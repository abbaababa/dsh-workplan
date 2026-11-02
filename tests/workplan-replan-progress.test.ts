/*
 * [1.11.0] T7：完成回报、重规划触发与进度同步的读/写契约。
 *
 * 三条断言各自钉住一个“只做了一半”的旧缺口：
 *  1. `dsh_workplan_replan` 必须真的注册成工具（否则提示词让模型调一个不存在的
 *     工具，需求变更永远落实不了）；
 *  2. 完成态的写入字段 `closure/report` 与读取点 `deliveryReadiness` 读的是
 *     同一条状态条目上的同名字段——写 `done` 未回报时门禁拦住，写 `reported`
 *     后放行；
 *  3. 记录级事实（changeRequest.pending / reportPending）进入同一交付门禁，
 *     而不是只活在提示词里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createReplanTool } from '../src/host.js'
import { applyStatus, deliveryReadiness, derivePlanSnapshot } from '../src/plan.js'
import { replanToolOutputSchema } from '../src/runtime.js'

function fakeRuntime() {
  const calls: any[] = []
  return {
    calls,
    replanPlan: async (agent: any, args: any) => {
      calls.push({ agent, args })
      return { ok: true, planId: 'p1', planRevision: 2, marks: [], added: [] }
    },
  }
}

function row(overrides: any = {}) {
  return {
    subtaskId: 'T1',
    stageId: 'S1',
    title: '做一件事',
    department: 'engineering',
    role: '执行工程师',
    status: 'pending',
    closure: 'pending',
    progress: 0,
    ...overrides,
  }
}

const PASS_EVIDENCE = {
  verification: 'structured',
  // [1.11.0] C-19：自称 pass 必须带证据，否则会被降级为 unverified。
  acceptance: [{ criterion: '有可核对输出', result: 'pass', evidence: 'npm test 通过 + 报告 §2' }],
  artifacts: [],
  missingArtifacts: [],
}

test('replan 工具已注册：参数面封闭，执行委托给 runtime.replanPlan', async () => {
  const runtime = fakeRuntime()
  const tool = createReplanTool(runtime)
  assert.equal(tool.name, 'dsh_workplan_replan')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['changeText', 'changes', 'planId', 'reason'])
  assert.deepEqual(tool.parameters.required.sort(), ['changes', 'reason'])
  assert.deepEqual(tool.parameters.properties.changes.items.properties.action.enum, ['cancel', 'replace', 'add'])
  assert.deepEqual(tool.parameters.properties.changes.items.required.sort(), ['action', 'subtaskId'])
  const schema: any = replanToolOutputSchema()
  for (const field of ['ok', 'planId', 'planRevision', 'marks', 'added', 'code', 'running']) {
    assert.ok(schema.properties[field], `replan 输出必须带 ${field}`)
  }
  const answer = await tool.execute(
    { reason: '用户改了交付范围', changes: [{ subtaskId: 'T1', action: 'cancel' }] },
    { agent: { session: { id: 's1' } } },
  )
  assert.equal(answer.ok, true)
  assert.equal(runtime.calls.length, 1, '工具必须真正调用 runtime.replanPlan，不能只是个空壳')
  assert.equal(runtime.calls[0].args.changes[0].action, 'cancel')
})

test('完成必回报：写 done 未回报被门禁拦住，写 reported 后同一字段放行', () => {
  let statuses = applyStatus([row()], 'T1', {
    status: 'done',
    progress: 100,
    ...PASS_EVIDENCE,
    updatedBy: 'child',
  })
  assert.equal(statuses[0].status, 'done')
  assert.equal(statuses[0].closure, 'done', '完成路径的中间态必须是 closure=done')

  const before = deliveryReadiness(derivePlanSnapshot(statuses))
  assert.equal(before.ready, false)
  assert.match(before.blockers.join('｜'), /尚未回报/)

  statuses = applyStatus(statuses, 'T1', {
    closure: 'reported',
    report: { state: 'sent', at: 1, ref: 'p1:1', turn: 1 },
    reportedAt: 1,
    updatedBy: 'system',
  })
  assert.equal(statuses[0].report?.state, 'sent')
  const after = deliveryReadiness(derivePlanSnapshot(statuses))
  assert.deepEqual(after.blockers, [])
  assert.equal(after.ready, true, '回报写入后，门禁读的必须是同一条状态条目')
})

test('主 Agent 亲自改判 done 不会被「未回报」误伤', () => {
  const statuses = applyStatus([row()], 'T1', {
    status: 'done',
    progress: 100,
    ...PASS_EVIDENCE,
    updatedBy: 'agent',
  })
  assert.equal(statuses[0].closure, 'done')
  const readiness = deliveryReadiness(derivePlanSnapshot(statuses))
  assert.equal(readiness.blockers.some((item: string) => item.includes('尚未回报')), false)
  assert.equal(readiness.ready, true)
})

test('记录级闭环事实进入同一交付门禁', () => {
  const snapshot = derivePlanSnapshot([row({
    status: 'done',
    closure: 'reported',
    progress: 100,
    report: { state: 'sent', at: 1, ref: 'p1:1', turn: 1 },
    ...PASS_EVIDENCE,
  })])
  assert.equal(deliveryReadiness(snapshot).ready, true)

  const pendingChange = deliveryReadiness(snapshot, { changePending: true })
  assert.equal(pendingChange.ready, false)
  assert.match(pendingChange.blockers.join('｜'), /需求变更/)

  const pendingReport = deliveryReadiness(snapshot, { reportPending: true })
  assert.equal(pendingReport.ready, false)
  assert.match(pendingReport.blockers.join('｜'), /尚未成功写入会话/)
})
