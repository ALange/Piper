/**
 * Piper profile helper: reads and edits one API key's Pi profile, from inside a sandbox.
 *
 * The profile is writable by that key's own sessions, so it may hold anything a session put there,
 * symlinks included. The gateway therefore never opens a profile file itself: a link planted as
 * `settings.json -> ~/.pi/agent/auth.json` would turn "show my settings" into "show the gateway's
 * credentials". Instead this script runs in the same sandbox a session gets, with only the profile
 * mounted, so following a link reaches nothing the session could not already read.
 *
 * Protocol: one JSON command on stdin, one JSON answer on stdout, `{ ok, result }` or `{ ok: false,
 * error }`. The working directory is the profile. PROFILE_MAX_BYTES caps what writes may grow it to.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const MAX_BYTES = Number(process.env.PROFILE_MAX_BYTES) || 0;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTENSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(ts|js)$/;

class Refusal extends Error {}

/** Bytes under a path, never following a link. */
function sizeOf(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	let total = 0;
	for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
	return total;
}

/** A relative path that stays inside `base`, or a refusal. */
function inside(base, rel) {
	const clean = normalize(String(rel ?? ""));
	if (!clean || clean === "." || isAbsolute(clean) || clean.startsWith("..")) throw new Refusal(`invalid path: ${rel}`);
	const full = join(base, clean);
	if (relative(base, full).startsWith("..")) throw new Refusal(`invalid path: ${rel}`);
	return full;
}

/** Refuse a write that would take the profile past its quota. `replaced` is what the write removes. */
function checkQuota(incoming, replaced = 0) {
	if (!MAX_BYTES) return;
	const after = sizeOf(ROOT) - replaced + incoming;
	if (after > MAX_BYTES) throw new Refusal(`profile quota exceeded: ${after} bytes would exceed the ${MAX_BYTES}-byte limit`);
}

function writeAtomic(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.piper-tmp`;
	writeFileSync(temp, content);
	// A rename replaces a link rather than writing through it.
	renameSync(temp, path);
}

function readSettings() {
	if (!existsSync("settings.json")) return {};
	const value = JSON.parse(readFileSync("settings.json", "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Refusal("settings.json is not a JSON object");
	return value;
}

function writeSettings(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Refusal("settings must be a JSON object");
	const text = `${JSON.stringify(value, null, 2)}\n`;
	checkQuota(Buffer.byteLength(text), sizeOf("settings.json"));
	writeAtomic(join(ROOT, "settings.json"), text);
	return value;
}

/** `name` and `description` from a SKILL.md frontmatter block. */
function frontmatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const out = {};
	if (!match) return out;
	for (const line of match[1].split(/\r?\n/)) {
		const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
		if (field) out[field[1]] = field[2].replace(/^["']|["']$/g, "");
	}
	return out;
}

function listSkills() {
	if (!existsSync("skills")) return [];
	const skills = [];
	for (const name of readdirSync("skills").sort()) {
		const file = join("skills", name, "SKILL.md");
		if (!existsSync(file)) continue;
		const meta = frontmatter(readFileSync(file, "utf8"));
		skills.push({ name, description: meta.description ?? "", bytes: sizeOf(join("skills", name)) });
	}
	return skills;
}

function listExtensions() {
	if (!existsSync("extensions")) return [];
	return readdirSync("extensions")
		.sort()
		.map((name) => ({ name, bytes: sizeOf(join("extensions", name)) }));
}

/** How deep skill discovery goes, and how much any one listing may return. */
const SKILL_DEPTH = 6;
const LIST_MAX = 500;
const PREVIEW_CHARS = 1500;

/**
 * Everything a Pi agent directory or package offers, by name: skills (found recursively, the way Pi
 * discovers them), extensions, prompt templates, agent definitions, AGENTS.md and packages.
 *
 * Exported because the gateway reads shared bundles with the same code. Bundles are the operator's
 * and read-only, so reading them directly is safe; a profile is read only through this helper,
 * inside a sandbox, for the reasons at the top of this file.
 */
export function inventory(root) {
	const at = (...parts) => join(root, ...parts);
	const isDir = (path) => {
		try {
			return lstatSync(path).isDirectory();
		} catch {
			return false;
		}
	};
	const read = (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	};
	const skills = [];
	const walk = (dir, rel, depth) => {
		if (depth > SKILL_DEPTH || skills.length >= LIST_MAX) return;
		const skillFile = join(dir, "SKILL.md");
		if (existsSync(skillFile)) {
			// A skill's own folder is its content, not more skills: Pi stops here, and so does this.
			const meta = frontmatter(read(skillFile));
			skills.push({ name: meta.name || rel.split("/").pop() || "(root)", description: meta.description ?? "", path: rel });
			return;
		}
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
			walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
		}
	};
	if (isDir(at("skills"))) walk(at("skills"), "", 0);
	skills.sort((a, b) => a.name.localeCompare(b.name));

	const markdown = (sub) => {
		if (!isDir(at(sub))) return [];
		return readdirSync(at(sub))
			.filter((n) => n.endsWith(".md"))
			.sort()
			.slice(0, LIST_MAX)
			.map((n) => ({ name: n.replace(/\.md$/, ""), description: frontmatter(read(at(sub, n))).description ?? "" }));
	};
	const extensions = isDir(at("extensions"))
		? readdirSync(at("extensions"), { withFileTypes: true })
				.filter((e) => e.isDirectory() || /\.(ts|js)$/.test(e.name))
				.map((e) => ({ name: e.name, bytes: sizeOf(at("extensions", e.name)) }))
				.sort((a, b) => a.name.localeCompare(b.name))
		: [];
	let packages = [];
	try {
		const settings = JSON.parse(read(at("settings.json")) || "{}");
		packages = (Array.isArray(settings.packages) ? settings.packages : []).map((p) => (typeof p === "string" ? p : p?.source ?? "?"));
	} catch {
		/* a broken settings.json is reported by summary */
	}
	const agentsText = read(at("AGENTS.md"));
	return {
		skills,
		extensions,
		prompts: markdown("prompts"),
		agents: markdown("agents"),
		packages,
		agentsMd: agentsText ? { bytes: Buffer.byteLength(agentsText), preview: agentsText.slice(0, PREVIEW_CHARS) } : null,
	};
}

const OPS = {
	inventory: () => ({ ...inventory(ROOT), bytes: sizeOf(ROOT), maxBytes: MAX_BYTES }),
	summary: () => {
		let settings = null;
		let settingsError = null;
		try {
			settings = readSettings();
		} catch (err) {
			settingsError = err.message;
		}
		return {
			bytes: sizeOf(ROOT),
			maxBytes: MAX_BYTES,
			settings,
			settingsError,
			skills: listSkills(),
			extensions: listExtensions(),
			hasAgentsMd: existsSync("AGENTS.md"),
		};
	},
	"settings.get": () => readSettings(),
	"settings.put": ({ settings }) => writeSettings(settings),
	"settings.patch": ({ set = {}, unset = [] }) => {
		const value = readSettings();
		for (const [key, v] of Object.entries(set)) value[key] = v;
		for (const key of unset) delete value[key];
		return writeSettings(value);
	},
	"skills.list": () => listSkills(),
	"skills.get": ({ name }) => {
		if (!NAME.test(String(name))) throw new Refusal(`invalid skill name: ${name}`);
		const dir = join("skills", name);
		if (!existsSync(join(dir, "SKILL.md"))) throw new Refusal(`no skill named ${name}`);
		const files = {};
		const walk = (rel) => {
			for (const entry of readdirSync(join(dir, rel))) {
				const path = rel ? join(rel, entry) : entry;
				const stat = lstatSync(join(dir, path));
				if (stat.isDirectory()) walk(path);
				else if (stat.isFile()) files[path] = readFileSync(join(dir, path), "utf8");
			}
		};
		walk("");
		return { name, files };
	},
	"skills.put": ({ name, files }) => {
		if (!NAME.test(String(name))) throw new Refusal(`invalid skill name: ${name}`);
		if (!files || typeof files !== "object" || typeof files["SKILL.md"] !== "string") throw new Refusal("a skill needs a SKILL.md");
		const dir = join(ROOT, "skills", name);
		const entries = Object.entries(files).map(([rel, content]) => {
			if (typeof content !== "string") throw new Refusal(`file ${rel} must be text`);
			return [inside(dir, rel), content];
		});
		checkQuota(entries.reduce((n, [, content]) => n + Buffer.byteLength(content), 0), sizeOf(dir));
		rmSync(dir, { recursive: true, force: true });
		for (const [path, content] of entries) writeAtomic(path, content);
		return { name, description: frontmatter(files["SKILL.md"]).description ?? "" };
	},
	"skills.delete": ({ name }) => {
		if (!NAME.test(String(name))) throw new Refusal(`invalid skill name: ${name}`);
		const dir = join("skills", name);
		if (!existsSync(dir)) throw new Refusal(`no skill named ${name}`);
		rmSync(dir, { recursive: true, force: true });
		return { deleted: name };
	},
	"extensions.list": () => listExtensions(),
	"extensions.get": ({ name }) => {
		if (!EXTENSION.test(String(name))) throw new Refusal(`invalid extension file name: ${name} (use name.ts or name.js)`);
		const file = join("extensions", name);
		if (!existsSync(file)) throw new Refusal(`no extension named ${name}`);
		return { name, content: readFileSync(file, "utf8") };
	},
	"extensions.put": ({ name, content }) => {
		if (!EXTENSION.test(String(name))) throw new Refusal(`invalid extension file name: ${name} (use name.ts or name.js)`);
		if (typeof content !== "string") throw new Refusal("an extension must be text");
		const file = join(ROOT, "extensions", name);
		checkQuota(Buffer.byteLength(content), sizeOf(file));
		writeAtomic(file, content);
		return { name };
	},
	"extensions.delete": ({ name }) => {
		if (!EXTENSION.test(String(name))) throw new Refusal(`invalid extension file name: ${name}`);
		const file = join("extensions", name);
		if (!existsSync(file)) throw new Refusal(`no extension named ${name}`);
		rmSync(file, { force: true });
		return { deleted: name };
	},
};

/** Run one command from stdin. Only when this file is the program, not when the gateway imports inventory(). */
async function main() {
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;
	let answer;
	try {
		const command = JSON.parse(input);
		const op = OPS[command?.op];
		if (!op) throw new Refusal(`unknown operation: ${command?.op}`);
		answer = { ok: true, result: op(command) };
	} catch (err) {
		answer = { ok: false, error: err instanceof Refusal ? err.message : `profile helper failed: ${err?.message ?? err}`, refused: err instanceof Refusal };
	}
	process.stdout.write(JSON.stringify(answer));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
