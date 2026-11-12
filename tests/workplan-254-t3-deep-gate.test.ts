/*
 * [2.5.4][T3R1] 负责人分派前深度梳理质量闸（T3）聚焦回归。
 *
 * 锁七件事（与主 Agent/叶子同一 40/40/20 字判据，常量真源 three-phase）：
 *  G1 缺 consolidation ⇒ DELEGATE_CONSOLIDATION_MISSING（单元 + runtime 未
 *     review 直接 dispatch 两入口），dispatch 拒绝记入 gateAudit；
 *  G2/G3/G4 problemAnalysis/approach/approachBasis 非空但合计 <40/40/20 字
 *     ⇒ DELEGATE_CONSOLIDATION_INCOMPLETE，拒因含字段名与下限数字；
 *     合计=各项长度之和（多项求和语义），trim 后计数；
 *  G5 恰好 40/40/20 字边界 ⇒ 放行（含多项合计恰好达标、首尾空白不计数）；
 *  G6 合格产物 ⇒ ok:true，members/角色配比/等级不变；
 *  G7 runtime：薄 review 拒 + gateAudit 记拒 → 合格 review 登记 + 记放行
 *     → dispatch 过门禁；gateAudit 有界 20 条；status 返回 gateAudit；
 *  G8 空数组旧拒因与顺序不变（空检查先于字数闸）；
 *  G9 durable 读回/回放后判据不放松：薄产物 dispatch 仍拒；gateAudit 经
 *     buildUpdateMessage + reconstructFromSession 回放后仍在（A3 可复核）；
 *  G10 effortOverride 继承不回归：梳理未带整体等级时回落 taskEffortFallback，
 *     显式配置优先（T4 合规：复杂声明配 ≥8 人分工表）。
 *
 * runtime 夹具完全仿照 tests/delegate-tool.test.ts（createWorkplanRuntime +
 * makePlan + makeSession + fake subagents）；durable 回放仿照
 * tests/workplan-251-deep-think.test.ts 与 workplan-250-delegate-retry.test.ts。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { planDelegations } from '../src/llm-rules.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { buildPlanMessage, buildUpdateMessage, createStatuses } from '../src/plan.js'
import {
  MIN_PLANNING_APPROACH_CHARS,
  MIN_PLANNING_BASIS_CHARS,
  MIN_PLANNING_PROBLEM_CHARS,
} from '../src/three-phase.js'

const QWEN = 'qwen3.8-flash'

/** 确定性字数夹具：n 个汉字，length 恰为 n（避免手工计数误差）。 */
const chars = (n: number) => '字'.repeat(n)

function makePlan() {
  return {
    planId: 'wp-254-t3-deep-gate',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: '分派前深度梳理质量闸用例',
    contradictions: { primary: { statement: '质量与时间' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        { id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [] },
      ],
    }],
  }
}

function makeSession(id: string) {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000, cwd: '/tmp/t3-gate-cwd' },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeSubagents() {
  const spawned: any[] = []
  return {
    spawned,
    startActivation: async (request: any) => {
      const childId = `member-${spawned.length + 1}`
      let resolveResult: any
      const result = new Promise((resolve) => { resolveResult = resolve })
      spawned.push({ childId, request, resolveResult })
      return { childId, result, dispose: async () => {} }
    },
  }
}

function makeRuntime(model: string, provider = 'qw') {
  const plan = makePlan()
  const rootSession = makeSession('session-root')
  const subagents = makeSubagents()
  const ctx: any = {
    logger: { warn() {} },
    subagents,
    sessions: {
      get: (id: string) => (id === 'session-root' ? rootSession : undefined),
      list: () => [],
      eventAt: () => undefined,
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = 'child-leader'
  const record = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set('session-root', record)
  const leaderAgent = {
    session: { id: 'child-leader', header: { parentSession: 'session-root', cwd: '/tmp/t3-gate-cwd' } },
    options: { provider, model },
  }
  return { runtime, record, rootSession, subagents, leaderAgent }
}

/** 合格梳理产物（真实文本，字数已脚本核验：48 / 46 / 70）。 */
function goodConsolidation(overrides: any = {}) {
  return {
    problemAnalysis: ['现状：部门任务需要拆给专家与组员；目标是保质保量完成；约束是不改无关文件；主要矛盾是质量与时间。'],
    approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测', '组员做自测：逐条核对验收标准并落盘留证'],
    approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据，约束决定不改无关文件。'],
    assignments: [
      { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'xhigh' },
      { member: 'Member-B', role: 'member', task: '补充回归用例', reasoningEffort: 'low' },
    ],
    ...overrides,
  }
}

/* ---------- G1 缺产物：两入口同一拒因 ---------- */

test('G1 单元：未交 consolidation ⇒ DELEGATE_CONSOLIDATION_MISSING', () => {
  for (const input of [{}, { consolidation: null }, { consolidation: undefined }]) {
    const result = planDelegations(input as any)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DELEGATE_CONSOLIDATION_MISSING')
  }
})

test('G1 runtime：未 review 直接 dispatch ⇒ DELEGATE_CONSOLIDATION_MISSING，gateAudit 记拒', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_MISSING')
  const audit = record.statuses[0].gateAudit
  assert.ok(Array.isArray(audit) && audit.length >= 1, 'dispatch 拒绝必须留痕')
  const last = audit[audit.length - 1]
  assert.equal(last.action, 'dispatch')
  assert.equal(last.ok, false)
  assert.equal(last.code, 'DELEGATE_CONSOLIDATION_MISSING')
})

/* ---------- G2/G3/G4 薄产物：合计字数下限 ---------- */

test('G2：problemAnalysis 非空但合计 <40 字 ⇒ INCOMPLETE，拒因含字段名与 40', () => {
  const single = planDelegations({ consolidation: goodConsolidation({ problemAnalysis: [chars(39)] }), model: QWEN })
  assert.equal(single.ok, false)
  assert.equal(single.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(single.error!, /problemAnalysis/)
  assert.match(single.error!, /40/)
  // 合计语义：多项求和 20+19=39 仍拒，拒因报告实际合计字数。
  const multi = planDelegations({ consolidation: goodConsolidation({ problemAnalysis: [chars(20), chars(19)] }), model: QWEN })
  assert.equal(multi.ok, false)
  assert.equal(multi.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(multi.error!, /39/)
})

test('G3：approach 合计 <40 字 ⇒ INCOMPLETE，拒因含 approach 与 40', () => {
  const single = planDelegations({ consolidation: goodConsolidation({ approach: [chars(39)] }), model: QWEN })
  assert.equal(single.ok, false)
  assert.equal(single.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(single.error!, /approach/)
  assert.match(single.error!, /40/)
  const multi = planDelegations({ consolidation: goodConsolidation({ approach: [chars(19), chars(20)] }), model: QWEN })
  assert.equal(multi.ok, false)
  assert.equal(multi.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
})

test('G4：approachBasis 合计 <20 字 ⇒ INCOMPLETE，拒因含 approachBasis 与 20', () => {
  const single = planDelegations({ consolidation: goodConsolidation({ approachBasis: [chars(19)] }), model: QWEN })
  assert.equal(single.ok, false)
  assert.equal(single.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(single.error!, /approachBasis/)
  assert.match(single.error!, /20/)
  const multi = planDelegations({ consolidation: goodConsolidation({ approachBasis: [chars(10), chars(9)] }), model: QWEN })
  assert.equal(multi.ok, false)
  assert.equal(multi.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
})

/* ---------- G5 边界恰好达标 ---------- */

test('G5：恰好 40/40/20 字 ⇒ 放行；常量与主 Agent/叶子同一真源', () => {
  assert.equal(MIN_PLANNING_PROBLEM_CHARS, 40)
  assert.equal(MIN_PLANNING_APPROACH_CHARS, 40)
  assert.equal(MIN_PLANNING_BASIS_CHARS, 20)
  const exact = planDelegations({
    consolidation: {
      problemAnalysis: [chars(40)],
      approach: [chars(40)],
      approachBasis: [chars(20)],
      assignments: goodConsolidation().assignments,
    },
    model: QWEN,
  })
  assert.equal(exact.ok, true, JSON.stringify(exact))
  // 多项合计恰好达标：20+20 / 19+21 / 10+10。
  const multi = planDelegations({
    consolidation: {
      problemAnalysis: [chars(20), chars(20)],
      approach: [chars(19), chars(21)],
      approachBasis: [chars(10), chars(10)],
      assignments: goodConsolidation().assignments,
    },
    model: QWEN,
  })
  assert.equal(multi.ok, true, JSON.stringify(multi))
  // trim 后计数：首尾空白不占字数，恰好达标仍放行。
  const trimmed = planDelegations({
    consolidation: {
      problemAnalysis: ['  ' + chars(40) + '  '],
      approach: ['\n' + chars(40) + '\t'],
      approachBasis: [' ' + chars(20) + ' '],
      assignments: goodConsolidation().assignments,
    },
    model: QWEN,
  })
  assert.equal(trimmed.ok, true, JSON.stringify(trimmed))
})

/* ---------- G6 合格产物 ---------- */

test('G6：合格产物 ⇒ ok:true，members/角色配比/等级不变', () => {
  const result = planDelegations({ consolidation: goodConsolidation(), model: QWEN })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.members.length, 2)
  assert.deepEqual(result.members.map((m) => m.role), ['expert', 'member'])
  assert.deepEqual(result.members.map((m) => m.effort), ['xhigh', 'low'])
  assert.equal(result.consolidation!.approachBasis.length, 1)
})

/* ---------- G7 runtime 全链路 + gateAudit ---------- */

test('G7 runtime：薄 review 拒+记拒 → 合格 review 登记+记放 → dispatch 过门禁；status 返回 gateAudit', async () => {
  const { runtime, leaderAgent, record, subagents } = makeRuntime(QWEN)
  const thin = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: goodConsolidation({ problemAnalysis: [chars(39)] }),
  })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(thin.error!, /problemAnalysis/)
  assert.equal(record.statuses[0].consolidation, undefined, '薄产物不得登记')
  let audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['review', false, 'DELEGATE_CONSOLIDATION_INCOMPLETE'],
  )
  const good = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation() })
  assert.equal(good.ok, true, JSON.stringify(good))
  audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['review', true, null],
  )
  const dispatched = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  assert.equal(subagents.spawned.length, 2, '合格梳理后 dispatch 必须为专家与组员各派生叶子')
  audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['dispatch', true, null],
  )
  const status = await runtime.delegateTool(leaderAgent, { action: 'status' })
  assert.equal(status.ok, true)
  assert.ok(status.gateAudit.length >= 3, 'status 必须返回可复核的门禁审计')
})

test('G7b：gateAudit 有界 20 条——连续拒绝只保留最近 20 条', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  for (let i = 0; i < 22; i += 1) {
    const result = await runtime.delegateTool(leaderAgent, {
      action: 'review',
      consolidation: goodConsolidation({ approachBasis: [chars(19)] }),
    })
    assert.equal(result.ok, false)
  }
  const audit = record.statuses[0].gateAudit
  assert.equal(audit.length, 20)
  assert.ok(audit.every((entry: any) => entry.action === 'review' && entry.ok === false))
})

/* ---------- G8 空数组旧拒因顺序不变 ---------- */

test('G8：空数组仍按原拒因拒绝（空检查先于字数闸），顺序不变', () => {
  const base = goodConsolidation()
  const noAnalysis = planDelegations({ consolidation: { ...base, problemAnalysis: [] }, model: QWEN })
  assert.equal(noAnalysis.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(noAnalysis.error!, /problemAnalysis 至少 1 条/)
  const noAssignments = planDelegations({ consolidation: { ...base, assignments: [] }, model: QWEN })
  assert.equal(noAssignments.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(noAssignments.error!, /assignments/)
  const noApproach = planDelegations({ consolidation: { ...base, approach: [] }, model: QWEN })
  assert.equal(noApproach.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(noApproach.error!, /approach 至少 1 条/)
  assert.match(noApproach.error!, /第二轮/)
  const noBasis = planDelegations({ consolidation: { ...base, approachBasis: [] }, model: QWEN })
  assert.equal(noBasis.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(noBasis.error!, /approachBasis 至少 1 条/)
  // 顺序：problemAnalysis 空先于 assignments 空。
  const both = planDelegations({ consolidation: { ...base, problemAnalysis: [], assignments: [] }, model: QWEN })
  assert.match(both.error!, /problemAnalysis/)
})

/* ---------- G9 durable 读回/回放后判据不放松 ---------- */

test('G9：状态行读回薄产物（旧存档形态）⇒ dispatch 仍拒并记入 gateAudit', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  // 模拟 durable 读回：薄 consolidation 已在状态行上（绕过 review 写入路径）。
  record.statuses[0].consolidation = {
    problemAnalysis: [chars(39)],
    approach: [chars(40)],
    approachBasis: [chars(20)],
    assignments: goodConsolidation().assignments,
  }
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(result.error!, /problemAnalysis/)
  const audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['dispatch', false, 'DELEGATE_CONSOLIDATION_INCOMPLETE'],
  )
})

test('G9b：gateAudit durable 回放——刷新/重启后拒绝/放行记录仍可复核', async () => {
  const { runtime, leaderAgent, rootSession, record } = makeRuntime(QWEN)
  rootSession.append('user/message', buildPlanMessage(record.plan))
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ problemAnalysis: [chars(39)] }) })
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const rebuilt: any = reconstructFromSession(rootSession)
  assert.ok(rebuilt?.plan, '计划必须可重建')
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.ok(Array.isArray(row.gateAudit), 'gateAudit 必须随 durable 回放恢复')
  assert.deepEqual(
    row.gateAudit.map((entry: any) => [entry.action, entry.ok]),
    [['review', false], ['review', true], ['dispatch', true]],
  )
  assert.equal(row.gateAudit[0].code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.equal(row.gateAudit[1].code, null)
  // 回放后的合格梳理仍过同一判据。
  const recheck = planDelegations({ consolidation: row.consolidation, model: QWEN })
  assert.equal(recheck.ok, true, JSON.stringify(recheck))
})

test('G9c：薄产物旧存档经 durable 回放 ⇒ 同一判据仍拒（回放不豁免）', () => {
  const plan = makePlan()
  const session = makeSession('session-root')
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId,
    subtaskId: 'T1',
    status: 'in_progress',
    revision: 2,
    consolidation: {
      problemAnalysis: [chars(39)],
      approach: [chars(40)],
      approachBasis: [chars(20)],
      assignments: goodConsolidation().assignments,
    },
  }))
  const rebuilt: any = reconstructFromSession(session)
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.ok(row.consolidation, '旧存档梳理登记可回放')
  const result = planDelegations({ consolidation: row.consolidation, model: QWEN })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(result.error!, /problemAnalysis/)
})

/* ---------- G10 effortOverride 继承不回归 ---------- */

test('G10：梳理未带整体等级 ⇒ 继承 taskEffortFallback；显式配置优先（T4 合规分工表）', () => {
  // 复杂声明档（xhigh）按 T4 须 ≥8 人：1 expert + 7 member，均未单独配档。
  const eight = Array.from({ length: 8 }, (_, i) => ({
    member: `M${i + 1}`,
    role: i === 0 ? 'expert' : 'member',
    task: `单一目标子任务 ${i + 1}（单一主产物、可独立验收）`,
  }))
  const inherited = planDelegations({ consolidation: goodConsolidation({ assignments: eight }), model: QWEN, taskEffortFallback: 'xhigh' })
  assert.equal(inherited.ok, true, JSON.stringify(inherited))
  assert.equal(inherited.taskEffort, 'xhigh')
  assert.deepEqual(inherited.members.map((m) => m.effort), Array(8).fill('xhigh'))
  const explicit = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'low' }), model: QWEN, taskEffortFallback: 'xhigh' })
  assert.equal(explicit.ok, true, JSON.stringify(explicit))
  assert.equal(explicit.taskEffort, 'low', '显式配置优先于回落源')
})
