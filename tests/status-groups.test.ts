import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * T7 regression: the "进行中 / 已完成" groups.
 *
 * Locks three properties that are easy to break without noticing:
 * 1. folding hides the completed group body but MUST NOT unmount the cards
 *    (`hidden` attribute + class, not a conditional `open ? body : null`);
 * 2. the disclosure button exposes `aria-expanded` and `aria-controls`
 *    pointing at the real body id in both states;
 * 3. in-group order follows design `docs/status-grouping-ia.md` §3.3:
 *    blocked first, paused/degraded next, then executing → integrating →
 *    planning → pending, ties by createdAt desc, sessionId as stable
 *    tie-break; the completed group sorts by the latest
 *    `statuses[].finishedAt`, not by the polling-refreshed `updatedAt`.
 */

function makeSession(overrides: any) {
  const base: any = {
    sessionId: 's',
    title: '任务',
    phase: 'executing',
    planId: null,
    createdAt: 1000,
    updatedAt: 1000,
    stats: { total: 0, done: 0, blocked: 0, inProgress: 0, pending: 0, progress: 0 },
    departments: [],
    stages: [],
    statuses: [],
    errors: [],
    risks: [],
    verification: [],
    practiceLoop: null,
  }
  return {
    ...base,
    ...overrides,
    stats: { ...base.stats, ...(overrides.stats || {}) },
  }
}

function stageFixture(name: string) {
  return [{
    id: 'S1',
    name,
    goal: '目标',
    checkpoint: '检查点',
    subtasks: [{
      id: 'T1',
      title: '具体工作',
      department: 'engineering',
      role: '工程师',
      objective: '完成',
      method: ['方法'],
      inputs: [],
      outputs: [],
      dependsOn: [],
      acceptance: ['验收'],
      risk: '风险',
    }],
  }]
}

function createHarness(fixture: any) {
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
      if (index >= states.length) {
        states[index] = index === 0 ? fixture : (typeof init === 'function' ? init() : init)
      }
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

  return { React: ReactStub, mount }
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

function hasClass(node: any, name: string) {
  if (!node || typeof node !== 'object') return false
  return String(node.props?.className || '').split(/\s+/).includes(name)
}

function click(node: any) {
  node.props.onClick()
}

// --- bundle loading (same pattern as the other client tests) ---
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
await import(`${pathToFileURL(clientPath).href}?status-groups=${Date.now()}`)

function mountDashboard(harness: Harness) {
  assert.ok(loaded, 'client bundle must register itself through window.__ModuleLoader__')
  const mod = loaded.factory(() => harness.React)
  const locales: any = {}
  let mainComponent: any = null
  const ctx: any = {
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
      register(spec: any, component: any) {
        if (spec.name === 'main') mainComponent = component
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.ok(mainComponent, 'main panel component must be registered')
  const t = (key: string) => locales.zh?.[key] ?? key
  const instance = harness.mount(mainComponent, { t })
  return { instance, t }
}

function groupOf(tree: any, group: string) {
  return find(tree, (node: any) => node.type === 'section' && node.props?.['data-group'] === group)
}

function groupHeadButtonOf(group: any) {
  return find(group, (node: any) => node.type === 'button' && hasClass(node, 'dsh-wp-group-head--btn'))
}

function groupBodyOf(group: any) {
  return find(group, (node: any) => node.type === 'div' && hasClass(node, 'dsh-wp-group-body'))
}

function cardsOf(body: any) {
  return findAll(body, (node: any) => node.type === 'article' && Boolean(node.props?.['data-session-id']))
}

function cardIds(body: any) {
  return cardsOf(body).map((card: any) => card.props['data-session-id'])
}

function toggleOf(card: any) {
  const button = find(card, (node: any) => node.type === 'button' && hasClass(node, 'dsh-wp-collapse-toggle'))
  assert.ok(button, 'each card must render its collapse summary button')
  return button
}

const liveSession = makeSession({
  sessionId: 'live-1',
  title: '正在进行的任务',
  phase: 'executing',
  createdAt: 100,
  updatedAt: 500,
  stats: { total: 2, done: 1, inProgress: 1 },
  stages: stageFixture('直接回答'),
})

const doneNewer = makeSession({
  sessionId: 'done-newer',
  title: '刚完成的任务',
  phase: 'done',
  createdAt: 50,
  updatedAt: 999,
  stats: { total: 2, done: 2, progress: 100 },
  statuses: [{ subtaskId: 'T1', status: 'done', finishedAt: 900 }],
  stages: stageFixture('收尾'),
})

const doneOlder = makeSession({
  sessionId: 'done-older',
  title: '早先完成的任务',
  phase: 'done',
  createdAt: 40,
  updatedAt: 800,
  stats: { total: 1, done: 1, progress: 100 },
  statuses: [{ subtaskId: 'T1', status: 'done', finishedAt: 100 }],
  stages: stageFixture('旧收尾'),
})

test('folded completed group keeps every card mounted and exposes matching aria state', () => {
  const harness = createHarness({ loading: false, error: null, updatedAt: 1, sessions: [liveSession, doneNewer, doneOlder] })
  const { instance } = mountDashboard(harness)

  const done = groupOf(instance.tree, 'done')
  assert.ok(done, 'completed group must render when a completed session exists')
  assert.equal(done.props['data-folded'], 'true', 'completed group folds when a live session exists')

  const body = groupBodyOf(done)
  assert.ok(body, 'folded group body must still be in the tree (no conditional unmount)')
  assert.equal(body.props.id, 'dsh-wp-group-body-done')
  assert.equal(body.props.hidden, true, 'hidden must be the boolean true React applies to the DOM property')
  assert.ok(hasClass(body, 'dsh-wp-group-body--folded'))
  assert.equal(cardsOf(body).length, 2, 'both completed cards stay mounted while folded')
  assert.deepEqual(cardIds(body), ['done-newer', 'done-older'], 'completed order follows finishedAt')
  assert.ok(textOf(body).includes('刚完成的任务'), 'folded cards keep their content')
  assert.equal(
    findAll(body, (node: any) => hasClass(node, 'dsh-wp-session-body')).length,
    2,
    'each card detail panel is still mounted while the group is folded',
  )

  const head = groupHeadButtonOf(done)
  assert.ok(head, 'completed group header must be a disclosure button')
  assert.equal(head.props['aria-expanded'], false)
  assert.equal(head.props['aria-controls'], body.props.id, 'aria-controls must point at the rendered body id')
  assert.equal(head.props['aria-expanded'], false)

  click(head)

  const expanded = groupOf(instance.tree, 'done')
  const expandedBody = groupBodyOf(expanded)
  const expandedHead = groupHeadButtonOf(expanded)
  assert.equal(expandedHead.props['aria-expanded'], true)
  assert.equal(expandedHead.props['aria-controls'], expandedBody.props.id)
  assert.equal(expanded.props['data-folded'], 'false')
  assert.equal(expandedBody.props.hidden, undefined, 'expanded body must not carry hidden')
  assert.equal(cardsOf(expandedBody).length, 2, 'expanding must not remount the cards away')

  click(expandedHead)
  const refolded = groupOf(instance.tree, 'done')
  assert.equal(refolded.props['data-folded'], 'true')
  assert.equal(groupBodyOf(refolded).props.hidden, true)
  assert.equal(cardsOf(groupBodyOf(refolded)).length, 2, 'folding again keeps the cards in the DOM')
})

test('expanding a card, folding and unfolding the group keeps that card expanded', () => {
  const harness = createHarness({ loading: false, error: null, updatedAt: 1, sessions: [liveSession, doneNewer, doneOlder] })
  const { instance } = mountDashboard(harness)

  let body = groupBodyOf(groupOf(instance.tree, 'done'))
  const card = cardsOf(body)[0]
  click(toggleOf(card))
  let first = cardsOf(groupBodyOf(groupOf(instance.tree, 'done')))[0]
  assert.equal(first.props['data-session-id'], 'done-newer')
  assert.equal(find(first, (node: any) => hasClass(node, 'dsh-wp-collapse')).props?.['data-open'], 'true')

  const head = groupHeadButtonOf(groupOf(instance.tree, 'done'))
  click(head)
  click(head)

  body = groupBodyOf(groupOf(instance.tree, 'done'))
  first = cardsOf(body)[0]
  assert.equal(first.props['data-open'], undefined, 'card state lives on the collapse root, not the article')
  const collapseRoot = find(first, (node: any) => hasClass(node, 'dsh-wp-collapse'))
  assert.equal(collapseRoot.props['data-open'], 'true', 'the card keeps its expanded state across group folding')
  assert.ok(textOf(first).includes('第 1 步：收尾'), 'the expanded card content is still rendered inside the folded group')
})

test('completed group starts expanded when nothing is in progress', () => {
  const harness = createHarness({ loading: false, error: null, updatedAt: 1, sessions: [doneNewer, doneOlder] })
  const { instance } = mountDashboard(harness)

  const done = groupOf(instance.tree, 'done')
  assert.equal(done.props['data-folded'], 'false')
  assert.equal(groupHeadButtonOf(done).props['aria-expanded'], true)
  assert.equal(groupBodyOf(done).props.hidden, undefined)
  const live = groupOf(instance.tree, 'live')
  assert.ok(live, 'empty live group still renders its heading and empty hint')
  assert.equal(groupBodyOf(live), null, 'no live cards means no body to fold')
  assert.ok(textOf(live).includes('没有进行中的任务'))
})

test('live group sorts by §3.3: blocked, paused/degraded, executing, integrating, planning, pending', () => {
  const fixture = [
    makeSession({ sessionId: 's-pending-b', phase: 'pending', createdAt: 400 }),
    makeSession({ sessionId: 's-planning', phase: 'planning', createdAt: 50 }),
    makeSession({ sessionId: 's-integrating', phase: 'integrating', createdAt: 900 }),
    makeSession({ sessionId: 's-exec-old', phase: 'executing', createdAt: 100 }),
    makeSession({ sessionId: 's-degraded', phase: 'degraded', createdAt: 200 }),
    makeSession({ sessionId: 's-paused', phase: 'paused', createdAt: 300 }),
    makeSession({ sessionId: 's-blocked', phase: 'blocked', createdAt: 100 }),
    makeSession({ sessionId: 's-exec-mid', phase: 'executing', createdAt: 600 }),
    makeSession({ sessionId: 's-exec-new', phase: 'executing', createdAt: 700 }),
    makeSession({ sessionId: 's-pending-a', phase: 'pending', createdAt: 400 }),
  ]
  const harness = createHarness({ loading: false, error: null, updatedAt: 1, sessions: fixture })
  const { instance } = mountDashboard(harness)

  const live = groupOf(instance.tree, 'live')
  assert.ok(live)
  assert.equal(live.props['data-folded'], 'false', 'live group is never folded')
  assert.equal(groupHeadButtonOf(live), null, 'live group header is not a disclosure button')
  assert.equal(groupBodyOf(live).props.hidden, undefined)

  assert.deepEqual(cardIds(groupBodyOf(live)), [
    's-blocked',
    's-paused',
    's-degraded',
    's-exec-new',
    's-exec-mid',
    's-exec-old',
    's-integrating',
    's-planning',
    's-pending-a',
    's-pending-b',
  ])
})

test('completed group sorts by latest finishedAt, then createdAt desc', () => {
  const fixture = [
    liveSession,
    makeSession({
      sessionId: 'd-updated-newest',
      phase: 'done',
      createdAt: 10,
      updatedAt: 9999,
      statuses: [{ subtaskId: 'T1', status: 'done', finishedAt: 100 }],
    }),
    makeSession({
      sessionId: 'd-finished-newest',
      phase: 'done',
      createdAt: 20,
      updatedAt: 1,
      statuses: [{ subtaskId: 'T1', status: 'done', finishedAt: 900 }],
    }),
    makeSession({
      sessionId: 'd-fallback-updated',
      phase: 'done',
      createdAt: 30,
      updatedAt: 800,
      statuses: [],
    }),
    makeSession({
      sessionId: 'd-tie-newer-created',
      phase: 'done',
      createdAt: 500,
      updatedAt: 2,
      statuses: [{ subtaskId: 'T1', status: 'done', finishedAt: 800 }],
    }),
  ]
  const harness = createHarness({ loading: false, error: null, updatedAt: 1, sessions: fixture })
  const { instance } = mountDashboard(harness)

  assert.deepEqual(cardIds(groupBodyOf(groupOf(instance.tree, 'done'))), [
    'd-finished-newest',
    'd-tie-newer-created',
    'd-fallback-updated',
    'd-updated-newest',
  ], 'finishedAt wins over updatedAt; ties fall back to createdAt desc')
})

test('fold chevron encodes state by shape, not colour', () => {
  const css = styleNodes.map((node: any) => String(node.textContent || '')).join('\n')
  assert.match(
    css,
    /\.dsh-wp-group--folded\s+\.dsh-wp-group-chevron\s*\{[^}]*rotate\(-45deg\)/,
    'folded chevron must rotate (shape encoding); colour may only be a fallback',
  )
  assert.match(
    css,
    /\.dsh-wp-group-chevron\s*\{[^}]*rotate\(45deg\)/,
    'expanded chevron must have the opposite rotation',
  )
  assert.match(css, /\.dsh-wp-group-body--folded\s*\{\s*display:\s*none/, 'folded body uses display:none, not removal')
})
