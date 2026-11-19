/*
 * [3.0.8] 主 Agent 五步开工证据协议（用户 2026-11-18 单框架收口）底层机制回归。
 *
 * 历史口径：2.5.1 的「两轮深度思考」开工门禁已废除——两轮内容本就是五步工作法
 * 第 1、2 步的子集，全系统只剩一套五步契约。本文件锁六件事：
 *  1. validateStartPhaseEvidence 与执行者层同一口径（40/40/20/20/10/20 字下限，
 *     缺产物/太薄/缺依据都有明确拒因）；
 *  2. dsh_workplan_dispatch 首次派发硬门禁：未交 START_EVIDENCE_MISSING、
 *     不合格 START_EVIDENCE_INCOMPLETE，拒绝不启动任何子 Agent、不刷派发预告；
 *  3. 合格产物登记到计划记录 + durable workplan-update（计划级，subtaskId=null）；
 *  4. 续跑/重试读档放行；重启回放（reconstructFromSession）消毒抬升不丢；
 *  5. 按 planId 记账：重规划的新计划必须重新提交开工证据；终态拒绝顺序不变；
 *  6. PROMPT_SECTION 与工具 schema 同源告知协议与门禁。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, buildUpdateMessage, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { sanitizeStartPhaseEvidence, validateStartPhaseEvidence } from '../src/five-step.js'
import { PROMPT_SECTION, createDispatchTool } from '../src/host.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
const liveRuntimes: Array<{ runtime: any; session: any }> = []
after(async () => {
  for (const { runtime, session } of liveRuntimes) {
    try {
      await runtime.cancelPlan({ session }, { reason: '测试收尾：停止所有仍在等待的假子会话' })
    } catch {
      // 收尾失败不能掩盖测试结果；下面的 dispatchPromise 仍会等待/超时。
    }
    const pending = runtime.state.records.get(session.id)?.dispatchPromise
    if (pending) {
      await Promise.race([
        pending.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ])
    }
  }
  clearInterval(eventLoopAnchor)
})

function makePlan() {
  return {
    planId: 'wp-251-main',
    sessionId: 'session-root',
    createdTurn: 1,
    createdAt: 1000,
    title: '主 Agent 五步开工证据回归',
    taskUnderstanding: { originalRequest: '优化插件底层机制', deliverable: '补丁' },
    contradictions: { primary: { statement: '质量与时间' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '部门任务',
        department: 'engineering',
        objective: '完成机制改造',
        acceptance: ['有单测证据'],
        outputs: ['补丁'],
        risk: 'low',
        dependsOn: [],
      }],
    }],
  }
}

function makeSession(id = 'session-root') {
  const events: any[] = []
  return {
    id,
    header: { createdAt: 1000, cwd: '/tmp/main-deep-think' },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeRuntime() {
  const plan = makePlan()
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  seedLeaderSelfEffort(session, plan)
  const spawned: any[] = []
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (request: any) => {
        const childId = `child-${spawned.length + 1}`
        let release!: (value: any) => void
        const result = new Promise((resolve) => { release = resolve })
        spawned.push({ childId, request, release })
        return { childId, result, dispose: async () => {} }
      },
    },
    sessions: { get: (id: string) => (id === session.id ? session : undefined), list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    maxResumes: 4,
    strictEvidence: false,
  })
  const statuses: any = createStatuses(plan)
  const record: any = { plan, statuses, updatedAt: 0, errors: [], notices: [] }
  runtime.state.records.set(session.id, record)
  liveRuntimes.push({ runtime, session })
  const rootAgent = { session, options: {} }
  return { runtime, record, session, spawned, rootAgent, plan, ctx }
}

function releaseAll(spawned: any[]) {
  for (const child of spawned) {
    child.release({ stopReason: 'completed', output: [{ type: 'text', text: '完成散文（本文件只考察门禁，不考察证据判定）' }] })
  }
}

/**
 * 归一化比对：validateStartPhaseEvidence/sanitizeStartPhaseEvidence 返回的 evidence
 * 会在 planning 上补空 constraints/unknowns 数组（结算侧形状的同一解析器），
 * 因此逐字段比对实质内容，而不是整体 deepEqual（键集合 intentionally 不同）。
 */
function assertEvidenceMatchesFixture(evidence: any) {
  assert.ok(evidence, 'evidence 不能为空')
  assert.deepEqual(evidence.planning.problemAnalysis, MAIN_START_PHASES_FIXTURE.planning.problemAnalysis)
  assert.deepEqual(evidence.planning.approach, MAIN_START_PHASES_FIXTURE.planning.approach)
  assert.deepEqual(evidence.planning.approachBasis, MAIN_START_PHASES_FIXTURE.planning.approachBasis)
  assert.deepEqual(evidence.planning.resources, MAIN_START_PHASES_FIXTURE.planning.resources)
  assert.deepEqual(evidence.planning.tools, MAIN_START_PHASES_FIXTURE.planning.tools)
  assert.deepEqual(evidence.preparation, MAIN_START_PHASES_FIXTURE.preparation)
}

function fixtureWith(mutate: (input: any) => void) {
  const input: any = structuredClone(MAIN_START_PHASES_FIXTURE)
  mutate(input)
  return input
}

/* ---------- 1. 纯逻辑判据（与执行者层同一口径） ---------- */

test('validateStartPhaseEvidence：五步第 1/2/3 步产物齐全 ⇒ ok 并归一化', () => {
  const check = validateStartPhaseEvidence(MAIN_START_PHASES_FIXTURE)
  assert.equal(check.ok, true, JSON.stringify(check))
  assertEvidenceMatchesFixture(check.evidence)
})

test('validateStartPhaseEvidence：缺产物/非对象 ⇒ START_EVIDENCE_MISSING，文案含协议与提交方式', () => {
  for (const value of [undefined, null, '一段文字', 42]) {
    const check = validateStartPhaseEvidence(value)
    assert.equal(check.ok, false)
    assert.equal(check.code, 'START_EVIDENCE_MISSING')
    assert.match(check.error!, /全面、全盘、深入梳理、研究、思考自己的任务/)
    assert.match(check.error!, /startPhases/)
  }
})

test('validateStartPhaseEvidence：第一步任务梳理太薄 ⇒ START_EVIDENCE_INCOMPLETE', () => {
  const check = validateStartPhaseEvidence(fixtureWith((input) => {
    input.planning.problemAnalysis = ['看一下任务']
  }))
  assert.equal(check.ok, false)
  assert.equal(check.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(check.error!, /problemAnalysis 太薄/)
})

test('validateStartPhaseEvidence：缺第二步依据 ⇒ START_EVIDENCE_INCOMPLETE（依赖不可审计不得放行）', () => {
  const check = validateStartPhaseEvidence(fixtureWith((input) => {
    delete input.planning.approachBasis
  }))
  assert.equal(check.ok, false)
  assert.equal(check.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(check.error!, /approachBasis/)
})

test('validateStartPhaseEvidence：第二步方法流程步骤太薄 / 依据太薄 ⇒ START_EVIDENCE_INCOMPLETE', () => {
  const thinApproach = validateStartPhaseEvidence(fixtureWith((input) => {
    input.planning.approach = ['把任务做好']
  }))
  assert.equal(thinApproach.ok, false)
  assert.equal(thinApproach.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(thinApproach.error!, /approach 太薄/)
  const thinBasis = validateStartPhaseEvidence(fixtureWith((input) => {
    input.planning.approachBasis = ['基于第一步']
  }))
  assert.equal(thinBasis.ok, false)
  assert.equal(thinBasis.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(thinBasis.error!, /approachBasis 太薄/)
})

test('sanitizeStartPhaseEvidence：回放消毒——合法归一化、非法/篡改 ⇒ null', () => {
  assertEvidenceMatchesFixture(sanitizeStartPhaseEvidence(MAIN_START_PHASES_FIXTURE))
  assert.equal(sanitizeStartPhaseEvidence({ planning: { problemAnalysis: ['薄'] } }), null)
  assert.equal(sanitizeStartPhaseEvidence(undefined), null)
  assert.equal(sanitizeStartPhaseEvidence('一段文字'), null)
})

/* ---------- 2. 派发硬门禁 ---------- */

test('dispatchTool：未交开工证据 ⇒ START_EVIDENCE_MISSING 硬拒，不启动子 Agent、不刷派发预告', async () => {
  const { runtime, rootAgent, session, spawned } = makeRuntime()
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'START_EVIDENCE_MISSING')
  assert.match(out.error, /全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(out.hint, /approachBasis/)
  assert.equal(spawned.length, 0, '门禁拒绝不得启动任何子 Agent')
  assert.ok(!JSON.stringify(session.events).includes('派发预告'), '拒绝路径不得刷派发预告')
})

test('dispatchTool：产物不合格 ⇒ START_EVIDENCE_INCOMPLETE 硬拒，不启动子 Agent', async () => {
  const { runtime, rootAgent, spawned } = makeRuntime()
  const out: any = await runtime.dispatchTool(rootAgent, {
    mode: 'async',
    startPhases: fixtureWith((input) => {
      input.planning.approachBasis = []
    }),
  }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'START_EVIDENCE_INCOMPLETE')
  assert.match(out.error, /approachBasis/)
  assert.equal(spawned.length, 0)
})

test('dispatchTool：开工证据合格 ⇒ 放行派发，登记到记录 + durable 持久化', async () => {
  const { runtime, rootAgent, record, session, spawned } = makeRuntime()
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async', startPhases: MAIN_START_PHASES_FIXTURE }, new AbortController().signal)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(spawned.length >= 1, '合格证据必须放行派发')
  assertEvidenceMatchesFixture(record.mainStartPhases)
  assert.equal(record.mainStartPhasesPlanId, 'wp-251-main')
  const durable = session.events.filter((e: any) => e.type === 'user/message' && JSON.stringify(e.data).includes('mainStartPhases'))
  assert.ok(durable.length >= 1, '登记必须写 durable workplan-update（重启不丢）')
  assert.ok(JSON.stringify(durable[durable.length - 1]).includes('workplan-update'))
  releaseAll(spawned)
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('dispatchTool：登记后续跑不带 startPhases ⇒ 读档放行（不重复要求提交）', async () => {
  const { runtime, rootAgent, spawned } = makeRuntime()
  const first: any = await runtime.dispatchTool(rootAgent, { mode: 'async', startPhases: MAIN_START_PHASES_FIXTURE }, new AbortController().signal)
  assert.equal(first.ok, true)
  const second: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.ok(second.code !== 'START_EVIDENCE_MISSING' && second.code !== 'START_EVIDENCE_INCOMPLETE', `续跑被门禁误拦：${JSON.stringify(second)}`)
  assert.equal(second.ok, true)
  releaseAll(spawned)
  await new Promise((resolve) => setTimeout(resolve, 20))
})

/* ---------- 3. 回放与记账 ---------- */

test('重启回放：durable 计划级证据消毒抬升 ⇒ 续跑读档放行', async () => {
  const plan = makePlan()
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId,
    subtaskId: null,
    mainStartPhases: MAIN_START_PHASES_FIXTURE,
    mainStartPhasesPlanId: plan.planId,
  }))
  const rebuilt: any = reconstructFromSession(session)
  assertEvidenceMatchesFixture(rebuilt.mainStartPhases)
  assert.equal(rebuilt.mainStartPhasesPlanId, plan.planId)

  const { runtime, rootAgent, spawned } = makeRuntime()
  runtime.state.records.set(session.id, rebuilt)
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.ok(out.code !== 'START_EVIDENCE_MISSING', '重启后续跑必须读档放行')
  assert.equal(out.ok, true, JSON.stringify(out))
  releaseAll(spawned)
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('按 planId 记账：重规划的新计划是新任务 ⇒ 必须重新提交开工证据', async () => {
  const { runtime, rootAgent, record } = makeRuntime()
  record.mainStartPhases = MAIN_START_PHASES_FIXTURE
  record.mainStartPhasesPlanId = 'wp-old-plan'
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'START_EVIDENCE_MISSING')
})

test('终态拒绝顺序不变：已取消计划未交 startPhases 仍回 PLAN_CANCELLED', async () => {
  const { runtime, rootAgent, record } = makeRuntime()
  record.cancelled = true
  record.phase = 'cancelled'
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'PLAN_CANCELLED')
})

/* ---------- 4. 提示词与工具 schema 同源告知 ---------- */

test('PROMPT_SECTION 与 dispatch schema：五步协议全文 + 门禁码 + startPhases 必填形状', () => {
  const text = String(PROMPT_SECTION)
  assert.match(text, /主 Agent 五步开工证据协议/)
  assert.match(text, /全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(text, /基于刚才第一步完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考/)
  assert.match(text, /方法、流程和步骤/)
  assert.match(text, /START_EVIDENCE_MISSING/)
  assert.match(text, /START_EVIDENCE_INCOMPLETE/)
  assert.doesNotMatch(text, /两轮深度思考/, '3.0.8 起两轮深度思考协议已废除，不得再出现')
  assert.doesNotMatch(text, /MAIN_DEEP_THINK/, '旧门禁码已废除，不得再出现')
  const tool: any = createDispatchTool({})
  const startPhases = tool.parameters.properties.startPhases
  assert.ok(startPhases, 'dispatch 工具必须暴露 startPhases 参数')
  assert.deepEqual(startPhases.required, ['planning', 'preparation'])
  assert.deepEqual(startPhases.properties.planning.required, ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'])
  assert.deepEqual(startPhases.properties.preparation.required, ['prepared', 'evidence'])
  assert.match(tool.description, /五步开工证据协议/)
  assert.match(tool.description, /START_EVIDENCE_MISSING/)
  assert.doesNotMatch(tool.description, /两轮深度思考/)
})
