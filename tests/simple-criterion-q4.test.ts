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

import { criterionExAnte } from '../src/criterion.js'
import { deriveLeaderEstimate, normaliseStatusEntry } from '../src/plan.js'
import { affirmativeCriterionClaims, delegateEstimates, makeRenderer, sessionFixture } from './helpers/scv2-render.js'
import {
  ACTIVE_ENV, WIDE_WINDOWS, completedWithEvidence, dispatch, dropWorkRoot, landReport,
  makeRuntime, rowOf, waitFor, withEnv, withFakeNow,
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

test('C-Q4-02（AC-Q4-2 边界）：和 12 全部上报 ⇒ 「超简单判据」告警；无肯定性达标；告警由服务端布尔下发', async () => {
  const raw = {
    subtaskId: 'T1', status: 'in_progress', progress: 40,
    startedAt: 1_700_000_000_000, deadlineAt: 1_700_000_720_000,
    ...delegateEstimates([{ member: 'a', minutes: 4 }, { member: 'b', minutes: 5 }, { member: 'c', minutes: 3 }]),
  }
  const status: any = normaliseStatusEntry(raw)
  // ③ 判定在服务端下发（客户端不做算术）
  assert.equal(status.leaderEstimateOverCriterion, true, '服务端布尔=true')
  assert.equal(status.leaderEstimate.totalMinutes, 12)
  const render = await makeRenderer()
  const html = render(sessionFixture([status]))
  // ① 出现「超简单判据」告警（i18n 键 leaderEstimateOver）
  assert.ok(html.includes('超简单判据'), `看板必须出现超简单判据告警：${html.slice(0, 300)}`)
  assert.ok(html.includes('12 分钟'), '告警含事前预估和 12 分钟')
  // ② 不出现肯定性「达标」（模板条件式/否定式提及除外，见 helper 口径）
  assert.deepEqual(affirmativeCriterionClaims(html), [])
  // 客户端只渲染不算术：同一载荷去掉服务端布尔 ⇒ 告警消失（客户端不得自行求和判定）
  const stripped = { ...status }
  delete stripped.leaderEstimateOverCriterion
  const html2 = render(sessionFixture([stripped]))
  assert.ok(!html2.includes('超简单判据'), '去掉服务端布尔后告警必须消失（客户端不做算术）')
})

test('C-Q4-03（AC-Q4-2 边界，D-3）：3 叶子仅 2 上报（3+4）⇒ 只显示部分和 7；含「部分和」；绝不显示肯定性达标', async () => {
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
  // ① 只显示部分和 7
  assert.ok(html.includes('部分和：7 分钟'), `应显示部分和 7：${html.slice(0, 400)}`)
  // ② 文案含「部分和」
  assert.ok(html.includes('部分和'))
  assert.ok(html.includes('2/3 已上报'), '上报进度如实展示')
  // ③ 绝不显示肯定性「达标」（D-3；部分和模板自带否定式提示）
  assert.deepEqual(affirmativeCriterionClaims(html), [])
  assert.ok(html.includes('不得视为「简单判据达标」'), '部分和模板必须带不得视为达标提示')
})

test('C-Q4-04（AC-Q4-3 边界）：单叶子 12 本身不产生违规计数；部门行 totalMinutes=14 触发聚合告警', () => {
  const raw = {
    subtaskId: 'T1', status: 'in_progress',
    ...delegateEstimates([{ member: 'a', minutes: 12 }, { member: 'b', minutes: 2 }]),
  }
  const status: any = normaliseStatusEntry(raw)
  // ① 叶子本身不产生「违规」计数（违规审计只在结算闸产生，预估阶段无）
  assert.equal(status.criterionViolations, undefined, '单叶子 12 不单独判违规')
  for (const delegate of status.delegates) assert.equal(delegate.criterionViolations, undefined)
  // ② 部门行 totalMinutes=14 触发 AC-Q4-2 告警
  assert.equal(status.leaderEstimate.totalMinutes, 14)
  assert.equal(status.leaderEstimateOverCriterion, true)
})

test('C-Q4-05（AC-Q4-4 正例，D-2/D-3）：无叶子直做行——墙钟 9⇒met、11⇒unmet；无 timeNotice⇒unmet（不得自动豁免）', async () => {
  // 场景一：事前 5（负责人自身预估，D-2）＋墙钟 9 分钟 ⇒ met
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    const notice: any = await h.runtime.updateStatus({ session: h.session }, { subtaskId: 'T1', timeNotice: { declaredMinutes: 5 } })
    assert.equal(notice.ok, true)
    await withFakeNow(9 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000))
      assert.equal(row.criterionResult, 'met', '①9 分钟 ⇒ met')
      assert.equal(row.status, 'done')
    })
  })
  // 场景二：事前 5＋墙钟 11 分钟 ⇒ unmet
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    await h.runtime.updateStatus({ session: h.session }, { subtaskId: 'T1', timeNotice: { declaredMinutes: 5 } })
    await withFakeNow(11 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000))
      assert.equal(row.criterionResult, 'unmet', '②11 分钟 ⇒ unmet')
      assert.notEqual(row.status, 'done')
    })
  })
  // 场景三：无 timeNotice ⇒ exAnteComplete=false ⇒ unmet（③④，D-3 严格）
  await withEnv(ACTIVE_ENV, async () => {
    const h = harness(2_000_000, WIDE_WINDOWS)
    await dispatch(h)
    landReport(h)
    await withFakeNow(2 * 60_000, async () => {
      h.release(completedWithEvidence())
      let row: any = null
      assert.ok(await waitFor(async () => { row = await rowOf(h.runtime, h.session); return row && row.status !== 'in_progress' && row.status !== 'pending' }, 15_000))
      assert.equal(row.criterionResult, 'unmet', '④无 timeNotice ⇒ unmet（不得因没有叶子自动达标）')
      assert.notEqual(row.status, 'done')
    })
  })
  // criterionExAnte 输出口径（D-2 推荐 A：直做取负责人自身 timeNotice）
  assert.deepEqual(criterionExAnte({ timeNotice: { declaredMinutes: 5 } }, null), { minutes: 5, complete: true })
  assert.deepEqual(criterionExAnte({}, null), { minutes: null, complete: false }, '③无预估不得自动豁免')
})
