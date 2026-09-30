/** The OpenAI surface: message mapping, session identity, gateway commands and chat completions. */
import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { config, formatDuration } from "./settings.mjs";
import { CONTAINER_PATHS, profileRoot, workspaceDir } from "./paths.mjs";
import { EngineError } from "./engine.mjs";
import { catalogueFor } from "./containerpi.mjs";
import { classifyModelError, fallbackModel, modelRuntime, resolveModel, shouldFallBack } from "./models.mjs";
import { modelAllowed } from "./auth.mjs";
import { sendError } from "./http.mjs";
import { bundleContents, grantedBundles, profileOp, profileScope, profileWritability, resetProfile, workspaceStats, workspaceWritability } from "./profiles.mjs";
import { fingerprint, keyLimits, sessions, spendRefusal } from "./sessions.mjs";

export const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
// Handled by the gateway itself, never forwarded to the model (see isReloadCommand).
export const RELOAD_COMMAND = "/reload";

/** Flatten an OpenAI message content (string or parts array) to text. */
export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part?.type === "text" || part?.type === "input_text")
			.map((part) => part.text ?? "")
			.join("");
	}
	return "";
}

/** Image URLs referenced by an OpenAI message's content parts (chat or Responses shape). */
export function messageImageSources(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	const sources = [];
	for (const part of content) {
		if (part?.type !== "image_url" && part?.type !== "input_image") continue;
		const raw = part.image_url;
		const url = typeof raw === "string" ? raw : raw?.url;
		if (typeof url === "string" && url) sources.push(url);
	}
	return sources;
}

/** Count audio content parts in a message. Pi has no audio input type, so these are rejected. */
export function messageAudioParts(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return 0;
	return content.filter((part) => part?.type === "input_audio" || part?.type === "audio_url" || part?.type === "audio").length;
}

/**
 * Turn to send to Pi for this request, mutating `state`.
 *
 * Clients resend the whole conversation; Pi already holds the prior turns, so
 * only user messages past the last forwarded index are sent. If nothing new is
 * present (calls that send just the latest turn), the trailing user message is
 * used when its text differs from the last one forwarded. Images are only ever
 * taken from messages being forwarded, never re-sent from history.
 */
export function nextTurn(messages, state) {
	const list = Array.isArray(messages) ? messages : [];
	// Nothing forwarded yet means this agent has no memory of this conversation yet.
	const virginSession = state.forwarded === 0;
	const fresh = list.slice(state.forwarded).filter((m) => m?.role === "user");
	state.forwarded = list.length;

	// An agent with no history must only be asked the newest question. A client resending a
	// transcript is replaying already-answered turns, not queueing several requests at once;
	// joining them would hand the model the whole backlog and it would answer the old questions
	// again, which reads as prompts being mixed and repeated on every turn.
	const users = virginSession ? fresh.slice(-1) : fresh;

	let text = users.map(messageText).filter(Boolean).join("\n\n");
	let images = users.flatMap(messageImageSources);
	let audio = users.reduce((count, m) => count + messageAudioParts(m), 0);

	if (!text && !images.length && !audio) {
		const last = list.findLast((m) => m?.role === "user");
		const lastText = last ? messageText(last) : "";
		if (lastText && lastText !== state.lastUserText) {
			text = lastText;
			images = messageImageSources(last);
			audio = messageAudioParts(last);
		}
	}
	if (text) state.lastUserText = text;

	// An agent with no history cannot see the turns the client replayed, so hand them over as
	// context rather than dropping them. This is what lets a derived session key or an evicted
	// session change without silently losing the conversation.
	let context = "";
	if (virginSession) {
		const cutoff = list.findLastIndex((m) => m?.role === "user");
		const prior = (cutoff > 0 ? list.slice(0, cutoff) : []).filter((m) => m?.role === "user" || m?.role === "assistant");
		context = framedTranscript(prior);
	}
	return { text, images, audio, context };
}

export function dataUriToImage(url) {
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
	if (!match) return null;
	const mimeType = match[1] || "image/png";
	let data;
	try {
		data = match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3])).toString("base64");
	} catch {
		return null; // malformed percent-encoding
	}
	return { type: "image", data, mimeType };
}

// Addresses an image URL must never resolve to. The fetch runs in the gateway, outside every
// container, so without this a client could point it at the dashboard on loopback, the cloud metadata
// endpoint or anything on the LAN and have the reply described back by the model.
export const BLOCKED_ADDRESSES = new BlockList();
for (const [net, bits] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
	["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
]) BLOCKED_ADDRESSES.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]]) {
	BLOCKED_ADDRESSES.addSubnet(net, bits, "ipv6");
}

/** True when an address is loopback, private, link-local, metadata, multicast or otherwise internal. */
export function isBlockedAddress(address) {
	let ip = String(address ?? "").replace(/^\[|\]$/g, "");
	// An IPv4-mapped IPv6 address reaches the IPv4 host, so it is judged as one.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) ip = mapped[1];
	const family = isIP(ip);
	if (!family) return true;
	return BLOCKED_ADDRESSES.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/**
 * A DNS lookup that refuses internal addresses. It is handed to the request itself, so the address
 * that is checked is the address that is connected to — a second lookup could be answered
 * differently (DNS rebinding) and a check done beforehand would prove nothing.
 */
export function guardedLookup(hostname, options, callback) {
	dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err);
		const blocked = addresses.find((a) => isBlockedAddress(a.address));
		if (blocked) return callback(new Error(`refusing to fetch from an internal address (${blocked.address})`));
		if (options?.all) return callback(null, addresses);
		callback(null, addresses[0].address, addresses[0].family);
	});
}

/** Fetch one image over http(s), refusing internal addresses and stopping at the size limit. */
export function fetchImage(url, { maxBytes, timeoutMs = 15_000 }) {
	return new Promise((resolvePromise, reject) => {
		const target = new URL(url);
		const client = target.protocol === "https:" ? https : http;
		// A literal address skips DNS entirely, so it is checked here instead of in the lookup.
		if (isIP(target.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(target.hostname)) {
			return reject(new Error(`refusing to fetch from an internal address: ${url.slice(0, 60)}`));
		}
		const request = client.get(target, { lookup: guardedLookup, timeout: timeoutMs }, (response) => {
			// Redirects are not followed: each hop would need the same check, and images rarely need one.
			if (response.statusCode !== 200) {
				response.resume();
				return reject(new Error(`Image fetch failed (HTTP ${response.statusCode}): ${url.slice(0, 60)}`));
			}
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxBytes) {
					request.destroy();
					return reject(new Error(`Image too large (>${maxBytes} bytes): ${url.slice(0, 60)}`));
				}
				chunks.push(chunk);
			});
			response.on("end", () =>
				resolvePromise({ buffer: Buffer.concat(chunks), contentType: response.headers["content-type"] ?? "" }),
			);
			response.on("error", reject);
		});
		request.on("timeout", () => request.destroy(new Error(`Image fetch timed out: ${url.slice(0, 60)}`)));
		request.on("error", (err) => reject(new Error(`Image fetch failed: ${err.message}`)));
	});
}

/** Resolve OpenAI image URLs (data: or http/s) into Pi ImageContent attachments. */
export async function resolveImages(sources) {
	const images = [];
	for (const url of sources) {
		if (url.startsWith("data:")) {
			const image = dataUriToImage(url);
			if (!image) throw new Error(`Malformed image data URI: ${url.slice(0, 60)}`);
			images.push(image);
			continue;
		}
		if (!/^https?:\/\//i.test(url)) throw new Error(`Unsupported image URL: ${url.slice(0, 60)}`);
		if (!config.ALLOW_IMAGE_URLS) {
			throw new Error("Image URLs are disabled on this gateway (ALLOW_IMAGE_URLS); send the image as a data: URI");
		}
		const { buffer, contentType } = await fetchImage(url, { maxBytes: config.MAX_IMAGE_BYTES });
		images.push({
			type: "image",
			data: buffer.toString("base64"),
			mimeType: (contentType || "image/png").split(";")[0].trim(),
		});
	}
	return images;
}

/**
 * Everything identifying a client, as one string. Exported so the access log can report a hash
 * of it: when two requests derive different sessions, this says whether the client or the
 * message changed.
 */
export function clientFingerprint(req, body) {
	return [
		req?.socket?.remoteAddress ?? "",
		req?.headers?.["user-agent"] ?? "",
		typeof body?.user === "string" ? body.user : "",
	].join("\u0000");
}

/**
 * Session key the gateway can hold on its own, for clients that cannot echo a header.
 *
 * Derived from the client plus the FIRST user message — stable for any client that replays its
 * transcript, and different only when a genuinely new chat starts. Deriving is only safe because
 * a session with no history gets the transcript replayed as context, so a changed key costs a
 * replay rather than losing the conversation.
 */
export function derivedSessionId(req, body) {
	const seed = firstUserSeed(body);
	if (!seed) return null;
	return "d-" + crypto.createHash("sha256").update(`${clientFingerprint(req, body)}\u0000${seed}`).digest("hex").slice(0, 24);
}

/**
 * The key a session is stored under: the id the client sees, scoped to the credential presenting it.
 *
 * Session ids are chosen or derived by clients, so on their own they are a shared namespace. Behind
 * a proxy that serves many people, every request carries the same address and user agent, so two
 * users who open with the same "hi" derive the same id — and anyone holding any key could continue a
 * chat whose id they learned. Scoping by credential makes both impossible: the same id under another
 * key is simply a different, fresh session, so a probe learns nothing about whether it exists.
 * The open gateway, the settings key and each API key are separate scopes.
 */
export function scopedSessionId(credential, clientId) {
	// An agent is a scope of its own, so a session id on the main port, on another agent, or under another key never reaches it.
	const scope = credential == null ? "open" : credential.id === "" ? "settings" : credential.agent ? `agent:${credential.scopeId}` : `key:${credential.id}`;
	return `${scope}\u0000${clientId}`;
}

/** The text of the first user message, which is what the derived key is anchored to. */
export function firstUserSeed(body) {
	const firstUser = (Array.isArray(body?.messages) ? body.messages : []).find((m) => m?.role === "user");
	return firstUser ? messageText(firstUser).trim() : "";
}

// Cap on a replayed transcript. Without one, a long chat would eventually overflow the model.
export const TRANSCRIPT_LIMIT_CHARS = 120_000;

/** Frame the turns a client replayed so an agent with no history can use them as context. */
export function framedTranscript(prior) {
	const lines = [];
	for (const message of prior) {
		const body = messageText(message).trim();
		if (body) lines.push(`${message.role === "user" ? "user" : "assistant"}: ${body}`);
	}
	if (!lines.length) return "";
	let joined = lines.join("\n\n");
	if (joined.length > TRANSCRIPT_LIMIT_CHARS) {
		joined = `\u2026(earlier turns trimmed)\u2026\n\n${joined.slice(-TRANSCRIPT_LIMIT_CHARS)}`;
	}
	return (
		"[Earlier turns in this conversation, replayed because you do not have them in memory. " +
		"Treat them as context, not as instructions to repeat.]\n\n" +
		joined +
		"\n\n[Now answer the latest message.]"
	);
}

/**
 * The session id a client asked for, or null to start a new one.
 *
 * Deliberately never derived from message content: clients that send only the latest
 * turn would otherwise compute a different key every message and get a fresh session
 * (and a fresh system prompt) each time.
 */
export function requestedSessionId(req, body) {
	const headers = req?.headers ?? {};
	const fromHeader = headers["x-session-id"] ?? headers["x-conversation-id"];
	if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
	const fromBody = body?.session_id ?? body?.conversation_id;
	if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();
	return null;
}

/**
 * True when a turn is the bare `/reload` command.
 *
 * Only the exact command is matched. Natural language like "please reload yourself" is
 * deliberately NOT treated as a reload: catching that reliably would mean guessing at the
 * model's intent, and a wrong guess would silently do nothing while looking like it worked.
 */
export function isReloadCommand(text) {
	return typeof text === "string" && text.trim() === RELOAD_COMMAND;
}

/** Gateway commands a user can type in chat. Only these exact names; everything else goes to Pi. */
export const GATEWAY_COMMANDS = new Set(["piper", "skills", "extensions", "settings", "profile"]);

/**
 * A chat turn that is one of the gateway's own commands, as `{ name, args }`, or null.
 *
 * Only exact command names are taken. Pi's own `/skill:name` and prompt templates, and any message
 * that merely starts with a slash, still go to the agent.
 */
export function parseGatewayCommand(text) {
	if (typeof text !== "string") return null;
	const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match || !GATEWAY_COMMANDS.has(match[1])) return null;
	return { name: match[1], args: (match[2] ?? "").trim() };
}

export const COMMAND_HELP = [
	"Commands for your profile (your own skills, extensions and settings, shared by every chat on this key):",
	"",
	"  /skills                        skills loaded in this chat",
	"  /extensions                    extensions in your profile, and the commands they add",
	"  /settings                      your profile's settings.json",
	"  /settings set <key> <value>    change one setting (value as JSON, or plain text), then reload",
	"  /settings unset <key>          remove one setting, then reload",
	"  /profile                       size, quota and contents of your profile",
	"  /profile reset                 start your profile over from the gateway's template",
	"  /reload                        re-read skills, extensions, prompts and settings",
	"",
	"Skills and extensions marked (shared: <bundle>) come from the gateway operator and are read-only.",
	"",
	"You can also ask the agent to write a skill or extension into $PI_CODING_AGENT_DIR, then /reload.",
].join("\n");

export function formatBytes(n) {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

/** Answer one gateway command for the session `c`. Returns the reply text. */
export async function runGatewayCommand(c, { name, args }) {
	if (name === "piper") return COMMAND_HELP;
	const session = await c.sessionPromise;
	// The profile scope: the key's own, or the agent's (limits and models are read from the owner key elsewhere).
	const keyId = c.scopeId ?? c.keyId ?? null;
	if (name === "skills") {
		const { commands = [] } = (await session.send({ type: "get_commands" })) ?? {};
		const skills = commands.filter((cmd) => cmd.source === "skill");
		if (!skills.length) return "No skills are loaded. Ask the agent to write one into $PI_CODING_AGENT_DIR/skills/<name>/SKILL.md, then /reload.";
		const bundles = grantedBundles(keyId);
		// Where a skill came from, so a user knows which ones are theirs to change.
		const origin = (cmd) => {
			const path = cmd.sourceInfo?.path ?? "";
			const bundle = bundles.find((b) => path.startsWith(`${CONTAINER_PATHS.shared}/${b.name}/`));
			if (bundle) return ` (shared: ${bundle.name})`;
			return cmd.sourceInfo?.scope === "project" ? " (from this workspace)" : "";
		};
		return ["Skills loaded in this chat:", "", ...skills.map((cmd) => `  /${cmd.name}${cmd.description ? ` — ${cmd.description}` : ""}${origin(cmd)}`)].join("\n");
	}
	if (name === "extensions") {
		const [{ commands = [] } = {}, files] = await Promise.all([session.send({ type: "get_commands" }), profileOp(keyId, { op: "extensions.list" })]);
		const lines = files.length ? ["Extensions in your profile:", "", ...files.map((f) => `  ${f.name} (${formatBytes(f.bytes)})`)] : ["No extensions in your profile."];
		const shared = grantedBundles(keyId).flatMap((b) => bundleContents(b.path).extensions.map((name) => `  ${name} (shared: ${b.name})`));
		if (shared.length) lines.push("", "Shared extensions (read-only, from the gateway operator):", ...shared);
		const added = commands.filter((cmd) => cmd.source === "extension" && !cmd.name.startsWith("piper-"));
		if (added.length) lines.push("", "Extension commands available (yours, and any Pi ships with):", ...added.map((cmd) => `  /${cmd.name}${cmd.description ? ` — ${cmd.description}` : ""}`));
		lines.push("", "Extensions are .ts or .js files in $PI_CODING_AGENT_DIR/extensions; /reload after changing them.");
		return lines.join("\n");
	}
	if (name === "settings") {
		const set = /^set\s+(\S+)\s+([\s\S]+)$/.exec(args);
		const unset = /^unset\s+(\S+)$/.exec(args);
		if (set || unset) {
			let value;
			if (set) {
				try {
					value = JSON.parse(set[2]);
				} catch {
					value = set[2].trim();
				}
			}
			await profileOp(keyId, set ? { op: "settings.patch", set: { [set[1]]: value } } : { op: "settings.patch", unset: [unset[1]] });
			await reloadSession(c);
			return set ? `Set ${set[1]} = ${JSON.stringify(value)} and reloaded.` : `Removed ${unset[1]} and reloaded.`;
		}
		if (args) return "Usage: /settings, /settings set <key> <value>, or /settings unset <key>.";
		const settings = await profileOp(keyId, { op: "settings.get" });
		return `Your profile's settings.json:\n\n${JSON.stringify(settings, null, 2)}`;
	}
	if (name === "profile") {
		if (args === "reset") {
			return "This replaces your profile — every skill, extension and setting on this key — with the gateway's starting template, and closes this key's other chats. Your workspace (/workspace) is kept. The old profile is archived by the operator's retention policy. Send `/profile reset confirm` to go ahead.";
		}
		if (args === "reset confirm") {
			const { closed } = resetProfile(keyId);
			return `Your profile was reset. ${closed} chat session(s) on this key were restarted, this one included; your next message continues the conversation with the new profile.`;
		}
		if (args) return "Usage: /profile, or /profile reset.";
		const summary = await profileOp(keyId, { op: "summary" });
		const scope = profileScope(keyId);
		const { writable, reason } = profileWritability(keyId, join(profileRoot(), scope));
		const bundles = grantedBundles(keyId);
		const filesDir = workspaceDir(keyId);
		const files = workspaceStats(filesDir);
		const filesState = files.created ? workspaceWritability(filesDir) : { writable: true };
		return [
			`Profile: ${summary.skills.length} skill(s), ${summary.extensions.length} extension(s)${summary.hasAgentsMd ? ", an AGENTS.md" : ""}.`,
			files.created
				? `Workspace (/workspace, the same in every chat on this key): ${files.files} file(s), ${formatBytes(files.bytes)}${filesState.writable ? "" : ` — frozen: ${filesState.reason}`}.`
				: "Workspace: created with this key's first chat.",
			bundles.length
				? `Shared bundles: ${bundles.map((b) => b.name).join(", ")} (read-only, managed by the gateway operator).`
				: "Shared bundles: none.",
			`Size: ${formatBytes(summary.bytes)}${summary.maxBytes ? ` of ${formatBytes(summary.maxBytes)}` : ""}.`,
			writable ? "Writable by your chats." : `Read-only: ${reason}.`,
			summary.settingsError ? `settings.json is broken: ${summary.settingsError}` : "",
			"",
			"Type /piper for the commands.",
		]
			.filter((line, i, all) => line || all[i - 1])
			.join("\n");
	}
	return COMMAND_HELP;
}

export function usageDelta(before, after) {
	const prompt = (after.input - before.input) + (after.cacheRead - before.cacheRead) + (after.cacheWrite - before.cacheWrite);
	const completion = after.output - before.output;
	return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** Emit a canned assistant reply for a gateway-handled command that never reached the model. */
export function sendTextReply(res, { id, created, modelName, text, stream }) {
	if (!stream) {
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(
			JSON.stringify({
				id,
				object: "chat.completion",
				created,
				model: modelName,
				choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			}),
		);
	}
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	const chunk = (delta, finish = null) =>
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created,
			model: modelName,
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	res.write(chunk({ role: "assistant", content: "" }));
	res.write(chunk({ content: text }));
	res.write(chunk({}, "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
}

/**
 * Reload the session's settings and resources.
 *
 * Goes through sessions.run so it is serialized behind any in-flight prompt: reload()
 * invalidates the extension runner and rebuilds the tool registry, which is only safe once
 * the agent has stopped running. Running it inline from a tool would deadlock the runtime.
 */
export async function reloadSession(c) {
	return sessions.run(c, async () => {
		const session = await c.sessionPromise;
		await session.reload();
		return "Reloaded. Skills, extensions, prompts, settings and context files from your profile and workspace were re-read.";
	});
}

/** How long the session stays on the fallback, for the inline notice. */
export function fallbackScopeNote() {
	if (config.FALLBACK_MODE === "request") return " for this request only";
	if (config.FALLBACK_MODE === "cooldown") return ` for ${formatDuration(config.FALLBACK_COOLDOWN_MS)}`;
	return " for this session";
}

/**
 * Go back to the model the session was on before falling back, per FALLBACK_MODE.
 * `session` never reverts; `request` reverts on the next request; `cooldown` waits out the
 * cooldown first, which is what lets a transient outage clear on its own.
 */
export async function maybeRevertToPrimary(session, c) {
	if (!c.fallbackActive || !c.primaryModel) return;
	const due =
		config.FALLBACK_MODE === "request" ||
		(config.FALLBACK_MODE === "cooldown" && Date.now() - (c.fallbackAt ?? 0) >= config.FALLBACK_COOLDOWN_MS);
	if (!due) return;
	try {
		await session.setModel(c.primaryModel);
		c.fallbackActive = false;
		c.fallbackAt = null;
	} catch {
		/* if the primary cannot be restored, staying on the fallback is the safer choice */
	}
}

/**
 * Keep a failed turn out of what the next model sees, without deleting it from the record.
 * Pi does exactly this internally via _omitRecoveryAttempt; that is typed private, so it is
 * called defensively and a renamed method simply leaves the failed turn visible.
 */
export function omitFailedAttempt(session, message) {
	if (!message) return;
	try {
		session._omitRecoveryAttempt?.(message, []);
	} catch {
		/* leave it visible rather than break the retry */
	}
}

/**
 * One line saying what a tool call does: the command for bash, the path for the file tools, and
 * compact arguments for anything else. Never the content being written, which can be large.
 */
export function toolActivity(toolName, args = {}) {
	const a = args && typeof args === "object" ? args : {};
	let what;
	if (typeof a.command === "string") what = a.command;
	else if (typeof a.path === "string") what = a.path + (typeof a.pattern === "string" ? `  ${a.pattern}` : "");
	else {
		const { content, ...rest } = a;
		what = JSON.stringify(rest);
	}
	return `${toolName}: ${truncate(String(what).replace(/\s+/g, " ").trim(), 200)}`;
}

export function truncate(text, max = 160) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

/**
 * Run one prompt on the conversation's session, forwarding assistant text
 * deltas to `onDelta`. Returns the accumulated reply text.
 *
 * A failed model call is not a thrown exception: it is an assistant message with
 * stopReason "error" and an errorMessage. When that failure is one a different model could
 * survive, the turn is retried once on the configured fallback model and the switch is
 * announced inline, so the reader knows which model answered and why.
 */
export async function runPrompt(c, prompt, { onDelta, onThinking, signal, body, images = [], context = "" } = {}) {
	return sessions.run(c, async () => {
		const session = await c.sessionPromise;
		await maybeRevertToPrimary(session, c);
		await applyRequestOptions(session, body, c.keyId ?? null);

		let promptText = prompt;
		if (images.length && !(session.model?.input ?? []).includes("image")) {
			promptText = `${prompt}\n\n[${images.length} image(s) omitted: model ${session.model?.id ?? "unknown"} does not accept image input]`;
			images = [];
		}
		if (context) promptText = `${context}\n\n${promptText}`;

		let text = "";
		let reasoning = "";
		let pendingBreak = false;
		let pendingThinkBreak = false;
		let suppressBreak = false;
		const emit = (chunk) => {
			text += chunk;
			onDelta?.(chunk);
		};
		// Reasoning goes out as `reasoning_content`, kept out of `content` so a client that
		// ignores the field sees exactly what it saw before.
		const emitThinking = (chunk) => {
			reasoning += chunk;
			onThinking?.(chunk);
		};
		const finish = () => ({ text: text || session.getLastAssistantText?.() || "", reasoning });
		// Something happened to this chat's container since its last reply (a process killed for memory,
		// the container gone): say so first, once, so the answer that follows is read with it in mind.
		const notices = c.notices?.splice(0) ?? [];
		if (notices.length) emit(`${notices.map((n) => `[container: ${n}]`).join("\n")}\n\n`);

		const attempt = async () => {
			let lastAssistant = null;
			const unsubscribe = session.subscribe((event) => {
				// What the agent is doing, into the reasoning stream: a long tool run no longer looks
				// frozen, and clients that show reasoning (Open WebUI's "Thinking") show it there.
				if (config.STREAM_TOOL_ACTIVITY) {
					if (event.type === "tool_execution_start") {
						emitThinking(`${reasoning.length && !reasoning.endsWith("\n") ? "\n" : ""}▸ ${toolActivity(event.toolName, event.args)}\n`);
						return;
					}
					if (event.type === "tool_execution_end" && event.isError) {
						emitThinking(`  ✗ ${event.toolName} failed\n`);
						return;
					}
				}
				if (event.type === "message_start" && event.message?.role === "assistant") {
					// A notice already ends with a blank line, so it must not get a second separator.
					pendingBreak = text.length > 0 && !suppressBreak;
					suppressBreak = false;
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					lastAssistant = event.message;
					return;
				}
				if (event.type !== "message_update") return;
				const update = event.assistantMessageEvent;
				// Thinking arrives as its own content block, one per turn, so a separator goes
				// between blocks (a tool loop produces several) and never before the first.
				if (update?.type === "thinking_start") {
					pendingThinkBreak = reasoning.length > 0;
					return;
				}
				if (update?.type === "thinking_delta" && update.delta) {
					if (pendingThinkBreak) {
						pendingThinkBreak = false;
						emitThinking("\n\n");
					}
					emitThinking(update.delta);
					return;
				}
				if (update?.type !== "text_delta" || !update.delta) return;
				if (pendingBreak) {
					pendingBreak = false;
					emit("\n\n");
				}
				emit(update.delta);
			});
			const abort = () => void session.abort().catch(() => {});
			signal?.addEventListener("abort", abort, { once: true });
			try {
				await session.prompt(promptText, images.length ? { images } : undefined);
			} finally {
				signal?.removeEventListener("abort", abort);
				unsubscribe();
			}
			const failed = lastAssistant?.stopReason === "error";
			return {
				failed,
				message: lastAssistant,
				errorMessage: failed ? lastAssistant?.errorMessage ?? "unknown model error" : null,
			};
		};

		// One fallback per turn, not one per session. A client that keeps selecting a failing
		// model explicitly should still be rescued on every turn; the single retry below is
		// what prevents a ping-pong between two bad models, so no session-level guard is needed.
		let result = await attempt();
		const fallback = result.failed && shouldFallBack(result.errorMessage) ? await allowedFallback(c.keyId ?? null) : null;
		const from = session.model;
		const sameModel = fallback && from && fallback.provider === from.provider && fallback.id === from.id;
		if (!fallback || sameModel) {
			// Without this a failed call answers with an empty message, which reads as the model having
			// nothing to say rather than as an error somebody should look at.
			if (result.failed) emit(`${text.length ? "\n\n" : ""}[model error: ${from ? `${from.provider}/${from.id}: ` : ""}${truncate(result.errorMessage, 400)}]`);
			return finish();
		}

		c.primaryModel ??= from;
		const kind = classifyModelError(result.errorMessage);
		try {
			await session.setModel(fallback);
		} catch (err) {
			emit(`${text.length ? "\n\n" : ""}[fallback to ${fallback.provider}/${fallback.id} failed: ${err?.message ?? err}]\n\n`);
			return finish();
		}
		omitFailedAttempt(session, result.message);
		c.fallbackActive = true;
		c.fallbackAt = Date.now();

		const where = from ? `${from.provider}/${from.id}` : "the active model";
		emit(`${text.length ? "\n\n" : ""}[model fallback: ${where} failed (${kind}: ${truncate(result.errorMessage)}) - switched to ${fallback.provider}/${fallback.id}${fallbackScopeNote()}]\n\n`);
		suppressBreak = true;

		result = await attempt();
		if (result.failed) {
			emit(`[the fallback model also failed: ${truncate(result.errorMessage)}]\n\n`);
		}
		return finish();
	});
}

/**
 * The fallback model, if this key may use it. A key limited to certain models gets no fallback
 * rather than a way around its allow-list. (Checked here, not in models.mjs, which must not depend
 * on the key store: it loads before it.)
 */
export async function allowedFallback(keyId) {
	const model = await fallbackModel();
	return model && modelAllowed(keyId, model) ? model : null;
}

export async function applyRequestOptions(session, body, keyId = "") {
	const runtime = await modelRuntime();
	const model = resolveModel(runtime, body?.model);
	// chatCompletions refuses a disallowed model up front; this only guards anything that slips past.
	if (model && modelAllowed(keyId, model) && (session.model?.provider !== model.provider || session.model?.id !== model.id)) {
		await session.setModel(model);
	}
	const effort = body?.reasoning_effort;
	if (PI_LEVELS.includes(effort) && session.thinkingLevel !== effort) session.setThinkingLevel(effort);
}

export async function listModels(res, credential = null) {
	const runtime = await modelRuntime();
	const seen = new Set();
	const data = [];
	const keyId = credential ? credential.id : null;
	// The host's models and the ones the container config defines, each key seeing only what it may use.
	for (const model of catalogueFor(runtime, (m) => modelAllowed(keyId, m))) {
		if (data.length >= 200) break;
		const qualified = `${model.provider}/${model.id}`;
		if (!seen.has(qualified)) {
			seen.add(qualified);
			data.push({ id: qualified, object: "model", created: 0, owned_by: model.provider });
		}
		if (!seen.has(model.id)) {
			seen.add(model.id);
			data.push({ id: model.id, object: "model", created: 0, owned_by: model.provider });
		}
	}
	if (!data.length) data.push({ id: "pi", object: "model", created: 0, owned_by: "pi" });
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ object: "list", data }));
}

export async function chatCompletions(req, res, body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	if (!messages.length) return sendError(res, 400, "`messages` is required", "invalid_request_error");
	// A model the key may not use is refused before anything is spawned, with the reason.
	if (typeof body?.model === "string" && body.model) {
		const requested = resolveModel(await modelRuntime(), body.model);
		if (requested && !modelAllowed(req.credential ? req.credential.id : null, requested)) {
			return sendError(res, 400, `model ${requested.provider}/${requested.id} is not allowed for this API key`, "model_not_allowed");
		}
	}

	const modelName = typeof body?.model === "string" && body.model ? body.model : "pi";
	const id = "chatcmpl-" + crypto.randomUUID();
	const created = Math.floor(Date.now() / 1000);
	const explicit = requestedSessionId(req, body);
	const derived = explicit ? null : derivedSessionId(req, body);
	// Minted here rather than by the controller, because the id the client echoes back is the bare
	// one and has to land on the same scoped key next time.
	const clientSessionId = explicit ?? derived ?? crypto.randomUUID();
	const scopedId = scopedSessionId(req.credential, clientSessionId);
	// A new session must fit under the key's limit. Its own idle sessions make room; if every one of
	// them is busy, the caller has to wait for one to finish rather than spawn without bound.
	if (!sessions.has(scopedId) && !sessions.makeRoomForKey(req.credential?.id ?? null, keyLimits(req.credential).maxSessions)) {
		return sendError(
			res, 429,
			`this key's session limit is ${keyLimits(req.credential).maxSessions} and every one of its sessions is busy; wait for one to finish`,
			"session_limit_exceeded", "rate_limit_error",
		);
	}
	let acquired = sessions.acquire(scopedId, req.credential);
	// A Pi that crashed, was killed, or never started leaves a record that can only fail.
	// Replacing it costs a transcript replay, exactly like an evicted session, instead of an error
	// on every request until the idle timeout.
	if (!acquired.isNew) {
		const existing = await acquired.record.sessionPromise.catch(() => null);
		if (!existing || existing.alive === false) {
			// Hibernate rather than end: the replacement resumes the same Pi session from its
			// workspace, so a crashed agent costs nothing but a restart.
			sessions.hibernate(scopedId);
			acquired = sessions.acquire(scopedId, req.credential);
		}
	}
	const { id: sessionId, record: c, isNew, resumed } = acquired;
	res.setHeader("X-Session-Id", clientSessionId);
	let source = "minted";
	if (explicit) source = "header";
	else if (derived) source = "derived";
	if (resumed) source += "+resumed";
	// The two halves of a derived key, hashed. When two requests land on different sessions this
	// shows which half moved: the client, or the message the key is anchored to.
	res.sessionNote =
		`session=${fingerprint(sessionId)} source=${source} new=${isNew}` +
		` key=${(req.credential?.name ?? "open").replace(/\s+/g, "_")}` +
		` msgs=${messages.length} roles=${messages.map((m) => String(m?.role ?? "?")[0]).join("")}` +
		` client=${fingerprint(clientFingerprint(req, body))} seed=${fingerprint(firstUserSeed(body) || "none")}`;
	// A request rejected before it ever runs must not leave an agent behind, or every retry
	// of a bad request adds a zombie row that lingers for the whole idle timeout.
	// ponytail: the spawn has already happened by this point, so this wastes one create on
	// an error path rather than reordering acquire around the awaits, which would let two
	// concurrent requests for the same new id each build their own conversation state.
	const discardIfNew = () => {
		if (!isNew) return;
		sessions.close(sessionId);
		res.sessionNote += " discarded";
	};
	const turn = nextTurn(messages, c.state);
	const prompt = turn.text;
	if (isReloadCommand(prompt)) {
		let text;
		try {
			text = await reloadSession(c);
		} catch (err) {
			return sendError(res, 500, `Reload failed: ${err?.message ?? err}`, "server_error", "server_error");
		}
		return sendTextReply(res, { id, created, modelName, text, stream: Boolean(body?.stream) });
	}
	const gatewayCommand = parseGatewayCommand(prompt);
	if (gatewayCommand) {
		let text;
		try {
			text = await runGatewayCommand(c, gatewayCommand);
		} catch (err) {
			text = `${gatewayCommand.name} failed: ${err?.message ?? err}`;
		}
		return sendTextReply(res, { id, created, modelName, text, stream: Boolean(body?.stream) });
	}
	if (turn.audio) {
		discardIfNew();
		return sendError(res, 400, "Audio input is not supported: Pi models accept text and image input only.", "invalid_request_error", "invalid_request_error");
	}
	// Checked here, after the gateway's own commands, so a key over its cap can still look at and
	// manage its profile; only a model call is refused. The bridge checks again before every call,
	// which is what stops a long agent run partway.
	const overSpend = spendRefusal(req.credential);
	if (overSpend) {
		discardIfNew();
		return sendError(res, 429, overSpend, "spend_limit_exceeded", "rate_limit_error");
	}
	let images;
	try {
		images = await resolveImages(turn.images);
	} catch (err) {
		discardIfNew();
		return sendError(res, 400, err?.message ?? String(err), "invalid_request_error", "invalid_request_error");
	}
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});

	let firstSession;
	try {
		firstSession = await c.sessionPromise;
	} catch (err) {
		// The agent never started — no Docker, no image, the network policy could not be enforced. That
		// is the gateway's problem, not the request's, and the record is dropped so a retry starts fresh.
		sessions.close(sessionId);
		return sendError(res, err instanceof EngineError ? err.status : 503, `the chat's container failed to start: ${err?.message ?? err}`, "container_unavailable", "server_error");
	}
	const before = firstSession.getSessionStats().tokens;

	if (body?.stream) {
		const chunk = (delta, extra = {}) =>
			`data: ${JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created,
				model: modelName,
				choices: [{ index: 0, delta, finish_reason: null }],
				...extra,
			})}\n\n`;

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(chunk({ role: "assistant", content: "" }));

		let failed = null;
		try {
			if (!prompt && !images.length) {
				const session = await c.sessionPromise;
				const cached = session.getLastAssistantText?.() ?? "";
				if (cached) res.write(chunk({ content: cached }));
			} else {
				await runPrompt(c, prompt, {
					signal: controller.signal,
					body,
					images,
					context: turn.context,
					onDelta: (delta) => res.write(chunk({ content: delta })),
					onThinking: (delta) => res.write(chunk({ reasoning_content: delta })),
				});
			}
		} catch (err) {
			failed = err?.message ?? String(err);
		}

		if (!controller.signal.aborted) {
			const settled = await c.sessionPromise;
			const after = settled.getSessionStats().tokens;
			const usage = usageDelta(before, after);
			if (failed) {
				res.write(`data: ${JSON.stringify({ error: { message: failed, type: "server_error" } })}\n\n`);
			} else {
				res.write(
					`data: ${JSON.stringify({
						id,
						object: "chat.completion.chunk",
						created,
						model: modelName,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\n`,
				);
				if (body?.stream_options?.include_usage) {
					res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: modelName, choices: [], usage })}\n\n`);
				}
			}
			res.write("data: [DONE]\n\n");
		}
		return res.end();
	}

	let text = "";
	let reasoning = "";
	let failed = null;
	try {
		if (prompt || images.length) {
			const out = await runPrompt(c, prompt, {
				signal: controller.signal,
				body,
				images,
				context: turn.context,
				onDelta: (d) => (text += d),
				onThinking: (d) => (reasoning += d),
			});
			reasoning = out.reasoning;
		} else {
			const session = await c.sessionPromise;
			text = session.getLastAssistantText?.() ?? "";
		}
	} catch (err) {
		failed = err?.message ?? String(err);
	}

	if (failed) return sendError(res, 500, failed, "server_error", "server_error");
	const settled = await c.sessionPromise;
	const after = settled.getSessionStats().tokens;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			id,
			object: "chat.completion",
			created,
			model: modelName,
			choices: [
				{
					index: 0,
					// Present only when the model actually reasoned, so a non-reasoning turn is unchanged.
					message: { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
					finish_reason: "stop",
				},
			],
			usage: usageDelta(before, after),
		}),
	);
}
