/*
 * Status/truth consistency — the executable guard for the 2026-11-01 incident.
 *
 * What users saw: the dashboard header said “已完成 13/13（完成率 100%）” while
 * the T12 row directly below still said “卡住原因：本轮预算用尽，等待续跑”.
 * Root cause: `applyStatus` 的 done 分支不清 `error`，改判路径又传 `undefined`
 * （被解释成「保留旧值」），而界面无条件把 `error` 渲染成「卡住原因」。
 *
 * These tests pin the four structural guarantees the fix introduces:
 *   1. a `done` row can never carry an `error` (write side and read side);
 *   2. the historical failure text is not lost — it moves to `lastError`;
 *   3. progress 100 % requires every defined subtask to be done;
 *   4. replaying the same result snapshot twice does not move revisions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateInvariantViolations,
  applyResultStatuses,
  applyStatus,
  createStatuses,
  derivePlanSnapshot,
  normaliseStatusEntry,
  type StatusEntry,
} from '../src/plan.js'

function plan() {
  return {
    planId: 'wp-test',
    stages: [
      {
        id: 'S1',
        subtasks: [
          { id: 'T1', title: 'a', department: 'data', role: 'r', objective: 'o', method: ['m'], acceptance: ['x'], outputs: ['f'] },
          { id: 'T2', title: 'b', department: 'data', role: 'r', objective: 'o', method: ['m'], acceptance: ['x'], outputs: ['f'] },
        ],
      },
      {
        id: 'S2',
        subtasks: [
          { id: 'T3', title: 'c', department: 'qa', role: 'r', objective: 'o', method: ['m'], acceptance: ['x'], outputs: ['f'] },
        ],
      },
    ],
  }
}

test('done 写入必须清 error，并把旧文本迁入 lastError', () => {
  let statuses: any[] = createStatuses(plan()) as any[]
  statuses = applyStatus(statuses, 'T1', { status: 'blocked', error: '本轮预算用尽，等待续跑' }) as any[]
  assert.equal(statuses[0].error, '本轮预算用尽，等待续跑')

  statuses = applyStatus(statuses, 'T1', { status: 'done', updatedBy: 'agent' }) as any[]
  const row: any = statuses[0]
  assert.equal(row.status, 'done')
  assert.equal(row.error, null, 'done 行不得携带 error')
  assert.equal(row.lastError, '本轮预算用尽，等待续跑', '旧文本必须留档')
  assert.equal(row.completedBy, 'agent')
})

test('[1.10.2] 写侧补漏：显式 done+error 也只能进 lastError', () => {
  /* 1.10.0/1.10.1 只在 patch.error 为 undefined/null 时清空；显式传字符串仍会
   * 把「完成 + 失败文本」写进持久化记录，读侧虽然会清洗，但不变量已被破坏。 */
  let statuses: any[] = createStatuses(plan()) as any[]
  statuses = applyStatus(statuses, 'T1', { status: 'done', error: '显式传入的失败文本' }) as any[]
  assert.equal(statuses[0].status, 'done')
  assert.equal(statuses[0].error, null, '显式 done+error 也必须清空 error')
  assert.equal(statuses[0].lastError, '显式传入的失败文本', '旧文本只能留档')

  /* 回放路径：子会话 result 里 done 与 error 同时出现时同样不得落盘 */
  let replayed: any[] = createStatuses(plan()) as any[]
  replayed = applyResultStatuses(replayed, {
    statuses: [{ subtaskId: 'T1', status: 'done', progress: 100, error: '子会话 result 里的失败文本', revision: 1 }],
  }) as any[]
  assert.equal(replayed[0].status, 'done')
  assert.equal(replayed[0].error, null)
  assert.equal(replayed[0].lastError, '子会话 result 里的失败文本')
})

test('读侧迁移：历史 done+error 记录在载荷层立即干净', () => {
  const normalised = normaliseStatusEntry({
    subtaskId: 'T12',
    status: 'done',
    progress: 100,
    error: '本轮预算用尽，等待续跑；上一轮子会话 d283b2b6；运行 28s',
  })
  assert.equal(normalised.status, 'done')
  assert.equal(normalised.error, null)
  assert.match(String(normalised.lastError), /d283b2b6/)
})

test('I12：done 行残留 error 会被不变量判为违规', () => {
  const snapshot = derivePlanSnapshot([
    { subtaskId: 'T1', status: 'done', progress: 100, error: '卡住原因' },
  ])
  /* 派生会先清洗，所以这里直接构造一份「未清洗」的一致性快照做反向验证 */
  const dirty = {
    ...snapshot,
    statuses: [{ ...snapshot.statuses[0], error: '卡住原因' } as StatusEntry],
  }
  const violations = aggregateInvariantViolations(dirty)
  assert.ok(violations.some((item) => item.startsWith('I12')), violations.join('; '))
  assert.ok(!aggregateInvariantViolations(snapshot).some((item) => item.startsWith('I12')))
})

test('分母来自计划定义：明细行缺失不得把进度抬到 100%', () => {
  const rows = [
    { subtaskId: 'T1', status: 'done', progress: 100 },
    { subtaskId: 'T2', status: 'done', progress: 100 },
  ]
  const withDefinition = derivePlanSnapshot(rows, 3)
  assert.equal(withDefinition.stats.total, 3, '分母必须是定义条数')
  assert.equal(withDefinition.stats.done, 2)
  assert.equal(withDefinition.stats.pending, 1)
  assert.ok(withDefinition.stats.progress < 100, '缺一项就不可能 100%')
  assert.ok(!aggregateInvariantViolations(withDefinition).some((item) => item.startsWith('I13')))

  /* 没有定义时的旧行为保留（只数明细行），但调用方在 runtime 里总会传定义 */
  const withoutDefinition = derivePlanSnapshot(rows)
  assert.equal(withoutDefinition.stats.total, 2)
  assert.equal(withoutDefinition.stats.progress, 100)
})

test('I13：未全部完成却报 100% 会被判违规', () => {
  const snapshot = derivePlanSnapshot([
    { subtaskId: 'T1', status: 'done', progress: 100 },
    { subtaskId: 'T2', status: 'pending' },
  ])
  const dirty = { ...snapshot, stats: { ...snapshot.stats, progress: 100 } }
  const violations = aggregateInvariantViolations(dirty)
  assert.ok(violations.some((item) => item.startsWith('I13')), violations.join('; '))
})

test('回放幂等：相等 revision 的结果快照不得二次应用', () => {
  let statuses: any[] = createStatuses(plan()) as any[]
  const result = {
    statuses: [
      { subtaskId: 'T1', status: 'done', progress: 100, summary: 'ok', revision: 1, updatedBy: 'child' },
    ],
  }
  statuses = applyResultStatuses(statuses, result) as any[]
  const firstRevision = statuses[0].revision
  assert.equal(statuses[0].status, 'done')

  statuses = applyResultStatuses(statuses, result) as any[]
  assert.equal(statuses[0].revision, firstRevision, '同一份快照回放两次，revision 不得漂移')
})

test('计划级失败文本在改判 done 后不再出现在错误列表（runtime 侧归档）', () => {
  /*
   * serialisePlan 的归档逻辑不在此文件的依赖面内（需要完整 runtime 桩），
   * 这里只固化它读取的事实：全部 done 时 done === total，故 phase 会被
   * reconcilePhase 判为 done，从而进入归档分支。phase 断言见 phase-percent-invariant。
   */
  const snapshot = derivePlanSnapshot([
    { subtaskId: 'T1', status: 'done', progress: 100 },
  ])
  assert.equal(snapshot.stats.done, snapshot.stats.total)
  assert.equal(snapshot.stats.progress, 100)
})
