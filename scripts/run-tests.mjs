#!/usr/bin/env node
/**
 * [2.2.9][P-4] 测试运行器（package.json `test` 脚本的收口）：
 *  ① 以 `--import dist-tests/tests/setup-event-loop-anchor.js` 给每个测试子进程注入全局
 *     事件循环锚（探针实证：--import 只进子进程、after() 钩子正常清理、runner 不被悬挂）；
 *  ② 强制 TAP 输出并**硬断言 cancelled === 0**：任何 cancelledByParent 都被显式点名并 exit 1，
 *     不再只靠 node --test 的退出码间接体现——把「fail 红」与「cancelled 红」两类问题在日志层
 *     就区分开（2.2.6 事故里 `pass 663/fail 0/cancelled 3` 被当成"差不多绿了"的教训）。
 *  ③ 汇总行显式打印 pass/fail/cancelled/exit，供本地与 CI 日志直接取证。
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.cwd())
const testsDir = join(root, 'dist-tests', 'tests')
const anchor = join(testsDir, 'setup-event-loop-anchor.js')
const files = readdirSync(testsDir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join(testsDir, f))
if (files.length === 0) {
  console.error('[run-tests] dist-tests/tests 下没有 *.test.js：先跑 tsc -p tsconfig.test.json')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(anchor).href, '--test', '--test-reporter=tap', ...files],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
)

let out = ''
child.stdout.on('data', (chunk) => {
  out += chunk
  process.stdout.write(chunk)
})
child.on('error', (error) => {
  console.error(`[run-tests] 无法启动测试进程：${error.message}`)
  process.exit(1)
})
child.on('close', (code) => {
  const grab = (label) => {
    const m = out.match(new RegExp(`^(?:#|ℹ)\\s+${label}\\s+(\\d+)`, 'm'))
    return m ? Number(m[1]) : null
  }
  const cancelled = grab('cancelled') ?? 0
  const pass = grab('pass')
  const fail = grab('fail')
  console.error(`[run-tests] pass=${pass ?? '?'} fail=${fail ?? '?'} cancelled=${cancelled} exit=${code}`)
  if (cancelled > 0) {
    console.error(
      '[run-tests] ❌ cancelled > 0：事件循环排空导致 node:test 取消等待中的用例'
      + '（CI 红叉根因族，T1 报告 §1）。排查顺序：① tests/handle-policy.test.ts 是否红（收束类计时器'
      + ' 被 unref）；② setup-event-loop-anchor 是否仍被 --import 注入（event-loop-anchor-global.test.ts）。',
    )
    process.exit(1)
  }
  process.exit(code ?? 1)
})
