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
	// The extensions and bundles this agent gets: blank (null) follows its key; "none", names or * otherwise.
	sharedBundles: row.shared_bundles ?? null,
	container: parseJson(row.container_json),
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
	create({ keyId, name, workspace = "own", model = null, thinking = null, container = null, port = 0 }) {
		const slug = String(name ?? "").trim();
		if (!AGENT_NAME.test(slug)) throw new Error("the agent's name must be lowercase letters, digits and hyphens, starting with a letter or digit (at most 31 characters)");
		if (this.find(keyId, slug)) throw new Error(`this key already has an agent called "${slug}"`);
		if (!WORKSPACE_MODES.includes(workspace)) throw new Error(`workspace must be one of ${WORKSPACE_MODES.join(", ")}`);
		const id = crypto.randomBytes(4).toString("hex");
		const now = Date.now();
		this.#db
			.prepare("INSERT INTO agents (id, key_id, name, port, workspace, model, thinking, container_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
			.run(id, keyId, slug, Number(port) || 0, workspace, model || null, thinking || null, container ? JSON.stringify(container) : null, now);
		this.reload();
		return this.get(id);
	}

	/** Change an agent. An absent field is left alone. The workspace mode is not changeable: it decides where its files are. */
	update(id, { name, model, thinking, container, enabled, port, description, canDelegate, sharedBundles }) {
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
			description: description === undefined ? agent.description : String(description ?? "").trim().slice(0, 300),
		};
		this.#db
			.prepare("UPDATE agents SET name = ?, model = ?, thinking = ?, container_json = ?, enabled = ?, port = ?, description = ?, can_delegate = ?, shared_bundles = ? WHERE id = ?")
			.run(nextName, next.model, next.thinking, next.container ? JSON.stringify(next.container) : null, next.enabled ? 1 : 0, next.port, next.description, next.canDelegate ? 1 : 0, next.sharedBundles, id);
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
