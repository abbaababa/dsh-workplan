/*
 * [3.0.0+] 派发质量闸（2026-11-15 用户裁决）聚焦测试。
 *
 * 用户裁决的三条口径：
 *  Q1 只拒发缺失质量要求的子任务：缺 qualityRequirements 的子任务不启动
 *     部门 Agent（spawned 数为证），其余合格子任务照常执行完成；
 *  Q2 旧计划豁免：createdAt 早于 QUALITY_GATE_ACTIVATED_AT 的计划缺失也放行；
 *  Q3 全部缺失时一个部门 Agent 都不启动、不会死循环，且会话内收到
 *     【派发拒发】通知并附 replan 指引；被拒行落 blocked+escalated。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, parseResultMessage } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { QUALITY_GATE_ACTIVATED_AT } from '../src/v3-contract.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlan(createdAt: number, subtasks: any[]) {
  return {
    planId: `wp-qg-${createdAt}`,
    sessionId: 'session-qg',
    createdTurn: 1,
    createdAt,
    title: '派发质量闸',
    taskUnderstanding: { originalRequest: '证明派发质量闸生效', deliverable: '聚焦测试' },
    contradictions: { primary: { statement: '质量与时间' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks }],
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-qg',
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeSubagents(spawned: any[]) {
  return {
    startActivation: async (request: any) => {
      const childId = `member-${spawned.length + 1}`
      let resolveResult: any
      const result = new Promise((resolve) => { resolveResult = resolve })
      spawned.push({ childId, request, resolveResult })
      return { childId, result, dispose: async () => {} }
    },
  }
}

function completed(text = '完成') {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

const OK_SUBTASK = {
  id: 'T1', title: '合格任务', department: 'engineering', dependsOn: [],
  objective: '做一件事', method: ['步骤一'], inputs: [], outputs: ['产物'],
  acceptance: ['可验收'], risk: '无',
  qualityRequirements: ['产物必须是可执行命令并附真实输出'],
}

const BAD_SUBTASK = {
  id: 'T2', title: '缺质量要求任务', department: 'engineering', dependsOn: [],
  objective: '做另一件事', method: ['步骤一'], inputs: [], outputs: ['产物'],
  acceptance: ['可验收'], risk: '无',
}

function boot(createdAt: number, subtasks: any[]) {
  const plan = makePlan(createdAt, subtasks)
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  seedLeaderSelfEffort(session, plan)
  const spawned: any[] = []
  const ctx = {
    logger: { warn() {} },
    subagents: makeSubagents(spawned),
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx as any, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    maxResumes: 4,
    strictEvidence: false,
  } as any)
  return { plan, session, spawned, runtime }
}

const noticeText = (session: any) => session.events
  .filter((event: any) => event.type === 'user/message')
  .map((event: any) => JSON.stringify(event.data))
  .join('\n')

test('Q1 新计划：缺质量要求的子任务被拒发，合格子任务照常执行完成', async () => {
  const { session, spawned, runtime } = boot(QUALITY_GATE_ACTIVATED_AT + 1000, [OK_SUBTASK, { ...BAD_SUBTASK }])
  const out: any = await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, true)

  // 只启动合格子任务 T1；T2 被质量闸拒发。
  assert.ok(await waitFor(() => spawned.length === 1), '只有合格子任务启动部门 Agent')

  spawned[0].resolveResult(completed('完成'))
  assert.ok(await waitFor(() => session.events.some(
    (event: any) => event.type === 'user/message' && parseResultMessage(event.data),
  )), '轮结束时必须写入 durable 结果消息')

  const settled: any = await runtime.statusTool({ session }, {})
  assert.equal(settled.stats.done, 1)
  const record: any = runtime.state.records.get('session-qg')
  const rowT2 = record.statuses.find((item: any) => item.subtaskId === 'T2')
  assert.ok(rowT2, 'T2 状态行必须存在')
  assert.equal(rowT2.status, 'blocked')
  assert.equal(rowT2.closure, 'escalated')
  assert.match(String(rowT2.error ?? ''), /质量要求/)
  // 会话内出现【派发拒发】通知且附 replan 指引。
  const notices = noticeText(session)
  assert.match(notices, /派发拒发/)
  assert.match(notices, /DISPATCH_QUALITY_REQUIREMENTS_MISSING/)
  assert.match(notices, /replan/)
})

test('Q2 旧计划：缺失质量要求也放行（零回归）', async () => {
  const { session, spawned, runtime } = boot(1000, [OK_SUBTASK, { ...BAD_SUBTASK, id: 'T2', title: '旧计划缺质量要求' }])
  const out: any = await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, true)
  // 两个子任务都启动（旧计划豁免）。
  assert.ok(await waitFor(() => spawned.length === 2), '旧计划两个子任务都应启动')
  spawned.forEach((child: any) => child.resolveResult(completed('完成')))
  assert.ok(await waitFor(() => session.events.some(
    (event: any) => event.type === 'user/message' && parseResultMessage(event.data),
  )))
  assert.equal(noticeText(session).includes('派发拒发'), false, '旧计划不应触发拒发通知')
})

test('Q3 全部缺失时：一个部门 Agent 都不启动，且不会死循环', async () => {
  const { session, spawned, runtime } = boot(QUALITY_GATE_ACTIVATED_AT + 1000, [{ ...BAD_SUBTASK }])
  const out: any = await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, true)
  // 给调度循环一点时间执行拒发分支。
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(spawned.length, 0)
  assert.match(noticeText(session), /派发拒发/)
  // 再次派发不会死循环/重复刷屏：行已是 blocked+escalated，不再是 ready。
  const again: any = await runtime.statusTool({ session }, {})
  assert.equal(again.running, false)
})
