/**
 * Agents: named, permanent Pi agents that belong to an API key, each with its own profile, container
 * and port (see lib/agentservers.mjs for the port).
 *
 * Two ids are in play. The **scope id** says where things live (profile, workspace, container): a
 * key's own id for its main endpoint, `<keyId>--<agentId>` for an agent. The **owner key** says who
 * pays and is limited: always the key. `ownerKeyOf` goes from one to the other. `--` cannot occur in
 * a key's UUID, so the split is unambiguous.
 *
 * This module depends on nothing but the settings database, so the modules that resolve ids (auth,
 * paths, profiles) can import it without a cycle. What needs the keys or the models to check (is the
 * key usable, is the model allowed) lives in lib/agentservers.mjs.
 */
import crypto from "node:crypto";
import { db } from "./settings.mjs";

export const AGENT_SEP = "--";
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const WORKSPACE_MODES = ["own", "shared"];
export const MEMORY_MODES = ["own", "shared"];

/** The scope id of an agent of a key. */
export const agentScope = (keyId, agentId) => `${keyId}${AGENT_SEP}${agentId}`;
/** The key an id belongs to: the id itself unless it is an agent's scope id. */
export const ownerKeyOf = (id) => (typeof id === "string" && id.includes(AGENT_SEP) ? id.slice(0, id.indexOf(AGENT_SEP)) : id);
/** The agent id inside a scope id, or null for a key's own scope. */
export const agentIdOf = (id) => (typeof id === "string" && id.includes(AGENT_SEP) ? id.slice(id.indexOf(AGENT_SEP) + AGENT_SEP.length) : null);

function parseJson(text) {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/** How an agent can show its colleagues' messages while it waits for them. */
export const DELEGATE_MESSAGE_MODES = ["chat", "thinking", "off"];

const fromRow = (row) => ({
	id: row.id,
	keyId: row.key_id,
	name: row.name,
	port: Number(row.port) || 0,
	workspace: row.workspace,
	model: row.model ?? null,
	thinking: row.thinking ?? null,
	description: row.description ?? "",
	canDelegate: Boolean(row.can_delegate),
	canSchedule: Boolean(row.can_schedule),
	// null: follow the DELEGATE_MESSAGES setting.
	delegateMessages: row.delegate_messages ?? null,
	// The extensions and bundles this agent gets: blank (null) follows its key; "none", names or * otherwise.
	sharedBundles: row.shared_bundles ?? null,
	container: parseJson(row.container_json),
	// Fixed at creation, like workspace: its own memory, or folded into its key's.
	memoryMode: row.memory_mode,
	enabled: Boolean(row.enabled),
	createdAt: Number(row.created_at),
});

export class AgentStore {
	#database;
	#loaded = null;

	// Nothing is read at construction: settings.mjs loads paths.mjs, which imports this module, before
	// the database exists. The first use reads the table.
	constructor(database = null) {
		this.#database = database;
	}

	get #db() {
		return this.#database ?? db;
	}

	get #byId() {
		if (!this.#loaded) this.reload();
		return this.#loaded;
	}

	reload() {
		this.#loaded = new Map(this.#db.prepare("SELECT * FROM agents ORDER BY created_at").all().map((row) => [row.id, fromRow(row)]));
	}

	list() {
		return [...this.#byId.values()];
	}

	listByKey(keyId) {
		return this.list().filter((a) => a.keyId === keyId);
	}

	get(id) {
		return this.#byId.get(String(id)) ?? null;
	}

	/** An agent by its scope id (`<keyId>--<agentId>`), or null. */
	getByScope(scopeId) {
		const id = agentIdOf(scopeId);
		const agent = id ? this.get(id) : null;
		return agent && agent.keyId === ownerKeyOf(scopeId) ? agent : null;
	}

	find(keyId, name) {
		return this.list().find((a) => a.keyId === keyId && a.name === name) ?? null;
	}

	/** Checked inputs to a stored agent. Throws with a message naming the field. */
	create({ keyId, name, workspace = "own", memoryMode = "own", model = null, thinking = null, container = null, port = 0 }) {
		const slug = String(name ?? "").trim();
		if (!AGENT_NAME.test(slug)) throw new Error("the agent's name must be lowercase letters, digits and hyphens, starting with a letter or digit (at most 31 characters)");
		if (this.find(keyId, slug)) throw new Error(`this key already has an agent called "${slug}"`);
		if (!WORKSPACE_MODES.includes(workspace)) throw new Error(`workspace must be one of ${WORKSPACE_MODES.join(", ")}`);
		if (!MEMORY_MODES.includes(memoryMode)) throw new Error(`memory must be one of ${MEMORY_MODES.join(", ")}`);
		const id = crypto.randomBytes(4).toString("hex");
		const now = Date.now();
		this.#db
			.prepare("INSERT INTO agents (id, key_id, name, port, workspace, memory_mode, model, thinking, container_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
			.run(id, keyId, slug, Number(port) || 0, workspace, memoryMode, model || null, thinking || null, container ? JSON.stringify(container) : null, now);
		this.reload();
		return this.get(id);
	}

	/** Change an agent. An absent field is left alone. The workspace mode is not changeable: it decides where its files are. */
	update(id, { name, model, thinking, container, enabled, port, description, canDelegate, canSchedule, sharedBundles, delegateMessages }) {
		const agent = this.get(id);
		if (!agent) return null;
		let nextName = agent.name;
		if (name !== undefined) {
			nextName = String(name).trim();
			if (!AGENT_NAME.test(nextName)) throw new Error("the agent's name must be lowercase letters, digits and hyphens, starting with a letter or digit (at most 31 characters)");
			const other = this.find(agent.keyId, nextName);
			if (other && other.id !== agent.id) throw new Error(`this key already has an agent called "${nextName}"`);
		}
		const next = {
			model: model === undefined ? agent.model : model || null,
			thinking: thinking === undefined ? agent.thinking : thinking || null,
			container: container === undefined ? agent.container : container,
			enabled: enabled === undefined ? agent.enabled : Boolean(enabled),
			port: port === undefined ? agent.port : Number(port) || 0,
			sharedBundles: sharedBundles === undefined ? agent.sharedBundles : sharedBundles,
			canDelegate: canDelegate === undefined ? agent.canDelegate : Boolean(canDelegate),
			canSchedule: canSchedule === undefined ? agent.canSchedule : Boolean(canSchedule),
			description: description === undefined ? agent.description : String(description ?? "").trim().slice(0, 300),
			delegateMessages: delegateMessages === undefined ? agent.delegateMessages : delegateMessages || null,
		};
		if (next.delegateMessages !== null && !DELEGATE_MESSAGE_MODES.includes(next.delegateMessages)) throw new Error(`messages from colleagues are one of: ${DELEGATE_MESSAGE_MODES.join(", ")} (or blank to follow the setting)`);
		this.#db
			.prepare("UPDATE agents SET name = ?, model = ?, thinking = ?, container_json = ?, enabled = ?, port = ?, description = ?, can_delegate = ?, can_schedule = ?, shared_bundles = ?, delegate_messages = ? WHERE id = ?")
			.run(nextName, next.model, next.thinking, next.container ? JSON.stringify(next.container) : null, next.enabled ? 1 : 0, next.port, next.description, next.canDelegate ? 1 : 0, next.canSchedule ? 1 : 0, next.sharedBundles, next.delegateMessages, id);
		this.reload();
		return this.get(id);
	}

	remove(id) {
		const agent = this.get(id);
		if (!agent) return null;
		this.#db.prepare("DELETE FROM agents WHERE id = ?").run(id);
		this.reload();
		return agent;
	}
}

export const agents = new AgentStore();

/**
 * Where an id's workspace lives: an agent that shares its key's workspace uses the key's; everything
 * else uses its own scope. The one place that rule is written, read by the path helpers.
 */
export function workspaceScopeOf(scopeId) {
	const agent = agents.getByScope(scopeId);
	return agent && agent.workspace === "shared" ? agent.keyId : scopeId;
}

/**
 * Where an id's memory lives: a key's own chats and a named agent's own chats already share one scope
 * id each with no extra rule needed (every chat of the same key or the same agent resolves to the same
 * scope id already); the one choice left is whether a named agent's memory folds into its key's instead
 * of staying its own, fixed when the agent is made (like workspace, for the same reason: it decides
 * what the agent can already see).
 */
export function memoryScopeOf(scopeId) {
	const agent = agents.getByScope(scopeId);
	return agent && agent.memoryMode === "shared" ? agent.keyId : scopeId;
}
