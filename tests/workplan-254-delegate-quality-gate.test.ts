/*
 * [3.0.8] 负责人 review 开工闸（startPhases 五步开工证据）＋分工表闸——聚焦回归。
 *
 * 3.0.8 单框架收口后，原「两轮深度思考产物闸」（consolidation 携带
 * problemAnalysis/approach/approachBasis 并卡 40/40/20 字）已废除：
 * consolidation 只剩 { taskReasoningEffort?, taskReasoningEffortDeclared?, assignments }
 * （再传梳理字段为编译错），planDelegations 不再有字数闸。第 1/2/3 步开工证据改经
 * startPhases 提交，由 validateStartPhaseEvidence 判据（与主 Agent/叶子同一口径，
 * 常量真源 src/five-step.ts MIN_*）在 review 入口硬拒：
 *  G1  缺 consolidation ⇒ dispatch 拒 DELEGATE_CONSOLIDATION_MISSING；
 *  G1b review 缺 startPhases ⇒ START_EVIDENCE_MISSING（不登记、留痕）；
 *  G2  startPhases.planning.problemAnalysis 合计 <40 字 ⇒ review 拒
 *      START_EVIDENCE_INCOMPLETE（approach <40 / approachBasis <20 / resources <20 /
 *      tools <10 / prepared <20 / evidence <20 同一判据）；
 *  G3  恰好达标（经 MIN_* 常量构造 40/40/20/20/10/20/20）⇒ review 登记、dispatch 放行；
 *  G4  空白修剪后计数；空数组按缺内容拒；MAIN_START_PHASES_FIXTURE 富证据放行；
 *  G5  行上遗留旧持久化产物 ⇒ dispatch 仍按同一判据拒（assignments 空 ⇒
 *      DELEGATE_CONSOLIDATION_INCOMPLETE；low 声明 ⇒ DELEGATE_LOW_TASK_FORBIDDEN）；
 *  G6  durable 回放（buildUpdateMessage + reconstructFromSession）后 dispatch 判据不放松；
 *  G7  effortOverride 继承不回归（taskEffortFallback / 显式优先 / 家族钳制，
 *      复杂声明档按 D1/D2 须 ≥8 人）；
 *  G8  gateAudit（拒绝/放行审计 ≤20 条 durable 回放）机制保留，薄证据拒因改
 *      START_EVIDENCE_INCOMPLETE 口径。
 * 夹具风格复用 delegate-tool.test.ts（makeRuntime/fake subagents）与
 * workplan-251-deep-think.test.ts（durable 回放）；≥8 人分工表复用
 * tests/helpers/delegate-consolidation.ts；合格开工证据复用
 * tests/helpers/main-deep-think.ts 的 MAIN_START_PHASES_FIXTURE。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { applyStatus, buildPlanMessage, buildUpdateMessage, createStatuses, flushPendingWorkplanUpdates } from '../src/plan.js'
import { planDelegations } from '../src/llm-rules.js'
import {
  MIN_PLANNING_APPROACH_CHARS,
  MIN_PLANNING_BASIS_CHARS,
  MIN_PLANNING_PROBLEM_CHARS,
  MIN_PREPARATION_CHARS,
  MIN_RESOURCE_CHARS,
  MIN_TOOL_CHARS,
  validateStartPhaseEvidence,
} from '../src/five-step.js'
import { GATE_PAD_APPROACH, GATE_PAD_PROBLEM, gateMembers } from './helpers/delegate-consolidation.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

/** 恰好 n 个字符（非空白，trim 不影响）——边界精确构造。 */
const ch = (n: number) => '梳'.repeat(n)

function makePlan() {
  return {
    planId: 'wp-254-quality-gate',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: '分派前深度梳理质量闸',
    taskUnderstanding: { originalRequest: '证明负责人分派门禁合格性判据生效', deliverable: '聚焦测试' },
    contradictions: { primary: { statement: '质量与时间' } },
    stages: [{
      id: 'S1',
      name: '实施',
      // [2.5.5] 夹具适配：本文件测质量闸/等级继承，不测禁派闸；任务行声明 high 即放行第三层派发。
      subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [], reasoningEffort: 'high' }],
    }],
  }
}

function makeSession(id: string) {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000, cwd: '/tmp/quality-gate-cwd' },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
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

function makeRuntime(model = 'qwen3.8-flash') {
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
    session: { id: 'child-leader', header: { parentSession: 'session-root', cwd: '/tmp/quality-gate-cwd' } },
    options: { provider: 'qw', model },
  }
  return { runtime, record, rootSession, subagents, leaderAgent }
}

const assignments2 = () => [
  { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
]

/*
 * [3.0.8] consolidation 瘦身为分工表＋等级配置（梳理产物已改由 startPhases 承载，
 * 再传 problemAnalysis 等字段会编译错）。GATE_PAD_* 现用作 startPhases 补充项。
 */
function slimConsolidation(overrides: any = {}) {
  return { assignments: assignments2(), ...overrides }
}

/** 恰好达标的开工证据：40/40/20/20/10/20/20 全边界，经 MIN_* 常量构造。 */
function exactStartPhases(overrides: any = {}) {
  const base: any = {
    planning: {
      problemAnalysis: [ch(MIN_PLANNING_PROBLEM_CHARS / 2), ch(MIN_PLANNING_PROBLEM_CHARS / 2)],
      approach: [ch(MIN_PLANNING_APPROACH_CHARS / 2), ch(MIN_PLANNING_APPROACH_CHARS / 2)],
      approachBasis: [ch(MIN_PLANNING_BASIS_CHARS)],
      resources: [ch(MIN_RESOURCE_CHARS)],
      tools: [ch(MIN_TOOL_CHARS)],
    },
    preparation: { prepared: [ch(MIN_PREPARATION_CHARS)], evidence: [ch(MIN_PREPARATION_CHARS)] },
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key in base.planning) base.planning[key] = value
    else base.preparation[key] = value
  }
  return base
}

/** 合格富开工证据（共享夹具深拷贝，可按字段覆盖）。 */
function richStartPhases(overrides: any = {}) {
  const base: any = JSON.parse(JSON.stringify(MAIN_START_PHASES_FIXTURE))
  for (const [key, value] of Object.entries(overrides)) {
    if (key in base.planning) base.planning[key] = value
    else base.preparation[key] = value
  }
  return base
}

/*
 * [2.5.5] 夹具适配：以下单元用例验证的是分工表闸与等级继承，不是「low 禁派」
 * 闸；按门禁判定链（src/llm-rules.ts banDeclared）给任务行补 taskRowEffort='high'
 * 即放行第三层派发，且不改变复杂档判定（人数闸仍只由 consolidation.taskReasoningEffort
 * / taskEffortFallback 决定）。断言意图零删改：只补前置数据。
 */
const pd = (args: any) => planDelegations({ taskRowEffort: 'high', ...args })

/* ---------- G0 判据单一事实源 ---------- */

test('G0：开工证据下限与主 Agent/叶子同一事实源（40/40/20＋3.1.0 新增 20/10/20）', () => {
  assert.equal(MIN_PLANNING_PROBLEM_CHARS, 40)
  assert.equal(MIN_PLANNING_APPROACH_CHARS, 40)
  assert.equal(MIN_PLANNING_BASIS_CHARS, 20)
  assert.equal(MIN_RESOURCE_CHARS, 20)
  assert.equal(MIN_TOOL_CHARS, 10)
  assert.equal(MIN_PREPARATION_CHARS, 20)
})

/* ---------- G1 缺产物 ---------- */

test('G1 单元：缺 consolidation ⇒ DELEGATE_CONSOLIDATION_MISSING', () => {
  for (const input of [null, undefined]) {
    const result = pd({ consolidation: input as any, model: 'qwen3.8-flash' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DELEGATE_CONSOLIDATION_MISSING')
    assert.match(result.error!, /分工表/)
  }
})

test('G1b 运行时 review 入口：缺 startPhases 开工证据 ⇒ START_EVIDENCE_MISSING，不登记、留痕', async () => {
  const { runtime, leaderAgent, record } = makeRuntime()
  const result = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: slimConsolidation() })
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

/* ---------- G2 单元：开工证据合计字数下限与恰好达标（判据真源 validateStartPhaseEvidence） ---------- */

test('G2 单元：problemAnalysis 合计 39 字 ⇒ START_EVIDENCE_INCOMPLETE；多项求和同判据；恰好 40 放行', () => {
  const thin = validateStartPhaseEvidence(exactStartPhases({ problemAnalysis: [ch(39)] }))
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(thin.error!, /problemAnalysis/)
  assert.match(thin.error!, /40/)
  // 合计=各项长度之和：19+20=39 仍拒（不是逐项判），拒因报告实际合计。
  const split = validateStartPhaseEvidence(exactStartPhases({ problemAnalysis: [ch(19), ch(20)] }))
  assert.equal(split.ok, false)
  assert.equal(split.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(split.error!, /39/)
  // 20+20=40 恰好达标。
  const exact = validateStartPhaseEvidence(exactStartPhases())
  assert.equal(exact.ok, true, JSON.stringify(exact))
})

test('G3 单元：approach 合计 39 字 ⇒ START_EVIDENCE_INCOMPLETE；恰好 40 放行', () => {
  const thin = validateStartPhaseEvidence(exactStartPhases({ approach: [ch(39)] }))
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(thin.error!, /approach/)
  assert.match(thin.error!, /40/)
  const exact = validateStartPhaseEvidence(exactStartPhases({ approach: [ch(20), ch(20)] }))
  assert.equal(exact.ok, true, JSON.stringify(exact))
})

test('G4 单元：approachBasis 合计 19 字 ⇒ START_EVIDENCE_INCOMPLETE；恰好 20 放行', () => {
  const thin = validateStartPhaseEvidence(exactStartPhases({ approachBasis: [ch(19)] }))
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(thin.error!, /approachBasis/)
  assert.match(thin.error!, /20/)
  const exact = validateStartPhaseEvidence(exactStartPhases({ approachBasis: [ch(20)] }))
  assert.equal(exact.ok, true, JSON.stringify(exact))
})

test('G2b 单元：resources <20 / tools <10 / prepared <20 / evidence <20 ⇒ 同一 INCOMPLETE 判据', () => {
  const resources = validateStartPhaseEvidence(exactStartPhases({ resources: [ch(MIN_RESOURCE_CHARS - 1)] }))
  assert.equal(resources.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(resources.error!, /resources/)
  assert.match(resources.error!, /20/)
  const tools = validateStartPhaseEvidence(exactStartPhases({ tools: [ch(MIN_TOOL_CHARS - 1)] }))
  assert.equal(tools.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(tools.error!, /tools/)
  assert.match(tools.error!, /10/)
  const prepared = validateStartPhaseEvidence(exactStartPhases({ prepared: [ch(MIN_PREPARATION_CHARS - 1)] }))
  assert.equal(prepared.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(prepared.error!, /prepared/)
  const evidence = validateStartPhaseEvidence(exactStartPhases({ evidence: [ch(MIN_PREPARATION_CHARS - 1)] }))
  assert.equal(evidence.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(evidence.error!, /evidence/)
})

/* ---------- G3 单元：分工表闸（consolidation 瘦身后仍有 assignments 闸） ---------- */

test('G3 单元：恰好达标开工证据＋合格分工表 ⇒ ok，分工与缺省等级正常', () => {
  const result = pd({ consolidation: slimConsolidation(), model: 'qwen3.8-flash' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.members.length, 2)
  assert.deepEqual(result.members.map((m: any) => m.effort), ['low', 'low'])
  assert.equal(result.taskEffort, null)
})

test('G4 单元：空白不计字（先 trim 再求和）；空数组按缺内容拒；合格富证据放行', () => {
  const spaces = validateStartPhaseEvidence(exactStartPhases({ problemAnalysis: [' '.repeat(60)] }))
  assert.equal(spaces.ok, false)
  assert.equal(spaces.code, 'START_EVIDENCE_INCOMPLETE')
  const padded = validateStartPhaseEvidence(exactStartPhases({ problemAnalysis: [ch(39) + '   '] }))
  assert.equal(padded.ok, false)
  assert.match(padded.error!, /39/)
  for (const overrides of [{ problemAnalysis: [] }, { approach: [] }, { approachBasis: [] }, { prepared: [] }]) {
    const empty = validateStartPhaseEvidence(exactStartPhases(overrides))
    assert.equal(empty.ok, false, JSON.stringify(overrides))
    assert.equal(empty.code, 'START_EVIDENCE_INCOMPLETE')
    assert.match(empty.error!, /至少需要 1 条/)
  }
  const rich = validateStartPhaseEvidence(richStartPhases())
  assert.equal(rich.ok, true, JSON.stringify(rich))
  // GATE_PAD 补充项单独使用也达标（helper 仍服务于开工证据口径）。
  const pad = validateStartPhaseEvidence(exactStartPhases({ problemAnalysis: [GATE_PAD_PROBLEM], approach: [GATE_PAD_APPROACH] }))
  assert.equal(pad.ok, true, JSON.stringify(pad))
})

/* ---------- G1 运行时：未 review 直接 dispatch ---------- */

test('G1 运行时：未提交分工表直接 dispatch ⇒ MISSING，gateAudit 记录拒绝并随 durable 落盘', async () => {
  const { runtime, leaderAgent, record, rootSession } = makeRuntime()
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_MISSING')
  const row = record.statuses[0]
  assert.ok(Array.isArray(row.gateAudit) && row.gateAudit.length >= 1)
  const last = row.gateAudit[row.gateAudit.length - 1]
  assert.equal(last.action, 'dispatch')
  assert.equal(last.ok, false)
  assert.equal(last.code, 'DELEGATE_CONSOLIDATION_MISSING')
  flushPendingWorkplanUpdates(rootSession)
  assert.match(JSON.stringify(rootSession.events), /gateAudit/, '拒绝留痕必须随 durable workplan-update 落盘')
})

/* ---------- G2 运行时：review 入口开工证据闸 ---------- */

test('G2 运行时 review 入口：七字段任一太薄 ⇒ START_EVIDENCE_INCOMPLETE，不登记、留痕', async () => {
  const cases = [
    { field: 'problemAnalysis', thin: { problemAnalysis: [ch(39)] } },
    { field: 'approach', thin: { approach: [ch(39)] } },
    { field: 'approachBasis', thin: { approachBasis: [ch(19)] } },
    { field: 'resources', thin: { resources: [ch(19)] } },
    { field: 'tools', thin: { tools: [ch(9)] } },
    { field: 'prepared', thin: { prepared: [ch(19)] } },
    { field: 'evidence', thin: { evidence: [ch(19)] } },
  ]
  for (const { field, thin } of cases) {
    const { runtime, leaderAgent, record } = makeRuntime()
    const result = await runtime.delegateTool(leaderAgent, {
      action: 'review',
      consolidation: slimConsolidation(),
      startPhases: exactStartPhases(thin),
    })
    assert.equal(result.ok, false, field)
    assert.equal(result.code, 'START_EVIDENCE_INCOMPLETE', field)
    assert.match(result.error, new RegExp(`startPhases\\.(planning|preparation)\\.${field}`), `${field} 拒因必须点名薄字段`)
    assert.equal(record.statuses[0].consolidation, undefined, `${field} 太薄不得登记`)
    assert.equal(record.statuses[0].startPhases, undefined, `${field} 太薄不得登记`)
    const audit = record.statuses[0].gateAudit
    assert.deepEqual(
      [audit[audit.length - 1].action, audit[audit.length - 1].ok, audit[audit.length - 1].code],
      ['review', false, 'START_EVIDENCE_INCOMPLETE'],
    )
  }
})

/* ---------- G5 运行时：dispatch 入口（行上遗留旧持久化产物） ---------- */

test('G5 运行时 dispatch 入口：行上已落旧持久化产物 ⇒ dispatch 仍按同一判据拒', async () => {
  // 绕过 review 直接写行：模拟开工闸上线前/旧形态已持久化的产物。
  const emptyCases = [
    { name: 'assignments 空', consolidation: slimConsolidation({ assignments: [] }), code: 'DELEGATE_CONSOLIDATION_INCOMPLETE', match: /assignments/ },
    { name: 'low 声明', consolidation: slimConsolidation({ taskReasoningEffort: 'low' }), code: 'DELEGATE_LOW_TASK_FORBIDDEN', match: /direct/ },
  ]
  for (const { name, consolidation, code, match } of emptyCases) {
    const { runtime, leaderAgent, record } = makeRuntime()
    record.statuses = applyStatus(record.statuses, 'T1', { consolidation })
    const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
    assert.equal(result.ok, false, name)
    assert.equal(result.code, code, name)
    assert.match(result.error, match, `${name} 拒因必须可复核`)
    const audit = record.statuses[0].gateAudit
    assert.equal(audit[audit.length - 1].action, 'dispatch')
    assert.equal(audit[audit.length - 1].ok, false)
  }
})

/* ---------- G3 运行时：恰好达标 ⇒ 登记 + 放行 ---------- */

test('G3 运行时：恰好达标开工证据 ⇒ review 登记成功、dispatch 放行派生 2 叶子', async () => {
  const { runtime, leaderAgent, record, subagents } = makeRuntime()
  const review = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: slimConsolidation(),
    startPhases: exactStartPhases(),
  })
  assert.equal(review.ok, true, JSON.stringify(review))
  const row = record.statuses[0]
  assert.ok(row.consolidation, '合格分工表必须登记')
  assert.equal(row.consolidation.assignments.length, 2)
  assert.ok(row.startPhases, '合格开工证据必须登记（行级 startPhases）')
  assert.deepEqual(row.startPhases.planning.problemAnalysis, [ch(20), ch(20)])
  const audit = row.gateAudit
  assert.equal(audit[audit.length - 1].action, 'review')
  assert.equal(audit[audit.length - 1].ok, true)
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  assert.equal(subagents.spawned.length, 2)
  for (const spawned of subagents.spawned) {
    assert.equal(spawned.request.maxDepth, 2, '叶子层边界不因开工闸改变')
  }
  assert.equal(record.statuses[0].delegates.length, 2)
})

/* ---------- G6 durable 读回 ---------- */

function replayRuntime(consolidation: any) {
  const plan: any = makePlan()
  const session = makeSession('session-root')
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId,
    subtaskId: 'T1',
    status: 'in_progress',
    revision: 2,
    consolidation,
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.ok(rebuilt?.plan, '计划必须可重建')
  const { runtime, leaderAgent, subagents } = makeRuntime()
  const record = runtime.state.records.get('session-root')
  record.statuses = rebuilt.statuses
  // 回放不携带 childId（buildUpdateMessage 白名单无此字段）：模拟续跑时重新登记。
  record.statuses[0].childId = 'child-leader'
  return { runtime, leaderAgent, subagents, rebuilt, session }
}

test('G6 durable：旧存档分工表（assignments 空）读回后 dispatch 仍拒（回放不补字、门禁不失效）', () => {
  const { runtime, leaderAgent, rebuilt } = replayRuntime(slimConsolidation({ assignments: [] }))
  // 消毒回放保持原样（不回补、不美化）。
  assert.equal(rebuilt.statuses[0].consolidation.assignments.length, 0)
  return runtime.delegateTool(leaderAgent, { action: 'dispatch' }).then((result: any) => {
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
    assert.match(result.error, /assignments/)
  })
})

test('G6 durable：合格分工表读回后 dispatch 放行（同一回放口径）', async () => {
  const { runtime, leaderAgent, subagents } = replayRuntime(slimConsolidation())
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(subagents.spawned.length, 2)
})

/* ---------- G7 effortOverride 继承不回归 ---------- */

test('G7 单元：taskEffortFallback 继承（复杂档 ≥8 人）、显式优先、家族钳制、无配置回落 low', () => {
  const model = 'qwen3.8-flash'
  const inherited = pd({ consolidation: slimConsolidation({ assignments: gateMembers(8) }), model, taskEffortFallback: 'xhigh' })
  assert.equal(inherited.ok, true, JSON.stringify(inherited))
  assert.equal(inherited.taskEffort, 'xhigh')
  assert.deepEqual(inherited.members.map((m: any) => m.effort), Array(8).fill('xhigh'))
  // [2.5.5] 显式 low ⇒ 禁止第三层下派（用户裁决 D1–D5）：本用例锁定该新契约。
  const explicit = pd({ consolidation: slimConsolidation({ taskReasoningEffort: 'low' }), model, taskEffortFallback: 'xhigh' })
  assert.equal(explicit.ok, false)
  assert.equal(explicit.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  // 回落源同样按家族钳制并留痕（qwen high→medium）。
  const clamped = pd({ consolidation: slimConsolidation({ assignments: gateMembers(8) }), model, taskEffortFallback: 'high' })
  assert.equal(clamped.ok, true, JSON.stringify(clamped))
  assert.equal(clamped.taskEffort, 'medium')
  assert.equal(clamped.taskEffortClamped?.requested, 'high')
  // 无整体配置回落 low 的旧行为不变。
  const none = pd({ consolidation: slimConsolidation(), model })
  assert.deepEqual(none.members.map((m: any) => m.effort), ['low', 'low'])
})

test('G7 端到端：重置清 consolidation 保留 effortOverride ⇒ 重新 review 继承、dispatch 贯穿', async () => {
  const { runtime, leaderAgent, record, subagents } = makeRuntime()
  const review = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: slimConsolidation({ taskReasoningEffort: 'xhigh', assignments: gateMembers(8) }),
    startPhases: richStartPhases(),
  })
  assert.equal(review.ok, true, JSON.stringify(review))
  assert.equal(record.statuses[0].effortOverride, 'xhigh')
  // 尝试重置：consolidation 清除、effortOverride 保留（任务级配置）。
  record.statuses = applyStatus(record.statuses, 'T1', { status: 'pending' })
  assert.equal(record.statuses[0].consolidation, undefined)
  assert.equal(record.statuses[0].effortOverride, 'xhigh')
  record.statuses[0].status = 'in_progress'
  record.statuses[0].childId = 'child-leader'
  // 重新 review 未再配整体等级 ⇒ 继承 effortOverride（复杂档 ⇒ ≥8 人）。
  const reReview = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: slimConsolidation({ assignments: gateMembers(8) }),
    startPhases: richStartPhases(),
  })
  assert.equal(reReview.ok, true, JSON.stringify(reReview))
  assert.equal(reReview.taskEffort, 'xhigh', '开工闸下继承不回归')
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  assert.equal(dispatch.effortOverride, 'xhigh')
  assert.equal(subagents.spawned.length, 8)
  for (const spawned of subagents.spawned) {
    assert.equal(spawned.request.agentOptions.reasoningEffort, 'low', '叶子 phase-0 一律 low 启动（自配档契约不变）')
  }
})

/* ---------- G8 gateAudit durable 回放 ---------- */

test('G8：拒绝→放行审计随 durable 回放可复核（顺序保持、有界 ≤20）', async () => {
  const { runtime, leaderAgent, rootSession, record } = makeRuntime()
  rootSession.append('user/message', buildPlanMessage(record.plan))
  const rejected = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: slimConsolidation(),
    startPhases: exactStartPhases({ approach: [ch(39)] }),
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'START_EVIDENCE_INCOMPLETE')
  const accepted = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: slimConsolidation(),
    startPhases: richStartPhases(),
  })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  const dispatched = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  flushPendingWorkplanUpdates(rootSession)
  const rebuilt: any = reconstructFromSession(rootSession)
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.ok(Array.isArray(row.gateAudit) && row.gateAudit.length >= 3, '回放后审计记录仍在')
  assert.ok(row.gateAudit.length <= 20, '审计有界')
  const reviewReject = row.gateAudit.find((e: any) => e.action === 'review' && e.ok === false)
  assert.equal(reviewReject.code, 'START_EVIDENCE_INCOMPLETE')
  const reviewOk = row.gateAudit.find((e: any) => e.action === 'review' && e.ok === true)
  assert.ok(reviewOk)
  const dispatchOk = row.gateAudit.find((e: any) => e.action === 'dispatch' && e.ok === true)
  assert.ok(dispatchOk)
  assert.ok(row.gateAudit.indexOf(reviewReject) < row.gateAudit.indexOf(reviewOk), '拒绝→放行顺序保持')
})
