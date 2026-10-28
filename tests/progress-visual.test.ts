import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * v1.5.0 进度图表化回归（设计稿 `docs/progress-visualization-design-20261028.md` A1–A12）。
 *
 * 锁定的不是「好不好看」，而是每条可测的可见性契约：
 * 1. 折叠卡默认视图里，0% 有四个独立可见信号：环（加粗零轨）、24px「0%」数字、
 *    一整条「还没开始」构成条、阶段步进条；数字不再只藏在 title 提示里。
 * 2. 有进度时：`data-percent` 是四舍五入后的整数，环画 SVG dash 弧，四段构成条
 *    的件数之和恒等于 total（不会溢出 100%）。
 * 3. 有卡住项时：`data-alarm="true"`、可见「N 卡住了」、对应阶段 `data-tone="blocked"`。
 * 4. 阶段步进条：每个阶段一个 [data-stage-id]，且恰好一个 data-current="true"。
 * 5. 图例恰好四项（做好了/正在做/卡住了/还没开始），顺序固定。
 * 6. 折叠态不挂载「分步进度」面板（展开才渲染），卡头不引入 canvas 或图表库。
 * 7. 脏数据（done>total、负数、非数字、缺失）不产生 NaN/Infinity/undefined，也不超 100%。
 */

const STAGES: any[] = [
  {
    id: 'S1', name: '定位', goal: '找到画圈处的源码', checkpoint: '定位清单',
    subtasks: [subtask('T1', '列出文件'), subtask('T2', '读取源码'), subtask('T3', '整理结论')],
  },
  {
    id: 'S2', name: '改造', goal: '把文字换成图表', checkpoint: '类型检查通过',
    subtasks: [subtask('T4', '改客户端'), subtask('T5', '加图表'), subtask('T6', '接面板')],
  },
  {
    id: 'S3', name: '验证', goal: '证明改后更醒目', checkpoint: '测试全绿',
    subtasks: [subtask('T7', '跑测试'), subtask('T8', '截图对比')],
  },
]

function subtask(id: string, title: string): any {
  return {
    id,
    title,
    department: 'engineering',
    role: '工程师',
    objective: `完成${title}`,
    method: ['执行'],
    inputs: [],
    outputs: ['产出'],
    dependsOn: [],
    acceptance: ['可验收'],
    risk: '—',
  }
}

function session(overrides: any): any {
  return {
    sessionId: 'zeroplan',
    title: '0/8 计划',
    phase: 'executing',
    planId: 'p1',
    createdAt: 1,
    updatedAt: 1,
    stats: { total: 8, done: 0, blocked: 0, inProgress: 1, pending: 7, progress: 0 },
    departments: [],
    taskUnderstanding: {},
    contradictions: { primary: null, secondary: [], transformationConditions: [] },
    stages: STAGES,
    statuses: [{ subtaskId: 'T1', status: 'in_progress' }],
    risks: [],
    verification: [],
    practiceLoop: null,
    errors: [],
    ...overrides,
  }
}

/** Render the dashboard main component with a fixed data fixture and return HTML. */
async function renderDashboard(sessions: any[]) {
  let loaded: any = null
  ;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', setAttribute: () => {} }),
    head: { appendChild: () => {} },
  }

  const stateFixture = { loading: false, sessions, error: null, updatedAt: Date.now() }
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

  // 只输出 primitive 属性：与真实 DOM 一样，data-* 与可见文本是唯一可断言面。
  function render(node: any): string {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node.type === 'function') {
      const isClass = node.type.prototype && node.type.prototype.render
      if (isClass) return render(new node.type(node.props).render())
      return render(node.type(node.props))
    }
    let attrs = ''
    for (const [key, value] of Object.entries(node.props || {})) {
      if (key === 'children' || value === undefined || value === null) continue
      if (typeof value === 'function' || typeof value === 'object') continue
      attrs += ` ${key}="${String(value).replace(/"/g, '&quot;')}"`
    }
    return `<${node.type}${attrs}>${(node.children || []).map(render).join('')}</${node.type}>`
  }

  const clientPath = path.resolve(process.cwd(), 'client.js')
  await import(`${pathToFileURL(clientPath).href}?progress-visual=${Date.now()}${Math.random()}`)
  assert.ok(loaded, 'client.js must register itself through window.__ModuleLoader__')
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
  return render(ReactStub.createElement(mainComponent, { t }))
}

/** 截出单张计划卡的 HTML：从它的 data-session-id 起，到下一张卡/下一个组为止。 */
function cardSlice(html: string, sessionId: string): string {
  const marker = `data-session-id="${sessionId}"`
  const start = html.indexOf(marker)
  assert.notEqual(start, -1, `session card ${sessionId} must be rendered`)
  const rest = html.slice(start + marker.length)
  const ends = [rest.indexOf('data-session-id="'), rest.indexOf('data-group="')].filter((index) => index >= 0)
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest
}

function segmentsOf(card: string): Array<{ kind: string; count: number }> {
  return [...card.matchAll(/dsh-wp-planviz-seg" data-kind="([a-z]+)" data-count="(\d+)"/g)]
    .map((match) => ({ kind: match[1], count: Number(match[2]) }))
}

test('a 0/8 plan exposes four visible signals in the collapsed card', async () => {
  const html = await renderDashboard([session({})])
  const card = cardSlice(html, 'zeroplan')

  // 信号 1：环仍然可见（0% 不画弧，但零轨加粗），并带机读标记。
  assert.ok(card.includes('data-zero="true"'), 'a real 0% ring must be marked')
  assert.equal(card.includes('strokeDasharray'), false, '0% must not draw an arc (no stray round-cap dot)')
  // 信号 2：百分比是 24px 的可见文本，不再只藏在 title 提示里。
  assert.ok(card.includes('dsh-wp-planviz-pct">0%<'), 'the rate must be readable as text')
  assert.equal(card.includes('title="0%"'), false, 'the rate must not exist only as a tooltip')
  // 信号 3：整条构成条是「还没开始」，并有可见图例。
  assert.ok(card.includes('data-kind="pending" data-count="7"'), 'the pending share must be a sized segment')
  assert.ok(card.includes('本计划 0/8 做好了'), 'the fraction stays visible as text')
  // 信号 4：阶段步进条。
  assert.ok(card.includes('dsh-wp-planviz-head'), 'head block must be rendered')
  assert.ok(card.includes('dsh-wp-planviz-bar'), 'composition bar must be rendered')
  assert.ok(card.includes('dsh-wp-stepper'), 'stage stepper must be rendered')
  assert.ok(card.includes('卡住了 0'), 'the blocked count stays visible in the legend')
})

test('3 of 8 renders 38% and segments that add up to the plan total', async () => {
  const html = await renderDashboard([
    session({
      sessionId: 'partial',
      stats: { total: 8, done: 3, blocked: 0, inProgress: 0, pending: 5, progress: 37.5 },
      statuses: [
        { subtaskId: 'T1', status: 'done' },
        { subtaskId: 'T2', status: 'done' },
        { subtaskId: 'T3', status: 'done' },
      ],
    }),
  ])
  const card = cardSlice(html, 'partial')
  assert.ok(card.includes('data-percent="38"'), 'the rate is rounded once, not floored or repeated')
  assert.ok(card.includes('dsh-wp-planviz-pct">38%<'), 'the rounded rate is also visible text')
  assert.ok(card.includes('strokeDasharray'), 'a non-zero rate must draw the arc')
  const segments = segmentsOf(card)
  assert.equal(segments.reduce((sum, segment) => sum + segment.count, 0), 8, 'segments must add up to total')
  assert.deepEqual(segments.map((segment) => segment.kind), ['done', 'pending'], 'only non-empty kinds get a segment')
})

test('a blocked item raises an alarm, names it, and marks its stage', async () => {
  const html = await renderDashboard([
    session({
      sessionId: 'blocked',
      stats: { total: 8, done: 1, blocked: 1, inProgress: 0, pending: 6, progress: 12.5 },
      statuses: [
        { subtaskId: 'T1', status: 'done' },
        { subtaskId: 'T4', status: 'blocked' },
      ],
    }),
  ])
  const card = cardSlice(html, 'blocked')
  assert.ok(card.includes('data-alarm="true"'), 'a blocked item must be machine-detectable')
  assert.ok(card.includes('1 卡住了'), 'the alarm states the count')
  assert.ok(card.includes('data-tone="blocked"'), 'the stage holding the blocked item must be marked')
  // 2C：一行「现在在做什么」——卡住优先，并带上具体任务名。
  assert.ok(card.includes('卡住了 · 改客户端'), 'the now-line must name the blocked task')
})

test('the step stepper draws one segment per stage with exactly one current stage', async () => {
  const html = await renderDashboard([session({})])
  const card = cardSlice(html, 'zeroplan')
  assert.ok(card.includes('data-stages="3"'), 'the stepper exposes the stage count')
  const stageIds = [...card.matchAll(/data-stage-id="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(stageIds, ['S1', 'S2', 'S3'], 'one segment per stage, in plan order')
  const current = [...card.matchAll(/data-current="true"/g)]
  assert.equal(current.length, 1, 'exactly one stage is current')
})

test('the legend lists the four buckets once, in a fixed order', async () => {
  const html = await renderDashboard([session({})])
  const card = cardSlice(html, 'zeroplan')
  const legend = [...card.matchAll(/dsh-wp-planviz-legend-item" data-kind="([a-z]+)" data-count="(\d+)"/g)]
  assert.deepEqual(legend.map((match) => match[1]), ['done', 'active', 'blocked', 'pending'])
  assert.deepEqual(legend.map((match) => Number(match[2])), [0, 1, 0, 7], 'legend counts must match the stats')
})

test('the collapsed card does not mount the step breakdown; opening it does', async () => {
  const html = await renderDashboard([session({})])
  assert.equal(cardSlice(html, 'zeroplan').includes('dsh-wp-planoverview'), false, 'collapsed card must stay compact')
  // 展开态由真实点击驱动，HTML 夹具里无法点击；这里锁定渲染分支本身存在，
  // 交互部分由 tests/session-collapse.test.ts 的折叠行为覆盖。
  const source = await readFile(path.resolve(process.cwd(), 'src/client.ts'), 'utf8')
  assert.ok(source.includes('open === true ? h(PlanOverview'), 'the open branch must render the breakdown')
  assert.ok(source.includes("t('vizStageTitle')"), 'the breakdown must be labelled')
})

test('dirty stats never render NaN / Infinity / undefined / >100%', async () => {
  const html = await renderDashboard([
    session({
      sessionId: 'dirty',
      stats: { total: 8, done: 99, blocked: -2, inProgress: 'x', pending: null, progress: 150 },
    }),
    session({ sessionId: 'empty', stats: undefined, stages: [], statuses: [] }),
  ])
  for (const bad of ['NaN', 'Infinity', 'undefined', '[object Object]']) {
    assert.equal(html.includes(bad), false, `dashboard must not render ${bad}`)
  }
  const card = cardSlice(html, 'dirty')
  assert.ok(card.includes('data-percent="100"'), 'done > total must clamp to 100%, never 1238%')
  for (const match of card.matchAll(/data-percent="(\d+)"/g)) {
    assert.ok(Number(match[1]) <= 100, `no rate may exceed 100%, got ${match[1]}%`)
  }
  assert.ok(card.includes('data-zero="false"'), '100% is not a zero state')
  const empty = cardSlice(html, 'empty')
  assert.ok(empty.includes('dsh-wp-planviz-pct">—<'), 'a 0/0 plan shows an em dash, not 0% or NaN')
  assert.ok(empty.includes('data-percent="none"'), 'an unknown rate is exposed as none')
  assert.equal(segmentsOf(empty).length, 0, 'a 0/0 plan has no segments to draw')
})

test('the card header stays dependency-free: no canvas, no chart library', async () => {
  const html = await renderDashboard([session({})])
  const card = cardSlice(html, 'zeroplan')
  assert.equal(card.includes('<canvas'), false, 'the header must not need a canvas')
  assert.equal(card.includes('Chart.'), false, 'the header must not need chart.js')
})
