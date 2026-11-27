/*
 * [T6][契约v1] 下属开工前预估时间上报硬门禁回归（estimate-tests-expert 唯一写者）。
 *
 * 唯一权威契约：_t6_estimate_20261112/00-contract-estimate-v1.md（FROZEN）。
 * 上位契约：_t5_channel_20261112/00-contract-v1.md（kind='estimate' 已预留）。
 * 夹具范式：workplan-252-leaf-deep-think.test.ts（runtime 激活夹具：startActivation
 * mock/spawned/resolveResult/qwen max→xhigh 钳制）＋ workplan-dept-channel.test.ts
 * （通道夹具：fakeSession catalog/sendMessage 注入/readDeptMessages/journal 临时目录）。
 *
 * 用例 → 验收映射（契约 §8）：
 *   A1① 缺 timeNotice ⇒ ESTIMATE_MISSING：startActivation 未被调用、不登记、成员未进入执行态
 *   A1② 非法值（0/-3/2.5/'abc'/缺 declaredMinutes/＞10080/非对象）⇒ ESTIMATE_INVALID（含 D9 原话）
 *   A1③ 合法正整数 ⇒ ok:true＋estimate 附回＋自配档接续；边界 1/10080；reason 缺省文案「理由：无」
 *   A1④ 重派读档：已配档+已思考但无预估 ⇒ leafPhaseZero 回 phase-0；三者齐全 ⇒ 直接 phase-1（含分钟数）
 *   A1序 校验顺序 reasoningEffort→complexityRationale→startPhases→timeNotice（旧拒因保持）
 *   A2⑤ 8 成员逐一上报不同分钟数 ⇒ delegateEstimates 8 键＋delegates[].estimate 8 条＋journal 8 条
 *        kind=estimate，from.member/from.sessionId/to.sessionId 归属逐一正确（临时目录留痕）
 *   A2路由 row.childId 缺失回退 leaderId（契约 §4）
 *   A3⑥ 存储值 Number.isInteger 全通过；非整数/越界/非法 at/delivery 消毒丢弃；reason≤300/messageId≤200
 *   A3台账 delegateEstimates 非法形状抛 INVALID_DELEGATE_ESTIMATES；上限 12（8 人全存活，不得截 6）
 *   D6⑦ sendMessage 抛错 ⇒ ESTIMATE_DELIVERY_FAILED 显式＋delivery:'failed' 落档＋不接续；
 *        重试重新投递成功后接续；sent 后重复提交不重复投递；留痕写失败不掩盖投递结果
 *   重置⑧ reset 后 delegateEstimates 仍在（显式 patch 优先、null 清除）
 *   回放⑨ buildUpdateMessage→parseUpdateMessage→applyStatus / reconstructFromSession 往返不丢＋消毒
 *   读面 derivePlanSnapshot / modelStatusLines 透传 estimate（契约 §3 回放白名单一处不漏）
 *   同源⑥ delegate schema timeNotice（integer≥1）＋「整数分钟」＋D9 原话＋phase-0/叶子/负责人任务书
 *
 * 纪律（契约 §7）：不碰共享 dist/lib；类型验收 npx tsc -p tsconfig.test.json --noEmit；
 * 运行态全量回归由负责人统一跑。实现未就绪的落点按冻结契约先行锁定（回报中注明依赖）。
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyStatus, buildChildPrompt, buildPlanMessage, buildUpdateMessage, createStatuses, derivePlanSnapshot, parseUpdateMessage, flushPendingWorkplanUpdates } from '../src/plan.js'
import { createWorkplanRuntime, modelStatusLines, reconstructFromSession } from '../src/runtime.js'
import { readDeptMessages } from '../src/dept-journal.js'
import { buildDelegateePrompt, buildLlmRulesBrief, buildPhaseZeroDelegateePrompt } from '../src/llm-rules.js'
import { createDelegateTool } from '../src/host.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

const ROOT = 'session-root'
const HEAD = 'child-leader'
const QWEN = 'qwen3-max-preview'
/* D9 用户原话（契约 §2：ESTIMATE_MISSING/ESTIMATE_INVALID 文案必须包含）。 */
const D9 = '你必须自己预估时间，汇报给对应负责人后，才可以重试或继续执行'

let journalDir = ''
let prevJournalEnv: string | undefined
function cleanupJournal(): void {
  if (prevJournalEnv === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
  else process.env.DSH_WORKPLAN_JOURNAL_DIR = prevJournalEnv
  if (journalDir) rmSync(journalDir, { recursive: true, force: true })
}
before(() => {
  prevJournalEnv = process.env.DSH_WORKPLAN_JOURNAL_DIR
  journalDir = mkdtempSync(join(process.cwd(), '.t6-estimate-gate-journal-'))
  process.env.DSH_WORKPLAN_JOURNAL_DIR = journalDir
})
after(cleanupJournal)
process.on('exit', cleanupJournal)

function makePlan(planId: string) {
  return {
    version: 1, planId, title: 'T6 预估门禁用例', sessionId: ROOT, createdTurn: 1, createdAt: 1000,
    taskUnderstanding: { originalRequest: '下属开工前预估上报', deliverable: '门禁回归' },
    contradictions: { primary: { statement: '先预估后开工 vs 不卡死回放', evidence: [], whyPrimary: '夹具主要矛盾' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: '预估门禁', rationale: '', checkpoint: '',
      subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', role: '负责人', objective: 'o', method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [] }],
    }],
  }
}

function fakeSession(id: string, parentId: string | null, catalog: string[] = []) {
  const events: any[] = catalog.map((childId) => ({ type: 'subagent/catalog', data: { childId } }))
  return {
    id,
    header: { createdAt: 1000, cwd: '/tmp/t6-estimate-cwd', ...(parentId ? { parentSession: parentId } : {}) },
    events,
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
  }
}

/* 融合夹具：252 的激活 mock（spawned/resolveResult/agents.get）＋ dept-channel 的
 * sendMessage 注入（fail 开关）＋ catalog 自动登记（spawn 即入负责人直接子会话台账）。 */
function makeFixture(planId: string) {
  const plan = makePlan(planId)
  const sessions: Record<string, any> = {}
  const rootSession = fakeSession(ROOT, null, [HEAD])
  const leaderSession = fakeSession(HEAD, ROOT)
  sessions[ROOT] = rootSession
  sessions[HEAD] = leaderSession
  const leaderAgent: any = { session: leaderSession, options: { provider: 'qw', model: QWEN } }
  const spawned: any[] = []
  const sent: any[] = []
  const fail = { value: false }
  const ctx: any = {
    logger: { warn() {}, info() {}, error() {} },
    sessions: {
      get: (id: string) => sessions[id] ?? (id.startsWith('member-') ? (sessions[id] = fakeSession(id, HEAD)) : undefined),
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
      sendMessage: async (agent: any, targetId: string, content: any[]) => {
        if (fail.value) throw new Error('模拟投递失败')
        sent.push({ from: agent?.session?.id, targetId, text: String(content?.[0]?.text ?? '') })
        return `msg-${sent.length}`
      },
      interruptByParent: () => ({ ok: true }),
    },
    agents: { get: (id: string) => (id === HEAD ? leaderAgent : undefined) },
  }
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = HEAD
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set(ROOT, record)
  const leafAgent = (childId: string) => ({ session: ctx.sessions.get(childId), options: { provider: 'qw', model: QWEN } })
  return { runtime, record, rootSession, leaderSession, spawned, sent, fail, leaderAgent, leafAgent, plan }
}

const MEMBERS8 = [
  { member: 'Expert-A', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }, { member: 'Expert-B', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  { member: 'Member-C', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }, { member: 'Member-D', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  { member: 'Member-E', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }, { member: 'Member-F', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  { member: 'Member-G', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }, { member: 'Member-H', role: 'expert', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
]
/* 复杂任务（taskReasoningEffort=medium）⇒ D2 强制 ≥8 人；8 人表与 01-review-payload-8.json 同口径。 */
const consolidation8 = () => ({
  taskReasoningEffort: 'medium',
  problemAnalysis: ['现状：T6 预估门禁须以 8 人分工表覆盖专家与组员；目标是逐条锁定 A1/A2/A3 验收；约束是唯一写者与冻结契约；主要矛盾是质量与时间。'],
  approach: ['专家锁定门禁与通道用例：先读契约再写断言并最小复现', '组员核对持久化与回放证据：逐条对照消毒白名单并落盘留证'],
  approachBasis: ['第二轮分工基于第一轮全部梳理结果：质量与时间矛盾决定专家做门禁、组员做证据。'],
  assignments: MEMBERS8.map((m) => ({ ...m, task: `单一目标任务：${m.member} 的实现与自测`, reasoningEffort: 'medium' })),
})

async function dispatched(planId: string, consolidation: any = consolidation8()) {
  const f = makeFixture(planId)
  const review = await f.runtime.delegateTool(f.leaderAgent, { action: 'review', consolidation, startPhases: MAIN_START_PHASES_FIXTURE })
  assert.equal(review.ok, true, JSON.stringify(review))
  const dispatch = await f.runtime.delegateTool(f.leaderAgent, { action: 'dispatch' })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  return f
}

const selfArgs = (minutes: any, over: any = {}) => ({
  action: 'self_effort', reasoningEffort: 'xhigh',
  complexityRationale: '非常复杂：多夹具融合与冻结契约逐条锁定',
  startPhases: MAIN_START_PHASES_FIXTURE,
  timeNotice: { declaredMinutes: minutes, reason: '夹具预估' },
  ...over,
})
const promptOf = (s: any) => s.request.prompt[0].text
const effortOf = (s: any) => s.request.agentOptions.reasoningEffort
const rowOf = (f: any) => f.record.statuses[0]
async function settle(spawned: any[], from = 0) {
  for (const s of spawned.slice(from)) s.resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: '完成' }] })
  await new Promise((resolve) => setTimeout(resolve, 10))
}
function estimateJournal(planId: string) {
  const read = readDeptMessages(planId, { kind: 'estimate' })
  assert.equal(read.ok, true, JSON.stringify(read))
  return (read as any).messages
}

/* ---------- A1 · self_effort 预估硬门禁（契约 §2/§5） ---------- */

test('A1① 缺 timeNotice ⇒ ESTIMATE_MISSING：不登记、startActivation 未被调用、成员未进入执行态', async () => {
  const f = await dispatched('wp-t6est-a1missing')
  const before = f.spawned.length
  const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(17, { timeNotice: undefined }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ESTIMATE_MISSING')
  assert.ok(r.error.includes(D9), 'error 必须包含 D9 原话')
  assert.match(r.error, /declaredMinutes/, 'error 必须含形状说明')
  assert.match(r.error, /正整数/, 'error 必须写明正整数分钟')
  assert.equal(f.spawned.length, before, '拒绝不得产生 phase-1 接续激活（成员未进入执行态）')
  const row = rowOf(f)
  assert.equal(row.delegateSelfEfforts, undefined, '拒绝不得登记自配档')
  assert.equal(row.delegateStartPhases, undefined, '拒绝不得登记思考产物')
  assert.equal(row.delegateEstimates, undefined, '拒绝不得登记预估')
  assert.equal(row.delegates[0].selfEffort, undefined)
  assert.equal(row.delegates[0].estimate, undefined)
  assert.equal(row.delegates[0].childId, 'member-1', '拒绝不得改写成员 childId（无接续）')
  assert.equal(f.sent.length, 0, '拒绝不得投递')
})

test('A1② 非法值（0/-3/2.5/abc/缺 declaredMinutes/＞10080/非对象）⇒ ESTIMATE_INVALID 硬拒', async () => {
  const f = await dispatched('wp-t6est-a1invalid')
  const before = f.spawned.length
  const badNotices: any[] = [
    { declaredMinutes: 0 }, { declaredMinutes: -3 }, { declaredMinutes: 2.5 },
    { declaredMinutes: 'abc' }, { declaredMinutes: 10081 }, { declaredMinutes: '15' },
    { reason: '缺 declaredMinutes' }, {},
    5, 'abc', [],
  ]
  for (const timeNotice of badNotices) {
    const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(17, { timeNotice }))
    assert.equal(r.ok, false, JSON.stringify({ timeNotice, r }))
    assert.equal(r.code, 'ESTIMATE_INVALID', JSON.stringify({ timeNotice, r }))
    assert.ok(r.error.includes(D9), 'error 必须包含 D9 原话')
  }
  /* null/undefined 属「未携带」边界：MISSING/INVALID 均为合格硬拒（都不得登记/接续）。 */
  for (const timeNotice of [null, undefined]) {
    const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(17, { timeNotice }))
    assert.equal(r.ok, false)
    assert.ok(['ESTIMATE_MISSING', 'ESTIMATE_INVALID'].includes(r.code), JSON.stringify(r))
    assert.ok(r.error.includes(D9))
  }
  assert.equal(f.spawned.length, before, '非法预估一律不得接续')
  assert.equal(rowOf(f).delegateEstimates, undefined, '非法预估一律不得登记')
  assert.equal(f.sent.length, 0)
})

test('A1③ 合法正整数 ⇒ ok:true＋estimate 附回＋登记＋送达负责人＋自配档接续（qwen max→xhigh）', async () => {
  const f = await dispatched('wp-t6est-a1ok')
  const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(17, { reasoningEffort: 'max' }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.selfEffort, 'xhigh', 'qwen max→xhigh 钳制')
  assert.equal(r.estimate?.declaredMinutes, 17)
  assert.equal(r.estimate?.delivery, 'sent')
  assert.equal(r.estimate?.reason, '夹具预估')
  assert.equal(f.spawned.length, 9, '必须新派生 phase-1 激活')
  assert.equal(effortOf(f.spawned[8]), 'xhigh')
  assert.match(promptOf(f.spawned[8]), /phase-0→phase-1 接续/)
  const row = rowOf(f)
  const entry = row.delegates[0].estimate
  assert.equal(entry.declaredMinutes, 17)
  assert.equal(entry.delivery, 'sent')
  assert.ok(entry.at > 0, 'at 必须是正 epochMs')
  assert.equal(typeof entry.messageId, 'string')
  assert.deepEqual(row.delegateEstimates['Expert-A'], entry, '双通道落档一致')
  flushPendingWorkplanUpdates(f.rootSession)
  assert.ok(JSON.stringify(f.rootSession.events).includes('delegateEstimates'), 'durable workplan-update 携带预估台账')
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].targetId, HEAD, '必须投给部门行负责人会话')
  assert.equal(f.sent[0].from, 'member-1')
  assert.ok(f.sent[0].text.includes('【第三层开工预估｜Expert-A → 部门负责人】'), 'body 模板抬头')
  assert.ok(f.sent[0].text.includes('约需 17 分钟（整数分钟）'), 'body 必须写明整数分钟')
  assert.ok(f.sent[0].text.includes('理由：夹具预估'))
  assert.ok(f.sent[0].text.includes('该预估已登记'))
  const messages = estimateJournal('wp-t6est-a1ok')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].from.sessionId, 'member-1')
  assert.equal(messages[0].from.role, 'expert')
  assert.equal(messages[0].from.member, 'Expert-A')
  assert.equal(messages[0].to.sessionId, HEAD)
  assert.equal(messages[0].to.role, 'head')
  assert.equal(messages[0].subtaskId, 'T1')
  assert.deepEqual(messages[0].data, { declaredMinutes: 17, reason: '夹具预估' })
  assert.equal(messages[0].delivery.status, 'sent')
  await settle(f.spawned, 8)
})

test('A1序 校验顺序不变：非法档/缺依据/缺思考先于 timeNotice（旧拒因保持）', async () => {
  const f = await dispatched('wp-t6est-a1order')
  const bad = await f.runtime.delegateTool(f.leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'ultra', complexityRationale: 'x' })
  assert.equal(bad.code, 'SELF_EFFORT_INVALID')
  const noWhy = await f.runtime.delegateTool(f.leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'medium' })
  assert.equal(noWhy.code, 'SELF_EFFORT_RATIONALE_MISSING')
  const noThink = await f.runtime.delegateTool(f.leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'xhigh', complexityRationale: '非常复杂' })
  assert.equal(noThink.code, 'START_EVIDENCE_MISSING', 'startPhases 先于 timeNotice 校验')
  const thin = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(17, { startPhases: { planning: { ...MAIN_START_PHASES_FIXTURE.planning, problemAnalysis: ['看一下'] }, preparation: MAIN_START_PHASES_FIXTURE.preparation } }))
  assert.equal(thin.code, 'START_EVIDENCE_INCOMPLETE')
  assert.equal(f.spawned.length, 8)
})

test('A1③边界 declaredMinutes=1 与 10080 放行；reason 缺省文案「理由：无」', async () => {
  for (const minutes of [1, 10080]) {
    const f = await dispatched(`wp-t6est-bound-${minutes}`)
    const notice = minutes === 1 ? { declaredMinutes: 1 } : { declaredMinutes: 10080, reason: '上限边界' }
    const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(minutes, { timeNotice: notice }))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.estimate?.declaredMinutes, minutes)
    assert.equal(rowOf(f).delegates[0].estimate.declaredMinutes, minutes)
    if (minutes === 1) assert.ok(f.sent[0].text.includes('理由：无'), 'reason 缺省必须写「无」')
    await settle(f.spawned, 8)
  }
})

test('A1④a 重派读档：已配档+已思考但无预估 ⇒ leafPhaseZero 回 phase-0 补交', async () => {
  const f = await dispatched('wp-t6est-a1replay0')
  const legacy = rowOf(f).delegates.map((d: any) => ({ ...d, status: 'failed', ...(d.member === 'Expert-A' ? { selfEffort: 'xhigh', startPhases: MAIN_START_PHASES_FIXTURE } : {}) }))
  f.record.statuses = applyStatus(f.record.statuses, 'T1', {
    delegates: legacy, delegateSelfEfforts: { 'Expert-A': 'xhigh' }, delegateStartPhases: { 'Expert-A': MAIN_START_PHASES_FIXTURE },
  })
  const again = await f.runtime.delegateTool(f.leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  const expertSpawn = f.spawned.filter((s: any) => promptOf(s).includes('Expert-A')).pop()
  assert.ok(expertSpawn, '重派必须产生 Expert-A 激活')
  assert.match(promptOf(expertSpawn), /phase-0/, '未预估的旧叶子必须回 phase-0 补交')
  assert.equal(effortOf(expertSpawn), 'low', 'phase-0 强制 low')
  assert.match(promptOf(expertSpawn), /timeNotice/, 'phase-0 任务书必须写明预估义务')
})

test('A1④b 重派读档：自配档+思考+预估三者齐全 ⇒ 直接 phase-1，接续文案含预估分钟数', async () => {
  const f = await dispatched('wp-t6est-a1replay1')
  const estimate = { declaredMinutes: 17, reason: '读档预估', at: 1500, messageId: 'msg-r', delivery: 'sent' }
  const legacy = rowOf(f).delegates.map((d: any) => ({ ...d, status: 'failed', ...(d.member === 'Expert-A' ? { selfEffort: 'xhigh', startPhases: MAIN_START_PHASES_FIXTURE, estimate } : {}) }))
  f.record.statuses = applyStatus(f.record.statuses, 'T1', {
    delegates: legacy, delegateSelfEfforts: { 'Expert-A': 'xhigh' }, delegateStartPhases: { 'Expert-A': MAIN_START_PHASES_FIXTURE }, delegateEstimates: { 'Expert-A': estimate },
  })
  const again = await f.runtime.delegateTool(f.leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  const expertSpawn = f.spawned.filter((s: any) => promptOf(s).includes('Expert-A') && effortOf(s) === 'xhigh').pop()
  assert.ok(expertSpawn, '三者齐全必须直接 phase-1 读档接续')
  assert.match(promptOf(expertSpawn), /自配档接续/)
  assert.match(promptOf(expertSpawn), /预估/, '接续文案必须追加预估已登记提示')
  assert.ok(promptOf(expertSpawn).includes('17'), '接续文案必须含分钟数')
})

/* ---------- A2 · 8 人场景双通道＋留痕归属（契约 §3/§4） ---------- */

test('A2⑤ 8 成员逐一上报不同分钟数：delegateEstimates 8 键＋delegates[].estimate 8 条＋journal 8 条归属正确', async () => {
  const f = await dispatched('wp-t6est-a2eight', consolidation8())
  assert.equal(f.spawned.length, 8, '复杂任务 8 人表必须全部派发（不得截 6）')
  for (let i = 0; i < 8; i += 1) {
    const r = await f.runtime.delegateTool(f.leafAgent(`member-${i + 1}`), selfArgs(11 + i))
    assert.equal(r.ok, true, JSON.stringify({ i, r }))
    assert.equal(r.estimate?.declaredMinutes, 11 + i)
  }
  assert.equal(f.spawned.length, 16, '8 条 phase-1 接续全部产生')
  const row = rowOf(f)
  assert.equal(row.delegates.length, 8, 'delegates 消毒上限 12，8 人必须全部存活')
  assert.equal(Object.keys(row.delegateEstimates).length, 8, 'delegateEstimates 必须 8 键')
  for (let i = 0; i < 8; i += 1) {
    const name = MEMBERS8[i].member
    const minutes = 11 + i
    assert.equal(row.delegateEstimates[name].declaredMinutes, minutes, `${name} 台账归属`)
    assert.ok(Number.isInteger(row.delegateEstimates[name].declaredMinutes), 'A3 整数存储')
    const entry = row.delegates.find((d: any) => d.member === name)
    assert.equal(entry.estimate.declaredMinutes, minutes, `${name} delegates[].estimate 归属`)
    assert.equal(entry.estimate.delivery, 'sent')
    assert.ok(entry.estimate.at > 0)
    assert.equal(f.sent[i].targetId, HEAD)
    assert.equal(f.sent[i].from, `member-${i + 1}`)
    assert.ok(f.sent[i].text.includes(name), 'body 必须含成员名')
    assert.ok(f.sent[i].text.includes(`约需 ${minutes} 分钟（整数分钟）`))
  }
  assert.equal(f.sent.length, 8)
  const messages = estimateJournal('wp-t6est-a2eight')
  assert.equal(messages.length, 8, 'journal 必须 8 条 kind=estimate')
  for (let i = 0; i < 8; i += 1) {
    const m = messages[i]
    assert.equal(m.from.member, MEMBERS8[i].member, 'from.member 逐一归属')
    assert.equal(m.from.sessionId, `member-${i + 1}`, 'from.sessionId=上报叶子会话')
    assert.equal(m.from.role, MEMBERS8[i].role)
    assert.equal(m.to.sessionId, HEAD, 'to.sessionId=部门行负责人会话')
    assert.equal(m.to.role, 'head')
    assert.equal(m.subtaskId, 'T1')
    assert.equal(m.data.declaredMinutes, 11 + i)
    assert.equal(m.delivery.status, 'sent')
  }
  await settle(f.spawned, 8)
})

test('A2路由 row.childId 缺失 ⇒ 回退 leaderId 投递（契约 §4，不静默失败）', async () => {
  const f = await dispatched('wp-t6est-a2fallback')
  rowOf(f).childId = null
  const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(12))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].targetId, HEAD, '回退目标=叶子父会话（负责人）')
  assert.equal(r.estimate?.delivery, 'sent')
  await settle(f.spawned, 8)
})

/* ---------- A3 · 整数存储与 fail-closed 消毒（契约 §2/§3，对照 sanitizeDelegateEstimate 白名单） ---------- */

test('A3⑥ delegates[].estimate 消毒：合法保留（Number.isInteger）；非法整体丢弃；超限截断', () => {
  const plan = makePlan('wp-t6est-a3sanitize')
  const base = { member: 'Expert-A', role: 'expert', task: '读取目标文件并写出一份结论', effort: 'low', childId: 'member-1', status: 'running', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }
  const put = (estimate: any) => applyStatus(createStatuses(plan), 'T1', { delegates: [{ ...base, estimate }] })[0].delegates[0].estimate
  const good = put({ declaredMinutes: 15, at: 1500, delivery: 'sent', reason: '  理由  ', messageId: 'msg-1' })
  assert.ok(good, '合法 estimate 必须保留')
  assert.ok(Number.isInteger(good.declaredMinutes))
  assert.equal(good.reason, '理由', 'reason trim 后落档')
  assert.equal(put({ declaredMinutes: 1, at: 1500, delivery: 'sent' }).declaredMinutes, 1, '下界 1 合法')
  assert.equal(put({ declaredMinutes: 10080, at: 1500, delivery: 'failed' }).declaredMinutes, 10080, '上界 10080 合法')
  assert.equal(put({ declaredMinutes: 15, at: 1500, delivery: 'sent', reason: 'x'.repeat(400) }).reason.length, 300, 'reason 超限截断 300')
  assert.equal(put({ declaredMinutes: 15, at: 1500, delivery: 'sent', messageId: 'm'.repeat(300) }).messageId.length, 200, 'messageId 超限截断 200')
  for (const declaredMinutes of [0, -3, 2.5, '15', 10081, undefined, null]) {
    assert.equal(put({ declaredMinutes, at: 1500, delivery: 'sent' }), undefined, `declaredMinutes=${String(declaredMinutes)} 必须整体丢弃（不做字符串强转）`)
  }
  for (const at of [0, -5, 'abc', undefined]) {
    assert.equal(put({ declaredMinutes: 15, at, delivery: 'sent' }), undefined, `at=${String(at)} 必须整体丢弃`)
  }
  for (const delivery of ['bogus', 'SENT', undefined]) {
    assert.equal(put({ declaredMinutes: 15, at: 1500, delivery }), undefined, `delivery=${String(delivery)} 必须整体丢弃`)
  }
  for (const estimate of ['x', 5, null]) {
    assert.equal(put(estimate), undefined, '非对象 estimate 必须丢弃')
  }
})

test('A3台账 delegateEstimates：逐键消毒、上限 25（3.1.0 随专家上限扩容）、非法形状抛 INVALID_DELEGATE_ESTIMATES、null 清除', () => {
  const plan = makePlan('wp-t6est-a3map')
  const est = (minutes: any) => ({ declaredMinutes: minutes, at: 1500, delivery: 'sent' })
  const statuses = applyStatus(createStatuses(plan), 'T1', { delegateEstimates: { Good: est(15), Bad: est(2.5), Worse: est(0) } })
  assert.deepEqual(statuses[0].delegateEstimates, { Good: est(15) }, '非法键丢弃、合法键保留')
  assert.ok(Number.isInteger(statuses[0].delegateEstimates.Good.declaredMinutes))
  const many: Record<string, any> = {}
  for (let i = 0; i < 26; i += 1) many[`M-${i}`] = est(10 + i)
  const capped = applyStatus(createStatuses(plan), 'T1', { delegateEstimates: many })
  assert.equal(Object.keys(capped[0].delegateEstimates).length, 25, '上限 25（8–25 人场景全部存活，不得沿用旧 6/12 截断）')
  assert.equal(applyStatus(createStatuses(plan), 'T1', { delegateEstimates: null })[0].delegateEstimates, null)
  for (const bad of ['bogus', 5, []]) {
    assert.throws(
      () => applyStatus(createStatuses(plan), 'T1', { delegateEstimates: bad }),
      (err: any) => err?.code === 'INVALID_DELEGATE_ESTIMATES',
      `delegateEstimates=${JSON.stringify(bad)} 必须抛 INVALID_DELEGATE_ESTIMATES`,
    )
  }
})

/* ---------- D6 · 投递失败显式报错＋重试＋幂等（契约 §4） ---------- */

test('D6⑦ sendMessage 抛错 ⇒ ESTIMATE_DELIVERY_FAILED＋failed 落档＋不接续；重试重投成功后接续；sent 幂等', async () => {
  const f = await dispatched('wp-t6est-d6')
  f.fail.value = true
  const first = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(17))
  assert.equal(first.ok, false)
  assert.equal(first.code, 'ESTIMATE_DELIVERY_FAILED')
  assert.match(first.error, /模拟投递失败/, 'error 必须含失败原因')
  assert.ok(first.error.includes('请重试 self_effort'), 'error 必须指引重试')
  assert.ok(first.error.includes('完整原子对'), 'error 必须要求携带完整原子对')
  assert.equal(f.spawned.length, 8, '投递失败不得接续 phase-1')
  const row = rowOf(f)
  assert.equal(row.delegates[0].estimate.delivery, 'failed', 'failed 必须落档')
  assert.equal(row.delegateEstimates['Expert-A'].delivery, 'failed')
  assert.equal(row.delegates[0].selfEffort, 'xhigh', '登记先于投递：自配档已登记保留')
  const failedJournal = estimateJournal('wp-t6est-d6')
  assert.equal(failedJournal.length, 1)
  assert.equal(failedJournal[0].delivery.status, 'failed')
  /* 重试：重新投递并覆盖 failed → sent，然后接续。 */
  f.fail.value = false
  const retry = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(18))
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(f.sent.length, 1, '重试必须真实重新投递（sent 只计成功投递：首次失败 0 → 重试成功 1）')
  assert.equal(f.sent[0].targetId, HEAD)
  assert.equal(rowOf(f).delegates[0].estimate.delivery, 'sent', '重试成功覆盖 failed')
  assert.equal(rowOf(f).delegates[0].estimate.declaredMinutes, 18)
  assert.equal(rowOf(f).delegateEstimates['Expert-A'].declaredMinutes, 18)
  assert.equal(f.spawned.length, 9, '重试成功后必须接续')
  const retryJournal = estimateJournal('wp-t6est-d6')
  assert.equal(retryJournal.length, 2, '失败与重试都留痕（追加式审计）')
  assert.equal(retryJournal[0].delivery.status, 'failed')
  assert.equal(retryJournal[1].delivery.status, 'sent')
  /* sent 后重复提交：不重复投递，直接继续接续流程（幂等守卫只拦 sent）。 */
  const newChildId = rowOf(f).delegates[0].childId
  const again = await f.runtime.delegateTool(f.leafAgent(newChildId), selfArgs(18))
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(f.sent.length, 1, 'sent 后重复提交不得重复投递（成功投递数不变）')
  assert.equal(rowOf(f).delegates[0].estimate.delivery, 'sent')
  assert.equal(f.spawned.length, 10, '幂等分支直接继续接续流程')
  await settle(f.spawned, 8)
})

test('D6 留痕写失败不掩盖投递结果：ok:true＋journal.JOURNAL_WRITE_FAILED（契约 §4）', async () => {
  const f = await dispatched('wp-t6est-d6jfail')
  const blocker = join(journalDir, 'blocker-file')
  writeFileSync(blocker, 'x', 'utf8')
  const saved = process.env.DSH_WORKPLAN_JOURNAL_DIR
  process.env.DSH_WORKPLAN_JOURNAL_DIR = blocker
  try {
    const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(13))
    assert.equal(r.ok, true, '投递成功不得被留痕失败掩盖')
    assert.ok(r.journal && r.journal.ok === false, '留痕失败必须显式上报')
    assert.equal(r.journal.code, 'JOURNAL_WRITE_FAILED')
    assert.equal(r.estimate?.delivery, 'sent')
    assert.equal(f.spawned.length, 9, '投递成功即满足 D9，照常接续')
  } finally {
    process.env.DSH_WORKPLAN_JOURNAL_DIR = saved
  }
  await settle(f.spawned, 8)
})

/* ---------- 重置保留⑧ ＋ 回放⑨ ＋ 读面透传（契约 §3/§5） ---------- */

test('重置⑧ reset 后 delegateEstimates 仍在（任务级配置）；显式 patch 优先；null 清除', async () => {
  const f = await dispatched('wp-t6est-reset')
  const r = await f.runtime.delegateTool(f.leafAgent('member-1'), selfArgs(17))
  assert.equal(r.ok, true, JSON.stringify(r))
  await settle(f.spawned, 8)
  f.record.statuses = applyStatus(f.record.statuses, 'T1', { status: 'pending' })
  assert.equal(rowOf(f).delegates, undefined, '重置清除尝试痕迹 delegates')
  assert.equal(rowOf(f).delegateEstimates['Expert-A'].declaredMinutes, 17, '预估是任务级配置，重置不清除')
  assert.equal(rowOf(f).delegateEstimates['Expert-A'].delivery, 'sent')
  const explicit = { declaredMinutes: 99, at: 1600, delivery: 'sent' }
  f.record.statuses = applyStatus(f.record.statuses, 'T1', { status: 'pending', delegateEstimates: { 'Expert-A': explicit } })
  assert.deepEqual(rowOf(f).delegateEstimates['Expert-A'], explicit, '显式 patch 优先')
  f.record.statuses = applyStatus(f.record.statuses, 'T1', { status: 'pending', delegateEstimates: null })
  assert.equal(rowOf(f).delegateEstimates, null, '显式 null 清除')
})

test('回放⑨ buildUpdateMessage→parseUpdateMessage→applyStatus / reconstructFromSession 往返不丢＋消毒', () => {
  const plan = makePlan('wp-t6est-replay')
  const estimate = { declaredMinutes: 17, reason: '回放不丢', at: 1500, messageId: 'msg-9', delivery: 'sent' }
  const delegates = [
    { member: 'Expert-A', role: 'expert', task: '读取目标文件并写出一份结论', effort: 'low', childId: 'member-1', status: 'running', estimate, qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    { member: 'Bad-Entry', role: 'expert', task: '读取目标文件并写出一份结论', effort: 'low', childId: 'member-2', status: 'running', estimate: { declaredMinutes: 2.5, at: 1500, delivery: 'sent' }, qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  ]
  const message = buildUpdateMessage({
    planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 2,
    delegates, delegateEstimates: { 'Expert-A': estimate, 'Bad-Entry': { declaredMinutes: 2.5, at: 1500, delivery: 'sent' } },
  })
  const parsed: any = parseUpdateMessage(message)
  assert.ok(parsed, 'update 消息必须可解析')
  assert.deepEqual(parsed.delegateEstimates['Expert-A'], estimate, '写入侧必须携带 delegateEstimates')
  const applied = applyStatus(createStatuses(plan), 'T1', parsed)
  assert.deepEqual(applied[0].delegateEstimates['Expert-A'], estimate)
  assert.equal(applied[0].delegateEstimates['Bad-Entry'], undefined, '非法台账键消毒丢弃')
  assert.deepEqual(applied[0].delegates[0].estimate, estimate)
  assert.equal(applied[0].delegates[1].estimate, undefined, '非法子对象消毒丢弃')
  const session = fakeSession(ROOT, null)
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', message)
  const rebuilt: any = reconstructFromSession(session)
  assert.ok(rebuilt?.plan, '必须能重建计划')
  const row = rebuilt.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.deepEqual(row.delegateEstimates['Expert-A'], estimate, '消费端 patch 必须透传 delegateEstimates（重启不丢）')
  assert.equal(row.delegateEstimates['Bad-Entry'], undefined)
  assert.deepEqual(row.delegates[0].estimate, estimate, 'delegates[].estimate 回放不丢')
})

test('读面透传：derivePlanSnapshot 与 modelStatusLines 均可见 estimate（契约 §3 一处不漏）', () => {
  const plan = makePlan('wp-t6est-readface')
  const estimate = { declaredMinutes: 15, at: 1500, delivery: 'sent' }
  const statuses = applyStatus(createStatuses(plan), 'T1', {
    status: 'in_progress',
    delegates: [{ member: 'Expert-A', role: 'expert', task: '读取目标文件并写出一份结论', effort: 'low', childId: 'member-1', status: 'running', estimate, qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }],
    delegateEstimates: { 'Expert-A': estimate },
  })
  const snapshot: any = derivePlanSnapshot(statuses)
  assert.deepEqual(snapshot.statuses[0].delegateEstimates['Expert-A'], estimate, '快照透传台账')
  assert.deepEqual(snapshot.statuses[0].delegates[0].estimate, estimate, '快照透传子对象')
  const line = modelStatusLines(statuses).find((item: any) => item.subtaskId === 'T1')
  assert.equal(line?.delegates?.[0]?.estimate?.declaredMinutes, 15, '模型可读面 delegates 行必须透出 estimate')
})

/* ---------- 同源⑥ · schema 与任务书文案（契约 §6，A3 单位明确） ---------- */

test('同源⑥a delegate schema：timeNotice 必填原子项（declaredMinutes integer；边界由代码硬校验）＋整数分钟＋错误码告知', () => {
  const tool: any = createDelegateTool({})
  const props = tool.parameters.properties
  const notice = props.timeNotice
  assert.ok(notice, 'delegate schema 必须新增 timeNotice 属性')
  assert.equal(notice.type, 'object')
  assert.equal(notice.properties?.declaredMinutes?.type, 'integer', 'declaredMinutes 必须是 integer')
  /*
   * [3.3.2] 边界表达方式变更（判据不变）：
   * DSH 0.2.3-alpha.2 的 dsh-tools 只接受精简 JSON Schema 子集（type/oneOf/
   * properties/required/additionalProperties/items/enum/const + 注解），
   * `minimum`/`maximum` 会让整个插件注册即抛 UNSUPPORTED_SCHEMA。因此边界从
   * schema 关键字搬到「描述写明 1..10080 + 代码硬校验」，下方用公开写入路径
   * 证明 0、10081 仍被丢弃、10080 仍被接受——边界没有被放宽。
   */
  assert.equal(notice.properties?.declaredMinutes?.minimum, undefined, 'schema 不得再带 minimum（DSH 0.2.3 子集禁止）')
  assert.equal(notice.properties?.declaredMinutes?.maximum, undefined, 'schema 不得再带 maximum（DSH 0.2.3 子集禁止）')
  assert.match(String(notice.properties?.declaredMinutes?.description ?? ''), /1 至 10080/, '边界必须写进描述，不能只说「正整数」')
  assert.ok(notice.required?.includes('declaredMinutes'), 'declaredMinutes 必填')
  assert.match(notice.description, /整数分钟/, 'schema 必须写明整数分钟')
  assert.match(notice.description, /self_effort/, 'schema 必须写明 self_effort 必填')
  assert.match(notice.description, /ESTIMATE_MISSING/)
  assert.match(notice.description, /ESTIMATE_INVALID/)
  assert.match(props.action.description, /timeNotice|开工前预估/, 'action enum 描述同步预估义务')
  const plan = makePlan('wp-t6est-bounds')
  const probe = (minutes: any) => applyStatus(createStatuses(plan), 'T1', {
    status: 'in_progress',
    delegateEstimates: { 'Expert-A': { declaredMinutes: minutes, at: 1500, delivery: 'sent' } },
    delegates: [{
      member: 'Expert-A', role: 'expert', task: '读取目标文件并写出一份结论', effort: 'low',
      childId: 'member-1', status: 'running',
      estimate: { declaredMinutes: minutes, at: 1500, delivery: 'sent' },
      qualityRequirements: ['必须给出命令输出'],
    }],
  })[0]
  assert.equal(probe(0).delegateEstimates?.['Expert-A'], undefined, '0 分钟必须被丢弃（边界硬校验在代码里，不靠 schema 关键字）')
  assert.equal(probe(10081).delegateEstimates?.['Expert-A'], undefined, '超过 10080 分钟必须被丢弃')
  assert.equal(probe(10080).delegateEstimates?.['Expert-A']?.declaredMinutes, 10080, '上边界 10080 必须接受')
})

test('同源⑥b phase-0/叶子任务书与共享 brief：预估义务＋D9 原话；负责人任务书含送达留痕一句', () => {
  const member = { member: 'X', role: 'expert' as const, task: '读取目标文件并写出一份结论', effort: 'low' as const, qualityRequirements: ['必须给出命令输出'] }
  const phase0 = buildPhaseZeroDelegateePrompt({ departmentLabel: '工程', member, cwd: '/tmp' })
  assert.match(phase0, /timeNotice/, 'phase-0 一次性提交清单必须含 timeNotice')
  assert.match(phase0, /整数分钟/)
  assert.ok(phase0.includes(D9), 'phase-0 必须告知 D9 拦截后果原话')
  assert.match(phase0, /ESTIMATE_MISSING/)
  const leaf = buildDelegateePrompt({ departmentLabel: '工程', leaderSubtaskId: 'T1', leaderSubtaskTitle: '部门任务', member, rulesBrief: '', cwd: '/tmp', leadSessionId: HEAD })
  assert.match(leaf, /预估/, '叶子任务书必须写明开工前预估义务')
  assert.match(leaf, /整数分钟/)
  const brief = buildLlmRulesBrief({ model: QWEN, tier: 'delegate', memberRole: 'expert' })
  assert.match(brief, /预估/, '共享 brief 叶子条同步预估义务')
  const plan = makePlan('wp-t6est-headprompt')
  const head = buildChildPrompt({ plan, subtask: plan.stages[0].subtasks[0], stage: plan.stages[0], cwd: '/tmp' })
  assert.ok(head.includes('下属经 self_effort 上报的开工预估（整数分钟）会即时送达你会话并留痕（kind=estimate）；未上报者被平台拦截开工。'), '负责人任务书必须含预估送达留痕一句（契约 §6）')
})
