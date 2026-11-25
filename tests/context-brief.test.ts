import test from 'node:test'
import assert from 'node:assert/strict'

import {
  briefCacheStats,
  clearBriefCache,
  compileBrief,
  condenseText,
  isHardFactSentence,
  looksAbsorbed,
  renderBrief,
} from '../src/context-brief.js'

test('[3.2.9] 硬事实逐字保留：数字/路径/哈希/命令/验收编号', () => {
  const text = '产物路径 /tmp/reports/T1/a.md；命中率 42%；sha256 abcdef1234567890；命令 npm test；验收 A1 通过。'
  const condensed = condenseText(text, 800, 'status.summary')
  for (const value of ['/tmp/reports/T1/a.md', '42%', 'abcdef1234567890', 'npm test', 'A1']) {
    assert.ok(condensed.includes(value), `压缩后必须保留硬事实 ${value}：${condensed}`)
  }
  assert.ok(condensed.length <= 800)
  assert.equal(isHardFactSentence('普通叙述没有数字'), false)
})

test('[3.2.9] 已吸收内容只保留 ref，不重复正文', () => {
  const brief = compileBrief([
    { id: 'settled', text: '这一段已经被后续结算吸收，不应再展开。', ref: 'reports/wp-settlement.json', absorbed: true },
    { id: 'anchor', text: '必须保留 /tmp/x.md 与 7 条验收。', hard: true },
  ], { budgetChars: 400 })
  assert.ok(brief.omitted.some((item) => item.id === 'settled' && item.reason === 'absorbed' && item.ref === 'reports/wp-settlement.json'))
  assert.ok(brief.hard.some((item) => item.includes('/tmp/x.md')))
  assert.match(renderBrief(brief), /可检索引用|硬事实/)
})

test('[3.2.9] 同一输入复用编译缓存，哈希稳定；原文仍可按 ref 取回', () => {
  clearBriefCache()
  const sources = [{ id: 'dep:T1', text: '依赖结论：路径 /tmp/a.md，数值 3.14。', ref: 'status.T1' }]
  const first = compileBrief(sources, { budgetChars: 300 })
  const second = compileBrief(sources, { budgetChars: 300 })
  assert.equal(first.cacheHit, false)
  assert.equal(second.cacheHit, true)
  assert.equal(first.hash, second.hash)
  assert.equal(first.hard.join(''), second.hard.join(''))
  // [3.2.9] 缓存命中标记只进结构化字段；提示词渲染对同一输入必须逐字稳定。
  assert.equal(renderBrief(first), renderBrief(second))
  const stats = briefCacheStats()
  assert.ok(stats.hits >= 1)
})

test('[3.2.9] 吸收判定保守：只有高相似摘要才视为已吸收', () => {
  const text = '先查指数成分权重，再决定检索方向，避免按名称漏掉最大驱动。'
  assert.equal(looksAbsorbed(text, { summary: text }), true)
  assert.equal(looksAbsorbed(text, { summary: '完全不同的内容' }), false)
  assert.equal(looksAbsorbed(text, { superseded: true }), true)
})

test('[3.2.9] 软句超预算的省略项仍带来源 ref', () => {
  const first = '普通叙述一'.repeat(20)
  const second = '普通叙述二'.repeat(20)
  const brief = compileBrief([
    { id: 'soft-source', text: `${first}。${second}。`, ref: 'status.soft-source' },
  ], { budgetChars: 120 })
  const omitted = brief.omitted.find((item) => item.reason === 'budget')
  assert.ok(omitted, `应有超预算省略项：${JSON.stringify(brief.omitted)}`)
  assert.equal(omitted?.ref, 'status.soft-source')
})
