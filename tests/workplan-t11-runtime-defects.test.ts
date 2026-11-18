/*
 * [T11] 运行态两处缺陷修复聚焦回归（主 Agent 直接实现 T11 的配套测试）。
 *
 * 缺陷①（血缘懒加载）：重启早期负责人会话尚未载入 ctx.sessions 时，selfEffortTool
 *   旧逻辑 leaderSession=ctx.sessions.get(leaderId) 取不到 → rootId 空 → 误报
 *   SELF_EFFORT_NOT_LEAF。修复：按 childId 扫描 state.records 懒加载回退；真非叶子
 *   （childId 未登记）仍拒绝，安全边界不变。
 * 缺陷②（通知 signal）：完成汇报/请示上报/预估投递/延期告知的 sendMessage 第四参为 {}
 *   无 signal，宿主无条件读 opts.signal.throwIfAborted() 崩溃
 *   （"Cannot read properties of undefined (reading 'throwIfAborted')"）。修复：携带
 *   有效 AbortSignal。本夹具的 sendMessage 忠实模拟宿主行为（无条件调用
 *   opts.signal.throwIfAborted()），旧缺陷会在投递时抛错→记 failed，修复后正常 sent。
 *
 * 夹具范式：workplan-t6-estimate-gate.test.ts（激活 mock/自配档）＋
 *   workplan-t8-leaf-completion.test.ts（doneOutcome/WORKPLAN_EVIDENCE 结算）。
 * 纪律：不碰共享 dist/lib；类型验收 npx tsc -p tsconfig.test.json --noEmit；
 *   运行态全量回归由负责人（主 Agent）统一跑。
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

const ROOT = 'session-root'
const HEAD = 'child-leader'
const QWEN = 'qwen3-max-preview'

let journalDir = ''
let prevJournalEnv: string | undefined
function cleanupJournal(): void {
  if (prevJournalEnv === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = prevJournalEnv
  if (journalDir) rmSync(journalDir, { recursive: true, force: true })
}
before(() => {
  prevJournalEnv = process.env.DSH_WORKPLAN_JOURNAL_DIR
  journalDir = mkdtempSync(join(process.cwd(), '.t11-runtime-defects-journal-'))
  process.env.DSH_WORKPLAN_JOURNAL_DIR = journalDir
})
after(cleanupJournal)
process.on('exit', cleanupJournal)

function makePlan(planId: string) {
  return {
    version: 1, planId, title: 'T11 运行态缺陷用例', sessionId: ROOT, createdTurn: 1, createdAt: 1000,
    taskUnderstanding: { originalRequest: '修复血缘懒加载与通知 signal', deliverable: '缺陷回归' },
    contradictions: { primary: { statement: '重启早期血缘可见性 vs 不误拒叶子', evidence: [], whyPrimary: '夹具主要矛盾' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: '缺陷修复', rationale: '', checkpoint: '',
      // [2.5.5] 夹具适配：本文件测运行时缺陷（①懒加载/②signal），不测低档禁派；任务行声明 high 放行第三层派发。
      subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', role: '负责人', objective: 'o', method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [], reasoningEffort: 'high' }],
    }],
  }
}

function fakeSession(id: string, parentId: string | null, catalog: string[] = []) {
  const events: any[] = catalog.map((childId) => ({ type: 'subagent/catalog', data: { childId } }))
  return {
    id,
    header: { createdAt: 1000, cwd: '/tmp/t11-runtime-cwd', ...(parentId ? { parentSession: parentId } : {}) },
    events,
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
  }
}

const consolidation2 = () => ({
  problemAnalysis: ['现状：任务拆给专家与组员；目标是保质保量完成；约束是不改无关文件；边界是只做分内工作。', '主要矛盾：质量与时间'],
  approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测', '组员做证据：逐条核对验收标准并落盘留证'],
  approachBasis: ['第二轮分工基于第一轮全部梳理结果：质量与时间矛盾决定专家做核心实现、组员做证据。'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑后自测', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  ],
})

function makeFixture(planId: string) {
  const plan = makePlan(planId)
  const sessions: Record<string, any> = {}
  const rootSession = fakeSession(ROOT, null, [HEAD])
  const leaderSession = fakeSession(HEAD, ROOT)
  sessions[ROOT] = rootSession
  sessions[HEAD] = leaderSession
  const leaderAgent: any = { session: leaderSession, options: { provider: 'qw', model: QWEN } }
  const rootAgent: any = { session: rootSession, options: {} }
  const spawned: any[] = []
  const sent: any[] = []
  const ctx: any = {
    logger: { warn() {}, info() {}, error() {} },
    sessions: {
      get: (id: string) => (id == null ? undefined : sessions[id] ?? (id.startsWith('member-') ? (sessions[id] = fakeSession(id, HEAD)) : undefined)),
      list: () => Object.values(sessions),
      eventAt: () => undefined,
    },
    subagents: {
      startActivation: async (request: any) => {
        const childId = `member-${spawned.length + 1}`
        let resolveResult: any
        const result = new Promise((resolve) => { resolveResult = resolve })
        spawned.push({ childId, request, resolveResult })
        leaderSession.events.push({ type: 'subagent/catalog', data: { childId } })
        return { childId, result, dispose: async () => {} }
      },
      /* 忠实模拟宿主：无条件读取 opts.signal.throwIfAborted()。旧缺陷（{} 无 signal）
       * 会在此抛 TypeError→被调用方 catch 记 DELIVERY_FAILED；修复后为有效 signal，正常投递。 */
      sendMessage: async (agent: any, targetId: string, content: any[], opts: any) => {
        opts.signal.throwIfAborted()
        sent.push({ from: agent?.session?.id, targetId, text: String(content?.[0]?.text ?? ''), opts })
        return `msg-${sent.length}`
      },
      interruptByParent: () => ({ ok: true }),
    },
    agents: { get: (id: string) => (id === ROOT ? rootAgent : id === HEAD ? leaderAgent : undefined) },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = HEAD
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set(ROOT, record)
  const leafAgent = (childId: string) => ({ session: ctx.sessions.get(childId), options: { provider: 'qw', model: QWEN } })
  return { runtime, record, rootSession, leaderSession, sessions, spawned, sent, leaderAgent, rootAgent, leafAgent, plan }
}

async function dispatched(planId: string) {
  const f = makeFixture(planId)
  const review = await f.runtime.delegateTool(f.leaderAgent, { action: 'review', consolidation: consolidation2() })
  assert.equal(review.ok, true, JSON.stringify(review))
  const dispatch = await f.runtime.delegateTool(f.leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  return f
}

const selfArgs = (minutes: any, over: any = {}) => ({
  action: 'self_effort', reasoningEffort: 'xhigh',
  complexityRationale: '非常复杂：多夹具融合与冻结契约逐条锁定',
  deepThink: MAIN_DEEP_THINK_FIXTURE,
  timeNotice: { declaredMinutes: minutes, reason: '夹具预估' },
  ...over,
})

function doneOutcome(marker: string) {
  const evidence = {
    status: 'done',
    summary: `${marker} 完成摘要`,
    acceptance: [
      { criterion: 'c1', result: 'pass', evidence: 'e1' },
      { criterion: 'c2', result: 'pass', evidence: 'e2' },
    ],
    artifacts: [`reports/wp-member-${marker}-T11.json`],
    // [3.0.0] F10：专家汇报须为合规 JSON（keyResults/keyInfo/importantInfo/leadRequirements）。
    report: {
      keyResults: [`${marker} 关键成果一`],
      keyInfo: [`${marker} 关键信息一`],
      importantInfo: [`${marker} 重要情报一`],
      leadRequirements: [`${marker} 领导要求一`],
    },
  }
  const text = `${marker} 完成摘要：定向测试证据。\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(evidence)}\n<!-- WORKPLAN_EVIDENCE:END -->`
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

async function settle(spawned: any[], from = 0) {
  for (const s of spawned.slice(from)) s.resolveResult(doneOutcome('T11-LEAF'))
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function assertValidSignal(opts: any, label: string) {
  assert.ok(opts, `${label}：sendMessage 必须收到第四参 opts`)
  assert.ok(opts.signal, `${label}：opts.signal 不得为 undefined（旧缺陷 {} 无 signal）`)
  assert.equal(typeof opts.signal.throwIfAborted, 'function', `${label}：signal 必须是有效 AbortSignal`)
  assert.equal(opts.signal.aborted, false, `${label}：正常投递不得处于 aborted（保留取消语义）`)
}

/* ---------- 缺陷① · 血缘懒加载回退 ---------- */

test('缺陷① 重启早期负责人会话不可见 ⇒ 按 childId 懒加载回退，不误报 SELF_EFFORT_NOT_LEAF', async () => {
  const f = await dispatched('wp-t11-lineage-fallback')
  const childId = f.record.statuses[0].delegates[0].childId
  delete f.sessions[HEAD] // 模拟重启早期负责人会话尚未载入 ctx.sessions
  const r = await f.runtime.delegateTool(f.leafAgent(childId), selfArgs(12))
  assert.notEqual(r.code, 'SELF_EFFORT_NOT_LEAF', '负责人会话暂不可见不得误报非叶子：' + JSON.stringify(r))
  const entry = f.record.statuses[0].delegates.find((d: any) => d.member === 'Expert-A')
  assert.equal(entry.selfEffort, 'xhigh', '懒加载回退后应越过血缘检查正常登记自配档')
})

test('缺陷① 安全边界：真非叶子（childId 未登记）仍拒绝 SELF_EFFORT_NOT_LEAF', async () => {
  const f = await dispatched('wp-t11-lineage-boundary')
  delete f.sessions[HEAD]
  const stray = { session: fakeSession('stray-not-leaf', HEAD), options: { provider: 'qw', model: QWEN } }
  const r = await f.runtime.delegateTool(stray, selfArgs(12))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SELF_EFFORT_NOT_LEAF', '未被登记为叶子的会话必须仍被拒绝')
})

test('缺陷① 回归：负责人会话可见时正常自配（既有行为不变）', async () => {
  const f = await dispatched('wp-t11-lineage-normal')
  const childId = f.record.statuses[0].delegates[0].childId
  const r = await f.runtime.delegateTool(f.leafAgent(childId), selfArgs(12))
  assert.equal(r.ok, true, JSON.stringify(r))
  const entry = f.record.statuses[0].delegates.find((d: any) => d.member === 'Expert-A')
  assert.equal(entry.selfEffort, 'xhigh')
})

/* ---------- 缺陷② · 通知携带有效 signal ---------- */

test('缺陷② 预估投递 sendMessage 携带有效 signal（不再 {} 无 signal）', async () => {
  const f = await dispatched('wp-t11-signal-estimate')
  const childId = f.record.statuses[0].delegates[0].childId
  const before = f.sent.length
  const r = await f.runtime.delegateTool(f.leafAgent(childId), selfArgs(12))
  assert.equal(r.ok, true, JSON.stringify(r))
  const sends = f.sent.slice(before)
  assert.ok(sends.length >= 1, '预估必须真实投递（旧缺陷会在此抛 throwIfAborted 记 failed）')
  for (const s of sends) assertValidSignal(s.opts, '预估投递')
})

test('缺陷② 请示上报 sendMessage 携带有效 signal', async () => {
  const f = await dispatched('wp-t11-signal-escalate')
  const childId = f.record.statuses[0].delegates[0].childId
  const before = f.sent.length
  const r = await f.runtime.escalateTool(f.leafAgent(childId), { subtaskId: 'T1', question: '需要负责人决定方向', options: ['A', 'B'] })
  assert.equal(r.ok, true, JSON.stringify(r))
  const sends = f.sent.slice(before)
  assert.ok(sends.length >= 1, '请示必须真实投递给负责人')
  for (const s of sends) assertValidSignal(s.opts, '请示上报')
})

test('缺陷② 完成汇报 sendMessage 携带有效 signal（要求7真实投递）', async () => {
  const f = await dispatched('wp-t11-signal-completion')
  const before = f.sent.length
  await settle(f.spawned)
  const sends = f.sent.slice(before).filter((s: any) => /第三层完成汇报/.test(s.text))
  assert.ok(sends.length >= 1, '成员结算后必须向负责人投递完成汇报（旧缺陷会抛 throwIfAborted 记 failed）')
  for (const s of sends) assertValidSignal(s.opts, '完成汇报')
  assert.equal(sends[0].targetId, HEAD, '完成汇报必须投给负责人会话')
})