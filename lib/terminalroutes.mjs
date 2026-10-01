/**
 * The WebSocket upgrade for `/dashboard/terminal/<container>`: every check that must pass before a shell opens,
 * in the order that leaks least. Refusals are plain HTTP answers on the upgrade request, before any WebSocket
 * exists.
 */
import { dashboardAuthorized, dashboardHash, keyLabel } from "./auth.mjs";
import { agentScope } from "./agents.mjs";
import { runWithActor } from "./audit.mjs";
import { upgrade } from "./websocket.mjs";
import { attachTerminal, terminalGate } from "./terminal.mjs";

const PATH = /^\/dashboard\/terminal\/(piper-[0-9a-f]{8}-(?:[0-9a-f]{16}|key-[0-9a-f]{12}))$/;

/** Answer an upgrade request with a plain refusal. */
function refuse(socket, status, message) {
	const body = JSON.stringify({ error: { message, type: "invalid_request_error", code: { 401: "dashboard_locked", 409: "conflict", 429: "rate_limited" }[status] ?? "forbidden" } });
	try {
		socket.end(`HTTP/1.1 ${status} ${{ 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests" }[status] ?? "Error"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
	} catch {
		socket.destroy();
	}
}

/** True when a browser's `Origin` is this very host (the page that opened the socket was served by us). */
export function sameOrigin(req) {
	const origin = req.headers.origin;
	// Browsers always send it on a WebSocket; a client that does not is not a browser, and has the cookie legitimately.
	if (!origin) return true;
	try {
		const host = new URL(origin).host;
		return host === req.headers.host || host === req.headers["x-forwarded-host"];
	} catch {
		return false;
	}
}

/** The label an audit row shows for a container: its key, or its key and agent. */
export function terminalLabel(name, details) {
	const labels = details?.Config?.Labels ?? {};
	const keyId = labels["piper.key"];
	if (!keyId) return name;
	return `${keyLabel(labels["piper.agent"] ? agentScope(keyId, labels["piper.agent"]) : keyId)} · ${name.replace(/^piper-/, "")}`;
}

/**
 * Handle an `upgrade` event. Returns true when the request was for a terminal (answered or upgraded), false when
 * it is not ours to handle. `spawnFn` is a parameter for the tests.
 */
export async function terminalUpgrade(req, socket, head, { spawnFn } = {}) {
	let url;
	try {
		url = new URL(req.url, "http://localhost");
	} catch {
		refuse(socket, 404, "Not found");
		return true;
	}
	const match = PATH.exec(url.pathname);
	if (!match) {
		refuse(socket, 404, "Not found");
		return true;
	}
	// Signed in first: nothing is said to a caller who is not.
	if (dashboardHash && !dashboardAuthorized(req)) return refuse(socket, 401, "Dashboard is locked"), true;
	if (!dashboardHash) return refuse(socket, 403, "A terminal needs a dashboard password: set one under Settings → Access first. A root shell on an open dashboard would let anyone on your network in."), true;
	if (!sameOrigin(req)) return refuse(socket, 403, "This page was not served by this gateway."), true;
	const name = match[1];
	const gate = await terminalGate(name);
	if (!gate.ok) return refuse(socket, gate.status, gate.message), true;
	const peer = upgrade(req, socket, head);
	if (!peer) return true;
	const address = req.socket?.remoteAddress ?? socket.remoteAddress ?? null;
	runWithActor("dashboard", address, () => attachTerminal(peer, name, { cols: url.searchParams.get("cols"), rows: url.searchParams.get("rows"), label: terminalLabel(name, gate.details), spawnFn }));
	return true;
}
