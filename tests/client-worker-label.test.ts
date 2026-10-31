import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * [1.8.5] 「现在谁在做」的口径回归测试。
 *
 * 事故（2026-10-30 21:38 截图）：计划卡片已经写着「已结束，可续跑 · 卡住了」，
 * 下面却还挂着「现在谁在做：研究分析 · 人性自私与利益博弈推演（卡住了）」。
 * 那句话在事实层面是假的——那一刻没有任何子 Agent 在跑——用户据此认为报告和
 * 状态互相矛盾。修复原则：只有真的存在 `in_progress` 条目时才允许用现在进行
 * 时的「现在谁在做」；否则一律改成过去时的「停在哪一步」。
 *
 * 这里渲染真实 client.js（与 tests/ended-group.test.ts 同一套桩），断言两种
 * 场景各说各的话，且不会互相串台。
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
        id: 'T1', title: '人性自私与利益博弈推演', department: 'research', role: '研究员',
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
  return {
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
  } as any
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

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return textOf(node.children)
}

const clientPath = path.resolve(process.cwd(), 'client.js')
await import(`${pathToFileURL(clientPath).href}?worker-label=${Date.now()}`)

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

/** 已结束 + 卡住：没有任何东西在跑，只能说「停在哪一步」。 */
const stuckEnded = () => makeSession({
  sessionId: 's-stuck',
  phase: 'ended',
  suspendedPhase: 'blocked',
  endReason: 'completed',
  endedAt: 5000,
  stats: { total: 2, done: 1, blocked: 1, inProgress: 0, pending: 0, progress: 50 },
  statuses: [
    { subtaskId: 'T1', status: 'done' },
    { subtaskId: 'T2', status: 'blocked', progress: 100, error: '子 Agent 结束状态为 aborted' },
  ],
  stages: twoSubtasks(),
})

/** 真的有一项在跑：必须继续用「现在谁在做」。 */
const twoSubtasks = () => [{
  id: 'S1',
  name: '阶段',
  goal: '目标',
  checkpoint: '检查点',
  subtasks: [
    { id: 'T1', title: '确认标的与数据口径', department: 'research', role: '研究员', objective: 'o', method: ['m'], inputs: [], outputs: [], dependsOn: [], acceptance: ['a'], risk: 'r' },
    { id: 'T2', title: '人性自私与利益博弈推演', department: 'research', role: '研究员', objective: 'o', method: ['m'], inputs: [], outputs: [], dependsOn: ['T1'], acceptance: ['a'], risk: 'r' },
  ],
}]

const liveRunning = () => makeSession({
  sessionId: 's-live',
  phase: 'executing',
  stats: { total: 2, done: 1, blocked: 0, inProgress: 1, pending: 0, progress: 50 },
  statuses: [
    { subtaskId: 'T1', status: 'done' },
    { subtaskId: 'T2', status: 'in_progress', progress: 40 },
  ],
  stages: twoSubtasks(),
})

function cardOf(tree: any, sessionId: string) {
  return findAll(tree, (node: any) => node.props?.['data-session-id'] === sessionId)[0] ?? null
}

test('已结束且卡住：说「停在哪一步」，绝不说「现在谁在做」', () => {
  const { tree } = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [stuckEnded()] })
  const card = cardOf(tree, 's-stuck')
  assert.ok(card, '卡片必须存在')
  const text = textOf(card)
  assert.ok(text.includes('停在哪一步'), `已结束的卡片必须用过时态说明停下位置，实际：${text.slice(0, 200)}`)
  assert.equal(text.includes('现在谁在做'), false, '没有任何子 Agent 在跑时不得使用现在进行时的「现在谁在做」')
})

test('有子任务真在跑：仍然说「现在谁在做」', () => {
  const { tree } = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [liveRunning()] })
  const card = cardOf(tree, 's-live')
  assert.ok(card, '卡片必须存在')
  const text = textOf(card)
  assert.ok(text.includes('现在谁在做'), `有 in_progress 条目时必须保留「现在谁在做」，实际：${text.slice(0, 200)}`)
  assert.equal(text.includes('停在哪一步'), false, '有子任务在跑时不得退化成「停在哪一步」')
})

test('两种口径不会在同一次渲染里串台', () => {
  const { tree } = mountDashboard({ loading: false, error: null, updatedAt: 1, sessions: [stuckEnded(), liveRunning()] })
  const stuckText = textOf(cardOf(tree, 's-stuck'))
  const liveText = textOf(cardOf(tree, 's-live'))
  assert.ok(stuckText.includes('停在哪一步'))
  assert.equal(stuckText.includes('现在谁在做'), false)
  assert.ok(liveText.includes('现在谁在做'))
  assert.equal(liveText.includes('停在哪一步'), false)
})
