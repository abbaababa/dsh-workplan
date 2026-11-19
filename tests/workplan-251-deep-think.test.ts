/*
 * [3.0.8] 五步工作法单框架（用户 2026-11-18 收口）底层机制回归。
 *
 * 历史口径：2.5.1 的「两轮深度思考」协议已并入五步工作法第 1/2 步，独立的
 * deepThink 开工门禁废除。本文件锁五件事：
 *  1. 三层执行者（部门负责人 / 全球顶尖专家）的任务书都注入同一份五步工作法
 *     协议：第一步任务梳理 → 第二步资源/工具/实施方案研究（含依据 approachBasis）
 *     → 第三步准备 → 第四步执行与验证 → 第五步 JSON 交付；
 *  2. 第二步依据 approachBasis 仍是结算门禁的必填结构化证据：缺失/太薄 ⇒
 *     规划阶段判未完成（PHASE_GATE），不得记 done；
 *  3. 负责人再分配硬门禁（planDelegations）3.0.8 口径：consolidation 只留分工表
 *     assignments 与整体等级 taskReasoningEffort，不再校验 40/40/20 两轮产物
 *     （改由 review 的 startPhases 开工闸同一判据校验）；拒因顺序不变；
 *  4. consolidation 消毒落档 + durable workplan-update 回放，刷新/重启不丢；
 *  5. 契约版本 FIVE_STEP_CONTRACT_VERSION = 4，摘要可读（五步工作法）。
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
  FIVE_STEP_CONTRACT_VERSION,
  phaseGateFromErrors,
  phaseSummaryLine,
  fiveStepPromptLines,
  validateFiveStepEvidence,
} from '../src/five-step.js'

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
      resources: ['现有代码库与只读权限：本任务所需源文件、测试与运行环境均已确认可用', '任务数据与验收标准：来自计划行，已核对'],
      tools: ['TypeScript 编译与 node 测试运行器：用于改码后自检', '文件读写与命令执行工具：用于执行与留证'],
    },
    preparation: {
      prepared: ['源文件、测试环境与验收标准均已就位：工作目录可读写，依赖已安装'],
      evidence: ['ls 与 node -v 输出正常；测试运行器可启动'],
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
    title: '五步工作法回归',
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
        // 夹具适配：本文件测结算/分工表闸，不测低档禁派；任务行声明 high 放行第三层判定链。
        reasoningEffort: 'high',
      }],
    }],
  }
}

/**
 * [3.0.8] consolidation 只留分工表与整体等级配置：{ assignments[], taskReasoningEffort? }。
 * 第 1/2/3 步证据（problemAnalysis/approach/approachBasis 等）改由 review 的
 * startPhases 开工闸承载，不再随 consolidation 提交与校验。
 */
function consolidation(overrides: any = {}) {
  return {
    assignments: [
      { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', reasoningEffort: 'xhigh', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
      { member: 'Member-B', role: 'expert', task: '补充核心路径回归用例', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    ],
    ...overrides,
  }
}

/* ---------- 1. 协议文案：三层同一口径 ---------- */

test('协议文案：五步工作法的顺序、依赖与用户原文口径', () => {
  const text = fiveStepPromptLines().join('\n')
  assert.match(text, /先全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(text, /基于第一步完成好的所有结果，再全面、全盘、深入地梳理、研究、思考/)
  assert.match(text, /以最高效率执行、确保完美完成自己任务的方法、流程和步骤/)
  assert.match(text, /基于第三步备齐的成果和既定实施方案，开始具体执行/)
  assert.match(text, /approachBasis/)
  assert.match(text, /五步工作法/)
  assert.doesNotMatch(text, /两轮深度思考/, '3.0.8 起两轮深度思考协议已并入五步，文案不得再出现')
  const first = text.indexOf('【第一步 · 任务梳理')
  const second = text.indexOf('【第二步 · 资源、工具与实施方案研究')
  const third = text.indexOf('【第三步 · 准备')
  const fourth = text.indexOf('【第四步 · 执行与验证')
  const fifth = text.indexOf('【第五步 · JSON mode')
  assert.ok(first >= 0 && first < second && second < third && third < fourth && fourth < fifth, '五步顺序不可颠倒')
})

test('部门负责人任务书（二级）注入五步协议与执行要求', () => {
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
  assert.match(prompt, /五步工作法/)
  assert.match(prompt, /先全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(prompt, /approachBasis/)
  assert.match(prompt, /前三步证据经 review 的 startPhases 一并提交并登记，未登记合格证据前禁止进入执行与再分配/)
  assert.doesNotMatch(prompt, /两轮深度思考/)
})

test('专家任务书（三级）注入五步工作法协议——仅专家口径', () => {
  const rulesBrief = buildLlmRulesBrief({ model: 'qwen3.8-flash', effort: 'xhigh', tier: 'delegate', memberName: 'X', memberRole: 'expert' })
  const prompt = buildDelegateePrompt({
    departmentLabel: '工程',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '部门任务',
    member: { member: 'X', role: 'expert', task: '单项工作', effort: 'xhigh', qualityRequirements: ['必须给出命令输出'] },
    rulesBrief,
    cwd: '/tmp',
  })
  assert.match(prompt, /五步工作法/, '专家任务书必须含五步协议')
  assert.match(prompt, /先全面、全盘、深入梳理、研究、思考自己的任务/, '专家第一步口径')
  assert.match(prompt, /基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案/, '专家第二步依赖口径')
  assert.match(prompt, /方法、流程、步骤/, '专家第二步产物口径')
  assert.match(prompt, /approachBasis/, '依据字段告知')
  assert.match(prompt, /startPhases/, '开工证据提交方式告知')
  assert.doesNotMatch(prompt, /两轮深度思考/)
})

test('buildLlmRulesBrief：负责人 tier 与专家 tier 都携带五步协议', () => {
  const head = buildLlmRulesBrief({ model: 'qwen3.8-flash', tier: 'department' })
  assert.match(head, /执行自己的任务必须先完成五步前三步/)
  assert.match(head, /startPhases/)
  assert.match(head, /approachBasis/)
  const leaf = buildLlmRulesBrief({ model: 'qwen3.8-flash', tier: 'delegate', memberRole: 'expert' })
  assert.match(leaf, /执行自己的任务必须遵守五步工作法的前三步/)
  assert.match(leaf, /startPhases/)
})

/* ---------- 2. 结算门禁：approachBasis 必填 ---------- */

test('契约版本 4：五步产物齐全 ⇒ ok，摘要可读', () => {
  assert.equal(FIVE_STEP_CONTRACT_VERSION, 4)
  const check = validateFiveStepEvidence(phases(), ['有单测证据'])
  assert.equal(check.ok, true, JSON.stringify(check.errors))
  assert.equal(check.phases!.version, 4)
  assert.deepEqual(check.phases!.planning.approachBasis, [BASIS])
  assert.match(phaseSummaryLine(check.phases!), /第二步 资源\/工具\/方案研究/)
  assert.match(phaseSummaryLine(check.phases!), /依据 1 条/)
})

test('缺 approachBasis ⇒ 规划阶段未完成（PHASE_GATE），不得记 done', () => {
  const input: any = phases()
  delete input.planning.approachBasis
  const check = validateFiveStepEvidence(input)
  assert.equal(check.ok, false)
  assert.equal(check.failedPhase, 'planning')
  assert.match(check.errors.join('；'), /approachBasis/)
  assert.equal(phaseGateFromErrors(check.errors), 'steps-1-3')
})

test('approachBasis 太薄（一句空话冒充依赖对应）⇒ 规划阶段未完成', () => {
  const input: any = phases()
  input.planning.approachBasis = ['基于第一轮']
  assert.ok('基于第一轮'.length < MIN_PLANNING_BASIS_CHARS)
  const check = validateFiveStepEvidence(input)
  assert.equal(check.ok, false)
  assert.equal(check.failedPhase, 'planning')
  assert.match(check.errors.join('；'), /approachBasis 太薄/)
})

test('approachBasis 非数组 ⇒ 明确拒因', () => {
  const input: any = phases()
  input.planning.approachBasis = '一段文字'
  const check = validateFiveStepEvidence(input)
  assert.equal(check.ok, false)
  assert.match(check.errors.join('；'), /approachBasis 必须是数组/)
})

/* ---------- 3. 负责人再分配硬门禁（3.0.8 consolidation 口径） ---------- */

/*
 * 夹具适配：以下单元用例验证分工表闸，不测「low 禁派」；按判定链
 * 给任务行补 taskRowEffort='high' 放行第三层判定，复杂档判定不受影响。
 */
const pd = (args: any) => planDelegations({ taskRowEffort: 'high', ...args })

test('未提交 consolidation ⇒ DELEGATE_CONSOLIDATION_MISSING（分工表硬门禁仍在）', () => {
  const result = pd({})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_MISSING')
  assert.match(result.error!, /分工表/)
})

test('consolidation 缺 assignments ⇒ DELEGATE_CONSOLIDATION_INCOMPLETE', () => {
  const result = pd({ consolidation: {} })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(result.error!, /assignments/)
})

/*
 * [3.0.8 收口] 原断言「缺 approach ⇒ DELEGATE_CONSOLIDATION_INCOMPLETE」与
 * 「缺 approachBasis ⇒ DELEGATE_CONSOLIDATION_INCOMPLETE」随两轮产物闸一并废除：
 * planDelegations 不再读取 problemAnalysis/approach/approachBasis（40/40/20 判据
 * 改由 review 的 startPhases 开工闸执行）。等价值回归 = 携带/缺失这些旧字段都
 * 不再影响分工表闸，且 consolidation 返回值只含 {assignments, taskReasoningEffort}。
 */
test('3.0.8 收口：consolidation 的旧两轮产物字段不再被校验或随结果返回', () => {
  const legacyFields = {
    problemAnalysis: ['现状：部门任务需要拆给专家与组员；目标是保质保量完成；约束是不改无关文件；主要矛盾是质量与时间。'],
    constraints: ['不得改动无关文件'],
    unknowns: [],
    approach: [],
    approachBasis: [],
  }
  const withLegacy = pd({ consolidation: { ...legacyFields, ...consolidation() }, model: 'qwen3.8-flash' })
  assert.equal(withLegacy.ok, true, JSON.stringify(withLegacy))
  const withoutLegacy = pd({ consolidation: consolidation(), model: 'qwen3.8-flash' })
  assert.equal(withoutLegacy.ok, true, JSON.stringify(withoutLegacy))
  assert.deepEqual(withoutLegacy.consolidation, { assignments: 2, taskReasoningEffort: null })
  assert.ok(!('approachBasis' in withLegacy.consolidation!), '旧字段不得随 consolidation 返回')
  assert.ok(!('problemAnalysis' in withLegacy.consolidation!), '旧字段不得随 consolidation 返回')
})

test('拒因顺序（3.0.8 口径）不变：未提交分工表 → 空 assignments → 分工表行不完整', () => {
  // 1) 连 consolidation 都没有 ⇒ 最先拒：分工表缺失。
  const missing = pd({})
  assert.equal(missing.code, 'DELEGATE_CONSOLIDATION_MISSING')
  // 2) consolidation 存在但 assignments 为空 ⇒ 分工表不完整（先于行级校验）。
  const emptyAssignments = pd({ consolidation: {} })
  assert.equal(emptyAssignments.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(emptyAssignments.error!, /assignments/)
  // 3) assignments 非空但行字段缺失（member 为空）⇒ 行级校验拒因。
  const brokenRow = pd({
    consolidation: { assignments: [{ member: '', role: 'expert', task: '读取目标文件得出一份结论', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }] },
    model: 'qwen3.8-flash',
  })
  assert.equal(brokenRow.code, 'DELEGATE_ASSIGNMENT_INVALID')
})

/* ---------- 4. 持久化与回放 ---------- */

/*
 * [3.0.8 收口] 原断言「approachBasis 随 consolidation 消毒落档 + 回放不丢」废除：
 * consolidation 只留分工表与等级配置（applyStatus 白名单落档，旧梳理字段被丢弃）。
 * 等价值回归 = 分工表 assignments 经消毒落档 + durable workplan-update 回放不丢，
 * 且旧两轮产物字段不落档。
 */
test('分工表（assignments）随 consolidation 消毒落档 + durable workplan-update 回放不丢', () => {
  const plan: any = makePlan()
  const statuses = createStatuses(plan)
  const submitted = consolidation()
  const patched = applyStatus(statuses, 'T1', { consolidation: { ...submitted, approachBasis: ['不应落档'], problemAnalysis: ['不应落档'] } })
  assert.equal(patched[0].consolidation.assignments.length, 2)
  assert.equal(patched[0].consolidation.assignments[0].member, 'Expert-A')
  assert.equal(patched[0].consolidation.assignments[0].role, 'expert')
  assert.deepEqual(patched[0].consolidation.assignments[0].qualityRequirements, ['必须给出可复核的命令输出或文件证据'])
  assert.equal(patched[0].consolidation.assignments[0].reasoningEffort, 'xhigh')
  assert.equal(typeof patched[0].consolidation.submittedAt, 'number')
  assert.ok(!('approachBasis' in patched[0].consolidation), '3.0.8 起旧两轮产物字段不得随 consolidation 落档')
  assert.ok(!('problemAnalysis' in patched[0].consolidation), '3.0.8 起旧两轮产物字段不得随 consolidation 落档')

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
    consolidation: submitted,
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.equal(rebuilt.statuses[0].consolidation.assignments.length, 2, '刷新/重启回放后分工表仍在')
  assert.deepEqual(
    rebuilt.statuses[0].consolidation.assignments.map((item: any) => item.member),
    ['Expert-A', 'Member-B'],
  )
})
