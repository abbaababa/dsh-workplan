/**
 * [3.0.2] 原子任务门槛的英文盲区修复回归钉。
 *
 * 旧判据两个盲区让复合任务被当单句放行：
 *  1) 句末符只收 。！？!?——英文句点 `.` 不算，「Fix A. Then update B.」
 *     两个英文句子却判原子；
 *  2) 并列词表缺 并/然后/接着/再——「改A并改B」「先备份再修改」全漏。
 *
 * 本文件钉住修复后的判定与「不误伤」边界：
 *  - 英文多句（`. ` 分隔）判复合；单个英文句仍是原子；
 *  - 文件名（a.ts）、版本号（1.12.0）里的点不算句读；
 *  - 并/然后/接着判复合；「再」只在两动作之间当连词时判复合，
 *    「不要再等待」「再次运行」不误伤；
 *  - 报错里的字符数如实报告截断后实际长度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { checkAtomicAssignment } from '../src/v3-contract.js'

const QUALITY = ['必须给出可复核的命令输出作为证据']

test('英文多句判复合：Fix A. Then update B.', () => {
  const result = checkAtomicAssignment('Fix A. Then update B.', QUALITY)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_TASK_NOT_ATOMIC')
  assert.match(String(result.error), /多个句子/)
})

test('英文单句仍原子：Fix the login bug.', () => {
  const result = checkAtomicAssignment('Fix the login bug.', QUALITY)
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('文件名与版本号里的英文点不算句读', () => {
  const file = checkAtomicAssignment('Fix the x.test.js parse failure in src dir.', QUALITY)
  assert.equal(file.ok, true, JSON.stringify(file))
  const version = checkAtomicAssignment('Bump the version to 1.12.0 in the manifest.', QUALITY)
  assert.equal(version.ok, true, JSON.stringify(version))
})

test('中文并列词：并 / 然后 / 接着 判复合', () => {
  for (const task of ['修改A模块并修改B模块', '先备份数据库然后修改配置', '先跑用例接着提交结果']) {
    const result = checkAtomicAssignment(task, QUALITY)
    assert.equal(result.ok, false, `${task} -> ${JSON.stringify(result)}`)
    assert.equal(result.code, 'DELEGATE_TASK_NOT_ATOMIC')
    assert.match(String(result.error), /并列词/)
  }
  // 报错文案只列长词：「并且」命中时不再重复列「并」。
  const both = checkAtomicAssignment('修改A模块并且修改B模块', QUALITY)
  assert.equal(both.ok, false)
  assert.match(String(both.error), /并且/)
  assert.doesNotMatch(String(both.error), /「并且、并」/)
})

test('连词「再」：两动作之间判复合，否定/副词用法不误伤', () => {
  // 两动作之间 → 复合。
  const compound = checkAtomicAssignment('先备份数据库再修改配置项', QUALITY)
  assert.equal(compound.ok, false, JSON.stringify(compound))
  assert.match(String(compound.error), /并列词「再」/)
  // 「不要再等待」不误伤（否定式）。
  const negated = checkAtomicAssignment('请不要再等待用户批复', QUALITY)
  assert.equal(negated.ok, true, JSON.stringify(negated))
  // 「再次运行」不误伤（副词）。
  const again = checkAtomicAssignment('再次运行全部回归用例', QUALITY)
  assert.equal(again.ok, true, JSON.stringify(again))
})

test('报错字符数如实报告截断后实际长度', () => {
  // 直接送检 320 字符：截断未介入，报告的就是实际长度。
  const task = `写${'x'.repeat(320)}`
  const direct = checkAtomicAssignment(task, QUALITY)
  assert.equal(direct.ok, false)
  assert.match(String(direct.error), /截断后实际 321 字符 > 300/)
})
