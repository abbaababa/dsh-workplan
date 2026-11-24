/*
 * [3.2.3][省钱 W3] 上一轮计划已生成但未派发时，只要任务锚点未变就复用原计划，
 * 不再白烧一次 runPlanner。任一过期信号（任务文本/消息 id 改变、plan 模式、
 * 审批hold、SALVAGED、replan 拆过的依赖、兼容开关）都退回旧的取消+重规划。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkplanRuntime } from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
after(() => { clearInterval(eventLoopAnchor) })

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

function planFixture() {
  return {
    version: 1,
    title: '省钱回归',
    taskUnderstanding: {
      deliverable: '一份结论',
      successCriteria: ['可复核'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '质量与成本', evidence: ['证据'], whyPrimary: '决定交付' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '完成',
      rationale: '需要',
      checkpoint: '复核',
      subtasks: [{
        id: 'T1',
        title: '单项工作',
        department: 'engineering',
        departmentRationale: '命中工程职责',
        role: '专家',
        objective: '完成单项工作',
        method: ['读取', '执行'],
        inputs: [],
        outputs: ['out.md'],
        dependsOn: [],
        qualityRequirements: ['有证据'],
        acceptance: ['可复核'],
        risk: '低',
        estimateMinutes: 10,
        reasoningEffort: 'medium',
      }],
    }],
    risks: [],
    verification: [{ item: '复核', method: '抽查', evidence: '命令输出' }],
    practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
  }
}

function fakeCtx(text: string, counter: { calls: number }) {
  return {
    llm: {
      stream() {
        counter.calls += 1
        return (async function* () {
          for (let i = 0; i < text.length; i += Math.max(1, Math.ceil(text.length / 4))) {
            yield { type: 'text-delta', text: text.slice(i, i + Math.max(1, Math.ceil(text.length / 4))) }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  } as any
}

function makeSession(id: string) {
  const events: any[] = [{
    type: 'system/message',
    data: { message: { role: 'system', content: [{ type: 'text', text: 's' }] } },
  }]
  const session: any = {
    id,
    header: { createdAt: 1000, cwd: '/work' },
    append(type: string, data: any) {
      events.push({ type, data })
      return { ok: true }
    },
    eventAt: (n: number) => events[n],
  }
  Object.defineProperty(session, 'seq', { get: () => events.length })
  return { session, events }
}

function payload(session: any, turn: number, id: string, text: string) {
  return {
    agent: { session },
    step: 1,
    turn,
    messages: [{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    signal: new AbortController().signal,
    modelSelection: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'high' },
  }
}

async function settle(runtime: any, sessionId: string) {
  for (let i = 0; i < 400; i += 1) {
    if (!runtime.state.planningInFlight?.get(sessionId)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('后台规划未结算')
}

async function scenario(opts: {
  turn2Id?: string
  turn2Text?: string
  envSwitch?: string
  autoDispatch?: boolean
} = {}) {
  return withEnv('DSH_WORKPLAN_NOTICES_FILE', join(mkdtempSync(join(tmpdir(), 'wp-reuse-')), 'notices.jsonl'), async () => {
    const counter = { calls: 0 }
    const runtime: any = createWorkplanRuntime(fakeCtx(JSON.stringify(planFixture()), counter), {
      cwd: '/work',
      plannerTimeoutMs: 5_000,
      autoDispatch: opts.autoDispatch,
    })
    const { session, events } = makeSession('session-reuse')
    const dispatched: any[] = []
    runtime.state.startAutoDispatch = (...args: any[]) => { dispatched.push(args) }

    const text = '请验证这个需求是否可行'
    await runtime.onPreStep(payload(session, 1, 'm1', text), async () => ({ kind: 'enter' }))
    await settle(runtime, session.id)
    assert.equal(counter.calls, 1, '第一轮应只规划一次')
    assert.equal(dispatched.length, opts.autoDispatch === false ? 0 : 1)
    // 模拟「计划已生成但派发没落地」：真实事故里 startAutoDispatch 可能失败/被拦，
    // 此时记录仍带 dispatchedAt 占位。清掉占位才能进入 W3 的复用分支。
    if (opts.autoDispatch !== false) {
      const record = runtime.state.records.get(session.id)
      if (record) {
        record.dispatchedAt = null
        record.dispatchPromise = null
      }
    }
    const oldRecord = runtime.state.records.get(session.id)

    await withEnv('DSH_WORKPLAN_REUSE_UNSENT_PLAN', opts.envSwitch, async () => {
      await runtime.onPreStep(payload(
        session,
        2,
        opts.turn2Id ?? 'm1',
        opts.turn2Text ?? text,
      ), async () => ({ kind: 'enter' }))
      await settle(runtime, session.id)
    })
    return { runtime, session, events, counter, dispatched, oldRecord }
  })
}

test('[3.2.3][W3] 任务未变：复用原计划，不重复调用规划器', async () => {
  const { runtime, session, counter, dispatched } = await scenario()
  assert.equal(counter.calls, 1, '第二轮不得再调用规划器')
  assert.equal(dispatched.length, 2, '复用后应自动派发')
  const record = runtime.state.records.get(session.id)
  assert.notEqual(record.phase, 'cancelled', '计划不应被取消')
  assert.ok(!record.errors.some((line: string) => line.includes('上一轮未派发')))
  assert.ok(typeof record.dispatchedAt === 'number')
})

test('[3.2.3][W3] 任务文本改变：退回取消 + 重规划', async () => {
  const { events, counter, oldRecord } = await scenario({ turn2Text: '这是一个全新的任务' })
  assert.ok(counter.calls >= 2, '任务变了必须重新规划')
  assert.equal(oldRecord?.phase, 'cancelled', '旧计划必须按 1.9.2 语义取消')
  assert.ok(oldRecord?.errors.some((line: string) => line.includes('上一轮未派发')))
  assert.equal(events.filter((e: any) => e.data?.source?.kind === 'workplan-reuse-dispatch').length, 0, '不得复用')
})

test('[3.2.3][W3] 新消息 id（文本相同）：退回取消 + 重规划', async () => {
  const { counter, oldRecord } = await scenario({ turn2Id: 'm2' })
  assert.ok(counter.calls >= 2, '用户新消息意味着意图可能变化，必须重规划')
  assert.equal(oldRecord?.phase, 'cancelled')
  assert.ok(oldRecord?.errors.some((line: string) => line.includes('上一轮未派发')))
})

test('[3.2.3][W3] 兼容开关 DSH_WORKPLAN_REUSE_UNSENT_PLAN=0 恢复旧行为', async () => {
  const { counter, oldRecord } = await scenario({ envSwitch: '0' })
  assert.ok(counter.calls >= 2)
  assert.equal(oldRecord?.phase, 'cancelled')
  assert.ok(oldRecord?.errors.some((line: string) => line.includes('上一轮未派发')))
})

test('[3.2.3][W3] plan-first 模式复用计划但不替模型派发，保留 startPhases 闸', async () => {
  const { runtime, session, events, counter, dispatched } = await scenario({ autoDispatch: false })
  assert.equal(counter.calls, 1, 'plan-first 也要省掉重复规划')
  assert.equal(dispatched.length, 0, 'plan-first 不得自动派发')
  const notice = events.find((event: any) => event.data?.source?.kind === 'workplan-reuse-dispatch')
  assert.ok(notice, '应提示模型沿用原计划并派发')
  assert.match(JSON.stringify(notice.data.content), /dsh_workplan_dispatch/)
  assert.match(JSON.stringify(notice.data.content), /startPhases/)
  assert.notEqual(runtime.state.records.get(session.id).phase, 'cancelled')
})
