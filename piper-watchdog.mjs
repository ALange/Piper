#!/usr/bin/env node
/**
 * Piper watchdog: tells you when the gateway stops answering, which the gateway cannot do itself.
 *
 * Run every minute by a systemd timer (installed by deploy.sh --systemd). It asks /health, and
 * alerts through the webhook set in the dashboard (ALERT_WEBHOOK_URL) when the gateway has failed two
 * checks in a row (one failure can be an ordinary restart), and again when it answers once more.
 * State lives in `.watchdog-state`, so it says each thing once. With no webhook it does nothing but
 * keep that state.
 *
 * Standalone like piper-backup.mjs: it reads the two settings it needs from gateway.db read-only and
 * imports no gateway module, because importing them would open the database and migrate it.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSettings } from "./piper-backup.mjs";

/** Failed checks in a row before "down" is said. A restart takes a few seconds, a check runs a minute apart. */
export const FAILS_BEFORE_ALERT = 2;

/** The same body lib/alerts.mjs sends, so one receiver handles both. */
export function payload(event, message, details, { recovered = false, now = Date.now() } = {}) {
	const text = `${recovered ? "✅" : "⚠️"} Piper on ${hostname()}: ${message}`;
	return { event, recovered, message, host: hostname(), time: new Date(now).toISOString(), details, text, content: text };
}

function loadState(file) {
	try {
		const state = JSON.parse(readFileSync(file, "utf8"));
		return { fails: Number(state.fails) || 0, down: Boolean(state.down), since: state.since ?? null };
	} catch {
		return { fails: 0, down: false, since: null };
	}
}

/**
 * One check. Returns {healthy, fails, down, alerted}. `fetchFn` and `now` are parameters for the tests.
 */
export async function check({ dir, dbPath = join(dir, "gateway.db"), stateFile = join(dir, ".watchdog-state"), fetchFn = fetch, now = Date.now() }) {
	const settings = readSettings(dbPath, ["PORT", "ALERT_WEBHOOK_URL"]);
	const port = Number(settings.PORT) || 8787;
	const hook = String(settings.ALERT_WEBHOOK_URL ?? "").trim();
	const state = loadState(stateFile);
	let healthy = false;
	let detail = "";
	try {
		const res = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
		healthy = res.ok;
		if (!res.ok) detail = `it answered ${res.status}`;
	} catch (err) {
		detail = err?.cause?.code ?? err?.message ?? String(err);
	}
	const send = async (body) => {
		if (!hook) return false;
		try {
			const res = await fetchFn(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
			return res.ok;
		} catch {
			return false;
		}
	};
	let alerted = null;
	if (healthy) {
		if (state.down) {
			const minutes = state.since ? Math.max(1, Math.round((now - state.since) / 60_000)) : null;
			await send(payload("gateway_down", `the gateway is answering again${minutes ? ` after about ${minutes} minute(s)` : ""}`, { port }, { recovered: true, now }));
			alerted = "recovered";
		}
		state.fails = 0;
		state.down = false;
		state.since = null;
	} else {
		state.fails += 1;
		if (state.fails >= FAILS_BEFORE_ALERT && !state.down) {
			state.down = true;
			state.since = now;
			await send(payload("gateway_down", `the gateway is not answering on port ${port} (${detail}); ${state.fails} checks in a row have failed`, { port, detail }, { now }));
			alerted = "down";
		}
	}
	writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	chmodSync(stateFile, 0o600);
	return { healthy, fails: state.fails, down: state.down, alerted, hook: Boolean(hook) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const dir = dirname(fileURLToPath(import.meta.url));
	const dbPath = process.env.GATEWAY_DB || join(dir, "gateway.db");
	// No database: nothing has ever run here, so there is nothing to watch.
	if (!existsSync(dbPath)) process.exit(0);
	check({ dir, dbPath }).then(
		(r) => {
			if (r.alerted) console.log(`watchdog: ${r.alerted}${r.hook ? "" : " (no webhook set, nothing sent)"}`);
		},
		(err) => {
			console.error(`watchdog: ${err?.message ?? err}`);
			process.exit(0);
		},
	);
}
