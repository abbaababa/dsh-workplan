/*
 * [2.2.9] 结算容错第二族：结果块**缺失**（子会话收尾异常：error/截断/超时）。
 *
 * 缺陷现场（用户 2026-11-10 截图红字复发族）：结算唯一载体是收尾消息块，
 * 单点、原子、无盘上备份；丢块后旧实现一次即 blocked 并级联冻结下游
 * （看板「已结束·需处理 / 2 卡住了 0/2」反复出现）。
 * 修复后的契约（本文件逐条钉死）：
 *  A1 EVIDENCE_MISSING 与 CHILD_NOT_COMPLETED / EVIDENCE_UNPARSABLE 同闸有界重试；
 *  A2 盘上备份（reports/wp-settlement-<id>.json）存在且合法 → 单次激活即采纳结算，不回喂；
 *  A3 无备份 → 回喂同一子会话「只补交结果块、勿重做已完成工作」，补交后正常 done；
 *  A4 回喂耗尽仍缺失 → 按实 blocked（verification=unverified），缺失永不计 done；
 *  A5 既有 unparsable / CHILD_NOT_COMPLETED 语义不回归（同闸单测逐字断言）。
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
} from '../src/plan.js'
import { createWorkplanRuntime, shouldRetryAttempt } from '../src/runtime.js'

process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `t9-evidence-missing-lessons-${process.pid}.jsonl`,
)

function phasesFixture() {
  return {
    planning: {
      problemAnalysis: ['现状：结算块缺失一次即 blocked 并级联冻结下游，看板红字反复出现；约束：缺失永不计 done、既有同族语义不回归；未知：盘上备份能否被采纳；主要矛盾：恢复路径与结算严格性必须在同一闸内并存；边界：只改结算链与提示词约定。'],
      constraints: ['缺失永不计 done', '有界重试不无限循环'],
      unknowns: [],
      approach: ['第 1 步：补交完整结果块 → 产出结构化结算 → 证明：行状态 done 且 verification=structured'],
    },
    execution: { steps: ['补交结果块'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: 'A1 通道可用', method: 'node --test', evidence: 'pass 输出' }],
      requirementCheck: '逐条核对通过',
      retrospective: {
        problems: ['现象：子会话收尾异常（error/截断/超时）导致结果块丢失，旧实现一次即 blocked 并级联冻结下游；根因：结算唯一载体是收尾消息块，单点无备份。'],
        detours: [],
        resolutions: ['为缺失族补上与 unparsable 同闸的有界回喂重试，并新增盘上结算备份采纳路径，恢复能力与结算严格性在同一闸内并存。'],
        prevention: ['遇到收尾异常先写盘上备份再发消息块；结算链任何新增唯一载体都必须配套盘上备份或有界重试恢复路径，避免单点丢失。'],
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

function proseOnly() {
  return '活干完了，报告如下：一切正常。（忘记附结果块）'
}

function makePlan() {
  return {
    planId: 'wp-t9-missing',
    title: '缺失结算验收',
    taskUnderstanding: { originalRequest: '验证缺失恢复', deliverable: '不误判' },
    contradictions: { primary: { statement: '恢复与严格性并存' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '交付',
      rationale: '落盘优先',
      checkpoint: '可核对',
      subtasks: [{
        id: 'T1',
        title: '实现通道',
        department: 'engineering',
        role: 'engineer',
        objective: '实现通道并通过验收',
        method: ['实现', '测试'],
        inputs: [],
        outputs: ['reports/t9-核对报告.md'],
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
    id: 'session-t9-missing',
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
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        const prompt = String(activation?.request?.prompt?.[0]?.text ?? '')
        prompts.push(prompt)
        const output = outputs.shift() ?? compliantOutput()
        return {
          childId: `child-t9-${prompts.length}`,
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

test('A1/A5：EVIDENCE_MISSING 与同族码同闸，attempt≥2 必停；既有码不回归', () => {
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_MISSING' }, 1, 60_000, 10_000), true,
    '预算够一个空闲窗口 → 缺失必须回喂补报，不是一次即 blocked')
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_MISSING' }, 1, 5_000, 10_000), false,
    '预算不足 → 按实受阻')
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_MISSING' }, 2, 60_000, 10_000), false,
    '有界：绝不无限循环')
  // A5 不回归：同族与既有码逐字保持。
  assert.equal(shouldRetryAttempt({ code: 'EVIDENCE_UNPARSABLE' }, 1, 60_000, 10_000), true)
  assert.equal(shouldRetryAttempt({ code: 'CHILD_NOT_COMPLETED' }, 1, 60_000, 10_000), true)
  assert.equal(shouldRetryAttempt({ code: 'CHILD_NOT_COMPLETED' }, 2, 60_000, 10_000), false)
})

test('A2 前置：无标记散文被判「结果块缺失」且 verification=unverified（缺失永不计 done）', () => {
  const verdict = adjudicateResult({ output: proseOnly(), expectedAcceptance: ['通道可用'] })
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.verification, 'unverified')
  assert.match(String(verdict.error), /结果块缺失/)
})

/* ------------------------------------------------------------------ e2e */

test('A2：盘上备份合法 → 单次激活即采纳结算，不回喂不重做', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-wp-t9-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  writeFileSync(join(cwd, 'reports', 'wp-settlement-T1.json'), JSON.stringify({
    status: 'done',
    blockedReason: '',
    phases: phasesFixture(),
    acceptance: [{ criterion: 'A1 通道可用', result: 'pass', evidence: '盘上备份' }],
    artifacts: [],
    needs: [],
  }))
  const { session, runtime, prompts } = makeRuntime([proseOnly()], cwd)
  const signal = new AbortController().signal
  const result: any = await runtime.dispatchTool({ session, options: {} }, {}, signal)
  const row = rowOf(result)
  assert.equal(prompts.length, 1, '备份可采纳时不得回喂第二次')
  assert.equal(row?.status, 'done', '备份结算：已完成的工作不被误判缺失')
})

test('A3：无备份 → 回喂「只补交结果块、勿重做」，补交后正常 done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-wp-t9-'))
  const { session, runtime, prompts } = makeRuntime([proseOnly(), compliantOutput()], cwd)
  const signal = new AbortController().signal
  const result: any = await runtime.dispatchTool({ session, options: {} }, {}, signal)
  const row = rowOf(result)
  assert.equal(prompts.length, 2, '缺失触发一次有界回喂')
  assert.match(prompts[1], /结果块缺失/, '回喂文案点名缺失')
  assert.match(prompts[1], /勿重做已完成的工作/, '回喂禁止重做（保住已落盘成果）')
  assert.equal(row?.status, 'done')
  assert.equal(row?.verification, 'structured')
})

test('A4：回喂耗尽仍缺失 → 按实 blocked，缺失永不计 done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-wp-t9-'))
  const { session, runtime, prompts } = makeRuntime([proseOnly(), proseOnly(), proseOnly()], cwd)
  const signal = new AbortController().signal
  const result: any = await runtime.dispatchTool({ session, options: {} }, {}, signal)
  const row = rowOf(result)
  assert.equal(row?.status, 'blocked', '重试耗尽按实受阻')
  assert.notEqual(row?.verification, 'structured', '缺失永不计 done/structured')
  assert.match(String(row?.error ?? ''), /结果块缺失/)
  assert.ok(prompts.length <= 3, '有界：最多两次激活')
})
