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
import { buildPlanMessage } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

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

test('O-4c（3.2.4 口径）：update schema 只声明仍在使用的 timeNotice，不再宣告已停用的 extendMs/criterionApproval', () => {
  const tool: any = createUpdateTool({})
  const props = tool?.parameters?.properties ?? {}
  /*
   * [3.2.4][省钱 R5] 延期事务与判据 v2 批准闸在生产路径恒不可达
   * （criterionV2Active() 恒 false；extendMs 一律 TIME_LIMITS_DISABLED），
   * 所以两个字段从 schema 移除：既省每次请求的说明字数，也不再把模型引向
   * 一次注定被拒的调用。runtime 仍保留旧字段兼容读取（本文件下方的直接
   * updateStatus 用例继续验证 TIME_LIMITS_DISABLED）。
   */
  assert.equal(props.extendMs, undefined, 'extendMs 已停用，不得再向模型宣告')
  assert.equal(props.criterionApproval, undefined, 'criterionApproval 随判据 v2 停用，不得再向模型宣告')
  assert.ok(props.timeNotice, 'schema 仍需声明 timeNotice（{declaredMinutes, reason}，仍在使用的开工预估）')
  assert.equal(props.timeNotice.type, 'object', 'timeNotice 为对象')
  assert.equal(tool?.parameters?.additionalProperties, false, '保持 additionalProperties:false（宿主 schema 子集）')
})

test('无时限：运行中 extendMs 返回 TIME_LIMITS_DISABLED，不写 deadline/journal，越过旧窗口仍存活', async () => {
  const { session, runtime, gate, hasStarted } = makeRuntime({}, { childTimeoutMs: 1_200 })
  const dispatchP = runtime.dispatchTool(
    { session, options: {} },
    { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' },
    new AbortController().signal,
  )
  assert.ok(await waitFor(hasStarted), 'T1 应已派发')
  const before = await rowOf(runtime, session)
  const res: any = await runtime.updateStatus(
    { session },
    { subtaskId: 'T1', extendMs: 1_500, reason: '旧调用兼容探针' },
  )
  assert.equal(res?.ok, false)
  assert.equal(res?.code, 'TIME_LIMITS_DISABLED', '明确告知无截止可延期，不得伪装成功')
  assert.match(String(res?.error ?? ''), /取消时限|无需/, '回执解释当前无时限')
  const afterExtend = await rowOf(runtime, session)
  assert.equal(afterExtend?.deadlineAt, null, '不得重新武装 deadlineAt')
  assert.equal(before?.deadlineAt, null, '起始即无 deadline')
  const extensionJournal = (afterExtend?.timeJournal ?? []).filter((entry: any) => entry?.action === 'extend')
  assert.equal(extensionJournal.length, 0, '未生效的延期不得记入生效流水')
  await delay(1_700)
  const alive = await rowOf(runtime, session)
  assert.equal(alive?.status, 'in_progress', '越过旧 1.2 秒窗口后任务仍必须存活')
  gate.release(completed('完成'))
  await dispatchP
  const finished = await rowOf(runtime, session)
  assert.notEqual(finished?.status, 'blocked', '显式完成不得被记为超时 blocked')
})

test('无时限：旧 timeoutMs/childTimeoutMs 下重复 extendMs 均拒绝，不存在封顶或裁决升级', async () => {
  const { session, runtime, gate, hasStarted } = makeRuntime({ timeoutMs: 2_000 }, { childTimeoutMs: 2_000 })
  const dispatchP = runtime.dispatchTool(
    { session, options: {} },
    { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' },
    new AbortController().signal,
  )
  assert.ok(await waitFor(hasStarted), 'T1 应已派发')
  const first: any = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 1_500, reason: '第一次旧调用' })
  const second: any = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 1_500, reason: '第二次旧调用' })
  for (const res of [first, second]) {
    assert.equal(res?.ok, false)
    assert.equal(res?.code, 'TIME_LIMITS_DISABLED')
    assert.doesNotMatch(String(res?.code ?? ''), /EXTEND_BUDGET_EXHAUSTED|TAKEOVER/)
  }
  const row = await rowOf(runtime, session)
  assert.equal(row?.status, 'in_progress')
  assert.equal(row?.deadlineAt, null)
  gate.release(completed('完成'))
  await dispatchP
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
