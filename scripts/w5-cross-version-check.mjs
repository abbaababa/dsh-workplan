/*
 * W5 跨版本联测：
 *  A. 同一份真实会话日志切片（root.jsonl 6867..7175），分别用 1.8.19（bc0384c，
 *     事故时加载的版本）与当前源码驱动，对比 cancel → present → dispatch → steer。
 *  B. 当前源码写出的 superseded 信封，交给 1.8.19 读侧，验证「安全降级为 cancelled」。
 *
 * 用法：node w5_cross_version.mjs <oldRuntime.js> <newRuntime.js> <newPlan.js>
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [OLD_RUNTIME, NEW_RUNTIME, NEW_PLAN] = process.argv.slice(2)
if (!OLD_RUNTIME || !NEW_RUNTIME || !NEW_PLAN) {
  throw new Error('usage: node w5_cross_version.mjs <oldRuntime.js> <newRuntime.js> <newPlan.js>')
}
const newRt = await import(NEW_RUNTIME)
const newPlan = await import(NEW_PLAN)
const oldRt = await import(OLD_RUNTIME)

// [R-W5-01] the incident root-session log is an external fixture; override with W5_ROOT_LOG
const LOG = process.env.W5_ROOT_LOG ?? '/Users/open/Documents/Stocks/_baseline_work/root/root.jsonl'
const A = 'wp-bea31753-ec5f-4d97-89b6-c673308113e3'
const B = 'wp-4ad0038f-ef9c-4e9b-8907-9a3f414fe246'
const result = {}

/* ---------- A. 真实日志切片 A/B ---------- */
function loadSlice(lo, hi) {
  const events = []
  let lineSha = null
  let productionError = null
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const seq = obj.seq
    if (!Number.isInteger(seq)) continue
    if (seq === 7168) lineSha = createHash('sha256').update(line).digest('hex')
    if (seq === 7175) productionError = obj.data?.message?.content?.[0]?.text ?? null
    if (seq < lo || seq > hi) continue
    events.push({ type: obj.type, data: obj.data })
  }
  return { events, lineSha, productionError }
}
function makeSession(events, id) {
  return {
    id,
    header: { createdAt: 1793490000000 },
    get seq() { return events.length },
    append(type, data) { events.push({ type, data }); return data },
    eventAt(i) { return events[i] },
  }
}
function makeCtx() {
  return {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('W5: must not start a child') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    get: () => undefined,
    cwd: '/Users/open/Documents/Stocks',
  }
}
async function drive(mod, session, runtime) {
  const out = {}
  const recA = mod.reconstructFromSession(session, A)
  const recB = mod.reconstructFromSession(session, B)
  out.reconstructA = { phase: recA?.phase, cancelled: recA?.cancelled === true, cancelRecorded: recA?.cancelRecorded === true, done: recA?.statuses?.filter((s) => s.status === 'done').length, total: recA?.statuses?.length }
  out.reconstructB = { phase: recB?.phase, done: recB?.statuses?.filter((s) => s.status === 'done').length, total: recB?.statuses?.length }
  const verdict = () => {
    if (typeof runtime.presentDenialVerdict === 'function') {
      const v = runtime.presentDenialVerdict({ session })
      return v ? { code: v.code, message: v.message } : null
    }
    const message = runtime.presentDenialReason({ session })
    return message ? { code: 'NO_CODE_1_8_19', message } : null
  }
  out.presentBeforeCancel = verdict()
  const c = await runtime.cancelPlan({ session }, { planId: A, reason: 'W5 联测：真实日志切片重放' })
  out.cancel = { ok: c.ok, phase: c.phase, alreadyCancelled: c.alreadyCancelled === true, cancelRecorded: c.cancelRecorded === true }
  out.presentAfterCancel = verdict()
  const d = await runtime.dispatchTool({ session }, { planId: A }, undefined)
  out.dispatch = { ok: d.ok, code: d.code, phase: d.phase, remaining: d.remaining }
  const steered = []
  runtime.state.activeTurns.set(session.id, 26)
  await runtime.onTurnStopping({ agent: { session, steer: (m) => steered.push(m) }, turn: 26 })
  out.steers = steered.length
  out.steerHead = steered.map((m) => (m?.content ?? []).map((x) => x.text ?? '').join('').slice(0, 80))
  return out
}
{
  const sliceOld = loadSlice(6867, 7175)
  const sessionOld = makeSession(sliceOld.events.map((e) => ({ ...e })), 'w5-slice-old')
  const oldRuntime = oldRt.createWorkplanRuntime(makeCtx(), { version: 'w5-old' })
  const a = await drive(oldRt, sessionOld, oldRuntime)
  const sliceNew = loadSlice(6867, 7175)
  const sessionNew = makeSession(sliceNew.events.map((e) => ({ ...e })), 'w5-slice-new')
  const newRuntime = newRt.createWorkplanRuntime(makeCtx(), { version: 'w5-new' })
  const b = await drive(newRt, sessionNew, newRuntime)
  const strip = (s) => String(s ?? '').replace(/^Error: /, '')
  result.realSlice = {
    source: '_baseline_work/root/root.jsonl seq 6867..7175',
    event7168Sha256: sliceOld.lineSha,
    productionPresentError: sliceOld.productionError,
    old: a,
    current: b,
    oldMessageMatchesProductionError: strip(a.presentAfterCancel?.message) === strip(sliceOld.productionError),
    currentWouldStillDeny: b.presentAfterCancel !== null,
  }
}

/* ---------- B. 新写 superseded 信封 → 1.8.19 读侧 ---------- */
function makePlan(planId, count, turn) {
  return {
    planId, sessionId: 'w5-supersede', createdTurn: turn, createdAt: 1000,
    title: `W5 降级联测 ${planId}`,
    contradictions: { primary: { statement: '被取代不等于完成' } },
    stages: [{ id: 'S1', name: '实施', subtasks: Array.from({ length: count }, (_, i) => ({ id: `T${i + 1}`, title: `第 ${i + 1} 步`, department: 'engineering', dependsOn: i === 0 ? [] : [`T${i}`] })) }],
  }
}
function markDone(status) {
  status.status = 'done'; status.progress = 100; status.verification = 'structured'
  status.acceptance = [{ criterion: `${status.subtaskId} 验收`, result: 'pass', evidence: 'w5' }]
  status.missingArtifacts = []
}
function settle(session, plan, statuses) {
  session.append('user/message', newPlan.buildResultMessage({
    planId: plan.planId, sessionId: session.id, dispatchedAt: 2000,
    statuses, errors: [], stats: newPlan.derivePlanSnapshot(statuses).stats, phase: 'executing',
  }))
}
function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }] }
}
{
  const events = []
  const session = makeSession(events, 'w5-supersede')
  const planA = makePlan('wp-w5-a', 2, 1)
  const planB = makePlan('wp-w5-b', 2, 2)
  session.append('user/message', newPlan.buildPlanMessage(planA))
  session.append('user/message', newPlan.buildPlanMessage(planB))
  const statusesA = newPlan.createStatuses(planA)
  markDone(statusesA[0])
  settle(session, planA, statusesA)
  const statusesB = newPlan.createStatuses(planB)
  statusesB.forEach(markDone)
  settle(session, planB, statusesB)
  session.append('user/message', userMessage('w5-confirm', '确认把 wp-w5-a 的责任交给 wp-w5-b：逐项覆盖已核对。'))
  const runtime = newRt.createWorkplanRuntime(makeCtx(), { version: 'w5-write' })
  const cancelled = await runtime.cancelPlan({ session }, { planId: 'wp-w5-a', reason: '先取消' })
  const superseded = await runtime.cancelPlan({ session }, {
    planId: 'wp-w5-a', disposition: 'superseded', reason: '责任转移给承接计划',
    supersededBy: { planId: 'wp-w5-b', mapping: [
      { from: 'T1', to: 'T1', basis: '同一交付责任' },
      { from: 'T2', to: 'T2', basis: '同一交付责任' },
    ] },
  })
  const envelopes = events.map((e) => newPlan.parseCancelMessage(e.data)).filter((p) => p?.disposition === 'superseded')
  const oldRecord = oldRt.reconstructFromSession(session, 'wp-w5-a')
  /*
   * 旧读侧看到的是 cancelled（安全降级）。把这份记录按事故路径变成 old runtime
   * 的 live 记录（旧 cancel 工具对已取消计划是幂等的），再问旧 present 闸门：
   * 必须拒绝交付——否则「降级为可交付」就不是安全降级。
   */
  const oldRuntime = oldRt.createWorkplanRuntime(makeCtx(), { version: 'w5-old-read' })
  const oldCancel = await oldRuntime.cancelPlan({ session }, { planId: 'wp-w5-a', reason: 'W5 旧读侧复问' })
  const oldPresentMessage = oldRuntime.presentDenialReason({ session })
  const oldPresent = oldPresentMessage
    ? { denied: true, message: oldPresentMessage.slice(0, 140) }
    : { denied: false }
  const oldDispatch = await oldRuntime.dispatchTool({ session }, { planId: 'wp-w5-a' }, undefined)
  result.supersededDowngrade = {
    write: { cancelled: cancelled.phase, superseded: superseded.phase, code: superseded.code, coverage: superseded.coverage, envelopes: envelopes.length },
    envelopeFields: envelopes[0] ? Object.keys(envelopes[0]).sort() : null,
    oldReader: { phase: oldRecord?.phase, cancelled: oldRecord?.cancelled === true, superseded: oldRecord?.superseded === true, done: oldRecord?.statuses?.filter((s) => s.status === 'done').length, total: oldRecord?.statuses?.length },
    oldCancel: { ok: oldCancel.ok, phase: oldCancel.phase, alreadyCancelled: oldCancel.alreadyCancelled === true },
    oldPresent,
    oldDispatch: { ok: oldDispatch.ok, code: oldDispatch.code },
  }
}
console.log(JSON.stringify(result, null, 2))

/*
 * [R-W5-01] Release-checklist gate. These assertions only read the measured
 * fields above; the probe logic is unchanged. Exit 0 only when every invariant
 * that made the W5 A/B study meaningful still holds.
 */
const checks = []
const ck = (name, ok) => checks.push({ name, ok: ok === true })
const rs = result.realSlice
const sw = result.supersededDowngrade
ck('1.8.19 reproduces the production denial text', rs.oldMessageMatchesProductionError === true)
ck('1.8.19 traps the turn: present denied and steer fired', rs.old.presentAfterCancel !== null && rs.old.steers >= 1)
/*
 * [2.2.x][2026-11-09 T5] 断言 3 判据修订（1.11.0 口径 → 2.2.x 门禁语义；主 Agent G4 裁决选项 B）：
 * 1.11.0 原判据「新版 present 放行且 steer=0」已过期。1.9.1(c6c3a0a) 引入 EVIDENCE_GAP、
 * 1.11.0(71f0b65) 引入跨部门需求闸门后，现行「会话内全部计划一起判」的门禁会先命中日志切片
 * 中兄弟计划 wp-4ad0038f（8/8 done 但 H1–H5 未处置）的证据缺口；2.2.6 的对象感知读取把这段
 * 历史 handoff 正确解析出来，present 返回 EVIDENCE_GAP 正是本版证据门禁的设计语义（非回归）。
 * 新判据：无取消 trap（steers=0）且 present 拒绝码为 EVIDENCE_GAP、拒绝理由为未落实 handoff。
 * 依据与两次实测留档：工作区根目录 _t5_release_execution_20261109/w5-verdict-diagnosis-T5.md。
 */
ck('current does not trap: no steer; 2.2.x evidence gate denies present with EVIDENCE_GAP',
   rs.current.steers === 0 && rs.current.presentAfterCancel?.code === 'EVIDENCE_GAP'
     && (rs.current.presentAfterCancel.message ?? '').includes('需求未落实'))
ck('current still refuses dispatch on a terminal plan', rs.current.dispatch.code === 'PLAN_CANCELLED')
ck('superseded write yields one full-coverage envelope', sw.write.superseded === 'superseded' && sw.write.coverage === 'full' && sw.write.envelopes === 1)
ck('old reader downgrades superseded to cancelled and still refuses', sw.oldReader.phase === 'cancelled' && sw.oldReader.superseded === false && sw.oldPresent.denied === true && sw.oldDispatch.code === 'PLAN_CANCELLED')
const failed = checks.filter((c) => !c.ok)
console.log('\nW5 CROSS-VERSION:')
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}`)
console.log(failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.length})`)
process.exit(failed.length === 0 ? 0 : 1)
