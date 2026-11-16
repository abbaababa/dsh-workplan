/*
 * [3.0.1] 后台规划与回合收尾的闭环回归。
 *
 * 事故：pre-step 为保住用户正文改为后台规划后，turn-stopping 看到 plan=null
 * 的占位记录便放行；主 Agent 先问“是否认可”并结束，真正的计划随后才迟到。
 * 这里同时钉住等待、快速完成、降级/澄清交回，以及新任务取代旧规划四条路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

const SESSION_ID = 'session-planning-convergence'

function makePlan(planId = 'wp-planning-convergence') {
  return {
    planId,
    sessionId: SESSION_ID,
    createdTurn: 1,
    createdAt: 1000,
    title: '后台规划闭环',
    stages: [{
      id: 'S1',
      name: '验证',
      subtasks: [{ id: 'T1', title: '验证闭环', department: 'qa', dependsOn: [] }],
    }],
  }
}

function makeRecord(plan: any): any {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    dispatchHold: { kind: 'keyword', reason: '等待用户认可', at: plan.createdAt },
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: SESSION_ID,
    header: { createdAt: 1000, cwd: '/tmp' },
    get seq() { return events.length },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeCtx(session: any) {
  return {
    logger: { warn() {} },
    get: () => undefined,
    subagents: { startActivation: async () => { throw new Error('these tests never dispatch') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

function makeRuntime(record: any, session: any) {
  const runtime: any = createWorkplanRuntime(makeCtx(session), { totalTimeoutMs: 60_000 })
  if (!runtime.state.planningInFlight) runtime.state.planningInFlight = new Map()
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

function steerableAgent(session: any) {
  const steered: any[] = []
  return {
    steered,
    agent: { session, steer(message: any) { steered.push(message) } },
  }
}

function textOf(message: any) {
  return String(message?.content?.[0]?.text ?? '')
}

test('规划仍在跑：收尾先等待；held 计划生成后交回主 Agent 一次，随后继续等用户认可', async () => {
  const session = makeSession()
  const placeholder = {
    plan: null, planId: null, phase: 'planning', statuses: [], errors: [], createdTurn: 1,
  }
  const runtime = makeRuntime(placeholder, session)
  const { agent, steered } = steerableAgent(session)
  const completed = makeRecord(makePlan())
  completed.planningCompletionPending = true
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = () => {
      runtime.state.records.set(session.id, completed)
      runtime.state.planningInFlight.delete(session.id)
      resolve()
    }
  })
  runtime.state.planningInFlight.set(session.id, {
    taskText: '原任务', controller: new AbortController(), promise,
  })

  const stopping = runtime.onTurnStopping({ agent, turn: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(steered.length, 0, '规划未结算前不得放行，也不得凭空发普通未完成提醒')

  release()
  await stopping
  assert.equal(steered.length, 1, '规划结果必须被强制交回主 Agent')
  assert.match(textOf(steered[0]), /后台规划结果待处理/)
  assert.match(textOf(steered[0]), /不得再说“计划尚未生成”/)
  assert.equal(completed.planningCompletionPending, false)

  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 1, 'held 计划交回后仍等待用户认可，不进入未完成 steer 死循环')
})

test('等待期间出现接替规划：旧收尾必须退出，不得消费旧结果', async () => {
  const session = makeSession()
  const placeholder = {
    plan: null, planId: null, phase: 'planning', statuses: [], errors: [], createdTurn: 1,
  }
  const runtime = makeRuntime(placeholder, session)
  const { agent, steered } = steerableAgent(session)
  const staleCompleted = makeRecord(makePlan('wp-stale-planning'))
  staleCompleted.planningCompletionPending = true
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = () => {
      runtime.state.records.set(session.id, staleCompleted)
      resolve()
    }
  })
  const oldPlanning = { taskText: '旧任务', controller: new AbortController(), promise }
  runtime.state.planningInFlight.set(session.id, oldPlanning)
  const stopping = runtime.onTurnStopping({ agent, turn: 1 })
  const nextPlanning = {
    taskText: '新任务', controller: new AbortController(), promise: new Promise<void>(() => {}),
  }
  runtime.state.planningInFlight.set(session.id, nextPlanning)
  release()
  await stopping
  assert.equal(steered.length, 0, '旧收尾不得把已被取代的结果重新交回')
  assert.equal(staleCompleted.planningCompletionPending, true)
})

test('规划在收尾前已完成：没有 in-flight 可查时仍必须交回一次', async () => {
  const session = makeSession()
  const completed = makeRecord(makePlan('wp-planning-fast'))
  completed.planningCompletionPending = true
  const runtime = makeRuntime(completed, session)
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 1)
  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 1, '一次性标记必须防止重复 steer')
})

test('后台降级/澄清没有 plan：也不能被旧回放吞掉，必须交回主 Agent 一次', async () => {
  for (const phase of ['degraded', 'clarify']) {
    const session = makeSession()
    const record = {
      plan: null, planId: null, phase, statuses: [], errors: ['fixture'], createdTurn: 1,
      planningCompletionPending: true,
    }
    const runtime = makeRuntime(record, session)
    const { agent, steered } = steerableAgent(session)
    await runtime.onTurnStopping({ agent, turn: 1 })
    assert.equal(steered.length, 1, `${phase} 必须交回`)
    assert.match(textOf(steered[0]), /降级或需要澄清/)
    await runtime.onTurnStopping({ agent, turn: 1 })
    assert.equal(steered.length, 1, `${phase} 交回后允许结束并等待用户`)
  }
})

function userMessage(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

test('同回合后续 step 的新真实任务也能取代旧后台规划，旧任务不得迟到落计划', async () => {
  const session = makeSession()
  const streams: any[] = []
  const ctx: any = makeCtx(session)
  ctx.llm = {
    async resolveModelInfo(provider: string, model: string) {
      return { provider, model, id: model, reasoning: { defaultEffort: 'high', efforts: ['low', 'high', 'max'] } }
    },
    stream(options: any) {
      streams.push(options)
      return {
        [Symbol.asyncIterator]: () => (async function* () {
          await new Promise<void>((_resolve, reject) => {
            if (options.signal.aborted) {
              reject(new DOMException('aborted', 'AbortError'))
              return
            }
            options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
        })(),
      }
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, {
    autoDispatch: false,
    totalTimeoutMs: 60_000,
    plannerTimeoutMs: 5_000,
    plannerIdleTimeoutMs: 5_000,
  })
  const next = async () => ({ kind: 'enter', messages: [] })
  const firstPayload = {
    agent: { session }, turn: 1, step: 1,
    modelSelection: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' },
    messages: [userMessage('m-old', '修复旧状态机的明确缺陷并运行指定回归测试')],
    signal: new AbortController().signal,
  }
  await runtime.onPreStep(firstPayload, next)
  const first = runtime.state.planningInFlight.get(session.id)
  assert.ok(first?.promise, '第一个任务必须登记可等待的后台规划承诺')

  await runtime.onPreStep({
    ...firstPayload,
    turn: 1,
    step: 2,
    messages: [userMessage('m-new', '修复新任务中的指定收尾闸门并验证精确行为')],
    signal: new AbortController().signal,
  }, next)
  const second = runtime.state.planningInFlight.get(session.id)
  assert.ok(second?.promise, '新任务必须启动自己的后台规划')
  assert.notEqual(second, first)
  assert.equal(first.controller.signal.aborted, true, '旧规划必须收到取代中止')

  await first.promise
  assert.equal(runtime.state.planningInFlight.get(session.id), second, '旧 finally 不得删掉新任务登记')
  assert.equal(streams.length, 2)
  assert.equal(streams[0].signal.aborted, true)
  assert.equal(streams[1].signal.aborted, false)

  second.controller.abort()
  await second.promise
  const planMessages = session.events.filter((event: any) => event.type === 'user/message'
    && event.data?.source?.kind === 'workplan-plan')
  assert.equal(planMessages.length, 0, '被中止的两个规划都不得迟到写入计划')
})

test('收尾等待期间 followup 入队：inbox 事件立即中止旧规划并放行新任务', async () => {
  const session = makeSession()
  const ctx: any = makeCtx(session)
  ctx.llm = {
    async resolveModelInfo(provider: string, model: string) {
      return { provider, model, id: model, reasoning: { defaultEffort: 'high', efforts: ['low', 'high', 'max'] } }
    },
    stream(options: any) {
      return {
        [Symbol.asyncIterator]: () => (async function* () {
          await new Promise<void>((_resolve, reject) => {
            if (options.signal.aborted) {
              reject(new DOMException('aborted', 'AbortError'))
              return
            }
            options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
        })(),
      }
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, {
    autoDispatch: false,
    totalTimeoutMs: 60_000,
    plannerTimeoutMs: 5_000,
    plannerIdleTimeoutMs: 5_000,
  })
  const { agent, steered } = steerableAgent(session)
  const next = async () => ({ kind: 'enter', messages: [] })
  const oldText = '修复旧状态机的明确缺陷并运行指定回归测试'
  const firstPayload = {
    agent, turn: 1, step: 1,
    modelSelection: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' },
    messages: [userMessage('m-old', oldText)],
    signal: new AbortController().signal,
  }
  await runtime.onPreStep(firstPayload, next)
  const first = runtime.state.planningInFlight.get(session.id)
  const stopping = runtime.onTurnStopping({ agent, turn: 1 })

  runtime.onInboxInserted({ agent, message: userMessage('m-progress', '进度如何？') })
  runtime.onInboxInserted({ agent, message: userMessage('m-duplicate', oldText) })
  assert.equal(first.controller.signal.aborted, false, '状态问题和同任务重复消息不得误取消')

  runtime.onInboxInserted({
    agent,
    message: userMessage('m-followup', '修复新任务中的指定收尾闸门并验证精确行为'),
  })
  assert.equal(first.superseded, true)
  assert.equal(first.controller.signal.aborted, true, 'followup 入队即取消，不等旧规划自然完成')
  await first.promise
  await stopping
  assert.equal(steered.length, 0, '被取代的旧规划不得再触发结果 steer')

  await runtime.onPreStep({
    ...firstPayload,
    turn: 2,
    messages: [userMessage('m-followup', '修复新任务中的指定收尾闸门并验证精确行为')],
    signal: new AbortController().signal,
  }, next)
  const second = runtime.state.planningInFlight.get(session.id)
  assert.ok(second?.promise, '旧收尾退出后，新 followup 必须能建立自己的规划')
  second.controller.abort()
  await second.promise
})
