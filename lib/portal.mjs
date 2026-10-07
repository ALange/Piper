/**
 * The client portal: a standalone page, on its own port (`PORTAL_PORT`), where a key holder logs in
 * with their own API key (or a username+password they set up once, see `loginWithPassword` and
 * `lib/auth.mjs`'s `portalSessionToken`/`readPortalSession`) and chats with their own agents, browsing
 * their own workspace files — nothing else in the gateway. Off by default (`PORTAL_ENABLED`): it opens
 * a new port.
 *
 * Unlike the dashboard's Playground, which a trusted operator uses to run as *any* key, every route
 * here is scoped to the one key presented in `Authorization: Bearer <key>` — a `keyId` is never taken
 * from a request body; `credentialFor`'s own ownership check (`agent.keyId !== key.id`) is relied on
 * for everything agent-scoped, exactly as it already is for an agent's own port
 * (`lib/agentservers.mjs`).
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { config } from "./settings.mjs";
import { apiKeys, bearerToken, loginFails, loginWaitMs, noteLoginFailure, portalSessionToken, readPortalSession } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { cors, logAccess, readJson, sendError, sendJson } from "./http.mjs";
import { filesRoutes } from "./profiles.mjs";
import { getHistory, PortalStoreError, saveHistory } from "./portalstore.mjs";
import { dataUriToImage, extensionsData, openSession, readySession, scopedSessionId, skillsData, startedSession } from "./chat.mjs";
import { modelRuntime, resolveModel } from "./models.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { sessions } from "./sessions.mjs";
import { MAX_WATCHERS_PER_SESSION } from "./liveroutes.mjs";
import { audit, auditOnce, runWithActor } from "./audit.mjs";
import {
	addSource,
	askNotebook,
	createNotebook,
	deleteNotebook,
	generateOutput,
	getNotebook,
	listNotebooks,
	listOutputs,
	listSources,
	NotebookError,
	removeSource,
	renameNotebook,
} from "./notebooks.mjs";

const CONVERSATION = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE = 32 * 1024;
const MAX_IMAGES = 6;

/** `body.images`: plain `data:` URIs, exactly what the browser's own `FileReader.readAsDataURL`
 * produces. Converted to the `{type:"image", data, mimeType}` shape `runAgentTurn` now accepts —
 * the same shape `resolveImages` already builds for `/v1/chat/completions` — or throws a plain,
 * readable reason (never a crash) for the caller to show. */
function checkedImages(raw) {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error("images must be a list of data: URIs");
	if (raw.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per message`);
	const cap = Number(config.PORTAL_ATTACHMENT_MAX_BYTES ?? 8 * 1024 * 1024);
	return raw.map((url, i) => {
		const image = dataUriToImage(String(url ?? ""));
		if (!image) throw new Error(`image ${i + 1} is not a valid data: URI`);
		const bytes = Buffer.byteLength(image.data, "base64");
		if (bytes > cap) throw new Error(`image ${i + 1} is ${Math.round(bytes / 1024 / 1024)} MB, over the ${Math.round(cap / 1024 / 1024)} MB limit (PORTAL_ATTACHMENT_MAX_BYTES)`);
		return image;
	});
}

let portalHtml = null;
/** Read fresh each time, like dashboardPage(), so an edit to portal.html is live without a restart. */
function portalPage() {
	try {
		portalHtml = readFileSync(new URL("../portal.html", import.meta.url), "utf8");
	} catch {
		/* keep serving the last good copy */
	}
	return portalHtml;
}

let notebookHtml = null;
/** Same idea as portalPage(): read fresh, so an edit to notebook.html is live without a restart. */
function notebookPage() {
	try {
		notebookHtml = readFileSync(new URL("../notebook.html", import.meta.url), "utf8");
	} catch {
		/* keep serving the last good copy */
	}
	return notebookHtml;
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Who this key is and its own agents — the one thing a bearer key alone could not learn before. Each
 * agent already runs on its own configured model, so there is nothing for this portal to pick. */
function whoami(key) {
	return {
		id: key.id,
		name: key.name,
		portalUsername: key.portalUsername || null,
		agents: agents.listByKey(key.id).filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, description: a.description || "" })),
	};
}

/** The client portal's own login, as an alternative to pasting the raw key: a username+password
 * issues a session token (lib/auth.mjs's portalSessionToken), never the raw key itself. Reached before
 * the regular key gate, same tier as /health and /: there is no key yet to check one against. */
async function loginWithPassword(req, res) {
	let body;
	try {
		body = await readJson(req);
	} catch {
		return sendError(res, 400, "Malformed JSON body");
	}
	const username = String(body?.username ?? "").trim();
	const password = String(body?.password ?? "");
	if (!username || !password) return sendError(res, 400, "A username and password are both required.");
	const throttleKey = `portal:${username.toLowerCase()}`;
	const waitMs = loginWaitMs(throttleKey);
	if (waitMs > 0) {
		res.setHeader("Retry-After", String(Math.ceil(waitMs / 1000)));
		return sendError(res, 429, `Too many attempts; wait ${Math.ceil(waitMs / 1000)}s and try again.`, "rate_limited");
	}
	const record = apiKeys.verifyPortalPassword(username, password);
	if (!record) {
		noteLoginFailure(throttleKey);
		const from = req.socket?.remoteAddress ?? "unknown";
		auditOnce(`authfail:${from}`, 60_000, "authfail.portal_password", from, `portal: wrong username or password for "${username}"`);
		return sendError(res, 401, "Wrong username or password.", "invalid_credentials", "authentication_error");
	}
	loginFails.delete(throttleKey);
	const issuedAt = Date.now();
	const ttl = Number(config.PORTAL_SESSION_MS) || 0;
	audit("session.password_login", record.name, "logged in to the client portal with a username and password");
	return sendJson(res, 200, { token: portalSessionToken(record, issuedAt), expiresAt: ttl > 0 ? issuedAt + ttl : null }, { noStore: true });
}

/** Set, change or remove this key's own portal username+password. Reached through the regular key
 * gate: either the real API key or an already-valid portal session can manage it -- once you're in,
 * how you got in does not matter. */
async function setPortalPassword(key, req, res) {
	let body;
	try {
		body = await readJson(req);
	} catch {
		return sendError(res, 400, "Malformed JSON body");
	}
	try {
		const record = apiKeys.setPortalPassword(key.id, { username: body?.username, password: body?.password });
		audit("portal.password_set", key.name, "a portal username/password was set or changed");
		return sendJson(res, 200, { username: record.portalUsername }, { noStore: true });
	} catch (err) {
		return sendError(res, 400, err.message);
	}
}

function clearPortalPassword(key, res) {
	apiKeys.clearPortalPassword(key.id);
	audit("portal.password_cleared", key.name, "the portal username/password was removed; its sessions all ended with it");
	return sendJson(res, 200, { cleared: true }, { noStore: true });
}

/** One turn, streamed — the same mechanism as the dashboard Playground (lib/playground.mjs), except
 * `keyId` is always the verified caller's own key, never taken from the request body. */
async function portalChat(key, req, res, body) {
	const message = String(body?.message ?? "");
	if (!message.trim()) return sendError(res, 400, "Type a message first.");
	if (message.length > MAX_MESSAGE) return sendError(res, 400, `A message is limited to ${MAX_MESSAGE / 1024} KB.`);
	const conversation = String(body?.conversation ?? "");
	if (!CONVERSATION.test(conversation)) return sendError(res, 400, "A conversation id is 8 to 64 letters, digits, - or _.");
	let images;
	try {
		images = checkedImages(body?.images);
	} catch (err) {
		return sendError(res, 413, err.message);
	}
	let credential;
	try {
		credential = credentialFor(key.id, body?.agentId ? String(body.agentId) : null);
	} catch (err) {
		if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
		throw err;
	}
	auditOnce(`portal:${conversation}`, 6 * 3_600_000, "session.portal", credential.name, "a conversation was started from the client portal");
	const controller = new AbortController();
	let disconnected = false;
	let unsubscribe = null;
	let sessionRecord = null;
	// Never aborts the turn itself: the browser going away must not cut off an agent that is still
	// working. Only this request's own plumbing comes down -- writing to a dead `res` would throw.
	// `GET .../events` is how a later request catches up on whatever happens next; an explicit stop
	// goes through `POST .../interrupt` instead, which acts on the session directly.
	res.on("close", () => {
		disconnected = true;
		clearInterval(beat);
		unsubscribe?.();
		unsubscribe = null;
	});
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
	const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
	try {
		const result = await runAgentTurn({
			credential,
			clientSessionId: `portal:${conversation}`,
			inbox: true,
			colleagues: true,
			prompt: message,
			images,
			signal: controller.signal,
			onSession: (record) => {
				sessionRecord = record;
				// Only what happens in this turn: whatever the log already holds is older.
				const seen = record.live.snapshot().items.reduce((m, i) => Math.max(m, i.id), 0);
				unsubscribe = record.live.subscribe((change) => {
					if (disconnected) return;
					if ((change.op === "add" || change.op === "update") && change.item.id > seen && change.item.kind !== "user") sse(res, "item", { op: change.op, item: change.item });
					// Auto-compaction can shrink the context mid-turn; the status bar need not wait for "done".
					else if (change.op === "state" && change.state.contextTokens != null) sse(res, "context", { contextUsed: change.state.contextTokens });
				});
			},
		});
		if (disconnected) return;
		// Best effort, for the status bar: the model this turn actually used, its context window, and
		// how fast it ran. Never worth failing an otherwise-successful turn over.
		let status = null;
		try {
			const session = await sessionRecord?.sessionPromise;
			const speed = session?.getSpeed();
			const model = speed?.last?.model ?? null;
			const contextWindow = model ? resolveModel(await modelRuntime(), model)?.contextWindow ?? null : null;
			status = { model, contextWindow, prompt: speed?.last?.prompt ?? null, gen: speed?.last?.gen ?? null };
		} catch {
			/* the chat answer itself already went out fine */
		}
		sse(res, "done", { text: result.text, reasoning: result.reasoning, usage: result.usage, cost: result.cost, status });
	} catch (err) {
		if (!disconnected) {
			const known = err instanceof AgentRunError;
			sse(res, "error", { message: known ? err.message : `The agent could not answer: ${err?.message ?? err}`, code: known ? err.code : "server_error", status: known ? err.status : 500 });
		}
	} finally {
		clearInterval(beat);
		unsubscribe?.();
		if (!disconnected) res.end();
	}
}

/** The started Pi session for `credential`, on a session id of its own (`portal:tools`) separate from any
 * actual conversation — listing skills or extensions needs a live session to ask Pi what is loaded, but
 * must not disturb, or depend on, a chat the key holder is or isn't having right now. */
async function sessionFor(credential) {
	const acquired = await readySession(credential, openSession(credential, "portal:tools"));
	await startedSession(acquired.record, acquired.id);
	return acquired.record;
}

/** End the server side of a conversation (its Pi session). Ownership-locked the same way as the chat route. */
function endConversation(key, id, agentId) {
	if (!CONVERSATION.test(String(id))) return false;
	let credential;
	try {
		credential = credentialFor(key.id, agentId ? String(agentId) : null);
	} catch {
		return false;
	}
	const scoped = scopedSessionId(credential, `portal:${id}`);
	return sessions.has(scoped) ? sessions.close(scoped) : false;
}

/** Stop the turn in flight for a conversation -- the portal's own "stop" button, now that losing the
 * connection no longer does this. Ownership-locked the same way as endConversation; acts on the
 * session directly, independent of whichever request started the turn, the same way the dashboard's
 * own /interrupt (lib/liveroutes.mjs) does. */
async function interruptConversation(key, id, agentId) {
	if (!CONVERSATION.test(String(id))) throw new AgentRunError("A conversation id is 8 to 64 letters, digits, - or _.", 400, "invalid_request_error", "invalid_request_error");
	const credential = credentialFor(key.id, agentId ? String(agentId) : null);
	const scoped = scopedSessionId(credential, `portal:${id}`);
	const record = sessions.recordById(scoped);
	const running = Boolean(record && record.inflight > 0);
	let aborted = false;
	if (running) {
		try {
			await record.session?.abort?.();
			aborted = true;
		} catch {
			/* reported in the response below */
		}
	}
	if (aborted) record.live.note("interrupted from the portal");
	audit("session.interrupt", credential.name, running ? (aborted ? "turn interrupted from the client portal" : "the interrupt failed") : "nothing was running");
	return { interrupted: aborted, wasRunning: running };
}

const PORTAL_MAX_WATCHERS_TOTAL = 20; // a quota of its own, separate from liveroutes.mjs's: a different
// trust/usage domain (one key's own tabs/devices), not worth sharing a global counter with the
// dashboard's operator view. The per-record cap below *is* shared, deliberately.
let portalWatching = 0;

/** Catch up a reconnecting client on a conversation's turn: the full LiveLog snapshot, and -- if it is
 * still running -- a live stream of what happens next, ending when it settles. Ownership-locked the
 * same way as every other portal route. A conversation with nothing live in memory (never started,
 * already fully reaped after settling, or cleared via endConversation) answers plainly with
 * `{live:false}` rather than an error: a reconnect is expected to probe this cheaply and often. Reuses
 * the same event vocabulary portalChat's own stream already uses (`item`/`done`/`error`), not the
 * dashboard's raw LiveLog op names, so the portal frontend's one stream handler serves both. */
async function conversationEvents(key, req, res, id, agentId) {
	if (!CONVERSATION.test(String(id))) return sendError(res, 400, "A conversation id is 8 to 64 letters, digits, - or _.");
	let credential;
	try {
		credential = credentialFor(key.id, agentId ? String(agentId) : null);
	} catch (err) {
		if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
		throw err;
	}
	const scoped = scopedSessionId(credential, `portal:${id}`);
	const record = sessions.recordById(scoped);
	if (!record) return sendJson(res, 200, { live: false }, { noStore: true });
	if (record.live.watchers >= MAX_WATCHERS_PER_SESSION || portalWatching >= PORTAL_MAX_WATCHERS_TOTAL) {
		return sendError(res, 429, "Too many connections are already watching this chat.", "rate_limited");
	}
	portalWatching += 1;
	let closed = false;
	let unsubscribe = null;
	const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
	const cleanup = () => {
		if (closed) return;
		closed = true;
		portalWatching -= 1;
		clearInterval(beat);
		unsubscribe?.();
		if (!res.writableEnded) res.end();
	};
	res.on("close", cleanup);
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
	const snap = record.live.snapshot();
	sse(res, "snapshot", snap);
	if (!snap.state.working) {
		sse(res, "done", { usage: null, cost: null, status: null });
		return cleanup();
	}
	unsubscribe = record.live.subscribe((change) => {
		if (change.op === "add" || change.op === "update") sse(res, "item", { op: change.op, item: change.item });
		else if (change.op === "state") {
			if (change.state.contextTokens != null) sse(res, "context", { contextUsed: change.state.contextTokens });
			if (change.state.working === false) {
				sse(res, "done", { usage: null, cost: null, status: null });
				cleanup();
			}
		} else if (change.op === "end") {
			sse(res, "error", { message: change.reason || "this chat ended", code: "session_ended" });
			cleanup();
		}
	});
}

/** One grounded question, streamed. Only `delta`/`done`/`error` -- there is no tool activity to
 * forward (askNotebook is one plain completion, not a tool-using agent turn), so notebook.html's
 * copy of portal.html's streamInto helper only ever needs to understand those three. */
async function notebookChat(key, req, res, notebookId, body) {
	const notebook = getNotebook(notebookId, key.id);
	if (!notebook) return sendError(res, 404, "no such notebook");
	const question = String(body?.question ?? "");
	if (!question.trim()) return sendError(res, 400, "Ask it something.");
	const controller = new AbortController();
	let disconnected = false;
	let beat;
	res.on("close", () => {
		disconnected = true;
		clearInterval(beat);
	});
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
	beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
	try {
		const result = await askNotebook({
			notebook,
			question,
			clientSessionId: `notebook:${notebookId}`,
			signal: controller.signal,
			onDelta: (d) => {
				if (!disconnected) sse(res, "delta", { text: d });
			},
		});
		if (disconnected) return;
		sse(res, "done", { text: result.text, reasoning: result.reasoning, usage: result.usage, cost: result.cost, citations: result.citations });
	} catch (err) {
		if (!disconnected) {
			const known = err instanceof AgentRunError || err instanceof NotebookError;
			sse(res, "error", { message: known ? err.message : `Could not answer: ${err?.message ?? err}`, code: known ? err.code ?? "notebook_error" : "server_error" });
		}
	} finally {
		clearInterval(beat);
		if (!disconnected) res.end();
	}
}

const NB_ONE = /^\/api\/notebooks\/([A-Za-z0-9]+)$/;
const NB_SOURCES = /^\/api\/notebooks\/([A-Za-z0-9]+)\/sources(?:\/([A-Za-z0-9]+))?$/;
const NB_CHAT = /^\/api\/notebooks\/([A-Za-z0-9]+)\/chat$/;
const NB_OUTPUTS = /^\/api\/notebooks\/([A-Za-z0-9]+)\/outputs$/;
const NB_GENERATE = /^\/api\/notebooks\/([A-Za-z0-9]+)\/generate$/;

/** Every /api/notebooks* route. Ownership is always getNotebook(id, key.id) -- never another key's,
 * the same shape every other portal resource already checks with credentialFor. Returns true when
 * it answered (the path was one of ours), so handlePortal's own 404 only fires for genuinely unknown
 * paths, the same convention lib/liveroutes.mjs's own router already uses. */
async function notebookRoutes(key, req, res, path) {
	if (!config.NOTEBOOK_ENABLED) {
		sendError(res, 404, "Notebooks are switched off (NOTEBOOK_ENABLED).", "not_found");
		return true;
	}
	if (path === "/api/notebooks" && req.method === "GET") {
		sendJson(res, 200, { notebooks: listNotebooks(key.id) }, { noStore: true });
		return true;
	}
	if (path === "/api/notebooks" && req.method === "POST") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			sendError(res, 400, "Malformed JSON body");
			return true;
		}
		try {
			sendJson(res, 201, createNotebook(key.id, { title: body?.title, agentId: body?.agentId ? String(body.agentId) : null }), { noStore: true });
		} catch (err) {
			if (err instanceof NotebookError) sendError(res, err.status, err.message);
			else throw err;
		}
		return true;
	}
	const one = NB_ONE.exec(path);
	if (one && req.method === "GET") {
		const notebook = getNotebook(one[1], key.id);
		if (!notebook) sendError(res, 404, "no such notebook");
		else sendJson(res, 200, notebook, { noStore: true });
		return true;
	}
	if (one && req.method === "PATCH") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			sendError(res, 400, "Malformed JSON body");
			return true;
		}
		try {
			sendJson(res, 200, renameNotebook(one[1], key.id, body?.title), { noStore: true });
		} catch (err) {
			if (err instanceof NotebookError) sendError(res, err.status, err.message);
			else throw err;
		}
		return true;
	}
	if (one && req.method === "DELETE") {
		try {
			sendJson(res, 200, { deleted: deleteNotebook(one[1], key.id) }, { noStore: true });
		} catch (err) {
			if (err instanceof NotebookError) sendError(res, err.status, err.message);
			else throw err;
		}
		return true;
	}
	const src = NB_SOURCES.exec(path);
	if (src && req.method === "GET" && !src[2]) {
		if (!getNotebook(src[1], key.id)) sendError(res, 404, "no such notebook");
		else sendJson(res, 200, { sources: listSources(src[1]) }, { noStore: true });
		return true;
	}
	if (src && req.method === "POST" && !src[2]) {
		let body;
		try {
			body = await readJson(req);
		} catch {
			sendError(res, 400, "Malformed JSON body");
			return true;
		}
		try {
			sendJson(res, 201, addSource(src[1], key.id, { kind: body?.kind, name: body?.name, origin: body?.origin, bytes: body?.bytes ?? null }), { noStore: true });
		} catch (err) {
			if (err instanceof NotebookError) sendError(res, err.status, err.message);
			else throw err;
		}
		return true;
	}
	if (src && req.method === "DELETE" && src[2]) {
		sendJson(res, 200, { removed: removeSource(src[2], src[1], key.id) }, { noStore: true });
		return true;
	}
	const chat = NB_CHAT.exec(path);
	if (chat && req.method === "POST") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			sendError(res, 400, "Malformed JSON body");
			return true;
		}
		await notebookChat(key, req, res, chat[1], body);
		return true;
	}
	const outputs = NB_OUTPUTS.exec(path);
	if (outputs && req.method === "GET") {
		if (!getNotebook(outputs[1], key.id)) sendError(res, 404, "no such notebook");
		else sendJson(res, 200, { outputs: listOutputs(outputs[1]) }, { noStore: true });
		return true;
	}
	const generate = NB_GENERATE.exec(path);
	if (generate && req.method === "POST") {
		const notebook = getNotebook(generate[1], key.id);
		if (!notebook) {
			sendError(res, 404, "no such notebook");
			return true;
		}
		let body;
		try {
			body = await readJson(req);
		} catch {
			sendError(res, 400, "Malformed JSON body");
			return true;
		}
		try {
			sendJson(res, 200, await generateOutput(notebook, String(body?.kind ?? "")), { noStore: true });
		} catch (err) {
			if (err instanceof NotebookError) sendError(res, err.status, err.message);
			else if (err instanceof AgentRunError) sendError(res, err.status, err.message, err.code, err.type);
			else throw err;
		}
		return true;
	}
	return false;
}

async function handlePortal(req, res) {
	cors(res);
	res.on("finish", () => logAccess(req, res.statusCode, res.sessionNote));
	try {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		const path = new URL(req.url, "http://localhost").pathname;
		if (req.method === "GET" && path === "/health") return sendJson(res, 200, { status: "ok" });
		if (req.method === "GET" && path === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(portalPage());
		}
		if (req.method === "GET" && path === "/notebook") {
			if (!config.NOTEBOOK_ENABLED) return sendError(res, 404, "Notebooks are switched off (NOTEBOOK_ENABLED).", "not_found");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(notebookPage());
		}
		if (req.method === "POST" && path === "/api/login-password") return await loginWithPassword(req, res);
		const token = bearerToken(req);
		const key = apiKeys.verify(token) ?? readPortalSession(token);
		if (!key) {
			const from = req.socket?.remoteAddress ?? "unknown";
			auditOnce(`authfail:${from}`, 60_000, "authfail.api", from, `portal: ${req.method} ${path}${token ? " (an unknown, revoked or expired credential)" : " (no key)"}`);
			return sendError(res, 401, "Invalid API key", "invalid_api_key", "authentication_error");
		}
		if (req.method === "GET" && path === "/api/whoami") return sendJson(res, 200, await whoami(key), { noStore: true });
		if (path === "/api/portal-password" && req.method === "POST") return await setPortalPassword(key, req, res);
		if (path === "/api/portal-password" && req.method === "DELETE") return clearPortalPassword(key, res);
		if (req.method === "POST" && path === "/api/chat") {
			let body;
			try {
				body = await readJson(req);
			} catch {
				return sendError(res, 400, "Malformed JSON body");
			}
			return await portalChat(key, req, res, body);
		}
		const del = /^\/api\/conversation\/([A-Za-z0-9_-]+)$/.exec(path);
		if (del && req.method === "DELETE") {
			const q = new URL(req.url, "http://localhost").searchParams;
			return sendJson(res, 200, { ended: endConversation(key, del[1], q.get("agentId")) }, { noStore: true });
		}
		const interrupt = /^\/api\/conversation\/([A-Za-z0-9_-]+)\/interrupt$/.exec(path);
		if (interrupt && req.method === "POST") {
			const q = new URL(req.url, "http://localhost").searchParams;
			try {
				return sendJson(res, 200, await interruptConversation(key, interrupt[1], q.get("agentId")), { noStore: true });
			} catch (err) {
				if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
				throw err;
			}
		}
		const events = /^\/api\/conversation\/([A-Za-z0-9_-]+)\/events$/.exec(path);
		if (events && req.method === "GET") {
			const q = new URL(req.url, "http://localhost").searchParams;
			return await conversationEvents(key, req, res, events[1], q.get("agentId"));
		}
		if (req.method === "GET" && path === "/api/history") {
			const stored = getHistory(key.id);
			return sendJson(res, 200, { data: stored?.data ?? null, updatedAt: stored?.updatedAt ?? null }, { noStore: true });
		}
		if (req.method === "PUT" && path === "/api/history") {
			let body;
			try {
				body = await readJson(req);
			} catch {
				return sendError(res, 400, "Malformed JSON body");
			}
			try {
				const updatedAt = saveHistory(key.id, body);
				return sendJson(res, 200, { updatedAt }, { noStore: true });
			} catch (err) {
				if (err instanceof PortalStoreError) return sendError(res, err.status, err.message);
				throw err;
			}
		}
		if (req.method === "GET" && (path === "/api/skills" || path === "/api/extensions")) {
			const agentId = new URL(req.url, "http://localhost").searchParams.get("agentId");
			let credential;
			try {
				credential = credentialFor(key.id, agentId || null);
			} catch (err) {
				if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
				throw err;
			}
			try {
				const record = await sessionFor(credential);
				if (path === "/api/skills") return sendJson(res, 200, { skills: await skillsData(record) }, { noStore: true });
				return sendJson(res, 200, await extensionsData(record), { noStore: true });
			} catch (err) {
				if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
				return sendError(res, 500, `could not list ${path === "/api/skills" ? "skills" : "extensions"}: ${err?.message ?? err}`, "server_error", "server_error");
			}
		}
		if (path === "/api/files" || path.startsWith("/api/files/")) {
			const agentId = new URL(req.url, "http://localhost").searchParams.get("agentId");
			let scopeId = key.id;
			if (agentId) {
				try {
					scopeId = credentialFor(key.id, agentId).scopeId;
				} catch (err) {
					if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
					throw err;
				}
			}
			return await filesRoutes(req, res, scopeId, path.slice("/api/files".length));
		}
		if (path.startsWith("/api/notebooks") && (await notebookRoutes(key, req, res, path))) return;
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 500, err?.message ?? String(err), "server_error", "server_error");
	}
}

let server = null;
export const portalPort = () => (server ? server.address()?.port ?? null : null);

/** No-op when PORTAL_ENABLED is off, or already running. */
export function startPortal() {
	if (!config.PORTAL_ENABLED || server) return;
	const s = http.createServer((req, res) => runWithActor("portal", req.socket?.remoteAddress, () => handlePortal(req, res)));
	s.on("error", (err) => {
		process.stderr.write(`portal: could not listen on ${config.HOST}:${config.PORTAL_PORT}: ${err.message}\n`);
		if (server === s) server = null;
	});
	server = s;
	s.listen(config.PORTAL_PORT, config.HOST, () => {
		process.stderr.write(`Piper client portal on http://${config.HOST}:${config.PORTAL_PORT}\n`);
	});
}

export async function stopPortal() {
	if (!server) return;
	const s = server;
	server = null;
	await new Promise((resolve) => s.close(() => resolve()));
	s.closeAllConnections?.();
}
