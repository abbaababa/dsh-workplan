import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * A blocked plan must tell the reader how to get out of it.
 *
 * Before this test existed the card only said "卡住了"; nothing in the UI hinted
 * that re-dispatching resumes from the blocked step, so the visible options were
 * "restate the request" or "give up" — which is how a recoverable failure looks
 * indistinguishable from a dead plan.
 */

function baseSession(overrides: any = {}) {
  return {
    sessionId: 's1',
    title: '受阻计划的续跑提示',
    phase: 'blocked',
    stats: { total: 2, done: 1, blocked: 1, inProgress: 0, pending: 0, progress: 50 },
    departments: [{ id: 'engineering', done: 1, total: 2, blocked: 1 }],
    taskUnderstanding: { deliverable: '结论' },
    contradictions: { primary: { statement: '矛盾', evidence: [], whyPrimary: '原因' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '取证', goal: '拿到证据', checkpoint: '清单',
      subtasks: [
        { id: 'T1', title: '拉取日志', department: 'engineering', role: '工程师', objective: '取证', method: ['读日志'], inputs: [], outputs: ['记录'], dependsOn: [], acceptance: ['完整'], risk: '缺失' },
        { id: 'T2', title: '复核', department: 'engineering', role: '工程师', objective: '复核', method: ['比对'], inputs: ['记录'], outputs: ['结论'], dependsOn: ['T1'], acceptance: ['有证据'], risk: '误判' },
      ],
    }],
    statuses: [
      { subtaskId: 'T1', status: 'done', progress: 100, summary: '完成' },
      { subtaskId: 'T2', status: 'blocked', progress: 0, error: '子任务 T2 无进展超时（300000ms 内子 Agent 没有产生任何新事件）' },
    ],
    risks: [],
    verification: [],
    practiceLoop: null,
    errors: [],
    resumeCount: 0,
    resumeLimit: 2,
    resumeAvailable: true,
    updatedAt: Date.now(),
    ...overrides,
  }
}

async function renderDashboard(session: any) {
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
      if (firstState) { firstState = false; return [{ loading: false, sessions: [session], error: null, updatedAt: Date.now() }, () => {}] }
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
    return `<${String(node.type)}>${(node.children || []).map(render).join('')}</${String(node.type)}>`
  }
  const clientPath = path.resolve(process.cwd(), 'client.js')
  await import(`${pathToFileURL(clientPath).href}?hint=${Date.now()}-${Math.random()}`)
  const mod = loaded.factory(() => ReactStub)
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
  assert.ok(mainComponent, 'main panel component must be registered')
  return render(ReactStub.createElement(mainComponent, { t }))
}

test('a blocked plan with resume budget tells the user it can be resumed', async () => {
  const html = await renderDashboard(baseSession())
  assert.ok(html.includes('卡住了'), 'the blocked state must stay visible')
  assert.ok(html.includes('续跑'), 'the card must explain that the plan can be resumed')
  assert.ok(html.includes('还可续跑 2 次'), 'the remaining resume budget must be shown')
  assert.ok(html.includes('会从受阻处继续'), 'the hint must say it continues from the blocked step')
})

test('a blocked plan with no budget tells the user to take over', async () => {
  const html = await renderDashboard(baseSession({
    resumeCount: 2,
    resumeAvailable: false,
    stats: { total: 2, done: 0, blocked: 2, inProgress: 0, pending: 0, progress: 0 },
  }))
  assert.ok(html.includes('额度已用尽'), 'an exhausted budget must be stated, not hidden')
  assert.ok(html.includes('直接接手'), 'the exhausted case must name the fallback')
})

/*
 * [1.8.4] 徽标承诺「可续跑」，卡片就必须给出续跑方法。
 *
 * 事故截图里同一张卡写着「已结束，可续跑 · 卡住了」，却不给任何操作提示——
 * 因为旧 `resumeHint` 只在 `phase === 'blocked'` 时返回指令，而这张卡的 phase
 * 是 `ended`。两条互斥的规则拼出了一张自相矛盾的卡（T3 的互斥证据）。
 */
test('an ended card with a blocked plan still explains how to resume', async () => {
  const html = await renderDashboard(baseSession({
    phase: 'ended',
    suspendedPhase: 'blocked',
    endedAt: Date.now(),
  }))
  assert.ok(html.includes('卡住了'), 'the suspended fact must stay visible')
  assert.ok(html.includes('续跑'), 'the badge says 可续跑, so the card must also say how')
  assert.ok(html.includes('还可续跑 2 次'), 'the remaining budget must still be shown')
})

/*
 * [1.8.4] 展示层自保：载荷同时说「已结束」和「派发仍在跑」时，以存活事实为准。
 *
 * 服务端已按 `record.dispatchPromise` 门控；这条用例保证即使拿到一份不守规矩的
 * 载荷（旧缓存、第三方构造的 payload），界面也不会重新说出「已结束」。
 */
test('an ended payload that still reports a live dispatch never renders 已结束', async () => {
  const base = {
    phase: 'ended',
    suspendedPhase: 'executing',
    stats: { total: 2, done: 1, blocked: 0, inProgress: 1, pending: 0, progress: 70 },
    statuses: [
      { subtaskId: 'T1', status: 'done', progress: 100 },
      { subtaskId: 'T2', status: 'in_progress', progress: 40 },
    ],
  }
  const withRunning = await renderDashboard(baseSession({ ...base, running: true }))
  assert.equal(withRunning.includes('已结束'), false, '派发仍在跑时不得出现「已结束」')

  const withoutRunning = await renderDashboard(baseSession({ ...base, running: false }))
  assert.ok(withoutRunning.includes('已结束'), '没有活派发时仍应正常显示「已结束」')
})

test('a pending plan is not mislabelled as cancelled', async () => {
  const html = await renderDashboard(baseSession({
    phase: 'pending',
    stats: { total: 2, done: 0, blocked: 0, inProgress: 0, pending: 2, progress: 0 },
    statuses: [
      { subtaskId: 'T1', status: 'pending' },
      { subtaskId: 'T2', status: 'pending' },
    ],
    resumeAvailable: false,
    resumeCount: 0,
  }))
  assert.ok(html.includes('受阻计划的续跑提示'), 'the plan card must still be rendered')
  assert.equal(html.includes('已取消'), false, 'a pending plan must not be displayed as cancelled')
})
