/*
 * [1.10.4][auto-resume] Pin the automatic-continuation decision table.
 *
 * The 2026-11-01 incident: T12 was killed by the whole-round budget, reset to
 * `pending`, and never ran again until a human dispatched it 24 minutes later.
 * The fix must continue a `paused` plan by itself — but it must *never*:
 *  - resurrect a cancelled/superseded plan,
 *  - repair a `blocked` row silently,
 *  - re-run `done` work to "fix" an evidence gap,
 *  - or loop without progress.
 *
 * Every branch below is pure: no host, no timers, no files.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_RESUME_DEFAULTS,
  AUTO_RESUME_MAX_ATTEMPTS_CAP,
  autoResumeAttemptCap,
  autoResumeEnabledFrom,
  decideAutoResume,
} from '../src/auto-resume.js'

/** A paused round that finished 12 of 13 subtasks and left 1 pending. */
function pausedWithPending(overrides: Record<string, any> = {}) {
  return {
    enabled: true,
    phase: 'paused',
    cancelled: false,
    degraded: false,
    planMode: false,
    running: false,
    total: 13,
    done: 12,
    pending: 1,
    blocked: 0,
    attempt: 0,
    maxAttempts: AUTO_RESUME_DEFAULTS.maxAttempts,
    noProgressRounds: 0,
    stallLimit: AUTO_RESUME_DEFAULTS.stallLimit,
    baseDelayMs: AUTO_RESUME_DEFAULTS.baseDelayMs,
    maxDelayMs: AUTO_RESUME_DEFAULTS.maxDelayMs,
    ...overrides,
  }
}

test('defaults: the feature is ON (1.10.6) and the budget is bounded', () => {
  /*
   * [1.10.6] Flipped from `false`. Shipping the recovery switch off is what
   * turned the T12 incident into a 1h57m stall, so "unset" must now mean "on".
   */
  assert.equal(AUTO_RESUME_DEFAULTS.enabled, true)
  assert.ok(AUTO_RESUME_DEFAULTS.maxAttempts >= 1)
  assert.ok(AUTO_RESUME_DEFAULTS.maxAttempts <= AUTO_RESUME_MAX_ATTEMPTS_CAP)
  assert.ok(AUTO_RESUME_DEFAULTS.stallLimit >= 1)
  const decision = decideAutoResume(pausedWithPending({ enabled: false }))
  assert.equal(decision.action, 'stop')
  assert.equal(decision.code, 'AUTO_RESUME_DISABLED')
  assert.equal(decision.delayMs, 0)
})

test('paused + pending schedules exactly one continuation with backoff', () => {
  const first = decideAutoResume(pausedWithPending())
  assert.equal(first.action, 'schedule')
  assert.equal(first.code, 'SCHEDULED')
  assert.equal(first.attempt, 1)
  assert.equal(first.delayMs, AUTO_RESUME_DEFAULTS.baseDelayMs)

  const second = decideAutoResume(pausedWithPending({ attempt: 1 }))
  assert.equal(second.action, 'schedule')
  assert.equal(second.attempt, 2)
  assert.equal(second.delayMs, AUTO_RESUME_DEFAULTS.baseDelayMs * 2)

  const capped = decideAutoResume(pausedWithPending({ attempt: 3, maxAttempts: 4 }))
  assert.equal(capped.action, 'schedule')
  assert.equal(capped.delayMs, Math.min(AUTO_RESUME_DEFAULTS.maxDelayMs, AUTO_RESUME_DEFAULTS.baseDelayMs * 8))
})

test('a cancelled or superseded plan is never resurrected', () => {
  assert.equal(decideAutoResume(pausedWithPending({ cancelled: true })).code, 'CANCELLED')
  assert.equal(decideAutoResume(pausedWithPending({ phase: 'cancelled' })).code, 'CANCELLED')
  assert.equal(decideAutoResume(pausedWithPending({ phase: 'superseded' })).code, 'SUPERSEDED')
})

test('a blocked row is a real failure, not a budget artifact', () => {
  const decision = decideAutoResume(pausedWithPending({ done: 11, pending: 1, blocked: 1 }))
  assert.equal(decision.action, 'stop')
  assert.equal(decision.code, 'HAS_BLOCKED')
})

test('all done but delivery not ready stops: evidence gaps are human work', () => {
  const decision = decideAutoResume(pausedWithPending({ done: 13, pending: 0, attempt: 1 }))
  assert.equal(decision.action, 'stop')
  assert.equal(decision.code, 'NOTHING_PENDING')
  assert.match(decision.reason, /证据缺口/)
})

test('only paused is auto-continuable; blocked/executing/done are not', () => {
  for (const phase of ['blocked', 'executing', 'done', 'planning', 'integrating']) {
    const decision = decideAutoResume(pausedWithPending({ phase }))
    assert.equal(decision.action, 'stop', phase)
    assert.equal(decision.code, 'PHASE_NOT_PAUSED', phase)
  }
})

test('plan mode, running dispatch and degraded plans are excluded', () => {
  assert.equal(decideAutoResume(pausedWithPending({ planMode: true })).code, 'PLAN_MODE')
  assert.equal(decideAutoResume(pausedWithPending({ running: true })).code, 'ALREADY_RUNNING')
  assert.equal(decideAutoResume(pausedWithPending({ degraded: true })).code, 'NO_PLAN')
  assert.equal(decideAutoResume(pausedWithPending({ total: 0, pending: 0 })).code, 'NO_PLAN')
})

test('the attempt budget and the no-progress guard both stop the chain', () => {
  const exhausted = decideAutoResume(pausedWithPending({ attempt: 2, maxAttempts: 2 }))
  assert.equal(exhausted.action, 'stop')
  assert.equal(exhausted.code, 'BUDGET_EXHAUSTED')

  const stalled = decideAutoResume(pausedWithPending({ attempt: 1, noProgressRounds: 1, stallLimit: 1 }))
  assert.equal(stalled.action, 'stop')
  assert.equal(stalled.code, 'NO_PROGRESS')

  const stillProgressing = decideAutoResume(pausedWithPending({ attempt: 1, noProgressRounds: 0 }))
  assert.equal(stillProgressing.action, 'schedule')
})

test('attempt budgets are clamped, never negative and never unbounded', () => {
  assert.equal(autoResumeAttemptCap(undefined), AUTO_RESUME_DEFAULTS.maxAttempts)
  assert.equal(autoResumeAttemptCap('not-a-number'), AUTO_RESUME_DEFAULTS.maxAttempts)
  assert.equal(autoResumeAttemptCap(-3), 0)
  assert.equal(autoResumeAttemptCap(99), AUTO_RESUME_MAX_ATTEMPTS_CAP)
  assert.equal(autoResumeAttemptCap(1.9), 1)
})

/*
 * [1.10.6] The switch resolver: an unset deployment must be ON, and both the
 * profile config and the environment must be able to turn it OFF again.
 *
 * The bug this pins is not "the flag is wrong" but "falsey spellings were read
 * as the default": `DSH_WORKPLAN_AUTO_RESUME=0` used to fall through to the
 * built-in default, so the only way to disable the chain was to make the
 * resolver return undefined. Now `0/false/no/off` is an explicit refusal.
 */
test('the enable resolver: default on, explicit off wins in both sources', () => {
  assert.equal(autoResumeEnabledFrom(undefined, undefined), true)
  assert.equal(autoResumeEnabledFrom(false, undefined), false)
  assert.equal(autoResumeEnabledFrom(false, '1'), false)
  assert.equal(autoResumeEnabledFrom(true, '0'), true)
  assert.equal(autoResumeEnabledFrom(undefined, '0'), false)
  assert.equal(autoResumeEnabledFrom(undefined, 'false'), false)
  assert.equal(autoResumeEnabledFrom(undefined, 'no'), false)
  assert.equal(autoResumeEnabledFrom(undefined, 'off'), false)
  assert.equal(autoResumeEnabledFrom(undefined, '1'), true)
  assert.equal(autoResumeEnabledFrom(undefined, ' TRUE '), true)
  assert.equal(autoResumeEnabledFrom('false', undefined), true, 'a non-boolean config value is not a switch')
  assert.equal(autoResumeEnabledFrom(undefined, 'maybe'), true, 'an unknown spelling falls back to the default')
})
