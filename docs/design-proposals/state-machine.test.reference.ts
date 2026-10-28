/*
 * T4 回归测试：子任务状态机、重置语义与不变量。
 *
 * 每条断言都对应 docs/state-machine-design.md 里的一张表或一条不变量；
 * 测试名称直接引用 T2 缺陷编号，修复后这些用例必须保持绿色。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { computeStats, planPhase } from '../src/plan.js'
import {
  ATTACH_PROGRESS,
  BLOCKED_REASON_FALLBACK,
  IllegalPhaseTransitionError,
  IllegalTransitionError,
  InvalidEntryError,
  InvariantError,
  PLAN_OPERATIONS,
  PLAN_PHASES,
  PLAN_PHASE_EVENTS,
  START_PROGRESS,
  SUBTASK_STATUSES,
  StateMachineError,
  TRANSITION_TYPES,
  allowedPhaseEvents,
  allowedSourceStatuses,
  applyPhaseEvent,
  applyPlanOperation,
  applyTransition,
  assertInvariants,
  collectViolations,
  findDepartmentViolations,
  findEntryViolations,
  findPhaseViolations,
  findStatsViolations,
  findStatusViolations,
  isPlanPhase,
  isSubtaskStatus,
  normaliseEntry,
  normaliseStatuses,
} from '../src/state.js'
import type { PlanPhase, StatusEntry, SubtaskStatus, Transition, TransitionType } from '../src/state.js'

const NOW = 1_700_000_000_000

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subtaskId: 'T1',
    stageId: 'stage-1',
    title: '任务一',
    department: 'eng',
    role: 'dev',
    status: 'pending',
    progress: 0,
    childId: null,
    startedAt: null,
    finishedAt: null,
    summary: '',
    error: null,
    ...overrides,
  }
}

function sample(status: SubtaskStatus): StatusEntry {
  switch (status) {
    case 'pending':
      return normaliseEntry(base(), { now: NOW })
    case 'in_progress':
      return normaliseEntry(base({ status, progress: 40, childId: 'child-1', startedAt: NOW, summary: '执行中' }), {
        now: NOW,
      })
    case 'done':
      return normaliseEntry(
        base({ status, progress: 100, childId: 'child-1', startedAt: NOW, finishedAt: NOW + 10, summary: '完成' }),
        { now: NOW },
      )
    case 'blocked':
      return normaliseEntry(
        base({ status, progress: 30, childId: 'child-1', startedAt: NOW, finishedAt: NOW + 10, error: '构建失败' }),
        { now: NOW },
      )
  }
  throw new Error(`unexpected status: ${String(status)}`)
}

function withId(entry: StatusEntry, subtaskId: string): StatusEntry {
  return { ...entry, subtaskId }
}

function withDepartment(entry: StatusEntry, department: string): StatusEntry {
  return { ...entry, department }
}

function payload(type: TransitionType): Transition {
  switch (type) {
    case 'start':
      return { type, progress: START_PROGRESS, at: NOW }
    case 'bind-child':
      return { type, childId: 'child-9', progress: ATTACH_PROGRESS }
    case 'report-progress':
      return { type, progress: 55 }
    case 'complete':
      return { type, summary: '完成', at: NOW + 20 }
    case 'fail':
      return { type, error: '失败原因', at: NOW + 20 }
    case 'reset':
      return { type }
    case 'restart':
      return { type, progress: START_PROGRESS, at: NOW + 20 }
  }
  throw new Error(`unexpected transition: ${String(type)}`)
}

const EXPECTED_STATUS: Record<TransitionType, SubtaskStatus> = {
  start: 'in_progress',
  'bind-child': 'in_progress',
  'report-progress': 'in_progress',
  complete: 'done',
  fail: 'blocked',
  reset: 'pending',
  restart: 'in_progress',
}

/* ------------------------------------------------------------------ *
 * §1 迁移矩阵：4 状态 × 7 动作全部枚举，不允许出现“第三种结果”
 * ------------------------------------------------------------------ */

test('迁移矩阵覆盖 4 个状态 × 7 个动作，合法结果均满足不变量', () => {
  let legal = 0
  for (const status of SUBTASK_STATUSES) {
    for (const type of TRANSITION_TYPES) {
      try {
        const next = applyTransition(sample(status), payload(type), { now: NOW })
        legal += 1
        assert.equal(next.status, EXPECTED_STATUS[type], `${status} × ${type} 的目标状态错误`)
        assert.deepEqual(findEntryViolations(next), [], `${status} × ${type} 的产物违反字段规则`)
      } catch (error) {
        assert.ok(
          error instanceof IllegalTransitionError,
          `${status} × ${type} 抛出了非契约错误：${error instanceof Error ? error.message : String(error)}`,
        )
        assert.equal((error as IllegalTransitionError).from, status)
        assert.equal((error as IllegalTransitionError).action, type)
      }
    }
  }
  const allowedTotal = TRANSITION_TYPES.reduce((sum, type) => sum + allowedSourceStatuses(type).length, 0)
  assert.equal(legal, allowedTotal)
  assert.equal(legal, 16)
})

test('非法迁移明确报错：不允许 start 已完成任务、不允许 complete 未开始任务', () => {
  assert.throws(() => applyTransition(sample('done'), { type: 'start' }), IllegalTransitionError)
  assert.throws(() => applyTransition(sample('pending'), { type: 'complete' }), IllegalTransitionError)
  assert.throws(() => applyTransition(sample('pending'), { type: 'bind-child', childId: 'c' }), IllegalTransitionError)
  assert.throws(() => applyTransition(sample('blocked'), { type: 'report-progress', progress: 50 }), IllegalTransitionError)
  assert.throws(() => applyTransition(sample('done'), { type: 'fail', error: 'x' }), IllegalTransitionError)
})

/* ------------------------------------------------------------------ *
 * §2 归一化：历史脏数据先修复，再断言
 * ------------------------------------------------------------------ */

test('pending 不得携带运行态/结果字段：六个伴随字段全部清空', () => {
  const dirty = base({
    status: 'pending',
    progress: 100,
    childId: 'child-x',
    startedAt: NOW,
    finishedAt: NOW,
    summary: '遗留摘要',
    error: '旧错误',
  })
  const codes = findEntryViolations(dirty).map((item) => item.code)
  for (const code of [
    'pending.progress',
    'pending.childId',
    'pending.startedAt',
    'pending.finishedAt',
    'pending.summary',
    'pending.error',
  ]) {
    assert.ok(codes.includes(code), `未捕获 ${code}，实际：${codes.join(',')}`)
  }
  const clean = normaliseEntry(dirty, { now: NOW })
  assert.deepEqual(clean, normaliseEntry(base(), { now: NOW }))
  assert.deepEqual(findEntryViolations(clean), [])
})

test('in_progress 归一化：进度封顶 99、清 finishedAt/error、补 startedAt', () => {
  const dirty = base({ status: 'in_progress', progress: 100, startedAt: null, finishedAt: NOW, error: '旧错误', summary: '进行中' })
  const clean = normaliseEntry(dirty, { now: NOW })
  assert.equal(clean.progress, 99)
  assert.equal(clean.startedAt, NOW)
  assert.equal(clean.finishedAt, null)
  assert.equal(clean.error, null)
  assert.equal(clean.summary, '进行中')
  assert.deepEqual(findEntryViolations(clean), [])
})

test('done 归一化：进度固定 100、清 error、缺 finishedAt 时补 now', () => {
  const dirty = base({ status: 'done', progress: 50, finishedAt: null, error: '旧错误', summary: '已有结论' })
  const clean = normaliseEntry(dirty, { now: NOW })
  assert.equal(clean.progress, 100)
  assert.equal(clean.finishedAt, NOW)
  assert.equal(clean.error, null)
  assert.equal(clean.summary, '已有结论')
  assert.deepEqual(findEntryViolations(clean), [])
})

test('blocked 归一化：进度封顶 99、缺 error 时用 summary 或兜底文案', () => {
  const dirty = base({ status: 'blocked', progress: 100, error: '   ', summary: '上游子任务受阻：T2' })
  const clean = normaliseEntry(dirty, { now: NOW })
  assert.equal(clean.progress, 99)
  assert.equal(clean.error, '上游子任务受阻：T2')
  assert.equal(clean.finishedAt, NOW)
  assert.deepEqual(findEntryViolations(clean), [])

  const bare = normaliseEntry(base({ status: 'blocked', progress: 100 }), { now: NOW })
  assert.equal(bare.error, BLOCKED_REASON_FALLBACK)
})

test('归一化是幂等的，且不修改输入对象', () => {
  const dirty = base({ status: 'pending', progress: 100, childId: 'child-x', error: '旧错误' })
  const once = normaliseEntry(dirty, { now: NOW })
  const twice = normaliseEntry(once, { now: NOW })
  assert.deepEqual(once, twice)
  assert.equal(dirty.progress, 100)
  assert.equal(dirty.childId, 'child-x')

  const frozen = Object.freeze(base({ status: 'pending', progress: 80 }))
  const out = normaliseStatuses([frozen], { now: NOW })
  assert.equal(out.length, 1)
  assert.equal(frozen.progress, 80)
})

test('非法状态项必须报错，而不是被静默修复', () => {
  assert.throws(() => normaliseEntry(null), InvalidEntryError)
  assert.throws(() => normaliseEntry({ status: 'pending' }), InvalidEntryError)
  assert.throws(() => normaliseEntry({ subtaskId: 'T1', status: 'running' }), InvalidEntryError)
  assert.throws(() => normaliseEntry({ subtaskId: 'T1', status: 'pending' }, { now: Number.NaN }), StateMachineError)
})

/* ------------------------------------------------------------------ *
 * §3 迁移后的字段写入（含 fail 不再伪造 100%）
 * ------------------------------------------------------------------ */

test('start：进度 5、startedAt、清空 childId/finishedAt/error', () => {
  const next = applyTransition(sample('pending'), { type: 'start' }, { now: NOW })
  assert.equal(next.status, 'in_progress')
  assert.equal(next.progress, START_PROGRESS)
  assert.equal(next.startedAt, NOW)
  assert.equal(next.childId, null)
  assert.equal(next.finishedAt, null)
  assert.equal(next.error, null)
  assert.equal(next.summary, '')
})

test('bind-child：只写 childId 并抬升进度，不降低已有进度', () => {
  const fresh = normaliseEntry(base({ status: 'in_progress', progress: 0, startedAt: NOW }), { now: NOW })
  const bound = applyTransition(fresh, { type: 'bind-child', childId: 'child-9' }, { now: NOW })
  assert.equal(bound.childId, 'child-9')
  assert.equal(bound.progress, ATTACH_PROGRESS)

  const later = applyTransition(sample('in_progress'), { type: 'bind-child', childId: 'child-9' }, { now: NOW })
  assert.equal(later.progress, 40)
})

test('report-progress：100 只能由 complete 写入，直接报 100 必须报错', () => {
  const next = applyTransition(sample('in_progress'), { type: 'report-progress', progress: 99 }, { now: NOW })
  assert.equal(next.progress, 99)
  assert.throws(
    () => applyTransition(sample('in_progress'), { type: 'report-progress', progress: 100 }),
    (error: unknown) => error instanceof StateMachineError && error.code === 'INVALID_PROGRESS',
  )
  assert.throws(
    () => applyTransition(sample('pending'), { type: 'start', progress: 100 }),
    (error: unknown) => error instanceof StateMachineError && error.code === 'INVALID_PROGRESS',
  )
})

test('fail：blocked 保留真实进度（封顶 99），不再伪造成 100%', () => {
  const running = normaliseEntry(base({ status: 'in_progress', progress: 80, childId: 'c', startedAt: NOW }), { now: NOW })
  const failed = applyTransition(running, { type: 'fail', error: '子 Agent 退出码 1', summary: '编译失败' }, { now: NOW + 5 })
  assert.equal(failed.status, 'blocked')
  assert.equal(failed.progress, 80)
  assert.equal(failed.childId, 'c')
  assert.equal(failed.startedAt, NOW)
  assert.equal(failed.finishedAt, NOW + 5)
  assert.equal(failed.error, '子 Agent 退出码 1')
  assert.equal(failed.summary, '编译失败')
  assert.deepEqual(findEntryViolations(failed), [])

  assert.throws(
    () => applyTransition(running, { type: 'fail', error: '   ' }),
    (error: unknown) => error instanceof StateMachineError && error.code === 'MISSING_REASON',
  )
})

test('complete：进度 100、清 error、保留摘要；重复完成幂等', () => {
  const running = applyTransition(sample('in_progress'), { type: 'complete', summary: '完成' }, { now: NOW + 7 })
  assert.equal(running.status, 'done')
  assert.equal(running.progress, 100)
  assert.equal(running.finishedAt, NOW + 7)
  assert.equal(running.error, null)
  assert.equal(running.summary, '完成')

  const again = applyTransition(running, { type: 'complete', summary: '补充说明' }, { now: NOW + 9 })
  assert.equal(again.progress, 100)
  assert.equal(again.finishedAt, NOW + 7)
  assert.equal(again.summary, '补充说明')
  assert.deepEqual(findEntryViolations(again), [])
})

/* ------------------------------------------------------------------ *
 * §4 重置：任意状态回到同一初始态，六个伴随字段全部清空
 * ------------------------------------------------------------------ */

test('reset 从四个状态都回到同一初始态', () => {
  const expected = normaliseEntry(base(), { now: NOW })
  for (const status of SUBTASK_STATUSES) {
    const reset = applyTransition(sample(status), { type: 'reset' }, { now: NOW })
    assert.deepEqual(reset, expected, `${status} reset 后残留了字段`)
    assert.equal(reset.status, 'pending')
    assert.equal(reset.progress, 0)
    assert.equal(reset.childId, null)
    assert.equal(reset.startedAt, null)
    assert.equal(reset.finishedAt, null)
    assert.equal(reset.summary, '')
    assert.equal(reset.error, null)
  }
})

test('restart：先复位再启动，不复用上一次的 childId/摘要/错误', () => {
  const restarted = applyTransition(sample('blocked'), { type: 'restart' }, { now: NOW + 30 })
  assert.equal(restarted.status, 'in_progress')
  assert.equal(restarted.progress, START_PROGRESS)
  assert.equal(restarted.childId, null)
  assert.equal(restarted.startedAt, NOW + 30)
  assert.equal(restarted.finishedAt, null)
  assert.equal(restarted.summary, '')
  assert.equal(restarted.error, null)
  assert.deepEqual(findEntryViolations(restarted), [])
})

/* ------------------------------------------------------------------ *
 * §5 计划级操作：pause / resume / cancel 的语义是“只动该动的”
 * ------------------------------------------------------------------ */

function planFixture(): StatusEntry[] {
  return [
    withId(sample('pending'), 'T1'),
    withId(sample('in_progress'), 'T2'),
    withId(sample('blocked'), 'T3'),
    withId(sample('done'), 'T4'),
  ]
}

test('pause-round：只把 in_progress 归零，不抹掉 blocked/done 的事实', () => {
  const input = planFixture()
  const out = applyPlanOperation(input, 'pause-round', { now: NOW })
  assert.deepEqual(out[0], input[0])
  assert.equal(out[1].status, 'pending')
  assert.equal(out[1].progress, 0)
  assert.equal(out[1].childId, null)
  assert.equal(out[1].startedAt, null)
  assert.equal(out[1].finishedAt, null)
  assert.equal(out[1].summary, '')
  assert.equal(out[1].error, null)
  assert.deepEqual(out[2], input[2], 'blocked 被错误地洗成了 pending')
  assert.deepEqual(out[3], input[3])

  const stats = computeStats(out)
  assert.equal(stats.inProgress, 0)
  assert.equal(stats.blocked, 1)
  assert.equal(stats.done, 1)
  assert.deepEqual(findStatusViolations(out), [])
  assert.deepEqual(findPhaseViolations('paused', out), [])
})

test('resume：blocked/in_progress 复位为 pending，done 保留，计数不再残留', () => {
  const input = planFixture()
  const out = applyPlanOperation(input, 'resume', { now: NOW })
  assert.equal(out[0].status, 'pending')
  assert.equal(out[1].status, 'pending')
  assert.equal(out[2].status, 'pending')
  assert.equal(out[3].status, 'done')
  assert.equal(out[2].progress, 0)
  assert.equal(out[2].error, null)
  assert.equal(out[2].finishedAt, null)

  const stats = computeStats(out)
  assert.equal(stats.blocked, 0)
  assert.equal(stats.inProgress, 0)
  assert.equal(stats.pending, 3)
  assert.equal(stats.done, 1)
  assert.deepEqual(findStatusViolations(out), [])
})

test('cancel：只归零正在运行的任务，取消不伪造 blocked', () => {
  const out = applyPlanOperation(planFixture(), 'cancel', { now: NOW })
  assert.equal(out[1].status, 'pending')
  assert.equal(out[2].status, 'blocked')
  assert.equal(out[3].status, 'done')
  assert.deepEqual(findStatusViolations(out), [])
  assert.deepEqual(findPhaseViolations('cancelled', out), [])
})

test('所有计划级操作都幂等，且产物满足不变量', () => {
  for (const operation of PLAN_OPERATIONS) {
    const once = applyPlanOperation(planFixture(), operation, { now: NOW })
    const twice = applyPlanOperation(once, operation, { now: NOW })
    assert.deepEqual(findStatusViolations(once), [], `${operation} 产物违反字段规则`)
    assert.deepEqual(twice, once, `${operation} 不幂等`)
  }
})

/* ------------------------------------------------------------------ *
 * §6 不变量：stats / departments / phase 必须与同一份 statuses 一致
 * ------------------------------------------------------------------ */

function statsFixture(): StatusEntry[] {
  return [
    withId(withDepartment(sample('done'), 'eng'), 'T1'),
    withId(withDepartment(sample('blocked'), 'eng'), 'T2'),
    withId(withDepartment(sample('in_progress'), 'qa'), 'T3'),
    withId(withDepartment(sample('pending'), 'qa'), 'T4'),
  ]
}

const DEPARTMENTS = [
  { id: 'eng', total: 2, done: 1, blocked: 1, inProgress: 0 },
  { id: 'qa', total: 2, done: 0, blocked: 0, inProgress: 1 },
]

test('stats 由同一份 statuses 派生：正确值通过，任一字段漂移都被捕获', () => {
  const statuses = statsFixture()
  const stats = computeStats(statuses)
  assert.deepEqual(findStatsViolations(statuses, stats), [])
  assert.deepEqual(collectViolations({ statuses, stats, departments: DEPARTMENTS, phase: 'executing' }), [])

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...stats, blocked: stats.blocked + 1 }, 'stats.blocked'],
    [{ ...stats, inProgress: 0 }, 'stats.inProgress'],
    [{ ...stats, done: 99 }, 'stats.done'],
    [{ ...stats, pending: 0 }, 'stats.pending'],
    [{ ...stats, total: 99 }, 'stats.total'],
    [{ ...stats, progress: stats.progress + 1 }, 'stats.progress'],
  ]
  for (const [broken, code] of cases) {
    const codes = findStatsViolations(statuses, broken).map((item) => item.code)
    assert.ok(codes.includes(code), `期望 ${code}，实际 ${codes.join(',')}`)
  }
})

test('stats 必须逐项等于 computeStats(statuses)，不能是缓存快照（D1/D2/D4）', () => {
  const statuses = statsFixture()
  const stale = { total: 4, done: 1, blocked: 1, inProgress: 0, pending: 2, progress: 10 }
  const codes = findStatsViolations(statuses, stale).map((item) => item.code)
  assert.ok(codes.includes('stats.inProgress'))
  assert.ok(codes.includes('stats.pending'))
  assert.ok(codes.includes('stats.progress'))
  assert.deepEqual(findStatsViolations(statuses, computeStats(normaliseStatuses(statuses))), [])
})

test('departments 与 stats 同源：任一部门计数漂移、增删部门都被捕获', () => {
  const statuses = statsFixture()
  assert.deepEqual(findDepartmentViolations(statuses, DEPARTMENTS), [])

  const wrong = DEPARTMENTS.map((item) => (item.id === 'qa' ? { ...item, inProgress: 0 } : item))
  assert.ok(findDepartmentViolations(statuses, wrong).some((item) => item.code === 'departments.inProgress'))
  assert.ok(
    findDepartmentViolations(statuses, [...DEPARTMENTS, { id: 'ops', total: 0, done: 0, blocked: 0, inProgress: 0 }]).some(
      (item) => item.code === 'departments.extra',
    ),
  )
  assert.ok(findDepartmentViolations(statuses, [DEPARTMENTS[0]]).some((item) => item.code === 'departments.missing'))
})

test('phase 与任务集合相容：落定阶段不得仍有任务在运行', () => {
  const allDone = [withId(sample('done'), 'T1'), withId(sample('done'), 'T2')]
  assert.deepEqual(findPhaseViolations('done', allDone), [])
  assert.deepEqual(findPhaseViolations('integrating', allDone), [])

  const running = statsFixture()
  assert.ok(findPhaseViolations('done', running).some((item) => item.code === 'phase.done'))
  for (const phase of ['paused', 'blocked', 'cancelled'] as const) {
    assert.ok(
      findPhaseViolations(phase, running).some((item) => item.code === 'phase.terminal.inProgress'),
      `${phase} 未捕获运行中的任务`,
    )
  }
  assert.ok(findPhaseViolations('pending', [withId(sample('done'), 'T1')]).some((item) => item.code === 'phase.pending'))
  assert.ok(findPhaseViolations('running', allDone).some((item) => item.code === 'phase.invalid'))
  assert.ok(findPhaseViolations('done', []).some((item) => item.code === 'phase.done.empty'))
})

test('planPhase 对已落定的状态集合与不变量相容', () => {
  const cases: StatusEntry[][] = [
    [withId(sample('done'), 'T1'), withId(sample('done'), 'T2')],
    [withId(sample('blocked'), 'T1'), withId(sample('pending'), 'T2')],
    [withId(sample('in_progress'), 'T1'), withId(sample('pending'), 'T2')],
    [withId(sample('pending'), 'T1')],
  ]
  for (const statuses of cases) {
    assert.deepEqual(findPhaseViolations(planPhase(statuses), statuses), [])
  }
  assert.equal(planPhase([withId(sample('done'), 'T1')]), 'integrating')
  assert.equal(planPhase([withId(sample('done'), 'T1')], true), 'done')
})

test('assertInvariants 汇聚全部违规并抛出 InvariantError', () => {
  const statuses = statsFixture()
  const dirty = { ...computeStats(statuses), done: 99 }
  assert.throws(
    () => assertInvariants({ statuses, stats: dirty, departments: DEPARTMENTS, phase: 'done' }),
    (error: unknown) =>
      error instanceof InvariantError &&
      error.violations.some((item) => item.code === 'stats.done') &&
      error.violations.some((item) => item.code === 'phase.done') &&
      error.message.includes('stats.done'),
  )
})

/* ------------------------------------------------------------------ *
 * §7 计划阶段状态机
 * ------------------------------------------------------------------ */

test('phase 主路径：pending → planning → executing → paused → executing → blocked → integrating → done', () => {
  let phase: PlanPhase = 'pending'
  phase = applyPhaseEvent(phase, 'defer')
  assert.equal(phase, 'planning')
  phase = applyPhaseEvent(phase, 'dispatch')
  assert.equal(phase, 'executing')
  phase = applyPhaseEvent(phase, 'round-paused')
  assert.equal(phase, 'paused')
  phase = applyPhaseEvent(phase, 'dispatch')
  assert.equal(phase, 'executing')
  phase = applyPhaseEvent(phase, 'round-blocked')
  assert.equal(phase, 'blocked')
  phase = applyPhaseEvent(phase, 'dispatch')
  assert.equal(phase, 'executing')
  phase = applyPhaseEvent(phase, 'round-completed')
  assert.equal(phase, 'integrating')
  phase = applyPhaseEvent(phase, 'result-written')
  assert.equal(phase, 'done')
})

test('phase 旁路：取消、降级、手动完成全部、终态封闭', () => {
  for (const phase of ['pending', 'planning', 'executing', 'paused', 'blocked', 'integrating'] as const) {
    assert.equal(applyPhaseEvent(phase, 'cancel'), 'cancelled')
  }
  assert.equal(applyPhaseEvent('pending', 'degrade'), 'degraded')
  assert.equal(applyPhaseEvent('planning', 'degrade'), 'degraded')
  assert.equal(applyPhaseEvent('executing', 'manual-completed-all'), 'integrating')
  assert.equal(applyPhaseEvent('blocked', 'manual-completed-all'), 'integrating')
  assert.equal(applyPhaseEvent('integrating', 'result-written'), 'done')

  assert.deepEqual(allowedPhaseEvents('done'), [])
  assert.deepEqual(allowedPhaseEvents('cancelled'), [])
  assert.deepEqual(allowedPhaseEvents('degraded'), [])
  for (const phase of ['done', 'cancelled', 'degraded'] as const) {
    assert.throws(() => applyPhaseEvent(phase, 'dispatch'), IllegalPhaseTransitionError)
  }
  assert.throws(() => applyPhaseEvent('executing', 'result-written'), IllegalPhaseTransitionError)
})

test('phase 矩阵覆盖 9 个阶段 × 9 个事件，无第三种结果', () => {
  let legal = 0
  for (const phase of PLAN_PHASES) {
    for (const event of PLAN_PHASE_EVENTS) {
      try {
        const next = applyPhaseEvent(phase, event)
        legal += 1
        assert.ok(isPlanPhase(next), `phase 迁移产生了非法阶段：${String(next)}`)
      } catch (error) {
        assert.ok(
          error instanceof IllegalPhaseTransitionError,
          `${phase} × ${event} 抛出了非契约错误：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  const allowedTotal = PLAN_PHASES.reduce((sum, phase) => sum + allowedPhaseEvents(phase).length, 0)
  assert.equal(legal, allowedTotal)
})

test('phase 输入校验：未知阶段/事件明确报错', () => {
  assert.throws(
    () => applyPhaseEvent('running', 'dispatch'),
    (error: unknown) => error instanceof StateMachineError && error.code === 'INVALID_PHASE',
  )
  assert.throws(
    () => applyPhaseEvent('pending', 'launch'),
    (error: unknown) => error instanceof StateMachineError && error.code === 'INVALID_PHASE_EVENT',
  )
  assert.equal(isSubtaskStatus('pending'), true)
  assert.equal(isSubtaskStatus('running'), false)
})

/* ------------------------------------------------------------------ *
 * §8 直接复刻 T2 的三个真实缺陷输入
 * ------------------------------------------------------------------ */

test('D3 复刻：预算暂停的 pending+progress=100+childId 被归一化并被断言拦截', () => {
  const dirty = base({
    status: 'pending',
    progress: 100,
    childId: 'child-hang',
    startedAt: NOW,
    finishedAt: null,
    summary: '',
    error: '本轮预算用尽，等待续跑',
  })
  const codes = findEntryViolations(dirty).map((item) => item.code)
  assert.ok(codes.includes('pending.progress'))
  assert.ok(codes.includes('pending.childId'))
  assert.ok(codes.includes('pending.startedAt'))
  assert.ok(codes.includes('pending.error'))

  const clean = normaliseEntry(dirty, { now: NOW })
  const stats = computeStats([clean])
  assert.equal(clean.progress, 0)
  assert.equal(clean.childId, null)
  assert.equal(stats.progress, 0)
  assert.equal(stats.done, 0)
  assert.deepEqual(collectViolations({ statuses: [clean], stats, phase: 'paused' }), [])
})

test('D4 复刻：resume 后 blocked 计数必须归零，且不允许残留 in_progress 字段', () => {
  const before = [withId(sample('blocked'), 'T1'), withId(sample('blocked'), 'T2')]
  assert.equal(computeStats(before).blocked, 2)

  const after = applyPlanOperation(before, 'resume', { now: NOW })
  const stats = computeStats(after)
  assert.equal(stats.blocked, 0)
  assert.equal(stats.inProgress, 0)
  assert.equal(stats.pending, 2)
  assert.deepEqual(findStatusViolations(after), [])
  assert.deepEqual(collectViolations({ statuses: after, stats, phase: 'executing' }), [])
})

test('D1/D2 复刻：mid-wave 状态与派生 stats 只可能来自同一份数组', () => {
  const statuses = [
    withId(sample('done'), 'T1'),
    withId(sample('done'), 'T2'),
    withId({ ...sample('in_progress'), progress: 10 }, 'T3'),
  ]
  const stats = computeStats(statuses)
  assert.deepEqual(stats, { total: 3, done: 2, blocked: 0, inProgress: 1, pending: 0, progress: 70 })
  assert.deepEqual(collectViolations({ statuses, stats, phase: 'executing' }), [])

  const snapshot = { total: 3, done: 1, blocked: 0, inProgress: 0, pending: 2, progress: 33 }
  assert.ok(findStatsViolations(statuses, snapshot).length >= 3)
})
