/** One-line descriptions of tool calls, shared by the reasoning stream and the live view. */

/**
 * One line saying what a tool call does: the command for bash, the path for the file tools, and
 * compact arguments for anything else. Never the content being written, which can be large.
 */
export function toolActivity(toolName, args = {}) {
	const a = args && typeof args === "object" ? args : {};
	// Who it is handed to matters more than the tool's own name here, so that is the line, not the args as
	// JSON — and the task is kept long enough to show in full in an expanded view, not just a one-line hint.
	if (toolName === "piper_delegate" && typeof a.agent === "string") {
		return truncate(`${a.agent}: ${String(a.task ?? "").replace(/\s+/g, " ").trim()}`, 4000);
	}
	let what;
	if (typeof a.command === "string") what = a.command;
	else if (typeof a.path === "string") what = a.path + (typeof a.pattern === "string" ? `  ${a.pattern}` : "");
	else {
		const { content, ...rest } = a;
		what = JSON.stringify(rest);
	}
	return `${toolName}: ${truncate(String(what).replace(/\s+/g, " ").trim(), 200)}`;
}

/**
 * The same "what" as `toolActivity`, but kept whole (not squashed to one line, not capped to a
 * one-line-excerpt length) -- for the expanded view of a tool call, where the full command matters
 * more than fitting on one line. Still never the raw `content` a write tool was given, which can be
 * large and isn't "the command" anyway.
 */
export function toolDetail(toolName, args = {}) {
	const a = args && typeof args === "object" ? args : {};
	if (toolName === "piper_delegate" && typeof a.agent === "string") return truncate(String(a.task ?? ""), 4000);
	if (typeof a.command === "string") return truncate(a.command, 4000);
	if (typeof a.path === "string") return truncate(a.path + (typeof a.pattern === "string" ? `  ${a.pattern}` : ""), 4000);
	const { content, ...rest } = a;
	return truncate(JSON.stringify(rest, null, 2), 4000);
}

export function truncate(text, max = 160) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}
