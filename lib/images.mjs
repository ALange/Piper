/**
 * Images: the environments chats can run in, building them, and keeping the disk tidy.
 *
 * An environment is a folder with a Dockerfile. `docker/Dockerfile` is the `full` environment and
 * builds to `piper-agent` (the name every existing setup already uses); any other lives in
 * `docker/environments/<name>/Dockerfile` and builds to `piper-agent-<name>`. Every one is built with
 * the Pi version this gateway runs, and carries the labels `piper.image=1` and `piper.pi-version`,
 * which are how an image is recognised as Piper's and how a stale one is noticed.
 *
 * Builds run one at a time, in the background, with their output kept for the page. Removing an
 * image is refused while a container or a setting uses it.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_DIR, config } from "./settings.mjs";
import { ENGINE_BIN, EngineError, inspectMany, listManaged, runDocker } from "./engine.mjs";
import { apiKeys } from "./auth.mjs";
import { audit } from "./audit.mjs";
import { hostPiVersion } from "./containers.mjs";

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MB = 1024 * 1024;

/** The environments there are: `full` and one per folder under docker/environments. */
export function listEnvironments(root = join(GATEWAY_DIR, "docker")) {
	const out = [];
	if (existsSync(join(root, "Dockerfile"))) out.push({ name: "full", tag: "piper-agent", dockerfile: join(root, "Dockerfile"), context: root });
	const base = join(root, "environments");
	let names = [];
	try {
		names = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort();
	} catch {
		/* no other environments */
	}
	for (const name of names) {
		if (name === "full" || !existsSync(join(base, name, "Dockerfile"))) continue;
		out.push({ name, tag: `piper-agent-${name}`, dockerfile: join(base, name, "Dockerfile"), context: join(base, name) });
	}
	return out;
}

/** The environment an image tag belongs to, by its name, or null for one that is not Piper's naming. */
export function environmentOfTag(tag) {
	const bare = String(tag).replace(/:latest$/, "");
	if (bare === "piper-agent") return "full";
	const match = /^piper-agent-([a-z0-9-]+)$/.exec(bare);
	return match ? match[1] : null;
}

/** The `docker build` command line for an environment, pinned to a Pi version. */
export function buildArgs(env, piVersion) {
	return ["build", "-t", env.tag, "-f", env.dockerfile, "--build-arg", `PI_VERSION=${piVersion}`, "--label", `piper.env=${env.name}`, env.context];
}

/**
 * The images Piper built: tag, id, size, Pi version, and what uses each (containers, keys, the
 * default). Untagged ones (a rebuilt image's predecessor) are listed too, since they still cost disk.
 */
export async function listImages({ hostPi = null } = {}) {
	const host = hostPi ?? (await hostPiVersion());
	const result = await runDocker(["images", "-a", "--filter", "label=piper.image=1", "--no-trunc", "--format", "{{json .}}"]);
	const rows = [];
	for (const line of result.stdout.split("\n").filter(Boolean)) {
		try {
			const r = JSON.parse(line);
			rows.push({ id: r.ID, repository: r.Repository, tag: r.Tag, created: r.CreatedSince, size: r.Size });
		} catch {
			/* a partial line */
		}
	}
	// Labels are not in `images`; one inspect gets them, and the sizes in bytes.
	const details = new Map();
	if (rows.length) {
		const inspected = await runDocker(["image", "inspect", ...new Set(rows.map((r) => r.id))]);
		try {
			for (const d of JSON.parse(inspected.stdout || "[]")) details.set(d.Id, d);
		} catch {
			/* unreadable: no details */
		}
	}
	const managed = await listManaged();
	const containers = await inspectMany(managed.map((c) => c.name));
	const usedBy = (id) => [...containers.values()].filter((c) => c.Image === id).length;
	const keyImages = new Map();
	for (const k of apiKeys.list()) if (k.container?.image) keyImages.set(k.container.image, [...(keyImages.get(k.container.image) ?? []), k.name]);
	const images = rows.map((r) => {
		const d = details.get(r.id);
		const name = r.repository && r.repository !== "<none>" ? `${r.repository}${r.tag && r.tag !== "latest" ? `:${r.tag}` : ""}` : null;
		const piVersion = d?.Config?.Labels?.["piper.pi-version"] ?? "";
		return {
			id: r.id,
			name,
			env: d?.Config?.Labels?.["piper.env"] ?? (name ? environmentOfTag(name) : null),
			piVersion,
			stale: Boolean(host && piVersion && piVersion !== host),
			sizeMb: d?.Size ? Math.round(d.Size / MB) : null,
			created: r.created,
			containers: usedBy(r.id),
			keys: name ? keyImages.get(name) ?? [] : [],
			isDefault: name === config.CONTAINER_IMAGE || name === `${config.CONTAINER_IMAGE}:latest`,
			untagged: !name,
		};
	});
	const envs = listEnvironments().map((e) => {
		const built = images.find((i) => i.name === e.tag);
		return { name: e.name, tag: e.tag, built: Boolean(built), piVersion: built?.piVersion ?? null, stale: built?.stale ?? false, containersToRecreate: built ? containersOn(built.id, containers) : 0 };
	});
	return { images, environments: envs, hostPiVersion: host, job: jobView() };
}

const containersOn = (id, containers) => [...containers.values()].filter((c) => c.Image === id).length;

// ---------------------------------------------------------------------------------------------
// Builds: one at a time, in the background, with the output kept
// ---------------------------------------------------------------------------------------------

let job = null;
let jobCounter = 0;
const LOG_LINES = 300;

/** The current or last build, for the page. Its log is the last 300 lines. */
export function jobView() {
	return job ? { id: job.id, env: job.env, tag: job.tag, state: job.state, startedAt: job.startedAt, endedAt: job.endedAt, code: job.code, lines: job.lines.slice(-LOG_LINES) } : null;
}

/**
 * Start building an environment. Returns the job at once; the build carries on in the background and
 * the page polls `jobView()`. Only one runs at a time: a second is refused while the first is going.
 * `spawnFn` and `piVersion` are parameters for the tests.
 */
export async function buildImage(envName, { spawnFn = spawn, piVersion } = {}) {
	if (job?.state === "running") throw new EngineError(`a build is already running (${job.env}); wait for it to finish`, 409);
	const env = listEnvironments().find((e) => e.name === envName);
	if (!env) throw new EngineError(`no environment "${envName}": add docker/environments/${NAME.test(String(envName)) ? envName : "<name>"}/Dockerfile`, 404);
	const pi = piVersion ?? (await hostPiVersion());
	if (!pi) throw new EngineError("cannot tell which Pi version to build for: Pi was not found", 503);
	const started = Date.now();
	job = { id: ++jobCounter, env: env.name, tag: env.tag, state: "running", startedAt: started, endedAt: null, code: null, lines: [`building ${env.tag} for Pi ${pi}`] };
	const current = job;
	audit("image.build", env.tag, `Pi ${pi}`);
	const child = spawnFn(ENGINE_BIN, buildArgs(env, pi), { stdio: ["ignore", "pipe", "pipe"] });
	const take = (chunk) => {
		for (const line of String(chunk).split(/\r?\n|\r/).filter(Boolean)) current.lines.push(line.slice(0, 400));
		if (current.lines.length > LOG_LINES * 2) current.lines.splice(0, current.lines.length - LOG_LINES);
	};
	child.stdout?.on("data", take);
	child.stderr?.on("data", take);
	child.on("error", (err) => {
		current.state = "failed";
		current.endedAt = Date.now();
		current.lines.push(`could not run docker: ${err.message}`);
	});
	child.on("close", (code) => {
		if (current.state === "failed") return;
		current.code = code;
		current.state = code === 0 ? "done" : "failed";
		current.endedAt = Date.now();
		current.lines.push(code === 0 ? `built ${env.tag} in ${Math.round((current.endedAt - started) / 1000)} s` : `the build failed (exit ${code})`);
	});
	return jobView();
}

// ---------------------------------------------------------------------------------------------
// Removing images
// ---------------------------------------------------------------------------------------------

/** Remove an image by name or id, but never one a container, a key or the default setting uses, and only Piper's own. */
export async function removeImage(ref, { hostPi = null } = {}) {
	const wanted = String(ref ?? "").trim();
	if (!wanted) throw new EngineError("say which image to remove", 400);
	const { images } = await listImages({ hostPi });
	// A name, a full id, or the start of an id (at least eight characters, so a short string cannot pick one by accident).
	const bare = wanted.replace(/^sha256:/, "");
	const target = images.find((i) => i.id === wanted || i.name === wanted || (bare.length >= 8 && i.id.replace(/^sha256:/, "").startsWith(bare)));
	if (!target) throw new EngineError(`"${ref}" is not one of Piper's images`, 404);
	if (target.isDefault) throw new EngineError(`${target.name} is the default image (CONTAINER_IMAGE): change that setting first`, 409);
	if (target.keys.length) throw new EngineError(`${target.name} is set as the image of ${target.keys.join(", ")}: change that first`, 409);
	if (target.containers) throw new EngineError(`${target.containers} container(s) are built from it: recreate or remove them first`, 409);
	const result = await runDocker(["rmi", target.name ?? target.id]);
	if (result.code !== 0) throw new EngineError(`docker could not remove it: ${(result.stderr || result.stdout).trim().split("\n").pop()}`, 409);
	audit("image.remove", target.name ?? target.id, `${target.sizeMb ?? "?"} MB`);
	return `removed ${target.name ?? target.id.slice(0, 19)}`;
}

/** Remove Piper's untagged images (what a rebuild leaves behind). Returns what docker said was reclaimed. */
export async function pruneImages() {
	const result = await runDocker(["image", "prune", "-f", "--filter", "label=piper.image=1"]);
	if (result.code !== 0) throw new EngineError(`docker could not prune: ${(result.stderr || result.stdout).trim().split("\n").pop()}`, 500);
	const reclaimed = /Total reclaimed space:\s*(.+)/.exec(result.stdout)?.[1]?.trim() ?? "nothing";
	audit("image.prune", "untagged piper images", reclaimed);
	return `removed untagged images: reclaimed ${reclaimed}`;
}

/** Forget the last build (tests). */
export function resetImageJob() {
	job = null;
}

