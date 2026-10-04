/**
 * The dashboard's Playground: a chat with a key's agent, as a person would have it.
 *
 *   GET    /dashboard/playground/targets.json                the keys and agents that can be chatted with, and the models each may use
 *   POST   /dashboard/playground/chat                        {keyId, agentId?, conversation, message, model?} -> a Server-Sent Events stream
 *   DELETE /dashboard/playground/conversation/<id>?keyId=&agentId=    end that conversation's session
 *
 * A turn is a real one: `runAgentTurn` as the chosen key (and agent), so the key's session cap, daily spend cap and model
 * allow-list apply and the cost is the key's and the agent's. The Pi session lives on the gateway like any chat's and resumes after
 * a restart; the conversation as shown (the messages) is kept by the browser, not here. The stream carries the session's own
 * event log (assistant text, thinking, tool calls with their results), the same data the live view shows, then `done` or `error`.
 *
 * It runs agents with their tools and spends a key's money, so it needs a dashboard password and can be switched off.
 */
import { config } from "./settings.mjs";
import { apiKeys, ApiKeyStore, dashboardHash, keyLabel, modelAllowed } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { auditOnce } from "./audit.mjs";
import { readJson, sendError, sendJson } from "./http.mjs";
import { modelRuntime } from "./models.mjs";
import { catalogueFor } from "./containerpi.mjs";
import { sessions } from "./sessions.mjs";
import { scopedSessionId } from "./chat.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";

const CONVERSATION = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE = 32 * 1024;

const gate = (res) => {
	if (!config.PLAYGROUND_ENABLED) return sendError(res, 403, "The Playground is switched off (Settings → Agent).", "forbidden"), false;
	if (!dashboardHash) return sendError(res, 403, "The Playground needs a dashboard password: it runs agents with their tools and spends a key's money. Set one under Settings → Access first.", "forbidden"), false;
	return true;
};

/** Who can be chatted with: each usable key's main endpoint and its enabled agents, with the models that key may use. */
export async function playgroundTargets() {
	const runtime = await modelRuntime();
	return apiKeys.list().filter((k) => !ApiKeyStore.problem(k)).map((k) => {
		const models = [];
		const seen = new Set();
		for (const m of catalogueFor(runtime, (x) => modelAllowed(k.id, x))) {
			const value = `${m.provider}/${m.id}`;
			if (seen.has(value) || models.length >= 300) continue;
			seen.add(value);
			models.push({ value, name: m.name && m.name !== m.id ? `${m.name}` : m.id, provider: m.provider });
		}
		return {
			keyId: k.id,
			key: k.name,
			models,
			agents: agents.listByKey(k.id).filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, description: a.description || "", model: a.model ?? null })),
		};
	});
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Run one turn and stream it. Errors before the stream starts are plain JSON answers; after, an `error` event. */
export async function playgroundChat(req, res, body) {
	const message = String(body?.message ?? "");
	if (!message.trim()) return sendError(res, 400, "Type a message first.");
	if (message.length > MAX_MESSAGE) return sendError(res, 400, `A message is limited to ${MAX_MESSAGE / 1024} KB.`);
	const conversation = String(body?.conversation ?? "");
	if (!CONVERSATION.test(conversation)) return sendError(res, 400, "A conversation id is 8 to 64 letters, digits, - or _.");
	let credential;
	try {
		credential = credentialFor(String(body?.keyId ?? ""), body?.agentId ? String(body.agentId) : null);
	} catch (err) {
		if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
		throw err;
	}
	auditOnce(`playground:${conversation}`, 6 * 3_600_000, "session.playground", credential.name, "a conversation was started from the dashboard Playground");
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
			clientSessionId: `playground:${conversation}`,
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

/** End the server side of a conversation (its Pi session), when the person deletes it. */
export function endConversation(id, keyId, agentId) {
	if (!CONVERSATION.test(String(id))) return false;
	let credential;
	try {
		credential = credentialFor(String(keyId ?? ""), agentId ? String(agentId) : null);
	} catch {
		return false;
	}
	const scoped = scopedSessionId(credential, `playground:${id}`);
	return sessions.has(scoped) ? sessions.close(scoped) : false;
}

/** `/dashboard/playground/…`. Returns true when the path was ours. */
export async function playgroundRoutes(req, res, path) {
	if (path === "/dashboard/playground/targets.json" && req.method === "GET") {
		if (!gate(res)) return true;
		sendJson(res, 200, { targets: await playgroundTargets() });
		return true;
	}
	if (path === "/dashboard/playground/chat" && req.method === "POST") {
		if (!gate(res)) return true;
		let body;
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body"), true;
		}
		await playgroundChat(req, res, body);
		return true;
	}
	const del = /^\/dashboard\/playground\/conversation\/([A-Za-z0-9_-]+)$/.exec(path);
	if (del && req.method === "DELETE") {
		if (!gate(res)) return true;
		const q = new URL(req.url, "http://x").searchParams;
		sendJson(res, 200, { ended: endConversation(del[1], q.get("keyId"), q.get("agentId")) });
		return true;
	}
	return false;
}
