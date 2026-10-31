/*
 * [1.8.18 草案] present 闸门的证据级与空计划边界。
 *
 * A1/A2 钉住 1.8.16/1.8.13 已修复的两条事故形状，防止回归；
 * A3 钉住 U6（空计划假拒绝），在 P2 前应为红；
 * A4 钉住 plan-mode 防死锁例外（host.ts:495-497），删 runtime.ts:3062 会红；
 * A5 证明 P2 的过滤依据是计划定义，而不是 statuses 长度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCancelMessage,
  buildPlanMessage,
  buildResultMessage,
  createStatuses,
  derivePlanSnapshot,
} from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { toolGuardReason } from '../src/host.js'

function makePlan(planId: string, count: number) {
  return {
    planId,
    sessionId: 'session-present-gate',
    createdTurn: 1,
    createdAt: 1000,
    title: `present 闸门 ${planId}`,
    contradictions: { primary: { statement: '计划未完成不得 present' } },
    stages: count === 0 ? [] : [{
      id: 'S1',
      name: '实施',
      subtasks: Array.from({ length: count }, (_, i) => ({
        id: `T${i + 1}`,
        title: `第 ${i + 1} 步`,
        department: 'engineering',
        dependsOn: i === 0 ? [] : [`T${i}`],
      })),
    }],
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-present-gate',
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeCtx(projections?: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('never dispatch') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    get: (name: string) => (name === 'sessionProjections' ? projections : undefined),
  }
}

function runtimeFor(projections?: any) {
  return createWorkplanRuntime(makeCtx(projections), { version: 'test' }) as any
}

function markDone(status: any, verification = 'structured') {
  status.status = 'done'
  status.progress = 100
  status.verification = verification
  status.acceptance = verification === 'structured'
    ? [{ criterion: `${status.subtaskId} 验收`, result: 'pass', evidence: 'test' }]
    : []
  status.missingArtifacts = []
}

function settle(session: any, plan: any, statuses: any[]) {
  session.append('user/message', buildResultMessage({
    planId: plan.planId,
    sessionId: session.id,
    dispatchedAt: 2000,
    statuses,
    errors: [],
    stats: derivePlanSnapshot(statuses).stats,
    phase: 'executing',
  }))
}

function replay(plans: any[], statusesByPlan: Record<string, any[]>, turn = 1) {
  const session = makeSession()
  for (const plan of plans) session.append('user/message', buildPlanMessage(plan))
  session.append('turn/start', { turn })
  for (const plan of plans) {
    const statuses = statusesByPlan[plan.planId]
    if (statuses) settle(session, plan, statuses)
  }
  return session
}

test('A1 计划 10/13 时 present 必须被拒，最后定义的计划就绪也不能放行', () => {
  const planA = makePlan('wp-a', 13)
  const planB = makePlan('wp-b', 1)
  const statusesA: any[] = createStatuses(planA)
  statusesA.forEach((item: any, i: number) => { if (i < 10) markDone(item) })
  const statusesB: any[] = createStatuses(planB)
  markDone(statusesB[0])
  const session = replay([planA, planB], { 'wp-a': statusesA, 'wp-b': statusesB })

  const reason = runtimeFor().presentDenialReason({ session })
  assert.ok(reason, '未完成计划不得放行')
  assert.match(reason, /wp-a/)
  assert.match(reason, /10\/13/)
  assert.match(reason, /T11/)
  assert.doesNotMatch(reason, /wp-b/, '不能被最后定义、已就绪的计划带过')
})

test('A2 全部 done 但一项无结构化证据/无验收时 present 必须被拒', () => {
  const plan = makePlan('wp-a', 13)
  const statuses: any[] = createStatuses(plan)
  statuses.forEach((item: any) => markDone(item))
  statuses[12].verification = 'unverified'
  statuses[12].acceptance = []
  const session = replay([plan], { 'wp-a': statuses })

  const reason = runtimeFor().presentDenialReason({ session })
  assert.ok(reason, '全部 done 不等于可交付')
  assert.match(reason, /证据未通过/)
  assert.match(reason, /T13 自检标记为未验证/)
  assert.match(reason, /T13 未提供验收项/)
  assert.match(reason, /dsh_workplan_update/)
})

test('A3 空计划 present 必须放行，不出现 0 个子任务文案；取消后仍放行', () => {
  const empty = makePlan('wp-empty', 0)

  // A3-1：只有空计划
  const onlyEmpty = makeSession()
  onlyEmpty.append('user/message', buildPlanMessage(empty))
  assert.equal(runtimeFor().presentDenialReason({ session: onlyEmpty }), undefined,
    '空计划不是交付对象，不得永久拦')

  // A3-2：空计划 + 真实未完成计划：只点名真实计划
  const real = makePlan('wp-real', 1)
  const realStatuses: any[] = createStatuses(real)
  const mixed = replay([empty, real], { 'wp-real': realStatuses })
  const mixedReason = runtimeFor().presentDenialReason({ session: mixed })
  assert.match(mixedReason, /wp-real/)
  assert.doesNotMatch(mixedReason, /wp-empty/)
  assert.match(mixedReason, /0\/1/)

  // A3-3：同一 runtime 先判空计划，再取消，仍不得转为拒绝（E5 缓存路径）
  const cached = makeSession()
  cached.append('user/message', buildPlanMessage(empty))
  const rt = runtimeFor()
  assert.equal(rt.presentDenialReason({ session: cached }), undefined)
  cached.append('user/message', buildCancelMessage('wp-empty'))
  assert.equal(rt.presentDenialReason({ session: cached }), undefined)
})

test('A4 plan 模式 + 未完成时 present 放行且 dispatch 被拒（防死锁不变量）', () => {
  const plan = makePlan('wp-a', 1)
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  const projections = { snapshot: () => ({ values: { plan: { active: true } } }) }
  const runtime = runtimeFor(projections)

  const present = toolGuardReason({ name: 'present', agent: { session } }, runtime)
  const dispatch = toolGuardReason({ name: 'dsh_workplan_dispatch', agent: { session } }, runtime)
  assert.equal(present, undefined, 'plan 模式下 present 保持可用（host.ts:495-497）')
  assert.ok(dispatch, 'plan 模式下 dispatch 必须被拒')
  assert.ok(!(present && dispatch), '不得同时拒绝 present 与 dispatch（死锁）')
})

test('A5 定义 1 子任务但状态未派生时仍拒绝（过滤依据是定义，不是 statuses）', () => {
  const plan = makePlan('wp-c', 1)
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))

  const reason = runtimeFor().presentDenialReason({ session })
  assert.ok(reason)
  assert.match(reason, /0\/1/)
  assert.match(reason, /未完成/)
})

test('A6 取消未完成计划后，重启回放仍拒绝 present（取消不改变未完成）', () => {
  const plan = makePlan('wp-cancel', 3)
  const statuses: any[] = createStatuses(plan)
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  settle(session, plan, statuses)
  session.append('user/message', buildCancelMessage('wp-cancel'))

  /*
   * No turn/start event: this is the fresh-runtime replay after a restart.
   * The live record and the turn attribution are both gone, which is exactly
   * the T5 E1 shape that used to be allowed.
   */
  const reason = runtimeFor().presentDenialReason({ session })
  assert.ok(reason, '取消后重启不得放行')
  assert.match(reason, /wp-cancel/)
  assert.match(reason, /已取消/)
  assert.match(reason, /0\/3/)
})

test('A7 旧计划取消后，较新的已就绪计划仍可交付（不因历史取消死锁）', () => {
  const oldPlan = makePlan('wp-old', 2)
  const oldStatuses: any[] = createStatuses(oldPlan)
  const newPlan = makePlan('wp-new', 1)
  const newStatuses: any[] = createStatuses(newPlan)
  markDone(newStatuses[0])

  const session = makeSession()
  session.append('user/message', buildPlanMessage(oldPlan))
  settle(session, oldPlan, oldStatuses)
  session.append('user/message', buildCancelMessage('wp-old'))
  session.append('user/message', buildPlanMessage(newPlan))
  settle(session, newPlan, newStatuses)

  assert.equal(runtimeFor().presentDenialReason({ session }), undefined,
    '较新的已就绪计划必须能交付')
})

test('A8 取消真实计划后用空计划作挡箭牌仍拒绝（空计划不参与门禁）', () => {
  const real = makePlan('wp-real', 1)
  const statuses: any[] = createStatuses(real)
  const empty = makePlan('wp-empty-shield', 0)

  const session = makeSession()
  session.append('user/message', buildPlanMessage(real))
  settle(session, real, statuses)
  session.append('user/message', buildCancelMessage('wp-real'))
  session.append('user/message', buildPlanMessage(empty))

  const reason = runtimeFor().presentDenialReason({ session })
  assert.ok(reason, '空计划不能把已取消的真实计划洗白')
  assert.match(reason, /wp-real/)
  assert.doesNotMatch(reason, /wp-empty-shield/)
})
