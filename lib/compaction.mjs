/**
 * Keeping every profile's compaction settings in line with COMPACT_AT_PERCENT.
 *
 * Pi's own auto-compaction threshold is an absolute token count (`reserveTokens`), not a percentage:
 * it fires once `contextTokens > contextWindow - reserveTokens`. Hitting "compact at N% full" for
 * every model, whatever its own window size, means computing `reserveTokens = (100-N)% of that
 * model's context window` and writing it as a `compaction.modelOverrides` entry (keyed `provider/id`,
 * same as Pi's own) into every profile's settings.json -- the file Pi reads inside a container as
 * PI_CODING_AGENT_DIR (lib/containers.mjs).
 *
 * Models and their context windows change independently of any one chat (a model added, a login
 * made), so this runs as a sweep over every profile on disk -- at gateway startup, whenever
 * COMPACT_AT_PERCENT is saved, and whenever the model catalogue reloads -- rather than once per
 * container start. A profile not yet touched gets the same sweep the next time one of those fires.
 *
 * Only the entries this module wrote are ever touched again: each sweep records which model keys it
 * set under a `piper.compactionManagedModels` marker in the same settings.json (a top-level key Pi
 * itself ignores, the same family as the `packages`/`enabledModels` keys Pi writes there itself), so
 * turning the feature back off removes exactly those and leaves anything a person configured by hand.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./settings.mjs";
import { profileRoot } from "./paths.mjs";
import { modelRuntime } from "./models.mjs";
import { catalogueFor } from "./containerpi.mjs";

const MARKER = "compactionManagedModels";
/** Tokens always held back regardless of percent, so a reply always has somewhere to land. */
const MIN_RESERVE = 1024;

function readJsonSafe(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** reserveTokens so compaction fires once `percent`% of a model's own context window is used. */
export function reserveTokensFor(contextWindow, percent) {
	const window = Number(contextWindow) || 0;
	if (window <= 0) return null;
	return Math.max(MIN_RESERVE, Math.round(window * (1 - percent / 100)));
}

/** Every model's own key (`provider/id`, matching Pi's `modelOverrides` keys) and context window. */
async function modelWindows(runtime) {
	return catalogueFor(runtime).map((m) => ({ key: `${m.provider}/${m.id}`, contextWindow: m.contextWindow }));
}

/** Apply (or clear) the managed overrides in one profile's settings.json. Never touches anything else. */
function applyToProfile(dir, overrides) {
	const path = join(dir, "settings.json");
	if (!existsSync(path)) return;
	const settings = readJsonSafe(path);
	const managed = new Set(settings.piper?.[MARKER] ?? []);
	const modelOverrides = { ...(settings.compaction?.modelOverrides ?? {}) };
	let changed = false;
	for (const key of managed) {
		if (key in modelOverrides) {
			delete modelOverrides[key];
			changed = true;
		}
	}
	for (const { key, reserveTokens } of overrides ?? []) {
		modelOverrides[key] = { ...(modelOverrides[key] ?? {}), reserveTokens };
		changed = true;
	}
	if (!changed) return;
	const compaction = { ...(settings.compaction ?? {}), modelOverrides };
	if (compaction.enabled === undefined) compaction.enabled = true;
	settings.compaction = compaction;
	const piper = { ...(settings.piper ?? {}) };
	if (overrides?.length) piper[MARKER] = overrides.map((o) => o.key);
	else delete piper[MARKER];
	if (Object.keys(piper).length) settings.piper = piper;
	else delete settings.piper;
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** Recompute and (re)write every profile's managed compaction overrides from COMPACT_AT_PERCENT. */
export async function syncCompactionSettings({ runtime = null } = {}) {
	const root = profileRoot();
	if (!root || !existsSync(root)) return;
	const percent = Number(config.COMPACT_AT_PERCENT) || 0;
	let overrides = null;
	if (percent > 0) {
		const windows = await modelWindows(runtime ?? (await modelRuntime()));
		overrides = windows.map(({ key, contextWindow }) => ({ key, reserveTokens: reserveTokensFor(contextWindow, percent) })).filter((o) => o.reserveTokens !== null);
	}
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isDirectory()) applyToProfile(join(root, entry.name), overrides);
	}
}
