/*
 * [3.1.4] 「用户已同意、插件却毫无反应」二次治本 · 回归测试。
 *
 * 事故（2026-11-20 本会话 session-a9232d63，计划 wp-cff638b6）：用户对计划回复
 * 「全部按你建议执行」，插件一声不响，计划 0/13 一直挂着。源码级根因两条：
 *
 *  ① 分类器方法错：isUserConfirmation 用「词表穷举 + 剥到空」判定，残留的「全部」
 *     二字吃不掉，整句判 false。实测 27 条日常同意句漏判 25 条——不是缺某个词，
 *     是用封闭词表穷举开放句式，必然持续复发；
 *  ② 兜底缺失：pre-step 遇见「认可闸门按住」的计划直接 `return downstream`，
 *     既不派发也不提示，用户永远不知道闸门卡在哪。
 *
 * 本文件同时钉住三个契约（防修复扩大或退化）：
 *   A. 自然同意句式必须识别（模板通道 + 词表通道并集）；
 *   B. 含实质内容/否定/超长的回复必须仍然排除，绝不吞掉新任务；
 *   C. 闸门按住时：确认回复自动解除并下达派发指令；非确认回复必须给出可见提示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { isUserConfirmation, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { PROMPT_SECTION, PLUGIN_VERSION, meta } from '../src/host.js'

const WORKSPACE = '/work'
const SESSION_ID = 'session-3-1-4-confirmation'
const TASK_TEXT = '总任务：预判159667工业母机ETF国泰明天至月底走势，经用户认可后再开始执行'

function userMsg(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function makeSession() {
  // 真实宿主此时（turn≥2）surface 上已有受保护系统头；appendUserMessage 在头落地前
  // 会暂存而非落盘（[2.5.3] 重启回放校验治本）。桩会话必须模拟该前置事实，
  // 否则断言的是「暂存队列」而不是「用户可见通知」。
  const events: any[] = [{ type: 'system/message', data: { id: 'sys-head' } }]
  return {
    id: SESSION_ID,
    header: { createdAt: 1000, cwd: WORKSPACE },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makePlan(planId = 'wp-3-1-3-confirmation') {
  return {
    planId,
    sessionId: SESSION_ID,
    createdTurn: 1,
    createdAt: 1000,
    title: '认可闸门回归',
    stages: [{
      id: 'S1',
      name: '验证',
      subtasks: [{ id: 'T1', title: '验证', department: 'qa', dependsOn: [] }],
    }],
  }
}

function makeRecord(plan: any): any {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    dispatchHold: { kind: 'keyword', reason: '等待用户认可', at: plan.createdAt },
  }
}

function makeRuntime(record: any, session: any) {
  const ctx = {
    logger: { warn() {} },
    get: () => undefined,
    subagents: { startActivation: async () => { throw new Error('these tests never dispatch') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, cwd: WORKSPACE })
  if (!runtime.state.planningInFlight) runtime.state.planningInFlight = new Map()
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

async function preStep(runtime: any, session: any, messages: any[], turn = 2) {
  return runtime.onPreStep(
    { agent: { session }, step: 1, turn, messages },
    async () => ({ kind: 'enter' }),
  )
}

/* ---------------- A. 自然同意句式必须识别 ---------------- */

test('3.1.4：日常同意句式 30 例必须全部识别为确认（事故原句在首位）', () => {
  const positives = [
    // 事故原句
    '全部按你建议执行',
    // 量化/程度副词开头
    '全部同意',
    '全都同意',
    '完全同意',
    '完全按你的建议办',
    '一律同意',
    '统统同意',
    '一并同意',
    '我全部同意',
    '我完全同意',
    '完全没问题',
    '全部没问题',
    '全按你的建议',
    '全按你说的做',
    '完全照你说的做',
    '全部照办',
    // 带「的/建议/执行」的完整句式
    '一切都按你的建议来',
    '就按你说的全部执行',
    '按你说的办',
    '就按这个方案执行',
    '同意全部按你建议执行',
    '好的，全部按您建议执行',
    '全部都按您说的办',
    '就这样，全部执行',
    // 听你的
    '都听你的',
    '全听你的',
    // 语气词/寒暄开头 + 完整按-句式（用户真实打字习惯）
    '好，全部按你说的做',
    '没问题，按计划执行',
    '同意，按计划执行',
    '可以，按你的建议执行',
  ]
  for (const text of positives) {
    assert.equal(isUserConfirmation(text), true, `应识别为确认：${text}`)
  }
})

test('3.1.4：原有 3.0.7 正例不得退化', () => {
  const positives = ['按你的建议执行', '好', '行', '同意', '认可', '确认', '就按这个来', '照办', '开始吧', 'OK']
  for (const text of positives) {
    assert.equal(isUserConfirmation(text), true, `应识别为确认：${text}`)
  }
})

/* ---------------- B. 反例必须仍然排除（防吞掉新任务） ---------------- */

test('3.1.4：含实质内容/否定/超长的回复必须排除', () => {
  const negatives = [
    '可以，但范围改成X',
    '同意，先只做第一部分',
    '确认，不过预算减半',
    '确认一下进度',
    '可以帮我看看吗',
    '确认明天几点开始？',
    '请分析明天的走势',
    '继续修复登录问题',
    '全部重新预判',
    '全部重做',
    '不好',
    '不是',
    '不对',
    '不同意',
    '不行',
    '还没想好',
    '先别开始',
    '暂不执行',
    '我考虑一下',
    '好'.repeat(25),
  ]
  for (const text of negatives) {
    assert.equal(isUserConfirmation(text), false, `必须排除：${text}`)
  }
})

/* ---------------- C. 闸门按住时的可见性 ---------------- */

test('3.1.4：闸门按住 + 「全部按你建议执行」→ 自动解除闸门并下达派发指令（事故现场复演）', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session)

  await preStep(runtime, session, [userMsg(TASK_TEXT), userMsg('全部按你建议执行')])

  assert.equal(record.dispatchHold, null, '确认回复必须自动解除认可闸门')
  const serialized = JSON.stringify(session.events)
  assert.ok(serialized.includes('dsh_workplan_dispatch'), '必须向主 Agent 下达派发指令')
  assert.equal(record.dispatchedAt, undefined, '派发动作仍由主 Agent 执行，钩子层不机械开跑')
})

test('3.1.4：闸门按住 + 非确认回复 → 必须给出可见提示且不自动派发', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session)

  await preStep(runtime, session, [userMsg(TASK_TEXT), userMsg('这个方案我还有别的想法')])

  const serialized = JSON.stringify(session.events)
  assert.ok(serialized.includes('计划仍在等待您的明确认可'), '不得静默：必须提示闸门仍按住')
  assert.ok(serialized.includes('dsh_workplan_release'), '必须给出放行方式')
  assert.equal(record.dispatchedAt, undefined, '非确认回复不得触发派发')
  assert.ok(record.dispatchHold, '闸门必须保持按住，保护计划不被吞掉')
})

test('3.1.4：同一句非确认消息重复到达时提示只出现一次（不刷屏）', async () => {
  const session = makeSession()
  const record = makeRecord(makePlan())
  const runtime = makeRuntime(record, session)
  const messages = [userMsg(TASK_TEXT), userMsg('这个方案我还有别的想法')]

  await preStep(runtime, session, messages, 2)
  await preStep(runtime, session, messages, 2)

  const serialized = JSON.stringify(session.events)
  const hits = serialized.match(/计划仍在等待您的明确认可/g) ?? []
  assert.equal(hits.length, 1, '同一条消息只提示一次')
})

/* ---------------- D. 版本号单源（防再次出现提示词自报旧版本） ---------------- */

test('3.1.4：提示词对外声明的版本必须等于 meta.version，不得残留旧版本号', () => {
  assert.equal(meta.version, PLUGIN_VERSION)
  // PROMPT_SECTION 导出的是已 join('\n') 的整段提示词，按行找版本声明句。
  const declared = PROMPT_SECTION.split('\n').find((line: string) => line.includes('版本（用户要求 13）'))
  assert.ok(declared, '提示词必须声明当前版本')
  assert.ok(declared!.includes(PLUGIN_VERSION), `声明版本必须为 ${PLUGIN_VERSION}`)
  assert.ok(!declared!.includes('3.1.0'), '不得残留 3.1.0 旧版本声明')
})
