#!/usr/bin/env node
/**
 * OpenAI-compatible gateway for the Pi coding agent (https://pi.dev).
 *
 *   POST /v1/chat/completions   streaming + non-streaming
 *   GET  /v1/models
 *   GET  /health
 *
 * One Pi agent per session id, never shared between ids: a separate `pi --mode rpc` in its own
 * Docker container, where Pi is a stock install with full privileges. The container is the
 * sandbox: the gateway decides what it can reach (the API key's workspace and profile, a network
 * that stops at the internet, resource limits), not what Pi does inside. Models the gateway holds
 * credentials for are served over a socket; models configured for containers are called directly.
 * Send `X-Session-Id`
(or `session_id`) to continue a chat; omit it and the gateway mints a fresh
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
import { GATEWAY_DB, config } from "./lib/settings.mjs";
import { authNote, authRequired, clearSessionCookie, credentialOf, dashboardAuthorized, dashboardHash, isDashboardPath } from "./lib/auth.mjs";
import { checkEngine, inspectMany, lastEngineStatus } from "./lib/engine.mjs";
import { diskSummary, engineOptions, hostPiVersion, migrateToContainers, startDiskWatch, startEventWatch } from "./lib/containers.mjs";
import { reloadModelRuntime } from "./lib/models.mjs";
import { cors, logAccess, readJson, sendError } from "./lib/http.mjs";
import { audit, auditOnce, runWithActor } from "./lib/audit.mjs";
import { resourceSnapshot } from "./lib/resources.mjs";
import { piVersionsFor } from "./lib/piversions.mjs";
import { aboutInfo, readPackage } from "./lib/about.mjs";
import { speedHistory } from "./lib/speed.mjs";
import { terminalUpgrade } from "./lib/terminalroutes.mjs";
import { vendorFile } from "./lib/vendor.mjs";
import { closeAllTerminals } from "./lib/terminal.mjs";
import { pageIndex, renderPage, searchDocs } from "./lib/docs.mjs";
import { piStatus } from "./lib/versions.mjs";
import { liveRoutes } from "./lib/liveroutes.mjs";
import { bundleRoutes, packageRoutes } from "./lib/bundleroutes.mjs";
import { extensionRoutes } from "./lib/extroutes.mjs";
import { playgroundRoutes } from "./lib/playground.mjs";
import { jobApiRoutes, jobDashboardRoutes, triggerRoute } from "./lib/jobroutes.mjs";
import { memoryDashboardRoutes } from "./lib/memoryroutes.mjs";
import { knowledgeDashboardRoutes } from "./lib/knowledgeroutes.mjs";
import { rssDashboardRoutes } from "./lib/rssroutes.mjs";
import { startJobs, stopJobs } from "./lib/jobs.mjs";
import { startFeeds, stopFeeds } from "./lib/rssfeeds.mjs";
import { startImageHousekeeping } from "./lib/images.mjs";
import { startTeamServers, stopTeamServers } from "./lib/teams.mjs";
import { dashboardFilesRoutes, filesRoutes, keyIdForScope, profileAdminRoutes, profileRoutes } from "./lib/profiles.mjs";
import { sessions, spendReport, startSweeps } from "./lib/sessions.mjs";
import { chatCompletions, listModels } from "./lib/chat.mjs";
import { startAgentServers, stopAgentServers } from "./lib/agentservers.mjs";
import { portalPort, startPortal, stopPortal } from "./lib/portal.mjs";
import { LOGIN_PAGE, hostPiRoutes, updateScopeRoute, agentRoutes, apiKeyRoutes, containerPiRoutes, containerRoutes, dashboardLogin, dashboardPage, dashboardSetPassword, modelCatalog, saveSettings, settingsPayload } from "./lib/dashboard.mjs";

// Everything the modules export, re-exported: the tests, and anyone embedding the gateway, import
// from here.
export * from "./lib/settings.mjs";
export * from "./lib/auth.mjs";
export * from "./lib/paths.mjs";
export * from "./lib/engine.mjs";
export * from "./lib/containerpi.mjs";
export * from "./lib/models.mjs";
export * from "./lib/http.mjs";
export * from "./lib/profiles.mjs";
export * from "./lib/runner.mjs";
export * from "./lib/containers.mjs";
export * from "./lib/keycontainer.mjs";
export * from "./lib/audit.mjs";
export * from "./lib/alerts.mjs";
export * from "./lib/images.mjs";
export * from "./lib/sessions.mjs";
export * from "./lib/chat.mjs";
export * from "./lib/livesession.mjs";
export * from "./lib/agentrun.mjs";
export * from "./lib/liveroutes.mjs";
export * from "./lib/jobs.mjs";
export * from "./lib/jobroutes.mjs";
export * from "./lib/memoryroutes.mjs";
export * from "./lib/agentmemory.mjs";
export * from "./lib/knowledge.mjs";
export * from "./lib/knowledgeroutes.mjs";
// Not `export *`: tick/pump collide in name (not meaning) with lib/jobs.mjs's own scheduler functions.
export {
	RssError, SOURCE_TYPE, getFeed, listFeeds, createFeed, updateFeed, removeFeed, parseFeedXml, forcePoll,
	tick as rssTick, parseExtraction, looksBlocked, parseUnblockReply, setExtractionRunner, pump as rssPump, retryEntry, startFeeds, stopFeeds,
} from "./lib/rssfeeds.mjs";
export * from "./lib/rssroutes.mjs";
export * from "./lib/templates.mjs";
export * from "./lib/wizard.mjs";
export * from "./lib/bundleroutes.mjs";
export * from "./lib/packagesource.mjs";
export * from "./lib/extlib.mjs";
export * from "./lib/extroutes.mjs";
export * from "./lib/playground.mjs";
export * from "./lib/pipackages.mjs";
export * from "./lib/teams.mjs";
export * from "./lib/delegate.mjs";
export * from "./lib/agentschedule.mjs";
export * from "./lib/agents.mjs";
export * from "./lib/agentservers.mjs";
export * from "./lib/portal.mjs";
export * from "./lib/portalstore.mjs";
export * from "./lib/updates.mjs";
export * from "./lib/hostpi.mjs";
export * from "./lib/resources.mjs";
export * from "./lib/versions.mjs";
export * from "./lib/piversions.mjs";
export * from "./lib/about.mjs";
export * from "./lib/docs.mjs";
export * from "./lib/speed.mjs";
export * from "./lib/websocket.mjs";
export * from "./lib/terminal.mjs";
export * from "./lib/terminalroutes.mjs";
export * from "./lib/vendor.mjs";
export * from "./lib/dashboard.mjs";

// ------------------------------------------------------------------- server

/**
 * Who a request is, for the audit log: the dashboard, an API key (or the settings key), or nobody yet. The
 * request then runs inside that context, so every audit row it causes says who and from where.
 */
export function actorOf(req) {
	let path = "/";
	try {
		path = new URL(req.url, "http://localhost").pathname;
	} catch {
		/* a malformed URL is answered by the handler */
	}
	if (isDashboardPath(path)) return "dashboard";
	const credential = credentialOf(req);
	return credential ? (credential.legacy ? "settings-key" : `key:${credential.name}`) : "anonymous";
}

export const server = http.createServer((req, res) => runWithActor(actorOf(req), req.socket?.remoteAddress, () => handle(req, res)));

async function handle(req, res) {
	cors(res);
	const started = Date.now();
	res.on("finish", () => {
		logAccess(req, res.statusCode, res.sessionNote);
		// One line per chat request when that is being recorded: who, which session (a fingerprint), model, status, time. Never the messages.
		if (req.method === "POST" && /^\/(v1\/)?chat\/completions$/.test(req.url?.split("?")[0] ?? "")) {
			audit("request.chat", req.credential?.name ?? "open gateway", `${res.statusCode} ${Date.now() - started} ms model=${res.auditModel ?? "?"} ${res.sessionNote ?? ""}`.trim());
		}
	});
	try {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		const path = new URL(req.url, "http://localhost").pathname;
		if (req.method === "GET" && (path === "/health" || path === "/")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			// Two more facts, both harmless to say to anyone: whether containers can run, and how much disk is left.
			const engine = lastEngineStatus();
			return res.end(JSON.stringify({ status: "ok", sessions: sessions.stats(), docker: engine ? engine.ok : null, diskFreeMb: diskSummary().freeMb }));
		}
		// The dashboard has its own guard, so an unauthenticated browser gets a sign-in page it can
		// answer instead of a 401 it cannot. /v1/* keeps the API key check to itself.
		const isDashboard = isDashboardPath(path);
		// Resolved once, so the log line and the session record both know which key was used.
		req.credential = credentialOf(req);
		// A job's webhook is authorised by that job's own token, so it is answered before the API-key check.
		if (await triggerRoute(req, res, path)) return;
		if (!isDashboard && authRequired() && !req.credential) {
			const from = req.socket?.remoteAddress ?? "unknown";
			auditOnce(`authfail:${from}`, 60_000, "authfail.api", from, `${req.method} ${path}${req.headers.authorization ? " (a key was sent, and is not valid)" : " (no key)"}`);
			return sendError(res, 401, "Invalid API key", "invalid_api_key", "authentication_error");
		}
		if (req.method === "POST" && path === "/dashboard/login") return await dashboardLogin(req, res);
		if (req.method === "POST" && path === "/dashboard/logout") {
			audit("auth.logout", req.socket?.remoteAddress ?? "unknown", "signed out");
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
		// The Documentation page. Which files can be read comes from the docs folder, never from the request.
		if (req.method === "GET" && (path === "/dashboard/docs.json" || path === "/dashboard/docs/search.json" || /^\/dashboard\/docs\/[a-z0-9-]+\.json$/.test(path))) {
			const send = (status, body) => {
				res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				return res.end(JSON.stringify(body));
			};
			if (path === "/dashboard/docs.json") return send(200, { pages: pageIndex(), version: readPackage().version });
			if (path === "/dashboard/docs/search.json") return send(200, { hits: searchDocs(new URL(req.url, "http://localhost").searchParams.get("q") ?? "") });
			const page = renderPage(path.slice("/dashboard/docs/".length, -".json".length));
			return page ? send(200, page) : sendError(res, 404, "No such page", "not_found");
		}
		if (req.method === "GET" && path.startsWith("/dashboard/vendor/")) {
			const file = vendorFile(path.slice("/dashboard/vendor/".length));
			if (!file) return sendError(res, 404, "No such file", "not_found");
			res.writeHead(200, { "Content-Type": file.type, "Cache-Control": "private, max-age=86400", "Content-Length": file.body.length, "X-Content-Type-Options": "nosniff" });
			return res.end(file.body);
		}
		if (req.method === "GET" && path === "/dashboard/speed.json") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(speedHistory(new URL(req.url, "http://localhost").searchParams.get("range") ?? "1h")));
		}
		if (req.method === "GET" && path === "/dashboard/about.json") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(await aboutInfo()));
		}
		if (path === "/dashboard/hostpi.json" || path === "/dashboard/hostpi/update") return await hostPiRoutes(req, res, path);
		if (path === "/dashboard/agents.json" || path === "/dashboard/wizard.json" || path === "/dashboard/templates.json" || path === "/dashboard/teams.json" || path === "/dashboard/teams" || path.startsWith("/dashboard/teams/") || path === "/dashboard/templates" || path.startsWith("/dashboard/templates/") || path === "/dashboard/agents" || path.startsWith("/dashboard/agents/")) return await agentRoutes(req, res, path);
		const updateMatch = /^\/dashboard\/profiles\/([A-Za-z0-9_-]+)\/update-container$/.exec(path);
		if (updateMatch) return await updateScopeRoute(req, res, updateMatch[1]);
		if (path === "/dashboard/profiles.json" || path.startsWith("/dashboard/profiles/")) return await profileAdminRoutes(req, res, path);
		if ((path === "/dashboard/bundles.json" || path === "/dashboard/bundles" || path.startsWith("/dashboard/bundles/") || path.startsWith("/dashboard/bundlefiles/")) && (await bundleRoutes(req, res, path))) return;
		if (path.startsWith("/dashboard/playground/") && (await playgroundRoutes(req, res, path))) return;
		if (path.startsWith("/dashboard/extensions") && (await extensionRoutes(req, res, path))) return;
		if (path.startsWith("/dashboard/packages/") && (await packageRoutes(req, res, path))) return;
		const filesMatch = /^\/dashboard\/files\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(path);
		if (filesMatch) {
			const keyId = keyIdForScope(filesMatch[1]);
			if (keyId === undefined) return sendError(res, 404, `No profile ${filesMatch[1]}`, "not_found");
			return await dashboardFilesRoutes(req, res, keyId, filesMatch[2] ?? "");
		}
		if (req.method === "GET" && path === "/dashboard/models.json") return await modelCatalog(res);
		if (req.method === "POST" && path === "/dashboard/models/reload") {
			await reloadModelRuntime();
			audit("models.reload", "model catalogue", "reloaded from the host's Pi and the container config");
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
			// Whether containers can run here and what is wrong when not: Docker, the image, the network
			// policy. A gateway that cannot start chats should say so on the page, not only in a 503.
			snapshot.containers = await checkEngine(await engineOptions());
			snapshot.disk = diskSummary();
			// What the machine, the gateway and the containers are using; never allowed to break the page.
			snapshot.resources = await resourceSnapshot().catch(() => null);
			// The Pi version of each live agent's container, from the cache (filled in the background).
			snapshot.hostPiVersion = await hostPiVersion();
			const live = await inspectMany([...new Set(snapshot.sessions.map((s) => s.container).filter(Boolean))]);
			const known = piVersionsFor([...live].map(([name, info]) => ({ name, id: info.Id, image: info.Config?.Image ?? "" })));
			for (const s of snapshot.sessions) {
				const v = s.container ? known.get(s.container) : null;
				s.piVersion = v?.version ?? null;
				s.piStatus = v ? piStatus(v.version, snapshot.hostPiVersion) : "unknown";
			}
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify(snapshot));
		}
		if (path.startsWith("/dashboard/session/") && req.method !== "DELETE" && (await liveRoutes(req, res, path))) return;
		if (req.method === "DELETE" && path.startsWith("/dashboard/session/")) {
			const closed = sessions.closeByFingerprint(path.slice("/dashboard/session/".length));
			audit("session.kill", path.slice("/dashboard/session/".length), closed ? "ended from the dashboard" : "no such session");
			res.writeHead(closed ? 200 : 404, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ closed }));
		}
		if (path === "/dashboard/jobs.json" || path === "/dashboard/jobs" || path.startsWith("/dashboard/jobs/")) return await jobDashboardRoutes(req, res, path);
		if (path === "/dashboard/memory.json" || path.startsWith("/dashboard/memory/")) return await memoryDashboardRoutes(req, res, path);
		if (path === "/dashboard/knowledge.json" || path.startsWith("/dashboard/knowledge/")) return await knowledgeDashboardRoutes(req, res, path);
		if (path === "/dashboard/rss.json" || path === "/dashboard/rss" || path.startsWith("/dashboard/rss/")) return await rssDashboardRoutes(req, res, path);
		if (path === "/dashboard/container-pi" || path === "/dashboard/containers/recheck") return await containerPiRoutes(req, res, path);
		if (path === "/dashboard/containers.json" || path.startsWith("/dashboard/containers/") || path === "/dashboard/audit.json" || path === "/dashboard/audit.csv" || path === "/dashboard/updates.json" || path === "/dashboard/alerts/test" || path === "/dashboard/images.json" || path.startsWith("/dashboard/images/")) return await containerRoutes(req, res, path);
		if (req.method === "POST" && path === "/dashboard/kill-all") {
			res.writeHead(200, { "Content-Type": "application/json" });
			const closedAll = sessions.closeAll();
			audit("session.kill_all", "every live session", `${closedAll} ended`);
			return res.end(JSON.stringify({ closed: closedAll }));
		}
		if (req.method === "GET" && path === "/dashboard") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(dashboardPage());
		}
		if (req.method === "GET" && path === "/v1/models") return await listModels(res, req.credential);
		if (path === "/v1/piper/jobs" || path.startsWith("/v1/piper/jobs/")) return await jobApiRoutes(req, res, path);
		if (path === "/v1/piper/profile" || path.startsWith("/v1/piper/profile/")) return await profileRoutes(req, res, path);
		// A key's own workspace, and the operator's view of any key's.
		if (path === "/v1/piper/files" || path.startsWith("/v1/piper/files/")) {
			return await filesRoutes(req, res, req.credential ? req.credential.scopeId ?? req.credential.id : null, path.slice("/v1/piper/files".length));
		}
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			return await chatCompletions(req, res, await readJson(req));
		}
		return sendError(res, 404, `Unknown route: ${req.method} ${path}`, "not_found");
	} catch (err) {
		return sendError(res, 500, err?.message ?? String(err), "server_error", "server_error");
	}
}

// The terminal is the only WebSocket the gateway serves.
server.on("upgrade", (req, socket, head) => {
	socket.on("error", () => {});
	runWithActor(actorOf(req), req.socket?.remoteAddress, () => terminalUpgrade(req, socket, head)).catch(() => socket.destroy());
});

export const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
/**
 * A warning for running as root, or null. Root is not refused: the gateway needs the Docker socket,
 * and access to it is root-equivalent whoever holds it. What it should get is a dedicated user (and,
 * better, rootless Docker), so a container escape is not a host takeover.
 */
export function rootWarning(uid = process.getuid?.()) {
	if (uid !== 0) return null;
	return "running as root: anything that escapes a container reaches the host as root. Prefer a dedicated user, ideally with rootless Docker (see DEPLOYMENT.md).\n";
}

if (isMain) {
	const warning = rootWarning();
	if (warning) process.stderr.write(warning);
	const moved = migrateToContainers();
	if (moved) process.stderr.write(`moved to containers: ${moved.workspaces} shared folder(s) became workspaces, ${moved.archived} old chat workspace(s) archived, ${moved.chats} stored chat(s) reset\n`);
	// A restart hibernates every chat instead of dropping it: each one's spend is written to the
	// ledger, its agent and container stopped, and the container and Pi session kept for the next message.
	let stopping = false;
	const shutdown = async (signal) => {
		if (stopping) return;
		stopping = true;
		process.stderr.write(`${signal}: hibernating ${sessions.size} chat(s)\n`);
		server.close();
		stopJobs();
		stopFeeds();
		void stopAgentServers();
		void stopTeamServers();
		void stopPortal();
		closeAllTerminals();
		const deadline = setTimeout(() => process.exit(0), 10_000);
		deadline.unref?.();
		await sessions.hibernateAll().catch(() => {});
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
	server.listen(config.PORT, config.HOST, () => {
		process.stderr.write(
			`Piper ${readPackage().version} on http://${config.HOST}:${config.PORT}  ` +
				`auth=${authNote()}  ` +
				`dashboard=${dashboardHash ? "password" : "open"}  ` +
				`image=${config.CONTAINER_IMAGE}  network=${config.CONTAINER_NETWORK}  ` +
				`limits=${config.CONTAINER_MEMORY_MB}MB/${config.CONTAINER_CPUS}cpu/${config.CONTAINER_PIDS}pids  ` +
				`${process.getuid?.() === 0 ? "user=ROOT  " : ""}db=${GATEWAY_DB}\n`,
		);
		// Say now whether containers can run, instead of at the first chat, and start the sweeps.
		void engineOptions().then((options) => checkEngine({ force: true, ...options })).then(
			(status) => {
				for (const problem of status.problems) process.stderr.write(`containers: ${problem}\n`);
				for (const warn of status.warnings) process.stderr.write(`containers: ${warn}\n`);
				if (status.ok) process.stderr.write(`containers: docker ${status.engine.version}, image ${config.CONTAINER_IMAGE} (Pi ${status.image.piVersion || "?"}), network ${status.network.mode}${status.firewall.allowed.length ? `, allowed: ${status.firewall.allowed.map((a) => a.endpoint).join(" ")}` : ""}\n`);
				startSweeps();
				startJobs();
				startFeeds();
				startImageHousekeeping();
				startEventWatch();
				startDiskWatch();
				startPortal();
				void startAgentServers().then(() => startTeamServers());
			},
			() => {
				startSweeps();
				startJobs();
				startFeeds();
				startPortal();
				void startAgentServers().then(() => startTeamServers());
			},
		);
	});
}
