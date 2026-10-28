/*
 * dsh-workplan — 子任务状态机、重置语义与不变量（单一真相源设计）
 *
 * 设计规则（详见 docs/state-machine-design.md）：
 *
 *  1. `statuses[]` 是唯一事实：每个子任务的状态、进度、时间戳、childId、
 *     摘要与错误只存在于这一处。
 *  2. `stats` / `departments` 永远是派生值：只能由同一份 statuses 快照现算，
 *     不允许缓存、不允许在别处累加（T2 缺陷 D1/D2/D4 的根因）。
 *  3. `phase` 是生命周期状态，只由事件改变（PLAN_PHASE_EVENTS 表）；不得由
 *     序列化层“顺手”改写，也不得用 planPhase() 无条件覆盖。
 *  4. 任何写入必须经过本模块的迁移函数；状态与伴随字段一起写，避免
 *     `pending + progress=100 + childId` 这类自相矛盾的组合。
 *  5. 重置 = 回到初始态：必须同时清空 progress/childId/startedAt/finishedAt/
 *     summary/error 六个伴随字段。
 *  6. 归一化（normalise）只用于读取历史/外部数据；断言（assert）用于写入后与
 *     下发前。顺序固定为“先归一化、再断言”，否则旧数据会误报。
 *
 * 本文件是纯函数模块，不依赖 runtime / client，便于被任何一侧复用与测试。
 */

/** 子任务的四个合法状态。顺序即 UI 的展示顺序。 */
export const SUBTASK_STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number]

/** 计划生命周期的九个合法阶段（与 docs/status-grouping-ia.md 的九值一致）。 */
export const PLAN_PHASES = [
  'pending',
  'planning',
  'executing',
  'integrating',
  'paused',
  'blocked',
  'degraded',
  'cancelled',
  'done',
] as const
export type PlanPhase = (typeof PLAN_PHASES)[number]

/** 刚启动时的进度（沿用 1.4.x 行为：先给 5%，再在子 Agent 绑定后到 10%）。 */
export const START_PROGRESS = 5
/** 子 Agent 绑定成功后的进度。 */
export const ATTACH_PROGRESS = 10
/** blocked 却没有任何可读原因时的兜底文案（保证“受阻必有原因”不变量）。 */
export const BLOCKED_REASON_FALLBACK = '受阻（未记录原因）'

const STATUS_SET: ReadonlySet<string> = new Set<string>(SUBTASK_STATUSES)
const PHASE_SET: ReadonlySet<string> = new Set<string>(PLAN_PHASES)

export function isSubtaskStatus(value: unknown): value is SubtaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

export function isPlanPhase(value: unknown): value is PlanPhase {
  return typeof value === 'string' && PHASE_SET.has(value)
}

/**
 * 一个子任务的规范形态。
 *
 * 允许携带额外字段（stageId/title/department/role/evidence…），迁移与归一化
 * 会原样保留，避免状态层成为 schema 的第二真相源。
 */
export interface StatusEntry {
  subtaskId: string
  status: SubtaskStatus
  progress: number
  childId: string | null
  startedAt: number | null
  finishedAt: number | null
  summary: string
  error: string | null
  [extra: string]: unknown
}

export interface TransitionOptions {
  /** 注入“当前时间”，测试与回放必须显式传入以保证确定性。 */
  now?: number
}

export class StateMachineError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'StateMachineError'
    this.code = code
  }
}

export class InvalidEntryError extends StateMachineError {
  constructor(message: string) {
    super(message, 'INVALID_ENTRY')
    this.name = 'InvalidEntryError'
  }
}

export class IllegalTransitionError extends StateMachineError {
  readonly subtaskId: string
  readonly from: SubtaskStatus
  readonly action: TransitionType

  constructor(subtaskId: string, from: SubtaskStatus, action: TransitionType, allowed: readonly SubtaskStatus[]) {
    const allowedText = allowed.length > 0 ? allowed.join(' / ') : '无'
    super(
      `子任务 ${subtaskId} 当前为 ${from}，不允许执行 ${action}（允许的来源状态：${allowedText}）`,
      'ILLEGAL_TRANSITION',
    )
    this.name = 'IllegalTransitionError'
    this.subtaskId = subtaskId
    this.from = from
    this.action = action
  }
}

export class IllegalPhaseTransitionError extends StateMachineError {
  readonly phase: PlanPhase
  readonly event: PlanPhaseEvent

  constructor(phase: PlanPhase, event: PlanPhaseEvent) {
    super(`计划阶段 ${phase} 不接受事件 ${event}`, 'ILLEGAL_PHASE_TRANSITION')
    this.name = 'IllegalPhaseTransitionError'
    this.phase = phase
    this.event = event
  }
}

export interface InvariantViolation {
  /** 稳定的机器可读代码，例如 `pending.progress`、`stats.blocked`。 */
  code: string
  subtaskId: string | null
  detail: string
}

export class InvariantError extends StateMachineError {
  readonly violations: InvariantViolation[]

  constructor(violations: InvariantViolation[]) {
    const head = violations
      .slice(0, 8)
      .map((item) => `${item.code}${item.subtaskId ? `(${item.subtaskId})` : ''}: ${item.detail}`)
      .join('；')
    super(`状态不变量被破坏（${violations.length} 处）：${head}`, 'INVARIANT_VIOLATION')
    this.name = 'InvariantError'
    this.violations = violations
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clampProgress(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(max, Math.max(0, Math.round(value)))
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function childIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function timestampOrNull(value: unknown): number | null {
  return isTimestamp(value) ? value : null
}

/**
 * 把任意输入归一化为规范形态。
 *
 * 该函数只做“修复”，不做“校验”：它会把历史脏数据收敛到合法组合，
 * 供读取/回放路径使用；写入路径应使用 applyTransition，它保证输入合法。
 *
 * 修复规则（与设计文档 §3.1 一一对应）：
 *  - pending：清空全部六个伴随字段；
 *  - in_progress：进度封顶 99，清 finishedAt/error，缺 startedAt 时补 now；
 *  - done：进度固定 100，清 error，缺 finishedAt 时补 now；
 *  - blocked：进度封顶 99，缺 finishedAt 时补 now，缺 error 时用 summary 兜底。
 */
export function normaliseEntry(entry: unknown, options?: TransitionOptions): StatusEntry {
  if (!isRecord(entry)) throw new InvalidEntryError('状态项必须是对象')
  const subtaskId = typeof entry.subtaskId === 'string' ? entry.subtaskId.trim() : ''
  if (!subtaskId) throw new InvalidEntryError('subtaskId 必须是非空字符串')
  if (!isSubtaskStatus(entry.status)) {
    throw new InvalidEntryError(`子任务 ${subtaskId} 的 status 非法：${String(entry.status)}`)
  }
  const now = options?.now ?? Date.now()
  if (!isTimestamp(now)) throw new StateMachineError('now 必须是有限数字', 'INVALID_TIMESTAMP')
  const status = entry.status
  const canonical: StatusEntry = {
    ...entry,
    subtaskId,
    status,
    progress: clampProgress(entry.progress, 100),
    childId: childIdOrNull(entry.childId),
    startedAt: timestampOrNull(entry.startedAt),
    finishedAt: timestampOrNull(entry.finishedAt),
    summary: textOrEmpty(entry.summary),
    error: nonEmptyText(entry.error),
  }

  switch (status) {
    case 'pending':
      canonical.progress = 0
      canonical.childId = null
      canonical.startedAt = null
      canonical.finishedAt = null
      canonical.summary = ''
      canonical.error = null
      break
    case 'in_progress':
      canonical.progress = Math.min(canonical.progress, 99)
      canonical.finishedAt = null
      canonical.error = null
      canonical.startedAt = canonical.startedAt ?? now
      break
    case 'done':
      canonical.progress = 100
      canonical.error = null
      canonical.finishedAt = canonical.finishedAt ?? now
      break
    case 'blocked':
      canonical.progress = Math.min(canonical.progress, 99)
      canonical.finishedAt = canonical.finishedAt ?? now
      canonical.error = canonical.error ?? nonEmptyText(canonical.summary) ?? BLOCKED_REASON_FALLBACK
      break
  }

  return canonical
}

export function normaliseStatuses(statuses: readonly unknown[], options?: TransitionOptions): StatusEntry[] {
  if (!Array.isArray(statuses)) {
    throw new StateMachineError('statuses 必须是数组', 'INVALID_STATUSES')
  }
  return statuses.map((entry) => normaliseEntry(entry, options))
}

/** 迁移动作。每个动作只能从特定状态出发（见 ALLOWED_TRANSITIONS）。 */
export type TransitionType =
  | 'start'
  | 'bind-child'
  | 'report-progress'
  | 'complete'
  | 'fail'
  | 'reset'
  | 'restart'

export const TRANSITION_TYPES = [
  'start',
  'bind-child',
  'report-progress',
  'complete',
  'fail',
  'reset',
  'restart',
] as const satisfies readonly TransitionType[]

export type Transition =
  | { type: 'start'; progress?: number; at?: number }
  | { type: 'bind-child'; childId: string; progress?: number }
  | { type: 'report-progress'; progress: number }
  | { type: 'complete'; summary?: string; at?: number }
  | { type: 'fail'; error: string; summary?: string; at?: number }
  | { type: 'reset' }
  | { type: 'restart'; progress?: number; at?: number }

/**
 * 合法来源状态表（迁移矩阵的唯一实现点）。
 *
 *  - `start`            ：只有 pending 可以启动；blocked/done 必须先 reset/restart。
 *  - `bind-child`       ：只有运行中的任务可以绑定子 Agent。
 *  - `report-progress`  ：只有运行中的任务可以报进度；100% 只能由 complete 写。
 *  - `complete`         ：运行中或重复完成（幂等补写摘要）；不直接重开已完成任务。
 *  - `fail`             ：pending（主 Agent 直接判负）/运行中/重复受阻。
 *  - `reset`            ：四个状态都可回到初始态（幂等）。
 *  - `restart`          ：四个状态都可复位后立刻重跑。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TransitionType, readonly SubtaskStatus[]>> = {
  start: ['pending'],
  'bind-child': ['in_progress'],
  'report-progress': ['in_progress'],
  complete: ['in_progress', 'done'],
  fail: ['pending', 'in_progress', 'blocked'],
  reset: ['pending', 'in_progress', 'done', 'blocked'],
  restart: ['pending', 'in_progress', 'done', 'blocked'],
}

export function allowedSourceStatuses(type: TransitionType): readonly SubtaskStatus[] {
  return ALLOWED_TRANSITIONS[type]
}

function requireProgress(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 99) {
    throw new StateMachineError(
      `progress 必须是 0-99 之间的整数（100 只属于 done），收到 ${String(value)}`,
      'INVALID_PROGRESS',
    )
  }
  return value
}

function requireTimestamp(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (!isTimestamp(value)) {
    throw new StateMachineError(`时间戳必须是有限数字，收到 ${String(value)}`, 'INVALID_TIMESTAMP')
  }
  return value
}

function requireChildId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new StateMachineError('childId 必须是非空字符串', 'INVALID_CHILD_ID')
  return id
}

function requireReason(value: unknown): string {
  const reason = nonEmptyText(value)
  if (!reason) throw new StateMachineError('fail 必须给出非空的 error 原因', 'MISSING_REASON')
  return reason
}

function startEntry(source: StatusEntry, progress: number, at: number): StatusEntry {
  return {
    ...source,
    status: 'in_progress',
    progress,
    childId: null,
    startedAt: at,
    finishedAt: null,
    summary: '',
    error: null,
  }
}

function resetEntry(source: StatusEntry): StatusEntry {
  return {
    ...source,
    status: 'pending',
    progress: 0,
    childId: null,
    startedAt: null,
    finishedAt: null,
    summary: '',
    error: null,
  }
}

function completeEntry(source: StatusEntry, summary: string | undefined, finishedAt: number): StatusEntry {
  if (summary !== undefined && typeof summary !== 'string') {
    throw new StateMachineError('complete 的 summary 必须是字符串', 'INVALID_TEXT')
  }
  return {
    ...source,
    status: 'done',
    progress: 100,
    finishedAt,
    error: null,
    summary: summary === undefined ? source.summary : summary,
  }
}

function failEntry(source: StatusEntry, error: string, summary: string | undefined, finishedAt: number): StatusEntry {
  if (summary !== undefined && typeof summary !== 'string') {
    throw new StateMachineError('fail 的 summary 必须是字符串', 'INVALID_TEXT')
  }
  return {
    ...source,
    status: 'blocked',
    progress: Math.min(source.progress, 99),
    finishedAt,
    error: requireReason(error),
    summary: summary === undefined ? source.summary : summary,
  }
}

/**
 * 执行一次状态迁移。输入必须是合法状态项（不合法会抛 InvalidEntryError），
 * 迁移本身非法会抛 IllegalTransitionError——两者都必须被调用方当作契约错误，
 * 而不是静默吞掉。
 */
export function applyTransition(entry: unknown, transition: Transition, options?: TransitionOptions): StatusEntry {
  if (!isRecord(transition) || !isTransitionType(transition.type)) {
    throw new StateMachineError(`未知的迁移动作：${String((transition as { type?: unknown })?.type)}`, 'INVALID_TRANSITION')
  }
  const now = options?.now ?? Date.now()
  const source = normaliseEntry(entry, { now })
  const allowed = ALLOWED_TRANSITIONS[transition.type]
  if (!allowed.includes(source.status)) {
    throw new IllegalTransitionError(source.subtaskId, source.status, transition.type, allowed)
  }

  let next: StatusEntry
  switch (transition.type) {
    case 'start':
      next = startEntry(source, requireProgress(transition.progress, START_PROGRESS), requireTimestamp(transition.at, now))
      break
    case 'bind-child':
      next = {
        ...source,
        childId: requireChildId(transition.childId),
        progress: Math.max(source.progress, requireProgress(transition.progress, ATTACH_PROGRESS)),
      }
      break
    case 'report-progress':
      next = { ...source, progress: requireProgress(transition.progress, source.progress) }
      break
    case 'complete':
      next = completeEntry(source, transition.summary, requireTimestamp(transition.at, source.finishedAt ?? now))
      break
    case 'fail':
      next = failEntry(source, transition.error, transition.summary, requireTimestamp(transition.at, source.finishedAt ?? now))
      break
    case 'reset':
      next = resetEntry(source)
      break
    case 'restart': {
      const at = requireTimestamp(transition.at, now)
      next = startEntry(resetEntry(source), requireProgress(transition.progress, START_PROGRESS), at)
      break
    }
  }

  return normaliseEntry(next, { now })
}

function isTransitionType(value: unknown): value is TransitionType {
  return typeof value === 'string' && (TRANSITION_TYPES as readonly string[]).includes(value)
}

/**
 * 计划级操作：一次性、原子地把一组任务带入某个语义状态。
 *
 * 与单个任务迁移的区别：这些操作表达“整轮结束/续跑/取消”的产品语义，
 * 必须统一入口，禁止在 runtime 里手写 map 改状态（T2 缺陷 D3 的根因）。
 *
 *  - `pause-round`：预算切片结束。只把 in_progress 归零为 pending；
 *    blocked/done/pending 原样保留（1.4.x 会把 blocked 也洗成 pending，
 *    丢失“受阻”这一事实，属于语义回归）。
 *  - `resume`：续跑前复位。blocked/in_progress → pending；done/pending 保留。
 *  - `cancel`：取消。只把正在运行的任务归零，未开始/已完成原样保留；
 *    取消是计划级结论，不把任务伪造成 blocked。
 *  - `normalise`：只归一化，不改语义（读取旧数据时使用）。
 */
export type PlanOperation = 'pause-round' | 'resume' | 'cancel' | 'normalise'

export const PLAN_OPERATIONS = ['pause-round', 'resume', 'cancel', 'normalise'] as const satisfies readonly PlanOperation[]

export function applyPlanOperation(
  statuses: readonly unknown[],
  operation: PlanOperation,
  options?: TransitionOptions,
): StatusEntry[] {
  if (!Array.isArray(statuses)) {
    throw new StateMachineError('statuses 必须是数组', 'INVALID_STATUSES')
  }
  const now = options?.now ?? Date.now()
  return statuses.map((entry) => {
    const current = normaliseEntry(entry, { now })
    switch (operation) {
      case 'pause-round':
      case 'cancel':
        return current.status === 'in_progress' ? resetEntry(current) : current
      case 'resume':
        return current.status === 'blocked' || current.status === 'in_progress' ? resetEntry(current) : current
      case 'normalise':
        return current
      default:
        throw new StateMachineError(`未知的计划级操作：${String(operation)}`, 'INVALID_PLAN_OPERATION')
    }
  })
}

/* ------------------------------------------------------------------ *
 * 不变量：可被测试与 CI 直接断言，不依赖人工判断
 * ------------------------------------------------------------------ */

function violation(code: string, subtaskId: string | null, detail: string): InvariantViolation {
  return { code, subtaskId, detail }
}

/**
 * 检查单个状态项的字段组合。
 *
 * 这里故意不归一化：不变量必须能发现“写入方写错了”，而不是替写入方掩盖。
 */
export function findEntryViolations(entry: unknown): InvariantViolation[] {
  if (!isRecord(entry)) return [violation('entry.type', null, '状态项必须是对象')]

  const violations: InvariantViolation[] = []
  const subtaskId = typeof entry.subtaskId === 'string' && entry.subtaskId.trim() !== '' ? entry.subtaskId : null
  const add = (code: string, detail: string): void => {
    violations.push(violation(code, subtaskId, detail))
  }

  if (!subtaskId) add('subtask.id', `subtaskId 必须是非空字符串（收到 ${JSON.stringify(entry.subtaskId)}）`)
  if (!isSubtaskStatus(entry.status)) {
    add('status.invalid', `status 必须是 ${SUBTASK_STATUSES.join(' / ')} 之一（收到 ${JSON.stringify(entry.status)}）`)
    return violations
  }
  const status = entry.status

  const progress = entry.progress
  if (typeof progress !== 'number' || !Number.isInteger(progress) || progress < 0 || progress > 100) {
    add('progress.invalid', `progress 必须是 0-100 的整数（收到 ${JSON.stringify(progress)}）`)
  }
  const progressIsInt = typeof progress === 'number' && Number.isInteger(progress)

  const childId = entry.childId
  if (!(childId === null || (typeof childId === 'string' && childId !== ''))) {
    add('childId.invalid', `childId 必须是 null 或非空字符串（收到 ${JSON.stringify(childId)}）`)
  }

  const startedAt = entry.startedAt
  if (!(startedAt === null || isTimestamp(startedAt))) {
    add('startedAt.invalid', `startedAt 必须是 null 或有限数字（收到 ${JSON.stringify(startedAt)}）`)
  }
  const finishedAt = entry.finishedAt
  if (!(finishedAt === null || isTimestamp(finishedAt))) {
    add('finishedAt.invalid', `finishedAt 必须是 null 或有限数字（收到 ${JSON.stringify(finishedAt)}）`)
  }

  const summary = entry.summary
  if (typeof summary !== 'string') {
    add('summary.invalid', `summary 必须是字符串（收到 ${JSON.stringify(summary)}）`)
  }

  const error = entry.error
  if (!(error === null || typeof error === 'string')) {
    add('error.invalid', `error 必须是 null 或字符串（收到 ${JSON.stringify(error)}）`)
  }

  switch (status) {
    case 'pending':
      if (progressIsInt && progress !== 0) add('pending.progress', `pending 的 progress 必须为 0（收到 ${progress}）`)
      if (childId !== null) add('pending.childId', 'pending 不得携带 childId')
      if (startedAt !== null) add('pending.startedAt', 'pending 不得携带 startedAt')
      if (finishedAt !== null) add('pending.finishedAt', 'pending 不得携带 finishedAt')
      if (summary !== '') add('pending.summary', 'pending 的 summary 必须为空')
      if (error !== null) add('pending.error', 'pending 不得携带 error（本轮原因属于计划级，不属于任务）')
      break
    case 'in_progress':
      if (progressIsInt && progress > 99) add('in_progress.progress', `in_progress 的 progress 不得超过 99（收到 ${progress}）`)
      if (finishedAt !== null) add('in_progress.finishedAt', 'in_progress 不得携带 finishedAt')
      if (error !== null) add('in_progress.error', 'in_progress 不得携带 error')
      if (!isTimestamp(startedAt)) add('in_progress.startedAt', 'in_progress 必须携带 startedAt')
      break
    case 'done':
      if (progressIsInt && progress !== 100) add('done.progress', `done 的 progress 必须为 100（收到 ${progress}）`)
      if (!isTimestamp(finishedAt)) add('done.finishedAt', 'done 必须携带 finishedAt')
      if (error !== null) add('done.error', 'done 不得携带 error')
      break
    case 'blocked':
      if (progressIsInt && progress > 99) add('blocked.progress', `blocked 的 progress 不得超过 99（收到 ${progress}）`)
      if (!isTimestamp(finishedAt)) add('blocked.finishedAt', 'blocked 必须携带 finishedAt')
      if (typeof error !== 'string' || error.trim() === '') add('blocked.error', 'blocked 必须携带非空 error 原因')
      break
  }

  return violations
}

/** 检查整组状态项：逐项规则 + subtaskId 唯一。 */
export function findStatusViolations(statuses: unknown): InvariantViolation[] {
  if (!Array.isArray(statuses)) return [violation('statuses.type', null, 'statuses 必须是数组')]
  const violations: InvariantViolation[] = []
  const seen = new Set<string>()
  for (const entry of statuses) {
    violations.push(...findEntryViolations(entry))
    if (isRecord(entry) && typeof entry.subtaskId === 'string' && entry.subtaskId.trim() !== '') {
      if (seen.has(entry.subtaskId)) {
        violations.push(violation('subtask.duplicate', entry.subtaskId, `subtaskId 重复：${entry.subtaskId}`))
      } else {
        seen.add(entry.subtaskId)
      }
    }
  }
  return violations
}

interface Counts {
  total: number
  done: number
  blocked: number
  inProgress: number
  pending: number
  progress: number
}

/**
 * 计数的独立实现（不调用 computeStats）。
 *
 * 它是不变量的“第二实现”，用来证明 runtime 下发的 stats 确实等于
 * 同一份 statuses 的派生结果；两份实现算法必须一致，否则测试会失败。
 */
function countStatuses(statuses: readonly unknown[]): Counts {
  let done = 0
  let blocked = 0
  let inProgress = 0
  let pending = 0
  let sum = 0
  for (const entry of statuses) {
    if (!isRecord(entry)) continue
    if (entry.status === 'done') done += 1
    else if (entry.status === 'blocked') blocked += 1
    else if (entry.status === 'in_progress') inProgress += 1
    else if (entry.status === 'pending') pending += 1
    const value = typeof entry.progress === 'number' && Number.isFinite(entry.progress) ? entry.progress : 0
    sum += value
  }
  const total = statuses.length
  return {
    total,
    done,
    blocked,
    inProgress,
    pending,
    progress: total === 0 ? 0 : Math.round(sum / total),
  }
}

/** 校验 stats 是否完全由同一份 statuses 派生（D1/D2/D4 的机器门禁）。 */
export function findStatsViolations(statuses: unknown, stats: unknown): InvariantViolation[] {
  const list = Array.isArray(statuses) ? statuses : []
  const expected = countStatuses(list)
  if (!isRecord(stats)) return [violation('stats.type', null, 'stats 必须是对象')]

  const violations: InvariantViolation[] = []
  const fields = ['total', 'done', 'blocked', 'inProgress', 'pending', 'progress'] as const
  for (const field of fields) {
    const actual = stats[field]
    if (actual !== expected[field]) {
      violations.push(
        violation(
          `stats.${field}`,
          null,
          `stats.${field} = ${JSON.stringify(actual)}，但 statuses 派生值为 ${expected[field]}`,
        ),
      )
    }
  }
  return violations
}

interface DepartmentAggregate {
  total: number
  done: number
  blocked: number
  inProgress: number
}

/**
 * 校验 departments 是否与同一份 statuses 一致。
 *
 * 语义与 serialisePlan 一致：pending 不计入任何部门计数，但计入 total。
 */
export function findDepartmentViolations(statuses: unknown, departments: unknown): InvariantViolation[] {
  if (!Array.isArray(statuses)) return [violation('statuses.type', null, 'statuses 必须是数组')]
  if (!Array.isArray(departments)) return [violation('departments.type', null, 'departments 必须是数组')]

  const expected = new Map<string, DepartmentAggregate>()
  for (const entry of statuses) {
    if (!isRecord(entry)) continue
    const key = typeof entry.department === 'string' && entry.department !== '' ? entry.department : ''
    const aggregate = expected.get(key) ?? { total: 0, done: 0, blocked: 0, inProgress: 0 }
    aggregate.total += 1
    if (entry.status === 'done') aggregate.done += 1
    else if (entry.status === 'blocked') aggregate.blocked += 1
    else if (entry.status === 'in_progress') aggregate.inProgress += 1
    expected.set(key, aggregate)
  }

  const violations: InvariantViolation[] = []
  const seen = new Set<string>()
  for (const item of departments) {
    if (!isRecord(item)) {
      violations.push(violation('departments.item', null, '部门条目必须是对象'))
      continue
    }
    const id = typeof item.id === 'string' ? item.id : ''
    seen.add(id)
    const want = expected.get(id)
    if (!want) {
      violations.push(violation('departments.extra', null, `部门 ${JSON.stringify(item.id)} 在 statuses 中不存在`))
      continue
    }
    for (const field of ['total', 'done', 'blocked', 'inProgress'] as const) {
      if (item[field] !== want[field]) {
        violations.push(
          violation(
            `departments.${field}`,
            null,
            `部门 ${id} 的 ${field} = ${JSON.stringify(item[field])}，但 statuses 派生值为 ${want[field]}`,
          ),
        )
      }
    }
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) {
      violations.push(violation('departments.missing', null, `statuses 中的部门 ${JSON.stringify(id)} 未出现在 departments 中`))
    }
  }
  return violations
}

/**
 * 校验计划阶段与任务集合是否相容：
 *  - done / integrating：不允许有未完成任务；
 *  - paused / blocked / cancelled：不允许仍有任务在运行（这些阶段是“已落定”的）；
 *  - pending：不允许已有任何任务离开初始态。
 */
export function findPhaseViolations(phase: unknown, statuses: unknown): InvariantViolation[] {
  if (!isPlanPhase(phase)) return [violation('phase.invalid', null, `未知的计划阶段：${JSON.stringify(phase)}`)]
  const list = Array.isArray(statuses) ? statuses : []
  const counts = countStatuses(list)
  const violations: InvariantViolation[] = []

  if (phase === 'done' || phase === 'integrating') {
    if (counts.total === 0) violations.push(violation('phase.done.empty', null, `${phase} 阶段不应是空计划`))
    if (counts.done !== counts.total) {
      violations.push(
        violation('phase.done', null, `${phase} 阶段仍有 ${counts.total - counts.done} 个任务未完成`),
      )
    }
  }
  if (phase === 'paused' || phase === 'blocked' || phase === 'cancelled') {
    if (counts.inProgress !== 0) {
      violations.push(violation('phase.terminal.inProgress', null, `${phase} 阶段仍有 ${counts.inProgress} 个任务在运行`))
    }
  }
  if (phase === 'pending' && counts.done + counts.inProgress + counts.blocked !== 0) {
    violations.push(violation('phase.pending', null, 'pending 阶段不允许存在已启动/已完成/受阻的任务'))
  }
  return violations
}

export interface InvariantInput {
  statuses: unknown
  stats?: unknown
  departments?: unknown
  phase?: unknown
}

/** 汇总所有启用的不变量检查；空数组表示全部通过。 */
export function collectViolations(input: InvariantInput): InvariantViolation[] {
  const violations = findStatusViolations(input.statuses)
  if (input.stats !== undefined) violations.push(...findStatsViolations(input.statuses, input.stats))
  if (input.departments !== undefined) violations.push(...findDepartmentViolations(input.statuses, input.departments))
  if (input.phase !== undefined) violations.push(...findPhaseViolations(input.phase, input.statuses))
  return violations
}

/** 断言所有启用的不变量；失败抛出 InvariantError，附带完整违规清单。 */
export function assertInvariants(input: InvariantInput): void {
  const violations = collectViolations(input)
  if (violations.length > 0) throw new InvariantError(violations)
}

/* ------------------------------------------------------------------ *
 * 计划阶段（phase）状态机
 * ------------------------------------------------------------------ */

/** 计划阶段事件。命名与 runtime 的进入路径一一对应。 */
export type PlanPhaseEvent =
  | 'defer' // plan 模式下延迟派发：pending → planning
  | 'dispatch' // 开始一轮执行：pending/planning/paused/blocked → executing
  | 'round-paused' // 预算切片结束：executing → paused
  | 'round-blocked' // 本轮有任务受阻且已落定：executing → blocked
  | 'round-completed' // 本轮全部完成但结果未写入：executing → integrating
  | 'manual-completed-all' // 主 Agent 手动把最后一项做完：executing/blocked → integrating
  | 'result-written' // 结果消息已写入：integrating → done
  | 'cancel' // 任意可取消阶段 → cancelled
  | 'degrade' // 计划不可生成：pending/planning → degraded

export const PLAN_PHASE_EVENTS = [
  'defer',
  'dispatch',
  'round-paused',
  'round-blocked',
  'round-completed',
  'manual-completed-all',
  'result-written',
  'cancel',
  'degrade',
] as const satisfies readonly PlanPhaseEvent[]

const PHASE_TRANSITIONS: Readonly<Record<PlanPhase, Readonly<Partial<Record<PlanPhaseEvent, PlanPhase>>>>> = {
  pending: { defer: 'planning', dispatch: 'executing', cancel: 'cancelled', degrade: 'degraded' },
  planning: { dispatch: 'executing', cancel: 'cancelled', degrade: 'degraded' },
  executing: {
    'round-paused': 'paused',
    'round-blocked': 'blocked',
    'round-completed': 'integrating',
    'manual-completed-all': 'integrating',
    cancel: 'cancelled',
  },
  paused: { dispatch: 'executing', cancel: 'cancelled' },
  blocked: { dispatch: 'executing', 'manual-completed-all': 'integrating', cancel: 'cancelled' },
  integrating: { 'result-written': 'done', cancel: 'cancelled' },
  degraded: {},
  cancelled: {},
  done: {},
}

const EVENT_SET: ReadonlySet<string> = new Set<string>(PLAN_PHASE_EVENTS)

export function isPlanPhaseEvent(value: unknown): value is PlanPhaseEvent {
  return typeof value === 'string' && EVENT_SET.has(value)
}

export function allowedPhaseEvents(phase: PlanPhase): PlanPhaseEvent[] {
  return Object.keys(PHASE_TRANSITIONS[phase]) as PlanPhaseEvent[]
}

/**
 * 执行一次阶段迁移；非法输入或非法迁移都抛错，禁止用 `?? fallback` 吞掉。
 */
export function applyPhaseEvent(phase: unknown, event: unknown): PlanPhase {
  if (!isPlanPhase(phase)) throw new StateMachineError(`未知的计划阶段：${String(phase)}`, 'INVALID_PHASE')
  if (!isPlanPhaseEvent(event)) throw new StateMachineError(`未知的阶段事件：${String(event)}`, 'INVALID_PHASE_EVENT')
  const next = PHASE_TRANSITIONS[phase][event]
  if (!next) throw new IllegalPhaseTransitionError(phase, event)
  return next
}
