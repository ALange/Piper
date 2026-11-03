/**
 * ComfyUI image generation: a capability-gated, agent-less, stateless target the client portal's
 * target dropdown offers like a model, except it produces an image instead of text. Runs whatever
 * workflow the operator configured (Settings -> ComfyUI -> COMFYUI_WORKFLOW, a whole ComfyUI
 * workflow exported in API format) rather than a workflow Piper builds itself -- the chat message
 * becomes the positive prompt by replacing a literal %%PROMPT%% placeholder the operator put
 * somewhere in that workflow's own JSON (see lib/settings.mjs's parseComfyUiWorkflow, which both
 * validates the setting and is reused here to parse it). Same capability pattern as Signal
 * (lib/agentsignal.mjs): a global on/off switch plus a can_generate_image flag on the agent, or on
 * the plain key when there is no agent.
 *
 * COMFYUI_BASE_URL is a fixed, operator-configured address -- the same trust tier as
 * ALERT_WEBHOOK_URL or an external model's own endpoint (lib/externalmodels.mjs) -- never checked
 * against lib/chat.mjs's SSRF blocklist, which exists for client-supplied image URLs, not this.
 */
import crypto from "node:crypto";
import { config, parseComfyUiWorkflow } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { apiKeys } from "./auth.mjs";
import { audit } from "./audit.mjs";

export class ComfyUiError extends Error {
	constructor(message, status = 502) {
		super(message);
		this.name = "ComfyUiError";
		this.status = status;
	}
}

const POLL_INTERVAL_MS = 1500;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // same order as MAX_IMAGE_BYTES elsewhere in the codebase
const MAX_CONCURRENT_PER_KEY = 2; // generation is much heavier/slower per call than a chat turn

const stripSlash = (s) => String(s ?? "").trim().replace(/\/+$/, "");

/** Whether this chat may generate an image at all, now -- an agent via its own switch, or a plain key
 * via its own. Same shape as lib/agentsignal.mjs's maySignal. */
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

/** A fresh, ready-to-submit copy of the operator's configured workflow: every %%PROMPT%% placeholder
 * replaced with the chat message, and a new random seed in every node that has a numeric one (a
 * custom workflow can have more than one sampler, e.g. a base pass and a refiner, and both should
 * move together rather than only whichever one Piper might otherwise have guessed was "the" sampler).
 * Returns the save node's id too, since it is whatever id the operator's own workflow happens to use,
 * not a fixed one -- pollHistory needs it to know where to look in ComfyUI's own history reply. */
function instantiateWorkflow(graph, prompt, seed) {
	const workflow = JSON.parse(JSON.stringify(graph));
	let saveImageNodeId = null;
	for (const [id, node] of Object.entries(workflow)) {
		if (!node || typeof node !== "object") continue;
		if (node.class_type === "SaveImage" && saveImageNodeId === null) saveImageNodeId = id;
		for (const key of Object.keys(node.inputs ?? {})) {
			if (node.inputs[key] === "%%PROMPT%%") node.inputs[key] = prompt;
			else if (key === "seed" && typeof node.inputs[key] === "number") node.inputs[key] = seed;
		}
	}
	return { workflow, saveImageNodeId };
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
	return `data:image/png;base64,${buf.toString("base64")}`;
}

/** What a caller gets: `{generate}`, gate-checked and scoped to `record` the same way
 * lib/agentsignal.mjs's signalFor is. `record` is `{keyId, agentId}` -- built by the caller, not the
 * raw session/credential object (their shapes differ -- see lib/portal.mjs's own call site). */
export function comfyuiFor(record) {
	requireGenerateImage(record);
	return {
		async generate({ prompt, signal } = {}) {
			requireGenerateImage(record);
			const text = String(prompt ?? "").trim();
			if (!text) throw new ComfyUiError("there is nothing to draw: the prompt is empty", 400);
			const base = stripSlash(config.COMFYUI_BASE_URL);
			if (!base) throw new ComfyUiError("COMFYUI_BASE_URL is not set (Settings → ComfyUI)", 500);
			// Re-parsed here, not trusted as already-valid from when it was saved: a direct database
			// edit, or a setting rolled back some other way, must not reach ComfyUI with something
			// broken (no SaveImage node, no placeholder) and fail confusingly three network calls deep.
			const graph = parseComfyUiWorkflow(config.COMFYUI_WORKFLOW);
			if (!graph) throw new ComfyUiError("COMFYUI_WORKFLOW is not set (Settings → ComfyUI)", 500);
			const release = beginImageTurn(record.keyId);
			try {
				const seed = crypto.randomInt(0, 2 ** 32 - 1);
				const { workflow, saveImageNodeId } = instantiateWorkflow(graph, text, seed);
				const clientId = crypto.randomUUID();
				const promptId = await submitPrompt(base, workflow, clientId, signal);
				const image = await pollHistory(base, promptId, saveImageNodeId, Number(config.COMFYUI_TIMEOUT_MS) || 180_000, signal);
				const dataUrl = await fetchImage(base, image, signal);
				// Not "image.*" -- that prefix means a Docker image operation (lib/images.mjs). This simply
				// falls through categoryOf()'s default to "operations", same place container actions land.
				audit("comfyui.generate", record.agentId ? `agent ${record.agentId}` : `key ${record.keyId}`, "generated an image with ComfyUI");
				return { dataUrl };
			} finally {
				release();
			}
		},
	};
}
