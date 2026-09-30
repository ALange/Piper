/** Profiles: each key's Pi profile, shared bundles, the key's workspace files, and the profile API. */
import { inventory } from "../piper-profile.mjs";
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GATEWAY_DIR, config, db } from "./settings.mjs";
import { allowedModelsFor, apiKeys, keyLabel } from "./auth.mjs";
import { containerSettingsFor } from "./keycontainer.mjs";
import { CONTAINER_PATHS, archiveRoot, profileRoot, scopeOf, sharedRoot, workspaceDir, workspaceRoot } from "./paths.mjs";
import { ENGINE_BIN, helperArgs } from "./engine.mjs";
import { readJson, sendError } from "./http.mjs";
import { PiRpcSession } from "./runner.mjs";
import { sessions } from "./sessions.mjs";
import { reloadSession } from "./chat.mjs";

/** The directory name of a credential's folders: one per API key, plus the open gateway and the settings key. */
export const profileScope = scopeOf;

/**
 * The profile directory for a key, created on first use.
 *
 * A profile is a Pi agent directory: settings.json, skills/, extensions/, prompts/, AGENTS.md. It
 * persists across that key's sessions and is shared by no other key. It starts from
 * PROFILE_TEMPLATE when one is set, never from your own ~/.pi/agent, which holds credentials and
 * packages that were never meant for anyone else.
 */
export function ensureProfile(keyId, { root = profileRoot(), template = config.PROFILE_TEMPLATE } = {}) {
	if (!root) throw new Error("PROFILE_ROOT is empty; containers need somewhere to keep profiles");
	const dir = join(root, profileScope(keyId));
	if (existsSync(dir)) return dir;
	mkdirSync(root, { recursive: true, mode: 0o700 });
	mkdirSync(dir, { mode: 0o700 });
	if (template && existsSync(template)) cpSync(template, dir, { recursive: true });
	// Deliberately no default model: a profile follows the default in the container config (applied
	// per chat by the bridge) until its user picks their own with /settings.
	const settingsPath = join(dir, "settings.json");
	if (!existsSync(settingsPath)) writeFileSync(settingsPath, "{}\n", { mode: 0o600 });
	return dir;
}

// A bundle is a folder under SHARED_ROOT laid out like a Pi package (skills/, extensions/,
// prompts/). It is operator-owned and mounted read-only, so unlike a profile the gateway may read
// its names freely: no session can write to it.

export const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A bundle list as typed: blank or null means "follow the default", otherwise names or *. */
export function bundleListFromInput(raw) {
	if (raw === null || raw === undefined) return null;
	const text = String(raw).trim();
	if (text === "") return null;
	if (text === "-" || text.toLowerCase() === "none") return "";
	const names = text.split(",").map((n) => n.trim()).filter(Boolean);
	for (const name of names) {
		if (name !== "*" && !BUNDLE_NAME.test(name)) throw new Error(`sharedBundles: "${name}" is not a bundle name`);
	}
	return names.join(",");
}

/** Every bundle on disk: subfolders of SHARED_ROOT with a valid name. */
export function listBundles(root = sharedRoot()) {
	if (!root) return [];
	let entries = [];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && BUNDLE_NAME.test(e.name))
		.map((e) => ({ name: e.name, path: join(root, e.name) }))
		.filter((b) => {
			try {
				return statSync(b.path).isDirectory();
			} catch {
				return false;
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The bundles a credential gets: its own list when it has one, the SHARED_BUNDLES default
 * otherwise, and every bundle for GATEWAY_API_KEY, the operator's own. Names that do not exist
 * are ignored, so granting a bundle before creating it is harmless.
 */
export function grantedBundles(keyId, { root = sharedRoot(), fallback = config.SHARED_BUNDLES } = {}) {
	const all = listBundles(root);
	if (keyId === "") return all;
	const own = keyId ? apiKeys.get(keyId)?.sharedBundles : null;
	const list = own ?? fallback ?? "";
	const names = String(list).split(",").map((n) => n.trim()).filter(Boolean);
	if (names.includes("*")) return all;
	return all.filter((b) => names.includes(b.name));
}

/** What a bundle holds, by name, for the dashboard and /profile. */
export function bundleContents(path) {
	const names = (sub, filter) => {
		try {
			return readdirSync(join(path, sub), { withFileTypes: true }).filter(filter).map((e) => e.name).sort();
		} catch {
			return [];
		}
	};
	return {
		skills: names("skills", (e) => e.isDirectory() || e.isSymbolicLink()),
		extensions: names("extensions", (e) => /\.(ts|js)$/.test(e.name) || e.isDirectory()),
		prompts: names("prompts", (e) => e.name.endsWith(".md")).map((n) => n.replace(/\.md$/, "")),
	};
}

// A key's profile is written by its own sessions, so the gateway treats its contents as hostile:
// it only ever looks at a profile through lstat (sizes and names, never following a link), and
// every read or write of a file's contents runs piper-profile.mjs in a container that has only that
// one folder mounted. That way a symlink a session planted — settings.json pointing at
// ~/.pi/agent/auth.json — resolves inside that container, where the path leads nowhere.

export const PROFILE_HELPER_PATH = join(GATEWAY_DIR, "piper-profile.mjs");
export const PROFILE_HELPER_TIMEOUT_MS = 30_000;
/** Helper operations that change the profile, and so are refused on a locked one. */
export const PROFILE_WRITES = new Set(["settings.put", "settings.patch", "skills.put", "skills.delete", "extensions.put", "extensions.delete"]);

/** A profile problem with the HTTP status it should be answered with. */
export class ProfileError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Sizes and names under a profile, from lstat alone: nothing here reads a file or follows a link. */
export function profileStats(dir) {
	const walk = (path) => {
		let stat;
		try {
			stat = lstatSync(path);
		} catch {
			return 0;
		}
		if (!stat.isDirectory()) return stat.size;
		let total = 0;
		for (const entry of readdirSync(path)) total += walk(join(path, entry));
		return total;
	};
	const names = (sub) => {
		try {
			const path = join(dir, sub);
			return lstatSync(path).isDirectory() ? readdirSync(path).sort() : [];
		} catch {
			return [];
		}
	};
	return { bytes: cachedTreeSize(dir), skills: names("skills"), extensions: names("extensions") };
}

/**
 * Folder sizes for the dashboard and the quota checks, cached briefly: walking a large shared
 * folder on every view would be slow. Every write the gateway makes itself invalidates the entry,
 * so its own API results stay exact; changes sessions make show up within the TTL.
 */
const SIZE_TTL_MS = 15_000;
const sizeCache = new Map();

export function cachedTreeSize(dir, { now = Date.now(), ttl = SIZE_TTL_MS } = {}) {
	const hit = sizeCache.get(dir);
	if (hit && now - hit.at < ttl) return hit.bytes;
	const bytes = treeSize(dir);
	sizeCache.set(dir, { bytes, at: now });
	return bytes;
}

/** Forget cached sizes for `dir` and anything inside it. */
export function invalidateSize(dir) {
	for (const key of sizeCache.keys()) if (key === dir || key.startsWith(`${dir}/`)) sizeCache.delete(key);
}

/** Total bytes under a path, from lstat alone: never reads a file, never follows a link. */
export function treeSize(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	let total = 0;
	for (const entry of readdirSync(path)) total += treeSize(join(path, entry));
	return total;
}

/**
 * A key's workspace, created on first use: the one folder mounted at /workspace in every chat of the
 * key. Kept apart from the profile, so a profile reset or lock never touches it.
 */
export function ensureWorkspace(keyId, { root = workspaceRoot() } = {}) {
	if (!root) throw new Error("WORKSPACE_ROOT is empty; containers need somewhere to keep workspaces");
	const dir = workspaceDir(keyId, root);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Whether a key's chats may write its workspace: always, unless a size limit is set and passed. */
export function workspaceWritability(dir, max = config.WORKSPACE_MAX_BYTES) {
	if (!(max > 0)) return { writable: true, reason: "" };
	const bytes = cachedTreeSize(dir);
	return bytes > max ? { writable: false, reason: `over its limit (${bytes} of ${max} bytes)` } : { writable: true, reason: "" };
}

/**
 * What is in a key's workspace, for the dashboard and /profile: size, file count and the
 * top-level entries. lstat only, like profileStats, because sessions write here freely.
 */
export function workspaceStats(dir, { maxEntries = 50 } = {}) {
	if (!existsSync(dir)) return { created: false, bytes: 0, files: 0, entries: [] };
	let files = 0;
	const count = (path) => {
		let stat;
		try {
			stat = lstatSync(path);
		} catch {
			return;
		}
		if (stat.isDirectory()) for (const e of readdirSync(path)) count(join(path, e));
		else files++;
	};
	count(dir);
	const entries = readdirSync(dir)
		.sort()
		.slice(0, maxEntries)
		.map((name) => {
			const stat = lstatSync(join(dir, name));
			return { name, type: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file", bytes: treeSize(join(dir, name)) };
		});
	return { created: true, bytes: treeSize(dir), files, entries, more: Math.max(0, readdirSync(dir).length - maxEntries) };
}

export function isProfileLocked(scope) {
	return Boolean(db.prepare("SELECT 1 FROM profile_locks WHERE scope = ?").get(scope));
}

export function setProfileLock(scope, locked) {
	if (locked) db.prepare("INSERT OR IGNORE INTO profile_locks (scope, locked_at) VALUES (?, ?)").run(scope, Date.now());
	else db.prepare("DELETE FROM profile_locks WHERE scope = ?").run(scope);
}

/**
 * Whether a key's sessions may write their profile, and if not, why. A locked profile is read-only
 * by the operator's choice; one over its quota is read-only until it is trimmed, which still leaves
 * the key able to chat and to delete things through the API.
 */
export function profileWritability(keyId, dir) {
	const scope = profileScope(keyId);
	if (isProfileLocked(scope)) return { writable: false, reason: "locked by the gateway operator" };
	const max = config.PROFILE_MAX_BYTES;
	if (max > 0) {
		const { bytes } = profileStats(dir);
		if (bytes > max) return { writable: false, reason: `over its quota (${bytes} of ${max} bytes)` };
	}
	return { writable: true, reason: "" };
}

/** The command that runs the profile helper in a container with only `dir` mounted, read-write. */
export function profileHelperInvocation({ dir, extraArgs = [], helperPath = PROFILE_HELPER_PATH, maxBytes = config.PROFILE_MAX_BYTES, image = config.CONTAINER_IMAGE, uid, gid }) {
	return { command: ENGINE_BIN, args: helperArgs({ dir, helperPath, extraArgs, maxBytes, image, uid, gid }) };
}

/** Run one profile operation for a key, in the helper's container. */
export async function profileOp(keyId, command) {
	const scope = profileScope(keyId);
	if (PROFILE_WRITES.has(command.op) && isProfileLocked(scope)) {
		throw new ProfileError("this profile is locked by the gateway operator", 423);
	}
	return runHelperJson(ensureProfile(keyId), command);
}

/** The helper's command line over `dir`. */
function helperArgv(dir, extraArgs = []) {
	const invocation = profileHelperInvocation({ dir, extraArgs });
	return [invocation.command, ...invocation.args];
}

/** Run one JSON helper command over `dir`: a profile, or a key's workspace. */
async function runHelperJson(dir, command) {
	const [bin, ...args] = helperArgv(dir);
	// Anything but a read changes the folder's size.
	if (!/(\.get|\.list|^summary|^inventory)$/.test(command.op)) invalidateSize(dir);
	const output = await new Promise((resolvePromise, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), PROFILE_HELPER_TIMEOUT_MS);
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new ProfileError(`cannot run the profile helper: ${err.message}`, 503));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			// 125-127 are the engine's own: it could not run the container (no Docker, no image).
			if (!stdout) return reject(new ProfileError(`the profile helper failed (code ${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`, code >= 125 && code <= 127 ? 503 : 500));
			resolvePromise(stdout);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(command));
	});
	let answer;
	try {
		answer = JSON.parse(output);
	} catch {
		throw new ProfileError("the profile helper answered with something that is not JSON", 500);
	}
	if (!answer.ok) throw new ProfileError(answer.error, answer.refused ? 400 : 500);
	return answer.result;
}

/**
 * The key's workspace over HTTP: list, download, upload and delete. Like the profile, it is written
 * by sessions, so every access runs the helper in a container that has only this folder mounted; a
 * link a session planted there leads nowhere the session could not already see.
 */
export async function filesOp(keyId, command) {
	return runHelperJson(ensureWorkspace(keyId), command);
}

/** Map the helper's raw-mode exit codes to HTTP statuses. */
const RAW_STATUS = { 3: 400, 4: 404, 5: 413, 6: 400 };

/**
 * Stream a file out of (`read`) or into (`write`) a key's workspace. `read` pipes to `res`,
 * sending headers only once the helper has started producing bytes, so a missing file is still a
 * clean 404. `write` pipes `req` in, capped at `maxBytes`.
 */
export function filesStream(keyId, mode, rel, { req, res, maxBytes = 0 }) {
	return new Promise((resolvePromise) => {
		let argv;
		try {
			argv = helperArgv(ensureWorkspace(keyId), ["raw", mode, rel, String(maxBytes)]);
		} catch (err) {
			sendError(res, err.status ?? 500, err.message);
			return resolvePromise();
		}
		const [bin, ...args] = argv;
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		let started = false;
		let jsonOut = "";
		child.stderr.setEncoding("utf8").on("data", (c) => (stderr = (stderr + c).slice(-2000)));
		child.on("error", (err) => {
			if (!res.headersSent) sendError(res, 503, `cannot run the profile helper: ${err.message}`);
			resolvePromise();
		});
		if (mode === "read") {
			child.stdin.end();
			child.stdout.on("data", (chunk) => {
				if (!started) {
					started = true;
					const name = rel.split("/").pop() || "file";
					res.writeHead(200, {
						"Content-Type": "application/octet-stream",
						"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
						"Cache-Control": "no-store",
					});
				}
				if (!res.write(chunk)) {
					child.stdout.pause();
					res.once("drain", () => child.stdout.resume());
				}
			});
			res.on("close", () => child.kill("SIGKILL"));
		} else {
			child.stdout.setEncoding("utf8").on("data", (c) => (jsonOut += c));
			child.stdin.on("error", () => {});
			req.pipe(child.stdin);
		}
		child.on("close", (code) => {
			if (mode === "write") invalidateSize(ensureWorkspace(keyId));
			if (code === 0) {
				if (mode === "read") {
					if (!started) res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
					res.end();
				} else {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(jsonOut || JSON.stringify({ ok: true }));
				}
			} else if (!res.headersSent) {
				sendError(res, RAW_STATUS[code] ?? 500, stderr.trim().split("\n").pop() || `the profile helper failed (code ${code})`);
			} else {
				res.destroy();
			}
			resolvePromise();
		});
	});
}

/**
 * /v1/piper/files[/<path>] for a key, and /dashboard/files/<scope>[/<path>] for the operator.
 *   GET    a folder (or the root)   -> JSON listing
 *   GET    a file                   -> its bytes
 *   PUT    a file                   -> stores the request body there
 *   DELETE a file or folder         -> removes it
 */
export async function filesRoutes(req, res, keyId, rel) {
	// A folder can be named in the path or, for a listing, as ?path=.
	const query = new URL(req.url ?? "/", "http://gateway").searchParams.get("path");
	const clean = decodeURIComponent(String(rel ?? "")).replace(/^\/+/, "") || (req.method === "GET" && query ? `${query.replace(/^\/+|\/+$/g, "")}/` : "");
	try {
		if (req.method === "GET") {
			if (clean === "" || clean.endsWith("/")) {
				return sendJsonHttp(res, 200, { path: clean, entries: await filesOp(keyId, { op: "files.list", path: clean }) });
			}
			// A folder named without a trailing slash is listed rather than refused.
			const entries = await filesOp(keyId, { op: "files.list", path: clean }).catch(() => null);
			if (entries) return sendJsonHttp(res, 200, { path: clean, entries });
			return await filesStream(keyId, "read", clean, { req, res });
		}
		if (req.method === "PUT") {
			// The quota check reads the size afresh: a stale cached figure could let an upload through.
			const quota = config.WORKSPACE_MAX_BYTES > 0 ? Math.max(0, config.WORKSPACE_MAX_BYTES - treeSize(ensureWorkspace(keyId))) : 0;
			const limit = [config.FILE_UPLOAD_MAX_BYTES, quota].filter((n) => n > 0);
			await filesStream(keyId, "write", clean, { req, res, maxBytes: limit.length ? Math.min(...limit) : 0 });
			return;
		}
		if (req.method === "DELETE") return sendJsonHttp(res, 200, await filesOp(keyId, { op: "files.delete", path: clean }));
		return sendError(res, 405, `method ${req.method} is not supported here`);
	} catch (err) {
		if (err instanceof ProfileError) return sendError(res, err.status, err.message);
		throw err;
	}
}

function sendJsonHttp(res, status, value) {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(value));
}

/**
 * Put a key's profile back to its starting state. Every live session of that key is closed first,
 * because each has the old directory mounted and would go on writing to it. The old profile is
 * archived beside the workspace archives, not deleted, and expires with them.
 */
export function resetProfile(keyId) {
	const scope = profileScope(keyId);
	if (isProfileLocked(scope)) throw new ProfileError("this profile is locked by the gateway operator", 423);
	const closed = sessions.closeByKey(keyId);
	const dir = join(profileRoot(), scope);
	let archived = null;
	if (existsSync(dir)) {
		// A rename moves a link rather than following it, so a hostile profile cannot redirect this.
		const archive = archiveRoot() || `${profileRoot()}-archive`;
		mkdirSync(archive, { recursive: true, mode: 0o700 });
		archived = join(archive, `profile-${scope}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
		renameSync(dir, archived);
	}
	invalidateSize(dir);
	ensureProfile(keyId);
	return { closed, archived: Boolean(archived) };
}

// /v1/piper/profile/* lets a key manage its own profile over HTTP: the same operations as the chat
// commands, for a client or script. The key presenting the request is the profile it reaches;
// there is no way to name another. Every change is followed by a reload of that key's live
// sessions, so it applies to chats already open.

/** Read a request body as text, within the same limit as JSON bodies. */
export function readText(req, limit = config.BODY_LIMIT) {
	return new Promise((resolvePromise, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				req.destroy();
				reject(new ProfileError("Request body too large", 413));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** A body that may be JSON or plain text, parsed by its content type. */
export async function readBody(req) {
	const text = await readText(req);
	if (!/json/i.test(req.headers["content-type"] ?? "")) return { text };
	try {
		return { json: JSON.parse(text || "{}") };
	} catch {
		throw new ProfileError("Malformed JSON body");
	}
}

/** Re-read resources in every live session of a key, so a profile change applies to open chats. */
export async function reloadKeySessions(keyId) {
	const records = sessions.recordsByKey(keyId);
	await Promise.all(
		records.map(async (c) => {
			const session = await c.sessionPromise.catch(() => null);
			if (session instanceof PiRpcSession && session.alive) await reloadSession(c).catch(() => {});
		}),
	);
	return records.length;
}

export async function profileRoutes(req, res, path) {
	const keyId = req.credential ? req.credential.id : null;
	const rest = path.slice("/v1/piper/profile".length);
	const segments = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
	const send = (status, value) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(value));
	};
	const changed = async (result) => send(200, { ...result, reloadedSessions: await reloadKeySessions(keyId) });
	try {
		const [kind, name] = segments;
		const method = req.method;
		if (!kind && method === "GET") {
			const scope = profileScope(keyId);
			const summary = await profileOp(keyId, { op: "summary" });
			const { writable, reason } = profileWritability(keyId, join(profileRoot(), scope));
			return send(200, { ...summary, writable, readOnlyReason: reason || undefined, locked: isProfileLocked(scope) });
		}
		if (kind === "reset" && !name && method === "POST") {
			const { json } = await readBody(req);
			if (json?.confirm !== true) throw new ProfileError('send {"confirm": true} to reset: it replaces every skill, extension and setting on this key');
			return send(200, resetProfile(keyId));
		}
		if (kind === "settings" && !name) {
			if (method === "GET") return send(200, await profileOp(keyId, { op: "settings.get" }));
			if (method === "PUT" || method === "PATCH") {
				const { json } = await readBody(req);
				if (!json) throw new ProfileError("send settings as application/json");
				const op = method === "PUT" ? { op: "settings.put", settings: json } : { op: "settings.patch", set: json.set ?? {}, unset: json.unset ?? [] };
				return changed({ settings: await profileOp(keyId, op) });
			}
		}
		if (kind === "skills") {
			if (!name && method === "GET") return send(200, await profileOp(keyId, { op: "skills.list" }));
			if (name && segments.length === 2) {
				if (method === "GET") return send(200, await profileOp(keyId, { op: "skills.get", name }));
				if (method === "DELETE") return changed(await profileOp(keyId, { op: "skills.delete", name }));
				if (method === "PUT") {
					// Either a bare SKILL.md, or {"files": {"SKILL.md": ..., "scripts/run.sh": ...}} for a skill
					// with supporting files.
					const { json, text } = await readBody(req);
					const files = json ? json.files : { "SKILL.md": text };
					return changed(await profileOp(keyId, { op: "skills.put", name, files }));
				}
			}
		}
		if (kind === "extensions") {
			if (!name && method === "GET") return send(200, await profileOp(keyId, { op: "extensions.list" }));
			if (name && segments.length === 2) {
				if (method === "GET") return send(200, await profileOp(keyId, { op: "extensions.get", name }));
				if (method === "DELETE") return changed(await profileOp(keyId, { op: "extensions.delete", name }));
				if (method === "PUT") {
					const { json, text } = await readBody(req);
					const content = json ? json.content : text;
					return changed(await profileOp(keyId, { op: "extensions.put", name, content }));
				}
			}
		}
		return sendError(res, 404, `Unknown profile route: ${method} ${path}`, "not_found");
	} catch (err) {
		if (err instanceof ProfileError) return sendError(res, err.status, err.message, err.status === 423 ? "profile_locked" : "invalid_request_error");
		throw err;
	}
}

/** The key id a profile scope belongs to, the inverse of profileScope. */
export function keyIdForScope(scope) {
	if (scope === "open") return null;
	if (scope === "settings") return "";
	return scope.startsWith("key-") ? scope.slice(4) : undefined;
}

/** Every profile on disk, for the dashboard: sizes and names from lstat, never file contents. */
export function profilesPayload() {
	const root = profileRoot();
	let scopes = [];
	try {
		scopes = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
	} catch {
		/* no profiles yet */
	}
	// Who gets each bundle: every key by name, plus the open gateway when no key exists yet.
	const holders = [...apiKeys.list().map((k) => ({ id: k.id, name: k.name })), ...(apiKeys.count() ? [] : [{ id: null, name: keyLabel(null) }])];
	return {
		maxBytes: config.PROFILE_MAX_BYTES,
		shared: {
			root: sharedRoot(),
			defaultBundles: config.SHARED_BUNDLES,
			bundles: listBundles().map((b) => ({
				name: b.name,
				...bundleContents(b.path),
				keys: holders.filter((h) => grantedBundles(h.id).some((g) => g.name === b.name)).map((h) => h.name),
			})),
		},
		profiles: scopes.map((scope) => {
			const keyId = keyIdForScope(scope);
			const dir = join(root, scope);
			const stats = profileStats(dir);
			const { writable, reason } = profileWritability(keyId, dir);
			return {
				scope,
				key: keyId === undefined ? "(unknown)" : keyLabel(keyId),
				bytes: stats.bytes,
				filesBytes: cachedTreeSize(join(workspaceRoot(), scope)),
				skills: stats.skills,
				extensions: stats.extensions,
				locked: isProfileLocked(scope),
				writable,
				readOnlyReason: reason,
				liveSessions: keyId === undefined ? 0 : sessions.recordsByKey(keyId).length,
			};
		}),
	};
}

/**
 * Where a loaded tool or command came from, judged by its source path inside the container: the key's
 * own profile, a shared bundle, the chat's workspace, the gateway's bridge, or Pi itself.
 */
export function originOf(path) {
	const p = String(path ?? "");
	if (p.startsWith(`${CONTAINER_PATHS.profile}/`)) return "own";
	const bundle = new RegExp(`^${CONTAINER_PATHS.shared}/([^/]+)/`).exec(p);
	if (bundle) return `shared: ${bundle[1]}`;
	if (p.startsWith(`${CONTAINER_PATHS.workspace}/`)) return "workspace";
	if (p.startsWith("/opt/piper/")) return "gateway";
	return "built-in";
}

/**
 * Everything one key's agents get, for the dashboard: what the user put in their own profile, what
 * each granted bundle adds, and — when one of the key's agents is running — exactly what it has
 * loaded, tools included. Nothing is created: a key that has never chatted has no profile yet.
 */
/**
 * A key's container settings for its detail view: its own values (null follows the default) and
 * what its chats actually get. Environment values are left out: they can hold secrets, and the page
 * only needs to know which names are set.
 */
export function containerView(keyId) {
	const eff = containerSettingsFor(keyId);
	return {
		keyId,
		admin: keyId === "" || keyId === null || keyId === undefined,
		own: eff.own,
		effective: { persistent: eff.persistent, memoryMb: eff.memoryMb, cpus: eff.cpus, pids: eff.pids, network: eff.network, image: eff.image, mounts: eff.mounts.map((m) => (m.host === m.container ? m.host : `${m.host}:${m.container}`)), envNames: eff.env.map(([name]) => name) },
	};
}

export async function profileDetail(scope) {
	const keyId = keyIdForScope(scope);
	if (keyId === undefined) return null;
	const dir = join(profileRoot(), scope);
	const created = existsSync(dir);
	if (!created && keyId && !apiKeys.get(keyId)) return null;
	let own = null;
	let ownError = null;
	if (created) {
		try {
			own = await profileOp(keyId, { op: "inventory" });
		} catch (err) {
			ownError = err?.message ?? String(err);
		}
	}
	const bundles = grantedBundles(keyId).map((b) => ({ name: b.name, ...inventory(b.path) }));
	const records = sessions.recordsByKey(keyId);
	const agent = records.map((r) => r.session).find((sess) => sess instanceof PiRpcSession && sess.alive);
	let live = null;
	if (agent) {
		const answer = await agent.inventory();
		live = answer
			? {
					tools: answer.tools.map((t) => ({ ...t, origin: originOf(t.path), active: (answer.active ?? []).includes(t.name) })),
					commands: answer.commands.filter((c) => !c.name.startsWith("piper-")).map((c) => ({ ...c, origin: originOf(c.path) })),
				}
			: { error: "the running agent did not answer in time" };
	}
	const state = created ? profileWritability(keyId, dir) : { writable: true, reason: "" };
	const filesDir = join(workspaceRoot(), scope);
	const files = workspaceStats(filesDir);
	if (files.created) {
		const fs = workspaceWritability(filesDir);
		files.writable = fs.writable;
		files.readOnlyReason = fs.reason;
	}
	files.maxBytes = config.WORKSPACE_MAX_BYTES;
	return {
		scope,
		files,
		// The key's model allow-list: its own (null follows the default), and what applies.
		models: keyId === "" ? { own: null, effective: "", admin: true } : { own: keyId ? apiKeys.get(keyId)?.allowedModels ?? null : null, effective: allowedModelsFor(keyId), keyId },
		container: containerView(keyId),
		key: keyLabel(keyId),
		created,
		locked: isProfileLocked(scope),
		writable: state.writable,
		readOnlyReason: state.reason,
		bytes: own?.bytes ?? 0,
		maxBytes: config.PROFILE_MAX_BYTES,
		own,
		ownError,
		bundles,
		liveSessions: records.length,
		live,
	};
}

export async function profileAdminRoutes(req, res, path) {
	const send = (status, value) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(value));
	};
	if (req.method === "GET" && path === "/dashboard/profiles.json") return send(200, profilesPayload());
	const detailMatch = /^\/dashboard\/profiles\/([A-Za-z0-9_-]+)\.json$/.exec(path);
	if (req.method === "GET" && detailMatch) {
		const detail = await profileDetail(detailMatch[1]);
		return detail ? send(200, detail) : sendError(res, 404, `No profile ${detailMatch[1]}`, "not_found");
	}
	const match = /^\/dashboard\/profiles\/([A-Za-z0-9_-]+)\/(lock|reset)$/.exec(path);
	if (!match || req.method !== "POST") return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	const [, scope, action] = match;
	const keyId = keyIdForScope(scope);
	if (keyId === undefined || !existsSync(join(profileRoot(), scope))) return sendError(res, 404, `No profile ${scope}`, "not_found");
	if (action === "lock") {
		let body;
		try {
			body = await readJson(req);
		} catch {
			return sendError(res, 400, "Malformed JSON body");
		}
		setProfileLock(scope, Boolean(body.locked));
		// A running container keeps the mounts it started with, so a lock only binds once its sessions
		// are gone. Closing them makes the lock take effect now rather than at the next reap.
		const closed = body.locked ? sessions.closeByKey(keyId) : 0;
		return send(200, { ...profilesPayload(), closed });
	}
	try {
		const result = resetProfile(keyId);
		return send(200, { ...profilesPayload(), ...result });
	} catch (err) {
		if (err instanceof ProfileError) return sendError(res, err.status, err.message);
		throw err;
	}
}
