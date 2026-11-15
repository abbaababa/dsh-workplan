/**
 * R3 regression suite — engine harness.
 *
 * Mounts the engine under test (baseline or fixed, chosen by the runner) on a
 * real cordis Context with two synthetic services:
 *   - sessions:          the live-session registry (ctx.sessions.list/get)
 *   - sessionPersistence: the fake archive backend (list/open seam)
 *
 * The engine is constructed exactly like production does (new Engine(ctx,
 * config)); no engine internals are patched or stubbed. The only observability
 * added is read-only inspection of the derived SQLite index file.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

class SessionsService extends Service {
	constructor(ctx, map) {
		super(ctx, "sessions");
		this._map = map;
	}
	list() {
		return [...this._map.values()];
	}
	get(id) {
		return this._map.get(id);
	}
}

class PersistenceService extends Service {
	constructor(ctx, fake) {
		super(ctx, "sessionPersistence");
		this._fake = fake;
	}
	list(options) {
		return this._fake.list(options);
	}
	open(id, mode, options) {
		return this._fake.open(id, mode, options);
	}
}

async function settle() {
	for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Create one isolated engine instance.
 * @param {object} opts
 * @param {Function} opts.Engine - engine class under test (default export)
 * @param {string} opts.indexPath - derived-index SQLite file (fresh per scenario)
 * @param {Map} [opts.liveSessions] - live session stubs keyed by id
 * @param {object} [opts.persistence] - fake persistence backend
 */
export async function createEngine({ Engine, indexPath, liveSessions = new Map(), persistence }) {
	const ctx = new Context();
	new SessionsService(ctx, liveSessions);
	const engine = new Engine(ctx, { path: indexPath, openAt: "first-search" });
	if (persistence !== undefined) {
		new PersistenceService(ctx, persistence);
		await settle();
		if (engine._persistenceBinding.service === undefined) {
			throw new Error("harness error: sessionPersistence binding did not attach to the engine");
		}
	}
	return { ctx, engine };
}

/**
 * Read-only count of indexed persisted sessions (progress observable).
 * Missing file or not-yet-initialized schema both mean ZERO committed rows:
 * a pre-aborted search can leave a created-but-empty database file behind
 * (the engine's background open races the abort), which is not an error.
 */
export function countPersisted(indexPath) {
	if (!existsSync(indexPath)) return 0;
	let db;
	try {
		db = new DatabaseSync(indexPath, { readOnly: true });
		return db.prepare("SELECT COUNT(*) AS n FROM persisted_sessions").get().n;
	} catch (error) {
		if (String(error?.message ?? error).includes("no such table")) return 0;
		throw error;
	} finally {
		db?.close();
	}
}

/** Read-only list of indexed persisted session ids (same edge semantics). */
export function persistedIds(indexPath) {
	if (!existsSync(indexPath)) return [];
	let db;
	try {
		db = new DatabaseSync(indexPath, { readOnly: true });
		return db.prepare("SELECT id FROM persisted_sessions ORDER BY id").all().map((row) => row.id);
	} catch (error) {
		if (String(error?.message ?? error).includes("no such table")) return [];
		throw error;
	} finally {
		db?.close();
	}
}
