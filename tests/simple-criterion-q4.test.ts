/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：Q4 粒度与责任（E-2/E-3/E-4）。
 * 承载用例：C-Q4-01…C-Q4-05（cases.md §6.2）。
 * 预期唯一来源：spec:163-166（AC-Q4-1…AC-Q4-4）。
 * 口径澄清（写入 T6 报告）：cases.md C-Q4-02 行「4 叶子 4+5+3=12」叶子数与
 * 算术和不一致（4+5+3 为 3 个加数）；按算术和 12 执行（3 叶子 4/5/3），
 * 预期不变（和 >10 告警、不达标）。
 * D-2/D-3 未裁定：本文件只断言 spec §3.6 推荐 A 的行为事实，不宣布达标。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { deriveLeaderEstimate, normaliseStatusEntry } from '../src/plan.js'
import { affirmativeCriterionClaims, delegateEstimates, makeRenderer, sessionFixture } from './helpers/scv2-render.js'
import {
  WIDE_WINDOWS, completedWithEvidence, dispatch, dropWorkRoot, landReport,
  makeRuntime, rowOf, waitFor, withFakeNow,
} from './helpers/scv2-runtime.js'

const roots: string[] = []
after(() => { for (const r of roots) dropWorkRoot(r) })
function harness(createdAt: number, options: any = {}) {
  const h = makeRuntime(createdAt, options)
  roots.push(h.workRoot)
  return h
}

test('C-Q4-01（AC-Q4-1 正例）：3 叶子 3/4/2 全部 sent ⇒ totalMinutes=9（误差 0）、reported=expected=3、缺口为空', () => {
  const row = {
    subtaskId: 'T1', status: 'in_progress',
    ...delegateEstimates([{ member: 'a', minutes: 3 }, { member: 'b', minutes: 4 }, { member: 'c', minutes: 2 }]),
  }
  const sum = deriveLeaderEstimate(row)
  assert.equal(sum?.totalMinutes, 9, '算术和 3+4+2=9，误差 0')
  assert.equal(sum?.reported, 3)
  assert.equal(sum?.expected, 3)
  assert.deepEqual(sum?.missing, [])
  assert.deepEqual(sum?.failed, [])
})

test('C-Q4-02（无时限新契约）：预估和 12 保留为信息，面板不出现超判据告警', async () => {
  const raw = {
    subtaskId: 'T1', status: 'in_progress', progress: 40,
    startedAt: 1_700_000_000_000, deadlineAt: null,
    ...delegateEstimates([{ member: 'a', minutes: 4 }, { member: 'b', minutes: 5 }, { member: 'c', minutes: 3 }]),
  }
  const status: any = normaliseStatusEntry(raw)
  assert.equal(status.leaderEstimateOverCriterion, false, '10 分钟判据告警永久关闭')
  assert.equal(status.leaderEstimate.totalMinutes, 12)
  const render = await makeRenderer()
  const html = render(sessionFixture([status]))
  assert.ok(!html.includes('超简单判据'), '看板不再出现超简单判据告警')
  assert.deepEqual(affirmativeCriterionClaims(html), [], '也不宣布判据达标')
  assert.ok(html.includes('无时限') || html.includes('执行无时限'), '明确展示无执行时限')
})

test('C-Q4-03（无时限新契约）：3 叶子仅 2 上报 ⇒ 部分和 7 仍如实展示，不判达标', async () => {
  const raw = {
    subtaskId: 'T1', status: 'in_progress', progress: 40,
    ...delegateEstimates([{ member: 'a', minutes: 3 }, { member: 'b', minutes: 4 }, { member: 'c', minutes: null }]),
  }
  const status: any = normaliseStatusEntry(raw)
  assert.equal(status.leaderEstimate.totalMinutes, 7)
  assert.equal(status.leaderEstimate.reported, 2)
  assert.equal(status.leaderEstimate.expected, 3)
  assert.deepEqual(status.leaderEstimate.missing, ['c'])
  const render = await makeRenderer()
  const html = render(sessionFixture([status]))
  assert.ok(html.includes('部分和：7 分钟'), `应显示部分和 7：${html.slice(0, 400)}`)
  assert.ok(html.includes('2/3 已上报'), '上报进度如实展示')
  assert.deepEqual(affirmativeCriterionClaims(html), [], '部分和不是达标')
  assert.ok(!html.includes('超简单判据'), '不再显示 10 分钟告警')
})

test('C-Q4-04（无时限新契约）：单叶子 12 与合计 14 均不产生违规或聚合告警', () => {
  const raw = {
    subtaskId: 'T1', status: 'in_progress',
    ...delegateEstimates([{ member: 'a', minutes: 12 }, { member: 'b', minutes: 2 }]),
  }
  const status: any = normaliseStatusEntry(raw)
  assert.equal(status.criterionViolations, undefined, '单叶子 12 不判违规')
  for (const delegate of status.delegates) assert.equal(delegate.criterionViolations, undefined)
  assert.equal(status.leaderEstimate.totalMinutes, 14, '合计仍保留')
  assert.equal(status.leaderEstimateOverCriterion, false, '合计 14 也不触发 10 分钟告警')
})

test('C-Q4-05（核心新契约）：11 分钟无 timeNotice 仍可 done，判据不再形成时间门', async () => {
  const h = harness(2_000_000, WIDE_WINDOWS)
  await dispatch(h)
  landReport(h)
  await withFakeNow(11 * 60_000, async () => {
    h.release(completedWithEvidence())
    let row: any = null
    assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000))
    assert.equal(row.status, 'done', '真实证据齐备时，11 分钟与缺失 timeNotice 都不阻止 done')
    assert.notEqual(row.criterionResult, 'unmet', '旧判据不得再判 unmet')
  })
})
