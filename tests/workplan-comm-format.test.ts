/*
 * [2.1.0] 沟通交流格式契约（用户 2026-11-06 的强制要求）。
 *
 * 需求原文要点：派发工作的同时附带统一沟通交流格式要求；部门人员提交结果前
 * 依此自查；主 Agent 收到后依同一份格式核验，不合规立刻退回，通知其重新
 * 检查格式后全盘重交。
 *
 * 这里锁四件事：
 * 1. 提示词确实附带同一份规范（下发环节）；
 * 2. 每条规范都能被独立核验出来（核验环节）；
 * 3. 不合规走 blocked/comm-format 并带可读退回通知（退回环节）；
 * 4. 兼容边界：requirePhases:false 不追溯否决旧日志。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMM_FORMAT_SPEC,
  COMM_FORMAT_VERSION,
  checkCommFormatCompliance,
  renderCommFormatRejection,
  renderCommFormatSpec,
} from '../src/comm-format.js'
import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  buildChildPrompt,
} from '../src/plan.js'

function block(payload: any) {
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function phasesFixture(overrides: any = {}) {
  return {
    planning: {
      problemAnalysis: ['现状：需要确认接口可用；约束：不能改线上配置；未知：对端限流阈值；主要矛盾：覆盖面与时间。'],
      constraints: ['不得修改生产配置'],
      unknowns: ['对端限流阈值未确认'],
      approach: ['先读现有实现确认入口 → 写最小复现脚本 → 跑一次并保存输出 → 对照验收标准逐条记录证据。'],
    },
    execution: { steps: ['读源码确认入口', '运行最小复现脚本', '记录输出证据'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: '接口可用', method: 'curl /health', evidence: 'HTTP 200' }],
      requirementCheck: '用户原要求已逐条核对，无遗漏。',
      retrospective: {
        problems: ['一开始误以为接口不需要鉴权，探测返回 401；根因是没先读鉴权中间件。'],
        detours: ['直接 curl 生产地址，浪费两轮排查。'],
        resolutions: ['先读鉴权中间件确认 token 头，再带 token 请求 /health。'],
        prevention: ['遇到接口探测，先读鉴权实现再发请求。'],
      },
    },
    ...overrides,
  }
}

function donePayload(overrides: any = {}) {
  return {
    status: 'done',
    summary: '实现完成',
    phases: phasesFixture(),
    acceptance: [{ criterion: '接口可用', result: 'pass', evidence: 'curl /health 返回 200' }],
    artifacts: [{ kind: 'file', ref: 'src/host.ts' }],
    needs: [],
    ...overrides,
  }
}

/* ---------------- 下发环节 ---------------- */

test('下发：子任务提示词附带统一格式规范，且与核验用的是同一份数据', () => {
  const prompt = buildChildPrompt({
    plan: { planId: 'wp-1', taskUnderstanding: {} },
    subtask: {
      id: 'T1',
      title: '修写入重复',
      department: 'engineering',
      role: 'engineer',
      objective: '修掉重复写入',
      method: ['改代码'],
      inputs: [],
      outputs: ['补丁'],
      acceptance: ['同一请求只写一条记录'],
      risk: '低',
      dependsOn: [],
    },
    stage: { name: 'S1', goal: '修复' },
    cwd: '/tmp',
  })
  assert.ok(prompt.includes(renderCommFormatSpec()), '提示词必须原样附带同一份规范文本')
  for (const req of COMM_FORMAT_SPEC.requirements) {
    assert.ok(prompt.includes(req.id), `提示词缺少规范条目 ${req.id}`)
  }
  assert.match(prompt, /提交前自查（强制）/, '必须要求部门人员提交前自查')
  assert.match(prompt, /退回/, '必须写明不合规会被退回')
})

test('规范：版本号与条目集合稳定（对外契约，改动须升版本）', () => {
  assert.equal(COMM_FORMAT_VERSION, 1)
  assert.deepEqual(
    COMM_FORMAT_SPEC.requirements.map((item: any) => item.id),
    ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'],
  )
  for (const req of COMM_FORMAT_SPEC.requirements) {
    assert.ok(req.description.trim().length > 10, `${req.id} 描述过于单薄`)
    assert.ok(req.rationale.trim().length > 5, `${req.id} 缺少理由`)
  }
})

/* ---------------- 核验环节：逐条 ---------------- */

test('核验 F1：缺少证据块标记且无法解析 → 不合规', () => {
  const result = checkCommFormatCompliance(null, '我改好了，文件在 src/host.ts', 1)
  assert.equal(result.compliant, false)
  assert.ok(result.violations.some((v) => v.ruleId === 'F1'))
})

test('核验 F2：status 缺失或非法 → 不合规', () => {
  const payload = donePayload({ status: 'finished' })
  const result = checkCommFormatCompliance(payload, block(payload), 1)
  assert.equal(result.compliant, false)
  assert.ok(result.violations.some((v) => v.ruleId === 'F2'))
})

test('核验 F3：三阶段缺失 → 不合规', () => {
  const payload = donePayload({ phases: { planning: phasesFixture().planning } })
  const result = checkCommFormatCompliance(payload, block(payload), 1)
  assert.equal(result.compliant, false)
  const f3 = result.violations.find((v) => v.ruleId === 'F3')
  assert.ok(f3)
  assert.match(f3!.message, /execution/)
  assert.match(f3!.message, /verification/)
})

test('核验 F4：pass 无证据 → 不合规', () => {
  const payload = donePayload({ acceptance: [{ criterion: '接口可用', result: 'pass' }] })
  const result = checkCommFormatCompliance(payload, block(payload), 1)
  assert.equal(result.compliant, false)
  assert.ok(result.violations.some((v) => v.ruleId === 'F4'))
})

test('核验 F5：验收条数少于计划 → 不合规', () => {
  const payload = donePayload()
  const result = checkCommFormatCompliance(payload, block(payload), 3)
  assert.equal(result.compliant, false)
  const f5 = result.violations.find((v) => v.ruleId === 'F5')
  assert.ok(f5)
  assert.match(f5!.message, /1/)
  assert.match(f5!.message, /3/)
})

test('核验 F6：产物条目非法（kind 不在枚举内 / ref 为空）→ 不合规', () => {
  for (const artifacts of [[{ kind: 'folder', ref: 'a' }], [{ kind: 'file', ref: '  ' }], [{}]]) {
    const payload = donePayload({ artifacts })
    const result = checkCommFormatCompliance(payload, block(payload), 1)
    assert.equal(result.compliant, false, JSON.stringify(artifacts))
    assert.ok(result.violations.some((v) => v.ruleId === 'F6'))
  }
})

test('核验 F6 边界：无文件产物但条目合法（纯 note/url）不判不合规', () => {
  const payload = donePayload({ artifacts: [{ kind: 'note', ref: '已在 README 中说明' }] })
  const result = checkCommFormatCompliance(payload, block(payload), 1)
  assert.equal(result.compliant, true, '是否有文件产物由计划验收决定，不由格式条决定')
})

test('核验 F7：复盘缺 problems/resolutions/prevention 任一 → 不合规', () => {
  for (const field of ['problems', 'resolutions', 'prevention']) {
    const retro = { ...phasesFixture().verification.retrospective, [field]: [] }
    const phases = phasesFixture()
    phases.verification = { ...phases.verification, retrospective: retro as any }
    const payload = donePayload({ phases })
    const result = checkCommFormatCompliance(payload, block(payload), 1)
    assert.equal(result.compliant, false, field)
    assert.ok(result.violations.some((v) => v.ruleId === 'F7'))
  }
})

test('核验 F8：blocked 但没有 question → 不合规', () => {
  const payload = { status: 'blocked', phases: phasesFixture(), acceptance: [], artifacts: [] }
  const result = checkCommFormatCompliance(payload, block(payload), 0)
  assert.equal(result.compliant, false)
  assert.ok(result.violations.some((v) => v.ruleId === 'F8'))
})

test('核验：合规结果零违规', () => {
  const payload = donePayload()
  const result = checkCommFormatCompliance(payload, block(payload), 1)
  assert.equal(result.compliant, true)
  assert.deepEqual(result.violations, [])
  assert.equal(result.version, COMM_FORMAT_VERSION)
})

/* ---------------- 退回环节 ---------------- */

test('退回：不合规走 blocked/comm-format，并带可读退回通知', () => {
  const output = block(donePayload({ acceptance: [{ criterion: '接口可用', result: 'pass' }] }))
  const verdict = adjudicateResult({ output, expectedAcceptance: ['接口可用'] })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'unverified')
  assert.equal((verdict as any).blockedKind, 'comm-format')
  assert.match(String(verdict.error), /沟通交流格式不合规/)
  assert.match(String(verdict.error), /F4/)
  const notice = String((verdict as any).commFormatRejection)
  assert.match(notice, /结果退回/)
  assert.match(notice, /不要只修一条就重交/)
  assert.match(notice, /F4/)
})

test('退回：合规结果不被误拦，可进入 done', () => {
  const verdict = adjudicateResult({ output: block(donePayload()), expectedAcceptance: ['接口可用'] })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.verification, 'structured')
})

test('退回通知：compliance 通过时为空串（不产生噪音）', () => {
  assert.equal(renderCommFormatRejection({ compliant: true, violations: [], version: 1 }), '')
})

/* ---------------- 兼容边界 ---------------- */

test('兼容边界：requirePhases=false（历史回放）不被格式契约追溯否决', () => {
  const verdict = adjudicateResult({
    output: block({ status: 'done', acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'ok' }], artifacts: [] }),
    requirePhases: false,
  })
  assert.equal(verdict.status, 'done', '旧日志按当时规则合法，不得因新契约翻红')
  assert.equal(verdict.verification, 'structured')
})