/**
 * Teams: a fixed chain of agents of one key behind an OpenAI-compatible endpoint of its own.
 *
 * A chat completion sent to a team's port runs its steps in order. Step n's prompt is its instruction with `{{task}}`
 * (what the caller asked) and `{{previous}}` (the last step's answer) filled in; each step runs on its agent through
 * `runAgentTurn`, so the key's limits and spend apply to every step, and the agents keep their own conversation across
 * follow-ups of the same team conversation. The last step's text is the answer. Progress goes to the caller as
 * reasoning (`▸ step 1 of 3: architect`), and a failing step stops the run and is named in the error.
 */
import crypto from "node:crypto";
import http from "node:http";
import { config, db } from "./settings.mjs";
import { ApiKeyStore, apiKeys, bearerToken } from "./auth.mjs";
import { AGENT_NAME, agents } from "./agents.mjs";
import { audit, auditOnce, runWithActor } from "./audit.mjs";
import { cors, logAccess, readJson, sendError } from "./http.mjs";
import { derivedSessionId, listModels, messageText, requestedSessionId } from "./chat.mjs";
import { AgentRunError, credentialFor, runAgentTurn } from "./agentrun.mjs";
import { AgentError, bindFree, listenOn } from "./agentservers.mjs";
import { alert } from "./alerts.mjs";
import { parsePortRange } from "./settings.mjs";

const PLACEHOLDER = /\{\{(task|previous)\}\}/;

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

const parseSteps = (text) => {
	try {
		const v = JSON.parse(text);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
};

export const teamView = (row) => {
	if (!row) return null;
	const steps = parseSteps(row.steps_json).map((s) => ({ agentId: s.agentId, agent: agents.get(s.agentId)?.name ?? null, instruction: s.instruction }));
	return {
		id: row.id,
		keyId: row.key_id,
		key: apiKeys.get(row.key_id)?.name ?? "(deleted key)",
		name: row.name,
		description: row.description,
		steps,
		broken: steps.some((s) => !s.agent),
		enabled: Boolean(row.enabled),
		port: listeningTeamPort(row.id) ?? Number(row.port),
		host: config.HOST,
		status: !row.enabled ? "disabled" : open.has(row.id) ? "listening" : "port-lost",
		createdAt: Number(row.created_at),
	};
};
export const getTeam = (id) => db.prepare("SELECT * FROM teams WHERE id = ?").get(String(id)) ?? null;
export const listTeams = () => db.prepare("SELECT * FROM teams ORDER BY created_at").all().map(teamView);

/** Steps from a form or client: `[{agent: name or id, instruction}]`, checked against the key's own agents. */
export function checkedSteps(keyId, raw) {
	const max = Number(config.TEAM_MAX_STEPS ?? 6);
	if (!Array.isArray(raw) || !raw.length) throw new AgentError("a team needs at least one step");
	if (raw.length > max) throw new AgentError(`a team has at most ${max} steps (TEAM_MAX_STEPS)`);
	return raw.map((s, i) => {
		const ref = String(s?.agent ?? s?.agentId ?? "");
		const agent = agents.listByKey(keyId).find((a) => a.id === ref || a.name === ref);
		if (!agent) throw new AgentError(`step ${i + 1}: this key has no agent "${ref}"`);
		const instruction = String(s?.instruction ?? "");
		if (!PLACEHOLDER.test(instruction)) throw new AgentError(`step ${i + 1}: the instruction must contain {{task}} or {{previous}}, or the agent would never see the work`);
		if (instruction.length > 8000) throw new AgentError(`step ${i + 1}: the instruction is over 8000 characters`);
		return { agentId: agent.id, instruction };
	});
}

export async function createTeam({ keyId, name, description = "", steps }) {
	const key = apiKeys.get(keyId);
	if (!key) throw new AgentError("no such API key", 404);
	const problem = ApiKeyStore.problem(key);
	if (problem) throw new AgentError(`this key is ${problem}`, 409);
	const cap = Number(config.TEAM_MAX_PER_KEY ?? 50);
	if (Number(db.prepare("SELECT COUNT(*) AS n FROM teams WHERE key_id = ?").get(keyId).n) >= cap) throw new AgentError(`this key already has ${cap} teams, the most allowed (TEAM_MAX_PER_KEY); remove one first`, 409);
	const slug = String(name ?? "").trim();
	if (!AGENT_NAME.test(slug)) throw new AgentError("a team's name is lowercase letters, digits and hyphens, starting with a letter or digit (at most 31 characters)");
	if (db.prepare("SELECT 1 FROM teams WHERE key_id = ? AND name = ?").get(keyId, slug)) throw new AgentError(`this key already has a team called "${slug}"`);
	const checked = checkedSteps(keyId, steps);
	const id = crypto.randomBytes(4).toString("hex");
	db.prepare("INSERT INTO teams (id, key_id, name, description, steps_json, port, enabled, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)").run(id, keyId, slug, String(description ?? "").slice(0, 300), JSON.stringify(checked), Date.now());
	try {
		await startTeam(getTeam(id));
	} catch (err) {
		db.prepare("DELETE FROM teams WHERE id = ?").run(id);
		throw err;
	}
	audit("team.create", `${key.name} / ${slug}`, `${checked.length} step(s), port ${listeningTeamPort(id)}`);
	return teamView(getTeam(id));
}

export async function updateTeam(id, { name, description, steps, enabled }) {
	const row = getTeam(id);
	if (!row) throw new AgentError("no such team", 404);
	const next = {
		name: name === undefined ? row.name : String(name).trim(),
		description: description === undefined ? row.description : String(description ?? "").slice(0, 300),
		steps: steps === undefined ? row.steps_json : JSON.stringify(checkedSteps(row.key_id, steps)),
		enabled: enabled === undefined ? Boolean(row.enabled) : Boolean(enabled),
	};
	if (!AGENT_NAME.test(next.name)) throw new AgentError("a team's name is lowercase letters, digits and hyphens (at most 31 characters)");
	const clash = db.prepare("SELECT id FROM teams WHERE key_id = ? AND name = ? AND id <> ?").get(row.key_id, next.name, id);
	if (clash) throw new AgentError(`this key already has a team called "${next.name}"`);
	db.prepare("UPDATE teams SET name = ?, description = ?, steps_json = ?, enabled = ? WHERE id = ?").run(next.name, next.description, next.steps, next.enabled ? 1 : 0, id);
	if (!next.enabled) await stopTeam(id);
	else await startTeam(getTeam(id));
	audit("team.update", `${apiKeys.get(row.key_id)?.name ?? row.key_id} / ${next.name}`, next.enabled ? "on" : "off");
	return teamView(getTeam(id));
}

export async function deleteTeam(id) {
	const row = getTeam(id);
	if (!row) throw new AgentError("no such team", 404);
	await stopTeam(id);
	db.prepare("DELETE FROM teams WHERE id = ?").run(id);
	audit("team.delete", `${apiKeys.get(row.key_id)?.name ?? row.key_id} / ${row.name}`, "");
}

export async function deleteTeamsOfKey(keyId) {
	// One bad team must not block the rest, or leave a key deletion (agents and jobs already gone) stuck
	// partway with no clean way to retry (deleteAgentsOfKey has the same guard, for the same reason).
	for (const row of db.prepare("SELECT id FROM teams WHERE key_id = ?").all(keyId)) await deleteTeam(row.id).catch((err) => process.stderr.write(`team ${row.id}: ${err.message}\n`));
}

// ---------------------------------------------------------------------------------------------
// Running a team
// ---------------------------------------------------------------------------------------------

/** A step's prompt: `{{task}}` and `{{previous}}` filled in. */
export const fillStep = (instruction, task, previous) => String(instruction).replaceAll("{{task}}", task).replaceAll("{{previous}}", previous);

/**
 * Run a team's steps for one request. `conversation` keeps each agent's context across follow-ups. `progress` is called
 * with lines to show the caller. Resolves to `{text, tokens, cost, steps}`; a step that fails throws an error that names it.
 */
export async function runTeam(team, task, { conversation, signal, progress = () => {} } = {}) {
	const steps = parseSteps(team.steps_json);
	const key = apiKeys.get(team.key_id);
	if (!key) throw new AgentRunError("the key this team belongs to no longer exists", 401, "invalid_api_key", "authentication_error");
	let previous = "";
	let tokens = 0;
	let cost = 0;
	for (let i = 0; i < steps.length; i++) {
		const agent = agents.get(steps[i].agentId);
		const label = `step ${i + 1} of ${steps.length}`;
		if (!agent) throw new AgentRunError(`${label} cannot run: its agent was deleted`, 409, "team_broken", "invalid_request_error");
		progress(`▸ ${label}: ${agent.name}\n`);
		const started = Date.now();
		try {
			const result = await runAgentTurn({ credential: credentialFor(key.id, agent.id), clientSessionId: `team:${team.id}:${conversation}:${i}`, prompt: fillStep(steps[i].instruction, task, previous), signal });
			previous = String(result.text ?? "");
			tokens += result.usage?.total_tokens ?? 0;
			cost += result.cost ?? 0;
			progress(`  ✓ ${agent.name} (${Math.round((Date.now() - started) / 1000)} s)\n`);
		} catch (err) {
			if (signal?.aborted) throw err;
			const status = err instanceof AgentRunError ? err.status : 500;
			throw new AgentRunError(`${label} (${agent.name}) failed: ${err.message}`, status, err.code ?? "server_error", err.type ?? "server_error");
		}
	}
	audit("runtime.team", `${key.name} / ${team.name}`, `${steps.length} step(s), ${tokens} tokens, $${cost.toFixed(4)}`, { actor: "system" });
	return { text: previous, tokens, cost, steps: steps.length };
}

// ---------------------------------------------------------------------------------------------
// The servers
// ---------------------------------------------------------------------------------------------

const open = new Map(); // team id -> { server, port }
export const listeningTeamPort = (id) => open.get(id)?.port ?? null;

const chunk = (id, created, model, delta, finish = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function completion(req, res, team, body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const lastUser = [...messages].reverse().find((m) => m?.role === "user");
	const task = lastUser ? messageText(lastUser) : "";
	if (!task.trim()) return sendError(res, 400, "messages needs a user message to give the team", "invalid_request_error");
	const conversation = (requestedSessionId(req, body) ?? derivedSessionId(req, body) ?? crypto.randomUUID()).replace(/[^\w.-]/g, "").slice(0, 80) || crypto.randomUUID();
	res.setHeader("X-Session-Id", conversation);
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});
	const id = `chatcmpl-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const model = `team/${team.name}`;
	const stream = body?.stream === true;
	let reasoning = "";
	if (stream) {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
		res.write(chunk(id, created, model, { role: "assistant", content: "" }));
	}
	try {
		const out = await runTeam(team, task, {
			conversation,
			signal: controller.signal,
			progress: (line) => {
				reasoning += line;
				if (stream) res.write(chunk(id, created, model, { reasoning_content: line }));
			},
		});
		if (stream) {
			res.write(chunk(id, created, model, { content: out.text }));
			res.write(chunk(id, created, model, {}, "stop"));
			return res.end("data: [DONE]\n\n");
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: out.text, reasoning_content: reasoning }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: out.tokens, total_tokens: out.tokens } }));
	} catch (err) {
		const status = err instanceof AgentRunError ? err.status : 500;
		if (stream && res.headersSent) {
			// Headers are out already: the failure goes in the stream, then it ends.
			res.write(chunk(id, created, model, { content: `\n[team error: ${err.message}]` }));
			res.write(chunk(id, created, model, {}, "stop"));
			return res.end("data: [DONE]\n\n");
		}
		return sendError(res, status, err.message, err.code ?? "server_error", err.type ?? "server_error");
	}
}

async function handleTeam(teamId, req, res) {
	cors(res);
	res.on("finish", () => logAccess(req, res.statusCode, res.sessionNote));
	try {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		const row = getTeam(teamId);
		if (!row || !row.enabled) return sendError(res, 404, "No such endpoint", "not_found");
		const path = new URL(req.url, "http://localhost").pathname;
		if (req.method === "GET" && (path === "/health" || path === "/")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ status: "ok" }));
		}
		const key = apiKeys.verify(bearerToken(req));
		if (!key || key.id !== row.key_id) {
			const from = req.socket?.remoteAddress ?? "unknown";
			auditOnce(`authfail:${from}`, 60_000, "authfail.api", from, `team ${row.name}: ${req.method} ${path}${bearerToken(req) ? " (a key was sent, and is not this team's)" : " (no key)"}`);
			return sendError(res, 401, "Invalid API key", "invalid_api_key", "authentication_error");
		}
		req.credential = key;
		if (req.method === "GET" && path === "/v1/models") return await listModels(res, key);
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) return await completion(req, res, row, await readJson(req));
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 500, err?.message ?? String(err), "server_error", "server_error");
	}
}

/** Open a team's port: its stored one when free, else a new one, stored. */
/**
 * Open a team's port: its stored one when free, else a new one (random, inside AGENT_PORT_RANGE when
 * set), stored so the URL survives a restart. Losing a stored port is raised as an alert and audited,
 * same as an agent's own port (startAgent): a client that had the old address needs the new one.
 */
export async function startTeam(row) {
	if (open.has(row.id)) return open.get(row.id).port;
	if (!row.enabled) return null;
	const server = http.createServer((req, res) => runWithActor(`team:${getTeam(row.id)?.name ?? row.id}`, req.socket?.remoteAddress, () => handleTeam(row.id, req, res)));
	let port = 0;
	let lost = false;
	if (row.port) {
		try {
			port = await listenOn(server, Number(row.port), config.HOST);
		} catch (err) {
			if (err.code !== "EADDRINUSE") throw err;
			lost = true;
		}
	}
	if (!port) port = await bindFree(server, config.HOST, parsePortRange(config.AGENT_PORT_RANGE));
	open.set(row.id, { server, port });
	server.on("error", (err) => process.stderr.write(`team ${row.name}: ${err.message}\n`));
	if (port !== Number(row.port)) db.prepare("UPDATE teams SET port = ? WHERE id = ?").run(port, row.id);
	if (lost) {
		audit("team.port", `${apiKeys.get(row.key_id)?.name ?? row.key_id} / ${row.name}`, `port ${row.port} was taken; now ${port}`);
		await alert(`team_port:${row.id}`, `team ${row.name}: port ${row.port} was taken, so it now listens on ${port}; clients need the new address`, { team: row.name, was: Number(row.port), now: port });
	}
	return port;
}

export async function stopTeam(id) {
	const entry = open.get(id);
	if (!entry) return false;
	open.delete(id);
	await new Promise((resolve) => {
		entry.server.close(() => resolve());
		entry.server.closeAllConnections?.();
	});
	return true;
}

export async function startTeamServers() {
	for (const row of db.prepare("SELECT * FROM teams WHERE enabled = 1").all()) {
		try {
			await startTeam(row);
		} catch (err) {
			process.stderr.write(`team ${row.name}: cannot listen: ${err.message}\n`);
		}
	}
}

export async function stopTeamServers() {
	await Promise.all([...open.keys()].map((id) => stopTeam(id)));
}
