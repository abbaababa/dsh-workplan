#!/usr/bin/env node
/**
 * T3 real-engine before/after benchmark (lead-owned).
 * Runs the ACTUAL SqliteSessionQueryEngine (baseline or patched lib) with the
 * ACTUAL JsonlSessionPersistence backend over a READ-ONLY corpus copy, issues
 * the exact P1 reproduction request under a cooperative abort budget, and
 * inspects committed index rows directly from the db file.
 *
 * Usage: node bench.mjs --lib <libPath> --corpus <root> --db <file>
 *                      --budget <ms|0=none> --label <name> [--fresh]
 * All writes stay inside the workspace (db file). The real ~/.dsh is never opened.
 */
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CHECKOUT = '/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai'
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
const LIB = args.lib || join(CHECKOUT, 'dsh-session-query-sqlite/lib/index.js')
const CORPUS = args.corpus
const DB = args.db
const BUDGET = Number(args.budget ?? 30000)
const LABEL = args.label || 'run'
if (!CORPUS || !DB) { console.error('missing --corpus/--db'); process.exit(2) }
if (args.fresh) rmSync(DB, { force: true })

const { default: Engine } = await import(LIB)
const Jsonl = await import(join(CHECKOUT, 'dsh-session-persistence-jsonl/lib/index.js'))

const ctx = new Context()
ctx.provide('sessions', { list: () => [], get: () => undefined })
ctx.plugin(Jsonl, { root: CORPUS })
ctx.plugin(Engine, { path: DB, openAt: 'first-search' })

async function waitForServices() {
  for (let i = 0; i < 1000; i += 1) {
    if (ctx.sessionQuery && ctx.sessionPersistence) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('services never activated')
}
await waitForServices()

// Exact P1 reproduction parameters (T1 R3-repro-evidence.md §3.1, = 18:22:27 historical call)
const P1 = {
  sessionId: 'session-6e26e9e5-1d95-4d47-b59d-4d75b838cae7',
  query: 'R1',
  filters: [{ kind: 'seq', from: 1 }],
}

let peakRssBytes = 0
const rssSampler = setInterval(() => {
  const rss = process.memoryUsage().rss
  if (rss > peakRssBytes) peakRssBytes = rss
}, 200)
rssSampler.unref?.()

const ac = new AbortController()
const timer = BUDGET > 0 ? setTimeout(() => ac.abort(new Error(`budget ${BUDGET}ms`)), BUDGET) : undefined
const t0 = performance.now()
let outcome, error, page
try {
  page = await ctx.sessionQuery.searchEvents(P1, { signal: ac.signal })
  outcome = 'ok'
} catch (e) {
  outcome = e?.code === 'SESSION_QUERY_ABORTED' ? 'aborted' : 'error'
  error = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 400) }
} finally {
  if (timer) clearTimeout(timer)
  clearInterval(rssSampler)
}
const elapsedMs = Math.round(performance.now() - t0)
const finalRss = process.memoryUsage().rss
if (finalRss > peakRssBytes) peakRssBytes = finalRss

let committedSessions = null, committedDocs = null, globalGeneration = null
try {
  const db = new DatabaseSync(DB, { readOnly: true })
  committedSessions = db.prepare('SELECT COUNT(*) AS n FROM persisted_sessions').get().n
  committedDocs = db.prepare('SELECT COUNT(*) AS n FROM persisted_docs').get().n
  globalGeneration = db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get().global_generation
  db.close()
} catch (e) {
  error = { ...(error ?? {}), dbInspect: String(e?.message ?? e) }
}

let corpusFiles = 0
try {
  for (const proj of readdirSync(CORPUS)) {
    try { corpusFiles += readdirSync(join(CORPUS, proj)).length } catch { /* not a dir */ }
  }
} catch { /* disclose */ }

console.log(JSON.stringify({
  label: LABEL,
  lib: LIB,
  corpus: CORPUS,
  corpusSessionDirs: corpusFiles,
  budgetMs: BUDGET,
  elapsedMs,
  outcome,
  error: error ?? null,
  hitCount: page?.items?.length ?? null,
  firstHits: page?.items?.slice(0, 5).map(h => ({ seq: h.seq, type: h.type, time: h.time, snippet: String(h.snippet).slice(0, 80) })) ?? null,
  nextCursor: page?.nextCursor !== undefined,
  committedSessions,
  committedDocs,
  globalGeneration,
  peakRssBytes,
  nodeVersion: process.version,
  capturedAt: new Date().toISOString(),
}, null, 1))

await ctx.sessionQuery.close()
process.exit(0)