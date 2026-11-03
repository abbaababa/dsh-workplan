/*
 * [1.12.0] T11：整轮预算到点时，不能把「不是被预算打断」的行一起重置。
 *
 * 事故形态（本文件先失败、修后通过）：
 *  - `closure:'escalated'`：applyStatus 的 pending 分支会把 status 改成 pending
 *    并清空 question/options/blockedKind。于是一条正在等用户/主 Agent 拍板的
 *    请示被静默抹掉，计划变回 paused，自动续跑随后把它当普通 pending 重派。
 *  - `closure:'instructed'`：`CLOSURE_TRANSITIONS.instructed` 不含 pending，
 *    重置直接抛 INVALID_TRANSITION。异常发生在 dispatchPlan 的 catch 内部，
 *    于是 phase/结果消息/自动续跑排期全部不落，计划停在 executing。
 *  - `closure:'replanned'`：`replanned` 是终态闭包，重置同样抛
 *    INVALID_TRANSITION，一整轮派发被一条历史旧行毁掉。
 *
 * 修复判据：预算到点只重置「本次尝试被打断」的行；三类闭态行原样保留，阶段
 * 改为按 live 行计算（有 blocked → blocked，否则 paused），并把原因写进 error。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStatus,
  createStatuses,
  derivePlanSnapshot,
} from '../src/plan.js'
import { dispatchPlan } from '../src/runtime.js'

/*
 * `totalTimer` is unref'd on purpose in the runtime; without one ref'd handle
 * Node would cancel the pending test instead of letting the budget fire.
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlan(subtasks?: any[]) {
  return {
    planId: 'wp-preserve',
    sessionId: 'session-preserve',
    createdTurn: 1,
    createdAt: 1000,
    title: '预算重置保留回归',
    stages: [{
      id: 'S1',
      subtasks: subtasks ?? [
        { id: 'T1', title: '待指示', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '另一项', department: 'engineering', dependsOn: [] },
      ],
    }],
  }
}

function makeRecord(plan: any, statuses: any[], phase: string): any {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase,
    statuses,
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: false,
    resumeCount: 0,
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-preserve',
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

function hangingChild() {
  return { childId: 'child-hang', result: new Promise(() => {}), dispose: async () => {} }
}

function makeCtx() {
  return {
    logger: { warn() {} },
    subagents: { startActivation: () => hangingChild() },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

function options(session: any) {
  return {
    agent: { session, options: {} },
    signal: new AbortController().signal,
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 400,
    strictEvidence: false,
  }
}

test('预算到点不重置「待指示」行：question/options 保留，阶段按 blocked 收束', async () => {
  const plan = makePlan()
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', {
    status: 'blocked',
    closure: 'escalated',
    blockedKind: 'escalated',
    question: '是否允许跳过缺失的第三方凭证？',
    options: ['跳过并标注未验证', '改为离线样本'],
    escalatedAt: 1,
    escalationSeq: 1,
    progress: 100,
    finishedAt: 2,
  })
  // 一条上一轮被中断、仍写着 in_progress 的行：它才是应该被重置的那一类。
  statuses = applyStatus(statuses, 'T2', {
    status: 'in_progress',
    closure: 'assigned',
    childId: 'child-old',
    progress: 30,
    startedAt: 1,
  })
  const record = makeRecord(plan, statuses, 'blocked')
  const session = makeSession()

  await dispatchPlan(makeCtx(), record, options(session))

  const t1: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(t1.status, 'blocked', '等指示行不能被预算重置成 pending')
  assert.equal(t1.closure, 'escalated', 'escalated 闭包必须保留')
  assert.equal(t1.blockedKind, 'escalated')
  assert.match(String(t1.question), /第三方凭证/, '问题原文必须还在，否则请示等于被吞掉')
  assert.deepEqual(t1.options, ['跳过并标注未验证', '改为离线样本'])

  const t2: any = record.statuses.find((item: any) => item.subtaskId === 'T2')
  assert.equal(t2.status, 'pending', '真正被预算打断的行照常回到 pending 以便续跑')
  assert.equal(t2.childId, null)
  assert.equal(record.phase, 'blocked', '有等指示行时阶段必须是 blocked，自动续跑才会停下')
  assert.match(String(record.error), /本轮执行预算（\d+ 分钟）已到/)
  assert.match(String(record.error), /等待指示/)
})

test('预算到点不重置「已下发指示」行：不抛 INVALID_TRANSITION，指示原样保留', async () => {
  const plan = makePlan()
  let statuses = createStatuses(plan)
  // instruct 的正常入口是 escalated → instructed（assigned → instructed 不在迁移表里）。
  statuses = applyStatus(statuses, 'T1', {
    status: 'blocked',
    closure: 'escalated',
    blockedKind: 'escalated',
    question: '选哪个方案？',
    escalatedAt: 1,
    escalationSeq: 1,
    progress: 40,
  })
  statuses = applyStatus(statuses, 'T1', {
    status: 'in_progress',
    closure: 'instructed',
    childId: 'child-1',
    startedAt: 1,
    instruction: { text: '按方案 B 继续', at: 2, by: 'agent', delivery: 'sent' },
    instructionSeq: 2,
  })
  const record = makeRecord(plan, statuses, 'blocked')
  const session = makeSession()

  // 修前这里会抛 INVALID_TRANSITION（instructed → pending 不在迁移表里）。
  const result = await dispatchPlan(makeCtx(), record, options(session))
  assert.ok(result, '预算到点必须返回记录，而不是从 catch 里再抛一次')

  const t1: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(t1.status, 'in_progress', '已下发指示的行仍在推进，不能被重置成 pending')
  assert.equal(t1.closure, 'instructed')
  assert.match(String(t1.instruction?.text), /方案 B/)
  assert.equal(record.phase, 'paused', '其余 pending 项仍可续跑；已指示行不会被重派')
  assert.match(String(record.error), /本轮执行预算（\d+ 分钟）已到/)
})

test('预算到点不重置「已重规划」旧行：replanned 是终态，不能参与重置', async () => {
  const plan = makePlan([
    { id: 'T1', title: '旧行', department: 'engineering', dependsOn: [], supersededAt: 1, replacedBy: ['T1b'] },
    { id: 'T1b', title: '接替行', department: 'engineering', dependsOn: [] },
    { id: 'T2', title: '另一项', department: 'engineering', dependsOn: [] },
  ])
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', {
    status: 'pending',
    closure: 'replanned',
    replannedReason: '用户改需求',
    replannedAt: 3,
    replannedFrom: 'pending',
    replacedBy: ['T1b'],
    revision: 2,
  })
  const record = makeRecord(plan, statuses, 'paused')
  const session = makeSession()

  // 修前这里会抛 INVALID_TRANSITION（replanned 没有出边）。
  await dispatchPlan(makeCtx(), record, options(session))

  const t1: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(t1.closure, 'replanned', '被重规划的旧行必须保持闭态，供追溯')
  assert.equal(record.phase, 'paused')
  const snapshot = derivePlanSnapshot(record.statuses)
  assert.equal(snapshot.stats.pending, 2, 'live 行 T1b/T2 回到 pending，旧行不计入')
})
