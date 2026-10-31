/*
 * [1.7.0] The evidence contract.
 *
 * The 1.6.0 review found the worst collaboration break: a child's non-empty
 * output was counted as `done` whatever it said, so a model could report
 * "unverified" or "one check failed" and the plan still showed that work as
 * finished. These tests pin the deterministic adjudication table
 * (`adjudicateResult`) and the review block the main Agent receives.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  buildResultMessage,
  messageText,
  parseEvidenceBlock,
} from '../src/plan.js'

function block(payload: any, prefix = '做完了。') {
  return `${prefix}\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function donePayload(overrides: any = {}) {
  return {
    status: 'done',
    summary: '实现完成',
    acceptance: [{ criterion: '接口可用', result: 'pass' }],
    artifacts: [{ kind: 'file', ref: 'src/host.ts' }],
    needs: [],
    ...overrides,
  }
}

test('结构化结果：全部验收通过才算 structured/done', () => {
  const verdict = adjudicateResult({ output: block(donePayload()) })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.verification, 'structured')
  assert.equal(verdict.acceptance.length, 1)
  assert.equal(verdict.artifacts[0].ref, 'src/host.ts')
  assert.equal(verdict.error, null)
})

test('结构化结果：acceptance 为空不得算 structured（T5-D）', () => {
  const verdict = adjudicateResult({ output: block(donePayload({ acceptance: [] })) })
  assert.equal(verdict.status, 'done', '没有验收项不等于失败，但也不等于已验证')
  assert.equal(verdict.verification, 'unverified', '空验收必须降级为 unverified，不能冒充 structured')
})

test('结构化结果：存在 unverified 验收项 → done 但标记 unverified', () => {
  const verdict = adjudicateResult({
    output: block(donePayload({ acceptance: [{ criterion: '接口可用', result: 'unverified' }] })),
  })
  assert.equal(verdict.status, 'done', '未验证不等于失败，不能直接判 blocked')
  assert.equal(verdict.verification, 'unverified', '主 Agent 必须知道不能直接采信')
})

test('结构化结果：任一验收 fail → 按受阻处理（failed）', () => {
  const verdict = adjudicateResult({
    output: block(donePayload({ acceptance: [{ criterion: '测试通过', result: 'fail' }] })),
  })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'failed')
})

test('结构化结果：status=partial 视为受阻并写明部分完成', () => {
  const verdict = adjudicateResult({
    output: block(donePayload({ status: 'partial', summary: '只改了 host，没补测试' })),
  })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'structured')
  assert.match(String(verdict.error), /部分完成/)
  assert.match(String(verdict.error), /没补测试/)
})

test('结构化结果：status=blocked 带原因与 needs', () => {
  const verdict = adjudicateResult({
    output: block({ status: 'blocked', blockedReason: '缺少上游产物', needs: ['需要 T2 的接口清单'] }),
  })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.error, '缺少上游产物')
  assert.deepEqual(verdict.needs, ['需要 T2 的接口清单'])
})

test('坏块 → 受阻且标记 unparsable，绝不按完成放行', () => {
  const verdict = adjudicateResult({ output: `${EVIDENCE_MARKER_BEGIN}\n{not json\n${EVIDENCE_MARKER_END}` })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'unparsable')
})

test('无结构化块但首行 BLOCKED → 旧格式受阻', () => {
  const verdict = adjudicateResult({ output: 'BLOCKED：等不到依赖' })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'legacy')
  assert.match(String(verdict.error), /等不到依赖/)
})

test('无结构化块的普通汇报 → done/legacy（保持旧行为，主 Agent 自行核对）', () => {
  const verdict = adjudicateResult({ output: '我改好了，文件在 src/host.ts' })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.verification, 'legacy')
})

test('strict=false 完全回到 1.6.0 判定，便于旧计划回放', () => {
  const failed = block(donePayload({ acceptance: [{ criterion: '测试通过', result: 'fail' }] }))
  assert.equal(adjudicateResult({ output: failed }).status, 'blocked')
  const legacy = adjudicateResult({ output: failed, strict: false })
  assert.equal(legacy.status, 'done')
  assert.equal(legacy.verification, 'legacy')
})

test('多个证据块时以最后一个为准（提示词模板在前、真实结论在后）', () => {
  const output = `${block(donePayload())}\n\n实际结论：\n${block({ status: 'blocked', blockedReason: '依赖缺失' })}`
  const parsed = parseEvidenceBlock(output)
  assert.equal(parsed.found, true)
  assert.equal(parsed.payload.status, 'blocked')
  assert.equal(adjudicateResult({ output }).status, 'blocked')
})

test('结果消息把未验证、自检失败、旧格式、缺失产物、needs 逐项交给主 Agent', () => {
  const message = buildResultMessage({
    planId: 'wp-evidence',
    sessionId: 'session-evidence',
    phase: 'blocked',
    stats: { total: 3, done: 2, blocked: 1, inProgress: 0, pending: 0, progress: 66 },
    statuses: [
      { subtaskId: 'T1', status: 'done', verification: 'structured', acceptance: [{ criterion: 'a', result: 'pass' }], missingArtifacts: ['lib/app.js'], needs: ['需要 T2 提供表格'] },
      { subtaskId: 'T2', status: 'done', verification: 'unverified', acceptance: [{ criterion: 'b', result: 'unverified' }] },
      { subtaskId: 'T3', status: 'done', verification: 'legacy' },
    ],
  })
  const text = messageText(message)
  assert.match(text, /验收核对/)
  assert.match(text, /未验证 1 条：T2/)
  assert.match(text, /未提供结构化证据 1 条：T3/)
  assert.match(text, /声明产物缺失：T1：lib\/app\.js/)
  assert.match(text, /跨部门待转达/)
  assert.match(text, /需要 T2 提供表格/)
  assert.match(text, /不要声称未验证的完成/)
})
