/**
 * [复审修复] 看板轮询的三项回归测试：
 *  1. 单次轮询 15s 超时：挂死的 fetch 不能让 entry.running 永真（冻结看板），
 *     超时必须走错误路径（console.warn + 写入 error 状态），interval 下一轮照常。
 *  2. document.visibilityState === 'hidden' 时跳过本轮轮询；visibilitychange
 *     回到 visible 立即补一轮；卸载时移除监听。
 *  3. fetchPlans 不再丢弃服务端裁剪标志：truncated / omittedSessions /
 *     omittedDetail（含挂在 session 项上的 omittedDetail）任一成立时，
 *     Dashboard 顶部渲染 trimNotice 提示条；载荷完整时不得渲染。
 *
 * 测试环境与 client-backtop.test.ts 相同：无 jsdom，用微型 React 运行时直接驱动
 * client.js 里真实注册的 Dashboard 组件；fetch / setInterval / setTimeout /
 * document.visibilityState 全部用可控假实现，断言读的是产品代码真实产出的树。
 */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const sessionFixture = {
  sessionId: 's1',
  title: '轮询修复验证',
  phase: 'executing',
  stats: { total: 2, done: 1, blocked: 0, inProgress: 1, pending: 0, progress: 50 },
  departments: [{ id: 'engineering', done: 1, total: 2, blocked: 0 }],
  statuses: [
    { subtaskId: 'T1', status: 'done', finishedAt: Date.now() },
    { subtaskId: 'T2', status: 'in-progress' },
  ],
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

function jsonResponse(payload: any) {
  return { ok: true, json: async () => payload }
}

/** 浏览器行为的最小仿真：signal 中止时 reject（生产代码依赖这一点结束挂死请求）。 */
function hangingFetch() {
  return (_url: string, opts: any) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener?.('abort', () => {
      reject(new Error('This operation was aborted'))
    })
  })
}

function sameDeps(a: any[] | undefined, b: any[] | undefined) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * 微型 React 运行时（与 client-backtop.test.ts 同思路）：按 hook 位置保存
 * 真实状态；render() 由外部提供，flushEffects() 渲染并跑待执行的 effect，
 * effect 同步 setState 会触发新一轮渲染，直到收敛。
 */
function createRuntime(dashboard: any, t: (key: string) => string, render: () => any) {
  const slots: any[] = []
  let cursor = 0
  let pending: number[] = []
  let tree: any = null
  let dirty = false

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

  const flushEffects = () => {
    let guard = 0
    // do-while：首次 render 之前 pending 必为空，必须先渲染一轮，
    // effect 才有机会在渲染过程中登记进 pending 并随后执行。
    do {
      dirty = false
      cursor = 0
      tree = render()
      const batch = pending
      pending = []
      for (const index of batch) {
        const slot = slots[index]
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = slot.fn()
        slot.hasRun = true
      }
    } while ((dirty || pending.length > 0) && guard++ < 25)
    if (dirty || pending.length > 0) throw new Error('渲染循环未收敛：effect 一直在改状态')
  }

  return {
    hooks,
    t,
    tree: () => tree,
    flushEffects,
    unmount: () => {
      for (const slot of slots) {
        if (slot.kind === 'effect' && typeof slot.cleanup === 'function') {
          slot.cleanup()
          slot.cleanup = undefined
        }
      }
    },
  }
}

async function tick(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** 深度优先找第一个满足断言的节点。 */
function findNode(node: any, pred: (n: any) => boolean): any {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findNode(item, pred)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object' && pred(node)) return node
  if (node && typeof node === 'object' && Array.isArray(node.children)) {
    return findNode(node.children, pred)
  }
  return null
}

function classContains(fragment: string) {
  return (node: any) => typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes(fragment)
}

type HarnessOptions = {
  lang?: 'zh' | 'en'
  fetchImpl?: (url: string, opts: any) => Promise<any>
  visibility?: 'visible' | 'hidden'
  /** 仿真旧宿主：强制生产代码走 setTimeout 手动控制器兜底路径。 */
  disableAbortSignalAny?: boolean
}

/*
 * 注意：全局桩（fetch / document / 计时器 / AbortSignal 静态方法）必须在整个
 * 测试期间保持安装——轮询是异步的，测试触发的后续交互（interval、
 * visibilitychange、超时触发、unmount 清理）都会再走到这些全局对象。
 * 用 t.after() 兜底恢复，保证断言失败也能还原。
 */
async function mount(t: TestContext, options: HarnessOptions = {}) {
  const lang = options.lang ?? 'zh'
  const fetchCalls: Array<{ url: string; opts: any }> = []
  const defaultFetch = (_url: string, _opts: any) => Promise.resolve(
    jsonResponse({ ok: true, sessions: [sessionFixture] }),
  )
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const wrappedFetch = (url: string, opts: any) => {
    fetchCalls.push({ url, opts })
    return fetchImpl(url, opts)
  }

  let intervalCb: (() => void) | null = null
  const timeoutCbs = new Map<number, () => void>()
  let nextTimeoutId = 1
  const docListeners = new Map<string, Set<(event?: any) => void>>()
  const docAdded: Array<{ type: string; fn: any }> = []
  const docRemoved: Array<{ type: string; fn: any }> = []

  // 捕获生产代码的 AbortSignal.timeout(ms) 信号，测试手动触发，避免真实等 15s。
  const timeoutSignals: Array<{ ms: number; controller: AbortController }> = []
  const patchAbortSignal = () => {
    if (options.disableAbortSignalAny) {
      ;(AbortSignal as any).any = undefined
      return
    }
    ;(AbortSignal as any).timeout = (ms: number) => {
      const controller = new AbortController()
      timeoutSignals.push({ ms, controller })
      return controller.signal
    }
    ;(AbortSignal as any).any = (signals: AbortSignal[]) => {
      const combined = new AbortController()
      for (const signal of signals) {
        if (signal.aborted) { combined.abort(); break }
        signal.addEventListener('abort', () => combined.abort(), { once: true })
      }
      return combined.signal
    }
  }
  const restoreAbortSignal = () => {
    ;(AbortSignal as any).any = realAbortAny
    ;(AbortSignal as any).timeout = realAbortTimeout
  }

  const documentStub: any = {
    visibilityState: options.visibility ?? 'visible',
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener(type: string, fn: any) {
      docAdded.push({ type, fn })
      if (!docListeners.has(type)) docListeners.set(type, new Set())
      docListeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: any) {
      docRemoved.push({ type, fn })
      docListeners.get(type)?.delete(fn)
    },
    dispatch(type: string) {
      for (const fn of [...(docListeners.get(type) ?? [])]) fn({ type })
    },
  }

  const loaded: any = { spec: null }
  const windowStub: any = {
    __ModuleLoader__: { load: (spec: any) => { loaded.spec = spec } },
    addEventListener() {},
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  }

  const realFetch = (globalThis as any).fetch
  const realSetInterval = (globalThis as any).setInterval
  const realClearInterval = (globalThis as any).clearInterval
  const realSetTimeout = (globalThis as any).setTimeout
  const realClearTimeout = (globalThis as any).clearTimeout
  const realDocument = (globalThis as any).document
  const realWindow = (globalThis as any).window
  const realWarn = console.warn
  const realAbortAny = (AbortSignal as any).any
  const realAbortTimeout = (AbortSignal as any).timeout
  const warnings: any[] = []
  console.warn = (...args: any[]) => { warnings.push(args) }

  ;(globalThis as any).window = windowStub
  ;(globalThis as any).document = documentStub
  ;(globalThis as any).fetch = wrappedFetch
  ;(globalThis as any).setInterval = (cb: () => void) => { intervalCb = cb; return 1 }
  ;(globalThis as any).clearInterval = () => {}
  ;(globalThis as any).setTimeout = (cb: () => void, ms: number) => {
    const id = nextTimeoutId++
    timeoutCbs.set(id, cb)
    return { id, ms }
  }
  ;(globalThis as any).clearTimeout = (handle: any) => {
    timeoutCbs.delete(typeof handle === 'object' ? handle?.id : handle)
  }
  patchAbortSignal()

  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    restoreAbortSignal()
    ;(globalThis as any).fetch = realFetch
    ;(globalThis as any).setInterval = realSetInterval
    ;(globalThis as any).clearInterval = realClearInterval
    ;(globalThis as any).setTimeout = realSetTimeout
    ;(globalThis as any).clearTimeout = realClearTimeout
    ;(globalThis as any).document = realDocument
    ;(globalThis as any).window = realWindow
    console.warn = realWarn
  }
  t.after(restore)

  try {
    const clientPath = path.resolve(process.cwd(), 'client.js')
    const specifier = `${pathToFileURL(clientPath).href}?planpoll=${Date.now()}-${Math.random()}`
    await import(specifier)
    assert.ok(loaded.spec, 'client.js 必须通过 window.__ModuleLoader__.load 自注册')

    class Component {
      props: any
      state: any
      constructor(props: any) { this.props = props; this.state = {} }
      setState(next: any) {
        this.state = { ...(this.state || {}), ...(typeof next === 'function' ? next(this.state) : next) }
      }
    }
    const runtimeHolder: any = { current: null }
    const ReactStub: any = {
      Component,
      createElement(type: any, props: any = {}, ...children: any[]) {
        return { type, props: { ...(props || {}) }, children }
      },
      useState(init: any) { return runtimeHolder.current.hooks.useState(init) },
      useEffect(fn: any, deps: any[]) { return runtimeHolder.current.hooks.useEffect(fn, deps) },
      useCallback(fn: any, deps: any[]) { return runtimeHolder.current.hooks.useCallback(fn, deps) },
      useMemo(fn: any, deps: any[]) { return runtimeHolder.current.hooks.useMemo(fn, deps) },
    }

    const mod = loaded.spec.factory(() => ReactStub)
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
    // 主面板是 Boundary > Dashboard；与 client-backtop.test.ts 同一取法。
    const guarded = mainComponent({ t })
    assert.equal(typeof guarded.type, 'function', '主面板必须先渲染错误边界')
    const dashboard = guarded.children[0].type
    assert.equal(typeof dashboard, 'function', '错误边界内必须是 Dashboard 组件')

    const render = () => dashboard({ t })
    const runtime = createRuntime(dashboard, t, render)
    runtimeHolder.current = runtime
    runtime.flushEffects()

    return {
      runtime,
      t,
      locales,
      fetchCalls,
      warnings,
      document: documentStub,
      docAdded,
      docRemoved,
      timeoutSignals,
      fireInterval: () => intervalCb?.(),
      /** 触发第 index 个 AbortSignal.timeout 捕获信号（仿真 15s 到点）。 */
      fireAbortTimeout: (index = 0) => timeoutSignals[index]?.controller.abort(),
      /** 兜底路径：触发第 id 个被捕获的 setTimeout 回调。 */
      fireTimeout: (id = 1) => {
        const cb = timeoutCbs.get(id)
        if (cb) { timeoutCbs.delete(id); cb() }
      },
      timeoutCount: () => timeoutCbs.size,
      unmount: () => runtime.unmount(),
    }
  } catch (error) {
    restore()
    throw error
  }
}

test('裁剪提示：truncated=true 时 Dashboard 顶部渲染 trimNotice 提示条，且 statbar 数据完整', async (t) => {
  const m = await mount(t, {
    fetchImpl: (_url, _opts) => Promise.resolve(jsonResponse({
      ok: true,
      sessions: [sessionFixture],
      truncated: true,
      omittedSessions: 0,
      omittedDetail: false,
    })),
  })
  await tick()
  m.runtime.flushEffects()

  const notice = findNode(m.runtime.tree(), classContains('dsh-wp-trim-notice'))
  assert.ok(notice, 'truncated=true 必须渲染 dsh-wp-trim-notice 提示条')
  assert.equal(notice.props.role, 'status')
  assert.match(notice.children[0], /省略/, 'zh 文案必须说明「已省略」')
  assert.ok(
    notice.props.className.includes('dsh-wp-banner--degraded'),
    '提示条必须复用现有 degraded 横幅样式（克制、无新依赖）',
  )
  // sessions 仍是数组且消费方未破坏：statbar 第一项 = 会话数 1。
  const statValue = findNode(m.runtime.tree(), (n: any) => n.props?.className === 'dsh-wp-stat-value')
  assert.equal(statValue?.children[0], 1, 'sessions 数组消费方（statbar）必须拿到完整数组')
})

test('裁剪提示：omittedSessions>0（会话全部被省略）时提示条仍然渲染', async (t) => {
  const m = await mount(t, {
    fetchImpl: (_url, _opts) => Promise.resolve(jsonResponse({
      ok: true,
      sessions: [],
      truncated: true,
      omittedSessions: 7,
    })),
  })
  await tick()
  m.runtime.flushEffects()

  const notice = findNode(m.runtime.tree(), classContains('dsh-wp-trim-notice'))
  assert.ok(notice, 'sessions 为空但 omittedSessions>0 时提示条必须渲染（不能静默显示「空」）')
})

test('裁剪提示：omittedDetail 挂在 session 项上时也要识别', async (t) => {
  const m = await mount(t, {
    fetchImpl: (_url, _opts) => Promise.resolve(jsonResponse({
      ok: true,
      sessions: [{ ...sessionFixture, omittedDetail: true }],
    })),
  })
  await tick()
  m.runtime.flushEffects()

  const notice = findNode(m.runtime.tree(), classContains('dsh-wp-trim-notice'))
  assert.ok(notice, 'sessions[].omittedDetail=true 必须触发提示条')
})

test('裁剪提示：载荷完整（无任何标志）时不得渲染提示条', async (t) => {
  const m = await mount(t)
  await tick()
  m.runtime.flushEffects()

  const notice = findNode(m.runtime.tree(), classContains('dsh-wp-trim-notice'))
  assert.equal(notice, null, '完整载荷不得渲染提示条')
})

test('可见性：hidden 时跳过轮询（含 interval 触发），visible 后补一轮；卸载移除监听', async (t) => {
  const m = await mount(t, { visibility: 'hidden' })
  await tick()
  assert.equal(m.fetchCalls.length, 0, 'hidden 状态下挂载不得发起 fetch')

  m.fireInterval()
  await tick()
  assert.equal(m.fetchCalls.length, 0, 'hidden 状态下 interval 触发也必须跳过')

  m.document.visibilityState = 'visible'
  m.document.dispatch('visibilitychange')
  await tick()
  m.runtime.flushEffects()
  assert.equal(m.fetchCalls.length, 1, '回到 visible 必须立即补一轮轮询')

  const added = m.docAdded.filter((entry: any) => entry.type === 'visibilitychange')
  assert.equal(added.length, 1, '每个轮询器只注册一个 visibilitychange 监听')
  m.unmount()
  const removed = m.docRemoved.filter((entry: any) => entry.type === 'visibilitychange')
  assert.equal(removed.length, 1, '卸载必须移除 visibilitychange 监听')
  assert.equal(removed[0].fn, added[0].fn, '移除的必须是注册时的同一个函数引用')
})

test('超时：挂死的 fetch 被 15s 控制器结束后走错误路径，running 不永真，下一轮照常', async (t) => {
  const m = await mount(t, { fetchImpl: hangingFetch() })
  await tick()
  assert.equal(m.fetchCalls.length, 1, '首轮轮询必须发起 fetch')
  assert.equal(m.timeoutSignals.length, 1, '每轮轮询必须挂一个 AbortSignal.timeout 控制器')
  assert.equal(m.timeoutSignals[0].ms, 15000, '超时上限必须是 15000ms')

  m.fireAbortTimeout(0) // 模拟 15s 到点：abort 挂死的 fetch
  await tick()
  m.runtime.flushEffects()

  assert.equal(m.warnings.length, 1, '超时必须 console.warn 恰好一次')
  assert.match(String(m.warnings[0]?.[0] ?? ''), /轮询超时/, 'warn 内容必须点明轮询超时')
  // ErrorBanner 是函数组件，微型运行时不再展开：断言它作为组件节点带着错误消息出现。
  const banner = findNode(m.runtime.tree(), (n: any) => (
    typeof n.type === 'function' && n.props && typeof n.props.message === 'string' && n.props.message !== ''
  ))
  assert.ok(banner, '超时必须落到错误路径（Dashboard 渲染 ErrorBanner 且带错误消息），不能无声冻结')

  m.fireInterval() // 4s interval 到点：若 running 永真这里不会再 fetch
  await tick()
  assert.equal(m.fetchCalls.length, 2, '超时结束后 interval 下一轮必须照常发起 fetch（running 已复位）')
  assert.equal(m.timeoutSignals.length, 2, '第二轮也必须重新挂超时控制器')
  m.unmount()
})

test('兜底路径：AbortSignal.any 缺失的旧宿主走手动 setTimeout 控制器，卸载时清理', async (t) => {
  const m = await mount(t, { fetchImpl: hangingFetch(), disableAbortSignalAny: true })
  await tick()
  assert.equal(m.fetchCalls.length, 1, '兜底路径首轮轮询必须发起 fetch')
  assert.equal(m.timeoutCount(), 1, '兜底路径必须用 setTimeout 挂超时控制器（15000ms）')

  m.unmount()
  assert.equal(m.timeoutCount(), 0, '卸载必须清理 pending 的超时计时器（禁止悬挂）')

  // 卸载后超时回调即使被清不掉也不再重要；这里确保没有 warn 泄漏（卸载中止保持静默）。
  await tick()
  assert.equal(m.warnings.length, 0, '卸载中止不得触发超时 warn')
})
