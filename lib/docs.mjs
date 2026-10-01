/**
 * The Documentation page: an administrator's handbook inside the dashboard.
 *
 * Pages are Markdown files shipped with Piper: the wiki pages in `docs/`, plus DEPLOYMENT.md and README.md
 * served as pages of their own (one source each, nothing copied). They are rendered here, on the server,
 * by a small renderer that escapes everything it does not recognise and emits only a fixed set of tags, so
 * nothing in a page can run script. Which files can be read is decided by a list built from the folder, never
 * from a request: a page id that is not in it is a 404.
 *
 * Tables that must not drift from the code (every setting, the container paths, the audit categories, the
 * networks, the command lines) are not written by hand: a line such as `<!-- generated:settings -->` in a page
 * is replaced by a table built from the code itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_DIR, SETTINGS_SPEC } from "./settings.mjs";
import { CONTAINER_PATHS } from "./paths.mjs";
import { BLOCKED_RANGES, NETWORK, NETWORK_MODES, NETWORK_OPEN } from "./engine.mjs";
import { AUDIT_CATEGORIES } from "./audit.mjs";

/** Titles for the pages that are not wiki pages, whose first heading is the project's ("Piper"). */
const TITLES = { deployment: "Deployment guide", reference: "Reference manual" };
/** The order pages are listed in; any other page in docs/ follows, alphabetically. */
const ORDER = ["overview", "functions", "deployment", "operations", "variables", "files", "api", "security", "troubleshooting", "reference"];
/** Files outside docs/ that are pages too, by id. */
const EXTRA = { deployment: "DEPLOYMENT.md", reference: "README.md" };
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

// ---------------------------------------------------------------------------------------------
// Which pages there are
// ---------------------------------------------------------------------------------------------

/** The text of a page's first paragraph, for the list. */
function summaryOf(markdown) {
	const lines = markdown.split("\n");
	let i = lines.findIndex((l) => /^#\s/.test(l));
	for (i = i + 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith("#") || line.startsWith("<!--") || line.startsWith("![") || line.startsWith("```") || line.startsWith("|") || line.startsWith(">")) continue;
		return line.replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").slice(0, 170);
	}
	return "";
}

/** Every page: [{id, title, summary, file}], from the folder. Read on each call, so an edited page shows without a restart. */
export function listPages(dir = GATEWAY_DIR) {
	const found = new Map();
	const add = (id, file) => {
		if (!ID.test(id)) return;
		try {
			const text = readFileSync(join(dir, file), "utf8");
			const title = TITLES[id] ?? /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/[*_`]/g, "").trim() ?? id;
			found.set(id, { id, title, summary: summaryOf(text), file });
		} catch {
			/* a page that is not there is not listed */
		}
	};
	try {
		for (const name of readdirSync(join(dir, "docs"))) if (name.endsWith(".md")) add(name.slice(0, -3), join("docs", name));
	} catch {
		/* no docs folder */
	}
	for (const [id, file] of Object.entries(EXTRA)) add(id, file);
	const rank = (id) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
	return [...found.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** The file name to page id map, for turning `DEPLOYMENT.md` and `docs/api.md` links into page links. */
function linkTargets(pages) {
	const map = new Map();
	for (const p of pages) {
		map.set(p.file, p.id);
		map.set(p.file.replace(/^docs\//, ""), p.id);
		map.set(`./${p.file}`, p.id);
		// A wiki page may link to any page by its id, `deployment.md`, even when that page's file is DEPLOYMENT.md.
		map.set(`${p.id}.md`, p.id);
	}
	return map;
}

// ---------------------------------------------------------------------------------------------
// Generated tables
// ---------------------------------------------------------------------------------------------

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

const DURATION_UNITS = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]];
function showDefault(spec) {
	const v = spec.def;
	if (spec.type === "secret") return "(none; set from the dashboard)";
	if (spec.type === "bool") return v ? "on" : "off";
	if (spec.type === "duration" && Number(v) > 0) {
		const [unit, size] = DURATION_UNITS.find(([, s]) => v % s === 0) ?? ["ms", 1];
		return `${v / size}${unit}`;
	}
	if (v === "" || v === undefined || v === null) return "(empty)";
	// Folders under this installation are written relative to it, so the page is the same on every host.
	return String(v).split(GATEWAY_DIR).join("<gateway dir>");
}

/** What a container sees at each of its fixed paths, by the name in CONTAINER_PATHS. */
export const PATH_NOTES = {
	workspace: "The key's workspace (or the agent's own), read-write; frozen read-only when over its size limit.",
	profile: "The key's Pi profile: settings, skills, extensions, prompts, AGENTS.md. Pi's own agent folder.",
	profileFrozen: "A locked or over-quota profile, mounted read-only here and copied into a tmpfs at /profile when Pi starts.",
	shared: "Operator bundles the key is granted, one folder each, read-only.",
	session: "Pi's session files. One folder per chat in a persistent container.",
	etc: "The models.json rendered for this key, read-only.",
	modelsFile: "The file the profile's models.json links to unless the key has its own.",
	run: "The directory holding the bridge socket(s).",
	socket: "The bridge socket of a chat that has a container of its own.",
	bridge: "The gateway's bridge extension, read-only.",
	profileHelper: "The profile helper, run in a throwaway container.",
	piConfig: "Where extensions keep settings they would put under ~/.pi; inside the profile so they persist per key.",
	home: "Root's home in the container; part of the container's own filesystem.",
};

const GENERATORS = {
	settings() {
		const groups = new Map();
		for (const spec of SETTINGS_SPEC) groups.set(spec.group ?? "Other", [...(groups.get(spec.group ?? "Other") ?? []), spec]);
		const out = [];
		for (const [group, specs] of groups) {
			out.push(`### ${group}`, "", table(["Variable", "Type", "Default", "Restart", "What it does"], specs.map((s) => [`\`${s.key}\``, s.type === "enum" ? `one of ${s.options.join(", ")}` : s.type, showDefault(s), s.restart ? "yes" : "no", s.help ?? ""])), "");
		}
		return out.join("\n");
	},
	paths() {
		return table(["Path in the container", "What it is"], Object.entries(CONTAINER_PATHS).map(([key, path]) => [`\`${path}\``, PATH_NOTES[key] ?? key]));
	},
	audit() {
		return table(["Category", "Setting", "Default", "Label in the page"], AUDIT_CATEGORIES.map((c) => [`\`${c.id}\``, c.setting ? `\`${c.setting}\`` : "(always recorded)", c.setting ? (c.optIn ? "off" : "on") : "on", c.label]));
	},
	networks() {
		return [
			table(["Policy", "Docker network", "Bridge", "Subnet", "Gateway"], [
				["`internet`", NETWORK.name, NETWORK.bridge, NETWORK.subnet, NETWORK.gateway],
				["`open`", NETWORK_OPEN.name, NETWORK_OPEN.bridge, NETWORK_OPEN.subnet, NETWORK_OPEN.gateway],
				["`none`", "none", "-", "-", "-"],
			]),
			"",
			`Policies: ${NETWORK_MODES.map((m) => `\`${m}\``).join(", ")}. For \`internet\` the gateway keeps firewall rules that drop traffic from containers to these ranges: ${BLOCKED_RANGES.map((r) => `\`${r}\``).join(", ")}.`,
		].join("\n");
	},
	commands() {
		// The comment block at the top of each script is its usage text.
		const usage = (file) => {
			try {
				const lines = readFileSync(join(GATEWAY_DIR, file), "utf8").split("\n").slice(1);
				const end = lines.findIndex((l) => !l.startsWith("#"));
				return lines.slice(0, end === -1 ? lines.length : end).map((l) => l.replace(/^# ?/, "")).join("\n").trimEnd();
			} catch {
				return "";
			}
		};
		return ["#### `piper.sh`", "", "```", usage("piper.sh"), "```", "", "#### `deploy.sh`", "", "```", usage("deploy.sh"), "```"].join("\n");
	},
};

// ---------------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------------

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The id a heading's text gets. */
export function slugify(text) {
	return String(text).toLowerCase().replace(/[`*_]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

/**
 * Where a link may go: http(s) and mailto as they are, an in-page anchor within the current page, a link to
 * another known page as a dashboard link; anything else (javascript:, data:, a file path, an unknown page) is
 * not a link and its text is shown plain.
 */
export function linkHref(url, { page = "", targets = new Map() } = {}) {
	const raw = String(url).trim();
	if (/^(https?:\/\/|mailto:)/i.test(raw)) return { href: raw, external: true };
	if (raw.startsWith("#")) return raw.length > 1 ? { href: `#help/docs/${page}/${slugify(raw.slice(1))}`, external: false } : null;
	const m = /^([^#]*)(?:#(.*))?$/.exec(raw);
	const id = m ? targets.get(m[1].replace(/^\.\//, "")) ?? targets.get(m[1]) : undefined;
	if (id) return { href: `#help/docs/${id}${m[2] ? `/${slugify(m[2])}` : ""}`, external: false };
	return null;
}

/** Inline Markdown to HTML: code, links, bold, italic. Everything else is escaped text. */
function inline(text, ctx) {
	const codes = [];
	let t = String(text).replace(/`([^`]+)`/g, (_, code) => {
		codes.push(`<code>${escapeHtml(code)}</code>`);
		return `\u0000${codes.length - 1}\u0000`;
	});
	// Images: dropped, their alt text kept.
	t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	const links = [];
	t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
		const target = linkHref(url, ctx);
		links.push({ label, target });
		return `\u0001${links.length - 1}\u0001`;
	});
	t = escapeHtml(t);
	t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>").replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
	t = t.replace(/\u0001(\d+)\u0001/g, (_, n) => {
		const { label, target } = links[Number(n)];
		// The label may itself hold code or emphasis.
		const inner = inlineLabel(label, codes);
		return target ? `<a href="${escapeHtml(target.href)}"${target.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>` : inner;
	});
	return t.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]);
}

function inlineLabel(label, codes) {
	return escapeHtml(label).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)] ?? "");
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

/**
 * Markdown to {html, headings}. Supported: headings, paragraphs, bullet and numbered lists (nested by
 * indentation), fenced code, tables, blockquotes, rules, and the inline forms above. Raw HTML is escaped,
 * never passed through; HTML comments other than the generated markers are dropped.
 */
export function renderMarkdown(markdown, { page = "", targets = new Map(), depth = 0 } = {}) {
	const ctx = { page, targets };
	const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
	const out = [];
	const headings = [];
	const used = new Map();
	let i = 0;

	const paragraph = [];
	const flush = () => {
		if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "), ctx)}</p>`);
		paragraph.length = 0;
	};

	while (i < lines.length) {
		const line = lines[i];
		const generated = /^\s*<!--\s*generated:([a-z]+)\s*-->\s*$/.exec(line);
		if (generated) {
			flush();
			if (depth < 2 && GENERATORS[generated[1]]) {
				const inner = renderMarkdown(GENERATORS[generated[1]](), { page, targets, depth: depth + 1 });
				out.push(inner.html);
				for (const h of inner.headings) headings.push(h);
			}
			i++;
			continue;
		}
		if (/^\s*<!--/.test(line)) {
			// A comment, possibly over several lines.
			while (i < lines.length && !/-->/.test(lines[i])) i++;
			i++;
			continue;
		}
		const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
		if (fence) {
			flush();
			const code = [];
			i++;
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
			i++;
			out.push(`<div class="codebox"><pre><code${fence[1] ? ` class="lang-${escapeHtml(fence[1])}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre></div>`);
			continue;
		}
		const head = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
		if (head) {
			flush();
			const level = head[1].length;
			const text = head[2];
			let id = slugify(text);
			const n = used.get(id) ?? 0;
			used.set(id, n + 1);
			if (n) id = `${id}-${n + 1}`;
			headings.push({ level, id, text: text.replace(/[`*_]/g, "") });
			out.push(`<h${level} id="${escapeHtml(id)}">${inline(text, ctx)}</h${level}>`);
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			out.push("<hr>");
			i++;
			continue;
		}
		if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
			flush();
			const header = splitRow(line);
			i += 2;
			const rows = [];
			while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
			out.push(`<div class="tablebox"><table><thead><tr>${header.map((c) => `<th>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${header.map((_, k) => `<td>${inline(r[k] ?? "", ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
			continue;
		}
		if (/^\s*>/.test(line)) {
			flush();
			const quote = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
			out.push(`<blockquote>${renderMarkdown(quote.join("\n"), { page, targets, depth: depth + 1 }).html}</blockquote>`);
			continue;
		}
		if (LIST_ITEM.test(line)) {
			flush();
			const items = [];
			// A bullet list and a numbered list at the same level are two lists, even with no text between them.
			const startsNewList = (text) => {
				const next = LIST_ITEM.exec(text ?? "");
				return Boolean(next && items.length && next[1].replace(/\t/g, "  ").length <= items[0].indent && /\d/.test(next[2]) !== items[0].ordered);
			};
			while (i < lines.length && ((LIST_ITEM.test(lines[i]) && !startsNewList(lines[i])) || (items.length && /^\s+\S/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !/^\s*```/.test(lines[i])) || (items.length && !lines[i].trim() && LIST_ITEM.test(lines[i + 1] ?? "") && !startsNewList(lines[i + 1])))) {
				const m = LIST_ITEM.exec(lines[i]);
				if (m) items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), text: m[3] });
				else if (lines[i].trim()) items[items.length - 1].text += ` ${lines[i].trim()}`;
				i++;
			}
			out.push(renderList(items, ctx));
			continue;
		}
		if (!line.trim()) {
			flush();
			i++;
			continue;
		}
		paragraph.push(line.trim());
		i++;
	}
	flush();
	return { html: out.join("\n"), headings };
}

/** A flat run of list items with indents as nested lists: a deeper indent opens a list inside the last item. */
function renderList(items, ctx) {
	const base = Math.min(...items.map((x) => x.indent));
	const build = (from, indent) => {
		let html = "";
		let k = from;
		const ordered = items[k].ordered;
		html += ordered ? "<ol>" : "<ul>";
		while (k < items.length && items[k].indent >= indent) {
			if (items[k].indent > indent) break;
			html += `<li>${inline(items[k].text, ctx)}`;
			k++;
			if (k < items.length && items[k].indent > indent) {
				const nested = build(k, items[k].indent);
				html += nested.html;
				k = nested.next;
			}
			html += "</li>";
		}
		html += ordered ? "</ol>" : "</ul>";
		return { html, next: k };
	};
	let out = "";
	let k = 0;
	while (k < items.length) {
		const built = build(k, Math.max(base, items[k].indent));
		out += built.html;
		k = built.next;
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Pages, and searching them
// ---------------------------------------------------------------------------------------------

/** One page rendered, or null when there is no such page. `id` is only ever compared with the list. */
export function renderPage(id, dir = GATEWAY_DIR) {
	const pages = listPages(dir);
	const page = pages.find((p) => p.id === String(id));
	if (!page) return null;
	let text = "";
	try {
		text = readFileSync(join(dir, page.file), "utf8");
	} catch {
		return null;
	}
	const { html, headings } = renderMarkdown(text, { page: page.id, targets: linkTargets(pages) });
	return { id: page.id, title: page.title, summary: page.summary, html, headings: headings.filter((h) => h.level >= 2 && h.level <= 3) };
}

/** The whole list with each page's second-level headings, for the page list. */
export function pageIndex(dir = GATEWAY_DIR) {
	return listPages(dir).map((p) => ({ id: p.id, title: p.title, summary: p.summary }));
}

/** The plain text of rendered HTML, for searching. */
function plain(html) {
	return html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/**
 * Sections whose text contains every word of `query`: [{page, title, heading, anchor, snippet}]. Each page is
 * cut at its headings, so a hit points at the section, not just the page. At most 30.
 */
export function searchDocs(query, dir = GATEWAY_DIR) {
	const words = String(query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
	if (!words.length) return [];
	const hits = [];
	for (const p of listPages(dir)) {
		const rendered = renderPage(p.id, dir);
		if (!rendered) continue;
		const parts = rendered.html.split(/(?=<h[1-4] id=")/);
		for (const part of parts) {
			const head = /^<h([1-4]) id="([^"]*)">(.*?)<\/h\1>/.exec(part);
			const text = plain(part);
			const low = text.toLowerCase();
			if (!words.every((w) => low.includes(w))) continue;
			const at = Math.max(0, low.indexOf(words[0]) - 60);
			hits.push({ page: p.id, title: p.title, heading: head ? plain(head[3]) : p.title, anchor: head ? head[2] : "", snippet: `${at ? "…" : ""}${text.slice(at, at + 200)}${at + 200 < text.length ? "…" : ""}` });
			if (hits.length >= 30) return hits;
		}
	}
	return hits;
}
