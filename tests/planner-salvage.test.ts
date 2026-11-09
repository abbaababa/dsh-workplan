/*
 * [2.1.7] 「定时器中止 ≠ 产出作废」与两个可选旋钮的回归用例。
 *
 * 事故（2026-11-07，会话日志实测 4 次）：模型 mimo-v2.6-flash 流式产出 900.0 秒、
 * 11694 个输出块、提示词 5102 字，撞绝对上限 PLANNER_TIMEOUT_HARD 后被整体丢弃——
 * 旧实现里正文是 collectStream 的局部变量，abort 一到就连同 900 秒的产出一起蒸发，
 * 遥测 textChars 恒为 0，事后连「到底写没写完」都无从复盘。
 *
 * 这里用假 ctx.llm.stream 跑完整 runPlanner（纯函数永远测不到「定时器 ↔ 流 ↔
 * 抢救」的协作）：
 *  1) 绝对上限中止时正文已写完 → 抢救成功（SALVAGED），计划照常返回；
 *  2) 正文被拦腰截断 → 不抢救（宁可降级也不交残缺计划），但遥测必须留下输出字数；
 *  3) 缺 finish 信号但正文完整 → 抢救成功；
 *  4) 抢救不绕过上下文闸：strict 下任务不符 → 仍按原判定中止；
 *  5) DSH_WORKPLAN_PLANNER_MAX_TOKENS / DSH_WORKPLAN_PLANNER_REASONING_EFFORT
 *     两个旋钮透传给模型调用；REASONING_EFFORT 不设时规划器取默认 max，
 *     不再继承主 Agent 的档位（用户 2026-11-08 决策 5）。
 *
 * 上下文闸对齐说明：计划夹具的 originalRequest 与 runOptions 的 taskText 不同，
 * strict 模式必然拦下——用例 1/3 因此显式关闭闸（DSH_WORKPLAN_CONTEXT_GUARD=off
 * 是文档化的回滚开关），用例 4 反过来验证闸仍然有效。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { plannerTelemetryLine, runPlanner } from '../src/runtime.js'

/*
 * 规划器计时器不 unref（真挂死时必须有人负责掐断），Node 22 在事件循环空掉时
 * 会取消挂起的测试：用 1 秒心跳顶住，60 秒后自行放手。
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

const now = () => Date.now()

function maskedAbort() {
  // 真实 LLM 层在 abort 时抛的就是这种泛化错误，真实原因只能从 signal.reason 读。
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

type Scenario = (signal: AbortSignal) => AsyncGenerator<any>

/** seen 会按顺序记下每次 stream 调用的 options，供旋钮断言。 */
function fakeCtx(scenario: Scenario, seen: any[] = []) {
  return {
    llm: {
      stream(options: any) {
        seen.push(options)
        return { [Symbol.asyncIterator]: () => scenario(options.signal) }
      },
    },
  } as any
}

function runOptions(overrides: any = {}) {
  const telemetry: any = {}
  return {
    telemetry,
    options: {
      taskText: '把这份说明整理成三段，每段不超过五行。',
      cwd: '/tmp',
      sessionId: 'session-planner-salvage',
      modelSelection: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'high' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: { totalMinutes: 20, childMinutes: 15, concurrency: 5, maxResumes: 4 },
      sourceMessageIds: [],
      ...overrides,
    },
  }
}

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

/** 与 tests/plan.test.ts 的 validPlan 夹具一致：能通过 validatePlan 的最小完整计划。 */
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
        subtasks: [
          {
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
          },
        ],
      },
      {
        id: 'S2',
        name: '验证',
        goal: '执行验证',
        rationale: '在范围内收集证据',
        checkpoint: '证据可复现',
        subtasks: [
          {
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
          },
        ],
      },
    ],
    risks: [
      {
        risk: '环境不稳定',
        likelihood: 'medium',
        impact: '结果不可复现',
        mitigation: '记录环境版本',
        trigger: '同一检查结果不一致',
      },
    ],
    verification: [{ item: '报告可复现', method: '按报告步骤重跑', evidence: '重跑日志' }],
    practiceLoop: { plan: '列假设', do: '执行检查', check: '核对证据', act: '修正结论' },
  }
}

const planJson = () => JSON.stringify(planFixture())

/** 把正文分片吐出；给 afterText 时随后进入持续产出状态，直到被定时器中止。 */
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

test('绝对上限中止时正文已写完 → 抢救成功，计划照常返回', async () => {
  const timeoutMs = 100 // 绝对上限 = 300ms，足够把 JSON 分片流完
  await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', async () => {
    const { telemetry, options } = runOptions({
      plannerTimeoutMs: timeoutMs,
      plannerIdleTimeoutMs: timeoutMs * 10,
    })
    const started = now()
    const plan: any = await runPlanner(
      fakeCtx((signal) => streamText(planJson(), signal, (sig) => untilHardAbort(sig))),
      { ...options, telemetry },
    )
    const elapsed = now() - started
    assert.ok(plan, '必须返回计划而不是抛超时')
    assert.equal(plan.title, '验证一个需求')
    assert.equal(plan.stages.length, 2)
    assert.equal(telemetry.outcome, 'SALVAGED', '判定必须留下抢救痕迹')
    assert.ok(elapsed >= timeoutMs * 3 - 40, `确实走到绝对上限才中止（${elapsed}ms）`)
    assert.equal(telemetry.textChars, planJson().length, '遥测必须记录真实输出字数')
  })
})

test('正文被拦腰截断 → 不抢救，仍报绝对上限，但遥测留下输出字数', async () => {
  const timeoutMs = 100
  const full = planJson()
  let cut = full.slice(0, Math.floor(full.length / 2))
  while (cut.endsWith('}')) cut = cut.slice(0, -1) // 保证截断点不在闭合括号上
  assert.ok(!cut.endsWith('}'), '截断点必须未闭合')
  const { telemetry, options } = runOptions({
    plannerTimeoutMs: timeoutMs,
    plannerIdleTimeoutMs: timeoutMs * 10,
  })
  await assert.rejects(
    () =>
      runPlanner(
        fakeCtx((signal) => streamText(cut, signal, (sig) => untilHardAbort(sig))),
        { ...options, telemetry },
      ),
    (error: any) => {
      assert.equal(error.code, 'PLANNER_TIMEOUT_HARD')
      return true
    },
  )
  assert.equal(telemetry.outcome, 'PLANNER_TIMEOUT_HARD')
  assert.equal(telemetry.textChars, cut.length, '残缺正文也要留档，旧实现这里是 0')
  const line = plannerTelemetryLine(telemetry)
  assert.match(line, /输出 \d+ 字/, `现场必须能复盘输出规模：${line}`)
})

test('缺 finish 信号但正文完整 → 抢救成功', async () => {
  await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', async () => {
    const { telemetry, options } = runOptions({ plannerTimeoutMs: 60_000 })
    const plan: any = await runPlanner(
      fakeCtx(async function* (signal) {
        yield* streamText(planJson(), signal) // 流完就结束，不给 finish 块
      }),
      { ...options, telemetry },
    )
    assert.equal(plan.title, '验证一个需求')
    assert.equal(telemetry.outcome, 'SALVAGED')
  })
})

test('抢救不绕过上下文闸：strict 下任务不符仍按原判定中止', async () => {
  // 不关闸：计划夹具讲的是「验证需求」，taskText 讲的是「整理成三段」，必然拦下。
  const timeoutMs = 100
  const { telemetry, options } = runOptions({
    plannerTimeoutMs: timeoutMs,
    plannerIdleTimeoutMs: timeoutMs * 10,
  })
  await assert.rejects(
    () =>
      runPlanner(
        fakeCtx((signal) => streamText(planJson(), signal, (sig) => untilHardAbort(sig))),
        { ...options, telemetry },
      ),
    (error: any) => {
      assert.equal(error.code, 'PLANNER_TIMEOUT_HARD', `闸必须拦下：${error.message}`)
      return true
    },
  )
  assert.notEqual(telemetry.outcome, 'SALVAGED', 'strict 闸未通过时绝不能标成已抢救')
})

test('两个旋钮：MAX_TOKENS / REASONING_EFFORT 透传给模型调用；不设时规划器取默认 max（不继承主 Agent）', async () => {
  // 场景只吐 {} 就正常 finish：两次都过不了 validatePlan，最终 PLANNER_FAILED——
  // 本用例只关心 stream 收到了什么参数，不关心成败。
  const quickFail: Scenario = async function* (signal) {
    await waitOrAbort(5, signal)
    yield { type: 'text-delta', text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  await withEnv('DSH_WORKPLAN_PLANNER_MAX_TOKENS', undefined, async () => {
    await withEnv('DSH_WORKPLAN_PLANNER_REASONING_EFFORT', undefined, async () => {
      const seen: any[] = []
      const { options, telemetry } = runOptions()
      await assert.rejects(() => runPlanner(fakeCtx(quickFail, seen), { ...options, telemetry }))
      assert.ok(seen.length >= 1, '至少调用一次模型')
      assert.equal(seen[0].maxTokens, undefined, '不设旋钮时不得擅自封顶')
      // [2.2.0][T13b] 用户决策 5「规划器停止继承」：未设旋钮时取默认 max，
      // 不得再等于 modelSelection.reasoningEffort（'high'）。
      assert.equal(seen[0].reasoningEffort, 'max', '不设旋钮时规划器不得继承主 Agent 的 high，必须取默认 max')
      assert.equal(telemetry.reasoningEffort, 'max', '遥测必须记录实际发给模型的档位')
      assert.equal(telemetry.reasoningEffortSource, 'default-max', '遥测必须能区分默认档与显式旋钮')
    })
  })

  await withEnv('DSH_WORKPLAN_PLANNER_MAX_TOKENS', '4096', async () => {
    await withEnv('DSH_WORKPLAN_PLANNER_REASONING_EFFORT', 'low', async () => {
      const seen: any[] = []
      const { options, telemetry } = runOptions()
      await assert.rejects(() => runPlanner(fakeCtx(quickFail, seen), { ...options, telemetry }))
      assert.ok(seen.length >= 1, '至少调用一次模型')
      assert.equal(seen[0].maxTokens, 4096, '封顶旋钮必须透传')
      assert.equal(seen[0].reasoningEffort, 'low', '规划专用推理档必须覆盖继承值')
    })
  })

  await withEnv('DSH_WORKPLAN_PLANNER_MAX_TOKENS', 'abc', async () => {
    const seen: any[] = []
    const { options, telemetry } = runOptions()
    await assert.rejects(() => runPlanner(fakeCtx(quickFail, seen), { ...options, telemetry }))
    assert.equal(seen[0].maxTokens, undefined, '非法取值必须回落（不许把封顶打成 NaN）')
  })
})

/*
 * [2.2.0][T13b/推理等级] 规划器停止继承（用户 2026-11-08 决策 5，选项 A）。
 *
 * 修复前 runtime.ts 是 `plannerEffort || modelSelection.reasoningEffort`：主 Agent
 * 用 low 省成本时规划器也低档，拆解变浅；主 Agent 用 max 时又替用户多花钱。
 * 修复后规划档位只有两个来源：合法旋钮值，或默认 max。本用例把「主 Agent 三档
 * 全试一遍 + 旋钮合法/非法/缺省」全部钉住，任何把 modelSelection 重新接回规划
 * 路径的改动都会在这里红灯。
 */
test('规划器停止继承：主 Agent low/high/max 一律得默认 max；旋钮合法值覆盖、非法值回落', async () => {
  const quickFail: Scenario = async function* (signal) {
    await waitOrAbort(5, signal)
    yield { type: 'text-delta', text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const run = async (mainEffort: string | undefined, envValue: string | undefined) => {
    const seen: any[] = []
    const telemetry: any = {}
    await withEnv('DSH_WORKPLAN_PLANNER_REASONING_EFFORT', envValue, async () => {
      const { options } = runOptions({
        modelSelection: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: mainEffort },
      })
      await assert.rejects(() => runPlanner(fakeCtx(quickFail, seen), { ...options, telemetry }))
    })
    assert.ok(seen.length >= 1, '至少调用一次模型')
    return { effort: seen[0].reasoningEffort, telemetry }
  }

  for (const main of ['low', 'high', 'max']) {
    const { effort, telemetry } = await run(main, undefined)
    assert.equal(effort, 'max', `主 Agent=${main} 时规划器不得继承，必须取默认 max`)
    assert.equal(telemetry.reasoningEffort, 'max', `主 Agent=${main} 时遥测必须记录实际生效的 max`)
    assert.equal(telemetry.reasoningEffortSource, 'default-max')
  }

  // 主 Agent 未指定档位时也不得变成 undefined（旧实现会把 undefined 透传给宿主→再次继承）。
  const undefinedMain = await run(undefined, undefined)
  assert.equal(undefinedMain.effort, 'max', '主 Agent 未指定档位时规划器仍须显式取 max')

  const lowKnob = await run('max', 'low')
  assert.equal(lowKnob.effort, 'low', '合法旋钮值必须覆盖默认档（保留降本/提速出口）')
  assert.equal(lowKnob.telemetry.reasoningEffortSource, 'env')

  const upperKnob = await run('max', 'LOW')
  assert.equal(upperKnob.effort, 'low', '大小写不应把合法档位变成非法值并静默抬高成本')

  const invalidKnob = await run('low', 'ultra')
  assert.equal(invalidKnob.effort, 'max', '非法旋钮值不得发给模型，必须回落 max')
  assert.equal(invalidKnob.telemetry.reasoningEffortSource, 'default-max')
})
