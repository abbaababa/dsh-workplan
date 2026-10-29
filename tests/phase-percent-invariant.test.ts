/*
 * [1.5.2] 「100% + 正在收尾」回归测试：计划的完成语义只能有一个事实源。
 *
 * 事故（用户截图 + 会话 session-c3852c31）：某计划的 14 个子任务全部完成，
 * 面板同时显示「100% · 14/14 做好了 · 都做完了」和状态胶囊「正在收尾」，
 * 并且这张卡还留在「进行中」组里。
 *
 * 根因：进度（done/total）只看 statuses，phase 却额外看 resultSeen
 * ——「结果消息已落盘」这个副作用。走 update 工具补完最后一项时没有任何
 * 代码会把 phase 晋升成 done，于是计划永久停在 integrating。
 *
 * 本文件把修复固化成可执行断言，分四层：
 *   1. 纯函数：planPhase / reconcilePhase 的终态语义；
 *   2. 计数：加权总进度不得在「还有未完成项」时说 100；
 *   3. 不变量：aggregateInvariantViolations 的 I8/I9 必须抓住矛盾组合；
 *   4. 端到端：update 补完 / 空更新回退 / 取消已完成计划 / 客户端渲染。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  aggregateInvariantViolations,
  createStatuses,
  derivePlanSnapshot,
  planPhase,
  reconcilePhase,
} from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

function makePlan() {
  return {
    planId: 'wp-phase',
    sessionId: 'session-phase',
    createdTurn: 1,
    createdAt: 1000,
    title: '阶段与进度一致性回归',
    stages: [{
      id: 'S1',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
      ],
    }],
  }
}

function makeStatuses(statuses: string[]) {
  return createStatuses(makePlan()).map((item: any, index: number) => ({
    ...item,
    status: statuses[index],
  }))
}

function makeRecord(plan: any): any {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: false,
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-phase',
    header: { createdAt: 1000 },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeCtx(session: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: () => { throw new Error('本测试不派发子任务') } },
    sessions: {
      get: (id: any) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: () => undefined,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 1. 纯函数：完成即终态，resultSeen 不再参与定义                    */
/* ------------------------------------------------------------------ */

test('全部 done 时 phase 恒为 done：结果消息是否落盘不影响完成语义', () => {
  const allDone = makeStatuses(['done', 'done'])
  assert.equal(planPhase(allDone), 'done')
  assert.equal(planPhase(allDone, false), 'done')
  assert.equal(planPhase(allDone, true), 'done')
})

test('未全部 done 时 phase 仍按 statuses 派生（blocked 优先于 executing）', () => {
  assert.equal(planPhase([]), 'pending')
  assert.equal(planPhase(makeStatuses(['pending', 'pending'])), 'pending')
  assert.equal(planPhase(makeStatuses(['done', 'in_progress'])), 'executing')
  assert.equal(planPhase(makeStatuses(['done', 'blocked'])), 'blocked')
})

test('reconcilePhase：缓存里的收尾/完成态一律服从 statuses', () => {
  const allDone = makeStatuses(['done', 'done'])
  const mixed = makeStatuses(['done', 'in_progress'])
  const blocked = makeStatuses(['done', 'blocked'])

  // 「100% + 正在收尾」的直接修复：旧缓存 integrating 在全部完成时必须变 done。
  assert.equal(reconcilePhase('integrating', allDone), 'done')
  assert.equal(reconcilePhase('done', allDone), 'done')
  assert.equal(reconcilePhase('paused', allDone), 'done')
  assert.equal(reconcilePhase(undefined, allDone), 'done')

  // 反向：plan 说 done 但还有没做完的活时必须降级，不能宣称已完成。
  assert.equal(reconcilePhase('done', mixed), 'executing')
  assert.equal(reconcilePhase('done', blocked), 'blocked')
  assert.equal(reconcilePhase('integrating', mixed), 'executing')

  // 有独立事实来源的 phase 不被触碰。
  assert.equal(reconcilePhase('paused', mixed), 'paused')
  assert.equal(reconcilePhase('cancelled', mixed), 'cancelled')
  assert.equal(reconcilePhase('blocked', blocked), 'blocked')
})

/* ------------------------------------------------------------------ */
/* 2. 计数：未全部完成时「总体进度」不得显示 100                     */
/* ------------------------------------------------------------------ */

test('加权总进度：完成 + 卡住混排时不会被抬到 100', () => {
  // blocked 的权重按它自己的进度计（100 表示「这项不会再前进了」）。
  // 1/1 卡住时旧算法直接得出 100，与「100% + 正在收尾」是同一类语义冲突。
  const blockedOnly = derivePlanSnapshot([{
    ...createStatuses(makePlan())[0],
    status: 'blocked',
    progress: 100,
  }]).stats
  assert.equal(blockedOnly.blocked, 1)
  assert.equal(blockedOnly.progress, 99, '没有全部完成时总进度封顶 99')

  // 全部完成才是 100，且此时 phase 必须是 done（两条结论由同一份计数支撑）。
  const allDone = makeStatuses(['done', 'done']).map((item: any) => ({ ...item, progress: 100 }))
  const snapshot = derivePlanSnapshot(allDone)
  assert.equal(snapshot.stats.progress, 100)
  assert.equal(planPhase(snapshot.statuses), 'done')
})

/* ------------------------------------------------------------------ */
/* 3. 不变量：I8/I9 必须抓住「100% 却未完成」和「完成却非终态」       */
/* ------------------------------------------------------------------ */

test('I8：全部完成但 phase 仍是进行中/收尾 —— 必须被不变量捕获', () => {
  const snapshot = derivePlanSnapshot(makeStatuses(['done', 'done']))
  for (const phase of ['integrating', 'executing', 'paused', 'pending']) {
    const violations = aggregateInvariantViolations(snapshot, phase)
    assert.ok(
      violations.some((line: string) => line.startsWith('I8')),
      `phase=${phase} 时 I8 必须报错，实际：${JSON.stringify(violations)}`,
    )
  }
  assert.deepEqual(aggregateInvariantViolations(snapshot, 'done'), [])
})

test('I8 反向：phase=done 但还有未完成项 —— 同样必须被捕获', () => {
  const snapshot = derivePlanSnapshot(makeStatuses(['done', 'pending']))
  const violations = aggregateInvariantViolations(snapshot, 'done')
  assert.ok(violations.some((line: string) => line.startsWith('I8')))
})

test('I9：stats.progress 与完成数互相矛盾时，即使 phase 正确也要报错', () => {
  const snapshot = derivePlanSnapshot(makeStatuses(['done', 'done']))
  const doctored = { ...snapshot, stats: { ...snapshot.stats, progress: 99 } }
  assert.ok(aggregateInvariantViolations(doctored, 'done').some((line: string) => line.startsWith('I9')))

  const partial = derivePlanSnapshot(makeStatuses(['done', 'pending']))
  const inflated = { ...partial, stats: { ...partial.stats, progress: 100 } }
  assert.ok(aggregateInvariantViolations(inflated, 'executing').some((line: string) => line.startsWith('I9')))
})

test('所有一致的 (statuses, phase) 组合都不产生任何不变量告警', () => {
  const matrix = [
    { statuses: ['done', 'done'], phase: 'done' },
    { statuses: ['done', 'in_progress'], phase: 'executing' },
    { statuses: ['done', 'blocked'], phase: 'blocked' },
    { statuses: ['pending', 'pending'], phase: 'pending' },
    { statuses: ['done', 'in_progress'], phase: 'paused' },
  ]
  for (const item of matrix) {
    const snapshot = derivePlanSnapshot(makeStatuses(item.statuses))
    assert.deepEqual(
      aggregateInvariantViolations(snapshot, item.phase),
      [],
      `${item.statuses.join('+')} / ${item.phase} 不应有告警`,
    )
  }
})

/* ------------------------------------------------------------------ */
/* 4. 端到端：用户实际走的路径                                       */
/* ------------------------------------------------------------------ */

test('主 Agent 用 update 工具补完最后一项：计划当场变成已完成（事故路径）', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const session = makeSession()
  const runtime = createWorkplanRuntime(makeCtx(session), { totalTimeoutMs: 60000 })
  runtime.state.records.set(session.id, record)
  const agent = { session, options: {} }

  await runtime.updateStatus(agent, { subtaskId: 'T1', status: 'done', progress: 100 })
  const middle = runtime.plansPayload(session.id).sessions[0]
  assert.equal(middle.phase, 'executing', '还有一项没做，不能提前宣称完成')

  await runtime.updateStatus(agent, { subtaskId: 'T2', status: 'done', progress: 100 })
  const payload = runtime.plansPayload(session.id).sessions[0]
  assert.equal(payload.stats.done, 2)
  assert.equal(payload.stats.progress, 100)
  /*
   * 这一行就是截图的修复点：旧代码在这里返回 integrating，并且因为 update
   * 路径不会再派发，永远等不到结果消息把它晋升成 done。
   */
  assert.equal(payload.phase, 'done', '最后一项补完时计划必须终态，不能停在正在收尾')
  assert.equal(payload.violations, undefined, '载荷不得携带不变量告警')
})

test('已完成的计划再做一次空更新不会被退回「正在收尾」（T4 实测 A.2）', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const session = makeSession()
  const runtime = createWorkplanRuntime(makeCtx(session), { totalTimeoutMs: 60000 })
  runtime.state.records.set(session.id, record)
  const agent = { session, options: {} }

  await runtime.updateStatus(agent, { subtaskId: 'T1', status: 'done', progress: 100 })
  await runtime.updateStatus(agent, { subtaskId: 'T2', status: 'done', progress: 100 })
  assert.equal(runtime.plansPayload(session.id).sessions[0].phase, 'done')

  await runtime.updateStatus(agent, { subtaskId: 'T2', status: 'done', progress: 100 })
  assert.equal(runtime.plansPayload(session.id).sessions[0].phase, 'done', '空更新不得让终态回退')
})

test('取消一个已全部完成的计划是 no-op：不产生「100% + 已取消」（T4 实测 A.4）', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const session = makeSession()
  const runtime = createWorkplanRuntime(makeCtx(session), { totalTimeoutMs: 60000 })
  runtime.state.records.set(session.id, record)
  const agent = { session, options: {} }

  await runtime.updateStatus(agent, { subtaskId: 'T1', status: 'done', progress: 100 })
  await runtime.updateStatus(agent, { subtaskId: 'T2', status: 'done', progress: 100 })

  const result: any = await runtime.cancelPlan(agent, { reason: '用户关掉了标签页' })
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'done')
  assert.equal(result.alreadyDone, true)
  const payload = runtime.plansPayload(session.id).sessions[0]
  assert.equal(payload.phase, 'done')
  assert.equal(payload.stats.progress, 100)
  assert.equal(payload.violations, undefined)
})

/* ------------------------------------------------------------------ */
/* 5. 客户端：即使收到旧的矛盾载荷，也不能渲染出自相矛盾的画面       */
/* ------------------------------------------------------------------ */

function sessionFixture(overrides: any) {
  const base: any = {
    sessionId: 's-phase',
    title: '阶段一致性会话',
    phase: 'executing',
    planId: 'wp-phase',
    createdAt: 1000,
    updatedAt: 1000,
    stats: { total: 2, done: 0, blocked: 0, inProgress: 0, pending: 2, progress: 0 },
    departments: [{ id: 'engineering', done: 0, total: 2, blocked: 0 }],
    taskUnderstanding: { deliverable: '一份结论' },
    contradictions: { primary: null, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '执行',
      goal: '做完两件事',
      checkpoint: '两件都完成',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', role: '工程师', objective: '完成一', method: ['做'], inputs: [], outputs: [], dependsOn: [], acceptance: ['完成'], risk: '风险' },
        { id: 'T2', title: '第二步', department: 'engineering', role: '工程师', objective: '完成二', method: ['做'], inputs: [], outputs: [], dependsOn: ['T1'], acceptance: ['完成'], risk: '风险' },
      ],
    }],
    statuses: [
      { subtaskId: 'T1', status: 'pending', progress: 0 },
      { subtaskId: 'T2', status: 'pending', progress: 0 },
    ],
    risks: [],
    verification: [],
    practiceLoop: null,
    errors: [],
  }
  return { ...base, ...overrides }
}

async function loadDashboardHtml(fixture: any): Promise<string> {
  let loaded: any = null
  ;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  let firstState = true
  const state = { loading: false, sessions: [fixture], error: null, updatedAt: Date.now() }
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
      if (firstState) { firstState = false; return [state, () => {}] }
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

  const clientPath = path.resolve(process.cwd(), 'client.js')
  await import(`${pathToFileURL(clientPath).href}?phase=${Date.now()}-${Math.random()}`)
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

test('客户端：收到「100% + integrating」的旧载荷时，卡片必须显示已完成并归入已完成组', async () => {
  const html = await loadDashboardHtml(sessionFixture({
    // 这就是用户截图里那张卡的持久化形态：14/14 全 done、progress 100，phase 仍是 integrating。
    phase: 'integrating',
    stats: { total: 2, done: 2, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
    departments: [{ id: 'engineering', done: 2, total: 2, blocked: 0 }],
    statuses: [
      { subtaskId: 'T1', status: 'done', progress: 100 },
      { subtaskId: 'T2', status: 'done', progress: 100 },
    ],
  }))

  assert.equal(html.includes('正在收尾'), false, '100% 的卡片不得再出现「正在收尾」')
  assert.ok(html.includes('都做完了'), '完成文案必须出现')
  assert.ok(html.includes('已完成'), '状态胶囊必须是已完成')
  assert.ok(
    html.includes('没有进行中的任务'),
    '全部完成的计划必须移入「已完成」组，进行中组应为空',
  )
})

test('客户端反向保护：phase 说 done 但计数没做完时，不能显示成就已完成', async () => {
  const html = await loadDashboardHtml(sessionFixture({
    phase: 'done',
    stats: { total: 2, done: 1, blocked: 0, inProgress: 1, pending: 0, progress: 50 },
    statuses: [
      { subtaskId: 'T1', status: 'done', progress: 100 },
      { subtaskId: 'T2', status: 'in_progress', progress: 50 },
    ],
  }))

  assert.equal(html.includes('都做完了'), false, '还有一项没做，不能显示「都做完了」')
  assert.equal(html.includes('没有进行中的任务'), false, '未完成的计划必须留在进行中组')
})
