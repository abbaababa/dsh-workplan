/*
 * [3.0.1][治本] 规划守卫判出「只有用户能答复」时，绝不允许规划器重试后猜过去。
 *
 * 用户报告的真实行为：插件判定任务需要向用户澄清，却先把任务拆成计划并自动
 * 派发——部门 Agent 在用户答复前就已经开工。根因有两层：
 *
 *  1) 规划守卫（validatePlanContext）给出 CLARIFY:/CONTEXT: 错误后，runPlanner
 *     旧实现把它们当普通校验错误交回规划器重试；规划器为了「修好」只能替用户
 *     瞎猜（随便消解矛盾、随便指定指代对象），猜过守卫后计划照常生成并自动派发。
 *  2) 入口 catch 只认「降级」一条出口，把「等用户答复」误报成「分解失败」。
 *
 * 修复后的契约（本文件钉住）：
 *  - CLARIFY:/CONTEXT: 类错误第一次尝试即抛 PlanError('CLARIFY_NEEDED')，
 *    绝不进入下一次规划尝试（stream 只被调用 1 次），问题与建议问句挂在 details；
 *  - DEVIATION 类错误（规划器自己能改写修复）保持旧行为：重试到次数上限；
 *  - 遥测 outcome 留痕 'CLARIFY_NEEDED'，复盘可见「这次是等用户，不是失败」。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { runPlanner } from '../src/runtime.js'

/*
 * 规划器计时器不 unref，Node 22 在事件循环空掉时会取消挂起的测试：
 * 1 秒心跳顶住，60 秒后自行放手（与 planner-salvage.test.ts 同法）。
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function fakeCtx(scenario: (signal: AbortSignal) => AsyncGenerator<any>, seen: any[] = []) {
  return {
    llm: {
      stream(options: any) {
        seen.push(options)
        return { [Symbol.asyncIterator]: () => scenario(options.signal) }
      },
    },
  } as any
}

function runOptions(overrides: any = {}) {
  const telemetry: any = {}
  return {
    telemetry,
    options: {
      // 「它」在最近对话里没有先行词（conversationContext 为空）⇒ 守卫必出 CONTEXT:。
      taskText: '把它整理成三段，每段不超过五行。',
      cwd: '/tmp',
      sessionId: 'session-clarify-audit-gate',
      modelSelection: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'high' },
      signal: new AbortController().signal,
      conversationContext: '',
      budget: { totalMinutes: 20, childMinutes: 15, concurrency: 5, maxResumes: 4 },
      sourceMessageIds: [],
      ...overrides,
    },
  }
}

/** 与 planner-salvage.test.ts 同一份最小合法计划夹具（能通过 validatePlan）。 */
function planFixture() {
  return {
    version: 1,
    title: '整理说明文档',
    taskUnderstanding: {
      originalRequest: '把它整理成三段，每段不超过五行。',
      deliverable: '整理后的三段文本',
      successCriteria: ['每段不超过五行'],
      constraints: ['不要改动原意'],
      knownFacts: ['用户要求分三段'],
      unknowns: ['原文长度未知'],
      assumptions: ['原文可分段'],
    },
    contradictions: {
      primary: {
        statement: '简洁与完整之间的矛盾',
        evidence: ['每段不超过五行'],
        whyPrimary: '过短可能丢信息',
      },
      secondary: [],
      transformationConditions: [],
    },
    stages: [
      {
        id: 'S1',
        name: '整理',
        goal: '完成三段整理',
        rationale: '直接执行',
        checkpoint: '文本分三段',
        subtasks: [
          {
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
          },
        ],
      },
    ],
    risks: [
      { risk: '信息丢失', likelihood: 'low', impact: '内容不完整', mitigation: '校对', trigger: '段过短' },
    ],
    verification: [{ item: '每段不超过五行', method: '逐段计数', evidence: '最终文本' }],
    practiceLoop: { plan: '读', do: '整理', check: '核对', act: '修正' },
  }
}

/** 一次性正常吐完正文并给 finish 信号（不经抢救路径）。 */
async function* streamOnce(full: string, signal: AbortSignal) {
  void signal
  yield { type: 'text-delta', text: full }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('守卫判出 CONTEXT（指代无先行词）→ 第一次尝试即 CLARIFY_NEEDED，不重试、不派发', async () => {
  const seen: any[] = []
  const { telemetry, options } = runOptions()
  await assert.rejects(
    () => runPlanner(fakeCtx((signal) => streamOnce(JSON.stringify(planFixture()), signal), seen), { ...options, telemetry }),
    (error: any) => {
      assert.equal(error.code, 'CLARIFY_NEEDED', `必须是等用户的终态，不是 PLANNER_FAILED：${error.message}`)
      assert.match(error.message, /指代/, '原因必须向用户说清楚是哪一个信息缺失')
      assert.ok(typeof error.details === 'string' && error.details.length > 8, 'details 必须带可原样转给用户的问句')
      return true
    },
  )
  assert.equal(seen.length, 1, 'CLARIFY/CONTEXT 类错误绝不允许交给规划器重试（第二次只能瞎猜）')
  assert.equal(telemetry.outcome, 'CLARIFY_NEEDED', '遥测必须留痕「等用户」，不得标成失败/降级')
})

test('DEVIATION 类错误保持旧行为：规划器重试到次数上限，错误码 DEVIATION', async () => {
  // taskText 没有指代、没有守卫 C1–C4 特征；计划的 originalRequest 与任务不符
  // ⇒ 守卫只出 DEVIATION 类错误 ⇒ 应交回规划器重试（旧契约不变）。
  const seen: any[] = []
  const { telemetry, options } = runOptions({
    taskText: '把版本号改成 1.12.0，并同步 README 与 CHANGELOG。',
    conversationContext: '',
  })
  const mismatched = planFixture()
  mismatched.taskUnderstanding.originalRequest = '整理一份完全不相干的旧文档'
  await assert.rejects(
    () => runPlanner(fakeCtx((signal) => streamOnce(JSON.stringify(mismatched), signal), seen), { ...options, telemetry }),
    (error: any) => {
      assert.equal(error.code, 'DEVIATION', `DEVIATION 类必须走完重试后报 DEVIATION：${error.code} ${error.message}`)
      return true
    },
  )
  assert.ok(seen.length >= 2, `DEVIATION 类必须允许重试（实际 ${seen.length} 次）`)
})
