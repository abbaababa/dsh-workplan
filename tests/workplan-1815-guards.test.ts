/*
 * [1.8.15] Cancel is terminal, default replay is activity-based.
 *
 * Three independent reports measured four defects on 1.8.13/1.8.14 bytes:
 *  - T4e F1/C16: `dispatch` on a cancelled plan answered `ok: true` and really
 *    started department Agents (`activationCalled: true`);
 *  - T4e F2: two cancels during one dispatch appended two cancel messages;
 *  - T3 B4/B5: the default replay returned null on a >2000-event session (the
 *    presentation gate silently saw no plan) and picked the last *defined*
 *    plan instead of the plan with the newest activity;
 *  - T4e F3: a cancelled round's result message still told the model to
 *    dispatch again.
 *
 * These tests pin the fixes for all four, plus the build identity now shipped
 * in the `/dsh-workplan/plans` payload.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCancelMessage,
  buildPlanMessage,
  buildResultMessage,
  createStatuses,
  parseCancelMessage,
} from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'

function makePlan(planId = 'wp-a') {
  return {
    planId,
    sessionId: 'session-1815',
    createdTurn: 1,
    createdAt: 1000,
    title: '1.8.15 取消与回放回归',
    contradictions: { primary: { statement: '取消是终态，回放按最近活动选计划' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
      ],
    }],
  }
}

function makeSession(id = 'session-1815') {
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

function hangingChild() {
  return { childId: 'child-hang', result: new Promise(() => {}), dispose: async () => {} }
}

function makeCtx(session: any, onActivate: () => any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: async () => onActivate() },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: (seq: number) => session.eventAt(seq),
    },
  }
}

function filler(event: any) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '…' }] } } }
}

test('取消之后的 dispatch 必须被拒绝，且不会启动任何部门 Agent', async () => {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan()))
  let activations = 0
  const runtime: any = createWorkplanRuntime(makeCtx(session, () => {
    activations += 1
    return hangingChild()
  }), { version: 'test-version' })

  const cancelled = await runtime.cancelPlan({ session }, { planId: 'wp-a', reason: '用户取消' })
  assert.equal(cancelled.phase, 'cancelled')

  const out = await runtime.dispatchTool({ session }, { planId: 'wp-a', mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, false, 'a cancelled plan must never answer ok:true')
  assert.equal(out.code, 'PLAN_CANCELLED')
  assert.match(String(out.error), /不会再启动任何部门 Agent/)
  assert.equal(activations, 0, 'cancel is the stop signal: no child may start')
})

test('派发途中连续两次取消只写一条取消消息', async () => {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan()))
  const runtime: any = createWorkplanRuntime(makeCtx(session, () => hangingChild()), {
    version: 'test-version',
    totalTimeoutMs: 300,
  })

  const started = await runtime.dispatchTool({ session }, { mode: 'async' }, new AbortController().signal)
  assert.equal(started.running, true)
  const inflight = runtime.state.records.get(session.id).dispatchPromise

  const first = await runtime.cancelPlan({ session }, { reason: '第一次取消' })
  const second = await runtime.cancelPlan({ session }, { reason: '第二次取消' })
  assert.equal(first.cancelRecorded, true)
  assert.equal(second.alreadyCancelled, true, 'the second cancel must be a no-op')

  const cancels = session.events.filter((event: any) => event.type === 'user/message' && parseCancelMessage(event.data))
  assert.equal(cancels.length, 1, 'one cancel, one durable message — even while the dispatch is still settling')
  await inflight.catch(() => undefined)
})

test('默认回放窗口也要够到两千事件之前的旧计划', () => {
  const session = makeSession()
  const planOld = makePlan('wp-old')
  session.append('user/message', buildPlanMessage(planOld))
  for (let index = 0; index < 2105; index += 1) session.events.push(filler(null))
  session.append('user/message', buildResultMessage({
    planId: 'wp-old',
    sessionId: session.id,
    dispatchedAt: 1,
    statuses: createStatuses(planOld),
    stats: { done: 0, total: 2, blocked: 0, pending: 2 },
    phase: 'paused',
    resumeCount: 0,
    resumeAvailable: true,
  }))

  const record = reconstructFromSession(session)
  assert.ok(record, 'the default window must scan back to the last defined plan')
  assert.equal(record.planId, 'wp-old')
  assert.equal(record.statuses.length, 2)
})

test('present 判定按本回合点名的计划，而不是最后定义的计划', () => {
  const session = makeSession()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', buildPlanMessage(makePlan('wp-a')))
  session.append('user/message', buildPlanMessage(makePlan('wp-b')))
  session.append('user/message', buildCancelMessage('wp-b', '用户取消'))
  const runtime: any = createWorkplanRuntime(makeCtx(session, () => hangingChild()), { version: 'test-version' })

  const denial = runtime.presentDenialReason({ session })
  assert.ok(denial, 'an incomplete plan must still deny the delivery')
  assert.match(String(denial), /wp-a/)
  assert.doesNotMatch(String(denial), /wp-b/, 'the cancelled plan defined last must not answer for this turn')
})

test('已取消计划的结果消息不再教继续派发', () => {
  const message: any = buildResultMessage({
    planId: 'wp-a',
    sessionId: 'session-1815',
    dispatchedAt: 1,
    statuses: createStatuses(makePlan('wp-a')),
    stats: { done: 0, total: 2, blocked: 0, pending: 0 },
    phase: 'cancelled',
    resumeCount: 0,
    resumeAvailable: true,
  })
  const text = String(message?.content?.[0]?.text ?? '')
  assert.match(text, /已取消/)
  assert.match(text, /不要再调用 dsh_workplan_dispatch/)
  assert.doesNotMatch(text, /再次调用 dsh_workplan_dispatch 即可继续跑/)
})

test('/dsh-workplan/plans 载荷带版本与运行态身份', () => {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan()))
  const runtime: any = createWorkplanRuntime(makeCtx(session, () => hangingChild()), {
    version: '1.8.15-test',
    build: { pid: 4321, startedAt: Date.now() - 1000, entryPath: '/tmp/host.js', buildHash: 'deadbeefcafe1234' },
  })
  const payload = runtime.plansPayload(undefined)
  assert.equal(payload.version, '1.8.15-test')
  assert.equal(payload.runtime.buildHash, 'deadbeefcafe1234')
  assert.equal(payload.runtime.pid, 4321)
})

test('会话里还有未完成计划时 present 不得放行，即使最后定义的计划已就绪', () => {
  const session = makeSession()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', buildPlanMessage(makePlan('wp-a')))
  const planB = {
    ...makePlan('wp-b'),
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '唯一一步', department: 'engineering', dependsOn: [] }] }],
  }
  session.append('user/message', buildPlanMessage(planB))
  session.append('user/message', buildResultMessage({
    planId: 'wp-b',
    sessionId: session.id,
    dispatchedAt: 1,
    statuses: [{
      subtaskId: 'T1',
      status: 'done',
      progress: 100,
      verification: 'structured',
      acceptance: [{ criterion: '结论可复现', result: 'pass', evidence: 'probe.out' }],
      artifacts: [],
      missingArtifacts: [],
    }],
    stats: { done: 1, total: 1, blocked: 0, pending: 0 },
    phase: 'done',
    resumeCount: 0,
    resumeAvailable: true,
  }))
  const runtime: any = createWorkplanRuntime(makeCtx(session, () => hangingChild()), { version: 'test-version' })

  const denial = runtime.presentDenialReason({ session })
  assert.ok(denial, 'an unfinished plan must block the delivery even when another plan is ready')
  assert.match(String(denial), /wp-a/)
  assert.match(String(denial), /交付就绪检查/)

  session.append('user/message', buildCancelMessage('wp-a', '不再推进'))
  const after = runtime.presentDenialReason({ session })
  assert.ok(after, 'cancel only stops execution; it never makes unfinished work deliverable')
  assert.match(String(after), /已取消/)
})
