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
 * An inbound attachment is handled the same way the client portal's own attach button already splits
 * one: an image goes to the model inline (vision); anything else is copied into the chat's own
 * workspace (uploads/<name>) for the agent to read itself, the file already sitting on disk wherever
 * signal-cli itself saved it after downloading it.
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

const MAX_TEXT = 4000;
const RPC_TIMEOUT_MS = 15_000;
const MAX_RESTART_DELAY_MS = 30_000;
const UNKNOWN_SENDER_AUDIT_WINDOW_MS = 60 * 60_000;

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
	const prompt = [text, notes.join("\n\n")].filter(Boolean).join("\n\n") || (images.length ? "(an image, no caption)" : "");
	if (!prompt) return;
	try {
		const clientSessionId = `signal:${contact.keyId}:${contact.agentId ?? ""}`;
		const result = await runTurn({ credential, clientSessionId, prompt, images });
		const reply = String(result?.text ?? "").trim();
		if (reply) await sendSignalMessage(sender, reply);
	} catch (err) {
		audit("signal.message.failed", sender, String(err?.message ?? err).slice(0, 300), { actor: "system" });
	}
}
