/*
 * [1.8.19] 超时不是「什么都没做」。
 *
 * 真实事故（2026-10-31）：
 *  - T11/T12 在 23:23:38 被 900 s 硬上限强制结束，而它们的交付物 23:22–23:23
 *    已经落盘（T11 32,996 B 报告 + 140 行索引；T12 51,547 B 报告）；父会话只看到
 *    `blocked / 达到执行上限`，没有任何「产物已在盘上」的线索。
 *  - T10 在 23:07:25 被 20 分钟整轮预算中止；重置为 pending 时清空 childId /
 *    startedAt，卡片显示「从未开始」，用户只能问「T10 为什么自己停止了」。
 *
 * 本文件钉住修复后的两个纯函数与提示词连续性：
 *  1) 硬超时的状态补丁必须把已落盘的声明产物写进 error 与 artifacts；
 *  2) 预算重置的 error 必须保留上一轮子会话与已落盘产物；
 *  3) 下一次尝试的提示词必须列出这些产物，要求先核对再补缺。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildChildPrompt } from '../src/plan.js'
import { budgetResetError, timeoutBlockedPatch } from '../src/runtime.js'

function makeSubtask(outputs: string[]) {
  return {
    id: 'T11',
    title: '更新交付索引并复跑扫描',
    department: 'engineering',
    role: '工具链维护工程师',
    objective: '登记新增产出',
    method: ['追加登记'],
    inputs: ['台账'],
    outputs,
    acceptance: ['scan new=0'],
    risk: '并发写',
    dependsOn: [],
  }
}

test('硬超时把已落盘的声明产物写进 error 与 artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-timeout-'))
  try {
    writeFileSync(join(dir, 'T11_索引登记与扫描复核_20261031.md'), '# report\n')
    const subtask = makeSubtask(['T11_索引登记与扫描复核_20261031.md', 'T11_missing.json'])
    const { patch, landed } = timeoutBlockedPatch(
      subtask,
      dir,
      '子任务 T11 达到执行上限（900000ms），已强制结束',
    )
    assert.equal(patch.status, 'blocked')
    assert.match(String(patch.error), /达到执行上限/)
    assert.match(String(patch.error), /该步声明的产物已在盘上/)
    assert.match(String(patch.error), /T11_索引登记与扫描复核_20261031\.md/)
    assert.match(String(patch.error), /先核对，不要当作从未运行/)
    assert.deepEqual(landed, ['T11_索引登记与扫描复核_20261031.md'])
    const artifacts = patch.artifacts ?? []
    const report = artifacts.find((item: any) => item.ref === 'T11_索引登记与扫描复核_20261031.md')
    assert.equal(report?.exists, true)
    assert.deepEqual(patch.missingArtifacts, ['T11_missing.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有任何产物落盘时，超时补丁不编造「已在盘上」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-timeout-empty-'))
  try {
    const subtask = makeSubtask(['T11_报告.md'])
    const { patch, landed } = timeoutBlockedPatch(subtask, dir, '子任务 T11 达到执行上限')
    assert.deepEqual(landed, [])
    assert.doesNotMatch(String(patch.error), /已在盘上/)
    assert.deepEqual(patch.missingArtifacts, ['T11_报告.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('预算重置保留上一轮子会话、运行时长与已落盘产物', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-budget-'))
  try {
    writeFileSync(join(dir, 'T10_coverage_report_20261031.json'), '{}')
    const subtask = makeSubtask(['T10_coverage_report_20261031.json'])
    const item = {
      subtaskId: 'T10',
      status: 'in_progress',
      childId: 'a0d5b134-3d41-4f60-ba93-26c4b652dd7b',
      startedAt: 1000,
      finishedAt: 61000,
    }
    const message = budgetResetError(item, subtask, dir)
    assert.match(message, /本轮预算用尽，等待续跑/)
    assert.match(message, /上一轮子会话 a0d5b134/)
    assert.match(message, /运行 60s/)
    assert.match(message, /声明产物已在盘上/)
    assert.match(message, /T10_coverage_report_20261031\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重试提示词列出上一轮已落盘产物并要求先核对', () => {
  const subtask = makeSubtask(['out/report.md'])
  const plan = {
    planId: 'wp-test',
    title: 't',
    taskUnderstanding: { originalRequest: '需求', deliverable: '交付物' },
    contradictions: { primary: { statement: '矛盾' } },
    stages: [{ id: 'S1', name: '阶段一', goal: '目标', subtasks: [subtask] }],
  }
  const base = {
    plan,
    subtask,
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
  }
  const withArtifacts = buildChildPrompt({
    ...base,
    statuses: [
      {
        subtaskId: 'T11',
        status: 'pending',
        artifacts: [
          { kind: 'file', ref: 'out/report.md', exists: true },
          { kind: 'file', ref: 'out/other.md', exists: false },
        ],
      },
    ],
  })
  assert.match(withArtifacts, /上一次这一子任务被中止/)
  assert.match(withArtifacts, /- out\/report\.md/)
  assert.doesNotMatch(withArtifacts, /- out\/other\.md/)
  assert.match(withArtifacts, /不要重写/)

  const withoutArtifacts = buildChildPrompt({
    ...base,
    statuses: [{ subtaskId: 'T11', status: 'pending' }],
  })
  assert.doesNotMatch(withoutArtifacts, /上一次这一子任务被中止/)
})
