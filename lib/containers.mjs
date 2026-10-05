/**
 * A chat's container: starting Pi in it, and what happens to it when the chat is stopped or ends.
 *
 * One container per chat, kept between restarts. Hibernating a chat stops its container; the next
 * message starts the same one, so whatever the agent installed is still there, and Pi continues its
 * own session. Ending a chat removes the container and the chat's state; the key's workspace stays.
 */
import { delegatorFor, mayDelegate } from "./delegate.mjs";
import { maySchedule, schedulerFor } from "./agentschedule.mjs";
import { spawn as defaultSpawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_DIR, config, db } from "./settings.mjs";
import { CONTAINER_PATHS as P, archiveRoot, chatRoot, ensureRunRoot, parseContainerEnv, parseContainerMounts, runRoot, workspaceRoot } from "./paths.mjs";
import { ENGINE_BIN, EngineError, chatIdHash, chatKey, chatKeyOfContainer, containerName, containerStats, diskUsage, dockerRootDir, ensureContainer, execArgs, execIn, hostNameservers, imageInfo, inspectMany, instanceId, isKeyContainer, keyContainerName, keyHash, killPi, listManaged, onReadinessChange, removeContainer, removeKeyContainer, requireReady, stopContainer, watchEvents } from "./engine.mjs";
import { containerSettingsFor, networkModesInUse } from "./keycontainer.mjs";
import { loadedPiVersion, pi, piPackageDir } from "./models.mjs";
import { allowedEndpoints, containerDefaultModel, directProviders, writeChatModels } from "./containerpi.mjs";
import { apiKeys, keyLabel, modelAllowed } from "./auth.mjs";
import { agentScope, agents } from "./agents.mjs";
import { alert, recovered } from "./alerts.mjs";
import { audit } from "./audit.mjs";
import { piVersionsFor } from "./piversions.mjs";
import { piStatus } from "./versions.mjs";
import { sessions } from "./sessions.mjs";
import { BRIDGE_PATH, PiRpcSession, hostDefaultModel, newMeter, startBridge } from "./runner.mjs";
import { ensureProfile, ensureWorkspace, grantedBundles, packageDir, profileWritability, workspaceWritability } from "./profiles.mjs";

/** The Pi version this gateway runs, which the image should match. */
export async function hostPiVersion() {
	try {
		await pi();
		// The version this process loaded, not what is on disk now: a Pi updated under a running gateway
		// changes the files but not what the gateway speaks, and images and containers must match the latter.
		if (loadedPiVersion) return loadedPiVersion;
		return diskPiVersion();
	} catch {
		return "";
	}
}

/** The Pi version installed where the gateway found Pi, read from its package.json now ("" when unknown). */
export function diskPiVersion(dir = piPackageDir) {
	try {
		// Unresolved would join to "package.json" in the working directory: the gateway's own.
		if (!dir) return "";
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "";
	} catch {
		return "";
	}
}

/** Where a chat's own state lives on the host: Pi's session files, and the models.json for it. */
export const chatDirOf = (idHash) => join(chatRoot(), chatKey(idHash));
/** The folder holding a chat's bridge socket, mounted at /run/piper. */
export const runDirOf = (idHash, root = runRoot()) => join(root, `${instanceId()}-${chatKey(idHash)}`);
/**
 * A persistent key's folders: Pi's session files (one subfolder per chat), the rendered models.json, and
 * the bridge sockets (one per chat). They are mounted once, when the container is created, so each chat
 * has its own subfolder or file in them rather than a mount of its own.
 */
export const keyDirOf = (keyId) => join(chatRoot(), `key-${keyHash(keyId)}`);
export const keyRunDirOf = (keyId, root = runRoot()) => join(root, `${instanceId()}-key-${keyHash(keyId)}`);
const socketFileOf = (idHash) => `${chatKey(idHash)}.sock`;

/**
 * What the readiness check needs, from the live settings: which private endpoints to let through,
 * this gateway's Pi version, and every network policy some chat may use (the default and each key's own).
 */
export async function engineOptions() {
	return { endpoints: allowedEndpoints(), hostPiVersion: await hostPiVersion(), modes: networkModesInUse() };
}

/** What `docker create` needs for a chat, from the live settings, the key's own overrides and its folders. */
export function containerSpecFor(record, workspace) {
	const keyId = record?.keyId ?? null;
	// Where the profile, workspace and container live: the key's own scope, or an agent's. The owner key
	// stays `keyId`, which is what limits, spend and the allow-list are read from.
	const scopeId = record?.scopeId ?? keyId;
	// A stored chat that is not running has an id hash but no id.
	const idHash = record.idHash ?? chatIdHash(record.id);
	const profileDir = ensureProfile(scopeId);
	const eff = containerSettingsFor(scopeId);
	const persistent = Boolean(scopeId && eff.persistent);
	return {
		name: persistent ? keyContainerName(scopeId) : containerName(idHash),
		persistent,
		agentId: record?.agentId ?? null,
		keyId,
		image: eff.image,
		workspace,
		workspaceWritable: workspaceWritability(workspace).writable,
		profileDir,
		profileWritable: profileWritability(scopeId, profileDir).writable,
		chatDir: persistent ? keyDirOf(scopeId) : chatDirOf(idHash),
		runDir: persistent ? keyRunDirOf(scopeId) : runDirOf(idHash),
		bridgePath: BRIDGE_PATH,
		bundles: grantedBundles(scopeId),
		mounts: eff.mounts,
		env: eff.env,
		memoryMb: eff.memoryMb,
		pids: eff.pids,
		cpus: eff.cpus,
		network: eff.network,
	};
}

/**
 * Pi's arguments and environment for one start. Chosen at every start, not baked into the container:
 * a resumed chat continues its session, a new one starts on the default model, and settings such as
 * CONTAINER_ENV apply from the next start.
 */
export function piInvocation(spec, { resume = false, defaultModel = null, idHash = null, delegate = false, schedule = false } = {}) {
	// A persistent container is shared by the key's chats, so each chat keeps its session and its socket
	// under its own name inside the one mounted folder.
	const shared = Boolean(spec.persistent && idHash);
	const sessionDir = shared ? `${P.session}/${chatKey(idHash)}` : P.session;
	const socket = shared ? `${P.run}/${socketFileOf(idHash)}` : P.socket;
	const piArgs = [
		"--mode", "rpc", "--session-dir", sessionDir, ...(resume ? ["--continue"] : []), "--approve",
		"-e", P.bridge, ...spec.bundles.flatMap((b) => ["-e", `${P.shared}/${b.name}${b.entry ? `/${b.entry}` : ""}`]),
	];
	const modelEnv = !resume && defaultModel?.model ? { PIPER_DEFAULT_MODEL: defaultModel.model, ...(defaultModel.thinking ? { PIPER_DEFAULT_THINKING: defaultModel.thinking } : {}) } : {};
	const env = {
		...Object.fromEntries(spec.env ?? parseContainerEnv()),
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		HOME: P.home,
		PI_CODING_AGENT_DIR: P.profile,
		PI_CONFIG_DIR: P.piConfig,
		PIPER_BRIDGE_SOCKET: socket,
		PIPER_WORKSPACE_DIR: P.workspace,
		...modelEnv,
		...(delegate ? { PIPER_DELEGATE: "1" } : {}),
		...(schedule ? { PIPER_SCHEDULE: "1" } : {}),
	};
	return { piArgs, env, sessionDir };
}

/** What a fresh container's /etc/resolv.conf says: the host's resolvers, the ones the firewall lets through. */
function resolvConfText() {
	const servers = hostNameservers();
	// The comment is for the agent: a bind-mounted file cannot be replaced, so `sed -i` and `mv` fail on it.
	return `# Yours to change, and kept. Edit in place (echo >, tee, an editor's save); sed -i and mv cannot replace it.\n${(servers.length ? servers : ["1.1.1.1", "9.9.9.9"]).map((ip) => `nameserver ${ip}`).join("\n")}\n`;
}

const HOSTS_TEXT = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\nfe00::\tip6-localnet\nff00::\tip6-mcastprefix\nff02::1\tip6-allnodes\nff02::2\tip6-allrouters\n127.0.1.1\tpiper\n";

/**
 * The container's /etc/resolv.conf, hosts and hostname as files in its state folder, created when they
 * are missing. The agent owns them from then on: its edits stay, in place, through stops and restarts.
 * The one thing kept up to date is the resolver list, and only while the agent has not touched it (the
 * file still equals what was last written here), so a host whose DHCP changed its DNS still works.
 * Files are written in place, never renamed, because they are bind-mounted into a running container.
 */
export function ensureSystemFiles(chatDir) {
	const dir = join(chatDir, "sys");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const seed = (name, text) => {
		const path = join(dir, name);
		if (!existsSync(path)) writeFileSync(path, text, { mode: 0o644 });
	};
	seed("hosts", HOSTS_TEXT);
	seed("hostname", "piper\n");
	const resolv = join(dir, "resolv.conf");
	const seeded = join(dir, ".resolv.seeded");
	const fresh = resolvConfText();
	const current = existsSync(resolv) ? readFileSync(resolv, "utf8") : null;
	const last = existsSync(seeded) ? readFileSync(seeded, "utf8") : null;
	// Missing: write it. Untouched since we wrote it, but the host's resolvers changed: write it again.
	// Anything else is the agent's and is left alone.
	if (current === null || (last !== null && current === last && current !== fresh)) {
		writeFileSync(resolv, fresh, { mode: 0o644 });
		writeFileSync(seeded, fresh, { mode: 0o600 });
	}
	return dir;
}

/**
 * What a container needs on the host before it is created: its system files, session, models.json and
 * socket folders. createContainerSession does the same inline for a chat that is starting; an update
 * rebuilds containers that may predate some of these.
 */
export function prepareContainerFolders(spec, keyId) {
	ensureSystemFiles(spec.chatDir);
	mkdirSync(join(spec.chatDir, "session"), { recursive: true, mode: 0o700 });
	writeChatModels(join(spec.chatDir, "etc"), (m) => modelAllowed(keyId, m));
	ensureRunRoot();
	mkdirSync(spec.runDir, { recursive: true, mode: 0o700 });
}

/** The last update of each container, remembered for the Containers page: {at, piFrom, piTo, steps}. */
const lastUpdates = new Map();
export const noteUpdate = (name, info) => lastUpdates.set(name, info);

/** An agent's own default model and thinking level, for a new chat of it, or null. */
export function agentDefaultModel(record) {
	const agent = record?.agentId ? agents.get(record.agentId) : null;
	return agent?.model ? { model: agent.model, thinking: agent.thinking ?? null } : null;
}

// The one raw (non-docker-command) process this module spawns: `docker exec` into a running container,
// talking Pi's RPC protocol over its stdio. Everything else here goes through engine.mjs's own `runner`
// already; this is injectable the same way, so a test can hand PiRpcSession a scripted child with no
// real Docker underneath (ensureContainer's own docker calls still need `setRunner` stubbed separately).
let sessionSpawn = defaultSpawn;
/** Replace what spawns a chat's Pi process (tests). No argument restores the real `spawn`. */
export function setSessionSpawn(fn) {
	const previous = sessionSpawn;
	sessionSpawn = fn ?? defaultSpawn;
	return previous;
}

/** Start Pi for a chat, in its container, and wait until it answers. */
export async function createContainerSession(workspace, record) {
	if (!workspace) throw new Error("WORKSPACE_ROOT is empty: each key needs a workspace folder");
	await pi();
	const ready = await requireReady(await engineOptions());
	const keyId = record?.keyId ?? null;
	const idHash = chatIdHash(record.id);
	const spec = containerSpecFor(record, workspace);
	// A bundle whose folder was granted but is no longer actually on disk (removed by hand, a restore that
	// missed it, one mid-reinstall) would otherwise be mounted empty and Pi refuses to start at all over
	// one missing extension. Left out of this run, with the chat told once, rather than taking the whole
	// container down; the grant itself is untouched; it mounts again the moment the folder is back.
	const missingBundles = spec.bundles.filter((b) => !existsSync(packageDir(b)));
	if (missingBundles.length) {
		spec.bundles = spec.bundles.filter((b) => !missingBundles.includes(b));
		(record.notices ??= []).push(
			`${missingBundles.length === 1 ? "an extension" : "extensions"} this chat was granted could not be found on the host and ${missingBundles.length === 1 ? "was" : "were"} left out: ${missingBundles.map((b) => b.name).join(", ")}. Reinstall or remove ${missingBundles.length === 1 ? "it" : "them"} on Extensions.`,
		);
	}
	// What stopping or ending this chat later needs to know, fixed now: the key's setting may change meanwhile.
	record.container = { name: spec.name, persistent: spec.persistent, runDir: spec.runDir, chatDir: spec.chatDir };
	// The readiness check looked at the default image; a key may name another.
	const image = spec.image === config.CONTAINER_IMAGE ? ready.image : await imageInfo(spec.image);
	if (!image) throw new EngineError(`the image "${spec.image}" does not exist; build it, or clear this key's image on Files & profiles → Profiles`);
	// The chat's own folders. The gateway creates and fills them, so a link an agent plants cannot
	// redirect them: the agent only ever sees them through the container's mounts.
	ensureSystemFiles(spec.chatDir);
	const sessionHost = spec.persistent ? join(spec.chatDir, "session", chatKey(idHash)) : join(spec.chatDir, "session");
	// A chat that began before its key was persistent brings its Pi session along.
	const before = join(chatDirOf(idHash), "session");
	if (spec.persistent && record?.resume && !existsSync(sessionHost) && existsSync(before)) {
		mkdirSync(join(spec.chatDir, "session"), { recursive: true, mode: 0o700 });
		cpSync(before, sessionHost, { recursive: true });
	}
	mkdirSync(sessionHost, { recursive: true, mode: 0o700 });
	writeChatModels(join(spec.chatDir, "etc"), (m) => modelAllowed(keyId, m));
	ensureRunRoot();
	mkdirSync(spec.runDir, { recursive: true, mode: 0o700 });
	const socketPath = join(spec.runDir, spec.persistent ? socketFileOf(idHash) : "bridge.sock");
	const meter = newMeter();
	const bridge = await startBridge(socketPath, meter, { keyId, delegator: mayDelegate(record) ? delegatorFor(record) : null, scheduler: maySchedule(record) ? schedulerFor(record) : null });
	let session;
	try {
		// Other chats of a persistent key may be using the container right now; it is not rebuilt under them.
		const busy = spec.persistent && sessions.recordsByKey(keyId).some((r) => r !== record && r.container?.name === spec.name);
		const { recreated, kept } = await ensureContainer(spec, image.id, { allowRecreate: !busy });
		if (recreated) process.stderr.write(`container ${spec.name} was recreated: its settings changed${spec.persistent ? "; what the agent installed in it was saved and carried over" : ", so what the agent installed in it is gone"}\n`);
		if (kept) (record.notices ??= []).push("this key's container settings changed, but other chats are using the container; it is rebuilt with the new settings, keeping what is installed, once none is");
		const { piArgs, env, sessionDir } = piInvocation(spec, {
			resume: Boolean(record?.resume),
			defaultModel: record?.resume ? null : agentDefaultModel(record) ?? containerDefaultModel(hostDefaultModel()),
			idHash,
			delegate: mayDelegate(record),
			schedule: maySchedule(record),
		});
		const args = execArgs({ name: spec.name, env, piArgs, profileWritable: spec.profileWritable });
		const child = sessionSpawn(ENGINE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
		session = new PiRpcSession(child, { meter, onClose: () => bridge.close(), bridge, direct: () => directProviders(), killRemote: () => killPi(spec.name, spec.persistent ? `--session-dir ${sessionDir}` : undefined), reason: () => recentReasonFor(spec.name) });
		return await session.init();
	} catch (err) {
		session?.dispose();
		bridge.close();
		throw err;
	}
}

/**
 * What the session controller asks of the container layer. `workspace` is the key's folder;
 * `stopped` and `ended` are the two ways a chat's process goes away.
 */
export const containerHost = {
	workspace: (keyId) => ensureWorkspace(keyId),

	/**
	 * Hibernate: a chat's own container is stopped and keeps its state; its socket folder goes (it is
	 * recreated). A persistent container is the key's, not the chat's, and keeps running: other chats
	 * may be in it, and what the agent started there (a proxy, a daemon) should outlive the chat. Only
	 * the chat's own socket goes.
	 */
	async stopped(idHash, record) {
		const c = record?.container;
		if (c?.persistent) {
			rmSync(join(c.runDir, socketFileOf(idHash)), { force: true });
			return;
		}
		await stopContainer(containerName(idHash)).catch(() => {});
		rmSync(runDirOf(idHash), { recursive: true, force: true });
	},

	/**
	 * End: remove a chat's own container and everything the chat kept. The workspace is the key's, and
	 * stays. A persistent key's container stays too; only this chat's session files and socket go.
	 */
	async ended(idHash) {
		await removeContainer(containerName(idHash)).catch(() => {});
		rmSync(runDirOf(idHash), { recursive: true, force: true });
		rmSync(chatDirOf(idHash), { recursive: true, force: true });
		forgetPersistentChat(idHash);
	},
};

/** Remove a chat's session folder and socket from every persistent key's folders (the chat need not say which key). */
function forgetPersistentChat(idHash) {
	const eachKeyDir = (root, fn) => {
		let names = [];
		try {
			names = readdirSync(root);
		} catch {
			return;
		}
		for (const name of names) if (/key-[0-9a-f]{12}$/.test(name)) fn(join(root, name));
	};
	if (chatRoot()) eachKeyDir(chatRoot(), (dir) => rmSync(join(dir, "session", chatKey(idHash)), { recursive: true, force: true }));
	if (runRoot()) eachKeyDir(runRoot(), (dir) => rmSync(join(dir, socketFileOf(idHash)), { force: true }));
}

/**
 * Remove a key's persistent container and the state saved for it, so its next chat starts from the clean
 * image. The key's workspace and profile are not touched. With `forget`, the key is going away: its
 * session and socket folders go too.
 */
export async function removePersistentContainer(keyId, { forget = false } = {}) {
	await removeKeyContainer(keyContainerName(keyId));
	rmSync(keyRunDirOf(keyId), { recursive: true, force: true });
	if (forget) rmSync(keyDirOf(keyId), { recursive: true, force: true });
}

/**
 * Reconcile what is on disk and in Docker with the chats this gateway knows, and expire old archives.
 *
 * `known` is the id hashes of every chat that can still be resumed (live or stored); `live` the ones
 * running now. At start nothing is live, so a container left running by a gateway that was killed
 * is stopped, and one belonging to no chat is removed. Only this gateway's containers and folders
 * are touched (they carry its instance id).
 */
export async function sweepContainers(known, live = new Set()) {
	const knownKeys = new Set([...known].map(chatKey));
	const liveKeys = new Set([...live].map(chatKey));
	const result = { stopped: 0, removed: 0, folders: 0, expired: 0 };
	for (const c of await listManaged()) {
		const key = chatKeyOfContainer(c.name);
		if (key === null) continue;
		if (isKeyContainer(c.name)) {
			// A persistent key's container lasts between gateway runs and while its chats are quiet. It goes
			// only with its key, or when the key stops being persistent.
			if (!(c.agentId ? agents.get(c.agentId) : apiKeys.get(c.keyId)?.container?.persistent)) {
				await removeKeyContainer(c.name);
				result.removed++;
			}
			continue;
		}
		if (!knownKeys.has(key)) {
			await removeContainer(c.name);
			result.removed++;
		} else if (!liveKeys.has(key) && c.state === "running") {
			await stopContainer(c.name);
			result.stopped++;
		}
	}
	// Stale sockets and session folders in persistent keys' folders: of chats that are gone or not running.
	const sweepKeyFolders = () => {
		const each = (root, fn) => {
			try {
				for (const name of readdirSync(root)) if (/key-[0-9a-f]{12}$/.test(name)) fn(join(root, name));
			} catch {
				/* none */
			}
		};
		if (runRoot()) {
			each(runRoot(), (dir) => {
				for (const file of readdirSync(dir)) {
					const m = /^([0-9a-f]{16})\.sock$/.exec(file);
					if (m && !liveKeys.has(m[1])) rmSync(join(dir, file), { force: true });
				}
			});
		}
		if (chatRoot()) {
			each(chatRoot(), (dir) => {
				let names = [];
				try {
					names = readdirSync(join(dir, "session"));
				} catch {
					return;
				}
				for (const name of names) {
					const path = join(dir, "session", name);
					try {
						if (!/^[0-9a-f]{16}$/.test(name) || knownKeys.has(name) || Date.now() - lstatSync(path).mtimeMs < 60_000) continue;
						rmSync(path, { recursive: true, force: true });
						result.folders++;
					} catch {
						/* raced with something else */
					}
				}
			});
		}
	};
	sweepKeyFolders();
	const prune = (root, keyOf) => {
		let entries = [];
		try {
			entries = readdirSync(root);
		} catch {
			return;
		}
		for (const name of entries) {
			const key = keyOf(name);
			if (key === null || knownKeys.has(key)) continue;
			const path = join(root, name);
			try {
				const stat = lstatSync(path);
				// A folder a minute old may belong to a chat that is starting right now.
				if (!stat.isDirectory() || Date.now() - stat.mtimeMs < 60_000) continue;
				rmSync(path, { recursive: true, force: true });
				result.folders++;
			} catch {
				/* raced with something else */
			}
		}
	};
	// Chat state folders are named by chat key; socket folders by instance and chat key.
	if (chatRoot()) prune(chatRoot(), (name) => (/^[0-9a-f]{16}$/.test(name) ? name : null));
	if (runRoot()) prune(runRoot(), (name) => (name.startsWith(`${instanceId()}-`) && !name.startsWith(`${instanceId()}-key-`) ? name.slice(instanceId().length + 1) : null));
	// Archives (reset profiles, workspaces from before containers) expire.
	const ttl = config.ARCHIVE_TTL_MS;
	if (ttl > 0 && workspaceRoot()) {
		let entries = [];
		try {
			entries = readdirSync(archiveRoot(), { withFileTypes: true });
		} catch {
			/* no archives yet */
		}
		for (const entry of entries) {
			const target = join(archiveRoot(), entry.name);
			try {
				if (Date.now() - lstatSync(target).mtimeMs > ttl) {
					rmSync(target, { recursive: true, force: true });
					result.expired++;
				}
			} catch {
				/* raced with something else */
			}
		}
	}
	return result;
}


/**
 * The one-time move from per-chat workspaces and shared folders to one workspace per key, recorded in
 * the `meta` table so it never runs twice:
 *
 *   - a key's old shared folder (`files/<scope>`) becomes its workspace (`workspaces/<scope>`), when
 *     the workspace does not exist yet;
 *   - the old per-chat workspaces (`workspaces/<uuid>`) go to the archive, where they expire by
 *     ARCHIVE_TTL_MS like anything else there;
 *   - stored chats are forgotten (their sessions lived in the old layout), so those chats start over
 *     and the client's transcript is replayed once;
 *   - stale bridge sockets from the old layout are removed.
 *
 * Profiles, keys, the ledger and settings are untouched. Paths are parameters for the tests.
 */
export function migrateToContainers({
	database = db,
	root = workspaceRoot(),
	archive = archiveRoot(),
	// Only where the database itself says the old shared folders were. A fresh database, or a scratch
	// copy, has no such record, and must never go looking in the default place: that belongs to the
	// gateway that owns it.
	filesRoot = database.prepare("SELECT value FROM meta WHERE key = 'legacy-key-files-root'").get()?.value || null,
	run = `${workspaceRoot()}-run`,
} = {}) {
	if (database.prepare("SELECT 1 FROM meta WHERE key = 'containers-migration'").get()) return null;
	const result = { workspaces: 0, archived: 0, chats: 0 };
	if (root) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		mkdirSync(archive, { recursive: true, mode: 0o700 });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		for (const name of readdirSync(root)) {
			if (!uuid.test(name)) continue;
			try {
				renameSync(join(root, name), join(archive, `${name}-before-containers-${stamp}`));
				result.archived++;
			} catch (err) {
				process.stderr.write(`migration: could not archive ${name}: ${err?.message ?? err}\n`);
			}
		}
		let scopes = [];
		try {
			if (filesRoot) scopes = readdirSync(filesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			/* no shared folders yet */
		}
		for (const scope of scopes) {
			const target = join(root, scope);
			if (existsSync(target)) continue;
			try {
				renameSync(join(filesRoot, scope), target);
				result.workspaces++;
			} catch (err) {
				process.stderr.write(`migration: could not move the shared folder ${scope} to its workspace: ${err?.message ?? err}\n`);
			}
		}
	}
	result.chats = database.prepare("DELETE FROM chats").run().changes;
	try {
		for (const name of readdirSync(run)) if (name.endsWith(".sock")) rmSync(join(run, name), { force: true });
	} catch {
		/* no old sockets */
	}
	database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('containers-migration', ?)").run(String(Date.now()));
	return result;
}

// ---------------------------------------------------------------------------------------------
// The Containers page: what exists, how it is doing, and what the operator can do to it
// ---------------------------------------------------------------------------------------------

const MB = 1024 * 1024;

/** Live usage is a `docker stats` call, so it is reused for a few seconds; a busy dashboard polls. */
let statsCache = { at: 0, key: "", data: new Map() };
const STATS_TTL_MS = 5000;

/**
 * Every container this gateway made, joined with what the gateway knows of its chat: whose it is,
 * whether the chat is running, stopped (and will resume) or has none (an orphan a sweep will remove),
 * and how it is using the machine. `docker` is asked once each for the details, the usage and, from
 * the cache, the disk figures (see pollDisk).
 */
export async function listContainers({ now = Date.now() } = {}) {
	refreshDiskSoon(now);
	const managed = await listManaged();
	const names = managed.map((c) => c.name);
	const info = await inspectMany(names);
	const runningNames = names.filter((n) => info.get(n)?.State?.Running);
	const statsKey = runningNames.join(",");
	if (now - statsCache.at > STATS_TTL_MS || statsCache.key !== statsKey) statsCache = { at: now, key: statsKey, data: await containerStats(runningNames), };
	const live = sessions.liveByChatKey();
	const stored = sessions.storedRows();
	const currentImages = new Map();
	const rows = [];
	// The Pi inside each container, from the cache; what is missing is read in the background, so the list never waits for it.
	const hostPi = await hostPiVersion();
	const piVersions = piVersionsFor(managed.map((c) => ({ name: c.name, id: info.get(c.name)?.Id ?? "", image: info.get(c.name)?.Config?.Image ?? "" })).filter((i) => i.id));
	for (const c of managed) {
		const persistent = isKeyContainer(c.name);
		const key = persistent ? null : chatKeyOfContainer(c.name);
		const detail = info.get(c.name);
		// A persistent container belongs to a key, not a chat: the chats in it are the key's live ones.
		const chats = persistent ? sessions.recordsByKey(c.keyId || null).filter((r) => r.container?.name === c.name) : [];
		const record = persistent ? chats[0] ?? null : key ? live.get(key) : null;
		const row = key ? stored.find((r) => r.id_hash.startsWith(key)) : null;
		const image = detail?.Config?.Image ?? "";
		if (image && !currentImages.has(image)) currentImages.set(image, (await imageInfo(image))?.id ?? null);
		const usage = statsCache.data.get(c.name);
		const disk = diskState.containers.get(c.name);
		const startedAt = detail?.State?.Running ? Date.parse(detail.State.StartedAt) : null;
		const keyId = c.keyId === "" ? null : c.keyId;
		rows.push({
			name: c.name,
			chatKey: key,
			persistent,
			piVersion: piVersions.get(c.name)?.version ?? null,
			piSource: piVersions.get(c.name)?.source ?? null,
			piStatus: piVersions.has(c.name) ? piStatus(piVersions.get(c.name).version, hostPi) : "unknown",
			update: lastUpdates.get(c.name) ?? null,
			agentId: c.agentId ?? null,
			chats: persistent ? chats.length : record ? 1 : 0,
			state: detail?.State?.Status ?? c.state,
			// A persistent container with no chat right now is "kept", not an orphan: it is meant to outlast them.
			status: persistent ? (chats.length ? "live" : (c.agentId ? agents.get(c.agentId) : apiKeys.get(c.keyId)?.container?.persistent) ? "kept" : "orphan") : record ? "live" : row ? "stopped" : "orphan",
			keyId,
			key: keyId ? keyLabel(c.agentId ? agentScope(keyId, c.agentId) : keyId) : c.keyId === "" ? "(no key)" : "(unknown)",
			fingerprint: persistent ? null : (record ? chatIdHash(record.id) : row?.id_hash)?.slice(0, 8) ?? null,
			image,
			imageStale: Boolean(image && currentImages.get(image) && detail?.Image && detail.Image !== currentImages.get(image)),
			createdAt: detail?.Created ? Date.parse(detail.Created) : null,
			startedAt,
			uptimeMs: startedAt ? now - startedAt : 0,
			memoryLimitMb: detail?.HostConfig?.Memory ? Math.round(detail.HostConfig.Memory / MB) : 0,
			cpu: usage?.cpu ?? null,
			memUsedMb: usage ? Math.round(usage.memUsed / MB) : null,
			pids: usage?.pids ?? null,
			diskMb: disk ? Math.round(disk.rw / MB) : null,
			requests: persistent ? chats.reduce((n, r) => n + r.requests, 0) : record?.requests ?? row?.requests ?? 0,
			lastUsedAt: persistent ? Math.max(0, ...chats.map((r) => r.lastUsedAt)) || null : record?.lastUsedAt ?? row?.last_used_at ?? null,
			inflight: persistent ? chats.reduce((n, r) => n + r.inflight, 0) : record?.inflight ?? 0,
			network: Object.keys(detail?.NetworkSettings?.Networks ?? {})[0] ?? null,
		});
	}
	rows.sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
	return { containers: rows, disk: diskSummary(), events: recentEvents.slice(-50).reverse(), hostPiVersion: hostPi };
}

/** What can be done to a container: stop it (the chat resumes), recreate it clean, or remove it and end the chat. */
export const CONTAINER_ACTIONS = ["stop", "recreate", "remove"];

/**
 * Do one of those to a container. It goes through the session controller when the chat is live, so
 * its spend is recorded and its Pi exits first; a stopped or orphaned container goes straight to the
 * engine. Every action is audited. Returns a sentence saying what happened.
 */
export async function containerAction(name, action) {
	if (!CONTAINER_ACTIONS.includes(action)) throw new EngineError(`unknown action ${action}`, 400);
	const key = chatKeyOfContainer(name);
	if (key === null) throw new EngineError(`${name} is not one of this gateway's containers`, 404);
	const details = (await inspectMany([name])).get(name);
	if (!details) throw new EngineError(`no container ${name}`, 404);
	if (isKeyContainer(name)) return keyContainerAction(name, action, details.Config?.Labels?.["piper.key"] || null);
	const known = sessions.liveByChatKey().has(key) || sessions.storedRows().some((r) => r.id_hash.startsWith(key));
	let message;
	if (action === "stop") {
		const record = sessions.stopByChatKey(key);
		if (record) await record.stopped;
		else await stopContainer(name);
		message = record ? "the chat was stopped; it resumes on its next message" : "the container was stopped";
	} else if (action === "recreate") {
		// Stop it, then remove the container but keep the chat's row and Pi session: the next message
		// builds a clean container and the conversation continues in it. `expectId` guards a message that
		// resumes the chat in the meantime: the container by this name could by then already be the fresh
		// one that message built, not the one just stopped, and removing it would lose what was just resumed.
		const record = sessions.stopByChatKey(key);
		if (record) await record.stopped;
		const { skipped } = await removeContainer(name, { expectId: details.Id });
		message = skipped ? "a message arrived first and already gave the chat a clean container; nothing was removed" : known ? "the container was removed; the chat gets a clean one on its next message and its conversation continues" : "the container was removed";
	} else {
		const record = sessions.stopByChatKey(key, { end: true });
		if (record) await record.stopped;
		else if (!sessions.endStoredByChatKey(key)) await removeContainer(name, { expectId: details.Id });
		message = known ? "the chat was ended and its container removed (its workspace is kept)" : "the container was removed";
	}
	audit(`container.${action}`, name, message);
	return message;
}

/**
 * The same three actions on a persistent key's container. It holds every chat of the key, so they act on
 * all of them: stop hibernates the chats and stops the container (its packages stay); recreate and
 * remove throw the container and its saved state away, which is what "reset" means, hibernating the
 * chats (they continue in a clean container) or ending them.
 */
async function keyContainerAction(name, action, keyId) {
	const chats = sessions.recordsByKey(keyId).filter((r) => r.container?.name === name);
	const stopAll = async (end) => {
		for (const r of chats) end ? sessions.close(r.id) : sessions.hibernate(r.id);
		await Promise.all(chats.map((r) => r.stopped));
	};
	let message;
	if (action === "stop") {
		await stopAll(false);
		await stopContainer(name);
		message = `the key's container was stopped (${chats.length} chat(s) hibernated); what is installed in it stays, and it starts again with the next message`;
	} else if (action === "recreate") {
		await stopAll(false);
		await removeKeyContainer(name);
		message = "the key's container and everything installed in it were removed; its next chat starts from the clean image (workspace, profile and conversations are kept)";
	} else {
		await stopAll(true);
		await removeKeyContainer(name);
		message = `the key's container was removed and its ${chats.length} running chat(s) ended (workspace and profile are kept)`;
	}
	audit(`container.${action}`, name, message);
	return message;
}

/** Run a command in a container, as root. Audited with the start of the command. */
export async function containerExec(name, command, timeoutMs) {
	if (chatKeyOfContainer(name) === null) throw new EngineError(`${name} is not one of this gateway's containers`, 404);
	const text = String(command ?? "").trim();
	if (!text) throw new EngineError("a command is required", 400);
	if (text.length > 4000) throw new EngineError("the command is too long", 400);
	const details = (await inspectMany([name])).get(name);
	if (!details) throw new EngineError(`no container ${name}`, 404);
	if (!details.State?.Running) throw new EngineError("the container is not running: a chat's container runs while the chat is; send the chat a message first", 409);
	audit("container.exec", name, text);
	return execIn(name, text, timeoutMs);
}

// ---------------------------------------------------------------------------------------------
// Disk: what containers have written, and what is left of the disk Docker lives on
// ---------------------------------------------------------------------------------------------

export const diskState = { at: 0, containers: new Map(), host: null, low: false, over: [] };
let rootDir = "";

/** The disk figures for the dashboard: free space on Docker's disk, and the containers over their limit. */
export function diskSummary() {
	const host = diskState.host;
	return {
		at: diskState.at || null,
		freeMb: host ? Math.round(host.freeBytes / MB) : null,
		totalMb: host ? Math.round(host.totalBytes / MB) : null,
		path: host?.path ?? null,
		warnBelowMb: config.DISK_FREE_WARN_MB,
		low: diskState.low,
		containerLimitMb: config.CONTAINER_DISK_MB,
		over: diskState.over,
	};
}

/**
 * Measure, then warn where a threshold is crossed: the disk Docker uses being low, or one container
 * having written more than CONTAINER_DISK_MB. A warning, not an action: the recreate button and
 * pruning images are the remedies. `statfs` and `now` are parameters for the tests.
 */
export async function pollDisk({ statfs = statfsSync, now = Date.now() } = {}) {
	diskState.containers = await diskUsage();
	rootDir ||= (await dockerRootDir()) || "";
	let host = null;
	for (const path of [rootDir, GATEWAY_DIR].filter(Boolean)) {
		try {
			const st = statfs(path);
			host = { path, freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
			break;
		} catch {
			/* not readable here (rootless Docker, a remote daemon): try the next */
		}
	}
	diskState.host = host;
	diskState.at = now;
	const warnBytes = config.DISK_FREE_WARN_MB * MB;
	diskState.low = Boolean(host && warnBytes > 0 && host.freeBytes < warnBytes);
	if (diskState.low) {
		await alert("disk_low", `only ${Math.round(host.freeBytes / MB)} MB free on ${host.path} (warning below ${config.DISK_FREE_WARN_MB} MB): chats cannot install or write once it is full`, { freeMb: Math.round(host.freeBytes / MB), path: host.path });
	} else {
		await recovered("disk_low", `free space on ${host?.path ?? "the disk"} is back above the warning level`);
	}
	const limit = config.CONTAINER_DISK_MB * MB;
	diskState.over = limit > 0 ? [...diskState.containers].filter(([, d]) => d.rw > limit).map(([name, d]) => ({ name, mb: Math.round(d.rw / MB) })) : [];
	for (const { name, mb } of diskState.over) {
		await alert(`container_disk:${name}`, `container ${name} has written ${mb} MB, over the ${config.CONTAINER_DISK_MB} MB warning: recreate it on the Containers page, or ask what the agent is downloading`, { container: name, mb });
	}
	return diskState;
}

/**
 * The disk walk is slow, so it is not done per page view. But a page opened after minutes without one
 * would show no disk figures until the next five-minute tick, so opening it starts a measurement in
 * the background when the last is two minutes old (one at a time; this view shows it on its next poll).
 */
let diskInFlight = null;
export function refreshDiskSoon(now = Date.now(), maxAgeMs = 2 * 60_000) {
	if (diskInFlight || (diskState.at && now - diskState.at < maxAgeMs)) return;
	diskInFlight = pollDisk().catch(() => {}).finally(() => { diskInFlight = null; });
}

/** Measure now and every five minutes. Started by the server, never at import. */
export function startDiskWatch() {
	const run = () => void pollDisk().catch((err) => process.stderr.write(`disk check failed: ${err?.message ?? err}\n`));
	setInterval(run, 5 * 60_000).unref();
	run();
}

// ---------------------------------------------------------------------------------------------
// Events: containers killed for memory, or gone
// ---------------------------------------------------------------------------------------------

/** What happened to containers lately, newest last, for the Containers page. */
export const recentEvents = [];
const REASON_MS = 2 * 60_000;

/** Why a container's Pi may have just died, from an event in the last two minutes, or null. */
export function recentReasonFor(name, now = Date.now()) {
	for (let i = recentEvents.length - 1; i >= 0; i--) {
		const e = recentEvents[i];
		if (e.container === name && now - e.ts < REASON_MS) return e.message;
	}
	return null;
}

/**
 * Record an event, tell the chat it belongs to (its next reply starts with a notice), and raise an
 * alert. `memoryMb` is what the container was limited to, for the message.
 */
export function handleContainerEvent(event, { memoryMb = 0, now = Date.now() } = {}) {
	const message = event.action === "oom"
		? `a process in this chat's container was killed: out of memory${memoryMb ? ` (limit ${memoryMb} MB)` : ""}`
		: `the container stopped unexpectedly${event.exitCode !== null ? ` (exit code ${event.exitCode})` : ""}`;
	recentEvents.push({ ts: now, kind: event.action === "oom" ? "oom" : "died", container: event.name, message });
	audit(event.action === "oom" ? "runtime.container_killed" : "runtime.container_died", event.name, message, { actor: "system" });
	if (recentEvents.length > 200) recentEvents.shift();
	const key = chatKeyOfContainer(event.name);
	// A persistent container's chats all hear of it.
	const records = isKeyContainer(event.name) ? sessions.allRecords().filter((r) => r.container?.name === event.name) : key && sessions.liveByChatKey().get(key) ? [sessions.liveByChatKey().get(key)] : [];
	for (const record of records) (record.notices ??= []).push(message);
	void alert(`container_${event.action}:${event.name}`, `${event.name}: ${message}`, { container: event.name, exitCode: event.exitCode });
	return message;
}

/** Watch for kills and deaths, and hear about readiness changes. Started by the server. */
export function startEventWatch() {
	onReadinessChange((status) => {
		audit("runtime.engine", status.ok ? "ready" : "not ready", status.ok ? "Docker, the image and the network policy are in order" : status.problems.join("; "), { actor: "system" });
		if (status.ok) void recovered("engine", "containers can run again: Docker, the image and the network policy are in order");
		else void alert("engine", `chats cannot start: ${status.problems.join("; ")}`, { problems: status.problems });
	});
	return watchEvents(async (event) => {
		const memoryMb = Math.round(((await inspectMany([event.name])).get(event.name)?.HostConfig?.Memory ?? 0) / MB);
		handleContainerEvent(event, { memoryMb });
	});
}
