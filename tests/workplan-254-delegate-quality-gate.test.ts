/*
 * [2.5.4][T3R1] 分派前深度梳理质量闸——聚焦回归（gate-tests，T3）。
 *
 * 锁负责人分派门禁的合格性判据（与主 Agent validateMainDeepThink / 叶子
 * self_effort 同一口径，单一事实源 = three-phase MIN_PLANNING_*_CHARS）：
 *  G1 缺 consolidation ⇒ dispatch 拒 DELEGATE_CONSOLIDATION_MISSING；
 *  G2 problemAnalysis 合计 <40 字 ⇒ review 与 dispatch 两入口均拒
 *     DELEGATE_CONSOLIDATION_INCOMPLETE；
 *  G3 approach 合计 <40 字 ⇒ 两入口均拒；
 *  G4 approachBasis 合计 <20 字 ⇒ 两入口均拒；
 *  G5 恰好达标（40/40/20）⇒ review 登记成功、dispatch 放行；
 *  G6 合格富产物 ⇒ 放行（合计字数=各项长度之和；空白修剪后不计字）；
 *  G7 durable 读回（reconstructFromSession）后 dispatch 仍拒薄产物；
 *  G8 effortOverride 继承不回归（taskEffortFallback / 显式优先 / 家族钳制，
 *     复杂声明档按 [2.5.4][T4] D1/D2 须 ≥8 人）；
 *  G9 gateAudit 拒绝/放行记录随 durable workplan-update 落盘、回放可复核。
 * 夹具风格复用 delegate-tool.test.ts（makeRuntime/fake subagents）与
 * workplan-251-deep-think.test.ts（durable 回放）；达标补充项与 ≥8 人分工表
 * 复用 tests/helpers/delegate-consolidation.ts。
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
} from '../src/three-phase.js'
import { GATE_PAD_APPROACH, GATE_PAD_PROBLEM, gateMembers } from './helpers/delegate-consolidation.js'

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
  { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
]

/** 恰好达标夹具：problemAnalysis 20+20=40、approach 20+20=40、approachBasis 20。 */
function boundaryConsolidation(overrides: any = {}) {
  return {
    problemAnalysis: [ch(20), ch(20)],
    constraints: [],
    unknowns: [],
    approach: [ch(20), ch(20)],
    approachBasis: [ch(20)],
    assignments: assignments2(),
    ...overrides,
  }
}

/** 合格富产物（真实文案口径）。 */
function richConsolidation(overrides: any = {}) {
  return boundaryConsolidation({
    problemAnalysis: ['现状：部门任务需要拆给专家与组员', GATE_PAD_PROBLEM],
    approach: ['专家做核心实现', GATE_PAD_APPROACH],
    approachBasis: ['第二轮分工基于第一轮全部梳理结果：质量与时间矛盾决定专家做核心实现、组员做证据。'],
    ...overrides,
  })
}

/*
 * [2.5.5] 夹具适配：以下单元用例验证的是深度梳理质量闸与等级继承，不是
 * 「low 禁派」闸；按门禁判定链（src/llm-rules.ts banDeclared）给任务行补
 * taskRowEffort='high' 即放行第三层派发，且不改变复杂档判定（人数闸仍只由
 * consolidation.taskReasoningEffort / taskEffortFallback 决定）。
 * 断言意图零删改：只补前置数据。
 */
const pd = (args: any) => planDelegations({ taskRowEffort: 'high', ...args })

/* ---------- G0 判据单一事实源 ---------- */

test('G0：质量闸下限与主 Agent/叶子同一事实源（40/40/20）', () => {
  assert.equal(MIN_PLANNING_PROBLEM_CHARS, 40)
  assert.equal(MIN_PLANNING_APPROACH_CHARS, 40)
  assert.equal(MIN_PLANNING_BASIS_CHARS, 20)
})

/* ---------- G1 缺产物 ---------- */

test('G1 单元：缺 consolidation ⇒ DELEGATE_CONSOLIDATION_MISSING', () => {
  for (const input of [null, undefined]) {
    const result = pd({ consolidation: input as any, model: 'qwen3.8-flash' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DELEGATE_CONSOLIDATION_MISSING')
    assert.match(result.error!, /梳理/)
  }
})

/* ---------- G2/G3/G4 单元：合计字数下限与恰好达标 ---------- */

test('G2 单元：problemAnalysis 合计 39 字 ⇒ INCOMPLETE；多项求和同判据；恰好 40 放行', () => {
  const thin = pd({ consolidation: boundaryConsolidation({ problemAnalysis: [ch(39)] }), model: 'qwen3.8-flash' })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(thin.error!, /problemAnalysis/)
  assert.match(thin.error!, /40/)
  // 合计=各项长度之和：19+20=39 仍拒（不是逐项判）。
  const split = pd({ consolidation: boundaryConsolidation({ problemAnalysis: [ch(19), ch(20)] }), model: 'qwen3.8-flash' })
  assert.equal(split.ok, false)
  assert.equal(split.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  // 20+20=40 恰好达标。
  const exact = pd({ consolidation: boundaryConsolidation(), model: 'qwen3.8-flash' })
  assert.equal(exact.ok, true, JSON.stringify(exact))
})

test('G3 单元：approach 合计 39 字 ⇒ INCOMPLETE；恰好 40 放行', () => {
  const thin = pd({ consolidation: boundaryConsolidation({ approach: [ch(39)] }), model: 'qwen3.8-flash' })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(thin.error!, /approach/)
  assert.match(thin.error!, /40/)
  const exact = pd({ consolidation: boundaryConsolidation({ approach: [ch(20), ch(20)] }), model: 'qwen3.8-flash' })
  assert.equal(exact.ok, true, JSON.stringify(exact))
})

test('G4 单元：approachBasis 合计 19 字 ⇒ INCOMPLETE；恰好 20 放行', () => {
  const thin = pd({ consolidation: boundaryConsolidation({ approachBasis: [ch(19)] }), model: 'qwen3.8-flash' })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.match(thin.error!, /approachBasis/)
  assert.match(thin.error!, /20/)
  const exact = pd({ consolidation: boundaryConsolidation({ approachBasis: [ch(20)] }), model: 'qwen3.8-flash' })
  assert.equal(exact.ok, true, JSON.stringify(exact))
})

test('G5 单元：恰好达标（40/40/20）⇒ ok，分工与缺省等级正常', () => {
  const result = pd({ consolidation: boundaryConsolidation(), model: 'qwen3.8-flash' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.members.length, 2)
  assert.deepEqual(result.members.map((m: any) => m.effort), ['low', 'low'])
  assert.equal(result.taskEffort, null)
})

test('G6 单元：空白不计字（先 trim 再求和）；空数组按缺交拒；合格富产物放行', () => {
  const spaces = pd({ consolidation: boundaryConsolidation({ problemAnalysis: [' '.repeat(60)] }), model: 'qwen3.8-flash' })
  assert.equal(spaces.ok, false)
  assert.equal(spaces.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  const padded = pd({ consolidation: boundaryConsolidation({ problemAnalysis: [ch(39) + '   '] }), model: 'qwen3.8-flash' })
  assert.equal(padded.ok, false)
  assert.match(padded.error!, /39/)
  for (const overrides of [{ problemAnalysis: [] }, { approach: [] }, { approachBasis: [] }]) {
    const empty = pd({ consolidation: boundaryConsolidation(overrides), model: 'qwen3.8-flash' })
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  }
  const rich = pd({ consolidation: richConsolidation(), model: 'qwen3.8-flash' })
  assert.equal(rich.ok, true, JSON.stringify(rich))
})

/* ---------- G1 运行时：未 review 直接 dispatch ---------- */

test('G1 运行时：未提交梳理直接 dispatch ⇒ MISSING，gateAudit 记录拒绝并随 durable 落盘', async () => {
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

/* ---------- G2/G3/G4 运行时：review 入口 ---------- */

test('G2-G4 运行时 review 入口：三字段任一太薄 ⇒ INCOMPLETE，不登记、留痕', async () => {
  const cases = [
    { field: 'problemAnalysis', thin: { problemAnalysis: [ch(39)] } },
    { field: 'approach', thin: { approach: [ch(39)] } },
    { field: 'approachBasis', thin: { approachBasis: [ch(19)] } },
  ]
  for (const { field, thin } of cases) {
    const { runtime, leaderAgent, record } = makeRuntime()
    const result = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: boundaryConsolidation(thin) })
    assert.equal(result.ok, false, field)
    assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE', field)
    assert.match(result.error, new RegExp(field), `${field} 拒因必须点名薄字段`)
    assert.equal(record.statuses[0].consolidation, undefined, `${field} 太薄不得登记`)
    const audit = record.statuses[0].gateAudit
    assert.equal(audit[audit.length - 1].action, 'review')
    assert.equal(audit[audit.length - 1].ok, false)
    assert.equal(audit[audit.length - 1].code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  }
})

/* ---------- G2/G3/G4 运行时：dispatch 入口（行上遗留薄产物） ---------- */

test('G2-G4 运行时 dispatch 入口：行上已落薄产物（旧持久化）⇒ dispatch 仍拒 INCOMPLETE', async () => {
  const cases = [
    { field: 'problemAnalysis', thin: { problemAnalysis: [ch(39)] } },
    { field: 'approach', thin: { approach: [ch(39)] } },
    { field: 'approachBasis', thin: { approachBasis: [ch(19)] } },
  ]
  for (const { field, thin } of cases) {
    const { runtime, leaderAgent, record } = makeRuntime()
    // 绕过 review 直接写行：模拟质量闸上线前已持久化的薄梳理产物。
    record.statuses = applyStatus(record.statuses, 'T1', { consolidation: boundaryConsolidation(thin) })
    const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
    assert.equal(result.ok, false, field)
    assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE', field)
    assert.match(result.error, new RegExp(field), `${field} 拒因必须点名薄字段`)
    const audit = record.statuses[0].gateAudit
    assert.equal(audit[audit.length - 1].action, 'dispatch')
    assert.equal(audit[audit.length - 1].ok, false)
  }
})

/* ---------- G5 运行时：恰好达标 ⇒ 登记 + 放行 ---------- */

test('G5 运行时：恰好达标（40/40/20）⇒ review 登记成功、dispatch 放行派生 2 叶子', async () => {
  const { runtime, leaderAgent, record, subagents } = makeRuntime()
  const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: boundaryConsolidation() })
  assert.equal(review.ok, true, JSON.stringify(review))
  const row = record.statuses[0]
  assert.ok(row.consolidation, '恰好达标的梳理产物必须登记')
  assert.deepEqual(row.consolidation.problemAnalysis, [ch(20), ch(20)])
  const audit = row.gateAudit
  assert.equal(audit[audit.length - 1].action, 'review')
  assert.equal(audit[audit.length - 1].ok, true)
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  assert.equal(subagents.spawned.length, 2)
  for (const spawned of subagents.spawned) {
    assert.equal(spawned.request.maxDepth, 2, '叶子层边界不因质量闸改变')
  }
  assert.equal(record.statuses[0].delegates.length, 2)
})

/* ---------- G7 durable 读回 ---------- */

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

test('G7 durable：薄产物读回后 dispatch 仍拒 INCOMPLETE（回放不补字、门禁不失效）', () => {
  const thin = boundaryConsolidation({ problemAnalysis: [ch(39)] })
  const { runtime, leaderAgent, rebuilt } = replayRuntime(thin)
  // 消毒回放保持薄产物原样（不回补、不美化）。
  assert.deepEqual(rebuilt.statuses[0].consolidation.problemAnalysis, [ch(39)])
  return runtime.delegateTool(leaderAgent, { action: 'dispatch' }).then((result: any) => {
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
    assert.match(result.error, /problemAnalysis/)
  })
})

test('G7 durable：合格产物读回后 dispatch 放行（同一回放口径）', async () => {
  const { runtime, leaderAgent, subagents } = replayRuntime(richConsolidation())
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(subagents.spawned.length, 2)
})

/* ---------- G8 effortOverride 继承不回归 ---------- */

test('G8 单元：taskEffortFallback 继承（复杂档 ≥8 人）、显式优先、家族钳制、无配置回落 low', () => {
  const model = 'qwen3.8-flash'
  const inherited = pd({ consolidation: richConsolidation({ assignments: gateMembers(8) }), model, taskEffortFallback: 'xhigh' })
  assert.equal(inherited.ok, true, JSON.stringify(inherited))
  assert.equal(inherited.taskEffort, 'xhigh')
  assert.deepEqual(inherited.members.map((m: any) => m.effort), Array(8).fill('xhigh'))
  // [2.5.5] 显式 low ⇒ 禁止第三层下派（用户裁决 D1–D5）：本用例锁定该新契约。
  const explicit = pd({ consolidation: richConsolidation({ taskReasoningEffort: 'low' }), model, taskEffortFallback: 'xhigh' })
  assert.equal(explicit.ok, false)
  assert.equal(explicit.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  // 回落源同样按家族钳制并留痕（qwen high→medium）。
  const clamped = pd({ consolidation: richConsolidation({ assignments: gateMembers(8) }), model, taskEffortFallback: 'high' })
  assert.equal(clamped.ok, true, JSON.stringify(clamped))
  assert.equal(clamped.taskEffort, 'medium')
  assert.equal(clamped.taskEffortClamped?.requested, 'high')
  // 无整体配置回落 low 的旧行为不变。
  const none = pd({ consolidation: richConsolidation(), model })
  assert.deepEqual(none.members.map((m: any) => m.effort), ['low', 'low'])
})

test('G8 端到端：重置清 consolidation 保留 effortOverride ⇒ 重新 review 继承、dispatch 贯穿', async () => {
  const { runtime, leaderAgent, record, subagents } = makeRuntime()
  const review = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: richConsolidation({ taskReasoningEffort: 'xhigh', assignments: gateMembers(8) }),
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
  const reReview = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: richConsolidation({ assignments: gateMembers(8) }) })
  assert.equal(reReview.ok, true, JSON.stringify(reReview))
  assert.equal(reReview.taskEffort, 'xhigh', '质量闸下继承不回归')
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  assert.equal(dispatch.effortOverride, 'xhigh')
  assert.equal(subagents.spawned.length, 8)
  for (const spawned of subagents.spawned) {
    assert.equal(spawned.request.agentOptions.reasoningEffort, 'low', '叶子 phase-0 一律 low 启动（自配档契约不变）')
  }
})

/* ---------- G9 gateAudit durable 回放 ---------- */

test('G9：拒绝→放行审计随 durable 回放可复核（顺序保持、有界 ≤20）', async () => {
  const { runtime, leaderAgent, rootSession, record } = makeRuntime()
  rootSession.append('user/message', buildPlanMessage(record.plan))
  const rejected = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: boundaryConsolidation({ approach: [ch(39)] }) })
  assert.equal(rejected.ok, false)
  const accepted = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: richConsolidation() })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  const dispatched = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  flushPendingWorkplanUpdates(rootSession)
  const rebuilt: any = reconstructFromSession(rootSession)
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.ok(Array.isArray(row.gateAudit) && row.gateAudit.length >= 3, '回放后审计记录仍在')
  assert.ok(row.gateAudit.length <= 20, '审计有界')
  const reviewReject = row.gateAudit.find((e: any) => e.action === 'review' && e.ok === false)
  assert.equal(reviewReject.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  const reviewOk = row.gateAudit.find((e: any) => e.action === 'review' && e.ok === true)
  assert.ok(reviewOk)
  const dispatchOk = row.gateAudit.find((e: any) => e.action === 'dispatch' && e.ok === true)
  assert.ok(dispatchOk)
  assert.ok(row.gateAudit.indexOf(reviewReject) < row.gateAudit.indexOf(reviewOk), '拒绝→放行顺序保持')
})
