/*
 * [修复] 结算容错第三族：结果块**已解析、但结算闸退回**（EVIDENCE_INCOMPLETE）。
 *
 * 缺陷现场（审计 2026-11-19）：验收未逐条覆盖 / 五步证据不完整 / 开工-结算
 * 证据不一致这三类缺口，旧实现一次即 blocked、无任何回喂——子 Agent 不知道
 * 差在哪，主 Agent 只能人工重派，「五步证据不完整」反复出现。
 * 修复后的契约（本文件逐条钉死）：
 *  B1 EVIDENCE_INCOMPLETE 与 EVIDENCE_UNPARSABLE / EVIDENCE_MISSING 同闸有界重试；
 *  B2 结算闸退回的 verdict 带结构化标志 rereport:true（回喂依据是标志，不是 error 文案）；
 *  B3 回喂同一子会话「按缺口补全、勿重做已完成工作」，补报后正常 done；
 *  B4 回喂耗尽仍不合格 → 按实 blocked，缺口永不计 done；
 *  B5 缺块判定结构化：missingBlock:true（调用方不再对 error 文案做正则匹配）。
 */
import test from 'node:test'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  buildPlanMessage,
} from '../src/plan.js'
import { createWorkplanRuntime, shouldRetryAttempt } from '../src/runtime.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `t10-evidence-incomplete-lessons-${process.pid}.jsonl`,
)

function phasesFixture() {
  return {
    planning: {
      problemAnalysis: ['现状：结算闸退回一次即 blocked 且不回喂，子 Agent 不知道差在哪；约束：缺口永不计 done、既有同族语义不回归；未知：回喂后能否补报成功；主要矛盾：补报通道与结算严格性必须在同一闸内并存；边界：只改结算链回喂，不动校验器判据。'],
      constraints: ['缺口永不计 done', '有界重试不无限循环'],
      unknowns: [],
      approach: ['第 1 步：按回喂缺口补全证据 → 产出结构化结算 → 证明：行状态 done 且 verification=structured'],
      approachBasis: ['第二步的方法、流程、步骤基于第一步完成好的全部结果：现状与主要矛盾决定先补缺口再整体回报，约束决定不改无关文件，验收标准决定每一步的留证方式。'],
      resources: ['现有代码库与只读权限：本任务所需源文件、测试与运行环境均已确认可用', '任务数据与验收标准：来自计划行，已核对'],
      tools: ['TypeScript 编译与 node 测试运行器：用于改码后自检', '文件读写与命令执行工具：用于执行与留证'],
    },
    preparation: {
      prepared: ['源文件、测试环境与验收标准均已就位：工作目录可读写，依赖已安装'],
      evidence: ['ls 与 node -v 输出正常；测试运行器可启动'],
    },
    execution: { steps: ['按缺口补全证据后整体回报'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: 'A1 通道可用', method: 'node --test', evidence: 'pass 输出' }],
      requirementCheck: '逐条核对通过',
      retrospective: {
        problems: ['现象：结果块已解析但结算闸退回一次即 blocked 且无回喂；根因：退回路径没有接 previousFailure 通道。'],
        detours: [],
        resolutions: ['为结算闸退回族接上与 unparsable/missing 同闸的有界回喂重试，缺口清单随 previousFailure 回喂同一子会话。'],
        prevention: ['遇到结算闸退回先读缺口清单再补报；结算链新增退回路径必须同步接回喂通道，避免一次即 blocked 的人工重派。'],
      },
    },
  }
}

function compliantOutput() {
  const payload = {
    status: 'done',
    blockedReason: '',
    phases: phasesFixture(),
    acceptance: [{ criterion: 'A1 通道可用', result: 'pass', evidence: 'node --test pass 输出' }],
    artifacts: [],
    needs: [],
    question: '',
    options: [],
  }
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

/** 结果块合法 JSON、但缺 preparation 组 ⇒ 结算闸退回（五步证据不完整）。 */
function incompleteOutput() {
  const phases: any = phasesFixture()
  delete phases.preparation
  const payload = {
    status: 'done',
    blockedReason: '',
    phases,
    acceptance: [{ criterion: 'A1 通道可用', result: 'pass', evidence: 'node --test pass 输出' }],
    artifacts: [],
    needs: [],
    question: '',
    options: [],
  }
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function proseOnly() {
  return '活干完了，报告如下：一切正常。（忘记附结果块）'
}

function makePlan() {
  return {
    planId: 'wp-t10-incomplete',
    title: '退回回喂验收',
    taskUnderstanding: { originalRequest: '验证退回回喂', deliverable: '不误判' },
    contradictions: { primary: { statement: '补报与严格性并存' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '交付',
      rationale: '回喂优先',
      checkpoint: '可核对',
      subtasks: [{
        id: 'T1',
        title: '实现通道',
        department: 'engineering',
        role: 'engineer',
        objective: '实现通道并通过验收',
        method: ['实现', '测试'],
        inputs: [],
        outputs: ['reports/t10-核对报告.md'],
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
    id: 'session-t10-incomplete',
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

function makeRuntime(outputs: string[], cwd: string) {
  const prompts: string[] = []
  const session = makeSession(cwd)
  session.append('user/message', buildPlanMessage(makePlan()))
  seedLeaderSelfEffort(session, makePlan())
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        const prompt = String(activation?.prompt?.[0]?.text ?? '')
        prompts.push(prompt)
        const output = outputs.shift() ?? compliantOutput()
        return {
          childId: `child-t10-${prompts.length}`,
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

test('B1：EVIDENCE_INCOMPLETE 与同族码同闸，attempt≥2 必停', () => {
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_INCOMPLETE' }, 1, 60_000, 10_000), true,
    '预算够一个空闲窗口 → 结算闸退回必须回喂补报，不是一次即 blocked')
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_INCOMPLETE' }, 1, 5_000, 10_000), false,
    '预算不足 → 按实受阻')
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_INCOMPLETE' }, 2, 60_000, 10_000), false,
    '有界：绝不无限循环')
})

test('B2/B5：结算闸退回带 rereport:true 结构化标志；缺块带 missingBlock:true（不依赖 error 文案正则）', () => {
  const incomplete = adjudicateResult({ output: incompleteOutput(), expectedAcceptance: ['通道可用'] })
  assert.equal(incomplete.status, 'blocked')
  assert.equal(incomplete.verification, 'unverified')
  assert.match(String(incomplete.error), /五步证据不完整/)
  assert.equal(incomplete.rereport, true, '回喂依据是结构化标志，不是 error 文案')

  const missing = adjudicateResult({ output: proseOnly(), expectedAcceptance: ['通道可用'] })
  assert.equal(missing.missingBlock, true, '缺块结构化标志')
  assert.notEqual(missing.rereport, true, '缺块走 EVIDENCE_MISSING 族，不进 incomplete 闸')
})

/* ------------------------------------------------------------------ e2e */

test('B3：结算闸退回 → 回喂「按缺口补全、勿重做」，补报后正常 done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-wp-t10-'))
  const { session, runtime, prompts } = makeRuntime([incompleteOutput(), compliantOutput()], cwd)
  const signal = new AbortController().signal
  const result: any = await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE,}, signal)
  const row = rowOf(result)
  assert.equal(prompts.length, 2, '结算闸退回触发一次有界回喂')
  assert.match(prompts[1], /五步证据不完整/, '回喂文案点名退回原因')
  assert.match(prompts[1], /preparation/, '回喂带校验器缺口清单')
  assert.match(prompts[1], /勿重做已完成的工作/, '回喂禁止重做（保住已落盘成果）')
  assert.equal(row?.status, 'done')
  assert.equal(row?.verification, 'structured')
})

test('B4：回喂耗尽仍不合格 → 按实 blocked，缺口永不计 done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-wp-t10-'))
  const { session, runtime, prompts } = makeRuntime([incompleteOutput(), incompleteOutput(), incompleteOutput()], cwd)
  const signal = new AbortController().signal
  const result: any = await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE,}, signal)
  const row = rowOf(result)
  assert.equal(row?.status, 'blocked', '重试耗尽按实受阻')
  assert.notEqual(row?.verification, 'structured', '缺口永不计 done/structured')
  assert.match(String(row?.error ?? ''), /五步证据不完整/)
  assert.ok(prompts.length <= 3, '有界：最多两次激活')
})
