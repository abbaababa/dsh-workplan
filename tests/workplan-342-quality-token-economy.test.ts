/**
 * [3.4.2] 高质极致省 Token 全链路优化回归测试：
 *  1) 三档成本模式 resolveCostProfile（balanced 默认 / ultra-lean / full / DSH_WORKPLAN_LEAN_MODE=0）；
 *  2) Node-0 共享锚点 buildChildSystemAnchor 跨不同子任务/专家逐字节一致（真正保住跨会话 KV 前缀缓存），
 *     同时 buildChildRecoveryAnchor 保留子任务目标与 A1..An 供压缩后恢复；
 *  3) leader-direct 工具阶段从 Step 1 隐藏 dsh_workplan_delegate 与 dsh_workplan_instruct；
 *  4) 等效计费权重 computeWeightedTokens + 计划级/单会话预算 evaluateRuntimeBudget；
 *  5) 只读问答/查文件直通 isDirectReadOnlyQuestion 与安全快车道 evaluateFastPathEligibility；
 *  6) 规划器自适应复杂度 isComplexPlanningTask + maybePlan 跳过 Phase-0 保留真实复杂度档；
 *  7) 静默心跳 createPlanningHeartbeat(silent:true) 与 buildChildPrompt(skipTimeNotice:true)。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  effectiveDepartmentExpertCap,
  effectivePlanExpertCap,
  resolveCostProfile,
  silentChatHeartbeatEnabled,
  skipChildTimeNoticeEnabled,
  skipLeaderPhaseZeroEnabled,
} from '../src/caps.js'
import { autoResumeEnabledFrom } from '../src/auto-resume.js'
import {
  PROMPT_SECTION,
  detectChildToolPhase,
  registerChildToolPhase,
  toolGuardReason,
  unregisterChildToolPhase,
  workplanToolAdmitted,
} from '../src/host.js'
import {
  buildChildPrompt,
  buildPlanMessage,
  buildResultMessage,
  createPlanningHeartbeat,
  isDirectReadOnlyQuestion,
} from '../src/plan.js'
import { buildDelegateePrompt } from '../src/llm-rules.js'
import {
  PlanError,
} from '../src/plan.js'
import {
  adjudicateExpertReport,
  buildChildRecoveryAnchor,
  buildChildSystemAnchor,
  buildPlanSubtaskStartPhases,
  buildPlansPayload,
  createWorkplanRuntime,
  dispatchPlan,
  evaluateFastPathEligibility,
  isComplexPlanningTask,
  reconstructFromSession,
  runPlanner,
} from '../src/runtime.js'
import { describeError } from '../src/watchdog.js'
import { auditTaskUnderstanding } from '../src/understanding.js'
import {
  computeWeightedTokens,
  evaluateRuntimeBudget,
  resolveProfileBudgets,
} from '../src/step-budget.js'
import { validateStartPhaseEvidence } from '../src/five-step.js'

async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

test('[3.4.2] 三档成本模式解析与开关默认值', async () => {
  await withEnv('DSH_WORKPLAN_COST_PROFILE', undefined, async () => {
    await withEnv('DSH_WORKPLAN_LEAN_MODE', undefined, async () => {
      assert.equal(resolveCostProfile(), 'balanced')
      assert.equal(skipLeaderPhaseZeroEnabled(), true)
      assert.equal(skipChildTimeNoticeEnabled(), true)
      assert.equal(silentChatHeartbeatEnabled(), true)
      assert.equal(effectivePlanExpertCap('balanced'), 8)
      assert.equal(effectiveDepartmentExpertCap('balanced'), 4)
      assert.equal(autoResumeEnabledFrom(undefined, undefined), true)
    })
  })

  await withEnv('DSH_WORKPLAN_COST_PROFILE', 'ultra-lean', async () => {
    assert.equal(resolveCostProfile(), 'ultra-lean')
    assert.equal(effectivePlanExpertCap('ultra-lean'), 4)
    assert.equal(effectiveDepartmentExpertCap('ultra-lean'), 2)
    assert.equal(autoResumeEnabledFrom(undefined, undefined), false)
  })

  await withEnv('DSH_WORKPLAN_COST_PROFILE', undefined, async () => {
    await withEnv('DSH_WORKPLAN_LEAN_MODE', '0', async () => {
      assert.equal(resolveCostProfile(), 'full')
      assert.equal(skipLeaderPhaseZeroEnabled('full'), false)
      assert.equal(skipChildTimeNoticeEnabled('full'), false)
      assert.equal(silentChatHeartbeatEnabled('full'), false)
      assert.equal(effectivePlanExpertCap('full'), 30)
      assert.equal(effectiveDepartmentExpertCap('full'), 25)
    })
  })
})

test('[3.4.2] Node-0 共享锚点在不同子任务/专家间逐字节一致，压缩恢复锚点保留私有验收清单', () => {
  const plan: any = {
    planId: 'wp-kv-342',
    planRevision: 2,
    taskAnchor: { text: '修复登录鉴权超时并补全单测，严禁修改数据库表结构。' },
    taskUnderstanding: { constraints: ['严禁修改数据库表结构', '不得引入第三方依赖'] },
    replanHistory: [{ revision: 2, reason: '补充覆盖 token 刷新分支' }],
  }
  const t1 = { id: 'T1', title: '修复鉴权', objective: '修复 auth.ts 超时', acceptance: ['A1 超时测试通过', 'A2 无回归'] }
  const t2 = { id: 'T2', title: '补齐文档', objective: '更新 API 说明', acceptance: ['A1 文档同步'] }
  const e1 = { member: '专家A', task: '实现指数退避重试' }
  const e2 = { member: '专家B', task: '补充边界测试用例' }

  const anchorT1 = buildChildSystemAnchor(plan, t1)
  const anchorT2 = buildChildSystemAnchor(plan, t2)
  const anchorE1 = buildChildSystemAnchor(plan, t1, e1)
  const anchorE2 = buildChildSystemAnchor(plan, t1, e2)

  assert.equal(anchorT1, anchorT2, '不同子任务的 Node-0 锚点必须逐字节一致以共享跨会话 KV 缓存')
  assert.equal(anchorT1, anchorE1, '负责人与专家的 Node-0 锚点必须逐字节一致')
  assert.equal(anchorE1, anchorE2, '并行专家的 Node-0 锚点必须逐字节一致')
  assert.match(anchorT1, /严禁修改数据库表结构/)
  assert.match(anchorT1, /重规划变更 r2/)

  const recT1 = buildChildRecoveryAnchor(plan, t1)
  const recE1 = buildChildRecoveryAnchor(plan, t1, e1)
  assert.match(recT1, /你的子任务（T1）/)
  assert.match(recT1, /A1 超时测试通过/)
  assert.match(recE1, /你的唯一分工（专家A）/)
})

test('[3.4.2] leader-direct 工具阶段从 Step 1 隐藏 delegate 与 instruct（登记与 spliced 双路径）', () => {
  const sid = 'leader-direct-reg-1'
  const sessionReg = {
    id: sid,
    seq: 0,
    header: { origin: 'subagent', parentSession: 'root-1', delegationDepth: 1 },
    eventAt: () => undefined,
  }
  registerChildToolPhase(sid, 'leader-direct')
  try {
    assert.equal(detectChildToolPhase(sessionReg, 1), 'leader-direct')
    assert.equal(workplanToolAdmitted('dsh_workplan_delegate', sessionReg), false)
    assert.equal(workplanToolAdmitted('dsh_workplan_instruct', sessionReg), false)
    assert.equal(workplanToolAdmitted('dsh_workplan_verify', sessionReg), true)
    assert.equal(workplanToolAdmitted('dsh_workplan_escalate', sessionReg), true)
  } finally {
    unregisterChildToolPhase(sid)
  }

  const splicedSession = {
    id: 'leader-direct-spliced-1',
    seq: 4,
    header: { origin: 'subagent', parentSession: 'root-1', delegationDepth: 1 },
    eventAt: (i: number) => (i === 3
      ? { type: 'agent/inbox/spliced', data: { inserted: [{ content: '你是 dsh-workplan 部门执行 Agent\n【直执单会话模式】无需拆分第三层专家' }] } }
      : { type: 'system/message', data: { content: 'sys' } }),
  }
  assert.equal(detectChildToolPhase(splicedSession, 1), 'leader-direct')
  assert.equal(workplanToolAdmitted('dsh_workplan_delegate', splicedSession), false)
  assert.equal(workplanToolAdmitted('dsh_workplan_instruct', splicedSession), false)
})

test('[3.4.2] 等效计费权重与全计划总预算熔断：不误杀高缓存任务，精准刹停高输出与超总预算计划', () => {
  // 高缓存读（95% cacheRead = 600,000 × 0.1 = 60,000）+ 低输出（2,000 × 5 = 10,000）+ 输入 18,000 = 88,000 等效计费
  const cheapCached = computeWeightedTokens({
    cacheReadTokens: 600_000,
    inputTokens: 18_000,
    cacheWriteTokens: 0,
    outputTokens: 2_000,
  })
  assert.equal(cheapCached, 88_000)

  const balancedBudgets = resolveProfileBudgets('balanced', {})
  assert.equal(balancedBudgets.stepConfig.soft, 35)
  assert.equal(balancedBudgets.stepConfig.hard, 45)
  assert.equal(balancedBudgets.sessionWeightedConfig.hard, 600_000)
  assert.equal(balancedBudgets.planWeightedConfig.hard, 1_200_000)

  const scaledTenBudgets = resolveProfileBudgets('balanced', {}, 10)
  assert.equal(scaledTenBudgets.planWeightedConfig.hard, 3_500_000)
  assert.equal(scaledTenBudgets.planTokenConfig.hard, 12_000_000)

  const okCached = evaluateRuntimeBudget({
    steps: 25,
    tokens: 620_000,
    weightedTokens: cheapCached,
    planTokens: 620_000,
    planWeightedTokens: cheapCached,
    stepConfig: balancedBudgets.stepConfig,
    tokenConfig: balancedBudgets.sessionTokenConfig,
    weightedConfig: balancedBudgets.sessionWeightedConfig,
    planTokenConfig: balancedBudgets.planTokenConfig,
    planWeightedConfig: balancedBudgets.planWeightedConfig,
  })
  assert.equal(okCached.action, 'ok', '高缓存命中且步数正常的任务不得被误杀')

  const highCacheWarnOnly = evaluateRuntimeBudget({
    steps: 25,
    tokens: 922_000,
    weightedTokens: 120_000,
    planTokens: 922_000,
    planWeightedTokens: 120_000,
    stepConfig: balancedBudgets.stepConfig,
    tokenConfig: balancedBudgets.sessionTokenConfig,
    weightedConfig: balancedBudgets.sessionWeightedConfig,
    planTokenConfig: balancedBudgets.planTokenConfig,
    planWeightedConfig: balancedBudgets.planWeightedConfig,
  })
  assert.notEqual(highCacheWarnOnly.action, 'abort', '高缓存命中未触及硬上限不得中止')

  const planAbort = evaluateRuntimeBudget({
    steps: 10,
    tokens: 150_000,
    weightedTokens: 150_000,
    planTokens: 800_000,
    planWeightedTokens: 1_250_000,
    stepConfig: balancedBudgets.stepConfig,
    tokenConfig: balancedBudgets.sessionTokenConfig,
    weightedConfig: balancedBudgets.sessionWeightedConfig,
    planTokenConfig: balancedBudgets.planTokenConfig,
    planWeightedConfig: balancedBudgets.planWeightedConfig,
  })
  assert.equal(planAbort.action, 'abort')
  assert.equal(planAbort.reason, 'plan-weighted-hard')
  assert.equal(planAbort.scope, 'plan')
})

test('[3.4.2] 精准放宽只读查文件直通与安全快车道，严格拦下高难排错/重构/交付类任务', () => {
  assert.equal(isDirectReadOnlyQuestion('帮我看看 src/host.ts 是干嘛的？'), true)
  assert.equal(isDirectReadOnlyQuestion('查看一下 package.json 的内容？'), true)
  assert.equal(isDirectReadOnlyQuestion('对比一下 balanced 和 ultra-lean 的区别'), true)
  assert.equal(isDirectReadOnlyQuestion('怎么配置 DSH_WORKPLAN_COST_PROFILE？'), true)
  // 写操作 / 报告 / 多步任务必须拦截
  assert.equal(isDirectReadOnlyQuestion('帮我看看 src/host.ts 并修复里面的 bug'), false)
  assert.equal(isDirectReadOnlyQuestion('查看 src/host.ts 并输出审计报告'), false)

  // 无文件路径短小明确改动可进安全快车道
  const shortEdit = evaluateFastPathEligibility({
    enabled: true,
    costProfile: 'balanced',
    taskText: '把登录页面的“确认”按钮文案改成“提交订单”',
  })
  assert.equal(shortEdit.ok, true, `短小明确单动作应命中快车道：${JSON.stringify(shortEdit)}`)

  // 高难排错 / 架构重构 / 跨模块绝不能误进 low 快车道
  assert.equal(evaluateFastPathEligibility({
    enabled: true,
    costProfile: 'balanced',
    taskText: '排查登录超时根因并修复 src/auth.ts',
  }).code, 'ANALYSIS')
  assert.equal(evaluateFastPathEligibility({
    enabled: true,
    costProfile: 'balanced',
    taskText: '重构鉴权模块架构 src/auth.ts',
  }).code, 'ANALYSIS')
})

test('[3.4.2] 规划器复杂度自适应与 maybePlan 预登记跳过 Phase-0（保留高难任务推理档）', async () => {
  assert.equal(isComplexPlanningTask('把 README.md 的版本号改成 3.4.2'), false)
  assert.equal(isComplexPlanningTask('请对整个认证与权限系统做全面架构审计、根因排查与多模块重构方案设计'), true)

  // 验证 buildPlanSubtaskStartPhases 产出可直接通过 validateStartPhaseEvidence 硬闸
  const samplePlan: any = {
    planId: 'wp-pre-342',
    taskUnderstanding: { constraints: ['严禁修改数据库表结构'], unknowns: [] },
  }
  const sampleSubtask: any = {
    id: 'T1',
    title: '架构审计与接口重构',
    objective: '排查多模块鉴权缺陷并重构核心中间件',
    method: ['先全盘梳理现有中间件链路与边界条件', '再实施模块化重构并补齐全部集成测试'],
    inputs: ['src/auth.ts'],
    outputs: ['src/auth.ts'],
    acceptance: ['全部单测与集成测试通过'],
  }
  const builtStart = validateStartPhaseEvidence(buildPlanSubtaskStartPhases(samplePlan, sampleSubtask, '/tmp'))
  assert.equal(builtStart.ok, true, `预登记开工证据必须通过硬闸：${builtStart.error ?? ''}`)

  // 验证 maybePlan 在 balanced 模式下预登记 effortOverride（保留 high/max）并打上 costProfile
  const events: any[] = [{ type: 'system/message', data: { content: 'sys' } }]
  const session: any = {
    id: 'root-maybe-342',
    seq: 1,
    header: { cwd: '/tmp' },
    eventAt: (i: number) => events[i],
    append(type: string, data: any) {
      events.push({ type, data })
      this.seq += 1
    },
  }
  const complexPlanJson = JSON.stringify({
    version: 1,
    title: '全链路鉴权排查与重构',
    taskUnderstanding: {
      anchors: ['全链路鉴权', '严禁修改数据库表结构'],
      deliverable: '重构后的鉴权模块与验证报告',
      successCriteria: ['全部鉴权单测通过', '严禁修改数据库表结构'],
      constraints: ['严禁修改数据库表结构'],
      knownFacts: ['现有系统存在鉴权并发问题'],
      unknowns: ['并发竞态触发点'],
      assumptions: ['本地可运行测试'],
    },
    contradictions: {
      primary: { statement: '鉴权安全与改造最小之间的矛盾', evidence: ['全链路鉴权并发问题'], whyPrimary: '直接影响正确性' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '排查与实现',
      goal: '定位并重构全链路鉴权',
      rationale: '核心安全链路需高档推理',
      checkpoint: '全部测试通过',
      subtasks: [{
        id: 'T1',
        title: '全链路鉴权排查与重构',
        department: 'engineering',
        departmentRationale: '工程核心鉴权代码改造',
        role: '资深架构师',
        objective: '定位全链路鉴权并发根因并完成重构，严禁修改数据库表结构',
        method: ['逐行审计鉴权链路与并发锁逻辑', '重构并运行全量回归测试验证'],
        inputs: ['src/auth.ts'],
        outputs: ['src/auth.ts'],
        dependsOn: [],
        qualityRequirements: ['严禁修改数据库表结构且全量测试通过'],
        acceptance: ['鉴权并发问题根因定位并修复，全部测试通过'],
        risk: '遗漏边界条件',
        reasoningEffort: 'high',
      }],
    }],
    risks: [],
    verification: [{ item: '全量测试通过', method: 'npm test', evidence: '日志' }],
    practiceLoop: { plan: '梳理', do: '重构', check: '测试', act: '收尾' },
  })

  const ctx: any = {
    sessions: { get: () => session },
    llm: {
      stream(req: any) {
        assert.equal(req.reasoningEffort, 'high', '复杂架构排查任务在 balanced 模式下规划器必须保持 high 档！')
        return (async function* () {
          yield { type: 'text-delta', text: complexPlanJson }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const runtime = createWorkplanRuntime(ctx, { autoDispatch: false })
  await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', async () => {
    await withEnv('DSH_WORKPLAN_COST_PROFILE', 'balanced', async () => {
      await runtime.onPreStep({
        agent: { session },
        turn: 1,
        step: 1,
        messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '排查并重构整个全链路鉴权并发架构问题，严禁修改数据库表结构' }], source: { kind: 'user' } }],
        modelSelection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' },
        signal: new AbortController().signal,
      }, async () => ({ kind: 'enter' }))
      // 等待后台规划完成
      const pending = runtime.state.planningInFlight?.get(session.id)
      if (pending?.promise) await pending.promise
    })
  })

  const rec = runtime.state.records.get(session.id)
  assert.ok(rec?.plan, '后台规划应成功生成计划')
  assert.equal(rec.plan.costProfile, 'balanced')
  assert.equal(rec.statuses[0].effortOverride, 'high', 'balanced 模式必须保留复杂子任务的 high 推理档，绝不降智')
  assert.ok(rec.statuses[0].startPhases?.planning, 'balanced 模式必须预登记 startPhases 以跳过冗余 Phase-0')
  assert.equal(rec.statuses[0].directMode, true, '单阶段耦合子任务自动标为 directMode 以裁剪 delegate/instruct 工具表')
  runtime.dispose()
})

test('[3.4.2] 静默心跳不向对话历史刷屏，skipTimeNotice 省略开工前 send_message 预估步骤', () => {
  const notices: string[] = []
  let timerFn: (() => void) | null = null
  const silentHb = createPlanningHeartbeat({
    appendNotice: (text) => notices.push(text),
    startedAt: 0,
    maxAttempts: 1,
    silent: true,
    setTimer: (fn) => { timerFn = fn; return 1 },
    clearTimer: () => {},
  })
  silentHb.start()
  assert.equal(timerFn, null, 'silent=true 时不得启动聊天心跳定时器')
  assert.equal(notices.length, 0)

  const promptSkip = buildChildPrompt({
    plan: { planId: 'wp-1', taskAnchor: { text: '测试' }, taskUnderstanding: { originalRequest: '测试' }, stages: [] },
    subtask: { id: 'T1', title: 't1', department: 'engineering', role: 'expert', objective: '做完', method: [], inputs: [], outputs: [], acceptance: ['A1'], dependsOn: [] },
    stage: { id: 'S1', name: 's1', goal: 'g1', subtasks: [] },
    dependencyResults: [],
    cwd: '/tmp',
    skipTimeNotice: true,
    directMode: true,
  })
  assert.match(promptSkip, /【直执单会话模式】/)
  assert.match(promptSkip, /省流模式已免除开工前 send_message 预估上报/)
  assert.doesNotMatch(promptSkip, /开工前先报预估时长：用/)
})

function buildValidTestPlanJson(constraints: string[], deliverable = '完整分析报告') {
  return JSON.stringify({
    version: 1,
    title: '研究分析与报告撰写',
    taskUnderstanding: {
      anchors: constraints,
      deliverable,
      successCriteria: ['按要求完成分析并交付高质量报告', ...constraints],
      constraints,
      knownFacts: ['目标明确'],
      unknowns: ['最新公开收尾口径'],
      assumptions: ['严格遵守所有约束'],
    },
    contradictions: {
      primary: { statement: '全面性与时效性的矛盾', evidence: ['要求最短时间超高质量完成'], whyPrimary: '直接决定交付节奏与准确度' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '研究分析',
      goal: '完成合规调研与分析',
      rationale: '先研究后交付',
      checkpoint: '约束全部核验',
      subtasks: [{
        id: 'T1',
        title: '完成研究分析并撰写交付报告',
        department: 'research',
        departmentRationale: '研究分析与编写报告',
        role: '研究员',
        objective: '完成全面梳理分析并编写清晰报告',
        method: ['全面梳理公开权威信息', '按规范撰写并复核全部结论'],
        inputs: ['公开历史行情'],
        outputs: ['reports/final.md'],
        dependsOn: [],
        qualityRequirements: constraints.length > 0 ? constraints : ['严格准确无遗漏'],
        acceptance: ['分析结论准确、约束严格遵守、报告清晰易懂'],
        risk: '信息口径偏差',
        reasoningEffort: 'low',
      }],
    }],
    risks: [],
    verification: [{ item: '约束核验', method: '人工核查', evidence: '核查记录' }],
    practiceLoop: { plan: '梳理', do: '执行', check: '复核', act: '交付' },
  })
}

test('[3.4.2] runPlanner 多轮修复消息携带合法 assistant.source（兼容 DSH 0.2.3-alpha.2 forAdapter replayState 检查）', async () => {
  const seenCalls: any[] = []
  const draftBadSchema = JSON.stringify({ title: '缺少阶段字段的坏草稿' })
  const validPlan = buildValidTestPlanJson(['禁止编造任何结论'])

  const ctx: any = {
    llm: {
      stream(req: any) {
        seenCalls.push(req.messages)
        // 严格模拟 DSH 0.2.3-alpha.2 @deepseek-ai/dsh-llm forAdapter() 对每条 assistant.source.replayState 的读取
        for (const msg of req.messages) {
          if (msg.role === 'assistant') {
            if (!msg.source) {
              throw new TypeError("Cannot read properties of undefined (reading 'replayState')")
            }
            void msg.source.replayState
          }
        }
        const replyText = seenCalls.length === 1 ? draftBadSchema : validPlan
        return (async function* () {
          yield { type: 'text-delta', text: replyText }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }

  const plan = await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', () =>
    runPlanner(ctx, {
      taskText: '请做研究分析，禁止编造任何结论',
      cwd: '/tmp',
      sessionId: 'sess-repair-source-1',
      modelSelection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
      signal: new AbortController().signal,
      costProfile: 'balanced',
    }),
  )

  assert.equal(seenCalls.length, 2, '第 1 次结构校验失败后应走第 2 次多轮修复并成功返回')
  assert.equal(seenCalls[1].length, 4, '第 2 次多轮修复必须保持 4 条消息以命中 Attempt 1 KV 前缀缓存')
  assert.equal(seenCalls[1][0].content[0].text, seenCalls[0][0].content[0].text, 'system 前缀必须逐字节一致')
  assert.equal(seenCalls[1][1].content[0].text, seenCalls[0][1].content[0].text, 'user 首轮前缀必须逐字节一致')
  assert.equal(seenCalls[1][2].role, 'assistant')
  assert.deepEqual(seenCalls[1][2].source, {
    kind: 'model',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  assert.equal(plan.title, '研究分析与报告撰写')
})

test('[3.4.2] runPlanner 多轮修复若被宿主拒收自动降级为单轮附底稿重试', async () => {
  const seenCalls: any[] = []
  const draftBadSchema = JSON.stringify({ title: '缺少阶段字段的坏草稿' })
  const validPlan = buildValidTestPlanJson(['禁止编造任何结论'])

  const ctx: any = {
    llm: {
      stream(req: any) {
        seenCalls.push(req.messages)
        const attempt = seenCalls.length
        return (async function* () {
          if (attempt === 1) {
            yield { type: 'text-delta', text: draftBadSchema }
            yield { type: 'finish', reason: { kind: 'stop' } }
          } else if (attempt === 2) {
            // 模拟宿主适配器以 finish/error UNKNOWN 拒收合成 assistant 消息
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'synthetic assistant rejected' } } }
          } else {
            yield { type: 'text-delta', text: validPlan }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        })()
      },
    },
  }

  const plan = await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', () =>
    runPlanner(ctx, {
      taskText: '请做研究分析，禁止编造任何结论',
      cwd: '/tmp',
      sessionId: 'sess-repair-fallback-1',
      modelSelection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
      signal: new AbortController().signal,
      costProfile: 'balanced',
    }),
  )

  assert.equal(seenCalls.length, 3, 'Attempt 2 拒收合成 assistant 后不得终止，应自动降级 Attempt 3 单轮重试')
  assert.equal(seenCalls[1].length, 4)
  assert.equal(seenCalls[2].length, 2, '第 3 次降级必须退回单轮 [system, user]')
  const userRetryPrompt = seenCalls[2][1].content[0].text
  assert.match(userRetryPrompt, /上一轮输出的计划 JSON 草稿：/)
  assert.match(userRetryPrompt, /缺少阶段字段的坏草稿/)
  assert.equal(plan.title, '研究分析与报告撰写')
})

test('[3.4.2] CONTEXT_GUARD 长中文禁止类约束同义改写不误杀，真实遗漏仍严格拦截', () => {
  const taskText = [
    '总任务：预判159667走势并写报告。',
    'A. 禁止参考未收盘的行情。',
    'F. 全程绝对禁止参考项目目录和文件夹内既有的所有内容，',
  ].join('\n')

  const paraphrasedPlan = JSON.parse(buildValidTestPlanJson([
    '严禁使用盘中未收盘行情数据',
    '全程禁止读取工作区已有文件及内容',
  ]))
  const passAudit = auditTaskUnderstanding(paraphrasedPlan, { taskText })
  assert.deepEqual(
    passAudit.stage3.missingHardAnchors,
    [],
    `合法同义否定改写不应被误报缺失，实测: ${JSON.stringify(passAudit.stage3.missingHardAnchors)}`,
  )

  const missingOnePlan = JSON.parse(buildValidTestPlanJson([
    '严禁使用盘中未收盘行情数据',
  ]))
  const catchOneAudit = auditTaskUnderstanding(missingOnePlan, { taskText })
  assert.ok(
    catchOneAudit.stage3.missingHardAnchors.some((m) => m.includes('项目目录')),
    `真实漏掉第二条禁止项必须拦截，实测: ${JSON.stringify(catchOneAudit.stage3.missingHardAnchors)}`,
  )

  // 即使整份计划里出现了「禁止超时」，但只在肯定语境里提到“未收盘的行情”，仍必须判定缺失（防极性绕过）
  const positiveOnlyPlan = JSON.parse(buildValidTestPlanJson(['禁止超时完成']))
  positiveOnlyPlan.stages[0].subtasks[0].objective = '梳理并分析未收盘的行情以及项目目录和文件夹内既有的所有内容'
  const catchPositiveAudit = auditTaskUnderstanding(positiveOnlyPlan, { taskText })
  assert.ok(
    catchPositiveAudit.stage3.missingHardAnchors.some((m) => m.includes('未收盘的行情')),
    `只在肯定语境提及禁令宾语不得放行，实测: ${JSON.stringify(catchPositiveAudit.stage3.missingHardAnchors)}`,
  )
})

test('[3.4.2] 计划级预算熔断保持 phase=blocked（绝不误标 cancelled 导致进度面板卡片消失），且未执行下游保留 pending', async () => {
  const controller = new AbortController()
  const events: any[] = [{ type: 'turn/start', data: { turn: 1 } }]
  const session: any = {
    id: 'root-budget-ui-1',
    seq: events.length,
    header: { createdAt: Date.now(), cwd: '/tmp' },
    eventAt: (i: number) => events[i],
    append(type: string, data: any) {
      events.push({ type, data })
      this.seq = events.length
    },
  }
  const record: any = {
    planId: 'wp-budget-ui-1',
    sessionId: session.id,
    title: '多阶段行情预判计划',
    phase: 'executing',
    cancelled: false,
    degraded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: {
      planId: 'wp-budget-ui-1',
      title: '多阶段行情预判计划',
      costProfile: 'balanced',
      stages: [
        { id: 'S1', name: '阶段一', goal: 'done', checkpoint: 'cp1', subtasks: [{ id: 'T1', title: '锁定口径', department: 'product', role: 'expert', objective: 'o1', method: [], inputs: [], outputs: [], dependsOn: [], acceptance: ['A1'] }] },
        { id: 'S2', name: '阶段二', goal: 'running', checkpoint: 'cp2', subtasks: [{ id: 'T2', title: '整理数据', department: 'data', role: 'expert', objective: 'o2', method: [], inputs: [], outputs: [], dependsOn: ['T1'], acceptance: ['A2'] }] },
        { id: 'S3', name: '阶段三', goal: 'pending', checkpoint: 'cp3', subtasks: [{ id: 'T3', title: '深度分析', department: 'research', role: 'expert', objective: 'o3', method: [], inputs: [], outputs: [], dependsOn: ['T2'], acceptance: ['A3'] }] },
      ],
    },
    statuses: [
      { subtaskId: 'T1', status: 'done', closure: 'reported', progress: 100, acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'ok' }], verification: 'structured' },
      { subtaskId: 'T2', status: 'in_progress', progress: 40 },
      { subtaskId: 'T3', status: 'pending', progress: 0 },
    ],
    errors: ['T2: 单子会话触发预算［stack: PlanError: detail | at Object.onPreStep］'],
  }

  controller.abort(new PlanError('全计划累计等效计费 token 已达 3,520,000（硬上限 3,500,000），触发计划级总预算熔断并收编已落盘产物', 'BUDGET_HARD_ABORT'))
  await dispatchPlan({ sessions: { get: () => session } }, record, {
    agent: { session, fork: async () => ({ session: { id: 'child-unused' } }) },
    modelSelection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    cwd: '/tmp',
    session,
    signal: controller.signal,
  })

  assert.equal(record.phase, 'blocked', '预算熔断必须收敛为 blocked，绝不能伪装成用户 cancelled')
  assert.equal(record.cancelled, false)
  const byId = new Map<string, any>(record.statuses.map((s: any) => [s.subtaskId, s]))
  assert.equal(byId.get('T1').status, 'done', '已完成的 T1 必须保持 done')
  assert.equal(byId.get('T2').status, 'blocked', '正在执行的 T2 应标为 blocked')
  assert.doesNotMatch(byId.get('T2').error, /stack:/, '写入状态的预算错误不得夹带内部 stack')
  assert.equal(byId.get('T3').status, 'pending', '尚未启动的下游 T3 必须保留 pending 以便续跑')

  const state = { records: new Map([[session.id, record]]), sessions: { list: () => [session], get: () => session } }
  const payload = buildPlansPayload({ sessions: { list: () => [session], get: () => session } }, state, session.id)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].phase, 'blocked', '看板载荷 phase 必须为 blocked，Dashboard 才能继续展示该计划')
})

test('[3.4.2] 省流模式免除子会话开工预告时不挂载 awaiting noticeChannel、不误报 NOT_OBSERVED_IN_SESSION_LOG', async () => {
  const events: any[] = [{ type: 'turn/start', data: { turn: 1 } }]
  const session: any = {
    id: 'root-skip-notice-1',
    seq: events.length,
    header: { createdAt: Date.now(), cwd: '/tmp' },
    eventAt: (i: number) => events[i],
    append(type: string, data: any) {
      events.push({ type, data })
      this.seq = events.length
    },
  }
  const plan: any = {
    planId: 'wp-skip-notice-1',
    sessionId: session.id,
    title: '省流无预告假告警回归',
    costProfile: 'balanced',
    stages: [{
      id: 'S1',
      name: '研究阶段',
      goal: '完成研究',
      checkpoint: '核对',
      subtasks: [{
        id: 'T1',
        title: '核验口径',
        department: 'product',
        role: 'expert',
        objective: '锁定口径并输出说明书',
        method: ['读取时间口径并写入说明书'],
        inputs: [],
        outputs: [],
        dependsOn: [],
        acceptance: ['A1 口径一致'],
      }],
    }],
  }
  const preStart = buildPlanSubtaskStartPhases(plan, plan.stages[0].subtasks[0], '/tmp')
  const record: any = {
    planId: plan.planId,
    sessionId: session.id,
    title: plan.title,
    phase: 'executing',
    cancelled: false,
    degraded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selfEffortConfigured: true,
    plan,
    statuses: [{
      subtaskId: 'T1',
      status: 'pending',
      progress: 0,
      effortOverride: 'low',
      directMode: true,
      startPhases: preStart,
    }],
    errors: [],
  }

  let capturedChildPrompt = ''
  const childResultText = [
    '已完成口径核验。',
    '<!-- WORKPLAN_EVIDENCE:START -->',
    JSON.stringify({
      status: 'done',
      acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'ok' }],
      phases: {
        execution: { steps: ['完成任务执行与结果核对'], deviations: [] },
        verification: { retrospective: { noIssues: true } },
      },
      report: {
        keyResults: ['已完成交付'],
        keyInfo: ['核对通过'],
        importantInfo: [],
        leadRequirements: ['无'],
      },
    }),
    '<!-- WORKPLAN_EVIDENCE:END -->',
  ].join('\n')

  const childSession: any = {
    id: 'child-skip-notice-1',
    seq: 1,
    header: { createdAt: Date.now(), cwd: '/tmp' },
    eventAt: (i: number) => (i === 0 ? { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: childResultText }] } } } : undefined),
  }

  const ctx: any = {
    logger: { warn() {} },
    sessions: {
      get: (id: string) => (id === session.id ? session : id === childSession.id ? childSession : undefined),
      list: () => [session, childSession],
    },
    subagents: {
      startActivation: async (spec: any) => {
        capturedChildPrompt = String(spec?.prompt?.[0]?.text ?? '')
        return {
          childId: childSession.id,
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: childResultText }],
          }),
          dispose: async () => {},
        }
      },
    },
  }

  await dispatchPlan(ctx, record, {
    agent: { id: 'lead-agent-1', session },
    modelSelection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    cwd: '/tmp',
    session,
    strictEvidence: false,
    signal: new AbortController().signal,
  })

  assert.match(capturedChildPrompt, /省流模式已免除开工前 send_message 预估上报/)
  assert.equal(record.statuses[0].status, 'done', `应顺利完成而不被门禁退回：${record.statuses[0].error ?? ''}`)
  assert.equal(record.statuses[0].noticeChannel, undefined, '免除预告时不得挂载 awaiting/not-observed 的 noticeChannel')
  assert.equal(
    (record.errors ?? []).some((e: string) => e.includes('NOT_OBSERVED_IN_SESSION_LOG')),
    false,
    `免除预告时不得写入 NOT_OBSERVED_IN_SESSION_LOG 假告警：${JSON.stringify(record.errors)}`,
  )
})

test('[3.4.3] 高缓存会话原始 token 上限提升：balanced 允许 6M raw 且保持 600k 加权熔断', () => {
  const balanced = resolveProfileBudgets('balanced', {})
  assert.equal(balanced.sessionTokenConfig.hard, 6_000_000)
  assert.equal(balanced.sessionWeightedConfig.hard, 600_000)
  // 复刻 T7R d3d69363 真实比例：1,423,872 cacheRead + 70,732 in + 34,039 out = 1,528,643 raw，加权仅 ~383k
  const verdict = evaluateRuntimeBudget({
    steps: 20,
    tokens: 1_528_643,
    weightedTokens: 383_314,
    planTokens: 2_000_000,
    planWeightedTokens: 500_000,
    stepConfig: balanced.stepConfig,
    tokenConfig: balanced.sessionTokenConfig,
    weightedConfig: balanced.sessionWeightedConfig,
    planTokenConfig: balanced.planTokenConfig,
    planWeightedConfig: balanced.planWeightedConfig,
  })
  assert.equal(verdict.action, 'ok', '93% cacheRead 且加权成本未触顶的优质会话不得被 1.5M raw 上限误杀')
})

test('[3.4.3] adjudicateExpertReport 兼容顶层 execution/verification 且仍严拒缺失证据', () => {
  // 复刻 T7D expert 866b2c37 的真实结构：status/execution/verification/report 放在顶层
  const topLevelShape = [
    'T7D 单一产物已生成并通过自检 ALL PASSED。',
    '<!-- WORKPLAN_EVIDENCE:START -->',
    JSON.stringify({
      status: 'done',
      execution: {
        steps: ['1 只读白名单 T3/T4/T7', '2 构建三情景模型', '3 独立 verify_t7d.py ALL PASSED'],
        deviations: [],
      },
      verification: {
        retrospective: { problems: [], detours: [], lessons: [], nextTime: [] },
        allPassed: true,
      },
      report: {
        keyResults: ['T7D 三情景与 10 对强互作已产出并双脚本自检通过'],
        keyInfo: ['11-28/29 休市，11-30 唯一交易日'],
        importantInfo: ['基准 0.429 vs 0.472 已双口径披露'],
        leadRequirements: ['最终报告保留双口径'],
      },
    }),
    '<!-- WORKPLAN_EVIDENCE:END -->',
  ].join('\n')
  const okVerdict = adjudicateExpertReport({ output: [{ type: 'text', text: topLevelShape }] })
  assert.deepEqual(okVerdict, { ok: true })

  // 若确实缺少 verification / steps，门禁仍然严格拦截
  const incompleteShape = [
    '只写了一半。',
    '<!-- WORKPLAN_EVIDENCE:START -->',
    JSON.stringify({
      status: 'done',
      report: {
        keyResults: ['done'],
        keyInfo: ['k'],
        importantInfo: ['i'],
        leadRequirements: ['l'],
      },
    }),
    '<!-- WORKPLAN_EVIDENCE:END -->',
  ].join('\n')
  const badVerdict = adjudicateExpertReport({ output: [{ type: 'text', text: incompleteShape }] })
  assert.equal(badVerdict.ok, false)
})

test('[3.4.3] T7R 中断挽救：子会话已写出完整合格结果块但后续步被 abort 时就地结算 done', async () => {
  const session: any = {
    id: 'root-salvage-1',
    header: { createdAt: Date.now(), cwd: '/tmp' },
    events: [] as any[],
    append(type: string, data: any) { this.events.push({ type, data }) },
  }
  const plan: any = {
    planId: 'wp-salvage-1',
    costProfile: 'balanced',
    taskAnchor: { text: '完成因子分析' },
    stages: [{
      id: 'S1',
      name: '分析',
      goal: '产出分析',
      subtasks: [{
        id: 'T7R',
        title: '因子互作与关键驱动',
        department: 'research',
        role: '研究员',
        objective: '产出因子互作矩阵',
        method: ['读取上游并验证'],
        outputs: ['reports/T7R/out.md'],
        acceptance: ['A1 矩阵齐全且可验证'],
        dependsOn: [],
        risk: '低',
        qualityRequirements: ['严禁引用未收盘行情'],
      }],
    }],
  }
  const preStart = buildPlanSubtaskStartPhases(plan, plan.stages[0].subtasks[0], '/tmp')
  const record: any = {
    planId: plan.planId,
    sessionId: session.id,
    title: plan.title,
    phase: 'executing',
    cancelled: false,
    degraded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selfEffortConfigured: true,
    plan,
    statuses: [{
      subtaskId: 'T7R',
      status: 'pending',
      progress: 0,
      effortOverride: 'high',
      directMode: true,
      startPhases: preStart,
    }],
    errors: [],
  }
  const completedEvidenceText = [
    '已完成全部研究并落盘验证。',
    '<!-- WORKPLAN_EVIDENCE:START -->',
    JSON.stringify({
      status: 'done',
      acceptance: [{ criterion: 'A1 矩阵齐全且可验证', result: 'pass', evidence: 'reports/T7R/out.md 实测 16 对通过' }],
      artifacts: [{ kind: 'file', ref: 'reports/T7R/out.md' }],
      phases: {
        execution: { steps: ['完成分析与独立核验'], deviations: [] },
        verification: { retrospective: { noIssues: true } },
      },
      departmentSummary: {
        keyResults: ['T7R 已完成'],
        keyInfo: ['16 对强互作'],
        importantInfo: ['截止 11-27 收盘'],
        sources: [],
      },
    }),
    '<!-- WORKPLAN_EVIDENCE:END -->',
  ].join('\n')

  const childSession: any = {
    id: 'child-salvage-1',
    seq: 2,
    header: { createdAt: Date.now(), cwd: '/tmp' },
    eventAt: (i: number) => (i === 0
      ? { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: completedEvidenceText }] } }
      : { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'notice' }] } }),
  }

  const ctx: any = {
    logger: { warn() {} },
    sessions: {
      get: (id: string) => (id === session.id ? session : id === childSession.id ? childSession : undefined),
      list: () => [session, childSession],
    },
    subagents: {
      startActivation: async () => ({
        childId: childSession.id,
        // 模拟 Step 20 已发出结果块后，Step 21 在 pre-step 被 BUDGET_HARD_ABORT 中断，output 为空
        result: Promise.resolve({ stopReason: 'aborted', output: [], diagnostic: 'parent' }),
        dispose: async () => {},
      }),
    },
  }

  await dispatchPlan(ctx, record, {
    agent: { id: 'lead-agent-salvage', session },
    modelSelection: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    cwd: '/tmp',
    session,
    strictEvidence: true,
    artifactExists: () => true,
    signal: new AbortController().signal,
  })

  assert.equal(record.statuses[0].status, 'done', `应从会话日志挽回合格结果块并结算 done：${record.statuses[0].error ?? ''}`)
  assert.equal(record.statuses[0].verification, 'structured')
})

test('[3.4.3] onPreStep 单会话硬上限 1 步收尾宽限窗口：先给收尾步，不立刻硬杀；下一步仍不交再杀', async () => {
  const planId = 'wp-grace-1'
  const rootSession: any = {
    id: 'root-grace',
    header: { createdAt: Date.now(), cwd: '/tmp' },
    append() {},
  }
  const childSession: any = {
    id: 'child-grace-1',
    seq: 1,
    header: { parentSession: 'root-grace', cwd: '/tmp' },
    eventAt: () => ({ type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'BUILD OK 19/19 PASS' }] } }),
    append() {},
  }
  const fullPlan: any = {
    planId,
    costProfile: 'balanced',
    stages: [{
      id: 'S1',
      name: 'S1',
      goal: 'G',
      subtasks: [{
        id: 'T7D',
        title: 'T7D',
        department: 'data',
        role: '专家',
        objective: '分析',
        method: ['分析'],
        outputs: ['reports/T7D/out.json'],
        acceptance: ['A1 通过'],
        dependsOn: [],
        risk: '低',
        qualityRequirements: ['必须核验'],
      }],
    }],
  }
  const preStart = buildPlanSubtaskStartPhases(fullPlan, fullPlan.stages[0].subtasks[0], '/tmp')
  const rec: any = {
    plan: fullPlan,
    statuses: [{ subtaskId: 'T7D', status: 'pending', effortOverride: 'high', directMode: true, startPhases: preStart }],
    phase: 'executing',
    errors: [],
  }
  let resolveChild!: (v: any) => void
  const childPromise = new Promise((r) => { resolveChild = r })
  const rtCtx: any = {
    logger: { warn() {} },
    sessions: {
      get: (id: string) => (id === rootSession.id ? rootSession : id === 'child-grace-1' ? childSession : undefined),
      list: () => [rootSession, childSession],
    },
    subagents: {
      startActivation: async () => ({
        childId: 'child-grace-1',
        result: childPromise,
        dispose: async () => {},
      }),
    },
  }
  const rt = createWorkplanRuntime(rtCtx, {})
  rt.state.records.set(rootSession.id, rec)
  // 注入 615k 等效计费 token（越过 balanced 600k 单会话硬上限，低于 1.35× 紧急线）
  rt.cacheMeter.observe('child-grace-1', {
    inputTokens: 15_000,
    outputTokens: 110_000,
    cacheReadTokens: 500_000,
    cacheWriteTokens: 0,
  })
  const running = rt.dispatchTool({ id: 'root-agent-grace', session: rootSession }, { mode: 'async', startPhases: preStart }, new AbortController().signal)
  await running
  await new Promise((r) => setTimeout(r, 20))
  try {
    const d1 = await rt.onPreStep({ agent: { session: childSession, options: {} }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(d1?.kind, 'enter')
    assert.match(JSON.stringify(d1), /预算上限收尾步（最后一步/, '首次触及单会话硬上限应先发 1 步收尾宽限提示而不立即强杀')
    // 第二次进 pre-step 仍未输出证据块，则真实触发中止
    const d2 = await rt.onPreStep({ agent: { session: childSession, options: {} }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(d2?.kind, 'enter')
    assert.doesNotMatch(JSON.stringify(d2), /预算上限收尾步（最后一步/, '收尾步用完后下一步必须硬中止')
  } finally {
    resolveChild({ stopReason: 'aborted', output: [] })
    await new Promise((r) => setTimeout(r, 30))
    rt.dispose()
  }
})

test('[3.4.3] replanPlan 在 balanced 模式下为新增/替换子任务预登记 directMode + startPhases + effortOverride', async () => {
  const rootSession: any = {
    id: 'root-replan-1',
    header: { createdAt: Date.now(), cwd: '/tmp' },
    events: [] as any[],
    append(type: string, data: any) { this.events.push({ type, data }) },
  }
  const rt = createWorkplanRuntime({
    logger: { warn() {} },
    sessions: { get: (id: string) => (id === rootSession.id ? rootSession : undefined), list: () => [rootSession] },
    subagents: {},
  }, {})
  const plan: any = {
    planId: 'wp-replan-balanced',
    costProfile: 'balanced',
    createdAt: Date.now(),
    taskAnchor: { text: '深度分析工业母机 ETF 走势' },
    stages: [{
      id: 'S1',
      name: '分析',
      goal: '深入研究',
      subtasks: [{
        id: 'T7',
        title: '旧互作矩阵',
        department: 'research',
        role: '专家',
        objective: '分析因子互作',
        method: ['读取上游并构建矩阵'],
        outputs: ['reports/T7/out.md'],
        acceptance: ['A1 互作矩阵齐全'],
        risk: '中',
        reasoningEffort: 'high',
        qualityRequirements: ['必须引用真实数据'],
      }],
    }],
  }
  rt.state.records.set(rootSession.id, {
    plan,
    statuses: [{ subtaskId: 'T7', stageId: 'S1', title: '旧互作矩阵', department: 'research', status: 'blocked', progress: 0 }],
    phase: 'blocked',
    errors: [],
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    modelSelection: { provider: 'deepseek-account', model: 'deepseek-reasoner' },
  })
  const replanRes = await rt.replanPlan({ session: rootSession, options: { model: 'deepseek-reasoner' } }, {
    reason: '缩小单次输出范围并合并脚本',
    changes: [{
      action: 'replace',
      subtaskId: 'T7',
      reason: '旧行超预算',
      replacement: {
        id: 'T7D',
        stageId: 'S1',
        title: '综合研判与单日预判',
        department: 'data',
        role: '资深数据专家',
        objective: '基于已归档的 T3/T4/T7 文件完成顺序脚本构建与双口径验证，产出单一 JSON+MD 产物',
        method: ['先读取 T3/T4/T7，再构建脚本并自检落盘'],
        outputs: ['reports/T7D/T7D.json'],
        acceptance: ['A1 产物自检全部通过'],
        risk: '低',
        reasoningEffort: 'high',
        qualityRequirements: ['全部数字截至前收盘'],
      },
    }],
  })
  assert.equal(replanRes.ok, true, `replan 应成功：${(replanRes as any).error ?? ''}`)
  const record = rt.state.records.get(rootSession.id)
  const t7dRow = record.statuses.find((s: any) => s.subtaskId === 'T7D')
  assert.ok(t7dRow, '应存在重规划后的 T7D 行')
  assert.equal(t7dRow.effortOverride, 'high', 'balanced 重规划应保留真实复杂度高档，不降级')
  assert.ok(t7dRow.startPhases, 'balanced 重规划必须预登记 startPhases 以跳过 Phase-0')
  assert.equal(t7dRow.directMode, true, '顺序脚本构建且单阶段耦合任务应预置 directMode=true')
  rt.dispose()
})

test('[3.4.3] toolGuardReason 拦截在途/刚结算工作计划中的盲等 wait_agent', async () => {
  const rootSession: any = { id: 'root-guard-wait', header: { createdAt: Date.now() } }
  const rt = createWorkplanRuntime({
    logger: { warn() {} },
    sessions: { get: (id: string) => (id === rootSession.id ? rootSession : undefined), list: () => [rootSession] },
    subagents: {},
  }, {})
  rt.state.records.set(rootSession.id, {
    plan: { planId: 'wp-wait-guard', stages: [] },
    statuses: [{ subtaskId: 'T1', status: 'in_progress' }],
    phase: 'executing',
    dispatchPromise: new Promise(() => {}),
  })
  const activeDenial = toolGuardReason({ name: 'wait_agent', agent: { session: rootSession } }, rt)
  assert.ok(activeDenial && activeDenial.includes('dsh_workplan_dispatch'), `应拦截在途 wait_agent 并引导 dispatch(wait)：${activeDenial}`)

  // 若后台轮次已经结算进入 blocked/resultWritten=true，同样禁止继续调用 wait_agent 傻等
  rt.state.records.set(rootSession.id, {
    plan: { planId: 'wp-wait-guard', stages: [] },
    statuses: [{ subtaskId: 'T7D', status: 'blocked' }],
    phase: 'blocked',
    dispatchPromise: null,
    resultWritten: true,
  })
  const settledDenial = toolGuardReason({ name: 'wait_agent', agent: { session: rootSession } }, rt)
  assert.ok(settledDenial && settledDenial.includes('已经结算完毕'), `应拦截已结算后的 wait_agent：${settledDenial}`)

  // 非工作计划会话或已完成计划不拦截 wait_agent
  rt.state.records.set(rootSession.id, {
    plan: { planId: 'wp-wait-guard', stages: [] },
    statuses: [{ subtaskId: 'T1', status: 'done' }],
    phase: 'done',
    dispatchPromise: null,
  })
  assert.equal(toolGuardReason({ name: 'wait_agent', agent: { session: rootSession } }, rt), undefined)
  rt.dispose()
})

test('[3.4.3] buildResultMessage 排除已重规划旧行，且 describeError 不在 PlanError 上附带栈噪声', () => {
  const msg = buildResultMessage({
    planId: 'wp-result-filter',
    sessionId: 'root-result-filter',
    dispatchedAt: Date.now(),
    statuses: [
      { subtaskId: 'T1', status: 'done', closure: 'reported', verification: 'structured', acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'ok' }] },
      { subtaskId: 'T7', status: 'blocked', closure: 'replanned', error: '已重规划：范围过大导致计费熔断' },
      { subtaskId: 'T7D', status: 'blocked', closure: 'blocked', error: '样本缺失' },
    ],
    stats: { total: 2, done: 1, blocked: 1, inProgress: 0, pending: 0, progress: 50 },
    phase: 'blocked',
    resumeCount: 0,
    resumeAvailable: true,
    deliveryReady: false,
  })
  const text = String(msg.content?.[0]?.text ?? '')
  assert.match(text, /剩余 1 项：T7D（首个原因：样本缺失）/)
  assert.doesNotMatch(text, /已重规划/, '不应把已重规划历史行 T7 当成剩余项或首个原因打印')

  const planErrText = describeError(new PlanError('触发预算上限', 'BUDGET_HARD_ABORT'))
  assert.equal(planErrText, '触发预算上限')
  assert.doesNotMatch(planErrText, /［stack:/)
  const jsErrText = describeError(new TypeError('unexpected null'))
  assert.match(jsErrText, /unexpected null［stack:/)
})

test('[3.4.3] 收尾宽限步锁死全部工具调用，若子会话误调 verify/read 立即零耗时拦截并再给一次纯文本交卷步', async () => {
  const planId = 'wp-grace-lock-1'
  const rootSession: any = { id: 'root-grace-lock', header: { createdAt: Date.now(), cwd: '/tmp' }, append() {} }
  const childSession: any = {
    id: 'child-grace-lock',
    seq: 1,
    header: { parentSession: 'root-grace-lock', cwd: '/tmp' },
    eventAt: () => ({ type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'BUILD OK' }] } }),
    append() {},
  }
  const fullPlan: any = {
    planId,
    costProfile: 'balanced',
    stages: [{
      id: 'S1',
      name: 'S1',
      goal: 'G',
      subtasks: [{
        id: 'T7D',
        title: 'T7D',
        department: 'data',
        role: '专家',
        objective: '分析',
        method: ['分析'],
        outputs: ['reports/T7D/out.json'],
        acceptance: ['A1 通过'],
        dependsOn: [],
        risk: '低',
        qualityRequirements: ['必须核验'],
      }],
    }],
  }
  const preStart = buildPlanSubtaskStartPhases(fullPlan, fullPlan.stages[0].subtasks[0], '/tmp')
  let resolveChild!: (v: any) => void
  const childPromise = new Promise((r) => { resolveChild = r })
  const rt = createWorkplanRuntime({
    logger: { warn() {} },
    sessions: {
      get: (id: string) => (id === rootSession.id ? rootSession : id === childSession.id ? childSession : undefined),
      list: () => [rootSession, childSession],
    },
    subagents: {
      startActivation: async () => ({
        childId: childSession.id,
        result: childPromise,
        dispose: async () => {},
      }),
    },
  }, {})
  rt.state.records.set(rootSession.id, {
    plan: fullPlan,
    statuses: [{ subtaskId: 'T7D', status: 'pending', effortOverride: 'high', directMode: true, startPhases: preStart }],
    phase: 'executing',
    errors: [],
  })
  rt.cacheMeter.observe(childSession.id, { inputTokens: 15_000, outputTokens: 110_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 })
  await rt.dispatchTool({ id: 'root-grace-lock-agent', session: rootSession }, { mode: 'async', startPhases: preStart }, new AbortController().signal)
  await new Promise((r) => setTimeout(r, 20))
  try {
    const d1 = await rt.onPreStep({ agent: { session: childSession, options: {} }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.match(JSON.stringify(d1), /严禁调任何工具/, '第 1 个宽限步应明确告知工具已锁定')
    // 模型习惯性尝试调 dsh_workplan_verify 或 read：toolGuardReason 必须 0ms 拦截，并保住第 2 个纯文本收尾机会
    const blockedVerify = toolGuardReason({ name: 'dsh_workplan_verify', agent: { session: childSession } }, rt)
    assert.ok(blockedVerify && blockedVerify.includes('所有工具调用已锁定禁止执行'), `收尾步应锁定 verify 等工具：${blockedVerify}`)
    const d2 = await rt.onPreStep({ agent: { session: childSession, options: {} }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.match(JSON.stringify(d2), /预算上限收尾步/, '工具被 0ms 拦下后必须给一次纯文本交卷补偿步')
    // 再用掉也不交卷，第 3 次硬中止
    const d3 = await rt.onPreStep({ agent: { session: childSession, options: {} }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.doesNotMatch(JSON.stringify(d3), /预算上限收尾步/)
  } finally {
    resolveChild({ stopReason: 'aborted', output: [] })
    await new Promise((r) => setTimeout(r, 30))
    rt.dispose()
  }
})

test('[3.4.3] workplan-wake 唤醒新回合受 onTurnStopping 收尾门禁约束 + directMode 跨重规划持久回放', async () => {
  const events: any[] = []
  const rootSession: any = {
    id: 'root-wake-replay',
    header: { createdAt: Date.now(), cwd: '/tmp' },
    get seq() { return events.length },
    eventAt(i: number) { return events[i] },
    append(type: string, data: any) { events.push({ type, data, seq: events.length }) },
  }
  const rt = createWorkplanRuntime({
    logger: { warn() {} },
    sessions: { get: (id: string) => (id === rootSession.id ? rootSession : undefined), list: () => [rootSession] },
    subagents: {},
  }, {})
  const plan: any = {
    planId: 'wp-wake-replay',
    title: '重规划回放测试计划',
    costProfile: 'balanced',
    createdAt: Date.now(),
    taskUnderstanding: { originalRequest: '完整交付并自检', deliverable: 'T7D.json', constraints: [], knownFacts: [], unknowns: [], assumptions: [], successCriteria: [] },
    contradictions: { primary: { statement: '成本与质量矛盾', evidence: ['单文件'], whyPrimary: '核心' }, secondary: [], transformationConditions: [] },
    taskAnchor: { text: '完整交付并自检' },
    stages: [{
      id: 'S1',
      name: '分析',
      goal: '产出分析',
      subtasks: [{
        id: 'T7',
        title: '旧项',
        department: 'research',
        role: '研究员',
        objective: '先读后写',
        method: ['读取上游并构建'],
        outputs: ['reports/T7/out.json'],
        acceptance: ['A1 齐全'],
        dependsOn: [],
        risk: '低',
        reasoningEffort: 'high',
        qualityRequirements: ['必须核验'],
      }],
    }],
  }
  rootSession.append('user/message', buildPlanMessage(plan, { totalBudgetMinutes: 30, maxResumes: 2 }))
  rt.state.records.set(rootSession.id, {
    plan,
    statuses: [{ subtaskId: 'T7', stageId: 'S1', title: '旧项', department: 'research', status: 'blocked', progress: 0 }],
    phase: 'blocked',
    errors: [],
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    modelSelection: { provider: 'deepseek-account', model: 'deepseek-reasoner' },
  })
  const replanRes = await rt.replanPlan({ session: rootSession, options: { model: 'deepseek-reasoner' } }, {
    reason: '合并重规划',
    changes: [{
      action: 'replace',
      subtaskId: 'T7',
      reason: '超预算',
      replacement: {
        id: 'T7D',
        stageId: 'S1',
        title: '综合研判',
        department: 'data',
        role: '数据专家',
        objective: '基于上游先读后算产出单一文件',
        method: ['先读取后验证'],
        outputs: ['reports/T7D/T7D.json'],
        acceptance: ['A1 全部通过'],
        risk: '低',
        reasoningEffort: 'high',
        qualityRequirements: ['禁止引用未收盘行情'],
      },
    }],
  })
  assert.equal(replanRes.ok, true)

  // 1) 重启回放后 directMode 必须不丢失
  const replayed = reconstructFromSession(rootSession)
  const replayedT7D = replayed?.statuses?.find((s: any) => s.subtaskId === 'T7D')
  assert.ok(replayedT7D, '重规划 T7D 应能回放')
  assert.equal(replayedT7D.directMode, true, 'directMode 必须随 workplan-update 持久落盘并回放恢复')
  assert.equal(replayedT7D.effortOverride, 'high')

  // 2) Turn 2 由 workplan-wake 唤醒时，onTurnStopping 必须识别该续跑回合並 steer 拦住未完成收尾
  rootSession.append('turn/start', { turn: 2 })
  rootSession.append('user/message', {
    id: 'wake-msg-1',
    role: 'user',
    content: [{ type: 'text', text: '[dsh-workplan] 本轮后台派发已结算完毕' }],
    source: { kind: 'workplan-wake', form: 'notice', summary: '派发轮次已结算' },
  })
  const steered: any[] = []
  await rt.onTurnStopping({ agent: { session: rootSession, steer(msg: any) { steered.push(msg) } }, turn: 2 })
  assert.equal(steered.length, 1, 'workplan-wake 唤醒的新回合未交付就收尾必须被 onTurnStopping steer 拦住')
  rt.dispose()
})

test('[3.4.3] 提示词禁止 ls -R reports 扫描历史旧目录，并规范主 Agent 个别补做需经 update 改判 done', () => {
  const leaderPrompt = buildChildPrompt({
    plan: { planId: 'wp-prompt-1', stages: [{ id: 'S1', subtasks: [{ id: 'T1' }] }] },
    subtask: { id: 'T1', title: 'T1', department: 'data', role: '专家', objective: '分析', method: ['读输入'], inputs: ['reports/T2/a.csv'], outputs: ['reports/T1/b.json'], acceptance: ['A1 ok'], risk: '低', qualityRequirements: ['严谨'] },
    stage: { id: 'S1', name: 'S1', goal: 'G' },
    dependencyResults: [],
    cwd: '/tmp',
    directMode: true,
  })
  assert.match(leaderPrompt, /禁止全文 read 自己刚生成的长文件/)
  assert.match(leaderPrompt, /严禁执行 ls -R reports/)

  const delegateePrompt = buildDelegateePrompt({
    departmentLabel: '数据',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: 'T1',
    member: { member: '专家A', role: 'expert', task: '生成JSON', qualityRequirements: ['自检'], effort: 'high' },
    rulesBrief: '',
    cwd: '/tmp',
  })
  assert.match(delegateePrompt, /严禁 ls -R reports/)
  assert.match(PROMPT_SECTION, /dsh_workplan_update.*禁抛开台账包揽全部剩余项或扫 reports 历史旧目录/)
})
