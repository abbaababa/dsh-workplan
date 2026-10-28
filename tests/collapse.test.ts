import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Minimal hook-aware renderer for the plugin bundle.
 *
 * The bundle is a plain `window.__ModuleLoader__.load({ factory })` script and
 * its `factory` only needs `require('react')`, so a tiny stub is enough to mount
 * presentational components. State slots persist across re-renders, which is all
 * the uncontrolled Collapse path needs.
 */
function createHarness() {
  let states: any[] = []
  let cursor = 0
  let renderRoot: (() => void) | null = null
  let rendering = false

  const ReactStub: any = {
    Fragment: 'fragment',
    Component: class {
      props: any
      constructor(props: any) {
        this.props = props
      }
      render() {
        return this.props?.children ?? null
      }
    },
    createElement(type: any, props: any, ...children: any[]) {
      const merged: any = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(init: any) {
      const index = cursor++
      if (index >= states.length) states[index] = typeof init === 'function' ? init() : init
      const setState = (value: any) => {
        const next = typeof value === 'function' ? value(states[index]) : value
        if (Object.is(next, states[index])) return
        states[index] = next
        if (renderRoot && !rendering) renderRoot()
      }
      return [states[index], setState]
    },
    useEffect() {},
    useCallback(fn: any) {
      return fn
    },
    useMemo(fn: any) {
      return fn()
    },
  }

  function renderNode(node: any): any {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(renderNode)
    if (typeof node.type === 'function') {
      const isClass = node.type.prototype && node.type.prototype.render
      return renderNode(isClass ? new node.type(node.props).render() : node.type(node.props))
    }
    if (node.type === 'fragment') return renderNode(node.props?.children)
    return { type: String(node.type), props: node.props || {}, children: renderNode(node.props?.children) }
  }

  function mount(Component: any, props: any) {
    states = []
    cursor = 0
    const instance: any = { props, tree: null }
    const render = () => {
      cursor = 0
      rendering = true
      try {
        instance.tree = renderNode(ReactStub.createElement(Component, instance.props))
      } finally {
        rendering = false
      }
      return instance.tree
    }
    instance.update = (next: any) => {
      instance.props = { ...instance.props, ...next }
      return render()
    }
    renderRoot = render
    render()
    return instance
  }

  return { React: ReactStub, mount, renderNode }
}

type Harness = ReturnType<typeof createHarness>

function childrenOf(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  return Array.isArray(node.children) ? node.children : [node.children]
}

function find(node: any, predicate: (candidate: any) => boolean): any {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of childrenOf(node)) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return null
}

function findAll(node: any, predicate: (candidate: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of childrenOf(node)) findAll(child, predicate, out)
  return out
}

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return textOf(node.children)
}

function query(instance: any, harness: Harness) {
  const tree = instance.tree
  const button = find(tree, (node: any) => node.type === 'button' && String(node.props.className || '').includes('dsh-wp-collapse-toggle'))
  const panel = find(tree, (node: any) => node.type === 'div' && String(node.props.id || '').endsWith('-panel'))
  const root = find(tree, (node: any) => node.type === 'section' && String(node.props.className || '').includes('dsh-wp-collapse'))
  assert.ok(button, 'collapse summary button must render')
  assert.ok(panel, 'collapse panel must render')
  assert.ok(root, 'collapse root must render')
  return { tree, button, panel, root, harness }
}

function makeEvent(key?: string) {
  const event: any = {
    stops: 0,
    preventDefaults: 0,
    key,
    stopPropagation() {
      event.stops += 1
    },
    preventDefault() {
      event.preventDefaults += 1
    },
  }
  return event
}

// --- load the built bundle once (tests run from the package root) ---
let loaded: any = null
;(globalThis as any).window = {
  __ModuleLoader__: {
    load(spec: any) {
      loaded = spec
    },
  },
}
const styleNodes: any[] = []
;(globalThis as any).document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (node: any) => styleNodes.push(node) },
}

const clientPath = path.resolve(process.cwd(), 'client.js')
await import(`${pathToFileURL(clientPath).href}?collapse=${Date.now()}`)

function bundle() {
  assert.ok(loaded, 'client bundle must register itself through window.__ModuleLoader__')
  assert.equal(typeof loaded.factory, 'function')
  return loaded
}

function minimalCtx() {
  const locales: any = {}
  return {
    effect(fn: any) {
      return fn()
    },
    locale: {
      register(_ns: string, lang: string, messages: any) {
        locales[lang] = messages
        return () => {}
      },
      bind() {
        return (key: string) => locales.zh?.[key] ?? key
      },
    },
    slots: {
      inject(_name: string, fn: any) {
        fn()
      },
      register() {
        return () => {}
      },
    },
  }
}

test('collapse component is exported for reuse by the task and step layers', () => {
  const harness = createHarness()
  const mod = bundle().factory(() => harness.React)
  assert.ok(mod.components, 'bundle must export reusable components')
  assert.equal(typeof mod.components.Collapse, 'function')
})

test('collapse starts collapsed and keeps title, progress and status in the summary', () => {
  const harness = createHarness()
  const mod = bundle().factory(() => harness.React)
  const Collapse = mod.components.Collapse
  const instance = harness.mount(Collapse, {
    title: '单句说明 1+1=2',
    meta: '1/1 做好了',
    badge: '已完成',
    children: harness.React.createElement('div', { className: 'body' }, '步骤明细正文'),
  })
  const { button, panel, root } = query(instance, harness)

  assert.equal(root.props['data-open'], 'false')
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props['aria-controls'], panel.props.id)
  assert.ok(String(panel.props.id).startsWith('dsh-wp-collapse-'))
  assert.equal(panel.props.hidden, true)

  const summary = textOf(button)
  assert.ok(summary.includes('单句说明 1+1=2'), 'collapsed summary keeps the task name')
  assert.ok(summary.includes('1/1 做好了'), 'collapsed summary keeps done/total')
  assert.ok(summary.includes('已完成'), 'collapsed summary keeps the status')
  assert.ok(textOf(panel).includes('步骤明细正文'), 'body stays mounted inside the hidden panel')
})

test('clicking the summary expands and clicking again collapses, without bubbling', () => {
  const harness = createHarness()
  const mod = bundle().factory(() => harness.React)
  const instance = harness.mount(mod.components.Collapse, { title: '检查 README', meta: '0/3 做好了' })

  const firstClick = makeEvent()
  query(instance, harness).button.props.onClick(firstClick)
  assert.equal(firstClick.stops, 1, 'summary click must stop propagation')
  let current = query(instance, harness)
  assert.equal(current.button.props['aria-expanded'], true)
  assert.equal(current.panel.props.hidden, false)
  assert.equal(current.root.props['data-open'], 'true')

  const secondClick = makeEvent()
  current.button.props.onClick(secondClick)
  assert.equal(secondClick.stops, 1)
  current = query(instance, harness)
  assert.equal(current.button.props['aria-expanded'], false)
  assert.equal(current.panel.props.hidden, true)
  assert.equal(current.root.props['data-open'], 'false')
})

test('the summary is a native button so Enter and Space reach the same toggle path', () => {
  const harness = createHarness()
  const mod = bundle().factory(() => harness.React)
  const instance = harness.mount(mod.components.Collapse, { title: '任务名', meta: '0/2 做好了' })

  let current = query(instance, harness)
  assert.equal(current.button.props.type, 'button', 'native button provides Enter/Space activation')

  for (const key of ['Enter', ' ', 'Spacebar']) {
    const event = makeEvent(key)
    current.button.props.onKeyDown(event)
    assert.equal(event.stops, 1, `${key} keydown must not bubble into the parent card`)
    assert.equal(event.preventDefaults, 0, 'the native button keeps its default activation')
  }
  assert.equal(query(instance, harness).button.props['aria-expanded'], false, 'keydown alone must not double-toggle')

  const other = makeEvent('a')
  query(instance, harness).button.props.onKeyDown(other)
  assert.equal(other.stops, 0, 'unrelated keys keep bubbling')

  // Browsers turn the native button activation into a click; the click path is
  // the single toggle source, so Enter/Space expand exactly once.
  const activation = makeEvent()
  query(instance, harness).button.props.onClick(activation)
  assert.equal(query(instance, harness).button.props['aria-expanded'], true)
})

test('supports controlled open state and reports the next value', () => {
  const harness = createHarness()
  const mod = bundle().factory(() => harness.React)
  const changes: boolean[] = []
  const instance = harness.mount(mod.components.Collapse, {
    title: '受控任务',
    open: false,
    onOpenChange: (next: boolean) => changes.push(next),
  })

  query(instance, harness).button.props.onClick(makeEvent())
  assert.deepEqual(changes, [true])
  assert.equal(query(instance, harness).button.props['aria-expanded'], false, 'controlled state only changes when the parent changes open')

  instance.update({ open: true })
  assert.equal(query(instance, harness).button.props['aria-expanded'], true)
  assert.equal(query(instance, harness).panel.props.hidden, false)

  query(instance, harness).button.props.onClick(makeEvent())
  assert.deepEqual(changes, [true, false])
  assert.equal(query(instance, harness).button.props['aria-expanded'], true, 'still controlled by the open prop')
})

test('defaultOpen only sets the initial state and every instance gets its own ids', () => {
  const harness = createHarness()
  const h = harness.React.createElement
  const mod = bundle().factory(() => harness.React)
  const Collapse = mod.components.Collapse

  const open = harness.mount(Collapse, { title: '默认展开', defaultOpen: true })
  assert.equal(query(open, harness).button.props['aria-expanded'], true)
  open.update({ title: '改名后仍展开' })
  assert.equal(query(open, harness).button.props['aria-expanded'], true, 'defaultOpen is not re-applied on re-render')

  function Pair() {
    return h('div', null,
      h(Collapse, { title: '任务一' }),
      h(Collapse, { title: '任务二' }),
      h(Collapse, { title: '步骤 1' }),
    )
  }
  const pair = harness.mount(Pair, {})
  const controls = findAll(pair.tree, (node: any) => node.type === 'button' && String(node.props.className || '').includes('dsh-wp-collapse-toggle'))
    .map((node: any) => node.props['aria-controls'])
  assert.equal(controls.length, 3)
  assert.equal(new Set(controls).size, 3, 'aria-controls ids must be unique per instance')
})

test('collapse styles ship a 44px toggle target, a hidden panel rule and focus outline', () => {
  const harness = createHarness()
  const mod = bundle().factory(() => harness.React)
  styleNodes.length = 0
  mod.apply(minimalCtx())
  assert.ok(styleNodes.length > 0, 'apply must inject a style element')
  const css = styleNodes.map((node: any) => node.textContent).join('\n')
  assert.match(css, /\.dsh-wp-collapse-toggle\s*\{[^}]*min-height:\s*44px/)
  assert.match(css, /\.dsh-wp-collapse-toggle\s*\{[^}]*cursor:\s*pointer/)
  assert.match(css, /\.dsh-wp-collapse-toggle:focus-visible/)
  assert.match(css, /\.dsh-wp-collapse-panel\[hidden\]\s*\{\s*display:\s*none;\s*\}/)
  assert.match(css, /\.dsh-wp-collapse\[data-open="true"\] \.dsh-wp-collapse-chevron/)
  assert.match(css, /prefers-reduced-motion[\s\S]*dsh-wp-collapse-chevron/)
})
