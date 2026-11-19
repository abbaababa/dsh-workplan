/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归共享 runtime 夹具。
 *
 * 来源与口径：
 *  - 手法同构 tests/simple-criterion-v2-t4-mechanism.test.ts（T4 自证夹具，
 *    makeRuntime/withEnv/ACTIVE_ENV/seedLeaderSelfEffort 模式），不改动该文件；
 *  - 预期唯一来源 reports/simple-criterion-v2-spec.md（28 条 AC）＋
 *    reports/simple-criterion-v2-cases.md（T5 冻结用例集 v1.1）；
 *  - GAP-4 消解口径：CRITERION_TARGET_MINUTES=10 为常量不可注入，集成用例用
 *    ①env 生效开关（ACTIVE_ENV）②伪造结算时钟（withFakeNow：Date.now 偏移，
 *    等价于 finishedAt−startedAt>10 分钟的 journal 时间戳伪造）③运行层短窗口
 *    childTimeoutMs=1000。伪造时钟窗口内所有看门狗窗口放大到 1 小时，防止
 *    假时钟触发运行层兜底抢跑判据闸（竞态防护，见 T6 报告 §夹具说明）。
 *  - waitFor 用 performance.now（单调钟）计时，不受 Date.now 伪造影响。
 *  - strictEvidence:true（产品默认）：adjudicateResult 在 strict:false 时走
 *    legacy 短路（src/plan.ts:3492-3503），不解析结果块、artifacts 恒为空——
 *    产物断言用例（C-Q1-05/C-Q3-02）必须用严格模式，否则夹具自证失效。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlanMessage } from '../../src/plan.js'
import { createWorkplanRuntime } from '../../src/runtime.js'
import { MAIN_START_PHASES_FIXTURE } from './main-deep-think.js'
import { seedLeaderSelfEffort } from './self-effort-contract.js'

export const ACTIVE_ENV = { DSH_WORKPLAN_CRITERION_V2: '1', DSH_WORKPLAN_CRITERION_V2_SINCE: '1000000' }

export function makeWorkRoot(prefix = 'wp-scv2-t6-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
export function dropWorkRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

export function approval(over: Record<string, any> = {}) {
  return { approvedBy: 'user', at: 1_500, reason: '用户批准原文：同意本任务放宽', scope: 'task', ...over }
}

export function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  return fn().finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
}

/** 伪造结算时钟：Date.now 偏移 offsetMs（GAP-4 ②）；finally 恢复，绝不泄漏。 */
export async function withFakeNow<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now
  Date.now = () => real() + offsetMs
  try { return await fn() } finally { Date.now = real }
}

export function makePlanMessage(createdAt: number, planId = 'wp-scv2-t6', sessionId = 'session-scv2-t6') {
  return buildPlanMessage({
    planId, sessionId, createdTurn: 1, createdAt,
    title: '判据 v2 T6 回归验收',
    taskUnderstanding: { originalRequest: '验证判据层机制', deliverable: '回归证据' },
    contradictions: { primary: { statement: '判据层与运行层分层' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', subtasks: [{ id: 'T1', title: '任务', department: 'engineering', objective: '验证', method: ['执行'], inputs: [], outputs: ['T1_report.md'], acceptance: ['产出'], risk: '无', dependsOn: [] }] }],
  })
}

export interface RuntimeHarness {
  session: any
  runtime: any
  release: (value: any) => void
  hasStarted: () => boolean
  workRoot: string
}

/**
 * 与 t4-mechanism 同构的假子会话 runtime。options 透传 createWorkplanRuntime；
 * 伪造时钟用例必须传大窗口（childTimeoutMs/totalTimeoutMs/idleTimeoutMs=3_600_000）。
 */
export function makeRuntime(createdAt: number, options: any = {}, ids?: { planId?: string; sessionId?: string }): RuntimeHarness {
  const planId = ids?.planId ?? 'wp-scv2-t6'
  const sessionId = ids?.sessionId ?? 'session-scv2-t6'
  const workRoot = makeWorkRoot()
  const session: any = {
    id: sessionId, header: { createdAt, cwd: workRoot }, events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) { this.events.push({ type, data }); return data },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', makePlanMessage(createdAt, planId, sessionId))
  seedLeaderSelfEffort(session, { planId, stages: [{ subtasks: [{ id: 'T1' }] }] })
  let release!: (value: any) => void
  const gatePromise = new Promise<any>((resolve) => { release = resolve })
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => { started = true; return { childId: 'child-scv2-t6', result: gatePromise, dispose: async () => {} } },
      sendMessage: async () => 'msg-1',
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx as any, { totalTimeoutMs: 100_000, idleTimeoutMs: 60_000, strictEvidence: true, ...options })
  return { session, runtime, release, hasStarted: () => started, workRoot }
}

/** 单调钟轮询（不受 withFakeNow 影响）。 */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

export async function rowOf(runtime: any, session: any, subtaskId = 'T1'): Promise<any> {
  const snapshot: any = await runtime.statusTool({ session }, {})
  return (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === subtaskId)
}

export async function dispatch(h: RuntimeHarness): Promise<void> {
  await h.runtime.dispatchTool({ session: h.session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE, mode: 'async' }, new AbortController().signal)
  if (!await waitFor(h.hasStarted, 5_000)) throw new Error('T1 应已派发')
}

export const completed = (text = '任务完成') => ({ stopReason: 'completed', output: [{ type: 'text', text }] })

/** 带完整 WORKPLAN_EVIDENCE 结果块的完成输出（声明产物 T1_report.md）。
 *  phases 各字段满足产品三阶段门禁的最薄字数（problemAnalysis/approach≥40、
 *  approachBasis≥20、retrospective.problems/resolutions≥20、prevention≥16），
 *  否则 strict:true 裁决会因「三阶段证据不完整」判 blocked（首跑 run2 根因）。 */
export function completedWithEvidence(artifactRef = 'T1_report.md') {
  const block = {
    status: 'done',
    blockedReason: '',
    phases: {
      planning: {
        problemAnalysis: [
          '目标与验收：产出 T1_report.md 并通过判据闸验收；现状：夹具 runtime 已派发 T1；约束：只写工作目录内产物；主要矛盾：结算墙钟受伪造时钟控制，须保证判据闸读到本次尝试时间戳。',
        ],
        approach: [
          '第 1 步：在工作目录落盘 T1_report.md 并核对文件存在；第 2 步：回报含三阶段证据与产物清单的结果块；第 3 步：由 statusTool 投影核对结算行状态与判据结果。',
        ],
        approachBasis: [
          '第一轮确认产物必须先于结算落盘，故第二轮把落盘排在回报之前；判据闸只认本次尝试墙钟，故核对步骤绑定 statusTool 投影。',
        ],
        resources: ['工作目录写权限与 T1_report.md 落盘位置已确认可用'],
        tools: ['文件读写工具用于落盘与核对，statusTool 用于核对结算行'],
      },
      preparation: {
        prepared: ['工作目录可写、T1_report.md 落盘路径与 statusTool 均已就位'],
        evidence: ['ls 工作目录正常；statusTool 可读取 T1 状态行'],
      },
      execution: { steps: ['落盘 T1_report.md', '回报结果块'], deviations: [] },
      verification: {
        allPassed: true,
        checks: [{ criterion: '产出', method: '文件存在性', evidence: 'T1_report.md 已落盘' }],
        requirementCheck: '产出已落盘且结果块含产物清单',
        retrospective: {
          problems: ['首次回报时三阶段证据字数不足被门禁拦截，根因是夹具模板过薄，未满足产品最薄字数要求。'],
          detours: [],
          resolutions: ['把夹具结果块的三阶段字段补齐到门禁字数以上，复跑裁决通过，产物清单正常解析。'],
          prevention: ['遇到结果块被裁决拦截，先读 error 中的门禁拒因逐条补齐，再复跑，不放宽断言。'],
        },
      },
    },
    acceptance: [{ criterion: '产出', result: 'pass', evidence: 'T1_report.md 已落盘' }],
    artifacts: [{ kind: 'file', ref: artifactRef }],
    needs: [],
    question: '',
    options: [],
  }
  const text = `任务完成，产物已落盘。\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(block)}\n<!-- WORKPLAN_EVIDENCE:END -->`
  return completed(text)
}

/** 在 harness 的 cwd 内落盘声明产物（集成用例的 artifacts 断言前提）。 */
export function landReport(h: RuntimeHarness, ref = 'T1_report.md'): void {
  writeFileSync(join(h.workRoot, ref), '# T1 交付\n\n判据 v2 回归夹具产物。\n')
}

/** 大窗口选项：伪造时钟用例专用（防运行层看门狗抢跑）。 */
export const WIDE_WINDOWS = { childTimeoutMs: 3_600_000, totalTimeoutMs: 3_600_000, idleTimeoutMs: 3_600_000 }
