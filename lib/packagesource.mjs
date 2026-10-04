/**
 * What a package or extension source may look like: `npm:<name>[@version]`, `git:<host>/<owner>/<repo>[@ref]`
 * or `https://<host>/<owner>/<repo>[@ref]`. Shared by the extension library (lib/extlib.mjs) and a key's or
 * agent's own Pi packages (lib/pipackages.mjs), which both run a host install from exactly this and so both
 * need the same ceiling on what reaches npm or git's command line.
 */
const NPM_SOURCE = /^npm:(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9^~<>=][A-Za-z0-9._~^<>=|*-]*)?$/;
const GIT_SOURCE = /^git:[A-Za-z0-9][A-Za-z0-9._~-]*(?:\.[A-Za-z0-9._~-]+)+\/[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._~/-]+)?$/;
const HTTPS_SOURCE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\.[A-Za-z0-9._~-]+)+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._~/-]+)?$/;

/**
 * The trimmed, valid source, or a reason it is refused (never throws): `{ok: true, source}` or `{ok: false,
 * reason}`. The caller wraps `reason` in whichever error class (and wording) fits where it is checked.
 */
export function checkPackageSource(text) {
	const source = String(text ?? "").trim();
	if (!source) return { ok: false, reason: "name a package: npm:<name>, git:<host>/<owner>/<repo> or an https:// repository" };
	if (source.length > 200) return { ok: false, reason: "that package source is too long" };
	if (source.includes("..")) return { ok: false, reason: "that is not a package source" };
	if (!(NPM_SOURCE.test(source) || GIT_SOURCE.test(source) || HTTPS_SOURCE.test(source))) {
		return { ok: false, reason: "a package source is npm:<name>[@version], git:<host>/<owner>/<repo>[@ref] or https://<host>/<owner>/<repo>[@ref]" };
	}
	return { ok: true, source };
}
