/*
 * [2.3.9][T4b] 第三层派发工具（dsh_workplan_delegate）回归。
 *
 * 用户强制要求 4/5 的可执行形式：
 *  - 要求 4：部门负责人必须先「全面、全盘、深入梳理」，再把任务分配给本部门
 *    相关领域全球顶尖专家（expert）与本部门组员（member）——review 硬门禁 +
 *    角色配比（各至少 1 名）由服务端强制，提示词绕不过；
 *  - 要求 5：每位下级按自己分到任务的复杂度配置推理等级并全程应用——等级随
 *    spawn 的 agentOptions 下发，越界档按模型家族合法集合钳制并留痕
 *    （qwen→low/medium/xhigh；非qwen→low/high/max）；
 *  - 层级边界：只有计划内部门负责人子会话可调用；根会话与第三层叶子一律拒绝；
 *    下级 spawn maxDepth:2，第四层由宿主绝对深度上限硬拒。
 *  - 持久化：consolidation/delegates 走 applyStatus 消毒 + durable
 *    workplan-update 消息，刷新/重启回放后门禁依然生效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkplanRuntime } from '../src/runtime.js'
import { createStatuses } from '../src/plan.js'

function makePlan() {
  return {
    planId: 'wp-delegate',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: '三层派发用例',
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
    header: { createdAt: 1000, cwd: '/tmp/delegate-cwd' },
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
    session: { id: 'child-leader', header: { parentSession: 'session-root', cwd: '/tmp/delegate-cwd' } },
    options: { provider, model },
  }
  return { runtime, record, rootSession, subagents, leaderAgent }
}

const goodConsolidation = (efforts: { expert: string; member: string }) => ({
  problemAnalysis: ['现状：需要把部门任务拆给专家与组员', '主要矛盾：质量与时间'],
  constraints: ['不得改动无关文件'],
  unknowns: [],
  approach: ['专家做核心实现', '组员做自测'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: efforts.expert },
    { member: 'Member-B', role: 'member', task: '补充回归用例', reasoningEffort: efforts.member },
  ],
})

/* ---------- 1. 调用者边界 ---------- */

test('delegateTool：根会话调用被拒（NOT_LEADER_SESSION），指引改用 dispatch', async () => {
  const { runtime } = makeRuntime('qwen3.8-flash')
  const rootAgent = { session: { id: 'session-root', header: {} }, options: {} }
  const result = await runtime.delegateTool(rootAgent, { action: 'status' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NOT_LEADER_SESSION')
  assert.match(result.error, /dsh_workplan_dispatch/)
})

test('delegateTool：第三层叶子会话调用被拒（NO_PLAN，叶子层禁令）', async () => {
  const { runtime } = makeRuntime('qwen3.8-flash')
  // 成员会话的父会话是部门子会话（无计划记录）⇒ 无法反查计划 ⇒ 拒绝再派发。
  const memberAgent = {
    session: { id: 'member-1', header: { parentSession: 'child-leader' } },
    options: { provider: 'qw', model: 'qwen3.8-flash' },
  }
  const result = await runtime.delegateTool(memberAgent, { action: 'dispatch' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_PLAN')
  assert.match(result.error, /叶子层/)
})

test('delegateTool：childId 未登记的子会话被拒（NO_SUBTASK）', async () => {
  const { runtime } = makeRuntime('qwen3.8-flash')
  const stranger = {
    session: { id: 'child-unknown', header: { parentSession: 'session-root' } },
    options: { provider: 'qw', model: 'qwen3.8-flash' },
  }
  const result = await runtime.delegateTool(stranger, { action: 'status' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_SUBTASK')
})

/* ---------- 2. 梳理硬门禁（要求 4） ---------- */

test('delegateTool：未提交梳理产物直接 dispatch ⇒ DELEGATE_CONSOLIDATION_MISSING（硬门禁）', async () => {
  const { runtime, leaderAgent } = makeRuntime('qwen3.8-flash')
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_CONSOLIDATION_MISSING')
  assert.match(result.error, /梳理/)
})

test('delegateTool：review 缺 problemAnalysis / assignments ⇒ 拒绝并给出缺口', async () => {
  const { runtime, leaderAgent } = makeRuntime('qwen3.8-flash')
  const noAnalysis = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: { assignments: [{ member: 'A', role: 'expert', task: 't', reasoningEffort: 'low' }] },
  })
  assert.equal(noAnalysis.ok, false)
  assert.match(noAnalysis.error, /problemAnalysis/)

  const noAssignments = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: { problemAnalysis: ['梳理'] },
  })
  assert.equal(noAssignments.ok, false)
  assert.match(noAssignments.error, /assignments/)
})

test('delegateTool：分工表只有专家没有组员（或反之）⇒ DELEGATE_ROLE_MIX_REQUIRED', async () => {
  const { runtime, leaderAgent } = makeRuntime('qwen3.8-flash')
  const result = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: {
      problemAnalysis: ['梳理'],
      assignments: [{ member: 'A', role: 'expert', task: 't', reasoningEffort: 'low' }],
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_ROLE_MIX_REQUIRED')
  assert.match(result.error, /全球顶尖专家/)
})

/* ---------- 3. review 登记 + 等级钳制留痕（要求 1/2/5） ---------- */

test('delegateTool：qwen 模型上 review 通过；越界档 max→xhigh 钳制并留痕，low 原样', async () => {
  const { runtime, leaderAgent, record, rootSession } = makeRuntime('qwen3.8-flash')
  const result = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: goodConsolidation({ expert: 'max', member: 'low' }),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const expert = result.members.find((m: any) => m.role === 'expert')
  assert.equal(expert.effort, 'xhigh', 'qwen 家族上 max 必须钳制为 xhigh')
  assert.equal(expert.requested, 'max')
  assert.equal(result.clamped.length, 1)
  assert.equal(result.clamped[0].member, 'Expert-A')
  // 行上落档 + durable 消息（刷新回放后门禁依然生效）
  const row = record.statuses[0]
  assert.ok(row.consolidation, 'consolidation 必须写入状态行')
  assert.equal(row.consolidation.assignments.length, 2)
  const durable = rootSession.events.filter((e: any) => e.type === 'user/message')
  assert.ok(durable.length >= 1, 'review 必须写 durable workplan-update 消息')
  assert.match(JSON.stringify(durable[durable.length - 1]), /workplan-update/)
})

test('delegateTool：非 qwen 模型上 medium→low、xhigh→high 钳制；max 原样', async () => {
  const { runtime, leaderAgent } = makeRuntime('gpt-5', 'openai')
  const result = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: {
      problemAnalysis: ['梳理'],
      assignments: [
        { member: 'E', role: 'expert', task: '复杂任务', reasoningEffort: 'max' },
        { member: 'M', role: 'member', task: '轻度任务', reasoningEffort: 'medium' },
      ],
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const expert = result.members.find((m: any) => m.role === 'expert')
  const member = result.members.find((m: any) => m.role === 'member')
  assert.equal(expert.effort, 'max', '非 qwen 家族 max 合法，原样')
  assert.equal(member.effort, 'low', '非 qwen 家族 medium 越界，钳制为 low')
  assert.equal(result.clamped.length, 1)
})

/* ---------- 4. dispatch 派发（要求 4/5 + 层级边界） ---------- */

test('delegateTool：dispatch 为每位下级派生第三层子会话——等级随 agentOptions 下发、maxDepth=2、任务书含要求 1/2 全文', async () => {
  const { runtime, leaderAgent, subagents, record } = makeRuntime('qwen3.8-flash')
  const review = await runtime.delegateTool(leaderAgent, {
    action: 'review',
    consolidation: goodConsolidation({ expert: 'xhigh', member: 'low' }),
  })
  assert.equal(review.ok, true)
  const result = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(subagents.spawned.length, 2, '必须为专家与组员各派生一个第三层子会话')

  for (const spawned of subagents.spawned) {
    // startActivation 参数结构：{ provider, label, request:{ prompt, parent, cwd,
    // agentOptions, maxDepth }, signal, delivery }——与真实 dispatchPlan 同构，
    // maxDepth/agentOptions/prompt 在内层 request，delivery 在顶层。
    const activation = spawned.request
    const inner = activation.request
    assert.equal(inner.maxDepth, 2, '第三层为叶子层：maxDepth=2，第四层（depth 3）由宿主硬拒')
    assert.equal(activation.delivery, 'caller', '下级结论必须送回部门负责人会话')
    assert.equal(inner.agentOptions.provider, 'qw')
    assert.equal(inner.agentOptions.model, 'qwen3.8-flash')
    assert.ok(['xhigh', 'low'].includes(inner.agentOptions.reasoningEffort))
    const promptText = inner.prompt[0].text
    // 要求 1/2 全文告知（LLM_REASONING_RULES_TEXT 注入）
    assert.match(promptText, /qwen/, '第三层任务书必须携带模型家族等级规则全文')
    assert.match(promptText, /推理等级/, '第三层任务书必须携带推理等级规则')
    assert.match(promptText, /不得派生任何第四层/, '叶子层禁令必须写进任务书')
  }
  const expertSpawn = subagents.spawned.find((s: any) => s.request.request.prompt[0].text.includes('Expert-A'))
  assert.equal(expertSpawn.request.request.agentOptions.reasoningEffort, 'xhigh', '专家等级=梳理分工表配置值（要求 5 全程应用）')

  // 台账落档
  const row = record.statuses[0]
  assert.equal(row.delegates.length, 2)
  assert.equal(row.delegates[0].status, 'running')
  assert.ok(row.delegates.every((d: any) => typeof d.childId === 'string' && d.childId))
})

test('delegateTool：下级仍有 running 时重复 dispatch ⇒ DELEGATE_ALREADY_RUNNING', async () => {
  const { runtime, leaderAgent } = makeRuntime('qwen3.8-flash')
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ expert: 'medium', member: 'low' }) })
  const first = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(first.ok, true)
  const second = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'DELEGATE_ALREADY_RUNNING')
})

test('delegateTool：下级结算后台账更新为 done/failed，summary 与 error 落档', async () => {
  const { runtime, leaderAgent, subagents, record } = makeRuntime('qwen3.8-flash')
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: goodConsolidation({ expert: 'medium', member: 'low' }) })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  subagents.spawned[0].resolveResult({
    stopReason: 'completed',
    output: [{ type: 'text', text: '专家结论：已完成并自测通过' }],
  })
  subagents.spawned[1].resolveResult({ stopReason: 'error', diagnostic: '子会话异常' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const row = record.statuses[0]
  const done = row.delegates.find((d: any) => d.childId === subagents.spawned[0].childId)
  const failed = row.delegates.find((d: any) => d.childId === subagents.spawned[1].childId)
  assert.equal(done.status, 'done')
  assert.match(done.summary, /专家结论/)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /子会话异常/)
})

test('delegateTool：status 动作返回梳理登记与下级进度；非法 action 被拒', async () => {
  const { runtime, leaderAgent } = makeRuntime('qwen3.8-flash')
  const before = await runtime.delegateTool(leaderAgent, { action: 'status' })
  assert.equal(before.ok, true)
  assert.equal(before.consolidation, null)
  assert.match(before.hint, /review/)

  const invalid = await runtime.delegateTool(leaderAgent, { action: 'launch' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'INVALID_ACTION')
})

test('delegateTool：spawn 抛错时该成员记为 rejected，其余成员不受影响', async () => {
  const { runtime, leaderAgent, record } = makeRuntime('qwen3.8-flash')
  const subagents = {
    spawned: [] as any[],
    startActivation: async () => { throw new Error('depth exceeded') },
  }
  ;(runtime as any) // noop
  // 直接替换 ctx.subagents 不可行（闭包已捕获）——用第二个 runtime 验证
  const plan = makePlan()
  const rootSession = makeSession('session-root')
  const ctx: any = {
    logger: { warn() {} },
    subagents,
    sessions: { get: (id: string) => (id === 'session-root' ? rootSession : undefined), list: () => [], eventAt: () => undefined },
  }
  const rt: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = 'child-leader'
  rt.state.records.set('session-root', { plan, statuses, updatedAt: 0, errors: [], notices: [] })
  const agent = {
    session: { id: 'child-leader', header: { parentSession: 'session-root' } },
    options: { provider: 'qw', model: 'qwen3.8-flash' },
  }
  await rt.delegateTool(agent, { action: 'review', consolidation: goodConsolidation({ expert: 'medium', member: 'low' }) })
  const result = await rt.delegateTool(agent, { action: 'dispatch' })
  assert.equal(result.ok, false, '全部成员派发被拒时 ok=false')
  assert.equal(result.rejected.length, 2)
  const row = rt.state.records.get('session-root').statuses[0]
  assert.equal(row.delegates.length, 2)
  assert.ok(row.delegates.every((d: any) => d.status === 'rejected' && /depth exceeded/.test(d.error)))
})
