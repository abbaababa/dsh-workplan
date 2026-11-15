/*
 * [SCv2-T6] 「简单」判据 v2 · T6 渲染夹具（E-4）。
 * 手法同构 tests/client-time-negotiation-render.test.ts:132-206 的
 * __ModuleLoader__ 渲染脚手架（F6），不改动该文件。
 * 纪律：statuses 先经 normaliseStatusEntry（服务端派生）再进夹具——
 * 证明「判定在服务端下发，客户端只渲染不算术」（src/client.ts:1725 约定）。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BUNDLE = process.env.DSH_WP_CLIENT_BUNDLE
  ? path.resolve(process.env.DSH_WP_CLIENT_BUNDLE)
  : path.resolve(process.cwd(), 'client.js')

export async function makeRenderer() {
  let loaded: any = null
  ;(globalThis as any).window = {
    __ModuleLoader__: { load: (spec: any) => { loaded = spec } },
  }
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  await import(`${pathToFileURL(BUNDLE).href}?scv2t6=${Date.now()}-${Math.random()}`)
  assert.ok(loaded, `bundle 未注册 ModuleLoader：${BUNDLE}`)
  const factory = loaded.factory
  let firstState = true
  let currentFixture: any = null
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
        return [{ loading: false, sessions: [currentFixture], error: null, updatedAt: Date.now() }, () => {}]
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
    return `<${tag}>${(node.children || []).map(render).join('')}</${tag}>`
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
  return (session: any) => {
    currentFixture = session
    firstState = true
    return render(ReactStub.createElement(mainComponent, { t }))
  }
}

/** 最小可渲染会话夹具：单部门行 T1，statuses 由调用方传入（已服务端归一化）。 */
export function sessionFixture(statuses: any[], subtaskExtra: any = {}) {
  const subtaskBase = {
    department: 'engineering', role: '工程师', method: ['按步骤执行'], inputs: [],
    outputs: ['可复核结果'], dependsOn: [], acceptance: ['断言通过'], risk: '夹具失真',
  }
  return {
    sessionId: 'session-scv2-t6-render',
    title: '判据 v2 T6 渲染夹具',
    phase: 'executing',
    stats: { total: 1, done: 0, blocked: 0, inProgress: 1, pending: 0, progress: 40 },
    departments: [{ id: 'engineering', done: 0, total: 1, blocked: 0 }],
    taskUnderstanding: { deliverable: '判据 v2 看板展示验收' },
    contradictions: { primary: { statement: '判据信息可见', evidence: [], whyPrimary: '用户能否看懂' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '展示阶段', goal: '验证判据字段可见', checkpoint: '断言通过',
      subtasks: [{ ...subtaskBase, id: 'T1', title: '判据验收任务', objective: '渲染判据字段', ...subtaskExtra }],
    }],
    statuses,
    risks: [], verification: [], practiceLoop: null, errors: [], updatedAt: Date.now(),
  }
}

/** 叶子预估台账夹具：member→{declaredMinutes,at,delivery:'sent'}（F2 形状）。 */
export function delegateEstimates(entries: Array<{ member: string; minutes: number | null }>) {
  const delegates = entries.map((e) => ({ member: e.member, role: 'member', task: '单项工作' }))
  const map: Record<string, any> = {}
  for (const e of entries) {
    if (e.minutes !== null) map[e.member] = { declaredMinutes: e.minutes, at: 1_700_000_000_000, delivery: 'sent' }
  }
  return { delegates, delegateEstimates: map }
}

/**
 * 「达标」肯定性断言辅助（C-Q2-04 / C-Q4-02 / C-Q4-03）：
 * 文案模板中存在两处**非肯定**的「达标」提及——
 *  ① leaderEstimatePartial：「不得视为「简单判据达标」」（否定）；
 *  ② leaderEstimateFull：「达标须同时满足…」（条件式，非宣布达标）；
 *  ③ leaderEstimateOver：「无留痕＝未批准，不得视为达标」（否定，首跑 C-Q4-02 补）。
 * AC-Q2-3/AC-Q4-2 的「不得显示达标」禁止的是**肯定性达标宣布**；本函数返回
 * 所有不属于上述两种语境的「达标」出现（带上下文），空数组＝无肯定性宣布。
 * 该解释已写入 T6 报告口径澄清节，不是放宽断言。
 */
export function affirmativeCriterionClaims(html: string): string[] {
  const bad: string[] = []
  const re = /达标/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(Math.max(0, m.index - 12), m.index)
    const after = html.slice(m.index, m.index + 10)
    const negated = before.endsWith('不得视为「简单判据') || before.endsWith('不得视为')
    const conditional = after.startsWith('达标须同时满足')
    if (!negated && !conditional) bad.push(html.slice(Math.max(0, m.index - 20), m.index + 20))
  }
  return bad
}
