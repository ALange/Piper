/**
 * Agent endpoints: for each enabled agent (lib/agents.mjs) an HTTP server of its own on its own port,
 * speaking the same OpenAI-compatible API as the gateway but as that agent: its profile, its
 * persistent container, its workspace. Plus the operations the dashboard performs on agents.
 *
 * What an agent port serves is deliberately small: the chat, the model list, the agent's own profile
 * and files. Never the dashboard, never settings. It accepts only the API key the agent belongs to,
 * so revoking or expiring the key closes every one of its agents, and no new secret exists.
 */
import { deleteJobsOf } from "./jobs.mjs";
import http from "node:http";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config, parsePortRange } from "./settings.mjs";
import { ApiKeyStore, apiKeys, bearerToken, keyLabel, modelAllowed } from "./auth.mjs";
import { agentScope, agents, DELEGATE_MESSAGE_MODES } from "./agents.mjs";
import { archiveRoot, profileRoot, scopeOf, workspaceRoot } from "./paths.mjs";
import { cors, logAccess, readJson, sendError } from "./http.mjs";
import { chatCompletions, listModels } from "./chat.mjs";
import { ensureProfile, ensureWorkspace, filesRoutes, invalidateSize, profileOp, profileRoutes } from "./profiles.mjs";
import { agentSpendToday, sessions } from "./sessions.mjs";
import { removePersistentContainer } from "./containers.mjs";
import { checkedContainerSettings } from "./keycontainer.mjs";
import { modelRuntime, resolveModel } from "./models.mjs";
import { resetEngineCheck } from "./engine.mjs";
import { alert } from "./alerts.mjs";
import { audit, auditOnce, runWithActor } from "./audit.mjs";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const INSTRUCTIONS_MAX = 64 * 1024;

/** A problem with an agent request, with the HTTP status to answer with. */
export class AgentError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------------------------
// The servers
// ---------------------------------------------------------------------------------------------

/** agentId -> { server, port } for the agents that are listening. */
const open = new Map();

/** Whether an agent is reachable: listening, switched off, or enabled but without a port (it could not bind). */
export function agentStatus(agent) {
	if (!agent.enabled) return "disabled";
	return open.has(agent.id) ? "listening" : "port-lost";
}

export const listeningPort = (agentId) => open.get(agentId)?.port ?? null;

/**
 * The request handler of one agent's port. It looks the agent up by id on every request, so a rename,
 * a new default model or a disable takes effect at once, and an agent that was deleted answers 404.
 */
export function agentHandler(agentId) {
	// Everything the request causes is recorded as that agent's key, from that address.
	return (req, res) => runWithActor(`agent:${agents.get(agentId)?.name ?? agentId}`, req.socket?.remoteAddress, () => handleAgent(agentId, req, res));
}

async function handleAgent(agentId, req, res) {
	const started = Date.now();
	cors(res);
	res.on("finish", () => {
		logAccess(req, res.statusCode, res.sessionNote);
		if (req.method === "POST" && /^\/(v1\/)?chat\/completions$/.test(req.url?.split("?")[0] ?? "")) {
			audit("request.chat", req.credential?.name ?? `agent ${agents.get(agentId)?.name ?? agentId}`, `${res.statusCode} ${Date.now() - started} ms model=${res.auditModel ?? "?"} ${res.sessionNote ?? ""}`.trim());
		}
	});
	try {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		const agent = agents.get(agentId);
		if (!agent || !agent.enabled) return sendError(res, 404, "No such endpoint", "not_found");
		const path = new URL(req.url, "http://localhost").pathname;
		if (req.method === "GET" && (path === "/health" || path === "/")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ status: "ok" }));
		}
		// Only the key this agent belongs to. `verify` refuses unknown, revoked and expired keys, and the
		// settings key is not an API key at all, so it never matches.
		const key = apiKeys.verify(bearerToken(req));
		if (!key || key.id !== agent.keyId) {
			const from = req.socket?.remoteAddress ?? "unknown";
			auditOnce(`authfail:${from}`, 60_000, "authfail.api", from, `agent ${agent.name}: ${req.method} ${path}${bearerToken(req) ? " (a key was sent, and is not this agent's)" : " (no key)"}`);
			return sendError(res, 401, "Invalid API key", "invalid_api_key", "authentication_error");
		}
		req.credential = { ...key, name: `${key.name} / ${agent.name}`, scopeId: agentScope(key.id, agent.id), agent: { id: agent.id, name: agent.name } };
		if (req.method === "GET" && path === "/v1/models") return await listModels(res, req.credential);
		if (path === "/v1/piper/profile" || path.startsWith("/v1/piper/profile/")) return await profileRoutes(req, res, path);
		if (path === "/v1/piper/files" || path.startsWith("/v1/piper/files/")) return await filesRoutes(req, res, req.credential.scopeId, path.slice("/v1/piper/files".length));
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) return await chatCompletions(req, res, await readJson(req));
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 500, err?.message ?? String(err), "server_error", "server_error");
	}
}

export function listenOn(server, port, host) {
	return new Promise((resolve, reject) => {
		const fail = (err) => reject(err);
		server.once("error", fail);
		server.listen(port, host, () => {
			server.off("error", fail);
			resolve(server.address().port);
		});
	});
}

/**
 * A free port inside the configured range, or any free one when there is none. Tried by binding, so
 * "free" is what the system says at this moment. A random order spreads agents over the range.
 */
export async function bindFree(server, host, range) {
	if (!range) return listenOn(server, 0, host);
	const [from, to] = range;
	const size = to - from + 1;
	const start = Math.floor(Math.random() * size);
	for (let i = 0; i < size; i++) {
		const port = from + ((start + i) % size);
		try {
			return await listenOn(server, port, host);
		} catch (err) {
			if (err.code !== "EADDRINUSE") throw err;
		}
	}
	throw new AgentError(`no free port in AGENT_PORT_RANGE ${from}-${to}`, 503);
}

/**
 * Open an agent's port: its stored one when free, else a new one (random, inside AGENT_PORT_RANGE when
 * set), stored so the URL survives a restart. Losing a stored port is raised as an alert and audited:
 * a client that had the old address needs the new one.
 */
export async function startAgent(agent) {
	if (open.has(agent.id)) return open.get(agent.id).port;
	const host = config.HOST;
	const server = http.createServer(agentHandler(agent.id));
	let port = 0;
	let lost = false;
	if (agent.port) {
		try {
			port = await listenOn(server, agent.port, host);
		} catch (err) {
			if (err.code !== "EADDRINUSE") throw err;
			lost = true;
		}
	}
	if (!port) port = await bindFree(server, host, parsePortRange(config.AGENT_PORT_RANGE));
	open.set(agent.id, { server, port });
	// Only once it is listening: a port that was taken is an expected fallback, not something to log.
	server.on("error", (err) => process.stderr.write(`agent ${agent.name}: ${err.message}\n`));
	if (port !== agent.port) agents.update(agent.id, { port });
	if (lost) {
		audit("agent.port", `${keyLabel(agentScope(agent.keyId, agent.id))}`, `port ${agent.port} was taken; now ${port}`);
		await alert(`agent_port:${agent.id}`, `agent ${agent.name}: port ${agent.port} was taken, so it now listens on ${port}; clients need the new address`, { agent: agent.name, was: agent.port, now: port });
	}
	return port;
}

/** Close an agent's port and its open connections. */
export async function stopAgent(agentId) {
	const entry = open.get(agentId);
	if (!entry) return false;
	open.delete(agentId);
	await new Promise((resolve) => {
		entry.server.close(() => resolve());
		entry.server.closeAllConnections?.();
	});
	return true;
}

/** Open every enabled agent's port. One that cannot bind is reported and left closed; it does not stop the rest. */
export async function startAgentServers() {
	for (const agent of agents.list()) {
		if (!agent.enabled) continue;
		try {
			await startAgent(agent);
		} catch (err) {
			process.stderr.write(`agent ${agent.name}: cannot listen: ${err.message}\n`);
		}
	}
}

export async function stopAgentServers() {
	await Promise.all([...open.keys()].map((id) => stopAgent(id)));
}

// ---------------------------------------------------------------------------------------------
// Operations (what the dashboard does)
// ---------------------------------------------------------------------------------------------

async function checkedModel(keyId, model, thinking) {
	if (thinking && !THINKING_LEVELS.includes(thinking)) throw new AgentError(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	if (!model) return { model: null, thinking: thinking || null };
	const found = resolveModel(await modelRuntime(), model);
	if (!found) throw new AgentError(`no model "${model}" here: use provider/model as /v1/models lists it`);
	if (!modelAllowed(keyId, found)) throw new AgentError(`the model ${found.provider}/${found.id} is not allowed for this key`);
	return { model: `${found.provider}/${found.id}`, thinking: thinking || null };
}

function checkedInstructions(text) {
	if (text === undefined || text === null) return undefined;
	if (typeof text !== "string") throw new AgentError("instructions must be text");
	if (Buffer.byteLength(text) > INSTRUCTIONS_MAX) throw new AgentError(`instructions are limited to ${INSTRUCTIONS_MAX / 1024} KB`);
	return text;
}

/** An agent's own container settings: a key's fields, but it is always persistent, so that one is not a choice. */
async function checkedAgentContainer(raw) {
	if (raw && typeof raw === "object") {
		const { persistent, ...rest } = raw;
		raw = rest;
	}
	return checkedContainerSettings(raw);
}

/** What the dashboard shows of an agent. */
export function agentView(agent) {
	const scope = agentScope(agent.keyId, agent.id);
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description ?? "",
		canDelegate: Boolean(agent.canDelegate),
		canSchedule: Boolean(agent.canSchedule),
		delegateMessages: agent.delegateMessages ?? null,
		sharedBundles: agent.sharedBundles ?? null,
		keyId: agent.keyId,
		key: apiKeys.get(agent.keyId)?.name ?? "(deleted key)",
		scope: scopeOf(scope),
		port: listeningPort(agent.id) ?? agent.port,
		host: config.HOST,
		status: agentStatus(agent),
		enabled: agent.enabled,
		workspace: agent.workspace,
		model: agent.model,
		thinking: agent.thinking,
		container: agent.container,
		createdAt: agent.createdAt,
		chats: sessions.recordsByScope(scope).length,
		spendToday: agentSpendToday(agent.id),
	};
}

/**
 * Create an agent for an existing, usable key: check everything, then build its profile (with the
 * instructions as AGENTS.md, written by the profile helper), its workspace when it has one of its own,
 * and open its port. A failure part-way removes what was made.
 */
export async function createAgent({ keyId, name, workspace = "own", model = null, thinking = null, instructions = "", container = null }) {
	const key = apiKeys.get(keyId);
	if (!key) throw new AgentError("no such API key", 404);
	const problem = ApiKeyStore.problem(key);
	if (problem) throw new AgentError(`this key is ${problem}; an agent needs a usable key`, 409);
	const text = checkedInstructions(instructions);
	const chosen = await checkedModel(keyId, model, thinking);
	const settings = await checkedAgentContainer(container);
	const agent = agents.create({ keyId, name, workspace, model: chosen.model, thinking: chosen.thinking, container: settings });
	const scope = agentScope(keyId, agent.id);
	try {
		ensureProfile(scope);
		if (text) await profileOp(scope, { op: "instructions.put", text });
		if (workspace === "own") ensureWorkspace(scope);
		await startAgent(agent);
	} catch (err) {
		await stopAgent(agent.id).catch(() => {});
		agents.remove(agent.id);
		archiveFolders(scope, agent, { workspace: workspace === "own" });
		throw err;
	}
	resetEngineCheck();
	audit("agent.create", keyLabel(scope), `${workspace} workspace${chosen.model ? `, ${chosen.model}` : ""}, port ${listeningPort(agent.id)}`);
	return agents.get(agent.id);
}

/** Change an agent: its name, model, limits, or instructions. A changed container setting restarts its chats. */
export async function updateAgent(id, { name, model, thinking, instructions, container, description, canDelegate, canSchedule, delegateMessages }) {
	const agent = agents.get(id);
	if (!agent) throw new AgentError("no such agent", 404);
	const scope = agentScope(agent.keyId, agent.id);
	const patch = {};
	if (name !== undefined) patch.name = name;
	if (description !== undefined) patch.description = description;
	if (canDelegate !== undefined) patch.canDelegate = Boolean(canDelegate);
	if (canSchedule !== undefined) patch.canSchedule = Boolean(canSchedule);
	if (delegateMessages !== undefined) {
		const mode = delegateMessages || null;
		if (mode !== null && !DELEGATE_MESSAGE_MODES.includes(mode)) throw new AgentError(`messages from colleagues are one of: ${DELEGATE_MESSAGE_MODES.join(", ")}, or blank to follow the setting`, 400);
		patch.delegateMessages = mode;
	}
	if (model !== undefined || thinking !== undefined) {
		const chosen = await checkedModel(agent.keyId, model === undefined ? agent.model : model, thinking === undefined ? agent.thinking : thinking);
		patch.model = chosen.model;
		patch.thinking = chosen.thinking;
	}
	let containerChanged = false;
	if (container !== undefined) {
		patch.container = await checkedAgentContainer(container);
		containerChanged = JSON.stringify(agent.container) !== JSON.stringify(patch.container);
	}
	const text = checkedInstructions(instructions);
	const updated = agents.update(id, patch);
	if (text !== undefined) await profileOp(scope, { op: "instructions.put", text });
	if (containerChanged) {
		const live = sessions.recordsByScope(scope);
		sessions.closeByScope(scope);
		await Promise.all(live.map((r) => r.stopped));
		resetEngineCheck();
	}
	audit("agent.update", keyLabel(scope), Object.keys({ ...patch, ...(text !== undefined ? { instructions: 1 } : {}) }).join(" ") || "nothing");
	return updated;
}

/** Switch an agent on or off. Off closes its port and stops its chats; its container, profile and files stay. */
export async function setAgentEnabled(id, enabled) {
	const agent = agents.get(id);
	if (!agent) throw new AgentError("no such agent", 404);
	const scope = agentScope(agent.keyId, agent.id);
	const updated = agents.update(id, { enabled });
	if (enabled) {
		await startAgent(updated);
	} else {
		const live = sessions.recordsByScope(scope);
		sessions.closeByScope(scope);
		await Promise.all(live.map((r) => r.stopped));
		await stopAgent(id);
	}
	audit(enabled ? "agent.enable" : "agent.disable", keyLabel(scope), "");
	return agents.get(id);
}

/** Give an agent a new port (close the old one, pick another). */
export async function renewAgentPort(id) {
	const agent = agents.get(id);
	if (!agent) throw new AgentError("no such agent", 404);
	await stopAgent(id);
	const updated = agents.update(id, { port: 0 });
	if (updated.enabled) await startAgent(updated);
	audit("agent.port", keyLabel(agentScope(agent.keyId, agent.id)), `new port ${listeningPort(id)}`);
	return agents.get(id);
}

/** Reset an agent's container: stop its chats and remove the container and what is installed in it. Profile and files stay. */
export async function resetAgentContainer(id) {
	const agent = agents.get(id);
	if (!agent) throw new AgentError("no such agent", 404);
	const scope = agentScope(agent.keyId, agent.id);
	const live = sessions.recordsByScope(scope);
	sessions.closeByScope(scope);
	await Promise.all(live.map((r) => r.stopped));
	await removePersistentContainer(scope);
	audit("agent.reset", keyLabel(scope), "container removed");
}

/**
 * Move an agent's profile, and its workspace when it has one of its own, to the archive rather than
 * deleting them: they expire by ARCHIVE_TTL_MS like any archive. A workspace shared with the key is the
 * key's and is never touched.
 */
function archiveFolders(scope, agent, { workspace = agent.workspace === "own" } = {}) {
	const archive = archiveRoot();
	if (!archive) return;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const move = (dir, label) => {
		if (!existsSync(dir)) return;
		mkdirSync(archive, { recursive: true, mode: 0o700 });
		try {
			renameSync(dir, join(archive, `agent-${agent.name}-${agent.id}-${label}-${stamp}`));
			invalidateSize(dir);
		} catch (err) {
			process.stderr.write(`could not archive ${dir}: ${err.message}\n`);
		}
	};
	if (profileRoot()) move(join(profileRoot(), scopeOf(scope)), "profile");
	if (workspace && workspaceRoot()) move(join(workspaceRoot(), scopeOf(scope)), "workspace");
}

/** Delete an agent: close its port, stop its chats, remove its container, archive its folders, forget it. */
export async function deleteAgent(id) {
	const agent = agents.get(id);
	if (!agent) throw new AgentError("no such agent", 404);
	const scope = agentScope(agent.keyId, agent.id);
	const live = sessions.recordsByScope(scope);
	sessions.closeByScope(scope);
	await Promise.all(live.map((r) => r.stopped));
	await stopAgent(id);
	await removePersistentContainer(scope, { forget: true }).catch(() => {});
	agents.remove(id);
	deleteJobsOf({ agentId: id });
	archiveFolders(scope, agent);
	resetEngineCheck();
	audit("agent.delete", `${apiKeys.get(agent.keyId)?.name ?? "(deleted key)"} / ${agent.name}`, "");
}

/** Delete every agent of a key, for when the key is deleted. */
export async function deleteAgentsOfKey(keyId) {
	for (const agent of agents.listByKey(keyId)) await deleteAgent(agent.id).catch((err) => process.stderr.write(`agent ${agent.name}: ${err.message}\n`));
}
