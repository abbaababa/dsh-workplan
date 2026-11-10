/*
 * [2.2.0][A2 / T1 台账 AC2] 看板「时长协商」展示回归测试。
 *
 * 用户决定（目标会话 seq=1939，第 2 条：是）：把协商信息显示到看板（改 client.ts）。
 * 本测试直接加载构建后的 client.js，渲染主面板，断言四类信息至少各出现一次：
 *   ① 预估时长（estimateMinutes）；② 协商上限（timeoutMs / deadlineAt）；
 *   ③ 延期记录（timeJournal 的 extend）；④ 开工预告 / 到点预警 / 通道状态。
 * 同时覆盖 AC2-2 降级负例：字段缺失时整块不渲染、不出现 undefined / [object Object]。
 *
 * 说明：本测试只验证「已下发的字段被画出来」，不伪造服务端数据；字段来源见
 * src/runtime.ts statusTool 的 startedAt/deadlineAt/timeJournal/timeNotice/
 * timeWarning/noticeChannel 与 src/plan.ts 的 estimateMinutes/timeoutMs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BUNDLE = process.env.DSH_WP_CLIENT_BUNDLE
  ? path.resolve(process.env.DSH_WP_CLIENT_BUNDLE)
  : path.resolve(process.cwd(), 'client.js')

const AT = 1_794_107_827_459
const DEADLINE = 1_794_108_550_459

const subtaskBase = {
  department: 'engineering',
  role: '工程师',
  method: ['按步骤执行'],
  inputs: [],
  outputs: ['可复核结果'],
  dependsOn: [],
  acceptance: ['断言通过'],
  risk: '夹具失真',
}

const sessionFixture = {
  sessionId: 'session-root',
  title: '时长协商展示夹具',
  phase: 'executing',
  stats: { total: 2, done: 0, blocked: 0, inProgress: 1, pending: 1, progress: 50 },
  departments: [{ id: 'engineering', done: 0, total: 2, blocked: 0 }],
  taskUnderstanding: { deliverable: '一份可复核的看板展示' },
  contradictions: {
    primary: { statement: '协商信息不可见', evidence: [], whyPrimary: '决定用户能否看懂' },
    secondary: [],
    transformationConditions: [],
  },
  stages: [{
    id: 'S1',
    name: '展示阶段',
    goal: '验证协商字段可见',
    checkpoint: '断言通过',
    subtasks: [
      {
        ...subtaskBase,
        id: 'T1',
        title: '带协商信息的任务',
        objective: '渲染协商字段',
        estimateMinutes: 6,
        timeoutMs: 720_000,
        reasoningEffort: 'max',
      },
      {
        ...subtaskBase,
        id: 'T2',
        title: '无协商字段的降级任务',
        objective: '验证字段缺失不报错',
      },
      // [2.2.7][T5/五档] 新档位渲染哨兵：client.ts Pill 白名单若漏改 medium/xhigh，
      // 这两个断言会立刻红灯（否则新档位在任务卡片上静默消失，无人发现）。
      {
        ...subtaskBase,
        id: 'T3',
        title: 'medium 档任务',
        objective: '验证 medium 档位渲染',
        reasoningEffort: 'medium',
      },
      {
        ...subtaskBase,
        id: 'T4',
        title: 'xhigh 档任务',
        objective: '验证 xhigh 档位渲染',
        reasoningEffort: 'xhigh',
      },
      {
        ...subtaskBase,
        id: 'T5',
        title: 'low 档任务',
        objective: '验证 low 档位渲染（五档 Pill 全覆盖）',
        reasoningEffort: 'low',
      },
    ],
  }],
  statuses: [
    {
      subtaskId: 'T1',
      status: 'in_progress',
      closure: 'assigned',
      progress: 40,
      startedAt: AT,
      deadlineAt: DEADLINE,
      timeJournal: [
        { at: AT + 1000, action: 'estimate', declaredMinutes: 6, by: 'agent', reason: '开工前预告' },
        { at: AT + 2000, action: 'extend', extendMs: 180_000, by: 'agent', reason: '补充时间' },
      ],
      timeNotice: { declaredMinutes: 6, at: AT + 1000, channel: 'agent', reason: '开工前预告' },
      timeWarning: { at: AT + 5000, remainingMs: 120_000, channel: 'watchdog' },
      noticeChannel: {
        state: 'observed',
        target: 'session-root',
        targetSource: 'agent.id',
        caller: 'child-1',
        at: AT + 500,
        observedAt: AT + 1500,
        reason: 'agent-message-relayed',
      },
      pendingAdjudication: true,
    },
    { subtaskId: 'T2', status: 'pending', closure: 'pending', progress: 0 },
    { subtaskId: 'T3', status: 'pending', closure: 'pending', progress: 0 },
    { subtaskId: 'T4', status: 'pending', closure: 'pending', progress: 0 },
    { subtaskId: 'T5', status: 'pending', closure: 'pending', progress: 0 },
  ],
  risks: [],
  verification: [],
  practiceLoop: null,
  errors: [],
  updatedAt: Date.now(),
}

/** 把 client.js 的工厂加载成可渲染的组件，返回渲染函数（与既有 client 测试同构）。 */
async function makeRenderer() {
  let loaded: any = null
  ;(globalThis as any).window = {
    __ModuleLoader__: { load: (spec: any) => { loaded = spec } },
  }
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  await import(`${pathToFileURL(BUNDLE).href}?time=${Date.now()}`)
  assert.ok(loaded, `bundle 未注册 ModuleLoader：${BUNDLE}`)
  const factory = loaded.factory
  let firstState = true
  let currentFixture = sessionFixture
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
  return (session = sessionFixture) => {
    // 每次渲染前重置 useState 的初始值，支持同文件内的降级用例。
    currentFixture = session
    firstState = true
    return render(ReactStub.createElement(mainComponent, { t }))
  }
}

test('A2：看板可见预估 / 协商上限 / 延期 / 开工预告 / 预警 / 通道 / 推理等级', async () => {
  const render = await makeRenderer()
  const html = render()
  assert.ok(html.length > 1000, '夹具必须真的渲染出面板')
  for (const expected of [
    '时长协商',
    '预估时长：6 分钟',
    '协商上限：12 分钟',
    '协商截止：',
    '延期记录：+3 分钟',
    '开工预告：6 分钟',
    '到点预警：剩余 120 秒',
    '预告通道：已观测到送达',
    '推理等级：max',
    // [2.2.7][T5/五档] medium/xhigh 必须同样渲染出 Pill；client.ts 白名单漏改即红灯。
    '推理等级：medium',
    '推理等级：xhigh',
    '推理等级：low',
    '待裁决：到点后按安全兜底结算',
  ]) {
    assert.ok(html.includes(expected), `看板必须出现「${expected}」；实际片段：${html.slice(0, 400)}`)
  }
  assert.equal(html.includes('undefined'), false, '字段缺失不得渲染 undefined')
  assert.equal(html.includes('[object Object]'), false, '对象字段不得直接字符串化')
})

test('A2 降级：无协商字段的任务不渲染协商块、不报错', async () => {
  const render = await makeRenderer()
  // 只保留 T2（没有任何协商字段），验证整块不出现且不产生脏文本。
  const bareSession = {
    ...sessionFixture,
    title: '降级展示夹具',
    statuses: [{ subtaskId: 'T2', status: 'pending', closure: 'pending', progress: 0 }],
    stages: [{
      ...sessionFixture.stages[0],
      subtasks: [sessionFixture.stages[0].subtasks[1]],
    }],
  }
  const html = render(bareSession)
  assert.ok(html.length > 1000, '降级夹具仍应正常渲染面板')
  assert.equal(html.includes('时长协商'), false, '没有任何字段时整块不渲染')
  assert.equal(html.includes('undefined'), false)
  assert.equal(html.includes('NaN'), false)
  assert.equal(html.includes('[object Object]'), false)
})
