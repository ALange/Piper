import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, statSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// server.mjs opens the settings database AND sweeps the workspace directory at module scope, so
// both must be pointed at scratch paths before importing — otherwise running the tests rewrites
// the real gateway.db and archives or deletes the real sessions' workspaces. A static import is
// hoisted above these assignments, so the import has to be dynamic. WORKSPACE_ROOT is seeded from
// the environment on first run, which is what makes the override take effect.
const TEST_DB = `${tmpdir()}/piper-test-${process.pid}.db`;
const TEST_WS = `${tmpdir()}/piper-test-ws-${process.pid}`;
process.env.GATEWAY_DB = TEST_DB;
process.env.WORKSPACE_ROOT = TEST_WS;
// The sandbox builder creates the profile root it masks, so it has to be a scratch path too.
const TEST_PROFILES = `${tmpdir()}/piper-test-profiles-${process.pid}`;
process.env.PROFILE_ROOT = TEST_PROFILES;
const TEST_SHARED = `${tmpdir()}/piper-test-shared-${process.pid}`;
const TEST_FILES = `${tmpdir()}/piper-test-files-${process.pid}`;
process.env.KEY_FILES_ROOT = TEST_FILES;
process.env.SHARED_ROOT = TEST_SHARED;
// Extras for the sandbox: only /usr/share/doc should survive. /root contains the Pi credentials,
// /etc/shadow is a secret, and /etc as a whole contains it.
// The Pi agent directory is refused as a whole, but its bin/ (Pi's own fd and rg) is the one exception.
const PI_AGENT = process.env.PI_CODING_AGENT_DIR || `${homedir()}/.pi/agent`;
process.env.SANDBOX_ALLOW = `/root:/etc/shadow:/etc:/usr/share/doc:/does/not/exist:${PI_AGENT}:${PI_AGENT}/bin`;
// Seeded at startup, which is when a validator that reads a not-yet-defined constant would fail.
process.env.SANDBOX_ENV = "TOOL_HOME=/opt/tool";
const { agentDirPath, classifyModelError, coerceSetting, derivedSessionId, expiryReason, fingerprint, formatDuration, framedTranscript, isInside, isReloadCommand, messageAudioParts, messageImageSources, messageText, nextTurn, parseDuration, pathVerdict, realPathFor, requestedSessionId, resolveImages, resolveModelQuery, sandboxCommand, SessionController, shQuote, shouldFallBack, WorkspaceManager, recordSpend, spendReport, spendTotals, hashPassword, verifyPassword, dashboardAuthorized, isDashboardPath, loadDashboardPassword, apiKeys, ApiKeyStore, expiryFromInput, keyLabel, apiKeyUsage, isSettingsKey, runtimeRoot, sandboxBindBack, jailedRoots, resolveTarget, sandboxCommand: buildSandbox, SENSITIVE_SYSTEM_PATHS, SANDBOX_ETC, allowedExtraPaths, readableRoots, scopedSessionId, isBlockedAddress, rootRefusal, profileScope, ensureProfile, bridgeCatalog, wireEvent, newMeter, meterUsage, runnerInvocation, PiRpcSession, startBridge, sandboxArgs, parseGatewayCommand, profileStats, profileHelperInvocation, profileWritability, setProfileLock, isProfileLocked, keyIdForScope, limitProperties, scopePrefix, keyLimits, limitFromInput, spentToday, spendRefusal, sweepSockets, bundleListFromInput, listBundles, grantedBundles, bundleContents, parseSandboxEnv, originOf, profileDetail, ensureKeyFiles, keyFilesWritability, keyFilesStats, treeSize, hostDefaultModel, chatIdHash, catalogueStamp, toolActivity, modelAllowed, allowedModelsFor, parseModelPatterns, cachedTreeSize, invalidateSize, SETTINGS_SPEC } = await import("./server.mjs");
const { inventory } = await import("./piper-profile.mjs");

/** The gateway's whole source, entry point and modules, for the tests that check its shape. */
function gatewaySource() {
	const lib = new URL("./lib/", import.meta.url);
	const files = existsSync(lib) ? readdirSync(lib).filter((f) => f.endsWith(".mjs")).sort().map((f) => new URL(f, lib)) : [];
	return [new URL("./server.mjs", import.meta.url), ...files].map((u) => readFileSync(u, "utf8")).join("\n");
}

/** The gateway's own directory, which the sandbox has to hide. */
const GATEWAY_DIR = dirname(fileURLToPath(import.meta.url));

const state = () => ({ forwarded: 0, lastUserText: null });
const s = (text) => ({ role: "system", content: text });
const u = (text) => ({ role: "user", content: text });
const a = (text) => ({ role: "assistant", content: text });
const uImg = (text, url) => ({ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url } }] });
const PNG = "data:image/png;base64,QUJD";

// Cumulative client: full history resent, only the new user turn is forwarded.
{
	const st = state();
	assert.equal(nextTurn([s("be terse"), u("one")], st).text, "one");
	assert.equal(nextTurn([s("be terse"), u("one"), a("1"), u("two")], st).text, "two");
	assert.equal(st.forwarded, 4);
	// Resending the same history is a no-op, not a duplicate turn.
	assert.equal(nextTurn([s("be terse"), u("one"), a("1"), u("two")], st).text, "");
}

// Regression: a client replaying its transcript at a brand-new agent must only be asked the
// newest question. When no session id is echoed every request mints a new agent, so joining the
// whole backlog into one prompt made the model re-answer earlier questions on every turn.
{
	const st = { forwarded: 0, lastUserText: null };
	const r = nextTurn([u("first question"), a("first answer"), u("second question")], st);
	assert.equal(r.text, "second question", "a fresh agent must only get the newest question");
	assert.equal(st.forwarded, 3);

	// Several unresolved user turns on the first request is still just the latest question.
	assert.equal(nextTurn([u("one"), u("two")], { forwarded: 0, lastUserText: null }).text, "two");

	// A session that already has history keeps the old behaviour and forwards only what is new.
	const live = state();
	nextTurn([u("one")], live);
	assert.equal(nextTurn([u("one"), a("1"), u("two")], live).text, "two");
}

// Non-cumulative client: only the latest turn is sent each time.
{
	const st = state();
	assert.equal(nextTurn([u("one")], st).text, "one");
	assert.equal(nextTurn([u("two")], st).text, "two");
	assert.equal(nextTurn([u("two")], st).text, "");
}

// Images ride only on forwarded turns; history is never re-uploaded.
{
	const st = state();
	const first = [uImg("what is this", PNG)];
	const r1 = nextTurn(first, st);
	assert.equal(r1.text, "what is this");
	assert.deepEqual(r1.images, [PNG]);

	const r2 = nextTurn([...first, a("a cat"), u("thanks")], st);
	assert.equal(r2.text, "thanks");
	assert.deepEqual(r2.images, []);
}

// An image-only turn still runs (empty text, one attachment).
{
	const r = nextTurn([{ role: "user", content: [{ type: "image_url", image_url: { url: PNG } }] }], state());
	assert.equal(r.text, "");
	assert.deepEqual(r.images, [PNG]);
}

// Incremental client sending just a fresh image turn.
{
	const st = state();
	assert.deepEqual(nextTurn([uImg("one", PNG)], st).images, [PNG]);
	assert.deepEqual(nextTurn([uImg("two", PNG)], st).images, [PNG]);
}

// Part shapes: chat `image_url` object, Responses `input_image` string.
assert.deepEqual(messageImageSources({ content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }), ["https://x/y.png"]);
assert.deepEqual(messageImageSources({ content: [{ type: "input_image", image_url: "https://x/y.png" }] }), ["https://x/y.png"]);
assert.deepEqual(messageImageSources({ content: "plain string" }), []);

// Multi-part text content is still extracted.
assert.equal(messageText({ content: [{ type: "text", text: "he" }, { type: "image_url", image_url: {} }, { type: "text", text: "llo" }] }), "hello");
assert.equal(nextTurn([u([{ type: "input_text", text: "hi" }])], state()).text, "hi");

// Assistant/system messages alone never produce a turn.
assert.equal(nextTurn([s("x"), a("y")], state()).text, "");
assert.equal(nextTurn([], state()).text, "");

// resolveImages: data URIs inline, unknown schemes rejected.
assert.deepEqual(await resolveImages([]), []);
assert.deepEqual(await resolveImages([PNG]), [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
assert.deepEqual(await resolveImages(["data:image/svg+xml,<svg/>"]), [{ type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" }]);
assert.deepEqual(await resolveImages(["data:;base64,QUJD"]), [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
await assert.rejects(resolveImages(["file:///etc/passwd"]), /Unsupported image URL/);
await assert.rejects(resolveImages(["data:image/png,%%%"]), /Malformed image data URI/);

// Audio parts are counted so the route can reject them (Pi has no audio input).
assert.equal(messageAudioParts({ content: [{ type: "input_audio", input_audio: { data: "x" } }] }), 1);
assert.equal(messageAudioParts({ content: [{ type: "text", text: "x" }, { type: "audio_url", audio_url: "y" }] }), 1);
assert.equal(messageAudioParts({ content: "plain" }), 0);
assert.equal(nextTurn([u("hi")], state()).audio, 0);
assert.equal(nextTurn([{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }], state()).audio, 1);

// Session id resolution: explicit signals only, never derived from message content.
{
	const req = (headers = {}) => ({ headers });
	assert.equal(requestedSessionId(req({ "x-session-id": "s1" }), {}), "s1");
	assert.equal(requestedSessionId(req({ "x-conversation-id": "c1" }), {}), "c1");
	assert.equal(requestedSessionId(req({ "x-session-id": "s1" }), { conversation_id: "c1" }), "s1");
	assert.equal(requestedSessionId(req(), { session_id: "s2" }), "s2");
	assert.equal(requestedSessionId(req(), { conversation_id: "s3" }), "s3");
	assert.equal(requestedSessionId(req(), {}), null);
	// Message content must never become a session key (that bug made every turn a new agent).
	assert.equal(requestedSessionId(req(), { messages: [{ role: "user", content: "hi" }] }), null);
	assert.equal(requestedSessionId(req(), { user: "alice" }), null);
}

// SessionController: mint, reuse, expire, evict.
{
	const settle = () => new Promise((r) => setTimeout(r, 0));
	const build = (opts = {}) => {
		const disposed = [];
		const ctl = new SessionController({
			create: async () => ({ dispose() { disposed.push(1); } }),
			maxSessions: 3,
			maxLifetimeMs: 1000,
			idleMs: 500,
			sweepMs: 0,
			...opts,
		});
		return { ctl, disposed };
	};

	// An id-less request mints a fresh session; two of them never collide.
	{
		const { ctl } = build();
		const one = ctl.acquire(null);
		const two = ctl.acquire(null);
		assert.notEqual(one.id, two.id, "id-less requests must not share an agent");
		assert.equal(one.isNew, true);
		assert.equal(ctl.size, 2);
	}

	// Same id reuses the record; a different id starts a separate session.
	{
		const { ctl } = build();
		const first = ctl.acquire("chat-1");
		assert.equal(ctl.acquire("chat-1").record, first.record);
		assert.equal(ctl.acquire("chat-1").isNew, false);
		assert.equal(ctl.acquire("chat-2").isNew, true);
		assert.equal(ctl.size, 2);
	}

	// Hard lifetime cap reaps even a just-used session.
	{
		const { ctl, disposed } = build({ idleMs: 60_000 });
		const rec = ctl.acquire("old").record;
		rec.lastUsedAt = rec.createdAt;
		assert.deepEqual(ctl.reap(rec.createdAt + 1001), ["old"]);
		await settle();
		assert.equal(ctl.size, 0);
		assert.equal(disposed.length, 1);
	}

	// Idle timeout reaps; inside both windows the session survives.
	{
		const { ctl } = build();
		const rec = ctl.acquire("idle").record;
		assert.deepEqual(ctl.reap(rec.createdAt + 400), []);
		assert.deepEqual(ctl.reap(rec.createdAt + 501), ["idle"]);
	}

	// A session with work pending is never reaped out from under it.
	{
		const { ctl, disposed } = build();
		const rec = ctl.acquire("busy").record;
		rec.inflight = 1;
		assert.deepEqual(ctl.reap(rec.createdAt + 10_000), []);
		assert.equal(ctl.size, 1);
		await settle();
		assert.equal(disposed.length, 0);
	}

	// At the cap the least-recently-used session is evicted.
	{
		const { ctl, disposed } = build();
		const a = ctl.acquire("a").record;
		const b = ctl.acquire("b").record;
		const c = ctl.acquire("c").record;
		a.lastUsedAt = 1000;
		b.lastUsedAt = 2000;
		c.lastUsedAt = 3000;
		ctl.acquire("d");
		await settle();
		assert.equal(ctl.size, 3);
		assert.equal(disposed.length, 1, "exactly one eviction at the cap");
	}

	// close() disposes the agent and reports whether the id existed (used to drop the
	// session behind a request that was rejected before it ever ran).
	{
		const { ctl, disposed } = build();
		ctl.acquire("doomed");
		assert.equal(ctl.close("doomed"), true);
		assert.equal(ctl.close("doomed"), false);
		await settle();
		assert.equal(disposed.length, 1);
		assert.equal(ctl.size, 0);
	}

	// closeByFingerprint is how the dashboard kills a row without ever seeing the real id.
	{
		const { ctl, disposed } = build();
		ctl.acquire("alpha");
		ctl.acquire("beta");
		assert.equal(ctl.closeByFingerprint(fingerprint("alpha")), true);
		assert.equal(ctl.size, 1);
		assert.equal(ctl.closeByFingerprint("deadbeef"), false, "unknown fingerprint must not close anything");
		assert.equal(ctl.closeByFingerprint(fingerprint("beta")), true);
		assert.equal(ctl.size, 0);
		await settle();
		assert.equal(disposed.length, 2);
	}

	// closeAll empties the registry.
	{
		const { ctl, disposed } = build();
		ctl.acquire("a");
		ctl.acquire("b");
		ctl.acquire("c");
		assert.equal(ctl.closeAll(), 3);
		assert.equal(ctl.size, 0);
		await settle();
		assert.equal(disposed.length, 3);
	}

	// One-shot pruning: a session used exactly once and then left quiet is an orphan.
	{
		const { ctl } = build({ oneShotMs: 200, idleMs: 60_000, maxLifetimeMs: 60_000 });
		const rec = ctl.acquire("orphan").record;
		assert.equal(rec.requests, 1);
		assert.deepEqual(ctl.reap(rec.lastUsedAt + 199), [], "inside the window it survives");
		assert.deepEqual(ctl.reap(rec.lastUsedAt + 201), ["orphan"]);
	}

	// A session that was actually continued is not a one-shot and must be spared.
	{
		const { ctl } = build({ oneShotMs: 200, idleMs: 60_000, maxLifetimeMs: 60_000 });
		ctl.acquire("chat");
		const rec = ctl.acquire("chat").record;
		assert.equal(rec.requests, 2);
		assert.deepEqual(ctl.reap(rec.lastUsedAt + 10_000), [], "a continued session outlives the one-shot window");
	}

	// The one-shot rule must still never touch a session with work in flight.
	{
		const { ctl } = build({ oneShotMs: 200, idleMs: 60_000, maxLifetimeMs: 60_000 });
		const rec = ctl.acquire("busy").record;
		rec.inflight = 1;
		assert.deepEqual(ctl.reap(rec.lastUsedAt + 10_000), []);
	}

	// Disabled when oneShotMs is 0: only idle and lifetime apply.
	{
		const { ctl } = build({ idleMs: 60_000, maxLifetimeMs: 60_000 });
		const rec = ctl.acquire("no-oneshot").record;
		assert.deepEqual(ctl.reap(rec.lastUsedAt + 10_000), []);
	}
}

// /reload is handled by the gateway; only the exact command matches, never intent.
assert.equal(isReloadCommand("/reload"), true);
assert.equal(isReloadCommand("  /reload  "), true);
assert.equal(isReloadCommand("please reload yourself"), false);
assert.equal(isReloadCommand("/reload now"), false);
assert.equal(isReloadCommand("/reloads"), false);
assert.equal(isReloadCommand(""), false);
assert.equal(isReloadCommand(undefined), false);

// Model resolution from the user's own wording. The catalog really does contain both
// deepseek-v4.1-flash and deepseek-v4-flash, so "4.1" must never match "v4".
{
	const catalog = [
		{ provider: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
		{ provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
		{ provider: "opencode-go", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
		{ provider: "deepseek", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
		{ provider: "github-copilot", id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
		{ provider: "github-copilot", id: "gpt-5.4", name: "GPT-5.4" },
		{ provider: "github-copilot", id: "gpt-5-mini", name: "GPT-5 mini" },
	];
	const id = (m) => (m ? `${m.provider}/${m.id}` : null);

	// The exact phrasing must pick 4.1 and honour the "from <provider>" hint.
	assert.equal(id(resolveModelQuery(catalog, "deepseek 4.1 flash from opencode-go").model), "opencode-go/deepseek-v4.1-flash");
	assert.equal(id(resolveModelQuery(catalog, "swap model to deepseek 4.1 flash from opencode-go").model), "opencode-go/deepseek-v4.1-flash");

	// A different id entirely still resolves.
	assert.equal(id(resolveModelQuery(catalog, "claude haiku 4.5 from github-copilot").model), "github-copilot/claude-haiku-4.5");

	// Ambiguous: two providers carry the same id, so it must refuse and list them.
	{
		const r = resolveModelQuery(catalog, "deepseek 4.1 flash");
		assert.equal(r.model, null);
		assert.equal(r.candidates.length, 2);
		assert.ok(r.candidates.includes("opencode-go/deepseek-v4.1-flash"));
		assert.ok(r.candidates.includes("deepseek/deepseek-v4.1-flash"));
	}

	// "4" alone is ambiguous between v4 and v4.1 rather than a silent wrong pick.
	assert.equal(resolveModelQuery(catalog, "deepseek 4 flash").model, null);

	// Unknown model changes nothing.
	{
		const r = resolveModelQuery(catalog, "gpt-9 turbo");
		assert.equal(r.model, null);
		assert.deepEqual(r.candidates, []);
	}

	// Regression: a nonsense name sharing ONE word with real models must not come back as a
	// candidate list. "gpt" alone matches gpt-5.4 and gpt-5-mini, which is not a suggestion.
	{
		const r = resolveModelQuery(catalog, "gpt-9-turbo-ultra");
		assert.equal(r.model, null);
		assert.deepEqual(r.candidates, [], "one matched word out of four must not yield candidates");
	}
	assert.equal(resolveModelQuery(catalog, "").model, null);
	// An exact id wins outright, even when a longer id shares all of its words.
	{
		const minis = [
			{ provider: "github-copilot", id: "gpt-5-mini", name: "GPT-5 mini" },
			{ provider: "github-copilot", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
		];
		assert.equal(id(resolveModelQuery(minis, "github-copilot/gpt-5-mini").model), "github-copilot/gpt-5-mini");
		assert.equal(id(resolveModelQuery(minis, "gpt-5-mini").model), "github-copilot/gpt-5-mini");
		assert.equal(id(resolveModelQuery(minis, "GPT-5.4-MINI").model), "github-copilot/gpt-5.4-mini");
	}
}

// Dashboard fingerprint: stable and distinguishing, but not the credential.
{
	assert.equal(fingerprint("alpha").length, 8);
	assert.match(fingerprint("alpha"), /^[0-9a-f]{8}$/);
	assert.equal(fingerprint("alpha"), fingerprint("alpha"));
	assert.notEqual(fingerprint("alpha"), fingerprint("beta"));
}

// Which limit fires first, as shown on the dashboard.
{
	assert.equal(expiryReason(1000, 500, 2000), "idle");
	assert.equal(expiryReason(1000, 2000, 500), "one-shot");
	assert.equal(expiryReason(500, 2000, 2000), "lifetime");
	assert.equal(expiryReason(1000, 2000, Infinity), "lifetime", "a session used more than once has no one-shot deadline");
}

// snapshot(): per-session rows, and the raw session id must never appear in the payload.
{
	const settle = () => new Promise((r) => setTimeout(r, 0));
	const ctl = new SessionController({
		create: async () => ({ dispose() {} }),
		maxSessions: 8,
		maxLifetimeMs: 3_600_000,
		idleMs: 1_800_000,
		sweepMs: 0,
	});
	ctl.acquire("alpha");
	ctl.acquire("beta");
	await settle();

	const snap = await ctl.snapshot();
	assert.equal(snap.count, 2);
	assert.equal(snap.sessions.length, 2);
	assert.ok(snap.sessions.every((s) => /^[0-9a-f]{8}$/.test(s.fingerprint)));
	assert.ok(snap.sessions.every((s) => s.expiresInMs > 0));
	// idle (30m) is the nearer of the two limits, so it is what would fire first
	assert.ok(snap.sessions.every((s) => s.expiresBecause === "idle"));
	assert.ok(snap.sessions.every((s) => s.provider === null && s.model === null));

	const blob = JSON.stringify(snap);
	assert.ok(!blob.includes("alpha") && !blob.includes("beta"), "raw session id leaked into the dashboard payload");
}

// Settings: durations are stored as milliseconds but written as "10m"/"24h" in the form.
{
	assert.equal(parseDuration("500ms"), 500);
	assert.equal(parseDuration("90s"), 90000);
	assert.equal(parseDuration("10m"), 600000);
	assert.equal(parseDuration("24h"), 86400000);
	assert.equal(parseDuration("2d"), 172800000);
	assert.equal(parseDuration("86400000"), 86400000);
	assert.equal(parseDuration("0"), 0);
	assert.throws(() => parseDuration("soon"), /not a duration/);
	assert.throws(() => parseDuration(""), /not a duration/);

	assert.equal(formatDuration(600000), "10m");
	assert.equal(formatDuration(86400000), "1d");
	assert.equal(formatDuration(90000), "1m 30s");
	assert.equal(formatDuration(0), "0");

	// Integers are range-checked, so a bad value never reaches the running config.
	const intSpec = { key: "MAX_SESSIONS", type: "int", min: 1, max: 100 };
	assert.equal(coerceSetting(intSpec, "42"), 42);
	assert.throws(() => coerceSetting(intSpec, "0"), /at least 1/);
	assert.throws(() => coerceSetting(intSpec, "101"), /at most 100/);
	assert.throws(() => coerceSetting(intSpec, "abc"), /whole number/);

	// Booleans accept the spellings an env var realistically carries.
	const boolSpec = { key: "ACCESS_LOG", type: "bool" };
	assert.equal(coerceSetting(boolSpec, "1"), true);
	assert.equal(coerceSetting(boolSpec, "true"), true);
	assert.equal(coerceSetting(boolSpec, "off"), false);
	assert.equal(coerceSetting(boolSpec, ""), false);
	assert.equal(coerceSetting(boolSpec, true), true);
	assert.throws(() => coerceSetting(boolSpec, "maybe"), /true or false/);

	const durSpec = { key: "SESSION_IDLE_MS", type: "duration", min: 1000 };
	assert.equal(coerceSetting(durSpec, "10m"), 600000);
	assert.throws(() => coerceSetting(durSpec, "0"), /at least 1000/);

	assert.equal(coerceSetting({ key: "HOST", type: "text" }, "0.0.0.0"), "0.0.0.0");
	assert.equal(coerceSetting({ key: "HOST", type: "text" }, undefined), "");
}

// Fallback trigger classification, mirroring Pi's own retryable vs fatal split.
{
	// Permanent for the account: the "credits finished" case Pi fails fast on.
	assert.equal(classifyModelError("GoUsageLimitError: monthly limit"), "quota");
	assert.equal(classifyModelError("Monthly usage limit reached"), "quota");
	assert.equal(classifyModelError("insufficient_quota"), "quota");
	assert.equal(classifyModelError("You exceeded your current quota"), "quota");

	// Transient: by the time we see these Pi has already exhausted its own retries.
	assert.equal(classifyModelError("upstream connect error"), "transient");
	assert.equal(classifyModelError("fetch failed"), "transient");
	assert.equal(classifyModelError("503 Service Unavailable"), "transient");
	assert.equal(classifyModelError("socket hang up"), "transient");
	assert.equal(classifyModelError("stream ended without message_stop"), "transient");
	assert.equal(classifyModelError("429 Too Many Requests"), "transient");

	// Deterministic request problems: a different model would fail the same way.
	assert.equal(classifyModelError("context length exceeded maximum"), "other");
	assert.equal(classifyModelError("invalid request: unknown field"), "other");
	assert.equal(classifyModelError(""), "none");
	assert.equal(classifyModelError(undefined), "none");

	assert.equal(shouldFallBack("insufficient_quota"), true);
	assert.equal(shouldFallBack("fetch failed"), true);
	assert.equal(shouldFallBack("invalid request: unknown field"), false);
	assert.equal(shouldFallBack(""), false);
}

// FALLBACK_MODE is a closed set, so a typo cannot silently disable the feature.
{
	const spec = { key: "FALLBACK_MODE", type: "enum", options: ["session", "request", "cooldown"] };
	assert.equal(coerceSetting(spec, "cooldown"), "cooldown");
	assert.equal(coerceSetting(spec, " session "), "session");
	assert.throws(() => coerceSetting(spec, "forever"), /must be one of/);
}

// A gateway-held session key, for clients that cannot echo a header.
{
	const req = (headers = {}, ip = "10.0.0.1") => ({ headers, socket: { remoteAddress: ip } });
	const conv = (first, ...rest) => ({ messages: [u(first), ...rest] });

	// Stable across turns, because the first user message is what the client replays.
	assert.equal(
		derivedSessionId(req(), conv("first question")),
		derivedSessionId(req(), conv("first question", a("answer"), u("second question"))),
	);

	// A new chat, a different client, user or address is a different session.
	assert.notEqual(derivedSessionId(req(), conv("first question")), derivedSessionId(req(), conv("other opener")));
	assert.notEqual(derivedSessionId(req(), conv("q")), derivedSessionId(req({ "user-agent": "other" }), conv("q")));
	assert.notEqual(derivedSessionId(req(), conv("q")), derivedSessionId(req({}, "10.0.0.2"), conv("q")));
	assert.notEqual(derivedSessionId(req(), conv("q")), derivedSessionId(req(), { messages: [u("q")], user: "alice" }));

	// Nothing to derive from without a user message.
	assert.equal(derivedSessionId(req(), { messages: [] }), null);
	assert.equal(derivedSessionId(req(), { messages: [a("hi")] }), null);
	assert.equal(derivedSessionId(req(), {}), null);
}

// Replaying a transcript at an agent that has no history.
{
	const framed = framedTranscript([u("what is 2+2"), a("4")]);
	assert.ok(framed.includes("user: what is 2+2"));
	assert.ok(framed.includes("assistant: 4"));
	assert.ok(framed.startsWith("[Earlier turns in this conversation"));
	assert.ok(framed.endsWith("[Now answer the latest message.]"));
	assert.equal(framedTranscript([]), "", "nothing to frame means no context message");

	const virgin = nextTurn([u("q1"), a("a1"), u("q2")], { forwarded: 0, lastUserText: null });
	assert.equal(virgin.text, "q2");
	assert.ok(virgin.context.includes("user: q1"), "an empty agent gets the replayed turns as context");

	const live = { forwarded: 0, lastUserText: null };
	nextTurn([u("q1")], live);
	assert.equal(nextTurn([u("q1"), a("a1"), u("q2")], live).context, "", "a session with history must not replay");
}

// The masked agent dir must be the one Pi actually uses, or provider credentials stay readable.
{
	const pkg = process.env.PI_AGENT_PACKAGE ?? "/root/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent";
	const { getAgentDir } = await import(pkg + "/dist/index.js");
	assert.equal(agentDirPath(), getAgentDir(), "the sandbox must mask the directory Pi reads credentials from");
}

// Path containment, and the symlink case that a string comparison would miss.
{
	assert.equal(isInside("/a/b", "/a/b"), true, "a directory contains itself");
	assert.equal(isInside("/a/b", "/a/b/c"), true);
	assert.equal(isInside("/a/b", "/a/bc"), false, "a shared prefix is not containment");
	assert.equal(isInside("/a/b", "/a"), false);
	assert.equal(isInside("/a/b", "/x"), false);
}

// The workspace jail: read and write are not the same permission.
{
	const base = mkdtempSync(join(tmpdir(), "pi-jail-"));
	const root = join(base, "workspaces");
	const workspace = join(root, "own");
	const sibling = join(root, "other");
	const secrets = join(base, "secrets");
	for (const dir of [workspace, sibling, secrets]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(workspace, "mine.txt"), "mine");
	writeFileSync(join(sibling, "secret.txt"), "another session");

	const deniedRoots = [root, `${root}-archive`, secrets];
	const verdict = (target, write = false) => pathVerdict(target, { workspace, deniedRoots, write });

	assert.equal(verdict(join(workspace, "mine.txt")), null, "own workspace is readable");
	assert.equal(verdict(join(workspace, "new.txt"), true), null, "own workspace is writable");

	assert.ok(verdict(join(sibling, "secret.txt")), "a sibling session must not be readable");
	assert.ok(verdict(join(sibling, "planted.txt"), true), "a sibling session must not be writable");
	assert.ok(verdict(join(secrets, "token")), "a masked root must not be readable");

	// Same reach as sandboxed bash: system files readable, nothing outside writable.
	assert.equal(verdict("/etc/hostname"), null, "system files stay readable");
	assert.ok(verdict("/etc/hostname", true), "writing a system file must be refused");
	assert.ok(verdict(join(base, "outside.txt"), true));

	// A symlink inside the workspace pointing out is not a way out.
	symlinkSync(sibling, join(workspace, "escape"));
	assert.ok(verdict(join(workspace, "escape", "secret.txt")), "reading through a symlink must be refused");
	assert.ok(verdict(join(workspace, "escape"), true), "writing through a symlink must be refused");
	assert.ok(realPathFor(join(workspace, "escape")).endsWith("other"), "realPathFor resolves the link");

	rmSync(base, { recursive: true, force: true });
}

// Shell quoting and the sandbox command's argument order.
{
	assert.equal(shQuote("plain"), "'plain'");
	assert.equal(shQuote("it's"), "'it'\\''s'");
	assert.equal(shQuote("a b"), "'a b'");

	const cmd = sandboxCommand("ls -la && echo done", { workspace: "/w/session" });
	assert.ok(cmd.startsWith(shQuote("/usr/bin/bwrap")));
	assert.ok(cmd.includes(shQuote("/w/session")));
	assert.ok(cmd.endsWith(shQuote("ls -la && echo done")), "the original command is one argument");
	assert.ok(cmd.includes("--unshare-pid"), "a fresh PID namespace is what hides the gateway's env");

	// Capabilities: as root, bwrap keeps every capability unless told otherwise, and with them a
	// session can `umount` the masks or remount / read-write. These flags are the whole fix.
	for (const flag of ["--unshare-user", "--cap-drop", "--new-session", "--unshare-ipc", "--unshare-uts"]) {
		assert.ok(cmd.includes(shQuote(flag)), `the sandbox must pass ${flag}`);
	}
	assert.ok(cmd.includes(`${shQuote("--cap-drop")} ${shQuote("ALL")}`), "every capability is dropped");
	assert.ok(cmd.includes(`${shQuote("--uid")} ${shQuote("65534")}`), "commands run as nobody");
	assert.ok(cmd.indexOf("--unshare-user") < cmd.indexOf("--ro-bind"), "namespace flags come before the mounts");

	// Network: off by default, and only the explicit "on" shares the host network.
	assert.ok(sandboxCommand("true", { workspace: "/w", network: "off" }).includes("--unshare-net"));
	assert.ok(!sandboxCommand("true", { workspace: "/w", network: "on" }).includes("--unshare-net"));
	assert.ok(sandboxCommand("true", { workspace: "/w", network: "bogus" }).includes("--unshare-net"), "anything but on fails closed");

	// An empty root, not the host's: nothing is visible unless it is mounted on purpose.
	for (const layout of ["same-path", "fixed"]) {
		const args = sandboxArgs({ workspace: "/w/session", layout });
		const pairs = (flag) => args.flatMap((a, i) => (a === flag ? [[args[i + 1], args[i + 2]]] : []));
		assert.equal(pairs("--ro-bind").some(([src]) => src === "/"), false, `${layout}: the host root is never mounted`);
		assert.ok(pairs("--ro-bind").some(([src, dst]) => src === "/usr" && dst === "/usr"), `${layout}: /usr is read-only`);
		// On this merged-usr host /bin is a link into /usr, and is recreated as one.
		if (lstatSync("/bin").isSymbolicLink()) {
			assert.ok(args.join(" ").includes("--symlink usr/bin /bin"), `${layout}: /bin is a link, as on the host`);
		}
		// /etc holds only the allow-list, plus a generated passwd and group.
		const etc = pairs("--ro-bind").filter(([, dst]) => dst.startsWith("/etc/")).map(([, dst]) => dst.slice(5));
		const allowed = new Set([...SANDBOX_ETC, "passwd", "group"]);
		assert.deepEqual(etc.filter((e) => !allowed.has(e)), [], `${layout}: nothing else from /etc`);
		assert.ok(etc.includes("passwd") && !pairs("--ro-bind").some(([src]) => src === "/etc/passwd"), "passwd is generated, not the host's");
		for (const hidden of ["/home", "/root", "/var/lib", "/srv", "/mnt", "/opt", "/sys", "/etc/shadow", "/etc/ssh"]) {
			assert.equal(pairs("--ro-bind").some(([src]) => src === hidden) || pairs("--bind").some(([src]) => src === hidden), false, `${layout}: ${hidden} is not mounted`);
		}
		// The workspace is the only thing writable, and the scratch space is private.
		assert.deepEqual(pairs("--bind").map(([src]) => src), ["/w/session"], `${layout}: only the workspace is writable`);
		for (const dir of ["/tmp", "/var/tmp", "/run"]) assert.ok(args.includes(dir), `${layout}: ${dir} is a private tmpfs`);
	}
	const fixed = sandboxArgs({ workspace: "/w/session", layout: "fixed" });
	assert.deepEqual(fixed.slice(fixed.indexOf("--bind"), fixed.indexOf("--bind") + 3), ["--bind", "/w/session", "/workspace"], "fixed layout: the workspace is /workspace");
	const envOf = (args, name) => args[args.findIndex((a, i) => a === "--setenv" && args[i + 1] === name) + 2];
	assert.equal(envOf(fixed, "HOME"), "/workspace");
	assert.ok(envOf(fixed, "PATH").startsWith("/opt/node/bin:"), "the runtime is at /opt/node");
	assert.ok(!fixed.join(" ").includes(runtimeRoot() + " " + runtimeRoot()), "no host path for the runtime in the fixed layout");
}

// SANDBOX_ALLOW cannot reach into or contain anything protected, and only what survives is mounted.
{
	const piBin = `${PI_AGENT}/bin`;
	assert.deepEqual(allowedExtraPaths(), ["/usr/share/doc", ...(existsSync(piBin) ? [piBin] : [])], "only the harmless extras, and Pi's bin/");
	const args = sandboxArgs({ workspace: "/w", layout: "fixed" });
	const mounted = args.flatMap((a, i) => (a === "--ro-bind" ? [args[i + 1]] : []));
	assert.ok(mounted.includes("/usr/share/doc"));
	for (const refused of ["/root", "/etc/shadow", "/etc"]) assert.ok(!mounted.includes(refused), `${refused} is refused`);
}

// SANDBOX_ENV: NAME=value pairs for tools, never the gateway's own variables.
{
	assert.deepEqual(parseSandboxEnv("RUSTUP_HOME=/root/.rustup  R2_X=a:b "), [["RUSTUP_HOME", "/root/.rustup"], ["R2_X", "a:b"]]);
	assert.deepEqual(parseSandboxEnv(""), []);
	for (const bad of ["PATH=/evil", "HOME=/root", "PI_CODING_AGENT_DIR=/root/.pi/agent", "PIPER_BRIDGE_SOCKET=/x", "no-equals", "1BAD=x"]) {
		assert.throws(() => parseSandboxEnv(bad, { strict: true }), /SANDBOX_ENV/, `${bad} is refused on save`);
		assert.deepEqual(parseSandboxEnv(bad), [], `${bad} is skipped if it was ever stored`);
	}
	const spec = { key: "SANDBOX_ENV", type: "text", validate: (t) => void parseSandboxEnv(t, { strict: true }) };
	assert.throws(() => coerceSetting(spec, "PATH=/x"), /cannot be overridden/);
	assert.equal(coerceSetting(spec, "A=1"), "A=1");
	assert.deepEqual(parseSandboxEnv(), [["TOOL_HOME", "/opt/tool"]], "a value seeded at startup survives loading");
	const inside = sandboxArgs({ workspace: "/w", layout: "fixed" });
	assert.ok(inside.join(" ").includes("--setenv TOOL_HOME /opt/tool"), "and reaches the sandbox");
}

// The in-process file tools' allow-list: the workspace, and nothing else the operator did not name.
{
	const workspace = mkdtempSync(join(tmpdir(), "pi-allow-"));
	const verdict = (target, write = false) =>
		pathVerdict(target, { workspace, deniedRoots: jailedRoots(), readableRoots: readableRoots(), write });
	assert.equal(verdict(join(workspace, "x.txt")), null, "own workspace is readable");
	assert.ok(verdict("/etc/hostname"), "host configuration is not");
	assert.ok(verdict("/opt/anything"), "installed software outside the workspace is not");
	assert.equal(verdict("/usr/share/doc"), null, "an operator's SANDBOX_ALLOW extra is");
	assert.ok(verdict("/etc/shadow"), "password hashes are not");
	assert.ok(verdict("/etc/ssh/sshd_config"), "ssh configuration and host keys are not");
	assert.ok(verdict("/var/lib/dpkg/status"), "service state is not");
	assert.ok(verdict("/home/someone/.ssh/id_ed25519"), "other users' homes are not");
	assert.ok(verdict("/tmp/anything"), "the gateway's /tmp is outside the allow-list");
	assert.ok(verdict("/proc/self/environ"), "the gateway's own environment is not");
	rmSync(workspace, { recursive: true, force: true });
}

// Session ids are scoped to the credential that presents them.
{
	const alice = { id: "k1", name: "alice" };
	const bob = { id: "k2", name: "bob" };
	const settings = { id: "", name: "GATEWAY_API_KEY", legacy: true };
	assert.equal(scopedSessionId(alice, "chat"), scopedSessionId({ ...alice }, "chat"), "stable for one key");
	const scopes = new Set([scopedSessionId(alice, "chat"), scopedSessionId(bob, "chat"), scopedSessionId(settings, "chat"), scopedSessionId(null, "chat")]);
	assert.equal(scopes.size, 4, "the same id under different credentials is four different sessions");
	assert.notEqual(scopedSessionId(alice, "a"), scopedSessionId(alice, "b"));

	// End to end through the controller: bob presenting alice's id gets a fresh session, not hers.
	const ctl = new SessionController({ create: async () => ({ dispose() {} }), maxSessions: 8, maxLifetimeMs: 1e6, idleMs: 1e6, sweepMs: 0 });
	const hers = ctl.acquire(scopedSessionId(alice, "d-shared"), alice);
	const his = ctl.acquire(scopedSessionId(bob, "d-shared"), bob);
	assert.notEqual(his.record, hers.record, "another key must never reach this session");
	assert.equal(his.isNew, true);
	assert.equal(ctl.acquire(scopedSessionId(alice, "d-shared"), alice).record, hers.record, "the owner still continues it");
	ctl.closeAll();
}

// Image URLs: internal addresses are refused, and URLs are off unless enabled.
{
	for (const address of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "[::1]", "not-an-ip"]) {
		assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
	}
	for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
		assert.equal(isBlockedAddress(address), false, `${address} is public`);
	}
	await assert.rejects(resolveImages(["http://example.com/a.png"]), /ALLOW_IMAGE_URLS/, "URLs are off by default");
}

// The gateway refuses to start as root unless told to.
{
	assert.equal(rootRefusal(1000, {}), null);
	assert.match(rootRefusal(0, {}), /refusing to run as root/);
	assert.equal(rootRefusal(0, { ALLOW_ROOT: "1" }), null);
	assert.match(rootRefusal(0, { ALLOW_ROOT: "0" }), /refusing/);
}

// The controller asks for a workspace per session and releases it when that session ends.
{
	const made = [];
	const released = [];
	const store = {
		create: () => { const path = `/ws/${made.length}`; made.push(path); return path; },
		release: (path) => released.push(path),
	};
	const ctl = new SessionController({
		create: async () => ({ dispose() {} }),
		maxSessions: 4,
		maxLifetimeMs: 1000,
		idleMs: 1000,
		workspaces: store,
		sweepMs: 0,
	});
	ctl.acquire("a");
	ctl.acquire("b");
	assert.deepEqual(made, ["/ws/0", "/ws/1"], "one workspace per session");
	assert.deepEqual([...ctl.liveWorkspaces()], ["/ws/0", "/ws/1"]);
	ctl.close("a");
	assert.deepEqual(released, ["/ws/0"], "closing a session releases its workspace");
	assert.deepEqual([...ctl.liveWorkspaces()], ["/ws/1"], "the swept set spares live sessions only");
}

// Workspace lifecycle policies, against a real filesystem: this is the code that can lose or
// accumulate data, so it is exercised rather than assumed.
{
	const base = mkdtempSync(join(tmpdir(), "pi-ws-"));
	const root = join(base, "workspaces");
	const archive = `${root}-archive`;
	const make = (policy, archiveTtlMs = 30 * 24 * 3600_000) =>
		new WorkspaceManager(() => ({ root, archiveRoot: archive, policy, archiveTtlMs }));
	const age = (target, ms) => utimesSync(target, new Date(Date.now() - ms), new Date(Date.now() - ms));

	// archive moves the directory aside; it must not copy, and contents must survive.
	{
		const ws = make("archive");
		const dir = ws.create();
		writeFileSync(join(dir, "work.txt"), "output");
		ws.release(dir);
		assert.equal(existsSync(dir), false, "the live directory is gone");
		const archived = readdirSync(archive);
		assert.equal(archived.length, 1);
		assert.equal(readFileSync(join(archive, archived[0], "work.txt"), "utf8"), "output", "contents survived");
	}

	// delete removes it and leaves no archive behind.
	{
		rmSync(archive, { recursive: true, force: true });
		const ws = make("delete");
		const dir = ws.create();
		writeFileSync(join(dir, "work.txt"), "output");
		ws.release(dir);
		assert.equal(existsSync(dir), false);
		// The archive root exists because ensureRoots creates it (bwrap needs the mountpoint);
		// what must be empty is its contents.
		assert.equal(existsSync(archive) ? readdirSync(archive).length : 0, 0, "delete must not archive");
	}

	// keep leaves the work exactly where it is.
	{
		const ws = make("keep");
		const dir = ws.create();
		writeFileSync(join(dir, "work.txt"), "output");
		ws.release(dir);
		assert.equal(existsSync(join(dir, "work.txt")), true);
	}

	// An untouched workspace is removed whatever the policy (a request rejected before it ran).
	{
		const ws = make("keep");
		const dir = ws.create();
		ws.release(dir);
		assert.equal(existsSync(dir), false, "an empty workspace is never worth keeping");
	}

	// sweep applies the policy to orphans and spares live sessions.
	{
		rmSync(archive, { recursive: true, force: true });
		const ws = make("archive");
		const orphan = ws.create();
		writeFileSync(join(orphan, "a.txt"), "x");
		const live = ws.create();
		writeFileSync(join(live, "b.txt"), "x");
		age(orphan, 5 * 60_000);
		age(live, 5 * 60_000); // both past the grace period, so only the live set protects one
		const out = ws.sweep(new Set([live]));
		assert.equal(out.orphans, 1, "exactly the orphan is reaped");
		assert.equal(existsSync(orphan), false);
		assert.equal(existsSync(join(live, "b.txt")), true, "a live session's workspace is spared");
	}

	// a directory touched within the last minute is skipped, so a second instance cannot reap a
	// running one's work. Uses its own root so the count means only what this block created.
	{
		const soloBase = mkdtempSync(join(tmpdir(), "pi-ws-fresh-"));
		const soloRoot = join(soloBase, "workspaces");
		const ws = new WorkspaceManager(
			() => ({ root: soloRoot, archiveRoot: `${soloRoot}-archive`, policy: "delete", archiveTtlMs: 0 }),
		);
		const fresh = ws.create();
		writeFileSync(join(fresh, "x.txt"), "x");
		assert.equal(ws.sweep(new Set()).orphans, 0, "a freshly touched directory is left alone");
		assert.equal(existsSync(fresh), true);
		rmSync(soloBase, { recursive: true, force: true });
	}

	// archives past their TTL expire; a TTL of 0 keeps them forever. Own root, so the count is
	// only about what this block archived.
	{
		const ttlBase = mkdtempSync(join(tmpdir(), "pi-ws-ttl-"));
		const ttlRoot = join(ttlBase, "workspaces");
		const ttlArchive = `${ttlRoot}-archive`;
		const withTtl = (archiveTtlMs) =>
			new WorkspaceManager(() => ({ root: ttlRoot, archiveRoot: ttlArchive, policy: "archive", archiveTtlMs }));

		const ws = withTtl(60_000);
		const dir = ws.create();
		writeFileSync(join(dir, "x.txt"), "x");
		ws.release(dir);
		const archived = join(ttlArchive, readdirSync(ttlArchive)[0]);
		age(archived, 120_000);
		assert.equal(ws.sweep(new Set()).expired, 1, "an archive past its TTL is removed");
		assert.equal(existsSync(archived), false);

		const forever = withTtl(0);
		const dir2 = forever.create();
		writeFileSync(join(dir2, "y.txt"), "y");
		forever.release(dir2);
		const kept = join(ttlArchive, readdirSync(ttlArchive)[0]);
		age(kept, 10 * 365 * 24 * 3600_000);
		assert.equal(forever.sweep(new Set()).expired, 0, "0 disables archive expiry");
		assert.equal(existsSync(kept), true);
		rmSync(ttlBase, { recursive: true, force: true });
	}

	rmSync(base, { recursive: true, force: true });
}

// Every setting the code reads must exist in the spec. A missing entry makes `config.X`
// undefined, which fails silently: a cooldown that never expires, a duration formatted as "0".
// This caught FALLBACK_COOLDOWN_MS after it was dropped from the spec while still being read.
{
	const src = gatewaySource();
	const specKeys = new Set([...src.matchAll(/key: "([A-Z_]+)"/g)].map((m) => m[1]));
	const referenced = new Set([...src.matchAll(/config\.([A-Z_]+)/g)].map((m) => m[1]));
	const missing = [...referenced].filter((k) => !specKeys.has(k));
	assert.deepEqual(missing, [], `settings read but never defined: ${missing.join(", ")}`);
	assert.ok(specKeys.size >= 19, "the spec should not shrink unexpectedly");
}

// The password is only ever stored as a scrypt hash, so what matters is that the right password
// verifies, a wrong one does not, and a malformed row fails closed instead of throwing.
{
	const encoded = hashPassword("correct horse battery staple");
	assert.match(encoded, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
	assert.equal(verifyPassword("correct horse battery staple", encoded), true);
	assert.equal(verifyPassword("correct horse battery stapl", encoded), false);
	assert.equal(verifyPassword("", encoded), false);
	assert.notEqual(hashPassword("same"), hashPassword("same"), "each hash carries its own salt");
	for (const bad of ["", "nope", "scrypt$1$2$3$4", "bcrypt$a$b$c$AA$BB", "scrypt$x$y$z$AA$BB"]) {
		assert.equal(verifyPassword("anything", bad), false, `a malformed hash was accepted: ${bad}`);
	}
}

// No password has to mean an open dashboard, or clearing one could never take effect. A set
// password has to refuse anything without a session — including the no-key case, where authorized()
// on its own says yes to everything and would otherwise bypass the password on a default install.
{
	assert.equal(dashboardAuthorized({ headers: {} }), true, "no password keeps the dashboard open");
	process.env.DASHBOARD_PASSWORD = "letmein-please";
	loadDashboardPassword();
	assert.equal(dashboardAuthorized({ headers: {} }), false, "a set password locks the dashboard");
	assert.equal(dashboardAuthorized({ headers: { cookie: "piper_session=forged.0000" } }), false, "a forged cookie is refused");
	assert.equal(dashboardAuthorized({ headers: { cookie: "piper_session=" } }), false);
	assert.equal(dashboardAuthorized({ headers: { authorization: "Bearer wrong" } }), false);
	delete process.env.DASHBOARD_PASSWORD;
}

// Every route the server answers under /dashboard has to be recognised by the guard, because a
// route it does not recognise is served to anyone who asks for it. /dashboard.json was exactly
// that: the dot after the name slipped past a startsWith("/dashboard/") test, so a locked dashboard
// still handed out every session fingerprint, model and cost figure.
{
	for (const p of ["/dashboard", "/dashboard.json", "/dashboard/models.json", "/dashboard/spend.json",
		"/dashboard/settings.json", "/dashboard/settings", "/dashboard/kill-all", "/dashboard/login",
		"/dashboard/logout", "/dashboard/password", "/dashboard/session/abcdef01"]) {
		assert.equal(isDashboardPath(p), true, `the dashboard guard does not cover ${p}`);
	}
	assert.equal(isDashboardPath("/v1/chat/completions"), false);
	assert.equal(isDashboardPath("/health"), false);
	assert.equal(isDashboardPath("/dashboardish"), false, "a lookalike prefix must not be swallowed");
}

// Spend has to outlive the session that incurred it, and the ledger's token total has to agree
// with what a live session reports. It once summed only input+output, so a session with a warm
// prompt cache read 12623 tokens live and recorded 113 here — invisible without this check.
{
	const billed = (cost, tokens, model = { provider: "test-provider", id: "test-model" }) => ({
		model,
		getSessionStats: () => ({ cost, tokens }),
	});
	const record = { id: "ledger-test-session", requests: 3 };
	const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

	assert.deepEqual(spendTotals(), { total: 0, today: 0, sessions: 0 }, "a fresh ledger is empty");

	recordSpend(record, billed(0.25, { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, total: 127 }));
	recordSpend(record, billed(0.5, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 }));
	// Nothing generated means nothing billed, so a rejected request must not land in the ledger.
	recordSpend(record, billed(0, empty));
	// A session that never resolved, or one with no stats, must not throw on the way out.
	recordSpend(record, null);
	recordSpend(record, { model: null });

	const totals = spendTotals();
	assert.equal(totals.total, 0.75, "costs accumulate");
	assert.equal(totals.today, 0.75, "both rows are from today");
	assert.equal(totals.sessions, 2, "the token-less entry is not recorded");

	const report = await spendReport();
	assert.equal(report.total.cost, 0.75);
	assert.equal(report.total.cacheRead, 5);
	assert.equal(report.total.cacheWrite, 2);
	assert.equal(report.byModel.length, 1);
	assert.equal(report.byModel[0].tokens, 138, "the token total includes cache read and write");
	assert.equal(report.byDay.length, 1, "both rows land on the same day");
	assert.equal(report.byDay[0].cost, 0.75);
	assert.equal(report.live.cost, 0, "no live sessions are started in this test");
}

// An API key is shown once and stored only as a hash, so what matters is that the value cannot be
// recovered from the row, that a revoked or expired key stops working without losing its history,
// and that a key which is merely wrong — or truncated — is never accepted.
{
	assert.equal(ApiKeyStore.problem({ revokedAt: null, expiresAt: 0 }), null, "never expires");
	assert.equal(ApiKeyStore.problem({ revokedAt: null, expiresAt: Date.now() + 60000 }), null);
	assert.equal(ApiKeyStore.problem({ revokedAt: null, expiresAt: Date.now() - 1 }), "expired");
	assert.equal(ApiKeyStore.problem({ revokedAt: Date.now(), expiresAt: 0 }), "revoked");
	// A revoked key that also lapsed reads as revoked, which is the more useful thing to say.
	assert.equal(ApiKeyStore.problem({ revokedAt: 1, expiresAt: 1 }), "revoked");

	const { record, key } = apiKeys.create({ name: "test key", expiresAt: 0 });
	assert.match(key, /^piper_[A-Za-z0-9_-]{43}$/, "key shape");
	assert.equal(record.prefix, key.slice(0, 14), "only a prefix is kept for display");
	assert.equal(record.hash.length, 64, "a sha256 hex digest");
	assert.equal(record.hash.includes(key), false, "the key itself is never stored");
	assert.equal(apiKeys.verify(key)?.id, record.id, "a fresh key verifies");
	assert.equal(apiKeys.verify(key.slice(0, -1)), null, "a truncated key is refused");
	assert.equal(apiKeys.verify(`piper_${"x".repeat(43)}`), null, "an unknown key is refused");
	assert.equal(apiKeys.verify(""), null);

	const renamed = apiKeys.update(record.id, { name: "renamed", expiresAt: Date.now() + 86400000 });
	assert.equal(renamed.name, "renamed");
	assert.equal(apiKeys.verify(key)?.id, record.id, "still valid after a rename and an extension");
	assert.equal(apiKeys.update(record.id, { name: "  " }).name, "renamed", "a blank name does not clear it");
	assert.equal(apiKeys.update("6f1e1a5c-0000-4000-8000-000000000000", {}), null, "an unknown id updates nothing");

	apiKeys.revoke(record.id);
	assert.equal(apiKeys.verify(key), null, "a revoked key stops working");
	assert.ok(apiKeys.get(record.id).revokedAt > 0, "but the row survives, so its usage stays attributed");
	assert.equal(keyLabel(record.id), "renamed");

	assert.equal(apiKeys.remove(record.id), true);
	assert.equal(apiKeys.get(record.id), null, "delete removes the row");
	assert.equal(apiKeys.remove(record.id), false, "deleting twice is not an error");
	assert.equal(keyLabel(record.id), "(deleted key)", "usage of a deleted key still has a label");

	assert.equal(keyLabel(null), "no key (open gateway)");
	assert.equal(keyLabel(""), "GATEWAY_API_KEY (settings)");

	assert.equal(expiryFromInput(null), 0, "null means never");
	assert.equal(expiryFromInput(""), 0);
	assert.equal(expiryFromInput("0"), 0);
	assert.equal(expiryFromInput("2030-06-01"), Date.parse("2030-06-01"), "a date string is accepted");
	assert.throws(() => expiryFromInput("the twelfth of never"), /valid date/);
	assert.throws(() => expiryFromInput("2001-01-01"), /future/, "an expiry in the past is rejected");
}

// Usage has to be attributed to the key that opened each session, and a key that was never used
// still needs a row on the page.
{
	const spendLike = (cost, tokens) => ({ model: { provider: "p", id: "m" }, getSessionStats: () => ({ cost, tokens }) });
	const one = apiKeys.create({ name: "usage one", expiresAt: 0 }).record;
	const two = apiKeys.create({ name: "usage two", expiresAt: 0 }).record;
	apiKeys.create({ name: "never used", expiresAt: 0 });

	recordSpend({ id: "k1", requests: 4, keyId: one.id }, spendLike(1.5, { input: 100, output: 10, cacheRead: 5, cacheWrite: 1, total: 116 }));
	recordSpend({ id: "k2", requests: 2, keyId: two.id }, spendLike(0.5, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 }));
	recordSpend({ id: "k3", requests: 1, keyId: null }, spendLike(0.25, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }));

	const usage = await apiKeyUsage();
	const byName = new Map(usage.keys.map((k) => [k.name, k]));
	assert.equal(byName.get("usage one").cost, 1.5);
	assert.equal(byName.get("usage one").requests, 4);
	assert.equal(byName.get("usage one").tokens.total, 116, "the token total includes cache read and write");
	assert.equal(byName.get("usage two").sessions, 1);
	assert.equal(byName.get("never used").sessions, 0, "an unused key is still listed");
	assert.ok(byName.get("no key (open gateway)"), "unauthenticated use is attributed too");
	assert.equal(usage.keys[0].name, "usage one", "sorted by cost");
	assert.equal(byName.get("usage one").byModel.length, 1, "per-model drill-down");
	assert.equal(byName.get("usage one").byModel[0].provider, "p");
	assert.ok(usage.total.cost >= 2.25, "the page total covers every key");
	assert.ok(usage.byDay.length >= 1, "a per-day series");
}

// The key resolved at the edge has to survive the whole way to the ledger row. It did not: acquire()
// kept its old signature and dropped the credential, so every row was billed to "no key" while the
// access log cheerfully printed the right key name. Nothing in the unit tests crossed that gap, so
// the shape of the chain is asserted here instead.
{
	const src = gatewaySource();
	assert.match(src, /#spawn\(id, credential = null(, row = null)?\)/, "#spawn has to take the credential");
	assert.match(src, /keyId: credential\?\.id \?\? null/, "#spawn has to record it");
	assert.match(src, /acquire\(requestId, credential = null\)/, "acquire has to take it");
	const spawnCalls = [...src.matchAll(/this\.#spawn\(([^)]*)\)/g)].map((m) => m[1]);
	assert.ok(spawnCalls.length >= 2, "expected acquire to spawn");
	assert.deepEqual(
		spawnCalls.filter((args) => !args.includes("credential")),
		[],
		"every #spawn call has to forward the credential, or the ledger loses the key",
	);
	assert.match(
		src,
		/const scopedId = scopedSessionId\(req\.credential, clientSessionId\)/,
		"the handler has to scope the id by the credential",
	);
	const acquires = [...src.matchAll(/sessions\.acquire\(([^)]*)\)/g)].map((m) => m[1]);
	assert.ok(acquires.length >= 1);
	assert.deepEqual(acquires.filter((args) => args !== "scopedId, req.credential"), [], "every acquire in the handler passes the scoped id and the credential");
}

// The settings key is compared as a hash, exactly like a created API key, so the database never
// holds a usable credential. With none configured, nothing verifies.
{
	assert.equal(isSettingsKey(""), false);
	assert.equal(isSettingsKey("anything-at-all"), false);
	assert.equal(isSettingsKey(null), false);
	assert.equal(isSettingsKey(undefined), false);
}

// The sandbox's boundary is only as good as its list of protected paths, and that list used to name
// four directories while everything else stayed readable — which is how a session could read the
// parent of the gateway, the shell history and the context-mode databases. The whole home directory
// is the boundary now, at both enforcement points, because bwrap's masks apply to bash alone.
{
	const home = homedir();
	const roots = jailedRoots();
	for (const expected of [home, GATEWAY_DIR, agentDirPath()]) {
		assert.ok(roots.includes(expected), `jailed roots should include ${expected}, got: ${roots.join(", ")}`);
	}
	assert.ok(roots.includes(TEST_WS), "the workspace root is still jailed");

	const ws = `${TEST_WS}/session-under-test`;
	const verdict = (target, write = false) => pathVerdict(target, { workspace: ws, deniedRoots: roots, write });
	assert.equal(verdict(`${ws}/file.txt`), null, "the session's own workspace stays readable");
	assert.ok(verdict(`${home}/analysis/some-other-project`) !== null, "another project under home is refused");
	assert.ok(verdict(`${home}/.bash_history`) !== null, "the shell history is refused");
	assert.ok(verdict(`${home}/.pi/context-mode/sessions/x.db`) !== null, "the context-mode databases are refused");
	assert.ok(verdict(`${GATEWAY_DIR}/gateway.db`) !== null, "gateway.db is refused");
	assert.equal(verdict("/etc/passwd"), null, "system files stay readable, deliberately");
	assert.ok(verdict("/etc/passwd", true) !== null, "but nothing outside the workspace is writable");
	// `~` has to mean the workspace, matching the shell whose HOME is set there.
	assert.equal(resolveTarget("~/notes.txt", ws), `${ws}/notes.txt`);
	assert.equal(resolveTarget("~", ws), ws);
}

// The bash side of the same policy: home masked, environment cleared, and the runtime handed back.
// Masking home without that last part breaks `node` outright, which this caught.
{
	const ws = `${TEST_WS}/sandbox-under-test`;
	const line = buildSandbox("true", { workspace: ws });
	assert.ok(line.includes("--clearenv"), "the environment must not be inherited");
	assert.ok(line.includes(homedir()), "the home directory has to be masked");
	assert.ok(line.includes("--unshare-pid"), "the PID namespace must be fresh");
	assert.ok(line.includes(ws), "the workspace has to be bound back in");

	const runtime = runtimeRoot();
	const back = sandboxBindBack();
	assert.ok(back.includes(runtime), `the runtime ${runtime} has to be handed back or node stops working`);
	assert.deepEqual(back, [runtime, ...allowedExtraPaths()], "only the runtime and the operator's allowed extras");
	assert.ok(
		!back.some((dir) => isInside(dir, GATEWAY_DIR)),
		"no bind-back may re-expose the gateway directory it follows",
	);
}

// ---------------------------------------------------------------- sandboxed runners

// Profiles: one per credential, seeded from your default model and the template, never from your
// own agent directory's credentials or packages.
{
	assert.equal(profileScope(null), "open");
	assert.equal(profileScope(""), "settings");
	assert.equal(profileScope("abc-123"), "key-abc-123");
	assert.equal(profileScope("../../etc"), "key-______etc", "a key id cannot steer the profile path");

	const base = mkdtempSync(join(tmpdir(), "pi-profile-"));
	const host = join(base, "host-agent");
	const template = join(base, "template");
	mkdirSync(host);
	mkdirSync(join(template, "skills", "house-style"), { recursive: true });
	writeFileSync(join(host, "settings.json"), JSON.stringify({ defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "high", packages: ["npm:secret-thing"], shellPath: "/bin/evil" }));
	writeFileSync(join(host, "auth.json"), '{"p":{"key":"sk-real"}}');
	writeFileSync(join(template, "skills", "house-style", "SKILL.md"), "---\nname: house-style\n---\n");

	const dir = ensureProfile("k1", { root: join(base, "profiles"), template });
	assert.equal(dir, join(base, "profiles", "key-k1"));
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), {}, "nothing is copied: a profile follows the operator's default model until its user picks one");
	// That default is read fresh for every new chat, and handed to the bridge.
	assert.deepEqual(hostDefaultModel(host), { model: "p/m", thinking: "high" });
	writeFileSync(join(host, "settings.json"), JSON.stringify({ defaultProvider: "local-openai", defaultModel: "Qwen/Qwen3-Next" }));
	assert.deepEqual(hostDefaultModel(host), { model: "local-openai/Qwen/Qwen3-Next", thinking: null }, "model ids may contain slashes");
	assert.equal(hostDefaultModel(join(base, "missing")), null);
	assert.equal(existsSync(join(dir, "auth.json")), false, "credentials are never copied into a profile");
	assert.equal(existsSync(join(dir, "skills", "house-style", "SKILL.md")), true, "the template is copied");

	// An existing profile is the key's own; creating it again must not overwrite what they changed.
	writeFileSync(join(dir, "settings.json"), '{"defaultModel":"mine"}');
	ensureProfile("k1", { root: join(base, "profiles"), template });
	assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).defaultModel, "mine");
	assert.notEqual(ensureProfile("k2", { root: join(base, "profiles"), template: "" }), dir, "each key gets its own");
	rmSync(base, { recursive: true, force: true });
}

// The catalogue a sandbox sees names models; it never carries where they live or how to reach them.
{
	const catalog = bridgeCatalog([
		{ provider: "a", id: "m1", name: "M1", api: "openai-completions", baseUrl: "http://10.0.0.5/v1", headers: { Authorization: "Bearer sk" }, apiKey: "sk", cost: { input: 1 }, contextWindow: 1000, maxTokens: 100, input: ["text"], reasoning: false },
		{ provider: "a", id: "m2", name: "M2", cost: {}, contextWindow: 1, maxTokens: 1, input: ["text"], reasoning: true },
		{ provider: "b", id: "m3", name: "M3", cost: {}, contextWindow: 1, maxTokens: 1, input: ["text", "image"], reasoning: false },
	]);
	assert.deepEqual(catalog.providers.map((p) => [p.id, p.models.map((m) => m.id)]), [["a", ["m1", "m2"]], ["b", ["m3"]]]);
	const text = JSON.stringify(catalog);
	for (const secret of ["baseUrl", "headers", "apiKey", "10.0.0.5", "sk"]) assert.ok(!text.includes(`"${secret}"`) && !text.includes(secret === "sk" ? "Bearer" : secret), `${secret} must not reach a sandbox`);
}

// The wire format: the cumulative snapshot goes once, deltas go bare, and every other event carries
// the block and usage the bridge needs to rebuild it.
{
	const partial = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], usage: { input: 5, output: 1 } };
	assert.deepEqual(wireEvent({ type: "start", partial }), { type: "start", partial });
	assert.deepEqual(wireEvent({ type: "text_delta", contentIndex: 0, delta: "hi", partial }), { type: "text_delta", contentIndex: 0, delta: "hi" });
	assert.deepEqual(wireEvent({ type: "toolcall_start", contentIndex: 0, partial }), { type: "toolcall_start", contentIndex: 0, usage: partial.usage, block: partial.content[0] });
	assert.deepEqual(wireEvent({ type: "done", reason: "stop", message: { role: "assistant" }, partial }), { type: "done", reason: "stop", message: { role: "assistant" }, usage: partial.usage });
}

// Metering: the ledger is written from the gateway's own count of each finished call.
{
	const meter = newMeter();
	meterUsage(meter, { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, totalTokens: 117, cost: { total: 0.25 } });
	meterUsage(meter, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } });
	meterUsage(meter, undefined);
	assert.equal(meter.cost, 0.75);
	assert.deepEqual(meter.tokens, { input: 11, output: 6, cacheRead: 100, cacheWrite: 2, total: 119 });
}

// Runner commands. bwrap: the same hardened empty-root sandbox as a bash call, in the fixed layout
// the containers use too — the profile, socket and bridge at fixed paths, never at host paths.
// Containers: no capabilities, no network, read-only root.
{
	const opts = { workspace: "/w/s1", profileDir: "/p/key-1", socketPath: "/r/a.sock", bridgePath: "/g/piper-bridge.mjs", packageDir: join(runtimeRoot(), "lib", "pi"), network: "off" };
	const { command, args } = runnerInvocation("bwrap", opts);
	assert.equal(command, "/usr/bin/bwrap");
	for (const flag of ["--unshare-user", "--unshare-net", "--clearenv", "--die-with-parent"]) assert.ok(args.includes(flag), `${flag} applies to the whole Pi process`);
	assert.ok(args.includes("ALL") && args[args.indexOf("--cap-drop") + 1] === "ALL");
	const pair = (flag, src, dst) => args.findIndex((a, i) => a === flag && args[i + 1] === src && args[i + 2] === dst);
	assert.ok(pair("--bind", "/p/key-1", "/profile") > 0, "the profile is writable, at /profile");
	assert.ok(pair("--bind", "/r/a.sock", "/run/piper/bridge.sock") > 0, "the socket is reachable");
	assert.ok(pair("--ro-bind", "/g/piper-bridge.mjs", "/opt/piper/bridge.mjs") > 0, "the bridge is read-only");
	assert.ok(pair("--bind", "/w/s1", "/workspace") > 0, "the workspace is /workspace");
	// The socket goes under /run, so it has to be mounted after /run's tmpfs or the tmpfs hides it.
	assert.ok(pair("--bind", "/r/a.sock", "/run/piper/bridge.sock") > args.indexOf("/run"));
	const binds = args.flatMap((a, i) => (a === "--bind" ? [args[i + 1]] : []));
	assert.deepEqual(binds.sort(), ["/p/key-1", "/r/a.sock", "/w/s1"], "nothing else is writable");
	const env = (name) => args[args.findIndex((a, i) => a === "--setenv" && args[i + 1] === name) + 2];
	assert.equal(env("PI_CODING_AGENT_DIR"), "/profile", "Pi reads the key's profile, not your agent directory");
	assert.equal(env("PIPER_BRIDGE_SOCKET"), "/run/piper/bridge.sock");
	assert.equal(env("HOME"), "/workspace");
	assert.equal(env("PI_OFFLINE"), "1");
	const tail = args.slice(args.indexOf("--"));
	assert.equal(tail[1], join("/opt/node", relative(runtimeRoot(), process.execPath)), "node runs from /opt/node");
	assert.equal(tail[2], "/opt/node/lib/pi/dist/bundle/cli.js", "the Pi package under the prefix is found at /opt/node");
	assert.deepEqual(tail.slice(-7), ["--mode", "rpc", "--session-dir", "/workspace/.piper/session", "--approve", "-e", "/opt/piper/bridge.mjs"], "Pi keeps its session in the chat's workspace");
	assert.ok(!tail.includes("--continue"), "a new chat starts a fresh Pi session");
	const resumed = runnerInvocation("bwrap", { ...opts, resume: true, defaultModel: { model: "p/m", thinking: "high" } }).args;
	assert.ok(resumed.slice(resumed.indexOf("--")).includes("--continue"), "a resumed chat continues its stored Pi session");
	assert.ok(!resumed.join(" ").includes("PIPER_DEFAULT_MODEL"), "a resumed chat keeps its own model");
	const fresh = runnerInvocation("bwrap", { ...opts, defaultModel: { model: "p/m", thinking: "high" } }).args;
	const envOfFresh = (name) => fresh[fresh.findIndex((a, i) => a === "--setenv" && fresh[i + 1] === name) + 2];
	assert.equal(envOfFresh("PIPER_DEFAULT_MODEL"), "p/m", "a new chat is handed the operator's default model");
	assert.equal(envOfFresh("PIPER_DEFAULT_THINKING"), "high");
	for (const hostPath of ["/p/key-1", "/r/a.sock", "/g/piper-bridge.mjs", "/w/s1", runtimeRoot()]) {
		assert.ok(!tail.some((a) => a.includes(hostPath)), `the command line inside never names ${hostPath}`);
	}
	assert.ok(!args.some((a) => /API_KEY|TOKEN/.test(a)), "no credential is passed into the sandbox");

	// A frozen profile (locked or over quota) is a throwaway overlay: readable, apparently writable,
	// and never written back.
	const frozen = runnerInvocation("bwrap", { ...opts, profileWritable: false }).args;
	const overlayAt = frozen.indexOf("--overlay-src");
	assert.ok(overlayAt > 0 && frozen[overlayAt + 1] === "/p/key-1" && frozen[overlayAt + 2] === "--tmp-overlay" && frozen[overlayAt + 3] === "/profile");
	assert.equal(frozen.findIndex((a, i) => a === "--bind" && frozen[i + 1] === "/p/key-1"), -1, "a frozen profile is never bound read-write");
	const frozenDocker = runnerInvocation("docker", { ...opts, profileWritable: false, image: "img", uid: 1, gid: 1 }).args;
	assert.ok(frozenDocker.includes("/p/key-1:/profile-frozen:ro"), "the container sees the frozen profile read-only");
	assert.ok(!frozenDocker.includes("/p/key-1:/profile"), "and never mounts it writable");
	assert.match(frozenDocker.at(-1), /^cp -a \/profile-frozen\/\. \/profile\/ && exec pi --mode rpc/);

	const outside = runnerInvocation("bwrap", { ...opts, packageDir: "/opt/pi-elsewhere" }).args;
	assert.ok(outside.findIndex((a, i) => a === "--ro-bind" && outside[i + 1] === "/opt/pi-elsewhere" && outside[i + 2] === "/opt/pi") > 0, "a Pi package outside the Node prefix is mounted at /opt/pi");
	assert.ok(outside.includes("/opt/pi/dist/bundle/cli.js"));

	const docker = runnerInvocation("docker", { ...opts, image: "img", uid: 1000, gid: 1000 });
	assert.equal(docker.command, "docker");
	const d = docker.args;
	for (const [flag, value] of [["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--user", "1000:1000"]]) {
		assert.equal(d[d.indexOf(flag) + 1], value, `${flag} ${value}`);
	}
	assert.ok(d.includes("--read-only") && d.includes("--rm") && d.includes("-i"));
	assert.ok(d.includes("/w/s1:/workspace") && d.includes("/p/key-1:/profile") && d.includes("/r/a.sock:/run/piper/bridge.sock"));
	assert.ok(d.includes("/g/piper-bridge.mjs:/opt/piper/bridge.mjs:ro"));
	assert.ok(d.includes("PI_CODING_AGENT_DIR=/profile"));
	assert.equal(d[d.indexOf("img") + 1], "pi", "the image runs pi");
	assert.ok(!runnerInvocation("podman", { ...opts, network: "on" }).args.includes("--network"), "network on uses the engine default");
}

// PiRpcSession against a scripted child: LF-only framing, prompt completion, extension commands
// that never start a run, and a crash that fails whatever was waiting.
{
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const fakeChild = (handler) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.exitCode = null;
		child.signalCode = null;
		child.kill = () => {};
		child.stdin = new PassThrough();
		child.sent = [];
		let buffer = "";
		child.stdin.on("data", (chunk) => {
			buffer += chunk;
			let i;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const command = JSON.parse(buffer.slice(0, i));
				buffer = buffer.slice(i + 1);
				child.sent.push(command);
				handler(command, (record) => child.stdout.write(`${JSON.stringify(record)}\n`));
			}
		});
		return child;
	};
	const ok = (command, data) => ({ type: "response", id: command.id, command: command.type, success: true, data });

	// A normal prompt: settles on agent_settled, and a U+2028 inside a string does not split the record.
	const tricky = "line\u2028separator\u2029para";
	const child = fakeChild((command, reply) => {
		if (command.type === "get_state") return reply(ok(command, { model: { provider: "p", id: "m", input: ["text"] }, thinkingLevel: "high", isStreaming: false }));
		if (command.type === "prompt") {
			reply(ok(command));
			reply({ type: "agent_start" });
			reply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: tricky } });
			reply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: tricky }] } });
			setTimeout(() => reply({ type: "agent_settled" }), 20);
		}
	});
	const meter = newMeter();
	meter.cost = 1.5;
	const session = await new PiRpcSession(child, { meter }).init(2000);
	assert.equal(session.model.id, "m");
	assert.equal(session.thinkingLevel, "high");
	const deltas = [];
	const unsubscribe = session.subscribe((e) => e.type === "message_update" && deltas.push(e.assistantMessageEvent.delta));
	await session.prompt("hi", { images: [{ type: "image", data: "QQ==", mimeType: "image/png" }] });
	unsubscribe();
	assert.deepEqual(deltas, [tricky], "U+2028 and U+2029 stay inside their record");
	assert.equal(session.getLastAssistantText(), tricky);
	assert.equal(child.sent.find((c) => c.type === "prompt").images.length, 1);
	assert.equal(session.getSessionStats().cost, 1.5, "stats come from the gateway's meter");

	// An extension command is handled without a run: no agent_settled ever comes, and prompt must not hang.
	const commandChild = fakeChild((command, reply) => {
		if (command.type === "get_state") return reply(ok(command, { isStreaming: false }));
		if (command.type === "prompt") return reply(ok(command));
	});
	const commandSession = await new PiRpcSession(commandChild).init(2000);
	const started = Date.now();
	await commandSession.prompt("/piper-reload");
	assert.ok(Date.now() - started < 1000, "an extension command returns without waiting for a run");

	// A crash fails the waiting prompt with a reason, and marks the session dead so the next request respawns.
	const crashChild = fakeChild((command, reply) => {
		if (command.type === "get_state") return reply(ok(command, {}));
		if (command.type === "prompt") {
			reply(ok(command));
			reply({ type: "agent_start" });
			crashChild.stderr.write("boom: out of memory\n");
			setTimeout(() => crashChild.emit("exit", 137, null), 20);
		}
	});
	let closed = false;
	const crashSession = await new PiRpcSession(crashChild, { onClose: () => (closed = true) }).init(2000);
	await assert.rejects(crashSession.prompt("hi"), /exited \(code 137\): boom: out of memory/);
	assert.equal(crashSession.alive, false);
	assert.equal(closed, true, "the bridge is torn down with the process");
	await assert.rejects(crashSession.send({ type: "get_state" }), /not running/);

	// A failed command rejects with Pi's own message.
	const failChild = fakeChild((command, reply) => {
		if (command.type === "get_state") return reply(ok(command, {}));
		reply({ type: "response", id: command.id, command: command.type, success: false, error: "Model not found: x/y" });
	});
	const failSession = await new PiRpcSession(failChild).init(2000);
	await assert.rejects(failSession.setModel({ provider: "x", id: "y" }), /Model not found/);
}

// The bridge socket: owner-only, unknown routes refused, and gone once closed.
{
	const { statSync: stat } = await import("node:fs");
	const http = await import("node:http");
	const dir = mkdtempSync(join("/tmp", "pb-"));
	const socketPath = join(dir, "t.sock");
	const bridge = await startBridge(socketPath, newMeter());
	assert.equal(stat(socketPath).mode & 0o777, 0o600);
	const status = await new Promise((resolve, reject) => {
		const req = http.request({ socketPath, path: "/dashboard/settings", method: "POST" }, (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end("{}");
	});
	assert.equal(status, 404, "nothing but the model routes answers on the bridge");
	bridge.close();
	assert.equal(existsSync(socketPath), false);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- profile control

// Chat commands: only the exact gateway names, so Pi's own /skill:name and templates pass through.
{
	assert.deepEqual(parseGatewayCommand("/skills"), { name: "skills", args: "" });
	assert.deepEqual(parseGatewayCommand("  /settings set defaultModel \"x\"  "), { name: "settings", args: 'set defaultModel "x"' });
	assert.deepEqual(parseGatewayCommand("/profile reset confirm"), { name: "profile", args: "reset confirm" });
	assert.equal(parseGatewayCommand("/skill:haiku gateways"), null, "Pi's skill commands go to Pi");
	assert.equal(parseGatewayCommand("/fix-tests"), null, "prompt templates go to Pi");
	assert.equal(parseGatewayCommand("/etc/passwd is readable, why?"), null);
	assert.equal(parseGatewayCommand("please show /skills"), null);
	assert.equal(parseGatewayCommand("/reload"), null, "/reload keeps its own handler");
}

// Scopes map back to keys, and locks and quotas decide whether a profile is writable.
{
	for (const id of [null, "", "0acb4c42-ff9b-4eb3-a3d6-d5d2b60ce354"]) assert.equal(keyIdForScope(profileScope(id)), id);
	assert.equal(keyIdForScope("bogus"), undefined);

	const dir = mkdtempSync(join(tmpdir(), "pi-lock-"));
	assert.equal(profileWritability("lock-test", dir).writable, true);
	setProfileLock(profileScope("lock-test"), true);
	assert.equal(isProfileLocked(profileScope("lock-test")), true);
	assert.deepEqual(profileWritability("lock-test", dir), { writable: false, reason: "locked by the gateway operator" });
	setProfileLock(profileScope("lock-test"), false);
	assert.equal(profileWritability("lock-test", dir).writable, true);
	rmSync(dir, { recursive: true, force: true });
}

// profileStats reads names and sizes only, and never follows a link out of the profile.
{
	const base = mkdtempSync(join(tmpdir(), "pi-stats-"));
	const dir = join(base, "profile");
	const outside = join(base, "outside");
	mkdirSync(join(dir, "skills", "a"), { recursive: true });
	mkdirSync(join(dir, "extensions"));
	mkdirSync(outside);
	writeFileSync(join(outside, "huge.bin"), Buffer.alloc(100_000));
	writeFileSync(join(dir, "skills", "a", "SKILL.md"), "12345");
	symlinkSync(outside, join(dir, "skills", "linked"));
	const stats = profileStats(dir);
	assert.deepEqual(stats.skills, ["a", "linked"]);
	assert.ok(stats.bytes < 1000, "a link is counted as itself, not as what it points at");
	rmSync(base, { recursive: true, force: true });
}

// The helper's sandbox: only the profile, writable; no network whatever SANDBOX_NETWORK says.
{
	const { command, args } = profileHelperInvocation("bwrap", { profileDir: "/p/key-9", helperPath: "/g/piper-profile.mjs", maxBytes: 42 });
	assert.equal(command, "/usr/bin/bwrap");
	assert.ok(args.includes("--unshare-net"), "the helper never has a network");
	assert.ok(args.includes("--cap-drop") && args.includes("--unshare-user"));
	// The profile stands in for the workspace: mounted at /workspace, the one writable place.
	assert.deepEqual(args.flatMap((a, i) => (a === "--bind" ? [[args[i + 1], args[i + 2]]] : [])), [["/p/key-9", "/workspace"]], "the profile is the one writable place");
	assert.ok(args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/g/piper-profile.mjs" && args[i + 2] === "/opt/piper/profile.mjs") > 0);
	assert.equal(args[args.indexOf("--chdir") + 1], "/workspace", "the helper runs in the profile");
	assert.equal(args[args.findIndex((a, i) => a === "--setenv" && args[i + 1] === "PROFILE_MAX_BYTES") + 2], "42");
	assert.deepEqual(args.slice(-2), [join("/opt/node", relative(runtimeRoot(), process.execPath)), "/opt/piper/profile.mjs"]);
	const docker = profileHelperInvocation("docker", { profileDir: "/p/key-9", helperPath: "/g/h.mjs", image: "img", uid: 5, gid: 5 }).args;
	assert.equal(docker[docker.indexOf("--network") + 1], "none");
	assert.ok(docker.includes("/p/key-9:/profile") && docker.includes("/g/h.mjs:/opt/piper/profile.mjs:ro"));
}

// The helper itself, run directly against a scratch profile: every operation, the quota, and the
// path checks. (Run outside a sandbox here; the sandbox is what makes following a link harmless.)
{
	const { execFileSync } = await import("node:child_process");
	const helper = fileURLToPath(new URL("./piper-profile.mjs", import.meta.url));
	const dir = mkdtempSync(join(tmpdir(), "pi-helper-"));
	const run = (command, maxBytes = 0) =>
		JSON.parse(execFileSync(process.execPath, [helper], { cwd: dir, input: JSON.stringify(command), env: { PATH: process.env.PATH, PROFILE_MAX_BYTES: String(maxBytes) } }).toString());

	assert.deepEqual(run({ op: "settings.get" }), { ok: true, result: {} });
	assert.equal(run({ op: "settings.put", settings: { defaultModel: "m" } }).ok, true);
	assert.deepEqual(run({ op: "settings.patch", set: { theme: "dark" }, unset: ["defaultModel"] }).result, { theme: "dark" });
	assert.equal(run({ op: "settings.put", settings: [1, 2] }).ok, false, "settings must be an object");

	const skill = { op: "skills.put", name: "demo", files: { "SKILL.md": "---\nname: demo\ndescription: Says hi.\n---\nhi", "scripts/run.sh": "echo hi" } };
	assert.deepEqual(run(skill).result, { name: "demo", description: "Says hi." });
	assert.equal(readFileSync(join(dir, "skills", "demo", "scripts", "run.sh"), "utf8"), "echo hi");
	assert.deepEqual(run({ op: "skills.list" }).result.map((s) => s.name), ["demo"]);
	assert.deepEqual(Object.keys(run({ op: "skills.get", name: "demo" }).result.files).sort(), ["SKILL.md", "scripts/run.sh"]);
	// Replacing a skill replaces it whole: files it no longer has are gone.
	run({ op: "skills.put", name: "demo", files: { "SKILL.md": "---\nname: demo\n---\nv2" } });
	assert.equal(existsSync(join(dir, "skills", "demo", "scripts")), false);

	for (const bad of [
		{ op: "skills.put", name: "../x", files: { "SKILL.md": "x" } },
		{ op: "skills.put", name: "ok", files: { "SKILL.md": "x", "../../escape": "x" } },
		{ op: "skills.put", name: "ok", files: { "SKILL.md": "x", "/etc/cron.d/x": "x" } },
		{ op: "skills.put", name: "ok", files: { "notes.md": "no SKILL.md" } },
		{ op: "extensions.put", name: "x.sh", content: "x" },
		{ op: "extensions.put", name: "../x.ts", content: "x" },
		{ op: "nope" },
	]) {
		const answer = run(bad);
		assert.equal(answer.ok, false, JSON.stringify(bad));
		assert.equal(answer.refused, true, "a bad request is a refusal, not a crash");
	}
	assert.equal(existsSync(join(dir, "..", "escape")), false);

	assert.equal(run({ op: "extensions.put", name: "hello.ts", content: "export default () => {}" }).ok, true);
	assert.deepEqual(run({ op: "extensions.list" }).result.map((e) => e.name), ["hello.ts"]);
	assert.equal(run({ op: "extensions.get", name: "hello.ts" }).result.content, "export default () => {}");
	assert.equal(run({ op: "extensions.delete", name: "hello.ts" }).ok, true);
	assert.equal(run({ op: "skills.delete", name: "demo" }).ok, true);

	// The quota counts the whole profile, and credits what a write replaces.
	const quota = run({ op: "extensions.put", name: "big.ts", content: "x".repeat(5000) }, 1000);
	assert.equal(quota.ok, false);
	assert.match(quota.error, /quota exceeded/);
	assert.equal(existsSync(join(dir, "extensions", "big.ts")), false, "a refused write leaves nothing behind");
	assert.equal(run({ op: "extensions.put", name: "small.ts", content: "x".repeat(100) }, 1000).ok, true);
	assert.equal(run({ op: "extensions.put", name: "small.ts", content: "y".repeat(100) }, 1000).ok, true, "replacing a file credits its old size");

	const summary = run({ op: "summary" }, 1000).result;
	assert.equal(summary.maxBytes, 1000);
	assert.deepEqual(summary.extensions.map((e) => e.name), ["small.ts"]);
	writeFileSync(join(dir, "settings.json"), "{broken");
	assert.match(run({ op: "summary" }).result.settingsError, /JSON|Unexpected|Expected/);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- limits

// Float settings, for money and CPU counts.
{
	const spec = { key: "X", type: "float", min: 0 };
	assert.equal(coerceSetting(spec, "0.25"), 0.25);
	assert.equal(coerceSetting(spec, 3), 3);
	assert.throws(() => coerceSetting(spec, ""), /must be a number/);
	assert.throws(() => coerceSetting(spec, "abc"), /must be a number/);
	assert.throws(() => coerceSetting(spec, "-1"), /at least 0/);
}

// Resource limits become systemd scope properties, and container flags.
{
	assert.deepEqual(limitProperties({ memoryMb: 2048, pids: 512, cpus: 1.5 }), ["MemoryMax=2048M", "MemorySwapMax=0", "OOMPolicy=continue", "TasksMax=512", "CPUQuota=150%"]);
	assert.deepEqual(limitProperties({ memoryMb: 0, pids: 0, cpus: 0 }), [], "0 means no limit");
	assert.deepEqual(scopePrefix([]), [], "no limits, no wrapper");
	assert.deepEqual(scopePrefix(["TasksMax=5"], { user: false }), ["systemd-run", "--scope", "--quiet", "--collect", "-p", "TasksMax=5", "--"]);
	assert.ok(scopePrefix(["TasksMax=5"], { user: true }).includes("--user"), "a non-root gateway uses its user manager");

	const opts = { workspace: "/w", profileDir: "/p", socketPath: "/r.sock", bridgePath: "/b.mjs", image: "img", uid: 1, gid: 1 };
	const limited = runnerInvocation("docker", { ...opts, memoryMb: 512, pids: 64, cpus: 0.5 }).args;
	assert.equal(limited[limited.indexOf("--memory") + 1], "512m");
	assert.equal(limited[limited.indexOf("--pids-limit") + 1], "64");
	assert.equal(limited[limited.indexOf("--cpus") + 1], "0.5");
	const unlimited = runnerInvocation("podman", { ...opts, memoryMb: 0, pids: 0, cpus: 0 }).args;
	assert.ok(!unlimited.includes("--memory") && !unlimited.includes("--pids-limit") && !unlimited.includes("--cpus"));
}

// Per-key limits: the key's own value wins, blank follows the default, 0 is unlimited, and the
// operator's settings key is never limited.
{
	assert.equal(limitFromInput("", "x"), null);
	assert.equal(limitFromInput(null, "x"), null);
	assert.equal(limitFromInput("2.5", "x"), 2.5);
	assert.equal(limitFromInput(0, "x"), 0);
	assert.throws(() => limitFromInput("-1", "x"), /0 or more/);
	assert.throws(() => limitFromInput("1.5", "x", { integer: true }), /whole number/);

	const { record } = apiKeys.create({ name: "limited" });
	const defaults = { maxSessions: 16, dailySpend: 5 };
	assert.deepEqual(keyLimits({ id: record.id }, defaults), { maxSessions: 16, dailySpend: 5 }, "defaults apply");
	apiKeys.update(record.id, { maxSessions: 2, dailySpend: 0 });
	assert.deepEqual(keyLimits({ id: record.id }, defaults), { maxSessions: 2, dailySpend: 0 }, "the key's own values win, 0 included");
	apiKeys.update(record.id, { maxSessions: null });
	assert.equal(keyLimits({ id: record.id }, defaults).maxSessions, 16, "null goes back to the default");
	assert.deepEqual(keyLimits({ id: "", name: "GATEWAY_API_KEY" }, defaults), { maxSessions: 0, dailySpend: 0 }, "the settings key is exempt");
	assert.deepEqual(keyLimits(null, defaults), defaults, "the open gateway follows the defaults");

	// Spend: today's ledger rows for this key only, against its cap.
	apiKeys.update(record.id, { dailySpend: 1 });
	assert.equal(spendRefusal({ id: record.id }), null, "nothing spent yet");
	const insert = (keyId, cost) =>
		recordSpend(
			{ id: `spend-${Math.random()}`, requests: 1, keyId },
			{ getSessionStats: () => ({ cost, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }), model: { provider: "p", id: "m" } },
		);
	insert(record.id, 0.6);
	insert("someone-else", 50);
	assert.ok(Math.abs(spentToday(record.id) - 0.6) < 1e-9, "only this key's rows count");
	assert.equal(spendRefusal({ id: record.id }), null, "under the cap");
	insert(record.id, 0.5);
	assert.match(spendRefusal({ id: record.id }), /daily spend limit reached: \$1\.1000 of \$1\.00/);
	assert.match(spendRefusal(record.id), /daily spend limit/, "the bridge passes a bare key id");
	assert.equal(spendRefusal(""), null, "the settings key is exempt");

	// The bridge refuses a model call from an over-cap key before touching any model.
	const http = await import("node:http");
	const dir = mkdtempSync(join("/tmp", "pb-"));
	const socketPath = join(dir, "s.sock");
	const bridge = await startBridge(socketPath, newMeter(), { keyId: record.id });
	const answer = await new Promise((resolve, reject) => {
		const req = http.request({ socketPath, path: "/stream", method: "POST" }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
		});
		req.on("error", reject);
		req.end(JSON.stringify({ provider: "p", modelId: "m", messages: [] }));
	});
	assert.equal(answer.status, 429);
	assert.match(answer.body.error, /daily spend limit reached/);
	assert.doesNotMatch(answer.body.error, /quota|429|rate.?limit/i, "must not look like a provider quota error, or the fallback would retry it");
	bridge.close();
	rmSync(dir, { recursive: true, force: true });
	apiKeys.remove(record.id);
}

// Session limits: a key's idle sessions make room; busy ones do not; other keys are untouched.
{
	const ctl = new SessionController({ create: async () => ({ dispose() {} }), maxSessions: 100, maxLifetimeMs: 1e6, idleMs: 1e6, sweepMs: 0 });
	const k = { id: "k-limit" };
	const a = ctl.acquire("a", k).record;
	const b = ctl.acquire("b", k).record;
	ctl.acquire("x", { id: "other" });
	a.lastUsedAt = 1;
	b.lastUsedAt = 2;
	assert.equal(ctl.makeRoomForKey("k-limit", 3), true, "under the limit");
	assert.equal(ctl.recordsByKey("k-limit").length, 2);
	assert.equal(ctl.makeRoomForKey("k-limit", 2), true, "at the limit, the oldest idle one goes");
	assert.equal(ctl.has("a"), false);
	assert.equal(ctl.has("b"), true);
	assert.equal(ctl.has("x"), true, "another key's session is never touched");
	b.inflight = 1;
	assert.equal(ctl.makeRoomForKey("k-limit", 1), false, "a busy session is never closed to make room");
	assert.equal(ctl.makeRoomForKey("k-limit", 0), true, "0 is unlimited");
	b.inflight = 0;
	ctl.closeAll();
}

// Stale bridge sockets are removed; a live one, and anything young, is left alone.
{
	const net = await import("node:net");
	const dir = mkdtempSync(join("/tmp", "ps-"));
	const live = net.createServer().listen(join(dir, "live.sock"));
	await new Promise((r) => live.once("listening", r));
	// A killed process leaves its socket file behind; a clean close would remove it, so the stale
	// socket has to come from a process that is actually killed.
	const { spawn: spawnChild } = await import("node:child_process");
	const owner = spawnChild(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(join(dir, "dead.sock"))}, () => console.log("up"))`]);
	await new Promise((r) => owner.stdout.once("data", r));
	owner.kill("SIGKILL");
	await new Promise((r) => owner.once("exit", r));
	const old = new Date(Date.now() - 5 * 60_000);
	assert.equal(existsSync(join(dir, "dead.sock")), true, "the dead socket file has to exist for this test to mean anything");
	for (const name of ["live.sock", "dead.sock"]) utimesSync(join(dir, name), old, old);
	writeFileSync(join(dir, "notes.txt"), "not a socket");
	await sweepSockets(dir);
	assert.equal(existsSync(join(dir, "live.sock")), true, "a socket somebody answers on is kept");
	assert.equal(existsSync(join(dir, "dead.sock")), false, "a refused one is removed");
	assert.equal(existsSync(join(dir, "notes.txt")), true);
	live.close();
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- shared bundles

{
	assert.equal(bundleListFromInput(""), null, "blank follows the default");
	assert.equal(bundleListFromInput(null), null);
	assert.equal(bundleListFromInput("none"), "", "none is an explicit empty list");
	assert.equal(bundleListFromInput(" base , security "), "base,security");
	assert.equal(bundleListFromInput("*"), "*");
	assert.throws(() => bundleListFromInput("../etc"), /not a bundle name/);
	assert.throws(() => bundleListFromInput("a b"), /not a bundle name/);

	const root = mkdtempSync(join(tmpdir(), "pi-shared-"));
	mkdirSync(join(root, "base", "skills", "hallmark"), { recursive: true });
	mkdirSync(join(root, "base", "extensions"), { recursive: true });
	mkdirSync(join(root, "base", "prompts"), { recursive: true });
	writeFileSync(join(root, "base", "extensions", "tool.ts"), "export default () => {}");
	writeFileSync(join(root, "base", "prompts", "review.md"), "Review.");
	mkdirSync(join(root, "security", "skills", "pentest"), { recursive: true });
	mkdirSync(join(root, ".hidden"));
	writeFileSync(join(root, "README.txt"), "not a bundle");
	assert.deepEqual(listBundles(root).map((b) => b.name), ["base", "security"], "only valid folders are bundles");
	assert.deepEqual(bundleContents(join(root, "base")), { skills: ["hallmark"], extensions: ["tool.ts"], prompts: ["review"] });

	const names = (list) => list.map((b) => b.name);
	const { record } = apiKeys.create({ name: "bundled" });
	assert.deepEqual(names(grantedBundles(record.id, { root, fallback: "base" })), ["base"], "the default applies");
	apiKeys.update(record.id, { sharedBundles: "security,missing" });
	assert.deepEqual(names(grantedBundles(record.id, { root, fallback: "base" })), ["security"], "a key's own list wins; unknown names are ignored");
	apiKeys.update(record.id, { sharedBundles: "" });
	assert.deepEqual(grantedBundles(record.id, { root, fallback: "*" }), [], "an explicit empty list gets nothing, whatever the default");
	apiKeys.update(record.id, { sharedBundles: "*" });
	assert.deepEqual(names(grantedBundles(record.id, { root, fallback: "" })), ["base", "security"]);
	assert.deepEqual(names(grantedBundles("", { root, fallback: "" })), ["base", "security"], "the operator's settings key gets everything");
	assert.deepEqual(names(grantedBundles(null, { root, fallback: "base" })), ["base"], "the open gateway follows the default");
	apiKeys.remove(record.id);

	// Each granted bundle is mounted read-only at /shared/<name> and loaded with one -e; the shared
	// root itself is never mounted, so a bundle that was not granted does not exist inside.
	const bundles = listBundles(root);
	const granted = bundles.filter((b) => b.name === "base");
	const args = runnerInvocation("bwrap", { workspace: "/w", profileDir: "/p", socketPath: "/r.sock", bridgePath: "/b.mjs", packageDir: join(runtimeRoot(), "lib", "pi"), network: "off", bundles: granted }).args;
	const loads = args.slice(args.indexOf("--"));
	assert.ok(args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === join(root, "base") && args[i + 2] === "/shared/base") > 0, "base is mounted read-only at /shared/base");
	assert.equal(args.findIndex((a, i) => a === "--bind" && args[i + 1] === join(root, "base")), -1, "a bundle is never writable");
	assert.ok(loads.findIndex((a, i) => a === "-e" && loads[i + 1] === "/shared/base") > 0, "base is loaded as a package");
	assert.ok(!args.includes(join(root, "security")) && !args.includes(root), "neither the other bundle nor the shared root is mounted");
	const docker = runnerInvocation("docker", { workspace: "/w", profileDir: "/p", socketPath: "/r.sock", bridgePath: "/b.mjs", image: "img", uid: 1, gid: 1, bundles }).args;
	assert.ok(docker.includes(`${join(root, "base")}:/shared/base:ro`));
	assert.ok(docker.slice(docker.indexOf("img")).join(" ").includes("-e /shared/base -e /shared/security"));
	rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- profile inventory

// inventory() finds what Pi would load: skills recursively but not inside another skill, extension
// files and folders, prompts, agent definitions, AGENTS.md and packages.
{
	const root = mkdtempSync(join(tmpdir(), "pi-inv-"));
	const skill = (rel, name, description) => {
		mkdirSync(join(root, "skills", rel), { recursive: true });
		writeFileSync(join(root, "skills", rel, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
	};
	skill("alpha", "alpha", "First.");
	skill("pack/beta", "beta", "Nested one level down.");
	skill("alpha/inner", "inner", "Inside another skill, so Pi never loads it.");
	mkdirSync(join(root, "skills", "node_modules", "x"), { recursive: true });
	writeFileSync(join(root, "skills", "node_modules", "x", "SKILL.md"), "---\nname: nm\n---\n");
	mkdirSync(join(root, "extensions", "folder-ext"), { recursive: true });
	writeFileSync(join(root, "extensions", "one.ts"), "export default () => {}");
	writeFileSync(join(root, "extensions", "notes.txt"), "not an extension");
	mkdirSync(join(root, "prompts"));
	writeFileSync(join(root, "prompts", "review.md"), "---\ndescription: Review code.\n---\nReview.");
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "scout.md"), "---\nname: scout\ndescription: Finds things.\n---\n");
	writeFileSync(join(root, "AGENTS.md"), "Be terse. ".repeat(300));
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: ["npm:pi-lens", { source: "git:github.com/x/y" }] }));

	const inv = inventory(root);
	assert.deepEqual(inv.skills.map((s) => [s.name, s.path]), [["alpha", "alpha"], ["beta", "pack/beta"]], "nested skills found, skills inside skills and node_modules not");
	assert.equal(inv.skills[0].description, "First.");
	assert.deepEqual(inv.extensions.map((e) => e.name), ["folder-ext", "one.ts"]);
	assert.deepEqual(inv.prompts, [{ name: "review", description: "Review code." }]);
	assert.deepEqual(inv.agents, [{ name: "scout", description: "Finds things." }]);
	assert.deepEqual(inv.packages, ["npm:pi-lens", "git:github.com/x/y"]);
	assert.equal(inv.agentsMd.bytes, 3000);
	assert.equal(inv.agentsMd.preview.length, 1500, "AGENTS.md is previewed, not sent whole");
	assert.deepEqual(inventory(join(root, "missing")), { skills: [], extensions: [], prompts: [], agents: [], packages: [], agentsMd: null });

	// The helper answers the same through its sandboxed command.
	const { execFileSync } = await import("node:child_process");
	const helper = fileURLToPath(new URL("./piper-profile.mjs", import.meta.url));
	const answer = JSON.parse(execFileSync(process.execPath, [helper], { cwd: root, input: '{"op":"inventory"}' }).toString());
	assert.equal(answer.ok, true);
	assert.deepEqual(answer.result.skills.map((s) => s.name), ["alpha", "beta"]);
	assert.ok(answer.result.bytes > 3000);
	rmSync(root, { recursive: true, force: true });
}

// Loaded tools and commands are labelled by where they came from, from their path inside the sandbox.
{
	assert.equal(originOf("/profile/extensions/mine.ts"), "own");
	assert.equal(originOf("/shared/base/extensions/r2mcp/index.ts"), "shared: base");
	assert.equal(originOf("/workspace/.pi/skills/x/SKILL.md"), "workspace");
	assert.equal(originOf("/opt/piper/bridge.mjs"), "gateway");
	assert.equal(originOf("/opt/node/lib/node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/index.js"), "built-in");
	assert.equal(originOf(""), "built-in");
	assert.equal(originOf("/profiles-evil/x"), "built-in", "only the profile folder itself counts as own");
}

// profileDetail never creates a profile, and refuses a scope that names no key.
{
	const { record } = apiKeys.create({ name: "never-chatted" });
	const d = await profileDetail(`key-${record.id}`);
	assert.equal(d.created, false);
	assert.equal(d.own, null);
	assert.equal(existsSync(join(TEST_PROFILES, `key-${record.id}`)), false, "looking does not create");
	assert.equal(await profileDetail("key-00000000-0000-0000-0000-000000000000"), null);
	assert.equal(await profileDetail("nonsense"), null);
	apiKeys.remove(record.id);
}

// ---------------------------------------------------------------- per-key shared folder

// Mounted at /workspace/shared, after the workspace's own bind (which would otherwise cover it).
{
	const opts = { workspace: "/w/s1", profileDir: "/p/key-1", socketPath: "/r/a.sock", bridgePath: "/g/b.mjs", packageDir: join(runtimeRoot(), "lib", "pi"), network: "off", filesDir: "/f/key-1" };
	const args = runnerInvocation("bwrap", opts).args;
	const at = (flag, src, dst) => args.findIndex((a, i) => a === flag && args[i + 1] === src && args[i + 2] === dst);
	const workspaceBind = at("--bind", "/w/s1", "/workspace");
	const filesBind = at("--bind", "/f/key-1", "/workspace/shared");
	assert.ok(workspaceBind > 0 && filesBind > workspaceBind, "the shared folder is bound after the workspace, or the workspace would hide it");
	assert.ok(at("--bind", "/p/key-1", "/profile") < workspaceBind, "binds outside the workspace stay before it");
	const env = (name) => args[args.findIndex((a, i) => a === "--setenv" && args[i + 1] === name) + 2];
	assert.equal(env("PIPER_SHARED_DIR"), "/workspace/shared", "the bridge is told where it is");
	const binds = args.flatMap((a, i) => (a === "--bind" ? [args[i + 1]] : []));
	assert.deepEqual(binds.sort(), ["/f/key-1", "/p/key-1", "/r/a.sock", "/w/s1"], "writable: workspace, profile, socket and the shared folder, nothing else");

	const frozen = runnerInvocation("bwrap", { ...opts, filesWritable: false }).args;
	const ov = frozen.findIndex((a, i) => a === "--overlay-src" && frozen[i + 1] === "/f/key-1");
	assert.ok(ov > 0 && frozen[ov + 3] === "/workspace/shared", "a frozen folder is a throwaway overlay");
	assert.ok(!frozen.includes("--bind") || frozen.findIndex((a, i) => a === "--bind" && frozen[i + 1] === "/f/key-1") === -1);

	const without = runnerInvocation("bwrap", { ...opts, filesDir: null }).args;
	assert.ok(!without.includes("/workspace/shared") && !without.join(" ").includes("PIPER_SHARED_DIR"), "no folder, no mount and no note");

	const docker = runnerInvocation("docker", { ...opts, image: "img", uid: 1, gid: 1 }).args;
	assert.ok(docker.includes("/f/key-1:/workspace/shared") && docker.includes("PIPER_SHARED_DIR=/workspace/shared"));
	assert.ok(runnerInvocation("docker", { ...opts, filesWritable: false, image: "img", uid: 1, gid: 1 }).args.includes("/f/key-1:/workspace/shared:ro"));
	assert.ok(sandboxArgs({ workspace: "/w" }).every((a) => !a.includes(TEST_FILES)), "no ordinary sandbox mounts the files root");
}

// One folder per key, created once, owner-only; a key id cannot steer where it goes.
{
	const root = mkdtempSync(join(tmpdir(), "pi-files-"));
	const a = ensureKeyFiles("k1", { root });
	assert.equal(a, join(root, "key-k1"));
	assert.equal(statSync(a).mode & 0o777, 0o700);
	writeFileSync(join(a, "note.txt"), "hello");
	assert.equal(ensureKeyFiles("k1", { root }), a, "idempotent");
	assert.equal(readFileSync(join(a, "note.txt"), "utf8"), "hello", "and never wipes what is there");
	assert.notEqual(ensureKeyFiles("k2", { root }), a);
	assert.equal(ensureKeyFiles("../../etc", { root }), join(root, "key-______etc"));

	// Size limit: none by default; frozen past a set one.
	assert.equal(keyFilesWritability(a, 0).writable, true);
	assert.equal(keyFilesWritability(a, 1000).writable, true);
	assert.match(keyFilesWritability(a, 3).reason, /over its limit \(5 of 3 bytes\)/);

	// Stats come from lstat alone: a link to something big counts as the link.
	const outside = join(root, "..", `pi-files-outside-${process.pid}`);
	writeFileSync(outside, Buffer.alloc(100_000));
	symlinkSync(outside, join(a, "big-link"));
	mkdirSync(join(a, "sub"));
	writeFileSync(join(a, "sub", "x.bin"), "abc");
	const st = keyFilesStats(a);
	assert.equal(st.created, true);
	assert.equal(st.files, 3, "note.txt, sub/x.bin and the link");
	assert.ok(st.bytes < 1000, "the link's target is never counted");
	assert.deepEqual(st.entries.map((e) => [e.name, e.type]), [["big-link", "link"], ["note.txt", "file"], ["sub", "dir"]]);
	assert.deepEqual(keyFilesStats(join(root, "nope")), { created: false, bytes: 0, files: 0, entries: [] });
	assert.equal(treeSize(join(a, "sub")), 3);
	rmSync(outside, { force: true });
	rmSync(root, { recursive: true, force: true });
}

// The empty mountpoint bwrap leaves in a workspace is not work: an otherwise untouched workspace is
// still deleted, and a real one is archived without it.
{
	const base = mkdtempSync(join(tmpdir(), "pi-mp-"));
	const root = join(base, "workspaces");
	const archive = `${root}-archive`;
	const ws = new WorkspaceManager(() => ({ root, archiveRoot: archive, policy: "archive", archiveTtlMs: 0 }));
	const idle = ws.create();
	mkdirSync(join(idle, "shared"));
	ws.release(idle);
	assert.equal(existsSync(idle), false, "only an empty mountpoint: deleted as untouched");
	assert.equal(existsSync(archive) ? readdirSync(archive).length : 0, 0, "and not archived");
	const busy = ws.create();
	mkdirSync(join(busy, "shared"));
	writeFileSync(join(busy, "work.txt"), "x");
	ws.release(busy);
	const [kept] = readdirSync(archive);
	assert.deepEqual(readdirSync(join(archive, kept)), ["work.txt"], "archived without the empty mountpoint");
	rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------- resumable chats

// Hibernate keeps a chat resumable; ending it does not. The stored row never holds the session id.
{
	const rows = new Map();
	const store = { get: (h) => rows.get(h) ?? null, put: (r) => rows.set(r.id_hash, { ...r }), delete: (h) => rows.delete(h), all: () => [...rows.values()] };
	const released = [];
	const dir = mkdtempSync(join(tmpdir(), "pi-resume-"));
	let made = 0;
	const workspaceStore = {
		create: () => { const w = join(dir, `ws${made++}`); mkdirSync(w); return w; },
		release: (w) => released.push(w),
	};
	const spent = [];
	let spawns = 0;
	const create = async (workspace, record) => {
		spawns++;
		return { resume: record.resume, getSessionStats: () => ({ cost: 0.01, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }), model: { provider: "p", id: "m" }, dispose() { spent.push(record.id); } };
	};
	const ctl = new SessionController({ create, maxSessions: 2, maxLifetimeMs: 1e9, idleMs: 1e9, sweepMs: 0, workspaces: workspaceStore, store });

	const first = ctl.acquire("key:1\u0000chat-a", { id: "k1" });
	first.record.state.forwarded = 4;
	first.record.state.lastUserText = "hello";
	await ctl.run(first.record, async () => {});
	const hash = chatIdHash("key:1\u0000chat-a");
	assert.equal(rows.get(hash).state_json, JSON.stringify({ forwarded: 4, lastUserText: "hello" }), "state is saved after every turn");
	assert.ok(![...rows.values()].some((r) => JSON.stringify(r).includes("chat-a")), "the session id itself is never stored");

	// Hibernate: process stopped, spend recorded, row and workspace kept.
	assert.equal(ctl.hibernate("key:1\u0000chat-a"), true);
	await first.record.stopped;
	assert.equal(ctl.size, 0);
	assert.ok(rows.has(hash), "a hibernated chat stays resumable");
	assert.deepEqual(released, [], "and keeps its workspace");
	assert.ok(ctl.liveWorkspaces().has(first.record.workspace), "the sweeper spares it");

	// The next request resumes it: same workspace, restored state, told to continue Pi's session.
	const back = ctl.acquire("key:1\u0000chat-a", { id: "k1" });
	assert.equal(back.isNew, false);
	assert.equal(back.resumed, true);
	assert.equal(back.record.workspace, first.record.workspace);
	assert.deepEqual(back.record.state, { forwarded: 4, lastUserText: "hello" }, "no transcript replay: the client's position is remembered");
	assert.equal(back.record.resume, true);
	assert.equal((await back.record.sessionPromise).resume, true, "the runner is asked to continue");
	assert.equal(back.record.createdAt, rows.get(hash).created_at, "its lifetime keeps counting from the original start");

	// Eviction hibernates too.
	ctl.acquire("key:1\u0000chat-b", { id: "k1" });
	ctl.acquire("key:1\u0000chat-c", { id: "k1" });
	assert.equal(ctl.size, 2);
	assert.equal(rows.size, 3, "the evicted chat is still stored");

	// Ending a chat deletes its row and releases its workspace.
	ctl.close("key:1\u0000chat-b");
	assert.equal(rows.has(chatIdHash("key:1\u0000chat-b")), false);
	assert.equal(released.length, 1);

	// A stored chat whose workspace has gone is started fresh.
	rows.set(chatIdHash("gone"), { id_hash: chatIdHash("gone"), key_id: null, workspace: join(dir, "nope"), created_at: 1, last_used_at: 1, requests: 3, state_json: "{}" });
	const fresh = ctl.acquire("gone", null);
	assert.equal(fresh.isNew, true);

	// Shutdown hibernates everything and waits for the spend to be recorded. Earlier stops settle first.
	await new Promise((r) => setTimeout(r, 20));
	const before = spent.length;
	const stopped = await ctl.hibernateAll();
	assert.ok(stopped >= 2);
	assert.equal(spent.length - before, stopped, "every live chat was stopped and billed");
	assert.equal(ctl.size, 0);

	// Stored chats expire by the same rules as live ones.
	const ctl2 = new SessionController({ create, maxSessions: 5, maxLifetimeMs: 1000, idleMs: 1e9, sweepMs: 0, workspaces: workspaceStore, store });
	const releasedBefore = released.length;
	ctl2.reap(Date.now() + 10_000);
	assert.equal(rows.size, 0, "past its lifetime, a hibernated chat is ended");
	assert.ok(released.length > releasedBefore, "and its workspace released");
	rmSync(dir, { recursive: true, force: true });
}

// Pi's own session record does not make a workspace worth archiving.
{
	const base = mkdtempSync(join(tmpdir(), "pi-piper-"));
	const root = join(base, "workspaces");
	const archive = `${root}-archive`;
	const ws = new WorkspaceManager(() => ({ root, archiveRoot: archive, policy: "archive", archiveTtlMs: 0 }));
	const oneOff = ws.create();
	mkdirSync(join(oneOff, ".piper", "session"), { recursive: true });
	writeFileSync(join(oneOff, ".piper", "session", "s.jsonl"), "{}");
	ws.release(oneOff);
	assert.equal(existsSync(oneOff), false, "only Pi's bookkeeping: deleted as untouched");
	assert.equal(existsSync(archive) ? readdirSync(archive).length : 0, 0);
	rmSync(base, { recursive: true, force: true });
}

// The catalogue notices when the operator's Pi configuration changes.
{
	const dir = mkdtempSync(join(tmpdir(), "pi-cat-"));
	const a = catalogueStamp(dir);
	writeFileSync(join(dir, "models.json"), "{}");
	const b = catalogueStamp(dir);
	assert.notEqual(a, b, "a new models.json changes the stamp");
	utimesSync(join(dir, "models.json"), new Date(), new Date(Date.now() + 5000));
	assert.notEqual(catalogueStamp(dir), b, "so does an edit");
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- visibility & control

// Tool activity: one readable line per tool call, never the content being written.
{
	// Optional and off unless switched on; the old "reasoning"/"off" values are not valid any more.
	const toolSpec = SETTINGS_SPEC.find((spec) => spec.key === "STREAM_TOOL_ACTIVITY");
	assert.equal(toolSpec.type, "bool");
	assert.equal(toolSpec.def, false, "tool output is off by default");
	assert.equal(coerceSetting(toolSpec, "on"), true);
	assert.throws(() => coerceSetting(toolSpec, "reasoning"));
	assert.equal(toolActivity("bash", { command: "ls -la\n  /workspace" }), "bash: ls -la /workspace");
	assert.equal(toolActivity("read", { path: "/workspace/a.txt" }), "read: /workspace/a.txt");
	assert.equal(toolActivity("grep", { path: "src", pattern: "TODO" }), "grep: src TODO");
	assert.equal(toolActivity("write", { path: "/workspace/big.txt", content: "x".repeat(10_000) }), "write: /workspace/big.txt", "the written content is never shown");
	assert.equal(toolActivity("analyze", { level: 2 }), 'analyze: {"level":2}');
	assert.ok(toolActivity("bash", { command: "y".repeat(500) }).length < 220, "long commands are truncated");
}

// Spend per model: a chat that switched models is billed to each for what it used there.
{
	const meter = newMeter();
	meterUsage(meter, { input: 10, output: 5, totalTokens: 15, cost: { total: 0.2 } }, "a/one");
	meterUsage(meter, { input: 1, output: 1, totalTokens: 2, cost: { total: 0.5 } }, "b/two");
	meterUsage(meter, { input: 4, output: 0, totalTokens: 4, cost: { total: 0.1 } }, "a/one");
	assert.equal(meter.byModel["a/one"].tokens.total, 19);
	assert.ok(Math.abs(meter.byModel["a/one"].cost - 0.3) < 1e-9);
	assert.equal(meter.byModel["b/two"].tokens.total, 2);
	assert.equal(meter.tokens.total, 21, "the total still covers everything");

	const fp = `per-model-${process.pid}`;
	recordSpend(
		{ id: fp, requests: 3, keyId: "pm-key" },
		{ getSessionStats: () => ({ cost: 0.8, tokens: meter.tokens, byModel: meter.byModel }), model: { provider: "b", id: "two" } },
	);
	const { DatabaseSync } = await import("node:sqlite");
	const rows = new DatabaseSync(TEST_DB).prepare("SELECT provider, model, cost, requests FROM spend WHERE key_id = 'pm-key' ORDER BY provider").all();
	assert.deepEqual(rows.map((r) => [r.provider, r.model, r.requests]), [["a", "one", 3], ["b", "two", 0]], "one row per model; requests counted once");
	assert.ok(Math.abs(rows[0].cost - 0.3) < 1e-9 && Math.abs(rows[1].cost - 0.5) < 1e-9);
}

// Model allow-lists: patterns, precedence, and the operator's key.
{
	assert.deepEqual(parseModelPatterns(""), []);
	assert.throws(() => parseModelPatterns("gpt-5"), /not a provider\/model pattern/);
	const m = (provider, id) => ({ provider, id });
	const { record } = apiKeys.create({ name: "limited-models" });
	assert.equal(modelAllowed(record.id, m("x", "y")), true, "no list: everything");
	apiKeys.update(record.id, { allowedModels: "local-openai/*, github-copilot/gpt-5-mini" });
	assert.equal(allowedModelsFor(record.id), "local-openai/*, github-copilot/gpt-5-mini");
	assert.equal(modelAllowed(record.id, m("local-openai", "Qwen/Qwen3-Next")), true, "a glob covers ids with slashes");
	assert.equal(modelAllowed(record.id, m("github-copilot", "gpt-5-mini")), true);
	assert.equal(modelAllowed(record.id, m("github-copilot", "gpt-5.4-mini")), false, "a dot in the pattern is literal");
	assert.equal(modelAllowed(record.id, m("anthropic", "claude")), false);
	assert.equal(modelAllowed("", m("anthropic", "claude")), true, "GATEWAY_API_KEY may use anything");
	apiKeys.update(record.id, { allowedModels: "broken" });
	assert.equal(modelAllowed(record.id, m("local-openai", "x")), false, "an unparseable list allows nothing rather than everything");
	apiKeys.remove(record.id);
}

// The shared-folder helper: streamed read and write, listing, deletion, and path safety.
{
	const { spawnSync } = await import("node:child_process");
	const helper = fileURLToPath(new URL("./piper-profile.mjs", import.meta.url));
	const dir = mkdtempSync(join(tmpdir(), "pi-fileapi-"));
	const run = (args, input) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, input });
	const payload = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251));
	const w = run(["raw", "write", "docs/data.bin", "0"], payload);
	assert.equal(w.status, 0, w.stderr.toString());
	assert.deepEqual(JSON.parse(w.stdout.toString()), { ok: true, bytes: 70_000 });
	const r = run(["raw", "read", "docs/data.bin"]);
	assert.equal(r.status, 0);
	assert.ok(Buffer.compare(r.stdout, payload) === 0, "the bytes come back identical");
	assert.equal(run(["raw", "write", "big.bin", "100"], Buffer.alloc(1000)).status, 5, "past the cap: refused");
	assert.equal(existsSync(join(dir, "big.bin")) || existsSync(join(dir, "big.bin.piper-upload")), false, "and nothing left behind");
	assert.equal(run(["raw", "read", "missing.txt"]).status, 4);
	assert.equal(run(["raw", "read", "docs"]).status, 3, "a folder is not a file");
	assert.equal(run(["raw", "read", "../../etc/passwd"]).status, 6, "no way out of the folder");
	// Paths are URL-style and always relative to the folder: a leading slash does not reach the host.
	assert.equal(run(["raw", "write", "/etc/x", "0"], "x").status, 0);
	assert.equal(readFileSync(join(dir, "etc", "x"), "utf8"), "x", "'/etc/x' lands inside the folder");
	rmSync(join(dir, "etc"), { recursive: true });
	// Links a session plants are never followed: not as the file, not as a folder on the way.
	const outside = mkdtempSync(join(tmpdir(), "pi-fileapi-outside-"));
	writeFileSync(join(outside, "secret"), "host secret");
	symlinkSync(join(outside, "secret"), join(dir, "file-link"));
	symlinkSync(outside, join(dir, "dir-link"));
	assert.equal(run(["raw", "read", "file-link"]).status, 3, "a link is not a file to serve");
	assert.equal(run(["raw", "read", "dir-link/secret"]).status, 6, "a linked folder is not a way out");
	assert.equal(run(["raw", "write", "dir-link/new", "0"], "x").status, 6);
	assert.equal(existsSync(join(outside, "new")), false, "nothing written through the link");
	assert.equal(JSON.parse(run([], JSON.stringify({ op: "files.list", path: "dir-link" })).stdout.toString()).ok, false);
	rmSync(join(dir, "file-link"));
	rmSync(join(dir, "dir-link"));
	rmSync(outside, { recursive: true });
	const list = (path) => JSON.parse(run([], JSON.stringify({ op: "files.list", path })).stdout.toString());
	assert.deepEqual(list("").result.map((e) => [e.name, e.type]), [["docs", "dir"]]);
	assert.equal(list("docs").result[0].bytes, 70_000);
	assert.equal(list("../").ok, false);
	const del = JSON.parse(run([], JSON.stringify({ op: "files.delete", path: "docs" })).stdout.toString());
	assert.equal(del.ok, true);
	assert.equal(existsSync(join(dir, "docs")), false);
	assert.equal(JSON.parse(run([], JSON.stringify({ op: "files.delete", path: "" })).stdout.toString()).ok, false, "the folder itself cannot be deleted");
	rmSync(dir, { recursive: true, force: true });
}

// Folder sizes are cached briefly, and forgotten when the gateway changes the folder.
{
	const dir = mkdtempSync(join(tmpdir(), "pi-size-"));
	writeFileSync(join(dir, "a"), "12345");
	const t0 = Date.now();
	assert.equal(cachedTreeSize(dir, { now: t0 }), 5);
	writeFileSync(join(dir, "b"), "123");
	assert.equal(cachedTreeSize(dir, { now: t0 + 1000 }), 5, "within the TTL the cached figure is used");
	assert.equal(cachedTreeSize(dir, { now: t0 + 60_000 }), 8, "after it, the folder is walked again");
	writeFileSync(join(dir, "c"), "1");
	invalidateSize(dir);
	assert.equal(cachedTreeSize(dir, { now: t0 + 60_001 }), 9, "an invalidation takes effect at once");
	rmSync(dir, { recursive: true, force: true });
}

console.log("nextTurn + images: ok");
rmSync(TEST_DB, { force: true });
rmSync(TEST_WS, { recursive: true, force: true });
rmSync(`${TEST_WS}-archive`, { recursive: true, force: true });
rmSync(`${TEST_WS}-run`, { recursive: true, force: true });
rmSync(TEST_PROFILES, { recursive: true, force: true });
rmSync(TEST_SHARED, { recursive: true, force: true });
rmSync(TEST_FILES, { recursive: true, force: true });
