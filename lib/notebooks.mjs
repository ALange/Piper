/**
 * Notebooks: a key's own set of sources (uploaded files, or URLs an agent fetches), asked grounded
 * questions against with citations, and summarised/FAQ'd/study-guided on request.
 *
 * Three things happen, each its own step, same split `lib/rssfeeds.mjs` already uses for the same
 * reason: adding a source is cheap and instant; extracting its clean text is a whole agent turn, in
 * that agent's own container, with whatever reading tool it has — the gateway never parses an
 * uploaded file or fetches a URL itself, the same isolation rule RSS's own header comment states.
 * Chunking and embedding follow a successful extraction: each chunk's vector is a plain BLOB in
 * `notebook_chunks`, and a question is answered by a brute-force cosine scan over that notebook's own
 * chunks (fast enough at the scale one person's notebooks hold) — not a dedicated vector database.
 */
import crypto from "node:crypto";
import { config, db } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";

export class NotebookError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "NotebookError";
		this.status = status;
	}
}

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const EXTRACT_TEXT_CAP = 100_000;

// ---------------------------------------------------------------------------------------------
// Notebooks: plain CRUD, scoped by key.
// ---------------------------------------------------------------------------------------------

const nbFromRow = (row) => ({
	id: row.id,
	keyId: row.key_id,
	agentId: row.agent_id,
	title: row.title,
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
});

/** A key's own notebook, or null -- never another key's (the same ownership shape every other portal
 * resource already has, checked by the caller via credentialFor before this is ever reached). */
export function getNotebook(id, keyId) {
	const row = db.prepare("SELECT * FROM notebooks WHERE id = ? AND key_id = ?").get(String(id ?? ""), String(keyId ?? ""));
	return row ? nbFromRow(row) : null;
}

export const listNotebooks = (keyId) => db.prepare("SELECT * FROM notebooks WHERE key_id = ? ORDER BY updated_at DESC").all(String(keyId ?? "")).map(nbFromRow);

export function createNotebook(keyId, { title, agentId = null } = {}) {
	if (agentId) {
		const agent = agents.get(agentId);
		if (!agent || agent.keyId !== keyId) throw new NotebookError("no such agent for this key", 404);
	}
	const id = `nb${crypto.randomBytes(8).toString("hex")}`;
	const now = Date.now();
	const label = String(title ?? "").trim().slice(0, 100) || "Untitled notebook";
	db.prepare("INSERT INTO notebooks (id, key_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, keyId, agentId || null, label, now, now);
	audit("notebook.create", label, agentId ? `agent ${agentId}` : "the key's own main endpoint");
	return getNotebook(id, keyId);
}

export function renameNotebook(id, keyId, title) {
	if (!getNotebook(id, keyId)) throw new NotebookError("no such notebook", 404);
	const label = String(title ?? "").trim().slice(0, 100);
	if (!label) throw new NotebookError("give it a title");
	db.prepare("UPDATE notebooks SET title = ?, updated_at = ? WHERE id = ?").run(label, Date.now(), id);
	return getNotebook(id, keyId);
}

export function deleteNotebook(id, keyId) {
	if (!getNotebook(id, keyId)) throw new NotebookError("no such notebook", 404);
	db.prepare("DELETE FROM notebook_chunks WHERE notebook_id = ?").run(id);
	db.prepare("DELETE FROM notebook_sources WHERE notebook_id = ?").run(id);
	db.prepare("DELETE FROM notebook_outputs WHERE notebook_id = ?").run(id);
	db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
	audit("notebook.delete", id, "");
	return true;
}

// ---------------------------------------------------------------------------------------------
// Sources: added instantly, extracted as a whole agent turn (see pumpExtract below).
// ---------------------------------------------------------------------------------------------

const srcFromRow = (row) => ({
	id: row.id,
	notebookId: row.notebook_id,
	kind: row.kind,
	name: row.name,
	origin: row.origin,
	status: row.status,
	error: row.error,
	bytes: row.bytes === null ? null : Number(row.bytes),
	chunks: Number(db.prepare("SELECT COUNT(*) AS n FROM notebook_chunks WHERE source_id = ?").get(row.id)?.n ?? 0),
	createdAt: Number(row.created_at),
	fetchedAt: row.fetched_at === null ? null : Number(row.fetched_at),
});

export const listSources = (notebookId) => db.prepare("SELECT * FROM notebook_sources WHERE notebook_id = ? ORDER BY created_at").all(notebookId).map(srcFromRow);
export const getSource = (id) => {
	const row = db.prepare("SELECT * FROM notebook_sources WHERE id = ?").get(String(id ?? ""));
	return row ? srcFromRow(row) : null;
};

/** Add a source: `{kind:'upload', name, origin}` (origin: the workspace-relative path it was already
 * uploaded to, via the ordinary file-upload route) or `{kind:'url', name, origin}` (origin: the URL
 * itself). Instant; extraction is queued separately. */
export function addSource(notebookId, keyId, { kind, name, origin, bytes = null }) {
	if (!getNotebook(notebookId, keyId)) throw new NotebookError("no such notebook", 404);
	if (kind !== "upload" && kind !== "url") throw new NotebookError('kind must be "upload" or "url"');
	const cap = Number(config.NOTEBOOK_MAX_SOURCES ?? 50);
	if (listSources(notebookId).length >= cap) throw new NotebookError(`this notebook already has ${cap} sources, the most allowed (NOTEBOOK_MAX_SOURCES)`, 409);
	const label = String(name ?? "").trim().slice(0, 200);
	const where = String(origin ?? "").trim();
	if (!label || !where) throw new NotebookError("a source needs a name and an origin");
	if (kind === "url") {
		try {
			const url = new URL(where);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
		} catch {
			throw new NotebookError("that is not a URL");
		}
	}
	const id = `ns${crypto.randomBytes(8).toString("hex")}`;
	const now = Date.now();
	db.prepare("INSERT INTO notebook_sources (id, notebook_id, kind, name, origin, status, bytes, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").run(id, notebookId, kind, label, where, bytes, now);
	db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(now, notebookId);
	setImmediate(pumpExtract);
	return getSource(id);
}

export function removeSource(id, notebookId, keyId) {
	if (!getNotebook(notebookId, keyId)) throw new NotebookError("no such notebook", 404);
	const row = db.prepare("SELECT * FROM notebook_sources WHERE id = ? AND notebook_id = ?").get(id, notebookId);
	if (!row) return false;
	db.prepare("DELETE FROM notebook_chunks WHERE source_id = ?").run(id);
	db.prepare("DELETE FROM notebook_sources WHERE id = ?").run(id);
	return true;
}

// ---------------------------------------------------------------------------------------------
// Extraction: one whole agent turn per new source, same shape as lib/rssfeeds.mjs's own.
// ---------------------------------------------------------------------------------------------

const UPLOAD_PROMPT = (path, hint) =>
	`Read the file at "${path}" in your workspace and extract its clean text: no headers/footers repeated on every page, no page numbers, just the content.\n\n` +
	`${hint ? `It is called: "${hint}"\n\n` : ""}Reply with exactly one JSON object and nothing else — no markdown fence, no words before or after it:\n` +
	`{"title": "...", "text": "...", "summary": "a two or three sentence summary"}`;

const URL_PROMPT = (url, hint) =>
	`Fetch this page and extract it clean: no ads, navigation or sponsored sections, just the piece itself.\n\n${url}\n\n` +
	`${hint ? `It is called: "${hint}"\n\n` : ""}Reply with exactly one JSON object and nothing else — no markdown fence, no words before or after it:\n` +
	`{"title": "...", "text": "...", "summary": "a two or three sentence summary"}`;

/** The agent's reply, strictly: one JSON object with a title and text. Throws a plain, readable reason otherwise. */
export function parseExtraction(reply) {
	const stripped = String(reply ?? "")
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	let data;
	try {
		data = JSON.parse(stripped);
	} catch {
		throw new Error("the agent's reply was not JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the agent's reply was not a JSON object");
	const title = typeof data.title === "string" ? data.title.trim() : "";
	const text = typeof data.text === "string" ? data.text.trim() : "";
	const summary = typeof data.summary === "string" ? data.summary.trim() : "";
	if (!title || !text) throw new Error("the agent's reply has no title or text");
	return { title, text, summary };
}

/** Fixed-size slices with overlap. A pure function: easy to test exactly, easy to change later
 * (e.g. to something sentence-aware) without touching anything that calls it. */
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
	const clean = String(text ?? "").trim();
	if (!clean) return [];
	const out = [];
	let i = 0;
	while (i < clean.length) {
		out.push(clean.slice(i, i + size));
		if (i + size >= clean.length) break;
		i += size - overlap;
	}
	return out;
}

let runTurn = runAgentTurn;
/** Replace what runs an extraction/question turn (tests); no argument restores the real one. */
export const setNotebookRunner = (fn) => void (runTurn = fn ?? runAgentTurn);

let embedFn = embedTexts;
/** Replace what computes embeddings (tests, so no real API call runs); no argument restores the real one. */
export const setEmbedder = (fn) => void (embedFn = fn ?? embedTexts);

/** One call to NOTEBOOK_EMBEDDING_URL, batched: `texts` in, one vector (Float32Array) per text out,
 * in the same order. The one host-side call this feature makes directly, no container involved --
 * a fixed, operator-configured address, the same trust tier as RSS's own feed-fetching. */
export async function embedTexts(texts) {
	if (!texts.length) return [];
	const url = String(config.NOTEBOOK_EMBEDDING_URL ?? "").trim();
	if (!url) throw new Error("NOTEBOOK_EMBEDDING_URL is not set");
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...(config.NOTEBOOK_EMBEDDING_API_KEY ? { authorization: `Bearer ${config.NOTEBOOK_EMBEDDING_API_KEY}` } : {}) },
		body: JSON.stringify({ model: config.NOTEBOOK_EMBEDDING_MODEL, input: texts }),
	});
	if (!res.ok) throw new Error(`the embeddings endpoint answered HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
	const body = await res.json();
	const rows = Array.isArray(body?.data) ? body.data : null;
	if (!rows || rows.length !== texts.length) throw new Error("the embeddings endpoint's reply did not match what was sent");
	return rows.map((r) => Float32Array.from(r.embedding ?? []));
}

const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
const fromBlob = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

/** Chunk a source's extracted text and store one embedding per chunk. Failures here are logged, not
 * thrown: the source's own extraction already succeeded and stays 'done' either way -- a notebook
 * with some unembedded sources still works for the ones that embedded, same tolerance RSS shows a
 * single bad entry. */
async function embedSource(source) {
	const chunks = chunkText(source.text);
	if (!chunks.length) return;
	let vectors;
	try {
		vectors = await embedFn(chunks);
	} catch (err) {
		audit("notebook.embed_failed", source.name, String(err?.message ?? err), { actor: "system" });
		return;
	}
	const insert = db.prepare("INSERT INTO notebook_chunks (id, notebook_id, source_id, ord, text, embedding) VALUES (?, ?, ?, ?, ?, ?)");
	chunks.forEach((text, i) => {
		if (!vectors[i]?.length) return;
		insert.run(`nc${crypto.randomBytes(8).toString("hex")}`, source.notebook_id, source.id, i, text, toBlob(vectors[i]));
	});
}

const controllers = new Map();

async function extractOne(row, controller) {
	const timeoutMs = EXTRACT_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timer.unref?.();
	let outcome;
	try {
		const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(row.notebook_id);
		if (!notebook) throw new Error("its notebook was deleted");
		const credential = credentialFor(notebook.key_id, notebook.agent_id || null);
		const prompt = row.kind === "upload" ? UPLOAD_PROMPT(row.origin, row.name) : URL_PROMPT(row.origin, row.name);
		const result = await runTurn({ credential, clientSessionId: `notebook-extract:${row.id}`, prompt, signal: controller.signal });
		const extracted = parseExtraction(result.text);
		outcome = { status: "done", text: extracted.text.length > EXTRACT_TEXT_CAP ? `${extracted.text.slice(0, EXTRACT_TEXT_CAP)}\n… (cut at ${EXTRACT_TEXT_CAP} characters)` : extracted.text, error: null };
	} catch (err) {
		const why = timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s, so the turn was stopped` : err instanceof AgentRunError ? err.message : String(err?.message ?? err);
		outcome = { status: "failed", text: null, error: why.slice(0, 1000) };
	} finally {
		clearTimeout(timer);
	}
	if (outcome.status === "failed") {
		// Discarded, not kept: the same reasoning as RSS's own extraction failures (lib/rssfeeds.mjs) --
		// a one-off hiccup is worth a fresh attempt, not a dead row someone has to notice and retry.
		audit("notebook.extract_failed", row.name, outcome.error, { actor: "system" });
		db.prepare("DELETE FROM notebook_sources WHERE id = ?").run(row.id);
		return;
	}
	db.prepare("UPDATE notebook_sources SET status = 'done', text = ?, fetched_at = ? WHERE id = ?").run(outcome.text, Date.now(), row.id);
	await embedSource({ ...row, text: outcome.text });
	audit("notebook.extract", row.name, "done", { actor: "system" });
}

/** Start extracting queued ('pending') sources, same one-slot-per-call self-chaining pattern as
 * lib/rssfeeds.mjs's own pump(); no interval timer needed here since adding a source already calls
 * this directly -- there is nothing to poll on a schedule. */
let pumping = false;
export function pumpExtract() {
	if (pumping) return;
	pumping = true;
	try {
		const max = 2;
		while (controllers.size < max) {
			const row = db.prepare("SELECT * FROM notebook_sources WHERE status = 'pending' ORDER BY created_at LIMIT 1").get();
			if (!row) break;
			const claimed = db.prepare("UPDATE notebook_sources SET status = 'extracting' WHERE id = ? AND status = 'pending'").run(row.id);
			if (!Number(claimed.changes)) continue;
			const controller = new AbortController();
			controllers.set(row.id, controller);
			void extractOne(row, controller).finally(() => {
				controllers.delete(row.id);
				setImmediate(pumpExtract);
			});
		}
	} finally {
		pumping = false;
	}
}

/** Requeue extractions an earlier process left mid-flight (a restart), the same as lib/rssfeeds.mjs's startFeeds(). */
export function resumeNotebookExtractions() {
	const stale = db.prepare("UPDATE notebook_sources SET status = 'pending' WHERE status = 'extracting'").run();
	if (Number(stale.changes)) audit("runtime.notebook", "notebooks", `${stale.changes} extraction(s) were interrupted by a restart and requeued`, { actor: "system" });
	setImmediate(pumpExtract);
}

/** Abort any extraction turns in flight, for a clean shutdown -- the same as lib/rssfeeds.mjs's stopFeeds(). */
export function stopNotebookExtractions() {
	for (const c of controllers.values()) c.abort();
}

// ---------------------------------------------------------------------------------------------
// Retrieval and grounded Q&A.
// ---------------------------------------------------------------------------------------------

export function cosine(a, b) {
	let dot = 0, na = 0, nb = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (!na || !nb) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** This notebook's chunks whose vectors are closest to `queryVector`, best first. Brute force: a
 * full scan of one notebook's own rows, fast enough at the scale one person's notebooks hold -- see
 * the notebook plan for why this is not a dedicated vector store. */
export function topChunks(notebookId, queryVector, k = 8) {
	const rows = db.prepare("SELECT c.*, s.name AS source_name FROM notebook_chunks c JOIN notebook_sources s ON s.id = c.source_id WHERE c.notebook_id = ?").all(notebookId);
	return rows
		.map((r) => ({ id: r.id, sourceId: r.source_id, sourceName: r.source_name, text: r.text, score: cosine(queryVector, fromBlob(r.embedding)) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, k);
}

const ASK_PROMPT = (excerpts, question) =>
	`Answer the question using only the excerpts below, nothing from your own memory. Cite the excerpt number for every claim, like [1] or [2][3]. ` +
	`If the excerpts do not answer it, say so plainly instead of guessing.\n\n` +
	excerpts.map((e, i) => `[${i + 1}] (from "${e.sourceName}")\n${e.text}`).join("\n\n") +
	`\n\nQuestion: ${question}`;

/** One grounded question against a notebook: embed it, retrieve the closest chunks, ask the
 * notebook's own agent to answer only from them. `clientSessionId` is the same persistent-session
 * trick the portal's own conversations use, so a follow-up question keeps the previous turn's
 * context -- nothing new needed in runAgentTurn/sessions.mjs for that. */
export async function askNotebook({ notebook, question, clientSessionId, signal, onDelta, onThinking, onSession }) {
	const text = String(question ?? "").trim();
	if (!text) throw new NotebookError("ask it something");
	const credential = credentialFor(notebook.keyId, notebook.agentId || null);
	const [queryVector] = await embedFn([text]);
	const excerpts = queryVector ? topChunks(notebook.id, queryVector) : [];
	if (!excerpts.length) {
		return { text: "This notebook has no indexed sources yet to answer from.", reasoning: "", usage: {}, cost: 0, citations: [] };
	}
	const prompt = ASK_PROMPT(excerpts, text);
	const result = await runTurn({ credential, clientSessionId, prompt, signal, onDelta, onThinking, onSession });
	return { ...result, citations: excerpts.map((e, i) => ({ n: i + 1, sourceId: e.sourceId, sourceName: e.sourceName })) };
}

// ---------------------------------------------------------------------------------------------
// Generated outputs: a summary, an FAQ, a study guide -- one agent turn over the whole notebook.
// ---------------------------------------------------------------------------------------------

export const OUTPUT_KINDS = ["summary", "faq", "study-guide"];
const OUTPUT_PROMPT = {
	summary: "Write a clear summary of the material below, organised by topic.",
	faq: "Write a list of likely questions and answers covering the material below, as markdown (**Q:** / **A:**).",
	"study-guide": "Write a study guide for the material below: key terms with short definitions, then a handful of review questions.",
};

export const listOutputs = (notebookId) => db.prepare("SELECT * FROM notebook_outputs WHERE notebook_id = ? ORDER BY created_at DESC").all(notebookId).map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: Number(r.created_at) }));

const OUTPUT_SOURCE_CAP = 60_000;

export async function generateOutput(notebook, kind) {
	if (!OUTPUT_KINDS.includes(kind)) throw new NotebookError(`kind must be one of ${OUTPUT_KINDS.join(", ")}`);
	const sources = listSources(notebook.id).filter((s) => s.status === "done");
	if (!sources.length) throw new NotebookError("add at least one source first", 409);
	const rows = sources.map((s) => db.prepare("SELECT text FROM notebook_sources WHERE id = ?").get(s.id));
	let combined = sources.map((s, i) => `=== ${s.name} ===\n${rows[i]?.text ?? ""}`).join("\n\n");
	if (combined.length > OUTPUT_SOURCE_CAP) combined = `${combined.slice(0, OUTPUT_SOURCE_CAP)}\n… (cut: this notebook's sources are large; the output below is from the first part only)`;
	const credential = credentialFor(notebook.keyId, notebook.agentId || null);
	const prompt = `${OUTPUT_PROMPT[kind]}\n\n${combined}`;
	const result = await runTurn({ credential, clientSessionId: `notebook-generate:${notebook.id}:${kind}:${Date.now()}`, prompt });
	const id = `no${crypto.randomBytes(8).toString("hex")}`;
	const now = Date.now();
	db.prepare("INSERT INTO notebook_outputs (id, notebook_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)").run(id, notebook.id, kind, result.text, now);
	audit("notebook.generate", notebook.title, kind);
	return { id, kind, text: result.text, createdAt: now };
}
