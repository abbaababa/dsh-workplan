/*
 * [1.13.0] 三阶段工作法的可执行契约（用户 2026-11-05 强制要求）。
 *
 * 锁四件事：
 *  1. 每个部门子任务的提示词都明确要求「先梳理问题 → 再形成可执行思路 →
 *     执行 → 验证」，并把「阶段一、二禁用插件，阶段三才可核验」写进去；
 *  2. 完成（done）必须带 planning / execution / verification 三阶段证据，
 *     缺一段就判未完成，不能靠一句「已完成」收尾；
 *  3. 阶段三核验工具（dsh_workplan_verify）在阶段一/二返回 PHASE_GATE，
 *     只有三阶段齐全且验证全部通过才回 passed；
 *  4. 阶段摘要可读，主 Agent 能看出每个部门梳理了什么、执行了什么、验证了什么。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  applyStatus,
  buildChildPrompt,
  createStatuses,
} from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import {
  phaseGateFromErrors,
  phaseSummaryLine,
  threePhasePromptLines,
  validatePhaseEvidence,
} from '../src/three-phase.js'

function phases(overrides: any = {}) {
  return {
    planning: {
      problemAnalysis: [
        '现状：现有接口没有幂等保护，重复提交会写两条记录；约束：不能改数据库结构；未知：上游是否会重试；主要矛盾：兼容旧调用方与修复重复写入。',
      ],
      constraints: ['不能改数据库结构'],
      unknowns: ['上游是否会自动重试'],
      approach: [
        '先读现有写入路径确认入口 → 在入口加幂等键校验 → 用同一请求连发两次 → 核对只写一条记录 → 对照验收标准逐条留证。',
      ],
    },
    execution: { steps: ['读写入路径', '加幂等校验', '连发两次并核对记录数'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: 'A1', method: '同一请求连发两次', evidence: '数据库只有 1 条记录' }],
      requirementCheck: '用户原要求逐条核对：幂等、兼容旧调用方，均覆盖。',
    },
    ...overrides,
  }
}

function evidence(payload: any) {
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function childPlan() {
  return {
    planId: 'wp-three-phase',
    sessionId: 'session-three-phase',
    createdTurn: 1,
    createdAt: 1,
    title: '三阶段回归',
    taskUnderstanding: {
      originalRequest: '修复重复写入',
      deliverable: '幂等写入',
    },
    contradictions: { primary: { statement: '兼容旧调用方与修复重复写入' } },
    taskAnchor: { text: '修复重复写入', sha256: 'a'.repeat(64) },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '修好幂等',
      subtasks: [{
        id: 'T1',
        title: '实现幂等写入',
        department: 'engineering',
        role: '后端工程师',
        objective: '同一请求只写一条记录',
        method: ['读代码', '改代码', '验证'],
        inputs: ['现有写入路径'],
        outputs: ['补丁', '验证记录'],
        acceptance: ['同一请求连发两次只写一条记录'],
        risk: '可能影响旧调用方',
        dependsOn: [],
      }],
    }],
  }
}

test('子 Agent 提示词包含三阶段顺序、禁止跳步与阶段三插件核验', () => {
  const plan = childPlan()
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
    statuses: createStatuses(plan),
  })
  assert.match(prompt, /三阶段工作法/)
  assert.match(prompt, /阶段一 · 规划阶段/)
  assert.match(prompt, /先全面、深入梳理要解决的问题/)
  assert.match(prompt, /完整、可执行思路/)
  assert.match(prompt, /阶段二 · 执行阶段/)
  assert.match(prompt, /阶段三 · 验证阶段/)
  assert.match(prompt, /阶段一、二：dsh-workplan 插件禁用/)
  assert.match(prompt, /dsh_workplan_verify/)
  assert.match(prompt, /"phases"/, '结果块模板必须包含 phases 字段')
  // 顺序要求：规划段必须出现在执行要求之前。
  assert.ok(
    prompt.indexOf('三阶段工作法') < prompt.indexOf('执行要求：'),
    '三阶段工作法必须先于执行要求出现，不能被埋在末尾',
  )
})

test('三阶段证据：齐全且验证通过才 ok', () => {
  const check = validatePhaseEvidence(phases(), ['同一请求连发两次只写一条记录'])
  assert.equal(check.ok, true)
  assert.ok(check.phases)
  assert.equal(check.errors.length, 0)
  assert.match(phaseSummaryLine(check.phases!), /阶段一 规划/)
  assert.match(phaseSummaryLine(check.phases!), /阶段三 验证/)
})

test('三阶段证据：缺 planning 直接失败，并指向阶段一', () => {
  const input: any = phases()
  delete input.planning
  const check = validatePhaseEvidence(input)
  assert.equal(check.ok, false)
  assert.equal(check.failedPhase, 'planning')
  assert.match(check.errors.join('；'), /planning 缺失/)
  assert.equal(phaseGateFromErrors(check.errors), 'phase-1-2')
})

test('三阶段证据：规划太薄（一句目标冒充思路）不算规划', () => {
  const input = phases()
  input.planning.approach = ['把代码改好']
  const check = validatePhaseEvidence(input)
  assert.equal(check.ok, false)
  assert.match(check.errors.join('；'), /approach 太薄/)
  assert.equal(check.failedPhase, 'planning')
})

test('三阶段证据：验证未全部通过不得报 done', () => {
  const input = phases()
  input.verification.allPassed = false
  const check = validatePhaseEvidence(input)
  assert.equal(check.ok, false)
  assert.equal(check.failedPhase, 'verification')
  assert.equal(phaseGateFromErrors(check.errors), 'verification')
})

test('三阶段证据：验证记录少于验收标准数 → 漏验', () => {
  const check = validatePhaseEvidence(phases(), ['验收一', '验收二', '验收三'])
  assert.equal(check.ok, false)
  assert.match(check.errors.join('；'), /只验证了 1 项，少于验收标准的 3 项/)
})

test('三阶段证据：验证条数够但未逐条对号入座，仍算漏验', () => {
  const input = phases({
    verification: {
      allPassed: true,
      checks: [
        { criterion: 'A1', method: '验证一', evidence: '证据一' },
        { criterion: 'A1', method: '验证一（重复）', evidence: '证据一' },
      ],
      requirementCheck: '两条验收都通过。',
    },
  })
  const check = validatePhaseEvidence(input, ['验收一', '验收二'])
  assert.equal(check.ok, false)
  assert.equal(check.failedPhase, 'verification')
  assert.match(check.errors.join('\n'), /缺少 A2/)
  assert.match(check.errors.join('\n'), /只写一部分不算覆盖/)
})

test('完成判定：没有 phases 的 done 被降级为 blocked/unverified', () => {
  const output = evidence({
    status: 'done',
    acceptance: [{ criterion: 'A1', result: 'pass', evidence: '记录数=1' }],
    artifacts: [],
    needs: [],
  })
  const verdict = adjudicateResult({ output, expectedAcceptance: ['同一请求连发两次只写一条记录'] })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'unverified')
  assert.match(String(verdict.error), /三阶段证据不完整/)
  assert.match(String(verdict.error), /planning/)
})

test('完成判定：三阶段齐全的 done 仍按原规则判 structured', () => {
  const output = evidence({
    status: 'done',
    phases: phases(),
    acceptance: [{ criterion: 'A1 同一请求连发两次只写一条记录', result: 'pass', evidence: '记录数=1' }],
    artifacts: [],
    needs: [],
  })
  const verdict = adjudicateResult({ output, expectedAcceptance: ['同一请求连发两次只写一条记录'] })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.verification, 'structured')
  assert.ok(verdict.phases, '通过的三阶段证据要随判定返回，供主 Agent 复核')
  assert.match(String(verdict.phaseSummary), /阶段一 规划/)
})

test('兼容边界：requirePhases=false 保留旧完成语义（历史回放/明确关闭）', () => {
  const output = evidence({
    status: 'done',
    acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'ok' }],
    artifacts: [],
    needs: [],
  })
  const verdict = adjudicateResult({ output, requirePhases: false })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.verification, 'structured')
})

test('提示词段落本身声明了阶段一/二禁用、阶段三核验', () => {
  const text = threePhasePromptLines().join('\n')
  assert.match(text, /阶段一、二：dsh-workplan 插件禁用/)
  assert.match(text, /阶段三：可以调用 dsh_workplan_verify/)
  assert.match(text, /禁止动手执行/)
})

function runtimeFixture() {
  const parent = {
    id: 'parent-verify',
    header: { createdAt: 1 },
    events: [],
    get seq() {
      return this.events.length
    },
    append() {},
    eventAt() {
      return undefined
    },
  }
  const child = { id: 'child-verify', header: { parentSession: 'parent-verify' } }
  const runtime: any = createWorkplanRuntime({
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: {
      get: (id: string) => (id === parent.id ? parent : undefined),
      list: () => [parent],
      eventAt: () => undefined,
    },
  }, { version: 'test-version' })
  const plan = childPlan()
  const record: any = {
    plan,
    statuses: createStatuses(plan),
    errors: [],
    phase: 'executing',
    updatedAt: Date.now(),
  }
  record.statuses = applyStatus(record.statuses, 'T1', {
    status: 'in_progress',
    closure: 'assigned',
    childId: child.id,
    progress: 30,
  })
  runtime.state.records.set(parent.id, record)
  return { runtime, child }
}

test('阶段三核验工具：阶段一/二提交被 PHASE_GATE 拒绝（插件禁用）', async () => {
  const { runtime, child } = runtimeFixture()
  const out = await runtime.verifyTool({ session: child }, {
    phases: {
      planning: { problemAnalysis: ['现状：还没规划完'] },
    },
  })
  assert.equal(out.ok, false)
  assert.equal(out.passed, false)
  assert.equal(out.code, 'PHASE_GATE')
  assert.equal(out.phase, 'phase-1-2')
  assert.match(String(out.error), /阶段一、二禁用/)
})

test('阶段三核验工具：三阶段齐全且验证通过 → passed', async () => {
  const { runtime, child } = runtimeFixture()
  const out = await runtime.verifyTool({ session: child }, { phases: phases() })
  assert.equal(out.ok, true)
  assert.equal(out.passed, true)
  assert.equal(out.phase, 'verification')
  assert.match(String(out.summary), /阶段一 规划/)
})

test('阶段三核验工具：验证未全部通过 → VERIFICATION_INCOMPLETE', async () => {
  const { runtime, child } = runtimeFixture()
  const input = phases()
  input.verification.allPassed = false
  const out = await runtime.verifyTool({ session: child }, { phases: input })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'VERIFICATION_INCOMPLETE')
  assert.match(String(out.error), /阶段三核验未通过/)
})
