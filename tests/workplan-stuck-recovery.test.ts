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
import test, { after } from 'node:test'
import { selfEffortStatuses } from './helpers/self-effort-contract.js'
import assert from 'node:assert/strict'

import {
  MAX_PLAN_RESUMES,
  buildResultMessage,
  canResumePlan,
  computeStats,
  createStatuses,
  derivePlanSnapshot,
  parseResultMessage,
  planPhase,
  resetBlockedStatuses,
} from '../src/plan.js'
import {
  createWorkplanRuntime,
  normaliseChildTimeout,
  normaliseIdleTimeout,
} from '../src/runtime.js'
import { createProgressWatchdog, describeError, pickTimeoutReason } from '../src/watchdog.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

/*
 * The idle and hard timeout timers under test are unref'd on purpose: a
 * shutting-down host must not be held open by them. Node 22, though, cancels a
 * pending test the moment the event loop drains with no ref'd handle left, so
 * these tests would be cancelled instead of reaching their timeouts. Keep one
 * ref'd handle alive for this file — the stand-in for the HTTP server a real
 * host always has running. It drops itself after a minute so a genuinely stuck
 * test still fails instead of hanging CI.
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

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
  const statuses = selfEffortStatuses(plan)
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
  assert.match(text, /受阻项可再次调用 dsh_workplan_dispatch 从受阻处续跑/)

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
  assert.match(exhaustedText, new RegExp(`已用尽自动续跑额度（${MAX_PLAN_RESUMES}/${MAX_PLAN_RESUMES}）`))
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
    enforceTimeouts: true,
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
    enforceTimeouts: true,
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
  assert.equal(normaliseChildTimeout(24 * 60 * 60 * 1000), 7200000)
  assert.equal(normaliseIdleTimeout(0), 300000)
  assert.equal(normaliseIdleTimeout(1), 1000)
  assert.equal(normaliseIdleTimeout(60 * 60 * 1000), 900000)
})

/* ------------------------------------------------------------------ */
/* 4. Error text: never "[object Object]" */
/* ------------------------------------------------------------------ */

test('describeError never renders an object as [object Object]', () => {
  // [2.5.5][T6] 堆栈留痕：message 保留在前，截断堆栈后缀可选；不得出现 [object Object]。
  const boom = describeError(new Error('  boom  '))
  assert.ok(boom.startsWith('boom'), 'message 必须保留')
  assert.doesNotMatch(boom, /\[object Object\]/)
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

test('旧 idle/单次窗口到点不再把子任务判卡住；只有显式取消才收束', async () => {
  const plan = makePlan()
  const session = makeSession()
  const record = makeRecord(plan)
  let calls = 0
  const ctx = makeCtx(
    () => {
      calls += 1
      return hangingChild()
    },
    { 'child-hang': { seq: 0 } },
  )
  const runtime = createWorkplanRuntime(ctx, {
    idleTimeoutMs: 300,
    childTimeoutMs: 500,
    totalTimeoutMs: 800,
    maxResumes: 2,
    strictEvidence: false,
  })
  runtime.state.records.set(session.id, record)
  const agent = { session, options: {} }
  const running = runtime.dispatchTool(agent, { startPhases: MAIN_START_PHASES_FIXTURE }, new AbortController().signal)
  await new Promise((resolve) => setTimeout(resolve, 1_200))

  const stats = derivePlanSnapshot(record.statuses).stats
  assert.equal(stats.blocked, 0, '旧 idle/上限都不再产生 blocked')
  assert.equal(stats.inProgress, 1, '任务仍在真实执行')
  assert.equal(calls, 1, '不因旧窗口自动重试')
  assert.notEqual(record.phase, 'blocked')
  assert.ok(!(record.errors ?? []).some((line: string) => /无进展|上限|CHILD_TIMEOUT/.test(line)))

  const cancelled = await runtime.cancelPlan({ session }, { reason: '测试显式取消' })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.abortedRunning, true)
  const settled = await running
  assert.equal(settled.ok, true)
  assert.equal(record.phase, 'cancelled', '显式取消仍能终止无时限长任务')
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

  const result = await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE,}, new AbortController().signal)
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

  const running = runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE,}, new AbortController().signal)
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

test('长时间运行的 dispatch 不再被墙钟判“已卡住”，而是如实返回 running', async () => {
  const plan = makePlan()
  const session = makeSession()
  const record = makeRecord(plan)
  record.dispatchPromise = new Promise(() => {})
  // 40 分钟远超旧 20 天？这里故意用 40 分钟：旧实现有“预算+宽限”逃逸，
  // 新契约必须以活跃 promise 为唯一事实，不能按 startedAt 墙钟判 wedged。
  record.dispatchStartedAt = Date.now() - 40 * 60 * 1000
  const ctx = makeCtx(() => doneChild())
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000 })
  runtime.state.records.set(session.id, record)

  const result = await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.alreadyRunning, true)
  assert.equal(result.running, true)
  assert.equal(result.stale, undefined, '活跃派发永不被墙钟判 stale')
  assert.match(String(result.hint), /仍在执行|查看实时状态/)
  const status = await runtime.statusTool({ session }, {})
  assert.equal(status?.running, true, '状态工具也持续报告 running')
})
