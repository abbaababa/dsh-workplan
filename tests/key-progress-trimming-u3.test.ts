import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * [U3][R3 独立回归] 关键进度注入收敛闸门——5 裁决点独立验收套件。
 *
 * 背景：旧会话登记条目 U3「T8 注入裁剪回归用例未开始（progress=100 虚标）」，
 * 明确要求独立验收、不得采信 agent-14 自跑的 38 项。本套件由 qa 域重试执行者
 * 独立编写，直接对 src/plan.ts 的收敛闸门（capKeyProgressText / 整轮预算 /
 * C2 禁止清单 / 豁免）做行为级断言。
 *
 * 5 裁决点：
 *  1) 注入裁剪存在且生效（闸门函数可导入、行为可观察）；
 *  2) 单条 ≤500 字符（超出截断＋按需查询指针，截断计入长度）；
 *  3) 整轮累计 ≤4000 字符（达上限后压缩为极简一行，不静默丢失）；
 *  4) heartbeat/过程通知彻底禁止（C2 前缀清单逐条断言，append 被丢弃）；
 *  5) 只防新增、保持兼容：计划定义（PLAN_MARKER）与 workplan-change 豁免上限，
 *     空 durable 信封仍 append（回放兼容），普通短消息原样通过。
 */
import {
  KEY_PROGRESS_SINGLE_LIMIT,
  KEY_PROGRESS_ROUND_LIMIT,
  capKeyProgressText,
  isBannedProgressNotice,
  resetRoundInjectionBudget,
  appendUserMessage,
  makeUserMessage,
  messageText,
  PLAN_MARKER_BEGIN,
} from '../src/plan.js'

/** 可注入落盘记录的 session 桩：append 立即执行（deferUntilHead:false 逃生门）。 */
function createSessionStub() {
  const appended: any[] = []
  const session: any = {
    append: (type: string, message: any, _opts?: any) => {
      appended.push({ type, message })
      return { type, message }
    },
  }
  return { session, appended }
}

function push(text: string, session: any) {
  return appendUserMessage(session, makeUserMessage(text, { kind: 'workplan', form: 'notice', summary: 't' }), undefined, {
    deferUntilHead: false,
  })
}

// ── 裁决点 2：单条 ≤500 字符 ─────────────────────────────────────────────
test('U3-2a 单条上限：500 字符内原文原样通过', () => {
  const text = 'x'.repeat(KEY_PROGRESS_SINGLE_LIMIT)
  assert.equal(capKeyProgressText(text), text)
})

test('U3-2b 单条上限：超出截断到 ≤500 且附按需查询指针', () => {
  const long = 'y'.repeat(KEY_PROGRESS_SINGLE_LIMIT + 500)
  const capped = capKeyProgressText(long)
  assert.ok(capped.length <= KEY_PROGRESS_SINGLE_LIMIT, `capped=${capped.length}`)
  assert.ok(capped.includes('详见按需查询'), '截断必须附按需查询指针')
  assert.ok(capped.endsWith('）'), '指针完整收尾')
})

test('U3-2c 单条上限：截断的 … 计入长度（不溢出）', () => {
  const long = 'z'.repeat(KEY_PROGRESS_SINGLE_LIMIT + 1)
  const capped = capKeyProgressText(long)
  assert.ok(capped.length <= KEY_PROGRESS_SINGLE_LIMIT)
  assert.ok(capped.includes('…'))
})

// ── 裁决点 4：heartbeat / 过程通知彻底禁止 ────────────────────────────────
test('U3-4a C2 禁止清单逐条命中（心跳/预告/预估上报全部禁止）', () => {
  const banned = [
    '【派发执行中】进度推送',
    '【规划预告】即将开始',
    '【规划进行中】第 2 次尝试',
    '【派发预告】即将派发',
    '【dsh-workplan·专家预估上报】预估 8 分钟',
    '【自动分解】第 1 次尝试失败：x',
  ]
  for (const text of banned) {
    assert.ok(isBannedProgressNotice(text), `应被禁止：${text.slice(0, 20)}`)
  }
})

test('U3-4b 禁止清单不误伤正常进度/结果消息', () => {
  const allowed = [
    'T3 完成（done）：产物已落盘 reports/foo.md',
    '【派发执行中之外】其他文案',
    '关键进度：T1 done｜T2 in_progress',
    '结果回报：全部子任务完成',
  ]
  for (const text of allowed) {
    assert.ok(!isBannedProgressNotice(text), `不应被禁止：${text.slice(0, 20)}`)
  }
})

test('U3-4c appendUserMessage 丢弃被禁过程通知（零落盘）', () => {
  const { session, appended } = createSessionStub()
  const result = push('【派发执行中】…', session)
  assert.equal(result, undefined)
  assert.equal(appended.length, 0, '被禁通知不得落盘')
})

// ── 裁决点 3：整轮累计 ≤4000 字符 ───────────────────────────────────────
test('U3-3a 整轮预算：未达上限前按单条 500 截断', () => {
  const { session, appended } = createSessionStub()
  resetRoundInjectionBudget(session, 'planA:1')
  const text = 'a'.repeat(600)
  push(text, session)
  assert.equal(appended.length, 1)
  const written = messageText(appended[0].message)
  assert.ok(written.length <= KEY_PROGRESS_SINGLE_LIMIT)
})

test('U3-3b 整轮预算：达 4000 后新事件压缩为极简一行且仍在', () => {
  const { session, appended } = createSessionStub()
  resetRoundInjectionBudget(session, 'planA:2')
  // 先消耗预算：9 条 × 500 = 4500 > 4000
  for (let i = 0; i < 9; i++) push('b'.repeat(500), session)
  const before = appended.length
  // 第 10 条：预算已尽，必须压缩为极简一行而非丢弃
  push('T5 blocked：原因详见报告\n第二行内容应被舍弃', session)
  assert.equal(appended.length, before + 1, '预算用尽不得静默丢失事件')
  const written = messageText(appended[appended.length - 1].message)
  assert.ok(written.includes('本轮注入预算用尽'), '极简一行必须带预算用尽指针')
  assert.ok(!written.includes('第二行内容'), '多行正文必须被压成首行')
})

test('U3-3c 整轮预算：resetRoundInjectionBudget 换轮后恢复正常截断', () => {
  const { session, appended } = createSessionStub()
  resetRoundInjectionBudget(session, 'planA:3')
  for (let i = 0; i < 9; i++) push('c'.repeat(500), session)
  appended.length = 0
  resetRoundInjectionBudget(session, 'planA:4')
  push('d'.repeat(600), session)
  const written = messageText(appended[0].message)
  assert.ok(written.length <= KEY_PROGRESS_SINGLE_LIMIT)
  assert.ok(!written.includes('预算用尽'), '新轮不应再触发预算压缩')
})

// ── 裁决点 5：只防新增、保持兼容 ─────────────────────────────────────────
test('U3-5a 计划定义消息（PLAN_MARKER）豁免上限，全文保留', () => {
  const { session, appended } = createSessionStub()
  resetRoundInjectionBudget(session, 'planB:1')
  const planText = `${PLAN_MARKER_BEGIN}\n` + 'p'.repeat(3000)
  push(planText, session)
  assert.equal(appended.length, 1)
  assert.equal(messageText(appended[0].message), planText)
})

test('U3-5b workplan-change（用户变更原文）豁免上限', () => {
  const { session, appended } = createSessionStub()
  resetRoundInjectionBudget(session, 'planB:2')
  const changeText = 'ch'.repeat(3000)
  appendUserMessage(
    session,
    makeUserMessage(changeText, { kind: 'workplan-change', form: 'notice', summary: 't' }),
    undefined,
    { deferUntilHead: false },
  )
  assert.equal(appended.length, 1)
  assert.equal(messageText(appended[0].message), changeText)
})

test('U3-5c durable 信封（workplan-update）正常通过且按 500 截断', () => {
  const { session, appended } = createSessionStub()
  resetRoundInjectionBudget(session, 'planB:3')
  const updateText = 'u'.repeat(900)
  appendUserMessage(
    session,
    makeUserMessage(updateText, { kind: 'workplan-update', form: 'notice', summary: 't' }),
    undefined,
    { deferUntilHead: false },
  )
  assert.equal(appended.length, 1)
  const written = messageText(appended[0].message)
  assert.ok(written.length <= KEY_PROGRESS_SINGLE_LIMIT, 'durable 信封仍受单条上限约束')
})

// ── 裁决点 1：注入裁剪闸门总行为 ─────────────────────────────────────────
test('U3-1 闸门端到端：禁件丢弃＋超限截断＋预算累计三者同时生效', () => {
  const { session, appended } = createSessionStub()
  resetRoundInjectionBudget(session, 'planC:1')
  push('【规划进行中】heartbeat', session) // 丢弃
  push('e'.repeat(700), session) // 截断到 ≤500
  push('正常进度消息', session) // 原样
  assert.equal(appended.length, 2)
  assert.ok(messageText(appended[0].message).length <= KEY_PROGRESS_SINGLE_LIMIT)
  assert.equal(messageText(appended[1].message), '正常进度消息')
})
