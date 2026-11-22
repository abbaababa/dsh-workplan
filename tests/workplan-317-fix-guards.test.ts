/*
 * [3.1.7] 本轮「按全部建议执行」修复的守门测试（P0/P1/P2/P3 关键不变量）。
 *
 * 钉住的契约（每条对应 T12 范围决策单的一个必改编号）：
 *  - U-64/U-68：delegates 条目级单调合并——低秩不覆盖高秩、同秩只认更晚时间戳、
 *    待指示条目绝不被覆盖、已 sent 通知标记不回退、childId 稳定；
 *    新一轮尝试（不同 childId + running）例外，必须取代旧终态（重派可再跑）。
 *  - U-71：负责人换主留档 childIdHistory（≤8 条、非法整体丢弃）。
 *  - U-05：status 迁移守卫——done→in_progress 拒绝，同值/合法边放行。
 *  - U-06：从非 done 进入 done 是新完成，closure 回 'done' 中间态（不继承 reported）。
 *  - U-18：normaliseStatusEntry 对 'Done'/'DONE ' 脏值保守归一，不再误降 pending。
 *  - U-19：blocked（非 escalated）把 report/reportedAt 迁入 lastReport/lastReportedAt。
 *  - U-38：回放 update 白名单补齐 13 个闭环字段（question/options/ackedAt 等不丢）。
 *  - U-43：WAL 写前日志 + ack + 三道归属闸（planCreatedAt/walSeq/严格前进）。
 *  - U-25/U-34：第二次 steer 短提醒保活关键串、不再逐字重发整段正文。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyStatus,
  buildPlanMessage,
  buildResultMessage,
  buildStopSteerText,
  buildUpdateMessage,
  computeStats,
  createStatuses,
  mergeDelegateEntriesMonotonic,
  normaliseStatusEntry,
} from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'
import { appendWorkplanUpdateWAL, appendWorkplanUpdateWALAck, readNoticeLedger } from '../src/notice-ledger.js'

function makePlan(planId: string, createdAt = 1000) {
  return {
    planId,
    sessionId: 'session-317',
    createdTurn: 1,
    createdAt,
    title: '3.1.7 守门',
    contradictions: { primary: { statement: '状态必须反映真实调度' } },
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }, { id: 'T2', dependsOn: ['T1'] }] }],
  }
}

function replaySession(events: any[]) {
  return { id: 'session-317', seq: events.length, header: { createdAt: 1000 }, eventAt: (n: number) => events[n] }
}

/* ---------- U-64/U-68：delegates 单调合并 ---------- */

test('U-64：低秩不覆盖高秩——running 快照不得把 done 打回', () => {
  const current = [{ member: 'A', childId: 'c-1', status: 'done', finishedAt: 2000, summary: '成果' }]
  const incoming = [{ member: 'A', childId: 'c-1', status: 'running', startedAt: 1000 }]
  const merged = mergeDelegateEntriesMonotonic(current, incoming)
  assert.equal(merged.value[0].status, 'done')
  assert.equal(merged.value[0].summary, '成果')
})

test('U-64：同秩只认更晚时间戳；已 sent 通知标记不回退', () => {
  const current = [{ member: 'A', childId: 'c-1', status: 'failed', finishedAt: 2000, report: { state: 'sent', at: 2100, ref: 'r' } }]
  const stale = [{ member: 'A', childId: 'c-1', status: 'failed', finishedAt: 1500, report: { state: 'failed', at: 1600, ref: 'r' } }]
  const merged = mergeDelegateEntriesMonotonic(current, stale)
  assert.equal(merged.value[0].finishedAt, 2000)
  assert.equal(merged.value[0].report.state, 'sent', '已 sent 不被 failed 覆盖')
})

test('U-65：待指示条目绝不被覆盖', () => {
  const current = [{ member: 'A', childId: 'c-1', status: 'running', closure: 'escalated', escalation: { question: '缺权限' } }]
  const incoming = [{ member: 'A', childId: 'c-1', status: 'failed', finishedAt: 9000 }]
  const merged = mergeDelegateEntriesMonotonic(current, incoming)
  assert.equal(merged.value[0].closure, 'escalated')
  assert.ok(merged.value[0].escalation)
})

test('U-64：新一轮尝试（不同 childId + running）取代旧终态——重派可再跑', () => {
  const current = [{ member: 'A', childId: 'c-old', status: 'failed', finishedAt: 2000 }]
  const incoming = [{ member: 'A', childId: 'c-new', status: 'running', startedAt: 3000 }]
  const merged = mergeDelegateEntriesMonotonic(current, incoming)
  assert.equal(merged.value[0].status, 'running')
  assert.equal(merged.value[0].childId, 'c-new')
})

test('U-64：incoming 无 childId 时保留 current 的 childId（不抹成 null）', () => {
  const current = [{ member: 'A', childId: 'c-1', status: 'running' }]
  const incoming = [{ member: 'A', status: 'running', summary: '补充' }]
  const merged = mergeDelegateEntriesMonotonic(current, incoming)
  assert.equal(merged.value[0].childId, 'c-1')
})

/* ---------- U-71：换主留档 ---------- */

test('U-71：childId 换主留档 childIdHistory，且消毒拒非法', () => {
  const plan = makePlan('wp-317-history')
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', { status: 'in_progress', childId: 'head-1' })
  statuses = applyStatus(statuses, 'T1', { childId: 'head-2' })
  const row: any = statuses.find((item: any) => item.subtaskId === 'T1')
  assert.ok(Array.isArray(row.childIdHistory))
  assert.equal(row.childIdHistory[0].childId, 'head-1')
  assert.equal(row.childId, 'head-2')
  // 非法 history 整体丢弃（消毒分支）。
  const dirty = applyStatus(statuses, 'T1', { childIdHistory: [{ childId: 'x', replacedAt: 'not-a-number' }] } as any)
  const dirtyRow: any = dirty.find((item: any) => item.subtaskId === 'T1')
  assert.equal(dirtyRow.childIdHistory, undefined)
})

/* ---------- U-05：status 迁移守卫 ---------- */

test('U-05：done→in_progress 拒绝；同值与合法边放行', () => {
  const plan = makePlan('wp-317-trans')
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', { status: 'done' })
  assert.throws(() => applyStatus(statuses, 'T1', { status: 'in_progress' }), /INVALID_STATUS_TRANSITION|非法状态迁移/)
  // 同值放行。
  const same = applyStatus(statuses, 'T1', { status: 'done' })
  assert.equal(same.find((i: any) => i.subtaskId === 'T1').status, 'done')
  // done→pending（重规划重置）放行。
  const reset = applyStatus(statuses, 'T1', { status: 'pending' })
  assert.equal(reset.find((i: any) => i.subtaskId === 'T1').status, 'pending')
})

/* ---------- U-06：新完成不继承 reported ---------- */

test('U-06：从非 done 进入 done 是新完成，closure 回 done 中间态', () => {
  const plan = makePlan('wp-317-done')
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', { status: 'done', closure: 'reported' })
  // 返工：done→pending→in_progress→done（新完成）。
  statuses = applyStatus(statuses, 'T1', { status: 'pending' })
  statuses = applyStatus(statuses, 'T1', { status: 'in_progress' })
  statuses = applyStatus(statuses, 'T1', { status: 'done' })
  const row: any = statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.closure, 'done', '新完成必须回 done 中间态等 markReported，不得继承旧 reported')
})

/* ---------- U-18：脏值保守归一 ---------- */

test('U-18：Done/DONE 脏值归一为 done，不再误降 pending 丢进度', () => {
  const entry = normaliseStatusEntry({ subtaskId: 'T1', status: 'Done', progress: 100, closure: 'DONE ' } as any)
  assert.equal(entry.status, 'done')
  assert.equal(entry.progress, 100)
  assert.equal((entry as any).closure, 'done')
})

/* ---------- U-19：blocked 清回报投影 ---------- */

test('U-19：blocked（非 escalated）把 report/reportedAt 迁入 lastReport/lastReportedAt', () => {
  const plan = makePlan('wp-317-blocked')
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', { status: 'done', closure: 'reported', reportedAt: 5000, report: { state: 'sent', at: 5000, ref: 'r' } } as any)
  statuses = applyStatus(statuses, 'T1', { status: 'blocked' })
  const row: any = statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.report, undefined, '已卡住与已回报不得同屏')
  assert.equal(row.reportedAt, undefined)
  assert.ok(row.lastReport, '旧回报留档不丢')
})

/* ---------- U-38：回放白名单补齐闭环字段 ---------- */

test('U-38：回放 update 不再丢 question/options/ackedAt 等闭环字段', () => {
  const plan = makePlan('wp-317-replay')
  const events = [
    { type: 'user/message', data: buildPlanMessage(plan) },
    {
      type: 'user/message',
      data: buildUpdateMessage({
        planId: plan.planId, subtaskId: 'T1', status: 'blocked', revision: 2,
        question: '需要哪个权限？', options: ['A', 'B'], blockedKind: 'escalated',
        escalatedAt: 3000, escalationSeq: 2, ackedAt: 3100, ackOverdue: false,
        assignedAt: 2500, instructionOverdue: false, reportedAt: 3200,
      } as any),
    },
  ]
  const record: any = reconstructFromSession(replaySession(events))
  const row: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.question, '需要哪个权限？')
  assert.deepEqual(row.options, ['A', 'B'])
  assert.equal(row.blockedKind, 'escalated')
  assert.equal(row.escalatedAt, 3000)
  assert.equal(row.ackedAt, 3100)
  assert.equal(row.assignedAt, 2500)
})

/* ---------- U-43：WAL 写前日志 + ack + 归属闸 ---------- */

test('U-43：WAL 写入/ack/读取闭环；ack 后不再被消费', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-wal-317-'))
  const file = join(dir, 'notices.jsonl')
  const durable = { kind: 'workplan-update', planId: 'wp-317-wal', subtaskId: 'T1', status: 'in_progress', revision: 5, walSeq: 10 }
  const walId = appendWorkplanUpdateWAL('session-317', durable, file, 1000)
  assert.ok(walId, 'WAL 写入成功返回 walId')
  const rows = readNoticeLedger(file)
  const wal = rows.filter((r) => r.form === 'wal')
  assert.equal(wal.length, 1)
  assert.equal((wal[0].durable as any)?.subtaskId, 'T1')
  // ack 之后该行被标记为已落 user/message，回放不再消费。
  assert.equal(appendWorkplanUpdateWALAck('session-317', 'wp-317-wal', [walId!], file, 1100), true)
  const acks = readNoticeLedger(file).filter((r) => r.form === 'wal-ack')
  assert.equal(acks.length, 1)
  assert.deepEqual((acks[0].durable as any)?.walIds, [walId])
})

test('U-43：崩溃窗口——未 flush 的缓冲更新经 WAL 补回重建态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-wal-crash-'))
  const file = join(dir, 'notices.jsonl')
  const prev = process.env.DSH_WORKPLAN_NOTICES_FILE
  process.env.DSH_WORKPLAN_NOTICES_FILE = file
  try {
    const plan = makePlan('wp-317-crash', 1000)
    // 模拟「进过内存缓冲但没落 user/message」：直接写 WAL（walSeq >= session.seq）。
    appendWorkplanUpdateWAL('session-317', {
      kind: 'workplan-update', planId: plan.planId, planCreatedAt: 1000,
      subtaskId: 'T1', status: 'in_progress', revision: 3, walSeq: 5,
      delegates: [{ member: 'A', childId: 'c-1', status: 'running' }],
    } as any, file, 2000)
    const events = [{ type: 'user/message', data: buildPlanMessage(plan) }]
    const record: any = reconstructFromSession(replaySession(events))
    const row: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
    /*
     * WAL 必须把崩溃窗口内的更新补回（status 从 pending 前进到 in_progress、
     * delegates 落账）；随后僵尸回收按既有契约把无存活派发的 in_progress 降级
     * 为 blocked（U-16/U-50），并补齐 closure/blockedKind/finishedAt/revision。
     * 这里钉住「WAL 真的被消费了」：delegates 在盘 + 回收投影自洽。
     */
    assert.ok(Array.isArray(row.delegates) && row.delegates.length === 1, 'WAL 必须补回崩溃窗口内的 delegates')
    assert.equal(row.delegates[0].member, 'A')
    assert.equal(row.status, 'blocked', '补回后无存活派发 ⇒ 僵尸回收降级 blocked')
    assert.equal(row.closure, 'blocked')
    assert.equal(row.blockedKind, 'failed')
    assert.ok(Number(row.revision) >= 3, 'WAL 的 revision 必须被消费')
  } finally {
    if (prev === undefined) delete process.env.DSH_WORKPLAN_NOTICES_FILE
    else process.env.DSH_WORKPLAN_NOTICES_FILE = prev
  }
})

test('U-43：归属闸——别的计划实例（planCreatedAt 不同）的 WAL 不污染本计划', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-wal-own-'))
  const file = join(dir, 'notices.jsonl')
  const prev = process.env.DSH_WORKPLAN_NOTICES_FILE
  process.env.DSH_WORKPLAN_NOTICES_FILE = file
  try {
    const plan = makePlan('wp-317-own', 1000)
    // 同 planId/sessionId 但 createdAt 不同的「另一个计划实例」留下的 WAL。
    appendWorkplanUpdateWAL('session-317', {
      kind: 'workplan-update', planId: plan.planId, planCreatedAt: 9999,
      subtaskId: 'T1', status: 'done', revision: 9, walSeq: 5,
    } as any, file, 2000)
    const events = [{ type: 'user/message', data: buildPlanMessage(plan) }]
    const record: any = reconstructFromSession(replaySession(events))
    const row: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
    assert.notEqual(row.status, 'done', '别的计划实例的 WAL 不得污染本计划')
  } finally {
    if (prev === undefined) delete process.env.DSH_WORKPLAN_NOTICES_FILE
    else process.env.DSH_WORKPLAN_NOTICES_FILE = prev
  }
})

/* ---------- U-50/U-16：僵尸回收投影自洽（含 finishedAt null 补正） ---------- */

test('U-50/U-16：僵尸 in_progress 行回收为 blocked，闭环投影齐全且 finishedAt 补当前时间', () => {
  const plan = makePlan('wp-317-zombie')
  const statuses = createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    status: index === 0 ? 'done' : 'in_progress',
    progress: index === 0 ? 100 : 40,
  }))
  const events = [
    { type: 'user/message', data: buildPlanMessage(plan) },
    {
      type: 'user/message',
      data: buildResultMessage({
        planId: plan.planId, sessionId: plan.sessionId, dispatchedAt: 2000,
        statuses, errors: [], stats: computeStats(statuses),
      }),
    },
  ]
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
  let record: any
  try {
    record = reconstructFromSession(replaySession(events))
  } finally {
    console.warn = originalWarn
  }
  const t2: any = record.statuses.find((item: any) => item.subtaskId === 'T2')
  assert.equal(t2.status, 'blocked')
  assert.equal(t2.closure, 'blocked', '不得留下 blocked+instructed 非法组合')
  assert.equal(t2.blockedKind, 'failed')
  /*
   * finishedAt 必须是真实时间戳：旧写法 Number(null)===0 被误判「已有值」，
   * 导致僵尸行 finishedAt 永远 null。这里钉住补正后一定是有限正数。
   */
  assert.equal(typeof t2.finishedAt, 'number')
  assert.ok(Number.isFinite(t2.finishedAt) && t2.finishedAt > 0, 'finishedAt 必须补当前时间，不得停在 null')
  assert.ok(Number(t2.revision) >= 1, '回收必须抬 revision')
  assert.equal(t2.updatedBy, 'system')
  assert.match(String(t2.error), /重启后失联/)
  assert.equal(record.phase, 'blocked')
  assert.equal(record.resumeAvailable, true)
})

/* ---------- U-25/U-34：第二次 steer 短提醒 ---------- */

test('U-25/U-34：第二次 steer 是短提醒，关键串保活、不再逐字重发整段', () => {
  const input = {
    planId: 'wp-317-steer', phase: 'executing',
    stats: { total: 3, done: 1, blocked: 0, inProgress: 1, pending: 1 },
    statuses: [
      { subtaskId: 'T1', status: 'done' },
      { subtaskId: 'T2', status: 'in_progress' },
      { subtaskId: 'T3', status: 'pending' },
    ],
    changePending: false, reportPending: false,
  }
  const first = buildStopSteerText({ ...input, attempt: 1 } as any)
  const second = buildStopSteerText({ ...input, attempt: 2 } as any)
  assert.match(second, /【计划未完成 · 禁止收尾】/)
  assert.match(second, /1\/3/)
  assert.match(second, /T2、T3/)
  assert.match(second, /不要调用 present/)
  assert.match(second, /第 2 次提醒/)
  assert.doesNotMatch(second, /计划已完成|已经完成/)
  assert.ok(second.length < first.length, '第二次必须比第一次短（去重生效）')
})
