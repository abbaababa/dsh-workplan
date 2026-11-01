/*
 * [W5 / T9] 真实取消信封联测：cancel → present → dispatch 不再双向死锁。
 *
 * 事故（session-d1e7bc05，2026-11-01 turn 26）：
 *   1. 计划 wp-bea31753 从未派发（0/8），模型在 turn 26 取消它；
 *   2. 同一回合再调 present（seq 7174），被拒（seq 7175 isError）：
 *      「计划 wp-bea31753… 已取消，但只完成 0/8…不得调用 present」；
 *   3. dispatch 对同一计划回 `PLAN_CANCELLED`；
 *   4. 收尾闸门又连续注入两条「【计划已取消但未完成 · 禁止收尾】」
 *      （seq 7184/7191）——present 不能、dispatch 不能、回合也不许收尾。
 *
 * 1.9.0（f12c9da）的修法是「终态解耦」：终态计划不再被自动选为判定对象，
 * 只有本回合结构化点名时才判定。本文件用**真实 1.8.19 信封的逐字字节**
 * （tests/fixtures/w5-cancel-event-7168.json，取自 root.jsonl seq 7168）
 * 复现这条链路，钉住四件事：
 *
 *  W5-1 真实信封的字段契约与 replay 读法（旧信封信封必须读成 cancelled）；
 *  W5-2 事故同构链路：取消后 present 放行、dispatch 仍按设计拒绝、不再 steer；
 *  W5-3 生产写路径写出的信封与 1.8.19 真实信封**同一 schema**（无新增必填字段）；
 *  W5-4 D2 未放宽：本回合点名的 cancelled 仍硬拦 present，收尾仍会 steer，
 *       出口是「未完成：剩余 N 项」而不是交付。
 *
 * 「死锁已消除」在这里的判据是：同一条真实输入下，present 与 dispatch 不再
 * 同时封死（present 可交付、dispatch 拒绝是终态语义），且收尾闸门不再禁止
 * 回合收尾；点名场景仍双向拒绝属设计保留（D2），其合法出口是如实报告未完成。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'

import {
  PLAN_VERSION,
  buildCancelMessage,
  buildPlanMessage,
  buildResultMessage,
  createStatuses,
  derivePlanSnapshot,
  parseCancelMessage,
} from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { computeMappingDigest } from '../src/supersede-digest.js'

const SESSION_ID = 'session-d1e7bc05-fd0c-4dc0-acd0-f42c391bd443'
const CANCELLED_PLAN = 'wp-bea31753-ec5f-4d97-89b6-c673308113e3'
const DONE_PLAN = 'wp-4ad0038f-ef9c-4e9b-8907-9a3f414fe246'

interface Fixture {
  provenance: Record<string, string | number>
  event: { type: string; data: any }
}

const FIXTURE: Fixture = JSON.parse(readFileSync(
  path.resolve(process.cwd(), 'tests', 'fixtures', 'w5-cancel-event-7168.json'),
  'utf8',
))

function realCancelEnvelope() {
  return FIXTURE.event.data
}

function makePlan(planId: string, count: number, turn = 1) {
  return {
    planId,
    sessionId: SESSION_ID,
    createdTurn: turn,
    createdAt: 1000,
    title: `W5 取消信封联测 ${planId}`,
    contradictions: { primary: { statement: '取消不等于完成：未完成项不得交付' } },
    stages: [{
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
    id: SESSION_ID,
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeCtx() {
  return {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('W5: 联测不得启动部门 Agent') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    get: () => undefined,
    cwd: process.cwd(),
  }
}

function runtimeFor() {
  return createWorkplanRuntime(makeCtx(), { version: 'w5-test' }) as any
}

function markDone(status: any) {
  status.status = 'done'
  status.progress = 100
  status.verification = 'structured'
  status.acceptance = [{ criterion: `${status.subtaskId} 验收`, result: 'pass', evidence: 'W5 联测' }]
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

test('W5-1 真实 1.8.19 取消信封：字段契约不变，replay 读作 cancelled', () => {
  const payload = parseCancelMessage(realCancelEnvelope())
  assert.ok(payload, '真实信封必须能被当前解析器读出')
  assert.deepEqual(Object.keys(payload).sort(), ['cancelledAt', 'kind', 'planId', 'reason', 'version'],
    '1.8.19 真实信封只有 5 个字段；新增字段必须是增量而不是改写')
  assert.equal(payload.kind, 'workplan-cancel')
  assert.equal(payload.version, PLAN_VERSION)
  assert.equal(payload.planId, CANCELLED_PLAN)

  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan(CANCELLED_PLAN, 8)))
  const donePlan = makePlan(DONE_PLAN, 8, 2)
  session.append('user/message', buildPlanMessage(donePlan))
  const statuses = createStatuses(donePlan)
  statuses.forEach(markDone)
  settle(session, donePlan, statuses)
  session.append('turn/start', { turn: 2 })
  session.append('user/message', realCancelEnvelope())

  const record = reconstructFromSession(session, CANCELLED_PLAN)
  assert.ok(record, '真实信封必须能重建出计划记录')
  assert.equal(record.phase, 'cancelled', '旧信封的回放语义必须仍是 cancelled')
  assert.equal(record.cancelled, true)
  assert.equal(record.cancelRecorded, true, '旧信封没有写入见证字段，必须由 replay 补出')
  assert.equal(record.superseded, false, '旧信封不得被误读成 superseded')
  assert.equal(record.statuses.filter((item: any) => item.status === 'done').length, 0)
  const doneRecord = reconstructFromSession(session, DONE_PLAN)
  assert.ok(doneRecord)
  assert.equal(doneRecord.phase, 'done', '同会话的完成计划不受影响')
})

test('W5-2 事故同构：取消后被取消计划成为 live，present 放行、dispatch 仍拒、不再 steer', async () => {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan(CANCELLED_PLAN, 8)))
  const donePlan = makePlan(DONE_PLAN, 8, 2)
  session.append('user/message', buildPlanMessage(donePlan))
  const statuses = createStatuses(donePlan)
  statuses.forEach(markDone)
  settle(session, donePlan, statuses)
  session.append('turn/start', { turn: 2 })
  session.append('user/message', realCancelEnvelope())

  const runtime = runtimeFor()
  // 事故路径：取消工具把被取消的计划 adopted 成 live 记录（seq 7167 的真实效果）。
  const cancelled = await runtime.cancelPlan({ session }, { planId: CANCELLED_PLAN, reason: 'W5 联测' })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.alreadyCancelled, true, '真实信封已落盘，取消必须幂等')
  assert.equal(cancelled.cancelRecorded, true)
  assert.equal(runtime.state.records.get(session.id).plan.planId, CANCELLED_PLAN)

  // 死锁点：present 不再因为它 0/8 被永久挡门（旧版此处返回 seq 7175 的 isError）。
  assert.equal(runtime.presentDenialVerdict({ session }), undefined,
    '未点名的终态计划不挡门：同会话的 8/8 计划必须可交付')

  // dispatch 的终态拒绝是设计保留的语义，不是死锁：调用方拿到明确码值。
  const dispatch = await runtime.dispatchTool({ session }, { planId: CANCELLED_PLAN }, undefined)
  assert.equal(dispatch.ok, false)
  assert.equal(dispatch.code, 'PLAN_CANCELLED')
  assert.equal(dispatch.remaining, 8)
  assert.match(dispatch.error, /取消只停止执行/)

  // 收尾闸门不再为未点名的终态计划注入「禁止收尾」。
  const steered: any[] = []
  runtime.state.activeTurns.set(session.id, 2)
  await runtime.onTurnStopping({ agent: { session, steer: (m: any) => steered.push(m) }, turn: 2 })
  assert.equal(steered.length, 0, '终态解耦后不得再 steer（事故 seq 7184/7191 的两条提醒不再出现）')
})

test('W5-3 生产写路径：新写信封与 1.8.19 真实信封同一 schema，冷启动可回放', async () => {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan(CANCELLED_PLAN, 8)))
  session.append('turn/start', { turn: 2 })

  const runtime = runtimeFor()
  const result = await runtime.cancelPlan({ session }, { planId: CANCELLED_PLAN, reason: 'W5 联测：生产写路径' })
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'cancelled')
  assert.equal(result.cancelRecorded, true)

  const written = parseCancelMessage(session.events[session.events.length - 1].data)
  assert.ok(written)
  assert.deepEqual(Object.keys(written).sort(), ['cancelledAt', 'kind', 'planId', 'reason', 'version'],
    '生产写路径不得给普通取消新增字段（旧解析器按 kind 读，安全降级的前提）')
  assert.equal(written.kind, 'workplan-cancel')
  assert.equal(written.version, PLAN_VERSION)
  assert.equal(written.planId, CANCELLED_PLAN)
  assert.equal(written.reason, 'W5 联测：生产写路径')

  // 冷启动 runtime：只有日志，没有内存状态。
  const cold = runtimeFor()
  assert.equal(cold.presentDenialVerdict({ session }), undefined, '重启后取消不得复活成永久挡门项')
  const dispatch = await cold.dispatchTool({ session }, { planId: CANCELLED_PLAN }, undefined)
  assert.equal(dispatch.code, 'PLAN_CANCELLED')
  const coldRecord = reconstructFromSession(session, CANCELLED_PLAN)
  assert.ok(coldRecord)
  assert.equal(coldRecord.cancelRecorded, true)
})

test('W5-4 D2 未放宽：本回合点名的 cancelled 仍硬拦 present 并 steer，出口是如实报告', async () => {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan(CANCELLED_PLAN, 8)))
  session.append('user/message', realCancelEnvelope())
  // 第 3 回合点名：结果消息把 planId 带进当前回合（结算/续跑唤醒的真实形状）。
  session.append('turn/start', { turn: 3 })
  settle(session, makePlan(CANCELLED_PLAN, 8), createStatuses(makePlan(CANCELLED_PLAN, 8)))

  const runtime = runtimeFor()
  await runtime.cancelPlan({ session }, { planId: CANCELLED_PLAN, reason: 'W5 联测' })
  const verdict = runtime.presentDenialVerdict({ session })
  assert.ok(verdict, '点名场景不得因为 W5-2 的放行而被一并放宽')
  assert.equal(verdict.code, 'CANCELLED_NAMED')
  assert.match(verdict.message, /已取消，但只完成 0\/8/)
  assert.match(verdict.message, /未完成：剩余 N 项/)

  const dispatch = await runtime.dispatchTool({ session }, { planId: CANCELLED_PLAN }, undefined)
  assert.equal(dispatch.code, 'PLAN_CANCELLED')

  const steered: any[] = []
  runtime.state.activeTurns.set(session.id, 3)
  await runtime.onTurnStopping({ agent: { session, steer: (m: any) => steered.push(m) }, turn: 3 })
  assert.equal(steered.length, 1, '点名场景仍要求按未完成口径收尾')
  assert.match(JSON.stringify(steered[0]), /禁止收尾/)
  await runtime.onTurnStopping({ agent: { session, steer: (m: any) => steered.push(m) }, turn: 3 })
  await runtime.onTurnStopping({ agent: { session, steer: (m: any) => steered.push(m) }, turn: 3 })
  assert.equal(steered.length, 2, 'steer 上限仍是 2，不会把会话锁死')
})

test('W5-5 superseded 是增量字段：kind/version 与真实取消信封一致，旧读侧可按 cancelled 降级', () => {
  const mapping = [
    { from: 'T1', to: 'T1', basis: '同一交付责任' },
    { from: 'T2', to: 'T2', basis: '同一交付责任' },
  ]
  const superseded = parseCancelMessage(buildCancelMessage('wp-w5-a', '责任转移', {
    disposition: 'superseded',
    supersededAt: 3000,
    supersededBy: { planId: 'wp-w5-b', mapping, digest: computeMappingDigest(mapping) },
  }))
  assert.ok(superseded)
  assert.equal(superseded.kind, 'workplan-cancel', '不得新增第二种信封 kind：旧读侧按 kind 识别')
  assert.equal(superseded.version, PLAN_VERSION, 'version 是 schema 版本，不得跟随插件包版本漂移')
  assert.equal(superseded.disposition, 'superseded')
  const base = parseCancelMessage(realCancelEnvelope())
  const baseKeys = new Set(Object.keys(base))
  assert.deepEqual(
    Object.keys(superseded).filter((key) => !baseKeys.has(key)).sort(),
    ['disposition', 'supersededAt', 'supersededBy'],
    '相对 1.8.19 真实信封只允许这三个增量字段，且旧解析器不认识它们时按 cancelled 读',
  )
})
