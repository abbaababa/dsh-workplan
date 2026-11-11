/*
 * [2.3.9][T3] LLM 家族静态规则验收（effort-rules 补充卷）。
 * 真源=plan.ts：classifyModelFamily/allowedEffortsForModel/复杂度映射/最高档；
 * 工具层=llm-rules.ts：validateReasoningEffort(报错轨)/correctEffortForModel(修正轨)。
 * 与 tests/effort-rules.test.ts（[2.2.7] 能力面钳制契约）互补、同时全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REASONING_EFFORTS,
  allowedEffortsForModel,
  classifyModelFamily,
  effortForComplexity,
  highestEffortOf,
  validatePlan,
} from '../src/plan.js'
import {
  LLM_REASONING_RULES_TEXT,
  correctEffortForModel,
  detectLlmType,
  validateReasoningEffort,
} from '../src/llm-rules.js'

test('[2.3.9/A1] qwen3.8 → {low,medium,xhigh}，不含 high/max', () => {
  assert.equal(classifyModelFamily('qwen3.8'), 'qwen')
  const allowed = allowedEffortsForModel('qwen3.8')
  assert.deepEqual([...(allowed ?? [])].sort(), ['low', 'medium', 'xhigh'])
  assert.equal(allowed?.includes('high'), false)
  assert.equal(allowed?.includes('max'), false)
})

test('[2.3.9/A1] qwen3.8-flash 同样命中（生产现场模型名）', () => {
  assert.equal(classifyModelFamily('qwen3.8-flash'), 'qwen')
  assert.deepEqual([...(allowedEffortsForModel('qwen3.8-flash') ?? [])].sort(), ['low', 'medium', 'xhigh'])
})

test('[2.3.9/A2] gpt-4o / gpt-5 → {low,high,max}，不含 medium/xhigh', () => {
  for (const id of ['gpt-4o', 'gpt-5']) {
    assert.equal(classifyModelFamily(id), 'other', id)
    const allowed = allowedEffortsForModel(id)
    assert.deepEqual([...(allowed ?? [])].sort(), ['high', 'low', 'max'], id)
    assert.equal(allowed?.includes('medium'), false, id)
    assert.equal(allowed?.includes('xhigh'), false, id)
  }
})

test('[2.3.9/A2] 家族抽查 + 大小写/空白容错 + 非前缀不误判', () => {
  assert.equal(classifyModelFamily('claude-sonnet-4-5'), 'other')
  assert.equal(classifyModelFamily('deepseek-v3'), 'other')
  assert.equal(classifyModelFamily('kimi-k2'), 'other')
  assert.equal(classifyModelFamily('Qwen3.8'), 'qwen')
  assert.equal(classifyModelFamily('  qwen-max  '), 'qwen')
  assert.equal(classifyModelFamily('notqwen-1'), 'other')
})

test('[2.3.9/边界] 模型名缺失 ⇒ null ⇒ 不施加静态约束', () => {
  assert.equal(classifyModelFamily(undefined), null)
  assert.equal(classifyModelFamily(''), null)
  assert.equal(allowedEffortsForModel(null), null)
  const untouched = correctEffortForModel('xhigh', null)
  assert.equal(untouched.adjusted, false)
  assert.equal(untouched.effort, 'xhigh')
})

test('[2.3.9/映射] 轻度=low；qwen 中=medium 难=xhigh；非qwen 中=high 难=max', () => {
  assert.equal(effortForComplexity('qwen', 'light'), 'low')
  assert.equal(effortForComplexity('qwen', 'moderate'), 'medium')
  assert.equal(effortForComplexity('qwen', 'heavy'), 'xhigh')
  assert.equal(effortForComplexity('other', 'light'), 'low')
  assert.equal(effortForComplexity('other', 'moderate'), 'high')
  assert.equal(effortForComplexity('other', 'heavy'), 'max')
})

test('[2.3.9/默认档] planner 家族默认=合法集最高档（qwen⇒xhigh、非qwen⇒max）', () => {
  assert.equal(highestEffortOf(allowedEffortsForModel('qwen3.8')), 'xhigh')
  assert.equal(highestEffortOf(allowedEffortsForModel('gpt-5')), 'max')
  assert.equal(highestEffortOf(null), null)
})

test('[2.3.9/A3] validateReasoningEffort：越界给出含家族集合的明确错误', () => {
  const bad = validateReasoningEffort('max', allowedEffortsForModel('qwen3.8'))
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /low, medium, xhigh/)
  assert.equal(validateReasoningEffort('medium', allowedEffortsForModel('qwen3.8')).ok, true)
  assert.equal(validateReasoningEffort('max', allowedEffortsForModel('gpt-5')).ok, true)
  assert.equal(validateReasoningEffort('high', null).ok, true)
})

test('[2.3.9/A3] correctEffortForModel：越界按强度序降级并留痕，集合内原样', () => {
  const cases: Array<[string, string, string]> = [
    ['max', 'qwen3.8', 'xhigh'],
    ['high', 'qwen3.8', 'medium'],
    ['xhigh', 'gpt-5', 'high'],
    ['medium', 'gpt-5', 'low'],
  ]
  for (const [from, model, to] of cases) {
    const c = correctEffortForModel(from, model)
    assert.equal(c.effort, to, `${from}@${model}`)
    assert.equal(c.adjusted, true, `${from}@${model}`)
    assert.match(c.reason ?? '', new RegExp(`${from}→${to}`))
  }
  assert.equal(correctEffortForModel('xhigh', 'qwen3.8').adjusted, false)
  assert.equal(correctEffortForModel('max', 'gpt-5').adjusted, false)
  assert.equal(correctEffortForModel('low', 'gpt-5').effort, 'low')
})

test('[2.3.9/存储] 五档全集不得删档：REASONING_EFFORTS 保持 + 两家族集合并=五档', () => {
  assert.deepEqual([...REASONING_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max'])
  const union = new Set([
    ...(allowedEffortsForModel('qwen3.8') ?? []),
    ...(allowedEffortsForModel('gpt-5') ?? []),
  ])
  for (const id of REASONING_EFFORTS) assert.equal(union.has(id), true, id)
})

function rawPlanWithEffort(effort: string) {
  return {
    version: 1,
    title: '测试计划',
    stages: [{ id: 's1', subtasks: [{ id: 'T1', title: 'x', reasoningEffort: effort }] }],
  }
}
const familyErrors = (result: any) => (result.errors ?? []).filter((e: string) => e.includes('reasoningEffort'))

test('[2.3.9/事前] validatePlan 传 qwen 集合：显式 high 拒绝并点名家族集合', () => {
  const r: any = validatePlan(rawPlanWithEffort('high'), { allowedEfforts: allowedEffortsForModel('qwen3.8') })
  assert.equal(r.ok, false)
  assert.equal(familyErrors(r).length >= 1, true, '必须有 reasoningEffort 点名错误')
  assert.match(familyErrors(r)[0] ?? '', /low \/ medium \/ xhigh/)
})

test('[2.3.9/事前] 合法档位不被家族校验误伤；未传集合=旧调用零迁移（回放兼容）', () => {
  const r: any = validatePlan(rawPlanWithEffort('medium'), { allowedEfforts: allowedEffortsForModel('qwen3.8') })
  assert.equal(familyErrors(r).length, 0)
  const legacy: any = validatePlan(rawPlanWithEffort('high'))
  assert.equal(familyErrors(legacy).length, 0)
  const other: any = validatePlan(rawPlanWithEffort('high'), { allowedEfforts: allowedEffortsForModel('gpt-5') })
  assert.equal(familyErrors(other).length, 0)
})

test('[2.3.9/告知] LLM_REASONING_RULES_TEXT=要求1/2全文事实源（供 T4 注入）', () => {
  assert.match(LLM_REASONING_RULES_TEXT, /low、medium、xhigh/)
  assert.match(LLM_REASONING_RULES_TEXT, /low、high、max/)
  assert.match(LLM_REASONING_RULES_TEXT, /qwen/)
})

test('[2.3.9/别名] detectLlmType ≡ classifyModelFamily', () => {
  for (const id of ['qwen3.8', 'gpt-5', '', undefined]) {
    assert.equal(detectLlmType(id as any), classifyModelFamily(id as any), String(id))
  }
})
