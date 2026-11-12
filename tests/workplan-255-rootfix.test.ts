/**
 * [2.5.5][治本回归] 用户 2026-11-12 三缺陷的根因修复固化：
 *  1. 截图缺陷（SessionFormatError: system/message requires a protected first
 *     surface head）：规划期通知（deferUntilHead，真实宿主 head 前窗口的全部
 *     写入方）在受保护系统头落地前一律暂存、头后按序补发，surface 上永远不
 *     存在先于系统头的 user/message（v4 校验器同口径断言）。
 *  2. 头落地自动补发保险丝：无后续写入时暂存通知也能在头落地后自动可见。
 *  3. 自动分解降级缺陷：normalizePlanRaw 对家族外五档/超上限 anchors/非字符串
 *     数组单点归一留痕，不再烧三次重试后降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendUserMessage, normalizePlanRaw, validatePlan } from '../src/plan.js'

function makeSession() {
  const events: any[] = []
  return {
    events,
    seq: 0,
    eventAt(i: number) { return events[i] },
    append(type: string, data: any, opts?: any) {
      events.push({ type, data, opts })
      this.seq = events.length
      return events.length
    },
    pushHead() {
      events.push({ type: 'system/message', data: { message: {} } })
      this.seq = events.length
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('[2.5.5/截图治本] head 前通知一律暂存，head 后按序补发；surface 首事件必为系统头', () => {
  const session = makeSession()
  appendUserMessage(session, '规划预告', undefined, { deferUntilHead: true })
  appendUserMessage(session, '规划心跳', undefined, { deferUntilHead: true })
  assert.equal(session.events.length, 0, 'head 前不得有任何 surface 写入')
  session.pushHead()
  appendUserMessage(session, '派发预告')
  assert.deepEqual(session.events.map((e) => e.type), [
    'system/message', 'user/message', 'user/message', 'user/message',
  ])
  assert.equal(session.events[0].type, 'system/message', 'v4 校验器口径：首 surface 事件必须是受保护系统头')
  const texts = session.events.slice(1).map((e) => e.data.content[0].text)
  assert.deepEqual(texts, ['规划预告', '规划心跳', '派发预告'], '暂存通知按序补发不丢内容')
})

test('[2.5.5/保险丝] 无后续写入时，head 落地后暂存通知自动补发（有界轮询自停）', async () => {
  const session = makeSession()
  appendUserMessage(session, '首回合规划通知', undefined, { deferUntilHead: true })
  assert.equal(session.events.length, 0)
  session.pushHead()
  await sleep(2600)
  assert.equal(session.events.length, 2, '保险丝应在头落地后自动补发')
  assert.equal(session.events[0].type, 'system/message')
  assert.equal(session.events[1].data.content[0].text, '首回合规划通知')
})

test('[2.5.5/降级治本] normalizePlanRaw：high@qwen→medium、max@qwen→xhigh、anchors 截断、outputs  coercion，全部留痕', () => {
  const raw = {
    stages: [{ id: 's1', subtasks: [{ id: 'T1', reasoningEffort: 'high', outputs: '单一产物', method: [1, 'x'] }] }],
    taskUnderstanding: { anchors: Array.from({ length: 45 }, (_, i) => `要素${i}`) },
  }
  const { raw: normalized, notes } = normalizePlanRaw(raw, ['low', 'medium', 'xhigh'])
  const st: any = normalized.stages[0].subtasks[0]
  assert.equal(st.reasoningEffort, 'medium')
  assert.deepEqual(st.outputs, ['单一产物'])
  assert.deepEqual(st.method, ['1', 'x'])
  assert.equal(normalized.taskUnderstanding.anchors.length, 40)
  assert.equal(notes.some((n) => n.includes('high→medium')), true)
  assert.equal(notes.some((n) => n.includes('anchors: 45→40')), true)
  assert.equal(notes.some((n) => n.includes('outputs')), true)
  // 合法值零改写；未传集合零迁移
  const legal = normalizePlanRaw({ stages: [{ subtasks: [{ reasoningEffort: 'xhigh' }] }] }, ['low', 'medium', 'xhigh'])
  assert.equal(legal.raw.stages[0].subtasks[0].reasoningEffort, 'xhigh')
  assert.equal(legal.notes.length, 0)
  const legacy = normalizePlanRaw(raw, null)
  assert.equal(legacy.raw.stages[0].subtasks[0].reasoningEffort, 'high')
})

test('[2.5.5/降级治本] validatePlan 集成：家族外档位不再产生拒绝错误（归一留痕随结果返回）', () => {
  const raw = {
    version: 1,
    title: 't',
    stages: [{ id: 's1', subtasks: [{ id: 'T1', title: 'x', reasoningEffort: 'max' }] }],
  }
  const r: any = validatePlan(raw, { allowedEfforts: ['low', 'medium', 'xhigh'] })
  assert.equal((r.errors ?? []).filter((e: string) => e.includes('reasoningEffort')).length, 0)
  assert.equal(normalizePlanRaw(raw, ['low', 'medium', 'xhigh']).raw.stages[0].subtasks[0].reasoningEffort, 'xhigh')
  assert.equal((r.notes ?? []).some((n: string) => n.includes('max→xhigh')), true)
})
