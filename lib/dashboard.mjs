/** The dashboard: its pages, settings, API key management and spend reports. */
import { readFileSync } from "node:fs";
import { GATEWAY_DB, SETTINGS_SPEC, coerceSetting, config, db, formatDuration, parseModelPatterns, serializeSetting, specByKey } from "./settings.mjs";
import { ApiKeyStore, PASSWORD_MIN, apiKeys, authRequired, clearPasswordHash, clearSessionCookie, dashboardHash, hashPassword, keyLabel, loginFails, loginWaitMs, noteLoginFailure, setPasswordHash, setSessionCookie, verifiedSettingsKeys, verifyPassword } from "./auth.mjs";
import { modelRuntime, resolveModel } from "./models.mjs";
import { checkEngine, imageInfo, resetEngineCheck } from "./engine.mjs";
import { checkedContainerSettings, containerDefaults, normalizeContainerInput } from "./keycontainer.mjs";
import { audit, recentAudit } from "./audit.mjs";
import { allowedEndpoints, catalogueFor, containerPiDirInfo, directProviders, ensureContainerPiDir, readContainerSettings, redactedModelsText, saveContainerDefaults, saveModelsText } from "./containerpi.mjs";
import { AgentError, agentView, createAgent, deleteAgent, deleteAgentsOfKey, renewAgentPort, resetAgentContainer, setAgentEnabled, updateAgent } from "./agentservers.mjs";
import { agentScope, agents } from "./agents.mjs";
import { CONTAINER_ACTIONS, containerAction, containerExec, diskSummary, engineOptions, listContainers, removePersistentContainer } from "./containers.mjs";
import { EngineError } from "./engine.mjs";
import { testAlert } from "./alerts.mjs";
import { buildImage, listImages, pruneImages, removeImage } from "./images.mjs";
import { readJson, sendError } from "./http.mjs";
import { bundleListFromInput, grantedBundles, profileOp } from "./profiles.mjs";
import { keyLimits, sessions, spentToday } from "./sessions.mjs";

/** Push the settings that can change without a restart into the running services. */
export function applyLiveSettings() {
	sessions.configure({
		maxSessions: config.MAX_SESSIONS,
		maxLifetimeMs: config.SESSION_MAX_LIFETIME_MS,
		idleMs: config.SESSION_IDLE_MS,
		oneShotMs: config.ONE_SHOT_TTL_MS,
		keepMs: config.CHAT_KEEP_MS,
	});
}

/** Validate a partial update, persist it, and apply what can be applied live. */
export async function saveSettings(updates) {
	const upsert = db.prepare(
		"INSERT INTO settings (key, value, source, updated_at) VALUES (?, ?, 'ui', ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = 'ui', updated_at = excluded.updated_at",
	);
	const applied = [];
	const restart = [];
	for (const [key, raw] of Object.entries(updates ?? {})) {
		const spec = specByKey.get(key);
		if (!spec) throw new Error(`unknown setting: ${key}`);
		let value;
		try {
			value = coerceSetting(spec, raw);
		} catch (err) {
			// Every error names its setting, so a caller changing several knows which one to fix.
			const message = err?.message ?? String(err);
			throw new Error(message.startsWith(key) ? message : `${key}: ${message}`);
		}
		// Every secret goes in hashed, so the database never holds one readable. Nothing reads these
		// back — the settings page only learns whether one is set — so a hash is strictly better.
		if (spec.type === "secret" && value) {
			value = hashPassword(value);
			verifiedSettingsKeys.clear();
		}
		// A model setting must name something the gateway can actually route to, or the
		// fallback would only be discovered as broken at the worst possible moment.
		if (spec.type === "model" && value) {
			const runtime = await modelRuntime();
			if (!resolveModel(runtime, value)) throw new Error(`${key}: no available model matches "${value}"`);
		}
		upsert.run(key, serializeSetting(spec, value), Date.now());
		config[key] = value;
		applied.push(key);
		if (spec.restart) restart.push(key);
	}
	applyLiveSettings();
	// A container setting may have changed what "ready" means; look again instead of trusting the last answer.
	resetEngineCheck();
	return { applied, restart };
}

export function settingsPayload() {
	const meta = new Map(db.prepare("SELECT key, source, updated_at FROM settings").all().map((r) => [r.key, r]));
	return {
		dbPath: GATEWAY_DB,
		secretInDb: true,
		// The hash itself is never sent anywhere; the page only needs to know whether one is set.
		passwordSet: Boolean(dashboardHash),
		settings: SETTINGS_SPEC.map((spec) => {
			const secret = spec.type === "secret";
			const value = config[spec.key];
			let display = value;
			if (spec.type === "duration") display = formatDuration(value);
			if (secret) display = "";
			return {
				key: spec.key,
				group: spec.group,
				type: spec.type,
				// A secret's value is never sent to the page; only whether one is set. Otherwise the
				// API key would sit in the HTML source of the settings page.
				value: secret ? undefined : value,
				display,
				isSet: secret ? Boolean(value) : undefined,
				def: spec.def,
				defDisplay: spec.type === "duration" ? formatDuration(spec.def) : spec.def,
				min: spec.min ?? null,
				max: spec.max ?? null,
				options: spec.options ?? null,
				restart: Boolean(spec.restart),
				help: spec.help,
				source: meta.get(spec.key)?.source ?? "default",
			};
		}),
	};
}

/**
 * The catalogue behind the dashboard MODELS view.
 *
 * Lists what the gateway can actually route to (auth configured), not the entire known
 * catalogue — `known` carries that total so the difference is visible rather than implied.
 * Only the fields the page renders are sent; raw Model objects are far larger.
 */
export async function modelCatalog(res) {
	const runtime = await modelRuntime();
	// The host's models the bridge serves, and the ones the container config has Pi call directly.
	const models = catalogueFor(runtime).map((m) => ({
		provider: m.provider,
		id: m.id,
		direct: Boolean(m.direct),
		name: m.name ?? m.id,
		reasoning: Boolean(m.reasoning),
		vision: Array.isArray(m.input) && m.input.includes("image"),
		contextWindow: m.contextWindow ?? null,
		maxTokens: m.maxTokens ?? null,
		costIn: m.cost?.input ?? null,
		costOut: m.cost?.output ?? null,
	}));
	const providers = [...new Set(models.map((m) => m.provider))].sort();
	res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(
		JSON.stringify({
			available: models.length,
			known: runtime.getModels().length,
			providerCount: providers.length,
			reasoning: models.filter((m) => m.reasoning).length,
			vision: models.filter((m) => m.vision).length,
			providers,
			models,
		}),
	);
}

// Read once at startup so a missing page fails fast, then re-read per request so editing
// dashboard.html is live — no restart. A bad save falls back to the last good copy.
export let dashboardHtml = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
export const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Piper - sign in</title>
<style>
  :root { color-scheme:dark; --bg:#0a0a0a; --panel:#101010; --border:#232323;
          --fg:#ededed; --muted:#8b8f94; --dim:#5f6368; --red:#f87171; --green:#6ee7a8; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg);
         color:var(--fg); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  form { width:340px; background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:22px; }
  .brand { display:flex; gap:10px; align-items:center; margin-bottom:20px; }
  .glyph { width:26px; height:26px; border:1px solid #3a3a3a; border-radius:7px; display:grid;
           place-items:center; color:var(--green); font-size:13px; }
  b { display:block; font-size:13px; }
  em { display:block; color:var(--dim); font-size:10px; font-style:normal; }
  label { display:block; color:var(--muted); font-size:10px; text-transform:uppercase;
          letter-spacing:.09em; margin-bottom:6px; }
  input { width:100%; background:#141414; color:var(--fg); border:1px solid var(--border);
          border-radius:7px; padding:9px 10px; font:inherit; }
  input:focus { outline:none; border-color:#3a3a3a; }
  button { margin-top:14px; width:100%; background:var(--fg); color:#0a0a0a; border:0;
           border-radius:7px; padding:9px; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .err { min-height:16px; margin-top:10px; color:var(--red); font-size:11px; }
  .note { margin-top:16px; color:var(--dim); font-size:10px; }
</style>
</head>
<body>
<form id="f">
  <div class="brand">
    <span class="glyph">&#9679;</span>
    <span><b>Piper</b><em>Pi agent proxy</em></span>
  </div>
  <label for="p">Password</label>
  <input id="p" type="password" autocomplete="current-password" autofocus>
  <button id="b">sign in</button>
  <div class="err" id="e"></div>
  <div class="note">Dashboard access is protected.</div>
</form>
<script>
var f = document.getElementById('f'), p = document.getElementById('p'),
    b = document.getElementById('b'), e = document.getElementById('e');
f.addEventListener('submit', function (ev) {
  ev.preventDefault();
  b.disabled = true;
  e.textContent = '';
  fetch('dashboard/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: p.value })
  })
    .then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j, retry: r.headers.get('retry-after') }; });
    })
    .then(function (res) {
      if (res.ok) { location.replace('dashboard'); return; }
      e.textContent = (res.j && res.j.error ? res.j.error.message : 'sign in failed') +
        (res.retry ? ' (retry in ' + res.retry + 's)' : '');
      b.disabled = false;
      p.select();
    })
    .catch(function (err) { e.textContent = err.message; b.disabled = false; });
});
</script>
</body>
</html>`;

/** Sign in. The password arrives in the body, never the query string: logAccess writes req.url. */
export async function dashboardLogin(req, res) {
	if (!dashboardHash) return sendError(res, 400, "No dashboard password is set");
	const ip = req.socket.remoteAddress ?? "unknown";
	const wait = loginWaitMs(ip);
	if (wait > 0) {
		res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
		return sendError(res, 429, `too many attempts - try again in ${Math.ceil(wait / 1000)}s`, "rate_limited", "rate_limit_error");
	}
	let body;
	try {
		body = await readJson(req);
	} catch {
		return sendError(res, 400, "Malformed JSON body");
	}
	if (!verifyPassword(String(body.password ?? ""), dashboardHash)) {
		const backoff = Math.max(0, noteLoginFailure(ip).until - Date.now());
		if (backoff > 0) res.setHeader("Retry-After", String(Math.ceil(backoff / 1000)));
		return sendError(res, 401, "Wrong password", "invalid_password", "authentication_error");
	}
	loginFails.delete(ip);
	setSessionCookie(req, res, Date.now());
	res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify({ ok: true }));
}

/**
 * Set, change, or remove the password. An empty `next` removes it and reopens the dashboard. A
 * change re-issues this browser's cookie, because the signature is keyed on the hash that just
 * changed — without that, saving a new password would sign the person who set it straight out.
 */
export async function dashboardSetPassword(req, res) {
	const ip = req.socket.remoteAddress ?? "unknown";
	// Throttled like sign-in: a stolen cookie should not make guessing the current password a fast
	// offline exercise, and the two paths sharing one counter keeps them consistent.
	const wait = loginWaitMs(ip);
	if (wait > 0) {
		res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
		return sendError(res, 429, `too many attempts - try again in ${Math.ceil(wait / 1000)}s`, "rate_limited", "rate_limit_error");
	}
	let body;
	try {
		body = await readJson(req);
	} catch {
		return sendError(res, 400, "Malformed JSON body");
	}
	const next = String(body.next ?? "");
	if (dashboardHash && !verifyPassword(String(body.current ?? ""), dashboardHash)) {
		const backoff = Math.max(0, noteLoginFailure(ip).until - Date.now());
		if (backoff > 0) res.setHeader("Retry-After", String(Math.ceil(backoff / 1000)));
		return sendError(res, 401, "Current password is wrong", "invalid_password", "authentication_error");
	}
	loginFails.delete(ip);
	if (next && next.length < PASSWORD_MIN) return sendError(res, 400, `Use at least ${PASSWORD_MIN} characters`);
	if (next) {
		setPasswordHash(hashPassword(next));
		setSessionCookie(req, res, Date.now());
	} else {
		clearPasswordHash();
		clearSessionCookie(res);
	}
	res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify({ ok: true, passwordSet: Boolean(dashboardHash) }));
}

/** Parse an expiry from the page: null/""/0 means never, a number is epoch ms, a string is a date. */
export function expiryFromInput(raw) {
	if (raw === null || raw === undefined || raw === "" || raw === 0 || raw === "0") return 0;
	const ms = typeof raw === "number" ? raw : Date.parse(String(raw));
	if (!Number.isFinite(ms)) throw new Error("expiry is not a valid date");
	if (ms <= Date.now()) throw new Error("expiry must be in the future, or empty for never");
	return ms;
}

/** Only the prefix is ever sent back — the key itself was never stored, so it cannot be. */
/** A per-key limit from the dashboard: blank or null follows the default, otherwise a number >= 0. */
export function limitFromInput(raw, name, { integer = false } = {}) {
	if (raw === null || raw === "" || raw === undefined) return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
		throw new Error(`${name} must be ${integer ? "a whole number" : "a number"} of 0 or more, or blank for the default`);
	}
	return n;
}

export function apiKeysPayload() {
	const now = Date.now();
	return {
		authRequired: authRequired(),
		// The settings key predates this table and still works, so it is shown rather than hidden.
		legacy: config.GATEWAY_API_KEY ? { name: "GATEWAY_API_KEY", note: "from Settings, always valid" } : null,
		keys: apiKeys.list().map((r) => ({
			id: r.id,
			name: r.name,
			prefix: r.prefix,
			createdAt: r.createdAt,
			expiresAt: r.expiresAt,
			revokedAt: r.revokedAt,
			lastUsedAt: r.lastUsedAt,
			status: ApiKeyStore.problem(r, now) ?? "active",
			// The key's own overrides (null follows the default), what applies, and where it stands now.
			maxSessions: r.maxSessions,
			dailySpend: r.dailySpend,
			limits: keyLimits({ id: r.id }),
			liveSessions: sessions.recordsByKey(r.id).length,
			spentToday: spentToday(r.id),
			sharedBundles: r.sharedBundles,
			allowedModels: r.allowedModels,
			container: r.container,
			bundles: grantedBundles(r.id).map((b) => b.name),
		})),
		defaults: { maxSessions: config.KEY_MAX_SESSIONS, dailySpend: config.KEY_DAILY_SPEND_USD, sharedBundles: config.SHARED_BUNDLES, allowedModels: config.KEY_ALLOWED_MODELS, container: containerDefaults() },
	};
}

export function keyStatus(keyId) {
	if (keyId === null || keyId === undefined) return "open";
	if (keyId === "") return "settings";
	const record = apiKeys.get(keyId);
	return record ? (ApiKeyStore.problem(record) ?? "active") : "deleted";
}

/** Per-key usage: the ledger's closed sessions, plus whatever is running right now. */
export async function apiKeyUsage() {
	const totals = db
		.prepare(
			"SELECT key_id, COUNT(*) AS sessions, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input), 0) AS input, " +
				"COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cacheRead, " +
				"COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(requests), 0) AS requests, " +
				"COALESCE(MAX(closed_at), 0) AS lastUsedAt FROM spend GROUP BY key_id",
		)
		.all();
	const models = db
		.prepare(
			"SELECT key_id, provider, model, COALESCE(SUM(cost), 0) AS cost, " +
				"COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens, COUNT(*) AS sessions " +
				"FROM spend GROUP BY key_id, provider, model ORDER BY cost DESC",
		)
		.all();
	const days = db
		.prepare(
			"SELECT date(closed_at / 1000, 'unixepoch', 'localtime') AS day, COALESCE(SUM(cost), 0) AS cost, " +
				"COALESCE(SUM(requests), 0) AS requests, COUNT(*) AS sessions FROM spend GROUP BY day " +
				"ORDER BY day DESC LIMIT 60",
		)
		.all();
	const live = new Map((await sessions.liveByKey()).map((l) => [l.keyId, l]));

	const entries = new Map();
	const entry = (keyId) => {
		const id = keyId ?? null;
		if (!entries.has(id)) {
			entries.set(id, {
				keyId: id,
				name: keyLabel(id),
				status: keyStatus(id),
				cost: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				requests: 0,
				sessions: 0,
				lastUsedAt: 0,
				live: live.get(id) ?? null,
				byModel: [],
			});
		}
		return entries.get(id);
	};

	for (const row of totals) {
		const e = entry(row.key_id);
		e.cost = Number(row.cost);
		e.requests = Number(row.requests);
		e.sessions = Number(row.sessions);
		e.lastUsedAt = Number(row.lastUsedAt);
		e.tokens = {
			input: Number(row.input),
			output: Number(row.output),
			cacheRead: Number(row.cacheRead),
			cacheWrite: Number(row.cacheWrite),
			total:
				Number(row.input) + Number(row.output) + Number(row.cacheRead) + Number(row.cacheWrite),
		};
	}
	for (const row of models) {
		entry(row.key_id).byModel.push({
			provider: row.provider,
			model: row.model,
			cost: Number(row.cost),
			tokens: Number(row.tokens),
			sessions: Number(row.sessions),
		});
	}
	// A key that has never been used still belongs on the page, and its own last-used stamp is the
	// one the ledger has not got: usage is only written when a session closes.
	for (const record of apiKeys.list()) {
		const e = entry(record.id);
		if (!e.lastUsedAt) e.lastUsedAt = record.lastUsedAt;
	}
	// Live sessions are deliberately not folded into these totals: everything else on this page —
	// the per-model breakdown, the per-day series — comes from the ledger, which is only written when
	// a session closes. Adding live requests here but not live cost would make a running key read
	// "1 request, 0 tokens, $0.00". The live figures ride along on `live` instead, for the page to
	// show separately.

	const keys = [...entries.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests || a.name.localeCompare(b.name));
	const grand = keys.reduce(
		(a, e) => ({
			cost: a.cost + e.cost,
			requests: a.requests + e.requests,
			sessions: a.sessions + e.sessions,
			tokens: a.tokens + e.tokens.total,
		}),
		{ cost: 0, requests: 0, sessions: 0, tokens: 0 },
	);
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	const today = db
		.prepare(
			"SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(requests), 0) AS requests, COUNT(*) AS sessions " +
				"FROM spend WHERE closed_at >= ?",
		)
		.get(midnight.getTime());
	return {
		today: { cost: Number(today.cost), requests: Number(today.requests), sessions: Number(today.sessions) },
		total: grand,
		keys,
		byDay: days.map((d) => ({ day: d.day, cost: Number(d.cost), requests: Number(d.requests), sessions: Number(d.sessions) })),
	};
}

/** The API Management page's endpoints. The dashboard guard has already run by the time these do. */
export async function apiKeyRoutes(req, res, path) {
	const rest = path.slice("/dashboard/api-keys".length);
	const json = (status, payload) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		return res.end(JSON.stringify(payload));
	};

	if (req.method === "GET" && rest === ".json") return json(200, apiKeysPayload());
	if (req.method === "GET" && rest === "/usage.json") return json(200, await apiKeyUsage());

	if (req.method === "POST" && rest === "") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body");
		}
		const name = String(body.name ?? "").trim();
		if (!name) return sendError(res, 400, "A name is required");
		let expiresAt;
		try {
			expiresAt = expiryFromInput(body.expiresAt);
		} catch (err) {
			return sendError(res, 400, err.message);
		}
		// Container settings chosen while creating (persistent, limits, ...) are checked before the key exists.
		let container = null;
		try {
			container = await checkedContainerSettings(body.container);
		} catch (err) {
			return sendError(res, 400, err.message);
		}
		const { record, key } = apiKeys.create({ name, expiresAt });
		if (container) {
			apiKeys.update(record.id, { container });
			audit("key.container", keyLabel(record.id), Object.entries(container).map(([k, v]) => (k === "env" ? `env(${v.split(/\s+/).length})` : `${k}=${v}`)).join(" "));
			resetEngineCheck();
		}
		// The one and only time the key appears in a response — it is not stored, so it cannot be shown again.
		return json(201, { ...apiKeysPayload(), key, createdId: record.id });
	}

	const match = rest.match(/^\/([0-9a-fA-F-]{36})(\/revoke)?$/);
	if (!match) return sendError(res, 404, `Unknown API key route: ${req.method} ${path}`, "not_found");
	const id = match[1];
	if (!apiKeys.get(id)) return sendError(res, 404, "No such key", "not_found");

	if (req.method === "DELETE") {
		const wasPersistent = apiKeys.get(id)?.container?.persistent;
		// Its agents go with it: ports closed, containers removed, folders archived.
		await deleteAgentsOfKey(id);
		apiKeys.remove(id);
		// Its chats cannot continue, and a persistent container would only be waiting for a key that is gone.
		if (wasPersistent) {
			const live = sessions.recordsByKey(id);
			sessions.closeByKey(id);
			await Promise.all(live.map((r) => r.stopped));
			await removePersistentContainer(id, { forget: true }).catch(() => {});
		}
		return json(200, { ...apiKeysPayload(), deleted: id });
	}
	if (req.method === "POST" && match[2]) {
		// Revoke first, then build the payload: the spread in an object literal is evaluated before
		// the property that follows it, so doing it inline would report the pre-revoke status.
		const revoked = apiKeys.revoke(id);
		// Revoking stops new requests but leaves the row and its usage history in place, which is
		// what makes it different from deleting. Sessions it already opened keep running.
		return json(200, { ...apiKeysPayload(), revoked: revoked.id });
	}
	if (req.method === "POST") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body");
		}
		const patch = {};
		if (body.name !== undefined) {
			const name = String(body.name).trim();
			if (!name) return sendError(res, 400, "A name is required");
			patch.name = name;
		}
		if (body.expiresAt !== undefined) {
			try {
				patch.expiresAt = expiryFromInput(body.expiresAt);
			} catch (err) {
				return sendError(res, 400, err.message);
			}
		}
		try {
			if (body.maxSessions !== undefined) patch.maxSessions = limitFromInput(body.maxSessions, "maxSessions", { integer: true });
			if (body.dailySpend !== undefined) patch.dailySpend = limitFromInput(body.dailySpend, "dailySpend");
			if (body.sharedBundles !== undefined) patch.sharedBundles = bundleListFromInput(body.sharedBundles);
			if (body.allowedModels !== undefined) {
				// Blank follows the default; anything else must parse, so a typo cannot lock a key out.
				const text = body.allowedModels === null ? "" : String(body.allowedModels).trim();
				if (text) parseModelPatterns(text);
				patch.allowedModels = text === "" ? null : text;
			}
			if (body.container !== undefined) patch.container = await checkedContainerSettings(body.container);
		} catch (err) {
			return sendError(res, 400, err.message);
		}
		const containerBefore = apiKeys.get(id)?.container ?? null;
		apiKeys.update(id, patch);
		let stopped = 0;
		if (patch.container !== undefined) {
			const wasPersistent = Boolean(containerBefore?.persistent);
			const isPersistent = Boolean(patch.container?.persistent);
			// A container's mounts and limits are fixed when it is created, and a running chat keeps the
			// one it has. Stop the key's live chats when their settings really changed: each resumes on its
			// next message, in a container built from the new ones, with its conversation intact.
			const liveBefore = sessions.recordsByKey(id);
			if (JSON.stringify(containerBefore) !== JSON.stringify(patch.container)) stopped = sessions.closeByKey(id);
			// Turning persistence off removes the key's container and what is installed in it: the chats go back
			// to a container of their own. Turning it on changes nothing until the next chat.
			if (wasPersistent && !isPersistent) {
				await Promise.all(liveBefore.map((r) => r.stopped));
				await removePersistentContainer(id).catch(() => {});
			}
			// Which fields, and the plain values; environment variables can hold secrets, so only their count.
			const c = patch.container ?? {};
			audit("key.container", keyLabel(id), patch.container ? Object.entries(c).map(([k, v]) => (k === "env" ? `env(${v.split(/\s+/).length})` : `${k}=${v}`)).join(" ") : "cleared");
			// The network policies in use may have changed, and so what the firewall must do.
			resetEngineCheck();
		}
		return json(200, { ...apiKeysPayload(), updated: id, stopped });
	}
	return sendError(res, 404, `Unknown API key route: ${req.method} ${path}`, "not_found");
}

export function dashboardPage() {
	try {
		dashboardHtml = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
	} catch {
		/* keep serving the last good copy */
	}
	return dashboardHtml;
}

/**
 * The container Pi configuration on the dashboard: the models the containers' Pi calls directly
 * (keys shown redacted, and a saved redaction keeps the stored key) and the default model. Also the
 * "check again" button for the container health panel.
 */
export async function containerPiRoutes(req, res, path) {
	const json = (status, body) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	};
	if (path === "/dashboard/containers/recheck") {
		if (req.method !== "POST") return sendError(res, 405, "use POST");
		resetEngineCheck();
		return json(200, await checkEngine({ force: true, ...(await engineOptions()) }));
	}
	const view = () => {
		const settings = readContainerSettings();
		return {
			dir: containerPiDirInfo(),
			models: redactedModelsText(),
			defaults: { defaultProvider: settings.defaultProvider ?? "", defaultModel: settings.defaultModel ?? "", defaultThinkingLevel: settings.defaultThinkingLevel ?? "" },
			providers: [...directProviders()],
			endpoints: allowedEndpoints(),
		};
	};
	if (req.method === "GET") {
		ensureContainerPiDir();
		return json(200, view());
	}
	if (req.method === "PUT") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body");
		}
		try {
			if (body.models !== undefined) saveModelsText(String(body.models));
			if (body.defaults !== undefined) saveContainerDefaults(body.defaults);
		} catch (err) {
			return sendError(res, 400, err?.message ?? String(err), "invalid_request_error", "invalid_request_error");
		}
		// The endpoints in models.json are opened in the firewall, so look again straight away.
		resetEngineCheck();
		return json(200, { ...view(), saved: true });
	}
	return sendError(res, 405, "use GET or PUT");
}

/**
 * The Endpoints page: agents, each a named permanent Pi of an API key on a port of its own. Creating,
 * changing, switching, resetting and deleting them. The dashboard guard has already run.
 */
export async function agentRoutes(req, res, path) {
	const json = (status, body) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	};
	const payload = () => ({
		agents: agents.list().map(agentView),
		keys: apiKeys.list().map((k) => ({ id: k.id, name: k.name, usable: !ApiKeyStore.problem(k) })),
		portRange: config.AGENT_PORT_RANGE,
		host: config.HOST,
	});
	const body = async () => {
		try {
			return await readJson(req);
		} catch {
			throw new AgentError("Malformed JSON body", 400);
		}
	};
	try {
		if (path === "/dashboard/agents.json" && req.method === "GET") return json(200, payload());
		if (path === "/dashboard/agents" && req.method === "POST") {
			const created = await createAgent(await body());
			return json(201, { ...payload(), created: created.id });
		}
		const match = /^\/dashboard\/agents\/([0-9a-f]{8})(?:\/([a-z-]+))?$/.exec(path);
		if (!match) return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
		const [, id, action] = match;
		if (!agents.get(id)) return sendError(res, 404, "No such agent", "not_found");
		if (req.method === "DELETE" && !action) {
			await deleteAgent(id);
			return json(200, { ...payload(), deleted: id });
		}
		if (req.method === "GET" && action === "instructions") {
			const agent = agents.get(id);
			return json(200, await profileOp(agentScope(agent.keyId, id), { op: "instructions.get" }));
		}
		if (req.method !== "POST") return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
		if (!action) await updateAgent(id, await body());
		else if (action === "enable") await setAgentEnabled(id, true);
		else if (action === "disable") await setAgentEnabled(id, false);
		else if (action === "new-port") await renewAgentPort(id);
		else if (action === "reset") await resetAgentContainer(id);
		else return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
		return json(200, { ...payload(), updated: id });
	} catch (err) {
		// Validation from the store is a plain Error and the client's fault; the others carry their status.
		return sendError(res, err.status ?? 400, err?.message ?? String(err));
	}
}

/**
 * The Containers page: every container with how it is doing, buttons to stop, recreate or remove
 * one, a box to run a command in one, and the audit trail. A command box on a dashboard anyone on
 * the network can open would be remote command execution, so it refuses until a dashboard password
 * is set; the page says so.
 */
export async function containerRoutes(req, res, path) {
	const json = (status, body) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	};
	if (path === "/dashboard/audit.json" && req.method === "GET") return json(200, { audit: recentAudit(100) });
	if (path === "/dashboard/alerts/test" && req.method === "POST") return json(200, await testAlert());
	if (path === "/dashboard/containers.json" && req.method === "GET") {
		return json(200, { ...(await listContainers()), audit: recentAudit(30), actions: CONTAINER_ACTIONS, execAllowed: Boolean(dashboardHash), execNote: dashboardHash ? "" : "Set a dashboard password (Settings → Access) to use this: a command box on an open dashboard would let anyone on your network run commands." });
	}
	// Images: what there is, building one in the background, removing and pruning.
	if (path === "/dashboard/images.json" && req.method === "GET") return json(200, await listImages());
	if (path.startsWith("/dashboard/images/") && req.method === "POST") {
		let body = {};
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body");
		}
		try {
			if (path === "/dashboard/images/build") return json(200, { job: await buildImage(String(body.env ?? "")) });
			if (path === "/dashboard/images/remove") return json(200, { ok: true, message: await removeImage(String(body.image ?? "")) });
			if (path === "/dashboard/images/prune") return json(200, { ok: true, message: await pruneImages() });
		} catch (err) {
			if (err instanceof EngineError) return sendError(res, err.status, err.message);
			throw err;
		}
		return sendError(res, 404, `Unknown image route: ${path}`, "not_found");
	}
	const match = /^\/dashboard\/containers\/(piper-[0-9a-f]{8}-(?:[0-9a-f]{16}|key-[0-9a-f]{12}))\/([a-z]+)$/.exec(path);
	if (!match || req.method !== "POST") return sendError(res, 404, `Unknown container route: ${req.method} ${path}`, "not_found");
	const [, name, action] = match;
	try {
		if (action === "exec") {
			if (!dashboardHash) return sendError(res, 403, "Running commands needs a dashboard password: set one under Settings → Access first.", "forbidden", "invalid_request_error");
			let body;
			try {
				body = await readJson(req);
			} catch {
				return sendError(res, 400, "Malformed JSON body");
			}
			return json(200, await containerExec(name, body.command, body.timeoutMs));
		}
		return json(200, { ok: true, message: await containerAction(name, action) });
	} catch (err) {
		if (err instanceof EngineError) return sendError(res, err.status, err.message);
		throw err;
	}
}
