/** The sandbox: which paths exist inside it, the bubblewrap arguments, and resource limits. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { GATEWAY_DIR, config } from "./settings.mjs";
import { pi } from "./models.mjs";

export const BWRAP = "/usr/bin/bwrap";

// Each session gets its own directory and is confined to it. Two enforcement points, one policy:
//
//   bash        -> a bubblewrap mount namespace, enforced by the kernel
//   file tools  -> a path check here, because they run in this process and cannot be namespaced
//
// The kernel sandbox is what makes the path check meaningful: with bash confined there is no
// unsandboxed route left around it. Inside the sandbox the system is readable but not writable,
// only the session's own workspace is writable, and the workspaces root, the archive, the Pi
// config directory and this gateway's own directory are hidden.

export function workspaceRoot() {
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
export function archiveRoot() {
	return `${workspaceRoot()}-archive`;
}

/** Room left for `/<16 hex>.sock` under a 107-byte Unix socket path limit. */
export const RUN_ROOT_MAX = 84;

/**
 * Per-session bridge sockets, beside the workspace root. A Unix socket path is limited to about
 * 107 bytes, so a deep workspace root falls back to a fixed directory under /tmp owned by this
 * user — fixed, rather than random, so the sandbox masks can name it without state.
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
		throw new Error(`refusing to use ${dir} for session sockets: it must be a directory owned by this user with mode 0700`);
	}
	return dir;
}

/** Per-key Pi profiles. */
export function profileRoot() {
	return String(config.PROFILE_ROOT ?? "").trim();
}

/** Per-key shared folders, mounted read-write at /workspace/shared in that key's chats. */
export function keyFilesRoot() {
	return String(config.KEY_FILES_ROOT ?? "").trim();
}

/** Shared bundles, mounted read-only into the sandboxes of the keys granted them. */
export function sharedRoot() {
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
export function protectedPaths() {
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
export const SANDBOX_UID = 65534;

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
export const SANDBOX_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

/** Where the fixed layout puts things. The container runners use the same paths. */
export const SANDBOX_PATHS = {
	workspace: "/workspace",
	profile: "/profile",
	shared: "/shared",
	keyFiles: "/workspace/shared",
	piSession: "/workspace/.piper/session",
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
export function sandboxIdentityFiles() {
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
export function jailExtension(workspace) {
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

export let scopeProbe;
/**
 * Whether a limited scope can actually be created here, found by trying one. As root that needs a
 * running systemd; as another user it needs a user manager with the controllers delegated, which a
 * container or a bare `su` session often lacks.
 */
export function scopesWork() {
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
