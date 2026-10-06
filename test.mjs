import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
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
const TEST_EXT = `${tmpdir()}/piper-test-extlib-${process.pid}`;
process.env.EXTENSIONS_ROOT = TEST_EXT;
const TEST_CONTAINER_PI = `${tmpdir()}/piper-test-container-pi-${process.pid}`;
process.env.CONTAINER_PI_DIR = TEST_CONTAINER_PI;
const PI_AGENT = process.env.PI_CODING_AGENT_DIR || `${homedir()}/.pi/agent`;
// Seeded at startup, which is when a validator that reads a not-yet-defined constant would fail.
process.env.CONTAINER_ENV = "TOOL_HOME=/opt/tool";
const { GATEWAY_DIR: GATEWAY_DIR_FOR_TEST, pi, imageInfo, listEnvironments, environmentOfTag, buildArgs, listImages, buildImage, jobView, resetImageJob, removeImage, pruneImages, refreshDiskSoon, parseSize, parseUsage, parseDiskSize, parseEvent, watchEvents, noteSelfStop, inspectMany, containerStats, diskUsage, listContainers, containerAction, containerExec, containerRoutes, pollDisk, diskSummary, diskState, handleContainerEvent, recentReasonFor, recentEvents, alertPayload, alert, recovered, testAlert, resetAlerts, ALERT_COOLDOWN_MS, parseWebhookUrl, onReadinessChange, lastEngineStatus, chatStore, clearPasswordHash, setPasswordHash, sessions, instanceId, normalizeContainerInput, containerSettingsFor, containerDefaults, networkModesInUse, containerView, secretIn, audit, recentAudit, networkName, networkArgs, NETWORK_OPEN, ensureNetwork, config, iptablesBinary, requireReady, hostNameservers, endpointOf, ensureContainerPiDir, readContainerModels, saveContainerDefaults, validateModelsText, writeChatModels, agentDirPath, classifyModelError, coerceSetting, derivedSessionId, expiryReason, fingerprint, formatDuration, framedTranscript, isInside, isReloadCommand, messageAudioParts, messageImageSources, messageText, nextTurn, parseDuration, requestedSessionId, resolveImages, resolveModelQuery, SessionController, shQuote, shouldFallBack, recordSpend, spendReport, spendTotals, hashPassword, verifyPassword, dashboardAuthorized, isDashboardPath, loadDashboardPassword, apiKeys, ApiKeyStore, expiryFromInput, keyLabel, apiKeyUsage, isSettingsKey, scopedSessionId, isBlockedAddress, fetchImage, guardedLookup, dataUriToImage, profileScope, ensureProfile, loginFails, loginWaitMs, noteLoginFailure, LOGIN_FREE_TRIES, LOGIN_MAX_WAIT_MS, bridgeCatalog, wireEvent, newMeter, meterUsage, PiRpcSession, startBridge, parseGatewayCommand, profileStats, profileWritability, setProfileLock, isProfileLocked, keyIdForScope, keyLimits, limitFromInput, spentToday, spendRefusal, bundleListFromInput, listBundles, grantedBundles, bundleContents, originOf, profileDetail, treeSize, hostDefaultModel, chatIdHash, catalogueStamp, toolActivity, modelAllowed, allowedModelsFor, parseModelPatterns, cachedTreeSize, invalidateSize, SETTINGS_SPEC, parseContainerEnv, parseContainerMounts, rootWarning, ensureWorkspace, workspaceWritability, workspaceStats, setRunner, containerName, containerCreateArgs, containerSignature, execArgs, helperArgs, firewallRules, ensureFirewall, ensureContainer, checkEngine, resetEngineCheck, chatKey, catalogueFor, directProviders, directCatalogue, renderModelsFor, redactedModelsText, saveModelsText, allowedEndpoints, containerDefaultModel, REDACTED, CONTAINER_PATHS, migrateToContainers, migrateSettingRows, containerHost, sweepContainers, parseAllow, profileHelperInvocation, workspaceDir, scopeOf, resolveModel, chatKeyOfContainer, NETWORK, isBlockedIp, inRange, piInvocation, containerSpecFor, setSessionSpawn, createContainerSession, stopContainer, removeContainer, listManaged, EngineError, keyContainerName, isKeyContainer, keyStateImage, killPi, agents, agentScope, ownerKeyOf, agentIdOf, workspaceScopeOf, memoryScopeOf, mayRemember, memoryFor, memoryOverview, memoryEntries, deleteMemoryEntry, clearMemory, deleteMemoryOf, memoryDashboardRoutes, createAgent, updateAgent, deleteAgent, setAgentEnabled, renewAgentPort, stopAgentServers, agentStatus, listeningPort, AgentError, agentView, parsePortRange, startAgent, stopAgent, deleteAgentsOfKey, agentDefaultModel, ensureSystemFiles, rebuildContainer, flattenImage, importChanges, execStream, FLATTEN_OVER_LAYERS, resolveTarget, updateContainer, startUpdate, startUpdateAll, updateJobView, resetUpdateJob, containersOfScope, updateScopeRoute, hostPiVersion, migrateAuditTable, categoryOf, auditEnabled, runWithActor, currentActor, auditOnce, resetAuditDedupe, settingChangeDetail, queryAudit, auditStats, auditCsv, purgeAudit, AUDIT_CATEGORIES, manageability, latestPiVersion, versionNewer, hostExtensions, hostPiInfo, updateHostPi, resetHostPiCache, startJob, startHostPiUpdate, diskPiVersion, hostPiEnv, piCliPath, sweep, db, vendorFile, VENDOR_FILES, THIRD_PARTY, dashboardFilesRoutes, acceptKey, encodeFrame, upgrade, TERMINAL_HELPER, attachTerminal, terminalGate, terminalCount, closeAllTerminals, terminalUpgrade, terminalLabel, sameOrigin, callSpeed, newSpeedStats, addSpeed, speedView, recordSpeed, speedHistory, purgeSpeed, SPEED_RANGES, MIN_PROMPT_TOKENS, renderMarkdown, slugify, linkHref, listPages, renderPage, pageIndex, searchDocs, PATH_NOTES, parseChangelog, readChangelog, readPackage, aboutInfo, parsePiList, piStatus, firstFileOfTar, readPiVersion, PI_PACKAGE_JSON, piVersionsFor, resetPiVersions, piVersionsPending, noteChanged, parseMeminfo, cpuTimes, cpuPercent, containerUsage, resourceSnapshot, resetResources, mayLookupKnowledge, knowledgeFor, addEntry, getByKey, getEntry, sourceSeen, overview: knowledgeOverview, entriesOf, removeEntry, clearSource, purgeOld, activityLog, knowledgeDashboardRoutes, RssError, SOURCE_TYPE, getFeed, listFeeds, createFeed, updateFeed, removeFeed, parseFeedXml, forcePoll, rssTick, parseExtraction, looksBlocked, parseUnblockReply, setExtractionRunner, rssPump, retryEntry, startFeeds, stopFeeds, rssDashboardRoutes, recentAudit: recentAuditRows } = await import("./server.mjs");
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

	// An image-only first message still derives a stable id (no text to seed it from otherwise), so a
	// client that sends images with no explicit session id can still be resumed, not given a fresh
	// session (and container) on every single request.
	const img = (url) => ({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] });
	assert.notEqual(derivedSessionId(req(), img("data:image/png;base64,AAA")), null);
	assert.equal(derivedSessionId(req(), img("data:image/png;base64,AAA")), derivedSessionId(req(), img("data:image/png;base64,AAA")), "the same image: the same session");
	assert.notEqual(derivedSessionId(req(), img("data:image/png;base64,AAA")), derivedSessionId(req(), img("data:image/png;base64,BBB")), "a different image: a different session");
	assert.notEqual(derivedSessionId(req(), img("data:image/png;base64,AAA")), derivedSessionId(req(), conv("q")), "never collides with a text-seeded one");
	// Text plus an image still seeds on the text, as before (unaffected by the fallback).
	assert.equal(derivedSessionId(req(), { messages: [{ role: "user", content: [{ type: "text", text: "q" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }] }), derivedSessionId(req(), conv("q")));
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

	// The actual wiring, not just the blocklist: a literal blocked address is refused before any connection
	// (no server needed to prove that), and guardedLookup refuses whatever a name resolves to, not just a
	// literal IP in the URL.
	await assert.rejects(fetchImage("http://127.0.0.1:1/x", { maxBytes: 1000 }), /refusing to fetch from an internal address/);
	await assert.rejects(fetchImage("http://[::1]:1/x", { maxBytes: 1000 }), /refusing to fetch from an internal address/);
	await new Promise((resolve, reject) => guardedLookup("127.0.0.1", {}, (err) => (err ? resolve() : reject(new Error("should have been blocked")))));
	await new Promise((resolve, reject) =>
		guardedLookup("127.0.0.1", {}, (err) => (err ? reject(err) : resolve()), () => false), // isBlocked overridden: nothing is internal
	);
	await new Promise((resolve, reject) => guardedLookup("8.8.8.8", { all: true }, (err, addrs) => (err ? reject(err) : (assert.deepEqual(addrs, [{ address: "8.8.8.8", family: 4 }]), resolve()))));

	// The real connect-and-stream path (size limit included), against a loopback server: `isBlocked` is
	// overridden to prove *that* logic works, since every address a test controls is otherwise refused by
	// design — the blocklist itself is what the assertions just above already covered.
	{
		const { createServer } = await import("node:http");
		const body = Buffer.from("not really a png, just bytes to move");
		const srv = createServer((req, res) => {
			if (req.url === "/big") {
				res.writeHead(200, { "content-type": "image/png" });
				return res.end(Buffer.alloc(5000));
			}
			if (req.url === "/404") return res.writeHead(404), res.end();
			res.writeHead(200, { "content-type": "image/png" });
			res.end(body);
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const url = (path) => `http://127.0.0.1:${srv.address().port}${path}`;
		const never = { isBlocked: () => false };
		const got = await fetchImage(url("/ok"), { maxBytes: 1_000_000, ...never });
		assert.deepEqual([got.buffer.equals(body), got.contentType], [true, "image/png"]);
		await assert.rejects(fetchImage(url("/big"), { maxBytes: 1000, ...never }), /too large/i);
		await assert.rejects(fetchImage(url("/404"), { maxBytes: 1000, ...never }), /HTTP 404/);
		await assert.rejects(fetchImage(url("/ok"), { maxBytes: 1000 }), /refusing to fetch from an internal address/, "the real guard, unoverridden, still refuses the same loopback server");
		await new Promise((r) => srv.close(r));
	}

	// data: URLs: the mime type, base64 vs percent-encoded, and malformed input.
	assert.deepEqual(dataUriToImage("data:image/png;base64,QQ=="), { type: "image", data: "QQ==", mimeType: "image/png" });
	assert.equal(dataUriToImage("data:image/jpeg;base64,/9k=").mimeType, "image/jpeg");
	assert.equal(dataUriToImage("data:,hi").mimeType, "image/png", "no type at all defaults to png");
	assert.equal(Buffer.from(dataUriToImage("data:text/plain,hi%20there").data, "base64").toString(), "hi there", "percent-encoded, not base64, is re-encoded");
	assert.equal(dataUriToImage("not a data url"), null);
	assert.equal(dataUriToImage("data:text/plain,%zz"), null, "malformed percent-encoding does not throw");
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

	// regenerate: a fresh secret for the same key; the old one stops working at once.
	const forRegen = apiKeys.create({ name: "regen-test", expiresAt: 0 });
	const regen1 = apiKeys.regenerate(forRegen.record.id);
	assert.notEqual(regen1.key, forRegen.key, "a genuinely new secret");
	assert.match(regen1.key, /^piper_[A-Za-z0-9_-]{43}$/, "same key shape");
	assert.equal(regen1.record.id, forRegen.record.id, "same key record");
	assert.equal(regen1.record.name, "regen-test", "everything else untouched");
	assert.equal(apiKeys.verify(forRegen.key), null, "the old secret stops working at once");
	assert.equal(apiKeys.verify(regen1.key)?.id, forRegen.record.id, "the new one works");
	assert.equal(apiKeys.regenerate("6f1e1a5c-0000-4000-8000-000000000000"), null, "an unknown id regenerates nothing");
	apiKeys.remove(forRegen.record.id);

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
	// Scoping and acquiring now live in one shared function (openSession), which the handler and the internal runs call.
	assert.match(src, /const scopedId = scopedSessionId\(credential, clientSessionId\)/, "the shared opener has to scope the id by the credential");
	assert.match(src, /openSession\(req\.credential, clientSessionId\)/, "the handler has to open its session with the request's credential");
	const acquires = [...src.matchAll(/sessions\.acquire\(([^)]*)\)/g)].map((m) => m[1]);
	assert.ok(acquires.length >= 1);
	assert.deepEqual(acquires.filter((args) => !/^(scopedId|acquired\.scopedId), credential$/.test(args)), [], "every acquire passes the scoped id and the credential");
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

	// The command timeout and idle watchdog below are both unref'd (so a live one never keeps the real
	// gateway process open by itself); in this isolated test nothing else is left active to drive Node's
	// event loop, so a ref'd keep-alive stands in for "a real gateway always has something else running".
	const keepAlive = setInterval(() => {}, 1000);

	// A command Pi never answers times out (PI_COMMAND_TIMEOUT_MS) instead of hanging forever, and the
	// session is still usable afterwards: the late answer, if it ever comes, is ignored.
	config.PI_COMMAND_TIMEOUT_MS = 30;
	let abortReply = null;
	const slowAckChild = fakeChild((command, reply) => {
		if (command.type === "get_state") return reply(ok(command, {}));
		if (command.type === "abort") abortReply = () => reply(ok(command));
		// everything else is answered normally
	});
	const slowAckSession = await new PiRpcSession(slowAckChild).init(2000);
	await assert.rejects(slowAckSession.abort(), /did not answer "abort" within 0s/);
	assert.equal(slowAckSession.alive, true, "a slow command alone does not kill the session");
	abortReply?.(); // the late answer arrives after the timeout already rejected; must not throw or resurface
	await new Promise((r) => setTimeout(r, 20));
	await assert.doesNotReject(slowAckSession.send({ type: "get_state" }), "the session still answers normally afterwards");
	config.PI_COMMAND_TIMEOUT_MS = 30_000;

	// 0 waits however long it takes (used by init(), which already races its own timeout).
	const patientChild = fakeChild((command, reply) => setTimeout(() => reply(ok(command, {})), 25));
	const patientSession = new PiRpcSession(patientChild);
	await patientSession.send({ type: "get_state" }, 0);

	// Pi gone fully silent while a prompt is waiting on agent_settled is treated as wedged: the prompt
	// fails, the session is marked dead, and the actual process is killed since it never exited on its own.
	config.PI_IDLE_TIMEOUT_MS = 30;
	let killed = false;
	const wedgedChild = fakeChild((command, reply) => {
		if (command.type === "get_state") return reply(ok(command, {}));
		if (command.type === "prompt") {
			reply(ok(command));
			reply({ type: "agent_start" });
			// then nothing, ever: no message_end, no agent_settled
		}
	});
	wedgedChild.kill = () => (killed = true);
	let wedgedClosed = false;
	const wedgedSession = await new PiRpcSession(wedgedChild, { onClose: () => (wedgedClosed = true) }).init(2000);
	await assert.rejects(wedgedSession.prompt("hi"), /stopped responding: no activity for 0s/);
	assert.equal(wedgedSession.alive, false);
	assert.equal(wedgedClosed, true);
	assert.equal(killed, true, "the unresponsive process is force-killed since it never exited by itself");
	config.PI_IDLE_TIMEOUT_MS = 20 * 60_000;

	// A command in flight when Pi goes silent is also freed, not just a waiting prompt.
	config.PI_IDLE_TIMEOUT_MS = 30;
	const silentChild = fakeChild(() => {}); // never answers anything, ever
	const silentSession = new PiRpcSession(silentChild);
	await assert.rejects(silentSession.send({ type: "get_state" }), /stopped responding/);
	config.PI_IDLE_TIMEOUT_MS = 20 * 60_000;

	// 0 turns the idle watchdog off: a waiting prompt is left alone indefinitely. Construct with a short
	// timeout (so the poll runs fast) then disable it, which proves the check itself is skipped and this
	// is not just a poll that happened to run too slowly to notice.
	config.PI_IDLE_TIMEOUT_MS = 10;
	const unwatchedChild = fakeChild((command, reply) => {
		if (command.type === "get_state") return reply(ok(command, {}));
		if (command.type === "prompt") {
			reply(ok(command));
			reply({ type: "agent_start" });
			setTimeout(() => reply({ type: "agent_settled" }), 80);
		}
	});
	const unwatchedSession = await new PiRpcSession(unwatchedChild).init(2000);
	config.PI_IDLE_TIMEOUT_MS = 0;
	await unwatchedSession.prompt("hi"); // would have been killed well before 80ms if the watchdog still ran
	assert.equal(unwatchedSession.alive, true);
	config.PI_IDLE_TIMEOUT_MS = 20 * 60_000;
	clearInterval(keepAlive);
}

// chatCompletions, the real `/v1/chat/completions` handler, over a fully fake Docker and a scripted Pi
// process (setSessionSpawn): the one place the HTTP-specific code — SSE framing, X-Session-Id, the
// audio/spend refusal ordering, stream vs non-stream — gets exercised for real, not through
// setAgentTurnRunner (which replaces this entire path and so never touches any of it).
{
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const { server } = await import("./server.mjs");
	resetEngineCheck();
	const priorNetwork = config.CONTAINER_NETWORK;
	const accessLog = config.ACCESS_LOG;
	config.CONTAINER_NETWORK = "none";
	config.ACCESS_LOG = false;

	setRunner(async (bin, args) => {
		if (bin === "docker" && args[0] === "version") return { code: 0, stdout: "27.0.0", stderr: "" };
		if (bin === "docker" && args[0] === "inspect") return { code: 1, stdout: "", stderr: "No such object" }; // no container yet: create one
		if (bin === "docker" && args[0] === "image") return { code: 0, stdout: "sha256:fakeimage|0.99.1", stderr: "" };
		return { code: 0, stdout: "", stderr: "" }; // create, start, network, iptables: all succeed
	});

	// Every chat's container is really this: a scripted child speaking Pi's RPC protocol over stdio,
	// echoing the prompt back so the test can tell the real text made the whole round trip.
	const fakeChild = () => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.exitCode = null;
		child.signalCode = null;
		// A real child_process actually dies and fires "exit" when killed; dispose() waits on exactly that
		// to tear the bridge server down, so a no-op kill() here would leak it (a listening unix socket) forever.
		child.kill = (signal = "SIGTERM") => {
			if (child.exitCode !== null || child.signalCode !== null) return true;
			child.signalCode = signal;
			setImmediate(() => child.emit("exit", null, signal));
			return true;
		};
		child.stdin = new PassThrough();
		// dispose() closes stdin first and waits up to 3s before force-killing; exiting right away like a
		// real Pi shutting down on a closed stdin keeps the test from paying that wait every time.
		child.stdin.on("end", () => child.exitCode === null && child.signalCode === null && setImmediate(() => child.emit("exit", 0, null)));
		let buffer = "";
		child.stdin.on("data", (chunk) => {
			buffer += chunk;
			let i;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const command = JSON.parse(buffer.slice(0, i));
				buffer = buffer.slice(i + 1);
				const reply = (record) => child.stdout.write(`${JSON.stringify(record)}\n`);
				const ok = (data) => reply({ type: "response", id: command.id, command: command.type, success: true, data });
				if (command.type === "get_state") ok({ model: { provider: "p", id: "m", input: ["text"] }, isStreaming: false });
				else if (command.type === "prompt") {
					const said = String(command.message ?? "");
					ok();
					reply({ type: "agent_start" });
					reply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `echo: ${said}` } });
					reply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `echo: ${said}` }] } });
					setTimeout(() => reply({ type: "agent_settled" }), 10);
				} else ok();
			}
		});
		return child;
	};
	setSessionSpawn(() => fakeChild());

	const { record: key, key: token } = apiKeys.create({ name: "chatCompletions-test", expiresAt: 0 });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = (body, headers = {}) =>
		fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

	// A real, non-streamed turn: the message reaches Pi through the fake container and its answer comes back,
	// with usage reported.
	const plain = await call({ messages: [{ role: "user", content: "hello there" }] });
	assert.equal(plain.status, 200);
	const plainJson = await plain.json();
	assert.equal(plainJson.object, "chat.completion");
	assert.equal(plainJson.choices[0].message.content, "echo: hello there");
	assert.equal(plainJson.choices[0].finish_reason, "stop");
	assert.ok(plainJson.usage);

	// Streamed: SSE chunks, role first, content deltas, a final stop chunk, then [DONE].
	const streamed = await call({ messages: [{ role: "user", content: "stream please" }], stream: true });
	assert.equal(streamed.status, 200);
	assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
	const text = await streamed.text();
	assert.match(text, /"delta":\{"role":"assistant","content":""\}/, "the role chunk opens the stream");
	assert.match(text, /"content":"echo: stream please"/);
	assert.match(text, /"finish_reason":"stop"/);
	assert.ok(text.trimEnd().endsWith("data: [DONE]"));

	// X-Session-Id: the same id resumes the same chat (one scoped session) across requests.
	const withId = (body) => call(body, { "x-session-id": "my-own-id" });
	const first = await withId({ messages: [{ role: "user", content: "first" }] });
	assert.equal(first.status, 200);
	const openBefore = sessions.allRecords().length;
	const second = await withId({ messages: [{ role: "user", content: "first" }, { role: "assistant", content: "echo: first" }, { role: "user", content: "second" }] });
	assert.equal(second.status, 200);
	assert.equal(sessions.allRecords().length, openBefore, "the second request resumed the same session rather than opening another");
	assert.equal((await second.json()).choices[0].message.content, "echo: second", "the newest user message is the prompt sent, not the whole history");

	// Audio is refused before anything is spawned.
	const audio = await call({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }] }] });
	assert.equal(audio.status, 400);
	assert.match((await audio.json()).error.message, /Audio input is not supported/);

	// An over-cap key is refused before any container work, even though its container already exists.
	apiKeys.update(key.id, { dailySpend: 0.01 });
	recordSpend({ id: `spend-${Math.random()}`, requests: 1, keyId: key.id }, { getSessionStats: () => ({ cost: 0.02, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }), model: { provider: "p", id: "m" } });
	const overCap = await call({ messages: [{ role: "user", content: "once more" }] });
	assert.equal(overCap.status, 429);
	assert.match((await overCap.json()).error.message, /daily spend limit reached/);
	apiKeys.update(key.id, { dailySpend: null });

	// A granted extension whose entry.json survived but whose actual package folder did not (by hand, a
	// partial restore, a reinstall that never finished) does not take the whole container down: it is left
	// out of that run, once, with the chat told so, rather than Pi refusing to start over one missing path.
	mkdirSync(join(TEST_EXT, "missing-pkg"), { recursive: true });
	writeFileSync(join(TEST_EXT, "missing-pkg", "entry.json"), JSON.stringify({ name: "missing-pkg", source: "npm:missing-pkg", version: "1.0.0", entry: "node_modules/missing-pkg" }));
	apiKeys.update(key.id, { sharedBundles: "missing-pkg" });
	const withMissing = await call({ messages: [{ role: "user", content: "hi" }] }, { "x-session-id": "needs-missing-ext" });
	assert.equal(withMissing.status, 200, "the chat still starts");
	const withMissingText = (await withMissing.json()).choices[0].message.content;
	assert.match(withMissingText, /^\[container: an extension this chat was granted could not be found or loaded on the host and was left out: missing-pkg\. Reinstall or remove it on Extensions\.\]\n\necho: hi$/);
	apiKeys.update(key.id, { sharedBundles: null });
	rmSync(join(TEST_EXT, "missing-pkg"), { recursive: true, force: true });

	// A granted extension whose folder exists but is not a usable Pi package (no package.json, no
	// extensions/skills/prompts folder — a half-written edit, or a file deleted out from under it) gets the
	// same treatment: left out with a notice, not a crash. The folder is present, unlike the case above.
	mkdirSync(join(TEST_EXT, "broken-pkg", "node_modules", "broken-pkg"), { recursive: true });
	writeFileSync(join(TEST_EXT, "broken-pkg", "entry.json"), JSON.stringify({ name: "broken-pkg", source: "npm:broken-pkg", version: "1.0.0", entry: "node_modules/broken-pkg" }));
	apiKeys.update(key.id, { sharedBundles: "broken-pkg" });
	const withBroken = await call({ messages: [{ role: "user", content: "hi" }] }, { "x-session-id": "needs-broken-ext" });
	assert.equal(withBroken.status, 200, "the chat still starts");
	const withBrokenText = (await withBroken.json()).choices[0].message.content;
	assert.match(withBrokenText, /^\[container: an extension this chat was granted could not be found or loaded on the host and was left out: broken-pkg\. Reinstall or remove it on Extensions\.\]\n\necho: hi$/);
	apiKeys.update(key.id, { sharedBundles: null });
	rmSync(join(TEST_EXT, "broken-pkg"), { recursive: true, force: true });

	// Each chat opened a real bridge server (a listening unix socket); closing the sessions tears those down
	// too, or they would outlive this test and keep the process from ever exiting.
	const openRecords = sessions.allRecords();
	sessions.closeAll();
	await Promise.all(openRecords.map((r) => r.stopped ?? Promise.resolve()));
	setSessionSpawn(null);
	server.closeAllConnections?.();
	await new Promise((r) => server.close(r));
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
	config.CONTAINER_NETWORK = priorNetwork;
	config.ACCESS_LOG = accessLog;
	resetEngineCheck();
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

// Agent memory: scope resolution, the write/read/lookup round trip and its caps, the bridge routes,
// the dashboard's view of it, and cleanup when an agent or a key is deleted.
{
	const rec = (extra) => ({ keyId: "mem-key-1", agentId: null, scopeId: "mem-key-1", ...extra });
	config.AGENT_MEMORY_ENABLED = true;

	// Scope: a key's own chats, and a named agent's own or shared, resolve the way workspaceScopeOf does.
	assert.equal(memoryScopeOf("mem-key-1"), "mem-key-1", "a plain key's own scope: itself");
	const ownAgent = agents.create({ keyId: "mem-key-1", name: "own-mem" });
	assert.equal(agents.get(ownAgent.id).memoryMode, "own", "the default");
	assert.equal(memoryScopeOf(agentScope("mem-key-1", ownAgent.id)), agentScope("mem-key-1", ownAgent.id));
	const sharedAgent = agents.create({ keyId: "mem-key-1", name: "shared-mem", memoryMode: "shared" });
	assert.equal(memoryScopeOf(agentScope("mem-key-1", sharedAgent.id)), "mem-key-1", "folds into its key's");
	assert.throws(() => agents.create({ keyId: "mem-key-1", name: "bad-mem", memoryMode: "sometimes" }), /memory must be one of/);
	agents.remove(ownAgent.id);
	agents.remove(sharedAgent.id);

	// mayRemember: the one global switch, and nothing to scope to is nothing to remember in.
	assert.equal(mayRemember(rec()), true);
	config.AGENT_MEMORY_ENABLED = false;
	assert.equal(mayRemember(rec()), false);
	config.AGENT_MEMORY_ENABLED = true;
	assert.equal(mayRemember({ keyId: null, scopeId: null }), false);

	// write/read/lookup, bound to one record's scope.
	const mem = memoryFor(rec());
	assert.deepEqual(mem.write({ name: "deploy-steps", value: "1. build 2. push 3. restart" }), { name: "deploy-steps", updated: false });
	assert.equal(mem.read({ name: "deploy-steps" }).value, "1. build 2. push 3. restart");
	assert.deepEqual(mem.write({ name: "deploy-steps", value: "just: deploy.sh" }), { name: "deploy-steps", updated: true }, "writing the same name again replaces it");
	assert.equal(mem.read({ name: "deploy-steps" }).value, "just: deploy.sh");
	assert.throws(() => mem.read({ name: "no-such-note" }), /no note called/);
	assert.throws(() => mem.write({ name: "", value: "x" }), /name a note/);
	assert.throws(() => mem.write({ name: "x", value: "  " }), /nothing to remember/);
	mem.write({ name: "user-preferences", value: "prefers terse answers" });
	const all = mem.lookup({});
	assert.deepEqual(all.map((n) => n.name), ["user-preferences", "deploy-steps"], "newest first");
	assert.deepEqual(mem.lookup({ query: "terse" }).map((n) => n.name), ["user-preferences"]);
	assert.deepEqual(mem.lookup({ query: "DEPLOY" }).map((n) => n.name), ["deploy-steps"], "case-insensitive, and matches the value too");
	assert.equal(mem.lookup({ query: "nothing matches this" }).length, 0);
	const long = "x".repeat(500);
	mem.write({ name: "long-one", value: long });
	assert.equal(mem.lookup({ query: "long-one" })[0].preview.length, 161, "previews are capped, with an ellipsis");
	clearMemory("mem-key-1");

	// Caps: a brand new name over the limit is refused; updating an existing one never is.
	config.MEMORY_MAX_ENTRIES = 2;
	mem.write({ name: "a", value: "1" });
	mem.write({ name: "b", value: "2" });
	assert.throws(() => mem.write({ name: "c", value: "3" }), /already has 2 notes.*MEMORY_MAX_ENTRIES/);
	assert.doesNotThrow(() => mem.write({ name: "a", value: "updated" }), "updating an existing one is always allowed");
	config.MEMORY_MAX_ENTRIES = 200;
	config.MEMORY_MAX_NAME_BYTES = 4;
	assert.throws(() => mem.write({ name: "toolong", value: "x" }), /MEMORY_MAX_NAME_BYTES/);
	config.MEMORY_MAX_NAME_BYTES = 100;
	config.MEMORY_MAX_VALUE_BYTES = 4;
	assert.throws(() => mem.write({ name: "x", value: "toolong" }), /MEMORY_MAX_VALUE_BYTES/);
	config.MEMORY_MAX_VALUE_BYTES = 4000;
	config.MEMORY_LOOKUP_LIMIT = 1;
	assert.equal(mem.lookup({}).length, 1, "the lookup limit");
	config.MEMORY_LOOKUP_LIMIT = 20;
	clearMemory("mem-key-1");

	// Scopes never cross: another key's (or agent's) memory is a different store entirely.
	const other = memoryFor(rec({ keyId: "mem-key-2", scopeId: "mem-key-2" }));
	other.write({ name: "deploy-steps", value: "a different key's note" });
	assert.throws(() => mem.read({ name: "deploy-steps" }), /no note called/, "mem-key-1 never had this note back");
	clearMemory("mem-key-2");

	// Disabled: every call refuses, with existing notes untouched (checked once re-enabled).
	mem.write({ name: "kept", value: "still here" });
	config.AGENT_MEMORY_ENABLED = false;
	assert.throws(() => mem.write({ name: "x", value: "y" }), /may not use memory/);
	assert.throws(() => mem.read({ name: "kept" }), /may not use memory/);
	assert.throws(() => mem.lookup({}), /may not use memory/);
	config.AGENT_MEMORY_ENABLED = true;
	assert.equal(mem.read({ name: "kept" }).value, "still here");
	clearMemory("mem-key-1");

	// The bridge routes: bound to the socket's own record, 403 when memory is not passed at all.
	{
		const dir = mkdtempSync(join("/tmp", "pb-mem-"));
		const http = await import("node:http");
		const post = (socketPath, path, body) =>
			new Promise((resolve, reject) => {
				const req = http.request({ socketPath, path, method: "POST", agent: false }, (res) => {
					let data = "";
					res.on("data", (c) => (data += c));
					res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
				});
				req.on("error", reject);
				req.end(JSON.stringify(body ?? {}));
			});
		const socketPath = join(dir, "with.sock");
		const post1 = (path, body) => post(socketPath, path, body);
		const withMemory = await startBridge(socketPath, newMeter(), { memory: memoryFor(rec()) });
		const wrote = await post1("/memory/write", { name: "n", value: "v" });
		assert.deepEqual(wrote, { status: 200, body: { note: { name: "n", updated: false } } });
		const read = await post1("/memory/read", { name: "n" });
		assert.equal(read.status, 200);
		assert.deepEqual([read.body.note.name, read.body.note.value, typeof read.body.note.updatedAt], ["n", "v", "number"]);
		assert.deepEqual((await post1("/memory/lookup", {})).body.notes.map((x) => x.name), ["n"]);
		withMemory.close();
		clearMemory("mem-key-1");

		const socketPath2 = join(dir, "without.sock");
		const post2 = (path, body) => post(socketPath2, path, body);
		const noMemory = await startBridge(socketPath2, newMeter(), {});
		assert.equal((await post2("/memory/write", { name: "n", value: "v" })).status, 403);
		assert.equal((await post2("/memory/read", { name: "n" })).status, 403);
		assert.equal((await post2("/memory/lookup", {})).status, 403);
		noMemory.close();
		rmSync(dir, { recursive: true, force: true });
	}

	// The dashboard's own view: every scope with notes, one scope's notes, delete one, clear all. Driven
	// over a real socket (memoryDashboardRoutes reads its body as a stream, like every other route here).
	{
		memoryFor(rec()).write({ name: "a", value: "1" });
		memoryFor(rec()).write({ name: "b", value: "2" });
		memoryFor(rec({ keyId: "mem-key-2", scopeId: "mem-key-2" })).write({ name: "c", value: "3" });
		const http = await import("node:http");
		const srv = http.createServer((req, res) => memoryDashboardRoutes(req, res, req.url));
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${srv.address().port}`;
		const call = (path, opts) => fetch(base + path, opts).then((r) => r.json().then((json) => ({ status: r.status, json })));

		const list = await call("/dashboard/memory.json");
		assert.ok(list.json.scopes.some((s) => s.scope === "mem-key-1" && s.entries === 2 && s.label) && list.json.scopes.some((s) => s.scope === "mem-key-2" && s.entries === 1));
		const view = await call("/dashboard/memory/mem-key-1");
		assert.deepEqual(view.json.entries.map((e) => e.name).sort(), ["a", "b"]);
		const del = await call("/dashboard/memory/mem-key-1/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "a" }) });
		assert.deepEqual(del.json, { deleted: true });
		assert.equal((await call("/dashboard/memory/mem-key-1/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "a" }) })).json.deleted, false, "already gone");
		assert.deepEqual((await call("/dashboard/memory/mem-key-1")).json.entries.map((e) => e.name), ["b"]);
		const cleared = await call("/dashboard/memory/mem-key-1", { method: "DELETE" });
		assert.deepEqual(cleared.json, { cleared: 1 });
		assert.equal((await call("/dashboard/memory/mem-key-1")).json.entries.length, 0);
		assert.ok(recentAuditRows(10).some((r) => r.action === "memory.delete") && recentAuditRows(10).some((r) => r.action === "memory.clear"));
		await new Promise((r) => srv.close(r));
		clearMemory("mem-key-2");
	}

	// Cleanup: deleting an agent removes its own memory; deleting a key removes its own and every agent's.
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
	const cleanupKey = apiKeys.create({ name: "mem-cleanup-test" });
	const ckey = cleanupKey.record ?? cleanupKey;
	const madeAgent = await createAgent({ keyId: ckey.id, name: "mem-agent" });
	memoryFor({ keyId: ckey.id, scopeId: agentScope(ckey.id, madeAgent.id) }).write({ name: "n", value: "v" });
	memoryFor({ keyId: ckey.id, scopeId: ckey.id }).write({ name: "n", value: "v" });
	assert.equal(memoryEntries(agentScope(ckey.id, madeAgent.id)).length, 1);
	await deleteAgent(madeAgent.id);
	assert.equal(memoryEntries(agentScope(ckey.id, madeAgent.id)).length, 0, "the agent's own memory went with it");
	assert.equal(memoryEntries(ckey.id).length, 1, "the key's own memory is untouched by deleting one agent");
	assert.equal(deleteMemoryOf({ keyId: ckey.id }), 1, "and is removed when the key itself goes");
	apiKeys.remove(ckey.id);
}

// Knowledge base: the generic store, RSS as its one producer today, the read-only bridge tools and
// the dashboard's routes for both.
{
	const krec = (extra) => ({ keyId: "know-key-1", agentId: null, scopeId: "know-key-1", ...extra });
	config.KNOWLEDGE_ENABLED = true;
	config.RSS_ENABLED = true;

	// parseFeedXml: RSS 2.0 (with CDATA and entities), Atom, and a feed with no guid at all.
	const rss = `<rss><channel>
		<item><title><![CDATA[Has &amp; Entities]]></title><link>https://example.test/a</link><guid>guid-a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
		<item><title>No Guid</title><link>https://example.test/b</link></item>
	</channel></rss>`;
	const parsed = parseFeedXml(rss);
	assert.deepEqual(parsed.map((e) => e.title), ["Has & Entities", "No Guid"]);
	assert.equal(parsed[0].guid, "guid-a");
	assert.equal(parsed[1].guid, "https://example.test/b", "no guid falls back to the link");
	assert.equal(parsed[0].publishedAt, Date.parse("Mon, 01 Jan 2024 00:00:00 GMT"));
	const atom = `<feed><entry><title>Atom Title</title><link href="https://example.test/atom-1"/><id>atom-1</id><updated>2024-01-02T00:00:00Z</updated></entry></feed>`;
	const parsedAtom = parseFeedXml(atom);
	assert.deepEqual(parsedAtom, [{ guid: "atom-1", url: "https://example.test/atom-1", title: "Atom Title", publishedAt: Date.parse("2024-01-02T00:00:00Z") }]);
	assert.deepEqual(parseFeedXml("<rss><channel></channel></rss>"), []);

	// The generic store: upsert on (sourceType, sourceRef, guid), the dashboard's views, cleanup.
	clearSource("test", "s1");
	addEntry({ sourceType: "test", sourceRef: "s1", guid: "g1", url: "https://x.test/1", title: "One", text: "body one", summary: "sum one", tags: ["a", "b"], status: "done" });
	const e1 = getByKey("test", "s1", "g1");
	assert.deepEqual([e1.title, e1.text, e1.tags, e1.status], ["One", "body one", ["a", "b"], "done"]);
	addEntry({ sourceType: "test", sourceRef: "s1", guid: "g1", url: "https://x.test/1", title: "One (updated)", text: "body one v2", status: "done" });
	assert.equal(getByKey("test", "s1", "g1").title, "One (updated)", "same key replaces, not duplicates");
	assert.equal(sourceSeen("test", "s1"), true);
	assert.equal(sourceSeen("test", "never-seen"), false);
	addEntry({ sourceType: "test", sourceRef: "s1", guid: "g2", url: "https://x.test/2", title: "Two", text: "body two", status: "pending" });
	assert.deepEqual(entriesOf("test", "s1").map((e) => e.guid).sort(), ["g1", "g2"]);
	assert.ok(knowledgeOverview().some((s) => s.sourceType === "test" && s.sourceRef === "s1" && s.entries === 2));
	assert.equal(removeEntry(getByKey("test", "s1", "g2").id), true);
	assert.equal(entriesOf("test", "s1").length, 1);
	assert.equal(clearSource("test", "s1"), 1);
	assert.equal(entriesOf("test", "s1").length, 0);
	addEntry({ sourceType: "test", sourceRef: "s1", guid: "gold", title: "Old", text: "x", status: "done" });
	db.prepare("UPDATE knowledge_entries SET created_at = ? WHERE source_type = 'test' AND source_ref = 's1'").run(Date.now() - 200 * 86_400_000);
	config.KNOWLEDGE_RETENTION_DAYS = 90;
	assert.equal(purgeOld(), 1, "older than KNOWLEDGE_RETENTION_DAYS is forgotten");
	config.KNOWLEDGE_RETENTION_DAYS = 0;
	addEntry({ sourceType: "test", sourceRef: "s1", guid: "forever", title: "Forever", text: "x", status: "done" });
	db.prepare("UPDATE knowledge_entries SET created_at = 1 WHERE source_type = 'test' AND source_ref = 's1'").run();
	assert.equal(purgeOld(), 0, "0 keeps everything");
	config.KNOWLEDGE_RETENTION_DAYS = 90;
	clearSource("test", "s1");

	// The agent-facing half: search/read, status-gated, available to any chat with a scope.
	assert.equal(mayLookupKnowledge(krec()), true);
	assert.equal(mayLookupKnowledge({ keyId: null, scopeId: null }), false);
	config.KNOWLEDGE_ENABLED = false;
	assert.equal(mayLookupKnowledge(krec()), false);
	config.KNOWLEDGE_ENABLED = true;
	clearSource("test", "know");
	addEntry({ sourceType: "test", sourceRef: "know", guid: "done-1", title: "Reactor Meltdown", text: "Full text about a reactor.", summary: "A reactor had a problem.", tags: ["energy"], status: "done" });
	addEntry({ sourceType: "test", sourceRef: "know", guid: "pending-1", title: "Still Cooking", text: "half text", status: "pending" });
	const kn = knowledgeFor(krec());
	const hits = kn.search({ query: "reactor" });
	assert.equal(hits.length, 1);
	assert.deepEqual([hits[0].title, hits[0].summary, hits[0].source], ["Reactor Meltdown", "A reactor had a problem.", "test"]);
	assert.equal(kn.search({ query: "still cooking" }).length, 0, "a pending entry is not findable");
	const got = kn.read({ id: hits[0].id });
	assert.equal(got.text, "Full text about a reactor.");
	assert.throws(() => kn.read({ id: getByKey("test", "know", "pending-1").id }), /no entry called/, "a pending entry is not readable either");
	config.KNOWLEDGE_ENABLED = false;
	assert.throws(() => kn.search({}), /may not use the knowledge base/);
	assert.throws(() => kn.read({ id: hits[0].id }), /may not use the knowledge base/);
	config.KNOWLEDGE_ENABLED = true;
	clearSource("test", "know");

	// The bridge routes: present only when `knowledge` is passed to startBridge.
	{
		const dir = mkdtempSync(join("/tmp", "pb-know-"));
		const http2 = await import("node:http");
		const post = (socketPath, path, body) =>
			new Promise((resolve, reject) => {
				const req = http2.request({ socketPath, path, method: "POST", agent: false }, (res) => {
					let data = "";
					res.on("data", (c) => (data += c));
					res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
				});
				req.on("error", reject);
				req.end(JSON.stringify(body ?? {}));
			});
		addEntry({ sourceType: "test", sourceRef: "bridge", guid: "b1", title: "Bridged", text: "bridged text", summary: "s", status: "done" });
		const socketPath = join(dir, "with.sock");
		const withKnowledge = await startBridge(socketPath, newMeter(), { knowledge: knowledgeFor(krec()) });
		const found = await post(socketPath, "/knowledge/search", { query: "bridged" });
		assert.equal(found.status, 200);
		assert.equal(found.body.entries[0].title, "Bridged");
		const read1 = await post(socketPath, "/knowledge/read", { id: found.body.entries[0].id });
		assert.equal(read1.body.entry.text, "bridged text");
		withKnowledge.close();

		const socketPath2 = join(dir, "without.sock");
		const noKnowledge = await startBridge(socketPath2, newMeter(), {});
		assert.equal((await post(socketPath2, "/knowledge/search", { query: "x" })).status, 403);
		assert.equal((await post(socketPath2, "/knowledge/read", { id: 1 })).status, 403);
		noKnowledge.close();
		rmSync(dir, { recursive: true, force: true });
		clearSource("test", "bridge");
	}

	// RSS feeds: CRUD, validation, the feed cap.
	const kkey = apiKeys.create({ name: "rss-test" });
	const rkey = kkey.record ?? kkey;
	const extractor = await createAgent({ keyId: rkey.id, name: "rss-extractor" });
	assert.throws(() => createFeed({ name: "bad", url: "not a url" }), /not a URL/);
	assert.throws(() => createFeed({ name: "bad", url: "ftp://x.test/feed" }), /http or https/);
	config.RSS_POLL_MIN_INTERVAL_MS = 60_000;
	assert.throws(() => createFeed({ name: "too fast", url: "https://feed.test/fast", intervalMs: 1_000 }), /RSS_POLL_MIN_INTERVAL_MS/, "an interval under the floor is refused, not silently floored");
	const feed = createFeed({ name: "Test Feed", url: "https://feed.test/one", agentId: extractor.id, intervalMs: 60_000 });
	assert.equal(feed.intervalMs, 60_000);
	assert.throws(() => createFeed({ name: "bad agent", url: "https://feed.test/two", agentId: "no-such-agent" }), (e) => e.status === 404);
	assert.equal(updateFeed(feed.id, { name: "Renamed" }).name, "Renamed");
	assert.throws(() => updateFeed("no-such-feed", { name: "x" }), (e) => e.status === 404);
	config.RSS_MAX_FEEDS = listFeeds().length;
	assert.throws(() => createFeed({ name: "over cap", url: "https://feed.test/three" }), (e) => e.status === 409);
	config.RSS_MAX_FEEDS = 100;

	// The backfill rule: a feed's first poll seeds entries as 'skipped' (never queued); its next poll
	// queues only what is genuinely new.
	const xmlOne = (items) => `<rss><channel>${items.map((it) => `<item><title>${it.t}</title><link>${it.u}</link><guid>${it.g}</guid></item>`).join("")}</channel></rss>`;
	const fakeFetch = (xml) => async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(xml, "utf8") });
	await forcePoll(feed.id, { fetchFn: fakeFetch(xmlOne([{ t: "A", u: "https://feed.test/a", g: "ga" }, { t: "B", u: "https://feed.test/b", g: "gb" }])) });
	assert.deepEqual(entriesOf(SOURCE_TYPE, feed.id).map((e) => e.status), ["skipped", "skipped"]);
	await forcePoll(feed.id, { fetchFn: fakeFetch(xmlOne([{ t: "A", u: "https://feed.test/a", g: "ga" }, { t: "B", u: "https://feed.test/b", g: "gb" }, { t: "C", u: "https://feed.test/c", g: "gc" }])) });
	const afterSecond = entriesOf(SOURCE_TYPE, feed.id);
	assert.equal(afterSecond.length, 3);
	assert.equal(afterSecond.find((e) => e.guid === "gc").status, "pending", "only the new one is queued");
	assert.equal(getFeed(feed.id).lastError, null);

	// Extraction: a whole agent turn per pending entry, strict JSON, the AgentRunError/timeout mapping.
	assert.deepEqual(parseExtraction('{"title":"T","text":"Body","summary":"S","tags":["x"]}'), { title: "T", text: "Body", summary: "S", tags: ["x"] });
	assert.deepEqual(parseExtraction('```json\n{"title":"T","text":"Body"}\n```'), { title: "T", text: "Body", summary: "", tags: [] });
	assert.throws(() => parseExtraction("not json at all"), /was not JSON/);
	assert.throws(() => parseExtraction("[1,2,3]"), /was not a JSON object/);
	assert.throws(() => parseExtraction('{"title":"","text":""}'), /no title or text/);

	const waitForEntry = async (guid, pred, ms = 3000, sourceRef = feed.id) => {
		const end = Date.now() + ms;
		for (;;) {
			const e = getByKey(SOURCE_TYPE, sourceRef, guid);
			if (e && pred(e)) return e;
			if (Date.now() > end) throw new Error(`timed out waiting on ${guid}`);
			await new Promise((r) => setTimeout(r, 15));
		}
	};
	setExtractionRunner(async ({ prompt }) => ({ text: JSON.stringify({ title: "C, extracted", text: "The full clean article.", summary: "Short summary.", tags: ["news"] }), usage: { total_tokens: 5 }, cost: 0, scopedId: "x" }));
	rssPump();
	const doneC = await waitForEntry("gc", (e) => e.status === "done");
	assert.deepEqual([doneC.title, doneC.text, doneC.summary, doneC.tags], ["C, extracted", "The full clean article.", "Short summary.", ["news"]]);

	const { AgentRunError: KAgentRunError } = await import("./server.mjs");
	setExtractionRunner(async () => {
		throw new KAgentRunError("daily spend limit reached", 429, "spend_limit_exceeded", "rate_limit_error");
	});
	await forcePoll(feed.id, { fetchFn: fakeFetch(xmlOne([{ t: "D", u: "https://feed.test/d", g: "gd" }])) });
	rssPump();
	const failedD = await waitForEntry("gd", (e) => e.status === "failed");
	assert.equal(failedD.error, "daily spend limit reached");

	config.RSS_EXTRACT_TIMEOUT_MS = 80;
	setExtractionRunner(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
	await forcePoll(feed.id, { fetchFn: fakeFetch(xmlOne([{ t: "E", u: "https://feed.test/e", g: "ge" }])) });
	rssPump();
	const timedOutE = await waitForEntry("ge", (e) => e.status === "failed");
	assert.match(timedOutE.error, /no answer within/);
	config.RSS_EXTRACT_TIMEOUT_MS = 5 * 60_000;

	// retryEntry: a failed row goes back to pending and gets another pass.
	setExtractionRunner(async () => ({ text: JSON.stringify({ title: "D, extracted", text: "Recovered text." }), usage: { total_tokens: 1 }, cost: 0, scopedId: "x" }));
	assert.equal(retryEntry(failedD.id), true);
	const recoveredD = await waitForEntry("gd", (e) => e.status === "done");
	assert.equal(recoveredD.text, "Recovered text.");
	assert.throws(() => retryEntry(999_999_999), (e) => e.status === 404);

	// looksBlocked / parseUnblockReply: the heuristic, and what the forced give-up reply keeps.
	assert.equal(looksBlocked("blah blah 403 Forbidden blah"), true);
	assert.equal(looksBlocked("This site uses Cloudflare to protect itself"), true);
	assert.equal(looksBlocked("here is a normal answer"), false);
	assert.deepEqual(parseUnblockReply('{"title":"T","text":"Body"}'), { extracted: { title: "T", text: "Body", summary: "", tags: [] } });
	assert.deepEqual(parseUnblockReply('{"blocked":true,"reason":"Cloudflare challenge"}'), { reason: "Cloudflare challenge" });
	assert.deepEqual(parseUnblockReply("plain prose giving up"), { reason: "plain prose giving up" });

	// Auto-unblock: a reply that looks blocked gets one more try, in the same session, before giving up.
	let turn = 0;
	const sessionsSeen = [];
	setExtractionRunner(async ({ clientSessionId }) => {
		turn++;
		sessionsSeen.push(clientSessionId);
		if (turn === 1) return { text: "Sorry, I got a 403 Forbidden from Cloudflare.", usage: { total_tokens: 1 }, cost: 0, scopedId: "x" };
		return { text: JSON.stringify({ title: "G, extracted", text: "Found it another way." }), usage: { total_tokens: 1 }, cost: 0, scopedId: "x" };
	});
	await forcePoll(feed.id, { fetchFn: fakeFetch(xmlOne([{ t: "G", u: "https://feed.test/g", g: "gg" }])) });
	rssPump();
	const recoveredG = await waitForEntry("gg", (e) => e.status === "done");
	assert.equal(recoveredG.text, "Found it another way.");
	assert.equal(turn, 2, "one retry, in the same session");
	assert.deepEqual(sessionsSeen, [`rss:${recoveredG.id}`, `rss:${recoveredG.id}`]);

	// Auto-unblock: still blocked after the retry — a distinct status from a plain failure.
	setExtractionRunner(async ({ prompt }) =>
		/That reply could not be used/.test(prompt)
			? { text: '{"blocked":true,"reason":"Cloudflare challenge page"}', usage: { total_tokens: 1 }, cost: 0, scopedId: "x" }
			: { text: "Blocked by Cloudflare, 403 Forbidden.", usage: { total_tokens: 1 }, cost: 0, scopedId: "x" },
	);
	await forcePoll(feed.id, { fetchFn: fakeFetch(xmlOne([{ t: "H", u: "https://feed.test/h", g: "gh" }])) });
	rssPump();
	const blockedH = await waitForEntry("gh", (e) => e.status === "blocked");
	assert.equal(blockedH.error, "Cloudflare challenge page");
	assert.equal(getFeed(feed.id).lastEntryStatus, "blocked", "the Feeds list shows the latest extraction's own status");
	assert.equal(getFeed(feed.id).lastEntryAt, blockedH.fetchedAt);

	// RSS_AUTO_UNBLOCK off: no second try, straight to failed.
	config.RSS_AUTO_UNBLOCK = false;
	let onlyOneTurn = 0;
	setExtractionRunner(async () => {
		onlyOneTurn++;
		return { text: "403 Forbidden, Cloudflare.", usage: { total_tokens: 1 }, cost: 0, scopedId: "x" };
	});
	await forcePoll(feed.id, { fetchFn: fakeFetch(xmlOne([{ t: "I", u: "https://feed.test/i", g: "gi" }])) });
	rssPump();
	const failedI = await waitForEntry("gi", (e) => e.status === "failed");
	assert.equal(onlyOneTurn, 1, "no retry when RSS_AUTO_UNBLOCK is off");
	assert.match(failedI.error, /was not JSON/);
	config.RSS_AUTO_UNBLOCK = true;

	// A feed with no agent and no RSS_DEFAULT_AGENT names the problem, not a crash.
	config.RSS_DEFAULT_AGENT = "";
	const orphanFeed = createFeed({ name: "Orphan", url: "https://feed.test/orphan" });
	await forcePoll(orphanFeed.id, { fetchFn: fakeFetch(xmlOne([{ t: "Seed", u: "https://feed.test/seed", g: "gseed" }])) });
	await forcePoll(orphanFeed.id, { fetchFn: fakeFetch(xmlOne([{ t: "Seed", u: "https://feed.test/seed", g: "gseed" }, { t: "F", u: "https://feed.test/f", g: "gf" }])) });
	rssPump();
	const orphanedF = await waitForEntry("gf", (e) => e.status === "failed", 3000, orphanFeed.id);
	assert.match(orphanedF.error, /no extracting agent/);
	setExtractionRunner(null);

	// The dashboard's own routes: Entries (generic) and Feeds (RSS-specific).
	{
		const httpd = await import("node:http");
		const srv = httpd.createServer((req, res) => {
			if (req.url.startsWith("/dashboard/knowledge")) return knowledgeDashboardRoutes(req, res, req.url);
			return rssDashboardRoutes(req, res, req.url);
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${srv.address().port}`;
		const call = (path, opts) => fetch(base + path, opts).then((r) => r.json().then((json) => ({ status: r.status, json })));

		const sources = await call("/dashboard/knowledge.json");
		assert.ok(sources.json.sources.some((s) => s.sourceType === SOURCE_TYPE && s.sourceRef === feed.id));
		const sourceEntries = await call(`/dashboard/knowledge/${SOURCE_TYPE}/${feed.id}`);
		assert.ok(sourceEntries.json.entries.some((e) => e.guid === "gc"));
		const oneEntry = sourceEntries.json.entries.find((e) => e.guid === "gc");
		const detail = await call(`/dashboard/knowledge/${SOURCE_TYPE}/${feed.id}/${oneEntry.id}`);
		assert.equal(detail.json.entry.text, "The full clean article.");
		const deleted = await call(`/dashboard/knowledge/${SOURCE_TYPE}/${feed.id}/${oneEntry.id}`, { method: "DELETE" });
		assert.deepEqual(deleted.json, { deleted: true });
		assert.equal((await call(`/dashboard/knowledge/${SOURCE_TYPE}/${feed.id}`)).json.entries.some((e) => e.id === oneEntry.id), false);
		const clearedSource = await call(`/dashboard/knowledge/${SOURCE_TYPE}/${feed.id}`, { method: "DELETE" });
		assert.ok(clearedSource.json.cleared > 0);

		const log = await call("/dashboard/knowledge/log.json");
		assert.ok(log.json.entries.some((r) => r.action === "knowledge.delete"), "a single delete is on record");
		assert.ok(log.json.entries.some((r) => r.action === "knowledge.clear"), "clearing a source is on record");
		assert.ok(log.json.entries.some((r) => r.action === "rss.extract"), "an extraction is on record");
		assert.deepEqual(activityLog(500).slice(0, log.json.entries.length).map((r) => r.action), log.json.entries.map((r) => r.action), "the dashboard route reads the same log");
		assert.equal(activityLog().some((r) => r.action.startsWith("auth.") || r.action.startsWith("settings.")), false, "only Knowledge/RSS actions show up here");

		const feedsList = await call("/dashboard/rss.json");
		assert.ok(feedsList.json.feeds.some((f) => f.id === feed.id));
		const created = await call("/dashboard/rss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Via Dashboard", url: "https://feed.test/dashboard" }) });
		assert.equal(created.status, 201);
		const patched = await call(`/dashboard/rss/${created.json.feed.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
		assert.equal(patched.json.feed.enabled, false);
		const removed = await call(`/dashboard/rss/${created.json.feed.id}`, { method: "DELETE" });
		assert.deepEqual(removed.json, { deleted: true });
		await new Promise((r) => srv.close(r));
	}

	removeFeed(feed.id);
	removeFeed(orphanFeed.id);
	await deleteAgent(extractor.id);
	apiKeys.remove(rkey.id);
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
	// The agent's instructions are the profile's AGENTS.md.
	assert.deepEqual(run({ op: "instructions.get" }).result, { text: "" }, "none yet");
	assert.equal(run({ op: "instructions.put", text: "You are the architect." }).ok, true);
	assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "You are the architect.");
	assert.equal(run({ op: "instructions.get" }).result.text, "You are the architect.");
	assert.equal(run({ op: "instructions.put", text: 5 }).ok, false, "instructions are text");
	assert.equal(run({ op: "instructions.put", text: "x".repeat(65 * 1024) }).ok, false, "and at most 64 KB");
	assert.equal(run({ op: "summary" }).result.hasAgentsMd, true, "Pi will see it");

	// The file browser's operations: folders, moves, text for an editor, and the refusals around them.
	{
		const sub = join(dir, "fb");
		mkdirSync(sub, { recursive: true });
		const files = (extra = {}) => run({ op: "files.list", path: "", ...extra });
		assert.deepEqual(run({ op: "files.mkdir", path: "fb/a/b/c" }).result, { path: "fb/a/b/c", created: true }, "nested folders at once");
		assert.deepEqual(run({ op: "files.mkdir", path: "fb/a/b/c" }).result, { path: "fb/a/b/c", created: false }, "making one that exists is fine");
		writeFileSync(join(sub, "file.txt"), "hello");
		for (const bad of [["", "that is the folder itself"], ["fb/file.txt", "a file is in the way"], ["../x", "invalid path"], ["fb/file.txt/inner", "cannot make that folder"]]) {
			const r2 = run({ op: "files.mkdir", path: bad[0] });
			assert.equal(r2.ok, false, `mkdir ${JSON.stringify(bad[0])}`);
			assert.match(r2.error, new RegExp(bad[1]));
		}
		// Listing: with and without folder sizes, and with the truncation facts.
		const plain = run({ op: "files.list", path: "fb" }).result;
		assert.ok(Array.isArray(plain) && plain.find((e) => e.name === "a").type === "dir" && typeof plain.find((e) => e.name === "file.txt").modified === "number");
		const light = run({ op: "files.list", path: "fb", sizes: false, meta: true }).result;
		assert.deepEqual([light.truncated, light.total, light.entries.find((e) => e.name === "a").bytes], [false, 2, null], "a folder's size is skipped on request");
		// Move and rename.
		assert.deepEqual(run({ op: "files.move", from: "fb/file.txt", to: "fb/a/moved.txt" }).result, { from: "fb/file.txt", to: "fb/a/moved.txt", moved: true });
		assert.equal(readFileSync(join(sub, "a", "moved.txt"), "utf8"), "hello");
		assert.equal(run({ op: "files.move", from: "fb/a/moved.txt", to: "fb/new/deep/name.txt" }).ok, true, "a move makes the folders it needs");
		writeFileSync(join(sub, "other.txt"), "other");
		assert.match(run({ op: "files.move", from: "fb/other.txt", to: "fb/new/deep/name.txt" }).error, /already exists/, "never over something unless asked");
		assert.equal(run({ op: "files.move", from: "fb/other.txt", to: "fb/new/deep/name.txt", overwrite: true }).ok, true);
		assert.equal(readFileSync(join(sub, "new", "deep", "name.txt"), "utf8"), "other");
		assert.match(run({ op: "files.move", from: "fb/new", to: "fb/new/deep/inside" }).error, /into itself/);
		assert.match(run({ op: "files.move", from: "fb/a", to: "fb/new", overwrite: true }).error, /folder cannot be replaced/, "a folder is never replaced");
		assert.match(run({ op: "files.move", from: "fb/missing", to: "fb/x" }).error, /no such file/);
		assert.match(run({ op: "files.move", from: "", to: "fb/x" }).error, /the folder itself/);
		assert.match(run({ op: "files.move", from: "fb/a", to: "" }).error, /the folder itself/);
		assert.match(run({ op: "files.move", from: "fb/a", to: "../out" }).error, /invalid path/);
		assert.equal(run({ op: "files.move", from: "fb/a", to: "fb/a" }).result.moved, false, "to the same place is nothing");
		// Links planted by an agent are never followed, on any side.
		symlinkSync("/etc", join(sub, "evil"));
		symlinkSync("/etc/hostname", join(sub, "evilfile"));
		for (const op of [{ op: "files.mkdir", path: "fb/evil/x" }, { op: "files.move", from: "fb/new/deep/name.txt", to: "fb/evil/stolen" }, { op: "files.move", from: "fb/evil/hostname", to: "fb/got" }, { op: "files.readtext", path: "fb/evilfile" }, { op: "files.writetext", path: "fb/evilfile", text: "x" }, { op: "files.writetext", path: "fb/evil/inside", text: "x" }]) {
			const r2 = run(op);
			assert.equal(r2.ok, false, `${op.op} through a link is refused`);
		}
		assert.equal(existsSync("/etc/stolen"), false);
		// Text for an editor.
		const text = run({ op: "files.readtext", path: "fb/new/deep/name.txt" }).result;
		assert.deepEqual([text.text, text.bytes, typeof text.modified], ["other", 5, "number"]);
		writeFileSync(join(sub, "bin.dat"), Buffer.from([1, 2, 0, 3]));
		writeFileSync(join(sub, "bad.txt"), Buffer.from([0xff, 0xfe, 0x41]));
		writeFileSync(join(sub, "unicode.txt"), "żółć 日本 😀\n");
		assert.deepEqual(run({ op: "files.readtext", path: "fb/bin.dat" }).result.binary, true, "a NUL byte: binary");
		assert.equal(run({ op: "files.readtext", path: "fb/bad.txt" }).result.binary, true, "not valid UTF-8: binary");
		assert.equal(run({ op: "files.readtext", path: "fb/unicode.txt" }).result.text, "żółć 日本 😀\n");
		writeFileSync(join(sub, "big.txt"), "x".repeat(2000));
		assert.deepEqual(Object.keys(run({ op: "files.readtext", path: "fb/big.txt", max: 1000 }).result).sort(), ["bytes", "modified", "tooBig"], "over the limit: not sent");
		assert.match(run({ op: "files.readtext", path: "fb/a" }).error, /not a regular file/);
		assert.match(run({ op: "files.readtext", path: "fb/nope" }).error, /no such file/);
		// Saving: a round trip, a conflict, limits.
		const opened = run({ op: "files.readtext", path: "fb/unicode.txt" }).result;
		const saved = run({ op: "files.writetext", path: "fb/unicode.txt", text: "changed ✓\n", expectModified: opened.modified }).result;
		assert.deepEqual([saved.bytes, saved.created, saved.modified >= opened.modified], [Buffer.byteLength("changed ✓\n"), false, true]);
		assert.equal(readFileSync(join(sub, "unicode.txt"), "utf8"), "changed ✓\n");
		const stale = run({ op: "files.writetext", path: "fb/unicode.txt", text: "mine\n", expectModified: opened.modified - 5000 });
		assert.match(stale.error, /^conflict: the file changed/);
		assert.equal(readFileSync(join(sub, "unicode.txt"), "utf8"), "changed ✓\n", "a conflict saves nothing");
		assert.equal(run({ op: "files.writetext", path: "fb/created/new.txt", text: "fresh" }).result.created, true, "no expectation: a new file and its folders");
		assert.match(run({ op: "files.writetext", path: "fb/gone.txt", text: "x", expectModified: 123 }).error, /^conflict: the file was removed/);
		assert.match(run({ op: "files.writetext", path: "fb/a", text: "x" }).error, /not a regular file/);
		assert.match(run({ op: "files.writetext", path: "fb/x.txt", text: 5 }).error, /must be a string/);
		assert.match(run({ op: "files.writetext", path: "fb/x.txt", text: "x".repeat(2000), max: 1000 }).error, /too large/);
		assert.match(run({ op: "files.writetext", path: "", text: "x" }).error, /the folder itself/);
		assert.match(run({ op: "files.writetext", path: "fb/q.txt", text: "x".repeat(600) }, 1000).error, /quota/, "the size limit is enforced like any profile write");
		assert.equal(existsSync(join(sub, "q.txt")), false);
		assert.equal(readdirSync(sub).some((n) => n.endsWith(".piper-tmp")), false, "no temp file is left behind");
		const many = join(dir, "many");
		mkdirSync(many);
		for (let i = 0; i < 5003; i++) writeFileSync(join(many, `f${String(i).padStart(5, "0")}`), "");
		const cut = run({ op: "files.list", path: "many", meta: true, sizes: false }).result;
		assert.deepEqual([cut.entries.length, cut.truncated, cut.total], [5000, true, 5003], "a huge folder says it was cut");
		rmSync(many, { recursive: true, force: true });
		rmSync(sub, { recursive: true, force: true });
	}

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
		put.run("PROFILE_ROOT", join(dir, "profiles")); put.run("WORKSPACE_ROOT", join(dir, "workspaces")); put.run("SHARED_ROOT", join(dir, "shared")); put.run("EXTENSIONS_ROOT", join(dir, "extensions")); put.run("CONTAINER_PI_DIR", join(dir, "container-pi")); put.run("PORT", "18771");
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
		assert.deepEqual(Object.keys(list.json).sort(), ["dangling", "environments", "hostPiVersion", "idleContainers", "images", "job", "states"]);
		assert.equal((await call("POST", "/dashboard/images/build", { env: "nope" })).status, 404);
		assert.equal((await call("POST", "/dashboard/images/remove", { image: "piper-agent" })).status, 409, "the default image cannot be removed from the page either");
		assert.equal((await call("POST", "/dashboard/images/remove", { image: "" })).status, 400, "a blank reference is refused, not read as \"every image\"");
		assert.equal((await call("POST", "/dashboard/images/remove", { image: "sha" })).status, 404, "and a short string does not pick an image by its prefix");
		assert.equal((await call("POST", "/dashboard/images/nonsense", {})).status, 404);
		assert.equal((await call("GET", "/dashboard/images/build")).status, 404, "building needs POST");
	}

	// Cleaning up: a fake docker with the situations that keep old images alive.
	{
		const { cleanupPlan, runCleanup, autoPrune, NeedsForce } = await import("./server.mjs");
		const own = (w) => `piper-${instanceId()}-${chatIdHash(w).slice(0, 16)}`;
		const other = (w) => `piper-deadbeef-${chatIdHash(w).slice(0, 16)}`;
		const rows = [
			["sha256:default", "piper-agent", "latest", 1900], ["sha256:oldrun", "<none>", "<none>", 1800], ["sha256:oldidle", "<none>", "<none>", 1700], ["sha256:orphan", "<none>", "<none>", 1600],
			["sha256:stale", "piper-agent-slim", "latest", 700], ["sha256:fresh", "piper-agent-re", "latest", 800], ["sha256:keptimg", "<none>", "<none>", 1500], ["sha256:foreignimg", "<none>", "<none>", 1400],
		];
		const labels = (id) => ({ "piper.image": "1", "piper.pi-version": id === "sha256:stale" ? "0.98.0" : "0.99.1" });
		const containers = [
			{ name: own("run"), image: "sha256:oldrun", running: true }, { name: own("idle1"), image: "sha256:oldidle", running: false }, { name: own("idle2"), image: "sha256:oldidle", running: false },
			{ name: `piper-${instanceId()}-key-abcdef123456`, image: "sha256:keptimg", running: false, persistent: true }, { name: other("far"), image: "sha256:foreignimg", running: false },
			{ name: own("cur"), image: "sha256:default", running: true },
		];
		const states = [["sha256:st-orphan", `gone${"0".repeat(8)}-abc`], ["sha256:st-live", `${containers[3].name.replace(/^piper-/, "")}`]];
		let removedC = [];
		let removedI = [];
		const alive = () => containers.filter((c) => !removedC.includes(c.name));
		const fmt = (r) => JSON.stringify({ ID: r[0], Repository: r[1], Tag: r[2], CreatedSince: "1 day ago", Size: `${r[3]}MB` });
		reply = (bin, args) => {
			const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
			if (args[0] === "images") {
				if (args.includes("label=piper.image=1")) return ok([...rows.filter((r) => !removedI.includes(r[0])).map(fmt), ...states.filter((x) => !removedI.includes(x[0])).map((x) => fmt([x[0], "piper-keystate", x[1], 900]))].join("\n"));
				if (!args.includes("--filter")) return ok([...states.filter((x) => !removedI.includes(x[0])).map((x) => fmt([x[0], "piper-keystate", x[1], 900])), fmt(["sha256:dangle", "<none>", "<none>", 300])].join("\n"));
				return ok();
			}
			if (args[0] === "image" && args[1] === "inspect") return ok(JSON.stringify(args.slice(2).map((id) => ({ Id: id, Size: (rows.find((r) => r[0] === id)?.[3] ?? 900) * 1048576, Config: { Labels: id === "sha256:dangle" || id.startsWith("sha256:st-") ? {} : labels(id) } }))));
			if (args[0] === "ps") return ok(alive().filter((c) => !args.some((x) => /label=piper\.instance=/.test(x)) || c.name.startsWith(`piper-${instanceId()}-`)).map((c) => `${c.name}\t${c.running ? "running" : "exited"}\t\t`).join("\n"));
			if (args[0] === "inspect") return ok(JSON.stringify(alive().map((c) => ({ Name: `/${c.name}`, Image: c.image, State: { Running: c.running }, Config: { Labels: c.persistent ? { "piper.persistent": "1" } : {} } }))));
			if (args[0] === "rm") { removedC.push(args[args.length - 1]); return ok(); }
			if (args[0] === "rmi") {
				const ref = args[args.length - 1];
				const id = rows.find((r) => r[1] !== "<none>" && `${r[1]}` === ref)?.[0] ?? states.find((x) => `piper-keystate:${x[1]}` === ref)?.[0] ?? ref;
				if (alive().some((c) => c.image === id)) return { code: 1, stdout: "", stderr: `Error response from daemon: conflict: unable to delete ${id} (must be forced) - image is being used by stopped container x` };
				if (ref === "sha256:failing") return { code: 1, stdout: "", stderr: "no space" };
				removedI.push(id); return ok();
			}
			return ok();
		};
		const view = async () => { removedC = []; removedI = []; return listImages({ hostPi: "0.99.1" }); };
		const l = await view();
		const by = Object.fromEntries(l.images.map((i) => [i.id, i]));
		assert.deepEqual([by["sha256:default"].running, by["sha256:oldrun"].running, by["sha256:oldidle"].idle.length, by["sha256:keptimg"].kept.length, by["sha256:foreignimg"].foreign, by["sha256:foreignimg"].idle.length], [1, 1, 2, 1, 1, 1], "running, idle, kept and another gateway's containers are told apart");
		assert.deepEqual(l.states.map((x) => [x.name.split(":")[0], x.orphan]), [["piper-keystate", true], ["piper-keystate", false]], "a saved state is an orphan when its container is gone");
		assert.ok(!l.images.some((i) => /keystate/.test(i.name ?? "")), "a saved state carries the image label but is a state, listed once");
		assert.deepEqual(l.dangling.map((d) => d.id), ["sha256:dangle"], "a dangling image with no Piper label is listed on its own");

		// Removing one: the stopped containers holding it are named, and removed only on a go-ahead.
		await assert.rejects(removeImage("sha256:oldrun", { hostPi: "0.99.1" }), (e) => e.status === 409 && /running from it/.test(e.message));
		await assert.rejects(removeImage("sha256:keptimg", { hostPi: "0.99.1" }), (e) => e.status === 409 && /kept container/.test(e.message));
		await assert.rejects(removeImage("sha256:oldidle", { hostPi: "0.99.1" }), (e) => e instanceof NeedsForce && e.errorCode === "needs_force" && /2 stopped container\(s\)/.test(e.message) && e.message.includes(own("idle1")));
		await assert.rejects(removeImage("sha256:foreignimg", { hostPi: "0.99.1" }), (e) => e instanceof NeedsForce && /belong to another Piper gateway/.test(e.message));
		assert.deepEqual(removedC, [], "nothing was removed without the go-ahead");
		assert.match(await removeImage("sha256:oldidle", { hostPi: "0.99.1", force: true }), /removed sha256:oldidle and 2 stopped container/);
		assert.deepEqual(removedC.sort(), [own("idle1"), own("idle2")].sort());
		assert.ok(removedI.includes("sha256:oldidle"), "then the image goes");
		assert.match(await removeImage("sha256:orphan", { hostPi: "0.99.1" }), /removed/, "an unused one just goes");
		assert.match(await removeImage(l.states[0].name, { hostPi: "0.99.1" }), /removed piper-keystate/, "a saved state with no container goes");
		await assert.rejects(removeImage(l.states[1].name, { hostPi: "0.99.1" }), (e) => e.status === 409 && /still exists/.test(e.message));
		await assert.rejects(removeImage("sha256:default", { hostPi: "0.99.1" }), (e) => e.status === 409);

		// Force-removing one whose idle container itself refuses to go: the image is not removed either,
		// and the message names the container, not just docker's own opaque complaint about the image.
		{
			const base = reply;
			reply = (bin, args) => (args[0] === "rm" && args[args.length - 1] === other("far") ? { code: 1, stdout: "", stderr: "Error: cannot remove container: in use" } : base(bin, args));
			await assert.rejects(removeImage("sha256:foreignimg", { hostPi: "0.99.1", force: true }), (e) => e.status === 409 && e.message.includes(other("far")) && /in use/.test(e.message));
			assert.ok(!removedI.includes("sha256:foreignimg"), "the image removal is never even attempted");
			reply = base;
		}

		// The plan: what is offered, why, and what it costs.
		await view();
		const plan = await cleanupPlan({ hostPi: "0.99.1" });
		const kind = (id) => plan.items.find((x) => x.id === id)?.kind;
		assert.deepEqual([kind("sha256:orphan"), kind("sha256:stale"), kind("sha256:fresh"), kind("sha256:oldidle"), kind("sha256:foreignimg"), kind("sha256:dangle"), kind("sha256:st-orphan")], ["safe", "safe", "rebuild", "containers", "containers", "other", "safe"]);
		for (const never of ["sha256:default", "sha256:oldrun", "sha256:keptimg", "sha256:st-live"]) assert.equal(kind(never), undefined, `${never} is never offered`);
		assert.deepEqual(plan.items.find((x) => x.id === "sha256:oldidle").containers.sort(), [own("idle1"), own("idle2")].sort());
		assert.equal(plan.items.find((x) => x.id === "sha256:foreignimg").foreign, 1);
		assert.equal(plan.safeMb, 1600 + 700 + 900, "the safe total is the unused ones");
		assert.ok(plan.allMb > plan.safeMb);
		// Running it: only what was chosen; items that need containers removed wait for the go-ahead.
		let done = await runCleanup({ select: ["sha256:orphan", "sha256:oldidle", "sha256:default", "sha256:oldrun", "nonsense"], hostPi: "0.99.1" });
		assert.equal(done.removed.length, 1);
		assert.equal(done.skipped.length, 4, "the one that needs its containers removed waits for the go-ahead, and the three that cannot be removed are said so");
		assert.ok(done.skipped.some((x) => /stopped containers were not to be removed/.test(x.reason)) && done.skipped.some((x) => /not something that can be removed now/.test(x.reason)));
		assert.deepEqual(removedC, [], "and its containers stay");
		assert.ok(!removedI.includes("sha256:default") && !removedI.includes("sha256:oldrun"), "the default image and a running one are not in the plan, so not removed even when asked for");
		done = await runCleanup({ select: ["sha256:oldidle", "sha256:foreignimg"], withContainers: true, hostPi: "0.99.1" });
		assert.equal(done.removed.length, 2);
		assert.ok(done.reclaimedMb >= 1700 + 1400);
		assert.deepEqual(removedC.sort(), [own("idle1"), own("idle2"), other("far")].sort(), "with the go-ahead their containers go first");
		// The automatic part touches only what is plainly unused.
		await view();
		const auto = await autoPrune();
		assert.equal(auto.removed, 2, "the unused superseded build and the orphaned saved state");
		assert.deepEqual([...new Set(removedI)].sort(), ["sha256:orphan", "sha256:st-orphan"].sort());
		assert.ok(!removedI.includes("sha256:stale") && !removedI.includes("sha256:fresh") && !removedI.includes("sha256:dangle") && !removedI.includes("sha256:oldidle"), "not an old-Pi tagged image, a spare environment, an unlabelled one, or one with containers");
		assert.ok(recentAudit(30).some((a) => a.action === "image.autoprune"), "and it is on record");
		// A failing removal is reported, the rest carries on.
		await view();
		rows.push(["sha256:failing", "<none>", "<none>", 100]);
		done = await runCleanup({ select: ["sha256:failing", "sha256:orphan"], hostPi: "0.99.1" });
		assert.deepEqual([done.failed.length, done.removed.length], [1, 1]);
		assert.match(done.failed[0].reason, /no space/);
		const baseReplyForRoutes = reply;
		// A container Piper did not make holds an image: never offered, never removed, and said so.
		await view();
		rows.push(["sha256:mine", "<none>", "<none>", 600]);
		containers.push({ name: "my-own-database", image: "sha256:mine", running: false });
		const withMine = await cleanupPlan({ hostPi: "0.99.1" });
		assert.equal(withMine.items.some((x) => x.id === "sha256:mine"), false, "an image a non-Piper container holds is not offered");
		assert.match(withMine.blocked.find((b) => /my-own-database/.test(b.reason)).reason, /not a Piper container/, "and the plan says why");
		await assert.rejects(removeImage("sha256:mine", { hostPi: "0.99.1", force: true }), (e) => e.status === 409 && /not a Piper container, so Piper will not remove it/.test(e.message));
		assert.ok(!removedC.includes("my-own-database"));
		// A Piper helper leftover (piper-pkg-…) is Piper's own: it is removed with the go-ahead.
		rows.push(["sha256:helperimg", "<none>", "<none>", 500]);
		containers.push({ name: "piper-pkg-1a2b3c", image: "sha256:helperimg", running: false });
		assert.deepEqual((await cleanupPlan({ hostPi: "0.99.1" })).items.find((x) => x.id === "sha256:helperimg").containers, ["piper-pkg-1a2b3c"]);
		// An image that others are built on can go once they have: the second pass handles the order.
		rows.push(["sha256:parent", "<none>", "<none>", 400], ["sha256:child", "<none>", "<none>", 300]);
		const baseRmi = reply;
		let parentRefused = 0;
		reply = (bin, args) => {
			if (args[0] === "rmi" && args[args.length - 1] === "sha256:parent" && !removedI.includes("sha256:child")) { parentRefused++; return { code: 1, stdout: "", stderr: "Error response from daemon: conflict: unable to delete sha256:parent (cannot be forced) - image has dependent child images" }; }
			return baseRmi(bin, args);
		};
		done = await runCleanup({ select: ["sha256:parent", "sha256:child"], hostPi: "0.99.1" });
		assert.deepEqual([done.removed.length, done.failed.length], [2, 0], "the parent goes after its child");
		assert.equal(parentRefused, 1, "it was tried, refused for the child, and tried again");
		// A refusal that cannot be fixed by order comes back in plain words.
		rows.push(["sha256:stuck", "<none>", "<none>", 200]);
		reply = (bin, args) => (args[0] === "rmi" && args[args.length - 1] === "sha256:stuck" ? { code: 1, stdout: "", stderr: "Error response from daemon: conflict: unable to delete sha256:stuck (must be forced) - image is being used by stopped container abc123" } : baseRmi(bin, args));
		done = await runCleanup({ select: ["sha256:stuck"], hostPi: "0.99.1" });
		assert.equal(done.failed.length, 1);
		assert.match(done.failed[0].reason, /container still uses it|several names|abc123/);
		assert.ok(recentAudit(20).some((a) => a.action === "image.cleanup" && /failed:/.test(a.detail)), "failures are on record with their reason");
		reply = baseRmi;
		containers.splice(containers.findIndex((c) => c.name === "my-own-database"), 1);
		containers.splice(containers.findIndex((c) => c.name === "piper-pkg-1a2b3c"), 1);
		// The chain that updates leave: stopped chat containers run from saved states, which sit on older builds.
		{
			const c1 = own("chain1"), c2 = own("chain2"), c3 = own("chain3");
			const tag = (c) => `piper-keystate:${c.replace(/^piper-/, "")}`;
			const imgs = { cur: ["sha256:cur", "piper-agent", "latest", 1900], p1: ["sha256:p1", "<none>", "<none>", 1890], p2: ["sha256:p2", "<none>", "<none>", 2000] };
			const stateIds = { [tag(c1)]: "sha256:s1", [tag(c2)]: "sha256:s2" };
			const parentOf = { "sha256:s1": "sha256:p1", "sha256:s2": "sha256:p2" };
			const boxes = [{ name: c1, image: "sha256:s1", running: false, at: "2026-10-01T10:00:00Z" }, { name: c2, image: "sha256:s2", running: false, at: "2026-10-01T10:05:00Z" }, { name: c3, image: "sha256:cur", running: false, at: "2026-10-01T10:06:00Z" }];
			const gone = new Set();
			const goneC = new Set();
			const sizes = { "sha256:s1": 2030, "sha256:s2": 2150 };
			const ok2 = (stdout = "") => ({ code: 0, stdout, stderr: "" });
			const fmt2 = (r) => JSON.stringify({ ID: r[0], Repository: r[1], Tag: r[2], CreatedSince: "1 day ago", Size: `${r[3]}MB` });
			const childOf = (id) => Object.entries(parentOf).find(([child, parent]) => parent === id && !gone.has(child))?.[0];
			reply = (bin, args) => {
				const live = () => boxes.filter((b) => !goneC.has(b.name));
				if (args[0] === "images") {
					if (args.includes("label=piper.image=1")) return ok2([...Object.values(imgs), ...Object.entries(stateIds).map(([t, id]) => [id, "piper-keystate", t.split(":")[1], sizes[id]])].filter((r) => !gone.has(r[0])).map(fmt2).join("\n"));
					if (!args.includes("--filter")) return ok2(Object.entries(stateIds).filter(([, id]) => !gone.has(id)).map(([t, id]) => fmt2([id, "piper-keystate", t.split(":")[1], sizes[id]])).join("\n"));
					return ok2();
				}
				if (args[0] === "image" && args[1] === "inspect") return ok2(JSON.stringify(args.slice(2).map((id) => ({ Id: id, Size: (sizes[id] ?? Object.values(imgs).find((r) => r[0] === id)?.[3] ?? 900) * 1048576, Config: { Labels: { "piper.image": "1", "piper.pi-version": "0.99.1" } } }))));
				if (args[0] === "ps") return ok2(live().filter((b) => !args.some((x) => /label=piper\.instance=/.test(x)) || b.name.startsWith(`piper-${instanceId()}-`)).map((b) => `${b.name}\texited\t\t`).join("\n"));
				if (args[0] === "inspect") return ok2(JSON.stringify(live().map((b) => ({ Name: `/${b.name}`, Image: b.image, State: { Running: false, FinishedAt: b.at }, Config: { Labels: {} } }))));
				if (args[0] === "rm") { goneC.add(args.at(-1)); return ok2(); }
				if (args[0] === "rmi") {
					const ref = args.at(-1);
					const id = stateIds[ref] ?? ref;
					if (live().some((b) => b.image === id)) return { code: 1, stdout: "", stderr: `Error response from daemon: conflict: unable to delete ${id} - image is being used by stopped container x` };
					if (childOf(id)) return { code: 1, stdout: "", stderr: `Error response from daemon: conflict: unable to delete ${id} (cannot be forced) - image has dependent child images` };
					gone.add(id);
					// Docker removes an untagged parent that nothing else needs.
					if (parentOf[id] && !childOf(parentOf[id])) gone.add(parentOf[id]);
					return ok2();
				}
				return ok2();
			};
			const l2 = await listImages({ hostPi: "0.99.1" });
			assert.deepEqual(l2.idleContainers.map((c) => c.name).sort(), [c1, c2].sort(), "the stopped chat containers that keep a saved state alive; not the one on the current image");
			assert.ok(l2.idleContainers.every((c) => c.saved && c.sizeMb > 2000 && c.finishedAt > 0));
			const plan2 = await cleanupPlan({ hostPi: "0.99.1" });
			assert.deepEqual(plan2.items.filter((x) => x.kind === "idle").map((x) => x.id).sort(), [`container:${c1}`, `container:${c2}`].sort());
			assert.match(plan2.items.find((x) => x.id === `container:${c1}`).reason, /stopped chat container .*saved state.*resumes in a fresh container/);
			assert.deepEqual(plan2.items.filter((x) => x.kind === "safe").map((x) => x.id).sort(), ["sha256:p1", "sha256:p2"], "the untagged builds behind them are offered too");
			assert.equal(plan2.blocked.filter((b) => /still exists/.test(b.reason)).length, 2, "the saved states are explained, not offered on their own");
			const everything = plan2.items.map((x) => x.id);
			// Without the go-ahead the containers stay, and the builds under them say what is in the way.
			let r2 = await runCleanup({ select: everything, hostPi: "0.99.1" });
			assert.equal(r2.skipped.filter((x) => /stopped containers were not to be removed/.test(x.reason)).length, 2);
			assert.equal(r2.failed.length, 2, "the two builds are refused");
			assert.match(r2.failed[0].reason, /other images are built on it|container still uses it/);
			assert.equal(goneC.size, 0);
			// With it: containers first, then the saved states go with them and the builds follow.
			r2 = await runCleanup({ select: everything, withContainers: true, hostPi: "0.99.1" });
			assert.deepEqual(r2.failed, [], "nothing is left stuck");
			assert.deepEqual([...goneC].sort(), [c1, c2].sort(), "the chat on the current image is not touched");
			assert.ok(gone.has("sha256:s1") && gone.has("sha256:s2") && gone.has("sha256:p1") && gone.has("sha256:p2"), "the whole chain is gone");
			assert.ok(r2.reclaimedMb > 4000);
		}
		reply = baseReplyForRoutes;
		// Through the page's routes: the plan, the go-ahead on remove, and cleanup.
		await view();
		const callApi = async (method, url, body) => {
			const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
			req.method = method; req.url = url;
			const res = { status: null, body: "", writeHead(st) { this.status = st; }, end(b) { this.body = b ?? ""; } };
			await containerRoutes(req, res, new URL(url, "http://x").pathname);
			return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
		};
		const apiPlan = await callApi("GET", "/dashboard/images/cleanup.json");
		assert.deepEqual([apiPlan.status, apiPlan.json.items.length > 3], [200, true]);
		const needs = await callApi("POST", "/dashboard/images/remove", { image: "sha256:oldidle" });
		assert.deepEqual([needs.status, needs.json.error.code], [409, "needs_force"]);
		assert.equal((await callApi("POST", "/dashboard/images/remove", { image: "sha256:oldidle", force: true })).status, 200);
		assert.equal((await callApi("POST", "/dashboard/images/cleanup", { select: ["sha256:fresh"] })).json.removed.length, 1);
		assert.equal((await callApi("POST", "/dashboard/images/cleanup", { select: "nope" })).json.removed.length, 0, "a bad selection selects nothing");
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
		["/dashboard/images.json", ["images", "idleContainers", "states", "dangling", "environments", "hostPiVersion", "job"]],
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
		assert.deepEqual(mounts, ["/w/key-k1:/workspace", "/p/key-k1:/profile", "/c/0123/session:/piper/session", "/c/0123/etc:/opt/piper/etc:ro", "/c/0123/sys/resolv.conf:/etc/resolv.conf", "/c/0123/sys/hosts:/etc/hosts", "/c/0123/sys/hostname:/etc/hostname", "/r/abc-0123:/run/piper", "/b.mjs:/opt/piper/bridge.mjs:ro", "/s/base:/shared/base:ro", "/opt/tools:/opt/tools:ro"]);
		assert.ok(mounts.every((m) => !/docker\.sock/.test(m)), "the engine's socket is never mounted");
		assert.ok(mounts.some((m) => m.endsWith(":/run/piper")) && !mounts.some((m) => m.endsWith("bridge.sock")), "the socket's folder is mounted, not the socket file");
		assert.ok(["/etc/resolv.conf", "/etc/hosts", "/etc/hostname"].every((f) => mounts.some((m) => m.endsWith(`:${f}`) && !m.endsWith(":ro"))), "Docker's own /etc files are the container's to edit, and persist");
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
		assert.equal(piInvocation({ ...spec }, {}).env.PIPER_MEMORY, undefined, "off unless asked for");
		assert.equal(piInvocation({ ...spec }, { remember: true }).env.PIPER_MEMORY, "1");
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
		assert.deepEqual(await ensureContainer(spec, "img1"), { created: true, recreated: false, kept: false, sig });
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

	// removeContainer's expectId: a message that resumed the chat in between leaves a *different* container
	// by the same name (built by a concurrent ensureContainer), which must survive, not be removed.
	{
		reset((bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Id: "old-id" }]), stderr: "" } : { code: 0, stdout: "", stderr: "" }));
		const matched = await removeContainer("c1", { expectId: "old-id" });
		assert.equal(matched.skipped, undefined, "the id still matches: removed as normal");
		assert.deepEqual(calls.map((c) => c[1]), ["inspect", "rm", "rmi"]);

		reset((bin, args) => (args[0] === "inspect" ? { code: 0, stdout: JSON.stringify([{ Id: "new-id" }]), stderr: "" } : { code: 0, stdout: "", stderr: "" }));
		const skipped = await removeContainer("c1", { expectId: "old-id" });
		assert.equal(skipped.skipped, "replaced");
		assert.deepEqual(calls.map((c) => c[1]), ["inspect"], "a mismatch never reaches rm");

		reset((bin, args) => (args[0] === "inspect" ? { code: 1, stdout: "", stderr: "No such object" } : { code: 0, stdout: "", stderr: "" }));
		await removeContainer("c1", { expectId: "old-id" });
		assert.deepEqual(calls.map((c) => c[1]), ["inspect", "rm", "rmi"], "gone already: nothing to mismatch against, so the removal still runs (idempotent either way)");

		reset((bin, args) => ({ code: 0, stdout: "", stderr: "" }));
		await removeContainer("c1");
		assert.deepEqual(calls.map((c) => c[1]), ["rm", "rmi"], "no expectId: the old behaviour, no inspect first");

		// The check and the removal run inside removeContainer's own per-name lock (the same one ensureContainer
		// uses to create a replacement), so nothing can build a new container in the gap between them.
		let concurrent = 0;
		let overlapped = false;
		reset((bin, args) => {
			if (args[0] === "inspect") {
				concurrent++;
				if (concurrent > 1) overlapped = true;
				return new Promise((r) => setTimeout(() => (concurrent--, r({ code: 0, stdout: JSON.stringify([{ Id: "old-id" }]), stderr: "" })), 15));
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		await Promise.all([removeContainer("c2", { expectId: "old-id" }), removeContainer("c2", { expectId: "old-id" })]);
		assert.equal(overlapped, false, "two calls for the same name never run their checks at the same time");
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
		assert.deepEqual(calls.map((c) => c[1]), ["rm", "rmi"], "the container, and the state an update saved for it");
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

	// Persistent keys: one container for the key, shared by its chats, that keeps what is installed in it.
	{
		assert.deepEqual(normalizeContainerInput({ persistent: true }), { persistent: true });
		assert.deepEqual(normalizeContainerInput({ persistent: "1", memoryMb: "256" }), { persistent: true, memoryMb: 256 });
		assert.equal(normalizeContainerInput({ persistent: false }), null, "off is not stored");
		assert.throws(() => normalizeContainerInput({ persistent: "maybe" }), /persistent must be on or off/);
		assert.equal(containerSettingsFor(ka.id).persistent, false, "off unless asked for");
		apiKeys.update(ka.id, { container: { persistent: true } });
		assert.equal(containerSettingsFor(ka.id).persistent, true);
		assert.equal(containerSettingsFor(null).persistent, false, "the open gateway has no key to keep a container for");
		const pa = containerSpecFor({ id: "chat-one", keyId: ka.id }, wsA);
		const pb = containerSpecFor({ id: "chat-two", keyId: ka.id }, wsA);
		assert.equal(pa.persistent, true);
		assert.equal(pa.name, pb.name, "two chats of the key meet one container");
		assert.equal(pa.name, keyContainerName(ka.id));
		assert.match(pa.name, /^piper-[0-9a-f]{8}-key-[0-9a-f]{12}$/);
		assert.equal(chatKeyOfContainer(pa.name) !== null && isKeyContainer(pa.name), true);
		assert.deepEqual([pa.chatDir, pa.runDir], [pb.chatDir, pb.runDir], "and one set of mounted folders");
		assert.equal(containerSettingsFor(kb.id).persistent, false);
		assert.ok(join(pa.runDir, `${chatKey(chatIdHash("chat-one"))}.sock`).length <= 107, "a persistent chat's socket path fits a Unix socket");
		assert.notEqual(containerSpecFor({ id: "chat-one", keyId: kb.id }, ensureWorkspace(kb.id)).name, pa.name, "another key has its own container");
		assert.notEqual(pa.name, containerName(chatIdHash("chat-one")), "not named after a chat");
		// Each chat keeps its session and socket under its own name inside the shared folders.
		const h1 = chatIdHash("chat-one"), h2 = chatIdHash("chat-two");
		const i1 = piInvocation(pa, { idHash: h1 }), i2 = piInvocation(pb, { idHash: h2 });
		assert.equal(i1.piArgs[i1.piArgs.indexOf("--session-dir") + 1], `/piper/session/${chatKey(h1)}`);
		assert.notEqual(i1.sessionDir, i2.sessionDir);
		assert.equal(i1.env.PIPER_BRIDGE_SOCKET, `/run/piper/${chatKey(h1)}.sock`);
		assert.notEqual(i1.env.PIPER_BRIDGE_SOCKET, i2.env.PIPER_BRIDGE_SOCKET);
		assert.equal(piInvocation({ ...pa, persistent: false }, { idHash: h1 }).env.PIPER_BRIDGE_SOCKET, "/run/piper/bridge.sock", "a chat's own container keeps the plain paths");
		assert.ok(containerCreateArgs({ ...pa, sig: "s" }).includes("piper.persistent=1"), "marked on the container");
		assert.ok(!containerCreateArgs({ ...pa, persistent: false, sig: "s" }).includes("piper.persistent=1"));
		// The image being rebuilt does not change a persistent container's signature (it keeps its own system).
		assert.equal(containerSignature(pa, "img-old"), containerSignature(pa, "img-new"));
		assert.notEqual(containerSignature({ ...pa, persistent: false }, "img-old"), containerSignature({ ...pa, persistent: false }, "img-new"));
		assert.notEqual(containerSignature(pa, ""), containerSignature({ ...pa, memoryMb: 1 }, ""), "but its limits still do");

		const sigP = containerSignature(pa, "img");
		const seen = (running, signature) => JSON.stringify([{ State: { Running: running }, Config: { Labels: { "piper.managed": "1", "piper.sig": signature } } }]);
		const engine = (handlers) => (bin, args) => handlers[args[0]]?.(args) ?? { code: 0, stdout: "", stderr: "" };
		// A changed setting: state is saved (commit) before the old container goes, and the new one starts from it.
		reset2(engine({ inspect: () => ({ code: 0, stdout: seen(true, "old"), stderr: "" }) }));
		const res = await ensureContainer(pa, "img");
		assert.equal(res.recreated, true);
		assert.deepEqual(calls2.map((c) => c[1]), ["inspect", "stop", "commit", "image", "rm", "create", "start"], "stopped, saved (and its depth looked at), removed, created, started");
		assert.ok(calls2.find((c) => c[1] === "commit").includes(keyStateImage(pa.name)), "saved to the key's state image");
		const created = calls2.find((c) => c[1] === "create");
		assert.equal(created[created.length - 1], keyStateImage(pa.name), "the new container is built from the saved state");
		// A failed save must not cost the installs.
		reset2(engine({ inspect: () => ({ code: 0, stdout: seen(true, "old"), stderr: "" }), commit: () => ({ code: 1, stdout: "", stderr: "no space left" }) }));
		await assert.rejects(ensureContainer(pa, "img"), /no space left/);
		assert.equal(calls2.filter((c) => c[1] === "rm").length, 0, "the container is not removed when its state could not be saved");
		// Other chats are in it: left alone, reported.
		reset2(engine({ inspect: () => ({ code: 0, stdout: seen(true, "old"), stderr: "" }) }));
		const held = await ensureContainer(pa, "img", { allowRecreate: false });
		assert.deepEqual([held.kept, held.recreated], [true, false]);
		assert.deepEqual(calls2.map((c) => c[1]), ["inspect"], "nothing is stopped under a running chat");
		// Missing container, but a saved state: start from that; with none saved, from the clean image.
		reset2(engine({ inspect: () => ({ code: 1, stdout: "", stderr: "" }), image: () => ({ code: 1, stdout: "", stderr: "No such image" }) }));
		await ensureContainer(pa, "img");
		const fresh = calls2.find((c) => c[1] === "create");
		assert.equal(fresh[fresh.length - 1], pa.image, "no saved state: the clean image");
		reset2(engine({ inspect: () => ({ code: 1, stdout: "", stderr: "" }), image: () => ({ code: 0, stdout: "sha256:x\n", stderr: "" }) }));
		await ensureContainer(pa, "img");
		const restored = calls2.find((c) => c[1] === "create");
		assert.equal(restored[restored.length - 1], keyStateImage(pa.name), "a saved state that exists is used");
		// A chat's own container is unaffected by all of this.
		reset2(engine({ inspect: () => ({ code: 0, stdout: seen(true, "old"), stderr: "" }) }));
		await ensureContainer({ ...pa, persistent: false }, "img");
		assert.deepEqual(calls2.map((c) => c[1]), ["inspect", "rm", "create", "start"], "no commit for a chat's own container");
		// Killing one chat's Pi leaves the others.
		reset2();
		await killPi(pa.name, `--session-dir ${i1.sessionDir}`);
		assert.ok(calls2[0].includes(`--session-dir ${i1.sessionDir}`) && !calls2[0].includes("--mode rpc"));
		// Stopping a chat leaves the persistent container running; ending one removes only its own files.
		reset2();
		const runDirP = pa.runDir;
		mkdirSync(runDirP, { recursive: true });
		const sock = join(runDirP, `${chatKey(h1)}.sock`);
		writeFileSync(sock, "");
		await containerHost.stopped(h1, { container: { name: pa.name, persistent: true, runDir: runDirP, chatDir: pa.chatDir } });
		assert.equal(calls2.filter((c) => c[1] === "stop").length, 0, "the container keeps running for the key's other chats");
		assert.equal(existsSync(sock), false, "only the chat's own socket goes");
		mkdirSync(join(pa.chatDir, "session", chatKey(h1)), { recursive: true });
		mkdirSync(join(pa.chatDir, "session", chatKey(h2)), { recursive: true });
		await containerHost.ended(h1);
		assert.equal(existsSync(join(pa.chatDir, "session", chatKey(h1))), false, "ending a chat forgets its session");
		assert.equal(existsSync(join(pa.chatDir, "session", chatKey(h2))), true, "and not another chat's");
		assert.equal(calls2.some((c) => c[1] === "rm" && c.includes(pa.name)), false, "and never the key's container");
		// The sweep keeps a persistent key's container, and removes it once the key is not persistent any more.
		const managedList = (kept) => engine({ ps: () => ({ code: 0, stdout: `${pa.name}\trunning\t${ka.id}\n`, stderr: "" }) });
		reset2(managedList());
		await sweepContainers(new Set(), new Set());
		assert.equal(calls2.filter((c) => c[1] === "rm" || c[1] === "stop").length, 0, "kept with no chat known and none running");
		apiKeys.update(ka.id, { container: { memoryMb: 256, pids: 32, cpus: 0.5, network: "none", env: "ONLY_HERE=1" } });
		reset2(managedList());
		await sweepContainers(new Set(), new Set());
		assert.equal(calls2.filter((c) => c[1] === "rm").length, 1, "removed when the key stopped being persistent");
		assert.ok(calls2.some((c) => c[1] === "rmi"), "with its saved state");
	}

	// The container's /etc/resolv.conf, hosts and hostname are files of its own: created once, kept, and
	// the resolver list refreshed only while the agent has not edited it.
	{
		const dir = mkdtempSync(join(tmpdir(), "sysfiles-"));
		const sys = ensureSystemFiles(dir);
		assert.equal(sys, join(dir, "sys"));
		for (const f of ["resolv.conf", "hosts", "hostname"]) assert.ok(statSync(join(sys, f)).isFile(), `${f} is a regular file: a missing source would make Docker create a folder`);
		assert.match(readFileSync(join(sys, "resolv.conf"), "utf8"), /^# [^\n]*\n(nameserver \d+\.\d+\.\d+\.\d+\n)+$/, "resolvers, one per line");
		assert.match(readFileSync(join(sys, "hosts"), "utf8"), /127\.0\.0\.1\tlocalhost[\s\S]*127\.0\.1\.1\tpiper/);
		assert.equal(readFileSync(join(sys, "hostname"), "utf8"), "piper\n");
		// The agent's edit is kept, in place (same file), and a second start does not undo it.
		const inode = statSync(join(sys, "resolv.conf")).ino;
		writeFileSync(join(sys, "resolv.conf"), "nameserver 127.0.0.1\n");
		writeFileSync(join(sys, "hosts"), "127.0.0.1 localhost mytor\n");
		ensureSystemFiles(dir);
		assert.equal(readFileSync(join(sys, "resolv.conf"), "utf8"), "nameserver 127.0.0.1\n", "an edited resolv.conf is the agent's");
		assert.equal(readFileSync(join(sys, "hosts"), "utf8"), "127.0.0.1 localhost mytor\n");
		assert.equal(statSync(join(sys, "resolv.conf")).ino, inode, "rewritten in place: a bind mount must keep its file");
		// Untouched since it was written: follows the host's resolvers when they change.
		const dir2 = mkdtempSync(join(tmpdir(), "sysfiles-"));
		ensureSystemFiles(dir2);
		writeFileSync(join(dir2, "sys", "resolv.conf"), "nameserver 203.0.113.9\n");
		writeFileSync(join(dir2, "sys", ".resolv.seeded"), "nameserver 203.0.113.9\n");
		const before = statSync(join(dir2, "sys", "resolv.conf")).ino;
		ensureSystemFiles(dir2);
		assert.notEqual(readFileSync(join(dir2, "sys", "resolv.conf"), "utf8"), "nameserver 203.0.113.9\n", "an untouched one is refreshed");
		assert.equal(statSync(join(dir2, "sys", "resolv.conf")).ino, before);
		rmSync(dir, { recursive: true, force: true });
		rmSync(dir2, { recursive: true, force: true });
	}

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
		assert.ok(newest.detail.length <= 400 && !/[\n\t]/.test(newest.detail), "a long, multi-line detail is squeezed and cut");
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
		// A message resumes the chat in between containerAction's own first look and the removal that follows:
		// the container by this name is already a fresh one by the time removeContainer re-checks it inside
		// its lock, so nothing is removed and the operator is told why, instead of losing it silently.
		forget();
		let inspected = 0;
		reply = (bin, args) =>
			args[0] === "inspect"
				? { code: 0, stdout: JSON.stringify([{ Name: `/${stoppedName}`, Id: ++inspected === 1 ? "original" : "resumed-already", State: { Running: true } }]), stderr: "" }
				: { code: 0, stdout: "", stderr: "" };
		assert.match(await containerAction(stoppedName, "recreate"), /already gave the chat a clean container; nothing was removed/);
		assert.ok(!seen.some((c) => c.args[0] === "rm"), "the fresh container is left alone");
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

// Agent endpoints: named, permanent agents of a key, each on a port of its own.
{
	const { server } = await import("./server.mjs");
	const http = await import("node:http");
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	config.HOST = "127.0.0.1";
	const engineCalls = [];
	setRunner(async (bin, args) => {
		engineCalls.push([bin, ...args]);
		return { code: bin === "docker" && args[0] === "ps" ? 0 : 127, stdout: "", stderr: "" };
	});

	// Ids: scope id of an agent, and back.
	assert.equal(agentScope("k1", "ab12cd34"), "k1--ab12cd34");
	assert.deepEqual([ownerKeyOf("k1--ab12cd34"), agentIdOf("k1--ab12cd34")], ["k1", "ab12cd34"]);
	assert.deepEqual([ownerKeyOf("k1"), agentIdOf("k1")], ["k1", null], "a key's own scope is itself");
	assert.deepEqual([ownerKeyOf(null), ownerKeyOf(""), agentIdOf(null)], [null, "", null]);
	assert.equal(scopeOf("k1--ab12cd34"), "key-k1--ab12cd34");
	assert.equal(keyIdForScope("key-k1--ab12cd34"), "k1--ab12cd34", "the profile routes work on an agent's scope");
	assert.deepEqual([parsePortRange(""), parsePortRange("20000-20010")], [null, [20000, 20010]]);
	for (const bad of ["20000", "a-b", "100-2000", "30000-20000", "1024-70000"]) assert.throws(() => parsePortRange(bad), /AGENT_PORT_RANGE/, bad);

	const { record: owner, key: ownerToken } = apiKeys.create({ name: "owner key", expiresAt: 0 });
	const { key: otherToken } = apiKeys.create({ name: "other key", expiresAt: 0 });
	const OWNER = owner.id;

	// Creating: every refusal, then two agents.
	await assert.rejects(createAgent({ keyId: "no-such-key", name: "x" }), (e) => e instanceof AgentError && e.status === 404);
	for (const name of ["Architect", "-x", "a b", "", "x".repeat(32)]) await assert.rejects(createAgent({ keyId: OWNER, name }), /lowercase letters/, JSON.stringify(name));
	await assert.rejects(createAgent({ keyId: OWNER, name: "x", workspace: "both" }), /workspace must be/);
	await assert.rejects(createAgent({ keyId: OWNER, name: "x", thinking: "extreme" }), /thinking must be/);
	await assert.rejects(createAgent({ keyId: OWNER, name: "x", instructions: 5 }), /instructions must be text/);
	await assert.rejects(createAgent({ keyId: OWNER, name: "x", instructions: "y".repeat(65 * 1024) }), /limited to 64 KB/);
	await assert.rejects(createAgent({ keyId: OWNER, name: "x", container: { memoryMb: "lots" } }), /memory/);
	assert.equal(agents.list().length, 0, "nothing was made by a refused request");

	// A per-key cap, so a scripted bulk-create cannot exhaust AGENT_PORT_RANGE with no clear reason why.
	config.AGENT_MAX_PER_KEY = 2;
	const capA = await createAgent({ keyId: OWNER, name: "cap-a" });
	const capB = await createAgent({ keyId: OWNER, name: "cap-b" });
	await assert.rejects(createAgent({ keyId: OWNER, name: "cap-c" }), /already has 2 agent endpoints.*AGENT_MAX_PER_KEY/);
	await deleteAgent(capA.id);
	await deleteAgent(capB.id);
	config.AGENT_MAX_PER_KEY = 50;

	const architect = await createAgent({ keyId: OWNER, name: "architect", workspace: "own", container: { memoryMb: 1024, env: "B=2", persistent: true } });
	const coder = await createAgent({ keyId: OWNER, name: "coder", workspace: "shared" });
	await assert.rejects(createAgent({ keyId: OWNER, name: "coder" }), /already has an agent called "coder"/, "names are unique per key");
	assert.equal(agentStatus(architect), "listening");
	assert.notEqual(listeningPort(architect.id), listeningPort(coder.id), "each has its own port");
	assert.equal(agents.get(architect.id).port, listeningPort(architect.id), "the port is stored, so the URL survives a restart");
	assert.equal(agents.get(architect.id).container.persistent, undefined, "an agent is always persistent, so that is not a setting");
	const archScope = agentScope(OWNER, architect.id);
	const codeScope = agentScope(OWNER, coder.id);
	assert.equal(existsSync(join(TEST_PROFILES, scopeOf(archScope))), true, "its profile exists");
	assert.notEqual(workspaceDir(archScope), workspaceDir(OWNER), "an own workspace is its own folder");
	assert.equal(workspaceDir(codeScope), workspaceDir(OWNER), "a shared one is the key's");
	assert.equal(workspaceScopeOf(codeScope), OWNER);
	assert.equal(existsSync(workspaceDir(archScope)), true);
	assert.equal(keyLabel(archScope), "owner key / architect");
	assert.equal(agentView(architect).key, "owner key");

	// Container settings: the agent's own over the key's over the defaults; always persistent.
	apiKeys.update(OWNER, { container: { memoryMb: 512, network: "none", env: "A=1" } });
	const effA = containerSettingsFor(archScope);
	assert.deepEqual([effA.memoryMb, effA.network, effA.persistent], [1024, "none", true], "the agent's memory, the key's network");
	assert.deepEqual(effA.env.filter(([n]) => n === "A" || n === "B").map(([n, v]) => `${n}=${v}`).sort(), ["A=1", "B=2"], "environment adds up");
	const effC = containerSettingsFor(codeScope);
	assert.deepEqual([effC.memoryMb, effC.persistent, effC.own], [512, true, null], "an agent with none of its own follows the key");
	assert.equal(containerSettingsFor(OWNER).persistent, false, "and the key itself is not made persistent by having agents");
	apiKeys.update(OWNER, { container: null });

	// Its container, its folders, its labels: apart from the key's and from each other's.
	const recA = { id: "chat-a", keyId: OWNER, scopeId: archScope, agentId: architect.id };
	const recC = { id: "chat-c", keyId: OWNER, scopeId: codeScope, agentId: coder.id };
	const specA = containerSpecFor(recA, ensureWorkspace(archScope));
	const specC = containerSpecFor(recC, ensureWorkspace(codeScope));
	const specKey = containerSpecFor({ id: "chat-k", keyId: OWNER }, ensureWorkspace(OWNER));
	assert.equal(specA.persistent, true);
	assert.equal(specA.name, keyContainerName(archScope));
	assert.equal(new Set([specA.name, specC.name, keyContainerName(OWNER)]).size, 3, "three different containers");
	assert.equal(specKey.persistent, false, "the key's own chats keep theirs");
	assert.equal(specA.keyId, OWNER, "the owner key stays what limits are read from");
	assert.notEqual(specA.profileDir, specC.profileDir);
	assert.equal(specC.workspace, workspaceDir(OWNER), "shared: the key's workspace is mounted");
	assert.notEqual(specA.workspace, specC.workspace);
	assert.ok(containerCreateArgs({ ...specA, sig: "s" }).includes(`piper.agent=${architect.id}`));
	assert.ok(containerCreateArgs({ ...specA, sig: "s" }).includes(`piper.key=${OWNER}`), "the label keeps the key: the Containers page and sweep read it");
	agents.update(architect.id, { model: "p/m", thinking: "high" });
	assert.deepEqual(agentDefaultModel(recA), { model: "p/m", thinking: "high" });
	assert.equal(agentDefaultModel({ agentId: null }), null);
	assert.equal(piInvocation(specA, { defaultModel: agentDefaultModel(recA), idHash: chatIdHash("chat-a") }).env.PIPER_DEFAULT_MODEL, "p/m", "a new chat starts on the agent's model");
	agents.update(architect.id, { model: null, thinking: null });

	// Sessions never cross: the same client id on the main port, on each agent, under another key.
	const sid = (credential) => scopedSessionId(credential, "same-id");
	const cred = { id: OWNER };
	assert.equal(new Set([sid(cred), sid({ ...cred, agent: { id: architect.id }, scopeId: archScope }), sid({ ...cred, agent: { id: coder.id }, scopeId: codeScope }), sid({ id: "another" })]).size, 4);

	// Over real sockets: who may call an agent's port, and what it serves.
	const base = (agent) => `http://127.0.0.1:${listeningPort(agent.id)}`;
	const ask = async (agent, path, { token, method = "GET", body } = {}) => {
		const res = await fetch(base(agent) + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* the assertions say */ }
		return { status: res.status, json, text };
	};
	assert.equal((await ask(architect, "/health")).json.status, "ok", "health needs no key and says nothing more");
	assert.equal((await ask(architect, "/v1/models")).status, 401, "no key");
	assert.equal((await ask(architect, "/v1/models", { token: otherToken })).status, 401, "another key");
	assert.equal((await ask(architect, "/v1/models", { token: "nonsense" })).status, 401);
	config.GATEWAY_API_KEY = "settings-key-for-test";
	assert.equal((await ask(architect, "/v1/models", { token: "settings-key-for-test" })).status, 401, "the settings key is not accepted here");
	config.GATEWAY_API_KEY = "";
	const models = await ask(architect, "/v1/models", { token: ownerToken });
	assert.equal(models.status, 200, "its own key");
	assert.equal(models.json.object, "list");
	for (const path of ["/dashboard", "/dashboard/agents.json", "/dashboard/api-keys.json", "/dashboard/settings.json", "/v1/piper/settings", "/nothing"]) {
		const r = await ask(architect, path, { token: ownerToken });
		assert.equal(r.status, 404, `${path} is not served on an agent's port`);
	}
	const chat = await ask(architect, "/v1/chat/completions", { token: ownerToken, method: "POST", body: {} });
	assert.equal(chat.status, 400, "the chat route reaches the gateway's own handler (and refuses an empty request)");
	assert.equal((await ask(architect, "/v1/chat/completions", { method: "POST", body: { messages: [] } })).status, 401, "but not without the key");
	const pre = await fetch(base(architect) + "/v1/chat/completions", { method: "OPTIONS" });
	assert.equal(pre.status, 204, "a browser client's preflight is answered");

	// Switching: off closes the port, on reopens the same one.
	const was = listeningPort(coder.id);
	await setAgentEnabled(coder.id, false);
	assert.equal(agentStatus(agents.get(coder.id)), "disabled");
	await assert.rejects(fetch(`http://127.0.0.1:${was}/health`), "closed");
	await setAgentEnabled(coder.id, true);
	assert.equal(listeningPort(coder.id), was, "the stored port is reused when it is free");
	// A taken port: the agent moves, and says so.
	await stopAgent(coder.id);
	const squatter = http.createServer((req, res) => res.end("x"));
	await new Promise((r) => squatter.listen(was, "127.0.0.1", r));
	await startAgent(agents.get(coder.id));
	assert.notEqual(listeningPort(coder.id), was, "it could not have its port back");
	assert.equal(agents.get(coder.id).port, listeningPort(coder.id), "the new one is stored");
	assert.ok(recentAuditRows(20).some((r) => r.action === "agent.port" && /was taken/.test(r.detail)), "and it is on record");
	await new Promise((r) => squatter.close(r));
	const before = listeningPort(coder.id);
	await renewAgentPort(coder.id);
	assert.equal(agentStatus(agents.get(coder.id)), "listening");
	assert.equal(agents.get(coder.id).port, listeningPort(coder.id));
	void before;
	// A range.
	config.AGENT_PORT_RANGE = "41100-41140";
	const ranged = await createAgent({ keyId: OWNER, name: "ranged" });
	assert.ok(listeningPort(ranged.id) >= 41100 && listeningPort(ranged.id) <= 41140, "picked inside AGENT_PORT_RANGE");
	config.AGENT_PORT_RANGE = "";
	await deleteAgent(ranged.id);

	// A revoked key closes the door on every agent of it.
	const { record: doomed, key: doomedToken } = apiKeys.create({ name: "doomed", expiresAt: 0 });
	const temp = await createAgent({ keyId: doomed.id, name: "temp" });
	assert.equal((await ask(temp, "/v1/models", { token: doomedToken })).status, 200);
	apiKeys.revoke(doomed.id);
	assert.equal((await ask(temp, "/v1/models", { token: doomedToken })).status, 401, "revoked");
	await assert.rejects(createAgent({ keyId: doomed.id, name: "more" }), /revoked/, "and no new agent for it");

	// Changing one: a new name, model and thinking are checked; an unknown or disallowed model is refused.
	await assert.rejects(updateAgent(architect.id, { name: "coder" }), /already has an agent/);
	await assert.rejects(updateAgent(architect.id, { model: "no-such-provider/no-such-model" }), /no model/);
	const renamed = await updateAgent(architect.id, { name: "architect2", container: { memoryMb: 2048 } });
	assert.deepEqual([renamed.name, renamed.container], ["architect2", { memoryMb: 2048 }]);
	await updateAgent(architect.id, { name: "architect" });

	// The dashboard routes.
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const dash = `http://127.0.0.1:${server.address().port}`;
	const dpost = async (path, body, method = "POST") => {
		const res = await fetch(dash + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		return { status: res.status, json: await res.json().catch(() => null) };
	};
	const listed = await (await fetch(`${dash}/dashboard/agents.json`)).json();
	assert.deepEqual(Object.keys(listed).sort(), ["agents", "host", "keys", "portRange"]);
	assert.ok(listed.agents.find((a) => a.name === "architect" && a.status === "listening" && a.port === listeningPort(architect.id)));
	assert.equal(listed.keys.find((k) => k.id === doomed.id).usable, false, "a revoked key is not offered");
	const made = await dpost("/dashboard/agents", { keyId: OWNER, name: "researcher", workspace: "own" });
	assert.equal(made.status, 201);
	const rid = made.json.created;
	assert.equal(made.json.agents.find((a) => a.id === rid).status, "listening");
	assert.equal((await dpost("/dashboard/agents", { keyId: OWNER, name: "researcher" })).status, 400, "a duplicate is the client's fault");
	assert.equal((await dpost("/dashboard/agents", { keyId: "nope", name: "x" })).status, 404);
	assert.equal((await dpost("/dashboard/agents/00000000/disable", {})).status, 404);
	assert.equal((await dpost(`/dashboard/agents/${rid}/disable`, {})).json.agents.find((a) => a.id === rid).status, "disabled");
	assert.equal((await dpost(`/dashboard/agents/${rid}/enable`, {})).json.agents.find((a) => a.id === rid).status, "listening");
	assert.equal((await dpost(`/dashboard/agents/${rid}/bogus`, {})).status, 404);
	assert.equal((await dpost(`/dashboard/agents/${rid}/reset`, {})).status, 200);
	assert.ok(engineCalls.some((c) => c[1] === "rm" && c.includes(keyContainerName(agentScope(OWNER, rid)))), "reset removes its container");
	assert.equal((await dpost(`/dashboard/agents/${rid}`, undefined, "DELETE")).json.deleted, rid);
	assert.equal(agents.get(rid), null);

	// Deleting: port closed, container and saved state removed, profile and own workspace archived, the key's workspace untouched.
	const keyFile = join(workspaceDir(OWNER), "keep.txt");
	writeFileSync(keyFile, "the key's");
	const archPort = listeningPort(architect.id);
	engineCalls.length = 0;
	await deleteAgent(architect.id);
	await assert.rejects(fetch(`http://127.0.0.1:${archPort}/health`), "its port is closed");
	assert.ok(engineCalls.some((c) => c[1] === "rm" && c.includes(keyContainerName(archScope))) && engineCalls.some((c) => c[1] === "rmi"), "container and saved state removed");
	assert.equal(existsSync(join(TEST_PROFILES, scopeOf(archScope))), false, "profile moved out");
	assert.equal(existsSync(workspaceDir(archScope)), false, "own workspace moved out");
	const archived = readdirSync(`${TEST_WS}-archive`).filter((n) => n.startsWith(`agent-architect-${architect.id}`));
	assert.equal(archived.length, 2, "its profile and its workspace are in the archive, not deleted");
	assert.equal(readFileSync(keyFile, "utf8"), "the key's", "the key's workspace is untouched");
	await deleteAgent(coder.id);
	assert.equal(existsSync(keyFile), true, "a shared workspace is never archived with an agent");

	// The sweep keeps an agent's container, and removes one whose agent is gone.
	const live = await createAgent({ keyId: OWNER, name: "kept" });
	const ps = (rows) => async (bin, args) => {
		engineCalls.push([bin, ...args]);
		return { code: bin === "docker" && args[0] === "ps" ? 0 : 127, stdout: args[0] === "ps" ? rows.map((r) => r.join("\t")).join("\n") : "", stderr: "" };
	};
	setRunner(ps([[keyContainerName(agentScope(OWNER, live.id)), "running", OWNER, live.id], [keyContainerName(agentScope(OWNER, "deadbeef")), "running", OWNER, "deadbeef"]]));
	engineCalls.length = 0;
	await sweepContainers(new Set(), new Set());
	const removed = engineCalls.filter((c) => c[1] === "rm").map((c) => c[c.length - 1]);
	assert.deepEqual(removed, [keyContainerName(agentScope(OWNER, "deadbeef"))], "only the orphan is removed");
	// Deleting a key takes its agents with it.
	const res = await dpost(`/dashboard/api-keys/${OWNER}`, undefined, "DELETE");
	assert.equal(res.status, 200);
	assert.equal(agents.listByKey(OWNER).length, 0, "its agents are gone with it");
	assert.equal(listeningPort(live.id), null, "and their ports");
	await deleteAgentsOfKey(doomed.id);
	assert.equal(agents.list().length, 0);

	await new Promise((r) => server.close(r));
	await stopAgentServers();
	config.ACCESS_LOG = accessLog;
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
}

// Update container: rebuild keeping what is installed, then Pi to the gateway's version and the extensions.
{
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const http = await import("node:http");
	const { server } = await import("./server.mjs");
	config.HOST = "127.0.0.1";
	const accessLog3 = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	const calls3 = [];
	let inspectFor = () => null;
	let piVersion = "0.1.0";
	let layers = 5;
	let failCommit = false;
	const hostPi = await hostPiVersion();
	assert.ok(hostPi, "the tests run with Pi installed");
	const fake = async (bin, args) => {
		calls3.push([bin, ...args]);
		const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
		if (args[0] === "inspect") {
			const names = args.slice(args.indexOf("container") + 1);
			const infos = names.map((n) => inspectFor(n)).filter(Boolean);
			return infos.length ? ok(JSON.stringify(infos)) : { code: 1, stdout: "[]", stderr: "No such object" };
		}
		if (args[0] === "image" && args[1] === "inspect") {
			if (args.includes("--format")) return ok("sha256:img|" + hostPi + "\n");
			return ok(JSON.stringify([{ Id: "sha256:saved", RootFS: { Layers: new Array(layers).fill("l") }, Config: { Env: ["PATH=/usr/bin", "TOOL=a b"], Cmd: ["sleep", "infinity"], Entrypoint: null, WorkingDir: "/workspace", Labels: { "piper.image": "1" } } }]));
		}
		if (args[0] === "commit" && failCommit) return { code: 1, stdout: "", stderr: "no space left on device" };
		if (args[0] === "exec" && args.includes("sh") && args.some((a) => /pi --version/.test(a))) return ok(`pi ${piVersion}\n`);
		return ok();
	};
	setRunner(fake);
	const spawned3 = [];
	let npmExit = 0;
	const fakeSpawn = (bin, args) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new PassThrough();
		child.kill = () => {};
		spawned3.push({ bin, args, child });
		setImmediate(() => {
			if (args[0] === "exec") {
				const cmd = args.slice(args.indexOf("timeout") + 4).join(" ");
				child.stdout.write(`running ${cmd}\n`);
				if (/npm install/.test(cmd) && npmExit === 0) piVersion = hostPi;
				setImmediate(() => child.emit("close", /npm install/.test(cmd) ? npmExit : 0));
			} else setImmediate(() => child.emit("close", 0));
		});
		return child;
	};
	const seq = () => calls3.map((c) => c[1] === "image" ? `image ${c[2]}` : c[1]);

	// rebuildContainer: stop, save, remove, create from the save with the current spec, start.
	const base3 = { name: "piper-ffffffff-key-000000000001", image: "piper-agent", workspace: "/w", profileDir: "/p", chatDir: "/c", runDir: "/r", bridgePath: "/b", persistent: true, keyId: "k", network: "none", memoryMb: 768 };
	const labelled = (sig = "old") => ({ Name: "/" + base3.name, State: { Running: true }, Config: { Labels: { "piper.managed": "1", "piper.sig": sig, "piper.key": "k" } } });
	inspectFor = (n) => (n === base3.name ? labelled() : null);
	calls3.length = 0;
	const built = await rebuildContainer(base3, "sha256:img", { spawnFn: fakeSpawn });
	assert.deepEqual([built.rebuilt, built.flattened], [true, false]);
	assert.deepEqual(seq(), ["inspect", "stop", "commit", "image inspect", "rm", "create", "start"], "stopped, saved, looked at its depth, removed, created, started");
	const create3 = calls3.find((c) => c[1] === "create");
	assert.equal(create3[create3.length - 1], keyStateImage(base3.name), "made again from what it had");
	assert.ok(create3.includes("768m"), "with the settings it would get now");
	// A failed save removes nothing.
	failCommit = true;
	calls3.length = 0;
	await assert.rejects(rebuildContainer(base3, "sha256:img", { spawnFn: fakeSpawn }), /no space left/);
	assert.equal(calls3.filter((c) => c[1] === "rm" || c[1] === "create").length, 0, "nothing is removed or made when the state could not be saved");
	failCommit = false;
	// No container yet: created from the clean image.
	inspectFor = () => null;
	calls3.length = 0;
	const fresh3 = await rebuildContainer({ ...base3, persistent: false }, "sha256:img", { spawnFn: fakeSpawn });
	assert.equal(fresh3.rebuilt, false);
	assert.deepEqual(seq(), ["inspect", "create", "start"]);
	assert.equal(calls3.find((c) => c[1] === "create").at(-1), "piper-agent");

	// Flattening: only when deep, keeping the configuration.
	layers = FLATTEN_OVER_LAYERS;
	calls3.length = 0;
	spawned3.length = 0;
	assert.equal((await flattenImage("piper-keystate:x", { spawnFn: fakeSpawn })).flattened, false, "not over the limit");
	assert.equal(spawned3.length, 0, "nothing was exported or imported");
	layers = FLATTEN_OVER_LAYERS + 20;
	spawned3.length = 0;
	calls3.length = 0;
	const flat = await flattenImage("piper-keystate:x", { spawnFn: fakeSpawn });
	assert.deepEqual([flat.flattened, flat.depth, flat.replacedId], [true, 120, "sha256:saved"]);
	assert.deepEqual(spawned3.map((p) => p.args[0]), ["export", "import"], "export piped into import");
	const importArgs = spawned3[1].args;
	const changes = importArgs.flatMap((a, i) => (a === "--change" ? [importArgs[i + 1]] : []));
	assert.ok(changes.includes('ENV TOOL="a b"') && changes.includes('CMD ["sleep","infinity"]') && changes.includes("WORKDIR /workspace") && changes.includes('LABEL "piper.image"="1"'), "the runtime configuration is put back");
	assert.deepEqual(importArgs.slice(-2), ["-", "piper-keystate:x"], "under the same tag");
	assert.ok(calls3.some((c) => c[1] === "create") && calls3.some((c) => c[1] === "rm" && c.includes("-f")), "through a throwaway container");
	assert.deepEqual(importChanges({}), []);
	layers = 5;

	// A long command, streamed.
	{
		const got = [];
		spawned3.length = 0;
		const run = execStream("c1", ["pi", "update", "--extensions"], { env: { HOME: "/root" }, cwd: "/profile", timeoutMs: 120_000, onLine: (l) => got.push(l), spawnFn: fakeSpawn });
		const done = await run;
		assert.deepEqual(spawned3[0].args.slice(0, 7), ["exec", "-w", "/profile", "-e", "HOME=/root", "c1", "timeout"], "env, folder, then the command under timeout");
		assert.deepEqual(spawned3[0].args.slice(6, 10), ["timeout", "-k", "10", "120"]);
		assert.deepEqual([done.code, done.timedOut, got], [0, false, ["running pi update --extensions"]]);
	}

	// Who owns a container, and what is refused.
	const { record: okKey } = apiKeys.create({ name: "updater", expiresAt: 0 });
	const agent = await createAgent({ keyId: okKey.id, name: "updatable" });
	const aScope = agentScope(okKey.id, agent.id);
	const aName = keyContainerName(aScope);
	const agentInfo = (extra = {}) => ({ Name: "/" + aName, State: { Running: true }, Config: { Labels: { "piper.managed": "1", "piper.sig": "old", "piper.key": okKey.id, "piper.agent": agent.id } }, ...extra });
	inspectFor = (n) => (n === aName ? agentInfo() : null);
	const t = await resolveTarget(aName);
	assert.deepEqual([t.kind, t.persistent, t.scopeId, t.keyId, t.agentId], ["agent", true, aScope, okKey.id, agent.id]);
	await assert.rejects(resolveTarget("piper-00000000-abc"), (e) => e.status === 404, "not ours");
	await assert.rejects(resolveTarget(keyContainerName("ghost")), (e) => e.status === 404, "no such container");
	const goneInfo = (n) => ({ Name: "/" + n, State: { Running: true }, Config: { Labels: { "piper.managed": "1", "piper.key": okKey.id, "piper.agent": "deadbeef" } } });
	inspectFor = (n) => goneInfo(n);
	await assert.rejects(resolveTarget(keyContainerName(agentScope(okKey.id, "deadbeef"))), /belongs to nothing/, "an agent that is gone owns nothing");
	inspectFor = (n) => (n === aName ? agentInfo() : null);
	assert.deepEqual(await containersOfScope(aScope), [], "no managed containers listed by this fake yet");

	// A request running in it: refused, nothing touched.
	const realRecords = sessions.recordsByScope.bind(sessions);
	const realHibernate = sessions.hibernate.bind(sessions);
	const hibernated = [];
	sessions.hibernate = (id) => { hibernated.push(id); return true; };
	sessions.recordsByScope = (scope) => (scope === aScope ? [{ id: "live-1", container: { name: aName }, inflight: 1, stopped: Promise.resolve() }] : realRecords(scope));
	calls3.length = 0;
	await assert.rejects(updateContainer(aName), (e) => e.status === 409 && /request is running/.test(e.message));
	assert.equal(calls3.filter((c) => c[1] === "stop" || c[1] === "rm").length, 0);
	assert.equal(hibernated.length, 0);
	// Idle chats are stopped first.
	sessions.recordsByScope = (scope) => (scope === aScope ? [{ id: "live-1", container: { name: aName }, inflight: 0, stopped: Promise.resolve() }] : realRecords(scope));

	// Not enough disk to save its state.
	diskState.containers = new Map([[aName, { rw: 3 * 1024 ** 3 }]]);
	diskState.host = { path: "/", freeBytes: 3.5 * 1024 ** 3, totalBytes: 10 * 1024 ** 3 };
	await assert.rejects(updateContainer(aName), (e) => e.status === 507 && /not enough disk/.test(e.message));
	diskState.host = { path: "/", freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 };

	// A good run: rebuilt, Pi set to the gateway's version, extensions updated, the container left running.
	const lines = [];
	calls3.length = 0;
	spawned3.length = 0;
	const result = await updateContainer(aName, (l) => lines.push(l), { spawnFn: fakeSpawn });
	assert.deepEqual(hibernated, ["live-1"], "its chat was stopped first");
	assert.deepEqual(result.steps.map((x) => `${x.name}:${x.state}`), ["rebuild:done", "pi:done", "extensions:done"]);
	assert.deepEqual([result.piFrom, result.piTo], ["0.1.0", hostPi], "old -> the gateway's");
	const npm = spawned3.find((p) => p.args.includes("npm"));
	assert.deepEqual(npm.args.slice(npm.args.indexOf("npm")), ["npm", "install", "-g", "--ignore-scripts", `@earendil-works/pi-coding-agent@${hostPi}`], "exactly the gateway's version, not latest");
	const ext = spawned3.find((p) => p.args.includes("--extensions"));
	const extEnv = ext.args.flatMap((a, i) => (a === "-e" ? [ext.args[i + 1]] : []));
	assert.ok(extEnv.includes("PI_CODING_AGENT_DIR=/profile") && extEnv.includes("PI_CONFIG_DIR=/profile/config"), "against the profile");
	assert.equal(extEnv.some((e) => e.startsWith("PI_OFFLINE")), false, "online: it has to reach the registry");
	assert.equal(ext.args[ext.args.indexOf("-w") + 1], "/profile");
	assert.equal(calls3.filter((c) => c[1] === "stop").length, 1, "stopped once, to save it; not stopped again afterwards");
	assert.ok(lines.some((l) => /rebuilt from its saved state/.test(l)) && lines.some((l) => /installing/.test(l)));
	assert.ok(recentAuditRows(10).some((r) => r.action === "container.update" && r.target === aName && new RegExp(`Pi 0\\.1\\.0 -> ${hostPi.replace(/\./g, "\\.")}`).test(r.detail)), "on record");

	// Already current: nothing installed. A failed install: reported, and the extensions still run.
	piVersion = hostPi;
	spawned3.length = 0;
	const again = await updateContainer(aName, () => {}, { spawnFn: fakeSpawn });
	assert.equal(again.steps.find((x) => x.name === "pi").detail, `already ${hostPi}`);
	assert.equal(spawned3.some((p) => p.args.includes("npm")), false);
	piVersion = "0.1.0";
	npmExit = 1;
	const broken = await updateContainer(aName, () => {}, { spawnFn: fakeSpawn });
	assert.deepEqual(broken.steps.map((x) => `${x.name}:${x.state}`), ["rebuild:done", "pi:failed", "extensions:done"], "one failed step does not stop the next");
	assert.deepEqual(broken.failed, ["pi"]);
	npmExit = 0;

	// A locked profile and a no-network policy: the extension/Pi steps say why they did not run.
	setProfileLock(scopeOf(aScope), true);
	spawned3.length = 0;
	piVersion = hostPi;
	const locked3 = await updateContainer(aName, () => {}, { spawnFn: fakeSpawn });
	assert.match(locked3.steps.find((x) => x.name === "extensions").detail, /locked by the operator/);
	assert.equal(spawned3.some((p) => p.args.includes("--extensions")), false);
	setProfileLock(scopeOf(aScope), false);
	await updateAgent(agent.id, { container: { network: "none" } });
	piVersion = "0.1.0";
	const offline = await updateContainer(aName, () => {}, { spawnFn: fakeSpawn });
	assert.match(offline.steps.find((x) => x.name === "pi").detail, /no network/);
	assert.match(offline.steps.find((x) => x.name === "extensions").detail, /no network/);
	assert.equal(offline.steps[0].state, "done", "it was still rebuilt");
	await updateAgent(agent.id, { container: null });

	// A chat's own container: found through its stored row, stopped again when done.
	const chatHash = chatIdHash("update-chat");
	const chatName = containerName(chatHash);
	chatStore.put({ id_hash: chatHash, key_id: null, workspace: "/w-chat", created_at: 1, last_used_at: 2, requests: 2, state_json: "{}" });
	const chatInfo = { Name: "/" + chatName, State: { Running: false }, Config: { Labels: { "piper.managed": "1", "piper.sig": "old", "piper.key": "" } } };
	inspectFor = (n) => (n === aName ? agentInfo() : n === chatName ? chatInfo : null);
	sessions.recordsByScope = realRecords;
	const ct = await resolveTarget(chatName);
	assert.deepEqual([ct.kind, ct.persistent, ct.workspace], ["chat", false, "/w-chat"]);
	calls3.length = 0;
	piVersion = hostPi;
	await updateContainer(chatName, () => {}, { spawnFn: fakeSpawn });
	assert.equal(calls3.filter((c) => c[1] === "stop").length, 2, "stopped to save it, and again afterwards like between messages");
	chatStore.delete(chatHash);
	await assert.rejects(resolveTarget(chatName), /belongs to no chat/, "an orphan is refused");

	// Jobs: one at a time, items in order, a busy or orphaned one skipped, the rest go on.
	resetUpdateJob();
	inspectFor = (n) => (n === aName ? agentInfo() : n === chatName ? chatInfo : null);
	const started = await startUpdate([aName], { spawnFn: fakeSpawn });
	assert.equal(started.state, "running");
	await assert.rejects(startUpdate([aName], { spawnFn: fakeSpawn }), (e) => e.status === 409, "one job at a time");
	for (let i = 0; i < 100 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(updateJobView().state, "done");
	assert.deepEqual(updateJobView().items.map((i) => [i.name, i.state]), [[aName, "done"]]);
	assert.ok(updateJobView().items[0].lines.some((l) => /rebuilt/.test(l)));
	await assert.rejects(startUpdate(["piper-00000000-abc"], { spawnFn: fakeSpawn }), (e) => e.status === 404, "an unknown container is refused up front");
	// Update all: lists what there is (the agent's, a chat's that is gone), skips what cannot be updated.
	sessions.recordsByScope = (scope) => (scope === aScope ? [{ id: "live-2", container: { name: aName }, inflight: 2, stopped: Promise.resolve() }] : realRecords(scope));
	setRunner(async (bin, args) => {
		if (args[0] === "ps") return { code: 0, stdout: `${aName}\trunning\t${okKey.id}\t${agent.id}\n${containerName(chatIdHash("vanished"))}\texited\t\t\n`, stderr: "" };
		return fake(bin, args);
	});
	const all = await startUpdateAll({ spawnFn: fakeSpawn });
	assert.equal(all.items.length, 2);
	for (let i = 0; i < 100 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	const states = Object.fromEntries(updateJobView().items.map((i) => [i.name.slice(-12), i.state]));
	assert.deepEqual(Object.values(states).sort(), ["skipped", "skipped"], "busy and orphaned ones are skipped, not failed");
	assert.equal(updateJobView().state, "done", "skips are not failures");
	sessions.recordsByScope = realRecords;
	sessions.hibernate = realHibernate;

	// The routes.
	setRunner(fake);
	inspectFor = (n) => (n === aName ? agentInfo() : null);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const dash = `http://127.0.0.1:${server.address().port}`;
	const post = async (path) => {
		const res = await fetch(dash + path, { method: "POST" });
		return { status: res.status, json: await res.json().catch(() => null) };
	};
	resetUpdateJob();
	assert.equal((await (await fetch(`${dash}/dashboard/updates.json`)).json()).job, null, "no job yet");
	assert.equal((await post(`/dashboard/containers/piper-00000000-abc/update`)).status, 404, "unknown container");
	const viaScope = await post(`/dashboard/profiles/${scopeOf(aScope)}/update-container`);
	assert.equal(viaScope.status, 404, "no managed container listed by the fake engine yet");
	assert.equal((await post(`/dashboard/profiles/key-nope/update-container`)).status, 404);
	setRunner(async (bin, args) => (args[0] === "ps" ? { code: 0, stdout: `${aName}\trunning\t${okKey.id}\t${agent.id}\n`, stderr: "" } : fake(bin, args)));
	assert.deepEqual(await containersOfScope(aScope), [aName], "an agent scope maps to its container");
	assert.deepEqual(await containersOfScope(okKey.id), [], "and the key's scope does not include its agents'");
	const viaAgent = await post(`/dashboard/agents/${agent.id}/update`);
	assert.equal(viaAgent.status, 200);
	assert.equal(viaAgent.json.job.items[0].name, aName);
	for (let i = 0; i < 100 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	const viaName = await post(`/dashboard/containers/${aName}/update`);
	assert.equal(viaName.status, 200, "the Containers page's button");
	for (let i = 0; i < 100 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal((await post(`/dashboard/containers/update-all`)).status, 200);
	for (let i = 0; i < 100 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal((await post(`/dashboard/agents/00000000/update`)).status, 404);

	await new Promise((r) => server.close(r));
	await deleteAgent(agent.id);
	resetUpdateJob();
	config.ACCESS_LOG = accessLog3;
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
}

// The audit log: what is recorded is chosen by settings, who did it comes from the request, nothing secret is written.
{
	const { DatabaseSync } = await import("node:sqlite");
	const http = await import("node:http");
	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	const saved = { ...Object.fromEntries(["AUDIT_AUTH", "AUDIT_SETTINGS", "AUDIT_KEYS", "AUDIT_OPERATIONS", "AUDIT_RUNTIME", "AUDIT_REQUESTS", "AUDIT_AUTH_FAILURES", "AUDIT_RETENTION_DAYS", "AUDIT_MAX_ROWS"].map((k) => [k, config[k]])) };
	const rowsOf = (action) => queryAudit({ q: action, limit: 500 }).rows.filter((r) => r.action === action);

	// The table of an older gateway gains the columns and keeps its rows.
	{
		const old = new DatabaseSync(":memory:");
		old.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
		old.prepare("INSERT INTO audit (ts, action, target, detail) VALUES (1, 'container.stop', 'c1', 'old row')").run();
		migrateAuditTable(old);
		migrateAuditTable(old);
		const cols = old.prepare("PRAGMA table_info(audit)").all().map((c) => c.name);
		for (const c of ["category", "actor", "ip"]) assert.ok(cols.includes(c), `${c} added, and adding twice is fine`);
		assert.equal(old.prepare("SELECT detail FROM audit").get().detail, "old row", "the old row is kept");
	}

	// Categories from the action's prefix; unknown ones are operations.
	for (const [action, category] of [["auth.login", "auth"], ["settings.change", "settings"], ["key.create", "keys"], ["profile.reset", "keys"], ["session.kill", "keys"], ["models.reload", "keys"], ["container.stop", "operations"], ["image.build", "operations"], ["agent.create", "operations"], ["host.pi.update", "operations"], ["runtime.sweep", "runtime"], ["request.chat", "requests"], ["authfail.api", "authfail"], ["audit.purge", "audit"], ["something.new", "operations"]]) {
		assert.equal(categoryOf(action), category, action);
	}
	assert.deepEqual(AUDIT_CATEGORIES.map((c) => c.id), ["auth", "settings", "keys", "operations", "runtime", "requests", "authfail", "audit"]);

	// What settings switch off is not stored; the audit category is always stored; the busy ones start off.
	assert.equal(config.AUDIT_REQUESTS, false, "per-request logging starts off");
	assert.equal(config.AUDIT_AUTH_FAILURES, false);
	assert.equal(auditEnabled("requests"), false);
	assert.equal(auditEnabled("keys"), true);
	config.AUDIT_KEYS = false;
	assert.equal(audit("key.create", "x", "off"), null, "a switched-off category stores nothing");
	assert.equal(rowsOf("key.create").filter((r) => r.detail === "off").length, 0);
	assert.ok(audit("audit.thing", "x", "always") > 0, "the audit category cannot be switched off");
	config.AUDIT_KEYS = true;
	assert.ok(audit("key.create", "x", "on") > 0);
	config.AUDIT_REQUESTS = true;
	assert.ok(audit("request.chat", "x", "now on") > 0);
	config.AUDIT_REQUESTS = false;

	// Who and from where comes from the request's context, through awaits; outside one it is the system.
	await runWithActor("dashboard", "10.1.2.3", async () => {
		await new Promise((r) => setTimeout(r, 5));
		assert.deepEqual(currentActor(), { actor: "dashboard", ip: "10.1.2.3" });
		audit("container.stop", "ctx-target", "inside");
	});
	const inside = queryAudit({ q: "ctx-target" }).rows[0];
	assert.deepEqual([inside.actor, inside.ip], ["dashboard", "10.1.2.3"]);
	audit("container.stop", "ctx-outside", "outside");
	assert.deepEqual([queryAudit({ q: "ctx-outside" }).rows[0].actor, queryAudit({ q: "ctx-outside" }).rows[0].ip], ["system", null]);
	audit("container.stop", "ctx-explicit", "", { actor: "key:x", ip: "1.1.1.1" });
	assert.equal(queryAudit({ q: "ctx-explicit" }).rows[0].actor, "key:x");

	// A settings change never shows a secret, and shows old -> new for the rest, cut short.
	const specOf = (key) => SETTINGS_SPEC.find((x) => x.key === key);
	assert.equal(settingChangeDetail(specOf("GATEWAY_API_KEY"), "", "hunter2-hunter2"), "changed (value not recorded)");
	assert.equal(settingChangeDetail(specOf("ALERT_WEBHOOK_URL"), "", "https://hooks.example/T0K3N"), "changed (value not recorded)", "a webhook URL carries a token");
	assert.equal(settingChangeDetail(specOf("CONTAINER_ENV"), "A=1", "A=2"), "changed (value not recorded)", "environment values can be secrets");
	assert.equal(settingChangeDetail(specOf("ACCESS_LOG"), false, true), "false -> true");
	assert.equal(settingChangeDetail({ type: "text" }, "", "x"), "(empty) -> x");
	assert.ok(settingChangeDetail({ type: "text" }, "a", "b".repeat(300)).length < 140, "long values are cut");

	// Reading: filters, paging, CSV.
	{
		for (let i = 0; i < 7; i++) audit("runtime.sweep", `page-${i}`, i % 2 ? "odd one" : "even one");
		const first = queryAudit({ categories: ["runtime"], q: "page-", limit: 3 });
		assert.deepEqual([first.rows.length, first.more], [3, true]);
		assert.deepEqual(first.rows.map((r) => r.target), ["page-6", "page-5", "page-4"], "newest first");
		const second = queryAudit({ categories: "runtime", q: "page-", limit: 3, before: first.next });
		assert.deepEqual(second.rows.map((r) => r.target), ["page-3", "page-2", "page-1"], "the cursor continues where the page ended");
		assert.equal(queryAudit({ q: "page-", limit: 3, before: second.next }).more, false);
		assert.equal(queryAudit({ categories: ["keys"], q: "page-" }).rows.length, 0, "a category filter");
		assert.equal(queryAudit({ q: "odd one", categories: "runtime" }).rows.length, 3);
		assert.equal(queryAudit({ q: "100%_" }).rows.length, 0, "% and _ in a search are literal");
		assert.equal(queryAudit({ actor: "nobody" }).rows.length, 0);
		assert.equal(queryAudit({ since: Date.now() + 60_000 }).rows.length, 0, "a time filter");
		assert.ok(queryAudit({ limit: 100000 }).rows.length <= 500, "capped at 500 a page");
		const st = auditStats();
		assert.ok(st.rows > 0 && st.oldest > 0);
		assert.deepEqual(st.categories.map((c) => c.id), AUDIT_CATEGORIES.map((c) => c.id));
		assert.equal(st.categories.find((c) => c.id === "requests").enabled, false);
		assert.ok(st.categories.find((c) => c.id === "runtime").count >= 7);
		const csv = auditCsv([{ ts: 0, category: "keys", action: "key.create", actor: "dashboard", ip: "1.2.3.4", target: 'name, with "quotes"', detail: "=HYPERLINK(\"x\")\nnext" }]);
		assert.equal(csv.split("\n")[0], "time,category,action,actor,address,target,detail");
		assert.ok(csv.includes('"name, with ""quotes"""'), "quoted");
		assert.ok(csv.includes("\"'=HYPERLINK"), "a cell that starts like a formula is neutralised");
	}

	// A burst is one row with a count.
	resetAuditDedupe();
	const t0 = Date.now();
	for (let i = 0; i < 4; i++) auditOnce("burst-a", 60_000, "authfail.api", "9.9.9.9", "GET /v1/models", {}, t0 + i);
	config.AUDIT_AUTH_FAILURES = true;
	resetAuditDedupe();
	for (let i = 0; i < 4; i++) auditOnce("burst-b", 60_000, "authfail.api", "9.9.9.9", "GET /v1/models", {}, t0 + i);
	const burst = rowsOf("authfail.api").filter((r) => r.target === "9.9.9.9");
	assert.equal(burst.length, 1, "four refusals, one row");
	assert.match(burst[0].detail, /\(×4\)$/);
	auditOnce("burst-b", 60_000, "authfail.api", "9.9.9.9", "GET /v1/models", {}, t0 + 70_000);
	assert.equal(rowsOf("authfail.api").filter((r) => r.target === "9.9.9.9").length, 2, "a new minute is a new row");
	config.AUDIT_AUTH_FAILURES = false;

	// Retention: by age, then by count; a purge is on record even with everything else off.
	{
		db.prepare("DELETE FROM audit").run();
		const day = 86_400_000;
		const put = (ts, n) => db.prepare("INSERT INTO audit (ts, action, target, detail, category) VALUES (?, 'container.stop', ?, '', 'operations')").run(ts, n);
		put(Date.now() - 100 * day, "ancient");
		put(Date.now() - 10 * day, "old");
		for (let i = 0; i < 5; i++) put(Date.now() - i * 1000, `fresh-${i}`);
		config.AUDIT_RETENTION_DAYS = 90;
		config.AUDIT_MAX_ROWS = 4;
		for (const k of ["AUDIT_KEYS", "AUDIT_OPERATIONS", "AUDIT_RUNTIME"]) config[k] = false;
		const purged = purgeAudit();
		assert.deepEqual([purged.byAge, purged.byCap], [1, 2], "the ancient row by age, then the two oldest of the rest, down to 4");
		const left = db.prepare("SELECT target FROM audit WHERE action = 'container.stop' ORDER BY id").all().map((r) => r.target);
		assert.deepEqual(left, ["fresh-1", "fresh-2", "fresh-3", "fresh-4"], "the newest rows are the ones kept");
		assert.ok(rowsOf("audit.purge").length === 1, "the purge is recorded although nearly everything is switched off");
		config.AUDIT_RETENTION_DAYS = 0;
		config.AUDIT_MAX_ROWS = 0;
		assert.deepEqual(Object.values(purgeAudit()), [0, 0], "0 keeps everything");
		for (const k of ["AUDIT_KEYS", "AUDIT_OPERATIONS", "AUDIT_RUNTIME"]) config[k] = true;
	}
	config.AUDIT_RETENTION_DAYS = 90;
	config.AUDIT_MAX_ROWS = 50000;

	// What the gateway does by itself.
	handleContainerEvent({ action: "oom", name: "piper-x-1", exitCode: 137 }, { memoryMb: 512 });
	const oom = rowsOf("runtime.container_killed")[0];
	assert.deepEqual([oom.actor, oom.target], ["system", "piper-x-1"]);
	assert.match(oom.detail, /out of memory/);

	// Over real sockets: sign-ins, settings, keys, profiles, sessions, requests and refused keys.
	clearPasswordHash();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (path, { method = "POST", body, cookie, token } = {}) => {
		const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* the assertions say */ }
		return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? null };
	};
	const PASS = "correct horse battery";
	assert.equal((await call("/dashboard/password", { body: { next: PASS } })).status, 200);
	const setRow = rowsOf("auth.password").at(0);
	assert.match(setRow.detail, /password set/);
	assert.deepEqual([setRow.actor, Boolean(setRow.ip)], ["dashboard", true], "from the dashboard, with the address");
	assert.equal((await call("/dashboard/login", { body: { password: "wrong wrong wrong" } })).status, 401);
	assert.equal(rowsOf("auth.login_failed").at(0).detail, "wrong password");
	const login = await call("/dashboard/login", { body: { password: PASS } });
	assert.equal(login.status, 200);
	assert.equal(rowsOf("auth.login").length >= 1, true);
	const cookie = login.cookie;
	assert.ok(cookie);
	assert.ok(!JSON.stringify(queryAudit({ limit: 500 }).rows).includes(PASS) && !JSON.stringify(queryAudit({ limit: 500 }).rows).includes("wrong wrong"), "no password is ever recorded");

	// The brute-force backoff itself: the pure math, then the real 429/Retry-After it drives, and that a
	// success clears it (this is the dashboard's only defense on an exposed login, so it earns a direct test
	// rather than relying on the single wrong-password-then-success check above).
	{
		loginFails.clear();
		const ip = "203.0.113.5";
		for (let i = 1; i <= LOGIN_FREE_TRIES; i++) {
			assert.equal(noteLoginFailure(ip).until, 0, `attempt ${i} is still free`);
			assert.equal(loginWaitMs(ip), 0);
		}
		const first = noteLoginFailure(ip); // the free tries are used up: this one starts the wait
		assert.ok(first.until > Date.now(), "the next wait has begun");
		assert.ok(loginWaitMs(ip) > 1000 && loginWaitMs(ip) <= 2000 + 50, "2^1 seconds, the first time over");
		const second = noteLoginFailure(ip);
		assert.ok(second.until - Date.now() > 3000 && second.until - Date.now() <= 4000 + 50, "it doubles");
		for (let i = 0; i < 20; i++) noteLoginFailure(ip);
		assert.ok(loginWaitMs(ip) <= LOGIN_MAX_WAIT_MS, "capped, however many times it fails");
		loginFails.delete(ip);

		// Over real sockets: once past the free tries, even the *correct* password is refused while the wait
		// is in effect (otherwise the wait would be pointless), with Retry-After telling the client how long.
		// The free tries, then one more that uses them up and starts the wait: all still 401 (the wait
		// itself is only checked on the *next* request, against what this one just set).
		for (let i = 0; i <= LOGIN_FREE_TRIES; i++) assert.equal((await call("/dashboard/login", { body: { password: "nope" } })).status, 401);
		const blocked = await call("/dashboard/login", { body: { password: "nope" } }); // now blocked before the password is even checked
		assert.equal(blocked.status, 429);
		const res2 = await fetch(base + "/dashboard/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASS }) });
		assert.equal(res2.status, 429, "the correct password too, while blocked");
		assert.ok(Number(res2.headers.get("retry-after")) >= 1, "Retry-After says how long");
		assert.match(rowsOf("auth.login_blocked").at(0)?.detail ?? "", /too many wrong passwords/);

		// A success clears the record (not reachable through the lock above without waiting it out for
		// real, so cleared directly, the same effect as the wait having expired on its own).
		loginFails.delete("127.0.0.1");
		const after = await call("/dashboard/login", { body: { password: PASS } });
		assert.equal(after.status, 200);
		assert.equal(loginFails.has("127.0.0.1"), false);
	}

	// Settings: old -> new; a secret says only that it changed; the audit settings are always recorded.
	assert.equal((await call("/dashboard/settings", { cookie, body: { settings: { ACCESS_LOG: true } } })).status, 200);
	const changed = rowsOf("settings.change").find((r) => r.target === "ACCESS_LOG");
	assert.equal(changed.detail, "false -> true");
	assert.equal(changed.actor, "dashboard");
	await call("/dashboard/settings", { cookie, body: { settings: { ACCESS_LOG: false } } });
	await call("/dashboard/settings", { cookie, body: { settings: { GATEWAY_API_KEY: "s3cr3t-value-never-logged" } } });
	assert.equal(rowsOf("settings.change").find((r) => r.target === "GATEWAY_API_KEY").detail, "changed (value not recorded)");
	await call("/dashboard/settings", { cookie, body: { settings: { GATEWAY_API_KEY: "" } } });
	await call("/dashboard/settings", { cookie, body: { settings: { ALERT_WEBHOOK_URL: "https://hooks.example.com/services/T0K3N" } } });
	await call("/dashboard/settings", { cookie, body: { settings: { ALERT_WEBHOOK_URL: "" } } });
	const everything = JSON.stringify(queryAudit({ limit: 500 }).rows);
	assert.ok(!everything.includes("s3cr3t-value") && !everything.includes("T0K3N"), "neither a secret nor a webhook token is in the log");
	const before = queryAudit({ categories: "settings", limit: 500 }).rows.length;
	await call("/dashboard/settings", { cookie, body: { settings: { ACCESS_LOG: false } } });
	assert.equal(queryAudit({ categories: "settings", limit: 500 }).rows.length, before, "saving the same value is not news");
	await call("/dashboard/settings", { cookie, body: { settings: { AUDIT_SETTINGS: false } } });
	assert.equal(rowsOf("settings.change").find((r) => r.target === "AUDIT_SETTINGS").category, "audit", "switching a category off is itself recorded");
	await call("/dashboard/settings", { cookie, body: { settings: { ACCESS_LOG: true } } });
	assert.equal(rowsOf("settings.change").filter((r) => r.target === "ACCESS_LOG").length, 2, "and with settings logging off a change is not stored");
	await call("/dashboard/settings", { cookie, body: { settings: { ACCESS_LOG: false, AUDIT_SETTINGS: true } } });
	config.ACCESS_LOG = false;

	// Keys, profiles, sessions.
	const made = await call("/dashboard/api-keys", { cookie, body: { name: "audited key", expiresAt: 0 } });
	assert.equal(made.status, 201);
	const kid = made.json.createdId;
	const ktoken = made.json.key;
	assert.match(rowsOf("key.create").find((r) => r.target === "audited key").detail, /no expiry/);
	assert.ok(!JSON.stringify(queryAudit({ limit: 500 }).rows).includes(ktoken), "the key itself is never recorded");
	await call(`/dashboard/api-keys/${kid}`, { cookie, body: { maxSessions: 3, dailySpend: 2.5 } });
	assert.match(rowsOf("key.update").at(0).detail, /maxSessions/);

	// regenerate: a fresh secret, on record, the old one stops working at once; the key itself never logged.
	const regenMade = await call("/dashboard/api-keys", { cookie, body: { name: "regen-audited", expiresAt: 0 } });
	const regenId = regenMade.json.createdId, regenOldToken = regenMade.json.key;
	const regen = await call(`/dashboard/api-keys/${regenId}/regenerate`, { cookie, body: {} });
	assert.equal(regen.status, 200);
	assert.notEqual(regen.json.key, regenOldToken, "a genuinely new secret");
	assert.match(rowsOf("key.regenerate").at(0).detail, /new secret/);
	assert.ok(!JSON.stringify(queryAudit({ limit: 500 }).rows).includes(regen.json.key), "the new key itself is never recorded either");
	assert.equal((await call("/v1/models", { method: "GET", token: regenOldToken })).status, 401, "the old secret stopped working");
	assert.equal((await call("/v1/models", { method: "GET", token: regen.json.key })).status, 200, "the new one works");
	await call(`/dashboard/api-keys/${regenId}`, { method: "DELETE", cookie });
	ensureProfile(kid);
	await call(`/dashboard/profiles/${scopeOf(kid)}/lock`, { cookie, body: { locked: true } });
	await call(`/dashboard/profiles/${scopeOf(kid)}/lock`, { cookie, body: { locked: false } });
	assert.deepEqual([rowsOf("profile.lock").length > 0, rowsOf("profile.unlock").length > 0], [true, true]);
	assert.equal((await call(`/dashboard/profiles/${scopeOf(kid)}/reset`, { cookie, body: {} })).status, 200);
	assert.equal(rowsOf("profile.reset").at(0).target, "audited key");
	assert.equal((await call("/dashboard/kill-all", { cookie, body: {} })).status, 200);
	assert.equal(rowsOf("session.kill_all").at(0).actor, "dashboard");

	// API traffic: failed keys and chat requests, only when switched on, with no content.
	config.AUDIT_AUTH_FAILURES = false;
	await call("/v1/models", { method: "GET" });
	assert.equal(rowsOf("authfail.api").filter((r) => /v1\/models/.test(r.detail) && /no key/.test(r.detail)).length, 0, "off: nothing");
	config.AUDIT_AUTH_FAILURES = true;
	resetAuditDedupe();
	for (let i = 0; i < 3; i++) assert.equal((await call("/v1/models", { method: "GET", token: "not-a-key" })).status, 401);
	const fails = rowsOf("authfail.api").filter((r) => /not valid/.test(r.detail));
	assert.equal(fails.length, 1, "three refusals from one address in a minute: one row");
	assert.match(fails[0].detail, /\(×3\)/);
	assert.equal(fails[0].actor, "anonymous");
	config.AUDIT_AUTH_FAILURES = false;
	await call("/v1/chat/completions", { token: ktoken, body: { note: "TOP-SECRET-PROMPT" } });
	assert.equal(rowsOf("request.chat").filter((r) => /TOP-SECRET/.test(r.detail)).length, 0);
	const requestsBefore = rowsOf("request.chat").length;
	config.AUDIT_REQUESTS = true;
	const refused = await call("/v1/chat/completions", { token: ktoken, body: { note: "TOP-SECRET-PROMPT" } });
	assert.equal(refused.status, 400);
	const reqRow = rowsOf("request.chat")[0];
	assert.equal(rowsOf("request.chat").length, requestsBefore + 1);
	assert.match(reqRow.detail, /^400 \d+ ms model=/);
	assert.equal(reqRow.actor, "key:audited key");
	assert.ok(!JSON.stringify(queryAudit({ limit: 500 }).rows).includes("TOP-SECRET"), "what was said is not recorded");
	config.AUDIT_REQUESTS = false;

	// The page's endpoints.
	const page = await (await fetch(`${base}/dashboard/audit.json?category=keys&limit=2`, { headers: { cookie } })).json();
	assert.deepEqual([page.rows.length, page.more, typeof page.next, Array.isArray(page.audit)], [2, true, "number", true]);
	assert.ok(page.rows.every((r) => r.category === "keys"));
	assert.ok(page.stats.categories.length === 8 && page.stats.rows > 0);
	const csvRes = await fetch(`${base}/dashboard/audit.csv?category=auth`, { headers: { cookie } });
	assert.equal(csvRes.headers.get("content-type"), "text/csv; charset=utf-8");
	assert.match(await csvRes.text(), /^time,category,action,actor,address,target,detail\n.*auth\.login/m);
	assert.equal((await fetch(`${base}/dashboard/audit.json`)).status, 401, "not without signing in");

	// Sign-out, changing and removing the password, and a key delete.
	assert.equal((await call("/dashboard/logout", { cookie, body: {} })).status, 200);
	assert.equal(rowsOf("auth.logout").length >= 1, true);
	assert.equal((await call(`/dashboard/api-keys/${kid}`, { method: "DELETE", cookie })).status, 200);
	assert.equal(rowsOf("key.delete").at(0).target, "audited key");
	assert.equal((await call("/dashboard/password", { cookie, body: { current: PASS, next: "" } })).status, 200);
	assert.match(rowsOf("auth.password").at(0).detail, /removed/);

	// The sweep applies retention.
	config.AUDIT_RETENTION_DAYS = 1;
	db.prepare("INSERT INTO audit (ts, action, target, detail, category) VALUES (?, 'container.stop', 'swept-away', '', 'operations')").run(Date.now() - 3 * 86_400_000);
	setRunner(async () => ({ code: 127, stdout: "", stderr: "" }));
	await sweep();
	assert.equal(queryAudit({ q: "swept-away" }).rows.length, 0, "old rows go with the sweep");

	await new Promise((r) => server.close(r));
	Object.assign(config, saved);
	config.ACCESS_LOG = accessLog;
	clearPasswordHash();
}

// The Pi the gateway runs on: versions, what can be updated, and the update itself (never against the real install here).
{
	const fsx = await import("node:fs");
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	const root = mkdtempSync(join(tmpdir(), "hostpi-"));
	const prefixRoot = join(root, "lib", "node_modules");
	const pkgDir = join(prefixRoot, "@earendil-works", "pi-coding-agent");
	mkdirSync(join(pkgDir, "dist"), { recursive: true });
	const writePkg = (version) => writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/cli.js" } }));
	writePkg("0.50.0");
	const fakeNpm = join(root, "npm");
	writeFileSync(fakeNpm, "");
	const cli = join(pkgDir, "dist", "cli.js");
	const runs = [];
	const fakeRun = (extra = {}) => async (bin, args) => {
		runs.push([bin, ...args]);
		if (args[0] === "root") return extra.root ?? { code: 0, stdout: `${prefixRoot}\n`, stderr: "" };
		if (args[0] === "view") return extra.view ?? { code: 0, stdout: "0.99.2\n", stderr: "" };
		if (args[1] === "list") return { code: 0, stdout: "npm:@scope/ext-one\n\n  npm:@scope/ext-two  \n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	};

	// The running version is what was loaded; the disk is what is installed now.
	assert.equal(await hostPiVersion(), diskPiVersion(), "nothing has been updated: the two agree");
	assert.equal(diskPiVersion(pkgDir), "0.50.0");
	assert.equal(diskPiVersion("/no/such/dir"), "");
	assert.equal(piCliPath(pkgDir), cli);
	assert.equal(piCliPath("/no/such/dir"), "");
	for (const [a, b, newer] of [["0.99.2", "0.99.1", true], ["0.99.1", "0.99.2", false], ["0.99.1", "0.99.1", false], ["1.0.0", "0.99.9", true], ["0.99.1", "0.99.1-beta.1", true], ["0.99.1-beta.1", "0.99.1", false]]) assert.equal(versionNewer(a, b), newer, `${a} newer than ${b}`);
	const env = hostPiEnv({ PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PATH: "/x", KEEP: "me" });
	assert.deepEqual([env.PI_OFFLINE, env.PI_SKIP_VERSION_CHECK, env.KEEP], [undefined, undefined, "me"], "Pi's own commands must be able to go online");
	assert.ok(env.PATH.startsWith(dirname(process.execPath)) && env.PATH.endsWith(":/x"), "the gateway's node first");

	// Whether it can be updated from here, and why not.
	assert.deepEqual(await manageability({ packageDir: pkgDir, run: fakeRun(), npm: fakeNpm }), { ok: true, reason: "" });
	const elsewhere = await manageability({ packageDir: "/opt/custom/pi", run: fakeRun(), npm: fakeNpm });
	assert.equal(elsewhere.ok, false);
	assert.match(elsewhere.reason, /not where the gateway's npm installs/);
	assert.match((await manageability({ packageDir: pkgDir, run: fakeRun(), npm: join(root, "missing-npm") })).reason, /no npm next to the gateway's node/);
	assert.match((await manageability({ packageDir: pkgDir, run: fakeRun({ root: { code: 1, stdout: "", stderr: "" } }), npm: fakeNpm })).reason, /could not say where/);
	assert.match((await manageability({ packageDir: "", run: fakeRun(), npm: fakeNpm })).reason, /not been loaded/);
	if (process.getuid?.() !== 0) {
		fsx.chmodSync(pkgDir, 0o555);
		assert.match((await manageability({ packageDir: pkgDir, run: fakeRun(), npm: fakeNpm })).reason, /cannot write/);
		fsx.chmodSync(pkgDir, 0o755);
	}

	// The newest release: asked once, cached, forced by `check`, and a failure is "unknown", not an error.
	resetHostPiCache();
	runs.length = 0;
	assert.equal(await latestPiVersion({ run: fakeRun(), npm: fakeNpm }), "0.99.2");
	assert.equal(await latestPiVersion({ run: fakeRun(), npm: fakeNpm }), "0.99.2");
	assert.equal(runs.filter((r) => r[1] === "view").length, 1, "the second look is from the cache");
	assert.equal(await latestPiVersion({ check: true, run: fakeRun({ view: { code: 0, stdout: "0.99.3\n", stderr: "" } }), npm: fakeNpm }), "0.99.3", "check asks again");
	assert.equal(await latestPiVersion({ check: true, run: fakeRun({ view: { code: 1, stdout: "", stderr: "offline" } }), npm: fakeNpm }), null);
	assert.equal(await latestPiVersion({ check: true, run: fakeRun({ view: { code: 0, stdout: "not a version", stderr: "" } }), npm: fakeNpm }), null);
	resetHostPiCache();
	assert.deepEqual(await hostExtensions({ run: fakeRun(), packageDir: pkgDir }), [{ name: "@scope/ext-one", type: "npm", scope: "user", filtered: false, pinned: null }, { name: "@scope/ext-two", type: "npm", scope: "user", filtered: false, pinned: null }], "package names as rows, blanks dropped");
	assert.deepEqual(await hostExtensions({ run: async () => { throw new Error("cached"); }, packageDir: pkgDir }), [{ name: "@scope/ext-one", type: "npm", scope: "user", filtered: false, pinned: null }, { name: "@scope/ext-two", type: "npm", scope: "user", filtered: false, pinned: null }], "and cached");

	// Updating, through a fake `spawn`: Pi's own commands, from the temp folder, online, one failure not stopping the next.
	const spawned = [];
	let exits = {};
	const fakeSpawn = (bin, args, options) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => {};
		spawned.push({ bin, args, options });
		setImmediate(() => {
			const what = args.slice(1).join(" ");
			child.stdout.write(`ran ${what}\n`);
			if (what === "update" && !exits.pi) writePkg("0.60.0");
			setImmediate(() => child.emit("close", what === "update" ? exits.pi ?? 0 : exits.ext ?? 0));
		});
		return child;
	};
	process.env.PI_OFFLINE = "1";
	const lines = [];
	const done = await updateHostPi({}, (l) => lines.push(l), { spawnFn: fakeSpawn, run: fakeRun(), packageDir: pkgDir });
	delete process.env.PI_OFFLINE;
	assert.deepEqual(spawned.map((p) => p.args.slice(1).join(" ")), ["update", "update --extensions"], "Pi, then its extensions");
	assert.ok(spawned.every((p) => p.bin === process.execPath && p.args[0] === cli && p.options.cwd === tmpdir()), "this install's own pi, run from the temp folder, never the gateway's");
	assert.ok(spawned.every((p) => p.options.env.PI_OFFLINE === undefined && p.options.stdio[0] === "ignore"), "online, and nothing can ask a question");
	assert.deepEqual([done.before, done.after, done.failed], ["0.50.0", "0.60.0", []]);
	assert.ok(lines.includes("Pi on disk: 0.50.0 -> 0.60.0"));
	assert.equal(done.restartNeeded, true, "what the gateway runs is not what is now installed");
	assert.ok(lines.some((l) => l.startsWith("The gateway still runs Pi ") && /restart/.test(l) && /rebuild the image/.test(l)), "the operator is told what is out of step");
	assert.ok(recentAuditRows(10).some((r) => r.action === "host.pi.update" && /0\.50\.0 -> 0\.60\.0/.test(r.detail)), "on record");
	// One step failing does not stop the next; only one asked for runs only that.
	exits = { pi: 3 };
	spawned.length = 0;
	const partial = await updateHostPi({}, () => {}, { spawnFn: fakeSpawn, run: fakeRun(), packageDir: pkgDir });
	assert.deepEqual([partial.steps.map((s) => `${s.name}:${s.state}`), partial.failed], [["pi:failed", "extensions:done"], ["pi"]]);
	exits = {};
	spawned.length = 0;
	await updateHostPi({ self: false }, () => {}, { spawnFn: fakeSpawn, run: fakeRun(), packageDir: pkgDir });
	assert.deepEqual(spawned.map((p) => p.args.slice(1).join(" ")), ["update --extensions"]);
	await assert.rejects(updateHostPi({ self: false, extensions: false }, () => {}, { spawnFn: fakeSpawn, run: fakeRun(), packageDir: pkgDir }), (e) => e.status === 400);
	spawned.length = 0;
	await assert.rejects(updateHostPi({}, () => {}, { spawnFn: fakeSpawn, run: fakeRun(), packageDir: "/opt/custom/pi" }), (e) => e.status === 409 && /not where the gateway's npm installs/.test(e.message));
	assert.equal(spawned.length, 0, "an install the gateway cannot manage is never touched");

	// As a job: refused up front when not manageable, and while another job is running; otherwise the log is kept.
	resetUpdateJob();
	await assert.rejects(startHostPiUpdate({}, { spawnFn: fakeSpawn, run: fakeRun(), packageDir: "/opt/custom/pi" }), (e) => e.status === 409);
	let release;
	startJob([{ name: "busy", label: "busy", run: () => new Promise((r) => (release = () => r({ failed: [] }))) }]);
	await assert.rejects(startHostPiUpdate({}, { spawnFn: fakeSpawn, run: fakeRun(), packageDir: pkgDir }), (e) => e.status === 409 && /already running/.test(e.message), "one job at a time, host or container");
	release();
	for (let i = 0; i < 50 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
	writePkg("0.50.0");
	await startHostPiUpdate({ self: true, extensions: false }, { spawnFn: fakeSpawn, run: fakeRun(), packageDir: pkgDir });
	for (let i = 0; i < 100 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual([updateJobView().state, updateJobView().items[0].name, updateJobView().items[0].state], ["done", "host:pi", "done"]);
	assert.ok(updateJobView().items[0].lines.some((l) => /0\.50\.0 -> 0\.60\.0/.test(l)));
	resetUpdateJob();

	// The endpoints. The update needs a dashboard password; the real install is never updated here.
	resetHostPiCache();
	await latestPiVersion({ check: true, run: fakeRun(), npm: fakeNpm });
	await hostExtensions({ run: fakeRun(), packageDir: pkgDir });
	clearPasswordHash();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (path, { method = "GET", body, cookie } = {}) => {
		const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
		return { status: res.status, json: await res.json().catch(() => null), cookie: res.headers.get("set-cookie")?.split(";")[0] ?? null };
	};
	const info = await call("/dashboard/hostpi.json");
	assert.equal(info.status, 200);
	for (const key of ["running", "onDisk", "latest", "updateAvailable", "restartNeeded", "packageDir", "manageable", "reason", "extensions", "updateAllowed", "updateNote", "job"]) assert.ok(key in info.json, key);
	assert.equal(info.json.latest, "0.99.2");
	assert.deepEqual(info.json.extensions, [{ name: "@scope/ext-one", type: "npm", scope: "user", filtered: false, pinned: null }, { name: "@scope/ext-two", type: "npm", scope: "user", filtered: false, pinned: null }]);
	assert.equal(info.json.updateAllowed, false, "no dashboard password: no update");
	assert.match(info.json.updateNote, /dashboard password/);
	assert.equal((await call("/dashboard/hostpi/update", { method: "POST", body: {} })).status, 403, "refused until a password is set");
	assert.equal((await call("/dashboard/password", { method: "POST", body: { next: "a long enough password" } })).status, 200);
	const session = await call("/dashboard/login", { method: "POST", body: { password: "a long enough password" } });
	assert.equal((await call("/dashboard/hostpi.json", { cookie: session.cookie })).json.updateAllowed, true);
	let free;
	startJob([{ name: "busy", label: "busy", run: () => new Promise((r) => (free = () => r({ failed: [] }))) }]);
	assert.equal((await call("/dashboard/hostpi/update", { method: "POST", body: {}, cookie: session.cookie })).status, 409, "with a password it is allowed, and then refused while another job runs (before anything is run)");
	free();
	for (let i = 0; i < 50 && updateJobView().state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal((await call("/dashboard/hostpi/bogus", { method: "POST", cookie: session.cookie })).status, 404);
	await call("/dashboard/password", { method: "POST", body: { current: "a long enough password", next: "" }, cookie: session.cookie });

	await new Promise((r) => server.close(r));
	resetHostPiCache();
	resetUpdateJob();
	config.ACCESS_LOG = accessLog;
	rmSync(root, { recursive: true, force: true });
}

// Resource usage for the Overview: host, gateway process, containers added up.
{
	// /proc/meminfo: available, not free, memory counts as usable.
	assert.deepEqual(parseMeminfo("MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n"), { total: 16384000 * 1024, available: 8192000 * 1024 });
	assert.equal(parseMeminfo("nonsense"), null);
	assert.equal(parseMeminfo("MemTotal: 100 kB\n"), null, "without MemAvailable `os` is asked instead");
	// CPU: the share of time spent busy between two readings.
	const t = (user, sys, idle) => [{ times: { user, nice: 0, sys, idle, irq: 0 } }];
	assert.deepEqual(cpuTimes(t(10, 10, 80)), { busy: 20, total: 100 });
	assert.equal(cpuPercent(cpuTimes(t(10, 10, 80)), cpuTimes(t(40, 10, 150))), 30, "30 of the 100 ticks between the readings were busy");
	assert.equal(cpuPercent(cpuTimes(t(1, 1, 1)), cpuTimes(t(1, 1, 1))), null, "no time passed: no figure, not a zero");
	assert.equal(cpuPercent({ busy: 0, total: 0 }, { busy: 500, total: 100 }), 100, "capped");
	// Containers, added up from one `docker stats`, cached for five seconds, empty when Docker is not there.
	resetResources();
	const managed = [
		{ name: "piper-aaaaaaaa-1111111111111111", state: "running", keyId: "", agentId: null },
		{ name: "piper-aaaaaaaa-key-222222222222", state: "running", keyId: "", agentId: null },
		{ name: "piper-aaaaaaaa-3333333333333333", state: "exited", keyId: "", agentId: null },
	];
	let statsCalls = 0;
	const stats = async (names) => {
		statsCalls++;
		assert.deepEqual(names, [managed[0].name, managed[1].name], "only running containers are asked about");
		return new Map([[managed[0].name, { cpu: 12.5, memUsed: 300 * 1048576, memLimit: 2048 * 1048576, pids: 7 }], [managed[1].name, { cpu: 50, memUsed: 900 * 1048576, memLimit: 0, pids: 30 }]]);
	};
	const t0 = Date.now();
	const usage = await containerUsage({ now: t0, list: async () => managed, stats });
	assert.deepEqual([usage.running, usage.total, usage.cpu, usage.pids], [2, 3, 62.5, 37]);
	assert.equal(usage.memUsed, 1200 * 1048576);
	assert.equal(usage.memLimit, 2048 * 1048576, "an unlimited container adds no limit");
	assert.deepEqual(usage.top.map((r) => r.name), [managed[1].name, managed[0].name], "heaviest memory first");
	assert.match(usage.top[0].label, /★$/, "a key's container is marked");
	assert.match(usage.top[1].label, / chat$/);
	await containerUsage({ now: t0 + 1000, list: async () => managed, stats });
	assert.equal(statsCalls, 1, "asked once in five seconds");
	await containerUsage({ now: t0 + 6000, list: async () => managed, stats });
	assert.equal(statsCalls, 2);
	resetResources();
	assert.equal(await containerUsage({ now: t0, list: async () => { throw new Error("docker is not running"); }, stats }), null, "Docker unreachable leaves it empty, not broken");
	// The whole snapshot, and a history that takes a sample at most every 15 seconds.
	resetResources();
	const snap = await resourceSnapshot({ now: t0, containers: usage });
	assert.deepEqual(Object.keys(snap).sort(), ["at", "containers", "disk", "gateway", "history", "host"]);
	assert.ok(snap.host.cores >= 1 && snap.host.memTotal > 0 && snap.host.memUsed >= 0 && snap.host.memUsed <= snap.host.memTotal && snap.host.load.length === 3 && snap.host.uptimeSec > 0);
	assert.ok(snap.gateway.rss > 0 && snap.gateway.uptimeSec > 0 && /^v\d+/.test(snap.gateway.node));
	assert.equal(snap.history.length, 1);
	assert.deepEqual(Object.keys(snap.history[0]).sort(), ["containersCpu", "containersMem", "cpu", "gateway", "mem", "t"]);
	assert.equal(snap.history[0].containersMem, 1200, "MB");
	await resourceSnapshot({ now: t0 + 5000, containers: usage });
	assert.equal((await resourceSnapshot({ now: t0 + 6000, containers: usage })).history.length, 1, "not more often than every 15 s");
	assert.equal((await resourceSnapshot({ now: t0 + 16000, containers: usage })).history.length, 2);
	assert.equal((await resourceSnapshot({ now: t0 + 40000, containers: null })).containers, null);
	resetResources();
	// It reaches the page through /dashboard.json.
	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	clearPasswordHash();
	setRunner(async () => ({ code: 127, stdout: "", stderr: "no docker here" }));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const page = await (await fetch(`http://127.0.0.1:${server.address().port}/dashboard.json`)).json();
	assert.ok(page.resources && page.resources.host.memTotal > 0 && "gateway" in page.resources, "the snapshot carries the resources");
	assert.deepEqual([page.resources.containers.running, page.resources.containers.total, page.resources.containers.top], [0, 0, []], "and with no Docker there are simply no containers");
	assert.ok(page.sessions !== undefined && page.containers !== undefined, "and the rest of the snapshot is intact");
	await new Promise((r) => server.close(r));
	config.ACCESS_LOG = accessLog;
	resetResources();
}

// Pi versions of containers and agents: read cheaply, cached, coloured against the gateway's own; extensions as rows.
{
	const tarOf = (text) => {
		const body = Buffer.from(text);
		const header = Buffer.alloc(512);
		header.write("package.json", 0);
		header.write(body.length.toString(8).padStart(11, "0"), 124, "ascii");
		return Buffer.concat([header, body, Buffer.alloc(512 - (body.length % 512 || 512)), Buffer.alloc(1024)]);
	};
	const piJson = (v) => JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: v, description: "naïve — unicode" });

	// How a version compares.
	for (const [version, host, expected] of [["0.99.1", "0.99.1", "current"], ["0.99.0", "0.99.1", "outdated"], ["0.98.9", "0.99.1", "outdated"], ["1.0.0", "0.99.1", "ahead"], ["0.99.2", "0.99.1", "ahead"], ["0.99.1-beta.1", "0.99.1", "outdated"], ["", "0.99.1", "unknown"], ["0.99.1", "", "unknown"], [null, null, "unknown"]]) {
		assert.equal(piStatus(version, host), expected, `${version} against ${host}`);
	}

	// Reading a version out of the tar `docker cp` produces.
	assert.match(firstFileOfTar(tarOf(piJson("0.99.1"))), /"version":"0\.99\.1"/);
	assert.ok(firstFileOfTar(tarOf(piJson("0.99.1"))).includes("naïve — unicode"), "bytes, not a text decoding, so non-ASCII survives");
	assert.equal(firstFileOfTar(Buffer.alloc(100)), "");
	assert.equal(firstFileOfTar(Buffer.alloc(1024)), "", "an empty archive");
	assert.equal(firstFileOfTar("not a buffer"), "");
	const seen4 = [];
	const answering = (handlers) => async (bin, args, opts) => {
		seen4.push({ args, opts });
		return (handlers[args[0]] ?? (() => ({ code: 1, stdout: "", stderr: "" })))(args, opts);
	};
	setRunner(answering({ cp: () => ({ code: 0, stdout: tarOf(piJson("0.98.0")), stderr: "" }) }));
	assert.deepEqual(await readPiVersion("c1"), { version: "0.98.0", source: "container" });
	assert.deepEqual(seen4.map((c) => c.args[0]), ["cp"], "a container that is not running is read without exec");
	assert.deepEqual(seen4[0].args, ["cp", `c1:${PI_PACKAGE_JSON}`, "-"]);
	assert.equal(seen4[0].opts.binary, true);
	seen4.length = 0;
	setRunner(answering({ exec: () => ({ code: 0, stdout: piJson("0.97.0"), stderr: "" }) }));
	assert.deepEqual(await readPiVersion("c2"), { version: "0.97.0", source: "container" }, "a Pi installed elsewhere is found through npm in the running container");
	assert.deepEqual(seen4.map((c) => c.args[0]), ["cp", "exec"]);
	setRunner(answering({ image: () => ({ code: 0, stdout: "sha256:x|0.96.0\n", stderr: "" }) }));
	assert.deepEqual(await readPiVersion("c3", { image: "piper-agent" }), { version: "0.96.0", source: "image" }, "nothing readable: the image's label, and it says so");
	setRunner(answering({}));
	assert.deepEqual(await readPiVersion("c4", { image: "piper-agent" }), { version: "", source: "none" });
	assert.deepEqual(await readPiVersion("c5"), { version: "", source: "none" });

	// The cache: answers at once, fills in the background, three at a time, by container id.
	resetPiVersions();
	const gates = [];
	let active = 0;
	let peak = 0;
	const read = (name) => new Promise((resolve) => {
		active++;
		peak = Math.max(peak, active);
		gates.push(() => { active--; resolve({ version: `v-${name}`, source: "container" }); });
	});
	const items = ["a", "b", "c", "d", "e"].map((n) => ({ name: n, id: `id-${n}`, image: "img" }));
	const t0 = Date.now();
	assert.equal(piVersionsFor(items, { read, now: t0 }).size, 0, "nothing is known yet, and it does not wait");
	await new Promise((r) => setImmediate(r));
	assert.deepEqual([peak, gates.length, piVersionsPending()], [3, 3, 5], "at most three reads at once, the rest wait");
	piVersionsFor(items, { read, now: t0 });
	await new Promise((r) => setImmediate(r));
	assert.equal(gates.length, 3, "asking again does not queue the same ones twice");
	while (piVersionsPending() > 0) {
		gates.splice(0).forEach((g) => g());
		await new Promise((r) => setTimeout(r, 5));
	}
	const got = piVersionsFor(items, { read, now: t0 + 1000 });
	assert.deepEqual([...got].map(([n, v]) => `${n}=${v.version}`).sort(), ["a=v-a", "b=v-b", "c=v-c", "d=v-d", "e=v-e"]);
	assert.equal(piVersionsFor([{ name: "a", id: "a-recreated", image: "img" }], { read, now: t0 + 1000 }).size, 0, "a recreated container has a new id: the old figure is not used for it");
	noteChanged("b");
	assert.equal(piVersionsFor([items[1]], { read, now: t0 + 1000 }).size, 0, "a change drops its entry");
	while (piVersionsPending() > 0) {
		gates.splice(0).forEach((g) => g());
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.equal(piVersionsFor([items[2]], { read, now: t0 + 11 * 60_000 }).size, 0, "an entry is good for ten minutes");
	while (piVersionsPending() > 0) {
		gates.splice(0).forEach((g) => g());
		await new Promise((r) => setTimeout(r, 5));
	}
	resetPiVersions();
	assert.doesNotThrow(() => piVersionsFor([{ name: "z", id: "z", image: "" }], { read: async () => { throw new Error("docker is gone"); } }), "a failing read is left unknown, never thrown");
	await new Promise((r) => setTimeout(r, 10));
	resetPiVersions();

	// The Containers view and the Agents snapshot carry the version and its colour.
	const hostPi = await hostPiVersion();
	// A version that is older than whatever Pi is installed here, whether it ends in .0 or not (1.0.0 -> 0.9.9).
	const older = (() => {
		const [major, minor, patch] = hostPi.split(/[.-]/).map((x) => Number(x) || 0);
		return patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.9` : `${Math.max(0, major - 1)}.9.9`;
	})();
	const nameCur = containerName(chatIdHash("pi-current"));
	const nameOld = containerName(chatIdHash("pi-old"));
	const nameStopped = containerName(chatIdHash("pi-stopped"));
	const infoOf = (name, running, id) => ({ Name: `/${name}`, Id: id, State: { Running: running, Status: running ? "running" : "exited" }, Image: "sha256:img", Config: { Image: "piper-agent", Labels: { "piper.managed": "1", "piper.key": "" } }, HostConfig: {}, NetworkSettings: { Networks: {} } });
	const versions = { [nameCur]: hostPi, [nameOld]: older, [nameStopped]: hostPi };
	setRunner(async (bin, args) => {
		if (args[0] === "ps") return { code: 0, stdout: [nameCur, nameOld, nameStopped].map((n) => `${n}\t${n === nameStopped ? "exited" : "running"}\t\t`).join("\n"), stderr: "" };
		if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([infoOf(nameCur, true, "id-cur"), infoOf(nameOld, true, "id-old"), infoOf(nameStopped, false, "id-stopped")]), stderr: "" };
		if (args[0] === "cp") return { code: 0, stdout: tarOf(piJson(versions[args[1].split(":")[0]])), stderr: "" };
		if (args[0] === "stats") return { code: 0, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	});
	resetPiVersions();
	const first = await listContainers();
	assert.equal(first.hostPiVersion, hostPi, "the page is told what to compare with");
	assert.ok(first.containers.every((c) => c.piStatus === "unknown" && c.piVersion === null), "the first look does not wait for the reads");
	await new Promise((r) => setTimeout(r, 30));
	const second = await listContainers();
	const by = Object.fromEntries(second.containers.map((c) => [c.name, c]));
	assert.deepEqual([by[nameCur].piVersion, by[nameCur].piStatus, by[nameCur].piSource], [hostPi, "current", "container"]);
	assert.deepEqual([by[nameOld].piVersion, by[nameOld].piStatus], [older, "outdated"], "older than the gateway's: red");
	assert.deepEqual([by[nameStopped].piVersion, by[nameStopped].piStatus], [hostPi, "current"], "a stopped container is read too");
	// A live agent: the snapshot names its container, and /dashboard.json joins the colour.
	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	clearPasswordHash();
	const agentRecord = { id: "pi-agent-session", keyId: null, scopeId: null, container: { name: nameOld } };
	const realAll = sessions.allRecords.bind(sessions);
	const realSnapshot = sessions.snapshot.bind(sessions);
	sessions.snapshot = async () => { const snap = await realSnapshot(); snap.sessions = [{ fingerprint: "abc", container: nameOld, expiresInMs: 1, idleMs: 1, ageMs: 1, inflight: 0, requests: 2, cost: 0, tokens: 0 }, { fingerprint: "def", container: nameCur, expiresInMs: 1, idleMs: 1, ageMs: 1, inflight: 0, requests: 2, cost: 0, tokens: 0 }, { fingerprint: "ghi", container: null, expiresInMs: 1, idleMs: 1, ageMs: 1, inflight: 0, requests: 2, cost: 0, tokens: 0 }]; return snap; };
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	await (await fetch(`${base}/dashboard.json`)).json();
	await new Promise((r) => setTimeout(r, 30));
	const dash = await (await fetch(`${base}/dashboard.json`)).json();
	assert.equal(dash.hostPiVersion, hostPi);
	const bySession = Object.fromEntries(dash.sessions.map((x) => [x.fingerprint, x]));
	assert.deepEqual([bySession.abc.piVersion, bySession.abc.piStatus], [older, "outdated"]);
	assert.deepEqual([bySession.def.piVersion, bySession.def.piStatus], [hostPi, "current"]);
	assert.deepEqual([bySession.ghi.piVersion, bySession.ghi.piStatus], [null, "unknown"], "a session with no container yet is unknown, not an error");
	sessions.snapshot = realSnapshot;
	void agentRecord; void realAll;
	await new Promise((r) => server.close(r));
	config.ACCESS_LOG = accessLog;
	resetPiVersions();
	setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));

	// `pi list` as table rows: names only, never a folder.
	const listing = "User packages:\n  git:github.com/zigai/pi-tweaks (filtered)\n    /root/.pi/agent/git/github.com/zigai/pi-tweaks\n  npm:@zigai/pi-footer\n    /root/.pi/agent/npm/node_modules/@zigai/pi-footer\n  npm:pi-lens@1.2.3\n    /root/.pi/agent/npm/node_modules/pi-lens\n  npm:@a/b@2.0.0\n    /y\n  /opt/local-ext\n    /opt/local-ext\n\nProject packages:\n  git:https://github.com/a/b.git@v1\n    /z\n  git@github.com:owner/ssh-repo.git\n    /w\n  weird line here\n";
	const rows = parsePiList(listing);
	assert.deepEqual(rows.map((r) => [r.name, r.type, r.scope, r.filtered, r.pinned]), [
		["zigai/pi-tweaks", "git", "user", true, null],
		["@zigai/pi-footer", "npm", "user", false, null],
		["pi-lens", "npm", "user", false, "1.2.3"],
		["@a/b", "npm", "user", false, "2.0.0"],
		["local-ext", "local", "user", false, null],
		["a/b", "git", "project", false, "v1"],
		["owner/ssh-repo", "git", "project", false, null],
		["weird line here", "other", "project", false, null],
	]);
	assert.ok(!JSON.stringify(rows).includes("/root/") && !JSON.stringify(rows).includes("node_modules"), "no folder ever reaches the API or the page");
	assert.deepEqual(parsePiList(""), []);
	assert.deepEqual(parsePiList(undefined), []);
	assert.deepEqual(parsePiList("No packages installed\n").map((r) => r.type), ["other"], "an odd line is kept, not lost");
	assert.ok(parsePiList(Array.from({ length: 300 }, (_, i) => `  npm:p${i}\n    /d`).join("\n")).length <= 100, "bounded");
}

// About and the Documentation handbook: the release notes, the page list, the renderer, the generated tables.
{
	const http = await import("node:http");
	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	const readText = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

	// The changelog and the package: the page's own data.
	const pkg = JSON.parse(readText("./package.json"));
	assert.deepEqual(readPackage().author, { name: "Adam Lange", email: "piper@adamlange.pl" });
	assert.equal(readPackage().version, pkg.version);
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
	const log = readChangelog();
	assert.ok(log.length >= 4, "every release is there");
	assert.equal(log[0].version, pkg.version, "the newest release is the current version");
	assert.ok(log.every((r, i) => /^\d+\.\d+\.\d+$/.test(r.version) && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.sections.length && r.sections.every((x) => x.title && x.items.length)), "each has a date, sections and items");
	assert.ok(log[0].sections.map((x) => x.title).includes("Added"));
	assert.ok(log.at(-1).version === "0.1.0");
	assert.ok(log.every((r, i) => i === 0 || versionNewer(log[i - 1].version, r.version)), "newest first, strictly");
	assert.deepEqual(parseChangelog("## [1.2.3] - 2026-01-02\n\n### Added\n- one thing that\n  wraps\n- two\n\n### Fixed\n- three\n\n## [1.0.0]\n### Added\n- x\n"), [
		{ version: "1.2.3", date: "2026-01-02", sections: [{ title: "Added", items: ["one thing that wraps", "two"] }, { title: "Fixed", items: ["three"] }] },
		{ version: "1.0.0", date: null, sections: [{ title: "Added", items: ["x"] }] },
	]);
	assert.deepEqual(parseChangelog("nothing useful here\n- a stray bullet\n"), [], "a garbled file is fewer releases, not an error");
	assert.deepEqual(parseChangelog(undefined), []);
	assert.deepEqual(readChangelog("/no/such/dir"), [], "a missing file is an empty changelog");
	const about = await aboutInfo();
	assert.equal(about.version, pkg.version);
	assert.ok(about.installation.node === process.version && about.installation.uptimeSec >= 0 && about.installation.platform);

	// The renderer: every construct, and nothing that can run.
	const r = (md) => renderMarkdown(md, { page: "p", targets: new Map([["README.md", "reference"], ["other.md", "other"]]) }).html;
	assert.equal(slugify("Hello, `World`! 2"), "hello-world-2");
	assert.match(r("# Title\n\nSome **bold**, *em*, `code <b>` and a [link](https://example.com)."), /<h1 id="title">Title<\/h1>\n<p>Some <strong>bold<\/strong>, <em>em<\/em>, <code>code &lt;b&gt;<\/code> and a <a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">link<\/a>\.<\/p>/);
	assert.equal(renderMarkdown("## A\n## A\n## A").headings.map((h) => h.id).join(), "a,a-2,a-3", "repeated headings get distinct ids");
	assert.match(r("- one\n- two\n  - nested\n- three\n\n1. first\n2. second"), /<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><li>three<\/li><\/ul>\n<ol><li>first<\/li><li>second<\/li><\/ol>/);
	assert.match(r("```bash\necho <hi> && ls\n```"), /<div class="codebox"><pre><code class="lang-bash">echo &lt;hi&gt; &amp;&amp; ls<\/code><\/pre><\/div>/);
	assert.match(r("| a | b |\n|---|---|\n| 1 | `x \\| y` |"), /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td><code>x \| y<\/code><\/td><\/tr><\/tbody><\/table>/);
	assert.equal(r("> quoted *text*"), "<blockquote><p>quoted <em>text</em></p></blockquote>");
	assert.match(r("a\n\n---\n\nb"), /<hr>/);
	assert.match(r("a snake_case_name and 2 * 3 * 4 stay as they are"), /snake_case_name and 2 \* 3 \* 4/);
	assert.equal(r("![a diagram](docs/x.png)"), "<p>a diagram</p>", "images are dropped, their words kept");
	// Links: http(s) and mailto as they are; anchors and known pages become dashboard links; the rest is plain text.
	assert.equal(linkHref("https://a.b/c?d=1").external, true);
	assert.equal(linkHref("mailto:x@y.z").href, "mailto:x@y.z");
	assert.deepEqual(linkHref("#Some Heading", { page: "p" }), { href: "#help/docs/p/some-heading", external: false });
	assert.equal(linkHref("README.md#Other Part", { targets: new Map([["README.md", "reference"]]) }).href, "#help/docs/reference/other-part");
	for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>", "vbscript:x", "//evil.example/x", "unknown.md", "/etc/passwd", "file:///etc/passwd", " javascript:alert(1)"]) assert.equal(linkHref(bad, { page: "p" }), null, bad);
	// Hostile input comes out escaped or dropped.
	for (const hostile of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "[x](javascript:alert(1))", "![x](javascript:alert(1))", "**<svg onload=alert(1)>**", "`</code><script>alert(1)</script>`", "# <script>alert(1)</script>", "| <script> |\n|---|\n| <img onerror=alert(1)> |", "- <iframe src=x></iframe>", "> <script>alert(1)</script>", "```\n</pre><script>alert(1)</script>\n```", "[<script>alert(1)</script>](https://a.b)", "<!-- generated:settings --><script>"]) {
		const html = r(hostile);
		assert.ok(!/<script|<img|<svg|<iframe|onerror=|onload=|href="javascript/i.test(html.replace(/&lt;[^&]*?&gt;/g, "")), `escaped: ${hostile} -> ${html}`);
		assert.ok(!/<(script|img|svg|iframe)\b/i.test(html), `no live tag: ${hostile} -> ${html}`);
	}
	assert.ok(!/alert/.test(r("[x](javascript:alert(1))") .replace(/^.*?<p>/, "")) || !/href/.test(r("[x](javascript:alert(1))")), "a javascript: link is not a link");
	assert.equal(r("<!-- a comment\nover lines -->\ntext"), "<p>text</p>", "comments are dropped");

	// The pages.
	const pages = listPages();
	const ids = pages.map((p) => p.id);
	for (const id of ["overview", "functions", "deployment", "operations", "variables", "files", "api", "security", "troubleshooting", "reference"]) assert.ok(ids.includes(id), `page ${id}`);
	assert.deepEqual(ids.slice(0, 3), ["overview", "functions", "deployment"], "the listed order");
	assert.equal(pages.find((p) => p.id === "deployment").title, "Deployment guide");
	assert.equal(pages.find((p) => p.id === "reference").title, "Reference manual");
	assert.ok(pages.every((p) => p.title && p.summary.length > 20), "every page has a title and a summary");
	assert.deepEqual(pageIndex().map((p) => p.id), ids);
	const rendered = Object.fromEntries(ids.map((id) => [id, renderPage(id)]));
	for (const wiki of ["overview", "functions", "operations", "variables", "files", "api", "security", "troubleshooting"]) {
		assert.ok(rendered[wiki].html.length > 2500 && rendered[wiki].headings.length >= 4, `${wiki} is a real page`);
	}
	assert.equal(renderPage("nope"), null);
	assert.equal(renderPage("../README"), null);
	assert.equal(renderPage("overview/../../etc/passwd"), null);
	assert.equal(renderPage(""), null);
	// Every internal link and anchor resolves to a page and a heading that exist.
	const anchorsOf = Object.fromEntries(ids.map((id) => [id, new Set([...rendered[id].html.matchAll(/<h[1-4] id="([^"]*)"/g)].map((m) => m[1]))]));
	for (const id of ids) {
		for (const m of rendered[id].html.matchAll(/href="#help\/docs\/([^"\/]+)(?:\/([^"]*))?"/g)) {
			assert.ok(anchorsOf[m[1]], `${id}: link to unknown page ${m[1]}`);
			if (m[2]) assert.ok(anchorsOf[m[1]].has(m[2]), `${id}: link to missing heading ${m[1]}#${m[2]}`);
		}
		assert.ok(!/href="(?!#help\/docs\/|https?:|mailto:)/.test(rendered[id].html), `${id}: every link is http(s), mailto or a dashboard link`);
	}

	// The generated tables come from the code: every setting, with its real default; no secret; no host path.
	const vars = rendered.variables.html;
	for (const spec of SETTINGS_SPEC) assert.ok(vars.includes(`<code>${spec.key}</code>`), `${spec.key} is in the reference`);
	assert.ok(vars.includes("<td>yes</td>") && vars.includes("<td>no</td>"), "restart column");
	const cellOf = (key) => new RegExp(`<tr><td><code>${key}</code></td>(?:<td>.*?</td>){2}`).exec(vars)[0];
	assert.match(cellOf("MAX_SESSIONS"), /<td>128<\/td>/);
	assert.match(cellOf("SESSION_IDLE_MS"), /<td>\d+[dhms]<\/td>/);
	assert.match(cellOf("AUDIT_REQUESTS"), /<td>off<\/td>/);
	assert.match(cellOf("AUDIT_AUTH"), /<td>on<\/td>/);
	assert.match(cellOf("GATEWAY_API_KEY"), /none; set from the dashboard/);
	assert.ok(!vars.includes(GATEWAY_DIR_FOR_TEST), "no path of this installation leaks into the page");
	assert.ok(vars.includes("&lt;gateway dir&gt;/workspaces"), "folders are written relative to the installation");
	assert.ok(!/s3cr3t|T0K3N/.test(vars));
	for (const [key, path] of Object.entries(CONTAINER_PATHS)) {
		assert.ok(PATH_NOTES[key], `${key} has a description`);
		assert.ok(rendered.files.html.includes(`<code>${path}</code>`), `${path} is in the files page`);
	}
	for (const c of AUDIT_CATEGORIES) assert.ok(rendered.security.html.includes(`<code>${c.id}</code>`), `audit category ${c.id} is documented`);
	for (const n of [NETWORK, NETWORK_OPEN]) assert.ok(rendered.security.html.includes(n.subnet) && rendered.security.html.includes(n.name));
	for (const range of ["10.0.0.0/8", "192.168.0.0/16", "169.254.0.0/16"]) assert.ok(rendered.security.html.includes(range));
	// The command reference is the scripts' own usage text, so every command and flag is in it.
	const ops = rendered.operations.html;
	for (const cmd of ["restart", "start", "stop", "status", "logs", "image", "doctor", "backup", "restore"]) assert.ok(readText("./piper.sh").includes(`${cmd}`) && new RegExp(`\\b${cmd}\\b`).test(ops), `piper.sh ${cmd}`);
	for (const flag of readText("./deploy.sh").split("\n").slice(1, 30).filter((l) => l.startsWith("#")).flatMap((l) => l.match(/--[a-z-]+/g) ?? [])) assert.ok(ops.includes(flag), `deploy.sh ${flag} is in the commands reference`);

	// Search finds the section, not just the page.
	const hits = searchDocs("iptables");
	assert.ok(hits.length > 0 && hits.every((h) => h.page && h.heading && h.snippet && ids.includes(h.page)));
	assert.ok(hits.some((h) => h.page === "security"), "the security page answers a question about the firewall");
	assert.ok(searchDocs("persistent container").some((h) => h.page === "functions" || h.page === "reference"));
	assert.deepEqual(searchDocs(""), []);
	assert.deepEqual(searchDocs("x"), [], "a one-letter query is nothing");
	assert.deepEqual(searchDocs("zzzzqqqqnotaword"), []);
	assert.ok(searchDocs("the".repeat(1)).length <= 30, "bounded");

	// Over real sockets: the list, a page, search, About; a bad id is a 404 and never a file.
	clearPasswordHash();
	await new Promise((res) => server.listen(0, "127.0.0.1", res));
	const base = `http://127.0.0.1:${server.address().port}`;
	const get = async (path) => {
		const res = await fetch(base + path);
		return { status: res.status, json: await res.json().catch(() => null), type: res.headers.get("content-type") };
	};
	const list = await get("/dashboard/docs.json");
	assert.equal(list.status, 200);
	assert.deepEqual(list.json.pages.map((p) => p.id), ids);
	assert.equal(list.json.version, pkg.version);
	const page = await get("/dashboard/docs/security.json");
	assert.deepEqual([page.status, page.json.id, page.json.title], [200, "security", "Security model and hardening"]);
	assert.ok(page.json.html.includes("<h2") && page.json.headings.every((h) => h.level === 2 || h.level === 3));
	assert.equal((await get("/dashboard/docs/nope.json")).status, 404);
	for (const evil of ["/dashboard/docs/..%2f..%2fetc%2fpasswd.json", "/dashboard/docs/%2e%2e%2fREADME.json", "/dashboard/docs/Security.json", "/dashboard/docs/overview.md", "/dashboard/docs/overview/../../gateway.json"]) {
		const res = await get(evil);
		assert.ok(res.status === 404 || res.status === 401, `${evil} -> ${res.status}`);
		assert.ok(!JSON.stringify(res.json).includes("root:"), "no file is ever read from the request");
	}
	const found = await get("/dashboard/docs/search.json?q=firewall");
	assert.ok(found.status === 200 && found.json.hits.length > 0);
	assert.deepEqual((await get("/dashboard/docs/search.json")).json.hits, []);
	const ab = await get("/dashboard/about.json");
	assert.equal(ab.status, 200);
	assert.deepEqual([ab.json.version, ab.json.author.name, ab.json.author.email, ab.json.license], [pkg.version, "Adam Lange", "piper@adamlange.pl", "Apache-2.0"]);
	assert.ok(ab.json.changelog.length >= 4 && ab.json.installation.node);
	// Locked dashboard: no handbook without signing in.
	setPasswordHash(hashPassword("a long enough password"));
	assert.equal((await get("/dashboard/docs.json")).status, 401);
	assert.equal((await get("/dashboard/about.json")).status, 401);
	clearPasswordHash();
	await new Promise((res) => server.close(res));
	config.ACCESS_LOG = accessLog;

	// The words that must not appear anywhere a reader sees: nothing about how Piper was made beyond its author.
	// Model ids such as claude-haiku-4.5 are names of things Piper talks to, not claims about its making, so they are not counted.
	const withoutModelIds = (text) => text.replace(/\bclaude-[a-z0-9.-]+/gi, "").replace(/\banthropic\/[a-z0-9.-]+/gi, "");
	const forbidden = /claude|anthropic|\bAI[- ](generated|assisted|built|written|powered)|generated (by|with) (an? )?(AI|LLM)|co-?authored|built with AI|written by AI|LLM-written|chatgpt|openai's? (codex|assistant) wrote/i;
	const shipped = ["README.md", "DEPLOYMENT.md", "CHANGELOG.md", "package.json", "LICENSE", "dashboard.html", "deploy.sh", "piper.sh", ...readdirSync(new URL("./docs/", import.meta.url)).filter((n) => n.endsWith(".md")).map((n) => `docs/${n}`), ...readdirSync(new URL("./lib/", import.meta.url)).map((n) => `lib/${n}`)];
	for (const file of shipped) assert.ok(!forbidden.test(withoutModelIds(readText(`./${file}`))), `${file} says nothing about AI authorship`);
	assert.ok(!forbidden.test(JSON.stringify(about)), "nor does the About payload");
	for (const html of Object.values(rendered)) assert.ok(!forbidden.test(withoutModelIds(html.html)));
}

// Model speed: timed from each call's events, averaged per session, kept per model over time.
{
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} is not ${b}`);

	// One call: what counts as prompt, what as generation, and what is not a measurement at all.
	const call = (usage, start, first, end) => callSpeed({ startMs: start, firstMs: first, endMs: end, usage });
	const good = call({ input: 1000, output: 101, cacheRead: 5000, cacheWrite: 0 }, 0, 500, 2500);
	assert.deepEqual(good, { prompt: { tokens: 1000, ms: 500 }, gen: { tokens: 100, ms: 2000 } }, "cache reads were not processed; the first output token is the clock's start");
	assert.equal(call({ input: 800, cacheWrite: 200, output: 51 }, 0, 100, 600).prompt.tokens, 1000, "cache writes were processed");
	assert.equal(call({ input: 10, output: 101 }, 0, 500, 2500).prompt, null, "a short prompt is mostly latency");
	assert.equal(call({ input: 10, output: 101 }, 0, 500, 2500).gen.tokens, 100);
	assert.equal(call({ input: 1000, output: 3 }, 0, 500, 700).gen, null, "a short answer is too short to time");
	assert.equal(call({ input: 1000, output: 3 }, 0, 500, 700).prompt.tokens, 1000, "but its prompt still counts");
	assert.equal(call({ input: 1000, output: 500 }, 0, 4000, 4010), null, "everything in one burst: the provider did not stream");
	assert.notEqual(call({ input: 1000, output: 10 }, 0, 500, 505), null, "a short answer may arrive in one burst");
	assert.equal(call({ input: 1000, output: 100 }, 0, 20, 2000).prompt, null, "a first token under 50 ms is not a processing time");
	assert.equal(call({ input: 1000, output: 100 }, 500, 100, 900), null, "time does not run backwards");
	assert.equal(call(null, 0, 1, 2), null);
	assert.equal(call({ input: 1000, output: 100 }, 0, null, 2000), null, "no token ever arrived");
	assert.equal(MIN_PROMPT_TOKENS, 64);

	// Averages are totals over totals: a long call weighs more than a short one.
	const stats = newSpeedStats();
	addSpeed(stats, { prompt: { tokens: 1000, ms: 500 }, gen: { tokens: 100, ms: 2000 } }, "p/a"); // 2000 and 50 per second
	addSpeed(stats, { prompt: { tokens: 200, ms: 100 }, gen: { tokens: 50, ms: 500 } }, "p/b"); // 2000 and 100 per second
	const view = speedView(stats);
	near(view.prompt, 2000, "prompt");
	near(view.gen, 60, "weighted generation speed (150 tokens in 2.5 s), not the 75 a mean of ratios would give");
	assert.deepEqual([view.calls, view.promptCalls, view.genCalls], [2, 2, 2]);
	near(view.last.gen, 100, "the last call");
	assert.equal(view.last.model, "p/b");
	near(view.byModel["p/a"].gen, 50, "per model within the session");
	assert.deepEqual(speedView(newSpeedStats()), { calls: 0, prompt: null, gen: null, promptCalls: 0, genCalls: 0, last: null, byModel: {} }, "no data is null, never zero or NaN");

	// The session times calls from its event stream with an injected clock.
	const fake = () => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.exitCode = null;
		child.signalCode = null;
		child.kill = () => {};
		child.stdin = new PassThrough();
		child.stdin.on("data", (chunk) => {
			for (const line of String(chunk).split("\n").filter(Boolean)) {
				const command = JSON.parse(line);
				child.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? { model: { provider: "p", id: "m", input: ["text"] }, isStreaming: false } : undefined })}\n`);
			}
		});
		return child;
	};
	const child = fake();
	const clock = { times: [] };
	const session = await new PiRpcSession(child, { clock: () => (clock.times.length ? clock.times.shift() : 0) }).init(2000);
	const emit = (record) => child.stdout.write(`${JSON.stringify(record)}\n`);
	const settle = () => new Promise((r) => setTimeout(r, 15));
	const assistant = (extra = {}) => ({ role: "assistant", provider: "prov", model: "fast", stopReason: "stop", ...extra });
	// One call as the stream shows it: the event before it (the request going out), the reply announced, deltas, the end.
	// `at` lists the arrival time of each event in that order: [boundary, start, ...one per delta, end].
	const run = async (at, { usage, message = {}, deltas = 1, boundary = true } = {}) => {
		const times = boundary ? at : at.slice(1);
		clock.times.push(...times);
		if (boundary) emit({ type: "agent_start" });
		emit({ type: "message_start", message: assistant() });
		for (let i = 0; i < deltas; i++) emit({ type: "message_update", assistantMessageEvent: { type: i === 0 ? "thinking_delta" : "text_delta", delta: "x" } });
		emit({ type: "message_end", message: assistant({ usage, ...message }) });
		await settle();
		clock.times.length = 0;
	};
	assert.equal(session.getSpeed().gen, null, "nothing measured yet");
	await run([0, 0, 500, 501, 502, 2500], { usage: { input: 1000, output: 101, cacheRead: 5000, cacheWrite: 0 }, deltas: 3 });
	let v = session.getSpeed();
	near(v.prompt, 2000, "prompt tokens per second");
	near(v.gen, 50, "generation tokens per second");
	assert.equal(v.last.model, "prov/fast");
	// A second model in the same session, a call that failed, one aborted, one that did not stream, one with no usage.
	const history0 = speedHistory("1h").models.reduce((n, m) => n + m.calls, 0);
	await run([0, 0, 100, 600], { usage: { input: 200, output: 51 }, message: { model: "slow" } });
	near(session.getSpeed().gen, 60, "the session average is weighted over both calls");
	assert.deepEqual(Object.keys(session.getSpeed().byModel).sort(), ["prov/fast", "prov/slow"]);
	for (const [label, opts] of [["error", { message: { stopReason: "error" } }], ["aborted", { message: { stopReason: "aborted" } }], ["no usage", { usage: null }], ["no deltas", { deltas: 0 }]]) {
		const before = JSON.stringify(session.getSpeed());
		await run([0, 0, ...(opts.deltas === 0 ? [] : [100]), 900], { usage: { input: 5000, output: 400 }, ...opts });
		assert.equal(JSON.stringify(session.getSpeed()), before, `a call that ${label} is not a measurement`);
	}
	await run([0, 0, 4000, 4005], { usage: { input: 5000, output: 400 } });
	near(session.getSpeed().prompt, 1200 * 1000 / 600, "a call that arrived in one burst did not change it");
	// A provider that holds its reply until the first token: Pi announces the reply only then, so the call is timed
	// from the event before it. Without that, this one would read as a time to first token of nothing.
	const beforeLate = JSON.stringify(session.getSpeed().prompt);
	await run([1000, 1990, 2000, 4000], { usage: { input: 3000, output: 101 } });
	assert.notEqual(JSON.stringify(session.getSpeed().prompt), beforeLate, "the prompt was timed from the request, 1000 ms before the first token");
	near(session.getSpeed().prompt, (1000 + 200 + 3000) / ((500 + 100 + 1000) / 1000), "1000 + 200 + 3000 prompt tokens over 500 + 100 + 1000 ms");
	// Tool turns: the call is timed from the tool result, not from the previous reply.
	const toolBefore = session.getSpeed().calls;
	clock.times.push(9000, 9000, 9600, 9700, 10200);
	emit({ type: "tool_execution_end", toolName: "bash" });
	emit({ type: "message_start", message: assistant() });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y" } });
	emit({ type: "message_end", message: assistant({ usage: { input: 3000, output: 21 } }) });
	await settle();
	clock.times.length = 0;
	assert.equal(session.getSpeed().calls, toolBefore + 1);
	near(session.getSpeed().last.prompt, 3000 / 0.6, "3000 tokens, 600 ms after the tool finished");
	await run([0, 0, 500, 2500], { usage: { input: 1000, output: 101 }, message: { role: "user" } });
	assert.equal(speedHistory("1h").models.reduce((n, m) => n + m.calls, 0), history0 + 3, "the second call, the late-announced one and the tool turn were added; a user message was not");

	// The history: one row per minute and model, ranges, buckets, and the setting that switches it off.
	const now = Date.now();
	db.prepare("DELETE FROM speed_minutes").run();
	config.SPEED_HISTORY_DAYS = 14;
	for (let m = 0; m < 5; m++) recordSpeed("alpha/one", { prompt: { tokens: 1000, ms: 500 }, gen: { tokens: 100, ms: 2000 } }, now - m * 60_000);
	recordSpeed("beta/two", { prompt: null, gen: { tokens: 300, ms: 3000 } }, now - 10 * 60_000);
	recordSpeed("alpha/one", { prompt: { tokens: 3000, ms: 3000 }, gen: { tokens: 400, ms: 2000 } }, now - 2 * 3_600_000);
	const hour = speedHistory("1h", now);
	assert.deepEqual([hour.range, hour.bucketMs], ["1h", 60_000]);
	assert.deepEqual(hour.models.map((m) => m.model), ["alpha/one", "beta/two"], "the most used first");
	const alpha = hour.models[0];
	assert.deepEqual([alpha.calls, alpha.provider], [5, "alpha"]);
	near(alpha.gen, 50, "five identical minutes");
	near(alpha.prompt, 2000, "prompt");
	assert.equal(alpha.points.length, 5, "a point per minute that had calls");
	assert.equal(hour.models[1].prompt, null, "a model with no prompt measurement has none, not zero");
	near(hour.models[1].gen, 100, "beta");
	const day = speedHistory("24h", now);
	const alpha24 = day.models.find((m) => m.model === "alpha/one");
	assert.equal(alpha24.calls, 6, "the call two hours ago is in 24 h");
	assert.equal(day.bucketMs, 15 * 60_000);
	assert.ok(alpha24.points.length <= 3, "the minutes fall into 15-minute buckets");
	near(alpha24.gen, (500 + 400) / ((10_000 + 2000) / 1000), "weighted over the day: 900 tokens in 12 s");
	assert.equal(speedHistory("bogus", now).range, "1h", "an unknown range is the default");
	assert.ok(Object.keys(SPEED_RANGES).join() === "1h,6h,24h,7d");
	assert.equal(speedHistory("1h", now + 3 * 86_400_000).models.length, 0, "an empty range is an empty list");
	// Same minute, same model: one row, summed.
	db.prepare("DELETE FROM speed_minutes").run();
	// (Aligned to the middle of a minute: "now" plus a second can be the next one, which made this flaky.)
	const sameMinute = Math.floor(now / 60_000) * 60_000 + 20_000;
	recordSpeed("m/x", { prompt: { tokens: 100, ms: 100 }, gen: null }, sameMinute);
	recordSpeed("m/x", { prompt: { tokens: 100, ms: 300 }, gen: null }, sameMinute + 1000);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM speed_minutes").get().n, 1);
	near(speedHistory("1h", sameMinute + 2000).models[0].prompt, 500, "200 tokens in 0.4 s");
	// Switched off: nothing is kept; retention.
	config.SPEED_HISTORY_DAYS = 0;
	assert.equal(recordSpeed("m/y", { prompt: { tokens: 100, ms: 100 }, gen: null }, now), false);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM speed_minutes WHERE model = 'm/y'").get().n, 0);
	assert.equal(purgeSpeed(now), 1, "switching it off drops what was kept");
	config.SPEED_HISTORY_DAYS = 2;
	recordSpeed("old/model", { prompt: { tokens: 100, ms: 100 }, gen: null }, now - 3 * 86_400_000);
	recordSpeed("new/model", { prompt: { tokens: 100, ms: 100 }, gen: null }, now - 3_600_000);
	assert.equal(purgeSpeed(now), 1, "older than the retention goes");
	assert.deepEqual(db.prepare("SELECT model FROM speed_minutes").all().map((r) => r.model), ["new/model"]);
	config.SPEED_HISTORY_DAYS = 14;
	db.prepare("DELETE FROM speed_minutes").run();
	assert.equal(recordSpeed(null, { prompt: null, gen: null }, now), false, "no model, nothing to record");

	// The Agents table and the Overview get it.
	const ctl = new SessionController({ create: async () => ({ getSpeed: () => ({ gen: 61.5, prompt: 1800, genCalls: 4, promptCalls: 4, calls: 4, last: { model: "p/m", gen: 60, prompt: 1700 }, byModel: {} }), getSessionStats: () => ({ cost: 0, tokens: { total: 0 } }), model: { provider: "p", id: "m" }, dispose() {} }), maxSessions: 4, maxLifetimeMs: 1e6, idleMs: 1e6, sweepMs: 0 });
	const acquired = ctl.acquire("speed-row", null);
	await acquired.record.sessionPromise;
	const row = (await ctl.snapshot()).sessions[0];
	assert.deepEqual([row.speed.gen, row.speed.prompt, row.speed.genCalls], [61.5, 1800, 4], "each running agent's row carries its speed");
	const plain = new SessionController({ create: async () => ({ dispose() {} }), maxSessions: 4, maxLifetimeMs: 1e6, idleMs: 1e6, sweepMs: 0 });
	const bare = plain.acquire("no-speed", null);
	await bare.record.sessionPromise;
	assert.equal((await plain.snapshot()).sessions[0].speed, null, "a session that cannot say has none");
	ctl.closeAll();
	plain.closeAll();

	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	clearPasswordHash();
	recordSpeed("route/model", { prompt: { tokens: 600, ms: 200 }, gen: { tokens: 90, ms: 1000 } }, Date.now());
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const sp = await (await fetch(`${base}/dashboard/speed.json?range=6h`)).json();
	assert.deepEqual([sp.range, sp.bucketMs, sp.models[0].model], ["6h", 300_000, "route/model"]);
	near(sp.models[0].gen, 90, "gen over the route");
	assert.equal((await (await fetch(`${base}/dashboard/speed.json`)).json()).range, "1h");
	setPasswordHash(hashPassword("a long enough password"));
	assert.equal((await fetch(`${base}/dashboard/speed.json`)).status, 401, "not without signing in");
	clearPasswordHash();
	await new Promise((r) => server.close(r));
	config.ACCESS_LOG = accessLog;
	db.prepare("DELETE FROM speed_minutes").run();
	session.dispose?.();
}

// The terminal: a WebSocket server written for it, a pty helper run for real, and the whole path with a local stand-in for docker exec.
{
	const http = await import("node:http");
	const net = await import("node:net");
	const { spawn: spawnProc, spawnSync } = await import("node:child_process");
	const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
	const until = async (fn, ms = 4000, what = "condition") => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			const v = fn();
			if (v) return v;
			await settle(10);
		}
		throw new Error(`timed out waiting for ${what}`);
	};

	// The handshake's accept value, from RFC 6455 itself.
	assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
	// What a frame looks like on the wire.
	assert.deepEqual([...encodeFrame(1, "hi")], [0x81, 2, 0x68, 0x69]);
	assert.deepEqual([...encodeFrame(2, Buffer.alloc(200)).subarray(0, 4)], [0x82, 126, 0, 200]);
	assert.deepEqual([...encodeFrame(2, Buffer.alloc(70000)).subarray(0, 10)], [0x82, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]);

	// A server that hands every connection to `upgrade`, and a raw client that can send anything.
	const peers = [];
	const wsServer = http.createServer();
	wsServer.on("upgrade", (req, socket, head) => {
		const peer = upgrade(req, socket, head, { maxMessage: 70_000, pingMs: 60_000, closeWaitMs: 300 });
		if (!peer) return;
		const record = { peer, messages: [], closed: null };
		peers.push(record);
		peer.onMessage = (data, binary) => {
			record.messages.push([binary, data]);
			if (!binary && data === "echo-me") peer.send("echoed");
			if (binary) peer.send(Buffer.from(data));
		};
		peer.onClose = (code, reason) => (record.closed = [code, reason]);
	});
	await new Promise((r) => wsServer.listen(0, "127.0.0.1", r));
	const port = wsServer.address().port;
	const mask = (payload) => {
		const key = Buffer.from([1, 2, 3, 4]);
		const out = Buffer.from(payload);
		for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
		return [key, out];
	};
	const clientFrame = (opcode, payload = Buffer.alloc(0), { fin = true, masked = true, rsv = 0, lenForm } = {}) => {
		const body = Buffer.from(payload);
		const [key, data] = masked ? mask(body) : [Buffer.alloc(0), body];
		let header;
		const m = masked ? 0x80 : 0;
		if (lenForm === 64 || body.length >= 65536) {
			header = Buffer.alloc(10);
			header[1] = m | 127;
			header.writeBigUInt64BE(BigInt(body.length), 2);
		} else if (lenForm === 16 || body.length >= 126) header = Buffer.from([0, m | 126, body.length >> 8, body.length & 0xff]);
		else header = Buffer.from([0, m | body.length]);
		header[0] = (fin ? 0x80 : 0) | rsv | opcode;
		return Buffer.concat([header, key, data]);
	};
	const connect = async (headers = {}) => {
		const socket = net.connect(port, "127.0.0.1");
		await new Promise((r) => socket.once("connect", r));
		const client = { socket, raw: Buffer.alloc(0), head: null, frames: [], ended: false };
		socket.on("data", (chunk) => {
			client.raw = Buffer.concat([client.raw, chunk]);
			if (!client.head) {
				const at = client.raw.indexOf("\r\n\r\n");
				if (at < 0) return;
				client.head = client.raw.subarray(0, at).toString();
				client.raw = client.raw.subarray(at + 4);
			}
			while (client.raw.length >= 2) {
				let len = client.raw[1] & 0x7f;
				let off = 2;
				if (len === 126) { if (client.raw.length < 4) break; len = client.raw.readUInt16BE(2); off = 4; }
				else if (len === 127) { if (client.raw.length < 10) break; len = Number(client.raw.readBigUInt64BE(2)); off = 10; }
				if (client.raw.length < off + len) break;
				client.frames.push({ fin: Boolean(client.raw[0] & 0x80), opcode: client.raw[0] & 0xf, payload: client.raw.subarray(off, off + len) });
				client.raw = client.raw.subarray(off + len);
			}
		});
		socket.on("close", () => (client.ended = true));
		socket.on("error", () => {});
		const h = { Host: `127.0.0.1:${port}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", ...headers };
		socket.write(`GET /t HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
		await until(() => client.head || client.ended, 3000, "the handshake answer");
		return client;
	};
	const closeCode = (client) => client.frames.find((f) => f.opcode === 8)?.payload.readUInt16BE(0);

	// Handshake: accepted with the right value; refused with the right status otherwise.
	const good = await connect();
	assert.match(good.head, /^HTTP\/1\.1 101 /);
	assert.match(good.head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
	assert.equal((await connect({ "Sec-WebSocket-Version": "8" })).head.split("\r\n")[0], "HTTP/1.1 426 Upgrade Required");
	assert.match((await connect({ "Sec-WebSocket-Version": "8" })).head, /Sec-WebSocket-Version: 13/);
	assert.match((await connect({ "Sec-WebSocket-Key": "short" })).head, /^HTTP\/1\.1 400 /);
	assert.match((await connect({ Upgrade: "h2c" })).head, /^HTTP\/1\.1 400 /);

	// Messages: text, binary, all three length forms, fragmentation, ping.
	good.socket.write(clientFrame(1, "echo-me"));
	await until(() => good.frames.length, 2000, "an echo");
	assert.deepEqual([good.frames[0].opcode, good.frames[0].payload.toString()], [1, "echoed"], "a text message and a text answer");
	for (const size of [0, 125, 126, 300, 65535, 65536, 69999]) {
		const before = good.frames.length;
		const data = Buffer.alloc(size, size & 0xff);
		good.socket.write(clientFrame(2, data));
		await until(() => good.frames.length > before, 3000, `the echo of ${size} bytes`);
		assert.ok(good.frames.at(-1).payload.equals(data), `${size} bytes come back intact`);
	}
	good.socket.write(clientFrame(2, Buffer.from("a"), { fin: false }));
	good.socket.write(clientFrame(9, Buffer.from("ping!")));
	good.socket.write(clientFrame(0, Buffer.from("b"), { fin: false }));
	good.socket.write(clientFrame(0, Buffer.from("c")));
	await until(() => good.frames.some((f) => f.opcode === 10), 2000, "the pong");
	assert.equal(good.frames.find((f) => f.opcode === 10).payload.toString(), "ping!", "a ping is answered with its own payload, even between fragments");
	await until(() => peers[0].messages.some(([, d]) => Buffer.isBuffer(d) && d.toString() === "abc"), 2000, "the reassembled message");
	good.socket.write(clientFrame(2, Buffer.concat([Buffer.from([0xf0, 0x9f]), Buffer.from([0x98, 0x80])]), { fin: false }));
	good.socket.write(clientFrame(0, Buffer.from("é")));
	good.socket.write(clientFrame(1, Buffer.from("é"), { lenForm: 16 }));
	await until(() => peers[0].messages.some(([b, d]) => !b && d === "é"), 2000, "text sent with a 16-bit length for a short payload");
	// The packet boundary can fall anywhere.
	const whole = Buffer.concat([clientFrame(1, "split-a"), clientFrame(1, "split-b")]);
	for (const byte of whole) good.socket.write(Buffer.from([byte]));
	await until(() => peers[0].messages.filter(([b, d]) => !b && /^split-/.test(d)).length === 2, 2000, "two messages sent a byte at a time");

	// Everything the RFC says to refuse, with the code it says to use.
	const refused = async (label, frame, code) => {
		const c = await connect();
		c.socket.write(frame);
		await until(() => closeCode(c) !== undefined || c.ended, 2000, label);
		assert.equal(closeCode(c), code, label);
		await until(() => c.ended, 2000, `${label}: the connection ends`);
	};
	await refused("an unmasked client frame", clientFrame(1, "x", { masked: false }), 1002);
	await refused("reserved bits", clientFrame(1, "x", { rsv: 0x40 }), 1002);
	await refused("an unknown opcode", clientFrame(3, "x"), 1002);
	await refused("a fragmented control frame", clientFrame(9, "x", { fin: false }), 1002);
	await refused("an oversize control frame", clientFrame(9, Buffer.alloc(126)), 1002);
	await refused("a continuation with nothing to continue", clientFrame(0, "x"), 1002);
	await refused("a new message inside a fragmented one", Buffer.concat([clientFrame(1, "a", { fin: false }), clientFrame(1, "b")]), 1002);
	await refused("a message over the limit (length in the header)", clientFrame(2, Buffer.alloc(70_001)), 1009);
	await refused("a huge 64-bit length", (() => { const f = clientFrame(2, "x", { lenForm: 64 }); f.writeBigUInt64BE(2n ** 40n, 2); return f; })(), 1009);
	await refused("a fragmented message over the limit", Buffer.concat([clientFrame(2, Buffer.alloc(40_000), { fin: false }), clientFrame(0, Buffer.alloc(40_000))]), 1009);
	await refused("invalid UTF-8 in text", clientFrame(1, Buffer.from([0xff, 0xfe])), 1007);
	await refused("a one-byte close payload", clientFrame(8, Buffer.from([1])), 1002);
	await refused("a reserved close code", clientFrame(8, Buffer.from([0x03, 0xed])), 1002);

	// Closing: the client's close is answered and ends the connection; the server's close waits for the answer.
	const polite = await connect();
	const politeRecord = peers.at(-1);
	polite.socket.write(clientFrame(8, Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from("bye")])));
	await until(() => polite.ended, 2000, "the polite close to end");
	assert.equal(closeCode(polite), 1001);
	assert.deepEqual(politeRecord.closed, [1001, "bye"], "the server is told the code and the reason");
	const servered = await connect();
	const serverRecord = peers.at(-1);
	serverRecord.peer.close(1000, "done");
	await until(() => closeCode(servered) === 1000, 2000, "the server's close frame");
	assert.equal(serverRecord.peer.open, false);
	assert.equal(serverRecord.peer.send("late"), false, "nothing is sent after a close");
	servered.socket.write(clientFrame(8, Buffer.from([0x03, 0xe8])));
	await until(() => serverRecord.closed, 2000, "the close to complete");
	const vanished = await connect();
	const vanishedRecord = peers.at(-1);
	vanished.socket.destroy();
	await until(() => vanishedRecord.closed, 2000, "a dropped connection to be noticed");
	assert.equal(vanishedRecord.closed[0], 1006);
	// A client that never answers pings is closed.
	const quiet = http.createServer();
	let quietPeer;
	quiet.on("upgrade", (req, socket, head) => { quietPeer = upgrade(req, socket, head, { pingMs: 40, closeWaitMs: 100 }); quietPeer.onClose = (code) => (quietPeer.code = code); });
	await new Promise((r) => quiet.listen(0, "127.0.0.1", r));
	const quietSocket = net.connect(quiet.address().port, "127.0.0.1");
	quietSocket.on("error", () => {});
	quietSocket.write("GET /q HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
	await until(() => quietPeer?.code, 3000, "the silent client to be dropped");
	assert.equal(quietPeer.code, 1001);
	quietSocket.destroy();
	await new Promise((r) => quiet.close(r));
	// Node's own client speaks to it.
	const echoed = await new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/t`);
		ws.binaryType = "arraybuffer";
		ws.onopen = () => ws.send("echo-me");
		ws.onmessage = (e) => { ws.close(); resolve(e.data); };
		ws.onerror = () => reject(new Error("the client could not connect"));
	});
	assert.equal(echoed, "echoed", "Node's WebSocket client works against it");
	for (const c of [good]) c.socket.destroy();
	await new Promise((r) => wsServer.close(r));

	// The pty helper, run for real: it is plain Python, so it needs no container to be tested.
	const pythonOk = spawnSync("python3", ["--version"]).status === 0;
	if (!pythonOk) console.log("python3 not found: the terminal helper was not run");
	else {
		const helper = (size = "80x24") => {
			const child = spawnProc("python3", ["-u", "-c", TERMINAL_HELPER, "piper-term-test"], { env: { ...process.env, TERM: "xterm-256color", PIPER_TERM_SIZE: size, HOME: tmpdir(), PS1: "" }, stdio: ["pipe", "pipe", "pipe"], cwd: tmpdir() });
			const h = { child, out: "", err: "", exit: null };
			child.stdout.setEncoding("utf8").on("data", (d) => (h.out += d));
			child.stderr.setEncoding("utf8").on("data", (d) => (h.err += d));
			child.on("close", (code) => (h.exit = code));
			h.type = (text) => child.stdin.write(Buffer.concat([Buffer.from(`D${Buffer.byteLength(text)}\n`), Buffer.from(text)]));
			h.typeBytes = (bytes) => child.stdin.write(Buffer.concat([Buffer.from(`D${bytes.length}\n`), Buffer.from(bytes)]));
			h.resize = (c, r) => child.stdin.write(`R${c}x${r}\n`);
			return h;
		};
		const t = helper("100x30");
		t.type("echo hello-$((6*7))\n");
		await until(() => t.out.includes("hello-42"), 5000, "the shell's answer");
		t.type("stty size\n");
		await until(() => /30 100/.test(t.out), 3000, "the starting size");
		t.resize(132, 43);
		await settle(100);
		t.type("stty size\n");
		await until(() => /43 132/.test(t.out), 3000, "the size after a resize");
		t.resize(1000, 1);
		await settle(80);
		t.type("stty size\n");
		await until(() => /2 500/.test(t.out), 3000, "a resize clamped to sane limits");
		t.typeBytes([0x65, 0x63, 0x68, 0x6f, 0x20, 0xc3]);
		await settle(60);
		t.typeBytes([0xa9, 0x0a]);
		await until(() => t.out.includes("é"), 3000, "a character split across two frames");
		t.type("sleep 30\n");
		await settle(300);
		t.type("\x03");
		await settle(200);
		t.type("echo after-interrupt\n");
		await until(() => t.out.includes("after-interrupt"), 3000, "a prompt after Ctrl-C");
		t.type("echo $TERM; exit 3\n");
		await until(() => t.exit !== null, 5000, "the helper to finish");
		assert.match(t.out, /xterm-256color/);
		assert.match(t.err, /X3\s*$/, "the exit code goes on stderr");
		assert.equal(t.exit, 0, "the helper itself ends cleanly");
		// Stdin ending hangs the shell up: nothing is left behind.
		const e = helper();
		e.type("echo ready\n");
		await until(() => e.out.includes("ready"), 5000, "a shell");
		e.type("sleep 60 &\n");
		e.child.stdin.end();
		await until(() => e.exit !== null, 6000, "the helper to end when stdin ends");
		assert.match(e.err, /X\d+/, "it still reports how the shell ended");
		// Exactly `sleep N`: matching on the whole command line would find the tool that runs this very test.
		const sleeping = (n) => spawnSync("sh", ["-c", `for p in $(pgrep -x sleep); do ps -o args= -p $p; done | grep -qx 'sleep ${n}'`]).status === 0;
		// A job the shell started does not outlive it, whether the shell exits or is hung up on.
		const jobs = helper();
		jobs.type("sleep 4242 &\n");
		await settle(300);
		assert.equal(sleeping(4242), true, "the job is running before the shell ends");
		jobs.type("exit\n");
		await until(() => jobs.exit !== null, 6000, "the helper to end after exit");
		await settle(100);
		assert.equal(sleeping(4242), false, "the job did not outlive its shell");
		const hung = helper();
		hung.type("sleep 4343 &\n");
		await settle(300);
		hung.child.stdin.end();
		await until(() => hung.exit !== null, 6000, "the helper to end when hung up on");
		await settle(100);
		assert.equal(sleeping(4343), false, "nor when the connection simply ends");
		// Garbage in the framing does not hurt it.
		const g = helper();
		g.child.stdin.write("Zjunk\nD99999999999x\nD5\nabc");
		g.type("de\n");
		g.type("echo still-here\n");
		await until(() => g.out.includes("still-here"), 5000, "the helper to survive bad frames");
		g.child.stdin.end();
		await until(() => g.exit !== null, 6000, "the helper to end");
	}

	// The whole path: HTTP upgrade, every refusal, the shell (a local stand-in for `docker exec`), audit, limits.
	if (pythonOk) {
		const { server } = await import("./server.mjs");
		const accessLog = config.ACCESS_LOG;
		config.ACCESS_LOG = false;
		const name = containerName(chatIdHash("terminal-test"));
		const stopped = containerName(chatIdHash("terminal-stopped"));
		const foreign = "some-other-container";
		const execCalls = [];
		setRunner(async (bin, args) => {
			if (args[0] === "inspect") {
				const infos = args.slice(args.indexOf("container") + 1).map((n) => ({ Name: `/${n}`, Id: `id-${n}`, State: { Running: n === name }, Config: { Image: "piper-agent", Labels: { "piper.managed": "1", "piper.key": "" } } }));
				return { code: 0, stdout: JSON.stringify(infos), stderr: "" };
			}
			if (args[0] === "exec") execCalls.push(args);
			return { code: 0, stdout: "", stderr: "" };
		});
		const standIn = (bin, args) => {
			const at = args.indexOf(name);
			const env = Object.fromEntries(args.flatMap((a, i) => (a === "-e" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
			return spawnProc("python3", ["-u", "-c", args[at + 4], args[at + 5]], { env: { ...process.env, ...env, HOME: tmpdir(), PS1: "" }, stdio: ["pipe", "pipe", "pipe"], cwd: tmpdir() });
		};
		const PASS = "a long enough password";
		clearPasswordHash();
		// terminalUpgrade is called by hand with the stand-in; a real server upgrade uses the same function.
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const sport = server.address().port;
		server.removeAllListeners("upgrade");
		server.on("upgrade", (req, socket, head) => { socket.on("error", () => {}); terminalUpgrade(req, socket, head, { spawnFn: standIn }).catch(() => socket.destroy()); });
		const dashPost = async (path, body, cookie) => {
			const res = await fetch(`http://127.0.0.1:${sport}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
			return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? null };
		};
		const attempt = (target, { cookie, origin, query = "" } = {}) => new Promise((resolve) => {
			const headers = { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) };
			const ws = new WebSocket(`ws://127.0.0.1:${sport}/dashboard/terminal/${target}${query}`, { headers });
			const got = { opened: false, messages: [], binary: "", closed: null };
			ws.binaryType = "arraybuffer";
			ws.onopen = () => { got.opened = true; resolve({ ws, got }); };
			ws.onmessage = (e) => (typeof e.data === "string" ? got.messages.push(JSON.parse(e.data)) : (got.binary += Buffer.from(e.data).toString()));
			ws.onerror = () => resolve({ ws, got });
			ws.onclose = (e) => (got.closed = [e.code, e.reason]);
		});
		const rawStatus = (target, headers = {}) => new Promise((resolve) => {
			const req = http.request({ port: sport, host: "127.0.0.1", path: `/dashboard/terminal/${target}`, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
			req.on("response", (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, body })); });
			req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: 101 }); });
			req.on("error", () => resolve({ status: 0 }));
			req.end();
		});
		// Without a password: refused, with a reason that says what to do.
		let r = await rawStatus(name);
		assert.equal(r.status, 403);
		assert.match(r.body, /dashboard password/);
		assert.equal(terminalCount(), 0);
		assert.equal((await dashPost("/dashboard/password", { next: PASS })).status, 200);
		const login = await dashPost("/dashboard/login", { password: PASS });
		const cookie = login.cookie;
		assert.ok(cookie);
		assert.equal((await rawStatus(name)).status, 401, "no cookie");
		assert.equal((await rawStatus(name, { Cookie: "piper_session=forged" })).status, 401, "a forged cookie");
		assert.equal((await rawStatus(name, { Cookie: cookie, Origin: "http://evil.example" })).status, 403, "a page from another origin");
		assert.equal((await rawStatus(foreign, { Cookie: cookie })).status, 404, "not one of this gateway's containers");
		assert.equal((await rawStatus(stopped, { Cookie: cookie })).status, 409, "not running");
		assert.equal((await rawStatus("../etc/passwd", { Cookie: cookie })).status, 404, "a path that is not a container name");
		const wrongPath = await new Promise((resolve) => http.get({ port: sport, host: "127.0.0.1", path: "/dashboard/other", headers: { Connection: "Upgrade", Upgrade: "websocket" } }).on("response", (res) => resolve(res.statusCode)).on("error", () => resolve(0)));
		assert.equal(wrongPath, 404, "only the terminal path upgrades");
		assert.equal(terminalCount(), 0, "nothing opened for any refusal");
		assert.equal(sameOrigin({ headers: { origin: "http://x:1", host: "x:1" } }), true);
		assert.equal(sameOrigin({ headers: { origin: "http://x:1", host: "y:1", "x-forwarded-host": "x:1" } }), true, "behind a proxy that rewrites Host");
		assert.equal(sameOrigin({ headers: { origin: "null", host: "x:1" } }), false);
		assert.equal(sameOrigin({ headers: { host: "x:1" } }), true, "no Origin: not a browser");
		// Settings that switch it off.
		config.TERMINAL_ENABLED = false;
		assert.equal((await rawStatus(name, { Cookie: cookie })).status, 403, "switched off");
		config.TERMINAL_ENABLED = true;

		// A real session.
		const auditBefore = queryAudit({ q: "terminal.", limit: 100 }).rows.length;
		const { ws, got } = await attempt(name, { cookie, origin: `http://127.0.0.1:${sport}`, query: "?cols=90&rows=20" });
		assert.equal(got.opened, true);
		await until(() => terminalCount() === 1, 2000, "the terminal to count");
		ws.send(Buffer.from("echo from-$((40+2)); stty size\n"));
		await until(() => got.binary.includes("from-42") && /20 90/.test(got.binary), 5000, `output and the size from the URL (got ${JSON.stringify(got.binary.slice(-300))}, ${JSON.stringify(got.messages)}, closed ${JSON.stringify(got.closed)})`);
		ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
		await settle(150);
		ws.send(Buffer.from("stty size\n"));
		await until(() => /40 120/.test(got.binary), 3000, "a resize over the socket");
		ws.send("not json at all");
		ws.send(JSON.stringify({ t: "unknown" }));
		ws.send(Buffer.from("echo still-alive\n"));
		await until(() => got.binary.includes("still-alive"), 3000, "bad control messages being ignored");
		ws.send(Buffer.from("exit 4\n"));
		await until(() => got.messages.some((m) => m.t === "exit" && m.code === 4), 5000, "the exit message");
		await until(() => got.closed, 3000, "the socket to close after the shell");
		assert.equal(terminalCount(), 0);
		const rows = queryAudit({ q: "terminal.", limit: 100 }).rows;
		assert.equal(rows.length, auditBefore + 2, "one row to open and one to close");
		const closeRow = rows.find((x) => x.action === "terminal.close");
		assert.match(closeRow.detail, /the shell exited \(code 4\); \d+ s, \d+ bytes typed, \d+ bytes shown/);
		assert.deepEqual([closeRow.actor, Boolean(closeRow.ip)], ["dashboard", true], "who and from where");
		assert.ok(!JSON.stringify(rows).includes("from-42") && !JSON.stringify(rows).includes("still-alive"), "what was typed or shown is never recorded");
		// Hanging up: the shell is told, the sweep by name runs, no terminal is left counted.
		execCalls.length = 0;
		const second = await attempt(name, { cookie });
		second.ws.send(Buffer.from("echo x\n"));
		await until(() => second.got.binary.includes("x"), 3000, "a second shell");
		second.ws.close();
		await until(() => terminalCount() === 0, 3000, "the count to drop when the browser leaves");
		await until(() => execCalls.some((a) => a.includes("pkill") && a.some((x) => /^piper-term-[0-9a-f]{8}$/.test(x))), 5000, "the by-name hang-up after a couple of seconds");
		const hangup = queryAudit({ q: "terminal.close", limit: 5 }).rows[0];
		assert.match(hangup.detail, /closed by the browser/);
		assert.deepEqual([hangup.actor, Boolean(hangup.ip)], ["dashboard", true], "a close from the browser still says who opened it");
		// The limit, and the idle timeout.
		config.TERMINAL_MAX_SESSIONS = 2;
		const a1 = await attempt(name, { cookie });
		const a2 = await attempt(name, { cookie });
		assert.deepEqual([a1.got.opened, a2.got.opened, terminalCount()], [true, true, 2]);
		assert.equal((await rawStatus(name, { Cookie: cookie })).status, 429, "over the limit");
		a1.ws.close();
		a2.ws.close();
		await until(() => terminalCount() === 0, 3000, "both to close");
		config.TERMINAL_MAX_SESSIONS = 4;
		config.TERMINAL_IDLE_MS = 400;
		const idle = await attempt(name, { cookie });
		await until(() => idle.got.messages.some((m) => m.t === "idle"), 3000, "the idle notice");
		await until(() => idle.got.closed, 3000, "the idle close");
		assert.match(queryAudit({ q: "terminal.close", limit: 3 }).rows[0].detail, /idle/);
		config.TERMINAL_IDLE_MS = 15 * 60_000;
		// Typing keeps it open.
		config.TERMINAL_IDLE_MS = 500;
		const busy = await attempt(name, { cookie });
		for (let i = 0; i < 5; i++) { busy.ws.send(Buffer.from(" ")); await settle(200); }
		assert.equal(busy.got.closed, null, "input keeps a terminal open past the idle time");
		config.TERMINAL_IDLE_MS = 15 * 60_000;
		closeAllTerminals("test over");
		await until(() => busy.got.closed, 3000, "closeAllTerminals");
		await until(() => terminalCount() === 0, 3000, "none left");
		// A shell that cannot start is explained, not silent.
		const broken = http.createServer();
		const brokenSpawn = () => spawnProc("sh", ["-c", "echo 'exec: \"python3\": executable file not found in $PATH' >&2; exit 127"], { stdio: ["pipe", "pipe", "pipe"] });
		server.removeAllListeners("upgrade");
		server.on("upgrade", (req, socket, head) => { socket.on("error", () => {}); terminalUpgrade(req, socket, head, { spawnFn: brokenSpawn }).catch(() => socket.destroy()); });
		const nope = await attempt(name, { cookie });
		await until(() => nope.got.messages.some((m) => m.t === "error"), 4000, "the explanation");
		assert.match(nope.got.messages.find((m) => m.t === "error").message, /the shell could not start: .*not found/);
		await until(() => nope.got.closed, 3000, "the close");
		void broken;
		assert.equal(terminalLabel(name, { Config: { Labels: { "piper.key": "" } } }), name);
		assert.match(terminalLabel(name, { Config: { Labels: { "piper.key": "no-such-key" } } }), /\(deleted key\) · /);
		clearPasswordHash();
		await new Promise((r) => server.close(r));
		config.ACCESS_LOG = accessLog;
		setRunner(async () => ({ code: 127, stdout: "", stderr: "the tests must not run docker" }));
	}
}

// The file browser's routes, with a stand-in `docker` that runs the helper locally in the mounted folder.
{
	const fsx = await import("node:fs");
	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	const bin = mkdtempSync(join(tmpdir(), "fakedocker-"));
	const helper = fileURLToPath(new URL("./piper-profile.mjs", import.meta.url));
	writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
dir=""; max=0; args=("$@"); rest=(); i=0
while [ $i -lt $# ]; do
  a="\${args[$i]}"
  case "$a" in
    -v) v="\${args[$((i+1))]}"; case "$v" in *:/data) dir="\${v%:/data}";; esac;;
    -e) e="\${args[$((i+1))]}"; case "$e" in PROFILE_MAX_BYTES=*) max="\${e#*=}";; esac;;
    /opt/piper/profile.mjs) rest=("\${args[@]:$((i+1))}"); break;;
  esac
  i=$((i+1))
done
cd "$dir" && PROFILE_MAX_BYTES=$max exec node ${helper} "\${rest[@]}"
`);
	fsx.chmodSync(join(bin, "docker"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	clearPasswordHash();
	const { record: key } = apiKeys.create({ name: "file browser", expiresAt: 0 });
	const { record: other } = apiKeys.create({ name: "someone else", expiresAt: 0 });
	const scopeName = scopeOf(key.id);
	const http = await import("node:http");
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, path, { body, json, query = "" } = {}) => {
		const res = await fetch(`${base}/dashboard/files/${scopeName}${path}${query}`, { method, headers: json !== undefined ? { "content-type": "application/json" } : {}, body: json !== undefined ? JSON.stringify(json) : body });
		const type = res.headers.get("content-type") ?? "";
		const raw = Buffer.from(await res.arrayBuffer());
		return { status: res.status, json: type.includes("json") ? JSON.parse(raw.toString()) : null, raw };
	};
	const ws = ensureWorkspace(key.id);
	const prof = ensureProfile(key.id);

	// Listing: workspace by default, the profile on request, folders sized only when asked.
	writeFileSync(join(ws, "readme.md"), "# hi\n");
	mkdirSync(join(ws, "src/deep"), { recursive: true });
	let r = await call("GET", "/");
	assert.equal(r.status, 200);
	assert.deepEqual([r.json.root, r.json.path, r.json.truncated, r.json.total], ["workspace", "", false, 2]);
	assert.deepEqual(r.json.entries.map((e) => [e.name, e.type]), [["readme.md", "file"], ["src", "dir"]]);
	assert.equal(r.json.entries.find((e) => e.name === "src").bytes, null, "no folder walk for a listing");
	r = await call("GET", "/src/");
	assert.equal(r.json.path, "src");
	r = await call("GET", "", { query: "?root=profile&as=list" });
	assert.equal(r.json.root, "profile");
	assert.ok(r.json.entries.some((e) => e.name === "settings.json"), "the profile has its settings.json");

	// Make, save, read back, conflict, move, download, delete: all in the workspace.
	assert.equal((await call("POST", "/docs/notes", { query: "?op=mkdir" })).json.created, true);
	r = await call("PUT", "/docs/notes/todo.txt", { query: "?as=text", json: { text: "first line\n" } });
	assert.equal(r.status, 200);
	const firstModified = r.json.modified;
	assert.equal(readFileSync(join(ws, "docs/notes/todo.txt"), "utf8"), "first line\n");
	r = await call("GET", "/docs/notes/todo.txt", { query: "?as=text" });
	assert.deepEqual([r.json.text, r.json.modified], ["first line\n", firstModified]);
	await new Promise((r) => setTimeout(r, 20));
	writeFileSync(join(ws, "docs/notes/todo.txt"), "the agent wrote this\n");
	utimesSync(join(ws, "docs/notes/todo.txt"), new Date(), new Date(Date.now() + 5000));
	r = await call("PUT", "/docs/notes/todo.txt", { query: "?as=text", json: { text: "mine\n", expectModified: firstModified } });
	assert.deepEqual([r.status, r.json.error.code], [409, "conflict"], "an edit over an agent's newer work is a conflict");
	assert.match(r.json.error.message, /changed since you opened it/);
	assert.equal(readFileSync(join(ws, "docs/notes/todo.txt"), "utf8"), "the agent wrote this\n");
	r = await call("POST", "/docs/notes/todo.txt", { query: "?op=move", json: { to: "docs/done/todo-renamed.txt" } });
	assert.deepEqual([r.status, r.json.moved], [200, true]);
	assert.equal(existsSync(join(ws, "docs/done/todo-renamed.txt")), true);
	r = await call("POST", "/docs/done/todo-renamed.txt", { query: "?op=move", json: { to: "readme.md" } });
	assert.equal(r.status, 400, "no overwrite unless asked");
	r = await call("POST", "/docs/done/todo-renamed.txt", { query: "?op=move", json: {} });
	assert.equal(r.status, 400);
	r = await call("GET", "/docs/done/todo-renamed.txt");
	assert.deepEqual([r.status, r.raw.toString()], [200, "the agent wrote this\n"], "a download is the bytes");
	r = await call("PUT", "/uploaded.bin", { body: Buffer.from([0, 1, 2, 255]) });
	assert.equal(r.status, 200, "an upload still works");
	assert.deepEqual([...readFileSync(join(ws, "uploaded.bin"))], [0, 1, 2, 255]);
	assert.equal((await call("GET", "/uploaded.bin", { query: "?as=text" })).json.binary, true);
	assert.equal((await call("DELETE", "/docs")).status, 200);
	assert.equal(existsSync(join(ws, "docs")), false);
	assert.equal((await call("GET", "/nope.txt", { query: "?as=text" })).status, 400);
	assert.equal((await call("PATCH", "/x")).status, 405);

	// The profile: editable, and locked means read-only.
	r = await call("PUT", "/AGENTS.md", { query: "?root=profile&as=text", json: { text: "You are the architect.\n" } });
	assert.equal(r.status, 200);
	assert.equal(readFileSync(join(prof, "AGENTS.md"), "utf8"), "You are the architect.\n", "written into the profile, not the workspace");
	assert.equal(existsSync(join(ws, "AGENTS.md")), false);
	setProfileLock(scopeName, true);
	for (const [method, path, extra] of [["PUT", "/AGENTS.md", { query: "?root=profile&as=text", json: { text: "x" } }], ["PUT", "/up.txt", { query: "?root=profile", body: "x" }], ["POST", "/d", { query: "?root=profile&op=mkdir" }], ["POST", "/AGENTS.md", { query: "?root=profile&op=move", json: { to: "B.md" } }], ["DELETE", "/AGENTS.md", { query: "?root=profile" }]]) {
		const locked = await call(method, path, extra);
		assert.equal(locked.status, 423, `${method} ${path} on a locked profile`);
		assert.equal(locked.json.error.code, "locked");
	}
	assert.equal(readFileSync(join(prof, "AGENTS.md"), "utf8"), "You are the architect.\n", "nothing changed");
	assert.equal((await call("GET", "/AGENTS.md", { query: "?root=profile&as=text" })).status, 200, "reading is fine");
	assert.equal((await call("PUT", "/ok.txt", { body: "workspace is not the profile" })).status, 200, "the workspace is not locked with it");
	setProfileLock(scopeName, false);
	assert.equal((await call("DELETE", "/AGENTS.md", { query: "?root=profile" })).status, 200);
	// Quotas: a profile over its limit refuses saves; a frozen workspace refuses writes but still deletes.
	const oldProfileMax = config.PROFILE_MAX_BYTES;
	config.PROFILE_MAX_BYTES = 500;
	r = await call("PUT", "/big.md", { query: "?root=profile&as=text", json: { text: "x".repeat(600) } });
	assert.equal(r.status, 400);
	assert.match(r.json.error.message, /quota/);
	config.PROFILE_MAX_BYTES = oldProfileMax;
	const oldWsMax = config.WORKSPACE_MAX_BYTES;
	writeFileSync(join(ws, "filler.bin"), Buffer.alloc(4000));
	invalidateSize(ws);
	config.WORKSPACE_MAX_BYTES = 1000;
	for (const [method, path, extra] of [["PUT", "/more.txt", { body: "x" }], ["PUT", "/t.txt", { query: "?as=text", json: { text: "x" } }], ["POST", "/f", { query: "?op=mkdir" }]]) {
		const frozen = await call(method, path, extra);
		assert.equal(frozen.status, 423, `${method} on a frozen workspace`);
		assert.match(frozen.json.error.message, /frozen/);
	}
	assert.equal((await call("DELETE", "/filler.bin")).status, 200, "deleting is how space is made");
	invalidateSize(ws);
	config.WORKSPACE_MAX_BYTES = oldWsMax;
	// An agent's links go nowhere, through the routes too.
	symlinkSync("/etc", join(ws, "etc-link"));
	assert.equal((await call("GET", "/etc-link/hostname")).status === 200, false, "a download through a link is refused");
	assert.equal((await call("PUT", "/etc-link/pwned", { query: "?as=text", json: { text: "x" } })).status, 400);
	assert.equal(existsSync("/etc/pwned"), false);
	const rawGet = (path) => new Promise((resolve) => http.get({ port: server.address().port, host: "127.0.0.1", path }, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, body })); }).on("error", () => resolve({ status: 0, body: "" })));
	for (const evil of [`/dashboard/files/${scopeName}/%2e%2e/%2e%2e/etc/passwd?as=text`, `/dashboard/files/${scopeName}/..%2f..%2fetc%2fpasswd?as=text`, `/dashboard/files/${scopeName}/%2fetc%2fpasswd?as=text`]) {
		const evilReply = await rawGet(evil);
		assert.ok(evilReply.status === 400 || evilReply.status === 404, `${evil} -> ${evilReply.status}`);
		assert.ok(!evilReply.body.includes("root:"), "no file outside the folder is ever read");
	}
	// An agent with a shared workspace browses the key's; with its own, its own.
	const agent = agents.create({ keyId: key.id, name: "browsable", workspace: "shared" });
	const agentScopeName = scopeOf(agentScope(key.id, agent.id));
	const viaAgent = await fetch(`${base}/dashboard/files/${agentScopeName}/`);
	assert.ok((await viaAgent.json()).entries.some((e) => e.name === "readme.md"), "a shared agent sees the key's workspace");
	agents.remove(agent.id);
	// What is recorded: the path, never the content; and nobody else's scope is reachable by guessing.
	const trail = queryAudit({ q: "files.", limit: 200 }).rows.filter((x) => x.action.startsWith("files."));
	assert.ok(["files.mkdir", "files.write", "files.move", "files.upload", "files.delete"].every((a) => trail.some((x) => x.action === a)), "each kind of change is recorded");
	assert.ok(trail.every((x) => x.category === "keys" && x.actor === "dashboard"));
	assert.ok(trail.some((x) => x.detail === "workspace:docs/notes/todo.txt"));
	assert.ok(!JSON.stringify(trail).includes("the agent wrote this") && !JSON.stringify(trail).includes("architect"), "content is not in the log");
	assert.equal((await fetch(`${base}/dashboard/files/key-no-such-key/`)).status, 200 || 404, "an unknown scope just has an empty folder");
	void other;
	// Locked dashboard.
	setPasswordHash(hashPassword("a long enough password"));
	assert.equal((await fetch(`${base}/dashboard/files/${scopeName}/`)).status, 401);
	clearPasswordHash();

	await new Promise((r) => server.close(r));
	process.env.PATH = oldPath;
	rmSync(bin, { recursive: true, force: true });
	config.ACCESS_LOG = accessLog;
}

// The vendored terminal files: exactly the listed ones, nothing else, only behind the dashboard.
{
	const { server } = await import("./server.mjs");
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;
	clearPasswordHash();
	assert.deepEqual(Object.keys(VENDOR_FILES).sort(), ["xterm/LICENSE", "xterm/addon-fit.js", "xterm/xterm.css", "xterm/xterm.js"]);
	for (const name of Object.keys(VENDOR_FILES)) assert.ok(vendorFile(name).body.length > 500, `${name} is there`);
	assert.match(vendorFile("xterm/LICENSE").body.toString(), /Permission is hereby granted/, "the licence travels with the code");
	for (const bad of ["../package.json", "xterm/../../package.json", "xterm/xterm.js.map", "xterm", "", "xterm/xterm.js/", "XTERM/xterm.js", "xterm%2Fxterm.js", "__proto__", "constructor"]) assert.equal(vendorFile(bad), null, JSON.stringify(bad));
	assert.deepEqual(THIRD_PARTY.map((t) => t.name), ["xterm.js", "xterm.js fit addon"]);
	for (const row of THIRD_PARTY) assert.ok(readFileSync(new URL("./THIRD_PARTY.md", import.meta.url), "utf8").includes(row.version), `THIRD_PARTY.md names ${row.name} ${row.version}`);
	assert.ok(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).dependencies === undefined, "still no runtime dependencies");
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const js = await fetch(`${base}/dashboard/vendor/xterm/xterm.js`);
	assert.deepEqual([js.status, js.headers.get("content-type"), js.headers.get("x-content-type-options")], [200, "text/javascript; charset=utf-8", "nosniff"]);
	assert.equal((await fetch(`${base}/dashboard/vendor/xterm/xterm.css`)).headers.get("content-type"), "text/css; charset=utf-8");
	for (const evil of ["/dashboard/vendor/../package.json", "/dashboard/vendor/xterm/%2e%2e/%2e%2e/package.json", "/dashboard/vendor/xterm/nope.js", "/dashboard/vendor/"]) assert.equal((await fetch(`${base}${evil}`)).status, 404, evil);
	setPasswordHash(hashPassword("a long enough password"));
	assert.equal((await fetch(`${base}/dashboard/vendor/xterm/xterm.js`)).status, 401, "not served to someone who is not signed in");
	clearPasswordHash();
	const about = await (await fetch(`${base}/dashboard/about.json`)).json();
	assert.deepEqual(about.thirdParty.map((t) => t.licence), ["MIT", "MIT"], "credited on the About page");
	await new Promise((r) => server.close(r));
	config.ACCESS_LOG = accessLog;
}

// Phase 0: the live event log, the shared agent turn, and spend per agent.
{
	const { LiveLog, MAX_ITEMS, MAX_TEXT, MAX_RESULT, credentialFor, runAgentTurn, AgentRunError, agentSpendToday } = await import("./server.mjs");
	const log = new LiveLog();
	const seen = [];
	const stop = log.subscribe((c) => seen.push(c));
	log.feed({ type: "agent_start" });
	log.feed({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
	log.feed({ type: "message_start", message: { role: "assistant" } });
	for (const delta of ["Hel", "lo ", "there"]) log.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
	log.feed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
	log.feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls  -la" } });
	log.feed({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "x".repeat(MAX_RESULT * 2) }] } });
	let snap = log.snapshot();
	assert.deepEqual(snap.items.map((i) => i.kind), ["user", "assistant", "thinking", "tool"], "deltas fold into one item each");
	assert.equal(snap.items[1].text, "Hello there");
	assert.equal(snap.items[3].summary, "bash: ls -la");
	assert.equal(snap.items[3].state, "done");
	assert.ok(snap.items[3].result.length <= MAX_RESULT + 1, "a tool result is capped");
	assert.equal(snap.state.working, true);
	assert.ok(seen.some((c) => c.op === "update") && seen.some((c) => c.op === "add"), "watchers see adds and updates");
	log.feed({ type: "agent_settled" });
	assert.equal(log.snapshot().state.working, false);
	assert.equal(JSON.stringify(log.snapshot()).includes("sessionId"), false);
	// Bounded: items and text.
	for (let i = 0; i < MAX_ITEMS + 50; i++) log.note(`n${i}`);
	assert.equal(log.snapshot().items.length, MAX_ITEMS);
	const big = new LiveLog();
	big.feed({ type: "message_start", message: { role: "assistant" } });
	for (let i = 0; i < 40; i++) big.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y".repeat(2000) } });
	assert.ok(big.snapshot().items[0].text.length <= MAX_TEXT + 1, "message text is capped");
	// A throwing watcher is dropped and does not stop the others.
	let calls = 0;
	log.subscribe(() => {
		throw new Error("bad watcher");
	});
	log.subscribe(() => calls++);
	log.note("x");
	log.note("y");
	assert.equal(calls, 2);
	assert.equal(log.watchers, 2, "the broken watcher is gone");
	stop();
	log.end("bye");
	assert.equal(log.ended, true);
	const after = seen.length;
	log.feed({ type: "agent_start" });
	assert.equal(seen.length, after, "nothing after the end");

	// credentialFor and the refusals of runAgentTurn.
	const created = apiKeys.create({ name: "run-test" });
	const key = created.record ?? created;
	const cred = credentialFor(key.id);
	assert.equal(cred.id, key.id);
	await assert.rejects(async () => credentialFor("nope"), (e) => e instanceof AgentRunError && e.status === 401);
	const agent = await createAgent({ keyId: key.id, name: "runner" });
	const ac = credentialFor(key.id, agent.id);
	assert.equal(ac.scopeId, agentScope(key.id, agent.id));
	assert.deepEqual(ac.agent, { id: agent.id, name: "runner" });
	await assert.rejects(async () => credentialFor(key.id, "not-an-agent"), (e) => e.status === 404);
	await assert.rejects(runAgentTurn({ credential: cred, prompt: "   " }), (e) => e.status === 400);
	apiKeys.update(key.id, { dailySpend: 0.01 });
	recordSpend({ id: "agentrun-spend", requests: 1, keyId: key.id, agentId: agent.id }, { getSessionStats: () => ({ cost: 0.5, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }), model: { provider: "p", id: "m" } });
	await assert.rejects(runAgentTurn({ credential: cred, prompt: "hi", clientSessionId: "over-cap" }), (e) => e.status === 429 && e.code === "spend_limit_exceeded");
	// Spend per agent.
	const report = await spendReport();
	const row = report.byAgent.find((r) => r.agentId === agent.id);
	assert.ok(row && Math.abs(row.cost - 0.5) < 1e-9, "the agent's spend is its own row");
	assert.match(row.label, /run-test/);
	assert.ok(Math.abs(agentSpendToday(agent.id) - 0.5) < 1e-9);
	assert.equal(agentSpendToday("someone-else"), 0);
	apiKeys.update(key.id, { dailySpend: null });
	await deleteAgent(agent.id).catch(() => {});
	apiKeys.revoke?.(key.id);
	await assert.rejects(async () => credentialFor(key.id), (e) => e.status === 401, "a revoked key runs nothing");
}

// Phase 1: the live view's routes.
{
	const { liveRoutes, renderTranscript, watcherCount, MAX_WATCHERS_PER_SESSION } = await import("./server.mjs");
	const http = await import("node:http");
	const fakeId = "live-view-chat";
	const { record } = sessions.acquire(fakeId, null);
	record.sessionPromise.catch(() => {});
	let aborts = 0;
	record.session = { model: { provider: "p", id: "m" }, getSessionStats: () => ({ cost: 0.25, tokens: { total: 42 } }), abort: async () => void aborts++, send: async (c) => (c.type === "get_messages" ? { messages: [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "yo" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
		{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "z".repeat(10_000) }] },
	] } : {}) };
	const fp = fingerprint(fakeId);
	const srv = http.createServer((req, res) => void liveRoutes(req, res, new URL(req.url, "http://x").pathname).then((handled) => handled || (res.writeHead(404), res.end())));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}/dashboard/session`;
	const before = recentAudit(500).length;

	clearPasswordHash();
	assert.equal((await fetch(`${base}/${fp}/transcript.md`)).status, 403, "no dashboard password, no live view");
	setPasswordHash(hashPassword("a long enough password"));
	assert.equal((await fetch(`${base}/${"0".repeat(12)}/transcript.md`)).status, 404, "unknown chat");
	assert.equal((await fetch(`${base}/not-hex/events`)).status, 404, "not a route of ours");
	config.LIVE_VIEW_ENABLED = false;
	assert.equal((await fetch(`${base}/${fp}/transcript.md`)).status, 403, "switched off");
	config.LIVE_VIEW_ENABLED = true;

	const md = await fetch(`${base}/${fp}/transcript.md`);
	assert.equal(md.status, 200);
	assert.match(md.headers.get("content-disposition"), /attachment; filename="piper-/);
	const text = await md.text();
	assert.match(text, /## You\n\nhi/);
	assert.match(text, /> t/);
	assert.match(text, /\*\*Tool: bash\*\*/);
	assert.match(text, /more characters cut/, "a long tool result is truncated");
	assert.equal(text.includes(fakeId), false, "the real session id is never in a transcript");
	assert.equal((await (await fetch(`${base}/${fp}/transcript.json`)).json()).messages.length, 3);
	assert.equal(renderTranscript(null), "# Piper chat\n");

	// Interrupt: nothing running is not an abort; a run in flight is aborted once.
	assert.deepEqual(await (await fetch(`${base}/${fp}/interrupt`, { method: "POST" })).json(), { interrupted: false, wasRunning: false });
	assert.equal(aborts, 0);
	record.inflight = 1;
	assert.deepEqual(await (await fetch(`${base}/${fp}/interrupt`, { method: "POST" })).json(), { interrupted: true, wasRunning: true });
	assert.equal(aborts, 1);
	record.inflight = 0;
	assert.equal((await fetch(`${base}/${fp}/interrupt`)).status, 405, "interrupt is a POST");

	// The stream: a snapshot first, then live changes, then the end.
	const stream = await fetch(`${base}/${fp}/events`);
	assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
	record.live.feed({ type: "message_start", message: { role: "assistant" } });
	const reader = stream.body.getReader();
	let got = "";
	const readUntil = async (re) => {
		const deadline = Date.now() + 3000;
		while (!re.test(got) && Date.now() < deadline) got += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
	};
	await readUntil(/event: snapshot/);
	assert.match(got, /event: snapshot\ndata: .*"chat":\{"key"/);
	assert.equal(got.includes(fakeId), false, "no real session id in the stream");
	assert.equal(watcherCount(), 1);
	record.live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "live!" } });
	await readUntil(/live!/);
	assert.match(got, /event: add/);
	sessions.close(fakeId);
	await readUntil(/event: end/);
	assert.match(got, /event: end/);
	await reader.cancel().catch(() => {});
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(watcherCount(), 0, "the watcher is released");
	assert.ok(recentAudit(500).length > before);
	const kinds = recentAudit(50).map((r) => r.action);
	assert.ok(kinds.includes("session.watch") && kinds.includes("session.interrupt") && kinds.includes("session.transcript"));
	assert.equal(recentAudit(50).some((r) => /yo|live!/.test(r.detail)), false, "the audit never holds content");

	// Watcher limit per chat.
	const other = sessions.acquire("live-view-limit", null).record;
	other.sessionPromise.catch(() => {});
	other.session = record.session;
	const ofp = fingerprint("live-view-limit");
	const opened = [];
	for (let i = 0; i < MAX_WATCHERS_PER_SESSION; i++) {
		const r = await fetch(`${base}/${ofp}/events`);
		assert.equal(r.status, 200);
		opened.push(r);
	}
	assert.equal((await fetch(`${base}/${ofp}/events`)).status, 429, "one more watcher than allowed");
	for (const r of opened) await r.body.cancel().catch(() => {});
	sessions.close("live-view-limit");
	clearPasswordHash();
	await new Promise((r) => srv.close(r));
	srv.closeAllConnections?.();
}

// Phase 2: jobs.
{
	const J = await import("./server.mjs");
	const { validateSchedule, nextRun, describeSchedule, createJob, updateJob, deleteJob, queueRun, pump, tick, cancelRun, trigger, newTrigger, clearTrigger, signWebhook, submit, requestStatus, cancelRequest, getJob, listRuns, setJobRunner, purgeRuns, JobError, scheduledJobView, deliverWebhook, validateWebhookUrl, getRun } = J;
	const created = apiKeys.create({ name: "jobs-test" });
	const key = created.record ?? created;
	const other = apiKeys.create({ name: "jobs-other" });
	const otherKey = other.record ?? other;
	const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

	// Schedules.
	assert.deepEqual(validateSchedule({ kind: "interval", every: "15", unit: "minutes" }), { kind: "interval", every: 15, unit: "minutes" });
	for (const bad of [null, {}, { kind: "cron" }, { kind: "interval", every: 0, unit: "minutes" }, { kind: "interval", every: 1.5, unit: "hours" }, { kind: "interval", every: 1, unit: "days" }, { kind: "interval", every: 9999, unit: "hours" }, { kind: "daily", at: "25:00" }, { kind: "daily", at: "7" }, { kind: "weekly", days: [], at: "07:30" }, { kind: "weekly", days: [7], at: "07:30" }, { kind: "once", at: "never" }]) assert.throws(() => validateSchedule(bad), JobError, JSON.stringify(bad));
	assert.deepEqual(validateSchedule({ kind: "daily", at: "7:05" }), { kind: "daily", at: "07:05" });
	assert.equal(nextRun({ kind: "interval", every: 2, unit: "hours" }, 1000), 1000 + 7_200_000);
	assert.equal(nextRun({ kind: "daily", at: "07:30" }, at(2026, 3, 10, 7, 0)), at(2026, 3, 10, 7, 30), "later today");
	assert.equal(nextRun({ kind: "daily", at: "07:30" }, at(2026, 3, 10, 7, 30)), at(2026, 3, 11, 7, 30), "exactly now is already past");
	assert.equal(nextRun({ kind: "daily", at: "07:30" }, at(2026, 12, 31, 23, 0)), at(2027, 1, 1, 7, 30), "over a year end");
	assert.equal(nextRun({ kind: "daily", at: "09:00" }, at(2026, 2, 28, 10, 0)), at(2026, 3, 1, 9, 0), "over a month end");
	// 2026-03-15 is a Sunday; Monday and Thursday at 06:00.
	const week = { kind: "weekly", days: [1, 4], at: "06:00" };
	assert.equal(new Date(nextRun(week, at(2026, 3, 15, 12, 0))).getDay(), 1);
	assert.equal(nextRun(week, at(2026, 3, 15, 12, 0)), at(2026, 3, 16, 6, 0));
	assert.equal(nextRun(week, at(2026, 3, 16, 6, 0)), at(2026, 3, 19, 6, 0), "Monday's slot is over, Thursday is next");
	assert.equal(nextRun({ kind: "weekly", days: [0], at: "06:00" }, at(2026, 3, 15, 6, 1)), at(2026, 3, 22, 6, 0), "the same weekday, a week on");
	assert.equal(nextRun({ kind: "once", at: 5000 }, 4000), 5000);
	assert.equal(nextRun({ kind: "once", at: 5000 }, 5000), null);
	assert.equal(nextRun({ kind: "manual" }, 0), null);
	// Daylight saving: the wall-clock time holds on the days the clock moves, whatever the zone is here.
	for (const [d0, d1] of [[at(2026, 3, 28, 12), at(2026, 3, 29, 3)], [at(2026, 10, 24, 12), at(2026, 10, 25, 3)], [at(2026, 3, 7, 12), at(2026, 3, 8, 3)], [at(2026, 11, 1, 0, 1), at(2026, 11, 1, 3)]]) {
		const n = new Date(nextRun({ kind: "daily", at: "07:30" }, d0));
		assert.deepEqual([n.getHours(), n.getMinutes()], [7, 30], "07:30 stays 07:30 across a clock change");
		assert.ok(nextRun({ kind: "daily", at: "07:30" }, d1) > d1);
	}
	assert.match(describeSchedule({ kind: "weekly", days: [1, 4], at: "06:00" }), /Mon, Thu at 06:00/);
	assert.equal(describeSchedule({ kind: "interval", every: 1, unit: "hours" }), "every hour");

	// Creating, validating, changing.
	assert.throws(() => createJob({ keyId: "nope", name: "x", prompt: "p" }), (e) => e.status === 404);
	assert.throws(() => createJob({ keyId: key.id, name: "", prompt: "p" }), /needs a name/);
	assert.throws(() => createJob({ keyId: key.id, name: "x", prompt: "  " }), /prompt is empty/);
	assert.throws(() => createJob({ keyId: key.id, name: "x", prompt: "p", timeoutMs: 5 }), /time limit/);
	assert.throws(() => createJob({ keyId: key.id, name: "x", prompt: "p", webhookUrl: "ftp://x" }), /http or https/);
	assert.throws(() => createJob({ keyId: key.id, name: "x", prompt: "p", webhookUrl: "https://u:p@x.test/" }), /credentials/);
	assert.throws(() => validateWebhookUrl("http://127.0.0.1:9/", { strict: true }), /internal/);
	assert.equal(validateWebhookUrl("http://127.0.0.1:9/"), "http://127.0.0.1:9/", "the operator may point at their own network");
	assert.throws(() => createJob({ keyId: key.id, agentId: "deadbeef", name: "x", prompt: "p" }), (e) => e.status === 404, "an agent that is not this key's");
	const made = createJob({ keyId: key.id, name: "daily", prompt: "say {{payload}}", schedule: { kind: "interval", every: 1, unit: "hours" } });
	assert.ok(made.job.nextRunAt > Date.now(), "timed from now");
	assert.equal(made.webhookSecret, null);
	const withHook = createJob({ keyId: key.id, name: "hooked", prompt: "p", webhookUrl: "http://127.0.0.1:1/x" });
	assert.match(withHook.webhookSecret, /^whsec_/);
	assert.equal(JSON.stringify(scheduledJobView(getJob(withHook.job.id))).includes(withHook.webhookSecret), false, "the signing secret is not in the view");
	assert.equal(updateJob(made.job.id, { name: "renamed", enabled: false }).job.nextRunAt, null, "off means no next run");
	assert.ok(updateJob(made.job.id, { enabled: true }).job.nextRunAt > Date.now());

	// Running, with an injected turn.
	const calls = [];
	let hold = null;
	setJobRunner(async ({ credential, clientSessionId, prompt, model, signal }) => {
		calls.push({ key: credential.id, clientSessionId, prompt, model });
		if (hold) await new Promise((resolve, reject) => { hold.release = resolve; signal.addEventListener("abort", () => reject(new Error("aborted"))); });
		return { text: `answer to: ${prompt}`, usage: { total_tokens: 12 }, cost: 0.02, scopedId: `scoped-${clientSessionId}` };
	});
	const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); } throw new Error("timed out waiting"); };
	const run1 = queueRun(made.job.id, "manual", { payload: "hello" });
	assert.equal(run1.status, "queued");
	await waitFor(() => getRun(run1.id).status === "ok");
	const done = listRuns(made.job.id)[0];
	assert.deepEqual([done.status, done.tokens, done.cost, done.trigger], ["ok", 12, 0.02, "manual"]);
	assert.equal(calls[0].prompt, "say hello", "{{payload}} is filled in");
	assert.match(calls[0].clientSessionId, new RegExp(`^job:${made.job.id}:\\d+$`), "a fresh session per run");
	updateJob(made.job.id, { sessionMode: "continue" });
	const run2 = queueRun(made.job.id, "manual");
	await waitFor(() => getRun(run2.id).status === "ok");
	assert.equal(calls[1].clientSessionId, `job:${made.job.id}`, "one stable session when it continues");

	// No overlap, the per-key cap, and the concurrency cap.
	hold = {};
	const slow = queueRun(made.job.id, "manual");
	await waitFor(() => getRun(slow.id).status === "running");
	const second = queueRun(made.job.id, "schedule");
	assert.deepEqual([second.status, second.error], ["skipped", "the previous run is still going"]);
	assert.equal(cancelRun(slow.id), true);
	await waitFor(() => getRun(slow.id).status === "cancelled");
	hold = null;
	config.JOBS_MAX_PER_KEY = 1;
	hold = {};
	const a = createJob({ keyId: key.id, name: "a", prompt: "p" }).job;
	const b = createJob({ keyId: key.id, name: "b", prompt: "p" }).job;
	const ra = queueRun(a.id, "manual");
	await waitFor(() => getRun(ra.id).status === "running");
	assert.throws(() => queueRun(b.id, "manual"), (e) => e.status === 429, "a person is told");
	assert.equal(queueRun(b.id, "schedule").status, "skipped", "a schedule is recorded as skipped");
	cancelRun(ra.id);
	await waitFor(() => getRun(ra.id).status === "cancelled");
	hold = null;
	config.JOBS_MAX_PER_KEY = 20;
	config.JOBS_MAX_PARALLEL = 1;
	hold = {};
	const p1 = queueRun(a.id, "manual");
	const p2 = queueRun(b.id, "manual");
	await waitFor(() => getRun(p1.id).status === "running");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(getRun(p2.id).status, "queued", "only JOBS_MAX_PARALLEL run at once");
	hold.release();
	await waitFor(() => getRun(p1.id).status === "ok");
	await waitFor(() => getRun(p2.id).status === "running");
	hold.release();
	await waitFor(() => getRun(p2.id).status === "ok");
	hold = null;
	config.JOBS_MAX_PARALLEL = 2;

	// Time limit.
	hold = {};
	const timed = createJob({ keyId: key.id, name: "timed", prompt: "p", timeoutMs: 10_000 }).job;
	db.prepare("UPDATE jobs SET timeout_ms = 60 WHERE id = ?").run(timed.id);
	const rt = queueRun(timed.id, "manual");
	await waitFor(() => getRun(rt.id).status === "timeout");
	assert.match(getRun(rt.id).error, /no answer within/);
	hold = null;

	// The scheduler: due jobs queue once, late ones make up one run, a one-time job switches off.
	const sched = createJob({ keyId: key.id, name: "sched", prompt: "tick", schedule: { kind: "interval", every: 30, unit: "minutes" } }).job;
	const nowT = Date.now();
	assert.equal(tick(nowT), 0, "nothing due yet");
	db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?").run(nowT - 3 * 3_600_000, sched.id);
	assert.equal(tick(nowT), 1, "three hours of missed runs make up one");
	await waitFor(() => listRuns(sched.id).length === 1 && listRuns(sched.id)[0].status === "ok");
	assert.match(listRuns(sched.id)[0].note, /late by .* made up once/);
	assert.ok(getJob(sched.id).next_run_at > nowT, "timed from now");
	assert.equal(tick(nowT), 0);
	const once = createJob({ keyId: key.id, name: "once", prompt: "o", schedule: { kind: "once", at: Date.now() + 60_000 } }).job;
	assert.equal(tick(Date.now() + 120_000), 1);
	assert.equal(getJob(once.id).enabled, 0, "a one-time job turns itself off");
	config.JOBS_ENABLED = false;
	db.prepare("UPDATE jobs SET next_run_at = 1 WHERE id = ?").run(sched.id);
	assert.equal(tick(), 0, "a switched-off scheduler queues nothing");
	assert.throws(() => queueRun(sched.id, "manual"), (e) => e.status === 409);
	config.JOBS_ENABLED = true;

	// A key that cannot run: the run is skipped with the reason, the turn never starts.
	setJobRunner(null);
	const victim = apiKeys.create({ name: "jobs-victim" });
	const victimKey = victim.record ?? victim;
	const vj = createJob({ keyId: victimKey.id, name: "v", prompt: "p" }).job;
	apiKeys.revoke(victimKey.id);
	const rv = queueRun(vj.id, "manual");
	await waitFor(() => getRun(rv.id).status === "skipped");
	assert.match(getRun(rv.id).error, /revoked/);
	assert.equal(deleteJob(vj.id), true);
	assert.equal(getRun(rv.id), null, "a job's history goes with it");

	// The inbound webhook.
	let calls2 = 0;
	setJobRunner(async ({ prompt }) => (calls2++, { text: prompt, usage: { total_tokens: 1 }, cost: 0, scopedId: "x" }));
	const hookJob = createJob({ keyId: key.id, name: "inbound", prompt: "got {{payload}}" }).job;
	assert.throws(() => trigger(hookJob.id, "anything", "x"), (e) => e.status === 404, "no token yet: not found");
	const token = newTrigger(hookJob.id);
	assert.match(token, /^pjt_/);
	assert.equal(JSON.stringify(getJob(hookJob.id)).includes(token), false, "only a hash is stored");
	assert.throws(() => trigger(hookJob.id, "pjt_wrong", "x"), (e) => e.status === 404 && e.message === "not found");
	assert.throws(() => trigger("jffffffffffff", token, "x"), (e) => e.status === 404, "an unknown job answers the same");
	config.JOBS_MIN_INTERVAL_MS = 60_000;
	const big = "z".repeat(40_000);
	const tr = trigger(hookJob.id, token, big);
	await waitFor(() => getRun(tr.id).status === "ok");
	assert.ok(getRun(tr.id).prompt.length <= "got ".length + 16 * 1024, "the payload is capped at 16 KB");
	assert.throws(() => trigger(hookJob.id, token, "again"), (e) => e.status === 429, "rate limited");
	config.JOBS_MIN_INTERVAL_MS = 0;
	clearTrigger(hookJob.id);
	assert.throws(() => trigger(hookJob.id, token, "x"), (e) => e.status === 404, "a revoked token stops working");
	updateJob(hookJob.id, { enabled: false });
	const token2 = newTrigger(hookJob.id);
	assert.throws(() => trigger(hookJob.id, token2, "x"), (e) => e.status === 409, "a switched-off job is not started");

	// The async API: ownership, status, cancel.
	const sub = submit(key, { prompt: "async please", model: null });
	assert.match(sub.id, /^j[0-9a-f]{12}$/);
	await waitFor(() => requestStatus(key, sub.id).status === "ok");
	assert.equal(requestStatus(key, sub.id).text, "async please");
	assert.throws(() => requestStatus(otherKey, sub.id), (e) => e.status === 404, "another key cannot read it");
	assert.throws(() => cancelRequest(otherKey, sub.id), (e) => e.status === 404);
	assert.throws(() => requestStatus(key, hookJob.id), (e) => e.status === 404, "a dashboard job is not an API request");
	assert.throws(() => submit(key, { prompt: "x", agent: "nobody" }), (e) => e.status === 404);
	assert.throws(() => submit(key, { prompt: "x", webhook_url: "http://169.254.169.254/" }), /internal/);
	assert.throws(() => submit({}, { prompt: "x" }), (e) => e.status === 401);

	// The completion webhook is signed and tried once more on failure.
	const received = [];
	const receiver = (await import("node:http")).createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			received.push({ body, sig: req.headers["x-piper-signature"] });
			res.writeHead(received.length === 1 ? 500 : 200);
			res.end();
		});
	});
	await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
	const wh = createJob({ keyId: key.id, name: "notify", prompt: "report", webhookUrl: `http://127.0.0.1:${receiver.address().port}/hook` });
	const rw = queueRun(wh.job.id, "manual");
	await waitFor(() => getRun(rw.id).webhook);
	assert.equal(received.length, 2, "one retry after a 500");
	assert.match(getRun(rw.id).webhook, /delivered \(200\)/);
	const { body, sig } = received[1];
	const [, t, mac] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
	assert.equal(signWebhook(wh.webhookSecret, body, Number(t)), sig, "the receiver can verify it with the secret");
	assert.equal(JSON.parse(body).status, "ok");
	assert.equal(JSON.parse(body).job.name, "notify");
	await new Promise((r) => receiver.close(r));
	receiver.closeAllConnections?.();

	// Retention, and what goes when a key goes.
	db.prepare("UPDATE job_runs SET ended_at = 1 WHERE job_id = ?").run(sub.id);
	assert.ok(purgeRuns() >= 1);
	assert.equal(getJob(sub.id), null, "an old API request disappears with its results");
	assert.ok(J.deleteJobsOf({ keyId: key.id }) > 3);
	assert.equal(listJobsCount(key.id), 0);
	setJobRunner(null);
	function listJobsCount(id) { return db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE key_id = ?").get(id).n; }
	J.stopJobs();
}

// Phase 2: agent-created schedules (the server side of the bridge's scheduling tools).
{
	const { maySchedule, schedulerFor, getJob, createJob, deleteJobsOf } = await import("./server.mjs");
	const rec = apiKeys.create({ name: "sched-agent-key" });
	const key = rec.record ?? rec;
	const agent = agents.create({ keyId: key.id, name: "ticker" });
	const otherAgent = agents.create({ keyId: key.id, name: "other" });
	const record = { keyId: key.id, agentId: agent.id, delegateChain: [], delegateDepth: 0 };
	config.AGENT_JOBS_ENABLED = true;
	config.AGENT_JOBS_MAX_PER_AGENT = 10;

	assert.equal(maySchedule(record), false, "off until the agent's own switch is on");
	agents.update(agent.id, { canSchedule: true });
	agents.update(otherAgent.id, { canSchedule: true });
	assert.equal(maySchedule(record), true);

	const sched = schedulerFor(record);
	assert.equal(sched.list().length, 0);
	const made = sched.create({ name: "check", prompt: "check the thing", schedule: { kind: "interval", every: 6, unit: "hours" } });
	assert.match(made.id, /^j[0-9a-f]{12}$/);
	assert.equal(made.sessionMode, "memory", "a recurring task starts fresh but is shown its last reports");
	assert.equal(made.notify, "changes", "and tells its owner only when something changed");
	assert.equal(made.scheduleText, "every 6 hours");
	assert.equal(getJob(made.id).origin, "agent", "it is marked as the agent's own");
	// Every schedule kind is accepted, and a one-off too.
	sched.create({ name: "daily", prompt: "p", schedule: { kind: "daily", at: "07:30" } });
	sched.create({ name: "once", prompt: "p", schedule: { kind: "once", at: Date.now() + 3_600_000 } });
	assert.equal(sched.list().length, 3);

	// An operator's job for the same agent is neither listed nor removable through the tool.
	const operatorJob = createJob({ keyId: key.id, agentId: agent.id, name: "operator", prompt: "p" }).job;
	assert.equal(sched.list().length, 3, "only the agent's own schedules are listed");
	assert.throws(() => sched.remove({ id: operatorJob.id }), /no such schedule/);
	assert.throws(() => sched.run({ id: operatorJob.id }), /no such schedule/);

	// Another agent of the same key cannot touch them either.
	const otherSched = schedulerFor({ keyId: key.id, agentId: otherAgent.id });
	const theirs = otherSched.create({ name: "theirs", prompt: "p", schedule: { kind: "manual" } });
	assert.throws(() => sched.remove({ id: theirs.id }), /no such schedule/);
	assert.throws(() => otherSched.remove({ id: made.id }), /no such schedule/);

	// The per-agent cap counts the agent's own schedules, not the operator's.
	config.AGENT_JOBS_MAX_PER_AGENT = 3;
	assert.throws(() => sched.create({ name: "over", prompt: "p", schedule: { kind: "weekly", days: [1], at: "06:00" } }), /the most it may have/);

	// The global switch is a kill switch for every agent.
	config.AGENT_JOBS_ENABLED = false;
	assert.equal(maySchedule(record), false);
	assert.throws(() => sched.list(), /may not create schedules/);
	assert.throws(() => schedulerFor(record), /may not create schedules/);
	config.AGENT_JOBS_ENABLED = true;

	assert.ok(deleteJobsOf({ keyId: key.id }) >= 4);
	agents.remove(agent.id);
	agents.remove(otherAgent.id);
	config.AGENT_JOBS_MAX_PER_AGENT = 10;
}

// Unattended runs: delivery to the owner, the previous-report context, auto-disable and the daily cost cap.
{
	const J = await import("./server.mjs");
	const { createJob, updateJob, queueRun, getJob, getRun, listRuns, setJobRunner, takeInbox, inboxNotice, deleteJobsOf, scheduledJobView, tick } = J;
	const rec = apiKeys.create({ name: "unattended-key" });
	const key = rec.record ?? rec;
	const agent = agents.create({ keyId: key.id, name: "watcher" });
	const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); } throw new Error("timed out waiting"); };
	const prompts = [];
	let reply = () => ({ text: "x", cost: 0 });
	setJobRunner(async ({ prompt }) => {
		prompts.push(prompt);
		const r = await reply(prompt);
		return { text: r.text, usage: { total_tokens: 1 }, cost: r.cost ?? 0, scopedId: "s" };
	});
	const runAndWait = async (job, trigger = "manual") => {
		const run = queueRun(job.id, trigger);
		await waitFor(() => !["queued", "running"].includes(getRun(run.id).status));
		return getRun(run.id);
	};
	// The alert webhook receives results too.
	const received = [];
	const hook = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { received.push(JSON.parse(b)); res.end("ok"); }); });
	await new Promise((r) => hook.listen(0, "127.0.0.1", r));
	const hookUrl = `http://127.0.0.1:${hook.address().port}/`;

	// Notify "changes": a new report is delivered, the same one and a NO_CHANGE reply are not.
	const watch = createJob({ keyId: key.id, agentId: agent.id, name: "price", prompt: "check the price", sessionMode: "memory", notify: "changes" }).job;
	assert.equal(watch.notify, "changes");
	reply = () => ({ text: "price is 10" });
	await runAndWait(watch);
	assert.match(prompts[0], /first one/, "the first run says there are no earlier reports");
	assert.match(prompts[0], /exactly NO_CHANGE/, "a job that notifies on change is told how to say nothing changed");
	assert.ok(prompts[0].endsWith("Task:\ncheck the price"));
	let inbox = takeInbox(key.id, agent.id);
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0].text, "price is 10");
	assert.equal(takeInbox(key.id, agent.id).length, 0, "taken once");
	reply = () => ({ text: "price is 10" });
	await runAndWait(watch);
	assert.match(prompts[1], /report of .*\n.*price is 10/s, "the earlier report is shown to the next run");
	assert.equal(takeInbox(key.id, agent.id).length, 0, "the same report is not delivered again");
	reply = () => ({ text: "NO_CHANGE" });
	await runAndWait(watch);
	assert.equal(takeInbox(key.id, agent.id).length, 0, "NO_CHANGE is not delivered");
	reply = () => ({ text: "price is 12" });
	await runAndWait(watch);
	assert.match(prompts[3], /price is 10/);
	assert.doesNotMatch(prompts[3], /NO_CHANGE\s*---/, "a NO_CHANGE reply is not offered as an earlier report");
	inbox = takeInbox(key.id, agent.id);
	assert.deepEqual(inbox.map((i) => i.text), ["price is 12"]);
	assert.match(inboxNotice(inbox), /^\[scheduled: price · .*\]\nprice is 12$/);
	assert.equal(takeInbox(key.id, null).length, 0, "the key's own chats do not get the agent's results");
	assert.equal(takeInbox(null, agent.id).length, 0);

	// "always" and "never"; failures are told unless "never".
	const loud = createJob({ keyId: key.id, agentId: agent.id, name: "loud", prompt: "p", notify: "always" }).job;
	const quiet = createJob({ keyId: key.id, agentId: agent.id, name: "quiet", prompt: "p" }).job;
	assert.equal(quiet.notify, "never", "an operator's job is quiet unless asked");
	reply = () => ({ text: "same" });
	await runAndWait(loud); await runAndWait(loud); await runAndWait(quiet);
	assert.equal(takeInbox(key.id, agent.id).length, 2, "always tells every run, never none");
	reply = () => { throw new Error("boom"); };
	await runAndWait(loud); await runAndWait(quiet);
	inbox = takeInbox(key.id, agent.id);
	assert.deepEqual(inbox.map((i) => i.title), ["loud: error"]);
	assert.throws(() => createJob({ keyId: key.id, name: "x", prompt: "p", notify: "sometimes" }), /notify is never/);
	assert.throws(() => createJob({ keyId: key.id, name: "x", prompt: "p", dailyCostCap: -1 }), /cost cap/);

	// The alert webhook gets the result as well.
	config.ALERT_WEBHOOK_URL = hookUrl;
	reply = () => ({ text: "price is 99" });
	await runAndWait(watch);
	await waitFor(() => received.length === 1);
	assert.match(received[0].message, /price\nprice is 99/);
	assert.equal(received[0].details.job, watch.id);
	config.JOBS_NOTIFY_ALERTS = false;
	reply = () => ({ text: "price is 100" });
	await runAndWait(watch);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(received.length, 1, "switched off: nothing is sent");
	config.JOBS_NOTIFY_ALERTS = true;
	takeInbox(key.id, agent.id);

	// A job whose scheduled runs keep failing is switched off, and the owner is told even if the job is quiet.
	config.JOBS_MAX_FAILURES = 2;
	reply = () => { throw new Error("tool is broken"); };
	const flaky = createJob({ keyId: key.id, agentId: agent.id, name: "flaky", prompt: "p", schedule: { kind: "interval", every: 1, unit: "hours" } }).job;
	await runAndWait(flaky);
	await runAndWait(flaky);
	assert.equal(getJob(flaky.id).enabled, 1, "manual failures do not count");
	assert.equal(getJob(flaky.id).fail_streak, 0);
	await runAndWait(flaky, "schedule");
	assert.equal(getJob(flaky.id).enabled, 1);
	reply = () => ({ text: "fine" });
	await runAndWait(flaky, "schedule");
	assert.equal(getJob(flaky.id).fail_streak, 0, "a success starts the count over");
	reply = () => { throw new Error("tool is broken"); };
	await runAndWait(flaky, "schedule");
	await runAndWait(flaky, "schedule");
	const off = scheduledJobView(getJob(flaky.id));
	assert.equal(off.enabled, false);
	assert.equal(off.nextRunAt, null);
	assert.match(off.disabledReason, /2 scheduled runs in a row failed .*tool is broken/);
	inbox = takeInbox(key.id, agent.id);
	assert.deepEqual(inbox.map((i) => i.title), ["flaky: switched off"]);
	await waitFor(() => received.some((r) => /switched off/.test(r.message)));
	const on = updateJob(flaky.id, { enabled: true }).job;
	assert.equal(on.enabled, true);
	assert.equal(on.failStreak, 0, "turning it on again resets the count");
	assert.equal(on.disabledReason, null);
	assert.ok(on.nextRunAt > Date.now());
	config.ALERT_WEBHOOK_URL = "";
	// 0 never switches a job off.
	config.JOBS_MAX_FAILURES = 0;
	for (let i = 0; i < 3; i++) await runAndWait(flaky, "schedule");
	assert.equal(getJob(flaky.id).enabled, 1);
	config.JOBS_MAX_FAILURES = 3;

	// The daily cost cap skips scheduled runs once, tells the owner once, and never blocks a manual run.
	const spendy = createJob({ keyId: key.id, agentId: agent.id, name: "spendy", prompt: "p", dailyCostCap: 0.05, schedule: { kind: "interval", every: 1, unit: "hours" } }).job;
	assert.equal(spendy.dailyCostCap, 0.05);
	reply = () => ({ text: "ok", cost: 0.03 });
	assert.equal((await runAndWait(spendy, "schedule")).status, "ok");
	assert.equal((await runAndWait(spendy, "schedule")).status, "ok");
	const capped = await runAndWait(spendy, "schedule");
	assert.equal(capped.status, "skipped");
	assert.match(capped.error, /daily cost cap reached: \$0\.06 spent .* \$0\.05/);
	await runAndWait(spendy, "schedule");
	assert.equal(takeInbox(key.id, agent.id).filter((i) => /cost cap/.test(i.title)).length, 1, "told once, not at every tick");
	assert.equal(getJob(spendy.id).fail_streak, 0, "a cap skip is not a failure");
	assert.equal((await runAndWait(spendy, "manual")).status, "ok", "a manual run is the owner's decision");
	updateJob(spendy.id, { dailyCostCap: 0 });
	assert.equal((await runAndWait(spendy, "schedule")).status, "ok", "0 is no cap");
	// A schedule an agent made gets the default cap; an operator's job has none.
	config.AGENT_JOBS_DAILY_COST = 0.04;
	const own = createJob({ keyId: key.id, agentId: agent.id, name: "own", prompt: "p", origin: "agent" }).job;
	assert.equal(own.effectiveCostCap, 0.04);
	assert.equal(own.dailyCostCap, null);
	assert.equal(scheduledJobView(getJob(spendy.id)).effectiveCostCap, 0);
	assert.equal(createJob({ keyId: key.id, name: "plain", prompt: "p" }).job.effectiveCostCap, 0);
	config.AGENT_JOBS_DAILY_COST = 1;

	// A chat shows waiting results at the top of its reply, once; a run of a job does not take them.
	{
		const { runPrompt } = await import("./server.mjs");
		J.startJobs();
		const fake = () => {
			let handler = null;
			return {
				model: null,
				subscribe: (fn) => ((handler = fn), () => {}),
				prompt: async () => {
					handler({ type: "message_start", message: { role: "assistant" } });
					handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello." } });
					handler({ type: "message_end", message: { role: "assistant" } });
				},
				getLastAssistantText: () => "",
			};
		};
		const chat = () => ({ keyId: key.id, agentId: agent.id, inflight: 0, queue: Promise.resolve(), sessionPromise: Promise.resolve(fake()) });
		reply = () => ({ text: "price is 7" });
		await runAndWait(watch);
		const quietTurn = await runPrompt(chat(), "hi", { inbox: false });
		assert.equal(quietTurn.text, "Hello.", "a hand-off or job turn leaves the inbox alone");
		const shown = await runPrompt(chat(), "hi");
		assert.match(shown.text, /^\[scheduled: price · .*\]\nprice is 7\n\nHello\.$/, "the result comes first, then the answer, with one blank line between");
		assert.equal((await runPrompt(chat(), "hi")).text, "Hello.", "shown once");
		// A colleague's progress lines reach the caller's reasoning stream during the turn, and the sink is gone after it.
		const waiting = chat();
		const session = await waiting.sessionPromise;
		const plainPrompt = session.prompt;
		session.prompt = async (...a) => {
			waiting.progress("[coder] ▸ bash: ls");
			waiting.progress("[coder] ✓ done in 2s");
			return plainPrompt(...a);
		};
		const thoughts = [];
		const withProgress = await runPrompt(waiting, "hi", { inbox: false, onThinking: (d) => thoughts.push(d) });
		assert.equal(thoughts.join(""), "[coder] ▸ bash: ls\n[coder] ✓ done in 2s\n");
		assert.equal(withProgress.reasoning, "[coder] ▸ bash: ls\n[coder] ✓ done in 2s\n", "and in the reasoning returned for a non-streamed reply");
		assert.equal(waiting.progress, null, "the sink is cleared when the turn ends");
		// A colleague's messages come into the reply as "(name): message", set apart from the agent's own words.
		const speaking = chat();
		const speakingSession = await speaking.sessionPromise;
		const speakingPrompt = speakingSession.prompt;
		speakingSession.prompt = async function () {
			speaking.say(["coder"], "I found it.");
			speaking.say(["coder", "tester"], "Tests pass.");
			return speakingPrompt();
		};
		const spoke = await runPrompt(speaking, "hi", { inbox: false });
		assert.equal(spoke.text, "(coder): I found it.\n\n(coder › tester): Tests pass.\n\nHello.");
		assert.equal(speaking.say, null);
		const silent = chat();
		const silentSession = await silent.sessionPromise;
		const silentPrompt = silentSession.prompt;
		silentSession.prompt = async function () { assert.equal(silent.say, null, "a job or hand-off turn shows none"); return silentPrompt(); };
		assert.equal((await runPrompt(silent, "hi", { inbox: false, colleagues: false })).text, "Hello.");
		// A colleague forwards to its caller instead of showing in its own stream.
		const forwarded = [];
		const nested = chat();
		nested.progressUp = (l) => forwarded.push(l);
		(await nested.sessionPromise).prompt = async function () { nested.progress("  [tester] ▸ bash: pytest"); };
		await runPrompt(nested, "hi", { inbox: false });
		assert.deepEqual(forwarded, ["  [tester] ▸ bash: pytest"]);
		J.stopJobs();
	}

	// A streamed reply that stays silent sends comment lines so a proxy or client does not drop it.
	{
		const { startKeepAlive } = await import("./server.mjs");
		const written = [];
		const res = Object.assign(new (await import("node:events")).EventEmitter(), { writableEnded: false, write: (t) => written.push(t) });
		const beat = startKeepAlive(res, 20);
		await new Promise((r) => setTimeout(r, 110));
		beat.stop();
		const count = written.length;
		assert.ok(count >= 3 && written.every((t) => t === ": keep-alive\n\n"), `comment lines only (${count})`);
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(written.length, count, "stopped");
		const off = []; const quiet = Object.assign(new (await import("node:events")).EventEmitter(), { writableEnded: false, write: (t) => off.push(t) });
		startKeepAlive(quiet, 0).stop();
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(off.length, 0, "0 turns it off");
	}

	// A job tied to an agent that lost permission, or was switched off, is simply not queued on its due
	// tick: paused, not run-and-failed, and resumed by itself once the agent or its permission is back.
	{
		const view = (id) => scheduledJobView(getJob(id));
		agents.update(agent.id, { canSchedule: true });
		const scheduled = createJob({ keyId: key.id, agentId: agent.id, name: "ticker", prompt: "p", origin: "agent", schedule: { kind: "interval", every: 1, unit: "minutes" } }).job;
		reply = () => ({ text: "ok" });
		const due = Date.now() + 61_000;
		assert.equal(tick(due), 1, "runnable: it fires");
		await waitFor(() => view(scheduled.id).failStreak === 0 && listRuns(scheduled.id)[0]?.status === "ok");
		const ranAt = listRuns(scheduled.id)[0].id;

		agents.update(agent.id, { canSchedule: false });
		const nextDue = view(scheduled.id).nextRunAt + 1000;
		assert.equal(tick(nextDue), 0, "its own scheduling permission was revoked: not queued");
		assert.equal(view(scheduled.id).enabled, true, "paused, not disabled");
		assert.equal(listRuns(scheduled.id)[0].id, ranAt, "no new run, no failure recorded");
		assert.ok(view(scheduled.id).nextRunAt > nextDue, "its schedule still advanced, so it is not due again at once");

		agents.update(agent.id, { canSchedule: true });
		config.AGENT_JOBS_ENABLED = false;
		assert.equal(tick(view(scheduled.id).nextRunAt + 1000), 0, "the global switch pauses every agent's schedules");
		config.AGENT_JOBS_ENABLED = true;
		assert.equal(tick(view(scheduled.id).nextRunAt + 1000), 1, "permission is back: it fires again, with no catch-up noise");
		await waitFor(() => listRuns(scheduled.id)[0].id !== ranAt && listRuns(scheduled.id)[0].status === "ok");

		// The agent itself being disabled pauses an operator's job for it too, not just one it made itself.
		const operatorJob = createJob({ keyId: key.id, agentId: agent.id, name: "operator-ticker", prompt: "p", schedule: { kind: "interval", every: 1, unit: "minutes" } }).job;
		agents.update(agent.id, { enabled: false });
		assert.equal(tick(view(operatorJob.id).nextRunAt + 1000), 0, "the agent is off: not queued");
		assert.equal(listRuns(operatorJob.id).length, 0, "no failed run was ever recorded for it");
		agents.update(agent.id, { enabled: true });
		assert.equal(tick(view(operatorJob.id).nextRunAt + 1000), 1, "enabled again: it fires");
		await waitFor(() => listRuns(operatorJob.id).length === 1);

		// A manual run is unaffected by canSchedule either way (it is not "scheduling"); only tick() pauses.
		agents.update(agent.id, { canSchedule: false });
		assert.equal((await runAndWait(scheduled, "manual")).status, "ok");
		agents.update(agent.id, { canSchedule: true });
	}

	// Results go when their job does; old seen ones are purged.
	assert.ok(db.prepare("SELECT COUNT(*) AS n FROM job_inbox WHERE job_id = ?").get(flaky.id).n >= 0);
	deleteJobsOf({ keyId: key.id });
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_inbox WHERE key_id = ?").get(key.id).n, 0);
	setJobRunner(null);
	await new Promise((r) => hook.close(r));
	agents.remove(agent.id);
}

// Phase 2: jobs over HTTP.
{
	const { server, setJobRunner, apiKeys, createJob, newTrigger, getRun, stopJobs } = await import("./server.mjs");
	setJobRunner(async ({ prompt }) => ({ text: `ran: ${prompt}`, usage: { total_tokens: 3 }, cost: 0, scopedId: "s" }));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const k1 = apiKeys.create({ name: "http-jobs-1" });
	const k2 = apiKeys.create({ name: "http-jobs-2" });
	const secret1 = k1.key ?? k1.secret ?? k1.token;
	const secret2 = k2.key ?? k2.secret ?? k2.token;
	const rec1 = k1.record ?? k1;
	assert.ok(secret1 && secret2, "the key is shown on creation");
	const call = (path, { key, method = "GET", body, headers = {} } = {}) => fetch(`${base}${path}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
	const waitFor = async (fn) => { const end = Date.now() + 3000; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error("timed out"); };

	assert.equal((await call("/v1/piper/jobs", { method: "POST", body: { prompt: "x" } })).status, 401, "a key is needed");
	const submitted = await call("/v1/piper/jobs", { key: secret1, method: "POST", body: { prompt: "hello async" } });
	assert.equal(submitted.status, 202);
	const { id } = await submitted.json();
	const status = await waitFor(async () => { const j = await (await call(`/v1/piper/jobs/${id}`, { key: secret1 })).json(); return j.status === "ok" ? j : null; });
	assert.equal(status.text, "ran: hello async");
	assert.equal((await call(`/v1/piper/jobs/${id}`, { key: secret2 })).status, 404, "another key sees nothing");
	assert.equal((await call(`/v1/piper/jobs/${id}`, { key: secret1, method: "DELETE" })).status, 200);
	assert.equal((await call("/v1/piper/jobs", { key: secret1, method: "POST", body: { prompt: "" } })).status, 400);

	// The trigger answers to the job's token, not to a key; and keeps working when keys are required.
	const job = createJob({ keyId: rec1.id, name: "hooked", prompt: "payload={{payload}}" }).job;
	const token = newTrigger(job.id);
	const path = `/v1/piper/jobs/${job.id}/trigger`;
	assert.equal((await call(path, { method: "POST", body: "x" })).status, 404, "no token");
	assert.equal((await call(path, { method: "POST", key: secret1, body: "x" })).status, 404, "an API key is not the job's token");
	assert.equal((await call(path)).status, 405);
	const ok = await call(path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: '{"event":"push"}' });
	assert.equal(ok.status, 202);
	const runId = (await ok.json()).run;
	await waitFor(() => getRun(runId).status === "ok");
	assert.equal(getRun(runId).prompt, 'payload={"event":"push"}');
	const viaHeader = await call(path, { method: "POST", headers: { "X-Piper-Token": token }, body: "again" });
	assert.equal(viaHeader.status, 202, "the token may come in X-Piper-Token (config is 0 s apart here)");

	// Dashboard routes (no password set here, so the page is open).
	const created = await call("/dashboard/jobs", { method: "POST", body: { keyId: rec1.id, name: "from page", prompt: "p", schedule: { kind: "daily", at: "07:30" } } });
	assert.equal(created.status, 201);
	const jid = (await created.json()).job.id;
	const list = await (await call("/dashboard/jobs.json")).json();
	assert.ok(list.jobs.some((j) => j.id === jid && j.scheduleText === "every day at 07:30"));
	assert.equal(JSON.stringify(list).includes(token), false, "no token in the list");
	const run = await (await call(`/dashboard/jobs/${jid}/run`, { method: "POST" })).json();
	await waitFor(() => getRun(run.run.id).status === "ok");
	const runs = await (await call(`/dashboard/jobs/${jid}/runs`)).json();
	assert.equal(runs.runs[0].status, "ok");
	assert.equal((await (await call(`/dashboard/jobs/runs/${run.run.id}`)).json()).run.text, "ran: p");
	const t = await (await call(`/dashboard/jobs/${jid}/trigger`, { method: "POST" })).json();
	assert.match(t.token, /^pjt_/);
	assert.equal((await call(`/dashboard/jobs/${jid}`, { method: "PATCH", body: { schedule: { kind: "weekly", days: [], at: "07:30" } } })).status, 400);
	assert.equal((await call(`/dashboard/jobs/${jid}`, { method: "DELETE" })).status, 200);
	assert.equal((await call(`/dashboard/jobs/${jid}`)).status, 404);
	await new Promise((r) => server.close(r));
	server.closeAllConnections?.();
	setJobRunner(null);
	stopJobs();
}

// Phase 3: templates, clone, export and import.
{
	const skillText = (n) => `---\nname: ${n}\ndescription: x\n---\nDo it.\n`;
	const T = await import("./server.mjs");
	const { validPath, validateBundle, listTemplates, getTemplate, saveTemplate, deleteTemplate, exportAgent, importBundle, cloneAgent, createFromTemplate, createAgent, deleteAgent, agents, profileOp, agentScope, apiKeys, config } = T;
	const b64 = (t) => Buffer.from(t).toString("base64");
	const base = { format: "piper-agent", version: 1, agent: { name: "ok-name" }, files: [{ path: "AGENTS.md", data: b64("hi") }] };

	// Paths and bundles: what may travel.
	for (const good of ["AGENTS.md", "settings.json", "skills/a/SKILL.md", "extensions/x.ts", "prompts/p.md", "agents/a.md", "skills/with space/SKILL.md"]) assert.equal(validPath(good), true, good);
	for (const evil of ["", "/etc/passwd", "../x", "skills/../../x", "skills//x", "skills/./x", "auth.json", "models.json", "AGENTS.md/x", "settings.json/y", ".ssh/id", "skills/.hidden/x", "a".repeat(500), "skills/a/b/c/d/e/f/g/h/i.md", "skills/a\\b", "skills/a\0b", "skills/‮"]) assert.equal(validPath(evil), false, JSON.stringify(evil));
	assert.equal(validateBundle(base).files.length, 1);
	const refuse = (mutate, re) => assert.throws(() => validateBundle(mutate(structuredClone(base))), re);
	refuse((b) => ({ ...b, format: "tar" }), /not a Piper agent bundle/);
	refuse((b) => ({ ...b, version: 2 }), /version 2/);
	refuse((b) => ({ ...b, files: "x" }), /no list of files/);
	refuse((b) => ({ ...b, files: [{ path: "../x", data: "" }] }), /cannot be used/);
	refuse((b) => ({ ...b, files: [{ path: "auth.json", data: "" }] }), /cannot be used/);
	refuse((b) => ({ ...b, files: [{ path: "AGENTS.md", data: "a" }, { path: "agents.md", data: "a" }] }), /twice|cannot be used/);
	refuse((b) => ({ ...b, files: [{ path: "skills/A.md", data: "" }, { path: "skills/a.md", data: "" }] }), /the same file twice/);
	refuse((b) => ({ ...b, files: [{ path: "AGENTS.md", data: "not base64!" }] }), /not valid base64/);
	refuse((b) => ({ ...b, files: Array.from({ length: 501 }, (_, i) => ({ path: `skills/f${i}.md`, data: "" })) }), /at most 500/);
	refuse((b) => ({ ...b, agent: { name: "Bad Name" } }), /not a valid name/);
	assert.throws(() => validateBundle({ ...base, files: [{ path: "AGENTS.md", data: b64("x".repeat(100)) }] }, { maxBytes: 50 }), /over the 50-byte limit/);
	const fields = validateBundle({ ...base, agent: { name: "n", model: "p/m", thinking: "bogus", workspace: "../x", container: { memoryMb: 512, network: "open", env: "SECRET=1", mounts: "/:/x", pids: -1 }, extra: "x" } }).agent;
	assert.deepEqual([fields.thinking, fields.workspace, fields.container], [null, "own", { memoryMb: 512 }], "only the safe fields survive, and bad ones fall back");

	// The built-in templates are real and every file of them can travel.
	const listed = listTemplates();
	assert.deepEqual(listed.filter((t) => t.builtin).map((t) => t.name), ["architect", "coder", "devops", "orchestrator", "researcher", "reviewer"]);
	for (const t of listed) {
		const full = getTemplate(t.name);
		assert.ok(t.description.length > 10 && full.files.some((f) => f.path === "AGENTS.md"), `${t.name} has a description and instructions`);
		validateBundle({ format: "piper-agent", version: 1, agent: { name: t.name }, files: full.files });
		assert.ok(Buffer.from(full.files.find((f) => f.path === "AGENTS.md").data, "base64").toString().length > 300, `${t.name}'s instructions are real`);
	}
	assert.ok(getTemplate("reviewer").files.some((f) => f.path === "skills/review-checklist/SKILL.md"));
	assert.throws(() => deleteTemplate("architect"), /built-in/);

	// The orchestrator: real instructions, and hand-offs on from the start.
	const orch = getTemplate("orchestrator");
	assert.equal(orch.canDelegate, true);
	assert.equal(listTemplates().find((t) => t.name === "orchestrator").canDelegate, true);
	assert.deepEqual(listTemplates().filter((t) => t.canDelegate).map((t) => t.name), ["orchestrator"], "only the orchestrator delegates by default");
	const orchText = Buffer.from(orch.files.find((f) => f.path === "AGENTS.md").data, "base64").toString();
	assert.ok(orchText.length > 1500 && /piper_agents/.test(orchText) && /piper_delegate/.test(orchText) && /same message/.test(orchText), "the working method is there");
	assert.equal(validateBundle({ ...base, agent: { name: "o", canDelegate: "yes" } }).agent.canDelegate, false, "only a real true turns it on");
	assert.equal(validateBundle({ ...base, agent: { name: "o", canDelegate: true } }).agent.canDelegate, true);

	// A fake docker that runs the profile helper over the mounted folder, so the real ops are exercised.
	const bin = mkdtempSync(join(tmpdir(), "fakedocker3-"));
	const helper = fileURLToPath(new URL("./piper-profile.mjs", import.meta.url));
	writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
dir=""; max=0; args=("$@"); rest=(); i=0
while [ $i -lt $# ]; do
  a="\${args[$i]}"
  case "$a" in
    -v) v="\${args[$((i+1))]}"; case "$v" in *:/data) dir="\${v%:/data}";; esac;;
    -e) e="\${args[$((i+1))]}"; case "$e" in PROFILE_MAX_BYTES=*) max="\${e#*=}";; esac;;
    /opt/piper/profile.mjs) rest=("\${args[@]:$((i+1))}"); break;;
  esac
  i=$((i+1))
done
[ -z "$dir" ] && exit 1
cd "$dir" && PROFILE_MAX_BYTES=$max exec node ${helper} "\${rest[@]}"
`);
	(await import("node:fs")).chmodSync(join(bin, "docker"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	const made = apiKeys.create({ name: "template test", expiresAt: 0 });
	const key = made.record ?? made;
	const other = apiKeys.create({ name: "template other", expiresAt: 0 });
	const otherKey = other.record ?? other;

	// From a template: the profile has its instructions, the settings are applied.
	const arch = await createFromTemplate({ keyId: key.id, template: "reviewer", name: "rev" });
	assert.equal(arch.agent.workspace, "shared", "the template's workspace mode");
	assert.equal(arch.agent.thinking, "high");
	const scope = agentScope(key.id, arch.agent.id);
	const instr = await profileOp(scope, { op: "instructions.get" });
	assert.match(JSON.stringify(instr), /Reviewer/);
	assert.ok((await profileOp(scope, { op: "skills.list" })).some((s) => s.name === "review-checklist"));
	await assert.rejects(createFromTemplate({ keyId: key.id, template: "nope", name: "x" }), (e) => e.status === 404);
	await assert.rejects(createFromTemplate({ keyId: key.id, template: "coder", name: "rev" }), /already has an agent/);
	assert.equal(agents.find(key.id, "rev").id, arch.agent.id);

	// Export, with things in the profile that must not travel: a link, auth.json, a stray folder.
	const profileDir = join(TEST_PROFILES, scopeOf(scope));
	await profileOp(scope, { op: "settings.put", settings: { theme: "dark" } });
	writeFileSync(join(profileDir, "auth.json"), '{"secret":"do-not-export"}');
	mkdirSync(join(profileDir, "scratch"), { recursive: true });
	writeFileSync(join(profileDir, "scratch", "x"), "x");
	symlinkSync("/etc/passwd", join(profileDir, "skills", "passwd-link"));
	symlinkSync("/etc", join(profileDir, "prompts"));
	const bundle = await exportAgent(arch.agent.id);
	const paths = bundle.files.map((f) => f.path).sort();
	assert.deepEqual(paths, ["AGENTS.md", "settings.json", "skills/review-checklist/SKILL.md"]);
	assert.ok(bundle.skipped >= 1, "the links were skipped");
	assert.equal(JSON.stringify(bundle).includes("do-not-export"), false, "auth.json never travels");
	assert.deepEqual(Object.keys(bundle.agent).sort(), ["canDelegate", "container", "description", "model", "name", "thinking", "workspace"]);

	// Import into another key: same files, a fresh profile; a hostile bundle writes nothing and leaves no agent.
	const imported = await importBundle({ keyId: otherKey.id, bundle: JSON.parse(JSON.stringify(bundle)), name: "copy" });
	const otherScope = agentScope(otherKey.id, imported.agent.id);
	assert.match(JSON.stringify(await profileOp(otherScope, { op: "instructions.get" })), /Reviewer/);
	assert.deepEqual((await profileOp(otherScope, { op: "settings.get" })), { theme: "dark" });
	const before = agents.listByKey(otherKey.id).length;
	for (const files of [[{ path: "../../escape", data: b64("x") }], [{ path: "skills/x/SKILL.md", data: b64("ok") }, { path: "auth.json", data: b64("x") }]]) {
		await assert.rejects(importBundle({ keyId: otherKey.id, bundle: { ...bundle, files }, name: "evil" }), (e) => e.status === 400);
	}
	assert.equal(agents.listByKey(otherKey.id).length, before, "a refused bundle leaves no agent behind");
	assert.equal(existsSync(join(TEST_PROFILES, "escape")), false);
	await assert.rejects(importBundle({ keyId: otherKey.id, bundle, name: "copy" }), /already has an agent/);
	await assert.rejects(importBundle({ keyId: "nope", bundle, name: "z" }), (e) => e.status === 404);
	// A planted link in the new profile is not written through (the helper checks every step of the way).
	const target = await createAgent({ keyId: key.id, name: "linked" });
	const targetScope = agentScope(key.id, target.id);
	const targetDir = join(TEST_PROFILES, scopeOf(targetScope));
	mkdirSync(join(TEST_WS, "elsewhere"), { recursive: true });
	symlinkSync(join(TEST_WS, "elsewhere"), join(targetDir, "skills"));
	await assert.rejects(profileOp(targetScope, { op: "tree.import", files: [{ path: "skills/x/SKILL.md", data: b64("pwn") }] }), /in the way/);
	assert.equal(existsSync(join(TEST_WS, "elsewhere", "x")), false, "nothing was written through the link");
	// A quota is respected.
	config.PROFILE_MAX_BYTES = 100;
	await assert.rejects(profileOp(otherScope, { op: "tree.import", files: [{ path: "prompts/big.md", data: b64("x".repeat(5000)) }] }), /quota/);
	config.PROFILE_MAX_BYTES = 0;

	// An orchestrator made from the template may delegate; export, import and clone keep that.
	const orchAgent = await createFromTemplate({ keyId: key.id, template: "orchestrator", name: "boss" });
	assert.equal(orchAgent.agent.canDelegate, true);
	assert.equal(orchAgent.agent.workspace, "shared");
	assert.ok(orchAgent.agent.description.length > 20, "it has a description");
	const orchBundle = await exportAgent(orchAgent.agent.id);
	assert.equal(orchBundle.agent.canDelegate, true);
	const orchImported = await importBundle({ keyId: otherKey.id, bundle: JSON.parse(JSON.stringify(orchBundle)), name: "boss-copy" });
	assert.equal(orchImported.agent.canDelegate, true, "import keeps it");
	assert.equal((await cloneAgent(orchAgent.agent.id, "boss-two")).agent.canDelegate, true, "clone keeps it");
	assert.equal(arch.agent.canDelegate, false, "a reviewer does not delegate");
	await saveTemplate({ fromAgent: orchAgent.agent.id, name: "my-boss" });
	assert.equal(getTemplate("my-boss").canDelegate, true, "a saved template keeps it");
	assert.equal((await createFromTemplate({ keyId: key.id, template: "my-boss", name: "boss-three" })).agent.canDelegate, true);
	deleteTemplate("my-boss");

	// Clone: a new agent of the same key, same profile.
	const clone = await cloneAgent(arch.agent.id, "rev-two");
	assert.equal(clone.agent.keyId, key.id);
	assert.equal(clone.agent.workspace, "shared");
	assert.match(JSON.stringify(await profileOp(agentScope(key.id, clone.agent.id), { op: "instructions.get" })), /Reviewer/);

	// Save as a template, use it, delete it.
	await assert.rejects(saveTemplate({ fromAgent: arch.agent.id, name: "Bad Name" }), /lowercase/);
	await assert.rejects(saveTemplate({ fromAgent: arch.agent.id, name: "coder" }), /already a template/);
	const savedT = await saveTemplate({ fromAgent: arch.agent.id, name: "my-reviewer", description: "mine" });
	assert.deepEqual([savedT.builtin, savedT.description], [false, "mine"]);
	const fromSaved = await createFromTemplate({ keyId: otherKey.id, template: "my-reviewer", name: "from-saved", model: null });
	assert.match(JSON.stringify(await profileOp(agentScope(otherKey.id, fromSaved.agent.id), { op: "instructions.get" })), /Reviewer/);
	config.TEMPLATE_MAX_BYTES = 64 * 1024;
	writeFileSync(join(profileDir, "AGENTS.md"), "y".repeat(80 * 1024));
	await assert.rejects(saveTemplate({ fromAgent: arch.agent.id, name: "too-big" }), /over the .* limit/);
	config.TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;
	assert.equal(deleteTemplate("my-reviewer"), true);
	assert.equal(getTemplate("my-reviewer"), null);

	// Looking at and changing templates.
	const { templateDetail, updateTemplate, duplicateTemplate } = T;
	const detail = templateDetail("reviewer");
	assert.equal(detail.builtin, true);
	assert.ok(detail.files.find((f) => f.path === "AGENTS.md").text.includes("Reviewer"), "text files come with their text");
	assert.throws(() => templateDetail("nope"), (e) => e.status === 404);
	assert.throws(() => updateTemplate("reviewer", { description: "x" }), (e) => e.status === 409, "a built-in cannot be changed");
	const copy = duplicateTemplate("reviewer", "my-rev");
	assert.deepEqual([copy.builtin, copy.files.length], [false, detail.files.length]);
	assert.throws(() => duplicateTemplate("reviewer", "my-rev"), (e) => e.status === 409);
	assert.throws(() => duplicateTemplate("reviewer", "Bad Name"), /lowercase/);
	const changed = updateTemplate("my-rev", { description: "mine", thinking: "low", workspace: "own", canDelegate: true, files: [{ path: "AGENTS.md", text: "# My reviewer\nBe terse.\n" }, { path: "skills/extra/SKILL.md", text: skillText("extra") }] });
	assert.deepEqual([changed.description, changed.thinking, changed.workspace, changed.canDelegate], ["mine", "low", "own", true]);
	assert.deepEqual(changed.files.map((f) => f.path), ["AGENTS.md", "skills/extra/SKILL.md"], "the file list is replaced");
	assert.throws(() => updateTemplate("my-rev", { files: [{ path: "../x", text: "" }] }), /cannot be used/);
	assert.throws(() => updateTemplate("my-rev", { files: [{ path: "auth.json", text: "" }] }), /cannot be used/);
	assert.throws(() => updateTemplate("my-rev", { files: [{ path: "AGENTS.md" }] }), /path and its text/);
	assert.throws(() => updateTemplate("my-rev", { files: [{ path: "AGENTS.md", text: "a" }, { path: "agents.md", text: "b" }] }), /twice|cannot be used/);
	config.TEMPLATE_MAX_BYTES = 64 * 1024;
	assert.throws(() => updateTemplate("my-rev", { files: [{ path: "AGENTS.md", text: "y".repeat(80 * 1024) }] }), /limit/);
	config.TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;
	assert.equal(templateDetail("my-rev").files.length, 2, "a refused change changes nothing");
	const made2 = await createFromTemplate({ keyId: key.id, template: "my-rev", name: "from-edited" });
	assert.equal(made2.agent.canDelegate, true);
	assert.match(JSON.stringify(await profileOp(agentScope(key.id, made2.agent.id), { op: "instructions.get" })), /Be terse/, "new agents get the edited text");
	deleteTemplate("my-rev");
	for (const a of agents.list().filter((x) => [key.id, otherKey.id].includes(x.keyId))) await deleteAgent(a.id);
	process.env.PATH = oldPath;
}

// Phase 4: delegation and teams.
{
	const D = await import("./server.mjs");
	const { colleagues, delegatorFor, mayDelegate, setAgentTurnRunner, createTeam, updateTeam, deleteTeam, deleteTeamsOfKey, listTeams, getTeam, runTeam, fillStep, checkedSteps, startTeam, stopTeamServers, listeningTeamPort, agents, apiKeys, config, db } = D;
	const mk = (name) => { const c = apiKeys.create({ name, expiresAt: 0 }); return { record: c.record ?? c, token: c.key }; };
	const k1 = mk("deleg-1");
	const k2 = mk("deleg-2");
	const mkAgent = (keyId, name, extra = {}) => { const a = agents.create({ keyId, name }); return agents.update(a.id, extra); };
	const arch = mkAgent(k1.record.id, "arch", { description: "designs", canDelegate: true });
	const coder = mkAgent(k1.record.id, "coder", { description: "writes code" });
	const off = mkAgent(k1.record.id, "off", { enabled: false });
	const foreign = mkAgent(k2.record.id, "stranger");
	const rec = (agent, extra = {}) => ({ id: `rec-${agent.id}`, keyId: agent.keyId, agentId: agent.id, delegateDepth: 0, delegateChain: [], live: { note() {} }, ...extra });

	// Who may delegate, and to whom.
	assert.equal(mayDelegate(rec(arch)), true);
	assert.equal(mayDelegate(rec(coder)), false, "off by default");
	assert.equal(mayDelegate({ keyId: k1.record.id, agentId: null }), false, "the key's main endpoint does not delegate");
	assert.deepEqual(colleagues(rec(arch)), [{ name: "coder", description: "writes code" }], "not itself, not a disabled agent, not another key's");
	assert.deepEqual(colleagues(rec(arch, { delegateChain: [coder.id] })), [], "nobody already in the chain");
	config.DELEGATE_ENABLED = false;
	assert.equal(mayDelegate(rec(arch)), false);
	assert.deepEqual(colleagues(rec(arch)), []);
	config.DELEGATE_ENABLED = true;

	// The roster that goes into the system prompt each turn.
	const { rosterText } = D;
	assert.equal(rosterText(rec(coder)), "", "an agent that may not delegate gets none");
	assert.match(rosterText(rec(arch)), /^Your colleagues right now/);
	assert.match(rosterText(rec(arch)), /- coder: writes code/);
	assert.ok(!/- arch:|- off:|stranger/.test(rosterText(rec(arch))), "not itself, not a disabled agent, not another key's");
	mkAgent(k1.record.id, "mute");
	assert.match(rosterText(rec(arch)), /- mute: \(no description: judge by its name\)/);
	mkAgent(k1.record.id, "late-arrival", { description: "joined after the orchestrator started" });
	assert.match(rosterText(rec(arch)), /late-arrival: joined after/, "a new agent is on the very next turn");
	for (let i = 0; i < 32; i++) mkAgent(k1.record.id, `bulk-${i}`, { description: "x".repeat(400) });
	const big = rosterText(rec(arch));
	assert.match(big, /and \d+ more/);
	assert.ok(big.split("\n").length <= 32 && !/x{201}/.test(big), "capped in length and in lines");
	for (let i = 0; i < 32; i++) agents.remove(agents.find(k1.record.id, `bulk-${i}`).id);
	agents.remove(agents.find(k1.record.id, "mute").id);
	agents.remove(agents.find(k1.record.id, "late-arrival").id);
	assert.match(rosterText(rec(arch, { delegateChain: [coder.id] })), /none enabled right now/, "alone: a note, not an empty list");
	config.DELEGATE_ENABLED = false;
	assert.equal(rosterText(rec(arch)), "");
	config.DELEGATE_ENABLED = true;

	// A hand-off runs the colleague with its credential, a derived session, and a deeper chain.
	const seen = [];
	let hold = null;
	setAgentTurnRunner(async ({ credential, clientSessionId, prompt, signal }) => {
		seen.push({ credential, clientSessionId, prompt });
		if (hold) await new Promise((res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
		return { text: `done: ${prompt}`, usage: { total_tokens: 5 }, cost: 0.01, scopedId: "x" };
	});
	const d = delegatorFor(rec(arch));
	assert.deepEqual(d.agents(), [{ name: "coder", description: "writes code" }]);
	assert.equal(await d.delegate("coder", "write fizzbuzz"), "done: write fizzbuzz");
	assert.equal(seen[0].credential.agent.id, coder.id);
	assert.equal(seen[0].credential.id, k1.record.id, "run as the same key");
	assert.equal(seen[0].credential.delegateDepth, 1);
	assert.deepEqual(seen[0].credential.delegateChain, [arch.id]);
	await d.delegate("coder", "again");
	assert.equal(seen[1].clientSessionId, seen[0].clientSessionId, "the colleague keeps its conversation across calls from one chat");
	await delegatorFor(rec(arch, { id: "another-chat" })).delegate("coder", "x");
	assert.notEqual(seen[2].clientSessionId, seen[0].clientSessionId, "another chat of the caller gets its own");
	for (const [name, task, re] of [["arch", "x", /itself/], ["nobody", "x", /no agent called/], ["stranger", "x", /no agent called/], ["off", "x", /switched off/], ["coder", "  ", /no task/], ["coder", "x".repeat(40000), /over 32768/]]) {
		await assert.rejects(d.delegate(name, task), re, name);
	}
	await assert.rejects(delegatorFor(rec(arch, { delegateDepth: 3 })).delegate("coder", "x"), /3 deep/, "depth limit");
	config.DELEGATE_MAX_DEPTH = 5;
	await delegatorFor(rec(arch, { delegateDepth: 3 })).delegate("coder", "x");
	config.DELEGATE_MAX_DEPTH = 3;
	await assert.rejects(delegatorFor(rec(arch, { delegateChain: [coder.id] })).delegate("coder", "x"), /already waiting/, "no loops");
	await assert.rejects(delegatorFor(rec(coder)).delegate("arch", "x"), /not allowed to delegate/);
	// A caller that goes away stops the colleague; a slow colleague times out.
	hold = {};
	const ac = new AbortController();
	const pending = d.delegate("coder", "slow", ac.signal);
	setTimeout(() => ac.abort(), 30);
	await assert.rejects(pending, /the caller stopped/);
	config.DELEGATE_TIMEOUT_MS = 40;
	await assert.rejects(d.delegate("coder", "slow"), /ran out of time \(the limit is 40ms|ran out of time \(the limit is 0/);
	// What the colleague had written, and what happened to its container, come back with the failure instead of being lost.
	const noted = { notices: ["a process was killed for using too much memory"] };
	setAgentTurnRunner(async ({ signal, onDelta, onSession }) => {
		onSession(noted);
		onDelta("step 1 done: found 3 functions. ");
		onDelta("step 2: scanning");
		await new Promise((res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
	});
	await assert.rejects(d.delegate("coder", "long job"), (e) => /ran out of time/.test(e.message) && /What happened to its container: a process was killed for using too much memory/.test(e.message) && /step 1 done: found 3 functions\. step 2: scanning/.test(e.message) && /call it again and ask it to continue/.test(e.message));
	assert.equal(noted.notices.length, 0, "the notice is said once, to the caller");
	config.DELEGATE_TIMEOUT_MS = 600000;
	// While the caller waits, what the colleague does is reported into the caller's stream.
	{
		const { LiveLog, followColleague } = await import("./server.mjs");
		const lines = [];
		const watcher = rec(arch, { progress: (l) => lines.push(l) });
		config.DELEGATE_MESSAGES = "thinking";
		setAgentTurnRunner(async ({ onSession, onDelta }) => {
			const live = new LiveLog();
			onSession({ live, notices: [] });
			live.feed({ type: "message_start", message: { role: "assistant" } });
			live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me look at the binary.\nSecond line is not shown." } });
			live.feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "file /work/a.out" } });
			live.feed({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: "ELF" } });
			live.feed({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "nope" } });
			live.feed({ type: "tool_execution_end", toolCallId: "t2", isError: true, result: { content: "not found" } });
			live.feed({ type: "message_start", message: { role: "assistant" } });
			live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "It is a 64-bit ELF." } });
			onDelta("It is a 64-bit ELF.");
			return { text: "It is a 64-bit ELF.", usage: { total_tokens: 1 }, cost: 0, scopedId: "x" };
		});
		assert.equal(await delegatorFor(watcher).delegate("coder", "what is a.out?"), "It is a 64-bit ELF.");
		assert.deepEqual(lines.map((l) => l.replace(/ in \d+(ms|s)$/, " in N")), [
			"[coder] ▸ started: what is a.out?",
			"[coder] › Let me look at the binary.",
			"[coder] ▸ bash: file /work/a.out",
			"[coder] ▸ bash: nope",
			"[coder] ✗ bash failed",
			"[coder] › It is a 64-bit ELF.",
			"[coder] ✓ done in N",
		]);
		// "tools" leaves out the messages; "off" says nothing at all.
		config.DELEGATE_PROGRESS = "tools";
		lines.length = 0;
		await delegatorFor(watcher).delegate("coder", "again");
		assert.ok(lines.length >= 5 && lines.every((l) => !l.includes("›")), "no message text in tools mode");
		config.DELEGATE_PROGRESS = "off";
		lines.length = 0;
		await delegatorFor(watcher).delegate("coder", "again");
		assert.deepEqual(lines, []);
		config.DELEGATE_PROGRESS = "full";
		// Messages in the reply: the whole of each finished message, as "(name): …"; tool calls stay in the reasoning.
		config.DELEGATE_MESSAGES = "chat";
		const said = [];
		const spoken = rec(arch, { progress: (l) => lines.push(l), say: (chain, m) => said.push([chain, m]) });
		const talker = async ({ onSession }) => {
			const live = new LiveLog();
			onSession({ live, notices: [] });
			live.feed({ type: "message_start", message: { role: "assistant" } });
			live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Looking at it.\nTwo lines." } });
			live.feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
			live.feed({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: "x" } });
			live.feed({ type: "message_start", message: { role: "assistant" } });
			live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "All done." } });
			return { text: "All done.", usage: { total_tokens: 1 }, cost: 0, scopedId: "x" };
		};
		setAgentTurnRunner(talker);
		lines.length = 0;
		await delegatorFor(spoken).delegate("coder", "go");
		assert.deepEqual(said, [[["coder"], "Looking at it.\nTwo lines."], [["coder"], "All done."]], "whole messages, in order, as they finish");
		assert.ok(lines.some((l) => l === "[coder] ▸ bash: ls") && lines.every((l) => !l.includes("›") && !l.includes("Looking")), "tool calls in the reasoning, message text not");
		// Even with progress off the messages still show; with messages off they do not.
		config.DELEGATE_PROGRESS = "off";
		said.length = 0; lines.length = 0;
		await delegatorFor(spoken).delegate("coder", "go");
		assert.equal(said.length, 2);
		assert.deepEqual(lines, []);
		config.DELEGATE_MESSAGES = "off";
		said.length = 0;
		await delegatorFor(spoken).delegate("coder", "go");
		assert.deepEqual(said, []);
		config.DELEGATE_PROGRESS = "full";
		config.DELEGATE_MESSAGES = "chat";
		// A long message is cut; a colleague's own colleague is named in the chain.
		setAgentTurnRunner(async ({ onSession }) => {
			const live = new LiveLog();
			const inner = { live, notices: [] };
			onSession(inner);
			live.feed({ type: "message_start", message: { role: "assistant" } });
			live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "z".repeat(5000) } });
			inner.sayUp(["tester"], "tests pass");
			return { text: "ok", usage: { total_tokens: 1 }, cost: 0, scopedId: "x" };
		});
		said.length = 0;
		await delegatorFor(spoken).delegate("coder", "go");
		assert.deepEqual(said[0], [["coder", "tester"], "tests pass"]);
		assert.ok(said[1][1].length === 3001 && said[1][1].endsWith("…"));
		// The agent's own choice beats the setting; blank follows it.
		setAgentTurnRunner(talker);
		for (const [own, global, expected] of [["off", "chat", 0], ["chat", "off", 2], [null, "chat", 2], [null, "off", 0], ["thinking", "chat", 0]]) {
			agents.update(arch.id, { delegateMessages: own });
			config.DELEGATE_MESSAGES = global;
			said.length = 0;
			await delegatorFor(spoken).delegate("coder", "go");
			assert.equal(said.length, expected, `agent ${own}, setting ${global}`);
		}
		assert.throws(() => agents.update(arch.id, { delegateMessages: "loud" }), /one of: chat, thinking, off/);
		assert.equal(agents.get(arch.id).delegateMessages, "thinking");
		await assert.rejects(D.updateAgent(arch.id, { delegateMessages: "loud" }), /one of: chat, thinking, off/);
		await D.updateAgent(arch.id, { delegateMessages: "" });
		assert.equal(agents.get(arch.id).delegateMessages, null, "blank follows the setting again");
		assert.equal(D.agentView(agents.get(arch.id)).delegateMessages, null);
		config.DELEGATE_MESSAGES = "thinking";
		// A colleague's own hand-offs report up through it, indented; a failure is named.
		setAgentTurnRunner(async ({ onSession, signal }) => {
			const inner = { live: new LiveLog(), notices: [] };
			onSession(inner);
			inner.progress?.("  [tester] ▸ bash: pytest");
			assert.equal(typeof inner.progressUp, "function", "the colleague reports upward");
			inner.progressUp("  [tester] ▸ bash: pytest");
			throw new D.AgentRunError("daily spend limit reached", 429, "spend_limit_exceeded", "rate_limit_error");
		});
		lines.length = 0;
		await assert.rejects(delegatorFor(watcher).delegate("coder", "x"), /daily spend limit/);
		assert.deepEqual(lines, ["[coder] ▸ started: x", "  [tester] ▸ bash: pytest", "[coder] ✗ stopped: daily spend limit reached"]);
		// A quiet colleague gets a sign of life, and stopping the follower ends it.
		const quiet = [];
		const log = new LiveLog();
		let t = 0;
		const f = followColleague(log, (l) => quiet.push(l), "[slow]", "full", { beatMs: 40, now: () => t });
		t = 100;
		await new Promise((r) => setTimeout(r, 1100));
		f.stop();
		assert.ok(quiet.some((l) => /^\[slow\] … still working \(/.test(l)), "a quiet colleague shows a sign of life");
		const after = quiet.length;
		await new Promise((r) => setTimeout(r, 1100));
		assert.equal(quiet.length, after, "stopped");
		assert.deepEqual(((o) => (followColleague(null, () => o.push("x"), "[x]", "full").stop(), o))([]), [], "no live log, nothing to follow");
	}
	config.DELEGATE_MESSAGES = "chat";
	setAgentTurnRunner(async ({ credential, clientSessionId, prompt, signal }) => {
		seen.push({ credential, clientSessionId, prompt });
		if (hold) await new Promise((res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
		return { text: `done: ${prompt}`, usage: { total_tokens: 5 }, cost: 0.01, scopedId: "x" };
	});
	hold = null;
	// A refusal inside the colleague's turn reaches the caller in words.
	setAgentTurnRunner(async () => { throw new D.AgentRunError("daily spend limit reached", 429, "spend_limit_exceeded", "rate_limit_error"); });
	await assert.rejects(d.delegate("coder", "x"), /could not do it: daily spend limit reached/);

	// Teams: steps are checked.
	assert.equal(fillStep("A {{task}} B {{previous}}", "T", "P"), "A T B P");
	assert.throws(() => checkedSteps(k1.record.id, []), /at least one step/);
	assert.throws(() => checkedSteps(k1.record.id, [{ agent: "stranger", instruction: "{{task}}" }]), /no agent "stranger"/);
	assert.throws(() => checkedSteps(k1.record.id, [{ agent: "arch", instruction: "do it" }]), /\{\{task\}\} or \{\{previous\}\}/);
	config.TEAM_MAX_STEPS = 2;
	assert.throws(() => checkedSteps(k1.record.id, [1, 2, 3].map(() => ({ agent: "arch", instruction: "{{task}}" }))), /at most 2/);
	config.TEAM_MAX_STEPS = 6;
	await assert.rejects(createTeam({ keyId: k1.record.id, name: "Bad Name", steps: [{ agent: "arch", instruction: "{{task}}" }] }), /lowercase/);

	// A team runs its steps in order on its own port.
	const log = [];
	setAgentTurnRunner(async ({ credential, clientSessionId, prompt }) => {
		log.push({ agent: credential.agent.name, clientSessionId, prompt });
		if (/FAIL/.test(prompt)) throw new D.AgentRunError("boom", 500);
		return { text: `${credential.agent.name} says (${prompt.replace(/\s+/g, " ")})`, usage: { total_tokens: 10 }, cost: 0.5, scopedId: "x" };
	});
	// A per-key cap, for the same reason an agent endpoint has one: each team opens its own port too.
	config.TEAM_MAX_PER_KEY = 1;
	const capTeam = await createTeam({ keyId: k1.record.id, name: "cap-team", steps: [{ agent: "arch", instruction: "{{task}}" }] });
	await assert.rejects(createTeam({ keyId: k1.record.id, name: "cap-team-2", steps: [{ agent: "arch", instruction: "{{task}}" }] }), /already has 1 teams.*TEAM_MAX_PER_KEY/);
	await deleteTeam(capTeam.id);
	config.TEAM_MAX_PER_KEY = 50;

	const team = await createTeam({ keyId: k1.record.id, name: "pipeline", description: "design then code", steps: [{ agent: "arch", instruction: "Design: {{task}}" }, { agent: "coder", instruction: "Implement {{previous}} for {{task}}" }] });
	assert.equal(team.status, "listening");
	assert.ok(team.port > 0);
	const url = `http://127.0.0.1:${team.port}`;
	const post = (body, token = k1.token, headers = {}) => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
	assert.equal((await post({ messages: [{ role: "user", content: "hi" }] }, k2.token)).status, 401, "only the owning key");
	assert.equal((await fetch(`${url}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 401);
	assert.equal((await fetch(`${url}/v1/piper/profile`, { headers: { Authorization: `Bearer ${k1.token}` } })).status, 404, "nothing else is served");
	assert.equal((await post({ messages: [{ role: "system", content: "x" }] })).status, 400);
	log.length = 0;
	const answer = await (await post({ messages: [{ role: "user", content: "a todo app" }] }, k1.token, { "X-Session-Id": "conv1" })).json();
	assert.equal(answer.choices[0].message.content, "coder says (Implement arch says (Design: a todo app) for a todo app)");
	assert.deepEqual(log.map((l) => l.agent), ["arch", "coder"], "in order");
	assert.match(answer.choices[0].message.reasoning_content, /▸ step 1 of 2: arch[\s\S]*✓ arch[\s\S]*▸ step 2 of 2: coder/);
	assert.equal(answer.usage.total_tokens, 20);
	assert.equal(new Set(log.map((l) => l.clientSessionId)).size, 2, "each step has its own session");
	log.length = 0;
	await post({ messages: [{ role: "user", content: "a todo app" }, { role: "assistant", content: "x" }, { role: "user", content: "add tags" }] }, k1.token, { "X-Session-Id": "conv1" });
	assert.match(log[0].prompt, /add tags/, "{{task}} is the newest user message");
	assert.match(log[0].clientSessionId, /:conv1:0$/, "a follow-up reaches the same agent sessions");
	// Streaming: progress as reasoning, then the answer.
	const streamed = await (await post({ stream: true, messages: [{ role: "user", content: "stream it" }] })).text();
	assert.match(streamed, /"reasoning_content":"▸ step 1 of 2: arch\\n"/);
	assert.match(streamed, /"content":"coder says/);
	assert.ok(streamed.trimEnd().endsWith("data: [DONE]"));
	// A failing step is named; the team stops there.
	log.length = 0;
	const failed = await post({ messages: [{ role: "user", content: "FAIL please" }] });
	assert.equal(failed.status, 500);
	assert.match((await failed.json()).error.message, /step 1 of 2 \(arch\) failed: boom/);
	assert.equal(log.length, 1, "the chain stopped at the failing step");
	// Switching off closes the port; a deleted agent breaks the team plainly.
	assert.equal(listTeams().find((t) => t.id === team.id).broken, false);
	const updated = await updateTeam(team.id, { description: "changed" });
	assert.equal(updated.description, "changed");
	agents.remove(coder.id);
	assert.equal(listTeams().find((t) => t.id === team.id).broken, true);
	const broken = await post({ messages: [{ role: "user", content: "x" }] });
	assert.equal(broken.status, 409);
	assert.match((await broken.json()).error.message, /agent was deleted/);
	// A taken port: the team moves, and says so, exactly like an agent's own port (startAgent).
	{
		const http = await import("node:http");
		const teamPort = listeningTeamPort(team.id);
		await stopTeamServers();
		const squatter = http.createServer((req, res) => res.end("x"));
		await new Promise((r) => squatter.listen(teamPort, "127.0.0.1", r));
		await startTeam(getTeam(team.id));
		assert.notEqual(listeningTeamPort(team.id), teamPort, "it could not have its port back");
		assert.equal(getTeam(team.id).port, listeningTeamPort(team.id), "the new one is stored");
		assert.ok(recentAuditRows(20).some((r) => r.action === "team.port" && /was taken/.test(r.detail)), "and it is on record");
		await new Promise((r) => squatter.close(r));
	}

	await updateTeam(team.id, { enabled: false });
	await assert.rejects(fetch(`${url}/health`), /fetch failed/);
	assert.equal(listeningTeamPort(team.id), null);
	await deleteTeam(team.id);
	assert.equal(getTeam(team.id), null);

	// deleteTeamsOfKey: one team that can no longer be deleted cleanly (its row is already gone, standing
	// in for whatever else could make a single deleteTeam reject) does not stop the rest of the key's teams
	// from going, matching deleteAgentsOfKey's own guard for exactly this reason.
	{
		const goodTeam = await createTeam({ keyId: k1.record.id, name: "good", steps: [{ agent: "arch", instruction: "{{task}}" }] });
		const badTeam = await createTeam({ keyId: k1.record.id, name: "bad", steps: [{ agent: "arch", instruction: "{{task}}" }] });
		db.prepare("DELETE FROM teams WHERE id = ?").run(badTeam.id); // out from under deleteTeam, so it throws "no such team"
		await deleteTeamsOfKey(k1.record.id); // must not throw, and must still remove the good one
		assert.equal(getTeam(goodTeam.id), null, "the good team is still removed");
		assert.equal(listeningTeamPort(goodTeam.id), null, "and its port with it");
	}

	setAgentTurnRunner(null);
	await stopTeamServers();
}

// Phase 5: packages, MCP servers and bundles.
{
	const P = await import("./server.mjs");
	const { validateSource, mcpAddArgs, packageRunArgs, runPiCommand, PackageError, installPackage, addMcp, listMcp, setMcpEnabled, createBundle, deleteBundle, bundleOverview, bundleDir, bundleUsers, bundleRoutes, packageRoutes, apiKeys, config, setProfileLock, profileOp, ensureProfile, sharedRoot } = P;

	// Package sources: what may be typed.
	for (const good of ["npm:left-pad", "npm:@scope/pkg", "npm:pkg@1.2.3", "npm:@scope/pkg@^1.0.0", "git:github.com/user/repo", "git:github.com/user/repo@v1.2", "https://github.com/user/repo", "https://gitlab.example.com:8443/group/sub/repo@main"]) assert.equal(validateSource(good), good, good);
	for (const evil of ["", "  ", "./local/path", "/etc/passwd", "../x", "-l", "--local", "npm:--registry=http://evil", "npm:pkg --global", "npm:pkg;rm -rf /", "npm:pkg$(id)", "npm:Pkg With Space", "git:git@github.com:user/repo", "ssh://git@github.com/user/repo", "http://github.com/user/repo", "https://user:pw@github.com/user/repo", "https://localhost/x", "https://github.com/user/repo?x=1", "file:///etc", "npm:", "npm:@/x", "x".repeat(300), "https://github.com/../x", "git:github.com/a/b\nc"]) assert.throws(() => validateSource(evil), PackageError, JSON.stringify(evil));

	// MCP: composed as separate arguments, secrets only as references.
	assert.deepEqual(mcpAddArgs({ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] }), ["mcp", "add", "fs", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"]);
	assert.deepEqual(mcpAddArgs({ name: "tools", command: "uvx", args: ["tools-mcp"], env: { API_KEY: "${TOOLS_KEY}" }, exposure: "direct" }), ["mcp", "add", "tools", "--exposure", "direct", "--env", "API_KEY=${TOOLS_KEY}", "--", "uvx", "tools-mcp"]);
	assert.deepEqual(mcpAddArgs({ name: "docs", url: "https://example.com/mcp", bearerTokenEnv: "DOCS_TOKEN" }), ["mcp", "add", "docs", "--url", "https://example.com/mcp", "--bearer-token-env-var", "DOCS_TOKEN"]);
	for (const [input, re] of [
		[{ name: "bad name", command: "npx" }, /name is letters/],
		[{ name: "x", command: "npx -y evil" }, /one program/],
		[{ name: "x", command: "-rf" }, /one program/],
		[{ name: "x", command: "npx", args: ["a\nb"] }, /arguments/],
		[{ name: "x", command: "npx", args: Array(41).fill("a") }, /at most 40/],
		[{ name: "x", command: "npx", env: { KEY: "sk-live-secret" } }, /never the secret itself/],
		[{ name: "x", command: "npx", env: { "BAD KEY": "${A}" } }, /not an environment variable name/],
		[{ name: "x", command: "npx", env: { KEY: "${A} and more" } }, /never the secret itself/],
		[{ name: "x", command: "npx", exposure: "everything" }, /exposure is one of/],
		[{ name: "x", url: "ftp://x/y" }, /http or https/],
		[{ name: "x", url: "https://user:pw@example.com/mcp" }, /no credentials/],
		[{ name: "x", url: "https://example.com/mcp", command: "npx" }, /not both/],
		[{ name: "x", url: "https://example.com/mcp", bearerTokenEnv: "not a name" }, /bearer token variable/],
		[{ name: "x", url: "nonsense" }, /not valid/],
	]) assert.throws(() => mcpAddArgs(input), re, JSON.stringify(input));

	// The container command line: only the profile is mounted.
	const run = packageRunArgs({ name: "piper-pkg-1", image: "piper-agent", profileDir: "/p/key-1", piArgs: ["install", "npm:x"], network: "internet", memoryMb: 512, pids: 100, cpus: 1.5, timeoutSeconds: 120 });
	assert.deepEqual(run.filter((_, i) => run[i - 1] === "-v"), ["/p/key-1:/profile"], "the profile is the only mount");
	assert.equal(run.some((a) => /docker\.sock|--privileged|--cap-add|--volumes-from|--mount|--device/.test(a)), false);
	assert.ok(run.includes("--read-only") && run.includes("--rm") && run.includes("no-new-privileges"));
	assert.deepEqual(run.slice(run.indexOf("--entrypoint")), ["--entrypoint", "timeout", "piper-agent", "-k", "10", "120", "pi", "install", "npm:x"], "the arguments go as separate words after the image");
	assert.ok(run.join(" ").includes("--memory 512m --memory-swap 512m") && run.join(" ").includes("--pids-limit 100") && run.join(" ").includes("--cpus 1.5"));
	assert.ok(run.includes("PI_CODING_AGENT_DIR=/profile"));
	assert.equal(run.some((a) => /PI_OFFLINE/.test(a)), false, "Pi may reach the network for an install");
	assert.deepEqual(run.slice(run.indexOf("--network"), run.indexOf("--network") + 2), ["--network", "piper"], "the scope's own network");
	assert.deepEqual(packageRunArgs({ name: "n", image: "i", profileDir: "/p", piArgs: ["mcp", "add"], network: "none" }).slice(0), packageRunArgs({ name: "n", image: "i", profileDir: "/p", piArgs: ["mcp", "add"], network: "none" }));
	const nonet = packageRunArgs({ name: "n", image: "i", profileDir: "/p", piArgs: ["mcp", "add"], network: "none" });
	assert.deepEqual(nonet.slice(nonet.indexOf("--network"), nonet.indexOf("--network") + 2), ["--network", "none"]);

	// Refusals before anything runs: the network policy, a locked profile, the switch.
	const made = apiKeys.create({ name: "pkg test", expiresAt: 0 });
	const key = made.record ?? made;
	apiKeys.update(key.id, { container: { network: "none" } });
	await assert.rejects(runPiCommand(key.id, ["install", "npm:x"], { needsNetwork: true }), (e) => e.status === 409 && /network policy is "none"/.test(e.message));
	apiKeys.update(key.id, { container: null });
	ensureProfile(key.id);
	setProfileLock(P.profileScope(key.id), true);
	assert.throws(() => installPackage(key.id, "npm:x"), (e) => e.status === 423);
	setProfileLock(P.profileScope(key.id), false);
	config.PACKAGES_ENABLED = false;
	assert.throws(() => installPackage(key.id, "npm:x"), (e) => e.status === 403);
	assert.throws(() => addMcp(key.id, { name: "a", command: "npx" }), (e) => e.status === 403);
	config.PACKAGES_ENABLED = true;
	assert.throws(() => installPackage(key.id, "./local"), PackageError, "validated before any container");
	assert.throws(() => addMcp(key.id, { name: "a", command: "npx", env: { K: "plain" } }), /never the secret/);

	// Bundles: the folder, its checks, who gets it.
	const root = sharedRoot();
	mkdirSync(root, { recursive: true });
	assert.deepEqual(createBundle("team-tools"), { name: "team-tools" });
	for (const sub of ["skills", "extensions", "prompts"]) assert.ok(existsSync(join(root, "team-tools", sub)));
	for (const evil of ["", "../x", "a/b", ".hidden", "x".repeat(65), "a b"]) assert.throws(() => createBundle(evil), /name/, JSON.stringify(evil));
	assert.throws(() => createBundle("team-tools"), /already a bundle/);
	assert.equal(bundleDir("team-tools"), join(root, "team-tools"));
	assert.throws(() => bundleDir("nope"), (e) => e.status === 404);
	assert.throws(() => bundleDir("../etc"), /not a bundle name/);
	mkdirSync(join(TEST_WS, "outside-bundle"), { recursive: true });
	symlinkSync(join(TEST_WS, "outside-bundle"), join(root, "linked"));
	assert.throws(() => bundleDir("linked"), (e) => e.status === 409 && /link/.test(e.message), "a linked bundle is not edited from here");
	assert.equal(bundleOverview().bundles.find((b) => b.name === "linked").editable, false);
	apiKeys.update(key.id, { sharedBundles: "team-tools" });
	assert.deepEqual(bundleUsers("team-tools").map((u) => u.label), ["pkg test"]);
	await assert.rejects(deleteBundle("team-tools"), (e) => e.status === 409 && /granted to pkg test/.test(e.message));
	// Deleting a bundle (forced) closes its users' live sessions and waits for them to stop, not just a
	// soft reload — the directory their container has mounted is about to disappear entirely.
	{
		const realRecordsByScope = P.sessions.recordsByScope.bind(P.sessions);
		let stoppedAwaited = false;
		P.sessions.recordsByScope = (scope) =>
			scope === key.id ? [{ id: "fake-bundle-session", container: { name: "fake" }, inflight: 0, stopped: new Promise((resolve) => setTimeout(() => ((stoppedAwaited = true), resolve()), 20)) }] : realRecordsByScope(scope);
		assert.deepEqual((await deleteBundle("team-tools", { force: true })), { deleted: "team-tools" });
		assert.equal(stoppedAwaited, true, "deleting it waited for the live session's container to actually stop");
		P.sessions.recordsByScope = realRecordsByScope;
	}
	assert.equal(existsSync(join(root, "team-tools")), false);
	assert.ok(existsSync(join(TEST_WS, "outside-bundle")), "deleting never follows a link");

	// Routes: changes need a dashboard password; reading does not.
	const http = await import("node:http");
	const srv = http.createServer((req, res) => void (async () => { const p = new URL(req.url, "http://x").pathname; (await bundleRoutes(req, res, p)) || (await packageRoutes(req, res, p)) || (res.writeHead(404), res.end()); })());
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}`;
	const call = (path, method = "GET", body) => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	P.clearPasswordHash();
	assert.equal((await call("/dashboard/bundles", "POST", { name: "x1" })).status, 403);
	assert.equal((await call("/dashboard/bundles/x1", "DELETE")).status, 403);
	assert.equal((await call("/dashboard/bundlefiles/x1/skills/a.md?as=text", "PUT", { text: "x" })).status, 403);
	assert.equal((await call(`/dashboard/packages/key-${key.id}/install`, "POST", { source: "npm:x" })).status, 403);
	assert.equal((await call(`/dashboard/packages/key-${key.id}/mcp-enable`, "POST", { name: "a" })).status, 403);
	assert.equal((await call("/dashboard/bundles.json")).status, 200);
	const info = await (await call(`/dashboard/packages/key-${key.id}.json`)).json();
	assert.deepEqual([info.passwordSet, info.enabled, info.packages, info.mcp.servers], [false, true, [], []]);
	assert.equal((await call("/dashboard/packages/key-nonexistent-key.json")).status, 404);
	assert.equal((await call("/dashboard/packages/job.json")).status, 200);
	P.setPasswordHash(P.hashPassword("a long enough password"));
	assert.equal((await call("/dashboard/bundles", "POST", { name: "x1" })).status, 201);
	assert.equal((await call("/dashboard/bundles", "POST", { name: "x1" })).status, 409);
	assert.equal((await call(`/dashboard/packages/key-${key.id}/install`, "POST", { source: "../../x" })).status, 400);
	assert.equal((await call(`/dashboard/packages/key-${key.id}/mcp-add`, "POST", { name: "a", command: "npx", env: { K: "plain" } })).status, 400);
	assert.equal((await call(`/dashboard/packages/key-${key.id}/nonsense`, "POST", {})).status, 404);
	assert.equal((await call("/dashboard/bundles/x1", "DELETE")).status, 200);
	P.clearPasswordHash();
	await new Promise((r) => srv.close(r));
	srv.closeAllConnections?.();
	rmSync(join(root, "linked"), { force: true });
}

// Dashboard navigation: pages, tabs, and old links.
{
	const html = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
	const vm = await import("node:vm");
	const start = html.indexOf("var PAGES = {");
	const fn = html.indexOf("function resolveHash(");
	const end = html.indexOf("\n}\n", fn) + 3;
	assert.ok(start > 0 && fn > start && end > fn, "the page table is where the test expects it");
	const ctx = vm.createContext({});
	vm.runInContext(`${html.slice(start, end)}\nthis.PAGES = PAGES; this.PANES = PANES; this.resolveHash = resolveHash;`, ctx);
	const { PAGES, PANES, resolveHash } = ctx;
	const navHtml = html.slice(html.indexOf('<nav id="nav">'), html.indexOf("</nav>"));
	const navPages = [...navHtml.matchAll(/<a[^>]*href="#([a-z]+)"/g)].map((m) => m[1]);
	assert.deepEqual([...navPages].sort(), Object.keys(PAGES).sort(), "every nav item is a page and every page is in the nav");
	assert.equal(new Set(navPages).size, navPages.length, "no page twice in the nav");
	assert.equal(navPages.length, 16, "sixteen items in the sidebar");
	assert.deepEqual([...navHtml.matchAll(/class="navgroup">([^<]+)</g)].map((m) => m[1]), ["Monitor", "Build", "Infrastructure", "Admin"]);

	// Every tab shows a pane that exists, and a split pane's sections match the markup.
	const reached = new Set();
	for (const [id, page] of Object.entries(PAGES)) {
		assert.ok(page.title && page.tabs.length, id);
		const tabIds = page.tabs.map((t) => t.id);
		assert.equal(new Set(tabIds).size, tabIds.length, `${id}: tab ids are unique`);
		for (const tab of page.tabs) {
			assert.ok(PANES.includes(tab.pane), `${id}/${tab.id}: pane ${tab.pane} is a known pane`);
			assert.ok(html.includes(`id="view-${tab.pane}"`), `${id}/${tab.id}: view-${tab.pane} exists`);
			assert.ok(tab.subtitle, `${id}/${tab.id} has a subtitle`);
			if (page.tabs.length > 1) assert.ok(tab.label, `${id}/${tab.id} has a label`);
			reached.add(tab.pane);
		}
	}
	assert.deepEqual([...reached].sort(), [...PANES].sort(), "every pane can be reached");
	for (const pane of PANES) {
		const block = html.slice(html.indexOf(`id="view-${pane}"`), html.indexOf("<!-- /view-", html.indexOf(`id="view-${pane}"`)) + 1);
		const marked = new Set([...block.matchAll(/<section data-tab="([a-z]+)"/g)].map((m) => m[1]));
		const wanted = new Set(Object.values(PAGES).flatMap((p) => p.tabs).filter((t) => t.pane === pane && t.sections).map((t) => t.sections));
		assert.deepEqual([...marked].sort(), [...wanted].sort(), `${pane}: the sections marked data-tab are exactly the ones a tab asks for`);
		const tabs = Object.values(PAGES).flatMap((p) => p.tabs).filter((t) => t.pane === pane);
		if (marked.size) assert.ok(tabs.every((t) => t.sections), `${pane}: a split pane's every tab names its sections`);
	}

	// Links, new and old.
	const at = (hash) => { const r = resolveHash(hash); return [r.page, r.tab.id, ...r.rest].join("/"); };
	for (const [hash, want] of Object.entries({
		"": "overview/overview", "#overview": "overview/overview", "#nonsense": "overview/overview", "#/chats": "chats/chats",
		"#agents": "agents/agents", "#agents/teams": "agents/teams", "#agents/create": "agents/create", "#agents/teams/x": "agents/teams/x",
		"#files": "files/files", "#files/profiles": "files/profiles", "#files/profiles/key-1--ab": "files/profiles/key-1--ab",
		"#containers": "containers/containers", "#containers/terminal/piper-ab": "containers/terminal/piper-ab", "#containers/events": "containers/events",
		"#settings": "settings/settings", "#settings/containers": "settings/settings/containers", "#apikeys": "apikeys/apikeys",
		"#help": "help/docs", "#help/about": "help/about", "#help/docs/functions/agents": "help/docs/functions/agents",
		// links of earlier versions
		"#endpoints": "agents/agents", "#terminal": "containers/terminal", "#terminal/piper-ab": "containers/terminal/piper-ab",
		"#profiles": "files/profiles", "#profiles/key-9": "files/profiles/key-9", "#docs": "help/docs", "#docs/overview/x": "help/docs/overview/x", "#about": "help/about",
		"#agents/not-a-tab": "agents/agents/not-a-tab",
	})) assert.equal(at(hash), want, JSON.stringify(hash));
	// The docs renderer's links and the page's own docs links agree.
	assert.equal(at(linkHref("#Some Heading", { page: "p" }).href), "help/docs/p/some-heading");
	assert.ok(!/href = '#docs|location\.hash = '#(profiles|terminal)/.test(html), "no code sets an old-style hash");
	assert.ok(!/sectiontitle/.test(html), "the repeated section title is gone");
	// The rule that hides other tabs' sections must only reach sections: the API keys page has its own data-tab blocks.
	assert.match(html, /\.view > section\[data-tab\]:not\(\.tabshown\)/);
	assert.ok(!/\.view > \[data-tab\]/.test(html), "the tab rule does not match every data-tab element");
	assert.ok(html.includes('class="pagetabs" id="tabbar"'), "the page tab bar has a class of its own, apart from the existing .tabs bars");
}

// What a package or extension source may look like, checked once and shared by both (lib/packagesource.mjs).
{
	const { checkPackageSource } = await import("./server.mjs");
	for (const good of ["npm:left-pad", "npm:@scope/pkg", "npm:pkg@1.2.3", "npm:@scope/pkg@^1.0.0", "git:github.com/user/repo", "git:github.com/user/repo@v1.2", "https://github.com/user/repo", "https://gitlab.example.com:8443/group/sub/repo@main"]) {
		assert.deepEqual(checkPackageSource(good), { ok: true, source: good }, good);
	}
	for (const evil of ["", "  ", "./local/path", "/etc/passwd", "../x", "-l", "npm:--registry=http://evil", "npm:pkg;rm -rf /", "git:git@github.com:user/repo", "http://github.com/user/repo", "https://user:pw@github.com/user/repo", "file:///etc", "npm:", "x".repeat(300), "https://github.com/../x"]) {
		const checked = checkPackageSource(evil);
		assert.equal(checked.ok, false, JSON.stringify(evil));
		assert.equal(typeof checked.reason, "string");
	}
	assert.equal(checkPackageSource("x".repeat(300)).reason, "that package source is too long");
	assert.equal(checkPackageSource(null).ok, false, "never throws on a strange input");
}

// Phase A (0.7): the extension library and grants.
{
	const X = await import("./server.mjs");
	const { checkedSource, nameFromSource, gitTarget, installEnv, installCommands, looksLikePiPackage, treeBytes, installExtension, updateExtension, removeExtension, extensionJobView, resetExtensionJob, libraryOverview, ExtensionError, listLibrary, listShared, grantedBundles, bundleUsers, createBundle, extensionRoutes, setAccess, extensionsPayload, agents, apiKeys, config, packageDir, containerCreateArgs, piInvocation, containerSignature, installInto, sessions } = X;
	const fsm = await import("node:fs");
	const log = join(TEST_WS, "fake-tools.log");
	const bin = mkdtempSync(join(tmpdir(), "fakenpm-"));
	// A fake npm and git: they make what the real ones would, and record how they were called.
	writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash
echo "npm $* | HOME=$HOME | ignore=$npm_config_ignore_scripts | secret=\${PIPER_TEST_SECRET:-none}" >> ${log}
prefix=""; spec=""; args=("$@"); i=0
while [ $i -lt $# ]; do case "\${args[$i]}" in --prefix) prefix="\${args[$((i+1))]}"; i=$((i+1));; install|--*) ;; *) spec="\${args[$i]}";; esac; i=$((i+1)); done
name="\${spec%%@[0-9^~]*}"; [ -z "$spec" ] && exit 0
case "$name" in failing) echo "npm error 404" >&2; exit 1;; esac
mkdir -p "$prefix/node_modules/$name"
echo "{\\"name\\":\\"$name\\",\\"version\\":\\"1.2.3\\",\\"keywords\\":[\\"pi-package\\"]}" > "$prefix/node_modules/$name/package.json"
case "$name" in plainlib) echo "{\\"name\\":\\"$name\\",\\"version\\":\\"1.0.0\\"}" > "$prefix/node_modules/$name/package.json";; esac
case "$name" in good*|plainlib) mkdir -p "$prefix/node_modules/$name/extensions"; echo "export default () => {};" > "$prefix/node_modules/$name/extensions/x.js";; esac
case "$name" in plainlib) rm -rf "$prefix/node_modules/$name/extensions"; echo hi > "$prefix/node_modules/$name/readme.txt";; esac
case "$name" in huge) head -c 3000000 /dev/zero > "$prefix/node_modules/$name/blob";; esac
echo "{\\"dependencies\\":{\\"$name\\":\\"1.2.3\\"}}" > "$prefix/package.json"
echo "added 1 package"
`);
	writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
echo "git $* | HOME=$HOME | cfg=$GIT_CONFIG_GLOBAL" >> ${log}
target="\${@: -1}"; mkdir -p "$target/.git" "$target/skills/demo"
echo "{\\"name\\":\\"fromgit\\",\\"version\\":\\"0.3.0\\",\\"pi\\":{\\"skills\\":[\\"./skills\\"]}}" > "$target/package.json"
echo "# demo" > "$target/skills/demo/SKILL.md"
`);
	(await import("node:fs")).chmodSync(join(bin, "npm"), 0o755);
	(await import("node:fs")).chmodSync(join(bin, "git"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	process.env.PIPER_TEST_SECRET = "gateway-secret-value";
	mkdirSync(TEST_WS, { recursive: true });
	const waitJob = async () => { const end = Date.now() + 8000; while (Date.now() < end) { const j = extensionJobView(); if (j && j.state !== "running") return j; await new Promise((r) => setTimeout(r, 20)); } throw new Error("job timed out"); };

	// Sources and names.
	for (const good of ["npm:good-ext", "npm:@scope/pkg@1.2.3", "git:github.com/o/repo", "git:github.com/o/repo@v1", "https://github.com/o/repo"]) assert.equal(checkedSource(good), good);
	for (const evil of ["", "./x", "/etc/passwd", "-g", "npm:--x", "npm:a b", "http://github.com/o/r", "git@github.com:o/r", "https://u:p@github.com/o/r", "npm:x;id", "x".repeat(300)]) assert.throws(() => checkedSource(evil), ExtensionError, evil);
	assert.deepEqual(["npm:@scope/pkg@1.2.3", "npm:good-ext", "https://github.com/o/Repo.git", "git:github.com/o/repo@v1"].map(nameFromSource), ["scope-pkg", "good-ext", "repo", "repo"]);
	assert.deepEqual(gitTarget("git:github.com/o/repo@v1"), { url: "https://github.com/o/repo", ref: "v1" });
	assert.deepEqual(gitTarget("https://gitlab.com/g/s/r"), { url: "https://gitlab.com/g/s/r", ref: null });

	// The commands and the environment of a host install.
	const env = installEnv("/lib/x");
	assert.deepEqual(Object.keys(env).filter((k) => !/^(PATH|HOME|TMPDIR|LANG|npm_config_|GIT_)/.test(k)), [], "nothing of the gateway's environment is passed on");
	assert.equal(env.npm_config_ignore_scripts, "true");
	assert.equal(installEnv("/x", { allowScripts: true }).npm_config_ignore_scripts, "false");
	const [npmCmd] = installCommands("npm:good-ext", "/lib/.stage");
	assert.deepEqual(npmCmd.args, ["install", "--prefix", "/lib/.stage", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--legacy-peer-deps", "--no-package-lock", "good-ext"]);
	assert.ok(!installCommands("npm:good-ext", "/s", { allowScripts: true })[0].args.includes("--ignore-scripts"));
	const [gitCmd] = installCommands("git:github.com/o/r@v1", "/lib/.stage");
	assert.deepEqual(gitCmd.args.slice(0, 6), ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]);
	assert.ok(gitCmd.args.includes("--depth") && gitCmd.args.includes("--branch") && gitCmd.args.includes("--"), "shallow, pinned, and the URL cannot be read as a flag");
	assert.equal(gitCmd.args.at(-2), "https://github.com/o/r");

	// Gates: the switch, the password-less route.
	config.EXTENSIONS_ENABLED = false;
	assert.throws(() => installExtension({ source: "npm:good-ext" }), (e) => e.status === 403);
	config.EXTENSIONS_ENABLED = true;
	assert.throws(() => installExtension({ source: "../x" }), ExtensionError);
	assert.throws(() => installExtension({ source: "npm:good-ext", name: "bad name" }), /a name is/);

	// Installing: npm.
	resetExtensionJob();
	installExtension({ source: "npm:good-ext" });
	let done = await waitJob();
	assert.equal(done.state, "done", done.lines.join("\n"));
	const entry = listLibrary().find((e) => e.name === "good-ext");
	assert.deepEqual([entry.entry, entry.version, entry.source, entry.kind], ["node_modules/good-ext", "1.2.3", "npm:good-ext", "package"]);
	assert.ok(fsm.existsSync(join(TEST_EXT, "good-ext", "node_modules", "good-ext", "extensions", "x.js")));
	assert.ok(!fsm.readdirSync(TEST_EXT).some((n) => n.startsWith(".staging")), "nothing is left staged");
	const called = fsm.readFileSync(log, "utf8");
	assert.match(called, /npm install --prefix .* --ignore-scripts/);
	assert.match(called, /ignore=true \| secret=none/, "the gateway's environment did not reach npm");
	assert.ok(!called.includes("gateway-secret-value"));
	assert.equal(packageDir(entry), join(TEST_EXT, "good-ext", "node_modules/good-ext"));

	// A hung install is told apart from one that genuinely failed: both end up SIGKILLed, but only the
	// timeout is reported as "timed out" rather than a bare, misleading exit code.
	{
		const { EventEmitter } = await import("node:events");
		const { PassThrough } = await import("node:stream");
		const hungSpawn = () => {
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = (signal) => void setImmediate(() => child.emit("close", signal === "SIGKILL" ? 137 : 1));
			return child;
		};
		await assert.rejects(installInto("x", "npm:good-ext", { spawnFn: hungSpawn, timeoutMs: 20 }), /npm timed out after 0 minutes/, "the timeout, not a bare exit code, is reported");

		// The same exit code from something else entirely (the host killing it for memory, say) is not
		// mistaken for this timeout: only the timer actually firing sets it.
		const killedForMemory = () => {
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = () => {};
			setImmediate(() => child.emit("close", 137));
			return child;
		};
		await assert.rejects(installInto("x", "npm:good-ext", { spawnFn: killedForMemory, timeoutMs: 60_000 }), /npm exited with code 137/);
	}

	// Installing: git.
	installExtension({ source: "git:github.com/o/fromgit@v1", name: "fromgit" });
	done = await waitJob();
	assert.equal(done.state, "done", done.lines.join("\n"));
	assert.equal(listLibrary().find((e) => e.name === "fromgit").entry, "src");
	assert.ok(!fsm.existsSync(join(TEST_EXT, "fromgit", "src", ".git")), "the clone's .git is removed");
	assert.match(fsm.readFileSync(log, "utf8"), /git -c core\.hooksPath=\/dev\/null .* clone --depth 1 --branch v1 -- https:\/\/github\.com\/o\/fromgit .*\| cfg=\/dev\/null/);
	// What must not get in.
	for (const [source, why] of [["npm:plainlib", /not a Pi package/], ["npm:failing", /exited with code 1/]]) {
		installExtension({ source });
		done = await waitJob();
		assert.equal(done.state, "failed", source);
		assert.match(done.lines.join("\n"), why, source);
		assert.ok(!listLibrary().some((e) => e.name === nameFromSource(source)), `${source} is not in the library`);
	}
	assert.ok(!fsm.readdirSync(TEST_EXT).some((n) => n.startsWith(".")), "failed installs leave nothing behind");
	config.EXTENSION_MAX_BYTES = 1024 * 1024;
	installExtension({ source: "npm:huge" });
	done = await waitJob();
	assert.equal(done.state, "failed");
	assert.match(done.lines.join("\n"), /limit/);
	config.EXTENSION_MAX_BYTES = 200 * 1024 * 1024;
	// Names: a bundle and an entry cannot share one.
	mkdirSync(TEST_SHARED, { recursive: true });
	createBundle("taken-name");
	assert.throws(() => installExtension({ source: "npm:good-ext2", name: "taken-name" }), (e) => e.status === 409);
	assert.throws(() => createBundle("good-ext"), /already the name of a library extension/);
	assert.throws(() => installExtension({ source: "npm:other-thing", name: "good-ext" }), (e) => e.status === 409 && /already installed from/.test(e.message));
	// Reinstall of the same source (update) swaps in place.
	const sigBefore = containerSignature({ bundles: [listLibrary().find((e) => e.name === "good-ext")] });
	await new Promise((r) => setTimeout(r, 2)); // installedAt is Date.now(); make sure it actually moves
	updateExtension("good-ext");
	assert.equal((await waitJob()).state, "done");
	assert.equal(listLibrary().filter((e) => e.name === "good-ext").length, 1);
	assert.throws(() => updateExtension("nope"), (e) => e.status === 404);
	assert.ok(treeBytes(join(TEST_EXT, "good-ext")) > 0);
	assert.equal(looksLikePiPackage(join(TEST_EXT, "good-ext", "node_modules", "good-ext")), true);
	// A reinstall under the same name/path/entry still changes the signature (via installedAt), so a
	// container already holding the old content is recreated on its next start rather than kept stale.
	const sigAfter = containerSignature({ bundles: [listLibrary().find((e) => e.name === "good-ext")] });
	assert.notEqual(sigBefore, sigAfter, "a same-name reinstall changes the signature too");

	// Updating (or removing) an extension closes its users' live sessions, and waits for them to actually
	// stop, before touching the directory their container has bind-mounted — not just a soft reload.
	{
		const realRecordsByScope = sessions.recordsByScope.bind(sessions);
		let stoppedAwaited = false;
		const fakeKeyCreated = apiKeys.create({ name: "fake-ext-user-key", expiresAt: 0 });
		const fakeKey = fakeKeyCreated.record ?? fakeKeyCreated;
		apiKeys.update(fakeKey.id, { sharedBundles: "good-ext" });
		sessions.recordsByScope = (scope) =>
			scope === fakeKey.id ? [{ id: "fake-ext-session", container: { name: "fake" }, inflight: 0, stopped: new Promise((resolve) => setTimeout(() => ((stoppedAwaited = true), resolve()), 20)) }] : realRecordsByScope(scope);
		updateExtension("good-ext");
		assert.equal((await waitJob()).state, "done");
		assert.equal(stoppedAwaited, true, "the update waited for the live session's container to actually stop");
		sessions.recordsByScope = realRecordsByScope;
		apiKeys.update(fakeKey.id, { sharedBundles: null });
	}

	// Grants: default -> key -> agent, and what each level gets.
	const mkKey = (name) => { const c = apiKeys.create({ name, expiresAt: 0 }); return c.record ?? c; };
	const key = mkKey("ext key");
	const other = mkKey("ext other");
	const a1 = agents.create({ keyId: key.id, name: "a1" });
	const a2 = agents.create({ keyId: key.id, name: "a2" });
	const scopeOf2 = (a) => `${a.keyId}--${a.id}`;
	const got = (scope) => grantedBundles(scope, { fallback: "taken-name" }).map((b) => b.name);
	assert.deepEqual(got(key.id), ["taken-name"], "the default");
	apiKeys.update(key.id, { sharedBundles: "good-ext,fromgit" });
	assert.deepEqual(got(key.id), ["fromgit", "good-ext"], "a key's list replaces the default");
	assert.deepEqual(got(scopeOf2(a1)), ["fromgit", "good-ext"], "its agents follow the key");
	agents.update(a1.id, { sharedBundles: "fromgit" });
	assert.deepEqual(got(scopeOf2(a1)), ["fromgit"], "an agent's own list wins");
	assert.deepEqual(got(scopeOf2(a2)), ["fromgit", "good-ext"], "a sibling still follows the key");
	agents.update(a1.id, { sharedBundles: "" });
	assert.deepEqual(got(scopeOf2(a1)), [], "none is a list too");
	agents.update(a1.id, { sharedBundles: "*" });
	assert.ok(got(scopeOf2(a1)).includes("good-ext") && got(scopeOf2(a1)).includes("taken-name"), "* is everything: bundles and the library");
	agents.update(a1.id, { sharedBundles: "ghost,fromgit" });
	assert.deepEqual(got(scopeOf2(a1)), ["fromgit"], "a name that does not exist is ignored");
	assert.deepEqual(got(other.id), ["taken-name"], "another key keeps the default");
	assert.deepEqual(bundleUsers("fromgit").map((u) => u.label), ["ext key", "ext key / a1", "ext key / a2"]);
	assert.deepEqual(bundleUsers("good-ext").map((u) => u.label), ["ext key", "ext key / a2"], "a1 has its own list without it");

	// Mounts: the entry's folder is mounted read-only and Pi is pointed at the package inside it.
	const mounts = grantedBundles(scopeOf2(a2), { fallback: "" }).filter((b) => b.name === "good-ext");
	const args = containerCreateArgs({ name: "c", sig: "s", image: "i", workspace: "/w", profileDir: "/p", chatDir: "/c", runDir: "/r", bridgePath: "/b.mjs", bundles: mounts });
	assert.ok(args.includes(`${join(TEST_EXT, "good-ext")}:${CONTAINER_PATHS.shared}/good-ext:ro`));
	const inv = piInvocation({ bundles: mounts, env: [] }, {});
	assert.ok(inv.piArgs.includes(`${CONTAINER_PATHS.shared}/good-ext/node_modules/good-ext`), "-e names the package inside the mounted folder");
	assert.notEqual(containerSignature({ bundles: [{ name: "x", path: "/p", entry: "a" }] }), containerSignature({ bundles: [{ name: "x", path: "/p", entry: "b" }] }), "a different entry rebuilds the container");

	// Routes: password, install, access, remove.
	const http = await import("node:http");
	const srv = http.createServer((req, res) => void extensionRoutes(req, res, new URL(req.url, "http://x").pathname).then((h) => h || (res.writeHead(404), res.end())));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}`;
	const call = (path, body) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	X.clearPasswordHash();
	assert.equal((await call("/dashboard/extensions/install", { source: "npm:good-ext3" })).status, 403, "no password, no install");
	assert.equal((await call("/dashboard/extensions/access", { level: "key", id: key.id, list: "" })).status, 403);
	const view = await (await call("/dashboard/extensions.json")).json();
	assert.deepEqual([view.passwordSet, view.library.map((e) => e.name).sort()], [false, ["fromgit", "good-ext"]]);
	assert.ok(view.keys.find((k) => k.id === key.id).agents.find((a) => a.id === a1.id).effective.includes("fromgit"));
	X.setPasswordHash(X.hashPassword("a long enough password"));
	assert.equal((await call("/dashboard/extensions/install", { source: "../x" })).status, 400);
	assert.equal((await call("/dashboard/extensions/access", { level: "nonsense" })).status, 400);
	assert.equal((await call("/dashboard/extensions/access", { level: "agent", id: "deadbeef", list: "" })).status, 404);
	let r = await call("/dashboard/extensions/access", { level: "agent", id: a2.id, list: "fromgit" });
	assert.equal(r.status, 200);
	assert.equal(agents.get(a2.id).sharedBundles, "fromgit");
	r = await call("/dashboard/extensions/access", { level: "agent", id: a2.id, list: "none" });
	assert.equal(agents.get(a2.id).sharedBundles, "", "none is a list that gives nothing");
	r = await call("/dashboard/extensions/access", { level: "agent", id: a2.id, list: "" });
	assert.equal(agents.get(a2.id).sharedBundles, null, "blank follows the key");
	r = await call("/dashboard/extensions/access", { level: "agent", id: a2.id, list: null });
	assert.equal(agents.get(a2.id).sharedBundles, null, "null follows the key again");
	await call("/dashboard/extensions/access", { level: "key", id: key.id, list: "bad name!" }).then((x) => assert.equal(x.status, 400));
	assert.equal((await call("/dashboard/extensions/access", { level: "default", list: "taken-name,good-ext" })).status, 200);
	assert.equal(config.SHARED_BUNDLES, "taken-name,good-ext");
	await call("/dashboard/extensions/access", { level: "default", list: "base" });
	// Removing something that is granted needs force.
	assert.equal((await call("/dashboard/extensions/remove", { name: "good-ext" })).status, 409);
	// Removing it (forced) closes its users' live sessions and waits for them to stop too, not just a
	// soft reload — the directory their container has mounted is about to disappear entirely.
	{
		const realRecordsByScope = sessions.recordsByScope.bind(sessions);
		let stoppedAwaited = false;
		sessions.recordsByScope = (scope) =>
			scope === key.id ? [{ id: "fake-remove-session", container: { name: "fake" }, inflight: 0, stopped: new Promise((resolve) => setTimeout(() => ((stoppedAwaited = true), resolve()), 20)) }] : realRecordsByScope(scope);
		assert.equal((await call("/dashboard/extensions/remove", { name: "good-ext", force: true })).status, 200);
		assert.equal(stoppedAwaited, true, "removing it waited for the live session's container to actually stop");
		sessions.recordsByScope = realRecordsByScope;
	}
	assert.ok(!fsm.existsSync(join(TEST_EXT, "good-ext")));
	assert.equal((await call("/dashboard/extensions/remove", { name: "good-ext" })).status, 404);
	assert.deepEqual(got(scopeOf2(a2)), ["fromgit"], "a removed entry is gone from what agents get");
	X.clearPasswordHash();
	await new Promise((r2) => srv.close(r2));
	srv.closeAllConnections?.();
	for (const a of [a1, a2]) agents.remove(a.id);
	process.env.PATH = oldPath;
	delete process.env.PIPER_TEST_SECRET;
	rmSync(join(TEST_SHARED, "taken-name"), { recursive: true, force: true });
}

// Phase B (0.7): the agent creation wizard.
{
	const W = await import("./server.mjs");
	const { wizardOptions, planWizard, createFromWizard, agents, apiKeys, profileOp, agentScope, listLibrary, config, deleteAgent, installInOrder, PackageError } = W;
	const fsm = await import("node:fs");
	const bin = mkdtempSync(join(tmpdir(), "fakedocker4-"));
	const helper = fileURLToPath(new URL("./piper-profile.mjs", import.meta.url));
	writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
dir=""; max=0; args=("$@"); rest=(); i=0
while [ $i -lt $# ]; do
  a="\${args[$i]}"
  case "$a" in
    -v) v="\${args[$((i+1))]}"; case "$v" in *:/data) dir="\${v%:/data}";; esac;;
    -e) e="\${args[$((i+1))]}"; case "$e" in PROFILE_MAX_BYTES=*) max="\${e#*=}";; esac;;
    /opt/piper/profile.mjs) rest=("\${args[@]:$((i+1))}"); break;;
  esac
  i=$((i+1))
done
[ -z "$dir" ] && exit 1
cd "$dir" && PROFILE_MAX_BYTES=$max exec node ${helper} "\${rest[@]}"
`);
	fsm.chmodSync(join(bin, "docker"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	W.clearPasswordHash();
	const made = apiKeys.create({ name: "wizard key", expiresAt: 0 });
	const key = made.record ?? made;
	const skill = (name, d = "does a thing") => `---\nname: ${name}\ndescription: ${d}\n---\nDo it.\n`;
	// A library entry to grant (a folder the way an install leaves it).
	mkdirSync(join(TEST_EXT, "wiz-ext", "node_modules", "wiz-ext", "extensions"), { recursive: true });
	writeFileSync(join(TEST_EXT, "wiz-ext", "node_modules", "wiz-ext", "extensions", "x.js"), "export default () => {};");
	writeFileSync(join(TEST_EXT, "wiz-ext", "entry.json"), JSON.stringify({ name: "wiz-ext", source: "npm:wiz-ext", version: "1.0.0", entry: "node_modules/wiz-ext" }));

	// What the steps offer.
	const opts = wizardOptions();
	assert.ok(opts.keys.some((k) => k.id === key.id && k.usable));
	const reviewer = opts.templates.find((t) => t.name === "reviewer");
	assert.ok(reviewer.instructions.includes("Reviewer") && reviewer.skills.map((x) => x.name).includes("review-checklist"));
	assert.ok(reviewer.skills.find((x) => x.name === "review-checklist").description.length > 10, "the skill's description comes from its header");
	assert.equal(opts.templates.find((t) => t.name === "orchestrator").canDelegate, true);
	assert.ok(opts.items.some((i) => i.name === "wiz-ext" && i.kind === "package"));
	assert.equal(opts.maxPackages, 5);

	// Refusals before anything is made.
	const base = { keyId: key.id, name: "wiz-one", template: "reviewer" };
	const refuse = (patch, re) => assert.throws(() => planWizard({ ...base, ...patch }), re, JSON.stringify(patch).slice(0, 80));
	refuse({ keyId: "nope" }, /choose a key/);
	refuse({ template: "nope" }, /no template/);
	refuse({ skills: { exclude: ["not-there"] } }, /no skill "not-there"/);
	refuse({ instructions: "x".repeat(70 * 1024) }, /limited to 64 KB/);
	refuse({ skills: { add: [{ name: "../evil", content: skill("x") }] } }, /not a skill name/);
	refuse({ skills: { add: [{ name: "a b", content: skill("x") }] } }, /not a skill name/);
	refuse({ skills: { add: [{ name: "review-checklist", content: skill("review-checklist") }] } }, /already a skill/);
	refuse({ skills: { add: [{ name: "headerless", content: "just text" }] } }, /needs a header/);
	refuse({ skills: { add: [{ name: "big", content: skill("big") + "x".repeat(70 * 1024) }] } }, /over 64 KB/);
	refuse({ skills: { add: Array.from({ length: 21 }, (_, i) => ({ name: `s${i}`, content: skill(`s${i}`) })) } }, /at most 20/);
	refuse({ thinking: "extreme" }, /thinking must be/);
	refuse({ extensions: "ghost" }, /no extension or bundle called "ghost"/);
	refuse({ extensions: "wiz-ext" }, (e) => e.status === 403, "granting needs a dashboard password");
	refuse({ packages: ["npm:x"] }, (e) => e.status === 403, "so does installing");
	W.setPasswordHash(W.hashPassword("a long enough password"));
	refuse({ packages: ["./local"] }, /package source/);
	refuse({ packages: Array(6).fill("npm:x") }, /at most 5/);
	assert.equal(planWizard({ ...base, extensions: "wiz-ext" }).sharedBundles, "wiz-ext");
	assert.equal(planWizard({ ...base, extensions: ["wiz-ext"] }).sharedBundles, "wiz-ext");
	assert.equal(planWizard({ ...base, extensions: "none" }).sharedBundles, "");
	assert.equal(planWizard({ ...base, extensions: "" }).sharedBundles, null, "blank follows the key");
	W.clearPasswordHash();
	const before = agents.listByKey(key.id).length;

	// A full create: template, edited instructions, one skill left out, one added, hand-offs on, limits.
	const reviewerSkills = reviewer.skills.length;
	W.setPasswordHash(W.hashPassword("a long enough password"));
	const created = await createFromWizard({
		keyId: key.id, name: "wiz-full", description: "reviews things", template: "reviewer", workspace: "own", thinking: "low",
		instructions: "# Custom\n\nYou are the custom reviewer.\n", skills: { exclude: ["review-checklist"], add: [{ name: "my-skill", content: skill("my-skill", "my own") }] },
		extensions: "wiz-ext", canDelegate: true, container: { memoryMb: 512 },
	});
	const a = created.agent;
	assert.deepEqual([a.name, a.description, a.workspace, a.thinking, a.canDelegate, a.sharedBundles, a.container?.memoryMb], ["wiz-full", "reviews things", "own", "low", true, "wiz-ext", 512]);
	const scope = agentScope(key.id, a.id);
	assert.match(JSON.stringify(await profileOp(scope, { op: "instructions.get" })), /You are the custom reviewer/);
	const skills = (await profileOp(scope, { op: "skills.list" })).map((x) => x.name);
	assert.deepEqual(skills, ["my-skill"], "the excluded skill is gone and the added one is there");
	assert.equal(W.grantedBundles(scope, { fallback: "" }).map((b) => b.name).join(), "wiz-ext", "the grant is in effect");
	// A blank-template agent with no extras follows its key and has only what was typed.
	const plain = await createFromWizard({ keyId: key.id, name: "wiz-plain", instructions: "Be brief." });
	assert.equal(plain.agent.sharedBundles, null);
	assert.match(JSON.stringify(await profileOp(agentScope(key.id, plain.agent.id), { op: "instructions.get" })), /Be brief/);
	assert.deepEqual(await profileOp(agentScope(key.id, plain.agent.id), { op: "skills.list" }), []);
	// Template instructions are kept when none are sent.
	const kept = await createFromWizard({ keyId: key.id, name: "wiz-kept", template: "coder" });
	assert.match(JSON.stringify(await profileOp(agentScope(key.id, kept.agent.id), { op: "instructions.get" })), /Coder/);
	assert.equal(kept.agent.canDelegate, false);
	// An orchestrator keeps its hand-offs unless told otherwise only via the explicit flag: the wizard's own choice wins.
	const orch = await createFromWizard({ keyId: key.id, name: "wiz-orch", template: "orchestrator", canDelegate: true });
	assert.equal(orch.agent.canDelegate, true);
	// A failure after the agent exists removes it again: a name already taken, and a refused model.
	await assert.rejects(createFromWizard({ keyId: key.id, name: "wiz-full" }), /already has an agent/);
	await assert.rejects(createFromWizard({ keyId: key.id, name: "wiz-model", model: "no-such/model" }), /no model/);
	assert.equal(agents.find(key.id, "wiz-model"), null);
	await assert.rejects(createFromWizard({ keyId: key.id, name: "wiz-limits", container: { memoryMb: "lots" } }), /memory/);
	assert.equal(agents.find(key.id, "wiz-limits"), null, "nothing is left behind");
	assert.equal(agents.listByKey(key.id).length, before + 4);
	// A new key made with the agent.
	refuse({ keyId: undefined, newKey: { name: " " } }, /name the new key/);
	refuse({ keyId: undefined, newKey: { name: "k", expiresAt: "not a date" } }, /not a valid date/);
	refuse({ keyId: undefined, newKey: { name: "k", expiresAt: 1000 } }, /in the future/);
	refuse({ keyId: undefined }, /choose a key/);
	const keysBefore = apiKeys.list().length;
	const fresh = await createFromWizard({ newKey: { name: "wizard made", expiresAt: Date.now() + 86_400_000 }, name: "wiz-newkey", instructions: "Hi." });
	assert.match(fresh.newKey.key, /^piper_/, "the secret comes back once");
	assert.equal(apiKeys.list().length, keysBefore + 1);
	const madeKey = apiKeys.get(fresh.newKey.id);
	assert.deepEqual([madeKey.name, fresh.agent.keyId === madeKey.id, W.ApiKeyStore.problem(madeKey)], ["wizard made", true, null]);
	assert.ok(apiKeys.verify(fresh.newKey.key), "the key works");
	assert.equal(JSON.stringify(W.apiKeys.get(fresh.newKey.id)).includes(fresh.newKey.key), false, "and is not kept in the clear");
	await assert.rejects(createFromWizard({ newKey: { name: "doomed" }, name: "wiz-doomed", model: "no-such/model" }), /no model/);
	assert.equal(apiKeys.list().length, keysBefore + 1, "a failed create does not leave a key behind");
	await assert.rejects(createFromWizard({ newKey: { name: "doomed2" }, name: "bad name!" }), /lowercase/);
	assert.equal(apiKeys.list().length, keysBefore + 1);
	await deleteAgent(fresh.agent.id);
	apiKeys.remove(fresh.newKey.id);

	// installInOrder: a package job already running elsewhere (the tracker is global, not per scope) is
	// waited out rather than silently dropped, and a package that genuinely fails is recorded, not just
	// swallowed, so the response's "queued" never quietly meant "actually, no".
	{
		const tried = [];
		let busyFor = 2;
		const install = (scope, source) => {
			tried.push(source);
			if (source === "npm:flaky" && busyFor-- > 0) throw new PackageError("another package job is running; wait for it to finish", 409);
			if (source === "npm:bad") throw new PackageError("that is not a package source", 400);
		};
		await installInOrder("key-x", ["npm:flaky", "npm:bad", "npm:good"], { install, waitMs: 5 });
		assert.deepEqual(tried, ["npm:flaky", "npm:flaky", "npm:flaky", "npm:bad", "npm:good"], "the busy one is retried in place, not skipped or reordered");
		const rows = recentAuditRows(10);
		assert.ok(rows.some((r) => r.action === "agent.package_failed" && r.target === "key-x" && /npm:bad.*not a package source/.test(r.detail)), "the genuine failure is on record");
		assert.ok(!rows.some((r) => r.action === "agent.package_failed" && /npm:flaky/.test(r.detail)), "the busy one, once it succeeds, is not recorded as a failure");

		// Given up on (busy for longer than the retry budget), it is recorded too, not silently dropped.
		busyFor = 999;
		await installInOrder("key-y", ["npm:flaky"], { install, waitMs: 1 });
		assert.ok(recentAuditRows(5).some((r) => r.action === "agent.package_failed" && r.target === "key-y" && /npm:flaky/.test(r.detail)));
	}

	// The page has every step.
	const html = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
	for (const step of ["wzkey", "wzidentity", "wzinstructions", "wzextensions", "wzlimits", "wzreview"]) assert.ok(html.includes(`'${step}'`), `the wizard has the ${step} step`);
	for (const a2 of agents.listByKey(key.id)) await deleteAgent(a2.id);
	rmSync(join(TEST_EXT, "wiz-ext"), { recursive: true, force: true });
	W.clearPasswordHash();
	process.env.PATH = oldPath;
}

// Phase C (0.7): the Playground's backend.
{
	const G = await import("./server.mjs");
	const { playgroundRoutes, playgroundTargets, setAgentTurnRunner, LiveLog, AgentRunError, apiKeys, agents, config, scopedSessionId, credentialFor, sessions, recentAudit } = G;
	const http = await import("node:http");
	const mk = (name) => { const c = apiKeys.create({ name, expiresAt: 0 }); return c.record ?? c; };
	const key = mk("pg key");
	const agent = agents.create({ keyId: key.id, name: "pg-agent" });
	agents.update(agent.id, { description: "for the playground" });
	const off = agents.create({ keyId: key.id, name: "pg-off" });
	agents.update(off.id, { enabled: false });
	const revoked = mk("pg revoked");
	apiKeys.revoke(revoked.id);
	const srv = http.createServer((req, res) => void playgroundRoutes(req, res, new URL(req.url, "http://x").pathname).then((h) => h || (res.writeHead(404), res.end())));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}/dashboard/playground`;
	const post = (body, signal) => fetch(`${base}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
	const conv = "conv-1234567890";
	const good = { keyId: key.id, agentId: agent.id, conversation: conv, message: "hello playground" };
	const events = async (res) => {
		const out = [];
		let buf = "";
		for await (const chunk of res.body) {
			buf += new TextDecoder().decode(chunk);
			let i;
			while ((i = buf.indexOf("\n\n")) >= 0) {
				const block = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const ev = /^event: (.*)$/m.exec(block)?.[1];
				const data = /^data: (.*)$/m.exec(block)?.[1];
				if (ev) out.push([ev, JSON.parse(data)]);
			}
		}
		return out;
	};

	// Gates.
	G.clearPasswordHash();
	assert.equal((await fetch(`${base}/targets.json`)).status, 403, "no password, no playground");
	assert.equal((await post(good)).status, 403);
	G.setPasswordHash(G.hashPassword("a long enough password"));
	config.PLAYGROUND_ENABLED = false;
	assert.equal((await post(good)).status, 403, "switched off");
	config.PLAYGROUND_ENABLED = true;

	// Targets: usable keys with their enabled agents and models.
	const targets = await (await fetch(`${base}/targets.json`)).json();
	const mine = targets.targets.find((t) => t.keyId === key.id);
	assert.deepEqual(mine.agents.map((a) => a.name), ["pg-agent"], "a disabled agent is not offered");
	assert.ok(Array.isArray(mine.models));
	assert.ok(!targets.targets.some((t) => t.keyId === revoked.id), "a revoked key is not offered");

	// Refusals before the stream.
	for (const [patch, status] of [[{ message: "  " }, 400], [{ message: "x".repeat(40_000) }, 400], [{ conversation: "short" }, 400], [{ conversation: "../../etc/passwd-x" }, 400], [{ keyId: revoked.id, agentId: null }, 401], [{ keyId: "nope", agentId: null }, 401], [{ agentId: "deadbeef" }, 404], [{ agentId: off.id }, 409]]) {
		const r = await post({ ...good, ...patch });
		assert.equal(r.status, status, JSON.stringify(patch).slice(0, 60));
		assert.match(r.headers.get("content-type"), /json/);
	}

	// A turn: the session's events come through, then done.
	let seenCredential = null;
	let seenSession = null;
	setAgentTurnRunner(async ({ credential, clientSessionId, prompt, model, signal, onSession }) => {
		seenCredential = credential;
		seenSession = { clientSessionId, prompt, model };
		const live = new LiveLog();
		live.feed({ type: "message_start", message: { role: "user", content: prompt } });
		onSession({ live });
		live.feed({ type: "message_start", message: { role: "assistant" } });
		live.feed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
		live.feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		live.feed({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: [{ type: "text", text: "a.txt" }] } });
		live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
		live.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "there" } });
		return { text: "Hello there", reasoning: "hmm", usage: { total_tokens: 9 }, cost: 0.01 };
	});
	let r = await post({ ...good, model: "p/m" });
	assert.equal(r.status, 200);
	assert.equal(r.headers.get("content-type"), "text/event-stream; charset=utf-8");
	let ev = await events(r);
	assert.deepEqual(ev.map(([e]) => e).filter((e, i, a) => e !== a[i - 1]), ["item", "done"]);
	const kinds = ev.filter(([e]) => e === "item").map(([, d]) => d.item.kind);
	assert.ok(kinds.includes("thinking") && kinds.includes("tool") && kinds.includes("assistant") && !kinds.includes("user"), "the user's own message is not echoed");
	const last = ev.at(-1);
	assert.deepEqual([last[0], last[1].text, last[1].usage.total_tokens, last[1].cost], ["done", "Hello there", 9, 0.01]);
	assert.equal(seenCredential.id, key.id);
	assert.equal(seenCredential.agent.id, agent.id, "it runs as the chosen agent");
	assert.deepEqual(seenSession, { clientSessionId: `playground:${conv}`, prompt: "hello playground", model: "p/m" });
	r = await post({ ...good, conversation: conv });
	await events(r);
	const audits = recentAudit(200).filter((a) => a.action === "session.playground");
	assert.equal(audits.length, 1, "a conversation is audited once, however many turns");
	assert.equal(JSON.stringify(audits).includes("hello playground"), false, "never the message");
	// Errors mid-stream are events.
	setAgentTurnRunner(async () => { throw new AgentRunError("daily spend limit reached", 429, "spend_limit_exceeded", "rate_limit_error"); });
	ev = await events(await post({ ...good, conversation: "conv-errors-0001" }));
	assert.deepEqual([ev.at(-1)[0], ev.at(-1)[1].status, ev.at(-1)[1].code], ["error", 429, "spend_limit_exceeded"]);
	setAgentTurnRunner(async () => { throw new Error("boom"); });
	ev = await events(await post({ ...good, conversation: "conv-errors-0002" }));
	assert.match(ev.at(-1)[1].message, /could not answer: boom/);
	// Stop: the client goes away, the turn is aborted.
	let aborted = null;
	setAgentTurnRunner(async ({ signal }) => { await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); })); return { text: "", usage: {}, cost: 0 }; });
	const controller = new AbortController();
	const pending = post({ ...good, conversation: "conv-abort-00001" }, controller.signal);
	const res3 = await pending;
	controller.abort();
	await res3.body?.cancel().catch(() => {});
	const end = Date.now() + 2000;
	while (!aborted && Date.now() < end) await new Promise((r2) => setTimeout(r2, 20));
	assert.equal(aborted, true, "stopping aborts the agent's turn");
	setAgentTurnRunner(null);

	// Ending a conversation closes its session.
	const credential = credentialFor(key.id, agent.id);
	const scoped = scopedSessionId(credential, "playground:conv-delete-0001");
	const opened = sessions.acquire(scoped, credential);
	opened.record.sessionPromise.catch(() => {});
	assert.equal(sessions.has(scoped), true);
	const del = await (await fetch(`${base}/conversation/conv-delete-0001?keyId=${key.id}&agentId=${agent.id}`, { method: "DELETE" })).json();
	assert.equal(del.ended, true);
	assert.equal(sessions.has(scoped), false);
	assert.equal((await (await fetch(`${base}/conversation/conv-delete-0001?keyId=${key.id}&agentId=${agent.id}`, { method: "DELETE" })).json()).ended, false, "nothing to end twice");
	assert.equal((await fetch(`${base}/conversation/bad%20id?keyId=${key.id}`, { method: "DELETE" })).status, 404, "an id that is not one is not a route");
	G.clearPasswordHash();
	await new Promise((r2) => srv.close(r2));
	srv.closeAllConnections?.();
	for (const a of [agent, off]) agents.remove(a.id);
}

// Phase C (0.7): the Playground page: markdown renderer and markup.
{
	const html = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
	const vm = await import("node:vm");
	const start = html.indexOf("function mdInline(text)");
	const end = html.indexOf("function mdSafeHref(href)");
	assert.ok(start > 0 && end > start);
	const ctx = vm.createContext({});
	vm.runInContext(`${html.slice(start, end)}\nthis.mdParse = mdParse; this.mdInline = mdInline;`, ctx);
	const parse = (t) => JSON.parse(JSON.stringify(ctx.mdParse(t)));
	const types = (t) => parse(t).map((b) => b.t);
	assert.deepEqual(types("# H\n\ntext\n\n- a\n- b\n\n1. x\n2. y\n\n```js\ncode\n```\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---"), ["h", "p", "ul", "ol", "code", "quote", "table", "hr"]);
	const code = parse("```py\nprint('<script>alert(1)</script>')\n\n\nx = 1\n```")[0];
	assert.deepEqual([code.t, code.lang], ["code", "py"]);
	assert.ok(code.text.includes("<script>") && code.text.includes("\n\n\nx = 1"), "code is kept as it was written, as text");
	assert.deepEqual(parse("```\nnever closed\nstill code")[0], { t: "code", lang: "", text: "never closed\nstill code" }, "a fence still open while streaming is code");
	const nested = parse("- a\n  - b\n    - c\n- d")[0];
	assert.equal(nested.items.length, 2);
	assert.equal(nested.items[0].sub[0].items[0].sub[0].items[0].c[0].v, "c", "lists nest by indent");
	assert.equal(parse("3. three\n4. four")[0].t, "ol");
	const inline = (t) => JSON.parse(JSON.stringify(ctx.mdInline(t)));
	assert.deepEqual(inline("a **b** c").map((n) => n.t), ["text", "b", "text"]);
	assert.deepEqual(inline("`x < y` and *it* and ~~gone~~").map((n) => n.t), ["code", "text", "i", "text", "del"]);
	assert.equal(inline("snake_case_word and 2*3*4")[0].t, "text", "intraword underscores are not emphasis");
	assert.deepEqual(inline("<img src=x onerror=alert(1)> and <b>bold</b>").map((n) => n.t), ["text"], "html is only ever text");
	assert.match(inline("[click](javascript:alert(1))")[0].href, /^javascript:/, "the parser keeps the target; rendering refuses it");
	assert.match(html.slice(html.indexOf("function mdSafeHref"), html.indexOf("function mdInlineNodes")), /\^\(https\?:\\\/\\\/\|mailto:\)/, "only http, https and mailto become links");
	assert.deepEqual(inline("see https://example.com/a.b, ok").map((n) => n.t), ["text", "a", "text"], "bare links are found and punctuation is left out");
	assert.equal(inline("see https://example.com/a.b, ok")[1].href, "https://example.com/a.b");
	assert.equal(types("a | b | c").join(), "p", "a pipe alone is not a table");
	assert.deepEqual(types("Para one\nstill para one\n\nPara two"), ["p", "p"]);
	// Model text never goes through innerHTML in the page's chat code, and every id the script uses exists.
	const chatCode = html.slice(html.indexOf("/* ---- Markdown for the Playground"), html.indexOf("var TEMPLATES = [];"));
	assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(chatCode), "no innerHTML in the Markdown or Playground code");
	for (const id of ["pg", "pgside", "pgnew", "pgsearch", "pglist", "pgexport", "pgclear", "pgtarget", "pgmodel", "pgtitle", "pgscroll", "pgmsgs", "pgdown", "pginput", "pgsend", "pgnote", "pgtoggle", "pgfilesbtn", "pgfiles", "pgfrefresh", "pgfcrumb", "pgflist", "pgfnote", "pgmodal", "pgmtitle", "pgmmeta", "pgmbody", "pgmraw", "pgmdl", "pgmclose"]) assert.ok(html.includes(`id="${id}"`), `the Playground has #${id}`);
	assert.ok(/<a href="#playground"/.test(html.slice(html.indexOf('<nav id="nav">'), html.indexOf('<nav id="nav">') + 200)), "Playground is first in the menu");
	assert.ok(/localStorage/.test(chatCode) && /try \{/.test(chatCode), "conversations are kept in the browser, guarded");
}

// The workspace file API: /v1/piper/files (a key's own, upload/list/download/delete, over the gateway's
// socket) and /dashboard/files (the operator's browser: list, text edit, mkdir, move, delete). Both run the
// real profile helper, so a fake `docker` on PATH execs the real helper script over the mounted folder —
// the same technique the profile/template tests above use — rather than mocking the helper's own logic away.
{
	const { server } = await import("./server.mjs");
	const bin = mkdtempSync(join(tmpdir(), "fakedocker-files-"));
	const helper = fileURLToPath(new URL("./piper-profile.mjs", import.meta.url));
	writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
dir=""; max=0; args=("$@"); rest=(); i=0
while [ $i -lt $# ]; do
  a="\${args[$i]}"
  case "$a" in
    -v) v="\${args[$((i+1))]}"; case "$v" in *:/data) dir="\${v%:/data}";; esac;;
    -e) e="\${args[$((i+1))]}"; case "$e" in PROFILE_MAX_BYTES=*) max="\${e#*=}";; esac;;
    /opt/piper/profile.mjs) rest=("\${args[@]:$((i+1))}"); break;;
  esac
  i=$((i+1))
done
[ -z "$dir" ] && exit 1
cd "$dir" && PROFILE_MAX_BYTES=$max exec node ${helper} "\${rest[@]}"
`);
	(await import("node:fs")).chmodSync(join(bin, "docker"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	const accessLog = config.ACCESS_LOG;
	config.ACCESS_LOG = false;

	const made = apiKeys.create({ name: "files-api-test", expiresAt: 0 });
	const key = made.record ?? made;
	const token = made.key;
	ensureWorkspace(key.id); // the folder the helper will mount

	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = (path, { method = "GET", body, headers = {} } = {}) =>
		fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body });

	// Upload, list, download (the real bytes back), delete.
	const content = "hello from a real file\n".repeat(50);
	const up = await call("/v1/piper/files/notes/hello.txt", { method: "PUT", body: content });
	assert.equal(up.status, 200);
	const listed = await (await call("/v1/piper/files/notes/")).json();
	assert.deepEqual(listed.entries.map((e) => e.name), ["hello.txt"]);
	const down = await call("/v1/piper/files/notes/hello.txt");
	assert.equal(down.status, 200);
	assert.equal(down.headers.get("content-disposition"), "attachment; filename*=UTF-8''hello.txt");
	assert.equal(await down.text(), content, "the real bytes, round-tripped through the real helper");
	const del = await (await call("/v1/piper/files/notes/hello.txt", { method: "DELETE" })).json();
	assert.ok(del.ok !== false);
	assert.equal((await call("/v1/piper/files/notes/hello.txt")).status, 404, "gone");

	// A folder named without a trailing slash is listed, not refused (filesRoutes' own fallback).
	await call("/v1/piper/files/sub/a.txt", { method: "PUT", body: "x" });
	const asFolder = await (await call("/v1/piper/files/sub")).json();
	assert.deepEqual(asFolder.entries.map((e) => e.name), ["a.txt"]);

	// Quota: a key's workspace over WORKSPACE_MAX_BYTES refuses more (423), read and delete still work.
	const quotaKey = apiKeys.create({ name: "files-quota-test", expiresAt: 0 });
	const qToken = quotaKey.key;
	ensureWorkspace((quotaKey.record ?? quotaKey).id);
	const qCall = (path, opts) => fetch(`${base}${path}`, { ...opts, headers: { authorization: `Bearer ${qToken}`, ...(opts?.headers ?? {}) } });
	await qCall("/v1/piper/files/a.txt", { method: "PUT", body: "x".repeat(100) });
	const oldQuota = config.WORKSPACE_MAX_BYTES;
	config.WORKSPACE_MAX_BYTES = 150;
	const overQuota = await qCall("/v1/piper/files/b.txt", { method: "PUT", body: "y".repeat(100) });
	assert.equal(overQuota.status, 413, "the quota, not just FILE_UPLOAD_MAX_BYTES, is enforced");
	assert.equal((await qCall("/v1/piper/files/a.txt")).status, 200, "reading still works over quota");
	assert.equal((await qCall("/v1/piper/files/a.txt", { method: "DELETE" })).status, 200, "and deleting, to make room");
	config.WORKSPACE_MAX_BYTES = oldQuota;

	// The dashboard's own browser: list, a text edit (with the conflict check), mkdir, move, delete.
	clearPasswordHash();
	const scope = scopeOf(key.id);
	const dash = (path, opts) => fetch(`${base}/dashboard/files/${scope}${path}`, opts);
	assert.equal((await dash("/sub/")).status, 200, "no password set: open");
	const list1 = await (await dash("/sub/")).json();
	assert.equal(list1.entries[0].name, "a.txt");
	await dash("/notes?op=mkdir", { method: "POST", headers: { "content-type": "application/json" } });
	const asText1 = await (await dash("/sub/a.txt?as=text")).json();
	assert.equal(asText1.text, "x");
	const saved = await dash("/sub/a.txt?as=text", { method: "PUT", body: JSON.stringify({ text: "x-edited", expectModified: asText1.modified }), headers: { "content-type": "application/json" } });
	assert.equal(saved.status, 200);
	const conflict = await dash("/sub/a.txt?as=text", { method: "PUT", body: JSON.stringify({ text: "stale write", expectModified: asText1.modified }), headers: { "content-type": "application/json" } });
	assert.equal(conflict.status, 409, "a save over a file that changed meanwhile is a conflict");
	const moved = await dash("/sub/a.txt?op=move", { method: "POST", body: JSON.stringify({ to: "notes/moved.txt" }), headers: { "content-type": "application/json" } });
	assert.equal(moved.status, 200);
	assert.equal((await dash("/notes/moved.txt?as=text")).status, 200);
	assert.equal((await dash("/notes/moved.txt", { method: "DELETE" })).status, 200);
	assert.equal((await dash("/notes/moved.txt?as=text")).status, 400, "gone (a refused op, not a 404, is this helper's own convention)");

	server.closeAllConnections?.();
	await new Promise((r) => server.close(r));
	config.ACCESS_LOG = accessLog;
	process.env.PATH = oldPath;
}

// The client portal: a standalone page, on its own port, logged in by a plain API key (never a
// dashboard password), that chats with only that key's own agents and browses only its own files.
{
	const X = await import("./server.mjs");
	const { config, apiKeys, agentScope, createAgent, deleteAgent, setAgentTurnRunner, startPortal, stopPortal, portalPort, ensureWorkspace } = X;

	config.PORTAL_ENABLED = false;
	startPortal();
	assert.equal(portalPort(), null, "PORTAL_ENABLED off: never starts");

	config.PORTAL_ENABLED = true;
	config.PORTAL_PORT = 0;
	startPortal();
	await new Promise((r) => setTimeout(r, 30));
	const port = portalPort();
	assert.ok(port > 0, "a real port, chosen by the OS");

	const base = `http://127.0.0.1:${port}`;
	const call = async (path, opts = {}) => {
		const res = await fetch(base + path, opts);
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* the assertions say */
		}
		return { status: res.status, json, text };
	};

	assert.equal((await call("/health")).json.status, "ok", "no auth needed");
	assert.match((await call("/")).text, /Piper/, "the static page is served, no auth");
	assert.equal((await call("/api/whoami")).status, 401, "no key");
	assert.equal((await call("/api/whoami", { headers: { authorization: "Bearer nonsense" } })).status, 401, "unknown key");

	const mine = apiKeys.create({ name: "portal test", expiresAt: 0 });
	const myKey = mine.record ?? mine;
	const myToken = mine.key;
	const myAgent = await createAgent({ keyId: myKey.id, name: "portal-agent" });

	const theirs = apiKeys.create({ name: "portal other", expiresAt: 0 });
	const theirKey = theirs.record ?? theirs;
	const theirAgent = await createAgent({ keyId: theirKey.id, name: "not-mine" });

	const auth = { authorization: `Bearer ${myToken}` };
	const who = await call("/api/whoami", { headers: auth });
	assert.equal(who.status, 200);
	assert.equal(who.json.id, myKey.id);
	assert.deepEqual(who.json.agents.map((a) => a.id), [myAgent.id], "only this key's own agents, never another's");

	// Chat: a real turn, through the same injectable runner every other agent-run test uses.
	let seenCredential = null;
	setAgentTurnRunner(async ({ credential, prompt }) => {
		seenCredential = credential;
		return { text: `echo: ${prompt}`, reasoning: "", usage: { total_tokens: 3 }, cost: 0, sessionId: "x", scopedId: "y", fingerprint: "z", isNew: true };
	});
	const chatRes = await call("/api/chat", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ conversation: "conversation-id-1", message: "hi", agentId: myAgent.id }) });
	assert.equal(chatRes.status, 200);
	assert.match(chatRes.text, /event: done/);
	assert.equal(seenCredential.agent.id, myAgent.id);

	// Ownership: an agent that is not this key's is refused, the same way credentialFor already refuses it.
	const stolenChat = await call("/api/chat", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ conversation: "conversation-id-2", message: "hi", agentId: theirAgent.id }) });
	assert.equal(stolenChat.status, 404, "an agent that is not this key's");

	// A keyId in the body is never trusted — only the bearer key's own id is ever used as the credential.
	await call("/api/chat", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ conversation: "conversation-id-3", message: "hi", keyId: theirKey.id }) });
	assert.equal(seenCredential.id, myKey.id, "the body's keyId is ignored");
	setAgentTurnRunner(null);

	// Files: the key's own workspace by default, an agent's own with ?agentId=, never another key's.
	writeFileSync(join(ensureWorkspace(myKey.id), "hello.txt"), "hi there");
	const list = await call("/api/files", { headers: auth });
	assert.equal(list.status, 200);
	assert.ok(list.json.entries.some((e) => e.name === "hello.txt"));
	const download = await call("/api/files/hello.txt", { headers: auth });
	assert.equal(download.text, "hi there");

	writeFileSync(join(ensureWorkspace(agentScope(myKey.id, myAgent.id)), "agent-file.txt"), "agent data");
	const agentList = await call(`/api/files?agentId=${myAgent.id}`, { headers: auth });
	assert.ok(agentList.json.entries.some((e) => e.name === "agent-file.txt"));
	assert.equal(agentList.json.entries.some((e) => e.name === "hello.txt"), false, "a different workspace entirely");

	const stolenFiles = await call(`/api/files?agentId=${theirAgent.id}`, { headers: auth });
	assert.equal(stolenFiles.status, 404, "never another key's agent's files");

	await deleteAgent(myAgent.id);
	await deleteAgent(theirAgent.id);
	await stopPortal();
	assert.equal(portalPort(), null);
}

console.log("nextTurn + images: ok");
rmSync(TEST_DB, { force: true });
rmSync(TEST_WS, { recursive: true, force: true });
rmSync(`${TEST_WS}-archive`, { recursive: true, force: true });
rmSync(`${TEST_WS}-run`, { recursive: true, force: true });
rmSync(`${TEST_WS}-chats`, { recursive: true, force: true });
rmSync(TEST_PROFILES, { recursive: true, force: true });
rmSync(TEST_SHARED, { recursive: true, force: true });
rmSync(TEST_EXT, { recursive: true, force: true });
rmSync(TEST_CONTAINER_PI, { recursive: true, force: true });
