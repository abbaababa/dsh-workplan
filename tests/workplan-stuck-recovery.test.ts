/*
 * Regression cover for every "the plan got stuck" path found in the 1.2.1
 * audit. Each test fails against 1.2.1 in the way the audit described, so the
 * suite is the executable version of the diagnosis:
 *
 *  - a child that stalls was killed at a fixed 300 s wall clock and every
 *    dependent was blocked with it (no plan could recover);
 *  - re-dispatching a blocked plan answered `ok: true` while running nothing;
 *  - cancelling a running plan threw `PLAN_RUNNING`, so a wedged dispatch could
 *    not be stopped at all;
 *  - `[object Object]` replaced the real failure text in user-visible errors.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_PLAN_RESUMES,
  buildResultMessage,
  canResumePlan,
  computeStats,
  createStatuses,
  derivePlanSnapshot,
  planPhase,
  resetBlockedStatuses,
} from '../src/plan.js'
import {
  createWorkplanRuntime,
  normaliseChildTimeout,
  normaliseIdleTimeout,
} from '../src/runtime.js'
import { createProgressWatchdog, describeError, pickTimeoutReason } from '../src/watchdog.js'

function messageTextOf(message: any) {
  return (message?.content ?? [])
    .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n')
}

function makePlan() {
  return {
    planId: 'wp-stuck',
    sessionId: 'session-stuck',
    createdTurn: 1,
    createdAt: 1000,
    title: '卡住回归',
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
}

function makeRecord(plan: any): any {
  const statuses = createStatuses(plan)
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses,
    stats: computeStats(statuses),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: false,
  }
}

function makeSession(id = 'session-stuck') {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000 },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt(seq: number) {
      return events[seq]
    },
    events,
  }
}

function makeCtx(impl: any, childSeqs: any = {}) {
  return {
    logger: { warn() {} },
    subagents: {
      startActivation: (spec: any) => impl(spec),
    },
    sessions: {
      get: (id: any) => childSeqs[id] ?? undefined,
      list: () => [],
      eventAt: () => undefined,
    },
  }
}

function doneChild(text = '子任务完成') {
  return {
    childId: 'child-1',
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
    dispose: async () => {},
  }
}

function hangingChild() {
  return {
    childId: 'child-hang',
    result: new Promise(() => {}),
    dispose: async () => {},
  }
}

/* ------------------------------------------------------------------ */
/* 1. Resume bookkeeping: a blocked plan is recoverable, a cancelled one is not */
/* ------------------------------------------------------------------ */

test('canResumePlan allows a blocked plan, refuses cancelled and exhausted ones', () => {
  const statuses = createStatuses(makePlan()).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'blocked',
    error: index === 0 ? null : '上游子任务受阻：T1',
  }))

  const allowed = canResumePlan({ phase: 'blocked', statuses, resumeCount: 0 })
  assert.equal(allowed.resume, true)
  assert.equal(allowed.failed, 1)
  assert.equal(allowed.remaining, MAX_PLAN_RESUMES)

  const cancelled = canResumePlan({ phase: 'cancelled', statuses, resumeCount: 0 })
  assert.equal(cancelled.resume, false, 'a user cancel must never resume on its own')

  const exhausted = canResumePlan({ phase: 'blocked', statuses, resumeCount: MAX_PLAN_RESUMES })
  assert.equal(exhausted.resume, false)
  assert.match(exhausted.reason, /续跑次数已用尽/)

  const healthy = canResumePlan({ phase: 'done', statuses: createStatuses(makePlan()), resumeCount: 0 })
  assert.equal(healthy.resume, false)
})

test('resetBlockedStatuses keeps done work and re-queues only failed attempts', () => {
  const plan = makePlan()
  const statuses = createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'blocked',
    progress: 100,
    error: index === 0 ? null : '上游子任务受阻：T1',
    childId: 'child-x',
    startedAt: 1234,
    finishedAt: 5678,
  }))
  const reset = resetBlockedStatuses(statuses)
  assert.equal(reset[0].status, 'done', 'finished subtasks must not be re-run')
  assert.equal(reset[0].summary, statuses[0].summary)
  assert.equal(reset[1].status, 'pending')
  assert.equal(reset[1].error, null)
  assert.equal(reset[1].childId, null)
  assert.equal(reset[1].startedAt, null)
  assert.equal(reset[1].finishedAt, null)
  assert.equal(reset[1].progress, 0)
  // T1 is still done, so the plan is no longer blocked; the reset only re-queues
  // the failed part, which is what makes a resume incremental.
  assert.equal(planPhase(reset), 'executing')
})

/* ------------------------------------------------------------------ */
/* 2. The model-visible result message must say whether a retry is possible */
/* ------------------------------------------------------------------ */

test('result message tells the model how to recover a blocked plan', () => {
  const plan = makePlan()
  const statuses = createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'blocked',
  }))
  const message = buildResultMessage({
    planId: plan.planId,
    sessionId: plan.sessionId,
    dispatchedAt: 2000,
    statuses,
    stats: computeStats(statuses),
    resumeCount: 0,
    resumeAvailable: true,
  })
  const text = messageTextOf(message)
  assert.match(text, /再次调用 dsh_workplan_dispatch/)
  assert.match(text, new RegExp(`剩余续跑额度 ${MAX_PLAN_RESUMES} 次`))
  assert.match(text, /"resumeAvailable":true/)

  const exhausted = buildResultMessage({
    planId: plan.planId,
    sessionId: plan.sessionId,
    dispatchedAt: 2000,
    statuses,
    stats: computeStats(statuses),
    resumeCount: MAX_PLAN_RESUMES,
    resumeAvailable: false,
  })
  const exhaustedText = messageTextOf(exhausted)
  assert.match(exhaustedText, /不会再自动重跑/)
  assert.match(exhaustedText, /直接接手完成/)
  assert.match(exhaustedText, new RegExp(`"resumeCount":${MAX_PLAN_RESUMES}`))
})

/* ------------------------------------------------------------------ */
/* 3. Timeout classification: no progress vs absolute ceiling */
/* ------------------------------------------------------------------ */

test('pickTimeoutReason distinguishes idle stall from hard ceiling', () => {
  const base = { idleMs: 1000, hardMs: 10000, progressObservable: true }
  assert.equal(pickTimeoutReason({ ...base, now: 500, startedAt: 0, lastProgressAt: 0 }), null)
  assert.equal(pickTimeoutReason({ ...base, now: 2000, startedAt: 0, lastProgressAt: 1500 }), null)
  assert.equal(pickTimeoutReason({ ...base, now: 2000, startedAt: 0, lastProgressAt: 0 }), 'stalled')
  assert.equal(pickTimeoutReason({ ...base, now: 11000, startedAt: 0, lastProgressAt: 10000 }), 'exhausted')
})

test('watchdog fires when the child log stops growing and stays quiet when it grows', async () => {
  let seq = 0
  let heartbeat = 0
  const quiet = createProgressWatchdog({
    getSeq: () => seq,
    idleMs: 120,
    hardMs: 5000,
    pollMs: 20,
    onProgress: () => {
      heartbeat += 1
    },
    makeError: (reason: any) => new Error(reason),
  })
  await assert.rejects(quiet.fired, /stalled/)
  quiet.stop()

  let grownSeq = 0
  let grew = 0
  const alive = createProgressWatchdog({
    getSeq: () => {
      grownSeq += 1
      return grownSeq
    },
    idleMs: 120,
    hardMs: 5000,
    pollMs: 20,
    onProgress: () => {
      grew += 1
    },
    makeError: (reason: any) => new Error(reason),
  })
  const outcome = await Promise.race([
    alive.fired.then(() => 'fired', () => 'fired'),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('alive'), 400)
      timer.unref?.()
    }),
  ])
  alive.stop()
  assert.equal(outcome, 'alive')
  assert.ok(grew > 0, 'growth must be reported as progress')
  assert.equal(heartbeat, 0)
})

test('timeouts are clamped so a bad config cannot disable or explode them', () => {
  assert.equal(normaliseChildTimeout(0), 900000)
  assert.equal(normaliseChildTimeout(1), 1000)
  assert.equal(normaliseChildTimeout(60 * 60 * 1000), 1800000)
  assert.equal(normaliseIdleTimeout(0), 300000)
  assert.equal(normaliseIdleTimeout(1), 1000)
  assert.equal(normaliseIdleTimeout(60 * 60 * 1000), 900000)
})

/* ------------------------------------------------------------------ */
/* 4. Error text: never "[object Object]" */
/* ------------------------------------------------------------------ */

test('describeError never renders an object as [object Object]', () => {
  assert.equal(describeError(new Error('  boom  ')), 'boom')
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError({ message: 'nested message' }), 'nested message')
  assert.match(describeError({ code: 'CHILD_TIMEOUT' }), /CHILD_TIMEOUT/)
  const envelope = describeError({ message: { content: [{ type: 'text', text: 'envelope text' }] } })
  assert.match(envelope, /envelope text/)
  assert.doesNotMatch(envelope, /\[object Object\]/)
  assert.doesNotMatch(describeError(undefined), /object Object/)
})

/* ------------------------------------------------------------------ */
/* 5. End-to-end: dispatch, stall, resume, cancel */
/* ------------------------------------------------------------------ */

test('a stalled child blocks only itself, then a re-dispatch resumes the plan', async () => {
  const plan = makePlan()
  const session = makeSession()
  const record = makeRecord(plan)
  let calls = 0
  const ctx = makeCtx(
    () => {
      calls += 1
      return hangingChild()
    },
    // A frozen session log is what "wedged" looks like from the outside.
    { 'child-hang': { seq: 0 } },
  )
  const runtime = createWorkplanRuntime(ctx, {
    // Idle window strictly inside the ceiling, so the stall path (and its single
    // retry) is what is exercised, not the absolute ceiling.
    idleTimeoutMs: 500,
    childTimeoutMs: 5000,
    totalTimeoutMs: 20000,
    maxResumes: 2,
  })
  runtime.state.records.set(session.id, record)
  const agent = { session, options: {} }

  const blocked = await runtime.dispatchTool(agent, {}, new AbortController().signal)
  assert.equal(blocked.ok, true)
  const blockedStats = derivePlanSnapshot(record.statuses).stats
  assert.equal(blockedStats.blocked, 2, 'T1 stalls and its dependent T2 must be blocked with it')
  assert.equal(blockedStats.done, 0)
  assert.equal(record.phase, 'blocked')
  assert.ok(record.errors.some((line: string) => /无进展|上限/.test(line)), 'the failure must be described in words')
  assert.ok(calls >= 2, 'a stalled child is retried once before being blocked')
  assert.ok(!JSON.stringify(record.errors).includes('[object Object]'))

  // Second dispatch must actually run again instead of silently doing nothing.
  const resumed = await (async () => {
    ctx.subagents.startActivation = () => doneChild('续跑完成')
    return runtime.dispatchTool(agent, {}, new AbortController().signal)
  })()
  assert.equal(resumed.ok, true)
  assert.equal(derivePlanSnapshot(record.statuses).stats.done, 2)
  assert.equal(record.phase, 'done')
  assert.equal(record.resumeCount, 1)
  assert.ok(record.errors.some((line: string) => /第 1 次续跑/.test(line)))
  assert.equal(session.events.length, 2, 'each dispatch writes one durable result message')
})

test('re-dispatching a blocked plan with no resume budget left fails loudly', async () => {
  const plan = makePlan()
  const session = makeSession()
  const record = makeRecord(plan)
  record.phase = 'blocked'
  record.resumeCount = MAX_PLAN_RESUMES
  record.statuses = record.statuses.map((item: any) => ({ ...item, status: 'blocked', error: '失败' }))
  const ctx = makeCtx(() => doneChild())
  const runtime = createWorkplanRuntime(ctx)
  runtime.state.records.set(session.id, record)

  const result = await runtime.dispatchTool({ session, options: {} }, {}, new AbortController().signal)
  assert.equal(result.ok, false)
  assert.match(String(result.error), /续跑次数已用尽/)
  assert.match(String(result.hint), /直接完成/)
  assert.equal(record.resumeCount, MAX_PLAN_RESUMES, 'a refused dispatch must not consume budget')
})

test('cancel stops a running dispatch instead of being refused', async () => {
  const plan = makePlan()
  const session = makeSession()
  const record = makeRecord(plan)
  const ctx = makeCtx(() => hangingChild(), { 'child-hang': { seq: 0 } })
  const runtime = createWorkplanRuntime(ctx, {
    idleTimeoutMs: 30000,
    childTimeoutMs: 30000,
    totalTimeoutMs: 60000,
  })
  runtime.state.records.set(session.id, record)

  const running = runtime.dispatchTool({ session, options: {} }, {}, new AbortController().signal)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(record.dispatchPromise, 'the dispatch should still be in flight')

  const cancelled = await runtime.cancelPlan({ session }, { reason: '测试取消' })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.abortedRunning, true)

  const settled = await running
  assert.equal(settled.ok, true)
  assert.equal(record.phase, 'cancelled')
  assert.ok(record.errors.some((line: string) => /第 2 次续跑|已取消|取消/.test(line)) || record.phase === 'cancelled')
})

test('a dispatch promise that never settles cannot answer "already running" forever', async () => {
  const plan = makePlan()
  const session = makeSession()
  const record = makeRecord(plan)
  record.dispatchPromise = new Promise(() => {})
  record.dispatchStartedAt = Date.now() - 30 * 60 * 1000
  const ctx = makeCtx(() => doneChild())
  const runtime = createWorkplanRuntime(ctx)
  runtime.state.records.set(session.id, record)

  const result = await runtime.dispatchTool({ session, options: {} }, {}, new AbortController().signal)
  assert.equal(result.ok, false)
  assert.equal(result.stale, true)
  assert.match(String(result.error), /判定为已卡住/)
  assert.match(String(result.hint), /直接接手/)
})
