/**
 * The audit log: a record of what was done to the gateway and what happened to it, never of what
 * anyone said to an agent.
 *
 * Every row has a category, an actor (the dashboard, an API key, or the system) and the address the
 * request came from. What is recorded is chosen in Settings → Audit, one switch per category, plus how
 * long rows are kept. A category that is switched off is simply not stored. One category, `audit`, is
 * always on: a change to these settings, or a purge, is on record even if everything else is off.
 *
 * Call sites stay plain, `audit(action, target, detail)`: the actor and address come from a context set
 * once per request (`runWithActor`), and a call outside any request is the system's.
 *
 * Nothing secret is ever written. Settings changes are described by `settingChangeDetail`, which says
 * only that a secret or sensitive setting changed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config, db } from "./settings.mjs";

const MAX_DETAIL = 400;
const DAY = 24 * 60 * 60 * 1000;

/** The categories, their on/off setting (null: always on) and label for the page. */
export const AUDIT_CATEGORIES = [
	{ id: "auth", setting: "AUDIT_AUTH", label: "Sign-ins", optIn: false },
	{ id: "settings", setting: "AUDIT_SETTINGS", label: "Settings", optIn: false },
	{ id: "keys", setting: "AUDIT_KEYS", label: "Keys and profiles", optIn: false },
	{ id: "operations", setting: "AUDIT_OPERATIONS", label: "Operations", optIn: false },
	{ id: "runtime", setting: "AUDIT_RUNTIME", label: "Runtime events", optIn: false },
	{ id: "requests", setting: "AUDIT_REQUESTS", label: "API requests", optIn: true },
	{ id: "authfail", setting: "AUDIT_AUTH_FAILURES", label: "Failed API auth", optIn: true },
	{ id: "audit", setting: null, label: "Audit settings", optIn: false },
];
const BY_ID = new Map(AUDIT_CATEGORIES.map((c) => [c.id, c]));

// action prefix -> category
const PREFIXES = [
	["auth.", "auth"], ["settings.", "settings"], ["key.", "keys"], ["profile.", "keys"], ["session.", "keys"], ["models.", "keys"],
	["container.", "operations"], ["image.", "operations"], ["agent.", "operations"], ["host.", "operations"],
	["runtime.", "runtime"], ["request.", "requests"], ["authfail.", "authfail"], ["audit.", "audit"],
];

/** The category an action belongs to, from its prefix. An unknown prefix is an operation. */
export function categoryOf(action) {
	const text = String(action);
	return PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "operations";
}

/** Whether a category is being recorded now. */
export function auditEnabled(category) {
	const spec = BY_ID.get(category);
	if (!spec || spec.setting === null) return true;
	const value = config[spec.setting];
	return value === undefined ? !spec.optIn : Boolean(value);
}

// ---------------------------------------------------------------------------------------------
// Who did it: a context set once per request
// ---------------------------------------------------------------------------------------------

const context = new AsyncLocalStorage();

/** Run `fn` with an actor and address that every `audit()` inside it (and what it awaits) picks up. */
export const runWithActor = (actor, ip, fn) => context.run({ actor, ip: ip ?? null }, fn);
export const currentActor = () => context.getStore() ?? null;

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

const clean = (text, max) => String(text ?? "").replace(/\s+/g, " ").slice(0, max);

/**
 * Record one action. Returns the row id, or null when its category is off. Never throws: a full disk
 * must not stop the action being audited. `extra` may name `actor`, `ip` or `category` explicitly.
 */
export function audit(action, target, detail = "", extra = {}) {
	try {
		const category = extra.category ?? categoryOf(action);
		if (!auditEnabled(category)) return null;
		const ctx = currentActor();
		const actor = extra.actor ?? ctx?.actor ?? "system";
		const ip = extra.ip ?? ctx?.ip ?? null;
		const result = db
			.prepare("INSERT INTO audit (ts, action, target, detail, category, actor, ip) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(Date.now(), clean(action, 80), clean(target, 200), clean(detail, MAX_DETAIL), category, clean(actor, 120), ip ? clean(ip, 64) : null);
		return Number(result.lastInsertRowid);
	} catch {
		/* the record is a courtesy */
		return null;
	}
}

const recent = new Map();

/**
 * Like `audit`, but a repeat of the same `key` within `windowMs` is not a new row: the first row's
 * detail gets a count instead. So a flood of the same refusal is one line, not thousands.
 */
export function auditOnce(key, windowMs, action, target, detail = "", extra = {}, now = Date.now()) {
	const seen = recent.get(key);
	if (seen && now - seen.at < windowMs) {
		seen.count += 1;
		if (seen.id) {
			try {
				db.prepare("UPDATE audit SET detail = ? WHERE id = ?").run(clean(`${detail} (×${seen.count})`, MAX_DETAIL), seen.id);
			} catch {
				/* a courtesy */
			}
		}
		return seen.id;
	}
	if (recent.size > 500) for (const [k, v] of recent) if (now - v.at >= windowMs) recent.delete(k);
	const id = audit(action, target, detail, extra);
	recent.set(key, { at: now, count: 1, id });
	return id;
}

/** Forget what `auditOnce` remembers (tests). */
export function resetAuditDedupe() {
	recent.clear();
}

/**
 * What to write about a settings change. A secret or sensitive setting says only that it changed; any
 * other shows old -> new, each cut at 120 characters.
 */
export function settingChangeDetail(spec, before, after) {
	if (spec?.type === "secret" || spec?.sensitive) return "changed (value not recorded)";
	const show = (v) => {
		const text = v === undefined || v === null || v === "" ? "(empty)" : String(v);
		return text.length > 120 ? `${text.slice(0, 120)}…` : text;
	};
	return `${show(before)} -> ${show(after)}`;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

// Rows written before categories existed get theirs from their action, once.
for (const [prefix, category] of PREFIXES) {
	try {
		db.prepare("UPDATE audit SET category = ? WHERE category IS NULL AND action LIKE ?").run(category, `${prefix.replace(/[%_]/g, "\\$&")}%`);
	} catch {
		/* the table may be locked by another process; the rows stay readable */
	}
}
try {
	db.prepare("UPDATE audit SET category = 'operations' WHERE category IS NULL").run();
} catch {
	/* as above */
}

const rowOf = (r) => ({ id: Number(r.id), ts: Number(r.ts), category: r.category ?? categoryOf(r.action), action: r.action, target: r.target, detail: r.detail, actor: r.actor ?? null, ip: r.ip ?? null });

/** The newest records first, for the Containers page. */
export function recentAudit(limit = 100) {
	return db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(500, Number(limit) || 100))).map(rowOf);
}

/**
 * Records matching the filters, newest first. `before` is a row id (a cursor: pass the last id of the
 * previous page), `since` and `until` are times in ms, `q` matches action, target, detail and actor.
 */
export function queryAudit({ categories = [], q = "", actor = "", since = 0, until = 0, before = 0, limit = 100 } = {}) {
	const where = [];
	const args = [];
	const wanted = (Array.isArray(categories) ? categories : String(categories).split(",")).map((c) => String(c).trim()).filter((c) => BY_ID.has(c));
	if (wanted.length) {
		where.push(`category IN (${wanted.map(() => "?").join(",")})`);
		args.push(...wanted);
	}
	const text = String(q ?? "").trim();
	if (text) {
		const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
		where.push("(action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\')");
		args.push(like, like, like, like);
	}
	if (String(actor ?? "").trim()) {
		where.push("actor = ?");
		args.push(String(actor).trim());
	}
	if (Number(since) > 0) {
		where.push("ts >= ?");
		args.push(Number(since));
	}
	if (Number(until) > 0) {
		where.push("ts <= ?");
		args.push(Number(until));
	}
	if (Number(before) > 0) {
		where.push("id < ?");
		args.push(Number(before));
	}
	const max = Math.max(1, Math.min(500, Number(limit) || 100));
	const rows = db.prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, max + 1).map(rowOf);
	const more = rows.length > max;
	return { rows: rows.slice(0, max), more, next: more ? rows[max - 1].id : null };
}

/** How much there is, from when, per category, and which categories are being recorded. */
export function auditStats() {
	const counts = Object.fromEntries(db.prepare("SELECT category, COUNT(*) AS n FROM audit GROUP BY category").all().map((r) => [r.category ?? "operations", Number(r.n)]));
	const total = db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM audit").get();
	return {
		rows: Number(total.n),
		oldest: total.oldest ? Number(total.oldest) : null,
		retentionDays: config.AUDIT_RETENTION_DAYS ?? 90,
		maxRows: config.AUDIT_MAX_ROWS ?? 50000,
		categories: AUDIT_CATEGORIES.map((c) => ({ id: c.id, label: c.label, setting: c.setting, enabled: auditEnabled(c.id), count: counts[c.id] ?? 0 })),
	};
}

const csvCell = (value) => {
	let text = String(value ?? "");
	// A spreadsheet runs a cell that starts with one of these as a formula.
	if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Rows as CSV: time, category, action, actor, address, target, detail. */
export function auditCsv(rows) {
	const lines = [["time", "category", "action", "actor", "address", "target", "detail"].join(",")];
	for (const r of rows) lines.push([new Date(r.ts).toISOString(), r.category, r.action, r.actor, r.ip, r.target, r.detail].map(csvCell).join(","));
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

/**
 * Apply AUDIT_RETENTION_DAYS and AUDIT_MAX_ROWS: rows older than the first go, then the oldest beyond the
 * second. A purge that removed something is itself a row (category `audit`, always recorded).
 */
export function purgeAudit({ now = Date.now() } = {}) {
	let byAge = 0;
	let byCap = 0;
	const days = Number(config.AUDIT_RETENTION_DAYS ?? 90);
	const cap = Number(config.AUDIT_MAX_ROWS ?? 50000);
	if (days > 0) byAge = Number(db.prepare("DELETE FROM audit WHERE ts < ?").run(now - days * DAY).changes);
	if (cap > 0) {
		const total = Number(db.prepare("SELECT COUNT(*) AS n FROM audit").get().n);
		if (total > cap) byCap = Number(db.prepare("DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY id ASC LIMIT ?)").run(total - cap).changes);
	}
	if (byAge || byCap) audit("audit.purge", "audit log", `${byAge} older than ${days} day(s), ${byCap} over the ${cap} row limit`, { actor: "system" });
	return { byAge, byCap };
}
