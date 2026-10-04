/**
 * Alerts: a message to a webhook when something needs a person.
 *
 * One JSON body that Slack-style receivers (`text`) and Discord-style ones (`content`) both read, and
 * that anything else can parse (`event`, `message`, `details`). An alert of a kind is sent once an
 * hour while the condition lasts, and its clearing is announced once. A failing webhook is logged and
 * never thrown: a broken alert channel must not break the thing being reported.
 */
import { hostname } from "node:os";
import { config } from "./settings.mjs";
import { audit } from "./audit.mjs";

/** How long an alert of one kind is held back after it was sent. */
export const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/** kind -> when it was last sent; a kind is here while its condition is considered active. */
const active = new Map();

/** The body sent for an alert. */
export function alertPayload(kind, message, details = {}, { host = hostname(), now = Date.now(), recovered = false } = {}) {
	const text = `${recovered ? "✅" : "⚠️"} Piper on ${host}: ${message}`;
	return { event: kind, recovered, message, host, time: new Date(now).toISOString(), details, text, content: text };
}

async function post(url, body, fetchFn) {
	try {
		const res = await fetchFn(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
		return { sent: true };
	} catch (err) {
		process.stderr.write(`alert not delivered (${body.event}): ${err?.message ?? err}\n`);
		return { sent: false, reason: err?.message ?? String(err) };
	}
}

/**
 * Report a condition. Held back for an hour after the last alert of this kind; the first report
 * after a quiet spell always goes. `fetchFn` and `now` are parameters for the tests.
 */
export async function alert(kind, message, details = {}, { fetchFn = fetch, now = Date.now(), url = config.ALERT_WEBHOOK_URL } = {}) {
	const last = active.get(kind);
	if (last !== undefined && now - last < ALERT_COOLDOWN_MS) return { sent: false, reason: "held back: sent recently" };
	// Recorded even with no webhook, so setting one later does not announce old news at once.
	active.set(kind, now);
	if (!url) return { sent: false, reason: "no webhook is set" };
	const outcome = await post(url, alertPayload(kind, message, details, { now }), fetchFn);
	audit("runtime.alert", kind, `${outcome.sent ? "sent" : `not delivered (${outcome.reason})`}: ${message}`, { actor: "system" });
	return outcome;
}

/** The condition cleared: say so once, and only if an alert of this kind had been raised. */
export async function recovered(kind, message, details = {}, { fetchFn = fetch, now = Date.now(), url = config.ALERT_WEBHOOK_URL } = {}) {
	if (!active.has(kind)) return { sent: false, reason: "nothing was raised" };
	active.delete(kind);
	if (!url) return { sent: false, reason: "no webhook is set" };
	return post(url, alertPayload(kind, message, details, { now, recovered: true }), fetchFn);
}

/** A message that is the point rather than a warning (a job's result): sent at once, never held back or remembered. */
export async function notifyNow(kind, message, details = {}, { fetchFn = fetch, url = config.ALERT_WEBHOOK_URL } = {}) {
	if (!url) return { sent: false, reason: "no webhook is set" };
	const body = alertPayload(kind, message, details);
	body.text = `📋 Piper on ${body.host}: ${message}`;
	body.content = body.text;
	return post(url, body, fetchFn);
}

/** A test alert, for the dashboard's button. It ignores the hold-back and reports the outcome. */
export async function testAlert({ fetchFn = fetch, url = config.ALERT_WEBHOOK_URL } = {}) {
	if (!url) return { sent: false, reason: "no webhook is set (Settings → Containers → Alerts)" };
	return post(url, alertPayload("test", "this is a test alert: alerts reach you", {}), fetchFn);
}

/** Forget what was raised (tests). */
export function resetAlerts() {
	active.clear();
}
