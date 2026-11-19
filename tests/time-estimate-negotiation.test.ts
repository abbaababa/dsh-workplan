/*
 * 执行预估契约 —— 预估原样保留、旧 timeoutMs 只读、绝不派生执行截止。
 *
 * 新契约：
 *  - estimateMinutes 仍限 1–240 整数，仅防离谱输入，不再被钳成 1–15；
 *  - 旧计划 timeoutMs 可解析/回放，但不得转成 deadlineAt、timer 或 watchdog；
 *  - 负责人/专家状态行固定 executionTimeLimit='none'、deadlineAt=null，
 *    无论 estimateMinutes 或旧 timeoutMs 取什么值；
 *  - 派发提示词要求开工前报预估（仅协调信息），明确无执行硬截止、预估不影响验收。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildChildPrompt, validatePlan } from '../src/plan.js'
import { buildPlanMessage } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

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

test('无时限：estimateMinutes=1/10/240 均不派生 deadlineAt 或计时器', async () => {
  const samples = [
    { label: '最小预估 1 分钟', estimateMinutes: 1 },
    { label: '中间值 10 分钟', estimateMinutes: 10 },
    { label: '最大预估 240 分钟', estimateMinutes: 240 },
  ]
  for (const sample of samples) {
    const run = await dispatchAndReadStatus(
      baseSubtask({ estimateMinutes: sample.estimateMinutes }),
      `session-no-deadline-${sample.estimateMinutes}`,
    )
    assert.equal(run.row?.status, 'in_progress', `${sample.label}：应进入执行态`)
    assert.equal(run.row?.executionTimeLimit, 'none', `${sample.label}：状态行必须声明无执行时限`)
    assert.equal(run.row?.deadlineAt, null, `${sample.label}：预估不得派生 deadlineAt`)
    assert.equal(run.row?.deadlineRemainingMs, null, `${sample.label}：不得显示剩余倒计时`)
    assert.equal(run.row?.legacyDeadlineAt, null, `${sample.label}：本例无历史截止`)
    assert.ok(await run.finish(), `${sample.label}：显式完成后本轮应收束`)
  }
})

test('B1/O-2a：派发提示词要求报预估，但明确无时限、预估不影响验收', () => {
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
  assert.match(prompt, /开工前/, '保留开工前预估上报')
  assert.match(prompt, /预估/, '保留预估信息登记')
  assert.match(prompt, /send_message/, '保留 send_message 上报通道')
  assert.match(prompt, /执行时间与进度沟通/, '提示词明确执行时间沟通段')
  assert.match(prompt, /无执行硬截止/, '明确平台不设硬截止')
  assert.match(prompt, /预估仅供参考/, '预估仅为协调信息，不是承诺')
  assert.match(prompt, /不影响验收/, '预估与实际耗时不影响完成验收')
  assert.doesNotMatch(
    prompt,
    /二次接手|协商上限|必须在[^\n。]{0,12}分钟内(?:完成|交付)/,
    '不得残留二次接手、协商上限或按分钟完成话术',
  )
  assert.match(prompt, /extendMs 已停用/, '旧延期字段被明确标注停用，而非隐藏')
})

/*
 * 旧计划 timeoutMs 的只读兼容：字段仍可解析，但不得参与任何截止计算。
 * 这是“旧配置不再复活计时器”的端到端观测。
 */
async function dispatchAndReadStatus(subtask: any, sessionId: string) {
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
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        started = true
        return { childId: 'child-no-deadline', result: gate.promise, dispose: async () => {} }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    strictEvidence: false,
  })
  const dispatchP = runtime.dispatchTool(
    { session, options: {} },
    { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' },
    new AbortController().signal,
  )
  assert.ok(await waitFor(() => started), 'T1 应已派发')
  let row: any
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    const snapshot: any = await runtime.statusTool({ session }, {})
    row = (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
    if (row?.startedAt) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return {
    row,
    finish: async () => {
      gate.release(completed('完成'))
      await dispatchP
      await new Promise((resolve) => setTimeout(resolve, 20))
      return true
    },
  }
}

test('旧 timeoutMs 在 2.5M/9M 下都不生成 deadlineAt', async () => {
  for (const sample of [
    { explicit: 2_500_000, id: 'session-timeout-explicit-wins' },
    { explicit: 9_000_000, id: 'session-timeout-explicit-clamped' },
  ]) {
    const run = await dispatchAndReadStatus(
      baseSubtask({ estimateMinutes: 10, timeoutMs: sample.explicit }),
      sample.id,
    )
    assert.equal(run.row?.status, 'in_progress', `timeoutMs=${sample.explicit} 旧字段不应阻止进入执行`)
    assert.equal(run.row?.deadlineAt, null, `timeoutMs=${sample.explicit} 不得重新武装 deadlineAt`)
    assert.equal(run.row?.deadlineRemainingMs, null, `timeoutMs=${sample.explicit} 不得显示倒计时`)
    assert.equal(run.row?.executionTimeLimit, 'none', `timeoutMs=${sample.explicit} 下仍声明无时限`)
    assert.equal(run.row?.legacyDeadlineAt, null, '新行没有历史截止')
    assert.ok(await run.finish(), '显式完成真实收束本轮')
  }
})
