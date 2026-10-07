/**
 * Agent memory: durable notes a chat writes, reads and searches through its bridge socket, never
 * through the container's own filesystem (that is what keeps writing and reading safe without needing
 * a throwaway container the way profile/workspace files do — the gateway itself owns the data and is
 * the only thing that ever touches it).
 *
 * The scope a chat's memory lives under is the same scope id everything else uses (lib/agents.mjs): a
 * key's own id for its main endpoint, an agent's own scope id (or, when the agent was made with memory
 * "shared", its key's id instead) for a named agent. Because every chat of the same key, or the same
 * agent, already resolves to the same scope id, "shared across its own chats" needs no extra code —
 * the one real choice is whether a named agent's memory also folds into its key's.
 */
import { config, db } from "./settings.mjs";
import { AGENT_SEP, memoryScopeOf } from "./agents.mjs";

const PREVIEW_CHARS = 160;

/** Whether this chat may use memory at all, now. */
export function mayRemember(record) {
	return Boolean(config.AGENT_MEMORY_ENABLED) && Boolean(record?.scopeId ?? record?.keyId);
}

/** The scope this chat's memory resolves to: its key's, or its agent's own or shared. */
export function memoryScopeFor(record) {
	const scopeId = record?.scopeId ?? record?.keyId ?? null;
	return scopeId ? memoryScopeOf(scopeId) : null;
}

/**
 * What the bridge hands to a chat's socket: `{write, read, lookup}`, bound to this chat's scope so a
 * tool call can never name another key's or agent's memory. Errors carry a message for the calling
 * agent to read, the same convention as lib/agentschedule.mjs and lib/delegate.mjs.
 */
export function memoryFor(record) {
	const scope = memoryScopeFor(record);
	const require = () => {
		if (!mayRemember(record) || !scope) throw new Error("this chat may not use memory");
	};
	return {
		write({ name, value } = {}) {
			require();
			const key = String(name ?? "").trim();
			if (!key) throw new Error("name a note to remember");
			const nameCap = Number(config.MEMORY_MAX_NAME_BYTES ?? 100);
			if (Buffer.byteLength(key) > nameCap) throw new Error(`that name is over the ${nameCap}-byte limit (MEMORY_MAX_NAME_BYTES)`);
			const text = String(value ?? "");
			if (!text.trim()) throw new Error("there is nothing to remember: the value is empty");
			const valueCap = Number(config.MEMORY_MAX_VALUE_BYTES ?? 4000);
			if (Buffer.byteLength(text) > valueCap) throw new Error(`that note is over the ${valueCap}-byte limit (MEMORY_MAX_VALUE_BYTES)`);
			const existing = db.prepare("SELECT id FROM memory_entries WHERE scope = ? AND name = ?").get(scope, key);
			if (!existing) {
				const cap = Number(config.MEMORY_MAX_ENTRIES ?? 200);
				const count = Number(db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE scope = ?").get(scope).n);
				if (count >= cap) throw new Error(`this memory already has ${cap} notes, the most allowed (MEMORY_MAX_ENTRIES); update an existing one by name, or ask the operator to clear some (Memory)`);
			}
			const now = Date.now();
			if (existing) db.prepare("UPDATE memory_entries SET value = ?, updated_at = ? WHERE id = ?").run(text, now, existing.id);
			else db.prepare("INSERT INTO memory_entries (scope, name, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(scope, key, text, now, now);
			return { name: key, updated: Boolean(existing) };
		},
		read({ name } = {}) {
			require();
			const key = String(name ?? "").trim();
			if (!key) throw new Error("name the note to recall");
			const row = db.prepare("SELECT value, updated_at FROM memory_entries WHERE scope = ? AND name = ?").get(scope, key);
			if (!row) throw new Error(`there is no note called "${key}"`);
			return { name: key, value: row.value, updatedAt: Number(row.updated_at) };
		},
		lookup({ query } = {}) {
			require();
			const q = String(query ?? "").trim();
			const limit = Math.max(1, Math.min(200, Number(config.MEMORY_LOOKUP_LIMIT ?? 20)));
			const rows = q
				? db.prepare("SELECT name, value, updated_at FROM memory_entries WHERE scope = ? AND (name LIKE ? OR value LIKE ?) ORDER BY updated_at DESC LIMIT ?").all(scope, `%${q}%`, `%${q}%`, limit)
				: db.prepare("SELECT name, value, updated_at FROM memory_entries WHERE scope = ? ORDER BY updated_at DESC LIMIT ?").all(scope, limit);
			return rows.map((r) => ({ name: r.name, preview: r.value.length > PREVIEW_CHARS ? `${r.value.slice(0, PREVIEW_CHARS)}…` : r.value, updatedAt: Number(r.updated_at) }));
		},
	};
}

/** Every scope with at least one note, for the dashboard: {scope, entries, bytes, updatedAt}. */
export function memoryOverview() {
	return db
		.prepare("SELECT scope, COUNT(*) AS entries, SUM(LENGTH(name) + LENGTH(value)) AS bytes, MAX(updated_at) AS updated_at FROM memory_entries GROUP BY scope ORDER BY updated_at DESC")
		.all()
		.map((r) => ({ scope: r.scope, entries: Number(r.entries), bytes: Number(r.bytes) || 0, updatedAt: Number(r.updated_at) }));
}

/** One scope's notes, for the dashboard. */
export function memoryEntries(scope) {
	return db
		.prepare("SELECT name, value, created_at, updated_at FROM memory_entries WHERE scope = ? ORDER BY updated_at DESC")
		.all(scope)
		.map((r) => ({ name: r.name, value: r.value, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }));
}

/** Remove one note. Returns whether there was one. */
export function deleteMemoryEntry(scope, name) {
	return Boolean(db.prepare("DELETE FROM memory_entries WHERE scope = ? AND name = ?").run(scope, name).changes);
}

/** Remove every note of a scope. Returns how many. */
export function clearMemory(scope) {
	return Number(db.prepare("DELETE FROM memory_entries WHERE scope = ?").run(scope).changes);
}

/**
 * Remove every note of a scope (an agent that is gone), or of a key and every agent of it (the key
 * itself is gone) — the same two cases lib/jobs.mjs's deleteJobsOf and lib/teams.mjs's
 * deleteTeamsOfKey clean up for jobs and teams.
 */
export function deleteMemoryOf({ scope = null, keyId = null } = {}) {
	if (scope) return clearMemory(scope);
	if (keyId) return Number(db.prepare("DELETE FROM memory_entries WHERE scope = ? OR scope LIKE ?").run(keyId, `${keyId}${AGENT_SEP}%`).changes);
	return 0;
}
