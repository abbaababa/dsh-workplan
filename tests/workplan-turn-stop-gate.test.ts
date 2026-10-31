/*
 * [1.8.7] 「未完成即输出」的回归防线。
 *
 * 事故 session-99984ebd-7d13-47d5-87a0-e9ba7271b883（2026-10-31）：
 *  - 计划 wp-66f57fa3 只完成 10/13，`dsh_workplan_dispatch({mode:"wait"})`
 *    返回「本轮预算用尽，可续跑（完成 10/13）｜已加入进行中的派发并等到结果」；
 *  - 同一秒注入的「部门执行结果」第 3 条写着「给出最终答复」，第 4 条又写
 *    「再次调用 dsh_workplan_dispatch」，两条命令互相抵触；
 *  - 模型照第 3 条执行：12:04:22 present 报告、12:04:25 turn/end completed；
 *    12:13 第二个回合又把进度写成「11/13，可续跑，不是失败」，随后会话永久
 *    停在 11/13，T12/T13 再没跑过。
 *
 * 修复分四层，本文件逐层钉住：
 *  1. 摘要与结果消息：未完成时第一句就是「未完成」，且只有未完成才出现
 *     「禁止交付」，完成时才允许「给出最终答复」；
 *  2. `buildStopSteerText`：回合收尾前注入的强制续跑指令；
 *  3. `agent/turn-stopping` 闸门：未完成 ⇒ steer；完成/已取消/非本回合任务
 *     ⇒ 放行；后台派发仍在跑 ⇒ 先等结果再判断；
 *  4. 每次 steer 有上限，不会把会话锁死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildResultMessage,
  buildResultSummary,
  buildStopSteerText,
  createStatuses,
  derivePlanSnapshot,
} from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

function makePlan(planId = 'wp-stop-gate') {
  return {
    planId,
    sessionId: 'session-stop-gate',
    createdTurn: 1,
    createdAt: 1000,
    title: '未完成禁止交付回归',
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
        { id: 'T3', title: '第三步', department: 'engineering', dependsOn: ['T2'] },
      ],
    }],
  }
}

function makeRecord(plan: any): any {
  const statuses: any[] = createStatuses(plan)
  statuses[0].status = 'done'
  /*
   * [1.8.13] A done row must carry structured evidence, otherwise the plan is
   * not deliverable and the gate is expected to object. Tests that want the
   * "complete and deliverable" state use `markDelivered` below.
   */
  statuses[0].verification = 'structured'
  statuses[0].acceptance = [{ criterion: '第一步验收', result: 'pass', evidence: '测试通过' }]
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'paused',
    statuses,
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: true,
  }
}

function markDelivered(record: any) {
  for (const item of record.statuses) {
    item.status = 'done'
    item.progress = 100
    item.verification = 'structured'
    item.acceptance = [{ criterion: `${item.subtaskId} 验收`, result: 'pass', evidence: 'npm test 通过' }]
    item.missingArtifacts = []
  }
  record.phase = 'done'
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-stop-gate',
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

function makeRuntime(record: any, session: any, childSessions: Record<string, any> = {}) {
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: { get: (id: string) => childSessions[id], list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000 })
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

function steerableAgent(session: any) {
  const steered: any[] = []
  return {
    steered,
    agent: {
      session,
      steer(message: any) {
        steered.push(message)
      },
    },
  }
}

function textOf(message: any) {
  const block = Array.isArray(message?.content) ? message.content[0] : undefined
  return String(block?.text ?? '')
}

test('结果摘要未完成时先写「未完成」，不再说「请核对并整合」', () => {
  const paused = buildResultSummary({ stats: { done: 10, total: 13, blocked: 0 }, phase: 'paused' })
  assert.match(paused, /【部门执行结果】未完成/)
  assert.match(paused, /10\/13/)
  assert.match(paused, /剩余 3 项/)
  assert.doesNotMatch(paused, /请主 Agent 核对并整合/)

  const complete = buildResultSummary({ stats: { done: 3, total: 3, blocked: 0 }, phase: 'done' })
  assert.match(complete, /【部门执行结果】完成 3\/3/)
  assert.doesNotMatch(complete, /未完成/)
})

test('未完成的结果消息只命令续跑，完成的结果消息才命令收尾', () => {
  const inbox = makeRecord(makePlan())
  const incomplete = textOf(buildResultMessage({
    planId: 'wp-stop-gate',
    sessionId: 'session-stop-gate',
    statuses: inbox.statuses,
    stats: derivePlanSnapshot(inbox.statuses).stats,
    phase: 'paused',
    errors: [],
  }))
  assert.match(incomplete, /【未完成，禁止交付】/)
  assert.match(incomplete, /不要调用 present/)
  assert.match(incomplete, /再次调用 dsh_workplan_dispatch/)
  assert.doesNotMatch(incomplete, /3\. 给出最终答复/)

  markDelivered(inbox)
  const finished = textOf(buildResultMessage({
    planId: 'wp-stop-gate',
    sessionId: 'session-stop-gate',
    statuses: inbox.statuses,
    stats: derivePlanSnapshot(inbox.statuses).stats,
    phase: 'done',
    errors: [],
  }))
  assert.match(finished, /3\. 给出最终答复/)
  assert.doesNotMatch(finished, /【未完成，禁止交付】/)

  /*
   * [1.8.13] T5-B/D: all rows done but no structured evidence used to produce
   * the same "give the final answer" instruction. It must now forbid delivery
   * and offer the repair path instead.
   */
  const bare = makeRecord(makePlan('wp-result-bare'))
  for (const item of bare.statuses) item.status = 'done'
  const evidenceBlocked = textOf(buildResultMessage({
    planId: 'wp-result-bare',
    sessionId: 'session-stop-gate',
    statuses: bare.statuses,
    stats: derivePlanSnapshot(bare.statuses).stats,
    phase: 'done',
    errors: [],
  }))
  assert.match(evidenceBlocked, /【证据未通过，禁止交付】/)
  assert.match(evidenceBlocked, /dsh_workplan_update/)
  assert.doesNotMatch(evidenceBlocked, /3\. 给出最终答复/)
})

test('收尾指令写清剩余量、禁止交付与唯一恢复动作', () => {
  const record = makeRecord(makePlan())
  const statuses = record.statuses
  const text = buildStopSteerText({
    planId: 'wp-stop-gate',
    stats: derivePlanSnapshot(statuses).stats,
    statuses,
    attempt: 2,
  })
  assert.match(text, /【计划未完成 · 禁止收尾】/)
  assert.match(text, /1\/3/)
  assert.match(text, /T2、T3/)
  assert.match(text, /不要调用 present/)
  assert.match(text, /第 2 次提醒/)
  assert.doesNotMatch(text, /计划已完成|已经完成/)
})

test('未完成且是本回合的任务：收尾被 steer 拦住，且每回合最多 2 次', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session)
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 1, '第一次收尾必须被拦下')
  assert.match(textOf(steered[0]), /计划未通过交付就绪检查，这个回合暂不关闭/)
  assert.equal(record.stopSteers.turn, 1)
  assert.equal(record.stopSteers.count, 1)

  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 2, '同一回合允许第二次提醒（覆盖两轮预算）')

  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 2, '到达上限后不再 steer，避免死循环')
})

test('完成且证据通过才放行；已取消/证据缺口会被拦住；非本回合任务放行', async () => {
  // 全部完成且证据通过
  {
    const session = makeSession()
    const record = makeRecord(makePlan('wp-complete'))
    markDelivered(record)
    const runtime = makeRuntime(record, session)
    const { agent, steered } = steerableAgent(session)
    await runtime.onTurnStopping({ agent, turn: 1 })
    assert.equal(steered.length, 0, '完成且证据通过的计划不得被拦')
  }
  // 已取消但未完成（T5-C）：取消不等于完成，不再直接放行
  {
    const session = makeSession()
    const record = makeRecord(makePlan('wp-cancelled'))
    record.phase = 'cancelled'
    const runtime = makeRuntime(record, session)
    const { agent, steered } = steerableAgent(session)
    await runtime.onTurnStopping({ agent, turn: 1 })
    assert.equal(steered.length, 1, '取消只停止执行，未完成项仍不得被当成完成')
    assert.match(textOf(steered[0]), /计划已取消但未完成/)
    assert.match(textOf(steered[0]), /不要调用 present/)
    assert.doesNotMatch(textOf(steered[0]), /1\. 调用 dsh_workplan_dispatch/)
  }
  // 全部 done 但证据缺口（T5-B/D）：也要拦，不能让回合安静收尾
  {
    const session = makeSession()
    const record = makeRecord(makePlan('wp-bare-done'))
    for (const item of record.statuses) item.status = 'done'
    record.phase = 'done'
    const runtime = makeRuntime(record, session)
    const { agent, steered } = steerableAgent(session)
    await runtime.onTurnStopping({ agent, turn: 1 })
    assert.equal(steered.length, 1, '全 done 但没有结构化证据，不得按完成收尾')
    assert.match(textOf(steered[0]), /证据未通过/)
  }
  // 不是本回合产生的任务（例如进度询问的回合）
  {
    const session = makeSession()
    const record = makeRecord(makePlan('wp-other-turn'))
    const runtime = makeRuntime(record, session)
    runtime.state.activeTurns.set(session.id, 7)
    const { agent, steered } = steerableAgent(session)
    await runtime.onTurnStopping({ agent, turn: 1 })
    assert.equal(steered.length, 0, '非任务回合不得被强制续跑')
  }
})

test('后台派发仍在跑时先等结果，再决定是否拦', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-joined'))
  let release!: () => void
  record.dispatchPromise = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = makeRuntime(record, session)
  const { agent, steered } = steerableAgent(session)

  const stopping = runtime.onTurnStopping({ agent, turn: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(steered.length, 0, '派发还没结束就不能判定完成度')

  release()
  await stopping
  assert.equal(steered.length, 1, '等到的结果仍未完成，必须拦住收尾')
})

/*
 * [1.8.8] 事故 turn 2 的绕过路径：它由 `subagent-settled` 消息唤醒，
 * 不是 human task，`maybePlan` 不写 activeTurns；旧闸门在第一行就放行，
 * 模型因此还能在 11/13 时收尾。以下用例按真实事件形状复现。
 */
function settlementMessage(childId: string, kind = 'subagent-settled') {
  return {
    id: 'msg-settled',
    role: 'user',
    content: [{ type: 'text', text: 'Background subagent finished and will do no further work unless you send it more.' }],
    source: { kind, senderSessionId: childId },
  }
}

function planWithChild(record: any, index: number, childId: string) {
  record.statuses[index].childId = childId
  return record
}

test('结算唤醒的回合：没有 human task 也必须被收尾闸门拦住', async () => {
  const session = makeSession()
  const record = planWithChild(makeRecord(makePlan('wp-settled')), 1, 'child-T2')
  session.append('turn/start', { turn: 2 })
  session.append('user/message', settlementMessage('child-T2'))
  const runtime = makeRuntime(record, session)
  runtime.state.activeTurns.set(session.id, 1) // 只有 turn 1 是 human task
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 2 })
  assert.equal(steered.length, 1, '结算回合同样装载了本计划的续跑输入，必须续跑')
  assert.equal(record.stopSteers.turn, 2)
})

test('无关子 Agent 的结算不得把闸门误激活', async () => {
  const session = makeSession()
  const record = planWithChild(makeRecord(makePlan('wp-unrelated')), 1, 'child-T2')
  session.append('turn/start', { turn: 2 })
  session.append('user/message', settlementMessage('child-someone-else'))
  const runtime = makeRuntime(record, session)
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 2 })
  assert.equal(steered.length, 0, '无关后台任务的结算不能触发计划续跑')

  // 对照：真实的人类追问回合也不该被这套 fallback 拦住（仍由 activeTurns 决定）。
  const human = makeSession()
  const humanRecord = makeRecord(makePlan('wp-human'))
  human.append('turn/start', { turn: 2 })
  human.append('user/message', {
    id: 'msg-human',
    role: 'user',
    content: [{ type: 'text', text: '进度如何？' }],
    source: { kind: 'user' },
  })
  const humanRuntime = makeRuntime(humanRecord, human)
  const humanAgent = steerableAgent(human)
  await humanRuntime.onTurnStopping({ agent: humanAgent.agent, turn: 2 })
  assert.equal(humanAgent.steered.length, 0, '非任务回合（如进度询问）不得被强制续跑')
})

test('预算重置清空 childId 后，结算回合仍按会话谱系被拦住', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-lineage'))
  // 预算暂停会把未完成项重置为 pending，normaliseStatusEntry 同时清空 childId；
  // 事故里的 T11 正是这样从 planChildIds 里消失，turn 2 才绕过了 1.8.8。
  record.statuses[1].status = 'pending'
  record.statuses[1].childId = null
  record.phase = 'paused'
  session.append('turn/start', { turn: 2 })
  session.append('user/message', settlementMessage('child-cleared'))
  const runtime = makeRuntime(record, session, { 'child-cleared': { header: { parentSession: session.id } } })
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 2 })
  assert.equal(steered.length, 1, 'childId 被清空不等于结算与计划无关：谱系仍然成立')
  assert.equal(record.stopSteers.turn, 2)
})

test('子会话已 dispose 时，父会话的 spawn 记录（subagent/catalog）仍能认亲', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-catalog'))
  record.statuses[1].status = 'pending'
  record.statuses[1].childId = null
  record.phase = 'paused'
  session.append('turn/start', { turn: 2 })
  /*
   * 真实生命周期里 `subagent-settled` 到达前子会话已经被 dispose，ctx.sessions
   * 取不到 header；只有父会话自己追加的 subagent/catalog 还留着 childId。
   */
  session.append('subagent/catalog', { childId: 'child-disposed', mode: 'continuable', label: 'engineering:T9' })
  session.append('user/message', settlementMessage('child-disposed'))
  const runtime = makeRuntime(record, session, {})
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 2 })
  assert.equal(steered.length, 1, 'spawn 记录是 dispose 之后唯一可靠的父链证据')
})

test('计划、谱系、spawn 记录三处都没有的结算，不得激活闸门', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-stranger'))
  record.statuses[1].status = 'pending'
  record.phase = 'paused'
  session.append('turn/start', { turn: 2 })
  session.append('subagent/catalog', { childId: 'child-known', label: 'engineering:T1' })
  session.append('user/message', settlementMessage('child-stranger'))
  const runtime = makeRuntime(record, session, {})
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 2 })
  assert.equal(steered.length, 0, '无关后台任务的结算不能把未完成计划强行续跑')
})

test('present：未完成/全 done 无证据/已取消都拒绝，证据补齐后才放行', () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-present'))
  const runtime: any = makeRuntime(record, session)

  const denied = runtime.presentDenialReason({ session })
  assert.match(denied, /未完成/)
  assert.match(denied, /禁止调用 present|不得调用 present/)
  assert.match(denied, /1\/3/)
  assert.match(denied, /T2/)

  for (const item of record.statuses) item.status = 'done'
  record.phase = 'done'
  const withoutEvidence = runtime.presentDenialReason({ session })
  assert.match(withoutEvidence, /证据未通过/, '状态全 done 不等于可交付')
  assert.match(withoutEvidence, /dsh_workplan_update/)

  markDelivered(record)
  assert.equal(runtime.presentDenialReason({ session }), undefined, '证据补齐后才允许交付')

  const cancelledSession = makeSession()
  const cancelled = makeRecord(makePlan('wp-present-cancelled'))
  cancelled.phase = 'cancelled'
  const cancelledRuntime: any = makeRuntime(cancelled, cancelledSession)
  const cancelledDenial = cancelledRuntime.presentDenialReason({ session: cancelledSession })
  assert.match(cancelledDenial, /已取消/, '取消 1/3 不得放行（T5-C）')
  assert.match(cancelledDenial, /不得调用 present/)

  const childSession = { ...makeSession(), header: { origin: 'subagent' } }
  const childRuntime: any = makeRuntime(makeRecord(makePlan('wp-present-child')), childSession)
  assert.equal(childRuntime.presentDenialReason({ session: childSession }), undefined, '子 Agent 的 present 不受父计划约束')
})

test('全部 done 但证据有硬缺口时，present 仍被拒绝', () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-present-evidence'))
  for (const item of record.statuses) item.status = 'done'
  record.phase = 'done'
  record.statuses[0].verification = 'failed'
  record.statuses[1].acceptance = [{ criterion: '逐条核对', result: 'fail', evidence: '' }]
  record.statuses[2].missingArtifacts = ['reports/missing.md']
  const runtime: any = makeRuntime(record, session)

  const denied = runtime.presentDenialReason({ session })
  assert.match(denied, /自检失败/)
  assert.match(denied, /验收未通过/)
  assert.match(denied, /缺少声明产物/)
  assert.match(denied, /dsh_workplan_update/)

  /*
   * [1.8.13] Clearing the hard gaps made the old gate pass; a legacy row with no
   * structured evidence is still not deliverable. Only real evidence flips it.
   */
  record.statuses[0].verification = undefined
  record.statuses[1].acceptance = undefined
  record.statuses[2].missingArtifacts = undefined
  assert.match(runtime.presentDenialReason({ session }), /证据未通过/, 'legacy/无证据不得放行')
  markDelivered(record)
  assert.equal(runtime.presentDenialReason({ session }), undefined)
})

test('剩余项全部 blocked：不再空转 steer，但 present 仍被拒绝', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan('wp-all-blocked'))
  record.statuses[1].status = 'blocked'
  record.statuses[2].status = 'blocked'
  record.phase = 'blocked'
  const runtime: any = makeRuntime(record, session)
  const { agent, steered } = steerableAgent(session)

  await runtime.onTurnStopping({ agent, turn: 1 })
  assert.equal(steered.length, 1, '没有可运行项时仍要阻止“已完成”的收尾')
  assert.match(textOf(steered[0]), /剩余项全部受阻/)
  assert.doesNotMatch(textOf(steered[0]), /1\. 调用 dsh_workplan_dispatch/)

  const denied = runtime.presentDenialReason({ session })
  assert.match(denied, /未完成/, '未完成的产物仍不得 present')
})

