/** Small HTTP helpers shared by the route handlers. */
import { resolve } from "node:path";
import { config } from "./settings.mjs";
import { bearerToken, isSettingsKey } from "./auth.mjs";

export function sendJson(res, status, value) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(value));
}

/** One line per request. Session ids are never logged, only their fingerprint. */
export function logAccess(req, status, note) {
	if (!config.ACCESS_LOG) return;
	process.stderr.write(`${new Date().toISOString()} ${req.method} ${status} ${req.url}${note ? ` ${note}` : ""}\n`);
}

export function cors(res) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Session-Id, X-Conversation-Id");
	res.setHeader("Access-Control-Expose-Headers", "X-Session-Id");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
}

export function sendError(res, status, message, code = "invalid_request_error", type = "invalid_request_error") {
	if (res.headersSent) return res.end();
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: { message, type, param: null, code } }));
}

export function readJson(req, limit = config.BODY_LIMIT) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

/**
 * Whether the settings key was presented. This no longer answers "is auth off" — that is
 * authRequired() — and it is false when no settings key is configured, because the only caller is
 * the dashboard guard and only a real key should open it.
 */
export function authorized(req) {
	return isSettingsKey(bearerToken(req));
}
