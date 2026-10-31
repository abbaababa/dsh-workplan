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
  buildStopSteerText,
  createStatuses,
  deliveryReadiness,
  derivePlanSnapshot,
  extractJson,
  flattenSubtasks,
  isRecord,
  isSocialMessage,
  isStatusQuestion,
  isVagueContinuation,
  makeUserMessage,
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
 * [1.8.5] 被中断时，先说清「东西到底写出来没有」。
 *
 * 事故（2026-10-30）：一个子 Agent 在 21:34:52 写完了 38KB 交付物，两秒后被
 * 外部中断；插件只留下「结束状态为 aborted」，产物存在与否完全不进判定，主
 * Agent 只能把它当彻底失败，下游 6 个任务跟着停摆。
 *
 * 这里不改变任何判定语义（中断依然记为失败、依然不自动重试），只在报错里
 * 附上一句可核实的事实：该步声明的产物里有哪几个已经在盘上。看到这句话的人
 * 才知道下一步该去核对、改判，而不是白等一次重试。
 */
export function probeInterruptedArtifacts(output: any, subtask: any, cwd: any, artifactExists: any = existsSync) {
  const candidates = new Set<string>()
  const collect = (text: any) => {
    if (typeof text !== 'string' || !text) return
    // 文件名可能带中文（本次事故就是「T6_人性博弈推演_20261030.md」这种），
    // 所以字符集必须放行 CJK，否则真正的产物会被当成没写。
    for (const hit of text.matchAll(/[\w\u4e00-\u9fff@.\/-]+\.(?:md|csv|json|html|txt|ts|js|py|ya?ml)/g)) {
      const ref = hit[0].replace(/^\.\//, '')
      // 太短的多半是扩展名碎片（如 “.md”），不足以定位文件。
      if (ref.length > 3) candidates.add(ref)
    }
  }
  collect(output)
  for (const item of Array.isArray(subtask?.outputs) ? subtask.outputs : []) collect(item)
  const landed: string[] = []
  for (const ref of candidates) {
    const target = resolveArtifactPath(ref, cwd)
    if (!target) continue
    let exists = false
    try {
      exists = artifactExists(target) === true
    } catch {
      exists = false
    }
    if (exists) landed.push(ref)
    if (landed.length >= 6) break
  }
  return landed
}

/**
 * [1.8.6] Turn "the child was interrupted" into evidence the plan can hold.
 *
 * 1.8.5 only put the landed files into the error string. That helped a human
 * read the message, but the plan still recorded `blocked` with no
 * `artifacts` / `missingArtifacts`, so the dispatcher had nothing to check and
 * cascaded every dependent into `blocked`: one interrupted child still killed
 * its whole downstream. This records the same finding in the status fields the
 * scheduler already understands.
 *
 * It deliberately does NOT change the verdict: an interrupted task stays
 * `blocked` (no auto-retry, no auto-adjudication). It only stops the cascade
 * and leaves the main Agent a factual basis to re-adjudicate.
 */
export function probeInterruptedEvidence(output: any, subtask: any, cwd: any, artifactExists: any = existsSync) {
  const landed = probeInterruptedArtifacts(output, subtask, cwd, artifactExists)
  const declared: string[] = []
  for (const item of Array.isArray(subtask?.outputs) ? subtask.outputs : []) {
    for (const hit of String(item).matchAll(/[\w\u4e00-\u9fff@.\/-]+\.(?:md|csv|json|html|txt|ts|js|py|ya?ml)/g)) {
      const ref = hit[0].replace(/^\.\//, '')
      if (ref.length > 3 && !declared.includes(ref)) declared.push(ref)
    }
  }
  const refs = [...new Set([...declared, ...landed])]
  const artifacts = refs.map((ref) => ({ kind: 'file', ref, exists: landed.includes(ref) }))
  const missingArtifacts = declared.filter((ref) => !landed.includes(ref))
  return { artifacts, missingArtifacts }
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
  /*
   * [1.8.6] The interrupt has to outlive the thrown error.
   *
   * `interruptedFlag` travels back to the dispatcher (it must not cascade this
   * task's dependents); `interruptedEvidence` is what gets written into the
   * blocked status so the main Agent can re-adjudicate on facts.
   */
  let interruptedFlag = false
  let interruptedEvidence: { artifacts: any[]; missingArtifacts: string[] } | null = null
  try {
    if (!writeSubtaskStatus(record, subtask.id, {
      status: 'in_progress',
      progress: 5,
      startedAt: Date.now(),
    }, guard)) return

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (guard.timedOut) return
      interruptedEvidence = null
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
          /*
           * [1.8.5] 中断必须自己说出「接下来怎么办」。
           *
           * 2026-10-30 事故：T6 在被外部中断前 2 秒已写出 38KB 交付物，插件只留下
           * 「子 Agent 结束状态为 aborted」，主 Agent 无从知道产物其实已经在盘上，
           * 于是把它当彻底失败处理，并把 6 个下游一起判死。中断类失败要显式提示
           * 「先核对已写出的产物」，并给出据实改判与续跑这两条出口。
           */
          const interrupted = result.stopReason === 'aborted'
          const landed = interrupted ? probeInterruptedArtifacts(output, subtask, options.cwd, options.artifactExists) : []
          if (interrupted) {
            interruptedFlag = true
            interruptedEvidence = probeInterruptedEvidence(output, subtask, options.cwd, options.artifactExists)
          }
          throw new PlanError(
            `子 Agent 结束状态为 ${result.stopReason}${result.diagnostic ? `：${result.diagnostic}` : ''}${
              interrupted
                ? `（子 Agent 在完成前被中断：先核对该步声明的产物是否已写出${
                  landed.length > 0
                    ? `——已核到 ${landed.length} 个文件确实在盘上：${landed.join('、')}`
                    : ''
                }；据实改判，再决定是否续跑）`
                : ''
            }`,
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
      // [1.8.6] A blocked status that carries no evidence is what made the
      // dispatcher treat "interrupted, file on disk" exactly like "produced
      // nothing". Record what was actually found.
      ...(interruptedEvidence && interruptedEvidence.artifacts.length > 0
        ? { artifacts: interruptedEvidence.artifacts }
        : {}),
      ...(interruptedEvidence && interruptedEvidence.missingArtifacts.length > 0
        ? { missingArtifacts: interruptedEvidence.missingArtifacts }
        : {}),
    }, guard)
    recordSubtaskError(record, subtask.id, message, guard)
    return interruptedFlag ? { interrupted: true } : undefined
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
    // [1.8.6] The outcome (`{interrupted:true}`) has to reach the dispatcher;
    // swallowing it here is why an interrupted child looked like any failure.
    return await Promise.race([
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
    // [1.8.13] The model must see *which* acceptance item failed, not just the
    // verdict; it cannot repair a gap it cannot name.
    acceptance: Array.isArray(item.acceptance)
      ? item.acceptance.slice(0, 8).map((entry: any) => ({
        criterion: truncate(String(entry?.criterion ?? ''), 200),
        result: String(entry?.result ?? ''),
        evidence: truncate(String(entry?.evidence ?? ''), 300),
      }))
      : [],
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

/**
 * [1.8.6] Explain why a `pending` task cannot run, instead of calling it blocked.
 *
 * A single generic sentence made three different situations indistinguishable:
 * a budget pause (nothing ran yet), an upstream whose declared file is missing
 * (the work may well be done), and a genuinely failed upstream. The main Agent
 * read all three as "7 卡住了" and had to re-derive the cause by hand.
 */
function describePendingCause(plan: any, statuses: any[], id: string): string {
  const byId = new Map<string, any>(statuses.map((item: any) => [item.subtaskId, item]))
  const entry = flattenSubtasks(plan).find((candidate: any) => candidate.subtask.id === id)
  if (!entry) return '计划里找不到该步骤'
  const declared: string[] = Array.isArray(entry.subtask.dependsOn) ? entry.subtask.dependsOn : []
  if (declared.length === 0) return '没有上游依赖，但本轮未被调度到'
  const bad = declared.filter((dep: string) => {
    const state = byId.get(dep)
    if (!state || state.status !== 'done') return true
    if (Array.isArray(state.missingArtifacts) && state.missingArtifacts.length > 0) return true
    if (state.verification === 'legacy') return true
    return false
  })
  if (bad.length === 0) return '上游都已就绪，但本轮未被调度到'
  return bad.map((dep: string) => {
    const state = byId.get(dep)
    if (!state) return `上游 ${dep} 缺失`
    if (state.status !== 'done') {
      return `上游 ${dep} 状态为 ${state.status}${state.error ? `（${String(state.error).slice(0, 80)}）` : ''}`
    }
    if (Array.isArray(state.missingArtifacts) && state.missingArtifacts.length > 0) {
      return `上游 ${dep} 的声明产物缺失：${state.missingArtifacts.join('、')}`
    }
    if (state.verification === 'legacy') return `上游 ${dep} 完成但未提供结构化证据`
    return `上游 ${dep} 不可用`
  }).join('；')
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
    /*
     * [1.8.6] Interrupted tasks are not cascaded.
     *
     * The 2026-10-30 incident: one child was interrupted after it had already
     * written its deliverable; the dispatcher blocked its 6 dependents. Those
     * children were never given a chance, and the plan looked like a 7-task
     * failure. Keep the interrupted task itself `blocked` (its verdict must not
     * be rewritten automatically), but leave dependents `pending` and say why.
     */
    const interruptedIds = new Set<string>()
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
        /*
         * [1.8.6] "Nothing is ready" is not the same thing as "everything
         * failed".
         *
         * The old code rewrote every remaining `pending` task to `blocked` with
         * one generic line ("依赖未完成或上游受阻"). A budget pause, a missing
         * artifact and a genuinely failed upstream all produced that same
         * status, the plan turned `blocked`, and a resume was billed against
         * the failure budget. Keep them `pending`, and record the actual cause.
         */
        const pending = record.statuses.filter((item: any) => item.status === 'pending')
        if (pending.length > 0) {
          const reasons = pending.map((item: any) =>
            `${item.subtaskId}：${describePendingCause(record.plan, record.statuses, item.subtaskId)}`)
          const message = `本轮结束，仍有 ${pending.length} 项保持 pending（不是失败，也未级联成 blocked）：${reasons.slice(0, 6).join('；')}`
          record.error = message
          record.errors = [...(record.errors ?? []), message].slice(-20)
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
        const outcome: any = await runSubtask(ctx, record, entry.stage, entry.subtask, {
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
        // [1.8.6] Remember which failures were interrupts, so the cascade below
        // can leave their dependents pending instead of blaming them.
        if (outcome && outcome.interrupted) interruptedIds.add(item.id)
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
        /*
         * [1.8.6] An interrupted task blocked itself, not its dependents.
         *
         * Recording the interruption in `errors` (instead of silently skipping)
         * keeps the reason visible in the result message, and `continue` leaves
         * the dependents `pending` so a re-dispatch can still run them once the
         * main Agent re-adjudicates the interrupted step.
         */
        if (interruptedIds.has(id)) {
          record.errors = [...(record.errors ?? []),
            `${id}: 被中断但产物已核对（见 artifacts），未自动级联下游；请据实改判或续跑`].slice(-20)
          continue
        }
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
    /*
     * [1.8.6] Do not let a pending tail masquerade as a failure.
     *
     * `planPhase` turns any `blocked` row into `blocked`; with D8's fix a round
     * can end with real blocked rows *and* untouched pending rows. Keep
     * `blocked` for real failures, and report `paused` when only pending work
     * is left, so a resume is not billed against the failure budget.
     */
    const hasBlocked = record.statuses.some((item: any) => item.status === 'blocked')
    const hasPending = record.statuses.some((item: any) => item.status === 'pending')
    record.phase = hasBlocked ? 'blocked' : (hasPending ? 'paused' : planPhase(record.statuses))
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
  const readiness = deliveryReadiness(snapshot, { phase: record.phase })
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
     * [1.8.13] Delivery readiness travels with the dashboard payload too.
     *
     * `phase` alone cannot express "all rows done but evidence missing, or a
     * cancelled plan is still incomplete"; a green 100% card next to a denied
     * present is exactly the contradiction this incident exposed. The UI can
     * now show the same verdict the gate uses.
     */
    deliveryReady: readiness.ready,
    deliveryBlockers: readiness.blockers.slice(0, 12),
    deliveryRemaining: readiness.remaining.slice(0, 20),
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
  /*
   * [1.8.10] 回放窗口必须包含目标计划的定义。
   *
   * 会话事件超过 MAX_HISTORY_EVENTS（2000）后，窗口起点会越过早期的 plan
   * 消息。此时按 planId 重建旧计划得到 null，dispatch / status 都会退回
   * 内存里那个更新的计划，旧计划在卡片上消失，也无法再续跑。
   * 显式指定 planId 时向前扫到该计划的 plan 消息，把窗口起点前移。
   */
  let start = Math.max(0, session.seq - MAX_HISTORY_EVENTS)
  if (targetPlanId) {
    for (let seq = start - 1; seq >= 0; seq -= 1) {
      let event
      try {
        event = session.eventAt(seq)
      } catch {
        continue
      }
      if (!event || event.type !== 'user/message') continue
      const payload = parseWorkplanMessage(event.data)
      if (payload?.plan?.planId === targetPlanId) {
        start = seq
        break
      }
    }
  }
  interface ReplaySnapshot {
    plan: any
    statuses: any[]
    resultPhase: string
    resultSeen: boolean
    resumeCount: number
    cancelled: boolean
  }
  /*
   * [1.8.9] 回放按 planId 分账，不按会话「最后一个计划」分账。
   *
   * 旧实现只有一组 plan/statuses：中途出现第二个计划（这次事故里是「继续」被
   * 误判后生成的 wp-dd26f206）时，第一个计划的快照被冻结在当时，之后所有属于
   * 它的结果消息与人工改判都被丢弃——重启后卡片从 13/14 掉回 5/14，而会话
   * 日志里明明有 7/14 的结果消息和 6 条 done 改判。现在每个计划各一份快照，
   * 每条 durable 消息只写给 planId 指定的那个计划。
   */
  const snapshots = new Map<string, ReplaySnapshot>()
  let currentId: string | null = null
  let degraded: any = null
  const ensure = (plan: any): ReplaySnapshot => {
    let snap = snapshots.get(plan.planId)
    if (!snap) {
      snap = {
        plan,
        statuses: createStatuses(plan),
        resultPhase: '',
        resultSeen: false,
        resumeCount: 0,
        cancelled: false,
      }
      snapshots.set(plan.planId, snap)
    }
    currentId = plan.planId
    return snap
  }
  /** [1.6.0] callId → 待确认的 update 写入；只有配对的 tool/result 才能定案。 */
  const pendingToolCalls = new Map<string, any>()
  /**
   * [1.8.11] 已经由 durable `workplan-update` 消息应用过的人工改判。
   *
   * 一次 `dsh_workplan_update` 会写两份记录：一条 durable 用户消息（带
   * revision 与 updatedBy=agent）和一条 tool/result。回放原来两份都应用，
   * 第二次以 system 身份把 revision 再抬一级并覆盖 summary——人工改判的
   * 证据后缀就这么丢了。这里记下消息的 seq，配对的 tool/result 不再重复写。
   */
  const appliedUpdates = new Map<string, { seq: number; status: string }>()
  const updateKey = (planId: string, subtaskId: string) => `${planId}\u0000${subtaskId}`
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
        currentId = null
      } else if (payload?.plan) {
        ensure(payload.plan)
      }
      /*
       * Every result message is routed by its own planId. A result that arrives
       * after a newer plan was generated must still update the plan it names —
       * that was the 13/14 → 5/14 replay regression. A plan never inherits
       * another plan's round phase or resume counter (each snapshot owns them).
       */
      const result = parseResultMessage(event.data)
      if (result && typeof result.planId === 'string') {
        const snap = snapshots.get(result.planId)
        if (snap) {
          snap.statuses = applyResultStatuses(snap.statuses, result)
          // Resume bookkeeping must survive a page refresh, otherwise the budget
          // silently resets and a never-succeeding subtask can loop forever.
          snap.resumeCount = Number(result.resumeCount ?? snap.resumeCount) || 0
          snap.resultPhase = typeof result.phase === 'string' ? result.phase : ''
          snap.resultSeen = true
          /*
           * [1.8.14] A cancel that lands while a dispatch is in flight writes no
           * separate cancel message (it aborts the dispatch instead), so the
           * only durable trace of that cancellation is `phase: 'cancelled'` in
           * the round result. Without this the plan reopens as "executing"
           * after a restart — the cancel is silently lost.
           */
          if (snap.resultPhase === 'cancelled') snap.cancelled = true
        }
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
      if (update && typeof update.planId === 'string' && typeof update.subtaskId === 'string') {
        const snap = snapshots.get(update.planId)
        if (snap) {
          try {
            snap.statuses = applyStatus(snap.statuses, update.subtaskId, {
              status: update.status,
              progress: typeof update.progress === 'number' ? update.progress : undefined,
              summary: typeof update.note === 'string' ? update.note : undefined,
              // [1.8.13] Evidence written through the update tool must survive replay.
              verification: update.verification,
              acceptance: update.acceptance,
              artifacts: update.artifacts,
              missingArtifacts: update.missingArtifacts,
              revision: Number.isInteger(update.revision) ? update.revision : undefined,
              updatedBy: 'agent',
            })
            appliedUpdates.set(updateKey(update.planId, update.subtaskId), {
              seq: Number(event.seq ?? 0),
              status: String(update.status ?? ''),
            })
          } catch {
            // An invalid historical update is ignored; the rest still replays.
          }
        }
      }
      const cancel = parseCancelMessage(event.data)
      if (cancel && typeof cancel.planId === 'string') {
        const snap = snapshots.get(cancel.planId)
        if (snap) snap.cancelled = true
      }
    } else if (event.type === 'tool/call') {
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
          const planId = typeof args.planId === 'string' ? args.planId : currentId
          if (planId) pendingToolCalls.set(data.callId, { args, planId, callSeq: Number(event.seq ?? 0) })
        }
      }
    } else if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.role === 'tool' ? message.toolCallId : null
      if (typeof callId !== 'string') continue
      const pending = pendingToolCalls.get(callId)
      pendingToolCalls.delete(callId)
      const snap = pending && typeof pending.planId === 'string' ? snapshots.get(pending.planId) : null
      if (!snap) {
        // 结果晚于新计划到达：旧计划的写入不污染新计划的状态表。
      } else if (message.isError === true) {
        // 失败的更新不是完成：状态表保持原样。
      } else {
        const args = pending.args
        /*
         * [1.8.11] 同一次改判已经由 durable 消息应用过时，配对结果不再写第二遍。
         * 判据是 seq 与状态都一致：durable 消息在本次调用之后到达且状态相同，
         * 才说明它是这次调用的记录；更早/更晚的人工改判仍按自己的顺序生效。
         */
        const applied = appliedUpdates.get(updateKey(pending.planId, args.subtaskId))
        const alreadyDurable = Boolean(applied)
          && applied!.seq > Number(pending.callSeq ?? 0)
          && applied!.status === String(args.status ?? '')
        if (!alreadyDurable) {
          try {
            snap.statuses = applyStatus(snap.statuses, args.subtaskId, {
              status: args.status,
              progress: typeof args.progress === 'number' ? args.progress : undefined,
              summary: typeof args.note === 'string' ? args.note : undefined,
              // [1.8.13] A tool/result fallback carries the same evidence fields.
              verification: args.verification,
              acceptance: args.acceptance,
              artifacts: args.artifacts,
              missingArtifacts: args.missingArtifacts,
            })
          } catch {
            // An invalid historical call is ignored; the live cache remains authoritative.
          }
        }
      }
    }
  }
  const chosen = targetPlanId
    ? snapshots.get(targetPlanId) ?? null
    : currentId
      ? snapshots.get(currentId) ?? null
      : null
  if (!chosen) {
    if (!degraded) return null
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
  const plan = chosen.plan
  const statuses = chosen.statuses
  const resultPhase = chosen.resultPhase
  const resultSeen = chosen.resultSeen
  const resumeCount = chosen.resumeCount
  const cancelled = chosen.cancelled
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
    /*
     * [1.8.14] Two facts, one from the log: whether the plan is cancelled and
     * whether that cancellation is durably recorded. For replay they are the
     * same; the live `cancelPlan` uses `cancelRecorded` to make a second
     * cancel a no-op instead of appending a duplicate message (N8).
     */
    cancelled,
    cancelRecorded: cancelled,
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
  /**
   * [1.8.13] Package version, supplied by the host from its `meta.version`.
   *
   * `dsh_workplan_status` used to say nothing about which build answered, so a
   * stale process (the incident ran 1.8.9 while the workspace had 1.8.11) could
   * only be detected by inspecting the PID by hand. The version now travels
   * with every status/dispatch answer.
   */
  version?: string
  /**
   * [1.8.14] Identity of the modules this process actually loaded.
   *
   * 1.8.13 made the *package version* visible, but the incident's N1 stayed
   * open: a version string cannot distinguish "this build" from "the same
   * version rebuilt", and after a profile recomposition the in-memory modules
   * may not be the files on disk. The host therefore hashes the loaded
   * `lib/host.js` + `lib/runtime.js` + `lib/plan.js` at module-init time and
   * passes the digest (plus PID and process start time) here. `status` answers
   * it even when there is no plan, so the "did the restart load the fix"
   * question needs no PID archaeology.
   */
  build?: {
    pid?: number
    startedAt?: number
    entryPath?: string
    buildHash?: string
  }
}

export function createWorkplanRuntime(ctx: any, options: WorkplanRuntimeOptions = {}) {
  /*
   * `activeTurns` maps a root session to the turn whose user message carried a
   * real task; the `agent/turn-stopping` gate only objects on those turns.
   */
  const state: any = { records: new Map(), activeTurns: new Map() }
  /*
   * Resolve the tunables once, at construction, so every code path (dispatch,
   * resume, cancel, the host's tool timeout) agrees on the same numbers.
   */
  const pluginVersion = typeof options.version === 'string' && options.version ? options.version : 'unknown'
  /*
   * [1.8.14] Build identity, captured once.
   *
   * `startedAt` is derived from `process.uptime()` so it is the real process
   * start, not the plugin's construction time; `uptimeMs` is computed live.
   * Tests construct the runtime without a `build` option, so every field is
   * optional and the answer degrades to `unknown` instead of failing.
   */
  const buildInfo = {
    pid: Number.isInteger(options.build?.pid) && Number(options.build?.pid) > 0
      ? Number(options.build!.pid)
      : process.pid,
    startedAt: Number.isFinite(Number(options.build?.startedAt)) && Number(options.build?.startedAt) > 0
      ? Number(options.build!.startedAt)
      : Math.round(Date.now() - process.uptime() * 1000),
    entryPath: typeof options.build?.entryPath === 'string' && options.build.entryPath
      ? options.build.entryPath
      : '',
    buildHash: typeof options.build?.buildHash === 'string' && options.build.buildHash
      ? options.build.buildHash
      : 'unknown',
  }
  function runtimeIdentity() {
    return {
      version: pluginVersion,
      pid: buildInfo.pid,
      startedAt: buildInfo.startedAt,
      uptimeMs: Math.max(0, Date.now() - buildInfo.startedAt),
      entryPath: buildInfo.entryPath,
      buildHash: buildInfo.buildHash,
    }
  }
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

  /**
   * Point an edit or a cancellation at the plan the caller actually named.
   *
   * dispatch has always rebuilt an older plan out of the session log
   * (`needsRebuild` + `reconstructFromSession(session, requestedPlanId)`), but
   * update and cancel compared the id and threw PLAN_ID_MISMATCH — so the one
   * repair path for "the child wrote its artifact and was then interrupted"
   * (re-adjudicating that step) was closed on exactly the plans that needed it.
   * Align the three tools: a named plan that exists in the session log becomes
   * the target record. While a *different* plan is dispatching, refuse with a
   * reason instead of silently swapping the running record out from under it.
   */
  function adoptRequestedPlan(session: any, current: any, requestedPlanId: any) {
    if (!current?.plan || !requestedPlanId || current.plan.planId === requestedPlanId) return current
    if (current.dispatchPromise) {
      throw new PlanError(
        `计划 ${requestedPlanId} 不是当前记录：${current.plan.planId} 正在执行，先等它结束或先取消它`,
        'PLAN_ID_MISMATCH',
      )
    }
    const rebuilt = reconstructFromSession(session, requestedPlanId)
    if (!rebuilt?.plan || rebuilt.plan.planId !== requestedPlanId) {
      throw new PlanError(
        `planId 与当前计划不匹配（当前 ${current.plan.planId}，会话日志里也没有 ${requestedPlanId}）`,
        'PLAN_ID_MISMATCH',
      )
    }
    rebuilt.resumeLimit = current.resumeLimit ?? rebuilt.resumeLimit
    state.records.set(session.id, rebuilt)
    return rebuilt
  }

  async function updateStatus(agent: any, args: any): Promise<any> {
    const session = agent?.session
    if (!session) throw new PlanError('只能在会话内更新计划', 'NO_SESSION')
    if (!isRootSession(session)) throw new PlanError('子 Agent 不能更新主计划', 'NOT_ROOT')
    let record = state.records.get(session.id)
    if (!record?.plan) record = reconstructFromSession(session, args?.planId)
    record = adoptRequestedPlan(session, record, args?.planId)
    if (!record?.plan) throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN')
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
    /*
     * [1.8.13] A manual verdict can carry structured evidence.
     *
     * The tool used to accept only `status/progress/note/evidence`, so the
     * documented escape from the present gate ("先用 dsh_workplan_update 复核
     * 并补证据") did not exist: a done row stayed `verification: undefined`
     * and could never become deliverable. These four fields are now accepted,
     * sanitised by `applyStatus`, persisted in the durable update message and
     * replayed. Omitted fields keep their previous values.
     */
    const evidencePatch: any = {}
    if (args?.verification !== undefined) evidencePatch.verification = args.verification
    if (args?.acceptance !== undefined) evidencePatch.acceptance = args.acceptance
    if (args?.artifacts !== undefined) evidencePatch.artifacts = args.artifacts
    if (args?.missingArtifacts !== undefined) evidencePatch.missingArtifacts = args.missingArtifacts
    record.statuses = applyStatus(record.statuses, subtaskId, {
      status,
      progress: typeof args?.progress === 'number' ? args.progress : undefined,
      summary: summary || undefined,
      error: status === 'blocked' ? (summary || '由主 Agent 标记为受阻') : undefined,
      ...evidencePatch,
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
      const writtenRow = record.statuses.find((item: any) => item.subtaskId === subtaskId)
      session.append('user/message', buildUpdateMessage({
        planId: record.plan.planId,
        subtaskId,
        status,
        progress: typeof args?.progress === 'number' ? args.progress : undefined,
        note: summary || undefined,
        revision,
        verification: writtenRow?.verification,
        acceptance: writtenRow?.acceptance,
        artifacts: writtenRow?.artifacts,
        missingArtifacts: writtenRow?.missingArtifacts,
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
    const readiness = deliveryReadiness(snapshot, { phase: record.phase })
    return {
      ok: true,
      planId: record.plan.planId,
      subtaskId,
      status: written?.status ?? status,
      revision: written?.revision ?? revision,
      updatedBy: written?.updatedBy ?? 'agent',
      stats: snapshot.stats,
      deliveryReady: readiness.ready,
      deliveryBlockers: readiness.blockers.slice(0, 12),
      deliveryRemaining: readiness.remaining.slice(0, 20),
      ...(readiness.ready
        ? { hint: '计划已全部 done 且证据通过，可以交付。' }
        : {
            hint: written?.status === 'done'
              ? '该子任务已是 done，但计划尚未通过交付就绪检查；若这项仍有证据缺口，请用 verification/acceptance 补齐或改回 blocked。'
              : '计划尚未通过交付就绪检查；继续推进剩余项，不要调用 present。',
          }),
    }
  }

  async function cancelPlan(agent: any, args: any) {
    const session = agent?.session
    if (!session) throw new PlanError('只能在会话内取消计划', 'NO_SESSION')
    if (!isRootSession(session)) throw new PlanError('子 Agent 不能取消主计划', 'NOT_ROOT')
    let record = state.records.get(session.id)
    if (!record?.plan) record = reconstructFromSession(session, args?.planId)
    record = adoptRequestedPlan(session, record, args?.planId)
    if (!record?.plan) throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN')
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
    /*
     * [1.8.14] N8: a second cancel used to append a second cancel message.
     *
     * Cancelling is idempotent by definition: once the cancellation is durably
     * recorded, repeating it must not grow the log — every duplicate is
     * replayed and shows up as another "取消" line in the transcript, which is
     * exactly the kind of "did it happen twice?" noise this incident was made
     * of. `dispatchPromise` is excluded because an in-flight dispatch may still
     * need aborting; that path returns without appending (see below).
     */
    if (record.phase === 'cancelled' && record.cancelRecorded === true && !record.dispatchPromise) {
      state.records.set(session.id, record)
      return {
        ok: true,
        planId: record.plan.planId,
        phase: 'cancelled',
        reason: typeof record.cancelReason === 'string' && record.cancelReason ? record.cancelReason : reason,
        alreadyCancelled: true,
        abortedRunning: false,
        cancelRecorded: true,
        stats: before.stats,
      }
    }
    const cancelMessage = buildCancelMessage(record.plan.planId, reason)
    /*
     * [1.8.14] N12: the durable cancel used to be the only append without a
     * try/catch. A failing append threw out of the tool after the in-memory
     * phase had already flipped to `cancelled`, leaving the UI saying
     * "已取消" while the log said nothing — the next restart silently undid it.
     * Record the failure and report `cancelRecorded: false` instead.
     */
    const appendCancelRecord = () => {
      try {
        session.append('user/message', cancelMessage, { surfaceOp: 'append' })
        record.cancelRecorded = true
        record.cancelReason = reason
        return true
      } catch (error: any) {
        record.cancelRecorded = false
        pushRecordError(record, `写入取消消息失败：${error instanceof Error ? error.message : String(error)}`)
        return false
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
      /*
       * [1.8.14] The abort path now writes the cancel durably too. 1.8.13
       * returned here without touching the log, so a later failed result write
       * left no trace of the cancellation at all and a restart reopened the
       * plan as "executing".
       */
      const recorded = appendCancelRecord()
      state.records.set(session.id, record)
      return {
        ok: true,
        planId: record.plan.planId,
        phase: 'cancelled',
        reason,
        abortedRunning: aborted,
        cancelRecorded: recorded,
        stats: derivePlanSnapshot(record.statuses).stats,
      }
    }
    record.phase = 'cancelled'
    record.error = `计划已取消：${reason}`
    record.updatedAt = Date.now()
    const recorded = appendCancelRecord()
    state.records.set(session.id, record)
    return {
      ok: true,
      planId: record.plan.planId,
      phase: 'cancelled',
      reason,
      cancelRecorded: recorded,
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
        /*
         * [1.8.14] N13: a failed result write is a real, user-visible failure —
         * the round summary is absent from the transcript and a restart can
         * disagree with the live phase. Log it durably, not only in the host log.
         */
        pushRecordError(record, `写入结果消息失败：${error instanceof Error ? error.message : String(error)}`)
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

  /*
   * [1.8.7] `ok` alone was read as "the plan is finished".
   *
   * The incident's tool result said `ok: true` while 3 of 13 subtasks had never
   * run; the rendered line added "已加入进行中的派发并等到结果", so the model
   * had no field telling it the round ended early. `complete`/`remaining` make
   * that state machine-readable instead of a sentence to interpret.
   */
  function completionFields(snapshot: any, phase: any) {
    const stats = snapshot?.stats ?? {}
    const total = Number(stats.total ?? 0)
    const done = Number(stats.done ?? 0)
    /*
     * [1.8.13] `complete` and `deliveryReady` are different facts.
     *
     * `complete` keeps its old meaning (every subtask done) so existing callers
     * do not break, but a dispatch answer that only said `complete:true` was
     * read as "finished" even when every row was legacy/empty-evidence. The
     * model now also sees whether the plan passed the delivery gate, plus the
     * exact gaps.
     */
    const readiness = deliveryReadiness(snapshot, { phase })
    return {
      complete: total > 0 && done >= total,
      remaining: Math.max(0, total - done),
      deliveryReady: readiness.ready,
      deliveryBlockers: readiness.blockers.slice(0, 12),
      deliveryRemaining: readiness.remaining.slice(0, 20),
    }
  }

  function dispatchSnapshotOf(record: any, extra: any = {}) {
    const snapshot = derivePlanSnapshot(record.statuses)
    return {
      ok: true,
      version: pluginVersion,
      runtime: runtimeIdentity(),
      planId: record.plan.planId,
      alreadyRunning: false,
      ...completionFields(snapshot, record.phase),
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
      /*
       * [1.8.14] N1/§14.6 step 2: the identity of the loaded build must be
       * answerable even before a plan exists. 1.8.13 returned NO_PLAN with no
       * version here, so the documented restart check ("call status, confirm
       * the version") failed on a fresh session — the check itself was wrong,
       * not just the docs.
       */
      return {
        ok: false,
        code: 'NO_PLAN',
        running: false,
        version: pluginVersion,
        runtime: runtimeIdentity(),
        error: '当前会话没有可查看的计划',
        hint: '先让本轮生成计划并调用 dsh_workplan_dispatch。',
      }
    }
    const running = Boolean(record.dispatchPromise)
    const snapshot = derivePlanSnapshot(record.statuses)
    const readiness = deliveryReadiness(snapshot, { phase: record.phase })
    return {
      ok: true,
      version: pluginVersion,
      runtime: runtimeIdentity(),
      planId: record.plan.planId,
      running,
      phase: record.phase,
      elapsedMs: record.dispatchStartedAt ? Date.now() - record.dispatchStartedAt : null,
      stats: snapshot.stats,
      statuses: modelStatusLines(snapshot.statuses),
      errors: (record.errors ?? []).slice(-10),
      resumeLimit: Number(record.resumeLimit ?? limits.maxResumes),
      deliveryReady: readiness.ready,
      deliveryBlockers: readiness.blockers.slice(0, 12),
      deliveryRemaining: readiness.remaining.slice(0, 20),
      ...(running
        ? { hint: '计划仍在执行：先向用户报告进度，不要声称完成；等结果消息出现后再逐项核对证据。' }
        : readiness.ready
          ? { hint: '计划已全部 done 且证据通过，可以交付。' }
          : readiness.cancelled
            ? { hint: '计划已取消且未完成：不要 dispatch 或 present；答复按「未完成：剩余 N 项与原因」开头。' }
            : { hint: '当前没有正在执行的派发。计划尚未通过交付就绪检查：先 dispatch 续跑剩余项；若只剩已 done 项的证据缺口，用 dsh_workplan_update 补 verification/acceptance。不要调用 present。' }),
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
        complete: false,
        remaining: Math.max(0, Number(live.stats.total ?? 0) - Number(live.stats.done ?? 0)),
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

  /*
   * [1.8.7] 回合收尾前的强制闸门——「未完成即输出」的根治点。
   *
   * 事故（session-99984ebd…，2026-10-31）里，模型在计划 10/13 时 present 了
   * 报告并给出收尾答复。插件原来只订阅 `agent/pre-step`，回合结束完全不受
   * 约束；预算暂停只写了一句「可续跑」，没有任何强制力。
   *
   * 官方 harness 为此提供了确切扩展点 `agent/turn-stopping`（@deepseek-ai/dsh-agent
   * 的 runtime-types 原文：「Awaited before the boundary commits — a listener
   * that objects steers (agent.steer(...)) and the machine re-reads its inbox:
   * fresh steering runs another step, none closes the turn.」）。同仓的
   * dsh-workspace-changes 就注册在插件根 ctx 上，证明该 agent 作用域事件能到
   * 达根监听器。
   *
   * 规则：
   *  - 只看根会话、只看本回合真实任务（state.activeTurns），社交/状态型回合不打扰；
   *  - 降级记录（没有计划）不拦；空计划也不拦（present 仍会拒绝）；
   *  - 后台派发仍在跑 ⇒ 先等它结束再判断，绝不让「已结束 ∧ 正在做」复活；
   *  - 计划未通过交付就绪检查（含未完成、证据缺口、已取消但未完成）⇒
   *    `agent.steer()` 一条明确的「禁止收尾」指令，每个回合最多 2 次。
   *
   * [1.8.13] 取消不再等于放行。
   *
   * 1.8.8 的闸门只问“还有没有 pending/in_progress”，所以全 done 但证据是
   * legacy/空验收的计划、以及 cancelled 的计划都会安静收尾并声称完成
   * （T5-B/C/D）。现在闸门与 present 共用 `deliveryReadiness`：凡是能拦住
   * 交付的缺口，也能拦住“这个回合就这么结束”。取消分支不再要求续跑，
   * 只要求按未完成口径如实收尾，所以不会空转。
   */
  const STOP_STEER_LIMIT = 2

  function recordReadiness(record: any) {
    const snapshot = derivePlanSnapshot(record.statuses)
    return deliveryReadiness(snapshot, { phase: record.phase })
  }

  function stopGateApplies(record: any) {
    if (!record?.plan) return false
    if (record.degraded) return false
    const readiness = recordReadiness(record)
    if (Number(readiness.total ?? 0) === 0) return false
    return !readiness.ready
  }

  function planChildIds(record: any) {
    const ids = new Set<string>()
    for (const item of record?.statuses ?? []) {
      if (typeof item?.childId === 'string' && item.childId) ids.add(item.childId)
    }
    for (const stage of record?.plan?.stages ?? []) {
      for (const subtask of stage?.subtasks ?? []) {
        if (typeof subtask?.childId === 'string' && subtask.childId) ids.add(subtask.childId)
      }
    }
    return ids
  }

  const PLAN_CONTINUATION_KINDS = new Set(['subagent-settled', 'workplan-result', 'workplan-continue'])

  /**
   * [1.8.9] 子会话谱系判定。
   *
   * `childId` 在预算重置时会被清空（`applyStatus({status:'pending'})` 走
   * `normaliseStatusEntry` 强制 childId=null），事故里的 T11 因此不在
   * planChildIds 中，turn 2 又一次绕过闸门。`header.parentSession` 是子会话
   * 自身的身份，预算与重启都不会改写它，用它旁证“这条结算来自本计划的执行者”。
   */
  function isChildSessionOf(senderId: string, session: any) {
    if (!senderId) return false
    try {
      const child = ctx.sessions?.get?.(senderId)
      const header = child?.header
      if (!header) return false
      return header.parentSession === session.id
    } catch {
      return false
    }
  }

  /**
   * [1.8.11] 用父会话自己的 `subagent/catalog` 事件认亲。
   *
   * `subagent-settled` 到达时子会话已经被 dispose（dsh-subagent 的
   * `finishDisposal` 先 `handle.dispose()` 再 `notifySettlement`），
   * `ctx.sessions.get(senderId)` 必然拿不到 header，1.8.9 的谱系判定因此
   * 在真实生命周期下恒为 false。spawn 记录却留在父会话的事件流里，重启、
   * 回放、预算重置都不会改写它，是唯一持久可靠的父链证据。
   */
  const spawnedChildCache = new Map<string, { at: number; ids: Set<string> }>()
  function spawnedChildIds(session: any): Set<string> {
    const cached = spawnedChildCache.get(session.id)
    if (cached && cached.at === session.seq) return cached.ids
    const ids = new Set<string>()
    if (typeof session?.eventAt === 'function') {
      for (let i = 0; i < session.seq; i += 1) {
        let event
        try {
          event = session.eventAt(i)
        } catch {
          continue
        }
        if (event?.type === 'subagent/catalog' && typeof event.data?.childId === 'string') {
          ids.add(event.data.childId)
        }
      }
    }
    spawnedChildCache.set(session.id, { at: session.seq, ids })
    return ids
  }

  /*
   * [1.8.14] N5：结算回合要判的是「这条结算对应的计划」，不是「最后生成的计划」。
   *
   * 重启后内存为空时，收尾闸门原本走默认回放（最后一个 plan 消息）：事故会话在
   * A 未完成时又生成了 B，A 的结果随后到达，闸门于是按 B 判定。结算输入
   * （workplan-result）自带 planId；显式传 planId 还能触发 1.8.10 的窗口前移，
   * 旧计划落在 2000 事件窗口外时也能重建。
   */
  function planIdFromTurn(session: any, turn: number): string | undefined {
    if (typeof session?.eventAt !== 'function' || !(turn >= 1)) return undefined
    let started = -1
    for (let i = session.seq - 1; i >= 0; i -= 1) {
      const event = session.eventAt(i)
      if (event?.type === 'turn/start' && Number(event.data?.turn) === turn) {
        started = i
        break
      }
    }
    if (started < 0) return undefined
    for (let i = started + 1; i < session.seq; i += 1) {
      const event = session.eventAt(i)
      if (!event) continue
      if (event.type === 'turn/end' && Number(event.data?.turn) === turn) break
      if (event.type !== 'user/message') continue
      const data = event.data?.message ?? event.data
      if (!data || typeof data !== 'object') continue
      /*
       * planId 不在信封上：结果消息的 planId 在正文标记之间的 JSON 里，
       * plan 消息的 planId 在 plan 对象里。两者都走已有的解析器，避免
       * 对消息形状再发明一套假设。
       */
      const result = parseResultMessage(data)
      if (result && typeof result.planId === 'string' && result.planId) return result.planId
      const planMessage = parseWorkplanMessage(data)
      const planId = planMessage?.plan?.planId
      if (typeof planId === 'string' && planId) return planId
    }
    return undefined
  }

  /**
   * [1.8.8] 结算/结果唤醒的回合也属于“本回合的任务”。
   *
   * 事故 turn 2 由 `subagent-settled` 消息唤醒：它不是 human task，
   * `humanMessages()` 不认，`maybePlan()` 不会写 `state.activeTurns`，
   * 收尾闸门因此在 turn 2 直接放行，模型又在 11/13 时收尾。
   * 这里按会话事件判断“这一回合是否装载了本计划的续跑输入”，
   * 只认三类来源，且子 Agent 结算必须来自本计划派出过的 child，
   * 避免无关后台任务把闸门误激活。
   */
  function turnCarriesPlanWork(session: any, turn: number, record: any) {
    if (typeof session?.eventAt !== 'function' || !(turn >= 1)) return false
    const childIds = planChildIds(record)
    let started = -1
    for (let i = session.seq - 1; i >= 0; i -= 1) {
      const event = session.eventAt(i)
      if (event?.type === 'turn/start' && Number(event.data?.turn) === turn) {
        started = i
        break
      }
    }
    if (started < 0) return false
    for (let i = started + 1; i < session.seq; i += 1) {
      const event = session.eventAt(i)
      if (!event) continue
      if (event.type === 'turn/end' && Number(event.data?.turn) === turn) break
      if (event.type !== 'user/message') continue
      const message = event.data?.message ?? event.data
      const source = message?.source ?? {}
      const kind = String(source.kind ?? '')
      if (!PLAN_CONTINUATION_KINDS.has(kind)) continue
      if (kind === 'subagent-settled') {
        const sender = String(source.senderSessionId ?? '')
        /*
         * 只认“本计划派出过的 child”“本会话的真实子会话”或“父会话 spawn
         * 记录里出现过的 child”。第三者是 dispose 之后唯一还能取到的证据；
         * 三者都不命中时，无关后台任务不能把闸门误激活。
         */
        if (!childIds.has(sender) && !isChildSessionOf(sender, session) && !spawnedChildIds(session).has(sender)) continue
      }
      return true
    }
    return false
  }

  async function onTurnStopping(payload: any) {
    try {
      const agent = payload?.agent
      const session = agent?.session
      if (!agent || !session || !isRootSession(session)) return
      if (typeof agent.steer !== 'function') return
      const turn = Number(payload?.turn ?? 0)
      const known = state.records.get(session.id)
      /*
       * [1.8.8] 不再只认 human task 标记的 activeTurns：结算唤醒的回合
       * （subagent-settled / workplan-result / workplan-continue）同样装载
       * 了本计划的续跑输入，必须受同一道收尾闸门约束。
       */
      if (state.activeTurns?.get?.(session.id) !== turn && !turnCarriesPlanWork(session, turn, known)) return
      if (isPlanModeActive(ctx, session)) return
      let record = known
      if (!record?.plan) {
        // [1.8.14] N5：优先按本回合结算消息里点名的计划重建，而不是最后生成的计划。
        record = reconstructFromSession(session, planIdFromTurn(session, turn))
        if (record?.plan) state.records.set(session.id, record)
      }
      if (!stopGateApplies(record)) return
      if (record.dispatchPromise) {
        try {
          await record.dispatchPromise
        } catch {
          /* the failure is already on record.errors; the gate only needs the outcome */
        }
        finishRound(record, session)
        if (!stopGateApplies(record)) return
      }
      const book = record.stopSteers && record.stopSteers.turn === turn
        ? record.stopSteers
        : { turn, count: 0 }
      if (book.count >= STOP_STEER_LIMIT) return
      book.count += 1
      record.stopSteers = book
      const snapshot = derivePlanSnapshot(record.statuses)
      agent.steer(makeUserMessage(
        buildStopSteerText({
          planId: record.plan.planId,
          phase: record.phase,
          stats: snapshot.stats,
          statuses: snapshot.statuses,
          attempt: book.count,
        }),
        {
          kind: 'workplan-continue',
          form: 'notice',
          summary: `【计划未就绪】${snapshot.stats.done}/${snapshot.stats.total}，本回合被要求按未完成口径收尾或继续`,
        },
      ))
      ctx.logger?.warn?.(
        `dsh-workplan: 计划 ${record.plan.planId} 未通过交付就绪检查（${snapshot.stats.done}/${snapshot.stats.total}），`
        + `已在回合收尾前要求继续/如实收尾（第 ${book.count} 次）`,
      )
    } catch (error) {
      ctx.logger?.warn?.(`dsh-workplan: 回合收尾检查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * [1.8.8] present 的硬闸门：计划未完成时不允许把产物作为成品交付。
   *
   * 1.8.7 只把这条规则写进提示词；事故里模型在回合中途直接 present，
   * 交付卡片先出现、收尾闸门后到，卡片无法撤回。这里在工具执行前拒绝，
   * 与回合闸门形成前后两道防线。
   *
   * [1.8.13] 判据换成与回合闸门同一个 `deliveryReadiness`。
   *
   * 1.8.9 只拦三类硬缺口（自检失败/验收失败/产物缺失），而把 legacy、
   * unverified、空 acceptance、undefined verification 当作“软缺口”放行；
   * 同时 `planIncomplete` 对 cancelled 直接返回 false，于是“取消 1/3 再
   * present”也能过（T5-C）。这两条都被本会话的行为探针证实。现在：
   *  - 只有 `deliveryReady === true` 才能 present；
   *  - 取消、降级（有 plan 时）、全 blocked、全 done 但无结构化证据一律拒绝；
   *  - 拒绝文案必须给出可执行的出路（dispatch / update 补证 / 改 blocked），
   *    cancel 不再被写成交付许可。
   */
  function presentDenialReason(agent: any) {
    const session = agent?.session
    if (!session || !isRootSession(session)) return undefined
    if (isPlanModeActive(ctx, session)) return undefined
    let record = state.records.get(session.id)
    if (!record?.plan) {
      record = reconstructFromSession(session)
      if (record?.plan) state.records.set(session.id, record)
    }
    if (!record?.plan) return undefined
    const snapshot = derivePlanSnapshot(record.statuses)
    const readiness = deliveryReadiness(snapshot, { phase: record.phase })
    if (readiness.ready) return undefined
    const planId = record.plan?.planId ?? record.planId
    const ids = readiness.remaining.slice(0, 10).join('、')
    const idSuffix = ids ? `（${ids}${readiness.remaining.length > 10 ? '…' : ''}）` : ''
    const blockers = readiness.blockers.slice(0, 10).join('；')
    if (readiness.cancelled) {
      /*
       * [1.8.13] `deliveryReadiness` already puts the cancellation fact at the
       * head of `blockers`; repeating it here produced the T6b/C0 copy with the
       * same sentence twice. Only the *evidence* gaps belong in this suffix.
       */
      const gaps = readiness.blockers
        .filter((line) => !line.startsWith('计划已取消但只完成'))
        .slice(0, 10)
        .join('；')
      if (readiness.remaining.length === 0) {
        return `计划 ${planId} 已取消，${readiness.total} 个子任务虽已 done，但证据未通过：${gaps || '缺少结构化证据'}。`
          + '取消只停止执行，不等于完成：不得调用 present，不得声称“已完成/最终版/已交付”；'
          + '答复必须说明取消状态与证据缺口，不能写成“全部完成”。'
      }
      return `计划 ${planId} 已取消，但只完成 ${readiness.done}/${readiness.total}，剩余 ${readiness.remaining.length} 项${idSuffix}`
        + `${gaps ? `；证据缺口：${gaps}` : ''}。`
        + '取消只停止执行，不等于完成，也不会让未完成项变成可交付：不得调用 present，不得声称“已完成/最终版/已交付”；'
        + '答复开头必须写「未完成：剩余 N 项（列出 ID）与原因」。'
    }
    if (readiness.remaining.length === 0) {
      return `计划 ${planId} 的 ${readiness.total} 个子任务虽都已 done，但证据未通过：${blockers || '缺少结构化证据'}。`
        + '在 deliveryReady 变为 true 之前，产物不得作为成品交付：'
        + "用 dsh_workplan_update 为这些子任务补 verification='structured' 与 acceptance（每项 result='pass' 并附证据），"
        + '或把对应子任务改回 blocked 并写明原因；不要调用 present。'
    }
    return `计划 ${planId} 未完成：完成 ${readiness.done}/${readiness.total}，剩余 ${readiness.remaining.length} 项${idSuffix}`
      + `${blockers ? `；另有证据缺口：${blockers}` : ''}。`
      + '在计划通过交付就绪检查之前不得调用 present 交付产物：先调用 dsh_workplan_dispatch 续跑剩余项；'
      + '证据缺口用 dsh_workplan_update 补齐；确实无法继续时，把答复写成「未完成：剩余 N 项与原因」。'
      + '取消只停止执行，不会改变“未完成”的结论。'
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
    onTurnStopping,
    presentDenialReason,
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
  /*
   * [1.8.7] Remember that this turn carries a real task.
   *
   * `agent/turn-stopping` must only object on turns whose plan belongs to the
   * user's actual request. A plan left paused in an earlier turn must not turn
   * every later "谢谢/进度如何" turn into a forced 20-minute dispatch, so the
   * stop gate reads this marker and stays silent on social or status turns.
   */
  if (!state.activeTurns) state.activeTurns = new Map()
  state.activeTurns.set(session.id, Number(payload.turn ?? 0))
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
      deliveryReady: { type: 'boolean' },
      deliveryBlockers: { type: 'array' },
      deliveryRemaining: { type: 'array' },
      hint: { type: 'string' },
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
      /*
       * [1.8.14] `cancelRecorded` is the difference between "the UI says
       * cancelled" and "a restart will still say cancelled". A cancel whose
       * durable append failed reports false so the caller does not build on it.
       */
      cancelRecorded: { type: 'boolean' },
      alreadyCancelled: { type: 'boolean' },
      abortedRunning: { type: 'boolean' },
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
      version: { type: 'string' },
      // [1.8.14] Loaded-build identity: version alone cannot prove which bytes
      // the process is running after a rebuild or a profile recomposition.
      runtime: { type: 'object' },
      deliveryReady: { type: 'boolean' },
      deliveryBlockers: { type: 'array' },
      deliveryRemaining: { type: 'array' },
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
      /*
       * [1.8.7] `ok:true` used to be the only success signal, so a budget pause
       * (10/13) read as a finished dispatch. `complete` is the field the model
       * must test before it presents anything.
       */
      complete: { type: 'boolean' },
      remaining: { type: 'integer' },
      deliveryReady: { type: 'boolean' },
      deliveryBlockers: { type: 'array' },
      deliveryRemaining: { type: 'array' },
      version: { type: 'string' },
      runtime: { type: 'object' },
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
