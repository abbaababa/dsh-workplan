/*
 * 构建产物清单自检 —— 防止 `lib/` 少一个文件导致插件整个加载失败。
 *
 * 事故（2026-11-01 19:32）：1.10.4 新增 `src/auto-resume.ts`，`tsc` 生成了
 * `dist/auto-resume.js`，但 `package.json` 的 build 脚本用的是**写死的文件名列表**
 * 去 `cp ... lib/`。于是 `lib/runtime.js` 里那句 `import './auto-resume.js'` 在运行时
 * 找不到目标，宿主直接报：
 *
 *   dsh-workplan-plugin ... failed to import:
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *   '.../lib/auto-resume.js' imported from '.../lib/runtime.js'
 *
 * 整个插件没有激活（`dsh: warning: 1 entry did not activate`）。这类错误在 `tsc`
 * 与单测阶段都不会出现——它们只编译、不按包内相对路径去解析 `lib/`。
 *
 * 本测试把「dist 里每一个 .js 都必须在 lib 里有同名文件」变成硬断言，并顺带检查
 * `client.js` 与 `dist/client.js` 字节一致。构建脚本已改为 `cp dist/*.js lib/`，
 * 这条断言保证将来再抓一个模块时不会重演。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const distDir = path.join(root, 'dist')
const libDir = path.join(root, 'lib')

test('dist 里每个 .js 都能在 lib 找到同名文件（漏拷即插件加载失败）', () => {
  assert.ok(existsSync(distDir), 'dist 不存在：先跑 npm run build')
  assert.ok(existsSync(libDir), 'lib 不存在：先跑 npm run build')
  const distFiles = readdirSync(distDir).filter((name) => name.endsWith('.js'))
  assert.ok(distFiles.length > 0, 'dist 里没有 .js，构建异常')
  const missing = distFiles.filter((name) => !existsSync(path.join(libDir, name)))
  assert.deepEqual(missing, [],
    `lib/ 缺少构建产物：${missing.join(', ')}（build 脚本必须把 dist/*.js 全部拷到 lib/）`)
})

test('client.js 与 dist/client.js 字节一致', () => {
  const a = readFileSync(path.join(root, 'client.js'))
  const b = readFileSync(path.join(distDir, 'client.js'))
  assert.equal(a.length, b.length, 'client.js 与 dist/client.js 长度不同')
  assert.ok(a.equals(b), 'client.js 与 dist/client.js 内容不同：重新 npm run build')
})
