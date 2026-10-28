import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_PLAN_JSON_CHARS,
  MAX_SUBTASKS,
  PLAN_MARKER_BEGIN,
  applyResultStatuses,
  applyStatus,
  buildChildPrompt,
  buildCancelMessage,
  buildPlanMessage,
  buildPlannerPrompt,
  buildResultMessage,
  computeStats,
  createStatuses,
  extractJson,
  isSocialMessage,
  isStatusQuestion,
  isVagueContinuation,
  markDependentsBlocked,
  messageText,
  readySubtasks,
  nextReadyInStage,
  parseResultMessage,
  parseCancelMessage,
  parseWorkplanMessage,
  planPhase,
  validatePlan,
} from '../src/plan.js'

import { dispatchPlan } from '../src/runtime.js'

function validPlan() {
  return {
    version: 1,
    title: '验证一个需求',
    taskUnderstanding: {
      originalRequest: '请验证这个需求是否可行',
      deliverable: '一份验证报告',
      successCriteria: ['报告给出可复现的证据'],
      constraints: ['不要修改业务代码'],
      knownFacts: ['用户要求验证可行性'],
      unknowns: ['现有测试覆盖率未知'],
      assumptions: ['验证环境可用'],
    },
    contradictions: {
      primary: {
        statement: '验证深度与时间成本之间的矛盾',
        evidence: ['任务要求证据，但时间有限'],
        whyPrimary: '证据不足会导致结论不可信',
      },
      secondary: ['环境差异可能影响结论'],
      transformationConditions: ['如果获得可复现环境，次要矛盾上升'],
    },
    stages: [
      {
        id: 'S1',
        name: '准备',
        goal: '明确验证范围',
        rationale: '先界定范围避免无效工作',
        checkpoint: '范围获得确认',
        subtasks: [
          {
            id: 'T1',
            title: '梳理验证范围',
            department: 'research',
            role: '需求分析',
            objective: '列出需要验证的假设',
            method: ['阅读需求', '列出假设'],
            inputs: ['用户需求'],
            outputs: ['假设清单'],
            dependsOn: [],
            acceptance: ['每个假设都有验证方法'],
            risk: '假设遗漏',
          },
        ],
      },
      {
        id: 'S2',
        name: '验证',
        goal: '执行验证',
        rationale: '在范围内收集证据',
        checkpoint: '证据可复现',
        subtasks: [
          {
            id: 'T2',
            title: '执行验证',
            department: 'qa',
            role: '验证工程师',
            objective: '按清单执行并记录证据',
            method: ['执行检查', '记录结果'],
            inputs: ['假设清单'],
            outputs: ['验证报告'],
            dependsOn: ['T1'],
            acceptance: ['报告包含可复现步骤'],
            risk: '环境不稳定',
          },
        ],
      },
    ],
    risks: [
      {
        risk: '环境不稳定',
        likelihood: 'medium',
        impact: '结果不可复现',
        mitigation: '记录环境版本',
        trigger: '同一检查结果不一致',
      },
    ],
    verification: [
      { item: '报告可复现', method: '按报告步骤重跑', evidence: '重跑日志' },
    ],
    practiceLoop: {
      plan: '列假设',
      do: '执行检查',
      check: '核对证据',
      act: '修正结论',
    },
  }
}

test('valid plan passes validation', () => {
  const result = validatePlan(validPlan())
  assert.equal(result.ok, true)
  assert.equal(result.plan!.stages.length, 2)
  assert.equal(result.plan!.title, '验证一个需求')
})

test('duplicate subtask id is rejected', () => {
  const plan = validPlan()
  plan.stages[1].subtasks[0].id = 'T1'
  const result = validatePlan(plan)
  assert.equal(result.ok, false)
  assert.ok(result.errors!.some((error: any) => error.includes('重复')))
})

test('unknown dependency is rejected', () => {
  const plan = validPlan()
  plan.stages[1].subtasks[0].dependsOn = ['T9']
  const result = validatePlan(plan)
  assert.equal(result.ok, false)
  assert.ok(result.errors!.some((error: any) => error.includes('未知子任务依赖')))
})

test('dependency on a later subtask is rejected', () => {
  const plan = validPlan()
  plan.stages[0].subtasks[0].dependsOn = ['T2']
  const result = validatePlan(plan)
  assert.equal(result.ok, false)
  assert.ok(result.errors!.some((error: any) => error.includes('更早')))
})

test('unknown department is rejected', () => {
  const plan = validPlan()
  plan.stages[0].subtasks[0].department = 'unknown'
  const result = validatePlan(plan)
  assert.equal(result.ok, false)
  assert.ok(result.errors!.some((error: any) => error.includes('department')))
})

test('more than the maximum subtasks is rejected', () => {
  const plan = validPlan()
  const template = plan.stages[0].subtasks[0]
  plan.stages[0].subtasks = Array.from({ length: MAX_SUBTASKS + 1 }, (_: any, index: any) => ({
    ...structuredClone(template),
    id: `T${index + 1}`,
  }))
  const result = validatePlan(plan)
  assert.equal(result.ok, false)
  assert.ok(result.errors!.some((error: any) => error.includes(String(MAX_SUBTASKS))))
})

test('empty acceptance is rejected', () => {
  const plan = validPlan()
  plan.stages[0].subtasks[0].acceptance = []
  const result = validatePlan(plan)
  assert.equal(result.ok, false)
  assert.ok(result.errors!.some((error: any) => error.includes('acceptance')))
})

test('oversized plan is rejected', () => {
  const plan = validPlan()
  const template = plan.stages[0].subtasks[0]
  const long = 'x'.repeat(1900)
  plan.stages[0].subtasks = Array.from({ length: MAX_SUBTASKS }, (_: any, index: any) => ({
    ...structuredClone(template),
    id: `T${index + 1}`,
    objective: long,
    method: [long, long, long, long],
    acceptance: [long, long, long],
  }))
  const result = validatePlan(plan)
  assert.equal(result.ok, false)
  assert.ok(result.errors!.some((error: any) => error.includes(String(MAX_PLAN_JSON_CHARS))))
})

test('extractJson accepts fenced JSON and rejects no JSON', () => {
  const value = extractJson('```json\n{"a":1}\n```')
  assert.deepEqual(value, { a: 1 })
  assert.throws(() => extractJson('no json here'), /JSON/)
})

test('plan message round-trips through the marker', () => {
  const validated = validatePlan(validPlan())
  assert.equal(validated.ok, true)
  const plan = {
    ...validated.plan!,
    planId: 'wp-test',
    sessionId: 'session-test',
    createdTurn: 1,
    createdAt: 1000,
    sourceMessageIds: ['m1'],
  }
  const message = buildPlanMessage(plan)
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'workplan')
  assert.ok(message.content[0].text.includes(PLAN_MARKER_BEGIN))
  const parsed = parseWorkplanMessage(message)
  assert.equal(parsed.planId, 'wp-test')
  assert.equal(parsed.plan.stages.length, 2)
  assert.equal(parsed.plan.sourceMessageIds[0], 'm1')
})

test('result message round-trips through the marker', () => {
  const plan = validatePlan(validPlan())
  assert.equal(plan.ok, true)
  const statuses = createStatuses(plan.plan)
  const finished = statuses.map((item: any) => ({
    ...item,
    status: 'done',
    progress: 100,
  }))
  const message = buildResultMessage({
    planId: 'wp-test',
    sessionId: 'session-test',
    dispatchedAt: 2000,
    statuses: finished,
    errors: [],
    stats: computeStats(finished),
  })
  assert.equal(message.source.kind, 'workplan-result')
  const parsed = parseResultMessage(message)
  assert.equal(parsed.planId, 'wp-test')
  assert.equal(parsed.stats.done, 2)
})

test('cancel message round-trips and preserves the plan id', () => {
  const message = buildCancelMessage('wp-cancel', '用户选择直接修复')
  assert.equal(message.source.kind, 'workplan-cancel')
  const parsed = parseCancelMessage(message)
  assert.equal(parsed.planId, 'wp-cancel')
  assert.equal(parsed.reason, '用户选择直接修复')
  const text = messageText(message)
  assert.match(text, /不会把未完成项标成完成/)
  assert.doesNotMatch(text, /没有派发部门 Agent/)
})

test('result statuses replay into reconstructed statuses', () => {
  const plan = validatePlan(validPlan())
  assert.equal(plan.ok, true)
  const statuses = createStatuses(plan.plan)
  const result = {
    planId: 'wp-test',
    statuses: statuses.map((item: any, index: number) => ({
      ...item,
      status: index === 0 ? 'done' : 'blocked',
      progress: index === 0 ? 100 : 0,
      error: index === 0 ? null : '上游子任务受阻：T1',
    })),
  }
  const replayed = applyResultStatuses(createStatuses(plan.plan), result)
  assert.equal(replayed[0].status, 'done')
  assert.equal(replayed[1].status, 'blocked')
  assert.equal(computeStats(replayed).done, 1)
  assert.equal(computeStats(replayed).blocked, 1)
})

test('status transitions and stats are consistent', () => {
  const validated = validatePlan(validPlan())
  assert.equal(validated.ok, true)
  let statuses = createStatuses(validated.plan!)
  assert.equal(statuses.length, 2)
  statuses = applyStatus(statuses, 'T1', { status: 'in_progress' })
  assert.equal(statuses[0].status, 'in_progress')
  assert.equal(statuses[0].startedAt !== null, true)
  statuses = applyStatus(statuses, 'T1', { status: 'done' })
  assert.equal(statuses[0].progress, 100)
  statuses = applyStatus(statuses, 'T2', { status: 'blocked', error: '环境不可用' })
  const stats = computeStats(statuses)
  assert.equal(stats.total, 2)
  assert.equal(stats.done, 1)
  assert.equal(stats.blocked, 1)
  assert.equal(stats.progress, 50)
  assert.equal(planPhase(statuses), 'blocked')
  const allDone = statuses.map((item: any) => ({ ...item, status: 'done' }))
  assert.equal(planPhase(allDone), 'integrating')
  assert.equal(planPhase(allDone, true), 'done')
})

test('invalid status and unknown subtask are rejected', () => {
  const validated = validatePlan(validPlan())
  assert.equal(validated.ok, true)
  const statuses = createStatuses(validated.plan!)
  assert.throws(() => applyStatus(statuses, 'T1', { status: 'nope' }), /非法状态/)
  assert.throws(() => applyStatus(statuses, 'T9', { status: 'done' }), /未知子任务/)
})

test('stage readiness and blocked dependents work', () => {
  const validated = validatePlan(validPlan())
  assert.equal(validated.ok, true)
  let statuses = createStatuses(validated.plan!)
  assert.deepEqual(nextReadyInStage(validated.plan!, statuses, 'S1').map((item: any) => item.id), ['T1'])
  assert.deepEqual(nextReadyInStage(validated.plan!, statuses, 'S2'), [])
  statuses = applyStatus(statuses, 'T1', { status: 'blocked', error: '无法准备' })
  statuses = markDependentsBlocked(validated.plan!, statuses, 'T1')
  assert.equal(statuses[1].status, 'blocked')
  assert.ok(String(statuses[1].error ?? '').includes('T1'))
})

test('planner and child prompts contain the required constraints', () => {
  const planner = buildPlannerPrompt('测试任务', '/tmp', '用户说：选B，补做全部卡住项')
  assert.ok(planner.includes('子任务总数 1-15'))
  assert.ok(planner.includes('engineering'))
  assert.ok(planner.includes('只输出一个 JSON 对象'))
  assert.ok(planner.includes('最近对话'))
  assert.ok(planner.includes('选B'))
  const child = buildChildPrompt({
    plan: {
      taskUnderstanding: { originalRequest: '原任务', deliverable: '交付物' },
      contradictions: { primary: { statement: '主要矛盾' } },
    },
    subtask: {
      id: 'T1',
      title: '子任务',
      department: 'research',
      role: '分析',
      objective: '目标',
      method: ['方法'],
      inputs: [],
      outputs: ['输出'],
      acceptance: ['验收'],
      risk: '风险',
    },
    stage: { name: '阶段', goal: '目标' },
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '用户说：选B，补做全部卡住项',
  })
  assert.ok(child.includes('研究分析'))
  assert.ok(child.includes('BLOCKED'))
  assert.ok(child.includes('不得编造'))
  assert.ok(child.includes('最近对话背景'))
  assert.ok(child.includes('选B'))
})

test('status questions bypass planning but repair tasks do not', () => {
  for (const text of [
    '之前卡住了的 全部完美完成了吗？',
    '完成了吗',
    '进度如何？',
    '还有多少没做完？',
    '全部完成了吗',
    '是否已经完成？',
    '哪里卡住了吗',
    '现在进度怎么样',
    '刷新后，显示4个具体工作？正确吗？',
    '这4个数字正确吗',
  ]) {
    assert.equal(isStatusQuestion(text), true, `expected status: ${text}`)
  }
  for (const text of [
    '选B，并且必须杜绝这个严重缺陷',
    '修复卡住的任务',
    '继续完成安装',
    '继续修复这个 bug',
    '下一页',
    '把进度条改短一点',
    '如何改进任务进度页面的排版',
    '如何排查并修复进度显示问题',
    '如何改进显示数字的排版',
    '你好',
  ]) {
    assert.equal(isStatusQuestion(text), false, `expected not status: ${text}`)
  }
})

test('social messages are detected without a model call', () => {
  for (const text of [
    '你好',
    '您好！',
    '你好呀',
    '谢谢',
    '谢谢你！',
    '好的，谢谢',
    '收到',
    '在吗？',
    '再见',
    '晚安',
    'hello',
    'Hi there!',
    'thanks a lot',
    'see you',
    'good morning',
    '早点休息呀',
    '老师好',
    '老板，辛苦了',
  ]) {
    assert.equal(isSocialMessage(text), true, `expected social: ${text}`)
  }
})

test('social detection does not swallow real requests', () => {
  for (const text of [
    '你好，帮我写代码',
    '谢谢，顺便修一下这个 bug',
    '好的，那请继续完成安装',
    '今天天气怎么样',
    '请解释主要矛盾',
    '我想请你分析这个方案',
    '晚安，明天帮我改代码',
    '帮我看看这个报错',
  ]) {
    assert.equal(isSocialMessage(text), false, `expected task: ${text}`)
  }
  assert.equal(isSocialMessage(''), false)
  assert.equal(isSocialMessage('x'.repeat(61)), false)
  assert.equal(isSocialMessage(123), false)
})

test('vague continuation detection catches bare continue requests', () => {
  for (const text of [
    '继续',
    '继续吧',
    '继续。',
    '接着',
    '接着来',
    'B继续',
    '按B继续',
    '方案B继续',
    '然后呢？',
    '下一步',
    '往下',
    '开始吧',
    '干吧',
    'continue',
    'Continue.',
    'go on',
    'keep going',
    'proceed',
  ]) {
    assert.equal(isVagueContinuation(text), true, `expected vague: ${text}`)
  }
})

test('vague continuation detection keeps requests with new task content', () => {
  for (const text of [
    '继续完成安装',
    '继续修复这个 bug',
    '继续推进插件研发',
    '接着写测试',
    '下一步部署到服务器',
    '然后呢，帮我解释原因',
    'continue implementing the parser',
    'proceed with the migration',
    '开始吧，先写测试',
    '接下来检查日志',
  ]) {
    assert.equal(isVagueContinuation(text), false, `expected task: ${text}`)
  }
  assert.equal(isVagueContinuation(''), false)
  assert.equal(isVagueContinuation('x'.repeat(25)), false)
  assert.equal(isVagueContinuation(123), false)
})


test('readySubtasks ignores stage boundaries and only follows real dependencies', () => {
  const plan = {
    stages: [
      { id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }] },
      { id: 'S2', subtasks: [{ id: 'T2', dependsOn: [] }, { id: 'T3', dependsOn: ['T2'] }] },
    ],
  }
  const statuses = [
    { subtaskId: 'T1', status: 'blocked', progress: 100 },
    { subtaskId: 'T2', status: 'pending', progress: 0 },
    { subtaskId: 'T3', status: 'pending', progress: 0 },
  ]
  assert.deepEqual(readySubtasks(plan, statuses).map((item: any) => item.id), ['T2'])
})

test('dispatch runs real DAG subtasks and does not hit the loop guard', async () => {
  const validated = validatePlan(validPlan())
  assert.equal(validated.ok, true)
  const plan = validated.plan!
  const record: any = {
    plan,
    statuses: createStatuses(plan),
    errors: [],
    phase: 'planning',
    updatedAt: Date.now(),
  }
  const seen: string[] = []
  const ctx: any = {
    subagents: {
      async startActivation(spec: any) {
        seen.push(spec.label)
        return {
          childId: `child-${seen.length}`,
          result: Promise.resolve({ output: [{ type: 'text', text: '完成' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
  }
  const controller = new AbortController()
  const result = await dispatchPlan(ctx, record, {
    agent: {},
    signal: controller.signal,
    modelSelection: { provider: 'test', model: 'test' },
    cwd: process.cwd(),
    conversationContext: '',
  })
  assert.equal(result.statuses.filter((item: any) => item.status === 'done').length, 2)
  assert.equal(result.statuses.filter((item: any) => item.status === 'blocked').length, 0)
  assert.equal(result.errors.some((item: any) => String(item).includes('调度次数异常')), false)
  assert.equal(seen.length, 2)
})

