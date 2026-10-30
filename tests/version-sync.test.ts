import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

/**
 * 版本一致性（T4 §1.1 的可执行形式）。
 *
 * 仓库有 git 标签（如 `v1.4.3`），但版本号仍是多处人工维护点，`package-lock.json`
 * 也曾长期停在 1.3.7。这里不写死版本号，只断言以下声明互相一致，升级时不需要改测试：
 *   package.json / package-lock.json（两处）/ src/host.ts 的 meta.version /
 *   CHANGELOG 里存在该版本的标题 / README 的安装命令。
 * 后两项是 1.7.0 补的：只改运行时代码不改文档，用户在 README 里会照着旧版本号装。
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

test('CHANGELOG and README mention the version being shipped', async () => {
  const pkg = await readJson('package.json')
  const changelog = await readFile(path.resolve(process.cwd(), 'CHANGELOG.md'), 'utf8')
  assert.match(
    changelog,
    new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')} — `, 'm'),
    'CHANGELOG must have a "## <version> — <date>" heading for the shipped version',
  )

  for (const file of ['README.md', 'README.en.md']) {
    const readme = await readFile(path.resolve(process.cwd(), file), 'utf8')
    assert.ok(
      readme.includes(`dsh-workplan@${pkg.version}`),
      `${file} must install dsh-workplan@${pkg.version}`,
    )
  }
})
