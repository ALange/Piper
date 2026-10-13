/**
 * Idempotent replay for an external-model turn (lib/externalmodels.mjs).
 *
 * That turn is one direct, stateless HTTP call: no Pi session, no container, nothing durable behind
 * it. Today, a dropped connection or a gateway restart mid-stream simply loses the finished answer --
 * the caller has to resend the whole message as a brand new turn, and if the first call had actually
 * finished server-side (just never reached a listener), the model gets billed for the same question
 * twice. This closes exactly that gap, the way @earendil-works/pi-durable's own commit-before-
 * surfacing model does: a turn's answer is committed once it is ready, keyed by the caller's own
 * `requestId`, so a retry with the same id gets back what was already committed instead of calling the
 * model again.
 *
 * It does not pull in pi-durable itself: that package's Harness brings along a model-calling library,
 * a QuickJS sandbox and a WASM image library Piper has no use for here, just to get this one idea. A
 * tiny table in the gateway's own database already open gets the same guarantee for this narrow case.
 *
 * Fully opt-in. `requestId` is a new, optional field: a caller that never sends one (every caller
 * before this existed) never has a row looked up or written, and behaves exactly as it always has.
 */
import { db } from "./settings.mjs";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
// A safety net for a retry shortly after a drop, not a transcript store -- rows older than this are
// purged the moment anything next touches the table, so nothing needs its own sweep/timer.
const REPLAY_TTL_MS = 10 * 60_000;

/** `raw` as a usable request id, or null for anything blank or not shaped like one (never throws: a
 * malformed id just disables replay for this call instead of failing the chat over it). */
export function normalizeRequestId(raw) {
	const id = String(raw ?? "").trim();
	return REQUEST_ID.test(id) ? id : null;
}

function purgeExpired(now = Date.now()) {
	db.prepare("DELETE FROM external_turn_replay WHERE created_at < ?").run(now - REPLAY_TTL_MS);
}

/** A previously committed turn for this exact request id, key and model -- or null. Scoped to both so
 * one key can never replay another's answer, and a retry against a different model (a client bug)
 * gets a fresh call rather than someone else's text. */
export function findReplay(requestId, keyId, modelId) {
	if (!requestId) return null;
	purgeExpired();
	const row = db.prepare("SELECT text, reasoning, usage_json FROM external_turn_replay WHERE request_id = ? AND key_id = ? AND model_id = ?").get(requestId, keyId, modelId);
	if (!row) return null;
	let usage = null;
	try {
		usage = row.usage_json ? JSON.parse(row.usage_json) : null;
	} catch {
		/* a broken row is not worth failing the chat over; fall through as if no usage was recorded */
	}
	return { text: row.text, reasoning: row.reasoning ?? "", usage };
}

/** Commit a finished turn's answer under `requestId`, for `findReplay` to return on a retry. */
export function commitReplay(requestId, keyId, modelId, { text, reasoning = "", usage = null }) {
	if (!requestId) return;
	db.prepare(
		"INSERT INTO external_turn_replay (request_id, key_id, model_id, text, reasoning, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT(request_id) DO UPDATE SET key_id = excluded.key_id, model_id = excluded.model_id, text = excluded.text, reasoning = excluded.reasoning, usage_json = excluded.usage_json, created_at = excluded.created_at",
	).run(requestId, keyId, modelId, String(text ?? ""), String(reasoning ?? ""), usage ? JSON.stringify(usage) : null, Date.now());
}
