/* [3.2.3] 省钱改动的守门测试：W1 规划器定向修复、W6 开工证据摘要注入。 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateFastPathEligibility, runPlanner, statusFingerprint } from '../src/runtime.js'
import { buildChildPrompt } from '../src/plan.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

const anchor = setInterval(() => {}, 1_000)
const release = setTimeout(() => clearInterval(anchor), 60_000)
release.unref?.()
after(() => clearInterval(anchor))

function fakeCtx(texts: string[], seen: any[]) {
  return {
    llm: {
      stream(options: any) {
        seen.push(options)
        const text = texts[seen.length - 1] ?? texts[texts.length - 1]
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  } as any
}

function validPlan() {
  return {
    version: 1,
    title: '整理说明文档',
    taskUnderstanding: {
      originalRequest: '把说明文档整理成三段',
      deliverable: '整理后的三段文本',
      successCriteria: ['每段不超过五行'],
      constraints: ['不要改动原意'],
      knownFacts: ['用户要求分三段'],
      unknowns: ['原文长度未知'],
      assumptions: ['原文可分段'],
    },
    contradictions: {
      primary: { statement: '简洁与完整之间的矛盾', evidence: ['每段不超过五行'], whyPrimary: '过短可能丢信息' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '整理',
      goal: '完成三段整理',
      rationale: '直接执行',
      checkpoint: '文本分三段',
      subtasks: [{
        id: 'T1',
        title: '整理成三段',
        department: 'design',
        role: '文档编辑',
        objective: '把文本整理成三段',
        method: ['阅读原文', '分段'],
        inputs: ['原文'],
        outputs: ['三段文本'],
        dependsOn: [],
        acceptance: ['每段不超过五行'],
        risk: '无',
      }],
    }],
    risks: [],
    verification: [{ item: '每段不超过五行', method: '逐段计数', evidence: '最终文本' }],
    practiceLoop: { plan: '读', do: '整理', check: '核对', act: '修正' },
  }
}

test('快路径：默认关闭；开启后也只接受单动作/单文件/单部门任务，疑点一律回落规划器', () => {
  const base = {
    taskText: '修复 src/runtime.ts 的代码缺陷',
    conversationContext: '',
    sessionId: 'session-fast-path',
    signal: { aborted: false },
    planMode: false,
    approvalHeld: false,
    turn: 2,
    existingActivePlan: null,
  }
  assert.equal(evaluateFastPathEligibility({ ...base, enabled: false }).code, 'FAST_PATH_DISABLED')
  const ok = evaluateFastPathEligibility({ ...base, enabled: true })
  assert.equal(ok.code, 'OK')
  assert.equal(ok.department, 'engineering')
  assert.equal(evaluateFastPathEligibility({ ...base, enabled: true, taskText: '修复 src/runtime.ts 的代码缺陷，然后提交补丁' }).code, 'MULTI_STEP')
  assert.equal(evaluateFastPathEligibility({ ...base, enabled: true, taskText: '分析 src/runtime.ts 的代码缺陷' }).code, 'ANALYSIS')
  assert.equal(evaluateFastPathEligibility({ ...base, enabled: true, planMode: true }).code, 'MODE_OR_HOLD')
})

test('W1：校验失败后的第二次规划只发「待修问题 + 上轮原文」，不再整份重发规划器提示词', async () => {
  const previous = process.env.DSH_WORKPLAN_CONTEXT_GUARD
  process.env.DSH_WORKPLAN_CONTEXT_GUARD = 'off'
  try {
    const seen: any[] = []
    const bad = { ...validPlan(), stages: [] }
    const plan = await runPlanner(fakeCtx([JSON.stringify(bad), JSON.stringify(validPlan())], seen), {
      telemetry: {},
      taskText: '把说明文档整理成三段',
      cwd: '/tmp',
      sessionId: 'session-token-economy-323',
      modelSelection: { provider: 'fake-provider', model: 'fake-model' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: { totalMinutes: 20, childMinutes: 15, concurrency: 5, maxResumes: 4 },
      sourceMessageIds: [],
    })
    assert.equal(plan.title, '整理说明文档')
    assert.equal(seen.length, 2, '第二次成功，不应有第三次调用')
    const first: string = seen[0].messages[0].content[0].text
    assert.match(first, /可用部门/)
    // [3.4.0] 定向修复改为 4 段多轮接续（system + 原 user + assistant 原文 + 精简待修 user），
    // 前 3 段与首轮逐字节一致以命中 KV 前缀缓存，末段只发待修问题不再重复规则。
    assert.equal(seen[1].messages.length, 4)
    assert.equal(seen[1].messages[0].content[0].text, first, 'system 规则前缀必须逐字节一致以命中 KV 缓存')
    assert.equal(seen[1].messages[1].content[0].text, seen[0].messages[1].content[0].text, '原始 user 前缀必须逐字节一致')
    assert.equal(seen[1].messages[2].role, 'assistant')
    assert.ok(seen[1].messages[2].content[0].text.includes(JSON.stringify(bad)), '上一轮原文必须逐字带上，不能让模型凭空编子任务')
    const repairUser: string = seen[1].messages[3].content[0].text
    assert.match(repairUser, /待修问题/)
    assert.doesNotMatch(repairUser, /可用部门/, '修复增量消息不得重发部门表')
    assert.doesNotMatch(repairUser, /输出 JSON 结构/, '修复增量消息不得重发 JSON 结构说明')
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_CONTEXT_GUARD
    else process.env.DSH_WORKPLAN_CONTEXT_GUARD = previous
  }
})

test('W5：状态指纹只认真实变化，revision 抬升即视为变化', () => {
  const before = [{ subtaskId: 'T1', status: 'in_progress', revision: 1 }]
  assert.equal(statusFingerprint(before), statusFingerprint([{ subtaskId: 'T1', status: 'in_progress', revision: 1 }]))
  assert.notEqual(statusFingerprint(before), statusFingerprint([{ subtaskId: 'T1', status: 'in_progress', revision: 2 }]))
  assert.notEqual(statusFingerprint(before), statusFingerprint([{ subtaskId: 'T1', status: 'done', revision: 1 }]))
})

test('W6：回喂开工证据走文件路径摘要，不再把登记全文重复注入一次', () => {
  const registered = MAIN_START_PHASES_FIXTURE
  const withRef = buildChildPrompt({
    plan: { planId: 'wp-x', stages: [] } as any,
    subtask: { id: 'T1', title: '任务', department: 'engineering', role: 'expert', objective: '目标', method: [], inputs: [], outputs: [], acceptance: [], dependsOn: [] } as any,
    stage: { id: 'S1', subtasks: [] } as any,
    dependencyResults: [],
    cwd: '/tmp',
    previousFailure: {
      attempt: 1,
      code: 'EVIDENCE_INCOMPLETE',
      message: '证据缺口',
      registeredStartPhases: registered,
      startEvidenceRef: '/tmp/wp-start-evidence-T1.json',
    },
  } as any)
  assert.match(withRef, /开工登记证据·接续摘要/)
  assert.match(withRef, /\/tmp\/wp-start-evidence-T1\.json/)
  // 摘要只列蓝图与索引；第一步长句不再逐字重发。
  assert.doesNotMatch(withRef, /第一步任务梳理：现状是计划已生成待派发/)
})
