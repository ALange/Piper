/** Settings: the database, the settings spec and the live `config` every other module reads. */
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseContainerEnv, parseContainerMounts } from "./paths.mjs";
import { parseAllow } from "./containerpi.mjs";

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
	{ key: "GATEWAY_API_KEY", group: "Security", type: "secret", def: "", sensitive: true,
	  help: "When set, every request must send Authorization: Bearer <key>." },
	{ key: "DASHBOARD_SESSION_MS", group: "Access Control", type: "duration", def: 12 * 60 * 60 * 1000, min: 0,
	  help: "How long a dashboard sign-in lasts. 0 keeps it until the browser closes. Changing the password ends every session regardless." },
	{ key: "MAX_SESSIONS", group: "Sessions", type: "int", def: 128, min: 1, max: 100000,
	  help: "Cap on live agents. Past it, the least-recently-used session is disposed." },
	{ key: "SESSION_MAX_LIFETIME_MS", group: "Sessions", type: "duration", def: 86400000, min: 0,
	  help: "The longest one Pi process runs before it is stopped, counted from when it started (a resumed chat counts again from its resume). Stopping frees the memory and keeps the container, so the next message resumes the chat where it was. It does not end the chat: see CHAT_KEEP_MS." },
	{ key: "SESSION_IDLE_MS", group: "Sessions", type: "duration", def: 600000, min: 0,
	  help: "Stop a running chat after this long without a request. Its container is stopped, not removed, so what was installed in it survives and the next message resumes it." },
	{ key: "CHAT_KEEP_MS", group: "Sessions", type: "duration", def: 30 * 24 * 60 * 60 * 1000, min: 0,
	  help: "How long a stopped chat's container and Pi session are kept after its last message. Past it the chat ends: the container is removed with everything installed in it (the workspace stays). 0 keeps them for ever." },
	{ key: "ONE_SHOT_TTL_MS", group: "Sessions", type: "duration", def: 120000, min: 0,
	  help: "End a session used exactly once and then quiet this long (titles, summaries). Its container is removed. 0 disables it." },
	{ key: "BODY_LIMIT", group: "Limits", type: "int", def: 32 * 1024 * 1024, min: 1024,
	  help: "Largest accepted request body, in bytes." },
	{ key: "MAX_IMAGE_BYTES", group: "Limits", type: "int", def: 20 * 1024 * 1024, min: 1024,
	  help: "Largest image the gateway will fetch and forward, in bytes." },
	{ key: "ALLOW_IMAGE_URLS", group: "Limits", type: "bool", def: false,
	  help: "Let clients send http(s) image URLs for the gateway to fetch. Off means data: URIs only. When on, addresses on loopback, private, link-local and metadata ranges are still refused." },
	{ key: "PI_AGENT_PACKAGE", group: "Agent", type: "text", def: "", restart: true,
	  help: "Path to the pi-coding-agent package when it cannot be resolved automatically." },
	{ key: "PROFILE_ROOT", group: "Agent", type: "text", def: join(GATEWAY_DIR, "profiles"),
	  help: "Each API key gets a persistent Pi profile (skills, extensions, prompts, settings) under this root, mounted at /profile in its chats' containers." },
	{ key: "PROFILE_TEMPLATE", group: "Agent", type: "text", def: "",
	  help: "A directory copied into a key's profile the first time it is created, e.g. a curated set of skills. Empty starts profiles with only your default model." },
	{ key: "SHARED_ROOT", group: "Agent", type: "text", def: join(GATEWAY_DIR, "shared"),
	  help: "Folder of shared bundles. Each subfolder is a bundle laid out like a Pi package — skills/, extensions/, prompts/ — mounted read-only into the containers of the keys it is granted to. Users cannot change a bundle, but see edits to it on their next /reload." },
	{ key: "SHARED_BUNDLES", group: "Agent", type: "text", def: "base",
	  help: "Bundles every key gets unless it has its own list: comma-separated bundle names, * for all of them, or empty for none. A key's own list is set on the API Management page." },
	{ key: "FILE_UPLOAD_MAX_BYTES", group: "Limits", type: "int", def: 1024 * 1024 * 1024, min: 0,
	  help: "Largest single file that can be uploaded into a key's workspace over /v1/piper/files or the dashboard, in bytes. 0 means no limit beyond the workspace's own." },
	{ key: "WORKSPACE_MAX_BYTES", group: "Limits", type: "int", def: 0, min: 0,
	  help: "Largest a key's workspace may grow to, in bytes. Past it, new chats get the workspace read-only until it is trimmed. 0 means no limit." },
	{ key: "PROFILE_MAX_BYTES", group: "Agent", type: "int", def: 100 * 1024 * 1024, min: 0,
	  help: "Largest a key's profile may grow to, in bytes. Uploads past it are refused, and a profile already over it is mounted read-only until it is trimmed. 0 means no limit." },
	{ key: "CONTAINER_IMAGE", group: "Containers", type: "text", def: "piper-agent",
	  help: "The image every chat's container starts from, built with ./piper.sh image. Changing it recreates a chat's container on its next start; what the agent installed in the old one is lost, its workspace, profile and session are not." },
	{ key: "CONTAINER_NETWORK", group: "Containers", type: "enum", options: ["internet", "none", "open"], def: "internet",
	  help: "What a container can reach. internet: the internet, but not this machine (so not the gateway or dashboard), not your LAN, not cloud metadata addresses, and not other containers; the gateway installs the firewall rules for that, and refuses to start chats if it cannot. none: no network at all. open: the network with no rules, so a container can reach this machine and your LAN, which includes this dashboard; set a dashboard password first. Applies to a chat's next start." },
	{ key: "CONTAINER_ALLOW", group: "Containers", type: "text", def: "", validate: (text) => void parseAllow(text, { strict: true }),
	  help: "Private-network endpoints containers may reach even under internet, as host or host:port separated by spaces, e.g. 192.168.1.50:4000. The endpoints of the models in the container models.json are allowed automatically." },
	{ key: "CONTAINER_PI_DIR", group: "Containers", type: "text", def: join(GATEWAY_DIR, "container-pi"),
	  help: "Folder with the Pi configuration for containers: a models.json (models the containers' Pi calls directly, with their keys) and a settings.json (the default model). Separate from your own ~/.pi/agent. Edited on this page." },
	{ key: "CONTAINER_MOUNTS", group: "Containers", type: "text", def: "", validate: (text) => void parseContainerMounts(text, { strict: true }),
	  help: "Host folders to make visible, read-only, in every container, as host or host:container separated by spaces, e.g. /opt/tools. For tools that are not in the image. A folder that is or contains something protected (the gateway's folders, your ~/.pi/agent, /root's secrets, an engine socket) is refused. Applies to a chat's next start." },
	{ key: "KEY_MAX_SESSIONS", group: "Limits", type: "int", def: 16, min: 0,
	  help: "Live sessions one API key may hold at once. Past it, that key's least recently used idle session is closed; if all are busy the request is refused with 429. 0 means no limit. A key can override it on the API Management page." },
	{ key: "KEY_DAILY_SPEND_USD", group: "Limits", type: "float", def: 0, min: 0,
	  help: "Most one API key may spend per local day, in US dollars, counted from the gateway's own metering. Checked before every model call, so a long agent run stops when it crosses the line. 0 means no limit. A key can override it. GATEWAY_API_KEY is exempt." },
	{ key: "KEY_ALLOWED_MODELS", group: "Limits", type: "text", def: "", validate: (text) => void parseModelPatterns(text),
	  help: "Models every API key may use, as provider/model patterns separated by commas, with * matching anything: local-openai/*, github-copilot/gpt-5-mini. Empty allows every model. A key can have its own list, set in its detail view on the Profiles page. GATEWAY_API_KEY may always use every model." },
	{ key: "CONTAINER_MEMORY_MB", group: "Limits", type: "int", def: 2048, min: 0,
	  help: "Memory for one chat's container, everything in it included, with no swap. Past it the kernel kills processes in that container only. 0 means no limit." },
	{ key: "CONTAINER_PIDS", group: "Limits", type: "int", def: 512, min: 0,
	  help: "Processes and threads one chat's container may run at once, so a fork bomb stays inside it. 0 means no limit." },
	{ key: "CONTAINER_CPUS", group: "Limits", type: "float", def: 2, min: 0,
	  help: "CPU cores one chat's container may use, e.g. 0.5 or 2. 0 means no limit." },
	{ key: "STREAM_TOOL_ACTIVITY", group: "Sessions", type: "bool", def: false,
	  help: "Show what the agent is doing — each tool it runs, with its command or file — in the reply's reasoning stream (reasoning_content), which clients such as Open WebUI show as \"Thinking\". Off keeps reasoning to the model's own thoughts. Applies from the next request." },
	{ key: "SPEED_HISTORY_DAYS", group: "Logging", type: "int", def: 14, min: 0,
	  help: "How many days of model speed (prompt processing and generation, in tokens per second, per model) the Overview keeps. Only model names, token counts and times are stored, never the conversation. 0 keeps no history; the live figures per session still work." },
	{ key: "ACCESS_LOG", group: "Logging", type: "bool", def: true,
	  help: "Write one line per request to stderr." },
	{ key: "FALLBACK_MODEL", group: "Fallback", type: "model", def: "",
	  help: "provider/model to switch a session to when the active model fails with a quota or exhausted-retry error, e.g. opencode-go/deepseek-v4.1-flash. Empty disables fallback. Validated against the live catalogue." },
	{ key: "FALLBACK_MODE", group: "Fallback", type: "enum", options: ["session", "request", "cooldown"], def: "session",
	  help: "session: stay on the fallback until the session ends. request: try the primary again on the next request. cooldown: retry the primary once the cooldown below has passed." },
	{ key: "FALLBACK_COOLDOWN_MS", group: "Fallback", type: "duration", def: 300000, min: 0,
	  help: "How long to stay on the fallback before retrying the primary, in cooldown mode." },
	{ key: "CONTAINER_DISK_MB", group: "Containers", type: "int", def: 0, min: 0,
	  help: "Warn when one chat's container has written more than this to its own filesystem (what the agent installed and downloaded). It is a warning only; the workspace and profile have their own limits. 0 turns it off." },
	{ key: "DISK_FREE_WARN_MB", group: "Containers", type: "int", def: 5120, min: 0,
	  help: "Warn, on the dashboard and by alert, when the disk Docker keeps its data on has less than this much free. 0 turns it off." },
	{ key: "ALERT_WEBHOOK_URL", group: "Containers", type: "text", def: "", sensitive: true, validate: (text) => void parseWebhookUrl(text),
	  help: "A URL that gets a JSON POST when something needs a person: Docker unreachable, the firewall rules missing, low disk, a container killed for memory, a gateway that stopped answering (the watchdog installed by deploy.sh --systemd). The body has text and content fields, so Slack and Discord webhooks work as they are. Empty turns alerts off." },
	{ key: "TERMINAL_ENABLED", group: "Containers", type: "bool", def: true,
	  help: "Allow the dashboard's terminal: an interactive root shell in a running container (Terminal page, or the terminal button on the Containers page). It needs a dashboard password and every open and close is recorded in the audit log. Off refuses all terminals." },
	{ key: "TERMINAL_IDLE_MS", group: "Containers", type: "duration", def: 15 * 60 * 1000, min: 0,
	  help: "Close a terminal after this long without anything typed. 0 never closes an idle terminal." },
	{ key: "TERMINAL_MAX_SESSIONS", group: "Containers", type: "int", def: 4, min: 1, max: 64,
	  help: "How many terminals may be open at once, in all." },
	{ key: "LIVE_VIEW_ENABLED", group: "Containers", type: "bool", def: true,
	  help: "Allow the dashboard's live view of a running chat (what the agent is saying and doing, with an interrupt button and a transcript download). It shows conversations, so it needs a dashboard password; every watch and interrupt is recorded in the audit log. Off refuses all of it." },
	{ key: "EXPORT_MAX_BYTES", group: "Agent", type: "int", def: 20 * 1024 * 1024, min: 1024 * 1024, max: 64 * 1024 * 1024,
	  help: "The most an agent's exported profile (instructions, settings, skills, extensions, prompts) or an imported bundle may hold, in bytes. Larger ones are refused." },
	{ key: "TEMPLATE_MAX_BYTES", group: "Agent", type: "int", def: 5 * 1024 * 1024, min: 64 * 1024, max: 32 * 1024 * 1024,
	  help: "The most a saved agent template may hold, in bytes. A template is a copy of an agent's profile kept in the database." },
	{ key: "DELEGATE_ENABLED", group: "Agent", type: "bool", def: true,
	  help: "Let agents that are switched to delegate hand work to the other agents of the same key (the piper_delegate tool). Off removes the tools and refuses every hand-off. A hand-off is a whole turn on the other agent, counted against the key like any chat." },
	{ key: "DELEGATE_MAX_DEPTH", group: "Agent", type: "int", def: 3, min: 1, max: 8,
	  help: "How many hand-offs may be chained: an agent delegating to one that delegates again counts 2. An agent is never asked to work for itself or for anyone already in the chain." },
	{ key: "DELEGATE_TIMEOUT_MS", group: "Agent", type: "duration", def: 10 * 60 * 1000, min: 10_000,
	  help: "How long one hand-off may take before the calling agent is told it timed out and the colleague's turn is stopped." },
	{ key: "TEAM_MAX_STEPS", group: "Agent", type: "int", def: 6, min: 1, max: 20,
	  help: "The most steps a team (a chain of agents on its own endpoint) may have." },
	{ key: "PACKAGES_ENABLED", group: "Containers", type: "bool", def: true,
	  help: "Allow installing Pi packages and MCP servers into a key's or agent's profile from the dashboard (Profiles). They run third-party code in that agent's container, so it needs a dashboard password. Off refuses all of it." },
	{ key: "JOBS_ENABLED", group: "Jobs", type: "bool", def: true,
	  help: "Run jobs: scheduled and webhook-triggered runs of an agent, and asynchronous requests through POST /v1/piper/jobs. Off stops the scheduler and refuses new runs; what is queued stays." },
	{ key: "JOBS_MAX_PARALLEL", group: "Jobs", type: "int", def: 2, min: 1, max: 16,
	  help: "How many job runs may be going at once, in all. A run is a whole agent turn in its own container, so each uses memory and model quota." },
	{ key: "JOBS_MIN_INTERVAL_MS", group: "Jobs", type: "duration", def: 5 * 60 * 1000, min: 0,
	  help: "The least time between two webhook triggers of the same job (a faster one is answered 429). It stops a misbehaving caller from running an agent in a loop. 0 allows any rate." },
	{ key: "JOBS_MAX_PER_KEY", group: "Jobs", type: "int", def: 20, min: 1, max: 1000,
	  help: "How many runs one key may have waiting or running at once, counting its schedules, triggers and API submissions." },
	{ key: "JOBS_RESULT_DAYS", group: "Jobs", type: "int", def: 30, min: 1, max: 3650,
	  help: "How long a finished run and its result text are kept, in days." },
	{ key: "AGENT_PORT_RANGE", group: "Containers", type: "text", def: "", restart: true, validate: (text) => void parsePortRange(text),
	  help: "Where an agent endpoint's port is picked, as FROM-TO (e.g. 20000-29999), so a firewall can allow just that range. Blank lets the system choose any free port. A port is picked once, when the agent is created, and kept. Applies to agents created afterwards." },
	{ key: "AUDIT_AUTH", group: "Audit", type: "bool", def: true,
	  help: "Record dashboard sign-ins: successful and failed logins, sign-outs, the password being set, changed or cleared, with the address they came from." },
	{ key: "AUDIT_SETTINGS", group: "Audit", type: "bool", def: true,
	  help: "Record every settings change: which setting and old -> new. Secret ones (keys, webhook URL, environment variables) only say that they changed." },
	{ key: "AUDIT_KEYS", group: "Audit", type: "bool", def: true,
	  help: "Record API key create, revoke, delete and limit changes, profile locks and resets, sessions killed from the dashboard, and model reloads." },
	{ key: "AUDIT_OPERATIONS", group: "Audit", type: "bool", def: true,
	  help: "Record what is done to containers, images, agent endpoints and Pi: stop, recreate, update, commands run in a container, image builds, the host Pi update." },
	{ key: "AUDIT_RUNTIME", group: "Audit", type: "bool", def: true,
	  help: "Record things that happen by themselves: a container killed for memory or dead, Docker becoming unreachable or back, limits hit, model fallbacks, a sweep removing something, alerts sent." },
	{ key: "AUDIT_REQUESTS", group: "Audit", type: "bool", def: false,
	  help: "Record one line per chat request: key or agent, session fingerprint, model, status and time. Never the messages. Busy gateways write a lot; retention below keeps it bounded." },
	{ key: "AUDIT_AUTH_FAILURES", group: "Audit", type: "bool", def: false,
	  help: "Record API requests refused for a bad or missing key, one line per address per minute with a count." },
	{ key: "AUDIT_RETENTION_DAYS", group: "Audit", type: "int", def: 90, min: 0,
	  help: "Delete audit rows older than this many days. 0 keeps them for ever." },
	{ key: "AUDIT_MAX_ROWS", group: "Audit", type: "int", def: 50000, min: 0,
	  help: "Keep at most this many audit rows; the oldest go first. 0 means no limit." },
	{ key: "CONTAINER_ENV", group: "Containers", type: "text", def: "", sensitive: true, validate: (text) => void parseContainerEnv(text, { strict: true }),
	  help: "Environment variables to set for Pi in every container, as NAME=value separated by spaces. PATH, HOME, TERM, LANG and anything starting PI_ or PIPER_ are the gateway's and cannot be set here. Applies to a chat's next start." },
	{ key: "WORKSPACE_ROOT", group: "Containers", type: "text", def: join(GATEWAY_DIR, "workspaces"),
	  help: "Each API key gets one workspace under this root, mounted at /workspace in every one of that key's chats, so they share files and the agent's work outlasts any chat." },
	{ key: "ARCHIVE_TTL_MS", group: "Containers", type: "duration", def: 30 * 24 * 60 * 60 * 1000, min: 0,
	  help: "Delete archives (profiles that were reset, workspaces from before the move to containers) older than this. 0 keeps archives forever." },
];

export const specByKey = new Map(SETTINGS_SPEC.map((spec) => [spec.key, spec]));
export const config = {};

export const DURATION_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

/** A port range `FROM-TO` as [from, to], null for blank, or an error. */
export function parsePortRange(text) {
	const value = String(text ?? "").trim();
	if (value === "") return null;
	const m = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(value);
	if (!m) throw new Error("AGENT_PORT_RANGE: write it as FROM-TO, e.g. 20000-29999");
	const [from, to] = [Number(m[1]), Number(m[2])];
	if (from < 1024 || to > 65535 || from > to) throw new Error("AGENT_PORT_RANGE: ports must be between 1024 and 65535, and FROM not above TO");
	return [from, to];
}

/** A webhook URL as a URL, or an error. Blank is fine: alerts are then off. */
export function parseWebhookUrl(text) {
	const value = String(text ?? "").trim();
	if (value === "") return "";
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("ALERT_WEBHOOK_URL: not a URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ALERT_WEBHOOK_URL: must be an http or https URL");
	return url.href;
}

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
// A key's own container settings (memory, cpus, pids, network, image, mounts, env) as JSON; null follows the defaults.
if (!keyColumns.has("container_json")) db.exec("ALTER TABLE api_keys ADD COLUMN container_json TEXT");
// Profiles an operator has frozen: mounted read-only in every container, and refused by the profile API.
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
// What an operator did to containers and keys: who could do it is the dashboard's business, this only records it.
// Agents: named, permanent Pi agents of an API key, each on a port of its own (see lib/agents.mjs).
db.exec(
	"CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, name TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 0, " +
		"workspace TEXT NOT NULL DEFAULT 'own', model TEXT, thinking TEXT, container_json TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
);
const agentColumns = new Set(db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name));
if (!agentColumns.has("can_delegate")) db.exec("ALTER TABLE agents ADD COLUMN can_delegate INTEGER NOT NULL DEFAULT 0");
if (!agentColumns.has("description")) db.exec("ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT ''");
// Teams: a chain of agents of one key behind an OpenAI endpoint of its own (lib/teams.mjs).
db.exec("CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', steps_json TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)");
// Agent templates the operator saved from an agent (the built-in ones are files in templates/).
db.exec("CREATE TABLE IF NOT EXISTS templates (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', model TEXT, thinking TEXT, workspace TEXT NOT NULL DEFAULT 'own', files_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
// Jobs: a prompt an agent runs on a schedule, on a webhook or on request, and the runs it has had (lib/jobs.mjs).
db.exec(
	"CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, agent_id TEXT, name TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, " +
		"schedule_json TEXT NOT NULL, session_mode TEXT NOT NULL DEFAULT 'fresh', webhook_url TEXT, webhook_secret TEXT, trigger_hash TEXT, trigger_at INTEGER NOT NULL DEFAULT 0, " +
		"enabled INTEGER NOT NULL DEFAULT 1, timeout_ms INTEGER NOT NULL DEFAULT 600000, origin TEXT NOT NULL DEFAULT 'dashboard', created_at INTEGER NOT NULL, next_run_at INTEGER)",
);
db.exec(
	"CREATE TABLE IF NOT EXISTS job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, key_id TEXT NOT NULL, prompt TEXT NOT NULL, trigger TEXT NOT NULL, " +
		"status TEXT NOT NULL, queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, text TEXT, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, " +
		"error TEXT, note TEXT, webhook TEXT)",
);
db.exec("CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs (job_id, id)");
db.exec("CREATE INDEX IF NOT EXISTS job_runs_status ON job_runs (status)");
db.exec("CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
/**
 * The audit table shipped with four columns; the audit page needs a category, who did it and from where.
 * Added to whatever table exists, old rows kept (their category is filled in from the action, see lib/audit.mjs).
 */
export function migrateAuditTable(database) {
	const have = new Set(database.prepare("PRAGMA table_info(audit)").all().map((c) => c.name));
	for (const name of ["category", "actor", "ip"]) if (!have.has(name)) database.exec(`ALTER TABLE audit ADD COLUMN ${name} TEXT`);
	database.exec("CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)");
	database.exec("CREATE INDEX IF NOT EXISTS audit_category ON audit (category, id)");
}
migrateAuditTable(db);
// The ledger shipped without a key column, so add it only where it is missing.
export const spendColumns = new Set(db.prepare("PRAGMA table_info(spend)").all().map((c) => c.name));
if (!spendColumns.has("key_id")) db.exec("ALTER TABLE spend ADD COLUMN key_id TEXT");
// Which agent endpoint of the key a session was (null: the key's own endpoint, or a row from before agents).
if (!spendColumns.has("agent_id")) db.exec("ALTER TABLE spend ADD COLUMN agent_id TEXT");
// The file holds GATEWAY_API_KEY when one is set, so keep it owner-only.
try {
	chmodSync(GATEWAY_DB, 0o600);
} catch {
	/* best effort: some filesystems do not support it */
}

/** Seed any missing key from its env var (or default), then load every key into `config`. */
/**
 * Settings that were renamed when Piper moved to containers, with how an old value maps onto the
 * new one. Applied before seeding, so nothing the operator set is lost.
 */
export const RENAMED_SETTINGS = [
	{ from: "SANDBOX_MEMORY_MB", to: "CONTAINER_MEMORY_MB" },
	{ from: "SANDBOX_PIDS", to: "CONTAINER_PIDS" },
	{ from: "SANDBOX_CPUS", to: "CONTAINER_CPUS" },
	{ from: "SANDBOX_ENV", to: "CONTAINER_ENV" },
	{ from: "KEY_FILES_MAX_BYTES", to: "WORKSPACE_MAX_BYTES" },
	{ from: "WORKSPACE_ARCHIVE_TTL_MS", to: "ARCHIVE_TTL_MS" },
	// The old switch was network on or off; internet is "on" without reaching this machine or the LAN.
	{ from: "SANDBOX_NETWORK", to: "CONTAINER_NETWORK", map: (value) => (value === "on" ? "internet" : "none") },
];

/** Settings that belonged to the bubblewrap and in-process runners and mean nothing now. */
export const OBSOLETE_SETTINGS = ["RUNNER", "WORKSPACE_JAIL", "GATEWAY_EXTENSIONS", "PI_CWD", "SANDBOX_LIMITS", "SANDBOX_ALLOW", "WORKSPACE_ON_EXPIRY", "KEY_FILES_ROOT"];

/** Carry renamed rows over and drop obsolete ones. Idempotent: a second run finds nothing to do. */
export function migrateSettingRows(database = db) {
	const has = database.prepare("SELECT value, source FROM settings WHERE key = ?");
	const insert = database.prepare("INSERT INTO settings (key, value, source, updated_at) VALUES (?, ?, ?, ?)");
	const drop = database.prepare("DELETE FROM settings WHERE key = ?");
	for (const { from, to, map } of RENAMED_SETTINGS) {
		const old = has.get(from);
		if (!old) continue;
		if (!has.get(to)) insert.run(to, map ? map(old.value) : old.value, old.source, Date.now());
		drop.run(from);
	}
	// Where the old shared folders were, so the move to per-key workspaces can find them even when the
	// operator had put them somewhere else.
	const files = has.get("KEY_FILES_ROOT");
	if (files?.value) database.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('legacy-key-files-root', ?)").run(files.value);
	for (const key of OBSOLETE_SETTINGS) drop.run(key);
	// The image was renamed with the move; a stored old default would otherwise keep pointing at it.
	database.prepare("DELETE FROM settings WHERE key = 'CONTAINER_IMAGE' AND value = 'piper-sandbox'").run();
}

export function loadSettings() {
	migrateSettingRows();
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

