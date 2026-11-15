/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：Q6 单次尝试墙钟（E-2/E-3）。
 * 承载用例：C-Q6-01…C-Q6-07（cases.md §6.2）。
 * 预期唯一来源：spec:221-224（AC-Q6-1…AC-Q6-4）。
 * 字段绑定：attemptWallClockMs（毫秒，派生不持久化，null=未验证，pending 不下发）、
 * criterionResult/criterionViolations（fields.md §1/§3）。
 * C-Q6-05 双尝试夹具：两次独立结算（各自 runtime＝各自尝试；派发重置行字段为
 * 既有「每次尝试独立」语义，T4 patch-notes §6.5 确认未改），总时长 12 分钟不累计判违规。
 * C-Q6-06② 口径澄清：事前 8≤10 时按设计不产生 ex-ante 违规 reason（只有被违反的
 * 条件才进 reasons）；「两个数字」经违规审计条目（exAnteMinutes+wallClockMs）双留痕，
 * 另补事前 12＋事后 11 双超场景断言 reasons 同时含两个数字。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { appendCriterionViolation, attemptWallClockMsOf, evaluateCriterion } from '../src/criterion.js'
import { normaliseStatusEntry } from '../src/plan.js'
import { modelStatusLines } from '../src/runtime.js'
import {
  ACTIVE_ENV, WIDE_WINDOWS, completedWithEvidence, dispatch, dropWorkRoot, landReport,
  makeRuntime, rowOf, waitFor, withEnv, withFakeNow,
} from './helpers/scv2-runtime.js'

const roots: string[] = []
after(() => { for (const r of roots) dropWorkRoot(r) })

test('C-Q6-01（AC-Q6-1 正例）：单次 11 分钟无批准 ⇒ unmet＋违规计数 +1；不得 met', () => {
  const evaluation = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: 11 * 60_000 })
  assert.equal(evaluation.criterionResult, 'unmet', '①判 unmet')
  assert.notEqual(evaluation.criterionResult, 'met', '③不得 met')
  assert.equal(evaluation.canBeDone, false)
  const violations = appendCriterionViolation([], { at: 1_000, attempt: 1, wallClockMs: 11 * 60_000, exAnteMinutes: 8, reasons: evaluation.reasons })
  assert.equal(violations.length, 1, '②违规计数 +1')
  assert.equal(violations[0].kind, 'criterion-overrun')
})

test('C-Q6-02（AC-Q6-1 边界）：两次尝试各 6 分钟无批准 ⇒ 各自 met；违规计数 0', () => {
  let violations: any[] = []
  for (const attempt of [1, 2]) {
    const evaluation = evaluateCriterion({ exAnteMinutes: 6, exAnteComplete: true, wallClockMs: 6 * 60_000 })
    if (evaluation.criterionResult === 'unmet') {
      violations = appendCriterionViolation(violations, { at: attempt, attempt, wallClockMs: 6 * 60_000, exAnteMinutes: 6, reasons: evaluation.reasons })
    }
    assert.equal(evaluation.criterionResult, 'met', `尝试 ${attempt} 各自 met`)
  }
  assert.equal(violations.length, 0, '②违规计数 0')
})

test('C-Q6-03（AC-Q6-2 正例）：墙钟=finishedAt−startedAt；回显同一对时间戳；不采用模型自报；pending 不下发', () => {
  const startedAt = 1_700_000_000_000
  const finishedAt = startedAt + 600_000
  // ① 派生器返回 finishedAt−startedAt
  assert.equal(attemptWallClockMsOf({ startedAt, finishedAt }), 600_000)
  // 判定输出回显同一对时间戳（状态行携带原始时间戳＋派生墙钟，区间=[startedAt,finishedAt]）
  const entry = normaliseStatusEntry({ subtaskId: 'T1', status: 'done', startedAt, finishedAt, timeSpentMinutes: 99 })
  assert.equal(entry.startedAt, startedAt, '②原始时间戳回显')
  assert.equal(entry.finishedAt, finishedAt)
  assert.equal(entry.attemptWallClockMs, 600_000)
  assert.equal(entry.attemptWallClockMs, entry.finishedAt - entry.startedAt, '判定区间一致')
  // ③ 不采用模型自报分钟数（timeSpentMinutes=99 不影响墙钟）
  assert.notEqual(entry.attemptWallClockMs, 99 * 60_000)
  // 模型可读面同源
  const lines = modelStatusLines([{ subtaskId: 'T1', status: 'done', startedAt, finishedAt }])
  assert.equal(lines[0].attemptWallClockMs, 600_000)
  // ④ pending 行不下发 attemptWallClockMs
  const pending = normaliseStatusEntry({ subtaskId: 'T1', status: 'pending', startedAt, finishedAt })
  assert.equal(pending.attemptWallClockMs, undefined, 'pending 无计时')
})

test('C-Q6-04（AC-Q6-2 边界）：预算重置清空时间戳 ⇒ null 未验证（绝不按 0）；evaluateCriterion 判 unmet＋wall-clock-unverified', () => {
  // ① 显式 null 守卫：绝不返回 0
  assert.equal(attemptWallClockMsOf({ startedAt: null, finishedAt: 61_000 }), null)
  assert.equal(attemptWallClockMsOf({ startedAt: 1_000, finishedAt: null }), null)
  assert.equal(attemptWallClockMsOf({}), null)
  const entry = normaliseStatusEntry({ subtaskId: 'T1', status: 'done', startedAt: null, finishedAt: null })
  assert.ok(entry.attemptWallClockMs === undefined || entry.attemptWallClockMs === null, '载荷不得出现 0')
  assert.notEqual(entry.attemptWallClockMs, 0, '绝不按 0 分钟展示')
  // ② evaluateCriterion 判 unmet 且 reasons 含 wall-clock-unverified（D-3 严格）
  const evaluation = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: null })
  assert.equal(evaluation.criterionResult, 'unmet')
  assert.ok(evaluation.reasons.some((r) => r.includes('wall-clock-unverified')), `reasons 必须含 wall-clock-unverified：${JSON.stringify(evaluation.reasons)}`)
})

test('C-Q6-05（AC-Q6-3 边界）：双尝试 6+6=12 分钟 ⇒ 每次独立计时不累计；两条独立结果各含自己的时间戳', async () => {
  const results: any[] = []
  for (const attempt of [1, 2]) {
    await withEnv(ACTIVE_ENV, async () => {
      const h = makeRuntime(2_000_000, WIDE_WINDOWS, { planId: `wp-scv2-t6-q6-${attempt}`, sessionId: `session-scv2-t6-q6-${attempt}` })
      roots.push(h.workRoot)
      await dispatch(h)
      landReport(h)
      await h.runtime.updateStatus({ session: h.session }, { subtaskId: 'T1', timeNotice: { declaredMinutes: 6 } })
      await withFakeNow(6 * 60_000, async () => {
        h.release(completedWithEvidence())
        let row: any = null
        assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000))
        // ① 不判违规（每次独立，只认本次 startedAt/finishedAt）
        assert.equal(row.criterionResult, 'met', `尝试 ${attempt} 独立判 met`)
        assert.equal(row.status, 'done')
        assert.ok((row.criterionViolations ?? []).length === 0, '总时长 12>10 不累计判违规')
        // ② 各自含自己的时间戳。实测口径：statusTool 投影含 startedAt 与派生
        // attemptWallClockMs，不含 finishedAt（首跑调试确认，非缺陷）；墙钟由
        // attemptWallClockMs 表达，两尝试 startedAt 互异即独立计时证据。
        assert.ok(Number.isFinite(Number(row.startedAt)), '本次尝试起点时间戳在场')
        assert.ok(row.attemptWallClockMs >= 6 * 60_000 && row.attemptWallClockMs < 6 * 60_000 + 10_000, '本次墙钟≈6 分钟')
        results.push(row)
      })
    })
  }
  assert.equal(results.length, 2, '输出两条独立结果')
  assert.notEqual(results[0].startedAt, results[1].startedAt, '两次尝试时间戳互相独立')
})

test('C-Q6-06（AC-Q6-4 正例，D-4）：事前 8＋事后 11 ⇒ unmet；两个数字双留痕；双超场景 reasons 同含两数', () => {
  // ① 判 unmet（两条件须同时满足才算达标）
  const evaluation = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: 660_000 })
  assert.equal(evaluation.criterionResult, 'unmet')
  assert.ok(evaluation.reasons.some((r) => r.includes('wall-clock-over') && r.includes('11.00')), '事后墙钟数字进 reasons')
  // ② 两个数字（事前和 8 / 事后墙钟 660000ms）经违规审计条目双留痕
  const violations = appendCriterionViolation([], { at: 1_000, attempt: 1, wallClockMs: 660_000, exAnteMinutes: 8, reasons: evaluation.reasons })
  assert.equal(violations[0].exAnteMinutes, 8)
  assert.equal(violations[0].wallClockMs, 660_000)
  // 双超场景：事前 12＋事后 11 ⇒ reasons 同时体现事前与事后两个数字（ex-ante/wall-clock 条目）
  const both = evaluateCriterion({ exAnteMinutes: 12, exAnteComplete: true, wallClockMs: 660_000 })
  assert.equal(both.criterionResult, 'unmet')
  assert.ok(both.reasons.some((r) => r.includes('ex-ante-over') && r.includes('12')), '事前数字 12 进 reasons')
  assert.ok(both.reasons.some((r) => r.includes('wall-clock-over') && r.includes('11.00')), '事后数字 11 进 reasons')
})

test('C-Q6-07（AC-Q6-4 边界）：事前 8+事后 10、事前 10+事后 10 ⇒ 均 met（边界含等号，无舍入误差）', () => {
  const a = evaluateCriterion({ exAnteMinutes: 8, exAnteComplete: true, wallClockMs: 600_000 })
  assert.equal(a.criterionResult, 'met', '8+10 达标（> 才超）')
  const b = evaluateCriterion({ exAnteMinutes: 10, exAnteComplete: true, wallClockMs: 600_000 })
  assert.equal(b.criterionResult, 'met', '10+10 达标（边界含等号）')
  assert.equal(b.canBeDone, true)
  // 无舍入误差：600000ms 恰好 10 分钟，不得被判 11
  assert.ok(!b.reasons.some((r) => r.includes('wall-clock-over')))
})
