/*
 * [1.9.2 / T6] superseded 写侧：唯一写入入口 + 写入 → 读侧链路。
 *
 * 1.9.0/1.9.1 只有读侧（replay 读 `cancel.disposition === 'superseded'`，
 * present 走覆盖链，dispatch 回 `PLAN_SUPERSEDED`）。写侧缺口是：没有任何
 * 代码会把记录写成 superseded，任何「就地改 phase」的捷径都会让 live 与
 * replay 分叉。这些用例钉住三件事：
 *
 *  1. 写入必须经 `src/supersede.ts`（V1–V8 → durable 信封 → 才翻内存），
 *     且一条处置只追加一条日志；
 *  2. 写进去之后，replay / 冷启动 runtime / present / dispatch 看到的是
 *     同一个 superseded 事实（不是内存自说自话）；
 *  3. 失败即不变（§7.4）：输入/证据/确认/映射任一处不满足时，日志与状态
 *     都不动，码值可断言；修好之后同一入口可以重试成功。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCancelMessage,
  buildPlanMessage,
  buildResultMessage,
  createStatuses,
  derivePlanSnapshot,
  parseCancelMessage,
} from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { computeMappingDigest, verifyMappingDigest } from '../src/supersede-digest.js'
import { SUPERSEDE_CODES } from '../src/supersede.js'

const SESSION_ID = 'session-supersede'

function makePlan(planId: string, createdTurn: number, count = 2) {
  return {
    planId,
    sessionId: SESSION_ID,
    createdTurn,
    createdAt: 1000,
    title: `覆盖迁移 ${planId}`,
    contradictions: { primary: { statement: '被取代不等于完成：交付只能使用承接计划的证据' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: Array.from({ length: count }, (_, i) => ({
        id: `T${i + 1}`,
        title: `第 ${i + 1} 步`,
        department: 'engineering',
        dependsOn: i === 0 ? [] : [`T${i}`],
      })),
    }],
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: SESSION_ID,
    header: { createdAt: 1000 },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeCtx(session: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('unit test: dispatch must not start a child') } },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: (seq: number) => session.eventAt(seq),
    },
    get: () => undefined,
    llm: {
      stream() {
        throw new Error('unit test: planner is not available')
      },
    },
  }
}

function markDone(status: any) {
  status.status = 'done'
  status.progress = 100
  status.verification = 'structured'
  status.acceptance = [{ criterion: `${status.subtaskId} 验收`, result: 'pass', evidence: 'test' }]
  status.missingArtifacts = []
}

function settle(session: any, plan: any, statuses: any[]) {
  session.append('user/message', buildResultMessage({
    planId: plan.planId,
    sessionId: session.id,
    dispatchedAt: 2000,
    statuses,
    errors: [],
    stats: derivePlanSnapshot(statuses).stats,
    phase: 'executing',
  }))
}

function userMessage(id: string, text: string, source?: any) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    ...(source ? { source } : {}),
  }
}

const MAPPING = [
  { from: 'T1', to: 'T1', basis: 'T1 是同一交付责任' },
  { from: 'T2', to: 'T2', basis: 'T2 是同一交付责任' },
]

const SUPERSEDE_ARGS = {
  planId: 'wp-a',
  disposition: 'superseded',
  reason: '责任转移给承接计划',
  supersededBy: { planId: 'wp-b', mapping: MAPPING },
}

interface PrepareOptions {
  order?: 'a-first' | 'b-first'
  bEvidenceGap?: boolean
  confirm?: boolean
  pluginConfirm?: boolean
}

function prepare(options: PrepareOptions = {}) {
  const session: any = makeSession()
  const planA = makePlan('wp-a', 1)
  const planB = makePlan('wp-b', 2)
  if (options.order === 'b-first') {
    session.append('user/message', buildPlanMessage(planB))
    session.append('user/message', buildPlanMessage(planA))
  } else {
    session.append('user/message', buildPlanMessage(planA))
    session.append('user/message', buildPlanMessage(planB))
  }

  const statusesA: any[] = createStatuses(planA)
  markDone(statusesA[0]) // A 只完成 1/2，未全 done 才允许被取代
  settle(session, planA, statusesA)

  const statusesB: any[] = createStatuses(planB)
  statusesB.forEach(markDone)
  if (options.bEvidenceGap) {
    statusesB[1].status = 'done'
    statusesB[1].acceptance = [{ criterion: 'T2 验收', result: 'fail', evidence: 'gap' }]
  }
  settle(session, planB, statusesB)

  if (options.pluginConfirm) {
    session.append('user/message', userMessage(
      'm-plugin',
      '确认：wp-a 由 wp-b 承接，wp-a 与 wp-b 的覆盖关系已记录',
      { kind: 'workplan' },
    ))
  }
  if (options.confirm !== false) {
    session.append('user/message', userMessage(
      'm-confirm',
      '确认把 wp-a 的责任交给 wp-b 承接：wp-b 的逐项证据覆盖 wp-a 的全部未完成项。',
    ))
  }

  const runtime: any = createWorkplanRuntime(makeCtx(session), { version: 'test' })
  return { session, planA, planB, runtime }
}

async function cancelSource(runtime: any, session: any) {
  const cancelled = await runtime.cancelPlan({ session }, { planId: 'wp-a', reason: '用户取消' })
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(cancelled.cancelRecorded, true)
  return cancelled
}

function supersededEnvelopes(session: any) {
  return session.events
    .map((event: any) => parseCancelMessage(event.data))
    .filter((payload: any) => payload?.disposition === 'superseded')
}

test('T6-1 写入 superseded 后 replay/冷启动/dispatch/present 看到同一个事实', async () => {
  const { session, runtime } = prepare()
  await cancelSource(runtime, session)
  const seqBefore = session.seq

  const result = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.phase, 'superseded')
  assert.equal(result.coverage, 'full')
  assert.equal(result.requiredCount, 2)
  assert.equal(result.coveredCount, 2)
  assert.equal(result.supersedeRecorded, true)
  assert.match(String(result.supersededBy?.digest), /^sha256:[0-9a-f]{64}$/)

  // 一条处置只追加一条 durable 记录，信封字段可逐字回读。
  assert.equal(session.seq, seqBefore + 1)
  const envelopes = supersededEnvelopes(session)
  assert.equal(envelopes.length, 1)
  assert.equal(envelopes[0].planId, 'wp-a')
  assert.equal(envelopes[0].supersededBy.planId, 'wp-b')
  assert.equal(envelopes[0].supersededBy.coverage, 'full')
  assert.equal(envelopes[0].supersededBy.verifiedBy, 'runtime-recompute')
  assert.equal(
    verifyMappingDigest(envelopes[0].supersededBy.mapping, envelopes[0].supersededBy.digest),
    true,
    'durable 记录里的 mapping 与 digest 必须能复算',
  )

  // 读侧 1：日志重放。
  const replayed: any = reconstructFromSession(session, 'wp-a')
  assert.equal(replayed.phase, 'superseded')
  assert.equal(replayed.superseded, true)
  assert.equal(replayed.cancelled, false)
  assert.equal(replayed.supersededBy.planId, 'wp-b')
  // 终态互斥与写入见证：取消信封在先、取代信封在后，回放不得留下「既取消又被取代」。
  assert.equal(replayed.cancelRecorded, true, '先前的取消是已落盘事实，与 live 记录一致')
  assert.equal(replayed.supersedeRecorded, true, '取代信封的写入见证必须可回放')

  // 读侧 2：冷启动 runtime（只有日志，没有内存状态）。
  const cold: any = createWorkplanRuntime(makeCtx(session), { version: 'test-cold' })
  const locked = await cold.cancelPlan({ session }, { planId: 'wp-a' })
  assert.equal(locked.ok, false)
  assert.equal(locked.code, 'SUPERSEDED_LOCKED')
  assert.equal(locked.cancelRecorded, true, '冷启动拒绝体与热路径字段一致（supersedeRecorded 已回放）')

  // 读侧 3：dispatch 不得再启动任何部门 Agent。
  const dispatch = await runtime.dispatchTool(
    { session },
    { planId: 'wp-a', mode: 'async' },
    new AbortController().signal,
  )
  assert.equal(dispatch.ok, false)
  assert.equal(dispatch.code, 'PLAN_SUPERSEDED')

  // 读侧 4：present 走覆盖链；承接计划 2/2 结构化就绪时放行，digest 被改动即 stale。
  assert.equal(runtime.supersededDenialVerdict(session, replayed), undefined)
  const tampered = {
    ...replayed,
    supersededBy: { ...replayed.supersededBy, digest: `sha256:${'0'.repeat(64)}` },
  }
  const stale = runtime.supersededDenialVerdict(session, tampered)
  assert.equal(stale?.code, 'SUPERSEDED_STALE')
})

test('T6-2 承接计划有证据缺口时拒绝写入（失败即不变），补齐后同一入口可重试', async () => {
  const { session, planB, runtime } = prepare({ bEvidenceGap: true })
  await cancelSource(runtime, session)
  const seqBefore = session.seq

  const denied = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, SUPERSEDE_CODES.EVIDENCE_GAP)
  assert.ok(Array.isArray(denied.gaps) && denied.gaps.length >= 1)
  assert.match(denied.gaps.join('；'), /T1→T2|T2/)
  assert.equal(session.seq, seqBefore, '拒绝时不得追加任何日志')
  assert.equal(supersededEnvelopes(session).length, 0)
  assert.equal(runtime.state.records.get(session.id).phase, 'cancelled')
  assert.match(String(denied.hint), /状态未改变/)

  // 修好证据：同一 plan 的后续结果消息覆盖旧状态，重试走同一入口。
  const fixed: any[] = createStatuses(planB)
  fixed.forEach(markDone)
  settle(session, planB, fixed)
  const retried = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(retried.ok, true, JSON.stringify(retried))
  assert.equal(retried.phase, 'superseded')
})

test('T6-3 插件消息里的「确认」不算用户确认（V8），真实用户确认后才通过', async () => {
  const { session, runtime } = prepare({ confirm: false, pluginConfirm: true })
  await cancelSource(runtime, session)
  const seqBefore = session.seq

  const denied = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, SUPERSEDE_CODES.NOT_CONFIRMED)
  assert.equal(session.seq, seqBefore)
  assert.equal(runtime.state.records.get(session.id).phase, 'cancelled')

  session.append('user/message', userMessage(
    'm-user-confirm',
    '同意：wp-a 交给 wp-b，按此执行逐项覆盖。',
  ))
  // 确认消息的 seq 必须在重试之前取：重试成功会再追加一条取代信封，
  // 拿重试后的 session.seq - 1 去比就把「确认位置」和「写入位置」混为一谈。
  const confirmSeq = session.seq - 1
  const retried = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(retried.ok, true, JSON.stringify(retried))
  assert.equal(retried.confirmedAtSeq, confirmSeq)
  assert.equal(supersededEnvelopes(session).length, 1)
  assert.equal(session.seq, confirmSeq + 2)
})

test('T6-4 映射不完整与承接计划未知都按码值拒绝', async () => {
  const { session, runtime } = prepare()
  await cancelSource(runtime, session)

  // runtime.cancelPlan(agent, args)：处置参数必须放第二个位置。
  const unknown = await runtime.cancelPlan({ session }, {
    planId: 'wp-a',
    disposition: 'superseded',
    supersededBy: { planId: 'wp-ghost', mapping: MAPPING },
  } as any)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, SUPERSEDE_CODES.TARGET_UNKNOWN)
  assert.equal(runtime.state.records.get(session.id).phase, 'cancelled')

  const incomplete = await runtime.cancelPlan({ session }, {
    planId: 'wp-a',
    disposition: 'superseded',
    supersededBy: { planId: 'wp-b', mapping: [MAPPING[0]] },
  } as any)
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.code, SUPERSEDE_CODES.MAPPING_INCOMPLETE)
  assert.deepEqual(incomplete.missingFrom, ['T2'])
  assert.equal(incomplete.coveredCount, 1)
  assert.equal(incomplete.requiredCount, 2)
})

test('T6-5 承接计划必须定义得更晚（V2）', async () => {
  const { session, runtime } = prepare({ order: 'b-first' })
  await cancelSource(runtime, session)
  const denied = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, SUPERSEDE_CODES.ORDER_INVALID)
  assert.equal(runtime.state.records.get(session.id).phase, 'cancelled')
})

test('T6-6 幂等 alreadySuperseded，且普通取消不能把 superseded 改回 cancelled', async () => {
  const { session, runtime } = prepare()
  await cancelSource(runtime, session)
  const first = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(first.ok, true)
  const seq = session.seq

  const again = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(again.ok, true)
  assert.equal(again.alreadySuperseded, true)
  assert.equal(session.seq, seq, '幂等调用不得追加记录')

  const plain = await runtime.cancelPlan({ session }, { planId: 'wp-a', reason: '想撤销取代' })
  assert.equal(plain.ok, false)
  assert.equal(plain.code, 'SUPERSEDED_LOCKED')
  assert.equal(session.seq, seq, '被拒绝的取消不得追加第二条不带 disposition 的信封')
  assert.equal(runtime.state.records.get(session.id).phase, 'superseded')
  assert.equal(supersededEnvelopes(session).length, 1)
})

test('T6-7 自动覆盖路径只写 cancelled，且不改写已 superseded 的终态记录', async () => {
  // 正例：上一轮未派发的 pending 计划，新回合仍按原语义自动取消。
  const pendingSession: any = makeSession()
  const pendingPlan: any = makePlan('wp-p', 1)
  pendingSession.append('user/message', buildPlanMessage(pendingPlan))
  const pendingRuntime: any = createWorkplanRuntime(makeCtx(pendingSession), { version: 'test' })
  const pendingRecord: any = {
    plan: pendingPlan,
    statuses: createStatuses(pendingPlan),
    phase: 'pending',
    errors: [],
    createdAt: 1000,
    updatedAt: 1000,
    dispatchedAt: null,
    dispatchPromise: null,
    createdTurn: 1,
  }
  pendingRuntime.state.records.set(pendingSession.id, pendingRecord)
  const next = async () => ({ kind: 'enter', messages: [] })
  const pendingDecision = await pendingRuntime.onPreStep({
    agent: { session: pendingSession },
    turn: 2,
    step: 1,
    modelSelection: { provider: 'test', model: 'test-model' },
    messages: [userMessage('m-task-pending', '修复状态机写入路径并给出测试证据')],
    signal: new AbortController().signal,
  }, next)
  assert.equal(pendingRecord.phase, 'cancelled')
  assert.ok((pendingRecord.errors as string[]).some((item) => /上一轮未派发/.test(item)))
  assert.equal(pendingDecision?.kind, 'enter')

  // 反例：已 superseded 的记录不得被自动覆盖改回 cancelled（live/replay 分叉）。
  const { session, runtime } = prepare()
  await cancelSource(runtime, session)
  const supersededResult = await runtime.cancelPlan({ session }, SUPERSEDE_ARGS)
  assert.equal(supersededResult.ok, true)
  const record = runtime.state.records.get(session.id)
  assert.equal(record.phase, 'superseded')

  await runtime.onPreStep({
    agent: { session },
    turn: 2,
    step: 1,
    modelSelection: { provider: 'test', model: 'test-model' },
    messages: [userMessage('m-task-superseded', '继续补齐其余测试并给出可回查证据')],
    signal: new AbortController().signal,
  }, next)
  assert.equal(record.phase, 'superseded', '自动覆盖路径不得把 superseded 改回 cancelled')
  assert.equal((record.errors ?? []).length, 0, '自动覆盖路径不得给 superseded 记录追加取消错误')
})

test('T6-8 cancelled 信封逐字不变；superseded 信封拒绝不可复算的 payload', () => {
  const cancelled: any = parseCancelMessage(buildCancelMessage('wp-x', '用户取消'))
  assert.deepEqual(Object.keys(cancelled).sort(), ['cancelledAt', 'kind', 'planId', 'reason', 'version'])
  assert.equal(cancelled.disposition, undefined, 'cancelled 路径不得新增字段')
  assert.equal(cancelled.version, 1)

  const mapping = [{ from: 'T1', to: 'T1', basis: '同一交付责任' }]
  const digest = computeMappingDigest(mapping)
  const superseded: any = parseCancelMessage(buildCancelMessage('wp-x', '责任转移', {
    disposition: 'superseded',
    supersededAt: 123,
    supersededBy: {
      planId: 'wp-y',
      requiredCount: 1,
      coveredCount: 1,
      coverage: 'full',
      mapping,
      verifiedAt: 123,
      verifiedBy: 'runtime-recompute',
      digest,
    },
  }))
  assert.equal(superseded.disposition, 'superseded')
  assert.equal(superseded.cancelledAt, 123)
  assert.equal(superseded.supersededAt, 123)
  assert.equal(superseded.supersededBy.planId, 'wp-y')
  assert.equal(verifyMappingDigest(superseded.supersededBy.mapping, superseded.supersededBy.digest), true)

  assert.throws(
    () => buildCancelMessage('wp-x', '责任转移', {
      disposition: 'superseded',
      supersededAt: 123,
      supersededBy: {
        planId: 'wp-y',
        requiredCount: 1,
        coveredCount: 1,
        coverage: 'full',
        mapping: [{ from: 'T1', to: 'T1', basis: '被改动过的依据' }],
        verifiedAt: 123,
        verifiedBy: 'runtime-recompute',
        digest,
      },
    }),
    /可复算/,
  )
  assert.throws(() => buildCancelMessage('wp-x', 'x', { disposition: 'maybe' }), /disposition/)
})

test('T6-9 非法 disposition 在入口被拒绝，不会静默降级成取消', async () => {
  const { session, runtime } = prepare()
  await cancelSource(runtime, session)
  const seqBefore = session.seq

  await assert.rejects(
    () => runtime.cancelPlan({ session }, { planId: 'wp-a', disposition: 'maybe' } as any),
    /disposition/,
  )
  assert.equal(session.seq, seqBefore, '非法入参不得追加日志')
  assert.equal(runtime.state.records.get(session.id).phase, 'cancelled')

  // 拼错的 disposition 若被静默忽略，就会把「想取代」写成「取消」——两者的读侧
  // 判定完全不同，所以这里同时钉住「拒绝」与「状态不变」。
  await assert.rejects(
    () => runtime.cancelPlan({ session }, { planId: 'wp-a', disposition: 'supersede' } as any),
    /disposition/,
  )
  assert.equal(session.seq, seqBefore)
})
