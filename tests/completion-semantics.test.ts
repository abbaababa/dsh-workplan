/*
 * [1.5.2] 「完成语义」同类矛盾回归：不只修截图那一格，而是把 T5 矩阵里
 * 同一根因的其它表现一起锁住。
 *
 * 截图修好后仍存在的同类问题（docs/state-progress-matrix.md §§5）：
 *   C2 执行中却写「没有下一步，这件事已完成」（单任务 in_progress、环 0%）；
 *   C5 部分完成（done>0、无 in_progress）时「现在」写「还没开始」；
 *   C8 允许 `{status:'in_progress', progress:100}`（「正在做 + 100%」）；
 *   C9 阶段行说「正在做」、阶段卡说「还没开始」；
 *   C11 降级计划 0/0 也说「这件事已完成」；
 *   C13 0% 的 pending 卡带 `data-state="active"`；
 *   C7 阶段条把 blocked 当「已触达」，环 50% 而条 100%。
 *
 * 本文件分两层：纯函数（applyStatus / 不变量）+ 真实 client.js 渲染。
 * 渲染断言只读「读者真正看到的那个节点」，避免被同卡其它文字误伤。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  aggregateInvariantViolations,
  applyStatus,
  createStatuses,
  derivePlanSnapshot,
} from '../src/plan.js'

// ─────────────────────────────── 纯函数层 ───────────────────────────────

function planWith(statuses: string[]) {
  const plan = {
    planId: 'wp-semantics',
    sessionId: 's-semantics',
    createdTurn: 1,
    createdAt: 1000,
    title: '完成语义回归',
    stages: [{
      id: 'S1',
      subtasks: statuses.map((_status, index) => ({
        id: `T${index + 1}`,
        title: `第 ${index + 1} 步`,
        department: 'engineering',
        dependsOn: index === 0 ? [] : [`T${index}`],
      })),
    }],
  }
  return plan
}

function statusesOf(statuses: string[]) {
  const plan = planWith(statuses)
  return createStatuses(plan).map((item: any, index: number) => ({
    ...item,
    status: statuses[index],
  }))
}

test('in_progress 的进度被夹到 99：完成只能由 done 表达（C8）', () => {
  const base = statusesOf(['pending'])
  const next = applyStatus(base, 'T1', { status: 'in_progress', progress: 100 })
  assert.equal(next[0].status, 'in_progress')
  assert.equal(next[0].progress, 99, '「正在做」不允许自称 100%')
  assert.ok(next[0].startedAt, '进入 in_progress 仍要记录开始时间')

  const explicit = applyStatus(base, 'T1', { status: 'in_progress', progress: 42 })
  assert.equal(explicit[0].progress, 42, '正常进度不受影响')

  const done = applyStatus(base, 'T1', { status: 'done' })
  assert.equal(done[0].progress, 100, 'done 仍然是 100')
})

test('I10 抓住手工构造的「in_progress + 100%」', () => {
  const plan = planWith(['in_progress'])
  const statuses = createStatuses(plan).map((item: any) => ({ ...item, status: 'in_progress', progress: 100 }))
  const snapshot = derivePlanSnapshot(statuses)
  const violations = aggregateInvariantViolations(snapshot, 'executing')
  assert.ok(
    violations.some((line: string) => line.startsWith('I10')),
    `expected an I10 violation, got ${JSON.stringify(violations)}`,
  )
})

test('I8/I10 对合法组合保持静默', () => {
  const statuses = statusesOf(['done', 'in_progress']).map((item: any) =>
    item.status === 'in_progress' ? { ...item, progress: 40 } : item,
  )
  const snapshot = derivePlanSnapshot(statuses)
  assert.deepEqual(aggregateInvariantViolations(snapshot, 'executing'), [])
})

// ─────────────────────────────── 渲染层 ───────────────────────────────

function stage(id: string, name: string, subtasks: any[]) {
  return {
    id,
    name,
    goal: `${name}目标`,
    checkpoint: `${name}检查点`,
    subtasks: subtasks.map((item: any) => ({
      role: '工程师',
      objective: `${item.title}的目标`,
      method: ['执行'],
      inputs: [],
      outputs: ['产出'],
      acceptance: ['满足验收'],
      risk: '风险',
      dependsOn: [],
      ...item,
    })),
  }
}

function fixture(overrides: any) {
  const statuses = overrides.statuses ?? []
  const snapshot = derivePlanSnapshot(statuses)
  return {
    sessionId: 's-render',
    title: '完成语义渲染回归',
    phase: 'executing',
    stats: snapshot.stats,
    departments: snapshot.departments,
    taskUnderstanding: { deliverable: '一份可复核的结论' },
    contradictions: { primary: { statement: '', evidence: [], whyPrimary: '' }, secondary: [], transformationConditions: [] },
    stages: [],
    statuses,
    risks: [],
    verification: [],
    practiceLoop: null,
    errors: [],
    updatedAt: Date.now(),
    ...overrides,
  }
}

class Component {
  props: any
  constructor(props: any) { this.props = props }
  render() { return this.props?.children ?? null }
}

/**
 * 渲染器：与 tests/client-render.test.ts 同源，但**保留所有属性**（class /
 * data-* / style），这样断言能精确读到 `data-state`、`data-width`、`data-percent`，
 * 而不是在整页 HTML 里做子串匹配。
 */
function makeRender(sessions: any[]) {
  const stateFixture = { loading: false, sessions, error: null, updatedAt: Date.now() }
  // 只让面板自己的第一个 useState 拿到数据快照；其余（openSessionId、折叠态等）
  // 必须拿各自的初始值，否则 Collapse 会把整个 sessions 数组当成 true。
  let firstState = true
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
  const attr = (key: string, value: any): string => {
    if (key === 'children' || value === null || value === undefined || value === false) return ''
    if (key === 'className') return ` class="${String(value)}"`
    if (key === 'style') {
      const css = Object.entries(value || {}).map(([k, v]) => `${k}:${v}`).join(';')
      return css ? ` style="${css}"` : ''
    }
    if (key === 'key') return ''
    if (/^[a-z-]+$/.test(key)) return ` ${key}="${String(value)}"`
    return ''
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
    const props = node.props || {}
    const attrs = Object.entries(props).map(([key, value]) => attr(key, value)).join('')
    return `<${tag}${attrs}>${(node.children || []).map(render).join('')}</${tag}>`
  }
  return { render, ReactStub }
}

async function renderDashboard(sessions: any[]) {
  let loaded: any = null
  ;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  const { render, ReactStub } = makeRender(sessions)
  const clientPath = path.resolve(process.cwd(), 'client.js')
  await import(`${pathToFileURL(clientPath).href}?semantics=${Date.now()}-${Math.random()}`)
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
  const mod = loaded.factory(() => ReactStub)
  const locales: any = {}
  const t = (key: string) => locales.zh?.[key] ?? key
  let mainComponent: any = null
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
  return { html, t }
}

function textOf(html: string, re: RegExp): string {
  const match = html.match(re)
  assert.ok(match, `render did not contain ${re}`)
  return String(match![1]).replace(/<[^>]+>/g, '').trim()
}

test('C2：单任务正在做时，不再说「没有下一步，这件事已完成」', async () => {
  const statuses = statusesOf(['in_progress']).map((item: any) => ({ ...item, progress: 40, startedAt: 1 }))
  const { html } = await renderDashboard([
    fixture({
      stages: [stage('S1', '唯一阶段', [{ id: 'T1', title: '唯一一步', department: 'engineering' }])],
      statuses,
    }),
  ])
  assert.equal(textOf(html, /<span class="dsh-wp-planviz-now-text">([^<]*)<\/span>/), '正在做 · 唯一一步')
  assert.equal(html.includes('没有下一步，这件事已完成'), false, '执行中不得宣布完成')
  assert.ok(html.includes('等这一步做完'), '应告诉读者在等当前这一步')
})

test('C5：部分完成时「现在」说还剩几项，而不是「还没开始」', async () => {
  const statuses = statusesOf(['done', 'pending'])
  const { html } = await renderDashboard([
    fixture({
      stages: [stage('S1', '唯一阶段', [
        { id: 'T1', title: '第一步', department: 'engineering' },
        { id: 'T2', title: '第二步', department: 'engineering' },
      ])],
      statuses,
    }),
  ])
  assert.equal(textOf(html, /<span class="dsh-wp-planviz-now-text">([^<]*)<\/span>/), '还剩 1 项')
  assert.equal(html.includes('没有下一步，这件事已完成'), false)
})

test('C11：0/0 的降级计划说「还没有安排任何工作」', async () => {
  const { html } = await renderDashboard([
    fixture({
      phase: 'degraded',
      plan: null,
      stages: [],
      statuses: [],
      stats: { total: 0, done: 0, blocked: 0, inProgress: 0, pending: 0, progress: 0 },
    }),
  ])
  assert.equal(html.includes('没有下一步，这件事已完成'), false, '没有计划不等于已完成')
  assert.ok(html.includes('还没有安排任何工作'))
})

test('C7：阶段条宽度只按 done 计，blocked 不再把条填满', async () => {
  const statuses = statusesOf(['done', 'blocked', 'pending'])
  const { html } = await renderDashboard([
    fixture({
      stages: [
        stage('S1', '第一阶段', [
          { id: 'T1', title: '完成的一步', department: 'engineering' },
          { id: 'T2', title: '卡住的一步', department: 'engineering' },
        ]),
        stage('S2', '第二阶段', [{ id: 'T3', title: '没开始的一步', department: 'engineering' }]),
      ],
      statuses,
    }),
  ])
  const s1 = html.match(/data-stage-id="S1"[\s\S]{0,600}?data-width="(\d+)"/)
  assert.ok(s1, 'stage S1 segment must expose data-width')
  assert.equal(Number(s1![1]), 50, '1/2 做完就是 50%，blocked 不计入完成度')
})

test('C9/C13：阶段卡与阶段行同说「还剩 N 项」；0% 未开始不再标 active', async () => {
  const statuses = statusesOf(['done', 'pending'])
  const partial = await renderDashboard([
    fixture({
      stages: [stage('S1', '唯一阶段', [
        { id: 'T1', title: '第一步', department: 'engineering' },
        { id: 'T2', title: '第二步', department: 'engineering' },
      ])],
      statuses,
    }),
  ])
  // 阶段卡徽章、阶段行摘要、卡片「现在」三处都应是「还剩 1 项」，不再出现
  // 「阶段行说正在做 / 阶段卡说还没开始」的分叉。
  const occurrences = partial.html.split('还剩 1 项').length - 1
  assert.ok(occurrences >= 2, `expected the same phrase in stage card + now, got ${occurrences}`)

  const idle = await renderDashboard([
    fixture({ statuses: statusesOf(['pending', 'pending']) }),
  ])
  assert.match(
    idle.html,
    /class="dsh-wp-planviz" data-percent="0"[^>]*data-state="idle"/,
    '0% 且没人开始应是 idle，不是 active',
  )
})
