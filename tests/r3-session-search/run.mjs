#!/usr/bin/env node
/**
 * R3 regression runner — session-search reconciliation defects.
 *
 * Usage:
 *   node run.mjs                          # test the baseline lib (default)
 *   R3_LIB_PATH=/path/to/fixed/index.js node run.mjs   # test a fixed lib
 *   R3_EXPECT=baseline node run.mjs       # assert the baseline defect pattern
 *   R3_EXPECT=fixed    node run.mjs       # assert the fixed lib is all-green
 *
 * Exit code 0 = all checks passed (or the R3_EXPECT pattern matched exactly).
 * Every scenario runs in its own temporary directory with a fresh derived
 * index; synthetic fixtures only, no real user data, no network.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEngine, countPersisted } from "./lib/harness.mjs";
import { MARKER, createArchive, createFakePersistence, makeLiveSession, makeEvents, makeHeader } from "./lib/fixtures.mjs";

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = resolve(process.env.R3_LIB_PATH ?? join(SUITE_DIR, "vendor/baseline-lib/index.js"));
const EXPECT = process.env.R3_EXPECT ?? "";
const SCENARIO_TIMEOUT_MS = 30000;

/** Checks that MUST fail on the baseline lib (each captures one R3 failure surface). */
const BASELINE_EXPECTED_FAILURES = new Set(["S1.2", "S1.3", "S1.5", "S2.1", "S2.2", "S4.1", "S4.2"]);

const mod = await import(pathToFileURL(LIB_PATH).href);
const Engine = mod.default ?? mod.SqliteSessionQueryEngine;
if (typeof Engine !== "function") {
	console.error(`runner error: ${LIB_PATH} does not export an engine class`);
	process.exit(2);
}
const libSha256 = createHash("sha256").update(readFileSync(LIB_PATH)).digest("hex");

function log(line = "") {
	console.log(line);
}

async function withTimeout(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms watchdog`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function scenario(id, name, fn) {
	mkdirSync(join(SUITE_DIR, ".tmp"), { recursive: true });
	const dir = mkdtempSync(join(SUITE_DIR, ".tmp", `${id}-`));
	const checks = [];
	const add = (checkId, criterion, pass, evidence) => checks.push({ id: checkId, criterion, pass: Boolean(pass), evidence });
	log(`\n=== ${id} ${name} ===`);
	try {
		await withTimeout(fn({ dir, add }), SCENARIO_TIMEOUT_MS, id);
	} catch (error) {
		add(`${id}.0`, "scenario completed without unexpected harness error", false, String(error?.stack ?? error));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	for (const check of checks) log(`  [${check.pass ? "PASS" : "FAIL"}] ${check.id} ${check.criterion} — ${check.evidence}`);
	return { id, name, checks };
}

function itemIds(result) {
	return result.items.map((item) => item.header.id);
}

/* ------------------------------------------------------------------ */
/* S1 — abort mid-reconciliation must not discard all progress         */
/* (baseline: full cold read + single commit after whole-round         */
/*  stability → a 30s-style abort leaves ZERO indexed progress, so     */
/*  every retry re-reads everything: the zero-progress dead loop)      */
/* ------------------------------------------------------------------ */
async function s1({ dir, add }) {
	const indexPath = join(dir, "index.sqlite");
	const ids = Array.from({ length: 12 }, (_, i) => `cold-s1-${String(i).padStart(2, "0")}`);
	const archives = new Map(ids.map((id) => [id, createArchive(id, 4)]));
	const hooks = {};
	const persistence = createFakePersistence({ archives, readDelayMs: 40, hooks });
	const { engine } = await createEngine({ Engine, indexPath, persistence });
	try {
		// Round 1: abort after 3 completed cold reads (models the 30s tool abort).
		const ac1 = new AbortController();
		let reads1 = 0;
		hooks.onReadComplete = () => {
			reads1 += 1;
			if (reads1 === 3) ac1.abort();
		};
		let code1 = "resolved";
		try {
			await engine.searchSessions({ query: MARKER }, { signal: ac1.signal });
		} catch (error) {
			code1 = error?.code ?? String(error);
		}
		const progress1 = countPersisted(indexPath);
		add("S1.1", "aborted round rejects with SESSION_QUERY_ABORTED", code1 === "SESSION_QUERY_ABORTED", `outcome=${code1}, coldReads=${reads1}`);

		// Round 2: same abort point again (models the retry after timeout).
		const ac2 = new AbortController();
		let reads2 = 0;
		hooks.onReadComplete = () => {
			reads2 += 1;
			if (reads2 === 3) ac2.abort();
		};
		let code2 = "resolved";
		try {
			await engine.searchSessions({ query: MARKER }, { signal: ac2.signal });
		} catch (error) {
			code2 = error?.code ?? String(error);
		}
		const progress2 = countPersisted(indexPath);
		add("S1.2", "incremental progress survives the first abort (indexed sessions > 0)", progress1 > 0, `indexedAfterAbort1=${progress1}/12`);
		add("S1.3", "second abort does not reset progress to zero (no zero-progress dead loop)", progress2 > 0 && progress2 >= progress1, `indexedAfterAbort2=${progress2}/12, outcome2=${code2}, coldReadsRound2=${reads2}`);

		// Round 3: an un-aborted search must eventually succeed on BOTH libs.
		hooks.onReadComplete = undefined;
		const result = await engine.searchSessions({ query: MARKER });
		const found = itemIds(result);
		const totalReads = persistence.stats().coldReads;
		add("S1.4", "un-aborted search eventually indexes and returns all 12 sessions", ids.every((id) => found.includes(id)), `returned=${found.length}/12, totalColdReads=${totalReads}`);
		// Resume, not restart: with unchanged revisions no session may be cold-read
		// twice. Budget = 12 sessions + at most 1 in-flight read discarded per
		// aborted round (2 aborted rounds) = 14. Baseline re-reads the whole corpus
		// every round (3+3+12=18) — the redundant-work half of the dead loop.
		add("S1.5", "no redundant full-corpus re-reads across retries (totalColdReads <= 14)", totalReads <= 14, `totalColdReads=${totalReads} (baseline signature: 18 = 3+3+12 full restarts)`);
	} finally {
		await engine.close();
	}
}

/* ------------------------------------------------------------------ */
/* S2 — live-owned archive revision churn must not fail the round      */
/* (baseline: whole-round stability compares EVERY archive revision,   */
/*  including the live-owned one that an active workspace keeps        */
/*  rewriting → observation never stabilizes → search always fails)    */
/* ------------------------------------------------------------------ */
async function s2({ dir, add }) {
	const indexPath = join(dir, "index.sqlite");
	const coldIds = Array.from({ length: 6 }, (_, i) => `cold-s2-${String(i).padStart(2, "0")}`);
	const liveId = "live-s2-active";
	const archives = new Map(coldIds.map((id) => [id, createArchive(id, 3)]));
	const liveHeader = makeHeader(liveId);
	const liveEvents = makeEvents(liveId, 3);
	archives.set(liveId, { header: liveHeader, events: liveEvents, revision: "rev-0" });
	const liveSessions = new Map([[liveId, makeLiveSession(liveHeader, liveEvents)]]);
	const persistence = createFakePersistence({
		archives,
		liveIds: new Set([liveId]),
		churnLiveRevision: true,
		readDelayMs: 5,
	});
	const { engine } = await createEngine({ Engine, indexPath, liveSessions, persistence });
	try {
		let result;
		let failure = "";
		try {
			result = await engine.searchSessions({ query: MARKER });
		} catch (error) {
			failure = `${error?.code ?? ""}: ${error?.message ?? error}`;
		}
		add("S2.1", "search succeeds while the live-owned archive revision keeps changing", result !== undefined, failure === "" ? `returned=${result.items.length} items, listCalls=${persistence.stats().listCalls}` : failure);
		const found = result === undefined ? [] : itemIds(result);
		add("S2.2", "all 6 stable cold sessions are searchable despite live churn", coldIds.every((id) => found.includes(id)), `found=${found.filter((id) => coldIds.includes(id)).length}/6`);
	} finally {
		await engine.close();
	}
}

/* ------------------------------------------------------------------ */
/* S3 — control: a static corpus must search correctly on BOTH libs    */
/* (guards against a suite that is red for the wrong reason)           */
/* ------------------------------------------------------------------ */
async function s3({ dir, add }) {
	const indexPath = join(dir, "index.sqlite");
	const ids = Array.from({ length: 5 }, (_, i) => `cold-s3-${String(i).padStart(2, "0")}`);
	const archives = new Map(ids.map((id) => [id, createArchive(id, 3)]));
	const persistence = createFakePersistence({ archives, readDelayMs: 1 });
	const { engine } = await createEngine({ Engine, indexPath, persistence });
	try {
		const result = await engine.searchSessions({ query: MARKER });
		const found = itemIds(result);
		add("S3.1", "static corpus: search returns all 5 sessions", ids.every((id) => found.includes(id)), `returned=${found.length}/5`);
		const snippetsOk = result.items.every((item) => item.bestMatch.snippet.includes(MARKER));
		add("S3.2", "static corpus: every hit snippet contains the search token", snippetsOk, `snippetsWithMarker=${result.items.filter((item) => item.bestMatch.snippet.includes(MARKER)).length}/${result.items.length}`);
		const target = ids[0];
		const events = await engine.searchEvents({ sessionId: target, query: `unique-${target}-0` });
		add("S3.3", "static corpus: within-session event search finds the unique token", events.items.length >= 1, `eventHits=${events.items.length}`);
		const readsBefore = persistence.stats().coldReads;
		const warm = await engine.searchSessions({ query: MARKER });
		const readsAfter = persistence.stats().coldReads;
		add("S3.4", "warm re-search reuses the index (zero additional cold reads)", readsAfter === readsBefore && warm.items.length === 5, `coldReadsDelta=${readsAfter - readsBefore}, warmHits=${warm.items.length}/5`);
	} finally {
		await engine.close();
	}
}

/* ------------------------------------------------------------------ */
/* S4 — one corrupt archive must be isolated, not fail the whole round */
/* (baseline: any cold-read failure aborts the entire observation;     */
/*  fixed: per-session failure isolation keeps healthy sessions going) */
/* ------------------------------------------------------------------ */
async function s4({ dir, add }) {
	const indexPath = join(dir, "index.sqlite");
	const healthyIds = Array.from({ length: 6 }, (_, i) => `cold-s4-${String(i).padStart(2, "0")}`);
	const corruptId = "cold-s4-corrupt";
	const archives = new Map(healthyIds.map((id) => [id, createArchive(id, 3)]));
	archives.set(corruptId, createArchive(corruptId, 3));
	const persistence = createFakePersistence({ archives, corruptIds: new Set([corruptId]), readDelayMs: 1 });
	const { engine } = await createEngine({ Engine, indexPath, persistence });
	try {
		let result;
		let failure = "";
		try {
			result = await engine.searchSessions({ query: MARKER });
		} catch (error) {
			failure = `${error?.code ?? ""}: ${error?.message ?? error}`;
		}
		add("S4.1", "search succeeds even though one archive is corrupt (failure isolation)", result !== undefined, failure === "" ? `returned=${result.items.length} items` : failure);
		const found = result === undefined ? [] : itemIds(result);
		add("S4.2", "all 6 healthy sessions remain searchable", healthyIds.every((id) => found.includes(id)), `found=${found.filter((id) => healthyIds.includes(id)).length}/6`);
	} finally {
		await engine.close();
	}
}

/* ------------------------------------------------------------------ */

log("R3 session-search regression suite");
log(`time:       ${new Date().toISOString()}`);
log(`node:       ${process.version}`);
log(`lib:        ${LIB_PATH}`);
log(`lib sha256: ${libSha256}`);
log(`expect:     ${EXPECT === "" ? "(none: exit 0 only if every check passes)" : EXPECT}`);

const results = [];
results.push(await scenario("S1", "abort mid-reconciliation keeps incremental progress", s1));
results.push(await scenario("S2", "live-owned revision churn does not fail reconciliation", s2));
results.push(await scenario("S3", "control: static corpus searches correctly", s3));
results.push(await scenario("S4", "corrupt archive is isolated from healthy sessions", s4));

const allChecks = results.flatMap((r) => r.checks);
const failures = allChecks.filter((c) => !c.pass);
log("\n=== summary ===");
log(`checks: ${allChecks.length}, passed: ${allChecks.length - failures.length}, failed: ${failures.length}`);
if (failures.length > 0) log(`failed: ${failures.map((c) => c.id).join(", ")}`);

let verdict;
if (EXPECT === "baseline") {
	const observed = new Set(failures.map((c) => c.id));
	const exact = observed.size === BASELINE_EXPECTED_FAILURES.size && [...observed].every((id) => BASELINE_EXPECTED_FAILURES.has(id));
	verdict = exact;
	log(`baseline pattern: ${exact ? "MATCH — suite captures the R3 defects (expected reds only)" : "MISMATCH — observed failures differ from the expected defect pattern"}`);
	if (!exact) {
		log(`  expected failures: ${[...BASELINE_EXPECTED_FAILURES].join(", ")}`);
		log(`  observed failures: ${[...observed].join(", ") || "(none)"}`);
	}
} else if (EXPECT === "fixed") {
	verdict = failures.length === 0;
	log(`fixed-lib gate: ${verdict ? "ALL GREEN — R3 defects are fixed" : "NOT GREEN — remaining failures above"}`);
} else {
	verdict = failures.length === 0;
	log(`result: ${verdict ? "ALL CHECKS PASSED" : "FAILURES PRESENT"}`);
}

writeFileSync(join(SUITE_DIR, "last-results.json"), `${JSON.stringify({ time: new Date().toISOString(), node: process.version, lib: LIB_PATH, libSha256, expect: EXPECT, verdict, results }, null, 2)}\n`);
log(`\nverdict: ${verdict ? "OK" : "NOT OK"} (details in last-results.json)`);
process.exit(verdict ? 0 : 1);
