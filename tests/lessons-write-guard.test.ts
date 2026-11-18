/**
 * [3.0.3] lessons 写路径加固回归钉。
 *
 * writeLessonsAtomic/recordLesson 的写路径：
 *  - mkdirSync mode 0o700、临时文件 writeFileSync mode 0o600、rename 后
 *    chmodSync 0o600（best-effort）；
 *  - 写前 lstatSync 目标文件/备份/临时文件，是符号链接则抛
 *    LESSONS_WRITE_REFUSED（防符号链接投毒，风格同 LESSONS_READ_FAILED）；
 *  - append 兜底路径同样拒绝符号链接，且 LESSONS_WRITE_REFUSED 不上兜底、
 *    直接向上抛。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordLesson } from '../src/lessons.js'

const RETRO = {
  problems: ['缺少复核'],
  detours: [] as string[],
  resolutions: ['补回归测试'],
  prevention: ['先写测试再改实现'],
}

function inputFor(file: string) {
  return {
    file,
    planId: 'wp-guard',
    subtaskId: 'T1',
    department: '工程',
    title: '写路径加固',
    retrospective: RETRO,
    now: 1700000000000,
  }
}

test('符号链接目标写入被拒（LESSONS_WRITE_REFUSED），受害者文件原样', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-guard-'))
  try {
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'SENTINEL', 'utf8')
    const link = join(dir, 'lessons.json')
    symlinkSync(victim, link)
    assert.throws(
      () => recordLesson(inputFor(link)),
      /LESSONS_WRITE_REFUSED/,
    )
    // 符号链接没被替换，指向的受害者文件也没被写入。
    assert.equal(readFileSync(victim, 'utf8'), 'SENTINEL')
    assert.ok(lstatSync(link).isSymbolicLink())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('预置的符号链接临时文件同样被拒，且不上 append 兜底', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-guard-'))
  try {
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'SENTINEL', 'utf8')
    const lessons = join(dir, 'lessons.json')
    // 攻击者预置 tmp 路径为符号链接：原子写 rename 前必须识破。
    symlinkSync(victim, `${lessons}.tmp-${process.pid}`)
    assert.throws(
      () => recordLesson(inputFor(lessons)),
      /LESSONS_WRITE_REFUSED/,
    )
    assert.equal(readFileSync(victim, 'utf8'), 'SENTINEL')
    assert.throws(() => statSync(lessons), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正常写入：目录 0o700、文件 0o600，记录可读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-guard-'))
  try {
    const lessons = join(dir, 'lessons.json')
    const result = recordLesson(inputFor(lessons))
    assert.equal(result?.mode, 'created')
    const stat = statSync(lessons)
    assert.equal(stat.mode & 0o777, 0o600, `文件权限应为 0o600，实际 ${(stat.mode & 0o777).toString(8)}`)
    assert.equal(statSync(dir).mode & 0o777, 0o700, `目录权限应为 0o700，实际 ${(statSync(dir).mode & 0o777).toString(8)}`)
    const { readLessons } = await import('../src/lessons.js')
    const rows = readLessons(lessons)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].subtaskId, 'T1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已存在的宽松权限文件重写后收紧到 0o600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-guard-'))
  try {
    const lessons = join(dir, 'lessons.json')
    writeFileSync(lessons, 'PRE-EXISTING\n', { encoding: 'utf8', mode: 0o644 })
    const result = recordLesson(inputFor(lessons))
    assert.equal(result?.mode, 'created')
    assert.equal(statSync(lessons).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
