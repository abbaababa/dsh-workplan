/*
 * [2.5.2] 叶子（专家/组员）执行前两轮深度思考硬门禁回归（用户 2026-11-12 要求）。
 *
 * 用户要求：四角色（主Agent/负责人/专家/组员）在开始具体执行前都被底层机制
 * 强制完成两轮深度思考（第一轮任务深研 → 第二轮基于第一轮全部结果理清方法、
 * 流程、步骤 → 再执行），且全程少走弯路。2.5.1 覆盖主Agent（dispatch 门禁）
 * 与负责人（review 门禁）；叶子此前只有任务书注入+结算时检查——本门禁把
 * phase-0 提交升级为原子对：self_effort 必须同时携带合格 deepThink，缺交/
 * 不合格硬拒（DEEP_THINK_MISSING / DEEP_THINK_INCOMPLETE），不登记、不接续；
 * 齐全才以自配档接续 phase-1，正式执行只能发生在两轮思考登记之后。
 *
 * 锁七件事：拒绝（缺交/敷衍/顺序）、放行+登记+持久化、重置保留+重派读档、
 * 旧叶子缺思考路由回 phase-0、回放消毒、四角色口径同源（含少走弯路）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyStatus, buildPlanMessage, buildUpdateMessage, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { threePhasePromptLines } from '../src/three-phase.js'
import { buildLlmRulesBrief, buildPhaseZeroDelegateePrompt } from '../src/llm-rules.js'
import { PROMPT_SECTION } from '../src/host.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

const QWEN = 'qwen3-max-preview'

function makePlan() {
  return {
    planId: 'wp-252-leaf', sessionId: 'session-root', createdTurn: 1, createdAt: 1000, title: '叶子执行前门禁用例',
    taskUnderstanding: { originalRequest: '补齐叶子执行前门禁', deliverable: '补丁' },
    contradictions: { primary: { statement: '先思考后执行 vs 不卡死回放' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [] }] }],
  }
}

function makeRuntime() {
  const plan = makePlan()
  const events: any[] = []
  const rootSession: any = {
    id: 'session-root', header: { createdAt: 1000, cwd: '/tmp/leaf-cwd' },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq], events,
  }
  const leaderSession: any = { id: 'child-leader', header: { createdAt: 1000, parentSession: 'session-root', cwd: '/tmp/leaf-cwd' }, append() {}, events: [] }
  const spawned: any[] = []
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
      interruptByParent: () => ({ ok: true }),
    },
    sessions: { get: (id: string) => (id === 'session-root' ? rootSession : id === 'child-leader' ? leaderSession : undefined), list: () => [], eventAt: () => undefined },
    agents: { get: (id: string) => (id === 'child-leader' ? leaderAgent : undefined) },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = 'child-leader'
  const record = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set('session-root', record)
  return { runtime, record, rootSession, spawned, leaderAgent, plan }
}

const consolidation = () => ({
  problemAnalysis: ['现状：任务拆给专家与组员', '主要矛盾：质量与时间'],
  approach: ['专家做核心实现', '组员做证据'],
  approachBasis: ['第二轮分工基于第一轮全部梳理结果：质量与时间矛盾决定专家做核心实现、组员做证据。'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'low' },
    { member: 'Member-B', role: 'member', task: '整理验收证据清单' },
  ],
})
const leafAgent = (childId: string) => ({ session: { id: childId, header: { parentSession: 'child-leader', cwd: '/tmp/leaf-cwd' } }, options: { provider: 'qw', model: QWEN } })
const promptOf = (s: any) => s.request.request.prompt[0].text
const effortOf = (s: any) => s.request.request.agentOptions.reasoningEffort

async function dispatched() {
  const env = makeRuntime()
  await env.runtime.delegateTool(env.leaderAgent, { action: 'review', consolidation: consolidation() })
  const r = await env.runtime.delegateTool(env.leaderAgent, { action: 'dispatch' })
  assert.equal(r.ok, true, JSON.stringify(r))
  return env
}

/* ---------- 1. 拒绝：缺交 / 敷衍 / 顺序 ---------- */

test('叶子 self_effort 缺 deepThink ⇒ DEEP_THINK_MISSING 硬拒，不登记、不接续', async () => {
  const { runtime, spawned, record } = await dispatched()
  const before = spawned.length
  const r = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DEEP_THINK_MISSING')
  assert.match(r.error, /全面、全盘、深入梳理、研究、思考/)
  assert.equal(spawned.length, before, '拒绝不得产生接续激活')
  assert.equal(record.statuses[0].delegateSelfEfforts, undefined, '拒绝不得登记自配档')
  assert.equal(record.statuses[0].delegateDeepThinks, undefined, '拒绝不得登记思考产物')
})

test('叶子 deepThink 敷衍（太薄/缺依据）⇒ DEEP_THINK_INCOMPLETE 硬拒', async () => {
  const { runtime, spawned } = await dispatched()
  const before = spawned.length
  const thin = await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂',
    deepThink: { ...MAIN_DEEP_THINK_FIXTURE, problemAnalysis: ['看一下'] },
  })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'DEEP_THINK_INCOMPLETE')
  const noBasis: any = { ...MAIN_DEEP_THINK_FIXTURE }
  delete noBasis.approachBasis
  const missing = await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂', deepThink: noBasis,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'DEEP_THINK_INCOMPLETE')
  assert.match(missing.error, /approachBasis/)
  assert.equal(spawned.length, before)
})

test('拒绝顺序不变：非法档/缺依据先于 deepThink 校验（旧拒因保持）', async () => {
  const { runtime } = await dispatched()
  const bad = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'ultra', complexityRationale: 'x' })
  assert.equal(bad.code, 'SELF_EFFORT_INVALID')
  const noWhy = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'medium' })
  assert.equal(noWhy.code, 'SELF_EFFORT_RATIONALE_MISSING')
})

/* ---------- 2. 放行：登记 + 持久化 + 接续蓝图 ---------- */

test('叶子 self_effort+合格 deepThink ⇒ 登记并以自配档接续 phase-1，执行蓝图随任务书下发', async () => {
  const { runtime, record, rootSession, spawned } = await dispatched()
  const r = await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'max', complexityRationale: '跨模块根因排查', deepThink: MAIN_DEEP_THINK_FIXTURE,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(spawned.length, 3, '必须新派生 phase-1 激活')
  assert.equal(effortOf(spawned[2]), 'xhigh', 'qwen max→xhigh 钳制后以自配档接续')
  const p1 = promptOf(spawned[2])
  assert.match(p1, /phase-0→phase-1 接续/)
  assert.match(p1, /第二轮方法流程步骤/, '第二轮蓝图随接续下发')
  assert.match(p1, /少走弯路/, '全程少走弯路要求随接续下发')
  const row = record.statuses[0]
  assert.deepEqual(row.delegates[0].deepThink, MAIN_DEEP_THINK_FIXTURE, 'delegates[].deepThink 落档')
  assert.deepEqual(row.delegateDeepThinks['Expert-A'], MAIN_DEEP_THINK_FIXTURE, 'delegateDeepThinks 台账落档')
  assert.match(JSON.stringify(rootSession.events), /delegateDeepThinks/, 'durable workplan-update 携带思考台账（重启不丢）')
  spawned[2].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: '完成' }] })
  await new Promise((resolve) => setTimeout(resolve, 10))
})

/* ---------- 3. 重置保留 + 重派读档 + 旧叶子补齐 ---------- */

test('重置保留 delegateDeepThinks；重派读档直接 phase-1（不再 phase-0、不重复提交）', async () => {
  const { runtime, record, spawned, leaderAgent } = await dispatched()
  await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂', deepThink: MAIN_DEEP_THINK_FIXTURE,
  })
  spawned[2].resolveResult({ stopReason: 'error', diagnostic: '中断' })
  spawned[1].resolveResult({ stopReason: 'error', diagnostic: '中断' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  record.statuses = applyStatus(record.statuses, 'T1', { status: 'pending' })
  assert.deepEqual(record.statuses[0].delegateDeepThinks['Expert-A'], MAIN_DEEP_THINK_FIXTURE, '思考产物是任务级配置，重置不清除')
  record.statuses[0].status = 'in_progress'
  record.statuses[0].childId = 'child-leader'
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  const again = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  // 取最后一次 Expert-A 激活（重派产生的读档接续），避免匹配到首次 self_effort 的 phase-0→phase-1 接续。
  const expertSpawn = spawned.filter((s: any) => promptOf(s).includes('Expert-A') && effortOf(s) === 'xhigh' && promptOf(s).includes('两轮思考读档')).pop()
  assert.ok(expertSpawn, '已自配+已思考成员重派必须直接 phase-1 读档接续')
  assert.match(promptOf(expertSpawn), /自配档接续/, '读档接续必须声明自配档已生效')
  assert.match(promptOf(expertSpawn), /不要重复提交思考产物/)
})

test('旧叶子只有自配档没有思考产物 ⇒ 重派路由回 phase-0 补齐（先思考后执行不留旁路）', async () => {
  const { runtime, record, spawned, leaderAgent } = await dispatched()
  // 模拟 2.5.2 之前登记的旧叶子：有 selfEffort、无 deepThink。
  const legacyDelegates = record.statuses[0].delegates.map((d: any) => ({ ...d, status: 'failed', ...(d.member === 'Expert-A' ? { selfEffort: 'xhigh' } : {}) }))
  record.statuses = applyStatus(record.statuses, 'T1', { delegates: legacyDelegates, delegateSelfEfforts: { 'Expert-A': 'xhigh' } })
  const again = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  const expertSpawn = spawned.filter((s: any) => promptOf(s).includes('Expert-A')).pop()
  assert.match(promptOf(expertSpawn), /phase-0/, '缺思考产物的旧叶子必须回 phase-0 补齐')
  assert.match(promptOf(expertSpawn), /deepThink/, 'phase-0 任务书必须写明思考产物义务')
})

/* ---------- 4. 回放消毒 ---------- */

test('重启回放：delegateDeepThinks 经 durable workplan-update 消毒抬升不丢', () => {
  const plan = makePlan()
  const events: any[] = []
  const session: any = {
    id: 'session-root', header: { createdAt: 1000 },
    get seq() { return events.length },
    append(t: string, d: any) { events.push({ type: t, data: d }); return d },
    eventAt: (n: number) => events[n], events,
  }
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 2,
    delegateSelfEfforts: { 'Expert-A': 'xhigh' },
    delegateDeepThinks: { 'Expert-A': MAIN_DEEP_THINK_FIXTURE, 'Bad-Entry': { problemAnalysis: ['薄'] } },
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.deepEqual(rebuilt.statuses[0].delegateDeepThinks['Expert-A'], MAIN_DEEP_THINK_FIXTURE, '合法产物回放不丢')
  assert.equal(rebuilt.statuses[0].delegateDeepThinks['Bad-Entry'], undefined, '非法/篡改产物消毒丢弃')
})

/* ---------- 5. 四角色口径同源（含少走弯路） ---------- */

test('协议文案同源：三阶段/主Agent提示词/负责人与叶子 brief/phase-0 任务书都含两轮+少走弯路', () => {
  const three = threePhasePromptLines().join('\n')
  assert.match(three, /以最高效率执行、确保完美完成自己任务的方法、流程和步骤/)
  assert.match(three, /少走弯路/)
  assert.match(String(PROMPT_SECTION), /少走弯路/)
  assert.match(String(PROMPT_SECTION), /DEEP_THINK_MISSING/, '主 Agent 提示词告知叶子门禁码')
  const head = buildLlmRulesBrief({ model: QWEN, tier: 'department' })
  assert.match(head, /少走弯路/)
  const leaf = buildLlmRulesBrief({ model: QWEN, tier: 'delegate', memberRole: 'expert' })
  assert.match(leaf, /少走弯路/)
  const phase0 = buildPhaseZeroDelegateePrompt({ departmentLabel: '工程', member: { member: 'X', role: 'expert', task: 't', effort: 'low' }, cwd: '/tmp' })
  assert.match(phase0, /deepThink/, 'phase-0 任务书必须写明 deepThink 义务')
  assert.match(phase0, /DEEP_THINK_MISSING/)
  assert.match(phase0, /少走弯路/)
  assert.match(phase0, /≥40字/, '字数口径告知（第一轮/第二轮）')
  assert.match(phase0, /≥20字/, '字数口径告知（依据）')
})