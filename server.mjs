#!/usr/bin/env node
/**
 * OpenAI-compatible gateway for the Pi coding agent (https://pi.dev).
 *
 *   POST /v1/chat/completions   streaming + non-streaming
 *   GET  /v1/models
 *   GET  /health
 *
 * One Pi agent per session id, never shared between ids: by default a separate `pi --mode rpc`
 * process inside a sandbox (RUNNER), with the API key's own profile of skills, extensions and
 * settings, and no credentials — model calls come back here over a socket. Send `X-Session-Id`
 * (or `session_id`) to continue a chat; omit it and the gateway mints a fresh
 * isolated session and returns the id in the `X-Session-Id` response header.
 * Sessions are held until the 24h lifetime cap, the idle timeout, or a count cap,
 * whichever comes first, then disposed.
 *
 * Requests forward only the *new* user turn, so Pi keeps its own context/history and
 * its tools (read/bash/edit/write) run server-side. Tool activity is not surfaced as
 * OpenAI tool_calls: the caller gets the agent's text back.
 *
 * Image parts (image_url / input_image) are forwarded to Pi as attachments.
 * Pi has no audio input type, so audio parts are rejected as unsupported.
 *
 *   node server.mjs
 *
 * Settings live in SQLite (GATEWAY_DB, default ./gateway.db) and are editable at
 * /dashboard#settings. GATEWAY_DB is the only environment variable that still matters;
 * every other knob seeds from its env var on first run and the database wins after that.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { GATEWAY_DB, agentCwd, config } from "./lib/settings.mjs";
import { authNote, authRequired, clearSessionCookie, credentialOf, dashboardAuthorized, dashboardHash, isDashboardPath } from "./lib/auth.mjs";
import { sandboxLimiter } from "./lib/sandbox.mjs";
import { reloadModelRuntime } from "./lib/models.mjs";
import { cors, logAccess, readJson, sendError } from "./lib/http.mjs";
import { filesRoutes, keyIdForScope, migrateProfileDefaults, profileAdminRoutes, profileRoutes } from "./lib/profiles.mjs";
import { sessions, spendReport } from "./lib/sessions.mjs";
import { chatCompletions, listModels } from "./lib/chat.mjs";
import { LOGIN_PAGE, apiKeyRoutes, dashboardLogin, dashboardPage, dashboardSetPassword, modelCatalog, saveSettings, settingsPayload } from "./lib/dashboard.mjs";

// Everything the modules export, re-exported: the tests, and anyone embedding the gateway, import
// from here.
export * from "./lib/settings.mjs";
export * from "./lib/auth.mjs";
export * from "./lib/sandbox.mjs";
export * from "./lib/models.mjs";
export * from "./lib/http.mjs";
export * from "./lib/profiles.mjs";
export * from "./lib/runner.mjs";
export * from "./lib/sessions.mjs";
export * from "./lib/chat.mjs";
export * from "./lib/dashboard.mjs";

// ------------------------------------------------------------------- server

export const server = http.createServer(async (req, res) => {
	cors(res);
	res.on("finish", () => logAccess(req, res.statusCode, res.sessionNote));
	try {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		const path = new URL(req.url, "http://localhost").pathname;
		if (req.method === "GET" && (path === "/health" || path === "/")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ status: "ok", cwd: agentCwd(), sessions: sessions.stats() }));
		}
		// The dashboard has its own guard, so an unauthenticated browser gets a sign-in page it can
		// answer instead of a 401 it cannot. /v1/* keeps the API key check to itself.
		const isDashboard = isDashboardPath(path);
		// Resolved once, so the log line and the session record both know which key was used.
		req.credential = credentialOf(req);
		if (!isDashboard && authRequired() && !req.credential) {
			return sendError(res, 401, "Invalid API key", "invalid_api_key", "authentication_error");
		}
		if (req.method === "POST" && path === "/dashboard/login") return await dashboardLogin(req, res);
		if (req.method === "POST" && path === "/dashboard/logout") {
			clearSessionCookie(res);
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify({ ok: true }));
		}
		if (isDashboard && !dashboardAuthorized(req)) {
			// The page itself invites a sign-in; every other route says why it refused.
			if (req.method === "GET" && path === "/dashboard") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				return res.end(LOGIN_PAGE);
			}
			return sendError(res, 401, "Dashboard is locked", "dashboard_locked", "authentication_error");
		}
		if (req.method === "POST" && path === "/dashboard/password") return await dashboardSetPassword(req, res);
		if (path.startsWith("/dashboard/api-keys")) return await apiKeyRoutes(req, res, path);
		if (path === "/dashboard/profiles.json" || path.startsWith("/dashboard/profiles/")) return await profileAdminRoutes(req, res, path);
		const filesMatch = /^\/dashboard\/files\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(path);
		if (filesMatch) {
			const keyId = keyIdForScope(filesMatch[1]);
			if (keyId === undefined) return sendError(res, 404, `No profile ${filesMatch[1]}`, "not_found");
			return await filesRoutes(req, res, keyId, filesMatch[2] ?? "");
		}
		if (req.method === "GET" && path === "/dashboard/models.json") return await modelCatalog(res);
		if (req.method === "POST" && path === "/dashboard/models/reload") {
			await reloadModelRuntime();
			return await modelCatalog(res);
		}
		if (req.method === "GET" && path === "/dashboard/spend.json") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(await spendReport()));
		}
		if (req.method === "GET" && path === "/dashboard/settings.json") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(settingsPayload()));
		}
		if (req.method === "POST" && path === "/dashboard/settings") {
			let result;
			try {
				const body = await readJson(req);
				result = await saveSettings(body.settings ?? {});
			} catch (err) {
				// Validation failures are the client's fault, so report them as such.
				return sendError(res, 400, err?.message ?? String(err), "invalid_request_error", "invalid_request_error");
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ ...settingsPayload(), ...result }));
		}
		if (req.method === "GET" && path === "/dashboard.json") {
			const snapshot = await sessions.snapshot();
			// The page polls this anyway, so the sidebar learns for free whether to offer a sign-out.
			snapshot.passwordSet = Boolean(dashboardHash);
			// The sandbox is a switch, and a switch that is off fails silently: a session then reads the
			// whole filesystem, including this gateway's own database. The page shows that state loudly.
			// The sandboxed runners are always confined; only the in-process runner depends on the jail.
			const inProcess = config.RUNNER === "inprocess";
			snapshot.runner = config.RUNNER;
			snapshot.jail = !inProcess || Boolean(config.WORKSPACE_JAIL);
			snapshot.jailNote = !snapshot.jail
				? "WORKSPACE_JAIL is off, so sessions run unsandboxed: bash is not confined and the file " +
					"tools are not path-checked. An agent can read this gateway's database and your home directory."
				: "";
			// A sandbox without limits can take the whole machine's memory or processes with it.
			const limiter = config.RUNNER === "bwrap" ? sandboxLimiter() : null;
			snapshot.limitsNote =
				limiter && (limiter.error || limiter.note?.startsWith("none"))
					? `${limiter.error ?? "systemd scopes are unavailable here"}, so one session can use all of this machine's memory, processes and CPU. Run under systemd, or use a container runner.`
					: "";
			snapshot.runnerNote = inProcess
				? "RUNNER is inprocess: every session shares this gateway's process and your ~/.pi/agent, and the file " +
					"tools are guarded by a path check rather than a sandbox. Use it only for yourself."
				: "";
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(snapshot));
		}
		if (req.method === "DELETE" && path.startsWith("/dashboard/session/")) {
			const closed = sessions.closeByFingerprint(path.slice("/dashboard/session/".length));
			res.writeHead(closed ? 200 : 404, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ closed }));
		}
		if (req.method === "POST" && path === "/dashboard/kill-all") {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ closed: sessions.closeAll() }));
		}
		if (req.method === "GET" && path === "/dashboard") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(dashboardPage());
		}
		if (req.method === "GET" && path === "/v1/models") return await listModels(res, req.credential);
		if (path === "/v1/piper/profile" || path.startsWith("/v1/piper/profile/")) return await profileRoutes(req, res, path);
		// A key's own shared folder, and the operator's view of any key's.
		if (path === "/v1/piper/files" || path.startsWith("/v1/piper/files/")) {
			return await filesRoutes(req, res, req.credential ? req.credential.id : null, path.slice("/v1/piper/files".length));
		}
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			return await chatCompletions(req, res, await readJson(req));
		}
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 500, err?.message ?? String(err), "server_error", "server_error");
	}
});

export const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
/**
 * Why the gateway should not start as root, or null when it may.
 *
 * The sandbox holds without root privileges, but as root its user namespace maps back to uid 0, so
 * anything root-owned that the masks miss is readable by the session that owns it. A dedicated
 * unprivileged user is what makes "the masks missed a path" a non-event rather than a leak.
 */
export function rootRefusal(uid = process.getuid?.(), env = process.env) {
	if (uid !== 0) return null;
	if (/^(1|true|yes|on)$/i.test(String(env.ALLOW_ROOT ?? ""))) return null;
	return (
		"refusing to run as root: sessions run commands on your behalf, and as root anything the sandbox " +
		"fails to mask is readable by them. Run as a dedicated user, or set ALLOW_ROOT=1 to accept the risk.\n"
	);
}

if (isMain) {
	const refusal = rootRefusal();
	if (refusal) {
		process.stderr.write(refusal);
		process.exit(1);
	}
	// A restart hibernates every chat instead of dropping it: each one's spend is written to the
	// ledger, its agent stopped, and its workspace and Pi session kept for the next message.
	let stopping = false;
	const shutdown = async (signal) => {
		if (stopping) return;
		stopping = true;
		process.stderr.write(`${signal}: hibernating ${sessions.size} chat(s)\n`);
		server.close();
		const deadline = setTimeout(() => process.exit(0), 5000);
		deadline.unref?.();
		await sessions.hibernateAll().catch(() => {});
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
	server.listen(config.PORT, config.HOST, () => {
		void migrateProfileDefaults().then((n) => n && process.stderr.write(`profiles now follow the default model: ${n} migrated\n`), () => {});
		process.stderr.write(
			`Piper on http://${config.HOST}:${config.PORT}  cwd=${agentCwd()}  ` +
				`auth=${authNote()}  ` +
				`dashboard=${dashboardHash ? "password" : "open"}  ` +
				`runner=${config.RUNNER}  ` +
				`${config.RUNNER === "bwrap" ? `limits=${sandboxLimiter().note ?? "unavailable"}  ` : ""}` +
				`jail=${config.RUNNER !== "inprocess" || config.WORKSPACE_JAIL ? "on" : "OFF"}  sandbox-net=${config.SANDBOX_NETWORK}  ` +
				`${process.getuid?.() === 0 ? "user=ROOT  " : ""}db=${GATEWAY_DB}\n`,
		);
	});
}
