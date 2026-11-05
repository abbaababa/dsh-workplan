/*
 * [1.11.0] 跨部门协作审计（T5/T8/T10）的阻断级修复回归。
 *
 * 三条不变量，任何一条回退都会让用户看到「计划显示可交付、实际没做完」：
 *  1. 计划写了 N 条验收，证据就必须逐条回应 N 条，自创验收项不能顶替；
 *  2. 未验收（unverified/failed）的上游不得解锁下游；
 *  3. 上游被重规划 cancel 后，下游必须显式 blocked，不能永久 pending。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  acceptanceCoverage,
  adjudicateResult,
  buildPlanMessage,
  applyStatus,
  blockCancelledDependents,
  createStatuses,
  deliveryReadiness,
  derivePlanSnapshot,
  markDependentsBlocked,
} from '../src/plan.js'
import { applyReplanStatuses, planReplan } from '../src/replan.js'

function planFixture(overrides: any = {}) {
  return {
    planId: 'p-hardening',
    sessionId: 's',
    createdTurn: 1,
    createdAt: 1,
    stages: [{
      id: 'S1',
      name: 's',
      subtasks: [{
        id: 'T1',
        title: '交付一份数据',
        department: 'data',
        role: '数据工程师',
        objective: '产出可复核数据',
        method: ['取数'],
        outputs: ['data.csv'],
        acceptance: ['给出可复现的取数命令', '给出数据行数与校验值'],
        dependsOn: [],
        ...overrides,
      }],
    }],
  }
}

function evidenceBlock(payload: any) {
  return `已完成。\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(payload)}\n<!-- WORKPLAN_EVIDENCE:END -->`
}

/*
 * [1.13.0] 三阶段证据（规划 → 执行 → 验证）是完成契约的一部分。
 * 这里按计划的两条验收生成两条验证记录，避免三阶段门禁掩盖本文件要锁的
 * 「验收覆盖」规则。
 */
function phasesFixture() {
  return {
    planning: {
      problemAnalysis: ['现状：需要交付可复核数据；约束：只能用离线样本；未知：样本是否完整；主要矛盾：覆盖与时间。'],
      constraints: ['只能使用离线样本'],
      unknowns: ['样本完整性待确认'],
      approach: ['先确认数据源与字段 → 写取数脚本 → 运行并记录行数与校验值 → 对照两条验收逐条留证。'],
    },
    execution: { steps: ['确认数据源', '运行取数脚本', '记录校验值'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [
        { criterion: 'A1', method: '复跑取数命令', evidence: 'node fetch.js --date 2026-11-02 输出一致' },
        { criterion: 'A2', method: '核对行数与 sha256', evidence: 'rows=1200 sha256=abc' },
      ],
      requirementCheck: '两条验收标准均已覆盖。',
    },
  }
}

test('验收覆盖：自创一条验收不能顶替计划要求的 N 条', () => {
  const plan = planFixture()
  const output = evidenceBlock({
    status: 'done',
    acceptance: [{ criterion: '自创验收项', result: 'pass', evidence: '看起来没问题' }],
  })
  const verdict = adjudicateResult({ output, expectedAcceptance: plan.stages[0].subtasks[0].acceptance })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'unverified')
  assert.match(String(verdict.error), /0\/2/)
})

test('验收覆盖：逐条回应（允许措辞差异）才判 structured', () => {
  const plan = planFixture()
  const output = evidenceBlock({
    status: 'done',
    phases: phasesFixture(),
    acceptance: [
      { criterion: '给出可复现的取数命令', result: 'pass', evidence: 'node fetch.js --date 2026-11-02' },
      { criterion: '给出数据行数与校验值', result: 'pass', evidence: 'rows=1200 sha256=abc' },
    ],
  })
  const verdict = adjudicateResult({ output, expectedAcceptance: plan.stages[0].subtasks[0].acceptance })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.verification, 'structured')
})

test('交付门：structured 但只回 1/2 条验收，ready 必须为 false', () => {
  const plan = planFixture()
  const statuses = applyStatus(createStatuses(plan as any), 'T1', {
    status: 'done',
    closure: 'reported',
    verification: 'structured',
    updatedBy: 'agent',
    acceptance: [{ criterion: '给出可复现的取数命令', result: 'pass', evidence: 'cmd' }],
  })
  const readiness = deliveryReadiness(derivePlanSnapshot(statuses), {
    expectedAcceptance: { T1: plan.stages[0].subtasks[0].acceptance },
  })
  assert.equal(readiness.ready, false)
  assert.ok(readiness.blockers.some((item) => item.includes('验收项未被逐条回应')))
})

test('上游 unverified 不得解锁下游（调度门与交付门同一结论）', () => {
  const plan = planFixture()
  plan.stages[0].subtasks.push({
    id: 'T2', title: '消费数据', department: 'qa', role: '验证', objective: '校验数据',
    method: [], outputs: ['report.md'], acceptance: ['给出校验结论'], dependsOn: ['T1'],
  })
  let statuses = createStatuses(plan as any)
  statuses = applyStatus(statuses, 'T1', { status: 'done', verification: 'unverified', acceptance: [], closure: 'reported' })
  const snapshot = derivePlanSnapshot(statuses)
  assert.equal(snapshot.stats.done, 1)
  const readiness = deliveryReadiness(snapshot)
  assert.equal(readiness.ready, false, '未验收的上游不能被当作可交付基础')
})

test('重规划 cancel：悬挂下游显式 blocked，不再永久 pending', () => {
  const plan = planFixture()
  plan.stages[0].subtasks.push({
    id: 'T2', title: '消费数据', department: 'qa', role: '验证', objective: '校验数据',
    method: [], outputs: ['report.md'], acceptance: ['给出校验结论'], dependsOn: ['T1'],
  })
  const replanned = planReplan(plan, [{ action: 'cancel', subtaskId: 'T1', reason: '需求取消' }], {
    planId: plan.planId, reason: '需求取消', revision: 2, at: 1_700_000_000_000,
  })
  assert.equal(replanned.ok, true)
  const statuses = createStatuses(plan as any)
  const blocked = blockCancelledDependents(replanned.ok ? (replanned as any).payload.plan : plan, statuses)
  const downstream: any = blocked.find((item: any) => item.subtaskId === 'T2')
  assert.equal(downstream.status, 'blocked')
  assert.match(String(downstream.error), /依赖已被重规划取消/)
})

test('级联遇已重规划旧行不抛 INVALID_TRANSITION', () => {
  const plan = planFixture()
  plan.stages[0].subtasks.push({
    id: 'T2', title: '下一项', department: 'qa', role: '验证', objective: 'o',
    method: [], outputs: ['r.md'], acceptance: ['a'], dependsOn: ['T1'],
  })
  let statuses = createStatuses(plan as any)
  statuses = applyStatus(statuses, 'T1', { status: 'pending', closure: 'replanned' })
  const next = markDependentsBlocked(plan, statuses, 'T1')
  const downstream: any = next.find((item: any) => item.subtaskId === 'T2')
  assert.equal(downstream.status, 'blocked')
  assert.equal(next.find((item: any) => item.subtaskId === 'T1')?.closure, 'replanned')
})

test('replan 字段强度：依赖超 12 条、验收超 8 条必须拒绝', () => {
  const plan = planFixture()
  const base = { planId: plan.planId, reason: 'r', revision: 2, at: 1_700_000_000_000 }
  const tooManyDeps = planReplan(plan, [{
    action: 'add', subtaskId: 'T9',
    newSubtask: { title: 'x', objective: 'o', dependsOn: Array.from({ length: 13 }, (_, i) => `X${i}`) },
  }], base)
  assert.equal(tooManyDeps.ok, false)
  const tooManyAcceptance = planReplan(plan, [{
    action: 'add', subtaskId: 'T10',
    newSubtask: { title: 'x', objective: 'o', acceptance: Array.from({ length: 9 }, (_, i) => `A${i}`) },
  }], base)
  assert.equal(tooManyAcceptance.ok, false)
})

test('replan 容量：superseded 旧行不占 15 项上限', () => {
  const stages = [{ id: 'S1', name: 's', subtasks: Array.from({ length: 15 }, (_, i) => ({
    id: `T${i + 1}`, title: `t${i}`, department: 'engineering', role: 'r', objective: 'o',
    method: [], outputs: ['x'], acceptance: ['a'], dependsOn: [],
  })) }]
  const plan = { planId: 'p-cap', sessionId: 's', createdTurn: 1, createdAt: 1, stages }
  const result = planReplan(plan, [{ action: 'replace', subtaskId: 'T1', reason: '改', replacement: { title: 't1b' } }], {
    planId: 'p-cap', reason: '改', revision: 2, at: 1_700_000_000_000,
  })
  assert.equal(result.ok, true, '满编 15 项时 replace 不应因旧行占位而失败')
})

test('acceptanceCoverage 短文本只等值匹配，避免 "ok" 命中任意单词', () => {
  assert.equal(acceptanceCoverage(['ok'], [{ criterion: 'broken thing', result: 'pass' }]).missing.length, 1)
  assert.equal(acceptanceCoverage(['ok'], [{ criterion: 'ok', result: 'pass' }]).missing.length, 0)
})

test('acceptanceCoverage 不再接受「只写长验收标准的一部分」（Q6 / U-16）', () => {
  const planned = ['通过登录测试与越权测试']
  const partial = acceptanceCoverage(planned, [{ criterion: '通过登录测试', result: 'pass' }])
  assert.equal(partial.covered, 0, '短子串不能顶替完整验收项')
  assert.equal(partial.missing.length, 1)
  const full = acceptanceCoverage(planned, [{ criterion: '通过登录测试与越权测试', result: 'pass' }])
  assert.equal(full.missing.length, 0)
})

test('acceptanceCoverage 接受按 A1/A2 稳定编号对号入座', () => {
  const planned = ['通过登录测试', '通过越权测试', '给出命令输出']
  const rows = [
    { criterion: 'A1 通过登录测试', result: 'pass' },
    { criterion: 'A2 通过越权测试', result: 'pass' },
    { criterion: 'A3 给出命令输出', result: 'pass' },
  ]
  const result = acceptanceCoverage(planned, rows)
  assert.equal(result.covered, 3)
  assert.equal(result.missing.length, 0)
  assert.equal(acceptanceCoverage(planned, [{ criterion: 'A2 通过越权测试', result: 'pass' }]).missing.length, 2)
})

test('buildPlanMessage 在自动派发时不再要求模型重复调用 dispatch', () => {
  const messagePlan: any = planFixture()
  messagePlan.title = '测试计划'
  messagePlan.contradictions = {
    primary: { statement: '要求与现状的落差', evidence: ['e'], whyPrimary: 'w' },
    secondary: [],
    transformationConditions: [],
  }
  const message = buildPlanMessage(messagePlan, { autoDispatched: true })
  const text = (message.content ?? []).map((part: any) => String(part?.text ?? '')).join('\n')
  assert.match(text, /计划已自动派发/)
  assert.match(text, /不要重复调用 dsh_workplan_dispatch/)
  const manual = buildPlanMessage(messagePlan, {})
  const manualText = (manual.content ?? []).map((part: any) => String(part?.text ?? '')).join('\n')
  assert.match(manualText, /必须调用 dsh_workplan_dispatch/)
})

test('重规划 cancel：applyReplanStatuses 自身级联阻断传递下游（D-13）', () => {
  const plan: any = {
    planId: 'p-cancel-cascade',
    sessionId: 's',
    createdTurn: 1,
    createdAt: 1,
    stages: [{
      id: 'S1',
      name: '交付',
      subtasks: [
        { id: 'A', title: '上游', department: 'engineering', role: 'dev', objective: 'a', method: ['x'], inputs: [], outputs: ['a'], dependsOn: [], acceptance: ['a ok'], risk: 'none' },
        { id: 'B', title: '下游一', department: 'qa', role: 'qa', objective: 'b', method: ['x'], inputs: [], outputs: ['b'], dependsOn: ['A'], acceptance: ['b ok'], risk: 'none' },
        { id: 'C', title: '下游二', department: 'writing', role: 'w', objective: 'c', method: ['x'], inputs: [], outputs: ['c'], dependsOn: ['B'], acceptance: ['c ok'], risk: 'none' },
      ],
    }],
  }
  const statuses = createStatuses(plan)
  const result: any = planReplan(plan, [{ action: 'cancel', subtaskId: 'A', reason: '需求撤销' }], {
    planId: plan.planId, reason: '上游需求撤销', revision: 1, at: 1_700_000_000_000,
  })
  assert.equal(result.ok, true)
  const next = applyReplanStatuses(statuses, result.payload)
  const byId = new Map(next.map((row: any) => [row.subtaskId, row]))
  assert.equal((byId.get('A') as any).closure, 'replanned')
  for (const [id, upstream] of [['B', 'A'], ['C', 'B']] as const) {
    const row: any = byId.get(id)
    assert.equal(row.status, 'blocked', `${id} 不得停在 pending`)
    assert.deepEqual((row.blockedBy ?? []).map((item: any) => item.id), [upstream])
    assert.match(String(row.error), /需求撤销/)
    assert.match(String(row.error), /A/)
  }
})
