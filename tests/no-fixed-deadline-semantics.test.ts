/*
 * 固定期限语义废止 —— 用户可见文案、预算预告、真实执行三层次。
 *
 * 新契约：
 *  - 负责人/专家提示词与计划消息明确“执行无时限、预估仅供参考”；
 *  - buildBudgetWarning 不再宣告分钟预算或协商上限；
 *  - 旧 childTimeoutMs 到点后任务仍在执行，不自动 blocked、不二次接手；
 *  - 历史 timeoutBlockedPatch 仅作为真实异常/用户取消后的产物抢救辅助；
 *  - watchdog 的纯函数边界与 blocked 续跑通道保持可用。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildBudgetWarning,
  buildChildPrompt,
  buildPlanMessage,
  createStatuses,
  resetBlockedStatuses,
} from '../src/plan.js'
import { dispatchPlan, timeoutBlockedPatch } from '../src/runtime.js'
import { pickTimeoutReason } from '../src/watchdog.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

const anchor = setInterval(() => {}, 1_000)
const dropAnchor = setTimeout(() => clearInterval(anchor), 60_000)
dropAnchor.unref?.()
after(() => clearInterval(anchor))

function rawPlan() {
  return {
    planId: 'wp-l4',
    title: '无固定期限验收',
    taskUnderstanding: { originalRequest: '验证无执行时限', deliverable: '不误杀' },
    contradictions: { primary: { statement: '慢工与赶点的矛盾' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '交付成果',
      rationale: '落盘优先',
      checkpoint: '成果可核对',
      subtasks: [{
        id: 'T1',
        title: '长任务交付',
        department: 'engineering',
        objective: '产出 T1_report.md',
        method: ['执行'],
        inputs: [],
        outputs: ['T1_report.md'],
        acceptance: ['报告落盘'],
        risk: '执行较久',
        dependsOn: [],
        estimateMinutes: 10,
      }],
    }],
  }
}

function completed(text = '完成') {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => { release = resolve })
  return { promise, release }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (check()) return true
    await delay(10)
  }
  return false
}

test('E1：计划与派发文案明确无时限，不出现固定完成承诺', () => {
  const plan = rawPlan()
  const stage = plan.stages[0]
  const subtask = stage.subtasks[0]
  const texts: Array<[string, string]> = [
    ['buildPlanMessage', buildPlanMessage(plan as any)],
    ['buildBudgetWarning', buildBudgetWarning(plan as any)],
    ['buildChildPrompt', buildChildPrompt({
      plan: plan as any,
      subtask,
      stage,
      dependencyResults: [],
      cwd: '/tmp',
      conversationContext: '',
    })],
  ]
  for (const [label, text] of texts) {
    assert.doesNotMatch(
      String(text),
      /硬执行上限|15 分钟\/步|强制结束|必须在[^\n。]{0,12}分钟内(?:完成|交付)/,
      `E1：${label} 不得含执行硬上限、强制结束或按分钟完成承诺`,
    )
  }
  assert.match(texts[1][1], /没有时限|无时限|不形成执行截止/, '预算预告明确无执行截止')
  assert.match(texts[1][1], /仅供参考/, '预估仅供参考')
  assert.match(texts[2][1], /无执行硬截止/, '派发提示词明确无执行硬截止')
  assert.match(texts[2][1], /不影响验收/, '预估与实际耗时不影响验收')
})

test('E2：预算预告是纯 advisory，不协商、不设分钟预算', () => {
  const text = String(buildBudgetWarning(rawPlan() as any))
  assert.match(text, /仅供参考/, '预估非承诺')
  assert.match(text, /没有时限|无时限|不形成执行截止/, '明确没有执行截止')
  assert.doesNotMatch(text, /协商上限|申请延期|必须在.{0,8}分钟|20 分钟|15 分钟/, '不残留预算/延期/分钟硬门')
})

test('历史产物抢救辅助仍可用：真实异常时保留盘上成果', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wp-rescue-'))
  writeFileSync(path.join(cwd, 'T1_report.md'), '# 交付\n')
  const { patch, landed } = timeoutBlockedPatch(
    (rawPlan() as any).stages[0].subtasks[0],
    cwd,
    '用户取消执行；已保留盘上产物',
  )
  assert.equal(patch.status, 'blocked', '取消/异常仍以 blocked 诚实结算')
  assert.match(String(patch.error), /产物已在盘上/, '抢救提示要求先核对，不当作从未运行')
  assert.ok(landed.includes('T1_report.md'), '抢救名单含落盘产物')
  assert.ok(
    Array.isArray(patch.artifacts) && patch.artifacts.some((item: any) => item?.exists === true),
    '落盘产物保留在结算产物列表',
  )
})

test('E4：旧 1 秒 childTimeout 到点后仍执行，不自动重试/接手', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wp-live-'))
  const plan = rawPlan()
  const session: any = {
    id: 'session-live',
    header: { createdAt: 1000 },
    events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) {
      this.events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => session.events[seq],
  }
  const gate = deferred()
  let activations = 0
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        activations += 1
        return { childId: `child-live-${activations}`, result: gate.promise, dispose: async () => {} }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const record: any = {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    resultWritten: false,
  }
  const controller = new AbortController()
  const running = dispatchPlan(ctx, record, {
    agent: { session, options: {} },
    signal: controller.signal,
    cwd,
    idleTimeoutMs: 60_000,
    childTimeoutMs: 1_000,
    totalTimeoutMs: 400_000,
    strictEvidence: false,
    startPhases: MAIN_START_PHASES_FIXTURE,
  } as any)
  assert.ok(await waitFor(() => activations === 1), '应启动一次负责人')
  await delay(1_300)
  const row = record.statuses.find((item: any) => item?.subtaskId === 'T1')
  assert.equal(row?.status, 'in_progress', '越过旧 1 秒窗口仍必须 in_progress')
  assert.equal(row?.deadlineAt ?? null, null, '不得产生或显示 deadlineAt')
  assert.equal(Boolean(row?.takeoverRequired), false, '不得进入二次接手')
  assert.equal(Number(row?.timeoutCount ?? 0), 0)
  assert.equal(activations, 1, '旧窗口到点不得自动重试或换人')
  gate.release(completed('完成'))
  controller.abort()
  await Promise.race([running.catch(() => undefined), delay(2_000)])
})

test('L2 纯函数：无进展/绝对窗口的独立语义仍可被显式调用', () => {
  assert.equal(
    pickTimeoutReason({ now: 10_000, startedAt: 0, lastProgressAt: 9_000, idleMs: 30_000, hardMs: 60_000, progressObservable: true }),
    null,
  )
  assert.equal(
    pickTimeoutReason({ now: 45_000, startedAt: 0, lastProgressAt: 9_000, idleMs: 30_000, hardMs: 60_000, progressObservable: true }),
    'stalled',
  )
  assert.equal(
    pickTimeoutReason({ now: 61_000, startedAt: 0, lastProgressAt: 60_000, idleMs: 30_000, hardMs: 60_000, progressObservable: true }),
    'exhausted',
  )
  assert.equal(
    pickTimeoutReason({ now: 45_000, startedAt: 0, lastProgressAt: 9_000, idleMs: 30_000, hardMs: 60_000, progressObservable: false }),
    null,
  )
})

test('续跑钉：blocked 行复位为 pending，escalated 行保持', () => {
  const out = resetBlockedStatuses([
    { subtaskId: 'T1', status: 'blocked', closure: 'blocked', blockedKind: 'timeout' },
    { subtaskId: 'T2', status: 'blocked', closure: 'escalated' },
  ])
  assert.equal(out.find((item: any) => item?.subtaskId === 'T1')?.status, 'pending')
  assert.equal(out.find((item: any) => item?.subtaskId === 'T2')?.status, 'blocked')
})
