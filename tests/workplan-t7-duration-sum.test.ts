/**
 * [T7] 负责人任务时长＝全部下属开工预估之和（test-member 唯一写者；tests/ 只写）。
 *
 * 唯一权威口径（J7 裁决）：
 *   - reports/T7-estimate-aggregation-spec-20261113.md（rules-expert 权威件；R1-R8 / T-1..T-12 / F1-F6 / A1-A16）
 *   - reports/T7-lead-decisions-20261113.md（负责人裁决 J1-J8，唯一口径）
 *   - reports/wp-user-decisions-20261112.md D3/D9：严格算术和、不含负责人自身耗时；只计 delivery==='sent'。
 *   - _t6_estimate_20261112/00-contract-estimate-v1.md §3（FROZEN）：消毒判据/台账形状/重置保留。
 *   - reports/T7-leader-duration-aggregation-spec-20261113.md 为双会话重复件，仅审计对照，不作断言依据（J7）。
 *
 * 冻结输出结构（J1/J8）：{ totalMinutes, reported, expected, missing[], failed[] }；
 *   仅 reported===expected 可表述完整等式；空 roster（无 delegates 且台账空）⇒ null/「无下属分工」，不得输出 0 分钟（J8）。
 *
 * 场景 → 验收映射：
 *   ① 多成员严格求和 ⇒ G1/G1b（A1/A14/R3/R4/D3，含 12 人上界 F4/J8）
 *   ② 新预估覆盖旧预估 ⇒ G2/G3（A2/A3；精确语义 J5：failed/缺失/非法才被整对象覆盖，sent 经 self_effort 幂等不可变，
 *      主 Agent 显式 patch 例外；self_effort 运行时幂等机制由 workplan-t6-estimate-gate.test.ts D6⑦ 覆盖）
 *   ③ 只计 delivery:'sent' ⇒ G4（A4/R2/D9）
 *   ④ 部分成员未上报 ⇒ G5（A8/J1 方案 A：reported<expected＋missing/failed 名单正确）
 *   ⑤ replan/重置后重算 ⇒ S2/S3/G11/G12（A11/A12/R8/T-5..T-8）
 *   ⑥ 非法输入 fail-closed ⇒ S1/G9/G10/G16（A5/A9/F1/F2/F6/J8 上界）
 *   ⑦ 空台账/零下级 ⇒ G8（F3/J8：空 roster⇒null；map=null 仍有班子⇒全员缺口部分和 0）
 *   另：A6 读档优先级 G6；A7 班子作用域 G7（J4）；A13 回放一致 S4/G13；A16 journal 不参和 S5/G14（J5）；
 *       R7 已结算仍计 G15；J8 不写回 timeNotice/timeJournal G17。
 *   A15（不新造存储）验证方法＝审查实现 diff（J2），属 review-expert 职责，非单测可断言，此处不虚构。
 *
 * [T7-ALIGN-1] 已对齐（agent-27 指令，2026-11-13）：T7_AGGREGATE_SOURCE = { module: '../src/plan.js',
 *   exportName: 'deriveLeaderEstimate' }（相对编译位置 dist-tests/tests/，与文件头导入同范式）。
 *   导出名已对 src/plan.ts:4968 源码逐字核实（LeaderEstimateSummary 五键冻结，plan.ts:4921-4927）；
 *   reports/T7-impl-handoff-20261113.md 截至对齐时未落盘，若落盘后导出名有变以 handoff 为准并即报 agent-27。
 * [T7-ALIGN-2] 已闭环（agent-27 批准补断言，2026-11-13）：impl 对 closure='replanned' 行返回 null
 *   （src/plan.ts:4973，R8 行级退出 live），G12 已补 assert.equal(await aggregate(old), null)；
 *   行级 closure 标记与台账追溯保留由 S3 钉住。
 * [T7-ALIGN-3] J8 越界输出的精确形态（null/异常标注/抛错）待 impl 交接冻结；G16 先钉 fail-closed 底线：
 *   绝不返回 >120960 的普通数值 totalMinutes，合法值必 Number.isSafeInteger。
 *
 * 纪律（T6 契约 §7＋lead-decisions §4＋负责人 2026-11-13 指令）：
 *   - 只写 tests/；不改 src/；impl+构建就绪信号前禁止 npm test / npm run build / tsc 发射（共享工作树并发写 src，
 *     历史教训 T4/T5/T8 同型事故）；类型自检仅允许 npx tsc -p tsconfig.test.json --noEmit。
 *   - 全量回归由负责人统一协调单一权威运行；journal 临时目录测后清理（after + exit 双保险）。
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { applyStatus, createStatuses, buildUpdateMessage, parseUpdateMessage, buildPlanMessage } from '../src/plan.js'
import { applyReplanStatuses } from '../src/replan.js'
import { appendDeptMessage, readDeptMessages, makeDeptMessageId } from '../src/dept-journal.js'
import { reconstructFromSession } from '../src/runtime.js'

/* ---------- journal 临时目录（范式 dept-estimate-contract.test.ts） ---------- */
let journalDir = ''
let prevJournalEnv: string | undefined
function cleanupJournal(): void {
  if (prevJournalEnv === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = prevJournalEnv
  if (journalDir) rmSync(journalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
before(() => {
  prevJournalEnv = process.env.DSH_WORKPLAN_JOURNAL_DIR
  journalDir = mkdtempSync(join(process.cwd(), '.tmp-t7-duration-sum-'))
  process.env.DSH_WORKPLAN_JOURNAL_DIR = journalDir
})
after(cleanupJournal)
process.on('exit', cleanupJournal)

/* ---------- 夹具 ---------- */
let seq = 0
function makePlan(tag: string) {
  seq += 1
  return {
    version: 1, planId: `t7sum-${tag}-${seq}`, title: 'T7 时长求和用例', sessionId: 'session-root', createdTurn: 1, createdAt: 1000,
    taskUnderstanding: { originalRequest: '负责人时长＝下属预估之和', deliverable: '聚合回归' },
    contradictions: { primary: { statement: '严格等式 vs 部分上报', evidence: [], whyPrimary: '夹具主要矛盾' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: '聚合', rationale: '', checkpoint: '',
      subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', role: '负责人', objective: 'o', method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [] }],
    }],
  }
}
/** T6 契约 §3 形状的 estimate 工厂。 */
function est(minutes: any, delivery: 'sent' | 'failed' = 'sent', over: Record<string, any> = {}): any {
  return { declaredMinutes: minutes, at: 1500, delivery, ...over }
}
function delegate(member: string, estimate?: any, over: Record<string, any> = {}): any {
  return { member, role: 'member', task: 't', effort: 'low', childId: `child-${member}`, status: 'running', ...(estimate === undefined ? {} : { estimate }), ...over }
}
/** 经真实写侧（applyStatus 消毒）落行的状态行。 */
function makeRow(tag: string, patch: Record<string, any> = {}): any {
  return applyStatus(createStatuses(makePlan(tag)), 'T1', { status: 'in_progress', ...patch })[0]
}
function fakeSession(id: string) {
  const events: any[] = []
  return {
    id, header: { createdAt: 1000, cwd: '/tmp/t7-duration-sum' }, events,
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (n: number) => events[n],
  }
}

/* ---------- [T7-ALIGN-1] 聚合 API 接缝（已对齐 agent-27 指令；导出名核实 src/plan.ts:4968） ---------- */
type T7Aggregation = { totalMinutes: number; reported: number; expected: number; missing: string[]; failed: string[] }
const T7_AGGREGATE_SOURCE: { module: string; exportName: string } = { module: '../src/plan.js', exportName: 'deriveLeaderEstimate' }
/** J8：空 roster ⇒ null；非空 roster ⇒ 冻结结构对象。防御：导出缺失/非函数时显式报错，不静默。 */
async function aggregate(row: any): Promise<T7Aggregation | null> {
  const mod: any = await import(T7_AGGREGATE_SOURCE.module)
  const fn = mod[T7_AGGREGATE_SOURCE.exportName]
  if (typeof fn !== 'function') throw new Error(`T7_EXPORT_MISSING: ${T7_AGGREGATE_SOURCE.module} 未导出函数 ${T7_AGGREGATE_SOURCE.exportName}（以 reports/T7-impl-handoff-20261113.md 为准并即报 agent-27）`)
  return await fn(row)
}
/** 非空 roster 断言辅助：J8 只允许空 roster 返回 null。 */
async function aggOf(row: any): Promise<T7Aggregation> {
  const out = await aggregate(row)
  assert.ok(out !== null && out !== undefined, '非空 roster 必须输出聚合对象（J8：null 仅限空 roster）')
  return out as T7Aggregation
}
function expectAgg(actual: T7Aggregation, expected: T7Aggregation, message?: string): void {
  assert.ok(Number.isInteger(actual.totalMinutes), 'R3：totalMinutes 必为整数分钟')
  assert.deepEqual(
    { ...actual, missing: [...actual.missing].sort(), failed: [...actual.failed].sort() },
    { ...expected, missing: [...expected.missing].sort(), failed: [...expected.failed].sort() },
    message,
  )
}

/* ---------- 基底契约（真实 T6 写侧/回放路径，无需等 T7 实现） ---------- */

test('S1 基底消毒（A5/A9 写侧，F1/F2/J3）：非法键丢弃、非法 map 形状抛 INVALID_DELEGATE_ESTIMATES、null 清除', () => {
  const plan = makePlan('s1')
  const row = applyStatus(createStatuses(plan), 'T1', {
    delegateEstimates: { Good: est(15), Zero: est(0), Frac: est(1.5), Str: est('15'), Over: est(10081), BadAt: est(15, 'sent', { at: 0 }), BadDelivery: est(15, 'ok' as any) },
  })[0]
  assert.deepEqual(Object.keys(row.delegateEstimates), ['Good'], '任一必填非法⇒整条丢弃，绝不字符串强转')
  for (const bad of ['bogus', 5, []]) {
    assert.throws(
      () => applyStatus(createStatuses(makePlan('s1bad')), 'T1', { delegateEstimates: bad }),
      (err: any) => err?.code === 'INVALID_DELEGATE_ESTIMATES',
      `delegateEstimates=${JSON.stringify(bad)} 必须显式拒收`,
    )
  }
  assert.equal(applyStatus(createStatuses(makePlan('s1null')), 'T1', { delegateEstimates: null })[0].delegateEstimates, null)
})

test('S2 重置保留（A11 基底，T-5）：pending 重置清 delegates、留 map；显式 patch 优先；null 清除', () => {
  let statuses = applyStatus(createStatuses(makePlan('s2')), 'T1', {
    status: 'in_progress', delegates: [delegate('Expert-A', est(17))], delegateEstimates: { 'Expert-A': est(17) },
  })
  statuses = applyStatus(statuses, 'T1', { status: 'pending' })
  assert.equal(statuses[0].delegates, undefined, '重置清除尝试痕迹')
  assert.deepEqual(statuses[0].delegateEstimates['Expert-A'], est(17), '任务级配置保留')
  const explicit = est(99, 'sent', { at: 1600 })
  statuses = applyStatus(statuses, 'T1', { status: 'pending', delegateEstimates: { 'Expert-A': explicit } })
  assert.deepEqual(statuses[0].delegateEstimates['Expert-A'], explicit, '显式 patch 优先')
  statuses = applyStatus(statuses, 'T1', { status: 'pending', delegateEstimates: null })
  assert.equal(statuses[0].delegateEstimates, null)
})

test('S3 replan（A12 基底，T-7/T-8/R8）：旧行 closure=replanned 且台账追溯保留；新行台账全新为空', () => {
  const statuses = applyStatus(createStatuses(makePlan('s3')), 'T1', {
    status: 'in_progress', delegates: [delegate('Expert-A', est(17))], delegateEstimates: { 'Expert-A': est(17) },
  })
  const next = applyReplanStatuses(statuses, {
    revision: 2, at: 2000,
    marks: [{ subtaskId: 'T1', action: 'replace', replacedBy: ['T1b'], reason: '需求变更' }],
    added: [{ subtaskId: 'T1b', stageId: 'S1', title: '接替', department: 'engineering', role: '负责人', replaces: 'T1' }],
  } as any)
  const old = next.find((r: any) => r.subtaskId === 'T1')
  const fresh = next.find((r: any) => r.subtaskId === 'T1b')
  assert.equal(old.closure, 'replanned', '旧行退出 live（R8 消费侧据此过滤）')
  assert.deepEqual(old.delegateEstimates['Expert-A'], est(17), '旧行台账仅追溯保留')
  assert.equal(fresh.delegateEstimates, undefined, '新行无预估台账，从零起步')
  assert.equal(fresh.delegates, undefined, '新行无班子')
})

test('S4 durable 回放（A13 基底，T-10）：update 往返与 reconstruct 重建台账逐位一致', () => {
  const plan = makePlan('s4')
  const estimate = est(17, 'sent', { reason: '回放不丢', messageId: 'msg-7' })
  const message = buildUpdateMessage({
    planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 2,
    delegates: [delegate('Expert-A', estimate)], delegateEstimates: { 'Expert-A': estimate },
  })
  const parsed: any = parseUpdateMessage(message)
  assert.ok(parsed)
  const applied = applyStatus(createStatuses(plan), 'T1', parsed)
  assert.deepEqual(applied[0].delegateEstimates['Expert-A'], estimate)
  const session = fakeSession('session-root')
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', message)
  const rebuilt: any = reconstructFromSession(session)
  const row = rebuilt.statuses.find((r: any) => r.subtaskId === 'T1')
  assert.deepEqual(row.delegateEstimates['Expert-A'], estimate, '重启读档不丢')
  assert.deepEqual(row.delegates[0].estimate, estimate)
})

test('S5 journal 审计承载（A16 基底，F5）：failed 重试多条 estimate 可逐条审计', () => {
  const planId = makePlan('s5').planId
  const mk = (minutes: number, status: 'sent' | 'failed', ts: number) => ({
    v: 1, id: makeDeptMessageId(ts), ts, planId, subtaskId: 'T1', kind: 'estimate',
    from: { sessionId: 'sess-leaf', role: 'member', member: 'Expert-A' },
    to: { sessionId: 'sess-head', role: 'head' },
    body: `预估 ${minutes} 分钟`, data: { declaredMinutes: minutes },
    delivery: { status, messageId: `m-${ts}` },
  })
  for (const m of [mk(15, 'failed', 1000), mk(18, 'sent', 2000), mk(18, 'sent', 3000)]) {
    assert.equal(appendDeptMessage(m as any).ok, true)
  }
  const read = readDeptMessages(planId, { kind: 'estimate' })
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.messages.length, 3, '审计留痕追加式，允许多条（求和严禁以此为数据源）')
})

/* ---------- 聚合语义（[T7-ALIGN-1] 对齐后生效；spec §2 公式＋J1-J8） ---------- */

test('G1 ①严格求和（A1/A14/R3/R4/D3）：8 人全 sent＝算术和；负责人自报 timeNotice 不混入', async () => {
  const minutes = [5, 8, 13, 21, 34, 55, 89, 144]
  const members = minutes.map((_, i) => `M-${i}`)
  const map: Record<string, any> = {}
  members.forEach((m, i) => { map[m] = est(minutes[i]) })
  const row = {
    ...makeRow('g1', { delegates: members.map((m, i) => delegate(m, est(minutes[i]))), delegateEstimates: map }),
    timeNotice: { declaredMinutes: 999, at: 1500, channel: 'agent', reason: '负责人自身协调耗时' },
  }
  expectAgg(await aggOf(row), { totalMinutes: 369, reported: 8, expected: 8, missing: [], failed: [] })
})

test('G1b 边界与上界（R3/F4/J8）：1 与 10080 合法；12 人×10080=120960 不丢键且 isSafeInteger', async () => {
  const row = makeRow('g1b', { delegateEstimates: { A: est(1), B: est(10080) }, delegates: [delegate('A', est(1)), delegate('B', est(10080))] })
  expectAgg(await aggOf(row), { totalMinutes: 10081, reported: 2, expected: 2, missing: [], failed: [] })
  const many: Record<string, any> = {}
  const roster: any[] = []
  for (let i = 0; i < 12; i += 1) { many[`P-${i}`] = est(10080); roster.push(delegate(`P-${i}`, est(10080))) }
  const full = makeRow('g1c', { delegateEstimates: many, delegates: roster })
  const agg = await aggOf(full)
  expectAgg(agg, { totalMinutes: 120960, reported: 12, expected: 12, missing: [], failed: [] })
  assert.ok(Number.isSafeInteger(agg.totalMinutes), 'J8：和必须 Number.isSafeInteger')
  assert.ok(agg.totalMinutes <= 120960, 'J8：理论上界 12×10080')
})

test('G2 ②覆盖语义（A2/T-2/J5）：failed(15) 重试 sent(18) ⇒ 只计 18，不重复计数', async () => {
  let row = makeRow('g2', { delegates: [delegate('Expert-A', est(15, 'failed'))], delegateEstimates: { 'Expert-A': est(15, 'failed') } })
  expectAgg(await aggOf(row), { totalMinutes: 0, reported: 0, expected: 1, missing: [], failed: ['Expert-A'] })
  row = applyStatus([row], 'T1', { delegateEstimates: { 'Expert-A': est(18, 'sent', { at: 1600 }) } })[0]
  expectAgg(await aggOf(row), { totalMinutes: 18, reported: 1, expected: 1, missing: [], failed: [] })
})

test('G3 ②sent 幂等（A3/T-3/J5）：台账不变则聚合恒等；显式 patch 是唯一覆盖例外（spec §1.3.3）', async () => {
  const row = makeRow('g3', { delegates: [delegate('Expert-A', est(17))], delegateEstimates: { 'Expert-A': est(17) } })
  const first = await aggOf(row)
  expectAgg(first, { totalMinutes: 17, reported: 1, expected: 1, missing: [], failed: [] })
  expectAgg(await aggOf(row), first, 'sent 幂等：重复读取值恒等（self_effort 重报 30 被运行时忽略，T6 D6⑦ 已钉）')
  const patched = applyStatus([row], 'T1', { delegateEstimates: { 'Expert-A': est(30, 'sent', { at: 1700 }) } })[0]
  expectAgg(await aggOf(patched), { totalMinutes: 30, reported: 1, expected: 1, missing: [], failed: [] })
})

test('G4 ③只计 sent（A4/R2/D9）：sent(10)+failed(20)+非法键 ⇒ 总和 10，缺口如实分类', async () => {
  const row = makeRow('g4', {
    delegates: [delegate('S', est(10)), delegate('F', est(20, 'failed')), delegate('I', est(2.5))],
    delegateEstimates: { S: est(10), F: est(20, 'failed'), I: est(2.5) },
  })
  expectAgg(await aggOf(row), { totalMinutes: 10, reported: 1, expected: 3, missing: ['I'], failed: ['F'] })
})

test('G5 ④部分未上报（A8/J1 方案 A）：8 人班子仅 3 人 sent ⇒ 部分和＋3/8，missing/failed 名单正确', async () => {
  const members = Array.from({ length: 8 }, (_, i) => `M-${i}`)
  const map: Record<string, any> = { 'M-0': est(5), 'M-1': est(8), 'M-2': est(13), 'M-3': est(21, 'failed') }
  const row = makeRow('g5', { delegates: members.map((m) => delegate(m, map[m])), delegateEstimates: map })
  const agg = await aggOf(row)
  expectAgg(agg, { totalMinutes: 26, reported: 3, expected: 8, missing: ['M-4', 'M-5', 'M-6', 'M-7'], failed: ['M-3'] })
  assert.ok(agg.reported < agg.expected, '有缺口时禁止表述完整等式（R4/J1：等式仅 X=Y 成立）')
})

test('G6 读档优先级（A6/R6）：map 与 delegates[].estimate 不一致以 map 为准；map 缺失回退 delegates', async () => {
  const row = makeRow('g6', {
    delegates: [delegate('A', est(15)), delegate('B', est(7))],
    delegateEstimates: { A: est(18, 'sent', { at: 1600 }) },
  })
  expectAgg(await aggOf(row), { totalMinutes: 25, reported: 2, expected: 2, missing: [], failed: [] })
})

test('G7 班子作用域（A7/R5/J4/T-6）：残留键不计入；重置后未重派按 map 键集合', async () => {
  const row = makeRow('g7', {
    delegates: [delegate('B', est(8)), delegate('C', est(13))],
    delegateEstimates: { StaleA: est(99), B: est(8), C: est(13) },
  })
  expectAgg(await aggOf(row), { totalMinutes: 21, reported: 2, expected: 2, missing: [], failed: [] })
  const reset = applyStatus([row], 'T1', { status: 'pending' })[0]
  assert.equal(reset.delegates, undefined)
  expectAgg(await aggOf(reset), { totalMinutes: 120, reported: 3, expected: 3, missing: [], failed: [] })
})

test('G8 ⑦空台账/零下级（F3/J8）：空 roster⇒null 不得输出 0；map=null 仍有班子⇒全员缺口部分和 0', async () => {
  assert.equal(await aggregate(makeRow('g8a')), null, 'J8：无 delegates 且台账空⇒null/「无下属分工」，不得暗示 0 分钟即刻完成')
  assert.equal(await aggregate(makeRow('g8b', { delegates: [], delegateEstimates: {} })), null, 'J8：显式空班子＋空台账同样⇒null')
  assert.equal(await aggregate(makeRow('g8d', { delegateEstimates: null })), null, 'J8：map=null 且无 delegates⇒空 roster')
  const cleared = makeRow('g8c', { delegates: [delegate('A'), delegate('B')], delegateEstimates: null })
  const agg = await aggOf(cleared)
  expectAgg(agg, { totalMinutes: 0, reported: 0, expected: 2, missing: ['A', 'B'], failed: [] })
  assert.ok(agg.reported < agg.expected, 'F3：0 必须带缺口标注，不得表述为「负责人任务时长为 0 分钟」')
})

test('G9 非法输入 fail-closed（A5/F1/F6/J3 读侧）：非法按未上报、不强转不猜补、不反写台账', async () => {
  const raw: Record<string, any> = {
    Ok: est(10), Zero: est(0), Frac: est(1.5), Str: est('15'), Over: est(10081),
    BadAt: est(15, 'sent', { at: 0 }), BadDelivery: est(15, 'ok' as any), NotObj: 'x',
  }
  const row = { ...makeRow('g9', { delegates: Object.keys(raw).map((m) => delegate(m)) }), delegateEstimates: raw }
  const before = JSON.stringify(row)
  expectAgg(await aggOf(row), { totalMinutes: 10, reported: 1, expected: 8, missing: ['BadAt', 'BadDelivery', 'Frac', 'NotObj', 'Over', 'Str', 'Zero'], failed: [] })
  assert.equal(JSON.stringify(row), before, 'F6：纯读派生，不得反写/顺手修复台账')
})

test('G10 非法 map fail-closed（A9/F2）：数组/字符串/数字 ⇒ INVALID_DELEGATE_ESTIMATES 显式传播，不静默求和', async () => {
  for (const bad of [[], 'bogus', 5]) {
    const row = { ...makeRow('g10'), delegateEstimates: bad }
    await assert.rejects(
      () => aggregate(row),
      (err: any) => err?.code === 'INVALID_DELEGATE_ESTIMATES',
      `delegateEstimates=${JSON.stringify(bad)} 不得静默求和`,
    )
  }
})

test('G11 ⑤重置后重算（A11/T-5）：pending 重置后 sent 预估仍计入（roster 切换为 map 键）', async () => {
  const row = makeRow('g11', { delegates: [delegate('Expert-A', est(17)), delegate('Expert-B', est(8))], delegateEstimates: { 'Expert-A': est(17), 'Expert-B': est(8) } })
  const reset = applyStatus([row], 'T1', { status: 'pending' })[0]
  expectAgg(await aggOf(reset), { totalMinutes: 25, reported: 2, expected: 2, missing: [], failed: [] })
})

test('G12 ⑤replan 后重算（A12/T-7/T-8/R8/J8）：旧行冻结追溯、新行空 roster⇒null 从零起步', async () => {
  const statuses = applyStatus(createStatuses(makePlan('g12')), 'T1', {
    status: 'in_progress', delegates: [delegate('Expert-A', est(17))], delegateEstimates: { 'Expert-A': est(17) },
  })
  const next = applyReplanStatuses(statuses, {
    revision: 2, at: 2000,
    marks: [{ subtaskId: 'T1', action: 'replace', replacedBy: ['T1b'], reason: '需求变更' }],
    added: [{ subtaskId: 'T1b', stageId: 'S1', title: '接替', department: 'engineering', role: '负责人', replaces: 'T1' }],
  } as any)
  const old = next.find((r: any) => r.subtaskId === 'T1')
  const fresh = next.find((r: any) => r.subtaskId === 'T1b')
  assert.equal(old.closure, 'replanned', '[T7-ALIGN-2] 计划级 live 入口就绪后补排除断言')
  assert.equal(await aggregate(old), null, 'R8 行级闭环：closure=replanned⇒null（impl plan.ts:4973；agent-27 批准补断言）')
  assert.equal(await aggregate(fresh), null, '新行无班子无台账⇒空 roster null（J8），叶子重新上报后逐步累加')
})

test('G13 重启回放一致（A13/T-10）：durable 重建前后聚合逐位一致', async () => {
  const plan = makePlan('g13')
  const estimate = est(21, 'sent', { messageId: 'msg-13' })
  const message = buildUpdateMessage({
    planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 2,
    delegates: [delegate('Expert-A', estimate)], delegateEstimates: { 'Expert-A': estimate },
  })
  const applied = applyStatus(createStatuses(plan), 'T1', parseUpdateMessage(message) as any)
  const session = fakeSession('session-root')
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', message)
  const rebuilt: any = reconstructFromSession(session)
  const after = rebuilt.statuses.find((r: any) => r.subtaskId === 'T1')
  assert.deepEqual(await aggOf(after), await aggOf(applied[0]), '纯读派生无状态，回放前后恒等')
})

test('G14 journal 严禁参和（A16/F5/J5）：failed 重试多条 journal 不改变聚合值', async () => {
  const planId = makePlan('g14').planId
  const mk = (minutes: number, status: 'sent' | 'failed', ts: number) => ({
    v: 1, id: makeDeptMessageId(ts), ts, planId, subtaskId: 'T1', kind: 'estimate',
    from: { sessionId: 'sess-leaf', role: 'member', member: 'Expert-A' },
    to: { sessionId: 'sess-head', role: 'head' },
    body: `预估 ${minutes} 分钟`, data: { declaredMinutes: minutes },
    delivery: { status, messageId: `m-${ts}` },
  })
  for (const m of [mk(15, 'failed', 1000), mk(18, 'sent', 2000), mk(18, 'sent', 3000)]) {
    assert.equal(appendDeptMessage(m as any).ok, true)
  }
  const row = makeRow('g14', { delegates: [delegate('Expert-A', est(18, 'sent', { at: 2000 }))], delegateEstimates: { 'Expert-A': est(18, 'sent', { at: 2000 }) } })
  expectAgg(await aggOf(row), { totalMinutes: 18, reported: 1, expected: 1, missing: [], failed: [] })
  const read = readDeptMessages(planId, { kind: 'estimate' })
  assert.equal(read.ok, true)
  if (read.ok) assert.equal(read.messages.length, 3, 'journal 仅审计可查，条数与聚合无关')
})

test('G15 已结算成员仍计入（R7/T-9）：done 成员的 sent 预估保留且继续计入', async () => {
  const row = makeRow('g15', {
    delegates: [delegate('Done-A', est(17), { status: 'done' }), delegate('Run-B', est(8))],
    delegateEstimates: { 'Done-A': est(17), 'Run-B': est(8) },
  })
  expectAgg(await aggOf(row), { totalMinutes: 25, reported: 2, expected: 2, missing: [], failed: [] })
})

test('G16 J8 上界 fail-closed：合法和 isSafeInteger≤120960；越界输入绝不返回 >120960 的普通数值', async () => {
  /* [T7-ALIGN-3] 越界输出精确形态（null/异常标注/抛错）待 impl 交接冻结；此处钉 fail-closed 底线。
   * 构造绕过写侧消毒的原始行：13 人×10080=131040＞120960（F4：roster>12 属非法输入）。 */
  const many: Record<string, any> = {}
  const roster: any[] = []
  for (let i = 0; i < 13; i += 1) { many[`X-${i}`] = est(10080); roster.push(delegate(`X-${i}`, est(10080))) }
  const raw = { ...makeRow('g16'), delegates: roster, delegateEstimates: many }
  let out: any = null
  let threw = false
  try { out = await aggregate(raw) } catch { threw = true }
  const value = out?.totalMinutes
  assert.ok(
    threw || out === null || value === null || typeof value !== 'number' || (value <= 120960 && Number.isSafeInteger(value)),
    'J8：越界必须 fail-closed（截断/异常标注/null/抛错均可），绝不输出 >120960 的普通数值',
  )
})

test('G17 J8 不写回：聚合不改 row.timeNotice/timeJournal（O-2a 自报通道语义不变），负责人自报不混入等式', async () => {
  const timeNotice = { declaredMinutes: 45, at: 1500, channel: 'agent', reason: '负责人自报参考值' }
  const timeJournal = [{ action: 'estimate', declaredMinutes: 45, at: 1500 }]
  const row = {
    ...makeRow('g17', { delegates: [delegate('A', est(17))], delegateEstimates: { A: est(17) } }),
    timeNotice, timeJournal,
  }
  const beforeNotice = JSON.stringify(row.timeNotice)
  const beforeJournal = JSON.stringify(row.timeJournal)
  expectAgg(await aggOf(row), { totalMinutes: 17, reported: 1, expected: 1, missing: [], failed: [] })
  assert.equal(JSON.stringify(row.timeNotice), beforeNotice, 'J8：聚合值绝不写回 timeNotice（回放前后 diff 为空）')
  assert.equal(JSON.stringify(row.timeJournal), beforeJournal, 'J8：聚合值绝不写回 timeJournal（回放前后 diff 为空）')
})
