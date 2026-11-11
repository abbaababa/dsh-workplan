/*
 * [2.5.0] 用户要求 1/2/3 的底层机制回归。
 *
 * 要求 1（根因修复）：部门负责人任务书不得再出现「你没有派发权限」这类与
 *   dsh_workplan_delegate 授权矛盾的禁令；必须明确授予本部门内再分配权限。
 * 要求 2（全程贯穿）：负责人经 consolidation.taskReasoningEffort 配置整体
 *   等级 → 状态行 effortOverride（消毒 + durable 回放 + 重置不清除）→ 派发链
 *   resolveTaskEffort 每次激活优先读它 → 下级未配档时继承它。
 * 要求 3（更简单、多人承担）：规划器提示词含「更简单/单一目标」硬规则；
 *   分工表 expert+member 各至少 1 名、最多 6 人的既有门禁不变。
 * 要求 5：版本声明统一 2.5.0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyStatus,
  buildChildPrompt,
  buildPlannerPrompt,
  buildUpdateMessage,
  createStatuses,
  parseUpdateMessage,
} from '../src/plan.js'
import { planDelegations, resolveTaskEffort } from '../src/llm-rules.js'
import { createWorkplanRuntime } from '../src/runtime.js'

const QWEN = 'qwen3-max-preview'

function assignments(extra: any[] = []) {
  return [
    { member: '专家甲', role: 'expert', task: '实现核心逻辑并附单测', ...extra[0] },
    { member: '组员乙', role: 'member', task: '整理验收证据清单', ...extra[1] },
  ]
}

function consolidation(overrides: any = {}) {
  return {
    problemAnalysis: ['现状：部门任务需要拆给专家与组员', '主要矛盾：质量与时间'],
    approach: ['专家做实现', '组员做证据'],
    approachBasis: ["第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据，约束决定不改无关文件。"],
    assignments: assignments(),
    ...overrides,
  }
}

test('要求2：整体任务等级按模型家族钳制并留痕（qwen high→medium）', () => {
  const plan = planDelegations({ consolidation: consolidation({ taskReasoningEffort: 'high' }), model: QWEN })
  assert.equal(plan.ok, true)
  assert.equal(plan.taskEffort, 'medium')
  assert.equal(plan.taskEffortClamped?.requested, 'high')
  assert.equal(plan.taskEffortClamped?.corrected, 'medium')
})

test('要求2：下级未单独配档时继承整体等级；显式配档优先；无整体配置回落 low', () => {
  const inherited = planDelegations({ consolidation: consolidation({ taskReasoningEffort: 'xhigh' }), model: QWEN })
  assert.equal(inherited.ok, true)
  assert.deepEqual(inherited.members.map((m) => m.effort), ['xhigh', 'xhigh'])
  const explicit = planDelegations({
    consolidation: consolidation({
      taskReasoningEffort: 'xhigh',
      assignments: assignments([{ reasoningEffort: 'low' }, {}]),
    }),
    model: QWEN,
  })
  assert.deepEqual(explicit.members.map((m) => m.effort), ['low', 'xhigh'])
  const noTask = planDelegations({ consolidation: consolidation(), model: QWEN })
  assert.deepEqual(noTask.members.map((m) => m.effort), ['low', 'low'])
  assert.equal(noTask.taskEffort, null)
})

test('要求2：非法整体等级明确拒绝（A3 报错轨），不改写不静默', () => {
  const plan = planDelegations({ consolidation: consolidation({ taskReasoningEffort: 'ultra' }), model: QWEN })
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_TASK_EFFORT_INVALID')
})

test('要求2：resolveTaskEffort 单一判据——override 优先、非法回落、缺省 high', () => {
  assert.equal(resolveTaskEffort({ override: 'low', planned: 'max' }), 'low')
  assert.equal(resolveTaskEffort({ override: 'bogus', planned: 'medium' }), 'medium')
  assert.equal(resolveTaskEffort({ override: null, planned: undefined }), 'high')
  assert.equal(resolveTaskEffort({}), 'high')
})

test('要求2：effortOverride 消毒入库、durable 回放不丢、尝试重置不清除', () => {
  const plan: any = {
    planId: 'wp-250', sessionId: 's', createdTurn: 1, createdAt: 1, title: 't',
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [] }] }],
  }
  let rows: any = createStatuses(plan)
  rows = applyStatus(rows, 'T1', { effortOverride: 'medium', updatedBy: 'child' })
  assert.equal(rows[0].effortOverride, 'medium')
  assert.throws(() => applyStatus(rows, 'T1', { effortOverride: 'ultra' }), /effortOverride/)
  // durable workplan-update 消息回放后仍在。
  const message = buildUpdateMessage({ planId: 'wp-250', subtaskId: 'T1', status: 'in_progress', effortOverride: 'medium', revision: 2 })
  const parsed: any = parseUpdateMessage(message)
  assert.equal(parsed.effortOverride, 'medium')
  let replayed: any = applyStatus(createStatuses(plan), 'T1', parsed)
  assert.equal(replayed[0].effortOverride, 'medium')
  // pending 重置（重试/续跑）不清除任务级配置；consolidation 痕迹仍清除。
  replayed = applyStatus(replayed, 'T1', { status: 'pending' })
  assert.equal(replayed[0].effortOverride, 'medium')
  // null 显式清除合法。
  replayed = applyStatus(replayed, 'T1', { effortOverride: null })
  assert.equal(replayed[0].effortOverride, null)
})

test('要求1/3：负责人任务书授予再分配权限，不再含矛盾禁令；规划器要求更简单', () => {
  const subtask: any = {
    id: 'T1', title: '部门任务', department: 'engineering', role: '资深架构师',
    objective: '完成机制改造', method: ['改代码'], inputs: [], outputs: ['补丁'],
    acceptance: ['有单测证据'], risk: '无', dependsOn: [],
  }
  const prompt = buildChildPrompt({
    plan: { taskUnderstanding: { originalRequest: '优化插件', deliverable: '补丁' }, contradictions: {} },
    subtask,
    stage: { id: 'S1', name: '实施', goal: '改造', rationale: '', checkpoint: '' },
    dependencyResults: [],
    cwd: '/tmp',
  })
  assert.ok(prompt.includes('本部门再分配权限'))
  assert.ok(prompt.includes('dsh_workplan_delegate'))
  assert.ok(!prompt.includes('你没有派发权限'))
  assert.ok(!prompt.includes('不要派生新的 Agent'))
  assert.ok(prompt.includes('taskReasoningEffort'))
  assert.ok(prompt.includes('单一目标'))
  const planner = buildPlannerPrompt('优化插件底层机制', '/tmp', '', {})
  assert.ok(planner.includes('分解必须更简单'))
  assert.ok(planner.includes('多名相关领域全球顶尖专家与组员'))
  assert.ok(planner.includes('再分配权限'))
})

function makeRuntime(model: string) {
  const plan: any = {
    planId: 'wp-250-rt', sessionId: 'session-root', createdTurn: 1, createdAt: 1000, title: '三层派发',
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [] }] }],
  }
  const events: any[] = []
  const rootSession: any = {
    id: 'session-root',
    header: { createdAt: 1000, cwd: '/tmp/delegate-cwd' },
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
  runtime.state.records.set('session-root', { plan, statuses, updatedAt: 0, errors: [], notices: [] })
  const leaderAgent = {
    session: { id: 'child-leader', header: { parentSession: 'session-root', cwd: '/tmp/delegate-cwd' } },
    options: { provider: 'qw', model },
  }
  return { runtime, spawned, leaderAgent, rootSession }
}

test('要求2 端到端：review 配置整体等级 → 状态行 effortOverride → dispatch 下级继承', async () => {
  const { runtime, spawned, leaderAgent } = makeRuntime(QWEN)
  const review = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: consolidation({ taskReasoningEffort: 'high' }),
  })
  assert.equal(review.ok, true)
  assert.equal(review.taskEffort, 'medium')
  const record = runtime.state.records.get('session-root')
  assert.equal(record.statuses[0].effortOverride, 'medium')
  assert.equal(record.statuses[0].consolidation.taskReasoningEffort, 'medium')
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true)
  assert.equal(dispatch.effortOverride, 'medium')
  assert.equal(spawned.length, 2)
  for (const child of spawned) {
    // [2.5.0][自配档] 继承降为旧计划兼容：叶子 phase-0 一律 low 启动，自配经 self_effort 接续。
    assert.equal(child.request.request.agentOptions.reasoningEffort, 'low')
    assert.match(child.request.request.prompt[0].text, /self_effort/, 'phase-0 任务书必须写明自配义务')
  }
  const status = await runtime.delegateTool(leaderAgent, { action: 'status' })
  assert.equal(status.effortOverride, 'medium')
})

test('要求5：版本声明统一 2.5.1（2.5.0 断言随定版升级）', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(pkg.version, '2.5.1')
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/tool-surface.json'), 'utf8'))
  assert.equal(fixture.version, '2.5.1')
})
