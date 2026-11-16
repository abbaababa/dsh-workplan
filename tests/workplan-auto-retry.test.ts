/*
 * [执行时限取消][原 1.10.6 自动重试] 集成回归：
 * 部门负责人/专家执行无时限后，旧 childTimeoutMs / totalTimeoutMs 到点既不能
 * 杀任务，也不能触发自动重试或产物冲突误报。真正的安全边界仍然保留：
 *  1) 旧窗口到点后只启动一次，任务继续，真实完成才结算；
 *  2) 旧窗口不产生 artifactConflict、不改写磁盘产物；
 *  3) 用户显式取消仍可立即收束，不会被“无时限”变成无法停止。
 */
import test, { after } from 'node:test'
import { selfEffortStatuses } from './helpers/self-effort-contract.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { derivePlanSnapshot } from '../src/plan.js'
import { dispatchPlan } from '../src/runtime.js'

/*
 * `dispatchPlan` 的计时器都是 unref 的（宿主关闭时不能被插件拖住），而 Node 22
 * 在事件循环空掉时会取消挂起的测试。真正的宿主总有 HTTP server 这类 ref 句柄，
 * 这里用一个 1 秒心跳代替它，60 秒后自行放手，避免真卡死时拖住 CI。
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlan(outputs: string[] = []) {
  return {
    planId: 'wp-auto-retry',
    sessionId: 'session-auto-retry',
    createdTurn: 1,
    createdAt: 1000,
    title: '硬超时自动重试一次',
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '写报告',
        department: 'engineering',
        objective: '写报告',
        method: ['写'],
        inputs: [],
        outputs,
        acceptance: ['报告存在'],
        risk: 'low',
        dependsOn: [],
      }],
    }],
  }
}

function makeRecord(plan: any): any {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: selfEffortStatuses(plan),
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
    id: 'session-auto-retry',
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

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function makeCtx(startActivation: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: (spec: any) => startActivation(spec) },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

test('旧 childTimeout 到点不再杀/不再自动重试；真实完成只启动一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-auto-retry-'))
  mkdirSync(join(dir, 'out'), { recursive: true })
  try {
    const plan = makePlan(['out/report.md'])
    const record = makeRecord(plan)
    const session = makeSession()
    const prompts: string[] = []
    let calls = 0
    let release!: (value: any) => void
    const gate = new Promise<any>((resolve) => { release = resolve })
    const ctx = makeCtx((spec: any) => {
      calls += 1
      prompts.push(String(spec?.prompt?.[0]?.text ?? ''))
      writeFileSync(join(dir, 'out/report.md'), '# first attempt\n')
      return { childId: 'child-hang', result: gate, dispose: async () => {} }
    })

    const dispatch = dispatchPlan(ctx, record, {
      agent: { session, options: {} },
      signal: new AbortController().signal,
      cwd: dir,
      idleTimeoutMs: 60_000,
      childTimeoutMs: 500,
      totalTimeoutMs: 800,
      strictEvidence: false,
    })
    assert.ok(await waitFor(() => calls === 1, 5_000), '任务应已启动')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const running = record.statuses.find((item: any) => item.subtaskId === 'T1')
    assert.equal(running?.status, 'in_progress', '旧单次/整轮窗口到点后仍在执行')
    assert.equal(calls, 1, '不自动启动第二次')

    release({ stopReason: 'completed', output: [{ type: 'text', text: '完成' }] })
    const result = await dispatch
    assert.ok(result)
    assert.equal(calls, 1, '真实完成全程只启动一次')
    assert.equal(prompts.length, 1)
    const stats = derivePlanSnapshot(record.statuses).stats
    assert.equal(stats.done, 1)
    assert.equal(stats.blocked, 0)
    assert.equal(record.phase, 'done')
    const row = record.statuses.find((item: any) => item.subtaskId === 'T1')
    assert.equal(row?.status, 'done')
    assert.equal(row?.artifactConflict, undefined, '无冲突时不得留下 artifactConflict')
    assert.ok(!record.errors.some((line: string) => /自动重试|CHILD_TIMEOUT/.test(line)), '不再产生超时重试留痕')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧超时窗口不产生 artifactConflict、不改写产物；显式取消仍立即收束', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-auto-retry-cancel-'))
  try {
    const plan = makePlan(['out/report.md'])
    const record = makeRecord(plan)
    const session = makeSession()
    const target = join(dir, 'out/report.md')
    mkdirSync(join(dir, 'out'), { recursive: true })
    let calls = 0
    let release!: (value: any) => void
    const gate = new Promise<any>((resolve) => { release = resolve })
    const controller = new AbortController()
    const ctx = makeCtx(() => {
      calls += 1
      writeFileSync(target, '# first attempt\n')
      return { childId: 'child-hang', result: gate, dispose: async () => {} }
    })
    const dispatch = dispatchPlan(ctx, record, {
      agent: { session, options: {} },
      signal: controller.signal,
      cwd: dir,
      idleTimeoutMs: 60_000,
      childTimeoutMs: 500,
      totalTimeoutMs: 800,
      strictEvidence: false,
    })
    assert.ok(await waitFor(() => calls === 1, 5_000))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const running = record.statuses.find((item: any) => item.subtaskId === 'T1')
    assert.equal(running?.status, 'in_progress')
    assert.equal(running?.artifactConflict, undefined, '不再因旧超时产生产物冲突标记')
    assert.equal(calls, 1)
    assert.equal(readFileSync(target, 'utf8'), '# first attempt\n', '执行期间产物未被改写')

    controller.abort()
    // 真实子 Agent 收 abort 后返回 cancelled；夹具需模拟宿主 result 同步收束。
    release({ stopReason: 'cancelled', output: [] })
    const result = await dispatch
    assert.ok(result)
    assert.equal(calls, 1)
    const row = record.statuses.find((item: any) => item.subtaskId === 'T1')
    assert.equal(row?.status, 'blocked', '显式取消仍按既有安全路径收束')
    assert.notEqual(record.phase, 'running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
