/*
 * [2.5.5][T3] low 任务禁止下派 ＋ direct 负责人亲自执行登记 · 聚焦测试矩阵。
 * [3.0.8] 五步工作法单框架收口适配：direct/review 的开工证据改经 startPhases
 * 提交（validateStartPhaseEvidence 同一判据，与主 Agent/叶子同口径），
 * DELEGATE_DIRECT_THINK_* 拒因码改名为 DELEGATE_DIRECT_START_*；
 * consolidation 瘦身为 { taskReasoningEffort?, taskReasoningEffortDeclared?, assignments }。
 *
 * 唯一规格：plugins/dsh-workplan/reports/wp-T3-impl-spec-20261114.md（§3/§4/§5/§9）。
 * 真源：llm-rules.ts planDelegations（禁派闸 DELEGATE_LOW_TASK_FORBIDDEN，判定链
 *   taskReasoningEffortDeclared ?? declaredEffort ?? taskRowEffort ?? 视同 low，
 *   钳制前判定、独立于 complexTask）；runtime.ts delegateTool（review/dispatch 两
 *   入口同判据＋direct 分支＋防注入剥离＋status low 直执 hint）；five-step.ts
 *   validateStartPhaseEvidence（40/40/20＋20/10/20/20 同一判据）。
 * 夹具仿照 tests/workplan-254-t3-deep-gate.test.ts 与 workplan-250-head-delegation.test.ts
 *   （createWorkplanRuntime + makePlan/makeSession + fake subagents + durable 回放）。
 * 矩阵分组（用例↔矩阵映射见 reports/wp-T3-tests-note.md）：
 *   A 四态（显式 low／皆缺视同 low／行级兜底 low／medium+ 放行）
 *   B 非法值仍 DELEGATE_TASK_EFFORT_INVALID＋拒因顺序不变
 *   C review/dispatch 双入口同判据＋钳制前声明记忆防误杀＋防注入剥离
 *   D direct：low 登记＋effortOverride 落位／复杂档拒／带分工表拒／startPhases 开工
 *     证据门禁／防旁路
 *   E 钳制前判定（非 qwen medium 仍按复杂判）
 *   F 非 low 既有行为回归（≥8 闸／角色配比／钳制留痕／S4 独立链）
 *   G direct 全链 e2e（规格 §9 direct 专项：phase-0 结算闸接续，attempt 不耗）
 *   X durable 缺口备案（3.0.8 行级 startPhases 回放口径实测）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildLlmRulesBrief, planDelegations, resolveTaskEffort } from '../src/llm-rules.js'
import { createWorkplanRuntime, reconstructFromSession, dispatchPlan } from '../src/runtime.js'
import { buildPlanMessage, createStatuses, flushPendingWorkplanUpdates } from '../src/plan.js'
import {
  MIN_PLANNING_APPROACH_CHARS,
  MIN_PLANNING_BASIS_CHARS,
  MIN_PLANNING_PROBLEM_CHARS,
  START_EVIDENCE_MIN_CHARS_BRIEF,
} from '../src/five-step.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

const QWEN = 'qwen3.8-flash'
const OTHER = 'gpt-5'
const LOW_FORBIDDEN = 'DELEGATE_LOW_TASK_FORBIDDEN'

/** 确定性字数夹具：n 个汉字，length 恰为 n。 */
const chars = (n: number) => '字'.repeat(n)

/** 合格五步开工证据（共享夹具深拷贝；flat 覆盖：planning 键入 planning，其余入 preparation）。 */
function goodPhases(overrides: any = {}) {
  const base: any = JSON.parse(JSON.stringify(MAIN_START_PHASES_FIXTURE))
  for (const [key, value] of Object.entries(overrides)) {
    if (key in base.planning) base.planning[key] = value
    else base.preparation[key] = value
  }
  return base
}

/** 合格分工表（3.0.8 瘦身后：只带 assignments，可覆盖 taskReasoningEffort 等）。 */
function goodConsolidation(overrides: any = {}) {
  return {
    assignments: [
      { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
      { member: 'Member-B', role: 'expert', task: '补充核心路径回归用例', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    ],
    ...overrides,
  }
}

/** 复杂任务合规分工表：8 名专家（D1/D2 ≥8 闸；组员角色已取消）。 */
function eight(extra: any[] = []) {
  const fillers = Array.from({ length: 6 }, (_, i) => ({
    member: `组员${'丙丁戊己庚辛'[i]}`, role: 'expert', task: `单一目标子任务 ${i + 3}（单一主产物、可独立验收）`, qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
  }))
  return [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', ...extra[0], qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    { member: 'Member-B', role: 'expert', task: '补充核心路径回归用例', ...extra[1], qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    ...fillers,
  ]
}

function makePlan(rowEffort?: string, chain = false) {
  return {
    planId: 'wp-t3-low-gate',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: 'low 禁派闸用例',
    contradictions: { primary: { statement: '质量与时间' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [],
        ...(rowEffort !== undefined ? { reasoningEffort: rowEffort } : {}),
        ...(chain ? {
          objective: '先完成第一步梳理，再基于上一步结论逐步实现',
          method: '顺序执行全部步骤，最后一步汇总产物并交付',
        } : {}),
      }],
    }],
  }
}

function makeSession(id: string) {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000, cwd: '/tmp/t3-low-gate-cwd' },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeRuntime(model: string, opts: { rowEffort?: string; provider?: string; chain?: boolean } = {}) {
  const plan = makePlan(opts.rowEffort, opts.chain)
  const rootSession = makeSession('session-root')
  const spawned: any[] = []
  const interrupts: any[] = []
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (request: any) => {
        const childId = `member-${spawned.length + 1}`
        let resolveResult: any
        const result = new Promise((resolve) => { resolveResult = resolve })
        spawned.push({ childId, request, resolveResult })
        return { childId, result, dispose: async () => {} }
      },
      interruptByParent: (...args: any[]) => { interrupts.push(args) },
    },
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
    session: { id: 'child-leader', header: { parentSession: 'session-root', cwd: '/tmp/t3-low-gate-cwd' } },
    options: { provider: opts.provider ?? 'qw', model },
  }
  return { runtime, record, rootSession, spawned, interrupts, leaderAgent }
}

const lastAudit = (record: any) => {
  const audit = record.statuses[0].gateAudit
  const entry = audit[audit.length - 1]
  return [entry.action, entry.ok, entry.code]
}

/* ---------- A 四态 ---------- */

test('A1 单元：显式 low 声明 ⇒ DELEGATE_LOW_TASK_FORBIDDEN＋文案四要素（亲自执行/direct、七项字数下限、无例外、不回溯）', () => {
  const r = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'low' }), model: QWEN })
  assert.equal(r.ok, false)
  assert.equal(r.code, LOW_FORBIDDEN)
  assert.match(r.error!, /亲自执行/)
  assert.match(r.error!, /action="direct"/)
  // [修复] 判据从「40/40/20」简写升级为与校验器同源的完整七项下限简报。
  assert.ok(r.error!.includes(START_EVIDENCE_MIN_CHARS_BRIEF))
  assert.match(r.error!, /无任何例外通道/)
  assert.match(r.error!, /不回溯/)
  assert.deepEqual(r.members, [])
})

test('A2 单元：声明/effortOverride/行级皆缺 ⇒ 视同 low 禁派（D3 末端兜底）', () => {
  const r = planDelegations({ consolidation: goodConsolidation(), model: QWEN })
  assert.equal(r.ok, false)
  assert.equal(r.code, LOW_FORBIDDEN)
})

test('A3 单元：任务行兜底 low 与 effortOverride 回落 low 均禁派（D1 判定链）', () => {
  const row = planDelegations({ consolidation: goodConsolidation(), model: QWEN, taskRowEffort: 'low' })
  assert.equal(row.code, LOW_FORBIDDEN)
  const override = planDelegations({ consolidation: goodConsolidation(), model: QWEN, taskEffortFallback: 'low' })
  assert.equal(override.code, LOW_FORBIDDEN)
  // 声明优先于行级：显式 medium 声明＋行级 low ⇒ 放行（声明档为判定权威）。
  const declared = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), model: QWEN, taskRowEffort: 'low' })
  assert.equal(declared.ok, true, JSON.stringify(declared))
})

test('A4 单元：medium/high/xhigh/max 声明放行（qwen，≥8 人）＋钳制前声明随 ok 返回', () => {
  for (const effort of ['medium', 'high', 'xhigh', 'max']) {
    const r = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: effort, assignments: eight() }), model: QWEN })
    assert.equal(r.ok, true, `${effort}: ${JSON.stringify(r)}`)
    assert.equal(r.taskEffortDeclared, effort, '钳制前原始声明必须随 ok 返回（供平台持久化）')
    assert.equal(r.members.length, 8)
  }
})

test('A5 runtime：review 四态——显式 low／皆缺／行级兜底 low 均拒＋gateAudit 留痕；medium 放行', async () => {
  const explicit = makeRuntime(QWEN)
  const r1 = await explicit.runtime.delegateTool(explicit.leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'low' }), startPhases: goodPhases() })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, LOW_FORBIDDEN)
  assert.deepEqual(lastAudit(explicit.record), ['review', false, LOW_FORBIDDEN])
  const missing = makeRuntime(QWEN) // 计划行无 reasoningEffort、行上无 effortOverride、梳理无声明
  const r2 = await missing.runtime.delegateTool(missing.leaderAgent, { action: 'review', consolidation: goodConsolidation(), startPhases: goodPhases() })
  assert.equal(r2.code, LOW_FORBIDDEN)
  const rowLow = makeRuntime(QWEN, { rowEffort: 'low' })
  const r3 = await rowLow.runtime.delegateTool(rowLow.leaderAgent, { action: 'review', consolidation: goodConsolidation(), startPhases: goodPhases() })
  assert.equal(r3.code, LOW_FORBIDDEN)
  const ok = makeRuntime(QWEN)
  const r4 = await ok.runtime.delegateTool(ok.leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), startPhases: goodPhases() })
  assert.equal(r4.ok, true, JSON.stringify(r4))
  assert.equal(ok.record.statuses[0].effortOverride, 'medium')
})

test('A6 runtime：medium review→dispatch 全链放行，派生 8 个叶子（两入口同判据）', async () => {
  const { runtime, leaderAgent, spawned, record } = makeRuntime(QWEN)
  const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), startPhases: goodPhases() })
  assert.equal(review.ok, true)
  assert.equal(record.statuses[0].consolidation.taskReasoningEffortDeclared, 'medium', '钳制前声明记忆必须持久化')
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  assert.equal(spawned.length, 8)
})

test('A7 runtime：dispatch 读回 low 声明（durable 读回形态）⇒ 同一新闸硬拒＋gateAudit', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  record.statuses[0].consolidation = goodConsolidation({ taskReasoningEffort: 'low' })
  const r = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(r.ok, false)
  assert.equal(r.code, LOW_FORBIDDEN)
  assert.deepEqual(lastAudit(record), ['dispatch', false, LOW_FORBIDDEN])
})

/* ---------- B 非法值与拒因顺序 ---------- */

test('B1 单元：非法声明/非法 effortOverride 仍走 DELEGATE_TASK_EFFORT_INVALID 旧轨（消费条件穿透）', () => {
  const declared = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'turbo' }), model: QWEN })
  assert.equal(declared.code, 'DELEGATE_TASK_EFFORT_INVALID')
  assert.match(declared.error!, /turbo/)
  const fallback = planDelegations({ consolidation: goodConsolidation(), model: QWEN, taskEffortFallback: 'turbo' })
  assert.equal(fallback.code, 'DELEGATE_TASK_EFFORT_INVALID')
})

test('B2 行级非法值：单元层不触发新闸（穿透）；runtime 层五档消毒归一 undefined ⇒ 视同 low 拒', async () => {
  const unit = planDelegations({ consolidation: goodConsolidation(), model: QWEN, taskRowEffort: 'turbo' })
  assert.equal(unit.ok, true, '非法行级值 banConsumable=false ⇒ 跳过新闸，旧行为不变')
  const { runtime, leaderAgent } = makeRuntime(QWEN, { rowEffort: 'turbo' })
  const r = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation(), startPhases: goodPhases() })
  assert.equal(r.code, LOW_FORBIDDEN, 'runtime 调用方把非法行级值消毒为 undefined ⇒ 皆缺视同 low')
})

test('B3 拒因顺序：缺 consolidation 最先／review 开工证据闸先于分工表各闸／low 空分工表新闸先／medium 空分工表旧 INCOMPLETE', async () => {
  const missing = planDelegations({ model: QWEN, taskRowEffort: 'low' })
  assert.equal(missing.code, 'DELEGATE_CONSOLIDATION_MISSING')
  // [3.0.8] 旧「consolidation 薄梳理闸」已废除（梳理产物改由 startPhases 承载），
  // consolidation 里的字数字段被忽略，薄开工证据由 review 的 startPhases 闸判。
  const lowEmpty = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'low', assignments: [] }), model: QWEN })
  assert.equal(lowEmpty.code, LOW_FORBIDDEN, '规格 §3.3：low 空分工表也先得到禁派＋direct 指路')
  const mediumEmpty = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: [] }), model: QWEN })
  assert.equal(mediumEmpty.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE', '非 low 空分工表仍是旧拒因')
  // review 入口拒因顺序：startPhases 开工证据闸先于 planDelegations 各闸（含禁派闸）。
  const { runtime, leaderAgent } = makeRuntime(QWEN)
  const noPhases = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'low' }) })
  assert.equal(noPhases.code, 'START_EVIDENCE_MISSING', 'review：缺开工证据先于禁派闸')
  const thinPhases = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: goodConsolidation({ taskReasoningEffort: 'low' }),
    startPhases: goodPhases({ problemAnalysis: [chars(MIN_PLANNING_PROBLEM_CHARS - 1)] }),
  })
  assert.equal(thinPhases.code, 'START_EVIDENCE_INCOMPLETE', 'review：薄开工证据先于禁派闸')
})

/* ---------- C 双入口同判据＋声明记忆＋防注入 ---------- */

test('C1 runtime：非 qwen medium review 钳制留痕＋declared 记忆 → dispatch 按钳制前声明档判复杂：8 人全部派发（截 6 缺陷已修，3.1.0）', async () => {
  const { runtime, leaderAgent, record, spawned } = makeRuntime(OTHER, { provider: 'openai' })
  const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), startPhases: goodPhases() })
  assert.equal(review.ok, true, JSON.stringify(review))
  assert.equal(review.taskEffort, 'low', '非 qwen medium→low 钳制')
  assert.equal(review.taskEffortClamped?.requested, 'medium')
  assert.equal(review.taskEffortClamped?.corrected, 'low')
  const row = record.statuses[0]
  assert.equal(row.effortOverride, 'low')
  assert.equal(row.consolidation.taskReasoningEffort, 'low', '持久化为钳制后值')
  assert.equal(row.consolidation.taskReasoningEffortDeclared, 'medium', '钳制前声明记忆必须留档')
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, `declared 记忆防误杀：${JSON.stringify(dispatch)}`)
  // [3.1.0] 治本：dispatch 的 complexTask 判据改用钳制前声明记忆（与禁派闸同源），
  // review 放行的 8 人名单不再被复读时的钳制后 low 回落成 cap=6 静默截断。
  assert.equal(spawned.length, 8, 'dispatch 按钳制前声明档判复杂：8 人全部派发（旧「截 6」行为已修）')
  assert.equal(dispatch.delegates.length, 8)
  assert.ok(dispatch.delegates.every((d: any) => d.status === 'running'), '8 名成员全部 running')
})

test('C2 防注入：review 输入携带 taskReasoningEffortDeclared 被剥离 ⇒ low 仍禁派；单元层平台写入形态原样消费', async () => {
  const { runtime, leaderAgent } = makeRuntime(QWEN)
  const injected = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: goodConsolidation({ taskReasoningEffort: 'low', taskReasoningEffortDeclared: 'max' }),
    startPhases: goodPhases(),
  })
  assert.equal(injected.code, LOW_FORBIDDEN, 'runtime 剥离注入字段，禁派闸不可被绕过（§5.8.4）')
  const platform = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'low', taskReasoningEffortDeclared: 'max', assignments: eight() }), model: QWEN })
  assert.equal(platform.ok, true, '平台持久化形态（declared=钳制前声明）按规格原样消费')
})

/* ---------- D direct 动作 ---------- */

test('D1 direct：合格 startPhases＋缺省/显式 low ⇒ 登记成功，effortOverride=low 落位＋空分工表＋审计＋hint', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN)
  const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases() })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.action, 'direct')
  assert.equal(r.effortOverride, 'low')
  assert.match(r.hint!, /low 直执已登记/)
  const row = record.statuses[0]
  assert.equal(row.effortOverride, 'low', 'effortOverride 落位 ⇒ phase-0 结算闸凭此接续')
  assert.deepEqual(row.consolidation.assignments, [], '空分工表＝直执标记')
  assert.equal(row.consolidation.taskReasoningEffort, 'low')
  assert.deepEqual(row.startPhases.planning.problemAnalysis, MAIN_START_PHASES_FIXTURE.planning.problemAnalysis, '开工证据落档行级 startPhases')
  assert.deepEqual(lastAudit(record), ['direct', true, null])
  const explicit = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(), reasoningEffort: 'low' })
  assert.equal(explicit.ok, true, '显式 low 同样接受')
})

test('D2 direct 防旁路：复杂档 medium/high/xhigh/max 与非法值一律 DELEGATE_DIRECT_EFFORT_INVALID，不落盘', async () => {
  for (const effort of ['medium', 'high', 'xhigh', 'max', 'turbo']) {
    const { runtime, leaderAgent, record } = makeRuntime(QWEN)
    const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(), reasoningEffort: effort })
    assert.equal(r.ok, false, effort)
    assert.equal(r.code, 'DELEGATE_DIRECT_EFFORT_INVALID', effort)
    assert.match(r.error!, /review\+dispatch/, '文案指路复杂流程')
    assert.equal(record.statuses[0].effortOverride ?? null, null, '拒绝不得写入 effortOverride')
    assert.equal(record.statuses[0].consolidation ?? null, null, '拒绝不得写入分工表')
    assert.deepEqual(lastAudit(record), ['direct', false, 'DELEGATE_DIRECT_EFFORT_INVALID'])
  }
})

/* ---------- D2b 顺序推理链直执档（3.2.3：链式 direct 不得 low，必须自评复杂档） ---------- */

test('D2b-1 链式 direct 缺 reasoningEffort ⇒ DELEGATE_DIRECT_CHAIN_EFFORT_REQUIRED，不落盘', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN, { chain: true })
  const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases() })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DELEGATE_DIRECT_CHAIN_EFFORT_REQUIRED')
  assert.match(r.error!, /自己评估/)
  assert.match(r.error!, /medium\/xhigh/)
  assert.match(r.error!, /high\/max/)
  assert.equal(record.statuses[0].effortOverride ?? null, null, '拒绝不得写入 effortOverride')
  assert.equal(record.statuses[0].consolidation ?? null, null, '拒绝不得写入分工表')
  assert.deepEqual(lastAudit(record), ['direct', false, 'DELEGATE_DIRECT_CHAIN_EFFORT_REQUIRED'])
})

test('D2b-2 链式 direct 显式 low ⇒ DELEGATE_DIRECT_CHAIN_EFFORT_INVALID（低档推不动推理链）', async () => {
  const { runtime, leaderAgent, record } = makeRuntime(QWEN, { chain: true })
  const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(), reasoningEffort: 'low' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DELEGATE_DIRECT_CHAIN_EFFORT_INVALID')
  assert.match(r.error!, /禁止 low 档亲自执行/)
  assert.equal(record.statuses[0].effortOverride ?? null, null)
  assert.deepEqual(lastAudit(record), ['direct', false, 'DELEGATE_DIRECT_CHAIN_EFFORT_INVALID'])
})

test('D2b-3 链式 direct 自评复杂档放行：非 qwen high/max、qwen medium/xhigh；effortOverride 随档落位', async () => {
  for (const [model, effort] of [[OTHER, 'high'], [OTHER, 'max'], [QWEN, 'medium'], [QWEN, 'xhigh']] as const) {
    const { runtime, leaderAgent, record } = makeRuntime(model, { chain: true })
    const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(), reasoningEffort: effort })
    assert.equal(r.ok, true, `${model} ${effort}: ${JSON.stringify(r)}`)
    assert.equal(r.action, 'direct')
    assert.equal(r.effortOverride, effort)
    assert.match(r.hint!, new RegExp(`${effort} 档`), 'hint 声明实际接续档')
    assert.equal(record.statuses[0].effortOverride, effort, '自评复杂档 durable 落位 ⇒ phase-1 按该档接续')
    assert.equal(record.statuses[0].consolidation.taskReasoningEffort, effort)
    assert.deepEqual(record.statuses[0].consolidation.assignments, [], '仍是空分工表＝直执标记，不下派')
    assert.deepEqual(lastAudit(record), ['direct', true, null])
  }
})

test('D2b-4 链式 direct 档位越界：qwen 的 max／非 qwen 的 medium／非法值 ⇒ DELEGATE_DIRECT_CHAIN_EFFORT_INVALID', async () => {
  for (const [model, effort] of [[QWEN, 'max'], [OTHER, 'medium'], [OTHER, 'xhigh'], [QWEN, 'turbo']] as const) {
    const { runtime, leaderAgent, record } = makeRuntime(model, { chain: true })
    const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(), reasoningEffort: effort })
    assert.equal(r.ok, false, `${model} ${effort}`)
    assert.equal(r.code, 'DELEGATE_DIRECT_CHAIN_EFFORT_INVALID', `${model} ${effort}`)
    assert.match(r.error!, /本模型家族的复杂档/, '文案给出本家族合法复杂档')
    assert.equal(record.statuses[0].effortOverride ?? null, null)
    assert.deepEqual(lastAudit(record), ['direct', false, 'DELEGATE_DIRECT_CHAIN_EFFORT_INVALID'])
  }
})

test('D2b-5 非链式任务不受影响：复杂档直执仍 DELEGATE_DIRECT_EFFORT_INVALID（D2 语义一字不变）', async () => {
  const { runtime, leaderAgent } = makeRuntime(QWEN)
  const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(), reasoningEffort: 'max' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DELEGATE_DIRECT_EFFORT_INVALID')
  assert.match(r.error!, /顺序推理链任务可经 direct 自评复杂档/, '文案指明链式例外')
})

/* ---------- D3 direct 防旁路：携带 consolidation（含空对象/分工表）⇒ DELEGATE_DIRECT_ASSIGNMENTS_FORBIDDEN ---------- */

test('D3 direct 防旁路：携带 consolidation（含空对象/分工表）⇒ DELEGATE_DIRECT_ASSIGNMENTS_FORBIDDEN', async () => {
  for (const consolidation of [{}, goodConsolidation()]) {
    const { runtime, leaderAgent, record } = makeRuntime(QWEN)
    const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(), consolidation })
    assert.equal(r.code, 'DELEGATE_DIRECT_ASSIGNMENTS_FORBIDDEN')
    assert.deepEqual(lastAudit(record), ['direct', false, 'DELEGATE_DIRECT_ASSIGNMENTS_FORBIDDEN'])
  }
})

test('D4 direct 开工证据门禁：缺证据 START_MISSING／薄证据 START_INCOMPLETE（40/40/20 同一判据）／恰好边界放行', async () => {
  assert.deepEqual([MIN_PLANNING_PROBLEM_CHARS, MIN_PLANNING_APPROACH_CHARS, MIN_PLANNING_BASIS_CHARS], [40, 40, 20])
  const { runtime, leaderAgent } = makeRuntime(QWEN)
  const missing = await runtime.delegateTool(leaderAgent, { action: 'direct' })
  assert.equal(missing.code, 'DELEGATE_DIRECT_START_MISSING')
  const thinCases = [
    { problemAnalysis: [chars(MIN_PLANNING_PROBLEM_CHARS - 1)] },
    { approach: [chars(MIN_PLANNING_APPROACH_CHARS - 1)] },
    { approachBasis: [chars(MIN_PLANNING_BASIS_CHARS - 1)] },
    { resources: [chars(19)] },
  ]
  for (const overrides of thinCases) {
    const r = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases(overrides) })
    assert.equal(r.code, 'DELEGATE_DIRECT_START_INCOMPLETE', JSON.stringify(overrides))
    // 拒因透传 validateStartPhaseEvidence 原文＋补 direct 同一判据说明。
    assert.match(r.error!, /startPhases\.(planning|preparation)\./, JSON.stringify(overrides))
    assert.match(r.error!, /合计 ≥40 字/)
    assert.match(r.error!, /approachBasis 合计 ≥20 字/)
  }
  const boundary = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases() })
  assert.equal(boundary.ok, true, '合格共享夹具（全部下限达标）放行')
})

test('D5 direct 防旁路：已有非空分工表 ⇒ CONFLICT；下级 running ⇒ ALREADY_RUNNING（顺序：running 先）', async () => {
  const conflict = makeRuntime(QWEN)
  conflict.record.statuses[0].consolidation = goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() })
  const r1 = await conflict.runtime.delegateTool(conflict.leaderAgent, { action: 'direct', startPhases: goodPhases() })
  assert.equal(r1.code, 'DELEGATE_DIRECT_CONFLICT')
  const running = makeRuntime(QWEN)
  running.record.statuses[0].delegates = [{ member: 'Expert-A', status: 'running' }]
  running.record.statuses[0].consolidation = goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() })
  const r2 = await running.runtime.delegateTool(running.leaderAgent, { action: 'direct', startPhases: goodPhases() })
  assert.equal(r2.code, 'DELEGATE_ALREADY_RUNNING', '校验 1（running）先于校验 2（CONFLICT）')
})

test('D6 路由隔离：叶子调 direct ⇒ NOT_LEADER_SESSION（无父会话）／NO_PLAN（父＝部门会话无计划）', async () => {
  const { runtime } = makeRuntime(QWEN)
  const noParent = await runtime.delegateTool({ session: { id: 'leaf-x', header: {} } }, { action: 'direct', startPhases: goodPhases() })
  assert.equal(noParent.code, 'NOT_LEADER_SESSION')
  const leaf = { session: { id: 'member-1', header: { parentSession: 'child-leader' } }, options: { provider: 'qw', model: QWEN } }
  const noPlan = await runtime.delegateTool(leaf, { action: 'direct', startPhases: goodPhases() })
  assert.equal(noPlan.code, 'NO_PLAN')
})

test('D7 direct 后：dispatch/review(low) 被禁派闸硬拒（D2）；重新 review 显式 medium+ 转复杂流程合法（§5.8.8 语义边界）', async () => {
  const { runtime, leaderAgent, spawned } = makeRuntime(QWEN)
  assert.equal((await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases() })).ok, true)
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.code, LOW_FORBIDDEN, 'direct 登记后读回 low ⇒ dispatch 硬拒')
  const reLow = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'low' }), startPhases: goodPhases() })
  assert.equal(reLow.code, LOW_FORBIDDEN)
  const reComplex = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), startPhases: goodPhases() })
  assert.equal(reComplex.ok, true, '新显式声明不是例外通道：声明档为判定权威，≥8 人闸照常')
  assert.equal((await runtime.delegateTool(leaderAgent, { action: 'dispatch' })).ok, true)
  assert.equal(spawned.length, 8)
})

test('D8 durable 回放：direct 登记与 declared 记忆经 buildPlanMessage+reconstructFromSession 不丢', async () => {
  const direct = makeRuntime(QWEN)
  direct.rootSession.append('user/message', buildPlanMessage(direct.record.plan))
  assert.equal((await direct.runtime.delegateTool(direct.leaderAgent, { action: 'direct', startPhases: goodPhases() })).ok, true)
  flushPendingWorkplanUpdates(direct.rootSession)
  const rebuilt: any = reconstructFromSession(direct.rootSession)
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.effortOverride, 'low')
  assert.equal(row.consolidation.taskReasoningEffort, 'low')
  assert.deepEqual(row.consolidation.assignments, [])
  assert.ok(row.gateAudit.some((e: any) => e.action === 'direct' && e.ok === true))
  // [3.0.8 疑似缺口] 行级 startPhases 不在 durable workplan-update 回放白名单
  // （见本文件 X1 备案用例）：此处只断言契约保证落盘的字段。
  const complex = makeRuntime(OTHER, { provider: 'openai' })
  complex.rootSession.append('user/message', buildPlanMessage(complex.record.plan))
  assert.equal((await complex.runtime.delegateTool(complex.leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), startPhases: goodPhases() })).ok, true)
  flushPendingWorkplanUpdates(complex.rootSession)
  const rebuilt2: any = reconstructFromSession(complex.rootSession)
  const row2 = rebuilt2.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row2.consolidation.taskReasoningEffortDeclared, 'medium', '钳制前声明记忆回放不丢（防 dispatch 误杀）')
  assert.equal(row2.effortOverride, 'low')
})

test('D9 status hint：low 直执派生分支命中；复杂钳制到 low 的行（分工表非空）不命中', async () => {
  const { runtime, leaderAgent } = makeRuntime(QWEN)
  await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases() })
  const status = await runtime.delegateTool(leaderAgent, { action: 'status' })
  assert.match(status.hint, /禁止第三层下派/)
  assert.match(status.hint, /direct/)
  const complex = makeRuntime(OTHER, { provider: 'openai' })
  await complex.runtime.delegateTool(complex.leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), startPhases: goodPhases() })
  const status2 = await complex.runtime.delegateTool(complex.leaderAgent, { action: 'status' })
  assert.equal(status2.effortOverride, 'low')
  assert.ok(!status2.hint.includes('负责人亲自执行'), '钳制到 low 的复杂行不得误导为直执')
  assert.match(status2.hint, /dispatch/)
})

test('D10 direct 幂等＋中断镜像 stall-fix：仅首次登记（此前无 effortOverride）中断，重复 direct 只更新产物', async () => {
  const { runtime, leaderAgent, record, interrupts } = makeRuntime(QWEN)
  assert.equal((await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases() })).ok, true)
  assert.equal(interrupts.length, 1, 'phase-0→登记转变才中断')
  const again = await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases({ approach: [chars(MIN_PLANNING_APPROACH_CHARS + 1)] }) })
  assert.equal(again.ok, true)
  assert.equal(record.statuses[0].effortOverride, 'low')
  assert.deepEqual(record.statuses[0].startPhases.planning.approach, [chars(MIN_PLANNING_APPROACH_CHARS + 1)], '产物更新（行级 startPhases）')
  assert.equal(interrupts.length, 1, 'phase-1 重新 direct 绝不中断正在执行的回合')
})

/* ---------- E 钳制前判定 ---------- */

test('E1 单元：非 qwen medium 声明按钳制前判复杂 ⇒ 放行＋钳制留痕＋declared 记忆（若按钳制后判会误禁）', () => {
  const r = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), model: OTHER })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.taskEffort, 'low')
  assert.equal(r.taskEffortClamped?.requested, 'medium')
  assert.equal(r.taskEffortClamped?.corrected, 'low')
  assert.equal(r.taskEffortDeclared, 'medium')
})

test('E2 单元：非 qwen medium 2 人 ⇒ DELEGATE_HEADCOUNT_MIN（复杂判定在钳制前，人数下限闸不被钳制豁免）', () => {
  const r = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight().slice(0, 2) }), model: OTHER, minHeadcount: 3 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('E3 单元：declared 记忆同时驱动禁派闸与复杂判定：钳制后 low + 记忆 medium + 8 人 ⇒ 复杂放行 8 人（3.1.0 治本）', () => {
  const r = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'low', taskReasoningEffortDeclared: 'medium', assignments: eight() }), model: QWEN })
  assert.equal(r.ok, true, 'banDeclared=medium（记忆）⇒ 禁派闸不触发；complexTask 也消费同一记忆')
  assert.equal(r.taskEffort, 'low', '持久化档仍是钳制后值')
  assert.equal(r.members.length, 8, 'complexTask 按钳制前声明记忆判复杂 ⇒ cap=25：8 人全部保留（旧「回落 6 截断」已修）')
})

/* ---------- F 非 low 既有行为回归（S4） ---------- */

test('F1 回归：复杂人数下限闸原样（qwen medium，配置下限 3 时 2 人拦）；组员角色取消后全专家合法', () => {
  const two = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight().slice(0, 2) }), model: QWEN, minHeadcount: 3 })
  assert.equal(two.code, 'DELEGATE_HEADCOUNT_MIN')
  // [3.0.0][用户要求 9] 8 人全部为专家是唯一合法形态，不再有配比闸。
  const allExpert = eight().map((m) => ({ ...m, role: 'expert' }))
  const ok = planDelegations({ consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: allExpert }), model: QWEN })
  assert.equal(ok.ok, true)
  assert.equal(ok.members.length, 8)
})

test('F2 回归：整体档钳制留痕＋成员越界钳制留痕＋未配档成员继承整体档（qwen high→medium）', () => {
  const r = planDelegations({
    consolidation: goodConsolidation({ taskReasoningEffort: 'high', assignments: eight([{ reasoningEffort: 'max' }, {}]) }),
    model: QWEN,
  })
  assert.equal(r.ok, true)
  assert.equal(r.taskEffort, 'medium')
  assert.equal(r.taskEffortClamped?.requested, 'high')
  assert.equal(r.taskEffortClamped?.corrected, 'medium')
  assert.equal(r.members[0].effort, 'xhigh', '成员 max 越界钳制到 qwen 最高档 xhigh')
  assert.equal(r.clamped[0].requested, 'max')
  assert.equal(r.clamped[0].corrected, 'xhigh')
  assert.deepEqual(r.members.slice(1).map((m) => m.effort), Array(7).fill('medium'), '未配档成员继承整体档')
})

test('F3 回归（S4 核心）：行级 high/medium 兜底只进禁派链，不触发 complexTask/≥8/上限；3.1.0 起超限由静默截断改为拒收', () => {
  for (const rowEffort of ['high', 'medium']) {
    // S4 不变：declaredEffort 缺失 ⇒ 非复杂（cap=6），行级等级不 newly 触发 ≥8/上限判据。
    const r = planDelegations({ consolidation: goodConsolidation({ assignments: eight() }), model: QWEN, taskRowEffort: rowEffort })
    assert.equal(r.code, 'DELEGATE_HEADCOUNT_MAX', `行级 ${rowEffort}：8 人超非复杂上限 6 ⇒ 拒收（不再静默截 6）`)
    assert.ok(r.error!.includes('6'), '拒因须含上限 6')
    // 6 人以内仍原样放行（S4：行级等级不触发 ≥8 下限，行为零变化）。
    const six = planDelegations({ consolidation: goodConsolidation({ assignments: eight().slice(0, 6) }), model: QWEN, taskRowEffort: rowEffort })
    assert.equal(six.ok, true, `行级 ${rowEffort}：6 人非复杂原样放行`)
    assert.equal(six.members.length, 6)
    assert.equal(six.taskEffort, null)
  }
})

test('F4 回归：resolveTaskEffort 单一判据不变＋W1 负责人告知块新文案在/旧文案除', () => {
  assert.equal(resolveTaskEffort({ override: 'low', planned: 'max' }), 'low')
  assert.equal(resolveTaskEffort({ override: 'bogus', planned: 'medium' }), 'medium')
  assert.equal(resolveTaskEffort({}), 'high')
  const brief = buildLlmRulesBrief({ model: QWEN })
  assert.match(brief, /low\/未配置任务禁止下派/)
  assert.match(brief, /action="direct"/)
  assert.ok(!brief.includes('非复杂任务（low/未配置）最多 6 人'), 'W1 旧人数口径必须移除')
})

/* ---------- G direct 全链 e2e（规格 §9 direct 专项补回） ---------- */

test('G1 e2e：合格 startPhases＋direct low 登记 ⇒ phase-0 结算闸放行、以 low 档接续 phase-1、attempt 预算不耗、status=done', async () => {
  // 夹具仿 workplan-250-self-effort.test.ts 负责人 phase-0→review→接续 e2e 惯例：
  // dispatchPlan 真实链路，phase-0 期间经叶子工具调用触发 direct 登记（本用例局部夹具，不动其他用例）。
  const plan = makePlan()
  const rootSession = makeSession('session-root')
  const leaderSession: any = { id: 'child-leader', header: { createdAt: 1000, parentSession: 'session-root', cwd: '/tmp/t3-low-gate-cwd' }, append() {}, events: [] }
  const spawned: any[] = []
  const interrupts: any[] = []
  const leaderAgent: any = { session: leaderSession, options: { provider: 'qw', model: QWEN } }
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (request: any) => {
        const childId = `member-${spawned.length + 1}`
        let resolveResult: any
        const result = new Promise((resolve) => { resolveResult = resolve })
        spawned.push({ childId, request, resolveResult })
        return { childId, result, dispose: async () => {} }
      },
      interruptByParent: (childId: string, parentId: string, mode: string) => { interrupts.push({ childId, parentId, mode }); return { ok: true } },
      sendMessage: async () => 'msg-direct-e2e-stub',
    },
    sessions: { get: (id: string) => (id === 'session-root' ? rootSession : id === 'child-leader' ? leaderSession : undefined), list: () => [], eventAt: () => undefined },
    agents: { get: (id: string) => (id === 'child-leader' ? leaderAgent : undefined) },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'pending'
  statuses[0].childId = null
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set('session-root', record)
  const promptOf = (s: any) => s.request.prompt[0].text
  const effortOf = (s: any) => s.request.agentOptions.reasoningEffort
  let directDone: any = null
  const origStart = ctx.subagents.startActivation
  ctx.subagents.startActivation = async (request: any) => {
    const act = await origStart(request)
    if (spawned.length === 1) {
      // phase-0 期间负责人提交 direct 登记（真实链路由叶子工具调用触发）
      setTimeout(async () => {
        directDone = await runtime.delegateTool(
          { session: { id: act.childId, header: { parentSession: 'session-root', cwd: '/tmp/t3-low-gate-cwd' } }, options: { provider: 'qw', model: QWEN } },
          { action: 'direct', startPhases: goodPhases(), reasoningEffort: 'low' },
        )
        spawned[0].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: 'phase-0 评估完成：任务为 low 轻度，负责人亲自执行' }] })
      }, 0)
    } else {
      spawned[spawned.length - 1].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: 'T1 已完成：负责人亲自执行完毕（strictEvidence=false）' }] })
    }
    return act
  }
  await dispatchPlan(ctx, record, {
    agent: { session: rootSession, options: {} },
    signal: new AbortController().signal,
    idleTimeoutMs: 60000, childTimeoutMs: 60000, totalTimeoutMs: 30000,
    strictEvidence: false,
  })
  assert.equal(directDone?.ok, true, JSON.stringify(directDone))
  assert.equal(directDone.effortOverride, 'low')
  assert.equal(spawned.length, 2, 'phase-0＋low 接续恰好 2 次激活 ⇒ 接续不是重试，attempt 预算不耗')
  assert.equal(effortOf(spawned[0]), 'low', '负责人 phase-0 以 low 启动')
  assert.match(promptOf(spawned[0]), /唯一职责/, 'phase-0 任务书唯一职责=评估+登记')
  assert.match(promptOf(spawned[0]), /action="direct"/, 'phase-0 任务书对 low 任务指路 direct')
  assert.equal(effortOf(spawned[1]), 'low', 'phase-1 以登记的 low 档接续（resolveTaskEffort 读档）')
  const p1 = promptOf(spawned[1])
  assert.match(p1, /phase-0→phase-1 接续/, '接续块注入')
  assert.match(p1, /继续勿重做/)
  assert.match(p1, /low 任务亲自执行/, 'lowDirect 接续指路亲自执行（W11 派生量：effortOverride=low＋空分工表）')
  assert.match(p1, /phase-0 评估完成/, 'phase-0 输出随接续携带')
  assert.match(p1, /执行要求/, 'phase-1 携带完整任务书')
  assert.deepEqual(interrupts, [{ childId: 'member-1', parentId: 'session-root', mode: 'continuable' }], 'direct 登记仅中断 phase-0 一次（stall-fix 镜像）')
  const row = record.statuses[0]
  assert.equal(row.effortOverride, 'low')
  assert.deepEqual(row.consolidation.assignments, [], '空分工表＝直执标记')
  assert.equal(row.status, 'done', 'phase-1 正常结算（接续不耗重试预算）')
  assert.equal(row.error ?? null, null, '全程无失败记录 ⇒ 未消耗重试')
  // 注：record.errors 可能含 noticeChannel SESSION_UNAVAILABLE 提示（夹具 sessions.get
  // 只识别 root/leader，与 self-effort e2e 同惯例）——属通知通道夹具边界，非尝试失败，
  // 不在本矩阵项断言范围；attempt 不耗由「恰 2 次激活＋done＋行级无 error」证明。
})

/* ---------- X durable 回放（3.0.8 缺口已修复） ---------- */

test('X1：行级 startPhases 经 durable workplan-update 回放不丢（G1 双侧接线）', async () => {
  // [3.0.8] 修复：persist 白名单 + buildUpdateMessage 白名单 + 回放 patch 三处
  // 均已接 startPhases（与 consolidation 同一回放口径），重建后行级开工证据仍在——
  // 结算一致性比对（adjudicateResult carryover）与重试执行蓝图重启后不丢。
  const { runtime, leaderAgent, record, rootSession } = makeRuntime(QWEN)
  rootSession.append('user/message', buildPlanMessage(record.plan))
  assert.equal((await runtime.delegateTool(leaderAgent, { action: 'direct', startPhases: goodPhases() })).ok, true)
  assert.ok(record.statuses[0].startPhases, '登记后行级 startPhases 在内存中生效')
  flushPendingWorkplanUpdates(rootSession)
  const rebuilt: any = reconstructFromSession(rootSession)
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.deepEqual(row.startPhases, record.statuses[0].startPhases, '重建后行级 startPhases 回放不丢')
})

/* ---------- H 重派跳过已完成成员（3.1.0） ---------- */

test('H1 runtime：[3.1.0] 重派跳过已完成成员——done 专家不重复拉起、成果原样保留、skippedDone 留痕', async () => {
  const { runtime, leaderAgent, record, spawned } = makeRuntime(QWEN)
  const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ taskReasoningEffort: 'medium', assignments: eight() }), startPhases: goodPhases() })
  assert.equal(review.ok, true, JSON.stringify(review))
  const first = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(spawned.length, 8, '首轮 8 人全部拉起')
  // 模拟结算：Expert-A 已交付（done），其余 7 人失败待重派（running 会触发重复派发闸）。
  const row = record.statuses[0]
  row.delegates = row.delegates.map((d: any, i: number) => (i === 0
    ? { ...d, status: 'done', summary: '核心逻辑已交付', finishedAt: 2000 }
    : { ...d, status: 'failed', error: '模拟失败', finishedAt: 2000 }))
  const again = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(again.skippedDone, 1, '重派结果必须显式报告跳过 1 名已完成成员')
  assert.equal(spawned.length, 15, '8+7：done 成员未被重复拉起，仅 7 名失败成员重派')
  const kept = again.delegates.find((d: any) => d.member === 'Expert-A')
  assert.equal(kept.status, 'done', 'done 成果原样保留（不重置回 running）')
  assert.equal(kept.summary, '核心逻辑已交付')
  assert.ok(again.delegates.filter((d: any) => d.member !== 'Expert-A').every((d: any) => d.status === 'running'))
  assert.match(again.hint, /跳过 1 名已完成成员/, 'hint 须告知负责人未重复拉起已完成专家')
})
