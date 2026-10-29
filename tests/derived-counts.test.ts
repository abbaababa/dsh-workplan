/*
 * Derived-count invariants — the executable contract behind 1.4.3.
 *
 * 1.4.2 shipped two sources of truth for the same numbers: the live status list
 * and a `stats` object cached on the record and refreshed only between dispatch
 * batches. The dashboard header read the cache while the stage badges read the
 * list, so a plan could say “0 正在做” and “正在做” on the same card, and a
 * re-queued subtask could read “还没开始” while reporting 100 %.
 *
 * These tests pin the replacement: counts are a pure function of the status
 * list, one implementation (`derivePlanSnapshot`) serves every consumer, and the
 * seven invariants I1–I7 enforced by `aggregateInvariantViolations` must hold on
 * every snapshot the plugin is able to emit.
 * The mutation cases prove the tests would catch a regression instead of merely
 * describing the current behaviour.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateInvariantViolations,
  computeStats,
  deriveAggregates,
  derivePlanSnapshot,
  normaliseStatusEntry,
  normaliseStatuses,
  parseResultMessage,
} from '../src/plan.js'
import { buildRoundResult } from '../src/runtime.js'

function entry(overrides: any = {}) {
  return {
    subtaskId: 'T1',
    stageId: 'S1',
    title: '第 1 步',
    department: 'engineering',
    role: '研发工程师',
    status: 'pending',
    progress: 0,
    childId: null,
    startedAt: null,
    finishedAt: null,
    summary: '',
    error: null,
    ...overrides,
  }
}

test('空计划的计数全为 0，而不是缺失或 NaN', () => {
  const snapshot = derivePlanSnapshot([])
  assert.deepEqual(snapshot.stats, { total: 0, done: 0, blocked: 0, inProgress: 0, pending: 0, progress: 0 })
  assert.deepEqual(snapshot.departments, [])
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
})

test('表驱动：四种状态的计数与按状态加权的总进度', () => {
  const cases: Array<{ name: string; statuses: any[]; expected: any }> = [
    {
      name: '单个 pending',
      statuses: [entry()],
      expected: { total: 1, done: 0, blocked: 0, inProgress: 0, pending: 1, progress: 0 },
    },
    {
      name: '单个 done（进度恒为 100）',
      statuses: [entry({ status: 'done', progress: 100 })],
      expected: { total: 1, done: 1, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
    },
    {
      /*
       * [1.5.2] blocked 的权重仍按 100 计（它不会再前进），但「总体进度」在
       * 计划没有全部完成时封顶 99：否则「1/1 卡住了」会同时显示「总体进度 100%」，
       * 与「100% + 正在收尾」是同一类语义冲突（T4 实测 A.5）。
       */
      name: '单个 blocked（权重按 100 计，但未全部完成时总进度封顶 99）',
      statuses: [entry({ status: 'blocked', progress: 100 })],
      expected: { total: 1, done: 0, blocked: 1, inProgress: 0, pending: 0, progress: 99 },
    },
    {
      name: '单个 in_progress（按自身进度）',
      statuses: [entry({ status: 'in_progress', progress: 40, childId: 'child-1', startedAt: 1 })],
      expected: { total: 1, done: 0, blocked: 0, inProgress: 1, pending: 0, progress: 40 },
    },
    {
      name: '四种状态混合：100 + 40 + 0 + 100 ⇒ 60',
      statuses: [
        entry({ subtaskId: 'T1', status: 'done', progress: 100 }),
        entry({ subtaskId: 'T2', status: 'in_progress', progress: 40 }),
        entry({ subtaskId: 'T3', status: 'blocked', progress: 100 }),
        entry({ subtaskId: 'T4', status: 'pending', progress: 0 }),
      ],
      expected: { total: 4, done: 1, blocked: 1, inProgress: 1, pending: 1, progress: 60 },
    },
  ]

  for (const item of cases) {
    const snapshot = derivePlanSnapshot(item.statuses)
    assert.deepEqual(snapshot.stats, item.expected, item.name)
    assert.deepEqual(aggregateInvariantViolations(snapshot), [], item.name)
  }
})

test('pending 上残留的进度与子 Agent 绑定会被清掉（D3 回归：pending + progress 100）', () => {
  const dirty = entry({ status: 'pending', progress: 100, childId: 'child-41bcef5d', startedAt: 10, finishedAt: 20, summary: '上一轮的结论' })
  const snapshot = derivePlanSnapshot([dirty])
  const only = snapshot.statuses[0]
  assert.equal(only.progress, 0)
  assert.equal(only.childId, null)
  assert.equal(only.startedAt, null)
  assert.equal(only.finishedAt, null)
  assert.equal(snapshot.stats.progress, 0, '待做的子任务不得把计划进度抬到 100')
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
})

test('done 的进度被归一为 100，未知状态降级为 pending 而不是从计数里消失（I2/I6）', () => {
  const snapshot = derivePlanSnapshot([
    entry({ subtaskId: 'T1', status: 'done', progress: 50 }),
    entry({ subtaskId: 'T2', status: 'weird', progress: 77 }),
  ])
  const done = snapshot.statuses.find((item) => item.subtaskId === 'T1')
  const odd = snapshot.statuses.find((item) => item.subtaskId === 'T2')
  assert.equal(done?.progress, 100)
  assert.equal(odd?.status, 'pending')
  assert.equal(odd?.progress, 0)
  assert.equal(snapshot.stats.done + snapshot.stats.blocked + snapshot.stats.inProgress + snapshot.stats.pending, snapshot.stats.total)
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
})

test('缺少 subtaskId 的条目被丢弃，不计入 total', () => {
  const snapshot = derivePlanSnapshot([entry(), {}, null, { subtaskId: '   ' }, entry({ subtaskId: 'T2' })])
  assert.equal(snapshot.stats.total, 2)
  assert.deepEqual(snapshot.statuses.map((item) => item.subtaskId), ['T1', 'T2'])
})

test('重复的 subtaskId 会被不变量捕获（I5）', () => {
  const duplicated = [entry(), entry()]
  const snapshot = derivePlanSnapshot(duplicated)
  const violations = aggregateInvariantViolations(snapshot)
  assert.ok(violations.some((line) => line.includes('I5')), `expected an I5 violation, got: ${violations.join(' | ')}`)
})

test('手工改坏计数会被不变量抓到 —— 证明这些断言本身有效', () => {
  const snapshot = derivePlanSnapshot([
    entry({ subtaskId: 'T1', department: 'engineering', status: 'done', progress: 100 }),
    entry({ subtaskId: 'T2', department: 'qa', status: 'in_progress', progress: 50 }),
  ])
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])

  const mutations: Array<[string, any]> = [
    ['stats.done + 1', { ...snapshot.stats, done: snapshot.stats.done + 1 }],
    ['stats.total + 1', { ...snapshot.stats, total: snapshot.stats.total + 1 }],
    ['stats.pending - 1', { ...snapshot.stats, pending: snapshot.stats.pending - 1 }],
    ['stats.progress 越界', { ...snapshot.stats, progress: 101 }],
  ]
  for (const [label, stats] of mutations) {
    const violations = aggregateInvariantViolations({ ...snapshot, stats })
    assert.ok(violations.length > 0, `${label} 必须被不变量捕获`)
  }

  const departmentMutations = [
    [{ ...snapshot.departments[0], done: 0 }, '部门 done 与统计不符'],
    [{ ...snapshot.departments[0], total: 99 }, '部门 total 与统计不符'],
  ]
  for (const [department, label] of departmentMutations) {
    const violations = aggregateInvariantViolations({ ...snapshot, departments: [department as any] })
    assert.ok(violations.length > 0, `${label} 必须被不变量捕获`)
  }
})

test('computeStats 只是 derivePlanSnapshot 的别名，两条路径不得分叉', () => {
  const statuses = [
    entry({ subtaskId: 'T1', status: 'done', progress: 100 }),
    entry({ subtaskId: 'T2', status: 'blocked', progress: 100 }),
  ]
  assert.deepEqual(computeStats(statuses), derivePlanSnapshot(statuses).stats)
  assert.deepEqual(computeStats(statuses), deriveAggregates(normaliseStatuses(statuses)).stats)
})

test('normaliseStatusEntry 不改动时间戳，只做类型收敛（刷新不得凭空改变载荷）', () => {
  const normalised = normaliseStatusEntry({ subtaskId: 'T1', status: 'in_progress', progress: '55', childId: 'c1', startedAt: 1234 })
  assert.equal(normalised.progress, 55)
  assert.equal(normalised.startedAt, 1234)
  assert.equal(normalised.finishedAt, null)
})

test('结果消息里的 stats 必须等于同一消息里 statuses 的派生值（D1/D2 端到端守卫）', () => {
  /*
   * The record deliberately carries a stale-looking status list: a `pending`
   * subtask still holding `progress: 100` and a `childId`, exactly what the
   * budget-exhausted reset produced in 1.4.2. The payload must self-correct
   * rather than ship the leftovers next to a fresh count.
   */
  const record = {
    plan: { planId: 'wp-derived', title: '派生计数守卫' },
    statuses: [
      entry({ subtaskId: 'T1', status: 'done', progress: 100 }),
      entry({ subtaskId: 'T2', status: 'pending', progress: 100, childId: 'child-abcdef', startedAt: 5 }),
      entry({ subtaskId: 'T3', status: 'in_progress', progress: 30, childId: 'child-123456', startedAt: 6 }),
    ],
    errors: [],
    phase: 'paused',
    resumeCount: 0,
  }
  const message = buildRoundResult(record, 'session-derived', { maxResumes: 4 })
  const payload = parseResultMessage(message)
  assert.ok(payload, 'the result payload must be parseable')

  const derived = derivePlanSnapshot((payload as any).statuses)
  assert.deepEqual((payload as any).stats, derived.stats, '同一个载荷里不允许出现两套计数')
  assert.deepEqual(aggregateInvariantViolations(derived), [])
  assert.equal(derived.stats.done, 1)
  assert.equal(derived.stats.pending, 1)
  assert.equal(derived.stats.inProgress, 1)
  assert.equal(derived.stats.total, 3)
  assert.equal(
    (payload as any).statuses.find((item: any) => item.subtaskId === 'T2').progress,
    0,
    'pending 的旧进度不得进入载荷',
  )
})

test('部门合计恒等于总量，且每个部门只统计自己的子任务（I7）', () => {
  const snapshot = derivePlanSnapshot([
    entry({ subtaskId: 'T1', department: 'engineering', status: 'done', progress: 100 }),
    entry({ subtaskId: 'T2', department: 'engineering', status: 'in_progress', progress: 50 }),
    entry({ subtaskId: 'T3', department: 'qa', status: 'blocked', progress: 100 }),
    entry({ subtaskId: 'T4', department: 'qa', status: 'pending', progress: 0 }),
  ])
  const engineering = snapshot.departments.find((item) => item.id === 'engineering')
  const qa = snapshot.departments.find((item) => item.id === 'qa')
  assert.deepEqual(engineering, { id: 'engineering', total: 2, done: 1, blocked: 0, inProgress: 1 })
  assert.deepEqual(qa, { id: 'qa', total: 2, done: 0, blocked: 1, inProgress: 0 })
  assert.equal(snapshot.departments.reduce((sum, item) => sum + item.total, 0), snapshot.stats.total)
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
})
