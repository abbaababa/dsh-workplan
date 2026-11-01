/*
 * [1.9.1] 用户授权的 follow-up 通道。
 *
 * 背景：三条子会话在事故夜被整轮预算（TOTAL_TIMEOUT）与 900s 子任务上限
 * 中止，末轮 `turn/end = aborted/parent`，界面因此永远显示 idle；台账侧
 * 它们是 done/structured。用户 2026-11-01 明确同意“补发 follow-up，让圈注
 * 三行真正变绿”。
 *
 * 本文件钉住四件事：
 *  1. 只允许根会话投递，且目标必须是父会话 catalog 里登记过的直接子会话；
 *  2. 投递本身不改计划状态、不写父会话事件——它只是把说明送进子会话；
 *  3. 子会话服务缺失或投递失败时返回 ok:false，不静默成功；
 *  4. message 为空/过长时明确拒绝，避免把空指令当成 follow-up。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorkplanRuntime } from '../src/runtime.js'

function makeSession(events: any[] = []) {
  return {
    id: 'session-followup',
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

function withChild(session: any, childId: string) {
  session.append('subagent/catalog', {
    childId,
    label: 'qa:T10 覆盖率与残项校验',
    mode: 'continuable',
    createdAt: 2000,
  })
  return session
}

function makeRuntime(subagents: any, session: any) {
  const ctx = {
    logger: { warn() {} },
    subagents,
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  return createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000 })
}

test('follow-up 只投递给父会话 catalog 登记过的直接子会话', async () => {
  const childId = 'a0d5b134-3d41-4f60-ba93-26c4b652dd7b'
  const calls: any[] = []
  const session = withChild(makeSession(), childId)
  const runtime: any = makeRuntime({
    startActivation: async () => { throw new Error('this test never dispatches') },
    sendMessage: async (...args: any[]) => {
      calls.push(args)
      return 'msg-1'
    },
  }, session)
  const agent = { id: session.id, session }

  const result = await runtime.followupTool(agent, {
    sessionId: childId,
    message: '请确认已有产物后正常结束回合，不要整步重跑。',
  }, new AbortController().signal)

  assert.equal(result.ok, true)
  assert.equal(result.sessionId, childId)
  assert.equal(result.messageId, 'msg-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], agent)
  assert.equal(calls[0][1], childId)
  assert.equal(calls[0][2][0].type, 'text')
  assert.match(calls[0][2][0].text, /正常结束回合/)
  /*
   * 投递不是状态写回：父会话事件只多出那一条 catalog，没有新计划/结果事件。
   */
  assert.deepEqual(session.events.map((event: any) => event.type), ['subagent/catalog'])
})

test('未知子会话、空 message、子 Agent 会话一律拒绝', async () => {
  const calls: any[] = []
  const session = withChild(makeSession(), 'child-known')
  const runtime: any = makeRuntime({
    startActivation: async () => undefined,
    sendMessage: async (...args: any[]) => {
      calls.push(args)
      return 'msg-x'
    },
  }, session)
  const signal = new AbortController().signal

  const unknown = await runtime.followupTool({ id: session.id, session }, {
    sessionId: 'child-not-in-catalog',
    message: 'hi',
  }, signal)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'NOT_DIRECT_CHILD')

  const empty = await runtime.followupTool({ id: session.id, session }, {
    sessionId: 'child-known',
    message: '   ',
  }, signal)
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'INVALID_MESSAGE')

  const missing = await runtime.followupTool({ id: session.id, session }, {
    sessionId: 'child-known',
    message: 'x'.repeat(4001),
  }, signal)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'MESSAGE_TOO_LONG')

  const childAgent = {
    id: 'child-known',
    session: { id: 'child-known', header: { parentSession: session.id }, seq: 0 },
  }
  const notRoot = await runtime.followupTool(childAgent, {
    sessionId: 'child-known',
    message: 'hi',
  }, signal)
  assert.equal(notRoot.ok, false)
  assert.equal(notRoot.code, 'NOT_ROOT')
  assert.equal(calls.length, 0)
})

test('子会话服务缺失或投递失败时如实返回错误', async () => {
  const childId = 'child-1'
  const signal = new AbortController().signal

  const noServiceSession = withChild(makeSession(), childId)
  const noService: any = makeRuntime({ startActivation: async () => undefined }, noServiceSession)
  const noServiceResult = await noService.followupTool({
    id: 'session-followup',
    session: noServiceSession,
  }, { sessionId: childId, message: 'hi' }, signal)
  assert.equal(noServiceResult.ok, false)
  assert.equal(noServiceResult.code, 'NO_SUBAGENT_SERVICE')

  const failingSession = withChild(makeSession(), childId)
  const failing: any = makeRuntime({
    startActivation: async () => undefined,
    sendMessage: async () => { throw new Error('child is disposing') },
  }, failingSession)
  const failed = await failing.followupTool({ id: 'session-followup', session: failingSession }, {
    sessionId: childId,
    message: 'hi',
  }, signal)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'DELIVERY_FAILED')
  assert.match(failed.error, /child is disposing/)
})
