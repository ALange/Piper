/**
 * The client portal: a standalone page, on its own port (`PORTAL_PORT`), where a key holder logs in
 * with their own API key and chats with their own agents, browsing their own workspace files —
 * nothing else in the gateway. Off by default (`PORTAL_ENABLED`): it opens a new port.
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
import { apiKeys, bearerToken } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { cors, logAccess, readJson, sendError, sendJson } from "./http.mjs";
import { filesRoutes } from "./profiles.mjs";
import { scopedSessionId } from "./chat.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { sessions } from "./sessions.mjs";
import { auditOnce, runWithActor } from "./audit.mjs";

const CONVERSATION = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE = 32 * 1024;

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

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Who this key is and its own agents — the one thing a bearer key alone could not learn before. Each
 * agent already runs on its own configured model, so there is nothing for this portal to pick. */
function whoami(key) {
	return {
		id: key.id,
		name: key.name,
		agents: agents.listByKey(key.id).filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, description: a.description || "" })),
	};
}

/** One turn, streamed — the same mechanism as the dashboard Playground (lib/playground.mjs), except
 * `keyId` is always the verified caller's own key, never taken from the request body. */
async function portalChat(key, req, res, body) {
	const message = String(body?.message ?? "");
	if (!message.trim()) return sendError(res, 400, "Type a message first.");
	if (message.length > MAX_MESSAGE) return sendError(res, 400, `A message is limited to ${MAX_MESSAGE / 1024} KB.`);
	const conversation = String(body?.conversation ?? "");
	if (!CONVERSATION.test(conversation)) return sendError(res, 400, "A conversation id is 8 to 64 letters, digits, - or _.");
	let credential;
	try {
		credential = credentialFor(key.id, body?.agentId ? String(body.agentId) : null);
	} catch (err) {
		if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
		throw err;
	}
	auditOnce(`portal:${conversation}`, 6 * 3_600_000, "session.portal", credential.name, "a conversation was started from the client portal");
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
	let unsubscribe = null;
	const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
	try {
		const result = await runAgentTurn({
			credential,
			clientSessionId: `portal:${conversation}`,
			inbox: true,
			colleagues: true,
			prompt: message,
			model: body?.model ? String(body.model) : null,
			signal: controller.signal,
			onSession: (record) => {
				// Only what happens in this turn: whatever the log already holds is older.
				const seen = record.live.snapshot().items.reduce((m, i) => Math.max(m, i.id), 0);
				unsubscribe = record.live.subscribe((change) => {
					if ((change.op === "add" || change.op === "update") && change.item.id > seen && change.item.kind !== "user") sse(res, "item", { op: change.op, item: change.item });
				});
			},
		});
		sse(res, "done", { text: result.text, reasoning: result.reasoning, usage: result.usage, cost: result.cost });
	} catch (err) {
		if (!controller.signal.aborted) {
			const known = err instanceof AgentRunError;
			sse(res, "error", { message: known ? err.message : `The agent could not answer: ${err?.message ?? err}`, code: known ? err.code : "server_error", status: known ? err.status : 500 });
		}
	} finally {
		clearInterval(beat);
		unsubscribe?.();
		res.end();
	}
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
		const key = apiKeys.verify(bearerToken(req));
		if (!key) {
			const from = req.socket?.remoteAddress ?? "unknown";
			auditOnce(`authfail:${from}`, 60_000, "authfail.api", from, `portal: ${req.method} ${path}${bearerToken(req) ? " (an unknown or revoked key)" : " (no key)"}`);
			return sendError(res, 401, "Invalid API key", "invalid_api_key", "authentication_error");
		}
		if (req.method === "GET" && path === "/api/whoami") return sendJson(res, 200, await whoami(key), { noStore: true });
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
