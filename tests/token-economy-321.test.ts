import test from 'node:test'
import assert from 'node:assert/strict'

import { adjudicateResult, buildChildPrompt, buildPlannerPrompt, MAX_ORIGINAL_REQUEST_CHARS, validatePlan } from '../src/plan.js'
import { createDelegateTool, createVerifyTool } from '../src/host.js'

/*
 * [3.2.2][省钱] 结构性省钱回归：
 *  1) planner 不再被要求复述 originalRequest（平台从用户原文回填）；
 *  2) 无指代任务只保留最近 3000 字对话，有指代时仍给完整 7000 字；
 *  3) 真实派发已带 llmRulesBrief 时，子任务书不再重复同一份负责人授权段；
 *  4) 子 Agent 只写顶层 acceptance 时，平台用同一张表生成 verification.checks，
 *     不再要求模型把验收表写两遍。
 */

const BASIS = '第二轮的方法、流程、步骤基于第一轮完成好的全部结果：现状与主要矛盾决定先确认入口再最小改动，约束决定不改无关文件，验收标准决定每一步的留证方式。'

function phases() {
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
      requirementCheck: '用户原要求逐条核对：幂等、兼容旧调用方，均覆盖。',
      retrospective: {
        problems: ['第一次只在应用层去重，仍被并发写穿；根因是没加数据库唯一约束。'],
        detours: [],
        resolutions: ['改为在入口做幂等键校验 + 唯一索引兜底，连发两次验证只写一条。'],
        prevention: ['遇到幂等需求，先确认存储层唯一约束，再谈应用层校验。'],
      },
    },
  }
}

function planWithoutOriginalRequest() {
  return {
    version: 1,
    title: '省钱回归',
    taskUnderstanding: {
      deliverable: '一份结论',
      successCriteria: ['可复核'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '质量与成本', evidence: ['证据'], whyPrimary: '决定交付' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '完成',
      rationale: '需要',
      checkpoint: '复核',
      subtasks: [{
        id: 'T1',
        title: '单项工作',
        department: 'engineering',
        departmentRationale: '命中工程职责',
        role: '专家',
        objective: '完成单项工作',
        method: ['读取', '执行'],
        inputs: [],
        outputs: ['out.md'],
        dependsOn: [],
        qualityRequirements: ['有证据'],
        acceptance: ['可复核'],
        risk: '低',
        estimateMinutes: 10,
        reasoningEffort: 'medium',
      }],
    }],
    risks: [],
    verification: [{ item: '复核', method: '抽查', evidence: '命令输出' }],
    practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
  }
}

test('[3.2.2] planner 可省略 originalRequest，平台回填后审计仍成立', () => {
  const result = validatePlan(planWithoutOriginalRequest())
  assert.equal(result.ok, true, result.ok ? '' : (result.errors ?? []).join('；'))
  assert.equal(result.plan!.taskUnderstanding.originalRequest, '', '缺失在 wire 层合法，由 runtime 回填')
})

test('[3.2.2] 无指代任务只带最近 3000 字对话；有指代任务保留完整背景', () => {
  const context = 'HEAD-MARKER ' + 'x'.repeat(5000) + ' TAIL-MARKER'
  const selfContained = buildPlannerPrompt('整理一份已有清单', '/tmp', context, {})
  assert.ok(!selfContained.includes('HEAD-MARKER'), '无指代时不应把最早 2000+ 字旧对话再付一遍')
  assert.ok(selfContained.includes('TAIL-MARKER'), '最近对话必须保留')

  const withReference = buildPlannerPrompt('把它整理成三段', '/tmp', context, {})
  assert.ok(withReference.includes('HEAD-MARKER'), '有指代时保留完整背景供解析先行词')
  assert.ok(withReference.includes('TAIL-MARKER'))
})

test('[3.2.2] 已带 llmRulesBrief 时子任务书不再重复负责人授权段；旧调用方仍保留', () => {
  const plan = planWithoutOriginalRequest()
  const common = {
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
  }
  const withBrief = buildChildPrompt({ ...common, llmRulesBrief: '部门负责人强制流程：BRIEF-MARKER' })
  assert.ok(withBrief.includes('BRIEF-MARKER'))
  assert.ok(!withBrief.includes('本部门再分配权限与推理等级配置（用户强制要求，平台机制保障）：'), '同一份授权规则不应付两遍')

  const legacy = buildChildPrompt({ ...common, llmRulesBrief: '' })
  assert.ok(legacy.includes('本部门再分配权限与推理等级配置（用户强制要求，平台机制保障）：'), '旧调用方/旧计划仍能看到本地授权段')
})

test('[3.2.2] 顶层 acceptance 覆盖后，平台自动生成 verification.checks/allPassed', () => {
  const payload = {
    status: 'done',
    phases: phases(),
    acceptance: [{ criterion: 'A1', result: 'pass', evidence: '数据库只有 1 条记录' }],
    artifacts: [],
    needs: [],
    question: '',
    options: [],
  }
  const output = '<!-- WORKPLAN_EVIDENCE:START -->\n' + JSON.stringify(payload) + '\n<!-- WORKPLAN_EVIDENCE:END -->'
  const verdict = adjudicateResult({ output, expectedAcceptance: ['同一请求连发两次只写一条记录'] })
  assert.equal(verdict.status, 'done', verdict.error ?? '')
  assert.equal(verdict.verification, 'structured')
  assert.equal(verdict.phases?.verification?.allPassed, true)
  assert.equal(verdict.phases?.verification?.checks?.length, 1)
  assert.equal(verdict.phases?.verification?.checks?.[0]?.criterion, 'A1')
})


test('[3.2.2] 预算上限：大对话下 planner/child 任务书与 delegate 工具说明书不得回涨', () => {
  const context = 'x'.repeat(7000)
  const planner = buildPlannerPrompt('整理一份已有清单', '/tmp', context, {})
  assert.ok(planner.length <= 10500, `planner 任务书应 <=10500，实际 ${planner.length}`)

  const plan: any = planWithoutOriginalRequest()
  plan.taskAnchor = { text: '整理一份已有清单'.repeat(10), sha256: 'a'.repeat(64) }
  plan.taskUnderstanding.originalRequest = '整理一份已有清单'.repeat(10)
  const child = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: context,
    llmRulesBrief: '部门负责人强制流程：BRIEF',
    compactBackground: true,
  })
  assert.ok(child.length <= 13000, `child 任务书应 <=13000，实际 ${child.length}`)

  const tool = createDelegateTool({}) as any
  const toolChars = JSON.stringify({ description: tool.description, parameters: tool.parameters }).length
  assert.ok(toolChars <= 4500, `delegate 工具说明书应 <=4500，实际 ${toolChars}`)
})


test('[3.2.2] originalRequest 的 wire 上限与平台回填上限一致（<=8000）', () => {
  const okPlan: any = planWithoutOriginalRequest()
  okPlan.taskUnderstanding.originalRequest = 'x'.repeat(MAX_ORIGINAL_REQUEST_CHARS)
  assert.equal(validatePlan(okPlan).ok, true, '8000 字符必须合法')

  const tooLong: any = planWithoutOriginalRequest()
  tooLong.taskUnderstanding.originalRequest = 'x'.repeat(MAX_ORIGINAL_REQUEST_CHARS + 1)
  assert.equal(validatePlan(tooLong).ok, false, '超过 8000 必须明确拒绝，不能留到回放才炸')
})


/* ------------------------------------------------------------------ 3.2.3 ------------------------------------------------------------------ */

function childFor(plan: any) {
  return buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
    llmRulesBrief: '部门负责人强制流程：BRIEF',
    compactBackground: true,
  })
}

test('[3.2.3][R1] 长请求与锚点同源时只补锚点未显示的尾部', () => {
  const longRequest = 'A'.repeat(3999) + 'TAIL-MARKER' + 'B'.repeat(3000)
  const plan: any = planWithoutOriginalRequest()
  plan.taskAnchor = { text: longRequest, sha256: 'a'.repeat(64) }
  plan.taskUnderstanding.originalRequest = longRequest
  const child = childFor(plan)
  const globalLine = child.split('\n').find((line: string) => line.startsWith('全局任务：')) ?? ''
  assert.ok(globalLine.includes('锚点同源'), '应明确说明与锚点同源')
  assert.ok(globalLine.includes('TAIL-MARKER'), '锚点没显示的尾部必须完整保留')
  assert.ok(!globalLine.includes('A'.repeat(80)), '前 3,999 字不得在全局任务里再付一遍')
})

test('[3.2.3][R2/R4] 任务书不复述前三步细则，checks 口径只出现一次', () => {
  const child = childFor(planWithoutOriginalRequest())
  assert.ok(!child.includes('第一步全面、全盘、深入梳理、研究、思考自己的任务'), '旧复述句必须删除')
  assert.ok(child.includes('approachBasis'), '关键串仍在上方五步协议中')
  assert.equal(child.split('checks 可省略').length - 1, 1, 'checks 可省略只应出现一次')
})

test('[3.2.3][C1/C2] verify 工具 schema 必填与提示词口径一致', () => {
  const tool: any = createVerifyTool({})
  const phasesSchema = tool.parameters.properties.phases
  assert.deepEqual(phasesSchema.properties.verification.required, ['retrospective'])
  assert.deepEqual(phasesSchema.required, ['execution', 'verification'])
})
