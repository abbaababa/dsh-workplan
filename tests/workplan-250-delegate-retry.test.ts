/*
 * [2.5.0][R4/R2] 第三层叶子「重试/续跑不丢已完成部分」根因修复回归。
 *
 * 缺口（本次核验发现）：delegate 重派时 buildDelegateePrompt 从不传
 * extraContext——叶子失败后重派拿到一张全新任务书，上次尝试的失败原因、
 * 已回报结论与在盘产物全部丢失，只能整步重跑（违反用户要求 4）。
 * 修复：runtime.ts probeDelegateLandedArtifacts（核盘结算备份）+
 * buildDelegateRetryBrief（重试简报纯函数）+ delegateTool dispatch 重派时
 * 经 extraContext 注入；llm-rules.ts planDelegations 新增 taskEffortFallback，
 * 重置后重新 review/dispatch 不丢已持久化的整体等级 effortOverride（R2×R4）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkplanRuntime, probeDelegateLandedArtifacts, buildDelegateRetryBrief, reconstructFromSession } from '../src/runtime.js'
import { applyStatus, buildPlanMessage, buildUpdateMessage, createStatuses } from '../src/plan.js'
import { planDelegations } from '../src/llm-rules.js'

const QWEN = 'qwen3-max-preview'

function makePlan() {
  return {
    planId: 'wp-250-retry',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: '第三层重试用例',
    stages: [{
      id: 'S1',
      name: '实施',
      // [2.5.5] 夹具适配：本文件测重派简报，不测低档禁派；任务行声明 high 放行第三层派发。
      subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [], reasoningEffort: 'high' }],
    }],
  }
}

function makeRuntime(cwd: string) {
  const plan = makePlan()
  const events: any[] = []
  const rootSession: any = {
    id: 'session-root',
    header: { createdAt: 1000, cwd },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
  const spawned: any[] = []
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
    },
    sessions: { get: (id: string) => (id === 'session-root' ? rootSession : undefined), list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = 'child-leader'
  const record = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set('session-root', record)
  const leaderAgent = {
    session: { id: 'child-leader', header: { parentSession: 'session-root', cwd } },
    options: { provider: 'qw', model: QWEN },
  }
  return { runtime, record, spawned, leaderAgent }
}

const consolidation = (overrides: any = {}) => ({
  // [2.5.4][T3R1] 夹具适配：补足合计字数 ≥40/40/20（保留「专家做核心实现」子串供重试简报断言）。
  problemAnalysis: ['现状：部门任务需要拆给专家与组员；目标是保质保量完成；约束是不改无关文件；主要矛盾是质量与时间。'],
  approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测', '组员做证据清单：逐条核对验收标准并落盘留证'],
  approachBasis: ["第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据，约束决定不改无关文件。"],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  ],
  ...overrides,
})

// [2.5.4][T4] 按 D1/D2 新契约适配，意图不变：复杂档（medium/high/xhigh/max）分工表须合计 ≥8 人。
// 默认 consolidation() 保持 2 人（非复杂子案依赖上限 6）；复杂子案专用 8 人表（≥1expert+≥1member）。
const assignments8 = () => [
  { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  ...Array.from({ length: 6 }, (_, i) => ({
    member: `Member-${String.fromCharCode(67 + i)}`, role: 'expert', task: `单一目标子任务 ${i + 3}（单一主产物、可独立验收）`, qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
  })),
]

const promptOf = (spawned: any) => spawned.request.prompt[0].text

/* ---------- 1. 在盘产物探测（纯逻辑，listDir 可注入） ---------- */

test('R4：probeDelegateLandedArtifacts 只认对应成员的结算备份，不串成员不编造', () => {
  const fakeDir = () => ['wp-member-Expert-A-t1.json', 'wp-member-Member-B-t2.json', 'wp-settlement-T1.json', 'notes.md']
  assert.deepEqual(probeDelegateLandedArtifacts('/tmp/x', 'Expert-A', fakeDir), ['reports/wp-member-Expert-A-t1.json'])
  assert.deepEqual(probeDelegateLandedArtifacts('/tmp/x', 'Member-B', fakeDir), ['reports/wp-member-Member-B-t2.json'])
  assert.deepEqual(probeDelegateLandedArtifacts('/tmp/x', 'Nobody', fakeDir), [])
})

test('R4：probeDelegateLandedArtifacts 目录读取失败/参数缺失返回空清单（绝不编造产物）', () => {
  const throwing = () => { throw new Error('ENOENT') }
  assert.deepEqual(probeDelegateLandedArtifacts('/tmp/x', 'Expert-A', throwing), [])
  assert.deepEqual(probeDelegateLandedArtifacts('/tmp/x', '', () => ['wp-member--a.json']), [])
  assert.deepEqual(probeDelegateLandedArtifacts(undefined, 'Expert-A', () => ['wp-member-Expert-A-a.json']), [])
  // 真实文件系统：不存在的目录同样安静返回空。
  assert.deepEqual(probeDelegateLandedArtifacts('/tmp/wp-250-definitely-missing-dir', 'Expert-A'), [])
})

/* ---------- 2. 重试简报纯函数 ---------- */

test('R4：buildDelegateRetryBrief 失败重试携带失败原因/在盘产物/勿重做硬约束与梳理思路', () => {
  const brief = buildDelegateRetryBrief(
    { status: 'failed', error: '执行中断：子会话异常', summary: '已完成一半：核心函数已写好' },
    ['reports/wp-member-Expert-A-t1.json'],
    ['专家做核心实现'],
  )
  assert.match(brief, /重试\/续跑简报/)
  assert.match(brief, /failed/)
  assert.match(brief, /执行中断：子会话异常/)
  assert.match(brief, /核心函数已写好/)
  assert.match(brief, /reports\/wp-member-Expert-A-t1\.json/)
  assert.match(brief, /专家做核心实现/)
  assert.match(brief, /请勿重做已完成的工作/)
  assert.match(brief, /禁止整步重跑/)
})

test('R4：buildDelegateRetryBrief 已完成成员续跑只补缺口；首发（无上次台账）返回空串', () => {
  const done = buildDelegateRetryBrief({ status: 'done', summary: '证据清单已就绪' }, [])
  assert.match(done, /已完成/)
  assert.match(done, /只补缺口/)
  assert.match(done, /请勿重做已完成的工作/)
  assert.equal(buildDelegateRetryBrief(null, []), '')
  assert.equal(buildDelegateRetryBrief(undefined, ['reports/a.json']), '')
})

/* ---------- 3. 端到端：叶子失败后重派，新任务书携带已完成部分 ---------- */

test('R4 端到端：叶子 failed/done 后重派——新任务书附上次失败原因、在盘产物与勿重做约束；首发任务书无简报', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wp250-retry-'))
  try {
    mkdirSync(join(cwd, 'reports'))
    writeFileSync(join(cwd, 'reports', 'wp-member-Expert-A-t1.json'), '{"status":"partial"}')
    const { runtime, spawned, leaderAgent } = makeRuntime(cwd)
    const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
    assert.equal(review.ok, true, JSON.stringify(review))
    const first = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(spawned.length, 2)
    for (const child of spawned) {
      assert.ok(!promptOf(child).includes('重试/续跑简报'), '首发任务书不得携带重试简报')
    }
    // Expert-A 失败（产物已在盘）、Member-B 完成。
    spawned[0].resolveResult({ stopReason: 'error', diagnostic: '执行中断：子会话异常' })
    spawned[1].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: '组员结论：证据清单已就绪' }] })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(spawned.length, 4, '重派必须为两位下级重新派生叶子')
    const expertRetry = promptOf(spawned[2])
    assert.match(expertRetry, /重试\/续跑简报/, '失败叶子重派必须携带重试简报')
    assert.match(expertRetry, /执行中断：子会话异常/, '必须携带上次失败原因')
    assert.match(expertRetry, /reports\/wp-member-Expert-A-t1\.json/, '必须携带已核实在盘的已完成产物清单')
    assert.match(expertRetry, /请勿重做已完成的工作/)
    assert.match(expertRetry, /专家做核心实现/, '必须携带负责人梳理上下文')
    assert.match(expertRetry, /不得派生任何第四层/, '叶子层禁令不因重试丢失')
    const memberRetry = promptOf(spawned[3])
    assert.match(memberRetry, /重试\/续跑简报/)
    assert.match(memberRetry, /证据清单已就绪/, '已完成成员的结论必须随续跑携带')
    assert.match(memberRetry, /请勿重做已完成的工作/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

/* ---------- 4. R2×R4：重置后整体等级不丢（effortOverride 回落继承） ---------- */

test('R2×R4：planDelegations taskEffortFallback——梳理未带整体等级时继承行上 effortOverride，显式配置优先', () => {
  // [2.5.4][T4] 按 D1/D2 新契约适配，意图不变：回落源 xhigh/high=复杂 ⇒ 对应子案扩到 8 人。
  // [T10][E-A] 按 2.5.5/D1–D5 新契约适配：low 与「未配置（视同 low）」已被禁派，
  // 原「explicit low 返回 taskEffort=low」「none 回落 low 仍 ok」在现行契约下是非法前提；
  // 现改为断言「显式 low 优先于回落源 → 命中 low 禁派闸」与「未配置视同 low → 禁派」，
  // 既保留「显式配置优先于回落源」的原意，又钉死新裁决语义（断言意图不弱化）。
  const inherited = planDelegations({ consolidation: consolidation({ assignments: assignments8() }), model: QWEN, taskEffortFallback: 'xhigh' })
  assert.equal(inherited.ok, true)
  assert.equal(inherited.taskEffort, 'xhigh')
  assert.deepEqual(inherited.members.map((m) => m.effort), Array(8).fill('xhigh'))
  const explicit = planDelegations({ consolidation: consolidation({ taskReasoningEffort: 'low' }), model: QWEN, taskEffortFallback: 'xhigh' })
  assert.equal(explicit.ok, false, '显式 low 优先于回落源 xhigh，必须命中 low 禁派闸')
  assert.equal(explicit.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  assert.equal(explicit.taskEffort, null)
  const clamped = planDelegations({ consolidation: consolidation({ assignments: assignments8() }), model: QWEN, taskEffortFallback: 'high' })
  assert.equal(clamped.taskEffort, 'medium', '回落源同样按家族钳制并留痕')
  assert.equal(clamped.taskEffortClamped?.requested, 'high')
  const none = planDelegations({ consolidation: consolidation(), model: QWEN })
  assert.equal(none.ok, false, '未配置整体等级 ⇒ 视同 low ⇒ 禁派（D1–D5）')
  assert.equal(none.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  assert.deepEqual(none.members, [])
})

test('R2×R4 端到端：重置清掉 consolidation 后重新 review/dispatch——effortOverride 全程贯穿到叶子 agentOptions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wp250-effort-'))
  try {
    const { runtime, record, spawned, leaderAgent } = makeRuntime(cwd)
    // [2.5.4][T4] 按 D1/D2 新契约适配，意图不变：声明 xhigh=复杂 ⇒ 首发 review 分工表扩到 8 人。
    const review = await runtime.delegateTool(leaderAgent, {
      action: 'review',
      consolidation: consolidation({ taskReasoningEffort: 'xhigh', assignments: assignments8() }),
    })
    assert.equal(review.ok, true)
    assert.equal(record.statuses[0].effortOverride, 'xhigh')
    // 尝试重置：consolidation/delegates 清除，effortOverride 保留（任务级配置）。
    record.statuses = applyStatus(record.statuses, 'T1', { status: 'pending' })
    assert.equal(record.statuses[0].consolidation, undefined)
    assert.equal(record.statuses[0].effortOverride, 'xhigh')
    // 重新激活（真实重试路径会重新登记 childId）。
    record.statuses[0].status = 'in_progress'
    record.statuses[0].childId = 'child-leader'
    // 重新 review 未再配整体等级、下级也未单独配档 ⇒ 必须继承 effortOverride。
    // [2.5.4][T4] 按 D1/D2 新契约适配，意图不变：effortOverride=xhigh 回落判复杂 ⇒ reReview 同样扩到 8 人。
    const reReview = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation({ assignments: assignments8() }) })
    assert.equal(reReview.ok, true, JSON.stringify(reReview))
    assert.equal(reReview.taskEffort, 'xhigh', '重新 review 不得丢失已配置的整体等级')
    assert.deepEqual(reReview.members.map((m: any) => m.effort), Array(8).fill('xhigh'))
    assert.equal(record.statuses[0].effortOverride, 'xhigh')
    assert.equal(record.statuses[0].consolidation.taskReasoningEffort, 'xhigh')
    const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
    assert.equal(dispatch.effortOverride, 'xhigh')
    for (const child of spawned) {
      // [2.5.0][自配档] 叶子未自配 ⇒ phase-0 low 启动；整体等级 effortOverride 仍全程贯穿（负责人层）。
      assert.equal(child.request.agentOptions.reasoningEffort, 'low', '叶子 phase-0 一律 low 启动，等待 self_effort 自配')
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

/* ---------- 5. R2/G1：durable 回放消费端（reconstructFromSession） ---------- */

test('R2/G1：刷新/重启回放后 effortOverride/consolidation/delegates 全部恢复（消费端不再漏接）', () => {
  // buildPlanMessage 需要 contradictions.primary（与 t6-handoffs-replay 同形）。
  const plan = { ...makePlan(), contradictions: { primary: { statement: '回放后整体等级与第三层台账不丢' } } }
  const events: any[] = []
  const session: any = {
    id: 'session-root',
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
  session.append('user/message', buildPlanMessage(plan))
  // 与 delegateTool review/dispatch 落盘同形的 durable workplan-update。
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId,
    subtaskId: 'T1',
    status: 'in_progress',
    effortOverride: 'xhigh',
    consolidation: {
      problemAnalysis: ['梳理：任务拆给专家与组员'],
      approach: ['专家做核心实现'],
      approachBasis: ["第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据，约束决定不改无关文件。"],
      assignments: [
        { member: 'Expert-A', role: 'expert', task: '实现核心逻辑', reasoningEffort: 'xhigh', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
        { member: 'Member-B', role: 'expert', task: '证据清单', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
      ],
      taskReasoningEffort: 'xhigh',
    },
    delegates: [
      { member: 'Expert-A', role: 'expert', task: '实现核心逻辑', effort: 'xhigh', childId: 'member-1', status: 'done', summary: '已完成', startedAt: 1, finishedAt: 2, qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    ],
    revision: 2,
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.ok(rebuilt?.plan, '计划必须可重建')
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.effortOverride, 'xhigh', '整体推理等级刷新/重启后不得丢失（resolveTaskEffort 仍优先读它）')
  assert.ok(row.consolidation, '梳理登记刷新/重启后不得丢失（dispatch 门禁判据）')
  assert.equal(row.consolidation.taskReasoningEffort, 'xhigh')
  assert.equal(row.consolidation.assignments.length, 2)
  assert.equal(row.delegates.length, 1, '第三层台账刷新/重启后不得丢失')
  assert.equal(row.delegates[0].member, 'Expert-A')
  assert.equal(row.delegates[0].status, 'done')
})
