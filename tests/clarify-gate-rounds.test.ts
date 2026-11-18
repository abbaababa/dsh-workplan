/**
 * [3.0.2] 澄清闸轮次上限（CLARIFY_GATE_MAX_ROUNDS）的回归钉。
 *
 * 钉住四件事：
 *  1. 同一会话连续触发澄清提问，第 1、2 轮照常 needed:true，
 *     达到上限后第 3 轮起一律 needed:false（放行进入规划）；
 *  2. 30 分钟 TTL 自愈：距上次触发超过 30 分钟，计数自动归零、恢复提问；
 *  3. resetClarifyRounds(sessionId) 立即清零（宿主 hook 到规划起点时应调用）；
 *  4. 会话隔离：A 会话耗尽不影响 B 会话；规则未命中的调用不计数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  auditClarifyNeed,
  resetClarifyRounds,
  CLARIFY_GATE_MAX_ROUNDS,
  __setClarifyGateClockForTests,
} from '../src/understanding.js'

/** C1 必中样例（逐字取自 MS2 T05-04）。 */
const C1_TEXT = 'W5 的跨版本 A/B 探针不进 npm test（R-W5-01，建议移入发版清单）。同意移入'

test.beforeEach(() => {
  resetClarifyRounds('')
  resetClarifyRounds('sess-a')
  resetClarifyRounds('sess-b')
  __setClarifyGateClockForTests()
})

test(`上限：连续触发 ${CLARIFY_GATE_MAX_ROUNDS} 轮后，下一轮放行`, () => {
  for (let round = 1; round <= CLARIFY_GATE_MAX_ROUNDS; round += 1) {
    const verdict = auditClarifyNeed(C1_TEXT, '')
    assert.equal(verdict.needed, true, `第 ${round} 轮必须照常提问`)
    assert.equal(verdict.rule, 'C1')
  }
  // 第 3 次（达到上限后）放行进入规划。
  const blocked = auditClarifyNeed(C1_TEXT, '')
  assert.equal(blocked.needed, false, JSON.stringify(blocked))
  assert.equal(blocked.rule, '')
  // 之后持续放行，不会恢复。
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, false)
})

test('上限：规则未命中的调用不计数', () => {
  const normal = '把版本号改成 1.12.0，并同步 README 与 CHANGELOG。'
  for (let index = 0; index < CLARIFY_GATE_MAX_ROUNDS + 2; index += 1) {
    assert.equal(auditClarifyNeed(normal, '').needed, false)
  }
  // 正常任务没消耗任何轮次，C1 仍可提问两轮。
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, false)
})

test('自愈：30 分钟未再触发则计数归零', () => {
  let now = 1_700_000_000_000
  __setClarifyGateClockForTests(() => now)
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, false)
  // 未满 30 分钟：仍挡住。
  now += 29 * 60 * 1000
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, false)
  // 超过 30 分钟：自动归零，恢复提问。
  now += 2 * 60 * 1000
  const revived = auditClarifyNeed(C1_TEXT, '')
  assert.equal(revived.needed, true, JSON.stringify(revived))
  assert.equal(revived.rule, 'C1')
  // 恢复后重新计满两轮再放行。
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '').needed, false)
})

test('reset：resetClarifyRounds 立即清零（宿主 hook 规划起点时的调用点）', () => {
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-a').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-a').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-a').needed, false)
  // 「会话开始新规划」：宿主调用 reset 立即清零，不用等 TTL。
  resetClarifyRounds('sess-a')
  const verdict = auditClarifyNeed(C1_TEXT, '', 'sess-a')
  assert.equal(verdict.needed, true, JSON.stringify(verdict))
})

test('会话隔离：A 耗尽不影响 B', () => {
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-a').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-a').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-a').needed, false)
  // B 会话独立计数，照常两轮。
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-b').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-b').needed, true)
  assert.equal(auditClarifyNeed(C1_TEXT, '', 'sess-b').needed, false)
})
