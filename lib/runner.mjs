/** Runners: the in-process session, the sandboxed Pi process over RPC, and its model bridge. */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { join, relative, resolve } from "node:path";
import { GATEWAY_DIR, agentCwd, config } from "./settings.mjs";
import { BWRAP, SANDBOX_PATHS, agentDirPath, ensureRunRoot, isInside, jailExtension, runtimeRoot, sandboxArgs, sandboxLimiter } from "./sandbox.mjs";
import { modelRuntime, pi, piPackageDir, resolveModelQuery } from "./models.mjs";
import { modelAllowed } from "./auth.mjs";
import { readJson, sendJson } from "./http.mjs";
import { ensureKeyFiles, ensureProfile, grantedBundles, keyFilesWritability, profileWritability } from "./profiles.mjs";
import { spendRefusal } from "./sessions.mjs";

export async function createInProcessSession(workspace, record = null) {
	const { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } = await pi();
	const cwd = workspace ?? agentCwd();
	// Sessions must not be able to observe each other through anything but their own context.
	// Extensions are the escape hatch that breaks that: pi-memory appends to a shared MEMORY.md
	// under the agent dir and the next session reads it back. So user packages stay disabled
	// unless GATEWAY_EXTENSIONS=1. Inline factories are loaded independently of `noExtensions`,
	// which is why the jail below still applies.
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: !config.GATEWAY_EXTENSIONS,
		extensionFactories: workspace ? [jailExtension(workspace)] : [],
	});
	await resourceLoader.reload();
	// The tool needs the session it is being registered on, so it reads through a ref filled in
	// once createAgentSession resolves. customTools survive noExtensions either way.
	const ref = { session: null, keyId: record?.keyId ?? null };
	const { session } = await createAgentSession({
		cwd,
		modelRuntime: await modelRuntime(),
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		customTools: [setModelTool(ref)],
	});
	ref.session = session;
	return session;
}

// The sandboxed runners give each session its own Pi process inside a sandbox, rather than an
// AgentSession inside this one. Everything a session can run — its tools, its extensions, its
// skills' scripts — then runs in there, so a key's own extensions are safe to load and the file
// tools need no path guard: there is nothing outside to guard.
//
//   gateway ──JSONL over stdin/stdout (Pi's RPC mode)──▶ pi --mode rpc, in bwrap or a container
//      ▲                                                    │ workspace (rw), key's profile (rw)
//      └──── model calls over a per-session Unix socket ◀───┘ no credentials, no network
//
// The sandbox never holds a provider credential. piper-bridge.mjs, loaded into every sandboxed Pi,
// registers the gateway's catalogue as providers that forward each call over the socket; the
// gateway runs it with the real credentials and meters what it cost. The ledger is therefore
// written from the gateway's own accounting, never from figures the sandbox reports.

export const BRIDGE_PATH = join(GATEWAY_DIR, "piper-bridge.mjs");
export const BRIDGE_IN_CONTAINER = SANDBOX_PATHS.bridge;
export const SOCKET_IN_CONTAINER = SANDBOX_PATHS.socket;
/** The model call carries the whole transcript, images included, so it gets more room than a request. */
export const BRIDGE_BODY_LIMIT = 256 * 1024 * 1024;
/** How long a sandboxed Pi may take to start and answer its first command. */
export const SPAWN_TIMEOUT_MS = 60_000;
/** Stream options the sandbox may choose. Anything else — headers, keys, URLs — is the gateway's. */
export const BRIDGE_OPTIONS = ["reasoning", "maxTokens", "temperature", "sessionId", "cacheRetention", "toolChoice", "thinkingBudgets"];

/** The catalogue a sandbox may use: what the gateway has credentials for, minus anything secret. */
export function bridgeCatalog(models) {
	const providers = new Map();
	for (const m of models) {
		if (!providers.has(m.provider)) providers.set(m.provider, { id: m.provider, models: [] });
		providers.get(m.provider).models.push({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
			inputLimits: m.inputLimits,
			cost: m.cost,
			promptCache: m.promptCache,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			compat: m.compat,
		});
	}
	return { providers: [...providers.values()] };
}

/**
 * One stream event as it crosses to the sandbox.
 *
 * The cumulative `partial` snapshot is sent once, with `start`; resending it with every delta would
 * make a reply's stream quadratic in its length. Pi does read that snapshot, so every other
 * non-delta event carries the one content block it concerns and the latest usage, and the bridge
 * rebuilds the snapshot from those.
 */
export function wireEvent(event) {
	const { partial, ...rest } = event;
	if (event.type === "start") return { ...rest, partial };
	if (event.type.endsWith("_delta")) return rest;
	const out = { ...rest };
	if (partial?.usage) out.usage = partial.usage;
	if (event.contentIndex !== undefined && partial?.content?.[event.contentIndex]) out.block = partial.content[event.contentIndex];
	return out;
}

/** A fresh per-session meter. getSessionStats() on a sandboxed session reads this. */
export function newMeter() {
	return { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Add one finished model call's usage to a meter. */
export function meterUsage(meter, usage, model = null) {
	if (!usage) return;
	const add = (into) => {
		into.cost += Number(usage.cost?.total) || 0;
		into.tokens.input += usage.input ?? 0;
		into.tokens.output += usage.output ?? 0;
		into.tokens.cacheRead += usage.cacheRead ?? 0;
		into.tokens.cacheWrite += usage.cacheWrite ?? 0;
		into.tokens.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	};
	add(meter);
	// And per model, so a chat that switched models is billed to each for what it used there.
	if (model) add((meter.byModel ??= {})[model] ??= newMeter());
}

export function bridgeFailure(model, message) {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model?.api,
			provider: model?.provider,
			model: model?.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

/** Run one model call for a sandbox, with the gateway's credentials, and meter it. */
export async function bridgeStream(req, res, meter, keyId) {
	const body = await readJson(req, BRIDGE_BODY_LIMIT);
	const overSpend = spendRefusal(keyId);
	if (overSpend) return sendJson(res, 429, { error: overSpend });
	const runtime = await modelRuntime();
	// Looked up in the gateway's own catalogue by name: nothing about the model — its URL, its API,
	// its headers — is taken from the sandbox.
	const model = runtime.getAvailableSnapshot().find((m) => m.provider === body?.provider && m.id === body?.modelId);
	if (!model) return sendJson(res, 400, { error: `no available model ${body?.provider}/${body?.modelId}` });
	if (!modelAllowed(keyId, model)) return sendJson(res, 403, { error: `model ${model.provider}/${model.id} is not allowed for this API key` });
	if (!Array.isArray(body?.messages)) return sendJson(res, 400, { error: "messages must be an array" });
	const options = {};
	for (const key of BRIDGE_OPTIONS) if (body.options?.[key] !== undefined) options[key] = body.options[key];
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});
	options.signal = controller.signal;
	res.writeHead(200, { "Content-Type": "application/x-ndjson" });
	let final = null;
	try {
		for await (const event of runtime.streamSimple(model, { messages: body.messages }, options)) {
			if (event.type === "done") final = event.message;
			if (event.type === "error") final = event.error;
			res.write(`${JSON.stringify(wireEvent(event))}\n`);
		}
	} catch (err) {
		res.write(`${JSON.stringify(bridgeFailure(model, err?.message ?? String(err)))}\n`);
	}
	meterUsage(meter, final?.usage, `${model.provider}/${model.id}`);
	res.end();
}

/**
 * The per-session socket a sandboxed Pi reaches the gateway through.
 *
 * It is bind-mounted into that one sandbox and nowhere else, so being able to connect is the
 * authentication. It answers three things: the model catalogue, a model call, and a model name to
 * resolve for pi_set_model. Nothing on it can reconfigure the gateway or reach another session.
 */
export async function startBridge(socketPath, meter, { keyId = null } = {}) {
	// Inventory answers the sandbox posts back, by request id (see PiRpcSession.inventory).
	const inventoryWaiters = new Map();
	const server = http.createServer(async (req, res) => {
		try {
			if (req.method === "POST" && req.url === "/inventory") {
				const body = await readJson(req);
				const waiter = inventoryWaiters.get(String(body?.id ?? ""));
				if (waiter) {
					inventoryWaiters.delete(String(body.id));
					waiter(body);
				}
				return sendJson(res, 200, { ok: true });
			}
			if (req.method === "GET" && req.url === "/models") {
				// The sandbox only ever learns about the models this key may use.
				return sendJson(res, 200, bridgeCatalog((await modelRuntime()).getAvailableSnapshot().filter((m) => modelAllowed(keyId, m))));
			}
			if (req.method === "POST" && req.url === "/stream") return await bridgeStream(req, res, meter, keyId);
			if (req.method === "POST" && req.url === "/resolve-model") {
				const { query } = await readJson(req);
				const { model, candidates } = resolveModelQuery((await modelRuntime()).getAvailableSnapshot().filter((m) => modelAllowed(keyId, m)), String(query ?? ""));
				if (model) return sendJson(res, 200, { provider: model.provider, id: model.id });
				return sendJson(res, 200, {
					message: candidates.length
						? `"${query}" matches several models: ${candidates.join(", ")}. Ask the user which one they mean; nothing was changed.`
						: `No available model matches "${query}". Nothing was changed.`,
				});
			}
			return sendJson(res, 404, { error: "unknown bridge route" });
		} catch (err) {
			if (!res.headersSent) return sendJson(res, 500, { error: err?.message ?? String(err) });
			res.end();
		}
	});
	rmSync(socketPath, { force: true });
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolvePromise);
	});
	chmodSync(socketPath, 0o600);
	return {
		/** Resolve with the next inventory posted under `id`, or null after `timeoutMs`. */
		expectInventory(id, timeoutMs = 5000) {
			return new Promise((resolvePromise) => {
				const timer = setTimeout(() => {
					inventoryWaiters.delete(id);
					resolvePromise(null);
				}, timeoutMs);
				inventoryWaiters.set(id, (body) => {
					clearTimeout(timer);
					resolvePromise(body);
				});
			});
		},
		close() {
			server.close();
			server.closeAllConnections?.();
			rmSync(socketPath, { force: true });
		},
	};
}

/**
 * The command that starts one sandboxed Pi in RPC mode.
 *
 * bwrap reuses sandboxArgs, so the whole process gets exactly the masks a wrapped bash call gets,
 * plus three mounts: the key's profile and the bridge socket read-write, the bridge extension
 * read-only. A profile that may not be changed (locked, or over quota) is mounted as a throwaway
 * overlay instead, so the session still works but nothing it writes there survives. Containers get
 * the same mounts at fixed paths.
 */
export function runnerInvocation(kind, { workspace, profileDir, profileWritable = true, filesDir = null, filesWritable = true, bundles = [], resume = false, defaultModel = null, socketPath, bridgePath = BRIDGE_PATH, packageDir, network = config.SANDBOX_NETWORK, image = config.CONTAINER_IMAGE, uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0, memoryMb = config.SANDBOX_MEMORY_MB, pids = config.SANDBOX_PIDS, cpus = config.SANDBOX_CPUS }) {
	// Each bundle is a Pi package: one -e loads its extensions, skills and prompts, and /reload
	// rediscovers whatever the operator has added to it since.
	// Pi keeps its session in the chat's own workspace, so the chat can be resumed after a restart or
	// an eviction: --continue picks up the latest session there.
	const piArgs = (bridge, bundlePaths) => [
		"--mode", "rpc", "--session-dir", SANDBOX_PATHS.piSession, ...(resume ? ["--continue"] : []), "--approve",
		"-e", bridge, ...bundlePaths.flatMap((p) => ["-e", p]),
	];
	// A new chat starts on the operator's current default model unless the key's profile names its
	// own; the bridge applies it. A resumed chat keeps whatever model it was on.
	const modelEnv = !resume && defaultModel?.model ? { PIPER_DEFAULT_MODEL: defaultModel.model, ...(defaultModel.thinking ? { PIPER_DEFAULT_THINKING: defaultModel.thinking } : {}) } : {};
	const quiet = { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
	if (kind === "bwrap") {
		// Everything at the fixed paths the containers use too: the session sees /workspace,
		// /profile and /shared/<bundle>, never where the gateway keeps them on the host.
		const P = SANDBOX_PATHS;
		const binds = [
			profileWritable
				? { source: profileDir, target: P.profile, write: true }
				: { source: profileDir, target: P.profile, overlay: true },
			{ source: socketPath, target: P.socket, write: true },
			{ source: bridgePath, target: P.bridge },
			...bundles.map((b) => ({ source: b.path, target: `${P.shared}/${b.name}` })),
			// The key's shared folder, inside the workspace so `ls` shows it: the same files in every
			// chat of this key. Frozen, when over its limit, the way a locked profile is.
			...(filesDir
				? [filesWritable ? { source: filesDir, target: P.keyFiles, write: true } : { source: filesDir, target: P.keyFiles, overlay: true }]
				: []),
		];
		// The Pi package is normally under the Node prefix, which is mounted at /opt/node already;
		// one installed anywhere else is mounted at /opt/pi.
		let piInside;
		if (packageDir && isInside(runtimeRoot(), packageDir)) {
			piInside = join(P.runtime, relative(runtimeRoot(), packageDir));
		} else {
			binds.push({ source: packageDir, target: P.pi });
			piInside = P.pi;
		}
		const args = sandboxArgs({
			workspace,
			layout: "fixed",
			network,
			binds,
			env: { ...quiet, PI_CODING_AGENT_DIR: P.profile, PI_CONFIG_DIR: P.piConfig, PIPER_BRIDGE_SOCKET: P.socket, ...(filesDir ? { PIPER_SHARED_DIR: P.keyFiles } : {}), ...modelEnv },
		});
		const node = join(P.runtime, relative(runtimeRoot(), process.execPath));
		return {
			command: args[0],
			args: [...args.slice(1), "--", node, join(piInside, "dist", "bundle", "cli.js"), ...piArgs(P.bridge, bundles.map((b) => `${P.shared}/${b.name}`))],
		};
	}
	const env = { ...quiet, HOME: "/workspace", PI_CODING_AGENT_DIR: "/profile", PI_CONFIG_DIR: SANDBOX_PATHS.piConfig, PIPER_BRIDGE_SOCKET: SOCKET_IN_CONTAINER, ...(filesDir ? { PIPER_SHARED_DIR: SANDBOX_PATHS.keyFiles } : {}), ...modelEnv };
	return {
		command: kind,
		args: [
			"run", "--rm", "-i", "--init",
			...(network === "on" ? [] : ["--network", "none"]),
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"--read-only", "--tmpfs", "/tmp",
			...(memoryMb > 0 ? ["--memory", `${memoryMb}m`] : []),
			...(pids > 0 ? ["--pids-limit", String(pids)] : []),
			...(cpus > 0 ? ["--cpus", String(cpus)] : []),
			// The gateway's own uid, so the workspace and profile it created are writable and nothing
			// the container writes is owned by anyone else.
			"--user", `${uid}:${gid}`,
			"-v", `${workspace}:/workspace`,
			// A frozen profile is mounted read-only elsewhere and copied into a tmpfs at start: the
			// container equivalent of bwrap's throwaway overlay.
			...(profileWritable ? ["-v", `${profileDir}:/profile`] : ["-v", `${profileDir}:/profile-frozen:ro`, "--tmpfs", `/profile:uid=${uid},gid=${gid},mode=0700`]),
			"-v", `${socketPath}:${SOCKET_IN_CONTAINER}`,
			"-v", `${bridgePath}:${BRIDGE_IN_CONTAINER}:ro`,
			...bundles.flatMap((b) => ["-v", `${b.path}:/shared/${b.name}:ro`]),
			// A frozen shared folder is read-only in a container: there is no overlay to hand it.
			...(filesDir ? ["-v", `${filesDir}:${SANDBOX_PATHS.keyFiles}${filesWritable ? "" : ":ro"}`] : []),
			"-w", "/workspace",
			...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
			image,
			...(profileWritable
				? ["pi", ...piArgs(BRIDGE_IN_CONTAINER, bundles.map((b) => `/shared/${b.name}`))]
				: ["sh", "-c", `cp -a /profile-frozen/. /profile/ && exec pi ${piArgs(BRIDGE_IN_CONTAINER, bundles.map((b) => `/shared/${b.name}`)).join(" ")}`]),
		],
	};
}

/**
 * A sandboxed Pi, driven over its RPC mode, behind the slice of the AgentSession surface the
 * gateway uses. That is what lets runPrompt, the fallback logic and the ledger stay the same
 * whichever runner is in use.
 *
 * Framing splits on LF only. Node's readline also splits on U+2028 and U+2029, which are valid
 * inside JSON strings, so it would corrupt any record that contains one.
 */
export class PiRpcSession {
	#child;
	#pending = new Map();
	#listeners = new Set();
	#settleWaiters = new Set();
	#nextId = 0;
	#buffer = "";
	#stderr = "";
	#lastText = "";
	#meter;
	#onClose;
	#sawAgentStart = false;
	model = null;
	thinkingLevel = undefined;
	alive = true;

	#bridge;

	constructor(child, { meter = newMeter(), onClose, bridge } = {}) {
		this.#child = child;
		this.#bridge = bridge;
		this.#meter = meter;
		this.#onClose = onClose;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		child.stderr?.setEncoding("utf8");
		// Kept short: it only ever needs to explain why a process died.
		child.stderr?.on("data", (chunk) => (this.#stderr = (this.#stderr + chunk).slice(-4000)));
		child.on("exit", (code, signal) => this.#onExit(code, signal));
		child.on("error", (err) => this.#onExit(null, null, err));
		child.stdin.on("error", () => {});
	}

	#onStdout(chunk) {
		this.#buffer += chunk;
		let newline;
		while ((newline = this.#buffer.indexOf("\n")) >= 0) {
			const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue; // stdout is reserved for the protocol, so this is noise rather than data
			}
			this.#dispatch(record);
		}
	}

	#dispatch(record) {
		if (record.type === "response" && record.id !== undefined && this.#pending.has(record.id)) {
			const { resolve, reject } = this.#pending.get(record.id);
			this.#pending.delete(record.id);
			if (record.success) resolve(record.data);
			else reject(new Error(record.error ?? `${record.command} failed`));
			return;
		}
		if (record.type === "agent_start") this.#sawAgentStart = true;
		if (record.type === "thinking_level_changed") this.thinkingLevel = record.level;
		if (record.type === "message_end" && record.message?.role === "assistant") {
			const text = (record.message.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
			if (text) this.#lastText = text;
		}
		if (record.type === "agent_settled") for (const waiter of this.#settleWaiters) waiter.resolve();
		for (const listener of this.#listeners) {
			try {
				listener(record);
			} catch {
				/* a listener's bug must not stop the stream */
			}
		}
	}

	#onExit(code, signal, err) {
		if (!this.alive) return;
		this.alive = false;
		const detail = err?.message ?? (signal ? `signal ${signal}` : `code ${code}`);
		const tail = this.#stderr.trim().split("\n").slice(-5).join(" | ");
		const error = new Error(`the sandboxed Pi exited (${detail})${tail ? `: ${tail}` : ""}`);
		for (const { reject } of this.#pending.values()) reject(error);
		this.#pending.clear();
		for (const waiter of this.#settleWaiters) waiter.reject(error);
		this.#onClose?.();
	}

	/** Send one command and resolve with its response data. */
	send(command) {
		if (!this.alive) return Promise.reject(new Error("the sandboxed Pi is not running"));
		const id = `g${++this.#nextId}`;
		return new Promise((resolvePromise, reject) => {
			this.#pending.set(id, { resolve: resolvePromise, reject });
			this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	/** Wait for the first command, so a sandbox that cannot start fails the spawn rather than the first prompt. */
	async init(timeoutMs = SPAWN_TIMEOUT_MS) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`the sandboxed Pi did not start within ${timeoutMs / 1000}s`)), timeoutMs);
		});
		try {
			const state = await Promise.race([this.send({ type: "get_state" }), timeout]);
			this.model = state?.model ?? null;
			this.thinkingLevel = state?.thinkingLevel;
		} finally {
			clearTimeout(timer);
		}
		return this;
	}

	subscribe(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Run one prompt to completion, as AgentSession.prompt does.
	 *
	 * Completion is `agent_settled`. A prompt that names an extension command is handled without an
	 * agent run and never settles, so after the prompt is accepted the state is checked: if no run
	 * started and none is streaming, there is nothing to wait for.
	 */
	async prompt(message, { images } = {}) {
		let waiter;
		const settled = new Promise((resolvePromise, reject) => {
			waiter = { resolve: resolvePromise, reject };
			this.#settleWaiters.add(waiter);
		});
		settled.catch(() => {});
		this.#sawAgentStart = false;
		try {
			await this.send({ type: "prompt", message, ...(images?.length ? { images } : {}) });
			const state = await this.send({ type: "get_state" });
			if (!this.#sawAgentStart && !state?.isStreaming && !state?.isCompacting) return;
			await settled;
		} finally {
			this.#settleWaiters.delete(waiter);
			this.send({ type: "get_state" }).then((state) => {
				if (state?.model) this.model = state.model;
			}, () => {});
		}
	}

	async abort() {
		await this.send({ type: "abort" });
	}

	async setModel(model) {
		const data = await this.send({ type: "set_model", provider: model.provider, modelId: model.id });
		this.model = data ?? model;
	}

	setThinkingLevel(level) {
		this.thinkingLevel = level;
		this.send({ type: "set_thinking_level", level }).catch(() => {});
	}

	/** The gateway's own metering of this session's model calls, not the sandbox's report. */
	getSessionStats() {
		const byModel = Object.fromEntries(Object.entries(this.#meter.byModel ?? {}).map(([k, v]) => [k, { cost: v.cost, tokens: { ...v.tokens } }]));
		return { cost: this.#meter.cost, tokens: { ...this.#meter.tokens }, byModel };
	}

	getLastAssistantText() {
		return this.#lastText;
	}

	/**
	 * Every tool and command this agent has loaded, with where each came from, or null when it does
	 * not answer in time. Runs the bridge's /piper-inventory command, which executes at once even
	 * mid-reply and adds nothing to the conversation.
	 */
	async inventory(timeoutMs = 5000) {
		if (!this.#bridge || !this.alive) return null;
		const id = crypto.randomBytes(8).toString("hex");
		const answer = this.#bridge.expectInventory(id, timeoutMs);
		await this.send({ type: "prompt", message: `/piper-inventory ${id}` }).catch(() => {});
		return answer;
	}

	/** Re-read skills, extensions, prompts, settings and context files, through the bridge's command. */
	async reload() {
		await this.send({ type: "prompt", message: "/piper-reload" });
	}

	/** Close stdin, which asks Pi to shut down, and make sure it does. */
	dispose() {
		if (!this.alive) return;
		try {
			this.#child.stdin.end();
		} catch {
			/* already closed */
		}
		const child = this.#child;
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 3000).unref?.();
	}
}

/** The default model and thinking level set in the operator's own Pi, for new chats to start on. */
export function hostDefaultModel(agentDir = agentDirPath()) {
	try {
		const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		if (!s.defaultProvider || !s.defaultModel) return null;
		return { model: `${s.defaultProvider}/${s.defaultModel}`, thinking: s.defaultThinkingLevel ?? null };
	} catch {
		return null;
	}
}

/** Start one sandboxed Pi for a session and wait until it answers. */
export async function createSandboxedSession(workspace, record) {
	const kind = config.RUNNER;
	if (!workspace) throw new Error(`RUNNER=${kind} needs WORKSPACE_ROOT: each sandboxed session runs in its own workspace`);
	if (kind === "bwrap" && !existsSync(BWRAP)) throw new Error("bubblewrap is not installed; install it or choose another RUNNER");
	await pi();
	if (kind === "bwrap" && !existsSync(join(piPackageDir, "dist", "bundle", "cli.js"))) {
		throw new Error(`cannot find the Pi CLI under ${piPackageDir || "(unresolved)"}; set PI_AGENT_PACKAGE`);
	}
	const profileDir = ensureProfile(record?.keyId ?? null);
	const { writable: profileWritable } = profileWritability(record?.keyId ?? null, profileDir);
	const socketPath = join(ensureRunRoot(), `${crypto.randomBytes(8).toString("hex")}.sock`);
	const meter = newMeter();
	const bridge = await startBridge(socketPath, meter, { keyId: record?.keyId ?? null });
	let session;
	try {
		const bundles = grantedBundles(record?.keyId ?? null);
		const filesDir = ensureKeyFiles(record?.keyId ?? null);
		const { writable: filesWritable } = keyFilesWritability(filesDir);
		const { command, args } = runnerInvocation(kind, {
			workspace, profileDir, profileWritable, filesDir, filesWritable, bundles, socketPath, packageDir: piPackageDir,
			resume: Boolean(record?.resume),
			defaultModel: record?.resume ? null : hostDefaultModel(),
		});
		// Containers carry their own limits; bwrap gets a systemd scope around it.
		const limiter = kind === "bwrap" ? sandboxLimiter() : { prefix: [] };
		if (limiter.error) throw new Error(limiter.error);
		const argv = [...limiter.prefix, command, ...args];
		const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
		session = new PiRpcSession(child, { meter, onClose: () => bridge.close(), bridge });
		return await session.init();
	} catch (err) {
		session?.dispose();
		bridge.close();
		throw err;
	}
}

/** Which runner a new session uses. Read per session, so a change applies without a restart. */
export function createSession(workspace, record) {
	return config.RUNNER === "inprocess" ? createInProcessSession(workspace, record) : createSandboxedSession(workspace, record);
}

/**
 * Resolve the user's wording and switch this session's model.
 *
 * Session-only: nothing is written to settings.json, so other gateway sessions and the
 * interactive `pi` in a terminal keep their own model.
 */
export async function setModelFromQuery(session, query, keyId = "") {
	const runtime = await modelRuntime();
	const { model, candidates } = resolveModelQuery(runtime.getAvailableSnapshot().filter((m) => modelAllowed(keyId, m)), query);
	if (!model) {
		return candidates.length
			? `"${query}" matches several models: ${candidates.join(", ")}. Ask the user which one they mean; nothing was changed.`
			: `No available model matches "${query}". Nothing was changed.`;
	}
	await session.setModel(model);
	return `Model switched to ${model.provider}/${model.id} for this session only.`;
}

/** The tool the model calls to change its own model. `ref` is filled in after the session exists. */
export function setModelTool(ref) {
	const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });
	return {
		name: "pi_set_model",
		label: "Set Pi model",
		description:
			"Switch the Pi model for this session. Pass the user's own wording verbatim, for example 'deepseek 4.1 flash from opencode-go'. " +
			"Do not invent or guess a provider/model id. Resolution is done against the live catalog; if the request is ambiguous or unknown nothing changes and a candidate list is returned so you can ask the user.",
		promptSnippet: "Switch the active model for this session",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The model the user asked for, in their own words (not an id you constructed).",
				},
			},
			required: ["query"],
		},
		execute: async (_toolCallId, params) => {
			if (!ref.session) return text("Model swapping is not available yet; try again in a moment.");
			try {
				return text(await setModelFromQuery(ref.session, String(params?.query ?? ""), ref.keyId));
			} catch (err) {
				return text(`Model swap failed: ${err?.message ?? err}`);
			}
		},
	};
}
