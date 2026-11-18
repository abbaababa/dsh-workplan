/*
 * [3.0.6][第 3 批②] 专用通知台账（notice-ledger）回归。
 *
 * 钉住语义：
 *  1. appendUserMessage 成功落盘 workplan 通知 ⇒ 台账 JSONL 同步多一行，
 *     kind/form/summary/text/sessionId 齐全（权威、机器可读的通知流）；
 *  2. 非 workplan 来源（如真实用户输入的 kind='user'）⇒ 不进台账；
 *  3. 台账写失败 ⇒ 不拖垮投递（appendUserMessage 照常返回），失败行进内存
 *     环形缓冲；下一次成功写入时先行补落，不丢行。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { appendUserMessage } from '../src/plan.js'
import {
  NOTICE_LEDGER_OVERFLOW_MAX,
  appendNoticeLedger,
  noticeLedgerOverflowSize,
  readNoticeLedger,
} from '../src/notice-ledger.js'

function makeSession(id = 'session-notice-ledger') {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) {
      events.push({ type, data, seq: events.length })
      return { type, data, seq: events.length - 1 }
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

/** 构造一个必然写入失败的路径：父路径里有一段是已存在的普通文件。 */
function guaranteedBadPath(dir: string): string {
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  return join(blocker, 'notices.jsonl')
}

function tempLedger(testObj: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-notices-'))
  process.env.DSH_WORKPLAN_NOTICES_FILE = join(dir, 'notices.jsonl')
  testObj.after(() => {
    delete process.env.DSH_WORKPLAN_NOTICES_FILE
    rmSync(dir, { recursive: true, force: true })
  })
  return process.env.DSH_WORKPLAN_NOTICES_FILE
}

test('workplan 通知落盘 ⇒ 台账同步一行，字段齐全', (t) => {
  const file = tempLedger(t)
  const session = makeSession()
  const before = readNoticeLedger(file).length
  appendUserMessage(session, 'dsh-workplan 台账测试：第一步已完成', undefined, { deferUntilHead: false })
  const rows = readNoticeLedger(file)
  assert.equal(rows.length, before + 1)
  const row = rows.at(-1)!
  assert.equal(row.sessionId, 'session-notice-ledger')
  assert.equal(row.kind, 'workplan')
  assert.equal(row.form, 'notice')
  assert.equal(row.text, 'dsh-workplan 台账测试：第一步已完成')
  assert.ok(row.summary.length > 0)
  assert.ok(row.surfaceSeq >= 0, '应记录对应的 user/message seq')
})

test('非 workplan 来源（真实用户输入）⇒ 不进台账', (t) => {
  const file = tempLedger(t)
  const session = makeSession()
  const before = readNoticeLedger(file).length
  appendUserMessage(session, '用户真实输入', { kind: 'user', form: 'input' }, { deferUntilHead: false })
  assert.equal(readNoticeLedger(file).length, before)
})

test('台账写失败 ⇒ 投递不抛错，失败行进内存缓冲，下次写入补落', (t) => {
  const goodDir = join(mkdtempSync(join(tmpdir(), 'dsh-workplan-notices-')), 'd')
  mkdirSync(goodDir)
  t.after(() => rmSync(goodDir, { recursive: true, force: true }))
  const goodFile = join(goodDir, 'notices.jsonl')
  const badFile = guaranteedBadPath(goodDir)
  // 直接走 appendNoticeLedger 制造失败（不经投递路径）。
  const ok1 = appendNoticeLedger('s-fail', { content: [{ type: 'text', text: '第一行' }], source: { kind: 'workplan' } }, badFile)
  assert.equal(ok1, false)
  assert.equal(noticeLedgerOverflowSize(), 1)
  // 下一次写到合法文件：积压行 + 新行一起落盘。
  const ok2 = appendNoticeLedger('s-fail', { content: [{ type: 'text', text: '第二行' }], source: { kind: 'workplan' } }, goodFile)
  assert.equal(ok2, true)
  assert.equal(noticeLedgerOverflowSize(), 0, '补落成功后缓冲必须清空')
  const rows = readNoticeLedger(goodFile)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, '第一行', '失败行必须先补落，不能丢')
  assert.equal(rows[1].text, '第二行')
})

test('环形缓冲有上限且不清空丢弃：积压超限后保留最新 N 条', (t) => {
  const goodDir = join(mkdtempSync(join(tmpdir(), 'dsh-workplan-notices-')), 'd')
  mkdirSync(goodDir)
  t.after(() => rmSync(goodDir, { recursive: true, force: true }))
  const goodFile = join(goodDir, 'notices.jsonl')
  const badFile = guaranteedBadPath(goodDir)
  const total = NOTICE_LEDGER_OVERFLOW_MAX + 5
  for (let i = 0; i < total; i += 1) {
    appendNoticeLedger('s-ring', { content: [{ type: 'text', text: `行${i}` }], source: { kind: 'workplan' } }, badFile)
  }
  assert.equal(noticeLedgerOverflowSize(), NOTICE_LEDGER_OVERFLOW_MAX)
  appendNoticeLedger('s-ring', { content: [{ type: 'text', text: '新行' }], source: { kind: 'workplan' } }, goodFile)
  const rows = readNoticeLedger(goodFile)
  assert.equal(rows.length, NOTICE_LEDGER_OVERFLOW_MAX + 1)
  assert.equal(rows.at(-1)!.text, '新行')
  assert.equal(rows[0].text, '行5', '环形缓冲保留最新的 N 条（最旧的 5 条被挤出）')
})

test('写失败不拖垮 appendUserMessage 投递', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-notices-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 台账指向必然失败的路径（父路径是已存在的普通文件）：投递仍成功，失败行进缓冲。
  process.env.DSH_WORKPLAN_NOTICES_FILE = guaranteedBadPath(dir)
  const session = makeSession()
  const appended = appendUserMessage(session, 'dsh-workplan 投递不依赖台账', undefined, { deferUntilHead: false })
  assert.ok(appended, 'user/message 投递必须成功（台账只是旁路留痕）')
  assert.ok(noticeLedgerOverflowSize() > 0)
  noticeLedgerOverflowSize() // 观测值已被上面断言钉住；缓冲由后续成功写入补落。
})
