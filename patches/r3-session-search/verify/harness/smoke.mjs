#!/usr/bin/env node
/**
 * T3 lead smoke test: wire the REAL SqliteSessionQueryEngine (baseline or patched
 * lib via R3_LIB_PATH) on a cordis Context with a synthetic persistence stub.
 * Proves the offline harness wiring before the real-corpus benchmark runs.
 * READ-ONLY against the checkout; all writes stay in this harness directory.
 */
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = '/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai'
const LIB = process.env.R3_LIB_PATH || join(CHECKOUT, 'dsh-session-query-sqlite/lib/index.js')
const { default: Engine } = await import(LIB)

const DB = join(HERE, 'smoke-db.sqlite')
rmSync(DB, { force: true })

function header(id) {
  return { version: 4, id, createdAt: 1794400000000, cwd: '/Users/open/Documents/Stocks', isSeeded: false }
}
function msg(seq, type, text, time) {
  const data = type === 'user/message'
    ? { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'test' } }
    : { message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text }] } }
  return { seq, type, time, data, surfaceOp: 'append' }
}
const SPECS = [
  { id: 'session-11111111-1111-4111-8111-111111111111', texts: ['hello R1 world', 'second event alpha'] },
  { id: 'session-22222222-2222-4222-8222-222222222222', texts: ['another R1 mention here', 'beta gamma'] },
]
const STORE = new Map(SPECS.map(s => [s.id, {
  header: header(s.id),
  revision: 'rev-1',
  events: [
    { seq: 0, type: 'system/message', time: 1794400000000, data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system head' }], source: { kind: 'test' } }, surfaceOp: 'append' },
    ...s.texts.map((t, i) => msg(i + 1, i % 2 === 0 ? 'user/message' : 'assistant/message', t, 1794400000001 + i)),
  ],
}]))

const counters = { list: 0, coldReads: 0 }
const persistence = {
  async list() {
    counters.list += 1
    return [...STORE.values()].map(s => ({ header: s.header, revision: s.revision }))
  },
  async open(id, mode) {
    if (mode !== 'read') throw new Error('smoke stub is read-only')
    const s = STORE.get(id)
    if (!s) throw new Error(`no session ${id}`)
    counters.coldReads += 1
    return {
      header: s.header,
      inheritedEventCount: 0,
      async read() { return { events: s.events, eventState: 'shared-frozen' } },
      async close() {},
    }
  },
}

const ctx = new Context()
ctx.provide('sessions', { list: () => [], get: () => undefined })
ctx.provide('sessionPersistence', persistence)
ctx.plugin(Engine, { path: DB, openAt: 'first-search' })

// wait for service activation (inject-driven)
const engine = await (async () => {
  for (let i = 0; i < 200; i += 1) {
    if (ctx.sessionQuery) return ctx.sessionQuery
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('engine service never activated')
})()

const t0 = performance.now()
const page = await engine.searchEvents({ sessionId: SPECS[0].id, query: 'R1' })
const dt = performance.now() - t0
console.log(JSON.stringify({
  ok: true,
  lib: LIB,
  elapsedMs: Math.round(dt),
  hits: page.items.map(h => ({ seq: h.seq, type: h.type, snippet: h.snippet })),
  sessionHeaderId: page.session.id,
  counters,
}, null, 1))

// inspect committed rows directly
const db = new DatabaseSync(DB)
const rows = db.prepare('SELECT id, revision, generation FROM persisted_sessions').all()
const gen = db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get()
console.log('persisted_sessions rows:', JSON.stringify(rows), 'search_state:', JSON.stringify(gen))
db.close()

// second call: warm skip check
const before = counters.coldReads
const page2 = await engine.searchEvents({ sessionId: SPECS[1].id, query: 'R1' })
console.log('warm call hits:', page2.items.length, 'coldReadsDelta:', counters.coldReads - before)
await engine.close()
console.log('SMOKE PASS')