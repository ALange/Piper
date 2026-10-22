/**
 * The dashboard's Playground: a chat with a key's agent, as a person would have it.
 *
 *   GET    /dashboard/playground/targets.json                the keys and agents that can be chatted with, and the models each may use
 *   POST   /dashboard/playground/chat                        {keyId, agentId?, conversation, message, model?, channel?} -> a Server-Sent Events stream
 *   GET    /dashboard/playground/conversation/<id>/events?keyId=&agentId=&channel=   catch up on a turn still running (a reload, a reconnect)
 *   POST   /dashboard/playground/conversation/<id>/interrupt?keyId=&agentId=&channel=   stop the turn in flight
 *   POST   /dashboard/playground/conversation/<id>/steer?keyId=&agentId=&channel=   {message} -> send it into the turn in flight instead of queuing a new one
 *   DELETE /dashboard/playground/conversation/<id>?keyId=&agentId=&channel=    end that conversation's session
 *
 * `channel: "signal"` resumes that key's (and agent's) own Signal session (lib/signal.mjs's own
 * `signal:${keyId}:${agentId}`) instead of starting or continuing an ordinary `playground:<id>`
 * conversation -- the browser's own `<id>` stays whatever it likes for its own bookkeeping, only the
 * server-side session string changes. Lets the operator pick up a Signal conversation here: the same
 * Pi session, same memory, replies just don't also go back out over Signal from this view.
 *
 * A turn is a real one: `runAgentTurn` as the chosen key (and agent), so the key's session cap, daily spend cap and model
 * allow-list apply and the cost is the key's and the agent's. The Pi session lives on the gateway like any chat's and resumes after
 * a restart; the conversation as shown (the messages) is kept by the browser, not here. The stream carries the session's own
 * event log (assistant text, thinking, tool calls with their results), the same data the live view shows, then `done` or `error`.
 *
 * A browser going away (a reload, a closed tab) does not stop the turn -- only `POST .../interrupt`
 * does, same as the client portal (lib/portal.mjs). `GET .../events` is how a later request (or the
 * same tab, reloaded) catches up on whatever happened while it was gone, live if it's still running.
 *
 * It runs agents with their tools and spends a key's money, so it needs a dashboard password and can be switched off.
 */
import { config } from "./settings.mjs";
import { apiKeys, ApiKeyStore, dashboardHash, keyLabel, modelAllowed } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { audit, auditOnce } from "./audit.mjs";
import { readJson, sendError, sendJson } from "./http.mjs";
import { modelRuntime } from "./models.mjs";
import { catalogueFor } from "./containerpi.mjs";
import { sessions } from "./sessions.mjs";
import { scopedSessionId, steerSession } from "./chat.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { MAX_WATCHERS_PER_SESSION } from "./liveroutes.mjs";
import { startExternalLiveTurn, endExternalLiveTurn, externalLiveRecordById } from "./externallive.mjs";
import { ExternalModelError, beginExternalTurn, chatCompletion, checkedHistory, getEndpoint, modelsForKey } from "./externalmodels.mjs";
import { commitReplay, findReplay, normalizeRequestId } from "./externalreplay.mjs";

const CONVERSATION = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE = 32 * 1024;

/** The real session string for a conversation: its own `playground:<id>`, or -- `channel: "signal"` --
 * that key's (and agent's) own Signal session, the exact string lib/signal.mjs itself builds, so
 * resuming it here lands on the same Pi session a Signal conversation already has. */
const sessionIdFor = (channel, conversationId, keyId, agentId) =>
	channel === "signal" ? `signal:${String(keyId ?? "")}:${agentId ? String(agentId) : ""}` : `playground:${conversationId}`;

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
			// Chat-only external models (lib/externalmodels.mjs) granted to this key -- a target the same
			// way an agent is, just no tools/skills/extensions and no Pi session behind it.
			externalModels: modelsForKey(k.id).map((m) => ({ id: m.id, name: m.name, endpointName: m.endpointName, vision: m.vision })),
		};
	});
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A chat-only turn against an external OpenAI-compatible model (lib/externalmodels.mjs), run as any
 * key the operator chooses -- the Playground's own trust tier, same as the agent path above already
 * takes `keyId` straight from the body. No Pi session, no container, no tools: one direct, streaming,
 * stateless HTTP call, with the same `item`/`done` SSE vocabulary the agent path uses, so the
 * Playground's existing message rendering needs no branch for it at all.
 */
async function playgroundExternalChat(res, { conversation, keyId, externalModelId, message, history, requestId }) {
	const model = modelsForKey(keyId).find((m) => m.id === externalModelId);
	if (!model) return sendError(res, 403, "This key is not granted that model (Integrations → Access Control).", "model_not_allowed", "invalid_request_error");
	let pastMessages;
	try {
		pastMessages = checkedHistory(history);
	} catch (err) {
		return sendError(res, 400, err.message);
	}
	const endpoint = getEndpoint(model.endpointId);
	if (!endpoint) return sendError(res, 404, "That model's endpoint no longer exists.", "not_found", "invalid_request_error");
	// A retry of a turn that already finished (a dropped connection, a gateway restart mid-stream) gets
	// back what was already committed, not a second call to the model -- see lib/externalreplay.mjs.
	const rid = normalizeRequestId(requestId);
	const cached = rid ? findReplay(rid, keyId, model.id) : null;
	if (cached) {
		res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		sse(res, "item", { op: "add", item: { kind: "assistant", id: "final", text: cached.text } });
		sse(res, "done", { text: cached.text, reasoning: cached.reasoning, usage: cached.usage, cost: 0, status: { model: `${endpoint.name}/${model.modelId}`, contextWindow: model.contextWindow || null, prompt: null, gen: null } });
		return res.end();
	}
	let release;
	try {
		release = beginExternalTurn(keyId);
	} catch (err) {
		const known = err instanceof ExternalModelError;
		return sendError(res, known ? err.status : 500, known ? err.message : `${err?.message ?? err}`, known ? "rate_limited" : "server_error");
	}
	const messages = [...pastMessages, { role: "user", content: message }];
	auditOnce(`playground:${keyId}:${externalModelId}`, 6 * 3_600_000, "session.playground", `${keyLabel(keyId)} / ${model.name}`, "a conversation was started from the dashboard Playground");
	const controller = new AbortController();
	// The external-model equivalent of an agent turn's `record` (lib/sessions.mjs): without it, a
	// reload mid-reply had nothing to reconnect to at all -- see lib/externallive.mjs.
	const liveKey = `playground:${keyId}:${conversation}`;
	const liveRecord = startExternalLiveTurn(liveKey);
	// Never aborts on disconnect, same as portalExternalChat: only this request's own plumbing (the
	// sse() writes below) comes down, the upstream call keeps running and its answer still lands in
	// liveRecord for a reconnect to pick up.
	let disconnected = false;
	res.on("close", () => {
		disconnected = true;
		clearInterval(beat);
	});
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
	const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
	let streamed = "";
	let streamedThink = "";
	let thinkStarted = false;
	const startedAt = Date.now();
	let firstTokenAt = null;
	try {
		sse(res, "item", { op: "add", item: { kind: "assistant", id: "final", text: "" } });
		const result = await chatCompletion({
			endpoint,
			model,
			messages,
			signal: controller.signal,
			onThinking: (delta) => {
				if (firstTokenAt === null) firstTokenAt = Date.now();
				streamedThink += delta;
				liveRecord.live.feed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
				if (disconnected) return;
				sse(res, "item", { op: thinkStarted ? "update" : "add", item: { kind: "thinking", id: "think", text: streamedThink } });
				thinkStarted = true;
			},
			onDelta: (delta) => {
				if (firstTokenAt === null) firstTokenAt = Date.now();
				streamed += delta;
				liveRecord.live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
				if (!disconnected) sse(res, "item", { op: "update", item: { kind: "assistant", id: "final", text: streamed } });
			},
		});
		// Committed before the disconnected check below: a finished answer is worth keeping for a
		// retry even when nobody is still listening to this response.
		if (rid) commitReplay(rid, keyId, model.id, { text: result.text, reasoning: result.reasoning, usage: result.usage });
		if (disconnected) return;
		const endedAt = Date.now();
		const promptSecs = firstTokenAt ? (firstTokenAt - startedAt) / 1000 : 0;
		const genSecs = firstTokenAt ? (endedAt - firstTokenAt) / 1000 : 0;
		sse(res, "done", {
			text: result.text,
			reasoning: result.reasoning,
			usage: result.usage,
			cost: 0,
			status: {
				model: `${endpoint.name}/${model.modelId}`,
				contextWindow: model.contextWindow || null,
				prompt: result.usage?.prompt_tokens && promptSecs > 0 ? result.usage.prompt_tokens / promptSecs : null,
				gen: result.usage?.completion_tokens && genSecs > 0 ? result.usage.completion_tokens / genSecs : null,
			},
		});
	} catch (err) {
		const known = err instanceof ExternalModelError;
		liveRecord.live.note(known ? err.message : `the model could not answer: ${err?.message ?? err}`);
		if (!disconnected) {
			sse(res, "error", { message: known ? err.message : `The model could not answer: ${err?.message ?? err}`, code: known ? "external_model_error" : "server_error", status: known ? err.status : 500 });
		}
	} finally {
		clearInterval(beat);
		release();
		endExternalLiveTurn(liveKey, liveRecord);
		if (!disconnected) res.end();
	}
}

/** Run one turn and stream it. Errors before the stream starts are plain JSON answers; after, an `error` event. */
export async function playgroundChat(req, res, body) {
	const message = String(body?.message ?? "");
	if (!message.trim()) return sendError(res, 400, "Type a message first.");
	if (message.length > MAX_MESSAGE) return sendError(res, 400, `A message is limited to ${MAX_MESSAGE / 1024} KB.`);
	const conversation = String(body?.conversation ?? "");
	if (!CONVERSATION.test(conversation)) return sendError(res, 400, "A conversation id is 8 to 64 letters, digits, - or _.");
	if (body?.externalModelId) return playgroundExternalChat(res, { conversation, keyId: String(body?.keyId ?? ""), externalModelId: String(body.externalModelId), message, history: body?.history, requestId: body?.requestId });
	let credential;
	try {
		credential = credentialFor(String(body?.keyId ?? ""), body?.agentId ? String(body.agentId) : null);
	} catch (err) {
		if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
		throw err;
	}
	auditOnce(`playground:${conversation}`, 6 * 3_600_000, "session.playground", credential.name, "a conversation was started from the dashboard Playground");
	const controller = new AbortController();
	let disconnected = false;
	let unsubscribe = null;
	// Never aborts the turn itself: the browser going away (a reload, a closed tab) must not cut off an
	// agent that is still working. Only this request's own plumbing comes down -- writing to a dead
	// `res` would throw. `GET .../conversation/<id>/events` is how a later request catches up on
	// whatever happens next, same as the client portal's own `GET .../events` (lib/portal.mjs).
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
			clientSessionId: sessionIdFor(body?.channel, conversation, body?.keyId, body?.agentId),
			inbox: true,
			colleagues: true,
			prompt: message,
			model: body?.model ? String(body.model) : null,
			signal: controller.signal,
			onSession: (record) => {
				// Only what happens in this turn: whatever the log already holds is older.
				const seen = record.live.snapshot().items.reduce((m, i) => Math.max(m, i.id), 0);
				// The *first* "user" item after that is this request's own prompt, already on screen the
				// moment it was typed -- echoing it back would duplicate it. Anything steered in later in
				// the same turn (POST .../steer, possibly from a different tab or device) is new to this
				// stream and has to be shown, so only that one echo is ever skipped, not every user item.
				let promptEchoId = null;
				unsubscribe = record.live.subscribe((change) => {
					if (disconnected) return;
					if (change.op === "add" && change.item.kind === "user" && promptEchoId === null && change.item.id > seen) {
						promptEchoId = change.item.id;
						return;
					}
					if ((change.op === "add" || change.op === "update") && change.item.id > seen) sse(res, "item", { op: change.op, item: change.item });
				});
			},
		});
		if (disconnected) return;
		sse(res, "done", { text: result.text, reasoning: result.reasoning, usage: result.usage, cost: result.cost });
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

/** Stop the turn in flight for a conversation -- the Playground's own "stop" button, now that losing
 * the connection no longer does this (same reasoning as lib/portal.mjs's own interruptConversation,
 * which this mirrors). Acts on the session directly, independent of whichever request started the
 * turn. */
async function interruptConversation(id, keyId, agentId, channel) {
	if (!CONVERSATION.test(String(id))) throw new AgentRunError("A conversation id is 8 to 64 letters, digits, - or _.", 400, "invalid_request_error", "invalid_request_error");
	const credential = credentialFor(String(keyId ?? ""), agentId ? String(agentId) : null);
	const scoped = scopedSessionId(credential, sessionIdFor(channel, id, keyId, agentId));
	const record = sessions.recordById(scoped) ?? (channel === "signal" ? null : externalLiveRecordById(`playground:${String(keyId ?? "")}:${id}`));
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
	if (aborted) record.live.note("interrupted from the Playground");
	audit("session.interrupt", credential.name, running ? (aborted ? "turn interrupted from the dashboard Playground" : "the interrupt failed") : "nothing was running");
	return { interrupted: aborted, wasRunning: running };
}

/** Send a message into the turn in flight, instead of waiting for it to finish -- the Playground's own
 * way to "steer" (lib/chat.mjs's steerSession; see there for what actually happens). An external model
 * (lib/externalmodels.mjs) has no Pi session to steer at all, so this only ever applies to a real
 * agent chat, same restriction as interruptConversation effectively has (nothing to abort either). */
async function steerConversation(id, keyId, agentId, channel, message) {
	if (!CONVERSATION.test(String(id))) throw new AgentRunError("A conversation id is 8 to 64 letters, digits, - or _.", 400, "invalid_request_error", "invalid_request_error");
	const text = String(message ?? "").trim();
	if (!text) throw new AgentRunError("Type a message first.", 400, "invalid_request_error", "invalid_request_error");
	if (text.length > MAX_MESSAGE) throw new AgentRunError(`A message is limited to ${MAX_MESSAGE / 1024} KB.`, 400, "invalid_request_error", "invalid_request_error");
	const credential = credentialFor(String(keyId ?? ""), agentId ? String(agentId) : null);
	const scoped = scopedSessionId(credential, sessionIdFor(channel, id, keyId, agentId));
	const record = sessions.recordById(scoped);
	const { steered } = await steerSession(record, text);
	if (!steered) throw new AgentRunError("Nothing is running in this conversation right now; send it as a normal message instead.", 409, "nothing_running", "invalid_request_error");
	audit("session.steer", credential.name, "a message was sent in while the turn was still running, from the dashboard Playground");
	return { steered: true };
}

/** End the server side of a conversation (its Pi session), when the person deletes it. */
export function endConversation(id, keyId, agentId, channel) {
	if (!CONVERSATION.test(String(id))) return false;
	let credential;
	try {
		credential = credentialFor(String(keyId ?? ""), agentId ? String(agentId) : null);
	} catch {
		return false;
	}
	const scoped = scopedSessionId(credential, sessionIdFor(channel, id, keyId, agentId));
	return sessions.has(scoped) ? sessions.close(scoped) : false;
}

const PLAYGROUND_MAX_WATCHERS_TOTAL = 20; // a quota of its own, same idea as lib/portal.mjs's

let playgroundWatching = 0;

/** Catch up a reconnecting Playground tab on a conversation's turn: the full LiveLog snapshot, and --
 * if it is still running -- a live stream of what happens next, ending when it settles. A conversation
 * with nothing live in memory (never started, already reaped, or ended) answers plainly with
 * `{live:false}`. Reuses the same `item`/`done`/`error` SSE vocabulary playgroundChat's own stream
 * already uses, so pgSend()'s one stream handler can serve both -- same design as lib/portal.mjs's own
 * `conversationEvents`, which this mirrors closely. */
async function playgroundConversationEvents(req, res, id, keyId, agentId, channel) {
	if (!CONVERSATION.test(String(id))) return sendError(res, 400, "A conversation id is 8 to 64 letters, digits, - or _.");
	let credential;
	try {
		credential = credentialFor(String(keyId ?? ""), agentId ? String(agentId) : null);
	} catch (err) {
		if (err instanceof AgentRunError) return sendError(res, err.status, err.message, err.code, err.type);
		throw err;
	}
	const scoped = scopedSessionId(credential, sessionIdFor(channel, id, keyId, agentId));
	const record = sessions.recordById(scoped) ?? (channel === "signal" ? null : externalLiveRecordById(`playground:${String(keyId ?? "")}:${id}`));
	if (!record) return sendJson(res, 200, { live: false }, { noStore: true });
	if (record.live.watchers >= MAX_WATCHERS_PER_SESSION || playgroundWatching >= PLAYGROUND_MAX_WATCHERS_TOTAL) {
		return sendError(res, 429, "Too many connections are already watching this chat.", "rate_limited");
	}
	playgroundWatching += 1;
	let closed = false;
	let unsubscribe = null;
	const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
	const cleanup = () => {
		if (closed) return;
		closed = true;
		playgroundWatching -= 1;
		clearInterval(beat);
		unsubscribe?.();
		if (!res.writableEnded) res.end();
	};
	res.on("close", cleanup);
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
	const snap = record.live.snapshot();
	// Same cold-start race lib/portal.mjs's conversationEvents fixed: `working` only flips true once Pi
	// emits its first event, but the turn can already be genuinely running (record.inflight > 0) before
	// that -- most visibly while its container is still starting. Without this, a reconnect landing in
	// that window would be told the turn was already done and the reply would finish with nobody
	// watching.
	const reallyWorking = snap.state.working || record.inflight > 0;
	sse(res, "snapshot", reallyWorking === snap.state.working ? snap : { ...snap, state: { ...snap.state, working: reallyWorking } });
	if (!reallyWorking) {
		sse(res, "done", { usage: null, cost: null });
		return cleanup();
	}
	unsubscribe = record.live.subscribe((change) => {
		if (change.op === "add" || change.op === "update") sse(res, "item", { op: change.op, item: change.item });
		else if (change.op === "state" && change.state.working === false) {
			sse(res, "done", { usage: null, cost: null });
			cleanup();
		} else if (change.op === "end") {
			sse(res, "error", { message: change.reason || "this chat ended", code: "session_ended" });
			cleanup();
		}
	});
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
		sendJson(res, 200, { ended: endConversation(del[1], q.get("keyId"), q.get("agentId"), q.get("channel")) });
		return true;
	}
	const events = /^\/dashboard\/playground\/conversation\/([A-Za-z0-9_-]+)\/events$/.exec(path);
	if (events && req.method === "GET") {
		if (!gate(res)) return true;
		const q = new URL(req.url, "http://x").searchParams;
		await playgroundConversationEvents(req, res, events[1], q.get("keyId"), q.get("agentId"), q.get("channel"));
		return true;
	}
	const interrupt = /^\/dashboard\/playground\/conversation\/([A-Za-z0-9_-]+)\/interrupt$/.exec(path);
	if (interrupt && req.method === "POST") {
		if (!gate(res)) return true;
		const q = new URL(req.url, "http://x").searchParams;
		try {
			sendJson(res, 200, await interruptConversation(interrupt[1], q.get("keyId"), q.get("agentId"), q.get("channel")));
		} catch (err) {
			if (err instanceof AgentRunError) sendError(res, err.status, err.message, err.code, err.type);
			else throw err;
		}
		return true;
	}
	const steer = /^\/dashboard\/playground\/conversation\/([A-Za-z0-9_-]+)\/steer$/.exec(path);
	if (steer && req.method === "POST") {
		if (!gate(res)) return true;
		const q = new URL(req.url, "http://x").searchParams;
		let body;
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body"), true;
		}
		try {
			sendJson(res, 200, await steerConversation(steer[1], q.get("keyId"), q.get("agentId"), q.get("channel"), body?.message));
		} catch (err) {
			if (err instanceof AgentRunError) sendError(res, err.status, err.message, err.code, err.type);
			else throw err;
		}
		return true;
	}
	return false;
}
