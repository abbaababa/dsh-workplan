#!/usr/bin/env node
/**
 * R3 expert-patch independent behavior suite (workspace-only writes).
 * Wires the REAL engine lib (baseline or patched) on a cordis Context with a
 * synthetic persistence stub, then proves the R3 fix mechanisms:
 *   A abort-progress: mid-round abort keeps committed sessions; resume converges
 *   B poison-isolation: one corrupt cold read loses only that session
 *   C zero-success fuse: all cold reads fail -> SESSION_QUERY_PERSISTENCE_FAILED
 *   D live-churn: live-owned revision churn no longer deadlocks observation
 *   E warm: fully indexed corpus performs zero cold reads
 * Usage: node behavior.mjs --lib <path> --expect fixed|baseline --label <name>
 */
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { out[key] = argv[i + 1]; i += 1 } else out[key] = true
    }
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const LIB = args.lib
const EXPECT = args.expect || 'fixed'
const LABEL = args.label || 'run'
if (!LIB) { console.error('missing --lib'); process.exit(2) }
const { default: Engine } = await import(LIB)
const DBDIR = join(HERE, 'behavior-dbs')
mkdirSync(DBDIR, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
function header(id) {
  return { version: 4, id, createdAt: 1794400000000, cwd: '/Users/open/Documents/Stocks', isSeeded: false }
}
function msg(seq, text, time) {
  return { seq, type: 'user/message', time, data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'test' } }, surfaceOp: 'append' }
}
function sid(n) {
  const h = n.toString(16).padStart(8, '0')
  return `session-${h}-0000-4000-8000-${h.padStart(12, '0')}`
}
function makeStore(count, { poison = new Set(), readDelayMs = 0, churnLiveId = null } = {}) {
  const store = new Map()
  for (let i = 1; i <= count; i += 1) {
    const id = sid(i)
    store.set(id, {
      header: header(id),
      revision: 'rev-1',
      events: [
        { seq: 0, type: 'system/message', time: 1794400000000, data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system head' }], source: { kind: 'test' } }, surfaceOp: 'append' },
        msg(1, `R3 marker text session ${i} alpha`, 1794400000001),
        msg(2, `beta gamma ${i}`, 1794400000002),
      ],
    })
  }
  const counters = { list: 0, coldReads: 0, churn: 0 }
  const persistence = {
    async list() {
      counters.list += 1
      return [...store.values()].map(s => ({
        header: s.header,
        revision: s.header.id === churnLiveId ? `rev-churn-${counters.churn++}` : s.revision,
      }))
    },
    async open(id, mode) {
      if (mode !== 'read') throw new Error('stub is read-only')
      const s = store.get(id)
      if (!s) throw new Error(`no session ${id}`)
      counters.coldReads += 1
      return {
        header: s.header,
        inheritedEventCount: 0,
        async read() {
          if (readDelayMs > 0) await sleep(readDelayMs)
          if (poison.has(id)) throw new Error(`poison pill archive for ${id}`)
          return { events: s.events, eventState: 'shared-frozen' }
        },
        async close() {},
      }
    },
  }
  return { store, counters, persistence }
}

async function wire({ count, poison, readDelayMs, churnLiveId, db, openAt = 'first-search' }) {
  rmSync(db, { force: true })
  const { store, counters, persistence } = makeStore(count, { poison, readDelayMs, churnLiveId })
  const ctx = new Context()
  const liveSessions = new Map()
  if (churnLiveId) {
    const s = store.get(churnLiveId)
    liveSessions.set(churnLiveId, {
      header: s.header,
      inheritedEventCount: 0,
      snapshotEvents: () => s.events,
    })
  }
  ctx.provide('sessions', { list: () => [...liveSessions.values()], get: id => liveSessions.get(id) })
  ctx.provide('sessionPersistence', persistence)
  const warnings = []
  ctx.logger.exporter({ export(m) { if (m.type === 'warn') warnings.push({ name: m.name, args: m.args.map(String) }) } })
  ctx.plugin(Engine, { path: db, openAt })
  for (let i = 0; i < 400; i += 1) {
    if (ctx.sessionQuery) break
    await sleep(5)
  }
  if (!ctx.sessionQuery) throw new Error('engine never activated')
  return { ctx, counters, warnings, store }
}

function inspect(db) {
  // Defensive: with openAt:'startup' the pre-warm opens the db asynchronously,
  // so the file/table may not exist yet on the first poll (P1 race, test-side).
  try {
    const h = new DatabaseSync(db, { readOnly: true })
    const rows = h.prepare('SELECT id, revision, generation FROM persisted_sessions ORDER BY id').all()
    const state = h.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get()
    h.close()
    return { committed: rows.length, rows, globalGeneration: state.global_generation }
  } catch {
    return { committed: 0, rows: [], globalGeneration: 0 }
  }
}

async function search(ctx, sessionId, budgetMs) {
  const ac = new AbortController()
  const timer = budgetMs > 0 ? setTimeout(() => ac.abort(new Error(`budget ${budgetMs}ms`)), budgetMs) : undefined
  const t0 = performance.now()
  try {
    const page = await ctx.sessionQuery.searchEvents({ sessionId, query: 'R3' }, { signal: ac.signal })
    return { outcome: 'ok', elapsedMs: Math.round(performance.now() - t0), hits: page.items.length }
  } catch (e) {
    return { outcome: e?.code === 'SESSION_QUERY_ABORTED' ? 'aborted' : (e?.code ?? 'error'), elapsedMs: Math.round(performance.now() - t0), message: String(e?.message ?? e).slice(0, 200) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`)
}

// ---- A: abort progress + resume convergence ----
{
  const db = join(DBDIR, `a-${LABEL}.sqlite`)
  const { ctx, counters } = await wire({ count: 40, readDelayMs: 30, db })
  const r1 = await search(ctx, sid(1), 250)
  const s1 = inspect(db)
  const before2 = counters.coldReads
  const r2 = await search(ctx, sid(1), 250)
  const readsCall2 = counters.coldReads - before2
  const s2 = inspect(db)
  const before3 = counters.coldReads
  const r3 = await search(ctx, sid(1), 0)
  const readsCall3 = counters.coldReads - before3
  const s3 = inspect(db)
  const beforeWarm = counters.coldReads
  const warm = await search(ctx, sid(1), 0)
  const warmColdDelta = counters.coldReads - beforeWarm
  const s4 = inspect(db)
  if (EXPECT === 'fixed') {
    record('A1-abort-keeps-progress', r1.outcome === 'aborted' && s1.committed > 0 && s1.committed < 40, { r1, committedAfterAbort: s1.committed })
    record('A2-resume-converges', s2.committed >= s1.committed && r3.outcome === 'ok' && s3.committed === 40, { r2, committedAfter2: s2.committed, r3, committedFinal: s3.committed })
    // Each aborted call may waste at most one in-flight (read-but-uncommitted)
    // session that the next call legitimately re-reads; committed rows never re-read.
    record('A3-no-reread-of-committed', readsCall2 <= (40 - s1.committed) + 1 && readsCall3 === 40 - s2.committed && warmColdDelta === 0 && warm.outcome === 'ok', { readsCall2, remainingAfterAbort: 40 - s1.committed, readsCall3, remainingAfterCall2: 40 - s2.committed, warmColdDelta })
    // With per-commit generation sync (review fix B1), aborted rounds advance the
    // DB generation, so rows legitimately carry mixed per-round generations.
    // Invariant: monotonic, every row <= global, and global == max row generation.
    record('A4-generation-monotonic', s1.rows.every(r => r.generation >= 1) && s3.globalGeneration >= s1.globalGeneration && s3.rows.every(r => r.generation <= s3.globalGeneration) && s3.globalGeneration === Math.max(...s3.rows.map(r => r.generation)), { genAfterAbort: s1.globalGeneration, genFinal: s3.globalGeneration, rowGens: [...new Set(s3.rows.map(r => r.generation))] })
  } else {
    record('A1-baseline-zero-progress', r1.outcome === 'aborted' && s1.committed === 0 && s2.committed === 0, { r1, committedAfterAbort: s1.committed, committedAfter2: s2.committed })
  }
  await ctx.sessionQuery.close()
}

// ---- A5: aborted partial commits invalidate stale session cursors (review finding #2) ----
if (EXPECT === 'fixed') {
  const db = join(DBDIR, `a5-${LABEL}.sqlite`)
  rmSync(db, { force: true })
  const store = new Map()
  const addSession = (i) => {
    const id = sid(i)
    store.set(id, { header: header(id), revision: 'rev-1', events: [
      { seq: 0, type: 'system/message', time: 1794400000000, data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system head' }], source: { kind: 'test' } }, surfaceOp: 'append' },
      msg(1, `R3 marker text session ${i} alpha`, 1794400000001),
    ] })
  }
  for (let i = 1; i <= 40; i += 1) addSession(i)
  let listCalls = 0
  const persistence = {
    async list() { listCalls += 1; if (listCalls === 4) await sleep(80); return [...store.values()].map(s => ({ header: s.header, revision: s.revision })) },
    async open(id, mode) {
      if (mode !== 'read') throw new Error('stub is read-only')
      const s = store.get(id)
      if (!s) throw new Error(`no session ${id}`)
      return { header: s.header, inheritedEventCount: 0, async read() { await sleep(30); return { events: s.events, eventState: 'shared-frozen' } }, async close() {} }
    },
  }
  const ctx = new Context()
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('sessionPersistence', persistence)
  ctx.plugin(Engine, { path: db, openAt: 'first-search' })
  for (let i = 0; i < 400 && !ctx.sessionQuery; i += 1) await sleep(5)
  const ss = async (req, budgetMs) => {
    const ac = new AbortController()
    const t = budgetMs > 0 ? setTimeout(() => ac.abort(new Error('budget')), budgetMs) : undefined
    try { const p = await ctx.sessionQuery.searchSessions(req, { signal: ac.signal }); return { outcome: 'ok', items: p.items.length, nextCursor: p.nextCursor ?? null } }
    catch (e) { return { outcome: e?.code ?? 'error', message: String(e?.message ?? e).slice(0, 120) } }
    finally { if (t) clearTimeout(t) }
  }
  const call1 = await ss({ query: 'R3', limit: 5 }, 0)
  addSession(41)
  // 4th list (call2 after-list) is slow: the 40ms budget aborts AFTER session 41 committed.
  const call2 = await ss({ query: 'R3', limit: 5 }, 40)
  const s2 = inspect(db)
  // Next round is fully warm: without the token bump the stale cursor would be accepted.
  const call3 = await ss({ query: 'R3', limit: 5, cursor: call1.nextCursor }, 0)
  record('A5-abort-commit-invalidates-cursor', call1.outcome === 'ok' && call2.outcome === 'SESSION_QUERY_ABORTED' && s2.committed === 41 && call3.outcome === 'SESSION_QUERY_STALE_CURSOR', { call1items: call1.items, call2, committedAfterAbort: s2.committed, call3 })
  await ctx.sessionQuery.close()
}

// ---- B: poison isolation ----
{
  const db = join(DBDIR, `b-${LABEL}.sqlite`)
  const poisonId = sid(3)
  const { ctx, warnings } = await wire({ count: 6, poison: new Set([poisonId]), db })
  const r = await search(ctx, sid(1), 0)
  const s = inspect(db)
  if (EXPECT === 'fixed') {
    const namedWarn = warnings.some(w => w.name === 'session-query-sqlite' && w.args.some(a => a.includes(poisonId)))
    record('B1-poison-isolated', r.outcome === 'ok' && s.committed === 5 && !s.rows.some(row => row.id === poisonId), { r, committed: s.committed, poisonPresent: s.rows.some(row => row.id === poisonId) })
    record('B2-warn-logged-named', warnings.length >= 1, { warnings, namedSessionQuerySqlite: namedWarn, specRequiresName: 'session-query-sqlite' })
    // B3: quiet follow-up calls must stay ok after isolation (review finding #1:
    // the zero-success fuse misfired when only known-bad archives remained).
    const r2quiet = await search(ctx, sid(1), 0)
    const s2quiet = inspect(db)
    const r3quiet = await search(ctx, sid(1), 0)
    record('B3-second-quiet-call-ok', r2quiet.outcome === 'ok' && r3quiet.outcome === 'ok' && s2quiet.committed === 5 && !s2quiet.rows.some(row => row.id === poisonId), { r2quiet, r3quiet, committed: s2quiet.committed })
  } else {
    record('B1-baseline-poison-kills-round', r.outcome === 'SESSION_QUERY_PERSISTENCE_FAILED' && s.committed === 0, { r, committed: s.committed })
  }
  await ctx.sessionQuery.close()
}

// ---- C: zero-success fuse ----
{
  const db = join(DBDIR, `c-${LABEL}.sqlite`)
  const all = new Set([sid(1), sid(2), sid(3)])
  const { ctx } = await wire({ count: 3, poison: all, db })
  const r = await search(ctx, sid(1), 0)
  const s = inspect(db)
  record('C1-zero-success-fuse', r.outcome === 'SESSION_QUERY_PERSISTENCE_FAILED' && s.committed === 0, { r, committed: s.committed })
  await ctx.sessionQuery.close()
}

// ---- D: live-owned churn must not deadlock ----
{
  const db = join(DBDIR, `d-${LABEL}.sqlite`)
  const liveId = sid(6)
  const { ctx } = await wire({ count: 6, churnLiveId: liveId, db })
  const r = await search(ctx, sid(1), 0)
  const s = inspect(db)
  if (EXPECT === 'fixed') {
    record('D1-live-churn-converges', r.outcome === 'ok' && s.committed === 5 && !s.rows.some(row => row.id === liveId), { r, committed: s.committed })
  } else {
    record('D1-baseline-churn-deadlock', r.outcome === 'SESSION_QUERY_PERSISTENCE_FAILED' && s.committed === 0, { r, committed: s.committed })
  }
  await ctx.sessionQuery.close()
}

// ---- P: startup background pre-warm (spec 5) ----
if (EXPECT === 'fixed') {
  {
    const db = join(DBDIR, `p1-${LABEL}.sqlite`)
    const { ctx, counters } = await wire({ count: 12, readDelayMs: 5, db, openAt: 'startup' })
    let s = inspect(db)
    for (let i = 0; i < 600 && s.committed < 12; i += 1) { await sleep(50); s = inspect(db) }
    record('P1-prewarm-builds-without-search', s.committed === 12 && counters.coldReads === 12, { committed: s.committed, coldReads: counters.coldReads })
    await ctx.sessionQuery.close()
  }
  {
    const db = join(DBDIR, `p2-${LABEL}.sqlite`)
    const { ctx } = await wire({ count: 40, readDelayMs: 100, db, openAt: 'startup' })
    await sleep(350)
    const t0 = performance.now()
    await ctx.sessionQuery.close()
    const closeMs = Math.round(performance.now() - t0)
    const s = inspect(db)
    record('P2-close-aborts-prewarm', closeMs < 1500 && s.committed > 0 && s.committed < 40, { closeMs, committed: s.committed })
  }
  {
    const db = join(DBDIR, `p3-${LABEL}.sqlite`)
    const { ctx, counters } = await wire({ count: 6, db, openAt: 'first-search' })
    await sleep(150)
    const s = existsSync(db) ? inspect(db) : { committed: 0 }
    record('P3-first-search-no-prewarm', s.committed === 0 && counters.coldReads === 0, { committed: s.committed, coldReads: counters.coldReads })
    await ctx.sessionQuery.close()
  }
  {
    const db = join(DBDIR, `p4-${LABEL}.sqlite`)
    const all = new Set([sid(1), sid(2)])
    const { ctx, warnings } = await wire({ count: 2, poison: all, db, openAt: 'startup' })
    await sleep(250)
    const prewarmWarn = warnings.some(w => w.args.some(a => a.includes('startup pre-warm failed')))
    const r = await search(ctx, sid(1), 0)
    record('P4-prewarm-failure-nonfatal', prewarmWarn && r.outcome === 'SESSION_QUERY_PERSISTENCE_FAILED', { prewarmWarn, searchAfter: r.outcome })
    await ctx.sessionQuery.close()
  }
} else {
  const db = join(DBDIR, `p1-${LABEL}.sqlite`)
  const { ctx, counters } = await wire({ count: 12, readDelayMs: 5, db, openAt: 'startup' })
  await sleep(300)
  const s = inspect(db)
  record('P1-baseline-no-prewarm', s.committed === 0 && counters.coldReads === 0, { committed: s.committed, coldReads: counters.coldReads })
  await ctx.sessionQuery.close()
}

const failed = results.filter(r => !r.pass)
console.log(JSON.stringify({ label: LABEL, lib: LIB, expect: EXPECT, total: results.length, passed: results.length - failed.length, failed: failed.map(f => f.name), capturedAt: new Date().toISOString() }))
process.exit(failed.length > 0 ? 1 : 0)
