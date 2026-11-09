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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createNoticeChannel, finaliseNoticeChannel, formatNoticeChannelLog, observeRelayedNotice, readLeadAgentId, resolveLeadAgentId, validateNoticeChannel, } from './notice-channel.js';
import { MAX_CONCURRENT, PlanError, aggregateInvariantViolations, appendUserMessage, applyStatus, attachPlanMeta, blockCancelledDependents, buildChildPrompt, buildCancelMessage, buildClarifyMessage, createPlannerProgressReporter, buildDegradedMessage, buildPlanMessage, buildPlannerPrompt, buildResultMessage, buildStopSteerText, createStatuses, DEFAULT_REASONING_EFFORT, deliveryReadiness, derivePlanSnapshot, 
// [2.2.0][T4/O-3b] O-3b 消费接线：缺省协商上限由预估派生（plan.ts 纯函数，T3 已定稿）。
deriveSubtaskTimeoutMs, extractJson, flattenSubtasks, isRecord, isSocialMessage, isTerminalPhase, isStatusQuestion, isVagueContinuation, makeUserMessage, markDependentsBlocked, messageText, readySubtasks, MAX_PLAN_RESUMES, PRESENT_DENY_CODES, canResumePlan, resetBlockedStatuses, parseCancelMessage, parseResultMessage, parseWorkplanMessage, planPhase, reconcilePhase, REASONING_EFFORTS, truncate, validatePlan, applyResultStatuses, adjudicateResult, activeDenyCode, MAX_CONVERSATION_CHARS, MAX_ESCALATION_OPTIONS, MAX_INSTRUCTION_CHARS, MAX_QUESTION_CHARS, parseUpdateMessage, buildUpdateMessage, normaliseHandoffs, needEntryText, openHandoffs, DEPARTMENTS, DEPARTMENT_IDS, MAX_HANDOFF_RESPONSE_CHARS, findSubtask, } from './plan.js';
import { auditClarifyNeed, compactUnderstandingAudit, validatePlanContext } from './understanding.js';
import { phaseGateFromErrors, phaseSummaryLine, validatePhaseEvidence } from './three-phase.js';
import { lessonStats, rankLessons, readLessons, recordLesson, renderLessonsBrief, resolveLessonsFile, } from './lessons.js';
import { computeMappingDigest, verifyMappingDigest } from './supersede-digest.js';
import { supersedePlanRecord } from './supersede.js';
import { createProgressWatchdog, describeError } from './watchdog.js';
import { AUTO_RESUME_DEFAULTS, autoResumeAttemptCap, decideAutoResume, liveResumeCounts } from './auto-resume.js';
import { applyReplanStatuses, buildChangeRequestMessage, buildReplanMessage, parseChangeRequestMessage, parseReplanMessage, planReplan, } from './replan.js';
/**
 * [1.8.18] How many subtasks the plan *defines*.
 *
 * `deliveryReadiness` counts the derived statuses, and `ready` requires
 * `total > 0`, so a plan with `stages: []` can never be ready. Such a plan is
 * not a delivery object at all: normal planning rejects it (`validatePlan`),
 * and it can only reach replay from a malformed historical message. Judging it
 * as "0/0 unfinished forever" was U6 (T5 P13): present was refused with the
 * false copy "0 个子任务虽都已 done".
 *
 * A malformed plan that reaches this function still counts as deliverable
 * (`MAX_SAFE_INTEGER`); plans failing reconstruction earlier are dropped by
 * `sessionPlanRecords` — a known fail-open boundary (T5 A9), not closed here.
 */
function expectedAcceptanceOf(plan) {
    const out = {};
    for (const entry of flattenSubtasks(plan)) {
        const id = String(entry?.subtask?.id ?? '');
        if (!id)
            continue;
        out[id] = Array.isArray(entry.subtask.acceptance) ? entry.subtask.acceptance : [];
    }
    return out;
}
function definedSubtaskCount(plan) {
    try {
        /*
         * [1.11.0] 被重规划替换/撤销的旧行不占分母。
         *
         * 契约 §7.2 硬规则 2：`cancel` 掉的工作如果仍然计入定义条数，计划就永远
         * 差一项、永远无法交付。标记由 `replan.ts` 写在计划定义上（supersededAt），
         * 与状态条目的 `closure:'replanned'` 是同一次写入的两个镜像。
         */
        return flattenSubtasks(plan).filter((entry) => !entry.subtask?.supersededAt).length;
    }
    catch {
        return Number.MAX_SAFE_INTEGER;
    }
}
/**
 * [1.11.0] 可调度/可计数的状态行：排除已被重规划替换或撤销的旧行。
 *
 * `closure` 仍是唯一标记。这里不复制状态的其它字段，只做视图过滤，因此
 * 左侧栏、调度器、交付门禁读到的仍是同一个 `record.statuses` 数组。
 */
function liveStatuses(statuses) {
    return Array.isArray(statuses)
        ? statuses.filter((item) => item?.closure !== 'replanned')
        : [];
}
/**
 * [1.11.0] C-17：交付门禁的唯一读取助手——左侧栏、present、收尾闸门、dispatch
 * 返回体都从这里拿 `deliveryReady`，不再各自决定“要不要把记录级事实算进去”。
 *
 * `changeRequest.pending`（执行中收到、尚未重规划的变更）与 `reportPending`
 * （完成结果还没写进会话）只存在于 `record` 而不是 `statuses`，所以必须在
 * 这一层显式传入；`plan.ts` 的 `deliveryReadiness` 因此仍是纯函数。
 */
function readinessOf(record, snapshot) {
    const snap = snapshot ?? derivePlanSnapshot(record?.plan ? blockCancelledDependents(record.plan, record?.statuses) : record?.statuses, record?.plan ? definedSubtaskCount(record.plan) : undefined);
    return deliveryReadiness(snap, {
        phase: record?.phase,
        changePending: record?.changeRequest?.status === 'pending',
        reportPending: record?.reportPending === true,
        /*
         * 计划定义的验收标准是交付门的另一半：状态行只回答「子 Agent 说通过
         * 了几条」，这里回答「计划要求的几条有没有被逐条回应」。
         */
        expectedAcceptance: record?.plan ? expectedAcceptanceOf(record.plan) : undefined,
    });
}
export const PLANNER_TIMEOUT_MS = 300000;
/**
 * 无进展窗口（默认 300s，DSH_WORKPLAN_PLANNER_TIMEOUT_MS，毫秒 >0）。
 *
 * 2.1.6 起它的含义从「固定墙钟」改成「**没有新内容**的时长」：从上一个
 * chunk 起算，首个 chunk 之前也按它计时。模型一直在正常输出时窗口不断
 * 重置，慢而稳定的长任务不再被误杀。
 *
 * 历史：2.1.1 把 120s 提到 300s 只是推迟超时；2.1.3 把常量改成可配置，
 * 默认值仍是 300s 的固定墙钟。于是 2026-11-07 10:05:19 → 10:10:19（实测
 * 300.06s）规划器仍在工作却被 abort，自动分解直接降级——提高默认值或开放
 * 配置都没有解决「按墙钟掐断一个正在产出的调用」这个结构问题。
 */
export const PLANNER_IDLE_TIMEOUT_MS = 90000;
/**
 * 首个 chunk 之后的「完全静默」窗口（默认 90s，DSH_WORKPLAN_PLANNER_IDLE_
 * TIMEOUT_MS，毫秒 >0）：文本、推理、usage 一个 chunk 都没有这么久，判定为
 * 连接卡死而不是模型还在思考。这个常量在 2.1.6 之前只声明、从未接线（死
 * 代码），现在真正参与计时；设为不小于无进展窗口即等价于关闭。
 */
export const PLANNER_HARD_MULTIPLIER = 3;
/**
 * 绝对上限 = 无进展窗口 × 该倍数（默认 900s）。慢可以，慢到没边不行：它给
 * 单次规划器尝试一个终点，保证规划失败永远是「有限时间后给出可执行建议」，
 * 而不是无限占用本轮预算。
 */
/**
 * [2.2.0][T13b/推理等级] 规划器默认推理档 = max（用户 2026-11-08 决策 5）。
 *
 * 用户规则（AGENTS.md 第 12 条）只说过「子 Agent 不得继承主 Agent 的等级」，
 * 规划器同样是主 Agent 派出的子调用：任务里明确授权「规划器停止继承」。规划
 * 本身属于「跨多个系统梳理根因并给出方案」——按同一条三档规则属非常复杂 →
 * max。`DSH_WORKPLAN_PLANNER_REASONING_EFFORT` 仍可显式覆盖（用户为降本/提速
 * 主动选择低档时有效），未设或非法时才用本默认值；**绝不读取
 * modelSelection.reasoningEffort**。旧行为（plannerEffort || 主 Agent 档位）会
 * 让主 Agent 的 low/high 直接决定拆解质量，与「子 Agent 自决档位」同源、同错。
 */
export const DEFAULT_PLANNER_REASONING_EFFORT = 'max';
/**
 * Absolute ceiling for one child execution.
 *
 * 300 000 ms used to be the *only* limit, and because it was purely a wall
 * clock it killed healthy work: a child that needed one more minute was
 * recorded as blocked, `markDependentsBlocked` blocked every dependent, and the
 * plan became terminal at the first slow subtask. The ceiling is now a
 * settlement guarantee, while the no-progress window below is what normally
 * ends an attempt.
 *
 * [2.2.0][T4/O-3b] 语义更新（柔性时长协商，方案 §1③/§2.2）：这不是固定交付
 * 期限，而是「协商上限＋L4 安全兜底」——单次执行时限协商而来（subtask.timeoutMs
 * 显式值优先，缺省 deriveSubtaskTimeoutMs(estimateMinutes)＝clamp(预估分钟×
 * 2.0×60000, MIN, MAX)），本常量只在无预估、无显式值时兜底（③C2 零回归）。
 * 时间是协商出来的安全兜底，不是固定交付期限：到点走 L4 安全兜底结算＋
 * 「待裁决」标记（延期 / 重试 / 接受），不表述为「强制结束」式固定期限误杀。
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
/*
 * [2.2.0][T4/O-3b] 单次绝对上限 1800000 → 7200000（120 分钟）：用户 2026-11-07
 * 决断（方案 §6 未知第 4 条）。协商上限 = clamp(预估分钟 × 2.0, 全局下限,
 * 单次绝对上限)（方案 §1③），2h 让「预告 60 分钟的子任务，其单次执行上限
 * ≥ 60 分钟」（方案 C1）成立；tests/time-estimate-negotiation.test.ts 的
 * expected 公式直接引用本常量，数值不同步会红灯。
 */
export const MAX_CHILD_TIMEOUT_MS = 7200000;
export const MIN_CHILD_IDLE_MS = 1000;
export const MAX_CHILD_IDLE_MS = 900000;
export const CHILD_POLL_MS = 2000;
/*
 * [1.11.0] 派发回执的两个窗口（T4 B1/B2）。
 *
 * `assigned` 只是「已交给子会话」，不等于「子会话已经动了」。收不到回执时
 * 静默等到空闲窗口（默认 300s）会把「根本没启动」和「在慢慢想」混为一谈：
 * 90s 先标记 ackOverdue 让看板可见，180s 仍无任何新事件就按 no-ack 收束，
 * 不再无限等待。
 */
export const ASSIGN_ACK_NOTICE_MS = 90000;
export const ASSIGN_ACK_DEADLINE_MS = 180000;
/*
 * [1.11.0] 指示回执的两个窗口（T4 B5）。
 *
 * `instructed` 只表示「指示已经写进状态行并投递」，不表示子 Agent 已经照做。
 * 60s 没有新事件先标 `instructionOverdue`（看板可见、主 Agent 可催），
 * 180s 仍无增长就按 no-ack 收束，避免「指示已下、那边根本没跑」无限挂起。
 */
export const INSTRUCTION_ACK_NOTICE_MS = 60000;
export const INSTRUCTION_ACK_DEADLINE_MS = 180000;
/*
 * 正向回执的观察频率。5s 足以在 60s 提醒前发现「子会话已在动」，同时把
 * 会话读取次数控制在可接受范围（每个等指示的行每 5s 一次只读查询）。
 */
export const INSTRUCTION_POLL_MS = 5000;
// [2.2.5][RoundBudget] 轮次总预算默认关闭。
//
// 用户要求：对子任务的执行时间不做强制限制，只通过开工预告/预估/协商/延期
// 与到点预警来治理；旧版默认 20 分钟会在子任务自己的 30 分钟协商截止前
// 先切断整轮，界面上出现“本轮预算用尽”，与上述目标矛盾。
//
// 现在：
//   - TOTAL_TIMEOUT_MS = 0 表示默认不设整轮硬预算；
//   - 显式传正数（配置/DSH_WORKPLAN_TOTAL_TIMEOUT_MS）仍可启用安全兜底；
//   - 子任务自己的 timeoutMs/deadlineAt/extendMs 不受影响。
// dispatchPlan 用 20 天哨兵值避免 Infinity 参与计时器/差值计算。
//
// [2.2.5][热修] 哨兵值不能超过 Node setTimeout 的上限：延时 > 2^31-1 毫秒
// （约 24.8 天）会被 Node 强制改成 1 毫秒并告警（TimeoutOverflowWarning）。
// 最初版本用 10 年，结果整轮定时器派发后 1ms 就触发，所有子任务瞬间被
// 「总执行超时」杀死（2026-11-08 17:36 / 18:01 两次现场实锤，38ms 与 8ms）。
// 20 天 = 1,728,000,000ms < 2^31-1，安全；且对单轮执行而言等价于“无预算”。
export const TOTAL_TIMEOUT_MS = 0;
export const NO_ROUND_BUDGET_MS = 20 * 24 * 60 * 60 * 1000;
export const ROUND_TIMER_MAX_MS = 2_000_000_000;
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
/**
 * [2.0.3] `source.kind === 'goal'` 的轮次也是用户的真实任务。
 *
 * 官方 DeepSeek Harness 的 `/goal <objective>` 命令不会产生 `user/message`：
 * 目标文本由 goal-round-driver 以 `source.kind = 'goal'`、`round >= 1` 的
 * 用户消息送达（见 `@deepseek-ai/dsh-goal-round-driver` 的
 * `renderGoalRoundPrompt` / `createUserMessage`）。旧版 `humanMessages()` 只认
 * `source.kind` 为 `user` 或省略的消息，于是 `/goal` 任务在整条 goal 生命周期
 * 内都拿不到任务文本，`maybePlan()` 永远不会触发自动分解。
 *
 * 这里只认每个 goal 的第一轮（`round === 1`），并且只在该会话没有进行中的
 * 计划时放行：
 *  - `round === 1` 是目标进入本会话的唯一入口，后续轮次是同一目标的续跑，
 *    不能重复建计划；
 *  - 已存在进行中/未派发计划时返回 undefined，避免 goal 轮次与人工计划互相
 *    取消或误记成「执行中新增需求」。
 *
 * 任务文本优先取 goal 领域服务的结构化 objective（干净文本），取不到时再从
 * `<goal_round>` 信封里解析 JSON objective，最后才退回整条消息文本。
 */
export function goalRoundPlanningTask(ctx, payload, existing) {
    if (planRecordIsLive(existing))
        return undefined;
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    for (const message of messages) {
        if (!message || message.role !== 'user')
            continue;
        const source = message.source ?? {};
        if (source.kind !== 'goal')
            continue;
        if (Number(source.round) !== 1)
            continue;
        const raw = messageText(message).trim();
        const text = goalObjectiveOf(ctx, payload.agent) || goalObjectiveFromText(raw) || raw;
        if (!text)
            continue;
        return { text: truncate(text, 16000), goalId: String(source.goalId ?? ''), round: 1 };
    }
    return undefined;
}
/**
 * Whether an existing plan record still owns work in this session.
 *
 * `isTerminalPhase()` 只覆盖 cancelled/superseded（present 门禁的语义）；
 * 对 goal 轮次的入口判定，done/ended/degraded/clarify 同样是「这一轮可以
 * 开始新计划」的历史记录，不能把 `/goal` 任务永久挡在自动分解之外。
 */
function planRecordIsLive(existing) {
    if (!existing?.plan)
        return false;
    const phase = String(existing.phase ?? '');
    return !['done', 'ended', 'cancelled', 'superseded', 'clarify', 'degraded'].includes(phase);
}
/** Read the structured objective of the current goal view, when the service exists. */
function goalObjectiveOf(ctx, agent) {
    try {
        const view = ctx?.get?.('goals')?.get?.(agent);
        return typeof view?.objective === 'string' ? view.objective.trim() : '';
    }
    catch {
        return '';
    }
}
/** Parse `Objective: "<json string>"` out of the official `<goal_round>` envelope. */
export function goalObjectiveFromText(text) {
    const match = /<goal_round>[\s\S]*?Objective:\s*("(?:[^"\\]|\\.)*")/.exec(String(text ?? ''));
    if (!match)
        return '';
    try {
        const value = JSON.parse(match[1]);
        return typeof value === 'string' ? value.trim() : '';
    }
    catch {
        return '';
    }
}
/*
 * Children start with zero parent context. Without recent turns they cannot
 * resolve "B", "it", "the previous item", so they search blindly and time out.
 * Build a bounded plain-text window from the session log (newest last) and pass
 * it to both the planner and every child. Plugin-generated plan/result rows are
 * excluded to avoid feeding the plan back into itself.
 */
function recentConversation(session, maxChars = MAX_CONVERSATION_CHARS) {
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
async function collectStream(stream, onChunk, sink) {
    let text = '';
    let textDeltaSeen = false;
    let finished = false;
    let finishKind = null;
    for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object')
            continue;
        /*
         * [2.1.6] 任何 chunk 都是「连接还活着」的证据——包括 reasoning-delta、
         * block-start、usage 这些不进正文的类型。计时器只认这里，才不会把正在
         * 推理的模型当成卡死。
         */
        onChunk?.();
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text;
            /*
             * [2.1.7] 正文必须边流边落进 sink：定时器中止时 for-await 会直接抛错，
             * 局部变量 text 连同 900 秒的产出一起蒸发，旧实现正是这样把「差一个
             * 收尾 } 的完整计划」整体扔掉的。
             */
            if (sink)
                sink.text = text;
            textDeltaSeen = true;
        }
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !textDeltaSeen) {
            text += chunk.block.text ?? '';
            if (sink)
                sink.text = text;
        }
        else if (chunk.type === 'finish') {
            finished = true;
            finishKind = chunk.reason?.kind ?? 'unknown';
            if (finishKind === 'error' || finishKind === 'aborted') {
                const failure = chunk.reason?.failure;
                /*
                 * [2.2.5][T4] 底层原因透传（T3 根因 P2）：failure.message 只是包装文案
                 * （如 "Connection error."），真因可能挂在 failure.cause 上（宿主透传后
                 * 自动生效，未透传时保持原文、行为不变）。failure.code 记入 details，
                 * 供重试分级（P1）判定，不再从文案反解。
                 */
                const causeText = failure?.cause ? errorCauseChain(failure.cause) : '';
                const failureCode = failure?.code != null ? String(failure.code) : '';
                throw new PlanError(`模型调用结束：${finishKind}${failureCode ? ` ${failureCode}` : ''}${failure?.message ? `：${failure.message}` : ''}${causeText ? `（底层原因：${causeText}）` : ''}`, finishKind === 'aborted' ? 'ABORTED' : 'PLANNER_LLM_ERROR', failureCode);
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
/**
 * [1.12.0] Rollback switch for the context guard.
 *
 * `DSH_WORKPLAN_CONTEXT_GUARD=off` keeps the 1.11.1 behaviour (audit still runs
 * and is attached for inspection, but no deviation can block a plan). This is a
 * runtime switch rather than a code revert so a bad release can be defused
 * without rebuilding, while the reason stays visible in the plan message.
 */
function contextGuardStrict() {
    const flag = String(process.env.DSH_WORKPLAN_CONTEXT_GUARD ?? '').trim().toLowerCase();
    return flag !== 'off' && flag !== '0' && flag !== 'false';
}
/** 规划器窗口取值：只接受有限正数，否则回落默认值（0/负数/NaN 都不许把计时器打成 1ms）。 */
export function normalisePlannerWindow(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}
function plannerDebugEnabled() {
    const flag = String(process.env.DSH_WORKPLAN_DEBUG ?? '').trim().toLowerCase();
    return flag !== '' && flag !== '0' && flag !== 'false' && flag !== 'off';
}
/**
 * 把规划器遥测压成一行能直接给用户看的现场说明（降级消息的 detail）。
 * 没有遥测时返回空串，调用方据此跳过，不制造「0 次尝试」之类的假事实。
 */
export function plannerTelemetryLine(telemetry) {
    if (!telemetry || typeof telemetry !== 'object' || !telemetry.attempt)
        return '';
    const parts = [
        telemetry.model ? `模型 ${telemetry.model}` : '',
        Number(telemetry.elapsedMs) > 0 ? `耗时 ${(Number(telemetry.elapsedMs) / 1000).toFixed(1)}s` : '',
        Number(telemetry.chunks) > 0 ? `收到 ${Number(telemetry.chunks)} 个输出块` : '未收到任何输出块',
        Number(telemetry.promptChars) > 0 ? `提示词 ${Number(telemetry.promptChars)} 字` : '',
        Number(telemetry.textChars) > 0 ? `输出 ${Number(telemetry.textChars)} 字` : '',
        telemetry.outcome && telemetry.outcome !== 'ok' ? `判定 ${telemetry.outcome}` : '',
    ].filter(Boolean);
    return `现场：${parts.join('｜')}`;
}
const PLANNER_ABORT_CODES = ['PLANNER_TIMEOUT', 'PLANNER_IDLE', 'PLANNER_TIMEOUT_HARD'];
/*
 * [2.2.5][T4] 规划器重试分级与退避（T3 根因 P1：规划器链路全层零重试零退避，
 * 一次 ~1s 网络连接尖峰 × 0ms 间隔 = 1.2 秒内两连败直接降级）。
 *  - PLANNER_RETRYABLE_LLM_CODES：宿主 classifyPiAiError 的可自愈失败类
 *    （偶发传输错误 / 超时 / 服务端 5xx / 限流 429），重试前做指数退避；
 *  - 其余失败类（AUTH / INVALID_REQUEST / 配额 / 上下文溢出 / PI_AI_ERROR /
 *    ABORTED）重试不会自愈，立即终止，不再烧下一次调用；
 *  - 退避 500ms → 1s（±20% 抖动），期间 signal 一旦取消立即让路，绝不悬挂。
 */
const PLANNER_RETRYABLE_LLM_CODES = ['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT'];
const PLANNER_MAX_ATTEMPTS = 3;
const PLANNER_RETRY_BACKOFF_BASE_MS = 500;
/**
 * [2.2.5][T4] 把 Error 的 cause 链展开成一行可读文本（T3 根因 P2 的插件侧落点）。
 *
 * 真实失败原因（ENOTFOUND / ECONNREFUSED / TLS alert 等）挂在 Error.cause 链上，
 * 外层 message 往往只有包装文案（"fetch failed"、"Connection error."）。
 * 展开规则与宿主 dsh-llm 的 errorChain 一致：外层在前，每层 cause 以 ": " 追加，
 * 重复文案只记一次；深度封顶 5 层防环。无 cause 时返回与 error.message 相同的
 * 文本，不改变既有行为。
 */
function errorCauseChain(value) {
    const parts = [];
    let current = value;
    for (let depth = 0; depth < 5 && current != null; depth += 1) {
        const text = typeof current.message === 'string' && current.message !== ''
            ? current.message
            : (typeof current.name === 'string' && current.name !== '' ? current.name : String(current));
        if (!parts.includes(text))
            parts.push(text);
        current = current.cause;
    }
    return parts.join(': ');
}
/**
 * [2.2.5][T4] 可被 signal 打断的退避等待：取消一到，Promise 立即 resolve，
 * 调用方随后检查 signal.aborted 抛 ABORTED——真取消路径不吃退避延迟。
 */
function sleepAbortable(signal, ms) {
    return new Promise((resolve) => {
        let timer = null;
        const finish = () => {
            if (timer !== null)
                clearTimeout(timer);
            timer = null;
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        };
        const onAbort = () => finish();
        if (signal?.aborted) {
            resolve();
            return;
        }
        timer = setTimeout(finish, ms);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}
/**
 * [2.1.7] 定时器中止后的正文抢救。
 *
 * 事故里模型流式输出了 900 秒、11694 个块，却因为没等到 finish 信号被整体
 * 丢弃——局部变量 text 连同它一起消失。只要正文末尾已闭合（`}`），就按与正常
 * 路径完全一致的三道闸（extractJson → validatePlan → validatePlanContext）
 * 重新验收；任何一道不过返回 null，照旧报超时。
 *
 * 只认「末尾已闭合」：被拦腰截断的 JSON 即使补上括号也可能丢掉尾部阶段，
 * 静默交出残缺计划比降级更危险。
 */
function salvagePartialPlan(text, guardOptions) {
    if (typeof text !== 'string')
        return null;
    const trimmed = text.trimEnd();
    if (!trimmed.endsWith('}'))
        return null;
    try {
        const raw = extractJson(trimmed);
        const validated = validatePlan(raw);
        if (!validated.ok)
            return null;
        const guard = validatePlanContext(validated.plan, guardOptions);
        if (!guard.ok)
            return null;
        const plan = validated.plan;
        plan.taskAnchor = guard.audit.anchor;
        plan.understandingAudit = compactUnderstandingAudit(guard.audit);
        return plan;
    }
    catch {
        return null;
    }
}
/**
 * [2.1.6] 单次规划器尝试的计时策略——判据是「有没有在产出」，不是「过了多久」。
 *
 * 三扇窗：
 *  1. 无进展窗口（plannerTimeoutMs，默认 300s）：自上一个 chunk 起算，首个
 *     chunk 之前同样适用。模型持续产出 ⇒ 窗口不断后移，慢而稳定的长任务不再
 *     被固定墙钟掐断；
 *  2. 静默窗口（plannerIdleTimeoutMs，默认 90s）：首个 chunk 之后完全静默，
 *     判定为卡死而非还在思考；不小于无进展窗口时等于关闭；
 *  3. 绝对上限（无进展窗口 × PLANNER_HARD_MULTIPLIER，默认 900s）：有无产出
 *     都到此为止，规划失败因此永远是「有限时间 + 可执行建议」。
 *
 * 每次中止都携带真实旋钮（DSH_WORKPLAN_PLANNER_TIMEOUT_MS /
 * DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS），而不是让用户去改源码常量。
 */
export async function runPlanner(ctx, options) {
    const { taskText, cwd, sessionId, modelSelection, signal, conversationContext = '', budget = {}, sourceMessageIds = [], telemetry, onProgress, } = options;
    const timeoutMs = normalisePlannerWindow(options.plannerTimeoutMs, PLANNER_TIMEOUT_MS);
    const idleMs = normalisePlannerWindow(options.plannerIdleTimeoutMs, PLANNER_IDLE_TIMEOUT_MS);
    const hardMs = timeoutMs * PLANNER_HARD_MULTIPLIER;
    /*
     * [2.1.7] 两个可选旋钮：
     *  - DSH_WORKPLAN_PLANNER_MAX_TOKENS：给单次生成封顶。无界生成是「流满 900 秒
     *    撞绝对上限」的放大器——封顶后模型会正常 finish，截断可被抢救/回喂；
     *  - DSH_WORKPLAN_PLANNER_REASONING_EFFORT：规划专用推理档，只接受
     *    low / high / max 三档。非法值不传给模型，回落默认档（见下）。
     *
     * [2.2.0][T13b] 用户 2026-11-08 决策 5「规划器停止继承」：未设该旋钮时，规划器
     * 不再沿用主 Agent 的推理档，而是取 DEFAULT_PLANNER_REASONING_EFFORT（max）。
     * 校验白名单复用 plan.ts 的 REASONING_EFFORTS：把 "ultra"/"medium" 这类非法值
     * 原样发给模型，真实宿主会以 400 拒绝整次规划——环境变量写错不应该让整个
     * 任务降级，所以非法值按「未设置」处理。
     */
    const plannerMaxTokens = normalisePlannerWindow(process.env.DSH_WORKPLAN_PLANNER_MAX_TOKENS, 0);
    // 大小写归一："LOW" 这类写法若因大小写被当成非法值回落 max，会静默抬高
    // 用户的成本预期，所以先归一化再进白名单。
    const plannerEffortRaw = String(process.env.DSH_WORKPLAN_PLANNER_REASONING_EFFORT ?? '').trim().toLowerCase();
    const plannerEffort = REASONING_EFFORTS.includes(plannerEffortRaw) ? plannerEffortRaw : '';
    const effectivePlannerEffort = plannerEffort || DEFAULT_PLANNER_REASONING_EFFORT;
    const secs = (ms) => Math.max(1, Math.round(ms / 1000));
    let lastErrors = [];
    /*
     * [2.1.6.1] 每次尝试的失败原因必须都留档：旧实现每轮 `lastErrors = ...` 整体
     * 覆盖，最终报错里只剩最后一次，第一次为什么失败永远丢失——事后只能靠猜。
     * [2.2.5][T4] 尝试次数由 2 提到 3（PLANNER_MAX_ATTEMPTS），可重试类失败
     * （传输/超时/服务端/限流）在两次尝试之间做指数退避，吸收偶发网络抖动。
     */
    const attemptReports = [];
    let lastText = '';
    for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt += 1) {
        if (signal.aborted)
            throw abortError();
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason ?? abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        const startedAt = Date.now();
        let sawChunk = false;
        let lastChunkAt = startedAt;
        let chunks = 0;
        let promptChars = 0;
        let outcome = 'ok';
        /*
         * [2.1.7] 流式正文的落点：collectStream 边流边写，abort/缺 finish 时也
         * 能留下全文，供抢救（salvagePartialPlan）与遥测复盘使用。
         */
        const sink = { text: '' };
        let progressTimer = null;
        const clearProgress = () => {
            if (progressTimer) {
                clearTimeout(progressTimer);
                progressTimer = null;
            }
        };
        const idleActive = () => sawChunk && idleMs < timeoutMs;
        const windowMs = () => (idleActive() ? idleMs : timeoutMs);
        const stallError = () => (idleActive()
            ? new PlanError(`规划器停滞：输出开始后 ${secs(idleMs)} 秒没有任何新内容，判定为卡死（不是还在思考）。可用 DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS 调整，设为不小于 ${secs(timeoutMs)} 秒即关闭`, 'PLANNER_IDLE')
            : new PlanError(`规划器超时：${secs(timeoutMs)} 秒内没有取得任何进展（任务过长或模型过慢）。请设置 DSH_WORKPLAN_PLANNER_TIMEOUT_MS（毫秒）放宽单次调用上限，或缩短任务文本`, 'PLANNER_TIMEOUT'));
        const checkProgress = () => {
            progressTimer = null;
            // 到点时若其实还有进展（窗口刚被收紧或时钟抖动），按剩余时间重新武装。
            if (Date.now() - lastChunkAt < windowMs()) {
                scheduleCheck();
                return;
            }
            controller.abort(stallError());
        };
        const scheduleCheck = () => {
            clearProgress();
            const remaining = Math.max(1, windowMs() - (Date.now() - lastChunkAt));
            progressTimer = setTimeout(checkProgress, remaining);
        };
        const hardTimer = setTimeout(() => {
            controller.abort(new PlanError(`规划器超出绝对上限：${secs(hardMs)} 秒（= DSH_WORKPLAN_PLANNER_TIMEOUT_MS 的 ${PLANNER_HARD_MULTIPLIER} 倍）。请缩短任务文本，或提高 DSH_WORKPLAN_PLANNER_TIMEOUT_MS`, 'PLANNER_TIMEOUT_HARD'));
        }, hardMs);
        const onChunk = () => {
            chunks += 1;
            lastChunkAt = Date.now();
            // 首个 chunk 到达时窗口可能由 300s 收紧为 90s，必须立刻按新窗口重排。
            if (!sawChunk) {
                sawChunk = true;
                scheduleCheck();
            }
        };
        scheduleCheck();
        /*
         * [2.2.5][T4] 本轮重试判定（catch 内赋值，finally 遥测之后执行）：
         *  - terminalFailure：不可自愈的 LLM 失败类，本轮结束后立即跳出循环；
         *  - retryBackoffMs：可重试类失败的重试前退避毫秒数（0 = 不退避）。
         */
        let terminalFailure = false;
        let retryBackoffMs = 0;
        try {
            let prompt = buildPlannerPrompt(taskText, cwd, conversationContext, budget);
            promptChars = prompt.length;
            if (lastErrors.length > 0) {
                prompt += [
                    '',
                    '上一次输出未通过校验，请修复以下问题后重新输出完整 JSON：',
                    ...lastErrors.slice(0, 12).map((error) => `- ${error}`),
                ].join('\n');
            }
            /*
             * [2.2.0][T13b/推理等级] 规划器停止继承主 Agent 的档位（用户 2026-11-08
             * 决策 5，选项 A）：显式传 effectivePlannerEffort（旋钮合法值，否则 max）。
             *
             * 旧代码 `plannerEffort || modelSelection.reasoningEffort` 的第二个操作数是
             * 主 Agent 的档位，等于让主 Agent 决定规划器：主 Agent 用 low 省成本时，
             * 拆解也降档，复杂任务被拆得更浅，后续部门再努力也补不回来。现在没有任何
             * 路径读 modelSelection.reasoningEffort 作为规划档位。
             */
            const stream = ctx.llm.stream({
                provider: modelSelection.provider,
                model: modelSelection.model,
                reasoningEffort: effectivePlannerEffort,
                ...(plannerMaxTokens > 0 ? { maxTokens: plannerMaxTokens } : {}),
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                signal: controller.signal,
                sessionId,
            });
            const text = await collectStream(stream, onChunk, sink);
            lastText = text;
            const raw = extractJson(text);
            const validated = validatePlan(raw);
            if (validated.ok) {
                /*
                 * [1.12.0] Structure alone is not understanding. Run the three-stage
                 * audit against the user's own words before the plan can be returned;
                 * a deviation becomes a retry error so the planner gets one chance to
                 * fix it, and a second failure degrades instead of dispatching.
                 */
                const guard = validatePlanContext(validated.plan, {
                    taskText,
                    conversationContext,
                    sourceMessageIds,
                    strict: contextGuardStrict(),
                });
                if (guard.ok) {
                    const plan = validated.plan;
                    plan.taskAnchor = guard.audit.anchor;
                    plan.understandingAudit = compactUnderstandingAudit(guard.audit);
                    return plan;
                }
                outcome = 'CONTEXT_GUARD';
                lastErrors = guard.errors.length > 0 ? guard.errors : guard.warnings;
                continue;
            }
            outcome = 'INVALID_PLAN';
            lastErrors = validated.errors ?? [];
        }
        catch (error) {
            /*
             * LLM 层会把 abort 掩码成泛化的 "DeepSeek Messages request aborted"，丢失
             * 真实原因。这里优先读我们自己写进 controller.signal.reason 的判定码，
             * 再区分「用户/宿主主动取消」，最后才当作可重试的偶发错误。
             */
            const reason = controller.signal.aborted ? controller.signal.reason : undefined;
            if (reason && PLANNER_ABORT_CODES.includes(String(reason.code))) {
                /*
                 * [2.1.7] 定时器中止 ≠ 产出作废。旧实现在此直接 throw，900 秒里流出来的
                 * 正文随局部变量一起蒸发（遥测 textChars=0 就是这么来的）。先尝试用
                 * 与正常路径一致的三道闸验收已产出的正文：能通过就照常返回计划；
                 * 通不过才按原判定中止，失败现场由 finally 的遥测留档。
                 */
                const salvaged = salvagePartialPlan(sink.text, {
                    taskText,
                    conversationContext,
                    sourceMessageIds,
                    strict: contextGuardStrict(),
                });
                if (salvaged && !signal.aborted) {
                    outcome = 'SALVAGED';
                    lastText = sink.text;
                    return salvaged;
                }
                outcome = String(reason.code);
                throw reason;
            }
            /*
             * [2.1.7] 同样地：模型写完了 JSON 却没送来 finish 信号（连接抖动、
             * 层序错乱）时，正文若已完整可用就不要整轮作废。
             */
            if (error instanceof PlanError && error.code === 'PLANNER_INCOMPLETE' && !signal.aborted) {
                const salvaged = salvagePartialPlan(sink.text, {
                    taskText,
                    conversationContext,
                    sourceMessageIds,
                    strict: contextGuardStrict(),
                });
                if (salvaged) {
                    outcome = 'SALVAGED';
                    lastText = sink.text;
                    return salvaged;
                }
            }
            if (signal.aborted || (controller.signal.aborted && reason?.code === 'ABORTED')) {
                outcome = 'ABORTED';
                throw abortError();
            }
            if (error instanceof PlanError && error.code === 'ABORTED') {
                outcome = 'ABORTED';
                throw error;
            }
            outcome = (error instanceof PlanError && error.code) || 'PLANNER_ERROR';
            /*
             * [2.2.5][T4] 失败原因整链透传（T3 根因 P2）：error.message 只是外层包装
             * （如 "fetch failed"），真因（ENOTFOUND / ECONNREFUSED / TLS alert）挂在
             * cause 链上。展开后写入 lastErrors → attemptReports → 最终降级文案，
             * 下次失败不再只看到一句 "TRANSPORT：Connection error"。
             */
            const message = error instanceof Error ? errorCauseChain(error) : String(error);
            lastErrors = [message];
            /*
             * [2.1.6.1] 只回一句「位置 6041」给模型毫无用处：它看不到自己断在哪。
             * 把断点附近的原文与「截断 / 写错」的判据一并回喂，第二次尝试才有靶子；
             * 同时把长度与尾部落进遥测，失败现场从此可复盘。
             */
            if (error instanceof PlanError && error.code === 'INVALID_JSON' && lastText) {
                const trimmed = lastText.trimEnd();
                const tail = trimmed.slice(-120);
                const closed = trimmed.endsWith('}');
                lastErrors = [
                    message,
                    `输出共 ${lastText.length} 字符，末尾原文：${JSON.stringify(tail)}`,
                    closed
                        ? '末尾已闭合 → 断点在正文中间，属语法写错（漏逗号/括号不匹配）'
                        : '末尾未闭合（没有结尾 }）→ 疑似输出被截断，请给出更紧凑的完整 JSON',
                ];
            }
            /*
             * [2.2.5][T4] 重试分级 + 退避（T3 根因 P1）：旧实现 catch 后零退避立即
             * 重试——一次 ~1s 网络连接尖峰 × 0ms 间隔 = 1.2 秒内两连败直接降级。
             * 现在：可重试类（TRANSPORT/TIMEOUT/SERVER/RATE_LIMIT）按 500ms→1s
             * 指数退避（±20% 抖动，可被 signal 打断）给抖动尾巴留出恢复窗口；
             * 其余 LLM 失败类（AUTH/INVALID_REQUEST/配额/上下文溢出等）重试不会
             * 自愈，置 terminal 标志本轮结束后立即跳出，不烧下一次调用。
             */
            const llmCode = error instanceof PlanError && error.code === 'PLANNER_LLM_ERROR'
                && typeof error.details === 'string'
                ? error.details
                : '';
            if (llmCode !== '' && !PLANNER_RETRYABLE_LLM_CODES.includes(llmCode)) {
                terminalFailure = true;
            }
            else if (attempt < PLANNER_MAX_ATTEMPTS && !signal.aborted) {
                retryBackoffMs = Math.round(PLANNER_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
            }
        }
        finally {
            clearProgress();
            clearTimeout(hardTimer);
            signal.removeEventListener('abort', onAbort);
            /*
             * [2.1.6] 规划器遥测：此前失败现场什么都不留，事后只能从会话 JSONL 反推
             * 「恰好 300.06 秒」。现在每次尝试都留下模型、提示词规模、产出块数、耗时
             * 与判定码，失败时随降级消息一起给到用户。
             */
            if (outcome !== 'ok' && lastErrors.length > 0) {
                attemptReports.push(`第 ${attempt} 次[${outcome}]：${lastErrors.join('；')}`);
                /*
                 * [2.2.5][T5] 分解期间进度透出（T1 P-6 / T3 §5）：每次失败尝试在遥测
                 * 留档之后向调用方回调一次（attempt / outcome / 真因链 / 退避毫秒 /
                 * 终态）。这里只是追加观察点——terminalFailure 与 retryBackoffMs 在
                 * catch 里已定值，本回调不读写循环控制变量，重试判定、退避与跳出
                 * 语义与旧实现逐字节一致。
                 */
                if (typeof onProgress === 'function') {
                    onProgress({
                        attempt,
                        outcome,
                        lastErrors: [...lastErrors],
                        retryBackoffMs,
                        terminal: terminalFailure,
                        aborted: signal.aborted,
                    });
                }
            }
            if (telemetry && typeof telemetry === 'object') {
                Object.assign(telemetry, {
                    // [2.1.7] 以 sink 为准：abort 时 lastText 恒为空，旧值让现场永远缺「输出 N 字」。
                    textChars: Math.max(lastText.length, sink.text.length),
                    provider: modelSelection.provider,
                    model: modelSelection.model,
                    // [2.2.0][T13b] 记录**实际发给模型**的档位：旧值记的是 modelSelection
                    // （主 Agent 档位），规划器停止继承后它不再等于生效值，照抄会让事后
                    // 复盘把「主 Agent=high」误读成「规划器=high」。
                    reasoningEffort: effectivePlannerEffort,
                    reasoningEffortSource: plannerEffort ? 'env' : 'default-max',
                    attempt,
                    taskChars: typeof taskText === 'string' ? taskText.length : 0,
                    promptChars,
                    chunks,
                    elapsedMs: Date.now() - startedAt,
                    outcome,
                    at: Date.now(),
                });
                if (plannerDebugEnabled()) {
                    console.warn('[dsh-workplan] planner attempt', JSON.stringify({ ...telemetry }));
                }
            }
        }
        /*
         * [2.2.5][T4] 退避在 finally（遥测计时）之后执行，不污染单次尝试的
         * elapsedMs；不可自愈失败在此直接跳出，最终报错仍走统一的聚合文案。
         * 校验类重试（CONTEXT_GUARD/INVALID_PLAN 的 continue）不经过这里，
         * 保持原有的零退避快重试。
         */
        if (terminalFailure)
            break;
        if (retryBackoffMs > 0) {
            await sleepAbortable(signal, retryBackoffMs);
            if (signal.aborted)
                throw abortError();
        }
    }
    const deviation = lastErrors.some((error) => /^(?:DEVIATION|CLARIFY|CONTEXT):/.test(String(error)));
    throw new PlanError(`规划器 ${attemptReports.length > 0 ? `全部 ${attemptReports.length} 次尝试` : '输出'}均未通过校验：${(attemptReports.length > 0 ? attemptReports : lastErrors).slice(0, 6).join(' ｜ ')}`, deviation ? 'DEVIATION' : 'PLANNER_FAILED', lastErrors);
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
                ...(record.errors ?? []),
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
    record.statuses = applyStatus(record.statuses, subtaskId, { updatedBy: 'child', ...patch });
    record.updatedAt = Date.now();
    return true;
}
function recordSubtaskError(record, subtaskId, message, guard) {
    if (guard.timedOut)
        return;
    record.errors = [...(record.errors ?? []), `${subtaskId}: ${truncate(message, 500)}`].slice(-20);
}
/**
 * Resolve one artifact reference against the round's working directory.
 *
 * Relative refs are what a child is asked to report, so they must be resolved
 * the same way for every check; an empty ref is never "present".
 */
function resolveArtifactPath(ref, cwd) {
    const text = typeof ref === 'string' ? ref.trim() : '';
    if (!text)
        return '';
    if (isAbsolute(text))
        return text;
    const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    return resolve(base, text);
}
/**
 * [1.7.0] Check the files a child declared.
 *
 * Only `kind:'file'` is verifiable here. A url or a note is taken at face
 * value; pretending to verify them would be worse than not checking at all.
 * The verdict is recorded rather than enforced: a missing file makes the
 * dependency gate fail, but it does not silently rewrite "done" to "blocked".
 */
export function checkArtifacts(artifacts, cwd, artifactExists = existsSync) {
    const list = Array.isArray(artifacts) ? artifacts : [];
    const missingArtifacts = [];
    const checked = list.map((item) => {
        if (!isRecord(item) || item.kind !== 'file')
            return item;
        const target = resolveArtifactPath(item.ref, cwd);
        let exists = false;
        try {
            exists = target ? artifactExists(target) === true : false;
        }
        catch {
            exists = false;
        }
        if (!exists)
            missingArtifacts.push(String(item.ref));
        return { ...item, exists };
    });
    return { artifacts: checked, missingArtifacts };
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
export function probeInterruptedArtifacts(output, subtask, cwd, artifactExists = existsSync) {
    const candidates = new Set();
    const collect = (text) => {
        if (typeof text !== 'string' || !text)
            return;
        // 文件名可能带中文（本次事故就是「T6_人性博弈推演_20261030.md」这种），
        // 所以字符集必须放行 CJK，否则真正的产物会被当成没写。
        for (const hit of text.matchAll(/[\w\u4e00-\u9fff@.\/-]+\.(?:md|csv|json|html|txt|ts|js|py|ya?ml)/g)) {
            const ref = hit[0].replace(/^\.\//, '');
            // 太短的多半是扩展名碎片（如 “.md”），不足以定位文件。
            if (ref.length > 3)
                candidates.add(ref);
        }
    };
    collect(output);
    for (const item of Array.isArray(subtask?.outputs) ? subtask.outputs : [])
        collect(item);
    const landed = [];
    for (const ref of candidates) {
        const target = resolveArtifactPath(ref, cwd);
        if (!target)
            continue;
        let exists = false;
        try {
            exists = artifactExists(target) === true;
        }
        catch {
            exists = false;
        }
        if (exists)
            landed.push(ref);
        if (landed.length >= 6)
            break;
    }
    return landed;
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
export function probeInterruptedEvidence(output, subtask, cwd, artifactExists = existsSync) {
    const landed = probeInterruptedArtifacts(output, subtask, cwd, artifactExists);
    const declared = [];
    for (const item of Array.isArray(subtask?.outputs) ? subtask.outputs : []) {
        for (const hit of String(item).matchAll(/[\w\u4e00-\u9fff@.\/-]+\.(?:md|csv|json|html|txt|ts|js|py|ya?ml)/g)) {
            const ref = hit[0].replace(/^\.\//, '');
            if (ref.length > 3 && !declared.includes(ref))
                declared.push(ref);
        }
    }
    const refs = [...new Set([...declared, ...landed])];
    const artifacts = refs.map((ref) => ({ kind: 'file', ref, exists: landed.includes(ref) }));
    const missingArtifacts = declared.filter((ref) => !landed.includes(ref));
    return { artifacts, missingArtifacts };
}
/**
 * [1.10.6] Fingerprint the files a timed-out attempt already wrote.
 *
 * T6 (G3) found that the retry decision never looked at the disk: a second
 * attempt could silently overwrite a deliverable the first attempt had already
 * produced, turning "the child stopped early" into "the deliverable was
 * rewritten". This snapshot (path + size + mtime) is the record the retry is
 * compared against.
 *
 * A missing file is not a conflict — it simply has no fingerprint. `stat` is
 * injectable so the check can be tested without touching the real filesystem.
 */
export function fingerprintArtifacts(refs, cwd, stat = statSync) {
    const list = Array.isArray(refs) ? refs : [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const ref = typeof item === 'string' ? item.trim() : '';
        if (!ref || seen.has(ref))
            continue;
        seen.add(ref);
        const target = resolveArtifactPath(ref, cwd);
        if (!target)
            continue;
        try {
            const info = stat(target);
            if (!info)
                continue;
            out.push({ ref, size: Number(info.size), mtimeMs: Number(info.mtimeMs) });
        }
        catch {
            // Missing or unreadable: nothing to protect, and not a conflict.
        }
    }
    return out;
}
/**
 * [1.10.6] Which landed artifacts changed since the snapshot was taken.
 *
 * Size or mtime differing is enough to call it a conflict: the file the first
 * attempt produced is no longer the file on disk, so a retry that rewrites it
 * would destroy work rather than finish it.
 */
export function diffArtifactFingerprints(before, after) {
    const previous = new Map();
    for (const item of Array.isArray(before) ? before : []) {
        if (item && typeof item.ref === 'string')
            previous.set(item.ref, item);
    }
    const conflicts = [];
    for (const item of Array.isArray(after) ? after : []) {
        if (!item || typeof item.ref !== 'string')
            continue;
        const recorded = previous.get(item.ref);
        if (!recorded)
            continue;
        if (recorded.size !== item.size || recorded.mtimeMs !== item.mtimeMs)
            conflicts.push(item.ref);
    }
    return conflicts;
}
/**
 * [1.8.19] Find a subtask definition by id, without assuming the plan is valid.
 */
export function findSubtaskById(plan, subtaskId) {
    for (const stage of Array.isArray(plan?.stages) ? plan.stages : []) {
        for (const subtask of Array.isArray(stage?.subtasks) ? stage.subtasks : []) {
            if (subtask?.id === subtaskId)
                return subtask;
        }
    }
    return null;
}
/**
 * [1.8.19] A hard per-subtask timeout must not erase what the child already wrote.
 *
 * Real incident (2026-10-31 23:23:38): T11/T12 were aborted by the 900 s
 * per-subtask ceiling four seconds after their deliverables had landed
 * (T11 32,996 B report + 140-row index; T12 51,547 B report). The parent only
 * saw `blocked / 达到执行上限`, with no hint that the files existed, so the same
 * work would be redone from scratch. This probe records the landed declared
 * outputs in the status row and in the error text — it does not change the
 * verdict (a timeout is still `blocked`), it only stops the evidence loss.
 */
export function timeoutBlockedPatch(subtask, cwd, message, artifactExists = existsSync) {
    const evidence = probeInterruptedEvidence(null, subtask, cwd, artifactExists);
    const landed = evidence.artifacts.filter((item) => item?.exists === true).map((item) => String(item.ref));
    const artifactNote = landed.length > 0
        ? `；该步声明的产物已在盘上：${landed.slice(0, 6).join('、')}（先核对，不要当作从未运行）`
        : '';
    return {
        patch: {
            status: 'blocked',
            closure: 'blocked',
            blockedKind: 'timeout',
            progress: 100,
            finishedAt: Date.now(),
            error: message + artifactNote,
            summary: truncate(`未完成：${message}${artifactNote}`, 3000),
            ...(evidence.artifacts.length > 0 ? { artifacts: evidence.artifacts } : {}),
            ...(evidence.missingArtifacts.length > 0 ? { missingArtifacts: evidence.missingArtifacts } : {}),
        },
        landed,
    };
}
/**
 * [1.8.19] The round budget reset used to erase every trace of the attempt.
 *
 * The 20-minute `TOTAL_TIMEOUT` branch resets unfinished rows to `pending`, and
 * `applyStatus` (by design) clears `childId / startedAt / finishedAt`. In the
 * 2026-10-31 incident T10 had run for ~19 minutes and had already written its
 * coverage report at 23:06:26 when the budget fired at 23:07:25; the card then
 * said "not started" and the user asked "why did T10 stop by itself". The
 * attempt provenance and any landed declared outputs now travel in the error
 * text, so the reset stays a pause but stops being an erasure.
 */
export function budgetResetError(item, subtask, cwd, artifactExists = existsSync) {
    const landed = probeInterruptedArtifacts(null, subtask, cwd, artifactExists);
    const parts = ['本轮预算用尽，等待续跑'];
    if (item?.childId)
        parts.push(`上一轮子会话 ${String(item.childId).slice(0, 8)}`);
    if (Number.isFinite(item?.startedAt) && Number.isFinite(item?.finishedAt)) {
        parts.push(`运行 ${Math.max(0, Math.round((Number(item.finishedAt) - Number(item.startedAt)) / 1000))}s`);
    }
    /*
     * [1.12.0][D-31] 预算重置不能把上一次的真实失败原因抹掉。
     *
     * 旧实现用「预算用尽」整段覆盖 `error`，原失败只留在 record.errors 的
     * 尾部切片里；模型读状态行时看不到「为什么上一轮没做完」，只会以为
     * 是时间不够。原值以只读摘要保留在前，重置原因仍然明确。
     */
    /*
     * 只保留「真实失败」原因：`本轮预算用尽` 与中止哨兵 `总执行超时` 都不是
     * 子任务的失败（后者会让 paused 计划看起来像集体超时，见 budget-pause
     * 用例的硬断言）。优先读 applyStatus 留档的 lastError，其次读当前值。
     */
    const isSentinel = (text) => /本轮预算用尽|总执行超时/.test(text);
    const previousFailure = [item?.lastError, item?.error]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find((value) => value !== '' && !isSentinel(value)) ?? '';
    if (previousFailure) {
        parts.push(`上一次尝试的失败原因：${truncate(previousFailure, 300)}`);
    }
    if (landed.length > 0)
        parts.push(`声明产物已在盘上：${landed.slice(0, 6).join('、')}`);
    return parts.join('；');
}
/**
 * Turn one child output into a status verdict.
 *
 * The decision lives in `adjudicateResult` (a pure function) so the runtime and
 * the session replay cannot disagree. This wrapper only adds the two things
 * that need the environment: the strict/legacy switch and the file check.
 */
function settleFromOutput(record, subtask, output, guard, options) {
    /*
     * [1.11.0] 已经升级的请示不能被收尾正文覆盖。
     *
     * `dsh_workplan_escalate` 在子会话中途就写下了 blocked + escalated。子 Agent
     * 随后仍可能补一段结果块（甚至写 done），如果这里照常 adjudicate，就会把
     * 「等人拍板」洗成「完成/普通失败」，提问也随之丢失。升级一旦写入，本轮
     * 的最终判定只能保留它。
     */
    const current = record.statuses.find((item) => item?.subtaskId === subtask.id);
    if (current?.closure === 'escalated')
        return { status: 'blocked', escalated: true };
    const verdict = adjudicateResult({
        output,
        strict: options.strictEvidence !== false,
        /*
         * [1.11.0] 计划验收进入裁决（T5 C4 / T10 D-01）。
         *
         * 不传这一项时，子 Agent 可以用一条自创验收项绕过整张验收表；传了之后
         * 「5 条只回 1 条」会在收尾时直接变成 blocked/unverified，而不是等到
         * 交付才被用户发现。
         */
        expectedAcceptance: Array.isArray(subtask?.acceptance) ? subtask.acceptance : [],
    });
    const checked = checkArtifacts(verdict.artifacts, options.cwd, options.artifactExists);
    const escalated = verdict.status === 'blocked'
        && typeof verdict.question === 'string' && verdict.question.trim() !== '';
    /*
     * [2.0.0] 自我学习闭环的出口：完成且带复盘证据时，立刻写入永久记忆。
     *
     * 写入失败不改变本次判定（教训没记住是记忆层的问题，不能把已经做完的工作
     * 判成未完成），但会把失败原因写进本条状态，避免「以为记住了其实没写」。
     */
    let lessonNote = '';
    if (verdict.status === 'done' && verdict.phases?.verification?.retrospective) {
        try {
            const saved = recordLesson({
                file: resolveLessonsFile(),
                planId: String(record.plan?.planId ?? ''),
                subtaskId: subtask.id,
                department: String(subtask.department ?? ''),
                title: `${subtask.id} ${subtask.title}`,
                cwd: typeof options.cwd === 'string' ? options.cwd : '',
                retrospective: verdict.phases.verification.retrospective,
                now: Date.now(),
            });
            if (saved) {
                lessonNote = saved.mode === 'repeated'
                    ? `已记住同类教训（第 ${saved.record.occurrences} 次，永久记忆）`
                    : '复盘已写入永久教训记忆';
            }
        }
        catch (error) {
            lessonNote = `复盘记忆写入失败：${truncate(error instanceof Error ? error.message : String(error), 120)}`;
        }
    }
    writeSubtaskStatus(record, subtask.id, {
        status: verdict.status,
        progress: 100,
        finishedAt: Date.now(),
        summary: truncate(lessonNote ? `${output}\n[自我学习] ${lessonNote}` : output, 3000),
        error: verdict.error,
        verification: verdict.verification,
        acceptance: verdict.acceptance,
        artifacts: checked.artifacts.length > 0 ? checked.artifacts : undefined,
        missingArtifacts: checked.missingArtifacts.length > 0 ? checked.missingArtifacts : undefined,
        needs: verdict.needs.length > 0 ? verdict.needs : undefined,
        /*
         * [1.11.0] 文本兜底：子会话拿不到 escalate 工具时，结果块里的
         * `question` 就是同一条请示。它仍然写成 blocked 投影，但 closure 是
         * escalated，看板与主 Agent 看到的都是「等指示」而不是普通失败。
         */
        ...(escalated
            ? {
                closure: 'escalated',
                blockedKind: 'escalated',
                question: verdict.question,
                options: verdict.options,
                escalatedAt: Date.now(),
                escalationSeq: Number(current?.revision ?? 0) + 1,
            }
            : verdict.status === 'done'
                /*
                 * [1.11.0] 完成必须落到 `closure:'done'`，不是 `blocked`。
                 *
                 * T9 的 P1 探针抓到过这里：完成路径固定写 `blocked/failed`，于是
                 * `done` 在执行路径不可达，「完成未回报」门禁与 `reportPending` 全部
                 * 恒不成立，进度栏也只能显示「失败」。完成与受阻是两种语义，必须分开。
                 */
                ? { closure: 'done', blockedKind: null }
                : {
                    closure: 'blocked',
                    /*
                     * [2.1.0] 沟通交流格式退回是独立的受阻类型：工作本身可能已完成，
                     * 只是结果格式不合规，须退回重交。看板与主 Agent 据此区分
                     * 「做错了」与「交错了」；退回通知（不合规条目清单）已在
                     * error 字段里，由 adjudicateResult 写入。
                     */
                    blockedKind: verdict.blockedKind === 'comm-format' ? 'comm-format' : 'failed',
                }),
    }, guard);
    if (verdict.status === 'blocked') {
        recordSubtaskError(record, subtask.id, escalated ? `待指示：${verdict.question}` : (verdict.error ?? '未完成'), guard);
    }
    else if (checked.missingArtifacts.length > 0) {
        recordSubtaskError(record, subtask.id, `声明产物缺失：${checked.missingArtifacts.join('、')}`, guard);
    }
    /*
     * [2.2.0][T6/O-1a] 完成即时通知（插件兜底通道，方案 §2.3）。
     *
     * 结算成功后立刻把「子任务 ID＋摘要＋验收计数＋用时」交给主会话，不等待
     * 整轮结束；只有真正的 done 才通知（blocked/escalated 不产生「已完成」
     * 措辞，A4）。投递与幂等标记由 `onSubtaskDone` 处理器负责：先写通知、
     * 写成功才记 report.state='sent'，绝不留无证据的已回报。
     */
    if (verdict.status === 'done' && options.notifyCompletion === true
        && typeof options.onSubtaskDone === 'function') {
        try {
            options.onSubtaskDone(record, subtask, verdict);
        }
        catch {
            /*
             * 通知是辅助通道：写失败不得回滚已经成立的完成判定，也不得让执行
             * 路径报错。失败由处理器记 reportPending，交 finishRound 批量补齐。
             */
        }
    }
    return { ...verdict, escalated };
}
/**
 * Retry policy for one child attempt.
 *
 * A wedged child (no event for the whole idle window) is worth one fresh
 * attempt. `CHILD_NOT_COMPLETED` is retried only while there is more than one
 * idle window left, otherwise the retry itself would just be killed by the same
 * watchdog.
 *
 * [1.10.3] 单个子任务撞上 900 秒硬上限时，只要整轮预算还够再跑一轮，就自动重试
 * 一次。用户 2026-11-01 的质疑是对的：此前这一支被无条件 `return false`，
 * 于是「预算没花完、只是这一步慢了」也被判成阻塞，必须等主 Agent 人工改判或
 * 重新派发——而 `attempt` 已经是 1、产物又都在盘上，重跑一次往往就能过。
 *
 * 仍然**不自动重试**的两种情况，理由不变：
 *  - `TOTAL_TIMEOUT`：整轮预算已经用光，重试必然再被同一把闸刀砍掉，只会空耗；
 *  - `ABORTED`：那是「有人决定停」而不是「跑不完」，自动重来等于违背决定。
 */
export function shouldRetryAttempt(error, attempt, remainingMs, idleTimeoutMs) {
    if (attempt >= 2)
        return false;
    const code = error?.code;
    if (code === 'CHILD_TIMEOUT') {
        /*
         * 重试要有意义，必须给它留够「至少再跑一次短任务」的时间。
         *
         * [1.10.6] 这里**不能**再拿空闲窗口当门槛（旧式 `max(idle, 120s)`）：
         * 出厂配置是 ceiling=900s / idle=300s / round=1200s，撞上限后剩下约
         * 300s，而 `remaining > 300s` 恒为假——用户要的「有预算就自动重试一次」
         * 会在默认配置下永远不触发，正是 T6 记录的那类「策略说会、链路不会」。
         * 固定 120s 是「够跑一次短任务」的下限，同时保证不会刚重试就被砍掉。
         * `tests/workplan-retry-feedback.test.ts` 的 60s 反例与 600s 正例都仍然成立。
         */
        const floor = 120000;
        return Number(remainingMs) > floor;
    }
    if (code === 'ABORTED' || code === 'TOTAL_TIMEOUT')
        return false;
    if (/aborted|refusal/i.test(String(error?.message ?? '')))
        return false;
    if (code === 'CHILD_STALLED')
        return true;
    if (code === 'CHILD_NOT_COMPLETED') {
        return Number(remainingMs) > Number(idleTimeoutMs);
    }
    return true;
}
async function executeSubtask(ctx, record, stage, subtask, options) {
    const { parentSignal, deadline, modelSelection, conversationContext = '', child, guard } = options;
    let lastError = null;
    /*
     * [1.10.6] A retry that starts after a *ceiling* timeout is a second attempt
     * even though this function is entered afresh. `attemptOffset` keeps the
     * numbering honest (`第 2 次尝试`) and, with the loop condition below, keeps
     * the cap at two real activations instead of letting the new call spend its
     * own two.
     */
    const firstAttempt = Number.isInteger(options.attemptOffset) && options.attemptOffset > 1
        ? options.attemptOffset
        : 1;
    let lastFailure = options.priorFailure ?? null;
    /*
     * [2.2.0][T3/O-2a] 子→主预告通道的两个动作，都在本函数内闭环：
     *   recordNoticeChannel  —— 派发瞬间写下「目标 / 调用方 / 时间戳」；
     *   finaliseNotice       —— 结算瞬间去父会话日志里核实预告到底有没有转达，
     *                           没转达就写一条四项齐全的失败日志（不静默丢失）。
     *
     * 目标 id 只从注入值取；注入值缺失时才按 agent.id → session.id 再解析一次
     * （重启重建/续跑路径）。[2.2.1][T5][F4] 不再回落 plan.sessionId：计划正文
     * 可能属于另一个 root 会话，不能作为「发给谁」的依据；两级都没有就留空，
     * 让提示词走「禁止猜测」分支。
     */
    const noticeLead = (() => {
        const injected = readLeadAgentId(options.leadAgentId);
        const liveAgentId = readLeadAgentId(options.agent?.id);
        /*
         * [2.2.0][T3/O-2a][F4] 目标完整性 fail-closed。
         *
         * 注入值来自 dispatchPlan 的 agent.id 优先解析；若未来某条重建/续跑路径
         * 只拿得到 plan.sessionId 兜底值，而执行侧又有活 Agent，则两者不一致
         * 时绝不能把兜底值写进子提示词（那等于把目标指向另一个 root 会话）。
         */
        if (injected && liveAgentId && injected !== liveAgentId) {
            return { id: '', source: 'mismatch:agent.id' };
        }
        if (injected) {
            return {
                id: injected,
                source: typeof options.leadAgentIdSource === 'string' && options.leadAgentIdSource !== 'none'
                    ? options.leadAgentIdSource
                    : 'options.leadAgentId',
            };
        }
        return resolveLeadAgentId({ agent: options.agent, session: options.session });
    })();
    const recordNoticeChannel = (entry) => {
        try {
            writeSubtaskStatus(record, subtask.id, { noticeChannel: entry }, guard);
        }
        catch (error) {
            /*
             * 通道留痕失败不能影响子任务本身（它是观测设施，不是交付物），但也不能
             * 一点痕迹都不留——写进本轮错误列表，主 Agent 读记录时能看到。
             */
            record.errors = [...(record.errors ?? []), `${subtask.id} noticeChannel 写入失败：${truncate(String(error?.message ?? error), 300)}`].slice(-20);
        }
    };
    const finaliseNotice = () => {
        if (guard.timedOut) {
            /*
             * [2.2.0][T3/O-2a][F3] 超时路径 writeSubtaskStatus 会被 guard 静默拒绝，
             * 不能写状态行；但通道不能停在没有结论的 awaiting。至少把四项日志写进
             * record.errors，让主 Agent 知道「是超时导致没收到结论」，而不是猜测。
             */
            const row = record.statuses.find((item) => item?.subtaskId === subtask.id);
            const current = row?.noticeChannel;
            if (current) {
                record.errors = [...(record.errors ?? []), formatNoticeChannelLog({
                        subtaskId: subtask.id,
                        target: current.target,
                        caller: current.caller,
                        at: current.at,
                        reason: 'TIMEOUT',
                    })].slice(-20);
            }
            return;
        }
        const row = record.statuses.find((item) => item?.subtaskId === subtask.id);
        const current = row?.noticeChannel;
        if (!current)
            return;
        const noticeSession = options.session && typeof options.session.eventAt === 'function'
            ? options.session
            : findSession(ctx, current.target);
        const observed = observeRelayedNotice(noticeSession, { childId: current.caller, sinceMs: current.at });
        const entry = finaliseNoticeChannel(current, {
            observed: Boolean(observed),
            observedAt: observed?.at ?? null,
            sessionAvailable: Boolean(noticeSession),
            now: Date.now(),
        });
        recordNoticeChannel(entry);
        if (entry.state !== 'observed') {
            record.errors = [...(record.errors ?? []), formatNoticeChannelLog({
                    subtaskId: subtask.id,
                    target: entry.target,
                    caller: entry.caller,
                    at: entry.at,
                    reason: entry.reason,
                })].slice(-20);
        }
    };
    /*
     * [2.1.0] 格式退回通知必须在下一次激活送达部门人员（用户 2026-11-06 的
     * 强制要求：不符合要求立刻退回，通知其重新检查格式后重交）。
     *
     * 结果被 `adjudicateResult` 判为 blocked/comm-format 后，退回通知（不合规
     * 条目清单）落在状态行 error 里；主 Agent 把该行复位为 in_progress 后
     * blockedKind 保留（只有 settle 的 assigned/done 写入才会清它）。这里据此
     * 把退回通知作为 COMM_FORMAT_REJECTED 的上次失败原因带回子提示词，部门
     * 人员重跑时能看到「退回原因 + 逐条修正要求」，而不是从零重做、把同一
     * 格式错误再交一次。
     */
    if (!lastFailure) {
        const rejectedRow = Array.isArray(record.statuses)
            ? record.statuses.find((item) => item?.subtaskId === subtask.id)
            : null;
        if (rejectedRow?.blockedKind === 'comm-format' && typeof rejectedRow?.error === 'string' && rejectedRow.error.trim() !== '') {
            lastFailure = {
                attempt: 1,
                code: 'COMM_FORMAT_REJECTED',
                message: rejectedRow.error,
            };
        }
        else if (record.commFormatRejections && typeof record.commFormatRejections === 'object') {
            /*
             * [2.1.0] 续跑路径：受阻行已被 `resetBlockedStatuses` 重置，退回原因
             * 保存在本轮的 `commFormatRejections` 里（见 dispatchPlan 的重置前置抄写）。
             * 消费一次即删，避免同一条退回通知被后续任意一次重试重复带上。
             */
            const stored = record.commFormatRejections[String(subtask.id)];
            if (typeof stored === 'string' && stored.trim() !== '') {
                lastFailure = { attempt: 1, code: 'COMM_FORMAT_REJECTED', message: stored };
                delete record.commFormatRejections[String(subtask.id)];
            }
        }
    }
    /*
     * [1.8.6] The interrupt has to outlive the thrown error.
     *
     * `interruptedFlag` travels back to the dispatcher (it must not cascade this
     * task's dependents); `interruptedEvidence` is what gets written into the
     * blocked status so the main Agent can re-adjudicate on facts.
     */
    let interruptedFlag = false;
    let interruptedEvidence = null;
    try {
        // [2.2.0][T4/O-3b] 尝试起点与协商截止同一时钟读数（C3 契约：deadlineAt −
        // startedAt 严格等于协商窗口）。deadlineAt 走 StatusEntry 未知字段保留通道
        // 直写：applyStatus（src/plan.ts，T3 领地）无路由分支，patch 会静默丢弃。
        const attemptStartMs = Date.now();
        const attemptWindowMs = Number(options.attemptTimeoutMs ?? 0);
        if (!writeSubtaskStatus(record, subtask.id, {
            status: 'in_progress',
            progress: 5,
            startedAt: attemptStartMs,
        }, guard))
            return;
        if (Number.isFinite(attemptWindowMs) && attemptWindowMs > 0) {
            const attemptRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
            if (attemptRow)
                attemptRow.deadlineAt = attemptStartMs + attemptWindowMs;
            if (options.attemptHandle) {
                options.attemptHandle.startedAt = attemptStartMs;
                options.attemptHandle.deadlineAt = attemptStartMs + attemptWindowMs;
            }
        }
        for (let attempt = firstAttempt; attempt <= 2; attempt += 1) {
            if (guard.timedOut)
                return;
            interruptedEvidence = null;
            if (parentSignal.aborted)
                throw abortError();
            if (Date.now() >= deadline)
                throw new PlanError('总执行超时', 'TOTAL_TIMEOUT');
            let activation = null;
            // Declared outside the try so the per-attempt finally can always cancel
            // the receipt timers, even when activation itself failed.
            let clearAckTimers = () => { };
            try {
                if (child.controller.signal.aborted) {
                    throw child.controller.signal.reason ?? abortError();
                }
                /*
                 * [2.0.0] 自我学习闭环的入口：把与本子任务最相关的历史教训注入提示词。
                 *
                 * 记忆读取失败不能影响本次派发（宁可不带教训，也不能因此不做任务），
                 * 所以整段用 try/catch 兜底；文件不存在时 renderLessonsBrief 返回空串。
                 */
                let lessonsBrief = '';
                try {
                    lessonsBrief = renderLessonsBrief({
                        department: subtask.department,
                        title: subtask.title,
                        objective: subtask.objective,
                        cwd: options.cwd,
                    });
                }
                catch {
                    lessonsBrief = '';
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
                                        /*
                                         * [1.11.0] 跨部门交接物必须能被下游直接消费（用户 m00687）。
                                         *
                                         * 只传状态和摘要时，下游部门知道「上游做完了」，却不知道
                                         * 产物在哪，只能重做或向主 Agent 再提一次需求。这里把上游
                                         * 已核验存在的产物引用一并带进子提示词，交接物才算真正交接。
                                         */
                                        artifacts: (Array.isArray(item.artifacts) ? item.artifacts : [])
                                            .filter((artifact) => artifact?.exists === true && typeof artifact?.ref === 'string')
                                            .map((artifact) => String(artifact.ref)),
                                    })),
                                    cwd: options.cwd,
                                    conversationContext,
                                    statuses: record.statuses,
                                    /*
                                     * [2.2.0][T3/O-2a] 子→主预告通道的目标（真实父会话 id）。
                                     *
                                     * 宿主只在非 caller 投递时注入父会话 id，本插件用 caller 投递，
                                     * 所以这里必须自己给值；空值走「禁止猜测」分支，绝不编造 id。
                                     */
                                    leadAgentId: noticeLead.id,
                                    leadAgentIdSource: noticeLead.source,
                                    /*
                                     * [2.1.0] 不再用 attempt>1 做门槛：被格式退回的行复位后第 1 次
                                     * 激活也必须带上退回通知，否则「退回」只是写了一行状态。
                                     */
                                    previousFailure: lastFailure ?? null,
                                    lessonsBrief,
                                }),
                            }],
                        parent: options.agent,
                        cwd: typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined,
                        /*
                         * [2.2.0][T13/推理等级] 子 Agent 不得继承主 Agent 的推理等级。
                         *
                         * 用户规则原文：「禁止子agent继承主agent的推理等级，子agent必须根据
                         * 自身任务的复杂度，自己使用推理等级为low、high或者是Max，其中，轻度
                         * 复杂的任务使用low，中等复杂的任务使用high，非常复杂的任务使用Max。」
                         * 宿主 resolveChildAgentOptions 在请求未点名 reasoningEffort 时会继承
                         * 父 Agent 的等级（dsh-subagent child-agent.d.ts:40-50），旧实现在这里
                         * 只传 provider/model，于是主 Agent 的等级被原样带进每个部门子会话。
                         * 现在显式覆盖为子任务自己的档位；缺失（旧计划/回放）回落 high，绝不
                         * 读取 modelSelection.reasoningEffort。
                         */
                        agentOptions: {
                            ...(modelSelection?.provider && modelSelection?.model
                                ? { provider: modelSelection.provider, model: modelSelection.model }
                                : {}),
                            reasoningEffort: typeof subtask.reasoningEffort === 'string'
                                && REASONING_EFFORTS.includes(subtask.reasoningEffort)
                                ? subtask.reasoningEffort
                                : DEFAULT_REASONING_EFFORT,
                        },
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
                /*
                 * [1.11.0] `assigned` 是「已交给子会话」，不是「子会话已确认」。
                 *
                 * 旧代码只写 childId + 10%，从这一刻起到子 Agent 真正产出第一个事件
                 * 之间没有任何可观察状态：用户看到 10% 长时间不动，也无法区分
                 * 「没启动」「启动失败」「在跑一个很长的工具」。这里把派发序号和
                 * 回执窗口一起写进状态，后面的 onProgress/定时器才有据可依。
                 */
                const assignedAt = Date.now();
                const dispatchSeq = Number(record.dispatchSeq ?? 0) + 1;
                record.dispatchSeq = dispatchSeq;
                const assigned = writeSubtaskStatus(record, subtask.id, {
                    childId: activation.childId,
                    progress: 10,
                    closure: 'assigned',
                    assignedAt,
                    dispatchSeq,
                    // A retry is a fresh attempt: no stale receipt or escalation survives it.
                    ackedAt: null,
                    ackEvidence: undefined,
                    ackOverdue: false,
                    escalatedAt: null,
                    escalationSeq: null,
                    question: null,
                    options: [],
                    blockedKind: null,
                }, guard);
                if (!assigned)
                    return;
                /*
                 * [2.2.0][T3/O-2a] 通道条目：此刻写下目标、调用方与时间戳。
                 *
                 * 这一步只记事实，不猜结果——消息有没有真的到主会话，要等结算时去父
                 * 会话日志里看（observeRelayedNotice）。旧实现里预告失败在计划记录上
                 * 完全不可见，主 Agent 只能看到一句 `subagent "lead" is unavailable`。
                 */
                recordNoticeChannel(createNoticeChannel({
                    target: noticeLead.id,
                    targetSource: noticeLead.source,
                    caller: activation.childId,
                    at: assignedAt,
                }));
                const ackTimers = [];
                clearAckTimers = () => {
                    while (ackTimers.length > 0) {
                        const timer = ackTimers.pop();
                        if (timer)
                            clearTimeout(timer);
                    }
                };
                const attemptRow = () => record.statuses.find((item) => item?.subtaskId === subtask.id);
                const noticeTimer = setTimeout(() => {
                    if (guard.timedOut)
                        return;
                    const row = attemptRow();
                    if (row?.closure !== 'assigned' || row?.dispatchSeq !== dispatchSeq)
                        return;
                    writeSubtaskStatus(record, subtask.id, { ackOverdue: true }, guard);
                }, ASSIGN_ACK_NOTICE_MS);
                noticeTimer.unref?.();
                ackTimers.push(noticeTimer);
                /*
                 * [1.11.0] 180s 仍无回执 → 明确收束为 no-ack，而不是继续静默等待。
                 *
                 * 看门狗默认空闲窗口是 300s，而「根本没启动」和「在慢慢想」在日志上
                 * 都表现为没有新事件。先把状态写成 blocked + blockedKind:'no-ack'，
                 * 再中止子会话；主 Agent 因此能立刻看到原因，也能选择续跑。
                 */
                const deadlineTimer = setTimeout(() => {
                    if (guard.timedOut)
                        return;
                    const row = attemptRow();
                    if (row?.closure !== 'assigned' || row?.dispatchSeq !== dispatchSeq)
                        return;
                    const seconds = Math.round(ASSIGN_ACK_DEADLINE_MS / 1000);
                    const message = `派发后 ${seconds}s 未收到子 Agent 任何新事件（no-ack）`;
                    writeSubtaskStatus(record, subtask.id, {
                        status: 'blocked',
                        closure: 'blocked',
                        blockedKind: 'no-ack',
                        progress: 100,
                        finishedAt: Date.now(),
                        ackOverdue: true,
                        error: message,
                        summary: `未完成：${message}`,
                    }, guard);
                    recordSubtaskError(record, subtask.id, message, guard);
                    if (!child.controller.signal.aborted) {
                        child.controller.abort(new PlanError(message, 'CHILD_NO_ACK', { subtaskId: subtask.id }));
                    }
                }, ASSIGN_ACK_DEADLINE_MS);
                deadlineTimer.unref?.();
                ackTimers.push(deadlineTimer);
                const idleTimeoutMs = normaliseIdleTimeout(options.idleTimeoutMs);
                // [2.2.0][T4/O-3b][O-4d] 双计时同源（方案 §2.5）：看门狗 hardMs 与本次尝试的
                // 协商执行时限同值（options.attemptTimeoutMs，缺省回落旧路径）；两者必须同步
                // 推移——延期时 rearmApproachingDeadline 传「自尝试起点计的新完整窗口」。
                const hardTimeoutMs = Number.isFinite(Number(options.attemptTimeoutMs)) && Number(options.attemptTimeoutMs) > 0
                    ? Math.min(MAX_CHILD_TIMEOUT_MS, Math.max(MIN_CHILD_TIMEOUT_MS, Number(options.attemptTimeoutMs)))
                    : normaliseChildTimeout(options.childTimeoutMs);
                const watchdog = createProgressWatchdog({
                    // [2.2.0][T4/O-3b][O-4b] 到点预警接线（T7 watchdog.ts 契约，原样消费）：
                    // 剩余 ≤ max(timeoutMs×0.2, 120000) 触发一次、同一武装周期幂等、extend 后
                    // rearm 可再触发。最小处理器：时间链留档 timeWarning＋本轮记录 notice＋会话
                    // 消息通知主 Agent（格式朴素，T6 波次统一润色）。
                    subtaskId: String(subtask.id),
                    onApproachingDeadline: (info) => {
                        if (guard.timedOut)
                            return;
                        try {
                            const warnRow = Array.isArray(record.statuses)
                                ? record.statuses.find((item) => item?.subtaskId === subtask.id)
                                : null;
                            if (warnRow) {
                                // timeWarning 走未知字段通道直写（applyStatus 白名单属 T3 领地）。
                                warnRow.timeWarning = {
                                    at: Date.now(),
                                    remainingMs: Math.max(0, Number(info?.remainingMs ?? 0)),
                                    newEstimateMinutes: null,
                                    channel: 'watchdog',
                                };
                            }
                            const text = `子任务 ${subtask.id} 即将到点：剩余 ${Math.max(0, Math.round(Number(info?.remainingMs ?? 0) / 1000))}s（协商上限 ${Number(info?.timeoutMs ?? 0)}ms）；如需继续请尽快决定延期（extendMs），否则到点将按安全兜底结算（待裁决）`;
                            record.notices = [...(record.notices ?? []), text].slice(-20);
                            record.updatedAt = Date.now();
                            /*
                             * 会话消息只对「有决策余量」的窗口推送：窗口 < 120000ms（＝触发规则
                             * max(timeoutMs×0.2, 120000) 里的预警下限，生产最小派生窗口恰好
                             * 120000ms）只出现在测试小窗场景，预警本身没有可执行的延期决策余量，
                             * 此时只留档（record.notices＋timeWarning），不推送会话消息——也不与
                             * tests/workplan-stuck-recovery.test.ts「session.events 只计持久消息」
                             * 的既有断言冲突。T6 波次统一润色通知渠道时再定稿推送策略。
                             * [2.2.0][T6/O-1a] 渠道已定稿：与完成即时通知同走主会话
                             * `user/message` 纯文本通道（方案 §2.3「即时通知消息」）；决策余量
                             * 门槛（timeoutMs ≥ 120000，取自触发规则预警下限）保持不变，故
                             * 上述断言不受影响。
                             */
                            if (Number(info?.timeoutMs ?? 0) >= 120000) {
                                const warnSession = options.session ?? options.agent?.session;
                                appendUserMessage(warnSession, text);
                            }
                        }
                        catch {
                            // 预警只做提示不得影响执行：写档失败静默忽略（T6 波次统一润色）。
                        }
                    },
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
                    onProgress: ({ now, seq, elapsedMs }) => {
                        if (guard.timedOut)
                            return;
                        // Visible liveness: the dashboard can show that a slow subtask is
                        // still producing events instead of looking frozen.
                        record.heartbeatAt = now;
                        record.updatedAt = now;
                        /*
                         * [1.11.0] 第一次观察到子会话日志增长 = 回执。
                         *
                         * 这是唯一能证明「子 Agent 已经在动」的廉价事实：不用它自己的
                         * 汇报（可能永远等不到），只看它有没有产生新事件。回执写入后
                         * 两个 no-ack 定时器立即撤销，正常的长任务不会被误判。
                         */
                        const row = attemptRow();
                        if (row?.closure !== 'assigned' || row?.dispatchSeq !== dispatchSeq)
                            return;
                        const acked = writeSubtaskStatus(record, subtask.id, {
                            closure: 'acknowledged',
                            ackedAt: now,
                            ackEvidence: { seq, elapsedMs },
                            ackOverdue: false,
                            progress: Math.max(Number(row.progress ?? 10), 15),
                        }, guard);
                        if (acked)
                            clearAckTimers();
                    },
                    makeError: (reason) => new PlanError(reason === 'stalled'
                        ? `子任务 ${subtask.id} 无进展超时（${idleTimeoutMs}ms 内子 Agent 没有产生任何新事件）`
                        : `子任务 ${subtask.id} 超时（${hardTimeoutMs}ms）`, reason === 'stalled' ? 'CHILD_STALLED' : 'CHILD_TIMEOUT', { subtaskId: subtask.id }),
                });
                // [2.2.0][T4/O-3b][O-4d] 看门狗挂到计时句柄：extendDeadline 延期成功后经
                // watchdog.rearmApproachingDeadline（传新完整窗口）同步推移两处计时。
                options.attemptHandle?.attachWatchdog?.(watchdog);
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
                    /*
                     * [1.8.5] 中断必须自己说出「接下来怎么办」。
                     *
                     * 2026-10-30 事故：T6 在被外部中断前 2 秒已写出 38KB 交付物，插件只留下
                     * 「子 Agent 结束状态为 aborted」，主 Agent 无从知道产物其实已经在盘上，
                     * 于是把它当彻底失败处理，并把 6 个下游一起判死。中断类失败要显式提示
                     * 「先核对已写出的产物」，并给出据实改判与续跑这两条出口。
                     */
                    const interrupted = result.stopReason === 'aborted';
                    const landed = interrupted ? probeInterruptedArtifacts(output, subtask, options.cwd, options.artifactExists) : [];
                    if (interrupted) {
                        interruptedFlag = true;
                        interruptedEvidence = probeInterruptedEvidence(output, subtask, options.cwd, options.artifactExists);
                    }
                    throw new PlanError(`子 Agent 结束状态为 ${result.stopReason}${result.diagnostic ? `：${result.diagnostic}` : ''}${interrupted
                        ? `（子 Agent 在完成前被中断：先核对该步声明的产物是否已写出${landed.length > 0
                            ? `——已核到 ${landed.length} 个文件确实在盘上：${landed.join('、')}`
                            : ''}；据实改判，再决定是否续跑）`
                        : ''}`, 'CHILD_NOT_COMPLETED');
                }
                if (!output)
                    throw new PlanError('子 Agent 没有返回文本结果', 'EMPTY_CHILD_OUTPUT');
                /*
                 * [1.7.0] Evidence decides the verdict.
                 *
                 * The old rule was "not BLOCKED => done", so a child that reported
                 * unverified or failed self-checks was still counted as finished and
                 * the main Agent had nothing to review but prose. `adjudicateResult`
                 * is the single deterministic table; `settleFromOutput` adds the
                 * environment-dependent artifact check.
                 */
                settleFromOutput(record, subtask, output, guard, options);
                return;
            }
            catch (error) {
                lastError = error;
                if (guard.timedOut)
                    break;
                const isAbort = parentSignal.aborted || child.controller.signal.aborted;
                const idleTimeoutMs = normaliseIdleTimeout(options.idleTimeoutMs);
                const remaining = deadline - Date.now();
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
                };
                const retry = !isAbort && shouldRetryAttempt(error, attempt, remaining, idleTimeoutMs);
                if (retry) {
                    record.errors = [
                        ...(record.errors ?? []),
                        `${subtask.id}: 第 ${attempt} 次执行失败（${lastFailure.code}），已带上失败原因重试`,
                    ].slice(-20);
                    writeSubtaskStatus(record, subtask.id, { progress: 15 }, guard);
                    continue;
                }
                /* [1.10.3] CHILD_TIMEOUT 现在也会在预算充足时重试，所以「预算不足未重试」这条说明对它同样成立。 */
                if (!isAbort && remaining <= idleTimeoutMs) {
                    record.errors = [
                        ...(record.errors ?? []),
                        `${subtask.id}: 剩余预算不足（${Math.max(0, Math.round(remaining / 1000))}s），未重试`,
                    ].slice(-20);
                }
                break;
            }
            finally {
                clearAckTimers();
                if (activation) {
                    await disposeActivation(activation, record, subtask.id, guard);
                    activation = null;
                }
            }
        }
        /*
         * [1.11.0] 已升级的请示不被最终的失败收束覆盖。
         *
         * 子 Agent 可能先调用 escalate，再因为中断/超时走到这里；此时问题已经
         * 写入状态，把它改成普通 blocked 会让主 Agent 永远看不到要回答什么。
         */
        const finalRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
        if (finalRow?.closure === 'escalated') {
            return interruptedFlag ? { interrupted: true } : undefined;
        }
        const message = describeError(lastError ?? new Error('未知失败'));
        writeSubtaskStatus(record, subtask.id, {
            status: 'blocked',
            closure: 'blocked',
            blockedKind: 'failed',
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
        }, guard);
        recordSubtaskError(record, subtask.id, message, guard);
        return interruptedFlag ? { interrupted: true } : undefined;
    }
    catch (error) {
        const message = describeError(error);
        try {
            const row = record.statuses.find((item) => item?.subtaskId === subtask.id);
            if (row?.closure === 'escalated') {
                recordSubtaskError(record, subtask.id, `升级后发生异常，保留待指示状态：${message}`, guard);
                return;
            }
            writeSubtaskStatus(record, subtask.id, {
                status: 'blocked',
                closure: 'blocked',
                blockedKind: 'failed',
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
    finally {
        /*
         * [2.2.0][T3/O-2a] 结算点唯一的通道收束入口（成功/受阻/待指示/中断都走这里）。
         *
         * 放在 finally 而不是各条 return 前面，是为了让「通道结论」与「子任务结论」
         * 一定是同一次执行的产物：任何一个出口漏写，都会让预告看起来像消失了。
         * [F3] 观测设施自身不得把已结算的子任务变成本轮异常：任何异常只进
         * record.errors，绝不从 finally 外抛。
         */
        try {
            finaliseNotice();
        }
        catch (error) {
            record.errors = [...(record.errors ?? []), `${subtask.id} noticeChannel 收束失败：${truncate(String(error?.message ?? error), 300)}`].slice(-20);
        }
    }
}
/*
 * [2.2.0][T4/O-3b] 本次执行时限（柔性时长协商消费序；T3b 待决点③裁决：消费侧钳位）。
 *
 * 消费序：① subtask.timeoutMs 显式协商上限（O-3c 原样透传）→ ② 缺省
 * deriveSubtaskTimeoutMs(estimateMinutes)＝clamp(预估分钟×2.0×60000, 1000,
 * 7200000) 派生（方案 §1③）→ ③ 两者皆无回落 normaliseChildTimeout（全局兜底
 * CHILD_TIMEOUT_MS，方案 ③C2 零回归）。结果统一钳 [MIN_CHILD_TIMEOUT_MS,
 * MAX_CHILD_TIMEOUT_MS]（方案 ③C3）。
 *
 * 显式注入的 childTimeoutMs（测试小窗 / DSH_WORKPLAN_CHILD_TIMEOUT_MS 旋钮）
 * 语义是「兜底上限」而非「固定值」（方案 §5.2「协商的默认基准/兜底上限」）：
 * 它对上面三步的结果取 min。必须区分「显式注入」与「缺省」——验收合同
 * tests/no-fixed-deadline-semantics.test.ts E4 注入 1000ms 小窗必须压过
 * estimateMinutes:10 派生的 1200000ms；而 tests/time-estimate-negotiation
 * .test.ts C3（无注入）派生值必须严格生效（deadlineAt − startedAt === 派生值）。
 * 因此 dispatchPlan 三处调用点改传 options.childTimeoutMs 原始值（未配置＝
 * undefined），不再传 normalise 后的 limits.childTimeoutMs（后者恒为 900000，
 * 无法区分显式与缺省）。
 */
function resolveSubtaskTimeoutMs(subtask, configuredChildTimeoutMs) {
    const clampWindow = (value) => Math.min(MAX_CHILD_TIMEOUT_MS, Math.max(MIN_CHILD_TIMEOUT_MS, value));
    const explicit = Number(subtask?.timeoutMs);
    const derived = deriveSubtaskTimeoutMs(subtask?.estimateMinutes, MIN_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS);
    let window;
    if (Number.isFinite(explicit) && explicit > 0)
        window = clampWindow(explicit);
    else if (derived !== undefined)
        window = clampWindow(derived);
    else
        window = normaliseChildTimeout(configuredChildTimeoutMs);
    // 显式注入＝兜底上限（对协商结果取 min）；未配置不封顶。
    const cap = Number(configuredChildTimeoutMs);
    if (Number.isFinite(cap) && cap > 0)
        window = Math.min(window, clampWindow(cap));
    return window;
}
/*
 * [2.2.0][T4/O-3b][O-4c/O-4d] 延期接口（D 项；T5 extendMs 事务的计时侧承接）。
 *
 * 调用契约（T5 按此接线）：
 *   extendDeadline(record, subtaskId, extendMs, { by?, reason? })
 *   → 成功 { ok: true, deadlineAt, timerRearmed: true, watchdogRearmed }
 *   → 拒绝 { ok: false, code: 'INVALID_EXTEND' | 'NO_ACTIVE_ATTEMPT', error, hint }
 *
 * 语义与边界：
 * - extendMs 须为正有限数（毫秒，向下取整），否则 INVALID_EXTEND。
 * - 只对「有活跃尝试」的子任务生效（runSubtaskAttempt 已注册计时句柄且未收束）；
 *   已到点收束 / 已结束的尝试一律 NO_ACTIVE_ATTEMPT（不能复活已结算的行）。
 * - 累计放宽预算校验（≤初始协商上限×1，超限 EXTEND_BUDGET_EXHAUSTED→转新轮
 *   续跑或转 escalate）属 T5 事务层职责，本函数不重复校验：调用方先校验再调用。
 * - 线程/并发语义：Node 单线程；本函数「校验→改 deadlineAt→重置计时器→
 *   watchdog.rearmApproachingDeadline→行内直写」在一个同步段完成，天然原子；
 *   并发调用按到达顺序串行，每次追加独立 timeJournal 条目（action:'extend'）。
 * - 延期成功后 deadlineAt 同步更新（行上字段＝句柄 deadlineAt），runSubtaskAttempt
 *   的一次性计时器重置为「新截止点 − now」，原截止点不再触发（O-4d：任务不被
 *   原截止点杀死）。
 * - 与 watchdog 的配合（F 项）：watchdog.rearmApproachingDeadline(newTimeoutMs)
 *   传入「自尝试起点计的新完整窗口」＝deadlineAt − 尝试起点（T7 watchdog.ts
 *   契约，不是剩余量）；两处计时同步推移（方案 §2.5），先触发者仍会杀任务。
 * - 行字段直写原因：applyStatus（src/plan.ts，T3 领地）无 deadlineAt/timeJournal
 *   路由分支，patch 会静默丢弃；这里走 StatusEntry 未知字段保留通道直写，
 *   回放/重建白名单在 reconstructFromSession 同名直写（本文件 2931 一带）。
 */
export function extendDeadline(record, subtaskId, extendMs, meta = {}) {
    const id = String(subtaskId ?? '');
    const amount = Number(extendMs);
    if (!Number.isFinite(amount) || amount < 1) {
        return {
            ok: false,
            code: 'INVALID_EXTEND',
            error: `extendMs 必须是正有限数（毫秒）：${String(extendMs)}`,
            hint: '请传入 1 以上的毫秒数；需要更长时限请转新轮续跑或转 escalate',
        };
    }
    const delta = Math.floor(amount);
    const handle = record?.attemptHandles?.[id];
    if (!handle || handle.settled) {
        return {
            ok: false,
            code: 'NO_ACTIVE_ATTEMPT',
            error: `子任务 ${id} 当前没有可延期的执行中尝试`,
            hint: '已收束的尝试不能复活：请转新轮续跑或人工裁决（escalate）',
        };
    }
    const deadlineAt = handle.extend(delta);
    const row = Array.isArray(record?.statuses)
        ? record.statuses.find((item) => item?.subtaskId === id)
        : null;
    if (row) {
        // deadlineAt/timeJournal 走未知字段通道直写（applyStatus 白名单属 T3 领地）。
        row.deadlineAt = deadlineAt;
        const journal = Array.isArray(row.timeJournal) ? row.timeJournal : [];
        journal.push({
            at: Date.now(),
            action: 'extend',
            extendMs: delta,
            by: ['agent', 'child', 'system'].includes(meta?.by) ? meta.by : 'agent',
            reason: truncate(String(meta?.reason ?? ''), 300),
        });
        row.timeJournal = journal.slice(-20);
    }
    record.updatedAt = Date.now();
    return { ok: true, deadlineAt, timerRearmed: true, watchdogRearmed: Boolean(handle.watchdog) };
}
/*
 * One attempt under a deadline that belongs to that attempt alone.
 *
 * [1.10.6] Split out of `runSubtask` so a ceiling timeout can be retried with a
 * *fresh* timer. The old code armed a single timer for the whole subtask (shared
 * by both attempts), so even once the retry decision became reachable the second
 * attempt would have had no time left — a patch that changes nothing.
 *
 * The timer remains a full settlement guarantee, not just an abort hint: if the
 * child activation ignores its abort signal, or never settles at all, the race
 * below still resolves, the subtask is recorded as blocked, and the dispatcher
 * keeps scheduling the rest of the DAG.
 */
async function runSubtaskAttempt(ctx, record, stage, subtask, options, timeoutMs) {
    const child = createChildController(options.parentSignal);
    const guard = { timedOut: false };
    let timer = null;
    let ceilingFired = false;
    // [1.10.6] What the ceiling left on disk, in the words of the same probe the
    // blocked row records. The retry is compared against exactly this list.
    let ceilingLanded = [];
    /*
     * [1.10.6] Snapshot taken *at the moment the ceiling fires*, not later.
     *
     * The first cut of this check fingerprinted the same refs twice, back to back,
     * immediately before the retry. Two reads of the same instant can never
     * differ, so the conflict branch was unreachable in production (only a test
     * injecting a mutating `stat` could reach it). The record must be taken while
     * the timeout is being recorded; the pre-retry read is compared against it.
     */
    let ceilingFingerprint = [];
    const stat = typeof options.artifactStat === 'function' ? options.artifactStat : statSync;
    /*
     * [2.2.0][T4/O-3b][O-4d] 可延期计时句柄（D 项延期接口的运行时锚点，方案 §2.2/§2.5）。
     * 本次尝试的协商截止只属于这次尝试：extend() 重置一次性计时器并同步 watchdog
     * （rearmApproachingDeadline 传「自尝试起点计的新完整窗口」）；settled 后不得
     * 复活（extendDeadline 一律 NO_ACTIVE_ATTEMPT）。行上 deadlineAt 由 executeSubtask
     * 以同一时钟读数写入（C3 契约），句柄权威值随写同步。
     */
    const attemptStart = Date.now();
    const attemptHandle = {
        subtaskId: String(subtask.id),
        startedAt: attemptStart,
        deadlineAt: attemptStart + timeoutMs,
        settled: false,
        watchdog: null,
        arm: (_ms) => { },
        extend(ms) {
            if (this.settled)
                return this.deadlineAt;
            this.deadlineAt += ms;
            this.arm(this.deadlineAt - Date.now());
            this.watchdog?.rearmApproachingDeadline(this.deadlineAt - this.startedAt);
            return this.deadlineAt;
        },
        attachWatchdog(watchdog) {
            this.watchdog = watchdog;
        },
    };
    record.attemptHandles = { ...(record.attemptHandles ?? {}), [String(subtask.id)]: attemptHandle };
    const deadlinePromise = new Promise((resolve) => {
        const fire = () => {
            ceilingFired = true;
            guard.timedOut = true;
            attemptHandle.settled = true;
            // [2.2.0][T4/O-3b][O-4d] L4 安全兜底结算＋「待裁决」标记（E4 契约）：时间是
            // 协商出来的安全兜底，不是固定交付期限——到点不表述为「强制结束」式固定期限
            // 误杀，而是安全兜底结算落盘，供主 Agent 决定延期 / 重试 / 接受（或转新轮
            // 续跑、人工裁决）。Reached only when the child ignored both its idle window
            // and its abort signal; the message says so, otherwise the cause looks like
            // a plain "too slow" and the next investigation goes down the wrong path.
            const message = `子任务 ${subtask.id} 达到协商执行上限（${timeoutMs}ms），已按安全兜底结算（待裁决：请主 Agent 决定延期 / 重试 / 接受，或转新轮续跑、人工裁决）`;
            try {
                // [1.8.19] Keep the evidence of what already landed on disk.
                const { patch, landed } = timeoutBlockedPatch(subtask, options.cwd, message, options.artifactExists);
                ceilingLanded = Array.isArray(landed) ? landed : [];
                ceilingFingerprint = fingerprintArtifacts(ceilingLanded, options.cwd, stat);
                /*
                 * [1.11.0] An escalation outranks the ceiling.
                 *
                 * The child may have written `escalated` seconds before this timer fired;
                 * turning that into a plain timeout would erase the question the main
                 * Agent has to answer. The activation is still aborted, but the row keeps
                 * its pending-decision state.
                 */
                const existing = record.statuses.find((item) => item?.subtaskId === subtask.id);
                if (existing?.closure === 'escalated') {
                    record.errors = [
                        ...(record.errors ?? []),
                        `${subtask.id}: 已达执行上限，但该子任务已在等待指示，保留 escalated 状态`,
                    ].slice(-20);
                }
                else {
                    record.statuses = applyStatus(record.statuses, subtask.id, patch);
                    record.errors = [...(record.errors ?? []), `${subtask.id}: ${patch.error}`].slice(-20);
                }
                /*
                 * [2.2.0][T4/O-3b][C/E] 「待裁决」结构化标记（E4 契约）：结算文案已含
                 * 「待裁决」，这里再落机器可读标记供裁决/回放白名单透传（pendingAdjudication）。
                 * 走 StatusEntry 未知字段通道直写（applyStatus 白名单属 T3 领地）。
                 */
                const settleRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
                if (settleRow)
                    settleRow.pendingAdjudication = true;
                record.updatedAt = Date.now();
            }
            catch (error) {
                record.errors = [
                    ...(record.errors ?? []),
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
        };
        // [2.2.0][T4/O-3b][O-4d] 可延期计时（D 项）：arm() 重置一次性计时器，extend()
        // 经 attemptHandle 调用它把截止点推移到新协商截止；原截止点不再触发。
        const arm = (ms) => {
            if (timer)
                clearTimeout(timer);
            timer = setTimeout(fire, Math.max(1, ms));
            timer.unref?.();
        };
        attemptHandle.arm = arm;
        arm(timeoutMs);
    });
    try {
        // [1.8.6] The outcome (`{interrupted:true}`) has to reach the dispatcher;
        // swallowing it here is why an interrupted child looked like any failure.
        const outcome = await Promise.race([
            executeSubtask(ctx, record, stage, subtask, {
                ...options,
                child,
                guard,
                // [2.2.0][T4/O-3b] 本次尝试的协商执行时限与计时句柄（deadlineAt 写入同源、
                // 看门狗 hardMs 同值、延期接口锚点）。
                attemptTimeoutMs: timeoutMs,
                attemptHandle,
            }),
            deadlinePromise,
        ]);
        return { outcome, ceilingFired, ceilingLanded, ceilingFingerprint };
    }
    finally {
        // [2.2.0][T4/O-3b] 收束即注销句柄：已收束的尝试不得再被 extendDeadline 复活。
        attemptHandle.settled = true;
        if (record.attemptHandles)
            delete record.attemptHandles[String(subtask.id)];
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        child.disposeListener();
        if (!child.controller.signal.aborted)
            child.controller.abort();
    }
}
/*
 * Runs one subtask, retrying **once** when the per-subtask ceiling fired and the
 * round budget can still pay for a second attempt (T6 G1/G3/G4).
 *
 * The retry is deliberately narrow:
 *  - only the ceiling (`CHILD_TIMEOUT`) qualifies; a user abort and a round
 *    budget timeout stay non-retryable, because retrying them would be killed by
 *    the same guillotine;
 *  - at most one retry (`attemptOffset: 2` caps the inner loop at a single run);
 *  - before it starts, the artifacts the first attempt landed are fingerprinted
 *    (path + size + mtime) and re-checked. If any of them changed since the
 *    timeout was recorded, something else owns that file now: the retry is
 *    skipped and the row is marked `artifactConflict` instead of overwriting it.
 */
async function runSubtask(ctx, record, stage, subtask, options) {
    // [2.2.0][T4/O-3b] 本次执行时限＝柔性时长协商消费序（见 resolveSubtaskTimeoutMs）：
    // ① subtask.timeoutMs 显式值 → ② deriveSubtaskTimeoutMs(estimateMinutes) 派生 →
    // ③ 缺省回落 CHILD_TIMEOUT_MS；显式注入的 childTimeoutMs 作兜底上限取 min。
    const childTimeoutMs = resolveSubtaskTimeoutMs(subtask, options.childTimeoutMs);
    const first = await runSubtaskAttempt(ctx, record, stage, subtask, options, childTimeoutMs);
    if (!first.ceilingFired)
        return first.outcome;
    const idleTimeoutMs = normaliseIdleTimeout(options.idleTimeoutMs);
    const now = Date.now();
    const deadline = Number.isFinite(options.deadline) ? Number(options.deadline) : now + childTimeoutMs;
    const remaining = deadline - now;
    const message = `子任务 ${subtask.id} 达到协商执行上限（${childTimeoutMs}ms）`;
    /*
     * [1.8.6] A parent abort outranks a retry: the round is being stopped on
     * purpose, and a second child would only be aborted on arrival.
     */
    if (options.parentSignal?.aborted)
        return first.outcome;
    if (!shouldRetryAttempt({ code: 'CHILD_TIMEOUT', message }, 1, remaining, idleTimeoutMs)) {
        record.errors = [
            ...(record.errors ?? []),
            `${subtask.id}: 达到执行上限，剩余预算 ${Math.max(0, Math.round(remaining / 1000))}s 不足，未重试`,
        ].slice(-20);
        return first.outcome;
    }
    /*
     * [1.10.6] T6 G3: never retry over work that already exists.
     *
     * `ceilingFingerprint` was taken the moment the ceiling fired (inside the
     * timeout callback); the same refs are re-read right before the retry starts.
     * A size or mtime difference means the file was written by somebody else in
     * between, so a retry would overwrite it rather than finish it.
     */
    const stat = typeof options.artifactStat === 'function' ? options.artifactStat : statSync;
    const current = fingerprintArtifacts(first.ceilingLanded, options.cwd, stat);
    const conflicts = diffArtifactFingerprints(first.ceilingFingerprint, current);
    const row = Array.isArray(record.statuses)
        ? record.statuses.find((item) => item.subtaskId === subtask.id)
        : null;
    if (conflicts.length > 0) {
        const note = `重试前核对发现已落盘产物在超时后被改动（${conflicts.join('、')}），为避免覆盖已跳过自动重试，请人工核对`;
        record.statuses = applyStatus(record.statuses, subtask.id, {
            artifactConflict: conflicts,
            error: truncate(`${truncate(String(row?.error ?? message), 1500)}；${note}`, 2000),
        });
        record.errors = [...(record.errors ?? []), `${subtask.id}: ${note}`].slice(-20);
        record.updatedAt = Date.now();
        return first.outcome;
    }
    record.statuses = applyStatus(record.statuses, subtask.id, {
        status: 'in_progress',
        progress: 15,
        // Clearing `error` moves the timeout text to `lastError` (applyStatus does
        // that move), so the row no longer claims "blocked" while it is retrying.
        error: null,
    });
    record.errors = [
        ...(record.errors ?? []),
        `${subtask.id}: 第 1 次执行达到上限（CHILD_TIMEOUT），已核对产物无冲突，自动重试一次`,
    ].slice(-20);
    record.updatedAt = Date.now();
    const retryTimeoutMs = Math.max(MIN_CHILD_TIMEOUT_MS, Math.min(childTimeoutMs, remaining));
    const second = await runSubtaskAttempt(ctx, record, stage, subtask, {
        ...options,
        attemptOffset: 2,
        priorFailure: { attempt: 1, code: 'CHILD_TIMEOUT', message: `${message}，已按安全兜底结算（待裁决）` },
    }, retryTimeoutMs);
    return second.outcome;
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
/**
 * The subtask rows a dispatch/status tool returns to the model.
 *
 * One definition, because the same plan was described in three slightly
 * different shapes (dispatch tail, already-running branch, status tool) and the
 * model could see three different answers in one turn.
 */
export function modelStatusLines(statuses) {
    const list = Array.isArray(statuses) ? statuses : [];
    return list.map((item) => ({
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
            ? item.acceptance.slice(0, 8).map((entry) => ({
                criterion: truncate(String(entry?.criterion ?? ''), 200),
                result: String(entry?.result ?? ''),
                evidence: truncate(String(entry?.evidence ?? ''), 300),
            }))
            : [],
        revision: Number(item.revision ?? 0),
        updatedBy: item.updatedBy ?? null,
        missingArtifacts: Array.isArray(item.missingArtifacts) ? item.missingArtifacts : [],
        needs: Array.isArray(item.needs) ? item.needs : [],
        // [1.11.0] 闭环阶段必须进入模型可读面：只暴露四值 status 时，
        // 「在等指示」和「做失败了」在工具输出里长得一模一样。
        closure: item.closure ?? null,
        blockedKind: item.blockedKind ?? null,
        question: item.question ?? null,
        options: Array.isArray(item.options) ? item.options : [],
        ackOverdue: item.ackOverdue === true,
        escalatedAt: item.escalatedAt ?? null,
        instruction: item.instruction?.text ? truncate(item.instruction.text, 500) : null,
        /*
         * [1.11.0] 跨部门需求的待处理项必须出现在模型可读面（用户 m00687）。
         *
         * 只放在结果消息里时，主 Agent 一旦错过那一轮就再也看不到「还有一条
         * 需求没处置」，而交付门禁却一直拦着。status 工具是与进度同源的读取口，
         * 这里只暴露未处置项，避免把已答复的历史反复塞进上下文。
         */
        openHandoffs: openHandoffs(item).map((handoff) => ({
            id: handoff.id,
            request: truncate(String(handoff.request ?? ''), 300),
            department: handoff.department ?? null,
            status: handoff.status,
        })),
        reportedAt: item.reportedAt ?? null,
        /*
         * [2.2.0][T4/O-3b][O-2.4] 柔性时长协商字段进入模型可读面（纯展示）：
         * 协商截止 deadlineAt、尝试起点 startedAt、剩余协商时间、预警标记 timeWarning、
         * 待裁决标记 pendingAdjudication 与时间链审计 timeJournal。验收合同
         * tests/time-estimate-negotiation.test.ts C3 直接从 statusTool 输出读
         * deadlineAt/startedAt（字段名/单位照合同原文）。
         */
        startedAt: item.startedAt ?? null,
        deadlineAt: item.deadlineAt ?? null,
        deadlineRemainingMs: Number.isFinite(Number(item.deadlineAt))
            ? Math.max(0, Number(item.deadlineAt) - Date.now())
            : null,
        timeWarning: item.timeWarning ?? null,
        timeJournal: Array.isArray(item.timeJournal) ? item.timeJournal.slice(-10) : [],
        pendingAdjudication: item.pendingAdjudication === true,
        /*
         * [2.2.0][T3/O-2a] 子→主预告通道的结论必须进入模型可读面。
         *
         * 这条能力的目标就是「可观测」：主 Agent 要能一眼看出该子任务的开工预告
         * 有没有真的到达（observed/not-observed）、目标是谁、什么时候、失败原因。
         * 只写状态行不让读，等于又是一个「看不见的失败」。
         */
        noticeChannel: item.noticeChannel ?? null,
    }));
}
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
        // [1.11.0] 结果消息也带上修订号，回放时才知道这份结果属于哪一版计划。
        planRevision: Number(record.planRevision ?? 0),
        /*
         * [1.11.0] C-17：记录级闭环事实随结果消息下发，让摘要里的判定与
         * `deliveryReady` 门禁读同一组输入（否则「结果说完成、present 被拒」）。
         */
        changePending: record.changeRequest?.status === 'pending',
        reportPending: record.reportPending === true,
    });
}
/**
 * [1.8.6] Explain why a `pending` task cannot run, instead of calling it blocked.
 *
 * A single generic sentence made three different situations indistinguishable:
 * a budget pause (nothing ran yet), an upstream whose declared file is missing
 * (the work may well be done), and a genuinely failed upstream. The main Agent
 * read all three as "7 卡住了" and had to re-derive the cause by hand.
 */
function describePendingCause(plan, statuses, id) {
    const byId = new Map(statuses.map((item) => [item.subtaskId, item]));
    const entry = flattenSubtasks(plan).find((candidate) => candidate.subtask.id === id);
    if (!entry)
        return '计划里找不到该步骤';
    const declared = Array.isArray(entry.subtask.dependsOn) ? entry.subtask.dependsOn : [];
    if (declared.length === 0)
        return '没有上游依赖，但本轮未被调度到';
    const bad = declared.filter((dep) => {
        const state = byId.get(dep);
        if (!state || state.status !== 'done')
            return true;
        if (Array.isArray(state.missingArtifacts) && state.missingArtifacts.length > 0)
            return true;
        if (state.verification === 'legacy')
            return true;
        return false;
    });
    if (bad.length === 0)
        return '上游都已就绪，但本轮未被调度到';
    return bad.map((dep) => {
        const state = byId.get(dep);
        if (!state)
            return `上游 ${dep} 缺失`;
        if (state.status !== 'done') {
            return `上游 ${dep} 状态为 ${state.status}${state.error ? `（${String(state.error).slice(0, 80)}）` : ''}`;
        }
        if (Array.isArray(state.missingArtifacts) && state.missingArtifacts.length > 0) {
            return `上游 ${dep} 的声明产物缺失：${state.missingArtifacts.join('、')}`;
        }
        if (state.verification === 'legacy')
            return `上游 ${dep} 完成但未提供结构化证据`;
        return `上游 ${dep} 不可用`;
    }).join('；');
}
export async function dispatchPlan(ctx, record, options) {
    const { agent, signal, modelSelection, cwd, conversationContext = '' } = options;
    const roundBudgetMs = Number(options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
    const deadline = Date.now() + (roundBudgetMs > 0 ? roundBudgetMs : NO_ROUND_BUDGET_MS);
    /*
     * [2.2.0][T3/O-2a] 本轮子→主预告通道的目标会话 id，一轮只解析一次。
     *
     * 宿主只在**非 caller** 投递时把父会话 id 追加进子提示词
     * （dsh-subagent/lib/index.js:1466），本插件用 `delivery: 'caller'` 派发，
     * 所以必须自己注入。解析优先级见 notice-channel.ts（agent.id → session.id），
     * 两级都拿不到就留空，提示词改走「禁止猜测」分支（[2.2.1][T5][F4] 不再用
     * plan.sessionId 兜底：计划正文可能属于另一个 root 会话）。
     */
    const leadNotice = resolveLeadAgentId({ agent, session: options.session });
    /*
     * Resume, do not restart.
     *
     * A blocked plan used to be terminal: every subtask was `blocked`, so
     * `readySubtasks()` returned nothing and the dispatcher broke out having run
     * zero children. Clearing only the failed attempts keeps finished work (and
     * its side effects) while giving the rest a second chance, and the resume
     * budget stops a subtask that always fails from looping forever.
     */
    /*
     * [1.11.0] 重规划 cancel 留下的悬挂下游，在派发前显式收束成 blocked
     * （T4 D-T4-02）。否则它们永远 pending，既不报错也不进入交付阻塞。
     */
    record.statuses = blockCancelledDependents(record.plan, record.statuses);
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
        /*
         * [2.1.0] 格式退回通知必须先抄下来，再重置受阻行。
         *
         * 用户 2026-11-06 的要求是「不符合要求立刻退回，通知其重新检查格式」。
         * `resetBlockedStatuses` 会把受阻行清成待跑（blockedKind / error 一并清掉），
         * 于是 executeSubtask 再也看不到「上一次是格式退回」，退回通知永远送不到
         * 部门人员——退回就只剩状态行上一个记号。这里在重置前把退回原因按子任务
         * 抄进本轮记录，由 executeSubtask 消费并随提示词发回；重置后这条信息仍
         * 生效于下一次激活，消费一次即删，不会污染后续无关重试。
         */
        const rejectedForRedo = [];
        for (const row of Array.isArray(record.statuses) ? record.statuses : []) {
            if (row?.blockedKind === 'comm-format' && typeof row?.error === 'string' && row.error.trim() !== '') {
                rejectedForRedo.push([String(row.subtaskId), row.error]);
            }
        }
        record.statuses = resetBlockedStatuses(record.statuses);
        if (rejectedForRedo.length > 0) {
            record.commFormatRejections = {
                ...(record.commFormatRejections && typeof record.commFormatRejections === 'object' ? record.commFormatRejections : {}),
                ...Object.fromEntries(rejectedForRedo),
            };
        }
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
            /*
             * [1.10.4] 保留自动续跑的审计行：它们必然含「续跑/预算」字样，旧过滤器
             * 会把「为什么自动续跑、停在哪个判定码」一起擦掉，正好毁掉事后取证。
             */
            record.errors = (record.errors ?? [])
                .filter((line) => !/预算|续跑/.test(String(line)) || String(line).includes('[auto-resume]'))
                .slice(-20);
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
        // [2.2.5][热修] 双重保险：即使哨兵值/配置未来被改成超限值，也把延时钳在
        // Node setTimeout 上限之内，杜绝“1ms 触发”的整轮秒杀。
    }, Math.min(Math.max(1000, deadline - Date.now()), ROUND_TIMER_MAX_MS));
    totalTimer.unref?.();
    record.dispatchedAt = Date.now();
    record.phase = 'executing';
    record.updatedAt = record.dispatchedAt;
    try {
        let guard = 0;
        /*
         * [1.8.6] Interrupted tasks are not cascaded.
         *
         * The 2026-10-30 incident: one child was interrupted after it had already
         * written its deliverable; the dispatcher blocked its 6 dependents. Those
         * children were never given a chance, and the plan looked like a 7-task
         * failure. Keep the interrupted task itself `blocked` (its verdict must not
         * be rewritten automatically), but leave dependents `pending` and say why.
         */
        const interruptedIds = new Set();
        while (true) {
            guard += 1;
            if (guard > 200)
                throw new PlanError('调度次数异常', 'DISPATCH_LOOP');
            if (parentSignal.aborted)
                throw abortError();
            if (Date.now() >= deadline)
                throw new PlanError('总执行超时', 'TOTAL_TIMEOUT');
            /*
             * [1.7.0] A `done` upstream only unblocks its dependents when the files it
             * declared actually exist. The check is opt-out (`artifactGate:false`) so
             * an older plan or a debugging session can keep plain status semantics.
             */
            const gate = options.artifactGate !== false;
            const ready = readySubtasks(record.plan, liveStatuses(record.statuses), gate
                ? {
                    /*
                     * [1.11.0] 未验收的 done 不再解锁下游（T5 C5 / T8 S1-05）。
                     *
                     * `done` 只说明子 Agent 交了东西；`unverified`/`failed` 说明
                     * 交付内容没有通过验收。让下游在这时开跑，等于把未验证的结论
                     * 当上游契约使用——跨部门链条会一路放大错误。legacy（旧日志）
                     * 与 structured 仍放行，避免历史计划整体卡死。
                     */
                    dependencyOk: (dependency) => dependency?.status === 'done'
                        && dependency?.verification !== 'unverified'
                        && dependency?.verification !== 'failed'
                        && !(Array.isArray(dependency?.missingArtifacts) && dependency.missingArtifacts.length > 0),
                }
                : {});
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
                const pending = liveStatuses(record.statuses).filter((item) => item.status === 'pending');
                if (pending.length > 0) {
                    const reasons = pending.map((item) => `${item.subtaskId}：${describePendingCause(record.plan, record.statuses, item.subtaskId)}`);
                    const message = `本轮结束，仍有 ${pending.length} 项保持 pending（不是失败，也未级联成 blocked）：${reasons.slice(0, 6).join('；')}`;
                    record.error = message;
                    record.errors = [...(record.errors ?? []), message].slice(-20);
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
                const outcome = await runSubtask(ctx, record, entry.stage, entry.subtask, {
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
                    // [1.10.6] Injectable stat for the pre-retry fingerprint check; tests
                    // use it so the conflict branch is provable without real files.
                    artifactStat: options.artifactStat,
                    // [2.2.0][T6/O-1a] 即时通知接线：后台轮次标记、主会话与完成回调透传到结算点。
                    notifyCompletion: options.notifyCompletion === true,
                    session: options.session,
                    // [2.2.0][T3/O-2a] 子→主预告通道：目标 id 与其来源随派发一起下传，
                    // 提示词注入与结算观测必须用同一个值（否则「注入了什么」与
                    // 「观测的是谁」会分叉，通道永远对不上）。
                    leadAgentId: leadNotice.id,
                    leadAgentIdSource: leadNotice.source,
                    onSubtaskDone: options.onSubtaskDone,
                });
                // [1.8.6] Remember which failures were interrupts, so the cascade below
                // can leave their dependents pending instead of blaming them.
                if (outcome && outcome.interrupted)
                    interruptedIds.add(item.id);
            });
            const blocked = record.statuses
                .filter((item) => item.status === 'blocked')
                .map((item) => item.subtaskId);
            for (const id of blocked) {
                /*
                 * Carry the actual cause downstream. The main Agent used to receive
                 * "上游子任务受阻: T2" with no reason and no missing artifacts, so it
                 * had to re-read the whole plan to guess what to repair.
                 */
                const upstream = record.statuses.find((item) => item.subtaskId === id);
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
                        `${id}: 被中断但产物已核对（见 artifacts），未自动级联下游；请据实改判或续跑`].slice(-20);
                    continue;
                }
                const cause = upstream
                    ? {
                        reason: upstream.error,
                        missingArtifacts: Array.isArray(upstream.missingArtifacts) ? upstream.missingArtifacts : [],
                    }
                    : null;
                record.statuses = markDependentsBlocked(record.plan, record.statuses, id, cause);
            }
            /*
             * No stats refresh here any more: `serialisePlan` derives the counts from
             * exactly the list it ships, so a cache can no longer lag behind the work.
             */
            record.updatedAt = Date.now();
        }
        /*
         * [1.8.6] Do not let a pending tail masquerade as a failure.
         *
         * `planPhase` turns any `blocked` row into `blocked`; with D8's fix a round
         * can end with real blocked rows *and* untouched pending rows. Keep
         * `blocked` for real failures, and report `paused` when only pending work
         * is left, so a resume is not billed against the failure budget.
         */
        const hasBlocked = liveStatuses(record.statuses).some((item) => item.status === 'blocked');
        const hasPending = liveStatuses(record.statuses).some((item) => item.status === 'pending');
        record.phase = hasBlocked ? 'blocked' : (hasPending ? 'paused' : planPhase(record.statuses));
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
                /*
                 * [1.12.0] 预算到点不是这三类行的「尝试被打断」（T11）：
                 *
                 *  - `escalated`：正在等用户/主 Agent 拍板。pending 分支会清空
                 *    question/options/blockedKind，于是请示被静默吞掉、计划变回 paused，
                 *    自动续跑再把它当普通 pending 重派一次。
                 *  - `instructed`：指示已投递给子会话，该子会话可能仍在写。重置成
                 *    pending 根本不在 `CLOSURE_TRANSITIONS.instructed` 里，会抛
                 *    INVALID_TRANSITION —— 而这里位于 catch 内部，异常会让 phase、
                 *    结果消息与自动续跑排期全部不落。
                 *  - `replanned`：终态旧行，只为追溯保留（没有出边），同样会抛。
                 *
                 * 三者保留原状由后续人工/子会话推进；真正被预算打断的行照常回到 pending。
                 */
                if (item.closure === 'escalated' || item.closure === 'instructed' || item.closure === 'replanned')
                    continue;
                // [1.8.19] Carry the aborted attempt's provenance and landed files into
                // the pause reason instead of silently erasing them.
                const definition = findSubtaskById(record.plan, item.subtaskId);
                reset = applyStatus(reset, item.subtaskId, {
                    status: 'pending',
                    error: budgetResetError(item, definition, options.cwd, options.artifactExists),
                });
            }
            record.statuses = reset;
            /*
             * 按 live 行（排除 replanned）统计：一条只为追溯保留的旧行既不算完成，
             * 也不算「保留为未完成」，否则文案会说「12/13，其余 1 项未完成」——
             * 而那 1 项永远不会再跑。
             */
            const live = liveStatuses(record.statuses);
            const total = live.length;
            const done = live.filter((item) => item.status === 'done').length;
            const pendingNow = live.filter((item) => item.status === 'pending').length;
            const blockedNow = live.filter((item) => item.status === 'blocked').length;
            /*
             * [1.5.2] 预算到点 ≠ 一定是「暂停」。
             *
             * 旧代码在这里无条件 `record.phase = 'paused'`：如果最后一个子任务恰好在
             * 截止时刻之后完成（done === total），计划会以 14/14、progress=100 的载荷
             * 带着 paused 返回，界面就是「100% + 预算用完，可续跑」（T5 C4）。
             * 全部完成时直接进终态，并且不再写「其余 0 项保留为未完成」这种自相矛盾的说明。
             */
            const allDoneNow = total > 0 && done === total;
            /*
             * [1.12.0] 与普通轮末同一判据（T11）：只要有仍 live 的 blocked 行，
             * 阶段就是 blocked —— 其中可能包含一条保留下来的「待指示」。写成 paused
             * 会让卡片显示「预算用完、可续跑」，而真正该做的是 instruct。
             */
            record.phase = allDoneNow ? 'done' : (blockedNow > 0 ? 'blocked' : 'paused');
            const roundBudgetMs = Number(options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
            const minutes = roundBudgetMs > 0 ? Math.max(1, Math.round(roundBudgetMs / 60000)) : 0;
            const roundLabel = minutes > 0 ? `本轮执行预算（${minutes} 分钟）` : '本轮无固定总预算';
            record.error = allDoneNow
                ? null
                : blockedNow > 0
                    ? `${roundLabel}已到：已完成 ${done}/${total}；${blockedNow} 项在等待指示或已受阻（续跑不会重派，请先 instruct 或改判），${pendingNow} 项保留为未完成，再次派发本计划即可继续`
                    : `${roundLabel}已到：已完成 ${done}/${total}，其余 ${total - done} 项保留为未完成，再次派发本计划即可续跑（已完成的不重跑）`;
            /*
             * Drop the failure lines the aborted children wrote on their way out.
             * They used to survive into the result payload as
             * `["T4: 总执行超时", "总执行超时", …]`, so the model read a failure
             * report for subtasks that were explicitly *not* failures.
             */
            record.errors = (record.errors ?? []).filter((line) => !/总执行超时/.test(String(line)));
            if (!allDoneNow)
                record.errors = [...(record.errors ?? []), record.error].slice(-20);
        }
        else {
            /*
             * `blocked` is a terminal state, so it always reports progress 100 — the
             * same rule the other four blocked writers follow. Carrying the partial
             * number over (`item.progress ?? 0`) made one failure show up as 0 %, 15 %
             * or 100 % depending on which branch happened to write it.
             */
            record.statuses = record.statuses.map((item) => {
                // [1.11.0] 被重规划的行不参与「失败收敛」：它们本来就是闭态旧行。
                if (item.closure === 'replanned')
                    return item;
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
const TURN_BOUNDARY_SCAN = 200;
export function sessionTurnState(session) {
    const total = Number(session?.seq);
    if (!Number.isFinite(total) || total <= 0 || typeof session?.eventAt !== 'function') {
        return { state: 'unknown', reason: null, reasonDetail: null, at: null };
    }
    const floor = Math.max(0, Math.floor(total) - TURN_BOUNDARY_SCAN);
    for (let seq = Math.floor(total) - 1; seq >= floor; seq -= 1) {
        let event;
        try {
            event = session.eventAt(seq);
        }
        catch {
            return { state: 'unknown', reason: null, reasonDetail: null, at: null };
        }
        if (!event)
            continue;
        if (event.type === 'turn/start')
            return { state: 'open', reason: null, reasonDetail: null, at: null };
        if (event.type === 'turn/end') {
            const reason = event.data?.reason ?? null;
            const detail = reason && reason.kind === 'aborted' ? (reason.reason?.kind ?? null) : null;
            const at = Number(event.time);
            return {
                state: 'ended',
                reason: typeof reason?.kind === 'string' ? reason.kind : 'completed',
                reasonDetail: typeof detail === 'string' ? detail : null,
                at: Number.isFinite(at) ? at : null,
            };
        }
    }
    return { state: 'unknown', reason: null, reasonDetail: null, at: null };
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
const STALE_INFLIGHT_NOTE = '本轮结束时这一步仍未完成，没有拿到结果；可以续跑。';
function settleStaleInflight(raw) {
    const list = Array.isArray(raw) ? raw : [];
    if (!list.some((item) => item?.status === 'in_progress'))
        return raw;
    return list.map((item) => item?.status === 'in_progress'
        ? {
            ...item,
            status: 'blocked',
            error: typeof item.error === 'string' && item.error.trim() !== '' ? item.error : STALE_INFLIGHT_NOTE,
        }
        : item);
}
function serialisePlan(record, session) {
    const plan = record.plan ?? null;
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
    const liveDispatch = Boolean(record.dispatchPromise);
    const turn = liveDispatch ? null : sessionTurnState(session);
    const turnEnded = turn?.state === 'ended';
    /*
     * Counts are derived here, once, from the very array that is shipped.
     *
     * `stats` used to be read from `record.stats`, a cache refreshed only between
     * dispatch batches, while `departments` below was aggregated live. The same
     * payload could therefore report “0 正在做” in the header while a stage badge
     * built from `statuses` said otherwise. Deriving both from one normalised
     * snapshot makes that contradiction structurally impossible.
     */
    const rawStatuses = Array.isArray(record.statuses) && record.statuses.length > 0
        ? record.statuses
        : plan
            ? createStatuses(plan)
            : [];
    /*
     * [1.10.0] 分母来自计划定义，并允许「明细行少于定义」时按 pending 补齐。
     * `definedSubtaskCount` 对畸形计划返回 MAX_SAFE_INTEGER，那种情况下退回
     * 「只数明细行」，避免把一个坏计划直接判成 0/天文数字。
     */
    const defined = plan ? definedSubtaskCount(plan) : 0;
    const expectedTotal = Number.isFinite(defined) && defined > 0 && defined < Number.MAX_SAFE_INTEGER
        ? defined
        : undefined;
    const snapshot = derivePlanSnapshot(turnEnded ? settleStaleInflight(rawStatuses) : rawStatuses, expectedTotal);
    const statuses = snapshot.statuses;
    const stats = snapshot.stats;
    /*
     * [1.5.2] 出口对账，而不是无条件相信内存缓存。
     *
     * 旧写法 `record.phase ?? planPhase(statuses)` 让缓存一旦存在就完全绕过
     * statuses：一次 `updateStatus` 把计划写成 integrating 之后，即使 14/14 全部
     * 完成，下发的 phase 仍是 integrating，界面于是「100% + 正在收尾」。这里改成
     * `reconcilePhase`：全部完成一律 done，缓存过期的 done/integrating 回退到派生值。
     */
    let phase = reconcilePhase(record.phase ?? (plan ? planPhase(statuses) : 'degraded'), statuses);
    if (phase === 'pending' && !record.dispatchedAt && plan?.createdAt && Date.now() - plan.createdAt > STALE_PENDING_MS) {
        phase = 'cancelled';
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
    let suspendedPhase = null;
    let endReason = null;
    let endReasonDetail = null;
    let endedAt = null;
    if (turnEnded && phase !== 'done' && phase !== 'cancelled') {
        suspendedPhase = phase;
        endReason = turn.reason;
        endReasonDetail = turn.reasonDetail;
        endedAt = turn.at;
        phase = 'ended';
    }
    /*
     * 每次真正下发前跑一遍跨字段不变量（I1–I11）。正常情况下恒为空；一旦某个
     * 未来改动重新引入「进度与状态打架」，这里会把它连同具体字段值一起带出去，
     * 而不是等用户截图发现。附在 payload 上而不是抛错：展示层不应因自检而白屏。
     */
    const violations = aggregateInvariantViolations(snapshot, phase);
    const readiness = readinessOf(record, snapshot);
    return {
        sessionId: session.id,
        planId: record.planId ?? plan?.planId ?? null,
        title: plan?.title ?? record.title ?? '任务进度',
        phase,
        ...(phase === 'ended' ? { suspendedPhase, endReason, endReasonDetail, endedAt } : {}),
        ...(violations.length ? { violations } : {}),
        degraded: record.degraded === true,
        error: record.error ? truncate(record.error, 2000) : null,
        /*
         * [1.10.0] C-18：「已结束 / 已完成」的计划不再把上一轮的失败文本摆在首页。
         *
         * 1.9.1 把 `record.errors`（"本轮执行预算已到：已完成 9/13…" 之类）无条件
         * 下发，界面又无条件渲染，于是 13/13 完成的那一帧下面还挂着一句「这件事没有
         * 做完」。现在：计划已 done 或 cancelled 时，这批文本改挂 `archivedErrors`，
         * 供折叠区/审计使用；`errors` 只在计划仍需处理时下发。
         */
        errors: phase === 'done' || phase === 'cancelled' ? [] : (record.errors ?? []).slice(-20),
        ...(phase === 'done' || phase === 'cancelled'
            ? { archivedErrors: (record.errors ?? []).slice(-20) }
            : {}),
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
         * [1.11.0] 重规划与回报状态随载荷下发（T7 C-15）。
         *
         * `planRevision` 让界面能显示「第 N 次修订」；`changeRequest` 是执行中
         * 收到、尚未重规划的用户变更；`reportPending` 表示完成结果还没成功回报。
         * 三者都来自 record 的同一份事实，不另建缓存。
         */
        planRevision: Number(record.planRevision ?? 0),
        changeRequest: record.changeRequest ?? null,
        reportPending: record.reportPending === true,
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
    /*
     * [1.8.10] 回放窗口必须包含目标计划的定义。
     *
     * 会话事件超过 MAX_HISTORY_EVENTS（2000）后，窗口起点会越过早期的 plan
     * 消息。此时按 planId 重建旧计划得到 null，dispatch / status 都会退回
     * 内存里那个更新的计划，旧计划在卡片上消失，也无法再续跑。
     * 显式指定 planId 时向前扫到该计划的 plan 消息，把窗口起点前移。
     */
    let start = Math.max(0, session.seq - MAX_HISTORY_EVENTS);
    if (targetPlanId) {
        for (let seq = start - 1; seq >= 0; seq -= 1) {
            let event;
            try {
                event = session.eventAt(seq);
            }
            catch {
                continue;
            }
            if (!event || event.type !== 'user/message')
                continue;
            const payload = parseWorkplanMessage(event.data);
            if (payload?.plan?.planId === targetPlanId) {
                start = seq;
                break;
            }
        }
    }
    /*
     * [1.8.15] Default replay keeps the "last defined plan" contract, but it
     * must still find that plan when its message predates the 2000-event window.
     *
     * T3 B4 measured the window failure on 1.8.14: on a >2000-event session the
     * window started after the plan message, the default replay returned null,
     * and `present` had no plan to judge — the delivery was silently allowed.
     * The scan reads backwards for the last `workplan` definition and moves the
     * window start to it.
     *
     * The "newest activity" variant was deliberately NOT adopted: the same
     * default answer also feeds `dispatch`, so an older plan that merely kept
     * receiving result/update messages would hijack a new task's default
     * dispatch target (the reason N5 in 1.8.14 left the contract alone). The
     * turn-scoped fixes (`planIdFromTurn`, the present gate) name the plan
     * explicitly instead of changing the default.
     */
    let defaultPlanId = null;
    if (!targetPlanId) {
        for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
            let event;
            try {
                event = session.eventAt(seq);
            }
            catch {
                continue;
            }
            if (!event || event.type !== 'user/message')
                continue;
            const planMessage = parseWorkplanMessage(event.data);
            const planId = planMessage?.plan?.planId;
            if (typeof planId !== 'string' || planId === '')
                continue;
            defaultPlanId = planId;
            let planStart = seq;
            for (let back = seq - 1; back >= 0; back -= 1) {
                let prior;
                try {
                    prior = session.eventAt(back);
                }
                catch {
                    continue;
                }
                if (!prior || prior.type !== 'user/message')
                    continue;
                if (parseWorkplanMessage(prior.data)?.plan?.planId === planId)
                    planStart = back;
            }
            if (planStart < start)
                start = planStart;
            break;
        }
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
    const snapshots = new Map();
    let currentId = null;
    let degraded = null;
    const ensure = (plan) => {
        let snap = snapshots.get(plan.planId);
        if (!snap) {
            snap = {
                plan,
                statuses: createStatuses(plan),
                resultPhase: '',
                resultSeen: false,
                resumeCount: 0,
                cancelled: false,
                superseded: false,
                supersededBy: undefined,
                errors: [],
                planRevision: Number(plan?.planRevision ?? 0) || 0,
                changeRequest: null,
            };
            snapshots.set(plan.planId, snap);
        }
        currentId = plan.planId;
        return snap;
    };
    /** [1.6.0] callId → 待确认的 update 写入；只有配对的 tool/result 才能定案。 */
    const pendingToolCalls = new Map();
    /**
     * [1.8.11] 已经由 durable `workplan-update` 消息应用过的人工改判。
     *
     * 一次 `dsh_workplan_update` 会写两份记录：一条 durable 用户消息（带
     * revision 与 updatedBy=agent）和一条 tool/result。回放原来两份都应用，
     * 第二次以 system 身份把 revision 再抬一级并覆盖 summary——人工改判的
     * 证据后缀就这么丢了。这里记下消息的 seq，配对的 tool/result 不再重复写。
     */
    const appliedUpdates = new Map();
    const updateKey = (planId, subtaskId) => `${planId}\u0000${subtaskId}`;
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
                currentId = null;
            }
            else if (payload?.plan) {
                ensure(payload.plan);
            }
            /*
             * Every result message is routed by its own planId. A result that arrives
             * after a newer plan was generated must still update the plan it names —
             * that was the 13/14 → 5/14 replay regression. A plan never inherits
             * another plan's round phase or resume counter (each snapshot owns them).
             */
            /*
             * [1.11.0] 重规划记录：采用 durable 消息里的完整修订计划，不重新推导。
             * 旧行在同一份 plan 里带 supersededAt，状态条目同步标 closure='replanned'。
             */
            const replan = parseReplanMessage(event.data);
            if (replan && typeof replan.planId === 'string') {
                const snap = snapshots.get(replan.planId);
                if (snap) {
                    snap.plan = replan.plan;
                    snap.planRevision = Number(replan.revision) || snap.planRevision;
                    snap.statuses = applyReplanStatuses(snap.statuses, replan);
                    if (snap.changeRequest && snap.changeRequest.status !== 'replanned') {
                        snap.changeRequest = {
                            ...snap.changeRequest,
                            status: 'replanned',
                            replannedAt: replan.at,
                            planRevision: snap.planRevision,
                        };
                    }
                }
            }
            /*
             * [1.11.0] 执行中收到的变更：恢复成 changeRequest，刷新后仍然可见、
             * 仍然阻止“静默收尾”。
             */
            const change = parseChangeRequestMessage(event.data);
            if (change && typeof change.planId === 'string') {
                const snap = snapshots.get(change.planId);
                if (snap) {
                    snap.changeRequest = {
                        seq: change.seq,
                        text: change.text,
                        at: change.at,
                        turn: change.turn,
                        status: 'pending',
                    };
                }
            }
            const result = parseResultMessage(event.data);
            if (result && typeof result.planId === 'string') {
                const snap = snapshots.get(result.planId);
                if (snap) {
                    snap.statuses = applyResultStatuses(snap.statuses, result);
                    /*
                     * [2.2.0][T4/O-3b][E] 重建白名单（E 项，runtime 侧）：applyResultStatuses
                     * （src/plan.ts，T3 领地）逐字段重建不含柔性时长协商新字段，会把
                     * deadlineAt/timeNotice/timeWarning/timeJournal/待裁决标记洗掉；结果消息
                     * 整包透传行对象（字段在 entry 上），按 T3b plan.ts:2966-2971 同名修复
                     * 口径补直写回放。
                     */
                    for (const entry of (Array.isArray(result.statuses) ? result.statuses : [])) {
                        const rebuiltRow = snap.statuses.find((item) => item?.subtaskId === entry?.subtaskId);
                        if (!rebuiltRow || !isRecord(entry))
                            continue;
                        for (const field of ['deadlineAt', 'timeNotice', 'timeWarning', 'timeJournal', 'pendingAdjudication']) {
                            if (entry[field] !== undefined)
                                rebuiltRow[field] = entry[field];
                        }
                        /*
                         * [2.2.0][T3/O-2a][F1] 通道结论也必须活过进程重启。
                         * applyResultStatuses 已带该字段；这里再走一次校验，防止旧日志/
                         * 未来字段来源把脏值直接拷进重建行（fail-closed）。
                         *
                         * [2.2.1][T5][F1] 非法值必须 `delete` 而不是写 `null`：写 null 会让
                         * 脏字段跨每次重启自我延续（下一次回放又把整行丢掉，done 行永远显示
                         * pending）。删除等价于「该结果消息没带这个字段」，合法值不受影响。
                         */
                        if (entry.noticeChannel !== undefined) {
                            const checked = validateNoticeChannel(entry.noticeChannel);
                            if (checked.ok)
                                rebuiltRow.noticeChannel = checked.value;
                            else
                                delete rebuiltRow.noticeChannel;
                        }
                    }
                    // Resume bookkeeping must survive a page refresh, otherwise the budget
                    // silently resets and a never-succeeding subtask can loop forever.
                    snap.resumeCount = Number(result.resumeCount ?? snap.resumeCount) || 0;
                    snap.resultPhase = typeof result.phase === 'string' ? result.phase : '';
                    snap.resultSeen = true;
                    // [1.8.17] Keep the durable failure lines so a replayed record is
                    // shaped like a live one (never `undefined`).
                    if (Array.isArray(result.errors)) {
                        snap.errors = snap.errors.concat(result.errors.map((line) => String(line))).slice(-20);
                    }
                    /*
                     * [1.8.14] A cancel that lands while a dispatch is in flight writes no
                     * separate cancel message (it aborts the dispatch instead), so the
                     * only durable trace of that cancellation is `phase: 'cancelled'` in
                     * the round result. Without this the plan reopens as "executing"
                     * after a restart — the cancel is silently lost.
                     */
                    if (snap.resultPhase === 'cancelled')
                        snap.cancelled = true;
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
            const update = parseUpdateMessage(event.data);
            if (update && typeof update.planId === 'string' && typeof update.subtaskId === 'string') {
                const snap = snapshots.get(update.planId);
                if (snap) {
                    try {
                        snap.statuses = applyStatus(snap.statuses, update.subtaskId, {
                            /*
                             * handoff 的 durable 记录携带的是状态快照，不是一次状态迁移。
                             * 重放时若再走 done 分支，会把已经 reported 的行打回 done 并抛
                             * INVALID_TRANSITION（wp-79c31abf 的 H1 就是这样被丢掉的）。
                             */
                            status: update.handoffs === undefined ? update.status : undefined,
                            /*
                             * [2.2.6][D-1] 人工改判的 closure 必须随 patch 回放。
                             *
                             * durable 的 workplan-update 自 1.11.0 起携带 closure
                             * （buildUpdateMessage），但这里的 patch 一直没把它传给
                             * applyStatus：行停在 escalated 时，status=done 的改判会因
                             * 「非法闭环迁移 escalated→done / closure=escalated 必须同时
                             * status=blocked」被拒，整条 update 被下面的裸 catch 吞掉，
                             * 重启后「待指示」行永久卡死（2026-11-08 wp-3c8c84b2 T2 实证，
                             * 见 artifacts/2.2.5-post-restart-regression.md §4 D-1）。
                             */
                            closure: typeof update.closure === 'string' ? update.closure : undefined,
                            progress: typeof update.progress === 'number' ? update.progress : undefined,
                            summary: typeof update.note === 'string' ? update.note : undefined,
                            // [1.8.13] Evidence written through the update tool must survive replay.
                            verification: update.verification,
                            acceptance: update.acceptance,
                            artifacts: update.artifacts,
                            missingArtifacts: update.missingArtifacts,
                            handoffs: update.handoffs,
                            revision: Number.isInteger(update.revision) ? update.revision : undefined,
                            // [2.2.0][T4/O-3b][E] 回放白名单（T3b TODO#2）：O-3b/O-2c 留档字段随
                            // update 记录回放；timeoutMs 有 applyStatus 分支，走 patch 即可。
                            timeoutMs: update.timeoutMs,
                            updatedBy: 'agent',
                        });
                        /*
                         * [2.2.0][T4/O-3b][E] 柔性时长协商新字段回放（E 项，runtime.ts 2931 一带）。
                         *
                         * deadlineAt/timeNotice/timeWarning/timeJournal/待裁决标记在 applyStatus
                         * （src/plan.ts，T3 领地）无路由分支，走 patch 会被静默丢弃；按 T3b
                         * plan.ts:2966-2971 同名修复口径在此直写重建行。extendMs 走累加语义
                         * （与线上 extendDeadline 一致：deadlineAt += extendMs 并追加 timeJournal），
                         * 仅当记录未自带 timeJournal 时合成，避免同一条 journal 被回放两次。
                         */
                        const replayRow = snap.statuses.find((item) => item?.subtaskId === update.subtaskId);
                        if (replayRow) {
                            for (const field of ['deadlineAt', 'timeNotice', 'timeWarning', 'timeJournal', 'pendingAdjudication']) {
                                if (update[field] !== undefined)
                                    replayRow[field] = update[field];
                            }
                            const replayExtend = Number(update.extendMs);
                            if (update.timeJournal === undefined && Number.isFinite(replayExtend) && replayExtend > 0
                                && Number.isFinite(Number(replayRow.deadlineAt))) {
                                replayRow.deadlineAt = Number(replayRow.deadlineAt) + Math.floor(replayExtend);
                                replayRow.timeJournal = [
                                    ...(Array.isArray(replayRow.timeJournal) ? replayRow.timeJournal : []),
                                    {
                                        at: Date.now(),
                                        action: 'extend',
                                        extendMs: Math.floor(replayExtend),
                                        by: 'agent',
                                        reason: truncate(String(update.reason ?? ''), 300),
                                    },
                                ].slice(-20);
                            }
                        }
                        appliedUpdates.set(updateKey(update.planId, update.subtaskId), {
                            seq: Number(event.seq ?? 0),
                            status: String(update.status ?? ''),
                        });
                    }
                    catch (error) {
                        /*
                         * [2.2.6][D-1] fail-closed 而非 fail-silent：历史 update 不合法时
                         * 至少留一条日志，否则「改判丢失」永远无从发现（本缺陷因此潜伏
                         * 自 1.7.0）。回放继续，不让单条坏记录拖垮整个重建。
                         */
                        console.warn('[dsh-workplan] 回放忽略一条不合法的历史改判：'
                            + `${String(update?.planId ?? '')}/${String(update?.subtaskId ?? '')}：`
                            + `${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
            const cancel = parseCancelMessage(event.data);
            if (cancel && typeof cancel.planId === 'string') {
                const snap = snapshots.get(cancel.planId);
                if (snap) {
                    /*
                     * [1.9.0] disposition='superseded' 的信封表示「责任已转移」，不是
                     * 用户撤销。旧解析器只校验 kind，因此该字段对新旧版本都安全：旧版
                     * 按 cancelled 读（不可派发、不可交付），不会复活成 active。
                     */
                    if (cancel.disposition === 'superseded') {
                        snap.superseded = true;
                        snap.supersededBy = cancel.supersededBy;
                        /*
                         * [1.9.2] 互斥（T6）：取代永远发生在取消之后，所以日志里两条信封
                         * 都在。只加 superseded 不清 cancelled，冷启动记录就会变成「既已
                         * 取消、又被取代」，与 live 记录（`supersedePlanRecord` 写入时
                         * 把 cancelled 置 false）分叉 —— 这正是写侧收敛要杜绝的那类分叉。
                         */
                        snap.cancelled = false;
                    }
                    else {
                        snap.cancelled = true;
                    }
                }
            }
        }
        else if (event.type === 'tool/call') {
            /*
             * [1.6.0] 只登记，不下结论。
             *
             * 回放原来一见到 `dsh_workplan_update` 的调用就 applyStatus，但调用发起不等于
             * 状态写入成功：宿主的 tool/result 带着 `message.isError`。会话
             * session-7129faea 里就有一次失败的 update 被回放记成完成，于是刷新后面板显示
             * 7/12，而真实只完成 6/12 —— 回放比实时“更乐观”，这是第二个数据源打架点。
             * 现在一律等对应的 tool/result：成功才采纳，失败或没有结果都不采纳。
             */
            const data = event.data;
            if (data?.name === 'dsh_workplan_update' && typeof data.callId === 'string') {
                const args = readToolArguments(data.arguments);
                if (args && typeof args.subtaskId === 'string' && typeof args.status === 'string') {
                    const planId = typeof args.planId === 'string' ? args.planId : currentId;
                    if (planId)
                        pendingToolCalls.set(data.callId, { args, planId, callSeq: Number(event.seq ?? 0) });
                }
            }
        }
        else if (event.type === 'tool/result') {
            const message = event.data?.message;
            const callId = message?.role === 'tool' ? message.toolCallId : null;
            if (typeof callId !== 'string')
                continue;
            const pending = pendingToolCalls.get(callId);
            pendingToolCalls.delete(callId);
            const snap = pending && typeof pending.planId === 'string' ? snapshots.get(pending.planId) : null;
            if (!snap) {
                // 结果晚于新计划到达：旧计划的写入不污染新计划的状态表。
            }
            else if (message.isError === true) {
                // 失败的更新不是完成：状态表保持原样。
            }
            else {
                const args = pending.args;
                /*
                 * [1.8.11] 同一次改判已经由 durable 消息应用过时，配对结果不再写第二遍。
                 * 判据是 seq 与状态都一致：durable 消息在本次调用之后到达且状态相同，
                 * 才说明它是这次调用的记录；更早/更晚的人工改判仍按自己的顺序生效。
                 */
                const applied = appliedUpdates.get(updateKey(pending.planId, args.subtaskId));
                const alreadyDurable = Boolean(applied)
                    && applied.seq > Number(pending.callSeq ?? 0)
                    && applied.status === String(args.status ?? '');
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
                        });
                    }
                    catch {
                        // An invalid historical call is ignored; the live cache remains authoritative.
                    }
                }
            }
        }
    }
    /*
     * [1.8.15] Prefer the explicitly named plan, then the plan that owns the
     * newest activity, then the last definition seen in the replay window.
     */
    const chosenId = targetPlanId ?? defaultPlanId ?? currentId;
    let chosen = chosenId ? snapshots.get(chosenId) ?? null : null;
    if (!chosen && currentId)
        chosen = snapshots.get(currentId) ?? null;
    if (!chosen) {
        if (!degraded)
            return null;
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
    const plan = chosen.plan;
    const statuses = chosen.statuses;
    const resultPhase = chosen.resultPhase;
    const resultSeen = chosen.resultSeen;
    const resumeCount = chosen.resumeCount;
    const superseded = chosen.superseded;
    /*
     * [1.9.2] 终态互斥（T6）：superseded 与 cancelled 不会同时成立。手写/旧版
     * 日志里可能出现「supersede 信封之后又有一条取消信封」，此时按终态优先级
     * 只认 superseded（fail-closed：被取代依然不可派发、不可交付）。
     */
    const cancelled = chosen.cancelled && !superseded;
    let phase = planPhase(statuses, resultSeen);
    if (resultPhase === 'paused' && statuses.some((item) => item.status !== 'done'))
        phase = 'paused';
    if (cancelled)
        phase = 'cancelled';
    if (superseded)
        phase = 'superseded';
    /*
     * [1.5.2] 回放也必须走同一套对账。
     *
     * 回放曾经因为 `resultSeen=true`（结果消息在会话里）得到 done，而同一时刻的
     * 实时缓存因为没有这个副作用得到 integrating —— 同一个会话刷新前后翻转。
     * `reconcilePhase` 让两条链路都以 statuses 为准：全部完成即 done（包括历史上
     * 「先完成、后收到取消消息」的会话，不再出现「100% + 已取消」）。
     */
    phase = reconcilePhase(phase, statuses);
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
        /*
         * [1.8.17] A reconstructed record must carry every field the live dispatch
         * path spreads/pushes unconditionally. `errors` was the one that was
         * missing; its absence turned a recoverable child failure into a round
         * abort that marked the rest of the plan blocked.
         */
        errors: (chosen.errors ?? []).slice(-20),
        resumeLimit: MAX_PLAN_RESUMES,
        resumeAvailable: canResumePlan({ phase, statuses, resumeCount }, MAX_PLAN_RESUMES).resume,
        stale: stalePending,
        /*
         * [1.8.14] Two facts, one from the log: whether the plan is cancelled and
         * whether that cancellation is durably recorded. For replay they are the
         * same; the live `cancelPlan` uses `cancelRecorded` to make a second
         * cancel a no-op instead of appending a duplicate message (N8).
         *
         * [1.9.2] 被取代的计划同样有一条已落盘的终态记录（V3 要求先取消才允许
         * 取代），因此 cancelRecorded 在 superseded 时为 true —— 与 live 记录一致
         * （`supersedePlanRecord` 保留先前的 cancelRecorded）。`supersedeRecorded`
         * 是取代信封的写入见证，补齐后普通取消的拒绝体在冷启动/热路径上字段相同。
         */
        cancelled,
        cancelRecorded: cancelled || superseded,
        superseded,
        supersedeRecorded: superseded,
        supersededBy: superseded ? chosen.supersededBy : undefined,
        /*
         * [1.11.0] 回放也恢复修订号与未处理变更。`reportPending` 由状态本身派生：
         * 存在 done 行却没到 reported，说明当时的结果消息没有成功写进会话。
         */
        planRevision: chosen.planRevision,
        changeRequest: chosen.changeRequest,
        /*
         * [1.11.0] 只把「本轮完成、还没回报」算作待回报：`closure:'done'` 是
         * 1.11.0 的显式中间态。旧日志的 done 行没有 closure（null），它本来就
         * 已经通过结果消息回报过，若用 `!== 'reported'` 判定，升级后每一份
         * 1.10.6 的历史计划都会被判成「未回报」而永久不可交付。
         */
        reportPending: statuses.some((item) => item?.status === 'done' && item?.closure === 'done'),
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
/**
 * Fixed hardening headers for every response this plugin serves.
 *
 * Two routes are exposed to the DSH web server: the JSON plan feed and the
 * vendored Chart.js file. Neither needs the browser to sniff a type, and a
 * dashboard URL carries a session id, so it must not leak through `Referer`
 * to anything the user clicks afterwards. Set once per response, before any
 * `writeHead`, so a later `writeHead(status, headers)` cannot drop them.
 */
export const HARDENING_HEADERS = Object.freeze({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
});
export function applyHardeningHeaders(res) {
    if (typeof res?.setHeader !== 'function')
        return;
    for (const [name, value] of Object.entries(HARDENING_HEADERS)) {
        res.setHeader(name, value);
    }
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
    /*
     * `activeTurns` maps a root session to the turn whose user message carried a
     * real task; the `agent/turn-stopping` gate only objects on those turns.
     */
    const state = { records: new Map(), activeTurns: new Map() };
    /*
     * Resolve the tunables once, at construction, so every code path (dispatch,
     * resume, cancel, the host's tool timeout) agrees on the same numbers.
     */
    const pluginVersion = typeof options.version === 'string' && options.version ? options.version : 'unknown';
    /*
     * [1.12.3] fail-closed 解析：显式值优先；'auto' 只在 headless 运行中生效。
     * `ctx.get` 在普通对象（测试）上不存在，可选链保证降级为「非 headless」。
     */
    const failClosedMode = options.failClosedOnIncomplete ?? 'auto';
    const headlessRun = (() => {
        try {
            return ctx?.get?.('headlessStartup') !== undefined;
        }
        catch {
            return false;
        }
    })();
    const failClosedActive = failClosedMode === true || (failClosedMode === 'auto' && headlessRun);
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
            ? Number(options.build.pid)
            : process.pid,
        startedAt: Number.isFinite(Number(options.build?.startedAt)) && Number(options.build?.startedAt) > 0
            ? Number(options.build.startedAt)
            : Math.round(Date.now() - process.uptime() * 1000),
        entryPath: typeof options.build?.entryPath === 'string' && options.build.entryPath
            ? options.build.entryPath
            : '',
        buildHash: typeof options.build?.buildHash === 'string' && options.build.buildHash
            ? options.build.buildHash
            : 'unknown',
    };
    function runtimeIdentity() {
        return {
            version: pluginVersion,
            pid: buildInfo.pid,
            startedAt: buildInfo.startedAt,
            uptimeMs: Math.max(0, Date.now() - buildInfo.startedAt),
            entryPath: buildInfo.entryPath,
            buildHash: buildInfo.buildHash,
        };
    }
    const limits = {
        /*
         * [2.1.6] 规划器的两扇窗此前不在 limits 里：`options.limits.plannerTimeoutMs`
         * 永远是 undefined，调用处只能靠兜底常量，状态/诊断也因此读不到「当前生效
         * 的规划器时限」。补齐后配置 → limits → 单次调用是同一条链路。
         */
        plannerTimeoutMs: normalisePlannerWindow(options.plannerTimeoutMs, PLANNER_TIMEOUT_MS),
        plannerIdleTimeoutMs: normalisePlannerWindow(options.plannerIdleTimeoutMs, PLANNER_IDLE_TIMEOUT_MS),
        childTimeoutMs: normaliseChildTimeout(options.childTimeoutMs),
        idleTimeoutMs: normaliseIdleTimeout(options.idleTimeoutMs),
        // [2.2.5] 0 = 不设整轮硬预算；正数才启用（最小 60s）。未配置按 0。
        totalTimeoutMs: Number.isFinite(Number(options.totalTimeoutMs)) && Number(options.totalTimeoutMs) >= 0
            ? (Number(options.totalTimeoutMs) === 0
                ? 0
                : Math.max(60000, Math.floor(Number(options.totalTimeoutMs))))
            : TOTAL_TIMEOUT_MS,
        maxResumes: Number.isFinite(Number(options.maxResumes)) && Number(options.maxResumes) >= 0
            ? Math.min(5, Math.floor(Number(options.maxResumes)))
            : MAX_PLAN_RESUMES,
        autoResume: {
            enabled: options.autoResume === true,
            maxAttempts: autoResumeAttemptCap(options.autoResumeMaxAttempts),
        },
    };
    /**
     * [1.12.0] 自动派发：计划生成后立即以 async 方式开跑。
     *
     * 与 `dsh_workplan_dispatch(mode:"async")` 走同一条 `dispatchPlan` 路径，
     * 区别只在「启动」是计划落地后的确定性动作，而不是模型的一次额外调用：
     *  - 独立 AbortController：回合结束不会杀掉后台执行；
     *  - 结果消息由 `finishRound` 写入，刷新后仍可见；
     *  - 失败只记录错误，不把「派发失败」伪装成「计划生成失败」。
     */
    function startAutoDispatch(record, session, agent) {
        const controller = new AbortController();
        record.abortDispatch = (reason) => {
            if (!controller.signal.aborted) {
                controller.abort(new PlanError(`计划已取消：${reason}`, 'CANCELLED'));
            }
        };
        const roundOptions = {
            agent,
            modelSelection: record.modelSelection,
            cwd: session.header?.cwd ?? options.cwd,
            conversationContext: record.conversationContext ?? '',
            // [2.2.0][T6/O-1a] 自动派发是后台轮次：结算成功即推送完成即时通知。
            notifyCompletion: true,
            onSubtaskDone: (recordArg, subtask, verdict) => emitSubtaskDoneNotice(recordArg, session, subtask, verdict),
        };
        record.dispatchStartedAt = Date.now();
        record.dispatchPromise = dispatchPlan(ctx, record, {
            ...roundOptions,
            signal: controller.signal,
            // [2.2.0][T4/O-3b] 传原始配置值：未配置=undefined 时协商派生生效，显式配置=兜底上限（resolveSubtaskTimeoutMs）。
            childTimeoutMs: options.childTimeoutMs,
            idleTimeoutMs: limits.idleTimeoutMs,
            totalTimeoutMs: limits.totalTimeoutMs,
            maxResumes: limits.maxResumes,
            strictEvidence: options.strictEvidence,
        }).finally(() => {
            record.dispatchPromise = null;
            record.dispatchStartedAt = null;
            record.abortDispatch = null;
        });
        record.dispatchPromise
            .then(() => {
            finishRound(record, session);
            state.records.set(session.id, record);
            armAutoResume(record, session, roundOptions);
        })
            .catch((error) => {
            pushRecordError(record, error);
            finishRound(record, session);
            state.records.set(session.id, record);
            armAutoResume(record, session, roundOptions);
        });
    }
    state.startAutoDispatch = startAutoDispatch;
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
            /*
             * [1.11.0] 回报自愈（契约 §7.3 B4）：上一轮结果消息已写入，但回报标记
             * 写失败/进程中断时，下一步 pre-step 幂等补齐，不重复追加上下文。
             */
            const session = payload.agent?.session;
            const known = session ? state.records.get(session.id) : null;
            if (known?.plan && known.reportPending === true && known.resultWritten === true) {
                const changed = markReported(known, session, `${known.plan.planId}:${known.dispatchedAt ?? 0}`);
                if (changed > 0) {
                    known.reportPending = (known.statuses ?? []).some((item) => item?.status === 'done' && item?.closure === 'done');
                }
            }
            return await maybePlan(ctx, state, payload, downstream, { ...options, limits });
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
    function adoptRequestedPlan(session, current, requestedPlanId) {
        if (!current?.plan || !requestedPlanId || current.plan.planId === requestedPlanId)
            return current;
        if (current.dispatchPromise) {
            throw new PlanError(`计划 ${requestedPlanId} 不是当前记录：${current.plan.planId} 正在执行，先等它结束或先取消它`, 'PLAN_ID_MISMATCH');
        }
        const rebuilt = reconstructFromSession(session, requestedPlanId);
        if (!rebuilt?.plan || rebuilt.plan.planId !== requestedPlanId) {
            throw new PlanError(`planId 与当前计划不匹配（当前 ${current.plan.planId}，会话日志里也没有 ${requestedPlanId}）`, 'PLAN_ID_MISMATCH');
        }
        rebuilt.resumeLimit = current.resumeLimit ?? rebuilt.resumeLimit;
        state.records.set(session.id, rebuilt);
        return rebuilt;
    }
    /*
     * [2.2.0][T5/O-4c/O-4d] 延期预算（防滥用，方案 §5.4 #1/#2；数值只引方案原文）。
     *
     * 初始协商上限的解析完全复用 T4 的 resolveSubtaskTimeoutMs（显式
     * subtask.timeoutMs → deriveSubtaskTimeoutMs(estimateMinutes) → 回落
     * CHILD_TIMEOUT_MS）。方案没有给出 MAX_EXTEND_MS 的具体数值，因此**不自拟
     * 常量**：单次延期上限派生为「剩余延期预算」＝初始协商上限 × 1 − 已累计延期
     * （timeJournal 中 action:'extend' 之和）。累计超限即拒绝并转「请主 Agent
     * 裁决」（EXTEND_BUDGET_EXHAUSTED），放宽永远有界。
     *
     * 为什么初始上限不传 options.childTimeoutMs：显式注入的 childTimeoutMs 是
     * 运维兜底上限（见 resolveSubtaskTimeoutMs 注释），不是本子任务的协商上限；
     * 延期预算按方案 §2.2 的口径取计划层解析值。验收合同也用同一口径（D4 用
     * 显式 timeoutMs 定 2000ms；D2 用例在 1200ms 小窗上放宽 1500ms 是合法的）。
     */
    function extendBudgetOf(record, subtaskId) {
        const entry = flattenSubtasks(record?.plan ?? { stages: [] })
            .find((candidate) => candidate?.subtask?.id === subtaskId);
        const initialMs = resolveSubtaskTimeoutMs(entry?.subtask, undefined);
        const row = Array.isArray(record?.statuses)
            ? record.statuses.find((item) => item?.subtaskId === subtaskId)
            : null;
        const usedMs = (Array.isArray(row?.timeJournal) ? row.timeJournal : [])
            .filter((item) => item?.action === 'extend')
            .reduce((sum, item) => {
            const value = Number(item?.extendMs);
            return Number.isFinite(value) && value > 0 ? sum + Math.floor(value) : sum;
        }, 0);
        // 方案 §5.4 #2：累计 extendMs ≤ 初始协商上限 × 1（最多再给一倍）。
        const capMs = initialMs;
        return { initialMs, capMs, usedMs, remainingMs: Math.max(0, capMs - usedMs) };
    }
    /*
     * [2.2.0][T5/O-4c] timeNotice 的形状校验（方案 §2.4：{declaredMinutes, reason}）。
     * 只记录、不改判定；非法值返回可读错误而不是抛裸错（与 STALE_WRITE 同风格）。
     */
    function validateTimeNotice(notice) {
        const declared = Number(notice?.declaredMinutes);
        if (!Number.isFinite(declared) || declared <= 0) {
            return {
                code: 'INVALID_TIME_NOTICE',
                error: `timeNotice.declaredMinutes 必须是正数分钟：${String(notice?.declaredMinutes)}`,
                hint: '预告只做记录（仅供参考、非承诺）：请传正数分钟与可选 reason。',
            };
        }
        return null;
    }
    /*
     * [2.2.0][T5/O-4c] 写入专家开工预告（O-2a）：状态行 timeNotice + timeJournal
     * 的 action:'estimate' 条目。applyStatus（plan.ts，T3 领地）还没有该字段的
     * 路由分支，按 T4 直写通道写行（StatusEntry 保留未知字段；回放白名单已透传
     * timeNotice，刷新后不丢）。
     */
    function recordTimeNotice(record, subtaskId, notice) {
        const row = Array.isArray(record?.statuses)
            ? record.statuses.find((item) => item?.subtaskId === subtaskId)
            : null;
        if (!row)
            return;
        const at = Date.now();
        const reason = truncate(String(notice?.reason ?? ''), 300);
        row.timeNotice = {
            declaredMinutes: Number(notice?.declaredMinutes),
            at,
            channel: 'agent',
            reason,
        };
        const journal = Array.isArray(row.timeJournal) ? row.timeJournal : [];
        journal.push({
            at,
            action: 'estimate',
            declaredMinutes: Number(notice?.declaredMinutes),
            by: 'agent',
            reason,
        });
        row.timeJournal = journal.slice(-20);
        record.updatedAt = at;
    }
    async function updateStatus(agent, args) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内更新计划', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能更新主计划', 'NOT_ROOT');
        let record = state.records.get(session.id);
        if (!record?.plan)
            record = reconstructFromSession(session, args?.planId);
        record = adoptRequestedPlan(session, record, args?.planId);
        if (!record?.plan)
            throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN');
        const subtaskId = typeof args?.subtaskId === 'string' ? args.subtaskId : '';
        if (!subtaskId)
            throw new PlanError('缺少 subtaskId', 'MISSING_SUBTASK');
        const status = typeof args?.status === 'string' ? args.status : '';
        /*
         * [2.2.0][T5/O-4c] 延期事务的入口判定（D2/D3/D4，方案 §2.2）：
         * extendMs / timeNotice 属于「只改时限、只做记录」的字段，不改状态判定，
         * 因此允许不带 status 单独提交；运行中也不需要 force——TASK_RUNNING 的
         * 唯一豁免来自「不改判定」这一事实，而不是特权。
         */
        const extendMsArg = args?.extendMs;
        const hasExtend = extendMsArg !== undefined && extendMsArg !== null;
        const timeNoticeArg = args?.timeNotice;
        const hasTimeNotice = timeNoticeArg !== undefined && timeNoticeArg !== null;
        const statusRequested = ['pending', 'in_progress', 'done', 'blocked'].includes(status);
        if (!statusRequested && !hasExtend && !hasTimeNotice) {
            throw new PlanError('status 必须是 pending / in_progress / done / blocked（仅协商时限时可省略 status，改传 extendMs / timeNotice）', 'INVALID_STATUS');
        }
        if (hasExtend && !(typeof extendMsArg === 'number' && Number.isInteger(extendMsArg) && extendMsArg > 0)) {
            return {
                ok: false,
                code: 'INVALID_EXTEND',
                planId: record.plan.planId,
                subtaskId,
                error: `extendMs 必须是正整数毫秒：${String(extendMsArg)}`,
                hint: '请传入 1 以上的整数毫秒；放宽永远有界（累计 ≤ 初始协商上限 × 1），超出请转新轮续跑或转 escalate 请主 Agent 裁决。',
            };
        }
        /*
         * [2.2.0][T5/O-4c] timeNotice 的校验放在入口统一做（所有路径共享）：
         * 非法预告不该因为调用同时带了 status/instruction 就被静默接受。
         */
        if (hasTimeNotice) {
            const problem = validateTimeNotice(timeNoticeArg);
            if (problem) {
                return {
                    ok: false,
                    code: problem.code,
                    planId: record.plan.planId,
                    subtaskId,
                    error: problem.error,
                    hint: problem.hint,
                };
            }
        }
        /*
         * [2.2.0][T5/O-4c] 延期事务与状态改判分开提交：方案 §2.2 把 extendMs 定为
         * 「放宽时间的唯一写路径」，要求原子与可审计；一次调用既改判定又改时限会让
         * 失败路径出现半写（判定已落、时限未落，或相反）。组合调用显式拒绝，模型分
         * 两次提交即可（两者都不需要 force）。
         */
        if (hasExtend && statusRequested) {
            return {
                ok: false,
                code: 'EXTEND_REQUIRES_DEDICATED_CALL',
                planId: record.plan.planId,
                subtaskId,
                error: '延期事务必须单独提交：同一次调用不要同时传 status 与 extendMs（放宽是原子、可审计的唯一写路径）',
                hint: '先单独调用 extendMs 放宽时限，再用另一次调用改判状态。',
            };
        }
        /*
         * [1.10.4] 人工改判优先于任何已排期的自动续跑：先撤销定时器，再写状态。
         * [2.2.0][T5/O-4c] 纯延期/纯预告不改判定，不撤销自动续跑（否则一次失败的
         * 延期尝试会把已排期的续跑静默取消，计划停在 paused 无人推进）。
         */
        if (statusRequested)
            clearAutoResumeTimer(record, 'manual-update');
        const note = typeof args?.note === 'string' ? args.note : '';
        const evidence = Array.isArray(args?.evidence)
            ? args.evidence.filter((item) => typeof item === 'string').join('；')
            : '';
        const summary = [note, evidence].filter(Boolean).join('｜');
        const current = record.statuses.find((item) => item.subtaskId === subtaskId);
        /*
         * [2.2.0][T5/O-4c] 纯时限事务（不带 status）不经过 applyStatus，必须自己
         * 拒绝未知子任务——否则一次对不存在行的 timeNotice 会得到「成功」。
         */
        if (!statusRequested && !current) {
            throw new PlanError(`未知子任务：${subtaskId}`, 'UNKNOWN_SUBTASK');
        }
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
            };
        }
        const running = Boolean(record.dispatchPromise);
        /*
         * [2.2.0][T5/O-4c] TASK_RUNNING 的唯一豁免：只给「不改状态判定」的时限事务。
         * 纯 extendMs / timeNotice 更新（statusRequested=false）照常放行；只要同一次
         * 调用还带 status，仍走原守卫——其余状态字段不得被顺手改掉（行为不变）。
         */
        const writeWhileRunning = running && !args?.force && statusRequested
            && (current?.status === 'pending' || current?.status === 'in_progress');
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
            };
        }
        /*
         * [1.11.0] 待指示行的两条合法出口（T4 S4→S5 / S4→S6）。
         *
         * `dsh_workplan_update` 也是 `instruct` 的等价入口：带 instruction 即恢复
         * 推进，不带 instruction 直接 in_progress/done 会把一条未回答的请示洗成
         * 「在做/做完」，所以显式拒绝，并告诉主 Agent 该用哪个字段。
         */
        const instruction = typeof args?.instruction === 'string' ? args.instruction.trim() : '';
        if (instruction) {
            if (current?.closure !== 'escalated') {
                return {
                    ok: false,
                    code: 'NOT_ESCALATED',
                    planId: record.plan.planId,
                    subtaskId,
                    error: '该子任务不在待指示状态，不需要 instruction；普通受阻请直接改判。',
                };
            }
            if (status !== 'in_progress') {
                return {
                    ok: false,
                    code: 'INSTRUCTION_REQUIRES_IN_PROGRESS',
                    planId: record.plan.planId,
                    subtaskId,
                    error: '下发 instruction 时 status 必须是 in_progress（或改用 dsh_workplan_instruct）。',
                };
            }
            const instructed = await instructSubtask(agent, {
                planId: args?.planId,
                subtaskId,
                instruction,
            }, undefined, record);
            /*
             * [2.2.0][T5/O-4c] 预告与指示同一次到达时，指示成功落行后再记预告：
             * 指示失败不该留下一笔「专家已预告」的记录。
             */
            if (hasTimeNotice && instructed?.ok !== false)
                recordTimeNotice(record, subtaskId, timeNoticeArg);
            return instructed;
        }
        if (current?.closure === 'escalated') {
            if (status === 'done') {
                return {
                    ok: false,
                    code: 'ESCALATION_OPEN',
                    planId: record.plan.planId,
                    subtaskId,
                    error: '该子任务仍在等待指示，不能直接改判 done：请先给出 instruction，或明确改判 blocked 放弃。',
                };
            }
            if (status === 'in_progress') {
                return {
                    ok: false,
                    code: 'INSTRUCTION_REQUIRED',
                    planId: record.plan.planId,
                    subtaskId,
                    error: '该子任务正在等待指示：恢复推进必须传 instruction（或调用 dsh_workplan_instruct），不能只改 status。',
                };
            }
        }
        /*
         * [2.2.0][T5/O-4c] 延期事务（放宽时间的唯一写路径，方案 §2.2；D2/D3 效果 +
         * §5.4 防滥用）：
         *  1. 预算：初始协商上限取 T4 resolveSubtaskTimeoutMs 的计划层解析值；累计
         *     放宽（timeJournal 中 action:'extend' 之和）≤ 初始上限 × 1。方案没有给
         *     MAX_EXTEND_MS 数值，单次上限派生为「剩余延期预算」，不自拟常量。
         *  2. 执行：校验通过才调用 T4 extendDeadline——它负责 deadlineAt += extendMs、
         *     重置一次性计时器、同步 watchdog，并追加 timeJournal（action:'extend'）。
         *     回放侧（本文件 replay 白名单）的累加语义与此一致：deadlineAt 累加 +
         *     同形 journal 条目，所以回放代码不需要改。
         *  3. 纯时限事务不改状态判定：回执只带时限结果与审计字段。
         */
        let extension = null;
        if (hasExtend) {
            const budget = extendBudgetOf(record, subtaskId);
            if (extendMsArg > budget.remainingMs) {
                return {
                    ok: false,
                    code: 'EXTEND_BUDGET_EXHAUSTED',
                    planId: record.plan.planId,
                    subtaskId,
                    budget,
                    error: `extendMs ${extendMsArg}ms 超出剩余延期预算 ${budget.remainingMs}ms：`
                        + `累计延期 ${budget.usedMs}ms，初始协商上限 ${budget.initialMs}ms（上限 × 1 = ${budget.capMs}ms）`,
                    hint: '放宽永远有界：该任务应转入新轮续跑（auto-resume）或转 escalate 请主 Agent/用户裁决。',
                };
            }
            const extended = extendDeadline(record, subtaskId, extendMsArg, {
                by: 'agent',
                reason: typeof args?.reason === 'string'
                    ? args.reason
                    : (typeof args?.note === 'string' ? args.note : ''),
            });
            if (!extended.ok) {
                return {
                    ok: false,
                    code: extended.code,
                    planId: record.plan.planId,
                    subtaskId,
                    error: extended.error,
                    hint: extended.hint,
                };
            }
            extension = extended;
        }
        if (!statusRequested) {
            if (hasTimeNotice)
                recordTimeNotice(record, subtaskId, timeNoticeArg);
            /*
             * 纯时限事务到此结束。方案 §2.2 效果 3：状态行 revision +1（延期/预告也是
             * 行变更，同样受 STALE_WRITE 乐观锁保护）；状态与判定一个字段都不改。
             */
            const row = record.statuses.find((item) => item?.subtaskId === subtaskId);
            if (row) {
                row.revision = Number(current?.revision ?? 0) + 1;
                row.updatedBy = 'agent';
            }
            record.updatedAt = Date.now();
            const snapshot = derivePlanSnapshot(record.statuses);
            const written = snapshot.statuses.find((item) => item.subtaskId === subtaskId);
            const readiness = readinessOf(record, snapshot);
            return {
                ok: true,
                planId: record.plan.planId,
                subtaskId,
                status: written?.status ?? current?.status ?? null,
                revision: written?.revision ?? Number(current?.revision ?? 0),
                updatedBy: written?.updatedBy ?? 'agent',
                ...(extension
                    ? {
                        deadlineAt: extension.deadlineAt,
                        timerRearmed: extension.timerRearmed,
                        watchdogRearmed: extension.watchdogRearmed,
                    }
                    : {}),
                ...(hasTimeNotice ? { timeNotice: written?.timeNotice ?? null } : {}),
                timeJournal: Array.isArray(written?.timeJournal) ? written.timeJournal.slice(-10) : [],
                stats: snapshot.stats,
                deliveryReady: readiness.ready,
                deliveryBlockers: readiness.blockers.slice(0, 12),
                deliveryRemaining: readiness.remaining.slice(0, 20),
                hint: '时限协商已记录：状态与判定未改，不需要 force；放宽永远有界，超出累计上限请转新轮续跑或转 escalate 请主 Agent 裁决。',
            };
        }
        const revision = Number(current?.revision ?? 0) + 1;
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
        const evidencePatch = {};
        if (args?.verification !== undefined)
            evidencePatch.verification = args.verification;
        if (args?.acceptance !== undefined)
            evidencePatch.acceptance = args.acceptance;
        if (args?.artifacts !== undefined)
            evidencePatch.artifacts = args.artifacts;
        if (args?.missingArtifacts !== undefined)
            evidencePatch.missingArtifacts = args.missingArtifacts;
        record.statuses = applyStatus(record.statuses, subtaskId, {
            status,
            progress: typeof args?.progress === 'number' ? args.progress : undefined,
            summary: summary || undefined,
            error: status === 'blocked' ? (summary || '由主 Agent 标记为受阻') : undefined,
            ...evidencePatch,
            /*
             * [1.11.0] 明确放弃（blocked）必须同时关掉 escalated，否则
             * applyStatus 会保留「等指示」投影，主 Agent 的放弃写了个寂寞。
             */
            ...(current?.closure === 'escalated' && status === 'blocked'
                ? { closure: 'blocked', blockedKind: 'failed', question: null, options: [] }
                : {}),
            revision,
            updatedBy: 'agent',
        });
        /*
         * [2.2.0][T5/O-4c] 带 status 的调用同时带 timeNotice 时，预告记录在改判落行
         * 之后写入：applyStatus 抛错（如非法 verification）时不会留下半写的预告。
         */
        if (hasTimeNotice)
            recordTimeNotice(record, subtaskId, timeNoticeArg);
        if (status === 'blocked') {
            record.statuses = markDependentsBlocked(record.plan, record.statuses, subtaskId, { reason: summary || '主 Agent 标记受阻' });
        }
        /*
         * [1.7.0] A re-adjudication is durable.
         *
         * `applyStatus` only touched the in-memory record, so after a refresh the
         * manual verdict vanished and the dashboard fell back to the old child
         * result. Appending one small message keeps the replay path honest.
         */
        try {
            const writtenRow = record.statuses.find((item) => item.subtaskId === subtaskId);
            appendUserMessage(session, buildUpdateMessage({
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
                closure: writtenRow?.closure,
                blockedKind: writtenRow?.blockedKind,
                question: writtenRow?.question,
                options: writtenRow?.options,
                instruction: writtenRow?.instruction,
                instructionSeq: writtenRow?.instructionSeq,
            }));
        }
        catch (error) {
            pushRecordError(record, error);
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
        record.phase = reconcilePhase(record.phase, record.statuses);
        record.updatedAt = Date.now();
        const snapshot = derivePlanSnapshot(record.statuses);
        const written = snapshot.statuses.find((item) => item.subtaskId === subtaskId);
        const readiness = readinessOf(record, snapshot);
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
        };
    }
    /**
     * [1.11.0] C-11：需求变更的唯一写入入口（dsh_workplan_replan）。
     *
     * 为什么必须单独一个工具，而不是让模型直接改计划消息：
     *  1. 旧行的 `supersededAt` 与状态条的 `closure:'replanned'` 必须同一次写入，
     *     否则调度器会继续跑「已撤销」的工作；
     *  2. durable `workplan-replan` 带上完整修订计划，刷新后才能得到同一份定义；
     *  3. 执行中收到变更时，工具返回 `REPLAN_PLAN_RUNNING` 并保留 changeRequest，
     *     让模型等待而不是静默丢弃或强行中断正在跑的子任务。
     */
    async function replanPlan(agent, args) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内重规划', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能重规划主计划', 'NOT_ROOT');
        let record = state.records.get(session.id);
        if (!record?.plan)
            record = reconstructFromSession(session, args?.planId);
        record = adoptRequestedPlan(session, record, args?.planId);
        if (!record?.plan)
            throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN');
        const planId = record.plan.planId;
        const revisionNow = Number(record.planRevision ?? record.plan?.planRevision ?? 0);
        const base = {
            ok: false,
            planId,
            planRevision: revisionNow,
            stats: derivePlanSnapshot(record.statuses).stats,
        };
        if (record.phase === 'cancelled' || record.phase === 'superseded' || record.superseded === true) {
            return {
                ...base,
                code: 'REPLAN_TERMINAL',
                error: '计划已是终态（已取消/已被取代），不能重规划',
                hint: '终态计划不会复活：如需继续这项工作，请让主 Agent 生成新计划。',
            };
        }
        if (record.dispatchPromise) {
            /*
             * 执行中拒绝改写定义，但把变更原文记下来。旧行为（maybePlan 直接
             * return downstream）会让用户在派发期间说的新需求彻底消失。
             */
            const change = typeof args?.changeText === 'string' ? truncate(args.changeText.trim(), 4000) : '';
            if (change) {
                const seq = Number(record.changeRequestSeq ?? 0) + 1;
                record.changeRequestSeq = seq;
                record.changeRequest = {
                    seq,
                    text: change,
                    at: Date.now(),
                    turn: Number(state.activeTurns?.get?.(session.id) ?? NaN) || null,
                    status: 'pending',
                };
                record.updatedAt = Date.now();
            }
            state.records.set(session.id, record);
            return {
                ...base,
                code: 'REPLAN_PLAN_RUNNING',
                error: '本轮派发仍在执行：重规划不会中途改写正在跑的子任务',
                hint: '先轮询 dsh_workplan_status 等本轮结束（或先 cancel 并等它收敛），再提交同一组 changes；变更已记录为 changeRequest，不会丢失。',
                running: true,
                changeRequest: record.changeRequest ?? null,
            };
        }
        const revision = revisionNow + 1;
        const at = Date.now();
        const result = planReplan(record.plan, args?.changes, {
            planId,
            reason: args?.reason,
            revision,
            at,
        });
        if (!result.ok)
            return { ...base, code: result.code, error: result.error };
        /*
         * 先落 durable 记录，再改内存：写失败时计划保持原样，不会出现
         * 「内存里已经改了、刷新后又退回去」的分叉。
         */
        try {
            appendUserMessage(session, buildReplanMessage(result.payload));
        }
        catch (error) {
            return {
                ...base,
                code: 'REPLAN_WRITE_FAILED',
                error: `写入重规划记录失败：${error instanceof Error ? error.message : String(error)}`,
                hint: '计划未被改动；修复会话写入问题后重试同一组 changes。',
            };
        }
        record.plan = result.payload.plan;
        record.planRevision = revision;
        record.statuses = applyReplanStatuses(record.statuses, result.payload);
        record.phase = planPhase(record.statuses);
        record.error = null;
        record.updatedAt = at;
        if (record.changeRequest && record.changeRequest.status !== 'replanned') {
            record.changeRequest = {
                ...record.changeRequest,
                status: 'replanned',
                replannedAt: at,
                planRevision: revision,
            };
        }
        state.records.set(session.id, record);
        const snapshot = derivePlanSnapshot(record.statuses, definedSubtaskCount(record.plan));
        return {
            ok: true,
            planId,
            planRevision: revision,
            reason: result.payload.reason,
            marks: result.payload.marks,
            added: result.payload.added,
            phase: record.phase,
            stats: snapshot.stats,
            statuses: modelStatusLines(snapshot.statuses),
            hint: '旧行保留为 closure=replanned（可追溯、不计入剩余项、不再调度）；修订后的新行是 pending，调用 dsh_workplan_dispatch 才会执行。',
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
            record = reconstructFromSession(session, args?.planId);
        record = adoptRequestedPlan(session, record, args?.planId);
        if (!record?.plan)
            throw new PlanError('当前会话还没有已生成的计划', 'NO_PLAN');
        /*
         * [1.9.2] superseded 的唯一写入入口（T6）。
         *
         * `disposition` 只有两个合法取值：省略/'cancelled' 走既有取消语义（返回体
         * 与 1.8.19 逐字相同）；'superseded' 交给 `supersedePlanRecord`（V1–V8
         * 复算 + digest + durable 信封）。其他取值一律拒绝：静默忽略一个拼错的
         * disposition 会把「想取代」写成「取消」，而两者的读侧判定完全不同。
         */
        const disposition = args?.disposition;
        if (disposition !== undefined && disposition !== 'cancelled' && disposition !== 'superseded') {
            throw new PlanError(`disposition 只能是 cancelled 或 superseded（收到 ${String(disposition)}）`, 'INVALID_DISPOSITION');
        }
        if (disposition === 'superseded') {
            const result = supersedePlanRecord(session, record, args, { reconstruct: reconstructFromSession });
            state.records.set(session.id, record);
            return result;
        }
        /*
         * [1.9.2] 被取代的计划不允许被普通取消静默改回 cancelled。
         *
         * 旧路径会追加第二条不带 disposition 的取消信封：live 变 cancelled，
         * replay 却因同一 planId 先读到 superseded 而仍是 superseded —— 又一种
         * live/replay 分叉。行政撤销（E6）需要用户明确要求并写入新的处置记录，
         * 本版本不实现，因此这里 fail-closed 并给出可执行说明。
         */
        if (record.phase === 'superseded' || record.superseded === true) {
            return {
                ok: false,
                planId: record.plan.planId,
                phase: 'superseded',
                code: 'SUPERSEDED_LOCKED',
                error: '计划已被取代：不能静默改回 cancelled（行政撤销 E6 需要用户明确要求并写入新的处置记录，本版本未实现）',
                hint: '被取代不等于完成：不得调用 present、不得声称“已完成”。如需撤销该处置，请先向用户确认，再由主 Agent 走审计流程。',
                cancelRecorded: record.supersedeRecorded === true,
                stats: derivePlanSnapshot(record.statuses).stats,
            };
        }
        const reason = typeof args?.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '用户取消';
        // [1.10.4] 取消是终态：必须撤销已排期的自动续跑，否则定时器会在取消之后复活计划。
        clearAutoResumeTimer(record, 'cancelled');
        /*
         * [1.5.2] 已完成即终态：取消不再把 100% 的计划改写成「已取消」。
         *
         * T4 实测 A.4：2/2 全部 done 的计划被取消后会得到 `phase=cancelled` +
         * `done=2/2` + `percent=100` —— 又一个「一边说全好了、一边说被取消」的
         * 自相矛盾组合，且会让本可续跑/查看的完成记录永远退出「已完成」组。
         * 这里直接把取消变成 no-op 并如实返回 done。
         */
        const before = derivePlanSnapshot(record.statuses);
        if (before.stats.total > 0 && before.stats.done === before.stats.total) {
            record.phase = 'done';
            record.updatedAt = Date.now();
            state.records.set(session.id, record);
            return {
                ok: true,
                planId: record.plan.planId,
                phase: 'done',
                reason,
                alreadyDone: true,
                abortedRunning: false,
                stats: before.stats,
            };
        }
        /*
         * [1.8.14] N8: a second cancel used to append a second cancel message.
         *
         * Cancelling is idempotent by definition: once the cancellation is durably
         * recorded, repeating it must not grow the log — every duplicate is
         * replayed and shows up as another "取消" line in the transcript, which is
         * exactly the kind of "did it happen twice?" noise this incident was made
         * of.
         *
         * [1.8.15] The abort path was the exception that still duplicated: while
         * `dispatchPromise` was in flight the guard fell through every time, so two
         * cancels during one dispatch appended two messages (T4e F2). Once the
         * abort has been requested there is nothing left to stop, so the presence
         * of an in-flight promise is no longer a reason to append again.
         */
        if (record.phase === 'cancelled' && record.cancelRecorded === true
            && (!record.dispatchPromise || record.abortRequested === true)) {
            state.records.set(session.id, record);
            return {
                ok: true,
                planId: record.plan.planId,
                phase: 'cancelled',
                reason: typeof record.cancelReason === 'string' && record.cancelReason ? record.cancelReason : reason,
                alreadyCancelled: true,
                abortedRunning: false,
                cancelRecorded: true,
                stats: before.stats,
            };
        }
        const cancelMessage = buildCancelMessage(record.plan.planId, reason);
        /*
         * [1.8.14] N12: the durable cancel used to be the only append without a
         * try/catch. A failing append threw out of the tool after the in-memory
         * phase had already flipped to `cancelled`, leaving the UI saying
         * "已取消" while the log said nothing — the next restart silently undid it.
         * Record the failure and report `cancelRecorded: false` instead.
         */
        const appendCancelRecord = () => {
            try {
                appendUserMessage(session, cancelMessage);
                record.cancelRecorded = true;
                record.cancelReason = reason;
                return true;
            }
            catch (error) {
                record.cancelRecorded = false;
                pushRecordError(record, `写入取消消息失败：${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        };
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
                /*
                 * [1.8.15] Mark the abort before asking for it. The idempotency guard
                 * above keys on this flag, so a second cancel that arrives while the
                 * dispatch promise is still settling cannot append a second message.
                 */
                record.abortRequested = true;
                record.abortDispatch?.(reason);
                aborted = true;
            }
            catch (error) {
                record.errors = [...(record.errors ?? []), `取消时中止执行失败：${String(error?.message ?? error)}`].slice(-20);
            }
            /*
             * [1.8.14] The abort path now writes the cancel durably too. 1.8.13
             * returned here without touching the log, so a later failed result write
             * left no trace of the cancellation at all and a restart reopened the
             * plan as "executing".
             */
            const recorded = appendCancelRecord();
            state.records.set(session.id, record);
            return {
                ok: true,
                planId: record.plan.planId,
                phase: 'cancelled',
                reason,
                abortedRunning: aborted,
                cancelRecorded: recorded,
                stats: derivePlanSnapshot(record.statuses).stats,
            };
        }
        record.phase = 'cancelled';
        record.error = `计划已取消：${reason}`;
        record.updatedAt = Date.now();
        const recorded = appendCancelRecord();
        state.records.set(session.id, record);
        return {
            ok: true,
            planId: record.plan.planId,
            phase: 'cancelled',
            reason,
            cancelRecorded: recorded,
            stats: derivePlanSnapshot(record.statuses).stats,
        };
    }
    /*
     * [1.10.4][auto-resume] 自动续跑的记账与排期。
     *
     * 为什么在工具层而不是 `dispatchPlan` 里：被整轮预算中止时，这一轮已经没有
     * 预算可用，轮内重试必然再被同一把闸刀砍掉（`shouldRetryAttempt` 对
     * `TOTAL_TIMEOUT` / `ABORTED` 恒为 false 是正确的）。能重试的只有「下一轮」：
     * 新预算、新截止时间，未完成项由 `resetBlockedStatuses` 放回 pending，
     * done 项永不重跑。所以调度点属于「谁结束了一轮」，也就是这里。
     *
     * 所有停止分支都由纯函数 `decideAutoResume` 判定，本层只负责：
     *  - 记录 done 水位与连续无进展轮数（防止空转）；
     *  - 用 unref 的定时器排期，并在取消/人工派发/进程销毁时撤销；
     *  - 起跑前再核对一次记录身份与阶段（定时器期间状态可能已变）。
     */
    function autoResumeBook(record) {
        if (!record.autoResume || typeof record.autoResume !== 'object') {
            record.autoResume = {
                attempt: 0,
                noProgressRounds: 0,
                doneBefore: null,
                nextAt: null,
                timer: null,
                lastDecision: null,
                history: [],
            };
        }
        return record.autoResume;
    }
    function clearAutoResumeTimer(record, reason) {
        const book = record?.autoResume;
        if (!book)
            return false;
        book.nextAt = null;
        if (!book.timer)
            return false;
        clearTimeout(book.timer);
        book.timer = null;
        book.lastStopReason = reason;
        return true;
    }
    function autoResumeView(record) {
        const book = record?.autoResume;
        return {
            enabled: limits.autoResume.enabled,
            attempt: Number(book?.attempt ?? 0),
            maxAttempts: limits.autoResume.maxAttempts,
            armed: Boolean(book?.timer),
            nextInMs: book?.nextAt ? Math.max(0, Number(book.nextAt) - Date.now()) : null,
            lastCode: book?.lastDecision?.code ?? null,
            lastReason: book?.lastDecision?.reason ?? null,
            lastStopReason: book?.lastStopReason ?? null,
        };
    }
    /**
     * 在一轮结束后决定是否再开一轮。
     *
     * @param record - 当前计划记录。
     * @param session - 根会话（结果消息与子 Agent 都归属它）。
     * @param base - 本轮派发的可复用参数（agent / modelSelection / cwd / conversationContext）。
     */
    function armAutoResume(record, session, base) {
        const book = autoResumeBook(record);
        clearAutoResumeTimer(record, 'rearmed');
        const snapshot = derivePlanSnapshot(record.statuses);
        const stats = snapshot.stats ?? {};
        const statuses = Array.isArray(record.statuses) ? record.statuses : [];
        const done = Number(stats.done ?? 0);
        const doneBefore = Number.isFinite(Number(book.doneBefore)) ? Number(book.doneBefore) : done;
        /*
         * 「有进展」只认新增的 done 行。被预算中止的子任务会把 error 从 pending
         * 一路写到重置，只有真正完成才会抬高 done；用 done 作水位既不会把
         * 「重跑一次又失败」误判成进展，也不会因错误文案变化而空转。
         */
        if (done > doneBefore)
            book.noProgressRounds = 0;
        else if (Number(book.attempt ?? 0) > 0)
            book.noProgressRounds = Number(book.noProgressRounds ?? 0) + 1;
        book.doneBefore = done;
        /*
         * [1.12.0] 只数仍参与调度的行（T11）：replanned 旧行保持 status='pending'
         * 只为追溯，把它们算进 pending 会让「live 全 done」的计划也排一次续跑，
         * 那一轮什么都不会派发，还会往 errors 里写一条误导性的停止行。
         */
        const liveCounts = liveResumeCounts(statuses);
        const pending = liveCounts.pending;
        const blocked = liveCounts.blocked;
        /*
         * [1.10.4 / D6] 正常完成的计划不许留「停止」噪音。
         *
         * T7 实测：`armAutoResume` 在每一轮结束后都会被调用，正常完成的轮也会走到
         * `PHASE_NOT_PAUSED` 分支，于是每个顺利结束的计划都在 `record.errors` 里多一条
         * 「[auto-resume] 停止」——把真正需要看的中止信息埋掉。全部 done 且没有
         * pending/blocked 时，直接静默收尾，不写台账。
         */
        if (Number(stats.total ?? 0) > 0 && pending === 0 && blocked === 0 && done === Number(stats.total ?? 0)) {
            book.lastDecision = { at: Date.now(), phase: record.phase, action: 'stop', code: 'NOTHING_PENDING', reason: '全部子任务已 done，无需自动续跑' };
            return book.lastDecision;
        }
        const decision = decideAutoResume({
            enabled: limits.autoResume.enabled,
            phase: record.phase,
            cancelled: record.cancelled === true,
            degraded: record.degraded === true,
            planMode: isPlanModeActive(ctx, session),
            running: Boolean(record.dispatchPromise),
            total: Number(stats.total ?? 0),
            done,
            pending,
            blocked,
            attempt: Number(book.attempt ?? 0),
            maxAttempts: limits.autoResume.maxAttempts,
            noProgressRounds: Number(book.noProgressRounds ?? 0),
            stallLimit: AUTO_RESUME_DEFAULTS.stallLimit,
            baseDelayMs: AUTO_RESUME_DEFAULTS.baseDelayMs,
            maxDelayMs: AUTO_RESUME_DEFAULTS.maxDelayMs,
        });
        book.lastDecision = { at: Date.now(), phase: record.phase, ...decision };
        book.history = [...(book.history ?? []), {
                at: Date.now(),
                phase: record.phase,
                done,
                pending,
                blocked,
                attempt: Number(book.attempt ?? 0),
                action: decision.action,
                code: decision.code,
            }].slice(-10);
        if (decision.action !== 'schedule') {
            /*
             * 显式关闭开关时不写错误行：关闭不是一次「失败」，不该污染计划台账。
             * 其余停止原因都要留痕，否则「为什么没有自动续跑」又变成考古。
             */
            if (decision.code !== 'AUTO_RESUME_DISABLED') {
                record.errors = [...(record.errors ?? []),
                    `[auto-resume] 停止（${decision.code}）：${decision.reason}`].slice(-20);
            }
            return decision;
        }
        const attempt = Number(book.attempt ?? 0) + 1;
        book.attempt = attempt;
        book.nextAt = Date.now() + decision.delayMs;
        record.errors = [...(record.errors ?? []),
            `[auto-resume] 已排期第 ${attempt}/${limits.autoResume.maxAttempts} 次自动续跑：`
                + `${Math.round(decision.delayMs / 1000)}s 后开始（本轮预算到点，仍有 ${pending} 项 pending；done 项不重跑）`].slice(-20);
        const timer = setTimeout(() => {
            book.timer = null;
            book.nextAt = null;
            try {
                /*
                 * 排期到点后逐项复核，任何一项不成立都安静退出：定时器活过了一个
                 * 回合，期间用户可能已经取消、主 Agent 可能已经手动派发、页面可能
                 * 已经换了一份计划记录。
                 */
                /*
                 * [1.10.4 / D1] 复核失败必须留下停止码。
                 *
                 * T5 的 I9：任何一次「本应自动续跑却没有发生」都要可解释。原先这里五个
                 * 分支全是裸 `return`，计划停在 paused 而台账里没有任何痕迹，用户只能再
                 * 做一次考古。现在每个分支都写 `lastStopReason`，并把原因追加到 history。
                 */
                const stopTimer = (code) => {
                    book.lastStopReason = code;
                    book.lastDecision = { at: Date.now(), phase: record.phase, action: 'stop', code, reason: '定时器复核未通过' };
                    book.history = [...(book.history ?? []), {
                            at: Date.now(), phase: record.phase, action: 'stop', code,
                        }].slice(-10);
                    return;
                };
                if (state.records.get(session.id) !== record)
                    return stopTimer('SCHEDULE_REVOKED_RECORD_REPLACED');
                if (record.dispatchPromise)
                    return stopTimer('SCHEDULE_REVOKED_ALREADY_RUNNING');
                if (record.cancelled === true)
                    return stopTimer('CANCELLED');
                if (isTerminalPhase(record.phase))
                    return stopTimer('PHASE_TERMINAL');
                if (isPlanModeActive(ctx, session))
                    return stopTimer('PLAN_MODE');
                if (record.phase !== 'paused')
                    return stopTimer('PHASE_NOT_PAUSED');
                const live = derivePlanSnapshot(record.statuses);
                const livePending = (record.statuses ?? []).filter((item) => item?.status === 'pending').length;
                if (Number(live.stats?.total ?? 0) === 0 || livePending === 0)
                    return stopTimer('NOTHING_PENDING');
                const controller = new AbortController();
                record.abortRequested = false;
                record.abortDispatch = (reason) => {
                    if (!controller.signal.aborted)
                        controller.abort(new PlanError(`计划已取消：${reason}`, 'CANCELLED'));
                };
                record.dispatchStartedAt = Date.now();
                // 新一轮必须写一条新的结果消息，否则主 Agent 永远看不到自动续跑的结局。
                record.resultWritten = false;
                book.doneBefore = Number(live.stats?.done ?? 0);
                record.dispatchPromise = dispatchPlan(ctx, record, {
                    ...base,
                    // [2.2.0][T6/O-1a] 自动续跑同样在后台执行：保持完成即时通知。
                    notifyCompletion: true,
                    signal: controller.signal,
                    // [2.2.0][T4/O-3b] 传原始配置值：未配置=undefined 时协商派生生效，显式配置=兜底上限（resolveSubtaskTimeoutMs）。
                    childTimeoutMs: options.childTimeoutMs,
                    idleTimeoutMs: limits.idleTimeoutMs,
                    totalTimeoutMs: limits.totalTimeoutMs,
                    maxResumes: limits.maxResumes,
                    strictEvidence: options.strictEvidence,
                })
                    .then(() => finishRound(record, session))
                    .catch((error) => {
                    pushRecordError(record, error);
                    finishRound(record, session);
                })
                    .finally(() => {
                    record.dispatchPromise = null;
                    record.dispatchStartedAt = null;
                    record.abortDispatch = null;
                    armAutoResume(record, session, base);
                });
                ctx.logger?.warn?.(`dsh-workplan: 计划 ${record.plan?.planId ?? '?'} 自动续跑第 ${attempt}/${limits.autoResume.maxAttempts} 轮已开始`
                    + `（remaining ${Number(live.stats?.total ?? 0) - Number(live.stats?.done ?? 0)}）`);
            }
            catch (error) {
                pushRecordError(record, error);
                ctx.logger?.warn?.(`dsh-workplan: 自动续跑失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }, decision.delayMs);
        timer.unref?.();
        book.timer = timer;
        return decision;
    }
    /**
     * Persist the round result and settle the phase.
     *
     * Extracted from the wait path so an async dispatch reaches exactly the same
     * end state: a durable result message plus a reconciled phase. Anything less
     * would make "start now, read later" a second, divergent code path.
     */
    /**
     * [1.11.0] 完成必回报的写入点（T7 C-06；契约 S7 done → S8 reported）。
     *
     * 只有在「结果消息确实写进会话」之后才调用：没有证据的“已回报”比不回报
     * 更危险。写入走 applyStatus（唯一写入口），读到的是同一条状态条目上的
     * `closure:'reported'` + `report{state,at,ref,turn}`，与左侧栏 chip 同源。
     * 返回本次新标记的条数；已是 reported 的行不重复写，避免每轮刷新 revision。
     */
    function markReported(record, session, ref, onlySubtaskId) {
        const at = Date.now();
        const rawTurn = Number(state.activeTurns?.get?.(session?.id) ?? NaN);
        const turn = Number.isFinite(rawTurn) ? rawTurn : null;
        let changed = 0;
        for (const item of Array.isArray(record?.statuses) ? record.statuses : []) {
            /*
             * [2.2.0][T6/O-1a] 即时通知只标记「刚结算的这一条」；finishRound 批量
             * 补齐不传 onlySubtaskId，保持原有「所有 done 未回报行」语义。
             */
            if (onlySubtaskId !== undefined && String(item?.subtaskId) !== String(onlySubtaskId))
                continue;
            if (item?.status !== 'done')
                continue;
            if (item?.closure === 'reported' && item?.report?.state === 'sent')
                continue;
            try {
                record.statuses = applyStatus(record.statuses, item.subtaskId, {
                    closure: 'reported',
                    reportedAt: at,
                    report: { state: 'sent', at, ref, turn },
                    revision: Number(item.revision ?? 0) + 1,
                    updatedBy: 'system',
                });
                changed += 1;
            }
            catch (error) {
                ctx.logger?.warn?.(`dsh-workplan: 回报标记失败 ${String(item?.subtaskId)}：${error instanceof Error ? error.message : String(error)}`);
                record.reportPending = true;
            }
        }
        return changed;
    }
    /**
     * [2.2.0][T6/O-1a] 完成即时通知的插件兜底投递器（后台轮次专用）。
     *
     * 方案 §2.3 双通道：①协议通道由子 Agent 完成即 `send_message`；②兜底通道
     * 由这里在 `settleFromOutput` 结算成功后立刻写一条纯文本 `user/message`
     * （含子任务 ID、摘要、验收计数、用时），不等待整轮结束。消息不带任何
     * workplan 标记，回放解析器按未知消息跳过（A2：回放是纯读）。
     *
     * 幂等：同一子任务已有 `closure:'reported'` + `report.state:'sent'` 时直接
     * 跳过——重复结算、finishRound 轮级批量补齐都不得重报。先写通知、后记
     * 回报：写失败只置 reportPending，交结果消息补齐（绝不留无证据已回报）。
     */
    function emitSubtaskDoneNotice(record, session, subtask, verdict) {
        if (!record || !session || typeof session.append !== 'function')
            return;
        const row = Array.isArray(record.statuses)
            ? record.statuses.find((item) => item?.subtaskId === subtask?.id)
            : null;
        if (row?.closure === 'reported' && row?.report?.state === 'sent')
            return;
        const acceptance = Array.isArray(verdict?.acceptance) ? verdict.acceptance : [];
        const passed = acceptance.filter((item) => item?.result === 'pass').length;
        const acceptanceCount = acceptance.length > 0
            ? `验收 ${passed}/${acceptance.length} 通过`
            : '验收记录 0 条（legacy 未提供结构化验收）';
        const elapsedMs = Number.isFinite(Number(row?.startedAt))
            ? Math.max(0, Date.now() - Number(row.startedAt))
            : 0;
        const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
        const summary = truncate(String(row?.summary ?? '').replace(/\s+/g, ' ').trim(), 160) || '（无摘要）';
        const text = `[dsh-workplan] 子任务 ${String(subtask?.id ?? '')} 已完成并结算：${summary}；${acceptanceCount}；用时 ${elapsed}`;
        try {
            appendUserMessage(session, text);
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-workplan: 完成即时通知写入失败 ${String(subtask?.id ?? '')}：`
                + `${error instanceof Error ? error.message : String(error)}`);
            record.reportPending = true;
            return;
        }
        const ref = `${record?.plan?.planId ?? 'plan'}:${record?.dispatchedAt ?? 0}`;
        markReported(record, session, ref, subtask?.id);
    }
    function finishRound(record, session) {
        const ref = `${record.plan?.planId ?? 'plan'}:${record.dispatchedAt ?? 0}`;
        if (!record.resultWritten) {
            /*
             * [1.11.0] 完成必回报的顺序：先标记 reported，再构建并落盘结果消息。
             *
             * 这样结果消息里的 statuses 就带着 `closure:'reported'`，刷新/重启后
             * 回放得到同一个结论；而“标记了但消息没写成功”会在 catch 里回滚，
             * 绝不留下没有证据的 reported。
             */
            const before = (record.statuses ?? []).map((item) => ({ ...item }));
            const needReport = before.filter((item) => item?.status === 'done' && item?.closure !== 'reported').length;
            // ^ 本轮结算：done 且未到 reported 的行（含旧日志的 null）都算待回报。
            const reported = markReported(record, session, ref);
            const resultMessage = buildRoundResult(record, session.id, limits);
            try {
                appendUserMessage(session, resultMessage);
                record.resultWritten = true;
                record.reportPending = needReport > 0 && reported < needReport;
            }
            catch (error) {
                // 消息没写成功 ⇒ 回报没有证据：把状态回滚成写之前的快照。
                record.statuses = before;
                ctx.logger?.warn?.(`dsh-workplan: 写入结果消息失败：${error instanceof Error ? error.message : String(error)}`);
                /*
                 * [1.8.14] N13: a failed result write is a real, user-visible failure —
                 * the round summary is absent from the transcript and a restart can
                 * disagree with the live phase. Log it durably, not only in the host log.
                 */
                pushRecordError(record, `写入结果消息失败：${error instanceof Error ? error.message : String(error)}`);
                /*
                 * [1.11.0] 写失败时不能假装回报过。保留 reportPending，让下一次
                 * pre-step 或下一轮 finishRound 幂等补齐（契约 §7.3 B4）。
                 */
                record.reportPending = true;
            }
        }
        else {
            /*
             * 旧日志 / 上一次写失败的重试：结果消息已在，但仍有 done 行没到
             * reported。幂等补齐，不重复追加消息。
             */
            const pending = (record.statuses ?? []).some((item) => item?.status === 'done' && item?.closure !== 'reported');
            if (pending) {
                const changed = markReported(record, session, ref);
                if (changed > 0)
                    record.reportPending = false;
            }
        }
        /*
         * [1.5.2] 终态不再依赖「结果消息写成功」这个副作用。
         *
         * 旧代码只有 `record.resultWritten === true` 时才把 phase 升成 done，
         * 于是 session.append 抛错（或该轮根本没有派发）就会永久停在 integrating。
         * 完成语义由 statuses 决定；结果消息只负责持久化，不负责定义完成。
         */
        record.phase = reconcilePhase(record.phase, record.statuses);
        return record;
    }
    /*
     * [1.8.7] `ok` alone was read as "the plan is finished".
     *
     * The incident's tool result said `ok: true` while 3 of 13 subtasks had never
     * run; the rendered line added "已加入进行中的派发并等到结果", so the model
     * had no field telling it the round ended early. `complete`/`remaining` make
     * that state machine-readable instead of a sentence to interpret.
     */
    function completionFields(snapshot, phase, record) {
        const stats = snapshot?.stats ?? {};
        const total = Number(stats.total ?? 0);
        const done = Number(stats.done ?? 0);
        /*
         * [1.8.13] `complete` and `deliveryReady` are different facts.
         *
         * `complete` keeps its old meaning (every subtask done) so existing callers
         * do not break, but a dispatch answer that only said `complete:true` was
         * read as "finished" even when every row was legacy/empty-evidence. The
         * model now also sees whether the plan passed the delivery gate, plus the
         * exact gaps.
         */
        const readiness = record
            ? readinessOf(record, snapshot)
            : deliveryReadiness(snapshot, { phase });
        return {
            complete: total > 0 && done >= total,
            remaining: Math.max(0, total - done),
            deliveryReady: readiness.ready,
            deliveryBlockers: readiness.blockers.slice(0, 12),
            deliveryRemaining: readiness.remaining.slice(0, 20),
        };
    }
    function dispatchSnapshotOf(record, extra = {}) {
        const snapshot = derivePlanSnapshot(record.statuses);
        return {
            ok: true,
            version: pluginVersion,
            runtime: runtimeIdentity(),
            planId: record.plan.planId,
            alreadyRunning: false,
            ...completionFields(snapshot, record.phase, record),
            ...extra,
            phase: record.phase,
            stats: snapshot.stats,
            statuses: modelStatusLines(snapshot.statuses),
        };
    }
    /**
     * Read-only progress probe for the main Agent.
     *
     * With async dispatch the model no longer blocks until the round ends, so it
     * needs a supported way to answer "做成什么样了" without guessing. This is the
     * only source it should read: same `derivePlanSnapshot` as the dashboard and
     * the result message, so all three cannot disagree.
     */
    async function statusTool(agent, args) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内查看计划', 'NO_SESSION');
        const requestedPlanId = typeof args?.planId === 'string' ? args.planId : undefined;
        let record = state.records.get(session.id);
        if (!record?.plan || (requestedPlanId && record.plan.planId !== requestedPlanId)) {
            const rebuilt = reconstructFromSession(session, requestedPlanId);
            if (rebuilt?.plan)
                record = rebuilt;
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
            };
        }
        const running = Boolean(record.dispatchPromise);
        const snapshot = derivePlanSnapshot(record.statuses);
        const readiness = readinessOf(record, snapshot);
        return {
            ok: true,
            version: pluginVersion,
            runtime: runtimeIdentity(),
            planId: record.plan.planId,
            /*
             * [2.2.2][D5] 规划器档位遥测进入模型可读面。
             *
             * 之前只写进内存 record / 失败降级消息；成功计划没有可复核的
             * planner reasoningEffort 证据，D5 只能 CONDITIONAL。现在 status
             * 返回 provider/model/reasoningEffort/source/outcome/at，便于在
             * 真实运行态核对“规划器未继承主 Agent”。
             */
            planner: record.planner ?? null,
            running,
            phase: record.phase,
            elapsedMs: record.dispatchStartedAt ? Date.now() - record.dispatchStartedAt : null,
            stats: snapshot.stats,
            statuses: modelStatusLines(snapshot.statuses),
            errors: (record.errors ?? []).slice(-10),
            resumeLimit: Number(record.resumeLimit ?? limits.maxResumes),
            // [1.10.4] 自动续跑的可观测面：开关、已用轮次、是否已排期、上一次判定码。
            autoResume: autoResumeView(record),
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
        };
    }
    /*
     * [1.9.1] 用户授权的 follow-up 通道。
     *
     * 事故背景：三条子会话 a0d5b134 / 031225ef / 7934905a 在 2026-10-31
     * 23:07–23:23 之间被整轮预算与 900s 子任务上限中止，各自末轮
     * `turn/end = aborted/parent`；界面据此显示 idle（灰色），而台账侧三条
     * 都是 done/structured。用户 2026-11-01 明确同意「补发 follow-up，让圈注
     * 三行真正变绿」——做法是让子会话自己再跑完一个正常回合，而不是伪造
     * turn/end 或改投影缓存。
     *
     * 本工具只做一件事：把一条消息投递到本会话的**直接**子会话。它不写计划
     * 状态、不触发交付、也不改变 `lastTurnCompleted`——那个字段只会被子会话
     * 自己真实完成的回合改写。投递成功后子会话开始新一轮；它正常结束，界面
     * 才可能变绿。失败一律返回 ok:false，不吞错。
     */
    async function followupTool(agent, args, signal) {
        const session = agent?.session;
        if (!session) {
            return { ok: false, code: 'NO_SESSION', error: '只能在会话内补发 follow-up' };
        }
        if (!isRootSession(session)) {
            return { ok: false, code: 'NOT_ROOT', error: '只有根会话可以补发 follow-up' };
        }
        const childId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        const message = typeof args?.message === 'string' ? args.message.trim() : '';
        if (!childId) {
            return { ok: false, code: 'INVALID_SESSION', error: 'sessionId 必填：必须是本会话的直接子会话 ID' };
        }
        if (!message) {
            return { ok: false, code: 'INVALID_MESSAGE', error: 'message 必填：要发给子会话的说明' };
        }
        if (message.length > 4000) {
            return { ok: false, code: 'MESSAGE_TOO_LONG', error: 'message 过长（上限 4000 字符）' };
        }
        if (!spawnedChildIds(session).has(childId)) {
            return {
                ok: false,
                code: 'NOT_DIRECT_CHILD',
                error: `${childId} 不是本会话的直接子会话（父会话 catalog 未登记），拒绝投递`,
            };
        }
        const service = ctx.subagents;
        if (!service || typeof service.sendMessage !== 'function') {
            return {
                ok: false,
                code: 'NO_SUBAGENT_SERVICE',
                error: '当前部署没有可用的 subagent 服务，无法投递 follow-up',
            };
        }
        try {
            const messageId = await service.sendMessage(agent, childId, [{ type: 'text', text: message }], { signal });
            return { ok: true, sessionId: childId, messageId: String(messageId ?? '') };
        }
        catch (error) {
            return {
                ok: false,
                code: 'DELIVERY_FAILED',
                sessionId: childId,
                error: truncate(error instanceof Error ? error.message : String(error), 500),
            };
        }
    }
    /**
     * [1.13.0] 阶段三（验证阶段）的插件核验入口（用户 2026-11-05）。
     *
     * 「按提交内容判阶段」：
     *   - 只有 planning + execution 证据齐全，才会进入阶段三核验；
     *   - 缺 planning/execution 的调用以 PHASE_GATE 拒绝并列出待补项 —— 这是一道
     *     证据门禁，不是对插件的全局禁用（「阶段一、二禁用插件」只是 2026-11-05
     *     当次优化会话的过程约束，2.0.2 起不再作为所有会话的产品规则）；
     *   - 阶段三核验会逐条检查：问题梳理/可执行思路是否有实质内容、执行步骤
     *     是否记录、验证是否全部通过、验证记录是否覆盖全部验收标准。
     *
     * 它不写状态、不替子 Agent 宣称完成：最终是否 done 仍由 `adjudicateResult`
     * 对同一份 phases 再判一次，避免「核验工具说通过」与「结果块没写」两套真相。
     */
    async function verifySubtask(agent, args) {
        const childSession = agent?.session;
        if (!childSession?.id) {
            return { ok: false, code: 'NO_SESSION', passed: false, error: '只能在部门子会话内做阶段三核验' };
        }
        const parentId = childSession.header?.parentSession;
        if (!parentId) {
            return {
                ok: false,
                code: 'NOT_CHILD_SESSION',
                passed: false,
                error: '当前不是子会话，无法反查父计划；三阶段核验只对已派发的部门子任务开放',
            };
        }
        let record = state.records.get(parentId);
        if (!record?.plan) {
            const parent = ctx.sessions?.get?.(parentId);
            if (parent) {
                try {
                    record = reconstructFromSession(parent);
                }
                catch (error) {
                    pushRecordError({ errors: [] }, error);
                }
            }
        }
        if (!record?.plan) {
            return { ok: false, code: 'NO_PLAN', passed: false, error: '父会话没有可关联的计划，无法核验' };
        }
        const row = (record.statuses ?? []).find((item) => item?.childId === childSession.id);
        if (!row) {
            return { ok: false, code: 'NO_SUBTASK', passed: false, error: '计划里找不到与本子会话关联的子任务（childId 未登记）' };
        }
        if (row.status === 'done') {
            return { ok: false, code: 'ALREADY_DONE', passed: false, subtaskId: row.subtaskId, error: '该子任务已标记完成，无需再次核验' };
        }
        const found = findSubtask(record.plan, row.subtaskId);
        const expectedAcceptance = Array.isArray(found?.subtask?.acceptance) ? found.subtask.acceptance : [];
        const rawPhases = isRecord(args?.phases)
            ? args.phases
            : { planning: args?.planning, execution: args?.execution, verification: args?.verification };
        const check = validatePhaseEvidence(rawPhases, expectedAcceptance);
        if (!check.ok || !check.phases) {
            const gate = phaseGateFromErrors(check.errors);
            return {
                ok: false,
                passed: false,
                code: gate === 'phase-1-2' ? 'PHASE_GATE' : 'VERIFICATION_INCOMPLETE',
                phase: gate,
                planId: record.plan.planId,
                subtaskId: row.subtaskId,
                gaps: check.errors,
                error: gate === 'phase-1-2'
                    ? `阶段三核验缺少前两阶段证据：先完成「梳理问题 → 形成可执行思路」并实际执行，再提交阶段三核验。${check.errors.slice(0, 5).join('；')}`
                    : `阶段三核验未通过：${check.errors.slice(0, 5).join('；')}`,
            };
        }
        return {
            ok: true,
            passed: true,
            phase: 'verification',
            planId: record.plan.planId,
            subtaskId: row.subtaskId,
            summary: phaseSummaryLine(check.phases),
            message: '插件核验通过：三阶段证据齐全、验证全部通过。现在把同一份 phases 写进结果块并提交。',
        };
    }
    /**
     * [1.11.0] 子 → 父的唯一反向通道（T4 C-09 / T6 M5）。
     *
     * 子会话只知道自己的 `session.id` 和父会话 id。这里用父链 + `childId` 反查
     * 子任务，而不是相信子 Agent 自报的 subtaskId：自报值可以写错，父链不会。
     * 写入仍是 `applyStatus`（唯一写入口），并同步落一条 durable update，刷新后
     * 「有一条请示在等指示」不会退回 pending。
     */
    async function escalateSubtask(agent, args) {
        const childSession = agent?.session;
        if (!childSession?.id) {
            return { ok: false, code: 'NO_SESSION', error: '只能在子会话内上报遇阻' };
        }
        const parentId = childSession.header?.parentSession;
        if (!parentId) {
            return {
                ok: false,
                code: 'NOT_CHILD_SESSION',
                error: '当前不是子会话，无法反查父计划；请直接在结果块写 status=blocked + question',
            };
        }
        let record = state.records.get(parentId);
        if (!record?.plan) {
            const parent = ctx.sessions?.get?.(parentId);
            if (parent) {
                try {
                    record = reconstructFromSession(parent);
                }
                catch (error) {
                    pushRecordError({ errors: [] }, error);
                }
            }
        }
        if (!record?.plan) {
            return {
                ok: false,
                code: 'NO_PLAN',
                error: '父会话没有可关联的计划；请在结果块写 status=blocked + question，由主 Agent 处理',
            };
        }
        const row = (record.statuses ?? []).find((item) => item?.childId === childSession.id);
        if (!row) {
            return {
                ok: false,
                code: 'NO_SUBTASK',
                error: '计划里找不到与本子会话关联的子任务（childId 未登记）；请在结果块写 status=blocked + question',
            };
        }
        if (row.status === 'done') {
            return { ok: false, code: 'ALREADY_DONE', subtaskId: row.subtaskId, error: '该子任务已标记完成，不能再提交请示' };
        }
        const question = truncate(String(args?.question ?? '').trim(), MAX_QUESTION_CHARS);
        if (!question) {
            return { ok: false, code: 'INVALID_QUESTION', subtaskId: row.subtaskId, error: 'question 必填：写清需要主 Agent 决定的单个问题' };
        }
        if (row.closure === 'escalated') {
            return {
                ok: true,
                alreadyEscalated: true,
                planId: record.plan.planId,
                subtaskId: row.subtaskId,
                status: 'blocked',
                closure: 'escalated',
                question: row.question ?? question,
                message: '这条请示已经在上报队列里，不要重复提交；停止推进，等待主 Agent 指示。',
            };
        }
        // [2.2.6][T4] 同模式共犯（T1 W4）：对象感知读取，消灭 String(对象) 分支。
        const options = (Array.isArray(args?.options) ? args.options : [])
            .slice(0, MAX_ESCALATION_OPTIONS)
            .map((item) => truncate(needEntryText(item), 300))
            .filter(Boolean);
        const needs = (Array.isArray(args?.needs) ? args.needs : [])
            .slice(0, 10)
            .map((item) => truncate(needEntryText(item), 300))
            .filter(Boolean);
        const now = Date.now();
        const revision = Number(row.revision ?? 0) + 1;
        record.statuses = applyStatus(record.statuses, row.subtaskId, {
            status: 'blocked',
            closure: 'escalated',
            blockedKind: 'escalated',
            question,
            options,
            needs: [...(Array.isArray(row.needs) ? row.needs : []), ...needs],
            progress: 100,
            finishedAt: now,
            error: question,
            summary: `待指示：${question}`,
            escalatedAt: now,
            escalationSeq: revision,
            revision,
            updatedBy: 'child',
        });
        record.updatedAt = now;
        try {
            const parent = ctx.sessions?.get?.(parentId);
            const written = record.statuses.find((item) => item?.subtaskId === row.subtaskId);
            appendUserMessage(parent, buildUpdateMessage({
                planId: record.plan.planId,
                subtaskId: row.subtaskId,
                status: 'blocked',
                closure: 'escalated',
                blockedKind: 'escalated',
                question,
                options,
                needs: written?.needs,
                escalatedAt: now,
                escalationSeq: revision,
                revision,
            }));
        }
        catch (error) {
            pushRecordError(record, error);
        }
        return {
            ok: true,
            planId: record.plan.planId,
            subtaskId: row.subtaskId,
            status: 'blocked',
            closure: 'escalated',
            question,
            revision,
            message: '已上报主 Agent。请立即停止推进，只允许做只读核对；等待指示期间不要开始新的写入或大改。',
        };
    }
    /**
     * [1.11.0] 指示回执（T4 B5 / M6，T10 N4）。
     *
     * 指示投递成功只证明消息进了收件箱，不证明子会话真的开始执行。三个观察点
     * 都以「该行仍是 instructed 且 instructionSeq 未变」为前提：
     *  - 轮询：子会话 seq 增长 = 已开始执行 → 写 acknowledged（唯一正向回执）；
     *  - 60s：仍无增长 → 写 `instructionOverdue`（界面显示、主 Agent 可催）；
     *  - 180s：仍无增长 → 收束为 blocked/no-ack（不再无限等待）。
     * 主 Agent 再次改判或子会话产出结果都会让这三个观察点自然作废。
     */
    function scheduleInstructionAck(record, subtaskId, childId, revision) {
        const rowOf = () => record.statuses.find((item) => item?.subtaskId === subtaskId);
        const readSeq = () => {
            try {
                const seq = Number(ctx.sessions?.get?.(childId)?.seq);
                return Number.isFinite(seq) ? seq : undefined;
            }
            catch {
                return undefined;
            }
        };
        const baseline = readSeq();
        let stopped = false;
        const timers = [];
        const stop = () => {
            if (stopped)
                return;
            stopped = true;
            for (const timer of timers) {
                clearTimeout(timer);
                clearInterval(timer);
            }
        };
        const sameAttempt = (row) => {
            if (stopped)
                return false;
            if (!row || row.closure !== 'instructed')
                return false;
            return Number(row.instructionSeq ?? 0) === Number(revision);
        };
        const unchanged = (row) => {
            if (!sameAttempt(row))
                return false;
            const seq = readSeq();
            if (seq === undefined || baseline === undefined)
                return true;
            return seq <= baseline;
        };
        /*
         * 正向回执：没有这一步时，一个正常工作但耗时较长的子会话会在 180s 被
         * 误判成 no-ack 并阻断，而它其实早就在产出事件了。
         */
        const poll = setInterval(() => {
            const row = rowOf();
            if (!sameAttempt(row)) {
                stop();
                return;
            }
            const seq = readSeq();
            if (seq === undefined || baseline === undefined || seq <= baseline)
                return;
            try {
                writeSubtaskStatus(record, subtaskId, {
                    closure: 'acknowledged',
                    ackedAt: Date.now(),
                    ackEvidence: { seq, elapsedMs: Date.now() - Number(row.instruction?.at ?? Date.now()) },
                    instructionOverdue: false,
                    progress: Math.max(Number(row.progress ?? 0), 15),
                }, { timedOut: false });
            }
            catch {
                // Row moved on between read and write; the next tick re-evaluates.
                return;
            }
            stop();
        }, INSTRUCTION_POLL_MS);
        poll.unref?.();
        timers.push(poll);
        const notice = setTimeout(() => {
            if (!unchanged(rowOf()))
                return;
            try {
                writeSubtaskStatus(record, subtaskId, { instructionOverdue: true }, { timedOut: false });
            }
            catch {
                // The row moved on between the read and the write; nothing to report.
            }
        }, INSTRUCTION_ACK_NOTICE_MS);
        notice.unref?.();
        timers.push(notice);
        const deadline = setTimeout(() => {
            if (!unchanged(rowOf())) {
                stop();
                return;
            }
            const seconds = Math.round(INSTRUCTION_ACK_DEADLINE_MS / 1000);
            const message = `指示下发后 ${seconds}s 子会话仍无任何新事件（no-ack）：指示没有被执行`;
            try {
                writeSubtaskStatus(record, subtaskId, {
                    status: 'blocked',
                    closure: 'blocked',
                    blockedKind: 'no-ack',
                    progress: 100,
                    finishedAt: Date.now(),
                    instructionOverdue: true,
                    error: message,
                    summary: `未完成：${message}`,
                }, { timedOut: false });
                recordSubtaskError(record, subtaskId, message, { timedOut: false });
            }
            catch {
                // Same race as above: the row already left instructed.
            }
            stop();
        }, INSTRUCTION_ACK_DEADLINE_MS);
        deadline.unref?.();
        timers.push(deadline);
    }
    /**
     * [1.11.0] 主 → 子下发指示（T4 C-10 / T6 M6）。
     *
     * 只有根会话能调用；只接受 `closure:'escalated'` 的行；只投递给本会话直接
     * 子会话。投递失败时不改状态（不伪造成「已指示」），把错误原样交给主 Agent。
     */
    async function instructSubtask(agent, args, signal, existingRecord) {
        const session = agent?.session;
        if (!session)
            return { ok: false, code: 'NO_SESSION', error: '只能在会话内下发指示' };
        if (!isRootSession(session))
            return { ok: false, code: 'NOT_ROOT', error: '只有根会话可以下发指示' };
        let record = existingRecord ?? state.records.get(session.id);
        if (!record?.plan)
            record = reconstructFromSession(session, args?.planId);
        record = adoptRequestedPlan(session, record, args?.planId);
        if (!record?.plan)
            return { ok: false, code: 'NO_PLAN', error: '当前会话还没有已生成的计划' };
        clearAutoResumeTimer(record, 'manual-instruct');
        const subtaskId = typeof args?.subtaskId === 'string' ? args.subtaskId.trim() : '';
        if (!subtaskId)
            return { ok: false, code: 'MISSING_SUBTASK', error: '缺少 subtaskId' };
        const current = record.statuses.find((item) => item?.subtaskId === subtaskId);
        if (!current)
            return { ok: false, code: 'UNKNOWN_SUBTASK', subtaskId, error: `未知子任务：${subtaskId}` };
        if (current.closure !== 'escalated') {
            return {
                ok: false,
                code: 'NOT_ESCALATED',
                subtaskId,
                error: '该子任务不在待指示状态；普通受阻请用 dsh_workplan_update 改判',
            };
        }
        const instruction = truncate(String(args?.instruction ?? args?.text ?? '').trim(), MAX_INSTRUCTION_CHARS);
        if (!instruction)
            return { ok: false, code: 'INVALID_INSTRUCTION', subtaskId, error: 'instruction 必填：写清要子 Agent 执行的决定' };
        const childId = typeof current.childId === 'string' ? current.childId : '';
        if (!childId)
            return { ok: false, code: 'NO_CHILD', subtaskId, error: '该行没有关联子会话，无法投递指示' };
        if (!spawnedChildIds(session).has(childId)) {
            return { ok: false, code: 'NOT_DIRECT_CHILD', subtaskId, error: `${childId} 不是本会话的直接子会话，拒绝投递` };
        }
        const service = ctx.subagents;
        if (!service || typeof service.sendMessage !== 'function') {
            return { ok: false, code: 'NO_SUBAGENT_SERVICE', subtaskId, error: '当前部署没有可用的 subagent 服务，无法投递指示' };
        }
        let messageId = '';
        try {
            messageId = String(await service.sendMessage(agent, childId, [{
                    type: 'text',
                    text: [
                        '【主 Agent 指示（对应你此前提交的请示）】',
                        instruction,
                        '',
                        '请按上述指示继续原任务。若仍受阻，先调用 dsh_workplan_escalate 再次上报，然后停止推进等待指示；不要自行猜测未被回答的部分。',
                    ].join('\n'),
                }], { signal }) ?? '');
        }
        catch (error) {
            return {
                ok: false,
                code: 'DELIVERY_FAILED',
                subtaskId,
                error: truncate(error instanceof Error ? error.message : String(error), 500),
                hint: '状态未改变，该行仍是待指示；可重试，或用 dsh_workplan_followup 直接投递同一段指示。',
            };
        }
        const now = Date.now();
        const revision = Number(current.revision ?? 0) + 1;
        record.statuses = applyStatus(record.statuses, subtaskId, {
            status: 'in_progress',
            closure: 'instructed',
            instruction: { text: instruction, at: now, by: 'agent', messageId, delivery: 'sent' },
            instructionSeq: revision,
            progress: Math.max(Number(current.progress ?? 0), 15),
            finishedAt: null,
            error: null,
            question: null,
            options: [],
            blockedKind: null,
            ackOverdue: false,
            ackedAt: null,
            ackEvidence: undefined,
            revision,
            updatedBy: 'agent',
        });
        /*
         * [1.11.0] 指示会解除「受阻」（T10 N3）。
         *
         * 行从 blocked/escalated 变成 in_progress/instructed 后，缓存的
         * `record.phase` 仍是 blocked；`reconcilePhase` 现在允许 blocked 在有
         * 活跃行时让位给 executing，这里必须重新对账，否则卡片继续显示
         * 「卡住了」，与事实相反。
         */
        record.phase = reconcilePhase(record.phase, record.statuses);
        record.updatedAt = now;
        try {
            const written = record.statuses.find((item) => item?.subtaskId === subtaskId);
            appendUserMessage(session, buildUpdateMessage({
                planId: record.plan.planId,
                subtaskId,
                status: 'in_progress',
                closure: 'instructed',
                instruction: written?.instruction,
                instructionSeq: revision,
                revision,
            }));
        }
        catch (error) {
            pushRecordError(record, error);
        }
        scheduleInstructionAck(record, subtaskId, childId, revision);
        const snapshot = derivePlanSnapshot(record.statuses);
        const readiness = readinessOf(record, snapshot);
        return {
            ok: true,
            planId: record.plan.planId,
            subtaskId,
            status: 'in_progress',
            closure: 'instructed',
            revision,
            messageId,
            stats: snapshot.stats,
            deliveryReady: readiness.ready,
            hint: '指示已投递，该行已变为「已收到指示」。子 Agent 会开启新一轮；完成前仍不得交付。',
        };
    }
    /**
     * [1.11.0] 工具层入口：子会话的遇阻上报（T4 C-09 / T6 M5）。
     *
     * 单独一层包装而不是让 host 直接调内部函数：`escalateSubtask` 需要
     * `record`/`ctx` 闭包，host 侧只拿得到 runtime 的公开面；这一层也是
     * 唯一被 `dsh_workplan_escalate` 触发的地方，便于测试替身注入。
     */
    async function escalateTool(agent, args) {
        return escalateSubtask(agent, args);
    }
    /**
     * [1.11.0] 工具层入口：主 Agent 下发指示（T4 C-10 / T6 M6）。
     *
     * 前置校验（根会话、escalated、直接子会话、非空 instruction）全部在
     * `instructSubtask` 里，这一层只转发 —— 校验留在唯一实现处，两个入口
     * （工具与 `dsh_workplan_update` 的 instruction 字段）才不会分叉。
     */
    async function instructTool(agent, args, signal) {
        return instructSubtask(agent, args, signal);
    }
    /**
     * [1.11.0] 跨部门需求的唯一处置入口（用户 m00687）。
     *
     * 子 Agent 只能「提出」需求（needs → open handoff），不能宣称需求已解决；
     * 只有根会话的主 Agent 能把一条需求指派给部门（routed）、写入书面答复
     * （answered）或判定无需动作（closed）。处置结果写回同一条状态行并追加
     * 一条可回放的人工改判消息，刷新后仍然有效。
     */
    async function handoffTool(agent, args, signal) {
        const session = agent?.session;
        if (!session)
            return { ok: false, code: 'NO_SESSION', error: '只能在会话内处置跨部门需求' };
        if (!isRootSession(session))
            return { ok: false, code: 'NOT_ROOT', error: '只有根会话可以处置跨部门需求' };
        let record = state.records.get(session.id);
        if (!record?.plan)
            record = reconstructFromSession(session, args?.planId);
        record = adoptRequestedPlan(session, record, args?.planId);
        if (!record?.plan)
            return { ok: false, code: 'NO_PLAN', error: '当前会话还没有已生成的计划' };
        const action = ['list', 'assign', 'resolve', 'close'].includes(args?.action) ? args.action : '';
        if (!action)
            return { ok: false, code: 'INVALID_ACTION', error: 'action 必须是 list / assign / resolve / close' };
        if (action === 'list') {
            const rows = (record.statuses ?? []).flatMap((row) => openHandoffs(row).map((handoff) => ({
                subtaskId: row.subtaskId,
                id: handoff.id,
                department: handoff.department,
                status: handoff.status,
                request: handoff.request,
            })));
            return { ok: true, planId: record.plan.planId, handoffs: rows, count: rows.length };
        }
        const subtaskId = typeof args?.subtaskId === 'string' ? args.subtaskId.trim() : '';
        if (!subtaskId)
            return { ok: false, code: 'MISSING_SUBTASK', error: '缺少 subtaskId' };
        const row = record.statuses.find((item) => item?.subtaskId === subtaskId);
        if (!row)
            return { ok: false, code: 'UNKNOWN_SUBTASK', subtaskId, error: `未知子任务：${subtaskId}` };
        const handoffs = normaliseHandoffs(row.handoffs);
        const wanted = typeof args?.handoffId === 'string' ? args.handoffId.trim() : '';
        const index = wanted
            ? handoffs.findIndex((item) => item.id === wanted)
            : handoffs.findIndex((item) => item.status === 'open' || item.status === 'routed');
        if (index < 0) {
            return {
                ok: false,
                code: wanted ? 'UNKNOWN_HANDOFF' : 'NO_OPEN_HANDOFF',
                subtaskId,
                error: wanted ? `未知跨部门需求：${wanted}` : '该行没有待处理的跨部门需求',
            };
        }
        const handoff = handoffs[index];
        if (action === 'assign') {
            const department = typeof args?.department === 'string' ? args.department.trim() : '';
            if (!DEPARTMENTS[department]) {
                return { ok: false, code: 'INVALID_DEPARTMENT', error: `department 必须是 ${DEPARTMENT_IDS.join(' / ')} 之一` };
            }
            handoffs[index] = { ...handoff, department, status: 'routed', updatedAt: Date.now(), by: 'agent' };
        }
        else if (action === 'resolve') {
            const response = truncate(String(args?.response ?? '').trim(), MAX_HANDOFF_RESPONSE_CHARS);
            if (!response)
                return { ok: false, code: 'INVALID_RESPONSE', error: 'resolve 必须写清答复或已由哪项产物满足该需求' };
            handoffs[index] = { ...handoff, status: 'answered', response, updatedAt: Date.now(), by: 'agent' };
        }
        else {
            handoffs[index] = { ...handoff, status: 'closed', response: handoff.response ?? null, updatedAt: Date.now(), by: 'agent' };
        }
        const revision = Number(row.revision ?? 0) + 1;
        record.statuses = applyStatus(record.statuses, subtaskId, {
            handoffs,
            revision,
            updatedBy: 'agent',
        });
        record.updatedAt = Date.now();
        try {
            appendUserMessage(session, buildUpdateMessage({
                planId: record.plan.planId,
                subtaskId,
                status: row.status,
                handoffs,
                revision,
            }));
        }
        catch (error) {
            pushRecordError(record, error);
        }
        /*
         * [1.11.0] 答复必须真的送到还在等它的子会话（用户 m00687）。
         *
         * 如果提出需求的行正处于「待指示」，它此刻停在那里等主 Agent：只把
         * handoff 写成 answered、不发指示，子会话永远不会继续，需求闭环只闭在
         * 计划表里。这里复用 instructSubtask 的唯一投递/回执链路（写 instructed、
         * 60s/180s 回执、下次激活注入），不另造第二条消息通道。
         * 投递失败不回滚 handoff：答复本身是真的，失败原因如实返回给主 Agent。
         */
        let instruction = null;
        if (action === 'resolve' && row.closure === 'escalated' && handoffs[index]?.response) {
            const answer = handoffs[index];
            instruction = await instructSubtask(agent, {
                planId: record.plan.planId,
                subtaskId,
                instruction: `跨部门需求 ${answer.id} 已答复${answer.department ? `（${answer.department}）` : ''}：${answer.response}。按此答复继续原任务。`,
            }, signal);
        }
        const finalReadiness = readinessOf(record, derivePlanSnapshot(record.statuses));
        return {
            ok: true,
            planId: record.plan.planId,
            subtaskId,
            handoff: record.statuses.find((item) => item?.subtaskId === subtaskId)?.handoffs?.[index] ?? null,
            deliveryReady: finalReadiness.ready,
            deliveryBlockers: finalReadiness.blockers,
            ...(instruction ? { instruction } : {}),
            hint: action === 'assign'
                ? '已登记责任部门。插件没有常驻部门代理：这次指派不会自动产生工作，请用 dsh_workplan_replan(action=add) 建一个该部门的子任务，或由你直接完成，再用 action=resolve 写入答复或产物引用；否则交付仍被拦住。'
                : instruction && instruction.ok !== true
                    ? '答复已记录，但投递到子会话失败：该行仍是待指示，按返回的 instruction.error 重试或改用 dsh_workplan_instruct。'
                    : '已记录处置结果；交付阻塞按最新状态重新计算。',
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
        /*
         * [1.10.4] 人工/工具派发优先于自动续跑：撤销待触发的定时器，并把自动
         * 轮次计数归零（这一次是外部授权的新起点）。done 水位取当前值，下一轮
         * 结束后才能正确判断「有没有新增完成项」。
         */
        clearAutoResumeTimer(record, 'manual-dispatch');
        {
            const book = autoResumeBook(record);
            book.attempt = 0;
            book.noProgressRounds = 0;
            book.doneBefore = Number(derivePlanSnapshot(record.statuses).stats?.done ?? 0);
        }
        if (args?.planId && record.plan.planId !== args.planId) {
            throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH');
        }
        /*
         * [1.8.15] Cancelled is terminal: dispatch must refuse, not resurrect.
         *
         * T4e F1/C16 proved the old path answered `ok: true` and really started
         * department Agents on a cancelled plan (`activationCalled: true`), and a
         * 2/2-done cancelled plan was silently rewritten to `phase: done`. Cancel
         * is the user's stop signal; the only honest answer is a refusal that says
         * how to continue deliberately (a new plan, or the main Agent takes over).
         */
        if (isTerminalPhase(record.phase) || record.cancelled === true) {
            /*
             * [1.9.0] 终态集合：cancelled（用户撤销）与 superseded（责任已转移）
             * 都不允许派发、不允许复活。superseded 用独立拒绝码，便于调用方区分
             * 「用户叫停」与「已被别的计划承接」。cancelled 的返回体与 1.8.19 相同。
             */
            const superseded = record.phase === 'superseded';
            const snapshot = derivePlanSnapshot(record.statuses);
            return {
                ok: false,
                planId: record.plan.planId,
                phase: superseded ? 'superseded' : 'cancelled',
                running: false,
                alreadyRunning: false,
                complete: false,
                remaining: Math.max(0, Number(snapshot.stats.total ?? 0) - Number(snapshot.stats.done ?? 0)),
                stats: snapshot.stats,
                code: superseded ? 'PLAN_SUPERSEDED' : 'PLAN_CANCELLED',
                error: superseded
                    ? '计划已被取代：不会再启动任何部门 Agent'
                    : '计划已取消：取消只停止执行，不会再启动任何部门 Agent',
                hint: superseded
                    ? '不要再次派发。被取代不等于完成：如需交付，请按覆盖链核对承接计划的证据；承接计划未就绪时不得调用 present。'
                    : '不要再次派发。如需继续这项工作，请向用户确认后重新生成计划；或由主 Agent 直接接手剩余项，并在答复中说明这是直接执行而非派发。',
            };
        }
        /*
         * [1.7.0] Two dispatch modes.
         *
         * `wait` (default, backward compatible) blocks until the round ends.
         * `async` starts the round and returns immediately, so the main Agent can
         * answer the user and keep integrating instead of sitting blind inside a
         * tool call for twenty minutes (the top-ranked collaboration break C1).
         */
        const mode = args?.mode === 'async' ? 'async' : 'wait';
        if (mode === 'wait' && record.dispatchPromise) {
            /*
             * A wait caller that meets an in-flight round joins it instead of being
             * told "already running" — the old answer carried no results at all, so
             * a model that missed the async result message had nothing to integrate.
             * A wedged promise keeps the old stale escape hatch (see below).
             */
            const startedAt = Number(record.dispatchStartedAt ?? 0);
            const staleAfter = limits.totalTimeoutMs > 0 ? limits.totalTimeoutMs + 120000 : NO_ROUND_BUDGET_MS + 120000;
            if (!(startedAt > 0 && Date.now() - startedAt > staleAfter)) {
                try {
                    await record.dispatchPromise;
                }
                catch (error) {
                    pushRecordError(record, error);
                }
                finishRound(record, session);
                state.records.set(session.id, record);
                return dispatchSnapshotOf(record, { joined: true });
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
            const startedAt = Number(record.dispatchStartedAt ?? 0);
            const staleAfter = limits.totalTimeoutMs > 0 ? limits.totalTimeoutMs + 120000 : NO_ROUND_BUDGET_MS + 120000;
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
            /*
             * [1.7.0] The idempotent answer now carries the progress itself.
             *
             * It used to say only `alreadyRunning: true`, so a second dispatch gave
             * the model strictly less information than doing nothing.
             */
            const live = derivePlanSnapshot(record.statuses);
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
            };
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
        const roundOptions = {
            agent,
            modelSelection: selection.provider && selection.model ? selection : record.modelSelection,
            cwd: session.header?.cwd ?? options.cwd,
            conversationContext: record.conversationContext ?? '',
            /*
             * [2.2.0][T6/O-1a] 只有后台（async）轮次推即时通知：wait 模式主 Agent
             * 在调用栈内等待，轮级结果消息就是该模式的完成通道，避免同一轮重复
             * 两条消息；既有的「每轮恰 1 条持久结果消息」断言因此保持不变。
             */
            notifyCompletion: mode === 'async',
            onSubtaskDone: (recordArg, subtask, verdict) => emitSubtaskDoneNotice(recordArg, session, subtask, verdict),
        };
        record.dispatchPromise = dispatchPlan(ctx, record, {
            ...roundOptions,
            signal: dispatchController.signal,
            // [2.2.0][T4/O-3b] 传原始配置值：未配置=undefined 时协商派生生效，显式配置=兜底上限（resolveSubtaskTimeoutMs）。
            childTimeoutMs: options.childTimeoutMs,
            idleTimeoutMs: limits.idleTimeoutMs,
            totalTimeoutMs: limits.totalTimeoutMs,
            maxResumes: limits.maxResumes,
            /*
             * [1.11.0] 严格完成是运行时级配置，不是每个调用点各传一份。
             * 漏传会让 `strictCompletion:false` 的部署读到默认 true，行为无法预期。
             */
            strictEvidence: options.strictEvidence,
        }).finally(() => {
            record.dispatchPromise = null;
            record.dispatchStartedAt = null;
            record.abortDispatch = null;
            signal?.removeEventListener?.('abort', onToolAbort);
        });
        if (mode === 'async') {
            /*
             * Settlement happens in the background: the same durable result message
             * is appended when the round ends, so a page refresh (or a later turn)
             * still sees the outcome. The returned values are a *starting* snapshot,
             * never a completion claim.
             */
            const startedAt = record.dispatchStartedAt;
            record.dispatchPromise
                .then(() => {
                finishRound(record, session);
                state.records.set(session.id, record);
                armAutoResume(record, session, roundOptions);
            })
                .catch((error) => {
                pushRecordError(record, error);
                finishRound(record, session);
                state.records.set(session.id, record);
                armAutoResume(record, session, roundOptions);
            });
            const live = derivePlanSnapshot(record.statuses);
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
            };
        }
        await record.dispatchPromise;
        finishRound(record, session);
        armAutoResume(record, session, roundOptions);
        /*
         * The model's dispatch result reports the same snapshot the dashboard will
         * show. It used to send `record.stats` while the status list below was read
         * fresh, so one reply could say “已完成 11” next to twelve finished rows.
         */
        return dispatchSnapshotOf(record);
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
    const STOP_STEER_LIMIT = 2;
    function recordReadiness(record) {
        return readinessOf(record);
    }
    function stopGateApplies(record, session, turn) {
        if (!record?.plan)
            return false;
        if (record.degraded)
            return false;
        /*
         * [1.9.0] 终态不再触发收尾 steer —— 这正是死锁的第二个出口（T8 I7）。
         * cancelled 只有在本回合被结构化点名时才提醒一次（present 仍会硬拦）；
         * superseded 不 steer：它的判定对象是承接计划，present 的拒绝文案已给出出路。
         */
        if (isTerminalPhase(record.phase)) {
            return record.phase === 'cancelled'
                && Boolean(session && turn && planIdFromTurn(session, turn) === record.plan.planId);
        }
        const readiness = recordReadiness(record);
        if (Number(readiness.total ?? 0) === 0)
            return false;
        return !readiness.ready;
    }
    function planChildIds(record) {
        const ids = new Set();
        for (const item of record?.statuses ?? []) {
            if (typeof item?.childId === 'string' && item.childId)
                ids.add(item.childId);
        }
        for (const stage of record?.plan?.stages ?? []) {
            for (const subtask of stage?.subtasks ?? []) {
                if (typeof subtask?.childId === 'string' && subtask.childId)
                    ids.add(subtask.childId);
            }
        }
        return ids;
    }
    const PLAN_CONTINUATION_KINDS = new Set(['subagent-settled', 'workplan-result', 'workplan-continue']);
    /**
     * [1.8.9] 子会话谱系判定。
     *
     * `childId` 在预算重置时会被清空（`applyStatus({status:'pending'})` 走
     * `normaliseStatusEntry` 强制 childId=null），事故里的 T11 因此不在
     * planChildIds 中，turn 2 又一次绕过闸门。`header.parentSession` 是子会话
     * 自身的身份，预算与重启都不会改写它，用它旁证“这条结算来自本计划的执行者”。
     */
    function isChildSessionOf(senderId, session) {
        if (!senderId)
            return false;
        try {
            const child = ctx.sessions?.get?.(senderId);
            const header = child?.header;
            if (!header)
                return false;
            return header.parentSession === session.id;
        }
        catch {
            return false;
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
    const spawnedChildCache = new Map();
    function spawnedChildIds(session) {
        const cached = spawnedChildCache.get(session.id);
        if (cached && cached.at === session.seq)
            return cached.ids;
        const ids = new Set();
        if (typeof session?.eventAt === 'function') {
            for (let i = 0; i < session.seq; i += 1) {
                let event;
                try {
                    event = session.eventAt(i);
                }
                catch {
                    continue;
                }
                if (event?.type === 'subagent/catalog' && typeof event.data?.childId === 'string') {
                    ids.add(event.data.childId);
                }
            }
        }
        spawnedChildCache.set(session.id, { at: session.seq, ids });
        return ids;
    }
    /*
     * [1.8.14] N5：结算回合要判的是「这条结算对应的计划」，不是「最后生成的计划」。
     *
     * 重启后内存为空时，收尾闸门原本走默认回放（最后一个 plan 消息）：事故会话在
     * A 未完成时又生成了 B，A 的结果随后到达，闸门于是按 B 判定。结算输入
     * （workplan-result）自带 planId；显式传 planId 还能触发 1.8.10 的窗口前移，
     * 旧计划落在 2000 事件窗口外时也能重建。
     */
    function planIdFromTurn(session, turn) {
        if (typeof session?.eventAt !== 'function' || !(turn >= 1))
            return undefined;
        let started = -1;
        for (let i = session.seq - 1; i >= 0; i -= 1) {
            const event = session.eventAt(i);
            if (event?.type === 'turn/start' && Number(event.data?.turn) === turn) {
                started = i;
                break;
            }
        }
        if (started < 0)
            return undefined;
        for (let i = started + 1; i < session.seq; i += 1) {
            const event = session.eventAt(i);
            if (!event)
                continue;
            if (event.type === 'turn/end' && Number(event.data?.turn) === turn)
                break;
            if (event.type !== 'user/message')
                continue;
            const data = event.data?.message ?? event.data;
            if (!data || typeof data !== 'object')
                continue;
            /*
             * planId 不在信封上：结果消息的 planId 在正文标记之间的 JSON 里，
             * plan 消息的 planId 在 plan 对象里。两者都走已有的解析器，避免
             * 对消息形状再发明一套假设。
             */
            const result = parseResultMessage(data);
            if (result && typeof result.planId === 'string' && result.planId)
                return result.planId;
            const planMessage = parseWorkplanMessage(data);
            const planId = planMessage?.plan?.planId;
            if (typeof planId === 'string' && planId)
                return planId;
        }
        return undefined;
    }
    /**
     * [1.8.15] 当前正在进行的回合号；没有打开中的回合时返回 undefined。
     *
     * `present` 的闸门需要知道「这一回合在结算哪个计划」。默认回放回答的是
     * 「最后定义的计划」，在 A 定义、B 后定义、A 的结果在 B 之后到达时会判错
     * 计划（T3 B5）。这里不新增状态，只从会话尾部回扫 `turn/start`；遇到
     * `turn/end` 说明当前没有打开中的回合。
     */
    function currentTurnOf(session) {
        if (typeof session?.eventAt !== 'function')
            return undefined;
        for (let i = session.seq - 1; i >= 0; i -= 1) {
            let event;
            try {
                event = session.eventAt(i);
            }
            catch {
                return undefined;
            }
            if (!event)
                continue;
            if (event.type === 'turn/start') {
                const turn = Number(event.data?.turn);
                return Number.isFinite(turn) && turn >= 1 ? turn : undefined;
            }
            if (event.type === 'turn/end')
                return undefined;
        }
        return undefined;
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
    function turnCarriesPlanWork(session, turn, record) {
        if (typeof session?.eventAt !== 'function' || !(turn >= 1))
            return false;
        const childIds = planChildIds(record);
        let started = -1;
        for (let i = session.seq - 1; i >= 0; i -= 1) {
            const event = session.eventAt(i);
            if (event?.type === 'turn/start' && Number(event.data?.turn) === turn) {
                started = i;
                break;
            }
        }
        if (started < 0)
            return false;
        for (let i = started + 1; i < session.seq; i += 1) {
            const event = session.eventAt(i);
            if (!event)
                continue;
            if (event.type === 'turn/end' && Number(event.data?.turn) === turn)
                break;
            if (event.type !== 'user/message')
                continue;
            const message = event.data?.message ?? event.data;
            const source = message?.source ?? {};
            const kind = String(source.kind ?? '');
            if (!PLAN_CONTINUATION_KINDS.has(kind))
                continue;
            if (kind === 'subagent-settled') {
                const sender = String(source.senderSessionId ?? '');
                /*
                 * 只认“本计划派出过的 child”“本会话的真实子会话”或“父会话 spawn
                 * 记录里出现过的 child”。第三者是 dispose 之后唯一还能取到的证据；
                 * 三者都不命中时，无关后台任务不能把闸门误激活。
                 */
                if (!childIds.has(sender) && !isChildSessionOf(sender, session) && !spawnedChildIds(session).has(sender))
                    continue;
            }
            return true;
        }
        return false;
    }
    async function onTurnStopping(payload) {
        try {
            const agent = payload?.agent;
            const session = agent?.session;
            if (!agent || !session || !isRootSession(session))
                return;
            if (typeof agent.steer !== 'function')
                return;
            const turn = Number(payload?.turn ?? 0);
            const known = state.records.get(session.id);
            /*
             * [1.8.8] 不再只认 human task 标记的 activeTurns：结算唤醒的回合
             * （subagent-settled / workplan-result / workplan-continue）同样装载
             * 了本计划的续跑输入，必须受同一道收尾闸门约束。
             */
            if (state.activeTurns?.get?.(session.id) !== turn && !turnCarriesPlanWork(session, turn, known))
                return;
            if (isPlanModeActive(ctx, session))
                return;
            let record = known;
            if (!record?.plan) {
                // [1.8.14] N5：优先按本回合结算消息里点名的计划重建，而不是最后生成的计划。
                record = reconstructFromSession(session, planIdFromTurn(session, turn));
                if (record?.plan)
                    state.records.set(session.id, record);
            }
            if (!stopGateApplies(record, session, turn))
                return;
            if (record.dispatchPromise) {
                try {
                    await record.dispatchPromise;
                }
                catch {
                    /* the failure is already on record.errors; the gate only needs the outcome */
                }
                finishRound(record, session);
                if (!stopGateApplies(record, session, turn))
                    return;
            }
            const book = record.stopSteers && record.stopSteers.turn === turn
                ? record.stopSteers
                : { turn, count: 0 };
            if (book.count >= STOP_STEER_LIMIT) {
                /*
                 * [1.12.3] steer 用尽后不再沉默放行。
                 *
                 * 旧行为（1.8.7–1.12.2）：达到上限就 `return`，回合正常收尾。对交互式
                 * 会话这是「避免死循环」；对 headless 却是事故复现路径——官方 runner 只
                 * 看 `turn/end reason.kind==='completed'`，它会把「计划未完成但回合正常
                 * 结束」打印成结果并 exit 0（session-99984ebd… 的最终现场）。
                 *
                 * 现在：headless（或显式开启）时抛 WORKPLAN_INCOMPLETE。turn-stopping
                 * 是 serial 事件，抛错 ⇒ 该回合以 error 收尾 ⇒ runner 走 fail()：
                 * 不打印正文、非零退出。交互式会话维持原样（只 steer，不抛错）。
                 */
                /*
                 * [2.1.0] U1=B：交互式会话放行，但必须留痕。
                 *
                 * 旧行为是 `return` 了事——用户看到回合正常结束，却没有任何地方写着
                 * 「这个回合其实是没通过门禁被放出来的」。B 方案不动「不硬拦」这个
                 * 决定，只把放行本身记成一件事：
                 *   1. 记录收进 record.releasedIncomplete（durable，刷新后仍在）；
                 *   2. 往会话追加一条 notice，用户当场能看见；
                 *   3. 日志留一行，便于事后对时间线。
                 * 三处都写同一组数字，避免「面板说 8/8、通知说 5/8」这种二次矛盾。
                 */
                if (!failClosedActive) {
                    const stuck = derivePlanSnapshot(record.statuses);
                    const released = (stuck.statuses ?? [])
                        .filter((item) => item.status !== 'done')
                        .map((item) => String(item.subtaskId));
                    record.releasedIncomplete = {
                        turn,
                        at: Date.now(),
                        done: stuck.stats.done,
                        total: stuck.stats.total,
                        remaining: released,
                    };
                    ctx.logger?.warn?.(`dsh-workplan: 回合 ${turn} 连续 ${book.count} 次未通过交付就绪，按 B 方案放行但留痕：`
                        + `${stuck.stats.done}/${stuck.stats.total}，未完成 ${released.join(', ') || '无'}`);
                    try {
                        appendUserMessage(session, makeUserMessage([
                            `⚠️ 本轮未通过交付就绪检查，已按「放行但留痕」结束（计划 ${record.plan.planId}）`,
                            `进度 ${stuck.stats.done}/${stuck.stats.total}；未完成：${released.join(', ') || '无'}`,
                            '本回合的内容不是最终交付；产物若已在盘上，下一回合核验后仍可交付。',
                        ].join('\n'), {
                            kind: 'workplan-release',
                            form: 'notice',
                            summary: `未就绪放行 ${stuck.stats.done}/${stuck.stats.total}`,
                        }));
                    }
                    catch (error) {
                        ctx.logger?.warn?.(`dsh-workplan: 放行留痕写入失败：${error instanceof Error ? error.message : String(error)}`);
                    }
                    return;
                }
                if (failClosedActive) {
                    const stuck = derivePlanSnapshot(record.statuses);
                    const remaining = (stuck.statuses ?? [])
                        .filter((item) => item.status !== 'done')
                        .map((item) => String(item.subtaskId));
                    throw new PlanError(`未完成：剩余 ${remaining.length} 项（${remaining.join(', ')}）与原因——计划 ${record.plan.planId} `
                        + `仅完成 ${stuck.stats.done}/${stuck.stats.total}，本回合已连续 ${book.count} 次被要求续跑/补证，`
                        + '仍未通过交付就绪检查。headless 以非零退出码结束，不输出「已完成」结果。', 'WORKPLAN_INCOMPLETE', { planId: record.plan.planId, stats: stuck.stats, remaining });
                }
                return;
            }
            book.count += 1;
            record.stopSteers = book;
            const snapshot = derivePlanSnapshot(record.statuses);
            agent.steer(makeUserMessage(buildStopSteerText({
                planId: record.plan.planId,
                phase: record.phase,
                stats: snapshot.stats,
                statuses: snapshot.statuses,
                attempt: book.count,
                changePending: record.changeRequest?.status === 'pending',
                reportPending: record.reportPending === true,
            }), {
                kind: 'workplan-continue',
                form: 'notice',
                summary: `【计划未就绪】${snapshot.stats.done}/${snapshot.stats.total}，本回合被要求按未完成口径收尾或继续`,
            }));
            ctx.logger?.warn?.(`dsh-workplan: 计划 ${record.plan.planId} 未通过交付就绪检查（${snapshot.stats.done}/${snapshot.stats.total}），`
                + `已在回合收尾前要求继续/如实收尾（第 ${book.count} 次）`);
        }
        catch (error) {
            /*
             * [1.12.3] fail-closed 的硬失败必须穿过这层日志包装：
             * 这里原本把任何异常降级成一条 warn，等于把上面的抛错又吃掉。
             */
            if (error instanceof PlanError && error.code === 'WORKPLAN_INCOMPLETE')
                throw error;
            ctx.logger?.warn?.(`dsh-workplan: 回合收尾检查失败：${error instanceof Error ? error.message : String(error)}`);
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
    /**
     * [1.8.16] 会话里所有「定义过」的计划。
     *
     * `reconstructFromSession(session)` 只回答「默认该看哪个计划」，而 `present`
     * 需要回答「会话里还有没有没交付完的计划」。1.8.15 的活体 E2E 暴露了这个差
     * 距：wp-6753e19f 停在 13/14，但最后定义的计划已就绪，`present` 仍然交付了
     * 报告。这里按日志里出现的 planId 逐个重建；数量极少（本会话只有 4 个），
     * 每个重建各自带回扫窗口，因此旧计划不会因为超过 2000 事件而消失。
     */
    function sessionPlanRecords(session) {
        if (typeof session?.eventAt !== 'function')
            return [];
        const ids = new Set();
        for (let i = 0; i < session.seq; i += 1) {
            let event;
            try {
                event = session.eventAt(i);
            }
            catch {
                continue;
            }
            if (!event || event.type !== 'user/message')
                continue;
            const planId = parseWorkplanMessage(event.data)?.plan?.planId;
            if (typeof planId === 'string' && planId)
                ids.add(planId);
        }
        const records = [];
        for (const planId of ids) {
            const record = reconstructFromSession(session, planId);
            if (record?.plan)
                records.push(record);
        }
        return records;
    }
    /**
     * [1.8.18] The last plan that actually defines work, for the restart replay.
     *
     * The gate used to fall back only to the live record or the turn's plan. After
     * a restart both are gone, so a session whose last action was cancelling an
     * unfinished plan allowed `present` — contradicting the cancel tool's own
     * contract ("取消后如仍有未完成项或证据缺口，present 仍会被拒绝"). T5 E1/E6
     * pinned that hole.
     *
     * Empty plans are skipped: they are not delivery objects (U6), and accepting
     * one as "the last plan" would let a builder cancel real work and define an
     * empty plan as a shield. Older cancelled plans still do not block a newer
     * plan, so cancelling a stale plan does not deadlock the session.
     */
    function lastGateablePlanRecord(session) {
        if (typeof session?.eventAt !== 'function')
            return undefined;
        for (let i = session.seq - 1; i >= 0; i -= 1) {
            let event;
            try {
                event = session.eventAt(i);
            }
            catch {
                continue;
            }
            if (!event || event.type !== 'user/message')
                continue;
            const plan = parseWorkplanMessage(event.data)?.plan;
            if (!plan || typeof plan.planId !== 'string' || plan.planId === '')
                continue;
            if (definedSubtaskCount(plan) === 0)
                continue;
            const record = reconstructFromSession(session, plan.planId);
            if (record?.plan && definedSubtaskCount(record.plan) > 0)
                return record;
        }
        return undefined;
    }
    /**
     * [1.9.0] 点名 superseded 时的覆盖链判定（T8 §4.2 第 4 条、§6.3）。
     *
     * superseded 只是「责任已转移」，不是完成：本回合点名它时，判的是承接计划
     * 是否真的就绪。承接计划缺失/已终止/无法复核 ⇒ fail-closed（SUPERSEDED_STALE）；
     * 承接计划未就绪 ⇒ 拒绝；只有承接计划 deliveryReady 才放行（产物来自承接计划）。
     *
     * [1.9.2] 返回值带上拒绝码（T8 §4.3 `judgeEffective`）：覆盖链无法复核
     * ⇒ `SUPERSEDED_STALE`；覆盖链有效但承接计划未就绪 ⇒ `ACTIVE_NOT_READY`。
     * 文案保持逐字不变，码值走 `src/plan.ts` 的同一组常量。
     */
    function supersededDenialVerdict(session, record) {
        const planId = record.plan?.planId ?? record.planId ?? '';
        const by = record.supersededBy;
        const successorPlanId = typeof by?.successorPlanId === 'string' && by.successorPlanId
            ? by.successorPlanId
            : typeof by?.planId === 'string' ? by.planId : '';
        if (!successorPlanId) {
            return presentDenial(PRESENT_DENY_CODES.SUPERSEDED_STALE, `计划 ${planId} 已被取代，但缺少可验证的承接计划（supersededBy.successorPlanId）：`
                + '覆盖证据失效（SUPERSEDED_STALE），不得调用 present；请向用户说明覆盖链无法复核并重新确认交付对象。');
        }
        /*
         * [W1] 覆盖摘要：present 复验从 mapping 重算摘要，不读缓存数值（T8 §6.3）。
         *
         * 摘要一旦对不上（含 mapping/digest 缺失），覆盖记录就无法复核 —— 无法复核
         * ≠ 通过，一律 stale。这条检查只证明「存下来的 mapping 没被改动」，不证明
         * 「两项工作在语义上等价」；后者仍只能由用户确认（V8）承载。
         */
        const mapping = by?.mapping;
        if (!Array.isArray(mapping)) {
            return presentDenial(PRESENT_DENY_CODES.SUPERSEDED_STALE, `计划 ${planId} 已被取代，但缺少可复算的逐项映射（supersededBy.mapping）：`
                + '覆盖证据失效（SUPERSEDED_STALE），不得调用 present，不得声称“已完成/最终版/已交付”；'
                + '请重新按用户确认的逐项映射做覆盖迁移，并由运行时写入复算后的 digest。');
        }
        const computedDigest = computeMappingDigest(mapping);
        if (!verifyMappingDigest(mapping, by?.digest)) {
            const stored = typeof by?.digest === 'string' ? by.digest.slice(0, 15) : '缺失';
            return presentDenial(PRESENT_DENY_CODES.SUPERSEDED_STALE, `计划 ${planId} 已被取代，但覆盖证据摘要与逐项映射不一致（supersededBy.digest=${stored}，`
                + `重算=${computedDigest.slice(0, 15)}）：覆盖证据失效（SUPERSEDED_STALE），不得调用 present，`
                + '不得声称“已完成/最终版/已交付”；请重新按用户确认的逐项映射做覆盖迁移，并由运行时复算 digest。');
        }
        const successor = reconstructFromSession(session, successorPlanId);
        if (!successor?.plan || definedSubtaskCount(successor.plan) === 0 || isTerminalPhase(successor.phase)) {
            return presentDenial(PRESENT_DENY_CODES.SUPERSEDED_STALE, `计划 ${planId} 已被取代，但承接计划 ${successorPlanId} 不存在、不是交付对象或已终止：`
                + '覆盖证据失效（SUPERSEDED_STALE）。被取代不等于完成：不得调用 present，不得声称“已完成/最终版/已交付”。');
        }
        const readiness = readinessOf(successor);
        if (!readiness.ready) {
            const ids = readiness.remaining.slice(0, 10).join('、');
            return presentDenial(PRESENT_DENY_CODES.ACTIVE_NOT_READY, `计划 ${planId} 已被取代，承接计划 ${successorPlanId} 只完成 ${readiness.done}/${readiness.total}`
                + `${ids ? `，剩余 ${readiness.remaining.length} 项（${ids}）` : ''}。`
                + '被取代不等于完成：承接计划通过交付就绪检查之前不得调用 present。');
        }
        return undefined;
    }
    /**
     * [1.9.2] present 拒绝点的唯一出口：码值取常量，拒绝文案保持逐字不变。
     *
     * host 的 guard 契约是 `string`（`ctx.tools.checkGuards`），所以工具错误里
     * 仍只有文案；码值由 `presentDenialVerdict` 一并返回，供断言、日志与后续
     * UI 使用。所有分支都必须经由这里，不要在分支里手写码值。
     */
    function presentDenial(code, message) {
        return { code, message };
    }
    function presentDenialVerdict(agent) {
        const session = agent?.session;
        if (!session)
            return undefined;
        /*
         * [1.11.0] 子会话不得直接交付（T7 P9 / R3）。
         *
         * 1.10.6 对非根会话直接返回 undefined，等于让子 Agent 绕过根交付门禁
         * 调用 present：中间产物会被当成最终交付展示给用户。交付只属于根会话；
         * 子会话的产物应写进工作区并由主 Agent 统一 present。
         */
        if (!isRootSession(session)) {
            return presentDenial(PRESENT_DENY_CODES.NOT_ROOT, '子 Agent 不能直接交付：请把产物写入工作区并在结论里给出路径，由主 Agent 统一核对后调用 present。');
        }
        if (isPlanModeActive(ctx, session))
            return undefined;
        /*
         * [1.8.16] Every plan in the session matters, not just the turn's plan.
         *
         * 1.8.15 taught this gate to prefer the plan named by the current turn's
         * messages, but a session can hold several plans at once (the incident
         * session itself ended with four). A live E2E on 1.8.15 showed the hole:
         * wp-6753e19f was still 13/14, the last defined plan was ready, and
         * `present` delivered the report. The gate now asks every plan in the log;
         * `dsh_workplan_cancel` is the documented escape hatch for a plan that
         * will not be finished.
         */
        const turn = currentTurnOf(session);
        const turnPlanId = turn ? planIdFromTurn(session, turn) : undefined;
        const candidates = sessionPlanRecords(session);
        const live = state.records.get(session.id);
        if (live?.plan && !candidates.some((item) => item.plan.planId === live.plan.planId))
            candidates.push(live);
        if (turnPlanId && !candidates.some((item) => item.plan.planId === turnPlanId)) {
            const named = reconstructFromSession(session, turnPlanId);
            if (named?.plan)
                candidates.push(named);
        }
        if (candidates.length === 0)
            return undefined;
        /*
         * [U6] a plan with zero defined subtasks is not a delivery object.
         * `deliveryReadiness` can never call it ready (`total > 0`), so judging it
         * only produced the false refusal "0 个子任务虽都已 done". Filter by the
         * definition itself — not by `statuses.length` — so a real plan whose
         * statuses failed to derive is still judged (and stays closed).
         */
        const gateable = candidates.filter((item) => definedSubtaskCount(item.plan) > 0);
        if (gateable.length === 0)
            return undefined;
        const unresolved = gateable
            .map((item) => ({
            record: item,
            readiness: readinessOf(item),
        }))
            /*
             * A cancelled plan is not a delivery blocker for *other* plans — the
             * incident session accumulates cancelled plans that will never be
             * finished, and blocking on them forever would deadlock delivery. It is
             * still checked below when it is the plan this turn (or the live record,
             * or the last defined plan after a restart) is about: cancel stops
             * execution, it does not make the work deliverable.
             */
            .filter((entry) => !isTerminalPhase(entry.record.phase) && !entry.readiness.ready);
        if (unresolved.length > 1) {
            const lines = unresolved.slice(0, 6).map((entry) => {
                const ids = entry.readiness.remaining.slice(0, 6).join('、');
                const suffix = ids ? `（${ids}${entry.readiness.remaining.length > 6 ? '…' : ''}）` : '';
                const gaps = entry.readiness.blockers.slice(0, 4).join('；');
                return `- 计划 ${entry.record.plan.planId}：完成 ${entry.readiness.done}/${entry.readiness.total}${suffix}`
                    + `${gaps ? `；证据缺口：${gaps}` : ''}`;
            });
            return presentDenial(PRESENT_DENY_CODES.ACTIVE_NOT_READY, `本会话还有 ${unresolved.length} 个计划未通过交付就绪检查：\n${lines.join('\n')}\n`
                + '在它们全部通过交付就绪检查之前，不得调用 present 交付任何产物：'
                + '先调用 dsh_workplan_dispatch 续跑，证据缺口用 dsh_workplan_update 补齐。'
                + '取消只停止执行，不会让未完成的计划变成可交付，也不能用来绕过这道检查。');
        }
        let record;
        let readiness;
        if (unresolved.length === 1) {
            record = unresolved[0].record;
            readiness = unresolved[0].readiness;
        }
        else {
            /*
             * No unfinished active plan. The plan this turn is about (or the live
             * record) may still be a cancelled one that never finished — T5-C pins
             * that `present` must be refused for it. After a restart neither exists,
             * so fall back to the last plan that defines work; otherwise the
             * sequence "cancel an unfinished plan, restart, present" silently
             * bypasses the cancel tool's own contract (T5 E1/E6).
             */
            record = state.records.get(session.id);
            if (turnPlanId)
                record = reconstructFromSession(session, turnPlanId) ?? record;
            if (!record?.plan)
                record = lastGateablePlanRecord(session);
            if (!record?.plan)
                return undefined;
            if (definedSubtaskCount(record.plan) === 0)
                return undefined;
            /*
             * [1.9.0] 终态解耦（T8 §4.3 P3）：终态计划不再被自动选为判定对象。
             *
             * 只有「本回合结构化点名」时才判定；否则不再写回 live、不再拦截其它
             * 计划的交付。取消 ≠ 完成：记录仍是 cancelled 0/N，只是不再永久挡门。
             */
            const namedThisTurn = Boolean(turnPlanId && record.plan.planId === turnPlanId);
            if (isTerminalPhase(record.phase) && !namedThisTurn)
                return undefined;
            if (record.phase === 'superseded') {
                const denial = supersededDenialVerdict(session, record);
                if (denial)
                    return denial;
                return undefined;
            }
            readiness = readinessOf(record);
            if (readiness.ready)
                return undefined;
        }
        if (record?.plan && !isTerminalPhase(record.phase))
            state.records.set(session.id, record);
        const snapshot = derivePlanSnapshot(record.statuses);
        const planId = record.plan?.planId ?? record.planId;
        const ids = readiness.remaining.slice(0, 10).join('、');
        const idSuffix = ids ? `（${ids}${readiness.remaining.length > 10 ? '…' : ''}）` : '';
        const blockers = readiness.blockers.slice(0, 10).join('；');
        if (readiness.cancelled) {
            /*
             * [1.8.13] `deliveryReadiness` already puts the cancellation fact at the
             * head of `blockers`; repeating it here produced the T6b/C0 copy with the
             * same sentence twice. Only the *evidence* gaps belong in this suffix.
             */
            const gaps = readiness.blockers
                .filter((line) => !line.startsWith('计划已取消但只完成'))
                .slice(0, 10)
                .join('；');
            if (readiness.remaining.length === 0) {
                return presentDenial(PRESENT_DENY_CODES.CANCELLED_NAMED, `计划 ${planId} 已取消，${readiness.total} 个子任务虽已 done，但证据未通过：${gaps || '缺少结构化证据'}。`
                    + '取消只停止执行，不等于完成：不得调用 present，不得声称“已完成/最终版/已交付”；'
                    + '答复必须说明取消状态与证据缺口，不能写成“全部完成”。');
            }
            return presentDenial(PRESENT_DENY_CODES.CANCELLED_NAMED, `计划 ${planId} 已取消，但只完成 ${readiness.done}/${readiness.total}，剩余 ${readiness.remaining.length} 项${idSuffix}`
                + `${gaps ? `；证据缺口：${gaps}` : ''}。`
                + '取消只停止执行，不等于完成，也不会让未完成项变成可交付：不得调用 present，不得声称“已完成/最终版/已交付”；'
                + '答复开头必须写「未完成：剩余 N 项（列出 ID）与原因」。');
        }
        /*
         * [1.9.2] P1 的单一映射：`activeDenyCode` 只看就绪结果。
         * `remaining` 为空但 `blockers` 非空 ⇒ `EVIDENCE_GAP`（T9 C05 的修法）；
         * 还有子任务没做完 ⇒ `ACTIVE_NOT_READY`。两个分支共用同一个码值来源。
         */
        const activeCode = activeDenyCode(readiness);
        if (readiness.remaining.length === 0) {
            return presentDenial(activeCode, `计划 ${planId} 的 ${readiness.total} 个子任务虽都已 done，但证据未通过：${blockers || '缺少结构化证据'}。`
                + '在 deliveryReady 变为 true 之前，产物不得作为成品交付：'
                + "用 dsh_workplan_update 为这些子任务补 verification='structured' 与 acceptance（每项 result='pass' 并附证据），"
                + '或把对应子任务改回 blocked 并写明原因；不要调用 present。');
        }
        return presentDenial(activeCode, `计划 ${planId} 未完成：完成 ${readiness.done}/${readiness.total}，剩余 ${readiness.remaining.length} 项${idSuffix}`
            + `${blockers ? `；另有证据缺口：${blockers}` : ''}。`
            + '在计划通过交付就绪检查之前不得调用 present 交付产物：先调用 dsh_workplan_dispatch 续跑剩余项；'
            + '证据缺口用 dsh_workplan_update 补齐；确实无法继续时，把答复写成「未完成：剩余 N 项与原因」。'
            + '取消只停止执行，不会改变“未完成”的结论。');
    }
    /**
     * 兼容入口：host 的 guard 只接受字符串，所以工具错误仍是原来的文案。
     * 需要码值时调用 `presentDenialVerdict`。
     */
    function presentDenialReason(agent) {
        return presentDenialVerdict(agent)?.message;
    }
    /*
     * [1.8.18] 已交付文件的写保护（T7-N2）。
     *
     * `present` 不复制内容（工具描述原文：the user opens the current files），
     * write/edit 也不校验路径是否已经交付。事故的迟到回合在 12:13 两次原地改写
     * 12:04 已 present 的报告，卡片背后的文件因此变了。这里把「present 时点
     * 已经定义过的计划」记到路径上：只要这些计划至今仍未通过交付就绪检查，
     * 根会话对同一路径的 write/edit 就被拒绝。present 之后才定义的新计划不在
     * 集合里，所以“用户要求改版 → 新计划”不会被写保护卡死；cancel 仍是显式出路。
     */
    const presentedPaths = new Map();
    /*
     * [1.12.2] G3 修复：符号链接必须归一到同一个文件。
     * 1.8.18 的 canonicalPath 只做 path.resolve，同一个文件因此有无限种写法——
     * 交付的是 /a/report.md，改 /link/report.md（link 指向 a）就被放过。
     * 这里再用 realpath.native 把路径解析成真实身份，两侧都解析才能比对。
     * 文件尚不存在时解析最近的存在祖先后拼回剩余段落；完全解析不了时
     * 返回 undefined，调用方回落到旧的 path.resolve 结果（不改变旧行为）。
     */
    function realPathIdentity(value) {
        try {
            return realpathSync.native(value);
        }
        catch {
            // 文件可能尚未创建，继续找最近的存在祖先。
        }
        let cursor = value;
        const tail = [];
        for (let depth = 0; depth < 64; depth += 1) {
            const parent = dirname(cursor);
            if (!parent || parent === cursor)
                return undefined;
            tail.unshift(basename(cursor));
            cursor = parent;
            try {
                return join(realpathSync.native(cursor), ...tail);
            }
            catch {
                // 继续向上。
            }
        }
        return undefined;
    }
    function canonicalPath(session, value) {
        if (typeof value !== 'string' || value.trim() === '')
            return undefined;
        if (isAbsolute(value))
            return resolve(value);
        const cwd = session?.header?.cwd ?? options.cwd;
        return typeof cwd === 'string' && cwd ? resolve(cwd, value) : undefined;
    }
    function identityPath(session, value) {
        const canonical = canonicalPath(session, value);
        if (canonical === undefined)
            return undefined;
        return realPathIdentity(canonical) ?? canonical;
    }
    function presentedEntries(session) {
        if (typeof session?.eventAt !== 'function' || !(Number(session.seq) >= 0))
            return [];
        const cache = presentedPaths.get(session.id);
        const reusable = cache !== undefined && cache.scannedTo <= Number(session.seq);
        const from = reusable ? cache.scannedTo : 0;
        const seen = new Set(reusable ? cache.planIds : []);
        const entries = reusable ? cache.entries.slice() : [];
        for (let i = from; i < Number(session.seq); i += 1) {
            let event;
            try {
                event = session.eventAt(i);
            }
            catch {
                continue;
            }
            if (!event)
                continue;
            if (event.type === 'user/message') {
                const planId = parseWorkplanMessage(event.data)?.plan?.planId;
                if (typeof planId === 'string' && planId)
                    seen.add(planId);
                continue;
            }
            if (event.type !== 'deliverables/presented')
                continue;
            const planIds = [...seen];
            for (const file of event.data?.files ?? []) {
                if (typeof file?.path !== 'string' || file.path.trim() === '')
                    continue;
                entries.push({ raw: file.path, canonical: identityPath(session, file.path), planIds });
            }
        }
        presentedPaths.set(session.id, {
            scannedTo: Number(session.seq),
            planIds: seen,
            entries,
        });
        return entries;
    }
    function recordForPlan(session, planId) {
        const live = state.records.get(session.id);
        if (live?.plan?.planId === planId)
            return live;
        return reconstructFromSession(session, planId);
    }
    function presentedWriteDenialReason(agent, args) {
        const session = agent?.session;
        if (!session)
            return undefined;
        if (isPlanModeActive(ctx, session))
            return undefined;
        const entries = presentedEntries(session);
        if (entries.length === 0)
            return undefined;
        const requested = args?.file_path ?? args?.path;
        if (typeof requested !== 'string' || requested.trim() === '')
            return undefined;
        // [1.12.2] G3: compare by real file identity (symlinks resolved).
        const canonical = identityPath(session, requested);
        /*
         * [1.12.2] G3: compare like-for-like. The entry now holds the real identity
         * of the presented path, so a link delivered earlier and a write through
         * the real path (or vice versa) resolve to the same string.
         */
        const matched = entries.filter((entry) => entry.raw === requested
            || (entry.raw !== undefined && identityPath(session, entry.raw) === canonical)
            || (canonical !== undefined && entry.canonical !== undefined && entry.canonical === canonical));
        if (matched.length === 0)
            return undefined;
        const planIds = new Set();
        for (const entry of matched)
            for (const planId of entry.planIds)
                planIds.add(planId);
        if (planIds.size === 0)
            return undefined;
        const unresolved = [...planIds]
            .map((planId) => recordForPlan(session, planId))
            .filter((record) => record?.plan
            && !isTerminalPhase(record.phase)
            && !readinessOf(record).ready);
        if (unresolved.length === 0)
            return undefined;
        const ids = unresolved.slice(0, 4).map((record) => record.plan.planId);
        return `文件 ${requested} 已通过 present 交付给用户，而交付时点已存在的计划`
            + `${ids.length ? ` ${ids.join('、')}` : ''} 仍未通过交付就绪检查。`
            + '计划未就绪期间不得原地改写已交付文件：先调用 dsh_workplan_dispatch 续跑剩余项，'
            + '完成后重新 present 新版本；确实不做的计划用 dsh_workplan_cancel 显式取消。'
            + '（present 之后新建的计划不受此限制。）';
    }
    /**
     * [1.12.2] G2: every path a single write call can touch.
     * apply_patch carries many files in one string; parsing the directives here
     * lets the guard deny the whole call instead of letting an unrelated path
     * in the arguments form a blind spot.
     */
    function writeTargets(_agent, args) {
        const targets = [];
        const single = args?.file_path ?? args?.path;
        if (typeof single === 'string' && single.trim() !== '')
            targets.push(single);
        const patch = typeof args?.input === 'string' ? args.input : (typeof args?.patch === 'string' ? args.patch : '');
        if (patch) {
            const directive = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm;
            let match;
            while ((match = directive.exec(patch)) !== null) {
                const path = match[1].trim();
                if (path !== '')
                    targets.push(path);
            }
        }
        return targets;
    }
    function plansPayload(sessionId) {
        /*
         * [1.8.15] The feed must carry build identity too.
         *
         * `status` learned version/runtime in 1.8.14, but the Web UI reads this
         * feed only — so after a rebuild the card could not tell "the process is
         * still running yesterday's bytes" (T5c §6.2). Same helpers, one source.
         */
        return {
            ...buildPlansPayload(ctx, state, sessionId),
            version: pluginVersion,
            runtime: runtimeIdentity(),
        };
    }
    async function route(req, res, connectionCtx = ctx) {
        applyHardeningHeaders(res);
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
    /**
     * [2.0.0] 只读的「永久教训记忆」入口。
     *
     * 用户要求这些经验必须能被复核。主 Agent 在阶段三可以用它查：记住了什么、
     * 哪些同类错误在重复发生、文件到底写在哪。它只读文件，不改任何计划状态。
     */
    async function lessonsTool(_agent, args) {
        const parsed = isRecord(args) ? args : {};
        const action = String(parsed.action ?? 'list');
        const file = resolveLessonsFile();
        try {
            if (action === 'stats') {
                return { ok: true, ...lessonStats(file) };
            }
            if (action === 'search') {
                const query = String(parsed.query ?? '').trim();
                const rows = query
                    ? readLessons(file).filter((item) => `${item.title} ${item.problems.join(' ')} ${item.detours.join(' ')} ${item.prevention.join(' ')}`
                        .toLowerCase()
                        .includes(query.toLowerCase()))
                    : readLessons(file);
                const limit = Math.min(Math.max(Number(parsed.limit) || 10, 1), 50);
                return { ok: true, file, total: rows.length, lessons: rows.slice(-limit).reverse() };
            }
            const department = typeof parsed.department === 'string' ? parsed.department.trim() : '';
            const limit = Math.min(Math.max(Number(parsed.limit) || 10, 1), 50);
            const lessons = department
                ? readLessons(file).filter((item) => item.department === department)
                : readLessons(file);
            const ranked = department
                ? rankLessons(lessons, { department, limit, now: Date.now() })
                : lessons.slice(-limit).reverse();
            return { ok: true, file, total: lessons.length, lessons: ranked };
        }
        catch (error) {
            return {
                ok: false,
                file,
                error: truncate(error instanceof Error ? error.message : String(error), 300),
                lessons: [],
            };
        }
    }
    function dispose() {
        // [1.10.4] 定时器不能吊住进程，也不能在记录清空后复活一个已销毁的计划。
        for (const record of state.records.values())
            clearAutoResumeTimer(record, 'dispose');
        state.records.clear();
    }
    return {
        state,
        limits,
        onPreStep,
        onTurnStopping,
        presentDenialReason,
        presentDenialVerdict,
        supersededDenialVerdict,
        presentedWriteDenialReason,
        writeTargets,
        updateStatus,
        cancelPlan,
        dispatchTool,
        statusTool,
        followupTool,
        escalateTool,
        verifyTool: verifySubtask,
        lessonsTool,
        instructTool,
        handoffTool,
        replanPlan,
        plansPayload,
        route,
        dispose,
        planModeActive: (session) => isPlanModeActive(ctx, session),
    };
}
/**
 * [1.12.3] 澄清闸门的退出口。默认开启；只有显式设成 0/false/off 才回到旧行为
 * （信息不足也照做计划、照派发）。
 */
function clarifyGateDisabled() {
    const raw = String(process.env.DSH_WORKPLAN_CLARIFY_GATE ?? '').trim().toLowerCase();
    return raw === '0' || raw === 'false' || raw === 'off';
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
    const existing = state.records.get(session.id);
    /*
     * [2.0.3] `/goal` 任务没有 user/message，任务文本只以 `source.kind = 'goal'`
     * 的轮次消息出现。放宽入口，但只认第一轮且只在该会话没有进行中计划时放行。
     */
    const goalTask = human.length === 0 ? goalRoundPlanningTask(ctx, payload, existing) : undefined;
    if (human.length === 0 && goalTask === undefined)
        return downstream;
    const taskText = goalTask?.text ?? taskTextFromMessages(payload.messages);
    if (!taskText)
        return downstream;
    if (isSocialMessage(taskText))
        return downstream;
    if (isVagueContinuation(taskText))
        return downstream;
    if (isStatusQuestion(taskText))
        return downstream;
    /*
     * [1.8.7] Remember that this turn carries a real task.
     *
     * `agent/turn-stopping` must only object on turns whose plan belongs to the
     * user's actual request. A plan left paused in an earlier turn must not turn
     * every later "谢谢/进度如何" turn into a forced 20-minute dispatch, so the
     * stop gate reads this marker and stays silent on social or status turns.
     */
    if (!state.activeTurns)
        state.activeTurns = new Map();
    state.activeTurns.set(session.id, Number(payload.turn ?? 0));
    const conversationContext = recentConversation(session);
    if (existing?.plan?.createdTurn === payload.turn)
        return downstream;
    /*
     * [1.11.0] 执行中记录的变更，在本轮结束后仍然没有被 replan 落实时，必须
     * 在下一步拦住“直接开始新一轮计划/直接收尾”：提醒模型先处理变更。每个
     * 变更序号只提醒一次（notifiedSeq），不会每步重复注入。
     */
    if (existing?.plan && !existing.dispatchPromise
        && existing.changeRequest?.status === 'pending'
        && existing.changeRequest.notifiedSeq !== existing.changeRequest.seq) {
        existing.changeRequest.notifiedSeq = existing.changeRequest.seq;
        const change = existing.changeRequest;
        return enterDecision(downstream, [buildChangeRequestMessage({
                kind: 'workplan-change',
                planId: String(existing.plan.planId ?? ''),
                seq: Number(change.seq) || 1,
                at: Number(change.at) || Date.now(),
                turn: Number(change.turn) || null,
                text: String(change.text ?? ''),
            }, { afterRound: true })]);
    }
    // A plan generated in plan mode is intentionally deferred: keep it intact
    // until the user leaves plan mode and dispatches it. Cancelling it here
    // would make the plan disappear before the main Agent can act on approval.
    if (existing?.plan && existing.planMode && !existing.dispatchedAt)
        return downstream;
    // A plan committed but not yet dispatched must not be overwritten in the
    // same turn; a later turn may supersede it, otherwise one abandoned plan
    // would lock planning forever.
    //
    // [1.9.2] 自动覆盖路径**只允许**写 cancelled，永不写 superseded（规则设计
    // §7.1：自动路径没有逐项映射与用户确认，满足不了 V4–V8）。它也不得把已经
    // superseded 的终态记录改回 cancelled：内存写 cancelled、日志里仍是
    // supersede 信封，会让 live 与 replay 分叉。终态记录由 present 的终态解耦
    // 处理（不再自动挡门），不需要在这里「取消」。
    if (existing?.plan && !existing.dispatchedAt && !isTerminalPhase(existing.phase)) {
        if (existing.plan.createdTurn === payload.turn)
            return downstream;
        existing.phase = 'cancelled';
        existing.cancelledAt = Date.now();
        existing.updatedAt = existing.cancelledAt;
        existing.errors = Array.isArray(existing.errors) ? existing.errors : [];
        existing.errors.push('计划已取消：上一轮未派发');
    }
    if (existing?.dispatchPromise || existing?.phase === 'executing') {
        /*
         * [1.11.0] C-12：执行中收到的新需求不能静默丢弃。
         *
         * 旧代码在这里直接 `return downstream`，用户在看到「正在做」之后补充的要求
         * 既没写进状态、也没出现在会话里，下一轮计划更不会包含它们。现在：
         *  - 原文落进 `record.changeRequest`（带序号/回合/时间），刷新后可恢复；
         *  - 一条 notice 消息进入本轮上下文，明确告诉模型「先别打断、结束后用
         *    dsh_workplan_replan 落实」；
         *  - 同一段文本只记一次，避免每步重复注入。
         */
        const text = truncate(taskText, 4000);
        const previous = typeof existing.changeRequest?.text === 'string' ? existing.changeRequest.text : '';
        if (previous !== text) {
            const seq = Number(existing.changeRequestSeq ?? 0) + 1;
            const at = Date.now();
            existing.changeRequestSeq = seq;
            existing.changeRequest = {
                seq,
                text,
                at,
                turn: Number(payload.turn ?? 0),
                status: 'pending',
                notifiedSeq: seq,
            };
            existing.updatedAt = at;
            const active = (existing.statuses ?? [])
                .filter((item) => item?.status === 'in_progress')
                .map((item) => `${String(item.subtaskId)}「${String(item.title ?? '')}」`);
            return enterDecision(downstream, [buildChangeRequestMessage({
                    kind: 'workplan-change',
                    planId: String(existing.plan?.planId ?? ''),
                    seq,
                    at,
                    turn: Number(payload.turn ?? 0),
                    text,
                }, { activeSubtasks: active })]);
        }
        return downstream;
    }
    /*
     * [1.12.3] 信息不足就不做计划、不派发——只问一句。
     *
     * 用户在 2026-11-04 拍板：自动派发改成「只在信息不足这一类上拦截」，其余照旧。
     * 因此拦截点放在规划之前，而不是关掉自动派发：缺信息时连计划都不生成，
     * 免得部门 Agent 对着一个猜出来的目标开工。
     * 关闭方式：DSH_WORKPLAN_CLARIFY_GATE=0（保留给需要旧行为的自动化）。
     */
    if (!clarifyGateDisabled()) {
        const clarify = auditClarifyNeed(taskText, conversationContext);
        if (clarify.needed) {
            const createdAt = Date.now();
            state.records.set(session.id, {
                planId: null,
                plan: null,
                title: '任务信息不足（先澄清）',
                degraded: false,
                clarify: true,
                error: clarify.reason,
                statuses: [],
                phase: 'clarify',
                errors: [truncate(clarify.reason, 1000)],
                createdAt,
                updatedAt: createdAt,
                createdTurn: payload.turn,
            });
            return enterDecision(downstream, [buildClarifyMessage({
                    rule: clarify.rule,
                    reason: clarify.reason,
                    question: clarify.question,
                })]);
        }
    }
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
    /*
     * [2.1.6] 规划器遥测的落点：成功写进记录、失败写进降级消息，让「为什么没
     * 分解成功」不再是一句没有现场的「超时」。
     */
    const plannerTelemetry = {};
    /*
     * [2.2.5][T5] 分解期间可见性——占位卡片（T1 P-5 / T3 §2 S1、§3 C1）。
     *
     * 缺陷：runPlanner 全程（最长 3 次尝试 × 300s 窗口 + 退避）此前零写入，
     * 用户看到的是「发出去一句话后界面没有任何反应」，无法区分「正在重试」
     * 与「卡死」（T1 断点层判定=未发出，插件层）。现在进入规划前先放一张
     * phase:'planning' 的占位记录：侧栏 4 秒轮询只要记录存在就下发（serialisePlan
     * 对 plan:null 已兜底），卡片徽标走既有词汇「正在安排」（client.ts LOCALE）。
     * 后续出口不新增路径：成功/降级由下方既有 records.set 整体覆盖；用户中止
     * 路径由 serialisePlan 的终态收敛（turnEnded → phase:'ended'）兜住，不会
     * 残留假「进行中」。
     */
    const planningStartedAt = Date.now();
    const planningRecord = {
        planId: null,
        plan: null,
        title: '正在生成任务分解…',
        degraded: false,
        statuses: [],
        phase: 'planning',
        errors: [],
        createdAt: planningStartedAt,
        updatedAt: planningStartedAt,
        createdTurn: payload.turn,
    };
    state.records.set(session.id, planningRecord);
    /*
     * [2.2.5][T5] 进度回调落点（T1 P-6 / T3 §3 C2/C3、§4 频率规则）：
     * 通道 A = 占位卡片 errors 区追加重试摘要（≤2 行，保底通道）；通道 B =
     * appendUserMessage 通知（仅「会退避重试」的失败发，≤2 条，aborted 静默）。
     * 文案组装与频率硬规则全部在 createPlannerProgressReporter / plannerProgressLines
     * （plan.ts，可独立回归）；这里只注入宿主交互面。
     */
    const onPlannerProgress = createPlannerProgressReporter({
        signal: payload.signal,
        record: planningRecord,
        setRecord: (record) => state.records.set(session.id, record),
        appendNotice: (text) => appendUserMessage(session, text),
        maxAttempts: PLANNER_MAX_ATTEMPTS,
    });
    try {
        plan = await runPlanner(ctx, {
            taskText,
            cwd: session.header?.cwd ?? options.cwd,
            sessionId: session.id,
            modelSelection,
            signal: payload.signal,
            plannerTimeoutMs: normalisePlannerWindow(options?.limits?.plannerTimeoutMs ?? options?.plannerTimeoutMs, PLANNER_TIMEOUT_MS),
            plannerIdleTimeoutMs: normalisePlannerWindow(options?.limits?.plannerIdleTimeoutMs ?? options?.plannerIdleTimeoutMs, PLANNER_IDLE_TIMEOUT_MS),
            telemetry: plannerTelemetry,
            // [2.2.5][T5] 分解期间进度事件（T1 P-6）：只追加观察回调，不改重试语义。
            onProgress: onPlannerProgress,
            conversationContext,
            sourceMessageIds: human.map((message) => message.id).filter((id) => typeof id === 'string'),
            /*
             * Hand the real limits to the planner. Without them it had no idea the
             * round budget was 20 minutes and happily planned 15 heavy subtasks,
             * which then died at the budget wall. The prompt now states the budget
             * and asks for `estimateMinutes` on every subtask.
             */
            budget: {
                totalMinutes: Number(options?.limits?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) > 0
                    ? Math.max(1, Math.round(Number(options.limits.totalTimeoutMs) / 60000))
                    : 0,
                childMinutes: Math.max(1, Math.round(Number(options?.limits?.childTimeoutMs ?? CHILD_TIMEOUT_MS) / 60000)),
                concurrency: MAX_CONCURRENT,
                maxResumes: Number(options?.limits?.maxResumes ?? MAX_PLAN_RESUMES),
            },
        });
    }
    catch (error) {
        if (payload.signal.aborted) {
            /*
             * [2.2.5][T5] 用户中止：静默退出（T3 §2 中止分支，不发通知）。占位卡片
             * 若本轮前无旧记录，交给 serialisePlan 终态收敛转 'ended'，不留假
             * 「进行中」；若本轮前已有旧计划记录，恢复它——中止不该把用户上一份
             * 终态进度从内存里挤掉（旧实现中止路径不写记录，此行为保持不变）。
             */
            if (existing?.plan)
                state.records.set(session.id, existing);
            return downstream;
        }
        const planId = `wp-${randomUUID()}`;
        const createdAt = Date.now();
        const message = buildDegradedMessage({
            planId,
            sessionId: session.id,
            createdTurn: payload.turn,
            createdAt,
            error: error instanceof Error ? error.message : String(error),
            detail: plannerTelemetryLine(plannerTelemetry),
            taskText,
        });
        state.records.set(session.id, {
            planId,
            plan: null,
            title: '自动分解降级',
            degraded: true,
            error: error instanceof Error ? error.message : String(error),
            planner: { ...plannerTelemetry, at: createdAt },
            statuses: [],
            phase: 'degraded',
            errors: [truncate(error instanceof Error ? error.message : String(error), 1000)],
            createdAt,
            updatedAt: createdAt,
            createdTurn: payload.turn,
        });
        return enterDecision(downstream, [message]);
    }
    if (payload.signal.aborted) {
        // [2.2.5][T5] 计划已生成但回合被中止：同中止分支，恢复旧记录再静默退出。
        if (existing?.plan)
            state.records.set(session.id, existing);
        return downstream;
    }
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
        // [2.1.6] 规划这一步花了多久、用的哪个模型：成功也留痕，失败才好对比。
        // [2.1.7] 抢救成功的计划保留 SALVAGED 判定，别被 'ok' 覆盖——它是复盘的关键证据。
        planner: { ...plannerTelemetry, outcome: plannerTelemetry.outcome === 'SALVAGED' ? 'SALVAGED' : 'ok', at: createdAt },
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
     * [1.12.0] Q2：默认自动派发。计划消息仍然先把计划完整展示出来，紧接着以
     * async 方式开跑——不是等所有子任务结束再显示（那才是旧的「没动静」）。
     * plan 模式不自动派发；显式 `autoDispatch:false` 保留 plan-first。
     */
    const autoDispatched = !planMode && options?.autoDispatch !== false;
    if (autoDispatched) {
        record.dispatchedAt = Date.now();
        state.startAutoDispatch?.(record, session, payload.agent);
    }
    /*
     * Plan-first: commit the plan with this step and let the main Agent call
     * dsh_workplan_dispatch. Dispatching here would hide the plan until every
     * child finished, which is exactly the "没动静/没完成" failure.
     *
     * [1.12.0] There is no tool guard that forces dispatch before other work —
     * `toolGuardReason` only denies dispatch in plan mode and `present` when the
     * plan is not ready. What actually enforces the ordering is the system
     * prompt, plus the turn-stopping gate steering at most twice per turn
     * (`STOP_STEER_LIMIT`); if the model still never dispatches, the next turn
     * cancels the stale plan ("计划已取消：上一轮未派发") and plans again.
     */
    const planMessage = buildPlanMessage(fullPlan, {
        totalBudgetMinutes: Number(options?.limits?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) > 0
            ? Math.max(1, Math.round(Number(options.limits.totalTimeoutMs) / 60000))
            : 0,
        maxResumes: Number(options?.limits?.maxResumes ?? MAX_PLAN_RESUMES),
        planMode,
        autoDispatched,
    });
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
            deliveryReady: { type: 'boolean' },
            deliveryBlockers: { type: 'array' },
            deliveryRemaining: { type: 'array' },
            hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
    };
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
            /*
             * [1.9.2] `disposition="superseded"` answers. `supersedeRecorded` is the
             * durable-write witness for the supersede envelope (the cancelled answer
             * uses `cancelRecorded`); `alreadySuperseded` is the §7.4 idempotent
             * re-submission. `code` carries the SUPERSEDE_* refusal; `gaps` /
             * `missingFrom` / `problems` explain exactly which V-rule failed so a
             * caller can repair the mapping instead of guessing.
             */
            disposition: { type: 'string' },
            supersededAt: { type: 'number' },
            supersedeRecorded: { type: 'boolean' },
            alreadySuperseded: { type: 'boolean' },
            coverage: { type: 'string' },
            requiredCount: { type: 'number' },
            coveredCount: { type: 'number' },
            successorSeenAtSeq: { type: 'number' },
            confirmedAtSeq: { type: 'number' },
            supersededBy: {
                type: 'object',
                properties: {
                    planId: { type: 'string' },
                },
                additionalProperties: true,
            },
            code: { type: 'string' },
            error: { type: 'string' },
            hint: { type: 'string' },
            gaps: { type: 'array', items: { type: 'string' } },
            missingFrom: { type: 'array', items: { type: 'string' } },
            problems: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok'],
        additionalProperties: true,
    };
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
            planner: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            deliveryReady: { type: 'boolean' },
            deliveryBlockers: { type: 'array' },
            deliveryRemaining: { type: 'array' },
            hint: { type: 'string' },
            error: { type: 'string' },
            code: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
    };
}
export function replanToolOutputSchema() {
    return {
        type: 'object',
        properties: {
            ok: { type: 'boolean' },
            planId: { type: 'string' },
            planRevision: { type: 'number' },
            reason: { type: 'string' },
            phase: { type: 'string' },
            stats: { type: 'object' },
            statuses: { type: 'array' },
            marks: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        subtaskId: { type: 'string' },
                        action: { type: 'string' },
                        replacedBy: { type: 'array', items: { type: 'string' } },
                        reason: { type: 'string' },
                    },
                    additionalProperties: true,
                },
            },
            added: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        subtaskId: { type: 'string' },
                        stageId: { type: 'string' },
                        title: { type: 'string' },
                        replaces: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                    },
                    additionalProperties: true,
                },
            },
            // 执行中拒绝改计划时：变更已记录、本轮仍在跑（REPLAN_PLAN_RUNNING）。
            running: { type: 'boolean' },
            changeRequest: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            code: { type: 'string' },
            error: { type: 'string' },
            hint: { type: 'string' },
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
    };
}
