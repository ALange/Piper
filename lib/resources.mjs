/**
 * What the gateway and its machine are using right now, for the Overview page: the host's CPU, memory
 * and load, the gateway's own process, and the containers added up (with the heaviest few named).
 *
 * Everything here is read, cheaply: the host from /proc and `os`, the containers from one cached
 * `docker stats` (five seconds), disk from the measurement the disk guard already takes. A history of
 * the last hour is kept from the samples taken while a dashboard is open, so the charts are observed
 * data. Docker being unreachable leaves the container figures empty; it never breaks the page.
 */
import os from "node:os";
import { readFileSync } from "node:fs";
import { containerStats, listManaged } from "./engine.mjs";
import { diskState, diskSummary } from "./containers.mjs";
import { keyLabel } from "./auth.mjs";
import { agentScope } from "./agents.mjs";

const MB = 1024 * 1024;
const STATS_TTL_MS = 5000;
const SAMPLE_EVERY_MS = 15_000;
const KEEP_SAMPLES = 240;

/** Total and available memory from /proc/meminfo text, in bytes, or null when it does not say. */
export function parseMeminfo(text) {
	const kb = (name) => {
		const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(String(text));
		return m ? Number(m[1]) * 1024 : null;
	};
	const total = kb("MemTotal");
	const available = kb("MemAvailable");
	return total && available !== null ? { total, available } : null;
}

function hostMemory() {
	try {
		const parsed = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
		if (parsed) return parsed;
	} catch {
		/* not Linux, or not readable: what `os` knows */
	}
	return { total: os.totalmem(), available: os.freemem() };
}

/** Busy and total CPU time, summed over all cores (ms). */
export function cpuTimes(cpus = os.cpus()) {
	let busy = 0;
	let total = 0;
	for (const { times } of cpus) {
		const idle = times.idle + (times.iowait ?? 0);
		const all = times.user + times.nice + times.sys + times.idle + times.irq + (times.iowait ?? 0);
		total += all;
		busy += all - idle;
	}
	return { busy, total };
}

/** The share of CPU time spent busy between two `cpuTimes` readings, 0-100, or null when no time has passed. */
export function cpuPercent(prev, now) {
	const total = now.total - prev.total;
	return total > 0 ? Math.max(0, Math.min(100, (100 * (now.busy - prev.busy)) / total)) : null;
}

let prevHost = cpuTimes();
let prevProc = { at: Date.now(), cpu: process.cpuUsage() };
let statsCache = { at: 0, value: null };
let history = [];
let lastSample = 0;

/** Forget readings and history (tests). */
export function resetResources() {
	prevHost = cpuTimes();
	prevProc = { at: Date.now(), cpu: process.cpuUsage() };
	statsCache = { at: 0, value: null };
	history = [];
	lastSample = 0;
}

/**
 * The running containers added up, from one cached `docker stats`: how many, their CPU (100 = one core),
 * memory used and the limits that are set, processes, what they have written to their own filesystems, and
 * the five using the most memory. Null when Docker cannot be asked.
 */
export async function containerUsage({ now = Date.now(), list = listManaged, stats = containerStats } = {}) {
	if (statsCache.value !== undefined && statsCache.at && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
	let value = null;
	try {
		const managed = await list();
		const running = managed.filter((c) => c.state === "running");
		const usage = await stats(running.map((c) => c.name));
		const rows = running.map((c) => {
			const u = usage.get(c.name) ?? { cpu: 0, memUsed: 0, memLimit: 0, pids: 0 };
			const owner = c.keyId ? keyLabel(c.agentId ? agentScope(c.keyId, c.agentId) : c.keyId) : "(no key)";
			return { name: c.name, label: c.agentId || c.name.includes("-key-") ? `${owner} ★` : `${owner} chat`, cpu: u.cpu, memUsed: u.memUsed, memLimit: u.memLimit, pids: u.pids };
		});
		const written = [...diskState.containers.values()].reduce((n, d) => n + (d.rw ?? 0), 0);
		value = {
			running: running.length,
			total: managed.length,
			cpu: rows.reduce((n, r) => n + r.cpu, 0),
			memUsed: rows.reduce((n, r) => n + r.memUsed, 0),
			memLimit: rows.reduce((n, r) => n + (r.memLimit > 0 && r.memLimit < 1e15 ? r.memLimit : 0), 0),
			pids: rows.reduce((n, r) => n + r.pids, 0),
			writtenBytes: written,
			top: rows.sort((a, b) => b.memUsed - a.memUsed).slice(0, 5),
		};
	} catch {
		value = null;
	}
	statsCache = { at: now, value };
	return value;
}

/**
 * Everything the Overview's resource cards and charts show. `now` and `containers` are parameters for the
 * tests. The history gets a sample at most every 15 s, whoever asks.
 */
export async function resourceSnapshot({ now = Date.now(), containers } = {}) {
	const cores = os.cpus().length || 1;
	const cpuNow = cpuTimes();
	const hostCpu = cpuPercent(prevHost, cpuNow);
	prevHost = cpuNow;
	const mem = hostMemory();
	const procCpu = process.cpuUsage();
	const elapsedMs = Math.max(1, now - prevProc.at);
	const gatewayCpu = Math.max(0, ((procCpu.user + procCpu.system - prevProc.cpu.user - prevProc.cpu.system) / 1000 / elapsedMs) * 100);
	prevProc = { at: now, cpu: procCpu };
	const used = containers !== undefined ? containers : await containerUsage({ now });
	const usage = process.memoryUsage();
	const snapshot = {
		at: now,
		host: { cores, cpuPercent: hostCpu, load: os.loadavg(), memTotal: mem.total, memUsed: mem.total - mem.available, uptimeSec: os.uptime() },
		gateway: { rss: usage.rss, heapUsed: usage.heapUsed, cpuPercent: gatewayCpu, uptimeSec: process.uptime(), node: process.version },
		containers: used,
		disk: diskSummary(),
	};
	if (now - lastSample >= SAMPLE_EVERY_MS) {
		lastSample = now;
		history.push({
			t: now,
			cpu: hostCpu ?? 0,
			mem: mem.total ? (100 * (mem.total - mem.available)) / mem.total : 0,
			gateway: usage.rss / MB,
			containersCpu: used?.cpu ?? 0,
			containersMem: (used?.memUsed ?? 0) / MB,
		});
		if (history.length > KEEP_SAMPLES) history.shift();
	}
	snapshot.history = history;
	return snapshot;
}
