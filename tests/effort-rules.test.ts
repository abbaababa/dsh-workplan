/*
 * [2.3.9][T3] LLM 家族检测与推理等级静态约束——验收用例（用户强制要求 1/2/3/5）。
 *
 * 用户规则原文（要求 1/2）：
 *  1. 字母 qwen 开头的大模型，推理等级只包括 low、medium、xhigh（轻度=low、
 *     比较复杂=medium、非常复杂=xhigh）。
 *  2. 非 qwen 开头的大模型，推理等级只包括 low、high、max（轻度=low、
 *     比较复杂=high、非常复杂=max）。
 *
 * 本文件固化的契约（与 llm-rules.ts / plan.ts 真源注释一致）：
 *  A1. 'qwen3.8' ⇒ 家族 'qwen' ⇒ 等级集合恰为 {low, medium, xhigh}，不含 high/max；
 *  A2. 'gpt-4o' ⇒ 家族 'other' ⇒ 等级集合恰为 {low, high, max}，不含 medium/xhigh；
 *      （大小写/首尾空白不敏感；qwen 不在开头不算 qwen；claude/deepseek/kimi 等均 other）
 *  A3. 越界档位双轨：validateReasoningEffort 给点名集合的明确错误文案（报错轨）；
 *      correctEffortForModel 按强度序自动降级且绝不抛错（修正轨）：
 *      qwen: max→xhigh、high→medium；非 qwen: xhigh→high、medium→low；
 *      模型名缺失 ⇒ null ⇒ 不施加静态约束、原样透传（防凭空收紧）；
 *  A3b. 派发集成：即使宿主不提供能力清单（旧宿主），派发前也按家族集合收窄
 *      （静态闸先于、独立于 [2.2.7] 能力闸）；复杂度映射（要求 1/2 数值化）。
 *  A3c. 规划器集成：qwen 命名模型上默认 max 即使无能力清单也被静态修正为 xhigh。
 *  告知事实源：LLM_REASONING_RULES_TEXT 含要求 1/2 全部档位（供部门告知注入引用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  allowedEffortsForModel,
  correctEffortForModel,
  detectLlmType,
  effortForComplexity,
  getAllowedEffortLevels,
  LLM_REASONING_RULES_TEXT,
  validateReasoningEffort,
} from '../src/llm-rules.js'
import { dispatchPlan, runPlanner } from '../src/runtime.js'
import { createStatuses, validatePlan } from '../src/plan.js'

/* ---------- 1. 家族检测（A1/A2 的判定层） ---------- */

test('A1 检测：qwen3.8 → qwen 家族（大小写/空白不敏感，非开头不算）', () => {
  assert.equal(detectLlmType('qwen3.8'), 'qwen')
  assert.equal(detectLlmType('qwen3.8-flash'), 'qwen')
  assert.equal(detectLlmType('Qwen3.8'), 'qwen')
  assert.equal(detectLlmType('  QWEN-max  '), 'qwen')
  assert.equal(detectLlmType('notqwen-1'), 'other')
  assert.equal(detectLlmType(undefined), null)
  assert.equal(detectLlmType(''), null)
})

test('A1 集合：qwen3.8 → 恰为 {low,medium,xhigh}，不含 high/max', () => {
  assert.deepEqual([...allowedEffortsForModel('qwen3.8')!].sort(), ['low', 'medium', 'xhigh'])
  assert.deepEqual([...getAllowedEffortLevels('qwen')!].sort(), ['low', 'medium', 'xhigh'])
  assert.equal(allowedEffortsForModel('qwen3.8')!.includes('high'), false)
  assert.equal(allowedEffortsForModel('qwen3.8')!.includes('max'), false)
})

test('A2 集合：gpt-4o → 恰为 {low,high,max}，不含 medium/xhigh；其他家族抽查', () => {
  assert.equal(detectLlmType('gpt-4o'), 'other')
  assert.deepEqual([...allowedEffortsForModel('gpt-4o')!].sort(), ['high', 'low', 'max'])
  assert.equal(allowedEffortsForModel('gpt-4o')!.includes('medium'), false)
  assert.equal(allowedEffortsForModel('gpt-4o')!.includes('xhigh'), false)
  for (const id of ['claude-sonnet-4-5', 'deepseek-v3', 'kimi-k2', 'GLM-4.6']) {
    assert.equal(detectLlmType(id), 'other', id)
    assert.deepEqual([...allowedEffortsForModel(id)!].sort(), ['high', 'low', 'max'], id)
  }
})

test('A2b 模型名缺失 → null = 不施加静态约束（保持旧行为）', () => {
  assert.equal(allowedEffortsForModel(null), null)
  assert.equal(allowedEffortsForModel(undefined), null)
  assert.equal(getAllowedEffortLevels(null), null)
})

/* ---------- 2. A3 双轨：明确报错 + 自动修正 ---------- */

test('A3 报错轨：越界档 → ok=false 且错误文案点名家族集合', () => {
  const bad = validateReasoningEffort('max', allowedEffortsForModel('qwen3.8'))
  assert.equal(bad.ok, false)
  assert.match(bad.error!, /low, medium, xhigh/)
  assert.match(bad.error!, /qwen/)
  const good = validateReasoningEffort('medium', allowedEffortsForModel('qwen3.8'))
  assert.equal(good.ok, true)
  // 模型未知（null 集合）⇒ 任何值合法（不凭空收紧）
  assert.equal(validateReasoningEffort('xhigh', null).ok, true)
})

test('A3 修正轨：越界档按强度序自动降级，集合内原样，绝不抛错', () => {
  const shape = (c: { effort: string; adjusted: boolean }) => ({ effort: c.effort, adjusted: c.adjusted })
  // qwen 集合外：max→xhigh、high→medium；集合内原样
  assert.deepEqual(shape(correctEffortForModel('max', 'qwen3.8')), { effort: 'xhigh', adjusted: true })
  assert.deepEqual(shape(correctEffortForModel('high', 'qwen3.8')), { effort: 'medium', adjusted: true })
  assert.deepEqual(shape(correctEffortForModel('xhigh', 'qwen3.8')), { effort: 'xhigh', adjusted: false })
  assert.deepEqual(shape(correctEffortForModel('medium', 'qwen3.8')), { effort: 'medium', adjusted: false })
  // 非 qwen 集合外：xhigh→high、medium→low；集合内原样
  assert.deepEqual(shape(correctEffortForModel('xhigh', 'gpt-4o')), { effort: 'high', adjusted: true })
  assert.deepEqual(shape(correctEffortForModel('medium', 'gpt-4o')), { effort: 'low', adjusted: true })
  assert.deepEqual(shape(correctEffortForModel('max', 'gpt-4o')), { effort: 'max', adjusted: false })
  // 修正留痕可读（含规则名与集合）
  const trace = correctEffortForModel('max', 'qwen3.8')
  assert.match(trace.reason!, /qwen-rule:max→xhigh/)
  assert.match(trace.reason!, /low, medium, xhigh/)
  // 模型名缺失 ⇒ 原样透传
  assert.deepEqual(shape(correctEffortForModel('xhigh', null)), { effort: 'xhigh', adjusted: false })
})

test('复杂度映射（要求 1/2 的轻度/比较复杂/非常复杂数值化）', () => {
  assert.equal(effortForComplexity('qwen', 'light'), 'low')
  assert.equal(effortForComplexity('qwen', 'moderate'), 'medium')
  assert.equal(effortForComplexity('qwen', 'heavy'), 'xhigh')
  assert.equal(effortForComplexity('other', 'light'), 'low')
  assert.equal(effortForComplexity('other', 'moderate'), 'high')
  assert.equal(effortForComplexity('other', 'heavy'), 'max')
  assert.equal(effortForComplexity(null, 'heavy'), null)
})

test('告知事实源：LLM_REASONING_RULES_TEXT 完整含要求 1/2 档位（T4 注入同引用）', () => {
  assert.match(LLM_REASONING_RULES_TEXT, /low、medium、xhigh/)
  assert.match(LLM_REASONING_RULES_TEXT, /low、high、max/)
  assert.match(LLM_REASONING_RULES_TEXT, /qwen/)
})

/* ---------- 3. A3b 派发集成：旧宿主无能力清单时静态闸仍生效，且先于派发 ---------- */

const FIVE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function planWithEfforts(prefix: string, efforts: readonly string[]) {
  return {
    version: 1,
    title: `${prefix}静态闸用例`,
    taskUnderstanding: {
      originalRequest: `${prefix}静态闸用例`,
      deliverable: '结果',
      successCriteria: ['有输出'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '静态集合与请求档不匹配', evidence: ['用户要求 1/2'], whyPrimary: '派发会被宿主拒绝' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '执行',
      goal: '验证静态闸',
      rationale: '回归用例',
      checkpoint: '断言通过',
      subtasks: efforts.map((effort, i) => ({
        id: `T${i + 1}`,
        title: `静态任务${i + 1}`,
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
      })),
    }],
    risks: [],
    verification: [{ item: 'i', method: 'm', evidence: 'e' }],
    practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
  }
}

/** 旧宿主形态：llm 存在但没有 resolveModelInfo ⇒ 能力闸不介入，只考察静态闸。 */
function legacyCtx(seen: any[]) {
  return {
    llm: {},
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
  } as any
}

async function dispatchLegacyHost(model: string, efforts: readonly string[]) {
  const stamp = Date.now()
  const validated: any = validatePlan(planWithEfforts(model, efforts))
  assert.equal(validated.ok, true, String(validated.errors))
  const seen: any[] = []
  const record: any = {
    plan: validated.plan,
    statuses: createStatuses(validated.plan),
    errors: [],
    phase: 'planning',
    updatedAt: Date.now(),
  }
  await dispatchPlan(legacyCtx(seen), record, {
    agent: {},
    signal: new AbortController().signal,
    modelSelection: { provider: `p-${stamp}`, model },
    cwd: process.cwd(),
    conversationContext: '',
    strictEvidence: false,
  })
  return seen.map((options) => options?.reasoningEffort)
}

test('A3b 派发（旧宿主+qwen 命名模型）：五档请求被静态闸收窄为 low/medium/medium/xhigh/xhigh', async () => {
  const observed = await dispatchLegacyHost(`qwen-static-${Date.now()}`, FIVE_EFFORTS)
  assert.deepEqual(observed, ['low', 'medium', 'medium', 'xhigh', 'xhigh'],
    '静态闸必须先于派发独立生效：high→medium、max→xhigh（要求 1 硬白名单）')
})

test('A3b 派发（旧宿主+非 qwen 模型）：五档请求被静态闸收窄为 low/low/high/high/max', async () => {
  const observed = await dispatchLegacyHost(`gpt-static-${Date.now()}`, FIVE_EFFORTS)
  assert.deepEqual(observed, ['low', 'low', 'high', 'high', 'max'],
    '要求 2 硬白名单：medium→low、xhigh→high')
})

/* ---------- 4. A3c 规划器集成：无能力清单时默认 max 被静态修正为 xhigh ---------- */

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

test('A3c 规划器（旧宿主+qwen 命名模型）：默认 max 被静态闸修正为 xhigh 后发送', async () => {
  await withGuardOff(async () => {
    const seen: any[] = []
    const stamp = Date.now()
    const ctx: any = {
      llm: {
        stream(options: any) {
          seen.push(options)
          const json = JSON.stringify(planWithEfforts('planner-static', ['medium']))
          async function* gen() {
            yield { type: 'text-delta', text: json }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
          return { [Symbol.asyncIterator]: () => gen() }
        },
      },
    }
    const plan = await runPlanner(ctx, {
      taskText: '静态闸规划用例',
      cwd: '/tmp',
      sessionId: `session-effort-rules-${stamp}`,
      modelSelection: { provider: `p-${stamp}`, model: `qwen-planner-${stamp}`, reasoningEffort: 'low' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: {},
      sourceMessageIds: [],
      telemetry: {},
    })
    assert.ok(plan, '规划必须成功产出，静态修正不得中断链路')
    assert.equal(seen[0]?.reasoningEffort, 'xhigh',
      'qwen 家族静态闸下规划器请求档 max 必须先降为合法集最高档 xhigh（独立于能力闸）')
  })
})
