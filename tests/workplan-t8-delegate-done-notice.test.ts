/*
 * [T8] 第三层叶子完成即时通知 → 原分派部门负责人会话（回归）。
 *
 * 契约依据：_t5_channel_20261112/00-contract-v1.md §1/§5（kind='completion'，
 * from 叶子 → to head，appendDeptMessage 留痕 + ctx.subagents.sendMessage 定向
 * 投递；幂等守卫只拦 report.state='sent'，failed 可重试；DELIVERY_FAILED 显式
 * 留痕）。改动前缺陷：两处叶子结算回调只把 durable workplan-update 写到根会话，
 * 负责人会话没有插件侧即时完成汇报，delegates 条目无回报幂等标记。
 *
 * 本文件逐条钉死：
 *  T8-1 dispatch 结算 done ⇒ sendMessage(根 agent→负责人会话) + completion 留痕
 *       + delegates[].report.state='sent' + 负责人纯文本通知 + 根 durable 回放；
 *       主行 closure/report 不受影响（主计划通知仍→根，T9 范围）。
 *  T8-2 幂等：已 sent 的成员在后续结算中不重报（sendMessage 恰每成员一次）。
 *  T8-3 投递失败 ⇒ report.state='failed' + DELIVERY_FAILED 留痕 + errors 审计；
 *       下一次结算自动补发（只有 sent 拦重报，T5 教训）。
 *  T8-4 done-only：failed 叶子不产生完成通知。
 *  T8-5 待指示优先：escalation 挂起的叶子结算不得覆盖成 done，也不通知。
 *  T8-6 selfEffort 接续结算同款路由到负责人会话（第二处接线）。
 *  T8-7 [T8][D2 同步] delegates 消毒上限 12（8 人结算不截断）+ report 子对象
 *       消毒持久化（非法形状丢弃）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkplanRuntime } from '../src/runtime.js'
import { applyStatus, createStatuses, flushPendingWorkplanUpdates } from '../src/plan.js'
import { readDeptMessages } from '../src/dept-journal.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

process.env.DSH_WORKPLAN_LESSONS_FILE = join(tmpdir(), `t8-lessons-${process.pid}.jsonl`)
process.env.DSH_WORKPLAN_JOURNAL_DIR = mkdtempSync(join(tmpdir(), `t8-journal-${process.pid}-`))

const QWEN = 'qwen3-max-preview'
const flush = () => new Promise((resolve) => setTimeout(resolve, 25))
const textOf = (event: any) => (Array.isArray(event?.data?.content) ? event.data.content.map((c: any) => String(c?.text ?? '')).join('') : '')

function makePlan(suffix: string) {
  return {
    planId: `wp-t8-notice-${suffix}`, sessionId: 'session-root', createdTurn: 1, createdAt: 1000, title: 'T8 完成通知路由',
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [] }] }],
  }
}

function makeRuntime(opts: { failDeliveryOnce?: boolean } = {}, suffix = 'x') {
  const plan = makePlan(suffix)
  const rootEvents: any[] = []
  const leaderEvents: any[] = []
  const rootSession: any = {
    id: 'session-root', header: { createdAt: 1000, cwd: '/tmp/t8-cwd' },
    get seq() { return rootEvents.length },
    append(type: string, data: any) { rootEvents.push({ type, data }); return data },
    eventAt: (seq: number) => rootEvents[seq], events: rootEvents,
  }
  const leaderSession: any = {
    id: 'child-leader', header: { createdAt: 1000, parentSession: 'session-root', cwd: '/tmp/t8-cwd' },
    get seq() { return leaderEvents.length },
    append(type: string, data: any) { leaderEvents.push({ type, data }); return data },
    eventAt: (seq: number) => leaderEvents[seq], events: leaderEvents,
  }
  const rootAgent: any = { session: rootSession, options: { provider: 'qw', model: QWEN } }
  const leaderAgent: any = { session: leaderSession, options: { provider: 'qw', model: QWEN } }
  const spawned: any[] = []
  const sent: any[] = []
  let sendAttempts = 0
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        const childId = `member-${spawned.length + 1}`
        let resolveResult: any
        const result = new Promise((resolve) => { resolveResult = resolve })
        spawned.push({ childId, resolveResult })
        return { childId, result, dispose: async () => {} }
      },
      interruptByParent: () => ({ ok: true }),
      sendMessage: async (agent: any, targetId: string, content: any[]) => {
        sendAttempts += 1
        if (opts.failDeliveryOnce && sendAttempts === 1) throw new Error('host lineage rejected (simulated)')
        sent.push({ agent, targetId, text: String(content?.[0]?.text ?? '') })
        return `msg-${sent.length}`
      },
    },
    sessions: { get: (id: string) => (id === 'session-root' ? rootSession : id === 'child-leader' ? leaderSession : undefined), list: () => [] },
    get: (name: string) => (name === 'agents' ? { get: (id: string) => (id === 'session-root' ? rootAgent : id === 'child-leader' ? leaderAgent : undefined) } : undefined),
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = 'child-leader'
  const record = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set('session-root', record)
  return { runtime, record, spawned, sent, rootAgent, leaderAgent, rootSession, leaderSession, rootEvents, leaderEvents }
}

/*
 * [3.0.0][2.5.5 禁派 regime] 未配置整体等级视同 low ⇒ review 被
 * DELEGATE_LOW_TASK_FORBIDDEN 硬拒。本文件只考察「叶子完成 → 定向汇报」链路，
 * 与人数、角色无关，因此声明复杂档并补齐 8 名专家（前两名保持原夹具语义
 * Expert-A / Member-B，其余为通用专家），断言意图零改动。
 */
const consolidation = () => ({
  taskReasoningEffort: 'medium',
  problemAnalysis: ['现状：任务拆给专家与组员；目标是保质保量完成；约束是不改无关文件；边界是只做分内工作。'],
  approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测；组员整理证据清单并逐条核对验收。'],
  approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据，约束决定不改无关文件。'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    ...Array.from({ length: 6 }, (_, i) => ({
      member: `Expert-${i + 3}`,
      role: 'expert',
      task: `整理第 ${i + 3} 份可独立验收的证据清单`,
      qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
    })),
  ],
})
const leafAgent = (childId: string) => ({ session: { id: childId, header: { parentSession: 'child-leader', cwd: '/tmp/t8-cwd' } }, options: { provider: 'qw', model: QWEN } })
const doneOutcome = (text: string) => ({ stopReason: 'completed', output: [{ type: 'text', text }] })
const rowOf = (record: any) => record.statuses[0]

async function dispatchTwo(f: any) {
  const review = await f.runtime.delegateTool(f.leaderAgent, { action: 'review', consolidation: consolidation() })
  assert.equal(review.ok, true, JSON.stringify(review))
  const r = await f.runtime.delegateTool(f.leaderAgent, { action: 'dispatch' })
  assert.equal(r.ok, true, JSON.stringify(r))
}

test('T8-1：dispatch 结算 done ⇒ 定向投递负责人会话 + completion 留痕 + report.sent + 纯文本通知 + 根 durable 回放；主行不受影响', async () => {
  const f = makeRuntime({}, '1')
  await dispatchTwo(f)
  f.spawned[0].resolveResult(doneOutcome('Expert-A 完成：实现已落盘并自测通过。'))
  await flush()
  // 定向投递：发送者=根 agent，目标=负责人会话（row.childId），正文含成员与 done。
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].agent, f.rootAgent, '发送者必须是根会话 agent（宿主 lineage 父→子）')
  assert.equal(f.sent[0].targetId, 'child-leader', '收件方必须是原分派负责人会话，不是根会话')
  assert.match(f.sent[0].text, /Expert-A/)
  assert.match(f.sent[0].text, /status=done/)
  // T5 契约留痕：kind='completion'，from 叶子 → to head，delivery sent。
  const journal = readDeptMessages('wp-t8-notice-1', { kind: 'completion' })
  assert.equal(journal.ok, true)
  const entries = journal.ok ? journal.messages : []
  assert.equal(entries.length, 1)
  assert.equal(entries[0].from.sessionId, 'member-1')
  assert.equal(entries[0].to.sessionId, 'child-leader')
  assert.equal(entries[0].to.role, 'head')
  assert.deepEqual(entries[0].data, { status: 'done' })
  assert.equal(entries[0].delivery.status, 'sent')
  // 幂等标记落台账（applyStatus 消毒后仍在）。
  const row = rowOf(f.record)
  assert.equal(row.delegates[0].status, 'done')
  assert.equal(row.delegates[0].report.state, 'sent')
  assert.ok(row.delegates[0].report.at > 0)
  assert.equal(row.delegates[1].report, undefined, '未结算成员不得带回报标记')
  // 负责人会话收到辅助纯文本通知（user/message 通道）。
  assert.ok(f.leaderEvents.some((e: any) => e.type === 'user/message' && /已完成并结算/.test(textOf(e))), '负责人会话必须有纯文本完成通知')
  // 根会话 durable 回放带 delegates[].report（刷新/重启不丢幂等标记）。
  /*
   * [3.0.0] 台账自 2.5.5 起合并落盘（缓冲 + 20s 定时器 + flush 时合并成
   * 「【进度归档】…」一条），因此断言不再依赖可见文本里的字面标记，改为
   * 直接核对 durable 载荷：kind=workplan-update 且携带 report 幂等标记。
   */
  flushPendingWorkplanUpdates(f.rootSession)
  const durableUpdates = f.rootEvents.filter((e: any) => e?.data?.source?.durable?.kind === 'workplan-update')
  assert.ok(
    durableUpdates.some((e: any) => JSON.stringify(e.data.source.durable).includes('"state":"sent"')),
    `根会话 durable update 必须携带 report 标记；实得 ${durableUpdates.length} 条`,
  )
  // 主行语义零改动：叶子通知不得把主行标成 reported（那是主计划/T9 通道）。
  assert.notEqual(row.closure, 'reported')
  assert.equal(row.report, undefined)
})

test('T8-2：幂等——已 sent 的成员在后续结算中不重报（每成员恰投递一次）', async () => {
  const f = makeRuntime({}, '2')
  await dispatchTwo(f)
  f.spawned[0].resolveResult(doneOutcome('Expert-A 完成。'))
  await flush()
  const firstAt = rowOf(f.record).delegates[0].report.at
  f.spawned[1].resolveResult(doneOutcome('Member-B 完成：证据清单已整理。'))
  await flush()
  assert.equal(f.sent.length, 2, '两个成员各投递一次，Expert-A 不得重报')
  assert.match(f.sent[1].text, /Member-B/)
  assert.equal(rowOf(f.record).delegates[0].report.at, firstAt, '已 sent 标记不得被后续结算覆盖')
  assert.equal(rowOf(f.record).delegates[1].report.state, 'sent')
})

test('T8-3：投递失败 ⇒ failed 留痕 + DELIVERY_FAILED 审计；下一次结算自动补发（只有 sent 拦重报）', async () => {
  const f = makeRuntime({ failDeliveryOnce: true }, '3')
  await dispatchTwo(f)
  f.spawned[0].resolveResult(doneOutcome('Expert-A 完成。'))
  await flush()
  const row = rowOf(f.record)
  assert.equal(row.delegates[0].status, 'done', '投递失败不得回滚完成判定')
  assert.equal(row.delegates[0].report.state, 'failed')
  assert.ok(f.record.errors.some((line: string) => /DELIVERY_FAILED/.test(line)), '失败必须显式审计留痕')
  const journal = readDeptMessages('wp-t8-notice-3', { kind: 'completion' })
  const entries = journal.ok ? journal.messages : []
  assert.equal(entries[0].delivery.status, 'failed')
  assert.equal(entries[0].delivery.code, 'DELIVERY_FAILED')
  // 兜底补发：Member-B 结算时把 failed 的 Expert-A 一并补发（failed 可重试）。
  f.spawned[1].resolveResult(doneOutcome('Member-B 完成。'))
  await flush()
  assert.equal(rowOf(f.record).delegates[0].report.state, 'sent', 'failed 条目必须在下一次结算补发为 sent')
  assert.equal(f.sent.length, 2, '补发后两成员各一条投递（失败尝试不计入成功投递）')
  assert.match(f.sent[0].text, /Expert-A/, '第一条成功投递是 Expert-A 的补发（按台账顺序）')
  assert.match(f.sent[1].text, /Member-B/)
})

test('T8-4：done-only——failed 叶子不产生完成通知', async () => {
  const f = makeRuntime({}, '4')
  await dispatchTwo(f)
  f.spawned[0].resolveResult({ stopReason: 'error', diagnostic: '模拟执行失败', output: [] })
  await flush()
  assert.equal(rowOf(f.record).delegates[0].status, 'failed')
  assert.equal(f.sent.length, 0, 'failed 叶子不得投递完成汇报')
  const journal = readDeptMessages('wp-t8-notice-4', { kind: 'completion' })
  assert.equal((journal.ok ? journal.messages : []).length, 0)
})

test('T8-5：待指示优先——escalation 挂起的叶子结算不得覆盖成 done，也不通知', async () => {
  const f = makeRuntime({}, '5')
  await dispatchTwo(f)
  const row = rowOf(f.record)
  const escalated = row.delegates.map((d: any, i: number) => (i === 0
    ? { ...d, escalation: { question: '需要负责人拍板方向', options: [], needs: [], at: Date.now(), delivery: 'sent' } }
    : d))
  f.record.statuses = applyStatus(f.record.statuses, 'T1', { delegates: escalated, revision: Number(row.revision ?? 0) + 1, updatedBy: 'child' })
  f.spawned[0].resolveResult(doneOutcome('Expert-A 回合结束（请示未答复）。'))
  await flush()
  assert.equal(rowOf(f.record).delegates[0].status, 'running', 'escalation 挂起不得被结算覆盖')
  assert.ok(rowOf(f.record).delegates[0].escalation, '请示子对象保留')
  assert.equal(f.sent.length, 0, '待指示叶子不产生完成通知')
})

test('T8-6：selfEffort 接续结算同款路由到负责人会话（第二处接线）', async () => {
  const f = makeRuntime({}, '6')
  await dispatchTwo(f)
  const r = await f.runtime.delegateTool(
    leafAgent('member-1'),
    {
      action: 'self_effort',
      reasoningEffort: 'medium',
      complexityRationale: '单点路由扩展，中等复杂度',
      deepThink: MAIN_DEEP_THINK_FIXTURE,
      // [2.3.0][T6] 开工前预估硬门禁：self_effort 必须携带 timeNotice。
      timeNotice: { declaredMinutes: 5, reason: '单点接线并自测' },
    },
    new AbortController().signal,
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  // [3.0.0] 复杂档 8 名专家：dispatch 派生 8 个叶子，接续再派生第 9 个激活。
  assert.equal(f.spawned.length, 9, '接续必须新派生 phase-1 激活')
  f.spawned[8].resolveResult(doneOutcome('Expert-A phase-1 完成。'))
  await flush()
  /*
   * [3.0.0] self_effort 登记本身会向负责人投递一条「预估上报」通知，因此 sent
   * 不再是恰好 1 条；断言改为「存在且仅一条来自 Expert-A 的完成汇报」，语义不变。
   */
  const completionSends = f.sent.filter((item: any) => /status=done/.test(item.text) && /Expert-A/.test(item.text))
  assert.equal(completionSends.length, 1, '接续结算必须恰投递一条 Expert-A 完成汇报')
  assert.equal(completionSends[0].targetId, 'child-leader', '接续结算的收件方同样是原分派负责人会话')
  assert.equal(rowOf(f.record).delegates[0].report.state, 'sent')
})

test('T8-7：[D2 同步] delegates 消毒上限 12（8 人不截断）+ report 子对象消毒持久化', () => {
  const plan = makePlan('7')
  let statuses: any = createStatuses(plan)
  const eight = Array.from({ length: 8 }, (_, i) => ({
    member: `M${i + 1}`, role: 'expert', task: `任务 ${i + 1}`, effort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
    childId: `child-${i + 1}`, status: 'done', summary: `摘要 ${i + 1}`,
    startedAt: 1000, finishedAt: 2000,
    ...(i === 0 ? { report: { state: 'sent', at: 3000, ref: 'wp-t8-notice:0', turn: 2 } } : {}),
  }))
  statuses = applyStatus(statuses, 'T1', { delegates: eight, revision: 1, updatedBy: 'system' })
  assert.equal(statuses[0].delegates.length, 8, '8 名下属结算不得被截掉（slice 上限须 ≥12）')
  assert.deepEqual(statuses[0].delegates[0].report, { state: 'sent', at: 3000, ref: 'wp-t8-notice:0', turn: 2 })
  // 非法 report 形状整体丢弃（fail-closed），不入库脏值。
  const bad = [{ member: 'X', role: 'expert', task: '读取目标文件并写出一份结论', effort: 'low', childId: 'c', status: 'done', report: { state: 'bogus', at: 1 }, qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }]
  const cleaned = applyStatus(statuses, 'T1', { delegates: bad, revision: 2, updatedBy: 'system' })
  assert.equal(cleaned[0].delegates[0].report, undefined)
})

/* ------------------------------------------------------------------ */
/* T8-8 并发竞态治本回归：同一 tick 8 个结算回调，不 await 中间 tick      */
/* ------------------------------------------------------------------ */

const consolidation8 = () => ({
  problemAnalysis: ['现状：任务拆给八名专家与组员；目标是保质保量完成；约束是不改无关文件；边界是只做分内工作；主要矛盾是并发结算不得重复投递。'],
  approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测；七名组员分别整理证据清单并逐条核对验收，最后统一汇总。'],
  approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据，约束决定不改无关文件。'],
  taskReasoningEffort: 'medium',
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    ...Array.from({ length: 7 }, (_, i) => ({ member: `Member-${i + 2}`, role: 'expert', task: `整理证据清单第 ${i + 2} 份`, reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] })),
  ],
})

test('T8-8：同一 tick 连续触发 8 个结算回调 ⇒ 恰 8 次投递、8 条留痕、每成员恰一条、结算互不覆盖（竞态治本）', async () => {
  const f = makeRuntime({}, '8')
  await f.runtime.delegateTool(f.leaderAgent, { action: 'review', consolidation: consolidation8() })
  const r = await f.runtime.delegateTool(f.leaderAgent, { action: 'dispatch' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(f.spawned.length, 8, '复杂任务 8 人分工必须全部派生')
  // 同一 tick 内连续触发 8 个结算：不 await 任何中间 tick（旧实现此处重复投递）。
  for (let i = 0; i < f.spawned.length; i += 1) {
    f.spawned[i].resolveResult(doneOutcome(`成员 ${i + 1} 完成：产物已落盘。`))
  }
  await flush()
  await flush()
  // 恰 8 次 sendMessage，每成员恰一条。
  assert.equal(f.sent.length, 8, '8 人=恰 8 条投递，并发不得重复')
  const sendCounts = new Map<string, number>()
  for (const s of f.sent) {
    const name = s.text.match(/【第三层完成汇报｜(.+?) → 部门负责人】/)?.[1] ?? '?'
    sendCounts.set(name, (sendCounts.get(name) ?? 0) + 1)
  }
  assert.equal(sendCounts.size, 8)
  for (const [name, count] of sendCounts) assert.equal(count, 1, `${name} 恰一条投递`)
  // 恰 8 条 completion 留痕，每成员恰一条，全部 to=负责人。
  const journal = readDeptMessages('wp-t8-notice-8', { kind: 'completion' })
  const entries = journal.ok ? journal.messages : []
  assert.equal(entries.length, 8, '8 人=恰 8 条留痕')
  const journalCounts = new Map<string, number>()
  for (const e of entries) {
    assert.equal(e.to.sessionId, 'child-leader')
    const name = String(e.from.member ?? '')
    journalCounts.set(name, (journalCounts.get(name) ?? 0) + 1)
  }
  for (const [name, count] of journalCounts) assert.equal(count, 1, `${name} 恰一条留痕`)
  // 8 个结算与 8 个标记全部保留（入口快照写回会互相覆盖——lost update 回归）。
  const row = rowOf(f.record)
  assert.equal(row.delegates.length, 8)
  for (const d of row.delegates) {
    assert.equal(d.status, 'done', `${d.member} 结算不得被并发写回覆盖`)
    assert.equal(d.report?.state, 'sent', `${d.member} 幂等标记必须落台账`)
  }
})
