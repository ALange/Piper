/**
 * Kanban task cards: a title+prompt an agent runs at once, without anyone at a client, moved through
 * a 4-column board (To Do, In Progress, Action Required, Done). Closely mirrors lib/jobs.mjs's own
 * queue/pump/execute shape, but a card *is* its own single live run rather than a definition with a
 * history of many -- there is at most one live turn per card, and Done closes its session for good.
 *
 * Pickup is automatic: creating a card queues it at once (subject to KANBAN_MAX_PARALLEL). While the
 * agent is working, it may call piper_kanban_ask_question (piper-bridge.mjs, routed through
 * lib/runner.mjs's /kanban/ask-question) to pause and ask the person one question -- the card moves to
 * Action Required, the same session stays open, and answering it (answerCard) resumes that same
 * session with the answer as the next message. This can loop any number of times before Done. Once
 * Done (ok, error or cancelled), the card's session is closed: there is no further open-ended chat on
 * it, only a retry (a brand-new session) dragged back to To Do.
 *
 * The "ask a question" mechanism is a soft contract, not a hard pause: nothing in Pi's tool-calling
 * loop stops the model from continuing to generate after the tool returns. See the tool's own
 * description (piper-bridge.mjs) for the prompt-level instruction, and execute()'s precedence rule
 * below (asked wins over whatever text the turn produced) for how the damage is bounded rather than
 * prevented.
 */
import crypto from "node:crypto";
import { config, db } from "./settings.mjs";
import { apiKeys } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { credentialFor, runAgentTurn } from "./agentrun.mjs";
import { sessions } from "./sessions.mjs";

const MAX_TITLE = 120;
const MAX_PROMPT = 20_000;
const MAX_TEXT = 64 * 1024;
const MAX_QUESTION = 4 * 1024;
const MAX_ANSWER = 20_000;

export class KanbanError extends Error {
	constructor(message, status = 400, code = "invalid_request_error") {
		super(message);
		this.name = "KanbanError";
		this.status = status;
		this.code = code;
	}
}

const now = () => Date.now();
const sessionIdFor = (row) => `kanban:${row.id}:${row.run_seq}`;
const clip = (text, n) => (String(text).length > n ? `${String(text).slice(0, n)}\n… (cut at ${n} characters)` : String(text));

function logEvent(cardId, runSeq, kind, text = null) {
	db.prepare("INSERT INTO kanban_events (card_id, run_seq, kind, text, ts) VALUES (?, ?, ?, ?, ?)").run(cardId, runSeq, kind, text, now());
}

// -----------------------------------------------------------------------------------------------
// Rows and views
// -----------------------------------------------------------------------------------------------

export const getCard = (id) => db.prepare("SELECT * FROM kanban_cards WHERE id = ?").get(String(id)) ?? null;
export const listCards = (keyId) => db.prepare("SELECT * FROM kanban_cards WHERE key_id = ? ORDER BY created_at DESC").all(keyId).map(cardView);
export const listEvents = (cardId, limit = 200) =>
	db.prepare("SELECT * FROM kanban_events WHERE card_id = ? ORDER BY id DESC LIMIT ?").all(String(cardId), Math.max(1, Math.min(500, Number(limit) || 200))).map(eventView);

/** The column the board shows a row in: "queued" (over the concurrency cap) still reads as "To Do". */
const columnOf = (row) => (row.status === "queued" ? "todo" : row.status);

export function cardView(row) {
	if (!row) return null;
	const agent = row.agent_id ? agents.get(row.agent_id) : null;
	return {
		id: row.id,
		keyId: row.key_id,
		agentId: row.agent_id,
		agent: agent?.name ?? null,
		title: row.title,
		prompt: row.prompt,
		status: row.status,
		column: columnOf(row),
		outcome: row.outcome ?? null,
		question: row.question ?? null,
		text: row.text ?? null,
		error: row.error ?? null,
		tokens: Number(row.tokens ?? 0),
		cost: Number(row.cost ?? 0),
		runSeq: Number(row.run_seq ?? 0),
		createdAt: Number(row.created_at),
		startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
		endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
		updatedAt: Number(row.updated_at),
	};
}
const eventView = (r) => ({ id: Number(r.id), runSeq: Number(r.run_seq), kind: r.kind, text: r.text ?? null, ts: Number(r.ts) });

function checked({ keyId, agentId, title, prompt }) {
	const key = apiKeys.get(keyId);
	if (!key) throw new KanbanError("no such key", 404, "not_found");
	// agentId is optional: blank runs the card directly on the key itself (the "main" API key, with
	// no agent) -- the same choice Jobs already offers alongside assigning it to a named agent.
	if (agentId) {
		const agent = agents.get(agentId);
		if (!agent || agent.keyId !== key.id) throw new KanbanError("no such agent for this key", 404, "not_found");
		if (!agent.enabled) throw new KanbanError(`the agent "${agent.name}" is switched off`, 409, "agent_disabled");
	}
	const t = String(title ?? "").trim().slice(0, MAX_TITLE);
	if (!t) throw new KanbanError("a task card needs a title");
	const p = String(prompt ?? "");
	if (!p.trim()) throw new KanbanError("the instructions are empty");
	if (p.length > MAX_PROMPT) throw new KanbanError(`the instructions are over ${MAX_PROMPT} characters`);
	return { title: t, prompt: p };
}

// -----------------------------------------------------------------------------------------------
// Creating and deleting
// -----------------------------------------------------------------------------------------------

/** Create a card and queue it at once (subject to KANBAN_MAX_PARALLEL / KANBAN_MAX_PER_KEY). */
export function createCard({ keyId, agentId, title, prompt }) {
	if (!config.KANBAN_ENABLED) throw new KanbanError("task cards are switched off (Settings → Kanban)", 409, "kanban_disabled");
	const cap = Number(config.KANBAN_MAX_PER_KEY ?? 50);
	if (Number(db.prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE key_id = ?").get(keyId).n) >= cap) {
		throw new KanbanError(`you already have ${cap} task cards, the most you may have; delete one first`, 429, "rate_limited");
	}
	const ok = checked({ keyId, agentId, title, prompt });
	const id = `k${crypto.randomBytes(6).toString("hex")}`;
	const ts = now();
	db.prepare("INSERT INTO kanban_cards (id, key_id, agent_id, title, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)").run(id, keyId, agentId ?? null, ok.title, ok.prompt, ts, ts);
	logEvent(id, 0, "created", ok.title);
	audit("kanban.create", ok.title, `key ${apiKeys.get(keyId)?.name ?? keyId}${agentId ? ` / ${agents.get(agentId)?.name ?? agentId}` : ""}`);
	setImmediate(pump);
	return cardView(getCard(id));
}

export function deleteCard(id) {
	const row = getCard(id);
	if (!row) return false;
	if (row.status === "in_progress" || row.status === "action_required") abortRun(row.id);
	db.prepare("DELETE FROM kanban_events WHERE card_id = ?").run(id);
	db.prepare("DELETE FROM kanban_cards WHERE id = ?").run(id);
	audit("kanban.delete", row.title, "deleted with its history");
	return true;
}

/** Remove every card of a key (it was deleted) or of an agent (it was deleted). */
export function deleteCardsOf({ keyId = null, agentId = null }) {
	const rows = keyId ? db.prepare("SELECT id FROM kanban_cards WHERE key_id = ?").all(keyId) : agentId ? db.prepare("SELECT id FROM kanban_cards WHERE agent_id = ?").all(agentId) : [];
	for (const r of rows) deleteCard(r.id);
	return rows.length;
}

// -----------------------------------------------------------------------------------------------
// Queue / pump / execute -- one card is at most one live run at a time
// -----------------------------------------------------------------------------------------------

let runTurn = runAgentTurn;
/** Replace what runs a turn (tests); no argument restores it. */
export const setKanbanRunner = (fn) => void (runTurn = fn ?? runAgentTurn);
const controllers = new Map(); // card id -> AbortController, for a run going now
const asked = new Map(); // card id -> {question}, set synchronously by the bridge route during a live turn
let pumping = false;

/** Start queued cards while there is room. */
export function pump() {
	if (pumping) return;
	pumping = true;
	try {
		const max = Number(config.KANBAN_MAX_PARALLEL ?? 2);
		while (controllers.size < max) {
			const row = db.prepare("SELECT * FROM kanban_cards WHERE status IN ('todo', 'queued') ORDER BY created_at LIMIT 1").get();
			if (!row) break;
			const claimed = db.prepare("UPDATE kanban_cards SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ? AND status IN ('todo', 'queued')").run(now(), now(), row.id);
			if (!Number(claimed.changes)) continue;
			logEvent(row.id, row.run_seq, "started");
			runOn({ ...row, status: "in_progress" }, row.prompt);
		}
		// Anything still 'todo' past this point is over the cap -- mark it 'queued' so the board's To Do
		// count reflects a real wait rather than looking like nothing happened.
		db.prepare("UPDATE kanban_cards SET status = 'queued' WHERE status = 'todo'").run();
	} finally {
		pumping = false;
	}
}

/** Start (or resume) one card's turn with `promptText` as the message to send. */
function runOn(row, promptText) {
	const controller = new AbortController();
	controllers.set(row.id, controller);
	void execute(row, controller, promptText).finally(() => {
		controllers.delete(row.id);
		asked.delete(row.id);
		setImmediate(pump);
	});
}

async function execute(row, controller, promptText) {
	const id = row.id;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, Number(config.KANBAN_TIMEOUT_MS ?? 20 * 60_000));
	timer.unref?.();
	try {
		const credential = credentialFor(row.key_id, row.agent_id, { kanbanCardId: id });
		const sessionId = sessionIdFor(row);
		db.prepare("UPDATE kanban_cards SET session_id = ? WHERE id = ?").run(sessionId, id);
		const result = await runTurn({ credential, clientSessionId: sessionId, prompt: promptText, signal: controller.signal });
		// The precedence rule: whether the agent asked a question wins over whatever text it produced --
		// see the module doc comment above. asked.get(id) is set synchronously, during this same awaited
		// call, by the bridge route (/kanban/ask-question -> noteQuestion).
		const question = asked.get(id)?.question ?? null;
		if (question) {
			db.prepare("UPDATE kanban_cards SET status = 'action_required', question = ?, updated_at = ? WHERE id = ?").run(question, now(), id);
			logEvent(id, row.run_seq, "question", question);
			audit("kanban.question", row.title, question.slice(0, 200));
			return; // session stays open; answerCard() resumes it -- it is NOT closed here
		}
		const text = String(result.text ?? "");
		db.prepare("UPDATE kanban_cards SET status = 'done', outcome = 'ok', text = ?, tokens = ?, cost = ?, ended_at = ?, updated_at = ?, question = NULL WHERE id = ?").run(
			clip(text, MAX_TEXT), result.usage?.total_tokens ?? 0, result.cost ?? 0, now(), now(), id,
		);
		sessions.close(result.scopedId);
		logEvent(id, row.run_seq, "done", "ok");
		audit("kanban.done", row.title, "ok");
	} catch (err) {
		const outcome = timedOut ? "error" : controller.signal.aborted ? "cancelled" : "error";
		const message = timedOut ? "no answer within the time limit, so the turn was stopped" : controller.signal.aborted ? "cancelled" : String(err?.message ?? err).slice(0, 500);
		db.prepare("UPDATE kanban_cards SET status = 'done', outcome = ?, error = ?, ended_at = ?, updated_at = ?, question = NULL WHERE id = ?").run(outcome, message, now(), now(), id);
		try {
			sessions.close(sessionIdFor(row));
		} catch {
			/* the session may never have been created, or may already be gone */
		}
		logEvent(id, row.run_seq, outcome === "cancelled" ? "cancelled" : "done", message);
		audit("kanban.done", row.title, `${outcome}: ${message}`);
	} finally {
		clearTimeout(timer);
	}
}

/** Called by the bridge route (/kanban/ask-question) while the turn is still running, synchronously
 * within execute()'s own awaited runTurn() call -- see the module doc comment above. */
export function noteQuestion(cardId, question) {
	const q = String(question ?? "").trim().slice(0, MAX_QUESTION);
	if (!q) throw new Error("say what you need to ask");
	asked.set(cardId, { question: q });
}

/** The bridge-socket object for a container running one card's turn (lib/containers.mjs wires this in
 * as `kanban` only when `record.kanbanCardId` is set). */
export function kanbanBridgeFor(record) {
	return {
		askQuestion({ question }) {
			noteQuestion(record.kanbanCardId, question);
			return { noted: true };
		},
	};
}

function abortRun(id) {
	const controller = controllers.get(id);
	if (controller) {
		controller.abort();
		return true;
	}
	return false;
}

/** Resume an Action Required card with the user's answer: same session, next message. */
export function answerCard(id, text) {
	const row = getCard(id);
	if (!row) throw new KanbanError("no such card", 404, "not_found");
	if (row.status !== "action_required") throw new KanbanError("this card is not waiting on an answer", 409, "invalid_state");
	const answer = String(text ?? "").trim();
	if (!answer) throw new KanbanError("say something to answer with");
	if (answer.length > MAX_ANSWER) throw new KanbanError(`the answer is over ${MAX_ANSWER} characters`);
	logEvent(row.id, row.run_seq, "answer", answer);
	db.prepare("UPDATE kanban_cards SET status = 'in_progress', question = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
	runOn({ ...row, status: "in_progress" }, answer);
	return cardView(getCard(id));
}

/** Cancel a card. In Progress has a genuinely live turn, so this aborts its controller (which routes
 * through execute()'s own catch branch into done/cancelled). To Do/queued never started one, and
 * Action Required's turn already finished -- it's just sitting idle, waiting on a human reply, with
 * no live controller to abort -- so both of those are cancelled immediately here instead. */
export function cancelCard(id) {
	const row = getCard(id);
	if (!row) throw new KanbanError("no such card", 404, "not_found");
	if (row.status === "in_progress") {
		abortRun(id);
		return cardView(getCard(id));
	}
	if (row.status === "todo" || row.status === "queued" || row.status === "action_required") {
		db.prepare("UPDATE kanban_cards SET status = 'done', outcome = 'cancelled', error = 'cancelled', ended_at = ?, updated_at = ?, question = NULL WHERE id = ?").run(now(), now(), id);
		if (row.status === "action_required") {
			try {
				sessions.close(sessionIdFor(row));
			} catch {
				/* may already be gone */
			}
		}
		logEvent(id, row.run_seq, "cancelled");
		return cardView(getCard(id));
	}
	throw new KanbanError("this card is already done", 409, "invalid_state");
}

/** Retry: only valid from Done. Opens a brand-new session (run_seq+1), since the old one was closed. */
export function retryCard(id) {
	const row = getCard(id);
	if (!row) throw new KanbanError("no such card", 404, "not_found");
	if (row.status !== "done") throw new KanbanError("only a finished card can be retried", 409, "invalid_state");
	db.prepare("UPDATE kanban_cards SET status = 'todo', outcome = NULL, text = NULL, error = NULL, question = NULL, session_id = NULL, run_seq = run_seq + 1, started_at = NULL, ended_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
	logEvent(id, row.run_seq + 1, "retried");
	audit("kanban.retry", row.title, `run ${row.run_seq + 1}`);
	setImmediate(pump);
	return cardView(getCard(id));
}

// -----------------------------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------------------------

/** On restart, a card still In Progress/Action Required has no live controller or container anymore --
 * mark it error rather than attempt Jobs-style stale-run recovery; a partially-answered task has no
 * safe "peek the last answer" step worth it for v1. The user retries it if it matters. */
let purgeTimer = null;
export function startKanban() {
	if (purgeTimer) return;
	for (const row of db.prepare("SELECT * FROM kanban_cards WHERE status IN ('in_progress', 'action_required')").all()) {
		db.prepare("UPDATE kanban_cards SET status = 'done', outcome = 'error', error = ?, ended_at = ?, updated_at = ?, question = NULL WHERE id = ?").run(
			"the gateway restarted while this was running; retry it", now(), now(), row.id,
		);
		logEvent(row.id, row.run_seq, "done", "the gateway restarted while this was running");
	}
	setImmediate(pump);
	purgeTimer = setInterval(() => purgeCards(), 60 * 60_000);
	purgeTimer.unref?.();
}

export function stopKanban() {
	clearInterval(purgeTimer);
	purgeTimer = null;
	for (const c of controllers.values()) c.abort();
}

/** Forget Done cards (and their timelines) older than KANBAN_RESULT_DAYS. */
export function purgeCards(nowMs = Date.now()) {
	const days = Number(config.KANBAN_RESULT_DAYS ?? 30);
	const stale = db.prepare("SELECT id FROM kanban_cards WHERE status = 'done' AND ended_at < ?").all(nowMs - days * 86_400_000);
	for (const r of stale) {
		db.prepare("DELETE FROM kanban_events WHERE card_id = ?").run(r.id);
		db.prepare("DELETE FROM kanban_cards WHERE id = ?").run(r.id);
	}
	return stale.length;
}
