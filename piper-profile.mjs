/**
 * Piper profile helper: reads and edits one API key's Pi profile or workspace, from inside a container.
 *
 * The profile is writable by that key's own sessions, so it may hold anything a session put there,
 * symlinks included. The gateway therefore never opens a profile file itself: a link planted as
 * `settings.json -> ~/.pi/agent/auth.json` would turn "show my settings" into "show the gateway's
 * credentials". Instead this script runs in a throwaway container with only the folder
 * mounted, so following a link reaches nothing the agent could not already read.
 *
 * Protocol: one JSON command on stdin, one JSON answer on stdout, `{ ok, result }` or `{ ok: false,
 * error }`. The working directory is the profile. PROFILE_MAX_BYTES caps what writes may grow it to.
 */
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
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
 * inside a container, for the reasons at the top of this file.
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

/** A path inside the folder being served, "" meaning the folder itself. */
function filePath(rel) {
	const text = String(rel ?? "").replace(/^\/+|\/+$/g, "");
	if (text === "") return ROOT;
	const target = inside(ROOT, text);
	// A session may plant links in the folder. None of the folders on the way may be one, so a path
	// can never lead out of the folder, even into what little the helper's own container shows.
	let dir = ROOT;
	for (const part of relative(ROOT, dirname(target)).split(sep).filter(Boolean)) {
		dir = join(dir, part);
		if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`invalid path: ${rel} (goes through a link)`);
	}
	return target;
}

/** lstat that answers null for a path that is not there, or sits under a file (ENOTDIR), instead of throwing. */
function statOrNull(path) {
	try {
		return lstatSync(path);
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
		throw err;
	}
}

/**
 * Moving an agent's profile between places: what goes (instructions, settings, skills, extensions, prompts, agent
 * definitions) and nothing else (never auth.json or the model files, which the gateway writes itself). Only regular
 * files travel: a link or a device is skipped on the way out and cannot be expressed on the way in.
 */
const TRANSFER_TOP = ["AGENTS.md", "settings.json", "skills", "extensions", "prompts", "agents"];
const TRANSFER_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,127}$/;
const TRANSFER_DEPTH = 8;
const TRANSFER_FILES = 500;

/** A transfer path as segments, or a refusal: relative, plain names, and under one of the allowed top entries. */
function transferPath(path) {
	const text = String(path ?? "");
	const parts = text.split("/");
	if (!text || text.length > 400 || parts.length > TRANSFER_DEPTH || parts.some((p) => !TRANSFER_SEGMENT.test(p) || p === "." || p === "..")) throw new Refusal(`not a path that can travel: ${text.slice(0, 80)}`);
	if (!TRANSFER_TOP.includes(parts[0])) throw new Refusal(`not part of a profile that travels: ${parts[0]}`);
	if ((parts[0] === "AGENTS.md" || parts[0] === "settings.json") && parts.length !== 1) throw new Refusal(`${parts[0]} is a file`);
	return parts;
}

function exportTree(maxBytes) {
	const files = [];
	let skipped = 0;
	let bytes = 0;
	const visit = (rel, depth) => {
		const stat = lstatSync(join(ROOT, rel), { throwIfNoEntry: false });
		if (!stat) return;
		if (stat.isDirectory()) {
			if (depth >= TRANSFER_DEPTH) return void skipped++;
			for (const name of readdirSync(join(ROOT, rel)).sort()) visit(`${rel}/${name}`, depth + 1);
			return;
		}
		let parts;
		try {
			parts = transferPath(rel);
		} catch {
			return void skipped++;
		}
		if (!stat.isFile()) return void skipped++;
		if (files.length >= TRANSFER_FILES) throw new Refusal(`more than ${TRANSFER_FILES} files: too much to export`);
		bytes += stat.size;
		if (bytes > maxBytes) throw new Refusal(`the profile is over the ${maxBytes}-byte export limit`);
		files.push({ path: parts.join("/"), data: readFileSync(join(ROOT, rel)).toString("base64") });
	};
	for (const top of TRANSFER_TOP) visit(top, 0);
	return { files, skipped, bytes };
}

function importTree(files, maxBytes) {
	if (!Array.isArray(files) || files.length > TRANSFER_FILES) throw new Refusal(`a bundle holds at most ${TRANSFER_FILES} files`);
	const seen = new Set();
	const decoded = files.map((f) => {
		const parts = transferPath(f?.path);
		const key = parts.join("/").toLowerCase();
		if (seen.has(key)) throw new Refusal(`the same file twice: ${f.path}`);
		seen.add(key);
		if (typeof f.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) throw new Refusal(`not valid data: ${f.path}`);
		return { parts, data: Buffer.from(f.data, "base64") };
	});
	const total = decoded.reduce((n, f) => n + f.data.length, 0);
	if (total > maxBytes) throw new Refusal(`the bundle is over the ${maxBytes}-byte limit`);
	checkQuota(total);
	for (const { parts, data } of decoded) {
		// No step of the way may be a link: a planted `skills -> /elsewhere` would send the write there.
		let at = ROOT;
		for (const part of parts.slice(0, -1)) {
			at = join(at, part);
			const stat = lstatSync(at, { throwIfNoEntry: false });
			if (stat && !stat.isDirectory()) throw new Refusal(`something other than a folder is in the way: ${parts.join("/")}`);
			if (!stat) mkdirSync(at);
		}
		const target = join(ROOT, ...parts);
		if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Refusal(`a folder is in the way: ${parts.join("/")}`);
		writeAtomic(target, data);
	}
	return { files: decoded.length, bytes: total };
}

const OPS = {
	// The key's workspace, when this helper runs over it: list and delete. Reading and writing
	// file contents go through the raw modes below, so large files never pass through JSON.
	// `sizes: false` skips adding up each folder (a browser does not need it and it walks the tree); `meta: true`
	// answers {entries, truncated} instead of the bare list, so a page can say it is showing the first 5,000.
	"files.list": ({ path, sizes = true, meta = false }) => {
		const dir = filePath(path);
		if (!existsSync(dir)) throw new Refusal(`no such folder: ${path || "/"}`);
		if (!lstatSync(dir).isDirectory()) throw new Refusal(`not a folder: ${path}`);
		const names = readdirSync(dir).sort();
		const entries = names.slice(0, 5000).map((name) => {
			const stat = lstatSync(join(dir, name));
			return {
				name,
				type: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file",
				bytes: stat.isDirectory() ? (sizes ? sizeOf(join(dir, name)) : null) : stat.size,
				modified: stat.mtimeMs,
			};
		});
		return meta ? { entries, truncated: names.length > 5000, total: names.length } : entries;
	},
	"files.mkdir": ({ path }) => {
		const target = filePath(path);
		if (target === ROOT) throw new Refusal("that is the folder itself");
		const stat = statOrNull(target);
		if (stat) {
			if (stat.isDirectory()) return { path, created: false };
			throw new Refusal(`a file is in the way: ${path}`);
		}
		try {
			mkdirSync(target, { recursive: true });
		} catch (err) {
			throw new Refusal(`cannot make that folder: ${err.code ?? err.message}`);
		}
		return { path, created: true };
	},
	// Rename or move inside the folder. Never the root, never into itself, never over something unless asked, and
	// never over a folder.
	"files.move": ({ from, to, overwrite = false }) => {
		const source = filePath(from);
		const target = filePath(to);
		if (source === ROOT || target === ROOT) throw new Refusal("the folder itself cannot be moved or replaced");
		const have = statOrNull(source);
		if (!have) throw new Refusal(`no such file: ${from}`);
		const rel = relative(source, target);
		if (rel === "") return { from, to, moved: false };
		if (have.isDirectory() && !rel.startsWith("..") && !isAbsolute(rel)) throw new Refusal("a folder cannot be moved into itself");
		const there = statOrNull(target);
		if (there) {
			if (!overwrite) throw new Refusal(`${to} already exists`);
			if (there.isDirectory() || have.isDirectory()) throw new Refusal("a folder cannot be replaced; delete it first");
		}
		try {
			mkdirSync(dirname(target), { recursive: true });
			renameSync(source, target);
		} catch (err) {
			throw new Refusal(`cannot move it: ${err.code ?? err.message}`);
		}
		return { from, to, moved: true };
	},
	// A text file for an editor: its text and when it was last changed, or why it is not shown as text.
	"files.readtext": ({ path, max }) => {
		const target = filePath(path);
		const stat = statOrNull(target);
		if (!stat) throw new Refusal(`no such file: ${path}`);
		if (!stat.isFile()) throw new Refusal(`not a regular file: ${path}`);
		const limit = Math.min(Number(max) || 1024 * 1024, 4 * 1024 * 1024);
		if (stat.size > limit) return { tooBig: true, bytes: stat.size, modified: stat.mtimeMs };
		const buffer = readFileSync(target);
		if (buffer.includes(0)) return { binary: true, bytes: stat.size, modified: stat.mtimeMs };
		let text;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		} catch {
			return { binary: true, bytes: stat.size, modified: stat.mtimeMs };
		}
		return { text, bytes: stat.size, modified: stat.mtimeMs };
	},
	// Save an editor's text. `expectModified` is what the editor was given when it opened the file: if the file has
	// changed since (an agent wrote it), the save is refused as a conflict instead of overwriting that work.
	"files.writetext": ({ path, text, expectModified, max }) => {
		if (typeof text !== "string") throw new Refusal("the text to save must be a string");
		const bytes = Buffer.byteLength(text);
		const limit = Math.min(Number(max) || 1024 * 1024, 4 * 1024 * 1024);
		if (bytes > limit) throw new Refusal(`too large to save here: ${bytes} bytes (the limit is ${limit})`);
		const target = filePath(path);
		if (target === ROOT) throw new Refusal("that is the folder itself");
		const stat = statOrNull(target);
		if (stat && !stat.isFile()) throw new Refusal(`not a regular file: ${path}`);
		const expected = expectModified === undefined || expectModified === null ? null : Number(expectModified);
		if (expected !== null) {
			if (!stat) throw new Refusal("conflict: the file was removed since you opened it");
			if (Math.abs(stat.mtimeMs - expected) > 1) throw new Refusal("conflict: the file changed since you opened it");
		}
		checkQuota(bytes, stat?.size ?? 0);
		writeAtomic(target, text);
		return { bytes, modified: lstatSync(target).mtimeMs, created: !stat };
	},
	"files.delete": ({ path }) => {
		const target = filePath(path);
		if (target === ROOT) throw new Refusal("refusing to delete the whole folder");
		if (!existsSync(target) && !lstatSync(target, { throwIfNoEntry: false })) throw new Refusal(`no such file: ${path}`);
		rmSync(target, { recursive: true, force: true });
		return { deleted: path };
	},
	"tree.export": ({ max }) => exportTree(Math.min(Number(max) || 20 * 1024 * 1024, 64 * 1024 * 1024)),
	"tree.import": ({ files, max }) => importTree(files, Math.min(Number(max) || 20 * 1024 * 1024, 64 * 1024 * 1024)),
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
	// The profile's AGENTS.md, which Pi puts in front of every conversation: the role an agent endpoint is given.
	"instructions.get": () => {
		const file = join(ROOT, "AGENTS.md");
		const stat = lstatSync(file, { throwIfNoEntry: false });
		return { text: stat?.isFile() ? readFileSync(file, "utf8") : "" };
	},
	"instructions.put": ({ text }) => {
		if (typeof text !== "string") throw new Refusal("instructions must be text");
		const bytes = Buffer.byteLength(text);
		if (bytes > 64 * 1024) throw new Refusal("instructions are limited to 64 KB");
		const file = join(ROOT, "AGENTS.md");
		checkQuota(bytes, sizeOf(file));
		writeAtomic(file, text);
		return { bytes };
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

/**
 * Stream one file's bytes in or out: `raw read <path>` writes the file to stdout, `raw write <path>
 * <maxBytes>` stores stdin there, replacing it whole. Failures exit with a code the gateway maps to
 * HTTP — 3 not a file, 4 not found, 5 too large, 6 a path that leaves the folder, 2 anything else —
 * and a reason on stderr, before any byte of content is written.
 */
async function raw(mode, rel, maxBytes) {
	const fail = (code, message) => {
		process.stderr.write(message);
		process.exit(code);
	};
	let target;
	try {
		target = filePath(rel);
	} catch (err) {
		return fail(err instanceof Refusal ? 6 : 2, err.message);
	}
	if (target === ROOT) return fail(3, "that is the folder itself, not a file");
	if (mode === "read") {
		// lstat, not stat: a link is not served, wherever it points.
		const stat = lstatSync(target, { throwIfNoEntry: false });
		if (!stat) return fail(4, `no such file: ${rel}`);
		if (!stat.isFile()) return fail(3, `not a file: ${rel}`);
		// Done when the file has been read out. stdout never emits "finish" (it is never closed), and
		// Node keeps running until what was written to it has drained.
		await new Promise((resolvePromise, reject) => {
			const stream = createReadStream(target).on("error", reject).on("end", resolvePromise);
			stream.pipe(process.stdout, { end: false });
		});
		return;
	}
	if (mode === "write") {
		const limit = Number(maxBytes) || 0;
		try {
			if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) return fail(3, `a folder is in the way: ${rel}`);
			mkdirSync(dirname(target), { recursive: true });
		} catch (err) {
			return fail(2, err.message);
		}
		const temp = `${target}.piper-upload`;
		let written = 0;
		// Opened at the first chunk that fits, not before: opening is asynchronous, and a file that
		// is opened after the clean-up of a refused upload would be left behind, empty.
		let out = null;
		for await (const chunk of process.stdin) {
			written += chunk.length;
			if (limit > 0 && written > limit) {
				if (out) {
					out.destroy();
					await new Promise((r) => out.once("close", r));
				}
				rmSync(temp, { force: true });
				return fail(5, `file too large: more than ${limit} bytes`);
			}
			out ??= createWriteStream(temp);
			if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
		}
		// An empty upload never got a chunk, and is still a file.
		out ??= createWriteStream(temp);
		await new Promise((r) => out.end(r));
		// A rename replaces a link rather than writing through it.
		renameSync(temp, target);
		process.stdout.write(JSON.stringify({ ok: true, bytes: written }));
		return;
	}
	fail(2, `unknown raw mode: ${mode}`);
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv[2] === "raw") await raw(process.argv[3], process.argv[4], process.argv[5]);
	else await main();
}
