/*
 * [2.5.4] 本会话（2026-11-12）用户实锤的机制缺陷中「可安全治本」部分的回归：
 *  ③ 子会话迟到结算不得削弱主 Agent 人工 structured 改判；
 *  ④ 行已裁决 done 后 pendingAdjudication 必须清除；
 *  ⑥ 父级 done 但含 failed/aborted 叶子时摘要显式点名覆盖来源；
 *  ① 2.5.3 头前通知前置闸导出仍在（回归复核）。
 *
 * 同时锁定「不得 loosening 的安全契约」（②/⑤ 经核实为有意契约，非缺陷）：
 *  - reported 行显式写 closure=done 仍拒绝（ forcing 新一轮，见 204 契约测试）；
 *  - 验收覆盖仍拒绝「只回一半」与否定词反转（Q6/U-16/T4 守卫）。
 * ②/⑤ 的用户侧 remedy 走写入侧（结算不写非法 closure / 人工补证带 A 编号），
 * 不改动迁移表与覆盖守卫，故此处断言契约原样。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStatus,
  acceptanceCoverage,
  CLOSURE_TRANSITIONS,
  appendUserMessage,
} from '../src/plan.js'

function row(over: any = {}) {
  return {
    id: 'T1',
    subtaskId: 'T1',
    status: 'in_progress',
    closure: 'assigned',
    revision: 1,
    updatedBy: 'system',
    verification: 'unverified',
    acceptance: [],
    delegates: [],
    summary: '',
    ...over,
  }
}

test('③ 子会话迟到结算保留主 Agent 人工 structured 验收', () => {
  const manual = row({
    status: 'done', closure: 'reported', updatedBy: 'agent', verification: 'structured',
    acceptance: [{ criterion: '甲', result: 'pass', evidence: '盘上文件+命令输出' }],
  })
  const next = applyStatus([manual], 'T1', { status: 'done', updatedBy: 'child', verification: 'unverified', acceptance: [] })
  assert.equal(next[0].verification, 'structured')
  assert.equal(next[0].acceptance.length, 1)
  assert.equal(next[0].acceptance[0].criterion, '甲')
})

test('④ done 裁决清除 pendingAdjudication', () => {
  const timed = row({ pendingAdjudication: true, timeoutCount: 1 })
  const next = applyStatus([timed], 'T1', { status: 'done', updatedBy: 'agent' })
  assert.equal(next[0].pendingAdjudication, false)
  assert.equal(next[0].status, 'done')
})

test('⑥ 父级 done 含 failed/aborted 叶子时摘要显式点名', () => {
  const parent = row({ delegates: [{ member: 'E1', status: 'failed' }, { member: 'M1', status: 'done' }], summary: '根因已实锤' })
  const next = applyStatus([parent], 'T1', { status: 'done', updatedBy: 'agent', summary: '根因已实锤' })
  assert.match(next[0].summary, /中止\/失败叶子：E1/)
  assert.match(next[0].summary, /非该叶子自报完成/)
})

test('② 契约保留：reported 显式退回 done 仍拒绝（不 loosening 迁移表）', () => {
  assert.ok(!CLOSURE_TRANSITIONS.reported.includes('done'))
  const reported = row({ status: 'done', closure: 'reported', updatedBy: 'child' })
  assert.throws(() => applyStatus([reported], 'T1', { status: 'done', closure: 'done', updatedBy: 'child' }), /非法闭环迁移/)
  // 但「不显式指定 closure」的人工复核保留 reported、不抛错（204 既有语义）。
  const ok = applyStatus([reported], 'T1', { status: 'done', verification: 'structured', acceptance: [{ criterion: 'A1', result: 'pass', evidence: 'e' }], updatedBy: 'agent' })
  assert.equal(ok[0].closure, 'reported')
})

test('⑤ 契约保留：只回一半 / 否定词反转仍不覆盖（不 loosening 覆盖守卫）', () => {
  assert.equal(acceptanceCoverage(['通过登录测试与越权测试'], [{ criterion: '通过登录测试', result: 'pass', evidence: 'e' }]).missing.length, 1)
  assert.equal(acceptanceCoverage(['不得超过 5%'], [{ criterion: '超过 5%', result: 'pass', evidence: 'e' }]).missing.length, 1)
  // 同义改写仍覆盖（既有 204 语义）。
  assert.equal(acceptanceCoverage(['数字与T9逐项一致。'], [{ criterion: '数字与T9一致', result: 'pass', evidence: 'e' }]).covered, 1)
})

test('① 2.5.3 头前通知前置闸导出仍在（回归复核）', () => {
  assert.equal(typeof appendUserMessage, 'function')
  const ev: any[] = []
  const session: any = {
    append(t: string, d: any, o: any) { ev.push({ type: t, seq: ev.length, data: d, surfaceOp: o?.surfaceOp }); return ev.length - 1 },
    eventAt(i: number) { return ev[i] },
    get seq() { return ev.length },
  }
  // 示例文案改用未被 C2 禁用清单命中的中性文案：本用例只验证「头前暂存 +
  // 按序补发」的时序契约，与具体文案无关；原 '【规划预告】x' 已被 C2 整条
  // 禁用（见 key-progress-trimming-u3 U3-4a），用它会让用例在闸门前就被丢弃。
  appendUserMessage(session, '预公告 x', undefined, { deferUntilHead: true })
  assert.equal(ev.length, 0)
  session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 's' }] } }, { surfaceOp: 'append' })
  appendUserMessage(session, '【任务分解】y')
  assert.equal(ev[0].type, 'system/message')
  assert.equal(ev.length, 3)
})
