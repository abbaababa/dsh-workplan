/*
 * [1.8.6] "没有可跑的步骤" ≠ "全都失败了"。
 *
 * 旧行为：只要 ready 为空，就把所有 pending 改写成 blocked，文案统一为
 * 「依赖未完成或上游受阻」。于是三种完全不同的情况在卡片上长得一模一样：
 *   1. 本轮预算到点（什么都没跑）；
 *   2. 上游的声明产物缺失（活儿可能已经干完，只是文件没在声明位置）；
 *   3. 上游真的失败。
 * 三种都被算作「卡住了」，还会消耗一次续跑额度。下面两条把新语义钉死：
 * pending 保持 pending，真实原因写进 errors；只有真 blocked 才把阶段判成 blocked。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createStatuses } from '../src/plan.js'
import { dispatchPlan } from '../src/runtime.js'

function makePlan(): any {
  return {
    planId: 'wp-pending-cause',
    sessionId: 'session-pending-cause',
    createdTurn: 1,
    createdAt: 1000,
    title: 'pending 原因诊断',
    stages: [
      {
        id: 'S1',
        subtasks: [
          {
            id: 'T1',
            title: '写接口文档',
            department: 'engineering',
            dependsOn: [],
            outputs: ['docs/api.md'],
          },
          {
            id: 'T2',
            title: '写测试',
            department: 'qa',
            dependsOn: ['T1'],
            outputs: ['tests/api.test.ts'],
          },
        ],
      },
    ],
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
    resultWritten: false,
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-pending-cause',
    header: { createdAt: 1000 },
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

test('上游声明产物缺失时，下游保持 pending 并写明真实原因', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  // 上游「完成」了，但它声明的文件不在盘上：这不是失败，是不能开工。
  record.statuses = record.statuses.map((item: any) =>
    item.subtaskId === 'T1'
      ? { ...item, status: 'done', progress: 100, missingArtifacts: ['docs/api.md'] }
      : item)

  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: () => { throw new Error('不该启动子 Agent') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const result = await dispatchPlan(ctx, record, {
    agent: { session: makeSession(), options: {} },
    signal: new AbortController().signal,
    cwd: '/tmp/never-written',
    artifactExists: () => false,
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 20000,
  })

  const t2: any = record.statuses.find((item: any) => item.subtaskId === 'T2')
  assert.equal(t2.status, 'pending', '不能把「开不了工」写成「卡住了」')
  assert.ok(t2.error == null, 'pending 不背失败文案')
  assert.match(String(record.error), /保持 pending/)
  assert.match(String(record.error), /声明产物缺失：docs\/api\.md/)
  assert.equal(result.phase, 'paused', '没有真失败项时阶段是 paused，可免费续跑')
})

test('没有 pending 需要解释时，不编造原因', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  record.statuses = record.statuses.map((item: any) => ({ ...item, status: 'done', progress: 100 }))

  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: () => { throw new Error('不该启动子 Agent') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const result = await dispatchPlan(ctx, record, {
    agent: { session: makeSession(), options: {} },
    signal: new AbortController().signal,
    cwd: '/tmp/never-written',
    artifactExists: () => true,
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 20000,
  })

  assert.ok(record.error == null, '没有 pending 时不该有解释文案')
  assert.equal(result.phase, 'done', '全部完成时阶段跟着 planPhase 走')
})
