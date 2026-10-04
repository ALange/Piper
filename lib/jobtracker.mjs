/**
 * The one thing genuinely shared by the host's own long-running jobs (an image build, a host or container
 * update, an extension or package install): each keeps its own job shape (what a job needs differs module
 * to module, and so does what "busy" should say), but every one of them keeps a log that must not grow
 * without bound while the job runs. This is that, factored out once instead of copy-pasted in each.
 */

/** Append a line to a job's log, trimmed back to `keep` once it has grown to twice that. */
export function appendLog(lines, line, keep) {
	lines.push(line);
	if (lines.length > keep * 2) lines.splice(0, lines.length - keep);
}
