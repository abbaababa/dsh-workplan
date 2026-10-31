/*
 * [1.8.5] planId 三处校验必须对称。
 *
 * 事故背景（2026-10-30，159667 计划）：某个子 Agent 在 21:34:52 已经把产物写完，
 * 21:34:54 却被外部中断，插件把这一步记成 blocked，并把它下游 6 个任务全部级联
 * 置阻。此时唯一诚实的补救是「据实改判这一步」——而 dispatch 早就支持用
 * `reconstructFromSession(session, planId)` 把旧计划重建后继续跑，update 与
 * cancel 却只做字符串比对就抛 PLAN_ID_MISMATCH。于是：能续跑的计划不能改判，
 * 需要改判的计划恰恰是卡住的那个。
 *
 * 这组用例把「三者对称」钉住：点名的旧计划可以改判、可以取消，真不存在的
 * planId 报错必须带上当前计划 id，供主 Agent 自己纠正。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { PLAN_MARKER_BEGIN, PLAN_MARKER_END, computeStats, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

function makePlan(planId: string, title: string) {
  return {
    planId,
    sessionId: 'session-lineage',
    createdTurn: 1,
    createdAt: 1000,
    title,
    stages: [
      {
        id: 'S1',
        subtasks: [
          { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
          { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
        ],
      },
    ],
  }
}

function makeRecord(plan: any): any {
  const statuses = createStatuses(plan).map((item: any, index: number) => (
    index === 0
      ? { ...item, status: 'done' }
      : { ...item, status: 'blocked', progress: 100, error: '子 Agent 在完成前被中断' }
  ))
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'blocked',
    statuses,
    stats: computeStats(statuses),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: true,
  }
}

function makeSession(id = 'session-lineage') {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000 },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt(seq: number) {
      return events[seq]
    },
    events,
  }
}

function makeCtx(session: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: () => { throw new Error('这些用例不应派发子 Agent') } },
    sessions: {
      get: (id: any) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: () => undefined,
    },
  }
}

/** 会话日志里的一条计划消息；reconstructFromSession 就是从它重建快照的。 */
function planMessage(plan: any) {
  const payload = {
    kind: 'workplan',
    version: 1,
    planId: plan.planId,
    sessionId: plan.sessionId,
    createdTurn: plan.createdTurn,
    createdAt: plan.createdAt,
    plan,
  }
  const text = `${PLAN_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${PLAN_MARKER_END}`
  return { content: [{ type: 'text', text }] }
}

/** 旧计划在日志里、新计划在内存里——正是「报告已出、旧计划卡住」的真实形态。 */
function lineage() {
  const oldPlan = makePlan('wp-old', '旧计划：159667 预判')
  const newPlan = makePlan('wp-new', '新计划：诊断')
  const session = makeSession()
  session.append('user/message', planMessage(oldPlan))
  session.append('user/message', planMessage(newPlan))
  const runtime: any = createWorkplanRuntime(makeCtx(session), { totalTimeoutMs: 60000 })
  runtime.state.records.set(session.id, makeRecord(newPlan))
  const agent = { session, options: {} }
  return { session, runtime, agent, oldPlan, newPlan }
}

test('update 指定日志里的旧计划：重建并改判，不再 PLAN_ID_MISMATCH', async () => {
  const { session, runtime, agent } = lineage()

  await runtime.updateStatus(agent, { planId: 'wp-old', subtaskId: 'T2', status: 'done', note: '产物已在盘上' })

  const hosted = runtime.plansPayload(session.id).sessions[0]
  assert.equal(hosted.planId, 'wp-old', '改判必须落在被点名的旧计划上，而不是当前记录')
  /*
   * 旧计划在日志里没有结果消息，重建出来是「两项都还没做」；这次只改判 T2。
   * 断言的是「写入落到了重建后的记录上」，而不是「计划被补完了」——两者混为一谈
   * 正是当初让主 Agent 误以为整份计划都已完成的读法。
   */
  const t1 = hosted.statuses.find((item: any) => item.subtaskId === 'T1')
  const t2 = hosted.statuses.find((item: any) => item.subtaskId === 'T2')
  assert.equal(t1.status, 'pending')
  assert.equal(t2.status, 'done')
  assert.equal(hosted.stats.done, 1)
})

test('cancel 指定日志里的旧计划：取消生效，且只取消那一个计划', async () => {
  const { session, runtime, agent } = lineage()

  const result = await runtime.cancelPlan(agent, { planId: 'wp-old', reason: '产物已落盘，计划作废' })

  assert.equal(result.planId, 'wp-old')
  const hosted = runtime.plansPayload(session.id).sessions[0]
  assert.equal(hosted.planId, 'wp-old')
  assert.equal(hosted.phase, 'cancelled')
})

test('点名一个根本不存在的 planId：报错必须带上当前计划 id', async () => {
  const { runtime, agent } = lineage()

  await assert.rejects(
    () => runtime.updateStatus(agent, { planId: 'wp-typo', subtaskId: 'T1', status: 'done' }),
    (error: any) => {
      assert.equal(error.code, 'PLAN_ID_MISMATCH')
      assert.match(error.message, /wp-new/, '错误必须告诉调用方当前计划是谁')
      assert.match(error.message, /wp-typo/, '错误必须回显被点名的错误 id')
      return true
    },
  )
})
