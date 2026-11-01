/*
 * [1.7.0] Host-facing tool contracts.
 *
 * The tools are the only interface the main Agent sees, so their schemas are a
 * behavioural contract, not cosmetics: a missing `mode` enum hides async
 * dispatch from the model, a missing `expectedRevision` makes the write guard
 * unusable, and a tool timeout that does not outlive the plan budget kills the
 * call while the dispatcher is still legitimately working. A-20 pins them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROMPT_SECTION,
  createCancelTool,
  createDispatchTool,
  createStatusTool,
  createUpdateTool,
  toolGuardReason,
} from '../src/host.js'
import { plannerOutputSchema, statusToolOutputSchema } from '../src/runtime.js'

function fakeRuntime() {
  return {
    limits: { totalTimeoutMs: 600_000, maxResumes: 4 },
    dispatchTool: async () => ({ ok: true }),
    updateStatus: async () => ({ ok: true }),
    cancelPlan: async () => ({ ok: true }),
    statusTool: async () => ({ ok: true, running: false }),
  }
}

test('dispatch 工具暴露 wait/async 两种模式，且超时覆盖计划预算', () => {
  const dispatch = createDispatchTool(fakeRuntime())
  assert.equal(dispatch.name, 'dsh_workplan_dispatch')
  assert.deepEqual(dispatch.parameters.properties.mode.enum, ['wait', 'async'])
  assert.equal(dispatch.parameters.properties.mode.type, 'string')
  assert.equal(dispatch.parameters.additionalProperties, false)
  assert.equal(dispatch.timeoutMs, 620_000, '工具超时必须比计划预算更长，否则派发中被宿主打断')
})

test('status 工具是只读的，输出 schema 覆盖进度字段', () => {
  const status = createStatusTool(fakeRuntime())
  assert.equal(status.name, 'dsh_workplan_status')
  assert.deepEqual(Object.keys(status.parameters.properties), ['planId'])
  const schema: any = statusToolOutputSchema()
  for (const field of ['ok', 'running', 'phase', 'stats', 'statuses', 'elapsedMs']) {
    assert.ok(schema.properties[field], `status 输出必须带 ${field}`)
  }
})

test('update 工具暴露 expectedRevision 与 force 写保护参数', () => {
  const update = createUpdateTool(fakeRuntime())
  assert.equal(update.name, 'dsh_workplan_update')
  assert.equal(update.parameters.properties.expectedRevision.type, 'integer')
  assert.equal(update.parameters.properties.force.type, 'boolean')
})

test('cancel 工具的参数面仍封闭：planId/reason + 受限的 disposition/supersededBy', () => {
  const cancel = createCancelTool(fakeRuntime())
  assert.equal(cancel.name, 'dsh_workplan_cancel')
  /*
   * [1.9.2 / T6] 写侧收敛后多了处置参数，但集合仍是封闭的：工具只接受「映射
   * 意图」，requiredCount/coveredCount/coverage/digest 由运行时复算，模型不得
   * 自报。这条用例挡的是「为了让 supersede 跑通而把 schema 放成 additionalProperties:true」。
   */
  assert.deepEqual(
    Object.keys(cancel.parameters.properties).sort(),
    ['disposition', 'planId', 'reason', 'supersededBy'],
  )
  assert.equal(cancel.parameters.additionalProperties, false)
  assert.deepEqual(cancel.parameters.properties.disposition.enum, ['cancelled', 'superseded'])
  const by = cancel.parameters.properties.supersededBy
  assert.deepEqual(by.required, ['planId', 'mapping'])
  assert.equal(by.additionalProperties, false)
  assert.deepEqual(Object.keys(by.properties).sort(), ['mapping', 'planId'])
  const item = by.properties.mapping.items
  assert.deepEqual(item.required, ['from', 'to', 'basis'])
  assert.equal(item.additionalProperties, false)
  const byProps = by.properties as Record<string, unknown>
  for (const field of ['requiredCount', 'coveredCount', 'coverage', 'digest']) {
    assert.equal(byProps[field], undefined, `运行时复算的 ${field} 不得成为工具入参`)
  }
})

test('规划器输出 schema 要求 ok，并允许完整计划', () => {
  const schema = plannerOutputSchema()
  assert.deepEqual(schema.required, ['ok'])
  assert.equal(schema.additionalProperties, true)
})

test('工具闸门：present 交给 runtime 判定，dispatch 保持 plan 模式限制，其余放行', () => {
  const runtime = {
    planModeActive: (session: any) => session?.id === 'plan-session',
    presentDenialReason: (agent: any) => (agent?.session?.id === 'blocked' ? '计划未完成：1/3' : undefined),
  }
  assert.equal(
    toolGuardReason({ name: 'present', agent: { session: { id: 'blocked' } } }, runtime),
    '计划未完成：1/3',
  )
  assert.equal(toolGuardReason({ name: 'present', agent: { session: { id: 'ok' } } }, runtime), undefined)
  assert.match(
    String(toolGuardReason({ name: 'dsh_workplan_dispatch', agent: { session: { id: 'plan-session' } } }, runtime)),
    /plan 模式/,
  )
  assert.equal(toolGuardReason({ name: 'bash', agent: { session: { id: 'blocked' } } }, runtime), undefined)
})

test('系统提示词教会主 Agent 使用 async/status 并逐条转达 needs', () => {
  assert.match(PROMPT_SECTION, /dsh_workplan_status/)
  assert.match(PROMPT_SECTION, /mode: "async"/)
  assert.match(PROMPT_SECTION, /跨部门待转达/)
  assert.match(PROMPT_SECTION, /structured/)
})
