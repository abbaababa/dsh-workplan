/*
 * [2.2.7] 推理档位兼容性钳制（用户 2026-11-09 报告的 PLANNER_LLM_ERROR 根因）。
 *
 * 事故现场：主链路 provider=qw / model=qwen3.8-flash，规划器默认档 max 不在该
 * 模型声明的 reasoning.efforts 清单（low/medium/xhigh）内，宿主 dsh-llm 在网络
 * 调用前直接抛 UNSUPPORTED_REASONING_EFFORT；该码不在可重试清单里 → 终态 → 唯一
 * 一次尝试即降级，整个自动分解还没开始就结束。同一枚雷在派发侧：计划里的
 * high/max 行派给 qwen 子会话会同样即抛（专家执行期中断的根因之一）。
 *
 * 契约：
 *  1. clampEffortToSupported 纯函数：清单内原样、否则钳到「不高于请求档」里最高的
 *     支持档；全部更强时取最弱支持档；空清单返回 undefined（= 不发送该字段）；
 *  2. 宿主不暴露 resolveModelInfo（旧宿主/测试夹具）⇒ 行为与修复前逐字节一致；
 *  3. 规划器实际发出的档位 = 钳制后档位，遥测记录实际值与 clamped 来源；
 *  4. 派发侧子会话 agentOptions 同样钳制（max→xhigh、high→medium、low→low）；
 *  5. 模型无 reasoning 元数据 ⇒ 不发送 reasoningEffort（发送必被宿主拒绝）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { clampEffortToSupported, dispatchPlan, resolveSupportedEfforts, runPlanner } from '../src/runtime.js'
import { createStatuses, validatePlan } from '../src/plan.js'

const QWEN_EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'xhigh', name: 'Extra High' },
]

/* ---------- 1. 纯函数：钳制规则 ---------- */

test('clampEffortToSupported：清单包含时原样、否则钳到不高于请求档的最高支持档', () => {
  assert.equal(clampEffortToSupported('max', ['low', 'medium', 'xhigh']), 'xhigh')
  assert.equal(clampEffortToSupported('high', ['low', 'medium', 'xhigh']), 'medium')
  assert.equal(clampEffortToSupported('low', ['low', 'medium', 'xhigh']), 'low')
  assert.equal(clampEffortToSupported('max', ['low', 'high', 'max']), 'max')
  assert.equal(clampEffortToSupported('high', ['low', 'high', 'max']), 'high')
})

/*
 * [2.2.7][T5/五档] 五档请求落在两类三档能力清单上的完整降级矩阵。
 *
 * 固化 T4 交付并经验收的语义（runtime.ts:249-255 注释同款）：向下钳制到
 * 「不高于请求档」的最近支持档——宁降质不失败，任何合法五档值都不会被
 * 拒绝或清空。注意：这是既有强度表（off<minimal<low<medium<high<xhigh<max）
 * 的直接推论：medium 在 low 与 high 之间，落在 low/high/max 清单上必然
 * medium→low（而不是抬高到 high——抬高会违反「不高于请求档」契约，把
 * 轻度成本任务静默升档多花钱）。xhigh→high 同理落在两档之间。
 */
test('clampEffortToSupported：五档全量落两类三档清单，降级序与强度表一致', () => {
  const THREE = ['low', 'high', 'max']
  // 落在非 qwen 型三档清单（low/high/max）：max 原样、xhigh→high、high 原样、medium→low、low 原样。
  assert.deepEqual(
    ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => clampEffortToSupported(e, THREE)),
    ['low', 'low', 'high', 'high', 'max'],
    '五档在 low/high/max 清单上的降级序必须逐级下探、永不抛错或清空',
  )
  const QWEN = ['low', 'medium', 'xhigh']
  // 落在 qwen 型清单（low/medium/xhigh）：max→xhigh、xhigh 原样、high→medium、medium 原样、low 原样。
  assert.deepEqual(
    ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => clampEffortToSupported(e, QWEN)),
    ['low', 'medium', 'medium', 'xhigh', 'xhigh'],
    '五档在 low/medium/xhigh 清单上的降级序必须与 AGENTS 规则 21 的模型档位面一致',
  )
  // 五档全声明清单 ⇒ 全部原样透传，不发生任何钳制。
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
  assert.deepEqual(FIVE.map((e) => clampEffortToSupported(e, FIVE)), FIVE,
    '模型声明支持五档时任何请求档都不得被改动')
  // 新档位 medium/xhigh 在空清单/null 下同样安全（不发送字段，不抛错）。
  assert.equal(clampEffortToSupported('medium', []), undefined)
  assert.equal(clampEffortToSupported('xhigh', null), undefined)
  // 清单乱序不影响（内部按强度排序）。
  assert.equal(clampEffortToSupported('medium', ['max', 'low', 'high']), 'low')
  assert.equal(clampEffortToSupported('xhigh', ['max', 'high', 'low']), 'high')
})

test('clampEffortToSupported：全部支持档都更强时取最弱支持档（宁降质不失败）', () => {
  assert.equal(clampEffortToSupported('low', ['high', 'xhigh']), 'high')
  assert.equal(clampEffortToSupported('off', ['medium', 'high']), 'medium')
})

test('clampEffortToSupported：空清单 / null / 非数组 ⇒ undefined（调用方据此不发送字段）', () => {
  assert.equal(clampEffortToSupported('max', []), undefined)
  assert.equal(clampEffortToSupported('max', null), undefined)
  assert.equal(clampEffortToSupported('max', undefined), undefined)
})

test('clampEffortToSupported：清单乱序不影响结果（内部按强度排序）', () => {
  assert.equal(clampEffortToSupported('max', ['xhigh', 'low', 'medium']), 'xhigh')
})

/* ---------- 2. resolveSupportedEfforts 能力面探测 ---------- */

test('resolveSupportedEfforts：宿主没有 resolveModelInfo ⇒ null（保持旧行为）', async () => {
  assert.equal(await resolveSupportedEfforts({ stream() {} }, 'p', 'm'), null)
  assert.equal(await resolveSupportedEfforts(undefined, 'p', 'm'), null)
  assert.equal(await resolveSupportedEfforts({ resolveModelInfo() {} }, undefined, 'm'), null)
})

test('resolveSupportedEfforts：读取 efforts id；无 reasoning 元数据 ⇒ 空清单；查询抛错 ⇒ null', async () => {
  const llm: any = {
    async resolveModelInfo(provider: string, model: string) {
      if (model === 'no-reasoning') return { provider, model, id: model }
      if (model === 'boom') throw new Error('provider not registered')
      return { provider, model, id: model, reasoning: { defaultEffort: 'medium', efforts: QWEN_EFFORTS } }
    },
  }
  assert.deepEqual(await resolveSupportedEfforts(llm, 'qw', `qwen-t-${Date.now()}`), ['low', 'medium', 'xhigh'])
  assert.deepEqual(await resolveSupportedEfforts(llm, 'p', 'no-reasoning'), [])
  assert.equal(await resolveSupportedEfforts(llm, 'p', 'boom'), null)
})

/* ---------- 3. runPlanner：qwen 模型上默认 max 必须钳制为 xhigh ---------- */

function minimalPlan(taskText: string) {
  return {
    version: 1,
    title: '钳制用例',
    taskUnderstanding: {
      originalRequest: taskText,
      deliverable: '可复现的测试结果',
      successCriteria: ['断言有输出'],
      constraints: ['不修改既有测试'],
      knownFacts: ['用户报告了 UNSUPPORTED_REASONING_EFFORT'],
      unknowns: ['无'],
      assumptions: ['无'],
    },
    contradictions: {
      primary: { statement: '默认档与模型能力不匹配', evidence: ['宿主本地即抛'], whyPrimary: '分解整体失败' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '验证',
      goal: '验证钳制',
      rationale: '回归用例',
      checkpoint: '断言通过',
      subtasks: [{
        id: 'T1',
        title: '执行钳制回归',
        department: 'qa',
        role: '验证工程师',
        objective: '运行测试并记录结果',
        method: ['执行 node --test'],
        inputs: ['测试文件'],
        outputs: ['测试输出'],
        dependsOn: [],
        acceptance: ['全部用例通过'],
        risk: '无',
      }],
    }],
    risks: [],
    verification: [{ item: '测试通过', method: 'node --test', evidence: '输出' }],
    practiceLoop: { plan: '写用例', do: '跑测试', check: '核对断言', act: '修复' },
  }
}

function plannerCtx(model: 'qwen-clamp' | 'silent' | 'none', seen: any[]) {
  const taskText = '把钳制用例跑通'
  return {
    llm: {
      async resolveModelInfo(provider: string, m: string) {
        if (m === 'none') return { provider, model: m, id: m }
        return { provider, model: m, id: m, reasoning: { defaultEffort: 'medium', efforts: QWEN_EFFORTS } }
      },
      stream(options: any) {
        seen.push(options)
        const json = JSON.stringify(minimalPlan(taskText))
        async function* gen() {
          yield { type: 'text-delta', text: json }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        return { [Symbol.asyncIterator]: () => gen() }
      },
    },
  } as any
}

async function withGuardOff<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_WORKPLAN_CONTEXT_GUARD
  process.env.DSH_WORKPLAN_CONTEXT_GUARD = 'off'
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_CONTEXT_GUARD
    else process.env.DSH_WORKPLAN_CONTEXT_GUARD = previous
  }
}

test('runPlanner：qwen 类模型上默认 max 被钳制为 xhigh 并成功出计划（修复前此处整体降级）', async () => {
  await withGuardOff(async () => {
    const seen: any[] = []
    const telemetry: any = {}
    const stamp = Date.now()
    const plan = await runPlanner(plannerCtx('qwen-clamp', seen), {
      taskText: '把钳制用例跑通',
      cwd: '/tmp',
      sessionId: `session-clamp-${stamp}`,
      modelSelection: { provider: `qw-${stamp}`, model: 'qwen-clamp', reasoningEffort: 'low' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: {},
      sourceMessageIds: [],
      telemetry,
    })
    assert.ok(plan, '计划必须正常返回，而不是降级')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].reasoningEffort, 'xhigh', '发给模型的必须是钳制后的等效档，而不是 max')
    assert.equal(telemetry.reasoningEffort, 'xhigh', '遥测必须记录实际发出值')
    assert.match(String(telemetry.reasoningEffortSource), /clamped\(max\)/, '遥测必须能看出发生过钳制及原请求档')
  })
})

test('runPlanner：模型无 reasoning 元数据 ⇒ 不发送 reasoningEffort（发送必被宿主拒绝）', async () => {
  await withGuardOff(async () => {
    const seen: any[] = []
    const stamp = Date.now()
    const plan = await runPlanner(plannerCtx('none', seen), {
      taskText: '把钳制用例跑通',
      cwd: '/tmp',
      sessionId: `session-clamp-none-${stamp}`,
      modelSelection: { provider: `p-${stamp}`, model: 'none' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: {},
      sourceMessageIds: [],
      telemetry: {},
    })
    assert.ok(plan)
    assert.equal('reasoningEffort' in seen[0], false, '无 reasoning 元数据时该字段必须缺席')
  })
})

test('runPlanner：宿主不暴露 resolveModelInfo（旧宿主兼容）⇒ 与修复前一致直发 max', async () => {
  await withGuardOff(async () => {
    const seen: any[] = []
    const telemetry: any = {}
    const legacyCtx = {
      llm: {
        stream(options: any) {
          seen.push(options)
          const json = JSON.stringify(minimalPlan('把钳制用例跑通'))
          async function* gen() {
            yield { type: 'text-delta', text: json }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
          return { [Symbol.asyncIterator]: () => gen() }
        },
      },
    } as any
    const stamp = Date.now()
    const plan = await runPlanner(legacyCtx, {
      taskText: '把钳制用例跑通',
      cwd: '/tmp',
      sessionId: `session-clamp-legacy-${stamp}`,
      modelSelection: { provider: `p-${stamp}`, model: `legacy-${stamp}` },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: {},
      sourceMessageIds: [],
      telemetry,
    })
    assert.ok(plan)
    assert.equal(seen[0].reasoningEffort, 'max')
    assert.equal(telemetry.reasoningEffortSource, 'default-max', '未钳制时来源标记不得变化')
  })
})

/* ---------- 4. 派发侧：部门子会话同样钳制 ---------- */

/*
 * [2.2.7][T5/五档] 派发侧五档全量钳制回归：五档计划行派发到只声明三档能力的
 * 模型上，逐行按降级序钳制，medium/xhigh 新档位既不即抛也不丢失。
 * 夹具提供 qwen 型清单（low/medium/xhigh）：
 *   low→low、medium→medium、high→medium、xhigh→xhigh、max→xhigh。
 */
test('dispatchPlan：五档子任务派发到 qwen 类模型时按清单逐档钳制（medium/xhigh 不即抛）', async () => {
  const seenFive: any[] = []
  const stampFive = Date.now()
  const subtasksFive = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort, i) => ({
    id: `T${i + 1}`,
    title: `五档任务${i + 1}`,
    department: 'engineering',
    role: '工程师',
    objective: '执行并回传结果',
    method: ['执行'],
    inputs: [],
    outputs: ['结果'],
    dependsOn: [],
    acceptance: ['有结果'],
    risk: '无',
    reasoningEffort: effort,
  }))
  const validatedFive: any = validatePlan({
    version: 1,
    title: '五档派发钳制用例',
    taskUnderstanding: {
      originalRequest: '验证五档派发钳制',
      deliverable: '结果',
      successCriteria: ['有输出'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '五档与三档能力面不匹配', evidence: ['宿主本地即抛'], whyPrimary: '派发期中断' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{ id: 'S1', name: 'S', goal: 'g', rationale: 'r', checkpoint: 'c', subtasks: subtasksFive }],
    risks: [],
    verification: [{ item: 'i', method: 'm', evidence: 'e' }],
    practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
  })
  assert.equal(validatedFive.ok, true, String(validatedFive.errors))
  const ctxFive: any = {
    llm: {
      async resolveModelInfo(provider: string, model: string) {
        return { provider, model, id: model, reasoning: { defaultEffort: 'medium', efforts: QWEN_EFFORTS } }
      },
    },
    subagents: {
      async startActivation(spec: any) {
        seenFive.push(spec?.request?.agentOptions)
        return {
          childId: `child-five-${seenFive.length}`,
          result: Promise.resolve({ output: [{ type: 'text', text: '完成' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
  }
  const recordFive: any = {
    plan: validatedFive.plan,
    statuses: createStatuses(validatedFive.plan),
    errors: [],
    phase: 'planning',
    updatedAt: Date.now(),
  }
  await dispatchPlan(ctxFive, recordFive, {
    agent: {},
    signal: new AbortController().signal,
    modelSelection: { provider: `qw-${stampFive}`, model: `qwen-five-${stampFive}` },
    cwd: process.cwd(),
    conversationContext: '',
    strictEvidence: false,
  })
  assert.equal(seenFive.length, 5, '五个子任务都必须派发，不得因新档位中断')
  assert.deepEqual(seenFive.map((options) => options?.reasoningEffort),
    ['low', 'medium', 'medium', 'xhigh', 'xhigh'],
    '五档派发必须钳制到 qwen 清单内等效档：low原样/medium原样/high→medium/xhigh原样/max→xhigh')
})

test('dispatchPlan：子任务 max/high/low 派发到 qwen 类模型时钳制为 xhigh/medium/low', async () => {
  const subtasks = ['max', 'high', 'low'].map((effort, i) => ({
    id: `T${i + 1}`,
    title: `任务${i + 1}`,
    department: 'engineering',
    role: '工程师',
    objective: '执行并回传结果',
    method: ['执行'],
    inputs: [],
    outputs: ['结果'],
    dependsOn: [],
    acceptance: ['有结果'],
    risk: '无',
    reasoningEffort: effort,
  }))
  const validated: any = validatePlan({
    version: 1,
    title: '派发钳制用例',
    taskUnderstanding: {
      originalRequest: '验证派发钳制',
      deliverable: '结果',
      successCriteria: ['有输出'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '默认档与模型能力不匹配', evidence: ['宿主本地即抛'], whyPrimary: '派发期即中断' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{ id: 'S1', name: 'S', goal: 'g', rationale: 'r', checkpoint: 'c', subtasks }],
    risks: [],
    verification: [{ item: 'i', method: 'm', evidence: 'e' }],
    practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
  })
  assert.equal(validated.ok, true, String(validated.errors))

  const stamp = Date.now()
  const seen: any[] = []
  const ctx: any = {
    llm: {
      async resolveModelInfo(provider: string, model: string) {
        return { provider, model, id: model, reasoning: { defaultEffort: 'medium', efforts: QWEN_EFFORTS } }
      },
    },
    subagents: {
      async startActivation(spec: any) {
        seen.push(spec?.request?.agentOptions)
        return {
          childId: `child-${seen.length}`,
          result: Promise.resolve({ output: [{ type: 'text', text: '完成' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
  }
  const record: any = {
    plan: validated.plan,
    statuses: createStatuses(validated.plan),
    errors: [],
    phase: 'planning',
    updatedAt: Date.now(),
  }
  await dispatchPlan(ctx, record, {
    agent: {},
    signal: new AbortController().signal,
    modelSelection: { provider: `qw-${stamp}`, model: 'qwen-dispatch' },
    cwd: process.cwd(),
    conversationContext: '',
    strictEvidence: false,
  })
  assert.equal(seen.length, 3, '三个子任务都必须派发')
  assert.deepEqual(seen.map((options) => options?.reasoningEffort), ['xhigh', 'medium', 'low'],
    '派发档位必须钳制到模型声明清单内的等效档')
})
