/**
 * The agent creation wizard's backend: what the steps offer, and creating an agent from all the choices at once.
 *
 *   wizardOptions()   keys, templates (with their instructions and skills), what can be granted, thinking levels
 *   createFromWizard  {keyId, name, description, template?, model, thinking, workspace, instructions,
 *                      skills: {exclude: [names], add: [{name, content}]}, extensions: null | "a,b" | "none",
 *                      packages: ["npm:x"], container, canDelegate}
 *
 * It builds on what the quick Create form and the templates already do: the profile is written by the profile helper from a
 * list of validated files, the container settings go through the same checks, and a failure at any point removes the agent
 * again. Nothing here opens a profile file.
 */
import { ApiKeyStore, apiKeys, dashboardHash, expiryFromInput } from "./auth.mjs";
import { agents, agentScope } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { AgentError, THINKING_LEVELS, createAgent, deleteAgent } from "./agentservers.mjs";
import { bundleListFromInput, listShared, profileOp } from "./profiles.mjs";
import { getTemplate, listTemplates, validateBundle } from "./templates.mjs";
import { PackageError, packageJobView, installPackage, validateSource } from "./pipackages.mjs";
import { config } from "./settings.mjs";

const INSTRUCTIONS_MAX = 64 * 1024;
const SKILL_MAX = 64 * 1024;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PACKAGES = 5;
const bad = (message, status = 400) => new AgentError(message, status);

const textOf = (file) => Buffer.from(file.data, "base64").toString("utf8");
const frontmatterOf = (text) => {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m?.[1] ?? "")?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
	return { name: field("name"), description: field("description") };
};

/** The skills a template ships: one per `skills/<name>/` folder, with the description from its SKILL.md. */
function skillsOf(files) {
	const names = [...new Set(files.filter((f) => f.path.startsWith("skills/") && f.path.split("/").length >= 3).map((f) => f.path.split("/")[1]))].sort();
	return names.map((name) => {
		const skill = files.find((f) => f.path === `skills/${name}/SKILL.md`);
		return { name, description: skill ? frontmatterOf(textOf(skill)).description : "" };
	});
}

/** Everything the wizard's steps offer. */
export function wizardOptions() {
	const templates = listTemplates().map((t) => {
		const full = getTemplate(t.name);
		const instructions = full.files.find((f) => f.path === "AGENTS.md");
		return { name: t.name, builtin: t.builtin, description: t.description, model: t.model, thinking: t.thinking, workspace: t.workspace, canDelegate: t.canDelegate, instructions: instructions ? textOf(instructions) : "", skills: skillsOf(full.files) };
	});
	return {
		keys: apiKeys.list().map((k) => ({ id: k.id, name: k.name, usable: !ApiKeyStore.problem(k), allowedModels: k.allowedModels ?? config.KEY_ALLOWED_MODELS ?? "" })),
		templates,
		items: listShared().map((b) => ({ name: b.name, kind: b.kind, source: b.source ?? "" })),
		thinking: THINKING_LEVELS,
		maxPackages: MAX_PACKAGES,
		passwordSet: Boolean(dashboardHash),
	};
}

/** Validate the wizard's choices and return the files for the profile and the fields for the agent. Throws a 400 naming the problem. */
export function planWizard(input) {
	const b = input && typeof input === "object" ? input : {};
	// Either an existing key, or a new one made with the agent (and removed again if the agent cannot be made).
	let key = null;
	let newKey = null;
	if (b.newKey && typeof b.newKey === "object") {
		const name = String(b.newKey.name ?? "").trim().slice(0, 80);
		if (!name) throw bad("name the new key");
		let expiresAt = 0;
		try {
			expiresAt = expiryFromInput(b.newKey.expiresAt);
		} catch (err) {
			throw bad(err.message);
		}
		newKey = { name, expiresAt };
	} else {
		key = apiKeys.get(b.keyId);
		if (!key) throw bad("choose a key, or create a new one", 404);
		const problem = ApiKeyStore.problem(key);
		if (problem) throw bad(`this key is ${problem}; an agent needs a usable key`, 409);
	}
	const template = b.template ? getTemplate(String(b.template)) : null;
	if (b.template && !template) throw bad(`no template called "${b.template}"`, 404);
	let files = template ? template.files.map((f) => ({ ...f })) : [];

	const exclude = new Set(Array.isArray(b.skills?.exclude) ? b.skills.exclude.map(String) : []);
	const have = new Set(skillsOf(files).map((s) => s.name));
	for (const name of exclude) if (!have.has(name)) throw bad(`the template has no skill "${name}" to leave out`);
	files = files.filter((f) => !(f.path.startsWith("skills/") && exclude.has(f.path.split("/")[1])));

	if (b.instructions !== undefined && b.instructions !== null) {
		const text = String(b.instructions);
		if (Buffer.byteLength(text) > INSTRUCTIONS_MAX) throw bad(`instructions are limited to ${INSTRUCTIONS_MAX / 1024} KB`);
		files = files.filter((f) => f.path !== "AGENTS.md");
		if (text.trim()) files.push({ path: "AGENTS.md", data: Buffer.from(text).toString("base64") });
	}

	const added = Array.isArray(b.skills?.add) ? b.skills.add : [];
	if (added.length > 20) throw bad("at most 20 skills can be added here");
	for (const skill of added) {
		const name = String(skill?.name ?? "");
		if (!SKILL_NAME.test(name)) throw bad(`"${name}" is not a skill name: letters, digits, dots, dashes and underscores`);
		if ((have.has(name) && !exclude.has(name)) || files.some((f) => f.path.startsWith(`skills/${name}/`))) throw bad(`there is already a skill called "${name}"`);
		const content = String(skill?.content ?? "");
		if (Buffer.byteLength(content) > SKILL_MAX) throw bad(`the skill "${name}" is over ${SKILL_MAX / 1024} KB`);
		const meta = frontmatterOf(content);
		if (!meta.description) throw bad(`the skill "${name}" needs a header with a description:\n---\nname: ${name}\ndescription: what it is for\n---`);
		files.push({ path: `skills/${name}/SKILL.md`, data: Buffer.from(content).toString("base64") });
	}

	// The same path and size checks as an imported bundle.
	validateBundle({ format: "piper-agent", version: 1, agent: {}, files });

	let sharedBundles = null;
	if (b.extensions !== undefined && b.extensions !== null && String(b.extensions).trim() !== "") {
		sharedBundles = bundleListFromInput(Array.isArray(b.extensions) ? b.extensions.join(",") : b.extensions);
		const known = new Set(listShared().map((x) => x.name));
		for (const name of String(sharedBundles ?? "").split(",").filter((n) => n && n !== "*")) if (!known.has(name)) throw bad(`there is no extension or bundle called "${name}"`);
	}
	const packages = (Array.isArray(b.packages) ? b.packages : []).map((p) => String(p).trim()).filter(Boolean);
	if (packages.length > MAX_PACKAGES) throw bad(`at most ${MAX_PACKAGES} packages can be installed from the wizard`);
	for (const p of packages) {
		try {
			validateSource(p);
		} catch (err) {
			throw bad(err.message);
		}
	}
	if ((sharedBundles !== null || packages.length) && !dashboardHash) throw bad("Granting extensions and installing packages needs a dashboard password: they are third-party code. Set one under Settings → Access, or leave them out.", 403);
	if (b.thinking && !THINKING_LEVELS.includes(b.thinking)) throw bad(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	return {
		key,
		newKey,
		files,
		sharedBundles,
		packages,
		fields: { keyId: key?.id ?? null, name: String(b.name ?? ""), workspace: b.workspace || "own", model: b.model || null, thinking: b.thinking || null, container: b.container ?? null },
		description: String(b.description ?? "").slice(0, 300),
		canDelegate: b.canDelegate === true,
	};
}

/**
 * Run packages' installs one after another (the job panel shows each); a failed one does not stop the rest.
 * The package job tracker is global, not per scope, so another install running anywhere on the gateway right
 * now (a concurrent wizard, an operator's own) is waited out rather than silently dropping this package.
 */
export async function installInOrder(scope, sources, { install = installPackage, waitMs = 1000 } = {}) {
	for (const source of sources) {
		for (let tries = 0; ; tries++) {
			try {
				install(scope, source);
				break;
			} catch (err) {
				if (err instanceof PackageError && err.status === 409 && tries < 20) {
					await new Promise((r) => setTimeout(r, waitMs));
					continue;
				}
				audit("agent.package_failed", scope, `the wizard's package "${source}" was not installed: ${err?.message ?? err}`, { actor: "system" });
				break;
			}
		}
		const until = Date.now() + 11 * 60_000;
		while (Date.now() < until && packageJobView()?.state === "running") await new Promise((r) => setTimeout(r, 500));
	}
}

/** Create the agent from the wizard's choices. Returns `{agent, queuedPackages}`. */
export async function createFromWizard(input, { queuePackages = true } = {}) {
	const plan = planWizard(input);
	let madeKey = null;
	if (plan.newKey) {
		const { record, key: secret } = apiKeys.create({ name: plan.newKey.name, expiresAt: plan.newKey.expiresAt });
		madeKey = { id: record.id, name: record.name, key: secret, expiresAt: plan.newKey.expiresAt };
		plan.key = record;
		plan.fields.keyId = record.id;
		audit("key.create", record.name, `${plan.newKey.expiresAt ? `expires ${new Date(plan.newKey.expiresAt).toISOString().slice(0, 10)}` : "no expiry"}; made by the agent creation wizard`);
	}
	let created;
	try {
		created = await createAgent(plan.fields);
	} catch (err) {
		if (madeKey) apiKeys.remove(madeKey.id);
		throw err;
	}
	try {
		const scope = agentScope(plan.key.id, created.id);
		if (plan.files.length) await profileOp(scope, { op: "tree.import", files: plan.files, max: config.EXPORT_MAX_BYTES });
		agents.update(created.id, { description: plan.description, canDelegate: plan.canDelegate, ...(plan.sharedBundles !== null ? { sharedBundles: plan.sharedBundles } : {}) });
		if (plan.packages.length && queuePackages) void installInOrder(scope, plan.packages);
		audit("agent.create", `${plan.key.name} / ${created.name}`, `from the wizard${input.template ? ` (template ${input.template})` : ""}; ${plan.files.length} file(s)${plan.sharedBundles !== null ? `; extensions: ${plan.sharedBundles || "none"}` : ""}${plan.packages.length ? `; ${plan.packages.length} package(s) queued` : ""}`);
	} catch (err) {
		await deleteAgent(created.id).catch(() => {});
		if (madeKey) apiKeys.remove(madeKey.id);
		throw err;
	}
	// The secret is returned here once and never stored.
	return { agent: agents.get(created.id), queuedPackages: plan.packages, newKey: madeKey };
}
