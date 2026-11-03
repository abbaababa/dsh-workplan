/*
 * [T6 回归] present 门禁：回放 durable `workplan-update` 时 handoffs 不能丢。
 *
 * 事故形状（wp-79c31abf，2026-11-03）：
 *   1. 结果消息里 T2 带 needs，回放时派生出 H1:open；
 *   2. 主 Agent 调 `dsh_workplan_handoff` 把 H1 置为 answered，落盘一条
 *      `workplan-update`（带 handoffs、status:'done'，但不带 closure）；
 *   3. 刷新/回放时 `reconstructFromSession` 的 patch 对象漏传 handoffs，且
 *      重放 status:'done' 会把已 reported 的行默认成 closure:'done'，触发
 *      `reported → done` 的 INVALID_TRANSITION 并被静默吞掉；
 *   4. `present` 门禁读回放结果，仍把 H1 当 open，于是拒绝交付。
 *
 * 本文件只钉住缺陷边界，不改变任何其他行为：
 *   - 用例 1：带回放 handoffs 的 durable 记录必须让 H1=answered（修复前红）；
 *   - 用例 2：真实 present 门禁不得再点名该计划的 H1（修复前红）；
 *   - 用例 3：反向对照——H1 仍是 open 时必须继续拒绝（修复前后都绿，防止
 *     “一刀切放行”式的过度修复）。
 *
 * 安装：把本文件复制到 `plugins/dsh-workplan/tests/`，用现有
 * `tsconfig.test.json` 编译后 `node --test dist-tests/tests/<本文件>.js`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildResultMessage,
  buildUpdateMessage,
  createStatuses,
  deliveryReadiness,
  derivePlanSnapshot,
  openHandoffs,
  parseUpdateMessage,
} from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'

const PLAN_ID = 'wp-t6-handoff-replay'
const SESSION_ID = 'session-t6-handoff-replay'
const NEED = '发布前重新 npm pack 1.12.0 并核对产物哈希'

function makePlan() {
  return {
    planId: PLAN_ID,
    sessionId: SESSION_ID,
    createdTurn: 1,
    createdAt: 1000,
    title: 'handoffs 回放回归',
    contradictions: { primary: { statement: '已答复的跨部门需求刷新后仍是 answered' } },
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

function makeSession() {
  const events: any[] = []
  return {
    id: SESSION_ID,
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function doneStatuses(plan: any) {
  const statuses: any[] = createStatuses(plan)
  for (const item of statuses) {
    item.status = 'done'
    /*
     * 事故现场：结果消息是在 finishRound 把 done 行标为 reported 之后才写的，
     * 所以载荷里带 closure:'reported'。回放该消息后行仍是 reported；随后
     * durable update 若重放 status:'done' 又不带 closure，才会撞上
     * reported → done 的非法迁移。
     */
    item.closure = 'reported'
    item.progress = 100
    item.verification = 'structured'
    item.acceptance = [{ criterion: `${item.subtaskId} 验收`, result: 'pass', evidence: 'npm test 通过' }]
    item.missingArtifacts = []
  }
  // 子 Agent 在结果块里提出的跨部门需求；回放时应派生出一条 open handoff。
  statuses[1].needs = [NEED]
  return statuses
}

/** plan 消息 + 结果消息；此时 H1 由 needs 派生、状态为 open。 */
function seedAnsweredSession() {
  const plan = makePlan()
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  const statuses = doneStatuses(plan)
  session.append('user/message', buildResultMessage({
    planId: PLAN_ID,
    sessionId: SESSION_ID,
    dispatchedAt: 2000,
    statuses,
    errors: [],
    stats: derivePlanSnapshot(statuses).stats,
    phase: 'executing',
  }))
  const before: any = reconstructFromSession(session)
  assert.equal(before.statuses[1].handoffs?.[0]?.status, 'open',
    '前置条件：needs 必须先派生出一条 open handoff（这是缺陷现场的形状）')
  return { plan, session, before }
}

/** 与 `dsh_workplan_handoff(resolve)` 落盘的消息同形：带 handoffs、status:'done'、无 closure。 */
function appendHandoffResolve(session: any, before: any) {
  const current = before.statuses[1]
  const answered = {
    id: 'H1',
    request: NEED,
    department: 'engineering',
    status: 'answered',
    response: '已在 1.12.0 发布流程中重新 pack，产物哈希见发布记录。',
    at: 3000,
    updatedAt: 3000,
    by: 'agent',
  }
  const message = buildUpdateMessage({
    planId: PLAN_ID,
    subtaskId: 'T2',
    status: current.status,
    handoffs: [answered],
    revision: Number(current.revision ?? 0) + 1,
  })
  // 缺陷现场的关键形状之一：durable 记录没有 closure，所以回放重放 status 时
  // 会把已经 reported 的行默认成 done，撞上非法迁移。
  const payload = parseUpdateMessage(message)
  assert.ok(payload, 'durable update 必须能被回放解析')
  assert.equal(Array.isArray(payload.handoffs), true, 'durable 记录必须携带 handoffs')
  assert.equal('closure' in payload, false, '缺陷场景要求该 durable 记录不带 closure')
  session.append('user/message', message)
  return message
}

function runtimeFor() {
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    get: () => undefined,
  }
  return createWorkplanRuntime(ctx, { version: 'test-version' }) as any
}

test('A1/A2 回放 durable handoff：H1 必须保持 answered，交付就绪必须为 true', () => {
  const { session, before } = seedAnsweredSession()
  appendHandoffResolve(session, before)

  const record: any = reconstructFromSession(session)
  const row = record.statuses[1]
  const h1 = row.handoffs?.[0]
  assert.equal(h1?.status, 'answered',
    `回放丢失 handoffs：durable 记录里的 H1=answered 没有落地（当前 H1=${String(h1?.status)}）。`
    + '根因是 runtime.ts 回放 patch 未传 handoffs；修复前 present 门禁会据此误判。')
  assert.deepEqual(openHandoffs(row), [], 'answered 的 handoff 不得继续挡交付')
  const readiness = deliveryReadiness(derivePlanSnapshot(record.statuses), { phase: record.phase })
  assert.equal(readiness.ready, true,
    `交付就绪必须为 true，实际 blockers=${JSON.stringify(readiness.blockers)}`)
})

test('A2 真实 present 门禁：修复前点名 H1，修复后不再拒绝该计划', () => {
  const { session, before } = seedAnsweredSession()
  appendHandoffResolve(session, before)

  const runtime = runtimeFor()
  const verdict = runtime.presentDenialVerdict({ session })
  assert.equal(verdict, undefined,
    verdict
      ? `present 门禁仍拒绝：code=${verdict.code} message=${verdict.message}`
      : '')
})

test('A3 反向对照：H1 仍为 open 时 present 必须继续拒绝（防过度修复）', () => {
  const { session } = seedAnsweredSession()
  // 不追加 handoff resolve 消息：H1 保持 open。
  const runtime = runtimeFor()
  const verdict = runtime.presentDenialVerdict({ session })
  assert.ok(verdict, 'H1 未处置时 present 必须被拒绝')
  assert.equal(verdict.code, 'EVIDENCE_GAP', `期望 EVIDENCE_GAP，实际 ${verdict.code}`)
  assert.match(verdict.message, /跨部门需求未落实（H1）/, '拒绝文案必须点名未落实的 H1')
})
