/**
 * The Pi configuration for containers: a gateway-owned folder (CONTAINER_PI_DIR) with a models.json
 * and a settings.json, separate from the operator's own ~/.pi/agent.
 *
 * Pi inside a container is a stock install. The models defined here are called by Pi directly — that
 * is the point of "configure it for the dockerized Pi" — while the bridge keeps serving the models
 * whose credentials stay on the host. So this module answers four questions: which providers are
 * direct (the bridge leaves them alone), which models they offer (for /v1/models and name
 * resolution), which endpoints the firewall must let through, and what models.json each key gets.
 *
 * Note this file may hold API keys, and those keys are inside every container that reads it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./settings.mjs";
import { containerPiDir } from "./paths.mjs";
import { hostNameservers } from "./engine.mjs";

const MODELS_FILE = () => join(containerPiDir(), "models.json");
const SETTINGS_FILE = () => join(containerPiDir(), "settings.json");

/** The folder itself, for display. */
export const containerPiDirInfo = () => containerPiDir();

/** The mark the dashboard shows in place of a key, and that a save reads as "keep what is stored". */
export const REDACTED = "***";

/** Create the folder and its two files when missing. Nothing is overwritten. */
export function ensureContainerPiDir() {
	const dir = containerPiDir();
	if (!dir) return "";
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!existsSync(MODELS_FILE())) writeFileSync(MODELS_FILE(), `${JSON.stringify({ providers: {} }, null, 2)}\n`, { mode: 0o600 });
	if (!existsSync(SETTINGS_FILE())) writeFileSync(SETTINGS_FILE(), "{}\n", { mode: 0o600 });
	return dir;
}

function readJson(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** models.json as an object: {providers: {name: {...}}}. A missing or broken file is an empty one. */
export function readContainerModels() {
	const parsed = containerPiDir() ? readJson(MODELS_FILE()) : null;
	return parsed && parsed.providers && typeof parsed.providers === "object" ? parsed : { providers: {} };
}

export function readContainerSettings() {
	return (containerPiDir() && readJson(SETTINGS_FILE())) || {};
}

/** The providers Pi calls directly. The bridge does not register these, so the two never collide. */
export function directProviders(models = readContainerModels()) {
	return new Set(Object.keys(models.providers ?? {}));
}

/** The models the container config defines, shaped like the catalogue's, for listing and resolution. */
export function directCatalogue(models = readContainerModels()) {
	const out = [];
	for (const [provider, def] of Object.entries(models.providers ?? {})) {
		for (const m of Array.isArray(def?.models) ? def.models : []) {
			if (!m || typeof m.id !== "string" || !m.id) continue;
			out.push({
				provider,
				id: m.id,
				name: m.name ?? m.id,
				api: m.api ?? def.api,
				reasoning: Boolean(m.reasoning),
				input: m.input ?? ["text"],
				contextWindow: m.contextWindow ?? 0,
				maxTokens: m.maxTokens ?? 0,
				cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				direct: true,
			});
		}
	}
	return out;
}

/**
 * Every model a key could use, by name: the host's catalogue minus the providers that are direct,
 * plus the direct models. `isAllowed(model)` is the key's allow-list.
 */
export function catalogueFor(runtime, isAllowed = () => true) {
	const models = readContainerModels();
	const direct = directProviders(models);
	const host = runtime.getAvailableSnapshot().filter((m) => !direct.has(m.provider));
	return [...host, ...directCatalogue(models)].filter((m) => isAllowed(m));
}

/** The default model and thinking level containers start on: the container config's, else the host's. */
export function containerDefaultModel(hostDefault = null) {
	const s = readContainerSettings();
	if (s.defaultProvider && s.defaultModel) return { model: `${s.defaultProvider}/${s.defaultModel}`, thinking: s.defaultThinkingLevel ?? null };
	return hostDefault;
}

/** Where a baseUrl points: {host, port}, or null when it is not an http(s) URL. */
export function endpointOf(baseUrl) {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return { host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
	} catch {
		return null;
	}
}

/** CONTAINER_ALLOW as [{host, port}]. Entries are `host` or `host:port`, separated by whitespace or commas. */
export function parseAllow(text = config.CONTAINER_ALLOW, { strict = false } = {}) {
	const out = [];
	for (const entry of String(text ?? "").split(/[\s,]+/).filter(Boolean)) {
		const match = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(entry);
		if (!match || (match[2] && Number(match[2]) > 65535)) {
			if (strict) throw new Error(`CONTAINER_ALLOW: "${entry}" is not host or host:port`);
			continue;
		}
		out.push({ host: match[1], port: match[2] ? Number(match[2]) : 0 });
	}
	return out;
}

/**
 * The endpoints containers are allowed to reach on the private network: the ones the operator named,
 * the ones their container models.json points at (a model that cannot be reached is no model), and
 * this machine's DNS resolvers (port 53 only).
 */
export function allowedEndpoints(models = readContainerModels(), nameservers = hostNameservers()) {
	const out = parseAllow().map((e) => ({ ...e, why: "CONTAINER_ALLOW" }));
	// Name resolution: without it apt, pip and git cannot find anything, whatever the network allows.
	for (const ip of nameservers) out.push({ host: ip, port: 53, proto: ["udp", "tcp"], why: "DNS resolver of this machine (resolv.conf)" });
	for (const [provider, def] of Object.entries(models.providers ?? {})) {
		const endpoint = typeof def?.baseUrl === "string" ? endpointOf(def.baseUrl) : null;
		if (endpoint) out.push({ ...endpoint, why: `container models.json, provider ${provider}` });
	}
	return out;
}

/**
 * The models.json one key gets: the container config with the models the key may not use removed.
 * A provider left with none is dropped, so the model list Pi shows is the key's own. Advisory for a
 * direct model — the key it needs is in the file, so an agent can write a models.json of its own; a
 * per-key key on the model server is what enforces it.
 */
export function renderModelsFor(isAllowed = () => true, models = readContainerModels()) {
	const providers = {};
	for (const [name, def] of Object.entries(models.providers ?? {})) {
		if (!Array.isArray(def?.models)) {
			providers[name] = def;
			continue;
		}
		const kept = def.models.filter((m) => m && typeof m.id === "string" && isAllowed({ provider: name, id: m.id }));
		if (kept.length || def.models.length === 0) providers[name] = { ...def, models: kept };
	}
	return `${JSON.stringify({ ...models, providers }, null, 2)}\n`;
}

/** Write a file atomically with an owner-only mode. */
function writePrivate(path, text) {
	const temp = `${path}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

/**
 * Write a key's rendered models.json where its chat's container reads it. The folder is the
 * gateway's, mounted read-only into the container, so a link planted by an agent cannot redirect it.
 */
export function writeChatModels(etcDir, isAllowed) {
	mkdirSync(etcDir, { recursive: true, mode: 0o700 });
	writePrivate(join(etcDir, "models.json"), renderModelsFor(isAllowed));
}

// ---------------------------------------------------------------------------------------------
// The dashboard editor: keys are shown redacted, and a saved redaction keeps the stored key.
// ---------------------------------------------------------------------------------------------

/** models.json as text with every provider's apiKey replaced by the redaction mark. */
export function redactedModelsText(models = readContainerModels()) {
	const providers = {};
	for (const [name, def] of Object.entries(models.providers ?? {})) {
		providers[name] = def && typeof def === "object" && def.apiKey ? { ...def, apiKey: REDACTED } : def;
	}
	return `${JSON.stringify({ ...models, providers }, null, 2)}\n`;
}

/** Whether text is a usable models.json, or an Error saying what is wrong. Nothing is written. */
export function validateModelsText(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`models.json is not valid JSON: ${err.message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("models.json must be an object");
	if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) throw new Error('models.json needs a "providers" object');
	for (const [name, def] of Object.entries(parsed.providers)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`provider name "${name}" is not usable`);
		if (!def || typeof def !== "object" || Array.isArray(def)) throw new Error(`provider ${name} must be an object`);
		if (def.baseUrl !== undefined && !endpointOf(def.baseUrl)) throw new Error(`provider ${name}: baseUrl must be an http(s) URL`);
		if (def.models !== undefined) {
			if (!Array.isArray(def.models)) throw new Error(`provider ${name}: models must be a list`);
			for (const m of def.models) if (!m || typeof m.id !== "string" || !m.id) throw new Error(`provider ${name}: every model needs an id`);
		}
	}
	return parsed;
}

/** Save a models.json from the dashboard: a redacted apiKey keeps the one already stored for that provider. */
export function saveModelsText(text) {
	const incoming = validateModelsText(text);
	const stored = readContainerModels().providers;
	for (const [name, def] of Object.entries(incoming.providers)) {
		if (def.apiKey === REDACTED) {
			if (stored[name]?.apiKey) def.apiKey = stored[name].apiKey;
			else delete def.apiKey;
		}
	}
	ensureContainerPiDir();
	writePrivate(MODELS_FILE(), `${JSON.stringify(incoming, null, 2)}\n`);
	return incoming;
}

/** Save the container defaults (settings.json) from the dashboard: only the three default keys. */
export function saveContainerDefaults({ defaultProvider, defaultModel, defaultThinkingLevel } = {}) {
	ensureContainerPiDir();
	const next = { ...readContainerSettings() };
	const set = (key, value) => {
		if (value === undefined) return;
		if (value === null || value === "") delete next[key];
		else next[key] = String(value);
	};
	set("defaultProvider", defaultProvider);
	set("defaultModel", defaultModel);
	set("defaultThinkingLevel", defaultThinkingLevel);
	if (Boolean(next.defaultProvider) !== Boolean(next.defaultModel)) throw new Error("set both a default provider and a default model, or neither");
	writePrivate(SETTINGS_FILE(), `${JSON.stringify(next, null, 2)}\n`);
	return next;
}
