/**
 * [1.10.4][auto-resume] Automatic continuation of a plan whose round budget ran out.
 *
 * Why this module exists
 * ----------------------
 * The 2026-11-01 incident: subtask T12 was killed by the whole-round budget
 * (`TOTAL_TIMEOUT`, 20 min) at 15:31:26, reset to `pending`, and then **never
 * ran again** — the plan stayed `paused` until a human dispatched it 24 minutes
 * later. `shouldRetryAttempt()` is right to refuse `ABORTED`/`TOTAL_TIMEOUT`
 * *inside* a round: that round has no budget left, so a retry would be cut by
 * the same blade. The missing layer is not "retry the child"; it is
 * "start the next round" — a new deadline, the same plan, and `done` work
 * never re-run.
 *
 * This module owns only the decision table (`should we continue?`). It is a
 * pure function with no timer, no I/O and no record mutation, so every branch
 * can be pinned by a unit test without mounting the host. The runtime supplies
 * the bookkeeping; `src/runtime.ts` owns the timer.
 *
 * Safety stance (the reason it is more than a loop)
 * -------------------------------------------------
 * Automatic recovery must never manufacture a green result. Therefore:
 *  - it only ever continues a `paused` plan; `blocked` means a real failure and
 *    is repaired by a human adjudication or the resume budget, never silently;
 *  - `done` rows are never re-run (the resumer calls `resetBlockedStatuses`,
 *    which only clears blocked/in_progress, and a paused round leaves them
 *    `pending`);
 *  - it never adjudicates evidence: every continuation goes through the normal
 *    child path (`settleFromOutput` → `deliveryReadiness`), so "all done" is
 *    still decided by structured evidence;
 *  - "all done but evidence gaps" stops here on purpose (`NOTHING_PENDING`):
 *    re-running a done subtask cannot fix a missing acceptance item, it only
 *    produces duplicate work and a chance to overwrite the evidence.
 *
 * Default: **on**. `AUTO_RESUME_DEFAULTS.enabled = true`; turn it off with
 * profile `autoResume: false` or `DSH_WORKPLAN_AUTO_RESUME=0`.
 */

/** Tunables that are policy, not deployment config. */
export const AUTO_RESUME_DEFAULTS = Object.freeze({
  /**
   * [1.10.6] On by default.
   *
   * The 2026-11-01 user verdict on the previous "off by default" stance was
   * unambiguous: a subtask killed by the round budget sat untouched for 1h57m
   * and the only reason was a flag nobody had been told to flip. A recovery
   * feature that ships silent is indistinguishable from a missing one.
   *
   * Every safety branch below still applies when this is on (cancel, plan mode,
   * blocked rows, no-progress, attempt cap), and `autoResume: false` in the
   * profile or `DSH_WORKPLAN_AUTO_RESUME=0` turns it off for one deployment.
   */
  enabled: true,
  /** How many continuation rounds one plan may start without a human. */
  maxAttempts: 2,
  /** Delay before the first continuation round. */
  baseDelayMs: 30_000,
  /** Upper bound of the exponential backoff. */
  maxDelayMs: 300_000,
  /** Consecutive continuation rounds that completed no new subtask before stopping. */
  stallLimit: 1,
})

/** Hard cap for a configured attempt budget (0 disables the chain). */
export const AUTO_RESUME_MAX_ATTEMPTS_CAP = 4

/**
 * Clamp a configured attempt budget.
 *
 * Non-numeric input falls back to the default instead of disabling the feature
 * silently; only an explicit in-range number is honoured.
 *
 * @param value - configured value, if any.
 * @returns an integer within `[0, AUTO_RESUME_MAX_ATTEMPTS_CAP]`.
 */
export function autoResumeAttemptCap(value: any) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return AUTO_RESUME_DEFAULTS.maxAttempts
  return Math.min(AUTO_RESUME_MAX_ATTEMPTS_CAP, Math.max(0, Math.floor(numeric)))
}

/**
 * [1.10.6] Resolve the feature flag from profile config + environment.
 *
 * Explicit config wins; an explicit environment value wins over the default;
 * anything unset falls back to `AUTO_RESUME_DEFAULTS.enabled` (now true).
 * Values are read the same way for both sources so `0/false/no/off` turn it off
 * instead of being treated as "present, therefore on".
 *
 * @param configValue - `autoResume` from the profile config, if any.
 * @param envValue - `DSH_WORKPLAN_AUTO_RESUME`, if set.
 * @returns whether automatic continuation rounds are allowed.
 */
export function autoResumeEnabledFrom(configValue: any, envValue: any) {
  if (typeof configValue === 'boolean') return configValue
  const raw = envValue === undefined || envValue === null ? '' : String(envValue).trim()
  if (raw !== '') {
    if (/^(1|true|yes|on)$/i.test(raw)) return true
    if (/^(0|false|no|off)$/i.test(raw)) return false
  }
  return AUTO_RESUME_DEFAULTS.enabled === true
}

/**
 * [1.12.0] Count the rows that still participate in scheduling.
 *
 * A `closure:'replanned'` row keeps `status:'pending'` for audit. Counting it as
 * pending made `armAutoResume` schedule a continuation round that could dispatch
 * nothing (every live row was done) and then append a misleading
 * `PHASE_NOT_PAUSED` stop line to `record.errors`.
 *
 * `armAutoResume` now passes these counts to `decideAutoResume`; `total` there
 * still comes from `derivePlanSnapshot` (same live-row rule).
 *
 * @param statuses - the plan's status list.
 * @returns live `done` / `pending` / `blocked` counts.
 */
export function liveResumeCounts(statuses: any) {
  const live = (Array.isArray(statuses) ? statuses : []).filter((item: any) => item?.closure !== 'replanned')
  const count = (status: string) => live.filter((item: any) => item?.status === status).length
  return { done: count('done'), pending: count('pending'), blocked: count('blocked') }
}

/** `schedule` = arm the next round; `stop` = leave the plan to a human. */
export type AutoResumeAction = 'schedule' | 'stop'

/**
 * Why the machine stopped. Stable strings: the status tool exposes them and
 * tests assert on the literal values.
 */
export type AutoResumeCode =
  | 'SCHEDULED'
  | 'AUTO_RESUME_DISABLED'
  | 'NO_PLAN'
  | 'CANCELLED'
  | 'SUPERSEDED'
  | 'ALREADY_RUNNING'
  | 'PLAN_MODE'
  | 'PHASE_NOT_PAUSED'
  | 'NOTHING_PENDING'
  | 'HAS_BLOCKED'
  | 'BUDGET_EXHAUSTED'
  | 'NO_PROGRESS'

/** Everything the decision needs; all fields are primitives by design. */
export interface AutoResumeInput {
  /** Feature flag. */
  enabled: boolean
  /** `record.phase` at the moment the round ended. */
  phase: string
  /** The user stopped this plan. */
  cancelled: boolean
  /** Automatic decomposition degraded; there is no usable plan. */
  degraded: boolean
  /** The session is in plan mode (a plan is for review, not execution). */
  planMode: boolean
  /** A dispatch is still in flight. */
  running: boolean
  /** Defined subtasks. */
  total: number
  /** Subtasks currently `done`. */
  done: number
  /** Subtasks currently `pending`. */
  pending: number
  /** Subtasks currently `blocked`. */
  blocked: number
  /** Continuation rounds already started by this machine. */
  attempt: number
  /** Configured continuation budget. */
  maxAttempts: number
  /** Consecutive continuation rounds that added no `done` row. */
  noProgressRounds: number
  /** Stop after this many stalled rounds. */
  stallLimit: number
  /** Backoff base. */
  baseDelayMs: number
  /** Backoff ceiling. */
  maxDelayMs: number
}

export interface AutoResumeDecision {
  action: AutoResumeAction
  code: AutoResumeCode
  /** Human/model readable; goes into `record.errors` and the status tool. */
  reason: string
  /** Attempt index of the round that would start (unchanged when stopping). */
  attempt: number
  /** Delay before that round; `0` when stopping. */
  delayMs: number
}

/**
 * Decide whether one more round may start, and when.
 *
 * Branch order is the contract (first match wins):
 *  1. feature flag / no plan
 *  2. user stop (`cancelled`, `superseded`) — never resurrect a decision
 *  3. already running / plan mode
 *  4. only a `paused` phase is auto-continuable
 *  5. any `blocked` row — a real failure, not a budget artifact
 *  6. nothing pending (includes "all done, evidence gap" — human work)
 *  7. attempt / progress budgets
 *
 * @param input - the frozen facts of the round that just ended.
 * @returns the decision plus a model-readable reason.
 */
export function decideAutoResume(input: AutoResumeInput): AutoResumeDecision {
  const attempt = Math.max(0, Math.floor(Number(input.attempt) || 0))
  const maxAttempts = Math.max(0, Math.floor(Number(input.maxAttempts) || 0))
  const stop = (code: AutoResumeCode, reason: string): AutoResumeDecision => ({
    action: 'stop',
    code,
    reason,
    attempt,
    delayMs: 0,
  })

  if (input.enabled !== true) {
    return stop('AUTO_RESUME_DISABLED', '自动续跑开关未开启（已被显式关闭：profile autoResume:false 或 DSH_WORKPLAN_AUTO_RESUME=0）')
  }
  if (input.degraded === true || Number(input.total) <= 0) {
    return stop('NO_PLAN', '没有可续跑的计划（自动分解降级或子任务数为 0）')
  }
  if (input.cancelled === true || input.phase === 'cancelled') {
    return stop('CANCELLED', '用户已取消：自动重来等于违背停下的决定')
  }
  if (input.phase === 'superseded') {
    return stop('SUPERSEDED', '责任已转移到承接计划，本计划不得自动续跑')
  }
  if (input.running === true) {
    return stop('ALREADY_RUNNING', '已有一轮在跑，不能并发再开一轮')
  }
  if (input.planMode === true) {
    return stop('PLAN_MODE', 'plan 模式下计划只供审阅，不自动执行')
  }
  if (input.phase !== 'paused') {
    return stop('PHASE_NOT_PAUSED', `计划阶段是 ${String(input.phase ?? 'unknown')}，只有 paused（预算到点）才自动续跑`)
  }
  /*
   * [1.12.0] 「有 blocked」先于「没有 pending」（T11）。
   *
   * 旧顺序把 `done=N, blocked=1, pending=0` 判成 NOTHING_PENDING（证据缺口），
   * 而真正要处理的是那条 blocked 行。1.12 起预算到点会保留等指示行并把阶段写成
   * blocked（PHASE_NOT_PAUSED 先命中），但历史会话回放仍可能出现 paused + blocked，
   * 所以这里按可执行的优先序回答。
   */
  if (Number(input.blocked) > 0) {
    return stop('HAS_BLOCKED', `存在 ${input.blocked} 个 blocked 子任务：那是真实失败，需人工改判或显式续跑，不自动修复`)
  }
  if (Number(input.pending) <= 0) {
    /*
     * Also the evidence-gap case: all rows done but deliveryReady=false.
     * Re-running done work is forbidden by the delivery contract; the gap can
     * only be closed by a human re-adjudication, so stop and say so.
     */
    return stop('NOTHING_PENDING', '没有 pending 项：若仍未就绪，那是证据缺口，需主 Agent 复核，不能靠重跑 done 项解决')
  }
  if (attempt >= maxAttempts) {
    return stop('BUDGET_EXHAUSTED', `自动续跑已用满 ${maxAttempts} 轮，交给主 Agent 决定`)
  }
  if (Number(input.noProgressRounds) >= Math.max(1, Number(input.stallLimit) || 1)) {
    return stop('NO_PROGRESS', `连续 ${input.noProgressRounds} 轮没有新增完成项，停止空转`)
  }

  const base = Math.max(0, Number(input.baseDelayMs) || 0)
  const cap = Math.max(base, Number(input.maxDelayMs) || base)
  const delayMs = Math.min(cap, base * Math.pow(2, attempt))
  return {
    action: 'schedule',
    code: 'SCHEDULED',
    reason: `第 ${attempt + 1}/${maxAttempts} 轮自动续跑将在 ${Math.round(delayMs / 1000)}s 后开始`,
    attempt: attempt + 1,
    delayMs,
  }
}
