/*
 * [3.0.8] 叶子（专家/组员）执行前五步开工证据硬门禁回归（五步工作法单框架）。
 *
 * 历史口径：2.5.2 两轮深度思考开工门禁（用户 2026-11-12 要求）→ 3.0.8 废除
 * deepThink 双框架，两轮内容本就是五步第 1、2 步的子集，统一为 startPhases
 * 五步开工证据（planning{ problemAnalysis[], approach[], approachBasis[],
 * resources[], tools[] } + preparation{ prepared[], evidence[] }，40/40/20 字判据）。
 *
 * 用户要求：四角色（主Agent/负责人/专家/组员）在开始具体执行前都被底层机制
 * 强制完成五步前三步（第一步任务梳理 → 第二步基于第一步全部结果理清资源、
 * 工具与实施方案 → 第三步准备就绪），且全程少走弯路。主Agent（dispatch 门禁）
 * 与负责人（review 门禁）已覆盖；叶子此前只有任务书注入+结算时检查——本门禁把
 * phase-0 提交升级为原子对：self_effort 必须同时携带合格 startPhases，缺交/
 * 不合格硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），不登记、不接续；
 * 齐全才以自配档接续 phase-1，正式执行只能发生在开工证据登记之后。
 *
 * 锁七件事：拒绝（缺交/敷衍/顺序）、放行+登记+持久化、重置保留+重派读档、
 * 旧叶子缺证据路由回 phase-0、回放消毒、四角色口径同源（含少走弯路）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyStatus, buildChildPrompt, buildPlanMessage, buildUpdateMessage, createStatuses, flushPendingWorkplanUpdates } from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { fiveStepPromptLines, sanitizeStartPhaseEvidence } from '../src/five-step.js'
import { buildLlmRulesBrief, buildPhaseZeroDelegateePrompt } from '../src/llm-rules.js'
import { PROMPT_SECTION } from '../src/host.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

const QWEN = 'qwen3-max-preview'

// [3.0.8] 登记/回放两侧的开工证据都经 sanitizeStartPhaseEvidence 归一化
// （constraints/unknowns 补空数组等），断言一律与消毒后形状比对（G1 双侧同判据）。
const START_PHASES_SANITIZED = sanitizeStartPhaseEvidence(MAIN_START_PHASES_FIXTURE)

function makePlan() {
  return {
    planId: 'wp-252-leaf', sessionId: 'session-root', createdTurn: 1, createdAt: 1000, title: '叶子执行前门禁用例',
    taskUnderstanding: { originalRequest: '补齐叶子执行前门禁', deliverable: '补丁' },
    contradictions: { primary: { statement: '先思考后执行 vs 不卡死回放' }, secondary: [], transformationConditions: [] },
    // [T10][D-R1] 夹具适配：计划行声明复杂档，通过 2.5.5 low 禁派闸（未配置视同 low）；
    // 行档位不进入 declaredEffort ⇒ 不触发 ≥8 人闸，2 人分工与既有断言保持不变。
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [], reasoningEffort: 'high' }] }],
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
      // [T6] 预估送达通道 stub：self_effort 登记后经 sendMessage 投给负责人（缺此函数会 ESTIMATE_DELIVERY_FAILED）。
      sendMessage: async () => 'msg-leaf-deep-think-stub',
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
  // [2.5.4][T3R1] 夹具适配：补足合计字数 ≥40/40/20（断言意图零改动）。
  problemAnalysis: ['现状：任务拆给专家与组员；目标是保质保量完成；约束是不改无关文件；边界是只做分内工作。', '主要矛盾：质量与时间'],
  approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测', '组员做证据：逐条核对验收标准并落盘留证'],
  approachBasis: ['第二轮分工基于第一轮全部梳理结果：质量与时间矛盾决定专家做核心实现、组员做证据。'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  ],
})
const leafAgent = (childId: string) => ({ session: { id: childId, header: { parentSession: 'child-leader', cwd: '/tmp/leaf-cwd' } }, options: { provider: 'qw', model: QWEN } })
const promptOf = (s: any) => s.request.prompt[0].text
const effortOf = (s: any) => s.request.agentOptions.reasoningEffort

async function dispatched() {
  const env = makeRuntime()
  // [3.0.8] review 同收 startPhases 开工证据（负责人开工闸）：用共享合格夹具过闸。
  await env.runtime.delegateTool(env.leaderAgent, { action: 'review', consolidation: consolidation(), startPhases: MAIN_START_PHASES_FIXTURE })
  const r = await env.runtime.delegateTool(env.leaderAgent, { action: 'dispatch' })
  assert.equal(r.ok, true, JSON.stringify(r))
  return env
}

/* ---------- 1. 拒绝：缺交 / 敷衍 / 顺序 ---------- */

test('叶子 self_effort 缺 startPhases ⇒ START_EVIDENCE_MISSING 硬拒，不登记、不接续', async () => {
  const { runtime, spawned, record } = await dispatched()
  const before = spawned.length
  const r = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'START_EVIDENCE_MISSING')
  assert.match(r.error, /全面、全盘、深入梳理、研究、思考/)
  assert.equal(spawned.length, before, '拒绝不得产生接续激活')
  assert.equal(record.statuses[0].delegateSelfEfforts, undefined, '拒绝不得登记自配档')
  assert.equal(record.statuses[0].delegateStartPhases, undefined, '拒绝不得登记开工证据')
})

test('叶子 startPhases 敷衍（太薄/缺依据）⇒ START_EVIDENCE_INCOMPLETE 硬拒', async () => {
  const { runtime, spawned } = await dispatched()
  const before = spawned.length
  // [3.0.8] 太薄用例改 planning 内部字段（顶层展开式是错误形状，planning 内仍全量）。
  const thin = await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂',
    startPhases: { ...MAIN_START_PHASES_FIXTURE, planning: { ...MAIN_START_PHASES_FIXTURE.planning, problemAnalysis: ['看一下'] } },
  })
  assert.equal(thin.ok, false)
  assert.equal(thin.code, 'START_EVIDENCE_INCOMPLETE')
  const noBasis: any = { ...MAIN_START_PHASES_FIXTURE, planning: { ...MAIN_START_PHASES_FIXTURE.planning } }
  delete noBasis.planning.approachBasis
  const missing = await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂', startPhases: noBasis,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(missing.error, /approachBasis/)
  assert.equal(spawned.length, before)
})

test('拒绝顺序不变：非法档/缺依据先于 startPhases 校验（旧拒因保持）', async () => {
  const { runtime } = await dispatched()
  const bad = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'ultra', complexityRationale: 'x' })
  assert.equal(bad.code, 'SELF_EFFORT_INVALID')
  const noWhy = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'medium' })
  assert.equal(noWhy.code, 'SELF_EFFORT_RATIONALE_MISSING')
})

/* ---------- 2. 放行：登记 + 持久化 + 接续蓝图 ---------- */

test('叶子 self_effort+合格 startPhases ⇒ 登记并以自配档接续 phase-1，执行蓝图随任务书下发', async () => {
  const { runtime, record, rootSession, spawned } = await dispatched()
  const r = await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'max', complexityRationale: '跨模块根因排查', startPhases: MAIN_START_PHASES_FIXTURE, timeNotice: { declaredMinutes: 20, reason: '跨模块根因排查' },
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(spawned.length, 3, '必须新派生 phase-1 激活')
  assert.equal(effortOf(spawned[2]), 'xhigh', 'qwen max→xhigh 钳制后以自配档接续')
  const p1 = promptOf(spawned[2])
  assert.match(p1, /phase-0→phase-1 接续/)
  assert.match(p1, /第二步方法流程步骤/, '第二步蓝图随接续下发')
  assert.match(p1, /少走弯路/, '全程少走弯路要求随接续下发')
  const row = record.statuses[0]
  assert.deepEqual(row.delegates[0].startPhases, START_PHASES_SANITIZED, 'delegates[].startPhases 落档')
  assert.deepEqual(row.delegateStartPhases['Expert-A'], START_PHASES_SANITIZED, 'delegateStartPhases 台账落档')
  flushPendingWorkplanUpdates(rootSession)
  assert.match(JSON.stringify(rootSession.events), /delegateStartPhases/, 'durable workplan-update 携带开工证据台账（重启不丢）')
  spawned[2].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: '完成' }] })
  await new Promise((resolve) => setTimeout(resolve, 10))
})

/* ---------- 3. 重置保留 + 重派读档 + 旧叶子补齐 ---------- */

test('重置保留 delegateStartPhases；重派读档直接 phase-1（不再 phase-0、不重复提交）', async () => {
  const { runtime, record, spawned, leaderAgent } = await dispatched()
  await runtime.delegateTool(leafAgent('member-1'), {
    action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂', startPhases: MAIN_START_PHASES_FIXTURE, timeNotice: { declaredMinutes: 25, reason: '非常复杂' },
  })
  spawned[2].resolveResult({ stopReason: 'error', diagnostic: '中断' })
  spawned[1].resolveResult({ stopReason: 'error', diagnostic: '中断' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  record.statuses = applyStatus(record.statuses, 'T1', { status: 'pending' })
  assert.deepEqual(record.statuses[0].delegateStartPhases['Expert-A'], START_PHASES_SANITIZED, '开工证据是任务级配置，重置不清除')
  record.statuses[0].status = 'in_progress'
  record.statuses[0].childId = 'child-leader'
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation(), startPhases: MAIN_START_PHASES_FIXTURE })
  const again = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  // 取最后一次 Expert-A 激活（重派产生的读档接续），避免匹配到首次 self_effort 的 phase-0→phase-1 接续。
  const expertSpawn = spawned.filter((s: any) => promptOf(s).includes('Expert-A') && effortOf(s) === 'xhigh' && promptOf(s).includes('开工证据读档')).pop()
  assert.ok(expertSpawn, '已自配+已登记开工证据成员重派必须直接 phase-1 读档接续')
  assert.match(promptOf(expertSpawn), /自配档接续/, '读档接续必须声明自配档已生效')
  assert.match(promptOf(expertSpawn), /不要重复提交开工证据/)
})

test('旧叶子只有自配档没有开工证据 ⇒ 重派路由回 phase-0 补齐（先证据后执行不留旁路）', async () => {
  const { runtime, record, spawned, leaderAgent } = await dispatched()
  // 模拟 3.0.8 之前登记的旧叶子：有 selfEffort、无 startPhases。
  const legacyDelegates = record.statuses[0].delegates.map((d: any) => ({ ...d, status: 'failed', ...(d.member === 'Expert-A' ? { selfEffort: 'xhigh' } : {}) }))
  record.statuses = applyStatus(record.statuses, 'T1', { delegates: legacyDelegates, delegateSelfEfforts: { 'Expert-A': 'xhigh' } })
  const again = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  const expertSpawn = spawned.filter((s: any) => promptOf(s).includes('Expert-A')).pop()
  assert.match(promptOf(expertSpawn), /phase-0/, '缺开工证据的旧叶子必须回 phase-0 补齐')
  assert.match(promptOf(expertSpawn), /startPhases/, 'phase-0 任务书必须写明开工证据义务')
})

/* ---------- 4. 回放消毒 ---------- */

test('重启回放：delegateStartPhases 经 durable workplan-update 消毒抬升不丢', () => {
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
    delegateStartPhases: { 'Expert-A': MAIN_START_PHASES_FIXTURE, 'Bad-Entry': { problemAnalysis: ['薄'] } },
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.deepEqual(rebuilt.statuses[0].delegateStartPhases['Expert-A'], START_PHASES_SANITIZED, '合法产物回放不丢')
  assert.equal(rebuilt.statuses[0].delegateStartPhases['Bad-Entry'], undefined, '非法/篡改产物消毒丢弃')
})

/* ---------- 5. 四角色口径同源（含少走弯路） ---------- */

test('协议文案同源：五步提示词/主Agent提示词/负责人与叶子 brief/phase-0 任务书都含开工证据+少走弯路', () => {
  const three = fiveStepPromptLines().join('\n')
  assert.match(three, /以最高效率执行、确保完美完成自己任务的方法、流程和步骤/)
  assert.match(three, /少走弯路/)
  assert.match(String(PROMPT_SECTION), /少走弯路/)
  assert.match(String(PROMPT_SECTION), /START_EVIDENCE_MISSING/, '主 Agent 提示词告知叶子门禁码')
  const head = buildLlmRulesBrief({ model: QWEN, tier: 'department' })
  assert.match(head, /startPhases/, '负责人 brief 写明开工证据义务（3.0.8 新契约）')
  // [疑似 src bug 已报告] 3.0.8 机械改写把负责人 brief 里的「全程少走弯路」短语改丢
  // （src/llm-rules.ts:182 部门行；2.5.x 旧行含「含全程如何少走弯路：先查历史教训、
  // 先验证再动手、不重复试错」）。同义口径仍经 buildChildPrompt 注入的
  // fiveStepPromptLines 覆盖负责人任务书——此处钉死该覆盖不回归：
  const childPrompt = buildChildPrompt({
    plan: makePlan(),
    subtask: makePlan().stages[0].subtasks[0],
    stage: makePlan().stages[0],
    dependencyResults: [],
    cwd: '/tmp/leaf-cwd',
  })
  assert.match(childPrompt, /少走弯路/, '负责人任务书（五步提示词注入）必须含少走弯路')
  const leaf = buildLlmRulesBrief({ model: QWEN, tier: 'delegate', memberRole: 'expert' })
  assert.match(leaf, /少走弯路/)
  const phase0 = buildPhaseZeroDelegateePrompt({ departmentLabel: '工程', member: { member: 'X', role: 'expert', task: '读取目标文件得出一份结论', effort: 'low', qualityRequirements: ['必须给出命令输出'] }, cwd: '/tmp' })
  assert.match(phase0, /startPhases/, 'phase-0 任务书必须写明 startPhases 义务')
  assert.match(phase0, /START_EVIDENCE_MISSING/)
  assert.match(phase0, /少走弯路/)
  assert.match(phase0, /≥40字/, '字数口径告知（第一步/第二步方法）')
  assert.match(phase0, /≥20字/, '字数口径告知（依据/资源/准备）')
})