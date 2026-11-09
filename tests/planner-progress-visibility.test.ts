/*
 * [2.2.5][T5] 分解期间进度可见性回归（T1 P-5/P-6/P-7 / T3 交互规范 §2-§5）。
 *
 * 缺陷：runPlanner 全程零进度透出，用户无法区分「正在重试」与「卡死」。
 * 修复后契约（每条对应验收标准）：
 *  A1 偶发抖动：第 1 次失败（可退避重试）→ onProgress 回调一次（含退避毫秒、
 *     非终态、真因链含 ECONNREFUSED）；占位卡片 errors 出现「第 1 次尝试失败…
 *     正在重试（约 N 秒后），第 2/3 次」；通道 B 发 1 条通知。
 *  A2 真故障：3 次全部失败 → runPlanner 拒绝，最终报错含逐次真因链
 *     （ECONNREFUSED 原样保留）；第 3 次失败不发通知（直接进降级文案）。
 *  A3 硬规则：通知每轮 ≤2 条；signal.aborted 后全静默；真因 >120 字符被
 *     截断；文案分母来自 maxAttempts 参数（不硬编码 3）。
 *  P-9 词汇：zh/en LOCALE.phase 均含 clarify 键（否则卡片徽标回显原始键名）。
 *
 * runPlanner 用假 ctx.llm.stream 跑完整链路；失败夹具用生产同构的
 * finish-error 块（reason.kind='error' + failure.code + failure.cause），
 * 与宿主 dsh-llm 的真实失败形状一致。上下文闸用文档化开关
 * DSH_WORKPLAN_CONTEXT_GUARD=off 关闭（夹具任务与闸审计文本不同构，同
 * planner-salvage.test.ts 的做法）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { createPlannerProgressReporter, plannerProgressLines } from '../src/plan.js'
import { runPlanner } from '../src/runtime.js'

/*
 * 与 planner-salvage.test.ts 相同的事件循环锚：规划器计时器不 unref，
 * 测试期间用 1 秒心跳顶住。
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

/** 设置环境变量跑 fn，无论成败都恢复原状（node:test 同文件顺序执行）。 */
async function withEnv(name: string, value: string | undefined, fn: () => Promise<void>) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

function planFixture() {
  return {
    version: 1,
    title: '验证一个需求',
    taskUnderstanding: {
      originalRequest: '请验证这个需求是否可行',
      deliverable: '一份验证报告',
      successCriteria: ['报告给出可复现的证据'],
      constraints: ['不要修改业务代码'],
      knownFacts: ['用户要求验证可行性'],
      unknowns: ['现有测试覆盖率未知'],
      assumptions: ['验证环境可用'],
    },
    contradictions: {
      primary: {
        statement: '验证深度与时间成本之间的矛盾',
        evidence: ['任务要求证据，但时间有限'],
        whyPrimary: '证据不足会导致结论不可信',
      },
      secondary: ['环境差异可能影响结论'],
      transformationConditions: ['如果获得可复现环境，次要矛盾上升'],
    },
    stages: [
      {
        id: 'S1',
        name: '准备',
        goal: '明确验证范围',
        rationale: '先界定范围避免无效工作',
        checkpoint: '范围获得确认',
        subtasks: [{
          id: 'T1',
          title: '梳理验证范围',
          department: 'research',
          role: '需求分析',
          objective: '列出需要验证的假设',
          method: ['阅读需求', '列出假设'],
          inputs: ['用户需求'],
          outputs: ['假设清单'],
          dependsOn: [],
          acceptance: ['每个假设都有验证方法'],
          risk: '假设遗漏',
        }],
      },
    ],
    risks: [{
      risk: '环境不稳定',
      likelihood: 'medium',
      impact: '结果不可复现',
      mitigation: '记录环境版本',
      trigger: '同一检查结果不一致',
    }],
    verification: [{ item: '报告可复现', method: '按报告步骤重跑', evidence: '重跑日志' }],
    practiceLoop: { plan: '列假设', do: '执行检查', check: '核对证据', act: '修正结论' },
  }
}

const planJson = () => JSON.stringify(planFixture())

/** 一次尝试的剧本：finish-error 块（生产同构失败）或完整计划正文。 */
type Attempt = { fail: { message: string, code?: string, cause?: string } } | { text: string }

/** 假流：第 n 次调用按 scenarios[n] 剧本执行（超出后重复最后一个）。 */
function fakeCtx(scenarios: Attempt[]) {
  let call = 0
  return {
    llm: {
      stream() {
        const attempt = scenarios[Math.min(call, scenarios.length - 1)]
        call += 1
        const self = this
        return {
          async *[Symbol.asyncIterator]() {
            if ('fail' in attempt) {
              yield {
                type: 'finish',
                reason: {
                  kind: 'error',
                  failure: {
                    message: attempt.fail.message,
                    code: attempt.fail.code ?? 'TRANSPORT',
                    ...(attempt.fail.cause ? { cause: { message: attempt.fail.cause } } : {}),
                  },
                },
              }
              return
            }
            const text = attempt.text
            const step = Math.max(1, Math.ceil(text.length / 5))
            for (let i = 0; i < text.length; i += step) {
              await new Promise((resolve) => setTimeout(resolve, 2))
              yield { type: 'text-delta', text: text.slice(i, i + step) }
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  } as any
}

/** 偶发网络抖动的生产同构失败：外层只有包装文案，真因挂在 cause 上。 */
const jitterAttempt = (): Attempt => ({
  fail: { message: 'Connection error', code: 'TRANSPORT', cause: 'connect ECONNREFUSED 127.0.0.1:3080' },
})

function runOptions(overrides: any = {}) {
  return {
    taskText: '把这份说明整理成三段，每段不超过五行。',
    cwd: '/tmp',
    sessionId: 'session-planner-progress',
    modelSelection: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'high' },
    signal: new AbortController().signal,
    conversationContext: '',
    budget: { totalMinutes: 20, childMinutes: 15, concurrency: 5, maxResumes: 4 },
    sourceMessageIds: [],
    plannerTimeoutMs: 5_000,
    plannerIdleTimeoutMs: 5_000,
    ...overrides,
  }
}

test('A1 偶发抖动：第 1 次失败回调含退避与真因，第 2 次成功返回计划', async () => {
  const reports: any[] = []
  await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', async () => {
    const plan = await runPlanner(fakeCtx([
      jitterAttempt(),
      { text: planJson() },
    ]), runOptions({
      onProgress: (report: any) => reports.push(report),
    }))
    assert.equal(plan?.title, '验证一个需求', '第 2 次成功后照常返回计划（观察回调未改变重试语义）')
  })
  assert.equal(reports.length, 1, '成功尝试不回调，只回调失败尝试')
  assert.equal(reports[0].attempt, 1)
  assert.equal(reports[0].outcome, 'PLANNER_LLM_ERROR')
  assert.equal(reports[0].terminal, false)
  assert.equal(reports[0].aborted, false)
  assert.ok(reports[0].retryBackoffMs > 0, '可自愈失败必须带退避毫秒')
  assert.ok(
    reports[0].lastErrors.join('；').includes('ECONNREFUSED'),
    `真因链必须透传底层原因，实际：${JSON.stringify(reports[0].lastErrors)}`,
  )
})

test('A1 通道 A/B：reporter 把失败尝试翻成卡片行与通知，成功尝试零噪音', () => {
  const record: any = { phase: 'planning', plan: null, errors: [], createdAt: 1, updatedAt: 1 }
  const setCalls: any[] = []
  const notices: string[] = []
  const reporter = createPlannerProgressReporter({
    record,
    setRecord: (r: any) => setCalls.push({ ...r }),
    appendNotice: (text: string) => notices.push(text),
    maxAttempts: 3,
  })
  reporter({ attempt: 1, outcome: 'PLANNER_LLM_ERROR', lastErrors: ['Connection error: connect ECONNREFUSED 127.0.0.1:3080'], retryBackoffMs: 900, terminal: false })
  reporter({ attempt: 2, outcome: 'ok', lastErrors: [], retryBackoffMs: 0, terminal: false })

  assert.equal(record.errors.length, 1, '成功尝试不产生卡片行')
  assert.match(
    record.errors[0],
    /第 1 次尝试失败（PLANNER_LLM_ERROR）：Connection error: connect ECONNREFUSED 127\.0\.0\.1:3080；正在重试（约 1 秒后），第 2\/3 次/,
    '卡片行必须含真因、次数与等待（T3 C3）',
  )
  assert.equal(notices.length, 1)
  assert.match(notices[0], /^【自动分解】第 1 次尝试失败：/, '通知走 T3 C2 模板')
  assert.match(notices[0], /正在重试（约 1 秒后），第 2\/3 次/)
  assert.ok(setCalls.length >= 1, '每次失败尝试都必须重放 records.set（4 秒轮询才能看到）')
})

test('A2 真故障：3 次全败 → 拒绝并带逐次真因链；第 3 次不发通知', async () => {
  const reports: any[] = []
  const record: any = { phase: 'planning', plan: null, errors: [], createdAt: 1, updatedAt: 1 }
  const notices: string[] = []
  const reporter = createPlannerProgressReporter({
    record,
    setRecord: () => {},
    appendNotice: (text: string) => notices.push(text),
    maxAttempts: 3,
  })
  await withEnv('DSH_WORKPLAN_CONTEXT_GUARD', 'off', async () => {
    await assert.rejects(
      runPlanner(fakeCtx([jitterAttempt()]), runOptions({
        onProgress: (report: any) => {
          reports.push(report)
          reporter(report)
        },
      })),
      (error: any) => {
        assert.equal(error.code, 'PLANNER_FAILED')
        assert.match(error.message, /3 次尝试/)
        assert.match(error.message, /ECONNREFUSED/, '最终文案必须含底层真因，不再只是笼统的 Connection error')
        return true
      },
    )
  })
  assert.equal(reports.length, 3, '三次失败各回调一次')
  assert.equal(notices.length, 2, '通道 B 每轮至多 2 条：第 3 次失败直接进降级文案')
  assert.equal(record.errors.length, 2, '通道 A 卡片行同样 ≤2 行')
})

test('A3 硬规则：aborted 静默、真因截断 ≤120、最后一次失败不加「正在重试」、分母来自参数', () => {
  const abortedSignal = { aborted: true }
  const setCalls: any[] = []
  const notices: string[] = []
  const reporter = createPlannerProgressReporter({
    signal: abortedSignal,
    record: { errors: [] },
    setRecord: (r: any) => setCalls.push(r),
    appendNotice: (t: string) => notices.push(t),
    maxAttempts: 3,
  })
  reporter({ attempt: 1, outcome: 'TRANSPORT', lastErrors: ['boom'], retryBackoffMs: 500, terminal: false })
  assert.equal(setCalls.length, 0, 'signal.aborted 后不写记录')
  assert.equal(notices.length, 0, 'signal.aborted 后不发通知')

  const longCause = 'x'.repeat(300)
  const lines = plannerProgressLines({ attempt: 1, outcome: 'TIMEOUT', lastErrors: [longCause], retryBackoffMs: 1200 }, 3)
  assert.ok(lines.notice && !lines.notice.includes('x'.repeat(121)), '真因链展示必须截断 ≤120 字符')
  assert.match(lines.notice!, /约 1 秒后/, '等待时长按实际退避四舍五入到秒')

  const last = plannerProgressLines({ attempt: 3, outcome: 'TIMEOUT', lastErrors: ['boom'], retryBackoffMs: 0 }, 3)
  assert.doesNotMatch(last.cardLine, /正在重试/, '最后一次失败不再预告重试')
  assert.equal(last.notice, null, '最后一次失败不发通知（直接进降级文案）')

  const total = plannerProgressLines({ attempt: 1, outcome: 'TIMEOUT', lastErrors: ['boom'], retryBackoffMs: 500 }, 5)
  assert.match(total.notice!, /第 2\/5 次/, '分母来自 maxAttempts 参数，不硬编码 3')
})

test('P-9 词汇：zh/en LOCALE.phase 均含 clarify 键', async () => {
  // 测试会被编译进 dist-tests/ 运行：源文件用 process.cwd()（包根）定位。
  const fs = await import('node:fs')
  const path = await import('node:path')
  const clientSource = fs.readFileSync(path.resolve(process.cwd(), 'src/client.ts'), 'utf8')
  assert.match(clientSource, /"clarify": "等信息中"/, 'zh 表缺 clarify 键时卡片徽标会回显原始键名')
  assert.match(clientSource, /"clarify": "Waiting for info"/, 'en 表同步')
})
