/*
 * [1.9.2] W1：覆盖映射摘要（canonical mapping digest）的可执行契约。
 *
 * 背景：`GATE_rule_design.md` §6.1 写的是 `digest = sha256(canonical(mapping))`，
 * 但没定义 `canonical`；`GATE_case_matrix.md:158`（W1）指出「两个实现会算出不同
 * digest，跨实现无法复算」，并把口径固定为「sort_keys + 紧凑分隔符 + 仅 mapping
 * 的 JSON」，要求 T8 补一行规范化定义。本测试钉住三件事：
 *
 *  1. 规范化文本的字节形状（键序、分隔符、数组顺序、非 ASCII）；
 *  2. 与 T9 `gate_rule_check.py::mapping_digest` 的**跨实现一致**：用例取自
 *     `_rerun_20261101/gate_cases.json` 的真实 mapping 与脚本算出的 digest；
 *  3. 失败语义：任何无法复核的输入一律 false（stale），且 present 复验在
 *     digest 不一致时以 SUPERSEDED_STALE 拒绝交付。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildResultMessage,
  CANCEL_MARKER_BEGIN,
  CANCEL_MARKER_END,
  createStatuses,
  derivePlanSnapshot,
  makeUserMessage,
} from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import {
  canonicalMappingJson,
  computeMappingDigest,
  isMappingDigest,
  verifyMappingDigest,
  withMappingDigest,
} from '../src/supersede-digest.js'

/* T9 合成用例（gate_cases.json → cases[1].session.records[0].supersededBy）的真实 mapping。 */
const T9_MAPPING = Array.from({ length: 8 }, (_, i) => ({
  from: `T${i + 1}`,
  to: `T${i + 1}`,
  basis: `合成占位：T${i + 1} 由覆盖计划 T${i + 1} 交付`,
}))
const T9_DIGEST = 'sha256:a686d5fd625879bd54e83bdce58d2820e63eb27641a5d50abed497b809e7ccf8'

test('canonicalMappingJson：键按码位排序、紧凑分隔符、数组顺序保持、非 ASCII 原样', () => {
  assert.equal(
    canonicalMappingJson({ z: '中', a: [{ y: true, x: null }], n: 1 }),
    '{"a":[{"x":null,"y":true}],"n":1,"z":"中"}',
  )
  assert.equal(
    canonicalMappingJson([{ from: 'T2' }, { from: 'T1' }]),
    '[{"from":"T2"},{"from":"T1"}]',
    '数组顺序是存储顺序，不排序',
  )
  assert.equal(canonicalMappingJson({ a: undefined, b: 'x', c: () => 1 }), '{"b":"x"}')
  assert.equal(canonicalMappingJson([undefined, () => 1]), '[null,null]')
  assert.equal(canonicalMappingJson('\u2028'), '"\u2028"', '不额外转义 U+2028')
})

test('W1 跨实现一致：与 T9 脚本对同一 mapping 算出同一 digest', () => {
  assert.equal(computeMappingDigest(T9_MAPPING), T9_DIGEST)
  /* 第二组独立样本，期望值由 Python json.dumps(sort_keys,separators) 算出。 */
  assert.equal(
    computeMappingDigest([
      { from: 'T2', to: 'T2', basis: 'B' },
      { from: 'T1', to: 'T1', basis: 'A' },
    ]),
    'sha256:70f13ac6706031000a56d53abf395f943d942c91ffaafa5f02a0d7c6da4651d8',
  )
  /* 键序不影响摘要（sort_keys 的意义）。 */
  assert.equal(
    computeMappingDigest([{ to: 'T1', basis: '合成占位：T1 由覆盖计划 T1 交付', from: 'T1' }]),
    'sha256:75305afbe9176bff245afd100b97806060c8c057882a3f30a125181bb45b11f9',
  )
})

test('W1 失败语义：被改动/缺失/格式非法一律不可复核（false），不抛异常', () => {
  const digest = computeMappingDigest(T9_MAPPING)
  assert.equal(verifyMappingDigest(T9_MAPPING, digest), true)

  const tampered = T9_MAPPING.map((item, i) => (i === 3 ? { ...item, basis: '被改写的依据' } : item))
  assert.equal(verifyMappingDigest(tampered, digest), false, 'basis 参与摘要，改动必须被发现')
  const shortened = T9_MAPPING.slice(0, 7)
  assert.equal(verifyMappingDigest(shortened, digest), false, '少一项必须被发现')

  assert.equal(verifyMappingDigest(T9_MAPPING, undefined), false)
  assert.equal(verifyMappingDigest(T9_MAPPING, 'sha256:ABC'), false)
  assert.equal(verifyMappingDigest(T9_MAPPING, digest.toUpperCase()), false, '只接受小写十六进制')
  assert.equal(verifyMappingDigest(null, digest), false)
  assert.equal(isMappingDigest(digest), true)
  assert.equal(isMappingDigest(`${digest}0`), false)

  assert.throws(() => computeMappingDigest({ from: 'T1' }), TypeError, '写入非数组是编程错误')
  assert.throws(() => withMappingDigest({ planId: 'wp-x' }), TypeError)
})

test('withMappingDigest：运行时复算覆盖调用方自报的 digest', () => {
  const by = withMappingDigest({ planId: 'wp-cov', mapping: T9_MAPPING, digest: 'sha256:deadbeef' })
  assert.equal(by.digest, T9_DIGEST)
  assert.equal(by.planId, 'wp-cov')
  assert.equal(verifyMappingDigest(by.mapping, by.digest), true)
})

/* ---------------------------------------------------------------- present 复验 */

function planOf(planId: string, count: number) {
  return {
    planId,
    sessionId: 'session-w1',
    createdTurn: 1,
    createdAt: 1000,
    title: `W1 ${planId}`,
    contradictions: { primary: { statement: '被取代不等于完成' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: Array.from({ length: count }, (_, i) => ({
        id: `T${i + 1}`,
        title: `第 ${i + 1} 步`,
        department: 'engineering',
        dependsOn: i === 0 ? [] : [`T${i}`],
      })),
    }],
  }
}

function markDone(status: any) {
  status.status = 'done'
  status.progress = 100
  status.verification = 'structured'
  status.acceptance = [{ criterion: `${status.subtaskId} 验收`, result: 'pass', evidence: 'npm test' }]
  status.missingArtifacts = []
}

function sessionWith(plans: any[], statusesByPlan: Record<string, any[]>, supersede?: any) {
  const events: any[] = []
  const session: any = {
    id: 'session-w1',
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
  for (const plan of plans) session.append('user/message', buildPlanMessage(plan))
  session.append('turn/start', { turn: 1 })
  for (const plan of plans) {
    const statuses = statusesByPlan[plan.planId]
    if (!statuses) continue
    session.append('user/message', buildResultMessage({
      planId: plan.planId,
      sessionId: session.id,
      dispatchedAt: 2000,
      statuses,
      errors: [],
      stats: derivePlanSnapshot(statuses).stats,
      phase: 'executing',
    }))
  }
  if (supersede) {
    const payload = {
      kind: 'workplan-cancel',
      version: 1,
      planId: supersede.planId,
      reason: '按用户确认迁移到覆盖计划',
      cancelledAt: 3000,
      disposition: 'superseded',
      supersededBy: supersede.supersededBy,
    }
    session.append('user/message', makeUserMessage([
      '【任务已取消】按用户确认迁移到覆盖计划',
      '',
      CANCEL_MARKER_BEGIN,
      JSON.stringify(payload),
      CANCEL_MARKER_END,
    ].join('\n'), { kind: 'workplan-cancel', form: 'notice', summary: '按用户确认迁移到覆盖计划' }))
  }
  return session
}

function runtimeFor() {
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('never dispatch') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  return createWorkplanRuntime(ctx as any, { version: 'test' }) as any
}

test('present 复验：digest 不一致 ⇒ SUPERSEDED_STALE（点名承接计划就绪也不放行）', () => {
  const source = planOf('wp-src', 2)
  const successor = planOf('wp-cov', 2)
  const sourceStatuses: any[] = createStatuses(source)
  markDone(sourceStatuses[0])
  const successorStatuses: any[] = createStatuses(successor)
  successorStatuses.forEach(markDone)
  assert.equal(derivePlanSnapshot(successorStatuses).stats.done, 2)

  const mapping = [
    { from: 'T1', to: 'T1', basis: 'T1 已由覆盖计划交付' },
    { from: 'T2', to: 'T2', basis: 'T2 已由覆盖计划交付' },
  ]
  const good = sessionWith([source, successor], { 'wp-src': sourceStatuses, 'wp-cov': successorStatuses }, {
    planId: 'wp-src',
    supersededBy: { successorPlanId: 'wp-cov', mapping, digest: computeMappingDigest(mapping) },
  })
  assert.equal(runtimeFor().presentDenialReason({ session: good }), undefined,
    '摘要可复核 + 承接计划就绪 ⇒ 放行（产物来自承接计划）')

  const tampered = sessionWith([source, successor], { 'wp-src': sourceStatuses, 'wp-cov': successorStatuses }, {
    planId: 'wp-src',
    supersededBy: {
      successorPlanId: 'wp-cov',
      mapping: mapping.map((item, i) => (i === 1 ? { ...item, basis: '改写过' } : item)),
      digest: computeMappingDigest(mapping),
    },
  })
  const reason = runtimeFor().presentDenialReason({ session: tampered })
  assert.ok(reason, '摘要不一致必须拒绝')
  assert.match(reason, /SUPERSEDED_STALE/)
  assert.match(reason, /摘要与逐项映射不一致/)
  assert.match(reason, /不得调用 present/)
  assert.match(reason, /已被取代/, '拒绝文案必须说明记录仍是被取代，而不是完成')
  assert.doesNotMatch(reason, /任务完成|全部完成/, '拒绝文案不得把被取代写成完成')

  const noMapping = sessionWith([source, successor], { 'wp-src': sourceStatuses, 'wp-cov': successorStatuses }, {
    planId: 'wp-src',
    supersededBy: { successorPlanId: 'wp-cov', digest: computeMappingDigest(mapping) },
  })
  const missing = runtimeFor().presentDenialReason({ session: noMapping })
  assert.match(String(missing), /缺少可复算的逐项映射/)
  assert.match(String(missing), /SUPERSEDED_STALE/)
})
