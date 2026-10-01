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
import { config } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { fingerprint } from "./sessions.mjs";

const MAX_TASK = 32 * 1024;
const MAX_ANSWER = 32 * 1024;

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
			try {
				const result = await runAgentTurn({ credential, clientSessionId: `delegate:${fingerprint(record.id)}:${target.id}`, prompt: text, signal: controller.signal });
				const answer = String(result.text ?? "");
				audit("runtime.delegate", `${caller?.name ?? "?"} -> ${target.name}`, `depth ${depth}, ${Math.round((Date.now() - started) / 1000)} s, $${result.cost.toFixed(4)}`, { actor: "system" });
				record.live?.note(`${target.name} answered`);
				return answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n… (cut at ${MAX_ANSWER} characters)` : answer || "(no text)";
			} catch (err) {
				const why = controller.signal.aborted ? (signal?.aborted ? "the caller stopped" : "it took too long") : err instanceof AgentRunError ? err.message : String(err?.message ?? err);
				audit("runtime.delegate", `${caller?.name ?? "?"} -> ${target.name}`, `failed: ${why}`, { actor: "system" });
				throw new Error(`"${target.name}" could not do it: ${why}`);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", forward);
			}
		},
	};
}
