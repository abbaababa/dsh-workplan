/*
 * [T9][用户要求6] 部门负责人任务完成 → 主 Agent 即时汇报回归。
 *
 * 缺口（负责人独立核实，runtime.ts 2026-11-12 版）：
 *  ① wait 模式 notifyCompletion:false，结算不触发 onSubtaskDone（本计划正是
 *     wait 模式）；② 通知文本只有「验收 X/Y」计数，缺逐条验收结论与「待主
 *     Agent 执行事项」；③ 无 head→root 的 completion 留痕。
 *
 * 本文件钉住（模板：tests/notice-channel.test.ts / time-notice-immediate.test.ts /
 * workplan-253-continuation-settlement.test.ts，node:test + assert/strict + 假 ctx）：
 *  A1：多部门分别完成（wait 模式）→ 主会话每部门各收 1 条独立汇报＋各 1 条
 *      kind='completion' 留痕；finishRound 批量补齐与纯读回放都不重报（幂等）。
 *  A2：汇报由插件侧结算即触发，不依赖子 Agent 执行 dispatch/重启安装；
 *      结算备份采纳路径（settleFromOutput 同一 options）同样触发。
 *  A3：文本含明确验收结论＋逐条验收结论＋「待主 Agent 执行事项」（含 D8
 *      手动重启 dsh web 生效建议）。
 *  D7 反例：unverified/空验收/缺失产物一律「未达完美完成判据」，绝不声称完美。
 *  D6 故障注入：append 抛错 → reportPending＋failed 留痕（不静默）；恢复后
 *      finishRound 补齐回报（绝不留无证据的已回报）。
 *
 * 留痕目录一律 env DSH_WORKPLAN_JOURNAL_DIR 指向工作区临时目录（沙箱内
 * ~/.dsh 可能不可写），测后清理（T5 冻结契约 §6.4）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  buildPlanMessage,
  messageText,
  parseResultMessage,
  parseUpdateMessage,
  parseWorkplanMessage,
} from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { readDeptMessages } from '../src/dept-journal.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

const ROOT_ID = 'session-t9-root'
/* 工作区内临时目录（沙箱 workspace-write；cwd 恒为插件根目录）。 */
const BASE = resolve(process.cwd(), '..', '..', '_t9_head_report_20261112')
const cleanupDirs: string[] = []
const originalJournalDir = process.env.DSH_WORKPLAN_JOURNAL_DIR

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => {
  clearInterval(eventLoopAnchor)
  if (originalJournalDir === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = originalJournalDir
  for (const dir of cleanupDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响断言 */ }
  }
})

function makeJournalDir(tag: string) {
  mkdirSync(BASE, { recursive: true })
  const dir = mkdtempSync(join(BASE, `journal-${tag}-`))
  cleanupDirs.push(dir)
  process.env.DSH_WORKPLAN_JOURNAL_DIR = dir
  return dir
}

function makeBackupCwd() {
  mkdirSync(BASE, { recursive: true })
  const cwd = mkdtempSync(join(BASE, 'backup-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  cleanupDirs.push(cwd)
  return cwd
}

function subtask(id: string, department: string, extra: any = {}) {
  return {
    id,
    title: `${id} 交付`,
    department,
    role: '负责人',
    objective: `完成 ${id}`,
    method: ['做'],
    inputs: [],
    outputs: [`${id}_report.md`],
    acceptance: [`${id} 交付物存在`],
    risk: 'low',
    dependsOn: [],
    ...extra,
  }
}

function makePlan(subtasks: any[]) {
  return {
    planId: 'wp-t9-head-completion',
    sessionId: ROOT_ID,
    createdTurn: 1,
    createdAt: 1000,
    title: 'T9 负责人完成即时汇报回归',
    taskUnderstanding: { originalRequest: '部门负责人完成即向主 Agent 独立汇报', deliverable: '每部门一条即时汇报＋completion 留痕' },
    contradictions: { primary: { statement: '轮级批量结果不能替代部门级即时汇报' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks }],
  }
}

function phasesFor(criterion: string) {
  return {
    planning: {
      problemAnalysis: ['第一轮：目标与验收明确；现状为假子会话夹具；约束是不依赖真实宿主服务；主要矛盾是结算即报与幂等不重报并存。'],
      constraints: ['不依赖真实宿主服务'],
      unknowns: [],
      approach: ['第二轮：先构造假会话夹具并核对既有教训 → 释放结算 → 逐条核对通知文本与留痕 → 重复结算核对幂等不重报。'],
      approachBasis: ['第二轮基于第一轮的夹具事实与幂等矛盾，决定用假会话逐条核对通知与留痕两个落点。'],
    },
    execution: { steps: ['构造夹具', '释放结算', '核对通知与留痕'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion, method: '核对产物', evidence: `${criterion} 的证据文件` }],
      requirementCheck: '用户原要求逐条核对：完成即报、幂等、留痕，均覆盖。',
      retrospective: {
        problems: ['现象：夹具首版只断言会话消息；根因：忽略了留痕落点。'],
        detours: [],
        resolutions: ['补读 dept-journal 留痕后断言齐全。'],
        prevention: ['遇到通道类任务，先同时核对会话消息与留痕两个落点再动手。'],
      },
    },
  }
}

function donePayload(id: string, over: any = {}) {
  const criterion = `${id} 交付物存在`
  return {
    status: 'done',
    blockedReason: '',
    phases: phasesFor(criterion),
    acceptance: [{ criterion, result: 'pass', evidence: `reports/${id}.md` }],
    artifacts: [],
    needs: [],
    ...over,
  }
}

function doneOutput(id: string, over: any = {}) {
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(donePayload(id, over))}\n${EVIDENCE_MARKER_END}`
}

function makeSession(cwd?: string) {
  const events: any[] = []
  return {
    id: ROOT_ID,
    header: { createdAt: 1000, ...(cwd ? { cwd } : {}) },
    events,
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
  }
}

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => { release = resolve })
  return { promise, release }
}

function completed(text: string) {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

function makeRuntime(plan: any, opts: any = {}) {
  const session = makeSession(opts.cwd)
  session.append('user/message', buildPlanMessage(plan))
  seedLeaderSelfEffort(session, plan)
  const gates: Array<{ promise: Promise<any>; release: (v: any) => void }> = []
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        const gate = deferred()
        gates.push(gate)
        return { childId: `child-t9-${gates.length}`, result: gate.promise, dispose: async () => {} }
      },
    },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: () => undefined,
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    maxResumes: 4,
    autoResume: false,
    /* 默认严格证据：结构化结果块才会被解析成 structured 判定（strict:false
     * 的旧语义一律 legacy，不解析块——D2 夹具同款口径）。 */
    strictEvidence: true,
    ...opts,
  })
  return { session, runtime, gates }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

/** 计划消息、轮级结果消息、durable 改判记录都不算「即时汇报」。 */
function noticeTexts(session: any): string[] {
  const out: string[] = []
  for (const event of session.events) {
    if (event.type !== 'user/message') continue
    const text = messageText(event.data)
    if (!text) continue
    if (parseWorkplanMessage(event.data)) continue
    if (parseResultMessage(event.data)) continue
    if (parseUpdateMessage(event.data)) continue
    out.push(text)
  }
  return out
}

const completionNotices = (session: any) => noticeTexts(session).filter((text) => text.includes('已完成并结算'))
const roundEnded = (session: any) => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data))

/** 按派发顺序逐个释放假子会话（并行/串行派发都适用）。 */
async function releaseInOrder(gates: any[], outputs: string[]) {
  for (let i = 0; i < outputs.length; i += 1) {
    assert.ok(await waitFor(() => gates.length > i), `第 ${i + 1} 个子任务应被派发`)
    gates[i].release(completed(outputs[i]))
  }
}

/* ------------------------------------------------------------------ *
 * A1+A3：wait 模式多部门分别完成 → 每部门一条独立汇报＋completion 留痕
 * ------------------------------------------------------------------ */

test('A1+A3：wait 模式三部门分别完成，主会话各收 1 条独立汇报＋3 条 completion 留痕，重复结算不重报', async () => {
  makeJournalDir('a1')
  const plan = makePlan([subtask('T1', 'engineering'), subtask('T2', 'research'), subtask('T3', 'design')])
  const { session, runtime, gates } = makeRuntime(plan)
  const dispatching = runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'wait' }, new AbortController().signal)
  await releaseInOrder(gates, [doneOutput('T1'), doneOutput('T2'), doneOutput('T3')])
  const out: any = await dispatching
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.stats.done, 3)

  const notices = completionNotices(session)
  assert.equal(notices.length, 3, 'A1：三个部门各恰 1 条独立即时汇报（wait 模式同样触发）')
  for (const id of ['T1', 'T2', 'T3']) {
    const mine = notices.filter((text) => text.includes(`子任务 ${id} `))
    assert.equal(mine.length, 1, `A1：${id} 只能有 1 条独立汇报`)
    const text = mine[0]
    assert.ok(text.includes('验收结论：1/1 通过'), 'A3：明确验收结论')
    assert.ok(text.includes('完美完成（验收 1/1 全部 pass，structured）'), 'D7：达到行级判据才声称完美完成')
    assert.ok(text.includes('逐条验收结论：') && text.includes(`${id} 交付物存在 → pass`), 'A3：逐条验收结论（criterion＋result）')
    assert.ok(text.includes('待主 Agent 执行事项：'), 'A3：待主 Agent 执行事项段')
    assert.ok(text.includes('手动重启 dsh web') && text.includes('不得自行重启或安装'), 'A3/D8：生效建议（手动重启、不安装）')
    assert.ok(!text.includes('<!-- DSH-WORKPLAN'), '纯文本通知不得带 workplan 标记（回放纯读）')
  }

  const journaled: any = readDeptMessages(plan.planId, { kind: 'completion' })
  assert.equal(journaled.ok, true, JSON.stringify(journaled))
  assert.equal(journaled.messages.length, 3, '每个部门完成各留 1 条 completion 痕')
  for (const message of journaled.messages) {
    assert.equal(message.from.role, 'head')
    assert.equal(message.to.role, 'root')
    assert.equal(message.to.sessionId, ROOT_ID)
    assert.equal(message.data.status, 'done')
    assert.equal(message.data.acceptanceCount, 1)
    assert.equal(message.delivery.status, 'sent')
    assert.ok(['T1', 'T2', 'T3'].includes(message.subtaskId))
  }

  /* 幂等：即时通知 + finishRound 批量补齐后仍各 1 条；重启/刷新回放是纯读。 */
  assert.equal(completionNotices(session).length, 3, 'finishRound 批量补齐不得重报')
  const before = session.events.length
  const rebuilt: any = reconstructFromSession(session)
  assert.ok(rebuilt?.plan, '回放应重建计划')
  assert.equal(session.events.length, before, '回放是纯读，不得追加（重复）通知')
  assert.equal(completionNotices(session).length, 3, '回放后汇报仍只有 3 条')
  for (const row of rebuilt.statuses) {
    assert.equal(row.closure, 'reported', '先写通知后记回报：通知落盘后才 reported')
    assert.equal(row.report?.state, 'sent')
  }
})

/* ------------------------------------------------------------------ *
 * A2：结算备份采纳路径同样触发（不依赖子 Agent dispatch/重启安装）
 * ------------------------------------------------------------------ */

test('A2：wait 模式结果块缺失但盘上备份新鲜且归属匹配 ⇒ 采纳结算即触发即时汇报＋留痕', async () => {
  makeJournalDir('a2')
  const cwd = makeBackupCwd()
  const plan = makePlan([subtask('T1', 'engineering')])
  /* 新鲜备份（mtime 晚于本次尝试 startedAt，用未来时间戳钉死）＋归属匹配：
   * 单次激活即采纳（与 workplan-253 D2-2 同款口径）。 */
  const backup = donePayload('T1', { planId: plan.planId, subtaskId: 'T1' })
  const backupFile = join(cwd, 'reports', 'wp-settlement-T1.json')
  writeFileSync(backupFile, JSON.stringify(backup))
  const future = new Date(Date.now() + 60_000)
  utimesSync(backupFile, future, future)
  const { session, runtime, gates } = makeRuntime(plan, { cwd, strictEvidence: true })
  const dispatching = runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'wait' }, new AbortController().signal)
  assert.ok(await waitFor(() => gates.length >= 1), 'T1 应被派发')
  /* 子会话只交散文（忘记结果块）：插件侧采纳备份结算——汇报不依赖子 Agent
   * 执行 dispatch、也不依赖任何重启/安装动作。 */
  gates[0].release(completed('活干完了，报告如下：一切正常。（忘记附结果块）'))
  const out: any = await dispatching
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.stats.done, 1, '备份采纳后正常结算 done')
  const record: any = runtime.state.records.get(session.id)
  assert.ok((record?.errors ?? []).some((line: string) => line.includes('已采纳盘上结算备份')), '采纳来源留档')
  const notices = completionNotices(session)
  assert.equal(notices.length, 1, 'A2：备份采纳路径同样触发即时汇报（wait 模式）')
  assert.ok(notices[0].includes('子任务 T1') && notices[0].includes('验收结论：1/1 通过'))
  const journaled: any = readDeptMessages(plan.planId, { kind: 'completion' })
  assert.equal(journaled.ok, true)
  assert.equal(journaled.messages.length, 1)
  assert.equal(journaled.messages[0].delivery.status, 'sent')
})

/* ------------------------------------------------------------------ *
 * D7 反例：未达行级完美完成判据绝不声称完美
 * ------------------------------------------------------------------ */

test('D7 反例：unverified/空验收/缺失产物都保留结算通知但明确「未达完美完成判据」', async () => {
  makeJournalDir('d7')
  const plan = makePlan([subtask('T1', 'engineering'), subtask('T2', 'research', { acceptance: [] }), subtask('T3', 'design')])
  const { session, runtime, gates } = makeRuntime(plan)
  const dispatching = runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'wait' }, new AbortController().signal)
  await releaseInOrder(gates, [
    /* T1：验收 unverified → done 但证据未验证。 */
    doneOutput('T1', { acceptance: [{ criterion: 'T1 交付物存在', result: 'unverified', evidence: '' }] }),
    /* T2：计划未定义验收项且结果块 acceptance 为空 → done/unverified（空验收不是全 pass）。 */
    doneOutput('T2', { acceptance: [] }),
    /* T3：声明产物不存在 → missingArtifacts。 */
    doneOutput('T3', { artifacts: [{ kind: 'file', ref: 'reports/t9-not-exists.md' }] }),
  ])
  const out: any = await dispatching
  assert.equal(out.ok, true, JSON.stringify(out))
  const notices = completionNotices(session)
  assert.equal(notices.length, 3, '未达完美也保留结算通知（不静默）')
  for (const text of notices) {
    assert.ok(text.includes('未达完美完成判据：'), '必须显式写明缺口')
    assert.ok(!text.includes('完美完成（验收'), '绝不声称完美完成')
  }
  const t1 = notices.find((text) => text.includes('子任务 T1 '))!
  assert.ok(t1.includes('证据等级为 unverified') || t1.includes('验收未全部 pass'), 'T1：unverified 缺口可见')
  const t2 = notices.find((text) => text.includes('子任务 T2 '))!
  assert.ok(t2.includes('未提供验收项') || t2.includes('证据等级为'), 'T2：空验收/legacy 缺口可见')
  const t3 = notices.find((text) => text.includes('子任务 T3 '))!
  assert.ok(t3.includes('缺少声明产物') && t3.includes('缺失产物待补'), 'T3：缺失产物进入缺口与待办段')
})

/* ------------------------------------------------------------------ *
 * D6 故障注入：append 抛错 → reportPending＋failed 留痕；finishRound 补齐
 * ------------------------------------------------------------------ */

test('D6：通知写失败置 reportPending＋failed 留痕（不静默）；恢复后 finishRound 补齐回报', async () => {
  makeJournalDir('d6')
  const plan = makePlan([subtask('T1', 'engineering'), subtask('T2', 'research', { dependsOn: ['T1'] })])
  const { session, runtime, gates } = makeRuntime(plan)
  const originalAppend = session.append.bind(session)
  let failNotice = true
  session.append = (type: string, data: any) => {
    const text = typeof data === 'string' ? data : String(data?.content?.[0]?.text ?? '')
    if (failNotice && type === 'user/message' && text.includes('已完成并结算')) throw new Error('log full')
    return originalAppend(type, data)
  }
  await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(() => gates.length >= 1), 'T1 应被派发')
  gates[0].release(completed(doneOutput('T1')))
  /* 写失败：failed 留痕落盘、reportPending=true、绝不记无证据的 reported。 */
  assert.ok(await waitFor(() => {
    const journal: any = readDeptMessages(plan.planId, { kind: 'completion' })
    return journal.ok && journal.messages.some((message: any) => message.subtaskId === 'T1' && message.delivery?.status === 'failed')
  }), 'D6：投递失败必须显式留 failed 痕，不静默丢弃')
  const record: any = runtime.state.records.get(session.id)
  assert.equal(record.reportPending, true, '写失败必须置 reportPending（交 finishRound 补齐）')
  const t1Row = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.notEqual(t1Row.closure, 'reported', '绝不留无证据的已回报')
  assert.equal(completionNotices(session).length, 0, '写失败的通知不得落盘')
  const failedEntry = (readDeptMessages(plan.planId, { kind: 'completion' }) as any).messages
    .find((message: any) => message.subtaskId === 'T1')
  assert.ok(String(failedEntry.delivery.error ?? '').includes('log full'), 'failed 留痕带可诊断错误')

  /* 恢复写入 → 放行 T2 → 轮结束：finishRound 批量补齐回报（D6 可重试）。 */
  failNotice = false
  assert.ok(await waitFor(() => gates.length >= 2), 'T1 结算后 T2 应被派发')
  gates[1].release(completed(doneOutput('T2')))
  assert.ok(await waitFor(() => roundEnded(session)), '轮级结果消息应出现（finishRound 已跑完）')
  const settled: any = runtime.state.records.get(session.id)
  assert.equal(settled.reportPending, false, 'finishRound 补齐后 reportPending 收敛为 false')
  for (const id of ['T1', 'T2']) {
    const row = settled.statuses.find((item: any) => item.subtaskId === id)
    assert.equal(row.closure, 'reported', `${id} 由 finishRound 补齐回报`)
    assert.equal(row.report?.state, 'sent')
  }
  const journal: any = readDeptMessages(plan.planId, { kind: 'completion' })
  assert.ok(journal.messages.some((message: any) => message.subtaskId === 'T1' && message.delivery.status === 'failed'), 'failed 留痕保留可审计')
  assert.ok(journal.messages.some((message: any) => message.subtaskId === 'T2' && message.delivery.status === 'sent'), '恢复后 T2 正常投递并留 sent 痕')
  assert.ok(completionNotices(session).some((text) => text.includes('子任务 T2 ')), '恢复后 T2 的即时汇报正常落盘')
})
