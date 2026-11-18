/*
 * [3.0.6][第 2 批] journal 保留策略：默认永久保留，只有显式开启才删旧文件。
 *
 * 审计证据的默认语义是“不删”；这里逐条钉住 pruneJournal 的边界：
 * 只看目录内直接的合法 <planId>.jsonl、只看普通文件、不碰符号链接、
 * 按 mtime 从旧到新、单次数量有上限。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pruneJournal } from '../src/dept-journal.js'

const DAY = 24 * 60 * 60 * 1000

function withJournalDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-journal-'))
  const previous = process.env.DSH_WORKPLAN_JOURNAL_DIR
  process.env.DSH_WORKPLAN_JOURNAL_DIR = dir
  try {
    return run(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
    else process.env.DSH_WORKPLAN_JOURNAL_DIR = previous
  }
}

function makeFile(dir: string, name: string, ageDays: number) {
  const path = join(dir, name)
  writeFileSync(path, '{"kind":"dispatch"}\n')
  const at = new Date(Date.now() - ageDays * DAY)
  utimesSync(path, at, at)
  return path
}

test('[3.0.6] retentionDays=0 表示永久保留：一个文件都不删', () => {
  withJournalDir((dir) => {
    makeFile(dir, 'wp-old.jsonl', 400)
    const result = pruneJournal({ retentionDays: 0 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, [])
    assert.deepEqual(readdirSync(dir), ['wp-old.jsonl'])
  })
})

test('[3.0.6] 只删超过保留期的合法 .jsonl 普通文件', () => {
  withJournalDir((dir) => {
    makeFile(dir, 'wp-old.jsonl', 40)
    makeFile(dir, 'wp-new.jsonl', 1)
    makeFile(dir, 'notes.txt', 400)
    makeFile(dir, 'bad name.jsonl', 400)
    const result = pruneJournal({ retentionDays: 30 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, ['wp-old.jsonl'])
    const left = readdirSync(dir).sort()
    assert.deepEqual(left, ['bad name.jsonl', 'notes.txt', 'wp-new.jsonl'])
  })
})

test('[3.0.6] 单次最多删除 maxFiles 个最旧文件', () => {
  withJournalDir((dir) => {
    makeFile(dir, 'wp-a.jsonl', 100)
    makeFile(dir, 'wp-b.jsonl', 90)
    makeFile(dir, 'wp-c.jsonl', 80)
    const result = pruneJournal({ retentionDays: 30, maxFiles: 2 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, ['wp-a.jsonl', 'wp-b.jsonl'])
    assert.deepEqual(readdirSync(dir), ['wp-c.jsonl'])
  })
})

test('[3.0.6] 符号链接一律跳过，不越界删除', () => {
  withJournalDir((dir) => {
    const target = makeFile(dir, 'wp-old.jsonl', 400)
    symlinkSync(target, join(dir, 'wp-link.jsonl'))
    const result = pruneJournal({ retentionDays: 30 })
    assert.equal(result.ok, true)
    // 目标文件本身合法且超期，会被删；链接本身保留（悬空），绝不跟着链接删别处。
    assert.deepEqual(result.deleted, ['wp-old.jsonl'])
    assert.deepEqual(readdirSync(dir).sort(), ['wp-link.jsonl'])
  })
})

test('[3.0.6] 目录不存在：视为无事可做，不报错', () => {
  const dir = join(tmpdir(), `dsh-workplan-missing-${Date.now()}`)
  const previous = process.env.DSH_WORKPLAN_JOURNAL_DIR
  process.env.DSH_WORKPLAN_JOURNAL_DIR = dir
  try {
    const result = pruneJournal({ retentionDays: 30 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, [])
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
    else process.env.DSH_WORKPLAN_JOURNAL_DIR = previous
  }
})
