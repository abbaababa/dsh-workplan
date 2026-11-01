/*
 * done + error 渲染回归测试（2026-11-01 事故的呈现层守护）。
 *
 * 事故形态：T12 行的 status 已经是 done，但持久化记录里还留着上一轮的
 * `error` 文本；1.9.1 的渲染层无条件把 `error` 画成「卡住原因」，于是同一张
 * 卡片上「已完成」和「卡住了」同时成立。1.10.1 在渲染层加了
 * `status !== 'done'` 守卫，并把历史文本降级为 `lastError` 留档。
 *
 * 本测试用最小脏数据夹具（status=done 且 error 非空）直接渲染真实 client.js，
 * 断言：
 *   1. done 行不得把 error 文本渲染成任何「原因」；
 *   2. lastError 至多以灰色留档样式出现；
 *   3. 未完成行的原因仍然照常显示（守卫不能误伤）。
 *
 * A/B 区分力：设 `DSH_WP_CLIENT_BUNDLE=/abs/path/to/legacy-client.js` 可把同一
 * 夹具指向修复前的 bundle。修复前应当失败（原因文本出现），修复后应当通过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 修复前的 1.9.1 bundle（由 A/B 脚本注入）；不设则使用当前构建的 client.js。 */
const BUNDLE = process.env.DSH_WP_CLIENT_BUNDLE
  ? path.resolve(process.env.DSH_WP_CLIENT_BUNDLE)
  : path.resolve(process.cwd(), 'client.js')

const DIRTY_ERROR = '旧错误-DONE-9f2c：本轮预算用尽，等待续跑'
const ARCHIVE_TEXT = '留档文本-ABC-7c1：上一轮子会话 d283b2b6'
const PENDING_ERROR = '待跑原因-PEND-3a4：还没开始'

const planFixture = {
  sessionId: 's1',
  title: 'done+error 渲染回归夹具',
  phase: 'done',
  stats: { total: 3, done: 1, blocked: 0, inProgress: 0, pending: 2, progress: 33 },
  departments: [{ id: 'engineering', done: 1, total: 3, blocked: 0 }],
  taskUnderstanding: { deliverable: '一份回归证据' },
  contradictions: {
    primary: { statement: 'done 与 error 并存', evidence: [], whyPrimary: '呈现层矛盾' },
    secondary: [],
    transformationConditions: [],
  },
  stages: [{
    id: 'S1',
    name: '阶段一',
    goal: '验证渲染守卫',
    checkpoint: '渲染输出',
    subtasks: [
      { id: 'T1', title: '已完成的一件', department: 'engineering', role: '测试', objective: '构造脏数据', method: ['夹具'], inputs: [], outputs: ['证据'], dependsOn: [], acceptance: ['有断言'], risk: '夹具失真' },
      { id: 'T2', title: '还没做完的一件', department: 'engineering', role: '测试', objective: '保留对照组', method: ['夹具'], inputs: [], outputs: ['证据'], dependsOn: [], acceptance: ['有断言'], risk: '误伤' },
      { id: 'T3', title: '干净的一件', department: 'engineering', role: '测试', objective: '空白对照', method: ['夹具'], inputs: [], outputs: ['证据'], dependsOn: [], acceptance: ['有断言'], risk: '噪声' },
    ],
  }],
  statuses: [
    { subtaskId: 'T1', status: 'done', progress: 100, error: DIRTY_ERROR, lastError: ARCHIVE_TEXT },
    { subtaskId: 'T2', status: 'pending', progress: 0, error: PENDING_ERROR },
    { subtaskId: 'T3', status: 'pending', progress: 0 },
  ],
  risks: [],
  verification: [],
  practiceLoop: null,
  errors: [],
  updatedAt: Date.now(),
}

let factoryPromise: Promise<any> | null = null

async function loadBundleFactory(): Promise<any> {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      let loaded: any = null
      ;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
      ;(globalThis as any).document = {
        getElementById: () => null,
        createElement: () => ({ id: '', textContent: '' }),
        head: { appendChild: () => {} },
      }
      await import(`${pathToFileURL(BUNDLE).href}?render=${Date.now()}`)
      assert.ok(loaded, `bundle 未注册 ModuleLoader：${BUNDLE}`)
      return loaded.factory
    })()
  }
  return factoryPromise
}

async function renderDashboard(session: any): Promise<string> {
  const factory = await loadBundleFactory()
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
      if (firstState) {
        firstState = false
        return [{ loading: false, sessions: [session], error: null, updatedAt: Date.now() }, () => {}]
      }
      return [init, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
  }
  const render = (node: any): string => {
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

  const mod = factory(() => ReactStub)
  const locales: any = {}
  let mainComponent: any = null
  const t = (key: string) => locales.zh?.[key] ?? key
  mod.apply({
    effect(fn: any) { return fn() },
    locale: {
      register(_ns: string, lang: string, obj: any) { locales[lang] = obj; return () => {} },
      bind() { return t },
    },
    slots: {
      inject(_name: string, fn: any) { fn() },
      register(spec: any, component: any) { if (spec.name === 'main') mainComponent = component; return () => {} },
    },
  })
  assert.ok(mainComponent, 'main 面板组件必须已注册')
  return render(ReactStub.createElement(mainComponent, { t }))
}

test('done-error-render: done 行带 error 时不得渲染卡住/未完成原因', async () => {
  const html = await renderDashboard(planFixture)
  assert.ok(html.length > 1000, '脏数据夹具必须真的渲染出面板')
  assert.equal(html.includes(DIRTY_ERROR), false, 'done 行的 error 原文不得出现在任何位置')
  assert.equal(html.includes(`卡住原因：${DIRTY_ERROR}`), false, 'done 行不得显示「卡住原因」')
  assert.equal(html.includes(`还没做完的原因：${DIRTY_ERROR}`), false, 'done 行不得显示「还没做完的原因」')
  assert.equal(html.includes(`dsh-wp-error-text">卡住原因：${DIRTY_ERROR}`), false, 'done 行不得生成 error 段落')
})

test('done-error-render: done 行的 lastError 只能以留档样式出现', async () => {
  const html = await renderDashboard(planFixture)
  assert.ok(
    html.includes(`上一轮的失败记录（已完成，仅留档）：${ARCHIVE_TEXT}`),
    'lastError 必须以明确的「仅留档」文案出现',
  )
  assert.equal(html.includes(`卡住原因：${ARCHIVE_TEXT}`), false, '留档文本不得被当成卡住原因')
  assert.equal(html.includes(`dsh-wp-error-text">${ARCHIVE_TEXT}`), false, '留档文本不得进入 error 段落')
})

test('done-error-render: 未完成行的原因仍然显示（守卫不误伤）', async () => {
  const html = await renderDashboard(planFixture)
  assert.ok(html.includes(PENDING_ERROR), 'pending 行的 error 仍应显示')
  assert.ok(
    html.includes(`还没做完的原因：${PENDING_ERROR}`) || html.includes(`卡住原因：${PENDING_ERROR}`),
    'pending 行应使用「还没做完的原因」（旧版为「卡住原因」）标签',
  )
  assert.equal(html.includes(`上一轮的失败记录（已完成，仅留档）：${PENDING_ERROR}`), false, '未完成行不得被标成留档')
})

test('done-error-render: 历史真实文本（error 与 lastError 相同）只以留档出现一次', async () => {
  const realText = '本轮预算用尽，等待续跑；上一轮子会话 d283b2b6；运行 28s'
  const html = await renderDashboard({
    ...planFixture,
    statuses: [
      { subtaskId: 'T1', status: 'done', progress: 100, error: realText, lastError: realText },
      { subtaskId: 'T2', status: 'pending', progress: 0 },
      { subtaskId: 'T3', status: 'pending', progress: 0 },
    ],
  })
  const occurrences = html.split(realText).length - 1
  assert.equal(html.includes(`卡住原因：${realText}`), false, '历史 done 行不得显示卡住原因')
  assert.equal(html.includes(`还没做完的原因：${realText}`), false, '历史 done 行不得显示未完成原因')
  assert.equal(occurrences, 1, '同一段历史文本在页面上只能出现一次（留档）')
  assert.ok(html.includes(`上一轮的失败记录（已完成，仅留档）：${realText}`), '历史文本应以留档样式出现')
})
