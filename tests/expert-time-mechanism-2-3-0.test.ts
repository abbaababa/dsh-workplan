/*
 * 专家执行时间机制 —— 无时限契约与历史保护原语。
 *
 * 新契约：
 *  - A1 开工预估仍登记并告知用户，但它只是信息，不派生截止；
 *  - A2 旧 extendMs / childTimeoutMs 不再放宽或重启任何计时器；
 *  - A3 旧小窗口到期后负责人/专家仍存活，不 timeout、不二次接手；
 *  - A4 显式取消/真实错误仍可收束，历史 takeover/产物保护纯函数继续可用。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlanMessage } from '../src/plan.js'
import {
  createWorkplanRuntime,
  buildTakeoverBrief,
  mergePreservedArtifacts,
} from '../src/runtime.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
const workRoot = mkdtempSync(join(tmpdir(), 'wp-time-230-'))
after(() => {
  clearInterval(eventLoopAnchor)
  rmSync(workRoot, { recursive: true, force: true })
})

function makePlanMessage(subtaskExtra: any = {}) {
  return buildPlanMessage({
    planId: 'wp-time-230',
    sessionId: 'session-time-230',
    createdTurn: 1,
    createdAt: 1000,
    title: '专家时间机制验收',
    taskUnderstanding: { originalRequest: '验证 2.3.0 时间机制', deliverable: '机制回归' },
    contradictions: { primary: { statement: '超时处理需要在放宽与接手之间有序升级' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '长任务',
        department: 'engineering',
        objective: '验证时间机制',
        method: ['执行'],
        inputs: [],
        outputs: ['T1_report.md'],
        acceptance: ['产出报告'],
        risk: '超时',
        dependsOn: [],
        ...subtaskExtra,
      }],
    }],
  })
}

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => { release = resolve })
  return { promise, release }
}

function makeRuntime(options: any = {}) {
  const session: any = {
    id: 'session-time-230',
    header: { createdAt: 1000, cwd: workRoot },
    events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) {
      this.events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', makePlanMessage())
  const gate = deferred()
  const sent: any[] = []
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        started = true
        return { childId: 'child-230', result: gate.promise, dispose: async () => {} }
      },
      sendMessage: async (_agent: any, childId: string, parts: any[]) => {
        sent.push({ childId, text: String(parts?.[0]?.text ?? '') })
        return 'msg-1'
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

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function rowOf(runtime: any, session: any) {
  const snapshot: any = await runtime.statusTool({ session }, {})
  return (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
}

function messageTexts(session: any) {
  return session.events
    .filter((event: any) => event.type === 'user/message')
    .map((event: any) => String(event.data?.content?.[0]?.text ?? event.data?.text ?? ''))
}

test('A1 预估上报→告知用户：timeNotice 仅作信息登记，不派生执行截止', async () => {
  const { session, runtime } = makeRuntime()
  const res: any = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    timeNotice: { declaredMinutes: 18, reason: '含实现与回归，预计 18 分钟' },
  })
  assert.equal(res?.ok, true, 'timeNotice 纯信息登记应放行')
  assert.equal(Number(res?.timeNotice?.declaredMinutes), 18, '状态行 timeNotice 已落档')
  const notice = messageTexts(session).find((text: string) => text.includes('专家预估上报'))
  assert.ok(notice, '主会话应出现【专家预估上报】通知')
  assert.match(notice!, /18/, '通知含预估分钟数')
  assert.match(notice!, /不会形成执行截止/, '通知明确预估不形成截止或验收门槛')
  const row = await rowOf(runtime, session)
  assert.equal(row?.executionTimeLimit, 'none')
  assert.equal(row?.deadlineAt, null)
})

test('A2 旧 childTimeoutMs/extendMs 不创建或延长执行时限', async () => {
  const { session, runtime, gate, sent, hasStarted } = makeRuntime({ childTimeoutMs: 1_000 })
  const dispatchP = runtime.dispatchTool(
    { session, options: {} },
    { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' },
    new AbortController().signal,
  )
  assert.ok(await waitFor(hasStarted), 'T1 应已派发')
  const extension: any = await runtime.updateStatus(
    { session },
    { subtaskId: 'T1', extendMs: 2_000, reason: '旧调用兼容探针' },
  )
  assert.equal(extension?.ok, false, '已无截止可延期')
  assert.equal(extension?.code, 'TIME_LIMITS_DISABLED')
  assert.equal(sent.length, 0, '不再发送“新截止时间”通知，因为没有截止')
  await sleep(1_300)
  const row = await rowOf(runtime, session)
  assert.equal(row?.status, 'in_progress', '越过旧 1 秒窗口仍必须存活')
  assert.equal(row?.deadlineAt, null)
  assert.equal(row?.executionTimeLimit, 'none')
  assert.equal(Number(row?.timeoutCount ?? 0), 0)
  assert.equal(row?.takeoverRequired, false)
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
  await dispatchP
})

test('A3 旧 1 秒/20 天窗口到期不自动 blocked、不二次接手；显式取消仍有效', async () => {
  const { session, runtime, gate, hasStarted } = makeRuntime({
    childTimeoutMs: 1_000,
    totalTimeoutMs: 2_000,
  })
  const controller = new AbortController()
  const dispatchP = runtime.dispatchTool(
    { session, options: {} },
    { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' },
    controller.signal,
  )
  assert.ok(await waitFor(hasStarted), 'T1 应已派发')
  await sleep(2_500)
  const row = await rowOf(runtime, session)
  assert.equal(row?.status, 'in_progress', '越过旧子任务与整轮窗口仍必须存活')
  assert.equal(row?.deadlineAt, null, '旧截止不得重新武装或显示')
  assert.equal(row?.takeoverRequired, false, '不再有二次超时接手')
  assert.equal(Number(row?.timeoutCount ?? 0), 0)
  assert.equal(
    messageTexts(session).some((text: string) => text.includes('执行中断') && text.includes('接手')),
    false,
    '不得自动发二次接手通知',
  )
  controller.abort()
  await dispatchP
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] })
})

test('A4 历史接管产物保护纯函数继续可用：只增不减', () => {
  const brief = buildTakeoverBrief(
    { outputs: ['T1_report.md', 'T1_tests.md'], acceptance: ['A1'] },
    { artifacts: [{ kind: 'file', ref: 'T1_report.md', exists: true }, { kind: 'note', ref: 'x' }] },
    ['T1_report.md'],
    2,
  )
  assert.deepEqual(brief.landedRefs, ['T1_report.md'], '已落盘清单照录')
  assert.deepEqual(brief.remainingOutputs, ['T1_tests.md'], '未完成 = outputs 去掉已落盘')
  assert.match(brief.instruction, /禁止丢弃/, 'instruction 保留「禁止丢弃已完成部分」')
  const merged = mergePreservedArtifacts([{ kind: 'file', ref: 'new.md', exists: true }], ['protected.md', 'protected.md'])
  assert.ok(merged.some((item: any) => item.ref === 'new.md'), '新写入保留')
  const preserved = merged.filter((item: any) => item.ref === 'protected.md')
  assert.equal(preserved.length, 1, '保护条目去重并入')
  assert.equal(preserved[0].exists, true, '保护条目固定存在语义')
  const before = [{ kind: 'file', ref: 'a.md', exists: true }]
  const after = mergePreservedArtifacts(before, ['b.md'])
  assert.ok(after.length >= before.length && before.every((item: any) => after.some((x: any) => x.ref === item.ref)),
    '任何合并都不得删除既有条目')
})
