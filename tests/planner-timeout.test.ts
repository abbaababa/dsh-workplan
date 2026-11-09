/*
 * [2.1.6] 规划器计时策略的回归用例——针对第三次复发的超时事故。
 *
 * 事故（2026-11-07，会话原始日志实测）：10:05:19.666 开始规划，10:10:19.700 被
 * abort 降级，差值 300.06 秒。旧实现是**固定墙钟**：模型只要还在正常输出，也会
 * 在第 300 秒被掐断；而 `PLANNER_IDLE_TIMEOUT_MS` 只声明、从未接线。
 *
 * 这里不测纯函数，而是用假 `ctx.llm.stream` 跑完整个 `runPlanner`，因为事故正是
 * 「定时器 ↔ 流」的协作断链，纯函数永远是绿的：
 *  1) 持续产出超过无进展窗口 → 不被掐断（进度把窗口往后推），最后正常走完；
 *  2) 一个字都不出 → 在无进展窗口处中止，报错点名真实旋钮 DSH_WORKPLAN_PLANNER_TIMEOUT_MS；
 *  3) 出了字之后完全静默 → 在静默窗口（更短）处中止，点名 DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS；
 *  4) 一直产出 → 撞绝对上限（×3），报错说明倍数关系；
 *  5) 窗口取值与遥测行的边界（0/负数/NaN 不得把计时器打成 1ms）。
 *
 * 假流模仿真实 LLM 层的行为：abort 被掩码成泛化的
 * "DeepSeek Messages request aborted"，因此用例同时验证 runPlanner 能从
 * `controller.signal.reason` 取回真实判定码，而不是把它当成偶发中断。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLANNER_IDLE_TIMEOUT_MS,
  PLANNER_TIMEOUT_MS,
  normalisePlannerWindow,
  plannerTelemetryLine,
  runPlanner,
} from '../src/runtime.js'
import { buildDegradedMessage } from '../src/plan.js'

/*
 * 规划器的计时器不 unref（真挂死时必须有人负责掐断），Node 22 在事件循环空掉时
 * 会取消挂起的测试：这里用 1 秒心跳顶住，60 秒后自行放手。
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

function fakeCtx(scenario: Scenario) {
  return {
    llm: {
      stream(options: any) {
        return {
          [Symbol.asyncIterator]: () => scenario(options.signal),
        }
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
      sessionId: 'session-planner-timeout',
      modelSelection: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'high' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: { totalMinutes: 20, childMinutes: 15, concurrency: 5, maxResumes: 4 },
      sourceMessageIds: [],
      ...overrides,
    },
  }
}

test('持续产出超过无进展窗口不会被掐断（进度把窗口往后推）', async () => {
  /*
   * 旧实现：墙钟 timeoutMs 一到就 abort，这里必然以 PLANNER_TIMEOUT 失败。
   * 新实现：每个 chunk 都重置「上一次进展」，只要一直有输出就能走到最后。
   */
  const timeoutMs = 150
  const scenario: Scenario = async function* (signal) {
    const started = now()
    while (now() - started < timeoutMs * 2) {
      await waitOrAbort(30, signal)
      yield { type: 'text-delta', text: '' }
    }
    // 输出结束：给一个能被解析成对象、但字段不全的 JSON，让流程走到校验分支。
    yield { type: 'text-delta', text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const { telemetry, options } = runOptions({
    plannerTimeoutMs: timeoutMs,
    // 静默窗口大于无进展窗口 = 关闭，避免干扰本用例的判定。
    plannerIdleTimeoutMs: timeoutMs * 10,
  })
  await assert.rejects(
    () => runPlanner(fakeCtx(scenario), { ...options, telemetry }),
    (error: any) => {
      // 不是被进度类计时器打断；失败原因是所有尝试都没通过校验。
      // [2.2.5][T4] 文案改为按实际尝试次数动态生成（原为固定的「两次」）。
      assert.equal(error.code, 'PLANNER_FAILED', `不该被计时器打断：${error.message}`)
      assert.match(error.message, /均未通过校验/)
      assert.match(error.message, /全部 3 次尝试/, '校验类失败仍会跑满全部尝试次数')
      return true
    },
  )
  assert.ok(
    telemetry.elapsedMs > timeoutMs,
    `流必须活过无进展窗口（elapsed=${telemetry.elapsedMs}ms > ${timeoutMs}ms）`,
  )
  assert.ok(telemetry.chunks >= 5, `窗口之后的输出块也必须被收到（chunks=${telemetry.chunks}）`)
  assert.ok(
    !['PLANNER_TIMEOUT', 'PLANNER_IDLE', 'PLANNER_TIMEOUT_HARD'].includes(telemetry.outcome),
    `判定码不该是计时器：${telemetry.outcome}`,
  )
})

test('完全不出字：在无进展窗口中止，报错点名 DSH_WORKPLAN_PLANNER_TIMEOUT_MS', async () => {
  const timeoutMs = 150
  const scenario: Scenario = async function* (signal) {
    await waitOrAbort(10_000, signal)
    yield { type: 'text-delta', text: '不该到这里' }
  }
  const { telemetry, options } = runOptions({
    plannerTimeoutMs: timeoutMs,
    plannerIdleTimeoutMs: timeoutMs * 10,
  })
  const started = now()
  await assert.rejects(
    () => runPlanner(fakeCtx(scenario), { ...options, telemetry }),
    (error: any) => {
      assert.equal(error.code, 'PLANNER_TIMEOUT')
      // 修复建议必须指向运行时真正的旋钮，而不是源码常量 PLANNER_TIMEOUT_MS。
      assert.match(error.message, /DSH_WORKPLAN_PLANNER_TIMEOUT_MS/)
      assert.doesNotMatch(error.message, /提高 PLANNER_TIMEOUT_MS/)
      return true
    },
  )
  const elapsed = now() - started
  assert.ok(elapsed >= timeoutMs - 20, `不能早于窗口中止（${elapsed}ms）`)
  assert.ok(elapsed < timeoutMs * 6, `不能拖到绝对上限才中止（${elapsed}ms）`)
  assert.equal(telemetry.outcome, 'PLANNER_TIMEOUT')
  assert.equal(telemetry.chunks, 0, '一个输出块都没收到')
  assert.equal(telemetry.model, 'fake-model')
  assert.ok(telemetry.promptChars > 0, '提示词规模必须被记录')
})

test('出了字之后完全静默：在更短的静默窗口中止，点名 DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS', async () => {
  const timeoutMs = 10_000 // 无进展窗口很大，确保中止来自静默窗口
  const idleMs = 150
  const scenario: Scenario = async function* (signal) {
    yield { type: 'reasoning-delta', text: '思考中' }
    await waitOrAbort(10_000, signal)
    yield { type: 'text-delta', text: '不该到这里' }
  }
  const { telemetry, options } = runOptions({
    plannerTimeoutMs: timeoutMs,
    plannerIdleTimeoutMs: idleMs,
  })
  const started = now()
  await assert.rejects(
    () => runPlanner(fakeCtx(scenario), { ...options, telemetry }),
    (error: any) => {
      assert.equal(error.code, 'PLANNER_IDLE')
      assert.match(error.message, /DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS/)
      return true
    },
  )
  const elapsed = now() - started
  assert.ok(elapsed >= idleMs - 30, `静默窗口到点才中止（${elapsed}ms）`)
  assert.ok(elapsed < timeoutMs / 2, `绝不能等到无进展窗口（${elapsed}ms）`)
  assert.equal(telemetry.outcome, 'PLANNER_IDLE')
  assert.ok(telemetry.chunks >= 1, '首个输出块之后才算静默')
})

test('一直产出：撞绝对上限（×3）而不是无限等下去', async () => {
  const timeoutMs = 120
  const scenario: Scenario = async function* (signal) {
    while (true) {
      await waitOrAbort(25, signal)
      yield { type: 'text-delta', text: 'x' }
    }
  }
  const { telemetry, options } = runOptions({
    plannerTimeoutMs: timeoutMs,
    plannerIdleTimeoutMs: timeoutMs * 10,
  })
  const started = now()
  await assert.rejects(
    () => runPlanner(fakeCtx(scenario), { ...options, telemetry }),
    (error: any) => {
      assert.equal(error.code, 'PLANNER_TIMEOUT_HARD')
      assert.match(error.message, /DSH_WORKPLAN_PLANNER_TIMEOUT_MS 的 3 倍/)
      return true
    },
  )
  const elapsed = now() - started
  const hardMs = timeoutMs * 3
  assert.ok(elapsed >= hardMs - 40, `必须活到绝对上限（${elapsed}ms ≈ ${hardMs}ms）`)
  assert.ok(elapsed < hardMs * 4, `也不能远超绝对上限（${elapsed}ms）`)
  assert.equal(telemetry.outcome, 'PLANNER_TIMEOUT_HARD')
  assert.ok(telemetry.chunks > 3, '绝对上限之前一直在收到输出')
})

test('窗口取值：0 / 负数 / NaN / 空串一律回落默认值', () => {
  assert.equal(normalisePlannerWindow(0, PLANNER_TIMEOUT_MS), PLANNER_TIMEOUT_MS)
  assert.equal(normalisePlannerWindow(-5, PLANNER_TIMEOUT_MS), PLANNER_TIMEOUT_MS)
  assert.equal(normalisePlannerWindow('abc', PLANNER_TIMEOUT_MS), PLANNER_TIMEOUT_MS)
  assert.equal(normalisePlannerWindow('', PLANNER_TIMEOUT_MS), PLANNER_TIMEOUT_MS)
  assert.equal(normalisePlannerWindow(undefined, PLANNER_IDLE_TIMEOUT_MS), PLANNER_IDLE_TIMEOUT_MS)
  assert.equal(normalisePlannerWindow('250000', PLANNER_TIMEOUT_MS), 250000)
  assert.equal(normalisePlannerWindow(250000, PLANNER_TIMEOUT_MS), 250000)
})

test('遥测行：没有现场就不编，有现场就说人话', () => {
  assert.equal(plannerTelemetryLine(undefined), '')
  assert.equal(plannerTelemetryLine({}), '')
  const line = plannerTelemetryLine({
    attempt: 1,
    model: 'fake-model',
    elapsedMs: 3000,
    chunks: 0,
    promptChars: 1200,
    outcome: 'PLANNER_TIMEOUT',
  })
  assert.match(line, /模型 fake-model/)
  assert.match(line, /耗时 3\.0s/)
  assert.match(line, /未收到任何输出块/)
  assert.match(line, /提示词 1200 字/)
  assert.match(line, /判定 PLANNER_TIMEOUT/)
})

test('降级消息带上失败现场（detail），没给就不占位', () => {
  const withDetail = buildDegradedMessage({
    planId: 'wp-x',
    sessionId: 's',
    createdTurn: 1,
    createdAt: 1,
    error: '规划器超时：…',
    detail: '现场：模型 fake-model｜耗时 300.1s｜未收到任何输出块',
    taskText: '任务',
  })
  const text = withDetail.content?.[0]?.text ?? ''
  assert.match(text, /现场：模型 fake-model/)
  assert.match(text, /自动任务分解失败/)
  const withoutDetail = buildDegradedMessage({
    planId: 'wp-y',
    sessionId: 's',
    createdTurn: 1,
    createdAt: 1,
    error: '别的错误',
    taskText: '任务',
  })
  const plain = withoutDetail.content?.[0]?.text ?? ''
  assert.doesNotMatch(plain, /现场：/)
})
