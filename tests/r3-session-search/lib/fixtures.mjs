/**
 * R3 regression suite — synthetic fixtures (no real user data).
 *
 * Builds fake session archives, a fake persistence service implementing the
 * exact seam the SQLite engine consumes (list / open / read / close), and
 * fake live sessions for ctx.sessions. Everything is deterministic and
 * in-process; archives live only in memory, the derived index lives in a
 * per-scenario temporary directory that the runner deletes afterwards.
 */
import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";

/** Common search token present in every synthetic session. */
export const MARKER = "zebraquark";

export function makeHeader(id, createdAt = 1700000000000) {
	return {
		id,
		version: SESSION_FORMAT_VERSION,
		createdAt,
		cwd: "/tmp/r3-fixture-workspace",
		isSeeded: false,
	};
}

/** Contiguous, surface-valid user/message log with searchable text. */
export function makeEvents(id, count, baseTime = 1700000000000) {
	const events = [];
	for (let i = 0; i < count; i += 1) {
		events.push({
			seq: i,
			type: "user/message",
			time: baseTime + i * 1000,
			surfaceOp: "append",
			data: {
				role: "user",
				content: [{ type: "text", text: `${MARKER} ${id} note${i} unique-${id}-${i}` }],
			},
		});
	}
	return events;
}

/** archives: Map<id, {header, events, revision}>; returns a persistence fake. */
export function createArchive(id, eventCount = 4) {
	return { header: makeHeader(id), events: makeEvents(id, eventCount), revision: "rev-0" };
}

export function makeLiveSession(header, events) {
	return {
		id: header.id,
		header,
		inheritedEventCount: 0,
		snapshotEvents: () => events.map((event) => structuredClone(event)),
	};
}

function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("synthetic abort"));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("synthetic abort"));
		}, { once: true });
	});
}

/**
 * Fake persistence backend.
 * opts:
 *  - archives: Map id -> {header, events, revision}
 *  - liveIds: Set of ids whose archive is owned by a live (active) session
 *  - churnLiveRevision: bump live-owned revisions on EVERY list() call,
 *    modelling an active workspace that keeps persisting while we observe
 *  - corruptIds: Set of ids whose open() throws (synthetic corruption)
 *  - readDelayMs: per-session cold-read latency (models slow full-corpus reads)
 *  - hooks: { onReadComplete(id) } — mutable callback fired after each cold read
 */
export function createFakePersistence(opts) {
	const {
		archives,
		liveIds = new Set(),
		churnLiveRevision = false,
		corruptIds = new Set(),
		readDelayMs = 0,
		hooks = {},
	} = opts;
	let listCalls = 0;
	let coldReads = 0;
	const check = (signal) => {
		if (signal?.aborted) throw new Error("synthetic abort");
	};
	return {
		identity: Symbol("r3-fake-persistence"),
		async list(options) {
			await tick();
			check(options?.signal);
			listCalls += 1;
			if (churnLiveRevision) {
				for (const id of liveIds) {
					const archive = archives.get(id);
					if (archive !== undefined) archive.revision = `rev-${listCalls}`;
				}
			}
			return [...archives.values()].map((archive) => ({
				header: structuredClone(archive.header),
				revision: archive.revision,
			}));
		},
		async open(id, mode, options) {
			check(options?.signal);
			if (corruptIds.has(id)) throw new Error(`synthetic corruption in archive "${id}"`);
			const archive = archives.get(id);
			if (archive === undefined) throw new Error(`unknown session "${id}"`);
			return {
				header: structuredClone(archive.header),
				inheritedEventCount: 0,
				async read(offset, limit, readOptions) {
					const signal = readOptions?.signal ?? options?.signal;
					await delay(readDelayMs, signal);
					check(signal);
					coldReads += 1;
					hooks.onReadComplete?.(id);
					return { events: structuredClone(archive.events), eventState: undefined };
				},
				async close() {},
			};
		},
		stats() {
			return { listCalls, coldReads };
		},
	};
}
