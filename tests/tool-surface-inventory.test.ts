import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

/**
 * 工具面清单回归（T4 · CC G-08 ADV_FSP / G-24 AVA 攻击面的可执行形式）。
 *
 * CC 对功能规范（ADV_FSP）与脆弱性分析（AVA）的要求是：对外接口必须成文、
 * 完整且与实现一致。本插件此前的问题不是接口缺失，而是接口清单只存在于
 * 文档（会滞后，如 1.8.x 冻结）或散落在代码里。这里把事实反过来固定：
 *
 *   src/host.ts（实现） ←逐条抽取→ 本测试 ←逐条比对→ tests/fixtures/tool-surface.json（基线）
 *
 * 任何新增/删除模型工具、HTTP 路由或生命周期事件都会让本测试失败，
 * 强制同一次变更里刷新 fixture 与 docs/cc 的 ADV_FSP / AVA 攻击面章节。
 * 基线是人工确认过的真实清单（1.12.0），不是"从代码生成再回填"的自证。
 */

async function read(rel: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), rel), 'utf8')
}

test('registered model tools match the tool-surface baseline', async () => {
  const host = await read('src/host.ts')
  const baseline = JSON.parse(await read('tests/fixtures/tool-surface.json'))

  // 与 host.ts 中注册工具的字面写法一致：name: 'dsh_workplan_xxx',
  const found = [...host.matchAll(/name:\s*'(dsh_workplan_[a-z_]+)'/g)].map((m) => m[1])
  assert.ok(found.length > 0, 'host.ts must register at least one model tool')
  assert.deepEqual(
    [...new Set(found)].sort(),
    [...baseline.tools].sort(),
    'registered tools drifted from tests/fixtures/tool-surface.json — refresh the fixture AND docs/cc ADV_FSP/AVA in the same change',
  )
})

test('registered HTTP routes match the tool-surface baseline', async () => {
  const host = await read('src/host.ts')
  const baseline = JSON.parse(await read('tests/fixtures/tool-surface.json'))

  const found = [...host.matchAll(/path:\s*'(\/dsh-workplan\/[^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(found)].sort(),
    [...baseline.routes].sort(),
    'registered routes drifted from tests/fixtures/tool-surface.json — refresh the fixture AND docs/cc ADV_FSP/AVA in the same change',
  )
})

test('lifecycle events match the tool-surface baseline', async () => {
  const host = await read('src/host.ts')
  const baseline = JSON.parse(await read('tests/fixtures/tool-surface.json'))

  const found = [...host.matchAll(/ctx\.on\('([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(found)].sort(),
    [...baseline.events].sort(),
    'lifecycle event subscriptions drifted from tests/fixtures/tool-surface.json — refresh the fixture AND docs/cc ADV_FSP/AVA in the same change',
  )
})

test('baseline declares the version it was confirmed against', async () => {
  const baseline = JSON.parse(await read('tests/fixtures/tool-surface.json'))
  const host = await read('src/host.ts')
  const meta = host.match(/export const meta = \{[\s\S]*?version:\s*'([^']+)'/)
  assert.ok(meta, 'src/host.ts must declare meta.version')
  assert.equal(
    baseline.version,
    meta![1],
    'tool-surface baseline must be re-confirmed whenever the plugin version changes',
  )
})
