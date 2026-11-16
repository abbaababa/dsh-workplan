/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：Q2 估时上限软门禁（E-2/E-4）。
 * 承载用例：C-Q2-01…C-Q2-06（cases.md §6.2）。
 * 预期唯一来源：spec:104-107（AC-Q2-1…AC-Q2-4）。
 * 字段绑定：estimateOverCriterion/estimateNeedsJustification/splitReason/
 * estimateConfirm（fields.md §3/§4）；leaderEstimateOverCriterion（服务端布尔）。
 * 口径说明：readSubtasks 是 plan.ts 内部校验器（validatePlan 消费它，
 * src/plan.ts:790/999），validatePlan 输出即 readSubtasks 校验后的计划载荷。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { buildPlannerPrompt, deriveLeaderEstimate, normaliseStatusEntry, validatePlan } from '../src/plan.js'
import { affirmativeCriterionClaims, delegateEstimates, makeRenderer, sessionFixture } from './helpers/scv2-render.js'

function planWithSubtask(subtask: any) {
  return {
    version: 1,
    title: '判据 v2 Q2 验收',
    taskUnderstanding: { originalRequest: '验证估时软门禁', deliverable: '标记可查询', successCriteria: ['不硬拒绝'], constraints: [], knownFacts: [], unknowns: [], assumptions: [] },
    contradictions: { primary: { statement: '估高与拆小', evidence: ['估高会掩盖拆分需求'], whyPrimary: '防大任务' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', goal: '验证', rationale: '先验证', checkpoint: '通过', subtasks: [subtask] }],
    risks: [{ risk: '无', likelihood: 'low', impact: '无', mitigation: '无', trigger: '无' }],
    verification: [{ item: '软门禁', method: '单测', evidence: '本文件' }],
    practiceLoop: { plan: '列样例', do: '跑校验', check: '核对', act: '修正' },
  }
}
function subtask(extra: any = {}) {
  return { id: 'T1', title: '验证', department: 'research', role: '分析', objective: '验证软门禁', method: ['样例'], inputs: [], outputs: ['报告'], dependsOn: [], acceptance: ['断言通过'], risk: '无', ...extra }
}

test('C-Q2-01（AC-Q2-1 正例）：1/90/240 通过且原样保留；错误文案仍写 1-240（不得改成 1-10）', () => {
  for (const value of [1, 90, 240]) {
    const res: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: value })))
    assert.equal(res.ok, true, `estimateMinutes=${value} 必须合法`)
    assert.equal(res.plan.stages[0].subtasks[0].estimateMinutes, value, '原样保留、不被钳制')
  }
  const bad: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 0 })))
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((line: string) => /1-240/.test(line)), `错误文案必须仍写 1-240：${JSON.stringify(bad.errors)}`)
  assert.ok(!bad.errors.some((line: string) => /1-10/.test(line)), '错误文案不得改成 1-10')
})

test('C-Q2-02（AC-Q2-1 反例）：0/241/10.5/"10" 全部拒绝且点名 estimateMinutes；拒绝而非改写', () => {
  for (const value of [0, 241, 10.5, '10']) {
    const res: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: value })))
    assert.equal(res.ok, false, `estimateMinutes=${JSON.stringify(value)} 必须拒绝`)
    assert.ok(res.errors.some((line: string) => /estimateMinutes/.test(line)), `拒因必须点名 estimateMinutes：${JSON.stringify(res.errors)}`)
    // 拒绝而非改写：不得输出被钳制后的合法值计划
    const rewritten = res.plan?.stages?.[0]?.subtasks?.[0]?.estimateMinutes
    assert.ok(rewritten === undefined || rewritten === value, '不得把非法值钳成合法值继续通过')
  }
})

test('C-Q2-03（无时限新契约）：11/240 分钟合法，但不产生 10 分钟软标记或补说明要求', () => {
  const plain11: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 11 })))
  const plain240: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 240 })))
  for (const res of [plain11, plain240]) {
    assert.equal(res.ok, true, '预估范围 1–240 合法，与执行时限无关')
    const row = res.plan.stages[0].subtasks[0]
    assert.equal(row.estimateOverCriterion, undefined, '不再有“超 10 分钟”软门禁')
    assert.equal(row.estimateNeedsJustification, undefined, '不再要求为超过 10 分钟补拆分说明')
  }
  const withReason: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 11, splitReason: '拆成骨架与断言两步' })))
  assert.equal(withReason.ok, true, '历史拆分说明仍可解析，不影响验收')
  assert.equal(withReason.plan.stages[0].subtasks[0].estimateNeedsJustification, undefined)
  const withConfirm: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 11, estimateConfirm: { confirmed: true, by: 'user' } })))
  assert.equal(withConfirm.ok, true)
  assert.equal(withConfirm.plan.stages[0].subtasks[0].estimateNeedsJustification, undefined)
})

test('C-Q2-04（无时限新契约）：estimateMinutes=12 不触发告警，也不宣布判据达标', async () => {
  const res: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 12 })))
  assert.equal(res.ok, true)
  const planRow = res.plan.stages[0].subtasks[0]
  assert.equal(planRow.estimateNeedsJustification, undefined, '无需补拆分说明')
  const plannerPrompt = String(buildPlannerPrompt('验证估时软门禁', process.cwd()))
  assert.doesNotMatch(plannerPrompt, /需补拆分说明或用户确认|≤\s*10\s*分钟/, '规划器不再按 10 分钟施压')
  const render = await makeRenderer()
  const status = normaliseStatusEntry({ subtaskId: 'T1', status: 'in_progress', progress: 40, startedAt: 1_700_000_000_000, deadlineAt: null })
  const html = render(sessionFixture([status], { estimateMinutes: 12 }))
  assert.ok(html.length > 1000, '夹具必须真的渲染出面板')
  assert.deepEqual(affirmativeCriterionClaims(html), [], '①渲染不得出现肯定性「达标」宣布')
  assert.ok(!html.includes('超简单判据'), '不再出现 10 分钟判据告警')
  assert.ok(html.includes('无时限') || html.includes('执行无时限'), '面板明确执行无时限')
})

test('C-Q2-05（AC-Q2-4 边界）：叶子 1/10080 通过、0/10081 拒绝；src 内 10080 字面量未被收紧成 10', () => {
  // 经公开出口 deriveLeaderEstimate（内部 sanitizeDelegateEstimate 同判据）验证范围
  const mk = (minutes: number) => ({
    delegates: [{ member: 'leaf-a', role: 'member' }],
    delegateEstimates: { 'leaf-a': { declaredMinutes: minutes, at: 1_700_000_000_000, delivery: 'sent' } },
  })
  for (const value of [1, 10080]) {
    const sum = deriveLeaderEstimate(mk(value))
    assert.equal(sum?.totalMinutes, value, `declaredMinutes=${value} 应通过并计入`)
    assert.equal(sum?.reported, 1)
  }
  for (const value of [0, 10081]) {
    const sum = deriveLeaderEstimate(mk(value))
    assert.equal(sum?.totalMinutes, 0, `declaredMinutes=${value} 应被拒（消毒为 null，不计入）`)
    assert.deepEqual(sum?.missing, ['leaf-a'], '非法预估进缺口清单，绝不拿 0 凑等式')
  }
  // 字面量计数：cases.md 预期「5 处」为 T4 补丁前基线锚点数；T6 实测全量 occurrences
  // 并按代码级校验点归因（口径澄清见 T6 报告）。断言：≥5 处且全部为 10080（未收紧成 10）。
  const files = ['plan.ts', 'host.ts', 'runtime.ts', 'client.ts', 'llm-rules.ts']
  let total = 0
  for (const name of files) {
    const text = readFileSync(path.join(process.cwd(), 'src', name), 'utf8')
    const hits = text.match(/10080/g) ?? []
    total += hits.length
    // 不得出现把叶子上限收紧成 10 的校验（>10 拒绝叶子预估的表达式）
    assert.ok(!/declaredMinutes[^\n]{0,40}>\s*10\b[^\n]{0,20}(拒绝|非法|null)/.test(text), `${name} 不得把叶子范围收紧成 10`)
  }
  assert.ok(total >= 5, `10080 字面量应 ≥5 处（实测 ${total}）`)
})

test('C-Q2-06（无时限新契约）：预估和 12/14 仍展示，但永不触发超判据告警', () => {
  const over: any = normaliseStatusEntry({
    subtaskId: 'T1', status: 'in_progress',
    ...delegateEstimates([{ member: 'a', minutes: 5 }, { member: 'b', minutes: 4 }, { member: 'c', minutes: 3 }]),
  })
  assert.equal(over.leaderEstimateOverCriterion, false, '执行时限取消后，10 分钟聚合告警永久关闭')
  assert.equal(over.leaderEstimate.totalMinutes, 12, '预估和仍如实保留为协调信息')
  const single: any = normaliseStatusEntry({
    subtaskId: 'T1', status: 'in_progress',
    ...delegateEstimates([{ member: 'a', minutes: 12 }, { member: 'b', minutes: 2 }]),
  })
  assert.equal(single.leaderEstimateOverCriterion, false)
  assert.equal(single.leaderEstimate.totalMinutes, 14, '预估和照录，不用于告警')
  const under = normaliseStatusEntry({
    subtaskId: 'T1', status: 'in_progress',
    ...delegateEstimates([{ member: 'a', minutes: 5 }, { member: 'b', minutes: 4 }]),
  })
  assert.equal(under.leaderEstimateOverCriterion, false)
})
