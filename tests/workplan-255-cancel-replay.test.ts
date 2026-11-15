/*
 * [2.5.5][P0 回归] 回放循环闭合位置：取消/取代回放不得被批量更新循环吞掉。
 *
 * 事故（本插件 T10 合并闸改造，2026-11-14）：
 *   把 `for (const update of parseUpdateMessages(event.data))` 的闭合大括号
 *   放到了「计划取消/取代回放」块之后，于是该块被圈进循环体：
 *     - 没有 workplan-update 的取消事件（parseUpdateMessages 返回空数组）
 *       ⇒ 循环体一次都不执行 ⇒ 取消/取代整块被静默跳过；
 *     - 冷启动/刷新后 cancelled / superseded 丢失，计划看起来还活着。
 *   live 路径不经回放，所以热状态下查不出来（T5 复核 I7，三源一致）。
 *
 * 本文件钉住三件事（都是「不修就必失败」的判据）：
 *   R1 会话里**一条 workplan-update 都没有**时，取消信封仍必须回放成 cancelled；
 *   R2 同会话里既有批量更新又有取消时，两者都必须生效（循环与取消块互不吞并）；
 *   R3 cancelled 之后再来 superseded 信封，必须按 superseded 收尾（cancelled=false）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCancelMessage,
  buildPlanMessage,
  buildUpdateMessage,
  flushPendingWorkplanUpdates,
  appendUserMessage,
} from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'
import { computeMappingDigest } from '../src/supersede-digest.js'

const ROOT = 'session-255-cancel-replay'

function fakeSession() {
  const events: any[] = []
  return {
    id: ROOT,
    header: { createdAt: 1000, cwd: '/tmp/wp-255-cancel-replay' },
    get seq() { return events.length },
    append(type: string, data: any, opts?: any) {
      events.push({ type, data, seq: events.length, ...(opts ? { surfaceOp: opts.surfaceOp } : {}) })
      return { type, data }
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makePlan(planId: string, sessionId = ROOT) {
  return {
    version: 1, planId, title: '取消回放用例', sessionId, createdTurn: 1, createdAt: 1000,
    taskUnderstanding: { originalRequest: '取消必须能回放', deliverable: '取消回放回归' },
    contradictions: { primary: { statement: '循环吞并取消块', evidence: [], whyPrimary: '主要矛盾' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: 'g', rationale: '', checkpoint: '',
      subtasks: ['T1', 'T2', 'T3'].map((id) => ({
        id, title: `任务 ${id}`, department: 'engineering', role: '负责人', objective: 'o',
        method: [], inputs: [], outputs: [], acceptance: ['a'], risk: '', dependsOn: [],
      })),
    }],
  }
}

test('R1 零 workplan-update 的会话：取消信封仍必须回放成 cancelled', () => {
  const plan = makePlan('wp-255-r1')
  const session = fakeSession()
  session.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })
  session.append('user/message', buildCancelMessage(plan.planId, '用户取消'), { surfaceOp: 'append' })

  /* 前提断言：这一会话里确实没有任何 workplan-update 信封。 */
  const updateCount = session.events.filter((event: any) => {
    const durable = event?.data?.source?.durable
    return event?.type === 'user/message' && durable?.kind === 'workplan-update'
  }).length
  assert.equal(updateCount, 0, '用例前提：会话里没有任何 workplan-update')

  const record: any = reconstructFromSession(session, plan.planId)
  assert.ok(record, '必须能重建计划记录')
  assert.equal(record.cancelled, true, '取消必须回放生效（R1：循环不得吞掉取消块）')
  assert.equal(record.phase, 'cancelled', 'phase 必须是 cancelled')
  assert.equal(record.cancelRecorded, true, '取消必须留下写入见证')
  assert.equal(record.superseded, false, '普通取消不得被读成 superseded')
})

test('R2 批量更新与取消并存：状态与取消都必须生效', () => {
  const plan = makePlan('wp-255-r2')
  const session = fakeSession()
  session.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })

  /* 走生产写路径：空可见文本的台账被缓冲，轮末合并成一条批消息。 */
  appendUserMessage(session, buildUpdateMessage({ planId: plan.planId, subtaskId: 'T1', status: 'in_progress', revision: 2 }), undefined, { deferUntilHead: false })
  appendUserMessage(session, buildUpdateMessage({ planId: plan.planId, subtaskId: 'T2', status: 'done', revision: 2 }), undefined, { deferUntilHead: false })
  flushPendingWorkplanUpdates(session)
  session.append('user/message', buildCancelMessage(plan.planId, '用户取消'), { surfaceOp: 'append' })

  const record: any = reconstructFromSession(session, plan.planId)
  assert.ok(record, '必须能重建计划记录')
  const rows = record.statuses.map((row: any) => ({ id: row.subtaskId, status: row.status, revision: row.revision }))
  assert.deepEqual(
    rows.filter((row: any) => row.id === 'T1').map((row: any) => row.status),
    ['in_progress'],
    '批量更新里的 T1 改判必须生效',
  )
  assert.deepEqual(
    rows.filter((row: any) => row.id === 'T2').map((row: any) => row.status),
    ['done'],
    '批量更新里的 T2 改判必须生效',
  )
  assert.equal(record.cancelled, true, '取消与批量更新必须同时生效')
})

test('R3 cancelled 之后 superseded：必须按 superseded 收尾', () => {
  const plan = makePlan('wp-255-r3')
  const session = fakeSession()
  session.append('user/message', buildPlanMessage(plan), { surfaceOp: 'append' })
  session.append('user/message', buildCancelMessage(plan.planId, '用户取消'), { surfaceOp: 'append' })

  const mapping = [{ from: 'T1', to: 'N1', basis: '同一责任' }]
  session.append('user/message', buildCancelMessage(plan.planId, '责任转移', {
    disposition: 'superseded',
    supersededAt: 2000,
    supersededBy: {
      planId: 'wp-255-r3-successor',
      requiredCount: 3,
      coveredCount: 1,
      mapping,
      digest: computeMappingDigest(mapping),
    },
  }), { surfaceOp: 'append' })

  const record: any = reconstructFromSession(session, plan.planId)
  assert.ok(record, '必须能重建计划记录')
  assert.equal(record.superseded, true, '取代必须回放生效')
  assert.equal(record.cancelled, false, '取代后 cancelled 必须被清掉（写侧互斥）')
  assert.equal(record.phase, 'superseded', 'phase 必须是 superseded')
})
