/*
 * [2.5.1] 主 Agent 两轮深度思考协议（用户 2026-11-11 补充要求）底层机制回归。
 *
 * 用户要求：插件底层机制必须确保主 Agent 自己也做到——执行自己的任务时先
 * 全面、全盘、深入梳理、研究、思考自己的任务（第一轮），再基于第一轮完成好
 * 的所有结果再全面、全盘、深入地开展梳理、研究和思考，理清方法、流程和步骤
 * （第二轮），最后基于第二轮的方法、流程、步骤开始具体执行。
 *
 * 锁六件事：
 *  1. validateMainDeepThink 与执行者层同一口径（40/40/20 字下限），缺产物/
 *     太薄/缺依据都有明确拒因；
 *  2. dsh_workplan_dispatch 首次派发硬门禁：未交 MAIN_DEEP_THINK_MISSING、
 *     不合格 MAIN_DEEP_THINK_INCOMPLETE，拒绝不启动任何子 Agent、不刷派发预告；
 *  3. 合格产物登记到计划记录 + durable workplan-update（计划级，subtaskId=null）；
 *  4. 续跑/重试读档放行；重启回放（reconstructFromSession）消毒抬升不丢；
 *  5. 按 planId 记账：重规划的新计划必须重新两轮思考；终态拒绝顺序不变；
 *  6. PROMPT_SECTION 与工具 schema 同源告知协议与门禁。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, buildUpdateMessage, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'
import { sanitizeMainDeepThink, validateMainDeepThink } from '../src/three-phase.js'
import { PROMPT_SECTION, createDispatchTool } from '../src/host.js'
import { MAIN_DEEP_THINK_FIXTURE } from './helpers/main-deep-think.js'
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
    title: '主 Agent 两轮深度思考回归',
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

/* ---------- 1. 纯逻辑判据（与执行者层同一口径） ---------- */

test('validateMainDeepThink：两轮产物齐全 ⇒ ok 并归一化', () => {
  const check = validateMainDeepThink(MAIN_DEEP_THINK_FIXTURE)
  assert.equal(check.ok, true, JSON.stringify(check))
  assert.deepEqual(check.deepThink, MAIN_DEEP_THINK_FIXTURE)
})

test('validateMainDeepThink：缺产物/非对象 ⇒ MAIN_DEEP_THINK_MISSING，文案含协议与提交方式', () => {
  for (const value of [undefined, null, '一段文字', 42]) {
    const check = validateMainDeepThink(value)
    assert.equal(check.ok, false)
    assert.equal(check.code, 'MAIN_DEEP_THINK_MISSING')
    assert.match(check.error!, /全面、全盘、深入梳理、研究、思考自己的任务/)
    assert.match(check.error!, /deepThink/)
  }
})

test('validateMainDeepThink：第一轮太薄 ⇒ INCOMPLETE', () => {
  const check = validateMainDeepThink({ ...MAIN_DEEP_THINK_FIXTURE, problemAnalysis: ['看一下任务'] })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'MAIN_DEEP_THINK_INCOMPLETE')
  assert.match(check.error!, /problemAnalysis 太薄/)
})

test('validateMainDeepThink：缺第二轮依据 ⇒ INCOMPLETE（依赖不可审计不得放行）', () => {
  const input: any = { ...MAIN_DEEP_THINK_FIXTURE }
  delete input.approachBasis
  const check = validateMainDeepThink(input)
  assert.equal(check.ok, false)
  assert.equal(check.code, 'MAIN_DEEP_THINK_INCOMPLETE')
  assert.match(check.error!, /approachBasis/)
})

test('validateMainDeepThink：第二轮方法流程步骤太薄 / 依据太薄 ⇒ INCOMPLETE', () => {
  const thinApproach = validateMainDeepThink({ ...MAIN_DEEP_THINK_FIXTURE, approach: ['把任务做好'] })
  assert.equal(thinApproach.ok, false)
  assert.match(thinApproach.error!, /approach 太薄/)
  const thinBasis = validateMainDeepThink({ ...MAIN_DEEP_THINK_FIXTURE, approachBasis: ['基于第一轮'] })
  assert.equal(thinBasis.ok, false)
  assert.match(thinBasis.error!, /approachBasis 太薄/)
})

test('sanitizeMainDeepThink：回放消毒——合法归一化、非法/篡改 ⇒ null', () => {
  assert.deepEqual(sanitizeMainDeepThink(MAIN_DEEP_THINK_FIXTURE), MAIN_DEEP_THINK_FIXTURE)
  assert.equal(sanitizeMainDeepThink({ problemAnalysis: ['薄'] }), null)
  assert.equal(sanitizeMainDeepThink(undefined), null)
})

/* ---------- 2. 派发硬门禁 ---------- */

test('dispatchTool：未交两轮产物 ⇒ MAIN_DEEP_THINK_MISSING 硬拒，不启动子 Agent、不刷派发预告', async () => {
  const { runtime, rootAgent, session, spawned } = makeRuntime()
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'MAIN_DEEP_THINK_MISSING')
  assert.match(out.error, /第一轮/)
  assert.match(out.hint, /approachBasis/)
  assert.equal(spawned.length, 0, '门禁拒绝不得启动任何子 Agent')
  assert.ok(!JSON.stringify(session.events).includes('派发预告'), '拒绝路径不得刷派发预告')
})

test('dispatchTool：产物不合格 ⇒ MAIN_DEEP_THINK_INCOMPLETE 硬拒，不启动子 Agent', async () => {
  const { runtime, rootAgent, spawned } = makeRuntime()
  const out: any = await runtime.dispatchTool(rootAgent, {
    mode: 'async',
    deepThink: { ...MAIN_DEEP_THINK_FIXTURE, approachBasis: [] },
  }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'MAIN_DEEP_THINK_INCOMPLETE')
  assert.equal(spawned.length, 0)
})

test('dispatchTool：两轮产物合格 ⇒ 放行派发，登记到记录 + durable 持久化', async () => {
  const { runtime, rootAgent, record, session, spawned } = makeRuntime()
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async', deepThink: MAIN_DEEP_THINK_FIXTURE }, new AbortController().signal)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(spawned.length >= 1, '合格产物必须放行派发')
  assert.deepEqual(record.mainDeepThink, MAIN_DEEP_THINK_FIXTURE)
  assert.equal(record.mainDeepThinkPlanId, 'wp-251-main')
  const durable = session.events.filter((e: any) => e.type === 'user/message' && JSON.stringify(e.data).includes('mainDeepThink'))
  assert.ok(durable.length >= 1, '登记必须写 durable workplan-update（重启不丢）')
  assert.ok(JSON.stringify(durable[durable.length - 1]).includes('workplan-update'))
  releaseAll(spawned)
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('dispatchTool：登记后续跑不带 deepThink ⇒ 读档放行（不重复要求提交）', async () => {
  const { runtime, rootAgent, spawned } = makeRuntime()
  const first: any = await runtime.dispatchTool(rootAgent, { mode: 'async', deepThink: MAIN_DEEP_THINK_FIXTURE }, new AbortController().signal)
  assert.equal(first.ok, true)
  const second: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.ok(second.code !== 'MAIN_DEEP_THINK_MISSING' && second.code !== 'MAIN_DEEP_THINK_INCOMPLETE', `续跑被门禁误拦：${JSON.stringify(second)}`)
  assert.equal(second.ok, true)
  releaseAll(spawned)
  await new Promise((resolve) => setTimeout(resolve, 20))
})

/* ---------- 3. 回放与记账 ---------- */

test('重启回放：durable 计划级产物消毒抬升 ⇒ 续跑读档放行', async () => {
  const plan = makePlan()
  const session = makeSession()
  session.append('user/message', buildPlanMessage(plan))
  session.append('user/message', buildUpdateMessage({
    planId: plan.planId,
    subtaskId: null,
    mainDeepThink: MAIN_DEEP_THINK_FIXTURE,
    mainDeepThinkPlanId: plan.planId,
  }))
  const rebuilt: any = reconstructFromSession(session)
  assert.deepEqual(rebuilt.mainDeepThink, MAIN_DEEP_THINK_FIXTURE, '回放必须抬升计划级两轮产物')
  assert.equal(rebuilt.mainDeepThinkPlanId, plan.planId)

  const { runtime, rootAgent, spawned } = makeRuntime()
  runtime.state.records.set(session.id, rebuilt)
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.ok(out.code !== 'MAIN_DEEP_THINK_MISSING', '重启后续跑必须读档放行')
  assert.equal(out.ok, true, JSON.stringify(out))
  releaseAll(spawned)
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('按 planId 记账：重规划的新计划是新任务 ⇒ 必须重新两轮思考', async () => {
  const { runtime, rootAgent, record } = makeRuntime()
  record.mainDeepThink = MAIN_DEEP_THINK_FIXTURE
  record.mainDeepThinkPlanId = 'wp-old-plan'
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'MAIN_DEEP_THINK_MISSING')
})

test('终态拒绝顺序不变：已取消计划未交 deepThink 仍回 PLAN_CANCELLED', async () => {
  const { runtime, rootAgent, record } = makeRuntime()
  record.cancelled = true
  record.phase = 'cancelled'
  const out: any = await runtime.dispatchTool(rootAgent, { mode: 'async' }, new AbortController().signal)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'PLAN_CANCELLED')
})

/* ---------- 4. 提示词与工具 schema 同源告知 ---------- */

test('PROMPT_SECTION 与 dispatch schema：协议全文 + 门禁码 + deepThink 必填三字段', () => {
  const text = String(PROMPT_SECTION)
  assert.match(text, /主 Agent 两轮深度思考协议/)
  assert.match(text, /先全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(text, /基于刚才第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考/)
  assert.match(text, /方法、流程和步骤/)
  assert.match(text, /MAIN_DEEP_THINK_MISSING/)
  assert.match(text, /MAIN_DEEP_THINK_INCOMPLETE/)
  const tool: any = createDispatchTool({})
  const deepThink = tool.parameters.properties.deepThink
  assert.ok(deepThink, 'dispatch 工具必须暴露 deepThink 参数')
  assert.deepEqual(deepThink.required, ['problemAnalysis', 'approach', 'approachBasis'])
  assert.match(tool.description, /两轮深度思考/)
})