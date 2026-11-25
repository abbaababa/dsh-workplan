import test from 'node:test'
import assert from 'node:assert/strict'

import { cacheMeterEnabled, createLlmCacheMeter, observeLlmStream, renderCacheSummary } from '../src/cache-meter.js'

test('[3.2.9] 按会话累计 cacheRead/cacheWrite，命中率不编造', () => {
  const meter = createLlmCacheMeter({ maxSessions: 8 })
  meter.observe('s1', { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100 })
  meter.observe('s1', { inputTokens: 500, outputTokens: 20, cacheReadTokens: 400 })
  meter.observe('s2', { inputTokens: 0, outputTokens: 5 })
  const one = meter.snapshot('s1')
  assert.equal(one.calls, 2)
  assert.equal(one.cacheReadTokens, 1200)
  assert.equal(one.cacheWriteTokens, 100)
  assert.ok(Math.abs(one.hitRate - 1200 / 2800) < 1e-9, `命中率应按互斥计数求和：${one.hitRate}`)
  const all = meter.summary()
  assert.equal(all.sessions, 2)
  assert.match(renderCacheSummary(all), /KV前缀缓存/)
  const none = meter.snapshot('missing')
  assert.equal(none.calls, 0)
  assert.equal(none.hitRate, 0)
})

test('[3.2.9] llm/stream 观察器透传全部块，只读 usage，不二次 next', async () => {
  const meter = createLlmCacheMeter()
  let listener: any = null
  let nextCalls = 0
  const ctx = { on: (name: string, fn: any) => { assert.equal(name, 'llm/stream'); listener = fn; return () => {} } }
  const dispose = observeLlmStream(ctx, meter)
  assert.equal(typeof listener, 'function')
  const chunks = [
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const stream = listener({ sessionId: 's1' }, () => {
    nextCalls += 1
    return (async function* () { for (const chunk of chunks) yield chunk })()
  })
  const seen: any[] = []
  for await (const chunk of stream) seen.push(chunk)
  assert.equal(nextCalls, 1)
  assert.deepEqual(seen, chunks)
  assert.equal(meter.snapshot('s1').cacheReadTokens, 8)
  dispose()
})

test('[3.2.9] 观察器无 sessionId / 无 ctx.on 时 fail-open', async () => {
  const meter = createLlmCacheMeter()
  assert.equal(observeLlmStream(null, meter)(), undefined)
  assert.equal(observeLlmStream({}, meter)(), undefined)
  const old = process.env.DSH_WORKPLAN_CACHE_METER
  process.env.DSH_WORKPLAN_CACHE_METER = '0'
  assert.equal(cacheMeterEnabled(), false)
  if (old === undefined) delete process.env.DSH_WORKPLAN_CACHE_METER
  else process.env.DSH_WORKPLAN_CACHE_METER = old
})

test('[3.2.9] 命中率分母按宿主互斥计数求和，不虚报 100%', () => {
  const meter = createLlmCacheMeter()
  meter.observe('root', { inputTokens: 120, outputTokens: 40, cacheReadTokens: 880 })
  const one = meter.snapshot('root')
  assert.equal(one.hitRate, 0.88)
  assert.equal(meter.summary(['root', 'root']).sessions, 1)
  assert.equal(meter.summary(['root', 'root']).calls, 1)
})
