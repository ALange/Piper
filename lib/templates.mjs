/**
 * Agent templates, clone, and export/import.
 *
 * What travels is an agent's *profile*: its instructions, settings, skills, extensions, prompts and agent
 * definitions (never `auth.json` or the model files, which the gateway writes itself), plus a few fields of the
 * agent (description, model, thinking, workspace mode and memory/process/cpu limits; never environment, mounts,
 * images or network, which are the operator's call on each gateway).
 *
 * The format is one JSON document, `{format: "piper-agent", version: 1, agent, files: [{path, data(base64)}]}`. It
 * holds regular files only, so a link, a device or a path outside the profile cannot be expressed: a bundle is
 * checked path by path here and again by the profile helper (inside a throwaway container) that writes it. The
 * gateway never opens a profile file itself.
 *
 * Built-in templates are folders in `templates/` (a `template.json` and a `profile/` tree); templates the operator
 * saves from an agent live in the database.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_DIR, config, db } from "./settings.mjs";
import { agentScope, agents, AGENT_NAME } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { AgentError, createAgent, deleteAgent } from "./agentservers.mjs";
import { profileOp } from "./profiles.mjs";

export const TEMPLATE_DIR = join(GATEWAY_DIR, "templates");
const TOP = ["AGENTS.md", "settings.json", "skills", "extensions", "prompts", "agents"];
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,127}$/;
const MAX_FILES = 500;
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const WORKSPACES = ["own", "shared"];
const LIMITS = ["memoryMb", "pids", "cpus"];

const bad = (message, status = 400) => new AgentError(message, status);

/** Whether a path may travel: relative plain names, under one of the profile's own top entries. */
export function validPath(path) {
	const text = String(path ?? "");
	const parts = text.split("/");
	if (!text || text.length > 400 || parts.length > 8) return false;
	if (parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) return false;
	if (!TOP.includes(parts[0])) return false;
	return !((parts[0] === "AGENTS.md" || parts[0] === "settings.json") && parts.length !== 1);
}

/** The agent fields a bundle may carry, in their stored shape; anything else is dropped. */
function agentFields(raw = {}) {
	const out = {};
	out.description = String(raw.description ?? "").slice(0, 300);
	out.model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim().slice(0, 200) : null;
	out.thinking = THINKING.includes(raw.thinking) ? raw.thinking : null;
	out.workspace = WORKSPACES.includes(raw.workspace) ? raw.workspace : "own";
	const container = {};
	for (const k of LIMITS) if (raw.container && Number.isFinite(Number(raw.container[k])) && Number(raw.container[k]) > 0) container[k] = Number(raw.container[k]);
	out.container = Object.keys(container).length ? container : null;
	return out;
}

/**
 * Check a parsed bundle and return `{agent, files}`, or throw a 400 naming the problem. Every path is validated,
 * duplicates (ignoring case) are refused, data must be base64, and the decoded total is capped.
 */
export function validateBundle(raw, { maxBytes = config.EXPORT_MAX_BYTES } = {}) {
	if (!raw || typeof raw !== "object" || raw.format !== "piper-agent") throw bad("this is not a Piper agent bundle (format must be \"piper-agent\")");
	if (raw.version !== 1) throw bad(`this bundle is version ${raw.version}; this gateway reads version 1`);
	if (!Array.isArray(raw.files)) throw bad("the bundle has no list of files");
	if (raw.files.length > MAX_FILES) throw bad(`a bundle holds at most ${MAX_FILES} files`);
	const seen = new Set();
	let total = 0;
	const files = raw.files.map((f) => {
		if (!f || typeof f !== "object" || !validPath(f.path)) throw bad(`a file path that cannot be used: ${String(f?.path).slice(0, 80)}`);
		const key = f.path.toLowerCase();
		if (seen.has(key)) throw bad(`the same file twice: ${f.path}`);
		seen.add(key);
		if (typeof f.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) throw bad(`the contents of ${f.path} are not valid base64`);
		total += Math.floor((f.data.length * 3) / 4);
		if (total > maxBytes) throw bad(`the bundle is over the ${maxBytes}-byte limit`);
		return { path: f.path, data: f.data };
	});
	const agent = agentFields(raw.agent);
	const name = raw.agent?.name;
	if (name !== undefined && name !== null) {
		if (!AGENT_NAME.test(String(name))) throw bad("the bundle's agent name is not a valid name");
		agent.name = String(name);
	}
	return { agent, files, bytes: total };
}

// ---------------------------------------------------------------------------------------------
// Export, import, clone
// ---------------------------------------------------------------------------------------------

/** An agent as a bundle. The profile is read by the helper in a throwaway container. */
export async function exportAgent(agentId) {
	const agent = agents.get(agentId);
	if (!agent) throw bad("no such agent", 404);
	const tree = await profileOp(agentScope(agent.keyId, agent.id), { op: "tree.export", max: config.EXPORT_MAX_BYTES });
	audit("agent.export", `${agent.name}`, `${tree.files.length} file(s), ${tree.bytes} bytes${tree.skipped ? `, ${tree.skipped} skipped (links or odd files)` : ""}`);
	return {
		format: "piper-agent",
		version: 1,
		exported: new Date().toISOString(),
		agent: { name: agent.name, description: agent.description ?? "", model: agent.model, thinking: agent.thinking, workspace: agent.workspace, container: agentFields({ container: agent.container }).container },
		files: tree.files,
		skipped: tree.skipped,
	};
}

/**
 * Make an agent of `keyId` from validated bundle contents. A model this gateway does not have is dropped (and
 * reported in `warnings`) rather than failing the whole import. If writing the profile fails the agent is removed again.
 */
export async function createFromBundle({ keyId, name, agent: fields, files }) {
	const warnings = [];
	let created;
	try {
		created = await createAgent({ keyId, name, workspace: fields.workspace, model: fields.model, thinking: fields.thinking, container: fields.container });
	} catch (err) {
		if (!fields.model || !/model/i.test(err.message)) throw err;
		warnings.push(`the model "${fields.model}" is not available here, so the agent uses the default`);
		created = await createAgent({ keyId, name, workspace: fields.workspace, model: null, thinking: null, container: fields.container });
	}
	try {
		if (files.length) await profileOp(agentScope(keyId, created.id), { op: "tree.import", files, max: config.EXPORT_MAX_BYTES });
		if (fields.description) agents.update(created.id, { description: fields.description });
	} catch (err) {
		await deleteAgent(created.id).catch(() => {});
		throw err;
	}
	return { agent: agents.get(created.id), warnings };
}

/** Import a bundle (already parsed from JSON) as a new agent of a key. `name` overrides the bundle's. */
export async function importBundle({ keyId, bundle, name = null }) {
	const checked = validateBundle(bundle);
	const finalName = name || checked.agent.name;
	if (!finalName) throw bad("give the agent a name");
	const result = await createFromBundle({ keyId, name: finalName, agent: checked.agent, files: checked.files });
	audit("agent.import", `${finalName}`, `${checked.files.length} file(s), ${checked.bytes} bytes into key ${keyId}`);
	return result;
}

/** A copy of an agent, as a new agent of the same key: its profile and settings, not its workspace or its container's state. */
export async function cloneAgent(agentId, name) {
	const source = agents.get(agentId);
	if (!source) throw bad("no such agent", 404);
	const bundle = await exportAgent(agentId);
	const checked = validateBundle(bundle);
	const result = await createFromBundle({ keyId: source.keyId, name, agent: { ...checked.agent, workspace: source.workspace }, files: checked.files });
	audit("agent.clone", `${source.name} -> ${name}`, `${checked.files.length} file(s)`);
	return result;
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

/** The files of a built-in template folder, host side. The folder is the project's own; links are skipped. */
function readFolder(root) {
	const files = [];
	const walk = (rel) => {
		for (const name of readdirSync(join(root, rel)).sort()) {
			const path = rel ? `${rel}/${name}` : name;
			const stat = lstatSync(join(root, path));
			if (stat.isDirectory()) walk(path);
			else if (stat.isFile() && validPath(path)) files.push({ path, data: readFileSync(join(root, path)).toString("base64") });
		}
	};
	walk("");
	return files;
}

function builtins() {
	let names = [];
	try {
		names = readdirSync(TEMPLATE_DIR).sort();
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		try {
			const meta = JSON.parse(readFileSync(join(TEMPLATE_DIR, name, "template.json"), "utf8"));
			out.push({ name, builtin: true, ...agentFields({ ...meta, container: null }), files: readFolder(join(TEMPLATE_DIR, name, "profile")) });
		} catch {
			/* a folder without a valid template.json is not a template */
		}
	}
	return out;
}

function saved() {
	return db.prepare("SELECT * FROM templates ORDER BY name").all().map((r) => ({ name: r.name, builtin: false, description: r.description, model: r.model, thinking: r.thinking, workspace: r.workspace, container: null, files: JSON.parse(r.files_json) }));
}

const summary = (t) => ({ name: t.name, builtin: t.builtin, description: t.description, model: t.model, thinking: t.thinking, workspace: t.workspace, files: t.files.map((f) => f.path) });

/** Every template: the built-in ones first, then the operator's. */
export const listTemplates = () => [...builtins(), ...saved()].map(summary);
export const getTemplate = (name) => [...builtins(), ...saved()].find((t) => t.name === name) ?? null;

/** Save an agent's profile as a template (a copy; later changes to the agent do not touch it). */
export async function saveTemplate({ fromAgent, name, description = "" }) {
	if (!TEMPLATE_NAME.test(String(name))) throw bad("a template's name is lowercase letters, digits and hyphens (at most 31 characters)");
	if (getTemplate(name)) throw bad(`there is already a template called "${name}"`, 409);
	const bundle = await exportAgent(fromAgent);
	const checked = validateBundle(bundle, { maxBytes: config.TEMPLATE_MAX_BYTES });
	const fields = checked.agent;
	db.prepare("INSERT INTO templates (name, description, model, thinking, workspace, files_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(name, String(description || fields.description || "").slice(0, 300), fields.model, fields.thinking, fields.workspace, JSON.stringify(checked.files), Date.now());
	audit("agent.template", name, `saved from ${agents.get(fromAgent)?.name}; ${checked.files.length} file(s)`);
	return summary(getTemplate(name));
}

export function deleteTemplate(name) {
	const t = getTemplate(name);
	if (!t) throw bad("no such template", 404);
	if (t.builtin) throw bad("a built-in template cannot be deleted", 409);
	db.prepare("DELETE FROM templates WHERE name = ?").run(name);
	audit("agent.template", name, "deleted");
	return true;
}

/** A new agent of `keyId` from a template. The caller's own choices (model, thinking, workspace) win over the template's. */
export async function createFromTemplate({ keyId, template, name, workspace, model, thinking, container }) {
	const t = getTemplate(template);
	if (!t) throw bad(`no template called "${template}"`, 404);
	const fields = { ...t, workspace: workspace || t.workspace, model: model || t.model, thinking: thinking || t.thinking, container: container ?? null };
	const result = await createFromBundle({ keyId, name, agent: fields, files: t.files });
	audit("agent.create", `${name}`, `from template ${template}`);
	return result;
}
