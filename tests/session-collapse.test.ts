import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Integration test: the task card (SessionCard) and the step card (StageCard)
 * must both use the shared Collapse component, start collapsed, keep the task
 * name / done-total / status in the summary, and must not change the aggregate
 * numbers rendered by the dashboard.
 */

const stateFixture = {
  loading: false,
  error: null,
  updatedAt: 1792938113017,
  sessions: [
    {
      sessionId: 's1',
      title: '单句说明 1+1=2',
      phase: 'done',
      planId: 'wp-s1',
      stats: { total: 1, done: 1, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
      departments: [{ id: 'engineering', done: 1, total: 1, blocked: 0 }],
      stages: [{
        id: 'S1',
        name: '直接回答',
        goal: '给出结论',
        checkpoint: '结论正确',
        subtasks: [{
          id: 'T1', title: '计算 1+1', department: 'engineering', role: '工程师',
          objective: '算出结果', method: ['口算'], inputs: [], outputs: ['2'],
          dependsOn: [], acceptance: ['等于 2'], risk: '算错',
        }],
      }],
      statuses: [{ subtaskId: 'T1', status: 'done' }],
      errors: [],
      risks: [],
      verification: [],
      practiceLoop: null,
    },
    {
      sessionId: 's2',
      title: '检查 dsh-workplan README',
      phase: 'done',
      planId: 'wp-s2',
      stats: { total: 3, done: 3, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
      departments: [{ id: 'engineering', done: 3, total: 3, blocked: 0 }],
      stages: [{
        id: 'S1',
        name: '核对文档',
        goal: '确认说明与代码一致',
        checkpoint: '逐条核对',
        subtasks: [
          { id: 'T1', title: '读 README', department: 'engineering', role: '工程师', objective: '通读', method: ['阅读'], inputs: [], outputs: ['疑问清单'], dependsOn: [], acceptance: ['读完'], risk: '漏读' },
          { id: 'T2', title: '对照代码', department: 'engineering', role: '工程师', objective: '核对', method: ['比对'], inputs: ['疑问清单'], outputs: ['差异'], dependsOn: ['T1'], acceptance: ['差异有证据'], risk: '误判' },
          { id: 'T3', title: '记录结论', department: 'qa', role: '测试', objective: '记录', method: ['整理'], inputs: ['差异'], outputs: ['结论'], dependsOn: ['T2'], acceptance: ['结论可复核'], risk: '遗漏' },
        ],
      }],
      statuses: [
        { subtaskId: 'T1', status: 'done' },
        { subtaskId: 'T2', status: 'done' },
        { subtaskId: 'T3', status: 'done' },
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
        // The dashboard's first hook is the plan state; later hooks are the
        // uncontrolled Collapse slots and must start from their own defaults.
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

function collapses(tree: any, className: string) {
  return findAll(tree, (node: any) => hasClass(node, className))
}

function toggleOf(root: any) {
  const button = find(root, (node: any) => node.type === 'button' && hasClass(node, 'dsh-wp-collapse-toggle'))
  assert.ok(button, 'each collapse root must render its summary button')
  return button
}

function panelOf(root: any) {
  const panel = find(root, (node: any) => node.type === 'div' && hasClass(node, 'dsh-wp-collapse-panel'))
  assert.ok(panel, 'each collapse root must render its panel')
  return panel
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
await import(`${pathToFileURL(clientPath).href}?session-collapse=${Date.now()}`)

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

test('task cards and step cards start collapsed and keep name, done/total and status in the summary', () => {
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)
  const tree = instance.tree

  const sessions = collapses(tree, 'dsh-wp-session-collapse')
  assert.equal(sessions.length, 2, 'one task card per active plan')
  for (const root of sessions) {
    assert.equal(root.props['data-open'], 'false', 'task card must default to collapsed')
    const button = toggleOf(root)
    assert.equal(button.props['aria-expanded'], false)
    assert.equal(panelOf(root).props.hidden, true, 'collapsed task panel must be hidden')
  }

  const firstSummary = textOf(toggleOf(sessions[0]))
  assert.ok(firstSummary.includes('单句说明 1+1=2'), 'summary keeps the task name')
  assert.ok(firstSummary.includes('本计划 1/1 做好了'), 'summary keeps done/total')
  // v1.5.0: the old one-line meta (`0 卡住了`) became the chart legend `卡住了 0`
  // plus the four-segment bar; the blocked count must still be visible.
  assert.ok(firstSummary.includes('卡住了 0'), 'summary keeps the blocked count in the legend')
  assert.ok(firstSummary.includes('100%'), 'the rate is visible as a number, not hidden in a title attribute')
  assert.ok(firstSummary.includes('已完成'), 'summary keeps the task status')
  const secondSummary = textOf(toggleOf(sessions[1]))
  assert.ok(secondSummary.includes('检查 dsh-workplan README'))
  assert.ok(secondSummary.includes('本计划 3/3 做好了'))

  const stages = collapses(tree, 'dsh-wp-stage-collapse')
  assert.equal(stages.length, 2, 'one step card per stage')
  for (const root of stages) {
    assert.equal(root.props['data-open'], 'false', 'step cards must default to collapsed')
    assert.equal(panelOf(root).props.hidden, true)
  }
  const firstStageSummary = textOf(toggleOf(stages[0]))
  assert.ok(firstStageSummary.includes('第 1 步：直接回答'), 'step summary keeps the step name')
  assert.ok(firstStageSummary.includes('1/1 做好了'), 'step summary keeps done/total')
  assert.ok(firstStageSummary.includes('都做完了'), 'step summary keeps the step status')
})

test('expanding a task reveals collapsed step summaries, and expanding a step reveals its details', () => {
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)

  let sessions = collapses(instance.tree, 'dsh-wp-session-collapse')
  const event = click(toggleOf(sessions[0]))
  assert.equal(event.stops, 1, 'task summary click must not bubble to the card')

  sessions = collapses(instance.tree, 'dsh-wp-session-collapse')
  assert.equal(sessions[0].props['data-open'], 'true')
  assert.equal(toggleOf(sessions[0]).props['aria-expanded'], true)
  assert.equal(panelOf(sessions[0]).props.hidden, false, 'expanded task panel must be visible')

  const taskPanel = panelOf(sessions[0])
  const stagesInTask = collapses(taskPanel, 'dsh-wp-stage-collapse')
  assert.equal(stagesInTask.length, 1)
  assert.equal(stagesInTask[0].props['data-open'], 'false', 'steps stay collapsed after the task expands')
  assert.equal(panelOf(stagesInTask[0]).props.hidden, true)

  click(toggleOf(stagesInTask[0]))
  const stageAfter = collapses(collapses(instance.tree, 'dsh-wp-session-collapse')[0], 'dsh-wp-stage-collapse')[0]
  assert.equal(stageAfter.props['data-open'], 'true')
  assert.equal(panelOf(stageAfter).props.hidden, false, 'expanded step panel must be visible')
  const detail = textOf(panelOf(stageAfter))
  assert.ok(detail.includes('具体工作 1：计算 1+1'), 'expanded step shows the work detail')
  assert.ok(detail.includes('怎么做'), 'expanded step keeps the method section')

  // Collapsing again hides the same panel and keeps every summary intact.
  click(toggleOf(stageAfter))
  const collapsedAgain = collapses(collapses(instance.tree, 'dsh-wp-session-collapse')[0], 'dsh-wp-stage-collapse')[0]
  assert.equal(collapsedAgain.props['data-open'], 'false')
  assert.equal(panelOf(collapsedAgain).props.hidden, true)
})

test('the aggregate numbers stay identical before and after expanding', () => {
  const harness = createHarness(stateFixture)
  const { instance } = mountDashboard(harness)

  function statRows(tree: any) {
    const stats = findAll(tree, (node: any) => hasClass(node, 'dsh-wp-stat'))
    return stats.map((stat: any) => ({
      value: textOf(find(stat, (node: any) => hasClass(node, 'dsh-wp-stat-value'))),
      label: textOf(find(stat, (node: any) => hasClass(node, 'dsh-wp-stat-label'))),
    }))
  }

  function headerText(tree: any) {
    return textOf(tree)
  }

  const before = statRows(instance.tree)
  assert.deepEqual(before, [
    { value: '2', label: '个任务' },
    { value: '4', label: '分配工作' },
    { value: '4', label: '做好了' },
    { value: '0', label: '正在做' },
    { value: '0', label: '卡住了' },
  ], 'aggregate must be 2 tasks / 4 work items / 4 done / 0 blocked')
  assert.ok(headerText(instance.tree).includes('2 个任务，拆成 4 件具体工作'))

  click(toggleOf(collapses(instance.tree, 'dsh-wp-session-collapse')[0]))
  assert.deepEqual(statRows(instance.tree), before, 'expanding a task must not change the aggregate')
  assert.ok(headerText(instance.tree).includes('2 个任务，拆成 4 件具体工作'))

  // Now that the task card is expanded, open the first step card inside it.
  const openTask = collapses(instance.tree, 'dsh-wp-session-collapse')[0]
  click(toggleOf(collapses(panelOf(openTask), 'dsh-wp-stage-collapse')[0]))
  assert.deepEqual(statRows(instance.tree), before, 'expanding a step must not change the aggregate')
  assert.ok(headerText(instance.tree).includes('2 个任务，拆成 4 件具体工作'))
  assert.ok(headerText(instance.tree).includes('2 个任务，拆成 4 件具体工作'))

  // Per-card summaries keep their own plan-scoped counts.
  const summaries = collapses(instance.tree, 'dsh-wp-session-collapse').map((root: any) => textOf(toggleOf(root)))
  assert.ok(summaries[0].includes('本计划 1/1 做好了'))
  assert.ok(summaries[1].includes('本计划 3/3 做好了'))
})
