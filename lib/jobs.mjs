/**
 * Jobs: a prompt an agent runs without anyone at a client. Three things start a run:
 *
 *   a schedule      structured, in the gateway's local time: every N minutes or hours, daily, on chosen weekdays, once
 *   a webhook       POST /v1/piper/jobs/<id>/trigger with the job's own token (so CI or GitHub can call it)
 *   a request       POST /v1/piper/jobs from a key's client, answered at once with an id to poll
 *
 * A run is `runAgentTurn` with the owning key's (and agent's) credential, so it is limited, metered and attributed
 * exactly like a chat the key sent itself: its session cap, spend cap and model allow-list apply, a revoked or
 * expired key runs nothing, and the cost lands on the key and the agent.
 *
 * The scheduler wakes every 15 seconds and queues what is due. A job never overlaps itself (a second run while one
 * is going is recorded as skipped), a missed run is made up once after downtime, at most `JOBS_MAX_PARALLEL` runs go
 * at once, and a run has a time limit that aborts the turn. When a job has a webhook, the finished run is POSTed to
 * it, signed.
 *
 * Unattended runs are looked after three ways. A result reaches the owner (notify: never, changes, always) in the
 * inbox, which the next chat of that key and agent shows at the top of its reply, and on the alert webhook. A "memory"
 * job starts fresh each run but is shown its last reports, and a task that answers NO_CHANGE is not delivered. A job
 * whose scheduled runs keep failing is switched off (JOBS_MAX_FAILURES), and one over its 24-hour spend cap skips runs.
 * A job tied to an agent that is disabled, or (for one the agent made for itself) that lost its scheduling permission,
 * is simply not queued on its due tick — paused rather than run-and-failed, and resumed by itself once the agent or
 * its permission is back; a manual or webhook-triggered run is unaffected, and still refused in the usual way.
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { config, db, parseDuration } from "./settings.mjs";
import { apiKeys, sha256 } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { guardedLookup, isBlockedAddress, setInboxSource } from "./chat.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { sessions } from "./sessions.mjs";
import { notifyNow } from "./alerts.mjs";

const TICK_MS = 15_000;
const MAX_PROMPT = 20_000;
const MAX_TEXT = 64 * 1024;
export const MAX_PAYLOAD = 16 * 1024;
const WEBHOOK_TEXT = 4 * 1024;
const MIN_TIMEOUT = 10_000;
const MAX_TIMEOUT = 2 * 60 * 60_000;
const NOTIFY_MODES = ["never", "changes", "always"];
const SESSION_MODES = ["fresh", "continue", "memory"];
const MEMORY_RUNS = 3; // earlier reports a "memory" run is shown
const MEMORY_CHARS = 1500; // of each
const INBOX_TEXT = 2000;
const INBOX_KEEP = 20; // unseen results kept per owner; older ones are dropped
/** What a task replies when there is nothing new to report; with notify "changes" it is not delivered. */
export const NO_CHANGE = "NO_CHANGE";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export class JobError extends Error {
	constructor(message, status = 400, code = "invalid_request_error") {
		super(message);
		this.name = "JobError";
		this.status = status;
		this.code = code;
	}
}

// ---------------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------------

const clock = (text) => {
	const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? "").trim());
	if (!m) throw new JobError("a time of day looks like 07:30 (24 hours)");
	return { hour: Number(m[1]), minute: Number(m[2]) };
};
const pad = (n) => String(n).padStart(2, "0");

/** A schedule from what a form or client sent, in its canonical shape; throws JobError for nonsense. */
export function validateSchedule(input) {
	const s = input && typeof input === "object" ? input : {};
	switch (s.kind) {
		case "manual":
			return { kind: "manual" };
		case "interval": {
			const unit = s.unit === "hours" ? "hours" : s.unit === "minutes" ? "minutes" : null;
			const every = Number(s.every);
			if (!unit || !Number.isInteger(every) || every < 1) throw new JobError("an interval is a whole number of minutes or hours, at least 1");
			if (every * (unit === "hours" ? 60 : 1) > 7 * 24 * 60) throw new JobError("an interval is at most 7 days");
			return { kind: "interval", every, unit };
		}
		case "daily": {
			const { hour, minute } = clock(s.at);
			return { kind: "daily", at: `${pad(hour)}:${pad(minute)}` };
		}
		case "weekly": {
			const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].sort();
			if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new JobError("choose at least one weekday (0 is Sunday, 6 is Saturday)");
			const { hour, minute } = clock(s.at);
			return { kind: "weekly", days, at: `${pad(hour)}:${pad(minute)}` };
		}
		case "once": {
			const at = typeof s.at === "number" ? s.at : Date.parse(String(s.at ?? ""));
			if (!Number.isFinite(at)) throw new JobError("a one-time schedule needs a date and time");
			return { kind: "once", at: Math.round(at) };
		}
		default:
			throw new JobError("a schedule is one of: manual, interval, daily, weekly, once");
	}
}

/**
 * When a schedule next fires after `from` (ms), or null when it never does. Wall-clock fields are rebuilt for
 * each candidate day, so a daylight-saving change moves nothing: 07:30 stays 07:30.
 */
export function nextRun(schedule, from = Date.now()) {
	switch (schedule?.kind) {
		case "interval":
			return from + schedule.every * (schedule.unit === "hours" ? 3_600_000 : 60_000);
		case "once":
			return schedule.at > from ? schedule.at : null;
		case "daily":
		case "weekly": {
			const { hour, minute } = clock(schedule.at);
			const base = new Date(from);
			for (let offset = 0; offset <= 8; offset++) {
				const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hour, minute, 0, 0);
				if (candidate.getTime() <= from) continue;
				if (schedule.kind === "weekly" && !schedule.days.includes(candidate.getDay())) continue;
				return candidate.getTime();
			}
			return null;
		}
		default:
			return null;
	}
}

/** A schedule in words, for the Jobs page and the API. */
export function describeSchedule(schedule) {
	switch (schedule?.kind) {
		case "manual":
			return "only when started";
		case "interval":
			return `every ${schedule.every === 1 ? (schedule.unit === "hours" ? "hour" : "minute") : `${schedule.every} ${schedule.unit}`}`;
		case "daily":
			return `every day at ${schedule.at}`;
		case "weekly":
			return `${schedule.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ")} at ${schedule.at}`;
		case "once":
			return `once, ${new Date(schedule.at).toLocaleString()}`;
		default:
			return "unknown";
	}
}

// ---------------------------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------------------------

const parseSchedule = (row) => {
	try {
		return JSON.parse(row.schedule_json);
	} catch {
		return { kind: "manual" };
	}
};

/** The most dollars a job may spend in 24 hours: its own cap, else the default for schedules agents made; 0 is none. */
function costCap(row) {
	if (row.daily_cost_cap !== null && row.daily_cost_cap !== undefined) return Number(row.daily_cost_cap);
	return row.origin === "agent" ? Number(config.AGENT_JOBS_DAILY_COST ?? 0) : 0;
}

const spentInLastDay = (jobId, now = Date.now()) => Number(db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM job_runs WHERE job_id = ? AND queued_at > ?").get(jobId, now - 86_400_000).c);

/** A job row as the dashboard and the API show it: never the trigger token's hash or the signing secret. */
export function scheduledJobView(row) {
	if (!row) return null;
	const schedule = parseSchedule(row);
	const last = db.prepare("SELECT id, status, started_at, ended_at, cost FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
	const agent = row.agent_id ? agents.get(row.agent_id) : null;
	return {
		id: row.id,
		keyId: row.key_id,
		agentId: row.agent_id ?? null,
		agent: agent?.name ?? null,
		name: row.name,
		prompt: row.prompt,
		model: row.model ?? null,
		schedule,
		scheduleText: describeSchedule(schedule),
		sessionMode: row.session_mode,
		webhookUrl: row.webhook_url ?? null,
		hasTrigger: Boolean(row.trigger_hash),
		enabled: Boolean(row.enabled),
		timeoutMs: Number(row.timeout_ms),
		notify: row.notify ?? "never",
		failStreak: Number(row.fail_streak ?? 0),
		dailyCostCap: row.daily_cost_cap === null || row.daily_cost_cap === undefined ? null : Number(row.daily_cost_cap),
		effectiveCostCap: costCap(row),
		disabledReason: row.disabled_reason ?? null,
		origin: row.origin,
		createdAt: Number(row.created_at),
		nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
		last: last ? { id: Number(last.id), status: last.status, startedAt: last.started_at === null ? null : Number(last.started_at), endedAt: last.ended_at === null ? null : Number(last.ended_at), cost: Number(last.cost) } : null,
	};
}

/** A run row; `full` adds the prompt that was sent and the whole result. */
export function runView(row, { full = false } = {}) {
	if (!row) return null;
	const out = {
		id: Number(row.id),
		jobId: row.job_id,
		status: row.status,
		trigger: row.trigger,
		queuedAt: Number(row.queued_at),
		startedAt: row.started_at === null ? null : Number(row.started_at),
		endedAt: row.ended_at === null ? null : Number(row.ended_at),
		tokens: Number(row.tokens),
		cost: Number(row.cost),
		error: row.error ?? null,
		note: row.note ?? null,
		webhook: row.webhook ?? null,
		preview: row.text ? row.text.slice(0, 160) : "",
	};
	if (full) Object.assign(out, { text: row.text ?? "", prompt: row.prompt });
	return out;
}

export const getJob = (id) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(String(id)) ?? null;
export const listJobs = ({ keyId = null, origin = null } = {}) =>
	db.prepare(`SELECT * FROM jobs ${keyId || origin ? `WHERE ${[keyId ? "key_id = ?" : null, origin ? "origin = ?" : null].filter(Boolean).join(" AND ")}` : ""} ORDER BY created_at DESC`).all(...[keyId, origin].filter(Boolean)).map(scheduledJobView);
export const listRuns = (jobId, limit = 50) => db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(String(jobId), Math.max(1, Math.min(200, Number(limit) || 50))).map((r) => runView(r));
export const getRun = (id) => db.prepare("SELECT * FROM job_runs WHERE id = ?").get(Number(id)) ?? null;

// ---------------------------------------------------------------------------------------------
// Creating and changing
// ---------------------------------------------------------------------------------------------

const newToken = () => `pjt_${crypto.randomBytes(24).toString("base64url")}`;
const newSecret = () => `whsec_${crypto.randomBytes(24).toString("base64url")}`;

/** A completion webhook URL: http or https only. `strict` (a client's, not the operator's) also refuses internal addresses. */
export function validateWebhookUrl(text, { strict = false } = {}) {
	const value = String(text ?? "").trim();
	if (!value) return null;
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new JobError("the webhook is not a URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new JobError("the webhook must be an http or https URL");
	if (url.username || url.password) throw new JobError("put no credentials in the webhook URL");
	if (strict && /^[\d.]+$|^\[/.test(url.hostname) && isBlockedAddress(url.hostname)) throw new JobError("the webhook may not point at an internal address");
	return url.href;
}

function checked({ keyId, agentId, name, prompt, model, timeoutMs, sessionMode, notify, dailyCostCap }) {
	const key = apiKeys.get(keyId);
	if (!key) throw new JobError("no such key", 404, "not_found");
	if (agentId) {
		const agent = agents.get(agentId);
		if (!agent || agent.keyId !== key.id) throw new JobError("no such agent for this key", 404, "not_found");
	}
	const text = String(prompt ?? "");
	if (!text.trim()) throw new JobError("the prompt is empty");
	if (text.length > MAX_PROMPT) throw new JobError(`the prompt is over ${MAX_PROMPT} characters`);
	const label = String(name ?? "").trim().slice(0, 80);
	if (!label) throw new JobError("a job needs a name");
	const timeout = timeoutMs === undefined || timeoutMs === null || timeoutMs === "" ? 600_000 : parseDuration(timeoutMs);
	if (!Number.isFinite(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) throw new JobError("the time limit is between 10 seconds and 2 hours");
	if (sessionMode !== undefined && !SESSION_MODES.includes(sessionMode)) throw new JobError("a job keeps its conversation (continue), starts fresh (fresh) or starts fresh with its last reports as notes (memory)");
	if (notify !== undefined && !NOTIFY_MODES.includes(notify)) throw new JobError("notify is never, changes (only when the report differs) or always");
	let cap = null;
	if (dailyCostCap !== undefined && dailyCostCap !== null && dailyCostCap !== "") {
		cap = Number(dailyCostCap);
		if (!Number.isFinite(cap) || cap < 0) throw new JobError("the daily cost cap is a number of dollars, 0 for none");
	}
	return { text, label, timeout, cap, model: String(model ?? "").trim().slice(0, 200) || null };
}

/**
 * Create a job. Returns `{job, triggerToken: null, webhookSecret}`: the signing secret exists when there is a
 * webhook, and is returned here once (and when regenerated) because a receiver needs it to verify a signature.
 */
export function createJob({ keyId, agentId = null, name, prompt, model = null, schedule = { kind: "manual" }, sessionMode = "fresh", webhookUrl = null, timeoutMs = undefined, origin = "dashboard", enabled = true, notify = undefined, dailyCostCap = undefined }) {
	// A schedule an agent made for itself tells its owner when something changed; the operator's jobs stay quiet unless asked.
	const tell = notify ?? (origin === "agent" ? "changes" : "never");
	const ok = checked({ keyId, agentId, name, prompt, model, timeoutMs, sessionMode, notify: tell, dailyCostCap });
	const plan = validateSchedule(schedule);
	const url = validateWebhookUrl(webhookUrl, { strict: origin === "api" });
	const id = `j${crypto.randomBytes(6).toString("hex")}`;
	const secret = url ? newSecret() : null;
	const now = Date.now();
	db.prepare("INSERT INTO jobs (id, key_id, agent_id, name, prompt, model, schedule_json, session_mode, webhook_url, webhook_secret, enabled, timeout_ms, origin, created_at, next_run_at, notify, daily_cost_cap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
		id, keyId, agentId, ok.label, ok.text, ok.model, JSON.stringify(plan), sessionMode, url, secret, enabled ? 1 : 0, ok.timeout, origin, now, enabled ? nextRun(plan, now) : null, tell, ok.cap,
	);
	audit("job.create", ok.label, `${describeSchedule(plan)}; key ${apiKeys.get(keyId)?.name ?? keyId}${agentId ? ` / ${agents.get(agentId)?.name}` : ""}; ${origin}`);
	return { job: scheduledJobView(getJob(id)), triggerToken: null, webhookSecret: secret };
}

/** Change a job. Only the fields given change. Returns `{job, webhookSecret}` (a new secret when a webhook was added). */
export function updateJob(id, patch) {
	const row = getJob(id);
	if (!row) throw new JobError("no such job", 404, "not_found");
	const next = {
		keyId: row.key_id,
		agentId: patch.agentId === undefined ? row.agent_id : patch.agentId || null,
		name: patch.name ?? row.name,
		prompt: patch.prompt ?? row.prompt,
		model: patch.model === undefined ? row.model : patch.model,
		timeoutMs: patch.timeoutMs ?? row.timeout_ms,
		sessionMode: patch.sessionMode ?? row.session_mode,
		notify: patch.notify ?? row.notify,
		dailyCostCap: patch.dailyCostCap === undefined ? row.daily_cost_cap : patch.dailyCostCap,
	};
	const ok = checked(next);
	const plan = patch.schedule === undefined ? parseSchedule(row) : validateSchedule(patch.schedule);
	const enabled = patch.enabled === undefined ? Boolean(row.enabled) : Boolean(patch.enabled);
	let url = row.webhook_url;
	let secret = row.webhook_secret;
	let fresh = null;
	if (patch.webhookUrl !== undefined) {
		url = validateWebhookUrl(patch.webhookUrl, { strict: row.origin === "api" });
		if (!url) secret = null;
		else if (!secret) secret = fresh = newSecret();
	}
	// A changed schedule, or turning a job on, is timed from now; otherwise the next run stands.
	const retime = patch.schedule !== undefined || (patch.enabled !== undefined && enabled && !row.enabled);
	const nextAt = !enabled ? null : retime ? nextRun(plan) : row.next_run_at === null ? nextRun(plan) : Number(row.next_run_at);
	// Turning a job on again is the owner's answer to a switch-off: the failure count starts over.
	const reset = patch.enabled !== undefined && enabled && !row.enabled;
	db.prepare("UPDATE jobs SET agent_id = ?, name = ?, prompt = ?, model = ?, schedule_json = ?, session_mode = ?, webhook_url = ?, webhook_secret = ?, enabled = ?, timeout_ms = ?, next_run_at = ?, notify = ?, daily_cost_cap = ?, fail_streak = ?, disabled_reason = ? WHERE id = ?").run(
		next.agentId, ok.label, ok.text, ok.model, JSON.stringify(plan), next.sessionMode, url, secret, enabled ? 1 : 0, ok.timeout, nextAt, next.notify, ok.cap, reset ? 0 : row.fail_streak, reset ? null : row.disabled_reason, id,
	);
	audit("job.update", ok.label, `${describeSchedule(plan)}; ${enabled ? "on" : "off"}`);
	return { job: scheduledJobView(getJob(id)), webhookSecret: fresh };
}

/** Give a job a webhook trigger token (or a new one). The token is returned once; only its hash is kept. */
export function newTrigger(id) {
	const row = getJob(id);
	if (!row) throw new JobError("no such job", 404, "not_found");
	const token = newToken();
	db.prepare("UPDATE jobs SET trigger_hash = ? WHERE id = ?").run(sha256(token), id);
	audit("job.trigger", row.name, "a trigger token was created or replaced");
	return token;
}

export function clearTrigger(id) {
	const row = getJob(id);
	if (!row) throw new JobError("no such job", 404, "not_found");
	db.prepare("UPDATE jobs SET trigger_hash = NULL WHERE id = ?").run(id);
	audit("job.trigger", row.name, "the trigger token was revoked");
}

/** A new signing secret for the completion webhook, returned once. */
export function newWebhookSecret(id) {
	const row = getJob(id);
	if (!row) throw new JobError("no such job", 404, "not_found");
	if (!row.webhook_url) throw new JobError("this job has no webhook");
	const secret = newSecret();
	db.prepare("UPDATE jobs SET webhook_secret = ? WHERE id = ?").run(secret, id);
	audit("job.update", row.name, "the webhook signing secret was replaced");
	return secret;
}

export function deleteJob(id) {
	const row = getJob(id);
	if (!row) return false;
	cancelJobRuns(id);
	db.prepare("DELETE FROM job_runs WHERE job_id = ?").run(id);
	db.prepare("DELETE FROM job_inbox WHERE job_id = ?").run(id);
	db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
	audit("job.delete", row.name, "deleted with its history");
	return true;
}

/** Remove every job of a key (it was deleted) or of an agent (it was deleted). */
export function deleteJobsOf({ keyId = null, agentId = null }) {
	const rows = keyId ? db.prepare("SELECT id FROM jobs WHERE key_id = ?").all(keyId) : agentId ? db.prepare("SELECT id FROM jobs WHERE agent_id = ?").all(agentId) : [];
	for (const r of rows) deleteJob(r.id);
	return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Queueing and running
// ---------------------------------------------------------------------------------------------

let runTurn = runAgentTurn;
/** Replace what runs a turn (tests); no argument restores it. */
export const setJobRunner = (fn) => void (runTurn = fn ?? runAgentTurn);
const controllers = new Map(); // run id -> AbortController, for runs going now
let pumping = false;

const insertRun = (job, trigger, prompt, status, extra = {}) => {
	const now = Date.now();
	const result = db.prepare("INSERT INTO job_runs (job_id, key_id, prompt, trigger, status, queued_at, started_at, ended_at, error, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
		job.id, job.key_id, prompt, trigger, status, now, status === "queued" ? null : now, status === "queued" ? null : now, extra.error ?? null, extra.note ?? null,
	);
	return Number(result.lastInsertRowid);
};

/** How many runs of a key are waiting or going. */
const activeRuns = (keyId) => Number(db.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE key_id = ? AND status IN ('queued', 'running')").get(keyId).n);

/**
 * Queue one run of a job. `payload` (a webhook's body, text) replaces `{{payload}}` in the prompt. A run while another
 * of the same job is queued or going is recorded as skipped and not run; a key over `JOBS_MAX_PER_KEY` is refused.
 * Returns the run's view.
 */
export function queueRun(jobId, trigger = "manual", { payload = "", note = null } = {}) {
	const job = getJob(jobId);
	if (!job) throw new JobError("no such job", 404, "not_found");
	if (!config.JOBS_ENABLED) throw new JobError("jobs are switched off (Settings → Jobs)", 409, "jobs_disabled");
	const prompt = String(job.prompt).replaceAll("{{payload}}", String(payload).slice(0, MAX_PAYLOAD));
	const busy = db.prepare("SELECT id FROM job_runs WHERE job_id = ? AND status IN ('queued', 'running') LIMIT 1").get(job.id);
	if (busy) {
		const id = insertRun(job, trigger, prompt, "skipped", { error: "the previous run is still going", note });
		return runView(getRun(id));
	}
	// The spend guard: a scheduled run that would start while the job is over its 24-hour cap does not run.
	const dollars = costCap(job);
	if (trigger === "schedule" && dollars > 0) {
		const spent = spentInLastDay(job.id);
		if (spent >= dollars) {
			const lastRun = db.prepare("SELECT error FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job.id);
			const reason = `daily cost cap reached: $${spent.toFixed(2)} spent in the last 24 hours, the cap is $${dollars.toFixed(2)}`;
			const id = insertRun(job, trigger, prompt, "skipped", { error: reason, note });
			// Said once when the cap is first hit, not at every tick that follows.
			if (!String(lastRun?.error ?? "").startsWith("daily cost cap")) void tellOwner(job, id, `${job.name}: paused by its cost cap`, `${reason}. Scheduled runs resume by themselves as the spend ages out of the 24 hours.`).catch(() => {});
			return runView(getRun(id));
		}
	}
	const cap = Number(config.JOBS_MAX_PER_KEY ?? 20);
	if (activeRuns(job.key_id) >= cap) {
		if (trigger === "schedule") {
			const id = insertRun(job, trigger, prompt, "skipped", { error: `the key already has ${cap} runs waiting or going`, note });
			return runView(getRun(id));
		}
		throw new JobError(`this key already has ${cap} runs waiting or going`, 429, "rate_limited");
	}
	const id = insertRun(job, trigger, prompt, "queued", { note });
	setImmediate(pump);
	return runView(getRun(id));
}

/** Start queued runs while there is room. */
export function pump() {
	if (pumping) return;
	pumping = true;
	try {
		const max = Number(config.JOBS_MAX_PARALLEL ?? 2);
		while (controllers.size < max) {
			const row = db.prepare("SELECT * FROM job_runs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
			if (!row) break;
			const claimed = db.prepare("UPDATE job_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), row.id);
			if (!Number(claimed.changes)) continue;
			const controller = new AbortController();
			controllers.set(Number(row.id), controller);
			void execute(row, controller).finally(() => {
				controllers.delete(Number(row.id));
				setImmediate(pump);
			});
		}
	} finally {
		pumping = false;
	}
}

const finish = (id, fields) => {
	const sets = Object.keys(fields);
	db.prepare(`UPDATE job_runs SET ended_at = ?, ${sets.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND status = 'running'`).run(Date.now(), ...sets.map((k) => fields[k]), Number(id));
};

/** A reply with nothing in it but the no-change marker. */
const isQuiet = (text) => new RegExp(`^\\s*${NO_CHANGE}\\s*[.!]?\\s*$`, "i").test(String(text ?? ""));
const digestOf = (text) => crypto.createHash("sha256").update(String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
const clip = (text, n) => (String(text).length > n ? `${String(text).slice(0, n)}…` : String(text));

/**
 * What a run is actually asked. A "memory" job starts a fresh session, so its last few real reports are put in front of
 * the task, newest first: the agent can compare, and it does not carry a growing conversation. A job that notifies on
 * change is told how to say there is nothing new.
 */
function promptFor(job, run) {
	const notes = [];
	if (job.session_mode === "memory") {
		const earlier = db.prepare("SELECT text, ended_at FROM job_runs WHERE job_id = ? AND status = 'ok' AND id < ? AND text IS NOT NULL ORDER BY id DESC LIMIT 12").all(job.id, Number(run.id))
			.filter((r) => r.text.trim() && !isQuiet(r.text))
			.slice(0, MEMORY_RUNS);
		notes.push(`This is a scheduled task ("${job.name}"), run on its own at ${new Date().toLocaleString()}. You do not remember earlier runs; ${earlier.length ? "your previous reports are below, newest first." : "this is the first one."}`);
		for (const r of earlier) notes.push(`--- report of ${new Date(Number(r.ended_at)).toLocaleString()} ---\n${clip(r.text, MEMORY_CHARS)}`);
	}
	if (job.notify === "changes") notes.push(`If nothing worth telling the owner has changed since your last report, reply with exactly ${NO_CHANGE} and nothing else. Otherwise reply with a report of what is new.`);
	return notes.length ? `${notes.join("\n\n")}\n\nTask:\n${run.prompt}` : run.prompt;
}

async function execute(run, controller) {
	const job = getJob(run.job_id);
	const id = Number(run.id);
	if (!job) return finish(id, { status: "cancelled", error: "the job was deleted" });
	let timedOut = false;
	let broken = false; // the key or agent can no longer run anything: retrying cannot help
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, Number(job.timeout_ms));
	timer.unref?.();
	let outcome;
	try {
		const credential = credentialFor(job.key_id, job.agent_id);
		const sessionId = job.session_mode === "continue" ? `job:${job.id}` : `job:${job.id}:${id}`;
		const result = await runTurn({ credential, clientSessionId: sessionId, prompt: promptFor(job, run), model: job.model, signal: controller.signal });
		if (job.session_mode !== "continue") sessions.close(result.scopedId);
		const text = String(result.text ?? "");
		outcome = { status: "ok", text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)` : text, tokens: result.usage?.total_tokens ?? 0, cost: result.cost ?? 0, digest: digestOf(text) };
	} catch (err) {
		if (timedOut) outcome = { status: "timeout", error: `no answer within ${Math.round(Number(job.timeout_ms) / 1000)} s, so the turn was stopped` };
		else if (controller.signal.aborted) outcome = { status: "cancelled", error: "cancelled" };
		else if (err instanceof AgentRunError && (err.status === 401 || err.status === 404 || err.status === 409 || err.status === 429)) {
			outcome = { status: "skipped", error: err.message };
			broken = err.status !== 429;
		} else outcome = { status: "error", error: String(err?.message ?? err).slice(0, 500) };
	} finally {
		clearTimeout(timer);
	}
	const previous = outcome.status === "ok" ? db.prepare("SELECT digest FROM job_runs WHERE job_id = ? AND status = 'ok' AND id < ? ORDER BY id DESC LIMIT 1").get(job.id, id) : null;
	finish(id, outcome);
	audit("runtime.job", job.name, `run ${id} ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`, { actor: "system" });
	await report(job, run, outcome, { broken, unchanged: Boolean(previous?.digest) && previous.digest === outcome.digest }).catch((err) => process.stderr.write(`jobs: report: ${err?.message ?? err}\n`));
	await deliverWebhook(job, id).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Telling the owner, and switching a failing job off
// ---------------------------------------------------------------------------------------------

/**
 * Put a message where the owner will see it: in the inbox (shown at the top of the next reply of a chat of this key and
 * agent) and, when an alert webhook is set, there too.
 */
async function tellOwner(job, runId, title, text) {
	db.prepare("INSERT INTO job_inbox (key_id, agent_id, job_id, run_id, ts, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)").run(job.key_id, job.agent_id ?? null, job.id, runId, Date.now(), title, clip(text, INBOX_TEXT));
	db.prepare("DELETE FROM job_inbox WHERE key_id = ? AND agent_id IS ? AND seen_at IS NULL AND id NOT IN (SELECT id FROM job_inbox WHERE key_id = ? AND agent_id IS ? AND seen_at IS NULL ORDER BY id DESC LIMIT ?)").run(job.key_id, job.agent_id ?? null, job.key_id, job.agent_id ?? null, INBOX_KEEP);
	if (config.JOBS_NOTIFY_ALERTS) await notifyNow("job", `${title}\n${clip(text, 1500)}`, { job: job.id, run: runId });
}

/** Results waiting for the chats of this key (and agent): returned oldest first and marked seen. */
export function takeInbox(keyId, agentId = null) {
	if (!keyId) return [];
	const rows = db.prepare("SELECT id, ts, title, text FROM job_inbox WHERE key_id = ? AND agent_id IS ? AND seen_at IS NULL ORDER BY id LIMIT 10").all(keyId, agentId ?? null);
	if (rows.length) db.prepare(`UPDATE job_inbox SET seen_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`).run(Date.now(), ...rows.map((r) => r.id));
	return rows.map((r) => ({ id: Number(r.id), ts: Number(r.ts), title: r.title, text: r.text }));
}

/** The inbox as the block a reply starts with. */
export function inboxNotice(items) {
	return items.map((i) => `[scheduled: ${i.title} · ${new Date(i.ts).toLocaleString()}]\n${i.text}`).join("\n\n");
}

/** After a run: count failures, switch a job that keeps failing off, and deliver the result as the job's notify setting asks. */
async function report(job, run, outcome, { broken, unchanged }) {
	const failed = outcome.status === "error" || outcome.status === "timeout" || (outcome.status === "skipped" && broken);
	const id = Number(run.id);
	if (run.trigger === "schedule" && (failed || outcome.status === "ok")) {
		const streak = outcome.status === "ok" ? 0 : Number(getJob(job.id)?.fail_streak ?? 0) + 1;
		db.prepare("UPDATE jobs SET fail_streak = ? WHERE id = ?").run(streak, job.id);
		const limit = Number(config.JOBS_MAX_FAILURES ?? 0);
		if (failed && limit > 0 && streak >= limit && getJob(job.id)?.enabled) {
			const reason = `${streak} scheduled runs in a row failed (last: ${outcome.error ?? outcome.status})`;
			db.prepare("UPDATE jobs SET enabled = 0, next_run_at = NULL, disabled_reason = ? WHERE id = ?").run(reason, job.id);
			audit("job.update", job.name, `switched off automatically: ${reason}`, { actor: "system" });
			await tellOwner(job, id, `${job.name}: switched off`, `${reason}. Fix the cause and turn it on again; its schedule was ${describeSchedule(parseSchedule(job))}.`);
			return;
		}
	}
	const mode = job.notify ?? "never";
	if (mode === "never") return;
	if (failed) return tellOwner(job, id, `${job.name}: ${outcome.status}`, outcome.error ?? outcome.status);
	if (outcome.status !== "ok") return;
	if (mode === "changes" && (isQuiet(outcome.text) || unchanged)) return;
	return tellOwner(job, id, job.name, outcome.text);
}

/** Cancel a queued or running run. Returns whether there was one to cancel. */
export function cancelRun(runId) {
	const row = getRun(runId);
	if (!row) return false;
	if (row.status === "queued") {
		db.prepare("UPDATE job_runs SET status = 'cancelled', ended_at = ?, error = 'cancelled' WHERE id = ? AND status = 'queued'").run(Date.now(), Number(row.id));
		return true;
	}
	const controller = controllers.get(Number(row.id));
	if (row.status === "running" && controller) {
		controller.abort();
		return true;
	}
	return false;
}

function cancelJobRuns(jobId) {
	for (const r of db.prepare("SELECT id FROM job_runs WHERE job_id = ? AND status IN ('queued', 'running')").all(jobId)) cancelRun(r.id);
}

// ---------------------------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------------------------

/**
 * Queue what is due at `now`. A job that is late (the gateway was down) runs once, not once per missed time, and is
 * timed from now. A one-time job turns itself off after it has fired.
 */
/**
 * Whether a scheduled job could even be tried right now, without trying it: a job whose agent was
 * switched off, or (for one an agent made for itself) lost its own scheduling permission or the
 * gateway's AGENT_JOBS_ENABLED switch, is simply not queued. This is what pauses it instead of letting
 * it run, fail, and eventually auto-disable on the noise of its own refusal.
 */
function schedulableNow(row) {
	if (!row.agent_id) return true;
	const agent = agents.get(row.agent_id);
	if (!agent || !agent.enabled) return false;
	if (row.origin === "agent" && (!config.AGENT_JOBS_ENABLED || !agent.canSchedule)) return false;
	return true;
}

export function tick(now = Date.now()) {
	if (!config.JOBS_ENABLED) return 0;
	let queued = 0;
	for (const row of db.prepare("SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now)) {
		const schedule = parseSchedule(row);
		const late = now - Number(row.next_run_at);
		const upcoming = nextRun(schedule, now);
		db.prepare("UPDATE jobs SET next_run_at = ?, enabled = ? WHERE id = ?").run(upcoming, schedule.kind === "once" ? 0 : 1, row.id);
		if (!schedulableNow(row)) continue; // paused; its next slot is already scheduled above, so it resumes by itself
		try {
			queueRun(row.id, "schedule", { note: late > 2 * TICK_MS ? `late by ${Math.round(late / 1000)} s: made up once` : null });
			queued += 1;
		} catch {
			/* queueRun records its own refusals; a disabled scheduler never gets here */
		}
	}
	return queued;
}

let timer = null;
let lastPurge = 0;

/** Start the scheduler. Runs a previous process left going are marked failed; queued ones are picked up. */
export function startJobs() {
	if (timer) return;
	setInboxSource((record) => inboxNotice(takeInbox(record.keyId ?? null, record.agentId ?? null)));
	const stale = db.prepare("UPDATE job_runs SET status = 'error', ended_at = ?, error = 'the gateway stopped while this was running' WHERE status = 'running'").run(Date.now());
	if (Number(stale.changes)) audit("runtime.job", "jobs", `${stale.changes} run(s) were interrupted by a restart`, { actor: "system" });
	timer = setInterval(() => {
		try {
			tick();
			pump();
			if (Date.now() - lastPurge > 60 * 60_000) {
				lastPurge = Date.now();
				purgeRuns();
			}
		} catch (err) {
			process.stderr.write(`jobs: ${err?.message ?? err}\n`);
		}
	}, TICK_MS);
	timer.unref?.();
	setImmediate(pump);
}

export function stopJobs() {
	clearInterval(timer);
	timer = null;
	for (const c of controllers.values()) c.abort();
}

/** Forget runs older than `JOBS_RESULT_DAYS`. */
export function purgeRuns(now = Date.now()) {
	const days = Number(config.JOBS_RESULT_DAYS ?? 30);
	const removed = Number(db.prepare("DELETE FROM job_runs WHERE ended_at IS NOT NULL AND ended_at < ?").run(now - days * 86_400_000).changes);
	db.prepare("DELETE FROM job_inbox WHERE seen_at IS NOT NULL AND seen_at < ?").run(now - days * 86_400_000);
	// A request from a client is a job of its own; once its results are gone it is too.
	db.prepare("DELETE FROM jobs WHERE origin = 'api' AND NOT EXISTS (SELECT 1 FROM job_runs WHERE job_runs.job_id = jobs.id)").run();
	return removed;
}

// ---------------------------------------------------------------------------------------------
// Inbound webhook
// ---------------------------------------------------------------------------------------------

/**
 * Start a job from its webhook. The token is the job's own (hashed in the database), compared in constant time;
 * a job without one, or with the wrong one, is a 404 so a caller learns nothing about which ids exist. At most one
 * trigger per `JOBS_MIN_INTERVAL_MS`; the body is cut at 16 KB and becomes `{{payload}}` in the prompt.
 */
export function trigger(jobId, token, body = "") {
	const row = getJob(jobId);
	const expected = row?.trigger_hash ?? "";
	const given = sha256(String(token ?? ""));
	const same = expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
	if (!row || !expected || !same) throw new JobError("not found", 404, "not_found");
	if (!row.enabled) throw new JobError("this job is switched off", 409, "job_disabled");
	const now = Date.now();
	const gap = Number(config.JOBS_MIN_INTERVAL_MS ?? 0);
	if (gap > 0 && now - Number(row.trigger_at) < gap) throw new JobError(`triggered too soon: at most once every ${Math.round(gap / 1000)} s`, 429, "rate_limited");
	db.prepare("UPDATE jobs SET trigger_at = ? WHERE id = ?").run(now, row.id);
	return queueRun(row.id, "webhook", { payload: String(body).slice(0, MAX_PAYLOAD) });
}

// ---------------------------------------------------------------------------------------------
// Completion webhook
// ---------------------------------------------------------------------------------------------

/** The `X-Piper-Signature` value: `t=<seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. */
export const signWebhook = (secret, body, at = Math.floor(Date.now() / 1000)) => `t=${at},v1=${crypto.createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;

function post(url, body, headers, { strict, timeoutMs = 5000 }) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const client = target.protocol === "https:" ? https : http;
		const req = client.request(target, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers }, timeout: timeoutMs, ...(strict ? { lookup: guardedLookup } : {}) }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode));
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
		req.end(body);
	});
}

/** Tell the job's webhook how a run ended. One retry; the outcome is written on the run. Never throws. */
export async function deliverWebhook(job, runId) {
	if (!job.webhook_url || !job.webhook_secret) return null;
	const run = getRun(runId);
	if (!run) return null;
	const body = JSON.stringify({ job: { id: job.id, name: job.name }, run: { id: Number(run.id), trigger: run.trigger }, status: run.status, text: String(run.text ?? "").slice(0, WEBHOOK_TEXT), error: run.error ?? null, cost: Number(run.cost) });
	let outcome = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const status = await post(job.webhook_url, body, { "X-Piper-Signature": signWebhook(job.webhook_secret, body), "X-Piper-Job": job.id }, { strict: job.origin === "api" });
			outcome = status >= 200 && status < 300 ? `delivered (${status})` : `the webhook answered ${status}`;
			if (status >= 200 && status < 300) break;
		} catch (err) {
			outcome = `the webhook failed: ${err.message}`;
		}
	}
	db.prepare("UPDATE job_runs SET webhook = ? WHERE id = ?").run(outcome, Number(runId));
	return outcome;
}

// ---------------------------------------------------------------------------------------------
// Asynchronous requests from a key's client
// ---------------------------------------------------------------------------------------------

/**
 * `POST /v1/piper/jobs`: run a prompt in the background as `credential`'s key (on one of its agents when `agent` names
 * one) and return at once. The job is a manual one that is run immediately; it is visible only to this key.
 */
export function submit(credential, { prompt, model = null, agent = null, webhook_url: webhookUrl = null, name = null, timeout_ms: timeoutMs }) {
	const keyId = credential?.id;
	if (!keyId || !apiKeys.get(keyId)) throw new JobError("this needs an API key", 401, "invalid_api_key");
	let agentId = null;
	if (agent) {
		const found = agents.find(keyId, String(agent));
		if (!found) throw new JobError(`this key has no agent called "${agent}"`, 404, "not_found");
		agentId = found.id;
	}
	if (activeRuns(keyId) >= Number(config.JOBS_MAX_PER_KEY ?? 20)) throw new JobError(`this key already has ${config.JOBS_MAX_PER_KEY} runs waiting or going`, 429, "rate_limited");
	const { job, webhookSecret } = createJob({ keyId, agentId, name: name || `request ${new Date().toISOString().slice(0, 16)}`, prompt, model, schedule: { kind: "manual" }, webhookUrl, timeoutMs, origin: "api" });
	const run = queueRun(job.id, "api");
	return { id: job.id, runId: run.id, status: run.status, webhookSecret };
}

/** What a client sees of its own request: the job and its newest run with the result. Another key's is a 404. */
export function requestStatus(credential, id) {
	const row = getJob(id);
	if (!row || row.origin !== "api" || row.key_id !== credential?.id) throw new JobError("no such job", 404, "not_found");
	const run = db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
	const view = runView(run, { full: true });
	return { id: row.id, status: view?.status ?? "queued", text: view?.text ?? "", error: view?.error ?? null, tokens: view?.tokens ?? 0, cost: view?.cost ?? 0, startedAt: view?.startedAt ?? null, endedAt: view?.endedAt ?? null, webhook: view?.webhook ?? null };
}

/** Cancel a client's own request. Returns whether there was a run to cancel. */
export function cancelRequest(credential, id) {
	const row = getJob(id);
	if (!row || row.origin !== "api" || row.key_id !== credential?.id) throw new JobError("no such job", 404, "not_found");
	const run = db.prepare("SELECT id FROM job_runs WHERE job_id = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1").get(row.id);
	return run ? cancelRun(run.id) : false;
}
