import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * [1.6.0] 「已结束」分组的渲染回归测试。
 *
 * 事故：会话已经结束，面板却把它放在「进行中」组里（截图红圈）。后端修复负责
 * 让阶段收敛为 `ended`，客户端负责让这个阶段有一个**独立、诚实**的落点：
 * 它不能继续借用「进行中」三个字，也不能被画成绿色完成态。
 *
 * 这里直接渲染真实 client.js（与 tests/status-groups.test.ts 同一套桩），断言
 * 三件事：ended 计划的归属组、组名文案、卡片徽标把「停在哪儿」说清楚。
 */

function makeSession(overrides: any) {
  const base: any = {
    sessionId: 's',
    title: '任务',
    phase: 'executing',
    planId: null,
    createdAt: 1000,
    updatedAt: 1000,
    stats: { total: 1, done: 0, blocked: 0, inProgress: 0, pending: 1, progress: 0 },
    departments: [],
    stages: [{
      id: 'S1',
      name: '阶段',
      goal: '目标',
      checkpoint: '检查点',
      subtasks: [{
        id: 'T1', title: '具体工作', department: 'engineering', role: '工程师',
        objective: '完成', method: ['方法'], inputs: [], outputs: [],
        dependsOn: [], acceptance: ['验收'], risk: '风险',
      }],
    }],
    statuses: [{ subtaskId: 'T1', status: 'pending' }],
    errors: [],
    risks: [],
    verification: [],
    practiceLoop: null,
  }
  return { ...base, ...overrides, stats: { ...base.stats, ...(overrides.stats || {}) } }
}

let loaded: any = null
;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
;(globalThis as any).document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: () => {} },
}

function createReactStub(fixture: any) {
  let firstState = true
  class Component {
    props: any
    constructor(props: any) { this.props = props }
    render() { return this.props?.children ?? null }
  }
  const stub: any = {
    Component,
    createElement(type: any, props: any, ...children: any[]) {
      const next = { ...(props || {}) }
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next }
    },
    useState(init: any) {
      if (firstState) { firstState = false; return [fixture, () => {}] }
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect() {},
    useCallback(fn: any) { return fn },
    useMemo(fn: any) { return fn() },
  }
  return stub
}

function renderNode(node: any): any {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderNode)
  if (typeof node.type === 'function') {
    const isClass = node.type.prototype && node.type.prototype.render
    return renderNode(isClass ? new node.type(node.props).render() : node.type(node.props))
  }
  return { type: String(node.type), props: node.props || {}, children: renderNode(node.props?.children) }
}

function childrenOf(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  return Array.isArray(node.children) ? node.children : [node.children]
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

function find(node: any, predicate: (candidate: any) => boolean): any {
  return findAll(node, predicate)[0] ?? null
}

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return textOf(node.children)
}

function hasClass(node: any, name: string) {
  if (!node || typeof node !== 'object') return false
  return String(node.props?.className || '').split(/\s+/).includes(name)
}

const clientPath = path.resolve(process.cwd(), 'client.js')
await import(`${pathToFileURL(clientPath).href}?ended-group=${Date.now()}`)

function mountDashboard(fixture: any) {
  assert.ok(loaded, 'client bundle must register itself through window.__ModuleLoader__')
  const ReactStub = createReactStub(fixture)
  const mod = loaded.factory(() => ReactStub)
  const locales: any = {}
  let mainComponent: any = null
  const ctx: any = {
    effect(fn: any) { return fn() },
    locale: {
      register(_ns: string, lang: string, messages: any) { locales[lang] = messages; return () => {} },
      bind() { return (key: string) => locales.zh?.[key] ?? key },
    },
    slots: {
      inject(_name: string, fn: any) { fn() },
      register(spec: any, component: any) { if (spec.name === 'main') mainComponent = component; return () => {} },
    },
  }
  mod.apply(ctx)
  assert.ok(mainComponent, 'main panel component must be registered')
  const t = (key: string) => locales.zh?.[key] ?? key
  return { tree: renderNode(ReactStub.createElement(mainComponent, { t })), t }
}

function groupOf(tree: any, group: string) {
  return find(tree, (node: any) => node.type === 'section' && node.props?.['data-group'] === group)
}

const endingSession = () => makeSession({
  sessionId: 's-ended',
  title: 'iPhone 端 dsh-mobile-access 右滑无法展开左侧栏的排查与修复',
  phase: 'ended',
  suspendedPhase: 'paused',
  endReason: 'completed',
  endedAt: 5000,
  stats: { total: 12, done: 7, blocked: 0, inProgress: 0, pending: 5, progress: 58 },
})
const runningSession = () => makeSession({ sessionId: 's-running', title: '正在跑的任务', phase: 'executing', stats: { total: 3, done: 1, blocked: 0, inProgress: 1, pending: 1, progress: 33 } })
const doneSession = () => makeSession({ sessionId: 's-done', title: '已完成的旧任务', phase: 'done', stats: { total: 2, done: 2, blocked: 0, inProgress: 0, pending: 0, progress: 100 } })

test('已结束的计划进入独立的「已结束」组，绝不留在「进行中」组', () => {
  const { tree } = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [endingSession(), runningSession(), doneSession()] })

  const live = groupOf(tree, 'live')
  const ended = groupOf(tree, 'ended')
  assert.ok(live, '进行中组必须存在')
  assert.ok(ended, '已结束组必须存在——会话结束的事实需要一个诚实的落点')

  assert.equal(findAll(live, (node: any) => node.props?.['data-session-id'] === 's-ended').length, 0, '已结束的计划不得出现在进行中组')
  assert.equal(findAll(ended, (node: any) => node.props?.['data-session-id'] === 's-ended').length, 1, '已结束的计划必须出现在已结束组')
  assert.equal(findAll(live, (node: any) => node.props?.['data-session-id'] === 's-running').length, 1)

  assert.ok(textOf(live).includes('进行中'))
  assert.ok(textOf(ended).includes('已结束'), '组名必须直接写「已结束」')
  assert.equal(textOf(ended).includes('进行中'), false, '已结束组的文案里不得再出现「进行中」')
})

test('已结束组的徽标把「停在哪儿」说清楚：终态 + 原阶段', () => {
  const { tree } = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [endingSession()] })
  const ended = groupOf(tree, 'ended')
  const card = find(ended, (node: any) => node.props?.['data-session-id'] === 's-ended')
  assert.ok(card)
  const text = textOf(card)
  assert.ok(text.includes('已结束，可续跑'), '必须明确说明这一轮已经结束')
  assert.ok(text.includes('预算用完，可续跑'), '必须保留原阶段，用户才知道是预算用完还是卡住了')
})

test('卡住的计划结束后仍然报「需处理」，只是换了分组', () => {
  const fixture = makeSession({ sessionId: 's-stuck', title: '卡住的任务', phase: 'ended', suspendedPhase: 'blocked', stats: { total: 2, done: 1, blocked: 1, inProgress: 0, pending: 0, progress: 50 } })
  const { tree } = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [fixture] })
  const ended = groupOf(tree, 'ended')
  assert.ok(textOf(ended).includes('需处理'), '结束不等于问题消失：受阻项必须继续提示用户')
})

test('没有已结束计划时不渲染空的「已结束」组', () => {
  const { tree } = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [runningSession()] })
  assert.equal(groupOf(tree, 'ended'), null, '空分组只是噪声，不应出现')
})

test('已完成组在有已结束或进行中计划时默认折叠，全部停妥后展开', () => {
  const busy = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [runningSession(), doneSession()] })
  const folded = groupOf(busy.tree, 'done')
  assert.equal(folded.props['data-folded'], 'true', '还有东西在跑时已完成组默认收起')

  const quiet = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [endingSession(), doneSession()] })
  const foldedQuiet = groupOf(quiet.tree, 'done')
  assert.equal(foldedQuiet.props['data-folded'], 'true', '已结束但未完成时，已完成组仍应收起（避免抢走注意力）')

  const idle = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [doneSession()] })
  assert.equal(groupOf(idle.tree, 'done').props['data-folded'], 'false', '只剩已完成计划时必须展开')
})
