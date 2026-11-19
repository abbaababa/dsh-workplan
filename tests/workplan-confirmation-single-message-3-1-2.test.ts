/*
 * [3.1.2] 「用户认可后插件不再运行」死锁修复 · 回归测试。
 *
 * 背景事故（2026-11-19 本会话 wp 实证）：用户对任务回复「认可」，插件毫无
 * 反应、任务分解反复重启。源码级根因：
 *   - onInboxInserted 用【单条消息】做分类判断（正确识别「认可」）；
 *   - onPreStep 的确认路由与取代逻辑用【全量用户消息拼接文本】做判断
 *     （「认可」被原始任务文本淹没，分类器集体失效）——两种口径自相矛盾。
 * 后果：确认消息落到「真实任务」路径，取代（杀死）在途后台分解；认可闸门
 * 等不到确认信号，计划永远派发不出去（死锁）。
 *
 * 修复（src/runtime.ts [3.1.2]）：
 *   ① 收件箱侧认出确认即当场标记 planning.userConfirmed = true（盖章）；
 *   ② 确认路由触发条件改用最新一条人类消息（lastHumanText）；
 *   ③ 取代逻辑增加单条豁免：寒暄/空泛续跑/状态提问/确认回复不得取代
 *      在途后台规划。
 *
 * 本文件锁定修复后的端到端行为；「带条件的回复是新需求必须取代」反向
 * 用例一并钉住，防修复扩大成「确认分类吞掉新任务」（3.0.7 头注释红线）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkplanRuntime } from '../src/runtime.js'

const WORKSPACE = '/work'
const SESSION_ID = 'session-3-1-2-confirmation'
const TASK_TEXT = '总任务：预判159667工业母机ETF国泰明天至月底走势，经用户认可后再开始执行'
const FOLLOWUP_TEXT = 'HTML报告还必须非常方便用户阅读  并全部按你的建议执行'

function userMsg(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function makeSession() {
  const events: any[] = []
  return {
    id: SESSION_ID,
    header: { createdAt: 1000, cwd: WORKSPACE },
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

function makeRuntime() {
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, cwd: WORKSPACE })
  // planningInFlight 为惰性创建（生产代码全程可选链访问），测试直接预置。
  if (!runtime.state.planningInFlight) runtime.state.planningInFlight = new Map()
  return runtime
}

function planningEntry(overrides: any = {}) {
  const entry: any = {
    taskText: `${TASK_TEXT}\n\n${FOLLOWUP_TEXT}`,
    superseded: false,
    userConfirmed: false,
    aborted: false,
    controller: {
      abort() {
        entry.aborted = true
      },
    },
  }
  return Object.assign(entry, overrides)
}

async function preStep(runtime: any, session: any, messages: any[], turn = 3) {
  return runtime.onPreStep(
    { agent: { session }, step: 1, turn, messages },
    async () => ({ kind: 'enter' }),
  )
}

test('3.1.2 用例1：收件箱收到「认可」→ 当场盖章 userConfirmed、不取代、回复用户', () => {
  const session = makeSession()
  const runtime = makeRuntime()
  const planning = planningEntry()
  runtime.state.planningInFlight.set(session.id, planning)

  runtime.onInboxInserted({ agent: { session }, message: userMsg('认可') })

  assert.equal(planning.userConfirmed, true, '确认必须在收件箱侧当场盖章')
  assert.notEqual(planning.superseded, true, '确认不得取代在途后台规划')
  assert.equal(planning.aborted, false, '确认的 abort 绝不得被触发')
})

test('3.1.2 用例2：pre-step 历史=[任务,补充,「认可」] → 确认路由放行，不取代在途规划', async () => {
  const session = makeSession()
  const runtime = makeRuntime()
  const planning = planningEntry()
  runtime.state.planningInFlight.set(session.id, planning)

  await preStep(runtime, session, [userMsg(TASK_TEXT), userMsg(FOLLOWUP_TEXT), userMsg('认可')])

  assert.notEqual(planning.superseded, true, '死锁现场：认可曾在此杀死在途规划')
  assert.equal(planning.aborted, false)
})

test('3.1.2 用例3：pre-step 跟进消息（继续/谢谢/进度如何）单条豁免，不取代在途规划', async () => {
  for (const follow of ['继续', '谢谢', '进度如何？']) {
    const session = makeSession()
    const runtime = makeRuntime()
    const planning = planningEntry()
    runtime.state.planningInFlight.set(session.id, planning)

    await preStep(runtime, session, [userMsg(TASK_TEXT), userMsg(FOLLOWUP_TEXT), userMsg(follow)])

    assert.notEqual(planning.superseded, true, `「${follow}」不得取代在途后台规划`)
    assert.equal(planning.aborted, false, `「${follow}」不得触发 abort`)
  }
})

test('3.1.2 用例4（对照）：真正的新任务必须正常取代在途规划', async () => {
  const session = makeSession()
  const runtime = makeRuntime()
  const planning = planningEntry()
  runtime.state.planningInFlight.set(session.id, planning)

  await preStep(runtime, session, [userMsg(TASK_TEXT), userMsg('重新生成计划并执行')])

  assert.equal(planning.superseded, true, '新任务必须取代旧规划（修复不得扩大）')
  assert.equal(planning.aborted, true)
})

test('3.1.2 用例5（对照）：带条件的回复是新需求，不得误判为确认，必须取代', async () => {
  const session = makeSession()
  const runtime = makeRuntime()
  const planning = planningEntry()
  runtime.state.planningInFlight.set(session.id, planning)

  await preStep(runtime, session, [userMsg(TASK_TEXT), userMsg('可以，但要把范围改成只修runtime.ts')])

  assert.equal(planning.superseded, true, '含实质变更条件的回复必须走新任务路径')
})
