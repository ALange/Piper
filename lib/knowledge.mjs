/**
 * The knowledge base: entries every chat may search and read, from whatever gathers them. RSS
 * (lib/rssfeeds.mjs) is the first and, for now, only source; `source_type` keeps the door open for
 * another one later without anything here changing.
 *
 * This module is the only place that writes `knowledge_entries` — a producer like the RSS reader
 * calls `addEntry` directly (a plain function call, in-process); nothing exposes writing or deleting
 * to an agent. The agent-facing half (`mayLookupKnowledge`/`knowledgeFor`) is read and search only,
 * mirroring lib/agentmemory.mjs's `mayRemember`/`memoryFor` shape, and is available to every chat —
 * not an agent-only permission like hand-offs.
 */
import { config, db } from "./settings.mjs";

const PREVIEW_CHARS = 200;

const fromRow = (row) => ({
	id: Number(row.id),
	sourceType: row.source_type,
	sourceRef: row.source_ref,
	guid: row.guid,
	url: row.url,
	title: row.title,
	text: row.text,
	summary: row.summary,
	tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
	publishedAt: row.published_at === null ? null : Number(row.published_at),
	status: row.status,
	error: row.error,
	fetchedAt: row.fetched_at === null ? null : Number(row.fetched_at),
	createdAt: Number(row.created_at),
});

/**
 * Add or replace one entry, keyed by (sourceType, sourceRef, guid). A producer calls this for every
 * item it finds, whether or not it ends up extracted — `status` says which: 'pending' (queued),
 * 'skipped' (backfill: known, never queued), 'done' or 'failed' (the result of trying).
 */
export function addEntry({ sourceType, sourceRef = null, guid = null, url = null, title = null, text = null, summary = null, tags = null, publishedAt = null, status = "done", error = null }) {
	const now = Date.now();
	const tagText = Array.isArray(tags) ? tags.filter(Boolean).join(",") : tags || null;
	const fetchedAt = status === "done" || status === "failed" || status === "blocked" ? now : null;
	db.prepare(
		"INSERT INTO knowledge_entries (source_type, source_ref, guid, url, title, text, summary, tags, published_at, status, error, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT(source_type, source_ref, guid) DO UPDATE SET url = excluded.url, title = excluded.title, text = excluded.text, summary = excluded.summary, tags = excluded.tags, " +
			"published_at = excluded.published_at, status = excluded.status, error = excluded.error, fetched_at = excluded.fetched_at",
	).run(sourceType, sourceRef, guid, url, title, text, summary, tagText, publishedAt, status, error, fetchedAt, now);
	return getByKey(sourceType, sourceRef, guid);
}

export const getByKey = (sourceType, sourceRef, guid) => {
	const row = db.prepare("SELECT * FROM knowledge_entries WHERE source_type = ? AND source_ref IS ? AND guid IS ?").get(sourceType, sourceRef, guid);
	return row ? fromRow(row) : null;
};

export const getEntry = (id) => {
	const row = db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(Number(id));
	return row ? fromRow(row) : null;
};

/** Whether this source has ever been polled at all (so a producer knows to run its backfill rule once). */
export const sourceSeen = (sourceType, sourceRef) => Boolean(db.prepare("SELECT 1 FROM knowledge_entries WHERE source_type = ? AND source_ref IS ? LIMIT 1").get(sourceType, sourceRef));

/** Every source with at least one entry, for the dashboard: {sourceType, sourceRef, entries, bytes, updatedAt}. */
export function overview() {
	return db
		.prepare(
			"SELECT source_type, source_ref, COUNT(*) AS entries, SUM(LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(text,'')) + LENGTH(COALESCE(summary,''))) AS bytes, MAX(created_at) AS updated_at " +
				"FROM knowledge_entries GROUP BY source_type, source_ref ORDER BY updated_at DESC",
		)
		.all()
		.map((r) => ({ sourceType: r.source_type, sourceRef: r.source_ref, entries: Number(r.entries), bytes: Number(r.bytes) || 0, updatedAt: Number(r.updated_at) }));
}

/** One source's entries, for the dashboard: every status, newest first. */
export const entriesOf = (sourceType, sourceRef) => db.prepare("SELECT * FROM knowledge_entries WHERE source_type = ? AND source_ref IS ? ORDER BY created_at DESC").all(sourceType, sourceRef).map(fromRow);

export const removeEntry = (id) => Boolean(db.prepare("DELETE FROM knowledge_entries WHERE id = ?").run(Number(id)).changes);

export const clearSource = (sourceType, sourceRef) => Number(db.prepare("DELETE FROM knowledge_entries WHERE source_type = ? AND source_ref IS ?").run(sourceType, sourceRef).changes);

/** Forget entries older than KNOWLEDGE_RETENTION_DAYS. 0 keeps everything. */
export function purgeOld(now = Date.now()) {
	const days = Number(config.KNOWLEDGE_RETENTION_DAYS ?? 90);
	if (!days) return 0;
	return Number(db.prepare("DELETE FROM knowledge_entries WHERE created_at < ?").run(now - days * 86_400_000).changes);
}

/** What producers and the operator have done here, newest first — polls, extractions, deletes — for the
 * Knowledge page's Log tab. Read straight from the audit log by action prefix, not a separate table: a
 * future producer's own actions show up here the moment it starts naming them the same way. */
export function activityLog(limit = 200) {
	const max = Math.max(1, Math.min(500, Number(limit) || 200));
	return db
		.prepare("SELECT id, ts, action, target, detail, actor FROM audit WHERE action LIKE 'rss.%' OR action LIKE 'knowledge.%' OR action = 'runtime.rss' ORDER BY id DESC LIMIT ?")
		.all(max)
		.map((r) => ({ id: Number(r.id), ts: Number(r.ts), action: r.action, target: r.target, detail: r.detail, actor: r.actor ?? null }));
}

// ---------------------------------------------------------------------------------------------
// The agent-facing half: read and search only, available to every chat.
// ---------------------------------------------------------------------------------------------

/** Whether this chat may use the knowledge base at all, now. */
export function mayLookupKnowledge(record) {
	return Boolean(config.KNOWLEDGE_ENABLED) && Boolean(record?.scopeId ?? record?.keyId);
}

const clip = (text, n) => (text && text.length > n ? `${text.slice(0, n)}…` : text);

/** What the bridge hands to a chat's socket: `{search, read}`. Only ever sees a 'done' entry. */
export function knowledgeFor(record) {
	const require = () => {
		if (!mayLookupKnowledge(record)) throw new Error("this chat may not use the knowledge base");
	};
	return {
		search({ query } = {}) {
			require();
			const q = String(query ?? "").trim();
			const limit = Math.max(1, Math.min(200, Number(config.KNOWLEDGE_LOOKUP_LIMIT ?? 20)));
			const rows = q
				? db
						.prepare("SELECT * FROM knowledge_entries WHERE status = 'done' AND (title LIKE ? OR summary LIKE ? OR text LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT ?")
						.all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, limit)
				: db.prepare("SELECT * FROM knowledge_entries WHERE status = 'done' ORDER BY created_at DESC LIMIT ?").all(limit);
			return rows.map(fromRow).map((e) => ({ id: e.id, title: e.title, summary: e.summary, tags: e.tags, source: e.sourceType, url: e.url, publishedAt: e.publishedAt, preview: !e.summary ? clip(e.text, PREVIEW_CHARS) : undefined }));
		},
		read({ id } = {}) {
			require();
			const entry = getEntry(id);
			if (!entry || entry.status !== "done") throw new Error(`there is no entry called ${JSON.stringify(id)}`);
			return { id: entry.id, title: entry.title, text: entry.text, summary: entry.summary, tags: entry.tags, source: entry.sourceType, url: entry.url, publishedAt: entry.publishedAt };
		},
	};
}
