import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildResultMessage,
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
