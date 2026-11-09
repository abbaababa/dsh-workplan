/*
 * [2.2.0][T2 红灯先行] 固定期限语义废止 + L4 结算兜底 —— 对应优化项 **O-5a / O-5b / O-5c**。
 * 设计依据：docs/dsh-workplan_优化方案_20261107.md §1 ⑤ 验收矩阵 E1/E2/E4、§2.3、§5.3。
 *
 * 断言点（口径抄录方案原文，不改写）：
 *  - E1：buildPlanMessage / buildBudgetWarning / buildChildPrompt 三处不再含
 *    固定期限措辞（「硬执行上限（默认 15 分钟/步）」等）——超时是安全兜底，
 *    不是交付期限；
 *  - E2：预算预告/计划消息把预估标注为「**仅供参考/非承诺**，实际时长协商决定」；
 *  - E4/L4：到点不再直接杀任务，而是进入 **L4 结算兜底 = 抢救（落盘成果保全）
 *    → 重试 → 续跑 + 「待裁决」标记**，工作成果不因慢被否定；
 *  - L2 钉：无进展窗（stalled/exhausted）判定逻辑不受影响（回归护栏）；
 *  - 续跑钉：blocked 行可被 resetBlockedStatuses 复位为 pending（续跑通道），
 *    escalated 行除外（「等指示」不是失败）。
 *
 * 现状（v2.1.7，红灯原因）：src/host.ts:114 仍写「子任务有硬执行上限（默认 15
 * 分钟/步）」；buildBudgetWarning（src/plan.ts:1275）无「仅供参考/非承诺」标注；
 * timeoutBlockedPatch（src/runtime.ts:1106）抢救语义在，但终态无「待裁决」标记
 * （closure:'blocked' / blockedKind:'timeout'，error 尾注「已强制结束」）。
 *
 * 计时口径：L4 链集成测试注入 childTimeoutMs=1000ms 小窗口（与既有
 * workplan-auto-retry.test.ts 同构），无真实长睡眠。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

import {
  buildBudgetWarning,
  buildChildPrompt,
  buildPlanMessage,
  createStatuses,
  resetBlockedStatuses,
} from '../src/plan.js'
import { dispatchPlan, timeoutBlockedPatch } from '../src/runtime.js'
import { pickTimeoutReason } from '../src/watchdog.js'

function rawPlan() {
  return {
    planId: 'wp-l4',
    title: 'L4 兜底验收',
    taskUnderstanding: { originalRequest: '验证结算兜底', deliverable: '不误杀' },
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
        risk: '超时',
        dependsOn: [],
        estimateMinutes: 10,
      }],
    }],
  }
}

function completed(text = '完成') {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

test('E1：三处文案不再含固定期限措辞（O-5a/O-5b）', () => {
  const hostSource = readFileSync(path.resolve(process.cwd(), 'src/host.ts'), 'utf8')
  const planSource = readFileSync(path.resolve(process.cwd(), 'src/plan.ts'), 'utf8')
  assert.doesNotMatch(
    hostSource,
    /硬执行上限（默认 15 分钟\/步）/,
    '待实现（O-5a/E1）：src/host.ts 系统提示词仍把超时写成「硬执行上限（默认 15 分钟/步）」——必须改为「超时是安全兜底（防止任务无限运行），不是交付期限」',
  )
  for (const [label, source] of [['src/host.ts', hostSource], ['src/plan.ts', planSource]] as const) {
    assert.doesNotMatch(
      source,
      /15 分钟\/步|必须在[^\n。]{0,12}分钟内(完成|交付)/,
      `E1：${label} 不得再出现固定完成期限措辞（时间是协商出来的安全兜底，不是固定交付期限）`,
    )
  }
  const plan = rawPlan()
  const stage = (plan as any).stages[0]
  const subtask = stage.subtasks[0]
  const texts: Array<[string, string]> = [
    ['buildPlanMessage', buildPlanMessage(plan as any)],
    ['buildBudgetWarning', buildBudgetWarning(plan as any)],
    ['buildChildPrompt', buildChildPrompt({ plan: plan as any, subtask, stage, dependencyResults: [], cwd: '/tmp', conversationContext: '' })],
  ]
  for (const [label, text] of texts) {
    assert.doesNotMatch(
      String(text),
      /硬执行上限|15 分钟\/步|必须在[^\n。]{0,12}分钟内(完成|交付)/,
      `E1：${label} 输出不得含固定期限措辞（超时是安全兜底，不是交付期限）`,
    )
  }
})

test('E2：预算预告把预估标注为「仅供参考/非承诺」（O-5b）', () => {
  const text = String(buildBudgetWarning(rawPlan() as any))
  assert.match(
    text,
    /仅供参考|非承诺/,
    '待实现（O-5b/E2）：buildBudgetWarning 预告文需改为「预估仅供参考，非承诺；实际时长协商决定」',
  )
  assert.match(
    text,
    /协商/,
    'E2：预告文应点明实际时长由协商决定（extendMs 等协商路径）',
  )
})

test('E4/L4：硬超时结算抢救落盘成果（timeoutBlockedPatch 不丢成果）', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wp-l4-'))
  writeFileSync(path.join(cwd, 'T1_report.md'), '# 交付\n')
  const { patch, landed } = timeoutBlockedPatch(
    (rawPlan() as any).stages[0].subtasks[0],
    cwd,
    '达到执行上限（1000ms），已强制结束',
  )
  assert.equal(patch.status, 'blocked', '兜底结算走 blocked（结算，不是无限挂起）')
  assert.match(String(patch.error), /产物已在盘上/, 'L4 抢救：声明产物落盘必须进 error 提示「先核对，不要当作从未运行」')
  assert.ok(landed.includes('T1_report.md'), '抢救名单应含落盘产物')
  assert.ok(
    Array.isArray(patch.artifacts) && patch.artifacts.some((item: any) => item?.exists === true),
    'E4：工作成果不因慢被否定——落盘产物保留在结算产物列表里',
  )
})

test('E4/L4：到点进入兜底链（自动重试一次）且终态带「待裁决」标记，不是失败否定', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wp-l4-'))
  writeFileSync(path.join(cwd, 'T1_report.md'), '# 交付\n')
  const plan = rawPlan()
  const session: any = {
    id: 'session-l4',
    header: { createdAt: 1000 },
    events: [] as any[],
    get seq() {
      return this.events.length
    },
    append(type: string, data: any) {
      this.events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => session.events[seq],
  }
  let activations = 0
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        activations += 1
        return { childId: `child-hang-${activations}`, result: new Promise(() => {}), dispose: async () => {} }
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
  const res = await dispatchPlan(ctx, record, {
    agent: { session, options: {} },
    signal: new AbortController().signal,
    cwd,
    idleTimeoutMs: 60_000,
    childTimeoutMs: 1_000,
    totalTimeoutMs: 400_000,
    strictEvidence: false,
  })
  assert.equal(activations, 2, 'L4 链「重试」：硬超时不是终局，预算充足时自动再试一次（与 workplan-auto-retry 语义一致）')
  const row = (res?.statuses ?? []).find((item: any) => item?.subtaskId === 'T1')
  assert.equal(row?.status, 'blocked', '兜底链走完后以 blocked 结算（结算保证落地）')
  assert.match(String(row?.error ?? ''), /产物已在盘上/, 'L4 抢救：终态保留落盘成果提示')
  assert.ok(
    Array.isArray(row?.artifacts) && row.artifacts.some((item: any) => item?.exists === true),
    'E4：重试用尽后成果仍被保全（工作成果不因慢被否定）',
  )
  // 只匹配字段「值」，不匹配字段名（字段名 escalatedAt/escalationSeq 现状即存在，
  // 匹配字段名会把本断言染成假绿——20261107 红灯留档记录过此坑）。
  const markerText = [row?.closure, row?.blockedKind, row?.error, row?.summary, row?.hint, row?.question]
    .filter((item: any) => typeof item === 'string')
    .join('｜')
  assert.match(
    markerText,
    /裁决|待裁决|escalated/,
    '待实现（O-5c/E4）：L4 兜底终态必须带「待裁决」标记（如 closure/blockedKind 值或结算文案含「待裁决」——转新轮续跑/人工裁决通道；close 掉就等于把一个已抢救的工作成果错记成终局失败）。现状终态只有 blocked/timeout 与「已强制结束」。',
  )
})

test('L2 钉：无进展窗（stalled/exhausted）判定不受影响', () => {
  assert.equal(
    pickTimeoutReason({ now: 10_000, startedAt: 0, lastProgressAt: 9_000, idleMs: 30_000, hardMs: 60_000, progressObservable: true }),
    null,
    '窗内有进展：不判',
  )
  assert.equal(
    pickTimeoutReason({ now: 45_000, startedAt: 0, lastProgressAt: 9_000, idleMs: 30_000, hardMs: 60_000, progressObservable: true }),
    'stalled',
    'L2 无进展窗：超过 idleMs 无进展判 stalled',
  )
  assert.equal(
    pickTimeoutReason({ now: 61_000, startedAt: 0, lastProgressAt: 60_000, idleMs: 30_000, hardMs: 60_000, progressObservable: true }),
    'exhausted',
    'L2：绝对上限到点判 exhausted',
  )
  assert.equal(
    pickTimeoutReason({ now: 45_000, startedAt: 0, lastProgressAt: 9_000, idleMs: 30_000, hardMs: 60_000, progressObservable: false }),
    null,
    'L2：进展不可观测时不判 stalled（只留绝对上限）',
  )
})

test('续跑钉：blocked 行复位为 pending（escalated 行除外）', () => {
  const out = resetBlockedStatuses([
    { subtaskId: 'T1', status: 'blocked', closure: 'blocked', blockedKind: 'timeout' },
    { subtaskId: 'T2', status: 'blocked', closure: 'escalated' },
  ])
  assert.equal(out.find((item: any) => item?.subtaskId === 'T1')?.status, 'pending', '续跑通道：blocked 行复位为 pending')
  assert.equal(out.find((item: any) => item?.subtaskId === 'T2')?.status, 'blocked', '「等指示」不是失败：escalated 行不复位（待主 Agent 裁决）')
})
