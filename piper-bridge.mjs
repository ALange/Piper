/**
 * Piper bridge: loaded into every sandboxed Pi process with `-e`.
 *
 * The sandbox holds no provider credentials and, by default, has no network. This extension is
 * the one way out: it registers the gateway's model catalogue as providers whose streamSimple
 * forwards each model call over a Unix socket to the gateway, which runs it with the real
 * credentials and streams the events back. The socket is bind-mounted into this sandbox alone,
 * so reaching it is the authentication.
 *
 * It also registers:
 *   - `pi_set_model`, so the model can switch itself on the user's request, as it could in-process;
 *   - `/piper-reload`, so the gateway's `/reload` can re-read skills, extensions and settings.
 *
 * Plain JavaScript on purpose: nothing here needs compiling, and the gateway has no build step.
 */
import http from "node:http";
import { createAssistantMessageEventStream, parseStreamingJson } from "@earendil-works/pi-ai";

const SOCKET = process.env.PIPER_BRIDGE_SOCKET;

function request(path, body, signal) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ socketPath: SOCKET, path, method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, signal },
			resolve,
		);
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

async function readJson(response) {
	let text = "";
	for await (const chunk of response) text += chunk;
	const data = JSON.parse(text);
	if (response.statusCode !== 200) throw new Error(data?.error ?? `bridge answered HTTP ${response.statusCode}`);
	return data;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function failure(model, reason, message) {
	return {
		type: "error",
		reason,
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: ZERO_USAGE,
			stopReason: reason,
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

/**
 * Forward one model call to the gateway.
 *
 * The gateway sends events without the cumulative `partial` snapshot, which would make the stream
 * quadratic in the reply's length. Pi reads that snapshot, though — a tool call's block is looked
 * up in it — so it is rebuilt here: the gateway sends the block itself on every start and end
 * event, and deltas are applied locally, exactly as a provider would have built it.
 */
function forward(model, context, options) {
	const stream = createAssistantMessageEventStream();
	(async () => {
		let partial;
		const toolJson = new Map();
		let finished = false;
		const push = (event) => {
			if (finished) return;
			if (event.type === "done" || event.type === "error") finished = true;
			stream.push(event);
		};
		try {
			const response = await request(
				"/stream",
				{
					provider: model.provider,
					modelId: model.id,
					messages: context.messages,
					options: {
						reasoning: options?.reasoning,
						maxTokens: options?.maxTokens,
						temperature: options?.temperature,
						sessionId: options?.sessionId,
						cacheRetention: options?.cacheRetention,
						toolChoice: options?.toolChoice,
						thinkingBudgets: options?.thinkingBudgets,
					},
				},
				options?.signal,
			);
			if (response.statusCode !== 200) {
				const data = await readJson(response).catch((err) => ({ error: err.message }));
				return push(failure(model, "error", data?.error ?? `bridge answered HTTP ${response.statusCode}`));
			}
			response.setEncoding("utf8");
			let buffer = "";
			for await (const chunk of response) {
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, "");
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					const event = JSON.parse(line);
					const { block, usage } = event;
					delete event.block;
					delete event.usage;
					if (event.type === "start") {
						partial = event.partial;
					} else if (partial) {
						if (usage) partial.usage = usage;
						const i = event.contentIndex;
						if (block && i !== undefined) partial.content[i] = block;
						else if (event.type === "text_delta") partial.content[i].text += event.delta;
						else if (event.type === "thinking_delta") partial.content[i].thinking += event.delta;
						else if (event.type === "toolcall_delta") {
							const json = (toolJson.get(i) ?? "") + event.delta;
							toolJson.set(i, json);
							partial.content[i].arguments = parseStreamingJson(json);
						}
						if (event.type !== "done" && event.type !== "error") event.partial = partial;
					}
					push(event);
				}
			}
			if (!finished) push(failure(model, "error", "the gateway closed the model stream before it finished"));
		} catch (err) {
			if (options?.signal?.aborted) push(failure(model, "aborted", "aborted"));
			else push(failure(model, "error", `model bridge failed: ${err?.message ?? err}`));
		}
	})();
	return stream;
}

export default async function piperBridge(pi) {
	if (!SOCKET) return;
	const catalog = await readJson(await request("/models"));
	for (const provider of catalog.providers) {
		pi.registerProvider(provider.id, {
			name: provider.name,
			// Never contacted: every call goes through streamSimple. Pi requires both when models are
			// defined, and neither is a credential.
			baseUrl: "http://piper-bridge.invalid",
			apiKey: "piper-bridge",
			api: "piper-bridge",
			models: provider.models,
			streamSimple: forward,
		});
	}

	pi.registerTool({
		name: "pi_set_model",
		label: "Set Pi model",
		description:
			"Switch the Pi model for this session. Pass the user's own wording verbatim, for example 'deepseek 4.1 flash from opencode-go'. " +
			"Do not invent or guess a provider/model id. Resolution is done against the live catalog; if the request is ambiguous or unknown nothing changes and a candidate list is returned so you can ask the user.",
		promptSnippet: "Switch the active model for this session",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "The model the user asked for, in their own words (not an id you constructed)." },
			},
			required: ["query"],
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });
			try {
				const answer = await readJson(await request("/resolve-model", { query: String(params?.query ?? "") }));
				if (!answer.provider) return text(answer.message);
				const model = ctx.modelRegistry.find(answer.provider, answer.id);
				if (!model || !(await pi.setModel(model))) return text(`Model ${answer.provider}/${answer.id} is not available here. Nothing was changed.`);
				return text(`Model switched to ${answer.provider}/${answer.id} for this session only.`);
			} catch (err) {
				return text(`Model swap failed: ${err?.message ?? err}`);
			}
		},
	});

	// What this agent really has, for the dashboard: every tool and command with where it came from.
	// The gateway asks with a request id and the answer goes back over the socket, since a command
	// has no other way to return data. It touches nothing in the conversation.
	pi.registerCommand("piper-inventory", {
		description: "Report loaded tools and commands to the gateway",
		handler: async (args) => {
			const source = (info) => info?.path ?? "";
			const tools = pi.getAllTools().map((t) => ({
				name: t.name,
				description: String(t.description ?? "").slice(0, 300),
				path: source(t.sourceInfo),
			}));
			const commands = pi.getCommands().map((c) => ({
				name: c.name,
				description: String(c.description ?? "").slice(0, 300),
				source: c.source,
				path: source(c.sourceInfo),
			}));
			await readJson(await request("/inventory", { id: String(args ?? "").trim(), tools, active: pi.getActiveTools(), commands }));
		},
	});

	pi.registerCommand("piper-reload", {
		description: "Re-read skills, extensions, prompts, settings and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
}
