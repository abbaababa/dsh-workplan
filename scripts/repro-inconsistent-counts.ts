#!/usr/bin/env node
/**
 * T2 minimal reproduction — aggregate counts vs live statuses in dsh-workplan.
 *
 * What this proves (all values are read from the code that ships in `lib/` and
 * `client.js`, not from a mock of them). Defect ids match
 * docs/defect-report-count-inconsistency.md:
 *
 *   D1 / scenario A. STATS FREEZE — during the second concurrency wave
 *      `record.stats` is the snapshot written at the end of wave 1, while
 *      `statuses` keep changing. One payload therefore says
 *      `0 正在做 / 2 还没开始` while one subtask is already done and another is
 *      running.
 *   D2 / scenario A. SELF-CONTRADICTION — the same payload's `departments` are
 *      aggregated from live `statuses`, so `stats.inProgress = 0` sits next to
 *      `departments[].inProgress = 1`.
 *   D3 / scenario B. BUDGET PAUSE — running out of the round budget rewrites
 *      unfinished subtasks as `pending` but keeps `progress: 100`, `childId`
 *      and `startedAt`, and leaves `stats.progress = 100` with `done = 0`.
 *   D4 / scenario C. RESUME — clearing blocked/in_progress back to `pending`
 *      does not recompute `stats`, so a resumed plan still reports `2 卡住了`
 *      while nothing is blocked.
 *   UI — the dashboard renders both halves at once: the top stat bar and the
 *      card meta line read the frozen `stats`, while the stage badge and the
 *      subtask pills read live `statuses`.
 *
 * Usage
 *   node scripts/repro-inconsistent-counts.ts
 *       Current build. Every defect must reproduce; exit 0 means "reproduced".
 *   node scripts/repro-inconsistent-counts.ts --expect-fixed
 *       Run after the T3 fix. Asserts the single-source invariants instead;
 *       exit 0 means "fixed".
 *
 * Only in-memory functions are called: no service restart, no build, no HTTP.
 * `plansPayload()` is the exact serialiser used by the `/dsh-workplan/plans`
 * route; the route itself is not called because it rejects non-browser callers
 * with HTTP 401 (see docs/defect-report-count-inconsistency.md).
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStatuses, computeStats } from '../lib/plan.js'
import { createWorkplanRuntime, dispatchPlan } from '../lib/runtime.js'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXPECT_FIXED = process.argv.includes('--expect-fixed')
const keepAlive = setInterval(() => {}, 1000)

let failures = 0
function check(name: string, ok: boolean, detail: string) {
  const verdict = ok ? 'PASS' : 'FAIL'
  console.log(`[${verdict}] ${name} — ${detail}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(5)
  }
  return false
}

function subtask(id: string, department: string, dependsOn: string[] = []) {
  return {
    id,
    title: `步骤 ${id}`,
    department,
    role: '工程师',
    objective: `完成 ${id}`,
    method: ['执行'],
    inputs: [],
    outputs: ['结果'],
    dependsOn,
    acceptance: ['通过'],
    risk: '无',
  }
}

function makePlan(planId: string, stages: any[]) {
  return { planId, sessionId: `session-${planId}`, createdTurn: 1, createdAt: 1000, title: '计数一致性复现', stages }
}

function makeSession(id: string) {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt(index: number) { return events[index] },
    events,
  }
}

function makeCtx(session: any, startActivation: (spec: any) => any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation },
    sessions: { get: () => undefined, list: () => [session], eventAt: () => undefined },
  }
}

function makeRecord(plan: any): any {
  // Mirrors the live createPlan record (src/runtime.ts:1619-1628) *exactly*:
  // no `stats` field. The first wave end writes it (src/runtime.ts:760), and
  // that write is what freezes during every later wave.
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    createdAt: 1000,
    updatedAt: Date.now(),
    resultWritten: false,
  }
}

function quickChild() {
  return {
    childId: 'child-quick',
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '完成' }] }),
    dispose: async () => {},
  }
}

function hangingChild() {
  return { childId: 'child-hang', result: new Promise(() => {}), dispose: async () => {} }
}

function dispatchOptions(session: any, signal: AbortSignal, totalTimeoutMs = 600000) {
  return {
    agent: { session, options: {} },
    signal,
    idleTimeoutMs: 600000,
    childTimeoutMs: 600000,
    totalTimeoutMs,
  }
}

function countsOf(statuses: any[]) {
  return {
    done: statuses.filter((item) => item.status === 'done').length,
    blocked: statuses.filter((item) => item.status === 'blocked').length,
    inProgress: statuses.filter((item) => item.status === 'in_progress').length,
    pending: statuses.filter((item) => item.status === 'pending').length,
  }
}

function departmentsOf(statuses: any[]) {
  const map = new Map<string, any>()
  for (const item of statuses) {
    const current = map.get(item.department) ?? {
      id: item.department,
      total: 0,
      done: 0,
      blocked: 0,
      inProgress: 0,
    }
    current.total += 1
    if (item.status === 'done') current.done += 1
    if (item.status === 'blocked') current.blocked += 1
    if (item.status === 'in_progress') current.inProgress += 1
    map.set(item.department, current)
  }
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/* ------------------------------------------------------------------ */
/* Scenario A: second wave, one quick child + one hanging child        */
/* ------------------------------------------------------------------ */

async function scenarioFrozenDuringSecondWave() {
  const plan = makePlan('wp-repro-stats-freeze', [
    { id: 'S1', name: '第一波', goal: 'g', checkpoint: 'c', subtasks: [subtask('T1', 'engineering')] },
    {
      id: 'S2',
      name: '第二波',
      goal: 'g',
      checkpoint: 'c',
      subtasks: [subtask('T2', 'qa', ['T1']), subtask('T3', 'design', ['T1'])],
    },
  ])
  const record = makeRecord(plan)
  const session = makeSession(`session-${plan.planId}`)
  const start = (spec: any) => (spec.label.includes('T3') ? hangingChild() : quickChild())
  const ctx = makeCtx(session, start)
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 600000 })
  runtime.state.records.set(session.id, record)
  const controller = new AbortController()
  const running = dispatchPlan(ctx, record, dispatchOptions(session, controller.signal))
  const reached = await waitFor(() => {
    const t2 = record.statuses.find((item: any) => item.subtaskId === 'T2')
    const t3 = record.statuses.find((item: any) => item.subtaskId === 'T3')
    return t2?.status === 'done' && t3?.status === 'in_progress'
  })
  if (!reached) throw new Error('scenario A did not reach the expected wave-2 state')
  const payload = runtime.plansPayload(session.id).sessions[0]
  controller.abort()
  await running.catch(() => {})
  return { plan, record, payload }
}

/* ------------------------------------------------------------------ */
/* Scenario B: round budget exhausted while one child is running       */
/* ------------------------------------------------------------------ */

async function scenarioBudgetPause() {
  const plan = makePlan('wp-repro-budget-pause', [
    { id: 'S1', name: '唯一波', goal: 'g', checkpoint: 'c', subtasks: [subtask('T1', 'engineering')] },
  ])
  const record = makeRecord(plan)
  const session = makeSession(`session-${plan.planId}`)
  const start = () => hangingChild()
  const ctx = makeCtx(session, start)
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 600000 })
  runtime.state.records.set(session.id, record)
  // dispatchPlan clamps the round timer to >= 1000 ms; 350 ms is enough to see
  // the pause branch without waiting a minute.
  await dispatchPlan(ctx, record, dispatchOptions(session, new AbortController().signal, 350))
  const payload = runtime.plansPayload(session.id).sessions[0]
  return { plan, record, payload }
}

/* ------------------------------------------------------------------ */
/* Scenario C: resume a blocked plan; one child hangs after the reset  */
/* ------------------------------------------------------------------ */

async function scenarioResumeBlocked() {
  const plan = makePlan('wp-repro-resume', [
    {
      id: 'S1',
      name: '唯一波',
      goal: 'g',
      checkpoint: 'c',
      subtasks: [subtask('T1', 'engineering'), subtask('T2', 'qa', ['T1'])],
    },
  ])
  const record = makeRecord(plan)
  record.statuses = record.statuses.map((item: any) => ({
    ...item,
    status: 'blocked',
    progress: 0,
    error: item.subtaskId === 'T1' ? '上次失败' : '上游子任务受阻：T1',
  }))
  record.phase = 'blocked'
  record.stats = computeStats(record.statuses)
  record.resumeCount = 0
  const session = makeSession(`session-${plan.planId}`)
  const start = () => hangingChild()
  const ctx = makeCtx(session, start)
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 600000 })
  runtime.state.records.set(session.id, record)
  const controller = new AbortController()
  const running = dispatchPlan(ctx, record, dispatchOptions(session, controller.signal))
  const reached = await waitFor(() => record.statuses.find((item: any) => item.subtaskId === 'T1')?.status === 'in_progress')
  if (!reached) throw new Error('scenario C did not reach the resumed in_progress state')
  const payload = runtime.plansPayload(session.id).sessions[0]
  controller.abort()
  await running.catch(() => {})
  return { plan, record, payload }
}

/* ------------------------------------------------------------------ */
/* Dashboard renderer (same React stub + window loader as the tests)   */
/* ------------------------------------------------------------------ */

async function renderDashboard(sessions: any[]): Promise<string> {
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

  const clientPath = path.resolve(PLUGIN_ROOT, 'client.js')
  await import(`${pathToFileURL(clientPath).href}?t2-repro=${Date.now()}${Math.random()}`)
  if (!loaded) throw new Error('client.js did not register through window.__ModuleLoader__')
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
  if (!mainComponent) throw new Error('dashboard main component was not registered')
  return render(ReactStub.createElement(mainComponent, { t }))
}

function statValue(html: string, label: string): number | null {
  const match = html.match(new RegExp(`dsh-wp-stat-value">(\\d+)</div><div className="dsh-wp-stat-label">${label}</div>`))
  return match ? Number(match[1]) : null
}

function cardMeta(html: string): { progress: number; inProgress: number; pending: number } | null {
  const match = html.match(/总体进度 (\d+)%<\/span><span>(\d+) 正在做 · (\d+) 还没开始<\/span>/)
  if (!match) return null
  return { progress: Number(match[1]), inProgress: Number(match[2]), pending: Number(match[3]) }
}

function donutPercent(html: string): number | null {
  const match = html.match(/<strong>(\d+)%<\/strong><span>做好了<\/span>/)
  return match ? Number(match[1]) : null
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const frozen = await scenarioFrozenDuringSecondWave()
const budget = await scenarioBudgetPause()
const resumed = await scenarioResumeBlocked()

const frozenStats = frozen.payload.stats
const frozenActual = countsOf(frozen.payload.statuses)
const frozenDepartments = departmentsOf(frozen.payload.statuses)
const budgetItem = budget.payload.statuses[0]
const resumeActual = countsOf(resumed.payload.statuses)

console.log('\n=== Observed payloads ===')
console.log('A stats      :', JSON.stringify(frozenStats))
console.log('A actual     :', JSON.stringify(frozenActual), 'progress', Math.round(frozen.payload.statuses.reduce((sum: number, item: any) => sum + item.progress, 0) / frozen.payload.statuses.length))
console.log('A statuses   :', frozen.payload.statuses.map((item: any) => `${item.subtaskId}:${item.status}:${item.progress}`).join(', '))
console.log('A departments:', JSON.stringify(frozen.payload.departments))
console.log('B item       :', JSON.stringify(budgetItem))
console.log('B stats      :', JSON.stringify(budget.payload.stats))
console.log('C stats      :', JSON.stringify(resumed.payload.stats))
console.log('C actual     :', JSON.stringify(resumeActual))
console.log('C statuses   :', resumed.payload.statuses.map((item: any) => `${item.subtaskId}:${item.status}:${item.progress}`).join(', '))

const frozenHtml = await renderDashboard([frozen.payload])
const budgetHtml = await renderDashboard([budget.payload])
const resumeHtml = await renderDashboard([resumed.payload])

console.log('\n=== Observed UI (top bar / card / stage / pills) ===')
console.log('A top done/doing:', statValue(frozenHtml, '做好了'), '/', statValue(frozenHtml, '正在做'))
console.log('A card meta     :', JSON.stringify(cardMeta(frozenHtml)))
console.log('A donut         :', donutPercent(frozenHtml))
console.log('B top done/doing:', statValue(budgetHtml, '做好了'), '/', statValue(budgetHtml, '正在做'))
console.log('B card meta     :', JSON.stringify(cardMeta(budgetHtml)))
console.log('B donut         :', donutPercent(budgetHtml))
console.log('C top blocked   :', statValue(resumeHtml, '卡住了'), 'doing', statValue(resumeHtml, '正在做'))
console.log('C card meta     :', JSON.stringify(cardMeta(resumeHtml)))

if (EXPECT_FIXED) {
  console.log('\n=== Invariants (--expect-fixed) ===')
  check('A: stats are derived from live statuses', JSON.stringify(frozenStats) === JSON.stringify(computeStats(frozen.payload.statuses)),
    `stats=${JSON.stringify(frozenStats)} derived=${JSON.stringify(computeStats(frozen.payload.statuses))}`)
  check('A: departments are derived from live statuses', JSON.stringify([...frozen.payload.departments].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))) === JSON.stringify(frozenDepartments),
    `payload=${JSON.stringify(frozen.payload.departments)} derived=${JSON.stringify(frozenDepartments)}`)
  check('A: top bar matches live counts', statValue(frozenHtml, '做好了') === frozenActual.done && statValue(frozenHtml, '正在做') === frozenActual.inProgress,
    `ui=${statValue(frozenHtml, '做好了')}/${statValue(frozenHtml, '正在做')} actual=${frozenActual.done}/${frozenActual.inProgress}`)
  const metaA = cardMeta(frozenHtml)
  check('A: card meta matches live counts', metaA?.inProgress === frozenActual.inProgress && metaA?.pending === frozenActual.pending,
    `ui=${JSON.stringify(metaA)} actual doing/pending=${frozenActual.inProgress}/${frozenActual.pending}`)
  check('B: no pending item keeps progress/childId/startedAt', budgetItem.status !== 'pending' || (budgetItem.progress === 0 && !budgetItem.childId && !budgetItem.startedAt),
    JSON.stringify({ status: budgetItem.status, progress: budgetItem.progress, childId: budgetItem.childId, startedAt: budgetItem.startedAt }))
  check('B: stats.progress is 0 when nothing is done', budget.payload.stats.progress === 0 && budget.payload.stats.done === 0,
    JSON.stringify(budget.payload.stats))
  check('B: card progress and donut agree after the pause', cardMeta(budgetHtml)?.progress === 0 && donutPercent(budgetHtml) === 0,
    `card=${JSON.stringify(cardMeta(budgetHtml))} donut=${donutPercent(budgetHtml)}`)
  check('C: resumed plan reports no stale blocked count', JSON.stringify(resumed.payload.stats) === JSON.stringify(computeStats(resumed.payload.statuses)),
    `stats=${JSON.stringify(resumed.payload.stats)} derived=${JSON.stringify(computeStats(resumed.payload.statuses))}`)
  check('C: UI blocked count matches live statuses', statValue(resumeHtml, '卡住了') === resumeActual.blocked,
    `ui=${statValue(resumeHtml, '卡住了')} actual=${resumeActual.blocked}`)
} else {
  console.log('\n=== Reproduction assertions (buggy build) ===')
  check('A: frozen stats say 0 doing / 2 pending', frozenStats.inProgress === 0 && frozenStats.pending === 2, JSON.stringify(frozenStats))
  check('A: actual state is 1 doing / 0 pending, one more done', frozenActual.inProgress === 1 && frozenActual.pending === 0 && frozenActual.done === 2, JSON.stringify(frozenActual))
  check('A: same payload contradicts itself (stats.done=1, qa.done=1)', frozenStats.done === 1 && frozenDepartments.find((d) => d.id === 'qa')?.done === 1, JSON.stringify(frozenDepartments))
  check('A: same payload contradicts itself (stats.inProgress=0, design.inProgress=1)', frozenStats.inProgress === 0 && frozenDepartments.find((d) => d.id === 'design')?.inProgress === 1, JSON.stringify(frozenDepartments))
  check('A: UI top bar shows 1 done / 0 doing', statValue(frozenHtml, '做好了') === 1 && statValue(frozenHtml, '正在做') === 0, `${statValue(frozenHtml, '做好了')}/${statValue(frozenHtml, '正在做')}`)
  check('A: UI card says 0 正在做 · 2 还没开始', cardMeta(frozenHtml)?.inProgress === 0 && cardMeta(frozenHtml)?.pending === 2, JSON.stringify(cardMeta(frozenHtml)))
  check('A: UI renders a done T2 and an in-progress T3', frozenHtml.includes('步骤 T2</div><span className="dsh-wp-pill dsh-wp-tone-done">') && frozenHtml.includes('步骤 T3</div><span className="dsh-wp-pill dsh-wp-tone-active">'),
    'stage/subtask pills read statuses')
  check('A: UI donut shows the frozen 33%', donutPercent(frozenHtml) === 33, String(donutPercent(frozenHtml)))
  check('B: pending keeps progress=100', budgetItem.status === 'pending' && budgetItem.progress === 100, JSON.stringify(budgetItem))
  check('B: pause payload says 100% with 0 done', budget.payload.stats.progress === 100 && budget.payload.stats.done === 0, JSON.stringify(budget.payload.stats))
  check('B: UI says 总体进度 100% while the donut says 0% / 0 done', cardMeta(budgetHtml)?.progress === 100 && donutPercent(budgetHtml) === 0 && statValue(budgetHtml, '做好了') === 0,
    `card=${JSON.stringify(cardMeta(budgetHtml))} donut=${donutPercent(budgetHtml)} done=${statValue(budgetHtml, '做好了')}`)
  check('C: resume keeps stale blocked=2 while none is blocked', resumed.payload.stats.blocked === 2 && resumeActual.blocked === 0, `${resumed.payload.stats.blocked}/${resumeActual.blocked}`)
  check('C: UI shows 2 卡住了 while T1 is 正在做', statValue(resumeHtml, '卡住了') === 2 && resumeHtml.includes('步骤 T1</div><span className="dsh-wp-pill dsh-wp-tone-active">'),
    `blocked=${statValue(resumeHtml, '卡住了')}`)
  check('C: UI card says 0 正在做 · 0 还没开始 while T1 runs and T2 is pending', cardMeta(resumeHtml)?.inProgress === 0 && cardMeta(resumeHtml)?.pending === 0,
    JSON.stringify(cardMeta(resumeHtml)))
}

clearInterval(keepAlive)
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`)
  process.exitCode = 1
} else {
  console.log(EXPECT_FIXED
    ? '\nAll single-source invariants hold.'
    : '\nAll four defects reproduced (stats freeze, payload split-brain, budget invariant breach, stale resume counts).')
}
