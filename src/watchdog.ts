/**
 * Timeout policy for one child execution.
 *
 * The rule this module exists to enforce: a child is stopped only when it is
 * demonstrably not making progress, or when it exceeds an absolute ceiling.
 *
 * History that produced this module: `runSubtask` used to race the child
 * against a single 300 000 ms wall-clock timer. A research child that
 * legitimately needed six minutes was recorded as `blocked`, `markDependentsBlocked`
 * then turned that one verdict into a whole plan reporting 0/N complete, and the
 * dashboard offered no recovery — the plan was terminal. Across the recorded
 * sessions that single timer produced every one of the observed child timeouts.
 *
 * Progress is read from the child's own session log (`ctx.sessions.get(id).seq`),
 * which grows with every appended step, tool call and streamed delta. That is a
 * public, non-deprecated accessor, and it is optional: when the child session
 * cannot be observed, only the absolute ceiling applies — never a shorter idle
 * guess, because a false stall would kill healthy work.
 */

/** Why a child execution was stopped early. */
export type TimeoutReason = 'stalled' | 'exhausted' | null

/**
 * Decide whether one child execution has exhausted its budget.
 *
 * Pure function: the watchdog loop only supplies observations.
 *
 * @param input.now - current time in epoch milliseconds.
 * @param input.startedAt - when the current attempt started.
 * @param input.lastProgressAt - last time the child's session log grew.
 * @param input.idleMs - no-progress window that means "wedged".
 * @param input.hardMs - absolute ceiling for one attempt.
 * @param input.progressObservable - whether the child's log can be read at all.
 * @returns `'exhausted'` on the ceiling, `'stalled'` on an idle window, else `null`.
 */
export function pickTimeoutReason(input: {
  now: number
  startedAt: number
  lastProgressAt: number
  idleMs: number
  hardMs: number
  progressObservable: boolean
}): TimeoutReason {
  const { now, startedAt, lastProgressAt, idleMs, hardMs, progressObservable } = input
  if (!Number.isFinite(now) || !Number.isFinite(startedAt)) return null
  if (now - startedAt >= hardMs) return 'exhausted'
  if (progressObservable && Number.isFinite(lastProgressAt) && now - lastProgressAt >= idleMs) {
    return 'stalled'
  }
  return null
}

/**
 * Render any rejection value as readable text.
 *
 * `String(error)` on a plain object yields `[object Object]`; one recorded
 * subtask was blocked with exactly that string, which made the failure
 * undiagnosable from the dashboard and the durable result message.
 *
 * @param value - a rejected value of unknown shape.
 * @returns a non-empty, human-readable description.
 */
export function describeError(value: unknown): string {
  if (value === null || value === undefined) return '未知失败'
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' ? '未知失败' : text
  }
  if (value instanceof Error) {
    const message = typeof value.message === 'string' ? value.message.trim() : ''
    return message !== '' ? message : (value.name || '未知失败')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['message', 'reason', 'error', 'detail']) {
      const field = record[key]
      if (typeof field === 'string' && field.trim() !== '') return field.trim()
      if (field instanceof Error && field.message?.trim()) return field.message.trim()
      if (field && typeof field === 'object') {
        const nested = describeError(field)
        if (nested !== '未知失败' && nested !== '[object Object]') return nested
      }
    }
    try {
      const text = JSON.stringify(value)
      if (typeof text === 'string' && text !== '' && text !== '{}') return text.slice(0, 500)
    } catch {
      // Circular structures have no JSON form; fall through to the constructor name.
    }
    const name = (value as any)?.constructor?.name
    return name ? `未命名错误（${name}）` : '未命名对象错误'
  }
  return String(value)
}

/**
 * Warning window floor: two minutes. The approaching-deadline window is
 * `max(timeoutMs × 0.2, WARN_FLOOR_MS)` (O-4b, design doc §2.3/§2.6 #9).
 */
const WARN_FLOOR_MS = 120_000

/**
 * What `onApproachingDeadline` reports once per armed warning cycle (O-4b).
 *
 * The warning is a signal, never a gate (design doc §5.3「预警是提示，不是拦截」):
 * this module cannot extend anything on its own, and the payload only reports
 * facts so the caller can decide whether to grant `extendMs`.
 */
export interface ApproachingDeadlineInfo {
  /** Which subtask is nearing its ceiling (optional `subtaskId` input; '' when absent). */
  subtaskId: string
  /** Milliseconds left before the current ceiling fires. */
  remainingMs: number
  /** The ceiling currently in force, ms measured from the attempt start. */
  timeoutMs: number
}

/** One live progress watchdog around a single child execution. */
export interface ProgressWatchdog {
  /** Rejects once with the PlanError built by `makeError`; never resolves. */
  readonly fired: Promise<never>
  /** Stop polling. Safe to call more than once. */
  stop(): void
  /** Last time the observed session log grew (or the attempt start). */
  lastProgressAt(): number
  /** How many times the observed session log grew. */
  progressEvents(): number
  /**
   * Push the absolute ceiling (ms from the attempt start) to `newHardMs` and
   * re-arm the one-shot approaching-deadline warning (O-4d). The watchdog never
   * moves the ceiling by itself — only an explicit call here does.
   */
  extend(newHardMs: number): void
  /**
   * Alias of `extend` under the T4/T5 parallel-construction contract name:
   * identical semantics and implementation — new ceiling plus warning re-arm.
   */
  rearmApproachingDeadline(newTimeoutMs: number): void
}

/**
 * Watch one child's session-log growth and reject when it stalls or runs out.
 *
 * @param input.getSeq - reads the child's current event sequence, or undefined when unobservable.
 * @param input.idleMs - no-progress window.
 * @param input.hardMs - absolute ceiling.
 * @param input.pollMs - observation period.
 * @param input.makeError - builds the rejection for the decided reason.
 * @param input.onProgress - called after each observed log growth.
 * @param input.onApproachingDeadline - called once per armed cycle when the
 *   remaining time enters `max(timeoutMs × 0.2, WARN_FLOOR_MS)` before the ceiling (O-4b).
 * @param input.subtaskId - reported back inside `onApproachingDeadline` info (optional).
 * @param input.now - clock, injectable for tests.
 * @returns a watchdog handle.
 */
export function createProgressWatchdog(input: {
  getSeq: () => number | undefined
  idleMs: number
  hardMs: number
  makeError: (reason: Exclude<TimeoutReason, null>) => Error
  pollMs?: number
  onProgress?: (info: { now: number; seq: number; elapsedMs: number }) => void
  onApproachingDeadline?: (info: ApproachingDeadlineInfo) => void
  subtaskId?: string
  now?: () => number
}): ProgressWatchdog {
  const clock = input.now ?? (() => Date.now())
  const pollMs = Math.max(10, Math.floor(input.pollMs ?? 2000))
  const startedAt = clock()
  let lastProgress = startedAt
  let lastSeq: number | null = null
  let growth = 0
  let settled = false
  // [2.2.0][O-4b/O-4d] Absolute ceiling (ms from `startedAt`) currently in
  // force. Only `rearm` below moves it — the warning itself never extends
  // anything, so an un-extended ceiling still settles as `exhausted`.
  let hardMs = Math.max(1, Math.floor(input.hardMs))
  // [2.2.0][O-4b] One-shot warning latch per armed cycle; cleared by `rearm`.
  let warned = false
  let timer: ReturnType<typeof setInterval> | null = null
  let rejectOnce: (error: Error) => void = () => {}

  const fired = new Promise<never>((_resolve, reject) => {
    rejectOnce = reject
  })
  // The caller may await a race in which this promise loses; keep the
  // rejection handled so Node never reports an unhandled rejection.
  fired.catch(() => {})

  const finish = (reason: Exclude<TimeoutReason, null>) => {
    if (settled) return
    settled = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    rejectOnce(input.makeError(reason))
  }

  // [2.2.0][O-4d] 推移绝对上限（自尝试起点计）并重新武装一次性预警。
  // 看门狗自身没有延期能力：只有调用方显式调用才会动上限
  // （design doc §5.3「预警是提示，不是拦截」）。
  const rearm = (newTimeoutMs: number) => {
    if (settled || !Number.isFinite(newTimeoutMs)) return
    hardMs = Math.max(1, Math.floor(newTimeoutMs))
    warned = false
  }

  // [2.2.0][O-4b] 即将超时预警：剩余 ≤ max(timeoutMs × 0.2, WARN_FLOOR_MS)
  // （取大者）且到点之前（remainingMs > 0，D1「到点之前到达」）时触发一次；
  // 同一武装周期内幂等（warned 闩锁），rearm 后按新时限重新武装。
  const warnApproachingDeadline = (now: number) => {
    if (warned || !input.onApproachingDeadline) return
    const remainingMs = hardMs - (now - startedAt)
    if (remainingMs <= 0 || remainingMs > Math.max(hardMs * 0.2, WARN_FLOOR_MS)) return
    warned = true
    try {
      input.onApproachingDeadline({
        subtaskId: input.subtaskId ?? '',
        remainingMs,
        timeoutMs: hardMs,
      })
    } catch {
      // An observer must never break the watchdog.
    }
  }

  const poll = () => {
    if (settled) return
    const now = clock()
    let seq: number | undefined
    try {
      seq = input.getSeq()
    } catch {
      seq = undefined
    }
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      if (lastSeq === null) {
        lastSeq = seq
      } else if (seq > lastSeq) {
        lastSeq = seq
        growth += 1
        lastProgress = now
        try {
          input.onProgress?.({ now, seq, elapsedMs: now - startedAt })
        } catch {
          // An observer must never break the watchdog.
        }
      }
    }
    warnApproachingDeadline(now)
    const reason = pickTimeoutReason({
      now,
      startedAt,
      lastProgressAt: lastProgress,
      idleMs: Math.max(1, Math.floor(input.idleMs)),
      hardMs,
      progressObservable: lastSeq !== null,
    })
    if (reason) finish(reason)
  }

  timer = setInterval(poll, pollMs)
  // [2.2.9][handle-policy] 收束类（T1 报告 R4）：看门狗是卡死子任务的最后收束保证，unref 时
  // 裸循环下看门狗失效。finish()/stop() 均 clearInterval，生命周期与子任务尝试绑定，不会悬挂宿主。

  return {
    fired,
    stop() {
      if (settled) return
      settled = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    lastProgressAt: () => lastProgress,
    progressEvents: () => growth,
    extend: (newHardMs: number) => {
      rearm(newHardMs)
    },
    rearmApproachingDeadline: (newTimeoutMs: number) => {
      rearm(newTimeoutMs)
    },
  }
}
