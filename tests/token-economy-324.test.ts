/* [3.2.4] 省钱与档位安全改动的守门测试：O6/O8 人数闸、O1 预登记开关、
 * 规划器 system+user 拆分、能力清单缓存 TTL/容量、F11 sources 契约。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { planDelegations } from '../src/llm-rules.js'
import { buildPlannerPrompt, buildPlannerSystemPrompt, buildPlannerUserPrompt } from '../src/plan.js'
import { renderDepartmentSummarySpec } from '../src/v3-contract.js'
import { runPlanner } from '../src/runtime.js'

const anchor = setInterval(() => {}, 1_000)
const release = setTimeout(() => clearInterval(anchor), 60_000)
release.unref?.()

function assignmentsOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    member: `专家${i + 1}`,
    role: 'expert',
    task: `单一目标子任务 ${i + 1}（单一主产物、可独立验收）`,
    qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
  }))
}

test('[O8] 单阶段计划豁免复杂任务 ≥8 人下限；多阶段计划不豁免', () => {
  const input = { consolidation: { assignments: assignmentsOf(3), taskReasoningEffort: 'high' }, model: 'gpt-4o' }
  const multi = planDelegations(input)
  assert.equal(multi.ok, false)
  assert.equal(multi.code, 'DELEGATE_HEADCOUNT_MIN')
  const single = planDelegations({ ...input, singleStagePlan: true })
  assert.equal(single.ok, true, `单阶段豁免应放行 3 人分工表：${single.error ?? ''}`)
  assert.equal(single.members.length, 3)
})

test('[O6/O8] caps 常量：MIN 可用环境变量覆盖（默认 8），MAX_TOTAL_EXPERTS_PER_PLAN 存在', async () => {
  const base = await import('../src/caps.js')
  assert.equal(base.MIN_COMPLEX_DELEGATE_MEMBERS, 8)
  assert.ok(base.MAX_TOTAL_EXPERTS_PER_PLAN >= 1)
  process.env.DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS = '3'
  try {
    const overriddenSpec = '../src/caps.js?o8-override=1'
    const overridden: typeof base = await import(overriddenSpec)
    assert.equal(overridden.MIN_COMPLEX_DELEGATE_MEMBERS, 3)
    assert.ok(overridden.MAX_COMPLEX_DELEGATE_MEMBERS >= 3)
  } finally {
    delete process.env.DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS
  }
  const badSpec = '../src/caps.js?o8-bad=1'
  const bad: typeof base = await import(badSpec)
  process.env.DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS = 'not-a-number'
  const fallbackSpec = '../src/caps.js?o8-fallback=1'
  const fallback: typeof base = await import(fallbackSpec)
  delete process.env.DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS
  assert.equal(bad.MIN_COMPLEX_DELEGATE_MEMBERS, 8, '缺省回落 8')
  assert.equal(fallback.MIN_COMPLEX_DELEGATE_MEMBERS, 8, '非法值回落 8')
})

test('[3.2.4] 规划器拆分：system 块含全部静态内容，user 块只含动态三段，拼接视图与旧口径一致', async () => {
  const budget = { concurrency: 5, maxResumes: 4 }
  const system = buildPlannerSystemPrompt(budget)
  const user = buildPlannerUserPrompt('把它整理成三段', '/tmp/work', '用户说：选B')
  assert.match(system, /可用部门/)
  assert.match(system, /输出 JSON 结构/)
  assert.match(system, /只允许半角标点/)
  assert.match(system, /最多 5 项并行/)
  assert.match(system, /受阻自动续跑 4 次/)
  assert.doesNotMatch(system, /最近对话（/)
  assert.doesNotMatch(system, /工作目录/)
  assert.match(user, /工作目录：\/tmp\/work/)
  assert.match(user, /最近对话/)
  assert.match(user, /任务：/)
  assert.match(user, /把它整理成三段/)
  assert.doesNotMatch(user, /可用部门/)
  assert.equal(buildPlannerPrompt('把它整理成三段', '/tmp/work', '用户说：选B', budget), `${system}\n\n${user}`)
})

test('[3.2.4] 规划器请求拆两角色：system 先行、user 随后；档位仍随请求发送', async () => {
  const previous = process.env.DSH_WORKPLAN_CONTEXT_GUARD
  process.env.DSH_WORKPLAN_CONTEXT_GUARD = 'off'
  const seen: any[] = []
  const validPlan = {
    version: 1,
    title: '整理说明文档',
    taskUnderstanding: {
      originalRequest: '把说明文档整理成三段',
      deliverable: '整理后的三段文本',
      successCriteria: ['每段不超过五行'],
      constraints: ['不要改动原意'],
      knownFacts: ['用户要求分三段'],
      unknowns: ['原文长度未知'],
      assumptions: ['原文可分段'],
    },
    contradictions: {
      primary: { statement: '简洁与完整之间的矛盾', evidence: ['每段不超过五行'], whyPrimary: '过短可能丢信息' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '整理',
      goal: '完成三段整理',
      rationale: '直接执行',
      checkpoint: '文本分三段',
      subtasks: [{
        id: 'T1',
        title: '整理成三段',
        department: 'design',
        role: '文档编辑',
        objective: '把文本整理成三段',
        method: ['阅读原文'],
        inputs: ['原文'],
        outputs: ['三段文本'],
        dependsOn: [],
        qualityRequirements: ['每段不超过五行'],
        acceptance: ['每段不超过五行'],
        risk: '无',
        reasoningEffort: 'low',
      }],
    }],
    risks: [],
    verification: [{ item: '每段不超过五行', method: '逐段计数', evidence: '最终文本' }],
    practiceLoop: { plan: '读', do: '整理', check: '核对', act: '修正' },
  }
  const fakeCtx = (text: string) => ({
    llm: {
      stream(options: any) {
        seen.push(options)
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  })
  try {
    const plan = await runPlanner(fakeCtx(JSON.stringify(validPlan)), {
      telemetry: {},
      taskText: '把说明文档整理成三段',
      cwd: '/tmp',
      sessionId: 'session-token-economy-324',
      modelSelection: { provider: 'fake-provider', model: 'fake-model' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: { totalMinutes: 20, childMinutes: 15, concurrency: 5, maxResumes: 4 },
      sourceMessageIds: [],
    })
    assert.equal(plan.title, '整理说明文档')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].messages.length, 2, '非修复请求必须恰好 system+user 两条消息')
    assert.equal(seen[0].messages[0].role, 'system')
    assert.equal(seen[0].messages[1].role, 'user')
    assert.match(seen[0].messages[0].content[0].text, /可用部门/)
    assert.match(seen[0].messages[1].content[0].text, /任务：/)
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_CONTEXT_GUARD
    else process.env.DSH_WORKPLAN_CONTEXT_GUARD = previous
  }
})

test('[3.2.4] resolveSupportedEfforts 缓存：同键命中、容量上限淘汰最旧', async () => {
  const freshSpec = '../src/runtime.js?cache-324=1'
  const fresh: typeof import('../src/runtime.js') = await import(freshSpec)
  let calls = 0
  const llm = {
    resolveModelInfo: async (_provider: string, model: string) => {
      calls += 1
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } }
    },
  }
  const first = await fresh.resolveSupportedEfforts(llm, 'p1', 'm1')
  const second = await fresh.resolveSupportedEfforts(llm, 'p1', 'm1')
  assert.deepEqual(first, ['low', 'high', 'max'])
  assert.equal(calls, 1, '同键第二次必须命中缓存')
  // 容量 128：再填 128 个新键把 m1 挤出，重查 m1 必须真实回源（calls+1）。
  for (let i = 0; i < 128; i += 1) {
    await fresh.resolveSupportedEfforts(llm, 'bulk', `m-${i}`)
  }
  const after = await fresh.resolveSupportedEfforts(llm, 'p1', 'm1')
  assert.deepEqual(after, ['low', 'high', 'max'])
  assert.equal(calls, 130, '容量淘汰后重查必须回源（1 首查 + 128 填充 + 1 回源）')
})

test('[3.2.4] resolveSupportedEfforts：模型无 reasoning 元数据 ⇒ 空清单（不发送档位字段）', async () => {
  const freshSpec = '../src/runtime.js?cache-324b=1'
  const fresh: typeof import('../src/runtime.js') = await import(freshSpec)
  const llm = { resolveModelInfo: async () => ({}) }
  const list = await fresh.resolveSupportedEfforts(llm, 'p2', 'm2')
  assert.deepEqual(list, [])
})

test('[3.2.4] leaderPreRegisterEnabled：默认关；1/true/on 开', async () => {
  const freshSpec = '../src/runtime.js?prereg-324=1'
  const fresh: typeof import('../src/runtime.js') = await import(freshSpec)
  assert.equal(fresh.leaderPreRegisterEnabled(), false)
  for (const value of ['1', 'true', 'on']) {
    process.env.DSH_WORKPLAN_LEADER_PRE_REGISTER = value
    assert.equal(fresh.leaderPreRegisterEnabled(), true, `值 ${value} 必须开启`)
    delete process.env.DSH_WORKPLAN_LEADER_PRE_REGISTER
  }
  process.env.DSH_WORKPLAN_LEADER_PRE_REGISTER = '0'
  assert.equal(fresh.leaderPreRegisterEnabled(), false)
  delete process.env.DSH_WORKPLAN_LEADER_PRE_REGISTER
})

test('[3.2.4][W3] F11 sources 契约：只需专家名，成果一句话由平台自动补充', () => {
  const spec = renderDepartmentSummarySpec()
  assert.match(spec, /每条只写专家名即可/)
  assert.match(spec, /成果一句话由平台从各专家汇报自动补充/)
  assert.doesNotMatch(spec, /专家名：一句关键成果/, '旧的一句话要求必须移除')
})

test('[3.2.4] planDelegations 透传预登记载荷（startPhases/timeNotice 随 members 返回）', () => {
  const plan = planDelegations({
    consolidation: {
      taskReasoningEffort: 'high',
      assignments: [{
        member: '专家A',
        role: 'expert',
        task: '单一目标子任务（单一主产物、可独立验收）',
        qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
        reasoningEffort: 'high',
        startPhases: { planning: { problemAnalysis: ['梳理'] }, preparation: { prepared: ['已备'] } },
        timeNotice: { declaredMinutes: 30 },
      }],
    },
    model: 'gpt-4o',
    singleStagePlan: true,
  })
  assert.equal(plan.ok, true, plan.error ?? '')
  const member: any = plan.members[0]
  assert.deepEqual((member as any).startPhases, { planning: { problemAnalysis: ['梳理'] }, preparation: { prepared: ['已备'] } })
  assert.deepEqual((member as any).timeNotice, { declaredMinutes: 30 })
})
