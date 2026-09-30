/** Authentication: the dashboard password, its sign-in cookie, and the API key store. */
import crypto from "node:crypto";
import { config, db, parseModelPatterns } from "./settings.mjs";
import { authorized } from "./http.mjs";

// The dashboard password is deliberately not a SETTINGS_SPEC entry: it is never edited as a text
// field, its value must never reach the page, and it is stored as a one-way scrypt hash so nothing
// can read it back — only check it. The encoded form is self-describing, so the cost parameters can
// change later without invalidating a password that was already set.
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const PASSWORD_MIN = 8;
export const SESSION_COOKIE = "piper_session";

/** Empty means no password is set, and no password means the dashboard is open to anyone. */
export let dashboardHash = "";

export function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
	return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(password, stored) {
	const parts = String(stored ?? "").split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const expected = Buffer.from(parts[5], "base64");
	let actual;
	try {
		actual = crypto.scryptSync(password, Buffer.from(parts[4], "base64"), expected.length, {
			N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]),
		});
	} catch {
		return false; // a corrupt row fails closed rather than throwing on every request
	}
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * A sign-in is a cookie carrying its issue time plus an HMAC of it. The signing key is the stored
 * hash, so changing the password invalidates every live session for free, with no revocation list.
 */
export function sessionValue(issuedAt) {
	const mac = crypto.createHmac("sha256", dashboardHash).update(`piper-session:${issuedAt}`).digest("base64url");
	return `${issuedAt}.${mac}`;
}

export function parseCookies(header) {
	const out = {};
	for (const part of String(header ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
	}
	return out;
}

/** The issue time of a valid session, or 0 when there is none. */
export function readSession(req) {
	if (!dashboardHash) return 0;
	const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
	const dot = raw ? raw.indexOf(".") : -1;
	if (dot < 1) return 0;
	const issuedAt = Number(raw.slice(0, dot));
	if (!Number.isFinite(issuedAt) || issuedAt <= 0) return 0;
	const expected = sessionValue(issuedAt);
	if (raw.length !== expected.length) return 0;
	if (!crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(expected))) return 0;
	// 0 means no expiry of our own: the cookie dies with the browser session.
	const ttl = Number(config.DASHBOARD_SESSION_MS) || 0;
	if (ttl > 0 && Date.now() - issuedAt > ttl) return 0;
	return issuedAt;
}

export function setSessionCookie(req, res, issuedAt) {
	const bits = [`${SESSION_COOKIE}=${sessionValue(issuedAt)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
	// Plain HTTP on localhost is the default, so Secure is set only when something in front
	// terminated TLS — otherwise the browser would never send the cookie back.
	if (req.headers["x-forwarded-proto"] === "https") bits.push("Secure");
	const ttl = Number(config.DASHBOARD_SESSION_MS) || 0;
	if (ttl > 0) bits.push(`Max-Age=${Math.floor(ttl / 1000)}`);
	res.setHeader("Set-Cookie", bits.join("; "));
}

export function clearSessionCookie(res) {
	res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/**
 * The dashboard's own guard, separate from GATEWAY_API_KEY so that protecting the dashboard does
 * not change what the OpenAI endpoints demand. With no password stored it returns true, so an
 * existing deployment is unaffected until one is set. An API key still works either way, so scripts
 * that already send a Bearer header keep reaching the JSON endpoints.
 */
export function dashboardAuthorized(req) {
	if (!dashboardHash) return true;
	// Only the settings key, deliberately: an API key must not be able to reconfigure the gateway.
	if (authorized(req)) return true;
	return readSession(req) > 0;
}

/**
 * Whether a path belongs to the dashboard, and so answers to the password rather than the API key.
 * Note the dot in /dashboard.json: a bare startsWith("/dashboard/") test misses it, and a missed
 * route is served to anyone who asks — that endpoint carries every session fingerprint and cost.
 */
export function isDashboardPath(path) {
	return path === "/dashboard" || path.startsWith("/dashboard/") || path.startsWith("/dashboard.");
}

// Wrong passwords are counted per client so the password cannot be guessed at speed. The wait
// doubles per failure past the free tries and is capped; a success clears the record.
// ponytail: one map keyed by ip, cleared wholesale past 1000 entries. Worth a real limiter only if
// this is ever exposed to the open internet.
export const LOGIN_FREE_TRIES = 5;
export const LOGIN_MAX_WAIT_MS = 5 * 60 * 1000;
export const loginFails = new Map();

export function loginWaitMs(ip) {
	return Math.max(0, (loginFails.get(ip)?.until ?? 0) - Date.now());
}

export function noteLoginFailure(ip) {
	if (loginFails.size > 1000) loginFails.clear();
	const rec = loginFails.get(ip) ?? { fails: 0, until: 0 };
	rec.fails += 1;
	if (rec.fails > LOGIN_FREE_TRIES) {
		rec.until = Date.now() + Math.min(2 ** (rec.fails - LOGIN_FREE_TRIES) * 1000, LOGIN_MAX_WAIT_MS);
	}
	loginFails.set(ip, rec);
	return rec;
}

export function setPasswordHash(encoded) {
	dashboardHash = encoded;
	db.prepare(
		"INSERT INTO settings (key, value, source, updated_at) VALUES ('DASHBOARD_PASSWORD', ?, 'ui', ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = 'ui', updated_at = excluded.updated_at",
	).run(encoded, Date.now());
}

export function clearPasswordHash() {
	dashboardHash = "";
	db.prepare("DELETE FROM settings WHERE key = 'DASHBOARD_PASSWORD'").run();
}

/**
 * DASHBOARD_PASSWORD always wins over what is stored, which is the recovery path: set it, restart,
 * and the forgotten password is replaced. Only its hash is persisted, and the variable can then be
 * unset — nothing keeps it in the settings table in plaintext.
 */
export function loadDashboardPassword() {
	const fromEnv = process.env.DASHBOARD_PASSWORD;
	if (fromEnv) {
		setPasswordHash(hashPassword(fromEnv));
		process.stderr.write("dashboard password replaced from DASHBOARD_PASSWORD\n");
		return;
	}
	dashboardHash = db.prepare("SELECT value FROM settings WHERE key = 'DASHBOARD_PASSWORD'").get()?.value ?? "";
}
loadDashboardPassword();

/** A key is 256 bits of random, so this only has to be preimage-resistant — not slow. */
export function sha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * The gateway's API keys.
 *
 * A key is randomBytes(32), so a plain SHA-256 is the right hash here: there is nothing to guess,
 * and every request has to verify one, where scrypt's deliberate slowness would block the event
 * loop for tens of milliseconds each time and stall concurrent streams. The dashboard password is
 * the opposite case — low entropy, verified rarely — which is why that one gets scrypt.
 *
 * Lookup is by hash, so the hash column is indexed and the whole table is mirrored in memory (it is
 * tiny, and keys change only when someone clicks something).
 */
/** A key's stored container settings, or null. A damaged value is read as none rather than breaking every key. */
function parseContainerJson(text) {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

export class ApiKeyStore {
	#db;
	#byHash = new Map();
	#byId = new Map();

	constructor(db) {
		this.#db = db;
		this.reload();
	}

	reload() {
		this.#byHash.clear();
		this.#byId.clear();
		for (const row of this.#db.prepare("SELECT * FROM api_keys").all()) {
			const record = {
				id: row.id,
				name: row.name,
				prefix: row.prefix,
				hash: row.hash,
				createdAt: Number(row.created_at),
				expiresAt: Number(row.expires_at),
				revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
				lastUsedAt: Number(row.last_used_at),
				maxSessions: row.max_sessions ?? null,
				dailySpend: row.daily_spend ?? null,
				sharedBundles: row.shared_bundles ?? null,
				allowedModels: row.allowed_models ?? null,
				container: parseContainerJson(row.container_json),
				// When last_used_at was last written out, so touch() can throttle its own writes.
				persistedAt: Number(row.last_used_at),
			};
			this.#byHash.set(record.hash, record);
			this.#byId.set(record.id, record);
		}
	}

	/** Why a key cannot be used right now, or null when it is fine. */
	static problem(record, now = Date.now()) {
		if (record.revokedAt) return "revoked";
		if (record.expiresAt > 0 && record.expiresAt <= now) return "expired";
		return null;
	}

	/** The record a presented key belongs to, or null when it is unknown, revoked or expired. */
	verify(presented) {
		const record = this.#byHash.get(sha256(String(presented)));
		if (!record || ApiKeyStore.problem(record)) return null;
		this.#touch(record);
		return record;
	}

	/**
	 * Stamp last use. This runs on every request, so the write is throttled: the figure is only ever
	 * shown to the minute, and losing the last minute of it to a crash costs nothing.
	 */
	#touch(record) {
		const now = Date.now();
		record.lastUsedAt = now;
		if (now - record.persistedAt < 60000) return;
		record.persistedAt = now;
		this.#db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, record.id);
	}

	/** Any row at all, including revoked and expired ones. */
	count() {
		return this.#byId.size;
	}

	/** Usable keys first, then the rest, newest first within each group. */
	list() {
		const now = Date.now();
		return [...this.#byId.values()].sort((a, b) => {
			const bad = Number(Boolean(ApiKeyStore.problem(a, now))) - Number(Boolean(ApiKeyStore.problem(b, now)));
			return bad || b.createdAt - a.createdAt;
		});
	}

	get(id) {
		return this.#byId.get(id) ?? null;
	}

	/**
	 * Mint a key. The full value is returned exactly once and never stored, so this is the only
	 * moment it can be copied.
	 */
	create({ name, expiresAt }) {
		const key = `piper_${crypto.randomBytes(32).toString("base64url")}`;
		const record = {
			id: crypto.randomUUID(),
			name: String(name ?? "").trim() || "unnamed key",
			prefix: key.slice(0, 14),
			hash: sha256(key),
			createdAt: Date.now(),
			expiresAt: Number(expiresAt) || 0,
		};
		this.#db.prepare(
			"INSERT INTO api_keys (id, name, prefix, hash, created_at, expires_at, revoked_at, last_used_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, NULL, 0)",
		).run(record.id, record.name, record.prefix, record.hash, record.createdAt, record.expiresAt);
		this.reload();
		return { record: this.get(record.id), key };
	}

	/**
	 * Rename, change the expiry, or set the key's own limits. An absent field is left alone; a limit
	 * set to null goes back to following the gateway default.
	 */
	update(id, { name, expiresAt, maxSessions, dailySpend, sharedBundles, allowedModels, container }) {
		const record = this.#byId.get(id);
		if (!record) return null;
		const nextName = name === undefined ? record.name : String(name).trim() || record.name;
		const nextExpiry = expiresAt === undefined ? record.expiresAt : Number(expiresAt) || 0;
		const nextSessions = maxSessions === undefined ? record.maxSessions : maxSessions;
		const nextSpend = dailySpend === undefined ? record.dailySpend : dailySpend;
		const nextBundles = sharedBundles === undefined ? record.sharedBundles : sharedBundles;
		const nextModels = allowedModels === undefined ? record.allowedModels : allowedModels;
		// null clears the key's own container settings; an object replaces them whole.
		const nextContainer = container === undefined ? record.container : container;
		this.#db
			.prepare("UPDATE api_keys SET name = ?, expires_at = ?, max_sessions = ?, daily_spend = ?, shared_bundles = ?, allowed_models = ?, container_json = ? WHERE id = ?")
			.run(nextName, nextExpiry, nextSessions ?? null, nextSpend ?? null, nextBundles ?? null, nextModels ?? null, nextContainer ? JSON.stringify(nextContainer) : null, id);
		this.reload();
		return this.get(id);
	}

	revoke(id) {
		if (!this.#byId.has(id)) return null;
		this.#db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
		this.reload();
		return this.get(id);
	}

	remove(id) {
		if (!this.#byId.has(id)) return false;
		this.#db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
		this.reload();
		return true;
	}
}

export const apiKeys = new ApiKeyStore(db);

// Bearer values that have already verified, keyed by a hash of the value so the cache itself holds
// nothing usable. Without it the settings key would be scrypt-verified on every single request,
// which is tens of milliseconds of blocking work in the request path.
export const verifiedSettingsKeys = new Set();

/**
 * Whether a presented token is the settings key.
 *
 * The key is stored as a scrypt hash for the same reason the dashboard password is: a database that
 * leaks should not hand over a usable credential. The cache is what keeps that from costing
 * anything per request — scrypt runs once per distinct key, not once per call.
 */
export function isSettingsKey(token) {
	const stored = config.GATEWAY_API_KEY;
	if (!stored || !token) return false;
	const digest = sha256(token);
	if (verifiedSettingsKeys.has(digest)) return true;
	if (!verifyPassword(token, stored)) return false;
	if (verifiedSettingsKeys.size > 50) verifiedSettingsKeys.clear();
	verifiedSettingsKeys.add(digest);
	return true;
}

/**
 * A GATEWAY_API_KEY stored before it was hashed is plaintext, so replace it in place on first load.
 * Runs once; after that the value already starts with the scheme name.
 */
export function migrateSettingsKey() {
	const stored = config.GATEWAY_API_KEY;
	if (!stored || stored.startsWith("scrypt$")) return;
	config.GATEWAY_API_KEY = hashPassword(stored);
	verifiedSettingsKeys.clear();
	db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(config.GATEWAY_API_KEY, "GATEWAY_API_KEY");
	process.stderr.write("hashed the stored GATEWAY_API_KEY\n");
}
migrateSettingsKey();

/**
 * What a request authenticated as: an API key record, the settings key, or null for nothing.
 * The settings key stays first-class because it predates this table, and it is the only credential
 * that opens the dashboard — handing someone an API key must not also hand them the ability to
 * reconfigure the gateway or change what a container may reach.
 */
export function credentialOf(req) {
	const token = bearerToken(req);
	if (!token) return null;
	if (isSettingsKey(token)) {
		return { id: "", name: "GATEWAY_API_KEY", legacy: true };
	}
	return apiKeys.verify(token);
}

export function bearerToken(req) {
	const header = req.headers.authorization ?? "";
	return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Whether a credential is needed at all. No key anywhere means the gateway stays open, which is the
 * behaviour an install with no auth has always had. Note that a revoked or expired key still counts:
 * the requirement is "a key was configured", so revoking your last key locks the API rather than
 * silently opening it.
 */
export function authRequired() {
	return Boolean(config.GATEWAY_API_KEY) || apiKeys.count() > 0;
}

/** What the startup banner should say about auth, which is no longer a single on/off. */
export function authNote() {
	const keys = apiKeys.count();
	const parts = [];
	if (config.GATEWAY_API_KEY) parts.push("settings key");
	if (keys) parts.push(`${keys} key${keys === 1 ? "" : "s"}`);
	return parts.length ? parts.join(" + ") : "off";
}

/** A human label for whatever a ledger row was billed to. */
export function keyLabel(keyId) {
	if (keyId === null || keyId === undefined) return "no key (open gateway)";
	if (keyId === "") return "GATEWAY_API_KEY (settings)";
	return apiKeys.get(keyId)?.name ?? "(deleted key)";
}

/** The allow-list text that applies to a key: its own, else the gateway default. */
export function allowedModelsFor(keyId) {
	if (keyId === "") return "";
	const own = keyId ? apiKeys.get(keyId)?.allowedModels : null;
	return own ?? config.KEY_ALLOWED_MODELS ?? "";
}

/**
 * May this key use this model? Checked everywhere a model is chosen: the catalogue a container is
 * shown, each model call through the bridge, `model` in a request, pi_set_model and the fallback.
 * GATEWAY_API_KEY is the operator's and may use anything; an unparseable list allows nothing.
 */
export function modelAllowed(keyId, model) {
	if (keyId === "" || !model) return true;
	let patterns;
	try {
		patterns = parseModelPatterns(allowedModelsFor(keyId));
	} catch {
		return false;
	}
	if (!patterns.length) return true;
	const name = `${model.provider}/${model.id}`;
	return patterns.some((re) => re.test(name));
}
