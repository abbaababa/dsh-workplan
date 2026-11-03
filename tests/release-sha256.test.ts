import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { promisify } from 'node:util'
import path from 'node:path'

const run = promisify(execFile)

/**
 * 发布物完整性凭据回归（T4 · CC G-12 AGD_PRE / G-15 ALC_DEL 的可执行形式）。
 *
 * scripts/compute-release-sha256.mjs 是 T3 诊断建议的"流程件"：
 * 发布时用它生成 sha256 清单，用户安装前校验（AGD_PRE），发布物公布凭据
 * （ALC_DEL）。本测试保证该工具本身可信：
 *   1. 计算结果与 Node crypto 独立重算一致；
 *   2. 输出确定性（同输入两次运行逐字节一致，无时间戳混入）；
 *   3. 缺输入文件非零退出，绝不输出部分成功清单。
 */

const script = path.resolve(process.cwd(), 'scripts/compute-release-sha256.mjs')
const fixture = path.resolve(process.cwd(), 'package.json')

test('sha256 manifest matches an independent crypto recomputation', async () => {
  const { stdout } = await run('node', [script, fixture])
  const manifest = JSON.parse(stdout)
  assert.equal(manifest.algorithm, 'sha256')
  assert.equal(manifest.files.length, 1)
  const expected = createHash('sha256').update(readFileSync(fixture)).digest('hex')
  assert.equal(manifest.files[0].sha256, expected)
  assert.equal(manifest.files[0].file, 'package.json')
  assert.equal(manifest.files[0].bytes, statSync(fixture).size)
})

test('manifest output is deterministic (no timestamps)', async () => {
  const a = await run('node', [script, fixture])
  const b = await run('node', [script, fixture])
  assert.equal(a.stdout, b.stdout, 'same input must produce byte-identical manifest')
})

test('missing input file exits non-zero with no partial manifest', async () => {
  await assert.rejects(
    run('node', [script, path.resolve(process.cwd(), 'no/such/artifact.tgz')]),
    (err: any) => {
      assert.equal(err.code, 1)
      assert.match(String(err.stderr), /cannot read/)
      assert.ok(!err.stdout, 'must not emit a manifest on failure')
      return true
    },
  )
})

test('multiple artifacts are listed in order', async () => {
  const lock = path.resolve(process.cwd(), 'package-lock.json')
  const { stdout } = await run('node', [script, fixture, lock])
  const manifest = JSON.parse(stdout)
  assert.deepEqual(
    manifest.files.map((f: any) => f.file),
    ['package.json', 'package-lock.json'],
  )
})
