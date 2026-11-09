/*
 * [2.2.0][T2 红灯先行] 专家时长预告 + 预估去钳制 + 协商上限派生
 * —— 对应优化项 **O-2a / O-2b / O-3a / O-3b**。
 * 设计依据：docs/dsh-workplan_优化方案_20261107.md §1 ②③ 验收矩阵 B1/B2、C1/C3。
 *
 * 断言点（阈值/公式/数值抄录方案原文，不改写）：
 *  - B2/O-2b：预估区间 **1–240 整数**——1、90、240 通过且原样保留（1-15 钳制不复存在），
 *    **0 与 241 被拒**（仅防离谱值，不是钳制）；
 *  - O-3a：子任务可选 **timeoutMs**（协商上限）原样透传（2.6 表 #1）；
 *  - O-3b/C3：缺省时 **协商上限 = clamp(预估分钟 × 2.0, MIN_CHILD_TIMEOUT_MS,
 *    MAX_CHILD_TIMEOUT_MS)**（方案 §2.2；MIN=1000ms / MAX=1800000ms 抄自
 *    src/runtime.ts:220-221），3 组边界样例：最小预告、乘积超 MAX、中间值；
 *  - B1/O-2a：派发提示词含「开工前先报预估时长」条款（新预估覆盖旧预估），
 *    且不含固定完成承诺。
 *
 * 现状（v2.1.7，红灯原因）：src/plan.ts:705-706 钳制
 * `Math.min(15, Math.max(1, Math.round(...)))`（90/240 被钳成 15；0/241 被钳成
 * 1/15 而不是被拒）；readSubtasks 不透传 timeoutMs；协商上限派生与 deadlineAt
 * 不存在；buildChildPrompt（src/plan.ts:4148-4369）全文无时间条款。
 *
 * 计时口径：派生值断言不依赖真实等待——运行中读状态行 deadlineAt（方案 §2.2
 * 状态行字段），假子会话由 deferred 门吊住，读完即放行。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildChildPrompt, validatePlan } from '../src/plan.js'
import { buildPlanMessage, parseResultMessage } from '../src/plan.js'
import {
  createWorkplanRuntime,
  MIN_CHILD_TIMEOUT_MS,
  MAX_CHILD_TIMEOUT_MS,
} from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

/** 能通过 validatePlan 的最小完整计划（与 tests/plan.test.ts 的 validPlan 同构）。 */
function planWithSubtask(subtask: any) {
  return {
    version: 1,
    title: '时长协商验收',
    taskUnderstanding: {
      originalRequest: '验证预估区间与协商上限派生',
      deliverable: '一份验证报告',
      successCriteria: ['报告给出可复现的证据'],
      constraints: ['不要修改业务代码'],
      knownFacts: ['用户要求验证预估口径'],
      unknowns: ['无'],
      assumptions: ['验证环境可用'],
    },
    contradictions: {
      primary: {
        statement: '预估的诚实表达与离谱值防护之间的矛盾',
        evidence: ['钳制会把长任务预估改短'],
        whyPrimary: '预估失准会直接变成误杀',
      },
      secondary: ['旧计划缺少新字段'],
      transformationConditions: ['若出现离谱值，防护需求上升'],
    },
    stages: [
      {
        id: 'S1',
        name: '实施',
        goal: '验证预估口径',
        rationale: '先验证区间再验证派生',
        checkpoint: '区间校验通过',
        subtasks: [subtask],
      },
    ],
    risks: [
      {
        risk: '预估失准',
        likelihood: 'medium',
        impact: '时限误判',
        mitigation: '预告协商',
        trigger: '实际用时超预估',
      },
    ],
    verification: [
      { item: '预估区间可复现', method: '按报告步骤重跑', evidence: '重跑日志' },
    ],
    practiceLoop: {
      plan: '列样例',
      do: '跑校验',
      check: '核对数值',
      act: '修正实现',
    },
  }
}

function baseSubtask(extra: any = {}) {
  return {
    id: 'T1',
    title: '梳理验证范围',
    department: 'research',
    role: '需求分析',
    objective: '验证预估区间',
    method: ['列出样例'],
    inputs: ['用户需求'],
    outputs: ['验证报告'],
    dependsOn: [],
    acceptance: ['每个样例都有断言'],
    risk: '预估失准',
    ...extra,
  }
}

function makePlanMessage(subtask: any) {
  return buildPlanMessage({
    planId: 'wp-time-estimate',
    sessionId: 'session-time-estimate',
    createdTurn: 1,
    createdAt: 1000,
    title: '时长协商验收',
    taskUnderstanding: { originalRequest: '验证协商上限派生', deliverable: '派生值正确' },
    contradictions: { primary: { statement: '预估必须进入超时计算' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks: [subtask] }],
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

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('B2/O-2b：预估 1、90、240 通过校验且原样保留（1-15 钳制不复存在）', () => {
  for (const value of [1, 90, 240]) {
    const result: any = validatePlan(planWithSubtask(baseSubtask({ estimateMinutes: value })))
    assert.equal(result.ok, true, `estimateMinutes=${value}（1–240 区间内）必须通过校验`)
    assert.equal(
      result.plan?.stages?.[0]?.subtasks?.[0]?.estimateMinutes,
      value,
      `待实现（O-2b/B2）：estimateMinutes=${value} 必须原样保留，不得被钳制（现状 src/plan.ts:705-706 把它钳成 1-15；方案要求放宽为 1-240 整数）`,
    )
  }
})

test('B2/O-2b：预估 0 与 241 被拒（仅防离谱值，不是钳制）', () => {
  for (const value of [0, 241]) {
    const result: any = validatePlan(planWithSubtask(baseSubtask({ estimateMinutes: value })))
    assert.equal(
      result.ok,
      false,
      `待实现（O-2b/B2）：estimateMinutes=${value} 越界（1–240 整数）必须被拒（仅防离谱值），而不是被钳成别的值继续通过`,
    )
    assert.ok(
      Array.isArray(result.errors) && result.errors.some((line: string) => /estimateMinutes/.test(line)),
      `拒绝理由必须点名 estimateMinutes（收到：${JSON.stringify(result.errors ?? [])}）`,
    )
  }
})

test('O-3a：timeoutMs 作为 per-subtask 协商上限被原样透传', () => {
  const result: any = validatePlan(planWithSubtask(baseSubtask({ estimateMinutes: 10, timeoutMs: 3_600_000 })))
  assert.equal(result.ok, true, '带 timeoutMs 的计划必须通过校验（可选字段，缺省合法）')
  assert.equal(
    result.plan?.stages?.[0]?.subtasks?.[0]?.timeoutMs,
    3_600_000,
    '待实现（O-3a/2.6 表 #1）：readSubtasks 必须新增可选 timeoutMs 透传（本子任务的协商上限）',
  )
})

test('O-3b/C3：协商上限 = clamp(预告分钟 × 2.0, MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS)——3 组边界样例', async () => {
  /*
   * 数值抄录方案原文：
   *  - 安全系数 2.0（方案 §2.2/§6.5）；
   *  - 钳制区间 [MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS]（方案 C3，
   *    常量抄自 src/runtime.ts:220-221）。
   * 三组样例：最小预告（1 分钟）、乘积超 MAX（240 分钟）、中间值（10 分钟）。
   */
  const samples = [
    { label: '最小预告 1 分钟（下界不误伤）', estimateMinutes: 1 },
    { label: '乘积超 MAX：预告 240 分钟（240×2.0=28800000ms 应钳到 MAX）', estimateMinutes: 240 },
    { label: '中间值 10 分钟（区间内原样）', estimateMinutes: 10 },
  ]
  for (const sample of samples) {
    const derived = sample.estimateMinutes * 2.0 * 60_000
    const expected = Math.min(MAX_CHILD_TIMEOUT_MS, Math.max(MIN_CHILD_TIMEOUT_MS, derived))
    const subtask = baseSubtask({ estimateMinutes: sample.estimateMinutes })
    const session: any = {
      id: `session-derive-${sample.estimateMinutes}`,
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
    session.append('user/message', makePlanMessage(subtask))
    const gate = deferred()
    const ctx = {
      logger: { warn() {} },
      subagents: {
        startActivation: async () => ({ childId: 'child-derive', result: gate.promise, dispose: async () => {} }),
      },
      sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    }
    const runtime = createWorkplanRuntime(ctx, {
      totalTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
      strictEvidence: false,
    })
    await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
    const snapshot: any = await runtime.statusTool({ session }, {})
    const row = (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
    assert.ok(
      Number.isFinite(Number(row?.deadlineAt)) && Number.isFinite(Number(row?.startedAt)),
      `待实现（O-3b/§2.2）：${sample.label}：运行中状态行应有协商截止 deadlineAt（= startedAt + clamp(预告分钟×2.0, ${MIN_CHILD_TIMEOUT_MS}, ${MAX_CHILD_TIMEOUT_MS})）`,
    )
    assert.equal(
      Number(row.deadlineAt) - Number(row.startedAt),
      expected,
      `${sample.label}：协商上限应为 ${expected}ms（公式 clamp(${sample.estimateMinutes}×2.0 分钟 = ${derived}ms, ${MIN_CHILD_TIMEOUT_MS}, ${MAX_CHILD_TIMEOUT_MS})）`,
    )
    gate.release(completed('完成'))
    assert.ok(
      await waitFor(() => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data)), 10_000),
      '本轮应收束',
    )
  }
})

test('B1/O-2a：派发提示词含「开工前先报预估时长」条款，且不含固定完成承诺', () => {
  const subtask = baseSubtask({ estimateMinutes: 10 })
  const plan = {
    planId: 'wp-prompt',
    title: 't',
    taskUnderstanding: { originalRequest: '需求', deliverable: '交付物' },
    contradictions: { primary: { statement: '矛盾' } },
    stages: [{ id: 'S1', name: '阶段一', goal: '目标', subtasks: [subtask] }],
  }
  const prompt = buildChildPrompt({
    plan,
    subtask,
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
  })
  assert.ok(
    /开工前/.test(prompt) && /预估/.test(prompt) && /send_message/.test(prompt),
    '待实现（O-2a/B1/2.6 表 #3）：buildChildPrompt 执行要求区需含「柔性时长协商协议」段——开工前 send_message(target:"lead") 报预估完成时长，新预估覆盖旧预估（方案 §2.3）',
  )
  assert.doesNotMatch(
    prompt,
    /必须.{0,8}(分钟|小时内)(完成|交付)|截止.{0,8}(点|时刻)|15 分钟\/步/,
    'B1：派发提示词不得出现固定完成承诺（时间是协商出来的安全兜底，不是固定交付期限）',
  )
})

/*
 * [2.2.0][T9b] 隔离测试：**显式 subtask.timeoutMs 优先于 estimateMinutes 派生值**。
 *
 * 回归依据：docs/dsh-workplan_全量回归与全链路验证_20261107.md「偏差/风险」节
 * (2) 的首要遗留风险——既有 O-3b/C3 用例只覆盖「无显式 timeoutMs 时的派生」
 * （1/240/10 三组），没有「显式值与派生值不同、且显式值赢」的隔离断言，
 * 消费序第 ① 步（src/runtime.ts resolveSubtaskTimeoutMs：explicit → derived →
 * CHILD_TIMEOUT_MS）一旦被回退成「派生优先」，现网测试不会变红。
 *
 * 断言点（全部通过既有公开出口验证，不改源码可见性）：
 *  - 用例 A：estimateMinutes: 10（派生 10×2.0×60000 = 1,200,000ms）＋显式
 *    timeoutMs: 2,500,000 → 运行中状态行 deadlineAt − startedAt 必须是
 *    **2,500,000**（显式优先），而非派生值 1,200,000；
 *  - 用例 B：显式 timeoutMs: 9,000,000（超 MAX_CHILD_TIMEOUT_MS=7,200,000）
 *    → 必须钳制为 **7,200,000**（显式值也要过同一钳制窗口，防止显式值绕过
 *    [MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS] 的单次绝对上限）。
 *
 * 计时口径与同文件 O-3b/C3 用例一致：不等待真实超时，dispatch 后立刻读状态行
 * 的 startedAt/deadlineAt（同一时钟读数派生），读完即放行假子会话收束。
 */

/**
 * 派发一条单子任务计划，读取运行中状态行的协商窗口长度，并返回收束函数。
 * 仅复用本文件既有构造手法（planWithSubtask/baseSubtask/makePlanMessage/
 * deferred/completed/waitFor），不触碰源码导出面。
 */
async function dispatchAndReadDeadline(subtask: any, sessionId: string) {
  const session: any = {
    id: sessionId,
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
  session.append('user/message', makePlanMessage(subtask))
  const gate = deferred()
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => ({ childId: 'child-timeout-priority', result: gate.promise, dispose: async () => {} }),
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    strictEvidence: false,
  })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  const snapshot: any = await runtime.statusTool({ session }, {})
  const row = (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  const offset = Number(row?.deadlineAt) - Number(row?.startedAt)
  return {
    row,
    offset,
    finish: async () => {
      gate.release(completed('完成'))
      return waitFor(
        () => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data)),
        10_000,
      )
    },
  }
}

test('[2.2.0][T9b] 显式 timeoutMs 优先于 estimateMinutes 派生值', async () => {
  const estimateMinutes = 10
  const derived = estimateMinutes * 2.0 * 60_000
  const explicit = 2_500_000
  assert.equal(derived, 1_200_000, '夹具前提：10 分钟派生值应为 1,200,000ms')
  assert.notEqual(explicit, derived, '夹具前提：显式值必须与派生值不同，才能证明优先级')
  const run = await dispatchAndReadDeadline(
    baseSubtask({ estimateMinutes, timeoutMs: explicit }),
    'session-timeout-explicit-wins',
  )
  assert.ok(
    Number.isFinite(run.offset),
    '运行中状态行应同时有 startedAt 与 deadlineAt（消费序断言的观测点）',
  )
  assert.equal(
    run.offset,
    explicit,
    `显式 subtask.timeoutMs 必须优先：协商窗口应为 ${explicit}ms，而不是 estimateMinutes=${estimateMinutes} 派生的 ${derived}ms`,
  )
  assert.ok(await run.finish(), '本轮应收束')
})

test('[2.2.0][T9b] 显式 timeoutMs 超 MAX 也要被钳制到 7,200,000', async () => {
  const explicit = 9_000_000
  assert.ok(explicit > MAX_CHILD_TIMEOUT_MS, `夹具前提：${explicit}ms 必须大于 MAX_CHILD_TIMEOUT_MS=${MAX_CHILD_TIMEOUT_MS}`)
  const run = await dispatchAndReadDeadline(
    baseSubtask({ estimateMinutes: 10, timeoutMs: explicit }),
    'session-timeout-explicit-clamped',
  )
  assert.ok(
    Number.isFinite(run.offset),
    '运行中状态行应同时有 startedAt 与 deadlineAt（钳制断言的观测点）',
  )
  assert.equal(
    run.offset,
    MAX_CHILD_TIMEOUT_MS,
    `显式 timeoutMs=${explicit}ms 超上限时必须钳制为 ${MAX_CHILD_TIMEOUT_MS}ms（显式值不得绕过 [${MIN_CHILD_TIMEOUT_MS}, ${MAX_CHILD_TIMEOUT_MS}] 窗口）`,
  )
  assert.ok(await run.finish(), '本轮应收束')
})
