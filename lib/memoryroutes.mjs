/** `/dashboard/memory…`: every scope that has notes, one scope's notes, and clearing them. The caller has
 * checked the dashboard cookie. The agent's own tools (lib/agentmemory.mjs, through the bridge) never
 * reach this file — it is the operator's view only. */
import { keyLabel } from "./auth.mjs";
import { readJson, sendError, sendJson } from "./http.mjs";
import { audit } from "./audit.mjs";
import { clearMemory, deleteMemoryEntry, memoryEntries, memoryOverview } from "./agentmemory.mjs";

export async function memoryDashboardRoutes(req, res, path) {
	const rest = path.slice("/dashboard/memory".length);
	try {
		if (rest === ".json" && req.method === "GET") {
			return sendJson(res, 200, { scopes: memoryOverview().map((s) => ({ ...s, label: keyLabel(s.scope) })) }, { noStore: true });
		}
		const match = /^\/([^/]+)(?:\/(delete))?$/.exec(rest);
		if (!match) return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
		const [, scope, action] = match;
		if (!action && req.method === "GET") {
			return sendJson(res, 200, { scope, label: keyLabel(scope), entries: memoryEntries(scope) }, { noStore: true });
		}
		if (!action && req.method === "DELETE") {
			const cleared = clearMemory(scope);
			if (cleared) audit("memory.clear", keyLabel(scope), `${cleared} note(s)`);
			return sendJson(res, 200, { cleared });
		}
		if (action === "delete" && req.method === "POST") {
			const { name } = await readJson(req);
			const deleted = deleteMemoryEntry(scope, String(name ?? ""));
			if (deleted) audit("memory.delete", keyLabel(scope), String(name ?? ""));
			return sendJson(res, 200, { deleted });
		}
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 400, err?.message ?? String(err));
	}
}
