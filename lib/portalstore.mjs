/**
 * The client portal's own chat history (`lib/portal.mjs`): one row per key, the whole conversation
 * list — titles, which agent, every message — kept as one JSON blob, the same shape the browser
 * already keeps in its own `sessionStorage`. The point is only so logging in from another browser
 * or device shows the same chats; nothing here is read by anything else in the gateway.
 */
import { config, db } from "./settings.mjs";

/** The stored history for one key, or `null` when it has never saved any. */
export function getHistory(keyId) {
	const row = db.prepare("SELECT data, updated_at FROM portal_history WHERE key_id = ?").get(keyId);
	if (!row) return null;
	try {
		return { data: JSON.parse(row.data), updatedAt: Number(row.updated_at) };
	} catch {
		return null;
	}
}

export class PortalStoreError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Replace one key's whole history. `data` is stored exactly as given (the browser's own shape); only
 * its serialized size is checked here, never its structure — that is the portal's own business. */
export function saveHistory(keyId, data) {
	const text = JSON.stringify(data ?? null);
	const cap = Number(config.PORTAL_HISTORY_MAX_BYTES ?? 4 * 1024 * 1024);
	if (Buffer.byteLength(text, "utf8") > cap) throw new PortalStoreError(`that is over the ${cap}-byte limit (PORTAL_HISTORY_MAX_BYTES) — trim a conversation or two`, 413);
	const now = Date.now();
	db.prepare(
		"INSERT INTO portal_history (key_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
	).run(keyId, text, now);
	return now;
}

/** When the key itself goes. */
export const deleteHistoryOf = (keyId) => Boolean(db.prepare("DELETE FROM portal_history WHERE key_id = ?").run(keyId).changes);
