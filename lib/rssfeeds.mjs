/**
 * RSS feeds: the first thing that feeds the knowledge base (lib/knowledge.mjs). Three things happen,
 * each on its own: polling a feed's own XML (the gateway fetches that itself — feed URLs are the
 * operator's own, the same trust level `ALERT_WEBHOOK_URL` already gets, not a client's), finding new
 * entries (by the feed's own guid), and extracting each new entry's full article, which is a whole
 * agent turn — the gateway never fetches an article page itself, only the agent does, inside its own
 * container, with whatever fetch tool it has.
 *
 * A feed's first poll ever seeds the knowledge base with its entries at that moment, marked 'skipped':
 * known, but never queued for extraction, so adding a feed never backfills a history you did not ask
 * for. From the next poll on, an entry not already known is queued ('pending'), and `pump()` extracts
 * up to `RSS_MAX_PARALLEL_EXTRACTIONS` at once — the same tick/pump split `lib/jobs.mjs` uses, for the
 * same reason: polling is cheap and can all happen on the tick; extraction is a whole agent turn and
 * needs a concurrency cap.
 */
import crypto from "node:crypto";
import { config, db } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { addEntry, getByKey, getEntry, removeEntry, sourceSeen } from "./knowledge.mjs";

export class RssError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "RssError";
		this.status = status;
	}
}

export const SOURCE_TYPE = "rss";
const TICK_MS = 15_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const FEED_FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------------------------
// Feeds: plain CRUD
// ---------------------------------------------------------------------------------------------

function validateFeedUrl(text) {
	const value = String(text ?? "").trim();
	if (!value) throw new RssError("give the feed a URL");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new RssError("that is not a URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new RssError("a feed URL must be http or https");
	return url.href;
}

function checkedInterval(ms) {
	const n = Number(ms);
	const floor = Number(config.RSS_POLL_MIN_INTERVAL_MS ?? 5 * 60_000);
	if (!Number.isFinite(n) || n < floor) throw new RssError(`the interval is at least ${Math.round(floor / 60_000)} minutes (RSS_POLL_MIN_INTERVAL_MS)`);
	return Math.round(n);
}

/** The most recently fetched (done/blocked) entry of a feed, for the dashboard's Feeds list — 'skipped'
 * (backfill) and 'pending'/'extracting' rows never set `fetched_at`, so they are never "the last one".
 * A merely 'failed' extraction is discarded entirely (see extractOne), so it never shows here either;
 * only a deliberate 'blocked' give-up persists as something worth seeing. */
const lastEntryRow = (feedId) => db.prepare("SELECT status, fetched_at, error FROM knowledge_entries WHERE source_type = ? AND source_ref = ? AND fetched_at IS NOT NULL ORDER BY fetched_at DESC LIMIT 1").get(SOURCE_TYPE, feedId);

const fromRow = (row) => {
	const last = lastEntryRow(row.id);
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		agentId: row.agent_id,
		intervalMs: Number(row.interval_ms),
		enabled: Boolean(row.enabled),
		nextPollAt: row.next_poll_at === null ? null : Number(row.next_poll_at),
		lastPolledAt: row.last_polled_at === null ? null : Number(row.last_polled_at),
		lastError: row.last_error,
		lastEntryStatus: last ? last.status : null,
		lastEntryAt: last ? Number(last.fetched_at) : null,
		lastEntryError: last ? last.error : null,
		createdAt: Number(row.created_at),
	};
};

export const getFeed = (id) => {
	const row = db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(String(id ?? ""));
	return row ? fromRow(row) : null;
};
export const listFeeds = () => db.prepare("SELECT * FROM rss_feeds ORDER BY created_at").all().map(fromRow);

export function createFeed({ name, url, agentId = null, intervalMs = 30 * 60_000 }) {
	const cap = Number(config.RSS_MAX_FEEDS ?? 100);
	if (listFeeds().length >= cap) throw new RssError(`there are already ${cap} feeds, the most allowed (RSS_MAX_FEEDS)`, 409);
	const href = validateFeedUrl(url);
	const interval = checkedInterval(intervalMs);
	if (agentId && !agents.get(agentId)) throw new RssError("no such agent", 404);
	const label = String(name ?? "").trim().slice(0, 100) || new URL(href).hostname;
	const id = `f${crypto.randomBytes(6).toString("hex")}`;
	const now = Date.now();
	db.prepare("INSERT INTO rss_feeds (id, name, url, agent_id, interval_ms, enabled, next_poll_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(id, label, href, agentId || null, interval, now, now);
	audit("rss.create", label, href);
	return getFeed(id);
}

export function updateFeed(id, { name, url, agentId, intervalMs, enabled } = {}) {
	const row = db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(String(id ?? ""));
	if (!row) throw new RssError("no such feed", 404);
	const next = {
		name: name === undefined ? row.name : String(name ?? "").trim().slice(0, 100) || row.name,
		url: url === undefined ? row.url : validateFeedUrl(url),
		agentId: agentId === undefined ? row.agent_id : agentId || null,
		intervalMs: intervalMs === undefined ? row.interval_ms : checkedInterval(intervalMs),
		enabled: enabled === undefined ? Boolean(row.enabled) : Boolean(enabled),
	};
	if (next.agentId && !agents.get(next.agentId)) throw new RssError("no such agent", 404);
	db.prepare("UPDATE rss_feeds SET name = ?, url = ?, agent_id = ?, interval_ms = ?, enabled = ? WHERE id = ?").run(next.name, next.url, next.agentId, next.intervalMs, next.enabled ? 1 : 0, id);
	audit("rss.update", next.name, next.enabled ? "on" : "off");
	return getFeed(id);
}

export function removeFeed(id) {
	const row = db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(String(id ?? ""));
	if (!row) return false;
	db.prepare("DELETE FROM rss_feeds WHERE id = ?").run(id);
	audit("rss.delete", row.name, "");
	return true;
}

// ---------------------------------------------------------------------------------------------
// A tiny, deliberately small RSS 2.0 / Atom parser. This gateway has no runtime dependencies and
// nothing else here needs real XML, so this is regex, not a parser: good enough for well-formed
// feeds (every mainstream one is), not a defence against a hostile one.
// ---------------------------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text) {
	return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
		if (body[0] === "#") {
			const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[body.toLowerCase()] ?? whole;
	});
}

function unwrapCdata(text) {
	const m = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(text);
	return m ? m[1] : text;
}

function tagText(block, name) {
	const m = new RegExp(`<${name}(?:[^>]*)>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
	return m ? decodeEntities(unwrapCdata(m[1]).trim()) || null : null;
}

function tagAttr(block, name, attr) {
	const m = new RegExp(`<${name}\\b[^>]*\\b${attr}=["']([^"']*)["'][^>]*\\/?>`, "i").exec(block);
	return m ? decodeEntities(m[1]).trim() || null : null;
}

function parseFeedDate(text) {
	if (!text) return null;
	const t = Date.parse(text);
	return Number.isFinite(t) ? t : null;
}

/** Entries from RSS 2.0 (`<item>`) or Atom (`<entry>`) XML: `[{guid, url, title, publishedAt}]`. */
export function parseFeedXml(xml) {
	const text = String(xml ?? "");
	let blocks = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
	let atom = false;
	if (!blocks.length) {
		blocks = [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
		atom = true;
	}
	return blocks
		.map((block) => {
			const title = tagText(block, "title") || "(untitled)";
			const url = atom ? tagAttr(block, "link", "href") || tagText(block, "link") : tagText(block, "link");
			const guid = tagText(block, "guid") || tagText(block, "id") || url;
			const publishedAt = parseFeedDate(tagText(block, "pubDate") || tagText(block, "published") || tagText(block, "updated"));
			return guid && url ? { guid, url, title, publishedAt } : null;
		})
		.filter(Boolean);
}

async function fetchFeedXml(url, { fetchFn = fetch, maxBytes = MAX_FEED_BYTES, timeoutMs = FEED_FETCH_TIMEOUT_MS } = {}) {
	const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "Piper/1 (+https://github.com/ALange/Piper)" } });
	if (!res.ok) throw new Error(`the feed answered HTTP ${res.status}`);
	const buffer = Buffer.from(await res.arrayBuffer());
	if (buffer.byteLength > maxBytes) throw new Error(`the feed is over the ${maxBytes}-byte limit`);
	return buffer.toString("utf8");
}

// ---------------------------------------------------------------------------------------------
// Polling: finds new entries. Extraction (the agent turn) is separate — see pump().
// ---------------------------------------------------------------------------------------------

async function pollOne(row, { fetchFn } = {}) {
	const seenBefore = sourceSeen(SOURCE_TYPE, row.id);
	let entries;
	try {
		entries = parseFeedXml(await fetchFeedXml(row.url, { fetchFn }));
	} catch (err) {
		db.prepare("UPDATE rss_feeds SET last_error = ?, last_polled_at = ? WHERE id = ?").run(`could not fetch or read the feed: ${String(err?.message ?? err).slice(0, 300)}`, Date.now(), row.id);
		return 0;
	}
	let added = 0;
	for (const entry of entries) {
		if (getByKey(SOURCE_TYPE, row.id, entry.guid)) continue;
		addEntry({ sourceType: SOURCE_TYPE, sourceRef: row.id, guid: entry.guid, url: entry.url, title: entry.title, publishedAt: entry.publishedAt, status: seenBefore ? "pending" : "skipped" });
		added++;
	}
	db.prepare("UPDATE rss_feeds SET last_error = NULL, last_polled_at = ? WHERE id = ?").run(Date.now(), row.id);
	if (added) setImmediate(pump);
	return added;
}

/** Poll one feed right now, ignoring its schedule (the dashboard's "pull now"). */
export async function forcePoll(id, options = {}) {
	const row = db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(String(id ?? ""));
	if (!row) throw new RssError("no such feed", 404);
	await pollOne(row, options);
	return getFeed(id);
}

/** Queue what is due. Extraction is queued separately by pollOne/pump, not here. */
export function tick(now = Date.now(), options = {}) {
	if (!config.RSS_ENABLED) return 0;
	let queued = 0;
	for (const row of db.prepare("SELECT * FROM rss_feeds WHERE enabled = 1 AND next_poll_at IS NOT NULL AND next_poll_at <= ?").all(now)) {
		const floor = Number(config.RSS_POLL_MIN_INTERVAL_MS ?? 5 * 60_000);
		db.prepare("UPDATE rss_feeds SET next_poll_at = ? WHERE id = ?").run(now + Math.max(Number(row.interval_ms), floor), row.id);
		void pollOne(row, options);
		queued++;
	}
	return queued;
}

// ---------------------------------------------------------------------------------------------
// Extraction: one whole agent turn per new entry.
// ---------------------------------------------------------------------------------------------

const PROMPT = (url, hint) =>
	`Fetch this article and extract it clean: no ads, navigation, related-articles or sponsored sections, just the piece itself.\n\n${url}\n\n` +
	`${hint ? `The feed calls it: "${hint}"\n\n` : ""}Reply with exactly one JSON object and nothing else — no markdown fence, no words before or after it:\n` +
	`{"title": "...", "text": "...", "summary": "a two or three sentence summary", "tags": ["...", "..."]}`;

/** The agent's reply, strictly: one JSON object with a title and text. Throws a plain, readable reason otherwise. */
export function parseExtraction(reply) {
	const stripped = String(reply ?? "")
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	let data;
	try {
		data = JSON.parse(stripped);
	} catch {
		throw new Error("the agent's reply was not JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the agent's reply was not a JSON object");
	const title = typeof data.title === "string" ? data.title.trim() : "";
	const text = typeof data.text === "string" ? data.text.trim() : "";
	const summary = typeof data.summary === "string" ? data.summary.trim() : "";
	const tags = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : [];
	if (!title || !text) throw new Error("the agent's reply has no title or text");
	return { title, text, summary, tags };
}

// A reply that failed to parse as the extraction JSON, but reads like the *site* refused the fetch
// (Cloudflare, a 403, a CAPTCHA) rather than the agent or the model doing something wrong. Heuristic,
// on purpose: it only decides whether to spend one more turn trying, never whether the entry is kept.
const BLOCK_SIGNS = /\b(403|forbidden|cloudflare|captcha|access denied|bot protection|blocked|verify you.{0,20}human|are you a robot|too many requests|429)\b/i;
export const looksBlocked = (text) => BLOCK_SIGNS.test(String(text ?? ""));

const UNBLOCK_PROMPT = (url) =>
	`That reply could not be used, and it looks like the site may be blocking automated requests (a 403, Cloudflare, a CAPTCHA or similar) rather than a ` +
	`tool problem. Before giving up, try another way to get the same article's clean text with whatever tools you have — the Wayback Machine ` +
	`(https://web.archive.org/web/2024/${url}), a cache, or a search for the same headline reported elsewhere. If one of those works, reply with the same ` +
	`JSON object as before. If nothing works, reply with exactly one JSON object and nothing else: {"blocked": true, "reason": "a short, specific reason"}.`;

/** The retry's reply: either the normal extraction, or an explicit give-up. Never throws — by this point
 * something is wrong either way, and the caller only needs a reason to show. */
export function parseUnblockReply(reply) {
	try {
		return { extracted: parseExtraction(reply) };
	} catch {
		const stripped = String(reply ?? "")
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/```\s*$/, "")
			.trim();
		try {
			const data = JSON.parse(stripped);
			if (data && typeof data === "object" && data.blocked) return { reason: (typeof data.reason === "string" && data.reason.trim()) || "the agent could not get past the block" };
		} catch {
			/* falls through to the raw reply below */
		}
		return { reason: String(reply ?? "").trim().slice(0, 600) || "the agent could not get past the block" };
	}
}

let runTurn = runAgentTurn;
/** Replace what runs an extraction turn (tests); no argument restores the real one. */
export const setExtractionRunner = (fn) => void (runTurn = fn ?? runAgentTurn);

const controllers = new Map();

async function extractOne(row, controller) {
	const feed = getFeed(row.source_ref);
	const timeoutMs = Number(config.RSS_EXTRACT_TIMEOUT_MS ?? 5 * 60_000);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timer.unref?.();
	let outcome;
	let lastReply = null;
	try {
		if (!feed) throw new Error("its feed was deleted");
		const agentId = feed.agentId || String(config.RSS_DEFAULT_AGENT ?? "").trim() || null;
		if (!agentId) throw new Error(`"${feed.name}" has no extracting agent, and RSS_DEFAULT_AGENT is not set`);
		const agent = agents.get(agentId);
		if (!agent) throw new Error(`"${feed.name}"'s extracting agent no longer exists`);
		const credential = credentialFor(agent.keyId, agent.id);
		const session = `rss:${row.id}`;
		const first = await runTurn({ credential, clientSessionId: session, prompt: PROMPT(row.url, row.title), signal: controller.signal });
		lastReply = first.text;
		let extracted;
		try {
			extracted = parseExtraction(first.text);
		} catch (parseErr) {
			if (config.RSS_AUTO_UNBLOCK && looksBlocked(first.text)) {
				const retry = await runTurn({ credential, clientSessionId: session, prompt: UNBLOCK_PROMPT(row.url), signal: controller.signal });
				lastReply = retry.text;
				const unblocked = parseUnblockReply(retry.text);
				if (unblocked.extracted) extracted = unblocked.extracted;
				else outcome = { status: "blocked", title: null, text: null, summary: null, tags: null, error: unblocked.reason.slice(0, 1000) };
			} else {
				throw parseErr;
			}
		}
		if (!outcome && extracted) {
			const cap = Number(config.RSS_MAX_ARTICLE_BYTES ?? 50_000);
			outcome = {
				status: "done",
				title: extracted.title,
				text: extracted.text.length > cap ? `${extracted.text.slice(0, cap)}\n… (cut at ${cap} characters)` : extracted.text,
				summary: extracted.summary || null,
				tags: extracted.tags,
				error: null,
			};
		}
	} catch (err) {
		let why = timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s, so the turn was stopped` : err instanceof AgentRunError ? err.message : String(err?.message ?? err);
		// The agent answered, just not with the JSON asked for: keep what it said, so a retry has something to go on.
		if (!timedOut && lastReply && !(err instanceof AgentRunError)) why += ` — the agent said: ${lastReply.trim().slice(0, 600)}`;
		outcome = { status: "failed", title: null, text: null, summary: null, tags: null, error: why.slice(0, 1000) };
	} finally {
		clearTimeout(timer);
	}
	if (outcome.status === "failed") {
		// Not kept as a dead end: discarded entirely, so the next time this feed is polled, the same
		// guid looks new again and gets a fresh attempt on its own next turn -- no permanent "failed"
		// entry sitting in the knowledge base waiting for someone to notice and click retry, and no
		// risk of hammering a persistently broken article immediately (pump()'s own self-chaining only
		// ever sees rows still in the table; this one is gone until polling finds it "new" again).
		// "blocked" is different on purpose: that is the agent's own considered answer, after already
		// trying a second time, that retrying again would not help — worth keeping and surfacing.
		removeEntry(row.id);
	} else {
		addEntry({
			sourceType: SOURCE_TYPE,
			sourceRef: row.source_ref,
			guid: row.guid,
			url: row.url,
			publishedAt: row.published_at === null ? null : Number(row.published_at),
			title: outcome.title ?? row.title,
			text: outcome.text,
			summary: outcome.summary,
			tags: outcome.tags,
			status: outcome.status,
			error: outcome.error,
		});
	}
	audit("rss.extract", feed?.name ?? row.source_ref ?? "?", `${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`, { actor: "system" });
}

/** Start extracting queued ('pending') entries, up to RSS_MAX_PARALLEL_EXTRACTIONS at once. */
let pumping = false;
export function pump() {
	if (pumping) return;
	pumping = true;
	try {
		const max = Number(config.RSS_MAX_PARALLEL_EXTRACTIONS ?? 2);
		while (controllers.size < max) {
			const row = db.prepare("SELECT * FROM knowledge_entries WHERE source_type = ? AND status = 'pending' ORDER BY id LIMIT 1").get(SOURCE_TYPE);
			if (!row) break;
			const claimed = db.prepare("UPDATE knowledge_entries SET status = 'extracting' WHERE id = ? AND status = 'pending'").run(row.id);
			if (!Number(claimed.changes)) continue;
			const controller = new AbortController();
			controllers.set(row.id, controller);
			void extractOne(row, controller).finally(() => {
				controllers.delete(row.id);
				setImmediate(pump);
			});
		}
	} finally {
		pumping = false;
	}
}

/** Queue a failed entry again (the dashboard's "retry"). */
export function retryEntry(id) {
	const entry = getEntry(id);
	if (!entry || entry.sourceType !== SOURCE_TYPE) throw new RssError("no such entry", 404);
	db.prepare("UPDATE knowledge_entries SET status = 'pending' WHERE id = ?").run(Number(id));
	setImmediate(pump);
	return true;
}

let timer = null;
/** Start polling and extracting. A run an earlier process left mid-extraction is requeued, not lost. */
export function startFeeds() {
	if (timer) return;
	const stale = db.prepare("UPDATE knowledge_entries SET status = 'pending' WHERE source_type = ? AND status = 'extracting'").run(SOURCE_TYPE);
	if (Number(stale.changes)) audit("runtime.rss", "feeds", `${stale.changes} extraction(s) were interrupted by a restart and requeued`, { actor: "system" });
	timer = setInterval(() => {
		try {
			tick();
			pump();
		} catch (err) {
			process.stderr.write(`rss: ${err?.message ?? err}\n`);
		}
	}, TICK_MS);
	timer.unref?.();
	setImmediate(pump);
}

export function stopFeeds() {
	clearInterval(timer);
	timer = null;
	for (const c of controllers.values()) c.abort();
}
