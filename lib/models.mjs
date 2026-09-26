/** Models: loading Pi, the model catalogue, name resolution and error classification. */
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./settings.mjs";
import { agentDirPath } from "./sandbox.mjs";

export const PKG = "@earendil-works/pi-coding-agent";

export let piModule;
// The package directory Pi was loaded from, so a sandboxed session can run the same version's CLI.
export let piPackageDir = "";
export async function pi() {
	if (piModule) return piModule;
	const specs = [PKG];
	const dir = config.PI_AGENT_PACKAGE?.replace(/\/$/, "");
	if (dir) specs.unshift(pathToFileURL(`${dir}/dist/index.js`).href);
	try {
		specs.push(pathToFileURL(`${execSync("npm root -g", { encoding: "utf8" }).trim()}/${PKG}/dist/index.js`).href);
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
			} catch {
				/* only the sandboxed runners need it, and they report its absence themselves */
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

/** Map an OpenAI `model` string to a Pi model, or undefined for the default. */
export function resolveModel(runtime, name) {
	if (!name || name === "pi") return undefined;
	if (name.includes("/")) {
		const [provider, ...rest] = name.split("/");
		return runtime.getModel(provider, rest.join("/")) ?? undefined;
	}
	return runtime.getAvailableSnapshot().find((m) => m.id === name || m.name === name);
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
