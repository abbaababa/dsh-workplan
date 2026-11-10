/*
 * [2.2.7] 执行中断即时通知（用户 2026-11-09 报告的第二个缺陷）。
 *
 * 缺陷：部门专家执行中被中断（失败重试 / 重试耗尽受阻 / no-ack / 请示）时，
 * 主会话直到整轮结束才随结果消息一并交代——期间用户只看到进度不动，不知道
 * 中断的本质原因，也不知道系统正在怎么处理，只能担心「任务是不是失败了」。
 *
 * 契约：
 *  1. announceSubtaskInterrupt 往主会话写【dsh-workplan·执行中断】纯文本消息，
 *     同一子任务整轮至多 3 条（cap），写失败只留档 record.errors，不影响执行；
 *  2. 集成：子会话第一次以 error 结束 → 用户当下就收到「被打断 + 原因 + 正在
 *     自动重试」的通知，第二次成功后本行照常 done。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { announceSubtaskInterrupt, dispatchPlan } from '../src/runtime.js'
import { createStatuses, validatePlan } from '../src/plan.js'

test('announceSubtaskInterrupt：前 3 条落会话，第 4 条起静默；append 抛错只记 errors', () => {
  const messages: string[] = []
  const session = { append: (type: string, payload: any) => messages.push(payload.content?.[0]?.text ?? JSON.stringify(payload)) }
  const record: any = { statuses: [{ subtaskId: 'T1', interruptNoticeCount: 0 }], errors: [] }
  assert.equal(announceSubtaskInterrupt(record, session, 'T1', '第一次中断'), true)
  assert.equal(announceSubtaskInterrupt(record, session, 'T1', '第二次'), true)
  assert.equal(announceSubtaskInterrupt(record, session, 'T1', '第三次'), true)
  assert.equal(announceSubtaskInterrupt(record, session, 'T1', '第四次应被 cap 拦下'), false)
  assert.equal(messages.length, 3)
  assert.match(messages[0], /【dsh-workplan·执行中断】/)
  const bad: any = { statuses: [{ subtaskId: 'T2' }], errors: [] }
  assert.equal(announceSubtaskInterrupt(bad, { append() { throw new Error('session log busy') } }, 'T2', '写失败'), false)
  assert.ok(String(bad.errors.join('')).includes('中断通知写入失败'), '写失败必须留档：' + JSON.stringify(bad.errors))
  assert.equal(announceSubtaskInterrupt(record, undefined, 'T1', '无会话静默跳过'), false)
})

test('集成：子会话执行被中断 → 主会话即时收到「原因 + 处理」通知，重试成功后照常结算', async () => {
  const plan: any = {
    version: 1,
    title: '中断通知用例',
    taskUnderstanding: {
      originalRequest: '验证中断即时通知', deliverable: '结果', successCriteria: ['通知即时出现在主会话'], constraints: ['不改动既有通道'], knownFacts: ['中断事件已有留档'], unknowns: [], assumptions: ['假子会话可控'],
    },
    contradictions: {
      primary: { statement: '中断期间用户看不到原因', evidence: ['记录只写 errors'], whyPrimary: '用户担心失败' },
      secondary: [], transformationConditions: [],
    },
    stages: [{
      id: 'S1', name: 'S', goal: 'g', rationale: 'r', checkpoint: 'c',
      subtasks: [{
        id: 'T1', title: '执行', department: 'engineering', role: '工程师', objective: '完成',
        method: ['做'], inputs: [], outputs: ['结果'], dependsOn: [], acceptance: ['有结果'], risk: '无',
        reasoningEffort: 'high',
      }],
    }],
    risks: [], verification: [{ item: 'i', method: 'm', evidence: 'e' }],
    practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
  }
  const validated = validatePlan(plan)
  assert.equal(validated.ok, true, String(validated.errors))
  const session: any = { id: 'lead-1', events: [], append: (type: string, payload: any) => session.events.push({ type, data: payload }) }
  let calls = 0
  const ctx: any = {
    subagents: {
      async startActivation(_spec: any) {
        calls += 1
        if (calls === 1) {
          return {
            childId: 'child-1',
            result: Promise.resolve({ stopReason: 'error', diagnostic: 'provider "qw" model "qwen3.8-flash" does not support reasoning effort "max"' }),
            dispose: async () => {},
          }
        }
        return {
          childId: 'child-2',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '完成' }] }),
          dispose: async () => {},
        }
      },
    },
    sessions: { get: (id: string) => (id === session.id ? session : undefined) },
  }
  const record: any = {
    plan: validated.plan,
    statuses: createStatuses(validated.plan),
    errors: [],
    phase: 'planning',
    updatedAt: Date.now(),
  }
  await dispatchPlan(ctx, record, {
    agent: { id: session.id, session },
    signal: new AbortController().signal,
    modelSelection: { provider: 'qw', model: 'some-model' },
    cwd: process.cwd(),
    conversationContext: '',
    strictEvidence: false,
  })
  const notices = session.events
    .filter((event: any) => event.type === 'user/message')
    .map((event: any) => String(event.data?.content?.[0]?.text ?? ''))
    .filter((text: string) => text.includes('【dsh-workplan·执行中断】'))
  assert.ok(notices.length >= 1, `主会话必须即时收到中断通知，实际消息：${JSON.stringify(session.events.map((e: any) => e.type))}`)
  assert.match(notices[0], /被打断/, '通知必须说清发生了什么')
  assert.match(notices[0], /自动重试/, '通知必须交代处理方式')
  assert.match(notices[0], /qwen3\.8-flash/, '通知必须带上本质原因（真因摘录，不是空话）')
  assert.equal(calls, 2, '第一次失败必须重试一次')
})
