/*
 * [T4] F1–F6 差距清单回归（reports/T2_fix_gap_list.md 第 6 节）。
 *
 * 这组用例只覆盖 3.1.5 仍未闭合的底层位置：结算备份文件名（F3）、被吞回调的
 * 审计行（F4）、收敛标记的持久化白名单（F4）、交付一致性告警（F6）、以及
 * 「历史行不自动改写」的 unresolved 输出（F5）。F1 的收敛主路径在
 * tests/delegate-ended-session-reconcile.test.ts，F2 在
 * tests/delegate-completion-projection.test.ts。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyStatus, deriveDelegateConsistencyWarnings, normaliseStatusEntry } from '../src/plan.js'
import {
  reconcileEndedDelegateSessions,
  settlementBackupPaths,
  settlementCallbackFailureLine,
} from '../src/runtime.js'

test('F3：结算备份新名含 planId，旧名兼容，跨计划同名子任务不再互覆', () => {
  const planA = settlementBackupPaths('/work', 'wp-aaa', 'T4')
  const planB = settlementBackupPaths('/work', 'wp-bbb', 'T4')
  assert.deepEqual(planA, [
    '/work/reports/wp-settlement-wp-aaa-T4.json',
    '/work/reports/wp-settlement-T4.json',
  ])
  assert.equal(planB[0], '/work/reports/wp-settlement-wp-bbb-T4.json')
  assert.notEqual(planA[0], planB[0], '两个计划同名子任务的新文件名必须不同')
  assert.equal(planA[1], planB[1], '旧名只作为兼容候选保留，且排在新名之后')
})

test('F3：planId 缺失时退化为旧名；非法字符清洗后不产生路径穿越', () => {
  assert.deepEqual(settlementBackupPaths('/work', '', 'T4'), ['/work/reports/wp-settlement-T4.json'])
  const sanitised = settlementBackupPaths('/work', '../x y', 'T4')
  assert.equal(sanitised[0], '/work/reports/wp-settlement-.._x_y-T4.json')
  assert.equal(sanitised[1], '/work/reports/wp-settlement-T4.json')
})

test('F4：结算回调异常审计行包含子任务、childId 与阶段', () => {
  const line = settlementCallbackFailureLine({
    subtaskId: 'T4',
    childId: 'c-1',
    stage: 'delegate-settlement',
    error: new Error('boom'),
  })
  assert.match(line, /^T4: 结算回调异常/)
  assert.match(line, /childId=c-1/)
  assert.match(line, /阶段=delegate-settlement/)
  assert.match(line, /boom/)
  assert.match(settlementCallbackFailureLine({ subtaskId: 'T5', stage: 'x', error: 'bad' }), /childId=未知/)
})

test('F4：收敛标记 reconciledAt/reconciledFrom 经 applyStatus 白名单存活（回放不丢）', () => {
  const rows = applyStatus(
    [{ subtaskId: 'T4', status: 'in_progress' }],
    'T4',
    {
      delegates: [
        {
          member: 'a',
          status: 'failed',
          error: '无结果块',
          finishedAt: 1,
          reconciledAt: 123,
          reconciledFrom: 'settled-message',
        },
      ],
      revision: 2,
      updatedBy: 'child',
    },
  )
  const delegate = (rows[0] as any).delegates[0]
  assert.equal(delegate.reconciledAt, 123)
  assert.equal(delegate.reconciledFrom, 'settled-message')
  const normalised = normaliseStatusEntry(rows[0]) as any
  assert.equal(normalised.delegates[0].reconciledAt, 123)
  assert.equal(normalised.delegates[0].reconciledFrom, 'settled-message')
})

test('F4：非法收敛标记被 fail-closed 丢弃', () => {
  const rows = applyStatus(
    [{ subtaskId: 'T4', status: 'in_progress' }],
    'T4',
    { delegates: [{ member: 'a', status: 'running', reconciledAt: 'oops', reconciledFrom: 'forged' }] },
  )
  const delegate = (rows[0] as any).delegates[0]
  assert.equal(delegate.reconciledAt, undefined)
  assert.equal(delegate.reconciledFrom, undefined)
})

test('F6：部门行已 done 而专家结算 0/N 时输出一致性告警，但不改变 done 判定', () => {
  const row = normaliseStatusEntry({
    subtaskId: 'T4',
    status: 'done',
    verification: 'structured',
    acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'x' }],
    delegates: [
      { member: 'a', status: 'running' },
      { member: 'b', status: 'running' },
    ],
  })
  const warnings = deriveDelegateConsistencyWarnings([row])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /T4 已验收完成/)
  assert.match(warnings[0], /0\/2/)
  assert.equal(row.status, 'done', '告警不得改判')
})

test('F6：专家已有 done、行未 done、或无第三层分工时不告警', () => {
  const settled = normaliseStatusEntry({ subtaskId: 'T4', status: 'done', delegates: [{ member: 'a', status: 'done' }] })
  assert.deepEqual(deriveDelegateConsistencyWarnings([settled]), [])
  const working = normaliseStatusEntry({ subtaskId: 'T5', status: 'in_progress', delegates: [{ member: 'a', status: 'running' }] })
  assert.deepEqual(deriveDelegateConsistencyWarnings([working]), [])
  const noDelegates = normaliseStatusEntry({ subtaskId: 'T6', status: 'done' })
  assert.deepEqual(deriveDelegateConsistencyWarnings([noDelegates]), [])
})

test('F1/F5：既无活体会话又无持久快照的运行行进入 unresolved（历史不静默改写）', () => {
  const result = reconcileEndedDelegateSessions(
    [{ member: 'history', childId: 'c-old', status: 'running' }],
    () => undefined,
    () => undefined,
  )
  assert.equal(result.changed, false)
  assert.equal(result.unresolved.length, 1)
  assert.match(String(result.unresolved[0].reason), /无持久结算快照/)
  assert.equal(result.delegates[0].status, 'running')
})
