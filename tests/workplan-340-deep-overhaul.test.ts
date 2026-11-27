import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createDelegateTool,
  createReplanTool,
  createStatusTool,
  detectChildToolPhase,
  registerChildToolPhase,
  unregisterChildToolPhase,
  workplanToolAdmitted,
} from '../src/host.js'
import { validateRetrospective } from '../src/lessons.js'
import { buildDelegateePrompt, buildLlmRulesBrief, buildPhaseZeroDelegateePrompt } from '../src/llm-rules.js'
import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  appendUserMessage,
  buildChildPrompt,
  buildPhaseZeroLeaderPrompt,
  buildResultMessage,
  isDirectReadOnlyQuestion,
  messageText,
} from '../src/plan.js'
import { planReplan } from '../src/replan.js'
import {
  buildChildSystemAnchor,
  createWorkplanRuntime,
  evaluateFastPathEligibility,
  persistRuntimeSettlementBackup,
  runPlanner,
} from '../src/runtime.js'
import { evaluateRuntimeBudget, parseStepBudget, parseTokenBudget } from '../src/step-budget.js'
import { auditTaskUnderstanding, extractTaskElements } from '../src/understanding.js'

function sharedPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

test('[3.4.0] 不可变阶段登记表消除 Step-1→Step-2 KV Cache 断层，并跳过 <system-reminder>', () => {
  const sid = 'child-kv-stable-1'
  // 模拟 Step 1：此时 user/message 尚未入账（seq=0）
  const emptyStep1Session = {
    id: sid,
    seq: 0,
    header: { parentSession: 'root-1', delegationDepth: 2, origin: 'subagent' },
    eventAt: () => undefined,
  }
  registerChildToolPhase(sid, 'leaf-phase-1')
  try {
    assert.equal(detectChildToolPhase(emptyStep1Session, 2), 'leaf-phase-1')
    assert.equal(workplanToolAdmitted('dsh_workplan_delegate', emptyStep1Session), false)
    assert.equal(workplanToolAdmitted('dsh_workplan_escalate', emptyStep1Session), true)
  } finally {
    unregisterChildToolPhase(sid)
  }

  // 兜底扫描：跳过 seq 0..3 的 <system-reminder>，命中 seq=5 的真实任务书
  const events: any[] = [
    { type: 'system/message', data: { content: 'sys' } },
    { type: 'user/message', data: { content: '<system-reminder>hook1</system-reminder>' } },
    { type: 'user/message', data: { content: '<system-reminder>hook2</system-reminder>' } },
    { type: 'user/message', data: { content: '<system-reminder>hook3</system-reminder>' } },
    { type: 'user/message', data: { content: '<system-reminder>hook4</system-reminder>' } },
    { type: 'user/message', data: { content: '你是 dsh-workplan 第三层本部门相关领域全球顶尖专家，只负责末尾【你的分工】里那一项工作。' } },
  ]
  const wrappedSession = {
    id: 'child-wrapped-1',
    seq: events.length,
    header: { parentSession: 'root-1', delegationDepth: 2, origin: 'subagent' },
    eventAt: (i: number) => events[i],
  }
  assert.equal(detectChildToolPhase(wrappedSession, 2), 'leaf-phase-1')
})

test('[3.4.0] 静态优先重排：Phase-0 负责人、Phase-0 专家、Phase-1 专家实现高比例 KV 前缀共享', () => {
  const sharedAnchor = '把认证模块的超时逻辑改成指数退避，严禁修改数据库表结构。'
  const p0a = buildPhaseZeroLeaderPrompt({
    subtaskId: 'T1',
    title: '修改认证重试',
    objective: '实现指数退避',
    departmentLabel: '工程部',
    taskAnchor: sharedAnchor,
    deliverable: '通过测试的退避实现',
    constraints: ['严禁修改数据库表结构'],
    successCriteria: ['单元测试全部通过'],
    dependencyBrief: '无上游依赖',
    replannedReason: '新增最大重试次数 3 次上限',
  })
  const p0b = buildPhaseZeroLeaderPrompt({
    subtaskId: 'T2',
    title: '补充文档',
    objective: '更新设计文档',
    departmentLabel: '产品部',
    taskAnchor: sharedAnchor,
    deliverable: '通过测试的退避实现',
    constraints: ['严禁修改数据库表结构'],
    successCriteria: ['单元测试全部通过'],
  })
  assert.ok(sharedPrefixLen(p0a, p0b) >= 400, `Phase-0 负责人应共享 >400 字符静态+锚点前缀，实测 ${sharedPrefixLen(p0a, p0b)}`)
  assert.match(p0a, /严禁修改数据库表结构/)
  assert.match(p0a, /新增最大重试次数 3 次上限/)
  assert.match(p0a, /timeNotice/)

  const e0a = buildPhaseZeroDelegateePrompt({
    departmentLabel: '工程部',
    member: { member: '专家A', role: 'expert', task: '写代码', qualityRequirements: ['单测通过'], effort: 'high' },
  })
  const e0b = buildPhaseZeroDelegateePrompt({
    departmentLabel: '测试部',
    member: { member: '专家B', role: 'expert', task: '写测试', qualityRequirements: ['覆盖边界'], effort: 'medium' },
  })
  assert.ok(sharedPrefixLen(e0a, e0b) >= 350, `Phase-0 专家跨部门应共享 >350 字符前缀，实测 ${sharedPrefixLen(e0a, e0b)}`)

  const e1a = buildDelegateePrompt({
    departmentLabel: '工程部',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '主任务',
    member: { member: '专家A', role: 'expert', task: '实现模块A', qualityRequirements: ['无回归'], effort: 'high' },
    rulesBrief: buildLlmRulesBrief({ model: 'deepseek-chat', effort: 'high', tier: 'delegate', phase1: true }),
    continuation: true,
  })
  const e1b = buildDelegateePrompt({
    departmentLabel: '研究部',
    leaderSubtaskId: 'T2',
    leaderSubtaskTitle: '主任务2',
    member: { member: '专家B', role: 'expert', task: '分析模块B', qualityRequirements: ['可复核'], effort: 'medium' },
    rulesBrief: buildLlmRulesBrief({ model: 'deepseek-chat', effort: 'medium', tier: 'delegate', phase1: true }),
    continuation: true,
  })
  assert.ok(sharedPrefixLen(e1a, e1b) >= 1200, `Phase-1 不同档位专家应共享 >1200 字符静态前缀，实测 ${sharedPrefixLen(e1a, e1b)}`)
  assert.match(e1a, /平台会自动落盘结算备份/)
  assert.match(e1a, /"noIssues":true/)
})

test('[3.4.0] runPlanner 定向修复重试保留 system + user + assistant 前缀命中 KV 缓存', async () => {
  const calls: any[] = []
  let attempt = 0
  const validPlan = {
    version: 1,
    title: '修复认证空指针',
    taskUnderstanding: {
      originalRequest: '修复 src/auth.ts 的空指针错误，禁止修改数据库',
      deliverable: '修复补丁',
      successCriteria: ['src/auth.ts 空指针已修复', '禁止修改数据库'],
      constraints: ['禁止修改数据库'],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '修复与稳定性平衡', evidence: ['src/auth.ts'], whyPrimary: '最小改动' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '修复',
      goal: '修复空指针',
      rationale: '单阶段修复',
      checkpoint: '验证通过',
      subtasks: [{
        id: 'T1',
        title: '修复 src/auth.ts',
        department: 'engineering',
        departmentRationale: '代码修复属工程部',
        role: '工程专家',
        objective: '修复 src/auth.ts 的空指针，严禁修改数据库',
        method: ['检查空值并补保护'],
        inputs: ['src/auth.ts'],
        outputs: ['src/auth.ts'],
        dependsOn: [],
        qualityRequirements: ['不引入回归且不修改数据库'],
        acceptance: ['src/auth.ts 空指针已修复且测试通过'],
        risk: '边界条件遗漏',
        reasoningEffort: 'low',
      }],
    }],
    risks: [],
    verification: [{ item: '单测通过', method: 'npm test', evidence: '日志' }],
    practiceLoop: { plan: '定位', do: '修复', check: '测试', act: '收尾' },
  }
  const ctx = {
    llm: {
      stream(req: any) {
        calls.push(req)
        attempt += 1
        const text = attempt === 1 ? '{"version":1,"title":"残缺"}' : JSON.stringify(validPlan)
        return (async function* () {
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const plan = await runPlanner(ctx, {
    taskText: '修复 src/auth.ts 的空指针错误，禁止修改数据库',
    cwd: '/tmp',
    sessionId: 'sess-planner-kv',
    modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
    signal: new AbortController().signal,
    budget: { concurrency: 4, maxResumes: 2 },
  })
  assert.ok(plan)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].messages.length, 4, 'Attempt 2 必须是 system + user + assistant + user 四段接续')
  assert.equal(calls[1].messages[0].role, 'system')
  assert.equal(calls[1].messages[0].content[0].text, calls[0].messages[0].content[0].text, 'system 前缀必须逐字节一致')
  assert.equal(calls[1].messages[1].content[0].text, calls[0].messages[1].content[0].text, '原始 user 前缀必须逐字节一致')
  assert.equal(calls[1].messages[2].role, 'assistant')
})

test('[3.4.0] 纯概念问答直通 + 确定性快路径放宽覆盖单文件代码任务', () => {
  assert.equal(isDirectReadOnlyQuestion('什么是 KV Prefix Cache？'), true)
  assert.equal(isDirectReadOnlyQuestion('解释一下 Transformer 注意力机制'), true)
  assert.equal(isDirectReadOnlyQuestion('how does prefix caching work?'), true)
  assert.equal(isDirectReadOnlyQuestion('修复 src/host.ts 的空指针'), false)
  assert.equal(isDirectReadOnlyQuestion('重构登录模块并补充测试'), false)

  const okSingleFile = evaluateFastPathEligibility({
    enabled: true,
    taskText: '更新 src/host.ts 的版本号常量为 3.4.0',
  })
  assert.equal(okSingleFile.ok, true, `简单代码修改应命中确定性快路径，实测 ${JSON.stringify(okSingleFile)}`)
  assert.equal(okSingleFile.department, 'engineering')

  const okTwoVerbs = evaluateFastPathEligibility({
    enabled: true,
    taskText: '检查并修复 src/auth.ts 的空指针异常',
  })
  assert.equal(okTwoVerbs.ok, true, `双动词单文件修复应命中确定性快路径，实测 ${JSON.stringify(okTwoVerbs)}`)
})

test('[3.4.0] 零异常复盘 {"noIssues":true} 合法通过，空白未声明仍严格拒绝', () => {
  const clean = validateRetrospective({ noIssues: true })
  assert.equal(clean.ok, true)
  const emptyWithoutFlag = validateRetrospective({ problems: [], detours: [], resolutions: [], prevention: [] })
  assert.equal(emptyWithoutFlag.ok, false)
})

test('[3.4.0] 平台自动落盘结算备份（0 LLM 输出 token）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-340-backup-'))
  try {
    const output = `已完成。\n${EVIDENCE_MARKER_BEGIN}\n{"status":"done","acceptance":[{"criterion":"A1","result":"pass","evidence":"ok"}]}\n${EVIDENCE_MARKER_END}`
    const path = persistRuntimeSettlementBackup(dir, 'wp-test-1', 'T1', output)
    assert.ok(path && existsSync(path))
    const saved = JSON.parse(readFileSync(path!, 'utf8'))
    assert.equal(saved.planId, 'wp-test-1')
    assert.equal(saved.subtaskId, 'T1')
    assert.equal(saved.status, 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[3.4.0] 运行期步数 + Token 硬上限实时熔断判定', () => {
  const stepCfg = parseStepBudget('40')
  const tokenCfg = parseTokenBudget('1000000')
  assert.equal(evaluateRuntimeBudget({ steps: 10, tokens: 100_000, stepConfig: stepCfg, tokenConfig: tokenCfg }).action, 'ok')
  assert.equal(evaluateRuntimeBudget({ steps: 40, tokens: 100_000, stepConfig: stepCfg, tokenConfig: tokenCfg }).action, 'warn')
  assert.equal(evaluateRuntimeBudget({ steps: 50, tokens: 100_000, stepConfig: stepCfg, tokenConfig: tokenCfg }).action, 'abort')
  assert.equal(evaluateRuntimeBudget({ steps: 10, tokens: 800_000, stepConfig: stepCfg, tokenConfig: tokenCfg }).action, 'warn')
  assert.equal(evaluateRuntimeBudget({ steps: 10, tokens: 1_000_000, stepConfig: stepCfg, tokenConfig: tokenCfg }).action, 'abort')
})

test('[3.4.0] 禁止类负面约束升级为硬锚点：丢弃必拦截，同义改写不误报', () => {
  const extracted = extractTaskElements('修复 src/auth.ts，严禁修改业务代码，不要删除日志表')
  const negations = extracted.elements.filter((e) => e.kind === 'negation')
  assert.ok(negations.length >= 2)
  assert.ok(negations.every((e) => e.hard === true), '明确禁止类约束必须为 hard: true')

  const basePlan = {
    taskUnderstanding: { originalRequest: '修复 src/auth.ts', deliverable: '补丁', constraints: [] as string[], successCriteria: [] as string[] },
    stages: [{ id: 'S1', name: '修', goal: '修', subtasks: [{ id: 'T1', title: '修', department: 'engineering', objective: '修复 src/auth.ts', acceptance: ['通过'] }] }],
  }
  const dropped = auditTaskUnderstanding(basePlan, { taskText: '修复 src/auth.ts，严禁修改业务代码' })
  assert.ok(dropped.stage3.missingHardAnchors.some((m) => m.includes('业务代码')), '丢弃禁止约束必须进入 missingHardAnchors')

  const paraphrasedPlan = structuredClone(basePlan)
  paraphrasedPlan.taskUnderstanding.constraints = ['不得改动业务代码']
  const paraphrased = auditTaskUnderstanding(paraphrasedPlan, { taskText: '修复 src/auth.ts，严禁修改业务代码' })
  assert.equal(paraphrased.stage3.missingHardAnchors.some((m) => m.includes('业务代码')), false, '同义否定改写不得误报')
})

test('[3.4.0] 重规划同步更新 taskAnchor 与 replanHistory，且透传至 buildChildPrompt 与节点 0 锚点', () => {
  const origPlan: any = {
    planId: 'wp-rp-1',
    sessionId: 'root-1',
    createdTurn: 1,
    createdAt: 1000,
    taskAnchor: { text: '原任务：输出 Markdown 报告', sha256: 'abc123' },
    taskUnderstanding: {
      originalRequest: '原任务：输出 Markdown 报告',
      deliverable: '报告',
      constraints: ['禁止编造数据'],
      successCriteria: ['结构完整'],
      knownFacts: ['已有 CSV 数据'],
      unknowns: ['是否需要图表'],
      assumptions: ['中文输出'],
    },
    verification: ['人工抽检全部数据'],
    stages: [{
      id: 'S1',
      name: '撰写',
      goal: '产报告',
      rationale: '一次性完成',
      checkpoint: '复核全部数字',
      subtasks: [{
        id: 'T1',
        title: '写报告',
        department: 'research',
        role: '研究员',
        objective: '输出 Markdown 报告',
        method: ['分析数据'],
        inputs: [],
        outputs: ['reports/r.md'],
        dependsOn: [],
        acceptance: ['数据准确'],
        risk: '口径偏差',
      }],
    }],
  }
  const replanned = planReplan(origPlan, [{
    subtaskId: 'T1',
    action: 'replace',
    replacement: { objective: '改输出 JSON 格式报告' },
  }], {
    planId: 'wp-rp-1',
    reason: '用户要求改为 JSON 格式',
    changeText: '不要 Markdown，改输出 JSON 格式',
    revision: 1,
    at: 2000,
  })
  assert.equal(replanned.ok, true)
  if (!replanned.ok) return
  const nextPlan = replanned.payload.plan
  assert.match(nextPlan.taskAnchor.text, /重规划修订 r1/)
  assert.match(nextPlan.taskAnchor.text, /改输出 JSON 格式/)
  assert.equal(nextPlan.taskAnchor.originalSha256, 'abc123')
  assert.notEqual(nextPlan.taskAnchor.sha256, 'abc123')

  const nextSubtask = nextPlan.stages[0].subtasks.find((s: any) => s.id === 'T1b')
  const childPrompt = buildChildPrompt({
    plan: nextPlan,
    subtask: nextSubtask,
    stage: nextPlan.stages[0],
    cwd: '/tmp',
  })
  assert.match(childPrompt, /禁止编造数据/)
  assert.match(childPrompt, /已有 CSV 数据/)
  assert.match(childPrompt, /阶段检查点：复核全部数字/)
  assert.match(childPrompt, /重规划最新变更/)

  const node0Anchor = buildChildSystemAnchor(nextPlan, nextSubtask)
  assert.match(node0Anchor, /不可变任务锚点/)
  assert.match(node0Anchor, /禁止编造数据/)
  assert.match(node0Anchor, /重规划变更 r1/)
})

test('[3.4.0] workplan-result 豁免 80 字截断并携带各部门交付摘要，status render 展示实质产物', () => {
  const events: any[] = []
  const session: any = {
    id: 'root-res-1',
    seq: 1,
    eventAt: (i: number) => (i === 0 ? { type: 'system/message', data: { content: 'sys' } } : events[i - 1]),
    append(type: string, data: any) {
      events.push({ type, data })
      this.seq += 1
    },
  }
  // 先灌满 4000 字符轮次进度预算
  for (let i = 0; i < 12; i += 1) {
    appendUserMessage(session, `【关键进度】T${i} 进度更新 ${'x'.repeat(380)}`)
  }
  const resultMsg = buildResultMessage({
    planId: 'wp-res-1',
    phase: 'done',
    taskAnchorText: '实现完整登录接口并返回 JWT 令牌，同时输出接口文档到 reports/api.md',
    stats: { total: 1, done: 1, blocked: 0, pending: 0, running: 0 },
    statuses: [{
      subtaskId: 'T1',
      title: '实现登录接口',
      status: 'done',
      verification: 'structured',
      acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'ok' }],
      departmentSummary: { conclusion: '已完成 JWT 登录接口并补充单测' },
      artifacts: [{ kind: 'file', ref: 'reports/api.md', exists: true }],
    }],
  })
  appendUserMessage(session, resultMsg)
  const lastText = messageText(events[events.length - 1].data)
  assert.match(lastText, /【各部门交付摘要】/)
  assert.match(lastText, /已完成 JWT 登录接口并补充单测/)
  assert.match(lastText, /reports\/api\.md/)

  const statusTool = createStatusTool({
    statusTool: async () => ({
      ok: true,
      planId: 'wp-res-1',
      phase: 'done',
      deliveryReady: true,
      stats: { total: 1, done: 1, blocked: 0 },
      statuses: [{
        subtaskId: 'T1',
        title: '实现登录接口',
        status: 'done',
        acceptance: [{ criterion: 'A1', result: 'pass' }],
        departmentSummary: { conclusion: '已完成 JWT 登录接口并补充单测' },
        artifacts: [{ ref: 'reports/api.md', exists: true }],
      }],
    }),
  })
  const rendered = statusTool.output.render({}, {
    ok: true,
    planId: 'wp-res-1',
    phase: 'done',
    deliveryReady: true,
    stats: { total: 1, done: 1, blocked: 0 },
    statuses: [{
      subtaskId: 'T1',
      title: '实现登录接口',
      status: 'done',
      acceptance: [{ criterion: 'A1', result: 'pass' }],
      departmentSummary: { conclusion: '已完成 JWT 登录接口并补充单测' },
      artifacts: [{ ref: 'reports/api.md', exists: true }],
    }],
  })
  assert.match(rendered[0].text, /已完成 JWT 登录接口并补充单测/)
  assert.match(rendered[0].text, /reports\/api\.md/)
})

test('[3.4.0] delegate/replan 工具 Schema 补全预登记字段与 abortRunning，且 dispatchTool 汇合在途 autoDispatch 不误报 START_EVIDENCE_MISSING', async () => {
  const delegateSchema: any = createDelegateTool({}).parameters.properties.consolidation.properties.assignments.items.properties
  assert.ok(delegateSchema.startPhases.properties.planning, 'assignments[].startPhases 必须展开完整 JSON Schema')
  assert.ok(delegateSchema.timeNotice.properties.declaredMinutes, 'assignments[].timeNotice 必须展开完整 JSON Schema')

  const replanSchema: any = createReplanTool({}).parameters.properties
  assert.equal(replanSchema.abortRunning.type, 'boolean', 'replan 工具必须暴露 abortRunning 参数')

  const events: any[] = [{ type: 'system/message', data: { content: 'sys' } }]
  const session: any = {
    id: 'root-join-1',
    seq: 1,
    header: {},
    eventAt: (i: number) => events[i],
    append(type: string, data: any) {
      events.push({ type, data })
      this.seq += 1
    },
  }
  const runtime = createWorkplanRuntime({ sessions: { get: () => session } }, { autoDispatch: true })
  const record: any = {
    plan: {
      planId: 'wp-join-1',
      sessionId: 'root-join-1',
      createdTurn: 1,
      createdAt: Date.now(),
      stages: [{ id: 'S1', name: 's1', goal: 'g1', subtasks: [{ id: 'T1', title: 't1', department: 'engineering', objective: 'o1', acceptance: ['A1'] }] }],
    },
    statuses: [{ subtaskId: 'T1', title: 't1', status: 'done', verification: 'structured', acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'ok' }] }],
    phase: 'done',
    errors: [],
    dispatchPromise: Promise.resolve(),
  }
  runtime.state.records.set(session.id, record)
  const joined = await runtime.dispatchTool({ session }, { planId: 'wp-join-1', mode: 'wait' }, undefined)
  assert.equal(joined.ok, true, `汇合在途 autoDispatch 不应报 START_EVIDENCE_MISSING，实测 ${JSON.stringify(joined)}`)
  assert.equal(joined.joined, true)
  runtime.dispose()
})
