/** `/dashboard/rss…`: the Feeds tab — list, create, change, pull now, delete — and retrying a failed
 * extraction (an RSS-specific action, so it lives here rather than in lib/knowledgeroutes.mjs). The
 * caller has checked the dashboard cookie. */
import { readJson, sendError, sendJson } from "./http.mjs";
import { createFeed, forcePoll, listFeeds, removeFeed, retryEntry, RssError, updateFeed } from "./rssfeeds.mjs";

const fail = (res, err) => {
	if (err instanceof RssError) return sendError(res, err.status, err.message, "invalid_request");
	return sendError(res, 400, err?.message ?? String(err));
};

export async function rssDashboardRoutes(req, res, path) {
	const rest = path.slice("/dashboard/rss".length);
	try {
		if (rest === ".json" && req.method === "GET") return sendJson(res, 200, { feeds: listFeeds() }, { noStore: true });
		if (rest === "" && req.method === "POST") {
			const b = await readJson(req);
			return sendJson(res, 201, { feed: createFeed({ name: b.name, url: b.url, agentId: b.agentId || null, intervalMs: b.intervalMs }) });
		}
		let match = /^\/entries\/(\d+)\/retry$/.exec(rest);
		if (match && req.method === "POST") return sendJson(res, 200, { retried: retryEntry(match[1]) });
		match = /^\/([^/]+)(?:\/(pull))?$/.exec(rest);
		if (!match) return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
		const [, id, action] = match;
		if (!action && req.method === "PATCH") {
			const b = await readJson(req);
			return sendJson(res, 200, { feed: updateFeed(id, { name: b.name, url: b.url, agentId: b.agentId, intervalMs: b.intervalMs, enabled: b.enabled }) });
		}
		if (!action && req.method === "DELETE") return sendJson(res, 200, { deleted: removeFeed(id) });
		if (action === "pull" && req.method === "POST") return sendJson(res, 202, { feed: await forcePoll(id) });
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return fail(res, err);
	}
}
