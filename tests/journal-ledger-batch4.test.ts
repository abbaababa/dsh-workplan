/*
 * [第 4 批] journal 回读窗口化 + pruneJournal 治理增强 + notice-ledger 治理/安全加固回归。
 *
 * 覆盖：
 *  1. 窗口回读：200KB+/200+ 行大文件下，新追加行（必在文件末尾，O_APPEND）仍被
 *     末尾 64KB 窗口命中（旧实现 O(n²) 全文件重读；窗口内坏行跳过）；
 *  2. 窗口首行截断：窗口起点落在行中间（首行 parse 失败）时跳过坏行继续命中；
 *  3. pruneJournal excludePlanIds：活跃但安静的计划跳过删除；
 *  4. pruneJournal unlink 失败：errors[] 收集原因、逐条 console.warn、ok 保持 true；
 *  5. notice 台账行数上限：env DSH_WORKPLAN_NOTICES_MAX_LINES=5（用例自管 env 并还原）
 *     触发超限重写，保留最新 5 行；
 *  6. notice 台账符号链接投毒：写入被跳过（不抛错、链接目标不变）；
 *  7. journal 符号链接投毒：appendDeptMessage 显式 JOURNAL_WRITE_FAILED、目标不变；
 *  8. 权限加固：journal/notice 文件 0o600、新建目录 0o700。
 *
 * 纪律：journal 一律 env DSH_WORKPLAN_JOURNAL_DIR 指向临时目录（还原）；ledger 用
 * 显式 file 参数隔离；console.warn 捕获用例内部自行还原。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendDeptMessage,
  deptJournalPath,
  makeDeptMessageId,
  pruneJournal,
  readDeptMessages,
} from '../src/dept-journal.js'
import type { DeptMessage } from '../src/dept-journal.js'
import {
  NOTICE_LEDGER_MAX_LINES,
  appendNoticeLedger,
  noticeLedgerOverflowSize,
  readNoticeLedger,
} from '../src/notice-ledger.js'

const DAY = 24 * 60 * 60 * 1000
/** 与 src/dept-journal.ts 的 JOURNAL_READBACK_WINDOW_BYTES 一致：测试前置条件用。 */
const READBACK_WINDOW_BYTES = 64 * 1024

let seq = 0
function freshPlanId(tag: string): string {
  seq += 1
  return `batch4-${tag}-${seq}`
}

function makeMsg(over: Partial<DeptMessage> = {}): DeptMessage {
  const now = Date.now()
  const base: DeptMessage = {
    v: 1,
    id: makeDeptMessageId(now),
    ts: now,
    planId: 'batch4-default',
    subtaskId: 'T5',
    kind: 'instruction',
    from: { sessionId: 'sess-head-001', role: 'head' },
    to: { sessionId: 'sess-leaf-001', role: 'member', member: 'batch4-member' },
    body: '批次4测试正文',
    delivery: { status: 'sent', messageId: 'm-1' },
  }
  return { ...base, ...over }
}

/** journal 测试：env 指向临时目录，测后还原并清理。 */
function withJournalDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-batch4-'))
  const previous = process.env.DSH_WORKPLAN_JOURNAL_DIR
  process.env.DSH_WORKPLAN_JOURNAL_DIR = dir
  try {
    run(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
    else process.env.DSH_WORKPLAN_JOURNAL_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeOldJournalFile(dir: string, name: string, ageDays: number): string {
  const path = join(dir, name)
  writeFileSync(path, '{"kind":"dispatch"}\n')
  const at = new Date(Date.now() - ageDays * DAY)
  utimesSync(path, at, at)
  return path
}

/** 捕获 console.warn（用例内自行还原）。 */
function captureWarns(run: () => void): string[] {
  const warns: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warns
}

test('冻结常量：NOTICE_LEDGER_MAX_LINES = 5000（可被 env 正整数覆盖）', () => {
  assert.equal(NOTICE_LEDGER_MAX_LINES, 5000)
})

test('窗口回读：200KB+/200+ 行大文件下命中新追加行（尾部窗口，非全文件重读）', () => {
  withJournalDir(() => {
    const planId = freshPlanId('big')
    const path = deptJournalPath(planId)
    // 预置 210 行、每行 ~1.4KB → 文件 > 280KB（远超 64KB 回读窗口）。
    const seed: string[] = []
    for (let i = 0; i < 210; i += 1) {
      if (i === 205) {
        seed.push('{"broken-json-line-trap"') // 窗口内坏行：必须被跳过、不影响命中
        continue
      }
      seed.push(JSON.stringify(makeMsg({ planId, body: `第${i}条-` + 'x'.repeat(1100), ts: 1_763_000_000_000 + i })))
    }
    writeFileSync(path, `${seed.join('\n')}\n`, 'utf8')
    const size = statSync(path).size
    assert.ok(size > 200 * 1024, `前置：文件应 >200KB，实际 ${size} 字节`)
    assert.ok(size > READBACK_WINDOW_BYTES, '前置：文件必须大于回读窗口（否则此用例测不到窗口路径）')

    const wrote = appendDeptMessage(makeMsg({ planId, body: '窗口回读-新追加行' }))
    assert.equal(wrote.ok, true, `大文件下追加必须成功：${'error' in wrote ? wrote.error : ''}`)
    const read = readDeptMessages(planId, { limit: 1, newest: true })
    assert.equal(read.ok, true)
    assert.equal(read.messages[0]?.body, '窗口回读-新追加行', '新行必须真实落盘且可读回')
  })
})

test('窗口首行截断：窗口起点落在行中间时跳过坏首行继续命中', () => {
  withJournalDir(() => {
    const planId = freshPlanId('trunc')
    const path = deptJournalPath(planId)
    // 首行 70KB 垃圾行：回读窗口起点（size-64KB）必落在该行中间 → 窗口首行截断坏行。
    const seed = ['A'.repeat(70_000)]
    for (let i = 0; i < 10; i += 1) {
      seed.push(JSON.stringify(makeMsg({ planId, body: `小行${i}` })))
    }
    writeFileSync(path, `${seed.join('\n')}\n`, 'utf8')
    const size = statSync(path).size
    assert.ok(size > READBACK_WINDOW_BYTES, `前置：文件应 >64KB，实际 ${size} 字节`)
    assert.ok(
      size - READBACK_WINDOW_BYTES < 70_000,
      '前置：窗口起点必须落在 70KB 垃圾行内部（首行截断场景成立）',
    )

    const wrote = appendDeptMessage(makeMsg({ planId, body: '截断场景-新行' }))
    assert.equal(wrote.ok, true, `首行截断不得误报失败：${'error' in wrote ? wrote.error : ''}`)
  })
})

test('pruneJournal：excludePlanIds 保护活跃但安静的计划不被 mtime 误删', () => {
  withJournalDir((dir) => {
    makeOldJournalFile(dir, 'wp-quiet.jsonl', 400)
    makeOldJournalFile(dir, 'wp-stale.jsonl', 400)
    const result = pruneJournal({ retentionDays: 30, excludePlanIds: new Set(['wp-quiet']) })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, ['wp-stale.jsonl'])
    assert.equal(result.errors, undefined, '无失败时 errors 应保持 undefined（兼容）')
    assert.deepEqual(readdirSync(dir).sort(), ['wp-quiet.jsonl'])
  })
})

test('pruneJournal：unlink 失败收集 errors（ok 保持 true）且逐条 console.warn', () => {
  withJournalDir((dir) => {
    makeOldJournalFile(dir, 'wp-a.jsonl', 400)
    makeOldJournalFile(dir, 'wp-b.jsonl', 400)
    // 去掉目录写权限：readdir/lstat 可读，unlink 必失败（EACCES/EPERM）。
    chmodSync(dir, 0o555)
    try {
      let result!: ReturnType<typeof pruneJournal>
      const warns = captureWarns(() => {
        result = pruneJournal({ retentionDays: 30 })
      })
      assert.equal(result.ok, true, 'unlink 失败不得把 ok 翻成 false（兼容既有调用方）')
      assert.deepEqual(result.deleted, [])
      assert.equal(result.errors?.length, 2, '两次 unlink 失败都应收集原因')
      assert.equal(warns.length, 2, '每个失败应各 console.warn 一行')
      assert.ok(warns.every((line) => line.includes('删除失败')))
      assert.deepEqual(readdirSync(dir).sort(), ['wp-a.jsonl', 'wp-b.jsonl'], '删除失败的文件必须原样保留')
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})

test('notice 台账：env DSH_WORKPLAN_NOTICES_MAX_LINES=5 触发超限重写，保留最新 5 行', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-batch4-notices-'))
  const file = join(dir, 'notices.jsonl')
  const previous = process.env.DSH_WORKPLAN_NOTICES_MAX_LINES
  process.env.DSH_WORKPLAN_NOTICES_MAX_LINES = '5'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_NOTICES_MAX_LINES
    else process.env.DSH_WORKPLAN_NOTICES_MAX_LINES = previous
    rmSync(dir, { recursive: true, force: true })
  })

  for (let i = 0; i < 7; i += 1) {
    const ok = appendNoticeLedger('s-cap', { content: `行${i}`, source: { kind: 'workplan' } }, file, 1_763_000_000_000 + i)
    assert.equal(ok, true, `第 ${i} 行写入必须成功`)
  }
  assert.equal(noticeLedgerOverflowSize(), 0, '全部成功时补落缓冲必须为空')

  const rawLines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  assert.equal(rawLines.length, 5, '超限后文件必须重写为恰好最新 5 行')

  const rows = readNoticeLedger(file)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map((row) => row.text), ['行2', '行3', '行4', '行5', '行6'], '必须保留最新的 5 行（行0/行1 被淘汰）')
  assert.deepEqual(rows.map((row) => row.at), [1_763_000_000_002, 1_763_000_000_003, 1_763_000_000_004, 1_763_000_000_005, 1_763_000_000_006])
})

test('notice 台账：符号链接目标写入被跳过（不抛错、链接目标不变）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-batch4-link-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const victim = join(dir, 'victim.jsonl')
  writeFileSync(victim, 'PRECIOUS\n', 'utf8')
  const link = join(dir, 'notices.jsonl')
  symlinkSync(victim, link)

  let ok!: boolean
  const warns = captureWarns(() => {
    ok = appendNoticeLedger('s-link', { content: 'SHOULD-NOT-LAND', source: { kind: 'workplan' } }, link)
  })
  assert.equal(ok, false, '符号链接写入必须按失败处理（行进内存缓冲）')
  assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS\n', '链接目标内容绝不允许被写入')
  assert.ok(lstatSync(link).isSymbolicLink(), '链接本身必须原样保留')
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('符号链接'))
  assert.ok(noticeLedgerOverflowSize() > 0, '被跳过的行必须留在内存缓冲等待补落')
})

test('journal：符号链接文件写入被跳过（显式 JOURNAL_WRITE_FAILED、目标不变）', () => {
  withJournalDir((dir) => {
    const planId = freshPlanId('link')
    const victim = join(dir, 'victim.jsonl')
    writeFileSync(victim, 'PRECIOUS\n', 'utf8')
    symlinkSync(victim, deptJournalPath(planId))

    let result!: ReturnType<typeof appendDeptMessage>
    const warns = captureWarns(() => {
      result = appendDeptMessage(makeMsg({ planId }))
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'JOURNAL_WRITE_FAILED')
    assert.ok(result.error.includes('符号链接'))
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS\n', '链接目标内容绝不允许被写入')
    assert.ok(lstatSync(deptJournalPath(planId)).isSymbolicLink())
    assert.equal(warns.length, 1)
    assert.ok(warns[0].includes('符号链接'))
  })
})

test('权限加固：journal/notice 文件 0o600、新建目录 0o700', () => {
  withJournalDir((dir) => {
    const planId = freshPlanId('perm')
    const wrote = appendDeptMessage(makeMsg({ planId }))
    assert.equal(wrote.ok, true)
    assert.equal(statSync(deptJournalPath(planId)).mode & 0o777, 0o600, 'journal 文件必须 0o600')
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'journal 目录必须 0o700')

    const noticeDir = mkdtempSync(join(tmpdir(), 'dsh-workplan-batch4-perm-'))
    try {
      const file = join(noticeDir, 'sub', 'notices.jsonl')
      const ok = appendNoticeLedger('s-perm', { content: '权限测试', source: { kind: 'workplan' } }, file)
      assert.equal(ok, true)
      assert.equal(statSync(file).mode & 0o777, 0o600, 'notice 台账文件必须 0o600')
      assert.equal(statSync(join(noticeDir, 'sub')).mode & 0o777, 0o700, '新建父目录必须 0o700')
    } finally {
      rmSync(noticeDir, { recursive: true, force: true })
    }
  })
})
