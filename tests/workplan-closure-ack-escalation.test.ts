/*
 * [1.11.0] T6 的回归：派发回执（acknowledged）与遇阻升级（escalated / blocked）。
 *
 * 这里锁的是「契约里可被代码断言的部分」，不是某一段实现细节：
 *  - `CLOSURES` 必须包含闭环用到的全部阶段（S2–S7），否则历史日志会被
 *    降级成 pending，看板把「在等人回答」显示成「还没开始」；
 *  - `applyStatus` 是唯一写入口，acknowledged / blocked / escalated 都必须
 *    能在这里落字段，且非法组合要被拒绝（escalated 必须投影成 blocked）；
 *  - 旧日志没有 `closure` 时必须降级为 null，而不是猜一个阶段；
 *  - 请示必须能随 durable update 消息回放，刷新后不退回 pending；
 *  - 子 Agent 提示词必须能检索到「遇阻先上报」这一段（P-01/P-05）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createEscalateTool,
  createInstructTool,
  PROMPT_SECTION,
} from '../src/host.js'
import {
  CLOSURES,
  applyStatus,
  buildChildPrompt,
  buildUpdateMessage,
  createStatuses,
  normaliseStatusEntry,
  parseUpdateMessage,
} from '../src/plan.js'

function makePlan() {
  return {
    planId: 'wp-closure',
    sessionId: 'session-closure',
    createdTurn: 1,
    createdAt: 1000,
    title: '闭环回归',
    stages: [{ id: 'S1', subtasks: [{ id: 'T1', title: '第1步', department: 'engineering' }] }],
  }
}

function seeded() {
  return createStatuses(makePlan())
}

test('CLOSURES 覆盖闭环每一个阶段（缺一个就会把该阶段降级成 pending）', () => {
  for (const closure of ['pending', 'assigned', 'acknowledged', 'instructed', 'escalated', 'blocked', 'done', 'reported', 'replanned']) {
    assert.ok(CLOSURES.includes(closure), `CLOSURES 缺少 ${closure}`)
  }
})

test('S2→S3：派发写入 assigned，首次进度写入 acknowledged（回执写入点）', () => {
  const assignedAt = 1_700_000_000_000
  let statuses: any = seeded()
  statuses = applyStatus(statuses, 'T1', {
    status: 'in_progress',
    closure: 'assigned',
    childId: 'child-1',
    progress: 10,
    assignedAt,
    ackedAt: null,
  })
  let row: any = statuses[0]
  assert.equal(row.status, 'in_progress')
  assert.equal(row.closure, 'assigned')
  assert.equal(row.assignedAt, assignedAt)
  assert.equal(row.ackedAt, null)

  // 子会话 seq 首次增长 → 回执。这是 S3 的唯一写入形态。
  statuses = applyStatus(statuses, 'T1', {
    closure: 'acknowledged',
    ackedAt: assignedAt + 4200,
    ackEvidence: { seq: 7, elapsedMs: 4200 },
    progress: 15,
  })
  row = statuses[0]
  assert.equal(row.status, 'in_progress', 'acknowledged 仍投影为 in_progress')
  assert.equal(row.closure, 'acknowledged')
  assert.equal(row.ackedAt, assignedAt + 4200)
  assert.deepEqual(row.ackEvidence, { seq: 7, elapsedMs: 4200 })
})

test('S6：无回执硬超时写 blocked + blockedKind=no-ack（缺回执兜底写入点）', () => {
  let statuses: any = seeded()
  statuses = applyStatus(statuses, 'T1', {
    status: 'in_progress',
    closure: 'assigned',
    childId: 'child-1',
    progress: 10,
    assignedAt: 1_700_000_000_000,
  })
  // B1：先只标逾期，不降级 status —— 「已下发未响应」是可观察状态，不是失败。
  statuses = applyStatus(statuses, 'T1', { ackOverdue: true })
  assert.equal(statuses[0].status, 'in_progress')
  assert.equal(statuses[0].ackOverdue, true)

  // B2：硬超时仍零增长 → blocked（no-ack），不是静默等待。
  statuses = applyStatus(statuses, 'T1', {
    status: 'blocked',
    closure: 'blocked',
    blockedKind: 'no-ack',
    error: '已下发 180s 无回执',
    finishedAt: 1_700_000_180_000,
  })
  assert.equal(statuses[0].status, 'blocked')
  assert.equal(statuses[0].closure, 'blocked')
  assert.equal(statuses[0].blockedKind, 'no-ack')
})

test('S4：escalated 只能投影成 blocked，且 question 必须落盘', () => {
  let statuses: any = seeded()
  statuses = applyStatus(statuses, 'T1', {
    status: 'blocked',
    closure: 'escalated',
    blockedKind: 'escalated',
    question: '需要主 Agent 决定：是否允许跳过缺失的第三方凭证？',
    options: ['跳过并标注未验证', '改为离线样本'],
    escalatedAt: 1_700_000_100_000,
    escalationSeq: 3,
  })
  const row: any = statuses[0]
  assert.equal(row.status, 'blocked')
  assert.equal(row.closure, 'escalated')
  assert.equal(row.blockedKind, 'escalated')
  assert.match(String(row.question), /第三方凭证/)
  assert.deepEqual(row.options, ['跳过并标注未验证', '改为离线样本'])

  // 投影表禁止 in_progress + escalated：那会显示「正在做」而实际没人跑。
  assert.throws(() => applyStatus(seeded(), 'T1', {
    status: 'in_progress',
    closure: 'escalated',
    question: 'x',
  }), /escalated/)

  assert.throws(
    () => applyStatus(seeded(), 'T1', { closure: 'waiting' }),
    (error: any) => error?.code === 'INVALID_CLOSURE',
  )
  assert.throws(
    () => applyStatus(seeded(), 'T1', { status: 'blocked', blockedKind: 'nonsense' }),
    (error: any) => error?.code === 'INVALID_BLOCKED_KIND',
  )
})

test('向后兼容：1.10.6 的旧条目没有 closure 时降级为 null，不猜阶段', () => {
  const legacy: any = normaliseStatusEntry({ subtaskId: 'T1', status: 'blocked', progress: 40, error: '旧失败' })
  assert.equal(legacy.status, 'blocked')
  assert.equal(legacy.closure, null)
  assert.equal(legacy.error, '旧失败')

  const unknown: any = normaliseStatusEntry({ subtaskId: 'T1', status: 'blocked', closure: 'escalated-v2' })
  assert.equal(unknown.closure, null, '未知 closure 不能猜成某个已知阶段')
})

test('请示可回放：durable update 消息带 closure/question，刷新后仍是待指示', () => {
  const message = buildUpdateMessage({
    planId: 'wp-closure',
    subtaskId: 'T1',
    status: 'blocked',
    closure: 'escalated',
    blockedKind: 'escalated',
    question: '需要主 Agent 决定接口版本',
    options: ['v1', 'v2'],
    escalatedAt: 1_700_000_100_000,
    escalationSeq: 2,
    note: '待指示',
  })
  const parsed: any = parseUpdateMessage(message)
  assert.ok(parsed, 'update 消息必须可解析')
  assert.equal(parsed.closure, 'escalated')
  assert.equal(parsed.question, '需要主 Agent 决定接口版本')
  assert.deepEqual(parsed.options, ['v1', 'v2'])
  assert.equal(parsed.escalationSeq, 2)
})

test('提示词可检索：子 Agent 被明确要求「遇阻先上报，再等待指示」', () => {
  const plan = makePlan()
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp/work',
  })
  assert.match(prompt, /遇阻上报（强制，先于继续动作）/)
  assert.match(prompt, /dsh_workplan_escalate/)
  assert.match(prompt, /停止推进，只做只读核对/)
  assert.match(prompt, /"question":"\.\.\."/, '结果块必须有 question 兜底字段')
})

/*
 * 工具必须真的接到 runtime 上：只写 runtime 函数而忘了 host 注册，是这类
 * 通道最常见的“看起来做完”的失败形态——提示词让子 Agent 调一个不存在的
 * 工具，模型会转而静默继续，闭环当场断掉。
 */
test('dsh_workplan_escalate / dsh_workplan_instruct 已接到 runtime 的写入口', async () => {
  const calls: any[] = []
  const runtime: any = {
    escalateTool: async (agent: any, args: any) => {
      calls.push({ tool: 'escalate', agent, args })
      return { ok: true, subtaskId: 'T1', question: args.question }
    },
    instructTool: async (agent: any, args: any, signal: any) => {
      calls.push({ tool: 'instruct', agent, args, signal })
      return { ok: true, subtaskId: args.subtaskId, revision: 2, messageId: 'm-1' }
    },
  }
  const agent = { session: { id: 'child-1' } }
  const escalate = createEscalateTool(runtime)
  const instruct = createInstructTool(runtime)
  assert.equal(escalate.name, 'dsh_workplan_escalate')
  assert.equal(instruct.name, 'dsh_workplan_instruct')

  const escalated: any = await escalate.execute({ subtaskId: 'T1', question: '用 v1 还是 v2？' }, { agent })
  assert.equal(escalated.ok, true)
  assert.equal(calls[0].tool, 'escalate')
  assert.equal(calls[0].args.question, '用 v1 还是 v2？')
  assert.match(String(escalate.output.render({}, escalated)[0].text), /待指示/)

  const instructed: any = await instruct.execute(
    { subtaskId: 'T1', instruction: '用 v2，并保留 v1 的兼容层' },
    { agent: { session: { id: 'root' } }, signal: 'sig' },
  )
  assert.equal(instructed.ok, true)
  assert.equal(calls[1].tool, 'instruct')
  assert.equal(calls[1].signal, 'sig')
  assert.match(String(instruct.output.render({}, instructed)[0].text), /已收到指示/)
})

test('主 Agent 提示词写明：待指示项必须当轮处理（instruct 或明确放弃）', () => {
  assert.match(String(PROMPT_SECTION), /待指示/)
  assert.match(String(PROMPT_SECTION), /dsh_workplan_instruct/)
  assert.match(String(PROMPT_SECTION), /ackOverdue/)
})
