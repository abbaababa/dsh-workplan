/*
 * [1.7.0] Cross-department context in the child prompt.
 *
 * Sibling departments used to be invisible to each other: each child received
 * only its own subtask plus the stages, so two departments could duplicate work,
 * contradict each other's interface, or silently wait on something nobody was
 * producing. The brief states who else is on the plan, what they are doing and
 * what they already produced; `needs` is the only supported way to ask for
 * help, and the main Agent relays it (the result message repeats it).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStatus,
  buildChildPrompt,
  buildTeamBrief,
  createStatuses,
} from '../src/plan.js'

function makePlan() {
  return {
    planId: 'wp-team',
    sessionId: 'session-team',
    createdTurn: 1,
    createdAt: 1000,
    title: '跨部门协作回归',
    taskUnderstanding: { originalRequest: '把接口和文档一起交付', deliverable: '接口 + 文档' },
    contradictions: { primary: { statement: '人手与并行度有限' } },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '完成实现与文档',
      subtasks: [
        {
          id: 'T1',
          title: '实现接口',
          department: 'engineering',
          objective: '实现接口',
          acceptance: ['接口可用'],
          outputs: ['src/api.ts'],
          risk: 'low',
          dependsOn: [],
        },
        {
          id: 'T2',
          title: '写使用文档',
          department: 'writing',
          objective: '写文档',
          acceptance: ['文档可照做'],
          outputs: ['docs/api.md'],
          risk: 'low',
          dependsOn: ['T1'],
        },
      ],
    }],
  }
}

test('兄弟部门 brief 列出同伴的部门、目标、输出与已完成摘要', () => {
  const plan = makePlan()
  let statuses: any[] = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', { status: 'done', summary: '接口已实现，导出 createClient' })
  const t2 = plan.stages[0].subtasks[1]

  const brief = buildTeamBrief(plan, statuses, t2)
  assert.match(brief, /T1/)
  assert.match(brief, /工程/)
  assert.match(brief, /实现接口/)
  assert.match(brief, /src\/api\.ts/)
  assert.match(brief, /接口已实现，导出 createClient/, '已完成部门的结果要让下游看见，避免重复造轮子')
  assert.ok(!brief.includes('T2'), '不要把自己的任务列成“兄弟部门”')
})

test('子 Agent 提示词带上兄弟部门进展与 needs 转达规则', () => {
  const plan = makePlan()
  const statuses = applyStatus(createStatuses(plan), 'T1', {
    status: 'done',
    summary: '接口已实现，导出 createClient',
  })
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[1],
    stage: plan.stages[0],
    dependencyResults: [{ id: 'T1', title: '实现接口', status: 'done', summary: '接口已实现，导出 createClient' }],
    cwd: '/repo',
    conversationContext: '',
    statuses,
    previousFailure: null,
  })

  assert.match(prompt, /兄弟部门进展/)
  assert.match(prompt, /需要协作请写进 needs 由主 Agent 转达/)
  assert.match(prompt, /接口已实现，导出 createClient/)
  assert.match(prompt, /WORKPLAN_EVIDENCE:START/, '必须给出结构化证据块模板')
  assert.match(prompt, /不要直连其他子 Agent/)
})

test('完整对话背景原样进入子 Agent 提示词，不再二次截断', () => {
  const plan = makePlan()
  const head = 'CONVERSATION-HEAD '
  const tail = ' CONVERSATION-TAIL'
  const context = head + 'x'.repeat(12000) + tail
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/repo',
    conversationContext: context,
    statuses: createStatuses(plan),
    previousFailure: null,
  })
  assert.ok(prompt.includes(head))
  assert.ok(prompt.includes(tail), '最近的用户原话不能被第二次截断丢掉')
})
