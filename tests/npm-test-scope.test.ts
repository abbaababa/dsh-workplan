/*
 * npm test 作用域自检 —— 把 R-W5-01 跨版本 A/B 探针挡在默认测试集合之外。
 *
 * 背景（R-W5-01，2026-11-01 裁决「不进 npm test，移入发版清单」）：
 *   `scripts/w5-cross-version-check.mjs` 需要**已发布的旧版 lib**（tag v1.8.19）、
 *   外部事故日志夹具（root.jsonl）与一次显式 `npm run build` 才能出结论。它属于
 *   发布前强制步骤（见 RELEASING.md §1.4），不属于任何一次 `npm test`。
 *
 * 现状本身是安全的（`test` 只编译 src+tests，只跑 dist-tests/tests/*.test.js），
 * 但这是**隐式**排除：任何人往 `tests/` 放一个会 spawn 探针的用例，或者在
 * `tsconfig.test.json` 的 include 里加 scripts 下的 TS 文件，探针就会悄悄进入默认
 * 集合，并在缺 tag/缺夹具的机器上把 `npm test` 变红。本测试把这条边界钉成
 * 可执行断言，防止回归。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const PROBE = 'scripts/w5-cross-version-check.mjs'

function readJson(file: string): any {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8'))
}

test('npm test 只从 tests/ 收集用例，scripts/ 的探针不参与编译与执行', () => {
  const pkg = readJson('package.json')
  const testScript: string = pkg.scripts.test

  // 1. [2.2.9] 默认测试入口收口到 scripts/run-tests.mjs（全局事件循环锚 --import 注入
  //    + cancelled===0 硬断言，见 tests/setup-event-loop-anchor.ts / P-2、P-4），
  //    不接受额外目录/文件参数。
  assert.match(
    testScript,
    /node scripts\/run-tests\.mjs$/,
    `npm test 入口必须以 node scripts/run-tests.mjs 结尾，实际：${testScript}`,
  )
  // 1b. 运行器只从 dist-tests/tests 收集 *.test.js，且与 R-W5-01 探针零关联——
  //    原「只跑 dist-tests/tests/*.test.js」的边界由运行器代码显式承接。
  const runner = readFileSync(path.join(root, 'scripts', 'run-tests.mjs'), 'utf8')
  assert.match(
    runner,
    /join\(root,\s*'dist-tests',\s*'tests'\)/,
    'run-tests.mjs 必须只从 dist-tests/tests 收集用例',
  )
  assert.match(
    runner,
    /endsWith\('\.test\.js'\)/,
    `run-tests.mjs 必须只收集 *.test.js（setup-event-loop-anchor.js 等非用例文件不得进测试集合）`,
  )
  assert.ok(
    !runner.includes('w5-cross-version-check'),
    'run-tests.mjs 不得引用 R-W5-01 跨版本探针（它属于发版清单，不属于 npm test）',
  )
  // 2. 测试编译配置只收 src 与 tests，且显式排除 scripts/。
  const tsconfigTest = readJson('tsconfig.test.json')
  assert.deepEqual(
    [...tsconfigTest.include].sort(),
    ['src/**/*.ts', 'tests/**/*.ts'],
    `tsconfig.test.json 的 include 必须恰好是 src/**/*.ts 与 tests/**/*.ts，实际：${JSON.stringify(tsconfigTest.include)}`,
  )
  assert.ok(
    tsconfigTest.exclude.includes('scripts'),
    `tsconfig.test.json 必须显式排除 scripts/，实际：${JSON.stringify(tsconfigTest.exclude)}`,
  )
  // 3. 探针脚本本身必须留在仓库里（随时可单独执行），只是不进 npm test。
  assert.ok(existsSync(path.join(root, PROBE)), `探针脚本缺失：${PROBE}`)
  assert.ok(!existsSync(path.join(root, 'dist-tests', 'scripts')), 'scripts/ 不应被编译进 dist-tests')
})

test('没有任何测试用例 import 或 spawn 跨版本探针', () => {
  const testsDir = path.join(root, 'tests')
  const self = 'npm-test-scope.test.ts'
  const pattern = /(?:import|require|execFile|exec|spawn|fork)\s*\(?[^\n]*w5-cross-version-check/
  const offenders: string[] = []
  for (const name of readdirSync(testsDir)) {
    if (!name.endsWith('.test.ts') || name === self) continue
    const text = readFileSync(path.join(testsDir, name), 'utf8')
    if (pattern.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些用例把 R-W5-01 探针拉进了 npm test：${offenders.join(', ')}`)
})
