#!/usr/bin/env node
/**
 * T5：枚举并实测 dsh-workplan 的（进度，状态）组合，找出「进度数值」与
 * 「状态文案」互不自洽的格子。
 *
 * 证据分三层：
 *   1. 结构枚举：对 1–3 个子任务的 4 种状态 × 合法 progress 取值做穷举，
 *      用真实 planPhase / deriveAggregates 计算 (phase, 环百分比, 加权百分比)，
 *      证明哪些组合在代码里可达、哪些不可达（不是凭印象列状态）。
 *   2. 真实写入：每个代表场景都走真实 runtime.updateStatus / dispatchPlan，
 *      不手写 stats；DOM 用真实 client.js 渲染（与 tests 相同的 React 桩）。
 *   3. 回放对照：在会话事件里保留 plan/update/cancel/result，比较实时缓存
 *      与刷新回放的 phase，捕捉「刷新后文案变化」这一类不一致。
 *
 * 运行：node scripts/scan-state-matrix.mjs
 * 退出码恒为 0（本脚本是扫描器，不是断言器）；冲突清单打印在最后。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildPlanMessage,
  buildResultMessage,
  computeStats,
  createStatuses,
  derivePlanSnapshot,
  planPhase,
  STATUSES,
} from '../lib/plan.js'
import { createWorkplanRuntime, dispatchPlan, reconstructFromSession } from '../lib/runtime.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NOW = Date.now()
const OLD = NOW - 11 * 60 * 1000

// ─────────────────────────────── 计划/会话桩 ───────────────────────────────

function subtask(id, overrides = {}) {
  return {
    id,
    title: `子任务 ${id}`,
    department: 'qa',
    role: '测试工程师',
    objective: `验证 ${id} 的状态与进度是否自洽`,
    method: ['读取真实 payload', '渲染真实 client.js'],
    inputs: [],
    outputs: ['DOM 事实'],
    dependsOn: [],
    acceptance: ['文案与数字不自相矛盾'],
    risk: '无',
    ...overrides,
  }
}

function makePlan({ key, sessionId, specs, createdAt = NOW, title = 'T5 状态矩阵扫描' }) {
  const plan = {
    planId: `wp-t5-${key}`,
    sessionId,
    createdTurn: 1,
    createdAt,
    title,
    taskUnderstanding: {
      deliverable: '状态-进度一致性矩阵',
      successCriteria: ['覆盖所有可达组合'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '待扫描', evidence: [], whyPrimary: '待扫描' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '单一阶段',
      goal: '把所有状态放在同一阶段内观察',
      checkpoint: '渲染后读取同一张卡片',
      subtasks: specs.map((spec) => subtask(spec.id, spec)),
    }],
    risks: [],
    verification: [],
    practiceLoop: null,
  }
  return plan
}

function makeSession(id, createdAt = NOW) {
  const events = []
  return {
    id,
    header: { createdAt },
    get seq() { return events.length },
    append(type, data) { events.push({ type, data }); return data },
    eventAt(seq) { return events[seq] },
    events,
  }
}

function makeRecord(plan, patch = {}) {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt ?? plan.createdAt,
    dispatchedAt: null,
    dispatchPromise: null,
    planMode: false,
    conversationContext: '',
    resultWritten: false,
    ...patch,
  }
}

function makeRuntime(session, record) {
  const runtime = createWorkplanRuntime({
    sessions: { list: () => [session], get: (id) => (id === session.id ? session : undefined) },
    logger: { warn() {} },
  })
  if (record) runtime.state.records.set(session.id, record)
  return runtime
}

/** 与真实工具调用一致：先写状态，再把这次调用记进会话日志（供回放）。 */
async function update(runtime, session, args) {
  const result = await runtime.updateStatus({ session }, args)
  session.append('tool/call', { name: 'dsh_workplan_update', arguments: args })
  return result
}

function findPayload(runtime, session) {
  const payload = runtime.plansPayload(session.id)
  return payload.sessions.find((item) => item.sessionId === session.id) ?? payload.sessions[0]
}

// ─────────────────────────── 真实 client.js 渲染 ───────────────────────────

function makeRenderer() {
  const styleToText = (style) => Object.entries(style)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}:${String(value)}`)
    .join(';')
  const render = (node) => {
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
      if (key === 'children' || key === 'key' || value === undefined || value === null) continue
      if (typeof value === 'function') continue
      if (key === 'style' && value && typeof value === 'object') {
        attrs += ` style="${styleToText(value).replace(/"/g, '&quot;')}"`
        continue
      }
      if (typeof value === 'object') continue
      attrs += ` ${key === 'className' ? 'class' : key}="${String(value).replace(/"/g, '&quot;')}"`
    }
    return `<${node.type}${attrs}>${(node.children || []).map(render).join('')}</${node.type}>`
  }
  return render
}

async function renderDashboard(sessions, openSessionId = null) {
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', setAttribute: () => {} }),
    head: { appendChild: () => {} },
  }
  const stateFixture = { loading: false, sessions, error: null, updatedAt: NOW }
  let stateIndex = 0
  class Component {
    constructor(props) { this.props = props }
    render() { return this.props?.children ?? null }
  }
  const ReactStub = {
    Component,
    createElement: (type, props, ...children) => {
      const next = { ...(props || {}) }
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next, children }
    },
    useState: (init) => {
      const index = stateIndex
      stateIndex += 1
      if (index === 0) return [stateFixture, () => {}]
      if (index === 1 && typeof openSessionId === 'string') return [openSessionId, () => {}]
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }

  const clientPath = path.resolve(ROOT, 'client.js')
  await import(`${pathToFileURL(clientPath).href}?t5=${NOW}-${Math.random()}`)
  if (!loaded) throw new Error('client.js 未通过 window.__ModuleLoader__ 注册')
  const mod = loaded.factory(() => ReactStub)
  const locales = {}
  let main = null
  const t = (key) => locales.zh?.[key] ?? key
  const ctx = {
    effect(fn) { return fn() },
    locale: {
      register(_ns, lang, obj) { locales[lang] = obj; return () => {} },
      bind() { return t },
    },
    slots: {
      inject(_name, fn) { fn() },
      register(spec, component) { if (spec.name === 'main') main = component; return () => {} },
    },
  }
  mod.apply(ctx)
  if (!main) throw new Error('主面板组件未注册')
  return makeRenderer()(ReactStub.createElement(main, { t }))
}

// ───────────────────────────────── DOM 事实 ─────────────────────────────────

function strip(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstMatch(text, re) {
  const match = String(text).match(re)
  return match ? match[1] : null
}

function sliceArticle(html, sessionId) {
  const at = html.indexOf(`data-session-id="${sessionId}"`)
  if (at < 0) return null
  const start = html.lastIndexOf('<article', at)
  const end = html.indexOf('</article>', at)
  if (start < 0 || end < 0) return null
  return html.slice(start, end + '</article>'.length)
}

function readCard(article) {
  const planvizTag = firstMatch(article, /(<div class="dsh-wp-planviz"[^>]*>)/)
  const collapses = article.split(/<button[^>]*class="dsh-wp-collapse-toggle"/).slice(1).map((segment) => {
    const head = segment.slice(0, segment.indexOf('</button>'))
    const title = strip(firstMatch(head, /dsh-wp-collapse-title">([\s\S]*?)<\/span>/) || '')
    const metaMatch = head.match(/dsh-wp-collapse-meta">([^<]*)</)
    const badge = strip(firstMatch(head, /dsh-wp-collapse-badge">([\s\S]*)/) || '')
    return { title, meta: metaMatch ? metaMatch[1] : '', badge }
  })
  const guideStart = article.indexOf('<section class="dsh-wp-guide"')
  const guideEnd = guideStart >= 0 ? article.indexOf('</section>', guideStart) : -1
  const guideRows = guideStart >= 0 && guideEnd > guideStart
    ? article.slice(guideStart, guideEnd).split('<div class="dsh-wp-guide-row">').slice(1).map((segment) => ({
      label: strip(firstMatch(segment, /dsh-wp-guide-label">([^<]*)</) || ''),
      value: strip(firstMatch(segment, /dsh-wp-guide-value">([\s\S]*?)<\/div>/) || ''),
    }))
    : []
  const overviewStats = strip(firstMatch(article, /dsh-wp-planoverview-stats">([\s\S]*?)<\/div>/) || '')
  const planRowStates = [...article.matchAll(/class="dsh-wp-planrow-state">([^<]*)</g)].map((m) => m[1])
  const planRowTones = [...article.matchAll(/class="dsh-wp-planrow" data-tone="([^"]+)"/g)].map((m) => m[1])
  const stepperTones = [...article.matchAll(/class="dsh-wp-stepper-seg"[\s\S]*?data-tone="([^"]+)"/g)].map((m) => m[1])
  const stepperWidths = [...article.matchAll(/class="dsh-wp-stepper-fill" data-width="(\d+)"/g)].map((m) => Number(m[1]))
  const subtaskProgress = [...article.matchAll(/class="dsh-wp-progress-meta"><span>进度 (\d+)%<\/span>/g)].map((m) => Number(m[1]))
  return {
    dataPercent: firstMatch(planvizTag || '', /data-percent="([^"]+)"/),
    dataState: firstMatch(planvizTag || '', /data-state="([^"]+)"/),
    pctText: strip(firstMatch(article, /dsh-wp-planviz-pct">([^<]*)</) || ''),
    scopeText: strip(firstMatch(article, /dsh-wp-planviz-scope">([^<]*)</) || ''),
    nowText: strip(firstMatch(article, /dsh-wp-planviz-now-text">([^<]*)</) || ''),
    nowState: firstMatch(article, /dsh-wp-planviz-now" data-state="([^"]+)"/),
    badge: collapses[0]?.badge ?? '',
    stageCollapses: collapses.slice(1),
    guide: Object.fromEntries(guideRows.map((row, index) => [index === 0 ? 'what' : index === 1 ? 'who' : 'next', row.value])),
    weightedText: overviewStats,
    weighted: firstMatch(overviewStats, /加权） (\d+)%/) === null ? null : Number(firstMatch(overviewStats, /加权） (\d+)%/)),
    planRows: planRowStates.map((state, index) => ({ tone: planRowTones[index], state })),
    stepper: stepperTones.map((tone, index) => ({ tone, width: stepperWidths[index] })),
    subtaskProgress,
  }
}

function readGroups(html) {
  const starts = [...html.matchAll(/<section class="dsh-wp-group dsh-wp-group--(live|done)[^"]*"[^>]*data-group="(live|done)"/g)]
  return starts.map((match, index) => {
    const from = match.index
    const to = index + 1 < starts.length ? starts[index + 1].index : html.length
    const section = html.slice(from, to)
    const tag = firstMatch(section, /(<section[^>]*>)/) || ''
    return {
      group: match[1],
      total: Number(firstMatch(tag, /data-total="(\d+)"/)),
      done: Number(firstMatch(tag, /data-done="(\d+)"/)),
      percent: firstMatch(tag, /data-percent="([^"]+)"/),
      title: strip(firstMatch(section, /dsh-wp-group-title"[^>]*>([^<]*)</) || ''),
      summary: strip(firstMatch(section, /dsh-wp-group-sub"[^>]*>([^<]*)</) || ''),
    }
  })
}

// ─────────────────────────────── 场景执行器 ───────────────────────────────

const scenarioResults = []

async function recordScenario(name, { payload, sessionId, runtime, session, note = '' }) {
  const html = await renderDashboard(runtime.plansPayload(sessionId).sessions, sessionId)
  const article = sliceArticle(html, sessionId)
  const card = article ? readCard(article) : null
  const payloadSession = findPayload(runtime, session)
  let replay = null
  try {
    replay = reconstructFromSession(session)
  } catch (error) {
    replay = { error: String(error?.message ?? error) }
  }
  const facts = {
    name,
    note,
    payload: payloadSession
      ? {
        phase: payloadSession.phase,
        statuses: (payloadSession.statuses || []).map((item) => ({
          id: item.subtaskId, status: item.status, progress: item.progress,
        })),
        stats: payloadSession.stats,
      }
      : null,
    replay: replay
      ? { phase: replay.phase, stale: replay.stale ?? null, statuses: (replay.statuses || []).map((item) => ({ id: item.subtaskId, status: item.status, progress: item.progress })) }
      : null,
    dom: card,
    groups: readGroups(html),
    hidden: !card,
  }
  scenarioResults.push(facts)
  console.log(`\n### ${name}`)
  console.log(JSON.stringify(facts))
  return facts
}

async function simpleScenario(name, specs, actions, options = {}) {
  const session = makeSession(`s-t5-${name}`)
  const plan = makePlan({ key: name, sessionId: session.id, specs, createdAt: options.createdAt ?? NOW })
  session.append('user/message', buildPlanMessage(plan))
  const record = makeRecord(plan, options.recordPatch)
  const runtime = makeRuntime(session, record)
  for (const action of actions) await action({ runtime, session, record, plan })
  return recordScenario(name, {
    payload: runtime.plansPayload(session.id),
    sessionId: session.id,
    runtime,
    session,
    note: options.note ?? '',
  })
}

function makeDispatchCtx(behaviours) {
  const startActivation = async (spec) => {
    const label = String(spec?.label ?? '')
    const id = firstMatch(label, /:([A-Za-z]+\d+)\s/) || 'T?'
    const behaviour = behaviours[id] ?? behaviours['*'] ?? 'hang'
    const childId = `child-${id}-${Math.random().toString(36).slice(2, 8)}`
    const dispose = async () => {}
    if (behaviour === 'quick') {
      return { childId, dispose, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: `${id} 完成` }] }) }
    }
    if (behaviour === 'fail') {
      return { childId, dispose, result: Promise.resolve({ stopReason: 'error', output: [{ type: 'text', text: `${id} 失败` }] }) }
    }
    if (typeof behaviour === 'number') {
      return {
        childId,
        dispose,
        result: new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'completed', output: [{ type: 'text', text: `${id} 完成` }] }), behaviour)),
      }
    }
    return { childId, dispose, result: new Promise(() => {}) }
  }
  return {
    logger: { warn() {} },
    subagents: { startActivation },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

async function dispatchScenario(name, specs, behaviours, options = {}) {
  const session = makeSession(`s-t5-${name}`)
  const plan = makePlan({ key: name, sessionId: session.id, specs })
  session.append('user/message', buildPlanMessage(plan))
  const record = makeRecord(plan)
  const runtime = makeRuntime(session, record)
  // dispatchPlan 的总预算计时器是 unref 的；独立脚本里没有其它 ref 句柄时，
  // Node 会在等待挂起子 Agent 时直接退出。这个 keepAlive 只负责让进程活到预算触发。
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    await dispatchPlan(makeDispatchCtx(behaviours), record, {
      agent: { session, options: {} },
      signal: new AbortController().signal,
      idleTimeoutMs: 60_000,
      childTimeoutMs: 60_000,
      totalTimeoutMs: options.totalTimeoutMs ?? 30_000,
    })
  } finally {
    clearInterval(keepAlive)
  }
  if (options.writeResult) {
    const result = {
      planId: plan.planId,
      sessionId: session.id,
      dispatchedAt: record.dispatchedAt ?? NOW,
      statuses: record.statuses,
      stats: computeStats(record.statuses),
      phase: record.phase,
      errors: record.errors ?? [],
    }
    session.append('user/message', buildResultMessage(result))
  }
  return recordScenario(name, {
    payload: runtime.plansPayload(session.id),
    sessionId: session.id,
    runtime,
    session,
    note: options.note ?? '',
  })
}

// ─────────────────────────────── 结构枚举矩阵 ───────────────────────────────

function bucket(value) {
  if (value === null) return 'null'
  if (value === 0) return '0'
  if (value >= 100) return '100'
  return '1-99'
}

/** 与 client.ts:1475 planCounts 相同的环百分比口径（只依赖 done/total）。 */
function ringPercent(stats) {
  return stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : null
}

function enumerateReachable() {
  const progressChoices = [0, 5, 10, 40, 50, 95, 99, 100]
  const rows = new Map()
  for (let n = 1; n <= 3; n += 1) {
    const statusVectors = []
    const buildStatuses = (index, acc) => {
      if (index === n) { statusVectors.push([...acc]); return }
      for (const status of STATUSES) buildStatuses(index + 1, [...acc, status])
    }
    buildStatuses(0, [])
    for (const statuses of statusVectors) {
      const slots = statuses.map((status, i) => ({ status, id: `T${i + 1}` }))
      const progressVectors = []
      const buildProgress = (index, acc) => {
        if (index === n) { progressVectors.push([...acc]); return }
        const { status } = slots[index]
        // done/pending 被 applyStatus 强制为 100/0，枚举它们没有意义。
        const choices = status === 'done' ? [100] : status === 'pending' ? [0] : progressChoices
        for (const progress of choices) buildProgress(index + 1, [...acc, progress])
      }
      buildProgress(0, [])
      for (const progress of progressVectors) {
        const sample = slots.map((slot, i) => ({ subtaskId: slot.id, title: slot.id, department: 'qa', status: slot.status, progress: progress[i] }))
        const snapshot = derivePlanSnapshot(sample)
        const phase = planPhase(snapshot.statuses, false)
        const ring = ringPercent(snapshot.stats)
        const weighted = snapshot.stats.progress
        const key = `${phase}|${bucket(ring)}|${bucket(weighted)}`
        const entry = rows.get(key) ?? { phase, ring: bucket(ring), weighted: bucket(weighted), count: 0, sample: null }
        entry.count += 1
        if (!entry.sample) entry.sample = sample.map((item) => `${item.subtaskId}:${item.status}@${item.progress}`).join(' ')
        rows.set(key, entry)
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.phase.localeCompare(b.phase) || a.ring.localeCompare(b.ring) || a.weighted.localeCompare(b.weighted))
}

// ───────────────────────────────── 主流程 ─────────────────────────────────

async function main() {
  await simpleScenario('pending', [{ id: 'T1' }, { id: 'T2' }], [], { note: '新建计划，全部 pending' })

  await simpleScenario('executing-partial-done', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
  ], { note: 'T1 完成、T2 尚未开始（复核/暂停间隙）' })

  await simpleScenario('executing-active-40', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'in_progress', progress: 40 }),
  ], { note: 'T1 进行到 40%，环 0%' })

  await simpleScenario('in-progress-100', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'in_progress', progress: 100 }),
  ], { note: '工具允许 in_progress + progress=100' })

  await simpleScenario('executing-ring-0-weighted-100', [{ id: 'T1' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'in_progress', progress: 100 }),
  ], { note: '单任务 in_progress@100：环 0%、加权 100%，同一张卡两个进度' })

  await simpleScenario('executing-ring-50-weighted-100', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'in_progress', progress: 100 }),
  ], { note: 'T1 done + T2 in_progress@100：环 50%、加权 100%' })

  await simpleScenario('integrating', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'done' }),
  ], { note: '全 done、结果消息尚未写入（用户截图的主场景）' })

  await simpleScenario('done', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'done' }),
    ({ runtime, session, record, plan }) => {
      const result = {
        planId: plan.planId,
        sessionId: session.id,
        dispatchedAt: NOW,
        statuses: record.statuses,
        stats: computeStats(record.statuses),
        phase: record.phase,
        errors: [],
      }
      session.append('user/message', buildResultMessage(result))
      record.resultWritten = true
      record.phase = 'done'
    },
  ], { note: '结果消息已落盘，dispatchTool 把 phase 置 done' })

  await simpleScenario('blocked-update', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'blocked' }),
  ], { note: 'update 标 blocked 时未传 progress（保留 0）' })

  await simpleScenario('blocked-and-active', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'blocked' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'in_progress', progress: 40 }),
  ], { note: '同一计划同时有 blocked 与 in_progress' })

  await simpleScenario('blocked-ring-0-weighted-100', [{ id: 'T1' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'blocked', progress: 100 }),
  ], { note: '单任务 blocked@100：环 0%、加权 100%、badge 卡住了' })

  await simpleScenario('blocked-ring-50-weighted-100', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'blocked', progress: 100 }),
  ], { note: 'T1 done + T2 blocked@100：环 50%、加权 100%' })

  await dispatchScenario('blocked-dispatch', [
    { id: 'T1' }, { id: 'T2' }, { id: 'T3', dependsOn: ['T2'] },
  ], { T1: 'quick', T2: 'fail', T3: 'hang' }, { writeResult: true, note: '真实 dispatch：T2 子 Agent 失败 → blocked@100，T3 依赖级联 blocked@0' })

  await dispatchScenario('paused-partial', [
    { id: 'T1' }, { id: 'T2' }, { id: 'T3', dependsOn: ['T2'] },
  ], { T1: 'quick', T2: 'hang', T3: 'hang' }, { totalTimeoutMs: 400, writeResult: true, note: '真实 dispatch：预算到点，T1 完成、其余回 pending' })

  await dispatchScenario('paused-100', [
    { id: 'T1' },
  ], { T1: 600 }, { totalTimeoutMs: 400, writeResult: true, note: '最后一个子任务在 deadline 后完成 → 全 done 却走 paused 分支' })

  await simpleScenario('cancelled-hidden', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'done' }),
    async ({ runtime, session }) => { await runtime.cancelPlan({ session }, { reason: 'T5 扫描' }) },
  ], { note: '取消后 payload.phase=cancelled，但 Dashboard 在分组前过滤 cancelled → 卡片不可见' })

  await simpleScenario('cancelled-resurrected', [{ id: 'T1' }, { id: 'T2' }], [
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T2', status: 'done' }),
    async ({ runtime, session }) => { await runtime.cancelPlan({ session }, { reason: 'T5 扫描' }) },
    ({ runtime, session }) => update(runtime, session, { subtaskId: 'T1', status: 'done' }),
  ], { note: '取消后一次 no-op update 把 live phase 重算回 integrating（卡片复活）；replay 仍是 cancelled' })

  await simpleScenario('stale-pending', [{ id: 'T1' }, { id: 'T2' }], [], {
    createdAt: OLD,
    note: '未派发且超过 10 分钟：serialisePlan 把 pending 改成 cancelled；reconstruct 却返回 pending+stale',
  })

  {
    const session = makeSession('s-t5-degraded')
    const record = {
      plan: null,
      planId: 'wp-t5-degraded',
      title: '自动分解降级',
      phase: 'degraded',
      statuses: [],
      errors: ['planner 不可用'],
      degraded: true,
      error: 'planner 不可用',
      createdAt: NOW,
      updatedAt: NOW,
      dispatchedAt: null,
      dispatchPromise: null,
      planMode: false,
      conversationContext: '',
    }
    session.append('user/message', {
      content: [{ type: 'text', text: '降级' }],
    })
    const runtime = makeRuntime(session, record)
    await recordScenario('degraded', {
      payload: runtime.plansPayload(session.id),
      sessionId: session.id,
      runtime,
      session,
      note: '0 个子任务：环 —、badge 安排失败、现在「还没开始」、下一步「没有下一步，这件事已完成」',
    })
  }

  console.log('\n\n## 结构枚举：所有可达 (status-phase × 环百分比 × 加权百分比)')
  const matrix = enumerateReachable()
  for (const row of matrix) {
    console.log(`| ${row.phase} | ${row.ring} | ${row.weighted} | ${row.count} | ${row.sample} |`)
  }

  console.log('\n\n## 全场景汇总')
  for (const result of scenarioResults) {
    const dom = result.dom
    console.log(JSON.stringify({
      name: result.name,
      phase: result.payload?.phase,
      replayPhase: result.replay?.phase,
      hidden: result.hidden,
      pct: dom?.pctText ?? null,
      badge: dom?.badge ?? null,
      now: dom?.nowText ?? null,
      dataState: dom?.dataState ?? null,
      weighted: dom?.weighted ?? null,
      stage: dom?.stageCollapses?.[0] ?? null,
      itemProgress: dom?.subtaskProgress ?? [],
      guide: dom?.guide ?? {},
      groups: result.groups,
    }))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
