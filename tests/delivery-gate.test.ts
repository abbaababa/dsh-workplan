/*
 * [1.8.13] One delivery predicate, pinned.
 *
 * The incident had four independent "done" judgments: result message, stop
 * gate, present guard and dispatch snapshot. They disagreed, so a plan could be
 * described as finished while present was denied (or worse, allowed). These
 * tests pin the single predicate and every path that now consumes it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCancelMessage,
  buildPlanMessage,
  createStatuses,
  deliveryReadiness,
  derivePlanSnapshot,
} from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'

function makePlan(planId = 'wp-delivery') {
  return {
    planId,
    sessionId: 'session-delivery',
    createdTurn: 1,
    createdAt: 1000,
    title: '交付就绪回归',
    contradictions: { primary: { statement: '交付就绪必须只有一个判据' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
      ],
    }],
  }
}

function readyStatuses(plan: any) {
  const statuses: any[] = createStatuses(plan)
  for (const item of statuses) {
    item.status = 'done'
    item.progress = 100
    item.verification = 'structured'
    item.acceptance = [{ criterion: `${item.subtaskId} 验收`, result: 'pass', evidence: 'npm test 通过' }]
    item.missingArtifacts = []
  }
  return statuses
}

function readinessOf(statuses: any[], phase = 'done') {
  return deliveryReadiness(derivePlanSnapshot(statuses), { phase })
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-delivery',
    header: { createdAt: 1000 },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeRuntime(record: any, session: any) {
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

test('deliveryReadiness：只有 structured + 逐项 pass + 产物齐全才算就绪', () => {
  const plan = makePlan()
  assert.equal(readinessOf(readyStatuses(plan)).ready, true, '完整证据必须就绪')

  const variants: Array<[string, (statuses: any[]) => void, RegExp]> = [
    ['legacy', (s) => { s[0].verification = 'legacy' }, /旧格式回传/],
    ['unverified', (s) => { s[0].verification = 'unverified' }, /未验证/],
    ['undefined', (s) => { s[0].verification = undefined }, /未提供自检结果/],
    ['empty acceptance', (s) => { s[0].acceptance = [] }, /acceptance 为空/],
    ['failed acceptance', (s) => { s[0].acceptance[0].result = 'fail' }, /验收未通过/],
    ['missing artifacts', (s) => { s[0].missingArtifacts = ['reports/x.md'] }, /缺少声明产物/],
    ['missing declared file', (s) => { s[0].artifacts = [{ kind: 'file', ref: 'reports/x.md', exists: false }] }, /声明产物不存在/],
  ]
  for (const [label, mutate, pattern] of variants) {
    const statuses = readyStatuses(plan)
    mutate(statuses)
    const readiness = readinessOf(statuses)
    assert.equal(readiness.ready, false, `${label} 不得就绪`)
    assert.match(readiness.blockers.join('；'), pattern, `${label} 必须给出可命名缺口`)
  }

  const pending = readyStatuses(plan)
  pending[1].status = 'pending'
  pending[1].verification = undefined
  pending[1].acceptance = []
  const pendingReadiness = readinessOf(pending)
  assert.equal(pendingReadiness.ready, false)
  assert.deepEqual(pendingReadiness.remaining, ['T2'])
})

test('deliveryReadiness：取消不等于完成，但全 done 且证据通过仍是就绪', () => {
  const plan = makePlan()
  const cancelledIncomplete = readyStatuses(plan)
  cancelledIncomplete[1].status = 'pending'
  const denied = readinessOf(cancelledIncomplete, 'cancelled')
  assert.equal(denied.ready, false)
  assert.equal(denied.cancelled, true)
  assert.match(denied.blockers.join('；'), /计划已取消但只完成 1\/2/)

  const cancelledDone = readyStatuses(plan)
  const allowed = readinessOf(cancelledDone, 'cancelled')
  assert.equal(allowed.ready, true, '取消本身不制造缺口；它也不是完成，只是没有未完成项')
})

test('update 补证会持久化，并在回放后仍然可交付', async () => {
  const plan = makePlan('wp-update-evidence')
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  const record: any = {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'paused',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
  }
  const runtime: any = makeRuntime(record, session)

  const first = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    status: 'done',
    verification: 'structured',
    acceptance: [{ criterion: 'T1 验收', result: 'pass', evidence: '测试通过' }],
  })
  assert.equal(first.ok, true)
  assert.equal(first.deliveryReady, false, 'T2 未完成时整体仍不可交付')

  const second = await runtime.updateStatus({ session }, {
    subtaskId: 'T2',
    status: 'done',
    verification: 'structured',
    acceptance: [{ criterion: 'T2 验收', result: 'pass', evidence: '测试通过' }],
  })
  assert.equal(second.ok, true)
  assert.equal(second.deliveryReady, true, '证据齐全后 update 必须报告可交付')

  const replayed: any = reconstructFromSession(session)
  assert.ok(replayed?.plan, '计划必须能从会话日志重建')
  assert.equal(replayed.statuses[0].verification, 'structured', '人工补证必须回放')
  assert.deepEqual(replayed.statuses[0].acceptance, [{ criterion: 'T1 验收', result: 'pass', evidence: '测试通过' }])
  const replayedReadiness = readinessOf(replayed.statuses, replayed.phase)
  assert.equal(replayedReadiness.ready, true, '刷新后仍必须可交付')
})

test('present：全 done 无证据、取消未完成一律拒绝；取消文案不再暗示可交付', () => {
  const plan = makePlan('wp-present-unified')
  const session = makeSession()
  const bare: any = {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'done',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
  }
  for (const item of bare.statuses) item.status = 'done'
  const runtime: any = makeRuntime(bare, session)
  const denied = runtime.presentDenialReason({ session })
  assert.match(denied, /证据未通过/)
  assert.match(denied, /dsh_workplan_update/)
  assert.doesNotMatch(denied, /取消计划，并在正文/)

  const cancelled = makeSession()
  const cancelledRecord: any = {
    plan: makePlan('wp-present-cancelled'),
    planId: 'wp-present-cancelled',
    title: '取消未完成',
    phase: 'cancelled',
    statuses: createStatuses(makePlan('wp-present-cancelled')),
    errors: [],
    degraded: false,
  }
  const cancelledRuntime: any = makeRuntime(cancelledRecord, cancelled)
  const cancelledDenial = cancelledRuntime.presentDenialReason({ session: cancelled })
  assert.match(cancelledDenial, /已取消/)
  assert.match(cancelledDenial, /不得调用 present/)
  assert.doesNotMatch(cancelledDenial, /先调用 dsh_workplan_cancel 取消计划/)

  const cancelMessage: any = buildCancelMessage('wp-cancel-copy')
  const text = String(cancelMessage?.content?.[0]?.text ?? '')
  assert.match(text, /取消不等于完成/)
  assert.match(text, /不要调用 present/)
  assert.match(text, /未完成：剩余 N 项/)
})
