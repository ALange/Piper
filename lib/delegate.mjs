/**
 * Hand-offs: an agent asks another agent of the same key to do part of the work.
 *
 * An agent that is switched to delegate gets two tools from the bridge extension, `piper_agents` (who the colleagues
 * are and what each is for) and `piper_delegate` (give one a task and wait for the answer). Both reach the gateway
 * over the chat's own bridge socket, which is bound to *that chat's record*: the caller is whoever owns the socket, so a
 * tool call cannot claim to be another agent or another key.
 *
 * A hand-off is a whole turn on the colleague, through `runAgentTurn` with the colleague's credential: its limits and
 * spend apply to the key like any chat. Colleagues are only the enabled agents of the caller's own key; never itself,
 * never anyone already in the chain (the caller is waiting on its own turn, so a call back would never be served), and
 * not deeper than `DELEGATE_MAX_DEPTH`. The colleague keeps its conversation across calls from one chat of the caller.
 */
import { config, formatDuration } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { fingerprint } from "./sessions.mjs";
import { truncate } from "./toolsummary.mjs";

const MAX_TASK = 32 * 1024;
const MAX_ANSWER = 32 * 1024;
const PARTIAL_TAIL = 4000; // of what a colleague had written when its turn was stopped

const MAX_SHOWN = 3000; // of one colleague message put in the caller's reply
const QUIET_BEAT_MS = 20_000; // a colleague that says nothing for this long gets a sign of life

/**
 * Show a person what a colleague is doing while its caller waits. `emit(line)` puts a line in the caller's reasoning stream
 * (see runPrompt); the colleague's live log supplies the events: each tool it starts (and fails) and, in "full" mode, the
 * first line of each message it writes. Returns `{stop}`. `tag` is how its lines begin, indented by hand-off depth so a
 * colleague's own colleagues read as nested.
 */
export function followColleague(live, emit, tag, mode, { beatMs = QUIET_BEAT_MS, now = Date.now, message = null, firstLines = mode === "full" } = {}) {
	if (!live?.subscribe || (mode === "off" && !message)) return { stop() {} };
	let last = now();
	const say = (line) => {
		last = now();
		try {
			emit(`${tag} ${line}`);
		} catch {
			/* a closed stream must not break the hand-off */
		}
	};
	let pending = null; // the assistant message being written: {id, text}
	const reported = new Set();
	// A finished message of the colleague: whole to `message` (shown in the caller's reply), or its first line as reasoning.
	const flush = () => {
		const full = pending?.text.trim();
		pending = null;
		if (!full) return;
		if (message) {
			last = now();
			try {
				message(full.length > MAX_SHOWN ? `${full.slice(0, MAX_SHOWN)}…` : full);
			} catch {
				/* a closed stream must not break the hand-off */
			}
		} else if (firstLines) say(`› ${truncate(full.split("\n")[0], 160)}`);
	};
	const unsubscribe = live.subscribe((change) => {
		const item = change?.item;
		if (!item) return;
		if (change.op === "add") {
			if (pending && !(item.kind === "assistant" && item.id === pending.id)) flush();
			if (item.kind === "tool" && mode !== "off") say(`▸ ${item.summary}`);
			else if (item.kind === "assistant") pending = { id: item.id, text: String(item.text ?? "") };
		} else if (change.op === "update") {
			if (item.kind === "assistant" && pending?.id === item.id) pending.text = String(item.text ?? "");
			else if (item.kind === "tool" && mode !== "off" && item.state === "error" && !reported.has(item.id)) {
				reported.add(item.id);
				say(`✗ ${item.name} failed`);
			}
		}
	});
	const started = now();
	const beat = mode === "full" ? setInterval(() => void (now() - last >= beatMs && say(`… still working (${formatDuration(Math.round((now() - started) / 1000) * 1000)})`)), Math.max(1000, Math.floor(beatMs / 2))) : null;
	beat?.unref?.();
	return {
		stop() {
			clearInterval(beat);
			unsubscribe();
			flush();
		},
	};
}

/** Whether an agent of this record may delegate at all, now. */
export function mayDelegate(record) {
	if (!config.DELEGATE_ENABLED || !record?.agentId) return false;
	return Boolean(agents.get(record.agentId)?.canDelegate);
}

/** The colleagues `record` may hand work to. */
export function colleagues(record) {
	if (!mayDelegate(record)) return [];
	const chain = new Set([record.agentId, ...(record.delegateChain ?? [])]);
	return agents.listByKey(record.keyId).filter((a) => a.enabled && !chain.has(a.id)).map((a) => ({ name: a.name, description: a.description || "" }));
}

const ROSTER_MAX = 30;

/**
 * The colleagues as a block for the agent's system prompt, so a newly created agent is used on the next turn without
 * the model having to ask. An agent with no description is listed by name and says so. Empty when the agent may not
 * delegate; a short note when it may but nobody else is there.
 */
export function rosterText(record) {
	if (!mayDelegate(record)) return "";
	const list = colleagues(record);
	if (!list.length) return "You may hand work to the other agents of this key, but there are none enabled right now: do the work yourself or tell the user which kind of agent is missing.";
	const shown = list.slice(0, ROSTER_MAX).map((a) => `- ${a.name}: ${a.description ? a.description.replace(/\s+/g, " ").slice(0, 200) : "(no description: judge by its name)"}`);
	return `Your colleagues right now (agents of this key you can hand work to with piper_delegate), with what each is for:\n${shown.join("\n")}${list.length > ROSTER_MAX ? `\n… and ${list.length - ROSTER_MAX} more (piper_agents lists them all)` : ""}`;
}

/**
 * What the bridge hands to a chat's socket: `{agents(), delegate(name, task, signal)}`. `delegate` resolves to the
 * colleague's text, or throws an Error whose message is for the calling agent to read.
 */
export function delegatorFor(record) {
	return {
		agents: () => colleagues(record),
		roster: () => rosterText(record),
		async delegate(name, task, signal) {
			if (!config.DELEGATE_ENABLED) throw new Error("delegation is switched off on this gateway");
			if (!mayDelegate(record)) throw new Error("this agent is not allowed to delegate");
			const text = String(task ?? "");
			if (!text.trim()) throw new Error("there is no task to give");
			if (text.length > MAX_TASK) throw new Error(`the task is over ${MAX_TASK} characters`);
			const depth = (record.delegateDepth ?? 0) + 1;
			const limit = Number(config.DELEGATE_MAX_DEPTH ?? 3);
			if (depth > limit) throw new Error(`hand-offs may be chained ${limit} deep and this would be ${depth}: do this part yourself`);
			const target = agents.find(record.keyId, String(name ?? ""));
			if (!target) throw new Error(`there is no agent called "${name}" on this key; ask piper_agents for the list`);
			if (target.id === record.agentId) throw new Error("an agent cannot hand work to itself");
			if ((record.delegateChain ?? []).includes(target.id)) throw new Error(`"${target.name}" is already waiting on this chain of hand-offs: calling it would never be answered`);
			if (!target.enabled) throw new Error(`"${target.name}" is switched off`);
			const caller = agents.get(record.agentId);
			const credential = credentialFor(record.keyId, target.id, { delegateDepth: depth, delegateChain: [...(record.delegateChain ?? []), record.agentId] });
			const controller = new AbortController();
			const forward = () => controller.abort();
			signal?.addEventListener("abort", forward, { once: true });
			const timer = setTimeout(() => controller.abort(), Number(config.DELEGATE_TIMEOUT_MS ?? 600_000));
			record.live?.note(`handing a task to ${target.name}`);
			const started = Date.now();
			// What the colleague has written so far, and its chat record: if its turn is cut short the caller gets both,
			// rather than a bare "could not do it" that throws the work away.
			let partial = "";
			let colleagueRecord = null;
			// What the colleague is doing goes to the person watching the caller's reply (the caller's turn has set record.progress).
			const mode = String(config.DELEGATE_PROGRESS ?? "full");
			const tag = `${"  ".repeat(depth - 1)}[${target.name}]`;
			const emit = (line) => record.progress?.(line);
			// Whole messages of the colleague go into the caller's reply as "(name): …" (record.say, set by the caller's turn).
			// The caller's own choice, else the gateway setting.
			const messages = String(caller?.delegateMessages ?? config.DELEGATE_MESSAGES ?? "chat");
			const say = messages === "chat" && record.say ? (message) => record.say([target.name], message) : null;
			let follower = { stop() {} };
			if (mode !== "off" && record.progress) emit(`${tag} ▸ started: ${truncate(text.replace(/\s+/g, " ").trim(), 100)}`);
			try {
				const result = await runAgentTurn({
					credential,
					clientSessionId: `delegate:${fingerprint(record.id)}:${target.id}`,
					prompt: text,
					signal: controller.signal,
					onDelta: (d) => void (partial += d),
					onSession: (r) => {
						colleagueRecord = r;
						// Its own hand-offs report up through this one, indented, instead of into a stream nobody reads.
						r.progressUp = (line) => emit(line);
						r.sayUp = (chain, message) => record.say?.([target.name, ...chain], message);
						follower = followColleague(r.live, emit, tag, record.progress ? mode : "off", { message: say, firstLines: messages === "thinking" && mode === "full" });
					},
				});
				follower.stop();
				if (mode !== "off") emit(`${tag} ✓ done in ${formatDuration(Math.max(1000, Math.round((Date.now() - started) / 1000) * 1000))}`);
				const answer = String(result.text ?? "");
				audit("runtime.delegate", `${caller?.name ?? "?"} -> ${target.name}`, `depth ${depth}, ${Math.round((Date.now() - started) / 1000)} s, $${result.cost.toFixed(4)}`, { actor: "system" });
				record.live?.note(`${target.name} answered`);
				return answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n… (cut at ${MAX_ANSWER} characters)` : answer || "(no text)";
			} catch (err) {
				follower.stop();
				const timedOut = controller.signal.aborted && !signal?.aborted;
				const why = controller.signal.aborted ? (signal?.aborted ? "the caller stopped" : `it ran out of time (the limit is ${formatDuration(Number(config.DELEGATE_TIMEOUT_MS ?? 600_000))}, DELEGATE_TIMEOUT_MS) and was stopped`) : err instanceof AgentRunError ? err.message : String(err?.message ?? err);
				audit("runtime.delegate", `${caller?.name ?? "?"} -> ${target.name}`, `failed: ${why}`, { actor: "system" });
				if (mode !== "off") emit(`${tag} ✗ stopped: ${truncate(why, 120)}`);
				// Something that happened to the colleague's container (killed for memory, gone) is queued as a notice for its
				// own next reply, which the caller never reads: say it here, once.
				const notices = colleagueRecord?.notices?.splice(0) ?? [];
				const lines = [`"${target.name}" could not do it: ${why}`];
				if (notices.length) lines.push(`What happened to its container: ${notices.join("; ")}`);
				if (partial.trim()) lines.push(`What it had written before it stopped${partial.length > PARTIAL_TAIL ? ` (the last ${PARTIAL_TAIL} characters)` : ""}:\n${partial.slice(-PARTIAL_TAIL)}`);
				if (timedOut) lines.push(`Its conversation is kept: you can call it again and ask it to continue from where it stopped, or give it a smaller part of the work.`);
				throw new Error(lines.join("\n\n"));
			} finally {
				if (colleagueRecord) colleagueRecord.progressUp = colleagueRecord.sayUp = null;
				clearTimeout(timer);
				signal?.removeEventListener("abort", forward);
			}
		},
	};
}
