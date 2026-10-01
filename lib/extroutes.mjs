/**
 * Dashboard routes for the extension library and who gets what.
 *
 *   GET  /dashboard/extensions.json                        the library, every key and agent with its list and what it gets, the job
 *   POST /dashboard/extensions/install  {source, name?, allowScripts?}
 *   POST /dashboard/extensions/update   {name}
 *   POST /dashboard/extensions/remove   {name, force?}
 *   POST /dashboard/extensions/access   {level: "default"|"key"|"agent", id, list}   list: blank follows the level above
 *
 * Installing puts third-party code on this host and into containers, and grants decide which agents run it: every change needs a
 * dashboard password.
 */
import { config } from "./settings.mjs";
import { apiKeys, dashboardHash, keyLabel } from "./auth.mjs";
import { agents, agentScope } from "./agents.mjs";
import { audit } from "./audit.mjs";
import { readJson, sendError, sendJson } from "./http.mjs";
import { bundleListFromInput, grantedBundles, listShared } from "./profiles.mjs";
import { sessions } from "./sessions.mjs";
import { ExtensionError, extensionJobView, installExtension, libraryOverview, removeExtension, updateExtension } from "./extlib.mjs";
import { saveSettings } from "./dashboard.mjs";

const names = (list) => list.map((b) => b.name);

/** What the Access matrix needs: the items, and for the default, each key and each agent its own list and its effective result. */
export function extensionsPayload() {
	return {
		enabled: Boolean(config.EXTENSIONS_ENABLED),
		passwordSet: Boolean(dashboardHash),
		library: libraryOverview(),
		items: listShared().map((b) => ({ name: b.name, kind: b.kind })),
		default: config.SHARED_BUNDLES ?? "",
		keys: apiKeys.list().map((k) => ({
			id: k.id,
			name: k.name,
			list: k.sharedBundles ?? null,
			effective: names(grantedBundles(k.id)),
			agents: agents.listByKey(k.id).map((a) => ({ id: a.id, name: a.name, list: a.sharedBundles ?? null, effective: names(grantedBundles(agentScope(k.id, a.id))) })),
		})),
		job: extensionJobView(),
	};
}

/** Set a grant list at one level and make the affected live chats pick it up (they stop and resume on their next message). */
export async function setAccess({ level, id, list }) {
	const value = bundleListFromInput(list);
	if (level === "default") {
		await saveSettings({ SHARED_BUNDLES: value ?? "" });
		audit("key.extensions", "default", `SHARED_BUNDLES = ${value === null || value === "" ? "none" : value}`);
		for (const key of apiKeys.list()) if (key.sharedBundles == null) sessions.closeByKey(key.id);
		return;
	}
	if (level === "key") {
		if (!apiKeys.get(id)) throw new ExtensionError("no such key", 404);
		apiKeys.update(id, { sharedBundles: value });
		sessions.closeByKey(id);
		audit("key.extensions", keyLabel(id), value === null ? "follows the default" : value === "" ? "none" : value);
		return;
	}
	if (level === "agent") {
		const agent = agents.get(id);
		if (!agent) throw new ExtensionError("no such agent", 404);
		agents.update(id, { sharedBundles: value });
		sessions.closeByScope(agentScope(agent.keyId, agent.id));
		audit("key.extensions", `${keyLabel(agent.keyId)} / ${agent.name}`, value === null ? "follows its key" : value === "" ? "none" : value);
		return;
	}
	throw new ExtensionError("level is default, key or agent");
}

/** `/dashboard/extensions…`. Returns true when the path was ours. */
export async function extensionRoutes(req, res, path) {
	if (path === "/dashboard/extensions.json" && req.method === "GET") return sendJson(res, 200, extensionsPayload()), true;
	const match = /^\/dashboard\/extensions\/(install|update|remove|access)$/.exec(path);
	if (!match) return false;
	if (req.method !== "POST") return sendError(res, 405, "POST to change the extension library"), true;
	if (!dashboardHash) return sendError(res, 403, "Changing extensions needs a dashboard password: they are third-party code that agents run. Set one under Settings → Access first.", "forbidden"), true;
	try {
		const b = await readJson(req).catch(() => ({}));
		if (match[1] === "install") return sendJson(res, 202, { job: installExtension({ source: b.source, name: b.name, allowScripts: b.allowScripts === true }) }), true;
		if (match[1] === "update") return sendJson(res, 202, { job: updateExtension(b.name) }), true;
		if (match[1] === "remove") {
			await removeExtension(String(b.name ?? ""), { force: b.force === true });
			return sendJson(res, 200, extensionsPayload()), true;
		}
		await setAccess({ level: b.level, id: b.id, list: b.list });
		return sendJson(res, 200, extensionsPayload()), true;
	} catch (err) {
		if (err instanceof ExtensionError) return sendError(res, err.status, err.message, err.status === 403 ? "forbidden" : err.status === 409 ? "conflict" : "invalid_request_error"), true;
		return sendError(res, 400, err?.message ?? String(err)), true;
	}
}
