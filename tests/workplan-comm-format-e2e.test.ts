/*
 * [2.1.0] T4 端到端验证：沟通交流格式门禁的「退回 → 修正 → 通过」真实链路。
 *
 * 与 `tests/workplan-comm-format.test.ts` 的分工：
 *  - 那个文件验证纯函数（checkCommFormatCompliance / adjudicateResult）逐条判定；
 *  - 本文件用真实 `createWorkplanRuntime` + 假子会话跑完整派发链路，验证：
 *    1. 不合规结果在真实派发里被记为 blocked/comm-format，且计划没有被标记完成；
 *    2. 用合规结果重派（走计划 blocked 的自动续跑路径）后同一子任务可判 done，
 *       且不残留退回状态（blockedKind/error 归零）；
 *    3. 子任务提示词确实附带同一份《沟通交流格式规范》（下发环节）。
 *
 * 另外验证「退回通知随下一次激活送达子提示词」——用户要求 2 的「通知」环节，
 * 2.1.1 修复前这里是断的（resetBlockedStatuses 先清掉了 blockedKind/error）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  buildPlanMessage,
} from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'

// 本次端到端验证不得往用户的永久教训记忆里写测试数据。
process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `t4-comm-format-lessons-${process.pid}.jsonl`,
)

function block(payload: any) {
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function phasesFixture() {
  return {
    planning: {
      problemAnalysis: ['现状：接口未实现；约束：不能改线上配置；未知：对端限流阈值；主要矛盾：覆盖率与时间。'],
      constraints: ['不得修改生产配置'],
      unknowns: ['对端限流阈值未确认'],
      approach: ['先读现有实现确认入口 → 写最小实现 → 跑测试 → 对照验收标准逐条记录证据。'],
    },
    execution: { steps: ['读源码确认入口', '实现通道', '运行测试并记录输出'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: '通道可用', method: 'node --test', evidence: '1/1 pass' }],
      requirementCheck: '用户原要求已逐条核对，无遗漏。',
      retrospective: {
        problems: ['一开始没有找到入口文件；根因是没有先读模块导出表。'],
        detours: ['先猜文件名浪费了一轮检索。'],
        resolutions: ['改为读 package.json 的 exports 再定位入口。'],
        prevention: ['遇到入口不明的模块，先读 package.json exports 再找文件。'],
      },
    },
  }
}

function payload(overrides: any = {}) {
  return {
    status: 'done',
    summary: '通道已实现',
    phases: phasesFixture(),
    acceptance: [{ criterion: '通道可用', result: 'pass', evidence: 'node --test 1/1 pass' }],
    artifacts: [{ kind: 'file', ref: 'src/host.ts' }],
    needs: [],
    ...overrides,
  }
}

/** 只违反 F4（pass 未附证据）的结果：其余门禁（F1/F2/F3/F5/F7）都通过。 */
function nonCompliantOutput() {
  return block(payload({
    acceptance: [{ criterion: '通道可用', result: 'pass' }],
  }))
}

/** 修正后合规的结果。 */
function compliantOutput() {
  return block(payload())
}

function makePlan() {
  return {
    planId: 'wp-comm-e2e',
    sessionId: 'session-comm-e2e',
    createdTurn: 1,
    createdAt: 1000,
    title: '沟通格式门禁端到端',
    taskUnderstanding: { originalRequest: '验证退回与修正后通过', deliverable: '门禁验证记录' },
    contradictions: { primary: { statement: '格式不合规必须退回' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '完成通道并交付',
      rationale: '单步即可验证门禁',
      subtasks: [{
        id: 'T1',
        title: '实现通道',
        department: 'engineering',
        role: 'engineer',
        objective: '实现通道并通过验收',
        method: ['实现', '测试'],
        inputs: [],
        outputs: ['代码'],
        acceptance: ['通道可用'],
        risk: '低',
        dependsOn: [],
      }],
    }],
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-comm-e2e',
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

function completed(text: string) {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

/** 假子会话：按顺序返回脚本化结果，并记录每次收到的提示词全文。 */
function makeRuntime(outputs: string[]) {
  const prompts: string[] = []
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan()))
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        const prompt = String(activation?.request?.prompt?.[0]?.text ?? '')
        prompts.push(prompt)
        const output = outputs.shift() ?? compliantOutput()
        return {
          childId: `child-comm-${prompts.length}`,
          result: Promise.resolve(completed(output)),
          dispose: async () => {},
        }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    childTimeoutMs: 20_000,
    maxResumes: 4,
    autoResume: false,
  })
  return { session, runtime, prompts }
}

function rowOf(out: any, id = 'T1') {
  return (Array.isArray(out?.statuses) ? out.statuses : []).find((item: any) => item.subtaskId === id)
}

test('端到端：不合规结果被退回且不计完成，修正后同一子任务可通过', async () => {
  const { session, runtime, prompts } = makeRuntime([nonCompliantOutput(), compliantOutput()])
  const signal = new AbortController().signal

  /* ---------- 第 1 轮：不合规 → 退回 ---------- */
  const first: any = await runtime.dispatchTool({ session, options: {} }, {}, signal)
  const rejected = rowOf(first)

  assert.equal(first.ok, true, '派发本身应成功返回，而不是抛错')
  assert.equal(rejected.status, 'blocked', '不合规结果不得被标记为 done')
  assert.equal(rejected.blockedKind, 'comm-format', '退回必须带可识别的 comm-format 标识')
  assert.equal(rejected.verification, 'unverified', '被退回的结果证据等级是 unverified')
  assert.match(String(rejected.error), /沟通交流格式不合规/, '错误信息必须写明格式不合规')
  assert.match(String(rejected.error), /F4/, '错误信息必须点名不合规条目 F4')
  assert.equal(first.stats.done, 0, '退回后完成计数必须为 0')
  assert.equal(first.complete, false, '退回后计划不得被标记完成')
  assert.equal(first.deliveryReady, false, '退回后不得可交付')

  // 下发环节：第 1 次派发的提示词必须附带同一份规范（F1-F9 + 自查指令）。
  assert.match(prompts[0], /沟通交流格式规范/, '派发提示词必须附带格式规范')
  for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9']) {
    assert.ok(prompts[0].includes(`【${id}】`), `派发提示词缺少规范条目 ${id}`)
  }
  assert.match(prompts[0], /提交前自查（强制）/, '派发提示词必须要求提交前自查')

  /* ---------- 第 2 轮：合规 → 通过 ---------- */
  const second: any = await runtime.dispatchTool({ session, options: {} }, {}, signal)
  const passed = rowOf(second)

  assert.equal(second.ok, true)
  assert.equal(passed.status, 'done', '修正格式后同一子任务必须可判完成')
  assert.equal(passed.verification, 'structured', '合规结果应落为 structured 证据')
  assert.equal(passed.error, null, '完成后不得残留退回错误信息')
  assert.equal(passed.blockedKind, null, '完成后不得残留退回标识')
  assert.equal(second.stats.done, 1)
  assert.equal(second.complete, true)

  /*
   * 用户要求 2 的「通知」环节：退回不能只在状态行留一个记号，必须把退回原因
   * 随下一次激活送回部门人员，它才知道要重新检查哪几条格式。
   *
   * 2.1.1 修复前这里是 false：续跑时 `resetBlockedStatuses` 先把受阻行连同
   * blockedKind/error 一起清掉，退回通知永远送不到。修复后在重置前抄写、
   * 由 executeSubtask 消费，下面三条断言把这条链路钉住，防止再退回去。
   */
  const secondPrompt = prompts[1] ?? ''
  assert.match(secondPrompt, /上一次尝试失败/, '第 2 次激活必须带「上一次尝试失败」段')
  assert.match(secondPrompt, /COMM_FORMAT_REJECTED/, '第 2 次激活必须标明失败类型是格式退回')
  assert.match(secondPrompt, /沟通交流格式不合规/, '第 2 次激活必须复述退回原因（逐条不合规项）')
  assert.ok(secondPrompt.length > (prompts[0]?.length ?? 0), '第 2 次激活提示词应比第 1 次更长（多出退回段）')
})

test('端到端：合规结果一次通过，不被门禁误拦', async () => {
  const { session, runtime } = makeRuntime([compliantOutput()])
  const out: any = await runtime.dispatchTool({ session, options: {} }, {}, new AbortController().signal)
  const row = rowOf(out)
  assert.equal(row.status, 'done')
  assert.equal(row.blockedKind, null)
  assert.equal(row.error, null)
  assert.equal(out.stats.done, 1)
})
