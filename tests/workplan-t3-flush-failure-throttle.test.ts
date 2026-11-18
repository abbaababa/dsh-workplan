/*
 * [T3] 写入失败限流回归：同批缓冲首次失败只记一次错误后停止周期重试，
 * 新台账更新到来再恢复。
 *
 * 验收：
 *  A1 合并落盘首次失败：只记一次错误，缓冲本体保留（台账不丢）；
 *  A2 失败后周期重试（重复 flush）一律跳过该批，不再尝试 append、不再记错误；
 *  A3 新台账更新到来：闩锁复位，flush 恢复并成功落盘，缓冲清空。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendUserMessage,
  buildPlanMessage,
  buildUpdateMessage,
  flushPendingWorkplanUpdates,
  pendingWorkplanUpdateCount,
} from '../src/plan.js'

const ROOT = 'session-root'

function fakeSession(id: string) {
  const events: any[] = [{ type: 'system/message', data: { content: [{ type: 'text', text: 'head' }] } }]
  const session: any = {
    id,
    header: { createdAt: 1000, cwd: '/tmp/wp-t3-throttle' },
    events,
    fail: false,
    userAppends: 0,
    get seq() { return events.length },
    append(type: string, data: any, opts?: any) {
      if (type === 'user/message') {
        session.userAppends += 1
        if (session.fail) throw new Error('disk full (simulated)')
      }
      events.push({ type, data, seq: events.length, ...(opts ? { surfaceOp: opts.surfaceOp } : {}) })
      return { type, data }
    },
    eventAt: (seq: number) => events[seq],
  }
  return session
}

function makePlan(planId: string) {
  return {
    version: 1, planId, title: '写入失败限流用例', sessionId: ROOT, createdTurn: 1, createdAt: 1000,
    taskUnderstanding: { originalRequest: '限流', deliverable: '回归' },
    contradictions: { primary: { statement: 'p', evidence: [], whyPrimary: 'w' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: '限流', rationale: '', checkpoint: '',
      subtasks: ['T1', 'T2'].map((tid) => ({
        id: tid, title: `任务 ${tid}`, department: 'engineering', role: '负责人', objective: 'o',
        method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [],
      })),
    }],
  }
}

function nonKey(planId: string, subtaskId: string, status: string, revision: number) {
  return buildUpdateMessage({ planId, subtaskId, status, revision })
}

test('A1/A2/A3 首次失败限流 + 新更新恢复', () => {
  const plan = makePlan('wp-t3-throttle')
  const session = fakeSession(ROOT)
  session.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })

  const warns: string[] = []
  const origWarn = console.warn
  console.warn = (...args: any[]) => { warns.push(String(args[0])) }

  try {
    for (const msg of [
      nonKey(plan.planId, 'T1', 'in_progress', 1),
      nonKey(plan.planId, 'T1', 'done', 2),
      nonKey(plan.planId, 'T2', 'in_progress', 1),
    ]) {
      assert.equal(appendUserMessage(session, msg, undefined, { deferUntilHead: false }), undefined)
    }
    assert.equal(pendingWorkplanUpdateCount(session), 3, '3 条台账进缓冲')

    /* A1：首次失败只记一次错误，缓冲保留 */
    session.fail = true
    const appendsBefore = session.userAppends
    assert.equal(flushPendingWorkplanUpdates(session), undefined, '失败时返回 undefined')
    assert.equal(session.userAppends, appendsBefore + 1, '只尝试了 1 次 append')
    assert.equal(warns.length, 1, '只记一次错误')
    assert.ok(warns[0].includes('已停止周期重试'), '错误文案说明已限流')
    assert.equal(pendingWorkplanUpdateCount(session), 3, '缓冲保留，台账不丢')

    /* A2：周期重试（重复 flush）全部跳过，不再尝试 append、不再记错误 */
    for (let i = 0; i < 5; i += 1) assert.equal(flushPendingWorkplanUpdates(session), undefined)
    assert.equal(session.userAppends, appendsBefore + 1, '限流后不再尝试 append')
    assert.equal(warns.length, 1, '限流后不再记错误')
  } finally {
    console.warn = origWarn
  }

  /* A3：新更新到来恢复重试并落盘成功 */
  session.fail = false
  assert.equal(appendUserMessage(session, nonKey(plan.planId, 'T2', 'done', 2), undefined, { deferUntilHead: false }), undefined)
  assert.equal(pendingWorkplanUpdateCount(session), 4, '新更新并入同批缓冲')
  const appended = flushPendingWorkplanUpdates(session)
  assert.ok(appended, '恢复后 flush 成功返回')
  assert.equal(pendingWorkplanUpdateCount(session), 0, '落盘后缓冲清空')
  const merged = session.events.find((e: any) => e.type === 'user/message' && e.data?.source?.durable?.updates)
  assert.ok(merged, '存在合并汇总消息')
  assert.equal(merged.data.source.durable.updates.length, 4, '汇总携带全部 4 条台账（含失败期间滞留的 3 条）')
})
