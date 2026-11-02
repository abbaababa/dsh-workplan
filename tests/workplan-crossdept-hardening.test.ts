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
  applyStatus,
  blockCancelledDependents,
  createStatuses,
  deliveryReadiness,
  derivePlanSnapshot,
  markDependentsBlocked,
} from '../src/plan.js'
import { planReplan } from '../src/replan.js'

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
