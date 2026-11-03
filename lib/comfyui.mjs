/**
 * ComfyUI image generation: a capability-gated, agent-less, stateless target the client portal's
 * target dropdown offers like a model, except it produces an image instead of text. Runs whatever
 * workflow the operator picked from their own library (managed here, Settings -> ComfyUI -> "ComfyUI
 * workflows", each a whole ComfyUI workflow exported in API format) rather than one workflow Piper
 * builds itself. A workflow is one of two kinds:
 *
 *   - "generate": a chat message in, an image out. The message replaces a literal %%PROMPT%%
 *     placeholder the operator put somewhere in the workflow's own JSON.
 *   - "edit": the same, plus exactly one attached image, which is uploaded to ComfyUI first and
 *     referenced from a literal %%IMAGE%% placeholder (a LoadImage node's "image" input) -- a face
 *     swap, an upscale, a style transfer, anything that starts from a picture instead of noise.
 *
 * Every node with a numeric "seed" input gets a fresh random one on every generation (a workflow can
 * have more than one sampler, e.g. a base pass and a refiner). One capability switch
 * (can_generate_image) covers every workflow in the library, the same pattern as Signal
 * (lib/agentsignal.mjs): a global on/off switch plus a flag on the agent, or on the plain key when
 * there is no agent -- there is no per-workflow grant.
 *
 * COMFYUI_BASE_URL is a fixed, operator-configured address -- the same trust tier as
 * ALERT_WEBHOOK_URL or an external model's own endpoint (lib/externalmodels.mjs) -- never checked
 * against lib/chat.mjs's SSRF blocklist, which exists for client-supplied image URLs, not this.
 *
 * Every result is also saved into the calling key's own workspace, under generated-images/ (never an
 * agent's -- there is no agent in this picture), so the portal's Gallery can list, preview, download
 * and delete past results through the exact same /api/files machinery (lib/profiles.mjs) the Files
 * browser already uses, rather than a second files-of-record this module would have to maintain
 * itself. A key's workspace is scoped to that key alone, the same as every other file it holds.
 */
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { config, db } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { apiKeys } from "./auth.mjs";
import { audit } from "./audit.mjs";
import { ensureWorkspace, filesStream, treeSize } from "./profiles.mjs";

export class ComfyUiError extends Error {
	constructor(message, status = 502) {
		super(message);
		this.name = "ComfyUiError";
		this.status = status;
	}
}

export const WORKFLOW_KINDS = ["generate", "edit"];

const POLL_INTERVAL_MS = 1500;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // same order as MAX_IMAGE_BYTES elsewhere in the codebase
const MAX_CONCURRENT_PER_KEY = 2; // generation is much heavier/slower per call than a chat turn

const stripSlash = (s) => String(s ?? "").trim().replace(/\/+$/, "");

/** Whether this chat may generate (or edit) an image at all, now -- an agent via its own switch, or a
 * plain key via its own. Same shape as lib/agentsignal.mjs's maySignal. One switch for every
 * workflow in the library; which workflow is picked is a separate question (getWorkflow below). */
export function mayGenerateImage(record) {
	if (!config.COMFYUI_ENABLED) return false;
	if (record?.agentId) return Boolean(agents.get(record.agentId)?.canGenerateImage);
	return Boolean(record?.keyId && apiKeys.get(record.keyId)?.canGenerateImage);
}

function requireGenerateImage(record) {
	if (!mayGenerateImage(record)) throw new ComfyUiError(record?.agentId ? "this agent may not generate images" : "this key may not generate images", 403);
}

// Named distinctly from lib/externalmodels.mjs's own setFetch: server.mjs re-exports every lib
// module with `export *`, and two same-named exports from different modules would collide there.
let fetchImpl = fetch;
export const setComfyUiFetch = (fn) => void (fetchImpl = fn ?? fetch);

/* ---- the workflow library (comfyui_workflows table, lib/settings.mjs) ---- */

const fromWorkflowRow = (row) => ({ id: row.id, name: row.name, kind: row.kind, workflow: row.workflow, createdAt: Number(row.created_at) });

export function listWorkflows() {
	return db.prepare("SELECT * FROM comfyui_workflows ORDER BY created_at").all().map(fromWorkflowRow);
}

export function getWorkflow(id) {
	const row = db.prepare("SELECT * FROM comfyui_workflows WHERE id = ?").get(String(id ?? ""));
	return row ? fromWorkflowRow(row) : null;
}

/** A ComfyUI workflow in API format (an object of node id -> {class_type, inputs}), with what
 * generate() below relies on actually there: a %%PROMPT%% placeholder for the chat message, a
 * SaveImage node to produce a file from, and -- for an "edit" workflow -- a %%IMAGE%% placeholder for
 * the one attached image. Throws a plain reason (no "COMFYUI_WORKFLOW:" prefix -- this validates one
 * row of a library now, not a single global setting) rather than returning a boolean. */
export function parseComfyUiWorkflowJson(text, kind) {
	const value = String(text ?? "").trim();
	if (value === "") throw new Error("a workflow needs its JSON (ComfyUI's own \"Save (API Format)\")");
	let graph;
	try {
		graph = JSON.parse(value);
	} catch {
		throw new Error("not valid JSON");
	}
	if (!graph || typeof graph !== "object" || Array.isArray(graph)) throw new Error("must be a ComfyUI workflow in API format (an object of node id -> {class_type, inputs})");
	let hasPlaceholder = false;
	let hasSaveImage = false;
	let hasImagePlaceholder = false;
	for (const node of Object.values(graph)) {
		if (!node || typeof node !== "object") continue;
		if (node.class_type === "SaveImage") hasSaveImage = true;
		for (const v of Object.values(node.inputs ?? {})) {
			if (v === "%%PROMPT%%") hasPlaceholder = true;
			if (v === "%%IMAGE%%") hasImagePlaceholder = true;
		}
	}
	if (!hasPlaceholder) throw new Error("no node has %%PROMPT%% as one of its inputs -- put that exact text in whichever node's prompt field a chat message should fill in");
	if (!hasSaveImage) throw new Error("no SaveImage node -- ComfyUI needs one to produce an image file");
	if (kind === "edit" && !hasImagePlaceholder) throw new Error("an image-edit workflow needs %%IMAGE%% as one of a node's inputs -- its LoadImage node's image field is where the attached image goes");
	return graph;
}

export function createWorkflow({ name, kind, workflow }) {
	const cleanName = String(name ?? "").trim();
	if (!cleanName) throw new Error("a workflow needs a name");
	if (!WORKFLOW_KINDS.includes(kind)) throw new Error(`kind must be one of: ${WORKFLOW_KINDS.join(", ")}`);
	parseComfyUiWorkflowJson(workflow, kind);
	const id = crypto.randomBytes(4).toString("hex");
	db.prepare("INSERT INTO comfyui_workflows (id, name, kind, workflow, created_at) VALUES (?, ?, ?, ?, ?)").run(id, cleanName, kind, String(workflow), Date.now());
	return getWorkflow(id);
}

export function updateWorkflow(id, { name, kind, workflow } = {}) {
	const row = getWorkflow(id);
	if (!row) return null;
	const nextName = name === undefined ? row.name : String(name).trim();
	if (!nextName) throw new Error("a workflow needs a name");
	const nextKind = kind === undefined ? row.kind : kind;
	if (!WORKFLOW_KINDS.includes(nextKind)) throw new Error(`kind must be one of: ${WORKFLOW_KINDS.join(", ")}`);
	const nextWorkflow = workflow === undefined ? row.workflow : String(workflow);
	parseComfyUiWorkflowJson(nextWorkflow, nextKind);
	db.prepare("UPDATE comfyui_workflows SET name = ?, kind = ?, workflow = ? WHERE id = ?").run(nextName, nextKind, nextWorkflow, id);
	return getWorkflow(id);
}

export function deleteWorkflow(id) {
	db.prepare("DELETE FROM comfyui_workflows WHERE id = ?").run(String(id ?? ""));
}

/* ---- running a workflow ---- */

const inFlightByKey = new Map();
function beginImageTurn(keyId) {
	const current = inFlightByKey.get(keyId) ?? 0;
	if (current >= MAX_CONCURRENT_PER_KEY) throw new ComfyUiError(`too many images are already generating for this key (at most ${MAX_CONCURRENT_PER_KEY} at once)`, 429);
	inFlightByKey.set(keyId, current + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (inFlightByKey.get(keyId) ?? 1) - 1;
		if (left <= 0) inFlightByKey.delete(keyId);
		else inFlightByKey.set(keyId, left);
	};
}

/** A fresh, ready-to-submit copy of the workflow: every %%PROMPT%% placeholder replaced with the chat
 * message, every %%IMAGE%% placeholder (only present for an "edit" workflow) replaced with the
 * uploaded image's own filename, and a new random seed in every node that has a numeric one. Returns
 * the save node's id too, since it is whatever id the operator's own workflow happens to use, not a
 * fixed one -- pollHistory needs it to know where to look in ComfyUI's own history reply. */
function instantiateWorkflow(graph, { prompt, imageRef, seed }) {
	const workflow = JSON.parse(JSON.stringify(graph));
	let saveImageNodeId = null;
	for (const [id, node] of Object.entries(workflow)) {
		if (!node || typeof node !== "object") continue;
		if (node.class_type === "SaveImage" && saveImageNodeId === null) saveImageNodeId = id;
		for (const key of Object.keys(node.inputs ?? {})) {
			if (node.inputs[key] === "%%PROMPT%%") node.inputs[key] = prompt;
			else if (node.inputs[key] === "%%IMAGE%%" && imageRef != null) node.inputs[key] = imageRef;
			else if (key === "seed" && typeof node.inputs[key] === "number") node.inputs[key] = seed;
		}
	}
	return { workflow, saveImageNodeId };
}

/** Uploads one attached image (lib/portal.mjs's checkedImages() shape: base64 `data` + `mimeType`,
 * not yet a data: URI) to ComfyUI's own /upload/image, and returns the filename (or
 * "subfolder/filename") a LoadImage node's "image" input expects to find it under. */
async function uploadImage(base, { data, mimeType }, signal) {
	let buf;
	try {
		buf = Buffer.from(String(data ?? ""), "base64");
	} catch {
		throw new ComfyUiError("the attached image could not be decoded", 400);
	}
	if (!buf.length) throw new ComfyUiError("the attached image is empty", 400);
	const ext = (String(mimeType || "image/png").split("/")[1] || "png").replace("jpeg", "jpg");
	const form = new FormData();
	form.append("image", new Blob([buf], { type: mimeType || "image/png" }), `upload.${ext}`);
	let res;
	try {
		res = await fetchImpl(`${base}/upload/image`, { method: "POST", body: form, signal });
	} catch (err) {
		throw new ComfyUiError(`could not upload the image to ComfyUI: ${err?.message ?? err}`, 502);
	}
	if (!res.ok) throw new ComfyUiError(`ComfyUI refused the uploaded image (HTTP ${res.status})`, 502);
	const body = await res.json().catch(() => ({}));
	if (!body?.name) throw new ComfyUiError("ComfyUI did not return the uploaded image's name", 502);
	return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
}

async function submitPrompt(base, workflow, clientId, signal) {
	let res;
	try {
		res = await fetchImpl(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }), signal });
	} catch (err) {
		throw new ComfyUiError(`could not reach ComfyUI at ${base}: ${err?.message ?? err}`, 502);
	}
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const nodeMsg = body?.node_errors ? Object.values(body.node_errors).map((n) => n?.errors?.[0]?.message).filter(Boolean).join("; ") : "";
		throw new ComfyUiError(`ComfyUI rejected the workflow${nodeMsg ? `: ${nodeMsg}` : body?.error?.message ? `: ${body.error.message}` : ` (HTTP ${res.status})`}`, 502);
	}
	if (!body?.prompt_id) throw new ComfyUiError("ComfyUI did not return a prompt id", 502);
	return body.prompt_id;
}

async function pollHistory(base, promptId, saveImageNodeId, timeoutMs, signal) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) throw new ComfyUiError("generation was interrupted", 499);
		let res;
		try {
			res = await fetchImpl(`${base}/history/${promptId}`, { signal });
		} catch (err) {
			throw new ComfyUiError(`lost contact with ComfyUI while waiting for the image: ${err?.message ?? err}`, 502);
		}
		if (res.ok) {
			const body = await res.json().catch(() => ({}));
			const entry = body?.[promptId];
			if (entry?.outputs?.[saveImageNodeId]?.images?.length) return entry.outputs[saveImageNodeId].images[0];
		}
		if (Date.now() >= deadline) throw new ComfyUiError(`ComfyUI did not finish the image within ${Math.round(timeoutMs / 1000)}s`, 504);
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}

async function fetchImage(base, { filename, subfolder, type }, signal) {
	const url = `${base}/view?${new URLSearchParams({ filename, subfolder: subfolder || "", type: type || "output" })}`;
	let res;
	try {
		res = await fetchImpl(url, { signal });
	} catch (err) {
		throw new ComfyUiError(`could not fetch the generated image: ${err?.message ?? err}`, 502);
	}
	if (!res.ok) throw new ComfyUiError(`could not fetch the generated image (HTTP ${res.status})`, 502);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_IMAGE_BYTES) throw new ComfyUiError(`the generated image was over ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 502);
	return buf;
}

/** Saves one result into the key's own workspace, under generated-images/, for the portal's Gallery
 * -- best-effort: a failure here must not break the chat reply the image is already on its way to,
 * so this only logs and never throws. Reuses the exact write path lib/signal.mjs's own
 * copyAttachmentToWorkspace uses for an inbound attachment (filesStream's "write" mode, with a fake
 * `res` to capture its JSON result), including the same quota check. */
async function saveToGallery(keyId, buf) {
	try {
		const quota = Number(config.WORKSPACE_MAX_BYTES ?? 0) > 0 ? Math.max(0, Number(config.WORKSPACE_MAX_BYTES) - treeSize(ensureWorkspace(keyId))) : 0;
		const limit = [Number(config.FILE_UPLOAD_MAX_BYTES ?? 0), quota].filter((n) => n > 0);
		const maxBytes = limit.length ? Math.min(...limit) : 0;
		const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`;
		let body = "";
		const fakeRes = { headersSent: false, writeHead() {}, end: (s) => { body = s ?? ""; }, destroy() {} };
		await filesStream(keyId, "write", `generated-images/${name}`, { req: Readable.from(buf), res: fakeRes, maxBytes });
		let parsed = {};
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			/* a non-JSON body means success here too, same as copyAttachmentToWorkspace's own parse */
		}
		if (parsed?.error) throw new Error(parsed.error.message ?? parsed.error);
	} catch (err) {
		console.error(`piper: could not save a generated image to the gallery (key ${keyId}):`, err?.message ?? err);
	}
}

/** What a caller gets: `{generate}`, gate-checked and scoped to `record` the same way
 * lib/agentsignal.mjs's signalFor is. `record` is `{keyId, agentId}` -- built by the caller, not the
 * raw session/credential object (their shapes differ -- see lib/portal.mjs's own call site).
 * `images`, when given, is lib/portal.mjs's checkedImages() shape (`[{type:"image", data, mimeType}]`),
 * required (exactly one) for an "edit" workflow and ignored for a "generate" one. */
export function comfyuiFor(record) {
	requireGenerateImage(record);
	return {
		async generate({ workflowId, prompt, images, signal } = {}) {
			requireGenerateImage(record);
			const text = String(prompt ?? "").trim();
			if (!text) throw new ComfyUiError("there is nothing to draw: the prompt is empty", 400);
			const row = getWorkflow(workflowId);
			if (!row) throw new ComfyUiError("no such workflow", 404);
			const base = stripSlash(config.COMFYUI_BASE_URL);
			if (!base) throw new ComfyUiError("COMFYUI_BASE_URL is not set (Settings → ComfyUI)", 500);
			// Re-parsed here, not trusted as already-valid from when it was saved: a direct database
			// edit must not reach ComfyUI with something broken (no SaveImage node, no placeholder) and
			// fail confusingly three network calls deep.
			const graph = parseComfyUiWorkflowJson(row.workflow, row.kind);
			const attached = Array.isArray(images) ? images : [];
			if (row.kind === "edit" && attached.length !== 1) throw new ComfyUiError("attach exactly one image to edit with this workflow", 400);
			const release = beginImageTurn(record.keyId);
			try {
				const imageRef = row.kind === "edit" ? await uploadImage(base, attached[0], signal) : null;
				const seed = crypto.randomInt(0, 2 ** 32 - 1);
				const { workflow, saveImageNodeId } = instantiateWorkflow(graph, { prompt: text, imageRef, seed });
				const clientId = crypto.randomUUID();
				const promptId = await submitPrompt(base, workflow, clientId, signal);
				const image = await pollHistory(base, promptId, saveImageNodeId, Number(config.COMFYUI_TIMEOUT_MS) || 180_000, signal);
				const buf = await fetchImage(base, image, signal);
				await saveToGallery(record.keyId, buf);
				// Not "image.*" -- that prefix means a Docker image operation (lib/images.mjs). This simply
				// falls through categoryOf()'s default to "operations", same place container actions land.
				audit("comfyui.generate", record.agentId ? `agent ${record.agentId}` : `key ${record.keyId}`, `${row.kind === "edit" ? "edited" : "generated"} an image with "${row.name}"`);
				return { dataUrl: `data:image/png;base64,${buf.toString("base64")}` };
			} finally {
				release();
			}
		},
	};
}
