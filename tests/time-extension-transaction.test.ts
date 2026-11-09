/*
 * [2.2.0][T2 红灯先行] extendMs 放宽事务 —— 对应优化项 **O-4c / O-4d**。
 * 设计依据：docs/dsh-workplan_优化方案_20261107.md §1 ④ 验收矩阵 D2/D3/D4、
 * §2.2「extendMs 事务」四步、§2.4 API 面、§5.4 防滥用 #1/#2。
 *
 * 断言点（数值/口径抄录方案原文，不改写）：
 *  - schema：`dsh_workplan_update` **显式声明 extendMs（整数毫秒）与 timeNotice**
 *    （additionalProperties:false，D-28 教训，2.6 表 #11）；
 *  - D2：运行中仅凭 extendMs 放宽（TASK_RUNNING 唯一豁免、不需 force），
 *    `deadlineAt += extendMs` 并重置计时，**任务不被原截止点杀死**（D2）；
 *  - D3：放宽全程写入协商流水 timeJournal（含时间/操作者/理由）；
 *  - D4：累计放宽（journal 中 extend 之和）**≤ 初始协商上限 × 1**（最多再给一倍），
 *    超封顶被拒并转「**请主 Agent 裁决**」（转新轮续跑或转 escalate 由人拍板）；
 *  - §5.4 #1：**子 Agent 身份发起 extendMs 被拒**（update 工具 root-only，
 *    子 Agent 物理上无法给自己放宽，授予权只在主 Agent）。
 *
 * 现状（v2.1.7，红灯原因）：createUpdateTool schema（src/host.ts:230-321）无
 * extendMs/timeNotice；updateStatus（src/runtime.ts:3540）无 extendMs 分支，
 * 不带 status 直接抛 INVALID_STATUS，运行中写入被 TASK_RUNNING 拒绝
 * （src/runtime.ts:3586-3601）；计时是一次性 setTimeout（src/runtime.ts:1787-1831）。
 * root-only 守卫（src/runtime.ts:3543）现状即在——该项是防御钉，保持全绿。
 *
 * 计时口径：不使用真实长睡眠。时限注入小窗口（childTimeoutMs 1200/2000ms，
 * 与既有 workplan-auto-retry.test.ts 同构），等待用 10ms 轮询，可重复。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { createUpdateTool } from '../src/host.js'
import { buildPlanMessage, parseResultMessage } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlanMessage(extra: any = {}) {
  return buildPlanMessage({
    planId: 'wp-extend',
    sessionId: 'session-extend',
    createdTurn: 1,
    createdAt: 1000,
    title: '放宽事务验收',
    taskUnderstanding: { originalRequest: '验证 extendMs 事务', deliverable: '放宽可推移计时' },
    contradictions: { primary: { statement: '运行中需要放宽时限' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '长任务收尾',
        department: 'engineering',
        objective: '验证放宽事务',
        method: ['执行'],
        inputs: [],
        outputs: ['T1_report.md'],
        acceptance: ['收尾完成'],
        risk: '超时',
        dependsOn: [],
        ...extra,
      }],
    }],
  })
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

function makeRuntime(planExtra: any = {}, options: any = {}) {
  const session: any = {
    id: 'session-extend',
    header: { createdAt: 1000 },
    events: [] as any[],
    get seq() {
      return this.events.length
    },
    append(type: string, data: any) {
      this.events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', makePlanMessage(planExtra))
  const gate = deferred()
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        started = true
        return { childId: 'child-extend', result: gate.promise, dispose: async () => {} }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    strictEvidence: false,
    ...options,
  })
  return { session, runtime, gate, hasStarted: () => started }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function rowOf(runtime: any, session: any, subtaskId = 'T1') {
  const snapshot: any = await runtime.statusTool({ session }, {})
  return (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === subtaskId)
}

test('O-4c：dsh_workplan_update schema 显式声明 extendMs 与 timeNotice（D-28，additionalProperties:false）', () => {
  const tool: any = createUpdateTool({})
  const props = tool?.parameters?.properties ?? {}
  assert.ok(
    props.extendMs,
    '待实现（O-4c/2.6 表 #11）：createUpdateTool schema 必须显式声明 extendMs（runtime 读了字段但 schema 没声明，严格宿主直接拒收——D-28 教训）',
  )
  assert.equal(props.extendMs.type, 'integer', 'extendMs 为整数毫秒')
  assert.ok(props.timeNotice, '待实现（O-4c）：schema 需声明 timeNotice（{declaredMinutes, reason}）')
  assert.equal(props.timeNotice.type, 'object', 'timeNotice 为对象')
  assert.equal(tool?.parameters?.additionalProperties, false, '保持 additionalProperties:false（宿主 schema 子集）')
})

test('O-4c/O-4d：运行中仅凭 extendMs 放宽（不需 force），deadlineAt += extendMs、计时重置、不被原截止点杀死（D2），并记入 timeJournal（D3）', async () => {
  const { session, runtime, gate, hasStarted } = makeRuntime({}, { childTimeoutMs: 1_200 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted), 'T1 应已派发')
  const before = await rowOf(runtime, session)
  let res: any
  try {
    res = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 1_500, reason: '专家预警新预估，需继续收尾' })
  } catch (error: any) {
    assert.fail(
      `待实现（O-4c/D2）：运行中 extendMs 事务应放行（入参 { subtaskId, extendMs, reason }，不改判定只改时限、无需 force；TASK_RUNNING 唯一豁免）。现状抛错：${String(error?.code ?? error?.message ?? error)}`,
    )
  }
  assert.equal(res?.ok, true, '待实现（O-4c/D2）：运行中 extendMs 应放行并返回 ok（TASK_RUNNING 唯一豁免分支，src/runtime.ts:3586-3601）')
  const afterExtend = await rowOf(runtime, session)
  assert.ok(
    Number.isFinite(Number(afterExtend?.deadlineAt)),
    '待实现（O-4d/§2.2）：状态行应有协商截止 deadlineAt（毫秒时间戳，可被 extendMs 推移）',
  )
  assert.equal(
    Number(afterExtend.deadlineAt) - Number(before?.deadlineAt ?? NaN),
    1_500,
    'O-4d：deadlineAt += extendMs（方案 §2.2 效果 3：定时器与 watchdog hardMs 同步推移）',
  )
  assert.ok(
    Array.isArray(afterExtend?.timeJournal)
      && afterExtend.timeJournal.some((entry: any) => entry?.action === 'extend' && Number(entry?.extendMs) === 1_500 && String(entry?.reason ?? '').includes('专家预警')),
    '待实现（D3）：放宽全程写入协商流水 timeJournal（含时间/操作者/理由；方案 §2.2）',
  )
  // 原截止点（1200ms）已过、任务仍存活 = 计时已按新 deadlineAt 重置。
  await delay(1_700)
  const alive = await rowOf(runtime, session)
  assert.equal(alive?.status, 'in_progress', 'O-4d/D2：extendMs 后任务不得在原截止点被杀（一次性 setTimeout 改为截止时刻驱动的可重置计时）')
  gate.release(completed('完成'))
  assert.ok(await waitFor(() => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data)), 10_000), '本轮应收束')
})

test('O-4c/D4：累计延期超封顶（初始协商上限 × 1）被拒并转「请主 Agent 裁决」', async () => {
  // 初始协商上限 = 2000ms（显式 timeoutMs 与全局 childTimeoutMs 同值，两条取值路径一致）。
  const { session, runtime, gate, hasStarted } = makeRuntime({ timeoutMs: 2_000 }, { childTimeoutMs: 2_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted), 'T1 应已派发')
  let first: any
  try {
    first = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 1_500, reason: '第一次放宽' })
  } catch (error: any) {
    assert.fail(`待实现（O-4c）：封顶内的 extendMs 应放行。现状抛错：${String(error?.code ?? error?.message ?? error)}`)
  }
  assert.equal(first?.ok, true, '累计 1500ms ≤ 初始协商上限 2000ms × 1，应放行')
  let second: any
  try {
    second = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 1_500, reason: '第二次放宽' })
  } catch (error: any) {
    assert.fail(
      `待实现（O-4c/D4）：累计放宽（3000ms）超初始协商上限 × 1（2000ms）应被拒绝并转「请主 Agent 裁决」，而不是抛裸错。现状抛错：${String(error?.code ?? error?.message ?? error)}`,
    )
  }
  assert.equal(second?.ok, false, '待实现（D4/§2.2 校验 2）：累计 extendMs ≤ 初始协商上限 × 1（最多再给一倍），超封顶必须被拒（放宽永远有界）')
  assert.match(String(second?.code ?? ''), /EXTEND|BUDGET|CAP/i, '拒绝错误码应点名放宽预算耗尽（如 EXTEND_BUDGET_EXHAUSTED，方案 §2.2 拒绝路径）')
  assert.match(
    String(second?.hint ?? '') + String(second?.error ?? ''),
    /裁决|新轮|人工|escalat/i,
    '待实现（D4）：超封顶必须自动转「请主 Agent 裁决」——提示转新轮续跑（auto-resume）或转 escalate 由主 Agent/用户决策',
  )
  gate.release(completed('完成'))
  await waitFor(() => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data)), 10_000)
})

test('O-4c/§5.4 #1：子 Agent 身份发起 extendMs 被拒（update 工具 root-only）', async () => {
  const childSession = {
    id: 'session-subagent-child',
    header: { createdAt: 1, origin: 'subagent' },
    events: [] as any[],
    get seq() {
      return 0
    },
    append() {
      throw new Error('子会话不应被写')
    },
    eventAt: () => undefined,
  }
  const { runtime } = makeRuntime()
  await assert.rejects(
    () => runtime.updateStatus({ session: childSession }, { subtaskId: 'T1', extendMs: 60_000, reason: '给自己放宽' }),
    (error: any) => /NOT_ROOT|子 Agent/.test(String(error?.code ?? '') + String(error?.message ?? '')),
    '子 Agent 不能给自己放宽时间（root-only 结构性防线必须保持：授予权只在主 Agent）',
  )
})
