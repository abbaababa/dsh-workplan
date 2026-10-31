import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCancelMessage,
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

test('两个计划交错回放：事故夹具下 A 的迟到结果与改判按 planId 归属，B 不污染 A', () => {
  /*
   * 事故夹具（session-99984ebd…，seq 与内容取自 durable 负载字段本身）：
   *   seq1216  A 结果 5/14（blocked T5,T6,T8,T9–T14）
   *   seq1223  计划 B（6 项）；seq1228 取消 B
   *   seq1337  A 结果 7/14（blocked T5,T9–T14）—— 在 B 之后到达
   *   seq1517…1532  T9–T14 逐条 done rev4
   * 1.8.8 只保留「最后一个计划」：B 出现时把 A 冻结在 5/14，之后属于 A 的
   * result/update 全部丢弃，重启后卡片从 13/14 掉回 5/14。本用例断言的是
   * 「按 planId 分账」本身——A 的终态逐项、B 的终态、两计划互不污染、
   * 不指定 planId 时仍取最新计划——而不是泛泛的「状态非空」。
   */
  const planIdA = 'wp-6753e19f-6334-42c8-bf9c-2ffe97536235'
  const planIdB = 'wp-dd26f206-9c6e-4375-9bf2-8955a4e32439'
  const sessionId = 'session-replay-incident'
  const makePlan = (planId: string, title: string, count: number, createdTurn: number, createdAt: number) => ({
    planId,
    sessionId,
    createdTurn,
    createdAt,
    title,
    contradictions: { primary: { statement: '两个计划的状态必须按 planId 分账' } },
    stages: [{
      id: 'S1',
      subtasks: Array.from({ length: count }, (_, index) => ({ id: `T${index + 1}`, dependsOn: [] })),
    }],
  })
  const planA = makePlan(planIdA, '审计任务（14 项）', 14, 1, 1000)
  const planB = makePlan(planIdB, '误判生成的计划（6 项）', 6, 6, 3000)
  const statusesFor = (plan: any, done: string[], blocked: string[]) =>
    createStatuses(plan).map((item: any) => ({
      ...item,
      status: blocked.includes(item.subtaskId) ? 'blocked' : done.includes(item.subtaskId) ? 'done' : 'pending',
      progress: done.includes(item.subtaskId) ? 100 : 0,
      error: blocked.includes(item.subtaskId) ? '上游子任务受阻' : null,
    }))
  const resultFor = (plan: any, statuses: any[], dispatchedAt: number) =>
    buildResultMessage({
      planId: plan.planId,
      sessionId,
      dispatchedAt,
      statuses,
      errors: [],
      stats: computeStats(statuses),
    })
  const resultA1 = resultFor(planA, statusesFor(planA, ['T1', 'T2', 'T3', 'T4', 'T7'],
    ['T5', 'T6', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14']), 2000)
  const resultA2 = resultFor(planA, statusesFor(planA, ['T1', 'T2', 'T3', 'T4', 'T6', 'T7', 'T8'],
    ['T5', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14']), 4000)
  const updateEvents = ['T9', 'T10', 'T11', 'T12', 'T13', 'T14'].map((subtaskId) => ({
    type: 'user/message',
    data: buildUpdateMessage({
      planId: planIdA,
      subtaskId,
      status: 'done',
      revision: 4,
      note: `${subtaskId} 主 Agent 复核改判`,
    }),
  }))
  const events = [
    { type: 'user/message', data: buildPlanMessage(planA) },
    { type: 'user/message', data: resultA1 },
    { type: 'user/message', data: buildPlanMessage(planB) },
    { type: 'user/message', data: buildCancelMessage(planIdB, '用户取消') },
    { type: 'user/message', data: resultA2 },
    ...updateEvents,
  ]
  const replay = (list: any[], planId?: string): any =>
    reconstructFromSession({ seq: list.length, header: { createdAt: 1000 }, eventAt: (n: number) => list[n] }, planId)

  const a = replay(events, planIdA)
  assert.ok(a, 'A 必须能按 planId 重建')
  assert.equal(a.plan.planId, planIdA, '指定 planId 时必须返回 A，不能退回最新计划')
  assert.equal(a.statuses.length, 14, 'A 的子任务集合不能被 B 的 6 项替换')
  const doneA = a.statuses.filter((item: any) => item.status === 'done').map((item: any) => item.subtaskId)
  assert.deepEqual(
    doneA.sort(),
    ['T1', 'T2', 'T3', 'T4', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14'].sort(),
    'B 之后到达的 7/14 结果与 T9–T14 六条 done 改判都必须记在 A 上（13/14）',
  )
  const blockedA = a.statuses.filter((item: any) => item.status === 'blocked').map((item: any) => item.subtaskId)
  assert.deepEqual(blockedA, ['T5'], 'A 只剩 T5 受阻')
  assert.deepEqual(
    derivePlanSnapshot(a.statuses).stats,
    { total: 14, done: 13, blocked: 1, inProgress: 0, pending: 0, progress: 93 },
    'A 的计数必须是 13/14、受阻 1，而不是被冻结的 5/14',
  )
  assert.equal(a.phase, 'blocked', '13/14 且 T5 受阻 → blocked，不能因为丢了记录而回到 pending')
  const t9 = a.statuses.find((item: any) => item.subtaskId === 'T9')
  assert.equal(t9.revision, 4, 'T9 的迟到改判必须按 update 的 revision=4 生效')
  assert.equal(t9.updatedBy, 'agent', 'T9 的再判定者必须是人工改判，而不是回放默认的 system')
  assert.match(String(t9.summary), /复核改判/, 'T9 的改判说明必须随 durable update 一起回放')

  const b = replay(events, planIdB)
  assert.equal(b.plan.planId, planIdB)
  assert.equal(b.statuses.length, 6)
  assert.deepEqual(b.statuses.map((item: any) => item.status), Array(6).fill('pending'), 'B 被取消，6 项都没完成')
  assert.equal(b.phase, 'cancelled')
  assert.equal(derivePlanSnapshot(b.statuses).stats.done, 0, 'B 不得继承 A 的完成数')

  assert.equal(replay(events).plan.planId, planIdB, '不指定 planId 时仍回到最新计划 B')

  /*
   * 互不污染：把另一个计划的事件整体删掉后单独回放，两份投影必须逐项相同。
   * 只看计数会漏掉「A 的 T5 被 B 的结果顺手改写成 done」这类单点污染。
   */
  const projection = (statuses: any[]) => statuses.map((item: any) => ({
    subtaskId: item.subtaskId,
    status: item.status,
    progress: item.progress,
    revision: item.revision ?? null,
    updatedBy: item.updatedBy ?? null,
    summary: item.summary,
    error: item.error,
  }))
  const aOnly = replay([events[0], events[1], events[4], ...updateEvents], planIdA)
  assert.deepEqual(projection(a.statuses), projection(aOnly.statuses), 'B 的计划/取消不得改变 A 的任何一项')
  const bOnly = replay([events[2], events[3]], planIdB)
  assert.deepEqual(projection(b.statuses), projection(bOnly.statuses), 'A 的结果与改判不得改变 B 的任何一项')
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

test('人工改判只写一次：durable update 与配对的 tool/result 不得重复 apply', () => {
  /*
   * 一次 `dsh_workplan_update` 在会话里留两条记录：durable 用户消息（带
   * revision 与 updatedBy=agent）和 tool/result。旧回放两份都应用，第二次
   * 以 system 身份再抬一级 revision 并覆盖 summary，人工改判的证据后缀丢失。
   */
  const plan = {
    planId: 'wp-double-apply',
    sessionId: 'session-replay-double',
    createdTurn: 1,
    createdAt: 1000,
    title: '人工改判回放',
    contradictions: { primary: { statement: '改判只写一次' } },
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }, { id: 'T2', dependsOn: ['T1'] }] }],
  }
  const events = [
    { seq: 0, type: 'user/message', data: buildPlanMessage(plan) },
    {
      seq: 1,
      type: 'tool/call',
      data: {
        name: 'dsh_workplan_update',
        callId: 'call-update-1',
        arguments: JSON.stringify({ planId: plan.planId, subtaskId: 'T1', status: 'done', note: '人工复核通过' }),
      },
    },
    {
      seq: 2,
      type: 'user/message',
      data: buildUpdateMessage({ planId: plan.planId, subtaskId: 'T1', status: 'done', note: '人工复核通过', revision: 4, at: 3000 }),
    },
    { seq: 3, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-update-1', isError: false } } },
  ]
  const session = { seq: events.length, header: { createdAt: 1000 }, eventAt: (n: number) => events[n] }
  const record: any = reconstructFromSession(session)

  assert.equal(record.statuses[0].status, 'done')
  assert.equal(record.statuses[0].revision, 4, '配对结果不得把 revision 再抬到 5')
  assert.equal(record.statuses[0].updatedBy, 'agent', '作者必须保留为人工改判，而不是被改成 system')

  // durable 消息缺席时，配对的 tool/result 仍是唯一来源，必须照常生效。
  const onlyTool = [
    { seq: 0, type: 'user/message', data: buildPlanMessage(plan) },
    {
      seq: 1,
      type: 'tool/call',
      data: { name: 'dsh_workplan_update', callId: 'call-update-2', arguments: JSON.stringify({ planId: plan.planId, subtaskId: 'T2', status: 'done' }) },
    },
    { seq: 2, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-update-2', isError: false } } },
  ]
  const fallback: any = reconstructFromSession({ seq: onlyTool.length, header: { createdAt: 1000 }, eventAt: (n: number) => onlyTool[n] })
  assert.equal(fallback.statuses[1].status, 'done', '没有 durable 消息时，tool/result 必须独立生效')
})
