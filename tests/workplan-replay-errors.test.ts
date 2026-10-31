/*
 * [1.8.17] A replayed record must be shaped like a live one.
 *
 * The 17:51:37 round of plan wp-40ce5eee died with
 *   TypeError: record.errors is not iterable
 * at the round-budget boundary: the host had restarted, so `dispatchTool`
 * rebuilt the plan with `reconstructFromSession`, whose record carried no
 * `errors` field. The abort path then spread it (`[...record.errors, …]`) and
 * the throw marked the six remaining subtasks blocked even though nothing had
 * gone wrong with them.
 *
 * These tests pin both halves of the fix:
 *  - replay always yields an `errors` array and keeps the durable failure lines;
 *  - dispatching that reconstructed record with a failing child records the
 *    failure instead of aborting the whole round.
 */
import test from 'node:test'

import assert from 'node:assert/strict'

import { dispatchPlan, reconstructFromSession } from '../src/runtime.js'

const plan = {
  planId: 'wp-replay-errors',
  sessionId: 'session-replay-errors',
  createdTurn: 1,
  createdAt: 1000,
  title: '回放错误数组回归',
  stages: [
    {
      id: 'S1',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
      ],
    },
  ],
}

function makeSession() {
  const events: any[] = []
  return {
    id: plan.sessionId,
    header: { createdAt: 1000 },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function appendPlan(session: any) {
  session.append('user/message', {
    content: [{
      type: 'text',
      text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId: plan.planId, sessionId: plan.sessionId, plan })}\n<!-- DSH-WORKPLAN:END -->`,
    }],
  })
}

function appendResult(session: any, errors: string[]) {
  const payload = {
    kind: 'workplan-result',
    version: 1,
    planId: plan.planId,
    sessionId: plan.sessionId,
    dispatchedAt: 2000,
    phase: 'paused',
    stats: { total: 2, done: 0, blocked: 0, inProgress: 0, pending: 2, progress: 0 },
    statuses: [
      { subtaskId: 'T1', status: 'pending', progress: 0 },
      { subtaskId: 'T2', status: 'pending', progress: 0 },
    ],
    errors,
    resumeCount: 0,
    resumeAvailable: true,
  }
  session.append('user/message', {
    content: [{
      type: 'text',
      text: `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify(payload)}\n<!-- DSH-WORKPLAN-RESULT:END -->`,
    }],
  })
}

function makeCtx(startActivation: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: (spec: any) => startActivation(spec) },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

test('回放记录始终带 errors 数组，并保留结果消息里的失败行', () => {
  const bare = makeSession()
  appendPlan(bare)
  const replayedBare: any = reconstructFromSession(bare)
  assert.ok(replayedBare, '计划消息必须能重建记录')
  assert.ok(Array.isArray(replayedBare.errors), 'errors 必须是数组，不能缺失')

  const withErrors = makeSession()
  appendPlan(withErrors)
  appendResult(withErrors, ['本轮执行预算（20 分钟）已到：已完成 0/2'])
  const replayed: any = reconstructFromSession(withErrors)
  assert.ok(Array.isArray(replayed.errors))
  assert.deepEqual(replayed.errors, ['本轮执行预算（20 分钟）已到：已完成 0/2'])
})

test('回放后的记录再派发：子任务失败只记错，不再炸掉整轮', async () => {
  const session = makeSession()
  appendPlan(session)
  appendResult(session, [])
  const record: any = reconstructFromSession(session)
  assert.ok(record)
  assert.ok(Array.isArray(record.errors))

  const failingChild = () => {
    const error: any = new Error('aborted by test')
    error.code = 'ABORTED'
    return {
      childId: 'child-fail',
      result: Promise.reject(error),
      dispose: async () => {},
    }
  }
  const ctx = makeCtx(() => failingChild())
  const result: any = await dispatchPlan(ctx, record, {
    agent: { session, options: {} },
    signal: new AbortController().signal,
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 5000,
  })

  assert.ok(result, '整轮必须有结果，而不是抛错')
  assert.ok(Array.isArray(record.errors), '这条记录在派发后仍必须有 errors 数组')
  assert.ok(record.errors.length > 0, '子任务失败必须记进 errors')
  assert.match(record.errors.join('\n'), /T1/)
  assert.notEqual(record.phase, 'executing', '失败后不得停在执行中')
})
