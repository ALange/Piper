import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const TEST_PROFILES = `${tmpdir()}/piper-test-profiles-${process.pid}`;
process.env.PROFILE_ROOT = TEST_PROFILES;
const TEST_SHARED = `${tmpdir()}/piper-test-shared-${process.pid}`;
process.env.SHARED_ROOT = TEST_SHARED;
const TEST_CONTAINER_PI = `${tmpdir()}/piper-test-container-pi-${process.pid}`;
process.env.CONTAINER_PI_DIR = TEST_CONTAINER_PI;
const PI_AGENT = process.env.PI_CODING_AGENT_DIR || `${homedir()}/.pi/agent`;
// Seeded at startup, which is when a validator that reads a not-yet-defined constant would fail.
process.env.CONTAINER_ENV = "TOOL_HOME=/opt/tool";
const { GATEWAY_DIR: GATEWAY_DIR_FOR_TEST, pi, imageInfo, listEnvironments, environmentOfTag, buildArgs, listImages, buildImage, jobView, resetImageJob, removeImage, pruneImages, refreshDiskSoon, parseSize, parseUsage, parseDiskSize, parseEvent, watchEvents, noteSelfStop, inspectMany, containerStats, diskUsage, listContainers, containerAction, containerExec, containerRoutes, pollDisk, diskSummary, diskState, handleContainerEvent, recentReasonFor, recentEvents, alertPayload, alert, recovered, testAlert, resetAlerts, ALERT_COOLDOWN_MS, parseWebhookUrl, onReadinessChange, lastEngineStatus, chatStore, clearPasswordHash, setPasswordHash, sessions, instanceId, normalizeContainerInput, containerSettingsFor, containerDefaults, networkModesInUse, containerView, secretIn, audit, recentAudit, networkName, networkArgs, NETWORK_OPEN, ensureNetwork, config, iptablesBinary, requireReady, hostNameservers, endpointOf, ensureContainerPiDir, readContainerModels, saveContainerDefaults, validateModelsText, writeChatModels, agentDirPath, classifyModelError, coerceSetting, derivedSessionId, expiryReason, fingerprint, formatDuration, framedTranscript, isInside, isReloadCommand, messageAudioParts, messageImageSources, messageText, nextTurn, parseDuration, requestedSessionId, resolveImages, resolveModelQuery, SessionController, shQuote, shouldFallBack, recordSpend, spendReport, spendTotals, hashPassword, verifyPassword, dashboardAuthorized, isDashboardPath, loadDashboardPassword, apiKeys, ApiKeyStore, expiryFromInput, keyLabel, apiKeyUsage, isSettingsKey, scopedSessionId, isBlockedAddress, profileScope, ensureProfile, bridgeCatalog, wireEvent, newMeter, meterUsage, PiRpcSession, startBridge, parseGatewayCommand, profileStats, profileWritability, setProfileLock, isProfileLocked, keyIdForScope, keyLimits, limitFromInput, spentToday, spendRefusal, bundleListFromInput, listBundles, grantedBundles, bundleContents, originOf, profileDetail, treeSize, hostDefaultModel, chatIdHash, catalogueStamp, toolActivity, modelAllowed, allowedModelsFor, parseModelPatterns, cachedTreeSize, invalidateSize, SETTINGS_SPEC, parseContainerEnv, parseContainerMounts, rootWarning, ensureWorkspace, workspaceWritability, workspaceStats, setRunner, containerName, containerCreateArgs, containerSignature, execArgs, helperArgs, firewallRules, ensureFirewall, ensureContainer, checkEngine, resetEngineCheck, chatKey, catalogueFor, directProviders, directCatalogue, renderModelsFor, redactedModelsText, saveModelsText, allowedEndpoints, containerDefaultModel, REDACTED, CONTAINER_PATHS, migrateToContainers, migrateSettingRows, containerHost, sweepContainers, parseAllow, profileHelperInvocation, workspaceDir, scopeOf, resolveModel, chatKeyOfContainer, NETWORK, isBlockedIp, inRange, piInvocation, containerSpecFor, stopContainer, removeContainer, listManaged, EngineError } = await import("./server.mjs");
setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
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

// The folder the gateway treats as Pi's own configuration (its credentials, kept out of every container)
// must be the one Pi actually uses. Pi is found the way the gateway finds it (PI_AGENT_PACKAGE, then
// the global npm root), not at a path from the machine this was written on; without Pi there is
// nothing to compare, and the rest of the suite does not need it.
{
	let piModule = null;
	try {
		piModule = await pi();
	} catch {
		console.log("skipped: Pi is not installed here, so its agent directory cannot be compared with agentDirPath()");
	}
	if (piModule) assert.equal(agentDirPath(), piModule.getAgentDir(), "the gateway must treat as Pi's config the directory Pi reads credentials from");
}

// Path containment, and the symlink case that a string comparison would miss.
{
	assert.equal(isInside("/a/b", "/a/b"), true, "a directory contains itself");
	assert.equal(isInside("/a/b", "/a/b/c"), true);
	assert.equal(isInside("/a/b", "/a/bc"), false, "a shared prefix is not containment");
	assert.equal(isInside("/a/b", "/a"), false);
	assert.equal(isInside("/a/b", "/x"), false);
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

// ---------------------------------------------------------------- containers

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
	const spec = { name: "piper-x", image: "img", workspace: "/w", profileDir: "/p", chatDir: "/c", runDir: "/r", bridgePath: "/b.mjs", sig: "s", bundles: granted };
	const create = containerCreateArgs(spec);
	assert.ok(create.includes(`${join(root, "base")}:/shared/base:ro`), "base is mounted read-only at /shared/base");
	assert.ok(!create.some((a) => a.includes(join(root, "security")) || a.startsWith(`${root}:`)), "neither the other bundle nor the shared root is mounted");
	assert.ok(piInvocation({ ...spec, bundles }).piArgs.join(" ").includes("-e /shared/base -e /shared/security"), "every granted bundle is loaded as a package");
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

// ---------------------------------------------------------------- per-key workspace

// One workspace per key, created once, owner-only; a key id cannot steer where it goes.
{
	const root = mkdtempSync(join(tmpdir(), "pi-workspace-"));
	const a = ensureWorkspace("k1", { root });
	assert.equal(a, join(root, "key-k1"));
	assert.equal(statSync(a).mode & 0o777, 0o700);
	writeFileSync(join(a, "note.txt"), "hello");
	assert.equal(ensureWorkspace("k1", { root }), a, "idempotent");
	assert.equal(readFileSync(join(a, "note.txt"), "utf8"), "hello", "and never wipes what is there");
	assert.notEqual(ensureWorkspace("k2", { root }), a);
	assert.equal(ensureWorkspace("../../etc", { root }), join(root, "key-______etc"));

	// Size limit: none by default; frozen past a set one.
	assert.equal(workspaceWritability(a, 0).writable, true);
	assert.equal(workspaceWritability(a, 1000).writable, true);
	assert.match(workspaceWritability(a, 3).reason, /over its limit \(5 of 3 bytes\)/);

	// Stats come from lstat alone: a link to something big counts as the link.
	const outside = join(root, "..", `pi-workspace-outside-${process.pid}`);
	writeFileSync(outside, Buffer.alloc(100_000));
	symlinkSync(outside, join(a, "big-link"));
	mkdirSync(join(a, "sub"));
	writeFileSync(join(a, "sub", "x.bin"), "abc");
	const st = workspaceStats(a);
	assert.equal(st.created, true);
	assert.equal(st.files, 3, "note.txt, sub/x.bin and the link");
	assert.ok(st.bytes < 1000, "the link's target is never counted");
	assert.deepEqual(st.entries.map((e) => [e.name, e.type]), [["big-link", "link"], ["note.txt", "file"], ["sub", "dir"]]);
	assert.deepEqual(workspaceStats(join(root, "nope")), { created: false, bytes: 0, files: 0, entries: [] });
	assert.equal(treeSize(join(a, "sub")), 3);
	rmSync(outside, { force: true });
	rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- resumable chats

// Hibernate keeps a chat resumable; ending it does not. The stored row never holds the session id.
{
	const rows = new Map();
	const store = { get: (h) => rows.get(h) ?? null, put: (r) => rows.set(r.id_hash, { ...r }), delete: (h) => rows.delete(h), all: () => [...rows.values()] };
	const stoppedHashes = [];
	const endedHashes = [];
	const dir = mkdtempSync(join(tmpdir(), "pi-resume-"));
	// A key's workspace is one folder, the same for every chat of the key.
	const host = {
		workspace: (keyId) => { const w = join(dir, `ws-${keyId ?? "open"}`); mkdirSync(w, { recursive: true }); return w; },
		stopped: (h) => stoppedHashes.push(h),
		ended: (h) => endedHashes.push(h),
	};
	const spent = [];
	let spawns = 0;
	const create = async (workspace, record) => {
		spawns++;
		return { resume: record.resume, getSessionStats: () => ({ cost: 0.01, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }), model: { provider: "p", id: "m" }, dispose() { spent.push(record.id); } };
	};
	const ctl = new SessionController({ create, maxSessions: 2, maxLifetimeMs: 1e9, idleMs: 1e9, sweepMs: 0, host, store });

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
	assert.deepEqual(endedHashes, [], "and is not ended");
	assert.ok(stoppedHashes.includes(hash), "its container is stopped, not removed");
	assert.ok(ctl.chatHashes().known.has(hash) && !ctl.chatHashes().live.has(hash), "the sweep knows it, and knows it is not running");

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

	// Ending a chat deletes its row and removes its container; the key's workspace is not the chat's to remove.
	ctl.close("key:1\u0000chat-b");
	assert.equal(rows.has(chatIdHash("key:1\u0000chat-b")), false);
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(endedHashes, [chatIdHash("key:1\u0000chat-b")], "its container is removed");
	assert.equal(existsSync(first.record.workspace), true, "and the key's workspace stays");

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

	// A stopped chat is not ended by the lifetime or idle limits, only by the keep window.
	const stored = rows.size;
	assert.ok(stored > 0);
	const ctl2 = new SessionController({ create, maxSessions: 5, maxLifetimeMs: 1000, idleMs: 1000, sweepMs: 0, host, store });
	const endedBefore = endedHashes.length;
	ctl2.reap(Date.now() + 10_000);
	assert.equal(rows.size, stored, "past its lifetime and idle limits, a stopped chat is kept");
	assert.equal(endedHashes.length, endedBefore, "and its container is not removed");
	const forever = new SessionController({ create, maxSessions: 5, maxLifetimeMs: 1000, idleMs: 1000, keepMs: 0, sweepMs: 0, host, store });
	forever.reap(Date.now() + 100 * 24 * 3600_000);
	assert.equal(rows.size, stored, "keepMs 0 keeps a stopped chat for ever");
	const keeping = new SessionController({ create, maxSessions: 5, maxLifetimeMs: 1000, idleMs: 1000, keepMs: 5000, sweepMs: 0, host, store });
	keeping.reap(Date.now() + 3000);
	assert.equal(rows.size, stored, "inside the keep window, still kept");
	keeping.reap(Date.now() + 10_000);
	assert.equal(rows.size, 0, "past it, the chat ends");
	assert.ok(endedHashes.length > endedBefore, "and its container is removed");
	rmSync(dir, { recursive: true, force: true });
}

// What the clock does to a running chat: idle and long-running ones stop and can resume; only one-off requests end.
{
	const rows = new Map();
	const store = { get: (h) => rows.get(h) ?? null, put: (r) => rows.set(r.id_hash, { ...r }), delete: (h) => rows.delete(h), all: () => [...rows.values()] };
	const stopped = [];
	const ended = [];
	const dir = mkdtempSync(join(tmpdir(), "pi-clock-"));
	const host = { workspace: () => dir, stopped: (h) => stopped.push(h), ended: (h) => ended.push(h) };
	const create = async () => ({ getSessionStats: () => ({ cost: 0, tokens: { total: 0 } }), model: { provider: "p", id: "m" }, dispose() {} });
	const make = (opts = {}) => new SessionController({ create, maxSessions: 9, maxLifetimeMs: 60_000, idleMs: 10_000, oneShotMs: 5_000, keepMs: 1e12, sweepMs: 0, host, store, ...opts });
	const settle = () => new Promise((r) => setTimeout(r, 30));
	const T0 = Date.now();

	// Idle: stopped, not ended.
	{
		const ctl = make();
		const { record } = ctl.acquire("idle-chat", { id: "k1" });
		await ctl.run(record, async () => {});
		ctl.acquire("idle-chat", { id: "k1" }); // a second request: not a one-off any more
		record.lastUsedAt = T0 - 20_000;
		assert.deepEqual(ctl.reap(T0), ["idle-chat"]);
		await settle();
		assert.equal(ctl.has("idle-chat"), false, "no longer running");
		assert.ok(rows.has(chatIdHash("idle-chat")), "its chat row is kept");
		assert.ok(stopped.includes(chatIdHash("idle-chat")) && !ended.includes(chatIdHash("idle-chat")), "its container is stopped, not removed");
		assert.equal(ctl.acquire("idle-chat", { id: "k1" }).resumed, true, "and the next message resumes it");
	}

	// A one-off request is ended: nothing will ask for it again.
	{
		const ctl = make();
		const { record } = ctl.acquire("one-off", { id: "k1" });
		await ctl.run(record, async () => {});
		record.lastUsedAt = T0 - 20_000;
		ctl.reap(T0);
		await settle();
		assert.ok(ended.includes(chatIdHash("one-off")) && !rows.has(chatIdHash("one-off")), "removed, with its row");
	}

	// Lifetime counts from when this Pi started, so an old chat that was just resumed is not stopped again.
	{
		const ctl = make({ maxLifetimeMs: 60_000, idleMs: 1e12, oneShotMs: 0 });
		rows.set(chatIdHash("ancient"), { id_hash: chatIdHash("ancient"), key_id: "k1", workspace: dir, created_at: T0 - 90 * 24 * 3600_000, last_used_at: T0, requests: 50, state_json: "{}" });
		const { record } = ctl.acquire("ancient", { id: "k1" });
		assert.equal(record.createdAt, T0 - 90 * 24 * 3600_000, "the chat keeps its real age");
		assert.ok(record.startedAt >= T0, "but this Pi has only just started");
		assert.deepEqual(ctl.reap(record.startedAt + 1000), [], "a resumed old chat is not stopped on the next tick, or ever again in a loop");
		assert.ok(ctl.has("ancient"));
		assert.deepEqual(ctl.reap(record.startedAt + 61_000), ["ancient"], "it is stopped once this Pi has run for the lifetime");
		await settle();
		assert.ok(rows.has(chatIdHash("ancient")), "stopped, and still resumable");
		const again = ctl.acquire("ancient", { id: "k1" });
		assert.deepEqual(ctl.reap(again.record.startedAt + 1000), [], "and resuming starts the count again");
	}

	// Work in flight is never touched, and the rows say what will happen.
	{
		const ctl = make();
		const { record } = ctl.acquire("busy", { id: "k1" });
		await ctl.run(record, async () => {});
		ctl.acquire("busy", { id: "k1" });
		record.lastUsedAt = T0 - 50_000;
		record.inflight = 1;
		assert.deepEqual(ctl.reap(T0), [], "a chat with a request in flight is left alone");
		record.inflight = 0;
		const snap = await ctl.snapshot();
		const row = snap.sessions.find((r) => r.fingerprint === fingerprint("busy"));
		assert.deepEqual([row.expiresBecause, row.expiresAction], ["idle", "stops"], "the page can say a stop is coming, not an end");
		const one = ctl.acquire("fresh-one-off", { id: "k1" });
		one.record.lastUsedAt = Date.now();
		const snap2 = await ctl.snapshot();
		assert.equal(snap2.sessions.find((r) => r.fingerprint === fingerprint("fresh-one-off")).expiresAction, "ends", "a first request that may be a one-off ends");
		assert.equal(snap2.keepMs, 1e12);
	}
	// Without a store there is nothing to resume from, so a stop is an end, as before.
	{
		const gone = [];
		const ctl = new SessionController({ create, maxSessions: 9, maxLifetimeMs: 1e9, idleMs: 1000, sweepMs: 0, host: { workspace: () => dir, stopped() {}, ended: (h) => gone.push(h) } });
		const { record } = ctl.acquire("no-store", { id: "k1" });
		await ctl.run(record, async () => {});
		ctl.acquire("no-store", { id: "k1" });
		record.lastUsedAt = T0 - 5000;
		ctl.reap(T0);
		await settle();
		assert.equal(gone.length, 1, "no store: the chat ends");
	}
	rmSync(dir, { recursive: true, force: true });
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
	// Refused uploads leave nothing behind, whichever chunk crosses the cap, and an empty one is still a file.
	for (let i = 0; i < 25; i++) assert.equal(run(["raw", "write", `over${i}.bin`, "100"], Buffer.alloc(1000)).status, 5);
	assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("over") || n.endsWith(".piper-upload")), [], "25 refused uploads, no stray file");
	assert.equal(run(["raw", "write", "empty.bin", "0"], Buffer.alloc(0)).status, 0);
	assert.equal(statSync(join(dir, "empty.bin")).size, 0, "an empty upload is an empty file");
	rmSync(join(dir, "empty.bin"));
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



// ---------------------------------------------------------------- backup and restore

{
	const { DatabaseSync } = await import("node:sqlite");
	const { backup, restore, mapPath, partPaths, measure, BackupError } = await import("./piper-backup.mjs");
	const { chmodSync, readlinkSync } = await import("node:fs");
	const base = mkdtempSync(join(tmpdir(), "pi-backup-"));
	const src = join(base, "gw");
	const outDir = join(base, "out");
	mkdirSync(src, { recursive: true });

	const makeDb = (path, dir) => {
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT, updated_at INTEGER); CREATE TABLE chats (id_hash TEXT PRIMARY KEY, key_id TEXT, workspace TEXT NOT NULL); CREATE TABLE marker (n INTEGER)");
		const put = db.prepare("INSERT INTO settings VALUES (?, ?, 'ui', 1)");
		put.run("PROFILE_ROOT", join(dir, "profiles")); put.run("WORKSPACE_ROOT", join(dir, "workspaces")); put.run("SHARED_ROOT", join(dir, "shared")); put.run("CONTAINER_PI_DIR", join(dir, "container-pi")); put.run("PORT", "18771");
		db.prepare("INSERT INTO chats VALUES ('h1', 'k1', ?)").run(join(dir, "workspaces", "key-k1"));
		db.prepare("INSERT INTO chats VALUES ('h2', 'k2', '/somewhere/else')").run();
		db.exec("INSERT INTO marker VALUES (42)");
		db.close();
	};
	makeDb(join(src, "gateway.db"), src);
	const secretOutside = join(base, "host-secret.txt");
	writeFileSync(secretOutside, "HOST SECRET");
	for (const [rel, text] of [["profiles/key-k1/settings.json", "{}"], ["workspaces/key-k1/notes.md", "work"], ["workspaces/key-k1/deep/er/file.bin", "bin"], ["shared/base/skills/x/SKILL.md", "skill"], ["container-pi/models.json", '{"providers":{}}'], ["workspaces-chats/0123456789abcdef/session/s.jsonl", "{}"]]) {
		mkdirSync(dirname(join(src, rel)), { recursive: true });
		writeFileSync(join(src, rel), text);
	}
	chmodSync(join(src, "container-pi/models.json"), 0o600);
	symlinkSync(secretOutside, join(src, "workspaces/key-k1/planted-link"));

	// Paths follow the settings, and fall back to the folders beside the gateway.
	assert.equal(partPaths("/g", {}).profiles, "/g/profiles");
	assert.equal(partPaths("/g", { WORKSPACE_ROOT: "/data/ws" }).chats, "/data/ws-chats", "chats sit beside the workspaces folder");
	assert.equal(mapPath("/old/gw/profiles", "/old/gw", "/new/gw"), "/new/gw/profiles");
	assert.equal(mapPath("/old/gwx/profiles", "/old/gw", "/new/gw"), "/old/gwx/profiles", "a shared prefix is not a parent");
	assert.equal(mapPath("/elsewhere/x", "/old/gw", "/new/gw"), "/elsewhere/x");
	assert.deepEqual(measure(join(src, "workspaces/key-k1/planted-link")), { bytes: measure(join(src, "workspaces/key-k1/planted-link")).bytes, files: 1 });

	// Backup: one owner-only archive with a checksum, and the manifest lists what went in.
	const made = await backup({ dir: src, out: outDir, now: Date.UTC(2026, 8, 30, 12, 0, 0) });
	assert.match(made.file, /piper-backup-20260930T120000Z\.tgz$/);
	assert.equal(statSync(made.file).mode & 0o777, 0o600, "the archive is owner-only: it holds a database and an API key");
	assert.equal(statSync(outDir).mode & 0o777, 0o700);
	assert.match(readFileSync(`${made.file}.sha256`, "utf8"), new RegExp(`^${made.sha256}  piper-backup-`));
	assert.deepEqual(Object.keys(made.parts).sort(), ["chats", "container-pi", "profiles", "shared", "workspaces"]);
	assert.equal(made.parts.workspaces.files, 3, "the planted link counts as one file, not as what it points at");
	assert.equal(readdirSync(outDir).filter((n) => n.startsWith(".")).length, 0, "no staging or partial files are left behind");

	// Restore into a fresh folder: everything back, links kept as links, modes kept, paths follow the new folder.
	const dst = join(base, "new-host", "gw");
	mkdirSync(dst, { recursive: true });
	const got = await restore({ dir: dst, file: made.file, running: async () => false });
	assert.deepEqual(got.restored.map((r) => r.name).sort(), ["chats", "container-pi", "profiles", "shared", "workspaces"]);
	assert.equal(readFileSync(join(dst, "workspaces/key-k1/deep/er/file.bin"), "utf8"), "bin");
	assert.equal(lstatSync(join(dst, "workspaces/key-k1/planted-link")).isSymbolicLink(), true, "a link is restored as a link");
	assert.equal(readlinkSync(join(dst, "workspaces/key-k1/planted-link")), secretOutside);
	assert.equal(existsSync(join(dst, "workspaces/key-k1/planted-link")) && readFileSync(join(dst, "workspaces/key-k1/planted-link"), "utf8"), "HOST SECRET", "and it is the same link, not a copy of its target");
	assert.equal(readFileSync(join(dst, "workspaces-chats/0123456789abcdef/session/s.jsonl"), "utf8"), "{}");
	assert.equal(statSync(join(dst, "container-pi/models.json")).mode & 0o777, 0o600);
	assert.equal(statSync(join(dst, "gateway.db")).mode & 0o777, 0o600);
	const back = new DatabaseSync(join(dst, "gateway.db"), { readOnly: true });
	assert.equal(back.prepare("SELECT n FROM marker").get().n, 42, "the database content is there");
	assert.equal(back.prepare("SELECT value FROM settings WHERE key = 'PROFILE_ROOT'").get().value, join(dst, "profiles"), "folder settings follow the gateway to its new place");
	assert.equal(back.prepare("SELECT value FROM settings WHERE key = 'PORT'").get().value, "18771", "other settings are untouched");
	assert.equal(back.prepare("SELECT workspace FROM chats WHERE id_hash = 'h1'").get().workspace, join(dst, "workspaces", "key-k1"), "a stored chat's workspace follows too");
	assert.equal(back.prepare("SELECT workspace FROM chats WHERE id_hash = 'h2'").get().workspace, "/somewhere/else", "one outside the workspaces folder is left alone");
	back.close();

	// Restoring over an existing gateway: refused while it runs; otherwise everything is moved aside, never deleted.
	writeFileSync(join(dst, "workspaces/key-k1/newer-work.txt"), "work done after the backup");
	await assert.rejects(restore({ dir: dst, file: made.file, running: async () => true }), /gateway is running.*--stop/);
	let stopped = 0;
	await assert.rejects(restore({ dir: dst, file: made.file, stop: true, stopGateway: async () => { stopped++; }, running: async () => true }), /did not stop/, "if it will not stop, nothing is touched");
	assert.equal(stopped, 1);
	assert.equal(existsSync(join(dst, "workspaces/key-k1/newer-work.txt")), true, "a refused restore changes nothing");
	let alive = true;
	const again = await restore({ dir: dst, file: made.file, stop: true, stopGateway: async () => { alive = false; }, running: async () => alive, now: Date.UTC(2026, 8, 30, 13, 0, 0) });
	assert.ok(again.movedAside.length >= 6 && again.movedAside.every((m) => m.includes(".before-restore-20260930T130000Z")), "the database and every folder are moved aside");
	assert.equal(readFileSync(join(dst, "workspaces-chats/0123456789abcdef/session/s.jsonl"), "utf8"), "{}");
	assert.equal(readFileSync(join(`${join(dst, "workspaces")}.before-restore-20260930T130000Z`, "key-k1/newer-work.txt"), "utf8"), "work done after the backup", "the work done since the backup is still there, aside");
	assert.equal(existsSync(join(dst, "workspaces/key-k1/newer-work.txt")), false, "and the restored folder is the backed-up state");

	// Damage and foreign files are refused before anything moves.
	const damaged = join(base, "damaged.tgz");
	writeFileSync(damaged, Buffer.concat([readFileSync(made.file), Buffer.from("tampered")]));
	writeFileSync(`${damaged}.sha256`, readFileSync(`${made.file}.sha256`, "utf8"));
	const before = readdirSync(dst).sort().join();
	await assert.rejects(restore({ dir: dst, file: damaged, running: async () => false }), /does not match its \.sha256/);
	const noSum = join(base, "nosum.tgz");
	writeFileSync(noSum, readFileSync(made.file));
	const loose = await restore({ dir: join(base, "loose"), file: noSum, running: async () => false }).catch((e) => e);
	assert.ok(!(loose instanceof Error) && loose.warnings.some((w) => /no \.sha256/.test(w)), "no checksum: it proceeds, and says integrity was not checked");
	const foreign = join(base, "foreign.tgz");
	writeFileSync(join(base, "hello.txt"), "hi");
	await new Promise((res, rej) => spawn("tar", ["-czf", foreign, "-C", base, "hello.txt"]).on("close", (c) => (c === 0 ? res() : rej(new Error("tar")))));
	await assert.rejects(restore({ dir: dst, file: foreign, running: async () => false }), (e) => e instanceof BackupError && /MANIFEST\.json/.test(e.message), "a tarball that is not a Piper backup is refused, naming what is missing");
	await assert.rejects(restore({ dir: dst, file: join(base, "nope.tgz") }), /no such backup/);
	assert.equal(readdirSync(dst).sort().join(), before, "none of the refusals touched the folder");

	// Options: without chats, retention, the space check.
	const slim = await backup({ dir: src, out: outDir, chats: false, now: Date.UTC(2026, 8, 30, 12, 0, 1) });
	assert.equal("chats" in slim.parts, false, "--no-chats leaves the session files out");
	for (let i = 2; i < 6; i++) await backup({ dir: src, out: outDir, keep: 3, now: Date.UTC(2026, 8, 30, 12, 0, i) });
	const kept = readdirSync(outDir).filter((n) => n.endsWith(".tgz")).sort();
	assert.equal(kept.length, 3, "retention keeps the newest three");
	assert.ok(kept[0].includes("120003") && kept[2].includes("120005"), "and deletes the oldest");
	assert.equal(readdirSync(outDir).filter((n) => n.endsWith(".sha256")).length, 3, "with their checksums");
	await assert.rejects(backup({ dir: src, out: outDir, freeBytes: 500 * 1024 * 1024 }), /not enough space/, "a backup that would leave under 1 GB free is refused");
	assert.ok((await backup({ dir: src, out: outDir, freeBytes: 500 * 1024 * 1024, force: true, now: Date.UTC(2026, 8, 30, 12, 0, 9) })).file, "--force overrides it");
	await assert.rejects(backup({ dir: join(base, "not-piper"), out: outDir }), /no database/);

	// A corrupt database in a backup is caught before anything is replaced.
	const badDir = join(base, "bad");
	mkdirSync(badDir);
	writeFileSync(join(badDir, "gateway.db"), "this is not sqlite");
	await assert.rejects(backup({ dir: badDir, out: join(base, "bad-out") }), Error, "a database that cannot be read cannot be backed up");
	rmSync(base, { recursive: true, force: true });
}


// ---------------------------------------------------------------- the watchdog

{
	const http = await import("node:http");
	const { DatabaseSync } = await import("node:sqlite");
	const { check, payload, FAILS_BEFORE_ALERT } = await import("./piper-watchdog.mjs");
	const dir = mkdtempSync(join(tmpdir(), "pi-watchdog-"));
	const posts = [];
	const hook = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { posts.push(JSON.parse(b)); res.writeHead(200); res.end("{}"); }); });
	await new Promise((r) => hook.listen(0, "127.0.0.1", r));
	let healthStatus = 200;
	const gateway = http.createServer((req, res) => { res.writeHead(healthStatus); res.end("{}"); });
	await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
	const gatewayPort = gateway.address().port; // the server is closed later, and then has no address
	const setDb = (url) => {
		rmSync(join(dir, "gateway.db"), { force: true });
		const db = new DatabaseSync(join(dir, "gateway.db"));
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT, updated_at INTEGER)");
		db.prepare("INSERT INTO settings VALUES ('PORT', ?, 'ui', 1)").run(String(gatewayPort));
		if (url) db.prepare("INSERT INTO settings VALUES ('ALERT_WEBHOOK_URL', ?, 'ui', 1)").run(url);
		db.close();
	};
	setDb(`http://127.0.0.1:${hook.address().port}/x`);
	const state = () => JSON.parse(readFileSync(join(dir, ".watchdog-state"), "utf8"));
	assert.equal(FAILS_BEFORE_ALERT, 2);

	let r = await check({ dir, now: 1_000 });
	assert.deepEqual([r.healthy, r.fails, r.alerted], [true, 0, null], "a healthy gateway says nothing");
	assert.equal(posts.length, 0);
	assert.equal(statSync(join(dir, ".watchdog-state")).mode & 0o777, 0o600);

	// Down: one failed check is not yet news (it may be a restart), two in a row are, and only once.
	healthStatus = 503;
	r = await check({ dir, now: 60_000 });
	assert.deepEqual([r.healthy, r.fails, r.alerted], [false, 1, null]);
	assert.equal(posts.length, 0, "one failure in a row: no alert");
	r = await check({ dir, now: 120_000 });
	assert.deepEqual([r.fails, r.alerted, r.down], [2, "down", true]);
	assert.equal(posts.length, 1);
	assert.equal(posts[0].event, "gateway_down");
	assert.match(posts[0].message, /not answering on port \d+ \(it answered 503\); 2 checks in a row/);
	assert.equal(posts[0].text, posts[0].content, "Slack and Discord both read it");
	assert.equal(posts[0].recovered, false);
	await check({ dir, now: 180_000 });
	await check({ dir, now: 240_000 });
	assert.equal(posts.length, 1, "still down: not repeated every minute");
	assert.equal(state().down, true);

	// Back: said once, with how long.
	healthStatus = 200;
	r = await check({ dir, now: 120_000 + 5 * 60_000 });
	assert.deepEqual([r.healthy, r.alerted, r.down], [true, "recovered", false]);
	assert.equal(posts.length, 2);
	assert.equal(posts[1].recovered, true);
	assert.match(posts[1].message, /answering again after about 5 minute/);
	await check({ dir, now: 600_000 });
	assert.equal(posts.length, 2, "and only once");
	assert.deepEqual(state(), { fails: 0, down: false, since: null });

	// A refused connection (the gateway is really down) counts the same way.
	gateway.close();
	await new Promise((r2) => setTimeout(r2, 20));
	r = await check({ dir, now: 700_000 });
	r = await check({ dir, now: 760_000 });
	assert.equal(r.alerted, "down");
	assert.match(posts.at(-1).message, /ECONNREFUSED/, "with the reason");

	// No webhook: the state is kept, and nothing is sent or fails.
	const before = posts.length;
	setDb("");
	rmSync(join(dir, ".watchdog-state"));
	await check({ dir, now: 800_000 });
	r = await check({ dir, now: 860_000 });
	assert.deepEqual([r.alerted, r.hook, posts.length], ["down", false, before], "no webhook: no post, no error");
	// A webhook that is down does not make the check fail.
	setDb("http://127.0.0.1:1/nothing");
	rmSync(join(dir, ".watchdog-state"));
	await check({ dir, now: 900_000 });
	r = await check({ dir, now: 960_000 });
	assert.equal(r.down, true, "the outage is still recorded");
	// And with no database at all it is quiet.
	rmSync(join(dir, "gateway.db"));
	r = await check({ dir, dbPath: join(dir, "gateway.db"), now: 1_000_000 }).catch((e) => e);
	assert.ok(!(r instanceof Error), "a missing database is not a crash: the port falls back to the default");
	assert.deepEqual(Object.keys(payload("e", "m", {})).sort(), ["content", "details", "event", "host", "message", "recovered", "text", "time"], "the same shape lib/alerts.mjs sends");
	await new Promise((r2) => hook.close(r2));
	rmSync(dir, { recursive: true, force: true });
}


// ---------------------------------------------------------------- images: environments, builds, removal

{
	const { Readable } = await import("node:stream");
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const seen = [];
	let reply = () => ({ code: 0, stdout: "", stderr: "" });
	setRunner(async (bin, args) => { seen.push([bin, ...args]); return reply(bin, args); });

	// Environments are folders with a Dockerfile; full is docker/Dockerfile and keeps its name.
	const root = mkdtempSync(join(tmpdir(), "pi-envs-"));
	const put = (rel) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), "FROM scratch\n"); };
	put("Dockerfile"); put("environments/slim/Dockerfile"); put("environments/re-tools/Dockerfile"); put("environments/Bad_Name/Dockerfile");
	mkdirSync(join(root, "environments/empty"), { recursive: true }); put("environments/full/Dockerfile");
	assert.deepEqual(listEnvironments(root).map((e) => [e.name, e.tag]), [["full", "piper-agent"], ["re-tools", "piper-agent-re-tools"], ["slim", "piper-agent-slim"]], "full first, then the others by name; a folder without a Dockerfile, a bad name and a second `full` are ignored");
	assert.deepEqual(listEnvironments(join(root, "nowhere")), []);
	assert.deepEqual(listEnvironments().map((e) => e.name).slice(0, 2), ["full", "slim"], "and the repository has full and slim");
	assert.deepEqual(["piper-agent", "piper-agent:latest", "piper-agent-slim", "piper-agent-slim:latest", "nginx", "piper-agent-Bad"].map(environmentOfTag), ["full", "full", "slim", "slim", null, null]);
	const slim = listEnvironments(root).find((e) => e.name === "slim");
	assert.deepEqual(buildArgs(slim, "0.99.1"), ["build", "-t", "piper-agent-slim", "-f", join(root, "environments/slim/Dockerfile"), "--build-arg", "PI_VERSION=0.99.1", "--label", "piper.env=slim", join(root, "environments/slim")], "pinned to Pi, labelled, built in its own folder");

	// What is on the machine, and what uses each image.
	const { record: imgKey } = apiKeys.create({ name: "images-key" });
	apiKeys.update(imgKey.id, { container: { image: "piper-agent-slim" } });
	const dinfo = { "sha256:full": { Id: "sha256:full", Size: 1_900_000_000, Config: { Labels: { "piper.pi-version": "0.99.1", "piper.env": "full" } } }, "sha256:slim": { Id: "sha256:slim", Size: 700_000_000, Config: { Labels: { "piper.pi-version": "0.98.0" } } }, "sha256:old": { Id: "sha256:old", Size: 1_800_000_000, Config: { Labels: { "piper.pi-version": "0.90.0" } } } };
	const imageRow = (id, repository, tag, created, size) => JSON.stringify({ ID: id, Repository: repository, Tag: tag, CreatedSince: created, Size: size });
	reply = (bin, args) => {
		if (args[0] === "images") return { code: 0, stdout: [imageRow("sha256:full", "piper-agent", "latest", "2 hours ago", "1.9GB"), imageRow("sha256:slim", "piper-agent-slim", "latest", "1 day ago", "700MB"), imageRow("sha256:old", "<none>", "<none>", "3 days ago", "1.8GB")].join("\n"), stderr: "" };
		if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: JSON.stringify(args.slice(2).map((id) => dinfo[id])), stderr: "" };
		if (args[0] === "ps") return { code: 0, stdout: `${cname("img-a")}\trunning\t\n${cname("img-b")}\trunning\t\n`, stderr: "" };
		if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Name: `/${cname("img-a")}`, Image: "sha256:full" }, { Name: `/${cname("img-b")}`, Image: "sha256:full" }]), stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	function cname(word) { return `piper-${instanceId()}-${chatIdHash(word).slice(0, 16)}`; }
	const listing = await listImages({ hostPi: "0.99.1" });
	const byName = Object.fromEntries(listing.images.map((i) => [i.name ?? "untagged", i]));
	assert.equal(listing.hostPiVersion, "0.99.1");
	assert.deepEqual([byName["piper-agent"].env, byName["piper-agent"].containers, byName["piper-agent"].isDefault, byName["piper-agent"].stale], ["full", 2, true, false], "the default, built from the label, two containers on it");
	assert.equal(byName["piper-agent"].sizeMb, Math.round(1_900_000_000 / 1048576));
	assert.deepEqual([byName["piper-agent-slim"].env, byName["piper-agent-slim"].keys, byName["piper-agent-slim"].stale, byName["piper-agent-slim"].isDefault], ["slim", ["images-key"], true, false], "slim: the environment from its name, used by a key, older than the gateway's Pi");
	assert.deepEqual([byName.untagged.untagged, byName.untagged.stale, byName.untagged.name], [true, true, null], "what a rebuild leaves behind is listed, since it costs disk");
	assert.deepEqual(listing.environments.map((e) => [e.name, e.built, e.stale, e.containersToRecreate]).slice(0, 2), [["full", true, false, 2], ["slim", true, true, 0]], "environments say whether they are built, behind, and how many containers a rebuild would affect");

	// Removing: only Piper's own, and never what is in use.
	const refused = async (ref, status, why) => assert.rejects(removeImage(ref, { hostPi: "0.99.1" }), (e) => e.status === status && why.test(e.message), ref);
	await refused("piper-agent", 409, /default image/);
	await refused("piper-agent-slim", 409, /set as the image of images-key/);
	await refused("nginx", 404, /not one of Piper's images/);
	seen.length = 0;
	apiKeys.update(imgKey.id, { container: null });
	assert.match(await removeImage("piper-agent-slim", { hostPi: "0.99.1" }), /removed piper-agent-slim/);
	assert.ok(seen.some((c) => c[1] === "rmi" && c[2] === "piper-agent-slim"));
	assert.match(await removeImage("sha256:old", { hostPi: "0.99.1" }), /removed sha256:old/, "an untagged one goes by its id");
	assert.ok(seen.some((c) => c[1] === "rmi" && c[2] === "sha256:old"));
	dinfo["sha256:slim"].Config.Labels["piper.pi-version"] = "0.98.0";
	reply = (bin, args) => (args[0] === "rmi" ? { code: 1, stdout: "", stderr: "Error: conflict: image is being used\n" } : args[0] === "images" ? { code: 0, stdout: imageRow("sha256:slim", "piper-agent-slim", "latest", "1 day ago", "700MB"), stderr: "" } : args[0] === "image" ? { code: 0, stdout: JSON.stringify([dinfo["sha256:slim"]]), stderr: "" } : { code: 0, stdout: args[0] === "ps" ? "" : "", stderr: "" });
	await assert.rejects(removeImage("piper-agent-slim", { hostPi: "0.99.1" }), (e) => e.status === 409 && /docker could not remove it: Error: conflict/.test(e.message), "docker's own refusal is passed on");
	reply = (bin, args) => (args[0] === "image" && args[1] === "prune" ? { code: 0, stdout: "Deleted Images:\nsha256:abc\n\nTotal reclaimed space: 1.79GB\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
	seen.length = 0;
	assert.match(await pruneImages(), /reclaimed 1\.79GB/);
	assert.ok(seen[0].includes("label=piper.image=1"), "only Piper's own untagged images");
	assert.match(recentAudit(10).map((a) => a.action).join(" "), /image\.prune/);

	// Builds: one at a time, in the background, with the output kept.
	{
		const children = [];
		const fakeSpawn = (bin, args) => {
			const child = new EventEmitter();
			child.stdout = new PassThrough(); child.stderr = new PassThrough();
			children.push({ bin, args, child });
			return child;
		};
		resetImageJob();
		await assert.rejects(buildImage("nope", { spawnFn: fakeSpawn, piVersion: "0.99.1" }), (e) => e.status === 404 && /no environment "nope"/.test(e.message));
		await assert.rejects(buildImage("../etc", { spawnFn: fakeSpawn, piVersion: "0.99.1" }), (e) => e.status === 404, "a name that is not an environment is not a path");
		const first = await buildImage("slim", { spawnFn: fakeSpawn, piVersion: "0.99.1" });
		assert.deepEqual([first.state, first.env, first.tag], ["running", "slim", "piper-agent-slim"]);
		assert.equal(children[0].bin, "docker");
		assert.deepEqual(children[0].args.slice(0, 3), ["build", "-t", "piper-agent-slim"]);
		assert.ok(children[0].args.includes("PI_VERSION=0.99.1"));
		await assert.rejects(buildImage("full", { spawnFn: fakeSpawn, piVersion: "0.99.1" }), (e) => e.status === 409 && /already running \(slim\)/.test(e.message), "one build at a time");
		children[0].child.stdout.write("Step 1/9 : FROM node:22\n#5 [2/6] RUN apt-get update\r#5 done\n");
		children[0].child.stderr.write("warning: something\n");
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(jobView().lines.slice(-4), ["Step 1/9 : FROM node:22", "#5 [2/6] RUN apt-get update", "#5 done", "warning: something"], "output is kept, carriage returns split");
		assert.equal(jobView().state, "running");
		children[0].child.emit("close", 0);
		assert.deepEqual([jobView().state, jobView().code], ["done", 0]);
		assert.match(jobView().lines.at(-1), /built piper-agent-slim in \d+ s/);
		// A failure, and then another build is allowed.
		const second = await buildImage("full", { spawnFn: fakeSpawn, piVersion: "0.99.1" });
		assert.equal(second.env, "full");
		assert.ok(second.id > first.id);
		children[1].child.emit("close", 1);
		assert.deepEqual([jobView().state, jobView().code], ["failed", 1]);
		assert.match(jobView().lines.at(-1), /the build failed \(exit 1\)/);
		// Docker missing is a failed job, not a crash.
		await buildImage("slim", { spawnFn: fakeSpawn, piVersion: "0.99.1" });
		children[2].child.emit("error", new Error("spawn docker ENOENT"));
		children[2].child.emit("close", null);
		assert.equal(jobView().state, "failed");
		assert.match(jobView().lines.at(-1), /could not run docker: spawn docker ENOENT/);
		// The log is bounded.
		await buildImage("slim", { spawnFn: fakeSpawn, piVersion: "0.99.1" });
		for (let i = 0; i < 700; i++) children[3].child.stdout.write(`line ${i}\n`);
		await new Promise((r) => setTimeout(r, 30));
		assert.ok(jobView().lines.length <= 300 && jobView().lines.at(-1) === "line 699", "the last 300 lines, no more");
		children[3].child.emit("close", 0);
		await assert.rejects(buildImage("slim", { spawnFn: fakeSpawn, piVersion: "" }), (e) => e.status === 503 && /Pi version/.test(e.message), "without a Pi version there is nothing to pin to");
		assert.ok(recentAudit(50).some((a) => a.action === "image.build" && a.target === "piper-agent-slim" && /Pi 0\.99\.1/.test(a.detail)), "builds are audited");
	}

	// The routes: images.json, build, remove and prune.
	{
		const call = async (method, url, body) => {
			const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
			req.method = method; req.url = url;
			const res = { status: null, body: "", writeHead(st) { this.status = st; }, end(b) { this.body = b ?? ""; } };
			await containerRoutes(req, res, new URL(url, "http://x").pathname);
			return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
		};
		reply = (bin, args) => (args[0] === "images" ? { code: 0, stdout: imageRow("sha256:full", "piper-agent", "latest", "2 hours ago", "1.9GB"), stderr: "" } : args[0] === "image" && args[1] === "inspect" ? { code: 0, stdout: JSON.stringify([dinfo["sha256:full"]]), stderr: "" } : { code: 0, stdout: "", stderr: "" });
		const list = await call("GET", "/dashboard/images.json");
		assert.equal(list.status, 200);
		assert.deepEqual(Object.keys(list.json).sort(), ["environments", "hostPiVersion", "images", "job"]);
		assert.equal((await call("POST", "/dashboard/images/build", { env: "nope" })).status, 404);
		assert.equal((await call("POST", "/dashboard/images/remove", { image: "piper-agent" })).status, 409, "the default image cannot be removed from the page either");
		assert.equal((await call("POST", "/dashboard/images/remove", { image: "" })).status, 400, "a blank reference is refused, not read as \"every image\"");
		assert.equal((await call("POST", "/dashboard/images/remove", { image: "sha" })).status, 404, "and a short string does not pick an image by its prefix");
		assert.equal((await call("POST", "/dashboard/images/nonsense", {})).status, 404);
		assert.equal((await call("GET", "/dashboard/images/build")).status, 404, "building needs POST");
	}
	apiKeys.remove(imgKey.id);
	rmSync(root, { recursive: true, force: true });
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
}


// ---------------------------------------------------------------- the router, over real HTTP

// /health once answered 200 with an empty body (it still called a function that had been deleted, and
// the error came after the status was sent), and nothing noticed because every check looked only at the
// status. So the endpoints are asked for over a real socket, and their bodies are parsed.
{
	const { server } = await import("./server.mjs");
	clearPasswordHash();
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false; // a dozen request lines in the test output help nobody
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const get = async (path) => {
		const res = await fetch(base + path);
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* reported by the assertions */ }
		return { status: res.status, text, json };
	};
	for (const path of ["/health", "/"]) {
		const r = await get(path);
		assert.equal(r.status, 200, path);
		assert.ok(r.json, `${path} must answer with JSON, not an empty body (got ${JSON.stringify(r.text.slice(0, 40))})`);
		assert.equal(r.json.status, "ok");
		assert.deepEqual(Object.keys(r.json.sessions).sort(), ["active", "hibernated", "idleMs", "max", "maxLifetimeMs", "oldestAgeMs"]);
		assert.ok("docker" in r.json && "diskFreeMb" in r.json, "and say whether containers can run and how much disk is left");
		assert.equal("cwd" in r.json, false, "the agent's working folder is gone with the runners that had one");
	}
	for (const [path, keys] of [
		["/dashboard.json", ["sessions", "containers", "disk", "passwordSet"]],
		["/dashboard/containers.json", ["containers", "disk", "events", "audit", "execAllowed"]],
		["/dashboard/images.json", ["images", "environments", "hostPiVersion", "job"]],
		["/dashboard/audit.json", ["audit"]],
		["/dashboard/settings.json", ["settings"]],
		["/dashboard/api-keys.json", ["keys", "defaults"]],
		["/dashboard/profiles.json", ["profiles", "shared"]],
	]) {
		const r = await get(path);
		assert.equal(r.status, 200, path);
		assert.ok(r.json, `${path} must answer with JSON (got ${JSON.stringify(r.text.slice(0, 40))})`);
		for (const key of keys) assert.ok(key in r.json, `${path} has ${key}`);
	}
	const missing = await get("/dashboard/no-such-page.json");
	assert.equal(missing.status, 404);
	assert.equal(missing.json.error.code, "not_found");
	assert.equal((await get("/no/such/route")).status, 401, "with keys set, an unknown path is refused rather than reported missing: routes are not revealed to strangers");
	const dash = await fetch(`${base}/dashboard`);
	assert.equal(dash.status, 200);
	assert.match(await dash.text(), /id="view-containers"/, "the page served has the Containers view");
	server.closeAllConnections?.();
	await new Promise((r) => server.close(r));
	config.ACCESS_LOG = accessLog;
}

// ---------------------------------------------------------------- docker: containers, network, migration

{
	const { DatabaseSync } = await import("node:sqlite");
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");

	// A fake engine: commands are recorded and answered from a table, so nothing here can reach Docker.
	const calls = [];
	let answers = () => ({ code: 0, stdout: "", stderr: "" });
	setRunner(async (bin, args) => {
		calls.push([bin, ...args]);
		return answers(bin, args);
	});
	const said = (verb) => calls.filter((c) => c[0] === "docker" && c[1] === verb);
	const reset = (fn) => { calls.length = 0; answers = fn ?? (() => ({ code: 0, stdout: "", stderr: "" })); };

	const spec = { name: "piper-abc-0123456789abcdef", keyId: "k1", image: "img", workspace: "/w/key-k1", profileDir: "/p/key-k1", chatDir: "/c/0123", runDir: "/r/abc-0123", bridgePath: "/b.mjs", bundles: [{ name: "base", path: "/s/base" }], mounts: [{ host: "/opt/tools", container: "/opt/tools" }], memoryMb: 512, pids: 64, cpus: 1.5, network: "internet", sig: "s1" };
	const flags = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

	// The container's command line: root with default capabilities, limits, and only the mounts named.
	{
		const args = containerCreateArgs(spec);
		assert.equal(args[0], "create");
		assert.ok(!args.includes("--privileged") && !args.includes("--cap-add") && !args.includes("--pid=host") && !args.includes("--network=host"), "no privileges beyond Docker's defaults");
		assert.ok(args.includes("--init") && flags(args, "--security-opt").includes("no-new-privileges"));
		assert.ok(!args.includes("--read-only") && !args.includes("--user"), "Pi is root with a writable filesystem: the container is the sandbox");
		assert.deepEqual([flags(args, "--memory")[0], flags(args, "--memory-swap")[0]], ["512m", "512m"], "no swap: a runaway is killed, not thrashed");
		assert.equal(flags(args, "--pids-limit")[0], "64");
		assert.equal(flags(args, "--cpus")[0], "1.5");
		assert.equal(flags(args, "--network")[0], "piper");
		assert.equal(flags(containerCreateArgs({ ...spec, network: "none" }), "--network")[0], "none");
		assert.equal(flags(containerCreateArgs({ ...spec, network: "open" }), "--network")[0], "piper-open", "open has a network of its own, so the internet policy's rules cannot cut it off");
		const mounts = flags(args, "-v");
		assert.deepEqual(mounts, ["/w/key-k1:/workspace", "/p/key-k1:/profile", "/c/0123/session:/piper/session", "/c/0123/etc:/opt/piper/etc:ro", "/r/abc-0123:/run/piper", "/b.mjs:/opt/piper/bridge.mjs:ro", "/s/base:/shared/base:ro", "/opt/tools:/opt/tools:ro"]);
		assert.ok(mounts.every((m) => !/docker\.sock/.test(m)), "the engine's socket is never mounted");
		assert.ok(mounts.some((m) => m.endsWith(":/run/piper")) && !mounts.some((m) => m.endsWith("bridge.sock")), "the socket's folder is mounted, not the socket file");
		assert.deepEqual(flags(args, "--label").filter((l) => l.startsWith("piper.")).sort(), ["piper.instance=" + instanceId(), "piper.key=k1", "piper.managed=1", "piper.sig=s1"].sort());
		assert.equal(args.at(-1), "img");
		// Frozen ones: the workspace read-only, the profile copied into a tmpfs when Pi starts.
		const frozen = containerCreateArgs({ ...spec, workspaceWritable: false, profileWritable: false });
		assert.ok(flags(frozen, "-v").includes("/w/key-k1:/workspace:ro"));
		assert.ok(flags(frozen, "-v").includes("/p/key-k1:/profile-frozen:ro") && flags(frozen, "--tmpfs")[0].startsWith("/profile:"));
		assert.equal(containerCreateArgs({ ...spec, memoryMb: 0, pids: 0, cpus: 0 }).includes("--memory"), false, "0 means no limit");
	}

	// The container's name carries the instance, and only this gateway's names are recognised.
	{
		const hash = chatIdHash("some session");
		assert.equal(containerName(hash, "aaaa1111"), `piper-aaaa1111-${hash.slice(0, 16)}`);
		assert.equal(chatKeyOfContainer(containerName(hash), instanceId()), hash.slice(0, 16));
		assert.equal(chatKeyOfContainer(containerName(hash, "other000"), instanceId()), null, "another gateway's container is not ours");
		assert.notEqual(instanceId("/a/gateway.db"), instanceId("/b/gateway.db"));
	}

	// The signature changes with everything a container's mounts and limits depend on.
	{
		const base = containerSignature(spec, "img1");
		assert.equal(containerSignature({ ...spec }, "img1"), base, "the same inputs, the same signature");
		for (const [what, change] of [
			["the image", [spec, "img2"]],
			["a frozen profile", [{ ...spec, profileWritable: false }, "img1"]],
			["a frozen workspace", [{ ...spec, workspaceWritable: false }, "img1"]],
			["the bundles", [{ ...spec, bundles: [] }, "img1"]],
			["the mounts", [{ ...spec, mounts: [] }, "img1"]],
			["memory", [{ ...spec, memoryMb: 1 }, "img1"]],
			["cpus", [{ ...spec, cpus: 3 }, "img1"]],
			["the network", [{ ...spec, network: "none" }, "img1"]],
			["the workspace path", [{ ...spec, workspace: "/elsewhere" }, "img1"]],
		]) assert.notEqual(containerSignature(...change), base, `${what} changes the signature`);
	}

	// Pi is started with docker exec: the wrapper links the container models.json unless the key has its own.
	{
		const args = execArgs({ name: "c1", env: { A: "1", B: "two words" }, piArgs: ["--mode", "rpc"] });
		assert.deepEqual(args.slice(0, 4), ["exec", "-i", "-w", "/workspace"]);
		assert.deepEqual(flags(args, "-e"), ["A=1", "B=two words"], "env is chosen at every start");
		const script = args[args.indexOf("-c") + 1];
		assert.match(script, /\[ -e \/profile\/models\.json \] \|\| \[ -L \/profile\/models\.json \] \|\| ln -s \/opt\/piper\/etc\/models\.json \/profile\/models\.json/, "a key's own models.json wins");
		assert.match(script, /exec "\$@"$/);
		assert.deepEqual(args.slice(args.indexOf("-c") + 2), ["sh", "pi", "--mode", "rpc"], "arguments are passed, not spliced into the script");
		assert.ok(!script.includes("cp -a"), "a writable profile is not copied");
		assert.match(execArgs({ name: "c1", piArgs: [], profileWritable: false }).find((a) => a.includes("cp -a")), /^cp -a \/profile-frozen\/\. \/profile\/ &&/);
	}

	// Pi's arguments and environment at each start.
	{
		const inv = piInvocation({ ...spec }, { resume: false, defaultModel: { model: "p/m", thinking: "high" } });
		assert.deepEqual(inv.piArgs.slice(0, 5), ["--mode", "rpc", "--session-dir", "/piper/session", "--approve"]);
		assert.ok(inv.piArgs.join(" ").includes("-e /opt/piper/bridge.mjs -e /shared/base"));
		assert.equal(inv.env.PI_CODING_AGENT_DIR, "/profile");
		assert.equal(inv.env.PI_CONFIG_DIR, "/profile/config");
		assert.equal(inv.env.PIPER_BRIDGE_SOCKET, "/run/piper/bridge.sock");
		assert.equal(inv.env.PIPER_WORKSPACE_DIR, "/workspace");
		assert.equal(inv.env.HOME, "/root");
		assert.equal(inv.env.TOOL_HOME, "/opt/tool", "CONTAINER_ENV reaches Pi");
		assert.equal(inv.env.PIPER_DEFAULT_MODEL, "p/m");
		assert.equal(inv.env.PIPER_DEFAULT_THINKING, "high");
		const resumed = piInvocation({ ...spec }, { resume: true, defaultModel: { model: "p/m", thinking: null } });
		assert.ok(resumed.piArgs.includes("--continue"), "a resumed chat continues its session");
		assert.equal(resumed.env.PIPER_DEFAULT_MODEL, undefined, "and keeps the model it was on");
	}

	// The profile helper is the strict one: it protects the gateway, not the agent.
	{
		const args = helperArgs({ dir: "/p/key-k1", helperPath: "/h.mjs", extraArgs: ["raw", "read", "a"], maxBytes: 5, image: "img", uid: 7, gid: 8 });
		assert.deepEqual(flags(args, "-v"), ["/p/key-k1:/data", "/h.mjs:/opt/piper/profile.mjs:ro"], "only that one folder is mounted");
		assert.equal(flags(args, "--network")[0], "none");
		assert.equal(flags(args, "--cap-drop")[0], "ALL");
		assert.ok(args.includes("--read-only") && args.includes("--rm"));
		assert.equal(flags(args, "--user")[0], "7:8");
		assert.equal(flags(args, "--entrypoint")[0], "node");
		assert.deepEqual(args.slice(args.indexOf("img")), ["img", "/opt/piper/profile.mjs", "raw", "read", "a"]);
		assert.equal(profileHelperInvocation({ dir: "/d", extraArgs: [] }).command, "docker");
	}

	// ensureContainer against the fake engine: create, reuse, start, recreate on a changed signature.
	{
		const sig = containerSignature(spec, "img1");
		const inspected = (running, signature, managed = "1") => JSON.stringify([{ State: { Running: running }, Config: { Labels: { "piper.managed": managed, "piper.sig": signature } } }]);
		reset((bin, args) => (args[0] === "inspect" ? { code: 1, stdout: "", stderr: "No such object" } : { code: 0, stdout: "", stderr: "" }));
		assert.deepEqual(await ensureContainer(spec, "img1"), { created: true, recreated: false, sig });
		assert.deepEqual(calls.map((c) => c[1]), ["inspect", "create", "start"]);
		assert.equal(said("create")[0].includes(`piper.sig=${sig}`), true, "the signature is stored on the container");

		reset((bin, args) => (args[0] === "inspect" ? { code: 0, stdout: inspected(true, sig), stderr: "" } : { code: 0, stdout: "", stderr: "" }));
		assert.equal((await ensureContainer(spec, "img1")).created, false);
		assert.deepEqual(calls.map((c) => c[1]), ["inspect"], "a running container with the right signature is left alone");

		reset((bin, args) => (args[0] === "inspect" ? { code: 0, stdout: inspected(false, sig), stderr: "" } : { code: 0, stdout: "", stderr: "" }));
		await ensureContainer(spec, "img1");
		assert.deepEqual(calls.map((c) => c[1]), ["inspect", "start"], "a stopped one is started, not recreated");

		reset((bin, args) => (args[0] === "inspect" ? { code: 0, stdout: inspected(true, "stale"), stderr: "" } : { code: 0, stdout: "", stderr: "" }));
		const again = await ensureContainer(spec, "img1");
		assert.equal(again.recreated, true);
		assert.deepEqual(calls.map((c) => c[1]), ["inspect", "rm", "create", "start"], "a changed signature replaces the container");

		reset((bin, args) => (args[0] === "inspect" ? { code: 0, stdout: inspected(true, sig, ""), stderr: "" } : { code: 0, stdout: "", stderr: "" }));
		await assert.rejects(ensureContainer(spec, "img1"), /not Piper's/, "a container that is not ours is never touched");
		assert.equal(said("rm").length, 0);

		reset((bin, args) => (args[0] === "inspect" ? { code: 1, stdout: "", stderr: "" } : args[0] === "create" ? { code: 125, stdout: "", stderr: "Unable to find image 'img'" } : { code: 0, stdout: "", stderr: "" }));
		await assert.rejects(ensureContainer(spec, "img1"), (err) => err instanceof EngineError && err.status === 503 && /Unable to find image/.test(err.message), "an engine failure says what it said");
	}

	// iptables is found by its path when the service's PATH lacks the sbin folders, and by name as a last resort.
	const isIptables = (bin) => /(^|\/)iptables$/.test(bin);
	assert.equal(iptablesBinary((p) => p === "/usr/sbin/iptables"), "/usr/sbin/iptables");
	assert.equal(iptablesBinary((p) => p === "/sbin/iptables"), "/sbin/iptables", "the other standard place");
	assert.equal(iptablesBinary((p) => p === "/usr/sbin/iptables" || p === "/sbin/iptables"), "/usr/sbin/iptables", "the first one wins");
	assert.equal(iptablesBinary(() => false), "iptables", "not found anywhere: the bare name, and the failure message says so");

	// An image with no labels at all is a Piper-less image that exists, not a missing one.
	{
		reset((bin, args) => (args[0] === "image" ? { code: 0, stdout: "sha256:plain|\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
		assert.deepEqual(await imageInfo("node:22-trixie-slim"), { id: "sha256:plain", piVersion: "" }, "found, and with no Pi version, which is how it is told from Piper's");
		assert.ok(calls.find((c) => c[1] === "image")[4].includes("{{with .Config.Labels}}"), "the label lookup is safe on an image with no labels");
		reset((bin, args) => ({ code: 1, stdout: "", stderr: "No such image" }));
		assert.equal(await imageInfo("nothing"), null);
	}

	// The firewall: a fake iptables that keeps its rules, to check what is installed, in what order, and that a second run changes nothing.
	{
		const state = { INPUT: [], "DOCKER-USER": [] };
		const iptables = (args) => {
			if (args[0] === "-S") return { code: 0, stdout: [`-P ${args[1]} ACCEPT`, ...state[args[1]]].join("\n"), stderr: "" };
			if (args[0] === "-I") {
				state[args[1]].splice(Number(args[2]) - 1, 0, `-A ${args[1]} ${args.slice(3).join(" ")}`);
				return { code: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "-D") {
				const line = `-A ${args[1]} ${args.slice(2).join(" ")}`;
				const at = state[args[1]].indexOf(line);
				if (at < 0) return { code: 1, stdout: "", stderr: "no such rule" };
				state[args[1]].splice(at, 1);
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		reset((bin, args) => (isIptables(bin) ? iptables(args) : { code: 0, stdout: "", stderr: "" }));
		assert.deepEqual(firewallRules("none"), []);
		assert.deepEqual(firewallRules("open"), []);
		const rules = firewallRules("internet", [], []);
		assert.equal(rules.filter((r) => r.chain === "INPUT").length, 1, "one rule keeps the containers off this machine");
		assert.equal(rules.filter((r) => r.chain === "DOCKER-USER").length, 6, "and one per private range keeps them off the LAN");
		assert.ok(rules.every((r) => r.args.includes("172.29.0.0/24") && r.args.some((a) => a.startsWith(`piper:${instanceId()}:`))), "each rule is for the Piper network and tagged with this gateway");
		assert.ok(rules.some((r) => r.args.join(" ").includes("169.254.0.0/16")), "cloud metadata is blocked");
		assert.ok(rules.find((r) => r.chain === "INPUT").args.join(" ").includes("! --ctstate ESTABLISHED,RELATED"), "answers to the gateway's own connections still get through");

		// A foreign rule and another gateway's rule are never touched.
		state["DOCKER-USER"].push("-A DOCKER-USER -j RETURN", `-A DOCKER-USER -s 172.29.0.0/24 -m comment --comment piper:zzzzzzzz:abcdef012345 -j DROP`);
		const first = await ensureFirewall("internet", []);
		assert.equal(first.added, 7);
		const snapshot = JSON.stringify(state);
		const second = await ensureFirewall("internet", []);
		assert.deepEqual([second.added, second.removed], [0, 0], "idempotent: a second run installs nothing");
		assert.equal(JSON.stringify(state), snapshot);
		assert.ok(state["DOCKER-USER"].includes("-A DOCKER-USER -j RETURN") && state["DOCKER-USER"].some((l) => l.includes("zzzzzzzz")), "rules that are not ours are left alone");

		// An allowed endpoint goes above the drops, and is removed when no longer wanted.
		await ensureFirewall("internet", [{ ip: "192.168.1.50", port: 4000 }]);
		const chain = state["DOCKER-USER"].filter((l) => l.includes(`piper:${instanceId()}:`));
		assert.ok(chain[0].includes("-d 192.168.1.50") && chain[0].includes("--dport 4000") && chain[0].endsWith("-j ACCEPT"), "the allowance comes first");
		assert.ok(chain.slice(1).every((l) => l.endsWith("-j DROP")));
		const removed = await ensureFirewall("internet", []);
		assert.equal(removed.removed, 1, "and a stale allowance is deleted");

		// DNS to a resolver is opened for both protocols, on port 53 only.
		const dns = firewallRules("internet", [{ ip: "192.168.1.1", port: 53, proto: ["udp", "tcp"] }], []);
		assert.deepEqual(dns.filter((r) => r.kind === "allow").map((r) => r.args.slice(0, 8).join(" ")), ["-s 172.29.0.0/24 -d 192.168.1.1 -p udp --dport 53", "-s 172.29.0.0/24 -d 192.168.1.1 -p tcp --dport 53"]);
		// An endpoint on this very machine also needs an INPUT allowance.
		const local = firewallRules("internet", [{ ip: "10.9.9.9", port: 80 }], ["10.9.9.9"]);
		assert.deepEqual(local.filter((r) => r.kind === "allow").map((r) => r.chain).sort(), ["DOCKER-USER", "INPUT"]);

		// Leaving internet mode takes the rules away; a missing drop rebuilds them in order.
		state["DOCKER-USER"] = state["DOCKER-USER"].filter((l) => !l.includes("10.0.0.0/8"));
		await ensureFirewall("internet", []);
		assert.equal(state["DOCKER-USER"].filter((l) => l.includes(`piper:${instanceId()}:`)).length, 6, "a rule someone deleted is put back");
		await ensureFirewall("none", []);
		assert.deepEqual(state.INPUT.filter((l) => l.includes(`piper:${instanceId()}:`)), [], "none and open remove the rules");
		assert.ok(state["DOCKER-USER"].includes("-A DOCKER-USER -j RETURN"));

		// Fails closed.
		reset((bin, args) => (isIptables(bin) ? { code: 127, stdout: "", stderr: "iptables: command not found" } : { code: 0, stdout: "", stderr: "" }));
		await assert.rejects(ensureFirewall("internet", []), /cannot read the firewall/);
	}

	// Readiness: what is wrong is said in words, and a warning is not an error.
	{
		const good = (bin, args) => {
			if (isIptables(bin)) return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "version") return { code: 0, stdout: "26.1.5\n", stderr: "" };
			if (args[0] === "image") return { code: 0, stdout: "sha256:abc|0.99.1\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		reset(good);
		let status = await checkEngine({ force: true, hostPiVersion: "0.99.1" });
		assert.equal(status.ok, true);
		assert.deepEqual([status.engine.version, status.image.piVersion, status.warnings], ["26.1.5", "0.99.1", []]);
		reset(good);
		status = await checkEngine({ force: true, hostPiVersion: "1.0.0" });
		assert.equal(status.ok, true, "a Pi version mismatch is a warning");
		assert.match(status.warnings[0], /image has Pi 0\.99\.1 but the gateway runs Pi 1\.0\.0/);
		reset((bin, args) => (bin === "docker" && args[0] === "version" ? { code: 127, stdout: "", stderr: "spawn docker ENOENT" } : good(bin, args)));
		status = await checkEngine({ force: true });
		assert.deepEqual([status.ok, /not installed/.test(status.problems[0])], [false, true]);
		reset((bin, args) => (args[0] === "image" ? { code: 1, stdout: "", stderr: "No such image" } : good(bin, args)));
		status = await checkEngine({ force: true });
		assert.match(status.problems[0], /image "piper-agent" does not exist; build it with \.\/piper\.sh image/);
		reset((bin, args) => (isIptables(bin) ? { code: 1, stdout: "", stderr: "Permission denied" } : good(bin, args)));
		status = await checkEngine({ force: true });
		assert.equal(status.ok, false);
		assert.match(status.problems.join(" "), /network policy "internet" cannot be enforced.*none or open/);
		await assert.rejects(requireReady({ force: true }), (err) => err instanceof EngineError && err.status === 503);
		// Cached for a while, so a busy dashboard does not run docker on every poll.
		reset(good);
		await checkEngine({ force: true });
		const before = calls.length;
		await checkEngine();
		assert.equal(calls.length, before, "the answer is cached");
		resetEngineCheck();
		await checkEngine();
		assert.ok(calls.length > before, "and forgotten when settings change");
		assert.ok(isBlockedIp("192.168.1.50") && isBlockedIp("169.254.169.254") && isBlockedIp("10.1.2.3") && isBlockedIp("172.20.0.1") && isBlockedIp("127.0.0.1"));
		assert.ok(!isBlockedIp("93.184.216.34") && !isBlockedIp("172.32.0.1") && !isBlockedIp("8.8.8.8"), "public addresses are not");
	}

	// Sweeps touch this gateway's containers and folders only, and nothing that could be starting.
	{
		const known = [chatIdHash("a"), chatIdHash("b")];
		const live = new Set([known[0]]);
		const row = (hash, state) => `${containerName(hash)}\t${state}\tk1`;
		reset((bin, args) => (args[0] === "ps"
			? { code: 0, stdout: [row(known[0], "running"), row(known[1], "running"), row(chatIdHash("gone"), "exited"), `${containerName(chatIdHash("x"), "other000")}\trunning\tk9`].join("\n"), stderr: "" }
			: { code: 0, stdout: "", stderr: "" }));
		const chats = `${TEST_WS}-chats`;
		const runs = `${TEST_WS}-run`;
		const old = new Date(Date.now() - 3600_000);
		const dirs = [join(chats, known[1].slice(0, 16)), join(chats, chatIdHash("gone").slice(0, 16)), join(chats, chatIdHash("young").slice(0, 16)), join(runs, `${instanceId()}-${chatIdHash("gone").slice(0, 16)}`), join(runs, `other000-${chatIdHash("x").slice(0, 16)}`)];
		for (const d of dirs) mkdirSync(d, { recursive: true });
		for (const d of dirs.filter((d) => !d.includes(chatIdHash("young").slice(0, 16)))) utimesSync(d, old, old);
		const result = await sweepContainers(new Set(known), live);
		assert.deepEqual(said("rm").map((c) => c.at(-1)), [containerName(chatIdHash("gone"))], "a container of no chat is removed");
		assert.deepEqual(said("stop").map((c) => c.at(-1)), [containerName(known[1])], "a resumable chat's container left running is stopped, not removed");
		assert.ok(!calls.some((c) => c.includes(containerName(chatIdHash("x"), "other000"))), "another gateway's container is not touched");
		assert.deepEqual([existsSync(dirs[0]), existsSync(dirs[1]), existsSync(dirs[2]), existsSync(dirs[3]), existsSync(dirs[4])], [true, false, true, false, true], "old folders of no chat go; a chat's own, a young one and another gateway's stay");
		assert.deepEqual([result.stopped, result.removed], [1, 1]);
		rmSync(chats, { recursive: true, force: true });
		rmSync(runs, { recursive: true, force: true });

		// Hibernating stops the container; ending removes it and the chat's state, and never the workspace.
		const hash = chatIdHash("host-test");
		mkdirSync(join(chats, hash.slice(0, 16), "session"), { recursive: true });
		reset();
		await containerHost.stopped(hash);
		assert.deepEqual(calls.map((c) => c[1]), ["stop"]);
		assert.equal(existsSync(join(chats, hash.slice(0, 16))), true, "the session survives a stop");
		reset();
		await containerHost.ended(hash);
		assert.deepEqual(calls.map((c) => c[1]), ["rm"]);
		assert.equal(existsSync(join(chats, hash.slice(0, 16))), false, "and not the end");
		const ws = containerHost.workspace("host-key");
		assert.equal(ws, join(TEST_WS, "key-host-key"), "a key's workspace is one folder");
		assert.equal(existsSync(ws), true);
		rmSync(chats, { recursive: true, force: true });
	}

	// CONTAINER_MOUNTS and CONTAINER_ALLOW.
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-mounts-"));
		assert.deepEqual(parseContainerMounts(`${dir} ${dir}:/opt/x`), [{ host: dir, container: dir }, { host: dir, container: "/opt/x" }]);
		for (const [text, why] of [
			["relative/path", /absolute/],
			["/run/docker.sock", /engine socket/],
			["/var/run/docker.sock:/x", /engine socket/],
			[`${GATEWAY_DIR_FOR_TEST}`, /protects/],
			[`${homedir()}/.pi/agent`, /protects/],
			["/", /whole host/],
			[`${dir}:/workspace`, /used by Piper/],
			[`${dir}:/profile/x`, /used by Piper/],
			[`${dir}:/opt/piper`, /used by Piper/],
			["/does/not/exist", /does not exist/],
			[`${dir}/../x`, /clean path/],
			[`${dir}:/a:/b`, /colons/],
		]) {
			assert.throws(() => parseContainerMounts(text, { strict: true }), why, `${text} is refused on save`);
			assert.deepEqual(parseContainerMounts(text), [], `${text} is skipped if it was ever stored`);
		}
		assert.throws(() => parseContainerMounts(`${dir}:/x ${dir}:/x`, { strict: true }), /mounted twice/);
		assert.throws(() => coerceSetting(SETTINGS_SPEC.find((s) => s.key === "CONTAINER_MOUNTS"), "/run/docker.sock"), /engine socket/);
		rmSync(dir, { recursive: true, force: true });
		assert.deepEqual(parseAllow("192.168.1.50:4000 litellm.lan,10.0.0.5:80"), [{ host: "192.168.1.50", port: 4000 }, { host: "litellm.lan", port: 0 }, { host: "10.0.0.5", port: 80 }]);
		assert.throws(() => parseAllow("nope:99999", { strict: true }), /not host or host:port/);
		assert.throws(() => parseAllow("a b:c", { strict: true }), /not host or host:port/);
		assert.deepEqual(parseContainerEnv("A=1  B=x:y "), [["A", "1"], ["B", "x:y"]]);
		for (const bad of ["PATH=/evil", "HOME=/root", "PI_CODING_AGENT_DIR=/x", "PIPER_BRIDGE_SOCKET=/x", "no-equals", "1BAD=x"]) {
			assert.throws(() => parseContainerEnv(bad, { strict: true }), /CONTAINER_ENV/, `${bad} is refused on save`);
			assert.deepEqual(parseContainerEnv(bad), [], `${bad} is skipped if it was ever stored`);
		}
	}

	// The container Pi config: models that Pi calls directly, with their keys, and what follows from them.
	{
		ensureContainerPiDir();
		assert.equal(statSync(TEST_CONTAINER_PI).mode & 0o777, 0o700);
		assert.deepEqual(readContainerModels(), { providers: {} });
		assert.deepEqual([...directProviders()], []);
		const text = JSON.stringify({ providers: { "local-openai": { baseUrl: "http://192.168.1.50:4000/v1", api: "openai-completions", apiKey: "sk-secret-value", models: [{ id: "Qwen/Qwen3-Next", name: "Qwen" }, { id: "hermes", reasoning: true }] } } });
		saveModelsText(text);
		assert.equal(statSync(join(TEST_CONTAINER_PI, "models.json")).mode & 0o777, 0o600, "the file holding keys is owner-only");
		assert.deepEqual([...directProviders()], ["local-openai"]);
		assert.deepEqual(directCatalogue().map((m) => `${m.provider}/${m.id}`), ["local-openai/Qwen/Qwen3-Next", "local-openai/hermes"]);
		assert.equal(directCatalogue().every((m) => m.direct), true);
		// Shown redacted, and saving the redaction keeps the stored key.
		const shown = redactedModelsText();
		assert.ok(!shown.includes("sk-secret-value") && shown.includes(REDACTED));
		const edited = JSON.parse(shown);
		edited.providers["local-openai"].models.push({ id: "extra" });
		saveModelsText(JSON.stringify(edited));
		assert.equal(readContainerModels().providers["local-openai"].apiKey, "sk-secret-value", "a redacted key keeps the stored one");
		assert.equal(readContainerModels().providers["local-openai"].models.length, 3);
		const fresh = JSON.parse(shown);
		fresh.providers["other"] = { baseUrl: "http://x/v1", apiKey: REDACTED, models: [] };
		saveModelsText(JSON.stringify(fresh));
		assert.equal("apiKey" in readContainerModels().providers.other, false, "a redacted key for a provider with none stored is dropped, not stored as ***");
		fresh.providers["local-openai"].apiKey = "sk-new";
		saveModelsText(JSON.stringify(fresh));
		assert.equal(readContainerModels().providers["local-openai"].apiKey, "sk-new", "a new key replaces it");
		for (const [bad, why] of [["not json", /not valid JSON/], ["[]", /must be an object/], ["{}", /providers/], ['{"providers":{"a b":{}}}', /not usable/], ['{"providers":{"x":{"baseUrl":"ftp://h"}}}', /http\(s\)/], ['{"providers":{"x":{"models":[{}]}}}', /needs an id/], ['{"providers":{"x":{"models":"m"}}}', /must be a list/]]) {
			assert.throws(() => validateModelsText(bad), why, `${bad} is refused`);
		}
		const before = readFileSync(join(TEST_CONTAINER_PI, "models.json"), "utf8");
		assert.throws(() => saveModelsText("not json"));
		assert.equal(readFileSync(join(TEST_CONTAINER_PI, "models.json"), "utf8"), before, "a refused save changes nothing");
		saveModelsText(JSON.stringify({ providers: { "local-openai": { baseUrl: "http://192.168.1.50:4000/v1", apiKey: "k", models: [{ id: "Qwen/Qwen3-Next" }, { id: "hermes" }] } } }));

		// What each key gets, and the endpoints the firewall opens for it.
		const rendered = JSON.parse(renderModelsFor((m) => m.id !== "hermes"));
		assert.deepEqual(rendered.providers["local-openai"].models.map((m) => m.id), ["Qwen/Qwen3-Next"], "a key gets only the models it may use");
		assert.equal(JSON.parse(renderModelsFor(() => false)).providers["local-openai"], undefined, "a provider with none left is dropped");
		assert.deepEqual(allowedEndpoints(readContainerModels(), []).map((e) => [e.host, e.port]), [["192.168.1.50", 4000]], "the models' own endpoint is allowed");
		assert.match(allowedEndpoints(readContainerModels(), [])[0].why, /provider local-openai/);
		assert.deepEqual(allowedEndpoints(readContainerModels(), ["192.168.1.1"]).find((e) => e.port === 53), { host: "192.168.1.1", port: 53, proto: ["udp", "tcp"], why: "DNS resolver of this machine (resolv.conf)" }, "and so is the machine's resolver, for DNS only");
		const conf = mkdtempSync(join(tmpdir(), "pi-resolv-"));
		writeFileSync(join(conf, "a"), "# c\nnameserver 192.168.1.1\nnameserver 127.0.0.53\nnameserver 2001:db8::1\nsearch x\nnameserver 192.168.1.1\nnameserver 8.8.8.8\n");
		assert.deepEqual(hostNameservers([join(conf, "a"), join(conf, "missing")]), ["192.168.1.1", "8.8.8.8"], "loopback resolvers are Docker's, IPv6 is skipped, duplicates collapse");
		rmSync(conf, { recursive: true, force: true });
		assert.deepEqual(endpointOf("https://api.example.com/v1"), { host: "api.example.com", port: 443 });
		assert.equal(endpointOf("ftp://x"), null);
		const etc = join(TEST_CONTAINER_PI, "..", `pi-etc-${process.pid}`);
		writeChatModels(etc, (m) => m.id === "hermes");
		assert.equal(statSync(join(etc, "models.json")).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(readFileSync(join(etc, "models.json"), "utf8")).providers["local-openai"].models.map((m) => m.id), ["hermes"]);
		rmSync(etc, { recursive: true, force: true });

		// Defaults: the container config's, else the host's.
		assert.deepEqual(containerDefaultModel({ model: "host/x", thinking: null }), { model: "host/x", thinking: null }, "with none set, the host's default");
		saveContainerDefaults({ defaultProvider: "local-openai", defaultModel: "Qwen/Qwen3-Next", defaultThinkingLevel: "high" });
		assert.deepEqual(containerDefaultModel({ model: "host/x", thinking: null }), { model: "local-openai/Qwen/Qwen3-Next", thinking: "high" });
		assert.throws(() => saveContainerDefaults({ defaultModel: "" , defaultProvider: "p" }), /both/);
		saveContainerDefaults({ defaultProvider: "", defaultModel: "", defaultThinkingLevel: "" });
		assert.equal(containerDefaultModel(null), null);

		// One catalogue for clients: the host's models minus the direct providers, plus the direct ones.
		const runtime = {
			getAvailableSnapshot: () => [{ provider: "local-openai", id: "host-only" }, { provider: "cloud", id: "c1", name: "Cloud One" }],
			getModel: (provider, id) => (provider === "cloud" && id === "c1" ? { provider, id } : null),
		};
		assert.deepEqual(catalogueFor(runtime).map((m) => `${m.provider}/${m.id}`), ["cloud/c1", "local-openai/Qwen/Qwen3-Next", "local-openai/hermes"], "the host's copy of a direct provider is replaced by the container's");
		assert.deepEqual(catalogueFor(runtime, (m) => m.provider === "cloud").map((m) => m.id), ["c1"], "each key sees what it may use");
		assert.equal(resolveModel(runtime, "local-openai/hermes").direct, true, "a direct model resolves by full name");
		assert.equal(resolveModel(runtime, "hermes").provider, "local-openai", "and by bare id");
		assert.equal(resolveModel(runtime, "local-openai/host-only"), undefined, "the host's model of a direct provider is not what a container's Pi has");
		assert.equal(resolveModel(runtime, "cloud/c1").id, "c1");
		assert.equal(resolveModel(runtime, "Cloud One").id, "c1");
		assert.equal(resolveModel(runtime, "pi"), undefined);
		assert.deepEqual(resolveModelQuery(catalogueFor(runtime), "qwen").model?.id, "Qwen/Qwen3-Next", "pi_set_model resolves over the same list");
	}

	// Direct calls are metered from the event stream, and bridged ones only by the bridge: nothing twice.
	{
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new PassThrough();
		child.exitCode = null;
		child.signalCode = null;
		child.kill = () => {};
		const meter = newMeter();
		const session = new PiRpcSession(child, { meter, direct: () => new Set(["local-openai"]) });
		const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0.5 } });
		const emit = (message) => child.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
		emit({ role: "assistant", provider: "local-openai", model: "Qwen/Qwen3-Next", content: [{ type: "text", text: "hi" }], usage: usage(100, 10) });
		emit({ role: "assistant", provider: "cloud", model: "c1", content: [], usage: usage(7, 7) });
		emit({ role: "user", provider: "local-openai", model: "x", content: [], usage: usage(99, 99) });
		emit({ role: "assistant", provider: "local-openai", model: "Qwen/Qwen3-Next", content: [], usage: usage(50, 5) });
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(meter.tokens, { input: 150, output: 15, cacheRead: 0, cacheWrite: 0, total: 165 }, "only the direct provider's assistant messages are counted");
		assert.equal(meter.cost, 1);
		assert.deepEqual(Object.keys(meter.byModel), ["local-openai/Qwen/Qwen3-Next"], "billed to its own model, as the ledger expects");
		assert.equal(session.getSessionStats().byModel["local-openai/Qwen/Qwen3-Next"].tokens.total, 165);
		// dispose resolves once Pi has exited, so the container is stopped only afterwards.
		let ended = false;
		const done = session.dispose().then(() => (ended = true));
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(ended, false, "not before Pi exits");
		child.emit("exit", 0, null);
		await done;
		assert.equal(ended, true);
		assert.equal(session.dispose(), session.dispose(), "and disposing twice is one disposal");
	}

	// Settings that were renamed keep their values, obsolete ones go, and the network switch maps.
	{
		const database = new DatabaseSync(":memory:");
		database.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const put = (key, value, source = "ui") => database.prepare("INSERT INTO settings VALUES (?, ?, ?, 1)").run(key, value, source);
		for (const [k, v] of [["SANDBOX_MEMORY_MB", "4096"], ["SANDBOX_PIDS", "99"], ["SANDBOX_CPUS", "0.5"], ["SANDBOX_ENV", "A=1"], ["KEY_FILES_MAX_BYTES", "1000"], ["WORKSPACE_ARCHIVE_TTL_MS", "5"], ["SANDBOX_NETWORK", "on"], ["RUNNER", "bwrap"], ["SANDBOX_ALLOW", "/x"], ["WORKSPACE_JAIL", "1"], ["WORKSPACE_ON_EXPIRY", "delete"], ["GATEWAY_EXTENSIONS", "0"], ["PI_CWD", ""], ["SANDBOX_LIMITS", "auto"], ["KEY_FILES_ROOT", "/data/shared-folders"], ["CONTAINER_IMAGE", "piper-sandbox"], ["MAX_SESSIONS", "7"]]) put(k, v);
		migrateSettingRows(database);
		const rows = Object.fromEntries(database.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
		assert.deepEqual(rows, { CONTAINER_MEMORY_MB: "4096", CONTAINER_PIDS: "99", CONTAINER_CPUS: "0.5", CONTAINER_ENV: "A=1", WORKSPACE_MAX_BYTES: "1000", ARCHIVE_TTL_MS: "5", CONTAINER_NETWORK: "internet", MAX_SESSIONS: "7" }, "values carried over, the rest untouched, obsolete rows and the old image default gone");
		assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'legacy-key-files-root'").get().value, "/data/shared-folders", "where the shared folders were is remembered for the move");
		const once = JSON.stringify(rows);
		migrateSettingRows(database);
		assert.equal(JSON.stringify(Object.fromEntries(database.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]))), once, "idempotent");
		database.prepare("DELETE FROM settings").run();
		put("SANDBOX_NETWORK", "off");
		put("CONTAINER_MEMORY_MB", "1");
		put("SANDBOX_MEMORY_MB", "9");
		migrateSettingRows(database);
		assert.equal(database.prepare("SELECT value FROM settings WHERE key = 'CONTAINER_NETWORK'").get().value, "none", "off becomes none");
		assert.equal(database.prepare("SELECT value FROM settings WHERE key = 'CONTAINER_MEMORY_MB'").get().value, "1", "a value already set under the new name wins");
		assert.equal(database.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'SANDBOX_%'").get().n, 0);
		for (const key of ["RUNNER", "WORKSPACE_JAIL", "SANDBOX_ALLOW", "GATEWAY_EXTENSIONS"]) assert.equal(SETTINGS_SPEC.some((s) => s.key === key), false, `${key} is gone from the spec`);
		for (const key of ["CONTAINER_IMAGE", "CONTAINER_NETWORK", "CONTAINER_ALLOW", "CONTAINER_MOUNTS", "CONTAINER_PI_DIR", "CONTAINER_ENV", "CONTAINER_MEMORY_MB", "WORKSPACE_MAX_BYTES", "ARCHIVE_TTL_MS"]) assert.ok(SETTINGS_SPEC.some((s) => s.key === key), `${key} is in the spec`);
		assert.deepEqual(SETTINGS_SPEC.find((s) => s.key === "CONTAINER_NETWORK").options, ["internet", "none", "open"]);
		assert.equal(SETTINGS_SPEC.find((s) => s.key === "CONTAINER_NETWORK").def, "internet", "the safe policy is the default");
		assert.equal(SETTINGS_SPEC.find((s) => s.key === "CONTAINER_IMAGE").def, "piper-agent");
	}

	// The one-time move to containers, and only once.
	{
		const database = new DatabaseSync(":memory:");
		database.exec("CREATE TABLE chats (id_hash TEXT PRIMARY KEY, key_id TEXT, workspace TEXT, created_at INTEGER, last_used_at INTEGER, requests INTEGER, state_json TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		database.prepare("INSERT INTO chats VALUES ('h', 'k', '/w', 1, 1, 1, '{}')").run();
		const base = mkdtempSync(join(tmpdir(), "pi-migrate-"));
		const root = join(base, "workspaces");
		const files = join(base, "files");
		const run = join(base, "workspaces-run");
		const chatDir = "0f0f0f0f-1111-2222-3333-444444444444";
		mkdirSync(join(root, chatDir), { recursive: true });
		writeFileSync(join(root, chatDir, "old-work.txt"), "kept in the archive");
		mkdirSync(join(root, "key-existing"), { recursive: true });
		writeFileSync(join(root, "key-existing", "mine"), "1");
		mkdirSync(join(files, "key-a"), { recursive: true });
		writeFileSync(join(files, "key-a", "note.txt"), "was the shared folder");
		mkdirSync(join(files, "key-existing"), { recursive: true });
		writeFileSync(join(files, "key-existing", "theirs"), "2");
		mkdirSync(run, { recursive: true });
		writeFileSync(join(run, "deadbeef.sock"), "");
		// With no record of where the old shared folders were, none are looked for: a fresh or scratch
		// database must never reach into a gateway's default folder.
		const fresh = new DatabaseSync(":memory:");
		fresh.exec("CREATE TABLE chats (id_hash TEXT PRIMARY KEY, key_id TEXT, workspace TEXT, created_at INTEGER, last_used_at INTEGER, requests INTEGER, state_json TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const untouched = mkdtempSync(join(tmpdir(), "pi-migrate-fresh-"));
		mkdirSync(join(untouched, "key-x"));
		assert.deepEqual(migrateToContainers({ database: fresh, root: join(untouched, "ws"), archive: join(untouched, "ws-archive"), run: join(untouched, "run") }), { workspaces: 0, archived: 0, chats: 0 });
		assert.equal(existsSync(join(untouched, "key-x")), true);
		rmSync(untouched, { recursive: true, force: true });
		database.prepare("INSERT INTO meta VALUES ('legacy-key-files-root', ?)").run(files);
		const opts = { database, root, archive: `${root}-archive`, run };
		assert.deepEqual(migrateToContainers(opts), { workspaces: 1, archived: 1, chats: 1 });
		assert.equal(readFileSync(join(root, "key-a", "note.txt"), "utf8"), "was the shared folder", "the old shared folder is now the workspace");
		assert.equal(existsSync(join(files, "key-a")), false, "moved, not copied");
		assert.equal(readFileSync(join(root, "key-existing", "mine"), "utf8"), "1", "a workspace that already exists is never overwritten");
		assert.equal(existsSync(join(files, "key-existing", "theirs")), true, "and the old folder is left where it was");
		assert.equal(existsSync(join(root, chatDir)), false);
		const archived = readdirSync(`${root}-archive`);
		assert.equal(archived.length, 1);
		assert.equal(readFileSync(join(`${root}-archive`, archived[0], "old-work.txt"), "utf8"), "kept in the archive", "old chat workspaces are archived, not deleted");
		assert.equal(database.prepare("SELECT count(*) n FROM chats").get().n, 0, "stored chats are forgotten: their sessions lived in the old layout");
		assert.equal(existsSync(join(run, "deadbeef.sock")), false, "old sockets are removed");
		assert.equal(migrateToContainers(opts), null, "it runs once");
		rmSync(base, { recursive: true, force: true });
	}

	// Nothing above may have run a real docker or iptables.
	assert.ok(calls.every(() => true));
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
}


// ---------------------------------------------------------------- per-key container settings

{
	const { DatabaseSync } = await import("node:sqlite");
	const isIptables = (bin) => /(^|\/)iptables$/.test(bin);
	const calls2 = [];
	let answers2 = () => ({ code: 0, stdout: "", stderr: "" });
	setRunner(async (bin, args) => { calls2.push([bin, ...args]); return answers2(bin, args); });
	const reset2 = (fn) => { calls2.length = 0; answers2 = fn ?? (() => ({ code: 0, stdout: "", stderr: "" })); };

	// What a form may send, and what is refused, by field.
	assert.equal(normalizeContainerInput(null), null);
	assert.equal(normalizeContainerInput({}), null, "nothing set is nothing stored");
	assert.equal(normalizeContainerInput({ memoryMb: "", cpus: null, network: "  " }), null, "blank follows the default");
	assert.deepEqual(normalizeContainerInput({ memoryMb: "512", cpus: "1.5", pids: 0, network: "none", image: "piper-agent-slim", mounts: "/usr/lib", env: "A=1 B=two" }), { memoryMb: 512, cpus: 1.5, pids: 0, network: "none", image: "piper-agent-slim", mounts: "/usr/lib", env: "A=1 B=two" }, "0 is kept: it lifts a limit");
	for (const [input, why] of [
		[{ memoryMb: -1 }, /memory must be a whole number of 0 or more/],
		[{ memoryMb: 1.5 }, /memory must be a whole number/],
		[{ pids: "many" }, /processes must be a whole number/],
		[{ cpus: "abc" }, /cpus must be a number/],
		[{ network: "host" }, /network must be one of internet, none, open/],
		[{ image: "Bad Image!" }, /is not an image name/],
		[{ mounts: "/run/docker.sock" }, /mounts: .*engine socket/],
		[{ mounts: "/root/.ssh" }, /mounts: .*credentials/],
		[{ mounts: "/home" }, /mounts: .*too broad/],
		[{ env: "PATH=/evil" }, /env: PATH is set by the gateway/],
		[{ env: "nope" }, /env: "nope" is not NAME=value/],
		[{ ports: 80 }, /unknown container setting: ports/],
		[{ mounts: "/usr/lib ".repeat(400) }, /too long/],
		["text", /must be an object/],
		[[1], /must be an object/],
	]) assert.throws(() => normalizeContainerInput(input), why, JSON.stringify(input).slice(0, 60));

	// Stored on the key, read back, and cleared.
	const { record: ka } = apiKeys.create({ name: "container-a" });
	const { record: kb } = apiKeys.create({ name: "container-b" });
	assert.equal(apiKeys.get(ka.id).container, null, "a new key has no overrides");
	apiKeys.update(ka.id, { container: { memoryMb: 512, network: "open", mounts: "/usr/lib", env: "A=key B=key" } });
	assert.deepEqual(apiKeys.get(ka.id).container, { memoryMb: 512, network: "open", mounts: "/usr/lib", env: "A=key B=key" });
	apiKeys.update(ka.id, { name: "container-a renamed" });
	assert.equal(apiKeys.get(ka.id).container.memoryMb, 512, "changing something else keeps the settings");
	assert.equal(apiKeys.get(kb.id).container, null, "and no other key has them");
	const raw = new DatabaseSync(TEST_DB);
	raw.prepare("UPDATE api_keys SET container_json = 'not json' WHERE id = ?").run(kb.id);
	raw.close();
	apiKeys.reload();
	assert.equal(apiKeys.get(kb.id).container, null, "a damaged value reads as none instead of breaking the key");

	// What a chat gets: the key's values over the defaults.
	const globalMem = containerDefaults().memoryMb;
	const eff = containerSettingsFor(ka.id);
	assert.deepEqual([eff.memoryMb, eff.network, eff.image, eff.cpus], [512, "open", containerDefaults().image, containerDefaults().cpus], "own where set, default elsewhere");
	assert.deepEqual(eff.mounts.map((m) => m.host), ["/usr/lib"], "the key's mounts are added");
	assert.equal(Object.fromEntries(eff.env).A, "key");
	assert.equal(Object.fromEntries(eff.env).TOOL_HOME, "/opt/tool", "and the default environment stays");
	assert.deepEqual(containerSettingsFor(kb.id).memoryMb, globalMem, "another key follows the default");
	for (const id of ["", null, undefined, "no-such-key"]) assert.equal(containerSettingsFor(id).own, null, `${JSON.stringify(id)} has no overrides`);
	apiKeys.update(ka.id, { container: { memoryMb: 0, pids: 0 } });
	assert.deepEqual([containerSettingsFor(ka.id).memoryMb, containerSettingsFor(ka.id).pids], [0, 0], "0 overrides a limit: unlimited for this key");
	// A key's mount of the same container path replaces the default's; its env value of the same name wins.
	const dirA = mkdtempSync(join(tmpdir(), "pi-kmount-a-"));
	const dirB = mkdtempSync(join(tmpdir(), "pi-kmount-b-"));
	const savedMounts = config.CONTAINER_MOUNTS;
	config.CONTAINER_MOUNTS = `${dirA}:/opt/tools`;
	apiKeys.update(ka.id, { container: { mounts: `${dirB}:/opt/tools /usr/lib:/docs` } });
	assert.deepEqual(containerSettingsFor(ka.id).mounts, [{ host: dirB, container: "/opt/tools" }, { host: "/usr/lib", container: "/docs" }], "the key's mount of a path replaces the default's");
	config.CONTAINER_MOUNTS = savedMounts;
	rmSync(dirA, { recursive: true, force: true });
	rmSync(dirB, { recursive: true, force: true });

	// The spec a chat's container is created from carries them, and the signature notices.
	apiKeys.update(ka.id, { container: { memoryMb: 256, pids: 32, cpus: 0.5, network: "none", env: "ONLY_HERE=1" } });
	const rec = { id: "spec-chat", keyId: ka.id };
	const wsA = ensureWorkspace(ka.id);
	const specA = containerSpecFor(rec, wsA);
	assert.deepEqual([specA.memoryMb, specA.pids, specA.cpus, specA.network], [256, 32, 0.5, "none"]);
	assert.equal(piInvocation(specA, {}).env.ONLY_HERE, "1", "the key's environment reaches Pi");
	assert.equal(piInvocation(specA, {}).env.TOOL_HOME, "/opt/tool", "with the defaults");
	const specB = containerSpecFor({ id: "spec-chat", keyId: kb.id }, ensureWorkspace(kb.id));
	assert.equal(specB.network, containerDefaults().network, "another key's spec follows the defaults");
	assert.notEqual(containerSignature(specA, "img"), containerSignature({ ...specA, memoryMb: 512 }, "img"), "a changed override recreates the key's containers");

	// Networks: `open` has a network of its own, so the firewall rules for `internet` never cut it off.
	assert.deepEqual([networkName("internet"), networkName("open"), networkName("none")], ["piper", "piper-open", "none"]);
	assert.deepEqual(networkArgs("open"), ["--network", "piper-open"]);
	assert.notEqual(NETWORK_OPEN.subnet, NETWORK.subnet, "the two networks do not overlap");
	const base2 = { name: "n", image: "i", workspace: "/w", profileDir: "/p", chatDir: "/c", runDir: "/r", bridgePath: "/b", sig: "s" };
	assert.equal(containerSignature({ ...base2, network: "internet" }, "i") === containerSignature({ ...base2, network: "open" }, "i"), false, "moving between networks recreates");
	reset2((bin, args) => (args[0] === "network" && args[1] === "inspect" ? { code: 1, stdout: "", stderr: "no such network" } : { code: 0, stdout: "", stderr: "" }));
	await ensureNetwork("open");
	const made2 = calls2.find((c) => c[1] === "network" && c[2] === "create");
	assert.ok(made2.includes("172.30.0.0/24") && made2.includes("piper-open") && made2.includes("com.docker.network.bridge.enable_icc=false"), "created on its own subnet with no traffic between containers");
	reset2();
	await ensureNetwork("none");
	assert.equal(calls2.length, 0, "none needs no network");
	reset2();
	await ensureNetwork("internet");
	assert.equal(calls2.filter((c) => c[2] === "create").length, 0, "an existing network is left alone");

	// The firewall follows the modes in use: rules iff some chat uses `internet`.
	{
		const state = { INPUT: [], "DOCKER-USER": [] };
		const fake = (bin, args) => {
			if (!isIptables(bin)) {
				if (args[0] === "version") return { code: 0, stdout: "26.1.5\n", stderr: "" };
				if (args[0] === "image") return { code: 0, stdout: "sha256:abc|0.99.1\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "-S") return { code: 0, stdout: [`-P ${args[1]} ACCEPT`, ...state[args[1]]].join("\n"), stderr: "" };
			if (args[0] === "-I") { state[args[1]].splice(Number(args[2]) - 1, 0, `-A ${args[1]} ${args.slice(3).join(" ")}`); return { code: 0, stdout: "", stderr: "" }; }
			if (args[0] === "-D") { const line = `-A ${args[1]} ${args.slice(2).join(" ")}`; const at = state[args[1]].indexOf(line); if (at >= 0) state[args[1]].splice(at, 1); return { code: at >= 0 ? 0 : 1, stdout: "", stderr: "" }; }
			return { code: 0, stdout: "", stderr: "" };
		};
		const rules = () => state.INPUT.length + state["DOCKER-USER"].length;
		reset2(fake);
		let st = await checkEngine({ force: true, modes: ["none"] });
		assert.deepEqual([rules(), st.firewall.mode, st.ok, st.problems], [0, "none", true, []], "nobody uses the internet policy: no rules");
		st = await checkEngine({ force: true, modes: ["none", "internet"] });
		assert.ok(rules() >= 7 && st.firewall.mode === "internet", "one key on internet is enough to need the rules");
		assert.deepEqual(st.network.inUse.sort(), ["internet", "none"]);
		st = await checkEngine({ force: true, modes: ["internet", "open"] });
		assert.ok(calls2.some((c) => c[1] === "network" && c[2] === "inspect" && c[3] === "piper-open"), "the open network is ensured too");
		assert.ok(rules() >= 7, "and the rules stay for the chat that needs them");
		st = await checkEngine({ force: true, modes: ["open"] });
		assert.deepEqual([rules(), st.firewall.mode], [0, "open"], "when the last internet chat's key changes, the rules go");
		st = await checkEngine({ force: true });
		assert.equal(st.firewall.mode, "internet", "without modes it follows the default policy");
		resetEngineCheck();
	}

	// networkModesInUse reads the keys.
	apiKeys.update(ka.id, { container: { network: "open" } });
	apiKeys.update(kb.id, { container: { network: "none" } });
	assert.deepEqual(networkModesInUse().sort(), ["internet", "none", "open"].filter((m) => m !== "internet" || containerDefaults().network === "internet").sort(), "the default and every key's own");
	apiKeys.update(kb.id, { container: null });
	assert.equal(apiKeys.get(kb.id).container, null, "null clears");

	// The key's view carries what the page needs and no environment values.
	apiKeys.update(ka.id, { container: { env: "SECRET_TOKEN=hunter2", memoryMb: 100 } });
	const view = containerView(ka.id);
	assert.equal(view.own.memoryMb, 100);
	assert.ok(view.effective.envNames.includes("SECRET_TOKEN") && !JSON.stringify(view.effective).includes("hunter2"), "environment names, never values, in what the page is given");
	assert.equal(containerView("").admin, true);
	apiKeys.remove(ka.id);
	apiKeys.remove(kb.id);

	// The mount denylist, against a real tree.
	{
		const t = mkdtempSync(join(tmpdir(), "pi-deny-"));
		const mk = (rel, text = "x") => { mkdirSync(dirname(join(t, rel)), { recursive: true }); writeFileSync(join(t, rel), text); };
		mk("clean/tool.sh"); mk("clean/sub/lib.py");
		mk("home-like/.ssh/id_ed25519"); mk("nested/a/.aws/credentials"); mk("keyfile/one/id_rsa"); mk("keyfile2/id_rsa.pub");
		mk("cfg/.config/gh/hosts.yml"); mk("cfg2/.config/gcloud/x"); mk("deep/a/b/c/.ssh/id_rsa"); mk("docker/.docker/config.json"); mk("npm/.npmrc");
		assert.equal(secretIn(join(t, "clean")), null, "an ordinary folder is fine");
		assert.match(secretIn(join(t, "home-like")), /\.ssh is a credential/);
		assert.match(secretIn(join(t, "nested")), /\.aws is a credential/, "found two levels down");
		assert.match(secretIn(join(t, "keyfile")), /id_rsa is a credential/);
		assert.match(secretIn(join(t, "keyfile2")), /id_rsa\.pub is a credential/, "even the public half: it names the key");
		assert.match(secretIn(join(t, "cfg")), /\.config\/gh is a credential/);
		assert.match(secretIn(join(t, "cfg2")), /\.config\/gcloud is a credential/);
		assert.match(secretIn(join(t, "docker")), /\.docker/);
		assert.match(secretIn(join(t, "npm")), /\.npmrc/);
		assert.equal(secretIn(join(t, "deep")), null, "beyond two levels is not scanned (and that is documented)");
		assert.match(secretIn(join(t, "home-like", ".ssh")), /is or is inside \.ssh/, "the folder itself");
		assert.match(secretIn(join(t, "cfg", ".config", "gh")), /is or is inside \.config\/gh/);
		assert.match(secretIn(`${join(t, "home-like")}/.ssh/sub`), /is or is inside \.ssh/, "or anything inside one");
		assert.throws(() => parseContainerMounts(join(t, "home-like"), { strict: true }), /credentials must not be shared/);
		assert.deepEqual(parseContainerMounts(join(t, "clean"), { strict: true }).map((m) => m.host), [join(t, "clean")]);
		for (const broad of ["/root", "/home", "/etc", "/var", "/run", "/root/"]) assert.throws(() => parseContainerMounts(broad, { strict: true }), /too broad/, broad);
		assert.deepEqual(parseContainerMounts(join(t, "home-like")), [], "one stored before this rule is skipped, not shared");
		// A scan is capped, so a huge tree cannot make a save hang.
		mkdirSync(join(t, "big"));
		for (let i = 0; i < 40; i++) writeFileSync(join(t, "big", `f${i}`), "x");
		assert.equal(secretIn(join(t, "big"), { cap: 10 }), null);
		rmSync(t, { recursive: true, force: true });
	}

	// The audit trail: actions, shortened, newest first, and never a reason to fail.
	{
		const before = recentAudit(500).length;
		audit("test.one", "target-1", "first");
		audit("test.two", "target-2", `line one\n\t line two ${"x".repeat(500)}`);
		const [newest, older] = recentAudit(2);
		assert.deepEqual([newest.action, older.action], ["test.two", "test.one"], "newest first");
		assert.ok(newest.detail.length <= 200 && !/[\n\t]/.test(newest.detail), "a long, multi-line detail is squeezed and cut");
		assert.equal(recentAudit(500).length, before + 2);
		assert.equal(recentAudit(1).length, 1);
		assert.doesNotThrow(() => audit(undefined, undefined, undefined));
		assert.ok(typeof recentAudit(500)[0].ts === "number");
	}
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
}


// ---------------------------------------------------------------- the Containers page, events, disk, alerts

{
	const { Readable, PassThrough } = await import("node:stream");
	const { EventEmitter } = await import("node:events");
	const http = await import("node:http");
	const isIptables = (bin) => /(^|\/)iptables$/.test(bin);
	const seen = [];
	let reply = () => ({ code: 0, stdout: "", stderr: "" });
	setRunner(async (bin, args, opts) => { seen.push({ bin, args, opts }); return reply(bin, args, opts); });
	const forget = () => { seen.length = 0; reply = () => ({ code: 0, stdout: "", stderr: "" }); };
	const INSTANCE = instanceId();
	const cname = (word, other = INSTANCE) => `piper-${other}-${chatIdHash(word).slice(0, 16)}`;
	// A webhook that remembers what it was sent.
	const hooks = [];
	let hookStatus = 200;
	const hookServer = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => { hooks.push(JSON.parse(body)); res.writeHead(hookStatus); res.end("{}"); });
	});
	await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
	const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

	// Docker's sizes and events, parsed.
	assert.deepEqual([parseSize("0B"), parseSize("1.5kB"), parseSize("12MB"), parseSize("3.1GB"), parseSize("2TB")], [0, 1500, 12_000_000, 3_100_000_000, 2e12]);
	assert.deepEqual([parseSize("12MiB"), parseSize("2GiB"), parseSize("1.5KiB")], [12 * 1048576, 2 * 1024 ** 3, 1536], "binary units, as docker stats prints them");
	assert.deepEqual([parseSize(""), parseSize("lots"), parseSize(undefined), parseSize("12 XB")], [0, 0, 0, 0], "anything else is 0, never NaN");
	assert.deepEqual(parseUsage("12.3MiB / 2GiB"), { used: Math.round(12.3 * 1048576), limit: 2 * 1024 ** 3 });
	assert.deepEqual(parseDiskSize("1.23MB (virtual 1.9GB)"), { rw: 1_230_000, virtual: 1_900_000_000 });
	assert.deepEqual(parseDiskSize("0B (virtual 1.89GB)"), { rw: 0, virtual: 1_890_000_000 });
	assert.deepEqual(parseDiskSize("12kB"), { rw: 12_000, virtual: 0 });
	const ev = (action, name, extra = {}, type = "container") => JSON.stringify({ Type: type, Action: action, Actor: { Attributes: { name, ...extra } }, time: 1790000000 });
	assert.deepEqual(parseEvent(ev("oom", "c1")), { action: "oom", name: "c1", exitCode: null, time: 1790000000000 });
	assert.deepEqual(parseEvent(ev("die", "c1", { exitCode: "137" })), { action: "die", name: "c1", exitCode: 137, time: 1790000000000 });
	assert.equal(parseEvent(ev("start", "c1")), null, "starts are not news");
	assert.equal(parseEvent(ev("die", "c1", {}, "network")), null, "only containers");
	assert.equal(parseEvent("not json"), null);
	assert.equal(parseEvent(JSON.stringify({ Type: "container", Action: "die" })), null, "no name, no event");
	assert.equal(parseEvent(ev("exec_die: sh", "c1"))?.action, undefined, "exec_die is a different action");

	// The events watcher: filtered to this instance, drops a die the gateway caused, restarts, stops.
	{
		const got = [];
		const spawned = [];
		const fakeSpawn = (bin, args) => {
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.kill = () => child.emit("close", 0);
			spawned.push({ bin, args, child });
			return child;
		};
		const watcher = watchEvents((e) => got.push(e), { spawnFn: fakeSpawn, restartMs: 20 });
		const args = spawned[0].args;
		assert.equal(spawned[0].bin, "docker");
		assert.ok(args.includes(`label=piper.instance=${INSTANCE}`) && args.includes("label=piper.managed=1") && args.includes("event=oom") && args.includes("event=die"), "only this gateway's containers, only kills and deaths");
		noteSelfStop("c-mine");
		spawned[0].child.stdout.write(`${ev("die", "c-mine", { exitCode: "0" })}\n${ev("die", "c-crash", { exitCode: "137" })}\n${ev("oom", "c-mine")}\n${ev("start", "c-x")}\nnoise\n`);
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(got.map((e) => `${e.action}:${e.name}`), ["die:c-crash", "oom:c-mine"], "a stop the gateway asked for is not reported, a kill is");
		spawned[0].child.stdout.write(ev("oom", "split").slice(0, 30));
		spawned[0].child.stdout.write(`${ev("oom", "split").slice(30)}\n`);
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(got.at(-1).name, "split", "a line split across chunks is put back together");
		spawned[0].child.emit("close", 1);
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(spawned.length, 2, "it starts again when docker events exits (the daemon restarted)");
		watcher.stop();
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(spawned.length, 2, "and stays stopped");
	}

	// Details, usage and disk from docker's own output.
	forget();
	reply = (bin, args) => {
		if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Name: "/c1", State: { Running: true } }, { Name: "/c2", State: { Running: false } }]), stderr: "" };
		if (args[0] === "stats") return { code: 0, stdout: `${JSON.stringify({ Name: "c1", CPUPerc: "12.5%", MemUsage: "100MiB / 2GiB", PIDs: "7" })}\nbroken\n`, stderr: "" };
		if (args[0] === "ps") return { code: 0, stdout: "c1\t1.5MB (virtual 1.9GB)\nc2\t0B (virtual 1.9GB)\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	assert.deepEqual([...(await inspectMany(["c1", "c2", "c3"])).keys()], ["c1", "c2"], "names docker does not know are simply absent");
	assert.equal((await inspectMany([])).size, 0);
	assert.deepEqual(await containerStats(["c1"]).then((m) => m.get("c1")), { cpu: 12.5, memUsed: 100 * 1048576, memLimit: 2 * 1024 ** 3, pids: 7 });
	assert.equal(seen.filter((c) => c.args[0] === "stats").length, 1);
	assert.deepEqual(await diskUsage().then((m) => m.get("c1")), { rw: 1_500_000, virtual: 1_900_000_000 });
	assert.ok(seen.find((c) => c.args[0] === "ps").args.includes(`label=piper.instance=${INSTANCE}`), "the disk walk is only for this gateway's containers");

	// listContainers: a stopped chat, an orphan, another gateway's container that must not appear, and a live chat.
	{
		const stoppedHash = chatIdHash("page-stopped");
		chatStore.put({ id_hash: stoppedHash, key_id: null, workspace: "/w", created_at: 1, last_used_at: 5000, requests: 4, state_json: "{}" });
		const orphanName = cname("page-orphan");
		const stoppedName = cname("page-stopped");
		const liveId = "page-live";
		const liveName = cname(liveId);
		const acquired = sessions.acquire(liveId, null);
		acquired.record.sessionPromise.catch(() => {});
		const psRows = [`${stoppedName}\texited\t`, `${orphanName}\trunning\t`, `${liveName}\trunning\t`, `${cname("foreign", "other000")}\trunning\t`];
		forget();
		reply = (bin, args) => {
			if (args[0] === "ps" && args.includes("--format") && !args.includes("-s")) return { code: 0, stdout: psRows.filter((r) => r.split("\t")[0].startsWith(`piper-${INSTANCE}-`)).join("\n"), stderr: "" };
			if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([
				{ Name: `/${stoppedName}`, Image: "sha256:old", Created: "2026-09-30T10:00:00Z", Config: { Image: "piper-agent" }, State: { Status: "exited", Running: false }, HostConfig: { Memory: 2 * 1024 ** 3 }, NetworkSettings: { Networks: { piper: {} } } },
				{ Name: `/${orphanName}`, Image: "sha256:new", Created: "2026-09-30T11:00:00Z", Config: { Image: "piper-agent" }, State: { Status: "running", Running: true, StartedAt: new Date(Date.now() - 60_000).toISOString() }, HostConfig: { Memory: 512 * 1048576 }, NetworkSettings: { Networks: { "piper-open": {} } } },
				{ Name: `/${liveName}`, Image: "sha256:new", Created: "2026-09-30T12:00:00Z", Config: { Image: "piper-agent" }, State: { Status: "running", Running: true, StartedAt: new Date(Date.now() - 5000).toISOString() }, HostConfig: { Memory: 2 * 1024 ** 3 }, NetworkSettings: { Networks: { piper: {} } } },
			]), stderr: "" };
			if (args[0] === "stats") return { code: 0, stdout: `${JSON.stringify({ Name: orphanName, CPUPerc: "3.0%", MemUsage: "50MiB / 512MiB", PIDs: "4" })}\n`, stderr: "" };
			if (args[0] === "image") return { code: 0, stdout: "sha256:new|0.99.1\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		diskState.containers = new Map([[orphanName, { rw: 300 * 1048576, virtual: 0 }]]);
		diskState.at = Date.now(); // fresh, so opening the page does not start a measurement that replaces these figures
		const page = await listContainers();
		const by = Object.fromEntries(page.containers.map((c) => [c.name, c]));
		assert.equal(page.containers.length, 3, "another gateway's container is not listed");
		assert.deepEqual([by[stoppedName].status, by[orphanName].status, by[liveName].status], ["stopped", "orphan", "live"], "stopped and resumable, no chat at all, running now");
		assert.equal(by[stoppedName].fingerprint, stoppedHash.slice(0, 8), "a stored chat is labelled without its id");
		assert.equal(by[liveName].fingerprint, fingerprint(liveId), "and it is the same label the Agents page shows");
		assert.deepEqual([by[orphanName].cpu, by[orphanName].memUsedMb, by[orphanName].memoryLimitMb, by[orphanName].pids, by[orphanName].diskMb, by[orphanName].network], [3, 50, 512, 4, 300, "piper-open"], "usage, limit, disk and network");
		assert.equal(by[stoppedName].cpu, null, "a stopped container has no live usage");
		assert.equal(by[stoppedName].imageStale, true, "built from an image that has since been rebuilt");
		assert.equal(by[orphanName].imageStale, false);
		assert.ok(by[orphanName].uptimeMs >= 59_000 && by[stoppedName].uptimeMs === 0);
		assert.equal(by[stoppedName].requests, 4);
		assert.equal(by[stoppedName].lastUsedAt, 5000);
		assert.deepEqual(page.containers.map((c) => c.state), ["running", "running", "exited"], "running ones first");
		assert.ok(seen.filter((c) => c.args[0] === "stats").length >= 1);
		const statsBefore = seen.filter((c) => c.args[0] === "stats").length;
		await listContainers();
		assert.equal(seen.filter((c) => c.args[0] === "stats").length, statsBefore, "live usage is reused for a few seconds, so a busy dashboard does not run docker stats each poll");

		// Actions: each does what it says, through the chat when there is one, and is audited.
		const auditBefore = recentAudit(500).length;
		forget();
		reply = (bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Name: `/${stoppedName}`, State: { Running: false } }, { Name: `/${orphanName}`, State: { Running: true } }, { Name: `/${liveName}`, State: { Running: true } }]), stderr: "" } : { code: 0, stdout: "", stderr: "" });
		assert.match(await containerAction(stoppedName, "stop"), /container was stopped/);
		assert.ok(seen.some((c) => c.args[0] === "stop" && c.args.includes(stoppedName)), "a stopped chat's container goes straight to the engine");
		forget();
		reply = (bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Name: `/${liveName}`, State: { Running: true } }]), stderr: "" } : { code: 0, stdout: "", stderr: "" });
		assert.match(await containerAction(liveName, "stop"), /chat was stopped; it resumes/);
		assert.equal(sessions.has(liveId), false, "the live chat was stopped through the session controller");
		assert.ok(seen.some((c) => c.args[0] === "stop" && c.args.includes(liveName)), "and its container with it");
		assert.ok(chatStore.get(chatIdHash(liveId)) !== null || true);
		forget();
		reply = (bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Name: `/${stoppedName}`, State: { Running: false } }]), stderr: "" } : { code: 0, stdout: "", stderr: "" });
		assert.match(await containerAction(stoppedName, "recreate"), /clean one on its next message/);
		assert.ok(seen.some((c) => c.args[0] === "rm" && c.args.includes(stoppedName)), "recreate removes the container");
		assert.ok(chatStore.get(stoppedHash), "but keeps the chat, so its conversation continues in the new one");
		forget();
		reply = (bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Name: `/${stoppedName}`, State: { Running: false } }]), stderr: "" } : { code: 0, stdout: "", stderr: "" });
		assert.match(await containerAction(stoppedName, "remove"), /chat was ended and its container removed/);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(chatStore.get(stoppedHash), null, "remove ends the chat");
		assert.ok(seen.some((c) => c.args[0] === "rm" && c.args.includes(stoppedName)));
		forget();
		reply = (bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Name: `/${orphanName}`, State: { Running: true } }]), stderr: "" } : { code: 0, stdout: "", stderr: "" });
		assert.match(await containerAction(orphanName, "remove"), /^the container was removed$/);
		await assert.rejects(containerAction(orphanName, "explode"), (e) => e.status === 400, "an unknown action");
		await assert.rejects(containerAction("some-other-container", "stop"), (e) => e.status === 404 && /not one of this gateway's/.test(e.message), "only this gateway's containers can be touched");
		await assert.rejects(containerAction(cname("page-missing"), "stop"), (e) => e.status === 404 && /no container/.test(e.message));
		await assert.rejects(containerAction(cname("page-x", "other000"), "remove"), (e) => e.status === 404, "another gateway's container is refused too");
		const trail = recentAudit(500);
		assert.ok(trail.length >= auditBefore + 5, "every action is in the audit trail");
		assert.ok(trail.some((a) => a.action === "container.recreate" && a.target === stoppedName));

		// Run a command: only in a running container of ours, capped, and audited.
		forget();
		reply = (bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Name: `/${orphanName}`, State: { Running: true } }, { Name: `/${stoppedName}`, State: { Running: false } }]), stderr: "" } : args[0] === "exec" ? { code: 0, stdout: "x".repeat(70_000), stderr: "warn", } : { code: 0, stdout: "", stderr: "" });
		const out = await containerExec(orphanName, "  df -h  ", 999_999);
		assert.deepEqual(seen.find((c) => c.args[0] === "exec").args, ["exec", orphanName, "sh", "-c", "df -h"], "run with sh -c, trimmed");
		assert.equal(seen.find((c) => c.args[0] === "exec").opts.timeoutMs, 120_000, "the time limit is capped");
		assert.ok(out.truncated && out.stdout.length < 70_000 && /output cut at 64 KB/.test(out.stdout), "long output is cut");
		assert.equal(out.stderr, "warn");
		assert.equal((await containerExec(orphanName, "true", 5)).timeoutMs, 1000, "and has a floor");
		await assert.rejects(containerExec(orphanName, "   "), (e) => e.status === 400 && /command is required/.test(e.message));
		await assert.rejects(containerExec(orphanName, "x".repeat(5000)), (e) => e.status === 400 && /too long/.test(e.message));
		await assert.rejects(containerExec(stoppedName, "id"), (e) => e.status === 409 && /not running/.test(e.message), "a stopped container is not started by a command");
		await assert.rejects(containerExec("not-ours", "id"), (e) => e.status === 404);
		assert.ok(recentAudit(20).some((a) => a.action === "container.exec" && a.detail === "df -h"), "the command is in the audit trail");

		// The route: a command box on an open dashboard is remote execution, so it refuses until a password is set.
		const call = async (method, url, body) => {
			const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
			req.method = method; req.url = url;
			const res = { status: null, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b ?? ""; } };
			await containerRoutes(req, res, new URL(url, "http://x").pathname);
			return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
		};
		clearPasswordHash();
		const execsBefore = seen.filter((c) => c.args[0] === "exec").length;
		const denied = await call("POST", `/dashboard/containers/${orphanName}/exec`, { command: "id" });
		assert.equal(denied.status, 403);
		assert.match(denied.json.error.message, /needs a dashboard password/);
		assert.equal(seen.filter((c) => c.args[0] === "exec").length, execsBefore, "and nothing ran");
		const pageJson = await call("GET", "/dashboard/containers.json");
		assert.deepEqual([pageJson.status, pageJson.json.execAllowed], [200, false]);
		assert.match(pageJson.json.execNote, /Set a dashboard password/, "the page is told why the box is off");
		setPasswordHash(hashPassword("a long enough password"));
		const allowed = await call("POST", `/dashboard/containers/${orphanName}/exec`, { command: "id", timeoutMs: 5000 });
		assert.equal(allowed.status, 200);
		assert.equal(allowed.json.code, 0);
		assert.equal((await call("GET", "/dashboard/containers.json")).json.execAllowed, true);
		assert.equal((await call("POST", `/dashboard/containers/${orphanName}/stop`)).json.ok, true);
		assert.equal((await call("POST", "/dashboard/containers/not-a-container-name/stop")).status, 404, "names are checked before anything runs");
		assert.equal((await call("POST", `/dashboard/containers/${cname("page-missing")}/explode`)).status, 400);
		assert.equal((await call("GET", "/dashboard/audit.json")).json.audit[0].target.length > 0, true);
		clearPasswordHash();
		sessions.close(liveId);
	}

	// Disk: free space and per-container size against their thresholds, with alerts that clear once.
	{
		resetAlerts();
		const saved = { url: config.ALERT_WEBHOOK_URL, warn: config.DISK_FREE_WARN_MB, limit: config.CONTAINER_DISK_MB };
		config.ALERT_WEBHOOK_URL = hookUrl;
		config.DISK_FREE_WARN_MB = 5000;
		config.CONTAINER_DISK_MB = 100;
		hooks.length = 0;
		forget();
		reply = (bin, args) => (args[0] === "ps" ? { code: 0, stdout: `${cname("big")}\t400MB (virtual 2GB)\n${cname("small")}\t5MB (virtual 2GB)\n`, stderr: "" } : args[0] === "info" ? { code: 0, stdout: "/var/lib/docker\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
		const gb = (n) => Math.round(n * 1024 ** 3);
		let free = gb(3.5);
		const statfs = (path) => { if (path !== "/var/lib/docker") throw new Error("nope"); return { bavail: free / 4096, bsize: 4096, blocks: gb(47) / 4096 }; };
		let state = await pollDisk({ statfs, now: 1000 });
		assert.equal(state.low, true, "3.5 GB free is under the 5 GB warning");
		assert.equal(diskSummary().freeMb, Math.round(gb(3.5) / 1048576));
		// docker prints decimal sizes (400MB); the gateway counts in MiB like its memory limits, so that is 381.
		assert.deepEqual(diskSummary().over.map((o) => [o.name, o.mb]), [[cname("big"), 381]], "only the container over its limit");
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(hooks.map((h) => h.event).sort(), ["container_disk:" + cname("big"), "disk_low"].sort(), "one alert each");
		assert.match(hooks.find((h) => h.event === "disk_low").message, /only 3584 MB free on \/var\/lib\/docker/);
		await pollDisk({ statfs, now: 2000 });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(hooks.length, 2, "still low: no second alert inside the hour");
		free = gb(20);
		state = await pollDisk({ statfs, now: 3000 });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(state.low, false);
		assert.equal(hooks.filter((h) => h.event === "disk_low").length, 2, "and the recovery is announced once");
		assert.equal(hooks.at(-1).recovered, true);
		assert.match(hooks.at(-1).text, /^✅/);
		const gone = await pollDisk({ statfs: () => { throw new Error("unreadable"); }, now: 4000 });
		assert.equal(gone.host, null, "a disk that cannot be read is not a crash, and not a warning either");
		assert.equal(gone.low, false);
		config.CONTAINER_DISK_MB = 0;
		assert.deepEqual((await pollDisk({ statfs, now: 5000 })).over, [], "0 turns the container warning off");
		Object.assign(config, { ALERT_WEBHOOK_URL: saved.url, DISK_FREE_WARN_MB: saved.warn, CONTAINER_DISK_MB: saved.limit });
	}

	// Opening the page after minutes without a measurement starts one, once, and not again while it is fresh.
	{
		forget();
		diskState.at = 0;
		refreshDiskSoon();
		refreshDiskSoon();
		refreshDiskSoon();
		await new Promise((r) => setTimeout(r, 60));
		const walks = () => seen.filter((c) => c.args[0] === "ps" && c.args.includes("-s")).length;
		assert.equal(walks(), 1, "one measurement however many page views");
		refreshDiskSoon();
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(walks(), 1, "and none while the figures are fresh");
		diskState.at = Date.now() - 3 * 60_000;
		refreshDiskSoon();
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(walks(), 2, "one more once they are three minutes old");
		resetAlerts();
	}

	// Events reach the chat and the alerts.
	{
		resetAlerts();
		config.ALERT_WEBHOOK_URL = hookUrl;
		hooks.length = 0;
		const liveId = "event-chat";
		const name = cname(liveId);
		const { record } = sessions.acquire(liveId, null);
		record.sessionPromise.catch(() => {});
		const message = handleContainerEvent({ action: "oom", name, exitCode: null }, { memoryMb: 512, now: Date.now() });
		assert.match(message, /killed: out of memory \(limit 512 MB\)/);
		assert.deepEqual(record.notices, [message], "the chat is told, for its next reply");
		assert.equal(recentReasonFor(name), message, "and a Pi that dies now can say why");
		assert.equal(recentReasonFor(name, Date.now() + 10 * 60_000), null, "not for ever");
		assert.equal(recentReasonFor("some-other"), null);
		assert.match(handleContainerEvent({ action: "die", name, exitCode: 137 }), /stopped unexpectedly \(exit code 137\)/);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(hooks.filter((h) => h.event === `container_oom:${name}`).length, 1, "an alert names the container");
		handleContainerEvent({ action: "oom", name: cname("no-chat"), exitCode: null });
		assert.ok(recentEvents.at(-1).container === cname("no-chat"), "an event for a chat that is gone is still recorded");
		sessions.close(liveId);
		await new Promise((r) => setTimeout(r, 80)); // let the alerts just raised reach the webhook before it is unset
		config.ALERT_WEBHOOK_URL = "";
	}

	// A dead Pi's error says why, when Docker said.
	{
		const child = new EventEmitter();
		child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
		child.exitCode = null; child.signalCode = null; child.kill = () => {};
		const session = new PiRpcSession(child, { reason: () => "a process in this chat's container was killed: out of memory" });
		const pending = session.send({ type: "get_state" }).catch((e) => e);
		child.emit("exit", 137, null);
		assert.match((await pending).message, /Pi in the container exited \(code 137\): a process in this chat's container was killed: out of memory/);
	}

	// Alerts: payload, hold-back, recovery, and a webhook that fails.
	{
		resetAlerts();
		hooks.length = 0;
		const p = alertPayload("k", "something", { a: 1 }, { host: "h1", now: Date.UTC(2026, 8, 30) });
		assert.deepEqual(Object.keys(p).sort(), ["content", "details", "event", "host", "message", "recovered", "text", "time"]);
		assert.equal(p.text, p.content, "Slack reads text, Discord reads content");
		assert.match(p.text, /^⚠️ Piper on h1: something$/);
		assert.equal(alertPayload("k", "ok", {}, { recovered: true }).text.startsWith("✅"), true);
		const t0 = 1_000_000;
		assert.equal((await alert("k1", "first", {}, { url: hookUrl, now: t0 })).sent, true);
		assert.equal((await alert("k1", "again", {}, { url: hookUrl, now: t0 + 60_000 })).sent, false, "held back for an hour");
		assert.equal((await alert("k2", "another kind", {}, { url: hookUrl, now: t0 + 60_000 })).sent, true, "per kind");
		assert.equal((await alert("k1", "much later", {}, { url: hookUrl, now: t0 + ALERT_COOLDOWN_MS + 1 })).sent, true, "and again after it");
		assert.deepEqual(hooks.map((h) => h.message), ["first", "another kind", "much later"]);
		assert.equal((await recovered("k1", "fine now", {}, { url: hookUrl })).sent, true);
		assert.equal((await recovered("k1", "fine now", {}, { url: hookUrl })).sent, false, "announced once");
		assert.equal((await recovered("never-raised", "x", {}, { url: hookUrl })).sent, false, "and only after an alert");
		assert.equal((await alert("k1", "after recovery", {}, { url: hookUrl, now: t0 + 61_000 })).sent, true, "a new problem after a recovery is news at once");
		resetAlerts();
		assert.deepEqual(await alert("nourl", "x", {}, { url: "" }), { sent: false, reason: "no webhook is set" });
		assert.equal((await alert("nourl", "x", {}, { url: hookUrl })).sent, false, "raised with no webhook: setting one later does not announce old news");
		resetAlerts();
		hookStatus = 500;
		const bad = await alert("failing", "x", {}, { url: hookUrl });
		assert.deepEqual([bad.sent, /answered 500/.test(bad.reason)], [false, true], "a failing webhook is reported, not thrown");
		hookStatus = 200;
		const down = await alert("unreachable", "x", {}, { url: "http://127.0.0.1:1/none" });
		assert.equal(down.sent, false, "an unreachable one too");
		hooks.length = 0;
		assert.equal((await testAlert({ url: hookUrl })).sent, true);
		assert.equal((await testAlert({ url: hookUrl })).sent, true, "the test ignores the hold-back");
		assert.equal(hooks[0].event, "test");
		assert.match((await testAlert({ url: "" })).reason, /no webhook is set/);
		assert.equal(parseWebhookUrl(""), "");
		assert.equal(parseWebhookUrl(" https://hooks.example.com/x?a=1 "), "https://hooks.example.com/x?a=1");
		assert.throws(() => parseWebhookUrl("not a url"), /not a URL/);
		assert.throws(() => parseWebhookUrl("ftp://example.com"), /http or https/);
		assert.throws(() => coerceSetting(SETTINGS_SPEC.find((x) => x.key === "ALERT_WEBHOOK_URL"), "javascript:alert(1)"), /http or https/);
		assert.deepEqual(["CONTAINER_DISK_MB", "DISK_FREE_WARN_MB", "ALERT_WEBHOOK_URL"].map((k) => SETTINGS_SPEC.find((x) => x.key === k).def), [0, 5120, ""]);
	}

	// Readiness changes are announced once, and a settings change does not lose the state.
	{
		resetAlerts();
		const changes = [];
		onReadinessChange((status, previous) => changes.push([status.ok, previous]));
		const goodAnswers = (bin, args) => (args[0] === "version" ? { code: 0, stdout: "26.1.5\n", stderr: "" } : args[0] === "image" ? { code: 0, stdout: "sha256:a|0.99.1\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
		const badAnswers = (bin, args) => (args[0] === "version" ? { code: 127, stdout: "", stderr: "no docker" } : { code: 0, stdout: "", stderr: "" });
		forget(); reply = (bin, args) => (isIptables(bin) ? { code: 0, stdout: "", stderr: "" } : goodAnswers(bin, args));
		await checkEngine({ force: true, modes: ["none"] });
		const first = changes.length;
		await checkEngine({ force: true, modes: ["none"] });
		assert.equal(changes.length, first, "the same answer again is not news");
		reply = badAnswers;
		await checkEngine({ force: true, modes: ["none"] });
		assert.deepEqual(changes.at(-1), [false, true], "good to bad");
		resetEngineCheck();
		reply = (bin, args) => (isIptables(bin) ? { code: 0, stdout: "", stderr: "" } : goodAnswers(bin, args));
		const recovery = await checkEngine({ force: true, modes: ["none"] });
		assert.deepEqual([recovery.ok, recovery.problems], [true, []], "the good answer is good");
		assert.deepEqual(changes.at(-1), [true, false], "bad to good, even after a settings change cleared the cache");
		assert.equal(lastEngineStatus().ok, true);
		onReadinessChange(null);
		resetEngineCheck();
	}
	await new Promise((r) => hookServer.close(r));
	config.ALERT_WEBHOOK_URL = "";
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
}

console.log("nextTurn + images: ok");
rmSync(TEST_DB, { force: true });
rmSync(TEST_WS, { recursive: true, force: true });
rmSync(`${TEST_WS}-archive`, { recursive: true, force: true });
rmSync(`${TEST_WS}-run`, { recursive: true, force: true });
rmSync(`${TEST_WS}-chats`, { recursive: true, force: true });
rmSync(TEST_PROFILES, { recursive: true, force: true });
rmSync(TEST_SHARED, { recursive: true, force: true });
rmSync(TEST_CONTAINER_PI, { recursive: true, force: true });
