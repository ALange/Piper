/**
 * Signal messenger integration: a signal-cli daemon run as a supervised subprocess for Piper's own,
 * single registered phone number (SIGNAL_PHONE_NUMBER), the allow-list of other numbers it will carry
 * a conversation with (the `signal_contacts` table -- linked by an agent's own piper_signal_* tool,
 * see lib/agentsignal.mjs), and routing an inbound message from a linked number to the right
 * key/agent's chat, exactly the way lib/jobs.mjs routes a webhook trigger to a job.
 *
 * A number not in signal_contacts, or disabled, is never routed anywhere: its message is simply
 * discarded. There is no reply-to-confirm handshake -- a number becomes active the moment
 * lib/agentsignal.mjs's enable() runs (trust-on-enable); the brakes on that are its own caps, not this
 * module's.
 *
 * signal-cli itself is not managed by Piper: the phone number must already be registered and verified
 * with signal-cli, outside Piper, before SIGNAL_ENABLED is turned on. This module only ever drives an
 * already-registered account's `jsonRpc` mode (reads JSON-RPC requests on stdin, writes responses and
 * notifications on stdout) -- not `daemon`, which is for its dbus/socket/tcp/http service modes and
 * does not accept a `--json-rpc` flag at all, despite the name suggesting otherwise.
 *
 * A Signal conversation has no "+ New chat" the way every other surface does -- the same session gets
 * resumed for as long as the number stays linked, however long that is. Two things bound how much
 * context that session ever carries: Pi's own auto-compaction (lib/compaction.mjs keeps it correctly
 * tuned, bounding any one session's *size*), and this module's own rotation, past
 * SIGNAL_SESSION_MAX_AGE_DAYS, which bounds a session's *age* -- a short handoff note is pulled from
 * the old session before it ends, so the fresh one that replaces it doesn't start from nothing. The
 * agent's own piper_signal_reset tool (lib/agentsignal.mjs) does the same ending, on request, any
 * time -- Signal's equivalent of a web chat's "+ New chat" button.
 *
 * An inbound attachment is handled the same way the client portal's own attach button already splits
 * one: an image goes to the model inline (vision); anything else is copied into the chat's own
 * workspace (uploads/<name>) for the agent to read itself, the file already sitting on disk wherever
 * signal-cli itself saved it after downloading it. Outbound, the agent's own piper_signal_send_file
 * tool (lib/agentsignal.mjs) sends a file from that same workspace back as a real attachment, to one
 * of its own linked numbers only -- never an arbitrary one.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { config, db } from "./settings.mjs";
import { credentialFor, runAgentTurn } from "./agentrun.mjs";
import { audit, auditOnce } from "./audit.mjs";
import { ensureWorkspace, filesStream, treeSize } from "./profiles.mjs";
import { scopedSessionId } from "./chat.mjs";
import { chatIdHash, chatStore, sessions } from "./sessions.mjs";

// A short, common-case extension -> MIME type guess for an outbound file, since signal-cli's data URI
// attachment needs one declared (node has no bundled mime database). Unknown extensions still send
// fine, just as generic bytes.
const EXT_MIME = {
	pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
	webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", csv: "text/csv", json: "application/json",
	zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4", mov: "video/quicktime", doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", html: "text/html", xml: "application/xml",
};
const mimeFromName = (name) => EXT_MIME[String(name ?? "").split(".").pop()?.toLowerCase()] ?? "application/octet-stream";

const MAX_TEXT = 4000;
const RPC_TIMEOUT_MS = 15_000;
const MAX_RESTART_DELAY_MS = 30_000;
const UNKNOWN_SENDER_AUDIT_WINDOW_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const HANDOFF_PROMPT =
	"This Signal conversation is being rotated to keep its context from growing without bound. In 3-5 short bullet points, note what's worth remembering for whoever picks this up next -- ongoing tasks, preferences, open questions. Be concise: this is a brief handoff note, not a full summary.";

const clip = (text, n) => (String(text).length > n ? `${String(text).slice(0, n)}\n… (cut at ${n} characters)` : String(text));

const PHONE_RE = /^\+[1-9]\d{7,14}$/;
/** A phone number in the +E.164 form signal-cli expects, or null when it doesn't look like one. */
export function normalizePhoneNumber(raw) {
	const trimmed = String(raw ?? "").trim().replace(/[\s()-]/g, "");
	return PHONE_RE.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------------------------
// The allow-list (signal_contacts)
// ---------------------------------------------------------------------------------------------

const contactView = (row) => ({
	id: row.id,
	phoneNumber: row.phone_number,
	keyId: row.key_id,
	agentId: row.agent_id ?? null,
	enabled: Boolean(row.enabled),
	createdAt: Number(row.created_at),
	lastMessageAt: row.last_message_at === null || row.last_message_at === undefined ? null : Number(row.last_message_at),
});

export const getContact = (id) => {
	const row = db.prepare("SELECT * FROM signal_contacts WHERE id = ?").get(String(id));
	return row ? contactView(row) : null;
};
export const getContactByNumber = (phoneNumber) => {
	const row = db.prepare("SELECT * FROM signal_contacts WHERE phone_number = ?").get(phoneNumber);
	return row ? contactView(row) : null;
};
/** Every number linked to one scope: an agent's own, or -- with no agent -- a key's agentless ones. */
export const contactsOf = ({ keyId, agentId = null }) =>
	db.prepare("SELECT * FROM signal_contacts WHERE key_id = ? AND agent_id IS ? ORDER BY created_at DESC").all(keyId, agentId ?? null).map(contactView);
/** How many numbers have been newly linked, gateway-wide, in the trailing 24 hours -- the operator-wide brake. */
export const newContactsToday = (now = Date.now()) => Number(db.prepare("SELECT COUNT(*) AS c FROM signal_contacts WHERE created_at > ?").get(now - 86_400_000).c);
/** Every linked number, any scope -- the dashboard's own view, not an agent's. */
export const listAllContacts = () => db.prepare("SELECT * FROM signal_contacts ORDER BY created_at DESC").all().map(contactView);

/** Link a number to a scope (insert, or reactivate if it was linked here before and later disabled).
 * Caller (lib/agentsignal.mjs) has already checked the caps and the "linked elsewhere" conflict. */
export function linkContact({ keyId, agentId = null, phoneNumber }) {
	const existing = db.prepare("SELECT * FROM signal_contacts WHERE phone_number = ?").get(phoneNumber);
	if (existing) {
		db.prepare("UPDATE signal_contacts SET enabled = 1 WHERE id = ?").run(existing.id);
		return getContact(existing.id);
	}
	const id = `sg${crypto.randomBytes(6).toString("hex")}`;
	db.prepare("INSERT INTO signal_contacts (id, phone_number, key_id, agent_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(id, phoneNumber, keyId, agentId, Date.now());
	return getContact(id);
}
export function setContactEnabled(id, enabled) {
	db.prepare("UPDATE signal_contacts SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}
export function removeContact(id) {
	db.prepare("DELETE FROM signal_contacts WHERE id = ?").run(id);
}
function touchContact(id) {
	db.prepare("UPDATE signal_contacts SET last_message_at = ? WHERE id = ?").run(Date.now(), id);
}

// ---------------------------------------------------------------------------------------------
// The daemon: spawn, JSON-RPC, respawn on exit
// ---------------------------------------------------------------------------------------------

let spawnFn = spawn;
/** Swap the child_process spawn used for the daemon, for tests (a fake signal-cli, never a real one). */
export function setSignalSpawn(fn) {
	spawnFn = fn ?? spawn;
}

let runTurn = runAgentTurn;
/** Swap the function used to run an agent's turn for an inbound message, for tests. */
export function setSignalRunner(fn) {
	runTurn = fn ?? runAgentTurn;
}

let child = null;
let rl = null;
let restartTimer = null;
let restarts = 0;
let stopping = false;
let lastError = null;
let nextRpcId = 1;
const pending = new Map();

/** What the dashboard's Signal panel shows. */
export function signalStatus() {
	return {
		enabled: Boolean(config.SIGNAL_ENABLED),
		phoneNumber: String(config.SIGNAL_PHONE_NUMBER ?? "").trim() || null,
		running: Boolean(child),
		lastError,
		contacts: Number(db.prepare("SELECT COUNT(*) AS c FROM signal_contacts WHERE enabled = 1").get().c),
	};
}

function rpcArgs() {
	const number = String(config.SIGNAL_PHONE_NUMBER ?? "").trim();
	const dataDir = String(config.SIGNAL_CLI_DATA_DIR ?? "").trim();
	const args = [];
	if (dataDir) args.push("--config", dataDir);
	args.push("-a", number, "jsonRpc");
	return args;
}

function spawnDaemon() {
	const bin = String(config.SIGNAL_CLI_PATH ?? "").trim() || "signal-cli";
	const proc = spawnFn(bin, rpcArgs(), { stdio: ["pipe", "pipe", "pipe"] });
	child = proc;
	lastError = null;
	rl = createInterface({ input: proc.stdout });
	rl.on("line", handleLine);
	proc.stderr?.on("data", (chunk) => process.stderr.write(`signal-cli: ${chunk}`));
	proc.on("error", (err) => {
		lastError = err?.message ?? String(err);
	});
	proc.on("exit", (code, signal) => {
		rl?.close();
		rl = null;
		child = null;
		for (const { reject } of pending.values()) reject(new Error("the signal-cli daemon stopped"));
		pending.clear();
		if (stopping) return;
		lastError = `signal-cli exited (code ${code ?? "?"}, signal ${signal ?? "none"})`;
		restarts += 1;
		const delay = Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** Math.min(restarts, 5));
		restartTimer = setTimeout(spawnDaemon, delay);
		restartTimer.unref?.();
	});
}

/** No-op when SIGNAL_ENABLED is off, SIGNAL_PHONE_NUMBER is unset, or already running. */
export function startSignal() {
	if (!config.SIGNAL_ENABLED || child) return;
	if (!String(config.SIGNAL_PHONE_NUMBER ?? "").trim()) {
		lastError = "SIGNAL_PHONE_NUMBER is not set";
		return;
	}
	stopping = false;
	restarts = 0;
	spawnDaemon();
}

export function stopSignal() {
	stopping = true;
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	for (const { reject } of pending.values()) reject(new Error("the signal-cli daemon is stopping"));
	pending.clear();
	rl?.close();
	rl = null;
	if (child) {
		child.kill();
		child = null;
	}
}

function sendRpc(method, params) {
	return new Promise((resolve, reject) => {
		if (!child?.stdin?.writable) return reject(new Error("the signal-cli daemon is not running"));
		const id = String(nextRpcId++);
		const timer = setTimeout(() => {
			if (pending.delete(id)) reject(new Error("signal-cli did not answer in time"));
		}, RPC_TIMEOUT_MS);
		timer.unref?.();
		pending.set(id, { resolve, reject, timer });
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`);
	});
}

function handleLine(line) {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return; // a non-JSON line (signal-cli's own banner, etc.) -- ignore
	}
	if (msg?.id !== undefined && pending.has(String(msg.id))) {
		const { resolve, reject, timer } = pending.get(String(msg.id));
		clearTimeout(timer);
		pending.delete(String(msg.id));
		if (msg.error) reject(new Error(msg.error.message ?? "signal-cli reported an error"));
		else resolve(msg.result);
		return;
	}
	if (msg?.method === "receive") void handleReceive(msg.params);
}

/** Send a message to a linked number. Used both for the enable-tool's welcome message and for a reply. */
export async function sendSignalMessage(phoneNumber, text) {
	await sendRpc("send", { recipient: [phoneNumber], message: clip(text, MAX_TEXT) });
}

/** The one client session id a Signal conversation for this key/agent ever uses -- the single place
 * this string is built, so handleReceive()'s own turns, a manual piper_signal_reset, and rotation all
 * agree on exactly which session they mean. */
export const signalClientSessionId = (keyId, agentId) => `signal:${keyId}:${agentId ?? ""}`;

/** How old (ms) the current session for this scope is, or null if there is none right now (never
 * started, or already ended). Reads the same persisted `chats` row SessionController itself resumes
 * from, without needing a live in-memory record -- a session idle long enough to have been reaped
 * from memory is still "that old" as far as rotation is concerned. */
function signalSessionAgeMs(keyId, agentId, now = Date.now()) {
	const credential = credentialFor(keyId, agentId);
	const scoped = scopedSessionId(credential, signalClientSessionId(keyId, agentId));
	const row = chatStore.get(chatIdHash(scoped));
	return row ? now - Number(row.created_at) : null;
}

/** End a key's (and agent's) own Signal session for good, so the next message starts fresh. Returns
 * whether there was one running to end. Shared by the manual piper_signal_reset tool
 * (lib/agentsignal.mjs) and automatic rotation below -- same primitive lib/playground.mjs's own
 * endConversation uses for an ordinary Playground chat. */
export function closeSignalSession(keyId, agentId) {
	const credential = credentialFor(keyId, agentId);
	const scoped = scopedSessionId(credential, signalClientSessionId(keyId, agentId));
	// sessions.close() itself now covers both a live session and one merely hibernated (stopped, but
	// still resumable from its stored row) -- the common case for an idle Signal conversation, which
	// would otherwise survive a reset/rotation and get silently resumed by the next message.
	return sessions.close(scoped);
}

/** Past SIGNAL_SESSION_MAX_AGE_DAYS, a conversation rotates to a fresh session rather than carrying
 * an ever-growing one forever: one short, purpose-built turn against the *old* session asks it for a
 * brief handoff note, which then ends -- the next real turn starts a new session with that note
 * prepended, so the fresh start isn't a blank one. Resolves to the handoff text (empty if the turn or
 * the rotation itself failed -- rotation still happens either way, just without a note to carry). */
async function rotateSignalSession(contact, sender) {
	let handoff = "";
	try {
		const credential = credentialFor(contact.keyId, contact.agentId);
		const clientSessionId = signalClientSessionId(contact.keyId, contact.agentId);
		const result = await runTurn({ credential, clientSessionId, prompt: HANDOFF_PROMPT });
		handoff = String(result?.text ?? "").trim();
	} catch (err) {
		audit("signal.session.rotated", sender, `handoff note failed, rotating anyway: ${err?.message ?? err}`, { actor: "system" });
	}
	closeSignalSession(contact.keyId, contact.agentId);
	audit("signal.session.rotated", sender, handoff ? "rotated with a handoff note" : "rotated with no handoff note", { actor: "system" });
	return handoff;
}

/** Read a file out of a chat's own workspace, the same sandboxed, symlink-safe way the portal's own
 * download route does -- the workspace is writable by the agent's own container, so a raw read here
 * would need the same guard filesStream's helper already has. Resolves to the whole file as a Buffer. */
function readWorkspaceFile(scopeId, relPath) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let status = 200;
		let errorBody = "";
		const fakeRes = {
			headersSent: false,
			writeHead(code) { status = code; this.headersSent = true; },
			write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
			end(body) {
				if (body) errorBody = body;
				if (status !== 200) reject(new Error(errorBody || `could not read it (HTTP ${status})`));
				else resolve(Buffer.concat(chunks));
			},
			on() {}, once() {}, destroy() {},
		};
		filesStream(scopeId, "read", relPath, { req: null, res: fakeRes }).catch(reject);
	});
}

const MAX_SEND_FILE_BYTES = 64 * 1024 * 1024; // signal-cli's own data-URI attachment, not a huge upload path
/** Send a file from a chat's own workspace to a linked number, as a real Signal attachment (a data URI,
 * so no temp file needs writing or cleaning up on the host). `caption`, if given, is the message text
 * alongside it -- the same "send" call, just with an attachment too. */
export async function sendSignalFile(phoneNumber, scopeId, relPath, caption) {
	const bytes = await readWorkspaceFile(scopeId, relPath);
	if (bytes.length > MAX_SEND_FILE_BYTES) throw new Error(`that file is ${Math.round(bytes.length / 1024 / 1024)} MB, over the ${MAX_SEND_FILE_BYTES / 1024 / 1024} MB this can send`);
	const name = String(relPath).split("/").pop() || "file";
	// Plain RFC 2397 form only (no filename parameter -- it's not part of the spec, and signal-cli's own
	// parser is not guaranteed to accept a non-standard extension to it); the recipient sees whatever
	// name signal-cli itself generates for an attachment with no filename of its own.
	const dataUri = `data:${mimeFromName(name)};base64,${bytes.toString("base64")}`;
	await sendRpc("send", { recipient: [phoneNumber], ...(caption ? { message: clip(caption, MAX_TEXT) } : {}), attachment: [dataUri] });
}

/** Where signal-cli itself already saved a downloaded attachment, if it did. signal-cli names the file
 * `<sanitized id><extension>` under `<its data dir>/attachments/` (the extension comes from the
 * original filename or a guess from the content type, which isn't worth replicating here) -- so this
 * matches by the id prefix instead of predicting the exact name. */
function attachmentFile(id) {
	const dataDir = String(config.SIGNAL_CLI_DATA_DIR ?? "").trim() || join(homedir(), ".local", "share", "signal-cli");
	const dir = join(dataDir, "attachments");
	const safeId = String(id ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
	if (!safeId) return null;
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return null; // no attachments directory yet, or SIGNAL_CLI_DATA_DIR is wrong
	}
	const name = names.find((n) => n.startsWith(safeId));
	return name ? join(dir, name) : null;
}

/** One inbound image attachment, read from disk as `{type, data, mimeType}` for runAgentTurn's `images`
 * -- or null when it isn't an image, isn't found, or is over SIGNAL_IMAGE_MAX_BYTES. Images go to the
 * model inline (vision), the same split the portal's own attach button makes between an image and any
 * other file (lib/portal.mjs's checkedImages / addImageFile vs. addDocFile). */
function readImageAttachment(att) {
	const mimeType = String(att?.contentType ?? "");
	if (!mimeType.startsWith("image/")) return null;
	const file = attachmentFile(att?.id);
	if (!file) return null;
	try {
		const cap = Number(config.SIGNAL_IMAGE_MAX_BYTES ?? 8 * 1024 * 1024);
		if (statSync(file).size > cap) return null;
		return { type: "image", data: readFileSync(file).toString("base64"), mimeType };
	} catch {
		return null;
	}
}

const UPLOAD_NAME_MAX = 180;
/** A Signal-supplied filename, made safe for a workspace path: no separators, no leading dots, capped
 * length -- nothing upstream sanitizes this, unlike a browser's own File.name. */
function safeUploadName(filename, fallback) {
	const cleaned = String(filename ?? "")
		.replace(/[\u0000-\u001f]/g, "")
		.replace(/[/\\]/g, "_")
		.replace(/^\.+/, "")
		.trim();
	return (cleaned || fallback).slice(0, UPLOAD_NAME_MAX);
}

/** A non-image attachment, copied into the chat's own workspace under uploads/, the same place and the
 * same way the client portal's "doc" attach already does (PUT /api/files/uploads/<name>) -- so the
 * agent discovers and reads it itself, over its normal filesystem access, rather than it being sent
 * inline. Resolves to the note to put in the prompt (`[Attached: uploads/<name> -- read it from your
 * workspace]`, matching portal.html's own wording exactly) or an explanation of why it could not be
 * copied in. Reuses filesStream -- the same sandboxed, symlink-safe helper the portal's upload route
 * runs -- rather than writing into a chat's own workspace directly: it's attacker-writable (the agent's
 * own container has it mounted read-write), so a raw write here would need to re-implement that
 * helper's symlink-walk guard itself to stay as safe.
 */
async function copyAttachmentToWorkspace(att, scopeId, index) {
	const file = attachmentFile(att?.id);
	if (!file) return `[Attachment ${index + 1} (${att?.filename || att?.contentType || "file"}) could not be read here]`;
	const name = safeUploadName(att?.filename, `attachment-${index + 1}`);
	const quota = Number(config.WORKSPACE_MAX_BYTES ?? 0) > 0 ? Math.max(0, Number(config.WORKSPACE_MAX_BYTES) - treeSize(ensureWorkspace(scopeId))) : 0;
	const limit = [Number(config.FILE_UPLOAD_MAX_BYTES ?? 0), quota].filter((n) => n > 0);
	const maxBytes = limit.length ? Math.min(...limit) : 0;
	let body = "";
	const fakeRes = { headersSent: false, writeHead() {}, end: (s) => { body = s ?? ""; }, destroy() {} };
	try {
		await filesStream(scopeId, "write", `uploads/${name}`, { req: createReadStream(file), res: fakeRes, maxBytes });
	} catch (err) {
		return `[Attachment ${index + 1} (${name}) could not be copied into the workspace: ${err?.message ?? err}]`;
	}
	let parsed = {};
	try {
		parsed = JSON.parse(body || "{}");
	} catch {
		/* a non-JSON body means success for this route (filesStream's write mode answers {ok:true} on success, an error body otherwise -- parse failures are treated as success) */
	}
	if (parsed?.error) return `[Attachment ${index + 1} (${name}) could not be copied into the workspace: ${parsed.error.message ?? parsed.error}]`;
	return `[Attached: uploads/${name} -- read it from your workspace]`;
}

/** An inbound message notification: route it to the linked scope's chat, or discard it. */
async function handleReceive(params) {
	const envelope = params?.envelope;
	const dataMessage = envelope?.dataMessage;
	const text = typeof dataMessage?.message === "string" ? dataMessage.message.trim() : "";
	const attachments = Array.isArray(dataMessage?.attachments) ? dataMessage.attachments : [];
	if (!envelope || (!text && !attachments.length)) return; // receipts, typing indicators, etc.
	const sender = normalizePhoneNumber(envelope.sourceNumber ?? envelope.source);
	if (!sender) return;
	const contact = getContactByNumber(sender);
	if (!contact || !contact.enabled) {
		auditOnce(`signal:unknown:${sender}`, UNKNOWN_SENDER_AUDIT_WINDOW_MS, "signal.message.discarded", sender, "a message from an unlinked number was discarded", { actor: "system" });
		return;
	}
	touchContact(contact.id);
	// Past SIGNAL_SESSION_MAX_AGE_DAYS, the session that would otherwise answer this message rotates
	// to a fresh one first -- see rotateSignalSession(). Pi's own compaction (lib/compaction.mjs)
	// bounds a session's *size* either way; this bounds its *age*, which compaction alone never does.
	let handoff = "";
	const maxAgeDays = Number(config.SIGNAL_SESSION_MAX_AGE_DAYS ?? 0);
	if (maxAgeDays > 0) {
		const age = signalSessionAgeMs(contact.keyId, contact.agentId);
		if (age !== null && age > maxAgeDays * DAY_MS) handoff = await rotateSignalSession(contact, sender);
	}
	const credential = credentialFor(contact.keyId, contact.agentId);
	const scopeId = credential.scopeId ?? credential.id;
	// Images go to the model inline; anything else is copied into the chat's own workspace, same split
	// as the client portal's own attach button, so the agent can read it itself from there.
	const images = [];
	const notes = [];
	for (let i = 0; i < attachments.length; i++) {
		const image = readImageAttachment(attachments[i]);
		if (image) images.push(image);
		else notes.push(await copyAttachmentToWorkspace(attachments[i], scopeId, i));
	}
	let prompt = [text, notes.join("\n\n")].filter(Boolean).join("\n\n") || (images.length ? "(an image, no caption)" : "");
	if (!prompt) return;
	if (handoff) prompt = `This is a new conversation, continuing from an earlier one. Handoff notes from before:\n${handoff}\n\nTheir message:\n${prompt}`;
	try {
		const clientSessionId = signalClientSessionId(contact.keyId, contact.agentId);
		const result = await runTurn({ credential, clientSessionId, prompt, images });
		const reply = String(result?.text ?? "").trim();
		if (reply) await sendSignalMessage(sender, reply);
	} catch (err) {
		audit("signal.message.failed", sender, String(err?.message ?? err).slice(0, 300), { actor: "system" });
	}
}
