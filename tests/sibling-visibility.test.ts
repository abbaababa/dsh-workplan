import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChildPrompt,
  buildSiblingDoneNotice,
  buildSiblingProgress,
  buildTeamBrief,
  dependencyAuditWarnings,
  markQueuedDelegates,
  prioritizeNewMembers,
} from '../src/plan.js'

/*
 * [3.2.1][治本] 兄弟可见性守门测试。
 *
 * 真实事故（2026-11-22 T4）：T3 已交付行情/资金事实，但 T4 的 status 只返回
 * 自己部门的 delegates，看不到兄弟完成到哪一步、产物在哪个文件，于是又把同一
 * 批公开事实采集了一遍。这里钉住三件事：
 *  - status 的 siblingSubtasks 只列非 pending 兄弟，done 优先，带已落盘产物；
 *  - 兄弟完成通知只给一行「谁完成、产物在哪、可复用」；
 *  - 任务书的兄弟简报对 done 兄弟优先给真实产物，并出现「兄弟复用」规则。
 */

function makePlan() {
  const mk = (id: string, title: string, outputs: string[], dependsOn: string[] = []) => ({
    id,
    title,
    department: 'data',
    role: '专家',
    objective: `${title}目标`,
    method: ['读取输入', '产出结果'],
    inputs: ['输入'],
    outputs,
    dependsOn,
    acceptance: ['A1 可复核'],
    qualityRequirements: ['给出命令输出'],
    risk: '低',
    estimateMinutes: 10,
    reasoningEffort: 'high',
  })
  const subtasks = [
    mk('T1', '行情数据', ['t1.csv']),
    mk('T2', '事件清单', ['t2.md']),
    mk('T3', '写报告', ['t3.md']),
    mk('T4', '待开始', ['t4.md']),
  ]
  return {
    version: 1,
    planId: 'wp-sibling',
    title: '兄弟可见性',
    taskAnchor: { text: '用户原要求：必须逐字保留。', sha256: 'c'.repeat(64) },
    taskUnderstanding: {
      originalRequest: '用户原要求：必须逐字保留。',
      deliverable: '一份报告',
      successCriteria: [],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: { primary: { statement: '时间与质量' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', goal: '完成', rationale: 'r', checkpoint: 'c', subtasks }],
  }
}

test('[3.2.1] siblingSubtasks 只列非 pending 兄弟，done 优先且带已落盘产物', () => {
  const plan = makePlan()
  const statuses = [
    { subtaskId: 'T1', status: 'done', summary: 'T1 已完成', artifacts: [{ kind: 'file', ref: 'reports/t1.csv', exists: true }] },
    { subtaskId: 'T2', status: 'running', artifacts: [] },
    { subtaskId: 'T3', status: 'pending' },
    { subtaskId: 'T4', status: 'blocked', error: '等待上游' },
  ]
  const rows = buildSiblingProgress(plan, statuses, 'T2')
  assert.deepEqual(rows.map((item: any) => item.id), ['T1', 'T4'])
  assert.equal(rows[0].status, 'done')
  assert.deepEqual(rows[0].artifacts, ['reports/t1.csv'])
  assert.equal(rows[1].status, 'blocked')
  assert.equal(rows.some((item: any) => item.id === 'T3'), false, 'pending 不应进入实时索引')
})

test('[3.2.1] 兄弟完成通知是一行，带产物路径和复用规则', () => {
  const plan = makePlan()
  const done = plan.stages[0].subtasks[0]
  const text = buildSiblingDoneNotice(done, {
    status: 'done',
    artifacts: [{ kind: 'file', ref: 'reports/t1.csv', exists: true }],
  })
  assert.match(text, /T1/)
  assert.match(text, /reports\/t1\.csv/)
  assert.match(text, /不要重复采集/)
  assert.ok(text.length <= 320)
})

test('[3.2.1] 兄弟完成通知无产物时退回计划产物，不编造路径', () => {
  const plan = makePlan()
  const done = plan.stages[0].subtasks[0]
  const text = buildSiblingDoneNotice(done, { status: 'done', artifacts: [] })
  assert.match(text, /t1\.csv/)
  assert.doesNotMatch(text, /reports\/wp-member/)
})

test('[3.2.1] 兄弟简报对 done 兄弟给真实产物，对 pending 兄弟仍给计划产物', () => {
  const plan = makePlan()
  const statuses = [
    { subtaskId: 'T1', status: 'done', summary: '数据已交付', artifacts: [{ kind: 'file', ref: 'reports/t1.csv', exists: true }] },
    { subtaskId: 'T2', status: 'running' },
    { subtaskId: 'T3', status: 'pending' },
    { subtaskId: 'T4', status: 'pending' },
  ]
  const brief = buildTeamBrief(plan, statuses, plan.stages[0].subtasks[1])
  assert.match(brief, /T1/)
  assert.match(brief, /已落盘 reports\/t1\.csv/)
  assert.match(brief, /T3/)
  assert.match(brief, /产出 t3\.md/)
})

test('[3.2.1] 计划自检点名「未定输入 + 可复用前序数据」的依赖缺口', () => {
  const plan = makePlan()
  plan.stages[0].subtasks[1].inputs = ['公开政策与行业数据（待确认）']
  const warnings = dependencyAuditWarnings(plan)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /T2/)
  assert.match(warnings[0], /T1/)
  assert.match(warnings[0], /dependsOn/)
})

test('[3.2.1] 有 done 兄弟时任务书出现兄弟复用规则', () => {
  const plan = makePlan()
  const statuses = [
    { subtaskId: 'T1', status: 'done', summary: '数据已交付', artifacts: [{ kind: 'file', ref: 'reports/t1.csv', exists: true }] },
    { subtaskId: 'T2', status: 'running' },
  ]
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[1],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    statuses,
  })
  assert.match(prompt, /兄弟复用/)
  assert.match(prompt, /siblingSubtasks/)
  assert.match(prompt, /reports\/t1\.csv|T1/)
})

test('[3.2.1] 补派排队可见：running 且无 childId 标 queued，有 childId 不标', () => {
  const input: any[] = [
    { member: 'a', status: 'running', childId: null },
    { member: 'b', status: 'running', childId: 'child-1' },
    { member: 'c', status: 'done', childId: 'child-2' },
  ]
  const out = markQueuedDelegates(input)
  assert.equal(out[0].queued, true)
  assert.equal(out[1].queued, undefined)
  assert.equal(out[2].queued, undefined)
  // 只改读面：不得修改入参对象
  assert.equal(input[0].queued, undefined)
})


test('[3.2.1] 补派时新成员排到旧成员前面，旧成员顺序不乱', () => {
  const members = [{ member: 'old-a' }, { member: 'new-x' }, { member: 'old-b' }, { member: 'new-y' }]
  const prior = [{ member: 'old-a' }, { member: 'old-b' }]
  const out = prioritizeNewMembers(members, prior)
  assert.deepEqual(out.map((item: any) => item.member), ['new-x', 'new-y', 'old-a', 'old-b'])
  // 没有新成员时保持原顺序
  assert.deepEqual(prioritizeNewMembers(prior, prior).map((item: any) => item.member), ['old-a', 'old-b'])
})
