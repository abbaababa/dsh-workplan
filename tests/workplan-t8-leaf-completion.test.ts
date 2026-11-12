/*
 * [T8] 第三层叶子完成即时向原分派负责人汇报——定向回归测试。
 *
 * 唯一权威契约：_t5_channel_20261112/00-contract-v1.md（FROZEN，§1/§4/§5）
 * ＋ T8 负责人验收口径（agent-19，2026-11-12）：
 *   A1  8 名下属分别完成 → 8 条 kind='completion' 定向留痕，to.sessionId=原分派
 *       负责人会话（row.childId），根会话不误收叶子完成汇报；delegates 消毒上限
 *       slice(0,6)→12 回归（8 人台账不被截断）。
 *   A1-并发  同一 tick 内 8 个结算回调同时触发 → 恰 8 条汇报、每成员恰一条
 *       （pending 过滤与 report 写回之间隔 await 的竞态须由同步在途认领治本）。
 *   A2  完成事件后即时发出（结算回调内触发，不等整轮结束）；留痕 ts/finishedAt
 *       时序可证（ts≥finishedAt 且差值在即时口径内）；重复结算幂等不重发
 *       （report.state='sent' 才拦截）。
 *   A3  注入投递失败 → 显式 failed 留痕（DELIVERY_FAILED）＋report.state='failed'
 *       ＋done 判定不受影响＋下一次结算兜底补发（sent 后才幂等拦截）。
 *   附加  escalation 挂起的叶子完成不得发「已完成」汇报（2.5.6 待指示优先）；
 *       failed 叶子不产生完成措辞；report 幂等标记 applyStatus→durable update→
 *       reconstructFromSession 回放不丢（fail-closed 消毒）。
 *   A5  根会话既有完成即时通知（emitSubtaskDoneNotice → 根会话）零回归。
 *
 * 口径说明：契约 §1 completion.data 的 acceptanceCount/artifacts 为可选字段；
 * 实现 data={status:'done'}，负责人 A1 口径未要求验收计数，本文件不将其作为
 * 硬断言（避免超出冻结契约过度约束）。
 *
 * 夹具风格复用 tests/workplan-dept-channel.test.ts：fakeSession＋
 * ctx.subagents.sendMessage 捕获＋失败注入＋DSH_WORKPLAN_JOURNAL_DIR 指向
 * 工作区临时目录（测后清理）。结算驱动：startActivation 返回受控 thenable，
 * 测试用 cb(outcome) 精确触发一次/两次结算（幂等用例），不依赖真实宿主。
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyStatus,
  buildPlanMessage,
  buildUpdateMessage,
  createStatuses,
  parseResultMessage,
  parseUpdateMessage,
} from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { readDeptMessages } from '../src/dept-journal.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

const ROOT = 'session-root-t8'
const HEAD = 'child-leader-t8'
const PLAN_ID_PREFIX = 'wp-t8-leaf'

let journalDir = ''
let prevJournalEnv: string | undefined

before(() => {
  prevJournalEnv = process.env.DSH_WORKPLAN_JOURNAL_DIR
  journalDir = mkdtempSync(join(process.cwd(), '.t8-leaf-journal-'))
  process.env.DSH_WORKPLAN_JOURNAL_DIR = journalDir
})

after(() => {
  if (prevJournalEnv === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = prevJournalEnv
  if (journalDir) rmSync(journalDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const MEMBER_NAMES = ['专家1', '专家2', '专家3', '专家4', '组员1', '组员2', '组员3', '组员4']

function consolidationFor(names: string[]) {
  return {
    problemAnalysis: ['现状：需要把部门任务拆给专家与组员并即时回收完成汇报；目标是保质保量完成；约束是不改无关文件；主要矛盾是质量与时间。', '未知：各成员实际耗时；边界：只做本计划内工作。'],
    constraints: ['不得改动无关文件'],
    unknowns: ['各成员实际耗时'],
    approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测', '组员做自测：逐条核对验收标准并落盘留证'],
    approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据。'],
    // 复杂任务（≥8 人）才声明 medium 触发 ≥8 人门禁；小型夹具走非复杂档（≤6 人）。
    ...(names.length >= 8 ? { taskReasoningEffort: 'medium' } : {}),
    assignments: names.map((member, index) => ({
      member,
      role: member.startsWith('专家') ? 'expert' : 'member',
      task: `单一目标任务 ${index + 1}：产出可独立验收的证据`,
      reasoningEffort: 'medium',
    })),
  }
}

function makePlan(planId: string) {
  return {
    version: 1,
    planId,
    title: 'T8 叶子完成即时汇报回归',
    sessionId: ROOT,
    createdTurn: 1,
    createdAt: 1000,
    contradictions: { primary: { statement: '叶子完成只通知根会话与负责人即时知情之间的矛盾', evidence: [], whyPrimary: '测试夹具主要矛盾' } },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '完成即时汇报',
      rationale: '',
      checkpoint: '',
      subtasks: [
        { id: 'T1', title: '部门任务', department: 'engineering', role: '负责人', objective: 'o', method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [] },
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

function doneOutcome(marker: string) {
  const evidence = {
    status: 'done',
    summary: `${marker} 完成摘要`,
    acceptance: [
      { criterion: 'c1', result: 'pass', evidence: 'e1' },
      { criterion: 'c2', result: 'pass', evidence: 'e2' },
    ],
    artifacts: [`reports/wp-member-${marker}-T8.json`],
  }
  const text = `${marker} 完成摘要：定向测试证据。\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(evidence)}\n<!-- WORKPLAN_EVIDENCE:END -->`
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

async function tick(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await tick(10)
  }
  return false
}

function completionJournal(planId: string) {
  const read = readDeptMessages(planId, { kind: 'completion' })
  assert.equal(read.ok, true, JSON.stringify(read))
  return (read as any).messages as any[]
}

function eventTexts(session: any): string[] {
  return session.events.map((event: any) => JSON.stringify(event?.data ?? ''))
}

/**
 * 受控派发夹具：review→dispatch 真实走 delegateTool；startActivation 返回
 * 受控 thenable——结算回调 cb 由测试显式触发（一次=正常结算，两次=重复结算）。
 */
async function makeHarness(planId: string, names: string[] = MEMBER_NAMES) {
  const plan = makePlan(planId)
  const leafIds = names.map((_, index) => `leaf-${index + 1}`)
  const rootSession = fakeSession(ROOT, null, [HEAD])
  const headSession = fakeSession(HEAD, ROOT, leafIds)
  const leafSessions = leafIds.map((id) => fakeSession(id, HEAD))
  const sessions: Record<string, any> = { [ROOT]: rootSession, [HEAD]: headSession }
  leafIds.forEach((id, index) => { sessions[id] = leafSessions[index] })
  const rootAgent = { session: rootSession, options: {} }
  const leaderAgent = { session: headSession, options: { provider: 'qw', model: 'qwen3.8-flash' } }
  const leafAgents = leafSessions.map((session) => ({ session, options: { provider: 'qw', model: 'qwen3.8-flash' } }))
  const agentsById: Record<string, any> = { [ROOT]: rootAgent, [HEAD]: leaderAgent }
  leafIds.forEach((id, index) => { agentsById[id] = leafAgents[index] })

  const sent: any[] = []
  const spawned: any[] = []
  const fail = { value: false }
  const ctx: any = {
    logger: { warn() {}, info() {}, error() {} },
    sessions: { get: (id: string) => sessions[id], list: () => Object.values(sessions), eventAt: () => undefined },
    agents: { get: (id: string) => agentsById[id] ?? null },
    subagents: {
      startActivation: async () => {
        const childId = `leaf-${spawned.length + 1}`
        const entry: any = { childId, cb: null }
        spawned.push(entry)
        return {
          childId,
          result: {
            then(cb: any) { entry.cb = cb; return Promise.resolve() },
            catch() { return this },
          },
          dispose: async () => {},
        }
      },
      sendMessage: async (agent: any, targetId: string, content: any[]) => {
        sent.push({ from: agent?.session?.id, targetId, text: String(content?.[0]?.text ?? '') })
        if (fail.value) throw new Error('投递失败：测试注入')
        return `msg-${sent.length}`
      },
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = HEAD
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set(ROOT, record)

  const review = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidationFor(names) })
  assert.equal(review.ok, true, JSON.stringify(review))
  const dispatch = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))

  const settle = async (index: number, outcome: any) => {
    assert.equal(typeof spawned[index]?.cb, 'function', `leaf-${index + 1} 结算回调必须已登记`)
    spawned[index].cb(outcome)
    await tick()
  }
  const delegateOf = (childId: string) => record.statuses[0].delegates.find((d: any) => d.childId === childId)
  return {
    runtime, record, ctx, sent, spawned, fail, plan, planId,
    rootSession, headSession, leafSessions, leaderAgent, leafAgents, rootAgent,
    settle, delegateOf,
  }
}

/* ------------------------------------------------------------------ *
 * A1 八名下属分别完成 → 8 条定向汇报（接收方=原分派负责人；根不误收）
 * ------------------------------------------------------------------ */

test('A1 八人定向：8 条 completion 留痕 to=原分派负责人，sendMessage 全投 HEAD，根会话不误收，台账不截断', async () => {
  const h = await makeHarness(`${PLAN_ID_PREFIX}-a1`)
  // slice(0,6)→12 回归：8 人台账必须完整落盘（派发 persist 后）。
  assert.equal(h.record.statuses[0].delegates.length, 8, 'delegates 消毒上限必须容纳 8 人（slice 6→12 回归）')
  for (let i = 0; i < 8; i += 1) {
    await h.settle(i, doneOutcome(`T8-LEAF-${i + 1}`))
    assert.ok(
      await waitFor(() => completionJournal(h.planId).length >= i + 1),
      `第 ${i + 1} 名成员完成后必须即时产生 completion 留痕`,
    )
  }
  const messages = completionJournal(h.planId)
  assert.equal(messages.length, 8, '8 名下属分别完成必须产生 8 条定向汇报')
  for (let i = 0; i < 8; i += 1) {
    const msg = messages[i]
    const name = MEMBER_NAMES[i]
    assert.equal(msg.v, 1)
    assert.equal(msg.kind, 'completion')
    assert.equal(msg.planId, h.planId)
    assert.equal(msg.subtaskId, 'T1', 'subtaskId 必须是负责人所在计划行 ID')
    assert.equal(msg.from.sessionId, `leaf-${i + 1}`)
    assert.equal(msg.from.member, name)
    assert.equal(msg.from.role, i < 4 ? 'expert' : 'member')
    assert.equal(msg.to.sessionId, HEAD, '接收方必须是原分派负责人会话（row.childId）')
    assert.equal(msg.to.role, 'head')
    assert.notEqual(msg.to.sessionId, ROOT, '根会话不得成为叶子完成汇报接收方')
    assert.equal(msg.delivery.status, 'sent')
    assert.equal(msg.data?.status, 'done')
    assert.ok(msg.body.includes('T1'), '正文必须含子任务 ID')
    assert.ok(msg.body.includes(name), '正文必须含成员名')
    assert.ok(msg.body.includes(`T8-LEAF-${i + 1}`), '正文必须含完成摘要')
    const entry = h.delegateOf(`leaf-${i + 1}`)
    assert.equal(entry.status, 'done')
    assert.equal(entry.report?.state, 'sent', '投递成功必须记 report.state=sent')
    assert.ok(entry.report?.at > 0)
    assert.equal(typeof entry.report?.ref, 'string')
  }
  // sendMessage 投递：8 次全部投负责人会话，发送者是根会话 agent，零次投根。
  assert.equal(h.sent.length, 8)
  for (const call of h.sent) {
    assert.equal(call.targetId, HEAD)
    assert.equal(call.from, ROOT, '发送者必须是根会话 agent（宿主 lineage 父→子）')
    assert.ok(call.text.includes('已完成并结算'))
  }
  // 负责人会话收到辅助纯文本通知；根会话只有 durable update，没有完成汇报文本。
  const headTexts = eventTexts(h.headSession).filter((text) => text.includes('已完成并结算'))
  assert.equal(headTexts.length, 8, '负责人会话必须收到 8 条辅助可见通知')
  const rootTexts = eventTexts(h.rootSession)
  assert.equal(rootTexts.filter((text) => text.includes('已完成并结算') || text.includes('第三层完成汇报')).length, 0, '根会话不得误收叶子完成汇报')
  assert.ok(rootTexts.some((text) => text.includes('workplan-update')), '根会话仍收到 durable workplan-update（回放不丢）')
})

/* ------------------------------------------------------------------ *
 * A1-并发 同一 tick 内 8 个结算回调同时触发（任务书「多下属同时完成」）
 * ------------------------------------------------------------------ */

test('A1-并发：同一 tick 内 8 个结算回调同时触发，恰 8 条定向汇报、每成员恰一条、无重复', async () => {
  const h = await makeHarness(`${PLAN_ID_PREFIX}-a1-race`)
  assert.equal(h.record.statuses[0].delegates.length, 8, '8 人台账必须完整')
  // 同一同步段连续触发 8 个结算回调（中间不 await）：复现「多下属同时完成」。
  // 竞态根因：pending 过滤与 report 写回之间隔 await，未同步认领在途成员会重复投递。
  for (let i = 0; i < 8; i += 1) {
    h.spawned[i].cb(doneOutcome(`T8-RACE-${i + 1}`))
  }
  assert.ok(await waitFor(() => completionJournal(h.planId).length >= 8, 5000), '并发完成后必须产生定向汇报')
  await tick(150) // 让全部在途微任务收敛，再断言精确计数（避免增长中途误判）
  const messages = completionJournal(h.planId)
  assert.equal(messages.length, 8, `恰 8 条定向汇报（并发竞态会重复投递），实际 ${messages.length}`)
  assert.equal(h.sent.length, 8, `sendMessage 恰 8 次投递（每成员一次），实际 ${h.sent.length}`)
  for (let i = 0; i < 8; i += 1) {
    const mine = messages.filter((msg) => msg.from.sessionId === `leaf-${i + 1}`)
    assert.equal(mine.length, 1, `成员 leaf-${i + 1} 恰一条汇报，实际 ${mine.length}`)
    assert.equal(mine[0].to.sessionId, HEAD, '接收方必须是原分派负责人会话')
    assert.equal(mine[0].delivery.status, 'sent')
    assert.equal(h.delegateOf(`leaf-${i + 1}`).report?.state, 'sent', '每成员最终 report.state=sent')
  }
  for (const call of h.sent) {
    assert.equal(call.targetId, HEAD, '并发投递全部投负责人会话，根会话不误收')
  }
})

/* ------------------------------------------------------------------ *
 * A2 即时口径：结算回调内触发＋ts/finishedAt 时序可证
 * ------------------------------------------------------------------ */

test('A2 即时时序：完成事件后结算回调内即发出，ts≥finishedAt 且差值在即时口径内', async () => {
  const h = await makeHarness(`${PLAN_ID_PREFIX}-a2`, ['专家1', '组员1'])
  const t0 = Date.now()
  await h.settle(0, doneOutcome('T8-TIMING'))
  assert.ok(await waitFor(() => completionJournal(h.planId).length >= 1, 2000), '完成事件后必须即时发出（无需任何整轮结束触发）')
  const entry = h.delegateOf('leaf-1')
  const msg = completionJournal(h.planId)[0]
  assert.equal(entry.status, 'done')
  assert.ok(entry.finishedAt >= t0, 'finishedAt 必须不早于完成事件')
  assert.ok(msg.ts >= entry.finishedAt, '留痕 ts 必须不早于 finishedAt（时序可证）')
  assert.ok(msg.ts - entry.finishedAt <= 2000, `即时口径：ts-finishedAt 差值必须≤2000ms，实际 ${msg.ts - entry.finishedAt}ms`)
  assert.ok(entry.report.at >= entry.finishedAt, 'report.at 必须不早于 finishedAt')
  assert.ok(msg.delivery.latencyMs >= 0, '投递时延必须可观测')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].targetId, HEAD)
})

test('A2 幂等：同一叶子重复结算不重发（report.state=sent 拦截）', async () => {
  const h = await makeHarness(`${PLAN_ID_PREFIX}-a2-idem`, ['专家1', '组员1'])
  await h.settle(0, doneOutcome('T8-IDEM'))
  assert.ok(await waitFor(() => completionJournal(h.planId).length === 1))
  // 重复结算：同一 outcome 再次触发结算回调（模拟重复完成事件/兜底重放）。
  h.spawned[0].cb(doneOutcome('T8-IDEM'))
  await tick()
  h.spawned[0].cb(doneOutcome('T8-IDEM'))
  await tick(50)
  assert.equal(completionJournal(h.planId).length, 1, '重复结算不得重发 completion 留痕')
  assert.equal(h.sent.length, 1, '重复结算不得重复投递')
  assert.equal(h.delegateOf('leaf-1').report.state, 'sent')
})

/* ------------------------------------------------------------------ *
 * A3 投递失败：显式 failed 留痕＋report.state=failed＋done 不受影响＋兜底补发
 * ------------------------------------------------------------------ */

test('A3 失败与重试：failed 留痕＋report.state=failed＋done 判定不变，下一次结算兜底补发，sent 后幂等', async () => {
  const h = await makeHarness(`${PLAN_ID_PREFIX}-a3`, ['专家1', '组员1'])
  h.fail.value = true
  await h.settle(0, doneOutcome('T8-FAIL'))
  assert.ok(await waitFor(() => completionJournal(h.planId).length === 1))
  const entry = h.delegateOf('leaf-1')
  assert.equal(entry.status, 'done', '投递失败绝不影响 done 判定')
  assert.equal(entry.report?.state, 'failed', '投递失败必须记 report.state=failed，绝不冒充 sent')
  const failedMsg = completionJournal(h.planId)[0]
  assert.equal(failedMsg.delivery.status, 'failed', '投递失败必须显式 failed 留痕')
  assert.equal(failedMsg.delivery.code, 'DELIVERY_FAILED')
  assert.ok(String(failedMsg.delivery.error ?? '').includes('投递失败'), 'failed 留痕必须带错误原文')
  assert.ok(h.record.errors.some((line: string) => line.includes('DELIVERY_FAILED')), 'record.errors 必须留痕投递失败')
  assert.equal(h.record.statuses[0].status, 'in_progress', '部门行状态不受通知失败影响')

  // 恢复投递后另一名成员结算 → 兜底补发所有 done 未 sent 条目（含 leaf-1）。
  h.fail.value = false
  await h.settle(1, doneOutcome('T8-RETRY'))
  assert.ok(await waitFor(() => completionJournal(h.planId).length === 3), '失败条目必须在下次结算兜底补发（failed+sent+另一成员 sent）')
  const messages = completionJournal(h.planId)
  const leaf1Messages = messages.filter((msg) => msg.from.sessionId === 'leaf-1')
  assert.equal(leaf1Messages.length, 2, '失败与补发都必须留痕（追加式审计）')
  assert.equal(leaf1Messages[0].delivery.status, 'failed')
  assert.equal(leaf1Messages[1].delivery.status, 'sent')
  assert.equal(h.delegateOf('leaf-1').report.state, 'sent', '补发成功后恢复 sent')
  assert.equal(h.delegateOf('leaf-2').report.state, 'sent')

  // sent 之后重复结算：幂等拦截，不再产生第 4 条。
  h.spawned[1].cb(doneOutcome('T8-RETRY'))
  await tick(50)
  assert.equal(completionJournal(h.planId).length, 3, 'sent 后重复结算必须被幂等拦截')
})

/* ------------------------------------------------------------------ *
 * 附加：待指示优先 / failed 叶子不产生完成措辞
 * ------------------------------------------------------------------ */

test('附加：escalation 挂起的叶子完成不得发「已完成」汇报（2.5.6 待指示优先）', async () => {
  const h = await makeHarness(`${PLAN_ID_PREFIX}-esc`, ['专家1', '组员1'])
  const esc = await h.runtime.escalateTool(h.leafAgents[0], { question: '等负责人拍板' })
  assert.equal(esc.ok, true, JSON.stringify(esc))
  await h.settle(0, { stopReason: 'completed', output: [{ type: 'text', text: '回合结束' }] })
  const entry = h.delegateOf('leaf-1')
  assert.ok(entry.escalation, 'escalation 子对象不得被结算覆盖')
  assert.notEqual(entry.status, 'done')
  // 另一名正常成员完成：兜底补发也不得把待指示叶子报成完成。
  await h.settle(1, doneOutcome('T8-ESC-OTHER'))
  assert.ok(await waitFor(() => completionJournal(h.planId).length === 1))
  const messages = completionJournal(h.planId)
  assert.equal(messages[0].from.sessionId, 'leaf-2')
  assert.equal(messages.filter((msg) => msg.from.sessionId === 'leaf-1').length, 0, '待指示叶子不得产生 completion 汇报')
  const headTexts = eventTexts(h.headSession).filter((text) => text.includes('已完成并结算'))
  assert.equal(headTexts.length, 1)
  assert.ok(!headTexts[0].includes('专家1'), '待指示叶子不得出现「已完成」措辞')
})

test('附加：failed 叶子不产生完成措辞，done-only 通知', async () => {
  const h = await makeHarness(`${PLAN_ID_PREFIX}-failed`, ['专家1', '组员1'])
  await h.settle(0, { stopReason: 'error', diagnostic: '注入失败' })
  await h.settle(1, doneOutcome('T8-FAILED-OTHER'))
  assert.ok(await waitFor(() => completionJournal(h.planId).length === 1))
  assert.equal(h.delegateOf('leaf-1').status, 'failed')
  const messages = completionJournal(h.planId)
  assert.equal(messages[0].from.sessionId, 'leaf-2')
  assert.equal(messages.filter((msg) => msg.from.sessionId === 'leaf-1').length, 0, 'failed 叶子不得产生 completion 汇报')
  const headTexts = eventTexts(h.headSession).filter((text) => text.includes('已完成并结算'))
  assert.equal(headTexts.length, 1)
  assert.ok(!headTexts[0].includes('专家1'), 'failed 叶子不得出现「已完成」措辞')
})

/* ------------------------------------------------------------------ *
 * 附加：report 幂等标记回放不丢＋fail-closed 消毒＋8 人回放
 * ------------------------------------------------------------------ */

test('附加：report 标记 applyStatus→durable update→reconstructFromSession 回放不丢；非法形状 fail-closed', () => {
  const planId = `${PLAN_ID_PREFIX}-replay`
  const plan = makePlan(planId)
  const report = { state: 'sent', at: 1_700_000_000_000, ref: `${planId}:1000` }
  const delegates = MEMBER_NAMES.map((member, index) => ({
    member,
    role: index < 4 ? 'expert' : 'member',
    task: '单一目标任务',
    effort: 'medium',
    childId: `leaf-${index + 1}`,
    status: 'done',
    summary: `${member} 完成`,
    error: null,
    startedAt: 1000,
    finishedAt: 1_700_000_000_000,
    report: { ...report },
  }))
  // applyStatus 往返（消毒保留 state/at/ref；turn 为可选 advisory 字段，不做整体 deepEqual）。
  let statuses: any = applyStatus(createStatuses(plan), 'T1', { status: 'in_progress', delegates, revision: 2 })
  assert.equal(statuses[0].delegates.length, 8, 'applyStatus 必须保留 8 人台账')
  const assertReportKept = (kept: any, label: string, roundTripped = false) => {
    assert.ok(kept, `${label}: report 幂等标记不得丢失`)
    assert.equal(kept.state, report.state, `${label}: report.state 必须保留`)
    assert.equal(kept.at, report.at, `${label}: report.at 必须保留`)
    assert.equal(kept.ref, report.ref, `${label}: report.ref 必须保留`)
    // 负责人裁决：report 与主行消毒同口径（plan.ts patch.report 同一 turn 表达式）。
    // 首次物化：缺 turn 键 → null；durable 往返后 turn:null 经 Number(null)=0
    // 再消毒为 0——这是主行/delegates 同口径的权威行为，不是 T8 缺陷。
    if (!roundTripped) {
      assert.equal(kept.turn, null, `${label}: 无活动轮次时 turn 必须物化为 null`)
    } else {
      assert.ok(kept.turn === null || kept.turn === 0, `${label}: 无活动轮次往返后 turn 必须保持 null/0，实际 ${kept.turn}`)
    }
  }
  assertReportKept(statuses[0].delegates[0].report, 'applyStatus')
  // durable update → parse → applyStatus 往返。
  const message = buildUpdateMessage({ planId, subtaskId: 'T1', status: 'in_progress', delegates: statuses[0].delegates, revision: 2 })
  const parsed: any = parseUpdateMessage(message)
  assert.ok(parsed, 'update 消息必须可解析')
  statuses = applyStatus(createStatuses(plan), 'T1', parsed)
  assertReportKept(statuses[0].delegates[7].report, 'durable 回放', true)
  // reconstructFromSession：进程重启后 8 人台账与 report 标记仍在。
  const session = fakeSession(ROOT, null)
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', message)
  const rebuilt: any = reconstructFromSession(session, planId)
  assert.ok(rebuilt?.plan, '必须能重建计划')
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.delegates.length, 8, '重启回放不得截断 8 人台账')
  for (const entry of row.delegates) {
    assertReportKept(entry.report, '重启回放', true)
  }
  // fail-closed：非法 state / 非对象 report 整体丢弃，不入库脏值。
  const bad = applyStatus(createStatuses(plan), 'T1', {
    delegates: [{ ...delegates[0], report: { state: 'bogus', at: 1, ref: 'x' } }],
  })
  assert.ok(!bad[0].delegates[0].report, '非法 report.state 必须整体丢弃')
  const bad2 = applyStatus(createStatuses(plan), 'T1', {
    delegates: [{ ...delegates[0], report: 'sent' }],
  })
  assert.ok(!bad2[0].delegates[0].report, '非对象 report 必须整体丢弃')
})

/* ------------------------------------------------------------------ *
 * A5 根会话既有完成即时通知回归（emitSubtaskDoneNotice 语义零破坏）
 * ------------------------------------------------------------------ */

test('A5 根会话回归：主计划 async 轮次完成仍即时通知根会话，先于结果消息，reportPending=false', async () => {
  const planId = `${PLAN_ID_PREFIX}-root`
  const session = fakeSession(ROOT, null)
  const subtask = {
    id: 'T1', title: '根回归', department: 'engineering', role: '工程师', objective: 'o',
    method: [], inputs: [], outputs: ['证据'], acceptance: ['断言通过'], risk: '', dependsOn: [],
  }
  session.append('user/message', buildPlanMessage({
    planId,
    sessionId: ROOT,
    createdTurn: 1,
    createdAt: 1000,
    title: '根会话完成通知回归',
    taskUnderstanding: { originalRequest: '验证根会话完成即时通知', deliverable: '通知先于结果消息' },
    contradictions: { primary: { statement: '回归' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks: [subtask] }],
  }))
  seedLeaderSelfEffort(session, { planId, stages: [{ subtasks: [{ id: 'T1' }] }] })

  let release!: (value: any) => void
  const gate = new Promise<any>((resolve) => { release = resolve })
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => ({ childId: 'child-root-t8', result: gate, dispose: async () => {} }),
    },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [session],
      eventAt: () => undefined,
    },
  }
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, idleTimeoutMs: 30_000, strictEvidence: false })
  await runtime.dispatchTool({ id: ROOT, session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE, mode: 'async' }, new AbortController().signal)

  const evidence = {
    status: 'done',
    summary: '根回归完成',
    acceptance: [{ criterion: '断言通过', result: 'pass', evidence: '本用例' }],
    phases: {
      planning: { problemAnalysis: ['第一轮深研：目标与验收、现状、约束、未知、主要矛盾、边界逐条写清。'], approach: ['第二轮方法流程步骤：先派发后督战再逐条验收交付。'], approachBasis: ['第二轮基于第一轮全部结果。'] },
      execution: { steps: ['执行完成'] },
      verification: { allPassed: true, checks: [{ criterion: '断言通过', method: '单测', evidence: '本用例' }], retrospective: { problems: ['无'], detours: [], resolutions: ['按契约执行'], prevention: ['遇到同类任务先查教训'] } },
    },
  }
  release({ stopReason: 'completed', output: [{ type: 'text', text: `完成。\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(evidence)}\n<!-- WORKPLAN_EVIDENCE:END -->` }] })
  assert.ok(
    await waitFor(() => session.events.some((event: any) => event.type === 'user/message' && parseResultMessage(event.data)), 10_000),
    '本轮应结算并写入结果消息',
  )
  const texts = eventTexts(session)
  const noticeIndex = texts.findIndex((text) => text.includes('[dsh-workplan] 子任务 T1 已完成并结算'))
  const resultIndex = texts.findIndex((text) => text.includes('DSH-WORKPLAN-RESULT'))
  assert.ok(noticeIndex >= 0, '根会话既有完成即时通知必须仍在（A5 零回归）')
  assert.ok(resultIndex >= 0)
  assert.ok(noticeIndex < resultIndex, '即时通知必须先于整轮结果消息（不等待整轮结束）')
  assert.equal(texts.filter((text) => text.includes('第三层完成汇报')).length, 0, '叶子完成汇报通道不得泄漏到根会话')
  const finished: any = await runtime.statusTool({ session }, {})
  const row = (finished?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.status, 'done')
  assert.equal(row.closure, 'reported')
  const record = runtime.state.records.get(ROOT)
  assert.equal(record.reportPending, false, '成功回报后 reportPending 必须为 false')
})
