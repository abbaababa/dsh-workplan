/*
 * [T5-channel] 叶子↔部门负责人双向请示/指示通道回归（冻结契约 v1）。
 *
 * 唯一权威契约：_t5_channel_20261112/00-contract-v1.md（FROZEN）。
 * 本文件把契约 §3a/§3b/§3c/§4 钉在可复核边界上：
 *   1. 上行：叶子 escalate 经 delegate 登记反查部门行，ctx.subagents.sendMessage
 *      投给负责人会话 row.childId；kind='escalation' 留痕；delegates[i].escalation
 *      子对象持久化 + durable update 到根会话；负责人行不得被置 blocked/escalated。
 *   2. 下行：负责人 instruct（member/sessionId 至少其一）投递给叶子；
 *      kind='instruction' 留痕（data.inReplyTo）；delegates[i].lastInstruction
 *      持久化并清 escalation；latencyMs 可观测；负责人行 closure 不变。
 *   3. 授权负例：非根非负责人 → NOT_ROOT；未登记目标 → NOT_DELEGATE/UNKNOWN_MEMBER；
 *      缺目标 → MISSING_TARGET；非直接子会话 → NOT_DIRECT_CHILD；跨行 subtaskId → UNKNOWN_SUBTASK。
 *   4. 投递失败 → DELIVERY_FAILED + failed 留痕，不伪造状态；留痕写失败不掩盖投递结果。
 *   5. 根路径（第一层 escalate/instruct）语义零回归。
 *   6. applyStatus→buildUpdateMessage→reconstructFromSession 回放保留子对象（治本）。
 *
 * 并发纪律（契约 §6）：留痕目录 env DSH_WORKPLAN_JOURNAL_DIR 指向工作区临时目录，
 * 测后清理；不依赖真实宿主投递。
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyStatus, buildPlanMessage, buildUpdateMessage, createStatuses, parseUpdateMessage } from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { readDeptMessages } from '../src/dept-journal.js'

const ROOT = 'session-root'
const HEAD = 'child-leader'
const HEAD2 = 'child-leader-2'
const LEAF1 = 'leaf-1'
const LEAF2 = 'leaf-2'
const LEAF3 = 'leaf-3'

let journalDir = ''
let prevJournalEnv: string | undefined

before(() => {
  prevJournalEnv = process.env.DSH_WORKPLAN_JOURNAL_DIR
  journalDir = mkdtempSync(join(process.cwd(), '.dept-channel-journal-'))
  process.env.DSH_WORKPLAN_JOURNAL_DIR = journalDir
})

after(() => {
  if (prevJournalEnv === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = prevJournalEnv
  if (journalDir) rmSync(journalDir, { recursive: true, force: true })
})

function makePlan(planId: string) {
  return {
    version: 1,
    planId,
    title: '双向通道回归',
    sessionId: ROOT,
    createdTurn: 1,
    createdAt: 1000,
    contradictions: { primary: { statement: '通道契约冻结与并发双写的矛盾', evidence: [], whyPrimary: '测试夹具主要矛盾' } },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '通道',
      rationale: '',
      checkpoint: '',
      subtasks: [
        { id: 'T1', title: '部门任务一', department: 'engineering', role: '负责人', objective: 'o', method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [] },
        { id: 'T2', title: '部门任务二', department: 'design', role: '负责人', objective: 'o', method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [] },
      ],
    }],
  }
}

function fakeSession(id: string, parentId: string | null, catalog: string[] = []) {
  const events: any[] = catalog.map((childId) => ({ type: 'subagent/catalog', data: { childId } }))
  return {
    id,
    header: { createdAt: 1000, ...(parentId ? { parentSession: parentId } : {}) },
    events,
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
  }
}

function delegate(member: string, role: string, childId: string) {
  return { member, role, task: '单一目标任务', effort: 'medium', childId, status: 'running', summary: '', error: null, startedAt: 1000, finishedAt: null }
}

function makeFixture(planId: string, opts: { headCatalog?: string[] } = {}) {
  const plan = makePlan(planId)
  const rootSession = fakeSession(ROOT, null, [HEAD, HEAD2])
  const headSession = fakeSession(HEAD, ROOT, opts.headCatalog ?? [LEAF1, LEAF2])
  const head2Session = fakeSession(HEAD2, ROOT, [LEAF3])
  const leaf1Session = fakeSession(LEAF1, HEAD)
  const leaf2Session = fakeSession(LEAF2, HEAD)
  const leaf3Session = fakeSession(LEAF3, HEAD2)
  const sessions: Record<string, any> = {
    [ROOT]: rootSession, [HEAD]: headSession, [HEAD2]: head2Session,
    [LEAF1]: leaf1Session, [LEAF2]: leaf2Session, [LEAF3]: leaf3Session,
  }
  const calls: any[] = []
  const fail = { value: false }
  const ctx: any = {
    logger: { warn() {}, info() {}, error() {} },
    sessions: { get: (id: string) => sessions[id], list: () => Object.values(sessions) },
    subagents: {
      sendMessage: async (agent: any, targetId: string, content: any[]) => {
        calls.push({ from: agent?.session?.id, targetId, text: String(content?.[0]?.text ?? '') })
        if (fail.value) throw new Error('投递失败：测试注入')
        return `msg-${calls.length}`
      },
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = HEAD
  statuses[0].delegates = [delegate('专家甲', 'expert', LEAF1), delegate('组员乙', 'member', LEAF2)]
  statuses[1].status = 'in_progress'
  statuses[1].childId = HEAD2
  statuses[1].delegates = [delegate('跨部门丙', 'expert', LEAF3)]
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set(ROOT, record)
  return {
    runtime, record, ctx, calls, fail, plan,
    rootSession, headSession,
    rootAgent: { session: rootSession },
    leaderAgent: { session: headSession },
    leader2Agent: { session: head2Session },
    leaf1Agent: { session: leaf1Session },
    leaf2Agent: { session: leaf2Session },
    leaf3Agent: { session: leaf3Session },
  }
}

function rowOf(fixture: any, subtaskId = 'T1') {
  return fixture.record.statuses.find((item: any) => item.subtaskId === subtaskId)
}

function journal(planId: string, kind: 'escalation' | 'instruction') {
  const read = readDeptMessages(planId, { kind })
  assert.equal(read.ok, true, JSON.stringify(read))
  return (read as any).messages
}

/* ------------------------------------------------------------------ *
 * 1. 上行：叶子 → 负责人（契约 §3a）
 * ------------------------------------------------------------------ */

test('上行：叶子 escalate 经 sendMessage 投给负责人＋escalation 留痕＋子对象持久化＋负责人行不 blocked', async () => {
  const f = makeFixture('wp-chan-esc1')
  const r = await f.runtime.escalateTool(f.leaf1Agent, {
    question: '接口选 A 还是 B？',
    options: ['A：复用既有通道', 'B：新建队列'],
    needs: ['需要数据部门提供样本'],
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.routedTo, 'head')
  assert.equal(r.planId, 'wp-chan-esc1')
  assert.equal(r.subtaskId, 'T1')
  assert.equal(r.member, '专家甲')
  assert.equal(typeof r.messageId, 'string')
  assert.ok(r.messageId.length > 0)
  // 投递目标 = 部门行 childId（负责人会话），不是根会话。
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].targetId, HEAD)
  assert.ok(f.calls[0].text.includes('接口选 A 还是 B？'))
  // 负责人行本身不得被置 blocked/escalated。
  const row = rowOf(f)
  assert.equal(row.status, 'in_progress')
  assert.ok(row.closure !== 'escalated' && row.closure !== 'blocked', '负责人行不得被置 blocked/escalated（初始 closure 保持不变）')
  // delegates[i].escalation 子对象（契约形状）。
  const entry = row.delegates.find((d: any) => d.member === '专家甲')
  assert.ok(entry.escalation, 'escalation 子对象必须持久化')
  assert.equal(entry.escalation.question, '接口选 A 还是 B？')
  assert.equal(entry.escalation.delivery, 'sent')
  assert.equal(entry.escalation.messageId, r.messageId)
  assert.ok(entry.escalation.at > 0)
  assert.deepEqual(entry.escalation.options, ['A：复用既有通道', 'B：新建队列'])
  assert.deepEqual(entry.escalation.needs, ['需要数据部门提供样本'])
  assert.equal(entry.status, 'running', '成员会话仍在等待指示，不得被置 blocked')
  // durable update 到根会话（回放不丢）。
  assert.ok(f.rootSession.events.some((e: any) => e.type === 'user/message'), '根会话必须收到 durable workplan-update')
  // 留痕 kind='escalation'（from 叶子 → to head）。
  const messages = journal('wp-chan-esc1', 'escalation')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].from.sessionId, LEAF1)
  assert.equal(messages[0].from.role, 'expert')
  assert.equal(messages[0].from.member, '专家甲')
  assert.equal(messages[0].to.sessionId, HEAD)
  assert.equal(messages[0].to.role, 'head')
  assert.equal(messages[0].subtaskId, 'T1')
  assert.equal(messages[0].delivery.status, 'sent')
  assert.deepEqual(messages[0].data?.options, ['A：复用既有通道', 'B：新建队列'])
})

test('上行幂等：同一叶子重复 escalate 不重复投递（alreadyEscalated）', async () => {
  const f = makeFixture('wp-chan-esc2')
  const first = await f.runtime.escalateTool(f.leaf1Agent, { question: '第一次请示' })
  assert.equal(first.ok, true)
  const second = await f.runtime.escalateTool(f.leaf1Agent, { question: '重复请示' })
  assert.equal(second.ok, true)
  assert.equal(second.alreadyEscalated, true)
  assert.equal(f.calls.length, 1, '重复请示不得再次投递')
})

test('上行血缘未登记：维持原 NO_PLAN 文案（不吞错、不伪造路由）', async () => {
  const f = makeFixture('wp-chan-esc3')
  const strangerLeaf = { session: fakeSession('leaf-unknown', HEAD) }
  const r = await f.runtime.escalateTool(strangerLeaf, { question: '未登记叶子的请示' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_PLAN')
  assert.equal(f.calls.length, 0)
})

/* ------------------------------------------------------------------ *
 * 2. 下行：负责人 → 叶子（契约 §3b）
 * ------------------------------------------------------------------ */

test('下行：head instruct(member) 投递叶子＋lastInstruction 持久化＋清 escalation＋latencyMs＋instruction 留痕(inReplyTo)', async () => {
  const f = makeFixture('wp-chan-ins1')
  const esc = await f.runtime.escalateTool(f.leaf1Agent, { question: '选 A 还是 B？' })
  assert.equal(esc.ok, true)
  const escJournal = journal('wp-chan-ins1', 'escalation')
  const r = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T1', member: '专家甲', instruction: '按 A 执行，保留既有边界' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.planId, 'wp-chan-ins1')
  assert.equal(r.subtaskId, 'T1')
  assert.equal(r.member, '专家甲')
  assert.equal(r.sessionId, LEAF1)
  assert.equal(typeof r.messageId, 'string')
  assert.ok(r.messageId.length > 0)
  assert.equal(typeof r.latencyMs, 'number')
  assert.ok(r.latencyMs >= 0)
  // 投递目标 = 叶子会话。
  assert.equal(f.calls[f.calls.length - 1].targetId, LEAF1)
  assert.ok(f.calls[f.calls.length - 1].text.includes('按 A 执行'))
  const row = rowOf(f)
  const entry = row.delegates.find((d: any) => d.member === '专家甲')
  assert.ok(entry.lastInstruction, 'lastInstruction 子对象必须持久化')
  assert.equal(entry.lastInstruction.text, '按 A 执行，保留既有边界')
  assert.equal(entry.lastInstruction.delivery, 'sent')
  assert.equal(entry.lastInstruction.messageId, r.messageId)
  assert.ok(entry.lastInstruction.at > 0)
  assert.ok(!entry.escalation, '已答复的 escalation 必须被清除')
  // 负责人行 closure 不变。
  assert.equal(row.status, 'in_progress')
  assert.ok(row.closure !== 'escalated' && row.closure !== 'blocked', '负责人行不得被置 blocked/escalated（初始 closure 保持不变）')
  // 留痕 kind='instruction'，data.inReplyTo 指向被答复的 escalation 消息 id。
  const insJournal = journal('wp-chan-ins1', 'instruction')
  assert.equal(insJournal.length, 1)
  assert.equal(insJournal[0].from.sessionId, HEAD)
  assert.equal(insJournal[0].from.role, 'head')
  assert.equal(insJournal[0].to.sessionId, LEAF1)
  assert.equal(insJournal[0].to.role, 'expert')
  assert.equal(insJournal[0].to.member, '专家甲')
  assert.equal(insJournal[0].delivery.status, 'sent')
  assert.equal(insJournal[0].data?.inReplyTo, escJournal[0].id)
})

test('下行：sessionId 目标可用；subtaskId 省略时默认负责人自己的行', async () => {
  const f = makeFixture('wp-chan-ins2')
  const bySession = await f.runtime.instructTool(f.leaderAgent, { sessionId: LEAF1, instruction: '按 sessionId 投递' })
  assert.equal(bySession.ok, true, JSON.stringify(bySession))
  assert.equal(bySession.sessionId, LEAF1)
  assert.equal(bySession.subtaskId, 'T1')
  const withRow = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T1', sessionId: LEAF2, instruction: '给组员乙' })
  assert.equal(withRow.ok, true, JSON.stringify(withRow))
  assert.equal(withRow.member, '组员乙')
  assert.equal(withRow.sessionId, LEAF2)
})

/* ------------------------------------------------------------------ *
 * 3. 授权负例（契约 §3b/§4：非直系一律拒绝）
 * ------------------------------------------------------------------ */

test('授权负例：非根非负责人 → NOT_ROOT', async () => {
  const f = makeFixture('wp-chan-neg1')
  const stranger = { session: fakeSession('stranger', ROOT) }
  const r = await f.runtime.instructTool(stranger, { subtaskId: 'T1', member: '专家甲', instruction: '越权' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_ROOT')
  assert.equal(f.calls.length, 0)
})

test('授权负例：缺 member/sessionId → MISSING_TARGET；未知成员 → UNKNOWN_MEMBER', async () => {
  const f = makeFixture('wp-chan-neg2')
  const missing = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T1', instruction: '无目标' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'MISSING_TARGET')
  const unknown = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T1', member: '不存在', instruction: 'x' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'UNKNOWN_MEMBER')
  assert.equal(f.calls.length, 0)
})

test('授权负例：跨部门目标（登记在他行 delegates）→ NOT_DELEGATE；member/sessionId 不一致 → NOT_DELEGATE', async () => {
  const f = makeFixture('wp-chan-neg3')
  const cross = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T1', sessionId: LEAF3, instruction: '跨部门' })
  assert.equal(cross.ok, false)
  assert.equal(cross.code, 'NOT_DELEGATE')
  const mismatch = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T1', member: '专家甲', sessionId: LEAF2, instruction: '不一致' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'NOT_DELEGATE')
  assert.equal(f.calls.length, 0)
})

test('授权负例：subtaskId 不是自己的行 → UNKNOWN_SUBTASK；目标不在直接子会话 catalog → NOT_DIRECT_CHILD', async () => {
  const f = makeFixture('wp-chan-neg4')
  const wrongRow = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T2', member: '跨部门丙', instruction: 'x' })
  assert.equal(wrongRow.ok, false)
  assert.equal(wrongRow.code, 'UNKNOWN_SUBTASK')
  // head 的 catalog 只登记 leaf-1：组员乙（leaf-2）不是直接子会话证据 ⇒ 拒绝。
  const g = makeFixture('wp-chan-neg5', { headCatalog: [LEAF1] })
  const notDirect = await g.runtime.instructTool(g.leaderAgent, { subtaskId: 'T1', member: '组员乙', instruction: 'x' })
  assert.equal(notDirect.ok, false)
  assert.equal(notDirect.code, 'NOT_DIRECT_CHILD')
  assert.equal(g.calls.length, 0)
})

/* ------------------------------------------------------------------ *
 * 4. 投递失败与留痕失败（契约 §4：显式报错，绝不静默）
 * ------------------------------------------------------------------ */

test('投递失败：escalate → DELIVERY_FAILED＋failed 留痕＋escalation.delivery=failed，不伪造已上报', async () => {
  const f = makeFixture('wp-chan-fail1')
  f.fail.value = true
  const r = await f.runtime.escalateTool(f.leaf1Agent, { question: '投递会失败' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DELIVERY_FAILED')
  const entry = rowOf(f).delegates.find((d: any) => d.member === '专家甲')
  assert.equal(entry.escalation?.delivery, 'failed')
  const messages = journal('wp-chan-fail1', 'escalation')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].delivery.status, 'failed')
  assert.equal(rowOf(f).status, 'in_progress', '负责人行不得被置 blocked')
})

test('D6 重试：escalate 投递失败后可重新投递（failed 不走幂等分支），成功后恢复幂等拦截', async () => {
  const f = makeFixture('wp-chan-retry')
  f.fail.value = true
  const first = await f.runtime.escalateTool(f.leaf1Agent, { question: '首次投递失败' })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'DELIVERY_FAILED')
  f.fail.value = false
  const retry = await f.runtime.escalateTool(f.leaf1Agent, { question: '失败后重试' })
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(retry.routedTo, 'head')
  assert.ok(!retry.alreadyEscalated, 'failed 请示不得被幂等分支拦截（D6 重试语义）')
  assert.equal(f.calls.length, 2, '重试必须真实重新投递')
  assert.equal(f.calls[1].targetId, HEAD)
  const entry = rowOf(f).delegates.find((d: any) => d.member === '专家甲')
  assert.equal(entry.escalation.delivery, 'sent')
  assert.equal(entry.escalation.question, '失败后重试')
  const messages = journal('wp-chan-retry', 'escalation')
  assert.equal(messages.length, 2, '失败与重试都必须留痕（追加式审计，不静默丢弃）')
  assert.equal(messages[0].delivery.status, 'failed')
  assert.equal(messages[1].delivery.status, 'sent')
  const third = await f.runtime.escalateTool(f.leaf1Agent, { question: '第三次重复' })
  assert.equal(third.ok, true)
  assert.equal(third.alreadyEscalated, true, '成功送达后恢复幂等拦截')
  assert.equal(f.calls.length, 2)
})

test('投递失败：instruct → DELIVERY_FAILED＋failed 留痕，lastInstruction 不伪造、escalation 不清除', async () => {
  const f = makeFixture('wp-chan-fail2')
  const esc = await f.runtime.escalateTool(f.leaf1Agent, { question: '先请示' })
  assert.equal(esc.ok, true)
  f.fail.value = true
  const r = await f.runtime.instructTool(f.leaderAgent, { subtaskId: 'T1', member: '专家甲', instruction: '投递会失败' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DELIVERY_FAILED')
  const entry = rowOf(f).delegates.find((d: any) => d.member === '专家甲')
  assert.ok(!entry.lastInstruction, '投递失败不得伪造 lastInstruction')
  assert.ok(entry.escalation, '投递失败不得清除 escalation')
  const messages = journal('wp-chan-fail2', 'instruction')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].delivery.status, 'failed')
})

test('留痕写失败不掩盖投递结果：两者都报（ok:true + journal.JOURNAL_WRITE_FAILED）', async () => {
  const f = makeFixture('wp-chan-jfail')
  const blocker = join(journalDir, 'blocker-file')
  writeFileSync(blocker, 'x', 'utf8')
  const saved = process.env.DSH_WORKPLAN_JOURNAL_DIR
  process.env.DSH_WORKPLAN_JOURNAL_DIR = blocker
  try {
    const r = await f.runtime.escalateTool(f.leaf1Agent, { question: '留痕会失败但投递成功' })
    assert.equal(r.ok, true, '投递成功不得被留痕失败掩盖')
    assert.equal(r.routedTo, 'head')
    assert.ok(r.journal && r.journal.ok === false, '留痕失败必须显式上报')
    assert.equal(r.journal.code, 'JOURNAL_WRITE_FAILED')
  } finally {
    process.env.DSH_WORKPLAN_JOURNAL_DIR = saved
  }
})

/* ------------------------------------------------------------------ *
 * 5. 根路径回归（第一层语义零改动）
 * ------------------------------------------------------------------ */

test('根路径回归：root instruct 仍按 closure=escalated 行投递并恢复 in_progress/instructed', async () => {
  const f = makeFixture('wp-chan-root1')
  const row = rowOf(f)
  row.status = 'blocked'
  row.closure = 'escalated'
  row.question = '部门请示'
  const r = await f.runtime.instructTool(f.rootAgent, { subtaskId: 'T1', instruction: '继续执行' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.status, 'in_progress')
  assert.equal(r.closure, 'instructed')
  assert.equal(f.calls[f.calls.length - 1].targetId, HEAD)
})

test('根路径回归：二级（负责人→主 Agent）escalate 仍把部门行置 blocked/escalated', async () => {
  const f = makeFixture('wp-chan-root2')
  const r = await f.runtime.escalateTool(f.leaderAgent, { question: '负责人向主 Agent 请示' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.status, 'blocked')
  assert.equal(r.closure, 'escalated')
  assert.equal(r.routedTo, undefined, '第一层返回形状不得被叶子路由污染')
  const row = rowOf(f)
  assert.equal(row.status, 'blocked')
  assert.equal(row.closure, 'escalated')
  assert.equal(row.question, '负责人向主 Agent 请示')
})

/* ------------------------------------------------------------------ *
 * 6. 持久化回放与消毒（契约 §3c：治本关键）
 * ------------------------------------------------------------------ */

test('持久化：applyStatus→buildUpdateMessage→reconstructFromSession 保留 escalation/lastInstruction 子对象', () => {
  const plan = makePlan('wp-chan-replay')
  const session = fakeSession(ROOT, null)
  session.append('user/message', buildPlanMessage(plan))
  const delegates = [
    {
      ...delegate('专家甲', 'expert', LEAF1),
      escalation: { question: '回放不丢的请示', options: ['A'], needs: [], at: 1500, messageId: 'msg-9', delivery: 'sent' },
      lastInstruction: { text: '回放不丢的指示', at: 1600, messageId: 'msg-10', delivery: 'sent' },
    },
  ]
  const statuses = applyStatus(createStatuses(plan), 'T1', { status: 'in_progress', delegates, revision: 2 })
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId, subtaskId: 'T1', status: 'in_progress', delegates: statuses[0].delegates, revision: 2,
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.ok(rebuilt?.plan, '必须能重建计划')
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  const entry = row.delegates.find((d: any) => d.member === '专家甲')
  assert.equal(entry.escalation?.question, '回放不丢的请示', 'escalation 子对象回放不得丢失')
  assert.equal(entry.escalation?.delivery, 'sent')
  assert.equal(entry.escalation?.messageId, 'msg-9')
  assert.equal(entry.lastInstruction?.text, '回放不丢的指示', 'lastInstruction 子对象回放不得丢失')
  assert.equal(entry.lastInstruction?.messageId, 'msg-10')
})

test('消毒：非法子对象 fail-closed 丢弃；超限字段截断（不入库脏值）', () => {
  const plan = makePlan('wp-chan-sanitize')
  const base = delegate('专家甲', 'expert', LEAF1)
  const statuses = applyStatus(createStatuses(plan), 'T1', {
    delegates: [
      { ...base, escalation: { question: 'q', at: 1500, delivery: 'bogus' } },
    ],
  })
  assert.ok(!statuses[0].delegates[0].escalation, '非法 delivery 枚举必须丢弃整个子对象')
  const statuses2 = applyStatus(createStatuses(plan), 'T1', {
    delegates: [
      { ...base, escalation: { question: 'q', at: -5, delivery: 'sent' } },
    ],
  })
  assert.ok(!statuses2[0].delegates[0].escalation, '非法 at（≤0）必须丢弃整个子对象')
  const statuses3 = applyStatus(createStatuses(plan), 'T1', {
    delegates: [
      {
        ...base,
        escalation: { question: 'q'.repeat(5000), at: 1500, delivery: 'sent' },
        lastInstruction: { text: 't', at: 1600, delivery: 'sent', messageId: 'x'.repeat(300) },
      },
    ],
  })
  const entry = statuses3[0].delegates[0]
  assert.equal(entry.escalation.question.length, 4000, 'question 超限截断 4000')
  assert.equal(entry.lastInstruction.messageId.length, 200, 'messageId 超限截断 200')
})

/* ------------------------------------------------------------------ *
 * 7. 真实 delegate 派发链路（合并自 workplan-leaf-escalate-instruct.test.ts，
 *    断言对齐契约 v1 子对象形状；原扁平字段用例已废弃，不留两套契约）
 * ------------------------------------------------------------------ */

const consolidation = {
  problemAnalysis: ['现状：需要把部门任务拆给专家与组员；目标是保质保量完成；约束是不改无关文件；主要矛盾是质量与时间。', '主要矛盾：质量与时间'],
  constraints: ['不得改动无关文件'],
  unknowns: [],
  approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测', '组员做自测：逐条核对验收标准并落盘留证'],
  approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据。'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'medium' },
    { member: 'Member-B', role: 'member', task: '补充回归用例', reasoningEffort: 'low' },
  ],
}

async function dispatched(planId: string) {
  const plan = makePlan(planId)
  const rootSession = fakeSession(ROOT, null, [HEAD, HEAD2])
  const leaderSession = fakeSession(HEAD, ROOT, ['member-1', 'member-2'])
  const leader2Session = fakeSession(HEAD2, ROOT)
  const leaf1 = fakeSession('member-1', HEAD)
  const leaf2 = fakeSession('member-2', HEAD)
  const sessions: Record<string, any> = {
    [ROOT]: rootSession, [HEAD]: leaderSession, [HEAD2]: leader2Session,
    'member-1': leaf1, 'member-2': leaf2,
  }
  const sent: any[] = []
  const spawned: any[] = []
  let sendMessageFails = false
  const ctx: any = {
    logger: { warn() {} },
    sessions: { get: (id: string) => sessions[id], list: () => Object.values(sessions), eventAt: () => undefined },
    subagents: {
      startActivation: async (request: any) => {
        const childId = `member-${spawned.length + 1}`
        let resolveResult: any
        const result = new Promise((resolve) => { resolveResult = resolve })
        spawned.push({ childId, request, resolveResult })
        return { childId, result, dispose: async () => {} }
      },
      sendMessage: async (agent: any, childId: string, content: any[]) => {
        if (sendMessageFails) throw new Error('模拟投递失败')
        sent.push({ agent, childId, text: content?.[0]?.text ?? '' })
        return `msg-${sent.length}`
      },
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = HEAD
  statuses[1].status = 'in_progress'
  statuses[1].childId = HEAD2
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set(ROOT, record)
  const leaderAgent = { session: leaderSession, options: { provider: 'qw', model: 'qwen3.8-flash' } }
  const leader2Agent = { session: leader2Session, options: { provider: 'qw', model: 'qwen3.8-flash' } }
  const leaf1Agent = { session: leaf1, options: { provider: 'qw', model: 'qwen3.8-flash' } }
  const leaf2Agent = { session: leaf2, options: { provider: 'qw', model: 'qwen3.8-flash' } }
  const rootAgent = { session: rootSession, options: {} }
  const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation })
  assert.equal(review.ok, true, JSON.stringify(review))
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  return {
    runtime, record, rootSession, leaderSession, sent, spawned,
    leaderAgent, leader2Agent, leaf1Agent, leaf2Agent, rootAgent,
    failDelivery: (fail: boolean) => { sendMessageFails = fail },
  }
}

const delegateOf = (harness: any, childId: string) =>
  harness.record.statuses[0].delegates.find((d: any) => d.childId === childId)

test('真实派发链路：叶子 escalate 经 delegate 登记路由到负责人（routedTo=head＋子对象＋留痕）', async () => {
  const h = await dispatched('wp-chan-real1')
  const r = await h.runtime.escalateTool(h.leaf1Agent, {
    subtaskId: 'T1',
    question: '需要负责人决定：接口用 v1 还是 v2？',
    options: ['v1', 'v2'],
    needs: ['需要研究部门提供接口文档'],
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.routedTo, 'head')
  assert.equal(r.member, 'Expert-A')
  assert.equal(r.subtaskId, 'T1')
  const entry = delegateOf(h, 'member-1')
  assert.equal(entry.escalation.question, '需要负责人决定：接口用 v1 还是 v2？')
  assert.deepEqual(entry.escalation.options, ['v1', 'v2'])
  assert.equal(entry.escalation.delivery, 'sent')
  assert.equal(entry.status, 'running', '请示期间成员不得被置 blocked')
  assert.equal(h.record.statuses[0].status, 'in_progress', '部门行不受影响')
  assert.notEqual(h.record.statuses[0].closure, 'escalated')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].childId, HEAD, '必须投给负责人会话')
  const durable = h.rootSession.events.filter((e: any) => e.type === 'user/message' && /workplan-update/.test(JSON.stringify(e.data)))
  assert.ok(durable.length >= 1, '请示必须写 durable workplan-update')
  const messages = journal('wp-chan-real1', 'escalation')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].from.member, 'Expert-A')
  assert.equal(messages[0].to.sessionId, HEAD)
})

test('真实派发链路：空 question 拒（INVALID_QUESTION）；重复请示幂等', async () => {
  const h = await dispatched('wp-chan-real2')
  const empty = await h.runtime.escalateTool(h.leaf2Agent, { question: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'INVALID_QUESTION')
  const first = await h.runtime.escalateTool(h.leaf1Agent, { question: '用哪个版本？' })
  assert.equal(first.ok, true)
  const again = await h.runtime.escalateTool(h.leaf1Agent, { question: '用哪个版本？' })
  assert.equal(again.ok, true)
  assert.equal(again.alreadyEscalated, true)
})

test('待指示优先于结算：叶子请示后结束回合，结算不得覆盖成 done/failed', async () => {
  const h = await dispatched('wp-chan-real3')
  await h.runtime.escalateTool(h.leaf1Agent, { question: '等负责人拍板' })
  h.spawned[0].resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: '回合结束' }] })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const entry = delegateOf(h, 'member-1')
  assert.ok(entry.escalation, 'escalation 子对象不得被结算覆盖')
  assert.equal(entry.escalation.question, '等负责人拍板')
  assert.notEqual(entry.status, 'done')
  assert.notEqual(entry.status, 'failed')
})

test('多成员同时请示：缺目标 MISSING_TARGET；member 消歧只答复指定成员', async () => {
  const h = await dispatched('wp-chan-real4')
  await h.runtime.escalateTool(h.leaf1Agent, { question: '专家卡住了' })
  await h.runtime.escalateTool(h.leaf2Agent, { question: '组员卡住了' })
  const missing = await h.runtime.instructTool(h.leaderAgent, { subtaskId: 'T1', instruction: '继续' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'MISSING_TARGET')
  const picked = await h.runtime.instructTool(h.leaderAgent, { subtaskId: 'T1', member: 'Member-B', instruction: '先补用例' })
  assert.equal(picked.ok, true, JSON.stringify(picked))
  // 2 次 escalate（投 HEAD）＋1 次指定 instruct（投 member-2）＝3；MISSING_TARGET 不投递。
  assert.equal(h.sent.length, 3)
  assert.equal(h.sent[0].childId, HEAD)
  assert.equal(h.sent[1].childId, HEAD)
  assert.equal(h.sent[2].childId, 'member-2')
  assert.ok(delegateOf(h, 'member-2').lastInstruction)
  assert.ok(!delegateOf(h, 'member-2').escalation)
  assert.ok(delegateOf(h, 'member-1').escalation, '未被指定的成员保持待指示')
})

test('越权（真实链路）：跨行 subtaskId → UNKNOWN_SUBTASK；他行叶子 → NOT_DELEGATE；叶子自答/孤儿 → NOT_ROOT', async () => {
  const h = await dispatched('wp-chan-real5')
  await h.runtime.escalateTool(h.leaf1Agent, { question: '卡住了' })
  const crossRow = await h.runtime.instructTool(h.leader2Agent, { subtaskId: 'T1', member: 'Expert-A', instruction: '继续' })
  assert.equal(crossRow.ok, false)
  assert.equal(crossRow.code, 'UNKNOWN_SUBTASK')
  const crossLeaf = await h.runtime.instructTool(h.leader2Agent, { subtaskId: 'T2', sessionId: 'member-1', instruction: '继续' })
  assert.equal(crossLeaf.ok, false)
  assert.equal(crossLeaf.code, 'NOT_DELEGATE')
  const self = await h.runtime.instructTool(h.leaf1Agent, { subtaskId: 'T1', member: 'Expert-A', instruction: '我自己答复自己' })
  assert.equal(self.ok, false)
  assert.equal(self.code, 'NOT_ROOT')
  const orphan = { session: { id: 'orphan', header: { parentSession: 'no-such-session' } }, options: {} }
  const noPlan = await h.runtime.instructTool(orphan, { subtaskId: 'T1', member: 'Expert-A', instruction: '继续' })
  assert.equal(noPlan.ok, false)
  assert.equal(noPlan.code, 'NOT_ROOT')
  // 唯一投递＝开场合法 escalate（投 HEAD）；4 次越权尝试全部零投递。
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].childId, HEAD)
})

test('根路径回归（真实链路）：第一层行未 escalated 时 root instruct 仍 NOT_ESCALATED', async () => {
  const h = await dispatched('wp-chan-real6')
  await h.runtime.escalateTool(h.leaf1Agent, { question: '叶子卡住了' })
  const notEscalated = await h.runtime.instructTool(h.rootAgent, { subtaskId: 'T1', instruction: '继续' })
  assert.equal(notEscalated.ok, false)
  assert.equal(notEscalated.code, 'NOT_ESCALATED')
})

test('durable 回放：escalation/lastInstruction 经 buildUpdateMessage → parseUpdateMessage → applyStatus 全保留', () => {
  const plan = makePlan('wp-chan-parse')
  const entry = {
    ...delegate('Expert-A', 'expert', 'member-1'),
    escalation: { question: '用 v1 还是 v2？', options: ['v1', 'v2'], needs: ['要文档'], at: 1_700_000_000_000, messageId: 'msg-1', delivery: 'sent' },
  }
  const message = buildUpdateMessage({ planId: plan.planId, subtaskId: 'T1', status: 'in_progress', delegates: [entry], revision: 3 })
  const parsed: any = parseUpdateMessage(message)
  assert.ok(parsed, 'update 消息必须可解析')
  let statuses: any = applyStatus(createStatuses(plan), 'T1', parsed)
  assert.equal(statuses[0].delegates[0].escalation.question, '用 v1 还是 v2？')
  assert.deepEqual(statuses[0].delegates[0].escalation.options, ['v1', 'v2'])
  assert.equal(statuses[0].delegates[0].escalation.messageId, 'msg-1')
  const instructed = buildUpdateMessage({
    planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 4,
    delegates: [{
      ...entry,
      escalation: undefined,
      lastInstruction: { text: '用 v2', at: 1_700_000_001_000, messageId: 'msg-2', delivery: 'sent' },
    }],
  })
  statuses = applyStatus(statuses, 'T1', parseUpdateMessage(instructed))
  const after = statuses[0].delegates[0]
  assert.ok(!after.escalation, '答复后 escalation 清除')
  assert.equal(after.lastInstruction.text, '用 v2')
  assert.equal(after.lastInstruction.messageId, 'msg-2')
})
