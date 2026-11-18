/*
 * [3.0.6][第 3 批①] 回合收尾等待上限（turnStoppingMaxWaitMs）。
 *
 * 审计病根：agent/turn-stopping 会无界等待在途规划（最坏 45 分钟）与在途派发
 * （执行无时限 ⇒ 理论无限）。本文件钉住新语义：
 *  1. 交互式：等满上限 ⇒ 不 steer、按「等待预算耗尽」放行但留痕
 *     （releasedIncomplete.reason='wait-exhausted' + 会话 notice），
 *     同一回合不重复发 notice；后台派发承诺不被消费、继续跑。
 *  2. fail-closed（headless）：等满上限 ⇒ 抛 WORKPLAN_WAIT_EXHAUSTED，
 *     穿过日志包装（该回合以 error 收尾）。
 *  3. 上限=0（默认旧行为）/承诺按时结算：行为与旧实现一致。
 *  4. 在途规划等满上限：标记 turnWaitTimedOut，同一规划对象不重复等待。
 *
 * 口径：本上限只约束「收尾闸门的等待」，不构成部门/专家的执行时限。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

function makePlan(planId = 'wp-wait-cap') {
  return {
    planId,
    sessionId: 'session-wait-cap',
    createdTurn: 1,
    createdAt: 1000,
    title: '收尾等待上限回归',
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

function makeRecord(plan: any): any {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'executing',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: true,
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-wait-cap',
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeRuntime(record: any, session: any, opts: any = {}) {
  const ctx: any = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('never dispatched') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  if (opts.headless) {
    ctx.get = (name: string) => (name === 'headlessStartup' ? {} : undefined)
  }
  const runtime: any = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    turnStoppingMaxWaitMs: opts.turnStoppingMaxWaitMs ?? 80,
  })
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

function steerableAgent(session: any) {
  const steered: any[] = []
  return {
    steered,
    agent: {
      session,
      steer(message: any) { steered.push(message) },
    },
  }
}

function exhaustNotices(session: any) {
  return session.events.filter((event: any) => event.type === 'user/message'
    && String(event.data?.source?.summary ?? '').includes('等待预算耗尽放行'))
}

test('交互式：派发在途且等满上限 ⇒ 放行但留痕，不 steer，不消费派发承诺', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session)
  const { agent, steered } = steerableAgent(session)
  let dispatchSettled = false
  record.dispatchPromise = new Promise<void>((resolve) => {
    setTimeout(() => { dispatchSettled = true; resolve() }, 60_000)
  })

  const startedAt = Date.now()
  await runtime.onTurnStopping({ agent, turn: 1 })
  const waitedMs = Date.now() - startedAt
  assert.ok(waitedMs < 5_000, `等待应按上限截断，实际 ${waitedMs}ms`)
  assert.equal(steered.length, 0, '等待预算耗尽不得再 steer（避免又拖住回合）')
  assert.ok(record.turnWaitExhausted, '必须留下耗尽标记')
  assert.equal(record.turnWaitExhausted.reason === undefined, true)
  assert.equal(dispatchSettled, false, '派发承诺不得被消费，后台继续跑')
  assert.equal(record.dispatchPromise !== null, true)
  assert.equal(record.releasedIncomplete?.reason, 'wait-exhausted')
  assert.equal(exhaustNotices(session).length, 1, '放行 notice 恰一条')

  // 同一回合再次收尾：不重复等待、不重复 notice，仍放行。
  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 0)
  assert.equal(exhaustNotices(session).length, 1, '同一回合 notice 不得重复')
})

test('fail-closed（headless）：等满上限 ⇒ 抛 WORKPLAN_WAIT_EXHAUSTED 并穿透日志包装', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session, { headless: true })
  const { agent } = steerableAgent(session)
  record.dispatchPromise = new Promise<void>(() => {})

  await assert.rejects(
    () => runtime.onTurnStopping({ agent, turn: 1 }),
    (error: any) => error?.code === 'WORKPLAN_WAIT_EXHAUSTED'
      && /等待预算耗尽/.test(String(error?.message ?? '')),
  )
})

test('上限=0（旧行为）：无界等待，承诺结算后照常走闸门', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session, { turnStoppingMaxWaitMs: 0 })
  const { agent, steered } = steerableAgent(session)
  record.dispatchPromise = new Promise<void>((resolve) => setTimeout(resolve, 20))

  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(record.turnWaitExhausted ?? null, null, '按时结算不得留耗尽标记')
  assert.equal(steered.length, 1, '结算后未完成仍按旧语义 steer')
})

test('在途规划等满上限：标记 turnWaitTimedOut，同一规划对象只等一次', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session)
  const { agent } = steerableAgent(session)
  const planning: any = { promise: new Promise<void>(() => {}) }
  runtime.state.planningInFlight = new Map([[session.id, planning]])

  const startedAt = Date.now()
  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.ok(Date.now() - startedAt < 5_000, '规划等待应按上限截断')
  assert.equal(planning.turnWaitTimedOut, true, '超时的规划对象必须被标记')
  assert.equal(record.turnWaitExhausted ?? null, null, '规划超时不是派发耗尽')

  // 同一规划对象 + 派发仍在跑：不再等规划，直接走派发上限逻辑。
  record.dispatchPromise = new Promise<void>(() => {})
  const again = Date.now()
  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.ok(Date.now() - again < 5_000)
})

/*
 * [3.0.6][第 3 批①] 复审修复：turnWaitExhausted / waitExhaustedNotifiedTurn 永不复位。
 * 旧标记一旦留在 record 上，auto-resume/continue/重派复用同一 record 时，
 * 下一回合被「已耗尽」零预算秒放行，且 notice 只按 turn 去重导致每回合误发。
 * 三处 `record.dispatchPromise = dispatchPlan(...)` 赋值前都必须清零两标志。
 */
test('复审修复：再次派发（复用原 record）必须清零等待耗尽两标志', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-redispatch'))
  const runtime = makeRuntime(record, session)
  const { agent } = steerableAgent(session)
  // 上一回合派发等待超时留下的陈旧标记（与 onTurnStopping 写下的形状一致）。
  record.turnWaitExhausted = { turn: 1, at: Date.now(), waitedMs: 80 }
  record.waitExhaustedNotifiedTurn = 1

  runtime.state.startAutoDispatch(record, session, agent)

  assert.ok(record.dispatchPromise, '必须真的走上派发赋值路径')
  assert.equal(record.turnWaitExhausted ?? null, null,
    '再派发必须清零 turnWaitExhausted，否则下一回合被零预算秒放行')
  assert.equal(record.waitExhaustedNotifiedTurn ?? null, null,
    '再派发必须清零 waitExhaustedNotifiedTurn，否则每回合误发 ⏳ 上限通知')
  runtime.dispose?.()
})
