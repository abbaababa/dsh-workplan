/*
 * [SCv2-T6][no-time-limit] 无执行时限条文回归。
 *
 * 背景：判据 v2 的「≤10 分钟完成目标」与运行层协商上限均已废止。
 * 本文件原先依赖仓库外的 reports/simple-criterion-v2-text-assertions.py
 * 检查旧条文；该检查器描述的是已取消的时限规则，不能继续作为产品契约。
 * 现在直接断言当前生产提示词与状态投影：负责人/专家无执行时限，预估只作
 * 协调信息，用户取消、真实错误、证据与质量门禁仍然有效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { PROMPT_SECTION } from '../src/host.js'
import { buildPlannerPrompt } from '../src/plan.js'
import { buildDelegateePrompt } from '../src/llm-rules.js'
import { modelStatusLines } from '../src/runtime.js'

test('C-Q1-01（新契约）：负责人/专家生产提示词明确无执行时限，保留取消与质量门禁', () => {
  const text = String(PROMPT_SECTION)
  assert.match(text, /不设总时长、单次时长、空闲无进展或回执硬截止/)
  assert.match(text, /不得仅因执行较久、暂时无新事件或未立即回执而中止/)
  assert.match(text, /estimateMinutes、timeNotice、timeSpentMinutes 只用于协调与告知/)
  assert.match(text, /extendMs 已停用（TIME_LIMITS_DISABLED）/)
  assert.match(text, /用户显式取消、真实执行错误、证据\/质量门禁仍然有效/)
  assert.doesNotMatch(text, /完成目标\s*≤\s*10\s*分钟/)
  assert.doesNotMatch(text, /二次接手|协商上限：/)
})

test('C-Q1-02（新契约）：规划器不得把分钟预估变成硬截止或验收门槛', () => {
  const prompt = buildPlannerPrompt('验证无执行时限的规划口径', '/tmp', '', { concurrency: 3, maxResumes: 2 })
  assert.match(prompt, /执行无时限/)
  assert.match(prompt, /不设置整轮或单个子任务执行截止/)
  assert.match(prompt, /estimateMinutes 只用于协调/)
  assert.match(prompt, /不能派生 timeoutMs 或延期机制/)
  assert.doesNotMatch(prompt, /完成目标\s*≤\s*10\s*分钟/)
  assert.doesNotMatch(prompt, /预估\s*[×x*]\s*2|协商上限|申请延期|二次接手/)
})

test('C-Q1-09（新契约）：专家任务书要求开工预估仅作协调，不设时长/回执截止', () => {
  const prompt = buildDelegateePrompt({
    departmentLabel: '工程',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '无时限验收',
    member: {
      member: 'Expert-A', role: 'expert', effort: 'low', task: '验证无时限执行',
      qualityRequirements: ['给出可核验产物'],
    },
    rulesBrief: '共享规则',
    cwd: '/tmp',
  })
  assert.match(prompt, /timeNotice=\{ declaredMinutes: 正整数分钟, reason\? \}/)
  assert.match(prompt, /该上报只是协调信息/)
  assert.match(prompt, /没有总时长、单次时长、空闲或回执硬截止/)
  assert.match(prompt, /预估或实际耗时不会触发延期、超时接手，也不影响 done 验收/)
  assert.doesNotMatch(prompt, /完成目标\s*≤\s*10\s*分钟/)
  assert.doesNotMatch(prompt, /未批准.*不得 done|申请延期|二次接手/)
})

test('C-Q7-01（新契约）：模型可读状态固定声明无执行时限，旧截止只作历史', () => {
  const lines = modelStatusLines([{
    subtaskId: 'T1', status: 'in_progress', startedAt: 1_000,
    deadlineAt: 9_999_999, timeNotice: { declaredMinutes: 12 },
  }])
  assert.equal(lines[0].executionTimeLimit, 'none')
  assert.equal(lines[0].deadlineAt, null)
  assert.equal(lines[0].deadlineRemainingMs, null)
  assert.equal(lines[0].legacyDeadlineAt, 9_999_999)
  assert.equal(lines[0].leaderEstimateOverCriterion, false)
})

test('C-Q7-02（新契约）：看板文案明确无时限，不再按旧截止倒计时或告警', async () => {
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../../src/client.ts', import.meta.url), 'utf8')
  assert.match(client, /noTimeLimit/)
  assert.match(client, /部门负责人和全球顶尖专家执行无时限；预估仅供参考，不影响完成验收/)
  assert.match(client, /历史延期记录（不再生效）/)
  assert.doesNotMatch(client, /deadlineRemainingMs\s*=/)
  assert.doesNotMatch(client, /超出判据|超出 10 分钟|协商上限：/)
})
