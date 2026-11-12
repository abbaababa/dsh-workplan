/*
 * [2.5.1] 两轮深度思考协议（用户 2026-11-11 强制要求）底层机制回归。
 *
 * 锁五件事：
 *  1. 三层执行者（部门负责人 / 全球顶尖专家 / 组员）的任务书都注入同一份
 *     两轮深度思考协议：先全面、全盘、深入梳理、研究、思考自己的任务 →
 *     基于第一轮完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，
 *     理清方法、流程和步骤 → 最后基于第二轮的方法、流程、步骤开始执行；
 *  2. 第二轮依据 approachBasis 是结算门禁的必填结构化证据：缺失/太薄 ⇒
 *     规划阶段判未完成（PHASE_GATE），不得记 done；
 *  3. 负责人再分配硬门禁同口径：approach + approachBasis 各至少 1 条，
 *     缺一 DELEGATE_CONSOLIDATION_INCOMPLETE；旧拒因顺序不变；
 *  4. approachBasis 随 consolidation 消毒落档 + durable workplan-update
 *     回放，刷新/重启不丢；
 *  5. 契约版本 THREE_PHASE_VERSION = 2，摘要可读（两轮深度思考）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStatus,
  buildChildPrompt,
  buildPlanMessage,
  buildUpdateMessage,
  createStatuses,
} from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'
import { buildDelegateePrompt, buildLlmRulesBrief, planDelegations } from '../src/llm-rules.js'
import {
  MIN_PLANNING_BASIS_CHARS,
  THREE_PHASE_VERSION,
  phaseGateFromErrors,
  phaseSummaryLine,
  threePhasePromptLines,
  validatePhaseEvidence,
} from '../src/three-phase.js'

const BASIS = '第二轮的方法、流程、步骤基于第一轮完成好的全部结果：现状与主要矛盾决定先确认入口再最小改动，约束决定不改无关文件，验收标准决定每一步的留证方式。'

function phases(overrides: any = {}) {
  return {
    planning: {
      problemAnalysis: [
        '现状：现有接口没有幂等保护，重复提交会写两条记录；约束：不能改数据库结构；未知：上游是否会重试；主要矛盾：兼容旧调用方与修复重复写入。',
      ],
      constraints: ['不能改数据库结构'],
      unknowns: ['上游是否会自动重试'],
      approach: [
        '先读现有写入路径确认入口 → 在入口加幂等键校验 → 用同一请求连发两次 → 核对只写一条记录 → 对照验收标准逐条留证。',
      ],
      approachBasis: [BASIS],
    },
    execution: { steps: ['读写入路径', '加幂等校验', '连发两次并核对记录数'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: 'A1', method: '同一请求连发两次', evidence: '数据库只有 1 条记录' }],
      requirementCheck: '用户原要求逐条核对：幂等、兼容旧调用方，均覆盖。',
      retrospective: {
        problems: ['第一次只在应用层去重，仍被并发写穿；根因是没加数据库唯一约束。'],
        detours: [],
        resolutions: ['改为在入口做幂等键校验 + 唯一索引兜底，连发两次验证只写一条。'],
        prevention: ['遇到幂等需求，先确认存储层唯一约束，再谈应用层校验。'],
      },
    },
    ...overrides,
  }
}

function makePlan() {
  return {
    planId: 'wp-251-deep-think',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: '两轮深度思考回归',
    taskUnderstanding: { originalRequest: '优化插件底层机制', deliverable: '补丁' },
    contradictions: { primary: { statement: '质量与时间' } },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '改造',
      subtasks: [{
        id: 'T1', title: '部门任务', department: 'engineering', role: '资深架构师',
        objective: '完成机制改造', method: ['改代码'], inputs: [], outputs: ['补丁'],
        acceptance: ['有单测证据'], risk: '无', dependsOn: [],
      }],
    }],
  }
}

function consolidation(overrides: any = {}) {
  return {
    problemAnalysis: ['现状：部门任务需要拆给专家与组员', '主要矛盾：质量与时间'],
    constraints: ['不得改动无关文件'],
    unknowns: [],
    approach: ['专家做核心实现', '组员做自测'],
    approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮全部梳理结果：质量与时间矛盾决定专家做核心实现、组员做自测。'],
    assignments: [
      { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'xhigh' },
      { member: 'Member-B', role: 'member', task: '补充回归用例', reasoningEffort: 'low' },
    ],
    ...overrides,
  }
}

/* ---------- 1. 协议文案：三层同一口径 ---------- */

test('协议文案：两轮深度思考的顺序、依赖与用户原文口径', () => {
  const text = threePhasePromptLines().join('\n')
  assert.match(text, /第一轮 · 任务深研：先全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(text, /基于刚才第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考/)
  assert.match(text, /理清自己该具体如何一步步以最高效率执行、确保完美完成自己任务的方法、流程和步骤/)
  assert.match(text, /最后，基于刚才第二轮理清楚的所有方法、流程、步骤，开始具体的执行工作/)
  assert.match(text, /approachBasis/)
  assert.match(text, /禁止动手执行/)
  const first = text.indexOf('第一轮 · 任务深研')
  const second = text.indexOf('第二轮 · 理清方法流程步骤')
  const exec = text.indexOf('【阶段二 · 执行阶段】')
  assert.ok(first >= 0 && first < second && second < exec, '第一轮 → 第二轮 → 执行的顺序不可颠倒')
})

test('部门负责人任务书（二级）注入两轮深度思考协议与执行要求', () => {
  const plan: any = makePlan()
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
    statuses: createStatuses(plan),
  })
  assert.match(prompt, /两轮深度思考/)
  assert.match(prompt, /先全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(prompt, /approachBasis/)
  assert.match(prompt, /最后才基于第二轮的方法、流程、步骤开始具体执行与再分配/)
})

test('专家/组员任务书（三级）注入两轮深度思考协议——两种角色同一口径', () => {
  for (const role of ['expert', 'member'] as const) {
    const rulesBrief = buildLlmRulesBrief({ model: 'qwen3.8-flash', effort: 'xhigh', tier: 'delegate', memberName: 'X', memberRole: role })
    const prompt = buildDelegateePrompt({
      departmentLabel: '工程',
      leaderSubtaskId: 'T1',
      leaderSubtaskTitle: '部门任务',
      member: { member: 'X', role, task: '单项工作', effort: 'xhigh' },
      rulesBrief,
      cwd: '/tmp',
    })
    assert.match(prompt, /两轮深度思考/, `${role} 任务书必须含协议`)
    assert.match(prompt, /先全面、全盘、深入梳理、研究、思考自己的任务/, `${role} 第一轮口径`)
    assert.match(prompt, /基于刚才前一步完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考/, `${role} 第二轮依赖口径`)
    assert.match(prompt, /方法、流程和步骤/, `${role} 第二轮产物口径`)
    assert.match(prompt, /approachBasis/, `${role} 依据字段告知`)
  }
})

test('buildLlmRulesBrief：负责人 tier 与专家/组员 tier 都携带协议', () => {
  const head = buildLlmRulesBrief({ model: 'qwen3.8-flash', tier: 'department' })
  assert.match(head, /执行自己的任务必须先走两轮深度思考/)
  assert.match(head, /problemAnalysis=第一轮任务深研/)
  assert.match(head, /approachBasis=第二轮基于第一轮全部结果的依据对应/)
  const leaf = buildLlmRulesBrief({ model: 'qwen3.8-flash', tier: 'delegate', memberRole: 'expert' })
  assert.match(leaf, /执行自己的任务必须先走两轮深度思考/)
})

/* ---------- 2. 结算门禁：approachBasis 必填 ---------- */

test('契约版本 2：两轮产物齐全 ⇒ ok，摘要可读', () => {
  assert.equal(THREE_PHASE_VERSION, 2)
  const check = validatePhaseEvidence(phases(), ['有单测证据'])
  assert.equal(check.ok, true, JSON.stringify(check.errors))
  assert.equal(check.phases!.version, 2)
  assert.deepEqual(check.phases!.planning.approachBasis, [BASIS])
  assert.match(phaseSummaryLine(check.phases!), /两轮深度思考/)
  assert.match(phaseSummaryLine(check.phases!), /第二轮依据 1 条/)
})

test('缺 approachBasis ⇒ 规划阶段未完成（PHASE_GATE），不得记 done', () => {
  const input: any = phases()
  delete input.planning.approachBasis
  const check = validatePhaseEvidence(input)
  assert.equal(check.ok, false)
  assert.equal(check.failedPhase, 'planning')
  assert.match(check.errors.join('；'), /approachBasis/)
  assert.equal(phaseGateFromErrors(check.errors), 'phase-1-2')
})

test('approachBasis 太薄（一句空话冒充依赖对应）⇒ 规划阶段未完成', () => {
  const input: any = phases()
  input.planning.approachBasis = ['基于第一轮']
  assert.ok('基于第一轮'.length < MIN_PLANNING_BASIS_CHARS)
  const check = validatePhaseEvidence(input)
  assert.equal(check.ok, false)
  assert.equal(check.failedPhase, 'planning')
  assert.match(check.errors.join('；'), /approachBasis 太薄/)
})

test('approachBasis 非数组 ⇒ 明确拒因', () => {
  const input: any = phases()
  input.planning.approachBasis = '一段文字'
  const check = validatePhaseEvidence(input)
  assert.equal(check.ok, false)
  assert.match(check.errors.join('；'), /approachBasis 必须是数组/)
})

/* ---------- 3. 负责人再分配硬门禁同口径 ---------- */

test('缺第二轮方法流程步骤（approach）⇒ DELEGATE_CONSOLIDATION_INCOMPLETE', () => {
  const result = planDelegations({ consolidation: consolidation({ approach: [] }), model: 'qwen3.8-flash' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(result.error!, /第二轮/)
  assert.match(result.error!, /方法、流程和步骤/)
})

test('有第二轮但缺依据（approachBasis）⇒ DELEGATE_CONSOLIDATION_INCOMPLETE', () => {
  const result = planDelegations({ consolidation: consolidation({ approachBasis: [] }), model: 'qwen3.8-flash' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(result.error!, /approachBasis/)
  assert.match(result.error!, /基于第一轮完成好的所有结果/)
})

test('两轮产物齐全 ⇒ 放行，approachBasis 随梳理产物返回', () => {
  const result = planDelegations({ consolidation: consolidation(), model: 'qwen3.8-flash' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.consolidation!.approachBasis.length, 1)
  assert.match(result.consolidation!.approachBasis[0], /基于第一轮/)
})

test('旧拒因顺序不变：problemAnalysis → assignments → 角色配比 先于两轮产物闸', () => {
  const noAnalysis = planDelegations({ consolidation: { assignments: consolidation().assignments }, model: 'qwen3.8-flash' })
  assert.match(noAnalysis.error!, /problemAnalysis/)
  const noAssignments = planDelegations({ consolidation: { problemAnalysis: ['梳理'] }, model: 'qwen3.8-flash' })
  assert.match(noAssignments.error!, /assignments/)
  const expertOnly = planDelegations({
    consolidation: { problemAnalysis: ['梳理'], assignments: [{ member: 'A', role: 'expert', task: 't', reasoningEffort: 'low' }] },
    model: 'qwen3.8-flash',
  })
  assert.equal(expertOnly.code, 'DELEGATE_ROLE_MIX_REQUIRED')
})

/* ---------- 4. 持久化与回放 ---------- */

test('approachBasis 随 consolidation 消毒落档 + durable workplan-update 回放不丢', () => {
  const plan: any = makePlan()
  const statuses = createStatuses(plan)
  const patched = applyStatus(statuses, 'T1', { consolidation: consolidation() })
  assert.deepEqual(patched[0].consolidation.approachBasis, consolidation().approachBasis)

  const events: any[] = []
  const session: any = {
    id: 'session-root',
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(t: string, d: any) { events.push({ type: t, data: d }); return d },
    eventAt: (n: number) => events[n],
    events,
  }
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId,
    subtaskId: 'T1',
    status: 'in_progress',
    revision: 2,
    consolidation: consolidation(),
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.deepEqual(rebuilt.statuses[0].consolidation.approachBasis, consolidation().approachBasis, '刷新/重启回放后第二轮依据仍在')
})