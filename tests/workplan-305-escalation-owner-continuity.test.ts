/*
 * [3.0.5] 用户改进方案 1/2 的机制回归：
 *  - 第三层专家遇阻必须先 dsh_workplan_escalate 给部门负责人；
 *  - 负责人答复前，dsh_workplan_delegate 的 review/dispatch/direct 一律硬拒，
 *    防止把问题改派、重派或降级给其他专家；
 *  - dsh_workplan_instruct 只能答复已经请示的原专家，投递成功后原专家继续执行；
 *  - 专家任务书把四步闭环写进提示词，且与 runtime 硬闸门同源。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkplanRuntime } from '../src/runtime.js'
import { createStatuses } from '../src/plan.js'
import { buildDelegateePrompt } from '../src/llm-rules.js'

function makeSession(id: string, parentSession?: string) {
  const events: any[] = []
  return {
    id,
    header: {
      createdAt: 1000,
      cwd: '/tmp/wp-305',
      ...(parentSession ? { parentSession } : {}),
    },
    get seq() { return events.length },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function consolidation() {
  return {
    problemAnalysis: ['现状：部门任务需要拆给专家；目标是保质保量完成；约束是不改无关文件；主要矛盾是质量与效率。'],
    constraints: ['不得改动无关文件'],
    unknowns: [],
    approach: ['专家先只读检查鉴权配置、请求头、时间戳与 token 刷新链路，定位接口 401 的具体根因；再用最小改动修复并补充回归验证，最后把证据和残余风险写清楚。'],
    approachBasis: ['第二轮方法基于第一轮梳理：主要矛盾是质量与效率，约束是不改无关文件，所以先根因后最小改动。'],
    assignments: [
      {
        member: 'Expert-A',
        role: 'expert',
        task: '定位接口 401 根因后最小修复',
        reasoningEffort: 'high',
        qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
      },
    ],
  } as any
}

function makeRuntime() {
  const plan: any = {
    planId: 'wp-305',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: '3.0.5 请示连续性',
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [], reasoningEffort: 'high' }],
    }],
  }
  const rootSession = makeSession('session-root')
  const leaderSession = makeSession('child-leader', 'session-root')
  const sent: any[] = []
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (request: any) => {
        const childId = 'child-Expert-A'
        leaderSession.append('subagent/catalog', { childId, label: request?.label })
        let releaseResult!: (value: any) => void
        const result = new Promise<any>((resolve) => { releaseResult = resolve })
        return { childId, result, releaseResult, dispose: async () => {} }
      },
      sendMessage: async (_agent: any, childId: string, parts: any[]) => {
        sent.push({ childId, text: String(parts?.[0]?.text ?? '') })
        return `msg-${sent.length}`
      },
    },
    sessions: {
      get: (id: string) => (id === 'session-root' ? rootSession : id === 'child-leader' ? leaderSession : undefined),
      list: () => [],
      eventAt: () => undefined,
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-3.0.5' })
  const statuses = createStatuses(plan) as any[]
  statuses[0].status = 'in_progress'
  statuses[0].childId = 'child-leader'
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set('session-root', record)
  const leaderAgent = { session: leaderSession, options: { provider: 'openai', model: 'gpt-5' } }
  const leafAgent = { session: makeSession('child-Expert-A', 'child-leader'), options: { provider: 'openai', model: 'gpt-5' } }
  return { runtime, record, rootSession, leaderSession, leaderAgent, leafAgent, sent }
}

test('3.0.5：专家请示后禁止改派，负责人答复后必须原专家继续执行', async () => {
  const { runtime, record, leaderAgent, leafAgent } = makeRuntime()

  const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  assert.equal(review.ok, true, JSON.stringify(review))
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))

  const tooEarly = await runtime.instructTool(leaderAgent, {
    subtaskId: 'T1',
    member: 'Expert-A',
    instruction: '先用 B 方案',
  })
  assert.equal(tooEarly.ok, false)
  assert.equal(tooEarly.code, 'NOT_ESCALATED', '未请示的成员不能接收指示，更不能被当作替代人选')

  const escalation = await runtime.escalateTool(leafAgent, {
    question: '接口返回 401，需要确认用 A 方案还是 B 方案',
    options: ['A 方案', 'B 方案'],
  })
  assert.equal(escalation.ok, true, JSON.stringify(escalation))
  assert.equal(escalation.routedTo, 'head')

  const row = record.statuses[0]
  assert.equal(row.delegates[0].closure, 'escalated', '第三层请示必须显式落在 delegates 台账')
  assert.equal(row.delegates[0].blockedKind, 'escalated')
  assert.match(row.delegates[0].escalation.question, /401/)

  const status = await runtime.delegateTool(leaderAgent, { action: 'status' })
  assert.equal(status.ok, true)
  assert.deepEqual(status.openEscalations, ['Expert-A'], '负责人读取面必须列出待指示成员')

  for (const action of ['dispatch', 'review', 'direct'] as const) {
    const blocked = await runtime.delegateTool(leaderAgent, { action })
    assert.equal(blocked.ok, false, `${action} 在待指示期间必须硬拒`)
    assert.equal(blocked.code, 'DELEGATE_ESCALATION_OPEN')
    assert.match(blocked.error, /禁止改派/)
    assert.match(blocked.hint, /dsh_workplan_instruct/)
  }

  const instructed = await runtime.instructTool(leaderAgent, {
    subtaskId: 'T1',
    member: 'Expert-A',
    instruction: '用 B 方案，并保持现有鉴权头不变。',
  })
  assert.equal(instructed.ok, true, JSON.stringify(instructed))
  const after = record.statuses[0].delegates[0]
  assert.equal(after.closure, 'instructed')
  assert.equal(after.status, 'running', '原专家恢复执行，不换人')
  assert.ok(!after.escalation, '请示答复后清除 escalation')

  const repeat = await runtime.instructTool(leaderAgent, {
    subtaskId: 'T1',
    member: 'Expert-A',
    instruction: '再补充一条',
  })
  assert.equal(repeat.ok, false)
  assert.equal(repeat.code, 'NOT_ESCALATED', '已答复成员不能再次按请示通道接收指示')
})

test('3.0.5：专家任务书写清四步闭环和禁止改派', () => {
  const prompt = buildDelegateePrompt({
    departmentLabel: '工程研发',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '部门任务',
    member: consolidation().assignments[0],
    rulesBrief: '',
    cwd: '/tmp/wp-305',
  })
  assert.match(prompt, /你先向部门负责人报告具体问题/)
  assert.match(prompt, /负责人全面梳理你的问题与本部门全部已派发任务执行状态/)
  assert.match(prompt, /负责人用 dsh_workplan_instruct 把方案告诉你/)
  assert.match(prompt, /禁止负责人在你待指示期间把你改派给其他专家/)
})
