/*
 * [执行时限取消][T3·质量验证] 专家执行时间机制——场景级独立验证
 *
 * 当前契约：部门负责人与全球顶尖专家执行无时限，timeNotice/预估值只是信息；
 * 旧 childTimeoutMs / totalTimeoutMs / extendMs / 二次接手都不再形成生产时限。
 * 场景：
 *   - A：预估上报通知只含信息义务与“不影响验收”，timeNotice 进入模型可读面；
 *   - B：旧 extendMs 明确 TIME_LIMITS_DISABLED，不写截止、不打扰专家；
 *   - C：旧 900ms 窗口远超后仍 in_progress，不接手、磁盘产物哈希不变；
 *   - D：正常完成路径不受影响，无超时/接手/延期通知。
 * 仍保留：用户显式取消、真实错误、证据与质量门禁。
 */
import test, { after } from 'node:test'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlanMessage, parseResultMessage } from '../src/plan.js'
import {
  createWorkplanRuntime,
  modelStatusLines,
} from '../src/runtime.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
const workRoot = mkdtempSync(join(tmpdir(), 'wp-qa-t3-'))
after(() => {
  clearInterval(eventLoopAnchor)
  rmSync(workRoot, { recursive: true, force: true })
})

function makePlanMessage(planId: string, outputs: string[]) {
  return buildPlanMessage({
    planId,
    sessionId: `session-${planId}`,
    createdTurn: 1,
    createdAt: 1000,
    title: 'QA 场景验证',
    taskUnderstanding: { originalRequest: '验证 2.3.0 时间机制四场景', deliverable: '场景验证报告' },
    contradictions: { primary: { statement: '超时处理需在放宽与接手之间有序升级' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '长任务',
        department: 'engineering',
        objective: '四场景机制验证',
        method: ['执行'],
        inputs: [],
        outputs,
        acceptance: ['产出报告'],
        risk: '超时',
        dependsOn: [],
      }],
    }],
  })
}

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => { release = resolve })
  return { promise, release }
}

function makeRuntime(planId: string, outputs: string[], options: any = {}) {
  const session: any = {
    id: `session-${planId}`,
    header: { createdAt: 1000, cwd: workRoot },
    events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) {
      this.events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', makePlanMessage(planId, outputs))
  seedLeaderSelfEffort(session, { planId, stages: [{ subtasks: [{ id: 'T1' }] }] })
  const gate = deferred()
  const sent: any[] = []
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        started = true
        return { childId: `child-${planId}`, result: gate.promise, dispose: async () => {} }
      },
      sendMessage: async (_agent: any, childId: string, parts: any[]) => {
        sent.push({ childId, text: String(parts?.[0]?.text ?? '') })
        return 'msg-qa'
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx as any, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    strictEvidence: false,
    ...options,
  })
  return { session, runtime, gate, sent, hasStarted: () => started }
}

async function waitFor(check: () => boolean, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function rowOf(runtime: any, session: any) {
  const snapshot: any = await runtime.statusTool({ session }, {})
  return (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
}

function messageTexts(session: any) {
  return session.events
    .filter((event: any) => event.type === 'user/message')
    .map((event: any) => String(event.data?.content?.[0]?.text ?? event.data?.text ?? ''))
}

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/* ============================ 场景 A ============================ */

test('场景A：预估上报后通知含预估分钟与「告知用户」义务，且 timeNotice 进入模型可读面', async () => {
  // 现实时序（与用户要求 1 一致）：主 Agent 先分配工作（dispatch），执行中的
  // 专家才上报预估。派发前无活跃 record，timeNotice 属契约外输入（QA 记录为
  // 观察项 D-T3-1，非 2.3.0 回归：2.2.0 O-2a 起行为相同），本用例走真实时序。
  const { session, runtime, gate, hasStarted } = makeRuntime('wp-qa-a', ['T1_report.md'], { childTimeoutMs: 30_000 })
  await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  const res: any = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    timeNotice: { declaredMinutes: 22, reason: 'QA 场景A：含实现与回归' },
  })
  assert.equal(res?.ok, true, 'timeNotice 事务应放行')
  const notice = messageTexts(session).find((text: string) => text.includes('专家预估上报'))
  assert.ok(notice, '主会话应出现【专家预估上报】即时通知')
  assert.match(notice!, /22 分钟/, '通知含专家上报的预估分钟数（22）')
  assert.match(notice!, /请把此预期执行时间告知用户/, '通知要求主 Agent 把预估时间告知用户（用户要求 1 前半段）')
  assert.match(notice!, /不会形成执行截止、超时接管或完成验收门槛/, '通知明确預估不产生时限/接手/验收门')
  assert.doesNotMatch(notice!, /放宽|extendMs|第二次超时/, '通知不再引导延期或二次接手')
  // 模型可读面：主 Agent 在通知之外也要能从状态行读到预估（防止通知被忽略）。
  const row = await rowOf(runtime, session)
  assert.equal(Number(row?.timeNotice?.declaredMinutes), 22, 'statusTool 行应携带 timeNotice（真实时序）')
  const readable: any = modelStatusLines([row])[0]
  assert.equal(Number(readable?.timeNotice?.declaredMinutes), 22, 'timeNotice 已透出到模型可读面（T1 修复点复验）')
  const journal = (readable?.timeJournal ?? []).map((item: any) => item.action)
  assert.ok(journal.includes('estimate'), 'timeJournal 留痕 estimate（审计链）')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
})

/* ============================ 场景 B ============================ */

test('场景B（新契约）：旧 extendMs 只返回 TIME_LIMITS_DISABLED，不写截止/不投延期告知', async () => {
  const { session, runtime, gate, sent, hasStarted } = makeRuntime('wp-qa-b', ['T1_report.md'], { childTimeoutMs: 30_000 })
  await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  const before = await rowOf(runtime, session)
  assert.equal(before?.deadlineAt ?? null, null, '运行中状态行不再有 deadlineAt')
  const res: any = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 5_000, reason: 'QA 场景B：旧延期请求' })
  assert.equal(res?.ok, false)
  assert.equal(res?.code, 'TIME_LIMITS_DISABLED', '旧延期请求明确告知时限已取消')
  assert.equal(res?.childNotified, undefined, '不向专家投递延期告知')
  const after = await rowOf(runtime, session)
  assert.equal(after?.deadlineAt ?? null, null, '仍无截止时间')
  assert.equal(after?.status, 'in_progress', '延期被拒不影响执行')
  assert.equal(sent.length, 0, '专家零打扰')
  const journal = (after?.timeJournal ?? []).map((item: any) => item.action)
  assert.ok(!journal.includes('extend'), '不得写 extend 假账')
  assert.ok(!journal.includes('notify-expert'))
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
})

test('场景B（新契约）：旧 400ms 窗口到点仍执行，不产生执行中断/放宽/接手通知', async () => {
  const { session, runtime, gate, hasStarted } = makeRuntime('wp-qa-b2', ['T1_report.md'], { childTimeoutMs: 400, totalTimeoutMs: 400_000 })
  await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  await new Promise((resolve) => setTimeout(resolve, 900))
  const row = await rowOf(runtime, session)
  assert.equal(row?.status, 'in_progress', '旧单次窗口到点后仍必须执行')
  assert.equal(row?.deadlineAt ?? null, null)
  assert.equal(Number(row?.timeoutCount ?? 0), 0, '不累计超时次数')
  assert.notEqual(row?.takeoverRequired, true, '永不由 400ms 旧窗口触发接手')
  const allText = messageTexts(session).join('\n')
  assert.doesNotMatch(allText, /执行中断|延期告知|extendMs|takeoverRequired/, '不产生时限相关通知')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] })
})

/* ============================ 场景 C（含 A2 哈希） ============================ */

test('场景C（新契约）：旧 900ms 窗口运行两倍时长仍不接手，磁盘产物原样保留', async () => {
  const artifact = join(workRoot, 'T1_report.md')
  const earlyWork = '# 专家已完成部分\n' + 'done-steps: A/B/C 三条链路已落地\n'
  writeFileSync(artifact, earlyWork)
  const hashBefore = sha256(artifact)
  const { session, runtime, gate, hasStarted } = makeRuntime('wp-qa-c', ['T1_report.md', 'T1_tests.md'], { childTimeoutMs: 900, totalTimeoutMs: 400_000 })
  await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  const row: any = await rowOf(runtime, session)
  assert.equal(row?.status, 'in_progress', '超过旧窗口两倍仍继续执行')
  assert.notEqual(row?.takeoverRequired, true, '不再有二次超时/接手')
  assert.equal(Number(row?.timeoutCount ?? 0), 0)
  assert.equal(row?.takeoverBrief ?? null, null, '不生成接手清单')
  assert.equal(sha256(artifact), hashBefore, '【A2】执行期间磁盘产物 sha256 原样保留')
  const readable: any = modelStatusLines([row])[0]
  assert.equal(readable?.executionTimeLimit, 'none')
  assert.equal(readable?.deadlineAt ?? null, null)
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] })
})

/* ============================ 场景 D（回归） ============================ */

test('场景D：不超时正常完成——既有结算路径零变化，无接手/放宽/预估通知、专家零打扰', async () => {
  const { session, runtime, gate, sent, hasStarted } = makeRuntime('wp-qa-d', ['T1_report.md'], { childTimeoutMs: 30_000 })
  await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  const running = await rowOf(runtime, session)
  assert.match(String(running?.status ?? ''), /in_progress|running/, '运行中状态行应为执行中')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: '正常完成' }] })
  // 正常收束：本轮应像 2.2.x 一样产生可解析的结算结果消息（既有路径不受影响）。
  assert.ok(await waitFor(() => session.events.some((event: any) =>
    event.type === 'user/message' && parseResultMessage(event.data)), 10_000), '既有结算路径应正常产生结果消息')
  const row = await rowOf(runtime, session)
  assert.equal(Number(row?.timeoutCount ?? 0), 0, '未超时：timeoutCount 必须为 0')
  assert.notEqual(row?.takeoverRequired, true, '未超时：不得出现 takeoverRequired')
  assert.notEqual(row?.pendingAdjudication, true, '未超时：不得出现待裁决标记')
  const allText = messageTexts(session).join('\n')
  assert.doesNotMatch(allText, /延期告知|执行中断|专家预估上报/, '无超时/无预告时，不得产生任何新机制通知（回归零打扰）')
  assert.equal(sent.length, 0, '未超时时插件不得向专家投递任何消息')
  assert.ok(!(row?.timeJournal ?? []).some((item: any) => item.action === 'timeout' || item.action === 'notify-expert'),
    'timeJournal 不得有 timeout/notify-expert 留痕')
})
