/*
 * [3.0.8] 负责人 review 开工闸（startPhases 五步开工证据）聚焦回归（T3R1 迁移版）。
 *
 * 锁七件事（与主 Agent/叶子同一判据，常量真源 src/five-step.ts）：
 *  G1 缺 consolidation ⇒ DELEGATE_CONSOLIDATION_MISSING（单元 + runtime 未
 *     review 直接 dispatch 两入口），dispatch 拒绝记入 gateAudit；
 *  G1b review 缺 startPhases ⇒ START_EVIDENCE_MISSING（runtime 入口，不登记）；
 *  G2/G3/G4 startPhases.planning.problemAnalysis/approach/approachBasis 非空但合计
 *     <40/40/20 字 ⇒ START_EVIDENCE_INCOMPLETE（判据真源 validateStartPhaseEvidence；
 *     runtime review 入口同一拒因），拒因含字段名与下限数字；合计=各项长度之和
 *     （多项求和语义），trim 后计数；
 *  G5 恰好 40/40/20 字边界 ⇒ 放行（含多项合计恰好达标、首尾空白不计数），
 *     边界经 MIN_* 常量构造；
 *  G6 合格分工表（consolidation 瘦身后）⇒ planDelegations ok:true，members/等级不变；
 *  G7 runtime：薄开工证据 review 拒+记拒 → 合格 review 登记+记放行 → dispatch 过
 *     门禁；gateAudit 有界 20 条；status 返回 gateAudit；
 *  G8 空数组拒因与顺序：开工证据空数组按「至少需要 1 条非空内容」拒；review 入口
 *     开工证据闸先于分工表闸；assignments 空检查先于人数闸；
 *  G9 durable 读回/回放后判据不放松：旧存档分工表 dispatch 仍拒；gateAudit 经
 *     buildUpdateMessage + reconstructFromSession 回放后仍在（A3 可复核）；
 *  G10 effortOverride 继承不回归：梳理未带整体等级时回落 taskEffortFallback，
 *     显式配置优先（T4 合规：复杂声明配 ≥8 人分工表）。
 *
 * [3.0.8] consolidation 不再携带 problemAnalysis/approach/approachBasis（原两轮
 * 思考产物）——再传会编译错；第 1/2/3 步证据改由 startPhases 承载。
 *
 * runtime 夹具完全仿照 tests/delegate-tool.test.ts（createWorkplanRuntime +
 * makePlan + makeSession + fake subagents）；durable 回放仿照
 * tests/workplan-251-deep-think.test.ts 与 workplan-250-delegate-retry.test.ts。
 *
 * [2.5.5][T3] 夹具适配（负责人裁决，门禁实现与夹具适配同批交付）：low/未配置禁派后，
 * 质量闸/放行类用例经 complexReview()（声明 medium＋8 人表）绕过禁派闸，原断言意图
 * 零删改；G10 显式档 low→medium 承载同一优先级意图。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { planDelegations } from '../src/llm-rules.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { buildPlanMessage, buildUpdateMessage, createStatuses, flushPendingWorkplanUpdates } from '../src/plan.js'
import {
  MIN_PLANNING_APPROACH_CHARS,
  MIN_PLANNING_BASIS_CHARS,
  MIN_PLANNING_PROBLEM_CHARS,
  validateStartPhaseEvidence,
} from '../src/five-step.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

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

/*
 * [3.0.8] consolidation 瘦身为分工表＋等级配置（梳理产物已改由 startPhases 承载）。
 * 原 goodConsolidation() 的真实文案移入 goodStartPhases()（开工证据口径）。
 */
function goodConsolidation(overrides: any = {}) {
  return {
    assignments: [
      { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', reasoningEffort: 'xhigh', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
      { member: 'Member-B', role: 'expert', task: '补充核心路径回归用例', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    ],
    ...overrides,
  }
}

/** 合格开工证据（真实文本，字数已脚本核验：48 / 46 / 70）。 */
function goodStartPhases(overrides: any = {}) {
  const base: any = JSON.parse(JSON.stringify(MAIN_START_PHASES_FIXTURE))
  for (const [key, value] of Object.entries(overrides)) {
    if (key in base.planning) base.planning[key] = value
    else base.preparation[key] = value
  }
  return base
}

// [2.5.5][T3] 夹具适配（原则①）：low/未配置禁派后，质量闸用例须带复杂声明绕过禁派闸；
// 复杂声明触发 ≥8 人闸，故放行类用例分工表扩到 8 人——前两条保持原夹具语义
// （Expert-A xhigh / Member-B low），原断言意图零删改。
const eightAssignments = () => [
  ...goodConsolidation().assignments,
  ...Array.from({ length: 6 }, (_, i) => ({
    member: `Member-${i + 3}`, role: 'expert', task: `单一目标子任务 ${i + 3}（单一主产物、可独立验收）`, qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
  })),
]
const complexReview = () => goodConsolidation({ taskReasoningEffort: 'medium', assignments: eightAssignments() })

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

test('G1b runtime：review 缺 startPhases ⇒ START_EVIDENCE_MISSING，不登记、留痕', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  const result = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: complexReview() })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'START_EVIDENCE_MISSING')
  assert.match(result.error!, /startPhases/)
  assert.equal(record.statuses[0].consolidation, undefined, '开工证据缺失不得登记')
  assert.equal(record.statuses[0].startPhases, undefined, '开工证据缺失不得登记')
  const audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['review', false, 'START_EVIDENCE_MISSING'],
  )
})

/* ---------- G2/G3/G4 薄开工证据：合计字数下限（判据真源 validateStartPhaseEvidence） ---------- */

test('G2：problemAnalysis 非空但合计 <40 字 ⇒ START_EVIDENCE_INCOMPLETE，拒因含字段名与 40', () => {
  const single = validateStartPhaseEvidence(goodStartPhases({ problemAnalysis: [chars(39)] }))
  assert.equal(single.ok, false)
  assert.equal(single.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(single.error!, /problemAnalysis/)
  assert.match(single.error!, /40/)
  // 合计语义：多项求和 20+19=39 仍拒，拒因报告实际合计字数。
  const multi = validateStartPhaseEvidence(goodStartPhases({ problemAnalysis: [chars(20), chars(19)] }))
  assert.equal(multi.ok, false)
  assert.equal(multi.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(multi.error!, /39/)
})

test('G3：approach 合计 <40 字 ⇒ START_EVIDENCE_INCOMPLETE，拒因含 approach 与 40', () => {
  const single = validateStartPhaseEvidence(goodStartPhases({ approach: [chars(39)] }))
  assert.equal(single.ok, false)
  assert.equal(single.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(single.error!, /approach/)
  assert.match(single.error!, /40/)
  const multi = validateStartPhaseEvidence(goodStartPhases({ approach: [chars(19), chars(20)] }))
  assert.equal(multi.ok, false)
  assert.equal(multi.code, 'START_EVIDENCE_INCOMPLETE')
})

test('G4：approachBasis 合计 <20 字 ⇒ START_EVIDENCE_INCOMPLETE，拒因含 approachBasis 与 20', () => {
  const single = validateStartPhaseEvidence(goodStartPhases({ approachBasis: [chars(19)] }))
  assert.equal(single.ok, false)
  assert.equal(single.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(single.error!, /approachBasis/)
  assert.match(single.error!, /20/)
  const multi = validateStartPhaseEvidence(goodStartPhases({ approachBasis: [chars(10), chars(9)] }))
  assert.equal(multi.ok, false)
  assert.equal(multi.code, 'START_EVIDENCE_INCOMPLETE')
})

test('G2 runtime：review 入口薄开工证据 ⇒ 同一拒因，不登记、记拒', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  const thin = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: complexReview(),
    startPhases: goodStartPhases({ problemAnalysis: [chars(39)] }),
  })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(thin.error!, /problemAnalysis/)
  assert.equal(record.statuses[0].consolidation, undefined, '薄开工证据不得登记')
  assert.equal(record.statuses[0].startPhases, undefined, '薄开工证据不得登记')
  const audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['review', false, 'START_EVIDENCE_INCOMPLETE'],
  )
})

/* ---------- G5 边界恰好达标 ---------- */

test('G5：恰好 40/40/20 字 ⇒ 放行；常量与主 Agent/叶子同一真源', () => {
  assert.equal(MIN_PLANNING_PROBLEM_CHARS, 40)
  assert.equal(MIN_PLANNING_APPROACH_CHARS, 40)
  assert.equal(MIN_PLANNING_BASIS_CHARS, 20)
  // 边界经 MIN_* 常量构造（resources/tools/prepared/evidence 同步给足下限）。
  const exact = validateStartPhaseEvidence({
    planning: {
      problemAnalysis: [chars(MIN_PLANNING_PROBLEM_CHARS)],
      approach: [chars(MIN_PLANNING_APPROACH_CHARS)],
      approachBasis: [chars(MIN_PLANNING_BASIS_CHARS)],
      resources: [chars(20)],
      tools: [chars(10)],
    },
    preparation: { prepared: [chars(20)], evidence: [chars(20)] },
  })
  assert.equal(exact.ok, true, JSON.stringify(exact))
  // 多项合计恰好达标：20+20 / 19+21 / 10+10。
  const multi = validateStartPhaseEvidence({
    planning: {
      problemAnalysis: [chars(20), chars(20)],
      approach: [chars(19), chars(21)],
      approachBasis: [chars(10), chars(10)],
      resources: [chars(20)],
      tools: [chars(10)],
    },
    preparation: { prepared: [chars(20)], evidence: [chars(20)] },
  })
  assert.equal(multi.ok, true, JSON.stringify(multi))
  // trim 后计数：首尾空白不占字数，恰好达标仍放行。
  const trimmed = validateStartPhaseEvidence({
    planning: {
      problemAnalysis: ['  ' + chars(MIN_PLANNING_PROBLEM_CHARS) + '  '],
      approach: ['\n' + chars(MIN_PLANNING_APPROACH_CHARS) + '\t'],
      approachBasis: [' ' + chars(MIN_PLANNING_BASIS_CHARS) + ' '],
      resources: [chars(20)],
      tools: [chars(10)],
    },
    preparation: { prepared: [chars(20)], evidence: [chars(20)] },
  })
  assert.equal(trimmed.ok, true, JSON.stringify(trimmed))
})

/* ---------- G6 合格分工表 ---------- */

test('G6：合格分工表 ⇒ ok:true，members/角色配比/等级不变', () => {
  // [2.5.5][T3] 原则①：复杂声明＋8 人表；前两条成员的角色/显式档断言逐字保留，
  // 新增 6 名未配档组员继承整体档 medium（继承语义另见 G10）。
  const result = planDelegations({ consolidation: complexReview(), model: QWEN })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.members.length, 8)
  // [3.0.0][用户要求 9] 组员角色取消：前两名也都是 expert（角色断言改成员名，等级断言不变）。
  assert.deepEqual(result.members.slice(0, 2).map((m) => m.member), ['Expert-A', 'Member-B'])
  assert.deepEqual(result.members.slice(0, 2).map((m) => m.effort), ['xhigh', 'low'])
  // [3.0.8] consolidation 结果只留分工表计数与整体等级（梳理字段已删除）。
  assert.equal(result.consolidation!.assignments, 8)
  assert.equal(result.consolidation!.taskReasoningEffort, 'medium')
})

/* ---------- G7 runtime 全链路 + gateAudit ---------- */

test('G7 runtime：薄 review 拒+记拒 → 合格 review 登记+记放 → dispatch 过门禁；status 返回 gateAudit', async () => {
  const { runtime, leaderAgent, record, subagents } = makeRuntime(QWEN)
  const thin = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: complexReview(),
    startPhases: goodStartPhases({ problemAnalysis: [chars(39)] }),
  })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(thin.error!, /problemAnalysis/)
  assert.equal(record.statuses[0].consolidation, undefined, '薄开工证据不得登记')
  let audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['review', false, 'START_EVIDENCE_INCOMPLETE'],
  )
  const good = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: complexReview(), startPhases: goodStartPhases() })
  assert.equal(good.ok, true, JSON.stringify(good))
  audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['review', true, null],
  )
  const dispatched = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  // [2.5.5][T3] 原则①：复杂声明 8 人分工表 ⇒ 派生 8 叶子（原 2 人），门禁链路意图不变。
  assert.equal(subagents.spawned.length, 8, '合格开工证据登记后 dispatch 必须为专家派生叶子')
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
    // [2.5.5][T3] 原则①：补复杂声明，使拒绝真正来自开工证据闸（而非禁派闸），有界审计意图不变。
    const result = await runtime.delegateTool(leaderAgent, {
      action: 'review',
      consolidation: complexReview(),
      startPhases: goodStartPhases({ approachBasis: [chars(19)] }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'START_EVIDENCE_INCOMPLETE')
  }
  const audit = record.statuses[0].gateAudit
  assert.equal(audit.length, 20)
  assert.ok(audit.every((entry: any) => entry.action === 'review' && entry.ok === false))
})

/* ---------- G8 空数组拒因与顺序 ---------- */

test('G8：空数组仍按原拒因拒绝（开工证据空检查先于分工表闸；assignments 空先于人数闸）', () => {
  // startPhases 空数组：validateStartPhaseEvidence「至少需要 1 条非空内容」拒因。
  const noAnalysis = validateStartPhaseEvidence(goodStartPhases({ problemAnalysis: [] }))
  assert.equal(noAnalysis.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(noAnalysis.error!, /problemAnalysis 至少需要 1 条/)
  const noApproach = validateStartPhaseEvidence(goodStartPhases({ approach: [] }))
  assert.equal(noApproach.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(noApproach.error!, /approach 至少需要 1 条/)
  const noBasis = validateStartPhaseEvidence(goodStartPhases({ approachBasis: [] }))
  assert.equal(noBasis.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(noBasis.error!, /approachBasis 至少需要 1 条/)
  // 分工表 assignments 空：旧拒因不变。
  const noAssignments = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: [] }), model: QWEN })
  assert.equal(noAssignments.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(noAssignments.error!, /assignments/)
  // [3.0.8] consolidation 不再有字数梳理字段：不带这些字段不再拒（配置下限 3 时 2 人落到人数闸）。
  const bare = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eightAssignments().slice(0, 2) }), model: QWEN, minHeadcount: 3 })
  assert.equal(bare.code, 'DELEGATE_HEADCOUNT_MIN')
})

/* ---------- G9 durable 读回/回放后判据不放松 ---------- */

test('G9：状态行读回旧存档分工表（assignments 空）⇒ dispatch 仍拒并记入 gateAudit', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  // 模拟 durable 读回：旧形态 consolidation 已在状态行上（绕过 review 写入路径）。
  record.statuses[0].consolidation = goodConsolidation({ taskReasoningEffort: 'medium', assignments: [] })
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(result.error!, /assignments/)
  const audit = record.statuses[0].gateAudit
  assert.deepEqual(
    [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
    ['dispatch', false, 'DELEGATE_CONSOLIDATION_INCOMPLETE'],
  )
})

test('G9b：gateAudit durable 回放——刷新/重启后拒绝/放行记录仍可复核', async () => {
  const { runtime, leaderAgent, rootSession, record } = makeRuntime(QWEN)
  rootSession.append('user/message', buildPlanMessage(record.plan))
  await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: complexReview(),
    startPhases: goodStartPhases({ problemAnalysis: [chars(39)] }),
  })
  // [2.5.5][T3] 原则①：合格 review 补复杂声明＋8 人表，durable 审计回放意图不变。
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: complexReview(), startPhases: goodStartPhases() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  flushPendingWorkplanUpdates(rootSession)
  const rebuilt: any = reconstructFromSession(rootSession)
  assert.ok(rebuilt?.plan, '计划必须可重建')
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.ok(Array.isArray(row.gateAudit), 'gateAudit 必须随 durable 回放恢复')
  assert.deepEqual(
    row.gateAudit.map((entry: any) => [entry.action, entry.ok]),
    [['review', false], ['review', true], ['dispatch', true]],
  )
  assert.equal(row.gateAudit[0].code, 'START_EVIDENCE_INCOMPLETE')
  assert.equal(row.gateAudit[1].code, null)
  // 回放后的合格分工表仍过同一判据。
  const recheck = planDelegations({ consolidation: row.consolidation, model: QWEN })
  assert.equal(recheck.ok, true, JSON.stringify(recheck))
})

test('G9c：旧存档分工表经 durable 回放 ⇒ 同一判据仍拒（回放不豁免）', () => {
  const plan = makePlan()
  const session = makeSession('session-root')
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId,
    subtaskId: 'T1',
    status: 'in_progress',
    revision: 2,
    consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: [] }),
  }))
  const rebuilt: any = reconstructFromSession(session)
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.ok(row.consolidation, '旧存档分工表登记可回放')
  const result = planDelegations({ consolidation: row.consolidation, model: QWEN })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(result.error!, /assignments/)
})

/* ---------- G10 effortOverride 继承不回归 ---------- */

test('G10：梳理未带整体等级 ⇒ 继承 taskEffortFallback；显式配置优先（T4 合规分工表）', () => {
  // 复杂声明档（xhigh）按 T4 须 ≥8 人：8 名专家，均未单独配档。
  const eight = Array.from({ length: 8 }, (_, i) => ({
    member: `M${i + 1}`,
    // [3.0.0] 组员角色取消 + 质量要求必填（断言意图：继承/显式优先，与角色无关）。
    role: 'expert',
    task: `单一目标子任务 ${i + 1}（单一主产物、可独立验收）`,
    qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
  }))
  const inherited = planDelegations({ consolidation: goodConsolidation({ assignments: eight }), model: QWEN, taskEffortFallback: 'xhigh' })
  assert.equal(inherited.ok, true, JSON.stringify(inherited))
  assert.equal(inherited.taskEffort, 'xhigh')
  assert.deepEqual(inherited.members.map((m) => m.effort), Array(8).fill('xhigh'))
  // [2.5.5][T3] 原则①：显式档原用 low，low 禁派后改用 medium 承载同一「显式配置优先于回落源」意图。
  const explicit = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight }), model: QWEN, taskEffortFallback: 'xhigh' })
  assert.equal(explicit.ok, true, JSON.stringify(explicit))
  assert.equal(explicit.taskEffort, 'medium', '显式配置优先于回落源')
})
