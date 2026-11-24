#!/usr/bin/env node
/**
 * T4 推理档位钳制行为验证 —— supportedEffortsCache 的 30 分钟 TTL 边界探针（零依赖、只读）。
 *
 * 证明目标（全程不等待真实 30 分钟）：
 *  1) 首次查询真实回源（resolveModelInfo 调用 +1），缓存写入时刻记为 T0；
 *  2) T0 + 1_799_999 ms（TTL 内 1ms）同键复测必须命中，调用次数不增；
 *  3) T0 + 1_800_000 ms（恰好到期）同键复测必须回源，调用次数 +1；
 *  4) 回源后缓存以本次时刻重新计时（lib/runtime.js:536），再走一轮「TTL-1 命中 / TTL 到期回源」。
 *
 * 时间控制：只在本进程内替换 globalThis.Date.now（被测代码唯一时间源，见
 * lib/runtime.js:519 与 :536），不修改被测模块、不 sleep、不等待；finally 中恢复原函数。
 *
 * 被测产物：plugins/dsh-workplan/lib/runtime.js（ESM）。
 * 运行方式：cd plugins/dsh-workplan && node scripts/t4-effort-cache-ttl.mjs
 * 退出码：全部断言通过 = 0；任一失败 = 1（并打印实际 calls 与 fakeNow 差值）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const TTL_MS = 30 * 60 * 1000 // 1_800_000ms = 30 分钟
const PROVIDER = 't4ttl'
const MODEL = 'cache-boundary'
const EXPECTED_EFFORTS = ['low', 'high', 'max']

const passed = []
function check(name, fn) {
  fn()
  passed.push(name)
  console.log(`✅ PASS  ${name}`)
}

const realNow = Date.now
let fakeNow = 0
let calls = 0
let clockRestored = false

// 1) 装载真实产物。带查询串的动态 import 会得到独立模块实例，缓存 Map 从空开始，
//    避免同进程内其它消费者（若有）污染本探针的调用计数。
const runtime = await import(
  new URL(`../lib/runtime.js?t4ttl=${process.pid}-${realNow()}`, import.meta.url).href
)
assert.equal(
  typeof runtime.resolveSupportedEfforts,
  'function',
  'lib/runtime.js 必须导出 resolveSupportedEfforts',
)

// 假 llm：唯一职责是数「真实回源」次数，并返回固定的三档清单。
// 首次查询返回 ['low','high','max']；缓存命中时这个函数根本不会被调用。
const llm = {
  async resolveModelInfo(provider, model) {
    calls += 1
    void provider
    void model
    return { reasoning: { efforts: EXPECTED_EFFORTS.map((id) => ({ id })) } }
  },
}

// 2) 进程内假时钟：替换范围 = 下方六次查询期间；范围外（import 阶段、断言后）仍是真实时钟。
Date.now = () => fakeNow
const t0 = fakeNow
try {
  fakeNow = 0
  const first = await runtime.resolveSupportedEfforts(llm, PROVIDER, MODEL)
  check('首查回源：T0+0ms 调用 +1（calls=1），返回 [' + EXPECTED_EFFORTS.join(',') + ']', () => {
    assert.deepEqual(first, EXPECTED_EFFORTS, '首查返回值应为 [' + EXPECTED_EFFORTS.join(',') + ']')
    assert.equal(calls, 1, `首查后 calls 应为 1，实际 ${calls}（now=${fakeNow}）`)
  })

  fakeNow = TTL_MS - 1
  const hit = await runtime.resolveSupportedEfforts(llm, PROVIDER, MODEL)
  check(`未过期命中：T0+${TTL_MS - 1}ms 复测，calls 仍为 1`, () => {
    assert.deepEqual(hit, EXPECTED_EFFORTS, '命中返回的清单应与首查一致')
    assert.equal(calls, 1, `TTL 内必须命中缓存，实际 calls=${calls}（now=${fakeNow}）`)
  })

  fakeNow = TTL_MS
  const expired = await runtime.resolveSupportedEfforts(llm, PROVIDER, MODEL)
  check(`过期回源：T0+${TTL_MS}ms 复测，calls 1→2`, () => {
    assert.deepEqual(expired, EXPECTED_EFFORTS, '回源返回值应与首查一致')
    assert.equal(calls, 2, `TTL 边界必须回源，实际 calls=${calls}（now=${fakeNow}）`)
  })

  // 3) 回源后的条目 at = 本次回源时刻（lib/runtime.js:536），据此验证「重新计时」。
  const again = await runtime.resolveSupportedEfforts(llm, PROVIDER, MODEL)
  check('回源后重新入缓存：同一 fakeNow 再查仍命中（calls 仍为 2）', () => {
    assert.equal(calls, 2, `回源后应立即重新入缓存，实际 calls=${calls}（now=${fakeNow}）`)
  })

  fakeNow = 2 * TTL_MS - 1
  await runtime.resolveSupportedEfforts(llm, PROVIDER, MODEL)
  check(`第二轮 TTL 内命中：T0+${2 * TTL_MS - 1}ms，calls 仍为 2`, () => {
    assert.equal(calls, 2, `第二轮 TTL 内应命中，实际 calls=${calls}（now=${fakeNow}）`)
  })

  fakeNow = 2 * TTL_MS
  const secondExpiry = await runtime.resolveSupportedEfforts(llm, PROVIDER, MODEL)
  check(`第二轮 TTL 到期回源：T0+${2 * TTL_MS}ms，calls 2→3`, () => {
    assert.deepEqual(secondExpiry, EXPECTED_EFFORTS, '第二轮回源返回值应与首查一致')
    assert.equal(calls, 3, `第二轮边界必须回源，实际 calls=${calls}（now=${fakeNow}）`)
  })
} catch (err) {
  console.error(`\n❌ 探针失败：${err && err.message ? err.message : err}`)
  console.error(`   实际状态：calls=${calls}，fakeNow=${fakeNow}（距 T0 ${fakeNow - t0}ms）`)
  throw err
} finally {
  Date.now = realNow
  clockRestored = Date.now === realNow
}

check('时钟已恢复：Date.now === 原函数', () => {
  assert.equal(clockRestored, true, 'Date.now 未恢复为原函数')
})

// 4) 源码级佐证（补充证据，不替代上面的行为断言）：
//    TTL 常量字面量必须是 30*60*1000，即 1_800_000ms，位置见 lib/runtime.js:507。
const source = fs.readFileSync(new URL('../lib/runtime.js', import.meta.url), 'utf8')
const ttlMatch = source.match(
  /const SUPPORTED_EFFORTS_CACHE_TTL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000\s*;/,
)
check('源码佐证：TTL 常量 = 30*60*1000 = 1_800_000ms（lib/runtime.js:507）', () => {
  assert.ok(ttlMatch, '未在 lib/runtime.js 中找到 TTL 常量定义')
})
const ttlLine = ttlMatch ? source.slice(0, ttlMatch.index).split('\n').length : -1

console.log(
  `\n=== 全部通过：${passed.length} 项；resolveModelInfo 累计调用 ${calls} 次；` +
    `TTL=${TTL_MS}ms；常量行 lib/runtime.js:${ttlLine} ===`,
)
