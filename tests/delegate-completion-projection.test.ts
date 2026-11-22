/*
 * [3.1.5] 第三层完成度投影回归：专家完成 ≠ 部门行自动完成。
 *
 * 事故口径：会话内 agent-2/agent-3 已在看板显示完成，而 T4 行仍不是 done。
 * 这不是第二份状态，也不是显示缓存；旧缺陷是缺少一个同源聚合字段，导致
 * 「delegates 逐条 done」与「行 status 未完成」被读成同一层级的矛盾结论。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { derivePlanSnapshot, normaliseStatusEntry } from '../src/plan.js'
import { modelStatusLines } from '../src/runtime.js'

test('T4 行未完成时，delegateCompletion 明确区分专家完成与部门汇总未完成', () => {
  const row = normaliseStatusEntry({
    subtaskId: 'T4',
    title: 'T4 部门任务',
    status: 'in_progress',
    progress: 80,
    delegates: [
      { member: '行业景气专家', role: 'expert', task: '单一任务', childId: 'agent-2', status: 'done', summary: '行业因素卡完成' },
      { member: '资金面专家', role: 'expert', task: '单一任务', childId: 'agent-3', status: 'done', summary: '资金面因素卡完成' },
    ],
  })

  assert.equal(row.status, 'in_progress', '部门行不能被下级完成自动改写')
  assert.deepEqual((row as any).delegateCompletion, {
    total: 2,
    done: 2,
    failed: 0,
    running: 0,
    rejected: 0,
    blocked: 0,
    timeout: 0,
    escalated: 0,
    allDone: true,
    awaitingLeaderSummary: true,
  })

  const [modelRow] = modelStatusLines([row])
  assert.equal(modelRow.status, 'in_progress')
  assert.equal(modelRow.delegateCompletion.allDone, true)
  assert.equal(modelRow.delegateCompletion.awaitingLeaderSummary, true)
})

test('部分专家失败/执行中时，allDone 不得为 true', () => {
  const row = normaliseStatusEntry({
    subtaskId: 'T4',
    status: 'in_progress',
    delegates: [
      { member: '行业景气专家', status: 'done' },
      { member: '资金面专家', status: 'failed', error: '证据缺失' },
    ],
  })

  assert.equal((row as any).delegateCompletion.done, 1)
  assert.equal((row as any).delegateCompletion.failed, 1)
  assert.equal((row as any).delegateCompletion.allDone, false)
  assert.equal((row as any).delegateCompletion.awaitingLeaderSummary, false)
})

test('无第三层分工/已重规划旧行不输出 delegateCompletion', () => {
  assert.equal(normaliseStatusEntry({ subtaskId: 'T1', status: 'in_progress' }).delegateCompletion, undefined)
  assert.equal(normaliseStatusEntry({
    subtaskId: 'T4-old',
    status: 'done',
    closure: 'replanned',
    delegates: [{ member: 'x', status: 'done' }],
  }).delegateCompletion, undefined)
})

test('看板快照与模型可读面共享同一 delegateCompletion 投影', () => {
  const row = {
    subtaskId: 'T4',
    status: 'in_progress',
    delegates: [
      { member: '行业景气专家', status: 'done' },
      { member: '资金面专家', status: 'done' },
    ],
  }
  const snapshot = derivePlanSnapshot([row])
  const [modelRow] = modelStatusLines(snapshot.statuses)
  assert.deepEqual(snapshot.statuses[0].delegateCompletion, modelRow.delegateCompletion)
})

/*
 * [T4][F2] 「等待负责人汇总」只对仍在推进的行成立。
 *
 * 反例（reports/T2_fix_gap_list.md §2.4 E1）：某行因验收不通过被 blocked、而
 * 专家恰好全部 done 时，旧判据仍给出 awaitingLeaderSummary=true，看板于是把
 * 受阻行解释成「只表示汇总未收尾」——不实表述。
 */
test('F2：专家全 done 但部门行 blocked 时，不得声称“只表示汇总未收尾”', () => {
  const row = normaliseStatusEntry({
    subtaskId: 'T4',
    status: 'blocked',
    error: '验收未通过：A2',
    delegates: [
      { member: '行业景气专家', status: 'done' },
      { member: '资金面专家', status: 'done' },
    ],
  })
  assert.equal((row as any).delegateCompletion.allDone, true)
  assert.equal((row as any).delegateCompletion.awaitingLeaderSummary, false)
})

test('F2：failed 行同样不冒领汇总解释；pending/in_progress 才显示等待汇总', () => {
  const failed = normaliseStatusEntry({
    subtaskId: 'T5',
    status: 'failed',
    lastError: '证据缺失',
    delegates: [{ member: 'a', status: 'done' }],
  })
  assert.equal((failed as any).delegateCompletion.awaitingLeaderSummary, false)

  const pending = normaliseStatusEntry({
    subtaskId: 'T6',
    status: 'pending',
    delegates: [{ member: 'a', status: 'done' }],
  })
  assert.equal((pending as any).delegateCompletion.awaitingLeaderSummary, true)

  const inProgress = normaliseStatusEntry({
    subtaskId: 'T7',
    status: 'in_progress',
    delegates: [{ member: 'a', status: 'done' }],
  })
  assert.equal((inProgress as any).delegateCompletion.awaitingLeaderSummary, true)
})
