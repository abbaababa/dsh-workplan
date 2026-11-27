/**
 * [3.4.1] macOS 27 + DSH 0.2.3-alpha.2 实机运行（计划 wp-c04490d4-71f2-4b69-a0fa-87cdfc52ae09）
 * 全量取证根因（RC-1 ~ RC-8）回归测试。
 *
 * 所有样本直接取自用户上传的 12 份实机会话日志（d07bc394 / 1972a885 / 972522c3 /
 * 0af9667b / f0924f30 / 994c9095 / session-4dbdce9e）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adjudicateResult,
  buildChildPrompt,
  buildPlanMessage,
  createStatuses,
} from '../src/plan.js'
import {
  createVerifyTool,
  detectChildToolPhase,
  workplanToolAdmitted,
} from '../src/host.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

const EXPECTED_ACCEPTANCE_2 = [
  'A1 给出插件目录的真实路径与版本核验结果',
  'A2 产物写到 reports/wp-c04490d4-T1/version-verification.md',
]

function wrapEvidence(payload: any): string {
  return `版本核验已完成，产物已落盘。\n\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(payload)}\n<!-- WORKPLAN_EVIDENCE:END -->`
}

const VALID_TOP_ACCEPTANCE = [
  { criterion: 'A1', result: 'pass', evidence: '/Users/open/dsh-workplan-340/package.json version="3.4.0"' },
  { criterion: 'A2', result: 'pass', evidence: 'reports/wp-c04490d4-T1/version-verification.md 已写入并复核' },
]

const VALID_SUMMARY = {
  keyResults: ['运行态插件版本确认为 3.4.0，入口与声明位一致'],
  keyInfo: ['运行态目录 /Users/open/dsh-workplan-340'],
  importantInfo: [],
  sources: [],
}

test('[3.4.1][RC-1] 实机 T1(d07bc394/1972a885/972522c3)、T2(0af9667b)、T3(f0924f30) 五种真实 checks 写法全部一次通过结算闸', () => {
  // 1) T1 Attempt 1 (d07bc394): checks 用 { check, result, evidence }
  const t1Attempt1 = adjudicateResult({
    output: wrapEvidence({
      status: 'done',
      phases: {
        execution: { steps: ['定位插件根目录并比对 package.json 与 lib/host.js 版本字面量'], deviations: [] },
        verification: {
          allPassed: true,
          checks: [
            { check: 'A1 路径与版本核验', result: 'pass', evidence: 'package.json version=3.4.0' },
            { check: 'A2 核验报告落盘', result: 'pass', evidence: 'reports/wp-c04490d4-T1/version-verification.md' },
          ],
          retrospective: { noIssues: true },
        },
      },
      acceptance: VALID_TOP_ACCEPTANCE,
      artifacts: [{ kind: 'file', ref: 'reports/wp-c04490d4-T1/version-verification.md' }],
      departmentSummary: VALID_SUMMARY,
    }),
    strict: true,
    expectedAcceptance: EXPECTED_ACCEPTANCE_2,
    startPhases: MAIN_START_PHASES_FIXTURE,
    formatTier: 'leader',
    expectedExperts: [],
  })
  assert.equal(t1Attempt1.status, 'done', `T1 Attempt 1 真实格式应通过：${t1Attempt1.error}`)

  // 2) T1 Attempt 2 (1972a885): checks 写了描述性 criterion（不含 A1/A2 编号），但顶层 acceptance 已按 A1/A2 全覆盖
  const t1Attempt2 = adjudicateResult({
    output: wrapEvidence({
      status: 'done',
      phases: {
        execution: { steps: ['复核运行态软链与版本声明'], deviations: [] },
        verification: {
          allPassed: true,
          checks: [
            { criterion: '运行态插件版本字面量一致性', method: '读取 package.json 与 lib/host.js', evidence: '均为 3.4.0' },
          ],
          retrospective: { noIssues: true },
        },
      },
      acceptance: VALID_TOP_ACCEPTANCE,
      artifacts: [{ kind: 'file', ref: 'reports/wp-c04490d4-T1/version-verification.md' }],
      departmentSummary: VALID_SUMMARY,
    }),
    strict: true,
    expectedAcceptance: EXPECTED_ACCEPTANCE_2,
    startPhases: MAIN_START_PHASES_FIXTURE,
    formatTier: 'leader',
    expectedExperts: [],
  })
  assert.equal(t1Attempt2.status, 'done', `T1 Attempt 2 真实格式应通过：${t1Attempt2.error}`)

  // 3) T1 Resume Attempt 1 (972522c3): 完全照抄提示词模板（省略 allPassed 与 checks）
  const t1TemplateCopy = adjudicateResult({
    output: wrapEvidence({
      status: 'done',
      phases: {
        execution: { steps: ['按提示词模板提交收尾证据'], deviations: [] },
        verification: {
          retrospective: { noIssues: true },
        },
      },
      acceptance: VALID_TOP_ACCEPTANCE,
      artifacts: [{ kind: 'file', ref: 'reports/wp-c04490d4-T1/version-verification.md' }],
      departmentSummary: VALID_SUMMARY,
    }),
    strict: true,
    expectedAcceptance: EXPECTED_ACCEPTANCE_2,
    startPhases: MAIN_START_PHASES_FIXTURE,
    formatTier: 'leader',
    expectedExperts: [],
  })
  assert.equal(t1TemplateCopy.status, 'done', `照抄提示词模板（省略 checks/allPassed）应通过：${t1TemplateCopy.error}`)

  // 4) T2 Attempt 1 (0af9667b): checks 用 { item, result, evidence }
  const t2Attempt1 = adjudicateResult({
    output: wrapEvidence({
      status: 'done',
      phases: {
        execution: { steps: ['执行 5 项冒烟脚本并验证 HTTP 200/401'], deviations: [] },
        verification: {
          allPassed: true,
          checks: [
            { item: 'A1', result: 'pass', evidence: '5/5 smoke checks passed' },
            { item: 'A2', result: 'pass', evidence: 'reports/wp-smoke-T2/smoke-report.md' },
          ],
          retrospective: { noIssues: true },
        },
      },
      acceptance: VALID_TOP_ACCEPTANCE,
      artifacts: [{ kind: 'file', ref: 'reports/wp-smoke-T2/smoke-report.md' }],
      departmentSummary: VALID_SUMMARY,
    }),
    strict: true,
    expectedAcceptance: EXPECTED_ACCEPTANCE_2,
    startPhases: MAIN_START_PHASES_FIXTURE,
    formatTier: 'leader',
    expectedExperts: [],
  })
  assert.equal(t2Attempt1.status, 'done', `T2 Attempt 1 真实格式应通过：${t2Attempt1.error}`)

  // 5) T3 Attempt 2 (f0924f30): checks 用 { check, command, expected, actual, passed }
  const t3Attempt2 = adjudicateResult({
    output: wrapEvidence({
      status: 'done',
      phases: {
        execution: { steps: ['核验 0 条产品缺陷与命令级规避方案'], deviations: [] },
        verification: {
          allPassed: true,
          checks: [
            { check: 'A1', command: 'node reports/wp-smoke-T2/smoke.mjs', expected: '5/5 PASS', actual: '5/5 PASS, exit 0', passed: true },
            { check: 'A2', command: 'test -s reports/wp-c04490d4-T1/version-verification.md', expected: 'exit 0', actual: 'exit 0', passed: true },
          ],
          retrospective: { noIssues: true },
        },
      },
      acceptance: VALID_TOP_ACCEPTANCE,
      artifacts: [{ kind: 'file', ref: 'reports/wp-c04490d4-T1/version-verification.md' }],
      departmentSummary: VALID_SUMMARY,
    }),
    strict: true,
    expectedAcceptance: EXPECTED_ACCEPTANCE_2,
    startPhases: MAIN_START_PHASES_FIXTURE,
    formatTier: 'leader',
    expectedExperts: [],
  })
  assert.equal(t3Attempt2.status, 'done', `T3 Attempt 2 真实格式应通过：${t3Attempt2.error}`)
})

test('[3.4.1][RC-3] dsh_workplan_verify schema 支持 retrospective.noIssues，不强制要求四项长数组', () => {
  const tool = createVerifyTool({})
  const retroSchema: any = (tool.parameters as any).properties.phases.properties.verification.properties.retrospective
  assert.equal(retroSchema.properties.noIssues?.type, 'boolean')
  assert.equal(retroSchema.required, undefined, '不得在 schema 层强制 required 四项数组，避免诱导 2200+ 字符转义 JSON 触发 MALFORMED_RESPONSE')
})

test('[3.4.1][RC-4] Step 1 仅写入 agent/inbox/spliced（seq=3，尚无 user/message）时即识别 leader-phase-0，消除 Step 2 tool-removal 缓存击穿', () => {
  const events = [
    { type: 'subagent/descriptor', seq: 0, data: { label: 'engineering:T1' } },
    { type: 'sandbox/mode', seq: 1, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, data: { policy: 'never' } },
    {
      type: 'agent/inbox/spliced',
      seq: 3,
      data: {
        target: 'next-turn',
        start: 0,
        inserted: [
          {
            content: [
              { type: 'text', text: 'Agent lead sent a message: ' },
              { type: 'text', text: '你是 dsh-workplan 部门执行负责人，phase-0（先配置后开工，low 档启动）' },
            ],
          },
        ],
      },
    },
    { type: 'turn/start', seq: 4, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 5, data: { target: 'next-turn', removedCount: 1, inserted: [] } },
    { type: 'step/start', seq: 6, data: { turn: 1, step: 1 } },
  ]
  const session = {
    id: 'child-step1-spliced-only',
    header: { parentSession: 'session-root', origin: 'subagent', delegationDepth: 1 },
    seq: events.length,
    eventAt: (i: number) => events[i],
  }
  assert.equal(detectChildToolPhase(session, 1), 'leader-phase-0')
  assert.equal(workplanToolAdmitted('dsh_workplan_verify', session), false, 'Step 1 即隐藏 verify')
  assert.equal(workplanToolAdmitted('dsh_workplan_instruct', session), false, 'Step 1 即隐藏 instruct')
  assert.equal(workplanToolAdmitted('dsh_workplan_delegate', session), true, 'Step 1 保留 delegate')
})

test('[3.4.1][RC-5 & RC-8] buildChildPrompt：对象型 plan.verification 不再渲染 [object Object]；重试回喂附带 previousOutputDraft', () => {
  const prompt = buildChildPrompt({
    plan: {
      planId: 'wp-341-rc5',
      verification: [
        { item: '核验插件版本', method: '读取 package.json', evidence: 'version === "3.4.1"' },
        { item: '核验冒烟通过', method: '运行 smoke.mjs', evidence: '5/5 PASS' },
      ],
      stages: [],
    },
    subtask: {
      id: 'T1',
      title: '版本核验',
      department: 'engineering',
      role: '负责核验',
      objective: '确认版本',
      method: ['读取 package.json'],
      inputs: [],
      outputs: ['reports/wp-341-rc5-T1/out.md'],
      acceptance: EXPECTED_ACCEPTANCE_2,
      dependsOn: [],
    },
    stage: { id: 'S1', name: '阶段一', goal: '完成核验', subtasks: [] },
    dependencyResults: [],
    cwd: '/tmp/wp-341',
    previousFailure: {
      attempt: 1,
      code: 'EVIDENCE_INCOMPLETE',
      message: '验收缺口示例',
      previousOutputDraft: '<!-- WORKPLAN_EVIDENCE:START -->\n{"status":"done"}\n<!-- WORKPLAN_EVIDENCE:END -->',
    },
  })
  assert.doesNotMatch(prompt, /\[object Object\]/, '不得出现 [object Object]')
  assert.match(prompt, /计划级整体验证要求：核验插件版本（方法：读取 package\.json，证据：version === "3\.4\.1"）；核验冒烟通过（方法：运行 smoke\.mjs，证据：5\/5 PASS）/)
  assert.match(prompt, /上一次尝试已提交的结果草稿/, '重试提示必须附上一次结果草稿以免重做')
})

test('[3.4.1][RC-6] 0 专家 direct 负责人误写 report 字段时自动映射为 departmentSummary（sources:[]）', () => {
  const verdict = adjudicateResult({
    output: wrapEvidence({
      status: 'done',
      phases: {
        execution: { steps: ['direct 亲自完成核验'], deviations: [] },
        verification: { retrospective: { noIssues: true } },
      },
      acceptance: VALID_TOP_ACCEPTANCE,
      artifacts: [{ kind: 'file', ref: 'reports/wp-c04490d4-T1/version-verification.md' }],
      report: {
        keyResults: ['单兵完成版本核验'],
        keyInfo: ['路径一致'],
        importantInfo: [],
        leadRequirements: ['无'],
      },
    }),
    strict: true,
    expectedAcceptance: EXPECTED_ACCEPTANCE_2,
    startPhases: MAIN_START_PHASES_FIXTURE,
    formatTier: 'leader',
    expectedExperts: [],
  })
  assert.equal(verdict.status, 'done', `0 专家 direct 负责人写 report 应自动兼容通过：${verdict.error}`)
  assert.deepEqual((verdict as any).departmentSummary?.keyResults, ['单兵完成版本核验'])
})

test('[3.4.1][RC-2, RC-6, RC-7] 运行时：reasoning 块打捞结果块、重试保留已观测 noticeChannel、handoff 唯一 handoffId 自动反查 subtaskId、autoDispatch 续跑免重复交 startPhases', async () => {
  const plan: any = {
    planId: 'wp-341-runtime',
    title: '实机回归计划',
    summary: '验证 RC-2/RC-6/RC-7',
    createdAt: 1000,
    sessionId: 'session-root-341',
    contradictions: { primary: '主矛盾', secondary: [] },
    taskUnderstanding: {
      goal: '验证',
      deliverable: '核验结论',
      constraints: [],
      successCriteria: ['T1 完成'],
    },
    stages: [
      {
        id: 'S1',
        name: '阶段一',
        goal: '验证',
        subtasks: [
          {
            id: 'T1',
            title: '子任务一',
            department: 'engineering',
            role: '工程负责人',
            objective: '完成验证',
            method: ['核验'],
            inputs: [],
            outputs: [],
            acceptance: ['A1 完成核验'],
            dependsOn: [],
          },
        ],
      },
    ],
    verification: [{ item: '整体核验', method: '检查状态', evidence: 'T1 done' }],
  }
  const events: any[] = []
  const session: any = {
    id: 'session-root-341',
    header: { createdAt: 1000, cwd: '/tmp' },
    get seq() { return events.length },
    append(type: string, data: any) {
      events.push({ type, data, time: Date.now() })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
  session.append('user/message', buildPlanMessage(plan))
  seedLeaderSelfEffort(session, plan)

  let callCount = 0
  const ctx: any = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        callCount += 1
        const childId = `child-341-${callCount}`
        if (callCount === 1) {
          // 第 1 次尝试：向父会话成功转达了开工预告，但故意返回坏 JSON 触发第 2 次尝试
          events.push({
            type: 'agent/inbox/spliced',
            time: Date.now() + 1,
            data: {
              inserted: [
                {
                  content: [{ type: 'text', text: 'T1 开工预估 2 分钟' }],
                  source: { kind: 'agent-message', form: 'relay', senderSessionId: childId },
                },
              ],
            },
          })
          return {
            childId,
            result: Promise.resolve({
              stopReason: 'completed',
              output: [{ type: 'text', text: '<!-- WORKPLAN_EVIDENCE:START -->\n{bad json\n<!-- WORKPLAN_EVIDENCE:END -->' }],
            }),
            dispose: async () => {},
          }
        }
        // 第 2 次尝试（模拟 972522c3 + 1972a885）：不重复发 send_message，且把最终结果块只写在 reasoning 块里
        const payload = {
          status: 'done',
          phases: {
            execution: { steps: ['已完成核验'], deviations: [] },
            verification: { retrospective: { noIssues: true } },
          },
          acceptance: [{ criterion: 'A1', result: 'pass', evidence: '核验通过' }],
          artifacts: [],
          departmentSummary: VALID_SUMMARY,
        }
        return {
          childId,
          result: Promise.resolve({
            stopReason: 'completed',
            output: [
              {
                type: 'reasoning',
                text: `hi\n\n核验完成，结论正常。\n\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(payload)}\n<!-- WORKPLAN_EVIDENCE:END -->`,
              },
            ],
          }),
          dispose: async () => {},
        }
      },
    },
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
      list: () => [],
      eventAt: () => undefined,
    },
  }

  const runtime: any = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    maxResumes: 4,
    strictEvidence: true,
  })
  const statuses: any = createStatuses(plan)
  statuses[0].startPhases = MAIN_START_PHASES_FIXTURE
  statuses[0].effortOverride = 'low'
  statuses[0].handoffs = [
    { id: 'H1', department: 'research', request: '确认旧目录用途', status: 'open', createdAt: 1000 },
  ]
  // 模拟 autoDispatch 已跑过一轮后进入 blocked（mainStartPhases 为 null，但 dispatchedAt > 0）
  const record: any = {
    plan,
    statuses,
    phase: 'blocked',
    dispatchedAt: 1000,
    mainStartPhases: null,
    mainStartPhasesPlanId: null,
    updatedAt: 0,
    errors: [],
    notices: [],
  }
  runtime.state.records.set(session.id, record)
  const rootAgent = { id: session.id, session, options: {} }

  // RC-7a: 只传 handoffId="H1" 不传 subtaskId，应自动定位到 T1 并处置成功
  const resolved: any = await runtime.handoffTool(rootAgent, {
    action: 'resolve',
    handoffId: 'H1',
    response: '旧目录仅作对照，以 ~/dsh-workplan-340 为准',
  })
  assert.equal(resolved.ok, true, `唯一 handoffId 省略 subtaskId 应成功：${JSON.stringify(resolved)}`)
  assert.equal(resolved.subtaskId, 'T1')

  // RC-7b + RC-2 + RC-6: autoDispatch 过的计划续跑不传 startPhases 应直接放行；
  // 第 2 次尝试的 reasoning 块被成功打捞结算为 done；第 1 次尝试已观测到的 noticeChannel 不被覆盖为 NOT_OBSERVED
  const dispatched: any = await runtime.dispatchTool(rootAgent, { mode: 'wait' }, new AbortController().signal)
  assert.equal(dispatched.ok, true, `autoDispatch 续跑不应报 START_EVIDENCE_MISSING：${JSON.stringify(dispatched)}`)
  assert.equal(record.statuses[0].status, 'done', `reasoning 块结果应成功结算 done：${record.statuses[0].error}`)
  assert.equal(record.statuses[0].noticeChannel?.state, 'observed', '第 1 次尝试已观测的预告在重试跳过重复发送时应保留 observed')
  assert.equal(
    (record.errors ?? []).some((e: string) => e.includes('NOT_OBSERVED_IN_SESSION_LOG')),
    false,
    `不应再记录虚假的 NOT_OBSERVED_IN_SESSION_LOG：${JSON.stringify(record.errors)}`,
  )
})
