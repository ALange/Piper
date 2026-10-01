/** The Pi process in a chat's container, driven over RPC, and the model bridge it reaches the gateway through. */
import crypto from "node:crypto";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { GATEWAY_DIR } from "./settings.mjs";
import { addSpeed, callSpeed, newSpeedStats, recordSpeed, speedView } from "./speed.mjs";
import { CONTAINER_PATHS, agentDirPath } from "./paths.mjs";
import { modelRuntime, resolveModelQuery } from "./models.mjs";
import { catalogueFor, directProviders } from "./containerpi.mjs";
import { modelAllowed } from "./auth.mjs";
import { readJson, sendJson } from "./http.mjs";
import { spendRefusal } from "./sessions.mjs";

// Each chat runs Pi in its own container, rather than as an AgentSession inside this process:
//
//   gateway ──JSONL over docker exec stdin/stdout (Pi's RPC mode)──▶ pi --mode rpc, in the container
//      ▲                                                                │ workspace (rw), key's profile (rw)
//      └──── model calls over a per-chat Unix socket ◀──────────────────┘ models the container config defines
//                                                                         are called directly
//
// Pi in the container is a stock install. Models the gateway holds credentials for reach the
// container's Pi through piper-bridge.mjs, which registers them as providers that forward each call
// over the socket; the gateway runs it with the real credentials and meters it. Models the operator
// configured for containers (containerpi.mjs) are called by Pi directly, and metered from the RPC
// event stream instead.

export const BRIDGE_PATH = join(GATEWAY_DIR, "piper-bridge.mjs");
/** The model call carries the whole transcript, images included, so it gets more room than a request. */
export const BRIDGE_BODY_LIMIT = 256 * 1024 * 1024;
/** How long Pi may take to start in its container and answer its first command. */
export const SPAWN_TIMEOUT_MS = 60_000;
/** Stream options a container may choose. Anything else — headers, keys, URLs — is the gateway's. */
export const BRIDGE_OPTIONS = ["reasoning", "maxTokens", "temperature", "sessionId", "cacheRetention", "toolChoice", "thinkingBudgets"];

/** The catalogue a container's Pi is offered through the bridge: what the gateway has credentials for, minus anything secret. */
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
 * One stream event as it crosses to the container.
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

/** A fresh per-session meter. getSessionStats() reads this. */
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

/** Run one model call for a container, with the gateway's credentials, and meter it. */
export async function bridgeStream(req, res, meter, keyId) {
	const body = await readJson(req, BRIDGE_BODY_LIMIT);
	const overSpend = spendRefusal(keyId);
	if (overSpend) return sendJson(res, 429, { error: overSpend });
	const runtime = await modelRuntime();
	// Looked up in the gateway's own catalogue by name: nothing about the model — its URL, its API,
	// its headers — is taken from the container.
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
 * The per-chat socket the container's Pi reaches the gateway through.
 *
 * Its folder is mounted into that one container and nowhere else, so being able to connect is the
 * authentication. It answers three things: the model catalogue, a model call, and a model name to
 * resolve for pi_set_model. Nothing on it can reconfigure the gateway or reach another session.
 */
export async function startBridge(socketPath, meter, { keyId = null, delegator = null } = {}) {
	// Inventory answers the container posts back, by request id (see PiRpcSession.inventory).
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
				// The container only ever learns about the models this key may use.
				// Providers the container config defines are Pi's own; registering them here too would collide.
				const direct = directProviders();
				return sendJson(res, 200, bridgeCatalog((await modelRuntime()).getAvailableSnapshot().filter((m) => !direct.has(m.provider) && modelAllowed(keyId, m))));
			}
			if (req.method === "GET" && req.url === "/agents") return sendJson(res, 200, { agents: delegator ? delegator.agents() : [] });
			if (req.method === "POST" && req.url === "/delegate") {
				if (!delegator) return sendJson(res, 403, { error: "this chat may not delegate" });
				const { agent, task } = await readJson(req);
				// If the calling agent goes away (interrupt, stop), the colleague's turn stops with it.
				const controller = new AbortController();
				res.on("close", () => controller.abort());
				try {
					return sendJson(res, 200, { text: await delegator.delegate(agent, task, controller.signal) });
				} catch (err) {
					return sendJson(res, 409, { error: err.message });
				}
			}
			if (req.method === "POST" && req.url === "/stream") return await bridgeStream(req, res, meter, keyId);
			if (req.method === "POST" && req.url === "/resolve-model") {
				const { query } = await readJson(req);
				const { model, candidates } = resolveModelQuery(catalogueFor(await modelRuntime(), (m) => modelAllowed(keyId, m)), String(query ?? ""));
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
 * The Pi in a chat's container, driven over its RPC mode, behind the slice of the AgentSession surface the
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
	// How fast this session's model calls have been, and the call being timed now.
	#clock = () => performance.now();
	#speed = newSpeedStats();
	#call = null;
	#boundaryAt = null;
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
	#direct;
	#killRemote;
	#reason;
	#disposing = null;

	/**
	 * `direct` returns the providers Pi calls itself; their calls never cross the bridge, so they are
	 * metered here, from the assistant messages in the event stream. `killRemote` ends Pi inside its
	 * container when closing its stdin did not (killing the `docker exec` client alone would not).
	 */
	constructor(child, { meter = newMeter(), onClose, bridge, direct = () => new Set(), killRemote, reason = () => null, clock = () => performance.now() } = {}) {
		this.#clock = clock;
		this.#child = child;
		this.#reason = reason;
		this.#bridge = bridge;
		this.#direct = direct;
		this.#killRemote = killRemote;
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
		this.#timeCall(record, this.#clock());
		if (record.type === "agent_start") this.#sawAgentStart = true;
		if (record.type === "thinking_level_changed") this.thinkingLevel = record.level;
		if (record.type === "message_end" && record.message?.role === "assistant") {
			const text = (record.message.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
			if (text) this.#lastText = text;
			// A call the gateway did not run: what it cost is only what the container reports.
			const m = record.message;
			if (m.usage && m.provider && this.#direct().has(m.provider)) meterUsage(this.#meter, m.usage, `${m.provider}/${m.model}`);
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
		// What Docker said happened to the container just now (killed for memory, say), when it did.
		const why = this.#reason();
		const error = new Error(`Pi in the container exited (${detail})${why ? `: ${why}` : ""}${tail ? `: ${tail}` : ""}`);
		for (const { reject } of this.#pending.values()) reject(error);
		this.#pending.clear();
		for (const waiter of this.#settleWaiters) waiter.reject(error);
		this.#onClose?.();
	}

	/** Send one command and resolve with its response data. */
	send(command) {
		if (!this.alive) return Promise.reject(new Error("Pi is not running in the container"));
		const id = `g${++this.#nextId}`;
		return new Promise((resolvePromise, reject) => {
			this.#pending.set(id, { resolve: resolvePromise, reject });
			this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	/** Wait for the first command, so a container that cannot start fails the spawn rather than the first prompt. */
	async init(timeoutMs = SPAWN_TIMEOUT_MS) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Pi did not start in the container within ${timeoutMs / 1000}s`)), timeoutMs);
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

	/**
	 * Time each model call from the event stream: the assistant message starts, its first token arrives, it
	 * ends. Done here, on every event, because every call (bridged or direct) shows up in this stream. A failed
	 * or aborted call is not a measurement.
	 */
	#timeCall(record, at) {
		const assistant = record.message?.role === "assistant";
		if (record.type === "message_start" && assistant) {
			// The call began when the request went out, which is the event before this one (the prompt, a tool
			// result, a new turn), not when Pi announced the reply: a provider that holds its response until
			// the first token has Pi announce it only then, which would read as a time to first token of zero.
			this.#call = { start: this.#boundaryAt ?? at, first: null };
			return;
		}
		if (record.type !== "message_update") this.#boundaryAt = at;
		if (!this.#call) return;
		if (record.type === "message_update" && this.#call.first === null && /_delta$/.test(record.assistantMessageEvent?.type ?? "")) {
			this.#call.first = at;
			return;
		}
		if (record.type === "message_end" && assistant) {
			const call = this.#call;
			this.#call = null;
			const m = record.message;
			if (m.stopReason === "error" || m.stopReason === "aborted") return;
			const sample = callSpeed({ startMs: call.start, firstMs: call.first, endMs: at, usage: m.usage });
			if (!sample) return;
			const model = m.provider && m.model ? `${m.provider}/${m.model}` : null;
			addSpeed(this.#speed, sample, model);
			recordSpeed(model, sample);
		}
	}

	/** How fast this session's model calls have been: weighted averages in tokens per second, and the last call. */
	getSpeed() {
		return speedView(this.#speed);
	}

	/** The metering of this session's model calls: the gateway's own for bridged models, the event stream's for direct ones. */
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

	/**
	 * Close stdin, which asks Pi to shut down, and make sure it does. Resolves once Pi has exited, so a
	 * caller can stop the container knowing nothing is half-way through writing the session file.
	 */
	dispose() {
		if (this.#disposing) return this.#disposing;
		if (!this.alive) return Promise.resolve();
		const child = this.#child;
		this.#disposing = new Promise((resolvePromise) => {
			let killer;
			child.once("exit", () => {
				clearTimeout(killer);
				resolvePromise();
			});
			try {
				child.stdin.end();
			} catch {
				/* already closed */
			}
			killer = setTimeout(async () => {
				try {
					await this.#killRemote?.();
				} catch {
					/* the container may be gone already */
				}
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				setTimeout(resolvePromise, 500).unref?.();
			}, 3000);
			killer.unref?.();
		});
		return this.#disposing;
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

/**
 * Resolve the user's wording and switch this session's model.
 *
 * Session-only: nothing is written to settings.json, so other gateway sessions and the
 * interactive `pi` in a terminal keep their own model.
 */
export async function setModelFromQuery(session, query, keyId = "") {
	const runtime = await modelRuntime();
	const { model, candidates } = resolveModelQuery(catalogueFor(runtime, (m) => modelAllowed(keyId, m)), query);
	if (!model) {
		return candidates.length
			? `"${query}" matches several models: ${candidates.join(", ")}. Ask the user which one they mean; nothing was changed.`
			: `No available model matches "${query}". Nothing was changed.`;
	}
	await session.setModel(model);
	return `Model switched to ${model.provider}/${model.id} for this session only.`;
}
