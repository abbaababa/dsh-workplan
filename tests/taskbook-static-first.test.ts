/* [3.2.4][省钱 3.0] 静态优先重排：同部门多名专家必须共享长前缀（缓存可命中），
 * 且五步协议仍先于执行要求（three-phase.test.ts:135 的守门契约）。 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDelegateePrompt,
  buildLlmRulesBrief,
  buildPhaseZeroDelegateePrompt,
} from '../src/llm-rules.js'

const anchor = setInterval(() => {}, 1_000)
const release = setTimeout(() => clearInterval(anchor), 60_000)
release.unref?.()
after(() => clearInterval(anchor))

const brief = buildLlmRulesBrief({ model: 'deepseek-v4.1-flash-1017', effort: 'high', tier: 'delegate' })

function expert(member: string, task: string) {
  return buildDelegateePrompt({
    departmentLabel: 'qa',
    leaderSubtaskId: 'T4',
    leaderSubtaskTitle: '推理档位验证',
    member: { member, role: 'expert', task, qualityRequirements: ['结论可复核'], effort: 'high' },
    rulesBrief: brief,
    cwd: '/Users/open/Documents/Stocks',
    continuation: true,
  })
}

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

test('同部门 8 名专家共享 ≥3000 字符前缀（缓存可命中），且差异只在尾部', () => {
  const prompts = Array.from({ length: 8 }, (_v, i) =>
    expert(`专家-${i + 1}`, `完成第 ${i + 1} 项独立子任务并产出验收证据`))
  let minShared = Number.POSITIVE_INFINITY
  for (let i = 1; i < prompts.length; i += 1) minShared = Math.min(minShared, commonPrefix(prompts[0], prompts[i]))
  assert.ok(
    minShared >= 3000,
    `8 份任务书的最小共享前缀必须 ≥3000 字符（实测 ${minShared}）；成员名不得出现在前缀里`,
  )
  // 差异必须落在尾部：动态分工段必须整体位于共享前缀之后
  const dynamicAt = prompts[0].indexOf('【你的分工】（本任务书中唯一因专家而异的部分）')
  // 分工段的标题本身也是共享文本，真正的分叉点落在段内第一行（成员名）；
  // 因此要求「分叉点不超过分工段起点 200 字符」——即差异必须集中在动态段内。
  assert.ok(
    minShared - dynamicAt <= 200,
    `差异必须落在动态分工段内（前缀 ${minShared}，分工段 ${dynamicAt}）`,
  )
  assert.ok(prompts[0].indexOf('完成第 1 项独立子任务') >= dynamicAt, '任务文本必须在动态分工段内')
})

test('静态优先不得打乱语义顺序：五步协议先于执行要求，动态分工在后', () => {
  const prompt = expert('专家-1', '做一件事')
  assert.ok(prompt.indexOf('五步工作法') >= 0, '五步协议必须在任务书里')
  const execAt = prompt.indexOf('执行要求（用户强制要求 5 原文口径）')
  assert.ok(execAt > 0, '执行要求段必须在任务书里')
  assert.ok(
    prompt.indexOf('五步工作法') < execAt,
    '五步工作法必须先于执行要求出现（three-phase.test.ts:135 守门契约的同口径）',
  )
  assert.ok(execAt < prompt.indexOf('【你的分工】（本任务书中唯一因专家而异的部分）'), '执行要求必须在动态分工之前')
})

test('phase-0 任务书同样静态优先：8 名专家共享 >80% 前缀', () => {
  const prompts = Array.from({ length: 8 }, (_v, i) =>
    buildPhaseZeroDelegateePrompt({
      departmentLabel: 'qa',
      member: { member: `专家-${i + 1}`, role: 'expert', task: `第 ${i + 1} 项任务`, qualityRequirements: ['可复核'], effort: 'low' },
      cwd: '/Users/open/Documents/Stocks',
    }))
  let minShared = Number.POSITIVE_INFINITY
  for (let i = 1; i < prompts.length; i += 1) minShared = Math.min(minShared, commonPrefix(prompts[0], prompts[i]))
  assert.ok(minShared / prompts[0].length > 0.8, `phase-0 共享前缀占比应 >80%（实测 ${(minShared / prompts[0].length * 100).toFixed(1)}%）`)
})

test('静态优先不删内容：关键义务与门禁串仍在', () => {
  const prompt = expert('专家-1', '做一件事')
  for (const key of [
    '推理等级以 self_effort 自配为权威',
    '开工前必须先预估本人任务耗时',
    '你是第三层叶子执行者',
    '共享可变状态纪律',
    '遇阻上报通道',
    '结果块契约',
    '产物根目录（唯一，强制）',
    '步数预算（只记账，不是时限）',
  ]) {
    assert.ok(prompt.includes(key), `任务书不得因重排丢失：${key}`)
  }
})
