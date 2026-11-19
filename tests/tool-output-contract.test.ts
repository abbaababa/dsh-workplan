/**
 * [3.0.1-激活热修] 工具输出契约回归钉（启用失败事故的永久防线）。
 *
 * 事故：dsh_workplan_hold / dsh_workplan_release 把 render 直接挂在工具根上、
 * 整体缺 output 包裹；DSH 宿主 ToolsService.register() 强制
 * output { schema, render, presentationMeta? }（dsh-tools/src/index.ts register()），
 * 注册即抛 TypeError，整个插件条目启用失败（web/headless 两 profile 同源皆挂）。
 * 插件自身测试全绿但宿主拒绝——因为没有任何用例按宿主契约校验工具定义。
 *
 * 这里用 mock ctx 走一遍 apply() 的注册路径，对全部已注册工具钉住：
 *   1. output 为对象、render 为函数、presentationMeta 缺省或为函数（逐字同宿主判定）；
 *   2. output.schema 为对象且根 type='object'、含 properties 与 required；
 *   3. render(args, value) 对成功/失败样例均返回 ContentBlock[]（{type,text} 块）；
 *   4. 注册工具集与 tests/fixtures/tool-surface.json 清单逐字一致。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../src/host.js'

interface CapturedTool {
  name: string
  output?: {
    schema?: unknown
    render?: unknown
    presentationMeta?: unknown
  }
  [key: string]: unknown
}

function collectRegisteredTools(): CapturedTool[] {
  const registered: CapturedTool[] = []
  const mockCtx = {
    effect: (fn: () => unknown) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: () => undefined,
    systemPrompt: { section: () => () => {} },
    tools: {
      register: (def: CapturedTool) => { registered.push(def); return () => {} },
      guard: () => () => {},
    },
    on: () => () => {},
    inject: () => () => {},
  }
  apply(mockCtx as any, {})
  return registered
}

const SAMPLES = [
  { ok: true, planId: 'P1', alreadyHeld: true, hold: { kind: 'manual', reason: 'r', at: 1, by: 'agent' } },
  { ok: true, planId: 'P1', hold: { kind: 'manual', reason: 'r', at: 1, by: 'agent' } },
  { ok: false, code: 'ALREADY_RUNNING', planId: 'P1', error: 'e' },
  { ok: false, code: 'NOT_HELD', planId: 'P1', error: 'e' },
  { ok: false, gateReleased: true, hold: { reason: 'r' }, dispatch: { ok: false, code: 'X', error: 'e' } },
  { ok: true, gateReleased: true, hold: { reason: 'r' }, dispatch: { ok: true } },
]

test('tool-output-contract: 全部已注册工具满足宿主 register() 契约', () => {
  const registered = collectRegisteredTools()
  assert.ok(registered.length > 0, 'apply() 必须注册至少一个工具')

  for (const def of registered) {
    // 1) 逐字复刻宿主 ToolsService.register() 的判定（dsh-tools/src/index.ts）
    const output = def.output
    assert.ok(output !== undefined && typeof output === 'object',
      `${def.name}: must declare output { schema, render, presentationMeta? }`)
    assert.equal(typeof output!.render, 'function',
      `${def.name}: output.render 必须是函数`)
    assert.ok(output!.presentationMeta === undefined || typeof output!.presentationMeta === 'function',
      `${def.name}: output.presentationMeta 缺省或为函数`)

    // 2) schema 形状（宿主 assertSupportedJsonSchema 的子集钉）
    const schema = output!.schema as any
    assert.ok(schema && typeof schema === 'object', `${def.name}: output.schema 必须是对象`)
    assert.equal(schema.type, 'object', `${def.name}: output.schema 根必须是 object`)
    assert.ok(schema.properties && typeof schema.properties === 'object',
      `${def.name}: output.schema 必须声明 properties`)
    assert.ok(Array.isArray(schema.required) && schema.required.includes('ok'),
      `${def.name}: output.schema.required 必须含 ok`)

    // 3) render 返回 ContentBlock[]
    for (const sample of SAMPLES) {
      const rendered = (output!.render as any)({}, sample)
      assert.ok(Array.isArray(rendered) && rendered.length > 0,
        `${def.name}: render 必须返回非空 ContentBlock[]，样例 ${JSON.stringify(sample)}`)
      for (const block of rendered) {
        assert.ok(block && typeof block === 'object' && typeof block.text === 'string',
          `${def.name}: ContentBlock 必须含文本块，样例 ${JSON.stringify(sample)}`)
      }
    }
  }
})

test('tool-output-contract: 注册工具集与 tool-surface 清单逐字一致', () => {
  const registered = collectRegisteredTools()
  // run-tests.mjs 以仓库根为 cwd（同 tool-surface-inventory.test.ts 的读法）；
  // 夹具 JSON 不被 tsc 拷进 dist-tests，不能按 import.meta.url 取路径。
  const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'tool-surface.json')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  assert.deepEqual(
    registered.map((d) => d.name).sort(),
    [...fixture.tools].sort(),
    '注册工具集与 tests/fixtures/tool-surface.json 不一致：接口变更必须同步清单',
  )
})

test('tool-output-contract: hold/release 的 render 语义（门禁文案三分支）', () => {
  const registered = collectRegisteredTools()
  const renderText = (name: string, value: unknown): string => {
    const tool = registered.find((d) => d.name === name)
    assert.ok(tool, `${name} 必须已注册`)
    const blocks = (tool!.output!.render as any)({}, value)
    return blocks.map((b: any) => b.text).join('')
  }

  assert.match(
    renderText('dsh_workplan_hold', { ok: false, code: 'ALREADY_RUNNING', error: '已开跑' }),
    /未能按住计划/,
  )
  assert.match(
    renderText('dsh_workplan_hold', { ok: true, alreadyHeld: true, planId: 'P1' }),
    /无需重复按住/,
  )
  assert.match(
    renderText('dsh_workplan_hold', { ok: true, planId: 'P1' }),
    /已设为认可闸门按住/,
  )

  // 「闸门已解除但 startPhases 门禁拒派发」不得误报成未解除（ok=false 但 gateReleased=true）
  assert.match(
    renderText('dsh_workplan_release', { ok: false, gateReleased: true, hold: { reason: 'r' }, dispatch: { ok: false, error: 'e', code: 'X' } }),
    /已解除，但派发未通过/,
  )
  assert.match(
    renderText('dsh_workplan_release', { ok: false, code: 'NOT_HELD', error: 'e' }),
    /未能解除闸门/,
  )
  assert.match(
    renderText('dsh_workplan_release', { ok: true, gateReleased: true, hold: { reason: 'r' } }),
    /已解除/,
  )
})
