/**
 * [2.5.4][T5] 部门消息留痕（src/dept-journal.ts）契约回归。
 *
 * 唯一权威契约：_t5_channel_20261112/00-contract-v1.md §1/§2（FROZEN）。
 * 纪律（契约 §6）：
 *   - 一律 env DSH_WORKPLAN_JOURNAL_DIR 指向工作区临时目录（沙箱内 ~/.dsh 可能不可写），测后清理；
 *   - 不碰共享 dist/lib：本文件可私有编译运行（负责人消息指定的 tsc --outDir 私有目录 + node --test）。
 * 覆盖：7 种 kind 往返、追加序回放、坏行 skipped、非法消息 fail-closed 拒收、
 *       写失败显式 JOURNAL_WRITE_FAILED、N 条追加零丢失、limit 默认 500 上限 5000、
 *       kind/since 过滤、planId 路径穿越拒绝、body 控制字符清洗、跨进程重启持久。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEPT_MESSAGE_VERSION,
  DEPT_MESSAGE_KINDS,
  DEPT_ROLES,
  makeDeptMessageId,
  validateDeptMessage,
  deptJournalPath,
  appendDeptMessage,
  readDeptMessages,
} from '../src/dept-journal.js'
import type { DeptMessage, DeptKind } from '../src/dept-journal.js'

/* 工作区临时目录（cwd 在插件根/工作区内），测后清理并还原 env。
 * 清理用 after 钩子 + process exit 兜底双保险：node --test 子进程退出前必清。 */
const baseDir = mkdtempSync(join(process.cwd(), '.tmp-dept-journal-'))
const prevEnv = process.env.DSH_WORKPLAN_JOURNAL_DIR
process.env.DSH_WORKPLAN_JOURNAL_DIR = baseDir
function cleanupTempDir(): void {
  try {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 兜底失败不掩盖测试结果；残留目录以 .tmp-dept-journal- 前缀可识别 */
  }
  if (prevEnv === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = prevEnv
}
after(cleanupTempDir)
process.on('exit', cleanupTempDir)

let seq = 0
function freshPlanId(tag: string): string {
  seq += 1
  return `t5j-${tag}-${seq}`
}

function makeMsg(over: Partial<DeptMessage> = {}): DeptMessage {
  const now = Date.now()
  const base: DeptMessage = {
    v: 1,
    id: makeDeptMessageId(now),
    ts: now,
    planId: 't5j-default',
    subtaskId: 'T5',
    kind: 'instruction',
    from: { sessionId: 'sess-head-001', role: 'head' },
    to: { sessionId: 'sess-leaf-001', role: 'member', member: 'journal-member' },
    body: '契约测试正文',
    delivery: { status: 'sent', messageId: 'm-1' },
  }
  return { ...base, ...over }
}

const KIND_DATA: Record<DeptKind, Record<string, unknown>> = {
  dispatch: { task: '实现双向通道' },
  instruction: { inReplyTo: 'msg-abc123' },
  escalation: { options: ['方案A', '方案B'], needs: ['落点清单'] },
  estimate: { declaredMinutes: 15, reason: '中等复杂度' },
  completion: { status: 'done', acceptanceCount: 4, artifacts: ['reports/x.json'] },
  need: { text: '需要契约落点' },
  receipt: { forMessageId: 'msg-abc123', observedAt: 1_763_000_000_000 },
}

test('冻结常量与契约 §2 一致（版本/7 kind/4 role/frozen）', () => {
  assert.equal(DEPT_MESSAGE_VERSION, 1)
  assert.deepEqual([...DEPT_MESSAGE_KINDS], [
    'dispatch', 'instruction', 'escalation', 'estimate', 'completion', 'need', 'receipt',
  ])
  assert.deepEqual([...DEPT_ROLES], ['root', 'head', 'expert', 'member'])
  assert.ok(Object.isFrozen(DEPT_MESSAGE_KINDS))
  assert.ok(Object.isFrozen(DEPT_ROLES))
})

test('makeDeptMessageId：形如 msg-<ts36>-<rand6>、≤80、唯一、尊重 now', () => {
  const now = 1_763_000_000_123
  const id = makeDeptMessageId(now)
  assert.match(id, /^msg-[0-9a-z]+-[0-9a-f]{6}$/)
  assert.ok(id.length <= 80)
  assert.ok(id.startsWith(`msg-${now.toString(36)}-`))
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i += 1) {
    const next = makeDeptMessageId()
    assert.ok(next.length <= 80)
    assert.ok(!seen.has(next), `id 重复：${next}`)
    seen.add(next)
  }
})

test('7 种 kind 往返：append ok → read 逐字段一致（含 kind 专属 data）', () => {
  for (const kind of DEPT_MESSAGE_KINDS) {
    const planId = freshPlanId(`kind-${kind}`)
    const msg = makeMsg({ planId, kind, data: KIND_DATA[kind] })
    const wrote = appendDeptMessage(msg)
    assert.equal(wrote.ok, true, `kind=${kind} 写入失败`)
    if (!wrote.ok) return
    assert.ok(wrote.path.endsWith(`${planId}.jsonl`))
    assert.ok(existsSync(wrote.path))
    const read = readDeptMessages(planId)
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.skipped, 0)
    assert.equal(read.messages.length, 1)
    assert.deepEqual(read.messages[0], msg)
  }
})

test('追加序回放：20 条按写入顺序原样读回', () => {
  const planId = freshPlanId('order')
  for (let i = 0; i < 20; i += 1) {
    const wrote = appendDeptMessage(makeMsg({ planId, body: `第${i}条`, ts: 1000 + i }))
    assert.equal(wrote.ok, true)
  }
  const read = readDeptMessages(planId)
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.messages.length, 20)
  assert.deepEqual(read.messages.map((m) => m.body), Array.from({ length: 20 }, (_, i) => `第${i}条`))
})

test('坏行计入 skipped：JSON 损坏与校验不过都计数，空行不计，好行照常回放', () => {
  const planId = freshPlanId('badlines')
  const good1 = makeMsg({ planId, body: '好行1' })
  const good2 = makeMsg({ planId, body: '好行2' })
  const invalidShape = makeMsg({ planId }) as unknown as Record<string, unknown>
  delete invalidShape.body
  const file = deptJournalPath(planId)
  writeFileSync(file, [
    JSON.stringify(good1),
    'this-is-not-json',
    JSON.stringify(invalidShape),
    '',
    JSON.stringify(good2),
  ].join('\n') + '\n', 'utf8')
  const read = readDeptMessages(planId)
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.skipped, 2)
  assert.deepEqual(read.messages.map((m) => m.body), ['好行1', '好行2'])
})

test('非法消息 fail-closed 拒收：validate 拒绝且 append 显式 JOURNAL_WRITE_FAILED', () => {
  const cases: Array<[string, () => unknown]> = [
    ['非对象', () => null],
    ['未知 kind（闲聊不入库）', () => ({ ...makeMsg(), kind: 'chat' })],
    ['未知 role', () => ({ ...makeMsg(), from: { sessionId: 's', role: 'boss' } })],
    ['缺 body', () => { const m = makeMsg() as unknown as Record<string, unknown>; delete m.body; return m }],
    ['缺 delivery', () => { const m = makeMsg() as unknown as Record<string, unknown>; delete m.delivery; return m }],
    ['缺 from', () => { const m = makeMsg() as unknown as Record<string, unknown>; delete m.from; return m }],
    ['body>4000', () => makeMsg({ body: 'x'.repeat(4001) })],
    ['ts=0', () => makeMsg({ ts: 0 })],
    ['ts<0', () => makeMsg({ ts: -1 })],
    ['ts>8.64e15', () => makeMsg({ ts: 8.64e15 + 1 })],
    ['ts 非数字', () => makeMsg({ ts: '123' as unknown as number })],
    ['ts=NaN', () => makeMsg({ ts: Number.NaN })],
    ['v=2', () => makeMsg({ v: 2 as unknown as 1 })],
    ['expert 缺 member', () => makeMsg({ to: { sessionId: 's', role: 'expert' } })],
    ['sessionId>200', () => makeMsg({ from: { sessionId: 'x'.repeat(201), role: 'head' } })],
    ['member>80', () => makeMsg({ to: { sessionId: 's', role: 'member', member: 'x'.repeat(81) } })],
    ['data JSON>4000', () => makeMsg({ data: { blob: 'x'.repeat(4001) } })],
    ['data 是数组', () => makeMsg({ data: [] as unknown as Record<string, unknown> })],
    ['planId 空', () => makeMsg({ planId: '' })],
    ['subtaskId 空', () => makeMsg({ subtaskId: '' })],
    ['id 空', () => makeMsg({ id: '' })],
    ['id>80', () => makeMsg({ id: 'x'.repeat(81) })],
    ['delivery.status 非法', () => makeMsg({ delivery: { status: 'pending' as unknown as 'sent' } })],
    ['delivery.latencyMs 负数', () => makeMsg({ delivery: { status: 'sent', latencyMs: -1 } })],
  ]
  for (const [name, build] of cases) {
    const value = build()
    const verdict = validateDeptMessage(value)
    assert.equal(verdict.ok, false, `用例「${name}」应被拒绝`)
    if (verdict.ok) return
    assert.ok(verdict.error.length > 0)
    const wrote = appendDeptMessage(value)
    assert.equal(wrote.ok, false, `用例「${name}」append 应失败`)
    if (wrote.ok) return
    assert.equal(wrote.code, 'JOURNAL_WRITE_FAILED')
    assert.ok(wrote.error.length > 0)
  }
})

test('写失败显式报错：路径被目录占用 → JOURNAL_WRITE_FAILED（含 EISDIR 原文）', () => {
  const planId = freshPlanId('isdir')
  mkdirSync(join(baseDir, `${planId}.jsonl`), { recursive: true })
  const wrote = appendDeptMessage(makeMsg({ planId }))
  assert.equal(wrote.ok, false)
  if (wrote.ok) return
  assert.equal(wrote.code, 'JOURNAL_WRITE_FAILED')
  assert.match(wrote.error, /EISDIR|directory/i)
  const read = readDeptMessages(planId)
  assert.equal(read.ok, false)
  if (read.ok) return
  assert.equal(read.code, 'JOURNAL_READ_FAILED')
  assert.ok(read.error.length > 0)
  /* 用例自清理占位目录，避免给整体清理留特殊残留。 */
  rmSync(join(baseDir, `${planId}.jsonl`), { recursive: true, force: true })
})

test('N=250 条追加零丢失：全部读回、id 唯一、顺序不变', () => {
  const planId = freshPlanId('bulk250')
  const ids: string[] = []
  for (let i = 0; i < 250; i += 1) {
    const msg = makeMsg({ planId, body: `bulk-${i}`, ts: 1000 + i })
    ids.push(msg.id)
    const wrote = appendDeptMessage(msg)
    assert.equal(wrote.ok, true, `第${i}条写入失败`)
  }
  const read = readDeptMessages(planId, { limit: 5000 })
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.skipped, 0)
  assert.equal(read.messages.length, 250)
  assert.deepEqual(read.messages.map((m) => m.id), ids)
  assert.equal(new Set(read.messages.map((m) => m.id)).size, 250)
})

test('limit 默认 500、上限 5000：5001 条追加后按契约截取', () => {
  const planId = freshPlanId('limit')
  for (let i = 0; i < 5001; i += 1) {
    const wrote = appendDeptMessage(makeMsg({ planId, body: `m-${i}`, ts: 1000 + i }))
    assert.equal(wrote.ok, true, `第${i}条写入失败`)
  }
  const def = readDeptMessages(planId)
  assert.equal(def.ok, true)
  if (!def.ok) return
  assert.equal(def.messages.length, 500)
  assert.equal(def.messages[0].body, 'm-0')
  assert.equal(def.messages[499].body, 'm-499')
  const capped = readDeptMessages(planId, { limit: 99999 })
  assert.equal(capped.ok, true)
  if (!capped.ok) return
  assert.equal(capped.messages.length, 5000)
  assert.equal(capped.skipped, 0)
  const small = readDeptMessages(planId, { limit: 3 })
  assert.equal(small.ok, true)
  if (!small.ok) return
  assert.deepEqual(small.messages.map((m) => m.body), ['m-0', 'm-1', 'm-2'])
})

test('kind/since 过滤：按种类与时间戳筛选，仍按追加序', () => {
  const planId = freshPlanId('filter')
  const rows: Array<[DeptKind, number]> = [
    ['estimate', 1000],
    ['instruction', 2000],
    ['estimate', 3000],
    ['completion', 4000],
  ]
  for (const [kind, ts] of rows) {
    assert.equal(appendDeptMessage(makeMsg({ planId, kind, ts })).ok, true)
  }
  const byKind = readDeptMessages(planId, { kind: 'estimate' })
  assert.equal(byKind.ok, true)
  if (!byKind.ok) return
  assert.deepEqual(byKind.messages.map((m) => m.ts), [1000, 3000])
  const bySince = readDeptMessages(planId, { since: 2000 })
  assert.equal(bySince.ok, true)
  if (!bySince.ok) return
  assert.deepEqual(bySince.messages.map((m) => m.ts), [2000, 3000, 4000])
  const both = readDeptMessages(planId, { kind: 'estimate', since: 2000 })
  assert.equal(both.ok, true)
  if (!both.ok) return
  assert.deepEqual(both.messages.map((m) => m.ts), [3000])
})

test('文件不存在 → ok:true 空列表 skipped=0', () => {
  const read = readDeptMessages(freshPlanId('missing'))
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.deepEqual(read.messages, [])
  assert.equal(read.skipped, 0)
})

test('planId 路径穿越拒绝：非法抛 INVALID_PLAN_ID，读写显式失败；合法边界放行', () => {
  const illegal = ['../evil', 'a/b', '', 'x'.repeat(121), 'a b', '计划', '.hidden', 'a\\b', 'a.b', '..']
  for (const planId of illegal) {
    assert.throws(() => deptJournalPath(planId), /INVALID_PLAN_ID/, `planId=${JSON.stringify(planId)} 应抛错`)
    const read = readDeptMessages(planId)
    assert.equal(read.ok, false)
    if (read.ok) return
    assert.equal(read.code, 'JOURNAL_READ_FAILED')
    assert.match(read.error, /INVALID_PLAN_ID/)
  }
  const wrote = appendDeptMessage(makeMsg({ planId: '../evil' }))
  assert.equal(wrote.ok, false)
  if (wrote.ok) return
  assert.equal(wrote.code, 'JOURNAL_WRITE_FAILED')
  assert.match(wrote.error, /INVALID_PLAN_ID/)
  for (const planId of ['A'.repeat(120), 'a-b_C9']) {
    const path = deptJournalPath(planId)
    assert.equal(path, join(baseDir, `${planId}.jsonl`))
  }
})

test('body 控制字符清洗：不可见字符去除，\\t\\n\\r 保留，落盘即清洗后文本', () => {
  const planId = freshPlanId('clean')
  const msg = makeMsg({ planId, body: 'a\u0000b\u0007c\nd\te\rf\u001b' })
  const verdict = validateDeptMessage(msg)
  assert.equal(verdict.ok, true)
  if (!verdict.ok) return
  assert.equal(verdict.value.body, 'abc\nd\te\rf')
  assert.equal(appendDeptMessage(msg).ok, true)
  const read = readDeptMessages(planId)
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.messages[0].body, 'abc\nd\te\rf')
})

test('跨进程重启持久：子进程读同一目录，记录仍在且逐字段一致', () => {
  const planId = freshPlanId('restart')
  const msgs = [0, 1, 2].map((i) => makeMsg({ planId, body: `重启前-${i}`, ts: 1000 + i }))
  for (const msg of msgs) assert.equal(appendDeptMessage(msg).ok, true)
  const modulePath = fileURLToPath(new URL('../src/dept-journal.js', import.meta.url))
  const script = [
    `import { readDeptMessages } from ${JSON.stringify(modulePath)};`,
    `const r = readDeptMessages(${JSON.stringify(planId)});`,
    'process.stdout.write(JSON.stringify(r));',
  ].join('\n')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DSH_WORKPLAN_JOURNAL_DIR: baseDir },
    encoding: 'utf8',
  })
  const parsed = JSON.parse(out) as { ok: boolean; messages: DeptMessage[]; skipped: number }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.skipped, 0)
  assert.deepEqual(parsed.messages, msgs)
})
