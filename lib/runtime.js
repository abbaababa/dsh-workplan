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
import { randomUUID } from 'node:crypto';
import { MAX_CONCURRENT, PlanError, applyStatus, attachPlanMeta, buildChildPrompt, buildCancelMessage, buildDegradedMessage, buildPlanMessage, buildPlannerPrompt, buildResultMessage, createStatuses, derivePlanSnapshot, extractJson, flattenSubtasks, isRecord, isSocialMessage, isStatusQuestion, isVagueContinuation, markDependentsBlocked, messageText, readySubtasks, MAX_PLAN_RESUMES, canResumePlan, resetBlockedStatuses, parseCancelMessage, parseResultMessage, parseWorkplanMessage, planPhase, truncate, validatePlan, applyResultStatuses, } from './plan.js';
import { createProgressWatchdog, describeError } from './watchdog.js';
export const PLANNER_TIMEOUT_MS = 120000;
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
export const CHILD_TIMEOUT_MS = 900000;
/** No-progress window: the child's own session log stopped growing. */
export const CHILD_IDLE_TIMEOUT_MS = 300000;
/*
 * Floors exist to reject zero, negative and absurdly small values, not to
 * overrule an operator. The defaults above are what production uses; a floor of
 * 1s keeps diagnostics and tests able to exercise the timers without waiting
 * minutes.
 */
export const MIN_CHILD_TIMEOUT_MS = 1000;
export const MAX_CHILD_TIMEOUT_MS = 1800000;
export const MIN_CHILD_IDLE_MS = 1000;
export const MAX_CHILD_IDLE_MS = 900000;
export const CHILD_POLL_MS = 2000;
export const TOTAL_TIMEOUT_MS = 1200000;
export const DISPOSE_TIMEOUT_MS = 5000;
export const STALE_PENDING_MS = 10 * 60 * 1000;
export const MAX_HISTORY_EVENTS = 2000;
export const MAX_LIVE_SESSIONS = 20;
function abortError() {
    return new PlanError('执行已取消', 'ABORTED');
}
export function isRootSession(session) {
    const header = session?.header;
    if (!header)
        return true;
    if (header.parentSession)
        return false;
    if (header.origin === 'subagent')
        return false;
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
        return false;
    return true;
}
export function humanMessages(messages) {
    if (!Array.isArray(messages))
        return [];
    return messages.filter((message) => {
        if (!message || message.role !== 'user')
            return false;
        const kind = message.source?.kind;
        if (kind === undefined)
            return true;
        return kind === 'user';
    });
}
function taskTextFromMessages(messages) {
    const texts = [];
    for (const message of humanMessages(messages)) {
        const text = messageText(message).trim();
        if (text)
            texts.push(text);
    }
    return truncate(texts.join('\n\n'), 16000);
}
/*
 * Children start with zero parent context. Without recent turns they cannot
 * resolve "B", "it", "the previous item", so they search blindly and time out.
 * Build a bounded plain-text window from the session log (newest last) and pass
 * it to both the planner and every child. Plugin-generated plan/result rows are
 * excluded to avoid feeding the plan back into itself.
 */
function recentConversation(session, maxChars = 7000) {
    if (!session || typeof session.eventAt !== 'function')
        return '';
    const parts = [];
    let seq = typeof session.seq === 'number' ? session.seq - 1 : -1;
    let scanned = 0;
    let total = 0;
    while (seq >= 0 && scanned < 800 && total < maxChars) {
        const event = session.eventAt(seq);
        seq -= 1;
        scanned += 1;
        if (!event)
            continue;
        if (event.type !== 'user/message' && event.type !== 'assistant/message')
            continue;
        const message = event.data?.message ?? event.data;
        const kind = message?.source?.kind;
        if (kind === 'workplan' || kind === 'workplan-result')
            continue;
        const text = messageText(message).trim();
        if (!text)
            continue;
        const line = `${event.type === 'user/message' ? '用户' : '助手'}：${truncate(text, 1200)}`;
        parts.unshift(line);
        total += line.length + 2;
    }
    return truncate(parts.join('\n\n'), maxChars);
}
export function isPlanModeActive(ctx, session) {
    try {
        const service = ctx.get?.('sessionProjections');
        const snapshot = service?.snapshot?.(session, ['plan']);
        const state = snapshot?.values?.plan;
        return state?.active === true || state?.pending === true;
    }
    catch {
        return false;
    }
}
function enterDecision(downstream, extraMessages) {
    if (!downstream || downstream.kind !== 'enter')
        return downstream;
    const decision = { kind: 'enter', messages: [...downstream.messages, ...extraMessages] };
    if (downstream.startsRequestSeries === true)
        decision.startsRequestSeries = true;
    return decision;
}
function pushRecordError(record, error) {
    // String(error) on a plain object produced "[object Object]" in the durable
    // error list, which made the failure undiagnosable after the fact.
    const text = truncate(describeError(error), 1000);
    record.errors = [...(record.errors ?? []), text].slice(-20);
}
async function collectStream(stream) {
    let text = '';
    let textDeltaSeen = false;
    let finished = false;
    let finishKind = null;
    for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object')
            continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text;
            textDeltaSeen = true;
        }
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !textDeltaSeen) {
            text += chunk.block.text ?? '';
        }
        else if (chunk.type === 'finish') {
            finished = true;
            finishKind = chunk.reason?.kind ?? 'unknown';
            if (finishKind === 'error' || finishKind === 'aborted') {
                const failure = chunk.reason?.failure;
                throw new PlanError(`模型调用结束：${finishKind}${failure?.code ? ` ${failure.code}` : ''}${failure?.message ? `：${failure.message}` : ''}`, finishKind === 'aborted' ? 'ABORTED' : 'PLANNER_LLM_ERROR');
            }
            if (finishKind !== 'stop') {
                throw new PlanError(`规划器输出未正常结束：${finishKind}`, 'PLANNER_INCOMPLETE');
            }
        }
    }
    if (!finished)
        throw new PlanError('规划器没有返回终止信号', 'PLANNER_INCOMPLETE');
    if (!text.trim())
        throw new PlanError('规划器返回空内容', 'EMPTY_OUTPUT');
    return text;
}
async function runPlanner(ctx, options) {
    const { taskText, cwd, sessionId, modelSelection, signal, conversationContext = '' } = options;
    let lastErrors = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal.aborted)
            throw abortError();
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason ?? abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => {
            controller.abort(new PlanError('规划器超时', 'PLANNER_TIMEOUT'));
        }, PLANNER_TIMEOUT_MS);
        try {
            let prompt = buildPlannerPrompt(taskText, cwd, conversationContext);
            if (lastErrors.length > 0) {
                prompt += [
                    '',
                    '上一次输出未通过校验，请修复以下问题后重新输出完整 JSON：',
                    ...lastErrors.slice(0, 12).map((error) => `- ${error}`),
                ].join('\n');
            }
            const stream = ctx.llm.stream({
                provider: modelSelection.provider,
                model: modelSelection.model,
                reasoningEffort: modelSelection.reasoningEffort,
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                signal: controller.signal,
                sessionId,
            });
            const text = await collectStream(stream);
            const raw = extractJson(text);
            const validated = validatePlan(raw);
            if (validated.ok)
                return validated.plan;
            lastErrors = validated.errors ?? [];
        }
        catch (error) {
            if (signal.aborted || (controller.signal.aborted && controller.signal.reason?.code === 'ABORTED')) {
                throw abortError();
            }
            if (error instanceof PlanError && error.code === 'ABORTED')
                throw error;
            lastErrors = [error instanceof Error ? error.message : String(error)];
        }
        finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
        }
    }
    throw new PlanError(`规划器两次输出均未通过校验：${lastErrors.slice(0, 5).join('；')}`, 'PLANNER_FAILED', lastErrors);
}
function createChildController(parentSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason ?? abortError());
    if (parentSignal.aborted)
        onAbort();
    else
        parentSignal.addEventListener('abort', onAbort, { once: true });
    return {
        controller,
        disposeListener: () => parentSignal.removeEventListener('abort', onAbort),
    };
}
function waitForActivation(activation, signal) {
    const result = activation.result;
    result.catch(() => { });
    return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            reject(signal.reason ?? abortError());
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        result.then((value) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
function resultText(result) {
    const text = messageText({ content: result?.output ?? [] }).trim();
    return text;
}
async function disposeActivation(activation, record, subtaskId, guard) {
    let timer = null;
    try {
        await Promise.race([
            activation.dispose(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('dispose timeout')), DISPOSE_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]);
    }
    catch (error) {
        if (!guard?.timedOut) {
            record.errors = [
                ...record.errors,
                `${subtaskId} dispose: ${truncate(String(error?.message ?? error), 300)}`,
            ].slice(-20);
        }
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function clamp(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0)
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(numeric)));
}
/**
 * Absolute child ceiling, clamped so an operator cannot configure a value that
 * outlives the plan budget or a disabled timer.
 *
 * @param value - configured value, if any.
 * @returns milliseconds within `[MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS]`.
 */
export function normaliseChildTimeout(value) {
    return clamp(value, MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS, CHILD_TIMEOUT_MS);
}
/**
 * No-progress window, clamped to stay meaningful next to the ceiling.
 *
 * @param value - configured value, if any.
 * @returns milliseconds within `[MIN_CHILD_IDLE_MS, MAX_CHILD_IDLE_MS]`.
 */
export function normaliseIdleTimeout(value) {
    return clamp(value, MIN_CHILD_IDLE_MS, MAX_CHILD_IDLE_MS, CHILD_IDLE_TIMEOUT_MS);
}
/*
 * Every status write for a subtask goes through this guard. Once the
 * subtask-level deadline has fired, the subtask is already recorded as blocked;
 * a child that settles afterwards (for example an activation whose abort signal
 * was ignored) must not be allowed to rewrite that verdict to done.
 */
function writeSubtaskStatus(record, subtaskId, patch, guard) {
    if (guard.timedOut)
        return false;
    record.statuses = applyStatus(record.statuses, subtaskId, patch);
    record.updatedAt = Date.now();
    return true;
}
function recordSubtaskError(record, subtaskId, message, guard) {
    if (guard.timedOut)
        return;
    record.errors = [...record.errors, `${subtaskId}: ${truncate(message, 500)}`].slice(-20);
}
async function executeSubtask(ctx, record, stage, subtask, options) {
    const { parentSignal, deadline, modelSelection, conversationContext = '', child, guard } = options;
    let lastError = null;
    try {
        if (!writeSubtaskStatus(record, subtask.id, {
            status: 'in_progress',
            progress: 5,
            startedAt: Date.now(),
        }, guard))
            return;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            if (guard.timedOut)
                return;
            if (parentSignal.aborted)
                throw abortError();
            if (Date.now() >= deadline)
                throw new PlanError('总执行超时', 'TOTAL_TIMEOUT');
            let activation = null;
            try {
                if (child.controller.signal.aborted) {
                    throw child.controller.signal.reason ?? abortError();
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
                                        .filter((item) => subtask.dependsOn.includes(item.subtaskId))
                                        .map((item) => ({
                                        id: item.subtaskId,
                                        title: item.title,
                                        status: item.status,
                                        summary: item.summary,
                                    })),
                                    cwd: options.cwd,
                                    conversationContext,
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
                });
                if (guard.timedOut)
                    return;
                if (!activation || typeof activation.result?.then !== 'function') {
                    throw new PlanError('子 Agent 没有返回可等待的结果', 'NO_ACTIVATION');
                }
                writeSubtaskStatus(record, subtask.id, {
                    childId: activation.childId,
                    progress: 10,
                }, guard);
                const idleTimeoutMs = normaliseIdleTimeout(options.idleTimeoutMs);
                const hardTimeoutMs = normaliseChildTimeout(options.childTimeoutMs);
                const watchdog = createProgressWatchdog({
                    getSeq: () => {
                        try {
                            const childSession = ctx.sessions?.get?.(activation.childId);
                            const seq = childSession?.seq;
                            return typeof seq === 'number' ? seq : undefined;
                        }
                        catch {
                            return undefined;
                        }
                    },
                    idleMs: idleTimeoutMs,
                    hardMs: Math.max(1000, Math.min(hardTimeoutMs, deadline - Date.now())),
                    // Poll often enough to notice growth inside a short idle window, but
                    // never more than four times per window.
                    pollMs: Math.min(CHILD_POLL_MS, Math.max(20, Math.floor(idleTimeoutMs / 4))),
                    onProgress: ({ now }) => {
                        if (guard.timedOut)
                            return;
                        // Visible liveness: the dashboard can show that a slow subtask is
                        // still producing events instead of looking frozen.
                        record.heartbeatAt = now;
                        record.updatedAt = now;
                    },
                    makeError: (reason) => new PlanError(reason === 'stalled'
                        ? `子任务 ${subtask.id} 无进展超时（${idleTimeoutMs}ms 内子 Agent 没有产生任何新事件）`
                        : `子任务 ${subtask.id} 超时（${hardTimeoutMs}ms）`, reason === 'stalled' ? 'CHILD_STALLED' : 'CHILD_TIMEOUT', { subtaskId: subtask.id }),
                });
                let result;
                try {
                    const waiter = waitForActivation(activation, child.controller.signal);
                    // The losing side of the race may reject after the watchdog fired;
                    // keep that rejection handled so Node never reports it as unhandled.
                    waiter.catch(() => { });
                    result = await Promise.race([waiter, watchdog.fired]);
                }
                finally {
                    watchdog.stop();
                }
                if (guard.timedOut)
                    return;
                const output = resultText(result);
                if (result.stopReason !== 'completed') {
                    throw new PlanError(`子 Agent 结束状态为 ${result.stopReason}${result.diagnostic ? `：${result.diagnostic}` : ''}`, 'CHILD_NOT_COMPLETED');
                }
                if (!output)
                    throw new PlanError('子 Agent 没有返回文本结果', 'EMPTY_CHILD_OUTPUT');
                if (/^\s*BLOCKED\s*[:：]/i.test(output)) {
                    writeSubtaskStatus(record, subtask.id, {
                        status: 'blocked',
                        progress: 100,
                        finishedAt: Date.now(),
                        summary: truncate(output, 3000),
                        error: truncate(output.replace(/^\s*BLOCKED\s*[:：]\s*/i, ''), 2000),
                    }, guard);
                    recordSubtaskError(record, subtask.id, output, guard);
                    return;
                }
                writeSubtaskStatus(record, subtask.id, {
                    status: 'done',
                    progress: 100,
                    finishedAt: Date.now(),
                    summary: truncate(output, 3000),
                    error: null,
                }, guard);
                return;
            }
            catch (error) {
                lastError = error;
                if (guard.timedOut)
                    break;
                const isAbort = parentSignal.aborted || child.controller.signal.aborted;
                /*
                 * Two failure kinds, two different correct reactions.
                 *
                 * A stalled child is wedged — no event for the whole idle window — so
                 * one fresh attempt can succeed and is worth trying. A hard ceiling
                 * means the budget is gone, so retrying would only burn the plan's
                 * remaining time; it goes straight to blocked.
                 */
                const stalled = error?.code === 'CHILD_STALLED';
                if (stalled && attempt < 2 && !isAbort) {
                    record.errors = [
                        ...record.errors,
                        `${subtask.id}: 第 ${attempt} 次执行无进展，已停止并重试`,
                    ].slice(-20);
                    writeSubtaskStatus(record, subtask.id, { progress: 15 }, guard);
                    continue;
                }
                if (isAbort || attempt >= 2 || error?.code === 'CHILD_NOT_COMPLETED' && /aborted|refusal/i.test(String(error?.message ?? ''))) {
                    break;
                }
                writeSubtaskStatus(record, subtask.id, { progress: 15 }, guard);
            }
            finally {
                if (activation) {
                    await disposeActivation(activation, record, subtask.id, guard);
                    activation = null;
                }
            }
        }
        const message = describeError(lastError ?? new Error('未知失败'));
        writeSubtaskStatus(record, subtask.id, {
            status: 'blocked',
            progress: 100,
            finishedAt: Date.now(),
            error: truncate(message, 2000),
            summary: truncate(`未完成：${message}`, 3000),
        }, guard);
        recordSubtaskError(record, subtask.id, message, guard);
    }
    catch (error) {
        const message = describeError(error);
        try {
            writeSubtaskStatus(record, subtask.id, {
                status: 'blocked',
                progress: 100,
                finishedAt: Date.now(),
                error: truncate(message, 2000),
                summary: truncate(`未完成：${message}`, 3000),
            }, guard);
        }
        catch {
            // The status list itself is unusable; the outer dispatcher records the error.
        }
        recordSubtaskError(record, subtask.id, message, guard);
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
async function runSubtask(ctx, record, stage, subtask, options) {
    const childTimeoutMs = normaliseChildTimeout(options.childTimeoutMs);
    const child = createChildController(options.parentSignal);
    const guard = { timedOut: false };
    let timer = null;
    const deadlinePromise = new Promise((resolve) => {
        timer = setTimeout(() => {
            guard.timedOut = true;
            // Reached only when the child ignored both its idle window and its
            // abort signal; the message says so, otherwise the cause looks like a
            // plain "too slow" and the next investigation goes down the wrong path.
            const message = `子任务 ${subtask.id} 达到执行上限（${childTimeoutMs}ms），已强制结束`;
            try {
                record.statuses = applyStatus(record.statuses, subtask.id, {
                    status: 'blocked',
                    progress: 100,
                    finishedAt: Date.now(),
                    error: message,
                    summary: truncate(`未完成：${message}`, 3000),
                });
                record.errors = [...record.errors, `${subtask.id}: ${message}`].slice(-20);
                record.updatedAt = Date.now();
            }
            catch (error) {
                record.errors = [
                    ...record.errors,
                    `${subtask.id}: 超时状态写入失败：${truncate(String(error?.message ?? error), 500)}`,
                ].slice(-20);
            }
            finally {
                if (!child.controller.signal.aborted) {
                    child.controller.abort(new PlanError(message, 'CHILD_TIMEOUT', { subtaskId: subtask.id }));
                }
                child.disposeListener();
                resolve();
            }
        }, childTimeoutMs);
        timer.unref?.();
    });
    try {
        await Promise.race([
            executeSubtask(ctx, record, stage, subtask, {
                ...options,
                child,
                guard,
            }),
            deadlinePromise,
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        child.disposeListener();
        if (!child.controller.signal.aborted)
            child.controller.abort();
    }
}
async function runWithConcurrency(items, limit, worker) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length)
                return;
            await worker(items[index], index);
        }
    });
    await Promise.all(workers);
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
export function buildRoundResult(record, sessionId, limits) {
    const { statuses, stats } = derivePlanSnapshot(record.statuses);
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
    });
}
export async function dispatchPlan(ctx, record, options) {
    const { agent, signal, modelSelection, cwd, conversationContext = '' } = options;
    const deadline = Date.now() + (options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
    /*
     * Resume, do not restart.
     *
     * A blocked plan used to be terminal: every subtask was `blocked`, so
     * `readySubtasks()` returned nothing and the dispatcher broke out having run
     * zero children. Clearing only the failed attempts keeps finished work (and
     * its side effects) while giving the rest a second chance, and the resume
     * budget stops a subtask that always fails from looping forever.
     */
    const resume = canResumePlan(record, options.maxResumes ?? MAX_PLAN_RESUMES);
    if (resume.resume) {
        /*
         * Continuing after a budget pause is not a repair, so it is not charged
         * against the resume budget and it does not reset anything: the paused
         * subtasks are already `pending`. Only a `blocked` plan pays a resume and
         * needs its failed attempts cleared.
         */
        const repairing = record.phase === 'blocked';
        if (repairing)
            record.resumeCount = Number(record.resumeCount ?? 0) + 1;
        record.statuses = resetBlockedStatuses(record.statuses);
        // A resume produces a new durable outcome; without clearing this flag the
        // second result message was never written and a page refresh replayed the
        // stale blocked state.
        record.resultWritten = false;
        record.error = null;
        if (repairing) {
            record.errors = [
                ...(record.errors ?? []),
                `第 ${record.resumeCount} 次续跑：已重置 ${resume.failed} 个受阻子任务（已完成的不重跑）`,
            ].slice(-20);
        }
        else {
            record.errors = (record.errors ?? []).filter((line) => !/预算|续跑/.test(String(line))).slice(-20);
        }
    }
    const parentSignal = signal;
    const childController = new AbortController();
    const onAbort = () => childController.abort(parentSignal.reason ?? abortError());
    if (parentSignal.aborted)
        onAbort();
    else
        parentSignal.addEventListener('abort', onAbort, { once: true });
    const totalTimer = setTimeout(() => {
        childController.abort(new PlanError('总执行超时', 'TOTAL_TIMEOUT'));
    }, Math.max(1000, deadline - Date.now()));
    totalTimer.unref?.();
    record.dispatchedAt = Date.now();
    record.phase = 'executing';
    record.updatedAt = record.dispatchedAt;
    try {
        let guard = 0;
        while (true) {
            guard += 1;
            if (guard > 200)
                throw new PlanError('调度次数异常', 'DISPATCH_LOOP');
            if (parentSignal.aborted)
                throw abortError();
            if (Date.now() >= deadline)
                throw new PlanError('总执行超时', 'TOTAL_TIMEOUT');
            const ready = readySubtasks(record.plan, record.statuses);
            if (ready.length === 0) {
                const pending = record.statuses.filter((item) => item.status === 'pending');
                for (const item of pending) {
                    record.statuses = applyStatus(record.statuses, item.subtaskId, {
                        status: 'blocked',
                        error: '依赖未完成或上游受阻',
                    });
                }
                break;
            }
            await runWithConcurrency(ready, MAX_CONCURRENT, async (item) => {
                // readySubtasks() returns subtask objects (they carry `id`, not
                // `subtaskId`); using the status key here silently skipped every task
                // and spun the dispatcher until DISPATCH_LOOP marked all blocked.
                const entry = flattenSubtasks(record.plan)
                    .find((candidate) => candidate.subtask.id === item.id);
                if (!entry)
                    return;
                await runSubtask(ctx, record, entry.stage, entry.subtask, {
                    agent,
                    parentSignal: childController.signal,
                    deadline,
                    childTimeoutMs: options.childTimeoutMs,
                    idleTimeoutMs: options.idleTimeoutMs,
                    modelSelection,
                    cwd,
                    conversationContext,
                });
            });
            const blocked = record.statuses
                .filter((item) => item.status === 'blocked')
                .map((item) => item.subtaskId);
            for (const id of blocked) {
                record.statuses = markDependentsBlocked(record.plan, record.statuses, id);
            }
            /*
             * No stats refresh here any more: `serialisePlan` derives the counts from
             * exactly the list it ships, so a cache can no longer lag behind the work.
             */
            record.updatedAt = Date.now();
        }
        record.phase = planPhase(record.statuses);
    }
    catch (error) {
        const message = describeError(error);
        pushRecordError(record, error);
        const budgetExhausted = error?.code === 'TOTAL_TIMEOUT' && !parentSignal.aborted;
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
            let reset = record.statuses;
            for (const item of record.statuses) {
                if (item.status === 'done')
                    continue;
                reset = applyStatus(reset, item.subtaskId, {
                    status: 'pending',
                    error: '本轮预算用尽，等待续跑',
                });
            }
            record.statuses = reset;
            record.phase = 'paused';
            const total = record.statuses.length;
            const done = record.statuses.filter((item) => item.status === 'done').length;
            const minutes = Math.max(1, Math.round((options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) / 60000));
            record.error = `本轮执行预算（${minutes} 分钟）已到：已完成 ${done}/${total}，其余 ${total - done} 项保留为未完成，再次派发本计划即可续跑（已完成的不重跑）`;
            /*
             * Drop the failure lines the aborted children wrote on their way out.
             * They used to survive into the result payload as
             * `["T4: 总执行超时", "总执行超时", …]`, so the model read a failure
             * report for subtasks that were explicitly *not* failures.
             */
            record.errors = [
                ...(record.errors ?? []).filter((line) => !/总执行超时/.test(String(line))),
                record.error,
            ].slice(-20);
        }
        else {
            /*
             * `blocked` is a terminal state, so it always reports progress 100 — the
             * same rule the other four blocked writers follow. Carrying the partial
             * number over (`item.progress ?? 0`) made one failure show up as 0 %, 15 %
             * or 100 % depending on which branch happened to write it.
             */
            record.statuses = record.statuses.map((item) => {
                if (item.status === 'pending' || item.status === 'in_progress') {
                    return {
                        ...item,
                        status: 'blocked',
                        progress: 100,
                        error: truncate(message, 2000),
                        finishedAt: item.finishedAt ?? Date.now(),
                    };
                }
                return item;
            });
            record.phase = parentSignal.aborted ? 'cancelled' : 'blocked';
        }
    }
    finally {
        clearTimeout(totalTimer);
        parentSignal.removeEventListener('abort', onAbort);
        if (!childController.signal.aborted)
            childController.abort();
        record.updatedAt = Date.now();
    }
    return record;
}
function serialisePlan(record, session) {
    const plan = record.plan ?? null;
    /*
     * Counts are derived here, once, from the very array that is shipped.
     *
     * `stats` used to be read from `record.stats`, a cache refreshed only between
     * dispatch batches, while `departments` below was aggregated live. The same
     * payload could therefore report “0 正在做” in the header while a stage badge
     * built from `statuses` said otherwise. Deriving both from one normalised
     * snapshot makes that contradiction structurally impossible.
     */
    const snapshot = derivePlanSnapshot(Array.isArray(record.statuses) && record.statuses.length > 0
        ? record.statuses
        : plan
            ? createStatuses(plan)
            : []);
    const statuses = snapshot.statuses;
    const stats = snapshot.stats;
    let phase = record.phase ?? (plan ? planPhase(statuses) : 'degraded');
    if (phase === 'pending' && !record.dispatchedAt && plan?.createdAt && Date.now() - plan.createdAt > STALE_PENDING_MS) {
        phase = 'cancelled';
    }
    return {
        sessionId: session.id,
        planId: record.planId ?? plan?.planId ?? null,
        title: plan?.title ?? record.title ?? '任务进度',
        phase,
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
    };
}
function readToolArguments(value) {
    if (isRecord(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        try {
            const parsed = JSON.parse(value);
            return isRecord(parsed) ? parsed : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
export function reconstructFromSession(session, targetPlanId) {
    const start = Math.max(0, session.seq - MAX_HISTORY_EVENTS);
    let plan = null;
    let statuses = [];
    let degraded = null;
    let resultSeen = false;
    // A round-budget pause must survive a page refresh; otherwise the replayed
    // plan looks “executing” forever (nothing is running) and the card stops
    // telling the user it can simply be dispatched again.
    let resultPhase = '';
    let cancelled = false;
    let resumeCount = 0;
    /*
     * Older plans stay dispatchable.
     *
     * The replayed state used to be "whatever the newest plan message says", so a
     * plan paused before a restart became unreachable the moment the next turn
     * generated a new plan: the rebuild answered with the new plan and every
     * dispatch of the old one failed with PLAN_ID_MISMATCH. Keep a snapshot per
     * plan and let the caller ask for a specific one.
     */
    const finished = [];
    const snapshot = () => ({ plan, statuses, resultPhase, resultSeen, resumeCount, cancelled });
    for (let seq = start; seq < session.seq; seq += 1) {
        let event;
        try {
            event = session.eventAt(seq);
        }
        catch {
            continue;
        }
        if (!event)
            continue;
        if (event.type === 'user/message') {
            const payload = parseWorkplanMessage(event.data);
            if (payload?.degraded) {
                degraded = payload;
                plan = null;
                statuses = [];
                cancelled = false;
            }
            else if (payload?.plan) {
                if (plan)
                    finished.push(snapshot());
                plan = payload.plan;
                statuses = createStatuses(plan);
                cancelled = false;
                /*
                 * A new plan must not inherit the previous plan's round phase.
                 *
                 * `resultPhase` outlived the old plan, so after a paused plan the next
                 * plan in the same session replayed as `paused` before its first
                 * dispatch — the card claimed the new plan was out of budget when it had
                 * not started. Only a result message for *this* plan may set it.
                 */
                resultPhase = '';
                resultSeen = false;
                resumeCount = 0;
            }
            const result = parseResultMessage(event.data);
            if (result && plan && result.planId === plan.planId) {
                statuses = applyResultStatuses(statuses, result);
                // Resume bookkeeping must survive a page refresh, otherwise the budget
                // silently resets and a never-succeeding subtask can loop forever.
                resumeCount = Number(result.resumeCount ?? resumeCount) || 0;
                resultPhase = typeof result.phase === 'string' ? result.phase : '';
                resultSeen = true;
            }
            const cancel = parseCancelMessage(event.data);
            if (cancel && plan && cancel.planId === plan.planId) {
                cancelled = true;
            }
        }
        else if (event.type === 'tool/call' && plan) {
            const data = event.data;
            if (data?.name === 'dsh_workplan_update') {
                const args = readToolArguments(data.arguments);
                if (args && typeof args.subtaskId === 'string' && typeof args.status === 'string') {
                    try {
                        statuses = applyStatus(statuses, args.subtaskId, {
                            status: args.status,
                            progress: typeof args.progress === 'number' ? args.progress : undefined,
                            summary: typeof args.note === 'string' ? args.note : undefined,
                        });
                    }
                    catch {
                        // An invalid historical call is ignored; the live cache remains authoritative.
                    }
                }
            }
        }
    }
    if (!plan && !degraded)
        return null;
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
        };
    }
    if (!plan)
        return null;
    if (targetPlanId && plan.planId !== targetPlanId) {
        const hit = finished.find((item) => item.plan?.planId === targetPlanId);
        if (!hit)
            return null;
        ({ plan, statuses, resultPhase, resultSeen, resumeCount, cancelled } = hit);
    }
    let phase = planPhase(statuses, resultSeen);
    if (resultPhase === 'paused' && statuses.some((item) => item.status !== 'done'))
        phase = 'paused';
    if (cancelled)
        phase = 'cancelled';
    /*
     * An old plan that was never dispatched used to be relabelled `cancelled`,
     * which also made it permanently unresumable — the card said "已取消" and no
     * amount of dispatching would move it. Keep it `pending`, and expose the age
     * as a separate flag so the UI can prompt instead of silently closing it.
     */
    const stalePending = phase === 'pending' && Boolean(plan.createdAt)
        && Date.now() - Number(plan.createdAt) > STALE_PENDING_MS;
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
    };
}
function liveSessions(ctx) {
    try {
        const sessions = ctx.sessions?.list?.();
        return Array.isArray(sessions) ? sessions : [];
    }
    catch {
        return [];
    }
}
function findSession(ctx, sessionId) {
    try {
        const session = ctx.sessions?.get?.(sessionId) ?? null;
        return session && isRootSession(session) ? session : null;
    }
    catch {
        return null;
    }
}
export function buildPlansPayload(ctx, state, sessionId) {
    let sessions = liveSessions(ctx).filter((session) => isRootSession(session));
    if (sessionId) {
        const match = sessions.find((session) => session.id === sessionId) ?? findSession(ctx, sessionId);
        sessions = match ? [match] : [];
    }
    sessions.sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0));
    sessions = sessions.slice(0, MAX_LIVE_SESSIONS);
    const items = [];
    for (const session of sessions) {
        let record = state.records.get(session.id);
        if (!record)
            record = reconstructFromSession(session);
        if (!record)
            continue;
        items.push(serialisePlan(record, session));
    }
    return { ok: true, now: Date.now(), sessions: items };
}
function respondJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
    });
    if (res.req?.method === 'HEAD') {
        res.end();
        return;
    }
    res.end(body);
}
export function createWorkplanRuntime(ctx, options = {}) {
    const state = { records: new Map() };
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
    };
    async function onPreStep(payload, next) {
        let downstream;
        try {
            downstream = await next();
        }
        catch (error) {
            throw error;
        }
        if (downstream?.kind !== 'enter')
            return downstream;
        try {
            return await maybePlan(ctx, state, payload, downstream, options);
        }
        catch (error) {
            try {
                const session = payload.agent?.session;
                const planId = `wp-${randomUUID()}`;
                const message = buildDegradedMessage({
                    planId,
                    sessionId: session?.id ?? 'unknown',
                    createdTurn: payload.turn,
                    createdAt: Date.now(),
                    error: error instanceof Error ? error.message : String(error),
                    taskText: taskTextFromMessages(payload.messages),
                });
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
                    });
                }
                return enterDecision(downstream, [message]);
            }
            catch {
                return downstream;
            }
        }
    }
    async function updateStatus(agent, args) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内更新计划', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能更新主计划', 'NOT_ROOT');
        const record = state.records.get(session.id);
        if (!record?.plan)
            throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN');
        if (args?.planId && record.plan.planId !== args.planId) {
            throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH');
        }
        const subtaskId = typeof args?.subtaskId === 'string' ? args.subtaskId : '';
        if (!subtaskId)
            throw new PlanError('缺少 subtaskId', 'MISSING_SUBTASK');
        const status = typeof args?.status === 'string' ? args.status : '';
        if (!['pending', 'in_progress', 'done', 'blocked'].includes(status)) {
            throw new PlanError('status 必须是 pending / in_progress / done / blocked', 'INVALID_STATUS');
        }
        const note = typeof args?.note === 'string' ? args.note : '';
        const evidence = Array.isArray(args?.evidence)
            ? args.evidence.filter((item) => typeof item === 'string').join('；')
            : '';
        const summary = [note, evidence].filter(Boolean).join('｜');
        record.statuses = applyStatus(record.statuses, subtaskId, {
            status,
            progress: typeof args?.progress === 'number' ? args.progress : undefined,
            summary: summary || undefined,
            error: status === 'blocked' ? (summary || '由主 Agent 标记为受阻') : undefined,
        });
        if (status === 'blocked') {
            record.statuses = markDependentsBlocked(record.plan, record.statuses, subtaskId);
        }
        record.phase = planPhase(record.statuses);
        record.updatedAt = Date.now();
        const snapshot = derivePlanSnapshot(record.statuses);
        return {
            ok: true,
            planId: record.plan.planId,
            subtaskId,
            status: snapshot.statuses.find((item) => item.subtaskId === subtaskId)?.status ?? status,
            stats: snapshot.stats,
        };
    }
    async function cancelPlan(agent, args) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内取消计划', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能取消主计划', 'NOT_ROOT');
        let record = state.records.get(session.id);
        if (!record?.plan)
            record = reconstructFromSession(session);
        if (!record?.plan)
            throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN');
        if (args?.planId && record.plan.planId !== args.planId) {
            throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH');
        }
        const reason = typeof args?.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '用户取消';
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
            record.phase = 'cancelled';
            record.error = `计划已取消：${reason}`;
            record.updatedAt = Date.now();
            let aborted = false;
            try {
                record.abortDispatch?.(reason);
                aborted = true;
            }
            catch (error) {
                record.errors = [...(record.errors ?? []), `取消时中止执行失败：${String(error?.message ?? error)}`].slice(-20);
            }
            return {
                ok: true,
                planId: record.plan.planId,
                phase: 'cancelled',
                reason,
                abortedRunning: aborted,
                stats: derivePlanSnapshot(record.statuses).stats,
            };
        }
        record.phase = 'cancelled';
        record.error = `计划已取消：${reason}`;
        record.updatedAt = Date.now();
        const message = buildCancelMessage(record.plan.planId, reason);
        session.append('user/message', message, { surfaceOp: 'append' });
        state.records.set(session.id, record);
        return {
            ok: true,
            planId: record.plan.planId,
            phase: 'cancelled',
            reason,
            stats: derivePlanSnapshot(record.statuses).stats,
        };
    }
    async function dispatchTool(agent, args, signal) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内派发计划', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能派发主计划', 'NOT_ROOT');
        let record = state.records.get(session.id);
        const requestedPlanId = typeof args?.planId === 'string' ? args.planId : undefined;
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
        const needsRebuild = !record?.plan || Boolean(requestedPlanId && record.plan.planId !== requestedPlanId);
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
            const rebuilt = reconstructFromSession(session, requestedPlanId);
            if (rebuilt?.plan) {
                rebuilt.resumeLimit = limits.maxResumes;
                state.records.set(session.id, rebuilt);
                record = rebuilt;
            }
        }
        if (!record?.plan)
            throw new PlanError('当前会话没有可派发的计划', 'NO_PLAN');
        if (args?.planId && record.plan.planId !== args.planId) {
            throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH');
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
            const startedAt = Number(record.dispatchStartedAt ?? 0);
            const staleAfter = limits.totalTimeoutMs + 120000;
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
                };
            }
            return { ok: true, planId: record.plan.planId, alreadyRunning: true, phase: record.phase, startedAt: startedAt || null };
        }
        /*
         * Refuse with an explanation instead of silently "succeeding".
         *
         * Re-dispatching an all-blocked plan used to fall straight through to
         * `readySubtasks()`, find nothing ready, and answer `{ ok: true }` without
         * running a single child. The model read that as success, so a plan that hit
         * one timeout could never move again.
         */
        const resume = canResumePlan(record, limits.maxResumes);
        if (record.phase === 'blocked' && resume.failed > 0 && !resume.resume) {
            return {
                ok: false,
                planId: record.plan.planId,
                phase: record.phase,
                resume,
                stats: derivePlanSnapshot(record.statuses).stats,
                error: resume.reason,
                hint: '这些子任务不会再自动重跑，请主 Agent 直接完成它们，并在答复中如实说明哪些未能自动完成。',
            };
        }
        record.dispatchStartedAt = Date.now();
        record.resumeLimit = limits.maxResumes;
        const selection = {
            provider: agent?.options?.provider,
            model: agent?.options?.model,
            reasoningEffort: agent?.options?.reasoningEffort,
        };
        /*
         * The dispatch runs under its own controller so a user cancel can actually
         * stop it. Passing the tool's abort signal alone was not enough: cancelling
         * while running was refused outright, which stranded a wedged dispatch.
         */
        const dispatchController = new AbortController();
        const onToolAbort = () => dispatchController.abort(signal?.reason ?? abortError());
        if (signal?.aborted)
            onToolAbort();
        else
            signal?.addEventListener?.('abort', onToolAbort, { once: true });
        record.abortDispatch = (reason) => {
            if (!dispatchController.signal.aborted) {
                dispatchController.abort(new PlanError(`计划已取消：${reason}`, 'CANCELLED'));
            }
        };
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
            record.dispatchPromise = null;
            record.dispatchStartedAt = null;
            record.abortDispatch = null;
            signal?.removeEventListener?.('abort', onToolAbort);
        });
        await record.dispatchPromise;
        if (!record.resultWritten) {
            const resultMessage = buildRoundResult(record, session.id, limits);
            try {
                session.append('user/message', resultMessage, { surfaceOp: 'append' });
                record.resultWritten = true;
            }
            catch (error) {
                ctx.logger?.warn?.(`dsh-workplan: 写入结果消息失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (record.resultWritten && record.statuses.length > 0 && record.statuses.every((item) => item.status === 'done')) {
            record.phase = 'done';
        }
        /*
         * The model's dispatch result reports the same snapshot the dashboard will
         * show. It used to send `record.stats` while the status list below was read
         * fresh, so one reply could say “已完成 11” next to twelve finished rows.
         */
        const snapshot = derivePlanSnapshot(record.statuses);
        return {
            ok: true,
            planId: record.plan.planId,
            alreadyRunning: false,
            phase: record.phase,
            stats: snapshot.stats,
            statuses: snapshot.statuses.map((item) => ({
                subtaskId: item.subtaskId,
                title: item.title,
                department: item.department,
                status: item.status,
                progress: item.progress,
                summary: truncate(item.summary ?? item.error ?? '', 2000),
                error: item.error ?? null,
            })),
        };
    }
    function plansPayload(sessionId) {
        return buildPlansPayload(ctx, state, sessionId);
    }
    async function route(req, res, connectionCtx = ctx) {
        let rejection;
        try {
            rejection = await Promise.resolve(connectionCtx?.connection?.requestRejection?.(req));
        }
        catch {
            respondJson(res, 403, { ok: false, error: '未授权的请求' });
            return;
        }
        if (rejection) {
            respondJson(res, typeof rejection === 'number' ? rejection : 401, {
                ok: false,
                error: '未授权的请求',
            });
            return;
        }
        let url;
        try {
            url = new URL(req.url ?? '/', 'http://localhost');
        }
        catch {
            respondJson(res, 400, { ok: false, error: '无效的请求地址' });
            return;
        }
        if (url.pathname !== '/dsh-workplan/plans') {
            respondJson(res, 404, { ok: false, error: '未找到' });
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' });
            res.end();
            return;
        }
        try {
            const payload = plansPayload(url.searchParams.get('sessionId') ?? undefined);
            const body = JSON.stringify(payload);
            if (body.length > 2_500_000) {
                respondJson(res, 200, { ...payload, truncated: true, sessions: payload.sessions.slice(0, 12) });
                return;
            }
            if (req.method === 'HEAD') {
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                    'content-length': Buffer.byteLength(body),
                });
                res.end();
                return;
            }
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(body),
            });
            res.end(body);
        }
        catch (error) {
            respondJson(res, 500, {
                ok: false,
                error: truncate(error instanceof Error ? error.message : String(error), 500),
            });
        }
    }
    function dispose() {
        state.records.clear();
    }
    return {
        state,
        limits,
        onPreStep,
        updateStatus,
        cancelPlan,
        dispatchTool,
        plansPayload,
        route,
        dispose,
        planModeActive: (session) => isPlanModeActive(ctx, session),
    };
}
function resolveModelSelection(ctx, payload) {
    const direct = payload.modelSelection;
    if (direct?.provider && direct?.model) {
        return {
            provider: direct.provider,
            model: direct.model,
            reasoningEffort: direct.reasoningEffort,
        };
    }
    const agentOptions = payload.agent?.options;
    if (agentOptions?.provider && agentOptions?.model) {
        return {
            provider: agentOptions.provider,
            model: agentOptions.model,
            reasoningEffort: agentOptions.reasoningEffort,
        };
    }
    try {
        const current = ctx.get?.('agentDefaultModel')?.currentSelection?.();
        if (current?.provider && current?.model) {
            return {
                provider: current.provider,
                model: current.model,
                reasoningEffort: current.reasoningEffort,
            };
        }
    }
    catch {
        // The headless profile may not register a default-model service.
    }
    return null;
}
async function maybePlan(ctx, state, payload, downstream, options) {
    const session = payload.agent?.session;
    if (!session || !isRootSession(session))
        return downstream;
    if (payload.step !== 1)
        return downstream;
    const planMode = isPlanModeActive(ctx, session);
    const human = humanMessages(payload.messages);
    if (human.length === 0)
        return downstream;
    const taskText = taskTextFromMessages(payload.messages);
    if (!taskText)
        return downstream;
    if (isSocialMessage(taskText))
        return downstream;
    if (isVagueContinuation(taskText))
        return downstream;
    if (isStatusQuestion(taskText))
        return downstream;
    const conversationContext = recentConversation(session);
    const existing = state.records.get(session.id);
    if (existing?.plan?.createdTurn === payload.turn)
        return downstream;
    // A plan generated in plan mode is intentionally deferred: keep it intact
    // until the user leaves plan mode and dispatches it. Cancelling it here
    // would make the plan disappear before the main Agent can act on approval.
    if (existing?.plan && existing.planMode && !existing.dispatchedAt)
        return downstream;
    // A plan committed but not yet dispatched must not be overwritten in the
    // same turn; a later turn may supersede it, otherwise one abandoned plan
    // would lock planning forever.
    if (existing?.plan && !existing.dispatchedAt) {
        if (existing.plan.createdTurn === payload.turn)
            return downstream;
        existing.phase = 'cancelled';
        existing.cancelledAt = Date.now();
        existing.updatedAt = existing.cancelledAt;
        existing.errors = Array.isArray(existing.errors) ? existing.errors : [];
        existing.errors.push('计划已取消：上一轮未派发');
    }
    if (existing?.dispatchPromise || existing?.phase === 'executing')
        return downstream;
    const modelSelection = resolveModelSelection(ctx, payload);
    if (!modelSelection?.provider || !modelSelection?.model) {
        const message = buildDegradedMessage({
            planId: `wp-${randomUUID()}`,
            sessionId: session.id,
            createdTurn: payload.turn,
            createdAt: Date.now(),
            error: '没有可用的模型路由，无法生成计划',
            taskText,
        });
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
        });
        return enterDecision(downstream, [message]);
    }
    let plan;
    try {
        plan = await runPlanner(ctx, {
            taskText,
            cwd: session.header?.cwd ?? options.cwd,
            sessionId: session.id,
            modelSelection,
            signal: payload.signal,
            conversationContext,
        });
    }
    catch (error) {
        if (payload.signal.aborted)
            return downstream;
        const planId = `wp-${randomUUID()}`;
        const createdAt = Date.now();
        const message = buildDegradedMessage({
            planId,
            sessionId: session.id,
            createdTurn: payload.turn,
            createdAt,
            error: error instanceof Error ? error.message : String(error),
            taskText,
        });
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
        });
        return enterDecision(downstream, [message]);
    }
    if (payload.signal.aborted)
        return downstream;
    const planId = `wp-${randomUUID()}`;
    const createdAt = Date.now();
    const fullPlan = attachPlanMeta(plan, {
        planId,
        sessionId: session.id,
        createdTurn: payload.turn,
        createdAt,
        sourceMessageIds: human.map((message) => message.id).filter((id) => typeof id === 'string'),
    });
    const record = {
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
    };
    state.records.set(session.id, record);
    /*
     * Plan-first: commit the plan with this step and let the main Agent call
     * dsh_workplan_dispatch. Dispatching here would hide the plan until every
     * child finished, which is exactly the "没动静/没完成" failure. The dispatch
     * tool appends the durable result after the children finish, and tools.guard
     * stops the main Agent from doing other work before dispatching.
     */
    const planMessage = buildPlanMessage(fullPlan);
    if (!planMode)
        return enterDecision(downstream, [planMessage]);
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
    };
    return enterDecision(downstream, [planMessage, note]);
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
    };
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
    };
}
export function dispatchToolOutputSchema() {
    return {
        type: 'object',
        properties: {
            ok: { type: 'boolean' },
            planId: { type: 'string' },
            alreadyRunning: { type: 'boolean' },
            stale: { type: 'boolean' },
            phase: { type: 'string' },
            stats: { type: 'object' },
            error: { type: 'string' },
            hint: { type: 'string' },
            resume: { type: 'object' },
        },
        required: ['ok'],
        additionalProperties: true,
    };
}
