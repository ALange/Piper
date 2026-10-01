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
import { ENGINE_BIN, EngineError, inspectMany, instanceId, listManaged, removeContainer, runDocker } from "./engine.mjs";
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
 * Every container on the machine with what it is: this gateway's, another Piper gateway's, a leftover Piper helper
 * (`piper-pkg-…`), or something Piper did not make at all. Docker refuses to delete an image any of them refers to,
 * so all of them have to be known; only Piper's own may ever be offered for removal.
 */
async function piperContainers() {
	const own = new Set((await listManaged()).map((c) => c.name));
	const everyone = await runDocker(["ps", "-a", "--format", "{{.Names}}"]);
	const names = new Set(own);
	if (everyone.code === 0) for (const line of everyone.stdout.split("\n").filter(Boolean)) names.add(line.split("\t")[0]);
	const info = await inspectMany([...names]);
	return [...names].map((name) => {
		const i = info.get(name) ?? {};
		const labels = i.Config?.Labels ?? {};
		return {
			name,
			imageId: i.Image ?? null,
			// A container whose state is unknown is treated as running: never removed on a guess.
			running: i.State ? i.State.Running !== false : true,
			persistent: labels["piper.persistent"] === "1",
			own: own.has(name),
			// Made by Piper (any gateway), or a Piper helper: the only kind that may be removed to free an image.
			piper: own.has(name) || labels["piper.managed"] === "1" || /^piper-/.test(name),
			keyId: labels["piper.key"] || null,
			agentId: labels["piper.agent"] || null,
		};
	});
}

const parseImageRows = (stdout) => {
	const rows = [];
	for (const line of String(stdout).split("\n").filter(Boolean)) {
		try {
			const r = JSON.parse(line);
			rows.push({ id: r.ID, repository: r.Repository, tag: r.Tag, created: r.CreatedSince, size: r.Size });
		} catch {
			/* a partial line */
		}
	}
	return rows;
};

/**
 * The images Piper built: tag, id, size, Pi version, and what uses each (containers, keys, the
 * default). Untagged ones (a rebuilt image's predecessor) are listed too, since they still cost disk.
 * Each says which containers hold it: running ones, idle ones (stopped chat containers), kept ones
 * (a key's or agent's persistent container) and ones that belong to another Piper gateway on this
 * machine, which Docker counts as users but this gateway's own list never showed.
 */
export async function listImages({ hostPi = null } = {}) {
	const host = hostPi ?? (await hostPiVersion());
	const result = await runDocker(["images", "-a", "--filter", "label=piper.image=1", "--no-trunc", "--format", "{{json .}}"]);
	// A saved state is a commit of a Piper container, so it carries the image label too: it is listed as a state, not as an image.
	const rows = parseImageRows(result.stdout).filter((r) => r.repository !== "piper-keystate");
	// Saved container states (what an update keeps) and dangling images with no Piper label (a build's leftovers, or not Piper's at all).
	const stateRows = parseImageRows((await runDocker(["images", "--filter", "reference=piper-keystate", "--no-trunc", "--format", "{{json .}}"])).stdout).filter((r) => r.repository === "piper-keystate");
	const known = new Set([...rows, ...stateRows].map((r) => r.id));
	const danglingRows = parseImageRows((await runDocker(["images", "--filter", "dangling=true", "--no-trunc", "--format", "{{json .}}"])).stdout).filter((r) => !known.has(r.id));
	// Labels are not in `images`; one inspect gets them, and the sizes in bytes.
	const details = new Map();
	const everyRow = [...rows, ...stateRows, ...danglingRows];
	if (everyRow.length) {
		const inspected = await runDocker(["image", "inspect", ...new Set(everyRow.map((r) => r.id))]);
		try {
			for (const d of JSON.parse(inspected.stdout || "[]")) details.set(d.Id, d);
		} catch {
			/* unreadable: no details */
		}
	}
	const containers = await piperContainers();
	const holders = (id) => containers.filter((c) => c.imageId === id || (c.imageId && id && c.imageId.replace(/^sha256:/, "") === id.replace(/^sha256:/, "")));
	const keyImages = new Map();
	for (const k of apiKeys.list()) if (k.container?.image) keyImages.set(k.container.image, [...(keyImages.get(k.container.image) ?? []), k.name]);
	const images = rows.map((r) => {
		const d = details.get(r.id);
		const name = r.repository && r.repository !== "<none>" ? `${r.repository}${r.tag && r.tag !== "latest" ? `:${r.tag}` : ""}` : null;
		const piVersion = d?.Config?.Labels?.["piper.pi-version"] ?? "";
		const held = holders(r.id);
		return {
			id: r.id,
			name,
			env: d?.Config?.Labels?.["piper.env"] ?? (name ? environmentOfTag(name) : null),
			piVersion,
			stale: Boolean(host && piVersion && piVersion !== host),
			sizeMb: d?.Size ? Math.round(d.Size / MB) : null,
			created: r.created,
			containers: held.length,
			running: held.filter((c) => c.running).length,
			idle: held.filter((c) => !c.running && !c.persistent && c.piper).map((c) => c.name),
			kept: held.filter((c) => !c.running && c.persistent).map((c) => c.name),
			// Containers that are not Piper's (and not running): they hold the image but are never Piper's to remove.
			outside: held.filter((c) => !c.running && !c.piper).map((c) => c.name),
			foreign: held.filter((c) => !c.own && c.piper).length,
			keys: name ? keyImages.get(name) ?? [] : [],
			isDefault: name === config.CONTAINER_IMAGE || name === `${config.CONTAINER_IMAGE}:latest`,
			untagged: !name,
		};
	});
	const stateOf = (r) => {
		const d = details.get(r.id);
		const container = `piper-${String(r.tag)}`;
		return { id: r.id, name: `${r.repository}:${r.tag}`, container, sizeMb: d?.Size ? Math.round(d.Size / MB) : null, created: r.created, orphan: !containers.some((c) => c.name === container) };
	};
	const envs = listEnvironments().map((e) => {
		const built = images.find((i) => i.name === e.tag);
		return { name: e.name, tag: e.tag, built: Boolean(built), piVersion: built?.piVersion ?? null, stale: built?.stale ?? false, containersToRecreate: built ? containersOn(built.id, containers) : 0 };
	});
	return {
		images,
		states: stateRows.map(stateOf),
		dangling: danglingRows.map((r) => ({ id: r.id, sizeMb: details.get(r.id)?.Size ? Math.round(details.get(r.id).Size / MB) : null, created: r.created })),
		environments: envs,
		hostPiVersion: host,
		job: jobView(),
	};
}

const containersOn = (id, containers) => containers.filter((c) => c.imageId === id).length;

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
		// The build this one replaced is now untagged: if nothing uses it, it goes.
		if (code === 0 && config.IMAGE_AUTO_PRUNE !== false && spawnFn === spawn) void autoPrune().then((r) => r.removed && current.lines.push(`removed ${r.removed} superseded image(s), ${r.reclaimedMb} MB`)).catch(() => {});
	});
	return jobView();
}

// ---------------------------------------------------------------------------------------------
// Removing images
// ---------------------------------------------------------------------------------------------

/** An error that says "this needs the person's go-ahead": the same request with `force` removes what is named. */
export class NeedsForce extends EngineError {
	constructor(message) {
		super(message, 409);
		this.errorCode = "needs_force";
	}
}

/**
 * Remove an image by name or id, but never one the default setting or a key uses, one a container is running from, or
 * one a key's or agent's kept container is built on. Stopped chat containers that hold an image are what usually keep an old
 * one alive (Docker will not delete an image any container refers to, running or not): they are named, and with `force` they are
 * removed first. That loses what was installed inside them; their conversations, files and profiles are not touched.
 */
export async function removeImage(ref, { hostPi = null, force = false } = {}) {
	const wanted = String(ref ?? "").trim();
	if (!wanted) throw new EngineError("say which image to remove", 400);
	const { images, states, dangling } = await listImages({ hostPi });
	// A name, a full id, or the start of an id (at least eight characters, so a short string cannot pick one by accident).
	const bare = wanted.replace(/^sha256:/, "");
	const matches = (i) => i.id === wanted || i.name === wanted || (bare.length >= 8 && i.id.replace(/^sha256:/, "").startsWith(bare));
	const state = states.find(matches);
	if (state) return removeState(state);
	const target = images.find(matches) ?? dangling.find(matches);
	if (!target) throw new EngineError(`"${ref}" is not one of Piper's images`, 404);
	if (target.isDefault) throw new EngineError(`${target.name} is the default image (CONTAINER_IMAGE): change that setting first`, 409);
	if (target.keys?.length) throw new EngineError(`${target.name} is set as the image of ${target.keys.join(", ")}: change that first`, 409);
	if (target.running) throw new EngineError(`${target.running} container(s) are running from it: stop or recreate them first`, 409);
	if (target.outside?.length) throw new EngineError(`${target.outside.join(", ")} is built from it but is not a Piper container, so Piper will not remove it: remove it yourself (docker rm) if you do not need it`, 409);
	if (target.kept?.length) throw new EngineError(`${target.kept.join(", ")} (a key's or agent's kept container) is built on it: update or reset that container first (Containers)`, 409);
	if (target.idle?.length) {
		const foreign = target.foreign ? ` (${target.foreign} of them belong to another Piper gateway on this machine)` : "";
		if (!force) throw new NeedsForce(`${target.idle.length} stopped container(s) are built from it${foreign}: ${target.idle.slice(0, 4).join(", ")}${target.idle.length > 4 ? ", …" : ""}. Remove them too? What was installed inside them is lost; chats, files and profiles are kept.`);
		for (const name of target.idle) await removeContainer(name);
	}
	const result = await runDocker(["rmi", target.name ?? target.id]);
	if (result.code !== 0) throw new EngineError(`docker could not remove it: ${(result.stderr || result.stdout).trim().split("\n").pop()}`, 409);
	audit("image.remove", target.name ?? target.id, `${target.sizeMb ?? "?"} MB${target.idle?.length ? `; ${target.idle.length} stopped container(s) removed first` : ""}`);
	return `removed ${target.name ?? target.id.slice(0, 19)}${target.idle?.length ? ` and ${target.idle.length} stopped container(s)` : ""}`;
}

async function removeState(state) {
	if (!state.orphan) throw new EngineError(`${state.name} is the saved state of ${state.container}, which still exists: it is removed with that container`, 409);
	const result = await runDocker(["rmi", "-f", state.name]);
	if (result.code !== 0) throw new EngineError(`docker could not remove it: ${(result.stderr || result.stdout).trim().split("\n").pop()}`, 409);
	audit("image.remove", state.name, `${state.sizeMb ?? "?"} MB (saved state of a container that is gone)`);
	return `removed ${state.name}`;
}

// ---------------------------------------------------------------------------------------------
// Cleaning up: a plan first, then only what was chosen
// ---------------------------------------------------------------------------------------------

/**
 * What could be cleaned up, each with the reason and the cost of doing it:
 *   safe        nothing uses it: a superseded build, a saved state whose container is gone, an old-Pi image nothing runs on
 *   containers  only stopped chat containers hold it: removing the image removes them too (what was installed in them is lost)
 *   rebuild     in date but not the default and unused: removing it means building it again if a key asks for it
 *   other       an untagged image with no Piper label: perhaps a build's leftovers, perhaps another tool's: never preselected
 * Never offered: the default image, one a key names, one a container is running from, one a kept (persistent) container is built on.
 */
export async function cleanupPlan({ hostPi = null } = {}) {
	const { images, states, dangling, hostPiVersion: host } = await listImages({ hostPi });
	const items = [];
	const blocked = [];
	for (const i of images) {
		const label = i.name ?? `(untagged) ${i.id.replace("sha256:", "").slice(0, 12)}`;
		const why = i.isDefault ? "the default image" : i.keys.length ? `set as the image of ${i.keys.join(", ")}` : i.running ? `${i.running} container(s) are running from it` : i.kept.length ? `a kept container is built on it (${i.kept.join(", ")})` : i.outside.length ? `${i.outside.join(", ")} is built from it and is not a Piper container` : null;
		if (why) {
			blocked.push({ name: label, sizeMb: i.sizeMb, reason: why });
			continue;
		}
		const base = { id: i.id, ref: i.name ?? i.id, name: label, sizeMb: i.sizeMb, containers: i.idle, foreign: i.foreign };
		if (i.idle.length) items.push({ ...base, kind: "containers", reason: `${i.untagged ? "an older build" : i.stale ? "built for an older Pi" : "not the default"}, held only by ${i.idle.length} stopped container(s)` });
		else if (i.untagged) items.push({ ...base, kind: "safe", reason: "an older build that nothing uses any more" });
		else if (i.stale) items.push({ ...base, kind: "safe", reason: `built for Pi ${i.piVersion}, the gateway runs ${host ?? "a newer one"}, and nothing uses it` });
		else items.push({ ...base, kind: "rebuild", reason: "not the default and nothing uses it; it is built again if a key asks for it" });
	}
	for (const st of states) {
		if (st.orphan) items.push({ id: st.id, ref: st.name, name: st.name, sizeMb: st.sizeMb, containers: [], foreign: 0, kind: "safe", reason: `the saved state of ${st.container}, which no longer exists` });
		else blocked.push({ name: st.name, sizeMb: st.sizeMb, reason: `the saved state of ${st.container}, which still exists` });
	}
	for (const d of dangling) items.push({ id: d.id, ref: d.id, name: `(untagged, no Piper label) ${d.id.replace("sha256:", "").slice(0, 12)}`, sizeMb: d.sizeMb, containers: [], foreign: 0, kind: "other", reason: "an untagged image: a build's leftover layer, or something Piper did not make" });
	const total = (kinds) => items.filter((x) => kinds.includes(x.kind)).reduce((n, x) => n + (x.sizeMb ?? 0), 0);
	return { items, blocked, safeMb: total(["safe"]), allMb: total(["safe", "containers", "rebuild", "other"]) };
}

/** Docker's refusal in words a person can act on, and whether trying again after removing other things could help. */
function explainRemoval(text, ref) {
	const line = String(text).trim().split("\n").pop().replace(/^Error response from daemon:\s*/, "");
	if (/dependent child images/i.test(line)) return { reason: "other images are built on it (a newer build or a saved container state): remove those first, then it can go", retry: true };
	if (/being used by (running|stopped) container/i.test(line)) return { reason: `a container still uses it (${line.replace(/^.*container\s+/i, "").split(/\s/)[0]}): ${line}`, retry: false };
	if (/multiple repositories|must be forced/i.test(line)) return { reason: `it carries several names (${line}): remove the others first`, retry: true };
	if (/No such image/i.test(line)) return { reason: "it is already gone", retry: false, gone: true };
	return { reason: line || `docker could not remove ${ref}`, retry: false };
}

/**
 * Do the chosen part of the plan. `select` names plan items by id; the plan is made again now, so only what is still
 * removable is touched, and an item that needs containers removed is skipped unless `withContainers` is true.
 * Saved states and containers go first, so an image they were built on can go in the same pass; one that Docker refuses
 * only because something else built on it is still there is tried once more at the end. Every refusal comes back with its
 * reason. Returns `{removed, failed, skipped, reclaimedMb}`.
 */
export async function runCleanup({ select = [], withContainers = false, hostPi = null } = {}) {
	const plan = await cleanupPlan({ hostPi });
	const chosen = new Set((Array.isArray(select) ? select : []).map(String));
	const out = { removed: [], failed: [], skipped: [], reclaimedMb: 0 };
	const todo = plan.items.filter((x) => chosen.has(x.id));
	for (const id of chosen) if (!plan.items.some((x) => x.id === id)) out.skipped.push({ name: String(id).slice(0, 40), reason: "not something that can be removed now (in use, the default, or already gone)" });
	// Saved states first (children of the images), then the rest.
	todo.sort((x, y) => Number(y.ref.startsWith("piper-keystate:")) - Number(x.ref.startsWith("piper-keystate:")));
	const attempt = async (item) => {
		for (const name of item.containers) {
			const gone = await removeContainer(name);
			if (gone && gone.code !== 0 && !/No such container/i.test(gone.stderr ?? "")) throw new Error(`could not remove its container ${name}: ${String(gone.stderr).trim().split("\n").pop()}`);
		}
		const result = await runDocker(["rmi", ...(item.ref.startsWith("piper-keystate:") ? ["-f"] : []), item.ref]);
		if (result.code !== 0) {
			const why = explainRemoval(result.stderr || result.stdout, item.ref);
			if (why.gone) return;
			const error = new Error(why.reason);
			error.retry = why.retry;
			throw error;
		}
		// Removing a tag only takes the name off when something is built on the image: it stays, untagged, and the disk is not freed.
		// Say so rather than reporting a removal that did not happen, and finish the job if nothing holds it any more.
		if (item.ref !== item.id) {
			const left = await runDocker(["image", "inspect", item.id]);
			let stillThere = false;
			try {
				stillThere = left.code === 0 && JSON.parse(left.stdout || "[]").some((d) => d.Id === item.id && !(d.RepoTags ?? []).length);
			} catch {
				/* unreadable: assume gone */
			}
			if (stillThere) {
				const second = await runDocker(["rmi", item.id]);
				if (second.code !== 0) {
					const why = explainRemoval(second.stderr || second.stdout, item.id);
					if (!why.gone) {
						const error = new Error(`its name was removed, but the image itself stays: ${why.reason}`);
						error.retry = why.retry;
						throw error;
					}
				}
			}
		}
	};
	const again = [];
	for (const item of todo) {
		if (item.kind === "containers" && !withContainers) {
			out.skipped.push({ name: item.name, reason: "its stopped containers were not to be removed" });
			continue;
		}
		try {
			await attempt(item);
			out.removed.push(item.name);
			out.reclaimedMb += item.sizeMb ?? 0;
		} catch (err) {
			if (err.retry) again.push(item);
			else out.failed.push({ name: item.name, reason: err.message });
		}
	}
	for (const item of again) {
		try {
			await attempt(item);
			out.removed.push(item.name);
			out.reclaimedMb += item.sizeMb ?? 0;
		} catch (err) {
			out.failed.push({ name: item.name, reason: err.message });
		}
	}
	if (out.removed.length || out.failed.length) audit("image.cleanup", "images", `${out.removed.length} removed (${out.reclaimedMb} MB)${out.failed.length ? `, ${out.failed.length} failed: ${out.failed.map((f) => `${f.name}: ${f.reason}`).join("; ").slice(0, 250)}` : ""}`);
	return out;
}

/** The part that is always safe: superseded builds and saved states of containers that are gone. Used after a build and hourly. */
export async function autoPrune() {
	const plan = await cleanupPlan();
	const safe = plan.items.filter((x) => x.kind === "safe" && (!x.name || x.name.startsWith("(untagged)") || x.ref.startsWith("piper-keystate:")));
	if (!safe.length) return { removed: 0, reclaimedMb: 0 };
	const done = await runCleanup({ select: safe.map((x) => x.id) });
	if (done.removed.length) audit("image.autoprune", "images", `${done.removed.length} unused image(s), ${done.reclaimedMb} MB`, { actor: "system" });
	return { removed: done.removed.length, reclaimedMb: done.reclaimedMb };
}

let housekeeping = null;
/** Tidy up now and then, without being asked: an hour after start and every six hours. `IMAGE_AUTO_PRUNE` switches it off. */
export function startImageHousekeeping() {
	if (housekeeping) return;
	const run = () => {
		if (config.IMAGE_AUTO_PRUNE === false) return;
		void autoPrune().catch(() => {});
	};
	housekeeping = setInterval(run, 6 * 3_600_000);
	housekeeping.unref?.();
	setTimeout(run, 60 * 60_000).unref?.();
}

/** Remove Piper's untagged images (what a rebuild leaves behind), and anything else that is plainly unused. */
export async function pruneImages() {
	const result = await runDocker(["image", "prune", "-f", "--filter", "label=piper.image=1"]);
	if (result.code !== 0) throw new EngineError(`docker could not prune: ${(result.stderr || result.stdout).trim().split("\n").pop()}`, 500);
	const reclaimed = /Total reclaimed space:\s*(.+)/.exec(result.stdout)?.[1]?.trim() ?? "nothing";
	audit("image.prune", "untagged piper images", reclaimed);
	// What docker's prune cannot reach: saved states of vanished containers, and builds a stopped container's absence now frees.
	const more = await autoPrune().catch(() => ({ removed: 0, reclaimedMb: 0 }));
	return `removed untagged images: reclaimed ${reclaimed}${more.removed ? `; also ${more.removed} more that nothing used (${more.reclaimedMb} MB)` : ""}`;
}

/** Forget the last build (tests). */
export function resetImageJob() {
	job = null;
}

