/**
 * The Pi the gateway itself runs on: what version it is, whether a newer one exists, and updating it
 * and its extensions from the dashboard.
 *
 * Two versions matter and they can differ. The gateway loads Pi as a library once, so what it *runs* is
 * fixed until it restarts (`hostPiVersion()`), while what is *installed* can change under it
 * (`diskPiVersion()`). An update changes the second only. Images and containers follow the first, which
 * is what the gateway actually speaks, so nothing is pinned to a version the gateway is not running.
 *
 * The update runs Pi's own `pi update` and `pi update --extensions` with the `pi` of this install, and only
 * where it is safe: the install has to be the one `npm root -g` of the gateway's own node leads to, and
 * writable by the gateway's user. Anything else is reported with the reason and the command to run by hand.
 * The operator's Pi directory holds credentials: this module never reads it; the `pi` CLI does, as it would
 * if the operator ran it.
 */
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EngineError } from "./engine.mjs";
import { PKG, piPackageDir } from "./models.mjs";
import { diskPiVersion, hostPiVersion } from "./containers.mjs";
import { audit } from "./audit.mjs";
import { versionNewer } from "./versions.mjs";

export { versionNewer };

const NPM = join(dirname(process.execPath), "npm");
const LATEST_TTL_MS = 10 * 60_000;
const LIST_TTL_MS = 60_000;

/** `execFile` as a promise that never rejects: {code, stdout, stderr}. Replaceable for the tests. */
export function runProgram(bin, args, { cwd, env, timeoutMs = 30_000 } = {}) {
	return new Promise((resolve) => {
		execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

const real = (p) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

/** The environment for running Pi's own commands: the gateway's, minus what would make them refuse to go online. */
export function hostPiEnv(base = process.env) {
	const env = { ...base };
	delete env.PI_OFFLINE;
	delete env.PI_SKIP_VERSION_CHECK;
	env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;
	return env;
}

/** Where this Pi's command line lives: the package's `bin` entry. */
export function piCliPath(packageDir = piPackageDir) {
	try {
		const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi ?? Object.values(pkg.bin ?? {})[0];
		return rel ? join(packageDir, rel) : "";
	} catch {
		return "";
	}
}

/**
 * Whether Pi can be updated from here: the gateway's npm must manage the place Pi is installed, and the
 * gateway's user must be able to write there. `reason` says what is wrong and what to run by hand.
 */
export async function manageability({ packageDir = piPackageDir, run = runProgram, npm = NPM } = {}) {
	const byHand = `run it yourself: ${npm} install -g ${PKG}`;
	if (!packageDir) return { ok: false, reason: "Pi has not been loaded yet" };
	if (!existsSync(npm)) return { ok: false, reason: `there is no npm next to the gateway's node (${dirname(process.execPath)}); ${byHand}` };
	const root = await run(npm, ["root", "-g"], { timeoutMs: 15_000 });
	if (root.code !== 0 || !root.stdout.trim()) return { ok: false, reason: `npm could not say where it installs global packages; ${byHand}` };
	const expected = join(root.stdout.trim(), PKG);
	if (real(expected) !== real(packageDir)) {
		return { ok: false, reason: `Pi is at ${packageDir}, not where the gateway's npm installs (${expected}): it was installed another way or with another node (PI_AGENT_PACKAGE?); update it the way it was installed` };
	}
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
	} catch {
		return { ok: false, reason: `the gateway's user cannot write to ${dirname(packageDir)}; update Pi as the user that owns it` };
	}
	return { ok: true, reason: "" };
}

let latestCache = { at: 0, value: null };

/** The newest published version, from npm's registry, or null when it could not be asked. Cached for ten minutes. */
export async function latestPiVersion({ check = false, run = runProgram, now = Date.now(), npm = NPM } = {}) {
	if (!check && latestCache.at && now - latestCache.at < LATEST_TTL_MS) return latestCache.value;
	const result = await run(npm, ["view", PKG, "version"], { env: hostPiEnv(), timeoutMs: 20_000 });
	const version = /^\s*(\d+\.\d+\.\d+[\w.+-]*)\s*$/m.exec(result.stdout)?.[1] ?? null;
	latestCache = { at: now, value: result.code === 0 ? version : null };
	return latestCache.value;
}

/** Forget what was looked up (tests). */
export function resetHostPiCache() {
	latestCache = { at: 0, value: null };
	listCache = { at: 0, value: [] };
}

let listCache = { at: 0, value: [] };

/**
 * `pi list` as a table's rows: {name, type, scope, filtered, pinned}. The output is sections ("User packages:",
 * "Project packages:"), an entry per package (`npm:@scope/name`, `git:github.com/owner/repo`, a path),
 * optionally " (filtered)", each followed by an indented line with its folder. The folder is dropped: it is
 * not wanted, and it says where the operator's Pi folder is. A line that is none of these is kept as
 * `other` rather than lost. `pinned` is the version or ref a source is fixed to, when it is.
 */
export function parsePiList(text) {
	const rows = [];
	let scope = "user";
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;
		const heading = /^(\w+)\s+packages:$/i.exec(line.trim());
		if (heading && !/^\s/.test(line)) {
			scope = heading[1].toLowerCase();
			continue;
		}
		// An entry sits at two spaces; its folder at four or more.
		if (/^\s{3,}/.test(line)) continue;
		let entry = line.trim();
		const filtered = / \(filtered\)$/.test(entry);
		if (filtered) entry = entry.replace(/ \(filtered\)$/, "");
		let type = "other";
		let name = entry;
		let pin = null;
		if (entry.startsWith("npm:")) {
			type = "npm";
			// `npm:name`, `npm:@scope/name`, each optionally pinned: `npm:name@1.2.3`.
			const m = /^(@[^/@]+\/[^@]+|[^@]+)(?:@(.+))?$/.exec(entry.slice(4));
			name = m ? m[1] : entry.slice(4);
			pin = m?.[2] ?? null;
		} else if (entry.startsWith("git:") || /^(https?|ssh):\/\//.test(entry) || /^git@/.test(entry)) {
			type = "git";
			// `git:github.com/owner/repo`, optionally `.git` and `@ref`: show `owner/repo`.
			const m = /^(?:git:)?(?:(?:https?|ssh):\/\/)?(?:git@)?[^/:]+[/:](.+?)(?:\.git)?(?:@([^/@]+))?$/.exec(entry);
			name = m ? m[1] : entry;
			pin = m?.[2] ?? null;
		} else if (/^([/~.]|[A-Za-z]:[\\/])/.test(entry)) {
			type = "local";
			name = entry.split(/[\\/]/).filter(Boolean).pop() ?? entry;
		}
		rows.push({ name: name.slice(0, 120), type, scope, filtered, pinned: pin });
	}
	return rows.slice(0, 100);
}

/** The packages the host Pi has installed, as rows for a table. Cached for a minute. */
export async function hostExtensions({ run = runProgram, now = Date.now(), packageDir = piPackageDir } = {}) {
	if (listCache.at && now - listCache.at < LIST_TTL_MS) return listCache.value;
	const cli = piCliPath(packageDir);
	if (!cli) return [];
	const result = await run(process.execPath, [cli, "list"], { cwd: tmpdir(), env: hostPiEnv(), timeoutMs: 30_000 });
	const rows = result.code === 0 ? parsePiList(result.stdout) : [];
	listCache = { at: now, value: rows };
	return rows;
}

/** Everything the "Pi on this host" panel shows. `check` asks the registry again instead of using the cache. */
export async function hostPiInfo({ check = false, run = runProgram, now = Date.now() } = {}) {
	const [running, latest, manage, extensions] = await Promise.all([hostPiVersion(), latestPiVersion({ check, run, now }), manageability({ run }), hostExtensions({ run, now })]);
	const onDisk = diskPiVersion();
	return {
		running,
		onDisk,
		latest,
		updateAvailable: Boolean(latest && onDisk && versionNewer(latest, onDisk)),
		restartNeeded: Boolean(running && onDisk && running !== onDisk),
		packageDir: piPackageDir,
		manageable: manage.ok,
		reason: manage.reason,
		extensions,
	};
}

/** Run one Pi command with this install's own `pi`, streaming its lines to `log`. Resolves {code, timedOut}. */
function runPi(args, log, { spawnFn = spawn, packageDir = piPackageDir, timeoutMs = 600_000 } = {}) {
	return new Promise((resolve) => {
		const cli = piCliPath(packageDir);
		if (!cli) {
			log("cannot find Pi's command line in its package");
			return resolve({ code: 127, timedOut: false });
		}
		// From the temp folder, never the gateway's own: Pi treats project-local files as something to trust.
		const child = spawnFn(process.execPath, [cli, ...args], { cwd: tmpdir(), env: hostPiEnv(), stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let timedOut = false;
		const feed = (chunk) => {
			buffer += String(chunk);
			const parts = buffer.split(/\r?\n|\r/);
			buffer = parts.pop() ?? "";
			for (const line of parts) if (line) log(line.slice(0, 400));
		};
		child.stdout?.on("data", feed);
		child.stderr?.on("data", feed);
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill?.("SIGKILL");
		}, timeoutMs);
		timer.unref?.();
		child.on("error", (err) => {
			clearTimeout(timer);
			log(`could not run Pi: ${err.message}`);
			resolve({ code: 127, timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (buffer) log(buffer.slice(0, 400));
			resolve({ code: code ?? 1, timedOut });
		});
	});
}

/**
 * Update the host's Pi and/or its extensions. Nothing is attempted when the install is not one the
 * gateway can manage (409 with the reason). A failing step is logged and does not stop the next. Returns
 * {steps, before, after, failed, restartNeeded}. `spawnFn`, `run` and `packageDir` are parameters for the tests.
 */
export async function updateHostPi({ self = true, extensions = true } = {}, log = () => {}, { spawnFn, run = runProgram, packageDir = piPackageDir } = {}) {
	if (!self && !extensions) throw new EngineError("choose Pi, its extensions, or both", 400);
	const manage = await manageability({ packageDir, run });
	if (!manage.ok) throw new EngineError(manage.reason, 409);
	const before = diskPiVersion(packageDir);
	const steps = [];
	const step = async (name, args) => {
		log(`pi ${args.join(" ")}`);
		const result = await runPi(args, log, { spawnFn, packageDir });
		const state = result.code === 0 ? "done" : "failed";
		steps.push({ name, state, detail: result.timedOut ? "timed out" : result.code === 0 ? "" : `pi exited ${result.code}` });
		log(`${name}: ${state}${result.timedOut ? " (timed out)" : result.code !== 0 ? ` (pi exited ${result.code})` : ""}`);
	};
	if (self) await step("pi", ["update"]);
	if (extensions) await step("extensions", ["update", "--extensions"]);
	const after = diskPiVersion(packageDir);
	const running = await hostPiVersion();
	latestCache = { at: 0, value: null };
	listCache = { at: 0, value: [] };
	log(after === before ? `Pi on disk is ${after || "unknown"}: unchanged` : `Pi on disk: ${before || "unknown"} -> ${after || "unknown"}`);
	const restartNeeded = Boolean(running && after && running !== after);
	if (restartNeeded) log(`The gateway still runs Pi ${running} until it is restarted. Images and containers follow the running version: after restarting, rebuild the image and update the containers.`);
	const failed = steps.filter((s) => s.state === "failed").map((s) => s.name);
	audit("host.pi.update", "Pi on this host", `${steps.map((s) => `${s.name} ${s.state}`).join(", ")}; ${before || "?"} -> ${after || "?"}${restartNeeded ? "; restart needed" : ""}`);
	return { steps, before, after, failed, restartNeeded };
}
