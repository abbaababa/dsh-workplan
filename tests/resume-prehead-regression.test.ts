/*
 * [2.5.5][T4] 重启后继续会话读取历史回归（session-1513aa1d 事故）。
 *
 * 根因：旧版 appendUserMessage 仅对显式 opts.deferUntilHead 的规划期通知暂存，
 * 派发崩溃中断通知/受阻通知/结算消息落在系统头（首个 system/message）之前，
 * 重启后读取端 assertReleasedV4Relationships 抛 "system/message requires a
 * protected first surface head"，整份历史被判 corrupt、会话无法继续。
 *
 * 断言点（修复前失败/修复后通过）：
 *  - 默认前置闸：头前任何 appendUserMessage 一律暂存，不写 surface；
 *  - 头后按序补发：头落地后先补暂存通知再写新消息，顺序不丢；
 *  - 逃生门：opts.deferUntilHead === false 显式立即写入（测试/特殊场景）；
 *  - 头已存在：立即写入，零回归；
 *  - 源码锚定：默认前置闸条件、T6 agent 兜底/fail-closed/堆栈留痕在位。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendUserMessage, enterPreHeadWindow } from '../src/plan.js'

function makeSession(withHead: boolean) {
  const events: any[] = []
  const appended: Array<{ type: string; data: any; opts: any }> = []
  const session: any = {
    get seq() { return events.length },
    eventAt: (i: number) => events[i],
    append: (type: string, data: any, opts: any) => {
      appended.push({ type, data, opts })
      events.push({ type, seq: events.length, data })
      return events.length
    },
  }
  if (withHead) events.push({ type: 'system/message', seq: 0, data: {} })
  return { session, events, appended }
}

test('pre-step 窗口前置闸：系统头前通知必须暂存，不得写 surface（旧代码在此失败）', () => {
  const { session, appended } = makeSession(false)
  enterPreHeadWindow(session)
  appendUserMessage(session, '【dsh-workplan·执行中断】子任务 T1 被打断')
  appendUserMessage(session, '【dsh-workplan·执行中断】子任务 T1 已受阻')
  assert.equal(appended.length, 0, '头前写入必须被暂存，否则重启后读取端判 corrupt')
})

test('头后按序补发：先补暂存通知再写新消息，顺序与内容不丢', () => {
  const { session, events, appended } = makeSession(false)
  enterPreHeadWindow(session)
  appendUserMessage(session, '通知一')
  appendUserMessage(session, '通知二')
  assert.equal(appended.length, 0)
  events.push({ type: 'system/message', seq: events.length, data: {} })
  appendUserMessage(session, '通知三')
  assert.deepEqual(appended.map((a) => a.data.content[0].text), ['通知一', '通知二', '通知三'])
  for (const a of appended) {
    assert.equal(a.type, 'user/message')
    assert.equal(a.opts?.surfaceOp, 'append')
  }
})

test('窗口外（工具路径契约）：头前写入立即执行，单元桩零回归', () => {
  const { session, appended } = makeSession(false)
  appendUserMessage(session, '工具路径通知')
  assert.equal(appended.length, 1)
})

test('逃生门：deferUntilHead=false 显式立即写入', () => {
  const { session, appended } = makeSession(false)
  appendUserMessage(session, '立即', undefined, { deferUntilHead: false })
  assert.equal(appended.length, 1)
})

test('头已存在：立即写入，零回归', () => {
  const { session, appended } = makeSession(true)
  appendUserMessage(session, '正常通知')
  assert.equal(appended.length, 1)
})

test('源码锚定：默认前置闸 + T6 agent 兜底/fail-closed/堆栈留痕在位', () => {
  const planSource = readFileSync(join(process.cwd(), 'src/plan.ts'), 'utf8')
  assert.ok(planSource.includes('preHeadWindowSessions.has(session)'), 'pre-step 窗口前置闸必须在位')
  assert.ok(planSource.includes('export function enterPreHeadWindow'), '窗口标记入口必须在位')
  const runtimeSource = readFileSync(join(process.cwd(), 'src/runtime.ts'), 'utf8')
  assert.ok(runtimeSource.includes('function resolveLiveAgent('), 'T6 agent 兜底解析必须在位')
  assert.ok(runtimeSource.includes('AGENT_RESOLUTION_FAILED'), 'T6 fail-closed 必须在位')
  assert.ok(runtimeSource.includes('parent: liveAgent'), 'T6 派发必须使用兜底解析后的活体 agent')
  const watchdogSource = readFileSync(join(process.cwd(), 'src/watchdog.ts'), 'utf8')
  assert.ok(watchdogSource.includes('value.stack'), 'T6 堆栈留痕必须在位')
})
