import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const sessionFixture = {
  sessionId: 's1',
  title: 'TypeScript 使用范围核验',
  phase: 'pending',
  stats: { total: 3, done: 0, blocked: 0, inProgress: 0, pending: 3, progress: 0 },
  departments: [
    { id: 'engineering', done: 0, total: 2, blocked: 0 },
    { id: 'qa', done: 0, total: 1, blocked: 0 },
  ],
  taskUnderstanding: { deliverable: '一份基于证据的核验结果' },
  contradictions: {
    primary: { statement: '范围与证据不一致', evidence: [], whyPrimary: '决定结论' },
    secondary: [],
    transformationConditions: [],
  },
  stages: [{
    id: 'S1', name: '盘点', goal: '确认范围', checkpoint: '核对清单',
    subtasks: [
      { id: 'T1', title: '列出文件', department: 'engineering', role: '工程师', objective: '列出源码', method: ['扫描目录'], inputs: [], outputs: ['清单'], dependsOn: [], acceptance: ['清单完整'], risk: '遗漏' },
      { id: 'T2', title: '核对类型', department: 'engineering', role: '工程师', objective: '核对类型', method: ['检查'], inputs: ['清单'], outputs: ['结论'], dependsOn: ['T1'], acceptance: ['结论有证据'], risk: '误判' },
      { id: 'T3', title: '复核', department: 'qa', role: '测试', objective: '复核', method: ['抽查'], inputs: ['结论'], outputs: ['复核记录'], dependsOn: ['T2'], acceptance: ['无遗漏'], risk: '抽样不足' },
    ],
  }],
  statuses: [
    { subtaskId: 'T1', status: 'pending' },
    { subtaskId: 'T2', status: 'pending' },
    { subtaskId: 'T3', status: 'pending' },
  ],
  risks: [],
  verification: [],
  practiceLoop: null,
  errors: [],
  updatedAt: Date.now(),
}

const stateFixture = {
  loading: false,
  sessions: [
    sessionFixture,
    {
      ...sessionFixture,
      sessionId: 's2',
      title: '已取消的旧计划',
      phase: 'cancelled',
      stats: { total: 13, done: 0, blocked: 0, inProgress: 0, pending: 13, progress: 0 },
      statuses: [],
      stages: [],
      departments: [],
      errors: ['计划已取消：上一轮未派发'],
    },
  ],
  error: null,
  updatedAt: Date.now(),
}

test('dashboard fixture renders plain labels and no raw locale keys', async () => {
  let loaded: any = null
  ;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  let firstState = true
  class Component {
    props: any
    constructor(props: any) { this.props = props }
    render() { return this.props?.children ?? null }
  }
  const ReactStub: any = {
    Component,
    createElement: (type: any, props: any, ...children: any[]) => {
      const next = { ...(props || {}) }
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next, children }
    },
    useState: (init: any) => {
      if (firstState) { firstState = false; return [stateFixture, () => {}] }
      return [init, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
  }
  function render(node: any): string {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node.type === 'function') {
      const isClass = node.type.prototype && node.type.prototype.render
      if (isClass) return render(new node.type(node.props).render())
      return render(node.type(node.props))
    }
    const tag = String(node.type)
    let attrs = ''
    if (tag === 'button' || tag === 'article') {
      const props = node.props || {}
      if (props.className) attrs += ` class="${String(props.className)}"`
      if (props.id) attrs += ` id="${String(props.id)}"`
      if (props['aria-label']) attrs += ` aria-label="${String(props['aria-label'])}"`
    }
    return `<${tag}${attrs}>${(node.children || []).map(render).join('')}</${tag}>`
  }

  const clientPath = path.resolve(process.cwd(), 'client.js')
  await import(`${pathToFileURL(clientPath).href}?render=${Date.now()}`)
  const mod = loaded.factory(() => ReactStub)
  const locales: any = {}
  let mainComponent: any = null
  const t = (key: string) => locales.zh?.[key] ?? key
  const ctx: any = {
    effect(fn: any) { return fn() },
    locale: {
      register(_ns: string, lang: string, obj: any) { locales[lang] = obj; return () => {} },
      bind() { return t },
    },
    slots: {
      inject(_name: string, fn: any) { fn() },
      register(spec: any, component: any) { if (spec.name === 'main') mainComponent = component; return () => {} },
    },
  }
  mod.apply(ctx)
  assert.ok(mainComponent, 'main panel component must be registered')
  const html = render(ReactStub.createElement(mainComponent, { t }))
  assert.ok(html.length > 1000, 'dashboard should render content')
  for (const bad of ['stats.', 'phase.', 'undefined', '[object Object]']) {
    assert.equal(html.includes(bad), false, `dashboard must not render ${bad}`)
  }
  assert.ok(html.includes('1 个任务，拆成 3 件具体工作'))
  assert.equal(html.includes('2 个任务'), false, 'cancelled plans must not inflate the aggregate count')
  assert.equal(html.includes('16 件具体工作'), false, 'cancelled plans must not inflate aggregate work items')
  assert.equal(html.includes('已取消'), false, 'cancelled plan cards should not be rendered')
  assert.ok(html.includes('当前各会话最新计划汇总'))
  assert.ok(html.includes('本计划'))
  assert.ok(html.includes('当前各会话最新计划的合计'))
  assert.ok(html.includes('<div>1</div><div>个任务</div>'), 'circled stat area must include the task count cell')
  assert.ok(html.includes('状态分布'), 'dashboard must render the status chart')
  assert.ok(html.includes('每个任务的进度'), 'dashboard must render per-task progress bars')
  assert.ok(html.includes('<svg>'), 'dashboard must render an SVG chart')
  assert.ok(html.includes('个任务'), 'task count label must be visible')
  assert.ok(html.includes('分配工作'))
  assert.ok(html.includes('做好了'))
  assert.ok(html.includes('卡住了'))
  assert.ok(html.includes('第 1 步'))
  assert.ok(html.includes('具体工作 1'))
  assert.ok(html.includes('dsh-wp-bar-button'), 'each task bar must be a clickable button')
  assert.ok(html.includes('跳转到任务明细'), 'task bar button must have a jump aria-label')
  assert.ok(html.includes('dsh-wp-session-'), 'task cards must expose a stable DOM anchor id')
})
