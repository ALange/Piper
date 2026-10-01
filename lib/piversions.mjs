/**
 * The Pi version in each container, for the Containers and Agents pages.
 *
 * Asking is a `docker cp` per container, so nothing on a page waits for it: what is cached is returned at
 * once and the rest is fetched in the background (at most three at a time), so the figures fill in over the
 * next poll or two. An entry is good for ten minutes and is dropped whenever the container is updated,
 * rebuilt, reset or removed, so a fix shows up green straight away.
 */
import { readPiVersion } from "./engine.mjs";

const TTL_MS = 10 * 60_000;
const MAX_PARALLEL = 3;

/** container name -> {id, version, source, at} */
const cache = new Map();
const queue = [];
const queued = new Set();
let running = 0;

/** Forget what was read for a container (it was updated, rebuilt, reset or removed). */
export function noteChanged(name) {
	cache.delete(name);
}

/** Forget everything (tests). */
export function resetPiVersions() {
	cache.clear();
	queue.length = 0;
	queued.clear();
	running = 0;
}

async function drain(read) {
	while (running < MAX_PARALLEL && queue.length) {
		const job = queue.shift();
		queued.delete(job.name);
		running++;
		void (async () => {
			try {
				const found = await read(job.name, { image: job.image });
				cache.set(job.name, { id: job.id, version: found.version, source: found.source, at: Date.now() });
			} catch {
				/* left unknown: asked again on the next poll */
			} finally {
				running--;
				void drain(read);
			}
		})();
	}
}

/**
 * The versions known now for `items` ([{name, id, image}]): Map name -> {version, source} for those cached
 * (and still the same container: a recreated one has a new id). The rest are queued to be read; this never waits.
 * `read` and `now` are parameters for the tests.
 */
export function piVersionsFor(items, { read = readPiVersion, now = Date.now() } = {}) {
	const out = new Map();
	// Containers that are gone leave entries behind; drop the ones past their time.
	if (cache.size > 200) for (const [name, hit] of cache) if (now - hit.at >= TTL_MS) cache.delete(name);
	for (const item of items) {
		const hit = cache.get(item.name);
		if (hit && hit.id === item.id && now - hit.at < TTL_MS) {
			out.set(item.name, { version: hit.version, source: hit.source });
			continue;
		}
		if (!queued.has(item.name)) {
			queued.add(item.name);
			queue.push({ name: item.name, id: item.id, image: item.image });
		}
	}
	void drain(read);
	return out;
}

/** How many reads are running or waiting (tests). */
export const piVersionsPending = () => running + queue.length;
