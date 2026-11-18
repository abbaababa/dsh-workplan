/*
 * [3.0.6][复审修复] 僵尸 in_progress 行回收（reconstructFromSession）。
 *
 * 事故形状：派发中途进程死亡 → 重启 → 回放重建出的行永远停在「正在做」，
 * 但没有任何存活 dispatchPromise 在调度它们；canResumePlan 又只对 executing
 * 放行，于是这些行只能人工逐行 update 才能救。修复：重建路径天然无运行期
 * 派发，尾部把残留 in_progress 一律降级为 blocked，行级 error 沿用
 * settleStaleInflight 的收束写法，另往 record.errors 追加计划级留痕。
 *
 * 钉住的契约：
 *  - 回放后 in_progress 行 → blocked，缺 error 的补「重启后失联」说明；
 *  - record.errors 追加计划级留痕（「重启后失联：派发中断，需重新派发」）；
 *  - 计划 phase 随状态对账成 blocked（不再「executing」），可续跑；
 *  - 无 in_progress 的回放零副作用（errors 原样、行不动）；
 *  - 已有行级 error 的僵尸行保留原说明（settleStaleInflight 同款语义）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildResultMessage,
  computeStats,
  createStatuses,
} from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'

function makePlan(planId: string) {
  return {
    planId,
    sessionId: 'session-zombie',
    createdTurn: 1,
    createdAt: 1000,
    title: '僵尸行回收测试',
    contradictions: { primary: { statement: '状态必须反映真实调度' } },
    stages: [
      {
        id: 'S1',
        subtasks: [
          { id: 'T1', dependsOn: [] },
          { id: 'T2', dependsOn: ['T1'] },
          { id: 'T3', dependsOn: ['T2'] },
        ],
      },
    ],
  }
}

function replaySession(events: any[]) {
  return { seq: events.length, header: { createdAt: 1000 }, eventAt: (n: number) => events[n] }
}

test('回放回收：派发中断残留的 in_progress 行降级为 blocked，errors 留痕', () => {
  const plan = makePlan('wp-zombie-1')
  const statuses = createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'in_progress',
    progress: index === 0 ? 100 : 40,
  }))
  // T3 自带一条行级错误：回收时必须保留原说明（settleStaleInflight 语义）。
  statuses[2].error = '子 Agent 回报：执行到一半被终止'
  const events = [
    { type: 'user/message', data: buildPlanMessage(plan) },
    {
      type: 'user/message',
      data: buildResultMessage({
        planId: plan.planId,
        sessionId: plan.sessionId,
        dispatchedAt: 2000,
        statuses,
        errors: [],
        stats: computeStats(statuses),
      }),
    },
  ]
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
  let record: any
  try {
    record = reconstructFromSession(replaySession(events))
  } finally {
    console.warn = originalWarn
  }

  assert.ok(record)
  const byId = Object.fromEntries(record.statuses.map((row: any) => [row.subtaskId, row]))
  assert.equal(byId.T1.status, 'done', 'done 行不受影响')
  assert.equal(byId.T2.status, 'blocked', '僵尸 in_progress 行必须降级为 blocked')
  assert.equal(byId.T3.status, 'blocked')
  assert.equal(byId.T2.progress, 40, '原进度保留')
  assert.match(String(byId.T2.error), /重启后失联：派发中断，需重新派发/, '缺说明的行补人话留痕')
  assert.equal(byId.T3.error, '子 Agent 回报：执行到一半被终止', '已有行级错误保留原说明')
  assert.equal(
    record.statuses.filter((row: any) => row.status === 'in_progress').length,
    0,
    '重建记录里不得残留任何 in_progress 行',
  )
  assert.equal(record.phase, 'blocked', 'phase 随状态对账：有 blocked 行即 blocked，不再 executing')
  assert.equal(record.resumeAvailable, true, 'blocked 计划可由既有 dispatch 路径接管续跑')
  assert.ok(
    record.errors.some((line: string) => line.includes('重启后失联：派发中断，需重新派发')),
    'record.errors 必须追加计划级留痕',
  )
  assert.ok(
    warnings.some((line) => line.includes('回放回收') && line.includes('2 条僵尸')),
    'console.warn 留痕：回收条数必须可复盘',
  )
})

test('回放零副作用：没有 in_progress 的计划原样重建（errors 不追加留痕）', () => {
  const plan = makePlan('wp-zombie-clean')
  const statuses = createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'pending',
    progress: index === 0 ? 100 : 0,
  }))
  const events = [
    { type: 'user/message', data: buildPlanMessage(plan) },
    {
      type: 'user/message',
      data: buildResultMessage({
        planId: plan.planId,
        sessionId: plan.sessionId,
        dispatchedAt: 2000,
        statuses,
        errors: ['一条历史失败行'],
        stats: computeStats(statuses),
      }),
    },
  ]
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
  let record: any
  try {
    record = reconstructFromSession(replaySession(events))
  } finally {
    console.warn = originalWarn
  }
  assert.ok(record)
  assert.equal(record.statuses.filter((row: any) => row.status === 'blocked').length, 0)
  assert.deepEqual(record.errors, ['一条历史失败行'], '无僵尸行时 errors 原样透传，不得追加回收留痕')
  assert.equal(warnings.length, 0, '无回收发生时不得有回收 warn')
})
