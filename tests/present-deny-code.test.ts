/*
 * [1.9.2] P1 拒绝码统一（T9 C05.denyCode 的修法）。
 *
 * 规则依据：
 *  - `_rerun_20261101/GATE_rule_design.md` §4.3（P1/P2、`judgeEffective`）、
 *    §4.4 R2（active 全 done 但证据缺口 ⇒ EVIDENCE_GAP）；
 *  - `_rerun_20261101/GATE_case_matrix.md` §3.2（最小修法：P1 在 remaining 为空
 *    且 blockers 非空时返回 EVIDENCE_GAP，其余仍 ACTIVE_NOT_READY）。
 *
 * 本文件钉住四件事：
 *  1. 码值是字面契约，取值与规则文档一致；
 *  2. P1 的「证据缺口」与「还有子任务没做完」不再同码，且只走一个映射函数；
 *  3. 取消/被取代的码值不被证据缺口抢走（终态优先）；
 *  4. `src/` 里不允许再出现散落的 `EVIDENCE_GAP` 字面量（只允许常量定义与注释）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

import {
  PRESENT_DENY_CODES,
  activeDenyCode,
  buildCancelMessage,
  buildPlanMessage,
  buildResultMessage,
  createStatuses,
  derivePlanSnapshot,
} from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

function makePlan(planId: string, count: number) {
  return {
    planId,
    sessionId: 'session-present-deny-code',
    createdTurn: 1,
    createdAt: 1000,
    title: `拒绝码用例 ${planId}`,
    contradictions: { primary: { statement: '计划未完成不得 present' } },
    stages: count === 0 ? [] : [{
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
    id: 'session-present-deny-code',
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
    subagents: { startActivation: async () => { throw new Error('never dispatch') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
    get: () => undefined,
  }
}

function runtimeFor() {
  return createWorkplanRuntime(makeCtx(), { version: 'test' }) as any
}

function markDone(status: any, verification = 'structured') {
  status.status = 'done'
  status.progress = 100
  status.verification = verification
  status.acceptance = verification === 'structured'
    ? [{ criterion: `${status.subtaskId} 验收`, result: 'pass', evidence: 'test' }]
    : []
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

test('码值契约：PRESENT_DENY_CODES 与规则文档逐字一致（对外契约，不可本地改名）', () => {
  assert.deepEqual(PRESENT_DENY_CODES, {
    ACTIVE_NOT_READY: 'ACTIVE_NOT_READY',
    EVIDENCE_GAP: 'EVIDENCE_GAP',
    CANCELLED_NAMED: 'CANCELLED_NAMED',
    SUPERSEDED_STALE: 'SUPERSEDED_STALE',
  })
})

test('P1 单一映射：证据缺口 ⇒ EVIDENCE_GAP；未做完 ⇒ ACTIVE_NOT_READY', () => {
  assert.equal(
    activeDenyCode({ remaining: [], blockers: ['T3 自检标记为未验证'] }),
    PRESENT_DENY_CODES.EVIDENCE_GAP,
    '全部 done 但证据缺口必须单列',
  )
  assert.equal(
    activeDenyCode({ remaining: ['T2'], blockers: [] }),
    PRESENT_DENY_CODES.ACTIVE_NOT_READY,
    '还有子任务没做完仍是 ACTIVE_NOT_READY',
  )
  assert.equal(
    activeDenyCode({ remaining: [], blockers: [] }),
    PRESENT_DENY_CODES.ACTIVE_NOT_READY,
    '无缺口时不得凭空返回 EVIDENCE_GAP（就绪计划根本不会走到映射）',
  )
})

test('P1 缺证据（R2/G02）：presentDenialVerdict 返回 EVIDENCE_GAP，文案与旧版逐字一致', () => {
  const plan = makePlan('wp-evidence', 3)
  const statuses: any[] = createStatuses(plan)
  markDone(statuses[0])
  markDone(statuses[1])
  markDone(statuses[2], 'unverified')
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  settle(session, plan, statuses)

  const runtime = runtimeFor()
  const verdict = runtime.presentDenialVerdict({ session })
  assert.ok(verdict, '证据缺口不得放行')
  assert.equal(verdict.code, PRESENT_DENY_CODES.EVIDENCE_GAP,
    '全部 done 但证据缺口 ⇒ EVIDENCE_GAP（不再是 ACTIVE_NOT_READY）')
  assert.equal(verdict.message, runtime.presentDenialReason({ session }),
    '兼容入口必须返回同一文案')
  assert.match(verdict.message, /计划 wp-evidence 的 3 个子任务虽都已 done，但证据未通过/)
  assert.match(verdict.message, /T3 自检标记为未验证/)
  assert.match(verdict.message, /T3 未提供验收项/)
  assert.match(verdict.message, /dsh_workplan_update/)
  assert.doesNotMatch(verdict.message, /^\[/, '拒绝文案保持逐字不变，不得加前缀')
})

test('P1 未完成：还有子任务没做完时返回 ACTIVE_NOT_READY，不是 EVIDENCE_GAP', () => {
  const plan = makePlan('wp-open', 3)
  const statuses: any[] = createStatuses(plan)
  markDone(statuses[0])
  markDone(statuses[1])
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  settle(session, plan, statuses)

  const verdict = runtimeFor().presentDenialVerdict({ session })
  assert.ok(verdict)
  assert.equal(verdict.code, PRESENT_DENY_CODES.ACTIVE_NOT_READY)
  assert.match(verdict.message, /计划 wp-open 未完成：完成 2\/3，剩余 1 项/)
})

test('多计划未就绪：按 T9 提案不细分，统一 ACTIVE_NOT_READY', () => {
  const planA = makePlan('wp-gap', 1)
  const statusesA: any[] = createStatuses(planA)
  markDone(statusesA[0], 'unverified')

  const planB = makePlan('wp-mid', 2)
  const statusesB: any[] = createStatuses(planB)
  markDone(statusesB[0])

  const session = makeSession()
  session.append('user/message', buildPlanMessage(planA))
  session.append('user/message', buildPlanMessage(planB))
  settle(session, planA, statusesA)
  settle(session, planB, statusesB)

  const verdict = runtimeFor().presentDenialVerdict({ session })
  assert.ok(verdict)
  assert.equal(verdict.code, PRESENT_DENY_CODES.ACTIVE_NOT_READY,
    'unresolved.length > 1 时保持 ACTIVE_NOT_READY（真值表 R4）')
  assert.match(verdict.message, /本会话还有 2 个计划未通过交付就绪检查/)
})

test('本回合点名的 cancelled：即使有证据缺口也返回 CANCELLED_NAMED（终态优先）', () => {
  // 1/2：全部 done 的取消计划会被 reconcilePhase 还原成 done（[1.5.2] 的既有语义），
  // 因此这里留一项未完成，钉住「终态码优先于 EVIDENCE_GAP」。
  const plan = makePlan('wp-cancel', 2)
  const statuses: any[] = createStatuses(plan)
  markDone(statuses[0], 'unverified')

  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  settle(session, plan, statuses)
  session.append('user/message', buildCancelMessage('wp-cancel'))
  // 第 2 回合点名：结果消息把 planId 带进当前回合。
  session.append('turn/start', { turn: 2 })
  settle(session, plan, statuses)

  const verdict = runtimeFor().presentDenialVerdict({ session })
  assert.ok(verdict)
  assert.equal(verdict.code, PRESENT_DENY_CODES.CANCELLED_NAMED)
  assert.match(verdict.message, /计划 wp-cancel 已取消，但只完成 1\/2，剩余 1 项/)
  assert.match(verdict.message, /证据缺口：T1 自检标记为未验证/)
})

test('非点名回合的 cancelled 不产生码值（终态解耦，1.9.0 保持项）', () => {
  const plan = makePlan('wp-cancel-idle', 2)
  const statuses: any[] = createStatuses(plan)
  markDone(statuses[0])
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  settle(session, plan, statuses)
  session.append('user/message', buildCancelMessage('wp-cancel-idle'))

  assert.equal(runtimeFor().presentDenialVerdict({ session }), undefined,
    '未点名的终态计划不挡门，也不该产出拒绝码')
})

test('superseded 覆盖链缺失：返回 SUPERSEDED_STALE（fail-closed）', () => {
  const record = {
    plan: makePlan('wp-sup', 1),
    phase: 'superseded',
    supersededBy: {},
  }
  const session = { id: 'session-present-deny-code', seq: 0, eventAt: () => undefined }
  const verdict = runtimeFor().supersededDenialVerdict(session, record)
  assert.ok(verdict)
  assert.equal(verdict.code, PRESENT_DENY_CODES.SUPERSEDED_STALE)
  assert.match(verdict.message, /缺少可验证的承接计划/)
})

test('已就绪的计划与 plan 模式不产生拒绝码（P0 与放行分支）', () => {
  const plan = makePlan('wp-ready', 1)
  const statuses: any[] = createStatuses(plan)
  markDone(statuses[0])
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  settle(session, plan, statuses)
  assert.equal(runtimeFor().presentDenialVerdict({ session }), undefined)

  const blocked = makePlan('wp-blocked', 1)
  const blockedSession = makeSession()
  blockedSession.append('user/message', buildPlanMessage(blocked))
  const projections = { snapshot: () => ({ values: { plan: { active: true } } }) }
  const runtime = createWorkplanRuntime(
    { ...makeCtx(), get: (name: string) => (name === 'sessionProjections' ? projections : undefined) },
    { version: 'test' },
  ) as any
  assert.equal(runtime.presentDenialVerdict({ session: blockedSession }), undefined,
    'plan 模式下 present 放行，不判定、不产出码值')
})

test('源码扫描：EVIDENCE_GAP 字面量只允许出现在常量定义与注释里', async () => {
  for (const file of ['plan.ts', 'runtime.ts', 'host.ts']) {
    const text = await readFile(path.resolve(process.cwd(), 'src', file), 'utf8')
    text.split('\n').forEach((line: string, index: number) => {
      if (!line.includes('EVIDENCE_GAP')) return
      const trimmed = line.trim()
      const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
      const isDefinition = line.includes("EVIDENCE_GAP: 'EVIDENCE_GAP'")
      const isReference = line.includes('PRESENT_DENY_CODES.EVIDENCE_GAP')
      assert.ok(isComment || isDefinition || isReference,
        `${file}:${index + 1} 出现未常量化字面量：${trimmed}`)
    })
  }
})
