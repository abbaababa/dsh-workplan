/*
 * [2.2.8][T7] 结算容错：结果块 JSON 解析失败 → 有界回喂重报，而不是「一次即 blocked」。
 *
 * 缺陷现场（本次计划 T4 实证）：子会话工作已完成、交付物已在盘上，只是结果块
 * 写成了非法 JSON；旧结算链一次 unparsable 即判 blocked（blockedKind=failed），
 * 并级联阻断下游，出现「子会话实况=已完成」与「账本状态=受阻」的可见错位。
 * 修复后的契约（本文件逐条钉死）：
 *  A1 unparsable 触发与 CHILD_NOT_COMPLETED 同闸的有界自动重试（回喂解析器具体错误）；
 *  A2 重试成功后正常结算；重试仍失败才 blocked，且记录附产物清单与复核改判提示；
 *  A4 CHILD_NOT_COMPLETED 既有重试行为不回归；
 *  结算严格性不变：非法 JSON 永不计 done（两个 e2e 场景都断言这一点）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  buildPlanMessage,
  parseEvidenceBlock,
} from '../src/plan.js'
import { createWorkplanRuntime, shouldRetryAttempt } from '../src/runtime.js'

// 本文件不得往用户的永久教训记忆里写测试数据。
process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `t7-unparsable-retry-lessons-${process.pid}.jsonl`,
)

/** 确认不可被有界修复抢救的非法块（探针实测：malformed=true、repair 失败）。 */
function malformedOutput(tag: string) {
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n{ ${tag} 这不是合法 JSON ]]]\n${EVIDENCE_MARKER_END}`
}

function phasesFixture() {
  return {
    planning: {
      problemAnalysis: [
        '现状：结算链遇到非法 JSON 一次即判 blocked 并级联阻断下游；约束：非法 JSON 不得计 done、既有 CHILD_NOT_COMPLETED 语义不得回归；未知：blocked 行是否随投影丢字段；主要矛盾：恢复路径（回喂重报）与结算严格性（永不放行）必须在同一闸内并存；边界：只改结算链与纯函数判定，不动派发与看板。',
      ],
      constraints: ['不得放宽结算严格性：非法 JSON 永不计 done', '不改变 CHILD_NOT_COMPLETED 既有行为', '有界重试：最多两次激活，绝不无限循环'],
      unknowns: ['无（触达点已由审计钉死）'],
      approach: [
        '第 1 步：结算前用纯函数 adjudicateResult 预裁决一次（不写状态、不留双源）→ 产出本行 verdict → 证明：非法块判定 verification=unparsable。',
        '第 2 步：unparsable 且 shouldRetryAttempt 放行时抛 EVIDENCE_UNPARSABLE，由既有 catch 把解析器具体错误回喂同一子会话要求修正重报 → 证明：第二次激活提示词含「解析器报告」与在盘产物清单。',
        '第 3 步：重试仍失败才受阻，随行附在盘产物清单与 dsh_workplan_update 复核提示 → 证明：blocked 行 error 文案逐字可断言。',
      ],
    },
    execution: { steps: ['读现有实现确认入口', '实现通道', '运行测试并记录输出'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: '通道可用', method: 'node --test', evidence: '1/1 pass' }],
      requirementCheck: '用户原要求已逐条核对，无遗漏。',
      retrospective: {
        problems: ['现象：非法结果块一次即 blocked；根因：结算前没有 unparsable 分支，直接放行 settleFromOutput 写受阻。'],
        detours: ['曾考虑改投影透出 artifacts，会扩大本任务边界，已放弃并回到 error 文案留档。'],
        resolutions: ['把 unparsable 并入 CHILD_NOT_COMPLETED 同款有界回喂重试，重试耗尽才受阻且附在盘产物清单。'],
        prevention: ['遇到结算类失败先问「能否回喂同一子会话自纠」，先复用既有有界重试闸，再考虑落人工改判。'],
      },
    },
  }
}

/** 合法且过 F1-F9 全部门禁的重报（证明 unparsable→修正→done 这条恢复路径成立）。 */
function compliantOutput() {
  const payload = {
    status: 'done',
    summary: '通道已实现',
    phases: phasesFixture(),
    acceptance: [{ criterion: '通道可用', result: 'pass', evidence: 'node --test 1/1 pass' }],
    artifacts: [{ kind: 'file', ref: 'reports/t7-核对报告.md' }],
    needs: [],
  }
  return `修正后重报。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function makePlan() {
  return {
    planId: 'wp-t7-unparsable',
    sessionId: 'session-t7-unparsable',
    createdTurn: 1,
    createdAt: 1000,
    title: '结算容错：解析失败回喂重报',
    taskUnderstanding: { originalRequest: '验证 unparsable 走重试而非直接受阻', deliverable: '容错验证记录' },
    contradictions: { primary: { statement: '非法 JSON 不得计 done' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '完成通道并交付',
      rationale: '单步即可验证结算链',
      subtasks: [{
        id: 'T1',
        title: '实现通道',
        department: 'engineering',
        role: 'engineer',
        objective: '实现通道并通过验收',
        method: ['实现', '测试'],
        inputs: [],
        outputs: ['reports/t7-核对报告.md'],
        acceptance: ['通道可用'],
        risk: '低',
        dependsOn: [],
      }],
    }],
  }
}

function makeSession(cwd: string) {
  const events: any[] = []
  return {
    id: 'session-t7-unparsable',
    header: { createdAt: 1000, cwd },
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

/** 假子会话：按脚本顺序返回结果，记录每次激活收到的提示词全文。 */
function makeRuntime(outputs: string[], cwd: string) {
  const prompts: string[] = []
  const session = makeSession(cwd)
  session.append('user/message', buildPlanMessage(makePlan()))
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        const prompt = String(activation?.request?.prompt?.[0]?.text ?? '')
        prompts.push(prompt)
        const output = outputs.shift() ?? compliantOutput()
        return {
          childId: `child-t7-${prompts.length}`,
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

/* ------------------------------------------------------------------ 纯函数闸 */

test('shouldRetryAttempt：EVIDENCE_UNPARSABLE 与 CHILD_NOT_COMPLETED 同闸，attempt≥2 必停（A1/A2 有界性）', () => {
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_UNPARSABLE' }, 1, 60_000, 10_000), true,
    '预算还剩超过一个空闲窗口 → 第 1 次解析失败必须回喂重报，不是直接受阻')
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_UNPARSABLE' }, 1, 5_000, 10_000), false,
    '预算不足以再跑一次回喂 → 不重试，按实受阻')
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_UNPARSABLE' }, 2, 60_000, 10_000), false,
    '有界：第二次仍非法绝不无限循环')
  // A4 不回归：CHILD_NOT_COMPLETED 原语义逐字保持。
  assert.equal(shouldRetryAttempt({ code: 'CHILD_NOT_COMPLETED' }, 1, 60_000, 10_000), true)
  assert.equal(shouldRetryAttempt({ code: 'CHILD_NOT_COMPLETED' }, 2, 60_000, 10_000), false)
})

test('adjudicateResult：非法块判定 unparsable 且错误文案携带解析器具体位置（回喂的靶子）', () => {
  const output = malformedOutput('status')
  const parsed = parseEvidenceBlock(output)
  assert.equal(parsed.malformed, true)
  assert.equal(typeof parsed.parseError, 'string')
  assert.match(String(parsed.parseError), /position \d+/, '必须带上解析器报出的具体位置')
  const verdict = adjudicateResult({ output, expectedAcceptance: ['通道可用'] })
  assert.equal(verdict.status, 'blocked', '非法 JSON 永不计 done：结算严格性不变')
  assert.equal(verdict.verification, 'unparsable')
  assert.match(String(verdict.error), /结果块 JSON 非法/)
  assert.match(String(verdict.error), /解析器报告：.*position \d+/, '错误文案必须内联解析器报告供回喂引用')
})

/* ---------------------------------------------------------------- e2e 恢复路径 */

test('e2e A1/A2：非法块 → 自动回喂重报 → 修正后正常结算 done（不再一次即 blocked）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't7-unparsable-ok-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  writeFileSync(join(cwd, 'reports', 't7-核对报告.md'), '# T7 核对报告\n')
  const { session, runtime, prompts } = makeRuntime([malformedOutput('第一轮'), compliantOutput()], cwd)
  const signal = new AbortController().signal

  const result: any = await runtime.dispatchTool({ session, options: {} }, {}, signal)
  const row = rowOf(result)

  assert.equal(result.ok, true, '派发本身应成功返回而不是抛错')
  assert.equal(prompts.length, 2, '第一次 unparsable 必须触发第 2 次回喂激活（而不是直接受阻）')
  assert.equal(row.status, 'done', '修正后的合法回报应照常结算为 done')
  assert.equal(row.verification, 'structured')
  assert.equal(result.stats.done, 1)
  assert.equal(result.complete, true)

  // 回喂内容：同一次激活的提示词里必须带「失败类型 + 解析器具体错误 + 勿重做已完成工作」。
  const feedback = prompts[1]
  assert.match(feedback, /上一次尝试失败/)
  assert.match(feedback, /EVIDENCE_UNPARSABLE/)
  assert.match(feedback, /解析器报告/)
  assert.match(feedback, /position \d+/, '必须把解析器报出的具体位置带给子会话')
  assert.match(feedback, /t7-核对报告\.md/, '在盘产物清单必须随回喂送达，防止整步重做')
  assert.match(feedback, /请勿重做已完成的工作/)

  // 主会话留痕：重试发生即时可见（侧栏↔账本错位治理的账本侧证据）。
  const notices = session.events
    .filter((item: any) => item.type === 'user/message')
    .map((item: any) => JSON.stringify(item.data ?? ''))
  assert.ok(notices.some((text: string) => text.includes('EVIDENCE_UNPARSABLE')
    && text.includes('自动重试（第 2 次）')), '重试开始时必须向主会话即时通报，不得静默')
})

test('e2e A2：重试后仍非法才 blocked，记录附在盘产物清单与 dsh_workplan_update 复核提示', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't7-unparsable-fail-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  writeFileSync(join(cwd, 'reports', 't7-核对报告.md'), '# T7 核对报告（第一轮已写出）\n')
  const { runtime, session, prompts } = makeRuntime(
    [malformedOutput('第一轮'), malformedOutput('第二轮')],
    cwd,
  )
  const signal = new AbortController().signal

  const result: any = await runtime.dispatchTool({ session, options: {} }, {}, signal)
  const row = rowOf(result)

  assert.equal(prompts.length, 2, '有界：最多两次激活，第二次仍非法即收束，绝不无限回喂')
  assert.equal(row.status, 'blocked', '重试仍失败才按实受阻')
  assert.equal(row.verification, 'unparsable', '非法 JSON 永不计 done：证据等级如实留档')
  assert.equal(row.blockedKind, 'failed')
  assert.equal(result.stats.done, 0, '受阻行不得计入完成')
  assert.equal(result.complete, false, '不得被误判为计划完成')

  // blocked 记录三要素：解析器具体错误 + 在盘产物清单 + 复核改判出口。
  // 注：模型可读投影（statusTool/dispatch 输出）不透出 artifacts 结构化字段，
  // 主 Agent 复核依赖的正是随行 error 文案——清单必须在文本面逐字可见。
  assert.match(String(row.error), /解析器报告/)
  assert.match(String(row.error), /dsh_workplan_update/, '必须给主 Agent 指明复核改判通道')
  assert.match(String(row.error), /产物已在盘上/)
  assert.match(String(row.error), /reports\/t7-核对报告\.md/, 'attempt 摘要/声明产物中确核在盘的清单必须随 blocked 行逐字留档')
})
