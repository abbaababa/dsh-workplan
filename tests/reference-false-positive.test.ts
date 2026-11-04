/**
 * [P0-2] Option-letter references must not fire on non-references.
 *
 * MS2 measured 0/4 clarify cases correctly abstaining and 2/20 wrongly blocked
 * by the referent audit. One of those two was T05-04: the text contains an
 * "A/B" comparison and the word 建议, and the old rule turned the A into an
 * unresolved option letter. A list marker "A." would do the same. A letter now
 * counts only when a selection verb points at it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { auditTaskUnderstanding, validatePlanContext } from '../src/understanding.js'

function plan() {
  return {
    version: 1,
    title: 't',
    taskUnderstanding: { originalRequest: '', assumptions: [], unknowns: [] },
    stages: [{
      id: 'S1',
      name: 's',
      subtasks: [{
        id: 'T1', title: '执行', department: 'engineering', role: 'r', objective: '按清单移入发版清单',
        method: ['m'], inputs: [], outputs: ['o'], acceptance: ['a'], risk: 'r',
      }],
    }],
  }
}

function tokens(text: string): string[] {
  return auditTaskUnderstanding(plan(), { taskText: text }).stage1.references.map((reference) => reference.token)
}

test('T05-04 real text: "A/B" plus 建议 is not an option reference', () => {
  const text = 'W5 的跨版本 A/B 探针不进 npm test（R-W5-01，建议移入发版清单）。同意移入'
  assert.deepEqual(tokens(text), [])
  const result = validatePlanContext(plan(), { taskText: text })
  assert.equal(result.errors.some((error) => error.startsWith('CONTEXT:')), false, result.errors.join(' | '))
})

test('Markdown list markers A./B. are not option references even with 建议 in the text', () => {
  const text = '建议按下列顺序执行\nA. 先改配置\nB. 再跑回归'
  assert.deepEqual(tokens(text), [])
})

test('a real selection still counts as an unresolved option', () => {
  const text = '按建议选 B 方案'
  assert.deepEqual(tokens(text).filter((token) => token === 'B'), ['B'])
  const result = validatePlanContext(plan(), { taskText: text })
  assert.equal(result.errors.some((error) => error.startsWith('CONTEXT:')), true, result.errors.join(' | '))
})

test('A/B comparison next to a selection verb is still not a letter reference', () => {
  assert.deepEqual(tokens('采用 A/B 双探针对比'), [])
})
