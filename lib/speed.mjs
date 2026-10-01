/**
 * How fast models answer: prompt processing speed and token generation speed, measured from the agent's own
 * event stream, per session and per model over time.
 *
 * One model call is timed from three moments: the assistant message starts (the prompt is sent), the first
 * token arrives, and the message ends. From those and the usage the provider reported:
 *
 *   prompt speed      = prompt tokens ÷ time to first token
 *   generation speed  = (output tokens − 1) ÷ time from the first token to the end
 *
 * Prompt tokens are the ones that had to be processed: input plus cache writes, not cache reads. Time to first
 * token also holds network and queueing time, so for a short prompt this reads low; calls with fewer than
 * MIN_PROMPT_TOKENS are not counted for it. A provider that does not stream sends everything at once, which
 * would make the prompt look slow and the generation look infinitely fast, so such a call is not counted at
 * all. Averages are token totals over time totals, not averages of per-call ratios, so a long call weighs more
 * than a short one.
 *
 * Nothing about the conversation is kept: per call only model, token counts and times. History is kept in
 * one-minute rows per model in the database for SPEED_HISTORY_DAYS (0 keeps none; live per-session figures
 * still work).
 */
import { config, db } from "./settings.mjs";

export const MIN_PROMPT_TOKENS = 64;
export const MIN_PROMPT_MS = 50;
export const MIN_OUTPUT_TOKENS = 8;
export const MIN_GEN_MS = 100;
/** Fewer output tokens than this in a single burst is just a short answer, not a provider that does not stream. */
const NON_STREAMING_TOKENS = 16;

db.exec(
	"CREATE TABLE IF NOT EXISTS speed_minutes (minute INTEGER NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, " +
		"prompt_tokens INTEGER NOT NULL DEFAULT 0, prompt_ms REAL NOT NULL DEFAULT 0, prompt_calls INTEGER NOT NULL DEFAULT 0, " +
		"gen_tokens INTEGER NOT NULL DEFAULT 0, gen_ms REAL NOT NULL DEFAULT 0, gen_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (minute, model))",
);

/**
 * What one finished call tells about speed. `usage` is the provider's report ({input, output, cacheRead,
 * cacheWrite}); `startMs`, `firstMs` and `endMs` are times on one clock. Returns
 * `{prompt: {tokens, ms} | null, gen: {tokens, ms} | null}`, or null when the call says nothing reliable.
 */
export function callSpeed({ startMs, firstMs, endMs, usage }) {
	if (!usage || firstMs == null || startMs == null || endMs == null) return null;
	const output = Number(usage.output) || 0;
	const prompt = (Number(usage.input) || 0) + (Number(usage.cacheWrite) || 0);
	const ttft = firstMs - startMs;
	const genMs = endMs - firstMs;
	if (ttft < 0 || genMs < 0) return null;
	// Everything in one burst: the provider did not stream, so neither figure means anything.
	if (output > NON_STREAMING_TOKENS && genMs < MIN_GEN_MS) return null;
	const result = { prompt: null, gen: null };
	if (prompt >= MIN_PROMPT_TOKENS && ttft >= MIN_PROMPT_MS) result.prompt = { tokens: prompt, ms: ttft };
	if (output >= MIN_OUTPUT_TOKENS && genMs >= MIN_GEN_MS) result.gen = { tokens: output - 1, ms: genMs };
	return result.prompt || result.gen ? result : null;
}

const rate = (part) => (part && part.ms > 0 ? (part.tokens * 1000) / part.ms : null);

/** A running total of speed samples: add them, read the weighted average and the last call. */
export function newSpeedStats() {
	return { calls: 0, prompt: { tokens: 0, ms: 0, calls: 0 }, gen: { tokens: 0, ms: 0, calls: 0 }, last: null, byModel: {} };
}

export function addSpeed(stats, sample, model = null) {
	const add = (into) => {
		into.calls += 1;
		if (sample.prompt) {
			into.prompt.tokens += sample.prompt.tokens;
			into.prompt.ms += sample.prompt.ms;
			into.prompt.calls += 1;
		}
		if (sample.gen) {
			into.gen.tokens += sample.gen.tokens;
			into.gen.ms += sample.gen.ms;
			into.gen.calls += 1;
		}
	};
	add(stats);
	stats.last = { model, prompt: rate(sample.prompt), gen: rate(sample.gen), at: Date.now() };
	if (model) add((stats.byModel[model] ??= { calls: 0, prompt: { tokens: 0, ms: 0, calls: 0 }, gen: { tokens: 0, ms: 0, calls: 0 } }));
}

/** The figures a table shows for one running total: {calls, prompt, gen, last} with rates in tokens per second. */
export function speedView(stats) {
	return {
		calls: stats.calls,
		prompt: rate(stats.prompt),
		gen: rate(stats.gen),
		promptCalls: stats.prompt.calls,
		genCalls: stats.gen.calls,
		last: stats.last ? { model: stats.last.model, prompt: stats.last.prompt, gen: stats.last.gen } : null,
		byModel: Object.fromEntries(Object.entries(stats.byModel).map(([m, s]) => [m, { calls: s.calls, prompt: rate(s.prompt), gen: rate(s.gen) }])),
	};
}

// ---------------------------------------------------------------------------------------------
// History: one-minute rows per model
// ---------------------------------------------------------------------------------------------

const upsert = db.prepare(
	"INSERT INTO speed_minutes (minute, model, calls, prompt_tokens, prompt_ms, prompt_calls, gen_tokens, gen_ms, gen_calls) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?) " +
		"ON CONFLICT(minute, model) DO UPDATE SET calls = calls + 1, prompt_tokens = prompt_tokens + excluded.prompt_tokens, prompt_ms = prompt_ms + excluded.prompt_ms, " +
		"prompt_calls = prompt_calls + excluded.prompt_calls, gen_tokens = gen_tokens + excluded.gen_tokens, gen_ms = gen_ms + excluded.gen_ms, gen_calls = gen_calls + excluded.gen_calls",
);

/** Keep one call's speed in the history. Does nothing when SPEED_HISTORY_DAYS is 0. Never throws. */
export function recordSpeed(model, sample, now = Date.now()) {
	if (!model || !sample || !(Number(config.SPEED_HISTORY_DAYS ?? 14) > 0)) return false;
	try {
		upsert.run(Math.floor(now / 60_000), String(model).slice(0, 200), sample.prompt?.tokens ?? 0, sample.prompt?.ms ?? 0, sample.prompt ? 1 : 0, sample.gen?.tokens ?? 0, sample.gen?.ms ?? 0, sample.gen ? 1 : 0);
		return true;
	} catch {
		return false;
	}
}

/** Ranges the page offers, and the width of one point on the chart for each. */
export const SPEED_RANGES = { "1h": { ms: 3_600_000, bucket: 60_000 }, "6h": { ms: 6 * 3_600_000, bucket: 5 * 60_000 }, "24h": { ms: 24 * 3_600_000, bucket: 15 * 60_000 }, "7d": { ms: 7 * 86_400_000, bucket: 3_600_000 } };

/**
 * Per-model speed over a range: totals and a series of points, one per bucket that had calls, so a gap in the
 * chart is a gap in use. `now` is a parameter for the tests.
 */
export function speedHistory(range = "1h", now = Date.now()) {
	const spec = SPEED_RANGES[range] ?? SPEED_RANGES["1h"];
	const since = Math.floor((now - spec.ms) / 60_000);
	const rows = db.prepare("SELECT * FROM speed_minutes WHERE minute >= ? ORDER BY minute").all(since);
	const models = new Map();
	const bucketMinutes = spec.bucket / 60_000;
	for (const r of rows) {
		const m = models.get(r.model) ?? { model: r.model, total: { calls: 0, prompt: { tokens: 0, ms: 0 }, gen: { tokens: 0, ms: 0 } }, buckets: new Map() };
		models.set(r.model, m);
		m.total.calls += r.calls;
		m.total.prompt.tokens += r.prompt_tokens;
		m.total.prompt.ms += r.prompt_ms;
		m.total.gen.tokens += r.gen_tokens;
		m.total.gen.ms += r.gen_ms;
		const key = Math.floor(r.minute / bucketMinutes) * bucketMinutes;
		const b = m.buckets.get(key) ?? { t: key * 60_000, calls: 0, prompt: { tokens: 0, ms: 0 }, gen: { tokens: 0, ms: 0 } };
		m.buckets.set(key, b);
		b.calls += r.calls;
		b.prompt.tokens += r.prompt_tokens;
		b.prompt.ms += r.prompt_ms;
		b.gen.tokens += r.gen_tokens;
		b.gen.ms += r.gen_ms;
	}
	return {
		range: SPEED_RANGES[range] ? range : "1h",
		since: since * 60_000,
		until: now,
		bucketMs: spec.bucket,
		models: [...models.values()]
			.map((m) => ({
				model: m.model,
				provider: m.model.includes("/") ? m.model.split("/")[0] : null,
				calls: m.total.calls,
				prompt: rate(m.total.prompt),
				gen: rate(m.total.gen),
				points: [...m.buckets.values()].map((b) => ({ t: b.t, calls: b.calls, prompt: rate(b.prompt), gen: rate(b.gen) })),
			}))
			.sort((a, b) => b.calls - a.calls),
	};
}

/** Delete history older than SPEED_HISTORY_DAYS (all of it when that is 0). Returns the rows removed. */
export function purgeSpeed(now = Date.now()) {
	const days = Number(config.SPEED_HISTORY_DAYS ?? 14);
	try {
		const cutoff = days > 0 ? Math.floor((now - days * 86_400_000) / 60_000) : Infinity;
		return Number(db.prepare("DELETE FROM speed_minutes WHERE minute < ?").run(Number.isFinite(cutoff) ? cutoff : Number.MAX_SAFE_INTEGER).changes);
	} catch {
		return 0;
	}
}
