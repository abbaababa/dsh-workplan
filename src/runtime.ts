/**
 * Host runtime for dsh-workplan.
 *
 * The runtime owns three things:
 *  - the `agent/pre-step` listener that plans and dispatches before the model's
 *    first step;
 *  - the in-memory dashboard cache, reconstructed from the durable session log
 *    when missing;
 *  - the two model-facing tools that update or re-dispatch a plan.
 *
 * Every failure is converted into an explicit blocked/degraded record. Nothing
 * in this file is allowed to escape as an unhandled rejection from a listener.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
  MAX_CONCURRENT,
  PlanError,
  aggregateInvariantViolations,
  applyStatus,
  attachPlanMeta,
  buildChildPrompt,
  buildCancelMessage,
  buildDegradedMessage,
  buildPlanMessage,
  buildPlannerPrompt,
  buildResultMessage,
  createStatuses,
  derivePlanSnapshot,
  extractJson,
  flattenSubtasks,
  isRecord,
  isSocialMessage,
  isStatusQuestion,
  isVagueContinuation,
  markDependentsBlocked,
  messageText,
  readySubtasks,
  MAX_PLAN_RESUMES,
  canResumePlan,
  resetBlockedStatuses,
  parseCancelMessage,
  parseResultMessage,
  parseWorkplanMessage,
  planPhase,
  reconcilePhase,
  truncate,
  validatePlan,
  applyResultStatuses,
  adjudicateResult,
  MAX_CONVERSATION_CHARS,
  parseUpdateMessage,
  buildUpdateMessage,
} from './plan.js'
import { createProgressWatchdog, describeError } from './watchdog.js'

export const PLANNER_TIMEOUT_MS = 120000
/**
 * Absolute ceiling for one child execution.
 *
 * 300 000 ms used to be the *only* limit, and because it was purely a wall
 * clock it killed healthy work: a child that needed one more minute was
 * recorded as blocked, `markDependentsBlocked` blocked every dependent, and the
 * plan became terminal at the first slow subtask. The ceiling is now a
 * settlement guarantee, while the no-progress window below is what normally
 * ends an attempt.
 */
export const CHILD_TIMEOUT_MS = 900000
/** No-progress window: the child's own session log stopped growing. */
export const CHILD_IDLE_TIMEOUT_MS = 300000
/*
 * Floors exist to reject zero, negative and absurdly small values, not to
 * overrule an operator. The defaults above are what production uses; a floor of
 * 1s keeps diagnostics and tests able to exercise the timers without waiting
 * minutes.
 */
export const MIN_CHILD_TIMEOUT_MS = 1000
export const MAX_CHILD_TIMEOUT_MS = 1800000
export const MIN_CHILD_IDLE_MS = 1000
export const MAX_CHILD_IDLE_MS = 900000
export const CHILD_POLL_MS = 2000
export const TOTAL_TIMEOUT_MS = 1200000
export const DISPOSE_TIMEOUT_MS = 5000
export const STALE_PENDING_MS = 10 * 60 * 1000
export const MAX_HISTORY_EVENTS = 2000
export const MAX_LIVE_SESSIONS = 20

function abortError() {
  return new PlanError('执行已取消', 'ABORTED')
}

export function isRootSession(session: any) {
  const header = session?.header
  if (!header) return true
  if (header.parentSession) return false
  if (header.origin === 'subagent') return false
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
  return true
}

export function humanMessages(messages: any) {
  if (!Array.isArray(messages)) return []
  return messages.filter((message: any) => {
    if (!message || message.role !== 'user') return false
    const kind = message.source?.kind
    if (kind === undefined) return true
    return kind === 'user'
  })
}

function taskTextFromMessages(messages: any) {
  const texts: string[] = []
  for (const message of humanMessages(messages)) {
    const text = messageText(message).trim()
    if (text) texts.push(text)
  }
  return truncate(texts.join('\n\n'), 16000)
}

/*
 * Children start with zero parent context. Without recent turns they cannot
 * resolve "B", "it", "the previous item", so they search blindly and time out.
 * Build a bounded plain-text window from the session log (newest last) and pass
 * it to both the planner and every child. Plugin-generated plan/result rows are
 * excluded to avoid feeding the plan back into itself.
 */
function recentConversation(session: any, maxChars = MAX_CONVERSATION_CHARS) {
  if (!session || typeof session.eventAt !== 'function') return ''
  const parts: string[] = []
  let seq = typeof session.seq === 'number' ? session.seq - 1 : -1
  let scanned = 0
  let total = 0
  while (seq >= 0 && scanned < 800 && total < maxChars) {
    const event = session.eventAt(seq)
    seq -= 1
    scanned += 1
    if (!event) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const message = event.data?.message ?? event.data
    const kind = message?.source?.kind
    if (kind === 'workplan' || kind === 'workplan-result') continue
    const text = messageText(message).trim()
    if (!text) continue
    const line = `${event.type === 'user/message' ? '用户' : '助手'}：${truncate(text, 1200)}`
    parts.unshift(line)
    total += line.length + 2
  }
  return truncate(parts.join('\n\n'), maxChars)
}

export function isPlanModeActive(ctx: any, session: any) {
  try {
    const service = ctx.get?.('sessionProjections')
    const snapshot = service?.snapshot?.(session, ['plan'])
    const state = snapshot?.values?.plan
    return state?.active === true || state?.pending === true
  } catch {
    return false
  }
}

function enterDecision(downstream: any, extraMessages: any[]) {
  if (!downstream || downstream.kind !== 'enter') return downstream
  const decision: any = { kind: 'enter', messages: [...downstream.messages, ...extraMessages] }
  if (downstream.startsRequestSeries === true) decision.startsRequestSeries = true
  return decision
}

function pushRecordError(record: any, error: any) {
  // String(error) on a plain object produced "[object Object]" in the durable
  // error list, which made the failure undiagnosable after the fact.
  const text = truncate(describeError(error), 1000)
  record.errors = [...(record.errors ?? []), text].slice(-20)
}

async function collectStream(stream: any) {
  let text = ''
  let textDeltaSeen = false
  let finished = false
  let finishKind = null
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      textDeltaSeen = true
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !textDeltaSeen) {
      text += chunk.block.text ?? ''
    } else if (chunk.type === 'finish') {
      finished = true
      finishKind = chunk.reason?.kind ?? 'unknown'
      if (finishKind === 'error' || finishKind === 'aborted') {
        const failure = chunk.reason?.failure
        throw new PlanError(
          `模型调用结束：${finishKind}${failure?.code ? ` ${failure.code}` : ''}${failure?.message ? `：${failure.message}` : ''}`,
          finishKind === 'aborted' ? 'ABORTED' : 'PLANNER_LLM_ERROR',
        )
      }
      if (finishKind !== 'stop') {
        throw new PlanError(`规划器输出未正常结束：${finishKind}`, 'PLANNER_INCOMPLETE')
      }
    }
  }
  if (!finished) throw new PlanError('规划器没有返回终止信号', 'PLANNER_INCOMPLETE')
  if (!text.trim()) throw new PlanError('规划器返回空内容', 'EMPTY_OUTPUT')
  return text
}

async function runPlanner(ctx: any, options: any) {
  const { taskText, cwd, sessionId, modelSelection, signal, conversationContext = '', budget = {} } = options
  let lastErrors: string[] = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal.aborted) throw abortError()
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      controller.abort(new PlanError('规划器超时', 'PLANNER_TIMEOUT'))
    }, PLANNER_TIMEOUT_MS)
    try {
      let prompt = buildPlannerPrompt(taskText, cwd, conversationContext, budget)
      if (lastErrors.length > 0) {
        prompt += [
          '',
          '上一次输出未通过校验，请修复以下问题后重新输出完整 JSON：',
          ...lastErrors.slice(0, 12).map((error: any) => `- ${error}`),
        ].join('\n')
      }
      const stream = ctx.llm.stream({
        provider: modelSelection.provider,
        model: modelSelection.model,
        reasoningEffort: modelSelection.reasoningEffort,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: controller.signal,
        sessionId,
      })
      const text = await collectStream(stream)
      const raw = extractJson(text)
      const validated = validatePlan(raw)
      if (validated.ok) return validated.plan
      lastErrors = validated.errors ?? []
    } catch (error) {
      if (signal.aborted || (controller.signal.aborted && (controller.signal.reason as any)?.code === 'ABORTED')) {
        throw abortError()
      }
      if (error instanceof PlanError && error.code === 'ABORTED') throw error
      lastErrors = [error instanceof Error ? error.message : String(error)]
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }
  throw new PlanError(
    `规划器两次输出均未通过校验：${lastErrors.slice(0, 5).join('；')}`,
    'PLANNER_FAILED',
    lastErrors,
  )
}

function createChildController(parentSignal: any) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parentSignal.reason ?? abortError())
  if (parentSignal.aborted) onAbort()
  else parentSignal.addEventListener('abort', onAbort, { once: true })
  return {
    controller,
    disposeListener: () => parentSignal.removeEventListener('abort', onAbort),
  }
}

function waitForActivation(activation: any, signal: any) {
  const result = activation.result
  result.catch(() => {})
  return new Promise((resolve: any, reject: any) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(signal.reason ?? abortError())
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    result.then(
      (value: any) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: any) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function resultText(result: any) {
  const text = messageText({ content: result?.output ?? [] }).trim()
  return text
}

async function disposeActivation(activation: any, record: any, subtaskId: string, guard?: SubtaskGuard) {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      activation.dispose(),
      new Promise((_: any, reject: any) => {
        timer = setTimeout(() => reject(new Error('dispose timeout')), DISPOSE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } catch (error: any) {
    if (!guard?.timedOut) {
      record.errors = [
        ...record.errors,
        `${subtaskId} dispose: ${truncate(String(error?.message ?? error), 300)}`,
      ].slice(-20)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface SubtaskGuard {
  timedOut: boolean
}

function clamp(value: any, min: number, max: number, fallback: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

/**
 * Absolute child ceiling, clamped so an operator cannot configure a value that
 * outlives the plan budget or a disabled timer.
 *
 * @param value - configured value, if any.
 * @returns milliseconds within `[MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS]`.
 */
export function normaliseChildTimeout(value: any) {
  return clamp(value, MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS, CHILD_TIMEOUT_MS)
}

/**
 * No-progress window, clamped to stay meaningful next to the ceiling.
 *
 * @param value - configured value, if any.
 * @returns milliseconds within `[MIN_CHILD_IDLE_MS, MAX_CHILD_IDLE_MS]`.
 */
export function normaliseIdleTimeout(value: any) {
  return clamp(value, MIN_CHILD_IDLE_MS, MAX_CHILD_IDLE_MS, CHILD_IDLE_TIMEOUT_MS)
}

/*
 * Every status write for a subtask goes through this guard. Once the
 * subtask-level deadline has fired, the subtask is already recorded as blocked;
 * a child that settles afterwards (for example an activation whose abort signal
 * was ignored) must not be allowed to rewrite that verdict to done.
 */
function writeSubtaskStatus(record: any, subtaskId: any, patch: any, guard: SubtaskGuard) {
  if (guard.timedOut) return false
  record.statuses = applyStatus(record.statuses, subtaskId, { updatedBy: 'child', ...patch })
  record.updatedAt = Date.now()
  return true
}

function recordSubtaskError(record: any, subtaskId: any, message: any, guard: SubtaskGuard) {
  if (guard.timedOut) return
  record.errors = [...record.errors, `${subtaskId}: ${truncate(message, 500)}`].slice(-20)
}

/**
 * Resolve one artifact reference against the round's working directory.
 *
 * Relative refs are what a child is asked to report, so they must be resolved
 * the same way for every check; an empty ref is never "present".
 */
function resolveArtifactPath(ref: any, cwd: any) {
  const text = typeof ref === 'string' ? ref.trim() : ''
  if (!text) return ''
  if (isAbsolute(text)) return text
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd()
  return resolve(base, text)
}

/**
 * [1.7.0] Check the files a child declared.
 *
 * Only `kind:'file'` is verifiable here. A url or a note is taken at face
 * value; pretending to verify them would be worse than not checking at all.
 * The verdict is recorded rather than enforced: a missing file makes the
 * dependency gate fail, but it does not silently rewrite "done" to "blocked".
 */
export function checkArtifacts(artifacts: any, cwd: any, artifactExists: any = existsSync) {
  const list = Array.isArray(artifacts) ? artifacts : []
  const missingArtifacts: string[] = []
  const checked = list.map((item: any) => {
    if (!isRecord(item) || item.kind !== 'file') return item
    const target = resolveArtifactPath(item.ref, cwd)
    let exists = false
    try {
      exists = target ? artifactExists(target) === true : false
    } catch {
      exists = false
    }
    if (!exists) missingArtifacts.push(String(item.ref))
    return { ...item, exists }
  })
  return { artifacts: checked, missingArtifacts }
}

/**
 * Turn one child output into a status verdict.
 *
 * The decision lives in `adjudicateResult` (a pure function) so the runtime and
 * the session replay cannot disagree. This wrapper only adds the two things
 * that need the environment: the strict/legacy switch and the file check.
 */
function settleFromOutput(record: any, subtask: any, output: any, guard: SubtaskGuard, options: any) {
  const verdict = adjudicateResult({ output, strict: options.strictEvidence !== false })
  const checked = checkArtifacts(verdict.artifacts, options.cwd, options.artifactExists)
  writeSubtaskStatus(record, subtask.id, {
    status: verdict.status,
    progress: 100,
    finishedAt: Date.now(),
    summary: truncate(output, 3000),
    error: verdict.error,
    verification: verdict.verification,
    acceptance: verdict.acceptance,
    artifacts: checked.artifacts.length > 0 ? checked.artifacts : undefined,
    missingArtifacts: checked.missingArtifacts.length > 0 ? checked.missingArtifacts : undefined,
    needs: verdict.needs.length > 0 ? verdict.needs : undefined,
  }, guard)
  if (verdict.status === 'blocked') {
    recordSubtaskError(record, subtask.id, verdict.error ?? '未完成', guard)
  } else if (checked.missingArtifacts.length > 0) {
    recordSubtaskError(record, subtask.id, `声明产物缺失：${checked.missingArtifacts.join('、')}`, guard)
  }
  return verdict
}

/**
 * Retry policy for one child attempt.
 *
 * A wedged child (no event for the whole idle window) is worth one fresh
 * attempt. A hard ceiling means the budget is gone, and an abort is a decision,
 * so neither is retried. `CHILD_NOT_COMPLETED` is retried only while there is
 * more than one idle window left, otherwise the retry itself would just be
 * killed by the same watchdog.
 */
export function shouldRetryAttempt(error: any, attempt: any, remainingMs: any, idleTimeoutMs: any) {
  if (attempt >= 2) return false
  const code = error?.code
  if (code === 'CHILD_TIMEOUT' || code === 'ABORTED' || code === 'TOTAL_TIMEOUT') return false
  if (/aborted|refusal/i.test(String(error?.message ?? ''))) return false
  if (code === 'CHILD_STALLED') return true
  if (code === 'CHILD_NOT_COMPLETED') {
    return Number(remainingMs) > Number(idleTimeoutMs)
  }
  return true
}

async function executeSubtask(ctx: any, record: any, stage: any, subtask: any, options: any) {
  const { parentSignal, deadline, modelSelection, conversationContext = '', child, guard } = options
  let lastError: any = null
  let lastFailure: any = null
  try {
    if (!writeSubtaskStatus(record, subtask.id, {
      status: 'in_progress',
      progress: 5,
      startedAt: Date.now(),
    }, guard)) return

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (guard.timedOut) return
      if (parentSignal.aborted) throw abortError()
      if (Date.now() >= deadline) throw new PlanError('总执行超时', 'TOTAL_TIMEOUT')
      let activation: any = null
      try {
        if (child.controller.signal.aborted) {
          throw child.controller.signal.reason ?? abortError()
        }
        activation = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: `${subtask.department}:${subtask.id} ${subtask.title}`.slice(0, 120),
          request: {
            prompt: [{
              type: 'text',
              text: buildChildPrompt({
                plan: record.plan,
                subtask,
                stage,
                dependencyResults: record.statuses
                  .filter((item: any) => subtask.dependsOn.includes(item.subtaskId))
                  .map((item: any) => ({
                    id: item.subtaskId,
                    title: item.title,
                    status: item.status,
                    summary: item.summary,
                  })),
                cwd: options.cwd,
                conversationContext,
                statuses: record.statuses,
                previousFailure: attempt > 1 ? lastFailure : null,
              }),
            }],
            parent: options.agent,
            cwd: typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined,
            agentOptions: modelSelection?.provider && modelSelection?.model
              ? { provider: modelSelection.provider, model: modelSelection.model }
              : undefined,
            maxDepth: 1,
          },
          signal: child.controller.signal,
          delivery: 'caller',
        })
        if (guard.timedOut) return
        if (!activation || typeof activation.result?.then !== 'function') {
          throw new PlanError('子 Agent 没有返回可等待的结果', 'NO_ACTIVATION')
        }
        writeSubtaskStatus(record, subtask.id, {
          childId: activation.childId,
          progress: 10,
        }, guard)
        const idleTimeoutMs = normaliseIdleTimeout(options.idleTimeoutMs)
        const hardTimeoutMs = normaliseChildTimeout(options.childTimeoutMs)
        const watchdog = createProgressWatchdog({
          getSeq: () => {
            try {
              const childSession = ctx.sessions?.get?.(activation.childId)
              const seq = childSession?.seq
              return typeof seq === 'number' ? seq : undefined
            } catch {
              return undefined
            }
          },
          idleMs: idleTimeoutMs,
          hardMs: Math.max(1000, Math.min(hardTimeoutMs, deadline - Date.now())),
          // Poll often enough to notice growth inside a short idle window, but
          // never more than four times per window.
          pollMs: Math.min(CHILD_POLL_MS, Math.max(20, Math.floor(idleTimeoutMs / 4))),
          onProgress: ({ now }: any) => {
            if (guard.timedOut) return
            // Visible liveness: the dashboard can show that a slow subtask is
            // still producing events instead of looking frozen.
            record.heartbeatAt = now
            record.updatedAt = now
          },
          makeError: (reason: any) => new PlanError(
            reason === 'stalled'
              ? `子任务 ${subtask.id} 无进展超时（${idleTimeoutMs}ms 内子 Agent 没有产生任何新事件）`
              : `子任务 ${subtask.id} 超时（${hardTimeoutMs}ms）`,
            reason === 'stalled' ? 'CHILD_STALLED' : 'CHILD_TIMEOUT',
            { subtaskId: subtask.id },
          ),
        })
        let result: any
        try {
          const waiter = waitForActivation(activation, child.controller.signal)
          // The losing side of the race may reject after the watchdog fired;
          // keep that rejection handled so Node never reports it as unhandled.
          waiter.catch(() => {})
          result = await Promise.race([waiter, watchdog.fired])
        } finally {
          watchdog.stop()
        }
        if (guard.timedOut) return
        const output = resultText(result)
        if (result.stopReason !== 'completed') {
          throw new PlanError(
            `子 Agent 结束状态为 ${result.stopReason}${result.diagnostic ? `：${result.diagnostic}` : ''}`,
            'CHILD_NOT_COMPLETED',
          )
        }
        if (!output) throw new PlanError('子 Agent 没有返回文本结果', 'EMPTY_CHILD_OUTPUT')
        /*
         * [1.7.0] Evidence decides the verdict.
         *
         * The old rule was "not BLOCKED => done", so a child that reported
         * unverified or failed self-checks was still counted as finished and
         * the main Agent had nothing to review but prose. `adjudicateResult`
         * is the single deterministic table; `settleFromOutput` adds the
         * environment-dependent artifact check.
         */
        settleFromOutput(record, subtask, output, guard, options)
        return
      } catch (error: any) {
        lastError = error
        if (guard.timedOut) break
        const isAbort = parentSignal.aborted || child.controller.signal.aborted
        const idleTimeoutMs = normaliseIdleTimeout(options.idleTimeoutMs)
        const remaining = deadline - Date.now()
        /*
         * [1.7.0] The retry carries the previous failure with it.
         *
         * Retrying with an identical prompt made the child repeat the same
         * dead end and produced the same error twice. The next attempt now
         * receives the code, message and attempt number, so it can change
         * approach — or stop honestly.
         */
        lastFailure = {
          attempt,
          code: error?.code ?? 'UNKNOWN',
          message: describeError(error),
        }
        const retry = !isAbort && shouldRetryAttempt(error, attempt, remaining, idleTimeoutMs)
        if (retry) {
          record.errors = [
            ...record.errors,
            `${subtask.id}: 第 ${attempt} 次执行失败（${lastFailure.code}），已带上失败原因重试`,
          ].slice(-20)
          writeSubtaskStatus(record, subtask.id, { progress: 15 }, guard)
          continue
        }
        if (!isAbort && remaining <= idleTimeoutMs && error?.code !== 'CHILD_TIMEOUT') {
          record.errors = [
            ...record.errors,
            `${subtask.id}: 剩余预算不足（${Math.max(0, Math.round(remaining / 1000))}s），未重试`,
          ].slice(-20)
        }
        break
      } finally {
        if (activation) {
          await disposeActivation(activation, record, subtask.id, guard)
          activation = null
        }
      }
    }

    const message = describeError(lastError ?? new Error('未知失败'))
    writeSubtaskStatus(record, subtask.id, {
      status: 'blocked',
      progress: 100,
      finishedAt: Date.now(),
      error: truncate(message, 2000),
      summary: truncate(`未完成：${message}`, 3000),
    }, guard)
    recordSubtaskError(record, subtask.id, message, guard)
  } catch (error) {
    const message = describeError(error)
    try {
      writeSubtaskStatus(record, subtask.id, {
        status: 'blocked',
        progress: 100,
        finishedAt: Date.now(),
        error: truncate(message, 2000),
        summary: truncate(`未完成：${message}`, 3000),
      }, guard)
    } catch {
      // The status list itself is unusable; the outer dispatcher records the error.
    }
    recordSubtaskError(record, subtask.id, message, guard)
  }
}

/*
 * Runs one subtask under a deadline that belongs to that subtask alone.
 *
 * The subtask timer is a full settlement guarantee, not just an abort hint: if
 * the child activation ignores its abort signal, or never settles at all, the
 * race below still resolves, that subtask is recorded as blocked, and the
 * dispatcher keeps scheduling the rest of the DAG. This function never throws
 * on a per-subtask timeout, so one slow child can no longer blanket-block the
 * whole plan — only that subtask (and its real dependents) is affected.
 */
async function runSubtask(ctx: any, record: any, stage: any, subtask: any, options: any) {
  const childTimeoutMs = normaliseChildTimeout(options.childTimeoutMs)
  const child = createChildController(options.parentSignal)
  const guard: SubtaskGuard = { timedOut: false }
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadlinePromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      guard.timedOut = true
      // Reached only when the child ignored both its idle window and its
      // abort signal; the message says so, otherwise the cause looks like a
      // plain "too slow" and the next investigation goes down the wrong path.
      const message = `子任务 ${subtask.id} 达到执行上限（${childTimeoutMs}ms），已强制结束`
      try {
        record.statuses = applyStatus(record.statuses, subtask.id, {
          status: 'blocked',
          progress: 100,
          finishedAt: Date.now(),
          error: message,
          summary: truncate(`未完成：${message}`, 3000),
        })
        record.errors = [...record.errors, `${subtask.id}: ${message}`].slice(-20)
        record.updatedAt = Date.now()
      } catch (error: any) {
        record.errors = [
          ...record.errors,
          `${subtask.id}: 超时状态写入失败：${truncate(String(error?.message ?? error), 500)}`,
        ].slice(-20)
      } finally {
        if (!child.controller.signal.aborted) {
          child.controller.abort(new PlanError(message, 'CHILD_TIMEOUT', { subtaskId: subtask.id }))
        }
        child.disposeListener()
        resolve()
      }
    }, childTimeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([
      executeSubtask(ctx, record, stage, subtask, {
        ...options,
        child,
        guard,
      }),
      deadlinePromise,
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    child.disposeListener()
    if (!child.controller.signal.aborted) child.controller.abort()
  }
}

async function runWithConcurrency(items: any, limit: any, worker: any) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

/**
 * Build the durable result message for the round that just ended.
 *
 * Extracted from `dispatchTool` so the wiring itself is testable: a mutation
 * test on 1.3.3 dropped `phase: record.phase` at the call site and all 62 tests
 * still passed, because every test stopped short of the call site. Now the
 * phase reaching the payload is pinned by a test of this function.
 *
 * @param record - the live plan record at the end of the round.
 * @param sessionId - the owning session id.
 * @param limits - resolved runtime limits (the resume budget comes from here).
 * @returns a user message carrying the `workplan-result` payload.
 */
/**
 * The subtask rows a dispatch/status tool returns to the model.
 *
 * One definition, because the same plan was described in three slightly
 * different shapes (dispatch tail, already-running branch, status tool) and the
 * model could see three different answers in one turn.
 */
export function modelStatusLines(statuses: any) {
  const list = Array.isArray(statuses) ? statuses : []
  return list.map((item: any) => ({
    subtaskId: item.subtaskId,
    title: item.title,
    department: item.department,
    status: item.status,
    progress: item.progress,
    summary: truncate(item.summary ?? item.error ?? '', 2000),
    error: item.error ?? null,
    verification: item.verification ?? null,
    revision: Number(item.revision ?? 0),
    updatedBy: item.updatedBy ?? null,
    missingArtifacts: Array.isArray(item.missingArtifacts) ? item.missingArtifacts : [],
    needs: Array.isArray(item.needs) ? item.needs : [],
  }))
}

export function buildRoundResult(record: any, sessionId: any, limits: any) {
  const { statuses, stats } = derivePlanSnapshot(record.statuses)
  return buildResultMessage({
    planId: record.plan.planId,
    sessionId,
    dispatchedAt: record.dispatchedAt ?? Date.now(),
    statuses,
    errors: record.errors,
    stats,
    // The exact phase this round ended in, so a refresh can replay a pause
    // instead of inventing `executing` for work that is not running.
    phase: record.phase,
    resumeCount: Number(record.resumeCount ?? 0),
    resumeAvailable: canResumePlan(record, limits.maxResumes).resume,
  })
}

export async function dispatchPlan(ctx: any, record: any, options: any) {
  const { agent, signal, modelSelection, cwd, conversationContext = '' } = options
  const deadline = Date.now() + (options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS)
  /*
   * Resume, do not restart.
   *
   * A blocked plan used to be terminal: every subtask was `blocked`, so
   * `readySubtasks()` returned nothing and the dispatcher broke out having run
   * zero children. Clearing only the failed attempts keeps finished work (and
   * its side effects) while giving the rest a second chance, and the resume
   * budget stops a subtask that always fails from looping forever.
   */
  const resume = canResumePlan(record, options.maxResumes ?? MAX_PLAN_RESUMES)
  if (resume.resume) {
    /*
     * Continuing after a budget pause is not a repair, so it is not charged
     * against the resume budget and it does not reset anything: the paused
     * subtasks are already `pending`. Only a `blocked` plan pays a resume and
     * needs its failed attempts cleared.
     */
    const repairing = record.phase === 'blocked'
    if (repairing) record.resumeCount = Number(record.resumeCount ?? 0) + 1
    record.statuses = resetBlockedStatuses(record.statuses)
    // A resume produces a new durable outcome; without clearing this flag the
    // second result message was never written and a page refresh replayed the
    // stale blocked state.
    record.resultWritten = false
    record.error = null
    if (repairing) {
      record.errors = [
        ...(record.errors ?? []),
        `第 ${record.resumeCount} 次续跑：已重置 ${resume.failed} 个受阻子任务（已完成的不重跑）`,
      ].slice(-20)
    } else {
      record.errors = (record.errors ?? []).filter((line: string) => !/预算|续跑/.test(String(line))).slice(-20)
    }
  }
  const parentSignal = signal
  const childController = new AbortController()
  const onAbort = () => childController.abort(parentSignal.reason ?? abortError())
  if (parentSignal.aborted) onAbort()
  else parentSignal.addEventListener('abort', onAbort, { once: true })
  const totalTimer = setTimeout(() => {
    childController.abort(new PlanError('总执行超时', 'TOTAL_TIMEOUT'))
  }, Math.max(1000, deadline - Date.now()))
  totalTimer.unref?.()
  record.dispatchedAt = Date.now()
  record.phase = 'executing'
  record.updatedAt = record.dispatchedAt
  try {
    let guard = 0
    while (true) {
      guard += 1
      if (guard > 200) throw new PlanError('调度次数异常', 'DISPATCH_LOOP')
      if (parentSignal.aborted) throw abortError()
      if (Date.now() >= deadline) throw new PlanError('总执行超时', 'TOTAL_TIMEOUT')
      /*
       * [1.7.0] A `done` upstream only unblocks its dependents when the files it
       * declared actually exist. The check is opt-out (`artifactGate:false`) so
       * an older plan or a debugging session can keep plain status semantics.
       */
      const gate = options.artifactGate !== false
      const ready = readySubtasks(record.plan, record.statuses, gate
        ? {
            dependencyOk: (dependency: any) => dependency?.status === 'done'
              && !(Array.isArray(dependency?.missingArtifacts) && dependency.missingArtifacts.length > 0),
          }
        : {})
      if (ready.length === 0) {
        const pending = record.statuses.filter((item: any) => item.status === 'pending')
        for (const item of pending) {
          record.statuses = applyStatus(record.statuses, item.subtaskId, {
            status: 'blocked',
            error: '依赖未完成或上游受阻',
          })
        }
        break
      }
      await runWithConcurrency(ready, MAX_CONCURRENT, async (item: any) => {
        // readySubtasks() returns subtask objects (they carry `id`, not
        // `subtaskId`); using the status key here silently skipped every task
        // and spun the dispatcher until DISPATCH_LOOP marked all blocked.
        const entry = flattenSubtasks(record.plan)
          .find((candidate: any) => candidate.subtask.id === item.id)
        if (!entry) return
        await runSubtask(ctx, record, entry.stage, entry.subtask, {
          agent,
          parentSignal: childController.signal,
          deadline,
          childTimeoutMs: options.childTimeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          modelSelection,
          cwd,
          conversationContext,
          strictEvidence: options.strictEvidence,
          artifactExists: options.artifactExists,
        })
      })
      const blocked = record.statuses
        .filter((item: any) => item.status === 'blocked')
        .map((item: any) => item.subtaskId)
      for (const id of blocked) {
        /*
         * Carry the actual cause downstream. The main Agent used to receive
         * "上游子任务受阻: T2" with no reason and no missing artifacts, so it
         * had to re-read the whole plan to guess what to repair.
         */
        const upstream = record.statuses.find((item: any) => item.subtaskId === id)
        const cause = upstream
          ? {
              reason: upstream.error,
              missingArtifacts: Array.isArray(upstream.missingArtifacts) ? upstream.missingArtifacts : [],
            }
          : null
        record.statuses = markDependentsBlocked(record.plan, record.statuses, id, cause)
      }
      /*
       * No stats refresh here any more: `serialisePlan` derives the counts from
       * exactly the list it ships, so a cache can no longer lag behind the work.
       */
      record.updatedAt = Date.now()
    }
    record.phase = planPhase(record.statuses)
  } catch (error) {
    const message = describeError(error)
    pushRecordError(record, error)
    const budgetExhausted = (error as any)?.code === 'TOTAL_TIMEOUT' && !parentSignal.aborted
    if (budgetExhausted) {
      /*
       * Running out of the round budget is not a task failure.
       *
       * This used to be indistinguishable from a real failure: the child that
       * happened to be running was recorded as `blocked` with “总执行超时”, the
       * cascade blocked everything downstream, and the dashboard showed
       * “0/N 做好了 · N 卡住了” — the exact symptom users reported as a stall.
       * Keep unfinished work `pending` so the next dispatch simply continues,
       * and mark the plan `paused` so the card can say why.
       */
      /*
       * Reset through `applyStatus`, not by hand.
       *
       * The previous hand-written spread kept `progress`, `startedAt` and
       * `childId` of the aborted attempt, so a re-queued subtask shipped as
       * `{status:'pending', progress:100, childId:'…'}`. The task list then said
       * “还没开始” while the counters and the progress bar said 100 % — one of
       * the contradictions reported against 1.4.2. `applyStatus` is the single
       * definition of what `pending` means, so the reset goes through it; the
       * explicit `error` stays as the reason the round stopped.
       */
      let reset = record.statuses
      for (const item of record.statuses) {
        if (item.status === 'done') continue
        reset = applyStatus(reset, item.subtaskId, {
          status: 'pending',
          error: '本轮预算用尽，等待续跑',
        })
      }
      record.statuses = reset
      const total = record.statuses.length
      const done = record.statuses.filter((item: any) => item.status === 'done').length
      /*
       * [1.5.2] 预算到点 ≠ 一定是「暂停」。
       *
       * 旧代码在这里无条件 `record.phase = 'paused'`：如果最后一个子任务恰好在
       * 截止时刻之后完成（done === total），计划会以 14/14、progress=100 的载荷
       * 带着 paused 返回，界面就是「100% + 预算用完，可续跑」（T5 C4）。
       * 全部完成时直接进终态，并且不再写「其余 0 项保留为未完成」这种自相矛盾的说明。
       */
      const allDoneNow = total > 0 && done === total
      record.phase = allDoneNow ? 'done' : 'paused'
      const minutes = Math.max(1, Math.round((options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) / 60000))
      record.error = allDoneNow
        ? null
        : `本轮执行预算（${minutes} 分钟）已到：已完成 ${done}/${total}，其余 ${total - done} 项保留为未完成，再次派发本计划即可续跑（已完成的不重跑）`
      /*
       * Drop the failure lines the aborted children wrote on their way out.
       * They used to survive into the result payload as
       * `["T4: 总执行超时", "总执行超时", …]`, so the model read a failure
       * report for subtasks that were explicitly *not* failures.
       */
      record.errors = (record.errors ?? []).filter((line: string) => !/总执行超时/.test(String(line)))
      if (!allDoneNow) record.errors = [...record.errors, record.error].slice(-20)
    } else {
      /*
       * `blocked` is a terminal state, so it always reports progress 100 — the
       * same rule the other four blocked writers follow. Carrying the partial
       * number over (`item.progress ?? 0`) made one failure show up as 0 %, 15 %
       * or 100 % depending on which branch happened to write it.
       */
      record.statuses = record.statuses.map((item: any) => {
        if (item.status === 'pending' || item.status === 'in_progress') {
          return {
            ...item,
            status: 'blocked',
            progress: 100,
            error: truncate(message, 2000),
            finishedAt: item.finishedAt ?? Date.now(),
          }
        }
        return item
      })
      record.phase = parentSignal.aborted ? 'cancelled' : 'blocked'
    }
  } finally {
    clearTimeout(totalTimer)
    parentSignal.removeEventListener('abort', onAbort)
    if (!childController.signal.aborted) childController.abort()
    record.updatedAt = Date.now()
  }
  return record
}

/*
 * [1.6.0] 会话「这一轮到底还在不在跑」的唯一事实源。
 *
 * 事故（session-7129faea…）：会话早已结束，面板仍把计划列在「进行中」组，
 * 卡片写着「预算用完，可续跑」——没有任何东西在跑，状态却表示正在跑。
 *
 * 根因：插件只订阅 `agent/pre-step`，`turn/end`、`session/disposed` 全都收不到；
 * 计划状态因此只由「派发结果」驱动，而派发结束后不再有任何事件把它收敛。
 *
 * 修复不引入第二个事件订阅（跨 scope 的事件投递受 scope 过滤，不可靠；而且
 * 订阅只覆盖实时路径，刷新/重启后全靠回放，两条链路一旦不同源就会来回翻转）。
 * 这里直接读会话日志本身——它既是实时事实，也是回放事实：
 *
 *  - 从末尾向前找最近的一条「轮次边界」事件：先遇到 `turn/end` ⇒ 这一轮已结束；
 *    先遇到 `turn/start` ⇒ 这一轮还开着；都没找到 ⇒ 未知，调用方保持原判定。
 *  - 不存在「会话已结束」这种事件：宿主只有每轮 `turn/end`。因此**不能**把
 *    `turn/end` 直接等同于「计划取消/完成」——一轮结束后可以随时续跑，这也是
 *    卡片提供「可续跑」的原因。它只证明「此刻没有东西在跑」。
 *  - 向后扫描设上限，避免越界；超过上限就返回 unknown，绝不猜测。
 */
const TURN_BOUNDARY_SCAN = 200

export function sessionTurnState(session: any) {
  const total = Number(session?.seq)
  if (!Number.isFinite(total) || total <= 0 || typeof session?.eventAt !== 'function') {
    return { state: 'unknown', reason: null, reasonDetail: null, at: null }
  }
  const floor = Math.max(0, Math.floor(total) - TURN_BOUNDARY_SCAN)
  for (let seq = Math.floor(total) - 1; seq >= floor; seq -= 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return { state: 'unknown', reason: null, reasonDetail: null, at: null }
    }
    if (!event) continue
    if (event.type === 'turn/start') return { state: 'open', reason: null, reasonDetail: null, at: null }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason ?? null
      const detail = reason && reason.kind === 'aborted' ? (reason.reason?.kind ?? null) : null
      const at = Number(event.time)
      return {
        state: 'ended',
        reason: typeof reason?.kind === 'string' ? reason.kind : 'completed',
        reasonDetail: typeof detail === 'string' ? detail : null,
        at: Number.isFinite(at) ? at : null,
      }
    }
  }
  return { state: 'unknown', reason: null, reasonDetail: null, at: null }
}

/*
 * [1.8.4] 回合已经结束 ⇒ 没有任何子任务还可能在跑。
 *
 * `turn/end` 之后仍残留 `in_progress` 只有两种来源：派发被进程退出/崩溃打断，
 * 或者某次状态写入没有配对收尾。无论哪种，把「正在做」原样留在载荷里都会让同一张
 * 卡片同时说出「已结束」和「正在做」（本次事故截图的第二处矛盾：卡片已经在
 * 「已结束」组里，第 4 步却写着「正在做」）。这里把这些条目改判为 `blocked`
 * （＝需要人来续跑），保留原进度与已有错误说明，只在没有说明时补一句人话。
 *
 * 不引入 `Date.now()`：回放路径必须与实时路径给出同一结论，所以这份载荷
 * 只依赖输入数组，不依赖当前时间。
 */
const STALE_INFLIGHT_NOTE = '本轮结束时这一步仍未完成，没有拿到结果；可以续跑。'
function settleStaleInflight(raw: any): any {
  const list = Array.isArray(raw) ? raw : []
  if (!list.some((item: any) => item?.status === 'in_progress')) return raw
  return list.map((item: any) =>
    item?.status === 'in_progress'
      ? {
          ...item,
          status: 'blocked',
          error: typeof item.error === 'string' && item.error.trim() !== '' ? item.error : STALE_INFLIGHT_NOTE,
        }
      : item
  )
}

function serialisePlan(record: any, session: any) {
  const plan = record.plan ?? null
  /*
   * [1.8.4] 先问「此刻还有没有东西在跑」，再决定这份载荷允不允许宣告结束。
   *
   * `record.dispatchPromise` 是插件内部唯一的权威存活信号：派发时赋值，
   * `.finally()` 里置空（见 dispatchTool）。1.7.0 引入 async 派发后，宿主会在
   * 派发真正结束**之前**就写下 `turn/end`：事故截图里 20:06:33 卡片已经
   * 「已结束」，而同一计划的派发一直跑到 20:22:50 才写入结果消息。也就是说
   * 「回合结束」不等于「没有东西在跑」——把前者当成结束证据，就是本次
   * 「已结束 ∧ 正在做」的根因。存活信号在这里读一次，下面所有「收敛为 ended」
   * 的判断都必须经过它。
   */
  const liveDispatch = Boolean(record.dispatchPromise)
  const turn = liveDispatch ? null : sessionTurnState(session)
  const turnEnded = turn?.state === 'ended'
  /*
   * Counts are derived here, once, from the very array that is shipped.
   *
   * `stats` used to be read from `record.stats`, a cache refreshed only between
   * dispatch batches, while `departments` below was aggregated live. The same
   * payload could therefore report “0 正在做” in the header while a stage badge
   * built from `statuses` said otherwise. Deriving both from one normalised
   * snapshot makes that contradiction structurally impossible.
   */
  const rawStatuses =
    Array.isArray(record.statuses) && record.statuses.length > 0
      ? record.statuses
      : plan
        ? createStatuses(plan)
        : []
  const snapshot = derivePlanSnapshot(turnEnded ? settleStaleInflight(rawStatuses) : rawStatuses)
  const statuses = snapshot.statuses
  const stats = snapshot.stats
  /*
   * [1.5.2] 出口对账，而不是无条件相信内存缓存。
   *
   * 旧写法 `record.phase ?? planPhase(statuses)` 让缓存一旦存在就完全绕过
   * statuses：一次 `updateStatus` 把计划写成 integrating 之后，即使 14/14 全部
   * 完成，下发的 phase 仍是 integrating，界面于是「100% + 正在收尾」。这里改成
   * `reconcilePhase`：全部完成一律 done，缓存过期的 done/integrating 回退到派生值。
   */
  let phase = reconcilePhase(record.phase ?? (plan ? planPhase(statuses) : 'degraded'), statuses)
  if (phase === 'pending' && !record.dispatchedAt && plan?.createdAt && Date.now() - plan.createdAt > STALE_PENDING_MS) {
    phase = 'cancelled'
  }
  /*
   * [1.6.0] 终态收敛：这一轮已经结束，而计划没有完成 ⇒ 不许再显示「进行中」。
   *
   * `phase` 到这里为止只由「派发动作」写入（executing / paused / blocked …），
   * 而派发结束后没有任何事件把它改回来，于是会话结束、进程空闲、面板却仍在
   * 「进行中」组里（事故截图）。上面 `sessionTurnState` 用会话日志回答
   * 「此刻还有没有东西在跑」，这里把答案落成独立阶段 `ended`：
   *
   *  - done / cancelled 已经是终态，不再改写（done 改写会直接违反不变量 I8）；
   *  - 其余阶段一律收敛为 `ended`，并把原阶段留在 `suspendedPhase` 里，
   *    卡片因此仍能显示「预算用完，可续跑」「卡住了」这类二级事实，不丢信息；
   *  - 只改**下发出去的那一份**，不动 `record.phase`：用户说「继续」后同一轮
   *    重新开始（日志里出现新的 turn/start），下一份 payload 自然回到原来的
   *    派发状态，不需要任何反向迁移逻辑；
   *  - 实时路径与回放路径都经过本函数，因此刷新前后结论必然一致（T4 硬约束）。
   *
   * [1.8.4] 前置门：只有 `turnEnded && !liveDispatch` 才准许收敛。存活信号为真时
   * 「回合已结束」仅仅说明宿主本轮不再收新消息，派发仍在跑，卡片必须继续显示
   * 真实阶段（正在做 / 预算用完），不许降级成 ended。
   */
  let suspendedPhase: any = null
  let endReason: any = null
  let endReasonDetail: any = null
  let endedAt: any = null
  if (turnEnded && phase !== 'done' && phase !== 'cancelled') {
    suspendedPhase = phase
    endReason = turn.reason
    endReasonDetail = turn.reasonDetail
    endedAt = turn.at
    phase = 'ended'
  }
  /*
   * 每次真正下发前跑一遍跨字段不变量（I1–I11）。正常情况下恒为空；一旦某个
   * 未来改动重新引入「进度与状态打架」，这里会把它连同具体字段值一起带出去，
   * 而不是等用户截图发现。附在 payload 上而不是抛错：展示层不应因自检而白屏。
   */
  const violations = aggregateInvariantViolations(snapshot, phase)
  return {
    sessionId: session.id,
    planId: record.planId ?? plan?.planId ?? null,
    title: plan?.title ?? record.title ?? '任务进度',
    phase,
    ...(phase === 'ended' ? { suspendedPhase, endReason, endReasonDetail, endedAt } : {}),
    ...(violations.length ? { violations } : {}),
    degraded: record.degraded === true,
    error: record.error ? truncate(record.error, 2000) : null,
    errors: (record.errors ?? []).slice(-20),
    createdAt: record.createdAt ?? plan?.createdAt ?? session.header.createdAt,
    updatedAt: record.updatedAt ?? Date.now(),
    createdTurn: plan?.createdTurn ?? record.createdTurn ?? null,
    plan,
    statuses,
    stats,
    /*
     * Liveness and resume bookkeeping. Without these the dashboard could not
     * tell a slow-but-alive child from a wedged one, and the model could not
     * tell whether dispatch would actually run anything.
     */
    heartbeatAt: record.heartbeatAt ?? null,
    /*
     * [1.8.4] 存活事实跟着载荷一起下发。
     *
     * 之前只有模型侧 tool 结果带 `running`，面板拿不到，只能靠 `phase` 猜
     * 「有没有东西在跑」；而 phase 既可能滞后（派发已结束、状态没回写），
     * 也可能过早（回合结束、派发还在跑）。把存活信号原样交给展示层，
     * 「已结束」与「正在做」就不可能再从两条互不知情的数据里各说各话。
     */
    running: liveDispatch,
    resumeCount: Number(record.resumeCount ?? 0),
    resumeLimit: Number(record.resumeLimit ?? MAX_PLAN_RESUMES),
    resumeAvailable: record.plan
      ? canResumePlan(record, Number(record.resumeLimit ?? MAX_PLAN_RESUMES)).resume
      : false,
    dispatchElapsedMs: record.dispatchStartedAt ? Date.now() - record.dispatchStartedAt : null,
    departments: snapshot.departments,
    taskUnderstanding: plan?.taskUnderstanding ?? record.taskUnderstanding ?? null,
    contradictions: plan?.contradictions ?? null,
    stages: plan?.stages ?? [],
    risks: plan?.risks ?? [],
    verification: plan?.verification ?? [],
    practiceLoop: plan?.practiceLoop ?? null,
  }
}

function readToolArguments(value: any) {
  if (isRecord(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

export function reconstructFromSession(session: any, targetPlanId?: string) {
  const start = Math.max(0, session.seq - MAX_HISTORY_EVENTS)
  let plan: any = null
  let statuses: any[] = []
  let degraded: any = null
  let resultSeen = false
  // A round-budget pause must survive a page refresh; otherwise the replayed
  // plan looks “executing” forever (nothing is running) and the card stops
  // telling the user it can simply be dispatched again.
  let resultPhase = ''
  let cancelled = false
  let resumeCount = 0
  /*
   * Older plans stay dispatchable.
   *
   * The replayed state used to be "whatever the newest plan message says", so a
   * plan paused before a restart became unreachable the moment the next turn
   * generated a new plan: the rebuild answered with the new plan and every
   * dispatch of the old one failed with PLAN_ID_MISMATCH. Keep a snapshot per
   * plan and let the caller ask for a specific one.
   */
  const finished: any[] = []
  /** [1.6.0] callId → 待确认的 update 写入；只有配对的 tool/result 才能定案。 */
  const pendingToolCalls = new Map<string, any>()
  const snapshot = () => ({ plan, statuses, resultPhase, resultSeen, resumeCount, cancelled })
  for (let seq = start; seq < session.seq; seq += 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (!event) continue
    if (event.type === 'user/message') {
      const payload = parseWorkplanMessage(event.data)
      if (payload?.degraded) {
        degraded = payload
        plan = null
        statuses = []
        cancelled = false
      } else if (payload?.plan) {
        if (plan) finished.push(snapshot())
        plan = payload.plan
        statuses = createStatuses(plan)
        cancelled = false
        /*
         * A new plan must not inherit the previous plan's round phase.
         *
         * `resultPhase` outlived the old plan, so after a paused plan the next
         * plan in the same session replayed as `paused` before its first
         * dispatch — the card claimed the new plan was out of budget when it had
         * not started. Only a result message for *this* plan may set it.
         */
        resultPhase = ''
        resultSeen = false
        resumeCount = 0
      }
      const result = parseResultMessage(event.data)
      if (result && plan && result.planId === plan.planId) {
        statuses = applyResultStatuses(statuses, result)
        // Resume bookkeeping must survive a page refresh, otherwise the budget
        // silently resets and a never-succeeding subtask can loop forever.
        resumeCount = Number(result.resumeCount ?? resumeCount) || 0
        resultPhase = typeof result.phase === 'string' ? result.phase : ''
        resultSeen = true
      }
      /*
       * [1.7.0] Manual re-adjudications replay in order.
       *
       * `dsh_workplan_update` used to live only in the live cache, so a refresh
       * reverted the dashboard to the child's original verdict. The durable
       * `workplan-update` message is small and append-only, so replay is just
       * "apply it when its turn comes"; a lower revision never overwrites a
       * newer one (see `applyResultStatuses`).
       */
      const update = parseUpdateMessage(event.data)
      if (update && plan && update.planId === plan.planId && typeof update.subtaskId === 'string') {
        try {
          statuses = applyStatus(statuses, update.subtaskId, {
            status: update.status,
            progress: typeof update.progress === 'number' ? update.progress : undefined,
            summary: typeof update.note === 'string' ? update.note : undefined,
            revision: Number.isInteger(update.revision) ? update.revision : undefined,
            updatedBy: 'agent',
          })
        } catch {
          // An invalid historical update is ignored; the rest still replays.
        }
      }
      const cancel = parseCancelMessage(event.data)
      if (cancel && plan && cancel.planId === plan.planId) {
        cancelled = true
      }
    } else if (event.type === 'tool/call' && plan) {
      /*
       * [1.6.0] 只登记，不下结论。
       *
       * 回放原来一见到 `dsh_workplan_update` 的调用就 applyStatus，但调用发起不等于
       * 状态写入成功：宿主的 tool/result 带着 `message.isError`。会话
       * session-7129faea 里就有一次失败的 update 被回放记成完成，于是刷新后面板显示
       * 7/12，而真实只完成 6/12 —— 回放比实时“更乐观”，这是第二个数据源打架点。
       * 现在一律等对应的 tool/result：成功才采纳，失败或没有结果都不采纳。
       */
      const data = event.data
      if (data?.name === 'dsh_workplan_update' && typeof data.callId === 'string') {
        const args = readToolArguments(data.arguments)
        if (args && typeof args.subtaskId === 'string' && typeof args.status === 'string') {
          pendingToolCalls.set(data.callId, { args, planId: plan.planId })
        }
      }
    } else if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.role === 'tool' ? message.toolCallId : null
      if (typeof callId !== 'string') continue
      const pending = pendingToolCalls.get(callId)
      pendingToolCalls.delete(callId)
      if (!pending || !plan || pending.planId !== plan.planId) {
        // 结果晚于新计划到达：旧计划的写入不污染新计划的状态表。
      } else if (message.isError === true) {
        // 失败的更新不是完成：状态表保持原样。
      } else {
        const args = pending.args
        try {
          statuses = applyStatus(statuses, args.subtaskId, {
            status: args.status,
            progress: typeof args.progress === 'number' ? args.progress : undefined,
            summary: typeof args.note === 'string' ? args.note : undefined,
          })
        } catch {
          // An invalid historical call is ignored; the live cache remains authoritative.
        }
      }
    }
  }
  if (!plan && !degraded) return null
  if (degraded) {
    return {
      plan: null,
      planId: degraded.planId ?? null,
      title: degraded.title ?? '自动分解降级',
      degraded: true,
      error: degraded.error ?? null,
      statuses: [],
      phase: 'degraded',
      createdAt: degraded.createdAt ?? session.header.createdAt,
      updatedAt: degraded.createdAt ?? session.header.createdAt,
      createdTurn: degraded.createdTurn ?? null,
    }
  }
  if (!plan) return null
  if (targetPlanId && plan.planId !== targetPlanId) {
    const hit = finished.find((item: any) => item.plan?.planId === targetPlanId)
    if (!hit) return null
    ;({ plan, statuses, resultPhase, resultSeen, resumeCount, cancelled } = hit)
  }
  let phase = planPhase(statuses, resultSeen)
  if (resultPhase === 'paused' && statuses.some((item: any) => item.status !== 'done')) phase = 'paused'
  if (cancelled) phase = 'cancelled'
  /*
   * [1.5.2] 回放也必须走同一套对账。
   *
   * 回放曾经因为 `resultSeen=true`（结果消息在会话里）得到 done，而同一时刻的
   * 实时缓存因为没有这个副作用得到 integrating —— 同一个会话刷新前后翻转。
   * `reconcilePhase` 让两条链路都以 statuses 为准：全部完成即 done（包括历史上
   * 「先完成、后收到取消消息」的会话，不再出现「100% + 已取消」）。
   */
  phase = reconcilePhase(phase, statuses)
  /*
   * An old plan that was never dispatched used to be relabelled `cancelled`,
   * which also made it permanently unresumable — the card said "已取消" and no
   * amount of dispatching would move it. Keep it `pending`, and expose the age
   * as a separate flag so the UI can prompt instead of silently closing it.
   */
  const stalePending = phase === 'pending' && Boolean(plan.createdAt)
    && Date.now() - Number(plan.createdAt) > STALE_PENDING_MS
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    degraded: false,
    error: null,
    statuses,
    phase,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    createdTurn: plan.createdTurn,
    resumeCount,
    resumeLimit: MAX_PLAN_RESUMES,
    resumeAvailable: canResumePlan({ phase, statuses, resumeCount }, MAX_PLAN_RESUMES).resume,
    stale: stalePending,
  }
}

function liveSessions(ctx: any) {
  try {
    const sessions = ctx.sessions?.list?.()
    return Array.isArray(sessions) ? sessions : []
  } catch {
    return []
  }
}

function findSession(ctx: any, sessionId: any) {
  try {
    const session = ctx.sessions?.get?.(sessionId) ?? null
    return session && isRootSession(session) ? session : null
  } catch {
    return null
  }
}

export function buildPlansPayload(ctx: any, state: any, sessionId: any) {
  let sessions = liveSessions(ctx).filter((session: any) => isRootSession(session))
  if (sessionId) {
    const match = sessions.find((session: any) => session.id === sessionId) ?? findSession(ctx, sessionId)
    sessions = match ? [match] : []
  }
  sessions.sort((a: any, b: any) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))
  sessions = sessions.slice(0, MAX_LIVE_SESSIONS)
  const items: any[] = []
  for (const session of sessions) {
    let record = state.records.get(session.id)
    if (!record) record = reconstructFromSession(session)
    if (!record) continue
    items.push(serialisePlan(record, session))
  }
  return { ok: true, now: Date.now(), sessions: items }
}

/**
 * Fixed hardening headers for every response this plugin serves.
 *
 * Two routes are exposed to the DSH web server: the JSON plan feed and the
 * vendored Chart.js file. Neither needs the browser to sniff a type, and a
 * dashboard URL carries a session id, so it must not leak through `Referer`
 * to anything the user clicks afterwards. Set once per response, before any
 * `writeHead`, so a later `writeHead(status, headers)` cannot drop them.
 */
export const HARDENING_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
})

export function applyHardeningHeaders(res: any) {
  if (typeof res?.setHeader !== 'function') return
  for (const [name, value] of Object.entries(HARDENING_HEADERS)) {
    res.setHeader(name, value)
  }
}

function respondJson(res: any, status: any, payload: any) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  if (res.req?.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

export type WorkplanRuntimeOptions = {
  cwd?: string
  /** Absolute ceiling per child execution, clamped by `normaliseChildTimeout`. */
  childTimeoutMs?: number
  /** No-progress window per child execution, clamped by `normaliseIdleTimeout`. */
  idleTimeoutMs?: number
  /** Whole-plan budget. */
  totalTimeoutMs?: number
  /** How many times a blocked plan may be resumed. */
  maxResumes?: number
}

export function createWorkplanRuntime(ctx: any, options: WorkplanRuntimeOptions = {}) {
  const state = { records: new Map() }
  /*
   * Resolve the tunables once, at construction, so every code path (dispatch,
   * resume, cancel, the host's tool timeout) agrees on the same numbers.
   */
  const limits = {
    childTimeoutMs: normaliseChildTimeout(options.childTimeoutMs),
    idleTimeoutMs: normaliseIdleTimeout(options.idleTimeoutMs),
    totalTimeoutMs: Number.isFinite(Number(options.totalTimeoutMs)) && Number(options.totalTimeoutMs) > 0
      ? Math.max(60000, Math.floor(Number(options.totalTimeoutMs)))
      : TOTAL_TIMEOUT_MS,
    maxResumes: Number.isFinite(Number(options.maxResumes)) && Number(options.maxResumes) >= 0
      ? Math.min(5, Math.floor(Number(options.maxResumes)))
      : MAX_PLAN_RESUMES,
  }

  async function onPreStep(payload: any, next: any) {
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      throw error
    }
    if (downstream?.kind !== 'enter') return downstream
    try {
      return await maybePlan(ctx, state, payload, downstream, { ...options, limits })
    } catch (error) {
      try {
        const session = payload.agent?.session
        const planId = `wp-${randomUUID()}`
        const message = buildDegradedMessage({
          planId,
          sessionId: session?.id ?? 'unknown',
          createdTurn: payload.turn,
          createdAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
          taskText: taskTextFromMessages(payload.messages),
        })
        if (session) {
          state.records.set(session.id, {
            planId,
            plan: null,
            title: '自动分解降级',
            degraded: true,
            error: error instanceof Error ? error.message : String(error),
            statuses: [],
            phase: 'degraded',
            errors: [truncate(String(error), 1000)],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            createdTurn: payload.turn,
          })
        }
        return enterDecision(downstream, [message])
      } catch {
        return downstream
      }
    }
  }

  async function updateStatus(agent: any, args: any) {
    const session = agent?.session
    if (!session) throw new PlanError('只能在会话内更新计划', 'NO_SESSION')
    if (!isRootSession(session)) throw new PlanError('子 Agent 不能更新主计划', 'NOT_ROOT')
    const record = state.records.get(session.id)
    if (!record?.plan) throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN')
    if (args?.planId && record.plan.planId !== args.planId) {
      throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH')
    }
    const subtaskId = typeof args?.subtaskId === 'string' ? args.subtaskId : ''
    if (!subtaskId) throw new PlanError('缺少 subtaskId', 'MISSING_SUBTASK')
    const status = typeof args?.status === 'string' ? args.status : ''
    if (!['pending', 'in_progress', 'done', 'blocked'].includes(status)) {
      throw new PlanError('status 必须是 pending / in_progress / done / blocked', 'INVALID_STATUS')
    }
    const note = typeof args?.note === 'string' ? args.note : ''
    const evidence = Array.isArray(args?.evidence)
      ? args.evidence.filter((item: any) => typeof item === 'string').join('；')
      : ''
    const summary = [note, evidence].filter(Boolean).join('｜')
    const current = record.statuses.find((item: any) => item.subtaskId === subtaskId)
    /*
     * [1.7.0] Two write guards, both non-throwing.
     *
     * 1. A stale revision means the caller is looking at an older snapshot; the
     *    write is refused instead of silently overwriting newer evidence.
     * 2. While the plan is running, the child owns the status of the subtask it
     *    is executing. An agent edit would race the child's settlement (and the
     *    child would overwrite it back). `force:true` is the explicit override,
     *    recorded as a manual re-adjudication.
     */
    if (Number.isInteger(args?.expectedRevision) && (current?.revision ?? 0) !== args.expectedRevision) {
      return {
        ok: false,
        code: 'STALE_WRITE',
        planId: record.plan.planId,
        subtaskId,
        current: {
          status: current?.status ?? null,
          revision: current?.revision ?? 0,
          updatedBy: current?.updatedBy ?? null,
        },
        hint: `该子任务已被更新（当前 revision ${current?.revision ?? 0}，你基于 ${args.expectedRevision}）；请重新读取状态后再改。`,
      }
    }
    const running = Boolean(record.dispatchPromise)
    const writeWhileRunning = running && !args?.force && (current?.status === 'pending' || current?.status === 'in_progress')
    if (writeWhileRunning) {
      return {
        ok: false,
        code: 'TASK_RUNNING',
        planId: record.plan.planId,
        subtaskId,
        current: {
          status: current?.status ?? null,
          revision: current?.revision ?? 0,
          updatedBy: current?.updatedBy ?? null,
        },
        hint: '该子任务正在执行；请等待本轮结束，或传 force:true 覆盖（会被记录为人工改判）。',
      }
    }
    const revision = Number(current?.revision ?? 0) + 1
    record.statuses = applyStatus(record.statuses, subtaskId, {
      status,
      progress: typeof args?.progress === 'number' ? args.progress : undefined,
      summary: summary || undefined,
      error: status === 'blocked' ? (summary || '由主 Agent 标记为受阻') : undefined,
      revision,
      updatedBy: 'agent',
    })
    if (status === 'blocked') {
      record.statuses = markDependentsBlocked(record.plan, record.statuses, subtaskId, { reason: summary || '主 Agent 标记受阻' })
    }
    /*
     * [1.7.0] A re-adjudication is durable.
     *
     * `applyStatus` only touched the in-memory record, so after a refresh the
     * manual verdict vanished and the dashboard fell back to the old child
     * result. Appending one small message keeps the replay path honest.
     */
    try {
      session.append('user/message', buildUpdateMessage({
        planId: record.plan.planId,
        subtaskId,
        status,
        progress: typeof args?.progress === 'number' ? args.progress : undefined,
        note: summary || undefined,
        revision,
      }), { surfaceOp: 'append' })
    } catch (error) {
      pushRecordError(record, error)
    }
    /*
     * [1.5.2] 这里曾是「100% + 正在收尾」的直接入口。
     *
     * 旧代码 `record.phase = planPhase(record.statuses)` 用不到 `resultSeen`，
     * 所以主 Agent 用 update 工具补完最后一项时得到的 phase 永远是 integrating；
     * 而这条路径之后不会再派发，也就永远不会写结果消息把它晋升为 done。
     * 走 `reconcilePhase` 后，全部完成即 done，且已 done 的计划不会被一次
     * 空更新打回 integrating（T4 实测 A.2 的回退路径）。
     */
    record.phase = reconcilePhase(record.phase, record.statuses)
    record.updatedAt = Date.now()
    const snapshot = derivePlanSnapshot(record.statuses)
    const written = snapshot.statuses.find((item: any) => item.subtaskId === subtaskId)
    return {
      ok: true,
      planId: record.plan.planId,
      subtaskId,
      status: written?.status ?? status,
      revision: written?.revision ?? revision,
      updatedBy: written?.updatedBy ?? 'agent',
      stats: snapshot.stats,
    }
  }

  async function cancelPlan(agent: any, args: any) {
    const session = agent?.session
    if (!session) throw new PlanError('只能在会话内取消计划', 'NO_SESSION')
    if (!isRootSession(session)) throw new PlanError('子 Agent 不能取消主计划', 'NOT_ROOT')
    let record = state.records.get(session.id)
    if (!record?.plan) record = reconstructFromSession(session)
    if (!record?.plan) throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN')
    if (args?.planId && record.plan.planId !== args.planId) {
      throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH')
    }
    const reason = typeof args?.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : '用户取消'
    /*
     * [1.5.2] 已完成即终态：取消不再把 100% 的计划改写成「已取消」。
     *
     * T4 实测 A.4：2/2 全部 done 的计划被取消后会得到 `phase=cancelled` +
     * `done=2/2` + `percent=100` —— 又一个「一边说全好了、一边说被取消」的
     * 自相矛盾组合，且会让本可续跑/查看的完成记录永远退出「已完成」组。
     * 这里直接把取消变成 no-op 并如实返回 done。
     */
    const before = derivePlanSnapshot(record.statuses)
    if (before.stats.total > 0 && before.stats.done === before.stats.total) {
      record.phase = 'done'
      record.updatedAt = Date.now()
      state.records.set(session.id, record)
      return {
        ok: true,
        planId: record.plan.planId,
        phase: 'done',
        reason,
        alreadyDone: true,
        abortedRunning: false,
        stats: before.stats,
      }
    }
    if (record.dispatchPromise) {
      /*
       * Cancel must always work.
       *
       * Refusing with "计划正在执行，不能取消" meant a wedged dispatch could not
       * be stopped at all: the tool that would stop it refused while the thing
       * it needed to stop was running. Abort the running dispatch and let it
       * settle as cancelled; the in-flight result message is still written, so
       * no partial work is lost.
       */
      record.phase = 'cancelled'
      record.error = `计划已取消：${reason}`
      record.updatedAt = Date.now()
      let aborted = false
      try {
        record.abortDispatch?.(reason)
        aborted = true
      } catch (error: any) {
        record.errors = [...(record.errors ?? []), `取消时中止执行失败：${String(error?.message ?? error)}`].slice(-20)
      }
      return {
        ok: true,
        planId: record.plan.planId,
        phase: 'cancelled',
        reason,
        abortedRunning: aborted,
        stats: derivePlanSnapshot(record.statuses).stats,
      }
    }
    record.phase = 'cancelled'
    record.error = `计划已取消：${reason}`
    record.updatedAt = Date.now()
    const message = buildCancelMessage(record.plan.planId, reason)
    session.append('user/message', message, { surfaceOp: 'append' })
    state.records.set(session.id, record)
    return {
      ok: true,
      planId: record.plan.planId,
      phase: 'cancelled',
      reason,
      stats: derivePlanSnapshot(record.statuses).stats,
    }
  }

  /**
   * Persist the round result and settle the phase.
   *
   * Extracted from the wait path so an async dispatch reaches exactly the same
   * end state: a durable result message plus a reconciled phase. Anything less
   * would make "start now, read later" a second, divergent code path.
   */
  function finishRound(record: any, session: any) {
    if (!record.resultWritten) {
      const resultMessage = buildRoundResult(record, session.id, limits)
      try {
        session.append('user/message', resultMessage, { surfaceOp: 'append' })
        record.resultWritten = true
      } catch (error) {
        ctx.logger?.warn?.(`dsh-workplan: 写入结果消息失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    /*
     * [1.5.2] 终态不再依赖「结果消息写成功」这个副作用。
     *
     * 旧代码只有 `record.resultWritten === true` 时才把 phase 升成 done，
     * 于是 session.append 抛错（或该轮根本没有派发）就会永久停在 integrating。
     * 完成语义由 statuses 决定；结果消息只负责持久化，不负责定义完成。
     */
    record.phase = reconcilePhase(record.phase, record.statuses)
    return record
  }

  function dispatchSnapshotOf(record: any, extra: any = {}) {
    const snapshot = derivePlanSnapshot(record.statuses)
    return {
      ok: true,
      planId: record.plan.planId,
      alreadyRunning: false,
      ...extra,
      phase: record.phase,
      stats: snapshot.stats,
      statuses: modelStatusLines(snapshot.statuses),
    }
  }

  /**
   * Read-only progress probe for the main Agent.
   *
   * With async dispatch the model no longer blocks until the round ends, so it
   * needs a supported way to answer "做成什么样了" without guessing. This is the
   * only source it should read: same `derivePlanSnapshot` as the dashboard and
   * the result message, so all three cannot disagree.
   */
  async function statusTool(agent: any, args: any) {
    const session = agent?.session
    if (!session) throw new PlanError('只能在会话内查看计划', 'NO_SESSION')
    const requestedPlanId = typeof args?.planId === 'string' ? args.planId : undefined
    let record = state.records.get(session.id)
    if (!record?.plan || (requestedPlanId && record.plan.planId !== requestedPlanId)) {
      const rebuilt = reconstructFromSession(session, requestedPlanId)
      if (rebuilt?.plan) record = rebuilt
    }
    if (!record?.plan) {
      return {
        ok: false,
        code: 'NO_PLAN',
        running: false,
        error: '当前会话没有可查看的计划',
        hint: '先让本轮生成计划并调用 dsh_workplan_dispatch。',
      }
    }
    const running = Boolean(record.dispatchPromise)
    const snapshot = derivePlanSnapshot(record.statuses)
    return {
      ok: true,
      planId: record.plan.planId,
      running,
      phase: record.phase,
      elapsedMs: record.dispatchStartedAt ? Date.now() - record.dispatchStartedAt : null,
      stats: snapshot.stats,
      statuses: modelStatusLines(snapshot.statuses),
      errors: (record.errors ?? []).slice(-10),
      resumeLimit: Number(record.resumeLimit ?? limits.maxResumes),
      ...(running
        ? { hint: '计划仍在执行：先向用户报告进度，不要声称完成；等结果消息出现后再逐项核对证据。' }
        : { hint: '当前没有正在执行的派发。若仍有 pending/blocked，可再次调用 dsh_workplan_dispatch 续跑。' }),
    }
  }

  async function dispatchTool(agent: any, args: any, signal: any) {
    const session = agent?.session
    if (!session) throw new PlanError('只能在会话内派发计划', 'NO_SESSION')
    if (!isRootSession(session)) throw new PlanError('子 Agent 不能派发主计划', 'NOT_ROOT')
    let record = state.records.get(session.id)
    const requestedPlanId = typeof args?.planId === 'string' ? args.planId : undefined
    /*
     * Rebuild when memory has no record **or** when the caller names a plan
     * that memory does not hold.
     *
     * 1.3.6 only covered the empty-memory case. The real restart test then hit
     * the other half: a restart does empty memory, but the very next turn's
     * planner immediately builds a *new* plan, so by the time the user asks for
     * the old paused plan memory holds the new one and the dispatch answered
     * `planId 与当前计划不匹配` — exactly the same dead end, one layer down.
     * A named plan that exists in the session log is dispatchable, whoever is
     * currently in memory.
     */
    const needsRebuild = !record?.plan || Boolean(requestedPlanId && record.plan.planId !== requestedPlanId)
    if (needsRebuild && !record?.dispatchPromise) {
      /*
       * A restarted host has no in-memory record, but the plan is still in the
       * session log.
       *
       * This used to answer `NO_PLAN` — “当前会话没有可派发的计划” — for a plan
       * the user could see on the card. Restarting `dsh web` (the exact step we
       * ask for when verifying a fix) therefore made a paused or blocked plan
       * permanently unresumable, which is a stall of the worst kind: the work is
       * finished on disk, and nothing can continue it.
       */
      const rebuilt = reconstructFromSession(session, requestedPlanId)
      if (rebuilt?.plan) {
        rebuilt.resumeLimit = limits.maxResumes
        state.records.set(session.id, rebuilt)
        record = rebuilt
      }
    }
    if (!record?.plan) throw new PlanError('当前会话没有可派发的计划', 'NO_PLAN')
    if (args?.planId && record.plan.planId !== args.planId) {
      throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH')
    }
    /*
     * [1.7.0] Two dispatch modes.
     *
     * `wait` (default, backward compatible) blocks until the round ends.
     * `async` starts the round and returns immediately, so the main Agent can
     * answer the user and keep integrating instead of sitting blind inside a
     * tool call for twenty minutes (the top-ranked collaboration break C1).
     */
    const mode = args?.mode === 'async' ? 'async' : 'wait'
    if (mode === 'wait' && record.dispatchPromise) {
      /*
       * A wait caller that meets an in-flight round joins it instead of being
       * told "already running" — the old answer carried no results at all, so
       * a model that missed the async result message had nothing to integrate.
       * A wedged promise keeps the old stale escape hatch (see below).
       */
      const startedAt = Number(record.dispatchStartedAt ?? 0)
      const staleAfter = limits.totalTimeoutMs + 120000
      if (!(startedAt > 0 && Date.now() - startedAt > staleAfter)) {
        try {
          await record.dispatchPromise
        } catch (error) {
          pushRecordError(record, error)
        }
        finishRound(record, session)
        state.records.set(session.id, record)
        return dispatchSnapshotOf(record, { joined: true })
      }
    }
    if (record.dispatchPromise) {
      /*
       * "Already running" must not become a permanent answer.
       *
       * If a previous dispatch promise never settles (a wedged child service
       * that ignored its abort signal), every later dispatch would report
       * success-with-nothing-done forever, and the only escape was a new
       * conversation. After the dispatch budget plus a grace period the plugin
       * stops claiming the plan is running and hands the work back instead.
       */
      const startedAt = Number(record.dispatchStartedAt ?? 0)
      const staleAfter = limits.totalTimeoutMs + 120000
      if (startedAt > 0 && Date.now() - startedAt > staleAfter) {
        return {
          ok: false,
          planId: record.plan.planId,
          alreadyRunning: true,
          stale: true,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          phase: record.phase,
          stats: derivePlanSnapshot(record.statuses).stats,
          error: `上一次派发已持续 ${Math.round((Date.now() - startedAt) / 1000)}s 仍未返回，判定为已卡住`,
          hint: '请主 Agent 直接接手完成剩余子任务，不要再次派发；并在答复中说明本次是直接执行而非派发。',
        }
      }
      /*
       * [1.7.0] The idempotent answer now carries the progress itself.
       *
       * It used to say only `alreadyRunning: true`, so a second dispatch gave
       * the model strictly less information than doing nothing.
       */
      const live = derivePlanSnapshot(record.statuses)
      return {
        ok: true,
        planId: record.plan.planId,
        alreadyRunning: true,
        running: true,
        phase: record.phase,
        startedAt: startedAt || null,
        elapsedMs: startedAt ? Date.now() - startedAt : null,
        stats: live.stats,
        statuses: modelStatusLines(live.statuses),
        hint: '计划仍在执行：先向用户报告进度，不要声称完成；用 dsh_workplan_status 查看实时状态。',
      }
    }
    /*
     * Refuse with an explanation instead of silently "succeeding".
     *
     * Re-dispatching an all-blocked plan used to fall straight through to
     * `readySubtasks()`, find nothing ready, and answer `{ ok: true }` without
     * running a single child. The model read that as success, so a plan that hit
     * one timeout could never move again.
     */
    const resume = canResumePlan(record, limits.maxResumes)
    if (record.phase === 'blocked' && resume.failed > 0 && !resume.resume) {
      return {
        ok: false,
        planId: record.plan.planId,
        phase: record.phase,
        resume,
        stats: derivePlanSnapshot(record.statuses).stats,
        error: resume.reason,
        hint: '这些子任务不会再自动重跑，请主 Agent 直接完成它们，并在答复中如实说明哪些未能自动完成。',
      }
    }
    record.dispatchStartedAt = Date.now()
    record.resumeLimit = limits.maxResumes
    const selection = {
      provider: agent?.options?.provider,
      model: agent?.options?.model,
      reasoningEffort: agent?.options?.reasoningEffort,
    }
    /*
     * The dispatch runs under its own controller so a user cancel can actually
     * stop it. Passing the tool's abort signal alone was not enough: cancelling
     * while running was refused outright, which stranded a wedged dispatch.
     */
    const dispatchController = new AbortController()
    const onToolAbort = () => dispatchController.abort(signal?.reason ?? abortError())
    if (signal?.aborted) onToolAbort()
    else signal?.addEventListener?.('abort', onToolAbort, { once: true })
    record.abortDispatch = (reason: string) => {
      if (!dispatchController.signal.aborted) {
        dispatchController.abort(new PlanError(`计划已取消：${reason}`, 'CANCELLED'))
      }
    }
    record.dispatchPromise = dispatchPlan(ctx, record, {
      agent,
      signal: dispatchController.signal,
      modelSelection: selection.provider && selection.model ? selection : record.modelSelection,
      cwd: session.header?.cwd ?? options.cwd,
      conversationContext: record.conversationContext ?? '',
      childTimeoutMs: limits.childTimeoutMs,
      idleTimeoutMs: limits.idleTimeoutMs,
      totalTimeoutMs: limits.totalTimeoutMs,
      maxResumes: limits.maxResumes,
    }).finally(() => {
      record.dispatchPromise = null
      record.dispatchStartedAt = null
      record.abortDispatch = null
      signal?.removeEventListener?.('abort', onToolAbort)
    })
    if (mode === 'async') {
      /*
       * Settlement happens in the background: the same durable result message
       * is appended when the round ends, so a page refresh (or a later turn)
       * still sees the outcome. The returned values are a *starting* snapshot,
       * never a completion claim.
       */
      const startedAt = record.dispatchStartedAt
      record.dispatchPromise
        .then(() => {
          finishRound(record, session)
          state.records.set(session.id, record)
        })
        .catch((error: any) => {
          pushRecordError(record, error)
          finishRound(record, session)
          state.records.set(session.id, record)
        })
      const live = derivePlanSnapshot(record.statuses)
      return {
        ok: true,
        planId: record.plan.planId,
        mode: 'async',
        running: true,
        alreadyRunning: false,
        phase: record.phase,
        startedAt,
        stats: live.stats,
        statuses: modelStatusLines(live.statuses),
        hint: '计划已开跑，尚未完成：先向用户说明“已派发、正在执行”，不要声称完成；'
          + '结果消息会在本轮结束时自动出现，期间可用 dsh_workplan_status 查看进度。',
      }
    }
    await record.dispatchPromise
    finishRound(record, session)
    /*
     * The model's dispatch result reports the same snapshot the dashboard will
     * show. It used to send `record.stats` while the status list below was read
     * fresh, so one reply could say “已完成 11” next to twelve finished rows.
     */
    return dispatchSnapshotOf(record)
  }

  function plansPayload(sessionId: any) {
    return buildPlansPayload(ctx, state, sessionId)
  }

  async function route(req: any, res: any, connectionCtx: any = ctx) {
    applyHardeningHeaders(res)
    let rejection
    try {
      rejection = await Promise.resolve(connectionCtx?.connection?.requestRejection?.(req))
    } catch {
      respondJson(res, 403, { ok: false, error: '未授权的请求' })
      return
    }
    if (rejection) {
      respondJson(res, typeof rejection === 'number' ? rejection : 401, {
        ok: false,
        error: '未授权的请求',
      })
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      respondJson(res, 400, { ok: false, error: '无效的请求地址' })
      return
    }
    if (url.pathname !== '/dsh-workplan/plans') {
      respondJson(res, 404, { ok: false, error: '未找到' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
      res.end()
      return
    }
    try {
      const payload = plansPayload(url.searchParams.get('sessionId') ?? undefined)
      const body = JSON.stringify(payload)
      if (body.length > 2_500_000) {
        respondJson(res, 200, { ...payload, truncated: true, sessions: payload.sessions.slice(0, 12) })
        return
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    } catch (error) {
      respondJson(res, 500, {
        ok: false,
        error: truncate(error instanceof Error ? error.message : String(error), 500),
      })
    }
  }

  function dispose() {
    state.records.clear()
  }

  return {
    state,
    limits,
    onPreStep,
    updateStatus,
    cancelPlan,
    dispatchTool,
    statusTool,
    plansPayload,
    route,
    dispose,
    planModeActive: (session: any) => isPlanModeActive(ctx, session),
  }
}

function resolveModelSelection(ctx: any, payload: any) {
  const direct = payload.modelSelection
  if (direct?.provider && direct?.model) {
    return {
      provider: direct.provider,
      model: direct.model,
      reasoningEffort: direct.reasoningEffort,
    }
  }
  const agentOptions = payload.agent?.options
  if (agentOptions?.provider && agentOptions?.model) {
    return {
      provider: agentOptions.provider,
      model: agentOptions.model,
      reasoningEffort: agentOptions.reasoningEffort,
    }
  }
  try {
    const current = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (current?.provider && current?.model) {
      return {
        provider: current.provider,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
      }
    }
  } catch {
    // The headless profile may not register a default-model service.
  }
  return null
}

async function maybePlan(ctx: any, state: any, payload: any, downstream: any, options: any) {
  const session = payload.agent?.session
  if (!session || !isRootSession(session)) return downstream
  if (payload.step !== 1) return downstream
  const planMode = isPlanModeActive(ctx, session)
  const human = humanMessages(payload.messages)
  if (human.length === 0) return downstream
  const taskText = taskTextFromMessages(payload.messages)
  if (!taskText) return downstream
  if (isSocialMessage(taskText)) return downstream
  if (isVagueContinuation(taskText)) return downstream
  if (isStatusQuestion(taskText)) return downstream
  const conversationContext = recentConversation(session)
  const existing = state.records.get(session.id)
  if (existing?.plan?.createdTurn === payload.turn) return downstream
  // A plan generated in plan mode is intentionally deferred: keep it intact
  // until the user leaves plan mode and dispatches it. Cancelling it here
  // would make the plan disappear before the main Agent can act on approval.
  if (existing?.plan && existing.planMode && !existing.dispatchedAt) return downstream
  // A plan committed but not yet dispatched must not be overwritten in the
  // same turn; a later turn may supersede it, otherwise one abandoned plan
  // would lock planning forever.
  if (existing?.plan && !existing.dispatchedAt) {
    if (existing.plan.createdTurn === payload.turn) return downstream
    existing.phase = 'cancelled'
    existing.cancelledAt = Date.now()
    existing.updatedAt = existing.cancelledAt
    existing.errors = Array.isArray(existing.errors) ? existing.errors : []
    existing.errors.push('计划已取消：上一轮未派发')
  }
  if (existing?.dispatchPromise || existing?.phase === 'executing') return downstream
  const modelSelection = resolveModelSelection(ctx, payload)
  if (!modelSelection?.provider || !modelSelection?.model) {
    const message = buildDegradedMessage({
      planId: `wp-${randomUUID()}`,
      sessionId: session.id,
      createdTurn: payload.turn,
      createdAt: Date.now(),
      error: '没有可用的模型路由，无法生成计划',
      taskText,
    })
    state.records.set(session.id, {
      planId: null,
      plan: null,
      title: '自动分解降级',
      degraded: true,
      error: '没有可用的模型路由',
      statuses: [],
      phase: 'degraded',
      errors: ['没有可用的模型路由'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdTurn: payload.turn,
    })
    return enterDecision(downstream, [message])
  }

  let plan
  try {
    plan = await runPlanner(ctx, {
      taskText,
      cwd: session.header?.cwd ?? options.cwd,
      sessionId: session.id,
      modelSelection,
      signal: payload.signal,
      conversationContext,
      /*
       * Hand the real limits to the planner. Without them it had no idea the
       * round budget was 20 minutes and happily planned 15 heavy subtasks,
       * which then died at the budget wall. The prompt now states the budget
       * and asks for `estimateMinutes` on every subtask.
       */
      budget: {
        totalMinutes: Math.max(1, Math.round(Number(options?.limits?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) / 60000)),
        childMinutes: Math.max(1, Math.round(Number(options?.limits?.childTimeoutMs ?? CHILD_TIMEOUT_MS) / 60000)),
        concurrency: MAX_CONCURRENT,
        maxResumes: Number(options?.limits?.maxResumes ?? MAX_PLAN_RESUMES),
      },
    })
  } catch (error) {
    if (payload.signal.aborted) return downstream
    const planId = `wp-${randomUUID()}`
    const createdAt = Date.now()
    const message = buildDegradedMessage({
      planId,
      sessionId: session.id,
      createdTurn: payload.turn,
      createdAt,
      error: error instanceof Error ? error.message : String(error),
      taskText,
    })
    state.records.set(session.id, {
      planId,
      plan: null,
      title: '自动分解降级',
      degraded: true,
      error: error instanceof Error ? error.message : String(error),
      statuses: [],
      phase: 'degraded',
      errors: [truncate(error instanceof Error ? error.message : String(error), 1000)],
      createdAt,
      updatedAt: createdAt,
      createdTurn: payload.turn,
    })
    return enterDecision(downstream, [message])
  }

  if (payload.signal.aborted) return downstream
  const planId = `wp-${randomUUID()}`
  const createdAt = Date.now()
  const fullPlan = attachPlanMeta(plan, {
    planId,
    sessionId: session.id,
    createdTurn: payload.turn,
    createdAt,
    sourceMessageIds: human.map((message: any) => message.id).filter((id: any) => typeof id === 'string'),
  })
  const record: any = {
    plan: fullPlan,
    statuses: createStatuses(fullPlan),
    phase: 'pending',
    errors: [],
    createdAt,
    updatedAt: createdAt,
    dispatchedAt: null,
    dispatchPromise: null,
    modelSelection,
    conversationContext,
    planMode,
  }
  state.records.set(session.id, record)
  /*
   * Plan-first: commit the plan with this step and let the main Agent call
   * dsh_workplan_dispatch. Dispatching here would hide the plan until every
   * child finished, which is exactly the "没动静/没完成" failure. The dispatch
   * tool appends the durable result after the children finish, and tools.guard
   * stops the main Agent from doing other work before dispatching.
   */
  const planMessage = buildPlanMessage(fullPlan, {
    totalBudgetMinutes: Math.max(1, Math.round(Number(options?.limits?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) / 60000)),
    maxResumes: Number(options?.limits?.maxResumes ?? MAX_PLAN_RESUMES),
  })
  if (!planMode) return enterDecision(downstream, [planMessage])
  /*
   * Plan mode is a planning-only collaboration state: the plugin must still
   * decompose the task and show the plan, but it must not start department
   * Agents before the user approves/leaves plan mode. The main Agent is told
   * to present this plan; dsh_workplan_dispatch is separately denied while
   * plan mode is active.
   */
  const note = {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: '当前处于 plan 模式：本计划只用于规划，不会启动部门 Agent。请先把上面的任务分解交给用户审阅；用户退出 plan 模式后，再调用 dsh_workplan_dispatch 执行。',
    }],
    source: { kind: 'workplan', form: 'notice', summary: 'plan 模式：计划已生成，等待用户审阅后派发' },
  }
  return enterDecision(downstream, [planMessage, note])
}

export function plannerOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      planId: { type: 'string' },
      phase: { type: 'string' },
      stats: { type: 'object' },
    },
    required: ['ok'],
    additionalProperties: true,
  }
}

export function updateToolOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      planId: { type: 'string' },
      subtaskId: { type: 'string' },
      status: { type: 'string' },
      stats: { type: 'object' },
    },
    required: ['ok'],
    additionalProperties: true,
  }
}

export function cancelToolOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      planId: { type: 'string' },
      phase: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['ok'],
    additionalProperties: true,
  }
}

export function statusToolOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      planId: { type: 'string' },
      running: { type: 'boolean' },
      phase: { type: 'string' },
      // The host accepts only a single type string per node; a nullable scalar
      // is expressed with oneOf (type arrays throw JsonSchemaError at activation).
      elapsedMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      stats: { type: 'object' },
      statuses: { type: 'array' },
      errors: { type: 'array' },
      resumeLimit: { type: 'number' },
      hint: { type: 'string' },
      error: { type: 'string' },
      code: { type: 'string' },
    },
    required: ['ok'],
    additionalProperties: true,
  }
}

export function dispatchToolOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      planId: { type: 'string' },
      alreadyRunning: { type: 'boolean' },
      stale: { type: 'boolean' },
      running: { type: 'boolean' },
      joined: { type: 'boolean' },
      mode: { type: 'string' },
      elapsedMs: { type: 'number' },
      statuses: { type: 'array' },
      phase: { type: 'string' },
      stats: { type: 'object' },
      error: { type: 'string' },
      hint: { type: 'string' },
      resume: { type: 'object' },
    },
    required: ['ok'],
    additionalProperties: true,
  }
}
