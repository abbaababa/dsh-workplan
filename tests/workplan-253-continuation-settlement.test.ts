/*
 * [2.5.2][T4b] D1 叶子接续死亡 + D2 陈旧结算误采纳——治本补丁回归。
 *
 * 缺陷现场（reports/D1-D2-root-cause-diagnosis.md，用户 2026-11-12 硬要求
 * 「查明并必须修复 T1/T2 四个叶子子任务自动停止」）：
 *  D1：selfEffortTool 在 interrupt 之后用属性访问 `(ctx as any).agents?.get?.()`
 *      取负责人 agent；inject 清单不含 'agents'，Cordis 代理对未注入服务的属性
 *      访问直接抛错（可选链挡不住代理 getter），异常位于 interrupt 之后、
 *      startActivation 之前且无 try/catch ⇒ 接续从未创建、失败台账不可达，
 *      四个叶子永久死亡。
 *  D2：结果块缺失时的盘上备份恢复路径读固定文件名即采纳，无归属/新鲜度校验
 *      ⇒ 误采纳陈旧跨任务结算（T1 假完成、T2 误 blocked，级联冻结下游）。
 *
 * 修复后的契约（本文件逐条钉死，对应诊断 §3 测试清单）：
 *  D1-1 属性访问抛错但 ctx.get('agents') 可用 ⇒ 自配成功：解析先于 interrupt、
 *       parent=负责人 agent、effort=自配档、signal 独立于调用方且不中止、
 *       childId 台账更新；安全访问器绝不触碰代理属性。
 *  D1-2 agents 服务不可用 ⇒ 不中断 phase-0、显式 SELF_EFFORT_CONTINUATION_FAILED、
 *       自配档与思考产物登记保留，重派读档直连 phase-1。
 *  D1-3 startActivation 连续两次失败 ⇒ 既有失败台账路径不回归。
 *  D2-1 陈旧备份（mtime<startedAt）⇒ 拒绝采纳、errors 审计留痕、落回
 *       EVIDENCE_MISSING 有界回喂。
 *  D2-2 新鲜且归属匹配（含额外顶层字段 planId/subtaskId/childId）⇒ 照常采纳，
 *       [2.2.9] 恢复能力不回归；adjudicateResult 对额外顶层字段容忍。
 *  D2-3 新鲜但 planId 不匹配 ⇒ 拒绝采纳。
 *  D2-4 新鲜但 subtaskId 不匹配（标记块包裹的第二入口）⇒ 拒绝采纳。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkplanRuntime } from '../src/runtime.js'
import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  applyStatus,
  buildPlanMessage,
  createStatuses,
} from '../src/plan.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'

process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `t4b-253-lessons-${process.pid}.jsonl`,
)

const QWEN = 'qwen3-max-preview'

/* ------------------------------------------------------------------ */
/* D1 夹具：250 自配档夹具 + Cordis 代理抛错模拟                        */
/* ------------------------------------------------------------------ */

function makeD1Plan() {
  return {
    planId: 'wp-253-d1', sessionId: 'session-root', createdTurn: 1, createdAt: 1000, title: 'D1 接续回归',
    // [T10][E-A] 夹具适配：计划行声明复杂档，通过 2.5.5 low 禁派闸（未配置视同 low）；
    // 行档位不进入 declaredEffort ⇒ 不触发 ≥8 人闸，2 人分工与既有断言保持不变。
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '部门任务', department: 'engineering', dependsOn: [], reasoningEffort: 'high' }] }],
  }
}

function makeD1Runtime(opts: { failContinuation?: boolean; agentsUnavailable?: boolean } = {}) {
  const plan = makeD1Plan()
  const events: any[] = []
  const rootSession: any = {
    id: 'session-root', header: { createdAt: 1000, cwd: '/tmp/t4b-cwd' },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq], events,
  }
  const leaderSession: any = { id: 'child-leader', header: { createdAt: 1000, parentSession: 'session-root', cwd: '/tmp/t4b-cwd' }, append() {}, events: [] }
  const spawned: any[] = []
  const spawnAttempts = { count: 0 }
  const interrupts: any[] = []
  const order: string[] = []
  const leaderAgent: any = { session: leaderSession, options: { provider: 'qw', model: QWEN } }
  const agentsService = { get: (id: string) => (id === 'child-leader' ? leaderAgent : undefined) }
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (request: any) => {
        spawnAttempts.count += 1
        if (opts.failContinuation && spawnAttempts.count > 2) throw new Error('spawn rejected')
        const childId = `member-${spawned.length + 1}`
        let resolveResult: any
        const result = new Promise((resolve) => { resolveResult = resolve })
        spawned.push({ childId, request, resolveResult })
        return { childId, result, dispose: async () => {} }
      },
      interruptByParent: (childId: string, parentId: string, mode: string) => {
        order.push('interrupt')
        interrupts.push({ childId, parentId, mode })
        return { ok: true }
      },
      // [T6] 预估送达通道 stub：self_effort 登记后经 sendMessage 投给负责人（缺此函数会 ESTIMATE_DELIVERY_FAILED）。
      sendMessage: async () => 'msg-253-stub',
    },
    sessions: { get: (id: string) => (id === 'session-root' ? rootSession : id === 'child-leader' ? leaderSession : undefined), list: () => [], eventAt: () => undefined },
    // 宿主同款安全访问器（普通函数 mock）：ctx.get('agents') 可用。
    get: (name: string) => {
      if (name === 'agents') {
        order.push('resolve:agents')
        return opts.agentsUnavailable ? undefined : agentsService
      }
      return undefined
    },
  }
  // Cordis 上下文代理模拟：对未注入服务的属性访问直接抛错（可选链挡不住）。
  let agentsPropertyHits = 0
  Object.defineProperty(ctx, 'agents', {
    configurable: true,
    get() {
      agentsPropertyHits += 1
      throw new Error('cannot get property "agents" without inject')
    },
  })
  const runtime: any = createWorkplanRuntime(ctx, { version: 'test-version' })
  const statuses: any = createStatuses(plan)
  statuses[0].status = 'in_progress'
  statuses[0].childId = 'child-leader'
  const record = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set('session-root', record)
  return { runtime, record, spawned, spawnAttempts, interrupts, order, leaderAgent, ctx, agentsPropertyHits: () => agentsPropertyHits }
}

const consolidation = () => ({
  // [2.5.4][T3R1] 夹具适配：补足合计字数 ≥40/40/20（断言意图零改动）。
  problemAnalysis: ['现状：任务拆给专家与组员；目标是保质保量完成；约束是不改无关文件；边界是只做分内工作。'],
  approach: ['专家做核心实现：先确认入口再最小改动，并附聚焦单测自测；组员整理证据清单并逐条核对验收。'],
  approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与时间的主要矛盾决定专家承担核心实现、组员承担自测与证据，约束决定不改无关文件。'],
  assignments: [
    { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', reasoningEffort: 'low', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
    { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] },
  ],
})
const leafAgent = (childId: string) => ({ session: { id: childId, header: { parentSession: 'child-leader', cwd: '/tmp/t4b-cwd' } }, options: { provider: 'qw', model: QWEN } })
const promptOf = (s: any) => s.request.prompt[0].text
const effortOf = (s: any) => s.request.agentOptions.reasoningEffort

test('D1-1：属性访问 agents 抛错但 ctx.get 可用 ⇒ 解析先于 interrupt、parent=负责人 agent、自配档接续、signal 独立不中止、childId 台账更新', async () => {
  const { runtime, record, spawned, interrupts, order, leaderAgent, agentsPropertyHits } = makeD1Runtime()
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const caller = new AbortController()
  const r = await runtime.delegateTool(
    leafAgent('member-1'),
    { action: 'self_effort', reasoningEffort: 'medium', complexityRationale: '跨模块根因排查，验证难度中等偏上', deepThink: MAIN_DEEP_THINK_FIXTURE, timeNotice: { declaredMinutes: 15, reason: '跨模块根因排查，验证难度中等偏上' } },
    caller.signal,
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(spawned.length, 3, '接续必须新派生 phase-1 激活')
  assert.equal(effortOf(spawned[2]), 'medium', 'phase-1 以自配档激活')
  assert.equal(spawned[2].request.parent, leaderAgent, 'startActivation 必须拿到精确的存活负责人 agent 对象（宿主血缘校验）')
  assert.notEqual(spawned[2].request.signal, caller.signal, '接续 signal 不得复用调用方（phase-0 回合）signal')
  assert.equal(spawned[2].request.signal.aborted, false)
  caller.abort()
  assert.equal(spawned[2].request.signal.aborted, false, '调用方 signal 中止不得连带取消平台驱动的接续')
  const resolveAt = order.indexOf('resolve:agents')
  const interruptAt = order.indexOf('interrupt')
  assert.ok(resolveAt >= 0 && interruptAt >= 0 && resolveAt < interruptAt, '负责人解析必须先于 interrupt（解析失败就不中断）')
  assert.deepEqual(interrupts[0], { childId: 'member-1', parentId: 'child-leader', mode: 'continuable' })
  assert.equal(agentsPropertyHits(), 0, '安全访问器路径绝不触碰会抛错的代理属性')
  const row = record.statuses[0]
  assert.equal(row.delegates[0].selfEffort, 'medium')
  assert.equal(row.delegates[0].childId, 'member-3', '台账 childId 更新为 phase-1 会话')
  assert.match(promptOf(spawned[2]), /phase-0→phase-1 接续/)
  assert.match(promptOf(spawned[2]), /继续勿重做/)
})

test('D1-2：agents 服务不可用 ⇒ 不中断 phase-0、显式 SELF_EFFORT_CONTINUATION_FAILED、登记保留且重派读档直连 phase-1', async () => {
  const { runtime, record, spawned, interrupts, leaderAgent } = makeD1Runtime({ agentsUnavailable: true })
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const r = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'medium', complexityRationale: '中等复杂度', deepThink: MAIN_DEEP_THINK_FIXTURE, timeNotice: { declaredMinutes: 15, reason: '中等复杂度' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SELF_EFFORT_CONTINUATION_FAILED', '解析失败必须显式报错，绝不静默')
  assert.match(String(r.error), /agents 服务不可用/)
  assert.equal(interrupts.length, 0, '解析失败不得中断 phase-0（旧缺陷正是中断后抛错致叶子永久死亡）')
  assert.equal(spawned.length, 2, '不产生接续会话')
  const row = record.statuses[0]
  assert.equal(row.delegateSelfEfforts['Expert-A'], 'medium', '自配档登记保留')
  assert.ok(row.delegateDeepThinks['Expert-A'], '两轮思考产物登记保留')
  assert.equal(row.delegates[0].status, 'failed', '失败台账可见，负责人可重派')
  // 重派读档：重置后重新 review+dispatch，Expert-A 直接以自配档 phase-1 接续。
  record.statuses = applyStatus(record.statuses, 'T1', { status: 'pending' })
  record.statuses[0].status = 'in_progress'
  record.statuses[0].childId = 'child-leader'
  const reReview = await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  assert.equal(reReview.ok, true, JSON.stringify(reReview))
  const again = await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  assert.equal(again.ok, true, JSON.stringify(again))
  const expertSpawn = spawned.find((s: any) => promptOf(s).includes('Expert-A') && effortOf(s) === 'medium' && promptOf(s).includes('自配档接续'))
  assert.ok(expertSpawn, '登记保留 ⇒ 重派读档直接以自配档接续 phase-1（不再 phase-0）')
})

test('D1-3：startActivation 连续两次失败 ⇒ 既有失败台账路径不回归（重试恰 1 次、禁止静默降档、自配档保留）', async () => {
  const { runtime, record, spawned, spawnAttempts, interrupts, leaderAgent } = makeD1Runtime({ failContinuation: true })
  await runtime.delegateTool(leaderAgent, { action: 'review', consolidation: consolidation() })
  await runtime.delegateTool(leaderAgent, { action: 'dispatch' })
  const r = await runtime.delegateTool(leafAgent('member-1'), { action: 'self_effort', reasoningEffort: 'medium', complexityRationale: '中等复杂度', deepThink: MAIN_DEEP_THINK_FIXTURE, timeNotice: { declaredMinutes: 15, reason: '中等复杂度' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SELF_EFFORT_CONTINUATION_FAILED')
  assert.equal(spawnAttempts.count, 4, '2 次 phase-0 成功 + 2 次接续尝试失败（恰重试 1 次）')
  assert.equal(spawned.length, 2, '失败的接续尝试不产生会话')
  assert.equal(interrupts.length, 1, '解析成功 ⇒ 照常中断 phase-0')
  const row = record.statuses[0]
  assert.equal(row.delegates[0].status, 'failed')
  assert.match(row.delegates[0].error, /禁止静默降档/)
  assert.equal(row.delegates[0].selfEffort, 'medium', '自配档保留，重派直接沿用')
  assert.equal(row.delegateSelfEfforts['Expert-A'], 'medium')
})

/* ------------------------------------------------------------------ */
/* D2 夹具：evidence-missing-retry 结算路径 + 真实临时文件 mtime 控制    */
/* ------------------------------------------------------------------ */

function phasesFixture() {
  return {
    planning: {
      problemAnalysis: ['现状：陈旧备份被无校验采纳致假完成/误 blocked；约束：缺失永不计 done、恢复能力不回归；主要矛盾：恢复路径必须加归属与新鲜度闸；边界：只改备份采纳闸与提示词。'],
      constraints: ['缺失永不计 done', '有界重试不无限循环'],
      unknowns: [],
      approach: ['第 1 步：本次新写带 planId/subtaskId 的备份 → 产出结构化结算 → 证明：行状态 done 且 verification=structured'],
      approachBasis: ['第二轮的方法、流程、步骤基于第一轮完成好的全部结果：现状与主要矛盾决定先验证入口再最小改动，约束决定不改无关文件，验收标准决定每一步的留证方式。'],
      resources: ['现有代码库与只读权限：本任务所需源文件、测试与运行环境均已确认可用', '任务数据与验收标准：来自计划行，已核对'],
      tools: ['TypeScript 编译与 node 测试运行器：用于改码后自检', '文件读写与命令执行工具：用于执行与留证'],
    },
    preparation: {
      prepared: ['源文件、测试环境与验收标准均已就位：工作目录可读写，依赖已安装'],
      evidence: ['ls 与 node -v 输出正常；测试运行器可启动'],
    },
    execution: { steps: ['本次新写结算备份并补交结果块'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: 'A1 通道可用', method: 'node --test', evidence: 'pass 输出' }],
      requirementCheck: '逐条核对通过',
      retrospective: {
        problems: ['现象：陈旧跨任务备份被采纳；根因：固定文件名复用且采纳前无归属/新鲜度校验。'],
        detours: [],
        resolutions: ['采纳前加新鲜度+归属闸，拒绝留痕并落回 EVIDENCE_MISSING 有界回喂。'],
        prevention: ['遇到固定路径恢复文件先校验归属与新鲜度再采纳；备份必须本次新写并带 planId/subtaskId。'],
      },
    },
  }
}

function backupPayload(extra: Record<string, any> = {}) {
  return {
    status: 'done',
    blockedReason: '',
    phases: phasesFixture(),
    acceptance: [{ criterion: 'A1 通道可用', result: 'pass', evidence: '盘上备份' }],
    artifacts: [],
    needs: [],
    ...extra,
  }
}

function compliantOutput() {
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(backupPayload())}\n${EVIDENCE_MARKER_END}`
}

function proseOnly() {
  return '活干完了，报告如下：一切正常。（忘记附结果块）'
}

function makeD2Plan() {
  return {
    planId: 'wp-253-settle',
    title: 'D2 结算闸验收',
    taskUnderstanding: { originalRequest: '验证备份采纳闸', deliverable: '不误采纳' },
    contradictions: { primary: { statement: '恢复与严格性并存' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: '交付', rationale: '落盘优先', checkpoint: '可核对',
      subtasks: [{
        id: 'T1', title: '实现通道', department: 'engineering', role: 'engineer',
        objective: '实现通道并通过验收', method: ['实现', '测试'], inputs: [], outputs: [],
        acceptance: ['通道可用'], risk: '低', dependsOn: [],
      }],
    }],
  }
}

function makeD2Runtime(outputs: string[], cwd: string) {
  const prompts: string[] = []
  const events: any[] = []
  const session: any = {
    id: 'session-253-settle',
    header: { createdAt: 1000, cwd },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
  session.append('user/message', buildPlanMessage(makeD2Plan()))
  seedLeaderSelfEffort(session, makeD2Plan())
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        const prompt = String(activation?.prompt?.[0]?.text ?? '')
        prompts.push(prompt)
        const output = outputs.shift() ?? compliantOutput()
        return {
          childId: `child-253-${prompts.length}`,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
          dispose: async () => {},
        }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000, idleTimeoutMs: 30_000, childTimeoutMs: 20_000,
    maxResumes: 4, autoResume: false,
  })
  return { session, runtime, prompts }
}

function makeBackupCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-wp-253-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  return cwd
}

function writeBackup(cwd: string, text: string, mtime: Date) {
  const file = join(cwd, 'reports', 'wp-settlement-T1.json')
  writeFileSync(file, text)
  utimesSync(file, mtime, mtime)
  return file
}

const rowOf = (out: any, id = 'T1') => (Array.isArray(out?.statuses) ? out.statuses : []).find((item: any) => item.subtaskId === id)
const recordOf = (runtime: any, session: any) => runtime.state.records.get(session.id)

test('D2-1：陈旧备份（mtime<startedAt）+结果块缺失 ⇒ 拒绝采纳、errors 审计留痕、落回 EVIDENCE_MISSING 回喂后正常 done', async () => {
  const cwd = makeBackupCwd()
  writeBackup(cwd, JSON.stringify(backupPayload({ planId: 'wp-253-settle', subtaskId: 'T1' })), new Date(Date.now() - 3_600_000))
  const { session, runtime, prompts } = makeD2Runtime([proseOnly(), compliantOutput()], cwd)
  const result: any = await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE }, new AbortController().signal)
  const row = rowOf(result)
  assert.equal(prompts.length, 2, '陈旧备份不得采纳：必须落回 EVIDENCE_MISSING 有界回喂')
  assert.match(prompts[1], /结果块缺失/, '回喂文案点名缺失')
  assert.match(prompts[1], /勿重做已完成的工作/)
  assert.equal(row?.status, 'done', '回喂补交后正常结算（恢复能力不回归）')
  const record = recordOf(runtime, session)
  const audit = (record?.errors ?? []).filter((line: string) => line.includes('拒绝采纳盘上结算备份'))
  assert.ok(audit.length >= 1, '拒绝必须写 errors 审计行')
  assert.match(audit[0], /陈旧备份/)
  assert.match(audit[0], /mtime=/)
  assert.match(audit[0], /startedAt=/)
})

test('D2-2：新鲜且归属匹配的备份（含额外顶层字段）⇒ 单次激活即采纳；adjudicateResult 对额外顶层字段容忍', async () => {
  const cwd = makeBackupCwd()
  const future = new Date(Date.now() + 60_000)
  writeBackup(cwd, JSON.stringify(backupPayload({ planId: 'wp-253-settle', subtaskId: 'T1', childId: 'child-253-x' })), future)
  const { session, runtime, prompts } = makeD2Runtime([proseOnly()], cwd)
  const result: any = await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE }, new AbortController().signal)
  const row = rowOf(result)
  assert.equal(prompts.length, 1, '新鲜且归属匹配 ⇒ 不回喂不重做（[2.2.9] 恢复能力不回归）')
  assert.equal(row?.status, 'done')
  const record = recordOf(runtime, session)
  assert.ok((record?.errors ?? []).some((line: string) => line.includes('已采纳盘上结算备份')), '采纳来源留档')
  // 额外顶层字段容忍：同一 payload 直接过 adjudicateResult 仍判 structured。
  const verdict = adjudicateResult({
    output: JSON.stringify(backupPayload({ planId: 'wp-253-settle', subtaskId: 'T1', childId: 'child-253-x' })),
    strict: true,
    expectedAcceptance: ['通道可用'],
  })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.verification, 'structured')
})

test('D2-3：新鲜但 planId 不匹配 ⇒ 拒绝采纳、审计留痕、落回 EVIDENCE_MISSING 回喂', async () => {
  const cwd = makeBackupCwd()
  writeBackup(cwd, JSON.stringify(backupPayload({ planId: 'wp-other-plan', subtaskId: 'T1' })), new Date(Date.now() + 60_000))
  const { session, runtime, prompts } = makeD2Runtime([proseOnly(), compliantOutput()], cwd)
  const result: any = await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE }, new AbortController().signal)
  assert.equal(prompts.length, 2, '跨计划备份不得采纳')
  assert.equal(rowOf(result)?.status, 'done', '回喂补交后正常结算')
  const record = recordOf(runtime, session)
  const audit = (record?.errors ?? []).filter((line: string) => line.includes('拒绝采纳盘上结算备份'))
  assert.ok(audit.length >= 1)
  assert.match(audit[0], /归属不匹配/)
  assert.match(audit[0], /planId=wp-other-plan/)
})

test('D2-4：新鲜但 subtaskId 不匹配（标记块包裹的第二入口）⇒ 拒绝采纳、审计留痕', async () => {
  const cwd = makeBackupCwd()
  const wrapped = `备份说明。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(backupPayload({ planId: 'wp-253-settle', subtaskId: 'T9' }))}\n${EVIDENCE_MARKER_END}`
  writeBackup(cwd, wrapped, new Date(Date.now() + 60_000))
  const { session, runtime, prompts } = makeD2Runtime([proseOnly(), compliantOutput()], cwd)
  const result: any = await runtime.dispatchTool({ session, options: {} }, { deepThink: MAIN_DEEP_THINK_FIXTURE }, new AbortController().signal)
  assert.equal(prompts.length, 2, '跨子任务备份不得采纳（标记块内 JSON 同样过归属闸）')
  assert.equal(rowOf(result)?.status, 'done')
  const record = recordOf(runtime, session)
  const audit = (record?.errors ?? []).filter((line: string) => line.includes('拒绝采纳盘上结算备份'))
  assert.ok(audit.length >= 1)
  assert.match(audit[0], /subtaskId=T9/)
})
