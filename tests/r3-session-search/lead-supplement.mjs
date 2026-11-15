#!/usr/bin/env node
/**
 * T3 LEAD-owned supplement to the r3-session-search regression suite.
 * Covers contract items the member suite does not: all-corrupt fail-closed
 * valve (B7), abort-before-progress safety, seq/time filters, cursor
 * pagination, stale-cursor rejection and generation monotonicity (B9).
 * Reuses the member harness/fixtures unchanged (read-only import).
 *
 * Usage: node lead-supplement.mjs            # baseline lib (default)
 *        R3_LIB_PATH=/path/to/fixed/index.js node lead-supplement.mjs
 * Expectation: ALL checks pass on BOTH baseline and fixed libs (these are
 * semantics-preservation / safety checks, not defect-capture checks).
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createEngine, countPersisted } from './lib/harness.mjs'
import { MARKER, createArchive, createFakePersistence } from './lib/fixtures.mjs'

const SUITE_DIR = dirname(fileURLToPath(import.meta.url))
const LIB_PATH = resolve(process.env.R3_LIB_PATH ?? join(SUITE_DIR, 'vendor/baseline-lib/index.js'))
const mod = await import(pathToFileURL(LIB_PATH).href)
const Engine = mod.default ?? mod.SqliteSessionQueryEngine
const libSha256 = createHash('sha256').update(readFileSync(LIB_PATH)).digest('hex')
const checks = []
const add = (id, criterion, pass, evidence) => {
  checks.push({ id, criterion, pass: Boolean(pass), evidence })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${criterion} — ${evidence}`)
}
mkdirSync(join(SUITE_DIR, '.tmp'), { recursive: true })

async function scenario(name, fn) {
  const dir = mkdtempSync(join(SUITE_DIR, '.tmp', `lead-${name}-`))
  console.log(`\n=== L-${name} ===`)
  try { await fn(dir) } catch (e) { add(`L-${name}.0`, 'scenario without harness error', false, String(e?.stack ?? e)) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

// L1: all archives corrupt → must THROW (fail-closed), never silently return empty.
await scenario('valve', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = ['cold-v-0', 'cold-v-1', 'cold-v-2']
  const archives = new Map(ids.map(id => [id, createArchive(id, 3)]))
  const persistence = createFakePersistence({ archives, corruptIds: new Set(ids), readDelayMs: 1 })
  const { engine } = await createEngine({ Engine, indexPath, persistence })
  try {
    let code = 'resolved', message = ''
    try { await engine.searchSessions({ query: MARKER }) } catch (e) { code = e?.code ?? String(e); message = String(e?.message ?? '') }
    add('L1.1', 'all-corrupt corpus rejects (no silent empty index)', code !== 'resolved', `outcome=${code}`)
    add('L1.2', 'rejection is SESSION_QUERY_PERSISTENCE_FAILED', code === 'SESSION_QUERY_PERSISTENCE_FAILED', `code=${code}, msg=${message.slice(0, 120)}`)
    add('L1.3', 'no sessions committed', countPersisted(indexPath) === 0, `rows=${countPersisted(indexPath)}`)
  } finally { await engine.close() }
})

// L2: abort before any cold read completes → zero progress, ABORTED contract.
await scenario('early-abort', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = Array.from({ length: 6 }, (_, i) => `cold-ea-${i}`)
  const archives = new Map(ids.map(id => [id, createArchive(id, 3)]))
  const ac = new AbortController()
  const persistence = createFakePersistence({ archives, readDelayMs: 50, hooks: {} })
  const { engine } = await createEngine({ Engine, indexPath, persistence })
  try {
    ac.abort() // pre-aborted signal
    let code = 'resolved'
    try { await engine.searchSessions({ query: MARKER }, { signal: ac.signal }) } catch (e) { code = e?.code ?? String(e) }
    add('L2.1', 'pre-aborted search rejects with SESSION_QUERY_ABORTED', code === 'SESSION_QUERY_ABORTED', `outcome=${code}`)
    // A pre-aborted first search never opens the index (openAt=first-search):
    // an absent index file means zero committed rows by construction.
    const rows = existsSync(indexPath) ? countPersisted(indexPath) : 0
    add('L2.2', 'zero rows committed', rows === 0, `rows=${rows}, indexFileExists=${existsSync(indexPath)}`)
  } finally { await engine.close() }
})

// L3: filters, pagination, stale cursor, generation monotonicity on static corpus.
await scenario('semantics', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = Array.from({ length: 5 }, (_, i) => `cold-sem-${i}`)
  const archives = new Map(ids.map(id => [id, createArchive(id, 4)]))
  const persistence = createFakePersistence({ archives, readDelayMs: 1 })
  const { engine } = await createEngine({ Engine, indexPath, persistence })
  try {
    const target = ids[0]
    const baseTime = 1700000000000
    // seq filter
    const seqPage = await engine.searchEvents({ sessionId: target, query: MARKER, filters: [{ kind: 'seq', from: 1, to: 2 }] })
    const seqs = seqPage.items.map(h => h.seq).sort((a, b) => a - b)
    add('L3.1', 'seq filter [1,2] returns exactly seq 1,2', JSON.stringify(seqs) === '[1,2]', `seqs=${JSON.stringify(seqs)}`)
    // time filter (events at baseTime + i*1000)
    const timePage = await engine.searchEvents({ sessionId: target, query: MARKER, filters: [{ kind: 'time', from: baseTime + 1000, to: baseTime + 2000 }] })
    const tseqs = timePage.items.map(h => h.seq).sort((a, b) => a - b)
    add('L3.2', 'time filter returns exactly seq 1,2', JSON.stringify(tseqs) === '[1,2]', `seqs=${JSON.stringify(tseqs)}`)
    // pagination: limit 2 over 5 sessions
    const p1 = await engine.searchSessions({ query: MARKER, limit: 2 })
    add('L3.3', 'page 1 has 2 items + nextCursor', p1.items.length === 2 && p1.nextCursor !== undefined, `items=${p1.items.length}, cursor=${p1.nextCursor !== undefined}`)
    const p2 = await engine.searchSessions({ query: MARKER, limit: 2, cursor: p1.nextCursor })
    const p3 = await engine.searchSessions({ query: MARKER, limit: 2, cursor: p2.nextCursor })
    const seen = [...p1.items, ...p2.items, ...p3.items].map(i => i.header.id)
    const unique = new Set(seen)
    add('L3.4', 'pagination covers all 5 sessions without duplicates', unique.size === 5 && seen.length === 5 && ids.every(id => unique.has(id)), `seen=${seen.length}, unique=${unique.size}`)
    add('L3.5', 'final page has no nextCursor', p3.nextCursor === undefined, `p3items=${p3.items.length}`)
    // generation before change
    const genOf = () => {
      const db = new DatabaseSync(indexPath, { readOnly: true })
      const g = db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get().global_generation
      db.close()
      return g
    }
    const genBefore = genOf()
    // change one archive revision → reconcile must bump generation and re-read only it
    const readsBefore = persistence.stats().coldReads
    archives.get(ids[2]).revision = 'rev-1'
    const staleTry = await engine.searchSessions({ query: MARKER, limit: 2, cursor: p1.nextCursor }).then(() => 'resolved').catch(e => e?.code ?? String(e))
    add('L3.6', 'old cursor rejected with SESSION_QUERY_STALE_CURSOR after corpus change', staleTry === 'SESSION_QUERY_STALE_CURSOR', `outcome=${staleTry}`)
    const genAfter = genOf()
    add('L3.7', 'global_generation monotonically increases on persisted change', genAfter > genBefore, `before=${genBefore}, after=${genAfter}`)
    const readsDelta = persistence.stats().coldReads - readsBefore
    add('L3.8', 'only the changed session is re-cold-read', readsDelta === 1, `coldReadsDelta=${readsDelta}`)
    // fresh cursor works after change
    const fresh = await engine.searchSessions({ query: MARKER, limit: 2 })
    const freshPage2 = await engine.searchSessions({ query: MARKER, limit: 2, cursor: fresh.nextCursor })
    add('L3.9', 'fresh cursor paginates correctly after change', freshPage2.items.length === 2, `page2items=${freshPage2.items.length}`)
  } finally { await engine.close() }
})

// L4: startup background pre-warm (config-gated; requires the R3-fix pre-warm).
// Mounted via ctx.plugin so the cordis lifecycle runs [Service.init].
const { Context } = await import('@deepseek-ai/cordis')
async function mountPlugin({ Engine, indexPath, persistence, openAt, liveSessions = new Map() }) {
  const ctx = new Context()
  ctx.provide('sessions', { list: () => [...liveSessions.values()], get: (id) => liveSessions.get(id) })
  ctx.provide('sessionPersistence', persistence)
  ctx.plugin(Engine, { path: indexPath, openAt })
  for (let i = 0; i < 400; i += 1) {
    if (ctx.sessionQuery) return ctx.sessionQuery
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('engine service never activated')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await scenario('prewarm-builds', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = Array.from({ length: 6 }, (_, i) => `cold-pw-${i}`)
  const archives = new Map(ids.map(id => [id, createArchive(id, 3)]))
  const persistence = createFakePersistence({ archives, readDelayMs: 5 })
  const engine = await mountPlugin({ Engine, indexPath, persistence, openAt: 'startup' })
  try {
    // No search call at all: the background pre-warm must build the index.
    let rows = 0
    for (let i = 0; i < 200; i += 1) {
      rows = existsSync(indexPath) ? countPersisted(indexPath) : 0
      if (rows === 6) break
      await sleep(25)
    }
    add('L4.1', 'startup pre-warm indexes all 6 sessions without any search call', rows === 6, `rows=${rows}/6, coldReads=${persistence.stats().coldReads}`)
    const readsBefore = persistence.stats().coldReads
    const result = await engine.searchSessions({ query: MARKER })
    add('L4.2', 'first search after pre-warm returns all sessions with zero extra cold reads', result.items.length === 6 && persistence.stats().coldReads === readsBefore, `hits=${result.items.length}, coldReadsDelta=${persistence.stats().coldReads - readsBefore}`)
  } finally { await engine.close() }
})

await scenario('prewarm-close', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = Array.from({ length: 30 }, (_, i) => `cold-pwc-${String(i).padStart(2, '0')}`)
  const archives = new Map(ids.map(id => [id, createArchive(id, 3)]))
  const persistence = createFakePersistence({ archives, readDelayMs: 150 })
  const engine = await mountPlugin({ Engine, indexPath, persistence, openAt: 'startup' })
  await sleep(400) // pre-warm is mid-build (~2-3 sessions committed)
  const t0 = performance.now()
  await engine.close()
  const closeMs = performance.now() - t0
  const rows = existsSync(indexPath) ? countPersisted(indexPath) : 0
  add('L4.3', 'close() during pre-warm returns promptly (<2000ms, abort-bounded)', closeMs < 2000, `closeMs=${Math.round(closeMs)}`)
  add('L4.4', 'partial pre-warm progress survives close (incremental commits)', rows > 0 && rows < 30, `rows=${rows}/30`)
})

await scenario('prewarm-gate', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = Array.from({ length: 4 }, (_, i) => `cold-pwg-${i}`)
  const archives = new Map(ids.map(id => [id, createArchive(id, 3)]))
  const persistence = createFakePersistence({ archives, readDelayMs: 5 })
  const engine = await mountPlugin({ Engine, indexPath, persistence, openAt: 'first-search' })
  try {
    await sleep(300)
    const rows = existsSync(indexPath) ? countPersisted(indexPath) : 0
    add('L4.5', 'openAt=first-search does NOT pre-warm (bundle-default behavior unchanged)', rows === 0 && persistence.stats().coldReads === 0, `rows=${rows}, coldReads=${persistence.stats().coldReads}`)
  } finally { await engine.close() }
})

// L5: poison isolation must survive REPEATED quiet calls (fuse must not misfire
// when only known-bad sessions remain to cold-read). Defect capture on the
// pre-fix lib: call2/call3 reject with SESSION_QUERY_PERSISTENCE_FAILED.
await scenario('poison-repeat', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const healthy = Array.from({ length: 5 }, (_, i) => `cold-pr-${i}`)
  const poisonId = 'cold-pr-poison'
  const archives = new Map([...healthy, poisonId].map(id => [id, createArchive(id, 3)]))
  const persistence = createFakePersistence({ archives, corruptIds: new Set([poisonId]), readDelayMs: 1 })
  const { engine } = await createEngine({ Engine, indexPath, persistence })
  try {
    const outcomes = []
    for (let i = 0; i < 3; i += 1) {
      try {
        const r = await engine.searchSessions({ query: MARKER })
        outcomes.push(`ok:${r.items.length}`)
      } catch (e) { outcomes.push(e?.code ?? String(e)) }
    }
    add('L5.1', 'three consecutive quiet calls with one poison all succeed', outcomes.every(o => o.startsWith('ok:')), `outcomes=${JSON.stringify(outcomes)}`)
    const rows = countPersisted(indexPath)
    add('L5.2', 'healthy sessions stay indexed, poison never indexed', rows === 5, `rows=${rows}/5`)
  } finally { await engine.close() }
})

// L6: abort after partial commits must keep the STALE_CURSOR contract
// (generation accounting must not lag behind committed rows). Four-step
// interleaving after the independent review's differential probe:
// R1 abort-after-all-commits → R2 quiet success issues cursors → R3 revision
// change + abort-after-commit → R4 old cursors MUST be rejected.
await scenario('cursor-abort-gap', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = ['cold-cg-0', 'cold-cg-1', 'cold-cg-2']
  const archives = new Map(ids.map(id => [id, createArchive(id, 3)]))
  const base = createFakePersistence({ archives, readDelayMs: 5 })
  let listCalls = 0
  const persistence = {
    ...base,
    async list(opts) {
      listCalls += 1
      // every round's SECOND list (the stability after-list) is slow, so a
      // 100ms abort lands after all cold-read commits but before the tail txn
      if (listCalls % 2 === 0) await sleep(200)
      return base.list(opts)
    },
  }
  const { engine } = await createEngine({ Engine, indexPath, persistence })
  const dbState = () => {
    const db = new DatabaseSync(indexPath, { readOnly: true })
    const g = db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get().global_generation
    const maxRow = db.prepare('SELECT MAX(generation) AS m FROM persisted_sessions').get().m
    db.close()
    return { g, maxRow }
  }
  const abortAfter = (ms) => { const ac = new AbortController(); setTimeout(() => ac.abort(), ms); return ac.signal }
  try {
    // R1: all 3 committed, abort during after-list → tail transaction never runs
    let o1 = 'resolved'
    try { await engine.searchSessions({ query: MARKER }, { signal: abortAfter(100) }) } catch (e) { o1 = e?.code ?? String(e) }
    const s1 = dbState()
    add('L6.1', 'R1 aborts after committing all 3 sessions', o1 === 'SESSION_QUERY_ABORTED' && countPersisted(indexPath) === 3, `outcome=${o1}, rows=${countPersisted(indexPath)}`)
    add('L6.2', 'DB generation stays in sync with committed rows after abort', s1.g === s1.maxRow, `dbGeneration=${s1.g}, maxRowGeneration=${s1.maxRow}`)
    // R2: quiet success, issue cursors
    const p2 = await engine.searchSessions({ query: MARKER, limit: 2 })
    const e2 = await engine.searchEvents({ sessionId: ids[0], query: MARKER, limit: 1 })
    add('L6.3', 'R2 quiet success issues both cursors', p2.nextCursor !== undefined && e2.nextCursor !== undefined, `sessionsCursor=${p2.nextCursor !== undefined}, eventsCursor=${e2.nextCursor !== undefined}`)
    // R3: revision change + abort after the re-commit
    archives.get(ids[0]).revision = 'rev-2'
    let o3 = 'resolved'
    try { await engine.searchSessions({ query: MARKER }, { signal: abortAfter(100) }) } catch (e) { o3 = e?.code ?? String(e) }
    add('L6.4', 'R3 aborts after re-committing the changed session', o3 === 'SESSION_QUERY_ABORTED', `outcome=${o3}`)
    // R4: old cursors must be stale
    const s4 = await engine.searchSessions({ query: MARKER, limit: 2, cursor: p2.nextCursor }).then(() => 'accepted').catch(e => e?.code ?? String(e))
    const e4 = await engine.searchEvents({ sessionId: ids[0], query: MARKER, limit: 1, cursor: e2.nextCursor }).then(() => 'accepted').catch(e => e?.code ?? String(e))
    add('L6.5', 'old sessions cursor rejected with STALE_CURSOR', s4 === 'SESSION_QUERY_STALE_CURSOR', `outcome=${s4}`)
    add('L6.6', 'old events cursor rejected with STALE_CURSOR', e4 === 'SESSION_QUERY_STALE_CURSOR', `outcome=${e4}`)
  } finally { await engine.close() }
})

// L7: SQLite WRITE failures during commit must propagate (fail-closed), not be
// isolated as per-session cold-read failures.
await scenario('write-fault', async (dir) => {
  const indexPath = join(dir, 'index.sqlite')
  const ids = ['cold-wf-0', 'cold-wf-1', 'cold-wf-2']
  const archives = new Map(ids.map(id => [id, createArchive(id, 3)]))
  const persistence = createFakePersistence({ archives, readDelayMs: 1 })
  const { engine } = await createEngine({ Engine, indexPath, persistence })
  try {
    await engine.searchSessions({ query: MARKER })
    // break the write path externally
    const db = new DatabaseSync(indexPath)
    db.exec('DROP TABLE persisted_docs')
    db.close()
    archives.get(ids[0]).revision = 'rev-2'
    let code = 'resolved'
    try { await engine.searchSessions({ query: MARKER }) } catch (e) { code = e?.code ?? String(e) }
    add('L7.1', 'commit write failure rejects with SESSION_QUERY_INDEX_FAILED (not isolated)', code === 'SESSION_QUERY_INDEX_FAILED', `outcome=${code}`)
  } finally { await engine.close() }
})

const failed = checks.filter(c => !c.pass)
console.log(`\n=== lead supplement summary ===\nlib: ${LIB_PATH}\nsha256: ${libSha256}\nchecks: ${checks.length}, passed: ${checks.length - failed.length}, failed: ${failed.length}${failed.length ? `\nfailed: ${failed.map(c => c.id).join(', ')}` : ''}`)
process.exit(failed.length === 0 ? 0 : 1)