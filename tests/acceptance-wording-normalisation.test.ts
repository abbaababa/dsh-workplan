/**
 * [3.0.3] 验收措辞归一化回归钉。
 *
 * 旧 normaliseCriterion 只做小写化 + 去标点 + 去祈使前缀，子 Agent 汇报
 * 换个措辞——加标点、大小写、多余空格、全角字符、「已完成：」式完成态
 * 前缀——就永远 missing，验收被无限退回。
 *
 * 本文件钉住归一化后的覆盖判定与「不放开」边界：
 *  - 「完成接口测试」被「已完成：接口测试。」覆盖（任务书指定用例）；
 *  - 全角字符、全角空格、大小写差异归一；
 *  - done/yes 前缀剥离，yesterday 类以 yes 开头的词不被误吃；
 *  - 只回一半、否定词反转仍不覆盖（Q6/U-16 与 2.0.4 语义不变）；
 *  - A1…An 稳定编号对号入座仍然有效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { acceptanceCoverage, normaliseCriterion } from '../src/plan.js'

test('任务书指定用例：「完成接口测试」被「已完成：接口测试。」覆盖', () => {
  const result = acceptanceCoverage(['完成接口测试'], [{ criterion: '已完成：接口测试。' }])
  assert.equal(result.total, 1)
  assert.equal(result.covered, 1)
  assert.deepEqual(result.missing, [])
})

test('归一化单元：前缀/标点/大小写/全角/全角空格', () => {
  assert.equal(normaliseCriterion('  已完成：接口测试。 '), '接口测试')
  assert.equal(normaliseCriterion('完成接口测试'), '接口测试')
  assert.equal(normaliseCriterion('Done: Run Unit Tests'), 'rununittests')
  assert.equal(normaliseCriterion('Yes, login flow works'), 'loginflowworks')
  // 全角字母数字与全角空格折叠到半角后再比较小写化结果。
  assert.equal(normaliseCriterion('已完成：ＲＵＮ　ｕｎｉｔ　ｔｅｓｔｓ。'), normaliseCriterion('run unit tests'))
  // 英文 yes 后随字母不算前缀（yesterday），CJK 已 直接相接算前缀。
  assert.equal(normaliseCriterion('yesterday once more'), 'yesterdayoncemore')
  assert.equal(normaliseCriterion('已通过登录测试'), '通过登录测试')
})

test('全角/半角、大小写、空格差异的双向覆盖', () => {
  const result = acceptanceCoverage(
    ['Run unit tests'],
    [{ criterion: '已完成：ＲＵＮ　ｕｎｉｔ　ｔｅｓｔｓ。' }],
  )
  assert.equal(result.covered, 1, JSON.stringify(result))
  assert.deepEqual(result.missing, [])
})

test('done/yes 前缀的英文汇报覆盖英文验收项', () => {
  const result = acceptanceCoverage(
    ['login flow works'],
    [{ criterion: 'done: login flow works' }, { criterion: 'yes, login flow works' }],
  )
  // 两条证据各自与验收项等值归一，覆盖判定只看是否存在命中行。
  assert.equal(result.covered, 1, JSON.stringify(result))
})

test('只回一半仍不覆盖（Q6/U-16 不回退）', () => {
  const result = acceptanceCoverage(
    ['登录测试与越权测试通过'],
    [{ criterion: '登录测试已通过' }],
  )
  assert.equal(result.covered, 0)
  assert.deepEqual(result.missing, ['登录测试与越权测试通过'])
})

test('否定词反转仍不覆盖（2.0.4 否定词状态一致要求不回退）', () => {
  const result = acceptanceCoverage(
    ['不得超过 5% 的错误率'],
    [{ criterion: '错误率 5%，符合预期' }],
  )
  assert.equal(result.covered, 0)
})

test('A1…An 稳定编号对号入座仍有效', () => {
  const result = acceptanceCoverage(
    ['登录功能正常', '越权访问被拦截'],
    [{ criterion: 'A1 已验证通过' }],
  )
  assert.equal(result.covered, 1, JSON.stringify(result))
  assert.deepEqual(result.missing, ['越权访问被拦截'])
})

test('短文本等值：ok 仍只认 ok（crossdept-hardening 不回退）', () => {
  const covered = acceptanceCoverage(['ok'], [{ criterion: 'OK' }])
  assert.equal(covered.covered, 1)
  const notCovered = acceptanceCoverage(['ok'], [{ criterion: 'okay' }])
  assert.equal(notCovered.covered, 0)
})
