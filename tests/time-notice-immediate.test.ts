/*
 * [2.2.0][T2 红灯先行] 子任务级完成即时通知 —— 对应优化项 **O-1a**（双通道）。
 * 设计依据：docs/dsh-workplan_优化方案_20261107.md §1 ① 验收矩阵 A1/A2/A4（A3 由既有
 * runtime-replay.test.ts 兜住：finishRound 批量结果消息语义不变）。
 *
 * 断言点（数值抄录方案原文，不改写）：
 *  - A1：单子任务完成到主会话出现该子任务专属通知 **≤ 5 秒**（不需要等整轮结束）；
 *  - A2：同一子任务不产生重复通知（**幂等**，重启/刷新后回放一致）；
 *  - A4：子任务全部未完成时**不存在「已完成」措辞**的通知。
 *
 * 现状（v2.1.7，红灯原因）：完成结算只写状态行（settleFromOutput，
 * src/runtime.ts:1176-1281 → writeSubtaskStatus src/runtime.ts:1230-1274），
 * 唯一通知落点是轮结束的 finishRound（src/runtime.ts:4313-4330 → session.append
 * src/runtime.ts:4329）；不存在任何子任务级即时通知——三个用例全部应失败/待实现。
 *
 * 计时口径：不用真实长睡眠。完成时刻 = 释放假子会话的时刻，≤5 秒断言用 10ms
 * 轮询（waitFor，与既有测试同构）计时，全程可重复。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, messageText, parseResultMessage, parseWorkplanMessage } from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlan() {
  return {
    planId: 'wp-time-notice',
    sessionId: 'session-time-notice',
    createdTurn: 1,
    createdAt: 1000,
    title: '即时通知验收',
    taskUnderstanding: { originalRequest: '验证完成即时通知', deliverable: '通知到达' },
    contradictions: { primary: { statement: '轮级批量通知不能替代子任务级即时通知' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        {
          id: 'T1',
          title: '产出第一份交付',
          department: 'engineering',
          objective: '完成 T1',
          method: ['写'],
          inputs: [],
          outputs: ['T1_report.md'],
          acceptance: ['T1 报告存在'],
          risk: 'low',
          dependsOn: [],
        },
        {
          id: 'T2',
          title: '产出第二份交付',
          department: 'engineering',
          objective: '完成 T2',
          method: ['写'],
          inputs: [],
          outputs: ['T2_report.md'],
          acceptance: ['T2 报告存在'],
          risk: 'low',
          dependsOn: ['T1'],
        },
      ],
    }],
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-time-notice',
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

function deferred() {
  let release!: (value: any) => void
  let reject!: (reason: any) => void
  const promise = new Promise<any>((resolve, rej) => {
    release = resolve
    reject = rej
  })
  return { promise, release, reject }
}

function completed(text = '完成') {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

function failed(text = '子任务执行失败') {
  const p = Promise.reject(new Error(text))
  p.catch(() => {})
  return { childId: 'child-fail', result: p, dispose: async () => {} }
}

/** 计划消息与轮级批量结果消息都不算「即时通知」。 */
function noticeTexts(session: any): string[] {
  const out: string[] = []
  for (const event of session.events) {
    if (event.type !== 'user/message') continue
    // [2.2.1] 即时通知现在是标准 UserMessage（对象）；统一用 messageText 取正文。
    const text = messageText(event.data)
    if (!text) continue
    if (parseWorkplanMessage(event.data)) continue
    if (parseResultMessage(event.data)) continue
    out.push(text)
  }
  return out
}

function makeRuntime() {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan()))
  const gates: Array<{ promise: Promise<any>; release: (v: any) => void; reject: (e: any) => void }> = []
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        const gate = deferred()
        gates.push(gate)
        return { childId: `child-${gates.length}`, result: gate.promise, dispose: async () => {} }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    maxResumes: 4,
    strictEvidence: false,
  })
  return { session, runtime, gates }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function roundEnded(session: any) {
  return session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data))
}

test('A1：单子任务完成到主会话出现专属即时通知 ≤ 5 秒，且先于轮级批量结果消息', async () => {
  const { session, runtime, gates } = makeRuntime()
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(() => gates.length >= 1), 'T1 应已派发')
  // T2 依赖 T1 且被假子会话吊住：T1 结算时整轮必然还没结束。
  gates[0].release(completed('T1 已完成全部验收'))
  const started = Date.now()
  const found = await waitFor(() => noticeTexts(session).some((text) => /T1/.test(text)), 5_000)
  const elapsed = Date.now() - started
  assert.ok(
    found,
    '待实现（O-1a/A1）：settleFromOutput 结算成功后应立即向主会话 session.append 一条含子任务 ID/摘要/验收计数/用时的即时通知（方案 §1 ① A1：≤5 秒、不需要等整轮结束）',
  )
  assert.ok(elapsed <= 5_000, `A1：完成到通知必须 ≤5 秒（5000ms），实际 ${elapsed}ms`)
  const events = session.events.filter((event: any) => event.type === 'user/message')
  const noticeIdx = events.findIndex(
    (event: any) => !parseWorkplanMessage(event.data) && !parseResultMessage(event.data) && /T1/.test(messageText(event.data)),
  )
  const resultIdx = events.findIndex((event: any) => parseResultMessage(event.data))
  assert.ok(noticeIdx >= 0 && (resultIdx === -1 || noticeIdx < resultIdx), 'A1：专属通知必须先于轮级批量结果消息到达（不需要等整轮结束）')
  // 收尾：放行 T2，让本轮干净结束。
  assert.ok(await waitFor(() => gates.length >= 2, 10_000), 'T1 结算后 T2 应被派发')
  gates[1].release(completed('T2 已完成'))
  assert.ok(await waitFor(() => roundEnded(session), 10_000), '轮级结果消息应出现')
})

test('A2：同一子任务重复结算/回放不重报（幂等，重启/刷新后回放一致）', async () => {
  const { session, runtime, gates } = makeRuntime()
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  await waitFor(() => gates.length >= 1)
  gates[0].release(completed('T1 已完成'))
  await waitFor(() => gates.length >= 2, 10_000)
  gates[1].release(completed('T2 已完成'))
  assert.ok(await waitFor(() => roundEnded(session), 10_000), '轮级结果消息应出现（finishRound 批量补齐已跑完）')
  const t1Notices = () => noticeTexts(session).filter((text) => /T1/.test(text))
  assert.equal(
    t1Notices().length,
    1,
    '待实现（O-1a/A2）：即时通知 + finishRound 批量补齐后，同一子任务（T1）专属通知只能有 1 条（幂等：markReported 记 report.state:"sent"，补齐不得重报）',
  )
  // 模拟重启/刷新：从会话日志回放重建状态，不得追加任何消息、通知仍只有 1 条。
  const before = session.events.length
  const record: any = reconstructFromSession(session)
  assert.ok(record?.plan, '回放应重建计划')
  assert.equal(session.events.length, before, 'A2：回放是纯读，不得追加（重复）通知')
  assert.equal(t1Notices().length, 1, 'A2：重启/刷新后回放一致，T1 通知仍只有 1 条')
})

test('A4：子任务全部未完成时不存在「已完成」措辞的通知', async () => {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan()))
  const ctx = {
    logger: { warn() {} },
    // 两个子任务（含自动重试的第二次尝试）全部失败：没有任何子任务完成。
    subagents: { startActivation: async () => failed() },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    maxResumes: 4,
    strictEvidence: false,
  })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(() => roundEnded(session), 15_000), '全部失败后本轮应收束并写轮级结果消息')
  const claimed = noticeTexts(session).filter((text) => /已完成/.test(text))
  assert.deepEqual(
    claimed,
    [],
    '待实现（O-1a/A4）：子任务全部未完成时，不得出现任何「已完成」措辞的即时通知（方案 §1 ① A4）',
  )
  const completionNotices = noticeTexts(session).filter((text) => /T[12]/.test(text) && !text.includes('【dsh-workplan·执行中断】'))
  assert.deepEqual(completionNotices, [], 'A4：没有任何子任务完成，就不应有任何子任务完成通知')
  // [2.2.7] 中断即报：受阻/失败的通知必须存在且如实交代原因与处理（这正是 A4 的镜像要求：
  // 不谎报完成，但必须如实报告中断）。
  const interruptNotices = noticeTexts(session).filter((text) => text.includes('【dsh-workplan·执行中断】'))
  assert.ok(interruptNotices.length > 0, '全部失败时用户必须即时收到中断通知，不得沉默等整轮')
  assert.ok(interruptNotices.every((text) => !/已完成/.test(text)), '中断通知不得出现「已完成」措辞')
})
