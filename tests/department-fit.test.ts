/**
 * T10 / M2 — department capability matching.
 *
 * Before 1.12.0 a department was a two-word label. These tests pin the minimum
 * semantic layer that makes "分配是否偏离" decidable:
 *   - all twelve departments carry duties, outputs and keywords;
 *   - a picture-book task maps to design, a contract to legal, a penetration
 *     test to security (the three fixed samples named in the change plan);
 *   - a picture-book task carrying a penetration-testing subtask is rejected;
 *   - a department actually changes the child prompt, not just the first line.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEPARTMENT_CAPABILITIES,
  DEPARTMENT_CAPABILITY_IDS,
  matchDepartmentKeywords,
  scoreDepartments,
} from '../src/departments.js'
import { departmentFit, validatePlanContext } from '../src/understanding.js'
import { buildChildPrompt, buildPlannerPrompt, DEPARTMENTS, DEPARTMENT_IDS } from '../src/plan.js'

function subtask(id: string, department: string, objective: string, extra: any = {}) {
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
    ...extra,
  }
}

test('all twelve departments carry non-empty duties, outputs and keywords', () => {
  assert.equal(DEPARTMENT_CAPABILITIES.length, 12)
  assert.deepEqual([...DEPARTMENT_CAPABILITY_IDS].sort(), [...DEPARTMENT_IDS].sort())
  for (const capability of DEPARTMENT_CAPABILITIES) {
    assert.ok(capability.zh.length > 0, `${capability.id} zh`)
    assert.ok(capability.en.length > 0, `${capability.id} en`)
    assert.ok(capability.responsibilities.length >= 3, `${capability.id} responsibilities`)
    assert.ok(capability.outputs.length >= 2, `${capability.id} outputs`)
    assert.ok(capability.keywords.length >= 8, `${capability.id} keywords`)
    const labels = DEPARTMENTS[capability.id as keyof typeof DEPARTMENTS] as any
    assert.equal(labels?.zh, capability.zh, `${capability.id} zh must match plan.ts`)
    assert.equal(labels?.en, capability.en, `${capability.id} en must match plan.ts`)
  }
})

test('fixed samples: picture book -> design, contract -> legal, pentest -> security', () => {
  const book = departmentFit(subtask('T1', 'design', '设计 8 页水彩插画，确定温柔童趣的视觉风格'), '为儿童绘本《月亮船》设计 8 页水彩插画，保持温柔、童趣的风格')
  assert.equal(book.verdict, 'fit')
  assert.ok(book.matched.includes('设计'))
  assert.ok(book.matched.includes('视觉'))

  const contract = departmentFit(subtask('T1', 'legal', '审核供应商合同的版权与许可条款'), '审核供应商合同的版权与许可条款，识别侵权风险')
  assert.equal(contract.verdict, 'fit')
  assert.ok(contract.matched.includes('合同'))
  assert.ok(contract.matched.includes('版权'))

  const pentest = departmentFit(subtask('T1', 'security', '对网关做渗透测试并输出漏洞报告'), '对网关做渗透测试并输出漏洞报告')
  assert.equal(pentest.verdict, 'fit')
  assert.ok(pentest.matched.includes('渗透'))
  assert.ok(pentest.matched.includes('漏洞'))
})

test('ranking prefers the department the task is actually about', () => {
  const top = scoreDepartments('设计 8 页水彩插画，保持温柔童趣的视觉风格，输出可点击原型')[0]
  assert.equal(top.id, 'design')

  const legal = scoreDepartments('审核合同版权与许可条款')[0]
  assert.equal(legal.id, 'legal')

  const security = scoreDepartments('渗透测试、越权验证与漏洞报告')[0]
  assert.equal(security.id, 'security')
})

test('picture-book task carrying a penetration-testing subtask is a blocking deviation', () => {
  const task = '为儿童绘本《月亮船》设计 8 页水彩插画，保持温柔、童趣的风格'
  const plan = {
    title: '绘本插画',
    taskUnderstanding: { originalRequest: task },
    stages: [
      {
        id: 'S1',
        name: '执行',
        subtasks: [
          subtask('T1', 'design', '设计 8 页水彩插画，保持温柔童趣的视觉风格'),
          subtask('T2', 'security', '扫描生产网关端口、尝试越权并输出漏洞报告'),
        ],
      },
    ],
  }

  const fit = departmentFit(plan.stages[0].subtasks[1], task)
  assert.equal(fit.intrusion, true, 'security vocabulary appears only in the subtask')
  assert.equal(fit.verdict, 'mismatch')

  const result = validatePlanContext(plan, { taskText: task })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('T2') && error.includes('安全')))
})

test('user wording alone can justify a department, and empty evidence stays weak', () => {
  const anchorOnly = departmentFit(subtask('T1', 'writing', '整理交付物并归档'), '把诊断报告写完并交付')
  assert.equal(anchorOnly.score, 0)
  assert.deepEqual(anchorOnly.anchorMatched, ['报告'])
  assert.equal(anchorOnly.verdict, 'fit')
  assert.ok(anchorOnly.reason.includes('用户原要求命中'))

  const empty = departmentFit(subtask('T1', 'writing', '整理交付物并归档'), '做点事情')
  assert.equal(empty.verdict, 'weak')
  assert.ok(empty.reason.includes('证据不足'))
})

test('unknown department is rejected with a concrete reason', () => {
  const fit = departmentFit(subtask('T1', 'marketing', '做点事情'), '做点事情')
  assert.equal(fit.verdict, 'mismatch')
  assert.ok(fit.reason.includes('未知部门'))
})

test('cross-department plan keeps one fit per department and no mismatches', () => {
  const task = '把 T11 的补丁 rebase 到 HEAD，补齐回归用例，写发布记录，并把红圈处改为默认收起'
  const plan = {
    title: '跨部门发布',
    taskUnderstanding: { originalRequest: task },
    stages: [
      {
        id: 'S1',
        name: '执行',
        subtasks: [
          subtask('T1', 'engineering', '把 T11 补丁 rebase 到 HEAD 并修复构建'),
          subtask('T2', 'qa', '补齐回归用例并运行测试，输出验收证据'),
          subtask('T3', 'writing', '写发布记录与变更说明文档'),
          subtask('T4', 'design', '红圈处改为默认收起，可点击展开'),
        ],
      },
    ],
  }
  const result = validatePlanContext(plan, { taskText: task })
  assert.deepEqual(result.audit.stage2.mismatches, [])
  assert.equal(result.ok, true, result.errors.join('\n'))
  for (const assignment of result.audit.stage2.assignments) {
    assert.equal(assignment.verdict, 'fit', `${assignment.subtaskId}: ${assignment.reason}`)
    assert.ok(assignment.reason.length > 0)
  }
})

test('department duties change the planner and child prompts', () => {
  const planner = buildPlannerPrompt('做一个设计任务', '/tmp', '', {})
  assert.ok(planner.includes('交互与信息架构设计'))
  assert.ok(planner.includes('合同与条款审查'))

  const base = {
    plan: {
      taskAnchor: null,
      taskUnderstanding: { originalRequest: '任务', deliverable: '交付物' },
      contradictions: { primary: { statement: '矛盾' } },
    },
    stage: { name: '阶段', goal: '目标' },
    dependencyResults: [],
    cwd: '/tmp',
  }
  const engineering = buildChildPrompt({
    ...base,
    subtask: subtask('T1', 'engineering', '改代码', { outputs: ['补丁'], acceptance: ['测试通过'] }),
  })
  const writing = buildChildPrompt({
    ...base,
    subtask: subtask('T2', 'writing', '写文档', { outputs: ['报告'], acceptance: ['可读'] }),
  })
  assert.ok(engineering.includes('代码实现与缺陷修复'))
  assert.ok(engineering.includes('代码或补丁'))
  assert.ok(writing.includes('文档与报告撰写'))
  assert.ok(writing.includes('文档或报告'))
  const duty = (prompt: string) => prompt.split('\n').find((line) => line.startsWith('部门职责：'))
  assert.notEqual(duty(engineering), duty(writing))
})

test('keyword matcher does not match short latin tokens inside longer words', () => {
  assert.deepEqual(matchDepartmentKeywords('rebuild the build pipeline', 'design'), [])
  assert.ok(matchDepartmentKeywords('UI 折叠加点击', 'design').includes('UI'))
})
