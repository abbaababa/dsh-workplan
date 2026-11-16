/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：Q1 例外审批与结算闸（E-2/E-3）。
 * 承载用例：C-Q1-03、C-Q1-04、C-Q1-05、C-Q1-06、C-Q1-10、C-Q1-11（cases.md §6.2）。
 * 预期唯一来源：spec:73（AC-Q1-2）、spec:74（AC-Q1-3）、spec:77（AC-Q1-6）。
 * 字段绑定权威：reports/simple-criterion-v2-fields.md（criterionException/
 * criterionResult/criterionViolations；任务 ID 由行 subtaskId 承载）。
 * GAP-4 消解口径：env 生效（ACTIVE_ENV）＋伪造结算时钟（withFakeNow 11 分钟）
 * ＋运行层短窗口 childTimeoutMs=1000；「真实墙钟等满 10 分钟」端到端不可测部分
 * 在 T6 报告标 unverified（不伪造）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeCriterionException } from '../src/criterion.js'
import { normaliseStatusEntry } from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'
import {
  ACTIVE_ENV, WIDE_WINDOWS, approval, completed, completedWithEvidence, dispatch,
  dropWorkRoot, landReport, makeRuntime, rowOf, waitFor, withEnv, withFakeNow,
} from './helpers/scv2-runtime.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'

const roots: string[] = []
after(() => { for (const r of roots) dropWorkRoot(r) })
function harness(createdAt: number, options: any = {}) {
  const h = makeRuntime(createdAt, options)
  roots.push(h.workRoot)
  return h
}

test('C-Q1-03（AC-Q1-2 正例）：批准留痕五要素可读出；无留痕消毒为 null；「全部按推荐」与主 Agent 自批无效', () => {
  const full = approval({ at: 1_700_000_000_000, extendedMs: 120_000, extendedMinutes: 2, source: '用户消息 m00123' })
  const withTrail: any = normaliseStatusEntry({
    subtaskId: 'T1', status: 'done', criterionResult: 'exception-approved', criterionException: full,
  })
  // 五要素：任务 ID=subtaskId、原文=reason、时间=at、分钟数=extendedMinutes、范围=scope
  assert.equal(withTrail.subtaskId, 'T1')
  assert.equal(withTrail.criterionException.reason, full.reason)
  assert.equal(withTrail.criterionException.at, full.at)
  assert.equal(withTrail.criterionException.extendedMinutes, 2)
  assert.equal(withTrail.criterionException.scope, 'task')
  assert.equal(withTrail.criterionResult, 'exception-approved')
  // 不带留痕：消毒 fail-closed，不得当作批准
  const without = normaliseStatusEntry({ subtaskId: 'T1', status: 'done', criterionException: null })
  assert.equal(without.criterionException, null)
  assert.equal(normaliseStatusEntry({ subtaskId: 'T1', status: 'done' }).criterionException, undefined, '缺省不下发（旧载荷不变）')
  // 「全部按推荐」不得被解析成任何个别超时的批准；approvedBy 必须字面量 user
  assert.equal(sanitizeCriterionException('全部按推荐'), null)
  assert.equal(sanitizeCriterionException({ ...full, approvedBy: 'agent' }), null, '主 Agent 自批无效')
  assert.equal(sanitizeCriterionException({ ...full, approvedBy: 'lead' }), null)
  const agentTrail = normaliseStatusEntry({ subtaskId: 'T1', status: 'done', criterionException: { ...full, approvedBy: 'agent' } })
  assert.equal(agentTrail.criterionException, null, '状态行消毒同样拒绝非 user 批准')
})

test('C-Q1-04（AC-Q1-2 边界）：刷新/重启回放后五要素仍在；只追加新字段；旧记录无字段读出不报错', () => {
  const planId = 'wp-scv2-t6-replay'
  const sessionId = 'session-scv2-t6-replay'
  const plan = {
    planId, sessionId, createdTurn: 1, createdAt: 2_000_000,
    title: '回放验收', stages: [{ id: 'S1', subtasks: [{ id: 'T1', title: '任务', department: 'engineering', dependsOn: [] }] }],
  }
  const session: any = {
    id: sessionId, header: { createdAt: 2_000_000, cwd: process.cwd() }, events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) { this.events.push({ type, data }); return data },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId, sessionId, plan })}\n<!-- DSH-WORKPLAN:END -->` }] })
  seedLeaderSelfEffort(session, plan)
  const full = approval({ at: 1_400, extendedMs: 120_000, extendedMinutes: 2 })
  const legacyRow = { subtaskId: 'T1', status: 'done', progress: 100, summary: '旧记录' }
  const resultPayload = {
    kind: 'workplan-result', version: 1, planId, sessionId,
    dispatchedAt: 5_000, phase: 'done',
    stats: { total: 1, done: 1, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
    statuses: [{ ...legacyRow, criterionResult: 'exception-approved', criterionException: full, criterionViolations: [{ kind: 'criterion-overrun', at: 1_300, attempt: 1 }] }],
    errors: [], resumeCount: 0, resumeAvailable: false,
  }
  session.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify(resultPayload)}\n<!-- DSH-WORKPLAN-RESULT:END -->` }] })
  const replayed: any = reconstructFromSession(session)
  assert.ok(replayed, '持久消息必须能重建计划')
  const row = replayed.statuses.find((item: any) => item.subtaskId === 'T1')
  // ① 回放后五项仍在（不被洗掉）
  assert.equal(row.subtaskId, 'T1')
  assert.equal(row.criterionException.reason, full.reason)
  assert.equal(row.criterionException.at, full.at)
  assert.equal(row.criterionException.extendedMinutes, 2)
  assert.equal(row.criterionException.scope, 'task')
  assert.equal(row.criterionResult, 'exception-approved')
  assert.equal(row.criterionViolations.length, 1)
  // ② 只追加新字段：既有字段相对顺序与语义不变
  const legacyKeys = Object.keys(legacyRow)
  const replayedLegacyKeys = Object.keys(row).filter((k) => legacyKeys.includes(k))
  assert.deepEqual(replayedLegacyKeys, legacyKeys, '既有字段顺序不变（C08 只追加）')
  assert.equal(row.status, 'done')
  assert.equal(row.summary, '旧记录')
  // ③ 旧记录无该字段时读出不报错（兼容，全部可选）
  // 夹具修正：不得用 {...session, events:[]}——seq getter/eventAt 闭包仍指向原
  // session，旧记录回放会读到带批准的原事件（首跑 C-Q1-04 失败根因）。新建独立会话。
  const legacySession: any = {
    id: sessionId, header: { createdAt: 2_000_000, cwd: process.cwd() }, events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) { this.events.push({ type, data }); return data },
    eventAt: (seq: number) => legacySession.events[seq],
  }
  legacySession.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId, sessionId, plan })}\n<!-- DSH-WORKPLAN:END -->` }] })
  seedLeaderSelfEffort(legacySession, plan)
  legacySession.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify({ ...resultPayload, statuses: [legacyRow] })}\n<!-- DSH-WORKPLAN-RESULT:END -->` }] })
  const legacyReplay: any = reconstructFromSession(legacySession)
  const legacyReplayedRow = legacyReplay.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(legacyReplayedRow.status, 'done')
  assert.equal(legacyReplayedRow.criterionResult, undefined, '旧记录不被强加新字段')
  assert.equal(legacyReplayedRow.criterionException, undefined)
})

test('C-Q1-05（新契约）：墙钟超过旧 10 分钟判据也无批准照常 done，时间不进入验收', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    await withFakeNow(11 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000), '应已结算')
      assert.equal(row.status, 'done', '有完整证据即可 done，无需用户批准“超时”')
      assert.equal(row.criterionResult ?? null, null, '生产不再产生判据结果')
      assert.equal(row.blockedKind ?? null, null, '不得因耗时进入 criterion-overrun')
      assert.equal(row.takeoverRequired ?? false, false)
      assert.ok((row.criterionViolations ?? []).length === 0, '不记录时间违规')
      assert.ok(Array.isArray(row.artifacts) && row.artifacts.some((a: any) => a.ref === 'T1_report.md' && a.exists === true), '真实产物仍然核验')
      assert.ok(Number(row.attemptWallClockMs) >= 11 * 60_000, '耗时仍如实记录，仅作信息')
    })
  })
})

test('C-Q1-06（新契约）：extendMs/criterionApproval 不再改期或参与 done，证据齐全照常完成', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    const disabled: any = await h.runtime.updateStatus({ session: h.session }, {
      subtaskId: 'T1', extendMs: 2_000,
      criterionApproval: approval({ at: Date.now() - 1_000 }),
    })
    assert.equal(disabled.ok, false)
    assert.equal(disabled.code, 'TIME_LIMITS_DISABLED')
    assert.equal(disabled.deadlineAt ?? null, null)
    const before = await rowOf(h.runtime, h.session)
    assert.equal(before.deadlineAt ?? null, null, '旧延期不得重新武装截止')
    assert.ok(!(before.timeJournal ?? []).some((item: any) => item.action === 'extend'))
    await withFakeNow(11 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000), '应已结算')
      assert.equal(row.status, 'done', '没有时限门，证据通过即可 done')
      assert.equal(row.criterionResult ?? null, null)
      assert.equal(row.criterionException ?? null, null)
      assert.equal(row.subtaskId, 'T1')
    })
    const disabledRow = await rowOf(h.runtime, h.session)
    const snapshot: any = await h.runtime.statusTool({ session: h.session }, {})
    assert.equal(snapshot.statuses.length, 1, '不生成接替行')
    assert.equal(disabledRow.replacedBy, undefined)
    assert.equal((disabledRow.criterionViolations ?? []).length, 0)
  })
})

test('C-Q1-10（新契约）：旧 1 秒窗口到点仍执行，deadline 恒为 null；用户显式取消仍收束', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, { childTimeoutMs: 1_000 })
    await dispatch(h)
    const before = await rowOf(h.runtime, h.session)
    assert.equal(before.deadlineAt ?? null, null, '起始即无执行截止')
    assert.equal(before.executionTimeLimit, 'none')
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    const running = await rowOf(h.runtime, h.session)
    assert.equal(running.status, 'in_progress', '越过旧窗口不得自动 blocked/done')
    assert.equal(running.deadlineAt ?? null, null, '不得补写截止')
    assert.equal(Number(running.timeoutCount ?? 0), 0, '不得累计超时')
    assert.notEqual(running.takeoverRequired, true, '不得二次接手')
    const actions = (running.timeJournal ?? []).map((item: any) => item.action)
    assert.ok(!actions.includes('extend'), '不得自动延长')
    assert.ok(!actions.includes('notify-expert'), '不得通知专家超时')

    const cancelled: any = await h.runtime.cancelPlan({ session: h.session }, { reason: '无时限任务的用户显式取消' })
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.abortedRunning, true, '用户取消仍能终止真实执行')
    const record = h.runtime.state.records.get(h.session.id)
    assert.equal(record?.phase, 'cancelled', '用户取消应落为 cancelled')
    const afterCancel = await rowOf(h.runtime, h.session)
    assert.equal(afterCancel.deadlineAt ?? null, null)
    assert.equal(Number(afterCancel.timeoutCount ?? 0), 0)
  })
})

test('C-Q1-11（新契约）：带不带用户批准，extendMs 都只返回 TIME_LIMITS_DISABLED，绝不改截止', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, { childTimeoutMs: 60_000 })
    await dispatch(h)
    const before = await rowOf(h.runtime, h.session)
    assert.equal(before.deadlineAt ?? null, null)
    const denied: any = await h.runtime.updateStatus({ session: h.session }, { subtaskId: 'T1', extendMs: 2_000, reason: '无批准放宽' })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'TIME_LIMITS_DISABLED')
    const approved: any = await h.runtime.updateStatus({ session: h.session }, {
      subtaskId: 'T1', extendMs: 2_000, criterionApproval: approval({ at: Date.now() - 1_000 }),
    })
    assert.equal(approved.ok, false)
    assert.equal(approved.code, 'TIME_LIMITS_DISABLED')
    assert.equal(approved.deadlineAt ?? null, null)
    const row = await rowOf(h.runtime, h.session)
    assert.equal(row.deadlineAt ?? null, null)
    assert.ok(!(row.timeJournal ?? []).some((item: any) => item.action === 'extend' || item.action === 'criterion-exception'), '不写延期/例外审计')
    h.release(completed())
  })
})
