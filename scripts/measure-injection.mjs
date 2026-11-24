#!/usr/bin/env node
/**
 * [3.2.4][省钱 R10] 可复现的「注入面」测量脚本（按真实角色集合测）。
 *
 * 用法：npm run build && node scripts/measure-injection.mjs
 *
 * 旧版硬编码了 11 个工具工厂，既包含根会话永远看不到的 delegate/verify/
 * escalate，又漏掉真实注入的 followup/hold/release —— 跨版本「省了多少」
 * 的基线因此失真（根会话多算 ~4,982 字符，另有两份最大子会话工具从未被测）。
 * 现在改为测全部 14 个工具，并用生产同一个 `workplanToolAdmitted()` 分角色
 * 求可见集合（根 11 / 负责人 4 / 专家 3），集合与 tests/fixtures/tool-surface.json
 * 一致，不再靠手抄。
 *
 * 口径（写死，便于跨版本对比；测的是字符数，不是账单 token）：
 *  - promptSection：注册给根会话的系统提示段；
 *  - toolSchemas.*：每个工具的 description + parameters 序列化长度；
 *  - toolSurface.roles.*：各角色真实可见工具的字符数之和（生产口径）；
 *  - plannerPrompt / leaderTaskBook / expertTaskBook：真实装配函数产出的长度；
 *  - weightedExample：1 份系统提示 + 1 份根工具面 + 1 份规划器 + 5 份负责人
 *    任务书 + 5 份专家任务书的一个示例加权和（权重按实际派发改）。
 * 本脚本只读、不写文件；不依赖网络。历史版本可在对应 git 标签上执行同一脚本对比。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  PROMPT_SECTION,
  createCancelTool,
  createDelegateTool,
  createDispatchTool,
  createEscalateTool,
  createFollowupTool,
  createHandoffTool,
  createHoldTool,
  createInstructTool,
  createLessonsTool,
  createReleaseTool,
  createReplanTool,
  createStatusTool,
  createUpdateTool,
  createVerifyTool,
  workplanToolAdmitted,
} from '../dist/host.js'
import { buildChildPrompt, buildPlannerPrompt } from '../dist/plan.js'
import { buildDelegateePrompt, buildLlmRulesBrief } from '../dist/llm-rules.js'
import { fiveStepPromptLines, fiveStepContinuationPromptLines } from '../dist/five-step.js'
import { renderCommFormatSpec } from '../dist/comm-format.js'

const here = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version

const factories = {
  cancel: createCancelTool,
  delegate: createDelegateTool,
  dispatch: createDispatchTool,
  escalate: createEscalateTool,
  followup: createFollowupTool,
  handoff: createHandoffTool,
  hold: createHoldTool,
  instruct: createInstructTool,
  lessons: createLessonsTool,
  release: createReleaseTool,
  replan: createReplanTool,
  status: createStatusTool,
  update: createUpdateTool,
  verify: createVerifyTool,
}
const toolNames = {
  cancel: 'dsh_workplan_cancel',
  delegate: 'dsh_workplan_delegate',
  dispatch: 'dsh_workplan_dispatch',
  escalate: 'dsh_workplan_escalate',
  followup: 'dsh_workplan_followup',
  handoff: 'dsh_workplan_handoff',
  hold: 'dsh_workplan_hold',
  instruct: 'dsh_workplan_instruct',
  lessons: 'dsh_workplan_lessons',
  release: 'dsh_workplan_release',
  replan: 'dsh_workplan_replan',
  status: 'dsh_workplan_status',
  update: 'dsh_workplan_update',
  verify: 'dsh_workplan_verify',
}
const toolSchemas = {}
for (const [key, factory] of Object.entries(factories)) {
  const tool = factory({})
  toolSchemas[key] = JSON.stringify({ description: tool.description, parameters: tool.parameters }).length
}

/*
 * 角色会话形状与生产一致：根会话没有 parentSession、depth=0；负责人
 * parentSession 存在、depth=1；叶子 depth=2。可见性判定直接调用生产函数，
 * 防止脚本与 host.ts 各写一份规则再次漂移。
 */
const roleSessions = {
  root: { header: { origin: 'user' } },
  leader: { header: { origin: 'subagent', parentSession: 'root', delegationDepth: 1 } },
  leaf: { header: { origin: 'subagent', parentSession: 'leader', delegationDepth: 2 } },
}
const toolSurface = {}
for (const [role, session] of Object.entries(roleSessions)) {
  const visible = Object.keys(factories).filter((key) => workplanToolAdmitted(toolNames[key], session))
  toolSurface[role] = {
    count: visible.length,
    names: visible.map((key) => toolNames[key]),
    chars: visible.reduce((sum, key) => sum + toolSchemas[key], 0),
  }
}

/*
 * 真实形状的计划：2 个阶段、15 个子任务、12 个并行兄弟、依赖 2 项。旧脚本
 * 只有 1 个子任务、0 个兄弟、12 字符的占位简报，任务书因此比真实派发小一半
 * （官方数字 7,293 对实测 12,718）。这里保持确定性，但把真实注入面放进来：
 * 兄弟状态、真实规则简报、1,200 字对话背景。
 */
const departments = ['engineering', 'research', 'design', 'product', 'data', 'quality', 'security', 'ops', 'writing', 'operations', 'legal', 'finance']
const subtasks = Array.from({ length: 15 }, (_, index) => ({
  id: `T${index + 1}`,
  title: `子任务 ${index + 1}：产出可验收的单项结果`,
  department: departments[index % departments.length],
  role: 'leader',
  objective: `完成第 ${index + 1} 项工作，给出可复核结论与唯一产物路径`,
  method: ['先梳理输入与约束', '再执行并逐条验证'],
  acceptance: ['结论可复核', '产物已落盘'],
  qualityRequirements: ['证据必须可复核', '产物路径唯一'],
  inputs: index === 0 ? [] : ['用户提供的清单'],
  outputs: [`reports/T${index + 1}/out.md`],
  dependsOn: index === 0 ? [] : ['T1'],
}))
const plan = {
  version: 1,
  planId: 'wp-measure',
  taskAnchor: { text: '整理一份已有清单并给出可验收结论', sha256: 'a'.repeat(64) },
  taskUnderstanding: { originalRequest: '整理一份已有清单并给出可验收结论' },
  contradictions: { primary: { statement: '质量与成本' } },
  stages: [{
    id: 'S1',
    name: '实施',
    goal: '完成',
    subtasks: subtasks.slice(0, 10),
  }, {
    id: 'S2',
    name: '复核',
    goal: '验收',
    subtasks: subtasks.slice(10),
  }],
}
const statuses = subtasks.map((item, index) => ({
  subtaskId: item.id,
  status: index < 6 ? 'done' : (index < 8 ? 'in_progress' : 'pending'),
  summary: index < 6 ? `第 ${index + 1} 项已完成，产物见 ${item.outputs[0]}。`.repeat(6) : '',
  artifacts: index < 6 ? [{ kind: 'file', ref: item.outputs[0], exists: true }] : [],
}))
const dependencyResults = [{
  id: 'T1',
  title: '子任务 1：产出可验收的单项结果',
  status: 'done',
  summary: `第 1 项已完成。${'关键结论与产物路径。'.repeat(60)}`,
  artifacts: ['reports/T1/out.md', 'reports/T1/table.csv'],
}]
const conversationContext = '用户：整理一份已有清单。助手：已确认口径。'.repeat(60).slice(0, 1200)
const target = plan.stages[0].subtasks[1]
const common = {
  plan,
  subtask: target,
  stage: plan.stages[0],
  dependencyResults,
  cwd: '/tmp',
  statuses,
  conversationContext,
  llmRulesBrief: buildLlmRulesBrief({ model: 'deepseek-flash', effort: 'max', tier: 'department' }),
  compactBackground: true,
}
const plannerPrompt = buildPlannerPrompt('整理一份已有清单并给出可验收结论', '/tmp', conversationContext, {})
const leaderTaskBook = buildChildPrompt(common)
const leaderTaskBookContinuation = buildChildPrompt({ ...common, phaseZeroContinuation: 'phase-0 已登记（接续）' })
const expertTaskBook = buildDelegateePrompt({
  departmentLabel: '质量验证',
  leaderSubtaskId: 'T1',
  leaderSubtaskTitle: '子任务 1：产出可验收的单项结果',
  member: { member: 'E1', task: '核对报告并逐条给出验收结论', qualityRequirements: ['有证据', '结论可复核'] },
  rulesBrief: buildLlmRulesBrief({ model: 'deepseek-flash', effort: 'high', tier: 'delegate', memberName: 'E1', memberRole: 'expert' }),
  cwd: '/tmp',
  continuation: true,
})

const components = {
  promptSection: PROMPT_SECTION.length,
  toolSchemas,
  toolSchemasAll: Object.values(toolSchemas).reduce((a, b) => a + b, 0),
  toolSurface,
  plannerPrompt: plannerPrompt.length,
  leaderTaskBook: leaderTaskBook.length,
  leaderTaskBookContinuation: leaderTaskBookContinuation.length,
  expertTaskBook: expertTaskBook.length,
  fiveStepFull: fiveStepPromptLines().join('\n').length,
  fiveStepContinuation: fiveStepContinuationPromptLines().join('\n').length,
  commSpecLeader: renderCommFormatSpec('leader').length,
}
const weights = { system: 1, toolSurface: 1, planner: 1, leaderTaskBooks: 5, expertTaskBooks: 5 }
const weightedExample = components.promptSection
  + toolSurface.root.chars
  + weights.planner * components.plannerPrompt
  + weights.leaderTaskBooks * components.leaderTaskBook
  + weights.expertTaskBooks * components.expertTaskBook

process.stdout.write(JSON.stringify({ version, note: '字符数，非账单 token', components, weights, weightedExample }, null, 2) + '\n')
