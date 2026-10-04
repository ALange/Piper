/**
 * The extension library: Pi packages installed **on this host** for granting to keys and agents.
 *
 * An install downloads with the host's own npm or git into a staging folder, checks that what arrived is a Pi package,
 * and moves it into `EXTENSIONS_ROOT/<name>/` with an `entry.json`. The code is never run on the host: install scripts are
 * off by default (`--ignore-scripts`), git hooks are disabled, the environment holds nothing but `PATH`, and the package is
 * afterwards mounted **read-only into containers** and executed there, under each agent's network policy and limits, exactly
 * like a shared bundle. Who gets which entry is decided by the grants (agent -> key -> default, see grantedBundles).
 *
 * Sources are `npm:name[@version]`, `git:host/owner/repo[@ref]` and `https://host/owner/repo[@ref]` (the same forms the
 * packages feature accepts). The operator's own Pi folder is never read or written.
 */
import { spawn } from "node:child_process";
import { checkPackageSource } from "./packagesource.mjs";
import crypto from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./settings.mjs";
import { appendLog } from "./jobtracker.mjs";
import { extensionsRoot } from "./paths.mjs";
import { audit } from "./audit.mjs";
import { BUNDLE_NAME, bundleUsers, listBundles, listLibrary, reloadKeySessions } from "./profiles.mjs";

export class ExtensionError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "ExtensionError";
		this.status = status;
	}
}

const TIMEOUT_MS = 10 * 60_000;
const LOG_LINES = 300;

// ---------------------------------------------------------------------------------------------
// Sources and names
// ---------------------------------------------------------------------------------------------

/** A library source: `npm:`, `git:` or `https://` forms only, nothing that names a path, a flag or credentials. */
export function checkedSource(text) {
	const checked = checkPackageSource(text);
	if (!checked.ok) throw new ExtensionError(checked.reason);
	return checked.source;
}

/** A library name from a source: `npm:@scope/pkg@1` -> `scope-pkg`, `https://github.com/o/repo.git` -> `repo`. */
export function nameFromSource(source) {
	let base;
	if (source.startsWith("npm:")) base = source.slice(4).replace(/@[^/@]+$/, "").replace(/^@/, "").replace(/\//g, "-");
	else base = source.replace(/^(git:|https:\/\/)/, "").replace(/@[^/@]+$/, "").split("/").filter(Boolean).slice(-1)[0] ?? "";
	return base.replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
}

/** The git URL and ref a `git:` or `https://` source means. */
export function gitTarget(source) {
	const body = source.replace(/^(git:|https:\/\/)/, "");
	const m = /^(.*?)(?:@([^/@]+))?$/.exec(body);
	return { url: `https://${m[1]}`, ref: m[2] ?? null };
}

// ---------------------------------------------------------------------------------------------
// Running the host's tools
// ---------------------------------------------------------------------------------------------

/** The environment for a host command: `PATH`, and a `HOME` of its own. Nothing of the gateway's, nothing of the operator's Pi. */
export function installEnv(home, { allowScripts = false } = {}) {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: home,
		TMPDIR: home,
		LANG: "C.UTF-8",
		npm_config_ignore_scripts: allowScripts ? "false" : "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
		npm_config_cache: join(home, ".npm"),
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
}

/** The commands an install runs, as argument lists: pure, so they can be checked. */
export function installCommands(source, stage, { allowScripts = false } = {}) {
	const scripts = allowScripts ? [] : ["--ignore-scripts"];
	if (source.startsWith("npm:")) {
		return [{ bin: "npm", args: ["install", "--prefix", stage, ...scripts, "--no-audit", "--no-fund", "--omit=dev", "--legacy-peer-deps", "--no-package-lock", source.slice(4)], cwd: stage }];
	}
	const { url, ref } = gitTarget(source);
	return [
		{ bin: "git", args: ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, join(stage, "src")], cwd: stage },
	];
}

/** Run one install command (npm or git). Resolves `{code, timedOut}`: `timedOut` is only true when this
 * timeout is what ended it, not whenever the exit code happens to look like a kill (SIGKILL from the host
 * running out of memory would look the same), so a hung install is told apart from one that really failed. */
function run(bin, args, { cwd, env, onLine, signal, spawnFn = spawn, timeoutMs = TIMEOUT_MS }) {
	return new Promise((resolve) => {
		const child = spawnFn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let timedOut = false;
		const feed = (chunk) => {
			buffer += String(chunk);
			const parts = buffer.split(/\r?\n|\r/);
			buffer = parts.pop() ?? "";
			for (const line of parts) if (line) onLine(line.slice(0, 400));
		};
		child.stdout.on("data", feed);
		child.stderr.on("data", feed);
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
		child.on("error", (err) => {
			clearTimeout(timer);
			onLine(`could not run ${bin}: ${err.message}`);
			resolve({ code: 127, timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (buffer) onLine(buffer.slice(0, 400));
			resolve({ code: code ?? 1, timedOut });
		});
	});
}

// ---------------------------------------------------------------------------------------------
// Checking what arrived
// ---------------------------------------------------------------------------------------------

/** Bytes under a path, links not followed. Stops counting past `limit`. */
export function treeBytes(path, limit = Infinity) {
	let total = 0;
	const walk = (p) => {
		if (total > limit) return;
		const stat = lstatSync(p, { throwIfNoEntry: false });
		if (!stat) return;
		if (stat.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
		else total += stat.size;
	};
	walk(path);
	return total;
}

/** Whether a folder is a Pi package: a `pi` manifest or the `pi-package` keyword, or the conventional resource folders. */
export function looksLikePiPackage(dir) {
	let pkg = null;
	try {
		pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch {
		/* a package may have no package.json */
	}
	if (pkg && typeof pkg.pi === "object" && pkg.pi !== null) return true;
	if (pkg && Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package")) return true;
	return ["extensions", "skills", "prompts"].some((d) => lstatSync(join(dir, d), { throwIfNoEntry: false })?.isDirectory());
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

let job = null;
let counter = 0;

export const extensionJobView = () => (job ? { id: job.id, title: job.title, state: job.state, startedAt: job.startedAt, endedAt: job.endedAt, lines: job.lines.slice(-LOG_LINES) } : null);
export const resetExtensionJob = () => void (job = null);

function startJob(title, work) {
	if (job?.state === "running") throw new ExtensionError("another extension job is running; wait for it to finish", 409);
	const current = { id: ++counter, title, state: "running", startedAt: Date.now(), endedAt: null, lines: [] };
	job = current;
	const log = (line) => appendLog(current.lines, line, LOG_LINES);
	void (async () => {
		try {
			await work(log);
			current.state = "done";
		} catch (err) {
			log(`failed: ${err.message}`);
			current.state = "failed";
		}
		current.endedAt = Date.now();
	})();
	return extensionJobView();
}

const gate = () => {
	if (!config.EXTENSIONS_ENABLED) throw new ExtensionError("installing extensions is switched off (Settings → Agent → Extensions)", 403);
	if (!extensionsRoot()) throw new ExtensionError("EXTENSIONS_ROOT is not set: there is nowhere to keep the library", 409);
};

/**
 * Install (or reinstall) an extension from `source` into the library under `name`. Resolves when it is in place; progress
 * lines go to `log`. Nothing is left in the library unless every check passed: the new copy is staged, checked, then swapped in.
 */
export async function installInto(name, source, { allowScripts = false, log = () => {}, spawnFn = spawn, timeoutMs = TIMEOUT_MS } = {}) {
	const root = extensionsRoot();
	mkdirSync(root, { recursive: true });
	const stage = join(root, `.staging-${crypto.randomBytes(4).toString("hex")}`);
	mkdirSync(stage, { recursive: true });
	try {
		const env = installEnv(stage, { allowScripts });
		for (const { bin, args, cwd } of installCommands(source, stage, { allowScripts })) {
			log(`$ ${bin} ${args.filter((a) => a !== stage).join(" ")}`);
			const result = await run(bin, args, { cwd, env, onLine: log, spawnFn, timeoutMs });
			if (result.code !== 0) throw new ExtensionError(result.timedOut ? `${bin} timed out after ${Math.round(timeoutMs / 60_000)} minutes` : `${bin} exited with code ${result.code}`);
		}
		let entry;
		if (source.startsWith("npm:")) {
			const top = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
			const names = Object.keys(top.dependencies ?? {});
			if (names.length !== 1) throw new ExtensionError("npm did not install exactly one package");
			entry = `node_modules/${names[0]}`;
		} else {
			entry = "src";
			rmSync(join(stage, "src", ".git"), { recursive: true, force: true });
			if (existsSync(join(stage, "src", "package.json"))) {
				const dependencies = Object.keys(JSON.parse(readFileSync(join(stage, "src", "package.json"), "utf8")).dependencies ?? {});
				if (dependencies.length) {
					const deps = { bin: "npm", args: ["install", "--prefix", join(stage, "src"), ...(allowScripts ? [] : ["--ignore-scripts"]), "--no-audit", "--no-fund", "--omit=dev", "--legacy-peer-deps", "--no-package-lock"], cwd: join(stage, "src") };
					log(`$ npm ${deps.args.filter((a) => a !== join(stage, "src")).join(" ")}`);
					const result = await run(deps.bin, deps.args, { cwd: deps.cwd, env, onLine: log, spawnFn, timeoutMs });
					if (result.code !== 0) throw new ExtensionError(result.timedOut ? `npm timed out after ${Math.round(timeoutMs / 60_000)} minutes` : `npm exited with code ${result.code}`);
				}
			}
		}
		rmSync(join(stage, ".npm"), { recursive: true, force: true });
		const packageDir = join(stage, entry);
		if (!looksLikePiPackage(packageDir)) throw new ExtensionError("that is not a Pi package: it has no \"pi\" section in package.json, no pi-package keyword, and no extensions/, skills/ or prompts/ folder");
		const cap = Number(config.EXTENSION_MAX_BYTES ?? 200 * 1024 * 1024);
		const size = treeBytes(stage, cap);
		if (size > cap) throw new ExtensionError(`it takes more than the ${cap}-byte limit with its dependencies (EXTENSION_MAX_BYTES)`);
		let version = "";
		try {
			version = String(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version ?? "");
		} catch {
			/* no version to show */
		}
		writeFileSync(join(stage, "entry.json"), `${JSON.stringify({ name, source, version, entry, scripts: Boolean(allowScripts), installedAt: Date.now() }, null, 1)}\n`);
		// Swap in: the old copy moves aside first, so a failure here leaves the library as it was.
		const target = join(root, name);
		const old = join(root, `.old-${crypto.randomBytes(4).toString("hex")}`);
		if (existsSync(target)) renameSync(target, old);
		try {
			renameSync(stage, target);
		} catch (err) {
			if (existsSync(old)) renameSync(old, target);
			throw err;
		}
		rmSync(old, { recursive: true, force: true });
		log(`installed ${name} ${version}`.trim());
		return { name, version, entry, size };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/** The names that are taken: bundles and library entries. */
const taken = () => new Set([...listBundles().map((b) => b.name), ...listLibrary().map((e) => e.name)]);

/** Install a new extension as a job. `name` defaults to one made from the source. */
export function installExtension({ source, name = null, allowScripts = false }) {
	gate();
	const checked = checkedSource(source);
	const chosen = String(name || nameFromSource(checked));
	if (!BUNDLE_NAME.test(chosen)) throw new ExtensionError("a name is letters, digits, dots, dashes and underscores, starting with a letter or digit (at most 64)");
	const existing = listLibrary().find((e) => e.name === chosen);
	if (!existing && taken().has(chosen)) throw new ExtensionError(`"${chosen}" is already the name of a shared bundle`, 409);
	if (existing && existing.source !== checked) throw new ExtensionError(`"${chosen}" is already installed from ${existing.source}; use another name, or remove it first`, 409);
	audit("files.extension_install", chosen, `${checked}${allowScripts ? " (install scripts allowed)" : ""}`);
	return startJob(`${existing ? "Reinstall" : "Install"} ${chosen}`, async (log) => {
		const done = await installInto(chosen, checked, { allowScripts, log });
		for (const { scope } of bundleUsers(chosen)) void reloadKeySessions(scope).catch(() => {});
		return done;
	});
}

/** Install again from the entry's own source, picking up a newer version when the source is not pinned. */
export function updateExtension(name) {
	gate();
	const entry = listLibrary().find((e) => e.name === name);
	if (!entry) throw new ExtensionError(`no extension called "${name}"`, 404);
	let scripts = false;
	try {
		scripts = JSON.parse(readFileSync(join(entry.path, "entry.json"), "utf8")).scripts === true;
	} catch {
		/* default off */
	}
	audit("files.extension_update", name, entry.source);
	return startJob(`Update ${name}`, async (log) => {
		await installInto(name, entry.source, { allowScripts: scripts, log });
		for (const { scope } of bundleUsers(name)) void reloadKeySessions(scope).catch(() => {});
	});
}

/** Remove an entry. Refused while something gets it, unless `force`; those chats reload without it. */
export async function removeExtension(name, { force = false } = {}) {
	const entry = listLibrary().find((e) => e.name === name);
	if (!entry) throw new ExtensionError(`no extension called "${name}"`, 404);
	const users = bundleUsers(name);
	if (users.length && !force) throw new ExtensionError(`"${name}" is granted to ${users.map((u) => u.label).join(", ")}; take it away from them first, or remove it anyway`, 409);
	rmSync(entry.path, { recursive: true, force: true });
	audit("files.extension_remove", name, `removed${users.length ? ` (it was granted to ${users.length} scope(s))` : ""}`);
	await Promise.all(users.map((u) => reloadKeySessions(u.scope).catch(() => 0)));
	return { removed: name };
}

/** The library for the dashboard: each entry with its size and who gets it. */
export function libraryOverview() {
	return listLibrary().map((e) => {
		let meta = {};
		try {
			meta = JSON.parse(readFileSync(join(e.path, "entry.json"), "utf8"));
		} catch {
			/* shown without the extras */
		}
		return { name: e.name, source: e.source, version: e.version, bytes: treeBytes(e.path), installedAt: meta.installedAt ?? null, scripts: meta.scripts === true, usedBy: bundleUsers(e.name).map((u) => u.label) };
	});
}

