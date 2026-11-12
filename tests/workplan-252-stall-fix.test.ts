/*
 * [2.5.2][stall-fix] 「提交任务后长时间无反应」缺陷修复回归（用户 2026-11-12 硬要求）。
 *
 * 本会话实证的三条根因与对应修复：
 *  R1 负责人 phase-1 重新 review 触发无条件中断，而接续只存在于 phase-0 结算
 *     分支 ⇒ 子会话 aborted、产物丢失、台账 blocked、用户长时间看不到进展。
 *     修复：仅当 review 之前未登记 effortOverride（真 phase-0）才中断。
 *  R2 规划器默认取家族最高推理档，实测单次规划 12-13 分钟 ⇒ 提交后长时间
 *     只有心跳没有结果。修复：默认改家族中等档（qwen=medium/非qwen=high），
 *     env 覆盖保留。
 *  R3 派发执行轮次期间零会话输出 ⇒ 用户无法区分在跑与卡死。修复：执行期
 *     进度心跳（复用规划心跳工厂，buildMessage 注入，finally stop 收束）。
 *
 * 断言口径：R1 行为级（中断计数）；R3 文案/工厂行为级（假时钟）+ 接线源码锚定；
 * R2 源码锚定（runPlanner 需真实 LLM，行为验证留待主 Agent 重启后真实规划）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildDispatchHeartbeat, createPlanningHeartbeat, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

const QWEN = 'qwen3-max-preview'

function makePlan() {
  return {
    planId: 'wp-stall-fix', sessionId: 'session-root', createdTurn: 1, createdAt: 1000, title: '无反应缺陷修复用例',
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [] }] }],
  }
}

function makeRuntime() {
  const plan = makePlan()
  const events: any[] = []
  const rootSession: any = {
    id: 'session-root', header: { createdAt: 1000, cwd: '/tmp/stall-cwd' },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq], events,
  }
  const leaderSession: any = { id: 'child-leader', header: { createdAt: 1000, parentSession: 'session-root', cwd: '/tmp/stall-cwd' }, append() {}, events: [] }
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
  return { runtime, record, rootSession, spawned, interrupts, leaderAgent }
}

const consolidation = (effort?: string) => ({
  problemAnalysis: ['现状：任务拆给专家与组员', '主要矛盾：质量与时间'],
  approach: ['专家做核心实现', '组员做证据'],
  approachBasis: ['第二轮分工基于第一轮全部梳理结果：质量与时间矛盾决定专家做核心实现、组员做证据。'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'low' },
    { member: 'Member-B', role: 'member', task: '整理验收证据清单' },
  ],
  ...(effort ? { taskReasoningEffort: effort } : {}),
})

/* ---------- R1：phase-1 重新 review 不得中断正在执行的回合 ---------- */

test('R1：首次 review 登记整体档（真 phase-0）⇒ 中断接续保留', async () => {
  const { runtime, interrupts, leaderAgent } = makeRuntime()
  const r = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation('xhigh') })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(interrupts.length, 1, 'phase-0 登记整体档必须中断以接续 phase-1（既有语义保留）')
  assert.deepEqual(interrupts[0], { childId: 'child-leader', parentId: 'session-root', mode: 'continuable' })
})

test('R1：已登记整体档后重新 review（phase-1）⇒ 绝不中断（缺陷根因修复）', async () => {
  const { runtime, record, interrupts, leaderAgent } = makeRuntime()
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation('xhigh') })
  assert.equal(interrupts.length, 1)
  assert.equal(record.statuses[0].effortOverride, 'xhigh', '整体档已登记（模拟已进入 phase-1）')
  // phase-1 负责人重新 review：同档、换档、不带档三种形态都不得中断。
  const same = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation('xhigh') })
  assert.equal(same.ok, true)
  const changed = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation('medium') })
  assert.equal(changed.ok, true)
  const inherit = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  assert.equal(inherit.ok, true)
  assert.equal(interrupts.length, 1, 'phase-1 重新 review 不得产生任何新中断（旧缺陷：无条件中断致子会话 aborted、台账停摆）')
  assert.equal(record.statuses[0].effortOverride, 'medium', '换档 review 仍正常更新整体档（只修中断，不修登记）')
})

/* ---------- R3：执行期进度心跳 ---------- */

test('R3：buildDispatchHeartbeat 文案——已用时/完成进度/执行中/不是卡死', () => {
  const text = buildDispatchHeartbeat(125000, 2, 5, 3)
  assert.match(text, /【派发执行中】/)
  assert.match(text, /2 分 5 秒/)
  assert.match(text, /完成 2\/5/)
  assert.match(text, /3 个子任务执行中/)
  assert.match(text, /不是卡死/)
  const zero = buildDispatchHeartbeat(0, 0, 3, 0)
  assert.match(zero, /0 秒/)
  assert.match(zero, /完成 0\/3/)
  assert.ok(!zero.includes('子任务执行中'), '无执行中子任务时不显示该段')
})

test('R3：心跳工厂 buildMessage 注入——假时钟周期触发、stop 收束、保险丝、中止静默', () => {
  const notices: string[] = []
  let tick: any = null
  let cleared = 0
  let clock = 1000
  const hb = createPlanningHeartbeat({
    appendNotice: (t: string) => notices.push(t),
    startedAt: 1000,
    maxAttempts: 1,
    intervalMs: 5000,
    now: () => clock,
    setTimer: (fn: () => void) => { tick = fn; return 1 },
    clearTimer: () => { cleared += 1 },
    buildMessage: (elapsed: number) => `自定义执行心跳 ${elapsed}ms`,
  })
  hb.start()
  assert.ok(tick, 'start 必须注册周期定时器')
  clock = 6000; tick()
  clock = 11000; tick()
  assert.deepEqual(notices, ['自定义执行心跳 5000ms', '自定义执行心跳 10000ms'], 'buildMessage 注入生效')
  hb.stop()
  assert.equal(cleared, 1, 'stop 必须清定时器（finally 收束纪律）')
  hb.stop()
  assert.equal(cleared, 1, '重复 stop 幂等')

  // 保险丝：maxNotices 上限后自动 stop。
  const fused: string[] = []
  let fuseTick: any = null
  const hb2 = createPlanningHeartbeat({
    appendNotice: (t: string) => fused.push(t),
    startedAt: 0, maxAttempts: 1, maxNotices: 2, intervalMs: 5000,
    setTimer: (fn: () => void) => { fuseTick = fn; return 1 },
    clearTimer: () => {},
    buildMessage: () => 'x',
  })
  hb2.start()
  fuseTick(); fuseTick(); fuseTick()
  assert.equal(fused.length, 2, 'maxNotices 保险丝防失控')

  // 中止信号：不再发通知。
  const aborted: string[] = []
  let abortTick: any = null
  const controller = new AbortController()
  const hb3 = createPlanningHeartbeat({
    signal: controller.signal,
    appendNotice: (t: string) => aborted.push(t),
    startedAt: 0, maxAttempts: 1, intervalMs: 5000,
    setTimer: (fn: () => void) => { abortTick = fn; return 1 },
    clearTimer: () => {},
    buildMessage: () => 'y',
  })
  hb3.start()
  controller.abort()
  abortTick()
  assert.equal(aborted.length, 0, '中止后心跳静默')
})

test('R3：dispatchPlan 接线源码锚定——start/finally stop/env 可调/唯一合规写入器', () => {
  const src = readFileSync(join(process.cwd(), 'src/runtime.ts'), 'utf8')
  const start = src.indexOf('export async function dispatchPlan')
  const end = src.indexOf('\nexport ', start + 10)
  const body = src.slice(start, end > start ? end : undefined)
  assert.match(body, /dispatchHeartbeat\.start\(\)/, '执行轮次开始必须启动心跳')
  assert.match(body, /dispatchHeartbeat\.stop\(\)/, 'finally 必须收束心跳')
  assert.ok(body.indexOf('dispatchHeartbeat.stop()') > body.indexOf('} finally {'), 'stop 必须在 finally 内')
  assert.match(body, /DSH_WORKPLAN_DISPATCH_HEARTBEAT_MS/, '间隔必须可经 env 调整')
  assert.match(body, /appendUserMessage\(dispatchHbSession/, '必须经唯一合规写入器')
  assert.match(body, /buildDispatchHeartbeat\(elapsedMs/, '文案必须用执行心跳纯函数')
})

/* ---------- R2：规划器默认档治本（源码锚定；行为验证留待真实规划） ---------- */

test('R2：规划器默认档=家族中等档（qwen=medium/非qwen=high），env 覆盖与家族白名单保留', () => {
  const src = readFileSync(join(process.cwd(), 'src/runtime.ts'), 'utf8')
  assert.match(src, /plannerModerateDefault = classifyModelFamily\(modelSelection\?\.model\) === 'qwen' \? 'medium' : 'high'/, '默认档必须是家族中等档，不再取最高档')
  assert.match(src, /plannerStaticAllowed\.includes\(plannerModerateDefault\)/, '中等档不在合法集时回落最高档（白名单语义不变）')
  assert.match(src, /DSH_WORKPLAN_PLANNER_REASONING_EFFORT/, 'env 显式覆盖保留')
  assert.match(src, /stall-fix/, '根因修复留痕')
})

/* ---------- 既有门禁语义不回归（冒烟） ---------- */

test('冒烟：主 Agent deepThink 门禁与叶子 self_effort+deepThink 门禁语义保持', async () => {
  const { runtime, leaderAgent, spawned } = makeRuntime()
  // 主 Agent 门禁：无 deepThink 的 dispatch 仍被硬拒（不启动子 Agent）。
  const rejected: any = await runtime.dispatchTool({ session: { id: 'session-root', header: { createdAt: 1000 } }, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'MAIN_DEEP_THINK_MISSING')
  assert.equal(spawned.length, 0)
  // 负责人 review 门禁：缺两轮产物仍被硬拒。
  const badReview = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: { problemAnalysis: ['梳理'], assignments: consolidation().assignments } })
  assert.equal(badReview.ok, false)
  assert.equal(badReview.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  // 叶子门禁：self_effort 缺 deepThink 仍被硬拒。
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const leaf = { session: { id: 'member-1', header: { parentSession: 'child-leader', cwd: '/tmp/stall-cwd' } }, options: { provider: 'qw', model: QWEN } }
  const noThink = await runtime.delegateTool(leaf, { action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '复杂' })
  assert.equal(noThink.ok, false)
  assert.equal(noThink.code, 'DEEP_THINK_MISSING')
  const withThink = await runtime.delegateTool(leaf, { action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '复杂', deepThink: MAIN_DEEP_THINK_FIXTURE })
  assert.equal(withThink.ok, true, JSON.stringify(withThink))
})