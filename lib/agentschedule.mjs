/**
 * Agent-created schedules: the server side of the bridge's scheduling tools.
 *
 * An agent talks to the gateway over its chat's own bridge socket (lib/runner.mjs), which is bound to that chat's
 * record, so the caller's key and agent come from the record and never from the request. With scheduling switched on
 * globally (AGENT_JOBS_ENABLED) and for the agent (its own can_schedule switch, like can_delegate), the tools the bridge
 * registers can create, list, run and remove jobs of the agent's own key and scope.
 *
 * A job is the same server-side job the Jobs page makes, stored in the gateway's database. It runs whether or not a
 * container is up: the scheduler is in the gateway process, and each run starts (or resumes) the agent's container
 * itself. What an agent may not do is name another key's or agent's job, or set a completion webhook (only the
 * operator does that). Only jobs the agent created are visible to it and removable by it.
 */
import { config } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { createJob, deleteJob, listJobs, listRuns, queueRun } from "./jobs.mjs";

const MAX_NAME = 80;

/** Whether this chat's agent may create schedules at all, now. */
export function maySchedule(record) {
	if (!config.AGENT_JOBS_ENABLED || !record?.agentId) return false;
	return Boolean(agents.get(record.agentId)?.canSchedule);
}

function requireSchedule(record) {
	if (!maySchedule(record)) throw new Error("this agent may not create schedules");
}

/** The schedules this agent created for itself. The operator's jobs for the same agent are deliberately not here. */
const ownJobs = (record) => listJobs({ keyId: record.keyId }).filter((j) => j.agentId === record.agentId && j.origin === "agent");

/** A compact view: what the model needs to name a schedule, and what it will do. */
const brief = (j) => ({
	id: j.id,
	name: j.name,
	prompt: j.prompt,
	schedule: j.schedule,
	scheduleText: j.scheduleText,
	sessionMode: j.sessionMode,
	notify: j.notify,
	enabled: j.enabled,
	disabledReason: j.disabledReason,
	nextRunAt: j.nextRunAt,
	last: j.last ? { status: j.last.status, endedAt: j.last.endedAt, preview: listRuns(j.id, 1)[0]?.preview ?? "" } : null,
});

/**
 * What the bridge hands to a chat's socket: `{create, list, run, remove}`. Bound to `record`, so a tool call cannot name
 * another key's or agent's jobs. Errors carry a message for the calling agent to read.
 */
export function schedulerFor(record) {
	requireSchedule(record);
	const mine = (id) => {
		const job = ownJobs(record).find((j) => j.id === String(id ?? ""));
		if (!job) throw new Error("there is no such schedule of yours; list them first");
		return job;
	};
	return {
		create({ name, prompt, schedule, sessionMode = "memory", notify = "changes", timeoutMs } = {}) {
			requireSchedule(record);
			const cap = Number(config.AGENT_JOBS_MAX_PER_AGENT ?? 10);
			if (ownJobs(record).length >= cap) throw new Error(`this agent already has ${cap} schedules, the most it may have; remove one first`);
			const made = createJob({
				keyId: record.keyId,
				agentId: record.agentId,
				name: String(name ?? "").trim().slice(0, MAX_NAME),
				prompt,
				// A recurring task starts fresh each run but is shown its last reports ("memory"), so it can compare without a growing
				// conversation; the result reaches the owner when it differs from the last one. The spend cap is the operator's to set.
				sessionMode,
				notify,
				schedule: schedule ?? { kind: "manual" },
				timeoutMs,
				origin: "agent",
			});
			return brief(made.job);
		},
		list() {
			requireSchedule(record);
			return ownJobs(record).map(brief);
		},
		run({ id } = {}) {
			requireSchedule(record);
			return queueRun(mine(id).id, "manual");
		},
		remove({ id } = {}) {
			requireSchedule(record);
			deleteJob(mine(id).id);
			return true;
		},
	};
}
