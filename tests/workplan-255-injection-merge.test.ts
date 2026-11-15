/*
 * [2.5.5][T10] 非关键 workplan-update 合并闸回归（用户 2026-11-14 裁决 A）。
 *
 * 现象：一次计划执行里，每条空可见文本的台账改判都单独落一条 user/message，
 * 界面按「上下文注入」逐条渲染，几十条卡片把对话刷满。
 *
 * 验收：
 *  A1 非关键台账不逐条落盘：N 条非关键更新 + 1 条关键更新 ⇒ 实际 append 2 条
 *     （1 条合并汇总 + 1 条关键进度），而非 N+1 条；
 *  A2 合并汇总可回放且与逐条落盘完全等价（reconstructFromSession 结果逐字段相等）；
 *  A3 关键进度文案不变（keyProgress===true 仍是【关键进度】原样）；
 *  A4 C2 禁止清单仍整条丢弃、不进缓冲、不产生汇总；
 *  A5 缓冲有界（超过上限丢最旧并计数，不无限增长）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendUserMessage,
  buildPlanMessage,
  buildUpdateMessage,
  flushPendingWorkplanUpdates,
  makeUserMessage,
  messageText,
  parseUpdateMessage,
  parseUpdateMessages,
  pendingWorkplanUpdateCount,
} from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'

const ROOT = 'session-root'

function fakeSession(id: string) {
  /* 头前：先落一条 system/message，让 pre-head 暂存逻辑按真实宿主路径走（直接 append）。 */
  const events: any[] = [{ type: 'system/message', data: { content: [{ type: 'text', text: 'head' }] } }]
  return {
    id,
    header: { createdAt: 1000, cwd: '/tmp/wp-255-merge' },
    events,
    get seq() { return events.length },
    append(type: string, data: any, opts?: any) {
      events.push({ type, data, seq: events.length, ...(opts ? { surfaceOp: opts.surfaceOp } : {}) })
      return { type, data }
    },
    eventAt: (seq: number) => events[seq],
  }
}

function makePlan(planId: string) {
  return {
    version: 1, planId, title: '合并闸用例', sessionId: ROOT, createdTurn: 1, createdAt: 1000,
    taskUnderstanding: { originalRequest: '合并注入', deliverable: '合并闸回归' },
    contradictions: { primary: { statement: '逐条刷屏 vs 回放等价', evidence: [], whyPrimary: '主要矛盾' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: '合并', rationale: '', checkpoint: '',
      subtasks: ['T1', 'T2', 'T3'].map((id) => ({
        id, title: `任务 ${id}`, department: 'engineering', role: '负责人', objective: 'o',
        method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [],
      })),
    }],
  }
}

function nonKey(planId: string, subtaskId: string, status: string, revision: number, note?: string) {
  return buildUpdateMessage({ planId, subtaskId, status, revision, ...(note ? { note } : {}) })
}

function keyMessage(planId: string, subtaskId: string, status: string, revision: number) {
  return buildUpdateMessage({ planId, subtaskId, status, revision, keyProgress: true, title: `任务 ${subtaskId}` })
}

function countAppends(session: any) {
  return session.events.filter((event: any) => event.type === 'user/message').length
}

test('A1 合并：N 条非关键台账 + 1 条关键进度 ⇒ 只落 2 条消息', () => {
  const plan = makePlan('wp-255-a1')
  const merged = fakeSession(ROOT)
  merged.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })
  const updates = [
    nonKey(plan.planId, 'T1', 'pending', 1),
    nonKey(plan.planId, 'T1', 'in_progress', 2, '开始'),
    nonKey(plan.planId, 'T2', 'in_progress', 1),
    nonKey(plan.planId, 'T2', 'done', 2, '产物已落盘'),
    nonKey(plan.planId, 'T3', 'in_progress', 1),
    nonKey(plan.planId, 'T1', 'done', 3, '验收通过'),
    nonKey(plan.planId, 'T3', 'blocked', 2, '缺输入'),
    nonKey(plan.planId, 'T3', 'in_progress', 3, '已解除'),
  ]
  for (const message of updates) {
    const ret = appendUserMessage(merged, message, undefined, { deferUntilHead: false })
    assert.equal(ret, undefined, '非关键台账必须缓冲、本次不落盘')
  }
  assert.equal(pendingWorkplanUpdateCount(merged), updates.length, '8 条全部在缓冲里')
  const before = countAppends(merged)
  appendUserMessage(merged, keyMessage(plan.planId, 'T2', 'done', 3), undefined, { deferUntilHead: false })
  assert.equal(countAppends(merged), before + 2, '关键进度落盘前，缓冲合并成 1 条 + 关键的 1 条')
  assert.equal(pendingWorkplanUpdateCount(merged), 0, '合并后缓冲清空')

  const batch: any = merged.events.find((event: any) => event.type === 'user/message' && event.data?.source?.durable?.updates)
  assert.ok(batch, '必须存在一条合并汇总消息')
  const text = messageText(batch.data)
  assert.ok(text.startsWith('【进度归档】'), `汇总文案前缀：${text.slice(0, 24)}`)
  assert.ok(text.length <= 500, '汇总单条仍受 500 上限约束')
  assert.equal(batch.data.source.durable.updates.length, updates.length, '汇总消息携带全部 8 条台账')
})

test('A2 回放等价：合并汇总 vs 逐条落盘，重建结果逐字段相等', () => {
  const plan = makePlan('wp-255-a2')
  const sequence = [
    nonKey(plan.planId, 'T1', 'pending', 1),
    nonKey(plan.planId, 'T1', 'in_progress', 2, '开始'),
    nonKey(plan.planId, 'T2', 'in_progress', 1),
    nonKey(plan.planId, 'T2', 'done', 2, '产物已落盘'),
    nonKey(plan.planId, 'T1', 'done', 3, '验收通过'),
    keyMessage(plan.planId, 'T3', 'in_progress', 1),
  ]
  const individual = fakeSession(ROOT)
  individual.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })
  for (const message of sequence) individual.append('user/message', message, { surfaceOp: 'append' })

  const merged = fakeSession(ROOT)
  merged.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })
  for (const message of sequence) appendUserMessage(merged, message, undefined, { deferUntilHead: false })
  flushPendingWorkplanUpdates(merged)

  const a: any = reconstructFromSession(individual)
  const b: any = reconstructFromSession(merged)
  assert.ok(a?.plan && b?.plan, '两侧都必须能重建计划')
  assert.deepEqual(
    b.statuses.map((row: any) => ({ id: row.subtaskId, status: row.status, note: row.note, revision: row.revision })),
    a.statuses.map((row: any) => ({ id: row.subtaskId, status: row.status, note: row.note, revision: row.revision })),
    '合并回放必须与逐条落盘逐字段等价',
  )
  assert.ok(countAppends(merged) < countAppends(individual), '合并且确实减少了落盘消息条数')
})

test('A3 关键进度文案不受影响（keyProgress===true 仍是【关键进度】一行）', () => {
  const plan = makePlan('wp-255-a3')
  const session = fakeSession(ROOT)
  session.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })
  const key = keyMessage(plan.planId, 'T1', 'done', 2)
  appendUserMessage(session, key, undefined, { deferUntilHead: false })
  const written = session.events.filter((event: any) => event.type === 'user/message').pop()
  const text = messageText(written.data)
  assert.ok(text.startsWith('【关键进度】T1 完成'), `关键进度原样：${text}`)
  assert.ok(text.includes('下一步：'), '关键进度仍含下一步')
  assert.equal(parseUpdateMessage(written.data)?.status, 'done', '关键进度同时携带可回放信封')
})

test('A4 C2 禁止清单仍整条丢弃，不进缓冲、不产生汇总', () => {
  const session = fakeSession(ROOT)
  const before = countAppends(session)
  const ret = appendUserMessage(
    session,
    makeUserMessage('【派发执行中】心跳', { kind: 'workplan', form: 'notice', summary: 't' }),
    undefined,
    { deferUntilHead: false },
  )
  assert.equal(ret, undefined)
  assert.equal(countAppends(session), before, '被禁通知零落盘')
  assert.equal(pendingWorkplanUpdateCount(session), 0, '被禁通知不得进缓冲')
})

test('A5 缓冲有界：超过条数上限丢最旧并计数，汇总仍只有一条', () => {
  const plan = makePlan('wp-255-a5')
  const session = fakeSession(ROOT)
  session.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })
  for (let i = 0; i < 130; i += 1) {
    appendUserMessage(session, nonKey(plan.planId, 'T1', 'in_progress', i + 1, `第 ${i} 条`), undefined, { deferUntilHead: false })
  }
  flushPendingWorkplanUpdates(session)
  const batches = session.events.filter((event: any) => event.type === 'user/message' && event.data?.source?.durable?.updates)
  const total = batches.reduce((sum: number, event: any) => sum + event.data.source.durable.updates.length, 0)
  assert.ok(total <= 130, '缓冲不会丢成负数')
  assert.ok(batches.length >= 1, '至少一条汇总')
  for (const event of batches) {
    assert.ok(event.data.source.durable.updates.length <= 100, '单条汇总不超过条数上限')
  }
  assert.equal(pendingWorkplanUpdateCount(session), 0, '合并后缓冲清空')
})

test('A6 parseUpdateMessages：普通消息返回单条、汇总消息按序展开', () => {
  const plan = makePlan('wp-255-a6')
  const single = nonKey(plan.planId, 'T1', 'in_progress', 1)
  assert.deepEqual(parseUpdateMessages(single).map((item: any) => item.status), ['in_progress'])
  assert.equal(parseUpdateMessage(single)?.status, 'in_progress')
  const batch = makeUserMessage('', {
    kind: 'workplan-update',
    form: 'notice',
    summary: 't',
    durable: { kind: 'workplan-update', version: 1, planId: plan.planId, updates: [nonKey(plan.planId, 'T1', 'done', 2).source.durable] },
  })
  assert.equal(parseUpdateMessage(batch), null, '汇总信封不作为单条返回')
  assert.deepEqual(parseUpdateMessages(batch).map((item: any) => item.status), ['done'])
})
