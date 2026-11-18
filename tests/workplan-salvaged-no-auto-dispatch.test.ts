/*
 * [3.0.6][复审修复] 规划器抢救出残缺计划（outcome=SALVAGED）时禁止自动派发。
 *
 * 事故形状：maybePlan 的 autoDispatched 条件只读 planMode/approvalHeld/
 * autoDispatch 三个开关，完全不读 planner.outcome——规划器在硬超时前抢
 * 救出一份只过了部分校验的残缺计划，未经用户确认直接 startAutoDispatch，
 * 残缺计划无人复核就整队开跑。修复后契约：
 *  - SALVAGED：绝不调 startAutoDispatch；计划照常展示；record.errors 留痕；
 *    会话里落一条 workplan-salvaged 用户可见通知，提示人工确认后再 dispatch；
 *  - 正常完成（对照）：startAutoDispatch 被调用，通知不带 salvaged 语义。
 *
 * 走完整 onPreStep → maybePlan → runPlanner（假 ctx.llm.stream）集成路径，
 * SALVAGED 剧本照抄 tests/planner-salvage.test.ts：正文流完不给 finish，
 * 由硬超时中止 → salvagePartialPlan 判定完整 → outcome=SALVAGED。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkplanRuntime } from '../src/runtime.js'

/*
 * 与 planner-salvage.test.ts 相同的事件循环锚：规划器计时器不 unref，
 * 测试期间用 1 秒心跳顶住，60 秒后自行放手。
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

/** 设置环境变量跑 fn，无论成败都恢复原状（node:test 同文件顺序执行）。 */
async function withEnv(name: string, value: string | undefined, fn: () => Promise<void>) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

/** 与 tests/planner-salvage.test.ts 的 planFixture 完全一致：能过 validatePlan。 */
function planFixture() {
  return {
    version: 1,
    title: '验证一个需求',
    taskUnderstanding: {
      originalRequest: '请验证这个需求是否可行',
      deliverable: '一份验证报告',
      successCriteria: ['报告给出可复现的证据'],
      constraints: ['不要修改业务代码'],
      knownFacts: ['用户要求验证可行性'],
      unknowns: ['现有测试覆盖率未知'],
      assumptions: ['验证环境可用'],
    },
    contradictions: {
      primary: {
        statement: '验证深度与时间成本之间的矛盾',
        evidence: ['任务要求证据，但时间有限'],
        whyPrimary: '证据不足会导致结论不可信',
      },
      secondary: ['环境差异可能影响结论'],
      transformationConditions: ['如果获得可复现环境，次要矛盾上升'],
    },
    stages: [
      {
        id: 'S1',
        name: '准备',
        goal: '明确验证范围',
        rationale: '先界定范围避免无效工作',
        checkpoint: '范围获得确认',
        subtasks: [{
          id: 'T1',
          title: '梳理验证范围',
          department: 'research',
          role: '需求分析',
          objective: '列出需要验证的假设',
          method: ['阅读需求', '列出假设'],
          inputs: ['用户需求'],
          outputs: ['假设清单'],
          dependsOn: [],
          acceptance: ['每个假设都有验证方法'],
          risk: '假设遗漏',
        }],
      },
      {
        id: 'S2',
        name: '验证',
        goal: '执行验证',
        rationale: '在范围内收集证据',
        checkpoint: '证据可复现',
        subtasks: [{
          id: 'T2',
          title: '执行验证',
          department: 'qa',
          role: '验证工程师',
          objective: '按清单执行并记录证据',
          method: ['执行检查', '记录结果'],
          inputs: ['假设清单'],
          outputs: ['验证报告'],
          dependsOn: ['T1'],
          acceptance: ['报告包含可复现步骤'],
          risk: '环境不稳定',
        }],
      },
    ],
    risks: [{
      risk: '环境不稳定',
      likelihood: 'medium',
      impact: '结果不可复现',
      mitigation: '记录环境版本',
      trigger: '同一检查结果不一致',
    }],
    verification: [{ item: '报告可复现', method: '按报告步骤重跑', evidence: '重跑日志' }],
    practiceLoop: { plan: '列假设', do: '执行检查', check: '核对证据', act: '修正结论' },
  }
}

const planJson = () => JSON.stringify(planFixture())

function maskedAbort() {
  return new Error('DeepSeek Messages request aborted')
}

/** 等 ms 毫秒；期间 signal 被 abort 就立刻以掩码错误结束，模仿真实流。 */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(maskedAbort())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(maskedAbort())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 正文分片吐完；afterText 缺省时悬停在产出行，直到硬超时把流中止。 */
async function* streamText(full: string, signal: AbortSignal, afterText?: (signal: AbortSignal) => AsyncGenerator<any>) {
  const step = Math.max(1, Math.ceil(full.length / 5))
  for (let i = 0; i < full.length; i += step) {
    await waitOrAbort(5, signal)
    yield { type: 'text-delta', text: full.slice(i, i + step) }
  }
  if (afterText) {
    yield* afterText(signal)
    return
  }
  await waitOrAbort(10_000, signal)
}

/** 持续产出空块（保住进度窗口），直到绝对上限把流中止。 */
function untilHardAbort(signal: AbortSignal) {
  return (async function* () {
    while (true) {
      await waitOrAbort(10, signal)
      yield { type: 'text-delta', text: '' }
    }
  })()
}

/** 正常剧本：正文流完 + finish(stop)。 */
async function* streamFullThenFinish(full: string, signal: AbortSignal) {
  const step = Math.max(1, Math.ceil(full.length / 5))
  for (let i = 0; i < full.length; i += step) {
    await waitOrAbort(5, signal)
    yield { type: 'text-delta', text: full.slice(i, i + step) }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function fakeLlmStream(scenario: (signal: AbortSignal) => AsyncGenerator<any>) {
  return {
    llm: {
      stream(options: any) {
        return { [Symbol.asyncIterator]: () => scenario(options.signal) }
      },
    },
  } as any
}

function makeSession(id: string) {
  const events: any[] = [
    // 受保护系统头（首个 system/message）：头已落地，pre-step 窗口内的
    // 通知不再进暂存队列，立即 append（workplan-254 同款约定）。
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 's' }] } } },
  ]
  const header: any = { createdAt: 1000, cwd: '/work' }
  const session: any = {
    id,
    header,
    append(type: string, data: any) {
      events.push({ type, data })
      return { ok: true }
    },
    eventAt: (n: number) => events[n],
  }
  Object.defineProperty(session, 'seq', { get: () => events.length })
  return { session, events }
}

function makeRuntime(ctx: any) {
  const runtime: any = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    cwd: '/work',
    plannerTimeoutMs: 100,
    plannerIdleTimeoutMs: 1_000,
  })
  return runtime
}

function humanPayload(session: any) {
  return {
    agent: { session },
    step: 1,
    turn: 1,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: '把这份说明整理成三段，每段不超过五行。' }],
      source: { kind: 'user' },
    }],
    signal: new AbortController().signal,
    modelSelection: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'high' },
  }
}

/** 后台规划跑完（planningInFlight 清空）再断言。 */
async function waitForPlanningToSettle(runtime: any, sessionId: string, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!runtime.state.planningInFlight?.get(sessionId)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`后台规划未在 ${timeoutMs}ms 内结算`)
}

test('SALVAGED：残缺计划不自动派发，留痕 + 用户可见暂停通知', async () => {
  await withEnv('DSH_WORKPLAN_NOTICES_FILE', join(mkdtempSync(join(tmpdir(), 'dsh-workplan-notices-')), 'notices.jsonl'), async () => {
  await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', async () => {
    const ctx = fakeLlmStream((signal) => streamText(planJson(), signal, (sig) => untilHardAbort(sig)))
    const runtime = makeRuntime(ctx)
    const { session, events } = makeSession('session-salvaged')
    const autoDispatchCalls: any[] = []
    // spy 替换真实现（会真的起子 Agent）：SALVAGED 路径一条都不许进来。
    runtime.state.startAutoDispatch = (...args: any[]) => {
      autoDispatchCalls.push(args)
    }

    await runtime.onPreStep(humanPayload(session), async () => ({ kind: 'enter' }))
    await waitForPlanningToSettle(runtime, session.id)

    assert.equal(autoDispatchCalls.length, 0, 'SALVAGED 计划绝不允许自动派发')
    const record = runtime.state.records.get(session.id)
    assert.ok(record, '计划记录必须已建')
    assert.equal(record.dispatchedAt, null, '派发时间戳必须保持为空')
    assert.equal(record.phase, 'pending', '未派发：phase 保持 pending')
    assert.ok(
      record.errors.some((line: string) =>
        line.includes('规划器只抢救出残缺计划') && line.includes('SALVAGED') && line.includes('workplan_dispatch')),
      'record.errors 必须留下「SALVAGED 暂停自动执行」留痕',
    )
    const notice = events.find(
      (event: any) => event.type === 'user/message' && event.data?.source?.kind === 'workplan-salvaged',
    )
    assert.ok(notice, '必须给用户发 workplan-salvaged 暂停通知')
    const text = JSON.stringify(notice.data.content)
    assert.match(text, /暂停自动派发/, '通知文案必须说明已暂停自动执行')
    assert.match(text, /dsh_workplan_dispatch/, '通知文案必须指路显式派发工具')
  })
  })
})

test('对照：正常完成的计划照常自动派发，且不发 salvaged 通知', async () => {
  await withEnv('DSH_WORKPLAN_NOTICES_FILE', join(mkdtempSync(join(tmpdir(), 'dsh-workplan-notices-')), 'notices.jsonl'), async () => {
  await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', async () => {
    const ctx = fakeLlmStream((signal) => streamFullThenFinish(planJson(), signal))
    const runtime = makeRuntime(ctx)
    const { session, events } = makeSession('session-clean')
    const autoDispatchCalls: any[] = []
    runtime.state.startAutoDispatch = (...args: any[]) => {
      autoDispatchCalls.push(args)
    }

    await runtime.onPreStep(humanPayload(session), async () => ({ kind: 'enter' }))
    await waitForPlanningToSettle(runtime, session.id)

    assert.equal(autoDispatchCalls.length, 1, '正常计划必须照常自动派发（对照组）')
    const record = runtime.state.records.get(session.id)
    assert.ok(record)
    assert.notEqual(record.dispatchedAt, null, '正常计划应已打派发时间戳')
    assert.equal(
      record.errors.filter((line: string) => line.includes('SALVAGED')).length,
      0,
      '正常计划不得有 salvaged 留痕',
    )
    const notice = events.find(
      (event: any) => event.type === 'user/message' && event.data?.source?.kind === 'workplan-salvaged',
    )
    assert.equal(notice, undefined, '正常计划不得发 salvaged 通知')
  })
  })
})
