/**
 * T10 / M1 — task anchor and deviation self-check.
 *
 * These tests pin the three acceptance categories in the task:
 *   1. a cross-department task keeps every hard element;
 *   2. a task that refers to "它 / 这个 / B" is either resolved from context or
 *      reported as needing context (never silently guessed);
 *   3. mutually contradictory requirements are reported instead of one being
 *      picked silently.
 *
 * Every assertion is against a pure function; no model, network or clock is
 * involved, so the result is reproducible.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_TASK_ELEMENTS,
  auditTaskUnderstanding,
  buildTaskAnchor,
  extractTaskElements,
  normalizeForMatch,
  validatePlanContext,
} from '../src/understanding.js'
import { buildChildPrompt, buildPlannerPrompt, validatePlan } from '../src/plan.js'

function rawPlan(overrides: any = {}) {
  return {
    version: 1,
    title: '验证一个需求',
    taskUnderstanding: {
      originalRequest: '请验证这个需求是否可行',
      deliverable: '一份验证报告',
      successCriteria: ['报告给出可复现的证据'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '证据与成本', evidence: ['时间有限'], whyPrimary: '证据不足则结论不可信' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [
      {
        id: 'S1',
        name: '准备',
        goal: '明确范围',
        rationale: '避免无效工作',
        checkpoint: '范围确认',
        subtasks: [
          {
            id: 'T1',
            title: '梳理验证范围',
            department: 'research',
            role: '需求分析',
            objective: '列出需要验证的假设',
            method: ['阅读需求', '列出假设'],
            inputs: [],
            outputs: ['假设清单'],
            dependsOn: [],
            acceptance: ['每个假设都有验证方法'],
            risk: '假设遗漏',
          },
        ],
      },
    ],
    risks: [],
    verification: [{ item: '范围', method: '复核', evidence: '清单' }],
    practiceLoop: { plan: '计划', do: '执行', check: '检查', act: '修正' },
    ...overrides,
  }
}

function planOf(...subtasks: any[]) {
  return {
    title: '测试计划',
    taskUnderstanding: { originalRequest: '测试计划' },
    stages: [{ id: 'S1', name: '阶段', subtasks }],
  }
}

function subtask(id: string, department: string, objective: string, extra: any = {}) {
  return {
    id,
    title: objective.slice(0, 20),
    department,
    role: '执行',
    objective,
    method: ['执行'],
    inputs: [],
    outputs: ['产物'],
    acceptance: ['可验收'],
    risk: '风险',
    ...extra,
  }
}

test('cross-department task: every hard element is extracted and kept', () => {
  const task = [
    '（1）把 T11 的 15 个低风险补丁 rebase 到当前 HEAD，发布 1.12.0；',
    '（2）对报告第 6.1 节的 U-15…U-21 全面分析并修正；',
    '（3）把红圈处改为默认不展开，最多 3 行。',
  ].join('')
  const extracted = extractTaskElements(task)
  const values = extracted.elements.map((element) => `${element.kind}:${element.value}`)

  assert.ok(values.includes('version:1.12.0'), `version missing in ${values.join(' | ')}`)
  assert.ok(values.includes('id:T11'), `T11 missing in ${values.join(' | ')}`)
  assert.ok(values.includes('id:U-15'), `U-15 missing in ${values.join(' | ')}`)
  assert.ok(values.includes('count:15个'), `15个 missing in ${values.join(' | ')}`)
  assert.ok(values.includes('quantity:最多3行'), `最多3行 missing in ${values.join(' | ')}`)
  assert.equal(extracted.conflicts.length, 0, 'a normal request must not be reported as conflicting')

  const plan = planOf(
    subtask('T1', 'engineering', '把 T11 的 15 个低风险补丁 rebase 到当前 HEAD，发布 1.12.0'),
    subtask('T2', 'research', '分析 U-15…U-21 七条未验证项并给出结论'),
    subtask('T3', 'design', '红圈处默认不展开，最多 3 行，可点击展开'),
  )
  plan.taskUnderstanding.originalRequest = task
  const audit = auditTaskUnderstanding(plan, { taskText: task, sourceMessageIds: ['m1'] })
  assert.equal(audit.stage3.verdict, 'aligned')
  assert.deepEqual(audit.stage3.missingHardAnchors, [])
  assert.equal(audit.stage3.summaryCoverage, 1)
  assert.equal(audit.anchor?.sha256.length, 64)
  assert.deepEqual(audit.anchor?.sourceMessageIds, ['m1'])
})

test('hard element dropped from the plan is a blocking deviation', () => {
  const task = '发布 1.12.0，并补齐 15 条回归用例。'
  const plan = planOf(subtask('T1', 'engineering', '补齐回归用例并运行测试'))
  const result = validatePlanContext(plan, { taskText: task })

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.startsWith('DEVIATION:') && error.includes('1.12.0')))
  assert.ok(result.audit.stage3.missingHardAnchors.some((entry) => entry.includes('1.12.0')))
  assert.equal(result.audit.stage3.verdict, 'deviation')
})

test('rollback switch downgrades every blocking finding to a warning', () => {
  const task = '发布 1.12.0。'
  const plan = planOf(subtask('T1', 'engineering', '整理发布说明'))
  const lenient = validatePlanContext(plan, { taskText: task, strict: false })

  assert.equal(lenient.ok, true)
  assert.equal(lenient.errors.length, 0)
  assert.ok(lenient.warnings.some((warning) => warning.includes('1.12.0')))
  // The audit itself still reports the deviation: switching off blocking must
  // not switch off the evidence.
  assert.equal(lenient.audit.stage3.verdict, 'deviation')
})

test('legacy plan without the original text degrades instead of blocking', () => {
  const plan = planOf(subtask('T1', 'engineering', '做点什么'))
  const result = validatePlanContext(plan, {})
  assert.equal(result.ok, true)
  assert.equal(result.audit.stage3.verdict, 'degraded')
  assert.equal(result.audit.anchor, null)
  assert.ok(result.audit.stage3.reasons[0].includes('旧计划'))
})

test('pronoun reference: unresolved without context, resolved with context', () => {
  const task = '把它改成默认收起，其他不动。'
  const plan = planOf(subtask('T1', 'design', '把分步进度默认收起，其他不动'))
  const without = auditTaskUnderstanding(plan, { taskText: task })
  assert.equal(without.stage1.references[0].token, '它')
  assert.equal(without.stage1.references[0].resolved, false)
  assert.equal(without.stage3.verdict, 'needs-context')
  assert.ok(without.stage3.reasons.some((reason) => reason.includes('指代')))

  const withContext = auditTaskUnderstanding(plan, {
    taskText: task,
    conversationContext: '用户上一轮说：把截图红圈处的三行分步进度改成可点击。',
  })
  assert.equal(withContext.stage1.references[0].resolved, true)
  assert.equal(withContext.stage1.references[0].resolvedBy, 'context')
  assert.notEqual(withContext.stage3.verdict, 'needs-context')
})

test('inline noun reference 「这个插件」 is self-contained; option letter B needs context', () => {
  const inline = extractTaskElements('排查这个插件的机制是否有问题')
  assert.equal(inline.references[0].token, '这个')
  assert.equal(inline.references[0].resolvedBy, 'inline-noun')
  assert.equal(inline.references[0].resolved, true)

  const option = extractTaskElements('按 B 方案执行，同时保留 A 方案做回退')
  const ref = option.references.find((entry) => entry.token === 'B')
  assert.ok(ref, `expected B reference, got ${JSON.stringify(option.references)}`)
  assert.equal(ref!.resolved, false)
})

test('「该」 as a modal is not mistaken for a pronoun', () => {
  assert.deepEqual(extractTaskElements('告诉他该怎么做。').references, [])
  const inline = extractTaskElements('把该模块改好。')
  assert.equal(inline.references[0].token, '该')
  assert.equal(inline.references[0].resolved, true)
})

test('conflicting requirements are reported, not silently picked', () => {
  const versionConflict = extractTaskElements('把版本号改成 1.12.0；但版本号必须保持 1.11.1。')
  assert.ok(versionConflict.conflicts.some((conflict) => conflict.kind === 'value'))

  const stateConflict = extractTaskElements('分步进度默认展开；同一处又要求分步进度默认不展开。')
  assert.ok(stateConflict.conflicts.some((conflict) => conflict.kind === 'default-state'))

  const scopeConflict = extractTaskElements('只改 src/client.ts；同时修改 src/plan.ts。')
  assert.ok(scopeConflict.conflicts.some((conflict) => conflict.kind === 'scope'))

  const plan = planOf(subtask('T1', 'engineering', '改版本号'))
  const conflictTask = '把版本号改成 1.12.0；但版本号必须保持 1.11.1。'
  plan.taskUnderstanding.originalRequest = conflictTask
  const audit = auditTaskUnderstanding(plan, { taskText: conflictTask })
  assert.equal(audit.stage3.verdict, 'needs-clarification')
  assert.ok(audit.stage3.reasons.some((reason) => reason.includes('自相矛盾')))
})

test('strict mode blocks a contradiction and an unresolved pronoun', () => {
  const conflictTask = '把版本号改成 1.12.0；但版本号必须保持 1.11.1。'
  const conflictPlan = planOf(subtask('T1', 'engineering', '改版本号'))
  conflictPlan.taskUnderstanding.originalRequest = conflictTask
  const blocked = validatePlanContext(conflictPlan, { taskText: conflictTask })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.errors.some((error) => error.startsWith('CLARIFY:')))

  const lenient = validatePlanContext(conflictPlan, { taskText: conflictTask, strict: false })
  assert.equal(lenient.ok, true)
  assert.ok(lenient.warnings.some((warning) => warning.includes('自相矛盾')))

  const pronounTask = '把它改成默认收起。'
  const pronounPlan = planOf(subtask('T1', 'design', '把分步进度默认收起'))
  const needsContext = validatePlanContext(pronounPlan, { taskText: pronounTask })
  assert.equal(needsContext.ok, false)
  assert.ok(needsContext.errors.some((error) => error.startsWith('CONTEXT:')))

  const resolved = validatePlanContext(pronounPlan, {
    taskText: pronounTask,
    conversationContext: '上一轮说：把截图红圈处的分步进度改成可点击。',
  })
  assert.equal(resolved.ok, true, resolved.errors.join('\n'))
})

test('anchor is read-only: hash must match the stored text and survives validatePlan', () => {
  const task = '发布 1.12.0。'
  const anchor = buildTaskAnchor(task, ['m1'])
  assert.ok(anchor)
  assert.equal(anchor!.text, task)

  const raw = rawPlan({ taskAnchor: anchor })
  const validated = validatePlan(raw)
  assert.equal(validated.ok, true)
  assert.equal(validated.plan!.taskAnchor?.sha256, anchor!.sha256)
  assert.equal(validated.plan!.taskAnchor?.text, task)

  const tampered = validatePlan(rawPlan({ taskAnchor: { ...anchor, text: '发布 9.9.9。' } }))
  assert.equal(tampered.ok, true)
  assert.equal(tampered.plan!.taskAnchor, null, 'a mismatched hash must not be trusted')

  const missing = validatePlan(rawPlan())
  assert.equal(missing.plan!.taskAnchor, null)
})

test('element extraction is bounded and stable for repeated text', () => {
  const task = Array.from({ length: 80 }, (_, index) => `第${index + 1}条要求 1.${index}.0。`).join('')
  const first = extractTaskElements(task)
  const second = extractTaskElements(task)
  assert.ok(first.elements.length <= MAX_TASK_ELEMENTS)
  assert.deepEqual(first, second)
})

test('planner prompt teaches the three stages and asks for a rationale', () => {
  const prompt = buildPlannerPrompt('发布 1.12.0', '/tmp', '', {})
  assert.ok(prompt.includes('抽取要素'))
  assert.ok(prompt.includes('匹配部门'))
  assert.ok(prompt.includes('偏离自检'))
  assert.ok(prompt.includes('departmentRationale'))
  assert.ok(prompt.includes('代码实现与缺陷修复'), 'planner must see engineering duties')
  assert.ok(prompt.includes('典型产物'), 'planner must see expected outputs')
})

test('child prompt carries the original anchor and department-specific duties', () => {
  const plan = {
    taskAnchor: buildTaskAnchor('把红圈处改为默认收起，发布 1.12.0', ['m1']),
    taskUnderstanding: { originalRequest: '把红圈处改为默认收起', deliverable: '改好的界面' },
    contradictions: { primary: { statement: '范围与时间' } },
  }
  const base = {
    plan,
    stage: { name: '阶段', goal: '目标' },
    dependencyResults: [],
    cwd: '/tmp',
  }
  const engineering: string = buildChildPrompt({
    ...base,
    subtask: { id: 'T1', title: '改代码', department: 'engineering', role: '工程师', objective: '修改代码', method: ['改'], inputs: [], outputs: ['补丁'], acceptance: ['测试通过'], risk: '风险' },
  })
  const design: string = buildChildPrompt({
    ...base,
    subtask: { id: 'T2', title: '改交互', department: 'design', role: '设计师', objective: '改交互', method: ['改'], inputs: [], outputs: ['设计稿'], acceptance: ['可点击'], risk: '风险' },
  })
  assert.ok(engineering.includes('用户原要求（只读锚点'))
  assert.ok(engineering.includes('发布 1.12.0'))
  assert.ok(engineering.includes('代码实现与缺陷修复'))
  assert.ok(design.includes('交互与信息架构设计'))
  assert.notEqual(
    engineering.split('\n').find((line) => line.startsWith('部门职责：')),
    design.split('\n').find((line) => line.startsWith('部门职责：')),
    'two departments must not receive identical duty lines',
  )
})

test('normalizeForMatch only removes formatting, never content', () => {
  assert.equal(normalizeForMatch(' 1.12.0 '), '1.12.0')
  assert.equal(normalizeForMatch('A，B。C'), 'abc')
  assert.equal(normalizeForMatch('1.12.0'), '1.12.0')
  assert.notEqual(normalizeForMatch('1.12.0'), normalizeForMatch('1120'))
  assert.equal(normalizeForMatch('15 个'), '15个')
  assert.notEqual(normalizeForMatch('15 个'), normalizeForMatch('15 条'))
})
