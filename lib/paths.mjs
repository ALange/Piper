/** Where things live on the host, where they appear inside a container, and the two setting parsers. */
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { GATEWAY_DIR, config } from "./settings.mjs";
import { workspaceScopeOf } from "./agents.mjs";

/** Where a chat's container sees what the gateway gives it. Fixed, so nothing depends on host paths. */
export const CONTAINER_PATHS = {
	workspace: "/workspace",
	profile: "/profile",
	// A frozen profile is mounted here read-only and copied into a tmpfs at /profile when Pi starts.
	profileFrozen: "/profile-frozen",
	shared: "/shared",
	// Pi's session files for this chat, so a stopped chat resumes where it was.
	session: "/piper/session",
	// Generated for this chat by the gateway and read-only here: the container config's models.json.
	etc: "/opt/piper/etc",
	modelsFile: "/opt/piper/etc/models.json",
	// The bridge socket's directory. A directory rather than the socket file, so a container that
	// outlives one gateway run sees the socket the next run creates.
	run: "/run/piper",
	socket: "/run/piper/bridge.sock",
	bridge: "/opt/piper/bridge.mjs",
	profileHelper: "/opt/piper/profile.mjs",
	// Where extensions keep settings they would put under ~/.pi (PI_CONFIG_DIR), inside the profile
	// so they persist per key.
	piConfig: "/profile/config",
	home: "/root",
};

/** Paths inside a container that mounts may not shadow. */
export const RESERVED_CONTAINER_PATHS = ["/", CONTAINER_PATHS.workspace, CONTAINER_PATHS.profile, CONTAINER_PATHS.profileFrozen, CONTAINER_PATHS.shared, "/piper", "/run/piper", "/opt/piper"];

export function workspaceRoot() {
	return String(config.WORKSPACE_ROOT ?? "").trim();
}

/** Mirrors Pi's getAgentDir(): the operator's own Pi directory, which holds the credentials the bridge serves. */
export function agentDirPath() {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv) {
		if (fromEnv === "~") return homedir();
		if (fromEnv.startsWith("~/")) return join(homedir(), fromEnv.slice(2));
		return resolve(fromEnv);
	}
	return join(homedir(), ".pi", "agent");
}

/** The directory name of a credential's folders: one per API key, plus the open gateway and the settings key. */
export function scopeOf(keyId) {
	if (keyId === null || keyId === undefined) return "open";
	if (keyId === "") return "settings";
	return `key-${String(keyId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** A key's workspace: the one folder every chat of that key mounts at /workspace. */
export function workspaceDir(keyId, root = workspaceRoot()) {
	// An agent that shares its key's workspace resolves to the key's folder here, for every caller.
	return join(root, scopeOf(workspaceScopeOf(keyId)));
}

/** Archives sit beside the root so a move is a rename on the same filesystem, never a copy. */
export function archiveRoot() {
	return `${workspaceRoot()}-archive`;
}

/** Per-chat state that must outlive a restart: Pi's session files. Beside the workspace root. */
export function chatRoot() {
	return workspaceRoot() ? `${workspaceRoot()}-chats` : "";
}

/** Room left for the longest socket path under the root, `/<8 hex>-key-<12 hex>/<16 hex>.sock` (48 bytes), under a 107-byte Unix socket path limit. */
export const RUN_ROOT_MAX = 59;

/**
 * Per-chat bridge sockets, beside the workspace root. A Unix socket path is limited to about 107
 * bytes, so a deep workspace root falls back to a fixed directory under /tmp owned by this user.
 * Only sockets live here, so losing it costs nothing.
 */
export function runRoot() {
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
		throw new Error(`refusing to use ${dir} for chat sockets: it must be a directory owned by this user with mode 0700`);
	}
	return dir;
}

/** Per-key Pi profiles. */
export function profileRoot() {
	return String(config.PROFILE_ROOT ?? "").trim();
}

/** Shared bundles, mounted read-only into the containers of the keys granted them. */
export function sharedRoot() {
	return String(config.SHARED_ROOT ?? "").trim();
}

/** The extension library: Pi packages installed on this host, mounted read-only where they are granted. */
export function extensionsRoot() {
	return String(config.EXTENSIONS_ROOT ?? "").trim();
}

/** The Pi configuration for containers (models.json, settings.json): separate from the operator's own. */
export function containerPiDir() {
	return String(config.CONTAINER_PI_DIR ?? "").trim();
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Single-quote a value for the outer shell. */
export function shQuote(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Host paths a container may never be given, and that nothing may contain either: the gateway's own
 * state, the operator's Pi credentials, host secrets, and the control sockets of container engines —
 * one reachable docker socket is the whole host.
 */
export function protectedHostPaths() {
	return [
		GATEWAY_DIR, workspaceRoot(), archiveRoot(), chatRoot(), runRoot(), profileRoot(), sharedRoot(), containerPiDir(), agentDirPath(),
		"/etc/shadow", "/etc/shadow-", "/etc/gshadow", "/etc/gshadow-", "/etc/sudoers", "/etc/sudoers.d",
		"/etc/ssh", "/etc/ssl/private", "/var/run/docker.sock", "/run/docker.sock", "/run/containerd", "/var/lib/docker",
		"/run/podman", "/proc", "/sys", "/dev", "/boot",
	].filter(Boolean);
}

/**
 * CONTAINER_ENV as [name, value] pairs. Entries are NAME=value separated by whitespace. With
 * `strict`, a malformed or reserved entry throws, which is how a save is refused; otherwise it is
 * skipped, so a bad stored value can never break every container.
 */
export function parseContainerEnv(text = config.CONTAINER_ENV, { strict = false } = {}) {
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
			if (strict) throw new Error(`CONTAINER_ENV: ${problem}`);
			continue;
		}
		pairs.push([match[1], match[2]]);
	}
	return pairs;
}

/** Folders far too broad to share: they hold other users' data and the host's own configuration. */
const TOO_BROAD = new Set(["/root", "/home", "/etc", "/var", "/run"]);
/** Where credentials live, by the tail of a path. A mount that is one of these, or holds one, is refused. */
const SECRET_TAILS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".password-store", ".config/gh", ".config/gcloud"];
const SECRET_FILE = /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/;

/**
 * The credential a folder is, sits inside or holds within two levels, or null. Two levels because
 * that is where the usual ones are (a home folder's .ssh, .config/gh) and because walking a whole
 * tree on every save would be slow; the scan is capped at 2,000 entries.
 */
/** The credential folder a path is, or is inside, judged by its name alone (nothing need exist), or null. */
export function secretPath(host) {
	const tail = SECRET_TAILS.find((t) => host.endsWith(`/${t}`) || host.includes(`/${t}/`));
	return tail ? `${host} is or is inside ${tail}` : null;
}

export function secretIn(host, { depth = 2, cap = 2000 } = {}) {
	const named = secretPath(host);
	if (named) return named;
	let seen = 0;
	const walk = (dir, level) => {
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			return null;
		}
		for (const name of names) {
			if (++seen > cap) return null;
			const path = `${dir}/${name}`;
			if (SECRET_FILE.test(name) || SECRET_TAILS.some((t) => path.endsWith(`/${t}`))) return `${path} is a credential`;
			if (level < depth) {
				let isDir = false;
				try {
					isDir = lstatSync(path).isDirectory();
				} catch {
					/* gone meanwhile */
				}
				const found = isDir ? walk(path, level + 1) : null;
				if (found) return found;
			}
		}
		return null;
	};
	return walk(host, 1);
}

/**
 * CONTAINER_MOUNTS as {host, container} pairs, mounted read-only. Entries are `host` or
 * `host:container`, separated by whitespace or commas. With `strict`, an entry that is unusable
 * throws, which is how a save is refused; otherwise it is skipped (a folder that is not there yet
 * would otherwise be created by the engine, as root).
 */
export function parseContainerMounts(text = config.CONTAINER_MOUNTS, { strict = false } = {}) {
	const mounts = [];
	const seen = new Set();
	for (const entry of String(text ?? "").split(/[\s,]+/).filter(Boolean)) {
		const [host, container = host, ...extra] = entry.split(":");
		let problem = null;
		if (extra.length) problem = `"${entry}" has too many colons`;
		else if (host === "/") problem = `"/" is the whole host`;
		else if (TOO_BROAD.has(host.replace(/\/+$/, ""))) problem = `${host} is too broad: it holds credentials and other users' data (share the folder you need, not its parent)`;
		else if (!isAbsolute(host) || !isAbsolute(container)) problem = `"${entry}" needs absolute paths`;
		else if (normalize(host) !== host.replace(/\/+$/, "") || normalize(container) !== container.replace(/\/+$/, "")) problem = `"${entry}" must be a clean path (no .. or //)`;
		else if (/docker\.sock|containerd\.sock/.test(entry)) problem = `"${entry}" is a container engine socket, which is the whole host`;
		else if (RESERVED_CONTAINER_PATHS.some((p) => (p === "/" ? container === "/" : isInside(p, container) || isInside(container, p)))) problem = `${container} is used by Piper inside the container`;
		else if (protectedHostPaths().some((p) => isInside(host, p) || isInside(p, host))) problem = `${host} is, or contains, something Piper protects`;
		// A credential folder is refused by its name, whether or not it exists on this machine.
		else if ((problem = secretPath(host))) problem = `${problem}: credentials must not be shared into a container`;
		else if (!existsSync(host)) problem = `${host} does not exist`;
		// secretIn scans the folder, so it runs once, last: its finding is kept and given its explanation.
		else if ((problem = secretIn(host))) problem = `${problem}: credentials must not be shared into a container`;
		else if (seen.has(container)) problem = `${container} is mounted twice`;
		if (problem) {
			if (strict) throw new Error(`CONTAINER_MOUNTS: ${problem}`);
			continue;
		}
		seen.add(container);
		mounts.push({ host: host.replace(/\/+$/, "") || "/", container: container.replace(/\/+$/, "") || "/" });
	}
	return mounts;
}

