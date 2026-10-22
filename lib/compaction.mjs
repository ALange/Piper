/**
 * Keeping every profile's compaction settings in line with COMPACT_AT_PERCENT (and
 * COMPACT_KEEP_RECENT_TOKENS).
 *
 * Pi's own auto-compaction threshold is a flat token count (`reserveTokens`), not a percentage, and
 * it is one number per profile -- there is no per-model compaction setting in Pi at all (its own
 * `CompactionSettings` is `{enabled?, reserveTokens?, keepRecentTokens?}`, nothing keyed by model).
 * So "compact at N% full" can only be approximated with one flat value: this computes it against the
 * *smallest* context window among the available models, which is the conservative choice -- it
 * guarantees compaction fires no later than N% for any model that profile might use, never later,
 * at the cost of firing somewhat earlier than strictly necessary for a larger-window model.
 *
 * Models and their context windows change independently of any one chat (a model added, a login
 * made), so this runs as a sweep over every profile on disk -- at gateway startup, whenever
 * COMPACT_AT_PERCENT (or COMPACT_KEEP_RECENT_TOKENS) is saved, and whenever the model catalogue
 * reloads -- rather than once per container start. A profile not yet touched gets the same sweep the
 * next time one of those fires.
 *
 * Only the keys this module itself wrote are ever touched again: a `piper.compactionManaged: true`
 * marker in the same settings.json (a top-level key Pi itself ignores, the same family as the
 * `packages`/`enabledModels` keys Pi writes there itself) says so; turning COMPACT_AT_PERCENT back to
 * 0 removes exactly `enabled`/`reserveTokens`/`keepRecentTokens` and the marker, leaving anything a
 * person hand-configured in `compaction` before the feature was ever turned on. A profile still
 * carrying the marker and field an earlier, broken version of this module used
 * (`piper.compactionManagedModels`, `compaction.modelOverrides` -- never actually read by Pi, see
 * below) has those cleaned up the first time this runs again, whether or not the feature stays on.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./settings.mjs";
import { profileRoot } from "./paths.mjs";
import { modelRuntime } from "./models.mjs";
import { catalogueFor } from "./containerpi.mjs";

const MARKER = "compactionManaged";
/** The marker (and the now-meaningless field) an earlier, broken version of this module wrote --
 * `compaction.modelOverrides` only exists in Pi's config under a different, unrelated area, so it was
 * never actually read by anything; cleaned up here, once, wherever it's found. */
const LEGACY_MARKER = "compactionManagedModels";
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

/** reserveTokens so compaction fires once `percent`% of a context window this size is used. */
export function reserveTokensFor(contextWindow, percent) {
	const window = Number(contextWindow) || 0;
	if (window <= 0) return null;
	return Math.max(MIN_RESERVE, Math.round(window * (1 - percent / 100)));
}

/** The smallest context window among the models actually available -- see the module comment for why. */
async function smallestContextWindow(runtime) {
	const windows = catalogueFor(runtime).map((m) => Number(m.contextWindow) || 0).filter((w) => w > 0);
	return windows.length ? Math.min(...windows) : 0;
}

/** Apply (or clear) the managed compaction keys in one profile's settings.json. Never touches anything else. */
function applyToProfile(dir, managed) {
	const path = join(dir, "settings.json");
	if (!existsSync(path)) return;
	const settings = readJsonSafe(path);
	const wasManaged = Boolean(settings.piper?.[MARKER]);
	const wasLegacyManaged = Boolean(settings.piper?.[LEGACY_MARKER]);
	if (!managed && !wasManaged && !wasLegacyManaged) return; // nothing to turn off, and nothing to turn on
	const compaction = { ...(settings.compaction ?? {}) };
	if (wasManaged) {
		delete compaction.reserveTokens;
		delete compaction.keepRecentTokens;
	}
	if (wasLegacyManaged) delete compaction.modelOverrides;
	if (managed) {
		if (compaction.enabled === undefined) compaction.enabled = true; // default on, never override an explicit hand-set value
		compaction.reserveTokens = managed.reserveTokens;
		if (managed.keepRecentTokens) compaction.keepRecentTokens = managed.keepRecentTokens;
	}
	if (Object.keys(compaction).length) settings.compaction = compaction;
	else delete settings.compaction;
	const piper = { ...(settings.piper ?? {}) };
	delete piper[LEGACY_MARKER];
	if (managed) piper[MARKER] = true;
	else delete piper[MARKER];
	if (Object.keys(piper).length) settings.piper = piper;
	else delete settings.piper;
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** Recompute and (re)write every profile's managed compaction settings from COMPACT_AT_PERCENT. */
export async function syncCompactionSettings({ runtime = null } = {}) {
	const root = profileRoot();
	if (!root || !existsSync(root)) return;
	const percent = Number(config.COMPACT_AT_PERCENT) || 0;
	let managed = null;
	if (percent > 0) {
		const window = await smallestContextWindow(runtime ?? (await modelRuntime()));
		const reserveTokens = reserveTokensFor(window, percent);
		if (reserveTokens !== null) managed = { reserveTokens, keepRecentTokens: Number(config.COMPACT_KEEP_RECENT_TOKENS) || 0 };
	}
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isDirectory()) applyToProfile(join(root, entry.name), managed);
	}
}
