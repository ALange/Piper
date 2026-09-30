/**
 * The container engine: the one place Piper runs `docker` (and `iptables`, for the network policy).
 *
 * The container is the sandbox. Inside it Pi is root with a writable filesystem and a network; what
 * the gateway decides is what the container can *reach*: which folders are mounted, which network it
 * is on, and how much it may use. Everything that builds a command line is a pure function, and
 * everything that runs one goes through `runner`, which tests replace.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { GATEWAY_DB, config } from "./settings.mjs";
import { CONTAINER_PATHS as P } from "./paths.mjs";

export const ENGINE_BIN = "docker";

/** The network chats live on under the internet policy. A fixed name and subnet, so the firewall rules can name it. */
export const NETWORK = Object.freeze({ name: "piper", bridge: "piper0", subnet: "172.29.0.0/24", gateway: "172.29.0.1" });
/**
 * The network for chats that are allowed everything. A second network rather than the first without
 * rules, because the rules are per network: one chat on `open` must not be cut off by the rules that
 * keep another chat's `internet` policy.
 */
export const NETWORK_OPEN = Object.freeze({ name: "piper-open", bridge: "piper1", subnet: "172.30.0.0/24", gateway: "172.30.0.1" });

/** Destinations the `internet` policy takes away: private networks, cloud metadata, this machine. */
export const BLOCKED_RANGES = Object.freeze(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8"]);

export const NETWORK_MODES = ["internet", "none", "open"];

export class EngineError extends Error {
	constructor(message, status = 503) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------------------------

/** Run a program to completion: {code, stdout, stderr}. Never rejects; a missing binary is code 127. */
export function defaultRunner(bin, args, { input, timeoutMs = 60_000 } = {}) {
	return new Promise((resolvePromise) => {
		const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
			if (!err) return resolvePromise({ code: 0, stdout, stderr });
			const code = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
			resolvePromise({ code, stdout: stdout ?? "", stderr: stderr || err.message });
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

let runner = defaultRunner;

/** Replace how commands run (tests). Returns the previous runner; no argument restores the default. */
export function setRunner(fn) {
	const previous = runner;
	runner = fn ?? defaultRunner;
	return previous;
}

const docker = (args, opts) => runner(ENGINE_BIN, args, opts);
/** Run one docker command through the same runner as everything else, for the modules that ask about images. */
export const runDocker = docker;

/**
 * Where iptables is. It lives in /usr/sbin, which a service's PATH often lacks (systemd units,
 * cron), and then the network policy would look impossible to enforce. The standard sbin folders
 * are tried before the bare name.
 */
export function iptablesBinary(exists = existsSync) {
	return ["/usr/sbin/iptables", "/sbin/iptables", "/usr/local/sbin/iptables"].find((p) => exists(p)) ?? "iptables";
}
const iptables = (args) => runner(iptablesBinary(), args, { timeoutMs: 15_000 });

/** A result that must have succeeded, or an EngineError that says what the engine answered. */
function must(result, what) {
	if (result.code === 0) return result;
	const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" | ");
	throw new EngineError(`${what} failed: ${detail || `exit ${result.code}`}`);
}

// ---------------------------------------------------------------------------------------------
// Names, limits, signature
// ---------------------------------------------------------------------------------------------

/** The hash a chat is stored under. The session id itself is a bearer secret and never stored. */
export function chatIdHash(id) {
	return crypto.createHash("sha256").update(String(id)).digest("hex");
}

/**
 * Which gateway this is, from where its database lives. Containers, firewall rules and socket folders
 * carry it, so a second gateway on the same Docker (a test run, a scratch copy) never mistakes the
 * first one's containers for orphans, and never removes its rules.
 */
export function instanceId(dbPath = GATEWAY_DB) {
	return crypto.createHash("sha1").update(String(dbPath)).digest("hex").slice(0, 8);
}

/** The first 16 hex of a chat's id hash: names its container and its state folders. */
export const chatKey = (idHash) => String(idHash).slice(0, 16);
export const containerName = (idHash, instance = instanceId()) => `piper-${instance}-${chatKey(idHash)}`;
/** The chat key a container name carries, or null when the name is not this instance's. */
export function chatKeyOfContainer(name, instance = instanceId()) {
	const prefix = `piper-${instance}-`;
	return String(name).startsWith(prefix) ? String(name).slice(prefix.length) : null;
}

/** The Docker network a policy puts a container on. */
export function networkName(mode = config.CONTAINER_NETWORK) {
	return mode === "none" ? "none" : mode === "open" ? NETWORK_OPEN.name : NETWORK.name;
}

/** What `--network` gets for a policy. */
export function networkArgs(mode = config.CONTAINER_NETWORK) {
	return ["--network", networkName(mode)];
}

/**
 * A hash of everything a container's mounts and limits depend on. A container is created with these
 * fixed, so on resume a changed signature means the container is recreated (what the agent installed
 * in it is lost; its workspace, profile and session are not). One rule that covers every setting.
 */
export function containerSignature(spec, imageId = "") {
	const basis = {
		image: imageId,
		profileWritable: spec.profileWritable !== false,
		workspaceWritable: spec.workspaceWritable !== false,
		bundles: (spec.bundles ?? []).map((b) => [b.name, b.path]),
		mounts: (spec.mounts ?? []).map((m) => [m.host, m.container]),
		memoryMb: spec.memoryMb ?? 0,
		pids: spec.pids ?? 0,
		cpus: spec.cpus ?? 0,
		// The network itself, not the policy's name: two policies can share a network, and one policy
		// once meant a different network than it does now.
		network: networkName(spec.network ?? "internet"),
		// Where the chat's folders and the bridge live are baked into the mounts too.
		workspace: spec.workspace,
		profileDir: spec.profileDir,
		chatDir: spec.chatDir,
		runDir: spec.runDir,
		bridgePath: spec.bridgePath,
	};
	return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

/**
 * `docker create` for a chat's container: root, Docker's default capabilities (no --privileged, no
 * engine socket, no host namespaces), a writable filesystem, the limits, and the mounts.
 *
 *   workspace   the key's shared workspace, read-write (read-only when the key is over its quota)
 *   profile     the key's Pi profile; a frozen one is copied into a tmpfs when Pi starts
 *   session     Pi's session files for this chat
 *   etc         the models.json rendered for this key, read-only
 *   run         the bridge socket's directory
 *   /shared/*   the bundles the key is granted, read-only
 *   mounts      the operator's CONTAINER_MOUNTS, read-only
 */
export function containerCreateArgs(spec) {
	const { name, keyId = null, sig, image, workspace, workspaceWritable = true, profileDir, profileWritable = true, chatDir, runDir, bridgePath, bundles = [], mounts = [], memoryMb = 0, pids = 0, cpus = 0, network = "internet" } = spec;
	return [
		"create", "--name", name, "--init", "--pull", "never", "--hostname", "piper",
		"--label", "piper.managed=1", "--label", `piper.instance=${instanceId()}`, "--label", `piper.key=${keyId ?? ""}`, "--label", `piper.sig=${sig}`,
		"--security-opt", "no-new-privileges",
		// Equal memory and swap limits: no swap, so a runaway process is killed instead of thrashing the host.
		...(memoryMb > 0 ? ["--memory", `${memoryMb}m`, "--memory-swap", `${memoryMb}m`] : []),
		...(pids > 0 ? ["--pids-limit", String(pids)] : []),
		...(cpus > 0 ? ["--cpus", String(cpus)] : []),
		...networkArgs(network),
		"-v", `${workspace}:${P.workspace}${workspaceWritable ? "" : ":ro"}`,
		...(profileWritable ? ["-v", `${profileDir}:${P.profile}`] : ["-v", `${profileDir}:${P.profileFrozen}:ro`, "--tmpfs", `${P.profile}:mode=0700`]),
		"-v", `${chatDir}/session:${P.session}`,
		"-v", `${chatDir}/etc:${P.etc}:ro`,
		"-v", `${runDir}:${P.run}`,
		"-v", `${bridgePath}:${P.bridge}:ro`,
		...bundles.flatMap((b) => ["-v", `${b.path}:${P.shared}/${b.name}:ro`]),
		...mounts.flatMap((m) => ["-v", `${m.host}:${m.container}:ro`]),
		"-w", P.workspace,
		image,
	];
}

/**
 * The command that starts Pi in a running container. It is `docker exec`, not the container's main
 * process, so mounts stay fixed while the arguments and environment are chosen at every start.
 *
 * The wrapper first copies a frozen profile into its tmpfs, then links the container config's
 * models.json into the profile unless the key has its own, then hands over to Pi.
 */
export function execArgs({ name, env = {}, piArgs, profileWritable = true, cwd = P.workspace }) {
	const prepare = [
		profileWritable ? "" : `cp -a ${P.profileFrozen}/. ${P.profile}/ &&`,
		`{ [ -e ${P.profile}/models.json ] || [ -L ${P.profile}/models.json ] || ln -s ${P.modelsFile} ${P.profile}/models.json; } &&`,
		'exec "$@"',
	].filter(Boolean).join(" ");
	return [
		"exec", "-i", "-w", cwd,
		...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
		name, "sh", "-c", prepare, "sh", "pi", ...piArgs,
	];
}

/**
 * The profile helper's command: `docker run` of the same image with ONE directory mounted, no
 * network and no capabilities. Unlike the agent's container this one is strict, because it protects
 * the gateway, not the agent: the gateway must never open a key's files on the host, since a link
 * planted there would turn "show my settings" into "show the host's". Inside, such a link leads nowhere.
 */
export function helperArgs({ dir, helperPath, extraArgs = [], maxBytes = 0, image = config.CONTAINER_IMAGE, uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0 }) {
	return [
		"run", "--rm", "-i", "--pull", "never",
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--read-only", "--tmpfs", "/tmp",
		"--memory", "256m", "--pids-limit", "64",
		"--user", `${uid}:${gid}`,
		"-v", `${dir}:/data`,
		"-v", `${helperPath}:${P.profileHelper}:ro`,
		"-w", "/data",
		"-e", `PROFILE_MAX_BYTES=${maxBytes}`,
		"--entrypoint", "node",
		image,
		P.profileHelper, ...extraArgs,
	];
}

// ---------------------------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------------------------

/** What `docker inspect` says about a container, or null when there is none. */
export async function inspectContainer(name) {
	const result = await docker(["inspect", "--type", "container", name]);
	if (result.code !== 0) return null;
	try {
		return JSON.parse(result.stdout)[0] ?? null;
	} catch {
		return null;
	}
}

/** The image's id and the Pi version it was built with, or null when there is no such image. */
export async function imageInfo(image = config.CONTAINER_IMAGE) {
	// `with` because an image with no labels at all has a nil map, and indexing that is an error that
	// would read as "no such image".
	const result = await docker(["image", "inspect", "--format", '{{.Id}}|{{with .Config.Labels}}{{index . "piper.pi-version"}}{{end}}', image]);
	if (result.code !== 0) return null;
	const [id, piVersion] = result.stdout.trim().split("|");
	return { id, piVersion: piVersion || "" };
}

/**
 * Make sure a chat's container exists with the right mounts and is running. Returns what it did:
 * `created` (there was none), `recreated` (its signature no longer matched, so it was replaced).
 */
export function ensureContainer(spec, imageId) {
	return locked(spec.name, async () => {
		const sig = containerSignature(spec, imageId);
		let info = await inspectContainer(spec.name);
		let recreated = false;
		if (info && info.Config?.Labels?.["piper.managed"] !== "1") {
			throw new EngineError(`a container named ${spec.name} exists and is not Piper's; remove or rename it`);
		}
		if (info && info.Config?.Labels?.["piper.sig"] !== sig) {
			noteSelfStop(spec.name);
			await rm(spec.name);
			info = null;
			recreated = true;
		}
		const created = !info;
		if (!info) must(await docker(containerCreateArgs({ ...spec, sig })), "creating the container");
		if (!info?.State?.Running) must(await docker(["start", spec.name]), "starting the container");
		return { created: created && !recreated, recreated, sig };
	});
}

// One operation at a time per container, so ending a chat and a message that starts it again a moment
// later cannot race: the second waits for the first, and sees what it left.
const locks = new Map();
function locked(name, fn) {
	const run = (locks.get(name) ?? Promise.resolve()).then(fn, fn);
	const tail = run.then(() => {}, () => {});
	locks.set(name, tail);
	tail.then(() => locks.get(name) === tail && locks.delete(name));
	return run;
}

const rm = (name) => docker(["rm", "-f", "-v", name], { timeoutMs: 30_000 });

/**
 * Containers the gateway itself is stopping or removing, with when. Docker reports every one of
 * those as a `die`, and an operator must not be told a container "died unexpectedly" when the
 * gateway just stopped it.
 */
const selfInflicted = new Map();
export function noteSelfStop(name, now = Date.now()) {
	selfInflicted.set(name, now);
	if (selfInflicted.size > 500) for (const [n, t] of selfInflicted) if (now - t > 60_000) selfInflicted.delete(n);
}
export const wasSelfStop = (name, now = Date.now()) => now - (selfInflicted.get(name) ?? -Infinity) < 60_000;

/** Stop a container, keeping it (a chat waiting to resume). A container that is gone is fine. */
export function stopContainer(name, timeoutSeconds = 2) {
	noteSelfStop(name);
	return locked(name, () => docker(["stop", "-t", String(timeoutSeconds), name], { timeoutMs: (timeoutSeconds + 20) * 1000 }));
}

/** Remove a container for good (a chat that ended). A container that is gone is fine. */
export function removeContainer(name) {
	noteSelfStop(name);
	return locked(name, () => rm(name));
}

/** Kill Pi's process inside a container, for when closing its stdin did not end it. */
export async function killPi(name) {
	await docker(["exec", name, "pkill", "-KILL", "-f", "--", "--mode rpc"], { timeoutMs: 10_000 });
}

/**
 * Run one shell command in a running container as root, for the operator's "run a command" box.
 * The time is capped and so is the output, so a stuck or chatty command cannot hold the gateway.
 */
export async function execIn(name, command, timeoutMs = 30_000) {
	const cap = 64 * 1024;
	const limit = Math.max(1000, Math.min(120_000, Number(timeoutMs) || 30_000));
	const result = await docker(["exec", name, "sh", "-c", String(command)], { timeoutMs: limit });
	const clip = (text) => (text.length > cap ? `${text.slice(0, cap)}\n… (output cut at ${cap / 1024} KB)` : text);
	return { code: result.code, stdout: clip(result.stdout), stderr: clip(result.stderr), truncated: result.stdout.length > cap || result.stderr.length > cap, timeoutMs: limit };
}

/** Every container this gateway made: [{name, state, keyId}]. */
export async function listManaged() {
	const result = await docker(["ps", "-a", "--filter", "label=piper.managed=1", "--filter", `label=piper.instance=${instanceId()}`, "--format", '{{.Names}}\t{{.State}}\t{{.Label "piper.key"}}']);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [name, state, keyId] = line.split("\t");
			return { name, state, keyId };
		});
}

// ---------------------------------------------------------------------------------------------
// Looking at containers: state, live usage, disk, and what happened to them
// ---------------------------------------------------------------------------------------------

/** Docker's sizes as bytes: decimal ("1.23kB", "12MB", "3.1GB") as `ps` prints them, binary ("12MiB") as `stats` does. */
export function parseSize(text) {
	const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKMGTP]?i?B)\s*$/.exec(String(text ?? ""));
	if (!match) return 0;
	const unit = match[2].toLowerCase();
	const power = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4, pb: 5, pib: 5 }[unit] ?? 0;
	return Math.round(parseFloat(match[1]) * (unit.includes("i") ? 1024 : 1000) ** power);
}

/** "12.3MiB / 2GiB" as {used, limit}. */
export function parseUsage(text) {
	const [used, limit] = String(text ?? "").split("/");
	return { used: parseSize(used), limit: parseSize(limit) };
}

/** `docker ps -s` prints "1.23MB (virtual 1.9GB)": what the container wrote, and with its image. */
export function parseDiskSize(text) {
	const match = /^\s*(\S+)(?:\s*\(virtual\s+(\S+)\))?/.exec(String(text ?? ""));
	return { rw: parseSize(match?.[1]), virtual: parseSize(match?.[2]) };
}

/** Details of these containers from `docker inspect`, by name. Names that do not exist are absent. */
export async function inspectMany(names) {
	const out = new Map();
	if (!names.length) return out;
	const result = await docker(["inspect", "--type", "container", ...names]);
	// A missing name makes inspect exit 1 but still print the rest.
	try {
		for (const info of JSON.parse(result.stdout || "[]")) out.set(String(info.Name).replace(/^\//, ""), info);
	} catch {
		/* unreadable: no details */
	}
	return out;
}

/** Live CPU, memory and processes of running containers: Map name -> {cpu, memUsed, memLimit, pids}. */
export async function containerStats(names) {
	const out = new Map();
	if (!names.length) return out;
	const result = await docker(["stats", "--no-stream", "--format", "{{json .}}", ...names], { timeoutMs: 20_000 });
	for (const line of result.stdout.split("\n").filter(Boolean)) {
		try {
			const row = JSON.parse(line);
			const mem = parseUsage(row.MemUsage);
			out.set(row.Name, { cpu: parseFloat(row.CPUPerc) || 0, memUsed: mem.used, memLimit: mem.limit, pids: Number(row.PIDs) || 0 });
		} catch {
			/* a partial line */
		}
	}
	return out;
}

/** What each of this gateway's containers has written to its own filesystem: Map name -> {rw, virtual}. Slow: it walks layers. */
export async function diskUsage() {
	const out = new Map();
	const result = await docker(["ps", "-a", "-s", "--filter", "label=piper.managed=1", "--filter", `label=piper.instance=${instanceId()}`, "--format", "{{.Names}}\t{{.Size}}"], { timeoutMs: 120_000 });
	if (result.code !== 0) return out;
	for (const line of result.stdout.split("\n").filter(Boolean)) {
		const [name, size] = line.split("\t");
		out.set(name, parseDiskSize(size));
	}
	return out;
}

/** Where Docker keeps its data, which is what fills up. */
export async function dockerRootDir() {
	const result = await docker(["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 15_000 });
	return result.code === 0 ? result.stdout.trim() : "";
}

/** One line of `docker events --format '{{json .}}'` as {action, name, exitCode, time}, or null when it is not one we use. */
export function parseEvent(line) {
	let e;
	try {
		e = JSON.parse(line);
	} catch {
		return null;
	}
	const name = e?.Actor?.Attributes?.name;
	const action = String(e?.Action ?? e?.status ?? "").split(":")[0];
	if (e?.Type !== "container" || !name || !["oom", "die"].includes(action)) return null;
	const exitCode = e.Actor.Attributes.exitCode === undefined ? null : Number(e.Actor.Attributes.exitCode);
	return { action, name, exitCode, time: Number(e.time) ? Number(e.time) * 1000 : Date.now() };
}

/**
 * Watch for this gateway's containers being killed for memory or dying, and hand each event to
 * `onEvent`. Restarts itself with a pause when `docker events` exits (the daemon restarted), and
 * reports nothing for a container the gateway stopped on purpose. Returns {stop}.
 */
export function watchEvents(onEvent, { spawnFn = spawn, restartMs = 3000 } = {}) {
	let child = null;
	let stopped = false;
	let timer = null;
	const start = () => {
		if (stopped) return;
		child = spawnFn(ENGINE_BIN, ["events", "--format", "{{json .}}", "--filter", "type=container", "--filter", "label=piper.managed=1", "--filter", `label=piper.instance=${instanceId()}`, "--filter", "event=oom", "--filter", "event=die"], { stdio: ["ignore", "pipe", "ignore"] });
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let i;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const event = parseEvent(buffer.slice(0, i));
				buffer = buffer.slice(i + 1);
				if (!event) continue;
				// A die the gateway asked for is not news; an oom always is.
				if (event.action === "die" && wasSelfStop(event.name, event.time)) continue;
				try {
					onEvent(event);
				} catch {
					/* a listener's bug must not stop the watch */
				}
			}
		});
		child.on("error", () => {});
		child.on("close", () => {
			child = null;
			if (!stopped) timer = setTimeout(start, restartMs);
		});
	};
	start();
	return {
		stop() {
			stopped = true;
			clearTimeout(timer);
			child?.kill();
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Network and firewall
// ---------------------------------------------------------------------------------------------

/** Create the network for a policy if it is missing: no traffic between containers, no IPv6. `none` needs none. */
export async function ensureNetwork(mode = "internet") {
	if (mode === "none") return;
	const net = mode === "open" ? NETWORK_OPEN : NETWORK;
	const found = await docker(["network", "inspect", net.name]);
	if (found.code === 0) return;
	must(
		await docker([
			"network", "create", "--driver", "bridge",
			"--subnet", net.subnet, "--gateway", net.gateway,
			"-o", `com.docker.network.bridge.name=${net.bridge}`,
			"-o", "com.docker.network.bridge.enable_icc=false",
			net.name,
		]),
		`creating the ${net.name} network`,
	);
}

function ipv4ToInt(ip) {
	const parts = String(ip).split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Whether an IPv4 address is inside a CIDR range. */
export function inRange(ip, cidr) {
	const [base, bits = "32"] = cidr.split("/");
	const a = ipv4ToInt(ip);
	const b = ipv4ToInt(base);
	if (a === null || b === null) return false;
	const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
	return (a & mask) === (b & mask);
}

export const isBlockedIp = (ip) => BLOCKED_RANGES.some((range) => inRange(ip, range));

/** This machine's own IPv4 addresses. */
export function localAddresses() {
	return Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4").map((a) => a.address);
}

/**
 * The firewall rules a network mode needs, in the order they must sit: allowances first, then drops.
 * Each carries a comment naming its content, which is how later runs tell present, missing and stale
 * apart without depending on how iptables prints a rule back.
 *
 *   INPUT        nothing from the containers reaches a service on this machine (the gateway, the
 *                dashboard, anything on localhost), except an endpoint the operator allowed
 *   DOCKER-USER  nothing from the containers reaches the LAN, link-local or cloud metadata addresses,
 *                except the endpoints the operator allowed
 *
 * `allow` is [{ip, port, proto}] already resolved to addresses; `proto` defaults to tcp.
 */
export function firewallRules(mode, allow = [], local = localAddresses(), instance = instanceId()) {
	if (mode !== "internet") return [];
	const rules = [];
	const add = (chain, spec, action) => {
		const body = [...spec];
		const id = crypto.createHash("sha1").update([chain, ...body, action].join(" ")).digest("hex").slice(0, 12);
		rules.push({ chain, id, kind: action === "ACCEPT" ? "allow" : "drop", args: [...body, "-m", "comment", "--comment", `piper:${instance}:${id}`, "-j", action] });
	};
	for (const { ip, port, proto = ["tcp"] } of allow) {
		// A port needs a protocol; without one, everything to that address is allowed.
		for (const p of port ? proto : [null]) {
			const target = ["-s", NETWORK.subnet, "-d", ip, ...(port ? ["-p", p, "--dport", String(port)] : [])];
			add("DOCKER-USER", target, "ACCEPT");
			// An endpoint on this very machine is reached through INPUT, not forwarded.
			if (local.includes(ip)) add("INPUT", target, "ACCEPT");
		}
	}
	add("INPUT", ["-s", NETWORK.subnet, "-m", "conntrack", "!", "--ctstate", "ESTABLISHED,RELATED"], "DROP");
	for (const range of BLOCKED_RANGES) add("DOCKER-USER", ["-s", NETWORK.subnet, "-d", range], "DROP");
	return rules;
}

/** The Piper rules currently installed in a chain: [{id, line}], where line is the rule as listed. */
async function installedRules(chain) {
	const result = await iptables(["-S", chain]);
	if (result.code !== 0) throw new EngineError(`cannot read the firewall (iptables -S ${chain}): ${(result.stderr || "").trim().split("\n")[0]}`);
	const rules = [];
	for (const line of result.stdout.split("\n")) {
		const found = new RegExp(`--comment "?piper:${instanceId()}:([0-9a-f]+)"?`).exec(line);
		if (found && line.startsWith("-A ")) rules.push({ id: found[1], line });
	}
	return rules;
}

const deleteArgs = (line) => ["-D", ...line.slice(3).match(/"[^"]*"|\S+/g).map((t) => t.replace(/^"|"$/g, ""))];

/**
 * Bring the firewall to the rules a mode needs: install what is missing, delete what is stale
 * (including everything when the mode is no longer `internet`). Throws when it cannot, which callers
 * treat as "do not run containers unprotected".
 */
export async function ensureFirewall(mode, allow = []) {
	const desired = firewallRules(mode, allow);
	const wanted = new Set(desired.map((r) => r.id));
	const installed = { INPUT: await installedRules("INPUT"), "DOCKER-USER": await installedRules("DOCKER-USER") };
	const have = new Set([...installed.INPUT, ...installed["DOCKER-USER"]].map((r) => r.id));
	const dropsMissing = desired.some((r) => r.kind === "drop" && !have.has(r.id));
	let removed = 0;
	let added = 0;
	// A missing drop means the order can no longer be trusted: start over.
	const remove = (rule, chain) => iptables(deleteArgs(rule.line)).then((r) => { must(r, `removing a firewall rule from ${chain}`); removed++; });
	for (const chain of Object.keys(installed)) {
		for (const rule of installed[chain]) if (dropsMissing || !wanted.has(rule.id)) await remove(rule, chain);
	}
	const present = dropsMissing ? new Set() : have;
	// Allowances go on top, drops below them; -I 1 puts each rule first, so insert drops before allows.
	const order = [...desired.filter((r) => r.kind === "drop").reverse(), ...desired.filter((r) => r.kind === "allow").reverse()];
	for (const rule of order) {
		if (present.has(rule.id)) continue;
		must(await iptables(["-I", rule.chain, "1", ...rule.args]), `installing a firewall rule in ${rule.chain}`);
		added++;
	}
	return { added, removed, rules: desired.length };
}

/** Whether the rules for a mode are all in place, without changing anything. */
export async function firewallInPlace(mode, allow = []) {
	const desired = firewallRules(mode, allow);
	const have = new Set([...(await installedRules("INPUT")), ...(await installedRules("DOCKER-USER"))].map((r) => r.id));
	return desired.every((r) => have.has(r.id));
}

/**
 * The nameservers the host uses, which containers need to resolve names. Docker's resolver in a
 * container forwards to these *from the container's network*, so one on the LAN (a router) would be
 * cut off by the same rules that keep containers off the LAN. Loopback ones are Docker's to handle.
 */
export function hostNameservers(files = ["/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"]) {
	const found = new Set();
	for (const file of files) {
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			const ip = /^\s*nameserver\s+(\d+\.\d+\.\d+\.\d+)\s*$/.exec(line)?.[1];
			if (ip && !inRange(ip, "127.0.0.0/8")) found.add(ip);
		}
	}
	return [...found];
}

/** Resolve [{host, port, why}] to [{ip, port, proto, why}]; only addresses the policy would block need a rule. */
export async function resolveEndpoints(endpoints) {
	const out = [];
	for (const { host, port, why, proto } of endpoints) {
		let ips = [];
		if (ipv4ToInt(host) !== null) ips = [host];
		else {
			try {
				ips = (await lookup(host, { all: true, family: 4 })).map((a) => a.address);
			} catch {
				continue;
			}
		}
		for (const ip of ips) if (isBlockedIp(ip)) out.push({ ip, port, proto, why, host });
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------------------------

let cached = null;

/**
 * Whether containers can run here, and what is wrong when not. Cached for 30 seconds (`force`
 * skips it) and never throws: a gateway whose Docker is down still serves its dashboard, and says why.
 *
 * `endpoints` are the hosts the operator allowed containers to reach; `hostPiVersion` is compared
 * with the image's, which is a warning rather than an error (an old image usually still works).
 * `modes` are the network policies in use: the default, and any a key chose for itself. The firewall
 * rules are installed when any of them is `internet` and taken away when none is.
 */
export async function checkEngine({ force = false, endpoints = [], hostPiVersion = "", modes, now = Date.now() } = {}) {
	if (!force && cached && now - cached.at < 30_000) return cached.status;
	const mode = config.CONTAINER_NETWORK;
	const inUse = [...new Set(modes?.length ? modes : [mode])];
	const needRules = inUse.includes("internet");
	const policy = needRules ? "internet" : inUse.includes("open") ? "open" : "none";
	const status = { ok: false, problems: [], warnings: [], engine: null, image: null, network: { mode, inUse, ok: true }, firewall: { mode: policy, ok: true, allowed: [] }, hostPiVersion };
	try {
		const version = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
		if (version.code !== 0) {
			status.problems.push(version.code === 127 ? "Docker is not installed (no `docker` command)" : `Docker is not answering: ${(version.stderr || "").trim().split("\n")[0]}`);
			return remember(status, now);
		}
		status.engine = { version: version.stdout.trim() };
		const image = await imageInfo();
		if (!image) status.problems.push(`the image "${config.CONTAINER_IMAGE}" does not exist; build it with ./piper.sh image`);
		else {
			status.image = image;
			if (hostPiVersion && image.piVersion && image.piVersion !== hostPiVersion) {
				status.warnings.push(`the image has Pi ${image.piVersion} but the gateway runs Pi ${hostPiVersion}; rebuild it with ./piper.sh image`);
			}
		}
		for (const m of inUse) {
			try {
				await ensureNetwork(m);
			} catch (err) {
				status.network.ok = false;
				status.problems.push(err.message);
			}
		}
		try {
			const allow = needRules ? await resolveEndpoints(endpoints) : [];
			status.firewall.allowed = allow.map(({ ip, port, proto, why }) => ({ endpoint: port ? `${ip}:${port}${proto ? `/${proto.join("+")}` : ""}` : ip, why }));
			await ensureFirewall(policy, allow);
		} catch (err) {
			status.firewall.ok = false;
			status.problems.push(
				`the network policy "${policy}" cannot be enforced: ${err.message}. Set CONTAINER_NETWORK (and any key's own network) to none or open, or fix iptables.`,
			);
		}
	} catch (err) {
		status.problems.push(`checking the container engine failed: ${err?.message ?? err}`);
	}
	status.ok = status.problems.length === 0;
	return remember(status, now);
}

let readinessHook = null;
/** Be told when readiness changes: fn(status, previousOk). Alerts hang on this. */
export function onReadinessChange(fn) {
	readinessHook = fn;
}

// Whether the last check passed. Kept apart from the cache, which a settings change clears: a
// recovery after that must still be seen as one.
let lastKnownOk;

function remember(status, now) {
	status.ok = status.problems.length === 0;
	const previous = lastKnownOk;
	lastKnownOk = status.ok;
	cached = { at: now, status };
	// Only a change is news, and the first answer of a run is a change only when it is bad.
	if (readinessHook && (previous === undefined ? !status.ok : previous !== status.ok)) {
		try {
			readinessHook(status, previous);
		} catch {
			/* a listener's bug must not break the check */
		}
	}
	return status;
}

/** The last readiness answer without asking again, or null before the first. For /health. */
export function lastEngineStatus() {
	return cached?.status ?? null;
}

/** Forget the cached readiness, so the next check looks again (after a setting changes). */
export function resetEngineCheck() {
	cached = null;
}

/** The readiness, or an EngineError (HTTP 503) saying what to fix. */
export async function requireReady(options) {
	const status = await checkEngine(options);
	if (!status.ok) throw new EngineError(status.problems.join("; "));
	return status;
}
