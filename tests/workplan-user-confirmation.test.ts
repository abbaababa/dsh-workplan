/*
 * [3.0.7] 确认回复识别 · isUserConfirmation 单元契约。
 *
 * 背景事故（2026-11-18 本会话）：用户对计划回复「按你的建议执行」，旧的
 * 社交/空泛追问/进度提问三类分类器都不认确认回复，它就被当成全新任务——
 * 先把原任务在途的后台分解取代中止，再对这句确认本身启动新一轮分解；
 * 下一条消息又取代这一轮，任务永远开不了跑（无限取代循环）。
 *
 * 用户想法（原话）：「收到用户确认回复后，你应该结合所有上下文全面、深入
 * 分析、思考、研究后，开始依据得出的所有结果分配任务」。
 *
 * 本文件锁定判定函数本身的正例/反例/边界：
 *   - 正例：常见中文/英文确认短句，必须全部识别为确认；
 *   - 反例：含实质内容、含否定、过长、非字符串，必须全部排除——
 *     任何漏放进来的反例都会在 pre-step 上吞掉用户的新任务。
 * 预期唯一来源：src/plan.ts isUserConfirmation 头注释（保守、可证三条件）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { isUserConfirmation } from '../src/plan.js'

test('3.0.7：事故原句「按你的建议执行」必须识别为确认', () => {
  assert.equal(isUserConfirmation('按你的建议执行'), true)
})

test('3.0.7：中文确认正例全集', () => {
  const positives = [
    '好',
    '行',
    '嗯',
    '是',
    '对',
    '好，那就这样',
    '就这么办',
    '就这么定了',
    '可以',
    '可以的',
    '没问题',
    '没问题吧',
    '没错',
    '同意',
    '我同意',
    '同意，执行吧',
    '认可',
    '批准',
    '确认',
    '确认，请开始',
    '确定',
    '照办',
    '照做',
    '按您说的办',
    '按此执行',
    '就按这个来',
    '采用这个方案',
    '执行',
    '开始吧',
    '动手',
    '去做吧',
    '去办',
    '干',
    '干吧',
    '办',
    'OK',
    'ok',
    '好的',
    '好的，开始吧',
  ]
  for (const text of positives) {
    assert.equal(isUserConfirmation(text), true, `应识别为确认：${text}`)
  }
})

test('3.0.7：英文确认正例全集', () => {
  const positives = [
    'ok',
    'OK',
    'okay',
    'yes',
    'yeah',
    'yep',
    'sure',
    'approve',
    'approved',
    'confirm',
    'confirmed',
    'agree',
    'agreed',
    'execute',
    'proceed',
    'lgtm',
    'go',
    'do it',
    'sounds good',
    'please proceed',
  ]
  for (const text of positives) {
    assert.equal(isUserConfirmation(text), true, `应识别为确认：${text}`)
  }
})

test('3.0.7：含实质内容/任务内容的反例必须排除（防止吞掉新任务）', () => {
  const negatives = [
    // 带条件的确认：实质内容不得被吞
    '可以，但范围改成X',
    '同意，先只做第一部分',
    '确认，不过预算减半',
    // 带询问：不是确认
    '确认一下进度',
    '可以帮我看看吗',
    '确认明天几点开始？',
    // 普通新任务/问题
    '请分析明天的走势',
    '接下来怎么办',
    '继续修复登录问题',
    '还没想好',
    '还没完成吗',
    // 否定与暂缓
    '不同意',
    '不认可这个方案',
    '不批准',
    '不确认',
    '不可以',
    '不行',
    '不能这样',
    '不要开始',
    '不用了',
    '先别开始',
    '别急',
    '暂不执行',
    '先不弄',
    '拒绝',
    '不好',
    '不是',
    '不对',
    '我考虑一下',
  ]
  for (const text of negatives) {
    assert.equal(isUserConfirmation(text), false, `必须排除：${text}`)
  }
})

test('3.0.7：长度边界——空串/超长一律排除', () => {
  assert.equal(isUserConfirmation(''), false)
  assert.equal(isUserConfirmation('   '), false)
  // 25 字符 > 上限 24：即使全是确认词也必须排除
  assert.equal(isUserConfirmation('好'.repeat(25)), false)
  assert.equal(isUserConfirmation('好'.repeat(24)), true)
})

test('3.0.7：类型边界——非字符串一律排除', () => {
  assert.equal(isUserConfirmation(undefined), false)
  assert.equal(isUserConfirmation(null), false)
  assert.equal(isUserConfirmation(42), false)
  assert.equal(isUserConfirmation({ text: '好' }), false)
  assert.equal(isUserConfirmation(['好']), false)
})

test('3.0.7：标点/空白/大小写不干扰判定', () => {
  assert.equal(isUserConfirmation(' OK！'), true)
  assert.equal(isUserConfirmation('好。'), true)
  assert.equal(isUserConfirmation('嗯，行'), true)
  assert.equal(isUserConfirmation('YES.'), true)
})
