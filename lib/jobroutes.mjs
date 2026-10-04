/**
 * HTTP for jobs.
 *
 *   /v1/piper/jobs                       POST   a client's asynchronous request (its key)
 *   /v1/piper/jobs/<id>                  GET    status and result;  DELETE  cancel      (the submitting key only)
 *   /v1/piper/jobs/<id>/trigger          POST   start a job, authorised by the job's own token, not an API key
 *   /dashboard/jobs…                     the Jobs page: list, create, change, run now, history, tokens
 */
import { bearerToken } from "./auth.mjs";
import { auditOnce } from "./audit.mjs";
import { readJson, sendError, sendJson } from "./http.mjs";
import { JobError, cancelRequest, cancelRun, clearTrigger, createJob, deleteJob, getJob, getRun, scheduledJobView, listJobs, MAX_PAYLOAD, listRuns, newTrigger, newWebhookSecret, queueRun, requestStatus, runView, submit, trigger, updateJob } from "./jobs.mjs";

export const TRIGGER_PATH = /^\/v1\/piper\/jobs\/(j[0-9a-f]{12})\/trigger$/;

const fail = (res, err) => {
	if (err instanceof JobError) return sendError(res, err.status, err.message, err.code, err.status === 401 ? "authentication_error" : err.status === 429 ? "rate_limit_error" : "invalid_request_error");
	return sendError(res, 400, err?.message ?? String(err));
};

/** A request body as text, at most `limit` bytes (the rest is cut, not refused: a webhook sender cannot be asked to shrink). */
function readText(req, limit) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			if (size < limit) chunks.push(chunk.subarray(0, limit - size));
			size += chunk.length;
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => resolve(""));
	});
}

/** The trigger endpoint, reached before the API-key check: the job's token is the credential. Returns true when handled. */
export async function triggerRoute(req, res, path) {
	const match = TRIGGER_PATH.exec(path);
	if (!match) return false;
	if (req.method !== "POST") return sendError(res, 405, "POST to trigger a job"), true;
	try {
		const body = await readText(req, MAX_PAYLOAD);
		const run = trigger(match[1], bearerToken(req) || String(req.headers["x-piper-token"] ?? ""), body);
		sendJson(res, 202, { run: run.id, status: run.status, note: run.error });
	} catch (err) {
		if (err instanceof JobError && err.status === 404) auditOnce(`jobtrigger:${req.socket?.remoteAddress}`, 60_000, "authfail.api", req.socket?.remoteAddress ?? "unknown", `POST ${path} (a job trigger with no valid token)`);
		fail(res, err);
	}
	return true;
}

/** `/v1/piper/jobs…` for an API key. */
export async function jobApiRoutes(req, res, path) {
	if (!req.credential?.id) return sendError(res, 401, "Jobs need an API key", "invalid_api_key", "authentication_error");
	const rest = path.slice("/v1/piper/jobs".length);
	try {
		if (rest === "" && req.method === "POST") {
			const body = await readJson(req);
			const made = submit(req.credential, body);
			return sendJson(res, 202, { id: made.id, status: made.status, ...(made.webhookSecret ? { webhook_secret: made.webhookSecret } : {}) });
		}
		const match = /^\/(j[0-9a-f]{12})$/.exec(rest);
		if (match && req.method === "GET") return sendJson(res, 200, requestStatus(req.credential, match[1]));
		if (match && req.method === "DELETE") return sendJson(res, 200, { cancelled: cancelRequest(req.credential, match[1]) });
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return fail(res, err);
	}
}

/** `/dashboard/jobs…`. The caller has checked the dashboard cookie. */
export async function jobDashboardRoutes(req, res, path) {
	const rest = path.slice("/dashboard/jobs".length);
	try {
		if (rest === ".json" && req.method === "GET") return sendJson(res, 200, { jobs: listJobs() });
		if (rest === "" && req.method === "POST") {
			const b = await readJson(req);
			const made = createJob({ keyId: b.keyId, agentId: b.agentId || null, name: b.name, prompt: b.prompt, model: b.model, schedule: b.schedule, sessionMode: b.sessionMode || "fresh", webhookUrl: b.webhookUrl, timeoutMs: b.timeoutMs, enabled: b.enabled !== false, notify: b.notify, dailyCostCap: b.dailyCostCap });
			return sendJson(res, 201, { job: made.job, webhookSecret: made.webhookSecret });
		}
		let match = /^\/runs\/(\d+)(?:\/(cancel))?$/.exec(rest);
		if (match) {
			const run = getRun(match[1]);
			if (!run) return sendError(res, 404, "No such run", "not_found");
			if (match[2] === "cancel" && req.method === "POST") return sendJson(res, 200, { cancelled: cancelRun(run.id) });
			if (req.method === "GET") return sendJson(res, 200, { run: runView(run, { full: true }) });
		}
		match = /^\/(j[0-9a-f]{12})(?:\/([a-z-]+))?$/.exec(rest);
		if (!match) return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
		const [, id, action] = match;
		if (!getJob(id)) return sendError(res, 404, "No such job", "not_found");
		if (!action && req.method === "GET") return sendJson(res, 200, { job: scheduledJobView(getJob(id)) });
		if (!action && req.method === "PATCH") {
			const b = await readJson(req);
			return sendJson(res, 200, updateJob(id, b));
		}
		if (!action && req.method === "DELETE") return sendJson(res, 200, { deleted: deleteJob(id) });
		if (action === "runs" && req.method === "GET") return sendJson(res, 200, { runs: listRuns(id, new URL(req.url, "http://x").searchParams.get("limit")) });
		if (action === "run" && req.method === "POST") return sendJson(res, 202, { run: queueRun(id, "manual") });
		if (action === "trigger" && req.method === "POST") return sendJson(res, 200, { token: newTrigger(id), path: `/v1/piper/jobs/${id}/trigger` });
		if (action === "trigger" && req.method === "DELETE") return clearTrigger(id), sendJson(res, 200, { revoked: true });
		if (action === "webhook-secret" && req.method === "POST") return sendJson(res, 200, { secret: newWebhookSecret(id) });
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return fail(res, err);
	}
}


