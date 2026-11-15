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

test('C-Q1-05（AC-Q1-3 正例）：超判据墙钟 11 分钟且无批准 ⇒ 不得 done；blocked(criterion-overrun)；产物保留；文案指向接替', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    await withFakeNow(11 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000), '应已结算')
      assert.notEqual(row.status, 'done', '①超判据且无批准不得 done')
      assert.equal(row.criterionResult, 'unmet')
      assert.equal(row.blockedKind, 'criterion-overrun')
      assert.ok((row.criterionViolations ?? []).length >= 1, '违规审计落行')
      assert.ok(row.criterionViolations[0].wallClockMs >= 11 * 60_000, '伪造墙钟 11 分钟进入审计')
    })
    const row = await rowOf(h.runtime, h.session)
    // ② 结算文案含「未完成」或「接替」指向（replan(replace)）
    assert.match(String(row.error ?? ''), /replan\(replace\)/)
    assert.ok(/未完成|接替/.test(String(row.summary ?? '') + String(row.error ?? '')))
    // ③ artifacts 仍含 T1_report.md 且 exists=true
    assert.ok(Array.isArray(row.artifacts) && row.artifacts.some((a: any) => a.ref === 'T1_report.md' && a.exists === true), '产物保留且 exists=true')
    // ④ 不得出现「已完成/最终版」式收尾
    assert.ok(!/已完成|最终版/.test(String(row.summary ?? '')), '结算文案不得出现已完成/最终版式收尾')
  })
})

test('C-Q1-06（AC-Q1-3 对照）：先写入用户批准留痕 ⇒ done；例外指向本任务；不生成接替行；不新增违规计数', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    const ok: any = await h.runtime.updateStatus({ session: h.session }, {
      subtaskId: 'T1', extendMs: 2_000,
      criterionApproval: approval({ at: Date.now() - 1_000 }),
    })
    assert.equal(ok.ok, true, '用户批准留痕后放宽放行')
    await withFakeNow(11 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000), '应已结算')
      assert.equal(row.status, 'done', '①有批准可 done')
      assert.equal(row.criterionResult, 'exception-approved')
    })
    const row = await rowOf(h.runtime, h.session)
    // ② 例外记录可读且指向本任务
    assert.equal(row.criterionException?.approvedBy, 'user')
    assert.equal(row.subtaskId, 'T1')
    // ③ 不生成接替行（计划仍只有 T1，无 replacedBy）
    const snapshot: any = await h.runtime.statusTool({ session: h.session }, {})
    assert.equal(snapshot.statuses.length, 1)
    assert.equal(row.replacedBy, undefined)
    // ④ 不新增违规计数
    assert.ok((row.criterionViolations ?? []).length === 0, '批准路径不记违规')
  })
})

test('C-Q1-10（AC-Q1-6 边界）：第一次到点、无批准 ⇒ deadlineAt 不自动延长；无 extend/notify-expert；不走接手', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, { childTimeoutMs: 1_000 })
    await dispatch(h)
    const before = await rowOf(h.runtime, h.session)
    const deadlineAt0 = Number(before.deadlineAt)
    const startedAt0 = Number(before.startedAt)
    assert.ok(Number.isFinite(deadlineAt0), '到点前应有协商截止')
    let row: any = null
    assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row?.criterionResult != null && row.status === 'blocked' }, 15_000), '到点应结算')
    // ① deadlineAt 未被自动延长（窗口长度不变；若起点未变则截止逐字不变）
    assert.equal(Number(row.deadlineAt) - Number(row.startedAt), 1_000, '协商窗口未被延长')
    if (Number(row.startedAt) === startedAt0) assert.equal(Number(row.deadlineAt), deadlineAt0, 'deadlineAt 与到点前一致')
    // ② timeJournal 无 extend、无 notify-expert（也无批准落痕）
    const actions = (row.timeJournal ?? []).map((item: any) => item.action)
    assert.ok(!actions.includes('extend'), `不得自动 extend：${JSON.stringify(actions)}`)
    assert.ok(!actions.includes('notify-expert'), `不得通知专家延期：${JSON.stringify(actions)}`)
    assert.ok(!actions.includes('criterion-exception'))
    // ③ 状态走未完成/接替路径，takeoverRequired !== true（第一次超时不接手）
    assert.equal(row.status, 'blocked')
    assert.notEqual(row.takeoverRequired, true)
    assert.match(String(row.error ?? ''), /先向用户申请例外批准/, '生效计划第一次超时通知改为先报批（Q1-B）')
  })
})

test('C-Q1-11（AC-Q1-6 边界）：第一次到点前已批准 ⇒ deadlineAt 后移＋extend 留痕＋childNotified；未批准 extendMs 拒绝', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, { childTimeoutMs: 60_000 })
    await dispatch(h)
    const before = await rowOf(h.runtime, h.session)
    const deadlineAt0 = Number(before.deadlineAt)
    // ④ 未带批准调用 extendMs 返回 ok:false 且拒因可辨认
    const denied: any = await h.runtime.updateStatus({ session: h.session }, { subtaskId: 'T1', extendMs: 2_000, reason: '无批准放宽' })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'EXTEND_NEEDS_USER_APPROVAL')
    // 已批准：放行并留痕
    const ok: any = await h.runtime.updateStatus({ session: h.session }, {
      subtaskId: 'T1', extendMs: 2_000, criterionApproval: approval({ at: Date.now() - 1_000 }),
    })
    assert.equal(ok.ok, true)
    // ① deadlineAt 后移且大于原值
    assert.ok(Number(ok.deadlineAt) > deadlineAt0, '批准后截止后移')
    // ③ childNotified === true（延期告知语义保留）
    assert.equal(ok.childNotified, true)
    const row = await rowOf(h.runtime, h.session)
    assert.equal(Number(row.deadlineAt), Number(ok.deadlineAt))
    // ② timeJournal 新增 extend 条目且带批准来源（criterion-exception by:user）
    const journal = row.timeJournal ?? []
    assert.ok(journal.some((item: any) => item.action === 'extend'), 'extend 条目落档')
    const approvalEntry = journal.find((item: any) => item.action === 'criterion-exception')
    assert.ok(approvalEntry, '批准审计条目落档')
    assert.equal(approvalEntry.by, 'user', '批准来源=用户')
    assert.equal(approvalEntry.extendMs, 2_000)
    h.release(completed())
  })
})
