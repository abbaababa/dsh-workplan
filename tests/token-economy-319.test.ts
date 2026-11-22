import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildPlanSummary,
  dependencyResultBrief,
  parseWorkplanMessage,
  PLAN_MARKER_BEGIN,
  PLAN_MARKER_END,
} from '../src/plan.js'
import { buildChildPrompt } from '../src/plan.js'
import { buildDelegateePrompt } from '../src/llm-rules.js'
import { fiveStepContinuationPromptLines, fiveStepPromptLines } from '../src/five-step.js'

/*
 * [3.1.9] token 经济的守门测试。
 *
 * 只钉住「结构性事实」，不钉具体文案措辞：
 *  - 计划消息的完整 plan 在 source.durable，可见文本只留紧凑骨架；
 *  - 依赖结果不再把上游证据块整段重复，兄弟简报不重复依赖项；
 *  - phase-1 接续只渲染第四/第五步，但关键字段与门禁仍在。
 */

function makePlan() {
  const subtasks = [
    {
      id: 'T1',
      title: '采集数据',
      department: 'data',
      role: '数据专家',
      objective: '产出已收盘日线数据表',
      method: ['读取数据源', '校验缺失值'],
      inputs: ['数据源'],
      outputs: ['daily.csv'],
      dependsOn: [],
      acceptance: ['A1 数据完整', 'A2 来源可追溯'],
      qualityRequirements: ['每列都有来源说明'],
      risk: '数据源不可达',
      estimateMinutes: 10,
      reasoningEffort: 'high',
    },
    {
      id: 'T2',
      title: '写报告',
      department: 'writing',
      role: '写作专家',
      objective: '产出报告正文',
      method: ['汇总数据', '撰写正文'],
      inputs: ['daily.csv'],
      outputs: ['report.md'],
      dependsOn: ['T1'],
      acceptance: ['A1 结论有证据'],
      qualityRequirements: ['小白能读懂'],
      risk: '结论夸大',
      estimateMinutes: 20,
      reasoningEffort: 'high',
    },
  ]
  return {
    version: 1,
    title: '测试计划',
    taskAnchor: { text: '请把数据整理成报告', sha256: 'a'.repeat(64) },
    taskUnderstanding: {
      originalRequest: '请把数据整理成报告',
      deliverable: '一份报告',
      successCriteria: ['结论可复核'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: { primary: { statement: '时间与质量', evidence: ['x'], whyPrimary: 'y' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', goal: '完成', rationale: 'r', checkpoint: 'c', subtasks }],
    risks: [{ risk: '风险', likelihood: 'low', impact: '小', mitigation: '规避', trigger: '信号' }],
    verification: [{ item: '验证', method: '检查', evidence: '文件' }],
    practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
    // 真实计划里这块可达 4.6KB；这里放一段足够大的审计内容，验证它不进可见文本。
    understandingAudit: { note: '审计'.repeat(1200) },
    normalizations: [],
    planId: 'wp-token-319',
    sessionId: 'session-token-319',
    createdTurn: 1,
    createdAt: 1000,
    sourceMessageIds: ['m1'],
  }
}

test('[3.1.9] 计划消息：完整 plan 进 durable，可见文本保持紧凑且可解析', () => {
  const plan = makePlan()
  const message = buildPlanMessage(plan)
  const text = message.content[0].text
  const durable = message.source?.durable

  assert.equal(message.source.kind, 'workplan')
  assert.equal(durable?.kind, 'workplan')
  assert.equal(durable?.plan?.planId, 'wp-token-319')
  assert.equal(durable?.plan?.stages?.[0]?.subtasks?.length, 2)
  assert.ok(durable?.plan?.understandingAudit, '完整审计字段必须留在 durable')
  assert.equal(text.includes(JSON.stringify(plan.understandingAudit)), false, '审计大块不得进入可见文本')
  assert.ok(text.length < 8000, `可见计划文本应保持紧凑，实际 ${text.length}`)
  assert.ok(text.includes(PLAN_MARKER_BEGIN) && text.includes(PLAN_MARKER_END), '保留定位 marker')
  assert.ok(text.includes('请把数据整理成报告'), '用户任务锚点必须仍然可见')

  const parsed = parseWorkplanMessage(message)
  assert.equal(parsed?.planId, 'wp-token-319')
  assert.equal(parsed?.plan?.stages?.[0]?.subtasks?.length, 2)
  assert.equal(parsed?.plan?.stages?.[0]?.subtasks?.[1]?.dependsOn?.[0], 'T1')
})

test('[3.1.9] 旧消息兼容：没有 durable 时仍从可见文本 marker 解析', () => {
  const plan = makePlan()
  const legacy = {
    role: 'user',
    content: [{ type: 'text', text: `${PLAN_MARKER_BEGIN}\n${JSON.stringify({ kind: 'workplan', version: 1, planId: plan.planId, sessionId: plan.sessionId, plan })}\n${PLAN_MARKER_END}` }],
    source: { kind: 'workplan', form: 'notice', summary: buildPlanSummary(plan) },
  }
  const parsed = parseWorkplanMessage(legacy)
  assert.equal(parsed?.planId, 'wp-token-319')
  assert.equal(parsed?.plan?.stages?.length, 1)
})

test('[3.1.9] 依赖结果：去掉证据块并压到 1200 字；兄弟简报不重复依赖项', () => {
  const plan = makePlan()
  const longSummary = '关键结论'.repeat(500) + '\n<!-- WORKPLAN_EVIDENCE:START -->\n{"status":"done"}\n<!-- WORKPLAN_EVIDENCE:END -->'
  const brief = dependencyResultBrief(longSummary)
  assert.ok(brief.length <= 1200, `依赖摘要应 <=1200，实际 ${brief.length}`)
  assert.equal(brief.includes('WORKPLAN_EVIDENCE'), false, '证据块不得进入依赖摘要')

  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[1],
    stage: plan.stages[0],
    dependencyResults: [{ id: 'T1', title: '采集数据', status: 'blocked', error: '数据源不可达', summary: longSummary, artifacts: ['daily.csv'] }],
    cwd: '/tmp',
    conversationContext: '',
    statuses: [
      { subtaskId: 'T1', status: 'done', summary: longSummary },
      { subtaskId: 'T2', status: 'pending', summary: '' },
    ],
  })
  assert.equal(prompt.includes('WORKPLAN_EVIDENCE:START'), true, '结果块模板仍必须保留')
  assert.ok(prompt.length < 20000, `任务书不应被上游长文撑爆，实际 ${prompt.length}`)
  assert.ok(prompt.includes('依赖项已在上方单列'), '排除依赖后仍保留兄弟简报标题与说明')
  assert.ok(prompt.includes('原因：数据源不可达'), '依赖被排除出兄弟简报后，失败原因仍必须随依赖块送达')
  assert.equal(prompt.includes(longSummary), false, '上游长文不得整段重复')
})

test('[3.1.9] phase-1 接续五步：只讲第四/第五步，但关键门禁与字段仍在', () => {
  const full = fiveStepPromptLines().join('\n')
  const short = fiveStepContinuationPromptLines().join('\n')
  assert.ok(short.length < full.length * 0.6, `接续版应显著短于完整版：${short.length} vs ${full.length}`)
  for (const key of ['五步工作法', '第四步', '第五步', 'phases.planning', 'phases.preparation', 'approachBasis', 'WORKPLAN_EVIDENCE:START', 'verify', 'START_EVIDENCE']) {
    assert.ok(short.includes(key), `接续版缺关键串：${key}`)
  }
  assert.equal(short.includes('第一步 · 任务梳理'), false, '接续版不再重讲第一步全文')
})

test('[3.1.9] 超长计划不截掉任务：15 项全部出现在可见骨架里', () => {
  const plan = makePlan()
  const subtasks = Array.from({ length: 15 }, (_, index) => ({
    id: `T${index + 1}`,
    title: `任务 ${index + 1} ${'标题'.repeat(20)}`,
    department: 'engineering',
    role: '专家',
    objective: `目标 ${'描述'.repeat(80)}`,
    method: ['步骤'],
    inputs: ['输入'],
    outputs: ['产物'],
    dependsOn: index === 0 ? [] : [`T${index}`],
    acceptance: [`验收一 ${'标准'.repeat(80)}`, `验收二 ${'标准'.repeat(80)}`],
    qualityRequirements: [`质量 ${'要求'.repeat(80)}`],
    risk: '风险',
    estimateMinutes: 10,
    reasoningEffort: 'high',
  }))
  plan.stages = [{ id: 'S1', name: '实施', goal: '完成', rationale: 'r', checkpoint: 'c', subtasks }]
  const message = buildPlanMessage(plan)
  const text = message.content[0].text
  assert.ok(text.length <= 8000, `可见计划文本应受控，实际 ${text.length}`)
  for (let index = 1; index <= 15; index += 1) {
    assert.ok(text.includes(`T${index} `), `第 ${index} 个子任务不得被截掉`)
  }
  assert.ok(text.includes('全部子任务索引'), '超长时应退化为完整索引')
  assert.equal(message.source?.durable?.plan?.stages?.[0]?.subtasks?.length, 15, 'durable 仍保留完整计划')
})

test('[3.1.9] 专家接续任务书显著短于完整任务书，且关键串不丢', () => {
  const input = {
    departmentLabel: '工程',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '部门任务',
    member: { member: 'X', role: 'expert' as const, task: '单项工作', effort: 'high', qualityRequirements: ['必须给出命令输出'] },
    rulesBrief: '规则简报',
    cwd: '/tmp',
  }
  const full = buildDelegateePrompt(input)
  const short = buildDelegateePrompt({ ...input, continuation: true })
  assert.ok(short.length < full.length * 0.85, `接续任务书应更短：${short.length} vs ${full.length}`)
  assert.ok(short.includes('五步工作法'))
  assert.ok(short.includes('第四步'))
  assert.ok(short.includes('approachBasis'))
})
