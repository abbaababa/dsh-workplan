/**
 * [2.5.4][T6] estimate 契约防漂移测试（src/dept-journal.ts 通道层）。
 *
 * 唯一权威契约：
 *   - _t5_channel_20261112/00-contract-v1.md §1/§2/§5（FROZEN；§5 预留 estimate 形状）
 *   - _t6_estimate_20261112/00-contract-estimate-v1.md §4（FROZEN；from 叶子→to head，
 *     data={ declaredMinutes, reason? } 即 T5 §5 预留形状）
 *
 * 目的：钉住冻结形状，防下游私删/私改——
 *   ① kind='estimate' 经 validateDeptMessage 通过且 data 形状与 T5 §5 预留一致；
 *   ② from 叶子（expert/member 带 member 名）→ to head 端点校验（缺 member 名 fail-closed 拒）；
 *   ③ appendDeptMessage + readDeptMessages(kind:'estimate') 临时目录往返一致、坏行计 skipped；
 *   ④ DEPT_MESSAGE_KINDS 仍含全部 7 kind（防下游私删）；
 *   ⑤ declaredMinutes 为正整数时 data JSON 可序列化且 ≤4000。
 *
 * 边界：只测 journal 通道层对 estimate 的承载与往返；declaredMinutes 的正整数/1..10080
 * 数值门禁属 T6 self_effort 层（契约 T6 §2），journal 层不校验该语义，本文件不虚构该拒收。
 *
 * 纪律（T5 契约 §6 同口径）：
 *   - env DSH_WORKPLAN_JOURNAL_DIR 指向工作区临时目录，测后清理（after + exit 双保险）；
 *   - 不碰共享 dist/lib：类型验收用 npx tsc -p tsconfig.test.json --noEmit；
 *     运行验收用私有临时 outDir 编译 + node --test（范式 dept-journal.test.ts 头注口径）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEPT_MESSAGE_KINDS,
  makeDeptMessageId,
  validateDeptMessage,
  deptJournalPath,
  appendDeptMessage,
  readDeptMessages,
} from '../src/dept-journal.js'
import type { DeptMessage } from '../src/dept-journal.js'

/* 工作区临时目录（cwd 在插件根/工作区内），测后清理并还原 env。 */
const baseDir = mkdtempSync(join(process.cwd(), '.tmp-dept-estimate-contract-'))
const prevEnv = process.env.DSH_WORKPLAN_JOURNAL_DIR
process.env.DSH_WORKPLAN_JOURNAL_DIR = baseDir
function cleanupTempDir(): void {
  try {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 兜底失败不掩盖测试结果；残留目录以 .tmp-dept-estimate-contract- 前缀可识别 */
  }
  if (prevEnv === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = prevEnv
}
after(cleanupTempDir)
process.on('exit', cleanupTempDir)

let seq = 0
function freshPlanId(tag: string): string {
  seq += 1
  return `t6est-${tag}-${seq}`
}

/** T6 §4 口径的 estimate 消息工厂：from 叶子（带 member 名）→ to head。 */
function makeEstimateMsg(over: Partial<DeptMessage> = {}): DeptMessage {
  const now = Date.now()
  const base: DeptMessage = {
    v: 1,
    id: makeDeptMessageId(now),
    ts: now,
    planId: 't6est-default',
    subtaskId: 'T6',
    kind: 'estimate',
    from: { sessionId: 'sess-leaf-est-001', role: 'member', member: 'estimate-contract-member' },
    to: { sessionId: 'sess-head-est-001', role: 'head' },
    body: '【第三层开工预估】执行本人任务约需 15 分钟（整数分钟）。',
    data: { declaredMinutes: 15, reason: '中等复杂度' },
    delivery: { status: 'sent', messageId: 'm-est-1' },
  }
  return { ...base, ...over }
}

test('① estimate 经 validateDeptMessage 通过，data 形状与 T5 §5 预留一致（含 reason 缺省）', () => {
  const withReason = makeEstimateMsg()
  const verdict = validateDeptMessage(withReason)
  assert.equal(verdict.ok, true, 'estimate（带 reason）应通过校验')
  if (!verdict.ok) return
  assert.equal(verdict.value.kind, 'estimate')
  assert.deepEqual(verdict.value.data, { declaredMinutes: 15, reason: '中等复杂度' })
  /* T5 §5 预留形状：declaredMinutes 数字 ＋ reason 可选字符串，无其他必填键。 */
  const data = verdict.value.data as Record<string, unknown>
  assert.equal(typeof data.declaredMinutes, 'number')
  assert.equal(typeof data.reason, 'string')

  const noReason = makeEstimateMsg({ data: { declaredMinutes: 8 } })
  const verdict2 = validateDeptMessage(noReason)
  assert.equal(verdict2.ok, true, 'estimate（reason 缺省）应通过校验')
  if (!verdict2.ok) return
  assert.deepEqual(verdict2.value.data, { declaredMinutes: 8 })
  assert.ok(!('reason' in (verdict2.value.data as Record<string, unknown>)))
})

test('② from 叶子（expert/member 带 member 名）→ to head 端点校验；缺 member 名 fail-closed 拒', () => {
  for (const role of ['expert', 'member'] as const) {
    const msg = makeEstimateMsg({
      from: { sessionId: 'sess-leaf-est-002', role, member: `leaf-${role}` },
      to: { sessionId: 'sess-head-est-002', role: 'head' },
    })
    const verdict = validateDeptMessage(msg)
    assert.equal(verdict.ok, true, `from ${role}（带 member 名）→ head 应通过`)
    if (!verdict.ok) return
    assert.deepEqual(verdict.value.from, { sessionId: 'sess-leaf-est-002', role, member: `leaf-${role}` })
    assert.deepEqual(verdict.value.to, { sessionId: 'sess-head-est-002', role: 'head' })
  }
  /* head 端点 member 可选（T5 §1）：不带 member 名同样通过。 */
  assert.equal(validateDeptMessage(makeEstimateMsg()).ok, true)
  /* 叶子缺 member 名一律拒（T5 §1/§2 fail-closed）。 */
  for (const role of ['expert', 'member'] as const) {
    const bad = makeEstimateMsg({ from: { sessionId: 'sess-leaf-est-003', role } })
    const verdict = validateDeptMessage(bad)
    assert.equal(verdict.ok, false, `from ${role} 缺 member 名应被拒`)
    if (verdict.ok) return
    assert.match(verdict.error, /member/)
    const wrote = appendDeptMessage(bad)
    assert.equal(wrote.ok, false)
    if (wrote.ok) return
    assert.equal(wrote.code, 'JOURNAL_WRITE_FAILED')
  }
})

test('③ append + read(kind:estimate) 临时目录往返一致；坏行计 skipped、kind 过滤只回 estimate', () => {
  const planId = freshPlanId('roundtrip')
  const est1 = makeEstimateMsg({ planId, body: '预估-1', ts: 1000, data: { declaredMinutes: 15, reason: '中等复杂度' } })
  const est2 = makeEstimateMsg({ planId, body: '预估-2', ts: 2000, data: { declaredMinutes: 8 } })
  const other = makeEstimateMsg({ planId, kind: 'instruction', body: '非 estimate', ts: 3000, data: { inReplyTo: 'msg-x' } })
  for (const msg of [est1, other, est2]) {
    const wrote = appendDeptMessage(msg)
    assert.equal(wrote.ok, true, `写入失败：${msg.body}`)
    if (!wrote.ok) return
    assert.ok(wrote.path.endsWith(`${planId}.jsonl`))
    assert.ok(existsSync(wrote.path))
  }
  const read = readDeptMessages(planId, { kind: 'estimate' })
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.skipped, 0)
  assert.deepEqual(read.messages, [est1, est2], 'kind 过滤后应按追加序逐字段一致')

  /* 坏行：JSON 损坏 ＋ 校验不过（缺 body）都计 skipped；空行不计；好行照常回放。 */
  const badPlanId = freshPlanId('badlines')
  const good1 = makeEstimateMsg({ planId: badPlanId, body: '好行1' })
  const good2 = makeEstimateMsg({ planId: badPlanId, body: '好行2' })
  const invalidShape = makeEstimateMsg({ planId: badPlanId }) as unknown as Record<string, unknown>
  delete invalidShape.body
  writeFileSync(deptJournalPath(badPlanId), [
    JSON.stringify(good1),
    'this-is-not-json',
    JSON.stringify(invalidShape),
    '',
    JSON.stringify(good2),
  ].join('\n') + '\n', 'utf8')
  const badRead = readDeptMessages(badPlanId, { kind: 'estimate' })
  assert.equal(badRead.ok, true)
  if (!badRead.ok) return
  assert.equal(badRead.skipped, 2)
  assert.deepEqual(badRead.messages.map((m) => m.body), ['好行1', '好行2'])
})

test('④ DEPT_MESSAGE_KINDS 仍含全部 7 kind 且冻结（防下游私删）', () => {
  assert.deepEqual([...DEPT_MESSAGE_KINDS], [
    'dispatch', 'instruction', 'escalation', 'estimate', 'completion', 'need', 'receipt',
  ])
  assert.equal(DEPT_MESSAGE_KINDS.length, 7)
  assert.ok(DEPT_MESSAGE_KINDS.includes('estimate'), 'estimate 不得被私删')
  assert.ok(Object.isFrozen(DEPT_MESSAGE_KINDS))
})

test('⑤ declaredMinutes 为正整数时 data JSON 可序列化且 ≤4000，往返后逐字段一致', () => {
  const samples: Array<Record<string, unknown>> = [
    { declaredMinutes: 15, reason: '中等复杂度' },
    { declaredMinutes: 1 },
    { declaredMinutes: 10080, reason: 'x'.repeat(300) },
  ]
  for (const data of samples) {
    const json = JSON.stringify(data)
    assert.equal(typeof json, 'string', 'data 必须可 JSON 序列化')
    assert.ok(json.length <= 4000, `data JSON 应 ≤4000，实际 ${json.length}`)
    const planId = freshPlanId('serial')
    const msg = makeEstimateMsg({ planId, data })
    const verdict = validateDeptMessage(msg)
    assert.equal(verdict.ok, true, `正整数 declaredMinutes=${String(data.declaredMinutes)} 应通过`)
    if (!verdict.ok) return
    assert.equal(appendDeptMessage(msg).ok, true)
    const read = readDeptMessages(planId, { kind: 'estimate' })
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.skipped, 0)
    assert.equal(read.messages.length, 1)
    assert.deepEqual(read.messages[0].data, data, '往返后 data 逐字段一致')
  }
})
