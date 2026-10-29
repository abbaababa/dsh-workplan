/*
 * The 1.3.1 real-process run exposed a last path that still looked stuck: the
 * plan-level round budget (20 min) fired while a child was legitimately
 * working, the running child was recorded as “总执行超时”, dependents were
 * blocked, and the dashboard showed “0/N 做好了 · N 卡住了” again.
 *
 * These tests pin the corrected semantics:
 *  - running out of budget is a pause, not a failure: unfinished subtasks stay
 *    `pending`, the plan phase becomes `paused`, and the message says how to
 *    continue;
 *  - the next dispatch simply continues the remaining work (finished work is
 *    not re-run);
 *  - the pause survives replay from the durable result message;
 *  - the planner is told not to hand root-only actions (dispatch, restart) to
 *    sub-agents, and every child prompt repeats that limit.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChildPrompt,
  buildPlannerPrompt,
  buildResultMessage,
  canResumePlan,
  computeStats,
  createStatuses,
  derivePlanSnapshot,
  parseResultMessage,
} from '../src/plan.js'
import { buildRoundResult, createWorkplanRuntime, dispatchPlan, reconstructFromSession } from '../src/runtime.js'

/*
 * A dispatch round's budget timer is unref'd in the runtime on purpose: a
 * shutting-down host must not be held open by it. Node 22, though, cancels a
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

function makePlan(stageCount = 2) {
  const subtasks = []
  for (let index = 1; index <= stageCount; index += 1) {
    subtasks.push({ id: `T${index}`, title: `第${index}步`, department: 'engineering', dependsOn: index === 1 ? [] : [`T${index - 1}`] })
  }
  return {
    planId: 'wp-budget',
    sessionId: 'session-budget',
    createdTurn: 1,
    createdAt: 1000,
    title: '预算暂停回归',
    stages: [{ id: 'S1', subtasks }],
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
    // No `stats` on the record any more: 1.4.3 derives counts at serialisation
    // time, so a fixture carrying a snapshot would hide a regression that
    // reintroduced the cache.
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: false,
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-budget',
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

function quickChild(text = '完成') {
  return {
    childId: 'child-quick',
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
    dispose: async () => {},
  }
}

function makeCtx(startActivation: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: (spec: any) => startActivation(spec) },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

test('计划预算到点是一次暂停：未完成的保持 pending，阶段 paused，文案说明可续跑', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const session = makeSession()
  const ctx = makeCtx(() => hangingChild())
  const result = await dispatchPlan(ctx, record, {
    agent: { session, options: {} },
    signal: new AbortController().signal,
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 400,
  })

  assert.ok(result)
  assert.equal(record.phase, 'paused', 'budget exhaustion must not look like a failure')
  /*
   * Counts are derived from the status list (1.4.3 removed the cached
   * `record.stats`), so the assertions read the same derivation the dashboard
   * and the model-facing result use.
   */
  const paused = derivePlanSnapshot(record.statuses)
  assert.equal(paused.stats.blocked, 0, 'nothing failed: the round simply ended')
  assert.equal(paused.stats.done, 0)
  assert.equal(paused.stats.pending, 2, 'unfinished subtasks stay pending so the next dispatch picks them up')
  assert.equal(paused.stats.inProgress, 0, 'no child may be left marked in progress')
  /*
   * A reset must clear the companions of the aborted attempt, not just flip the
   * status: `{status:'pending', progress:100, childId:'…'}` was exactly the
   * “还没开始 but 100 %” contradiction reported against 1.4.2.
   */
  for (const item of paused.statuses) {
    assert.equal(item.progress, 0, `${item.subtaskId} 重置后进度必须是 0`)
    assert.equal(item.childId, null, `${item.subtaskId} 重置后不得保留 childId`)
    assert.equal(item.startedAt, null, `${item.subtaskId} 重置后不得保留 startedAt`)
  }
  assert.match(String(record.error), /本轮执行预算（\d+ 分钟）已到/)
  assert.match(String(record.error), /续跑/)
  assert.ok(!JSON.stringify(record.statuses).includes('总执行超时'), 'the killed child must not be recorded as a task failure')
})

test('再次派发会接着跑剩余子任务，已完成的不重跑', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const session = makeSession()
  let calls = 0
  const ctx = makeCtx(() => {
    calls += 1
    return hangingChild()
  })
  const options = { agent: { session, options: {} }, signal: new AbortController().signal, idleTimeoutMs: 60000, childTimeoutMs: 60000, totalTimeoutMs: 400 }
  await dispatchPlan(ctx, record, options)
  assert.equal(record.phase, 'paused')

  ctx.subagents.startActivation = () => quickChild('续跑完成')
  await dispatchPlan(ctx, record, { ...options, totalTimeoutMs: 5000 })
  assert.equal(derivePlanSnapshot(record.statuses).stats.done, 2, 'both subtasks finish on the second dispatch')
  /*
   * [1.5.2] 全部子任务完成即终态，不再等结果消息把它「晋升」成 done。
   * 旧断言固化的是 `integrating`，那正是「14/14、100%、正在收尾」的来源：
   * 结果消息写失败或本轮根本不派发时，计划会永远停在收尾态。
   */
  assert.equal(record.phase, 'done', 'all subtasks done is itself the terminal condition')
})

test('paused 阶段能从结果消息回放出来（刷新后不退回“正在做”）', () => {
  const plan = makePlan()
  const resultPayload = {
    kind: 'workplan-result',
    version: 1,
    planId: plan.planId,
    sessionId: 'session-budget',
    dispatchedAt: 5000,
    phase: 'paused',
    stats: { total: 2, done: 0, blocked: 0, inProgress: 0, pending: 2, progress: 0 },
    statuses: [
      { subtaskId: 'T1', status: 'pending', progress: 10, error: '本轮预算用尽，等待续跑' },
      { subtaskId: 'T2', status: 'pending', progress: 0, error: '本轮预算用尽，等待续跑' },
    ],
    errors: ['本轮执行预算（20 分钟）已到：已完成 0/2，其余 2 项保留为未完成，再次派发本计划即可续跑（已完成的不重跑）'],
    resumeCount: 0,
    resumeAvailable: true,
  }
  const session = makeSession()
  session.append('user/message', {
    content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId: plan.planId, sessionId: 'session-budget', plan })}\n<!-- DSH-WORKPLAN:END -->` }],
  })
  session.append('user/message', {
    content: [{ type: 'text', text: `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify(resultPayload)}\n<!-- DSH-WORKPLAN-RESULT:END -->` }],
  })

  const replayed = reconstructFromSession(session)
  assert.ok(replayed, 'the durable messages must reconstruct a plan')
  assert.equal(replayed.phase, 'paused')
  assert.equal(derivePlanSnapshot((replayed as any).statuses).stats.pending, 2)
})

test('规划器被要求：不得把只有主 Agent 能做的动作写进子任务', () => {
  const prompt = buildPlannerPrompt('修复卡住', '/tmp/work', '')
  assert.match(prompt, /没有派发权限/)
  assert.match(prompt, /只有主 Agent 才能执行/)
  assert.match(prompt, /10 分钟内完成/)
})

test('子 Agent 提示明确说明没有派发权限、不能重启服务', () => {
  const plan = makePlan()
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp/work',
  })
  assert.match(prompt, /没有派发权限/)
  assert.match(prompt, /不要等待或空转/)
})

/*
 * The 1.3.2 real-process run exposed two leftovers around the pause path:
 * `resumeAvailable` stayed false (pending work was invisible to canResumePlan,
 * so the card promised nothing could be resumed), and the result payload did
 * not carry `phase`, so a refresh replayed the pause as `executing`.
 */
test('预算暂停后仍算可续跑，且续跑不消耗自动续跑额度', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const session = makeSession()
  const ctx = makeCtx(() => hangingChild())
  const options = { agent: { session, options: {} }, signal: new AbortController().signal, idleTimeoutMs: 60000, childTimeoutMs: 60000, totalTimeoutMs: 400 }
  await dispatchPlan(ctx, record, options)
  assert.equal(record.phase, 'paused')

  const decision = canResumePlan(record, 4)
  assert.equal(decision.resume, true, 'a paused plan with pending work can be dispatched again')
  assert.equal(decision.failed, 2)
  assert.equal(record.resumeCount ?? 0, 0, 'a pause must not be charged against the resume budget')

  ctx.subagents.startActivation = () => quickChild('续跑完成')
  await dispatchPlan(ctx, record, { ...options, totalTimeoutMs: 5000 })
  // [1.5.2] 续跑把最后两项做完后，计划当场就是 done（不再停在 integrating）。
  assert.equal(record.phase, 'done')
  assert.equal(record.resumeCount ?? 0, 0, 'continuing after a pause stays outside the resume budget')
})

test('结果消息自带阶段，刷新后能原样回放暂停', () => {
  const plan = makePlan()
  const session = makeSession()
  session.append('user/message', {
    content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId: plan.planId, sessionId: 'session-budget', plan })}\n<!-- DSH-WORKPLAN:END -->` }],
  })
  const statuses = [
    { subtaskId: 'T1', status: 'pending', progress: 10, error: '本轮预算用尽，等待续跑' },
    { subtaskId: 'T2', status: 'pending', progress: 0, error: '本轮预算用尽，等待续跑' },
  ]
  session.append('user/message', buildResultMessage({
    planId: plan.planId,
    sessionId: 'session-budget',
    dispatchedAt: 5000,
    statuses,
    stats: computeStats(statuses as any),
    errors: ['本轮执行预算（20 分钟）已到：已完成 0/2，其余 2 项保留为未完成，再次派发本计划即可续跑（已完成的不重跑）'],
    phase: 'paused',
    resumeCount: 0,
    resumeAvailable: true,
  }))

  const replayed = reconstructFromSession(session)
  assert.ok(replayed, 'the durable messages must reconstruct a plan')
  assert.equal(replayed!.phase, 'paused', 'the payload phase must survive the round trip')
  assert.equal(replayed!.resumeAvailable, true, 'a paused plan must be advertised as resumable')
})

test('预算到点不把被杀子任务的超时写进失败清单', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const session = makeSession()
  const ctx = makeCtx(() => hangingChild())
  await dispatchPlan(ctx, record, {
    agent: { session, options: {} },
    signal: new AbortController().signal,
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 400,
  })
  const lines = (record.errors ?? []).join('\n')
  assert.equal(/总执行超时/.test(lines), false, 'the round budget is not a subtask failure')
  assert.match(lines, /本轮执行预算（\d+ 分钟）已到/)
})


/*
 * Three gaps the 1.3.3 real-process verification (11 subtasks, 9 done) found
 * and the earlier suite missed.
 */
test('结果消息的构造走 buildRoundResult：阶段必须真的进载荷（变异测试曾放行）', () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  record.phase = 'paused'
  record.statuses = record.statuses.map((item: any) => ({ ...item, error: '本轮预算用尽，等待续跑' }))
  record.errors = ['本轮执行预算（20 分钟）已到：已完成 0/2，其余 2 项保留为未完成，再次派发本计划即可续跑（已完成的不重跑）']

  const message = buildRoundResult(record, 'session-budget', { maxResumes: 4 })
  // The payload lives inside a JSON string, so its quotes arrive escaped.
  const text = JSON.stringify(message).replace(/\\"/g, '"')
  assert.match(text, /"phase":"paused"/, 'the phase must reach the payload, not just the record')
  assert.match(text, /"resumeAvailable":true/, 'a paused plan with pending work is resumable')
  assert.equal(/总执行超时/.test(text), false)
})

test('新计划不继承上一份计划暂停阶段（同会话连续计划）', () => {
  const session = makeSession()
  const first = makePlan()
  session.append('user/message', {
    content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId: first.planId, sessionId: 'session-budget', plan: first })}\n<!-- DSH-WORKPLAN:END -->` }],
  })
  const statuses = [
    { subtaskId: 'T1', status: 'pending', progress: 10, error: '本轮预算用尽，等待续跑' },
    { subtaskId: 'T2', status: 'pending', progress: 0, error: '本轮预算用尽，等待续跑' },
  ]
  session.append('user/message', buildResultMessage({
    planId: first.planId,
    sessionId: 'session-budget',
    dispatchedAt: 5000,
    statuses,
    stats: computeStats(statuses as any),
    errors: ['本轮执行预算（20 分钟）已到'],
    phase: 'paused',
    resumeCount: 0,
    resumeAvailable: true,
  }))

  const second = { ...makePlan(), planId: 'wp-second', title: '第二份计划' }
  session.append('user/message', {
    content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId: second.planId, sessionId: 'session-budget', plan: second })}\n<!-- DSH-WORKPLAN:END -->` }],
  })

  const replayed = reconstructFromSession(session)
  assert.ok(replayed)
  assert.equal(replayed!.planId, 'wp-second')
  assert.equal(replayed!.phase, 'pending', 'a brand-new plan must not inherit the previous pause')
})

test('重启后没有内存记录时，派发会从会话存档重建计划而不是报 NO_PLAN', async () => {
  const plan = makePlan()
  const session = makeSession()
  session.append('user/message', {
    content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId: plan.planId, sessionId: 'session-budget', plan })}\n<!-- DSH-WORKPLAN:END -->` }],
  })
  const ctx = makeCtx(() => quickChild('重启后续跑完成'))
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 60000, maxResumes: 4 })
  const result: any = await runtime.dispatchTool({ session }, { planId: plan.planId }, new AbortController().signal)
  assert.equal(result?.ok, true)
  assert.equal(result?.stats?.done, 2, 'the rebuilt record must run the plan instead of answering NO_PLAN')

  /*
   * The round phase has to survive the whole call site, not just the helper.
   *
   * A mutation test on 1.3.4 replaced `record` with `{ ...record, phase:
   * undefined }` at the call site and all 65 tests stayed green: every test
   * called `buildRoundResult` directly. So assert against what was actually
   * appended to the session — that is the only surface the call site owns.
   */
  let resultPayload: any = null
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const parsed = parseResultMessage(event.data)
    if (parsed?.planId === plan.planId) resultPayload = parsed
  }
  assert.ok(resultPayload, 'a durable result message must be appended')
  /*
   * [1.5.2] 结果消息里的 phase 也必须已经是 done：它是刷新后回放的唯一依据，
   * 曾经这里写的是 integrating，于是同一个会话刷新前后在「正在收尾/已完成」之间翻转。
   */
  assert.equal(resultPayload.phase, 'done', 'the phase must reach the payload through the real call site')
  assert.equal('phase' in resultPayload, true)
})

test('重启后仍能派发重启前暂停的旧计划：重建按 planId 精确取计划', async () => {
  /*
   * Seen in the wild: a plan paused, the host restarted, the next turn
   * generated a new plan, and dispatching the old paused plan answered
   * PLAN_ID_MISMATCH forever because the rebuild only knew the newest plan.
   * The paused work was on disk and unreachable — a stall again.
   */
  const older = { ...makePlan(), planId: 'wp-old', createdAt: 1000 }
  const newer = { ...makePlan(), planId: 'wp-new', createdAt: 5000 }
  const session = makeSession()
  const wrap = (kind: 'plan' | 'result', payload: any) => {
    const tag = kind === 'plan' ? '' : '-RESULT'
    return `<!-- DSH-WORKPLAN${tag}:BEGIN -->\n${JSON.stringify(payload)}\n<!-- DSH-WORKPLAN${tag}:END -->`
  }
  session.append('user/message', {
    content: [{ type: 'text', text: wrap('plan', { kind: 'workplan', version: 1, planId: older.planId, sessionId: 'session-budget', plan: older }) }],
  })
  session.append('user/message', {
    content: [{ type: 'text', text: wrap('result', {
      kind: 'workplan-result',
      version: 1,
      planId: older.planId,
      sessionId: 'session-budget',
      statuses: [{ subtaskId: 'T1', status: 'done', progress: 100 }, { subtaskId: 'T2', status: 'pending', progress: 0 }],
      stats: { total: 2, done: 1, blocked: 0, inProgress: 0, pending: 1, progress: 50 },
      phase: 'paused',
      resumeCount: 0,
      resumeAvailable: true,
      errors: ['本轮执行预算（20 分钟）已到：已完成 1/2'],
    }) }],
  })
  session.append('user/message', {
    content: [{ type: 'text', text: wrap('plan', { kind: 'workplan', version: 1, planId: newer.planId, sessionId: 'session-budget', plan: newer }) }],
  })

  assert.equal(reconstructFromSession(session)?.plan?.planId, 'wp-new', 'default replay still means the newest plan')
  const rebuilt: any = reconstructFromSession(session, 'wp-old')
  assert.equal(rebuilt?.plan?.planId, 'wp-old')
  assert.equal(rebuilt?.statuses?.find((item: any) => item.subtaskId === 'T1')?.status, 'done')

  const ctx = makeCtx(() => quickChild('旧计划续跑完成'))
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 60000, maxResumes: 4 })
  const result: any = await runtime.dispatchTool({ session }, { planId: 'wp-old' }, new AbortController().signal)
  assert.equal(result?.ok, true)
  assert.equal(result?.planId, 'wp-old', 'dispatching the old paused plan must target that plan, not the newest one')
  assert.equal(result?.stats?.done, 2, 'the pending subtask must run and finish')
})

test('内存里是另一份计划时，按 planId 派发旧计划照样重建并继续跑', async () => {
  /*
   * Real restart hit this: memory did not stay empty long enough to matter.
   * The next turn's planner built a fresh plan, so by the time the user asked
   * to resume the paused one, memory held the new plan and dispatch answered
   * “planId 与当前计划不匹配”. A named plan that exists in the session log has
   * to stay dispatchable.
   */
  const older = { ...makePlan(), planId: 'wp-mem-a', createdAt: 1000 }
  const newer = { ...makePlan(), planId: 'wp-mem-b', createdAt: 5000 }
  const session = makeSession()
  const wrap = (kind: 'plan' | 'result', payload: any) => {
    const tag = kind === 'plan' ? '' : '-RESULT'
    return `<!-- DSH-WORKPLAN${tag}:BEGIN -->\n${JSON.stringify(payload)}\n<!-- DSH-WORKPLAN${tag}:END -->`
  }
  session.append('user/message', {
    content: [{ type: 'text', text: wrap('plan', { kind: 'workplan', version: 1, planId: older.planId, sessionId: 'session-budget', plan: older }) }],
  })
  session.append('user/message', {
    content: [{ type: 'text', text: wrap('result', {
      kind: 'workplan-result', version: 1, planId: older.planId, sessionId: 'session-budget',
      statuses: [{ subtaskId: 'T1', status: 'done', progress: 100 }, { subtaskId: 'T2', status: 'pending', progress: 0 }],
      stats: { total: 2, done: 1, blocked: 0, inProgress: 0, pending: 1, progress: 50 },
      phase: 'paused', resumeCount: 0, resumeAvailable: true, errors: ['本轮执行预算（20 分钟）已到：已完成 1/2'],
    }) }],
  })
  session.append('user/message', {
    content: [{ type: 'text', text: wrap('plan', { kind: 'workplan', version: 1, planId: newer.planId, sessionId: 'session-budget', plan: newer }) }],
  })

  const ctx = makeCtx(() => quickChild('派发完成'))
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 60000, maxResumes: 4 })

  const first: any = await runtime.dispatchTool({ session }, { planId: 'wp-mem-b' }, new AbortController().signal)
  assert.equal(first?.planId, 'wp-mem-b', 'the newest plan dispatches first and fills memory')
  assert.equal(first?.stats?.done, 2)

  const olderRun: any = await runtime.dispatchTool({ session }, { planId: 'wp-mem-a' }, new AbortController().signal)
  assert.equal(olderRun?.ok, true)
  assert.equal(olderRun?.planId, 'wp-mem-a', 'memory holding another plan must not lock the old one out')
  assert.equal(olderRun?.stats?.done, 2, 'the old plan must resume and finish its pending subtask')
})
