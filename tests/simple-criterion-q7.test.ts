/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：Q7 运行层零改动（E-2）。
 * 承载用例：C-Q7-03（cases.md §6.2）＋ C-Q1-07、C-Q1-08（与 C-Q7-03 同一断言双证，
 * cases.md §3 C-Q7-03 行明列；§6.2 未给 C-Q1-07/08 落点，按双证语义归入本文件，
 * 已在 T6 报告口径澄清节说明）。
 * 预期唯一来源：spec:75（AC-Q1-4）、spec:252（AC-Q7-2）——常量 900000/7200000、
 * derive 公式 min(7200000, max(1000, est×2.0×60000))、est≤0→undefined 逐字不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CRITERION_TARGET_MINUTES } from '../src/criterion.js'
import { deriveSubtaskTimeoutMs } from '../src/plan.js'
import { CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS, MIN_CHILD_TIMEOUT_MS } from '../src/runtime.js'

test('C-Q1-07（AC-Q1-4 正例）：CHILD_TIMEOUT_MS=900000、MAX_CHILD_TIMEOUT_MS=7200000、derive 公式不变', () => {
  assert.equal(CHILD_TIMEOUT_MS, 900_000)
  assert.equal(MAX_CHILD_TIMEOUT_MS, 7_200_000)
  assert.equal(MIN_CHILD_TIMEOUT_MS, 1_000)
  assert.equal(CRITERION_TARGET_MINUTES, 10, '判据层目标常量=10（与运行层常量分层并存）')
  // 公式逐字：min(max, max(min, est×2.0×60000))——中间值原样、两端钳制
  assert.equal(deriveSubtaskTimeoutMs(10), 1_200_000)
  assert.equal(deriveSubtaskTimeoutMs(5), 600_000)
})

test('C-Q1-08（AC-Q1-4 边界）：est=1→120000；est=90/240→钳到 7200000；est=0/负数→undefined', () => {
  assert.equal(deriveSubtaskTimeoutMs(1), 120_000)
  assert.equal(deriveSubtaskTimeoutMs(90), 7_200_000, '90×2.0×60000=10800000 → 钳到 MAX')
  assert.equal(deriveSubtaskTimeoutMs(240), 7_200_000, '240×2.0×60000=28800000 → 钳到 MAX')
  assert.equal(deriveSubtaskTimeoutMs(0), undefined)
  assert.equal(deriveSubtaskTimeoutMs(-5), undefined)
  assert.equal(deriveSubtaskTimeoutMs(undefined), undefined)
})

test('C-Q7-03（AC-Q7-2 正例）：常量与公式双证不变；不得以缩短运行层时限落实判据层（120 分钟未改小）', () => {
  assert.equal(CHILD_TIMEOUT_MS, 900_000, '默认单次兜底 15 分钟未改')
  assert.equal(MAX_CHILD_TIMEOUT_MS, 7_200_000, '120 分钟绝对上限未改小（2026-11-07 旧决断保留为运行层兜底）')
  assert.equal(deriveSubtaskTimeoutMs(1), 120_000)
  assert.equal(deriveSubtaskTimeoutMs(90), 7_200_000)
  assert.equal(deriveSubtaskTimeoutMs(240), 7_200_000)
  assert.equal(deriveSubtaskTimeoutMs(0), undefined)
})
