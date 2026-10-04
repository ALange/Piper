/**
 * Dashboard routes for shared bundles and for Pi packages and MCP servers.
 *
 *   /dashboard/bundles.json, POST /dashboard/bundles, DELETE /dashboard/bundles/<name>     list, create, delete
 *   /dashboard/bundlefiles/<name>/<path>                                                   the file browser over one bundle
 *   /dashboard/packages/<scope>.json, POST /dashboard/packages/<scope>/<action>            packages and MCP of a profile
 *   /dashboard/packages/job.json                                                           the running or last job
 *
 * Bundles are run by every key that is granted them, as code; packages and MCP servers install third-party code. All
 * changes need a dashboard password, like the terminal and the host Pi update.
 */
import { config } from "./settings.mjs";
import { apiKeys, dashboardHash } from "./auth.mjs";
import { ownerKeyOf, agents, agentIdOf } from "./agents.mjs";
import { readJson, sendError, sendJson } from "./http.mjs";
import { ProfileError, bundleOverview, createBundle, dashboardFilesRoutes, deleteBundle, keyIdForScope } from "./profiles.mjs";
import { PackageError, addMcp, installPackage, listMcp, listPackages, packageJobView, removeMcp, removePackage, setMcpEnabled, testMcp, updatePackages } from "./pipackages.mjs";
import { containerSettingsFor } from "./keycontainer.mjs";
import { keyLabel } from "./auth.mjs";

const json = (res, status, body) => sendJson(res, status, body, { noStore: true });

const needPassword = (res, what) => {
	if (dashboardHash) return false;
	sendError(res, 403, `${what} needs a dashboard password: it changes code that agents run. Set one under Settings → Access first.`, "forbidden");
	return true;
};

/** `/dashboard/bundles…` and `/dashboard/bundlefiles/…`. Returns true when the path was ours. */
export async function bundleRoutes(req, res, path) {
	try {
		if (path === "/dashboard/bundles.json" && req.method === "GET") return json(res, 200, bundleOverview()), true;
		if (path === "/dashboard/bundles" && req.method === "POST") {
			if (needPassword(res, "Creating a bundle")) return true;
			const { name } = await readJson(req);
			createBundle(name);
			return json(res, 201, bundleOverview()), true;
		}
		const del = /^\/dashboard\/bundles\/([^/]+)$/.exec(path);
		if (del && req.method === "DELETE") {
			if (needPassword(res, "Deleting a bundle")) return true;
			await deleteBundle(decodeURIComponent(del[1]), { force: new URL(req.url, "http://x").searchParams.get("force") === "1" });
			return json(res, 200, bundleOverview()), true;
		}
		const files = /^\/dashboard\/bundlefiles\/([^/]+)(\/.*)?$/.exec(path);
		if (files) {
			// Reading is for the signed-in operator; any change is code every granted key will run.
			if (req.method !== "GET" && needPassword(res, "Changing a bundle")) return true;
			await dashboardFilesRoutes(req, res, decodeURIComponent(files[1]), files[2] ?? "", { shared: true });
			return true;
		}
	} catch (err) {
		if (err instanceof ProfileError) return sendError(res, err.status, err.message, err.status === 409 ? "conflict" : "invalid_request_error"), true;
		throw err;
	}
	return false;
}

/** The scope id a `/dashboard/packages/<scope>` path names, if it is a real key or agent. */
function scopeOf(segment) {
	const id = keyIdForScope(segment);
	if (!id) return null;
	if (!apiKeys.get(ownerKeyOf(id))) return null;
	const agentId = agentIdOf(id);
	if (agentId && !agents.get(agentId)) return null;
	return id;
}

/** `/dashboard/packages/…`. Returns true when the path was ours. */
export async function packageRoutes(req, res, path) {
	if (path === "/dashboard/packages/job.json" && req.method === "GET") return json(res, 200, { job: packageJobView() }), true;
	const match = /^\/dashboard\/packages\/([A-Za-z0-9_-]+?)(?:\.json|\/([a-z-]+))$/.exec(path);
	if (!match) return false;
	const scope = scopeOf(match[1]);
	if (!scope) return sendError(res, 404, "No such key or agent", "not_found"), true;
	const action = match[2];
	try {
		if (!action && req.method === "GET") {
			const eff = containerSettingsFor(scope);
			return json(res, 200, {
				scope: match[1],
				label: keyLabel(scope),
				enabled: Boolean(config.PACKAGES_ENABLED),
				passwordSet: Boolean(dashboardHash),
				network: eff.network ?? config.CONTAINER_NETWORK,
				packages: await listPackages(scope),
				mcp: await listMcp(scope),
				job: packageJobView(),
			}), true;
		}
		if (req.method !== "POST" || !action) return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found"), true;
		if (needPassword(res, "Installing packages and MCP servers")) return true;
		const b = await readJson(req).catch(() => ({}));
		const answer = {
			install: () => installPackage(scope, b.source),
			remove: () => removePackage(scope, b.source),
			update: () => updatePackages(scope),
			"mcp-add": () => addMcp(scope, b),
			"mcp-remove": () => removeMcp(scope, b.name),
			"mcp-test": () => testMcp(scope),
		}[action];
		if (action === "mcp-enable") return json(res, 200, await setMcpEnabled(scope, b.name, b.enabled !== false)), true;
		if (!answer) return sendError(res, 404, `Unknown action: ${action}`, "not_found"), true;
		return json(res, 202, { job: answer() }), true;
	} catch (err) {
		if (err instanceof PackageError || err instanceof ProfileError) return sendError(res, err.status, err.message, err.status === 403 ? "forbidden" : err.status === 409 || err.status === 423 ? "conflict" : "invalid_request_error"), true;
		throw err;
	}
}
