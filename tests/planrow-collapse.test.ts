import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * [1.12.0] 「分步进度」每一步默认收起、点击/键盘展开收起。
 *
 * 锁定的契约（T5 C9 + 本次子任务验收）：
 * 1. 首次渲染所有步骤行 data-open=false、aria-expanded=false、面板 hidden；
 * 2. 单击展开、再次单击收起；展开一项不改变其他项；
 * 3. 收起态仍显示状态点、第 N 步：名称、进度条、done/total、状态词；
 * 4. 展开态显示该步目标、检查点与子任务摘要（完整明细仍由下方阶段卡承担）；
 * 5. 点击/Enter/Space 都走同一条切换路径，并阻止冒泡；
 * 6. 展开前后计划统计不变；
 * 7. 重渲染/轮询刷新不重置用户选择；
 * 8. 刷新后（localStorage 恢复）已展开项仍展开，默认项仍收起；
 * 9. localStorage 不可用时退回内存状态，不抛错。
 */

const stateFixture = {
  loading: false,
  error: null,
  updatedAt: 1793600000000,
  sessions: [
    {
      sessionId: 's1',
      title: '分步进度折叠验证',
      phase: 'executing',
      planId: 'wp-planrow',
      stats: { total: 3, done: 1, blocked: 0, inProgress: 1, pending: 1, progress: 33 },
      departments: [{ id: 'engineering', done: 1, total: 2, blocked: 0 }],
      stages: [
        {
          id: 'S1',
          name: '定位',
          goal: '找到画圈处的源码',
          checkpoint: '定位清单逐条可复核',
          subtasks: [
            {
              id: 'T1', title: '列出文件', department: 'engineering', role: '工程师',
              objective: '列出相关文件', method: ['扫描目录'], inputs: [], outputs: ['文件清单'],
              dependsOn: [], acceptance: ['清单完整'], risk: '遗漏',
            },
            {
              id: 'T2', title: '读取源码', department: 'engineering', role: '工程师',
              objective: '读组件源码', method: ['逐行阅读'], inputs: ['文件清单'], outputs: ['接入点'],
              dependsOn: ['T1'], acceptance: ['接入点有行号'], risk: '读错文件',
            },
          ],
        },
        {
          id: 'S2',
          name: '改造',
          goal: '把步骤行改成可折叠',
          checkpoint: '类型检查通过',
          subtasks: [
            {
              id: 'T3', title: '改客户端', department: 'design', role: '交互设计',
              objective: '实现默认收起', method: ['改组件'], inputs: ['接入点'], outputs: ['组件改动'],
              dependsOn: ['T2'], acceptance: ['默认收起'], risk: '状态被覆盖',
            },
          ],
        },
      ],
      statuses: [
        { subtaskId: 'T1', status: 'done' },
        { subtaskId: 'T2', status: 'in_progress' },
        { subtaskId: 'T3', status: 'pending' },
      ],
      errors: [],
      risks: [],
      verification: [],
      practiceLoop: null,
    },
  ],
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
        // The dashboard's first hook is the plan state; every later slot starts
        // from its own initializer (the controlled plan-row set included).
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
    // Simulate a poll delivering new plan data into the dashboard's state slot.
    instance.setData = (next: any) => {
      states[0] = next
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

function collapses(tree: any, className: string) {
  return findAll(tree, (node: any) => hasClass(node, className))
}

function toggleOf(root: any) {
  const button = find(root, (node: any) => node.type === 'button' && hasClass(node, 'dsh-wp-collapse-toggle'))
  assert.ok(button, 'each collapse root must render its summary button')
  return button
}

function click(node: any) {
  const event: any = { stops: 0, stopPropagation() { event.stops += 1 } }
  node.props.onClick(event)
  return event
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
await import(`${pathToFileURL(clientPath).href}?planrow=${Date.now()}`)

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

function openPlanCard(instance: any) {
  const sessions = collapses(instance.tree, 'dsh-wp-session-collapse')
  assert.equal(sessions.length, 1, 'one task card must render')
  click(toggleOf(sessions[0]))
}

function planRowRoots(tree: any) {
  return findAll(tree, (node: any) => node.type === 'section' && hasClass(node, 'dsh-wp-planrow'))
}

function planRowButtons(tree: any) {
  return findAll(tree, (node: any) => node.type === 'button' && hasClass(node, 'dsh-wp-planrow-toggle'))
}

function planRowPanels(tree: any) {
  return findAll(tree, (node: any) => node.type === 'div' && hasClass(node, 'dsh-wp-planrow-panel'))
}

function summaryStats(tree: any) {
  const overview = find(tree, (node: any) => hasClass(node, 'dsh-wp-planoverview'))
  assert.ok(overview, 'step breakdown must render')
  return {
    total: overview.props['data-plan-total'],
    done: overview.props['data-plan-done'],
  }
}

function installStorage(store: Map<string, string>) {
  ;(globalThis as any).window.localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key) : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
  }
}

test('plan rows start collapsed and keep the screenshot summary fields', () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)

  const roots = planRowRoots(instance.tree)
  const buttons = planRowButtons(instance.tree)
  const panels = planRowPanels(instance.tree)
  assert.equal(roots.length, 2, 'one row per stage')
  assert.equal(buttons.length, 2)
  assert.equal(panels.length, 2)

  for (const root of roots) {
    assert.equal(root.props['data-open'], 'false', 'every step starts collapsed')
  }
  for (const button of buttons) {
    assert.equal(button.type, 'button', 'the row summary is a native button')
    assert.equal(button.props.type, 'button')
    assert.equal(button.props['aria-expanded'], false)
  }
  for (const panel of panels) {
    assert.equal(panel.props.hidden, true, 'collapsed panel must stay hidden')
  }
  assert.equal(buttons[0].props['aria-controls'], panels[0].props.id, 'aria-controls points at the row panel')
  assert.equal(buttons[1].props['aria-controls'], panels[1].props.id)

  const first = textOf(buttons[0])
  assert.ok(first.includes('第 1 步：定位'), 'collapsed row keeps the step name')
  assert.ok(first.includes('1/2'), 'collapsed row keeps done/total')
  assert.ok(first.includes('正在做'), 'collapsed row keeps the state word')
  const second = textOf(buttons[1])
  assert.ok(second.includes('第 2 步：改造'))
  assert.ok(second.includes('0/1'))
  assert.ok(second.includes('还没开始'))

  // 默认收起：即使第 1 步是「当前步骤」，首屏也不展开它。
  assert.equal(roots[0].props['data-current'], 'true')
  assert.equal(roots[0].props['data-open'], 'false')
})

test('clicking one row expands only that row; clicking again collapses it', () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)

  const before = summaryStats(instance.tree)
  let buttons = planRowButtons(instance.tree)
  const event = click(buttons[0])
  assert.equal(event.stops, 1, 'row click must not bubble into the parent card')

  let roots = planRowRoots(instance.tree)
  buttons = planRowButtons(instance.tree)
  let panels = planRowPanels(instance.tree)
  assert.equal(roots[0].props['data-open'], 'true')
  assert.equal(buttons[0].props['aria-expanded'], true)
  assert.equal(panels[0].props.hidden, false, 'expanded panel must be visible')
  assert.equal(roots[1].props['data-open'], 'false', 'the other row must stay collapsed')
  assert.equal(panels[1].props.hidden, true)

  const detail = textOf(panels[0])
  assert.ok(detail.includes('要做出什么：找到画圈处的源码'), 'expanded row shows the step goal')
  assert.ok(detail.includes('这一步做完先检查：定位清单逐条可复核'), 'expanded row shows the checkpoint')
  assert.ok(detail.includes('具体工作 1：列出文件'), 'expanded row lists its work items')
  assert.ok(detail.includes('具体工作 2：读取源码'))
  assert.ok(detail.includes('做好了'), 'work item status is visible')
  assert.ok(detail.includes('正在做'))
  assert.ok(detail.includes('工程研发'), 'work item department is visible')
  assert.equal(detail.includes('怎么做'), false, 'the compact summary must not duplicate the full stage card')

  assert.deepEqual(summaryStats(instance.tree), before, 'expanding must not change plan totals')

  click(planRowButtons(instance.tree)[0])
  roots = planRowRoots(instance.tree)
  panels = planRowPanels(instance.tree)
  assert.equal(roots[0].props['data-open'], 'false')
  assert.equal(panels[0].props.hidden, true)
  assert.equal(roots[1].props['data-open'], 'false', 'collapsing row 1 must not touch row 2')
  assert.deepEqual(summaryStats(instance.tree), before)
})

test('multiple rows expand independently; one row never resets another', () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)

  click(planRowButtons(instance.tree)[0])
  click(planRowButtons(instance.tree)[1])
  let roots = planRowRoots(instance.tree)
  assert.equal(roots[0].props['data-open'], 'true')
  assert.equal(roots[1].props['data-open'], 'true')

  click(planRowButtons(instance.tree)[0])
  roots = planRowRoots(instance.tree)
  assert.equal(roots[0].props['data-open'], 'false', 'closing row 1 only closes row 1')
  assert.equal(roots[1].props['data-open'], 'true', 'row 2 stays open')
})

test('Enter and Space follow the native button path; unrelated keys keep bubbling', () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)

  let button = planRowButtons(instance.tree)[0]
  const enter = { key: 'Enter', stops: 0, stopPropagation() { enter.stops += 1 } }
  button.props.onKeyDown(enter)
  assert.equal(enter.stops, 1)
  assert.equal(planRowButtons(instance.tree)[0].props['aria-expanded'], false, 'keydown alone must not double-toggle')

  const space = { key: ' ', stops: 0, stopPropagation() { space.stops += 1 } }
  button.props.onKeyDown(space)
  assert.equal(space.stops, 1)
  assert.equal(planRowButtons(instance.tree)[0].props['aria-expanded'], false)

  const other = { key: 'a', stops: 0, stopPropagation() { other.stops += 1 } }
  button.props.onKeyDown(other)
  assert.equal(other.stops, 0, 'unrelated keys keep bubbling')

  // Browsers turn Enter/Space into a click; the click path is the single toggle source.
  click(planRowButtons(instance.tree)[0])
  assert.equal(planRowButtons(instance.tree)[0].props['aria-expanded'], true)
})

test('re-rendering / polling keeps the user choice instead of forcing a state', () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)

  click(planRowButtons(instance.tree)[0])
  assert.equal(planRowRoots(instance.tree)[0].props['data-open'], 'true')

  // Simulate the dashboard re-rendering on the next poll with the same data.
  instance.update({ t: instance.props.t })
  let roots = planRowRoots(instance.tree)
  assert.equal(roots[0].props['data-open'], 'true', 'a re-render must not collapse the open row')
  assert.equal(roots[1].props['data-open'], 'false')

  click(planRowButtons(instance.tree)[1])
  instance.update({ t: instance.props.t })
  roots = planRowRoots(instance.tree)
  assert.equal(roots[1].props['data-open'], 'true')
  assert.equal(roots[0].props['data-open'], 'true')
})

test('a data update refreshes content but never forces a row open or shut', () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)

  click(planRowButtons(instance.tree)[0])
  assert.equal(planRowRoots(instance.tree)[0].props['data-open'], 'true')

  const next: any = JSON.parse(JSON.stringify(stateFixture))
  next.sessions[0].stages[0].subtasks[1].title = '读取源码（已更新）'
  next.sessions[0].statuses[1].status = 'done'
  next.sessions[0].stats = { total: 3, done: 2, blocked: 0, inProgress: 0, pending: 1, progress: 67 }
  instance.setData(next)

  const roots = planRowRoots(instance.tree)
  assert.equal(roots[0].props['data-open'], 'true', 'updated data must not collapse the open row')
  assert.equal(roots[1].props['data-open'], 'false', 'updated data must not expand untouched rows')
  const detail = textOf(planRowPanels(instance.tree)[0])
  assert.ok(detail.includes('读取源码（已更新）'), 'updated work item text must render')
  assert.ok(detail.includes('做好了'), 'updated work item status must render')
  assert.equal(summaryStats(instance.tree).done, '2', 'updated totals must render')
})

test('the open choice survives a refresh (localStorage), default rows stay collapsed', () => {
  const store = new Map<string, string>()
  installStorage(store)

  // First visit: open the second step only.
  {
    const harness = createHarness(stateFixture)
    const { instance } = mountDashboard(harness)
    openPlanCard(instance)
    click(planRowButtons(instance.tree)[1])
    assert.equal(JSON.parse(store.get('dsh-workplan:planrow-open:v1:s1') || '[]').join(','), 'S2')
  }

  // Refresh: a brand-new mount must restore S2 open and S1 closed.
  {
    const harness = createHarness(stateFixture)
    const { instance } = mountDashboard(harness)
    openPlanCard(instance)
    const roots = planRowRoots(instance.tree)
    assert.equal(roots[0].props['data-open'], 'false', 'S1 was never opened')
    assert.equal(roots[1].props['data-open'], 'true', 'S2 must be restored from localStorage')
  }

  // Close S2, refresh again: nothing is expanded.
  {
    const harness = createHarness(stateFixture)
    const { instance } = mountDashboard(harness)
    openPlanCard(instance)
    click(planRowButtons(instance.tree)[1])
    assert.equal(store.get('dsh-workplan:planrow-open:v1:s1'), '[]')
  }
  {
    const harness = createHarness(stateFixture)
    const { instance } = mountDashboard(harness)
    openPlanCard(instance)
    for (const root of planRowRoots(instance.tree)) {
      assert.equal(root.props['data-open'], 'false', 'a closed choice must not come back open')
    }
  }
})

test('closing and reopening the task card keeps the per-step choice (no implicit expand)', () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)

  openPlanCard(instance)
  click(planRowButtons(instance.tree)[0])
  assert.equal(planRowRoots(instance.tree)[0].props['data-open'], 'true')

  // Collapse the whole card: PlanOverview unmounts, but SessionCard keeps the choice.
  click(toggleOf(collapses(instance.tree, 'dsh-wp-session-collapse')[0]))
  assert.equal(planRowRoots(instance.tree).length, 0, 'collapsed card must not render the breakdown')

  // Reopen: the row the user opened is still open; the other row stays closed.
  click(toggleOf(collapses(instance.tree, 'dsh-wp-session-collapse')[0]))
  const roots = planRowRoots(instance.tree)
  assert.equal(roots.length, 2)
  assert.equal(roots[0].props['data-open'], 'true', 'a card reopen must not reset the user choice')
  assert.equal(roots[1].props['data-open'], 'false', 'a card reopen must not expand untouched rows')
})

function twoSessionFixture() {
  const fixture: any = JSON.parse(JSON.stringify(stateFixture))
  const second = JSON.parse(JSON.stringify(fixture.sessions[0]))
  second.sessionId = 's2'
  second.planId = 'wp-planrow-2'
  second.title = '另一个计划的步骤'
  fixture.sessions.push(second)
  return fixture
}

test('two task cards keep independent step state and storage keys', () => {
  const store = new Map<string, string>()
  installStorage(store)
  const harness = createHarness(twoSessionFixture())
  const { instance } = mountDashboard(harness)

  function card(id: string) {
    const node = find(instance.tree, (candidate: any) => candidate.props?.['data-session-id'] === id)
    assert.ok(node, `session card ${id} must render`)
    return node
  }

  // Open s1 and expand its first step.
  click(toggleOf(card('s1')))
  let roots = planRowRoots(card('s1'))
  assert.equal(roots.length, 2)
  const s1PanelId = planRowButtons(card('s1'))[0].props['aria-controls']
  click(planRowButtons(card('s1'))[0])
  assert.equal(planRowRoots(card('s1'))[0].props['data-open'], 'true')
  assert.equal(planRowRoots(card('s1'))[1].props['data-open'], 'false')
  assert.equal(store.get('dsh-workplan:planrow-open:v1:s1'), '["S1"]')

  // The dashboard is an accordion: opening s2 closes s1, but s1's choice is kept.
  click(toggleOf(card('s2')))
  roots = planRowRoots(card('s2'))
  assert.equal(roots.length, 2)
  const s2PanelId = planRowButtons(card('s2'))[0].props['aria-controls']
  assert.notEqual(s1PanelId, s2PanelId, 'panel ids must be session-scoped')
  assert.equal(roots[0].props['data-open'], 'false', 's2 must start collapsed')
  assert.equal(roots[1].props['data-open'], 'false')
  click(planRowButtons(card('s2'))[1])
  assert.equal(store.get('dsh-workplan:planrow-open:v1:s2'), '["S2"]')

  // Reopen s1: its own row set is restored, s2's choice stays in s2.
  click(toggleOf(card('s1')))
  roots = planRowRoots(card('s1'))
  assert.equal(roots[0].props['data-open'], 'true', 's1 keeps its own opened row')
  assert.equal(roots[1].props['data-open'], 'false')

  // Reopen s2: only S2 is open there.
  click(toggleOf(card('s2')))
  roots = planRowRoots(card('s2'))
  assert.equal(roots[0].props['data-open'], 'false')
  assert.equal(roots[1].props['data-open'], 'true')
})

test('a broken localStorage falls back to in-memory state without errors', () => {
  ;(globalThis as any).window.localStorage = {
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('QuotaExceededError') },
  }
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)
  assert.equal(planRowRoots(instance.tree)[0].props['data-open'], 'false')
  click(planRowButtons(instance.tree)[0])
  const roots = planRowRoots(instance.tree)
  assert.equal(roots[0].props['data-open'], 'true', 'interaction still works when storage is unavailable')
  assert.equal(roots[1].props['data-open'], 'false')
})

test('the existing full step details still render below the collapsible overview', async () => {
  installStorage(new Map())
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  openPlanCard(instance)

  // D-6 未拍板：下方「分几步做」阶段卡必须原样保留。
  assert.equal(collapses(instance.tree, 'dsh-wp-stage-collapse').length, 2)

  // The source branch that renders the overview is unchanged (progress-visual test
  // also asserts this string); this guards against accidentally removing the panel.
  const source = await readFile(path.resolve(process.cwd(), 'src/client.ts'), 'utf8')
  assert.ok(source.includes('open === true ? h(PlanOverview'), 'the open branch must render the breakdown')
  assert.ok(source.includes("t('vizStageTitle')"), 'the breakdown must be labelled')
})
