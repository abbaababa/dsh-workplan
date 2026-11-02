/*
 * [1.10.6] T6 G1/G3/G4 的集成用例：硬超时到底会不会重试，以及重试前有没有
 * 真的核对过已落盘的产物。
 *
 * T6 的探针证明「策略说会、链路不会」：`shouldRetryAttempt(CHILD_TIMEOUT)`
 * 返回 true，但真实 dispatch 只启动了一次子 Agent。纯函数用例（只测
 * `shouldRetryAttempt`）因此一直是绿的，却拦不住这条断链——所以这里不测纯
 * 函数，而是用假子 Agent 跑完整个 `dispatchPlan`：
 *
 *  1) 硬超时 + 整轮预算充足 → 恰好再启动一次（activationCalls === 2），且第二次
 *     的提示词带着上一次失败（`CHILD_TIMEOUT`），不是原样重试；
 *  2) 超时后已落盘产物被改动 → 不启动第二次（activationCalls === 1），行标记
 *     `artifactConflict`，宁可停下来让人核对，也不覆盖别人的产物。
 *
 * 这两个断言一起才构成「自动续跑一次、而且不重复产出」的最小闭环：只加自动
 * 重试会把「停摆」换成「重复产出」，只加产物核对则永远不会重试。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStatuses, derivePlanSnapshot } from '../src/plan.js'
import { dispatchPlan } from '../src/runtime.js'

/*
 * `dispatchPlan` 的计时器都是 unref 的（宿主关闭时不能被插件拖住），而 Node 22
 * 在事件循环空掉时会取消挂起的测试。真正的宿主总有 HTTP server 这类 ref 句柄，
 * 这里用一个 1 秒心跳代替它，60 秒后自行放手，避免真卡死时拖住 CI。
 */
const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlan(outputs: string[] = []) {
  return {
    planId: 'wp-auto-retry',
    sessionId: 'session-auto-retry',
    createdTurn: 1,
    createdAt: 1000,
    title: '硬超时自动重试一次',
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '写报告',
        department: 'engineering',
        objective: '写报告',
        method: ['写'],
        inputs: [],
        outputs,
        acceptance: ['报告存在'],
        risk: 'low',
        dependsOn: [],
      }],
    }],
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
    id: 'session-auto-retry',
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

function hangingChild() {
  return { childId: 'child-hang', result: new Promise(() => {}), dispose: async () => {} }
}

function quickChild(text = '完成') {
  return {
    childId: 'child-quick',
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
    dispose: async () => {},
  }
}

function makeCtx(startActivation: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: (spec: any) => startActivation(spec) },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

test('硬超时且预算充足时自动重试一次，第二次带着 CHILD_TIMEOUT 失败原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-auto-retry-'))
  mkdirSync(join(dir, 'out'), { recursive: true })
  try {
    const plan = makePlan(['out/report.md'])
    const record = makeRecord(plan)
    const session = makeSession()
    const prompts: string[] = []
    let calls = 0
    const ctx = makeCtx((spec: any) => {
      calls += 1
      prompts.push(String(spec?.request?.prompt?.[0]?.text ?? ''))
      if (calls === 1) {
        // 第一次执行先落盘再「卡住」：真实事故里子 Agent 就是这样，产物已写出
        // 但会话被上限掐断。
        writeFileSync(join(dir, 'out/report.md'), '# first attempt\n')
        return hangingChild()
      }
      return quickChild('完成')
    })

    const result = await dispatchPlan(ctx, record, {
      agent: { session, options: {} },
      signal: new AbortController().signal,
      cwd: dir,
      idleTimeoutMs: 60_000,
      childTimeoutMs: 1_000,
      // 远大于 120s 的重试下限：证明「有预算」分支被走到。
      totalTimeoutMs: 400_000,
      // 假子会话只回散文，没有证据块；本条只验证重试策略。
      strictEvidence: false,
    })

    assert.ok(result)
    assert.equal(calls, 2, '硬超时只自动重试一次：第一次 + 第二次')
    assert.equal(prompts.length, 2)
    assert.match(prompts[1], /上一次尝试失败/, '第二次必须知道上一次失败，而不是原样重试')
    assert.match(prompts[1], /CHILD_TIMEOUT/)

    const stats = derivePlanSnapshot(record.statuses).stats
    assert.equal(stats.done, 1, '重试成功后应算完成，而不是继续挂着 blocked')
    assert.equal(stats.blocked, 0)
    assert.equal(record.phase, 'done')
    const row = record.statuses.find((item: any) => item.subtaskId === 'T1')
    assert.equal(row?.status, 'done')
    assert.equal(row?.artifactConflict, undefined, '无冲突时不得留下 artifactConflict')
    assert.ok(
      record.errors.some((line: string) => /已核对产物无冲突，自动重试一次/.test(line)),
      '重试这件事必须留痕，事后能看出发生过什么',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重试前核对发现产物在超时后被改动：不覆盖、不重试、标记 artifactConflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-auto-retry-conflict-'))
  try {
    const plan = makePlan(['out/report.md'])
    const record = makeRecord(plan)
    const session = makeSession()
    const target = join(dir, 'out/report.md')
    mkdirSync(join(dir, 'out'), { recursive: true })
    let calls = 0
    const prompts: string[] = []
    const ctx = makeCtx((spec: any) => {
      calls += 1
      prompts.push(String(spec?.request?.prompt?.[0]?.text ?? ''))
      if (calls > 1) return quickChild('不应该被调用')
      // 第一次先落盘，再挂起等待上限。
      writeFileSync(target, '# first attempt\n')
      return {
        childId: 'child-hang',
        result: new Promise(() => {}),
        /*
         * 关键时序：`dispose()` 在「超时回调取完快照」之后、「重试前复核」之前
         * 执行（executeSubtask 的 finally → runSubtask 的剩余逻辑）。在这里改写
         * 文件，模拟另一个写者在空窗期接手了同一份产物。
         *
         * 这正是能区分「超时那一刻取快照」与「两次快照背靠背取」的时序：旧实现
         * 两次读取都在 dispose 之后，永远读不到差别；只有把第一次快照放进超时
         * 回调里，才能发现文件已经变了。
         */
        dispose: async () => {
          writeFileSync(target, '# rewritten by somebody else after the timeout\n')
        },
      }
    })

    const result = await dispatchPlan(ctx, record, {
      agent: { session, options: {} },
      signal: new AbortController().signal,
      cwd: dir,
      idleTimeoutMs: 60_000,
      childTimeoutMs: 1_000,
      totalTimeoutMs: 400_000,
      strictEvidence: false,
    })

    assert.ok(result)
    assert.equal(calls, 1, '产物有变动时不得启动第二次执行')
    assert.equal(prompts.length, 1)

    const row = record.statuses.find((item: any) => item.subtaskId === 'T1')
    assert.equal(row?.status, 'blocked', '超时仍然是 blocked，重试只负责补跑、不改判')
    assert.deepEqual(row?.artifactConflict, ['out/report.md'])
    assert.match(String(row?.error), /已跳过自动重试/)
    assert.match(String(row?.error), /out\/report\.md/)
    assert.ok(
      record.errors.some((line: string) => /为避免覆盖已跳过自动重试/.test(line)),
      '跳过重试的原因必须进入错误列表，主 Agent 才能看到',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
