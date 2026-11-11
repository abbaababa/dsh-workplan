/*
 * [2.5.0][自配档] 用户要求 2 新口径「先配置后开工」平台强制机制回归。
 *
 * 口径：负责人/专家/组员各自按自己任务复杂度自配推理等级；phase-0 以 low 启动、
 * 唯一职责=评估复杂度+提交自配（负责人 review.taskReasoningEffort；叶子
 * delegate action=self_effort）；平台登记后立即以自配档接续 phase-1（宿主契约：
 * reasoningEffort 创建时解析、同会话不可换档 ⇒ interruptByParent(continuable)+
 * 新激活携带 phase-0 产物+完整任务书+继续勿重做）；分工表 per-member 档降为建议、
 * 成员自配为权威；继承仅旧计划回放兼容。持久化：effortOverride（既有）+
 * delegates[].selfEffort/delegateSelfEfforts（新增）消毒+durable 写入与回放消费
 * 双侧接线+重置保留+重试/续跑沿用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkplanRuntime, reconstructFromSession, dispatchPlan } from '../src/runtime.js'
import { applyStatus, buildPlanMessage, buildUpdateMessage, createStatuses } from '../src/plan.js'
import { planDelegations } from '../src/llm-rules.js'

const QWEN = 'qwen3-max-preview'

function makePlan() {
  return {
    planId: 'wp-250-self', sessionId: 'session-root', createdTurn: 1, createdAt: 1000, title: '自配档用例',
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [] }] }],
  }
}

function makeRuntime(opts: { failPhase1?: boolean } = {}) {
  const plan = makePlan()
  const events: any[] = []
  const rootSession: any = {
    id: 'session-root', header: { createdAt: 1000, cwd: '/tmp/self-cwd' },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq], events,
  }
  const leaderSession: any = { id: 'child-leader', header: { createdAt: 1000, parentSession: 'session-root', cwd: '/tmp/self-cwd' }, append() {}, events: [] }
  const spawned: any[] = []
  const spawnAttempts = { count: 0 }
  const interrupts: any[] = []
  const leaderAgent: any = { session: leaderSession, options: { provider: 'qw', model: QWEN } }
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (request: any) => {
        spawnAttempts.count += 1
        if (opts.failPhase1 && spawnAttempts.count > 2) throw new Error('spawn rejected')
        const childId = `member-${spawned.length + 1}`
        let resolveResult: any
        const result = new Promise((resolve) => { resolveResult = resolve })
        spawned.push({ childId, request, resolveResult })
        return { childId, result, dispose: async () => {} }
      },
      interruptByParent: (childId: string, parentId: string, mode: string) => { interrupts.push({ childId, parentId, mode }); return { ok: true } },
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
  return { runtime, record, rootSession, spawned, spawnAttempts, interrupts, leaderAgent, ctx }
}

const consolidation = (overrides: any = {}) => ({
  problemAnalysis: ['现状：任务拆给专家与组员'],
  approach: ['专家做核心实现'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'low' },
    { member: 'Member-B', role: 'member', task: '整理验收证据清单' },
  ],
  ...overrides,
})
const leafAgent = (childId: string) => ({ session: { id: childId, header: { parentSession: 'child-leader', cwd: '/tmp/self-cwd' } }, options: { provider: 'qw', model: QWEN } })
const promptOf = (s: any) => s.request.request.prompt[0].text
const effortOf = (s: any) => s.request.request.agentOptions.reasoningEffort

test('自配档：dispatch 叶子 phase-0 一律 low 启动，任务书唯一职责=self_effort 自配（分工表档降为建议）', async () => {
  const { runtime, spawned, leaderAgent } = makeRuntime()
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation({ taskReasoningEffort: 'xhigh' }) })
  const r = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(r.ok, true, JSON.stringify(r))
  for (const s of spawned) {
    assert.equal(effortOf(s), 'low', 'phase-0 强制 low，不烧分工表建议档/整体档')
    assert.match(promptOf(s), /self_effort/, 'phase-0 任务书必须写明自配义务')
    assert.match(promptOf(s), /唯一职责/, 'phase-0 唯一职责=评估复杂度+自配')
    assert.match(promptOf(s), /不得派生任何第四层/, '叶子禁令保留')
  }
})

test('自配档 e2e：叶子 self_effort 登记（钳制留痕）→ 平台以自配档接续 phase-1，携带 phase-0 产物+继续勿重做，childId 台账更新', async () => {
  const { runtime, record, rootSession, spawned, interrupts, leaderAgent } = makeRuntime()
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const r = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'max', complexityRationale: '跨模块根因排查，验证难度高' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.selfEffort, 'xhigh', 'qwen 家族 max→xhigh 钳制')
  assert.equal(r.clamped.requested, 'max')
  assert.equal(spawned.length, 3, '接续必须新派生 phase-1 激活')
  assert.equal(effortOf(spawned[2]), 'xhigh', 'phase-1 以自配档激活（权威，覆盖分工表建议 low）')
  const p1 = promptOf(spawned[2])
  assert.match(p1, /phase-0→phase-1 接续/, '接续块必须在任务书中')
  assert.match(p1, /跨模块根因排查/, 'phase-0 产物（复杂度依据）随接续携带')
  assert.match(p1, /继续勿重做/, '禁止重做 phase-0 已完成工作')
  assert.match(p1, /实现核心逻辑并自测/, '完整任务书随接续携带')
  assert.deepEqual(interrupts[0], { childId: 'member-1', parentId: 'child-leader', mode: 'continuable' }, 'phase-0 回合经 parent authority continuable 中断')
  const row = record.statuses[0]
  assert.equal(row.delegates[0].selfEffort, 'xhigh')
  assert.equal(row.delegates[0].selfEffortRequested, 'max')
  assert.equal(row.delegates[0].childId, 'member-3', '台账 childId 更新为 phase-1 会话')
  assert.equal(row.delegateSelfEfforts['Expert-A'], 'xhigh')
  assert.match(JSON.stringify(rootSession.events), /selfEffort/, 'durable workplan-update 携带 selfEffort')
  // phase-1 结算正常落档
  spawned[2].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: '专家结论：完成' }] })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(record.statuses[0].delegates[0].status, 'done')
})

test('自配档：非法档拒绝/缺依据拒绝/非叶子拒绝（平台硬校验）', async () => {
  const { runtime, leaderAgent } = makeRuntime()
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const bad = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'ultra', complexityRationale: 'x' })
  assert.equal(bad.ok, false); assert.equal(bad.code, 'SELF_EFFORT_INVALID')
  const noWhy = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'medium' })
  assert.equal(noWhy.ok, false); assert.equal(noWhy.code, 'SELF_EFFORT_RATIONALE_MISSING')
  const notLeaf = await runtime.delegateTool(leaderAgent, { action: 'self_effort', reasoningEffort: 'medium', complexityRationale: 'x' })
  assert.equal(notLeaf.ok, false); assert.equal(notLeaf.code, 'SELF_EFFORT_NOT_LEAF')
  const stranger = await runtime.delegateTool(leafAgent('member-unknown'), { action: 'self_effort', reasoningEffort: 'medium', complexityRationale: 'x' })
  assert.equal(stranger.ok, false); assert.equal(stranger.code, 'SELF_EFFORT_NOT_LEAF')
})

test('自配档：接续失败重试 1 次仍败 ⇒ SELF_EFFORT_CONTINUATION_FAILED 显式报错，禁止静默降档，自配档保留', async () => {
  const { runtime, record, spawned, spawnAttempts, leaderAgent } = makeRuntime({ failPhase1: true })
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const r = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'medium', complexityRationale: '中等复杂度' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SELF_EFFORT_CONTINUATION_FAILED')
  assert.equal(spawnAttempts.count, 4, '必须恰好重试 1 次（2 次 phase-0 成功 + 2 次接续尝试失败）')
  assert.equal(spawned.length, 2, '失败的接续尝试不产生会话')
  const row = record.statuses[0]
  assert.equal(row.delegates[0].status, 'failed')
  assert.match(row.delegates[0].error, /禁止静默降档/)
  assert.equal(row.delegates[0].selfEffort, 'medium', '自配档保留，重派直接沿用')
  assert.equal(row.delegateSelfEfforts['Expert-A'], 'medium')
})

test('自配档：重置保留 delegateSelfEfforts；重派直接以自配档接续 phase-1（不再 phase-0）', async () => {
  const { runtime, record, spawned, leaderAgent } = makeRuntime()
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂' })
  // 全部结算后重派：Expert-A 已自配 ⇒ phase-1 直连；Member-B 未自配 ⇒ 仍 phase-0。
  spawned[2].resolveResult({ stopReason: 'error', diagnostic: '中断' })
  spawned[1].resolveResult({ stopReason: 'error', diagnostic: '中断' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  // 重置（pending）后 delegateSelfEfforts 保留
  record.statuses = applyStatus(record.statuses, 'T1', { status: 'pending' })
  assert.equal(record.statuses[0].delegateSelfEfforts['Expert-A'], 'xhigh', '自配档是任务级配置，重置不清除')
  record.statuses[0].status = 'in_progress'
  record.statuses[0].childId = 'child-leader'
  // 重置清掉 consolidation（尝试痕迹）⇒ 重新 review 后才可 dispatch；自配档台账保留。
  const reReview = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  assert.equal(reReview.ok, true, JSON.stringify(reReview))
  const again = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  const expertSpawn = spawned.find((s: any) => promptOf(s).includes('Expert-A') && effortOf(s) === 'xhigh' && promptOf(s).includes('自配档接续'))
  assert.ok(expertSpawn, '已自配成员重派必须直接以自配档 phase-1 接续')
  const memberSpawns = spawned.filter((s: any) => promptOf(s).includes('Member-B'))
  assert.equal(effortOf(memberSpawns[memberSpawns.length - 1]), 'low', '未自配成员仍 phase-0 low')
})

test('自配档：durable 回放消费端恢复 selfEffort/delegateSelfEfforts（G1 教训：写入+消费双侧接线）', () => {
  const plan = { ...makePlan(), contradictions: { primary: { statement: '自配档回放不丢' } } }
  const events: any[] = []
  const session: any = {
    id: 'session-root', header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq], events,
  }
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 2,
    effortOverride: 'xhigh',
    delegateSelfEfforts: { 'Expert-A': 'xhigh' },
    delegates: [{ member: 'Expert-A', role: 'expert', task: '实现', effort: 'low', selfEffort: 'xhigh', selfEffortRequested: 'max', complexityRationale: '跨模块', childId: 'member-3', status: 'running' }],
  }))
  const rebuilt: any = reconstructFromSession(session)
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.effortOverride, 'xhigh')
  assert.equal(row.delegateSelfEfforts['Expert-A'], 'xhigh', '自配档台账回放恢复')
  assert.equal(row.delegates[0].selfEffort, 'xhigh', 'delegates[].selfEffort 回放恢复')
  assert.equal(row.delegates[0].selfEffortRequested, 'max')
  assert.equal(row.delegates[0].complexityRationale, '跨模块')
})

test('自配档：负责人 phase-0 low → review 自配 → 平台以自配档接续 phase-1（携带 phase-0 输出+继续勿重做，不耗重试预算）', async () => {
  const { runtime, record, spawned, ctx, rootSession } = makeRuntime()
  record.statuses[0].status = 'pending'
  record.statuses[0].childId = null
  const plan = record.plan
  let reviewDone: any = null
  const origStart = ctx.subagents.startActivation
  ctx.subagents.startActivation = async (request: any) => {
    const act = await origStart(request)
    if (spawned.length === 1) {
      // phase-0 期间负责人提交 review 自配（真实链路由叶子工具调用触发）
      setTimeout(async () => {
        reviewDone = await runtime.delegateTool(
          { session: { id: act.childId, header: { parentSession: 'session-root', cwd: '/tmp/self-cwd' } }, options: { provider: 'qw', model: QWEN } },
          { action: 'review', consolidation: consolidation({ taskReasoningEffort: 'xhigh' }) },
        )
        spawned[spawned.length - 1].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: 'phase-0 梳理完成：主要矛盾是质量与时间' }] })
      }, 0)
    } else {
      spawned[spawned.length - 1].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: 'T1 已完成：散文结论（strictEvidence=false）' }] })
    }
    return act
  }
  await dispatchPlan(ctx, record, {
    agent: { session: rootSession, options: {} },
    signal: new AbortController().signal,
    idleTimeoutMs: 60000, childTimeoutMs: 60000, totalTimeoutMs: 30000,
    strictEvidence: false,
  })
  assert.equal(reviewDone?.ok, true, JSON.stringify(reviewDone))
  assert.ok(spawned.length >= 2, 'phase-0 之后必须有 phase-1 接续激活')
  assert.equal(effortOf(spawned[0]), 'low', '负责人 phase-0 以 low 启动')
  assert.match(promptOf(spawned[0]), /唯一职责/, 'phase-0 任务书唯一职责=评估+自配')
  assert.equal(effortOf(spawned[1]), 'xhigh', 'phase-1 以负责人自配档激活')
  assert.match(promptOf(spawned[1]), /phase-0→phase-1 接续/, '接续块注入')
  assert.match(promptOf(spawned[1]), /phase-0 梳理完成/, 'phase-0 产物随接续携带')
  assert.match(promptOf(spawned[1]), /继续勿重做/)
  assert.match(promptOf(spawned[1]), /执行要求/, 'phase-1 携带完整任务书')
  assert.equal(record.statuses[0].status, 'done', 'phase-1 正常结算（接续不耗重试预算）')
})

test('自配档：重试/续跑读档——effortOverride 已登记时直接 phase-1 自配档，不再 phase-0', async () => {
  const { runtime, record, spawned, ctx, rootSession } = makeRuntime()
  record.statuses[0].status = 'pending'
  record.statuses[0].childId = null
  record.statuses = applyStatus(record.statuses, 'T1', { effortOverride: 'medium', updatedBy: 'child' })
  const origStart = ctx.subagents.startActivation
  ctx.subagents.startActivation = async (request: any) => {
    const act = await origStart(request)
    spawned[spawned.length - 1].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: '完成 prose' }] })
    return act
  }
  await dispatchPlan(ctx, record, {
    agent: { session: rootSession, options: {} },
    signal: new AbortController().signal,
    idleTimeoutMs: 60000, childTimeoutMs: 60000, totalTimeoutMs: 30000,
    strictEvidence: false,
  })
  assert.equal(effortOf(spawned[0]), 'medium', '已登记自配档 ⇒ 首发即 phase-1 自配档（重试/续跑/回放同判据）')
  assert.ok(!promptOf(spawned[0]).includes('phase-0（先配置后开工'), '不再走 phase-0')
})

test('自配档：旧计划回放零迁移——无新字段的梳理/改判照常工作，建议档计算保留', () => {
  const legacy = planDelegations({ consolidation: consolidation(), model: QWEN })
  assert.equal(legacy.ok, true, '旧梳理产物（无 selfEffort 概念）照常通过')
  assert.deepEqual(legacy.members.map((m) => m.effort), ['low', 'low'], '建议档计算保留（兼容），实际启动档由平台 phase-0 强制 low')
  const plan = { ...makePlan(), contradictions: { primary: { statement: '旧计划' } } }
  const events: any[] = []
  const session: any = { id: 'session-root', header: { createdAt: 1000 }, get seq() { return events.length }, append(t: string, d: any) { events.push({ type: t, data: d }); return d }, eventAt: (n: number) => events[n], events }
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({ planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 2 }))
  const rebuilt: any = reconstructFromSession(session)
  assert.equal(rebuilt.statuses[0].effortOverride, undefined, '旧日志无新字段 ⇒ 零迁移不报错')
})
