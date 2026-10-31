/*
 * [1.8.18] 已交付文件的写保护（T7-N2）回归。
 *
 * 事故 session-99984ebd（2026-10-31）：
 *  - 12:04:22 用 present 交付报告，模型 12:04:25 收尾；
 *  - 12:12:34 后台子 Agent 结算唤醒第二个回合，12:13:00 与 12:13:08 两次
 *    `edit` 原地改写**同一个**已交付路径，卡片背后的文件因此变了。
 *
 * 根因不是「模型不听话」，而是生命周期里没有这一层：
 *  1. `present` 不复制内容（工具描述：the user opens the current files）；
 *  2. `write`/`edit`/`str_replace_editor` 不校验路径是否已经交付；
 *  3. 插件此前只守 dispatch 与 present，写工具完全在闸门之外。
 *
 * 本文件钉住修复后的契约：
 *  - present 时点已定义、至今未就绪的计划 ⇒ 拒绝改写该路径，并给出续跑/取消出口；
 *  - present 之后才定义的新计划 ⇒ 放行（用户要求改版走新计划，不被写保护卡死）；
 *  - 计划已就绪、已取消、非根会话、plan 模式、其它路径、非写工具 ⇒ 放行；
 *  - 相对/绝对路径按 session.header.cwd 归一后比较。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { fileWriteGuardReason } from '../src/host.js'

const WORKSPACE = '/work'
const REPORT = `${WORKSPACE}/report.md`
const SESSION_ID = 'session-write-guard'

function makePlan(planId = 'wp-write-guard', sessionId = SESSION_ID) {
  return {
    planId,
    sessionId,
    createdTurn: 1,
    createdAt: 1000,
    title: '已交付文件写保护回归',
    contradictions: { primary: { statement: '交付后不得原地改写' } },
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

function makeRecord(plan: any): any {
  const statuses: any[] = createStatuses(plan)
  statuses[0].status = 'done'
  statuses[0].verification = 'structured'
  statuses[0].acceptance = [{ criterion: '第一步验收', result: 'pass', evidence: '测试通过' }]
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'paused',
    statuses,
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: true,
  }
}

function markDelivered(record: any) {
  for (const item of record.statuses) {
    item.status = 'done'
    item.progress = 100
    item.verification = 'structured'
    item.acceptance = [{ criterion: `${item.subtaskId} 验收`, result: 'pass', evidence: 'npm test 通过' }]
    item.missingArtifacts = []
  }
  record.phase = 'done'
  return record
}

function makeSession(header: any = { createdAt: 1000 }) {
  const events: any[] = []
  return {
    id: SESSION_ID,
    header,
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
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, cwd: WORKSPACE })
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

function agentFor(session: any) {
  return { session }
}

function presentedPlan(session: any, plan: any) {
  session.append('user/message', buildPlanMessage(plan, { totalBudgetMinutes: 20 }))
}

function presentedFile(session: any, path: string) {
  session.append('deliverables/presented', {
    turn: 1,
    callId: 'call_present_1',
    files: [{ path, description: '交付报告' }],
  })
}

test('未就绪计划 + 已交付路径：拒绝改写并给出续跑/取消出口', () => {
  const plan = makePlan()
  const session = makeSession({ createdAt: 1000, cwd: WORKSPACE })
  presentedPlan(session, plan)
  presentedFile(session, REPORT)
  const runtime = makeRuntime(makeRecord(plan), session)

  const reason = runtime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT })
  assert.equal(typeof reason, 'string')
  assert.match(reason, /wp-write-guard/)
  assert.match(reason, /dsh_workplan_dispatch/)
  assert.match(reason, /dsh_workplan_cancel/)
  assert.match(reason, /present/)
})

test('相对路径与绝对路径按 session.header.cwd 归一后仍然命中', () => {
  const plan = makePlan()
  const session = makeSession({ createdAt: 1000, cwd: WORKSPACE })
  presentedPlan(session, plan)
  presentedFile(session, 'report.md')
  const runtime = makeRuntime(makeRecord(plan), session)

  assert.equal(typeof runtime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT }), 'string')
  assert.equal(typeof runtime.presentedWriteDenialReason(agentFor(session), { path: `${WORKSPACE}/nested/../report.md` }), 'string')
})

test('present 之后才定义的新计划不在快照里，不拦改写', () => {
  const session = makeSession({ createdAt: 1000, cwd: WORKSPACE })
  presentedFile(session, REPORT)
  const latePlan = makePlan('wp-after-present')
  presentedPlan(session, latePlan)
  const runtime = makeRuntime(makeRecord(latePlan), session)

  assert.equal(runtime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT }), undefined)
})

test('计划已就绪：放行', () => {
  const plan = makePlan()
  const session = makeSession({ createdAt: 1000, cwd: WORKSPACE })
  presentedPlan(session, plan)
  presentedFile(session, REPORT)
  const runtime = makeRuntime(markDelivered(makeRecord(plan)), session)

  assert.equal(runtime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT }), undefined)
})

test('计划已取消：放行（cancel 是显式出路，不是交付许可也只是停止执行）', () => {
  const plan = makePlan()
  const session = makeSession({ createdAt: 1000, cwd: WORKSPACE })
  presentedPlan(session, plan)
  presentedFile(session, REPORT)
  const record = makeRecord(plan)
  record.phase = 'cancelled'
  const runtime = makeRuntime(record, session)

  assert.equal(runtime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT }), undefined)
})

test('非根会话、plan 模式、其它路径、空参数：放行', () => {
  const plan = makePlan()
  const childSession = makeSession({ createdAt: 1000, cwd: WORKSPACE, parentSession: 'parent-session' })
  presentedPlan(childSession, plan)
  presentedFile(childSession, REPORT)
  const runtime = makeRuntime(makeRecord(plan), childSession)
  assert.equal(runtime.presentedWriteDenialReason(agentFor(childSession), { file_path: REPORT }), undefined)

  const session = makeSession({ createdAt: 1000, cwd: WORKSPACE })
  presentedPlan(session, plan)
  presentedFile(session, REPORT)
  const rootRuntime = makeRuntime(makeRecord(plan), session)
  assert.equal(rootRuntime.presentedWriteDenialReason(agentFor(session), { file_path: `${WORKSPACE}/other.md` }), undefined)
  assert.equal(rootRuntime.presentedWriteDenialReason(agentFor(session), {}), undefined)
  assert.equal(rootRuntime.presentedWriteDenialReason(agentFor(session), undefined), undefined)

  const planModeCtx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('never') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    get: () => ({ snapshot: () => ({ values: { plan: { active: true } } }) }),
  }
  const planModeRuntime: any = createWorkplanRuntime(planModeCtx, { totalTimeoutMs: 60_000, cwd: WORKSPACE })
  planModeRuntime.state.records.set(session.id, makeRecord(plan))
  assert.equal(planModeRuntime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT }), undefined)
})

test('fileWriteGuardReason 只接管三个写工具，不改变 present/dispatch 的原有语义', () => {
  const plan = makePlan()
  const session = makeSession({ createdAt: 1000, cwd: WORKSPACE })
  presentedPlan(session, plan)
  presentedFile(session, REPORT)
  const runtime = makeRuntime(makeRecord(plan), session)

  for (const name of ['write', 'edit']) {
    const reason = fileWriteGuardReason({ name, agent: agentFor(session), arguments: { file_path: REPORT } }, runtime)
    assert.equal(typeof reason, 'string', name)
  }
  const strReplace = fileWriteGuardReason(
    { name: 'str_replace_editor', agent: agentFor(session), arguments: { path: REPORT } },
    runtime,
  )
  assert.equal(typeof strReplace, 'string')

  assert.equal(fileWriteGuardReason({ name: 'present', agent: agentFor(session) }, runtime), undefined)
  assert.equal(fileWriteGuardReason({ name: 'dsh_workplan_dispatch', agent: agentFor(session) }, runtime), undefined)
  assert.equal(fileWriteGuardReason({ name: 'read', agent: agentFor(session), arguments: { file_path: REPORT } }, runtime), undefined)
})
