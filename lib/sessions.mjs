/** Sessions: the session controller, workspaces, and the spend ledger and limits. */
import crypto from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { basename, join } from "node:path";
import { config, db } from "./settings.mjs";
import { apiKeys } from "./auth.mjs";
import { archiveRoot, runRoot, workspaceRoot } from "./sandbox.mjs";
import { createSession } from "./runner.mjs";

/**
 * Owns the per-session workspace directories.
 *
 * The cross-session safety comes from the sandbox masking the whole root; this class is about
 * disk and durability, not isolation. `sweep` is what makes WORKSPACE_ON_EXPIRY true across a
 * restart: the registry is in memory, so a previous run's directories are all orphans.
 */
export class WorkspaceManager {
	#settings;

	/** Settings are injected so the policies can be exercised against a scratch root; the default
	 *  reads the live values, so a policy change applies without a restart. */
	constructor(settings) {
		this.#settings =
			settings ??
			(() => ({
				root: workspaceRoot(),
				archiveRoot: archiveRoot(),
				policy: config.WORKSPACE_ON_EXPIRY,
				archiveTtlMs: config.WORKSPACE_ARCHIVE_TTL_MS,
			}));
	}

	/**
	 * The sandbox masks these paths, and bubblewrap cannot create a mountpoint on a read-only
	 * root, so both roots have to exist on disk before the first command runs. Without this the
	 * sandbox fails closed and every command is refused.
	 */
	ensureRoots() {
		const { root, archiveRoot: archive } = this.#settings();
		if (!root) return;
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			mkdirSync(archive, { recursive: true, mode: 0o700 });
		} catch (err) {
			process.stderr.write(`cannot create the workspace roots: ${err?.message ?? err}\n`);
		}
	}

	create() {
		const { root } = this.#settings();
		if (!root) return null;
		this.ensureRoots();
		const dir = join(root, crypto.randomUUID());
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	release(workspace) {
		if (!workspace || !existsSync(workspace)) return;
		const { archiveRoot: archive, policy } = this.#settings();
		try {
			// bwrap leaves an empty `shared` mountpoint behind for the key's shared folder, whose real
			// files live elsewhere. It is not the session's work, so it goes before anything is judged.
			const mountpoint = join(workspace, "shared");
			try {
				if (lstatSync(mountpoint).isDirectory() && readdirSync(mountpoint).length === 0) rmSync(mountpoint, { recursive: true });
			} catch {
				/* no mountpoint */
			}
			// A workspace nothing was ever written to (a request rejected before it ran, or a one-off
			// title request) is not worth archiving, so it goes regardless of the policy. Pi's own
			// session record under .piper is bookkeeping, not work.
			if (readdirSync(workspace).filter((e) => e !== ".piper").length === 0) {
				rmSync(workspace, { recursive: true, force: true });
				return;
			}
			if (policy === "keep") return;
			if (policy === "delete") {
				rmSync(workspace, { recursive: true, force: true });
				return;
			}
			mkdirSync(archive, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			renameSync(workspace, join(archive, `${basename(workspace)}-${stamp}`));
		} catch (err) {
			// Anything unexpected leaves the directory in place rather than destroying it.
			process.stderr.write(`workspace release failed for ${workspace}: ${err?.message ?? err}\n`);
		}
	}

	sweep(live = new Set()) {
		const { root, archiveRoot: archive, archiveTtlMs } = this.#settings();
		let orphans = 0;
		let expired = 0;
		if (root) {
			let entries = [];
			try {
				entries = readdirSync(root, { withFileTypes: true });
			} catch {
				/* root not created yet */
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const dir = join(root, entry.name);
				if (live.has(dir)) continue;
				// ponytail: a directory touched in the last minute might belong to another gateway
				// instance that has just started, so it is skipped this tick rather than archived.
				// The registry's own close() path handles genuinely expired sessions immediately.
				try {
					if (Date.now() - statSync(dir).mtimeMs < 60_000) continue;
				} catch {
					continue;
				}
				this.release(dir);
				orphans++;
			}
		}
		if (archiveTtlMs > 0) {
			let entries = [];
			try {
				entries = readdirSync(archive, { withFileTypes: true });
			} catch {
				/* no archives yet */
			}
			for (const entry of entries) {
				const target = join(archive, entry.name);
				try {
					if (Date.now() - statSync(target).mtimeMs > archiveTtlMs) {
						rmSync(target, { recursive: true, force: true });
						expired++;
					}
				} catch {
					/* raced with something else */
				}
			}
		}
		return { orphans, expired };
	}
}

export const workspaces = new WorkspaceManager();

/**
 * Stable, non-reversible short id for display.
 *
 * A session id is a bearer credential: anyone holding it can continue that chat. The
 * dashboard therefore shows this digest instead, which is enough to tell rows apart and
 * follow one over time but cannot be pasted into a request to resume the session.
 */
export function fingerprint(id) {
	return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8);
}

/** Which of the three limits would fire first, for display. */
export function expiryReason(lifetimeLeft, idleLeft, orphanLeft) {
	if (orphanLeft < lifetimeLeft && orphanLeft < idleLeft) return "one-shot";
	if (lifetimeLeft <= idleLeft) return "lifetime";
	return "idle";
}

/**
 * Owns every live Pi session.
 *
 * One Pi AgentSession per session id, never shared between ids. A session is held
 * until the hard lifetime cap, the idle timeout, or LRU eviction at MAX_SESSIONS —
 * whichever comes first — then disposed.
 *
 * `create` is injected so the lifecycle is testable without spawning real Pi sessions.
 */
export class SessionController {
	#sessions = new Map();
	#create;
	#max;
	#maxLifetimeMs;
	#idleMs;
	#oneShotMs;
	#workspaces;
	#history = [];
	#lastSampleAt = 0;
	#timer;
	#store;
	#persistable;

	constructor({ create, maxSessions, maxLifetimeMs, idleMs, oneShotMs = 0, workspaces: workspaceStore, sweepMs = 60_000, store = null, persistable = () => true }) {
		this.#create = create;
		this.#max = maxSessions;
		this.#maxLifetimeMs = maxLifetimeMs;
		this.#idleMs = idleMs;
		this.#oneShotMs = oneShotMs;
		// Defaulted so the controller can be tested without touching a filesystem.
		this.#workspaces = workspaceStore ?? { create: () => null, release: () => {} };
		// Where resumable chats are kept (the `chats` table in production). Without one, a stopped
		// session is gone, which is what the in-process runner and most tests want.
		this.#store = store;
		this.#persistable = persistable;
		if (sweepMs > 0) {
			this.#timer = setInterval(() => this.reap(), sweepMs);
			this.#timer.unref?.();
		}
	}

	get size() {
		return this.#sessions.size;
	}

	/**
	 * Apply changed limits to the running controller. Settings that only affect future work
	 * (a session's model, its agent directory) are not here; this is the reaping policy, which
	 * is read on every tick and can change live.
	 */
	configure({ maxSessions, maxLifetimeMs, idleMs, oneShotMs }) {
		if (maxSessions != null) this.#max = maxSessions;
		if (maxLifetimeMs != null) this.#maxLifetimeMs = maxLifetimeMs;
		if (idleMs != null) this.#idleMs = idleMs;
		if (oneShotMs != null) this.#oneShotMs = oneShotMs;
	}

	/**
	 * The record for `requestId`, spawning one if needed. A null id always mints a
	 * fresh unguessable session, so two callers can never end up sharing one agent.
	 */
	acquire(requestId, credential = null) {
		if (requestId) {
			const existing = this.#sessions.get(requestId);
			if (existing) {
				existing.requests += 1;
				existing.lastUsedAt = Date.now();
				return { id: requestId, record: existing, isNew: false };
			}
			// A chat that was hibernated — by a restart, an eviction, or a crash — resumes where it
			// was: same workspace, same Pi session, same position in the client's transcript.
			const row = this.#store?.get(chatIdHash(requestId));
			if (row) {
				if (row.workspace && existsSync(row.workspace)) {
					return { id: requestId, record: this.#spawn(requestId, credential, row), isNew: false, resumed: true };
				}
				this.#store.delete(row.id_hash);
			}
			return { id: requestId, record: this.#spawn(requestId, credential), isNew: true };
		}
		const id = crypto.randomUUID();
		return { id, record: this.#spawn(id, credential), isNew: true };
	}

	/** One Pi run at a time per session; a failure doesn't wedge the queue behind it. */
	run(record, fn) {
		record.inflight++;
		record.lastUsedAt = Date.now();
		const queued = record.queue.then(fn, fn);
		record.queue = queued.then(
			() => {},
			() => {},
		);
		return queued.finally(() => {
			record.inflight--;
			// Activity is the completion, not the start: a long tool run must not look quiet
			// the moment its answer lands, or the one-shot rule would reap it immediately.
			record.lastUsedAt = Date.now();
			this.#persist(record);
		});
	}

	/** Save what a chat needs to be resumed. Called on spawn and after every turn. */
	#persist(record) {
		if (!this.#store || !record.workspace || !this.#persistable(record)) return;
		this.#store.put({
			id_hash: chatIdHash(record.id),
			key_id: record.keyId ?? null,
			workspace: record.workspace,
			created_at: record.createdAt,
			last_used_at: record.lastUsedAt,
			requests: record.requests,
			state_json: JSON.stringify(record.state),
		});
	}

	/**
	 * Stop a chat's process but keep it resumable: its spend is recorded and its agent stopped, but
	 * its workspace and stored row stay, so the next message for the same id picks it up. Used for
	 * eviction, shutdown, a dead agent, and a profile being replaced underneath it. Falls back to
	 * ending the chat where nothing can be resumed (no store, or the in-process runner).
	 */
	hibernate(id) {
		const record = this.#sessions.get(id);
		if (!record) return false;
		if (!this.#store || !this.#persistable(record)) return this.close(id);
		this.#persist(record);
		this.#sessions.delete(id);
		record.stopped = record.sessionPromise.then(
			(session) => {
				recordSpend(record, session);
				session.dispose?.();
			},
			() => {},
		);
		return true;
	}

	/** Hibernate every live chat, for shutdown. Resolves once their spend is recorded. */
	async hibernateAll() {
		const records = [...this.#sessions.values()];
		for (const record of records) this.hibernate(record.id);
		await Promise.all(records.map((r) => r.stopped ?? Promise.resolve()));
		return records.length;
	}

	/** End a chat for good: its spend is recorded, its workspace released, and it is no longer resumable. */
	close(id) {
		const record = this.#sessions.get(id);
		if (!record) return false;
		this.#store?.delete(chatIdHash(id));
		this.#sessions.delete(id);
		record.sessionPromise.then(
			(session) => {
				recordSpend(record, session);
				session.dispose?.();
			},
			() => {},
		);
		// Every way a session can end funnels through here, so the workspace policy is applied
		// in exactly one place: reaping, LRU eviction, a manual kill, shutdown, and a request
		// rejected before its agent ever ran.
		this.#workspaces.release(record.workspace);
		return true;
	}

	/** Live cost and token totals, read off each session's own stats. */
	/** Live usage grouped by the key that opened each session. */
	async liveByKey() {
		const out = new Map();
		for (const record of this.#sessions.values()) {
			const session = await record.sessionPromise.catch(() => null);
			const stats = session?.getSessionStats?.();
			const keyId = record.keyId ?? null;
			const acc = out.get(keyId) ?? { keyId, cost: 0, tokens: 0, requests: 0, sessions: 0 };
			acc.cost += Number(stats?.cost) || 0;
			acc.tokens += stats?.tokens?.total ?? 0;
			acc.requests += record.requests ?? 0;
			acc.sessions += 1;
			out.set(keyId, acc);
		}
		return [...out.values()];
	}

	async liveStats() {
		let cost = 0;
		let tokens = 0;
		for (const record of this.#sessions.values()) {
			const session = await record.sessionPromise.catch(() => null);
			const stats = session?.getSessionStats?.();
			if (!stats) continue;
			cost += Number(stats.cost) || 0;
			tokens += stats.tokens?.total ?? 0;
		}
		return { cost, tokens };
	}

	/** Workspace directories of live sessions, so the sweeper spares them. */
	liveWorkspaces() {
		const live = new Set();
		for (const record of this.#sessions.values()) if (record.workspace) live.add(record.workspace);
		// A hibernated chat's workspace is not an orphan: its next message resumes it.
		for (const row of this.#store?.all() ?? []) if (row.workspace) live.add(row.workspace);
		return live;
	}

	/**
	 * Close the session whose id hashes to `fp`. Rows only carry a fingerprint, so targeting
	 * happens here and the real id never has to leave the process. Refuses when the fingerprint
	 * is not unique, rather than killing an arbitrary agent.
	 */
	closeByFingerprint(fp) {
		const matches = [...this.#sessions.keys()].filter((id) => fingerprint(id) === fp);
		if (matches.length !== 1) return false;
		return this.close(matches[0]);
	}

	has(id) {
		return this.#sessions.has(id);
	}

	/**
	 * Make room for one more session of a key under its limit, by closing that key's least recently
	 * used idle session. Returns false when every one of them is busy.
	 */
	makeRoomForKey(keyId, max) {
		if (!(max > 0)) return true;
		const own = this.recordsByKey(keyId);
		if (own.length < max) return true;
		const idle = own.filter((r) => r.inflight === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
		const excess = own.length - max + 1;
		if (idle.length < excess) return false;
		for (const record of idle.slice(0, excess)) this.close(record.id);
		return true;
	}

	/** The live records a key opened. */
	recordsByKey(keyId) {
		return [...this.#sessions.values()].filter((r) => (r.keyId ?? null) === (keyId ?? null));
	}

	/**
	 * Stop every session a key opened, so they restart on its current profile. They hibernate rather
	 * than end: the next message resumes each conversation, now with the new profile mounted.
	 */
	closeByKey(keyId) {
		const ids = [...this.#sessions.values()].filter((r) => (r.keyId ?? null) === (keyId ?? null)).map((r) => r.id);
		for (const id of ids) this.hibernate(id);
		return ids.length;
	}

	closeAll() {
		const ids = [...this.#sessions.keys()];
		for (const id of ids) this.close(id);
		return ids.length;
	}

	/** Dispose sessions past their lifetime or idle timeout. Never reaps a session with work pending. */
	reap(now = Date.now()) {
		this.#sample(now);
		const reaped = [];
		for (const record of this.#sessions.values()) {
			if (record.inflight > 0) continue;
			const pastLifetime = now - record.createdAt > this.#maxLifetimeMs;
			const pastIdle = now - record.lastUsedAt > this.#idleMs;
			const orphaned = this.#oneShotMs > 0 && record.requests <= 1 && now - record.lastUsedAt > this.#oneShotMs;
			if (!pastLifetime && !pastIdle && !orphaned) continue;
			reaped.push(record.id);
			this.close(record.id);
		}
		// Hibernated chats expire by the same rules, measured from their stored times.
		const liveHashes = new Set([...this.#sessions.keys()].map(chatIdHash));
		for (const row of this.#store?.all() ?? []) {
			if (liveHashes.has(row.id_hash)) continue;
			const pastLifetime = now - row.created_at > this.#maxLifetimeMs;
			const pastIdle = now - row.last_used_at > this.#idleMs;
			const orphaned = this.#oneShotMs > 0 && row.requests <= 1 && now - row.last_used_at > this.#oneShotMs;
			if (!pastLifetime && !pastIdle && !orphaned) continue;
			this.#store.delete(row.id_hash);
			this.#workspaces.release(row.workspace);
			reaped.push(row.id_hash);
		}
		return reaped;
	}

	/** Counts only — session ids are bearer secrets, so they are never exposed. */
	stats() {
		let oldest = null;
		for (const record of this.#sessions.values()) if (oldest === null || record.createdAt < oldest) oldest = record.createdAt;
		return {
			active: this.#sessions.size,
			hibernated: Math.max(0, (this.#store?.all().length ?? 0) - this.#sessions.size),
			max: this.#max,
			maxLifetimeMs: this.#maxLifetimeMs,
			idleMs: this.#idleMs,
			oldestAgeMs: oldest === null ? 0 : Date.now() - oldest,
		};
	}

	/**
	 * Per-session view for the dashboard. Async because the model is read off the live
	 * session, so it reflects pi_set_model swaps immediately.
	 */
	async snapshot() {
		const now = Date.now();
		this.#sample(now);
		const rows = await Promise.all(
			[...this.#sessions.values()].map(async (record) => {
				const session = await record.sessionPromise.catch(() => null);
				const stats = session?.getSessionStats?.();
				const lifetimeLeft = record.createdAt + this.#maxLifetimeMs - now;
				const idleLeft = record.lastUsedAt + this.#idleMs - now;
				const orphanLeft = this.#oneShotMs > 0 && record.requests <= 1 ? record.lastUsedAt + this.#oneShotMs - now : Infinity;
				const soonest = Math.min(lifetimeLeft, idleLeft, orphanLeft);				return {
					fingerprint: fingerprint(record.id),
					provider: session?.model?.provider ?? null,
					model: session?.model?.id ?? null,
					ageMs: now - record.createdAt,
					idleMs: now - record.lastUsedAt,
					expiresInMs: Math.max(0, soonest),
					expiresBecause: expiryReason(lifetimeLeft, idleLeft, orphanLeft),
					inflight: record.inflight,
					requests: record.requests,
					// Live spend for this session. Pi aggregates over compacted-away history too, so it is
					// what was actually billed so far, not an estimate.
					cost: Number(stats?.cost) || 0,
					tokens: stats?.tokens?.total ?? 0,
				};
			}),
		);
		rows.sort((a, b) => a.expiresInMs - b.expiresInMs);
		return {
			count: rows.length,
			max: this.#max,
			maxLifetimeMs: this.#maxLifetimeMs,
			idleMs: this.#idleMs,
			oneShotMs: this.#oneShotMs,
			history: this.#history,
			// Persisted ledger totals, so the spend figures survive reaping and restarts. Live spend is
			// the sum of the per-session costs below.
			spend: spendTotals(),
			sessions: rows,
		};
	}

	/**
	 * Rolling sample of the live-agent count, for the dashboard trend. Sampled at most every 15s
	 * from the reaper tick and from snapshot(), so the line is real observed data rather than a
	 * fabricated curve. Keeps one hour.
	 */
	#sample(now) {
		if (now - this.#lastSampleAt < 15_000) return;
		this.#lastSampleAt = now;
		this.#history.push({ t: now, count: this.#sessions.size });
		if (this.#history.length > 240) this.#history.shift();
	}

	#spawn(id, credential = null, row = null) {
		this.#evictOldest();
		const now = Date.now();
		// A fresh UUID per record, never the client's session id: a caller-supplied id must not be
		// able to steer where a directory is created. A resumed chat keeps the one it had.
		const workspace = row ? row.workspace : this.#workspaces.create();
		const record = {
			id,
			workspace,
			// Which key opened this session, recorded once. A session continued by a different key
			// stays attributed to whoever created it.
			keyId: credential?.id ?? null,
			keyName: credential?.name ?? null,
			sessionPromise: null,
			queue: Promise.resolve(),
			state: row ? JSON.parse(row.state_json) : { forwarded: 0, lastUserText: null },
			// Tells the runner to continue the Pi session stored in the workspace rather than start one.
			resume: Boolean(row),
			inflight: 0,
			requests: row ? row.requests + 1 : 1,
			// Fallback bookkeeping: which model to go back to, and when we switched.
			primaryModel: null,
			fallbackActive: false,
			fallbackAt: null,
			createdAt: row ? row.created_at : now,
			lastUsedAt: now,
		};
		if (row) record.keyId = row.key_id ?? record.keyId;
		record.sessionPromise = this.#create(workspace, record);
		// Kept on the record once it exists, so synchronous readers (spend limits) can see it.
		record.sessionPromise.then((session) => (record.session = session), () => {});
		this.#sessions.set(id, record);
		this.#persist(record);
		return record;
	}

	#evictOldest() {
		if (this.#sessions.size < this.#max) return;
		let victim;
		for (const record of this.#sessions.values()) {
			if (record.inflight > 0) continue;
			if (!victim || record.lastUsedAt < victim.lastUsedAt) victim = record;
		}
		// ponytail: when every session is busy we overshoot the cap rather than break in-flight work
		// Evicted, not ended: the chat resumes if its client comes back.
		if (victim) this.hibernate(victim.id);
	}
}

/** The hash a chat is stored under. The session id itself is a bearer secret and never stored. */
export function chatIdHash(id) {
	return crypto.createHash("sha256").update(String(id)).digest("hex");
}

/** The `chats` table, as the session controller's store. */
export const chatStore = {
	get: (idHash) => db.prepare("SELECT * FROM chats WHERE id_hash = ?").get(idHash) ?? null,
	put: (row) =>
		db
			.prepare(
				"INSERT INTO chats (id_hash, key_id, workspace, created_at, last_used_at, requests, state_json) VALUES (?, ?, ?, ?, ?, ?, ?) " +
					"ON CONFLICT(id_hash) DO UPDATE SET key_id = excluded.key_id, workspace = excluded.workspace, last_used_at = excluded.last_used_at, " +
					"requests = excluded.requests, state_json = excluded.state_json",
			)
			.run(row.id_hash, row.key_id, row.workspace, row.created_at, row.last_used_at, row.requests, row.state_json),
	delete: (idHash) => db.prepare("DELETE FROM chats WHERE id_hash = ?").run(idHash),
	all: () => db.prepare("SELECT * FROM chats").all(),
};

export const sessions = new SessionController({
	create: createSession,
	maxSessions: config.MAX_SESSIONS,
	maxLifetimeMs: config.SESSION_MAX_LIFETIME_MS,
	idleMs: config.SESSION_IDLE_MS,
	oneShotMs: config.ONE_SHOT_TTL_MS,
	workspaces,
	store: chatStore,
	// Only a sandboxed Pi keeps its session on disk; an in-process one has nothing to resume.
	persistable: () => config.RUNNER !== "inprocess",
});

/**
 * Reconcile workspaces against the live set, and expire old archives.
 *
 * The registry is in memory, so on the first run of a process every directory on disk is an
 * orphan. That is what makes WORKSPACE_ON_EXPIRY true across a restart rather than only while the
 * process happens to be alive — and with `delete` it means a restart expires every workspace.
 */
export function sweepWorkspaces() {
	workspaces.ensureRoots();
	const { orphans, expired } = workspaces.sweep(sessions.liveWorkspaces());
	if (orphans || expired) {
		process.stderr.write(`workspace sweep: ${orphans} orphaned, ${expired} archive(s) expired\n`);
	}
}
setInterval(sweepWorkspaces, 60_000).unref();
sweepWorkspaces();

/**
 * Remove bridge sockets nobody is listening on, left behind by a gateway that was killed rather than
 * shut down. A socket is only removed when connecting to it is refused, so a second gateway sharing
 * the directory keeps its own; one younger than a minute is skipped as possibly still starting.
 */
export async function sweepSockets(dir = runRoot()) {
	let names = [];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".sock"));
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		const path = join(dir, name);
		try {
			const stat = lstatSync(path);
			if (!stat.isSocket() || Date.now() - stat.mtimeMs < 60_000) continue;
		} catch {
			continue;
		}
		const stale = await new Promise((resolvePromise) => {
			const probe = netConnect(path);
			probe.once("connect", () => {
				probe.destroy();
				resolvePromise(false);
			});
			probe.once("error", (err) => resolvePromise(err.code === "ECONNREFUSED" || err.code === "ENOENT"));
		});
		if (stale) {
			rmSync(path, { force: true });
			removed++;
		}
	}
	return removed;
}
setInterval(() => void sweepSockets().catch(() => {}), 10 * 60_000).unref();
void sweepSockets().catch(() => {});

/**
 * Record what a session cost, so spend outlives the session.
 *
 * Called on close, which is the single funnel for every way a session can end. A session that
 * generated nothing is not recorded. A ledger failure must never stop a session being disposed,
 * so everything here is swallowed after logging.
 */
export function recordSpend(record, session) {
	try {
		const stats = session?.getSessionStats?.();
		const tokens = stats?.tokens;
		if (!tokens || tokens.total <= 0) return;
		const insert = db.prepare(
			"INSERT INTO spend (fingerprint, provider, model, cost, input, output, cache_read, cache_write, requests, closed_at, key_id) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const now = Date.now();
		const row = (provider, model, part, requests) =>
			insert.run(
				fingerprint(record.id), provider, model, Number(part.cost) || 0,
				part.tokens.input ?? 0, part.tokens.output ?? 0, part.tokens.cacheRead ?? 0, part.tokens.cacheWrite ?? 0,
				requests, now, record.keyId ?? null,
			);
		// One row per model the chat used, when the gateway metered it that way (the sandboxed
		// runners); otherwise one row billed to the model it ended on. The chat's request count goes
		// on its first row only, so per-key request totals stay right.
		const parts = Object.entries(stats.byModel ?? {}).filter(([, p]) => p.tokens.total > 0);
		if (parts.length) {
			parts.forEach(([key, part], i) => {
				const slash = key.indexOf("/");
				row(key.slice(0, slash), key.slice(slash + 1), part, i === 0 ? record.requests ?? 0 : 0);
			});
			return;
		}
		row(session.model?.provider ?? null, session.model?.id ?? null, stats, record.requests ?? 0);
	} catch (err) {
		process.stderr.write(`spend record failed: ${err?.message ?? err}\n`);
	}
}

/** Totals for the dashboard cards. The detailed breakdown lives in /dashboard/spend.json. */
export function spendTotals() {
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	const all = db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS sessions FROM spend").get();
	const today = db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM spend WHERE closed_at >= ?").get(midnight.getTime());
	return { total: Number(all.cost), today: Number(today.cost), sessions: Number(all.sessions) };
}

/** The spend view's report: totals, per model, and per day. */
export async function spendReport() {
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	const total = db
		.prepare(
			"SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, " +
				"COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite, COUNT(*) AS sessions FROM spend",
		)
		.get();
	const today = db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS sessions FROM spend WHERE closed_at >= ?").get(midnight.getTime());
	const byModel = db
		.prepare(
			"SELECT provider, model, COALESCE(SUM(cost), 0) AS cost, " +
				"COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens, COUNT(*) AS sessions " +
				"FROM spend GROUP BY provider, model ORDER BY cost DESC, sessions DESC",
		)
		.all();
	const byDay = db
		.prepare(
			"SELECT date(closed_at / 1000, 'unixepoch', 'localtime') AS day, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS sessions " +
				"FROM spend GROUP BY day ORDER BY day DESC LIMIT 60",
		)
		.all();
	return {
		today: { cost: Number(today.cost), sessions: Number(today.sessions) },
		total: {
			cost: Number(total.cost),
			sessions: Number(total.sessions),
			input: Number(total.input),
			output: Number(total.output),
			cacheRead: Number(total.cacheRead),
			cacheWrite: Number(total.cacheWrite),
		},
		byModel: byModel.map((r) => ({ ...r, cost: Number(r.cost), tokens: Number(r.tokens), sessions: Number(r.sessions) })),
		byDay: byDay.map((r) => ({ ...r, cost: Number(r.cost), sessions: Number(r.sessions) })),
		live: await sessions.liveStats(),
	};
}

/**
 * The limits that apply to a credential. A key's own setting wins over the gateway default; 0 means
 * unlimited either way. GATEWAY_API_KEY is the operator's own credential, so it is never limited.
 */
export function keyLimits(credential, defaults = { maxSessions: config.KEY_MAX_SESSIONS, dailySpend: config.KEY_DAILY_SPEND_USD }) {
	if (credential && credential.id === "") return { maxSessions: 0, dailySpend: 0 };
	const record = credential?.id ? apiKeys.get(credential.id) : null;
	return {
		maxSessions: record?.maxSessions ?? defaults.maxSessions ?? 0,
		dailySpend: record?.dailySpend ?? defaults.dailySpend ?? 0,
	};
}

/** Local midnight, the start of "today" for spend limits, matching the Spend page. */
export function startOfToday(now = Date.now()) {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	return midnight.getTime();
}

/**
 * What a key has spent today: the ledger rows closed since midnight, plus what its live sessions
 * have run up so far. Both come from the gateway's own metering, never from a sandbox's report.
 */
export function spentToday(keyId) {
	const row = db
		.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM spend WHERE closed_at >= ? AND key_id IS ?")
		.get(startOfToday(), keyId ?? null);
	let live = 0;
	for (const record of sessions.recordsByKey(keyId)) live += Number(record.session?.getSessionStats?.().cost) || 0;
	return Number(row.cost) + live;
}

/** Why a key may not make another model call today, or null while it is under its cap. */
export function spendRefusal(credentialOrKeyId) {
	const credential = typeof credentialOrKeyId === "object" ? credentialOrKeyId : credentialOrKeyId === undefined ? null : { id: credentialOrKeyId };
	const { dailySpend } = keyLimits(credential);
	if (!(dailySpend > 0)) return null;
	const spent = spentToday(credential?.id ?? null);
	if (spent < dailySpend) return null;
	return `daily spend limit reached: $${spent.toFixed(4)} of $${dailySpend.toFixed(2)} spent today on this key; it resets at local midnight`;
}
