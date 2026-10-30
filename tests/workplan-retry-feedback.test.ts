/*
 * [1.7.0] Retry feedback.
 *
 * A retry used to resend an identical prompt, so the child walked into the same
 * dead end and produced the same error twice. Now the retry decision is a
 * deterministic rule (`shouldRetryAttempt`) and the second attempt receives the
 * previous failure — code, message, attempt number — so it can change approach
 * instead of repeating itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChildPrompt, createStatuses } from '../src/plan.js'
import { shouldRetryAttempt } from '../src/runtime.js'

function makePlan() {
  return {
    planId: 'wp-retry',
    sessionId: 'session-retry',
    createdTurn: 1,
    createdAt: 1000,
    title: '重试回灌回归',
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '实现',
        department: 'engineering',
        objective: '实现',
        acceptance: ['可用'],
        outputs: ['src/a.ts'],
        risk: 'low',
        dependsOn: [],
      }],
    }],
  }
}

test('只重试一次，且只重试可能自行恢复的失败', () => {
  assert.equal(shouldRetryAttempt({ code: 'CHILD_STALLED' }, 1, 60_000, 10_000), true)
  assert.equal(shouldRetryAttempt({ code: 'CHILD_STALLED' }, 2, 60_000, 10_000), false, '第二次失败不再重试')
  assert.equal(shouldRetryAttempt({ code: 'CHILD_TIMEOUT' }, 1, 60_000, 10_000), false, '硬超时重试只会再超时')
  assert.equal(shouldRetryAttempt({ code: 'ABORTED' }, 1, 60_000, 10_000), false, '用户取消/中止不得重试')
  assert.equal(shouldRetryAttempt({ code: 'TOTAL_TIMEOUT' }, 1, 60_000, 10_000), false)
  assert.equal(shouldRetryAttempt({ code: 'CHILD_NOT_COMPLETED' }, 1, 5_000, 10_000), false, '剩余时间不足一个空闲窗口时不重试')
  assert.equal(shouldRetryAttempt({ code: 'CHILD_NOT_COMPLETED' }, 1, 30_000, 10_000), true)
  assert.equal(shouldRetryAttempt({ message: 'activation aborted by host' }, 1, 60_000, 10_000), false)
  assert.equal(shouldRetryAttempt({ code: 'EMPTY_CHILD_OUTPUT' }, 1, 60_000, 10_000), true)
})

test('第二次尝试的提示词写明上一次失败，避免原样重试', () => {
  const plan = makePlan()
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/repo',
    conversationContext: '',
    statuses: createStatuses(plan),
    previousFailure: { attempt: 1, code: 'CHILD_STALLED', message: '无进展超时（10000ms）' },
  })

  assert.match(prompt, /上一次尝试失败/)
  assert.match(prompt, /CHILD_STALLED/)
  assert.match(prompt, /无进展超时/)
  assert.match(prompt, /不是新的任务/, '必须提醒子 Agent 先诊断上次失败原因')
})
