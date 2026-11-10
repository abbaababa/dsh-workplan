/*
 * [2.2.9][T4][mono-tests] 结算事件写入单调性闸（M1/M2）与 reportPending 稳定判定（M4/M5）专项回归。
 *
 * 事故原型（wp-215ed52f T5 实证）：结算 rev16 已落 durable 结果消息后，主 Agent 基于
 * 落后 live 快照追加的 rev9 handoff 答复更新在回放时按 seq 升序「后到即覆盖」，把 T5 行
 * 从 rev16 回退到 rev9——与业务不变量「revision 单调递增、已结算态不可回退」正面冲突；
 * 同一族症状②：门禁读可变标志 `record.reportPending`，判定随事件到达顺序来回震荡。
 *
 * 本文件把 T2 探针（reports/t2-probe-monotonicity.mjs）与 T3 探针
 * （reports/t3-probe-report-pending.mjs）已实证的形状升格为回归用例，钉死五条契约：
 *  G1 拒绝回退：低 rev 事件整事件语义被拒（含 tool/result 第二通道、handoff 增量单调合并）；
 *  G2 允许前向：前向 rev / 等 rev 正常通过，不引入误拦；
 *  G3 兼容无 rev：旧格式（无 revision 字段 / 非整数 rev）一律放行；
 *  G4 reportPending 稳定：判定 = 对闸后 statuses 的纯派生，与到达顺序/审计镜像无关，
 *     重建带 resultWritten → 自愈一次收敛；live/replay 同判；
 *  G5 T7 交叉：非法 JSON 有界重试通道不带 rev、恒前向，与单调闸互不干扰；
 *     结算严格性不变——非法 JSON 永不计 done。
 *
 * 运行口径（与本包既有 88 个测试文件逐字一致，见 package.json 的 test 脚本）：
 *   npx tsc -p tsconfig.test.json && node --test dist-tests/tests/workplan-monotonicity.test.js
 * 直接 `node --test tests/*.test.ts` 在本包对任何测试文件都会因 `../src/plan.js`
 * 说明符不被 Node 重映射到 .ts 而 ERR_MODULE_NOT_FOUND（NodeNext 编译约定，非本文件缺陷）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  applyStatus,
  buildPlanMessage,
  buildResultMessage,
  buildUpdateMessage,
  createStatuses,
  mergeHandoffEntriesByUpdatedAt,
  openHandoffs,
  parseEvidenceBlock,
} from '../src/plan.js'
import {
  buildPlansPayload,
  createWorkplanRuntime,
  deriveReportPending,
  reconstructFromSession,
  shouldRetryAttempt,
} from '../src/runtime.js'

// 本文件不得往用户的永久教训记忆里写测试数据。
process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `t4-monotonicity-lessons-${process.pid}.jsonl`,
)

const PLAN_ID = 'wp-t4-mono'
const SESSION_ID = 'session-t4-mono'
const T0 = Date.now() - 30_000

/* ------------------------------------------------------------------ 夹具 */

function makePlan(id = PLAN_ID) {
  return {
    planId: id,
    sessionId: id === PLAN_ID ? SESSION_ID : `session-${id}`,
    createdTurn: 1,
    createdAt: T0,
    title: '单调性闸与 reportPending 稳定专项',
    contradictions: { primary: { statement: '低 rev 事件不得回退已结算行；门禁判定与到达顺序无关' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        { id: 'T1', title: 'a', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: 'b', department: 'engineering', dependsOn: ['T1'] },
      ],
    }],
  }
}

/** 会话夹具：逐字抄 T2/T3 探针（判据依赖 event.seq——自造最小对象会漏，教训 §预防）。 */
function makeSession(id = SESSION_ID) {
  const events: any[] = []
  return {
    id,
    header: { createdAt: T0 },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data, seq: events.length })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeCtx(session: any): any {
  return {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('fixture never dispatches') } },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: (seq: number) => session.eventAt(seq),
    },
    get: () => undefined,
    llm: { stream() { throw new Error('fixture: planner unavailable') } },
  }
}

/** 结算行：done + 指定 closure/rev（事故形状：closure reported、structured 证据）。 */
function settledStatuses(plan: any, closure: string, rev: number, opts: any = {}) {
  const statuses: any[] = createStatuses(plan)
  for (const item of statuses) {
    item.status = 'done'
    item.closure = closure
    item.progress = 100
    item.verification = 'structured'
    item.acceptance = [{ criterion: `${item.subtaskId} 验收`, result: 'pass', evidence: `rev${rev} 结算证据` }]
    item.missingArtifacts = []
    item.summary = `rev${rev} 结算摘要`
    item.revision = rev
    if (closure === 'reported') item.report = { state: 'sent', at: T0 + rev, ref: `${plan.planId}:${rev}` }
  }
  if (opts.needsOnT2) statuses[1].needs = [opts.needsOnT2]
  if (opts.handoffOnT2) {
    statuses[1].handoffs = [{
      id: 'H1', request: 'T2 答复锚点', department: null, status: 'answered',
      response: '终版答复（rev16 结算时已闭环）', at: T0, updatedAt: T0 + 100,
    }]
  }
  return statuses
}

function seedResult(session: any, plan: any, statuses: any, dispatchedAt = 2000) {
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildResultMessage({
    planId: plan.planId, sessionId: session.id, dispatchedAt,
    statuses, errors: [], phase: 'executing',
  }))
}

function rowOf(statuses: any, id: string) {
  return statuses.find((item: any) => item.subtaskId === id)
}

/** 捕获一段同步/异步代码里的 console.warn（单调闸拒绝日志的唯一可观测出口）。 */
async function captureWarns<T>(fn: () => T | Promise<T>): Promise<{ value: T; warns: string[] }> {
  const lines: string[] = []
  const real = console.warn
  console.warn = (...a: any[]) => { lines.push(a.join(' ')) }
  try {
    const value = await fn()
    return { value, warns: lines }
  } finally {
    console.warn = real
  }
}

function gateLogs(warns: string[]) {
  return warns.filter((w) => w.includes('monotonicity gate') && w.includes('skipped'))
}

function payloadOf(ctx: any, state: any) {
  return buildPlansPayload(ctx, state, ctx.sessionIdFor ?? SESSION_ID).sessions[0]
}

const plan = makePlan()

/* ---------------------------------------------------------------- G1 拒绝回退 */

test('G1-A1 rev9 回退事件被单调闸整事件拒绝：rev16 结算内容与闭环不回退，日志含两 rev 比较值', async () => {
  const session = makeSession()
  seedResult(session, plan, settledStatuses(plan, 'reported', 16))
  session.append('user/message', buildUpdateMessage({
    planId: PLAN_ID, subtaskId: 'T2',
    status: 'pending', note: '旧世代快照摘要（不得回退）',
    verification: 'unverified',
    acceptance: [{ criterion: 'T2 验收', result: 'unverified', evidence: '旧证据' }],
    revision: 9, at: Date.now(),
  }))
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  const row = rowOf(record.statuses, 'T2')
  // 行语义逐字段不回退（症状①正解）。
  assert.equal(row.status, 'done', `rev9 事件把行回退成 ${row.status}`)
  assert.equal(row.verification, 'structured', '旧事件 verification 不得覆盖')
  assert.equal(row.acceptance[0].result, 'pass', '旧事件 acceptance 不得覆盖')
  assert.equal(row.summary, 'rev16 结算摘要', '旧事件 note 不得覆盖')
  assert.equal(row.closure, 'reported', '已结算闭环不得回退')
  // A3 中间行为：闸确实执行了 rev 比较并跳过整事件——行 rev 精确保持 16（不抬不降），
  // 且日志逐字带出两个 rev 值；若只是「应用后复原」，revision 与日志形状都对不上。
  assert.equal(row.revision, 16, '被拒事件必须被整体跳过：行 rev 既不回退也不抬号')
  const hits = gateLogs(warns)
  assert.ok(hits.length >= 1, `日志必须含 monotonicity gate skipped，实际=${JSON.stringify(warns)}`)
  assert.ok(hits[0].includes('event rev 9') && hits[0].includes('row rev 16'), '日志必须含两 rev 比较值')
  assert.ok(hits[0].includes(`${PLAN_ID}/T2`), '日志必须点名被拒的 plan/subtask')
  // 幂等：同一份乱序日志重建两次，结算语义恒同（震荡的反命题）。时间戳类字段
  // （finishedAt/attemptEndedAt）随重建时刻走，不属被保护语义，逐字段比较语义面。
  const again = await captureWarns(() => reconstructFromSession(session) as any)
  const semantic = (rec: any) => rec.statuses.map((s: any) => JSON.stringify([
    s.subtaskId, s.status, s.closure, s.revision, s.verification, s.summary, s.acceptance,
    (s.handoffs ?? []).map((h: any) => [h.id, h.status, h.response]),
  ])).join('|')
  assert.equal(semantic(again.value), semantic(record))
})

test('G1-A1b tool/result 第二通道（patch 不带 rev）不得从拒绝事件灌回旧内容', async () => {
  const session = makeSession()
  seedResult(session, plan, settledStatuses(plan, 'reported', 16))
  session.append('tool/call', {
    name: 'dsh_workplan_update', callId: 'call-stale',
    arguments: JSON.stringify({ planId: PLAN_ID, subtaskId: 'T2', status: 'pending', note: '第二通道旧内容' }),
  })
  session.append('user/message', buildUpdateMessage({
    planId: PLAN_ID, subtaskId: 'T2', status: 'pending', revision: 9,
  }))
  session.append('tool/result', {
    message: { role: 'tool', toolCallId: 'call-stale', isError: false },
  })
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  const row = rowOf(record.statuses, 'T2')
  assert.equal(gateLogs(warns).length >= 1, true, 'durable 侧必须过闸（比较逻辑真实执行）')
  assert.equal(row.status, 'done', `第二通道灌回了旧内容：status=${row.status}`)
  assert.notEqual(row.summary, '第二通道旧内容', '拒绝路径登记的 appliedUpdates 必须让配对 tool/result 跳过（A3 中间行为）')
})

test('G1-A1c 事故原型（T5/H1）：rev9 handoff 答复后到——答复单调合并保留，行结算态永不回退', async () => {
  const session = makeSession()
  const statuses = settledStatuses(plan, 'reported', 16, { needsOnT2: '需要 T6 标注降级序方向' })
  seedResult(session, plan, statuses)
  const mid = reconstructFromSession(session) as any
  assert.equal(openHandoffs(rowOf(mid.statuses, 'T2')).length, 1, '前置：needs 派生一条 open handoff')
  session.append('user/message', buildUpdateMessage({
    planId: PLAN_ID, subtaskId: 'T2', status: 'done',
    handoffs: [{
      id: 'H1', request: '需要 T6 标注降级序方向', department: 'engineering',
      status: 'answered', response: '已落实于交付报告 §2/§4.3', at: 3000, updatedAt: 9000, by: 'agent',
    }],
    revision: 9,
  }))
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  assert.ok(gateLogs(warns).length >= 1, '低 rev 事件本体必须被闸拒绝')
  const row = rowOf(record.statuses, 'T2')
  const h1 = row.handoffs[0]
  assert.equal(h1.status, 'answered', 'handoff 答复属字段级增量（M2），拒绝路径也必须保留（事故正解）')
  assert.match(h1.response, /已落实/, '答复内容不得丢')
  assert.deepEqual(openHandoffs(row), [], 'answered 不得继续挡交付门禁')
  assert.equal(row.status, 'done')
  assert.equal(row.revision, 16, '合并答复不抬行 rev：事件整体仍被跳过')
  assert.equal(row.verification, 'structured', '结算证据不回退')
  assert.equal(row.closure, 'reported', '闭环不回退')
})

/* ---------------------------------------------------------------- G2 前向放行 */

test('G2-A2 rev17 前向事件正常应用，且闸日志零命中（比较逻辑真实执行、非盲目放行）', async () => {
  const session = makeSession()
  seedResult(session, plan, settledStatuses(plan, 'reported', 16))
  session.append('user/message', buildUpdateMessage({
    planId: PLAN_ID, subtaskId: 'T2', status: 'done',
    note: 'rev17 复核改判', verification: 'structured',
    acceptance: [{ criterion: 'T2 验收', result: 'pass', evidence: 'rev17 复核' }],
    revision: 17,
  }))
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  const row = rowOf(record.statuses, 'T2')
  assert.equal(row.summary, 'rev17 复核改判')
  assert.equal(row.acceptance[0].evidence, 'rev17 复核')
  assert.ok(Number(row.revision) >= 17, `前向写入后行 rev 应 >=17，实际 ${row.revision}`)
  assert.equal(gateLogs(warns).length, 0, '前向事件不得被误拦')
})

test('G2-A2b 等 rev（16）事件放行：同世代补写是合法场景，不误拦', async () => {
  const session = makeSession()
  seedResult(session, plan, settledStatuses(plan, 'reported', 16))
  session.append('user/message', buildUpdateMessage({
    planId: PLAN_ID, subtaskId: 'T2', status: 'done', note: '同世代补写', revision: 16,
  }))
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  assert.equal(rowOf(record.statuses, 'T2').summary, '同世代补写', '等 rev 必须通过')
  assert.equal(gateLogs(warns).length, 0, '等 rev 属前向语义，不得触发拒绝日志')
})

/* ---------------------------------------------------------------- G3 无 rev 兼容 */

test('G3-A3 无 revision 字段的旧格式事件不被误拦（向后兼容）', async () => {
  const session = makeSession()
  seedResult(session, plan, settledStatuses(plan, 'reported', 16))
  const msg = buildUpdateMessage({ planId: PLAN_ID, subtaskId: 'T2', status: 'done', note: '旧格式改判', revision: 16 })
  const before = msg.content[0].text
  const after = before.replace('"revision":16', '"__stripped__":1')
  assert.notEqual(after, before, '构造前提：载荷必须先带 rev 才能剥')
  msg.content = [{ type: 'text', text: after }]
  session.append('user/message', msg)
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  const row = rowOf(record.statuses, 'T2')
  assert.equal(row.summary, '旧格式改判', '无 rev 字段必须放行')
  assert.equal(row.status, 'done')
  assert.equal(gateLogs(warns).length, 0, '无 rev 不参与比较，不得产生拒绝日志')
})

test('G3-A3b 非整数 revision（字符串 "16"）按旧格式放行', async () => {
  const session = makeSession()
  seedResult(session, plan, settledStatuses(plan, 'reported', 16))
  const msg = buildUpdateMessage({ planId: PLAN_ID, subtaskId: 'T2', status: 'done', note: '字符串 rev', revision: 16 })
  msg.content = [{ type: 'text', text: msg.content[0].text.replace('"revision":16', '"revision":"16"') }]
  session.append('user/message', msg)
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  assert.equal(rowOf(record.statuses, 'T2').summary, '字符串 rev')
  assert.equal(gateLogs(warns).length, 0)
})

test('M2 单元：mergeHandoffEntriesByUpdatedAt 永不回退 / 秩前进无视伪戳 / 新登记 / 幂等', () => {
  const current = [
    { id: 'H1', request: 'A', department: null, status: 'answered', response: 'r1', at: 1, updatedAt: 5, by: 'agent' },
    { id: 'H2', request: 'B', department: null, status: 'open', response: null, at: 1, updatedAt: 1, by: 'child' },
  ]
  const once: any = mergeHandoffEntriesByUpdatedAt(current, [
    { id: 'H1', request: 'A', status: 'open', response: null, updatedAt: 99, by: 'child' }, // 高戳低秩：仍不回退
    { id: 'H2', request: 'B', status: 'routed', department: 'data', updatedAt: 2, by: 'agent' }, // 秩前进
    { id: 'H3', request: 'C', status: 'open', updatedAt: 3, by: 'child' }, // 新登记
  ])
  assert.equal(once.value[0].status, 'answered', 'answered 永不被低秩 open 覆盖（时间戳不参与秩判定）')
  assert.equal(once.value[1].status, 'routed', '秩前进采纳')
  assert.equal(once.value.length, 3, '新 request 追加')
  const adv: any = mergeHandoffEntriesByUpdatedAt(current, [
    { id: 'HX', request: 'A', status: 'closed', response: 'r2', updatedAt: 6, by: 'agent' },
  ])
  assert.equal(adv.value[0].id, 'H1', '同 request 精化时 id 保持稳定')
  assert.equal(adv.value[0].status, 'closed', '终态间允许前进（answered→closed）')
  const twice: any = mergeHandoffEntriesByUpdatedAt(once.value, [
    { id: 'H1', request: 'A', status: 'open', updatedAt: 99 },
    { id: 'H2', request: 'B', status: 'routed', department: 'data', updatedAt: 2 },
    { id: 'H3', request: 'C', status: 'open', updatedAt: 3 },
  ])
  assert.equal(twice.changed, false, '同一记录二次进入必须幂等')
})

/* ---------------------------------------------------------------- G4 reportPending 稳定 */

test('G4-P1 乱序到达不影响门禁判定：rev9 被拒后恒放行；审计镜像翻转 5 轮判定恒稳（标志退出决策）', async () => {
  const session = makeSession()
  seedResult(session, plan, settledStatuses(plan, 'reported', 16, { handoffOnT2: true }))
  session.append('user/message', buildUpdateMessage({
    planId: PLAN_ID, subtaskId: 'T2', status: 'done', verification: 'unverified',
    acceptance: [{ criterion: 'T2 验收', result: 'unverified', evidence: '旧世代证据' }],
    note: '落后的 live 快照上的 handoff 答复（不得回退 rev16）',
    handoffs: [{
      id: 'H1', request: 'T2 答复锚点', department: null, status: 'answered',
      response: '更早的答复文本（同秩更旧 updatedAt，必须被保留方压制）', at: T0, updatedAt: T0 + 50,
    }],
    revision: 9, at: Date.now(),
  }))
  const ctx = makeCtx(session)
  const p1 = payloadOf(ctx, { records: new Map(), activeTurns: new Map() })
  assert.equal(p1.deliveryReady, true, 'rev9 被单调闸拒绝后，全行仍 done+reported → 必须放行')
  assert.equal(p1.reportPending, false, '派生闸不得因被拒事件里的 closure/证据回退而抖动')
  assert.equal(rowOf(p1.statuses, 'T2').revision, 16, '行 rev 不回退')
  assert.equal(rowOf(p1.statuses, 'T2').handoffs[0].response, '终版答复（rev16 结算时已闭环）', '同秩更旧答复（rev9 事件携带）必须被保留方压制')
  // 震荡压力：审计镜像标志人为置反 5 轮——判定必须恒稳（M4.1 主闸：标志不再参与决策）。
  for (let i = 0; i < 5; i += 1) {
    const st: any = { records: new Map(), activeTurns: new Map() }
    const rec = reconstructFromSession(session) as any
    rec.reportPending = i % 2 === 0
    st.records.set(SESSION_ID, rec)
    const p = payloadOf(ctx, st)
    assert.equal(p.deliveryReady, true, `标志污染第 ${i} 轮仍须放行`)
    assert.equal(p.reportPending, false, `标志污染第 ${i} 轮派生观测恒 false（与镜像无关）`)
  }
  // 到达顺序对偶：rev9 先到、rev16 结果后到 → 最终判定同向放行（一次收敛，不震荡）。
  const planB = makePlan('wp-t4-mono-b')
  const sessionB = makeSession(planB.sessionId)
  sessionB.append('user/message', buildPlanMessage(planB))
  sessionB.append('user/message', buildUpdateMessage({
    planId: planB.planId, subtaskId: 'T2', status: 'done', verification: 'unverified',
    note: '先到的旧事件', revision: 9, at: Date.now(),
  }))
  sessionB.append('user/message', buildResultMessage({
    planId: planB.planId, sessionId: sessionB.id, dispatchedAt: 2000,
    statuses: settledStatuses(planB, 'reported', 16), errors: [], phase: 'executing',
  }))
  const ctxB: any = makeCtx(sessionB)
  ctxB.sessionIdFor = sessionB.id
  const pB = payloadOf(ctxB, { records: new Map(), activeTurns: new Map() })
  assert.equal(pB.deliveryReady, true, '另一种到达顺序同样放行')
  assert.equal(pB.reportPending, false)
})

test('G4-P2 人工改判 live 路径一次判定即放行、live/replay 同判（无先拒后放震荡）', async () => {
  const plan2 = makePlan('wp-t4-mono-live')
  const session = makeSession(plan2.sessionId)
  session.append('user/message', buildPlanMessage(plan2))
  const ctx: any = makeCtx(session)
  ctx.sessionIdFor = session.id
  const runtime: any = createWorkplanRuntime(ctx, { version: 'fixture' })
  const record: any = {
    plan: plan2, planId: plan2.planId, title: plan2.title, phase: 'paused',
    statuses: createStatuses(plan2), errors: [], degraded: false,
    createdAt: T0, updatedAt: Date.now(),
  }
  runtime.state.records.set(session.id, record)
  const agent = { session }
  const r1: any = await runtime.updateStatus(agent, {
    subtaskId: 'T1', status: 'done', verification: 'structured',
    acceptance: [{ criterion: 'T1 验收', result: 'pass', evidence: 'npm test 通过' }],
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.deliveryReady, false, 'T2 未完成时仍不可交付')
  assert.ok(!String(r1.deliveryBlockers.join('；')).includes('reportPending'), '剩余项不得伪装成 reportPending')
  assert.equal(deriveReportPending(record), false, ' durable 改判消息本身即回报证据，行即时闭环')
  const r2: any = await runtime.updateStatus(agent, {
    subtaskId: 'T2', status: 'done', verification: 'structured',
    acceptance: [{ criterion: 'T2 验收', result: 'pass', evidence: 'npm test 通过' }],
  })
  assert.equal(r2.ok, true)
  assert.equal(r2.deliveryReady, true, '最后一项改判的那一次判定即放行——不得先拒后放')
  assert.equal(deriveReportPending(record), false)
  const replayed = reconstructFromSession(session) as any
  assert.equal(rowOf(replayed.statuses, 'T1').closure, 'reported', '回放侧确定性升级：live/replay 同判')
  assert.equal(replayed.reportPending, false, '重建同判：不得 live 放行、刷新拦截')
  for (let i = 0; i < 2; i += 1) {
    assert.equal((reconstructFromSession(session) as any).reportPending, false, '重复重建幂等')
  }
})

test('G4-P3 旧日志 closure-done 行：重建带 resultWritten → pre-step 自愈一次收敛，其后判定与 rev 恒稳', async () => {
  const plan3 = makePlan('wp-t4-mono-heal')
  const session = makeSession(plan3.sessionId)
  // 旧日志形状（2.2.9 前 markReported 写失败/进程中断）：结果消息行 closure 停在 done。
  seedResult(session, plan3, settledStatuses(plan3, 'done', 12))
  const ctx: any = makeCtx(session)
  ctx.sessionIdFor = session.id
  const runtime: any = createWorkplanRuntime(ctx, { version: 'fixture' })
  const record = reconstructFromSession(session) as any
  assert.equal(record.resultWritten, true, '重建必须带 resultWritten（旧缺口：恒 undefined → 自愈永不触发）')
  assert.equal(record.reportPending, true, 'closure done 行 → 派生 true，门禁拦')
  runtime.state.records.set(session.id, record)
  const next = async () => ({ kind: 'enter', messages: [] })
  const payload = {
    agent: { session }, turn: 7, step: 1,
    modelSelection: { provider: 'fixture', model: 'fixture-model' },
    messages: [{ id: 'm-status', role: 'user', content: [{ type: 'text', text: '进度如何？' }] }],
    signal: new AbortController().signal,
  }
  await runtime.onPreStep(payload, next)
  assert.equal(rowOf(record.statuses, 'T1').closure, 'reported', '首个 pre-step 即完成自愈（不再靠人工收敛）')
  assert.equal(deriveReportPending(record), false)
  assert.equal(payloadOf(ctx, runtime.state).deliveryReady, true, '自愈后一次判定即放行')
  const revAfter = rowOf(record.statuses, 'T1').revision
  for (let i = 0; i < 3; i += 1) await runtime.onPreStep(payload, next)
  assert.equal(rowOf(record.statuses, 'T1').revision, revAfter, '重复 pre-step 幂等：不再抬 rev')
  assert.equal(payloadOf(ctx, runtime.state).deliveryReady, true, '之后判定恒稳（震荡的反命题）')
})

/* ---------------------------------------------------------------- G5 T7 交叉 */

const X1_PLAN = 'wp-t4-mono-x1'
const X1_SESSION = 'session-t4-mono-x1'

function malformedX1(tag: string) {
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n{ ${tag} 这不是合法 JSON ]]]\n${EVIDENCE_MARKER_END}`
}

function compliantX1() {
  const phases = {
    planning: {
      problemAnalysis: [
        '现状：子会话第一次回报的 JSON 非法，结算链按 T7 通道回喂重报；已知事实：重试结算写入不带事件 rev，恒按 current+1 前向抬号；约束：非法 JSON 永不计 done、单调闸不得拦合法前向写入；未知：无（两条通道的调用点已由 T2 §1.4 兼容表钉死）；主要矛盾：恢复路径（有界回喂）与写回保护（低 rev 拒绝）必须在同一结算链并存且互不干扰；边界：只验证共存，不改动任一通道实现。',
      ],
      constraints: ['非法 JSON 不得计 done', '有界重试最多两次激活', '不修改生产严格性闸'],
      unknowns: ['无'],
      approach: [
        '第 1 步：fake 子会话第一轮回非法块、第二轮回合法块 → 产出 prompts.length=2 与 done+structured 结算 → 证明：dispatch 结果行逐字段断言。',
        '第 2 步：把该结算固化为 durable 结果消息后注入 rev 更低的旧改判事件 → 产出单调闸拒绝日志（含两 rev 比较值）与不回退的行 → 证明：reconstruct 语义面断言。',
      ],
    },
    execution: { steps: ['复刻 T7 夹具跑两轮激活', 'seed 结果消息', '注入低 rev 事件', '重建并逐字段核对'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: '通道可用', method: 'node --test', evidence: '本用例即证据：prompts=2 且行 done+structured' }],
      requirementCheck: '已逐条核对：严格性、有界性、单调共存三条均有用例断言钉死。',
      retrospective: {
        problems: ['非法块一次即 blocked；根因：结算链在 apply 前没有 unparsable 预裁决分支。'],
        detours: [],
        resolutions: [
          '把 unparsable 并入与 CHILD_NOT_COMPLETED 同闸的有界回喂重试：回喂解析器具体错误与在盘产物清单，重试耗尽才受阻；本用例用同一条 e2e 通道验证其与单调闸共存。',
        ],
        prevention: ['遇到结算类失败先问能否回喂同一子会话自纠，先复用既有有界重试闸，再考虑人工改判出口。'],
      },
    },
  }
  const payload = {
    status: 'done',
    summary: '重试通道与单调闸共存',
    phases,
    acceptance: [{ criterion: '通道可用', result: 'pass', evidence: 'node --test 1/1 pass' }],
    artifacts: [{ kind: 'file', ref: 'reports/t4-cross-report.md' }],
    needs: [],
  }
  return `修正后重报。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function makeX1Plan() {
  return {
    planId: X1_PLAN,
    sessionId: X1_SESSION,
    createdTurn: 1,
    createdAt: T0,
    title: 'T7 重试与单调闸交叉',
    contradictions: { primary: { statement: '重试结算不得被旧事件回退' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1', title: '实现通道', department: 'engineering', role: 'engineer',
        objective: '通过验收', method: ['实现', '测试'], inputs: [],
        outputs: ['reports/t4-cross-report.md'], acceptance: ['通道可用'], risk: '低', dependsOn: [],
      }],
    }],
  }
}

test('G5-X1 T7 有界重试结算后，低 rev 旧事件被闸拒绝：重试行为与单调共存互不干扰', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-mono-x1-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  writeFileSync(join(cwd, 'reports', 't4-cross-report.md'), '# T4 交叉报告\n')
  const events: any[] = []
  const session: any = {
    id: X1_SESSION,
    header: { createdAt: T0, cwd },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data, seq: events.length }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
  const x1Plan = makeX1Plan()
  session.append('user/message', buildPlanMessage(x1Plan))
  const prompts: string[] = []
  const outputs = [malformedX1('第一轮'), compliantX1()]
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        prompts.push(String(activation?.request?.prompt?.[0]?.text ?? ''))
        const output = outputs.shift() ?? compliantX1()
        return {
          childId: `child-x1-${prompts.length}`,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
          dispose: async () => {},
        }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    get: () => undefined,
    llm: { stream() { throw new Error('fixture: planner unavailable') } },
  }
  ctx.sessionIdFor = X1_SESSION
  const runtime: any = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000, idleTimeoutMs: 30_000, childTimeoutMs: 20_000, maxResumes: 4, autoResume: false,
  })
  const { value: dispatch, warns: dispatchWarns } = await captureWarns(
    () => runtime.dispatchTool({ session, options: {} }, {}, new AbortController().signal),
  )
  const liveRow = rowOf(dispatch.statuses, 'T1')
  // T7 行为不回归：第一轮非法 → 回喂 → 第二轮合法 → done+structured（A4 交叉面）。
  assert.equal(prompts.length, 2, 'unparsable 必须触发第 2 次回喂激活')
  assert.equal(liveRow.status, 'done')
  assert.equal(liveRow.verification, 'structured')
  assert.equal(gateLogs(dispatchWarns).length, 0, '子结算（writeSubtaskStatus 族不带 rev）恒前向，永不触闸')
  const settleRev = Number(liveRow.revision)
  assert.ok(Number.isInteger(settleRev) && settleRev >= 1, `结算行 rev 应为正整数，实际 ${liveRow.revision}`)
  // 把重试结算固化为 durable 结果消息（与 T2/T3 探针 seedResult 同形；不依赖 fake 派发
  // 是否已把结果消息落盘——回放侧的结算事实与被测闸在同一入口消费）。
  session.append('user/message', buildResultMessage({
    planId: X1_PLAN, sessionId: X1_SESSION, dispatchedAt: 2000,
    statuses: dispatch.statuses, errors: [], phase: 'executing',
  }))
  // 交叉注入：回放侧存在比结算更旧的手动改判事件（rev = settleRev-1，含 0 边界）。
  session.append('user/message', buildUpdateMessage({
    planId: X1_PLAN, subtaskId: 'T1', status: 'pending', note: '落后的旧改判（不得回退重试结算）',
    verification: 'unverified', acceptance: [{ criterion: '通道可用', result: 'unverified', evidence: '旧证据' }],
    revision: settleRev - 1, at: Date.now(),
  }))
  const { value: record, warns } = await captureWarns(() => reconstructFromSession(session) as any)
  assert.ok(gateLogs(warns).length >= 1, `rev=${settleRev - 1} 打 rev=${settleRev} 行必须被拒且日志含比较值`)
  assert.ok(gateLogs(warns)[0].includes(`event rev ${settleRev - 1}`))
  const row = rowOf(record.statuses, 'T1')
  assert.equal(row.status, 'done', '重试结算不得被旧事件回退')
  assert.equal(row.verification, 'structured')
  assert.equal(row.acceptance[0].result, 'pass')
  assert.equal(row.revision, settleRev, '被拒事件整体跳过：行 rev 不抬不降')
  assert.equal(deriveReportPending(record), deriveReportPending({ statuses: dispatch.statuses }), 'live/replay 对同一结算同判')
})

test('G5-X2 严格性不降：非法 JSON 永不计 done；不带 rev 的前向写入不受闸影响', () => {
  // 结算严格性锚点（已知约束「非法 JSON 依旧不计 done」在闸上线后保持）。
  const verdict = adjudicateResult({ output: malformedX1('status'), expectedAcceptance: ['通道可用'] })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'unparsable')
  const parsed = parseEvidenceBlock(malformedX1('status'))
  assert.equal(parsed.malformed, true)
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_UNPARSABLE' }, 1, 60_000, 10_000), true, '有界重试闸原语义保持')
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_UNPARSABLE' }, 2, 60_000, 10_000), false, '第二非法绝不无限回喂')
  // 库级口径：applyStatus 的前向/无 rev 写入恒被采纳（与 runtime.ts 调用点兼容表一致）。
  let statuses = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', {
    status: 'done', verification: 'structured',
    acceptance: [{ criterion: 'x', result: 'pass', evidence: 'y' }], revision: 16, updatedBy: 'agent',
  })
  statuses = applyStatus(statuses, 'T1', { status: 'done', summary: 'forward', revision: 17 })
  assert.equal(rowOf(statuses, 'T1').summary, 'forward')
  assert.ok(Number(rowOf(statuses, 'T1').revision) >= 17)
  statuses = applyStatus(statuses, 'T1', { summary: 'no-rev' })
  assert.ok(Number(rowOf(statuses, 'T1').revision) > 17, '无 rev 按 current+1 单调抬号')
})
