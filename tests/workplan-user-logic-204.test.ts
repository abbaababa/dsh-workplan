/*
 * [2.0.4] 三处「与用户直觉相反的逻辑」的回归防线（用户 m00302，2026-11-05）。
 *
 * 事故背景：一次 12 子任务的分析任务里，
 *  1. 5 个子 Agent 的产物都已落盘，但回传的结果块在长度上限处被截断，
 *     整条结果被判「无法解析」，只能人工兜底；
 *  2. 主 Agent 复核证据时撞上「非法闭环迁移：reported → done」，被迫先写
 *     一次假的 blocked 再写 done，审计链被污染；
 *  3. 验收覆盖只认「证据原文包含计划原文」，把同义改写判成「没回应」，
 *     交付门禁反复重开。
 *
 * 三条修法都不放松原有的严格性：只要证据真的缺，门禁仍然拦。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  acceptanceCoverage,
  adjudicateResult,
  applyStatus,
  createStatuses,
  criterionSimilarity,
  parseEvidenceBlock,
  repairEvidenceJson,
  rescueEvidenceFromFence,
} from '../src/plan.js'

function coverage(want: string, got: string) {
  return acceptanceCoverage([want], [{ criterion: got, result: 'pass', evidence: '见附件' }])
}

test('验收覆盖：同义改写与语序调整算同一条，部分回应仍不算', () => {
  /* 主 Agent 把「逐项一致」写成「一致」——同一个意思，必须放行。 */
  assert.equal(coverage('数字与T9逐项一致。', '数字与T9一致').covered, 1)
  /* 语序对调 + 补充说明：同一条验收。 */
  assert.equal(
    coverage('区间下界不高于上界，情景收盘在区间内', '情景收盘在区间内，且下界不高于上界').covered,
    1,
  )
  /* Q6/U-16 的本意不变：只回应了其中一半，不得顶替整条。 */
  assert.equal(coverage('通过登录测试与越权测试', '通过登录测试').covered, 0)
  /* 完全不同的验收项仍然不覆盖。 */
  assert.equal(coverage('所有数字与T9逐项一致', '检查文档格式').covered, 0)
})

test('相似度函数：等值 1、无关 0、同义改写落在阈值之上', () => {
  assert.equal(criterionSimilarity('abc', 'abc'), 1)
  assert.ok(criterionSimilarity('检查文档格式', '所有数字与t9逐项一致') < 0.3)
  assert.ok(criterionSimilarity('数字与t9逐项一致', '数字与t9一致') >= 0.7)
})

test('已回报的行可以复核，不会退回未回报，也不再报非法迁移', () => {
  const plan = { stages: [{ id: 'S1', subtasks: [{ id: 'T1', department: 'engineering', dependsOn: [] }] }] }
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', { status: 'done', closure: 'reported' })
  assert.equal(statuses[0].closure, 'reported')
  /* 事后补齐 verification/acceptance：以前这里抛 INVALID_TRANSITION。 */
  statuses = applyStatus(statuses, 'T1', {
    status: 'done',
    verification: 'structured',
    acceptance: [{ criterion: 'A1', result: 'pass', evidence: '已核对' }],
  })
  assert.equal(statuses[0].status, 'done')
  assert.equal(statuses[0].closure, 'reported')
  /* 显式把已回报退回未回报，仍然拒绝：那会让交付门禁重新打开。 */
  assert.throws(
    () => applyStatus(statuses, 'T1', { status: 'done', closure: 'done' }),
    /非法闭环迁移/,
  )
})

test('截断的结果块能被修回来，且修复后照常走门禁', () => {
  const truncated = `做完了。\n${EVIDENCE_MARKER_BEGIN}\n{"status":"done","summary":"ok","acceptance":[{"criterion":"A1","result":"pass","evidence":"e"}],"execution":{"steps":["a","b"`
  const parsed = parseEvidenceBlock(truncated)
  assert.equal(parsed.malformed, false)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.repaired, true)
  assert.equal(parsed.payload.status, 'done')

  /* 修复只补结构，不补内容：缺的验收项仍然会被覆盖检查拦下。 */
  const verdict = adjudicateResult({
    output: truncated,
    expectedAcceptance: ['A1', 'A2'],
    requirePhases: false,
  })
  assert.equal(verdict.status, 'blocked')
  assert.match(String(verdict.error), /验收项未被逐条回应/)
})

test('修不好的块仍如实报错，并给出可执行下一步', () => {
  /* 连结构都补不回来（没有可闭合的括号）：必须如实判为不可解析。 */
  const broken = `做完了。\n${EVIDENCE_MARKER_BEGIN}\n{这不是 JSON`
  const parsed = parseEvidenceBlock(broken)
  assert.equal(parsed.malformed, true)
  assert.equal(parsed.payload, null)
  const verdict = adjudicateResult({ output: broken, expectedAcceptance: [], requirePhases: false })
  assert.equal(verdict.status, 'blocked')
  assert.match(String(verdict.error), /截断|非法/)
  assert.equal(repairEvidenceJson(''), null)
})

test('只剩半截的块可以补结构，但内容缺口仍由覆盖检查兜住', () => {
  /* 尾巴被切掉：只补括号，不补内容，于是 acceptance 为空 → 仍不可交付。 */
  const half = `做完了。\n${EVIDENCE_MARKER_BEGIN}\n{"status": "done", "acceptance": [ 这不是 JSON`
  const parsed = parseEvidenceBlock(half)
  assert.equal(parsed.malformed, false)
  assert.equal(parsed.repaired, true)
  const verdict = adjudicateResult({ output: half, expectedAcceptance: ['A1'], requirePhases: false })
  assert.equal(verdict.status, 'blocked')
  assert.match(String(verdict.error), /验收项未被逐条回应/)
})

test('正常闭合的结果块不被标记为 truncated', () => {
  const good = `完成。\n${EVIDENCE_MARKER_BEGIN}\n{"status":"done","summary":"ok"}\n${EVIDENCE_MARKER_END}`
  const parsed = parseEvidenceBlock(good)
  assert.equal(parsed.malformed, false)
  assert.equal(parsed.truncated, false)
  assert.equal(parsed.repaired, false)
})

test('没写规定标记、但内容交齐的回执能被认领；普通 JSON 不会被误认', () => {
  const fenced = '做完了。\n\n```json\n{"status":"done","summary":"ok","acceptance":[{"criterion":"A1","result":"pass","evidence":"e"}]}\n```\n'
  const parsed = parseEvidenceBlock(fenced)
  assert.equal(parsed.found, true)
  assert.equal(parsed.rescued, true)
  assert.equal(parsed.payload.status, 'done')
  /* 计划载荷、配置片段这类 JSON 不是回执，绝不能被误认。 */
  assert.equal(rescueEvidenceFromFence('```json\n{"planId":"x","version":1}\n```'), null)
  assert.equal(rescueEvidenceFromFence('没有 JSON'), null)
})

test('否定词与被截半句不得被相似度放过（T4 复现的两类假阳性）', () => {
  /* 删掉「不得」= 把约束反过来，必须判不覆盖。 */
  assert.equal(coverage('涨幅不得超过5%', '涨幅超过5%').covered, 0)
  /* 只抄前半句、丢掉「合计口径与时间戳」，必须判不覆盖。 */
  assert.equal(coverage('验证全部数字、日期、概率、合计口径与时间戳', '验证全部数字、日期与概率').covered, 0)
  /* 原句照抄并补证据说明，仍然覆盖。 */
  assert.equal(coverage('涨幅不得超过5%', '涨幅不得超过5%（含截图）').covered, 1)
})
