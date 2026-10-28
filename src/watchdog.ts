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
  now?: () => number
}): ProgressWatchdog {
  const clock = input.now ?? (() => Date.now())
  const pollMs = Math.max(10, Math.floor(input.pollMs ?? 2000))
  const startedAt = clock()
  let lastProgress = startedAt
  let lastSeq: number | null = null
  let growth = 0
  let settled = false
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
    const reason = pickTimeoutReason({
      now,
      startedAt,
      lastProgressAt: lastProgress,
      idleMs: Math.max(1, Math.floor(input.idleMs)),
      hardMs: Math.max(1, Math.floor(input.hardMs)),
      progressObservable: lastSeq !== null,
    })
    if (reason) finish(reason)
  }

  timer = setInterval(poll, pollMs)
  timer.unref?.()

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
  }
}
