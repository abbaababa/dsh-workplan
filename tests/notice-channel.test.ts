/*
 * [2.2.0][T3/O-2a] 子→主「开工预告」通道回归测试。
 *
 * 真实事故（2026-11-08，目标会话 seq=2006 与 T2 根因报告）：
 *   插件用 `delivery: 'caller'` 派发，宿主只在非 caller 投递时才把父会话 id
 *   追加进子提示词；插件却让子 Agent 向 `target: "lead"` 发消息——`"lead"` 不是
 *   参数名、也不是任何会话 id，真实派发必然得到
 *   `subagent "lead" is unavailable`，预告静默丢失。
 *
 * 本文件把修复钉在三个可复核的边界上：
 *   1. 提示词：必须注入真实父会话 id + 宿主契约字段 `agent_id`；不得再出现
 *      `target: "lead"`；拿不到 id 时必须「禁止猜测」并留确定性失败记录；
 *   2. 状态行：派发瞬间记录 target/caller/at，结算时按父会话日志实证收束为
 *      observed / not-observed，任何失败都留 target/caller/at/reason 四项日志；
 *   3. 校验与回放：applyStatus 拒绝未知 state/reason/非法时间戳，合法条目原样
 *      落盘（刷新、回放后不丢）。
 *
 * 真实环境送达（重启后由 T8 采集）不在本文件冒充；本文件只证明「代码层 +
 * 插件运行时状态行」的契约成立。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyResultStatuses,
  applyStatus,
  buildChildPrompt,
  createStatuses,
  parseWorkplanMessage,
  parseResultMessage,
  buildPlanMessage,
} from '../src/plan.js'
import {
  NOTICE_TARGET_MISSING_TEXT,
  createNoticeChannel,
  finaliseNoticeChannel,
  formatNoticeChannelLog,
  leadNoticeCallForm,
  observeRelayedNotice,
  readLeadAgentId,
  relayedSenderId,
  resolveLeadAgentId,
  validateNoticeChannel,
} from '../src/notice-channel.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'

const LEAD_ID = 'session-root-4ce46ec9'
const CHILD_ID = 'child-3759600a'

function baseSubtask(extra: any = {}) {
  return {
    id: 'T1',
    title: '验证通道',
    department: 'engineering',
    role: '工程师',
    objective: '验证子→主预告通道',
    method: ['构造夹具'],
    inputs: [],
    outputs: ['证据'],
    dependsOn: [],
    acceptance: ['断言通过'],
    risk: '夹具失真',
    ...extra,
  }
}

function planWith(subtask: any) {
  return {
    version: 1,
    planId: 'wp-notice-channel',
    title: '预告通道回归',
    sessionId: LEAD_ID,
    taskUnderstanding: {
      originalRequest: '修复并验证子→主预告通道',
      deliverable: '可复现的测试结果',
      successCriteria: ['断言全部通过'],
      constraints: ['不扩大消息目标权限'],
      knownFacts: ['宿主 send_message 只有 agent_id/message'],
      unknowns: [],
      assumptions: ['回归测试覆盖提示词与状态行'],
    },
    contradictions: {
      primary: {
        statement: '父会话 id 未注入与要求子 Agent 回报之间的矛盾',
        evidence: ['delivery: caller 时宿主不追加父 id'],
        whyPrimary: '决定通道是否结构性不可达',
      },
      secondary: [],
      transformationConditions: ['插件显式注入真实父 id'],
    },
    stages: [{
      id: 'S1',
      name: '单阶段',
      goal: '覆盖提示词与状态行',
      rationale: '最小计划即可验证',
      checkpoint: '断言通过',
      subtasks: [subtask],
    }],
    risks: [{
      risk: '通道再次漂移',
      likelihood: 'low',
      impact: '预告静默丢失',
      mitigation: '提示词与宿主 schema 由同一函数生成',
      trigger: '提示词出现 target: lead',
    }],
    verification: [{ item: '通道可达', method: '单测 + 重启后 e2e', evidence: '测试输出' }],
    practiceLoop: { plan: '写用例', do: '运行', check: '看断言', act: '修正' },
  }
}

function buildPrompt(leadAgentId = '', leadAgentIdSource = 'none') {
  const subtask = baseSubtask()
  const plan = planWith(subtask)
  return buildChildPrompt({
    plan,
    subtask,
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
    leadAgentId,
    leadAgentIdSource,
  })
}

function fakeSession(events: any[] = [], id = LEAD_ID) {
  return {
    id,
    header: { createdAt: 1000 },
    events,
    get seq() { return events.length },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
  }
}

/* ------------------------------------------------------------------ *
 * 1. 目标解析：只认可信来源，绝不猜 "lead"
 * ------------------------------------------------------------------ */

test('resolveLeadAgentId：只认 agent.id → session.id；拿不到活身份时 fail-closed（F4：不回落 plan.sessionId）', () => {
  assert.deepEqual(
    resolveLeadAgentId({ agent: { id: LEAD_ID }, session: { id: 'session-fallback' } }),
    { id: LEAD_ID, source: 'agent.id' },
  )
  assert.deepEqual(resolveLeadAgentId({ session: { id: 'session-root' } }), { id: 'session-root', source: 'session.id' })
  /*
   * [2.2.1][T5][F4] plan.sessionId 只是「计划创建时的会话 id」，可能属于另一个
   * 会话（fork / 重启后换会话 / 迁移），把它当发送目标会把预告投到别的 root
   * 会话。拿不到活 agent / 本轮 session 时必须留空，让提示词走「禁止猜测」分支。
   */
  assert.deepEqual(resolveLeadAgentId({}), { id: '', source: 'TARGET_NOT_INJECTED' })
  // 关键：函数本身不提供 "lead" 别名；调用方只会传真实 id（下方提示词用例验证旧别名绝迹）。
  assert.equal(readLeadAgentId('  '), '')
  assert.equal(readLeadAgentId(42), '')
})

test('leadNoticeCallForm：只生成宿主 schema 的 agent_id/message，不生成 target', () => {
  const form = leadNoticeCallForm(LEAD_ID)
  assert.ok(form.includes(`agent_id: ${JSON.stringify(LEAD_ID)}`), `必须带真实 agent_id：${form}`)
  assert.ok(form.includes('message:'), '必须带 message 字段')
  assert.equal(form.includes('target'), false, `不得再出现宿主不认的 target 字段：${form}`)
  assert.ok(leadNoticeCallForm('').includes('<父会话 ID：本提示词未注入>'), '缺失 id 时只能给占位符，不能编造')
})

/* ------------------------------------------------------------------ *
 * 2. 提示词：注入真实 id，失败可确定性处理，旧文案绝迹
 * ------------------------------------------------------------------ */

test('buildChildPrompt：注入真实父会话 id，使用 agent_id，不再出现 target:"lead"', () => {
  const prompt = buildPrompt(LEAD_ID, 'agent.id')
  assert.ok(prompt.includes(`agent_id: ${JSON.stringify(LEAD_ID)}`), '提示词必须包含真实父会话 id')
  assert.ok(prompt.includes('由插件注入，唯一合法目标'), '必须声明目标 id 的唯一来源')
  assert.ok(prompt.includes('完成即回报'), '必须保留完成即时回报条款')
  assert.ok(prompt.includes('开工前先报预估时长'), '必须保留开工预告条款')
  assert.equal(/send_message\s*\(\s*target/.test(prompt), false, '不得出现宿主 schema 没有的 target 调用形式')
  assert.equal(prompt.includes('"lead"'), false, '不得出现无法解析的 "lead" 目标')
  assert.ok(prompt.includes('插件不解析这一行'), 'F5：失败分支不得承诺插件会解析子 Agent 自述')
})

test('buildChildPrompt：拿不到父会话 id 时走「禁止猜测」分支并留确定性失败记录', () => {
  const prompt = buildPrompt('', 'none')
  assert.ok(prompt.includes(NOTICE_TARGET_MISSING_TEXT), '缺失 id 必须留下固定占位符')
  assert.ok(prompt.includes('禁止猜测'), '必须禁止子 Agent 自行拼接 id')
  assert.ok(prompt.includes('LEAD_ID_MISSING'), '必须给出确定性的失败原因码')
  assert.equal(/send_message\s*\(\s*target/.test(prompt), false, '缺失 id 时也不得退回 target 别名')
  assert.ok(prompt.includes('插件不解析这一行'), 'F5：不得承诺解析子 Agent 自述，避免假上报')
  assert.ok(prompt.includes('通道结论以状态行观测为准'), 'F5：必须说明真实通道结论来自观测')
})

/* ------------------------------------------------------------------ *
 * 3. 通道留痕：派发时 awaiting，结算时按实证收束
 * ------------------------------------------------------------------ */

test('createNoticeChannel：派发瞬间记录 target/caller/at，未注入 id 时原因固定', () => {
  const at = 1_794_109_539_653
  const entry = createNoticeChannel({ target: LEAD_ID, targetSource: 'agent.id', caller: CHILD_ID, at })
  assert.equal(entry.state, 'awaiting')
  assert.equal(entry.target, LEAD_ID)
  assert.equal(entry.targetSource, 'agent.id')
  assert.equal(entry.caller, CHILD_ID)
  assert.equal(entry.at, at)
  assert.equal(entry.reason, null)

  const missing = createNoticeChannel({ target: '', targetSource: 'none', caller: CHILD_ID, at })
  assert.equal(missing.target, null)
  assert.equal(missing.reason, 'TARGET_NOT_INJECTED')
})

test('finaliseNoticeChannel：observed 只能来自父会话日志实证；拿不到会话如实写 SESSION_UNAVAILABLE', () => {
  const base = createNoticeChannel({ target: LEAD_ID, targetSource: 'agent.id', caller: CHILD_ID, at: 1000 })
  const observed = finaliseNoticeChannel(base, { observed: true, observedAt: 2000, sessionAvailable: true, now: 3000 })
  assert.equal(observed.state, 'observed')
  assert.equal(observed.observedAt, 2000)
  assert.equal(observed.reason, 'agent-message-relayed')

  const notObserved = finaliseNoticeChannel(base, { observed: false, sessionAvailable: true, now: 3000 })
  assert.equal(notObserved.state, 'not-observed')
  assert.equal(notObserved.observedAt, null)
  assert.equal(notObserved.reason, 'NOT_OBSERVED_IN_SESSION_LOG')

  const unavailable = finaliseNoticeChannel(base, { sessionAvailable: false, now: 3000 })
  assert.equal(unavailable.state, 'not-observed')
  assert.equal(unavailable.reason, 'SESSION_UNAVAILABLE')

  const missing = finaliseNoticeChannel(
    createNoticeChannel({ target: '', targetSource: 'none', caller: CHILD_ID, at: 1000 }),
    { observed: false, sessionAvailable: true, now: 3000 },
  )
  assert.equal(missing.reason, 'TARGET_NOT_INJECTED')
})

/* ------------------------------------------------------------------ *
 * 4. 父会话日志观测：只认该子会话的转达消息，有界回看
 * ------------------------------------------------------------------ */

test('relayedSenderId：识别 agent/inbox/spliced 与兼容的 user/message 形状', () => {
  const relay = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      inserted: [{
        source: { kind: 'agent-message', form: 'relay', senderSessionId: CHILD_ID },
        content: [{ type: 'text', text: '预告' }],
      }],
    },
  }
  assert.equal(relayedSenderId(relay), CHILD_ID)
  const direct = {
    type: 'user/message',
    data: { message: { source: { kind: 'agent-message', senderSessionId: CHILD_ID } } },
  }
  assert.equal(relayedSenderId(direct), CHILD_ID)
  assert.equal(relayedSenderId({ data: { inserted: [{ source: { kind: 'user', senderSessionId: CHILD_ID } }] } }), '')
  assert.equal(relayedSenderId(null), '')
})

test('observeRelayedNotice：命中该子会话的转达消息；sinceMs 之前的事件不冒充；无会话返回 null', () => {
  const events: any[] = [
    { type: 'agent/inbox/spliced', time: 900, data: { inserted: [{ source: { kind: 'agent-message', senderSessionId: CHILD_ID } }] } },
    { type: 'agent/inbox/spliced', time: 1500, data: { inserted: [{ source: { kind: 'agent-message', senderSessionId: CHILD_ID } }] } },
    { type: 'agent/inbox/spliced', time: 1600, data: { inserted: [{ source: { kind: 'agent-message', senderSessionId: 'other-child' } }] } },
  ]
  const session = fakeSession(events)
  const hit = observeRelayedNotice(session, { childId: CHILD_ID, sinceMs: 1000 })
  assert.ok(hit, '必须命中 sinceMs 之后、该子会话的转达消息')
  assert.equal(hit.seq, 1)
  assert.equal(hit.at, 1500)
  assert.equal(observeRelayedNotice(session, { childId: CHILD_ID, sinceMs: 2000 }), null)
  assert.equal(observeRelayedNotice(session, { childId: 'nobody', sinceMs: 0 }), null)
  assert.equal(observeRelayedNotice({ seq: 3 }, { childId: CHILD_ID }), null, '没有 eventAt 的会话不得伪观测')
})

/* ------------------------------------------------------------------ *
 * 5. 写入校验与失败日志：不吞错、不落脏值
 * ------------------------------------------------------------------ */

test('validateNoticeChannel：合法条目原样通过；未知状态/原因、非法时间戳一律拒绝', () => {
  const valid = {
    state: 'not-observed',
    target: LEAD_ID,
    targetSource: 'session.id',
    caller: CHILD_ID,
    at: 1000,
    observedAt: null,
    reason: 'NOT_OBSERVED_IN_SESSION_LOG',
  }
  const ok = validateNoticeChannel(valid)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, valid)

  for (const bad of [
    { ...valid, state: 'sent' },
    { ...valid, reason: '因为网络不好' },
    { ...valid, at: 0 },
    { ...valid, observedAt: -1 },
    // F2：跨字段不一致、超长目标、超出 Date 范围的时间戳
    { ...valid, state: 'observed', observedAt: null, reason: 'agent-message-relayed' },
    { ...valid, state: 'observed', observedAt: 2000, reason: null },
    { ...valid, state: 'awaiting', observedAt: 2000 },
    { ...valid, state: 'awaiting', reason: 'NOT_OBSERVED_IN_SESSION_LOG' },
    { ...valid, target: 'x'.repeat(201) },
    { ...valid, at: 9e15 },
  ]) {
    const checked = validateNoticeChannel(bad)
    assert.equal(checked.ok, false, `必须拒绝脏值：${JSON.stringify(bad)}`)
    assert.match(String(checked.error), /noticeChannel/)
  }
  assert.equal(validateNoticeChannel(null).ok, false)
  assert.equal(validateNoticeChannel([]).ok, false)
})

test('formatNoticeChannelLog：失败日志四项齐全（目标/调用方/时间戳/原因）', () => {
  const line = formatNoticeChannelLog({ subtaskId: 'T3', target: '', caller: '', at: 1000, reason: 'SESSION_UNAVAILABLE' })
  assert.ok(line.includes('T3 noticeChannel:'), line)
  assert.ok(line.includes(`target=${NOTICE_TARGET_MISSING_TEXT}`), '目标缺失必须显式写占位符，不得为空')
  assert.ok(line.includes('caller=pending-child'), '调用方缺失必须显式写占位符')
  assert.ok(line.includes('at=1970-01-01T00:00:01.000Z'), '必须带可复核的 ISO 时间戳')
  assert.ok(line.includes('reason=SESSION_UNAVAILABLE'), '必须带固定原因码')
  const full = formatNoticeChannelLog({ subtaskId: 'T3', target: LEAD_ID, caller: CHILD_ID, at: 1000, reason: 'NOT_OBSERVED_IN_SESSION_LOG' })
  assert.ok(full.includes(`target=${LEAD_ID}`) && full.includes(`caller=${CHILD_ID}`))
})

test('applyStatus：noticeChannel 走单点校验；合法条目落行，非法条目抛错且不污染原行', () => {
  const plan = planWith(baseSubtask())
  let statuses = createStatuses(plan)
  const entry = createNoticeChannel({ target: LEAD_ID, targetSource: 'agent.id', caller: CHILD_ID, at: 1000 })

  statuses = applyStatus(statuses, 'T1', { noticeChannel: entry })
  assert.deepEqual((statuses[0] as any).noticeChannel, entry, '合法通道条目必须原样进入状态行（刷新/回放可读）')

  assert.throws(
    () => applyStatus(statuses, 'T1', { noticeChannel: { ...entry, state: 'unknown' } }),
    /noticeChannel/,
    '未知 state 必须在写入前被拒绝',
  )
  assert.deepEqual((statuses[0] as any).noticeChannel, entry, '非法写入不得把原行改成脏值')
})

/* ------------------------------------------------------------------ *
 * 6. 运行时集成：派发写 awaiting；父会话日志出现转达消息后收束 observed
 * ------------------------------------------------------------------ */

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => { release = resolve })
  return { promise, release }
}

function completed(text = '完成') {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function makePlanMessage(subtask: any, sessionId = LEAD_ID) {
  return buildPlanMessage({
    planId: 'wp-notice-channel',
    sessionId,
    createdTurn: 1,
    createdAt: 1000,
    title: '预告通道运行时集成',
    taskUnderstanding: { originalRequest: '验证通道状态行', deliverable: '状态行 observed' },
    contradictions: { primary: { statement: '子 Agent 不知道父 id' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks: [subtask] }],
  })
}

test('运行时集成：派发写 awaiting（真实 target/caller），转达消息落父会话后结算为 observed', async () => {
  const session = fakeSession([])
  session.append('user/message', makePlanMessage(baseSubtask()))
  assert.equal(parseWorkplanMessage(session.events[0].data)?.planId, 'wp-notice-channel')

  const gate = deferred()
  let startedAt = 0
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        startedAt = Date.now()
        return { childId: CHILD_ID, result: gate.promise, dispose: async () => {} }
      },
    },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: () => undefined,
    },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    strictEvidence: false,
  })
  await runtime.dispatchTool({ id: LEAD_ID, session, options: {} }, { mode: 'async' }, new AbortController().signal)

  const running: any = await runtime.statusTool({ session }, {})
  const row = (running?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  assert.ok(row?.noticeChannel, '派发后状态行必须出现 noticeChannel')
  assert.equal(row.noticeChannel.state, 'awaiting')
  assert.equal(row.noticeChannel.target, session.id, '目标必须是本轮主会话 id（不得是 "lead"）')
  assert.equal(row.noticeChannel.caller, CHILD_ID)
  assert.ok(Number(row.noticeChannel.at) >= startedAt - 5, '通道时间必须是派发时刻')

  // 父会话日志里出现该子会话转达的预告（真实形状：agent/inbox/spliced）。
  session.events.push({
    type: 'agent/inbox/spliced',
    time: Date.now(),
    data: {
      target: 'next-step',
      inserted: [{
        source: { kind: 'agent-message', form: 'relay', senderSessionId: CHILD_ID },
        content: [{ type: 'text', text: 'T1 开工预告：预计 5 分钟' }],
      }],
    },
  })

  gate.release(completed('完成'))
  assert.ok(
    await waitFor(() => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data)), 10_000),
    '本轮应结算并写入结果消息',
  )
  const finished: any = await runtime.statusTool({ session }, {})
  const settled = (finished?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  assert.ok(settled?.noticeChannel, '结算后 noticeChannel 必须仍在状态行')
  assert.equal(settled.noticeChannel.state, 'observed', '父会话日志有转达消息时必须判 observed')
  assert.equal(settled.noticeChannel.reason, 'agent-message-relayed')
  assert.ok(Number(settled.noticeChannel.observedAt) > 0, 'observedAt 必须来自父会话日志的实证时间')
})

/* ------------------------------------------------------------------ *
 * 7. 进程重启后的回放：noticeChannel 必须活过 reconstructFromSession
 * ------------------------------------------------------------------ */

test('F1 回放：进程重启后 reconstructFromSession 仍保留 noticeChannel', () => {
  const session = fakeSession([])
  session.append('user/message', makePlanMessage(baseSubtask()))
  const observed = {
    state: 'observed',
    target: LEAD_ID,
    targetSource: 'agent.id',
    caller: CHILD_ID,
    at: 1500,
    observedAt: 1600,
    reason: 'agent-message-relayed',
  }
  const payload = {
    kind: 'workplan-result',
    version: 1,
    planId: 'wp-notice-channel',
    sessionId: LEAD_ID,
    dispatchedAt: 1000,
    statuses: [{
      subtaskId: 'T1',
      status: 'done',
      closure: 'reported',
      progress: 100,
      startedAt: 1200,
      finishedAt: 1700,
      summary: '完成',
      verification: 'structured',
      acceptance: [{ criterion: '结果可核对', result: 'pass' }],
      artifacts: [],
      missingArtifacts: [],
      needs: [],
      noticeChannel: observed,
    }],
    stats: { total: 1, done: 1, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
    phase: 'done',
  }
  const text = `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify(payload)}\n<!-- DSH-WORKPLAN-RESULT:END -->`
  session.append('user/message', { content: [{ type: 'text', text }] })

  const rebuilt: any = reconstructFromSession(session, 'wp-notice-channel')
  assert.ok(rebuilt, '必须能从会话日志重建计划')
  const row = (rebuilt.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  assert.ok(row, '重建后必须保留 T1 行')
  assert.deepEqual(row.noticeChannel, observed, '进程重启后的回放不得丢弃 noticeChannel（F1）')
})

/* ------------------------------------------------------------------ *
 * 8. [2.2.1][T5][F1] 回放容错：脏通道字段不得丢弃整条结果行
 *
 * 复现来源：T4 残余项复核（artifacts/t4-residual-verify-20261108/）A2/B2 ——
 * 结果载荷里出现 noticeChannel:null（或非法 state）时，applyResultStatuses
 * 会把整条结果行交给 applyStatus，单点校验抛错后被 catch 吞掉，于是
 * done/summary/verification/acceptance 全不落地，一条完成行回放成 pending。
 * 这组用例把「null/非法值按字段缺失处理、合法值原样回放、重建后不留 null」
 * 钉在回放入口（applyResultStatuses）与真实重建入口（reconstructFromSession）。
 * ------------------------------------------------------------------ */

function observedNoticeEntry() {
  return {
    state: 'observed',
    target: LEAD_ID,
    targetSource: 'agent.id',
    caller: CHILD_ID,
    at: 1500,
    observedAt: 1600,
    reason: 'agent-message-relayed',
  }
}

function resultPayload(noticeChannels: any[]) {
  const statuses = noticeChannels.map((noticeChannel) => {
    const row: any = {
      subtaskId: 'T1',
      status: 'done',
      closure: 'reported',
      progress: 100,
      startedAt: 1200,
      finishedAt: 1700,
      summary: '完成',
      verification: 'structured',
      acceptance: [{ criterion: '结果可核对', result: 'pass', evidence: 'evidence/01.log' }],
      artifacts: [],
      missingArtifacts: [],
      needs: [],
    }
    if (noticeChannel !== undefined) row.noticeChannel = noticeChannel
    return row
  })
  return {
    kind: 'workplan-result',
    version: 1,
    planId: 'wp-notice-channel',
    sessionId: LEAD_ID,
    dispatchedAt: 1000,
    statuses,
    stats: { total: 1, done: 1, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
    phase: 'done',
  }
}

function reconstructWith(payload: any) {
  const session = fakeSession([])
  session.append('user/message', makePlanMessage(baseSubtask()))
  const text = `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify(payload)}\n<!-- DSH-WORKPLAN-RESULT:END -->`
  session.append('user/message', { content: [{ type: 'text', text }] })
  return reconstructFromSession(session, 'wp-notice-channel')
}

function assertDoneRow(row: any, label: string) {
  assert.ok(row, `${label}: T1 行必须存在`)
  assert.equal(row.status, 'done', `${label}: done 行不得回放成 ${row?.status}`)
  assert.equal(row.summary, '完成', `${label}: 完成摘要不得丢失`)
  assert.equal(row.verification, 'structured', `${label}: 证据等级不得丢失`)
  assert.equal(Array.isArray(row.acceptance) && row.acceptance.length, 1, `${label}: 验收项不得丢失`)
}

test('F1-a 回放容错：noticeChannel:null 不得丢弃整行（done 仍 done、摘要/证据保留）', () => {
  const replayed: any = applyResultStatuses(createStatuses(planWith(baseSubtask())), resultPayload([null]))
  const row = replayed.find((item: any) => item.subtaskId === 'T1')
  assertDoneRow(row, 'applyResultStatuses(null)')
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, 'noticeChannel'),
    false,
    'null 必须按「字段缺失」处理，不得把 null 写进状态行',
  )
})

test('F1-b 回放容错：非法非空 state 同样不得丢弃整行', () => {
  const bad = { ...observedNoticeEntry(), state: 'sent' }
  const replayed: any = applyResultStatuses(createStatuses(planWith(baseSubtask())), resultPayload([bad]))
  const row = replayed.find((item: any) => item.subtaskId === 'T1')
  assertDoneRow(row, 'applyResultStatuses(非法 state)')
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'noticeChannel'), false, '非法值不得落进状态行')
})

test('F1-c 回放容错不误伤合法值：observed 原样回放', () => {
  const observed = observedNoticeEntry()
  const replayed: any = applyResultStatuses(createStatuses(planWith(baseSubtask())), resultPayload([observed]))
  const row = replayed.find((item: any) => item.subtaskId === 'T1')
  assertDoneRow(row, 'applyResultStatuses(合法值)')
  assert.deepEqual(row.noticeChannel, observed, '合法通道字段必须原样保留')
})

test('F1-d 重建：null 通道字段被删除而非写回 null（切断自我延续）', () => {
  const rebuilt: any = reconstructWith(resultPayload([null]))
  const row = (rebuilt?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  assertDoneRow(row, 'reconstructFromSession(null)')
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, 'noticeChannel'),
    false,
    '重建后不得留下 noticeChannel:null（否则下一次重启继续自我延续）',
  )
})

test('F1-e 重建：合法值仍活过重启（回归保护）', () => {
  const observed = observedNoticeEntry()
  const rebuilt: any = reconstructWith(resultPayload([observed]))
  const row = (rebuilt?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  assertDoneRow(row, 'reconstructFromSession(合法值)')
  assert.deepEqual(row.noticeChannel, observed, '合法通道字段必须活过进程重启')
})

/* ------------------------------------------------------------------ *
 * 9. [2.2.1][T5][F4] 无活 agent 时不得拿 plan.sessionId 当发送目标
 * ------------------------------------------------------------------ */

test('F4 运行时：无活 agent 时不得把 plan.sessionId 当发送目标（fail-closed）', async () => {
  const session = fakeSession([])
  session.append('user/message', makePlanMessage(baseSubtask()))
  const gate = deferred()
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => ({ childId: CHILD_ID, result: gate.promise, dispose: async () => {} }),
    },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: () => undefined,
    },
  }
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, idleTimeoutMs: 30_000, strictEvidence: false })
  // 只给会话、不给活 agent：这是 T4 D5 的「injected 为空且无活 agent」场景。
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)

  const running: any = await runtime.statusTool({ session }, {})
  const row = (running?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  assert.ok(row?.noticeChannel, '派发后状态行必须留下通道条目（即使目标不可用也要如实记录）')
  assert.equal(row.noticeChannel.target, null, 'plan.sessionId 不得被当成发送目标')
  assert.equal(row.noticeChannel.reason, 'TARGET_NOT_INJECTED', '目标不可用必须给出确定性原因码')

  gate.release(completed('完成'))
  assert.ok(
    await waitFor(() => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data)), 10_000),
    '本轮应正常结算，不得因为目标缺失而卡住',
  )
})
