import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, buildResultMessage, computeStats, createStatuses } from '../src/plan.js'
import {
  buildPlansPayload,
  reconstructFromSession,
  sessionTurnState,
} from '../src/runtime.js'

/*
 * [1.6.0] 会话结束后状态必须收敛——本次事故的回归测试。
 *
 * 事故现象（session-7129faea…）：会话早已结束、没有任何东西在跑，面板的红色
 * 分组仍写着「进行中」。根因是插件只订阅 `agent/pre-step`，`turn/end` 从不到达，
 * 计划阶段只由派发动作写入，派发结束后再无人收敛。
 *
 * 修复的事实源是会话日志本身（`sessionTurnState`）而不是第二个事件订阅，因此
 * 这里同时覆盖「实时路径」与「回放路径」——两者都经过 serialisePlan。
 * 每条用例都直接断言对外载荷（buildPlansPayload 的返回），不是内部字段。
 */

/*
 * 时间基准必须贴近「现在」：`serialisePlan` 有一条既有的兜底——计划创建超过
 * 10 分钟仍停在 pending 且从未派发，会被改判 cancelled。用固定历史时间戳会让
 * 这些用例全部落到那条兜底上，测的就不是本文件的收敛逻辑了。
 */
const T0 = Date.now() - 30_000

function planFixture(id = 'T1') {
  return {
    planId: 'wp-ended',
    sessionId: 'session-ended',
    createdTurn: 1,
    createdAt: T0,
    title: '会话结束后状态收敛',
    stages: [
      {
        id: 'S1',
        name: '第一阶段',
        subtasks: [
          { id, title: '具体工作', department: 'engineering', role: '工程师', objective: '完成', method: ['做'], inputs: [], outputs: [], dependsOn: [], acceptance: ['达标'], risk: '无' },
        ],
      },
    ],
    contradictions: { primary: { statement: '必须收敛' }, secondary: [], transformationConditions: [] },
    risks: [],
    verification: [],
    practiceLoop: null,
  }
}

function sessionFixture(events: any[], overrides: any = {}) {
  return {
    id: 'session-ended',
    header: { createdAt: T0 },
    seq: events.length,
    eventAt: (seq: number) => events[seq],
    ...overrides,
  }
}

function payloadOf(session: any) {
  const ctx = {
    sessions: {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : null),
    },
  }
  const payload = buildPlansPayload(ctx, { records: new Map() }, null)
  return payload.sessions[0]
}

test('正常结束：turn/end(completed) 后未完成的计划收敛为 ended，不再算「进行中」', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 5000 },
  ]
  const item = payloadOf(sessionFixture(events))

  assert.equal(item.phase, 'ended', '会话结束后不得再下发「进行中」类阶段')
  assert.equal(item.suspendedPhase, 'pending', '原阶段必须保留下来，卡片才能说清停在哪一步')
  assert.equal(item.endReason, 'completed')
  assert.equal(item.endReasonDetail, null)
  assert.equal(item.endedAt, T0 + 5000, '结束时间取自宿主 turn/end，供「已结束」组排序')
  assert.equal(item.stats.done, 0)
})

test('异常中断：turn/end(aborted/user) 同样收敛，并保留中断原因', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, time: T0 + 2000 },
  ]
  const item = payloadOf(sessionFixture(events))

  assert.equal(item.phase, 'ended', '用户中断也是终止路径，必须收敛')
  assert.equal(item.endReason, 'aborted')
  assert.equal(item.endReasonDetail, 'user', 'aborted 的子原因（user/parent/hook/disposed）要如实带出')
})

test('异常中断：进程级 disposed 中断同样收敛', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, time: T0 + 2000 },
  ]
  const item = payloadOf(sessionFixture(events))
  assert.equal(item.phase, 'ended')
  assert.equal(item.endReasonDetail, 'disposed')
})

test('正在跑的一轮不会被误判成已结束', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
  ]
  const item = payloadOf(sessionFixture(events))
  assert.equal(item.phase, 'pending', '没有 turn/end 就是还开着，阶段保持原样')
  assert.equal(item.suspendedPhase, undefined, '未结束时不附带终态字段')
  assert.equal('endedAt' in item, false)
})

test('全部完成的计划结束后仍是 done，且不产生不变量违规', () => {
  const plan = planFixture()
  const statuses = createStatuses(plan).map((item: any) => ({ ...item, status: 'done', progress: 100 }))
  const result = buildResultMessage({
    planId: plan.planId,
    sessionId: plan.sessionId,
    dispatchedAt: T0 + 1500,
    statuses,
    errors: [],
    stats: computeStats(statuses),
    phase: 'done',
  })
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'user/message', data: result, time: T0 + 2000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 3000 },
  ]
  const item = payloadOf(sessionFixture(events))
  assert.equal(item.phase, 'done', '终态 done 不允许被改成 ended（否则违反 I8：全完成却非 done）')
  assert.equal(item.violations, undefined, '结束收敛不得制造跨字段矛盾')
  assert.equal(item.stats.done, item.stats.total)
})

test('已结束后用户说「继续」：新的 turn/start 让阶段回到原派发阶段', () => {
  const plan = planFixture()
  const statuses = createStatuses(plan).map((item: any) => ({ ...item }))
  const paused = buildResultMessage({
    planId: plan.planId,
    sessionId: plan.sessionId,
    dispatchedAt: T0 + 1500,
    statuses,
    errors: [],
    stats: computeStats(statuses),
    phase: 'paused',
  })
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'user/message', data: paused, time: T0 + 2000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 3000 },
  ]
  const ended = payloadOf(sessionFixture(events))
  assert.equal(ended.phase, 'ended')
  assert.equal(ended.suspendedPhase, 'paused')
  assert.equal(ended.resumeAvailable, true, '已结束不等于不可续跑：预算用完的计划仍应可续跑')

  // 用户接着说「继续」——宿主写入新的 turn/start，同一份日志重新出载荷。
  const resumedEvents = [...events, { type: 'turn/start', data: { turn: 2 }, time: T0 + 9000 }]
  const resumed = payloadOf(sessionFixture(resumedEvents))
  assert.equal(resumed.phase, 'paused', '新一轮开始后必须回到原派发阶段，不能被 ended 永久覆盖')
  assert.equal('endedAt' in resumed, false, '回到进行中时必须撤掉终态字段，避免卡片自相矛盾')
})

test('刷新幂等：同一份会话日志连续出两次载荷，结论完全一致', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 5000 },
  ]
  const session = sessionFixture(events)
  const first = payloadOf(session)
  const second = payloadOf(session)
  assert.deepEqual(
    { phase: second.phase, suspendedPhase: second.suspendedPhase, endReason: second.endReason, endedAt: second.endedAt },
    { phase: first.phase, suspendedPhase: first.suspendedPhase, endReason: first.endReason, endedAt: first.endedAt },
  )
  // 回放路径（无内存记录）与实时路径（有记录）必须同源：这里两次都是回放。
  const replay = reconstructFromSession(session)
  assert.ok(replay, '回放必须能重建计划')
  assert.equal(first.phase, 'ended')
})

test('多会话隔离：一个会话结束不影响另一个仍在运行的会话', () => {
  const endedPlan = planFixture()
  const openPlan = { ...planFixture('T1'), planId: 'wp-open', sessionId: 'session-open', title: '还在跑' }
  const endedSession = sessionFixture([
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(endedPlan), time: T0 + 1000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 5000 },
  ])
  const openSession = sessionFixture([
    { type: 'turn/start', data: { turn: 1 }, time: T0 + 100 },
    { type: 'user/message', data: buildPlanMessage(openPlan), time: T0 + 2000 },
  ], { id: 'session-open' })

  const ctx = {
    sessions: {
      list: () => [endedSession, openSession],
      get: (id: string) => [endedSession, openSession].find((s) => s.id === id) ?? null,
    },
  }
  const payload = buildPlansPayload(ctx, { records: new Map() }, null)
  const byId = new Map(payload.sessions.map((item: any) => [item.sessionId, item]))
  assert.equal(byId.get('session-ended')!.phase, 'ended')
  assert.equal(byId.get('session-open')!.phase, 'pending')
})

test('扫描上限：轮次边界早于最近 200 条事件时返回 unknown，绝不猜', () => {
  const events: any[] = [
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 },
  ]
  for (let index = 0; index < 260; index += 1) {
    events.push({ type: 'assistant/message', data: { index }, time: T0 + index })
  }
  const state = sessionTurnState(sessionFixture(events))
  assert.equal(state.state, 'unknown')

  const plan = planFixture()
  const item = payloadOf(sessionFixture([...events, { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 9000 }]))
  assert.equal(item.phase, 'pending', '证据不足时保持原判定，不做乐观收敛')
})

test('回放只采纳成功的 update 调用：isError 的 tool/result 不计完成', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    // 第一次写入失败（宿主 tool/result 带 message.isError=true）
    { type: 'tool/call', data: { callId: 'call-1', name: 'dsh_workplan_update', arguments: { subtaskId: 'T1', status: 'done' } }, time: T0 + 2000 },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-1', isError: true } }, time: T0 + 2100 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 5000 },
  ]
  const item = payloadOf(sessionFixture(events))
  assert.equal(item.stats.done, 0, '失败的 update 不得被回放记成完成（事故里 7/12 的真实成因之一）')
  assert.equal(item.statuses[0].status, 'pending')
})

test('回放采纳成功的 update 调用：isError 缺失或 false 都算写入成功', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'tool/call', data: { callId: 'call-2', name: 'dsh_workplan_update', arguments: { subtaskId: 'T1', status: 'done', progress: 100 } }, time: T0 + 2000 },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-2', isError: false } }, time: T0 + 2100 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 5000 },
  ]
  const item = payloadOf(sessionFixture(events))
  assert.equal(item.stats.done, 1)
  assert.equal(item.phase, 'done', '全部完成后即使这一轮结束也应是 done，不是 ended')
})

test('没有对应 tool/result 的 update 调用不参与回放（保守，不乐观）', () => {
  const plan = planFixture()
  const events = [
    { type: 'turn/start', data: { turn: 1 }, time: T0 },
    { type: 'user/message', data: buildPlanMessage(plan), time: T0 + 1000 },
    { type: 'tool/call', data: { callId: 'call-3', name: 'dsh_workplan_update', arguments: { subtaskId: 'T1', status: 'done' } }, time: T0 + 2000 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, time: T0 + 3000 },
  ]
  const item = payloadOf(sessionFixture(events))
  assert.equal(item.stats.done, 0)
  assert.equal(item.phase, 'ended')
})
