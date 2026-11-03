/**
 * ComfyUI image generation: a capability-gated, agent-less, stateless target the client portal's
 * target dropdown offers like a model, except it produces an image instead of text. One fixed
 * built-in txt2img workflow (checkpoint loader -> positive/negative CLIP text encode -> empty latent
 * -> KSampler -> VAE decode -> save image); the user's typed message becomes the positive prompt,
 * everything else (negative prompt, size, steps, cfg, sampler) is an operator default (Settings ->
 * ComfyUI). Same capability pattern as Signal (lib/agentsignal.mjs): a global on/off switch plus a
 * can_generate_image flag on the agent, or on the plain key when there is no agent.
 *
 * COMFYUI_BASE_URL is a fixed, operator-configured address -- the same trust tier as
 * ALERT_WEBHOOK_URL or an external model's own endpoint (lib/externalmodels.mjs) -- never checked
 * against lib/chat.mjs's SSRF blocklist, which exists for client-supplied image URLs, not this.
 */
import crypto from "node:crypto";
import { config } from "./settings.mjs";
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

/** The one built-in txt2img node graph, in ComfyUI's own /prompt API shape. Node ids are fixed since
 * Piper always builds exactly this graph -- "9" is always the SaveImage node. */
function buildWorkflow({ prompt, negativePrompt, checkpoint, width, height, steps, cfg, sampler, seed }) {
	return {
		"4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
		"5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
		"6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
		"7": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: ["4", 1] } },
		"3": { class_type: "KSampler", inputs: { seed, steps, cfg, sampler_name: sampler, scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
		"8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
		"9": { class_type: "SaveImage", inputs: { filename_prefix: "piper", images: ["8", 0] } },
	};
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

async function pollHistory(base, promptId, timeoutMs, signal) {
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
			if (entry?.outputs?.["9"]?.images?.length) return entry.outputs["9"].images[0];
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
			const checkpoint = String(config.COMFYUI_CHECKPOINT ?? "").trim();
			if (!checkpoint) throw new ComfyUiError("COMFYUI_CHECKPOINT is not set (Settings → ComfyUI)", 500);
			const base = stripSlash(config.COMFYUI_BASE_URL);
			if (!base) throw new ComfyUiError("COMFYUI_BASE_URL is not set (Settings → ComfyUI)", 500);
			const release = beginImageTurn(record.keyId);
			try {
				const workflow = buildWorkflow({
					prompt: text,
					negativePrompt: String(config.COMFYUI_NEGATIVE_PROMPT ?? ""),
					checkpoint,
					width: Number(config.COMFYUI_DEFAULT_WIDTH) || 512,
					height: Number(config.COMFYUI_DEFAULT_HEIGHT) || 512,
					steps: Number(config.COMFYUI_DEFAULT_STEPS) || 20,
					cfg: Number(config.COMFYUI_DEFAULT_CFG) || 7,
					sampler: String(config.COMFYUI_SAMPLER || "euler"),
					seed: crypto.randomInt(0, 2 ** 32 - 1),
				});
				const clientId = crypto.randomUUID();
				const promptId = await submitPrompt(base, workflow, clientId, signal);
				const image = await pollHistory(base, promptId, Number(config.COMFYUI_TIMEOUT_MS) || 180_000, signal);
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
