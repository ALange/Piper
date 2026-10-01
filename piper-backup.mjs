#!/usr/bin/env node
/**
 * Piper backup and restore.
 *
 *   node piper-backup.mjs backup  [--out DIR] [--keep N] [--no-chats] [--force]
 *   node piper-backup.mjs restore FILE [--stop]
 *
 * Standalone on purpose: it never imports the gateway's modules, because importing them opens
 * gateway.db and runs migrations. It reads the few folder settings it needs straight from the
 * database, read-only.
 *
 * A backup is one owner-only `.tgz` holding a consistent copy of gateway.db (`VACUUM INTO`, safe
 * while the gateway runs), the profiles, workspaces, shared bundles, the container Pi config (whose
 * models.json holds an API key) and, unless --no-chats, the chats' Pi session files, plus a
 * MANIFEST.json, with a `.sha256` beside it. Containers are not included: a chat whose container is
 * missing gets a fresh one on its next message, and its session, workspace and profile come back.
 *
 * A restore never deletes: everything it replaces is moved aside as `<name>.before-restore-<time>`.
 */
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import crypto from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statfsSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORMAT = 1;
const GIB = 1024 ** 3;
const NAME = /^piper-backup-\d{8}T\d{6}Z\.tgz$/;

/** The folder settings that say where data lives: [setting, default folder under the gateway]. */
const FOLDER_SETTINGS = [
	["profiles", "PROFILE_ROOT", "profiles"],
	["workspaces", "WORKSPACE_ROOT", "workspaces"],
	["shared", "SHARED_ROOT", "shared"],
	["container-pi", "CONTAINER_PI_DIR", "container-pi"],
];

export class BackupError extends Error {}

/** Read a few settings from a database without writing anything. Missing file or rows give {}. */
export function readSettings(dbPath, keys) {
	if (!existsSync(dbPath)) return {};
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const out = {};
		for (const key of keys) out[key] = db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
		return out;
	} catch {
		return {};
	} finally {
		db.close();
	}
}

/** Where each part lives: the setting when set, else the default beside the gateway. */
export function partPaths(dir, settings = {}) {
	const paths = {};
	for (const [name, key, fallback] of FOLDER_SETTINGS) paths[name] = resolve(settings[key] || join(dir, fallback));
	// Pi's session files are kept beside the workspaces root, named after it.
	paths.chats = `${paths.workspaces}-chats`;
	return paths;
}

/** Bytes and file count under a path, never following a link. */
export function measure(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return { bytes: 0, files: 0 };
	}
	if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
	let bytes = 0;
	let files = 0;
	for (const entry of readdirSync(path)) {
		const sub = measure(join(path, entry));
		bytes += sub.bytes;
		files += sub.files;
	}
	return { bytes, files };
}

function sha256File(path) {
	return new Promise((resolvePromise, reject) => {
		const hash = crypto.createHash("sha256");
		createReadStream(path).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolvePromise(hash.digest("hex")));
	});
}

/** Run tar. Exit 1 means "a file changed while it was read", normal for a live gateway; 2+ is a failure. */
function tar(args, { stdout } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("tar", args, { stdio: ["ignore", stdout ? "pipe" : "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-2000)));
		if (stdout) child.stdout.pipe(stdout);
		child.on("error", (err) => reject(new BackupError(`cannot run tar: ${err.message}`)));
		child.on("close", (code) => {
			if (code === 0 || code === 1) return resolvePromise({ code, stderr });
			reject(new BackupError(`tar failed (${code}): ${stderr.trim().split("\n").slice(-2).join(" | ")}`));
		});
	});
}

const escapeSed = (text) => text.replace(/[\\^$.*+?()[\]{}|,]/g, "\\$&");
const stamp = (now) => new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** The mapping of a path from one gateway folder to another: unchanged when it lies elsewhere. */
export function mapPath(path, from, to) {
	if (!path || !from || !to || from === to) return path;
	return path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

/**
 * Write a backup. Returns {file, bytes, sha256, parts, warnings}.
 * `freeBytes` and `now` are parameters for the tests.
 */
export async function backup({ dir, dbPath = join(dir, "gateway.db"), out = join(dir, "backups"), keep = 0, chats = true, force = false, minFreeBytes = GIB, freeBytes, now = Date.now() }) {
	dir = resolve(dir);
	out = resolve(out);
	if (!existsSync(dbPath)) throw new BackupError(`no database at ${dbPath}: is ${dir} a Piper folder?`);
	process.umask(0o077);
	mkdirSync(out, { recursive: true, mode: 0o700 });
	const settings = readSettings(dbPath, FOLDER_SETTINGS.map((f) => f[1]));
	const paths = partPaths(dir, settings);
	const wanted = Object.entries(paths).filter(([name, path]) => (name !== "chats" || chats) && existsSync(path));

	const parts = {};
	let total = 0;
	for (const [name, path] of wanted) {
		parts[name] = { path, ...measure(path) };
		total += parts[name].bytes;
	}
	// The archive is smaller than its contents, so the raw size is a safe estimate.
	const free = freeBytes ?? (() => { const s = statfsSync(out); return s.bavail * s.bsize; })();
	if (!force && free - total < minFreeBytes) {
		throw new BackupError(`not enough space: ${(free / GIB).toFixed(1)} GB free, the data is ${(total / GIB).toFixed(2)} GB and ${(minFreeBytes / GIB).toFixed(0)} GB must stay free (use --force to try anyway, or --out another disk)`);
	}

	const staging = mkdtempSync(join(out, ".staging-"));
	const finalName = `piper-backup-${stamp(now)}.tgz`;
	const partial = join(out, `.${finalName}.partial`);
	try {
		// A consistent copy of the database, taken while the gateway may be writing to it.
		const copy = join(staging, "gateway.db");
		const src = new DatabaseSync(dbPath, { readOnly: true });
		try {
			src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
		} finally {
			src.close();
		}
		const dbHash = await sha256File(copy);
		const manifest = {
			format: FORMAT,
			created: new Date(now).toISOString(),
			host: hostname(),
			gatewayDir: dir,
			node: process.version,
			chats,
			db: { bytes: lstatSync(copy).size, sha256: dbHash },
			parts,
			note: "Containers are not included; chats get a fresh one on resume.",
		};
		writeFileSync(join(staging, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

		// Each part is stored under a fixed name, whatever folder it came from.
		const args = ["-czf", partial, "--warning=no-file-changed", "-C", staging, "--transform", "s,^gateway.db$,db/gateway.db,", "gateway.db", "MANIFEST.json"];
		for (const [name, path] of wanted) {
			const rel = path.replace(/^\/+/, "");
			args.push("--transform", `s,^${escapeSed(rel)}/,parts/${name}/,`, "--transform", `s,^${escapeSed(rel)}$,parts/${name},`);
		}
		for (const [, path] of wanted) args.push("-C", "/", path.replace(/^\/+/, ""));
		const result = await tar(args);
		chmodSync(partial, 0o600);
		const file = join(out, finalName);
		renameSync(partial, file);
		const sha256 = await sha256File(file);
		writeFileSync(`${file}.sha256`, `${sha256}  ${finalName}\n`, { mode: 0o600 });

		const warnings = result.code === 1 ? ["some files changed while they were being archived (the gateway was running); the copy is still usable"] : [];
		if (keep > 0) {
			const old = readdirSync(out).filter((n) => NAME.test(n)).sort();
			for (const name of old.slice(0, Math.max(0, old.length - keep))) {
				rmSync(join(out, name), { force: true });
				rmSync(join(out, `${name}.sha256`), { force: true });
			}
		}
		return { file, bytes: lstatSync(file).size, sha256, parts: manifest.parts, warnings };
	} finally {
		rmSync(staging, { recursive: true, force: true });
		rmSync(partial, { force: true });
	}
}

/** Whether a gateway answers on this port, for the refusal to restore over a running one. */
export async function gatewayAnswers(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Restore a backup into `dir`. Everything replaced is moved aside first, never deleted.
 * `running` and `stopGateway` are parameters for the tests; the CLI supplies the real ones.
 */
export async function restore({ dir, file, dbPath = join(dir, "gateway.db"), stop = false, running, stopGateway, now = Date.now() }) {
	dir = resolve(dir);
	file = resolve(file);
	if (!existsSync(file)) throw new BackupError(`no such backup: ${file}`);
	process.umask(0o077);
	// A fresh host has no gateway folder yet.
	mkdirSync(dirname(dbPath), { recursive: true });

	// The archive must be the one that was written: its checksum, then a readable manifest.
	const sidecar = `${file}.sha256`;
	const warnings = [];
	if (existsSync(sidecar)) {
		const want = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
		if ((await sha256File(file)) !== want) throw new BackupError("the backup does not match its .sha256: it is damaged or was changed");
	} else {
		warnings.push("there is no .sha256 next to the backup, so its integrity was not checked");
	}
	const manifestText = await readMember(file, "MANIFEST.json");
	let manifest;
	try {
		manifest = JSON.parse(manifestText);
	} catch {
		throw new BackupError("the backup has no readable manifest: it is not a Piper backup");
	}
	if (manifest.format !== FORMAT) throw new BackupError(`unsupported backup format ${manifest.format}`);

	// Nothing can be running from a folder that has no database yet (a fresh host, a scratch copy).
	const port = Number(readSettings(dbPath, ["PORT"]).PORT) || 8787;
	if (existsSync(dbPath) && (await (running ?? gatewayAnswers)(port))) {
		if (!stop) throw new BackupError(`the gateway is running on port ${port}: stop it first, or use --stop`);
		await stopGateway?.();
		if (await (running ?? gatewayAnswers)(port)) throw new BackupError("the gateway did not stop");
	}

	// The database first: it says where the folders belong, and it is checked before anything moves.
	const staging = mkdtempSync(join(dirname(dbPath), ".restore-"));
	try {
		const newDb = join(staging, "gateway.db");
		await extractMember(file, "db/gateway.db", newDb);
		if ((await sha256File(newDb)) !== manifest.db?.sha256) throw new BackupError("the database in the backup does not match its manifest");
		const check = new DatabaseSync(newDb);
		try {
			const rows = check.prepare("PRAGMA integrity_check").all();
			if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw new BackupError("the database in the backup failed its integrity check");
		} finally {
			check.close();
		}

		// Folders that were under the old gateway folder follow it to the new one.
		const from = manifest.gatewayDir;
		const rewrites = {};
		const edit = new DatabaseSync(newDb);
		let targets;
		try {
			for (const [, key] of FOLDER_SETTINGS) {
				const row = edit.prepare("SELECT value FROM settings WHERE key = ?").get(key);
				const moved = row && mapPath(row.value, from, dir);
				if (row && moved !== row.value) {
					edit.prepare("UPDATE settings SET value = ? WHERE key = ?").run(moved, key);
					rewrites[key] = { from: row.value, to: moved };
				}
			}
			targets = partPathsFrom(edit, dir);
			// A stored chat names its key's workspace by path; it follows the workspaces folder.
			const oldRoot = manifest.parts?.workspaces?.path;
			for (const row of edit.prepare("SELECT id_hash, workspace FROM chats").all()) {
				const moved = mapPath(row.workspace, oldRoot, targets.workspaces);
				if (moved !== row.workspace) edit.prepare("UPDATE chats SET workspace = ? WHERE id_hash = ?").run(moved, row.id_hash);
			}
		} finally {
			edit.close();
		}

		const stampNow = stamp(now);
		const movedAside = [];
		const aside = (path) => {
			if (!lstatExists(path)) return;
			const to = `${path}.before-restore-${stampNow}`;
			renameSync(path, to);
			movedAside.push(to);
		};
		aside(dbPath);
		aside(`${dbPath}-wal`);
		aside(`${dbPath}-shm`);
		const restored = [];
		for (const name of Object.keys(manifest.parts ?? {})) {
			const target = targets[name];
			if (!target) continue;
			aside(target);
			mkdirSync(target, { recursive: true, mode: 0o700 });
			await tar(["-xzf", file, "-C", target, "--strip-components=2", `parts/${name}`]);
			restored.push({ name, path: target });
		}
		renameSync(newDb, dbPath);
		chmodSync(dbPath, 0o600);
		return { manifest, restored, movedAside, rewrites, warnings };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

const lstatExists = (path) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

function readSettingsFrom(db, key) {
	return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

function partPathsFrom(db, dir) {
	const settings = {};
	for (const [, key] of FOLDER_SETTINGS) settings[key] = readSettingsFrom(db, key);
	return partPaths(dir, settings);
}

/** One file's contents from the archive, as text. */
async function readMember(file, member) {
	const chunks = [];
	const pass = new PassThrough();
	pass.on("data", (c) => chunks.push(c));
	try {
		await tar(["-xzOf", file, member], { stdout: pass });
	} catch (err) {
		throw new BackupError(`cannot read ${member} from the backup: ${err.message}`);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) throw new BackupError(`${member} is missing from the backup`);
	return text;
}

/** One file from the archive, written to a path. */
async function extractMember(file, member, to) {
	const out = createWriteStream(to, { mode: 0o600 });
	await tar(["-xzOf", file, member], { stdout: out });
	await new Promise((resolvePromise) => out.end(resolvePromise));
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main(argv) {
	const [command, ...rest] = argv;
	const opts = { dir: dirname(fileURLToPath(import.meta.url)) };
	const positional = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--out") opts.out = rest[++i];
		else if (a === "--keep") opts.keep = Number(rest[++i]);
		else if (a === "--dir") opts.dir = rest[++i];
		else if (a === "--no-chats") opts.chats = false;
		else if (a === "--force") opts.force = true;
		else if (a === "--stop") opts.stop = true;
		else if (a.startsWith("-")) throw new BackupError(`unknown option ${a}`);
		else positional.push(a);
	}
	if (opts.keep !== undefined && !(opts.keep >= 0)) throw new BackupError("--keep needs a number");
	opts.dbPath = process.env.GATEWAY_DB || join(opts.dir, "gateway.db");
	if (command === "backup") {
		const result = await backup(opts);
		console.log(`backup: ${result.file} (${mb(result.bytes)})`);
		for (const [name, part] of Object.entries(result.parts)) console.log(`  ${name.padEnd(13)} ${String(part.files).padStart(6)} files  ${mb(part.bytes).padStart(10)}  ${part.path}`);
		console.log(`  sha256 ${result.sha256}`);
		console.log("  contains an API key (container-pi/models.json) and the database: keep it private.");
		for (const w of result.warnings) console.log(`  note: ${w}`);
		return 0;
	}
	if (command === "restore") {
		if (positional.length !== 1) throw new BackupError("restore needs the backup file: restore FILE [--stop]");
		const here = dirname(fileURLToPath(import.meta.url));
		opts.file = positional[0];
		opts.stopGateway = () => new Promise((res) => spawn(join(here, "piper.sh"), ["stop"], { stdio: "inherit" }).on("close", res));
		const result = await restore(opts);
		console.log(`restored ${result.manifest.created} from ${result.manifest.host}:`);
		for (const r of result.restored) console.log(`  ${r.name.padEnd(13)} -> ${r.path}`);
		for (const [key, r] of Object.entries(result.rewrites)) console.log(`  ${key}: ${r.from} -> ${r.to}`);
		console.log("moved aside, not deleted (remove them when you are satisfied):");
		for (const m of result.movedAside) console.log(`  ${m}`);
		for (const w of result.warnings) console.log(`  note: ${w}`);
		console.log("start the gateway to use it. Containers were not restored: chats get a fresh one on their next message.");
		return 0;
	}
	console.error("usage: piper-backup.mjs backup [--out DIR] [--keep N] [--no-chats] [--force]\n       piper-backup.mjs restore FILE [--stop]");
	return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(`piper-backup: ${err instanceof BackupError ? err.message : err?.stack ?? err}`);
			process.exit(1);
		},
	);
}
