/** Sessions: the session controller, its sweeps, and the spend ledger and limits. */
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { config, db } from "./settings.mjs";
import { audit, purgeAudit } from "./audit.mjs";
import { purgeSpeed } from "./speed.mjs";
import { apiKeys, keyLabel } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { LiveLog } from "./livesession.mjs";
import { chatIdHash } from "./engine.mjs";
import { containerHost, createContainerSession, sweepContainers } from "./containers.mjs";

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
 * `create` is injected so the lifecycle is testable without spawning real Pi sessions. So is `host`,
 * which owns everything a chat has outside this process: the key's workspace (`workspace(keyId)`),
 * and its container, which `stopped(idHash)` stops for a chat that may resume and `ended(idHash)`
 * removes for one that will not.
 */
export class SessionController {
	#sessions = new Map();
	#create;
	#max;
	#maxLifetimeMs;
	#idleMs;
	#oneShotMs;
	#keepMs;
	#host;
	#history = [];
	#lastSampleAt = 0;
	#timer;
	#store;
	#persistable;

	constructor({ create, maxSessions, maxLifetimeMs, idleMs, oneShotMs = 0, keepMs = 0, host, sweepMs = 60_000, store = null, persistable = () => true }) {
		this.#create = create;
		this.#max = maxSessions;
		this.#maxLifetimeMs = maxLifetimeMs;
		this.#idleMs = idleMs;
		this.#oneShotMs = oneShotMs;
		this.#keepMs = keepMs;
		// Defaulted so the controller can be tested without touching a filesystem.
		this.#host = host ?? { workspace: () => null, stopped: () => {}, ended: () => {} };
		// Where resumable chats are kept (the `chats` table in production). Without one, a stopped
		// session is gone, which is what most tests want.
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
	configure({ maxSessions, maxLifetimeMs, idleMs, oneShotMs, keepMs }) {
		if (maxSessions != null) this.#max = maxSessions;
		if (maxLifetimeMs != null) this.#maxLifetimeMs = maxLifetimeMs;
		if (idleMs != null) this.#idleMs = idleMs;
		if (oneShotMs != null) this.#oneShotMs = oneShotMs;
		if (keepMs != null) this.#keepMs = keepMs;
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
	 * Stop a chat's process but keep it resumable: its spend is recorded and its agent stopped, and its
	 * container is stopped, but the container and the stored row stay, so the next message for the same
	 * id picks it up. Used for eviction, shutdown, a dead agent, and a profile being replaced underneath
	 * it. Falls back to ending the chat where nothing can be resumed (no store).
	 */
	hibernate(id) {
		const record = this.#sessions.get(id);
		if (!record) return false;
		if (!this.#store || !this.#persistable(record)) return this.close(id);
		this.#persist(record);
		this.#sessions.delete(id);
		record.live?.end("the chat was put to sleep");
		// Pi first, so nothing is half-way through writing its session file when the container stops.
		const idHash = chatIdHash(id);
		record.stopped = record.sessionPromise
			.then(
				async (session) => {
					recordSpend(record, session);
					await session.dispose?.();
				},
				() => {},
			)
			.then(() => this.#host.stopped(idHash, record))
			.catch(() => {});
		return true;
	}

	/** Hibernate every live chat, for shutdown. Resolves once their spend is recorded. */
	async hibernateAll() {
		const records = [...this.#sessions.values()];
		for (const record of records) this.hibernate(record.id);
		await Promise.all(records.map((r) => r.stopped ?? Promise.resolve()));
		return records.length;
	}

	/** End a chat for good: its spend is recorded, its container removed, and it is no longer resumable. */
	close(id) {
		const record = this.#sessions.get(id);
		if (!record) return false;
		const idHash = chatIdHash(id);
		this.#store?.delete(idHash);
		this.#sessions.delete(id);
		record.live?.end("the chat ended");
		// Every way a session can end funnels through here, so the container is removed in exactly one
		// place: reaping, a manual kill, and a request rejected before its agent ever ran.
		record.stopped = record.sessionPromise
			.then(
				async (session) => {
					recordSpend(record, session);
					await session.dispose?.();
				},
				() => {},
			)
			.then(() => this.#host.ended(idHash))
			.catch(() => {});
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

	/** Live chats by the first 16 hex of their id hash, which is what their containers are named after. */
	liveByChatKey() {
		const out = new Map();
		for (const record of this.#sessions.values()) out.set(chatIdHash(record.id).slice(0, 16), record);
		return out;
	}

	/** The stored (resumable) chats: rows with their id hash, key, timestamps and request count. */
	storedRows() {
		return this.#store?.all() ?? [];
	}

	/**
	 * Stop (`end: false`) or end a live chat by its container's chat key. Returns its record, whose
	 * `stopped` promise settles when its container has been stopped or removed, or null when the chat
	 * is not live.
	 */
	stopByChatKey(key, { end = false } = {}) {
		const record = this.liveByChatKey().get(key);
		if (!record) return null;
		if (end) this.close(record.id);
		else this.hibernate(record.id);
		return record;
	}

	/** End a stopped chat by its container's chat key: its row goes, and so does its container. */
	endStoredByChatKey(key) {
		const row = this.storedRows().find((r) => r.id_hash.startsWith(key));
		if (!row) return false;
		this.#store.delete(row.id_hash);
		Promise.resolve(this.#host.ended(row.id_hash)).catch(() => {});
		return true;
	}

	/** The id hashes of chats that are running, and of every chat that could still be resumed. */
	chatHashes() {
		const live = new Set([...this.#sessions.keys()].map(chatIdHash));
		const known = new Set(live);
		for (const row of this.#store?.all() ?? []) known.add(row.id_hash);
		return { live, known };
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

	/** The live record whose id hashes to `fp`, or null (none, or more than one). The id itself stays here. */
	recordByFingerprint(fp) {
		const matches = [...this.#sessions.values()].filter((r) => fingerprint(r.id) === fp);
		return matches.length === 1 ? matches[0] : null;
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

	/** The live records that use one profile: a key's main endpoint, or one agent (scope ids differ). */
	recordsByScope(scopeId) {
		return [...this.#sessions.values()].filter((r) => (r.scopeId ?? r.keyId ?? null) === (scopeId ?? null));
	}

	/** Stop every session of one scope, so it restarts on its current profile. They hibernate, as closeByKey's do. */
	closeByScope(scopeId) {
		const ids = this.recordsByScope(scopeId).map((r) => r.id);
		for (const id of ids) this.hibernate(id);
		return ids.length;
	}

	/** Every live record. */
	allRecords() {
		return [...this.#sessions.values()];
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

	/**
	 * What the clock does to chats. Stopping is not ending, and only a chat that will not come back is
	 * ended:
	 *
	 *   - a running agent idle for SESSION_IDLE_MS, or running for SESSION_MAX_LIFETIME_MS, is
	 *     **stopped**: its Pi exits and its container stops, freeing the memory, but the container, the
	 *     Pi session and the chat's row stay, so the next message resumes it with what was installed;
	 *   - a one-off request (used once and then quiet) is **ended**: nothing will ask for it again;
	 *   - a stopped chat is **ended** only when unused for CHAT_KEEP_MS (0 keeps it forever).
	 *
	 * The running time is counted from when this Pi started, not from when the chat began. A chat
	 * resumed after a month would otherwise be past its lifetime the moment it woke, and be stopped
	 * again on the next tick, for ever. A session with work pending is never touched.
	 */
	reap(now = Date.now()) {
		this.#sample(now);
		const reaped = [];
		for (const record of this.#sessions.values()) {
			if (record.inflight > 0) continue;
			const pastLifetime = now - (record.startedAt ?? record.createdAt) > this.#maxLifetimeMs;
			const pastIdle = now - record.lastUsedAt > this.#idleMs;
			const orphaned = this.#oneShotMs > 0 && record.requests <= 1 && now - record.lastUsedAt > this.#oneShotMs;
			if (!pastLifetime && !pastIdle && !orphaned) continue;
			reaped.push(record.id);
			// Without a store there is nothing to resume from, and hibernate falls back to ending.
			if (orphaned) this.close(record.id);
			else this.hibernate(record.id);
		}
		// Stopped chats: ended after the keep window, or at once when they were one-off requests.
		const liveHashes = new Set([...this.#sessions.keys()].map(chatIdHash));
		for (const row of this.#store?.all() ?? []) {
			if (liveHashes.has(row.id_hash)) continue;
			const unused = now - row.last_used_at;
			const expired = this.#keepMs > 0 && unused > this.#keepMs;
			const orphaned = this.#oneShotMs > 0 && row.requests <= 1 && unused > this.#oneShotMs;
			if (!expired && !orphaned) continue;
			this.#store.delete(row.id_hash);
			Promise.resolve(this.#host.ended(row.id_hash)).catch(() => {});
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
				const lifetimeLeft = (record.startedAt ?? record.createdAt) + this.#maxLifetimeMs - now;
				const idleLeft = record.lastUsedAt + this.#idleMs - now;
				const orphanLeft = this.#oneShotMs > 0 && record.requests <= 1 ? record.lastUsedAt + this.#oneShotMs - now : Infinity;
				const soonest = Math.min(lifetimeLeft, idleLeft, orphanLeft);				return {
					fingerprint: fingerprint(record.id),
					// The container it runs in, for the Pi version the Live chats page shows.
					container: record.container?.name ?? null,
					provider: session?.model?.provider ?? null,
					model: session?.model?.id ?? null,
					ageMs: now - record.createdAt,
					idleMs: now - record.lastUsedAt,
					expiresInMs: Math.max(0, soonest),
					expiresBecause: expiryReason(lifetimeLeft, idleLeft, orphanLeft),
					// A one-off request ends; anything else only stops, and can be resumed.
					expiresAction: expiryReason(lifetimeLeft, idleLeft, orphanLeft) === "one-shot" ? "ends" : "stops",
					inflight: record.inflight,
					requests: record.requests,
					// Live spend for this session. Pi aggregates over compacted-away history too, so it is
					// what was actually billed so far, not an estimate.
					cost: Number(stats?.cost) || 0,
					tokens: stats?.tokens?.total ?? 0,
					// How fast its model calls have been (tokens per second): prompt processing and generation.
					speed: session?.getSpeed?.() ?? null,
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
			keepMs: this.#keepMs,
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
		const workspace = row ? row.workspace : this.#host.workspace(credential?.scopeId ?? credential?.id ?? null);
		const record = {
			id,
			workspace,
			// Which key opened this session, recorded once. A session continued by a different key
			// stays attributed to whoever created it.
			keyId: credential?.id ?? null,
			keyName: credential?.name ?? null,
			// Where this session's profile, workspace and container live: the key's own scope, or an agent's.
			scopeId: credential?.scopeId ?? credential?.id ?? null,
			agentId: credential?.agent?.id ?? null,
			// Hand-offs: how deep this chat is in a chain of agents calling agents, and who is above it.
			delegateDepth: credential?.delegateDepth ?? 0,
			delegateChain: credential?.delegateChain ?? [],
			sessionPromise: null,
			queue: Promise.resolve(),
			state: row ? JSON.parse(row.state_json) : { forwarded: 0, lastUserText: null },
			// Tells the runner to continue the Pi session kept in the chat's own folder rather than start one.
			resume: Boolean(row),
			inflight: 0,
			requests: row ? row.requests + 1 : 1,
			// Fallback bookkeeping: which model to go back to, and when we switched.
			primaryModel: null,
			fallbackActive: false,
			fallbackAt: null,
			createdAt: row ? row.created_at : now,
			// When this Pi started: the lifetime limit counts from here, and a resume starts it again.
			startedAt: now,
			lastUsedAt: now,
			// What the dashboard's live view shows: the recent events of this chat, in memory only.
			live: new LiveLog(),
		};
		if (row) record.keyId = row.key_id ?? record.keyId;
		record.sessionPromise = this.#create(workspace, record);
		// Kept on the record once it exists, so synchronous readers (spend limits) can see it.
		record.sessionPromise.then(
			(session) => {
				record.session = session;
				// Feed the live view; the subscription ends with the session.
				session.subscribe?.((event) => record.live.feed(event));
			},
			() => {},
		);
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

export { chatIdHash };

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

// Late-bound, so the container layer (which imports this module for spend limits) can load after it.
export const sessions = new SessionController({
	create: (workspace, record) => createContainerSession(workspace, record),
	maxSessions: config.MAX_SESSIONS,
	maxLifetimeMs: config.SESSION_MAX_LIFETIME_MS,
	idleMs: config.SESSION_IDLE_MS,
	oneShotMs: config.ONE_SHOT_TTL_MS,
	keepMs: config.CHAT_KEEP_MS,
	host: {
		workspace: (keyId) => containerHost.workspace(keyId),
		stopped: (idHash, record) => containerHost.stopped(idHash, record),
		ended: (idHash) => containerHost.ended(idHash),
	},
	store: chatStore,
});

/**
 * Reconcile containers, chat folders and archives with the chats this gateway knows. Started by the
 * server, never at import: it talks to Docker, and a test or a tool importing this module must not.
 */
let lastAuditPurge = 0;
export async function sweep() {
	const { live, known } = sessions.chatHashes();
	const found = await sweepContainers(known, live);
	if (found.stopped || found.removed || found.folders || found.expired) {
		process.stderr.write(`sweep: ${found.stopped} container(s) stopped, ${found.removed} removed, ${found.folders} folder(s) removed, ${found.expired} archive(s) expired\n`);
		audit("runtime.sweep", "sweep", `${found.stopped} container(s) stopped, ${found.removed} removed, ${found.folders} folder(s) removed, ${found.expired} archive(s) expired`, { actor: "system" });
	}
	// The audit log's own retention, at most hourly.
	if (Date.now() - lastAuditPurge > 60 * 60_000) {
		lastAuditPurge = Date.now();
		purgeAudit();
		purgeSpeed();
	}
	return found;
}

/** Sweep now, then every ten minutes. */
export function startSweeps() {
	const run = () => void sweep().catch((err) => process.stderr.write(`sweep failed: ${err?.message ?? err}\n`));
	setInterval(run, 10 * 60_000).unref();
	run();
}

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
			"INSERT INTO spend (fingerprint, provider, model, cost, input, output, cache_read, cache_write, requests, closed_at, key_id, agent_id) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const now = Date.now();
		const row = (provider, model, part, requests) =>
			insert.run(
				fingerprint(record.id), provider, model, Number(part.cost) || 0,
				part.tokens.input ?? 0, part.tokens.output ?? 0, part.tokens.cacheRead ?? 0, part.tokens.cacheWrite ?? 0,
				requests, now, record.keyId ?? null, record.agentId ?? null,
			);
		// One row per model the chat used, when it was metered that way (a container's
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
	// Per key and agent endpoint: a key's agents share its limits but not its bill.
	const byAgent = db
		.prepare(
			"SELECT key_id, agent_id, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens, " +
				"COUNT(*) AS sessions FROM spend GROUP BY key_id, agent_id ORDER BY cost DESC, sessions DESC",
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
		byAgent: byAgent.map((r) => ({
			keyId: r.key_id,
			agentId: r.agent_id,
			label: r.agent_id ? `${keyLabel(r.key_id)} / ${agents.get(r.agent_id)?.name ?? "(deleted agent)"}` : keyLabel(r.key_id),
			cost: Number(r.cost),
			tokens: Number(r.tokens),
			sessions: Number(r.sessions),
		})),
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
 * have run up so far. Figures for bridged models are the gateway's own metering; for direct ones they are the container's.
 */
export function spentToday(keyId) {
	const row = db
		.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM spend WHERE closed_at >= ? AND key_id IS ?")
		.get(startOfToday(), keyId ?? null);
	let live = 0;
	for (const record of sessions.recordsByKey(keyId)) live += Number(record.session?.getSessionStats?.().cost) || 0;
	return Number(row.cost) + live;
}

/** What one agent endpoint has spent today: closed sessions plus what its live sessions have run up so far. */
export function agentSpendToday(agentId) {
	const row = db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM spend WHERE closed_at >= ? AND agent_id = ?").get(startOfToday(), agentId);
	let live = 0;
	for (const record of sessions.allRecords()) if (record.agentId === agentId) live += Number(record.session?.getSessionStats?.().cost) || 0;
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
