/*
 * [2.2.0][T13/推理等级] 子 Agent 推理等级治理。
 * [2.2.7][T5/五档扩展] 本文件由三档契约升级为五档契约（用户 2026-11-09 要求）。
 *
 * 用户强制规则原文（五档版）：「禁止子agent继承主agent的推理等级，子agent必须
 * 根据自身任务的复杂度，自己使用推理等级，其中，轻度复杂的任务必须使用 low，
 * 中等复杂的任务必须使用 medium 或 high，非常复杂的任务必须使用 xhigh 或 max。
 * 推理等级包括 low、medium、high、xhigh 或 max。」
 *
 * 本文件验证的契约：
 * 1. reasoningEffort 只接受 low / medium / high / xhigh / max 五档；
 * 2. 非法值（含大小写/空格变体）被拒绝且错误点名 reasoningEffort、写明五档合法集；
 * 3. 缺失时回落 high（中等默认，D1 决策保持）；
 * 4. 规划器提示词含五档 OR 映射、五个示例、二选一消歧规则与「禁止继承」；
 * 5. 旧三档（low/high/max）计划 JSON 全部原样校验通过——向后兼容零迁移；
 * 6. 计划消息序列化/解析往返保留该字段（回放兼容）；
 * 7. 部门子会话 agentOptions 携带子任务自己的档位，不继承主 Agent（五档双向验证）；
 * 8. replan replace/add 显式 medium/xhigh 不丢失、非法值入口即拒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildPlannerPrompt,
  createStatuses,
  DEFAULT_REASONING_EFFORT,
  parseWorkplanMessage,
  REASONING_EFFORTS,
  validatePlan,
} from '../src/plan.js'
import { dispatchPlan } from '../src/runtime.js'
import { planReplan } from '../src/replan.js'

/** 一个满足 readSubtasks 全部必填项的最小子任务。 */
function subtask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'T1',
    title: '完成子任务',
    department: 'engineering',
    role: '资深工程师',
    objective: '按验收标准完成工作',
    method: ['按步骤执行'],
    inputs: [],
    outputs: ['结果说明'],
    dependsOn: [],
    acceptance: ['结果可核对'],
    risk: '无',
    ...overrides,
  }
}

/** 一个满足 validatePlan 全部必填项的最小计划（阶段/子任务由用例注入）。 */
function planWith(subtasks: any[]) {
  return {
    version: 1,
    title: '推理等级用例',
    taskUnderstanding: {
      originalRequest: '验证子任务推理等级的校验与派发',
      deliverable: '可复现的测试结果',
      successCriteria: ['每个断言都有输出'],
      constraints: ['不修改既有测试'],
      knownFacts: ['用户要求 low / medium / high / xhigh / max 五档'],
      unknowns: ['宿主运行时实际生效值待集成环境验证'],
      assumptions: ['校验层与派发层复用同一字段'],
    },
    contradictions: {
      primary: {
        statement: '继承主 Agent 等级与子任务自决之间的矛盾',
        evidence: ['旧实现把父等级透传给子会话'],
        whyPrimary: '决定子 Agent 是否按自身复杂度工作',
      },
      secondary: ['旧计划回放兼容'],
      transformationConditions: ['缺失字段时回落 high 即可兼容'],
    },
    stages: [
      {
        id: 'S1',
        name: '单阶段',
        goal: '覆盖五档、非法值与缺省',
        rationale: '最小计划即可验证字段',
        checkpoint: '断言全部通过',
        subtasks,
      },
    ],
    risks: [
      {
        risk: '断言失真',
        likelihood: 'low',
        impact: '误判实现',
        mitigation: '直接断言字段值',
        trigger: '出现红灯',
      },
    ],
    verification: [{ item: '字段被保留', method: '单元测试', evidence: 'node --test 输出' }],
    practiceLoop: { plan: '写用例', do: '执行', check: '看输出', act: '修正' },
  }
}

test('reasoningEffort 白名单恰为五档 low / medium / high / xhigh / max，且原样保留', () => {
  // A1①：事实源常量本身必须是五档、顺序固定（唯一白名单，禁止漂移）。
  assert.deepEqual([...REASONING_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max'],
    '白名单必须恰为五档（用户 2026-11-09 要求：三档扩五档）')
  // A1②：五档逐值遍历——每档都通过校验且不改写、不降级。
  for (const effort of REASONING_EFFORTS) {
    const result = validatePlan(planWith([subtask({ reasoningEffort: effort })]))
    assert.equal(result.ok, true, `${effort} 应通过校验：${JSON.stringify(result.errors)}`)
    assert.equal(result.plan!.stages[0].subtasks[0].reasoningEffort, effort)
  }
})

test('A3 非法 reasoningEffort 被拒绝且错误点名该字段并写明五档合法集', () => {
  // 'foo'/'LOW'/'Medium' 为任务指定样本；其余覆盖乱值、大小写与空格变体。
  for (const effort of ['foo', 'LOW', 'Medium', 'off', 'ultra', 'xhighX', ' MAX', '', 'max\n']) {
    const result = validatePlan(planWith([subtask({ reasoningEffort: effort })]))
    assert.equal(result.ok, false, `${JSON.stringify(effort)} 必须被拒绝`)
    const errors = (result.errors ?? []).join('\n')
    assert.match(errors, /reasoningEffort/, `错误必须点名 reasoningEffort：${errors}`)
    assert.match(errors, /low \/ medium \/ high \/ xhigh \/ max/, `错误必须写明五档合法取值：${errors}`)
  }
  // 非法值绝不允许被静默改写后放行（拒绝语义，不是回落语义——回落只属于缺失路径）。
  const result = validatePlan(planWith([subtask({ reasoningEffort: 'foo' })]))
  assert.equal(result.ok, false)
  assert.ok((result.errors ?? []).filter((e: any) => /reasoningEffort/.test(String(e))).length >= 1,
    '拒绝错误必须点名 reasoningEffort 字段')
})

test('缺省回落 high（中等默认），绝不继承主 Agent 的等级', () => {
  const result = validatePlan(planWith([subtask()]))
  assert.equal(result.ok, true)
  assert.equal(result.plan!.stages[0].subtasks[0].reasoningEffort, 'high')
  assert.equal(DEFAULT_REASONING_EFFORT, 'high')
})

/*
 * A2 向后兼容回归：旧三档体系（v2.2.0–v2.2.6）写出的计划必须零迁移继续可用。
 * low/high/max 是五档集合的子集，校验、保留、序列化回放全部按原值通过；
 * 显式 null/undefined 仍走缺失回落，不报错。
 */
test('A2 旧三档 plan JSON 回归：low/high/max 原值通过、序列化往返零迁移', () => {
  const legacy = planWith([
    subtask({ id: 'T1', title: '轻任务', reasoningEffort: 'low' }),
    subtask({ id: 'T2', title: '中等任务', reasoningEffort: 'high' }),
    subtask({ id: 'T3', title: '复杂任务', reasoningEffort: 'max' }),
    subtask({ id: 'T4', title: '旧格式无该字段' }),
  ])
  const result = validatePlan(legacy)
  assert.equal(result.ok, true, `旧三档计划必须继续通过校验：${JSON.stringify(result.errors)}`)
  const efforts = result.plan!.stages[0].subtasks.map((item: any) => item.reasoningEffort)
  assert.deepEqual(efforts, ['low', 'high', 'max', 'high'], '旧值原样保留；缺失字段按旧语义回落 high')

  // 序列化/解析往返：模拟旧计划消息的回放路径（replay 兼容）。
  const plan = {
    ...result.plan!,
    planId: 'wp-legacy3',
    sessionId: 'session-legacy3',
    createdTurn: 1,
    createdAt: 1000,
    sourceMessageIds: ['m1'],
  }
  const parsed = parseWorkplanMessage(buildPlanMessage(plan))
  assert.ok(parsed, '旧三档计划消息必须能被解析')
  const replayed = parsed.plan.stages[0].subtasks.map((item: any) => item.reasoningEffort)
  assert.deepEqual(replayed, ['low', 'high', 'max', 'high'], '回放后档位不得变化')

  // reasoningEffort: null 等价缺失（旧入口容错语义保持）。
  const nulled = validatePlan(planWith([subtask({ reasoningEffort: null })]))
  assert.equal(nulled.ok, true)
  assert.equal(nulled.plan!.stages[0].subtasks[0].reasoningEffort, 'high')
})

test('规划器提示词包含五档 OR 映射、五个示例、消歧规则与「禁止继承」', () => {
  const prompt = buildPlannerPrompt('测试任务', '/tmp', '', {})
  // 用户要求的映射原文逐字锁定：轻度=low／中等=medium或high／非常=xhigh或max。
  assert.match(prompt, /轻度复杂="low"/, '必须写明轻度=low')
  assert.match(prompt, /中等复杂="medium"或"high"/, '必须写明中等=medium或high')
  assert.match(prompt, /非常复杂="xhigh"或"max"/, '必须写明非常复杂=xhigh或max')
  // 五档各自示例，防止新档位无锚点导致 LLM 输出抖动。
  assert.match(prompt, /整理并校对一份已有清单="low"/, '缺少低档示例')
  assert.match(prompt, /补充单个工具函数并补齐单元测试="medium"/, '缺少 medium 示例')
  assert.match(prompt, /独立实现一个模块并补齐测试="high"/, '缺少中档示例')
  assert.match(prompt, /跨多个模块排查根因并修复="xhigh"/, '缺少 xhigh 示例')
  assert.match(prompt, /跨多个系统排查根因并给出架构级修复方案="max"/, '缺少高档示例')
  // OR 语义消歧必须成文（D2 决策）：同等输入产生稳定档位。
  assert.match(prompt, /优先选择较低档（medium 优先于 high，xhigh 优先于 max）/, '缺少二选一消歧规则')
  // 白名单话术与禁止继承、缺省回落语义同步为五档。
  assert.match(prompt, /只允许 low \/ medium \/ high \/ xhigh \/ max 五档/, '必须写明五档合法集')
  assert.match(prompt, /禁止沿用\/继承主 Agent 的推理等级/, '必须明确禁止继承')
  assert.match(prompt, /缺失时执行侧回落 "high"/, '必须写明缺省回落 high')
  assert.match(prompt, /"reasoningEffort": "high"/, 'JSON 示例必须包含该字段')
})

test('计划消息序列化/解析往返保留 reasoningEffort（回放兼容）', () => {
  const validated = validatePlan(planWith([subtask({ reasoningEffort: 'max' })]))
  assert.equal(validated.ok, true)
  const plan = {
    ...validated.plan!,
    planId: 'wp-t13',
    sessionId: 'session-t13',
    createdTurn: 1,
    createdAt: 1000,
    sourceMessageIds: ['m1'],
  }
  const parsed = parseWorkplanMessage(buildPlanMessage(plan))
  assert.ok(parsed, '计划消息必须能被解析')
  assert.equal(parsed.plan.stages[0].subtasks[0].reasoningEffort, 'max')
})

test('部门子会话档位只由子任务自身复杂度决定：主 Agent 五档全试结果完全一致', async () => {
  const validated = validatePlan(planWith([
    subtask({ id: 'T1', title: '轻任务', reasoningEffort: 'low' }),
    subtask({ id: 'T2', title: '中等任务（显式）', reasoningEffort: 'high' }),
    subtask({ id: 'T3', title: '复杂任务', reasoningEffort: 'max' }),
    subtask({ id: 'T4', title: '中等任务（缺省）' }),
    subtask({ id: 'T5', title: '中等任务（新档显式）', reasoningEffort: 'medium' }),
    subtask({ id: 'T6', title: '复杂任务（新档显式）', reasoningEffort: 'xhigh' }),
  ]))
  assert.equal(validated.ok, true)

  /*
   * 每档主 Agent 都重新派发一次同一份计划，收集子会话 agentOptions 里的档位。
   * 断言目标：五张表完全相同 = 子任务档位与主 Agent 档位无关（A1）；并且
   * 主 Agent=max 时简单子任务仍是 low、主 Agent=low 时复杂子任务仍是 max/xhigh。
   * 若实现把 modelSelection.reasoningEffort 接回子会话，各表会跟着变。
   * [2.2.7][T5] 主 Agent 表从三档扩为五档（含 medium/xhigh），新档位行 T5/T6
   * 同样不得被继承改写。
   */
  const effortsOf = async (mainEffort: string) => {
    const plan = structuredClone(validated.plan!)
    const record: any = {
      plan,
      statuses: createStatuses(plan),
      errors: [],
      phase: 'planning',
      updatedAt: Date.now(),
    }
    const seen: Array<{ id: string; effort: any }> = []
    const ctx: any = {
      subagents: {
        async startActivation(spec: any) {
          const label = String(spec?.label ?? '')
          const id = label.match(/:(T\d+)\s/)?.[1] ?? ''
          seen.push({ id, effort: spec?.request?.agentOptions?.reasoningEffort })
          return {
            childId: `child-${mainEffort}-${seen.length}`,
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
      // 主 Agent 档位故意逐档变化：子会话若继承就会看到与该档相同的值。
      modelSelection: { provider: 'test', model: 'test', reasoningEffort: mainEffort },
      cwd: process.cwd(),
      conversationContext: '',
      strictEvidence: false,
    })
    assert.equal(result.statuses.filter((item: any) => item.status === 'blocked').length, 0,
      `主 Agent=${mainEffort} 时派发不得受阻：${JSON.stringify(result.errors ?? [])}`)
    return Object.fromEntries(seen.map((item) => [item.id, item.effort]))
  }

  const expected = { T1: 'low', T2: 'high', T3: 'max', T4: 'high', T5: 'medium', T6: 'xhigh' }
  const low = await effortsOf('low')
  const medium = await effortsOf('medium')
  const high = await effortsOf('high')
  const xhigh = await effortsOf('xhigh')
  const max = await effortsOf('max')

  assert.deepEqual(low, expected, '主 Agent=low 时子任务档位必须只由自身复杂度决定')
  assert.deepEqual(medium, expected, '主 Agent=medium 时子任务档位不得改变')
  assert.deepEqual(high, expected, '主 Agent=high 时子任务档位不得改变')
  assert.deepEqual(xhigh, expected, '主 Agent=xhigh 时子任务档位不得改变')
  assert.deepEqual(max, expected, '主 Agent=max 时子任务档位不得改变')
  assert.equal(max.T1, 'low', 'A2：主 Agent=max + 简单子任务 → low')
  assert.equal(low.T3, 'max', '反向组合：主 Agent=low + 复杂子任务 → max')
  assert.equal(low.T6, 'xhigh', '反向组合：主 Agent=low + 新档复杂子任务 → xhigh')
  assert.equal(max.T5, 'medium', '主 Agent=max + 新档中等子任务 → medium（不继承抬高）')
  assert.equal(low.T4, 'high', '缺省档位回落 high（中等默认），不随主 Agent 变化')
})

/*
 * [2.2.0][T13b/推理等级] 重规划是第二个写计划定义的入口，必须与首次规划同强度。
 * 修复前 REPLACEMENT_FIELDS 与 add 固定字段表都没有 reasoningEffort，模型在
 * replace/add 里显式写 low / max 会被静默丢弃，替换/新增行退回缺省 high。
 */
function replanFixture(oldEffort?: string) {
  const validated = validatePlan(planWith([subtask({ id: 'T1', reasoningEffort: oldEffort })]))
  assert.equal(validated.ok, true)
  return {
    ...validated.plan!,
    planId: 'wp-t13b',
    sessionId: 'session-t13b',
    createdTurn: 1,
    createdAt: 1000,
    sourceMessageIds: ['m1'],
  }
}

const REPLAN_OPTIONS = { planId: 'wp-t13b', reason: '需求变更', revision: 2, at: 1_700_000_000_000 }

test('replan replace 保留原行 reasoningEffort，显式覆盖不丢失', () => {
  const plan = replanFixture('max')
  const inherited = planReplan(plan, [{
    action: 'replace',
    subtaskId: 'T1',
    replacement: { title: '改后的任务' },
  }], REPLAN_OPTIONS)
  assert.equal(inherited.ok, true)
  const kept = (inherited as any).payload.plan.stages[0].subtasks.find((item: any) => item.id === 'T1b')
  assert.equal(kept?.reasoningEffort, 'max', '未显式给档位时必须继承原行的 max')

  const overridden = planReplan(plan, [{
    action: 'replace',
    subtaskId: 'T1',
    replacement: { title: '改后的轻任务', reasoningEffort: 'low' },
  }], REPLAN_OPTIONS)
  assert.equal(overridden.ok, true)
  const successor = (overridden as any).payload.plan.stages[0].subtasks.find((item: any) => item.id === 'T1b')
  assert.equal(successor?.reasoningEffort, 'low', 'replacement 里显式的 reasoningEffort 不得被静默丢弃')
})

test('replan add 保留显式 reasoningEffort，缺失时经 readSubtasks 回落 high', () => {
  const plan = replanFixture('max')
  const result = planReplan(plan, [
    {
      action: 'add',
      subtaskId: 'A1',
      newSubtask: { id: 'A1', title: '轻任务', objective: '整理已有清单', department: 'engineering', reasoningEffort: 'low' },
    },
    {
      action: 'add',
      subtaskId: 'A2',
      newSubtask: { id: 'A2', title: '中等任务', objective: '实现一个模块', department: 'engineering' },
    },
  ], REPLAN_OPTIONS)
  assert.equal(result.ok, true)
  const payload = (result as any).payload
  const added = payload.plan.stages
    .flatMap((stage: any) => stage.subtasks)
    .filter((item: any) => item.id === 'A1' || item.id === 'A2')
  assert.equal(added.find((item: any) => item.id === 'A1')?.reasoningEffort, 'low', 'newSubtask 里显式的 low 不得被静默丢弃')

  const revalidated = validatePlan(planWith(added))
  assert.equal(revalidated.ok, true, `重规划新增的子任务必须能通过校验：${JSON.stringify(revalidated.errors)}`)
  const all = revalidated.plan!.stages[0].subtasks
  assert.equal(all.find((item: any) => item.id === 'A1')?.reasoningEffort, 'low')
  assert.equal(all.find((item: any) => item.id === 'A2')?.reasoningEffort, 'high', '缺失档位必须回落 high')
})

/*
 * [2.2.7][T5/五档] replan 入口的五档贯通与 G1 拒绝：
 * T4 在 replan.ts 入口补了与 readSubtasks 同语义的白名单——medium/xhigh
 * 显式值必须透传成功，非法值必须在入口即拒（而不是透传进计划后派发期静默回落）。
 */
test('replan 五档贯通：replace 显式 xhigh / add 显式 medium 透传，非法值入口拒绝', () => {
  const plan = replanFixture('high')
  const ok = planReplan(plan, [
    { action: 'replace', subtaskId: 'T1', replacement: { title: '更重的任务', reasoningEffort: 'xhigh' } },
    {
      action: 'add',
      subtaskId: 'A1',
      newSubtask: { id: 'A1', title: '中等任务', objective: '补单个工具函数与测试', department: 'engineering', reasoningEffort: 'medium' },
    },
  ], REPLAN_OPTIONS)
  assert.equal(ok.ok, true, `五档显式值必须通过 replan 入口：${JSON.stringify((ok as any).errors ?? (ok as any).message)}`)
  const rows = (ok as any).payload.plan.stages.flatMap((stage: any) => stage.subtasks)
  assert.equal(rows.find((item: any) => item.id === 'T1b')?.reasoningEffort, 'xhigh',
    'replacement 里显式的 xhigh 不得被静默丢弃')
  assert.equal(rows.find((item: any) => item.id === 'A1')?.reasoningEffort, 'medium',
    'newSubtask 里显式的 medium 不得被静默丢弃')

  for (const bad of ['foo', 'LOW', 'Medium', 'ultra']) {
    const rejected = planReplan(plan, [
      { action: 'replace', subtaskId: 'T1', replacement: { title: '非法档位', reasoningEffort: bad } },
    ], { ...REPLAN_OPTIONS, reason: `非法档位拒绝用例 ${bad}` })
    assert.notEqual(rejected.ok, true, `${JSON.stringify(bad)} 必须在 replan 入口即拒`)
    assert.match(JSON.stringify(rejected), /low \/ medium \/ high \/ xhigh \/ max/,
      `拒绝理由必须点名五档合法集：${JSON.stringify(rejected).slice(0, 300)}`)
  }
})
