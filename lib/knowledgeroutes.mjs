/** `/dashboard/knowledge…`: every source with entries, one source's entries, one entry's detail, and
 * deleting/clearing. The caller has checked the dashboard cookie. The agent-facing tools
 * (lib/knowledge.mjs's `knowledgeFor`, through the bridge) never reach this file — it is the
 * operator's view only. A source ref of "-" in the URL stands for a null `sourceRef`. */
import { sendError, sendJson } from "./http.mjs";
import { audit } from "./audit.mjs";
import { clearSource, entriesOf, getEntry, overview, removeEntry } from "./knowledge.mjs";

const unref = (ref) => (ref === "-" ? null : ref);

export async function knowledgeDashboardRoutes(req, res, path) {
	const rest = path.slice("/dashboard/knowledge".length);
	try {
		if (rest === ".json" && req.method === "GET") {
			return sendJson(res, 200, { sources: overview() }, { noStore: true });
		}
		let match = /^\/([^/]+)\/([^/]+)\/(\d+)$/.exec(rest);
		if (match) {
			const [, sourceType, sourceRefRaw, id] = match;
			const entry = getEntry(id);
			if (!entry || entry.sourceType !== sourceType || entry.sourceRef !== unref(sourceRefRaw)) return sendError(res, 404, "No such entry", "not_found");
			if (req.method === "GET") return sendJson(res, 200, { entry }, { noStore: true });
			if (req.method === "DELETE") {
				const deleted = removeEntry(id);
				if (deleted) audit("knowledge.delete", `${sourceType}/${sourceRefRaw}`, entry.title ?? String(id));
				return sendJson(res, 200, { deleted });
			}
		}
		match = /^\/([^/]+)\/([^/]+)$/.exec(rest);
		if (match) {
			const [, sourceType, sourceRefRaw] = match;
			const sourceRef = unref(sourceRefRaw);
			if (req.method === "GET") return sendJson(res, 200, { sourceType, sourceRef, entries: entriesOf(sourceType, sourceRef) }, { noStore: true });
			if (req.method === "DELETE") {
				const cleared = clearSource(sourceType, sourceRef);
				if (cleared) audit("knowledge.clear", `${sourceType}/${sourceRefRaw}`, `${cleared} entry(ies)`);
				return sendJson(res, 200, { cleared });
			}
		}
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 400, err?.message ?? String(err));
	}
}
