/** Models: loading Pi, the model catalogue, name resolution and error classification. */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./settings.mjs";
import { agentDirPath, isInside } from "./paths.mjs";
import { directCatalogue, directProviders } from "./containerpi.mjs";

export const PKG = "@earendil-works/pi-coding-agent";

/**
 * Pi's own "managed install" (introduced in Pi 1.6.0): a stable launcher script (~/.pi/agent/bin/pi)
 * whose actual package moves on every self-update, named in install/current-version (plain text) --
 * `install/releases/<that version>/node_modules/<pkg>`, never a fixed path. `pi update`, run against an
 * older, conventionally npm-installed Pi, migrates it into this layout and removes the old npm-global
 * copy outright (confirmed 2026-11-22, after a 1.5.2-era install updated itself to 1.6.0 this way and
 * left the gateway's old resolution path -- npm's own global folder -- empty). Read fresh every call,
 * never cached: the version segment changes under this on every later update too, exactly the same
 * problem a hardcoded PI_AGENT_PACKAGE would have.
 */
export function managedInstallRoot(home = process.env.HOME) {
	return home ? join(home, ".pi", "agent", "install") : null;
}
export function managedInstallPackageDir(home, root = managedInstallRoot(home)) {
	if (!root) return null;
	let version;
	try {
		version = readFileSync(join(root, "current-version"), "utf8").trim();
	} catch {
		return null;
	}
	if (!version) return null;
	const dir = join(root, "releases", version, "node_modules", PKG);
	return existsSync(dir) ? dir : null;
}

/**
 * The stable entrypoint script a managed install declares, next to current-version in its own
 * manifest (managed-install.json): `{"entrypoint":{"type":"script","path":"/.../bin/pi"}}`. Running a
 * managed install's own bundled dist/bundle/cli.js directly (bypassing this script) skips whatever
 * context it sets up first -- Pi 1.6.1 refuses to self-update at all without it ("pi cannot self-update
 * this installation"), confirmed against a real install 2026-11-26. Returns null with nothing managed,
 * or a manifest that does not declare a runnable script.
 */
export function managedInstallEntrypoint(home = process.env.HOME) {
	const root = managedInstallRoot(home);
	if (!root) return null;
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(root, "managed-install.json"), "utf8"));
	} catch {
		return null;
	}
	const path = manifest?.entrypoint?.type === "script" ? manifest.entrypoint.path : null;
	return path && existsSync(path) ? path : null;
}

/**
 * Where Pi's package actually sits on disk right now, for whichever install the gateway loaded it
 * from. A managed install's loaded directory never changes in place -- its self-update creates an
 * entirely new release directory and flips current-version rather than touching this one -- so a
 * frozen `packageDir` would report "unchanged" forever after the first update that actually worked.
 * Re-resolved fresh only when `packageDir` is itself inside the managed install; a conventional npm
 * install is mutated in place by its own update, so the frozen path is already current for it.
 */
export function currentPackageDir({ packageDir = piPackageDir, managedRoot = managedInstallRoot() } = {}) {
	if (managedRoot && packageDir && isInside(managedRoot, packageDir)) return managedInstallPackageDir(undefined, managedRoot) ?? packageDir;
	return packageDir;
}

export let piModule;
// The package directory Pi was loaded from, so the gateway can tell which Pi version it runs.
export let piPackageDir = "";
// The version that was loaded into this process. Updating Pi on disk does not change what this process
// runs, so anything that must match the running gateway (images, containers) reads this, not the disk.
export let loadedPiVersion = "";
export async function pi() {
	if (piModule) return piModule;
	const specs = [PKG];
	// Tried ahead of the bare specifier and the npm-global fallback below, but behind an explicit
	// PI_AGENT_PACKAGE: an operator who set that meant it, a managed install is only ever a guess.
	const managed = managedInstallPackageDir();
	if (managed) specs.unshift(pathToFileURL(`${managed}/dist/index.js`).href);
	const dir = config.PI_AGENT_PACKAGE?.replace(/\/$/, "");
	if (dir) specs.unshift(pathToFileURL(`${dir}/dist/index.js`).href);
	try {
		specs.push(pathToFileURL(`${execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()}/${PKG}/dist/index.js`).href);
	} catch {
		// no global npm on PATH; project-local resolution still applies
	}
	const errors = [];
	for (const spec of specs) {
		try {
			piModule = await import(spec);
			try {
				const entry = spec.startsWith("file:") ? spec : import.meta.resolve(spec);
				piPackageDir = dirname(dirname(fileURLToPath(entry)));
				try {
					loadedPiVersion = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8")).version ?? "";
				} catch {
					/* unreadable: the disk is asked instead */
				}
			} catch {
				/* only the version check needs it, and it reports its absence itself */
			}
			break;
		} catch (err) {
			errors.push(`${spec}: ${err.message}`);
		}
	}
	if (!piModule) throw new Error(`Cannot load ${PKG}. Set PI_AGENT_PACKAGE.\n${errors.join("\n")}`);
	return piModule;
}

export let runtimePromise;
let runtimeStamp = "";
let runtimeCheckedAt = 0;

/** The files the catalogue is built from; a change to any of them means it is out of date. */
const CATALOGUE_FILES = ["models.json", "auth.json", "settings.json"];

/** Modification times of the catalogue's source files, as one comparable string. */
export function catalogueStamp(dir = agentDirPath()) {
	return CATALOGUE_FILES.map((f) => {
		try {
			return statSync(join(dir, f)).mtimeMs;
		} catch {
			return 0;
		}
	}).join(":");
}

/**
 * The model catalogue, rebuilt when the operator's Pi configuration changes. A model added or a
 * login made in `pi` shows up without restarting the gateway. The check is a few stat calls, done at
 * most every two seconds; a call already in flight finishes on the catalogue it started with.
 */
export function modelRuntime({ now = Date.now() } = {}) {
	if (runtimePromise && now - runtimeCheckedAt >= 2000) {
		runtimeCheckedAt = now;
		if (catalogueStamp() !== runtimeStamp) runtimePromise = null;
	}
	if (!runtimePromise) {
		runtimeStamp = catalogueStamp();
		runtimeCheckedAt = now;
		runtimePromise = pi().then(({ ModelRuntime }) => ModelRuntime.create({ allowModelNetwork: false }));
		runtimePromise.catch(() => (runtimePromise = null));
	}
	return runtimePromise;
}

/** Rebuild the catalogue now, for the dashboard's reload button. */
export function reloadModelRuntime() {
	runtimePromise = null;
	return modelRuntime();
}

/**
 * Map an OpenAI `model` string to a Pi model, or undefined for the default. Models the container
 * config defines (the ones Pi calls directly) are found too, and win over a host provider of the
 * same name, since that is what a container's Pi would use.
 */
export function resolveModel(runtime, name) {
	if (!name || name === "pi") return undefined;
	const direct = directProviders();
	const directModels = directCatalogue();
	if (name.includes("/")) {
		const [provider, ...rest] = name.split("/");
		const id = rest.join("/");
		if (direct.has(provider)) return directModels.find((m) => m.provider === provider && m.id === id);
		return runtime.getModel(provider, id) ?? undefined;
	}
	return [...runtime.getAvailableSnapshot().filter((m) => !direct.has(m.provider)), ...directModels].find((m) => m.id === name || m.name === name);
}

export const MODEL_STOPWORDS = new Set([
	"a", "an", "the", "to", "from", "on", "in", "with", "for", "of", "my", "it", "its",
	"model", "swap", "switch", "change", "use", "set", "please", "default", "pi", "llm",
]);

/** Lowercase word tokens, keeping dots so "4.1" stays distinct from "4". */
export function modelTokens(text) {
	return String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9.]+/)
		.filter((token) => token && !MODEL_STOPWORDS.has(token));
}

export function tokenMatches(queryToken, hayToken) {
	return hayToken === queryToken || hayToken.includes(queryToken) || queryToken.includes(hayToken);
}

/**
 * Resolve a free-text model request against the live catalog.
 *
 * Returns `{ model }` only when one candidate is the unique best match; otherwise returns
 * `{ candidates }` and the caller must change nothing. Guessing is the failure mode to
 * avoid: the catalog holds both `opencode-go/deepseek-v4.1-flash` and
 * `opencode-go/deepseek-v4-flash`, which differ by one character, so a near-miss would
 * silently persist the wrong model. "4.1" matches "v4.1" but never "v4".
 */
export function resolveModelQuery(models, query) {
	const tokens = modelTokens(query);
	if (!tokens.length) return { model: null, candidates: [] };
	// An exact provider/id, or an id only one provider has, is not a question. Word scoring would
	// otherwise call "gpt-5-mini" a tie with "gpt-5.4-mini", which shares every one of its words.
	const exact = String(query).trim().toLowerCase();
	const byFullId = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === exact);
	if (byFullId.length === 1) return { model: byFullId[0], candidates: [] };
	const byId = models.filter((m) => String(m.id).toLowerCase() === exact);
	if (byId.length === 1) return { model: byId[0], candidates: [] };

	const scored = [];
	for (const model of models) {
		const hay = modelTokens(`${model.provider}/${model.id} ${model.name ?? ""}`);
		let score = 0;
		for (const token of tokens) if (hay.some((h) => tokenMatches(token, h))) score += 1;
		if (score > 0) scored.push({ model, score });
	}
	if (!scored.length) return { model: null, candidates: [] };

	scored.sort((a, b) => b.score - a.score);
	const best = scored[0].score;
	const winners = scored.filter((s) => s.score === best);
	// Unique best that matched all but at most one significant word -> confident.
	if (winners.length === 1 && best >= Math.max(1, tokens.length - 1)) return { model: winners[0].model, candidates: [] };
	// Only suggest alternatives when at least half the words actually matched. Otherwise a
	// nonsense name like "gpt-9-turbo-ultra" comes back as a list of every gpt model, which
	// reads like a plausible suggestion when it is really just noise from one shared word.
	if (best < Math.ceil(tokens.length / 2)) return { model: null, candidates: [] };
	return { model: null, candidates: winners.slice(0, 8).map((s) => `${s.model.provider}/${s.model.id}`) };
}

/** Quota, credit and subscription exhaustion — permanent for the account. */
export const QUOTA_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|insufficient_quota|exceeded your current quota|quota exceeded|billing|out of credits|credit balance/i;

/** Transient provider and transport failures, which Pi retries before giving up. */
export const TRANSIENT_ERROR_PATTERN =
	/overloaded|high demand|rate.?limit|too many requests|\b(?:429|500|502|503|504|520|524)\b|service.?unavailable|server.?error|internal.?error|provider.?(?:returned|error)|network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?(?:closed|error)|stream ended/i;

/** Classify a failed turn's error text. Mirrors how Pi decides retryable vs fatal. */
export function classifyModelError(errorMessage) {
	if (!errorMessage) return "none";
	if (QUOTA_ERROR_PATTERN.test(errorMessage)) return "quota";
	if (TRANSIENT_ERROR_PATTERN.test(errorMessage)) return "transient";
	return "other";
}

/**
 * Whether a failed turn is worth retrying on a different model.
 *
 * "quota" is permanent for the account, so a same-model retry cannot help. "transient" only
 * reaches us once Pi has already exhausted its own retries. "other" is a deterministic request
 * problem — a bad payload, a context overflow — that a different model will not fix either, so
 * retrying would just fail twice.
 */
export function shouldFallBack(errorMessage) {
	const kind = classifyModelError(errorMessage);
	return kind === "quota" || kind === "transient";
}

/** The configured fallback model, or null when disabled or unresolvable. */
export async function fallbackModel() {
	if (!config.FALLBACK_MODEL) return null;
	const runtime = await modelRuntime();
	return resolveModel(runtime, config.FALLBACK_MODEL) ?? null;
}
