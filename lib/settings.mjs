/** Settings: the database, the settings spec and the live `config` every other module reads. */
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseSandboxEnv } from "./sandbox.mjs";

export const GATEWAY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Gateway settings live in SQLite via node:sqlite (built in, no dependency). GATEWAY_DB is the
// one thing that must stay an environment variable, because the database cannot record where it
// lives. Every other knob is seeded from its environment variable on first run, then the stored
// row is authoritative — so editing it in the dashboard sticks and the env var stops mattering.

export const GATEWAY_DB = process.env.GATEWAY_DB ?? fileURLToPath(new URL("../gateway.db", import.meta.url));

export const SETTINGS_SPEC = [
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
	{ key: "FILE_UPLOAD_MAX_BYTES", group: "Limits", type: "int", def: 1024 * 1024 * 1024, min: 0,
	  help: "Largest single file that can be uploaded into a key's shared folder over /v1/piper/files or the dashboard, in bytes. 0 means no limit beyond the folder's own." },
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
	{ key: "KEY_ALLOWED_MODELS", group: "Limits", type: "text", def: "", validate: (text) => void parseModelPatterns(text),
	  help: "Models every API key may use, as provider/model patterns separated by commas, with * matching anything: local-openai/*, github-copilot/gpt-5-mini. Empty allows every model. A key can have its own list, set in its detail view on the Profiles page. GATEWAY_API_KEY may always use every model." },
	{ key: "SANDBOX_LIMITS", group: "Limits", type: "enum", options: ["auto", "systemd", "off"], def: "auto",
	  help: "How sandboxed sessions are held to the memory, process and CPU limits below. systemd runs each in its own systemd scope (a cgroup); auto does that when systemd-run works here and runs unlimited otherwise; off never limits. Containers use the engine's own flags whatever this says." },
	{ key: "SANDBOX_MEMORY_MB", group: "Limits", type: "int", def: 2048, min: 0,
	  help: "Memory for one sandboxed session, everything it runs included. Past it the kernel kills processes inside that sandbox only. 0 means no limit." },
	{ key: "SANDBOX_PIDS", group: "Limits", type: "int", def: 512, min: 0,
	  help: "Processes and threads one sandboxed session may run at once, so a fork bomb stays inside its own sandbox. 0 means no limit." },
	{ key: "SANDBOX_CPUS", group: "Limits", type: "float", def: 2, min: 0,
	  help: "CPU cores one sandboxed session may use, e.g. 0.5 or 2. 0 means no limit." },
	{ key: "STREAM_TOOL_ACTIVITY", group: "Sessions", type: "bool", def: false,
	  help: "Show what the agent is doing — each tool it runs, with its command or file — in the reply's reasoning stream (reasoning_content), which clients such as Open WebUI show as \"Thinking\". Off keeps reasoning to the model's own thoughts. Applies from the next request." },
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

export const specByKey = new Map(SETTINGS_SPEC.map((spec) => [spec.key, spec]));
export const config = {};

export const DURATION_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

/**
 * A model allow-list as regular expressions: comma-separated `provider/model` patterns where `*`
 * matches anything. Empty means no restriction. A pattern must name a provider and a model, so a
 * typo like "gpt-5" is refused rather than silently matching nothing.
 */
export function parseModelPatterns(text) {
	const parts = String(text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
	return parts.map((p) => {
		if (!/^[^/\s]+\/\S+$/.test(p) && p !== "*") throw new Error(`"${p}" is not a provider/model pattern (e.g. local-openai/* or github-copilot/gpt-5-mini)`);
		return new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	});
}

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

export function serializeSetting(spec, value) {
	return spec.type === "bool" ? (value ? "1" : "0") : String(value);
}

export const db = new DatabaseSync(GATEWAY_DB);
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
export const keyColumns = new Set(db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name));
if (!keyColumns.has("max_sessions")) db.exec("ALTER TABLE api_keys ADD COLUMN max_sessions INTEGER");
if (!keyColumns.has("daily_spend")) db.exec("ALTER TABLE api_keys ADD COLUMN daily_spend REAL");
if (!keyColumns.has("shared_bundles")) db.exec("ALTER TABLE api_keys ADD COLUMN shared_bundles TEXT");
if (!keyColumns.has("allowed_models")) db.exec("ALTER TABLE api_keys ADD COLUMN allowed_models TEXT");
// Profiles an operator has frozen: mounted read-only in every sandbox, and refused by the profile API.
db.exec("CREATE TABLE IF NOT EXISTS profile_locks (scope TEXT PRIMARY KEY, locked_at INTEGER NOT NULL)");
// Chats that can be resumed: a restart or an eviction stops the agent's process but keeps its
// workspace and Pi session, and the next message continues it. The client's session id is a bearer
// secret, so only its hash is stored.
db.exec(
	"CREATE TABLE IF NOT EXISTS chats (id_hash TEXT PRIMARY KEY, key_id TEXT, workspace TEXT NOT NULL, " +
		"created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, requests INTEGER NOT NULL, state_json TEXT NOT NULL)",
);
// One-time jobs the gateway has already run, by name.
db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
// The ledger shipped without a key column, so add it only where it is missing.
export const spendColumns = new Set(db.prepare("PRAGMA table_info(spend)").all().map((c) => c.name));
if (!spendColumns.has("key_id")) db.exec("ALTER TABLE spend ADD COLUMN key_id TEXT");
// The file holds GATEWAY_API_KEY when one is set, so keep it owner-only.
try {
	chmodSync(GATEWAY_DB, 0o600);
} catch {
	/* best effort: some filesystems do not support it */
}

/** Seed any missing key from its env var (or default), then load every key into `config`. */
export function loadSettings() {
	// STREAM_TOOL_ACTIVITY was briefly a choice of "reasoning" or "off"; it is now on/off and off by
	// default, so the old value is dropped and seeded afresh.
	db.prepare("DELETE FROM settings WHERE key = 'STREAM_TOOL_ACTIVITY' AND value NOT IN ('0', '1')").run();
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

/** The agent workspace: an empty PI_CWD means the process working directory. */
export function agentCwd() {
	return config.PI_CWD || process.cwd();
}
