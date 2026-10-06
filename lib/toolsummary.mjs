/** One-line descriptions of tool calls, shared by the reasoning stream and the live view. */

/**
 * One line saying what a tool call does: the command for bash, the path for the file tools, and
 * compact arguments for anything else. Never the content being written, which can be large.
 */
export function toolActivity(toolName, args = {}) {
	const a = args && typeof args === "object" ? args : {};
	// Who it is handed to matters more than the tool's own name here, so that is the line, not the args as JSON.
	if (toolName === "piper_delegate" && typeof a.agent === "string") {
		return truncate(`${a.agent}: ${String(a.task ?? "").replace(/\s+/g, " ").trim()}`, 200);
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

export function truncate(text, max = 160) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}
