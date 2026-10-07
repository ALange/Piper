/**
 * Run one turn on an agent without an HTTP client: for scheduled jobs, delegation between agents, and teams.
 *
 * It goes through the very same steps as a chat request: the credential's session cap, replacement of a crashed
 * agent, the daily spend cap, the model allow-list, and `runPrompt` for the turn itself. A turn is therefore
 * limited, metered and attributed exactly as if a client had sent it with that key.
 */
import crypto from "node:crypto";
import { ApiKeyStore, apiKeys, modelAllowed } from "./auth.mjs";
import { agentScope, agents } from "./agents.mjs";
import { modelRuntime, resolveModel } from "./models.mjs";
import { fingerprint, sessions, spendRefusal } from "./sessions.mjs";
import { AgentRunError, isReloadCommand, openSession, parseGatewayCommand, readySession, reloadSession, runGatewayCommand, runPrompt, startedSession, usageDelta } from "./chat.mjs";
import { auditOnce } from "./audit.mjs";

export { AgentRunError };

/**
 * The credential a run uses: the owning key's, and for an agent endpoint the agent's own scope, exactly what the
 * agent's port builds for a request. A key that is revoked, expired or gone cannot run anything (401).
 */
export function credentialFor(keyId, agentId = null, extra = {}) {
	const key = apiKeys.get(keyId);
	if (!key) throw new AgentRunError("the key this belongs to no longer exists", 401, "invalid_api_key", "authentication_error");
	const problem = ApiKeyStore.problem(key);
	if (problem) throw new AgentRunError(`the key this belongs to is ${problem}`, 401, "invalid_api_key", "authentication_error");
	if (!agentId) return key;
	const agent = agents.get(agentId);
	if (!agent || agent.keyId !== key.id) throw new AgentRunError("no such agent for this key", 404, "not_found", "invalid_request_error");
	if (!agent.enabled) throw new AgentRunError(`the agent "${agent.name}" is switched off`, 409, "agent_disabled", "invalid_request_error");
	return { ...key, name: `${key.name} / ${agent.name}`, scopeId: agentScope(key.id, agent.id), agent: { id: agent.id, name: agent.name }, ...extra };
}

/**
 * Run `prompt` on the session `clientSessionId` of `credential` (a new session when none is given) and return
 * `{text, reasoning, usage, cost, sessionId, scopedId, fingerprint, isNew}`. `onDelta` and `onThinking` see the text as it streams;
 * `signal` aborts the turn. `images` (optional, `{type:"image", data, mimeType}[]`, the same shape `resolveImages`
 * builds for a client request) is dropped by `runPrompt` itself with a text note when the session's model cannot
 * see images; nothing here needs to know that. `/reload` and the gateway's own commands (`/piper`, `/skills`,
 * `/extensions`, `/settings`, `/profile`) are answered directly, the same as `/v1/chat/completions`, never
 * reaching the model. Throws AgentRunError for everything a request would be refused for.
 */
async function runTurnForReal({ credential, clientSessionId = crypto.randomUUID(), prompt, model = null, images = [], signal, onDelta, onThinking, onSession, inbox = false, colleagues = false }) {
	const text = String(prompt ?? "");
	if (!text.trim()) throw new AgentRunError("there is nothing to ask: the prompt is empty", 400, "invalid_request_error", "invalid_request_error");
	if (model) {
		const requested = resolveModel(await modelRuntime(), model);
		if (requested && !modelAllowed(credential?.id ?? null, requested)) {
			auditOnce(`limit:${credential?.id ?? "open"}:model`, 60_000, "runtime.limit", credential?.name ?? "open gateway", `model ${requested.provider}/${requested.id} is not allowed for this key`);
			throw new AgentRunError(`model ${requested.provider}/${requested.id} is not allowed for this API key`, 400, "model_not_allowed", "invalid_request_error");
		}
	}
	const acquired = await readySession(credential, openSession(credential, clientSessionId));
	const { id: sessionId, record, isNew } = acquired;
	// `/reload` and the gateway's own `/piper`, `/skills`, `/extensions`, `/settings`, `/profile` commands
	// (lib/chat.mjs) never reach the model and are handled here, the same as `/v1/chat/completions` already
	// does, so a chat through the Portal or the Playground gets them too instead of sending the literal
	// text to the agent. Checked before the spend cap: managing a profile must still work when over it.
	const noUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
	if (isReloadCommand(text)) {
		let out;
		try {
			out = await reloadSession(record);
		} catch (err) {
			throw new AgentRunError(`Reload failed: ${err?.message ?? err}`, 500, "server_error", "server_error");
		}
		onSession?.(record);
		return { text: out, reasoning: "", usage: noUsage, cost: 0, sessionId: clientSessionId, scopedId: sessionId, fingerprint: fingerprint(sessionId), isNew };
	}
	const gatewayCommand = parseGatewayCommand(text);
	if (gatewayCommand) {
		let out;
		try {
			out = await runGatewayCommand(record, gatewayCommand);
		} catch (err) {
			out = `${gatewayCommand.name} failed: ${err?.message ?? err}`;
		}
		onSession?.(record);
		return { text: out, reasoning: "", usage: noUsage, cost: 0, sessionId: clientSessionId, scopedId: sessionId, fingerprint: fingerprint(sessionId), isNew };
	}
	// Refused before a run is wasted, and a session made only for this refused turn is dropped again.
	const over = spendRefusal(credential);
	if (over) {
		auditOnce(`limit:${credential?.id ?? "open"}:spend`, 60_000, "runtime.limit", credential?.name ?? "open gateway", over);
		if (isNew) sessions.close(sessionId);
		throw new AgentRunError(over, 429, "spend_limit_exceeded", "rate_limit_error");
	}
	const session = await startedSession(record, sessionId);
	// Lets a caller watch the session's events (the dashboard Playground streams tool activity from them).
	onSession?.(record);
	const statsBefore = session.getSessionStats();
	const before = statsBefore.tokens;
	let streamed = "";
	let thought = "";
	const out = await runPrompt(record, text, {
		signal,
		body: model ? { model } : {},
		images,
		context: "",
		inbox,
		colleagues,
		onDelta: (d) => {
			streamed += d;
			onDelta?.(d);
		},
		onThinking: (d) => {
			thought += d;
			onThinking?.(d);
		},
	});
	const statsAfter = (await record.sessionPromise).getSessionStats();
	// `scopedId` is the id the controller knows the session by, for closing it again; `sessionId` is the caller's.
	return { text: out?.text ?? streamed, reasoning: out?.reasoning ?? thought, usage: usageDelta(before, statsAfter.tokens), cost: Math.max(0, (Number(statsAfter.cost) || 0) - (Number(statsBefore.cost) || 0)), sessionId: clientSessionId, scopedId: sessionId, fingerprint: fingerprint(sessionId), isNew };
}

let impl = runTurnForReal;
/** Replace what runs a turn (tests); no argument restores it. */
export const setAgentTurnRunner = (fn) => void (impl = fn ?? runTurnForReal);
export const runAgentTurn = (options) => impl(options);
