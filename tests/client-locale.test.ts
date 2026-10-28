import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_KEYS = [
  'stats.done',
  'stats.blocked',
  'stats.inProgress',
  'stats.pending',
  'stats.progress',
  'phase.pending',
  'phase.planning',
  'phase.executing',
  'phase.integrating',
  'phase.done',
  'phase.blocked',
  'phase.degraded',
  'phase.cancelled',
  'scopeAll',
  'scopeThis',
  'allPlansHint',
  'level.low',
  'level.medium',
  'level.high',
  'dept.engineering',
  'dept.qa',
  'workItems',
  'taskBreakdown',
]

class StubComponent {
  props: any
  constructor(props: any) {
    this.props = props
  }
  render() {
    return this.props?.children ?? null
  }
}

const ReactStub: any = {
  Component: StubComponent,
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }),
  useState: (value: any) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useMemo: (fn: any) => fn(),
}

function stubDocument() {
  return {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
}

test('client locale is flat and every literal key resolves', async () => {
  let loaded: any = null
  ;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
  ;(globalThis as any).document = stubDocument()
  const clientPath = path.resolve(process.cwd(), 'client.js')
  await import(`${pathToFileURL(clientPath).href}?audit=${Date.now()}`)
  assert.ok(loaded, 'client loader must run')
  assert.equal(loaded.id, 'dsh-workplan')
  const mod = loaded.factory(() => ReactStub)
  const locales: any = {}
  const ctx: any = {
    effect(fn: any) { return fn() },
    locale: {
      register(_ns: string, lang: string, obj: any) { locales[lang] = obj; return () => {} },
      bind() { return (key: string) => locales.zh?.[key] ?? key },
    },
    slots: {
      inject(_name: string, fn: any) { fn() },
      register() { return () => {} },
    },
  }
  mod.apply(ctx)
  assert.ok(locales.zh, 'zh locale registered')
  assert.ok(locales.en, 'en locale registered')
  for (const [lang, obj] of Object.entries(locales)) {
    for (const [key, value] of Object.entries(obj as any)) {
      assert.equal(typeof value, 'string', `${lang}.${key} must be a flat string`)
    }
  }
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in locales.zh, `missing zh.${key}`)
    assert.ok(key in locales.en, `missing en.${key}`)
  }
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/client.ts'), 'utf8')
  const literalKeys = [...source.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1])
  const missing = literalKeys.filter((key) => !(key in locales.zh) || !(key in locales.en))
  assert.deepEqual(missing, [], `literal locale keys missing: ${missing.join(', ')}`)
})
