/**
 * [T3] Pronoun resolution inside the task text itself.
 *
 * MS2 T05-08 names the instrument 「159667工业母机ETF国泰」 in one sentence and
 * asks 「它每天具体走势到底如何？」 in the next. Conversation-only resolution
 * saw an empty history and refused the task as "no antecedent"; a blind 240
 * character window then resolved a whole clause instead of the name.
 *
 * The rule pinned here:
 *   - an explicit referent in the SAME sentence, or in the sentence right
 *     before it, resolves the pronoun;
 *   - a pronoun with no explicit referent in that scope still blocks
 *     (needs-context), so a missing antecedent is never guessed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  auditTaskUnderstanding,
  resolvePronounAntecedentInline,
  validatePlanContext,
} from '../src/understanding.js'

/** Contiguous excerpt of the real MS2 T05-08 task text (packs/T05-08.md). */
const T0508 = [
  '总任务：',
  '必须全部重新准确预判，159667工业母机ETF国泰，下月全月详细、具体的走势，合计涨跌幅分别是多少？',
  '准确预判后详细并通俗易懂地告诉我，它每天具体走势到底如何？',
  '本总任务非常复杂。',
].join('\n')

const RESOLVE_CASES = [
  {
    name: 'T05-08: the referent is named in the previous sentence',
    text: T0508,
    expected: '159667工业母机ETF国泰',
  },
  {
    name: 'same sentence: trailing prose is not glued to the name',
    text: '159667工业母机ETF国泰是我重点关注的基金，它每天具体走势到底如何？',
    expected: '159667工业母机ETF国泰',
  },
  {
    name: 'previous sentence: the request lead-in is stripped',
    text: '我关注159667工业母机ETF国泰。它今天怎么样？',
    expected: '159667工业母机ETF国泰',
  },
  {
    name: 'a bare stock code is an explicit referent',
    text: '159667 昨天涨停。它下月怎么走？',
    expected: '159667',
  },
  {
    name: 'a quoted name is an explicit referent',
    text: '板块里只有「工业母机ETF国泰」能做，它下月怎么走？',
    expected: '工业母机ETF国泰',
  },
  {
    name: 'a latin identifier is an explicit referent',
    text: '请修复 dsh-workplan 的日志问题，它现在刷屏。',
    expected: 'dsh-workplan',
  },
]

for (const item of RESOLVE_CASES) {
  test('resolves: ' + item.name, () => {
    const found = resolvePronounAntecedentInline('它', item.text)
    assert.equal(found?.antecedent ?? null, item.expected)
  })
}

const BLOCK_CASES = [
  { name: 'no referent anywhere', text: '把它改成默认收起，其他不动。' },
  { name: 'only a demonstrative, no referent', text: '把这个问题处理一下，它太麻烦了。' },
  { name: 'referent two sentences back is outside the scope', text: '159667工业母机ETF国泰昨天涨了。今天大盘很弱。告诉我它明天会怎么走。' },
  { name: 'a version number is not a name', text: '把 2.0 版本改成默认收起，它现在太吵了。' },
  { name: 'there is no real pronoun in 其它', text: '把其它东西整理一下，它太乱了。' },
]

for (const item of BLOCK_CASES) {
  test('still blocks: ' + item.name, () => {
    assert.equal(resolvePronounAntecedentInline('它', item.text), null)
  })
}

function planStub(text: string) {
  return {
    title: '离线回放',
    taskUnderstanding: {
      originalRequest: text,
      deliverable: '',
      successCriteria: [],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    stages: [],
    verification: [],
  }
}

test('T05-08 is no longer reported as needs-context for 它', () => {
  const audit = auditTaskUnderstanding(planStub(T0508), { taskText: T0508, conversationContext: '' })
  const reference = audit.stage1.references.find((item) => item.token === '它')
  assert.ok(reference, 'the pronoun must still be recorded as a reference')
  assert.equal(reference?.resolved, true)
  // The referent came from the task text — an empty conversation must not be
  // reported as its source.
  assert.equal(reference?.resolvedBy, 'task-text')
  assert.equal(reference?.antecedent, '159667工业母机ETF国泰')
  assert.ok(!audit.stage3.reasons.some((reason) => reason.includes('找不到先行词')))
})

test('a conversation antecedent is still attributed to the conversation', () => {
  const text = '把它改成默认收起。'
  const audit = auditTaskUnderstanding(planStub(text), {
    taskText: text,
    conversationContext: '用户上一轮说：把截图红圈处的三行分步进度改成可点击。',
  })
  const reference = audit.stage1.references.find((item) => item.token === '它')
  assert.equal(reference?.resolved, true)
  assert.equal(reference?.resolvedBy, 'context')
})

test('validatePlanContext raises no CONTEXT error for T05-08', () => {
  const validation = validatePlanContext(planStub(T0508), { taskText: T0508, conversationContext: '' })
  assert.ok(!validation.errors.some((error) => error.startsWith('CONTEXT:')))
})

test('validatePlanContext still raises CONTEXT when the referent is missing', () => {
  const text = '把它改成默认收起，其他不动。'
  const validation = validatePlanContext(planStub(text), { taskText: text, conversationContext: '' })
  assert.ok(validation.errors.some((error) => error.startsWith('CONTEXT:')))
})
