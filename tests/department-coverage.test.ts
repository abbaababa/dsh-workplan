/**
 * [P0-1] Required department coverage.
 *
 * MS2 measured 11/29 required departments covered: a plan could silently drop a
 * domain the user's own request names (design/legal/security/devops) and still
 * pass every earlier check, because the audit only asked "does the chosen
 * department fit?". These tests pin the new gate: an implied domain must be
 * either planned or explicitly excluded, and silence blocks dispatch.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REQUIRED_DEPARTMENT_MIN_HITS,
  auditDepartmentCoverage,
  auditTaskUnderstanding,
  validatePlanContext,
} from '../src/understanding.js'
import { DEPARTMENT_CAPABILITIES } from '../src/departments.js'

function subtask(id: string, department: string, objective: string) {
  return {
    id,
    title: objective.slice(0, 24),
    department,
    role: '执行',
    objective,
    method: ['执行'],
    inputs: [],
    outputs: ['产物'],
    acceptance: ['可验收'],
    risk: '风险',
  }
}

function plan(subtasks: any[], assumptions: string[] = []) {
  return {
    version: 1,
    title: 't',
    taskUnderstanding: { originalRequest: '', assumptions, unknowns: [] },
    stages: [{ id: 'S1', name: 's', subtasks }],
  }
}

// Two design keywords (截图 / 红圈): the request clearly asks for UI work.
const UI_TASK = '把左侧栏里画红圈的那个板块，挪到「进行中」上面，截图如下'

test('threshold is pinned: one incidental keyword is not a required domain', () => {
  assert.equal(REQUIRED_DEPARTMENT_MIN_HITS, 2)
  // 「修复」alone is one engineering keyword: interest, not an implied domain.
  const single = auditDepartmentCoverage('修复一下', plan([subtask('T1', 'qa', '跑回归')]))
  assert.equal(single.required.some((entry) => entry.department === 'engineering'), false)
  assert.equal(auditDepartmentCoverage('修复这个 bug', plan([])).required.some((entry) => entry.department === 'engineering'), true)
})

test('a request naming a domain with 2+ keywords requires that department', () => {
  const coverage = auditDepartmentCoverage(UI_TASK, plan([subtask('T1', 'engineering', '改数据顺序')]))
  const design = coverage.required.find((entry) => entry.department === 'design')
  assert.ok(design, 'design must be required')
  assert.ok(design!.hits.includes('截图') && design!.hits.includes('红圈'))
  assert.deepEqual(coverage.missing.map((entry) => entry.department), ['design'])
})

test('planned domain is not missing', () => {
  const coverage = auditDepartmentCoverage(UI_TASK, plan([
    subtask('T1', 'design', '调整左侧栏板块顺序与样式'),
    subtask('T2', 'qa', '回归验证截图效果'),
  ]))
  assert.equal(coverage.missing.length, 0)
  assert.equal(coverage.excluded.length, 0)
})

test('silent omission blocks dispatch under strict validation', () => {
  const result = validatePlanContext(plan([subtask('T1', 'engineering', '改数据顺序')]), { taskText: UI_TASK })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.startsWith('COVERAGE:') && error.includes('设计')),
    'expected a COVERAGE error naming 设计, got: ' + result.errors.join(' | '))
})

test('a written exclusion in assumptions clears the gate and is recorded', () => {
  const assumptions = ['不安排设计：本次只调整数据顺序，不涉及任何样式、布局或视觉改动']
  const p = plan([subtask('T1', 'engineering', '改数据顺序')], assumptions)
  const coverage = auditDepartmentCoverage(UI_TASK, p)
  assert.equal(coverage.missing.length, 0)
  assert.deepEqual(coverage.excluded.map((entry) => entry.department), ['design'])
  const result = validatePlanContext(p, { taskText: UI_TASK })
  assert.equal(result.ok, true, result.errors.join(' | '))
  assert.equal(result.audit.stage2.excludedDepartments[0].department, 'design')
})

// Real MS2 texts: both were planned with the domain silently dropped.
const MS2_CC_STANDARD = '全面深入审查当前插件，参照 ISO/IEC 15408（CC）最新版国际标准，如果不完全满足就准确诊断并修复'
const MS2_TAG_RELEASE = '取补丁版 1.5.1 提交，并打 v1.5.1 标签'

test('recall: a named security standard makes security a required domain', () => {
  const coverage = auditDepartmentCoverage(MS2_CC_STANDARD, plan([subtask('T1', 'engineering', '改代码')]))
  assert.ok(coverage.required.some((entry) => entry.department === 'security'),
    'security must be required, got: ' + JSON.stringify(coverage.required))
  assert.ok(coverage.missing.some((entry) => entry.department === 'security'))
})

test('recall: an ordered pair catches 「打 v1.5.1 标签」 as release work', () => {
  const coverage = auditDepartmentCoverage(MS2_TAG_RELEASE, plan([subtask('T1', 'engineering', '改代码')]))
  const devops = coverage.required.find((entry) => entry.department === 'devops')
  assert.ok(devops, 'devops must be required, got: ' + JSON.stringify(coverage.required))
  assert.ok(devops!.hits.includes('打…标签'))
  assert.ok(coverage.missing.some((entry) => entry.department === 'devops'))
})

test('recall: a named international standard makes legal a required domain (T05-05)', () => {
  const coverage = auditDepartmentCoverage(MS2_CC_STANDARD, plan([subtask('T1', 'engineering', '改代码')]))
  const legal = coverage.required.find((entry) => entry.department === 'legal')
  assert.ok(legal, 'legal must be required, got: ' + JSON.stringify(coverage.required))
  assert.ok(legal!.hits.length >= 2, 'legal hits >= 2, got: ' + JSON.stringify(legal!.hits))
  assert.ok(legal!.hits.includes('15408'), 'the literal standard number must hit: ' + JSON.stringify(legal!.hits))
  assert.ok(coverage.missing.some((entry) => entry.department === 'legal'))
})

// R5 reverse case (§49 of the 2026-11-04 review): '国际…标准' was added to lift
// T05-05 above the >=2 gate, but it fires on the same span as the pre-existing
// '国际标准', so plain「参考国际标准做一下排版」reached 2 hits and pulled legal
// into a pure typesetting task. The pair is removed; without it this text must
// stay at 1 hit and legal must NOT be required. T05-05 keeps 4 hits (A2).
const R5_TYPESETTING = '参考国际标准做一下排版'

test('reverse: a bare 「国际标准」 reference does not make legal required (R5)', () => {
  const coverage = auditDepartmentCoverage(R5_TYPESETTING, plan([subtask('T1', 'engineering', '改代码')]))
  const legal = coverage.required.find((entry) => entry.department === 'legal')
  assert.equal(legal, undefined, 'legal must not be required, got: ' + JSON.stringify(coverage.required))
  assert.ok(coverage.required.every((entry) => entry.department !== 'legal'))
})

test('recall: no ordered-pair keyword remains in the legal catalog', () => {
  const capability = DEPARTMENT_CAPABILITIES.find((entry) => entry.id === 'legal')!
  const pairs = capability.keywords.filter((keyword) => keyword.includes('…'))
  assert.deepEqual(pairs, [], 'legal must not carry an ordered pair: ' + JSON.stringify(pairs))
  // 16 -> 22 on 2026-11-04: 窃取/信息泄露/个人信息/数据安全/隐私风险/移动终端 were added
  // so the T05-12 privacy question reaches the >=2 gate without naming 法务. Each is
  // legal-specific; 「泄露」 was deliberately widened to 「信息泄露」 so a memory leak
  // (内存泄露) cannot pull legal into an engineering task.
  assert.equal(capability.keywords.length, 22)
})

test('recall: legal keywords do not fire on a single 「法」 character', () => {
  const coverage = auditDepartmentCoverage('按法律法规办法处理一下这个事', plan([subtask('T1', 'engineering', '改代码')]))
  assert.equal(coverage.required.some((entry) => entry.department === 'legal'), false,
    'no one-character keyword may exist: ' + JSON.stringify(coverage.required))
})

test('legacy replay without the original text stays non-blocking', () => {
  const audit = auditTaskUnderstanding(plan([subtask('T1', 'engineering', '改数据顺序')]), {})
  assert.equal(audit.stage3.verdict, 'degraded')
  assert.deepEqual(audit.stage2.missingDepartments, [])
})
