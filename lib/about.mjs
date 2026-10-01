/**
 * What the About page shows: the version and author from package.json, the release notes from
 * CHANGELOG.md, and a few live facts about this installation. Only fixed files next to the gateway are
 * read; nothing comes from a request.
 */
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import { GATEWAY_DB, GATEWAY_DIR } from "./settings.mjs";
import { diskPiVersion, hostPiVersion } from "./containers.mjs";
import { lastEngineStatus } from "./engine.mjs";

const startedAt = Date.now();

/** package.json's fields the page shows. */
export function readPackage(dir = GATEWAY_DIR) {
	try {
		const p = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
		const author = typeof p.author === "string" ? { name: p.author, email: "" } : { name: p.author?.name ?? "", email: p.author?.email ?? "" };
		const repo = typeof p.repository === "string" ? p.repository : p.repository?.url ?? "";
		return { name: p.name ?? "piper", version: p.version ?? "", license: p.license ?? "", author, homepage: p.homepage ?? "", repository: repo.replace(/^git\+/, "").replace(/\.git$/, ""), description: p.description ?? "" };
	} catch {
		return { name: "piper", version: "", license: "", author: { name: "", email: "" }, homepage: "", repository: "", description: "" };
	}
}

/**
 * CHANGELOG.md as releases: [{version, date, sections: [{title, items[]}]}], newest first as written. Headings
 * are `## [0.4.0] - 2026-09-30` and `### Added`; an item is a `- ` line, and an indented line continues it.
 * Anything else is ignored, so a garbled file gives fewer releases, not an error.
 */
export function parseChangelog(text) {
	const releases = [];
	let release = null;
	let section = null;
	let item = null;
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.replace(/\s+$/, "");
		const head = /^##\s+\[?v?(\d+\.\d+\.\d+[\w.+-]*)\]?(?:\s*[-–]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
		if (head) {
			release = { version: head[1], date: head[2] ?? null, sections: [] };
			releases.push(release);
			section = item = null;
			continue;
		}
		if (!release) continue;
		const sub = /^###\s+(.+)$/.exec(line);
		if (sub) {
			section = { title: sub[1].trim(), items: [] };
			release.sections.push(section);
			item = null;
			continue;
		}
		if (!section) continue;
		const bullet = /^[-*]\s+(.+)$/.exec(line);
		if (bullet) {
			item = bullet[1];
			section.items.push(item);
		} else if (item !== null && /^\s+\S/.test(line)) {
			section.items[section.items.length - 1] = `${section.items[section.items.length - 1]} ${line.trim()}`;
		}
	}
	return releases;
}

export function readChangelog(dir = GATEWAY_DIR) {
	try {
		return parseChangelog(readFileSync(`${dir}/CHANGELOG.md`, "utf8"));
	} catch {
		return [];
	}
}

/** Third-party code shipped in vendor/ (see THIRD_PARTY.md): shown on the About page. */
export const THIRD_PARTY = [
	{ name: "xterm.js", version: "6.0.0", licence: "MIT", url: "https://github.com/xtermjs/xterm.js", what: "the terminal emulator in the Terminal tab (Containers)" },
	{ name: "xterm.js fit addon", version: "0.11.0", licence: "MIT", url: "https://github.com/xtermjs/xterm.js", what: "sizes the terminal to its window" },
];

/** The About page's payload. */
export async function aboutInfo({ dir = GATEWAY_DIR, now = Date.now() } = {}) {
	let dbBytes = null;
	try {
		dbBytes = statSync(GATEWAY_DB).size;
	} catch {
		/* a memory database, or not readable */
	}
	const engine = lastEngineStatus();
	return {
		...readPackage(dir),
		changelog: readChangelog(dir),
		thirdParty: THIRD_PARTY,
		installation: {
			piRunning: await hostPiVersion(),
			piInstalled: diskPiVersion(),
			node: process.version,
			docker: engine?.engine?.version ?? null,
			platform: `${os.platform()} ${os.release()} (${os.arch()})`,
			startedAt,
			uptimeSec: Math.round((now - startedAt) / 1000),
			databaseBytes: dbBytes,
		},
	};
}
