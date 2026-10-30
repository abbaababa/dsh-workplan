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

test('cancel 工具仍然存在且只接受 planId 与 reason', () => {
  const cancel = createCancelTool(fakeRuntime())
  assert.equal(cancel.name, 'dsh_workplan_cancel')
  assert.deepEqual(Object.keys(cancel.parameters.properties).sort(), ['planId', 'reason'])
})

test('规划器输出 schema 要求 ok，并允许完整计划', () => {
  const schema = plannerOutputSchema()
  assert.deepEqual(schema.required, ['ok'])
  assert.equal(schema.additionalProperties, true)
})

test('系统提示词教会主 Agent 使用 async/status 并逐条转达 needs', () => {
  assert.match(PROMPT_SECTION, /dsh_workplan_status/)
  assert.match(PROMPT_SECTION, /mode: "async"/)
  assert.match(PROMPT_SECTION, /跨部门待转达/)
  assert.match(PROMPT_SECTION, /structured/)
})
