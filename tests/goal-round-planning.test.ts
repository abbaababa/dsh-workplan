import test from 'node:test'
import assert from 'node:assert/strict'

import { goalObjectiveFromText, goalRoundPlanningTask, humanMessages } from '../src/runtime.js'

/*
 * [2.0.3] `/goal` 任务的自动分解入口。
 *
 * 官方 DSH 的 /goal 不产生 user/message，目标文本只以 source.kind='goal'
 * 的轮次消息送达；这组断言把「哪些 goal 消息可以触发规划」固定成可复核的
 * 行为，避免以后又把 goal 轮次当成「没有人类任务」而静默跳过。
 */

function goalRoundPrompt(objective: string, round = 1): string {
  return [
    '<goal_round>',
    `Objective: ${JSON.stringify(objective)}`,
    `Round: ${round}/8`,
    '',
    'Continue working toward the objective in this same session.',
    '</goal_round>',
  ].join('\n')
}

function userMessage(text: string, source: any) {
  return { role: 'user', content: [{ type: 'text', text }], source }
}

test('humanMessages 仍然不把 goal 轮次当成人类消息（人工任务路径不变）', () => {
  const messages = [userMessage(goalRoundPrompt('修复插件'), { kind: 'goal', goalId: 'g1', revision: 1, round: 1 })]
  assert.equal(humanMessages(messages).length, 0)
})

test('goalObjectiveFromText 能从官方 <goal_round> 信封解析 JSON 目标', () => {
  const objective = '修复 dsh-workplan 的 /goal 触发问题，并 "不动" 其他契约'
  assert.equal(goalObjectiveFromText(goalRoundPrompt(objective)), objective)
})

test('goal 第一轮没有 goals 服务时，用信封里的结构化目标作为任务文本', () => {
  const payload = {
    messages: [userMessage(goalRoundPrompt('完成插件修复与发布'), { kind: 'goal', goalId: 'g1', revision: 1, round: 1 })],
    agent: { id: 's1' },
  }
  const task = goalRoundPlanningTask({ get: () => undefined }, payload, undefined)
  assert.ok(task)
  assert.equal(task!.text, '完成插件修复与发布')
  assert.equal(task!.goalId, 'g1')
  assert.equal(task!.round, 1)
})

test('goal 领域服务的结构化 objective 优先于信封文本', () => {
  const payload = {
    messages: [userMessage(goalRoundPrompt('信封里的目标'), { kind: 'goal', goalId: 'g1', revision: 1, round: 1 })],
    agent: { id: 's1' },
  }
  const ctx = {
    get: (name: string) => (name === 'goals' ? { get: () => ({ objective: '领域服务里的目标' }) } : undefined),
  }
  assert.equal(goalRoundPlanningTask(ctx, payload, undefined)!.text, '领域服务里的目标')
})

test('goal 第二轮及以后不再触发新计划（只认 round === 1）', () => {
  const payload = {
    messages: [userMessage(goalRoundPrompt('继续', 2), { kind: 'goal', goalId: 'g1', revision: 1, round: 2 })],
    agent: { id: 's1' },
  }
  assert.equal(goalRoundPlanningTask({ get: () => undefined }, payload, undefined), undefined)
})

test('非 goal 来源、空消息与缺失 objective 的兜底行为仍然安全', () => {
  const humanPayload = { messages: [userMessage('普通用户任务', { kind: 'user' })], agent: { id: 's1' } }
  assert.equal(goalRoundPlanningTask({ get: () => undefined }, humanPayload, undefined), undefined)

  const rawPayload = {
    messages: [userMessage('自由文本目标', { kind: 'goal', goalId: 'g1', revision: 1, round: 1 })],
    agent: { id: 's1' },
  }
  assert.equal(goalRoundPlanningTask({ get: () => undefined }, rawPayload, undefined)!.text, '自由文本目标')
})

test('已有进行中的计划时 goal 轮次不得抢跑；历史终态/已完成记录不拦新任务', () => {
  const payload = {
    messages: [userMessage(goalRoundPrompt('目标'), { kind: 'goal', goalId: 'g1', revision: 1, round: 1 })],
    agent: { id: 's1' },
  }
  const ctx = { get: () => undefined }
  for (const phase of ['executing', 'paused', 'pending', 'verification']) {
    assert.equal(goalRoundPlanningTask(ctx, payload, { plan: { planId: 'p1' }, phase }), undefined, `phase=${phase}`)
  }
  for (const phase of ['done', 'ended', 'cancelled', 'superseded', 'degraded', 'clarify']) {
    assert.ok(goalRoundPlanningTask(ctx, payload, { plan: phase === 'degraded' || phase === 'clarify' ? null : { planId: 'p1' }, phase }), `phase=${phase}`)
  }
})
