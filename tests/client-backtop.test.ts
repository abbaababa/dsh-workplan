/**
 * [T5] 「回到顶部」按钮的行为测试。
 *
 * 测试环境（T3 结论）：本仓库没有 jsdom / happy-dom，也不允许新增测试依赖。
 * 所以不挂真实 DOM，而是用「微型 React 运行时」直接调用 client.js 里注册的
 * Dashboard 函数组件：useState/useEffect/useCallback/useMemo 按位置保存真实状态
 * 与依赖（依赖变化才重跑 effect，卸载执行 cleanup）；面板根节点用一个假滚动容器
 * 替代（scrollTop / addEventListener / removeEventListener / scrollTo / closest）；
 * 每次 commit 后回填根节点的 ref。
 * 因此断言读的都是产品代码真实产出的结果（data-visible、传给 scrollTo 的参数、
 * 注册/移除的监听器），不是对源码文本做恒真检查。唯一的文本断言在最后一组：
 * CSS 定位无法在 node 里由布局引擎验证，只能静态比对，并已标注强度上限。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
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

const LOADED_STATE = {
  loading: false,
  sessions: [sessionFixture],
  error: null,
  updatedAt: Date.now(),
}

function createPanel() {
  const listeners = new Map<string, Set<(event?: any) => void>>()
  const added: Array<{ type: string; fn: any; opts: any }> = []
  const removed: Array<{ type: string; fn: any }> = []
  const scrollToCalls: any[] = []
  const closestCalls: string[] = []
  const scrollTopAssignments: number[] = []
  let currentScrollTop = 0

  const panel: any = {}
  Object.defineProperty(panel, 'scrollTop', {
    get: () => currentScrollTop,
    set: (value: number) => { scrollTopAssignments.push(value); currentScrollTop = value },
    enumerable: true,
  })
  panel.scrollTo = (opts: any) => { scrollToCalls.push(opts) }
  panel.addEventListener = (type: string, fn: any, opts?: any) => {
    added.push({ type, fn, opts })
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(fn)
  }
  panel.removeEventListener = (type: string, fn: any) => {
    removed.push({ type, fn })
    listeners.get(type)?.delete(fn)
  }
  panel.closest = (selector: string) => { closestCalls.push(selector); return panel }
  // 仅测试用：模拟浏览器派发 scroll 事件
  panel.dispatch = (type: string) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn({ type })
  }
  panel.listenerCount = (type: string) => listeners.get(type)?.size ?? 0
  panel.added = added
  panel.removed = removed
  panel.scrollToCalls = scrollToCalls
  panel.closestCalls = closestCalls
  panel.scrollTopAssignments = scrollTopAssignments
  return panel
}

function sameDeps(a: any[] | undefined, b: any[] | undefined) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

function createRuntime(dashboard: any, t: (key: string) => string, panel: any, options: { attachRefs?: boolean } = {}) {
  const attachRefs = options.attachRefs !== false
  const slots: any[] = []
  let cursor = 0
  let dirty = false
  let pending: number[] = []
  let tree: any = null

  const setState = (index: number, next: any) => {
    const slot = slots[index]
    const value = typeof next === 'function' ? next(slot.value) : next
    if (!Object.is(value, slot.value)) {
      slot.value = value
      dirty = true
    }
  }

  const hooks = {
    useState(init: any) {
      const index = cursor++
      let slot = slots[index]
      if (!slot) {
        slot = { kind: 'state', value: typeof init === 'function' ? init() : init }
        slots[index] = slot
      }
      assert.equal(slot.kind, 'state', `hook #${index} 被跨渲染换成了 ${slot.kind}`)
      return [slot.value, (next: any) => setState(index, next)]
    },
    useCallback(fn: any, deps: any[]) {
      const index = cursor++
      let slot = slots[index]
      if (!slot) {
        slot = { kind: 'callback', value: fn, deps }
        slots[index] = slot
        return slot.value
      }
      assert.equal(slot.kind, 'callback', `hook #${index} 被跨渲染换成了 ${slot.kind}`)
      if (!sameDeps(slot.deps, deps)) {
        slot.value = fn
        slot.deps = deps
      }
      return slot.value
    },
    useMemo(fn: any, deps: any[]) {
      const index = cursor++
      let slot = slots[index]
      if (!slot) {
        slot = { kind: 'memo', value: fn(), deps }
        slots[index] = slot
        return slot.value
      }
      assert.equal(slot.kind, 'memo', `hook #${index} 被跨渲染换成了 ${slot.kind}`)
      if (!sameDeps(slot.deps, deps)) {
        slot.value = fn()
        slot.deps = deps
      }
      return slot.value
    },
    useEffect(fn: any, deps: any[]) {
      const index = cursor++
      let slot = slots[index]
      if (!slot) {
        slot = { kind: 'effect', hasRun: false }
        slots[index] = slot
      }
      assert.equal(slot.kind, 'effect', `hook #${index} 被跨渲染换成了 ${slot.kind}`)
      if (!slot.hasRun || !sameDeps(slot.deps, deps)) {
        slot.fn = fn
        slot.deps = deps
        pending.push(index)
      }
    },
  }

  const commit = () => {
    cursor = 0
    pending = []
    tree = dashboard({ t })
    // React 在 commit 阶段回填 ref，然后才跑 effect。
    if (attachRefs) {
      const ref = tree && tree.props && tree.props.ref
      if (typeof ref === 'function') ref(panel)
    }
    for (const index of pending) {
      const slot = slots[index]
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = slot.fn()
      slot.hasRun = true
    }
    pending = []
  }

  const flush = () => {
    let guard = 0
    do {
      dirty = false
      commit()
    } while (dirty && guard++ < 25)
    if (dirty) throw new Error('渲染循环未收敛：effect 一直在改状态')
  }

  const unmount = () => {
    for (const slot of slots) {
      if (slot.kind === 'effect' && typeof slot.cleanup === 'function') {
        slot.cleanup()
        slot.cleanup = undefined
      }
    }
  }

  return {
    hooks,
    flush,
    unmount,
    tree: () => tree,
    /** 测试专用：把第 index 个 state 槽直接置为「已加载」状态，跳过真实 fetch 往返。 */
    seedState(index: number, value: any) {
      const slot = slots[index]
      assert.ok(slot, `state 槽 #${index} 不存在`)
      assert.equal(slot.kind, 'state')
      slot.value = value
    },
  }
}

const MOTION = { reduced: false }

async function loadClientModule(ReactStub: any) {
  let loaded: any = null
  const windowStub: any = {
    __ModuleLoader__: { load: (spec: any) => { loaded = spec } },
    __added: [] as string[],
    addEventListener(type: string) { windowStub.__added.push(type) },
    matchMedia: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? MOTION.reduced : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  }
  ;(globalThis as any).window = windowStub
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  const clientPath = path.resolve(process.cwd(), 'client.js')
  const specifier = `${pathToFileURL(clientPath).href}?backtop=${Date.now()}-${Math.random()}`
  await import(specifier)
  assert.ok(loaded, 'client.js 必须通过 window.__ModuleLoader__.load 自注册')
  return loaded.factory(() => ReactStub)
}

async function mountPanel(lang: 'zh' | 'en' = 'zh', options: { attachRefs?: boolean; scrollTop?: number } = {}) {
  const panel = createPanel()
  panel.scrollTop = options.scrollTop ?? 0

  // usePlans 的轮询 effect 会调 fetch / setInterval；这里给永不返回的 fetch 和
  // 假定时器，让测试不依赖网络也不留下真定时器。
  const realFetch = (globalThis as any).fetch
  const realSetInterval = (globalThis as any).setInterval
  const realClearInterval = (globalThis as any).clearInterval
  ;(globalThis as any).fetch = () => new Promise(() => {})
  ;(globalThis as any).setInterval = () => 0
  ;(globalThis as any).clearInterval = () => {}

  try {
    const state: any = { runtime: null }
    // 错误边界是 class 组件，client.js 的 factory 一执行就需要 React.Component。
    class Component {
      props: any
      state: any
      constructor(props: any) { this.props = props; this.state = {} }
      setState(next: any) {
        this.state = { ...(this.state || {}), ...(typeof next === 'function' ? next(this.state) : next) }
      }
    }
    const ReactStub: any = {
      Component,
      createElement(type: any, props: any = {}, ...children: any[]) {
        return { type, props: { ...(props || {}) }, children }
      },
      useState(init: any) { return state.runtime.hooks.useState(init) },
      useEffect(fn: any, deps: any[]) { return state.runtime.hooks.useEffect(fn, deps) },
      useCallback(fn: any, deps: any[]) { return state.runtime.hooks.useCallback(fn, deps) },
      useMemo(fn: any, deps: any[]) { return state.runtime.hooks.useMemo(fn, deps) },
    }

    const mod = await loadClientModule(ReactStub)
    const locales: any = {}
    let mainComponent: any = null
    const ctx: any = {
      effect(fn: any) { return fn() },
      locale: {
        register(_ns: string, code: string, dict: any) { locales[code] = dict; return () => {} },
        bind() { return (key: string) => locales[lang]?.[key] ?? key },
      },
      slots: {
        inject(_name: string, fn: any) { fn() },
        register(spec: any, component: any) {
          if (spec.name === 'main') mainComponent = component
          return () => {}
        },
      },
    }
    mod.apply(ctx)
    assert.ok(mainComponent, 'main 面板组件必须注册')

    const t = (key: string) => locales[lang]?.[key] ?? key
    // 主面板被 guard() 包在错误边界里：Boundary > Dashboard。
    const guarded = mainComponent({ t })
    assert.equal(typeof guarded.type, 'function', '主面板必须先渲染错误边界')
    const inner = guarded.children[0]
    assert.equal(typeof inner.type, 'function', '错误边界内必须是 Dashboard 组件')
    const dashboard = inner.type

    const runtime = createRuntime(dashboard, t, panel, { attachRefs: options.attachRefs })
    state.runtime = runtime
    runtime.flush()
    runtime.seedState(0, LOADED_STATE)
    runtime.flush()

    return { panel, runtime, t, locales, mainComponent }
  } finally {
    ;(globalThis as any).fetch = realFetch
    ;(globalThis as any).setInterval = realSetInterval
    ;(globalThis as any).clearInterval = realClearInterval
  }
}

/** 取「回到顶部」按钮节点，并断言它确实是 .dsh-wp 的最后一个直接子元素。 */
function backTopButton(runtime: any) {
  const root = runtime.tree()
  assert.equal(root.type, 'div', '面板根节点必须是 div')
  assert.equal(root.props.className, 'dsh-wp', '面板根节点必须是 .dsh-wp（唯一 overflow 容器）')
  const children: any[] = root.children ?? []
  const last = children[children.length - 1]
  assert.ok(last, '面板根节点必须有子元素')
  assert.equal(last.type, 'button', '「回到顶部」必须是根节点的最后一个直接子元素')
  assert.equal(String(last.props.className), 'dsh-wp-backtop')
  return last
}

function visibleAttr(runtime: any) {
  return backTopButton(runtime).props['data-visible']
}

test('回到顶部按钮：原生 button、贴右定位类名、中文无障碍名，初始不显示', async () => {
  const { runtime } = await mountPanel()
  const button = backTopButton(runtime)

  assert.equal(button.type, 'button', '必须是原生 button（键盘可达）')
  assert.equal(button.props.type, 'button', '必须显式声明 type="button"（避免表单提交语义）')
  assert.equal(button.props['aria-label'], '回到顶部', 'aria-label 必须用 zh 文案')
  assert.equal(button.props.title, '回到顶部', 'title 必须用 zh 文案')
  assert.equal(button.props['data-visible'], 'false', 'scrollTop=0 时初始必须隐藏')
  // 图标层必须对读屏隐藏，否则箭头会被念出来。
  const icon = button.children[0]
  assert.equal(icon.props['aria-hidden'], 'true', '箭头图标必须 aria-hidden')
  assert.equal(icon.children[0], '↑')
})

test('回到顶部按钮：阈值严格大于 200px（200 隐藏 / 201 显示 / 回到 0 再隐藏）', async () => {
  const { panel, runtime } = await mountPanel()

  panel.scrollTop = 200
  panel.dispatch('scroll')
  runtime.flush()
  assert.equal(visibleAttr(runtime), 'false', 'scrollTop=200 必须仍然隐藏（阈值是严格大于）')

  panel.scrollTop = 201
  panel.dispatch('scroll')
  runtime.flush()
  assert.equal(visibleAttr(runtime), 'true', 'scrollTop=201 必须显示')

  panel.scrollTop = 0
  panel.dispatch('scroll')
  runtime.flush()
  assert.equal(visibleAttr(runtime), 'false', '滚回顶部后必须隐藏')
})

test('回到顶部按钮：刷新时已停在半路也能立刻显示（effect 内先求一次初值）', async () => {
  const { runtime } = await mountPanel('zh', { scrollTop: 640 })
  assert.equal(visibleAttr(runtime), 'true', '挂载时 scrollTop 已超过阈值，按钮必须直接可见')
})

test('回到顶部按钮：点击以 top:0 / smooth 调用滚动容器的 scrollTo', async () => {
  const { panel, runtime } = await mountPanel()
  panel.scrollTop = 480
  panel.dispatch('scroll')
  runtime.flush()

  const button = backTopButton(runtime)
  button.props.onClick({ currentTarget: null })

  assert.equal(panel.scrollToCalls.length, 1, '点击必须恰好调用一次 scrollTo')
  assert.deepEqual(panel.scrollToCalls[0], { top: 0, behavior: 'smooth' }, '必须滚到 top:0，且用平滑滚动')
})

test('回到顶部按钮：prefers-reduced-motion 时改用 behavior:auto', async () => {
  MOTION.reduced = true
  try {
    const { panel, runtime } = await mountPanel()
    panel.scrollTop = 400
    panel.dispatch('scroll')
    runtime.flush()

    backTopButton(runtime).props.onClick({ currentTarget: null })
    assert.deepEqual(panel.scrollToCalls[0], { top: 0, behavior: 'auto' }, '减少动效时必须瞬时跳转')
  } finally {
    MOTION.reduced = false
  }
})

test('回到顶部按钮：宿主 scrollTo 抛错时回退到直接赋值 scrollTop = 0', async () => {
  const { panel, runtime } = await mountPanel()
  panel.scrollTop = 500
  panel.dispatch('scroll')
  runtime.flush()
  panel.scrollTo = () => { throw new Error('scrollTo(options) 不被支持') }

  backTopButton(runtime).props.onClick({ currentTarget: null })
  assert.equal(panel.scrollTop, 0, 'scrollTo 失败后必须仍把内容滚回顶部')
  assert.ok(panel.scrollTopAssignments.includes(0), '回退路径必须是 scrollTop=0 赋值')
})

test('回到顶部按钮：ref 未回填时从事件目标向上找 .dsh-wp 兜底', async () => {
  const { panel, runtime } = await mountPanel('zh', { attachRefs: false })
  assert.equal(panel.listenerCount('scroll'), 0, 'ref 未回填时不应绑定 scroll 监听')

  const button = backTopButton(runtime)
  button.props.onClick({ currentTarget: { closest: (selector: string) => panel.closest(selector) } })

  assert.deepEqual(panel.closestCalls, ['.dsh-wp'], '兜底必须查找 .dsh-wp 这个容器')
  assert.deepEqual(panel.scrollToCalls[0], { top: 0, behavior: 'smooth' }, '兜底路径也必须真的滚动')
})

test('回到顶部按钮：只监听面板容器的 scroll（passive），卸载时移除同一个处理器', async () => {
  const { panel, runtime } = await mountPanel()

  // 数据从「加载中」变成「已加载」时 activeSessions.length 变化，effect 允许重订阅，
  // 但任一时刻只能有一个生效的 scroll 监听。
  assert.equal(panel.listenerCount('scroll'), 1, '任一时刻只能有一个生效的 scroll 监听')
  assert.ok(panel.added.length >= 1, '必须注册过 scroll 监听')
  for (const entry of panel.added) {
    assert.equal(entry.type, 'scroll', '只能监听 scroll')
    assert.deepEqual(entry.opts, { passive: true }, '滚动监听必须是 passive（不阻塞滚动）')
  }
  assert.equal(new Set(panel.added.map((entry: any) => entry.fn)).size, panel.added.length, '不得重复注册同一个处理器')
  assert.equal(panel.removed.length, panel.added.length - 1, '每次重订阅都要先解绑旧监听，不能泄漏')
  assert.equal((globalThis as any).window.__added?.length ?? 0, 0, '不得把监听绑到 window 上')

  const lastHandler = panel.added[panel.added.length - 1].fn
  runtime.unmount()

  assert.equal(panel.listenerCount('scroll'), 0, '卸载后监听必须被移除')
  assert.equal(panel.removed[panel.removed.length - 1].fn, lastHandler, '移除的必须是注册时的同一个函数引用')

  // 卸载后再派发事件不应再触碰状态（监听已解绑）。
  panel.scrollTop = 900
  panel.dispatch('scroll')
  runtime.flush()
  assert.equal(visibleAttr(runtime), 'false', '卸载后 scroll 事件必须不再更新按钮状态')
})

test('回到顶部按钮：英文环境使用 Back to top 文案', async () => {
  const { runtime } = await mountPanel('en')
  const button = backTopButton(runtime)
  assert.equal(button.props['aria-label'], 'Back to top')
  assert.equal(button.props.title, 'Back to top')
})

test('静态断言：CSS 定位与滚动容器（node 无布局引擎，只能比文本，强度上限在此）', async () => {
  const source = readFileSync(path.resolve(process.cwd(), 'client.js'), 'utf8')

  const backTopRule = /\.dsh-wp-backtop\s*\{([^}]*)\}/.exec(source)
  assert.ok(backTopRule, 'client.js 必须包含 .dsh-wp-backtop 样式规则')
  const backTopCss = backTopRule![1]
  assert.match(backTopCss, /position:\s*sticky/, '必须 sticky 在面板视口内，不能 fixed/absolute')
  assert.match(backTopCss, /bottom:\s*16px/, '必须距视口底部 16px')
  assert.match(backTopCss, /margin:\s*12px 0 0 auto/, '必须靠右（auto 左外边距）')
  assert.match(backTopCss, /visibility:\s*hidden/, '必须始终挂载、用 visibility 藏显')
  assert.doesNotMatch(backTopCss, /position:\s*(fixed|absolute)/, '禁止 fixed（钉浏览器视口）或 absolute（随内容滚走）')

  assert.match(source, /\.dsh-wp-backtop\[data-visible="true"\][^{]*\{[^}]*visibility:\s*visible/, 'data-visible=true 必须切到可见')

  const panelRule = /\.dsh-wp\s*\{([^}]*)\}/.exec(source)
  assert.ok(panelRule, 'client.js 必须包含 .dsh-wp 样式规则')
  assert.match(panelRule![1], /overflow-y:\s*auto/, '.dsh-wp 必须仍是纵向滚动容器（滚动逻辑绑定它）')
})
