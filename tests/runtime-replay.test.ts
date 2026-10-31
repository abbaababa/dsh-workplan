import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildResultMessage,
  buildUpdateMessage,
  computeStats,
  createStatuses,
  derivePlanSnapshot,
} from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'

test('dashboard reconstruction replays result statuses, not only the plan', () => {
  const plan = {
    planId: 'wp-replay',
    sessionId: 'session-replay',
    createdTurn: 1,
    createdAt: 1000,
    title: '回放测试',
    contradictions: { primary: { statement: '状态必须持久' } },
    stages: [
      {
        id: 'S1',
        subtasks: [
          { id: 'T1', dependsOn: [] },
          { id: 'T2', dependsOn: ['T1'] },
        ],
      },
    ],
  }
  const statuses = createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'blocked',
    progress: index === 0 ? 100 : 0,
    error: index === 0 ? null : '上游子任务受阻：T1',
  }))
  const planMessage = buildPlanMessage(plan)
  const resultMessage = buildResultMessage({
    planId: plan.planId,
    sessionId: plan.sessionId,
    dispatchedAt: 2000,
    statuses,
    errors: ['T2 blocked'],
    stats: computeStats(statuses),
  })
  const events = [
    { type: 'user/message', data: planMessage },
    { type: 'user/message', data: resultMessage },
  ]
  const session = {
    seq: events.length,
    header: { createdAt: 1000 },
    eventAt: (seq: number) => events[seq],
  }
  const record: any = reconstructFromSession(session)
  assert.ok(record)
  assert.equal(record.statuses[0].status, 'done')
  assert.equal(record.statuses[1].status, 'blocked')
  /*
   * Counts are derived from the status list, never stored beside it. A record
   * that carried its own `stats` is what allowed the header and the badges to
   * disagree in 1.4.2, so the absence of that field is asserted explicitly.
   */
  assert.equal('stats' in record, false)
  assert.equal(derivePlanSnapshot(record.statuses).stats.done, 1)
  assert.equal(derivePlanSnapshot(record.statuses).stats.blocked, 1)
})

test('a plan with all work done is done only after the result message', () => {
  const plan = {
    planId: 'wp-replay-done',
    sessionId: 'session-replay-done',
    createdTurn: 1,
    createdAt: 1000,
    title: '完成态测试',
    contradictions: { primary: { statement: '完成必须有结果记录' } },
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }] }],
  }
  const statuses = createStatuses(plan).map((item: any) => ({
    ...item,
    status: 'done',
    progress: 100,
    finishedAt: 2000,
  }))
  const planMessage = buildPlanMessage(plan)
  const resultMessage = buildResultMessage({
    planId: plan.planId,
    sessionId: plan.sessionId,
    dispatchedAt: 2000,
    statuses,
    errors: [],
    stats: computeStats(statuses),
  })
  const withResult = {
    seq: 2,
    header: { createdAt: 1000 },
    eventAt: (seq: number) => [
      { type: 'user/message', data: planMessage },
      { type: 'user/message', data: resultMessage },
    ][seq],
  }
  const after: any = reconstructFromSession(withResult)
  assert.equal(after.phase, 'done')
  assert.equal(derivePlanSnapshot(after.statuses).stats.done, 1)
})

test('a second plan must not freeze the earlier plan’s later result or update', () => {
  /*
   * 事故复现：wp-6753e19f 还没跑完，「继续」被误判生成了 wp-dd26f206。
   * 旧回放只保留“最后一个计划”的状态，wp-6753e19f 之后到达的 7/14 结果
   * 与六条 done 改判全部被丢弃，重启后卡片从 13/14 掉回 5/14。
   */
  const planA = {
    planId: 'wp-a',
    sessionId: 'session-replay-two',
    createdTurn: 1,
    createdAt: 1000,
    title: 'A',
    contradictions: { primary: { statement: '较早的计划不能被后来的计划冻结' } },
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }, { id: 'T2', dependsOn: ['T1'] }] }],
  }
  const planB = {
    planId: 'wp-b',
    sessionId: 'session-replay-two',
    createdTurn: 2,
    createdAt: 3000,
    title: 'B',
    contradictions: { primary: { statement: '最新计划仍是默认目标' } },
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }] }],
  }
  const statusesA = createStatuses(planA).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'blocked',
    progress: index === 0 ? 100 : 0,
  }))
  const resultA = buildResultMessage({
    planId: 'wp-a',
    sessionId: 'session-replay-two',
    dispatchedAt: 4000,
    statuses: statusesA,
    errors: [],
    stats: computeStats(statusesA),
  })
  const updateA = buildUpdateMessage({
    planId: 'wp-a',
    subtaskId: 'T2',
    status: 'done',
    revision: 9,
    note: '主 Agent 复核通过',
  })
  const events = [
    { type: 'user/message', data: buildPlanMessage(planA) },
    { type: 'user/message', data: buildPlanMessage(planB) },
    { type: 'user/message', data: resultA },
    { type: 'user/message', data: updateA },
  ]
  const session = { seq: events.length, header: { createdAt: 1000 }, eventAt: (n: number) => events[n] }

  const a: any = reconstructFromSession(session, 'wp-a')
  assert.ok(a, '旧计划必须仍可按 planId 重建')
  assert.equal(derivePlanSnapshot(a.statuses).stats.done, 2, '旧计划必须收到自己迟到的 result 与 update')
  assert.equal(a.phase, 'done')

  const b: any = reconstructFromSession(session)
  assert.equal(b.plan.planId, 'wp-b', '不指定 planId 时仍回到最新计划')
  assert.equal(b.phase, 'pending')
})

test('回放窗口仍要够到 MAX_HISTORY_EVENTS 之前的旧计划', () => {
  /*
   * 长会话（>2000 事件）里，窗口起点会越过最早的 plan 消息。旧代码按
   * planId 重建只会得到 null，dispatch 与 status 一起退回新计划。
   */
  const planOld = {
    planId: 'wp-old',
    sessionId: 'session-replay-window',
    createdTurn: 1,
    createdAt: 1000,
    title: '旧计划',
    contradictions: { primary: { statement: '旧计划仍可续跑' } },
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }, { id: 'T2', dependsOn: ['T1'] }] }],
  }
  const planNew = {
    planId: 'wp-new',
    sessionId: 'session-replay-window',
    createdTurn: 3,
    createdAt: 9000,
    title: '新计划',
    contradictions: { primary: { statement: '新计划是默认目标' } },
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }] }],
  }
  const filler = Array.from({ length: 2098 }, () => ({ type: 'assistant/message', data: {} }))
  const events = [
    { type: 'user/message', data: buildPlanMessage(planOld) },
    ...filler,
    { type: 'user/message', data: buildPlanMessage(planNew) },
  ]
  const session = { seq: events.length, header: { createdAt: 1000 }, eventAt: (n: number) => events[n] }

  const old: any = reconstructFromSession(session, 'wp-old')
  assert.equal(old?.plan?.planId, 'wp-old', '窗口外的旧计划必须仍可按 planId 重建')
  assert.equal(old.statuses.length, 2)

  const latest: any = reconstructFromSession(session)
  assert.equal(latest.plan.planId, 'wp-new', '不指定计划时窗口行为不变')
})
