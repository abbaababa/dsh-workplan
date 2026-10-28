import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * T6 regression.
 *
 * What is locked here (each item is a measurable acceptance property, not a look):
 * 1. a group header always renders a plain-text sentence
 *    `未完成 N / 已完成 M（完成率 x%）` — readable without opening the group and
 *    without relying on color;
 * 2. `total = 0` renders `完成率暂无数据` and `data-percent="none"`, never
 *    `NaN` / `Infinity` (a degraded plan can legitimately have zero work items);
 * 3. dirty stats cannot leak into the header: non-numeric / negative totals count
 *    as 0 and `done > total` is clamped, so the ring never exceeds 100%;
 * 4. the disclosure button's `aria-label` carries the complete sentence (counts,
 *    rate and the three status buckets), not just "展开";
 * 5. the progress indicator is one inline `<svg>` ring with `<circle>` strokes —
 *    no canvas, no third-party chart library.
 */

const baseSession: any = {
  sessionId: 's1',
  title: 'TypeScript 使用范围核验',
  phase: 'executing',
  planId: 'p1',
  createdAt: 1000,
  updatedAt: 1000,
  stats: { total: 4, done: 1, blocked: 1, inProgress: 1, pending: 1, progress: 25 },
  departments: [{ id: 'engineering', done: 0, total: 2, blocked: 0 }],
  taskUnderstanding: { deliverable: '一份基于证据的核验结果' },
  contradictions: { primary: null, secondary: [], transformationConditions: [] },
  stages: [{
    id: 'S1', name: '盘点', goal: '确认范围', checkpoint: '核对清单',
    subtasks: [{
      id: 'T1', title: '列出文件', department: 'engineering', role: '工程师',
      objective: '列出源码', method: ['扫描目录'], inputs: [], outputs: ['清单'],
      dependsOn: [], acceptance: ['清单完整'], risk: '遗漏',
    }],
  }],
  statuses: [{ subtaskId: 'T1', status: 'running' }],
  risks: [],
  verification: [],
  practiceLoop: null,
  errors: [],
}

function session(overrides: any) {
  return { ...baseSession, ...overrides }
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

  // Emits every primitive prop as an attribute (`aria-expanded={false}` included),
  // so the assertions below see state and ARIA exactly as the DOM would.
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
  await import(`${pathToFileURL(clientPath).href}?group-summary=${Date.now()}${Math.random()}`)
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

/** Slice a single group section out of the HTML (the live group renders first). */
function groupSlice(html: string, group: 'live' | 'done') {
  const start = html.indexOf(`data-group="${group}"`)
  assert.notEqual(start, -1, `${group} group must be rendered`)
  const nextMarker = group === 'live' ? 'data-group="done"' : 'data-group="live"'
  const end = html.indexOf(nextMarker, start + 1)
  return end === -1 ? html.slice(start) : html.slice(start, end)
}

function assertNoBrokenNumbers(html: string) {
  for (const bad of ['NaN', 'Infinity', 'undefined', '[object Object]']) {
    assert.equal(html.includes(bad), false, `dashboard must not render ${bad}`)
  }
}

test('each group header states 未完成 / 已完成 / 完成率 in plain text', async () => {
  const html = await renderDashboard([
    session({ sessionId: 'live', phase: 'executing', stats: { total: 4, done: 1, blocked: 1, inProgress: 1, pending: 1, progress: 25 } }),
    session({ sessionId: 'done', phase: 'done', stats: { total: 3, done: 3, blocked: 0, inProgress: 0, pending: 0, progress: 100 } }),
  ])
  assertNoBrokenNumbers(html)
  // live group: 4 work items, 1 done -> 3 open, 25%
  assert.ok(html.includes('未完成 3 / 已完成 1（完成率 25%）'), 'in-progress group must show its own counts and rate')
  // completed group: 3 work items, all done -> 100%
  assert.ok(html.includes('未完成 0 / 已完成 3（完成率 100%）'), 'completed group must show its own counts and rate')
  // the numbers are also machine-checkable on the section element
  const live = groupSlice(html, 'live')
  const done = groupSlice(html, 'done')
  assert.ok(live.includes('data-total="4"') && live.includes('data-done="1"'), 'live section must expose its totals')
  assert.ok(live.includes('data-percent="25"'), 'live section must expose the rounded rate')
  assert.ok(done.includes('data-total="3"') && done.includes('data-done="3"'), 'done section must expose its totals')
  assert.ok(done.includes('data-percent="100"'), 'done section must expose the rounded rate')
})

test('the indicator is one inline SVG ring with a text label, no canvas', async () => {
  const html = await renderDashboard([
    session({ stats: { total: 4, done: 1, blocked: 0, inProgress: 1, pending: 2, progress: 25 } }),
  ])
  const live = groupSlice(html, 'live')
  assert.ok(live.includes('<svg viewBox="0 0 44 44"'), 'group header must render a 44px inline SVG ring')
  assert.ok(live.includes('dsh-wp-group-ring-track'), 'ring must have a track circle')
  assert.ok(live.includes('strokeDasharray'), 'ring must draw progress as an SVG dash arc')
  assert.ok(live.includes('dsh-wp-group-ring-label">25%<'), 'the rate must also exist as text inside the ring')
  // chart.js draws elsewhere in the panel; the group header must stay pure SVG
  assert.equal(live.includes('<canvas'), false, 'the group header ring must not use a canvas fallback')

  // 0% must not draw the arc at all (avoids a stray dot from the round line cap)
  const zero = await renderDashboard([
    session({ stats: { total: 2, done: 0, blocked: 0, inProgress: 2, pending: 0, progress: 0 } }),
  ])
  assert.ok(zero.includes('未完成 2 / 已完成 0（完成率 0%）'), '0% must render as a plain number')
  assert.equal(groupSlice(zero, 'live').includes('strokeDasharray'), false, '0% must not draw the arc')
})

test('zero work items renders a dash instead of 0/0 or NaN', async () => {
  const html = await renderDashboard([
    session({ sessionId: 'empty-plan', phase: 'degraded', stats: { total: 0, done: 0, blocked: 0, inProgress: 0, pending: 0, progress: 0 } }),
  ])
  assertNoBrokenNumbers(html)
  // v1.5.0（用户 Q3）：删掉「未完成 0 / 已完成 0（完成率暂无数据）」这行 0/0；
  // 环上已经是「—」，组内空态也已说明没有工作项，重复一遍只是噪声。
  assert.equal(html.includes('完成率暂无数据'), false, 'empty denominator must not print a 0/0 sentence')
  assert.ok(html.includes('data-percent="none"'), 'unknown rate must be exposed as none, not 0')
  assert.ok(html.includes('dsh-wp-group-ring-label">—<'), 'unknown rate must render an em dash, not a bogus percentage')
  // 「暂无数据」与「0%」必须是两种视觉状态：这里既没有组内工作项，卡片也是 0/0，
  // 所以两边都只能是「—」；真正的 0/8 由 progress-visual.test.ts 覆盖。
  assert.ok(html.includes('data-zero="false"'), 'a group without work items must not be marked as a real 0%')
  assert.equal(html.includes('data-zero="true"'), false, 'no surface in this fixture has a real 0% rate')
  assert.ok(html.includes('dsh-wp-planviz-pct">—<'), 'the plan card must show an em dash instead of 0%')
})

test('dirty stats are clamped: done never exceeds total, negatives count as zero', async () => {
  const html = await renderDashboard([
    session({ sessionId: 'over', phase: 'done', stats: { total: 2, done: 5, blocked: 0, inProgress: 0, pending: 0, progress: 150 } }),
    session({ sessionId: 'negative', phase: 'executing', stats: { total: -3, done: -1, blocked: 0, inProgress: 0, pending: 0, progress: 0 } }),
    session({ sessionId: 'missing', phase: 'executing', stats: undefined }),
  ])
  assertNoBrokenNumbers(html)
  // completed group: 2 items, done clamped from 5 to 2 -> 100% (never 250%)
  const done = groupSlice(html, 'done')
  assert.ok(done.includes('未完成 0 / 已完成 2（完成率 100%）'), 'done must be clamped to total')
  assert.ok(done.includes('data-percent="100"'), 'clamped rate must be exposed as 100')
  // live group: negative and missing stats must be treated as zero, not poison the sum.
  // v1.5.0: a 0/0 group no longer prints a sentence at all (user Q3) — the ring is "—".
  assert.equal(html.includes('完成率暂无数据'), false, 'negative/missing stats must not resurrect the 0/0 sentence')
  assert.ok(html.includes('dsh-wp-group-ring-label">—<'), 'a group with no work items must show an em dash')
  // the header ring never shows more than 100% (per-card percentages are another component)
  for (const match of html.matchAll(/dsh-wp-group-ring-label">(\d+)%</g)) {
    assert.ok(Number(match[1]) <= 100, `group rate must stay inside 0..100, got ${match[1]}%`)
  }
})

test('the disclosure button announces the full summary, not just 展开', async () => {
  const html = await renderDashboard([
    session({ sessionId: 'live', phase: 'executing' }),
    session({ sessionId: 'done', phase: 'done', stats: { total: 3, done: 3, blocked: 0, inProgress: 0, pending: 0, progress: 100 } }),
  ])
  const done = groupSlice(html, 'done')
  // the completed group is collapsed by default while live work exists
  assert.ok(done.includes('aria-expanded="false"'), 'completed group must start folded')
  const label = done.match(/aria-label="([^"]*已完成组[^"]*)"/)
  assert.ok(label, 'folding button must carry a group aria-label')
  const text = label![1]
  assert.ok(text.startsWith('展开。'), 'aria-label must still start with the action, got: ' + text)
  assert.ok(text.includes('1 个计划'), 'aria-label must state the plan count')
  assert.ok(text.includes('共 3 件具体工作'), 'aria-label must state the work item count')
  assert.ok(text.includes('已完成 3 件'), 'aria-label must state the done count')
  assert.ok(text.includes('完成率 100%'), 'aria-label must state the rate')
  assert.ok(text.includes('卡住 0 件'), 'aria-label must state the blocked count')
})

test('the collapsed body keeps its cards in the DOM (no unmount)', async () => {
  const html = await renderDashboard([
    session({ sessionId: 'live', phase: 'executing' }),
    session({ sessionId: 'done', phase: 'done', title: '已收尾的计划', stats: { total: 3, done: 3, blocked: 0, inProgress: 0, pending: 0, progress: 100 } }),
  ])
  assert.ok(html.includes('dsh-wp-group-body--folded'), 'completed body must be folded by default')
  // the card of the folded group is still rendered: folding must not unmount it
  assert.ok(html.includes('dsh-wp-session-done'), 'folded group body must keep its session cards in the DOM')
})
