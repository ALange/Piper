/**
 * Piper bridge: loaded into the Pi process in every chat's container with `-e`.
 *
 * Pi here is a stock install. For the models the gateway holds credentials for, the container has
 * none: this extension registers the gateway's model catalogue as providers whose streamSimple
 * forwards each model call over a Unix socket to the gateway, which runs it with the real
 * credentials and streams the events back. The socket is mounted into this container alone, so
 * reaching it is the authentication. Models the operator configured for containers are not in that
 * catalogue: Pi calls them itself, from its own models.json.
 *
 * It also registers:
 *   - `pi_set_model`, so the model can switch itself on the user's request, so the agent can change its own model;
 *   - `/piper-reload`, so the gateway's `/reload` can re-read skills, extensions and settings.
 *
 * Plain JavaScript on purpose: nothing here needs compiling, and the gateway has no build step.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
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
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`the gateway answered with invalid JSON (HTTP ${response.statusCode})`);
	}
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

/**
 * The model catalogue, tolerating a transient failure to reach the bridge socket right at startup (unlike
 * every later call in this file, which is wrapped at its own call site, this one runs before anything else
 * and a plain throw here would take the whole extension down with it: the delegate, schedule and model-switch
 * tools below too, not just the model providers). A few quick retries, then an empty catalogue rather than
 * none of it: Pi still loads, with its own directly-configured models and every non-model tool working.
 */
async function fetchCatalog(tries = 5, delayMs = 400) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await readJson(await request("/models"));
		} catch (err) {
			if (attempt >= tries) {
				process.stderr.write(`piper-bridge: could not reach the gateway for its model catalogue (${err?.message ?? err}); continuing without its models\n`);
				return { providers: [] };
			}
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
}

export default async function piperBridge(pi) {
	if (!SOCKET) return;
	const catalog = await fetchCatalog();
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

	// Hand-offs: only when the gateway says this agent may delegate (PIPER_DELEGATE), and only to agents of the
	// same key, which the gateway decides: the socket is this chat's, so it cannot be used to speak for another.
	if (process.env.PIPER_DELEGATE === "1") {
		const reply = (value) => ({ content: [{ type: "text", text: value }], details: {} });
		// The colleagues are in the system prompt every turn, current as of this turn, so an agent created a minute ago
		// is used without the model having to ask. A failure adds nothing: it must never block a turn.
		pi.on("before_agent_start", async (event) => {
			try {
				const { roster } = await readJson(await request("/agents"));
				if (!roster) return;
				const guidelines = (event.systemPromptOptions.promptGuidelines ??= []);
				// Replace last turn's list rather than stacking lists.
				for (let i = guidelines.length - 1; i >= 0; i--) if (guidelines[i].startsWith("Your colleagues right now") || guidelines[i].startsWith("You may hand work to the other agents")) guidelines.splice(i, 1);
				guidelines.push(roster);
			} catch {
				/* no roster this turn */
			}
		});
		pi.registerTool({
			name: "piper_agents",
			label: "List colleague agents",
			description: "List the other agents you can hand work to, with what each is for. Use it before piper_delegate when you do not already know who to ask.",
			promptSnippet: "List the colleague agents you can delegate to",
			parameters: { type: "object", properties: {} },
			async execute() {
				try {
					const { agents } = await readJson(await request("/agents"));
					if (!agents.length) return reply("You have no colleagues you can hand work to right now.");
					return reply(agents.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`).join("\n"));
				} catch (err) {
					return reply(`Could not list colleagues: ${err?.message ?? err}`);
				}
			},
		});
		pi.registerTool({
			name: "piper_delegate",
			label: "Delegate to a colleague",
			description:
				"Give a task to one of your colleague agents and wait for its answer. The colleague has its own instructions, skills and files, and sees only the task you write, so make it self-contained: say what you need, what you already know, and what form the answer should take. " +
				"It keeps its own conversation across your calls, so a follow-up can refer to earlier ones. Its answer comes back as text. Do not delegate what you can do yourself in a step or two.",
			promptSnippet: "Hand a self-contained task to a colleague agent and get its answer",
			parameters: {
				type: "object",
				properties: {
					agent: { type: "string", description: "The colleague's name, from piper_agents." },
					task: { type: "string", description: "A complete, self-contained task." },
				},
				required: ["agent", "task"],
			},
			async execute(_toolCallId, params, signal) {
				try {
					const answer = await readJson(await request("/delegate", { agent: String(params?.agent ?? ""), task: String(params?.task ?? "") }, signal));
					return reply(answer.text);
				} catch (err) {
					return reply(`Delegation failed: ${err?.message ?? err}`);
				}
			},
		});
	}

	// Schedules: an agent may book a recurring task on the gateway. The job lives on the server, so it runs on its
	// schedule even when this chat's container is stopped; each run starts the container again. Only the agent's own
	// schedules, and it cannot set a completion webhook (that stays the operator's).
	if (process.env.PIPER_SCHEDULE === "1") {
		const reply = (value) => ({ content: [{ type: "text", text: value }], details: {} });
		const when = (s) => {
			if (!s) return "unknown";
			if (s.kind === "interval") return `every ${s.every} ${s.unit}`;
			if (s.kind === "daily") return `every day at ${s.at}`;
			if (s.kind === "weekly") return `on weekdays ${(s.days ?? []).join(",")} at ${s.at}`;
			if (s.kind === "once") return `once at ${new Date(s.at).toISOString()}`;
			return String(s.kind ?? "manual");
		};
		pi.registerTool({
			name: "piper_schedule",
			label: "Schedule a recurring task",
			description:
				"Book a task to run again later on the gateway, even after this chat ends or its container is stopped: the server starts the container again to run it. " +
				"Use it when the user asks you to check, watch or repeat something every so often, daily or at a set time. The prompt is what you will be asked each run, so write it as a self-contained instruction. " +
				"Forms of schedule: {kind:'interval', every:<whole number>, unit:'minutes'|'hours'} (at most 7 days), {kind:'daily', at:'HH:MM'}, {kind:'weekly', days:[0-6, 0 is Sunday], at:'HH:MM'}, {kind:'once', at:'<ISO date and time>'}. Times are the gateway's local time. " +
				"Each run starts fresh but is shown your last few reports, so compare with them. With the default notify ('changes') the owner is told only when you have something new: if nothing changed since your last report, reply with exactly NO_CHANGE. " +
				"Results are shown to the user at the top of their next reply in this agent's chat. A task that fails several times in a row is switched off automatically.",
			promptSnippet: "Book a recurring task that runs on the gateway",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "A short name for the task." },
					prompt: { type: "string", description: "What to do each time it runs, as a complete instruction." },
					schedule: {
						type: "object",
						description: 'When to run it, e.g. {"kind":"interval","every":6,"unit":"hours"} or {"kind":"daily","at":"07:30"}.',
						properties: {
							kind: { type: "string", description: "interval, daily, weekly, once or manual." },
							every: { type: "number", description: "With interval: how many minutes or hours between runs." },
							unit: { type: "string", description: "With interval: minutes or hours." },
							at: { type: "string", description: "With daily or weekly: HH:MM. With once: an ISO date and time." },
							days: { type: "array", items: { type: "number" }, description: "With weekly: weekdays, 0 is Sunday." },
						},
						required: ["kind"],
					},
					session_mode: { type: "string", description: "memory (default) starts each run fresh but shows it your last reports; continue keeps one growing conversation; fresh starts with no memory at all." },
					notify: { type: "string", description: "changes (default): tell the owner only when the report differs from the last one; always: tell them every run; never: keep results on the gateway only." },
					timeout_ms: { type: "number", description: "How long one run may take, in milliseconds. Leave out for the default (10 minutes)." },
				},
				required: ["name", "prompt", "schedule"],
			},
			async execute(_toolCallId, params) {
				try {
					const answer = await readJson(await request("/schedule", { name: params?.name, prompt: params?.prompt, schedule: params?.schedule, sessionMode: params?.session_mode, notify: params?.notify, timeoutMs: params?.timeout_ms }));
					const s = answer.schedule;
					return reply(`Scheduled "${s.name}" (id ${s.id}): ${when(s.schedule)}${s.nextRunAt ? `, next run ${new Date(s.nextRunAt).toISOString()}` : ""}. It runs on the gateway, so it will run even if this chat is idle.`);
				} catch (err) {
					return reply(`Could not schedule it: ${err?.message ?? err}`);
				}
			},
		});
		pi.registerTool({
			name: "piper_schedules",
			label: "List schedules",
			description: "List the recurring tasks you have booked, with their ids and when each runs next.",
			promptSnippet: "List the recurring tasks you booked",
			parameters: { type: "object", properties: {} },
			async execute() {
				try {
					const { schedules } = await readJson(await request("/schedule"));
					if (!schedules.length) return reply("You have no scheduled tasks.");
					return reply(schedules.map((s) => `- ${s.id} "${s.name}": ${when(s.schedule)}, ${s.enabled ? "on" : `off${s.disabledReason ? ` (${s.disabledReason})` : ""}`}${s.nextRunAt ? `, next ${new Date(s.nextRunAt).toISOString()}` : ""}${s.last ? `, last run ${s.last.status}${s.last.preview ? `: ${String(s.last.preview).replace(/\s+/g, " ")}` : ""}` : ""}`).join("\n"));
				} catch (err) {
					return reply(`Could not list them: ${err?.message ?? err}`);
				}
			},
		});
		pi.registerTool({
			name: "piper_unschedule",
			label: "Remove a schedule",
			description: "Remove one of your scheduled tasks, by its id, so it stops running.",
			promptSnippet: "Remove a scheduled task you booked",
			parameters: { type: "object", properties: { id: { type: "string", description: "The schedule's id, from piper_schedules." } }, required: ["id"] },
			async execute(_toolCallId, params) {
				try {
					await readJson(await request("/schedule/remove", { id: String(params?.id ?? "") }));
					return reply(`Removed schedule ${params?.id}.`);
				} catch (err) {
					return reply(`Could not remove it: ${err?.message ?? err}`);
				}
			},
		});
		pi.registerTool({
			name: "piper_run_schedule",
			label: "Run a schedule now",
			description: "Start one of your scheduled tasks immediately, without waiting for its next time.",
			promptSnippet: "Run a scheduled task now",
			parameters: { type: "object", properties: { id: { type: "string", description: "The schedule's id, from piper_schedules." } }, required: ["id"] },
			async execute(_toolCallId, params) {
				try {
					const { run } = await readJson(await request("/schedule/run", { id: String(params?.id ?? "") }));
					return reply(`Started schedule ${params?.id} now (run ${run.id}, ${run.status}).`);
				} catch (err) {
					return reply(`Could not start it: ${err?.message ?? err}`);
				}
			},
		});
	}

	// Memory: notes that outlive this one chat. A key's own chats all share one memory, and so does a
	// named agent's — its own, or its key's, chosen when the agent was made. Never read or written
	// through this container's own filesystem: every call crosses the bridge, bound to this chat's
	// scope by the gateway, so a tool call can never name another key's or agent's memory.
	if (process.env.PIPER_MEMORY === "1") {
		const reply = (value) => ({ content: [{ type: "text", text: value }], details: {} });
		pi.registerTool({
			name: "piper_remember",
			label: "Remember a note",
			description:
				"Write (or update) a durable note under a short name, so it survives after this chat ends. Shared with every other chat of the same key or agent, so something you learn in one conversation is there in the next. " +
				"Use a short, specific name you (or a future chat) would think to look up again, e.g. \"deploy-steps\" or \"user-preferences\"; writing the same name again replaces it.",
			promptSnippet: "Remember a note for later",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "A short, specific name for the note. Writing it again replaces the old value." },
					value: { type: "string", description: "What to remember." },
				},
				required: ["name", "value"],
			},
			async execute(_toolCallId, params) {
				try {
					const { note } = await readJson(await request("/memory/write", { name: params?.name, value: params?.value }));
					return reply(`${note.updated ? "Updated" : "Remembered"} "${note.name}".`);
				} catch (err) {
					return reply(`Could not remember that: ${err?.message ?? err}`);
				}
			},
		});
		pi.registerTool({
			name: "piper_recall",
			label: "Recall a note",
			description: "Read back a note by its exact name. Use piper_memories first if you do not already know the name.",
			promptSnippet: "Recall a note by name",
			parameters: { type: "object", properties: { name: { type: "string", description: "The note's exact name, from piper_memories." } }, required: ["name"] },
			async execute(_toolCallId, params) {
				try {
					const { note } = await readJson(await request("/memory/read", { name: params?.name }));
					return reply(note.value);
				} catch (err) {
					return reply(`Could not recall that: ${err?.message ?? err}`);
				}
			},
		});
		pi.registerTool({
			name: "piper_memories",
			label: "Search notes",
			description: "List your notes, newest first, or search their names and content for a word or phrase. Leave the query out to see everything (up to the limit).",
			promptSnippet: "List or search your remembered notes",
			parameters: { type: "object", properties: { query: { type: "string", description: "A word or phrase to search for. Leave out to list everything." } } },
			async execute(_toolCallId, params) {
				try {
					const { notes } = await readJson(await request("/memory/lookup", { query: params?.query }));
					if (!notes.length) return reply(params?.query ? `No notes match "${params.query}".` : "You have no notes yet.");
					return reply(notes.map((n) => `- ${n.name} (${new Date(n.updatedAt).toLocaleString()}): ${n.preview}`).join("\n"));
				} catch (err) {
					return reply(`Could not search notes: ${err?.message ?? err}`);
				}
			},
		});
	}

	// The knowledge base: read and search only, available to every chat, not gated per agent — it is
	// something to draw on, not a capability like hand-offs. Never write or delete from here.
	if (process.env.PIPER_KNOWLEDGE === "1") {
		const reply = (value) => ({ content: [{ type: "text", text: value }], details: {} });
		pi.registerTool({
			name: "piper_knowledge_search",
			label: "Search the knowledge base",
			description: "Search what has been gathered into the knowledge base (RSS articles today, more later) by title, summary, tags and content. Leave the query out to see the newest entries.",
			promptSnippet: "Search the knowledge base",
			parameters: { type: "object", properties: { query: { type: "string", description: "A word or phrase to search for. Leave out to list the newest entries." } } },
			async execute(_toolCallId, params) {
				try {
					const { entries } = await readJson(await request("/knowledge/search", { query: params?.query }));
					if (!entries.length) return reply(params?.query ? `Nothing matches "${params.query}".` : "The knowledge base is empty.");
					return reply(entries.map((e) => `- #${e.id} ${e.title}${e.publishedAt ? ` (${new Date(e.publishedAt).toLocaleDateString()})` : ""}: ${e.summary || e.preview || ""}${e.tags && e.tags.length ? ` [${e.tags.join(", ")}]` : ""}`).join("\n"));
				} catch (err) {
					return reply(`Could not search: ${err?.message ?? err}`);
				}
			},
		});
		pi.registerTool({
			name: "piper_knowledge_read",
			label: "Read a knowledge base entry",
			description: "Read one entry's full text, by its id from piper_knowledge_search.",
			promptSnippet: "Read a knowledge base entry by id",
			parameters: { type: "object", properties: { id: { type: "number", description: "The entry's id, from piper_knowledge_search." } }, required: ["id"] },
			async execute(_toolCallId, params) {
				try {
					const { entry } = await readJson(await request("/knowledge/read", { id: params?.id }));
					return reply(`${entry.title}\n\n${entry.text}`);
				} catch (err) {
					return reply(`Could not read that: ${err?.message ?? err}`);
				}
			},
		});
	}

	// A new chat starts on the operator's current default model, unless the key's profile names its
	// own. The gateway sets PIPER_DEFAULT_MODEL only for new chats; a resumed one keeps its model.
	const defaultModel = process.env.PIPER_DEFAULT_MODEL;
	if (defaultModel) {
		pi.on("session_start", async (event, ctx) => {
			if (event.reason !== "startup") return;
			let own = {};
			try {
				own = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "settings.json"), "utf8"));
			} catch {
				/* no settings of its own */
			}
			if (!own.defaultModel) {
				// Model ids can contain slashes (Qwen/Qwen3-…), so only the first one splits off the provider.
				const slash = defaultModel.indexOf("/");
				const model = ctx.modelRegistry.find(defaultModel.slice(0, slash), defaultModel.slice(slash + 1));
				if (model) await pi.setModel(model);
			}
			const thinking = process.env.PIPER_DEFAULT_THINKING;
			if (thinking && !own.defaultThinkingLevel) pi.setThinkingLevel(thinking);
		});
	}

	// The key's workspace: tell the agent what it is, or it will treat it like scratch space. It outlives
	// every chat and every other chat of the key works in it too.
	const workspaceDir = process.env.PIPER_WORKSPACE_DIR;
	if (workspaceDir) {
		pi.on("before_agent_start", (event) => {
			const guidelines = (event.systemPromptOptions.promptGuidelines ??= []);
			const note =
				`${workspaceDir} is this API key's workspace: it persists, and every other chat of the same key works in it too and can read and change it. ` +
				`Keep this chat's own scratch files in a subfolder so they do not overwrite another chat's. ` +
				`Everything outside it (installed packages, the home directory) belongs to this chat's container alone.`;
			if (!guidelines.includes(note)) guidelines.push(note);
		});
	}

	// Extensions' own settings (the ones they would keep under ~/.pi) go to PI_CONFIG_DIR, which the
	// gateway points into the key's profile. Said explicitly, or an agent told "use Brave with key X"
	// writes ~/.pi/..., which lives in this chat's container only.
	const configDir = process.env.PI_CONFIG_DIR;
	if (configDir) {
		pi.on("before_agent_start", (event) => {
			const guidelines = (event.systemPromptOptions.promptGuidelines ??= []);
			const note =
				`Extensions that keep settings under ~/.pi read them from $PI_CONFIG_DIR (${configDir}) instead, e.g. ${configDir}/byte-pi-web/config.json. ` +
				`Settings written there persist across every chat on this API key; ~/.pi itself lives in this chat's container only.`;
			if (!guidelines.includes(note)) guidelines.push(note);
		});
	}

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
