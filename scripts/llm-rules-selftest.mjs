#!/usr/bin/env node
/**
 * [2.3.9][T3] 本地自测：LLM 家族检测 + 推理等级静态约束（llm-rules.js）。
 * 覆盖验收 A1/A2/A3 + 边界（大小写、缺失模型、复杂度映射）。
 * 用法：npm run build 之后 node scripts/llm-rules-selftest.mjs
 */
import assert from 'node:assert/strict'
import {
  detectLlmType,
  getAllowedEffortLevels,
  allowedEffortsForModel,
  effortForComplexity,
  validateReasoningEffort,
  correctEffortForModel,
  LLM_REASONING_RULES_TEXT,
} from '../lib/llm-rules.js'

let passed = 0
const t = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

// A1：qwen 开头模型 ⇒ 集合恰为 {low,medium,xhigh}，不含 high/max
t('A1 qwen3.8 → {low,medium,xhigh}', () => {
  assert.equal(detectLlmType('qwen3.8'), 'qwen')
  const allowed = getAllowedEffortLevels('qwen')
  assert.deepEqual([...allowed].sort(), ['low', 'medium', 'xhigh'])
  assert.equal(allowed.includes('high'), false)
  assert.equal(allowed.includes('max'), false)
  assert.deepEqual([...allowedEffortsForModel('qwen3.8')].sort(), ['low', 'medium', 'xhigh'])
})

// A2：非 qwen 模型 ⇒ 集合恰为 {low,high,max}，不含 medium/xhigh
t('A2 gpt-4o → {low,high,max}', () => {
  assert.equal(detectLlmType('gpt-4o'), 'other')
  const allowed = allowedEffortsForModel('gpt-4o')
  assert.deepEqual([...allowed].sort(), ['high', 'low', 'max'])
  assert.equal(allowed.includes('medium'), false)
  assert.equal(allowed.includes('xhigh'), false)
})

// A2b：其他非 qwen 家族抽查（claude/deepseek/kimi 等）
t('A2b claude-sonnet/deepseek-v3/kimi-k2 → 非qwen集合', () => {
  for (const id of ['claude-sonnet-4-5', 'deepseek-v3', 'kimi-k2', 'GLM-4.6']) {
    assert.equal(detectLlmType(id), 'other', id)
    assert.deepEqual([...allowedEffortsForModel(id)].sort(), ['high', 'low', 'max'], id)
  }
})

// A3：集合外档位 ⇒ 有明确错误信息（校验轨）+ 自动降级修正（修正轨）
t('A3 validate 给出明确错误信息', () => {
  const bad = validateReasoningEffort('max', allowedEffortsForModel('qwen3.8'))
  assert.equal(bad.ok, false)
  assert.match(bad.error, /qwen/)
  assert.match(bad.error, /low, medium, xhigh/)
  const good = validateReasoningEffort('medium', allowedEffortsForModel('qwen3.8'))
  assert.equal(good.ok, true)
})

t('A3 correct 自动降级（按强度序下探，绝不抛错）', () => {
  // qwen 集合外的 max/high → 降级 xhigh/medium；集合内原样
  assert.deepEqual(
    (({ effort, adjusted }) => ({ effort, adjusted }))(correctEffortForModel('max', 'qwen3.8')),
    { effort: 'xhigh', adjusted: true },
  )
  assert.deepEqual(
    (({ effort, adjusted }) => ({ effort, adjusted }))(correctEffortForModel('high', 'qwen3.8')),
    { effort: 'medium', adjusted: true },
  )
  assert.deepEqual(
    (({ effort, adjusted }) => ({ effort, adjusted }))(correctEffortForModel('xhigh', 'qwen3.8')),
    { effort: 'xhigh', adjusted: false },
  )
  // 非 qwen 集合外的 xhigh/medium → 降级 high/low
  assert.deepEqual(
    (({ effort, adjusted }) => ({ effort, adjusted }))(correctEffortForModel('xhigh', 'gpt-4o')),
    { effort: 'high', adjusted: true },
  )
  assert.deepEqual(
    (({ effort, adjusted }) => ({ effort, adjusted }))(correctEffortForModel('medium', 'gpt-4o')),
    { effort: 'low', adjusted: true },
  )
  assert.deepEqual(
    (({ effort, adjusted }) => ({ effort, adjusted }))(correctEffortForModel('max', 'gpt-4o')),
    { effort: 'max', adjusted: false },
  )
})

// 边界：大小写不敏感 + 空白容错（用户原文「字母qwen开头」）
t('边界 Qwen/ 前缀与空白大小写', () => {
  assert.equal(detectLlmType('Qwen3.8'), 'qwen')
  assert.equal(detectLlmType('  QWEN-max  '), 'qwen')
  assert.equal(detectLlmType('notqwen-1'), 'other') // 非开头不算
})

// 边界：模型名缺失 ⇒ null = 不施加静态约束（防凭空收紧）
t('边界 缺失模型名 → null 不约束', () => {
  assert.equal(detectLlmType(undefined), null)
  assert.equal(detectLlmType(''), null)
  assert.equal(allowedEffortsForModel(null), null)
  const c = correctEffortForModel('xhigh', null)
  assert.equal(c.adjusted, false)
  assert.equal(c.effort, 'xhigh')
})

// 要求 1/2 复杂度映射（轻度=low；qwen 中=medium 难=xhigh；非qwen 中=high 难=max）
t('复杂度映射', () => {
  assert.equal(effortForComplexity('qwen', 'light'), 'low')
  assert.equal(effortForComplexity('qwen', 'moderate'), 'medium')
  assert.equal(effortForComplexity('qwen', 'heavy'), 'xhigh')
  assert.equal(effortForComplexity('other', 'light'), 'low')
  assert.equal(effortForComplexity('other', 'moderate'), 'high')
  assert.equal(effortForComplexity('other', 'heavy'), 'max')
})

// 告知文案单一事实源（供 T4 注入引用）
t('规则全文含 low/medium/xhigh 与 low/high/max', () => {
  assert.match(LLM_REASONING_RULES_TEXT, /low、medium、xhigh/)
  assert.match(LLM_REASONING_RULES_TEXT, /low、high、max/)
})

console.log(`\n[T3 selftest] ${passed} cases, exit=${process.exitCode ?? 0}`)
