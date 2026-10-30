/*
 * [1.7.0] Dispatch modes and the read-only status probe.
 *
 * The top-ranked break in the 1.6.0 review was "the main Agent is blind while
 * dispatching": `dispatchPlan` was awaited inside the tool call, so for up to
 * twenty minutes the model could neither answer the user nor report progress.
 * These tests pin the two supported modes and the snapshot each returns:
 *  - `async` returns within a second with `running: true` and live statuses;
 *  - a `wait` call that meets an in-flight round joins it and returns the real
 *    results instead of a content-free `alreadyRunning: true`;
 *  - `dsh_workplan_status` reconstructs from the session log after a restart
 *    and never claims completion for work that is still running.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, parseResultMessage } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlan() {
  return {
    planId: 'wp-modes',
    sessionId: 'session-modes',
    createdTurn: 1,
    createdAt: 1000,
    title: '派发模式回归',
    taskUnderstanding: { originalRequest: '回归验证协作通道', deliverable: '通过验收' },
    contradictions: { primary: { statement: '主 Agent 与子 Agent 必须共享同一份状态' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '实现协作通道',
        department: 'engineering',
        objective: '实现通道',
        acceptance: ['通道可用'],
        outputs: ['代码'],
        risk: 'low',
        dependsOn: [],
      }],
    }],
  }
}

function makeSession(id = 'session-modes') {
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
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function completed(text = '完成') {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

function makeRuntime(child: Promise<any>, session = makeSession()) {
  session.append('user/message', buildPlanMessage(makePlan()))
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => ({ childId: 'child-modes', result: child, dispose: async () => {} }),
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    maxResumes: 4,
  })
  return { session, runtime, ctx }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('async 派发在 1s 内返回 running，结果稍后以结果消息落盘', async () => {
  const gate = deferred()
  const { session, runtime } = makeRuntime(gate.promise)
  const started = Date.now()
  const out: any = await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)

  assert.equal(out.ok, true)
  assert.equal(out.mode, 'async')
  assert.equal(out.running, true, 'async 返回的是“已开跑”，不是“已完成”')
  assert.equal(out.stats.total, 1)
  assert.equal(out.statuses[0].status, 'in_progress')
  assert.ok(Date.now() - started < 1_000, 'async 不得阻塞到本轮结束')
  assert.match(String(out.hint), /不要声称完成/)

  // While it runs, the probe must show work in flight and never claim done.
  const live: any = await runtime.statusTool({ session }, {})
  assert.equal(live.running, true)
  assert.equal(live.stats.done, 0)
  assert.equal(live.statuses[0].status, 'in_progress')

  // A second async dispatch is idempotent but still informative.
  const again: any = await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.equal(again.alreadyRunning, true)
  assert.equal(again.running, true)
  assert.equal(again.statuses[0].status, 'in_progress')

  gate.release(completed('完成'))
  assert.ok(await waitFor(() => session.events.some(
    (event) => event.type === 'user/message' && parseResultMessage(event.data),
  )), 'async 轮结束时必须写入 durable 结果消息')

  const settled: any = await runtime.statusTool({ session }, {})
  assert.equal(settled.running, false)
  assert.equal(settled.stats.done, 1)
  assert.equal(settled.statuses[0].status, 'done')

  const resultMessages = session.events
    .filter((event) => event.type === 'user/message' && parseResultMessage(event.data))
    .map((event) => parseResultMessage(event.data))
  assert.equal(resultMessages.length, 1, '结果消息只写一次')
  assert.equal(resultMessages[0].planId, 'wp-modes')
})

test('运行中的 wait 派发会 join 并返回完整结果，而不是空的 alreadyRunning', async () => {
  const gate = deferred()
  const { session, runtime } = makeRuntime(gate.promise)
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)

  const joinedPromise = runtime.dispatchTool({ session, options: {} }, {}, new AbortController().signal)
  gate.release(completed('完成'))
  const joined: any = await joinedPromise

  assert.equal(joined.ok, true)
  assert.equal(joined.joined, true, '第二次 wait 必须加入进行中的派发')
  assert.equal(joined.alreadyRunning, false)
  assert.equal(joined.stats.done, 1)
  assert.equal(joined.statuses[0].status, 'done')
})

test('没有计划时 status 工具如实返回 NO_PLAN，不编造进度', async () => {
  const session = makeSession('session-empty')
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => ({ childId: 'x', result: Promise.resolve(completed()), dispose: async () => {} }) },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000 })
  const out: any = await runtime.statusTool({ session }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NO_PLAN')
  assert.equal(out.running, false)
})

test('重启后 status 工具可以从会话记录重建计划并读到完成项', async () => {
  const session = makeSession('session-restart')
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => ({ childId: 'child-restart', result: Promise.resolve(completed('完成')), dispose: async () => {} }),
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const first = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000 })
  session.append('user/message', buildPlanMessage(makePlan()))
  const out: any = await first.dispatchTool({ session, options: {} }, {}, new AbortController().signal)
  assert.equal(out.stats.done, 1)

  // A fresh runtime has no in-memory record: the session log must be enough.
  const second = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000 })
  const rebuilt: any = await second.statusTool({ session }, {})
  assert.equal(rebuilt.ok, true)
  assert.equal(rebuilt.planId, 'wp-modes')
  assert.equal(rebuilt.stats.done, 1)
  assert.equal(rebuilt.running, false)
})
