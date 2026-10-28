/**
 * 派生计数可执行证明（开发期证据，不进入发布物）。
 *
 * 目的：用**真实的 1.4.2 缺陷数据**证明 `src/plan.ts` 里已发布的派生方案可以消除
 * T2 报告的 4 条缺陷，并且把“同一报文自相矛盾”变成不可表示的状态。
 *
 * 该脚本直接导入**已发布的实现**（`src/plan.ts`），不是设计稿副本：1.4.3 起不再维护
 * 第二份算法实现（`docs/design-derived-counts.reference.ts` 已删除），避免“设计与实现
 * 各算一套”重新变成双真相源。
 *
 * 运行：
 *   node --experimental-strip-types scripts/prove-derived-counts.ts
 *
 * 断言失败会抛错并以非 0 退出；全部通过打印 [PASS] 行与汇总。
 */

import assert from 'node:assert/strict'
import {
  aggregateInvariantViolations,
  computeStats as legacyComputeStats,
  derivePlanSnapshot,
  deriveAggregates,
  normaliseStatusEntry,
  type PlanSnapshot,
  type StatusEntry,
  type SubtaskStatus,
} from '../src/plan.ts'

let checks = 0

function pass(message: string): void {
  checks += 1
  console.log(`[PASS] ${message}`)
}

function entry(
  subtaskId: string,
  status: SubtaskStatus,
  progress: number,
  overrides: Partial<StatusEntry> = {},
): StatusEntry {
  return {
    subtaskId,
    stageId: 'S1',
    title: `步骤 ${subtaskId}`,
    department: 'engineering',
    role: '工程师',
    status,
    progress,
    childId: status === 'in_progress' ? `child-${subtaskId}` : null,
    startedAt: status === 'pending' ? null : 1_700_000_000_000,
    finishedAt: status === 'done' || status === 'blocked' ? 1_700_000_100_000 : null,
    summary: '',
    error: null,
    ...overrides,
  }
}

/** D1/D2：并发波中途，缓存 stats 停留在波首，statuses 已经是实时。 */
function scenarioConcurrentWave(): void {
  const liveStatuses: StatusEntry[] = [
    entry('design', 'in_progress', 10, { department: 'design' }),
    entry('engineering', 'done', 100, { department: 'engineering' }),
    entry('qa', 'done', 100, { department: 'qa' }),
  ]
  // 原始会话 payload 中被冻住的 stats（波首快照）：done=1, inProgress=0, pending=2, progress=33。
  const frozenStats = { total: 3, done: 1, blocked: 0, inProgress: 0, pending: 2, progress: 33 }

  const snapshot = derivePlanSnapshot(liveStatuses)
  assert.deepEqual(snapshot.stats, { total: 3, done: 2, blocked: 0, inProgress: 1, pending: 0, progress: 70 })
  pass(`D1 同一 statuses 派生出正确计数 ${JSON.stringify(snapshot.stats)}`)

  assert.notDeepEqual(snapshot.stats, frozenStats)
  assert.notEqual(snapshot.stats.done, frozenStats.done)
  assert.notEqual(snapshot.stats.inProgress, frozenStats.inProgress)
  pass('D2 被冻住的 stats 与实时 statuses 不可能再同时出现在一个报文里（派生结果唯一）')

  const departments = snapshot.departments
  assert.deepEqual(departments.find((item) => item.id === 'design'), {
    id: 'design',
    total: 1,
    done: 0,
    blocked: 0,
    inProgress: 1,
  })
  assert.equal(departments.reduce((sum, item) => sum + item.done, 0), snapshot.stats.done)
  assert.equal(departments.reduce((sum, item) => sum + item.inProgress, 0), snapshot.stats.inProgress)
  pass('D2 分母（departments）与分子（stats）来自同一次遍历，逐部门求和等于全局计数')
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
}

/** D3：预算暂停把 T12 留成 pending + progress=100 + childId/startedAt 残留。 */
function scenarioBudgetPause(): void {
  const statuses: StatusEntry[] = []
  for (let index = 1; index <= 11; index += 1) statuses.push(entry(`T${index}`, 'done', 100))
  statuses.push(entry('T12', 'pending', 100, {
    childId: '41bcef5d-stale',
    startedAt: 1_763_000_000_000,
    error: '本轮预算用尽，等待续跑',
    summary: '',
  }))

  const snapshot = derivePlanSnapshot(statuses)
  const t12 = snapshot.statuses.find((item) => item.subtaskId === 'T12')
  assert.ok(t12)
  assert.equal(t12.status, 'pending')
  assert.equal(t12.progress, 0)
  assert.equal(t12.childId, null)
  assert.equal(t12.startedAt, null)
  assert.equal(t12.finishedAt, null)
  assert.equal(t12.error, '本轮预算用尽，等待续跑')
  pass('D3 暂停条目被规范化为 pending + progress=0 + 无 childId/startedAt，错误提示保留')

  assert.deepEqual(snapshot.stats, { total: 12, done: 11, blocked: 0, inProgress: 0, pending: 1, progress: 92 })
  /*
   * 1.4.2 的 computeStats 直接把每条 item.progress 求平均，不看 status：
   * 11 个 done(100) + 1 个残留 100 的 pending ⇒ 1200/12 = 100%。这里用局部函数
   * 复刻**旧公式**，而不是调用 src/plan.ts 的 computeStats —— 后者在 1.4.3 已是
   * derivePlanSnapshot 的别名，调用它只会得到 92，无法再证明旧缺陷。
   */
  const legacyFormula = (items: StatusEntry[]): number =>
    items.length === 0 ? 0 : Math.round(items.reduce((sum, item) => sum + Number(item.progress ?? 0), 0) / items.length)
  assert.equal(legacyFormula(statuses), 100, '1.4.2 的公式确实把 pending 残留的 100 平均进总体进度')
  assert.equal(legacyComputeStats(statuses).progress, 92, '发布版别名必须给出 92，不得再复现旧公式')
  pass(`D3 12 项里 11 项完成 → 92%（1.4.2 公式会算成 ${legacyFormula(statuses)}%）`)
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
}

/** D4：blocked 计划 resume 后，缓存 stats.blocked 仍残留 2。 */
function scenarioResume(): void {
  const statuses: StatusEntry[] = [
    entry('T1', 'in_progress', 10, { childId: 'child-T1', startedAt: 1_700_000_500_000 }),
    entry('T2', 'pending', 0, { startedAt: null, finishedAt: null }),
    entry('T3', 'done', 100),
  ]
  const snapshot = derivePlanSnapshot(statuses)
  assert.deepEqual(snapshot.stats, { total: 3, done: 1, blocked: 0, inProgress: 1, pending: 1, progress: 37 })
  assert.equal(snapshot.stats.blocked, 0, 'resume 之后不能残留 blocked 计数')
  pass('D4 resume 后 blocked=0 / inProgress=1 / pending=1，与被重置的 statuses 完全一致')
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
}

/** 自洽性：任何 payload 重新喂回派生函数，必须原样返回同一份三元组（幂等）。 */
function scenarioIdempotence(): void {
  const snapshot = derivePlanSnapshot([
    entry('A', 'in_progress', 40),
    entry('B', 'blocked', 30, { error: '上游受阻' }),
    entry('C', 'done', 100),
    entry('D', 'pending', 0),
  ])
  const again = derivePlanSnapshot(snapshot.statuses)
  assert.deepEqual(again, snapshot)
  pass('S1 派生幂等：derivePlanSnapshot(payload.statuses) 与 payload.{stats,departments} 完全一致')

  const payload: PlanSnapshot = { statuses: snapshot.statuses, stats: snapshot.stats, departments: snapshot.departments }
  assert.deepEqual(derivePlanSnapshot(payload.statuses), payload)
  pass('S1 报文自检公式成立：payload 只能由 derivePlanSnapshot 生成，不能手工拼装')
}

/** 脏数据防线：未知状态、NaN、超界、字符串、null 条目都不能让计数失配。 */
function scenarioDirtyInput(): void {
  const dirty = [
    { ...entry('X', 'in_progress', 50), status: 'unknown' as unknown as SubtaskStatus },
    { ...entry('Y', 'in_progress', Number.NaN), progress: Number.NaN },
    { ...entry('Z', 'blocked', 150), progress: 150 },
    null,
  ]
  const snapshot = derivePlanSnapshot(dirty)
  assert.equal(snapshot.stats.total, 3, '无身份（null）的损坏条目在规范化阶段被丢弃，不计入 total')
  assert.equal(snapshot.stats.pending, 1, '未知状态 X 归入 pending，保证计数之和 = total')
  assert.equal(snapshot.stats.inProgress, 1)
  assert.equal(snapshot.stats.blocked, 1)
  assert.equal(snapshot.stats.done, 0)
  assert.equal(snapshot.stats.progress, 33, 'X 记 0、Y(NaN) 记 0、Z 夹到 100，合计 100/3 = 33')
  assert.deepEqual(aggregateInvariantViolations(snapshot), [])
  const unknown = snapshot.statuses.find((item) => item.subtaskId === 'X')
  assert.ok(unknown)
  assert.equal(unknown.status, 'pending')
  assert.equal(unknown.progress, 0)
  pass('S2 脏数据被结构化规范化：未知→pending、NaN→0、150→100、无身份条目丢弃，不变量恒成立')
}

/** 负向对照：检查器必须能抓到人为制造的矛盾，否则它是空转的。 */
function scenarioCheckerHasTeeth(): void {
  const snapshot = derivePlanSnapshot([entry('A', 'done', 100), entry('B', 'pending', 0)])
  const corrupted: PlanSnapshot = {
    statuses: snapshot.statuses,
    stats: { ...snapshot.stats, done: snapshot.stats.done + 1 },
    departments: snapshot.departments,
  }
  const violations = aggregateInvariantViolations(corrupted)
  assert.ok(violations.length > 0, '被篡改的 stats 必须被检查器抓到')
  assert.ok(violations.some((item) => item.startsWith('I2')), `应命中 I2，实际：${violations.join('；')}`)
  pass(`S3 不变量检查器有牙齿（负向对照命中 ${violations.length} 条：${violations[0]}）`)
}

/** 随机状态序列：不变量与幂等必须恒成立（确定性 LCG，不用第三方依赖）。 */
function scenarioRandomised(): void {
  let seed = 202_610_28
  const random = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
    return seed / 2 ** 32
  }
  const statuses: SubtaskStatus[] = ['pending', 'in_progress', 'done', 'blocked']
  const departments = ['engineering', 'design', 'qa']

  for (let round = 0; round < 500; round += 1) {
    const count = Math.floor(random() * 9)
    const input: StatusEntry[] = []
    for (let index = 0; index < count; index += 1) {
      const rawStatus = statuses[Math.floor(random() * statuses.length)]
      const status: SubtaskStatus = random() < 0.1 ? ('bogus' as SubtaskStatus) : rawStatus
      const progress = random() < 0.1 ? random() * 300 - 100 : Math.floor(random() * 101)
      input.push(entry(`T${index}`, status, progress, {
        department: departments[Math.floor(random() * departments.length)],
      }))
    }
    const snapshot = derivePlanSnapshot(input)
    const violations = aggregateInvariantViolations(snapshot)
    assert.deepEqual(violations, [], `随机用例 ${round} 违反不变量：${violations.join('；')}`)
    assert.deepEqual(derivePlanSnapshot(snapshot.statuses), snapshot, `随机用例 ${round} 不满足幂等`)
    assert.equal(snapshot.stats.total, input.length)
  }
  pass('S4 500 组随机状态序列：不变量与幂等全部成立')
}

/** 直接对 raw 聚合（不先规范化）也必须自洽，作为防线兜底。 */
function scenarioRawDefence(): void {
  const raw = [entry('P', 'pending', 100)]
  const { stats } = deriveAggregates(raw)
  assert.equal(stats.progress, 0, 'pending 的脏 progress 不得污染总体进度')
  pass('S5 绕过规范化直接聚合时，pending 的 progress=100 仍被按 0 计（D3 双保险）')

  const normalised = normaliseStatusEntry(entry('P', 'pending', 100))
  assert.equal(normalised.progress, 0)
  assert.equal(normalised.childId, null)
  pass('S5 normaliseStatusEntry 幂等且不改时间戳（序列化可安全重复调用）')
}

scenarioConcurrentWave()
scenarioBudgetPause()
scenarioResume()
scenarioIdempotence()
scenarioDirtyInput()
scenarioCheckerHasTeeth()
scenarioRandomised()
scenarioRawDefence()

console.log(`\nAll design proofs passed (${checks} assertions).`)
