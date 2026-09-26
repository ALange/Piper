#!/usr/bin/env node
/**
 * OpenAI-compatible gateway for the Pi coding agent (https://pi.dev).
 *
 *   POST /v1/chat/completions   streaming + non-streaming
 *   GET  /v1/models
 *   GET  /health
 *
 * One Pi agent per session id, never shared between ids: by default a separate `pi --mode rpc`
 * process inside a sandbox (RUNNER), with the API key's own profile of skills, extensions and
 * settings, and no credentials — model calls come back here over a socket. Send `X-Session-Id`
 * (or `session_id`) to continue a chat; omit it and the gateway mints a fresh
 * isolated session and returns the id in the `X-Session-Id` response header.
 * Sessions are held until the 24h lifetime cap, the idle timeout, or a count cap,
 * whichever comes first, then disposed.
 *
 * Requests forward only the *new* user turn, so Pi keeps its own context/history and
 * its tools (read/bash/edit/write) run server-side. Tool activity is not surfaced as
 * OpenAI tool_calls: the caller gets the agent's text back.
 *
 * Image parts (image_url / input_image) are forwarded to Pi as attachments.
 * Pi has no audio input type, so audio parts are rejected as unsupported.
 *
 *   node server.mjs
 *
 * Settings live in SQLite (GATEWAY_DB, default ./gateway.db) and are editable at
 * /dashboard#settings. GATEWAY_DB is the only environment variable that still matters;
 * every other knob seeds from its env var on first run and the database wins after that.
 */
import http from "node:http";
import crypto from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import https from "node:https";
import { BlockList, connect as netConnect, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { homedir, tmpdir } from "node:os";
import { execFileSync, execSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inventory } from "./piper-profile.mjs";

const PKG = "@earendil-works/pi-coding-agent";
const GATEWAY_DIR = dirname(fileURLToPath(import.meta.url));
const BWRAP = "/usr/bin/bwrap";
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
// Handled by the gateway itself, never forwarded to the model (see isReloadCommand).
const RELOAD_COMMAND = "/reload";

// ------------------------------------------------------------------ settings
//
// Gateway settings live in SQLite via node:sqlite (built in, no dependency). GATEWAY_DB is the
// one thing that must stay an environment variable, because the database cannot record where it
// lives. Every other knob is seeded from its environment variable on first run, then the stored
// row is authoritative — so editing it in the dashboard sticks and the env var stops mattering.

const GATEWAY_DB = process.env.GATEWAY_DB ?? fileURLToPath(new URL("./gateway.db", import.meta.url));

const SETTINGS_SPEC = [
	{ key: "HOST", group: "Network", type: "text", def: "127.0.0.1", restart: true,
	  help: "Bind address. 0.0.0.0 exposes the gateway on your network." },
	{ key: "PORT", group: "Network", type: "int", def: 8787, min: 1, max: 65535, restart: true,
	  help: "Listen port." },
	{ key: "GATEWAY_API_KEY", group: "Security", type: "secret", def: "",
	  help: "When set, every request must send Authorization: Bearer <key>." },
	{ key: "DASHBOARD_SESSION_MS", group: "Access Control", type: "duration", def: 12 * 60 * 60 * 1000, min: 0,
	  help: "How long a dashboard sign-in lasts. 0 keeps it until the browser closes. Changing the password ends every session regardless." },
	{ key: "MAX_SESSIONS", group: "Sessions", type: "int", def: 128, min: 1, max: 100000,
	  help: "Cap on live agents. Past it, the least-recently-used session is disposed." },
	{ key: "SESSION_MAX_LIFETIME_MS", group: "Sessions", type: "duration", def: 86400000, min: 0,
	  help: "Hard lifetime of a session, measured from when it was spawned." },
	{ key: "SESSION_IDLE_MS", group: "Sessions", type: "duration", def: 600000, min: 0,
	  help: "Dispose a session after this long without a request." },
	{ key: "ONE_SHOT_TTL_MS", group: "Sessions", type: "duration", def: 120000, min: 0,
	  help: "Close a session used exactly once and then quiet this long. 0 disables it." },
	{ key: "BODY_LIMIT", group: "Limits", type: "int", def: 32 * 1024 * 1024, min: 1024,
	  help: "Largest accepted request body, in bytes." },
	{ key: "MAX_IMAGE_BYTES", group: "Limits", type: "int", def: 20 * 1024 * 1024, min: 1024,
	  help: "Largest image the gateway will fetch and forward, in bytes." },
	{ key: "ALLOW_IMAGE_URLS", group: "Limits", type: "bool", def: false,
	  help: "Let clients send http(s) image URLs for the gateway to fetch. Off means data: URIs only. When on, addresses on loopback, private, link-local and metadata ranges are still refused." },
	{ key: "PI_CWD", group: "Agent", type: "text", def: "",
	  help: "Workspace the agent's tools run in. Empty means the process working directory. Applies to new sessions." },
	{ key: "PI_AGENT_PACKAGE", group: "Agent", type: "text", def: "", restart: true,
	  help: "Path to the pi-coding-agent package when it cannot be resolved automatically." },
	{ key: "RUNNER", group: "Agent", type: "enum", options: ["bwrap", "docker", "podman", "inprocess"], def: "bwrap",
	  help: "Where each session's Pi runs. bwrap, docker and podman run a separate Pi process per session inside a sandbox, with its own profile of skills, extensions and settings, and no provider credentials. inprocess runs every session inside this gateway process, sharing your ~/.pi/agent; only for trusted single-user use. Applies to new sessions." },
	{ key: "PROFILE_ROOT", group: "Agent", type: "text", def: join(GATEWAY_DIR, "profiles"),
	  help: "Each API key gets a persistent Pi profile (skills, extensions, prompts, settings) under this root, mounted into its sandboxes. Not used by the inprocess runner." },
	{ key: "PROFILE_TEMPLATE", group: "Agent", type: "text", def: "",
	  help: "A directory copied into a key's profile the first time it is created, e.g. a curated set of skills. Empty starts profiles with only your default model." },
	{ key: "SHARED_ROOT", group: "Agent", type: "text", def: join(GATEWAY_DIR, "shared"),
	  help: "Folder of shared bundles. Each subfolder is a bundle laid out like a Pi package — skills/, extensions/, prompts/ — mounted read-only into the sandboxes of the keys it is granted to. Users cannot change a bundle, but see edits to it on their next /reload." },
	{ key: "SHARED_BUNDLES", group: "Agent", type: "text", def: "base",
	  help: "Bundles every key gets unless it has its own list: comma-separated bundle names, * for all of them, or empty for none. A key's own list is set on the API Management page." },
	{ key: "KEY_FILES_ROOT", group: "Agent", type: "text", def: join(GATEWAY_DIR, "files"),
	  help: "Each API key gets a persistent shared folder under this root, mounted read-write at /workspace/shared in every one of that key's chats, so they can hand files to each other across conversations. Not used by the inprocess runner." },
	{ key: "KEY_FILES_MAX_BYTES", group: "Agent", type: "int", def: 0, min: 0,
	  help: "Largest a key's shared folder may grow to, in bytes. Past it, new chats get the folder frozen: readable, with writes that do not persist, until it is trimmed. 0 means no limit." },
	{ key: "PROFILE_MAX_BYTES", group: "Agent", type: "int", def: 100 * 1024 * 1024, min: 0,
	  help: "Largest a key's profile may grow to, in bytes. Uploads past it are refused, and a profile already over it is mounted read-only until it is trimmed. 0 means no limit." },
	{ key: "CONTAINER_IMAGE", group: "Agent", type: "text", def: "piper-sandbox",
	  help: "Image for the docker and podman runners. It must have pi on its PATH; see Dockerfile.sandbox." },
	{ key: "GATEWAY_EXTENSIONS", group: "Agent", type: "bool", def: false,
	  help: "inprocess runner only: load Pi extensions for sessions. Re-opens cross-session state leaks and runs extension code in the gateway process; see the README. The sandboxed runners always load the key's own extensions, inside the sandbox." },
	{ key: "KEY_MAX_SESSIONS", group: "Limits", type: "int", def: 16, min: 0,
	  help: "Live sessions one API key may hold at once. Past it, that key's least recently used idle session is closed; if all are busy the request is refused with 429. 0 means no limit. A key can override it on the API Management page." },
	{ key: "KEY_DAILY_SPEND_USD", group: "Limits", type: "float", def: 0, min: 0,
	  help: "Most one API key may spend per local day, in US dollars, counted from the gateway's own metering. Checked before every model call, so a long agent run stops when it crosses the line. 0 means no limit. A key can override it. GATEWAY_API_KEY is exempt." },
	{ key: "SANDBOX_LIMITS", group: "Limits", type: "enum", options: ["auto", "systemd", "off"], def: "auto",
	  help: "How sandboxed sessions are held to the memory, process and CPU limits below. systemd runs each in its own systemd scope (a cgroup); auto does that when systemd-run works here and runs unlimited otherwise; off never limits. Containers use the engine's own flags whatever this says." },
	{ key: "SANDBOX_MEMORY_MB", group: "Limits", type: "int", def: 2048, min: 0,
	  help: "Memory for one sandboxed session, everything it runs included. Past it the kernel kills processes inside that sandbox only. 0 means no limit." },
	{ key: "SANDBOX_PIDS", group: "Limits", type: "int", def: 512, min: 0,
	  help: "Processes and threads one sandboxed session may run at once, so a fork bomb stays inside its own sandbox. 0 means no limit." },
	{ key: "SANDBOX_CPUS", group: "Limits", type: "float", def: 2, min: 0,
	  help: "CPU cores one sandboxed session may use, e.g. 0.5 or 2. 0 means no limit." },
	{ key: "ACCESS_LOG", group: "Logging", type: "bool", def: true,
	  help: "Write one line per request to stderr." },
	{ key: "FALLBACK_MODEL", group: "Fallback", type: "model", def: "",
	  help: "provider/model to switch a session to when the active model fails with a quota or exhausted-retry error, e.g. opencode-go/deepseek-v4.1-flash. Empty disables fallback. Validated against the live catalogue." },
	{ key: "FALLBACK_MODE", group: "Fallback", type: "enum", options: ["session", "request", "cooldown"], def: "session",
	  help: "session: stay on the fallback until the session ends. request: try the primary again on the next request. cooldown: retry the primary once the cooldown below has passed." },
	{ key: "FALLBACK_COOLDOWN_MS", group: "Fallback", type: "duration", def: 300000, min: 0,
	  help: "How long to stay on the fallback before retrying the primary, in cooldown mode." },
	{ key: "SANDBOX_ENV", group: "Workspaces", type: "text", def: "", validate: (text) => void parseSandboxEnv(text, { strict: true }),
	  help: "Environment variables to set inside every sandbox, as NAME=value separated by spaces, for tools that need to be told where they live, e.g. RUSTUP_HOME=/root/.rustup. PATH, HOME, TERM, LANG and anything starting PI_ or PIPER_ are the gateway's and cannot be set here. Applies to new sessions." },
	{ key: "SANDBOX_ALLOW", group: "Workspaces", type: "text", def: "",
	  help: "Colon-separated folders or files to make visible, read-only, inside every sandbox, at the same path. A sandbox otherwise sees only its workspace, its profile, granted shared bundles and the system software under /usr, so a toolchain in /opt, ~/.cargo/bin or ~/.local/bin needs listing here. An entry that is or contains something protected (/root, /etc, /etc/ssh, the gateway's folders, your ~/.pi/agent) is ignored. Also what in-process file tools may read beyond the workspace. Applies to new sessions." },
	{ key: "WORKSPACE_ROOT", group: "Workspaces", type: "text", def: join(GATEWAY_DIR, "workspaces"),
	  help: "Each session gets its own directory under this root, named by a fresh UUID, and is confined to it. Empty disables per-session workspaces and falls back to PI_CWD." },
	{ key: "SANDBOX_NETWORK", group: "Workspaces", type: "enum", options: ["off", "on"], def: "off",
	  help: "Network access for sandboxed sessions. off (the default) gives each sandbox an empty network namespace: no internet, no LAN, no cloud metadata, and no route to this gateway; model calls still work, through the gateway. on shares the host network, so a session can reach anything the host can — package registries, but also this dashboard, so set a dashboard password first. Applies to new sessions: running ones keep the network they started with, so kill them on the Agents page to apply it at once." },
	{ key: "WORKSPACE_JAIL", group: "Workspaces", type: "bool", def: true,
	  help: "inprocess runner only (the others are always sandboxed). Confine each session to its workspace: bash runs inside a bubblewrap namespace and the file tools are path-checked. If bubblewrap is missing, commands are refused rather than run unsandboxed." },
	{ key: "WORKSPACE_ON_EXPIRY", group: "Workspaces", type: "enum", options: ["archive", "delete", "keep"], def: "archive",
	  help: "What happens to a workspace when its agent is reaped: archive moves it beside the root, delete removes it, keep leaves it where it is. An untouched workspace is always removed." },
	{ key: "WORKSPACE_ARCHIVE_TTL_MS", group: "Workspaces", type: "duration", def: 30 * 24 * 60 * 60 * 1000, min: 0,
	  help: "Delete archives older than this. 0 keeps archives forever." },
];

const specByKey = new Map(SETTINGS_SPEC.map((spec) => [spec.key, spec]));
const config = {};

const DURATION_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

/** Accepts "10m", "24h", "90s", "500ms" or a plain number of milliseconds. */
export function parseDuration(raw) {
	const text = String(raw ?? "").trim().toLowerCase();
	if (/^\d+$/.test(text)) return Number(text);
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text);
	if (!match) throw new Error("not a duration (try 10m, 24h, 90s)");
	return Math.round(Number(match[1]) * DURATION_UNITS[match[2]]);
}

/** Human form for the settings form, e.g. 600000 -> "10m". */
export function formatDuration(ms) {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) return "0";
	const parts = [];
	let left = n;
	for (const [suffix, size] of [["d", 86400000], ["h", 3600000], ["m", 60000], ["s", 1000]]) {
		if (left >= size) {
			parts.push(Math.floor(left / size) + suffix);
			left %= size;
		}
	}
	return parts.join(" ") || n + "ms";
}

/** Coerce and validate a raw value against its spec. Throws with a usable message. */
export function coerceSetting(spec, raw) {
	if (spec.type === "bool") {
		if (typeof raw === "boolean") return raw;
		const text = String(raw ?? "").trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(text)) return true;
		if (["0", "false", "no", "off", ""].includes(text)) return false;
		throw new Error(`${spec.key} must be true or false`);
	}
	if (spec.type === "enum") {
		const text = String(raw ?? "").trim();
		if (!spec.options?.includes(text)) throw new Error(`${spec.key} must be one of: ${(spec.options ?? []).join(", ")}`);
		return text;
	}
	if (spec.type === "float") {
		const n = Number(String(raw ?? "").trim());
		if (String(raw ?? "").trim() === "" || !Number.isFinite(n)) throw new Error(`${spec.key} must be a number`);
		if (spec.min != null && n < spec.min) throw new Error(`${spec.key} must be at least ${spec.min}`);
		if (spec.max != null && n > spec.max) throw new Error(`${spec.key} must be at most ${spec.max}`);
		return n;
	}
	if (spec.type === "int" || spec.type === "duration") {
		const n = spec.type === "duration" ? parseDuration(raw) : Number(raw);
		if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${spec.key} must be a whole number`);
		if (spec.min != null && n < spec.min) throw new Error(`${spec.key} must be at least ${spec.min}`);
		if (spec.max != null && n > spec.max) throw new Error(`${spec.key} must be at most ${spec.max}`);
		return n;
	}
	const text = String(raw ?? "");
	spec.validate?.(text);
	return text;
}

function serializeSetting(spec, value) {
	return spec.type === "bool" ? (value ? "1" : "0") : String(value);
}

const db = new DatabaseSync(GATEWAY_DB);
db.exec(
	"CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL)",
);
// One row per closed session, so spend survives reaping and a restart. Pi reports cost and tokens
// per session and aggregates over compacted-away history too, so these are what was actually
// billed. Kept forever unless you delete rows yourself.
db.exec(
	"CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL, " +
		"provider TEXT, model TEXT, cost REAL NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, " +
		"cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, requests INTEGER NOT NULL, closed_at INTEGER NOT NULL)",
);
db.exec("CREATE INDEX IF NOT EXISTS spend_closed_at ON spend (closed_at)");
// One row per API key. Only a hash and a short display prefix are kept, so a key that is lost or
// never copied cannot be recovered — issue a new one. See ApiKeyStore for why this hash is a plain
// SHA-256 while the dashboard password's is deliberately slow scrypt.
db.exec(
	"CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, " +
		"hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0, " +
		"revoked_at INTEGER, last_used_at INTEGER NOT NULL DEFAULT 0)",
);
db.exec("CREATE INDEX IF NOT EXISTS api_keys_hash ON api_keys (hash)");
// Per-key limits, added after the table shipped. NULL means the key follows the gateway default.
const keyColumns = new Set(db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name));
if (!keyColumns.has("max_sessions")) db.exec("ALTER TABLE api_keys ADD COLUMN max_sessions INTEGER");
if (!keyColumns.has("daily_spend")) db.exec("ALTER TABLE api_keys ADD COLUMN daily_spend REAL");
if (!keyColumns.has("shared_bundles")) db.exec("ALTER TABLE api_keys ADD COLUMN shared_bundles TEXT");
// Profiles an operator has frozen: mounted read-only in every sandbox, and refused by the profile API.
db.exec("CREATE TABLE IF NOT EXISTS profile_locks (scope TEXT PRIMARY KEY, locked_at INTEGER NOT NULL)");
// The ledger shipped without a key column, so add it only where it is missing.
const spendColumns = new Set(db.prepare("PRAGMA table_info(spend)").all().map((c) => c.name));
if (!spendColumns.has("key_id")) db.exec("ALTER TABLE spend ADD COLUMN key_id TEXT");
// The file holds GATEWAY_API_KEY when one is set, so keep it owner-only.
try {
	chmodSync(GATEWAY_DB, 0o600);
} catch {
	/* best effort: some filesystems do not support it */
}

/** Seed any missing key from its env var (or default), then load every key into `config`. */
function loadSettings() {
	const stored = new Map(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
	const insert = db.prepare("INSERT INTO settings (key, value, source, updated_at) VALUES (?, ?, ?, ?)");
	for (const spec of SETTINGS_SPEC) {
		if (stored.has(spec.key)) continue;
		const fromEnv = process.env[spec.key];
		let seeded = spec.def;
		let source = "default";
		if (fromEnv !== undefined) {
			try {
				seeded = coerceSetting(spec, fromEnv);
				source = "env";
			} catch {
				seeded = spec.def; // an unusable env value must not stop the gateway starting
			}
		}
		insert.run(spec.key, serializeSetting(spec, seeded), source, Date.now());
		stored.set(spec.key, serializeSetting(spec, seeded));
	}
	for (const spec of SETTINGS_SPEC) {
		try {
			config[spec.key] = coerceSetting(spec, stored.get(spec.key));
		} catch {
			config[spec.key] = spec.def; // a corrupt row falls back to the default rather than throwing
		}
	}
}
loadSettings();

// ------------------------------------------------------- dashboard password

// The dashboard password is deliberately not a SETTINGS_SPEC entry: it is never edited as a text
// field, its value must never reach the page, and it is stored as a one-way scrypt hash so nothing
// can read it back — only check it. The encoded form is self-describing, so the cost parameters can
// change later without invalidating a password that was already set.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const PASSWORD_MIN = 8;
const SESSION_COOKIE = "piper_session";

/** Empty means no password is set, and no password means the dashboard is open to anyone. */
let dashboardHash = "";

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
function sessionValue(issuedAt) {
	const mac = crypto.createHmac("sha256", dashboardHash).update(`piper-session:${issuedAt}`).digest("base64url");
	return `${issuedAt}.${mac}`;
}

function parseCookies(header) {
	const out = {};
	for (const part of String(header ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
	}
	return out;
}

/** The issue time of a valid session, or 0 when there is none. */
function readSession(req) {
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

function setSessionCookie(req, res, issuedAt) {
	const bits = [`${SESSION_COOKIE}=${sessionValue(issuedAt)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
	// Plain HTTP on localhost is the default, so Secure is set only when something in front
	// terminated TLS — otherwise the browser would never send the cookie back.
	if (req.headers["x-forwarded-proto"] === "https") bits.push("Secure");
	const ttl = Number(config.DASHBOARD_SESSION_MS) || 0;
	if (ttl > 0) bits.push(`Max-Age=${Math.floor(ttl / 1000)}`);
	res.setHeader("Set-Cookie", bits.join("; "));
}

function clearSessionCookie(res) {
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
const LOGIN_FREE_TRIES = 5;
const LOGIN_MAX_WAIT_MS = 5 * 60 * 1000;
const loginFails = new Map();

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

function setPasswordHash(encoded) {
	dashboardHash = encoded;
	db.prepare(
		"INSERT INTO settings (key, value, source, updated_at) VALUES ('DASHBOARD_PASSWORD', ?, 'ui', ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = 'ui', updated_at = excluded.updated_at",
	).run(encoded, Date.now());
}

function clearPasswordHash() {
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

// ------------------------------------------------------- api keys

/** A key is 256 bits of random, so this only has to be preimage-resistant — not slow. */
function sha256(value) {
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
	update(id, { name, expiresAt, maxSessions, dailySpend, sharedBundles }) {
		const record = this.#byId.get(id);
		if (!record) return null;
		const nextName = name === undefined ? record.name : String(name).trim() || record.name;
		const nextExpiry = expiresAt === undefined ? record.expiresAt : Number(expiresAt) || 0;
		const nextSessions = maxSessions === undefined ? record.maxSessions : maxSessions;
		const nextSpend = dailySpend === undefined ? record.dailySpend : dailySpend;
		const nextBundles = sharedBundles === undefined ? record.sharedBundles : sharedBundles;
		this.#db
			.prepare("UPDATE api_keys SET name = ?, expires_at = ?, max_sessions = ?, daily_spend = ?, shared_bundles = ? WHERE id = ?")
			.run(nextName, nextExpiry, nextSessions ?? null, nextSpend ?? null, nextBundles ?? null, id);
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
const verifiedSettingsKeys = new Set();

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
 * reconfigure the gateway or turn off the sandbox.
 */
function credentialOf(req) {
	const token = bearerToken(req);
	if (!token) return null;
	if (isSettingsKey(token)) {
		return { id: "", name: "GATEWAY_API_KEY", legacy: true };
	}
	return apiKeys.verify(token);
}

function bearerToken(req) {
	const header = req.headers.authorization ?? "";
	return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Whether a credential is needed at all. No key anywhere means the gateway stays open, which is the
 * behaviour an install with no auth has always had. Note that a revoked or expired key still counts:
 * the requirement is "a key was configured", so revoking your last key locks the API rather than
 * silently opening it.
 */
function authRequired() {
	return Boolean(config.GATEWAY_API_KEY) || apiKeys.count() > 0;
}

/** What the startup banner should say about auth, which is no longer a single on/off. */
function authNote() {
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

/** The agent workspace: an empty PI_CWD means the process working directory. */
function agentCwd() {
	return config.PI_CWD || process.cwd();
}

/** Push the settings that can change without a restart into the running services. */
function applyLiveSettings() {
	sessions.configure({
		maxSessions: config.MAX_SESSIONS,
		maxLifetimeMs: config.SESSION_MAX_LIFETIME_MS,
		idleMs: config.SESSION_IDLE_MS,
		oneShotMs: config.ONE_SHOT_TTL_MS,
	});
}

/** Validate a partial update, persist it, and apply what can be applied live. */
async function saveSettings(updates) {
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
	return { applied, restart };
}

function settingsPayload() {
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

// ---------------------------------------------------------------- pi loading

let piModule;
// The package directory Pi was loaded from, so a sandboxed session can run the same version's CLI.
let piPackageDir = "";
async function pi() {
	if (piModule) return piModule;
	const specs = [PKG];
	const dir = config.PI_AGENT_PACKAGE?.replace(/\/$/, "");
	if (dir) specs.unshift(pathToFileURL(`${dir}/dist/index.js`).href);
	try {
		specs.push(pathToFileURL(`${execSync("npm root -g", { encoding: "utf8" }).trim()}/${PKG}/dist/index.js`).href);
	} catch {
		// no global npm on PATH; project-local resolution still applies
	}
	const errors = [];
	for (const spec of specs) {
		try {
			piModule = await import(spec);
			try {
				const entry = spec.startsWith("file:") ? spec : import.meta.resolve(spec);
				piPackageDir = dirname(dirname(fileURLToPath(entry)));
			} catch {
				/* only the sandboxed runners need it, and they report its absence themselves */
			}
			break;
		} catch (err) {
			errors.push(`${spec}: ${err.message}`);
		}
	}
	if (!piModule) throw new Error(`Cannot load ${PKG}. Set PI_AGENT_PACKAGE.\n${errors.join("\n")}`);
	return piModule;
}

let runtimePromise;
function modelRuntime() {
	runtimePromise ??= pi().then(({ ModelRuntime }) => ModelRuntime.create({ allowModelNetwork: false }));
	return runtimePromise;
}

// ------------------------------------------------------- workspace sandbox
//
// Each session gets its own directory and is confined to it. Two enforcement points, one policy:
//
//   bash        -> a bubblewrap mount namespace, enforced by the kernel
//   file tools  -> a path check here, because they run in this process and cannot be namespaced
//
// The kernel sandbox is what makes the path check meaningful: with bash confined there is no
// unsandboxed route left around it. Inside the sandbox the system is readable but not writable,
// only the session's own workspace is writable, and the workspaces root, the archive, the Pi
// config directory and this gateway's own directory are hidden.

function workspaceRoot() {
	return String(config.WORKSPACE_ROOT ?? "").trim();
}

/**
 * Mirrors Pi's getAgentDir() so the sandbox can be built before the Pi module is loaded.
 * This path is the mask that hides provider credentials, so a drift here is a real leak rather
 * than a cosmetic bug — a test asserts it equals Pi's own value.
 */
export function agentDirPath() {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv) {
		if (fromEnv === "~") return homedir();
		if (fromEnv.startsWith("~/")) return join(homedir(), fromEnv.slice(2));
		return resolve(fromEnv);
	}
	return join(homedir(), ".pi", "agent");
}

/** Archives sit beside the root so the move is a rename on the same filesystem, never a copy. */
function archiveRoot() {
	return `${workspaceRoot()}-archive`;
}

/** Room left for `/<16 hex>.sock` under a 107-byte Unix socket path limit. */
const RUN_ROOT_MAX = 84;

/**
 * Per-session bridge sockets, beside the workspace root. A Unix socket path is limited to about
 * 107 bytes, so a deep workspace root falls back to a fixed directory under /tmp owned by this
 * user — fixed, rather than random, so the sandbox masks can name it without state.
 */
function runRoot() {
	if (!workspaceRoot()) return "";
	const beside = `${workspaceRoot()}-run`;
	return beside.length <= RUN_ROOT_MAX ? beside : join(tmpdir(), `piper-${process.getuid?.() ?? "user"}-run`);
}

/**
 * Create the run root, refusing one that somebody else prepared. Under /tmp another local user
 * could create the directory first, or a symlink in its place, and read every socket placed in it.
 */
export function ensureRunRoot(dir = runRoot()) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	const uid = process.getuid?.();
	if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
		throw new Error(`refusing to use ${dir} for session sockets: it must be a directory owned by this user with mode 0700`);
	}
	return dir;
}

/** Per-key Pi profiles. */
function profileRoot() {
	return String(config.PROFILE_ROOT ?? "").trim();
}

/** Per-key shared folders, mounted read-write at /workspace/shared in that key's chats. */
function keyFilesRoot() {
	return String(config.KEY_FILES_ROOT ?? "").trim();
}

/** Shared bundles, mounted read-only into the sandboxes of the keys granted them. */
function sharedRoot() {
	return String(config.SHARED_ROOT ?? "").trim();
}



/** Directories that must stay invisible to every session. */
export function jailedRoots() {
	// The whole home directory, not just the interesting parts of it. This guard is the only thing
	// standing between the in-process file tools and the filesystem — bwrap's masks apply to bash
	// alone — and a deny list is worth exactly the last path somebody remembered to add.
	//
	// /proc is here because these tools run inside the gateway process, so /proc/self is the gateway
	// itself: its environment, its command line and its open descriptors, which include the database.
	// A session can still read /proc through bash, where it gets a fresh namespace instead.
	return [workspaceRoot(), archiveRoot(), runRoot(), profileRoot(), sharedRoot(), keyFilesRoot(), agentDirPath(), GATEWAY_DIR, homedir(), "/proc", ...SENSITIVE_SYSTEM_PATHS].filter(Boolean);
}

/**
 * System locations the sandbox takes away even though the rest of the system stays readable.
 *
 * When the gateway runs as root, the sandbox's user namespace maps its uid back to root, so every
 * root-only file on the host would be readable by its owner — the session. Masking these is what
 * keeps password hashes, host keys, other users' homes and service state out of reach, and it
 * matters just as much for a non-root gateway sharing a machine with other accounts. The /run
 * entries are control sockets: one reachable docker or containerd socket is the whole host.
 */
export const SENSITIVE_SYSTEM_PATHS = [
	"/etc/shadow", "/etc/shadow-", "/etc/gshadow", "/etc/gshadow-",
	"/etc/sudoers", "/etc/sudoers.d", "/etc/ssh", "/etc/ssl/private",
	"/home", "/srv", "/mnt", "/media",
	"/var/lib", "/var/log", "/var/backups", "/var/spool", "/var/mail",
	"/run/docker.sock", "/run/containerd", "/run/podman", "/run/user", "/run/secrets", "/run/dbus",
];


/**
 * Where the in-process file tools may read besides the workspace: only what the operator handed
 * over with SANDBOX_ALLOW. An allow-list rather than a deny-list, because these tools run in the
 * gateway process and a deny-list is worth exactly the last path somebody remembered to add. The
 * denied roots are still checked first, so nothing here can re-open them.
 */
export function readableRoots() {
	// The workspace is always readable (pathVerdict checks it first); beyond it, only what the
	// operator explicitly allowed — the same view a sandboxed session gets, minus the system.
	return allowedExtraPaths();
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks before judging, so a symlink cannot be used to step outside. */
export function realPathFor(target) {
	try {
		return realpathSync(target);
	} catch {
		// A path that does not exist yet: judge the parent it would be created in.
		try {
			return join(realpathSync(dirname(target)), basename(target));
		} catch {
			return resolve(target);
		}
	}
}

/**
 * May a tool touch `target`?
 * @returns null when allowed, otherwise a message to hand back to the agent.
 */
export function pathVerdict(target, { workspace, deniedRoots, readableRoots: readable, write }) {
	const real = realPathFor(target);
	if (isInside(realPathFor(workspace), real)) return null;
	if (write) return `refusing to write outside this session's workspace: ${target}`;
	if (deniedRoots.some((root) => isInside(realPathFor(root), real))) {
		return `not readable from a session: ${target}`;
	}
	// Without an allow-list every path the deny list misses is readable, which is the old behaviour
	// and what the tests of the deny list itself exercise.
	if (readable && !readable.some((root) => isInside(realPathFor(root), real))) {
		return `not readable from a session: ${target}`;
	}
	return null;
}

/** Pi resolves tool paths itself; this mirrors it closely enough that the realpath check is what
 *  actually decides. A mismatch can only cause a false refusal, never a missed escape. */
export function resolveTarget(raw, cwd) {
	let text = String(raw).trim();
	if (text.startsWith("@")) text = text.slice(1);
	// `~` is the session's workspace, matching the shell inside the sandbox, whose HOME is set
	// there. The real home directory is deliberately out of reach, so expanding to it would only
	// produce a refusal.
	if (text === "~") text = cwd;
	else if (text.startsWith("~/")) text = join(cwd, text.slice(2));
	return isAbsolute(text) ? text : resolve(cwd, text);
}

/** Single-quote a value for the outer shell. */
export function shQuote(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap a command so it runs inside the sandbox.
 *
 * Every mask is emitted before the workspace bind: bubblewrap applies operations in order, so a
 * mask placed after the bind would silently erase the workspace.
 */
/** The installation root of the runtime running this gateway, e.g. the Node prefix. */
export function runtimeRoot() {
	return dirname(dirname(process.execPath));
}

/** Extra paths to keep reachable inside the sandbox, from SANDBOX_ALLOW. */
export function sandboxAllowPaths() {
	return String(config.SANDBOX_ALLOW ?? "")
		.split(":")
		.map((p) => p.trim())
		.filter((p) => p.startsWith("/") && p !== "/");
}

/**
 * Paths no SANDBOX_ALLOW entry may reach into or contain: the gateway's own state, your Pi
 * credentials, and the host's real secrets. An allow path of `/root` would contain the Pi agent
 * directory; one of `/etc/ssh` would be inside a secret. Either is dropped rather than mounted.
 */
function protectedPaths() {
	return [
		GATEWAY_DIR, workspaceRoot(), archiveRoot(), runRoot(), profileRoot(), sharedRoot(), keyFilesRoot(), agentDirPath(),
		"/etc/shadow", "/etc/shadow-", "/etc/gshadow", "/etc/gshadow-", "/etc/sudoers", "/etc/sudoers.d",
		"/etc/ssh", "/etc/ssl/private", "/run/docker.sock", "/run/containerd", "/run/podman", "/proc", "/sys",
	].filter(Boolean);
}

/**
 * SANDBOX_ALLOW entries that exist and reach nothing protected.
 *
 * One exception inside the Pi agent directory: its bin/ folder, where Pi keeps the fd and rg it
 * downloads for its own find and grep tools. It holds only those binaries, and without it a
 * sandboxed Pi has no fd or rg. The real path is checked, so a link cannot stretch the exception.
 */
export function allowedExtraPaths() {
	const guarded = protectedPaths();
	const piBin = join(agentDirPath(), "bin");
	const exempt = (dir) => isInside(piBin, dir) && isInside(realPathFor(piBin), realPathFor(dir));
	return sandboxAllowPaths().filter(
		(dir) => existsSync(dir) && (exempt(dir) || !guarded.some((p) => isInside(dir, p) || isInside(p, dir))),
	);
}

/**
 * SANDBOX_ENV as [name, value] pairs. Entries are NAME=value separated by whitespace. With
 * `strict`, a malformed or reserved entry throws, which is how a save is refused; otherwise it is
 * skipped, so a bad stored value can never break every sandbox.
 */
export function parseSandboxEnv(text = config.SANDBOX_ENV, { strict = false } = {}) {
	// Variables the gateway sets itself. A literal here rather than a module constant: this runs
	// while settings load at startup, before any constant further down the file exists.
	const RESERVED_ENV = /^(PATH|HOME|TERM|LANG|PI_.*|PIPER_.*)$/;
	const pairs = [];
	for (const entry of String(text ?? "").split(/\s+/).filter(Boolean)) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry);
		let problem = null;
		if (!match) problem = `"${entry}" is not NAME=value`;
		else if (RESERVED_ENV.test(match[1])) problem = `${match[1]} is set by the gateway and cannot be overridden`;
		if (problem) {
			if (strict) throw new Error(`SANDBOX_ENV: ${problem}`);
			continue;
		}
		pairs.push([match[1], match[2]]);
	}
	return pairs;
}

/**
 * What is mounted read-only besides the system: the runtime running this gateway, so `node` and
 * `npm` work, and the operator's SANDBOX_ALLOW extras.
 */
export function sandboxBindBack() {
	return [runtimeRoot(), ...allowedExtraPaths()].filter((dir) => dir && existsSync(dir));
}

/** Inside the sandbox every command runs as nobody, whatever user started the gateway. */
const SANDBOX_UID = 65534;

/**
 * The only things under /etc a sandbox gets. Binaries need a handful of them — /etc/alternatives
 * is where Debian keeps `awk` and friends, ld.so.cache is how libraries are found, and resolv.conf,
 * hosts, nsswitch.conf and the CA certificates are what DNS and TLS need when the network is on.
 * Everything else in /etc (174 entries on the machine this was written on) describes the host.
 */
export const SANDBOX_ETC = [
	"alternatives", "ld.so.cache", "ld.so.conf", "ld.so.conf.d", "localtime", "timezone",
	"nsswitch.conf", "hosts", "resolv.conf", "ssl/certs", "ssl/openssl.cnf",
	"mime.types", "protocols", "services", "os-release",
];

/** Top-level system paths: bound when they are directories, recreated when they are merged-usr links. */
const SANDBOX_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

/** Where the fixed layout puts things. The container runners use the same paths. */
export const SANDBOX_PATHS = {
	workspace: "/workspace",
	profile: "/profile",
	shared: "/shared",
	keyFiles: "/workspace/shared",
	runtime: "/opt/node",
	pi: "/opt/pi",
	bridge: "/opt/piper/bridge.mjs",
	profileHelper: "/opt/piper/profile.mjs",
	socket: "/run/piper/bridge.sock",
};

/**
 * A two-line passwd and group, so tools that look up the current user (git, ssh, python's getpass)
 * find "nobody" without the sandbox seeing every account on the host. Written once beside the
 * session sockets.
 */
function sandboxIdentityFiles() {
	const dir = ensureRunRoot();
	const files = {
		passwd: "root:x:0:0:root:/root:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n",
		group: "root:x:0:\nnogroup:x:65534:\n",
	};
	const out = {};
	for (const [name, content] of Object.entries(files)) {
		const path = join(dir, `sandbox-${name}`);
		let current = null;
		try {
			current = readFileSync(path, "utf8");
		} catch {
			/* first use */
		}
		if (current !== content) writeFileSync(path, content, { mode: 0o644 });
		out[name] = path;
	}
	return out;
}

/**
 * The bubblewrap arguments for a sandbox around `workspace`, up to but not including the command.
 *
 * The sandbox starts from an empty root and is given only what it needs: the system software under
 * /usr (and the /bin, /lib links into it), a short list of /etc files, the runtime, its workspace,
 * and whatever `binds` add. Nothing else of the host exists inside — no home directories, no /var,
 * no /opt, no /mnt, no /sys — so there is no deny-list to keep complete.
 *
 * Two layouts. "fixed" is for a whole Pi process: the workspace is /workspace, the runtime is
 * /opt/node, and callers bind the profile, bundles and bridge at SANDBOX_PATHS, so no host path
 * (the username, where the gateway lives) ever shows. "same-path" keeps every mount at its host
 * path; the in-process runner needs that, because its Pi hands commands absolute host paths.
 *
 * `binds` are `{ source, target, write, overlay }`; `target` defaults to `source`. `env` adds to
 * the cleared environment.
 */
export function sandboxArgs({ workspace, layout = "same-path", network = config.SANDBOX_NETWORK, binds = [], env = {} }) {
	const fixed = layout === "fixed";
	const runtime = runtimeRoot();
	const runtimeInside = fixed ? SANDBOX_PATHS.runtime : runtime;
	const workspaceInside = fixed ? SANDBOX_PATHS.workspace : workspace;
	const extras = allowedExtraPaths();
	const args = [
		BWRAP,
		// A user namespace with every capability dropped: nothing inside can mount, unmount or
		// remount, so the view built below is the only one it will ever have.
		"--unshare-user", "--uid", String(SANDBOX_UID), "--gid", String(SANDBOX_UID),
		"--cap-drop", "ALL",
		// setsid, so a command cannot push keystrokes into the gateway's terminal with TIOCSTI.
		"--new-session",
		"--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
		// An empty network namespace: no internet, no LAN, no cloud metadata endpoint, and no route
		// back to this gateway's own dashboard.
		...(network === "on" ? [] : ["--unshare-net"]),
		// bwrap inherits our environment by default, which would hand a session every variable the
		// gateway was started with — including provider credentials on a deployment that injects them
		// that way.
		"--clearenv",
		"--setenv", "PATH",
		[join(runtimeInside, "bin"), ...extras, "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":"),
		"--setenv", "HOME", workspaceInside,
		"--setenv", "TERM", "dumb",
		"--setenv", "LANG", "C.UTF-8",
	];
	// The operator's variables first, so the gateway's own (the Pi and bridge variables) always win.
	for (const [name, value] of parseSandboxEnv()) args.push("--setenv", name, value);
	for (const [name, value] of Object.entries(env)) args.push("--setenv", name, String(value));

	// The system, read-only. On a merged-usr host /bin and /lib are links into /usr, recreated as
	// links rather than mounted.
	for (const path of SANDBOX_SYSTEM) {
		let stat;
		try {
			stat = lstatSync(path);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) args.push("--symlink", readlinkSync(path), path);
		else if (stat.isDirectory()) args.push("--ro-bind", path, path);
	}
	args.push("--dir", "/etc");
	for (const name of SANDBOX_ETC) {
		const path = join("/etc", name);
		if (existsSync(path)) args.push("--ro-bind", path, path);
	}
	const identity = sandboxIdentityFiles();
	args.push("--ro-bind", identity.passwd, "/etc/passwd", "--ro-bind", identity.group, "/etc/group");
	// Private scratch space; /run is where the bridge socket is bound in the fixed layout.
	args.push("--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", "/run");

	// The runtime and the operator's extras, read-only.
	args.push("--ro-bind", runtime, runtimeInside);
	for (const dir of extras) args.push("--ro-bind", dir, dir);
	const mount = (bind) => {
		const source = bind.source ?? bind.path;
		const target = bind.target ?? source;
		// A throwaway overlay: the path looks writable inside, every write lands on an invisible tmpfs,
		// and the original is untouched. Pi needs to write lock files beside its settings even to read
		// them, so a plain read-only mount would make it ignore a locked profile's settings entirely.
		if (bind.overlay) args.push("--overlay-src", source, "--tmp-overlay", target);
		else args.push(bind.write ? "--bind" : "--ro-bind", source, target);
	};
	// A bind that lands inside the workspace (the key's /workspace/shared) has to follow the
	// workspace's own bind, or that bind would cover it.
	const insideWorkspace = (bind) => isInside(workspaceInside, bind.target ?? bind.source ?? bind.path);
	for (const bind of binds) if (!insideWorkspace(bind)) mount(bind);
	args.push("--bind", workspace, workspaceInside);
	for (const bind of binds) if (insideWorkspace(bind)) mount(bind);
	args.push("--dev", "/dev", "--proc", "/proc", "--chdir", workspaceInside);
	args.push("--unshare-pid", "--die-with-parent");
	return args;
}

/** Wrap one shell command so it runs inside the sandbox. */
export function sandboxCommand(command, options) {
	return [...sandboxArgs(options), "--", "/bin/sh", "-c", command].map(shQuote).join(" ");
}

/** Confine one session to its workspace. */
function jailExtension(workspace) {
	return {
		name: "workspace-jail",
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", (event) => {
				if (!config.WORKSPACE_JAIL || !workspaceRoot()) return undefined;
				if (event.toolName === "bash") {
					// Fail closed: an unsandboxed command is worse than a refused one.
					if (!existsSync(BWRAP)) {
						return { block: true, reason: "bubblewrap is not installed, refusing to run a command unsandboxed" };
					}
					event.input.command = sandboxCommand(String(event.input.command ?? ""), { workspace });
					return undefined;
				}
				const write = event.toolName === "write" || event.toolName === "edit";
				const raw = event.input?.path;
				if (typeof raw !== "string" || !raw) return undefined;
				const verdict = pathVerdict(resolveTarget(raw, workspace), {
					workspace,
					deniedRoots: jailedRoots(),
					readableRoots: readableRoots(),
					write,
				});
				return verdict ? { block: true, reason: verdict } : undefined;
			});
		},
	};
}

/**
 * Owns the per-session workspace directories.
 *
 * The cross-session safety comes from the sandbox masking the whole root; this class is about
 * disk and durability, not isolation. `sweep` is what makes WORKSPACE_ON_EXPIRY true across a
 * restart: the registry is in memory, so a previous run's directories are all orphans.
 */
class WorkspaceManager {
	#settings;

	/** Settings are injected so the policies can be exercised against a scratch root; the default
	 *  reads the live values, so a policy change applies without a restart. */
	constructor(settings) {
		this.#settings =
			settings ??
			(() => ({
				root: workspaceRoot(),
				archiveRoot: archiveRoot(),
				policy: config.WORKSPACE_ON_EXPIRY,
				archiveTtlMs: config.WORKSPACE_ARCHIVE_TTL_MS,
			}));
	}

	/**
	 * The sandbox masks these paths, and bubblewrap cannot create a mountpoint on a read-only
	 * root, so both roots have to exist on disk before the first command runs. Without this the
	 * sandbox fails closed and every command is refused.
	 */
	ensureRoots() {
		const { root, archiveRoot: archive } = this.#settings();
		if (!root) return;
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			mkdirSync(archive, { recursive: true, mode: 0o700 });
		} catch (err) {
			process.stderr.write(`cannot create the workspace roots: ${err?.message ?? err}\n`);
		}
	}

	create() {
		const { root } = this.#settings();
		if (!root) return null;
		this.ensureRoots();
		const dir = join(root, crypto.randomUUID());
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	release(workspace) {
		if (!workspace || !existsSync(workspace)) return;
		const { archiveRoot: archive, policy } = this.#settings();
		try {
			// bwrap leaves an empty `shared` mountpoint behind for the key's shared folder, whose real
			// files live elsewhere. It is not the session's work, so it goes before anything is judged.
			const mountpoint = join(workspace, "shared");
			try {
				if (lstatSync(mountpoint).isDirectory() && readdirSync(mountpoint).length === 0) rmSync(mountpoint, { recursive: true });
			} catch {
				/* no mountpoint */
			}
			// A workspace nothing was ever written to (a request rejected before it ran) is not
			// worth archiving, so it goes regardless of the policy.
			if (readdirSync(workspace).length === 0) {
				rmSync(workspace, { recursive: true, force: true });
				return;
			}
			if (policy === "keep") return;
			if (policy === "delete") {
				rmSync(workspace, { recursive: true, force: true });
				return;
			}
			mkdirSync(archive, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			renameSync(workspace, join(archive, `${basename(workspace)}-${stamp}`));
		} catch (err) {
			// Anything unexpected leaves the directory in place rather than destroying it.
			process.stderr.write(`workspace release failed for ${workspace}: ${err?.message ?? err}\n`);
		}
	}

	sweep(live = new Set()) {
		const { root, archiveRoot: archive, archiveTtlMs } = this.#settings();
		let orphans = 0;
		let expired = 0;
		if (root) {
			let entries = [];
			try {
				entries = readdirSync(root, { withFileTypes: true });
			} catch {
				/* root not created yet */
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const dir = join(root, entry.name);
				if (live.has(dir)) continue;
				// ponytail: a directory touched in the last minute might belong to another gateway
				// instance that has just started, so it is skipped this tick rather than archived.
				// The registry's own close() path handles genuinely expired sessions immediately.
				try {
					if (Date.now() - statSync(dir).mtimeMs < 60_000) continue;
				} catch {
					continue;
				}
				this.release(dir);
				orphans++;
			}
		}
		if (archiveTtlMs > 0) {
			let entries = [];
			try {
				entries = readdirSync(archive, { withFileTypes: true });
			} catch {
				/* no archives yet */
			}
			for (const entry of entries) {
				const target = join(archive, entry.name);
				try {
					if (Date.now() - statSync(target).mtimeMs > archiveTtlMs) {
						rmSync(target, { recursive: true, force: true });
						expired++;
					}
				} catch {
					/* raced with something else */
				}
			}
		}
		return { orphans, expired };
	}
}

export { WorkspaceManager };

const workspaces = new WorkspaceManager();

// -------------------------------------------------------- session controller

async function createInProcessSession(workspace) {
	const { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } = await pi();
	const cwd = workspace ?? agentCwd();
	// Sessions must not be able to observe each other through anything but their own context.
	// Extensions are the escape hatch that breaks that: pi-memory appends to a shared MEMORY.md
	// under the agent dir and the next session reads it back. So user packages stay disabled
	// unless GATEWAY_EXTENSIONS=1. Inline factories are loaded independently of `noExtensions`,
	// which is why the jail below still applies.
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: !config.GATEWAY_EXTENSIONS,
		extensionFactories: workspace ? [jailExtension(workspace)] : [],
	});
	await resourceLoader.reload();
	// The tool needs the session it is being registered on, so it reads through a ref filled in
	// once createAgentSession resolves. customTools survive noExtensions either way.
	const ref = { session: null };
	const { session } = await createAgentSession({
		cwd,
		modelRuntime: await modelRuntime(),
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		customTools: [setModelTool(ref)],
	});
	ref.session = session;
	return session;
}

// ------------------------------------------------------ sandboxed Pi processes
//
// The sandboxed runners give each session its own Pi process inside a sandbox, rather than an
// AgentSession inside this one. Everything a session can run — its tools, its extensions, its
// skills' scripts — then runs in there, so a key's own extensions are safe to load and the file
// tools need no path guard: there is nothing outside to guard.
//
//   gateway ──JSONL over stdin/stdout (Pi's RPC mode)──▶ pi --mode rpc, in bwrap or a container
//      ▲                                                    │ workspace (rw), key's profile (rw)
//      └──── model calls over a per-session Unix socket ◀───┘ no credentials, no network
//
// The sandbox never holds a provider credential. piper-bridge.mjs, loaded into every sandboxed Pi,
// registers the gateway's catalogue as providers that forward each call over the socket; the
// gateway runs it with the real credentials and meters what it cost. The ledger is therefore
// written from the gateway's own accounting, never from figures the sandbox reports.

const BRIDGE_PATH = join(GATEWAY_DIR, "piper-bridge.mjs");
const BRIDGE_IN_CONTAINER = SANDBOX_PATHS.bridge;
const SOCKET_IN_CONTAINER = SANDBOX_PATHS.socket;
/** The model call carries the whole transcript, images included, so it gets more room than a request. */
const BRIDGE_BODY_LIMIT = 256 * 1024 * 1024;
/** How long a sandboxed Pi may take to start and answer its first command. */
const SPAWN_TIMEOUT_MS = 60_000;
/** Settings copied from your own Pi into a new profile, so a key starts on the model you use. */
const PROFILE_SEED_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];
/** Stream options the sandbox may choose. Anything else — headers, keys, URLs — is the gateway's. */
const BRIDGE_OPTIONS = ["reasoning", "maxTokens", "temperature", "sessionId", "cacheRetention", "toolChoice", "thinkingBudgets"];

/** The directory name of a credential's profile: one per API key, plus the open gateway and the settings key. */
export function profileScope(keyId) {
	if (keyId === null || keyId === undefined) return "open";
	if (keyId === "") return "settings";
	return `key-${String(keyId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * The profile directory for a key, created on first use.
 *
 * A profile is a Pi agent directory: settings.json, skills/, extensions/, prompts/, AGENTS.md. It
 * persists across that key's sessions and is shared by no other key. It starts from
 * PROFILE_TEMPLATE when one is set, never from your own ~/.pi/agent, which holds credentials and
 * packages that were never meant for anyone else.
 */
export function ensureProfile(keyId, { root = profileRoot(), template = config.PROFILE_TEMPLATE, hostAgentDir = agentDirPath() } = {}) {
	if (!root) throw new Error("PROFILE_ROOT is empty; the sandboxed runners need somewhere to keep profiles");
	const dir = join(root, profileScope(keyId));
	if (existsSync(dir)) return dir;
	mkdirSync(root, { recursive: true, mode: 0o700 });
	mkdirSync(dir, { mode: 0o700 });
	if (template && existsSync(template)) cpSync(template, dir, { recursive: true });
	const settingsPath = join(dir, "settings.json");
	if (!existsSync(settingsPath)) {
		let seeded = {};
		try {
			const host = JSON.parse(readFileSync(join(hostAgentDir, "settings.json"), "utf8"));
			for (const key of PROFILE_SEED_KEYS) if (host[key] !== undefined) seeded[key] = host[key];
		} catch {
			seeded = {};
		}
		writeFileSync(settingsPath, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });
	}
	return dir;
}

/** The catalogue a sandbox may use: what the gateway has credentials for, minus anything secret. */
export function bridgeCatalog(models) {
	const providers = new Map();
	for (const m of models) {
		if (!providers.has(m.provider)) providers.set(m.provider, { id: m.provider, models: [] });
		providers.get(m.provider).models.push({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
			inputLimits: m.inputLimits,
			cost: m.cost,
			promptCache: m.promptCache,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			compat: m.compat,
		});
	}
	return { providers: [...providers.values()] };
}

/**
 * One stream event as it crosses to the sandbox.
 *
 * The cumulative `partial` snapshot is sent once, with `start`; resending it with every delta would
 * make a reply's stream quadratic in its length. Pi does read that snapshot, so every other
 * non-delta event carries the one content block it concerns and the latest usage, and the bridge
 * rebuilds the snapshot from those.
 */
export function wireEvent(event) {
	const { partial, ...rest } = event;
	if (event.type === "start") return { ...rest, partial };
	if (event.type.endsWith("_delta")) return rest;
	const out = { ...rest };
	if (partial?.usage) out.usage = partial.usage;
	if (event.contentIndex !== undefined && partial?.content?.[event.contentIndex]) out.block = partial.content[event.contentIndex];
	return out;
}

/** A fresh per-session meter. getSessionStats() on a sandboxed session reads this. */
export function newMeter() {
	return { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Add one finished model call's usage to a meter. */
export function meterUsage(meter, usage) {
	if (!usage) return;
	meter.cost += Number(usage.cost?.total) || 0;
	meter.tokens.input += usage.input ?? 0;
	meter.tokens.output += usage.output ?? 0;
	meter.tokens.cacheRead += usage.cacheRead ?? 0;
	meter.tokens.cacheWrite += usage.cacheWrite ?? 0;
	meter.tokens.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function bridgeFailure(model, message) {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model?.api,
			provider: model?.provider,
			model: model?.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

/** Run one model call for a sandbox, with the gateway's credentials, and meter it. */
async function bridgeStream(req, res, meter, keyId) {
	const body = await readJson(req, BRIDGE_BODY_LIMIT);
	const overSpend = spendRefusal(keyId);
	if (overSpend) return sendJson(res, 429, { error: overSpend });
	const runtime = await modelRuntime();
	// Looked up in the gateway's own catalogue by name: nothing about the model — its URL, its API,
	// its headers — is taken from the sandbox.
	const model = runtime.getAvailableSnapshot().find((m) => m.provider === body?.provider && m.id === body?.modelId);
	if (!model) return sendJson(res, 400, { error: `no available model ${body?.provider}/${body?.modelId}` });
	if (!Array.isArray(body?.messages)) return sendJson(res, 400, { error: "messages must be an array" });
	const options = {};
	for (const key of BRIDGE_OPTIONS) if (body.options?.[key] !== undefined) options[key] = body.options[key];
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});
	options.signal = controller.signal;
	res.writeHead(200, { "Content-Type": "application/x-ndjson" });
	let final = null;
	try {
		for await (const event of runtime.streamSimple(model, { messages: body.messages }, options)) {
			if (event.type === "done") final = event.message;
			if (event.type === "error") final = event.error;
			res.write(`${JSON.stringify(wireEvent(event))}\n`);
		}
	} catch (err) {
		res.write(`${JSON.stringify(bridgeFailure(model, err?.message ?? String(err)))}\n`);
	}
	meterUsage(meter, final?.usage);
	res.end();
}

function sendJson(res, status, value) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(value));
}

/**
 * The per-session socket a sandboxed Pi reaches the gateway through.
 *
 * It is bind-mounted into that one sandbox and nowhere else, so being able to connect is the
 * authentication. It answers three things: the model catalogue, a model call, and a model name to
 * resolve for pi_set_model. Nothing on it can reconfigure the gateway or reach another session.
 */
export async function startBridge(socketPath, meter, { keyId = null } = {}) {
	// Inventory answers the sandbox posts back, by request id (see PiRpcSession.inventory).
	const inventoryWaiters = new Map();
	const server = http.createServer(async (req, res) => {
		try {
			if (req.method === "POST" && req.url === "/inventory") {
				const body = await readJson(req);
				const waiter = inventoryWaiters.get(String(body?.id ?? ""));
				if (waiter) {
					inventoryWaiters.delete(String(body.id));
					waiter(body);
				}
				return sendJson(res, 200, { ok: true });
			}
			if (req.method === "GET" && req.url === "/models") {
				return sendJson(res, 200, bridgeCatalog((await modelRuntime()).getAvailableSnapshot()));
			}
			if (req.method === "POST" && req.url === "/stream") return await bridgeStream(req, res, meter, keyId);
			if (req.method === "POST" && req.url === "/resolve-model") {
				const { query } = await readJson(req);
				const { model, candidates } = resolveModelQuery((await modelRuntime()).getAvailableSnapshot(), String(query ?? ""));
				if (model) return sendJson(res, 200, { provider: model.provider, id: model.id });
				return sendJson(res, 200, {
					message: candidates.length
						? `"${query}" matches several models: ${candidates.join(", ")}. Ask the user which one they mean; nothing was changed.`
						: `No available model matches "${query}". Nothing was changed.`,
				});
			}
			return sendJson(res, 404, { error: "unknown bridge route" });
		} catch (err) {
			if (!res.headersSent) return sendJson(res, 500, { error: err?.message ?? String(err) });
			res.end();
		}
	});
	rmSync(socketPath, { force: true });
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolvePromise);
	});
	chmodSync(socketPath, 0o600);
	return {
		/** Resolve with the next inventory posted under `id`, or null after `timeoutMs`. */
		expectInventory(id, timeoutMs = 5000) {
			return new Promise((resolvePromise) => {
				const timer = setTimeout(() => {
					inventoryWaiters.delete(id);
					resolvePromise(null);
				}, timeoutMs);
				inventoryWaiters.set(id, (body) => {
					clearTimeout(timer);
					resolvePromise(body);
				});
			});
		},
		close() {
			server.close();
			server.closeAllConnections?.();
			rmSync(socketPath, { force: true });
		},
	};
}

/**
 * The command that starts one sandboxed Pi in RPC mode.
 *
 * bwrap reuses sandboxArgs, so the whole process gets exactly the masks a wrapped bash call gets,
 * plus three mounts: the key's profile and the bridge socket read-write, the bridge extension
 * read-only. A profile that may not be changed (locked, or over quota) is mounted as a throwaway
 * overlay instead, so the session still works but nothing it writes there survives. Containers get
 * the same mounts at fixed paths.
 */
export function runnerInvocation(kind, { workspace, profileDir, profileWritable = true, filesDir = null, filesWritable = true, bundles = [], socketPath, bridgePath = BRIDGE_PATH, packageDir, network = config.SANDBOX_NETWORK, image = config.CONTAINER_IMAGE, uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0, memoryMb = config.SANDBOX_MEMORY_MB, pids = config.SANDBOX_PIDS, cpus = config.SANDBOX_CPUS }) {
	// Each bundle is a Pi package: one -e loads its extensions, skills and prompts, and /reload
	// rediscovers whatever the operator has added to it since.
	const piArgs = (bridge, bundlePaths) => ["--mode", "rpc", "--no-session", "--approve", "-e", bridge, ...bundlePaths.flatMap((p) => ["-e", p])];
	const quiet = { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
	if (kind === "bwrap") {
		// Everything at the fixed paths the containers use too: the session sees /workspace,
		// /profile and /shared/<bundle>, never where the gateway keeps them on the host.
		const P = SANDBOX_PATHS;
		const binds = [
			profileWritable
				? { source: profileDir, target: P.profile, write: true }
				: { source: profileDir, target: P.profile, overlay: true },
			{ source: socketPath, target: P.socket, write: true },
			{ source: bridgePath, target: P.bridge },
			...bundles.map((b) => ({ source: b.path, target: `${P.shared}/${b.name}` })),
			// The key's shared folder, inside the workspace so `ls` shows it: the same files in every
			// chat of this key. Frozen, when over its limit, the way a locked profile is.
			...(filesDir
				? [filesWritable ? { source: filesDir, target: P.keyFiles, write: true } : { source: filesDir, target: P.keyFiles, overlay: true }]
				: []),
		];
		// The Pi package is normally under the Node prefix, which is mounted at /opt/node already;
		// one installed anywhere else is mounted at /opt/pi.
		let piInside;
		if (packageDir && isInside(runtimeRoot(), packageDir)) {
			piInside = join(P.runtime, relative(runtimeRoot(), packageDir));
		} else {
			binds.push({ source: packageDir, target: P.pi });
			piInside = P.pi;
		}
		const args = sandboxArgs({
			workspace,
			layout: "fixed",
			network,
			binds,
			env: { ...quiet, PI_CODING_AGENT_DIR: P.profile, PIPER_BRIDGE_SOCKET: P.socket, ...(filesDir ? { PIPER_SHARED_DIR: P.keyFiles } : {}) },
		});
		const node = join(P.runtime, relative(runtimeRoot(), process.execPath));
		return {
			command: args[0],
			args: [...args.slice(1), "--", node, join(piInside, "dist", "bundle", "cli.js"), ...piArgs(P.bridge, bundles.map((b) => `${P.shared}/${b.name}`))],
		};
	}
	const env = { ...quiet, HOME: "/workspace", PI_CODING_AGENT_DIR: "/profile", PIPER_BRIDGE_SOCKET: SOCKET_IN_CONTAINER, ...(filesDir ? { PIPER_SHARED_DIR: SANDBOX_PATHS.keyFiles } : {}) };
	return {
		command: kind,
		args: [
			"run", "--rm", "-i", "--init",
			...(network === "on" ? [] : ["--network", "none"]),
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"--read-only", "--tmpfs", "/tmp",
			...(memoryMb > 0 ? ["--memory", `${memoryMb}m`] : []),
			...(pids > 0 ? ["--pids-limit", String(pids)] : []),
			...(cpus > 0 ? ["--cpus", String(cpus)] : []),
			// The gateway's own uid, so the workspace and profile it created are writable and nothing
			// the container writes is owned by anyone else.
			"--user", `${uid}:${gid}`,
			"-v", `${workspace}:/workspace`,
			// A frozen profile is mounted read-only elsewhere and copied into a tmpfs at start: the
			// container equivalent of bwrap's throwaway overlay.
			...(profileWritable ? ["-v", `${profileDir}:/profile`] : ["-v", `${profileDir}:/profile-frozen:ro`, "--tmpfs", `/profile:uid=${uid},gid=${gid},mode=0700`]),
			"-v", `${socketPath}:${SOCKET_IN_CONTAINER}`,
			"-v", `${bridgePath}:${BRIDGE_IN_CONTAINER}:ro`,
			...bundles.flatMap((b) => ["-v", `${b.path}:/shared/${b.name}:ro`]),
			// A frozen shared folder is read-only in a container: there is no overlay to hand it.
			...(filesDir ? ["-v", `${filesDir}:${SANDBOX_PATHS.keyFiles}${filesWritable ? "" : ":ro"}`] : []),
			"-w", "/workspace",
			...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
			image,
			...(profileWritable
				? ["pi", ...piArgs(BRIDGE_IN_CONTAINER, bundles.map((b) => `/shared/${b.name}`))]
				: ["sh", "-c", `cp -a /profile-frozen/. /profile/ && exec pi ${piArgs(BRIDGE_IN_CONTAINER, bundles.map((b) => `/shared/${b.name}`)).join(" ")}`]),
		],
	};
}

/**
 * A sandboxed Pi, driven over its RPC mode, behind the slice of the AgentSession surface the
 * gateway uses. That is what lets runPrompt, the fallback logic and the ledger stay the same
 * whichever runner is in use.
 *
 * Framing splits on LF only. Node's readline also splits on U+2028 and U+2029, which are valid
 * inside JSON strings, so it would corrupt any record that contains one.
 */
export class PiRpcSession {
	#child;
	#pending = new Map();
	#listeners = new Set();
	#settleWaiters = new Set();
	#nextId = 0;
	#buffer = "";
	#stderr = "";
	#lastText = "";
	#meter;
	#onClose;
	#sawAgentStart = false;
	model = null;
	thinkingLevel = undefined;
	alive = true;

	#bridge;

	constructor(child, { meter = newMeter(), onClose, bridge } = {}) {
		this.#child = child;
		this.#bridge = bridge;
		this.#meter = meter;
		this.#onClose = onClose;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		child.stderr?.setEncoding("utf8");
		// Kept short: it only ever needs to explain why a process died.
		child.stderr?.on("data", (chunk) => (this.#stderr = (this.#stderr + chunk).slice(-4000)));
		child.on("exit", (code, signal) => this.#onExit(code, signal));
		child.on("error", (err) => this.#onExit(null, null, err));
		child.stdin.on("error", () => {});
	}

	#onStdout(chunk) {
		this.#buffer += chunk;
		let newline;
		while ((newline = this.#buffer.indexOf("\n")) >= 0) {
			const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue; // stdout is reserved for the protocol, so this is noise rather than data
			}
			this.#dispatch(record);
		}
	}

	#dispatch(record) {
		if (record.type === "response" && record.id !== undefined && this.#pending.has(record.id)) {
			const { resolve, reject } = this.#pending.get(record.id);
			this.#pending.delete(record.id);
			if (record.success) resolve(record.data);
			else reject(new Error(record.error ?? `${record.command} failed`));
			return;
		}
		if (record.type === "agent_start") this.#sawAgentStart = true;
		if (record.type === "thinking_level_changed") this.thinkingLevel = record.level;
		if (record.type === "message_end" && record.message?.role === "assistant") {
			const text = (record.message.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
			if (text) this.#lastText = text;
		}
		if (record.type === "agent_settled") for (const waiter of this.#settleWaiters) waiter.resolve();
		for (const listener of this.#listeners) {
			try {
				listener(record);
			} catch {
				/* a listener's bug must not stop the stream */
			}
		}
	}

	#onExit(code, signal, err) {
		if (!this.alive) return;
		this.alive = false;
		const detail = err?.message ?? (signal ? `signal ${signal}` : `code ${code}`);
		const tail = this.#stderr.trim().split("\n").slice(-5).join(" | ");
		const error = new Error(`the sandboxed Pi exited (${detail})${tail ? `: ${tail}` : ""}`);
		for (const { reject } of this.#pending.values()) reject(error);
		this.#pending.clear();
		for (const waiter of this.#settleWaiters) waiter.reject(error);
		this.#onClose?.();
	}

	/** Send one command and resolve with its response data. */
	send(command) {
		if (!this.alive) return Promise.reject(new Error("the sandboxed Pi is not running"));
		const id = `g${++this.#nextId}`;
		return new Promise((resolvePromise, reject) => {
			this.#pending.set(id, { resolve: resolvePromise, reject });
			this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	/** Wait for the first command, so a sandbox that cannot start fails the spawn rather than the first prompt. */
	async init(timeoutMs = SPAWN_TIMEOUT_MS) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`the sandboxed Pi did not start within ${timeoutMs / 1000}s`)), timeoutMs);
		});
		try {
			const state = await Promise.race([this.send({ type: "get_state" }), timeout]);
			this.model = state?.model ?? null;
			this.thinkingLevel = state?.thinkingLevel;
		} finally {
			clearTimeout(timer);
		}
		return this;
	}

	subscribe(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Run one prompt to completion, as AgentSession.prompt does.
	 *
	 * Completion is `agent_settled`. A prompt that names an extension command is handled without an
	 * agent run and never settles, so after the prompt is accepted the state is checked: if no run
	 * started and none is streaming, there is nothing to wait for.
	 */
	async prompt(message, { images } = {}) {
		let waiter;
		const settled = new Promise((resolvePromise, reject) => {
			waiter = { resolve: resolvePromise, reject };
			this.#settleWaiters.add(waiter);
		});
		settled.catch(() => {});
		this.#sawAgentStart = false;
		try {
			await this.send({ type: "prompt", message, ...(images?.length ? { images } : {}) });
			const state = await this.send({ type: "get_state" });
			if (!this.#sawAgentStart && !state?.isStreaming && !state?.isCompacting) return;
			await settled;
		} finally {
			this.#settleWaiters.delete(waiter);
			this.send({ type: "get_state" }).then((state) => {
				if (state?.model) this.model = state.model;
			}, () => {});
		}
	}

	async abort() {
		await this.send({ type: "abort" });
	}

	async setModel(model) {
		const data = await this.send({ type: "set_model", provider: model.provider, modelId: model.id });
		this.model = data ?? model;
	}

	setThinkingLevel(level) {
		this.thinkingLevel = level;
		this.send({ type: "set_thinking_level", level }).catch(() => {});
	}

	/** The gateway's own metering of this session's model calls, not the sandbox's report. */
	getSessionStats() {
		return { cost: this.#meter.cost, tokens: { ...this.#meter.tokens } };
	}

	getLastAssistantText() {
		return this.#lastText;
	}

	/**
	 * Every tool and command this agent has loaded, with where each came from, or null when it does
	 * not answer in time. Runs the bridge's /piper-inventory command, which executes at once even
	 * mid-reply and adds nothing to the conversation.
	 */
	async inventory(timeoutMs = 5000) {
		if (!this.#bridge || !this.alive) return null;
		const id = crypto.randomBytes(8).toString("hex");
		const answer = this.#bridge.expectInventory(id, timeoutMs);
		await this.send({ type: "prompt", message: `/piper-inventory ${id}` }).catch(() => {});
		return answer;
	}

	/** Re-read skills, extensions, prompts, settings and context files, through the bridge's command. */
	async reload() {
		await this.send({ type: "prompt", message: "/piper-reload" });
	}

	/** Close stdin, which asks Pi to shut down, and make sure it does. */
	dispose() {
		if (!this.alive) return;
		try {
			this.#child.stdin.end();
		} catch {
			/* already closed */
		}
		const child = this.#child;
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 3000).unref?.();
	}
}

// ---------------------------------------------------------------- resource limits
//
// bubblewrap confines what a session can see, not how much it can use. Memory, processes and CPU are
// held with a systemd scope per sandbox: a cgroup the kernel enforces, which also means a runaway
// session is killed inside its own scope rather than by the OOM killer picking the gateway.

/** The systemd properties for the configured limits, e.g. ["MemoryMax=2048M", "TasksMax=512"]. */
export function limitProperties({ memoryMb = config.SANDBOX_MEMORY_MB, pids = config.SANDBOX_PIDS, cpus = config.SANDBOX_CPUS } = {}) {
	const props = [];
	// Swap is capped too: MemoryMax alone limits RAM, and a session could spill past it into swap.
	// OOMPolicy=continue: when the kernel kills the biggest process in the scope — the runaway
	// command, not Pi — the scope carries on. The default stops the whole scope, which would take
	// the agent down with the command that misbehaved.
	if (memoryMb > 0) props.push(`MemoryMax=${memoryMb}M`, "MemorySwapMax=0", "OOMPolicy=continue");
	if (pids > 0) props.push(`TasksMax=${pids}`);
	if (cpus > 0) props.push(`CPUQuota=${Math.round(cpus * 100)}%`);
	return props;
}

/** The argv prefix that runs a command in a limited systemd scope. */
export function scopePrefix(props, { user = (process.getuid?.() ?? 0) !== 0 } = {}) {
	if (!props.length) return [];
	return ["systemd-run", ...(user ? ["--user"] : []), "--scope", "--quiet", "--collect", ...props.flatMap((p) => ["-p", p]), "--"];
}

let scopeProbe;
/**
 * Whether a limited scope can actually be created here, found by trying one. As root that needs a
 * running systemd; as another user it needs a user manager with the controllers delegated, which a
 * container or a bare `su` session often lacks.
 */
function scopesWork() {
	if (scopeProbe !== undefined) return scopeProbe;
	try {
		const [bin, ...args] = scopePrefix(["MemoryMax=64M", "TasksMax=16"]);
		execFileSync(bin, [...args, "true"], { stdio: "ignore", timeout: 10_000 });
		scopeProbe = true;
	} catch {
		scopeProbe = false;
	}
	return scopeProbe;
}

/**
 * How sandboxes are limited right now: the argv prefix to put before them, and a note for the
 * banner and dashboard. systemd mode fails closed — if scopes cannot be made, sessions are refused
 * rather than run unlimited — while auto falls back to unlimited and says so.
 */
export function sandboxLimiter() {
	const props = limitProperties();
	const mode = config.SANDBOX_LIMITS;
	if (mode === "off" || !props.length) return { prefix: [], note: "off" };
	if (scopesWork()) return { prefix: scopePrefix(props), note: `systemd (${props.join(", ")})` };
	if (mode === "systemd") return { error: "SANDBOX_LIMITS is systemd, but a systemd scope cannot be created here" };
	return { prefix: [], note: "none: systemd scopes are unavailable here" };
}

/** Start one sandboxed Pi for a session and wait until it answers. */
async function createSandboxedSession(workspace, record) {
	const kind = config.RUNNER;
	if (!workspace) throw new Error(`RUNNER=${kind} needs WORKSPACE_ROOT: each sandboxed session runs in its own workspace`);
	if (kind === "bwrap" && !existsSync(BWRAP)) throw new Error("bubblewrap is not installed; install it or choose another RUNNER");
	await pi();
	if (kind === "bwrap" && !existsSync(join(piPackageDir, "dist", "bundle", "cli.js"))) {
		throw new Error(`cannot find the Pi CLI under ${piPackageDir || "(unresolved)"}; set PI_AGENT_PACKAGE`);
	}
	const profileDir = ensureProfile(record?.keyId ?? null);
	const { writable: profileWritable } = profileWritability(record?.keyId ?? null, profileDir);
	const socketPath = join(ensureRunRoot(), `${crypto.randomBytes(8).toString("hex")}.sock`);
	const meter = newMeter();
	const bridge = await startBridge(socketPath, meter, { keyId: record?.keyId ?? null });
	let session;
	try {
		const bundles = grantedBundles(record?.keyId ?? null);
		const filesDir = ensureKeyFiles(record?.keyId ?? null);
		const { writable: filesWritable } = keyFilesWritability(filesDir);
		const { command, args } = runnerInvocation(kind, { workspace, profileDir, profileWritable, filesDir, filesWritable, bundles, socketPath, packageDir: piPackageDir });
		// Containers carry their own limits; bwrap gets a systemd scope around it.
		const limiter = kind === "bwrap" ? sandboxLimiter() : { prefix: [] };
		if (limiter.error) throw new Error(limiter.error);
		const argv = [...limiter.prefix, command, ...args];
		const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
		session = new PiRpcSession(child, { meter, onClose: () => bridge.close(), bridge });
		return await session.init();
	} catch (err) {
		session?.dispose();
		bridge.close();
		throw err;
	}
}

// ---------------------------------------------------------------- shared bundles
//
// A bundle is a folder under SHARED_ROOT laid out like a Pi package (skills/, extensions/,
// prompts/). It is operator-owned and mounted read-only, so unlike a profile the gateway may read
// its names freely: no session can write to it.

const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A bundle list as typed: blank or null means "follow the default", otherwise names or *. */
export function bundleListFromInput(raw) {
	if (raw === null || raw === undefined) return null;
	const text = String(raw).trim();
	if (text === "") return null;
	if (text === "-" || text.toLowerCase() === "none") return "";
	const names = text.split(",").map((n) => n.trim()).filter(Boolean);
	for (const name of names) {
		if (name !== "*" && !BUNDLE_NAME.test(name)) throw new Error(`sharedBundles: "${name}" is not a bundle name`);
	}
	return names.join(",");
}

/** Every bundle on disk: subfolders of SHARED_ROOT with a valid name. */
export function listBundles(root = sharedRoot()) {
	if (!root) return [];
	let entries = [];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && BUNDLE_NAME.test(e.name))
		.map((e) => ({ name: e.name, path: join(root, e.name) }))
		.filter((b) => {
			try {
				return statSync(b.path).isDirectory();
			} catch {
				return false;
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The bundles a credential gets: its own list when it has one, the SHARED_BUNDLES default
 * otherwise, and every bundle for GATEWAY_API_KEY, the operator's own. Names that do not exist
 * are ignored, so granting a bundle before creating it is harmless.
 */
export function grantedBundles(keyId, { root = sharedRoot(), fallback = config.SHARED_BUNDLES } = {}) {
	const all = listBundles(root);
	if (keyId === "") return all;
	const own = keyId ? apiKeys.get(keyId)?.sharedBundles : null;
	const list = own ?? fallback ?? "";
	const names = String(list).split(",").map((n) => n.trim()).filter(Boolean);
	if (names.includes("*")) return all;
	return all.filter((b) => names.includes(b.name));
}

/** What a bundle holds, by name, for the dashboard and /profile. */
export function bundleContents(path) {
	const names = (sub, filter) => {
		try {
			return readdirSync(join(path, sub), { withFileTypes: true }).filter(filter).map((e) => e.name).sort();
		} catch {
			return [];
		}
	};
	return {
		skills: names("skills", (e) => e.isDirectory() || e.isSymbolicLink()),
		extensions: names("extensions", (e) => /\.(ts|js)$/.test(e.name) || e.isDirectory()),
		prompts: names("prompts", (e) => e.name.endsWith(".md")).map((n) => n.replace(/\.md$/, "")),
	};
}

// ------------------------------------------------------------- profile management
//
// A key's profile is written by its own sessions, so the gateway treats its contents as hostile:
// it only ever looks at a profile through lstat (sizes and names, never following a link), and
// every read or write of a file's contents runs piper-profile.mjs inside the same sandbox a session
// gets. That way a symlink a session planted — settings.json pointing at ~/.pi/agent/auth.json —
// resolves inside the sandbox, where that path is an empty mask.

const PROFILE_HELPER_PATH = join(GATEWAY_DIR, "piper-profile.mjs");
const PROFILE_HELPER_IN_CONTAINER = SANDBOX_PATHS.profileHelper;
const PROFILE_HELPER_TIMEOUT_MS = 30_000;
/** Helper operations that change the profile, and so are refused on a locked one. */
const PROFILE_WRITES = new Set(["settings.put", "settings.patch", "skills.put", "skills.delete", "extensions.put", "extensions.delete"]);

/** A profile problem with the HTTP status it should be answered with. */
export class ProfileError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Sizes and names under a profile, from lstat alone: nothing here reads a file or follows a link. */
export function profileStats(dir) {
	const walk = (path) => {
		let stat;
		try {
			stat = lstatSync(path);
		} catch {
			return 0;
		}
		if (!stat.isDirectory()) return stat.size;
		let total = 0;
		for (const entry of readdirSync(path)) total += walk(join(path, entry));
		return total;
	};
	const names = (sub) => {
		try {
			const path = join(dir, sub);
			return lstatSync(path).isDirectory() ? readdirSync(path).sort() : [];
		} catch {
			return [];
		}
	};
	return { bytes: walk(dir), skills: names("skills"), extensions: names("extensions") };
}

/** Total bytes under a path, from lstat alone: never reads a file, never follows a link. */
export function treeSize(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	let total = 0;
	for (const entry of readdirSync(path)) total += treeSize(join(path, entry));
	return total;
}

/**
 * A key's shared folder, created on its first chat. It is data, not configuration: kept apart from
 * the profile, so a profile reset or lock never touches it.
 */
export function ensureKeyFiles(keyId, { root = keyFilesRoot() } = {}) {
	if (!root) throw new Error("KEY_FILES_ROOT is empty; the sandboxed runners need somewhere to keep shared folders");
	const dir = join(root, profileScope(keyId));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Whether a key's chats may write its shared folder: always, unless a size limit is set and passed. */
export function keyFilesWritability(dir, max = config.KEY_FILES_MAX_BYTES) {
	if (!(max > 0)) return { writable: true, reason: "" };
	const bytes = treeSize(dir);
	return bytes > max ? { writable: false, reason: `over its limit (${bytes} of ${max} bytes)` } : { writable: true, reason: "" };
}

/**
 * What is in a key's shared folder, for the dashboard and /profile: size, file count and the
 * top-level entries. lstat only, like profileStats, because sessions write here freely.
 */
export function keyFilesStats(dir, { maxEntries = 50 } = {}) {
	if (!existsSync(dir)) return { created: false, bytes: 0, files: 0, entries: [] };
	let files = 0;
	const count = (path) => {
		let stat;
		try {
			stat = lstatSync(path);
		} catch {
			return;
		}
		if (stat.isDirectory()) for (const e of readdirSync(path)) count(join(path, e));
		else files++;
	};
	count(dir);
	const entries = readdirSync(dir)
		.sort()
		.slice(0, maxEntries)
		.map((name) => {
			const stat = lstatSync(join(dir, name));
			return { name, type: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file", bytes: treeSize(join(dir, name)) };
		});
	return { created: true, bytes: treeSize(dir), files, entries, more: Math.max(0, readdirSync(dir).length - maxEntries) };
}

export function isProfileLocked(scope) {
	return Boolean(db.prepare("SELECT 1 FROM profile_locks WHERE scope = ?").get(scope));
}

export function setProfileLock(scope, locked) {
	if (locked) db.prepare("INSERT OR IGNORE INTO profile_locks (scope, locked_at) VALUES (?, ?)").run(scope, Date.now());
	else db.prepare("DELETE FROM profile_locks WHERE scope = ?").run(scope);
}

/**
 * Whether a key's sessions may write their profile, and if not, why. A locked profile is read-only
 * by the operator's choice; one over its quota is read-only until it is trimmed, which still leaves
 * the key able to chat and to delete things through the API.
 */
export function profileWritability(keyId, dir) {
	const scope = profileScope(keyId);
	if (isProfileLocked(scope)) return { writable: false, reason: "locked by the gateway operator" };
	const max = config.PROFILE_MAX_BYTES;
	if (max > 0) {
		const { bytes } = profileStats(dir);
		if (bytes > max) return { writable: false, reason: `over its quota (${bytes} of ${max} bytes)` };
	}
	return { writable: true, reason: "" };
}

/** The command that runs the profile helper in a sandbox with only `profileDir` mounted, read-write. */
export function profileHelperInvocation(kind, { profileDir, helperPath = PROFILE_HELPER_PATH, maxBytes = config.PROFILE_MAX_BYTES, image = config.CONTAINER_IMAGE, uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0 }) {
	if (kind === "bwrap") {
		// The profile stands in for the workspace: it is the one writable place, and the working
		// directory. The network is off whatever SANDBOX_NETWORK says; the helper never needs it.
		const args = sandboxArgs({
			workspace: profileDir,
			layout: "fixed",
			network: "off",
			binds: [{ source: helperPath, target: SANDBOX_PATHS.profileHelper }],
			env: { PROFILE_MAX_BYTES: String(maxBytes) },
		});
		const node = join(SANDBOX_PATHS.runtime, relative(runtimeRoot(), process.execPath));
		return { command: args[0], args: [...args.slice(1), "--", node, SANDBOX_PATHS.profileHelper] };
	}
	return {
		command: kind,
		args: [
			"run", "--rm", "-i",
			"--network", "none",
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"--read-only",
			"--user", `${uid}:${gid}`,
			"-v", `${profileDir}:/profile`,
			"-v", `${helperPath}:${PROFILE_HELPER_IN_CONTAINER}:ro`,
			"-w", "/profile",
			"-e", `PROFILE_MAX_BYTES=${maxBytes}`,
			image,
			"node", PROFILE_HELPER_IN_CONTAINER,
		],
	};
}

/** Run one profile operation for a key, inside the sandbox. */
export async function profileOp(keyId, command, { kind = config.RUNNER } = {}) {
	if (kind === "inprocess") {
		throw new ProfileError("profiles belong to the sandboxed runners; RUNNER is inprocess, so sessions use your own ~/.pi/agent", 409);
	}
	if (kind === "bwrap" && !existsSync(BWRAP)) throw new ProfileError("bubblewrap is not installed", 503);
	const scope = profileScope(keyId);
	if (PROFILE_WRITES.has(command.op) && isProfileLocked(scope)) {
		throw new ProfileError("this profile is locked by the gateway operator", 423);
	}
	const profileDir = ensureProfile(keyId);
	const invocation = profileHelperInvocation(kind, { profileDir });
	const limiter = kind === "bwrap" ? sandboxLimiter() : { prefix: [] };
	if (limiter.error) throw new ProfileError(limiter.error, 503);
	const [bin, ...args] = [...limiter.prefix, invocation.command, ...invocation.args];
	const output = await new Promise((resolvePromise, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), PROFILE_HELPER_TIMEOUT_MS);
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new ProfileError(`cannot run the profile helper: ${err.message}`, 503));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (!stdout) return reject(new ProfileError(`the profile helper failed (code ${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`, 500));
			resolvePromise(stdout);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(command));
	});
	let answer;
	try {
		answer = JSON.parse(output);
	} catch {
		throw new ProfileError("the profile helper answered with something that is not JSON", 500);
	}
	if (!answer.ok) throw new ProfileError(answer.error, answer.refused ? 400 : 500);
	return answer.result;
}

/**
 * Put a key's profile back to its starting state. Every live session of that key is closed first,
 * because each has the old directory mounted and would go on writing to it. The old profile is
 * archived beside the workspace archives, not deleted, and expires with them.
 */
export function resetProfile(keyId) {
	const scope = profileScope(keyId);
	if (isProfileLocked(scope)) throw new ProfileError("this profile is locked by the gateway operator", 423);
	const closed = sessions.closeByKey(keyId);
	const dir = join(profileRoot(), scope);
	let archived = null;
	if (existsSync(dir)) {
		// A rename moves a link rather than following it, so a hostile profile cannot redirect this.
		const archive = archiveRoot() || `${profileRoot()}-archive`;
		mkdirSync(archive, { recursive: true, mode: 0o700 });
		archived = join(archive, `profile-${scope}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
		renameSync(dir, archived);
	}
	ensureProfile(keyId);
	return { closed, archived: Boolean(archived) };
}

/** Which runner a new session uses. Read per session, so a change applies without a restart. */
function createSession(workspace, record) {
	return config.RUNNER === "inprocess" ? createInProcessSession(workspace) : createSandboxedSession(workspace, record);
}

/**
 * Stable, non-reversible short id for display.
 *
 * A session id is a bearer credential: anyone holding it can continue that chat. The
 * dashboard therefore shows this digest instead, which is enough to tell rows apart and
 * follow one over time but cannot be pasted into a request to resume the session.
 */
export function fingerprint(id) {
	return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8);
}

/** Which of the three limits would fire first, for display. */
export function expiryReason(lifetimeLeft, idleLeft, orphanLeft) {
	if (orphanLeft < lifetimeLeft && orphanLeft < idleLeft) return "one-shot";
	if (lifetimeLeft <= idleLeft) return "lifetime";
	return "idle";
}

/**
 * Owns every live Pi session.
 *
 * One Pi AgentSession per session id, never shared between ids. A session is held
 * until the hard lifetime cap, the idle timeout, or LRU eviction at MAX_SESSIONS —
 * whichever comes first — then disposed.
 *
 * `create` is injected so the lifecycle is testable without spawning real Pi sessions.
 */
export class SessionController {
	#sessions = new Map();
	#create;
	#max;
	#maxLifetimeMs;
	#idleMs;
	#oneShotMs;
	#workspaces;
	#history = [];
	#lastSampleAt = 0;
	#timer;

	constructor({ create, maxSessions, maxLifetimeMs, idleMs, oneShotMs = 0, workspaces: workspaceStore, sweepMs = 60_000 }) {
		this.#create = create;
		this.#max = maxSessions;
		this.#maxLifetimeMs = maxLifetimeMs;
		this.#idleMs = idleMs;
		this.#oneShotMs = oneShotMs;
		// Defaulted so the controller can be tested without touching a filesystem.
		this.#workspaces = workspaceStore ?? { create: () => null, release: () => {} };
		if (sweepMs > 0) {
			this.#timer = setInterval(() => this.reap(), sweepMs);
			this.#timer.unref?.();
		}
	}

	get size() {
		return this.#sessions.size;
	}

	/**
	 * Apply changed limits to the running controller. Settings that only affect future work
	 * (a session's model, its agent directory) are not here; this is the reaping policy, which
	 * is read on every tick and can change live.
	 */
	configure({ maxSessions, maxLifetimeMs, idleMs, oneShotMs }) {
		if (maxSessions != null) this.#max = maxSessions;
		if (maxLifetimeMs != null) this.#maxLifetimeMs = maxLifetimeMs;
		if (idleMs != null) this.#idleMs = idleMs;
		if (oneShotMs != null) this.#oneShotMs = oneShotMs;
	}

	/**
	 * The record for `requestId`, spawning one if needed. A null id always mints a
	 * fresh unguessable session, so two callers can never end up sharing one agent.
	 */
	acquire(requestId, credential = null) {
		if (requestId) {
			const existing = this.#sessions.get(requestId);
			if (existing) {
				existing.requests += 1;
				existing.lastUsedAt = Date.now();
				return { id: requestId, record: existing, isNew: false };
			}
			return { id: requestId, record: this.#spawn(requestId, credential), isNew: true };
		}
		const id = crypto.randomUUID();
		return { id, record: this.#spawn(id, credential), isNew: true };
	}

	/** One Pi run at a time per session; a failure doesn't wedge the queue behind it. */
	run(record, fn) {
		record.inflight++;
		record.lastUsedAt = Date.now();
		const queued = record.queue.then(fn, fn);
		record.queue = queued.then(
			() => {},
			() => {},
		);
		return queued.finally(() => {
			record.inflight--;
			// Activity is the completion, not the start: a long tool run must not look quiet
			// the moment its answer lands, or the one-shot rule would reap it immediately.
			record.lastUsedAt = Date.now();
		});
	}

	close(id) {
		const record = this.#sessions.get(id);
		if (!record) return false;
		this.#sessions.delete(id);
		record.sessionPromise.then(
			(session) => {
				recordSpend(record, session);
				session.dispose?.();
			},
			() => {},
		);
		// Every way a session can end funnels through here, so the workspace policy is applied
		// in exactly one place: reaping, LRU eviction, a manual kill, shutdown, and a request
		// rejected before its agent ever ran.
		this.#workspaces.release(record.workspace);
		return true;
	}

	/** Live cost and token totals, read off each session's own stats. */
	/** Live usage grouped by the key that opened each session. */
	async liveByKey() {
		const out = new Map();
		for (const record of this.#sessions.values()) {
			const session = await record.sessionPromise.catch(() => null);
			const stats = session?.getSessionStats?.();
			const keyId = record.keyId ?? null;
			const acc = out.get(keyId) ?? { keyId, cost: 0, tokens: 0, requests: 0, sessions: 0 };
			acc.cost += Number(stats?.cost) || 0;
			acc.tokens += stats?.tokens?.total ?? 0;
			acc.requests += record.requests ?? 0;
			acc.sessions += 1;
			out.set(keyId, acc);
		}
		return [...out.values()];
	}

	async liveStats() {
		let cost = 0;
		let tokens = 0;
		for (const record of this.#sessions.values()) {
			const session = await record.sessionPromise.catch(() => null);
			const stats = session?.getSessionStats?.();
			if (!stats) continue;
			cost += Number(stats.cost) || 0;
			tokens += stats.tokens?.total ?? 0;
		}
		return { cost, tokens };
	}

	/** Workspace directories of live sessions, so the sweeper spares them. */
	liveWorkspaces() {
		const live = new Set();
		for (const record of this.#sessions.values()) if (record.workspace) live.add(record.workspace);
		return live;
	}

	/**
	 * Close the session whose id hashes to `fp`. Rows only carry a fingerprint, so targeting
	 * happens here and the real id never has to leave the process. Refuses when the fingerprint
	 * is not unique, rather than killing an arbitrary agent.
	 */
	closeByFingerprint(fp) {
		const matches = [...this.#sessions.keys()].filter((id) => fingerprint(id) === fp);
		if (matches.length !== 1) return false;
		return this.close(matches[0]);
	}

	has(id) {
		return this.#sessions.has(id);
	}

	/**
	 * Make room for one more session of a key under its limit, by closing that key's least recently
	 * used idle session. Returns false when every one of them is busy.
	 */
	makeRoomForKey(keyId, max) {
		if (!(max > 0)) return true;
		const own = this.recordsByKey(keyId);
		if (own.length < max) return true;
		const idle = own.filter((r) => r.inflight === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
		const excess = own.length - max + 1;
		if (idle.length < excess) return false;
		for (const record of idle.slice(0, excess)) this.close(record.id);
		return true;
	}

	/** The live records a key opened. */
	recordsByKey(keyId) {
		return [...this.#sessions.values()].filter((r) => (r.keyId ?? null) === (keyId ?? null));
	}

	/** Close every session a key opened. Used when its profile is replaced underneath them. */
	closeByKey(keyId) {
		const ids = [...this.#sessions.values()].filter((r) => (r.keyId ?? null) === (keyId ?? null)).map((r) => r.id);
		for (const id of ids) this.close(id);
		return ids.length;
	}

	closeAll() {
		const ids = [...this.#sessions.keys()];
		for (const id of ids) this.close(id);
		return ids.length;
	}

	/** Dispose sessions past their lifetime or idle timeout. Never reaps a session with work pending. */
	reap(now = Date.now()) {
		this.#sample(now);
		const reaped = [];
		for (const record of this.#sessions.values()) {
			if (record.inflight > 0) continue;
			const pastLifetime = now - record.createdAt > this.#maxLifetimeMs;
			const pastIdle = now - record.lastUsedAt > this.#idleMs;
			const orphaned = this.#oneShotMs > 0 && record.requests <= 1 && now - record.lastUsedAt > this.#oneShotMs;
			if (!pastLifetime && !pastIdle && !orphaned) continue;
			reaped.push(record.id);
			this.close(record.id);
		}
		return reaped;
	}

	/** Counts only — session ids are bearer secrets, so they are never exposed. */
	stats() {
		let oldest = null;
		for (const record of this.#sessions.values()) if (oldest === null || record.createdAt < oldest) oldest = record.createdAt;
		return {
			active: this.#sessions.size,
			max: this.#max,
			maxLifetimeMs: this.#maxLifetimeMs,
			idleMs: this.#idleMs,
			oldestAgeMs: oldest === null ? 0 : Date.now() - oldest,
		};
	}

	/**
	 * Per-session view for the dashboard. Async because the model is read off the live
	 * session, so it reflects pi_set_model swaps immediately.
	 */
	async snapshot() {
		const now = Date.now();
		this.#sample(now);
		const rows = await Promise.all(
			[...this.#sessions.values()].map(async (record) => {
				const session = await record.sessionPromise.catch(() => null);
				const stats = session?.getSessionStats?.();
				const lifetimeLeft = record.createdAt + this.#maxLifetimeMs - now;
				const idleLeft = record.lastUsedAt + this.#idleMs - now;
				const orphanLeft = this.#oneShotMs > 0 && record.requests <= 1 ? record.lastUsedAt + this.#oneShotMs - now : Infinity;
				const soonest = Math.min(lifetimeLeft, idleLeft, orphanLeft);				return {
					fingerprint: fingerprint(record.id),
					provider: session?.model?.provider ?? null,
					model: session?.model?.id ?? null,
					ageMs: now - record.createdAt,
					idleMs: now - record.lastUsedAt,
					expiresInMs: Math.max(0, soonest),
					expiresBecause: expiryReason(lifetimeLeft, idleLeft, orphanLeft),
					inflight: record.inflight,
					requests: record.requests,
					// Live spend for this session. Pi aggregates over compacted-away history too, so it is
					// what was actually billed so far, not an estimate.
					cost: Number(stats?.cost) || 0,
					tokens: stats?.tokens?.total ?? 0,
				};
			}),
		);
		rows.sort((a, b) => a.expiresInMs - b.expiresInMs);
		return {
			count: rows.length,
			max: this.#max,
			maxLifetimeMs: this.#maxLifetimeMs,
			idleMs: this.#idleMs,
			oneShotMs: this.#oneShotMs,
			history: this.#history,
			// Persisted ledger totals, so the spend figures survive reaping and restarts. Live spend is
			// the sum of the per-session costs below.
			spend: spendTotals(),
			sessions: rows,
		};
	}

	/**
	 * Rolling sample of the live-agent count, for the dashboard trend. Sampled at most every 15s
	 * from the reaper tick and from snapshot(), so the line is real observed data rather than a
	 * fabricated curve. Keeps one hour.
	 */
	#sample(now) {
		if (now - this.#lastSampleAt < 15_000) return;
		this.#lastSampleAt = now;
		this.#history.push({ t: now, count: this.#sessions.size });
		if (this.#history.length > 240) this.#history.shift();
	}

	#spawn(id, credential = null) {
		this.#evictOldest();
		const now = Date.now();
		// A fresh UUID per record, never the client's session id: a caller-supplied id must not be
		// able to steer where a directory is created.
		const workspace = this.#workspaces.create();
		const record = {
			id,
			workspace,
			// Which key opened this session, recorded once. A session continued by a different key
			// stays attributed to whoever created it.
			keyId: credential?.id ?? null,
			keyName: credential?.name ?? null,
			sessionPromise: null,
			queue: Promise.resolve(),
			state: { forwarded: 0, lastUserText: null },
			inflight: 0,
			requests: 1,
			// Fallback bookkeeping: which model to go back to, and when we switched.
			primaryModel: null,
			fallbackActive: false,
			fallbackAt: null,
			createdAt: now,
			lastUsedAt: now,
		};
		record.sessionPromise = this.#create(workspace, record);
		// Kept on the record once it exists, so synchronous readers (spend limits) can see it.
		record.sessionPromise.then((session) => (record.session = session), () => {});
		this.#sessions.set(id, record);
		return record;
	}

	#evictOldest() {
		if (this.#sessions.size < this.#max) return;
		let victim;
		for (const record of this.#sessions.values()) {
			if (record.inflight > 0) continue;
			if (!victim || record.lastUsedAt < victim.lastUsedAt) victim = record;
		}
		// ponytail: when every session is busy we overshoot the cap rather than break in-flight work
		if (victim) this.close(victim.id);
	}
}

const sessions = new SessionController({
	create: createSession,
	maxSessions: config.MAX_SESSIONS,
	maxLifetimeMs: config.SESSION_MAX_LIFETIME_MS,
	idleMs: config.SESSION_IDLE_MS,
	oneShotMs: config.ONE_SHOT_TTL_MS,
	workspaces,
});

/**
 * Reconcile workspaces against the live set, and expire old archives.
 *
 * The registry is in memory, so on the first run of a process every directory on disk is an
 * orphan. That is what makes WORKSPACE_ON_EXPIRY true across a restart rather than only while the
 * process happens to be alive — and with `delete` it means a restart expires every workspace.
 */
function sweepWorkspaces() {
	workspaces.ensureRoots();
	const { orphans, expired } = workspaces.sweep(sessions.liveWorkspaces());
	if (orphans || expired) {
		process.stderr.write(`workspace sweep: ${orphans} orphaned, ${expired} archive(s) expired\n`);
	}
}
setInterval(sweepWorkspaces, 60_000).unref();
sweepWorkspaces();

/**
 * Remove bridge sockets nobody is listening on, left behind by a gateway that was killed rather than
 * shut down. A socket is only removed when connecting to it is refused, so a second gateway sharing
 * the directory keeps its own; one younger than a minute is skipped as possibly still starting.
 */
export async function sweepSockets(dir = runRoot()) {
	let names = [];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".sock"));
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		const path = join(dir, name);
		try {
			const stat = lstatSync(path);
			if (!stat.isSocket() || Date.now() - stat.mtimeMs < 60_000) continue;
		} catch {
			continue;
		}
		const stale = await new Promise((resolvePromise) => {
			const probe = netConnect(path);
			probe.once("connect", () => {
				probe.destroy();
				resolvePromise(false);
			});
			probe.once("error", (err) => resolvePromise(err.code === "ECONNREFUSED" || err.code === "ENOENT"));
		});
		if (stale) {
			rmSync(path, { force: true });
			removed++;
		}
	}
	return removed;
}
setInterval(() => void sweepSockets().catch(() => {}), 10 * 60_000).unref();
void sweepSockets().catch(() => {});

// ------------------------------------------------------------ pure mapping

/** Flatten an OpenAI message content (string or parts array) to text. */
export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part?.type === "text" || part?.type === "input_text")
			.map((part) => part.text ?? "")
			.join("");
	}
	return "";
}

/** Image URLs referenced by an OpenAI message's content parts (chat or Responses shape). */
export function messageImageSources(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	const sources = [];
	for (const part of content) {
		if (part?.type !== "image_url" && part?.type !== "input_image") continue;
		const raw = part.image_url;
		const url = typeof raw === "string" ? raw : raw?.url;
		if (typeof url === "string" && url) sources.push(url);
	}
	return sources;
}

/** Count audio content parts in a message. Pi has no audio input type, so these are rejected. */
export function messageAudioParts(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return 0;
	return content.filter((part) => part?.type === "input_audio" || part?.type === "audio_url" || part?.type === "audio").length;
}

/**
 * Turn to send to Pi for this request, mutating `state`.
 *
 * Clients resend the whole conversation; Pi already holds the prior turns, so
 * only user messages past the last forwarded index are sent. If nothing new is
 * present (calls that send just the latest turn), the trailing user message is
 * used when its text differs from the last one forwarded. Images are only ever
 * taken from messages being forwarded, never re-sent from history.
 */
export function nextTurn(messages, state) {
	const list = Array.isArray(messages) ? messages : [];
	// Nothing forwarded yet means this agent has no memory of this conversation yet.
	const virginSession = state.forwarded === 0;
	const fresh = list.slice(state.forwarded).filter((m) => m?.role === "user");
	state.forwarded = list.length;

	// An agent with no history must only be asked the newest question. A client resending a
	// transcript is replaying already-answered turns, not queueing several requests at once;
	// joining them would hand the model the whole backlog and it would answer the old questions
	// again, which reads as prompts being mixed and repeated on every turn.
	const users = virginSession ? fresh.slice(-1) : fresh;

	let text = users.map(messageText).filter(Boolean).join("\n\n");
	let images = users.flatMap(messageImageSources);
	let audio = users.reduce((count, m) => count + messageAudioParts(m), 0);

	if (!text && !images.length && !audio) {
		const last = list.findLast((m) => m?.role === "user");
		const lastText = last ? messageText(last) : "";
		if (lastText && lastText !== state.lastUserText) {
			text = lastText;
			images = messageImageSources(last);
			audio = messageAudioParts(last);
		}
	}
	if (text) state.lastUserText = text;

	// An agent with no history cannot see the turns the client replayed, so hand them over as
	// context rather than dropping them. This is what lets a derived session key or an evicted
	// session change without silently losing the conversation.
	let context = "";
	if (virginSession) {
		const cutoff = list.findLastIndex((m) => m?.role === "user");
		const prior = (cutoff > 0 ? list.slice(0, cutoff) : []).filter((m) => m?.role === "user" || m?.role === "assistant");
		context = framedTranscript(prior);
	}
	return { text, images, audio, context };
}

function dataUriToImage(url) {
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
	if (!match) return null;
	const mimeType = match[1] || "image/png";
	let data;
	try {
		data = match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3])).toString("base64");
	} catch {
		return null; // malformed percent-encoding
	}
	return { type: "image", data, mimeType };
}

// Addresses an image URL must never resolve to. The fetch runs in the gateway, outside every
// sandbox, so without this a client could point it at the dashboard on loopback, the cloud metadata
// endpoint or anything on the LAN and have the reply described back by the model.
const BLOCKED_ADDRESSES = new BlockList();
for (const [net, bits] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
	["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
]) BLOCKED_ADDRESSES.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]]) {
	BLOCKED_ADDRESSES.addSubnet(net, bits, "ipv6");
}

/** True when an address is loopback, private, link-local, metadata, multicast or otherwise internal. */
export function isBlockedAddress(address) {
	let ip = String(address ?? "").replace(/^\[|\]$/g, "");
	// An IPv4-mapped IPv6 address reaches the IPv4 host, so it is judged as one.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) ip = mapped[1];
	const family = isIP(ip);
	if (!family) return true;
	return BLOCKED_ADDRESSES.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/**
 * A DNS lookup that refuses internal addresses. It is handed to the request itself, so the address
 * that is checked is the address that is connected to — a second lookup could be answered
 * differently (DNS rebinding) and a check done beforehand would prove nothing.
 */
function guardedLookup(hostname, options, callback) {
	dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err);
		const blocked = addresses.find((a) => isBlockedAddress(a.address));
		if (blocked) return callback(new Error(`refusing to fetch from an internal address (${blocked.address})`));
		if (options?.all) return callback(null, addresses);
		callback(null, addresses[0].address, addresses[0].family);
	});
}

/** Fetch one image over http(s), refusing internal addresses and stopping at the size limit. */
function fetchImage(url, { maxBytes, timeoutMs = 15_000 }) {
	return new Promise((resolvePromise, reject) => {
		const target = new URL(url);
		const client = target.protocol === "https:" ? https : http;
		// A literal address skips DNS entirely, so it is checked here instead of in the lookup.
		if (isIP(target.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(target.hostname)) {
			return reject(new Error(`refusing to fetch from an internal address: ${url.slice(0, 60)}`));
		}
		const request = client.get(target, { lookup: guardedLookup, timeout: timeoutMs }, (response) => {
			// Redirects are not followed: each hop would need the same check, and images rarely need one.
			if (response.statusCode !== 200) {
				response.resume();
				return reject(new Error(`Image fetch failed (HTTP ${response.statusCode}): ${url.slice(0, 60)}`));
			}
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxBytes) {
					request.destroy();
					return reject(new Error(`Image too large (>${maxBytes} bytes): ${url.slice(0, 60)}`));
				}
				chunks.push(chunk);
			});
			response.on("end", () =>
				resolvePromise({ buffer: Buffer.concat(chunks), contentType: response.headers["content-type"] ?? "" }),
			);
			response.on("error", reject);
		});
		request.on("timeout", () => request.destroy(new Error(`Image fetch timed out: ${url.slice(0, 60)}`)));
		request.on("error", (err) => reject(new Error(`Image fetch failed: ${err.message}`)));
	});
}

/** Resolve OpenAI image URLs (data: or http/s) into Pi ImageContent attachments. */
export async function resolveImages(sources) {
	const images = [];
	for (const url of sources) {
		if (url.startsWith("data:")) {
			const image = dataUriToImage(url);
			if (!image) throw new Error(`Malformed image data URI: ${url.slice(0, 60)}`);
			images.push(image);
			continue;
		}
		if (!/^https?:\/\//i.test(url)) throw new Error(`Unsupported image URL: ${url.slice(0, 60)}`);
		if (!config.ALLOW_IMAGE_URLS) {
			throw new Error("Image URLs are disabled on this gateway (ALLOW_IMAGE_URLS); send the image as a data: URI");
		}
		const { buffer, contentType } = await fetchImage(url, { maxBytes: config.MAX_IMAGE_BYTES });
		images.push({
			type: "image",
			data: buffer.toString("base64"),
			mimeType: (contentType || "image/png").split(";")[0].trim(),
		});
	}
	return images;
}

/**
 * Everything identifying a client, as one string. Exported so the access log can report a hash
 * of it: when two requests derive different sessions, this says whether the client or the
 * message changed.
 */
export function clientFingerprint(req, body) {
	return [
		req?.socket?.remoteAddress ?? "",
		req?.headers?.["user-agent"] ?? "",
		typeof body?.user === "string" ? body.user : "",
	].join("\u0000");
}

/**
 * Session key the gateway can hold on its own, for clients that cannot echo a header.
 *
 * Derived from the client plus the FIRST user message — stable for any client that replays its
 * transcript, and different only when a genuinely new chat starts. Deriving is only safe because
 * a session with no history gets the transcript replayed as context, so a changed key costs a
 * replay rather than losing the conversation.
 */
export function derivedSessionId(req, body) {
	const seed = firstUserSeed(body);
	if (!seed) return null;
	return "d-" + crypto.createHash("sha256").update(`${clientFingerprint(req, body)}\u0000${seed}`).digest("hex").slice(0, 24);
}

/**
 * The key a session is stored under: the id the client sees, scoped to the credential presenting it.
 *
 * Session ids are chosen or derived by clients, so on their own they are a shared namespace. Behind
 * a proxy that serves many people, every request carries the same address and user agent, so two
 * users who open with the same "hi" derive the same id — and anyone holding any key could continue a
 * chat whose id they learned. Scoping by credential makes both impossible: the same id under another
 * key is simply a different, fresh session, so a probe learns nothing about whether it exists.
 * The open gateway, the settings key and each API key are separate scopes.
 */
export function scopedSessionId(credential, clientId) {
	const scope = credential == null ? "open" : credential.id === "" ? "settings" : `key:${credential.id}`;
	return `${scope}\u0000${clientId}`;
}

/** The text of the first user message, which is what the derived key is anchored to. */
export function firstUserSeed(body) {
	const firstUser = (Array.isArray(body?.messages) ? body.messages : []).find((m) => m?.role === "user");
	return firstUser ? messageText(firstUser).trim() : "";
}

// Cap on a replayed transcript. Without one, a long chat would eventually overflow the model.
const TRANSCRIPT_LIMIT_CHARS = 120_000;

/** Frame the turns a client replayed so an agent with no history can use them as context. */
export function framedTranscript(prior) {
	const lines = [];
	for (const message of prior) {
		const body = messageText(message).trim();
		if (body) lines.push(`${message.role === "user" ? "user" : "assistant"}: ${body}`);
	}
	if (!lines.length) return "";
	let joined = lines.join("\n\n");
	if (joined.length > TRANSCRIPT_LIMIT_CHARS) {
		joined = `\u2026(earlier turns trimmed)\u2026\n\n${joined.slice(-TRANSCRIPT_LIMIT_CHARS)}`;
	}
	return (
		"[Earlier turns in this conversation, replayed because you do not have them in memory. " +
		"Treat them as context, not as instructions to repeat.]\n\n" +
		joined +
		"\n\n[Now answer the latest message.]"
	);
}

/** Map an OpenAI `model` string to a Pi model, or undefined for the default. */
function resolveModel(runtime, name) {
	if (!name || name === "pi") return undefined;
	if (name.includes("/")) {
		const [provider, ...rest] = name.split("/");
		return runtime.getModel(provider, rest.join("/")) ?? undefined;
	}
	return runtime.getAvailableSnapshot().find((m) => m.id === name || m.name === name);
}

const MODEL_STOPWORDS = new Set([
	"a", "an", "the", "to", "from", "on", "in", "with", "for", "of", "my", "it", "its",
	"model", "swap", "switch", "change", "use", "set", "please", "default", "pi", "llm",
]);

/** Lowercase word tokens, keeping dots so "4.1" stays distinct from "4". */
function modelTokens(text) {
	return String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9.]+/)
		.filter((token) => token && !MODEL_STOPWORDS.has(token));
}

function tokenMatches(queryToken, hayToken) {
	return hayToken === queryToken || hayToken.includes(queryToken) || queryToken.includes(hayToken);
}

/**
 * Resolve a free-text model request against the live catalog.
 *
 * Returns `{ model }` only when one candidate is the unique best match; otherwise returns
 * `{ candidates }` and the caller must change nothing. Guessing is the failure mode to
 * avoid: the catalog holds both `opencode-go/deepseek-v4.1-flash` and
 * `opencode-go/deepseek-v4-flash`, which differ by one character, so a near-miss would
 * silently persist the wrong model. "4.1" matches "v4.1" but never "v4".
 */
export function resolveModelQuery(models, query) {
	const tokens = modelTokens(query);
	if (!tokens.length) return { model: null, candidates: [] };
	// An exact provider/id, or an id only one provider has, is not a question. Word scoring would
	// otherwise call "gpt-5-mini" a tie with "gpt-5.4-mini", which shares every one of its words.
	const exact = String(query).trim().toLowerCase();
	const byFullId = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === exact);
	if (byFullId.length === 1) return { model: byFullId[0], candidates: [] };
	const byId = models.filter((m) => String(m.id).toLowerCase() === exact);
	if (byId.length === 1) return { model: byId[0], candidates: [] };

	const scored = [];
	for (const model of models) {
		const hay = modelTokens(`${model.provider}/${model.id} ${model.name ?? ""}`);
		let score = 0;
		for (const token of tokens) if (hay.some((h) => tokenMatches(token, h))) score += 1;
		if (score > 0) scored.push({ model, score });
	}
	if (!scored.length) return { model: null, candidates: [] };

	scored.sort((a, b) => b.score - a.score);
	const best = scored[0].score;
	const winners = scored.filter((s) => s.score === best);
	// Unique best that matched all but at most one significant word -> confident.
	if (winners.length === 1 && best >= Math.max(1, tokens.length - 1)) return { model: winners[0].model, candidates: [] };
	// Only suggest alternatives when at least half the words actually matched. Otherwise a
	// nonsense name like "gpt-9-turbo-ultra" comes back as a list of every gpt model, which
	// reads like a plausible suggestion when it is really just noise from one shared word.
	if (best < Math.ceil(tokens.length / 2)) return { model: null, candidates: [] };
	return { model: null, candidates: winners.slice(0, 8).map((s) => `${s.model.provider}/${s.model.id}`) };
}

/** Quota, credit and subscription exhaustion — permanent for the account. */
const QUOTA_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|insufficient_quota|exceeded your current quota|quota exceeded|billing|out of credits|credit balance/i;

/** Transient provider and transport failures, which Pi retries before giving up. */
const TRANSIENT_ERROR_PATTERN =
	/overloaded|high demand|rate.?limit|too many requests|\b(?:429|500|502|503|504|520|524)\b|service.?unavailable|server.?error|internal.?error|provider.?(?:returned|error)|network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?(?:closed|error)|stream ended/i;

/** Classify a failed turn's error text. Mirrors how Pi decides retryable vs fatal. */
export function classifyModelError(errorMessage) {
	if (!errorMessage) return "none";
	if (QUOTA_ERROR_PATTERN.test(errorMessage)) return "quota";
	if (TRANSIENT_ERROR_PATTERN.test(errorMessage)) return "transient";
	return "other";
}

/**
 * Whether a failed turn is worth retrying on a different model.
 *
 * "quota" is permanent for the account, so a same-model retry cannot help. "transient" only
 * reaches us once Pi has already exhausted its own retries. "other" is a deterministic request
 * problem — a bad payload, a context overflow — that a different model will not fix either, so
 * retrying would just fail twice.
 */
export function shouldFallBack(errorMessage) {
	const kind = classifyModelError(errorMessage);
	return kind === "quota" || kind === "transient";
}

/**
 * The session id a client asked for, or null to start a new one.
 *
 * Deliberately never derived from message content: clients that send only the latest
 * turn would otherwise compute a different key every message and get a fresh session
 * (and a fresh system prompt) each time.
 */
export function requestedSessionId(req, body) {
	const headers = req?.headers ?? {};
	const fromHeader = headers["x-session-id"] ?? headers["x-conversation-id"];
	if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
	const fromBody = body?.session_id ?? body?.conversation_id;
	if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();
	return null;
}

/**
 * True when a turn is the bare `/reload` command.
 *
 * Only the exact command is matched. Natural language like "please reload yourself" is
 * deliberately NOT treated as a reload: catching that reliably would mean guessing at the
 * model's intent, and a wrong guess would silently do nothing while looking like it worked.
 */
export function isReloadCommand(text) {
	return typeof text === "string" && text.trim() === RELOAD_COMMAND;
}

/** Gateway commands a user can type in chat. Only these exact names; everything else goes to Pi. */
const GATEWAY_COMMANDS = new Set(["piper", "skills", "extensions", "settings", "profile"]);

/**
 * A chat turn that is one of the gateway's own commands, as `{ name, args }`, or null.
 *
 * Only exact command names are taken. Pi's own `/skill:name` and prompt templates, and any message
 * that merely starts with a slash, still go to the agent.
 */
export function parseGatewayCommand(text) {
	if (typeof text !== "string") return null;
	const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match || !GATEWAY_COMMANDS.has(match[1])) return null;
	return { name: match[1], args: (match[2] ?? "").trim() };
}

const COMMAND_HELP = [
	"Commands for your profile (your own skills, extensions and settings, shared by every chat on this key):",
	"",
	"  /skills                        skills loaded in this chat",
	"  /extensions                    extensions in your profile, and the commands they add",
	"  /settings                      your profile's settings.json",
	"  /settings set <key> <value>    change one setting (value as JSON, or plain text), then reload",
	"  /settings unset <key>          remove one setting, then reload",
	"  /profile                       size, quota and contents of your profile",
	"  /profile reset                 start your profile over from the gateway's template",
	"  /reload                        re-read skills, extensions, prompts and settings",
	"",
	"Skills and extensions marked (shared: <bundle>) come from the gateway operator and are read-only.",
	"",
	"You can also ask the agent to write a skill or extension into $PI_CODING_AGENT_DIR, then /reload.",
].join("\n");

function formatBytes(n) {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

/** Answer one gateway command for the session `c`. Returns the reply text. */
async function runGatewayCommand(c, { name, args }) {
	if (name === "piper") return COMMAND_HELP;
	const session = await c.sessionPromise;
	if (!(session instanceof PiRpcSession)) {
		return "Profile commands need a sandboxed runner. This gateway runs sessions in-process (RUNNER=inprocess), where every session shares the operator's own Pi configuration.";
	}
	const keyId = c.keyId ?? null;
	if (name === "skills") {
		const { commands = [] } = (await session.send({ type: "get_commands" })) ?? {};
		const skills = commands.filter((cmd) => cmd.source === "skill");
		if (!skills.length) return "No skills are loaded. Ask the agent to write one into $PI_CODING_AGENT_DIR/skills/<name>/SKILL.md, then /reload.";
		const bundles = grantedBundles(keyId);
		// Where a skill came from, so a user knows which ones are theirs to change.
		const origin = (cmd) => {
			const path = cmd.sourceInfo?.path ?? "";
			const bundle = bundles.find((b) => path.startsWith(`${SANDBOX_PATHS.shared}/${b.name}/`));
			if (bundle) return ` (shared: ${bundle.name})`;
			return cmd.sourceInfo?.scope === "project" ? " (from this workspace)" : "";
		};
		return ["Skills loaded in this chat:", "", ...skills.map((cmd) => `  /${cmd.name}${cmd.description ? ` — ${cmd.description}` : ""}${origin(cmd)}`)].join("\n");
	}
	if (name === "extensions") {
		const [{ commands = [] } = {}, files] = await Promise.all([session.send({ type: "get_commands" }), profileOp(keyId, { op: "extensions.list" })]);
		const lines = files.length ? ["Extensions in your profile:", "", ...files.map((f) => `  ${f.name} (${formatBytes(f.bytes)})`)] : ["No extensions in your profile."];
		const shared = grantedBundles(keyId).flatMap((b) => bundleContents(b.path).extensions.map((name) => `  ${name} (shared: ${b.name})`));
		if (shared.length) lines.push("", "Shared extensions (read-only, from the gateway operator):", ...shared);
		const added = commands.filter((cmd) => cmd.source === "extension" && !cmd.name.startsWith("piper-"));
		if (added.length) lines.push("", "Extension commands available (yours, and any Pi ships with):", ...added.map((cmd) => `  /${cmd.name}${cmd.description ? ` — ${cmd.description}` : ""}`));
		lines.push("", "Extensions are .ts or .js files in $PI_CODING_AGENT_DIR/extensions; /reload after changing them.");
		return lines.join("\n");
	}
	if (name === "settings") {
		const set = /^set\s+(\S+)\s+([\s\S]+)$/.exec(args);
		const unset = /^unset\s+(\S+)$/.exec(args);
		if (set || unset) {
			let value;
			if (set) {
				try {
					value = JSON.parse(set[2]);
				} catch {
					value = set[2].trim();
				}
			}
			await profileOp(keyId, set ? { op: "settings.patch", set: { [set[1]]: value } } : { op: "settings.patch", unset: [unset[1]] });
			await reloadSession(c);
			return set ? `Set ${set[1]} = ${JSON.stringify(value)} and reloaded.` : `Removed ${unset[1]} and reloaded.`;
		}
		if (args) return "Usage: /settings, /settings set <key> <value>, or /settings unset <key>.";
		const settings = await profileOp(keyId, { op: "settings.get" });
		return `Your profile's settings.json:\n\n${JSON.stringify(settings, null, 2)}`;
	}
	if (name === "profile") {
		if (args === "reset") {
			return "This replaces your profile — every skill, extension and setting on this key — with the gateway's starting template, and closes this key's other chats. Your shared folder (/workspace/shared) is kept. The old profile is archived by the operator's retention policy. Send `/profile reset confirm` to go ahead.";
		}
		if (args === "reset confirm") {
			const { closed } = resetProfile(keyId);
			return `Your profile was reset. ${closed} chat session(s) on this key were closed, this one included; your next message starts a fresh agent that replays this conversation.`;
		}
		if (args) return "Usage: /profile, or /profile reset.";
		const summary = await profileOp(keyId, { op: "summary" });
		const scope = profileScope(keyId);
		const { writable, reason } = profileWritability(keyId, join(profileRoot(), scope));
		const bundles = grantedBundles(keyId);
		const filesDir = join(keyFilesRoot(), scope);
		const files = keyFilesStats(filesDir);
		const filesState = files.created ? keyFilesWritability(filesDir) : { writable: true };
		return [
			`Profile: ${summary.skills.length} skill(s), ${summary.extensions.length} extension(s)${summary.hasAgentsMd ? ", an AGENTS.md" : ""}.`,
			files.created
				? `Shared folder (/workspace/shared, the same in every chat on this key): ${files.files} file(s), ${formatBytes(files.bytes)}${filesState.writable ? "" : ` — frozen: ${filesState.reason}`}.`
				: "Shared folder: created with this key's first chat.",
			bundles.length
				? `Shared bundles: ${bundles.map((b) => b.name).join(", ")} (read-only, managed by the gateway operator).`
				: "Shared bundles: none.",
			`Size: ${formatBytes(summary.bytes)}${summary.maxBytes ? ` of ${formatBytes(summary.maxBytes)}` : ""}.`,
			writable ? "Writable by your chats." : `Read-only: ${reason}.`,
			summary.settingsError ? `settings.json is broken: ${summary.settingsError}` : "",
			"",
			"Type /piper for the commands.",
		]
			.filter((line, i, all) => line || all[i - 1])
			.join("\n");
	}
	return COMMAND_HELP;
}

// ------------------------------------------------------------- agent driving

function usageDelta(before, after) {
	const prompt = (after.input - before.input) + (after.cacheRead - before.cacheRead) + (after.cacheWrite - before.cacheWrite);
	const completion = after.output - before.output;
	return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** Emit a canned assistant reply for a gateway-handled command that never reached the model. */
function sendTextReply(res, { id, created, modelName, text, stream }) {
	if (!stream) {
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(
			JSON.stringify({
				id,
				object: "chat.completion",
				created,
				model: modelName,
				choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			}),
		);
	}
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	const chunk = (delta, finish = null) =>
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created,
			model: modelName,
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	res.write(chunk({ role: "assistant", content: "" }));
	res.write(chunk({ content: text }));
	res.write(chunk({}, "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
}

/**
 * Reload the session's settings and resources.
 *
 * Goes through sessions.run so it is serialized behind any in-flight prompt: reload()
 * invalidates the extension runner and rebuilds the tool registry, which is only safe once
 * the agent has stopped running. Running it inline from a tool would deadlock the runtime.
 */
async function reloadSession(c) {
	return sessions.run(c, async () => {
		const session = await c.sessionPromise;
		await session.reload();
		if (session instanceof PiRpcSession) {
			return "Reloaded. Skills, extensions, prompts, settings and context files from your profile and workspace were re-read.";
		}
		return "Reloaded. Settings, skills, prompts, themes, and context files were re-read. Extensions remain disabled for session isolation, so no package-provided state was loaded.";
	});
}

/**
 * Resolve the user's wording and switch this session's model.
 *
 * Session-only: nothing is written to settings.json, so other gateway sessions and the
 * interactive `pi` in a terminal keep their own model.
 */
async function setModelFromQuery(session, query) {
	const runtime = await modelRuntime();
	const { model, candidates } = resolveModelQuery(runtime.getAvailableSnapshot(), query);
	if (!model) {
		return candidates.length
			? `"${query}" matches several models: ${candidates.join(", ")}. Ask the user which one they mean; nothing was changed.`
			: `No available model matches "${query}". Nothing was changed.`;
	}
	await session.setModel(model);
	return `Model switched to ${model.provider}/${model.id} for this session only.`;
}

/** The tool the model calls to change its own model. `ref` is filled in after the session exists. */
function setModelTool(ref) {
	const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });
	return {
		name: "pi_set_model",
		label: "Set Pi model",
		description:
			"Switch the Pi model for this session. Pass the user's own wording verbatim, for example 'deepseek 4.1 flash from opencode-go'. " +
			"Do not invent or guess a provider/model id. Resolution is done against the live catalog; if the request is ambiguous or unknown nothing changes and a candidate list is returned so you can ask the user.",
		promptSnippet: "Switch the active model for this session",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The model the user asked for, in their own words (not an id you constructed).",
				},
			},
			required: ["query"],
		},
		execute: async (_toolCallId, params) => {
			if (!ref.session) return text("Model swapping is not available yet; try again in a moment.");
			try {
				return text(await setModelFromQuery(ref.session, String(params?.query ?? "")));
			} catch (err) {
				return text(`Model swap failed: ${err?.message ?? err}`);
			}
		},
	};
}

/** The configured fallback model, or null when disabled or unresolvable. */
async function fallbackModel() {
	if (!config.FALLBACK_MODEL) return null;
	const runtime = await modelRuntime();
	return resolveModel(runtime, config.FALLBACK_MODEL) ?? null;
}

/** How long the session stays on the fallback, for the inline notice. */
function fallbackScopeNote() {
	if (config.FALLBACK_MODE === "request") return " for this request only";
	if (config.FALLBACK_MODE === "cooldown") return ` for ${formatDuration(config.FALLBACK_COOLDOWN_MS)}`;
	return " for this session";
}

/**
 * Go back to the model the session was on before falling back, per FALLBACK_MODE.
 * `session` never reverts; `request` reverts on the next request; `cooldown` waits out the
 * cooldown first, which is what lets a transient outage clear on its own.
 */
async function maybeRevertToPrimary(session, c) {
	if (!c.fallbackActive || !c.primaryModel) return;
	const due =
		config.FALLBACK_MODE === "request" ||
		(config.FALLBACK_MODE === "cooldown" && Date.now() - (c.fallbackAt ?? 0) >= config.FALLBACK_COOLDOWN_MS);
	if (!due) return;
	try {
		await session.setModel(c.primaryModel);
		c.fallbackActive = false;
		c.fallbackAt = null;
	} catch {
		/* if the primary cannot be restored, staying on the fallback is the safer choice */
	}
}

/**
 * Keep a failed turn out of what the next model sees, without deleting it from the record.
 * Pi does exactly this internally via _omitRecoveryAttempt; that is typed private, so it is
 * called defensively and a renamed method simply leaves the failed turn visible.
 */
function omitFailedAttempt(session, message) {
	if (!message) return;
	try {
		session._omitRecoveryAttempt?.(message, []);
	} catch {
		/* leave it visible rather than break the retry */
	}
}

function truncate(text, max = 160) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

/**
 * Run one prompt on the conversation's session, forwarding assistant text
 * deltas to `onDelta`. Returns the accumulated reply text.
 *
 * A failed model call is not a thrown exception: it is an assistant message with
 * stopReason "error" and an errorMessage. When that failure is one a different model could
 * survive, the turn is retried once on the configured fallback model and the switch is
 * announced inline, so the reader knows which model answered and why.
 */
async function runPrompt(c, prompt, { onDelta, onThinking, signal, body, images = [], context = "" } = {}) {
	return sessions.run(c, async () => {
		const session = await c.sessionPromise;
		await maybeRevertToPrimary(session, c);
		await applyRequestOptions(session, body);

		let promptText = prompt;
		if (images.length && !(session.model?.input ?? []).includes("image")) {
			promptText = `${prompt}\n\n[${images.length} image(s) omitted: model ${session.model?.id ?? "unknown"} does not accept image input]`;
			images = [];
		}
		if (context) promptText = `${context}\n\n${promptText}`;

		let text = "";
		let reasoning = "";
		let pendingBreak = false;
		let pendingThinkBreak = false;
		let suppressBreak = false;
		const emit = (chunk) => {
			text += chunk;
			onDelta?.(chunk);
		};
		// Reasoning goes out as `reasoning_content`, kept out of `content` so a client that
		// ignores the field sees exactly what it saw before.
		const emitThinking = (chunk) => {
			reasoning += chunk;
			onThinking?.(chunk);
		};
		const finish = () => ({ text: text || session.getLastAssistantText?.() || "", reasoning });

		const attempt = async () => {
			let lastAssistant = null;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_start" && event.message?.role === "assistant") {
					// A notice already ends with a blank line, so it must not get a second separator.
					pendingBreak = text.length > 0 && !suppressBreak;
					suppressBreak = false;
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					lastAssistant = event.message;
					return;
				}
				if (event.type !== "message_update") return;
				const update = event.assistantMessageEvent;
				// Thinking arrives as its own content block, one per turn, so a separator goes
				// between blocks (a tool loop produces several) and never before the first.
				if (update?.type === "thinking_start") {
					pendingThinkBreak = reasoning.length > 0;
					return;
				}
				if (update?.type === "thinking_delta" && update.delta) {
					if (pendingThinkBreak) {
						pendingThinkBreak = false;
						emitThinking("\n\n");
					}
					emitThinking(update.delta);
					return;
				}
				if (update?.type !== "text_delta" || !update.delta) return;
				if (pendingBreak) {
					pendingBreak = false;
					emit("\n\n");
				}
				emit(update.delta);
			});
			const abort = () => void session.abort().catch(() => {});
			signal?.addEventListener("abort", abort, { once: true });
			try {
				await session.prompt(promptText, images.length ? { images } : undefined);
			} finally {
				signal?.removeEventListener("abort", abort);
				unsubscribe();
			}
			const failed = lastAssistant?.stopReason === "error";
			return {
				failed,
				message: lastAssistant,
				errorMessage: failed ? lastAssistant?.errorMessage ?? "unknown model error" : null,
			};
		};

		// One fallback per turn, not one per session. A client that keeps selecting a failing
		// model explicitly should still be rescued on every turn; the single retry below is
		// what prevents a ping-pong between two bad models, so no session-level guard is needed.
		let result = await attempt();
		const fallback = result.failed && shouldFallBack(result.errorMessage) ? await fallbackModel() : null;
		const from = session.model;
		const sameModel = fallback && from && fallback.provider === from.provider && fallback.id === from.id;
		if (!fallback || sameModel) {
			// Without this a failed call answers with an empty message, which reads as the model having
			// nothing to say rather than as an error somebody should look at.
			if (result.failed) emit(`${text.length ? "\n\n" : ""}[model error: ${from ? `${from.provider}/${from.id}: ` : ""}${truncate(result.errorMessage, 400)}]`);
			return finish();
		}

		c.primaryModel ??= from;
		const kind = classifyModelError(result.errorMessage);
		try {
			await session.setModel(fallback);
		} catch (err) {
			emit(`${text.length ? "\n\n" : ""}[fallback to ${fallback.provider}/${fallback.id} failed: ${err?.message ?? err}]\n\n`);
			return finish();
		}
		omitFailedAttempt(session, result.message);
		c.fallbackActive = true;
		c.fallbackAt = Date.now();

		const where = from ? `${from.provider}/${from.id}` : "the active model";
		emit(`${text.length ? "\n\n" : ""}[model fallback: ${where} failed (${kind}: ${truncate(result.errorMessage)}) - switched to ${fallback.provider}/${fallback.id}${fallbackScopeNote()}]\n\n`);
		suppressBreak = true;

		result = await attempt();
		if (result.failed) {
			emit(`[the fallback model also failed: ${truncate(result.errorMessage)}]\n\n`);
		}
		return finish();
	});
}

async function applyRequestOptions(session, body) {
	const runtime = await modelRuntime();
	const model = resolveModel(runtime, body?.model);
	if (model && (session.model?.provider !== model.provider || session.model?.id !== model.id)) {
		await session.setModel(model);
	}
	const effort = body?.reasoning_effort;
	if (PI_LEVELS.includes(effort) && session.thinkingLevel !== effort) session.setThinkingLevel(effort);
}

// ------------------------------------------------------------- http helpers

/** One line per request. Session ids are never logged, only their fingerprint. */
function logAccess(req, status, note) {
	if (!config.ACCESS_LOG) return;
	process.stderr.write(`${new Date().toISOString()} ${req.method} ${status} ${req.url}${note ? ` ${note}` : ""}\n`);
}

function cors(res) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Session-Id, X-Conversation-Id");
	res.setHeader("Access-Control-Expose-Headers", "X-Session-Id");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
}

function sendError(res, status, message, code = "invalid_request_error", type = "invalid_request_error") {
	if (res.headersSent) return res.end();
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: { message, type, param: null, code } }));
}

function readJson(req, limit = config.BODY_LIMIT) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

/**
 * Whether the settings key was presented. This no longer answers "is auth off" — that is
 * authRequired() — and it is false when no settings key is configured, because the only caller is
 * the dashboard guard and only a real key should open it.
 */
export function authorized(req) {
	return isSettingsKey(bearerToken(req));
}

// ------------------------------------------------------------ route handlers

async function listModels(res) {
	const runtime = await modelRuntime();
	const seen = new Set();
	const data = [];
	for (const model of runtime.getAvailableSnapshot()) {
		if (data.length >= 200) break;
		const qualified = `${model.provider}/${model.id}`;
		if (!seen.has(qualified)) {
			seen.add(qualified);
			data.push({ id: qualified, object: "model", created: 0, owned_by: model.provider });
		}
		if (!seen.has(model.id)) {
			seen.add(model.id);
			data.push({ id: model.id, object: "model", created: 0, owned_by: model.provider });
		}
	}
	if (!data.length) data.push({ id: "pi", object: "model", created: 0, owned_by: "pi" });
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ object: "list", data }));
}

/**
 * Record what a session cost, so spend outlives the session.
 *
 * Called on close, which is the single funnel for every way a session can end. A session that
 * generated nothing is not recorded. A ledger failure must never stop a session being disposed,
 * so everything here is swallowed after logging.
 */
export function recordSpend(record, session) {
	try {
		const stats = session?.getSessionStats?.();
		const tokens = stats?.tokens;
		if (!tokens || tokens.total <= 0) return;
		db.prepare(
			"INSERT INTO spend (fingerprint, provider, model, cost, input, output, cache_read, cache_write, requests, closed_at, key_id) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			fingerprint(record.id),
			session.model?.provider ?? null,
			session.model?.id ?? null,
			Number(stats.cost) || 0,
			tokens.input ?? 0,
			tokens.output ?? 0,
			tokens.cacheRead ?? 0,
			tokens.cacheWrite ?? 0,
			record.requests ?? 0,
			Date.now(),
			record.keyId ?? null,
		);
	} catch (err) {
		process.stderr.write(`spend record failed: ${err?.message ?? err}\n`);
	}
}

/** Totals for the dashboard cards. The detailed breakdown lives in /dashboard/spend.json. */
export function spendTotals() {
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	const all = db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS sessions FROM spend").get();
	const today = db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM spend WHERE closed_at >= ?").get(midnight.getTime());
	return { total: Number(all.cost), today: Number(today.cost), sessions: Number(all.sessions) };
}

/** The spend view's report: totals, per model, and per day. */
export async function spendReport() {
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	const total = db
		.prepare(
			"SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, " +
				"COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite, COUNT(*) AS sessions FROM spend",
		)
		.get();
	const today = db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS sessions FROM spend WHERE closed_at >= ?").get(midnight.getTime());
	const byModel = db
		.prepare(
			"SELECT provider, model, COALESCE(SUM(cost), 0) AS cost, " +
				"COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens, COUNT(*) AS sessions " +
				"FROM spend GROUP BY provider, model ORDER BY cost DESC, sessions DESC",
		)
		.all();
	const byDay = db
		.prepare(
			"SELECT date(closed_at / 1000, 'unixepoch', 'localtime') AS day, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS sessions " +
				"FROM spend GROUP BY day ORDER BY day DESC LIMIT 60",
		)
		.all();
	return {
		today: { cost: Number(today.cost), sessions: Number(today.sessions) },
		total: {
			cost: Number(total.cost),
			sessions: Number(total.sessions),
			input: Number(total.input),
			output: Number(total.output),
			cacheRead: Number(total.cacheRead),
			cacheWrite: Number(total.cacheWrite),
		},
		byModel: byModel.map((r) => ({ ...r, cost: Number(r.cost), tokens: Number(r.tokens), sessions: Number(r.sessions) })),
		byDay: byDay.map((r) => ({ ...r, cost: Number(r.cost), sessions: Number(r.sessions) })),
		live: await sessions.liveStats(),
	};
}

/**
 * The catalogue behind the dashboard MODELS view.
 *
 * Lists what the gateway can actually route to (auth configured), not the entire known
 * catalogue — `known` carries that total so the difference is visible rather than implied.
 * Only the fields the page renders are sent; raw Model objects are far larger.
 */
async function modelCatalog(res) {
	const runtime = await modelRuntime();
	const models = runtime.getAvailableSnapshot().map((m) => ({
		provider: m.provider,
		id: m.id,
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

async function chatCompletions(req, res, body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	if (!messages.length) return sendError(res, 400, "`messages` is required", "invalid_request_error");

	const modelName = typeof body?.model === "string" && body.model ? body.model : "pi";
	const id = "chatcmpl-" + crypto.randomUUID();
	const created = Math.floor(Date.now() / 1000);
	const explicit = requestedSessionId(req, body);
	const derived = explicit ? null : derivedSessionId(req, body);
	// Minted here rather than by the controller, because the id the client echoes back is the bare
	// one and has to land on the same scoped key next time.
	const clientSessionId = explicit ?? derived ?? crypto.randomUUID();
	const scopedId = scopedSessionId(req.credential, clientSessionId);
	// A new session must fit under the key's limit. Its own idle sessions make room; if every one of
	// them is busy, the caller has to wait for one to finish rather than spawn without bound.
	if (!sessions.has(scopedId) && !sessions.makeRoomForKey(req.credential?.id ?? null, keyLimits(req.credential).maxSessions)) {
		return sendError(
			res, 429,
			`this key's session limit is ${keyLimits(req.credential).maxSessions} and every one of its sessions is busy; wait for one to finish`,
			"session_limit_exceeded", "rate_limit_error",
		);
	}
	let acquired = sessions.acquire(scopedId, req.credential);
	// A sandboxed Pi that crashed, was killed, or never started leaves a record that can only fail.
	// Replacing it costs a transcript replay, exactly like an evicted session, instead of an error
	// on every request until the idle timeout.
	if (!acquired.isNew) {
		const existing = await acquired.record.sessionPromise.catch(() => null);
		if (!existing || existing.alive === false) {
			sessions.close(scopedId);
			acquired = sessions.acquire(scopedId, req.credential);
		}
	}
	const { id: sessionId, record: c, isNew } = acquired;
	res.setHeader("X-Session-Id", clientSessionId);
	let source = "minted";
	if (explicit) source = "header";
	else if (derived) source = "derived";
	// The two halves of a derived key, hashed. When two requests land on different sessions this
	// shows which half moved: the client, or the message the key is anchored to.
	res.sessionNote =
		`session=${fingerprint(sessionId)} source=${source} new=${isNew}` +
		` key=${(req.credential?.name ?? "open").replace(/\s+/g, "_")}` +
		` msgs=${messages.length} roles=${messages.map((m) => String(m?.role ?? "?")[0]).join("")}` +
		` client=${fingerprint(clientFingerprint(req, body))} seed=${fingerprint(firstUserSeed(body) || "none")}`;
	// A request rejected before it ever runs must not leave an agent behind, or every retry
	// of a bad request adds a zombie row that lingers for the whole idle timeout.
	// ponytail: the spawn has already happened by this point, so this wastes one create on
	// an error path rather than reordering acquire around the awaits, which would let two
	// concurrent requests for the same new id each build their own conversation state.
	const discardIfNew = () => {
		if (!isNew) return;
		sessions.close(sessionId);
		res.sessionNote += " discarded";
	};
	const turn = nextTurn(messages, c.state);
	const prompt = turn.text;
	if (isReloadCommand(prompt)) {
		let text;
		try {
			text = await reloadSession(c);
		} catch (err) {
			return sendError(res, 500, `Reload failed: ${err?.message ?? err}`, "server_error", "server_error");
		}
		return sendTextReply(res, { id, created, modelName, text, stream: Boolean(body?.stream) });
	}
	const gatewayCommand = parseGatewayCommand(prompt);
	if (gatewayCommand) {
		let text;
		try {
			text = await runGatewayCommand(c, gatewayCommand);
		} catch (err) {
			text = `${gatewayCommand.name} failed: ${err?.message ?? err}`;
		}
		return sendTextReply(res, { id, created, modelName, text, stream: Boolean(body?.stream) });
	}
	if (turn.audio) {
		discardIfNew();
		return sendError(res, 400, "Audio input is not supported: Pi models accept text and image input only.", "invalid_request_error", "invalid_request_error");
	}
	// Checked here, after the gateway's own commands, so a key over its cap can still look at and
	// manage its profile; only a model call is refused. The bridge checks again before every call,
	// which is what stops a long agent run partway.
	const overSpend = spendRefusal(req.credential);
	if (overSpend) {
		discardIfNew();
		return sendError(res, 429, overSpend, "spend_limit_exceeded", "rate_limit_error");
	}
	let images;
	try {
		images = await resolveImages(turn.images);
	} catch (err) {
		discardIfNew();
		return sendError(res, 400, err?.message ?? String(err), "invalid_request_error", "invalid_request_error");
	}
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});

	let firstSession;
	try {
		firstSession = await c.sessionPromise;
	} catch (err) {
		// The agent never started — no bubblewrap, a broken image, a limit systemd refused. That is
		// the gateway's problem, not the request's, and the record is dropped so a retry starts fresh.
		sessions.close(sessionId);
		return sendError(res, 503, `the session's sandbox failed to start: ${err?.message ?? err}`, "sandbox_unavailable", "server_error");
	}
	const before = firstSession.getSessionStats().tokens;

	if (body?.stream) {
		const chunk = (delta, extra = {}) =>
			`data: ${JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created,
				model: modelName,
				choices: [{ index: 0, delta, finish_reason: null }],
				...extra,
			})}\n\n`;

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(chunk({ role: "assistant", content: "" }));

		let failed = null;
		try {
			if (!prompt && !images.length) {
				const session = await c.sessionPromise;
				const cached = session.getLastAssistantText?.() ?? "";
				if (cached) res.write(chunk({ content: cached }));
			} else {
				await runPrompt(c, prompt, {
					signal: controller.signal,
					body,
					images,
					context: turn.context,
					onDelta: (delta) => res.write(chunk({ content: delta })),
					onThinking: (delta) => res.write(chunk({ reasoning_content: delta })),
				});
			}
		} catch (err) {
			failed = err?.message ?? String(err);
		}

		if (!controller.signal.aborted) {
			const settled = await c.sessionPromise;
			const after = settled.getSessionStats().tokens;
			const usage = usageDelta(before, after);
			if (failed) {
				res.write(`data: ${JSON.stringify({ error: { message: failed, type: "server_error" } })}\n\n`);
			} else {
				res.write(
					`data: ${JSON.stringify({
						id,
						object: "chat.completion.chunk",
						created,
						model: modelName,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\n`,
				);
				if (body?.stream_options?.include_usage) {
					res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: modelName, choices: [], usage })}\n\n`);
				}
			}
			res.write("data: [DONE]\n\n");
		}
		return res.end();
	}

	let text = "";
	let reasoning = "";
	let failed = null;
	try {
		if (prompt || images.length) {
			const out = await runPrompt(c, prompt, {
				signal: controller.signal,
				body,
				images,
				context: turn.context,
				onDelta: (d) => (text += d),
				onThinking: (d) => (reasoning += d),
			});
			reasoning = out.reasoning;
		} else {
			const session = await c.sessionPromise;
			text = session.getLastAssistantText?.() ?? "";
		}
	} catch (err) {
		failed = err?.message ?? String(err);
	}

	if (failed) return sendError(res, 500, failed, "server_error", "server_error");
	const settled = await c.sessionPromise;
	const after = settled.getSessionStats().tokens;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			id,
			object: "chat.completion",
			created,
			model: modelName,
			choices: [
				{
					index: 0,
					// Present only when the model actually reasoned, so a non-reasoning turn is unchanged.
					message: { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
					finish_reason: "stop",
				},
			],
			usage: usageDelta(before, after),
		}),
	);
}

// ------------------------------------------------------------- profile API
//
// /v1/piper/profile/* lets a key manage its own profile over HTTP: the same operations as the chat
// commands, for a client or script. The key presenting the request is the profile it reaches;
// there is no way to name another. Every change is followed by a reload of that key's live
// sessions, so it applies to chats already open.

/** Read a request body as text, within the same limit as JSON bodies. */
function readText(req, limit = config.BODY_LIMIT) {
	return new Promise((resolvePromise, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				req.destroy();
				reject(new ProfileError("Request body too large", 413));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** A body that may be JSON or plain text, parsed by its content type. */
async function readBody(req) {
	const text = await readText(req);
	if (!/json/i.test(req.headers["content-type"] ?? "")) return { text };
	try {
		return { json: JSON.parse(text || "{}") };
	} catch {
		throw new ProfileError("Malformed JSON body");
	}
}

/** Re-read resources in every live session of a key, so a profile change applies to open chats. */
async function reloadKeySessions(keyId) {
	const records = sessions.recordsByKey(keyId);
	await Promise.all(
		records.map(async (c) => {
			const session = await c.sessionPromise.catch(() => null);
			if (session instanceof PiRpcSession && session.alive) await reloadSession(c).catch(() => {});
		}),
	);
	return records.length;
}

async function profileRoutes(req, res, path) {
	const keyId = req.credential ? req.credential.id : null;
	const rest = path.slice("/v1/piper/profile".length);
	const segments = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
	const send = (status, value) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(value));
	};
	const changed = async (result) => send(200, { ...result, reloadedSessions: await reloadKeySessions(keyId) });
	try {
		const [kind, name] = segments;
		const method = req.method;
		if (!kind && method === "GET") {
			const scope = profileScope(keyId);
			const summary = await profileOp(keyId, { op: "summary" });
			const { writable, reason } = profileWritability(keyId, join(profileRoot(), scope));
			return send(200, { ...summary, writable, readOnlyReason: reason || undefined, locked: isProfileLocked(scope) });
		}
		if (kind === "reset" && !name && method === "POST") {
			const { json } = await readBody(req);
			if (json?.confirm !== true) throw new ProfileError('send {"confirm": true} to reset: it replaces every skill, extension and setting on this key');
			return send(200, resetProfile(keyId));
		}
		if (kind === "settings" && !name) {
			if (method === "GET") return send(200, await profileOp(keyId, { op: "settings.get" }));
			if (method === "PUT" || method === "PATCH") {
				const { json } = await readBody(req);
				if (!json) throw new ProfileError("send settings as application/json");
				const op = method === "PUT" ? { op: "settings.put", settings: json } : { op: "settings.patch", set: json.set ?? {}, unset: json.unset ?? [] };
				return changed({ settings: await profileOp(keyId, op) });
			}
		}
		if (kind === "skills") {
			if (!name && method === "GET") return send(200, await profileOp(keyId, { op: "skills.list" }));
			if (name && segments.length === 2) {
				if (method === "GET") return send(200, await profileOp(keyId, { op: "skills.get", name }));
				if (method === "DELETE") return changed(await profileOp(keyId, { op: "skills.delete", name }));
				if (method === "PUT") {
					// Either a bare SKILL.md, or {"files": {"SKILL.md": ..., "scripts/run.sh": ...}} for a skill
					// with supporting files.
					const { json, text } = await readBody(req);
					const files = json ? json.files : { "SKILL.md": text };
					return changed(await profileOp(keyId, { op: "skills.put", name, files }));
				}
			}
		}
		if (kind === "extensions") {
			if (!name && method === "GET") return send(200, await profileOp(keyId, { op: "extensions.list" }));
			if (name && segments.length === 2) {
				if (method === "GET") return send(200, await profileOp(keyId, { op: "extensions.get", name }));
				if (method === "DELETE") return changed(await profileOp(keyId, { op: "extensions.delete", name }));
				if (method === "PUT") {
					const { json, text } = await readBody(req);
					const content = json ? json.content : text;
					return changed(await profileOp(keyId, { op: "extensions.put", name, content }));
				}
			}
		}
		return sendError(res, 404, `Unknown profile route: ${method} ${path}`, "not_found");
	} catch (err) {
		if (err instanceof ProfileError) return sendError(res, err.status, err.message, err.status === 423 ? "profile_locked" : "invalid_request_error");
		throw err;
	}
}

/** The key id a profile scope belongs to, the inverse of profileScope. */
export function keyIdForScope(scope) {
	if (scope === "open") return null;
	if (scope === "settings") return "";
	return scope.startsWith("key-") ? scope.slice(4) : undefined;
}

/** Every profile on disk, for the dashboard: sizes and names from lstat, never file contents. */
function profilesPayload() {
	const root = profileRoot();
	let scopes = [];
	try {
		scopes = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
	} catch {
		/* no profiles yet */
	}
	// Who gets each bundle: every key by name, plus the open gateway when no key exists yet.
	const holders = [...apiKeys.list().map((k) => ({ id: k.id, name: k.name })), ...(apiKeys.count() ? [] : [{ id: null, name: keyLabel(null) }])];
	return {
		runner: config.RUNNER,
		maxBytes: config.PROFILE_MAX_BYTES,
		shared: {
			root: sharedRoot(),
			defaultBundles: config.SHARED_BUNDLES,
			bundles: listBundles().map((b) => ({
				name: b.name,
				...bundleContents(b.path),
				keys: holders.filter((h) => grantedBundles(h.id).some((g) => g.name === b.name)).map((h) => h.name),
			})),
		},
		profiles: scopes.map((scope) => {
			const keyId = keyIdForScope(scope);
			const dir = join(root, scope);
			const stats = profileStats(dir);
			const { writable, reason } = profileWritability(keyId, dir);
			return {
				scope,
				key: keyId === undefined ? "(unknown)" : keyLabel(keyId),
				bytes: stats.bytes,
				filesBytes: treeSize(join(keyFilesRoot(), scope)),
				skills: stats.skills,
				extensions: stats.extensions,
				locked: isProfileLocked(scope),
				writable,
				readOnlyReason: reason,
				liveSessions: keyId === undefined ? 0 : sessions.recordsByKey(keyId).length,
			};
		}),
	};
}

/**
 * Where a loaded tool or command came from, judged by its source path inside the sandbox: the key's
 * own profile, a shared bundle, the chat's workspace, the gateway's bridge, or Pi itself.
 */
export function originOf(path) {
	const p = String(path ?? "");
	if (p.startsWith(`${SANDBOX_PATHS.profile}/`)) return "own";
	const bundle = new RegExp(`^${SANDBOX_PATHS.shared}/([^/]+)/`).exec(p);
	if (bundle) return `shared: ${bundle[1]}`;
	if (p.startsWith(`${SANDBOX_PATHS.workspace}/`)) return "workspace";
	if (p.startsWith("/opt/piper/")) return "gateway";
	return "built-in";
}

/**
 * Everything one key's agents get, for the dashboard: what the user put in their own profile, what
 * each granted bundle adds, and — when one of the key's agents is running — exactly what it has
 * loaded, tools included. Nothing is created: a key that has never chatted has no profile yet.
 */
export async function profileDetail(scope) {
	const keyId = keyIdForScope(scope);
	if (keyId === undefined) return null;
	const dir = join(profileRoot(), scope);
	const created = existsSync(dir);
	if (!created && keyId && !apiKeys.get(keyId)) return null;
	let own = null;
	let ownError = null;
	if (created) {
		try {
			own = await profileOp(keyId, { op: "inventory" });
		} catch (err) {
			ownError = err?.message ?? String(err);
		}
	}
	const bundles = grantedBundles(keyId).map((b) => ({ name: b.name, ...inventory(b.path) }));
	const records = sessions.recordsByKey(keyId);
	const agent = records.map((r) => r.session).find((sess) => sess instanceof PiRpcSession && sess.alive);
	let live = null;
	if (agent) {
		const answer = await agent.inventory();
		live = answer
			? {
					tools: answer.tools.map((t) => ({ ...t, origin: originOf(t.path), active: (answer.active ?? []).includes(t.name) })),
					commands: answer.commands.filter((c) => !c.name.startsWith("piper-")).map((c) => ({ ...c, origin: originOf(c.path) })),
				}
			: { error: "the running agent did not answer in time" };
	}
	const state = created ? profileWritability(keyId, dir) : { writable: true, reason: "" };
	const filesDir = join(keyFilesRoot(), scope);
	const files = keyFilesStats(filesDir);
	if (files.created) {
		const fs = keyFilesWritability(filesDir);
		files.writable = fs.writable;
		files.readOnlyReason = fs.reason;
	}
	files.maxBytes = config.KEY_FILES_MAX_BYTES;
	return {
		scope,
		files,
		key: keyLabel(keyId),
		created,
		locked: isProfileLocked(scope),
		writable: state.writable,
		readOnlyReason: state.reason,
		bytes: own?.bytes ?? 0,
		maxBytes: config.PROFILE_MAX_BYTES,
		own,
		ownError,
		bundles,
		liveSessions: records.length,
		live,
	};
}

async function profileAdminRoutes(req, res, path) {
	const send = (status, value) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(value));
	};
	if (req.method === "GET" && path === "/dashboard/profiles.json") return send(200, profilesPayload());
	const detailMatch = /^\/dashboard\/profiles\/([A-Za-z0-9_-]+)\.json$/.exec(path);
	if (req.method === "GET" && detailMatch) {
		const detail = await profileDetail(detailMatch[1]);
		return detail ? send(200, detail) : sendError(res, 404, `No profile ${detailMatch[1]}`, "not_found");
	}
	const match = /^\/dashboard\/profiles\/([A-Za-z0-9_-]+)\/(lock|reset)$/.exec(path);
	if (!match || req.method !== "POST") return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	const [, scope, action] = match;
	const keyId = keyIdForScope(scope);
	if (keyId === undefined || !existsSync(join(profileRoot(), scope))) return sendError(res, 404, `No profile ${scope}`, "not_found");
	if (action === "lock") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body");
		}
		setProfileLock(scope, Boolean(body.locked));
		// A running sandbox keeps the mount it started with, so a lock only binds once its sessions
		// are gone. Closing them makes the lock take effect now rather than at the next reap.
		const closed = body.locked ? sessions.closeByKey(keyId) : 0;
		return send(200, { ...profilesPayload(), closed });
	}
	try {
		const result = resetProfile(keyId);
		return send(200, { ...profilesPayload(), ...result });
	} catch (err) {
		if (err instanceof ProfileError) return sendError(res, err.status, err.message);
		throw err;
	}
}

// ---------------------------------------------------------------- dashboard

// Read once at startup so a missing page fails fast, then re-read per request so editing
// dashboard.html is live — no restart. A bad save falls back to the last good copy.
let dashboardHtml = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
const LOGIN_PAGE = `<!doctype html>
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
async function dashboardLogin(req, res) {
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
async function dashboardSetPassword(req, res) {
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

/**
 * The limits that apply to a credential. A key's own setting wins over the gateway default; 0 means
 * unlimited either way. GATEWAY_API_KEY is the operator's own credential, so it is never limited.
 */
export function keyLimits(credential, defaults = { maxSessions: config.KEY_MAX_SESSIONS, dailySpend: config.KEY_DAILY_SPEND_USD }) {
	if (credential && credential.id === "") return { maxSessions: 0, dailySpend: 0 };
	const record = credential?.id ? apiKeys.get(credential.id) : null;
	return {
		maxSessions: record?.maxSessions ?? defaults.maxSessions ?? 0,
		dailySpend: record?.dailySpend ?? defaults.dailySpend ?? 0,
	};
}

/** Local midnight, the start of "today" for spend limits, matching the Spend page. */
function startOfToday(now = Date.now()) {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	return midnight.getTime();
}

/**
 * What a key has spent today: the ledger rows closed since midnight, plus what its live sessions
 * have run up so far. Both come from the gateway's own metering, never from a sandbox's report.
 */
export function spentToday(keyId) {
	const row = db
		.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM spend WHERE closed_at >= ? AND key_id IS ?")
		.get(startOfToday(), keyId ?? null);
	let live = 0;
	for (const record of sessions.recordsByKey(keyId)) live += Number(record.session?.getSessionStats?.().cost) || 0;
	return Number(row.cost) + live;
}

/** Why a key may not make another model call today, or null while it is under its cap. */
export function spendRefusal(credentialOrKeyId) {
	const credential = typeof credentialOrKeyId === "object" ? credentialOrKeyId : credentialOrKeyId === undefined ? null : { id: credentialOrKeyId };
	const { dailySpend } = keyLimits(credential);
	if (!(dailySpend > 0)) return null;
	const spent = spentToday(credential?.id ?? null);
	if (spent < dailySpend) return null;
	return `daily spend limit reached: $${spent.toFixed(4)} of $${dailySpend.toFixed(2)} spent today on this key; it resets at local midnight`;
}

function apiKeysPayload() {
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
			bundles: grantedBundles(r.id).map((b) => b.name),
		})),
		defaults: { maxSessions: config.KEY_MAX_SESSIONS, dailySpend: config.KEY_DAILY_SPEND_USD, sharedBundles: config.SHARED_BUNDLES },
	};
}

function keyStatus(keyId) {
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
async function apiKeyRoutes(req, res, path) {
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
		const { record, key } = apiKeys.create({ name, expiresAt });
		// The one and only time the key appears in a response — it is not stored, so it cannot be shown again.
		return json(201, { ...apiKeysPayload(), key, createdId: record.id });
	}

	const match = rest.match(/^\/([0-9a-fA-F-]{36})(\/revoke)?$/);
	if (!match) return sendError(res, 404, `Unknown API key route: ${req.method} ${path}`, "not_found");
	const id = match[1];
	if (!apiKeys.get(id)) return sendError(res, 404, "No such key", "not_found");

	if (req.method === "DELETE") {
		apiKeys.remove(id);
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
		} catch (err) {
			return sendError(res, 400, err.message);
		}
		apiKeys.update(id, patch);
		return json(200, { ...apiKeysPayload(), updated: id });
	}
	return sendError(res, 404, `Unknown API key route: ${req.method} ${path}`, "not_found");
}

function dashboardPage() {
	try {
		dashboardHtml = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
	} catch {
		/* keep serving the last good copy */
	}
	return dashboardHtml;
}

// ------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
	cors(res);
	res.on("finish", () => logAccess(req, res.statusCode, res.sessionNote));
	try {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		const path = new URL(req.url, "http://localhost").pathname;
		if (req.method === "GET" && (path === "/health" || path === "/")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ status: "ok", cwd: agentCwd(), sessions: sessions.stats() }));
		}
		// The dashboard has its own guard, so an unauthenticated browser gets a sign-in page it can
		// answer instead of a 401 it cannot. /v1/* keeps the API key check to itself.
		const isDashboard = isDashboardPath(path);
		// Resolved once, so the log line and the session record both know which key was used.
		req.credential = credentialOf(req);
		if (!isDashboard && authRequired() && !req.credential) {
			return sendError(res, 401, "Invalid API key", "invalid_api_key", "authentication_error");
		}
		if (req.method === "POST" && path === "/dashboard/login") return await dashboardLogin(req, res);
		if (req.method === "POST" && path === "/dashboard/logout") {
			clearSessionCookie(res);
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify({ ok: true }));
		}
		if (isDashboard && !dashboardAuthorized(req)) {
			// The page itself invites a sign-in; every other route says why it refused.
			if (req.method === "GET" && path === "/dashboard") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				return res.end(LOGIN_PAGE);
			}
			return sendError(res, 401, "Dashboard is locked", "dashboard_locked", "authentication_error");
		}
		if (req.method === "POST" && path === "/dashboard/password") return await dashboardSetPassword(req, res);
		if (path.startsWith("/dashboard/api-keys")) return await apiKeyRoutes(req, res, path);
		if (path === "/dashboard/profiles.json" || path.startsWith("/dashboard/profiles/")) return await profileAdminRoutes(req, res, path);
		if (req.method === "GET" && path === "/dashboard/models.json") return await modelCatalog(res);
		if (req.method === "GET" && path === "/dashboard/spend.json") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(await spendReport()));
		}
		if (req.method === "GET" && path === "/dashboard/settings.json") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(settingsPayload()));
		}
		if (req.method === "POST" && path === "/dashboard/settings") {
			let result;
			try {
				const body = await readJson(req);
				result = await saveSettings(body.settings ?? {});
			} catch (err) {
				// Validation failures are the client's fault, so report them as such.
				return sendError(res, 400, err?.message ?? String(err), "invalid_request_error", "invalid_request_error");
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ ...settingsPayload(), ...result }));
		}
		if (req.method === "GET" && path === "/dashboard.json") {
			const snapshot = await sessions.snapshot();
			// The page polls this anyway, so the sidebar learns for free whether to offer a sign-out.
			snapshot.passwordSet = Boolean(dashboardHash);
			// The sandbox is a switch, and a switch that is off fails silently: a session then reads the
			// whole filesystem, including this gateway's own database. The page shows that state loudly.
			// The sandboxed runners are always confined; only the in-process runner depends on the jail.
			const inProcess = config.RUNNER === "inprocess";
			snapshot.runner = config.RUNNER;
			snapshot.jail = !inProcess || Boolean(config.WORKSPACE_JAIL);
			snapshot.jailNote = !snapshot.jail
				? "WORKSPACE_JAIL is off, so sessions run unsandboxed: bash is not confined and the file " +
					"tools are not path-checked. An agent can read this gateway's database and your home directory."
				: "";
			// A sandbox without limits can take the whole machine's memory or processes with it.
			const limiter = config.RUNNER === "bwrap" ? sandboxLimiter() : null;
			snapshot.limitsNote =
				limiter && (limiter.error || limiter.note?.startsWith("none"))
					? `${limiter.error ?? "systemd scopes are unavailable here"}, so one session can use all of this machine's memory, processes and CPU. Run under systemd, or use a container runner.`
					: "";
			snapshot.runnerNote = inProcess
				? "RUNNER is inprocess: every session shares this gateway's process and your ~/.pi/agent, and the file " +
					"tools are guarded by a path check rather than a sandbox. Use it only for yourself."
				: "";
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(snapshot));
		}
		if (req.method === "DELETE" && path.startsWith("/dashboard/session/")) {
			const closed = sessions.closeByFingerprint(path.slice("/dashboard/session/".length));
			res.writeHead(closed ? 200 : 404, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ closed }));
		}
		if (req.method === "POST" && path === "/dashboard/kill-all") {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ closed: sessions.closeAll() }));
		}
		if (req.method === "GET" && path === "/dashboard") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(dashboardPage());
		}
		if (req.method === "GET" && path === "/v1/models") return await listModels(res);
		if (path === "/v1/piper/profile" || path.startsWith("/v1/piper/profile/")) return await profileRoutes(req, res, path);
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			return await chatCompletions(req, res, await readJson(req));
		}
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 500, err?.message ?? String(err), "server_error", "server_error");
	}
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
/**
 * Why the gateway should not start as root, or null when it may.
 *
 * The sandbox holds without root privileges, but as root its user namespace maps back to uid 0, so
 * anything root-owned that the masks miss is readable by the session that owns it. A dedicated
 * unprivileged user is what makes "the masks missed a path" a non-event rather than a leak.
 */
export function rootRefusal(uid = process.getuid?.(), env = process.env) {
	if (uid !== 0) return null;
	if (/^(1|true|yes|on)$/i.test(String(env.ALLOW_ROOT ?? ""))) return null;
	return (
		"refusing to run as root: sessions run commands on your behalf, and as root anything the sandbox " +
		"fails to mask is readable by them. Run as a dedicated user, or set ALLOW_ROOT=1 to accept the risk.\n"
	);
}

if (isMain) {
	const refusal = rootRefusal();
	if (refusal) {
		process.stderr.write(refusal);
		process.exit(1);
	}
	server.listen(config.PORT, config.HOST, () => {
		process.stderr.write(
			`Piper on http://${config.HOST}:${config.PORT}  cwd=${agentCwd()}  ` +
				`auth=${authNote()}  ` +
				`dashboard=${dashboardHash ? "password" : "open"}  ` +
				`runner=${config.RUNNER}  ` +
				`${config.RUNNER === "bwrap" ? `limits=${sandboxLimiter().note ?? "unavailable"}  ` : ""}` +
				`jail=${config.RUNNER !== "inprocess" || config.WORKSPACE_JAIL ? "on" : "OFF"}  sandbox-net=${config.SANDBOX_NETWORK}  ` +
				`${process.getuid?.() === 0 ? "user=ROOT  " : ""}db=${GATEWAY_DB}\n`,
		);
	});
}
