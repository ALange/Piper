/**
 * Update a container: rebuild it with the settings it would get now, keeping what is installed in it,
 * then bring Pi and its extensions up to date.
 *
 * Reset (remove the container and its saved state) is the way to start clean. This is the other one:
 * the agent's system (Tor, apt packages, files in /root) stays, and the container is made again from a
 * saved copy of it, with today's mounts, limits, bundles and DNS files. Then, inside it:
 *
 *   - Pi is set to the version the gateway itself runs. The container's `pi --mode rpc` has to speak
 *     the gateway's protocol, so this is deliberately not "the newest release": a newer Pi is reached by
 *     updating the host's first.
 *   - `pi update --extensions` brings the profile's packages up to date. They live in the profile (a host
 *     folder), so they survive any rebuild; it is skipped when the profile is locked by the operator or is
 *     a throwaway copy (frozen or over its quota), where the update would be lost.
 *
 * Runs are jobs, one at a time, like image builds: the page starts one and polls for its log.
 */
import { EngineError, chatIdHash, chatKeyOfContainer, execIn, execStream, imageInfo, inspectMany, isKeyContainer, listManaged, rebuildContainer, stopContainer } from "./engine.mjs";
import { agentScope, agents } from "./agents.mjs";
import { apiKeys, keyLabel } from "./auth.mjs";
import { containerSpecFor, diskState, hostPiVersion, noteUpdate, prepareContainerFolders } from "./containers.mjs";
import { ensureWorkspace, isProfileLocked, profileWritability } from "./profiles.mjs";
import { profileRoot, scopeOf } from "./paths.mjs";
import { sessions } from "./sessions.mjs";
import { audit } from "./audit.mjs";
import { manageability, updateHostPi } from "./hostpi.mjs";
import { noteChanged } from "./piversions.mjs";
import { join } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const LOG_LINES = 300;
const GB = 1024 * 1024 * 1024;

/** What a container is, from its labels and name, and what is running in it. Throws 404 for one nothing owns. */
export async function resolveTarget(name) {
	const key = chatKeyOfContainer(name);
	if (key === null) throw new EngineError(`${name} is not one of this gateway's containers`, 404);
	const details = (await inspectMany([name])).get(name);
	if (!details) throw new EngineError(`no container ${name}`, 404);
	const labels = details.Config?.Labels ?? {};
	const keyId = labels["piper.key"] || null;
	const agentId = labels["piper.agent"] || null;
	if (isKeyContainer(name)) {
		const scopeId = agentId ? agentScope(keyId, agentId) : keyId;
		const owned = agentId ? agents.get(agentId) : apiKeys.get(keyId)?.container?.persistent;
		if (!owned) throw new EngineError(`${name} belongs to nothing any more (its key or agent is gone, or is no longer persistent): remove it instead`, 404);
		const chats = sessions.recordsByScope(scopeId).filter((r) => r.container?.name === name);
		return { name, kind: agentId ? "agent" : "key", keyId, agentId, scopeId, persistent: true, chats, record: { keyId, scopeId, agentId, id: `update:${name}` }, workspace: ensureWorkspace(scopeId), label: keyLabel(scopeId) };
	}
	const live = sessions.liveByChatKey().get(key);
	const row = sessions.storedRows().find((r) => r.id_hash.startsWith(key));
	if (!live && !row) throw new EngineError(`${name} belongs to no chat any more: remove it instead`, 404);
	const owner = live ? live.keyId ?? null : row.key_id ?? null;
	return {
		name, kind: "chat", keyId: owner, agentId: null, scopeId: owner, persistent: false,
		chats: live ? [live] : [],
		record: { keyId: owner, scopeId: owner, idHash: live ? chatIdHash(live.id) : row.id_hash },
		workspace: live ? live.workspace : row.workspace,
		label: `${keyLabel(owner)} chat ${(live ? chatIdHash(live.id) : row.id_hash).slice(0, 8)}`,
	};
}

/** The version a `pi --version` line holds, or "". */
const versionIn = (text) => /(\d+\.\d+\.\d+[\w.+-]*)/.exec(String(text))?.[1] ?? "";

/**
 * Update one container. `log` gets every line of what happens. Returns {steps, piFrom, piTo}: each step
 * `{name, state: "done"|"skipped"|"failed", detail}`. A step that fails does not stop the next one: a
 * failed npm install still leaves a rebuilt container, and its extensions can still be updated.
 * Throws (and changes nothing) when a request is running in it or the disk has no room to save it.
 */
export async function updateContainer(name, log = () => {}, { spawnFn } = {}) {
	const t = await resolveTarget(name);
	if (t.chats.some((r) => r.inflight > 0)) throw new EngineError("a request is running in it; try again when it has finished", 409);
	// Saving the state copies what the container wrote; on a tight disk that can fill it.
	const written = diskState.containers.get(name)?.rw ?? 0;
	const free = diskState.host?.freeBytes;
	if (free !== undefined && written && free < written + GB) {
		throw new EngineError(`not enough disk to save its state: ${(written / GB).toFixed(1)} GB written, ${(free / GB).toFixed(1)} GB free (1 GB must stay free)`, 507);
	}
	if (t.chats.length) {
		log(`stopping ${t.chats.length} chat(s) in it; each resumes on its next message`);
		const stopping = t.chats;
		for (const r of stopping) sessions.hibernate(r.id);
		await Promise.all(stopping.map((r) => r.stopped));
	}
	const spec = containerSpecFor(t.record, t.workspace);
	const image = await imageInfo(spec.image);
	if (!image) throw new EngineError(`the image "${spec.image}" does not exist: build it first`, 503);
	prepareContainerFolders(spec, t.keyId);
	const steps = [];
	const step = async (stepName, fn) => {
		try {
			const result = await fn();
			steps.push({ name: stepName, ...result });
			log(`${stepName}: ${result.state}${result.detail ? ` (${result.detail})` : ""}`);
		} catch (err) {
			steps.push({ name: stepName, state: "failed", detail: err?.message ?? String(err) });
			log(`${stepName}: failed (${err?.message ?? err})`);
		}
	};
	let piFrom = "";
	let piTo = "";

	log("rebuilding it with the current settings, keeping what is installed…");
	const rebuilt = await rebuildContainer(spec, image.id, { spawnFn });
	log(rebuilt.rebuilt ? `rebuilt from its saved state${rebuilt.flattened ? " (flattened: it had many layers)" : ""}` : "it had no container yet; created");
	steps.push({ name: "rebuild", state: "done", detail: rebuilt.rebuilt ? "state kept" : "created" });

	const noNetwork = spec.network === "none";
	await step("pi", async () => {
		const target = await hostPiVersion();
		if (!target) return { state: "skipped", detail: "cannot tell which Pi version the gateway runs" };
		piFrom = versionIn((await execIn(name, "pi --version 2>&1 | tail -n 1", 30_000)).stdout);
		piTo = piFrom;
		if (piFrom === target) return { state: "done", detail: `already ${target}` };
		if (noNetwork) return { state: "skipped", detail: `is ${piFrom || "unknown"}, the gateway runs ${target}; no network in this container's policy to install it` };
		log(`Pi is ${piFrom || "unknown"}, the gateway runs ${target}: installing ${target}`);
		const run = await execStream(name, ["npm", "install", "-g", "--ignore-scripts", `${PI_PACKAGE}@${target}`], { onLine: log, timeoutMs: 600_000, spawnFn });
		if (run.code !== 0) return { state: "failed", detail: run.timedOut ? "timed out" : `npm exited ${run.code}` };
		piTo = versionIn((await execIn(name, "pi --version 2>&1 | tail -n 1", 30_000)).stdout);
		return piTo === target ? { state: "done", detail: `${piFrom || "unknown"} -> ${piTo}` } : { state: "failed", detail: `installed, but pi reports ${piTo || "nothing"}` };
	});

	await step("extensions", async () => {
		const scope = scopeOf(t.scopeId);
		if (isProfileLocked(scope)) return { state: "skipped", detail: "the profile is locked by the operator" };
		if (!profileWritability(t.scopeId, join(profileRoot(), scope)).writable) return { state: "skipped", detail: "the profile is frozen or over its limit, so an update would be lost" };
		if (noNetwork) return { state: "skipped", detail: "no network in this container's policy" };
		// Not PI_OFFLINE: the whole point is to reach the registry. Stdin is closed, so nothing can ask.
		const env = { HOME: "/root", PI_CODING_AGENT_DIR: "/profile", PI_CONFIG_DIR: "/profile/config", PI_TELEMETRY: "0" };
		const run = await execStream(name, ["pi", "update", "--extensions"], { env, cwd: "/profile", onLine: log, timeoutMs: 600_000, spawnFn });
		if (run.code !== 0) return { state: "failed", detail: run.timedOut ? "timed out" : `pi exited ${run.code}` };
		return { state: "done", detail: "" };
	});

	// Its Pi may just have changed: read it again rather than show the old figure for ten minutes.
	noteChanged(name);
	// A chat's own container waits stopped, as it does between messages; a persistent one keeps running.
	if (!t.persistent) await stopContainer(name).catch(() => {});
	const failed = steps.filter((s) => s.state === "failed").map((s) => s.name);
	const summary = `${steps.map((s) => `${s.name} ${s.state}`).join(", ")}${piFrom && piTo && piFrom !== piTo ? `; Pi ${piFrom} -> ${piTo}` : ""}`;
	noteUpdate(name, { at: Date.now(), piFrom, piTo, steps: steps.map((s) => `${s.name}: ${s.state}`), failed });
	audit("container.update", name, summary);
	return { steps, piFrom, piTo, failed };
}

// ---------------------------------------------------------------------------------------------
// Jobs: one at a time, in the background, with the log kept for the page
// ---------------------------------------------------------------------------------------------

let job = null;
let counter = 0;

/** The current or last update job, for the page. */
export function updateJobView() {
	return job ? { id: job.id, state: job.state, startedAt: job.startedAt, endedAt: job.endedAt, items: job.items.map((i) => ({ name: i.name, label: i.label, state: i.state, lines: i.lines.slice(-LOG_LINES) })) } : null;
}

export function resetUpdateJob() {
	job = null;
}

/**
 * Run a list of things one after another as the job, returning it at once. Each entry is
 * `{name, label, run(log) -> {failed: []}}`. One that throws a 409 or 404 (busy, or belongs to nothing) is
 * skipped and says why; one that fails does not stop the rest. Only one job runs at a time, whatever it is:
 * a host Pi update and a container update never overlap.
 */
export function startJob(entries) {
	if (job?.state === "running") throw new EngineError("an update is already running; wait for it to finish", 409);
	if (!entries.length) throw new EngineError("there is nothing to update", 404);
	const current = { id: ++counter, state: "running", startedAt: Date.now(), endedAt: null, items: entries.map((e) => ({ name: e.name, label: e.label, state: "queued", lines: [] })) };
	job = current;
	void (async () => {
		for (const [index, item] of current.items.entries()) {
			item.state = "running";
			const log = (line) => {
				item.lines.push(line);
				if (item.lines.length > LOG_LINES * 2) item.lines.splice(0, item.lines.length - LOG_LINES);
			};
			try {
				const result = await entries[index].run(log);
				item.state = result.failed.length ? "failed" : "done";
			} catch (err) {
				const skip = err instanceof EngineError && (err.status === 409 || err.status === 404);
				log(`${skip ? "skipped" : "failed"}: ${err?.message ?? err}`);
				item.state = skip ? "skipped" : "failed";
			}
		}
		current.state = current.items.some((i) => i.state === "failed") ? "failed" : "done";
		current.endedAt = Date.now();
	})();
	return updateJobView();
}

/**
 * Start updating these containers, one after another, and return the job at once. `names` is checked up
 * front so an unknown container is a 404 here, not a line in a log (Update all passes `lenient` and lets
 * each item decide).
 */
export async function startUpdate(names, { lenient = false, spawnFn } = {}) {
	if (job?.state === "running") throw new EngineError("an update is already running; wait for it to finish", 409);
	const labels = new Map();
	for (const name of names) {
		try {
			labels.set(name, (await resolveTarget(name)).label);
		} catch (err) {
			if (!lenient) throw err;
			labels.set(name, name.replace(/^piper-/, ""));
		}
	}
	return startJob(names.map((name) => ({ name, label: labels.get(name), run: (log) => updateContainer(name, log, { spawnFn }) })));
}

/** Update the Pi the gateway runs on, and/or its extensions, as a job. The caller has checked a dashboard password is set. */
export async function startHostPiUpdate(options = {}, { spawnFn, run, packageDir } = {}) {
	// The job check comes first: nothing is looked at, let alone run, while another job is going.
	if (job?.state === "running") throw new EngineError("an update is already running; wait for it to finish", 409);
	const manage = await manageability({ run, ...(packageDir ? { packageDir } : {}) });
	if (!manage.ok) throw new EngineError(manage.reason, 409);
	return startJob([{ name: "host:pi", label: "Pi on this host", run: (log) => updateHostPi(options, log, { spawnFn, run, ...(packageDir ? { packageDir } : {}) }) }]);
}

/** Every container this gateway made, updated in turn. */
export async function startUpdateAll(opts = {}) {
	const names = (await listManaged()).map((c) => c.name);
	return startUpdate(names, { ...opts, lenient: true });
}

/** The containers a profile scope uses: a key's own (persistent, or its chats') or one agent's. */
export async function containersOfScope(scopeId) {
	const agentId = scopeId?.includes("--") ? scopeId.slice(scopeId.indexOf("--") + 2) : null;
	const keyId = agentId ? scopeId.slice(0, scopeId.indexOf("--")) : scopeId;
	return (await listManaged()).filter((c) => (c.keyId || null) === (keyId || null) && (agentId ? c.agentId === agentId : !c.agentId)).map((c) => c.name);
}
