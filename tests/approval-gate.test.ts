/**
 * [3.0.1] 认可闸门 + 死锁自愈（wp-e745a477 事故修复的回归钉）。
 *
 * 事故回放：用户总任务原文写明「有疑问先问用户，经用户认可后再开始执行」，
 * 插件却在第一条用户消息上自动生成计划并（autoDispatch 默认 true）立即派发；
 * T1 子会话因缺上下文升级待指示后子会话失联，instruct 报 NO_CHILD、
 * ESCALATION_OPEN 禁止改判、dispatch 被待指示行挡住——三条出口全堵，整盘卡死。
 *
 * 这里钉住四件事：
 *   1. 认可门槛语识别：8 类「先经用户认可再执行」表述各自命中，普通任务不误伤；
 *   2. 总开关 DSH_WORKPLAN_APPROVAL_GATE=0 只关关键词识别这一半；
 *   3. isDispatchHeld：只有 keyword/manual 两种 hold 才按住，release 后放行；
 *   4. 死锁自愈补丁：escalated 行复位 pending + 登记 reviveInstruction，
 *      且 applyStatus 集成后行状态、迁移合法性、pending 重置块不吞指示。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectApprovalGate,
  approvalGateDetectionDisabled,
  isDispatchHeld,
  buildChildRevivePatch,
} from '../src/approval-gate.js'
import { applyStatus, buildUpdateMessage, buildChildPrompt } from '../src/plan.js'

/* 逐字取自真实事故与常见用户表述。 */
const GATE_CASES = [
  { name: '经用户认可后再执行', text: '请你为以上内容制定计划，经用户认可后再开始执行。全程有任何疑问立刻问用户。' },
  { name: '得到您认可后再', text: '有任何疑问必须先询问用户，得到您明确回复后才能开始正式执行！' },
  { name: '确认后再开始执行', text: '计划制定后如有不确定，先向用户确认后再开始执行。' },
  { name: '先问您', text: '执行前我有几个问题需要先问您，请您回复。' },
  { name: '有疑问先问用户', text: '全程有任何疑问立刻问用户，经用户认可后再开始执行。' },
  { name: '等待用户确认', text: '制定计划后等待用户确认，确认前不要派发任何任务。' },
  { name: '未经认可不得', text: '未经用户认可不得开始执行，先出计划。' },
  { name: '认可后开始执行', text: '请制定详细计划，用户认可后开始执行。' },
]

for (const item of GATE_CASES) {
  test(`gate: 「${item.name}」命中认可闸门`, () => {
    const verdict = detectApprovalGate(item.text)
    assert.equal(verdict.held, true, JSON.stringify(verdict))
    assert.ok(verdict.reason.length > 0, '必须给出按住原因')
    assert.ok(verdict.matched.length > 0, '必须记录命中的门槛语')
  })
}

const FREE_CASES = [
  { name: '普通任务', text: '帮我修复登录页样式 bug。' },
  { name: '不含门槛语的认可字样', text: '这个方案我认为很好，请按计划推进。' },
  { name: '英文任务', text: 'Fix the build and run all tests.' },
]

for (const item of FREE_CASES) {
  test(`gate: ${item.name} 不误伤`, () => {
    const verdict = detectApprovalGate(item.text)
    assert.equal(verdict.held, false, JSON.stringify(verdict))
  })
}

test('gate: DSH_WORKPLAN_APPROVAL_GATE=0 只关闭关键词识别', () => {
  const prev = process.env.DSH_WORKPLAN_APPROVAL_GATE
  try {
    assert.equal(approvalGateDetectionDisabled(), false)
    process.env.DSH_WORKPLAN_APPROVAL_GATE = '0'
    assert.equal(approvalGateDetectionDisabled(), true)
    process.env.DSH_WORKPLAN_APPROVAL_GATE = 'OFF'
    assert.equal(approvalGateDetectionDisabled(), true)
    process.env.DSH_WORKPLAN_APPROVAL_GATE = '1'
    assert.equal(approvalGateDetectionDisabled(), false)
  } finally {
    if (prev === undefined) delete process.env.DSH_WORKPLAN_APPROVAL_GATE
    else process.env.DSH_WORKPLAN_APPROVAL_GATE = prev
  }
})

test('hold: 只有 keyword/manual 闸门才按住，release 后放行', () => {
  assert.equal(isDispatchHeld({ dispatchHold: { kind: 'keyword', reason: 'r', at: 1, by: 'system' } }), true)
  assert.equal(isDispatchHeld({ dispatchHold: { kind: 'manual', reason: 'r', at: 1, by: 'agent' } }), true)
  assert.equal(isDispatchHeld({ dispatchHold: null }), false)
  assert.equal(isDispatchHeld({}), false)
  assert.equal(isDispatchHeld(null), false)
  // 已派发计划不受闸门影响
  assert.equal(isDispatchHeld({ dispatchHold: null, dispatchedAt: 123 }), false)
})

function escalatedRow() {
  return {
    subtaskId: 'T1',
    title: '产品需求确认',
    department: 'product',
    status: 'blocked',
    closure: 'escalated',
    question: '规模与口径不明确，请示用户',
    options: ['A', 'B'],
    childId: 'dead-child-session',
    revision: 3,
  }
}

test('revive: buildChildRevivePatch 产出合法复位补丁', () => {
  const { patch, revision } = buildChildRevivePatch(escalatedRow(), '按推荐方案执行，规模 20 亿', 1000)
  assert.equal(revision, 4)
  assert.equal(patch.status, 'pending')
  assert.equal(patch.closure, 'pending')
  assert.equal(patch.childId, null)
  assert.equal(patch.question, null)
  assert.deepEqual(patch.options, [])
  assert.equal(patch.reviveInstruction.text, '按推荐方案执行，规模 20 亿')
  assert.equal(patch.reviveInstruction.at, 1000)
  assert.ok(patch.reviveInstruction.by === 'agent')
})

test('revive: buildChildRevivePatch 拒绝空指示', () => {
  assert.throws(() => buildChildRevivePatch(escalatedRow(), '   ', 1000), /指示/)
})

test('revive: applyStatus 集成——escalated 行复位并保留指示（pending 重置块不吞它）', () => {
  const rows = [escalatedRow()]
  const { patch } = buildChildRevivePatch(rows[0], '按推荐方案执行', 1000)
  const next = applyStatus(rows, 'T1', patch)
  const row = next[0]
  assert.equal(row.status, 'pending')
  assert.equal(row.closure, 'pending')
  assert.equal(row.childId, null)
  assert.equal(row.question, null)
  assert.deepEqual(row.options, [])
  assert.equal(row.reviveInstruction.text, '按推荐方案执行')
  assert.equal(row.revision, 4)
})

test('revive: applyStatus 对非法 reviveInstruction 消毒拒绝', () => {
  const rows = [escalatedRow()]
  assert.throws(
    () => applyStatus(rows, 'T1', { reviveInstruction: { text: '' } }),
    /reviveInstruction/,
  )
})

test('revive: buildChildPrompt 把指示带进新子会话提示词', () => {
  const plan = { planId: 'p1', title: 't', subtasks: [] }
  const prompt = buildChildPrompt({
    plan,
    subtask: escalatedRow(),
    stage: 'phase-1',
    dependencyResults: '',
    cwd: '/tmp',
    reviveInstruction: { text: '按推荐方案执行', at: 1000, by: 'agent' },
  })
  assert.ok(typeof prompt === 'string' && prompt.includes('按推荐方案执行'), '提示词必须包含复活指示全文')
  assert.ok(prompt.includes('不要重复请示同一问题'), '必须告知新子会话这是已拍板的指示')
})

test('durable: buildUpdateMessage 透传计划级 dispatchHold/gateHistory 与子任务级 reviveInstruction', () => {
  const msg = buildUpdateMessage({
    planId: 'p1',
    planRevision: 7,
    dispatchHold: { kind: 'manual', reason: '用户要求先认可', at: 5, by: 'agent' },
    gateHistory: [{ kind: 'manual', reason: 'r', at: 5, by: 'agent' }],
  })
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
  assert.ok(text.includes('dispatchHold'), '计划级闸门必须进 durable 信封')
  assert.ok(text.includes('gateHistory'), '留痕历史必须进 durable 信封')

  const rowMsg = buildUpdateMessage({
    planId: 'p1',
    subtaskId: 'T1',
    reviveInstruction: { text: '按推荐方案执行', at: 1000, by: 'agent' },
  })
  const rowText = typeof rowMsg === 'string' ? rowMsg : JSON.stringify(rowMsg)
  assert.ok(rowText.includes('reviveInstruction'), '子任务级复活指示必须进 durable 信封')
})
