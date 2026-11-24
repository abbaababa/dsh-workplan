import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChildPrompt } from '../src/plan.js'
import { buildLlmRulesBrief } from '../src/llm-rules.js'

/*
 * [3.2.5][红线] 用户 2026-11-24 定死：所有子任务执行自己的任务全过程禁止注意力丢失。
 *
 * 这四例只钉「唯一信息不得从任务书消失」与「删除重复副本后必须在原位置补注意力」，
 * 不钉具体文案；任何后续「省 token」改动若违反其一，测试必须失败：
 *  1. 自包含任务的最近对话背景仍然注入（1,200 字）；只有探测到指代才放 7,000 字。
 *     「自包含」只是词面推断，用户可能在上文刚改过要求却没写「它」。
 *  2. pending 兄弟仍带目标：目标决定执行者要不要等它、会不会重复采集同一批输入。
 *  3. 完整自查句只留一份（逐字重复不增加约束），但结果模板后仍有短提醒
 *     （「提交前」位置的近期效应不能被省掉）。
 *  4. phase-1 不再收到 phase-0 的过时流程指令（与接续块正面矛盾），phase-0 仍收到完整流程。
 */

function makePlan() {
  return {
    planId: 'wp-attention',
    taskAnchor: { text: '整理一份清单并交付', sha256: 'a'.repeat(64) },
    contradictions: { primary: { statement: '质量与成本的主要矛盾' } },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '完成交付',
      subtasks: [
        {
          id: 'T1',
          title: '主任务',
          department: 'engineering',
          role: 'leader',
          objective: '完成主任务并产出 out.md',
          acceptance: ['A1 可复核'],
          qualityRequirements: ['给出可复核证据'],
          inputs: [],
          outputs: ['out.md'],
          dependsOn: [],
        },
        {
          id: 'T2',
          title: '并行任务',
          department: 'writing',
          role: 'leader',
          objective: '写并行说明文档',
          acceptance: ['A1 可复核'],
          qualityRequirements: ['给出可复核证据'],
          inputs: [],
          outputs: ['t2.md'],
          dependsOn: [],
        },
      ],
    }],
  }
}

function render(options: any = {}) {
  const plan = makePlan()
  const subtask = plan.stages[0].subtasks[0]
  return buildChildPrompt({
    plan,
    subtask,
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '历史对话'.repeat(300),
    llmRulesBrief: buildLlmRulesBrief({ model: 'm', effort: 'max', tier: 'department' }),
    compactBackground: true,
    statuses: [],
    ...options,
  })
}

test('红线：自包含任务仍注入最近对话背景（唯一信息不得删除）', () => {
  const text = render()
  assert.ok(text.includes('历史对话'), '自包含任务的 1,200 字背景被省掉了')
})

test('红线：pending 兄弟仍带目标（唯一信息不得删除）', () => {
  const text = render()
  const line = text.split('\n').find((item: string) => item.startsWith('- T2 '))
  assert.ok(line, 'pending 兄弟整行消失')
  assert.ok(line.includes('写并行说明文档'), `pending 兄弟目标被省掉了：${line}`)
})

test('红线：自查句只留一份，但提交位置仍有短提醒', () => {
  const text = render()
  const copies = (text.match(/提交前自查（强制）/g) ?? []).length
  assert.equal(copies, 1, `完整自查句应只出现 1 次，实际 ${copies} 次`)
  assert.ok(text.includes('提交前再对照上方 F1–F11 自查一遍'), '结果模板后的短提醒被删掉了')
})

test('红线：phase-1 不再收到 phase-0 过时流程，phase-0 仍收到完整流程', () => {
  const phase0 = buildLlmRulesBrief({ model: 'm', effort: 'max', tier: 'department' })
  const phase1 = buildLlmRulesBrief({ model: 'm', effort: 'max', tier: 'department', phase1: true })
  assert.ok(phase0.includes('phase-0 low 启动'), 'phase-0 简报丢失开工流程')
  assert.ok(phase0.includes('必须先完成五步前三步'), 'phase-0 简报丢失前置流程')
  assert.ok(!phase1.includes('phase-0 low 启动'), 'phase-1 简报仍带过时的 phase-0 启动指令')
  assert.ok(!phase1.includes('必须先完成五步前三步'), 'phase-1 简报仍带与接续块矛盾的前置指令')
  assert.ok(phase1.includes('部门负责人强制流程'), 'phase-1 简报丢失去重所需的流程标题')
})
