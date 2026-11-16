/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：Q3 拆分优先与接替（E-2/E-3）。
 * 承载用例：C-Q3-01…C-Q3-05（cases.md §6.2）。
 * 预期唯一来源：spec:133-136（AC-Q3-1…AC-Q3-4）。
 * GAP-1 消解口径：AC-Q3-1 按 Q2-B 软门禁断言（标记可查询、不得显示达标），
 * 保留「若硬拒绝则 fail」守卫；GAP-3 口径：运行时不自动 replan，断言最小可观测
 * （非 done＋文案指向 replan(replace)/接替＋产物只读保留）。
 * Q3 参考实现绑定：q3SettlementVerdict（fields.md §5，替换 referenceQ3Settlement）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { validatePlan } from '../src/plan.js'
import {
  ACTIVE_ENV, WIDE_WINDOWS, approval, completedWithEvidence, dispatch, dropWorkRoot,
  landReport, makeRuntime, rowOf, waitFor, withEnv, withFakeNow,
} from './helpers/scv2-runtime.js'

const roots: string[] = []
after(() => { for (const r of roots) dropWorkRoot(r) })
function harness(createdAt: number, options: any = {}) {
  const h = makeRuntime(createdAt, options)
  roots.push(h.workRoot)
  return h
}
function planWithSubtask(subtask: any) {
  return {
    version: 1,
    title: '判据 v2 Q3 验收',
    taskUnderstanding: { originalRequest: '验证拆分优先', deliverable: '结构校验', successCriteria: ['不凑数'], constraints: [], knownFacts: [], unknowns: [], assumptions: [] },
    contradictions: { primary: { statement: '质量与时长', evidence: ['大任务无法 10 分钟完成'], whyPrimary: '拆分优先' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', goal: '验证', rationale: '先验证', checkpoint: '通过', subtasks: [subtask] }],
    risks: [{ risk: '无', likelihood: 'low', impact: '无', mitigation: '无', trigger: '无' }],
    verification: [{ item: '结构', method: '单测', evidence: '本文件' }],
    practiceLoop: { plan: '列样例', do: '跑校验', check: '核对', act: '修正' },
  }
}
function subtask(extra: any = {}) {
  return { id: 'T1', title: '验证', department: 'research', role: '分析', objective: '验证拆分优先', method: ['样例'], inputs: [], outputs: ['报告'], dependsOn: [], acceptance: ['断言通过'], risk: '无', ...extra }
}

test('C-Q3-01（新契约）：12 分钟预估只是信息，不产生超判据标记、拆分理由或硬拒绝', () => {
  const res: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 12 })))
  assert.equal(res.ok, true, '估时长短不参与结构校验')
  const row = res.plan.stages[0].subtasks[0]
  assert.equal(row.estimateOverCriterion, undefined, '不再生成超判据标记')
  assert.equal(row.estimateNeedsJustification, undefined, '不再要求时长理由')
  assert.ok(!JSON.stringify(res.plan).includes('达标'), '规划产物不得显示时间达标')
  assert.ok(!JSON.stringify(res.plan).includes('协商上限'), '不得生成时间协商上限')
})

test('C-Q3-02（新契约）：旧判据超时也按真实证据 done；产物核验与摘要照旧', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    await withFakeNow(11 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000), '应已结算')
      assert.equal(row.status, 'done', '证据齐全即 done，不因旧判据改判')
      assert.equal(row.blockedKind ?? null, null)
      assert.equal(row.criterionResult ?? null, null)
      assert.ok(String(row.summary ?? '').length > 0, '正常完成摘要保留')
    })
    const row = await rowOf(h.runtime, h.session)
    assert.ok(row.artifacts.some((a: any) => a.ref === 'T1_report.md' && a.exists === true), '真实产物仍核验')
    assert.ok(!/criterion-overrun|replan\(replace\)/.test(String(row.error ?? '')), '不得产生旧判据接替文案')
  })
})

test('C-Q3-03（AC-Q3-3 边界）：合法接替行通过结构校验；outputs/acceptance 为空被拒且点名字段', () => {
  const legal: any = validatePlan(planWithSubtask(subtask({ id: 'T1b', title: '接替行', objective: '只补缺口', outputs: ['缺口报告'], acceptance: ['缺口补齐'] })))
  assert.equal(legal.ok, true, '合法接替行（单目标/单产物/验收非空）通过')
  const noOutputs: any = validatePlan(planWithSubtask(subtask({ outputs: [] })))
  assert.equal(noOutputs.ok, false)
  assert.ok(noOutputs.errors.some((line: string) => /outputs/.test(line)), `拒因点名 outputs：${JSON.stringify(noOutputs.errors)}`)
  const noAcceptance: any = validatePlan(planWithSubtask(subtask({ acceptance: [] })))
  assert.equal(noAcceptance.ok, false)
  assert.ok(noAcceptance.errors.some((line: string) => /acceptance/.test(line)), `拒因点名 acceptance：${JSON.stringify(noAcceptance.errors)}`)
})

test('C-Q3-04（AC-Q3-3 反例）：method 为空被拒（硬规则）；多主产物凑数行按实现现状判定', (t) => {
  const noMethod: any = validatePlan(planWithSubtask(subtask({ method: [] })))
  assert.equal(noMethod.ok, false, '①method 为空被拒（既有硬规则）')
  assert.ok(noMethod.errors.some((line: string) => /method/.test(line)))
  // ② 凑数行：outputs:['A','B'] 且 objective 含「同时」——若已有校验则拒绝；
  // 未实现则记 unverified 并登记缺口（不得写 pass）。实测：readSubtasks outputs
  // 上限 12（src/plan.ts:909），无「单一主产物」校验 ⇒ 走 unverified 分支。
  const padded: any = validatePlan(planWithSubtask(subtask({ outputs: ['A', 'B'], objective: '同时产出 A 与 B 两个交付物' })))
  if (padded.ok === false) {
    assert.ok(padded.errors.some((line: string) => /outputs|产物/.test(line)), '拒绝须点名产物字段')
  } else {
    t.todo('多主产物校验未实现（outputs 上限 12，无单一主产物约束）⇒ 本项 unverified，缺口登记交主 Agent（GAP-T6-2）')
  }
})

test('C-Q3-05（新契约）：旧审批入口停用，11 分钟后仍凭证据 done，不生成接替行', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    const disabled: any = await h.runtime.updateStatus({ session: h.session }, {
      subtaskId: 'T1', extendMs: 2_000, criterionApproval: approval({ at: Date.now() - 1_000 }),
    })
    assert.equal(disabled.ok, false)
    assert.equal(disabled.code, 'TIME_LIMITS_DISABLED')
    await withFakeNow(11 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000))
      assert.equal(row.status, 'done', '完成不依赖旧时间批准')
      assert.equal(row.criterionResult ?? null, null)
    })
    const row = await rowOf(h.runtime, h.session)
    assert.equal(row.criterionException ?? null, null, '不再写时间例外')
    const snapshot: any = await h.runtime.statusTool({ session: h.session }, {})
    assert.equal(snapshot.statuses.length, 1, '不生成接替行')
    assert.equal((row.criterionViolations ?? []).length, 0, '不记时间违规')
  })
})
