/*
 * [1.8.0] Response hardening.
 *
 * Both routes this plugin exposes sit on the DSH web server: `/dsh-workplan/plans`
 * returns JSON that contains session ids, and `/dsh-workplan/vendor/chart.umd.js`
 * returns JavaScript. A browser that sniffs the first as something else, or that
 * forwards the panel URL in `Referer`, turns a read-only dashboard into a leak.
 * The headers are applied through one helper so a future `res.writeHead(...)`
 * cannot silently drop them; this test pins the helper's contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { HARDENING_HEADERS, applyHardeningHeaders } from '../src/runtime.js'

function recordingRes() {
  const headers: Record<string, string> = {}
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[String(name).toLowerCase()] = String(value)
    },
  }
}

test('响应加固头固定为 nosniff 与 no-referrer', () => {
  assert.equal(HARDENING_HEADERS['x-content-type-options'], 'nosniff')
  assert.equal(HARDENING_HEADERS['referrer-policy'], 'no-referrer')
  assert.equal(Object.isFrozen(HARDENING_HEADERS), true, '常量必须不可变，避免运行时被改写')
})

test('applyHardeningHeaders 把两个头写进响应对象', () => {
  const res = recordingRes()
  applyHardeningHeaders(res)
  assert.deepEqual(res.headers, {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
})

test('applyHardeningHeaders 对没有 setHeader 的对象保持静默', () => {
  assert.doesNotThrow(() => applyHardeningHeaders({}))
  assert.doesNotThrow(() => applyHardeningHeaders(null))
  assert.doesNotThrow(() => applyHardeningHeaders(undefined))
})

test('两条路由的处理函数都调用加固助手', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const root = process.cwd()
  const [runtimeSource, hostSource] = await Promise.all([
    readFile(path.resolve(root, 'src/runtime.ts'), 'utf8'),
    readFile(path.resolve(root, 'src/host.ts'), 'utf8'),
  ])
  assert.match(runtimeSource, /async function route\([\s\S]{0,120}applyHardeningHeaders\(res\)/)
  assert.match(hostSource, /handler: \(req: any, res: any\) => \{\s*applyHardeningHeaders\(res\)/)
})

/*
 * [1.8.1] The vendored-asset route answers GET/HEAD only.
 *
 * SECURITY.md used to claim this route ran the same auth check as `/plans`,
 * which it never did — one `curl -X POST` proved the documentation wrong. The
 * honest fix is twofold: the docs now state the asymmetry, and the route
 * enforces the method restriction the docs claim. This test pins the second
 * half so neither can drift again.
 */
test('图表库路由只服务 GET/HEAD，其余方法返回 405', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const hostSource = await readFile(path.resolve(process.cwd(), 'src/host.ts'), 'utf8')
  const chartHandler = hostSource.slice(hostSource.indexOf('/dsh-workplan/vendor/chart.umd.js'))
  assert.match(chartHandler, /if \(req\?\.method !== 'GET' && req\?\.method !== 'HEAD'\) \{\s*res\.statusCode = 405/)
  assert.match(chartHandler, /res\.setHeader\('allow', 'GET, HEAD'\)/)
  assert.match(chartHandler, /res\.end\(req\?\.method === 'HEAD' \? undefined : body\)/)
})
