/**
 * What a live chat is doing, kept in memory for the dashboard's session view.
 *
 * Each session record gets one `LiveLog`, fed from the Pi session's events. It keeps the last `MAX_ITEMS` items
 * (a user message, an assistant message, thinking, a tool call, a note), the text of each capped, with the deltas of
 * a message folded into the item rather than kept one by one. Watchers get the current items, then each change.
 * Nothing is written to disk and it goes with the session. The real session id is never in it.
 */
import { toolActivity } from "./toolsummary.mjs";

export const MAX_ITEMS = 300;
export const MAX_TEXT = 16 * 1024;
export const MAX_RESULT = 2 * 1024;

const cap = (text, max) => {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** The text of a message's content: a string, or the text blocks of an array. */
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "");

export class LiveLog {
	#items = [];
	#seq = 0;
	#watchers = new Set();
	#state = { working: false };
	#current = null;
	#thinking = null;
	#tools = new Map();
	ended = false;

	get watchers() {
		return this.#watchers.size;
	}

	/** The items now and the state, as a watcher first sees them. */
	snapshot() {
		return { items: this.#items.map((i) => ({ ...i })), state: { ...this.#state } };
	}

	/** Receive changes: `fn({op, item?, state?})`. Returns the unsubscribe. */
	subscribe(fn) {
		this.#watchers.add(fn);
		return () => this.#watchers.delete(fn);
	}

	#emit(change) {
		for (const fn of [...this.#watchers]) {
			try {
				fn(change);
			} catch {
				this.#watchers.delete(fn);
			}
		}
	}

	#add(kind, fields) {
		const item = { id: ++this.#seq, kind, at: Date.now(), ...fields };
		this.#items.push(item);
		while (this.#items.length > MAX_ITEMS) this.#items.shift();
		this.#emit({ op: "add", item: { ...item } });
		return item;
	}

	#update(item) {
		this.#emit({ op: "update", item: { ...item } });
	}

	/** A note from the gateway itself (an interrupt, a hand-off to a colleague). */
	note(text) {
		this.#add("note", { text: cap(text, 400) });
	}

	/** Set what the header shows: `{working, model, tokens, cost}`; only the fields given change. */
	setState(patch) {
		const next = { ...this.#state, ...patch };
		if (JSON.stringify(next) === JSON.stringify(this.#state)) return;
		this.#state = next;
		this.#emit({ op: "state", state: { ...next } });
	}

	/** Take one Pi session event. Unknown events are ignored. */
	feed(event) {
		if (!event || this.ended) return;
		switch (event.type) {
			case "agent_start":
				this.setState({ working: true });
				return;
			case "agent_settled":
			case "agent_end":
				this.#current = null;
				this.#thinking = null;
				this.setState({ working: false });
				return;
			case "compaction_start": {
				const label = event.reason === "overflow" ? "the context overflowed; compacting" : event.reason === "threshold" ? "context is getting full; compacting automatically" : "compacting the context";
				this.note(`${label}\u2026`);
				return;
			}
			case "compaction_end": {
				if (event.aborted) {
					this.note("compaction was interrupted; nothing changed");
					return;
				}
				if (event.errorMessage) {
					this.note(`compaction failed: ${event.errorMessage}`);
					return;
				}
				const before = event.result?.tokensBefore;
				const after = event.result?.estimatedTokensAfter;
				this.note(`compacted the context: ${before ?? "?"} \u2192 ${after ?? "?"} tokens`);
				if (typeof after === "number") this.setState({ contextTokens: after });
				return;
			}
			case "message_start": {
				const role = event.message?.role;
				if (role === "user") {
					const text = textOf(event.message.content);
					if (text) this.#add("user", { text: cap(text, MAX_TEXT) });
				} else if (role === "assistant") {
					this.#current = null;
					this.#thinking = null;
				}
				return;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update?.type === "text_delta" && update.delta) {
					this.#current ??= this.#add("assistant", { text: "" });
					if (this.#current.text.length < MAX_TEXT) this.#current.text = cap(this.#current.text + update.delta, MAX_TEXT);
					this.#update(this.#current);
				} else if (update?.type === "thinking_delta" && update.delta) {
					this.#thinking ??= this.#add("thinking", { text: "" });
					if (this.#thinking.text.length < MAX_TEXT) this.#thinking.text = cap(this.#thinking.text + update.delta, MAX_TEXT);
					this.#update(this.#thinking);
				} else if (update?.type === "text_start") {
					this.#current = null;
				} else if (update?.type === "thinking_start") {
					this.#thinking = null;
				}
				return;
			}
			case "tool_execution_start": {
				// The next text is a new message after the tool.
				this.#current = null;
				this.#thinking = null;
				const item = this.#add("tool", { name: String(event.toolName ?? "tool"), summary: toolActivity(event.toolName, event.args), state: "running" });
				if (event.toolCallId) this.#tools.set(event.toolCallId, item);
				return;
			}
			case "tool_execution_end": {
				const item = this.#tools.get(event.toolCallId);
				this.#tools.delete(event.toolCallId);
				if (!item) return;
				item.state = event.isError ? "error" : "done";
				item.result = cap(textOf(event.result?.content), MAX_RESULT);
				this.#update(item);
				return;
			}
			default:
		}
	}

	/** The session is gone: tell watchers, and refuse further events. */
	end(reason = "the session ended") {
		if (this.ended) return;
		this.ended = true;
		this.#emit({ op: "end", reason });
		this.#watchers.clear();
		this.#tools.clear();
	}
}
