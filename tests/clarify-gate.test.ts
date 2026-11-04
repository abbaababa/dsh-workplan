/**
 * [1.12.3] 信息不足先问，不做计划、不派发。
 *
 * 2026-11-04 MS2 的 20 条真实用例里，T05-04/09/13/20 四条本来必须澄清，插件却照样
 * 拆计划并（自动）派发，部门 Agent 于是对着猜出来的目标开工（4/4 全错）。用户当天
 * 拍板：自动派发**只在「信息不足」这一类上拦截**，其余照旧。
 *
 * 这里钉住三件事：
 *   1. 四条真实原文各自命中对应规则，并给出可以原样问用户的一句话；
 *   2. 真正的任务不被误拦（含「红圈处」这种已经有明确对象的界面改动）；
 *   3. 拦截消息里没有计划信封——没生成计划，就不该出现 planId。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { auditClarifyNeed } from '../src/understanding.js'
import { buildClarifyMessage, PLAN_MARKER_BEGIN } from '../src/plan.js'
import { matchDepartmentKeywords } from '../src/departments.js'

/** 逐字取自 _t5_model_validation_20261103/cases.json 的 text 字段。 */
const T0504 = 'W5 的跨版本 A/B 探针不进 npm test（R-W5-01，建议移入发版清单）。同意移入'
const T0509 = '36 条范围缺口（18 开放 + 12 表外）  必须完美补上\n\n\n还有  按 T4 草稿开始续做'
const T0513 = '显示内容希望可折叠，可点击展开'
const T0520 = '准确预测11月全月详细、具体走势'

const CLARIFY_CASES = [
  { name: 'T05-04 bare agreement', text: T0504, rule: 'C1' },
  { name: 'T05-09 dangling draft id', text: T0509, rule: 'C2' },
  { name: 'T05-13 no UI surface', text: T0513, rule: 'C4' },
  { name: 'T05-20 no forecast subject', text: T0520, rule: 'C3' },
]

for (const item of CLARIFY_CASES) {
  test(`clarify: ${item.name} is asked, not planned (${item.rule})`, () => {
    const verdict = auditClarifyNeed(item.text, '')
    assert.equal(verdict.needed, true, JSON.stringify(verdict))
    assert.equal(verdict.rule, item.rule)
    assert.ok(verdict.reason.length > 0)
    assert.ok(verdict.question.length > 8, 'the rule must yield a question a human can answer')
  })
}

test('clarify: real tasks are not intercepted', () => {
  const normal = [
    '这个是现有dsh-workplan插件的截图，\n把左侧栏“任务进度”里，画红圈的“每个任务进度”板块放在“进行中”板块的上面。',
    '把红圈处改为默认收起',
    '把版本号改成 1.12.0，并同步 README 与 CHANGELOG。',
    '修复 tests/plan-anchor.test.ts 里的失败用例，然后跑 npm test。',
    '把 T11 的补丁 rebase 到 HEAD，补齐回归用例，写发布记录。',
    '发布 1.12.3 到 npm，并建 GitHub Release。',
  ]
  for (const text of normal) {
    const verdict = auditClarifyNeed(text, '')
    assert.equal(verdict.needed, false, `must not ask: ${text} -> ${JSON.stringify(verdict)}`)
  }
})

test('clarify: the conversation may supply the missing surface', () => {
  const verdict = auditClarifyNeed('把它改成默认收起。', '上一轮说：把截图红圈处的分步进度改成可点击。')
  assert.equal(verdict.needed, false, JSON.stringify(verdict))
})

test('clarify: the interception message carries no plan envelope', () => {
  const verdict = auditClarifyNeed(T0513, '')
  const message = buildClarifyMessage(verdict)
  const text = message.content.map((part: any) => part.text ?? '').join('')
  assert.ok(text.includes('未生成计划'), text)
  assert.ok(text.includes(verdict.question), 'the message must hand the agent the exact question')
  assert.ok(text.includes('不要调用 dsh_workplan_dispatch'), text)
  assert.equal(text.includes(PLAN_MARKER_BEGIN), false, 'no plan was generated, so no plan marker')
})

test('recall: T05-12 reaches the legal gate; a memory leak does not', () => {
  const privacy = matchDepartmentKeywords(
    '请问，这个刚研发好的插件安全吗？会窃取用户电脑和移动终端里的文件和数据吗？',
    'legal',
  )
  assert.ok(privacy.length >= 2, JSON.stringify(privacy))
  assert.deepEqual(matchDepartmentKeywords('修复内存泄露导致的崩溃', 'legal'), [])
})
