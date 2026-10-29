#!/usr/bin/env node
/**
 * T2 最小复现：同一张卡片同时显示「100%」与「正在收尾」。
 *
 * 现象
 * ----
 * 计划的所有子任务都已 done，但计划层 phase 仍是 `integrating`
 * （locale.zh phase.integrating = 「正在收尾」），于是卡片上：
 *   - 环图 / 百分比：planCounts(stats) = round(done / total * 100) = 100%
 *   - 阶段胶囊：phase = integrating → 「正在收尾」
 *   - 摘要「现在」：全 done → 「都做完了」
 * 三处文案互不相容，且都来自同一个 payload。
 *
 * 为什么不是伪造
 * --------------
 * 本脚本不 mock 业务函数：
 *   1. 计划记录用 `createStatuses()` 生成，状态变更走真实的
 *      `runtime.updateStatus()`（与 dsh_workplan_update 工具同一实现）；
 *   2. payload 走真实的 `runtime.plansPayload()`（与 /dsh-workplan/plans 路由同一实现）；
 *   3. DOM 用真实的 `client.js` + 与 tests/*.test.ts 相同的 React 桩渲染。
 *
 * 两个场景
 * --------
 * A. 最小输入（3 条状态变更）：计划 + T1 done + T2 done。
 *    最后一次 updateStatus 执行 `record.phase = planPhase(record.statuses)`，
 *    全 done 且没有 resultSeen → integrating，而 stats 由同一份 statuses 派生，
 *    done=total=2、progress=100。
 * B. 持久化场景：本轮结果已经写入会话（resultSeen=true、replay 应为 done），
 *    主 Agent 按提示词复核后把 T2 标记 in_progress 再 done。
 *    updateStatus 再次只用 planPhase(statuses)（默认 resultSeen=false）：
 *    实时缓存变成 integrating，而同一会话日志 replay 是 done。
 *    即：不刷新显示「100% + 正在收尾」，刷新后变「已完成」。
 *
 * 用法
 * ----
 *   node scripts/repro-phase-percent-integrating.mjs
 *       复现模式：要求矛盾出现；默认连续跑 3 次并比对指纹（稳定性结论）。
 *   node scripts/repro-phase-percent-integrating.mjs --runs 3
 *       显式指定重复次数。
 *   node scripts/repro-phase-percent-integrating.mjs --expect-fixed
 *       修复后模式（1.5.2 起用这个）：要求计划在全部完成时 phase=done、
 *       胶囊「已完成」、实时与回放一致、载荷不带 I8/I9 告警。
 *
 * 说明：默认的复现模式断言的是「旧 bug 仍然存在」，1.5.2 修复后它必然 FAIL
 * ——这正是修复生效的证据；日常回归请用 --expect-fixed（应为 PASS）。
 *
 * 退出码：0 = 当前模式的目标达成；1 = 未达成（矛盾没复现，或修复后仍并存）。
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildPlanMessage,
  buildResultMessage,
  computeStats,
  createStatuses,
  derivePlanSnapshot,
} from '../lib/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../lib/runtime.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXPECT_FIXED = process.argv.includes('--expect-fixed')
const runsFlag = process.argv.indexOf('--runs')
const RUNS = runsFlag >= 0 ? Math.max(1, Number(process.argv[runsFlag + 1]) || 1) : 3

let failures = 0
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`)
  if (!ok) failures += 1
}

const PLAN_CREATED_AT = 1_700_000_000_000

function makePlan() {
  return {
    planId: 'wp-t2-phase-percent',
    sessionId: 's-t2',
    createdTurn: 1,
    createdAt: PLAN_CREATED_AT,
    title: 'T2：100% 与「正在收尾」并存的最小复现',
    taskUnderstanding: {
      deliverable: '一份可重放的复现证据',
      successCriteria: ['三次执行结论一致'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: {
        statement: '子任务全部完成（100%）与计划「正在收尾」同时出现在同一张卡片',
        evidence: ['payload.phase=integrating', 'payload.stats.done=total', 'stats.progress=100'],
        whyPrimary: '这是用户可见的自相矛盾',
      },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '单阶段最小计划',
      goal: '用最少的输入进入收尾状态',
      checkpoint: '同一时刻抓取 payload 与 DOM',
      subtasks: [
        {
          id: 'T1',
          title: '抓取状态快照',
          department: 'qa',
          role: '测试工程师',
          objective: '抓取矛盾时刻的原始状态',
          method: ['读取 plansPayload'],
          inputs: [],
          outputs: ['payload JSON'],
          dependsOn: [],
          acceptance: ['字段取值可见'],
          risk: '无',
        },
        {
          id: 'T2',
          title: '渲染卡片核对',
          department: 'qa',
          role: '测试工程师',
          objective: '确认卡片同时给出 100% 与正在收尾',
          method: ['真实 client.js 渲染'],
          inputs: ['payload'],
          outputs: ['DOM 片段'],
          dependsOn: ['T1'],
          acceptance: ['两个文案同时出现'],
          risk: '无',
        },
      ],
    }],
    risks: [],
    verification: [],
    practiceLoop: null,
  }
}

/** 与 tests/workplan-budget-pause.test.ts 相同的会话桩：只实现 replay 真正用到的接口。 */
function makeSession(id) {
  const events = []
  return {
    id,
    header: { createdAt: PLAN_CREATED_AT },
    get seq() { return events.length },
    append(type, data) { events.push({ type, data }); return data },
    eventAt: (seq) => events[seq],
    events,
  }
}

/** 与 runtime.maybePlan() 落库的记录同形；不手工放 stats，统计一律现算。 */
function makeRecord(plan) {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    dispatchedAt: null,
    dispatchPromise: null,
    planMode: false,
    conversationContext: '',
  }
}

function sessionDigest(session) {
  const { statuses, stats } = {
    statuses: (session.statuses || []).map((item) => ({
      subtaskId: item.subtaskId,
      status: item.status,
      progress: item.progress,
    })),
    stats: session.stats,
  }
  return {
    phase: session.phase,
    stats,
    statuses,
    percentFromDoneRatio: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : null,
  }
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
      const name = key === 'className' ? 'class' : key
      attrs += ` ${name}="${String(value).replace(/"/g, '&quot;')}"`
    }
    return `<${node.type}${attrs}>${(node.children || []).map(render).join('')}</${node.type}>`
  }
  return render
}

async function renderDashboard(sessions) {
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', setAttribute: () => {} }),
    head: { appendChild: () => {} },
  }

  const stateFixture = { loading: false, sessions, error: null, updatedAt: PLAN_CREATED_AT }
  let firstState = true
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
      if (firstState) { firstState = false; return [stateFixture, () => {}] }
      return [init, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }

  const clientPath = path.resolve(ROOT, 'client.js')
  await import(`${pathToFileURL(clientPath).href}?t2phase=${Date.now()}${Math.random()}`)
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

function sliceArticle(html, sessionId) {
  const at = html.indexOf(`data-session-id="${sessionId}"`)
  if (at < 0) throw new Error(`渲染结果中找不到 ${sessionId}`)
  const start = html.lastIndexOf('<article', at)
  const end = html.indexOf('</article>', at)
  if (start < 0 || end < 0) throw new Error(`${sessionId} 的 article 未闭合`)
  return html.slice(start, end + '</article>'.length)
}

function firstMatch(text, re) {
  const match = text.match(re)
  return match ? match[1] : null
}

function readCardFacts(article) {
  return {
    planvizTag: firstMatch(article, /(<div class="dsh-wp-planviz"[^>]*>)/),
    dataPercent: firstMatch(article, /class="dsh-wp-planviz"[^>]*data-percent="([^"]+)"/),
    dataState: firstMatch(article, /class="dsh-wp-planviz"[^>]*data-state="([^"]+)"/),
    pctText: firstMatch(article, /<span class="dsh-wp-planviz-pct">([^<]*)<\/span>/),
    scopeText: firstMatch(article, /<span class="dsh-wp-planviz-scope">([^<]*)<\/span>/),
    nowText: firstMatch(article, /<span class="dsh-wp-planviz-now-text">([^<]*)<\/span>/),
    badgeText: (firstMatch(article, /<span class="dsh-wp-collapse-badge">([\s\S]*?)<\/span>\s*<\/button>/) || '')
      .replace(/<[^>]+>/g, '')
      .trim(),
    has100: article.includes('100%'),
    // 注意：不能用 article.includes('正在收尾') 判断胶囊——计划标题里也可能
    // 包含这几个字（本脚本的 fixture 标题就含）。胶囊只认 collapse-badge 的文本。
    hasIntegratingLabel: (firstMatch(article, /<span class="dsh-wp-collapse-badge">([\s\S]*?)<\/span>\s*<\/button>/) || '')
      .replace(/<[^>]+>/g, '')
      .trim() === '正在收尾',
    hasAllDone: article.includes('都做完了'),
  }
}

// ───────────────────────────────── 单次执行 ─────────────────────────────────

async function runOnce(index) {
  // 场景 A：最小输入（计划 + 两条状态变更）。
  const sessionA = makeSession(`s-t2-a-${index}`)
  const runtimeA = createWorkplanRuntime({ sessions: { list: () => [sessionA] }, logger: { warn() {} } })
  const planA = makePlan()
  planA.sessionId = sessionA.id
  const recordA = makeRecord(planA)
  runtimeA.state.records.set(sessionA.id, recordA)

  await runtimeA.updateStatus({ session: sessionA }, { subtaskId: 'T1', status: 'done' })
  await runtimeA.updateStatus({ session: sessionA }, { subtaskId: 'T2', status: 'done' })
  const payloadA = runtimeA.plansPayload(sessionA.id)
  const liveA = payloadA.sessions[0]

  // 场景 B：结果消息已落盘（replay 应为 done），主 Agent 复核后再改一次状态。
  const sessionB = makeSession(`s-t2-b-${index}`)
  const runtimeB = createWorkplanRuntime({ sessions: { list: () => [sessionB] }, logger: { warn() {} } })
  const planB = makePlan()
  planB.sessionId = sessionB.id
  const recordB = makeRecord(planB)
  runtimeB.state.records.set(sessionB.id, recordB)

  await runtimeB.updateStatus({ session: sessionB }, { subtaskId: 'T1', status: 'done' })
  await runtimeB.updateStatus({ session: sessionB }, { subtaskId: 'T2', status: 'done' })
  // dispatchTool 在结果消息 append 成功后的行为：
  recordB.phase = 'done'
  recordB.resultWritten = true
  sessionB.append('user/message', buildPlanMessage(planB))
  sessionB.append('user/message', buildResultMessage({
    planId: planB.planId,
    sessionId: sessionB.id,
    dispatchedAt: PLAN_CREATED_AT + 1000,
    statuses: recordB.statuses,
    errors: [],
    stats: computeStats(recordB.statuses),
    phase: 'integrating',
    resumeCount: 0,
    resumeAvailable: true,
  }))
  // 主 Agent 按提示词复核：把 T2 退回 in_progress 再确认 done。
  await runtimeB.updateStatus({ session: sessionB }, { subtaskId: 'T2', status: 'in_progress' })
  await runtimeB.updateStatus({ session: sessionB }, { subtaskId: 'T2', status: 'done' })
  const payloadB = runtimeB.plansPayload(sessionB.id)
  const liveB = payloadB.sessions[0]
  const replayB = reconstructFromSession(sessionB)
  if (replayB) replayB.stats = derivePlanSnapshot(replayB.statuses).stats

  const html = await renderDashboard([liveA])
  const article = sliceArticle(html, liveA.sessionId)
  const card = readCardFacts(article)

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      a: sessionDigest(liveA),
      b: sessionDigest(liveB),
      replayB: { phase: replayB?.phase, stats: replayB?.stats },
      card: {
        dataPercent: card.dataPercent,
        dataState: card.dataState,
        pctText: card.pctText,
        scopeText: card.scopeText,
        nowText: card.nowText,
        badgeText: card.badgeText,
      },
    }))
    .digest('hex')

  return { index, liveA, liveB, replayB, card, fingerprint, payloadA }
}

// ─────────────────────────────────── 主流程 ───────────────────────────────────

const results = []
for (let index = 1; index <= RUNS; index += 1) results.push(await runOnce(index))
const first = results[0]
const { liveA, liveB, replayB, card } = first

console.log(`\n=== 第 1 次执行的原始状态快照（plansPayload.sessions[0]）===`)
console.log(JSON.stringify({
  sessionId: liveA.sessionId,
  phase: liveA.phase,
  stats: liveA.stats,
  statuses: liveA.statuses.map((item) => ({
    subtaskId: item.subtaskId,
    status: item.status,
    progress: item.progress,
    finishedAt: item.finishedAt,
  })),
}, null, 2))

console.log(`\n=== 同一 payload 经 client.js 渲染出的卡片关键片段 ===`)
console.log(`planviz 开标签: ${card.planvizTag}`)
console.log(`百分比: ${card.pctText} · ${card.scopeText}`)
console.log(`「现在」: ${card.nowText}`)
console.log(`阶段胶囊: ${card.badgeText}`)
console.log(`卡片同时包含「100%」=${card.has100}，「正在收尾」=${card.hasIntegratingLabel}，「都做完了」=${card.hasAllDone}`)

console.log(`\n=== 场景 B：结果已落盘后再次 update ===`)
console.log(`实时缓存（plansPayload）: phase=${liveB.phase} · done=${liveB.stats.done}/${liveB.stats.total} · progress=${liveB.stats.progress}`)
console.log(`会话日志回放（reconstructFromSession）: phase=${replayB?.phase} · done=${replayB?.stats?.done}/${replayB?.stats?.total} · progress=${replayB?.stats?.progress}`)

console.log(`\n=== 稳定性（连续 ${RUNS} 次，指纹一致即稳定）===`)
for (const item of results) console.log(`第 ${item.index} 次: ${item.fingerprint.slice(0, 16)}…  phase=${item.liveA.phase} pct=${item.card.pctText} badge=${item.card.badgeText}`)
const stable = results.every((item) => item.fingerprint === first.fingerprint)
check('稳定性', stable, stable ? `${RUNS}/${RUNS} 次指纹一致` : '各次指纹不一致（偶发）')

console.log('\n=== 断言 ===')
if (EXPECT_FIXED) {
  check(
    '场景 A 计划层 phase 为 done（全部完成即终态）',
    liveA.phase === 'done',
    `payload.phase=${liveA.phase}`,
  )
  check(
    '场景 A 统计显示全部完成',
    liveA.stats.done === liveA.stats.total && liveA.stats.total === 2 && liveA.stats.progress === 100,
    `done=${liveA.stats.done}/${liveA.stats.total} · progress=${liveA.stats.progress}`,
  )
  check(
    '场景 A 卡片胶囊为已完成，且不再出现「正在收尾」',
    card.badgeText === '已完成' && card.hasIntegratingLabel === false,
    `badge=${card.badgeText} · hasIntegrating=${card.hasIntegratingLabel}`,
  )
  check(
    '场景 A 不再出现「100% + 正在收尾」同卡并存',
    !(card.dataPercent === '100' && card.hasIntegratingLabel),
    `data-percent=${card.dataPercent} · hasIntegrating=${card.hasIntegratingLabel}`,
  )
  check(
    '场景 A 图表状态与胶囊一致',
    card.dataState === 'done' && card.badgeText === '已完成',
    `data-state=${card.dataState} · badge=${card.badgeText}`,
  )
  check(
    '场景 B 实时缓存与日志回放一致',
    liveB.phase === 'done' && replayB?.phase === 'done',
    `live=${liveB.phase} · replay=${replayB?.phase}`,
  )
  check(
    '场景 A 载荷不带不变量告警',
    !Array.isArray(liveA.violations) || liveA.violations.length === 0,
    `violations=${JSON.stringify(liveA.violations ?? null)}`,
  )
} else {
  check(
    '场景 A 计划层 phase 为 integrating',
    liveA.phase === 'integrating',
    `payload.phase=${liveA.phase}`,
  )
  check(
    '场景 A 统计显示全部完成',
    liveA.stats.done === liveA.stats.total && liveA.stats.total === 2 && liveA.stats.progress === 100,
    `done=${liveA.stats.done}/${liveA.stats.total} · progress=${liveA.stats.progress}`,
  )
  check(
    '场景 A 卡片同时给出 100% / 都做完了 / 正在收尾',
    card.dataPercent === '100' && card.pctText === '100%' && card.nowText === '都做完了' && card.badgeText === '正在收尾',
    `data-percent=${card.dataPercent} · pct=${card.pctText} · now=${card.nowText} · badge=${card.badgeText}`,
  )
  check(
    '场景 B 实时缓存与日志回放不一致',
    liveB.phase === 'integrating' && replayB?.phase === 'done',
    `live=${liveB.phase} · replay=${replayB?.phase}（刷新即翻转）`,
  )
  console.log('\n结论：以上断言全部 PASS 即表示矛盾已在真实代码路径上复现。')
}

console.log(`\n${failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
