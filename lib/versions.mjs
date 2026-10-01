/** Comparing Pi versions. No imports, so anything may use it without a cycle. */

/** a > b for plain dotted versions (a pre-release suffix counts as older than the same release). */
export function versionNewer(a, b) {
	const parts = (v) => String(v).split("-")[0].split(".").map((n) => Number(n) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return String(a).includes("-") === false && String(b).includes("-");
}

/**
 * How a container's Pi compares with the one the gateway runs:
 *   current   the same version
 *   outdated  older than the gateway's (update it)
 *   ahead     newer than the gateway's (the RPC protocol may differ)
 *   unknown   one of the two is not known
 */
export function piStatus(version, host) {
	if (!version || !host) return "unknown";
	if (version === host) return "current";
	return versionNewer(host, version) ? "outdated" : "ahead";
}
