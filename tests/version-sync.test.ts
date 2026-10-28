import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

/**
 * 版本一致性（T4 §1.1 的可执行形式）。
 *
 * 仓库有 git 标签（如 `v1.4.3`），但 npm 包版本 `package.json` 与宿主读取的
 * `meta.version`（`src/host.ts`）仍是两处人工维护点，`package-lock.json` 也曾
 * 长期停在 1.3.7。这里不写死版本号，只断言四处声明互相一致，升级时不需要改测试。
 * 生成物（`lib/host.js`、`dist/host.js`）由 `npm run build` 覆盖，不在此断言。
 */

async function readJson(relativePath: string): Promise<any> {
  const text = await readFile(path.resolve(process.cwd(), relativePath), 'utf8')
  return JSON.parse(text)
}

test('package.json, package-lock.json and meta.version stay in sync', async () => {
  const pkg = await readJson('package.json')
  const lock = await readJson('package-lock.json')
  const host = await readFile(path.resolve(process.cwd(), 'src/host.ts'), 'utf8')

  const meta = host.match(/export const meta = \{[\s\S]*?version:\s*'([^']+)'/)
  assert.ok(meta, 'src/host.ts must declare meta.version')
  const hostVersion = meta![1]

  assert.equal(pkg.version, lock.version, 'package-lock root version must equal package.json')
  assert.equal(pkg.version, lock.packages?.['']?.version, 'package-lock packages[""] version must equal package.json')
  assert.equal(hostVersion, pkg.version, 'meta.version must equal package.json version')
})
