/**
 * Pi packages and MCP servers, installed into a key's or an agent's profile from the dashboard.
 *
 * Both are things Pi keeps in the profile (`settings.json` packages, `mcp.json` servers) and manages with its own
 * commands (`pi install`, `pi mcp add`). The gateway never runs those on the host, and never edits a profile file
 * itself. It runs them in a **throwaway container**: the scope's image, its memory/process/cpu limits, only the
 * profile mounted at `/profile` (`PI_CODING_AGENT_DIR=/profile`), no engine socket, no key, no other mount, a time
 * limit, and a network only when the command needs one (an install, a connection test) and the scope's policy allows it.
 *
 * Packages and MCP servers run third-party code. Everything the operator types is validated and handed to Pi as separate
 * arguments, never as a shell string, and secrets are never written to `mcp.json`: a value may only be a `${NAME}`
 * reference to an environment variable, which is set in the key's or agent's extra environment.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { config } from "./settings.mjs";
import { ENGINE_BIN, networkArgs } from "./engine.mjs";
import { containerSettingsFor } from "./keycontainer.mjs";
import { engineOptions } from "./containers.mjs";
import { requireReady } from "./engine.mjs";
import { ensureProfile, filesOp, isProfileLocked, profileScope, profileWritability, reloadKeySessions } from "./profiles.mjs";
import { audit } from "./audit.mjs";
import { join } from "node:path";
import { profileRoot } from "./paths.mjs";

export class PackageError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "PackageError";
		this.status = status;
	}
}

// ---------------------------------------------------------------------------------------------
// What may be typed
// ---------------------------------------------------------------------------------------------

const NPM_SOURCE = /^npm:(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9^~<>=][A-Za-z0-9._~^<>=|*-]*)?$/;
const GIT_SOURCE = /^git:[A-Za-z0-9][A-Za-z0-9._~-]*(?:\.[A-Za-z0-9._~-]+)+\/[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._~/-]+)?$/;
const HTTPS_SOURCE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\.[A-Za-z0-9._~-]+)+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._~/-]+)?$/;

/**
 * A package source: `npm:name[@version]`, `git:host/owner/repo[@ref]` or `https://host/owner/repo[@ref]`. Nothing that
 * names a local path, starts with `-` (a flag), carries credentials or contains anything but plain URL characters.
 */
export function validateSource(text) {
	const source = String(text ?? "").trim();
	if (!source) throw new PackageError("name a package to install: npm:<name>, git:<host>/<owner>/<repo> or an https:// repository");
	if (source.length > 200) throw new PackageError("that package name is too long");
	if (source.includes("..")) throw new PackageError("that is not a package source");
	if (!(NPM_SOURCE.test(source) || GIT_SOURCE.test(source) || HTTPS_SOURCE.test(source))) {
		throw new PackageError("a package source is npm:<name>[@version], git:<host>/<owner>/<repo>[@ref] or https://<host>/<owner>/<repo>[@ref] (local paths and other forms are not accepted here)");
	}
	return source;
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXPOSURES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];
const COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_./@:+-]{0,127}$/;
const bareArg = (s) => typeof s === "string" && s.length <= 300 && !/[\0\r\n]/.test(s);

/** An environment value for an MCP server: only `${NAME}`, a reference, never the secret itself. */
const reference = (value, what) => {
	const m = /^\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}$/.exec(String(value ?? "").trim());
	if (!m) throw new PackageError(`${what}: a value must be a reference like \${NAME}, never the secret itself: set the variable in this key's or agent's extra environment (Profiles → container settings)`);
	return `\${${m[1]}}`;
};

/**
 * The arguments for `pi mcp add` from a form: a stdio server (`command`, `args`, `env` as {NAME: "${VAR}"}) or an HTTP one
 * (`url`, `bearerTokenEnv` naming the variable that holds the token). Throws PackageError for anything else.
 */
export function mcpAddArgs(input) {
	const name = String(input?.name ?? "");
	if (!SERVER_NAME.test(name)) throw new PackageError("a server's name is letters, digits, _ and - (at most 40)");
	const out = ["mcp", "add", name];
	const exposure = input?.exposure ? String(input.exposure) : "";
	if (exposure) {
		if (!EXPOSURES.includes(exposure)) throw new PackageError(`exposure is one of ${EXPOSURES.join(", ")}`);
		out.push("--exposure", exposure);
	}
	if (input?.url) {
		let url;
		try {
			url = new URL(String(input.url));
		} catch {
			throw new PackageError("the URL is not valid");
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new PackageError("an MCP server's URL is http or https");
		if (url.username || url.password) throw new PackageError("put no credentials in the URL: use a bearer token variable");
		if (input.command) throw new PackageError("a server is either a command or a URL, not both");
		out.push("--url", url.href);
		if (input.bearerTokenEnv) {
			if (!ENV_NAME.test(String(input.bearerTokenEnv))) throw new PackageError("the bearer token variable is a name like MY_TOKEN");
			out.push("--bearer-token-env-var", String(input.bearerTokenEnv));
		}
		return out;
	}
	const command = String(input?.command ?? "");
	if (!COMMAND.test(command)) throw new PackageError("the command is one program (like npx or uvx), without arguments or spaces: arguments go in the list below it");
	const args = Array.isArray(input?.args) ? input.args : [];
	if (args.length > 40 || !args.every(bareArg)) throw new PackageError("arguments: at most 40, each plain text of at most 300 characters");
	for (const [key, value] of Object.entries(input?.env ?? {})) {
		if (!ENV_NAME.test(key)) throw new PackageError(`"${key}" is not an environment variable name`);
		out.push("--env", `${key}=${reference(value, `env ${key}`)}`);
	}
	return [...out, "--", command, ...args];
}

// ---------------------------------------------------------------------------------------------
// The throwaway container
// ---------------------------------------------------------------------------------------------

/**
 * The `docker run` for one Pi command over a profile. Pure, so it can be checked: the only mount is the profile, there is no
 * engine socket and no key, the root is read-only apart from a scratch /tmp, and Pi is told the profile is its agent folder.
 */
export function packageRunArgs({ name, image, profileDir, piArgs, network, memoryMb = 0, pids = 0, cpus = 0, timeoutSeconds = 600 }) {
	return [
		"run", "--rm", "--name", name, "--pull", "never", "--init",
		"--security-opt", "no-new-privileges",
		"--read-only", "--tmpfs", "/tmp:size=1g",
		...(memoryMb > 0 ? ["--memory", `${memoryMb}m`, "--memory-swap", `${memoryMb}m`] : ["--memory", "2g", "--memory-swap", "2g"]),
		"--pids-limit", String(pids > 0 ? pids : 512),
		...(cpus > 0 ? ["--cpus", String(cpus)] : []),
		...(network === "none" ? ["--network", "none"] : networkArgs(network)),
		"-v", `${profileDir}:/profile`,
		"-w", "/profile",
		"-e", "PI_CODING_AGENT_DIR=/profile", "-e", "HOME=/tmp/home", "-e", "npm_config_cache=/tmp/npm", "-e", "PI_SKIP_VERSION_CHECK=1", "-e", "PI_TELEMETRY=0",
		"--entrypoint", "timeout",
		image, "-k", "10", String(timeoutSeconds), "pi", ...piArgs,
	];
}

/**
 * Run `pi <piArgs>` over a scope's profile in a throwaway container and resolve `{code, timedOut}`; each output line goes to
 * `onLine`. `needsNetwork` commands are refused when the scope's policy is `none` (and say why). A locked or over-quota
 * profile is refused for commands that change it.
 */
export async function runPiCommand(scopeId, piArgs, { onLine = () => {}, needsNetwork = false, changes = true, timeoutMs = 600_000, spawnFn = spawn } = {}) {
	const eff = containerSettingsFor(scopeId);
	if (needsNetwork && eff.network === "none") throw new PackageError("this scope's network policy is \"none\", so nothing can be downloaded or reached; change it (Profiles → container settings) first", 409);
	if (changes) {
		const writable = profileWritability(scopeId, join(profileRoot(), profileScope(scopeId)));
		if (!writable.writable) throw new PackageError(`the profile is ${writable.reason}`, 423);
	}
	await requireReady(await engineOptions());
	const profileDir = ensureProfile(scopeId);
	const name = `piper-pkg-${crypto.randomBytes(5).toString("hex")}`;
	const args = packageRunArgs({ name, image: eff.image, profileDir, piArgs, network: needsNetwork ? eff.network : "none", memoryMb: eff.memoryMb, pids: eff.pids, cpus: eff.cpus, timeoutSeconds: Math.round(timeoutMs / 1000) });
	return await new Promise((resolve) => {
		const child = spawnFn(ENGINE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		const feed = (chunk) => {
			buffer += String(chunk);
			const parts = buffer.split(/\r?\n|\r/);
			buffer = parts.pop() ?? "";
			for (const line of parts) if (line) onLine(line.slice(0, 400));
		};
		child.stdout?.on("data", feed);
		child.stderr?.on("data", feed);
		const guard = setTimeout(() => child.kill?.("SIGKILL"), timeoutMs + 30_000);
		guard.unref?.();
		child.on("error", (err) => {
			clearTimeout(guard);
			onLine(`could not run docker: ${err.message}`);
			resolve({ code: 127, timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(guard);
			if (buffer) onLine(buffer.slice(0, 400));
			resolve({ code: code ?? 1, timedOut: code === 124 || code === 137 });
		});
	});
}

// ---------------------------------------------------------------------------------------------
// Jobs: one at a time, with their output
// ---------------------------------------------------------------------------------------------

let job = null;
let counter = 0;
const LOG_LINES = 200;

export const packageJobView = () => (job ? { id: job.id, title: job.title, scope: job.scope, state: job.state, startedAt: job.startedAt, endedAt: job.endedAt, lines: job.lines.slice(-LOG_LINES) } : null);

/** Run a Pi command as the (single) package job. Resolves at once with the job; the output fills in as it runs. */
export function startPackageJob(scopeId, title, piArgs, options = {}) {
	if (job?.state === "running") throw new PackageError("another package job is running; wait for it to finish", 409);
	const current = { id: ++counter, title, scope: scopeId, state: "running", startedAt: Date.now(), endedAt: null, lines: [] };
	job = current;
	const log = (line) => {
		current.lines.push(line);
		if (current.lines.length > LOG_LINES * 2) current.lines.splice(0, current.lines.length - LOG_LINES);
	};
	void (async () => {
		try {
			const result = await runPiCommand(scopeId, piArgs, { ...options, onLine: log });
			if (result.timedOut) log("stopped: it took too long");
			current.state = result.code === 0 ? "done" : "failed";
			if (result.code !== 0) log(`pi exited with code ${result.code}`);
			if (options.changes !== false && result.code === 0) void reloadKeySessions(scopeId).catch(() => {});
		} catch (err) {
			log(`failed: ${err.message}`);
			current.state = "failed";
		}
		current.endedAt = Date.now();
	})();
	return packageJobView();
}

export const resetPackageJob = () => void (job = null);

// ---------------------------------------------------------------------------------------------
// What is installed
// ---------------------------------------------------------------------------------------------

/** The packages listed in the profile's settings.json, read by the profile helper. */
export async function listPackages(scopeId) {
	const inv = await filesOp(scopeId, { op: "inventory" }, { root: "profile" });
	return inv.packages ?? [];
}

const redactEnv = (env) => Object.fromEntries(Object.entries(env && typeof env === "object" ? env : {}).map(([k, v]) => [k, /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(v)) ? String(v) : "(value hidden)"]));

/** The MCP servers in the profile's mcp.json, with environment and header values hidden unless they are references. */
export async function listMcp(scopeId) {
	let text = "";
	try {
		text = (await filesOp(scopeId, { op: "files.readtext", path: "mcp.json" }, { root: "profile" })).text ?? "";
	} catch {
		return { servers: [], note: null };
	}
	let doc;
	try {
		doc = JSON.parse(text || "{}");
	} catch {
		return { servers: [], note: "mcp.json is not valid JSON" };
	}
	const servers = Object.entries(doc?.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}).map(([name, s]) => ({
		name,
		kind: s?.url ? "http" : "stdio",
		command: s?.command ? [s.command, ...(Array.isArray(s.args) ? s.args : [])].join(" ").slice(0, 300) : null,
		url: s?.url ?? null,
		env: redactEnv(s?.env),
		headers: redactEnv(s?.headers),
		exposure: s?.exposure ?? null,
		enabled: s?.enabled !== false,
	}));
	return { servers, note: null };
}

// ---------------------------------------------------------------------------------------------
// Operations (what the dashboard does)
// ---------------------------------------------------------------------------------------------

const gate = (scopeId) => {
	if (!config.PACKAGES_ENABLED) throw new PackageError("installing packages and MCP servers is switched off (Settings → Containers → Packages)", 403);
	if (isProfileLocked(profileScope(scopeId))) throw new PackageError("this profile is locked by the gateway operator", 423);
};

export function installPackage(scopeId, source) {
	gate(scopeId);
	const checked = validateSource(source);
	audit("profile.package_install", scopeId, checked);
	return startPackageJob(scopeId, `Install ${checked}`, ["install", checked], { needsNetwork: true });
}

export function removePackage(scopeId, source) {
	gate(scopeId);
	const checked = validateSource(source);
	audit("profile.package_remove", scopeId, checked);
	return startPackageJob(scopeId, `Remove ${checked}`, ["remove", checked]);
}

export function updatePackages(scopeId) {
	gate(scopeId);
	audit("profile.package_update", scopeId, "all");
	return startPackageJob(scopeId, "Update packages", ["update", "--extensions"], { needsNetwork: true });
}

export function addMcp(scopeId, input) {
	gate(scopeId);
	const args = mcpAddArgs(input);
	audit("profile.mcp_add", scopeId, `${input.name}: ${input.url ? new URL(input.url).origin : input.command}`);
	return startPackageJob(scopeId, `Add MCP server ${input.name}`, args);
}

export function removeMcp(scopeId, name) {
	gate(scopeId);
	if (!SERVER_NAME.test(String(name ?? ""))) throw new PackageError("a server's name is letters, digits, _ and -");
	audit("profile.mcp_remove", scopeId, name);
	return startPackageJob(scopeId, `Remove MCP server ${name}`, ["mcp", "remove", String(name)]);
}

/** Connect to every enabled server of the profile and report: state, tools and errors, with the exit code. */
export function testMcp(scopeId) {
	if (!config.PACKAGES_ENABLED) throw new PackageError("installing packages and MCP servers is switched off", 403);
	audit("profile.mcp_test", scopeId, "pi mcp list");
	return startPackageJob(scopeId, "Test MCP servers", ["mcp", "list"], { needsNetwork: true, changes: false });
}

/** Switch a server on or off by editing `enabled` in mcp.json, through the profile helper (it refuses a changed file). */
export async function setMcpEnabled(scopeId, name, enabled) {
	gate(scopeId);
	if (!SERVER_NAME.test(String(name ?? ""))) throw new PackageError("a server's name is letters, digits, _ and -");
	const file = await filesOp(scopeId, { op: "files.readtext", path: "mcp.json" }, { root: "profile" }).catch(() => null);
	if (!file || typeof file.text !== "string") throw new PackageError("there is no mcp.json", 404);
	let doc;
	try {
		doc = JSON.parse(file.text);
	} catch {
		throw new PackageError("mcp.json is not valid JSON", 409);
	}
	if (!doc?.mcpServers?.[name]) throw new PackageError(`no server called "${name}"`, 404);
	if (enabled) delete doc.mcpServers[name].enabled;
	else doc.mcpServers[name].enabled = false;
	await filesOp(scopeId, { op: "files.writetext", path: "mcp.json", text: `${JSON.stringify(doc, null, 2)}\n`, expectModified: file.modified }, { root: "profile" });
	audit("profile.mcp_toggle", scopeId, `${name} ${enabled ? "on" : "off"}`);
	void reloadKeySessions(scopeId).catch(() => {});
	return { name, enabled };
}

