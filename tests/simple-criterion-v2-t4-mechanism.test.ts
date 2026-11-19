/*
 * [SCv2-T4] 「简单」判据 v2 · T4 语义补丁机制回归（工程部门自证用例）。
 *
 * 口径唯一来源：reports/simple-criterion-v2-spec.md（用户 2026-11-13 裁决
 * B/B/B/B/A/A/B）＋ reports/simple-criterion-v2-touchpoints.md（C05–C10/C22/C29）
 * ＋ reports/simple-criterion-v2-open-decisions.md（D-1~D-4 推荐 A，待用户裁定）。
 * 本文件不反推预期：全部断言抄自 spec 的 S-/AC- 条目；T5 的 28 条 AC 用例集
 * （reports/simple-criterion-v2-cases.md）是独立验收层，与本文件互补。
 *
 * 覆盖：
 *  - D-1 生效边界（fail-closed，默认关闭＝在途/历史零影响，Q5-A）；
 *  - Q1-B extendMs 用户批准闸（EXTEND_NEEDS_USER_APPROVAL / 留痕落行 / 事后追认无效）；
 *  - Q2-B 估时 >10 软门禁（1–240 不压缩、0/241 仍拒、标记可查询）；
 *  - Q3-B/§3.5 结算三选一（met/unmet/exception-approved；unmet 不得 done＋违规审计）；
 *  - Q4-B 事前聚合（叶子和/直做自身预估，D-2；部分和不算齐，D-3）；
 *  - Q6-A 单次尝试墙钟（时间戳来源；重置清空⇒null 未验证，绝不按 0）；
 *  - Q7-B 运行层常量与公式零改动（900000/7200000/×2.0 clamp）；
 *  - C08 回放白名单（criterionResult/criterionException/criterionViolations 刷新不丢）。
 *
 * 计时口径：与既有时间测试同构——小窗口 childTimeoutMs + 10ms 轮询，不用真实长睡眠。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CRITERION_TARGET_MINUTES,
  appendCriterionViolation,
  attemptWallClockMsOf,
  criterionExAnte,
  criterionV2Active,
  evaluateCriterion,
  q3SettlementVerdict,
  sanitizeCriterionException,
} from '../src/criterion.js'
import { buildPlanMessage, deriveSubtaskTimeoutMs, normaliseStatusEntry, validatePlan } from '../src/plan.js'
import {
  CHILD_TIMEOUT_MS,
  MAX_CHILD_TIMEOUT_MS,
  createWorkplanRuntime,
  modelStatusLines,
  reconstructFromSession,
} from '../src/runtime.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
const workRoot = mkdtempSync(join(tmpdir(), 'wp-scv2-t4-'))
after(() => { clearInterval(eventLoopAnchor); rmSync(workRoot, { recursive: true, force: true }) })

const APPROVAL = { approvedBy: 'user', at: 1_500, reason: '用户批准原文：同意本任务放宽', scope: 'task' }

/* ---------------- D-1 生效边界（fail-closed） ---------------- */

test('D-1（执行时限取消）：开关、起点、createdAt 再齐全也不能激活 10 分钟判据', () => {
  assert.equal(criterionV2Active(2_000_000, {}), false)
  const env = { DSH_WORKPLAN_CRITERION_V2: '1', DSH_WORKPLAN_CRITERION_V2_SINCE: '1000000' }
  assert.equal(criterionV2Active(2_000_000, env), false)
  assert.equal(criterionV2Active(999_999, env), false)
  assert.equal(criterionV2Active(undefined, env), false)
  const iso = { DSH_WORKPLAN_CRITERION_V2: 'true', DSH_WORKPLAN_CRITERION_V2_SINCE: '2026-11-13T00:00:00Z' }
  assert.equal(criterionV2Active(Date.parse('2026-11-13T00:00:01Z'), iso), false)
  assert.equal(criterionV2Active(Number.MAX_SAFE_INTEGER, iso), false)
})

/* ---------------- Q1-B 批准留痕消毒 ---------------- */

test('Q1-B/S-Q1-2：criterionException 消毒 fail-closed（无留痕＝未批准）', () => {
  assert.deepEqual(sanitizeCriterionException(APPROVAL), APPROVAL)
  assert.equal(sanitizeCriterionException({ ...APPROVAL, approvedBy: 'agent' }), null, '主 Agent 自行批准无效')
  assert.equal(sanitizeCriterionException({ ...APPROVAL, reason: '  ' }), null, '批准原文空白＝无留痕')
  assert.equal(sanitizeCriterionException({ ...APPROVAL, scope: 'world' }), null, '适用范围必须 task/plan')
  assert.equal(sanitizeCriterionException({ ...APPROVAL, at: 0 }), null)
  assert.equal(sanitizeCriterionException(null), null)
  assert.equal(sanitizeCriterionException('user-approved'), null)
})

/* ---------------- Q6-A 单次尝试墙钟 ---------------- */

test('Q6-A/C29：墙钟只认时间戳；重置清空⇒null 未验证，绝不按 0 分钟', () => {
  assert.equal(attemptWallClockMsOf({ startedAt: 1_000, finishedAt: 61_000 }), 60_000)
  assert.equal(attemptWallClockMsOf({ startedAt: null, finishedAt: 61_000 }), null, '预算重置清空 startedAt 的陷阱')
  assert.equal(attemptWallClockMsOf({}), null)
  assert.equal(attemptWallClockMsOf({ startedAt: 5_000, finishedAt: 1_000 }), 0, '时钟抖动不为负')
})

/* ---------------- Q4-B/D-2/D-3 事前口径 ---------------- */

test('Q4-B/D-2/D-3：叶子和为事前值；直做取负责人自身预估；未齐不算齐', () => {
  assert.deepEqual(criterionExAnte({}, { totalMinutes: 12, reported: 3, expected: 3 }), { minutes: 12, complete: true })
  assert.deepEqual(criterionExAnte({}, { totalMinutes: 6, reported: 1, expected: 3 }), { minutes: 6, complete: false }, '部分和：未齐')
  assert.deepEqual(criterionExAnte({ timeNotice: { declaredMinutes: 7 } }, null), { minutes: 7, complete: true }, 'D-2 直做＝负责人自身预估')
  assert.deepEqual(criterionExAnte({}, null), { minutes: null, complete: false }, '直做无预估＝不得自动豁免（S-Q4-4）')
})

/* ---------------- §3.5 结算三选一 ---------------- */

test('§3.5/S-Q6-5/D-4：met=事前≤10 且事后≤10；任一超标无批准⇒unmet；批准⇒exception-approved', () => {
  const met = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: 8 * 60_000 })
  assert.equal(met.criterionResult, 'met'); assert.equal(met.canBeDone, true); assert.equal(met.needsReplacement, false)
  const wallOver = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: 11 * 60_000 })
  assert.equal(wallOver.criterionResult, 'unmet'); assert.equal(wallOver.canBeDone, false); assert.equal(wallOver.needsReplacement, true)
  const exAnteOver = evaluateCriterion({ exAnteMinutes: 12, exAnteComplete: true, wallClockMs: 5 * 60_000 })
  assert.equal(exAnteOver.criterionResult, 'unmet', 'D-4 双条件：事前 12 事后 5 仍不达标')
  const incomplete = evaluateCriterion({ exAnteMinutes: null, exAnteComplete: false, wallClockMs: 5 * 60_000 })
  assert.equal(incomplete.criterionResult, 'unmet', 'D-3 严格：预估未齐不得达标')
  const noWall = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: null })
  assert.equal(noWall.criterionResult, 'unmet', 'Q6 陷阱：墙钟缺失不得按 0 判达标')
  const approved = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: 11 * 60_000, exception: sanitizeCriterionException(APPROVAL), settledAt: 2_000 })
  assert.equal(approved.criterionResult, 'exception-approved'); assert.equal(approved.canBeDone, true); assert.equal(approved.exceptionRecorded, true)
  const late = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: 11 * 60_000, exception: sanitizeCriterionException(APPROVAL), settledAt: 1_000 })
  assert.equal(late.criterionResult, 'unmet', 'C-4 推荐 A：批准晚于结算＝事后追认无效')
  assert.ok(late.reasons.some((r) => r.includes('approval-after-settlement')))
})

test('T5 绑定适配器：q3SettlementVerdict 与参考实现 referenceQ3Settlement 同口径', () => {
  assert.equal(q3SettlementVerdict({ declaredMinutes: 23, wallClockMinutes: 23, userApproved: false }).criterionResult, 'unmet')
  assert.equal(q3SettlementVerdict({ declaredMinutes: 23, wallClockMinutes: 23, userApproved: true }).criterionResult, 'exception-approved')
  assert.equal(q3SettlementVerdict({ declaredMinutes: 6, wallClockMinutes: 6 }).criterionResult, 'met')
  assert.equal(q3SettlementVerdict({ declaredMinutes: 10, wallClockMinutes: 10 }).criterionResult, 'met', '边界 10 分钟达标')
  assert.equal(q3SettlementVerdict({ declaredMinutes: 11, wallClockMinutes: 0 }).criterionResult, 'unmet')
})

test('D-4 推荐 A：违规审计 append-only（续跑不洗白），上限 20 条', () => {
  const one = appendCriterionViolation([], { at: 1, attempt: 1, wallClockMs: 700_000, exAnteMinutes: 8, reasons: ['wall-clock-over'] })
  assert.equal(one.length, 1); assert.equal(one[0].kind, 'criterion-overrun')
  const two = appendCriterionViolation(one, { at: 2, attempt: 2, wallClockMs: 100, exAnteMinutes: 8, reasons: [] })
  assert.equal(two.length, 2, '原始违规保留，不因接替成功被抹除')
  const many = appendCriterionViolation(Array.from({ length: 25 }, (_, i) => ({ at: i })), { at: 99, attempt: 1, wallClockMs: null, exAnteMinutes: null, reasons: [] })
  assert.equal(many.length, 20)
})

/* ---------------- Q2-B 软门禁（GAP-1 消解：不硬拒绝） ---------------- */

function planWithSubtask(subtask: any) {
  return {
    version: 1,
    title: '判据 v2 软门禁验收',
    taskUnderstanding: { originalRequest: '验证 >10 软门禁', deliverable: '标记可查询', successCriteria: ['不硬拒绝'], constraints: [], knownFacts: [], unknowns: [], assumptions: [] },
    contradictions: { primary: { statement: '估高与拆小', evidence: ['估高会掩盖拆分需求'], whyPrimary: '防大任务' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', goal: '验证', rationale: '先验证', checkpoint: '通过', subtasks: [subtask] }],
    risks: [{ risk: '无', likelihood: 'low', impact: '无', mitigation: '无', trigger: '无' }],
    verification: [{ item: '软门禁', method: '单测', evidence: '本文件' }],
    practiceLoop: { plan: '列样例', do: '跑校验', check: '核对', act: '修正' },
  }
}
function subtask(extra: any = {}) {
  return { id: 'T1', title: '验证', department: 'research', role: '分析', objective: '验证软门禁', method: ['样例'], inputs: [], outputs: ['报告'], dependsOn: [], acceptance: ['断言通过'], risk: '无', ...extra }
}

test('Q2-B（执行时限取消）：1–240 保留、0/241 仍拒；任何时长都不再打 10 分钟标记', () => {
  for (const value of [1, 10, 11, 23, 90, 240]) {
    const res: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: value })))
    assert.equal(res.ok, true, `estimateMinutes=${value} 必须合法`)
    const row = res.plan.stages[0].subtasks[0]
    assert.equal(row.estimateMinutes, value, '原样保留，不改写')
    assert.equal(row.estimateOverCriterion, undefined, '不再有超 10 分钟标记')
    assert.equal(row.estimateNeedsJustification, undefined, '不要求补拆分说明')
  }
  for (const value of [0, 241, 1.5]) {
    const res: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: value })))
    assert.equal(res.ok, false, `estimateMinutes=${value} 必须拒绝`)
  }
  const withReason: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 23, splitReason: '拆成骨架与断言两步' })))
  assert.equal(withReason.ok, true, '历史拆分说明仍可回放')
  assert.equal(withReason.plan.stages[0].subtasks[0].splitReason, '拆成骨架与断言两步')
  const badReason: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 12, splitReason: 42 })))
  assert.equal(badReason.ok, false, 'splitReason 形状非法拒绝（数据卫生，不是时限门）')
  const badConfirm: any = validatePlan(planWithSubtask(subtask({ estimateMinutes: 12, estimateConfirm: { confirmed: 'yes' } })))
  assert.equal(badConfirm.ok, false, 'estimateConfirm 形状非法拒绝')
})

/* ---------------- Q7-B 运行层零改动 ---------------- */

test('Q7-B/AC-Q1-4/AC-Q7-2：运行层常量与派生公式逐字不变', () => {
  assert.equal(CHILD_TIMEOUT_MS, 900_000)
  assert.equal(MAX_CHILD_TIMEOUT_MS, 7_200_000)
  assert.equal(CRITERION_TARGET_MINUTES, 10)
  assert.equal(deriveSubtaskTimeoutMs(1), 120_000)
  assert.equal(deriveSubtaskTimeoutMs(5), 600_000)
  assert.equal(deriveSubtaskTimeoutMs(90), 7_200_000, '超 MAX 钳制')
  assert.equal(deriveSubtaskTimeoutMs(240), 7_200_000)
  assert.equal(deriveSubtaskTimeoutMs(undefined), undefined)
})

/* ---------------- 读时派生与消毒 ---------------- */

test('C29/C08：墙钟与历史判据字段只读消毒，执行时限固定为 none', () => {
  const entry = normaliseStatusEntry({ subtaskId: 'T1', status: 'done', startedAt: 1_000, finishedAt: 601_000, criterionResult: 'bogus', criterionException: { approvedBy: 'agent' }, timeNotice: { declaredMinutes: 12 } })
  assert.equal(entry.attemptWallClockMs, 600_000, '墙钟仅用于展示/审计')
  assert.equal(entry.criterionResult, null, '非法枚举降级 null')
  assert.equal(entry.criterionException, null, '非法批准消毒为 null')
  assert.equal(entry.leaderEstimateOverCriterion, false, '不再产生 10 分钟告警')
  assert.equal(entry.deadlineAt ?? null, null, '旧截止不得重新武装')
  const ok = normaliseStatusEntry({ subtaskId: 'T1', status: 'done', criterionResult: 'exception-approved', criterionException: APPROVAL })
  assert.equal(ok.criterionResult, 'exception-approved', '历史字段可回放')
  assert.deepEqual(ok.criterionException, APPROVAL)
  const pending = normaliseStatusEntry({ subtaskId: 'T1', status: 'pending', startedAt: 1_000, finishedAt: 601_000 })
  assert.equal(pending.attemptWallClockMs, undefined, 'pending 无计时')
  const lines = modelStatusLines([{ subtaskId: 'T1', status: 'blocked', startedAt: 1_000, finishedAt: 61_000, criterionResult: 'unmet', timeNotice: { declaredMinutes: 12 } }])
  assert.equal(lines[0].attemptWallClockMs, 60_000)
  assert.equal(lines[0].criterionResult, 'unmet', '历史结果只读展示')
  assert.equal(lines[0].leaderEstimateOverCriterion, false)
  assert.equal(lines[0].executionTimeLimit, 'none')
  assert.equal(lines[0].deadlineAt, null)
})

/* ---------------- 集成：真实 runtime ---------------- */

function makePlanMessage(createdAt: number) {
  return buildPlanMessage({
    planId: 'wp-scv2-t4', sessionId: 'session-scv2-t4', createdTurn: 1, createdAt,
    title: '判据 v2 机制验收',
    taskUnderstanding: { originalRequest: '验证判层机制', deliverable: '机制回归' },
    contradictions: { primary: { statement: '判据层与运行层分层' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '任务', department: 'engineering', objective: '验证', method: ['执行'], inputs: [], outputs: ['T1_report.md'], acceptance: ['产出'], risk: '无', dependsOn: [] }] }],
  })
}
function makeRuntime(createdAt: number, options: any = {}) {
  const session: any = {
    id: 'session-scv2-t4', header: { createdAt, cwd: workRoot }, events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) { this.events.push({ type, data }); return data },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', makePlanMessage(createdAt))
  // [2.5.2] 先配置后开工硬门禁：播种负责人自配推理等级（与 budget-pause 回放同法），
  // 否则 executeSubtask 在结算前抛 SELF_EFFORT_MISSING，到不了判据闸。
  seedLeaderSelfEffort(session, { planId: 'wp-scv2-t4', stages: [{ subtasks: [{ id: 'T1' }] }] })
  let release!: (value: any) => void
  const gatePromise = new Promise<any>((resolve) => { release = resolve })
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => { started = true; return { childId: 'child-scv2', result: gatePromise, dispose: async () => {} } },
      sendMessage: async () => 'msg-1',
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx as any, { totalTimeoutMs: 100_000, idleTimeoutMs: 60_000, strictEvidence: false, ...options })
  return { session, runtime, release, hasStarted: () => started }
}
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)) }
  return false
}
async function rowOf(runtime: any, session: any) {
  const snapshot: any = await runtime.statusTool({ session }, {})
  return (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
}
const ACTIVE_ENV = { DSH_WORKPLAN_CRITERION_V2: '1', DSH_WORKPLAN_CRITERION_V2_SINCE: '1000000' }
function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  return fn().finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
}
const completed = (text = '任务完成') => ({ stopReason: 'completed', output: [{ type: 'text', text }] })

test('C05 集成（新契约）：环境变量/时间再满足旧条件，extendMs 也只返回 TIME_LIMITS_DISABLED', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const { session, runtime, release, hasStarted } = makeRuntime(2_000_000, { childTimeoutMs: 60_000 })
    await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' }, new AbortController().signal)
    assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
    const denied: any = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 2_000, reason: '无批准放宽' })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'TIME_LIMITS_DISABLED')
    const approved: any = await runtime.updateStatus({ session }, {
      subtaskId: 'T1', extendMs: 2_000,
      criterionApproval: { ...APPROVAL, at: Date.now() - 1_000 },
    })
    assert.equal(approved.ok, false, '用户批准也不能复活已取消的时限')
    assert.equal(approved.code, 'TIME_LIMITS_DISABLED')
    const row = await rowOf(runtime, session)
    assert.equal(row.deadlineAt ?? null, null)
    assert.equal(row.criterionException ?? null, null, '不再写判据延期留痕')
    assert.ok(!(row.timeJournal ?? []).some((item: any) => item.action === 'extend' || item.action === 'criterion-exception'))
    release(completed())
  })
})

test('Q3-B 集成（新契约）：无 timeNotice、无判据也可以 done，不再因时长被 blocked', async () => {
  await withEnv(ACTIVE_ENV, async () => {
    const { session, runtime, release, hasStarted } = makeRuntime(2_000_000, { childTimeoutMs: 60_000 })
    await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' }, new AbortController().signal)
    assert.ok(await waitFor(hasStarted, 5_000))
    release(completed())
    let row: any = null
    assert.ok(await waitFor(async () => { row = await rowOf(runtime, session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 10_000), '应已结算')
    assert.equal(row.status, 'done', '真实完成不因缺预估/超 10 分钟被阻断')
    assert.notEqual(row.blockedKind, 'criterion-overrun')
    assert.notEqual(row.criterionResult, 'unmet')
    assert.equal((row.criterionViolations ?? []).length, 0, '不再生成时长违规审计')
    assert.doesNotMatch(String(row.error ?? ''), /criterion-overrun/)
  })
})

test('Q7-B 集成（新契约）：旧 1 秒窗口到点不 blocked、不落判据，真实完成仍 done', async () => {
  const { session, runtime, release, hasStarted } = makeRuntime(2_000_000, { childTimeoutMs: 1_000 })
  await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000))
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  let row: any = await rowOf(runtime, session)
  assert.equal(row.status, 'in_progress', '旧窗口到点仍执行')
  assert.equal(row.deadlineAt ?? null, null)
  assert.equal(row.criterionResult ?? null, null, '不再按时间落 met/unmet')
  assert.equal((row.criterionViolations ?? []).length, 0)
  assert.notEqual(row.blockedKind, 'criterion-overrun')
  release(completed())
  assert.ok(await waitFor(async () => {
    row = await rowOf(runtime, session)
    return row && row.status !== 'in_progress' && row.status !== 'pending'
  }, 10_000), '真实完成应正常结算')
  assert.equal(row.status, 'done')
  assert.notEqual(row.blockedKind, 'criterion-overrun')
})

test('C08 回放：结果消息携带的判据字段经 reconstructFromSession 不丢（刷新/重启同源）', () => {
  const plan = {
    planId: 'wp-scv2-replay', sessionId: 'session-scv2-replay', createdTurn: 1, createdAt: 2_000_000,
    title: '回放验收', stages: [{ id: 'S1', subtasks: [{ id: 'T1', title: '任务', department: 'engineering', dependsOn: [] }] }],
  }
  const session: any = {
    id: 'session-scv2-replay', header: { createdAt: 2_000_000, cwd: workRoot }, events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) { this.events.push({ type, data }); return data },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId: plan.planId, sessionId: plan.sessionId, plan })}\n<!-- DSH-WORKPLAN:END -->` }] })
  seedLeaderSelfEffort(session, plan)
  const resultPayload = {
    kind: 'workplan-result', version: 1, planId: plan.planId, sessionId: plan.sessionId,
    dispatchedAt: 5_000, phase: 'done',
    stats: { total: 1, done: 1, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
    statuses: [{ subtaskId: 'T1', status: 'done', progress: 100, criterionResult: 'exception-approved', criterionException: APPROVAL, criterionViolations: [{ kind: 'criterion-overrun', at: 1_400, attempt: 1 }] }],
    errors: [], resumeCount: 0, resumeAvailable: false,
  }
  session.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify(resultPayload)}\n<!-- DSH-WORKPLAN-RESULT:END -->` }] })
  const replayed: any = reconstructFromSession(session)
  assert.ok(replayed, '持久消息必须能重建计划')
  const row = replayed.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.criterionResult, 'exception-approved', 'criterionResult 活过回放')
  assert.deepEqual(row.criterionException, APPROVAL, '批准留痕活过回放（[2.2.0] 坑不复现）')
  assert.equal(row.criterionViolations.length, 1, '违规审计活过回放')
})
