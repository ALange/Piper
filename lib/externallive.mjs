/**
 * The same "catch a reconnecting tab up on a turn still running" ability lib/sessions.mjs's `LiveLog`
 * gives agent chats, but for an external-model chat (lib/portal.mjs's portalExternalChat / lib/
 * playground.mjs's playgroundExternalChat), which has no Pi session or container to carry a record --
 * it is one plain streaming HTTP call. Without this, a reload mid-reply from an external model had
 * nothing to reconnect to at all (unlike an agent chat), and was stuck on "Thinking..." forever: the
 * turn kept running and finishing server-side, but no record of it survived the request that started
 * it, so there was nothing left to tell a reconnecting tab the answer ever came back.
 *
 * Deliberately minimal: one LiveLog per in-flight (or just-finished) turn, keyed by whatever the
 * caller chooses (portal.mjs and playground.mjs each use their own `${scope}:${keyId}:${conversation}`
 * so the two never collide and a key can never reconnect into another key's turn). A finished record
 * lingers for GRACE_MS so a reload landing just after "done" still sees the real answer instead of a
 * confusing {live:false}, then is dropped -- there is no container to hibernate and nothing durable to
 * keep forever.
 */
import { LiveLog } from "./livesession.mjs";

const GRACE_MS = 2 * 60_000;
const records = new Map();

/** Start tracking a new turn. Replaces (and clears the grace timer of) any stale record still sitting
 * under the same key -- normal turn-taking means at most one of these is ever really in flight. */
export function startExternalLiveTurn(scopedKey) {
	const prior = records.get(scopedKey);
	if (prior?.timer) clearTimeout(prior.timer);
	const controller = new AbortController();
	const live = new LiveLog();
	live.feed({ type: "agent_start" });
	const record = { live, inflight: 1, controller, session: { abort: async () => controller.abort() }, timer: null };
	records.set(scopedKey, record);
	return record;
}

export function externalLiveRecordById(scopedKey) {
	return records.get(scopedKey) ?? null;
}

/** The turn is over (answered or failed) -- mark it settled and schedule the record's own cleanup. */
export function endExternalLiveTurn(scopedKey, record) {
	record.inflight = 0;
	record.live.feed({ type: "agent_settled" });
	if (record.timer) clearTimeout(record.timer);
	record.timer = setTimeout(() => records.delete(scopedKey), GRACE_MS);
	record.timer.unref?.(); // a leftover grace timer must never be the reason the process won't exit
}
