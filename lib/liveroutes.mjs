/**
 * The dashboard's live view of a running chat: a stream of what it is doing, an interrupt, and a transcript.
 *
 *   GET  /dashboard/session/<fingerprint>/events          Server-Sent Events: a snapshot, then each change
 *   POST /dashboard/session/<fingerprint>/interrupt       stop the turn in flight
 *   GET  /dashboard/session/<fingerprint>/transcript.md   the conversation so far (or .json)
 *
 * These show what people said to agents, so they need a dashboard password and can be switched off. A watch and an
 * interrupt are audited (who, which chat), never the content. The chat is named by its fingerprint; the real
 * session id never leaves the process.
 */
import { config } from "./settings.mjs";
import { dashboardHash, keyLabel } from "./auth.mjs";
import { audit } from "./audit.mjs";
import { sendError, sendJson } from "./http.mjs";
import { sessions } from "./sessions.mjs";

export const MAX_WATCHERS_PER_SESSION = 5;
export const MAX_WATCHERS_TOTAL = 20;
const TOOL_TEXT = 4 * 1024;
let watching = 0;

/** How many streams are open now. */
export const watcherCount = () => watching;


/** What the page needs to title a chat: its owner and agent, without the id. */
const describe = (record) => ({ key: keyLabel(record.keyId), agent: record.agentId ? keyLabel(record.scopeId) : null, requests: record.requests });

/** Model, tokens and cost from the live session. */
function stateOf(record) {
	const session = record.session;
	const stats = session?.getSessionStats?.();
	return { model: session?.model ? `${session.model.provider}/${session.model.id}` : null, tokens: Number(stats?.tokens?.total) || 0, cost: Number(stats?.cost) || 0, inflight: record.inflight };
}

const gate = (res) => {
	if (!config.LIVE_VIEW_ENABLED) return sendError(res, 403, "The live view is switched off (Settings → Containers → Live view).", "forbidden"), false;
	if (!dashboardHash) return sendError(res, 403, "The live view needs a dashboard password: it shows what people say to agents. Set one under Settings → Access first.", "forbidden"), false;
	return true;
};

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "");
const clip = (text, max) => (String(text).length > max ? `${String(text).slice(0, max)}\n… (${String(text).length - max} more characters cut)` : String(text));

/** Markdown for a list of Pi messages: roles, thinking, tool calls and results, each tool result cut at 4 KB. */
export function renderTranscript(messages, title = "Piper chat") {
	const out = [`# ${title}`, ""];
	for (const m of Array.isArray(messages) ? messages : []) {
		if (m?.role === "user") out.push("## You", "", textOf(m.content), "");
		else if (m?.role === "assistant") {
			out.push("## Agent", "");
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "text" && b.text) out.push(b.text, "");
				else if (b?.type === "thinking" && b.thinking) out.push(...clip(b.thinking, TOOL_TEXT).split("\n").map((l) => `> ${l}`), "");
				else if (b?.type === "toolCall") out.push(`**Tool: ${b.name}**`, "", "```json", clip(JSON.stringify(b.arguments ?? {}), TOOL_TEXT), "```", "");
			}
		} else if (m?.role === "toolResult") out.push(`**Result of ${m.toolName ?? "tool"}${m.isError ? " (error)" : ""}**`, "", "```", clip(textOf(m.content), TOOL_TEXT), "```", "");
		else if (m?.role === "bashExecution") out.push(`**Shell: \`${m.command}\`**`, "", "```", clip(m.output ?? "", TOOL_TEXT), "```", "");
	}
	return `${out.join("\n").trimEnd()}\n`;
}

/**
 * Handle `/dashboard/session/<fingerprint>/<what>`. Returns true when it answered (the path is one of ours).
 * The caller has checked the dashboard cookie.
 */
export async function liveRoutes(req, res, path) {
	const match = /^\/dashboard\/session\/([0-9a-f]{6,64})\/(events|interrupt|transcript\.md|transcript\.json)$/.exec(path);
	if (!match) return false;
	const [, fp, what] = match;
	if (!gate(res)) return true;
	const record = sessions.recordByFingerprint(fp);
	if (!record) return sendError(res, 404, "No such chat: it may have stopped. Chats that are not running cannot be watched.", "not_found"), true;
	const label = describe(record);
	const target = `${label.key}${label.agent ? ` / ${label.agent}` : ""}`;

	if (what === "events" && req.method === "GET") {
		if (record.live.watchers >= MAX_WATCHERS_PER_SESSION || watching >= MAX_WATCHERS_TOTAL) {
			sendError(res, 429, `Too many people are watching (${record.live.watchers} on this chat, ${watching} in all).`, "rate_limited");
			return true;
		}
		watching += 1;
		audit("session.watch", target, "opened the live view");
		res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		const refresh = () => record.live.setState(stateOf(record));
		refresh();
		send("snapshot", { ...record.live.snapshot(), chat: label });
		const unsubscribe = record.live.subscribe((change) => {
			send(change.op, change);
			if (change.op === "end") res.end();
		});
		const beat = setInterval(() => {
			refresh();
			res.write(": keep-alive\n\n");
		}, 5000);
		let closed = false;
		const cleanup = () => {
			if (closed) return;
			closed = true;
			watching -= 1;
			clearInterval(beat);
			unsubscribe();
		};
		res.on("close", cleanup);
		req.on("close", cleanup);
		return true;
	}

	if (what === "interrupt" && req.method === "POST") {
		const running = record.inflight > 0;
		let aborted = false;
		if (running) {
			try {
				await record.session?.abort?.();
				aborted = true;
			} catch {
				/* reported below */
			}
		}
		audit("session.interrupt", target, running ? (aborted ? "turn interrupted from the dashboard" : "the interrupt failed") : "nothing was running");
		if (aborted) record.live.note("interrupted from the dashboard");
		sendJson(res, 200, { interrupted: aborted, wasRunning: running });
		return true;
	}

	if ((what === "transcript.md" || what === "transcript.json") && req.method === "GET") {
		let messages;
		try {
			messages = (await record.session?.send?.({ type: "get_messages" }))?.messages ?? [];
		} catch (err) {
			return sendError(res, 503, `The agent could not give its transcript: ${err?.message ?? err}`, "server_error", "server_error"), true;
		}
		audit("session.transcript", target, "downloaded a transcript");
		const name = `piper-${label.agent ?? label.key}-${new Date().toISOString().slice(0, 10)}`.replace(/[^\w.-]+/g, "-");
		if (what === "transcript.json") {
			res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}.json"`, "Cache-Control": "no-store" });
			res.end(JSON.stringify({ chat: label, messages }, null, 2));
		} else {
			res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.md"`, "Cache-Control": "no-store" });
			res.end(renderTranscript(messages, `Chat with ${target}`));
		}
		return true;
	}
	sendError(res, 405, "method not allowed", "invalid_request_error");
	return true;
}
