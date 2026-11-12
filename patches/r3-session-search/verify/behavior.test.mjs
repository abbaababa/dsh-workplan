#!/usr/bin/env node
/**
 * R3 patch offline behavior verification (expert-patch, T3).
 * Runs the REAL engine lib (baseline or patched, via --lib) on a cordis Context
 * with synthetic persistence stubs. Proves, without touching the host:
 *   s1 smoke           happy path unchanged (hits, rows, generation, warm skip)
 *   s2 abort-progress  30s-style abort keeps committed progress; next call converges
 *   s3 isolation       one poison session does not sink the whole reconcile
 *   s4 fuse            all-fail cold reads still raise PERSISTENCE_FAILED (not silent)
 *   s5 churn           live-owned archive churn no longer destabilizes the round
 * Usage: node behavior.test.mjs --lib <lib/index.js> --label <name> --expect <baseline|patched>
 * All writes stay under verify/runs/<label>/ and verify/hostpkg/.
 */
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1 }
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const LIB = args.lib
const LABEL = args.label || 'run'
const EXPECT = args.expect || 'patched'
if (!LIB) { console.error('missing --lib'); process.exit(2) }

const RUNS = join(HERE, 'runs', LABEL)
rmSync(RUNS, { recursive: true, force: true })
mkdirSync(RUNS, { recursive: true })
const HOSTPKG = join(HERE, 'hostpkg')
mkdirSync(join(HOSTPKG, 'lib'), { recursive: true })
copyFileSync(LIB, join(HOSTPKG, 'lib', 'index.js'))
const { default: Engine } = await import(join(HOSTPKG, 'lib', 'index.js'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
function header(id) {
  return { version: 4, id, createdAt: 1794400000000, cwd: '/Users/open/Documents/Stocks', isSeeded: false }
}
function sysMsg() {
  return { seq: 0, type: 'system/message', time: 1794400000000, data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system head' }], source: { kind: 'test' } }, surfaceOp: 'append' }
}
function msg(seq, type, text, time) {
  const data = type === 'user/message'
    ? { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'test' } }
    : { message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text }] } }
  return { seq, type, time, data, surfaceOp: 'append' }
}
function sid(n) {
  const h = n.toString(16).padStart(8, '0')
  return `session-${h}-0000-4000-8000-000000000000`
}
function makeStore(ids, { delayMs = 0, failIds = new Set(), churnId = null } = {}) {
  const STORE = new Map(ids.map(id => [id, {
    header: header(id),
    revision: 'rev-1',
    events: [sysMsg(), msg(1, 'user/message', `hello R1 world in ${id.slice(8, 16)}`, 1794400000001), msg(2, 'assistant/message', 'second event alpha', 1794400000002)],
  }]))
  const counters = { list: 0, coldReads: 0 }
  let churnTick = 0
  const persistence = {
    async list() {
      counters.list += 1
      return [...STORE.values()].map(s => ({
        header: s.header,
        revision: s.header.id === churnId ? `rev-churn-${++churnTick}` : s.revision,
      }))
    },
    async open(id, mode) {
      if (mode !== 'read') throw new Error('stub is read-only')
      const s = STORE.get(id)
      if (!s) throw new Error(`no session ${id}`)
      if (delayMs > 0) await sleep(delayMs)
      if (failIds.has(id)) throw new Error(`poison pill in ${id}`)
      counters.coldReads += 1
      return {
        header: s.header,
        inheritedEventCount: 0,
        async read() { return { events: s.events, eventState: 'shared-frozen' } },
        async close() {},
      }
    },
  }
  return { persistence, counters }
}
async function withEngine(dbPath, persistence, sessions, fn) {
  const ctx = new Context()
  ctx.provide('sessions', sessions ?? { list: () => [], get: () => undefined })
  ctx.provide('sessionPersistence', persistence)
  ctx.plugin(Engine, { path: dbPath, openAt: 'first-search' })
  let engine
  for (let i = 0; i < 500; i += 1) {
    if (ctx.sessionQuery) { engine = ctx.sessionQuery; break }
    await sleep(5)
  }
  assert.ok(engine, 'engine service never activated')
  try { return await fn(engine) } finally { await engine.close() }
}
function inspect(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return {
      committedSessions: db.prepare('SELECT COUNT(*) AS n FROM persisted_sessions').get().n,
      committedDocs: db.prepare('SELECT COUNT(*) AS n FROM persisted_docs').get().n,
      globalGeneration: db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get().global_generation,
      rowGenerations: db.prepare('SELECT DISTINCT generation FROM persisted_sessions ORDER BY generation').all().map(r => r.generation),
      ids: db.prepare('SELECT id FROM persisted_sessions ORDER BY id').all().map(r => r.id),
    }
  } finally { db.close() }
}
async function call(engine, request, budgetMs, method = 'searchEvents') {
  const ac = new AbortController()
  const timer = budgetMs > 0 ? setTimeout(() => ac.abort(new Error(`budget ${budgetMs}ms`)), budgetMs) : undefined
  const t0 = performance.now()
  try {
    const page = await engine[method](request, { signal: ac.signal })
    return { outcome: 'ok', elapsedMs: Math.round(performance.now() - t0), hitCount: page.items.length, firstSeq: page.items[0]?.seq ?? null, firstId: page.items[0]?.header?.id ?? null }
  } catch (e) {
    return { outcome: 'error', code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200), causeMessage: e?.cause ? String(e.cause.message ?? e.cause).slice(0, 200) : null, elapsedMs: Math.round(performance.now() - t0) }
  } finally { if (timer) clearTimeout(timer) }
}

const results = { label: LABEL, expect: EXPECT, lib: LIB, nodeVersion: process.version, capturedAt: new Date().toISOString(), scenarios: {} }

// ---- s1 smoke: happy path unchanged -------------------------------------
{
  const ids = [sid(0x11), sid(0x22)]
  const { persistence, counters } = makeStore(ids)
  const dbPath = join(RUNS, 's1.sqlite')
  const r = await withEngine(dbPath, persistence, undefined, async (engine) => {
    const a = await call(engine, { sessionId: ids[0], query: 'R1' }, 0)
    const before = counters.coldReads
    const b = await call(engine, { sessionId: ids[1], query: 'R1' }, 0)
    return { a, b, warmColdReadsDelta: counters.coldReads - before }
  })
  const db = inspect(dbPath)
  assert.equal(r.a.outcome, 'ok'); assert.equal(r.a.hitCount, 1); assert.equal(r.a.firstSeq, 1)
  assert.equal(r.b.outcome, 'ok'); assert.equal(r.b.hitCount, 1)
  assert.equal(r.warmColdReadsDelta, 0)
  assert.equal(db.committedSessions, 2); assert.equal(db.globalGeneration, 1)
  results.scenarios.s1 = { ...r, db, pass: true }
}

// ---- s2 abort-progress: the R3 death-loop breaker ------------------------
{
  const ids = Array.from({ length: 40 }, (_, i) => sid(0x100 + i))
  const { persistence, counters } = makeStore(ids, { delayMs: 40 })
  const dbPath = join(RUNS, 's2.sqlite')
  const r = await withEngine(dbPath, persistence, undefined, async (engine) => {
    const req = { sessionId: ids[0], query: 'R1', filters: [{ kind: 'seq', from: 1 }] }
    const r1 = await call(engine, req, 300)
    const afterAbort = inspect(dbPath)
    const r2 = await call(engine, req, 0)
    const beforeWarm = counters.coldReads
    const r3 = await call(engine, req, 0)
    return { r1, afterAbort, r2, r3, warmColdReadsDelta: counters.coldReads - beforeWarm, coldReadsTotal: counters.coldReads }
  })
  const db = inspect(dbPath)
  assert.equal(r.r1.code, 'SESSION_QUERY_ABORTED')
  if (EXPECT === 'patched') assert.ok(r.afterAbort.committedSessions > 0, 'abort must keep committed progress')
  else assert.equal(r.afterAbort.committedSessions, 0, 'baseline loses all progress on abort')
  assert.equal(r.r2.outcome, 'ok'); assert.equal(r.r2.hitCount, 1)
  assert.equal(r.r3.outcome, 'ok'); assert.equal(r.warmColdReadsDelta, 0)
  assert.equal(db.committedSessions, 40)
  assert.equal(db.globalGeneration, 1)
  assert.deepEqual(db.rowGenerations, [1])
  results.scenarios.s2 = { ...r, db, pass: true }
}

// ---- s3 failure isolation: one poison session ----------------------------
{
  const ids = Array.from({ length: 5 }, (_, i) => sid(0x200 + i))
  const poison = ids[2]
  const { persistence } = makeStore(ids, { failIds: new Set([poison]) })
  const dbPath = join(RUNS, 's3.sqlite')
  const r = await withEngine(dbPath, persistence, undefined, async (engine) => {
    return { search: await call(engine, { sessionId: ids[0], query: 'R1' }, 0) }
  })
  const db = inspect(dbPath)
  if (EXPECT === 'patched') {
    assert.equal(r.search.outcome, 'ok'); assert.equal(r.search.hitCount, 1)
    assert.equal(db.committedSessions, 4)
    assert.ok(!db.ids.includes(poison), 'poison session must not be indexed')
  } else {
    assert.equal(r.search.code, 'SESSION_QUERY_PERSISTENCE_FAILED')
    assert.equal(db.committedSessions, 0)
  }
  results.scenarios.s3 = { ...r, db, poison, pass: true }
}

// ---- s4 zero-success fuse -------------------------------------------------
{
  const ids = Array.from({ length: 3 }, (_, i) => sid(0x300 + i))
  const { persistence } = makeStore(ids, { failIds: new Set(ids) })
  const dbPath = join(RUNS, 's4.sqlite')
  const r = await withEngine(dbPath, persistence, undefined, async (engine) => {
    return { search: await call(engine, { sessionId: ids[0], query: 'R1' }, 0) }
  })
  const db = inspect(dbPath)
  assert.equal(r.search.code, 'SESSION_QUERY_PERSISTENCE_FAILED')
  assert.ok(String(r.search.causeMessage ?? '').includes('poison pill'), 'first failure must surface as cause')
  assert.equal(db.committedSessions, 0)
  results.scenarios.s4 = { ...r, db, pass: true }
}

// ---- s5 churn: live-owned archive revision churn --------------------------
{
  const ids = [sid(0x401), sid(0x402), sid(0x403)]
  const churnId = ids[2]
  const { persistence } = makeStore(ids, { churnId })
  const liveEvents = [sysMsg(), msg(1, 'user/message', 'live R1 event', 1794400000001)]
  const liveSession = { id: churnId, header: header(churnId), inheritedEventCount: 0, snapshotEvents: () => liveEvents }
  const sessions = { list: () => [liveSession], get: id => (id === churnId ? liveSession : undefined) }
  const dbPath = join(RUNS, 's5.sqlite')
  const r = await withEngine(dbPath, persistence, sessions, async (engine) => {
    const search = await call(engine, { sessionId: ids[0], query: 'R1' }, 0)
    // temp.live_sessions is connection-local: prove the live row through the public API instead.
    const liveSearch = await call(engine, { query: 'R1', sessionFilters: [{ kind: 'availability', values: ['live'] }] }, 0, 'searchSessions')
    return { search, liveSearch }
  })
  const db = inspect(dbPath)
  if (EXPECT === 'patched') {
    assert.equal(r.search.outcome, 'ok'); assert.equal(r.search.hitCount, 1)
    assert.equal(db.committedSessions, 2)
    assert.equal(r.liveSearch.outcome, 'ok')
    assert.equal(r.liveSearch.hitCount, 1)
    assert.equal(r.liveSearch.firstId, churnId)
    assert.ok(!db.ids.includes(churnId), 'live-owned archive is shadowed by the live row')
  } else {
    assert.equal(r.search.code, 'SESSION_QUERY_PERSISTENCE_FAILED')
    assert.ok(r.search.message.includes('did not stabilize'))
  }
  results.scenarios.s5 = { ...r, db, churnId, pass: true }
}

console.log(JSON.stringify(results, null, 1))
console.log(`BEHAVIOR ${EXPECT.toUpperCase()} EXPECTATIONS ALL PASS (${LABEL})`)
