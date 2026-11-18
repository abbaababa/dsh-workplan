/**
 * [3.0.2] 认可闸门语境排除（否定句 / 引文转述）的回归钉。
 *
 * 事故输入两类：
 *  1. 否定句——「不用经用户认可再执行，直接干」字面命中「经…认可再…」，
 *     但用户是在**取消**门槛，绝不能按住；
 *  2. 引文——用户粘贴规章制度原文（含「须经用户批准后再执行」）供参考，
 *     不是在给自己的任务设门槛。
 *
 * 同时钉住「语境排除不误伤真请求」：真门槛语照常命中，
 * 同一条文本里「先转述、后立门槛」时后一处仍触发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { detectApprovalGate } from '../src/approval-gate.js'

/* ---------------- 否定句：取消门槛，不得按住 ---------------- */

const NEGATED_CASES = [
  { name: '不用…再执行', text: '这个任务不用经用户认可再执行，直接干。' },
  { name: '无需…后再动手', text: '无需得到您认可后再开始动手，直接按计划改。' },
  { name: '不必等认可', text: '本任务不必等用户批准后再执行，先做。' },
  { name: '不需要先问', text: '这里不需要有疑问先问用户，你直接做就行。' },
  { name: '谈不上认可问题', text: '小改动谈不上须经用户认可后才执行，直接发布。' },
  { name: '单字勿紧贴', text: '此任务勿须经用户认可再执行，立即开工。' },
]

for (const item of NEGATED_CASES) {
  test(`context: 否定句「${item.name}」不触发认可闸门`, () => {
    const verdict = detectApprovalGate(item.text)
    assert.equal(verdict.held, false, JSON.stringify(verdict))
  })
}

/* ---------------- 引文/转述：规章制度原文，不得按住 ---------------- */

const QUOTED_CASES = [
  { name: '中文方引号', text: '公司制度写明「须经用户批准后再执行」，本次照办即可。' },
  { name: '转述字样+后文命中', text: '这是规定原文：须先经用户认可再开始执行，供你参考。' },
  { name: '条款转述', text: '条款里有「有疑问先问用户，经用户认可后再开始执行」一句。' },
  { name: '直引号包裹', text: '制度写明"须经用户批准后再执行"，照办即可。' },
]

for (const item of QUOTED_CASES) {
  test(`context: 引文「${item.name}」不触发认可闸门`, () => {
    const verdict = detectApprovalGate(item.text)
    assert.equal(verdict.held, false, JSON.stringify(verdict))
  })
}

/* ---------------- 真请求保持不变 ---------------- */

test('context: 真门槛语照常命中（回归）', () => {
  const cases = [
    '请你为以上内容制定计划，经用户认可后再开始执行。',
    '未经用户认可不得开始执行，先出计划。',
    '有任何疑问必须先询问用户，得到您明确回复后才能开始正式执行！',
  ]
  for (const text of cases) {
    const verdict = detectApprovalGate(text)
    assert.equal(verdict.held, true, text)
  }
})

test('context: 同条规则多处命中时，干净的后一处仍触发', () => {
  // 第一处「经…认可再执行」整句在引号里（转述），第二处才是给本任务立的真门槛。
  const text = '他说「经用户认可再执行」，后面这句才是门槛：经您认可后才开始。'
  const verdict = detectApprovalGate(text)
  assert.equal(verdict.held, true, JSON.stringify(verdict))
})

test('context: 引用在别处、真门槛语在引号外仍触发', () => {
  const text = '他说「直接干就行」，但本任务须经用户认可后再执行。'
  const verdict = detectApprovalGate(text)
  assert.equal(verdict.held, true, JSON.stringify(verdict))
})

test('context: 普通任务仍不命中（零回归）', () => {
  assert.equal(detectApprovalGate('帮我修复登录页样式 bug。').held, false)
  assert.equal(detectApprovalGate('Fix the build and run all tests.').held, false)
})
