/**
 * A key's own container settings, and what a chat of that key actually gets.
 *
 * The defaults are the CONTAINER_* settings. A key can override memory, CPU, processes, network and
 * image, and add mounts and environment variables of its own; a blank field follows the default. `persistent`
 * gives the key one container that lasts between its chats. The
 * stored form is one JSON object in api_keys.container_json, written only after `normalize` accepted it.
 */
import { config } from "./settings.mjs";
import { apiKeys } from "./auth.mjs";
import { agents } from "./agents.mjs";
import { parseContainerEnv, parseContainerMounts } from "./paths.mjs";
import { NETWORK_MODES, imageInfo } from "./engine.mjs";

export const CONTAINER_FIELDS = ["memoryMb", "cpus", "pids", "network", "image", "mounts", "env", "persistent"];
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:@-]{0,127}$/i;

const blank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function number(raw, name, { integer = false } = {}) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
		throw new Error(`${name} must be ${integer ? "a whole number" : "a number"} of 0 or more (0 is unlimited), or blank for the default`);
	}
	return n;
}

/**
 * The container settings a dashboard form sent, checked and reduced to what is actually set, or null
 * when nothing is. Anything wrong throws with a message naming the field. The mounts and environment
 * go through the same strict parsers as the global settings, so a key cannot be given what the
 * operator could not be.
 */
export function normalizeContainerInput(raw) {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("container settings must be an object");
	for (const key of Object.keys(raw)) if (!CONTAINER_FIELDS.includes(key)) throw new Error(`unknown container setting: ${key}`);
	const out = {};
	if (!blank(raw.memoryMb)) out.memoryMb = number(raw.memoryMb, "memory", { integer: true });
	if (!blank(raw.pids)) out.pids = number(raw.pids, "processes", { integer: true });
	if (!blank(raw.cpus)) out.cpus = number(raw.cpus, "cpus");
	if (!blank(raw.network)) {
		if (!NETWORK_MODES.includes(raw.network)) throw new Error(`network must be one of ${NETWORK_MODES.join(", ")}, or blank for the default`);
		out.network = raw.network;
	}
	if (!blank(raw.image)) {
		const image = String(raw.image).trim();
		if (!IMAGE_NAME.test(image)) throw new Error(`"${image}" is not an image name`);
		out.image = image;
	}
	// Persistent: one container for the key, kept between chats, so what the agent installs stays.
	if (!blank(raw.persistent)) {
		if ([true, "true", "1", 1].includes(raw.persistent)) out.persistent = true;
		else if (![false, "false", "0", 0].includes(raw.persistent)) throw new Error("persistent must be on or off");
	}
	if (!blank(raw.mounts)) {
		const text = String(raw.mounts).trim();
		if (text.length > 2000) throw new Error("mounts is too long");
		try {
			parseContainerMounts(text, { strict: true });
		} catch (err) {
			throw new Error(err.message.replace(/^CONTAINER_MOUNTS: /, "mounts: "));
		}
		out.mounts = text;
	}
	if (!blank(raw.env)) {
		const text = String(raw.env).trim();
		if (text.length > 2000) throw new Error("env is too long");
		try {
			parseContainerEnv(text, { strict: true });
		} catch (err) {
			throw new Error(err.message.replace(/^CONTAINER_ENV: /, "env: "));
		}
		out.env = text;
	}
	return Object.keys(out).length ? out : null;
}

/** The defaults every key starts from. */
export function containerDefaults() {
	return { memoryMb: config.CONTAINER_MEMORY_MB, cpus: config.CONTAINER_CPUS, pids: config.CONTAINER_PIDS, network: config.CONTAINER_NETWORK, image: config.CONTAINER_IMAGE, mounts: config.CONTAINER_MOUNTS, env: config.CONTAINER_ENV };
}

/**
 * What a chat of this scope gets. A key's main endpoint: the key's own values over the defaults. An
 * agent's: the agent's own over its key's over the defaults. Mounts and environment variables add to
 * what is below them (a layer's mount of the same container path, or value of the same variable,
 * wins). The settings key and the open gateway have no overrides. 0 means unlimited and is a value like
 * any other, so a layer can lift a limit as well as lower it. An agent is always persistent; only a
 * real key can be, and the settings key and the open gateway cannot (no key to keep a container for).
 */
export function containerSettingsFor(scopeId) {
	const agent = scopeId ? agents.getByScope(scopeId) : null;
	const keyId = agent ? agent.keyId : scopeId;
	const keyOwn = keyId ? apiKeys.get(keyId)?.container ?? null : null;
	const layers = [keyOwn, agent?.container ?? null];
	const base = containerDefaults();
	const pick = (name) => {
		let value = base[name];
		for (const layer of layers) if (layer && layer[name] !== undefined && layer[name] !== null) value = layer[name];
		return value;
	};
	let mounts = parseContainerMounts();
	for (const layer of layers) {
		const added = layer?.mounts ? parseContainerMounts(layer.mounts) : [];
		mounts = [...mounts.filter((m) => !added.some((k) => k.container === m.container)), ...added];
	}
	const env = new Map(parseContainerEnv());
	for (const layer of layers) for (const [name, value] of layer?.env ? parseContainerEnv(layer.env) : []) env.set(name, value);
	const own = agent ? agent.container : keyOwn;
	return { memoryMb: pick("memoryMb"), cpus: pick("cpus"), pids: pick("pids"), network: pick("network"), image: pick("image"), mounts, env: [...env], persistent: Boolean(agent || (keyId && keyOwn?.persistent)), own };
}

/** Every network policy some chat may use: the default and each key's own. */
export function networkModesInUse() {
	return [...new Set([config.CONTAINER_NETWORK, ...apiKeys.list().map((k) => k.container?.network).filter(Boolean), ...agents.list().map((a) => a.container?.network).filter(Boolean)])];
}

/**
 * Container settings from a form, checked: the fields through the strict parsers, and a named image
 * has to exist and be one of Piper's (it carries Pi and the labels), or every chat would fail to
 * start. Returns the settings to store, or null for none.
 */
export async function checkedContainerSettings(raw) {
	const settings = normalizeContainerInput(raw);
	if (settings?.image) {
		const image = await imageInfo(settings.image);
		if (!image) throw new Error(`the image "${settings.image}" does not exist on this host`);
		if (!image.piVersion) throw new Error(`"${settings.image}" is not a Piper image (it has no piper.pi-version label): build one from docker/environments with ./piper.sh image`);
	}
	return settings;
}
