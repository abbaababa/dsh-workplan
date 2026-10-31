import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChildPrompt,
  createStatuses,
  defuseSessionReferenceText,
  isCanonicalSessionUri,
} from '../src/plan.js'

/*
 * 事故回归：T9 部门子 Agent 首轮「处理失败」。
 *
 * 父会话历史里写了 `dsh-session:1980`（表示 dsh-session 包第 1980 行），
 * Harness 的 session-reference 把它当跨会话引用，base64url 解码后 JSON.parse
 * 失败，turn 在模型调用前中止。插件必须保证拼出的子任务提示词里不存在可被
 * 该正则命中的裸 token。
 */
const HARNESS_BARE_URI = /dsh-session:[A-Za-z0-9_-]+/u

function makePlan(originalRequest = '验证需求') {
  return {
    planId: 'wp-session-ref',
    sessionId: 'session-ref',
    createdTurn: 1,
    createdAt: 1000,
    title: 'session 引用消毒回归',
    taskUnderstanding: {
      originalRequest,
      deliverable: '一份报告',
      constraints: [],
      assumptions: [],
    },
    contradictions: { primary: { statement: '无' } },
    stages: [{
      id: 'S1',
      name: '核验',
      goal: '核验',
      subtasks: [{
        id: 'T1',
        title: '核验结果',
        department: 'qa',
        role: '验证者',
        objective: '核验结果',
        method: ['读文件'],
        inputs: [],
        outputs: ['报告'],
        acceptance: ['有结论'],
        risk: 'low',
        dependsOn: [],
        estimatedMinutes: 5,
      }],
    }],
  }
}

test('裸的 package:line 文本被转义，且不再命中 harness 的裸引用正则', () => {
  const source = '而 `ctx.sessions.get()`（`dsh-session:1980`）只查询 live store'
  const safe = defuseSessionReferenceText(source)

  assert.equal(safe, '而 `ctx.sessions.get()`（`dsh-session\\:1980`）只查询 live store')
  assert.equal(HARNESS_BARE_URI.test(safe), false, '转义后不能留下可被引用的裸 token')
  assert.match(safe, /1980/, '行号信息必须保留，不能丢证据')
})

test('规范 URI 原样保留（真正的跨会话引用不受影响）', () => {
  const sessionId = '0d55b72d-07ba-4bee-a07b-4114d99cb7a8'
  const uri = `dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`

  assert.equal(isCanonicalSessionUri(uri), true)
  assert.equal(isCanonicalSessionUri('dsh-session:1980'), false)
  assert.equal(defuseSessionReferenceText(`见 ${uri}`), `见 ${uri}`)
})

test('消毒是幂等的（重复拼装不会累积转义）', () => {
  const once = defuseSessionReferenceText('dsh-session:1980')
  assert.equal(defuseSessionReferenceText(once), once)
})

test('子任务提示词：背景里的裸引用被消毒', () => {
  const plan = makePlan()
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/repo',
    conversationContext: '助手：dsh-session:1980 这一行的逻辑是……',
    statuses: createStatuses(plan),
  })

  assert.equal(HARNESS_BARE_URI.test(prompt), false, '整段提示词都不能留下裸 token')
  assert.match(prompt, /dsh-session\\:1980/)
  assert.match(prompt, /这一行的逻辑是/)
})

test('子任务提示词：用户原始请求里的裸引用同样被消毒', () => {
  const plan = makePlan('请解释 dsh-session:1980 为什么会导致失败')
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [{ id: 'T0', title: '前序', status: 'done', summary: '引用 dsh-session:1980' }],
    cwd: '/repo',
    conversationContext: '',
    statuses: createStatuses(plan),
  })

  assert.equal(HARNESS_BARE_URI.test(prompt), false)
  assert.match(prompt, /dsh-session\\:1980/)
  assert.match(prompt, /前序/)
})
