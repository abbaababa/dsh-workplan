import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, buildResultMessage, computeStats, createStatuses } from '../src/plan.js'
import { aggregateInvariantViolations, derivePlanSnapshot } from '../src/plan.js'
import { buildPlansPayload } from '../src/runtime.js'

/*
 * [1.8.4] 回归测试：「会话已出结果，左侧栏却显示『已结束 ∧ 正在做』」。
 *
 * 事故会话 session-b83e4a75-225a-4e78-9bb2-d8cb90078278，2026-10-30：
 *   · 19:58:39 turn/end（宿主本轮结束）
 *   · 20:06:33 用户截图：卡片在「已结束」组、60%，第 4 步却写着「正在做」
 *   · 20:16:37 新的 turn/start（用户说「继续」）
 *   · 20:18:57 turn/end，20:22:50 才写入计划结果（blocked / 11 of 15）
 *
 * 也就是说：`turn/end` 之后派发仍在真实运行近 4 分钟。旧实现把「回合已结束」
 * 当成「没有东西在跑」，直接下发 `phase='ended'`，于是同一张卡同时说出
 * 「已结束」和「正在做」。修复的事实源是 `record.dispatchPromise`（派发时赋值、
 * `.finally()` 置空的权威存活信号），不是第二个事件订阅。
 *
 * 这里直接断言对外载荷（buildPlansPayload 的返回），不碰内部字段。
 */

const T0 = Date.now() - 30_000

function planFixture() {
  return {
    planId: 'wp-live-dispatch',
    sessionId: 'session-live',
    createdTurn: 1,
    createdAt: T0,
    title: '异步派发跨过回合结束',
    stages: [
      {
        id: 'S1',
        name: '第一阶段',
        subtasks: [
          { id: 'T1', title: '已完成的一步', department: 'engineering', role: '工程师', objective: '完成', method: ['做'], inputs: [], outputs: [], dependsOn: [], acceptance: ['达标'], risk: '无' },
          { id: 'T2', title: '还在跑的一步', department: 'engineering', role: '工程师', objective: '完成', method: ['做'], inputs: [], outputs: [], dependsOn: [], acceptance: ['达标'], risk: '无' },
        ],
      },
    ],
    contradictions: { primary: { statement: '矛盾必须说清' }, secondary: [], transformationConditions: [] },
    risks: [],
    verification: [],
    practiceLoop: null,
  }
}

/** 一个已结束回合的会话日志：turn/start → turn/end，中间没有任何东西在跑。 */
function endedSession(events: any[] = []) {
  const log = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    ...events,
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 5000 },
  ]
  return {
    id: 'session-live',
    header: { createdAt: T0 },
    seq: log.length,
    eventAt: (seq: number) => log[seq],
  }
}

function statusesFor(plan: any, overrides: any = {}) {
  return createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    ...(index === 0 ? { status: 'done', progress: 100 } : {}),
    ...(index === 1 ? { status: 'in_progress', progress: 40, startedAt: T0 + 1000 } : {}),
    ...overrides,
  }))
}

function payloadOf(session: any, record: any) {
  const ctx = {
    sessions: {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : null),
    },
  }
  const state = { records: new Map([[session.id, record]]) }
  return buildPlansPayload(ctx, state, null).sessions[0]
}

test('回合已结束但派发仍在跑：载荷不得收敛为 ended，且必须带出存活事实', () => {
  const plan = planFixture()
  const record: any = {
    plan,
    planId: plan.planId,
    statuses: statusesFor(plan),
    phase: 'executing',
    createdAt: T0,
    updatedAt: T0 + 6000,
    // 派发尚未结算：这是一个永不 settle 的 promise，与 `dispatchPromise` 同形。
    dispatchPromise: new Promise(() => {}),
  }
  const item = payloadOf(endedSession(), record)

  assert.equal(item.running, true, '存活事实必须随载荷下发，展示层才能自保')
  assert.notEqual(item.phase, 'ended', '派发仍在跑时绝不许宣告结束（本次事故的根因）')
  assert.equal(item.phase, 'executing', '必须显示真实阶段')
  assert.equal(item.suspendedPhase, undefined, '没有 ended 就不该有 suspendedPhase')
  assert.equal(item.stats.inProgress, 1, '正在跑的子任务必须如实计数')
})

test('派发结算后同一条记录才允许收敛为 ended，并保留原阶段', () => {
  const plan = planFixture()
  const record: any = {
    plan,
    planId: plan.planId,
    // 结算后残留一个 in_progress（进程被打断时的典型形态），由下一条用例验证收敛。
    statuses: statusesFor(plan, {}).map((item: any) => (item.status === 'in_progress' ? { ...item, status: 'blocked', progress: 40 } : item)),
    phase: 'executing',
    createdAt: T0,
    updatedAt: T0 + 6000,
    dispatchPromise: null,
  }
  const item = payloadOf(endedSession(), record)

  assert.equal(item.running, false, '没有活派发时存活事实必须是 false')
  assert.equal(item.phase, 'ended', '派发结算且回合结束后，未完成的计划应进「已结束」')
  assert.equal(item.suspendedPhase, 'blocked', '原阶段必须保留，卡片才能说清停在哪')
  assert.equal(item.endReason, 'completed')
  assert.equal(item.endedAt, T0 + 5000)
})

test('回合结束且无活派发：残留的 in_progress 必须收敛，不能与「已结束」并存', () => {
  const plan = planFixture()
  const record: any = {
    plan,
    planId: plan.planId,
    statuses: statusesFor(plan),
    phase: 'executing',
    createdAt: T0,
    updatedAt: T0 + 6000,
    dispatchPromise: null,
  }
  const item = payloadOf(endedSession(), record)

  assert.equal(item.phase, 'ended')
  assert.equal(
    item.statuses.some((entry: any) => entry.status === 'in_progress'),
    false,
    '「已结束」的卡片里不允许再出现「正在做」（本次事故的第二处矛盾）'
  )
  const settled = item.statuses.find((entry: any) => entry.subtaskId === 'T2')
  assert.equal(settled.status, 'blocked', '没跑完的一步只能判为受阻，等待续跑')
  assert.ok(String(settled.error || '').includes('续跑'), '必须说明为什么停住、以及可以续跑')
  assert.equal(item.stats.inProgress, 0, '计数必须与下发的状态列表同口径')
  assert.equal(item.stats.blocked, 1)
  assert.deepEqual(item.violations ?? [], [], '收敛后的载荷必须通过 I1–I10 全部不变量')
})

test('回放路径同样不把 in_progress 留在 ended 载荷里', () => {
  const plan = planFixture()
  const statuses = statusesFor(plan)
  const events = [
    { type: 'user/message', data: buildPlanMessage(plan) },
    { type: 'user/message', data: buildResultMessage({
      planId: plan.planId,
      sessionId: plan.sessionId,
      dispatchedAt: T0 + 1000,
      statuses,
      errors: ['T2 仍在执行时回合被打断'],
      stats: computeStats(statuses),
    }) },
  ]
  // records 为空 ⇒ 走 reconstructFromSession 回放，与进程重启后的刷新一致。
  const item = payloadOf(endedSession(events), {})

  assert.equal(item.phase, 'ended')
  assert.equal(
    item.statuses.some((entry: any) => entry.status === 'in_progress'),
    false,
    '刷新后看到的结论必须与实时路径一致'
  )
  assert.deepEqual(item.violations ?? [], [])
})

test('收敛只改下发的副本：不修改内存记录里的原始状态', () => {
  const plan = planFixture()
  const statuses = statusesFor(plan)
  const record: any = {
    plan,
    planId: plan.planId,
    statuses,
    phase: 'executing',
    createdAt: T0,
    updatedAt: T0 + 6000,
    dispatchPromise: null,
  }
  payloadOf(endedSession(), record)

  assert.equal(record.statuses[1].status, 'in_progress', '原始记录必须保持原样，用户续跑后仍按它继续')
  assert.equal(record.phase, 'executing')
})

test('新增 I11 不变量：修复前的形态（ended + in_progress）会被自检判红', () => {
  const plan = planFixture()
  const snapshot = derivePlanSnapshot(statusesFor(plan))
  // 修复前的形态：一个 in_progress 子任务配 ended 阶段。展示层再也不会这么下发，
  // 但如果未来某个改动重新引入它，自检必须把具体计数带出来。
  const violations = aggregateInvariantViolations(snapshot, 'ended')
  assert.equal(snapshot.stats.inProgress, 1)
  assert.ok(
    violations.some((message) => message.startsWith('I11')),
    `自检必须点名 I11，实际：${violations.join(' | ')}`
  )
  // 修复后的形态（无 in_progress）不得再触发 I11。
  const settled = derivePlanSnapshot(statusesFor(plan, {}).map((item: any) => (item.status === 'in_progress' ? { ...item, status: 'blocked' } : item)))
  assert.equal(aggregateInvariantViolations(settled, 'ended').some((message) => message.startsWith('I11')), false)
})
