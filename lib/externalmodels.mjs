/**
 * External endpoints: operator-added OpenAI-compatible chat endpoints (self-hosted inference, a
 * third-party API), each with its own models and capability flags, plus which API key may use which
 * model. A model used this way is chat only -- a plain, direct, host-side HTTP call to the endpoint's
 * own `/v1/chat/completions`, never a Pi container session, so there is no session to persist, no
 * tools, skills or extensions. The caller (the client portal) resends the whole conversation as
 * `messages` on every turn, the same shape OpenAI's own API expects, the same way the portal already
 * keeps a conversation's full history client-side for an agent turn.
 *
 * The one new host-side network call this adds (detecting models, checking status, the chat call
 * itself) is to a fixed, operator-configured address -- the same trust tier as RSS's own
 * feed-fetching (lib/rssfeeds.mjs) and the notebook feature's embeddings call (lib/notebooks.mjs).
 */
import crypto from "node:crypto";
import { db } from "./settings.mjs";
import { apiKeys } from "./auth.mjs";
import { audit } from "./audit.mjs";

export class ExternalModelError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "ExternalModelError";
		this.status = status;
	}
}

const DETECT_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 8_000;
// The OpenAI-standard reasoning_effort values (the same field Piper's own /v1/chat/completions
// already accepts, lib/chat.mjs's applyRequestOptions) -- what most reasoning-capable OpenAI-compatible
// servers document. Not every provider supports every level, but these three are the common ground.
export const REASONING_EFFORTS = ["low", "medium", "high"];

/** Trim a trailing slash and, if present, a trailing "/v1" -- an OpenAI-compatible base URL is commonly
 * given either way ("https://api.x.com" or "https://api.x.com/v1"), and every call here appends
 * "/v1/..." itself, so the stored/used base is always the bare origin regardless of which form was typed. */
export function normalizeBaseUrl(url) {
	return String(url ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

// ---------------------------------------------------------------------------------------------
// Endpoints and their models: plain CRUD.
// ---------------------------------------------------------------------------------------------

const epFromRow = (row) => ({
	id: row.id,
	name: row.name,
	baseUrl: row.base_url,
	hasKey: Boolean(row.api_key),
	enabled: Boolean(row.enabled),
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
});

const modelFromRow = (row) => ({
	id: row.id,
	endpointId: row.endpoint_id,
	modelId: row.model_id,
	name: row.name || row.model_id,
	contextWindow: row.context_window === null ? null : Number(row.context_window),
	vision: Boolean(row.vision),
	embedding: Boolean(row.embedding),
	audio: Boolean(row.audio),
	reasoning: Boolean(row.reasoning),
	// Only meaningful when `reasoning` is set; null means "don't send reasoning_effort at all" --
	// let the model use whatever it defaults to.
	reasoningEffort: row.reasoning ? row.reasoning_effort || null : null,
	enabled: Boolean(row.enabled),
	createdAt: Number(row.created_at),
});

export const listEndpoints = () => db.prepare("SELECT * FROM external_endpoints ORDER BY created_at").all().map(epFromRow);
export const getEndpoint = (id) => {
	const row = db.prepare("SELECT * FROM external_endpoints WHERE id = ?").get(String(id ?? ""));
	return row ? epFromRow(row) : null;
};
/** The endpoint's row with its real api_key, for making the actual HTTP calls -- never sent to a client. */
const getEndpointSecret = (id) => db.prepare("SELECT * FROM external_endpoints WHERE id = ?").get(String(id ?? "")) ?? null;

export const listExternalModels = (endpointId) => db.prepare("SELECT * FROM external_models WHERE endpoint_id = ? ORDER BY created_at").all(endpointId).map(modelFromRow);
export const getModel = (id) => {
	const row = db.prepare("SELECT * FROM external_models WHERE id = ?").get(String(id ?? ""));
	return row ? modelFromRow(row) : null;
};

const normalizeCaps = ({ vision = false, embedding = false, audio = false, reasoning = false } = {}) => ({
	vision: Boolean(vision),
	embedding: Boolean(embedding),
	audio: Boolean(audio),
	reasoning: Boolean(reasoning),
});

/** `null` clears it (the model gets no reasoning_effort sent); omitted leaves it as it was; otherwise
 * it must be one of REASONING_EFFORTS. Shared by addModel and updateModel so both validate the same way. */
function checkedReasoningEffort(value) {
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	if (!REASONING_EFFORTS.includes(value)) throw new ExternalModelError(`reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}`);
	return value;
}

/** Create an endpoint with its initial set of models in one call -- the dashboard wizard's "Save". */
export function createEndpoint({ name, baseUrl, apiKey = "", models = [] }) {
	const label = String(name ?? "").trim().slice(0, 100);
	if (!label) throw new ExternalModelError("give the endpoint a name");
	const url = normalizeBaseUrl(baseUrl);
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
	} catch {
		throw new ExternalModelError("that is not a URL");
	}
	if (!Array.isArray(models) || !models.length) throw new ExternalModelError("add at least one model");
	const id = `ep${crypto.randomBytes(8).toString("hex")}`;
	const now = Date.now();
	db.prepare("INSERT INTO external_endpoints (id, name, base_url, api_key, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(id, label, url, String(apiKey ?? "").trim() || null, now, now);
	for (const m of models) addModel(id, m);
	audit("integration.create", label, `${models.length} model(s)`);
	return getEndpoint(id);
}

export function updateEndpoint(id, { name, baseUrl, apiKey, enabled }) {
	const row = getEndpointSecret(id);
	if (!row) throw new ExternalModelError("no such endpoint", 404);
	const nextName = name === undefined ? row.name : String(name).trim().slice(0, 100);
	if (!nextName) throw new ExternalModelError("give the endpoint a name");
	let nextUrl = row.base_url;
	if (baseUrl !== undefined) {
		nextUrl = normalizeBaseUrl(baseUrl);
		try {
			const parsed = new URL(nextUrl);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
		} catch {
			throw new ExternalModelError("that is not a URL");
		}
	}
	// A blank apiKey field means "leave it alone" (the dashboard never shows the real one back);
	// an explicit null/empty-string clear is only possible by passing apiKey: null.
	const nextKey = apiKey === undefined ? row.api_key : apiKey === null || apiKey === "" ? null : String(apiKey).trim();
	const nextEnabled = enabled === undefined ? Boolean(row.enabled) : Boolean(enabled);
	db.prepare("UPDATE external_endpoints SET name = ?, base_url = ?, api_key = ?, enabled = ?, updated_at = ? WHERE id = ?").run(nextName, nextUrl, nextKey, nextEnabled ? 1 : 0, Date.now(), id);
	audit("integration.update", nextName, "");
	return getEndpoint(id);
}

export function deleteEndpoint(id) {
	if (!getEndpoint(id)) throw new ExternalModelError("no such endpoint", 404);
	const modelIds = db.prepare("SELECT id FROM external_models WHERE endpoint_id = ?").all(id).map((r) => r.id);
	const delAssign = db.prepare("DELETE FROM key_external_models WHERE model_id = ?");
	for (const mid of modelIds) delAssign.run(mid);
	db.prepare("DELETE FROM external_models WHERE endpoint_id = ?").run(id);
	db.prepare("DELETE FROM external_endpoints WHERE id = ?").run(id);
	audit("integration.delete", id, "");
	return true;
}

export function addModel(endpointId, { modelId, name = "", contextWindow = null, vision, embedding, audio, reasoning, reasoningEffort } = {}) {
	if (!getEndpoint(endpointId)) throw new ExternalModelError("no such endpoint", 404);
	const mid = String(modelId ?? "").trim();
	if (!mid) throw new ExternalModelError("a model needs its id");
	const caps = normalizeCaps({ vision, embedding, audio, reasoning });
	const effort = checkedReasoningEffort(reasoningEffort) ?? null;
	const id = `em${crypto.randomBytes(8).toString("hex")}`;
	db.prepare("INSERT INTO external_models (id, endpoint_id, model_id, name, context_window, vision, embedding, audio, reasoning, reasoning_effort, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)").run(
		id,
		endpointId,
		mid,
		String(name ?? "").trim().slice(0, 200) || null,
		contextWindow === null || contextWindow === undefined || contextWindow === "" ? null : Number(contextWindow) || null,
		caps.vision ? 1 : 0,
		caps.embedding ? 1 : 0,
		caps.audio ? 1 : 0,
		caps.reasoning ? 1 : 0,
		caps.reasoning ? effort : null,
		Date.now(),
	);
	return getModel(id);
}

export function updateModel(id, { name, contextWindow, vision, embedding, audio, reasoning, reasoningEffort, enabled } = {}) {
	const row = db.prepare("SELECT * FROM external_models WHERE id = ?").get(String(id ?? ""));
	if (!row) throw new ExternalModelError("no such model", 404);
	const next = {
		name: name === undefined ? row.name : String(name ?? "").trim().slice(0, 200) || null,
		contextWindow: contextWindow === undefined ? row.context_window : contextWindow === null || contextWindow === "" ? null : Number(contextWindow) || null,
		vision: vision === undefined ? Boolean(row.vision) : Boolean(vision),
		embedding: embedding === undefined ? Boolean(row.embedding) : Boolean(embedding),
		audio: audio === undefined ? Boolean(row.audio) : Boolean(audio),
		reasoning: reasoning === undefined ? Boolean(row.reasoning) : Boolean(reasoning),
		reasoningEffort: reasoningEffort === undefined ? row.reasoning_effort : checkedReasoningEffort(reasoningEffort),
		enabled: enabled === undefined ? Boolean(row.enabled) : Boolean(enabled),
	};
	db.prepare("UPDATE external_models SET name = ?, context_window = ?, vision = ?, embedding = ?, audio = ?, reasoning = ?, reasoning_effort = ?, enabled = ? WHERE id = ?").run(
		next.name,
		next.contextWindow,
		next.vision ? 1 : 0,
		next.embedding ? 1 : 0,
		next.audio ? 1 : 0,
		next.reasoning ? 1 : 0,
		next.reasoning ? next.reasoningEffort : null,
		next.enabled ? 1 : 0,
		id,
	);
	return getModel(id);
}

export function removeModel(id) {
	if (!getModel(id)) throw new ExternalModelError("no such model", 404);
	db.prepare("DELETE FROM key_external_models WHERE model_id = ?").run(id);
	db.prepare("DELETE FROM external_models WHERE id = ?").run(id);
	return true;
}

/** Every endpoint with its models nested in -- the dashboard's one list call for all four tabs. */
export const listEndpointsWithModels = () => listEndpoints().map((ep) => ({ ...ep, models: listExternalModels(ep.id) }));

// ---------------------------------------------------------------------------------------------
// Detection and status: best-effort probes of the endpoint itself, nothing persisted by either.
// ---------------------------------------------------------------------------------------------

let fetchImpl = fetch;
/** Replace the fetch detection/status/chat calls use (tests); no argument restores the real one. */
export const setFetch = (fn) => void (fetchImpl = fn ?? fetch);

/** A light guess at a model's capabilities from its id/name -- a convenience the wizard pre-ticks,
 * never trusted as fact: the operator sees and can correct every checkbox before saving. */
export function guessCapabilities(modelId) {
	const s = String(modelId ?? "").toLowerCase();
	return {
		vision: /vision|\bvl\b|4o|omni|gemini|claude-3|claude-4|claude-5/.test(s),
		embedding: /embed/.test(s),
		audio: /audio|whisper|tts|speech/.test(s),
		reasoning: /\bo1\b|\bo3\b|\bo4\b|reasoning|\bthink/.test(s) || /\br1\b/.test(s) || /qwq|gpt-5/.test(s),
	};
}

/** Probe `${baseUrl}/v1/models`; best-effort, never throws -- a wizard step the operator can always
 * fall back to filling in by hand. Returns `{models, error}`, exactly one of which is set. */
export async function detectModels(baseUrl, apiKey = "") {
	const url = `${normalizeBaseUrl(baseUrl)}/v1/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
	timer.unref?.();
	try {
		const res = await fetchImpl(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: controller.signal });
		if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
		const body = await res.json();
		const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
		const models = rows
			.map((r) => (typeof r === "string" ? { id: r } : r))
			.filter((r) => r && typeof r.id === "string" && r.id)
			.map((r) => ({ modelId: r.id, name: r.id, contextWindow: Number(r.context_window ?? r.contextWindow) || null, ...guessCapabilities(r.id) }));
		return { models, error: models.length ? null : "the endpoint answered with no models" };
	} catch (err) {
		return { models: [], error: err?.name === "AbortError" ? `no answer within ${DETECT_TIMEOUT_MS / 1000}s` : String(err?.message ?? err) };
	} finally {
		clearTimeout(timer);
	}
}

/** On-demand only -- a "recheck" button, never polled, the same shape as the Container Health panel's
 * own "check again". Tries `/v1/models` first (what most OpenAI-compatible servers answer cheaply);
 * any HTTP reply at all (even an auth error) counts as "online" -- this is reachability, not auth. */
export async function checkEndpointStatus(endpoint) {
	const row = getEndpointSecret(endpoint.id ?? endpoint);
	if (!row) throw new ExternalModelError("no such endpoint", 404);
	const url = `${row.base_url}/v1/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
	timer.unref?.();
	const startedAt = Date.now();
	try {
		const res = await fetchImpl(url, { headers: row.api_key ? { authorization: `Bearer ${row.api_key}` } : {}, signal: controller.signal });
		return { online: true, status: res.status, ms: Date.now() - startedAt };
	} catch (err) {
		return { online: false, ms: Date.now() - startedAt, error: err?.name === "AbortError" ? `no answer within ${STATUS_TIMEOUT_MS / 1000}s` : String(err?.message ?? err) };
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------------------------
// Per-key access: which models a key may use for chat.
// ---------------------------------------------------------------------------------------------

/** A key's assigned models, each with its endpoint's name folded in -- what the portal's whoami and
 * the dashboard's Access Control tab both want. */
export function modelsForKey(keyId) {
	const rows = db
		.prepare(
			"SELECT m.*, e.name AS endpoint_name FROM key_external_models k " +
				"JOIN external_models m ON m.id = k.model_id JOIN external_endpoints e ON e.id = m.endpoint_id " +
				"WHERE k.key_id = ? AND m.enabled = 1 AND e.enabled = 1 ORDER BY k.created_at",
		)
		.all(String(keyId ?? ""));
	return rows.map((r) => ({ ...modelFromRow(r), endpointName: r.endpoint_name }));
}

/** Replace a key's whole set of assigned models in one call -- the Access Control tab's "Save". */
export function setKeyModels(keyId, modelIds) {
	if (!apiKeys.get(keyId)) throw new ExternalModelError("no such API key", 404);
	const ids = [...new Set((Array.isArray(modelIds) ? modelIds : []).map(String))];
	for (const mid of ids) if (!getModel(mid)) throw new ExternalModelError(`no such model: ${mid}`, 404);
	const now = Date.now();
	db.prepare("DELETE FROM key_external_models WHERE key_id = ?").run(keyId);
	const insert = db.prepare("INSERT INTO key_external_models (key_id, model_id, created_at) VALUES (?, ?, ?)");
	for (const mid of ids) insert.run(keyId, mid, now);
	audit("integration.access", keyId, `${ids.length} model(s) assigned`);
	return modelsForKey(keyId);
}

/** Every external model with which keys have it, for the Access Control tab's picker + checklist. */
export function listAccess() {
	const models = db
		.prepare("SELECT m.*, e.name AS endpoint_name FROM external_models m JOIN external_endpoints e ON e.id = m.endpoint_id ORDER BY e.name, m.created_at")
		.all()
		.map((r) => ({ ...modelFromRow(r), endpointName: r.endpoint_name }));
	const assignments = {};
	for (const row of db.prepare("SELECT key_id, model_id FROM key_external_models").all()) (assignments[row.key_id] ??= []).push(row.model_id);
	return { models, assignments };
}

// ---------------------------------------------------------------------------------------------
// The chat call itself: one direct, streaming, stateless HTTP request. No Pi, no container.
// ---------------------------------------------------------------------------------------------

/** Parse one OpenAI-style SSE buffer into complete `data:` lines, returning the leftover partial
 * buffer -- a pure function so the chunk-splitting logic is unit-testable without a real stream. */
export function splitSseLines(buffer) {
	const lines = [];
	let rest = buffer;
	let i;
	while ((i = rest.indexOf("\n")) >= 0) {
		const line = rest.slice(0, i).replace(/\r$/, "");
		rest = rest.slice(i + 1);
		if (line.startsWith("data:")) lines.push(line.slice(5).trim());
	}
	return { lines, rest };
}

/**
 * One direct call to `${endpoint.baseUrl}/v1/chat/completions`, streamed. `messages` is the whole
 * conversation so far (OpenAI's own `{role, content}[]` shape) -- there is no server-side session to
 * resend it from, by design (see this file's header). `onDelta` sees each token as it streams.
 * Returns `{text, usage}`. Throws ExternalModelError on anything the caller should show as a chat error.
 */
export async function chatCompletion({ endpoint, model, messages, signal, onDelta, onThinking }) {
	const row = getEndpointSecret(endpoint.id ?? endpoint);
	if (!row) throw new ExternalModelError("no such endpoint", 404);
	const url = `${row.base_url}/v1/chat/completions`;
	// stream_options.include_usage: the standard OpenAI way to ask a streaming reply to still end with
	// a usage chunk -- without it, most servers simply omit token counts from a streamed response.
	const body = { model: model.modelId, messages, stream: true, stream_options: { include_usage: true } };
	// Only sent when the model is flagged as reasoning-capable and an effort level is configured --
	// the same request field Piper's own /v1/chat/completions already accepts (lib/chat.mjs).
	if (model.reasoning && model.reasoningEffort) body.reasoning_effort = model.reasoningEffort;
	let res;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...(row.api_key ? { authorization: `Bearer ${row.api_key}` } : {}) },
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		throw new ExternalModelError(`could not reach the endpoint: ${err?.message ?? err}`, 502);
	}
	if (!res.ok) {
		const errBody = await res.text().catch(() => "");
		throw new ExternalModelError(`the endpoint answered HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 300)}` : ""}`, 502);
	}
	if (!res.body) throw new ExternalModelError("the endpoint sent no response body", 502);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	// Servers vary on the field name for a reasoning model's "thinking" tokens; reasoning_content
	// (DeepSeek, vLLM) and reasoning (a few others) are the two actually seen in the wild.
	let reasoning = "";
	let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const { lines, rest } = splitSseLines(buffer);
		buffer = rest;
		for (const line of lines) {
			if (line === "[DONE]") continue;
			let chunk;
			try {
				chunk = JSON.parse(line);
			} catch {
				continue;
			}
			const delta = chunk?.choices?.[0]?.delta ?? {};
			const think = delta.reasoning_content ?? delta.reasoning;
			if (typeof think === "string" && think) {
				reasoning += think;
				onThinking?.(think);
			}
			if (typeof delta.content === "string" && delta.content) {
				text += delta.content;
				onDelta?.(delta.content);
			}
			if (chunk?.usage) usage = chunk.usage;
		}
	}
	return { text, reasoning, usage };
}
