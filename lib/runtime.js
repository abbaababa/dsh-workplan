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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createNoticeChannel, finaliseNoticeChannel, formatNoticeChannelLog, observeRelayedNotice, readLeadAgentId, resolveLeadAgentId, validateNoticeChannel, } from './notice-channel.js';
// [T5-channel][契约v1 §2] 部门消息留痕：冻结 API，只 import 不改（journal-member 实现）。
import { appendDeptMessage, makeDeptMessageId, readDeptMessages } from './dept-journal.js';
// [3.1.7][P1 U-43] 台账写前日志读端：崩溃窗口内只进过内存缓冲的更新由此恢复。
import { readNoticeLedger } from './notice-ledger.js';
import { MAX_CONCURRENT, PlanError, aggregateInvariantViolations, appendUserMessage, enterPreHeadWindow, applyStatus, attachPlanMeta, blockCancelledDependents, buildChildPrompt, buildCancelMessage, buildClarifyMessage, createPlannerProgressReporter, 
// [2.5.2] 规划期间心跳（治整段静默以为死机）：plan.ts 纯函数 + 注入工厂。
createPlanningHeartbeat, planningHeartbeatIntervalMs, 
// [2.5.2][stall-fix] 派发执行期进度心跳文案（同一工厂，buildMessage 注入）。
buildDispatchHeartbeat, buildDegradedMessage, buildPlanMessage, 
// [2.3.10][T2] 用户要求1：规划前/派发前会话内耗时预告文案（plan.ts 纯函数）。
buildPhaseZeroLeaderPrompt, buildPhaseZeroContinuationHint, buildPlanningPreAnnouncement, buildDispatchPreAnnouncement, buildPlannerPrompt, buildResultMessage, buildStopSteerText, createStatuses, deliveryReadiness, 
// [3.1.7] 接续证据分层：执行蓝图全量 + 审计链索引 + 落盘引用。
renderStartEvidenceBrief, 
// [T7][lead-decisions J2/G2] 负责人时长聚合纯函数：模型可读面与 delegate status
// 挂同一函数（看板载荷经 plan.ts normaliseStatusEntry 同源），读时派生不持久化。
deriveLeaderEstimate, leaderEstimateRoster, derivePlanSnapshot, 
// [T4][F6] 第三层结算一致性告警（只告警不改判）：交付就绪/status 汇总同源。
deriveDelegateConsistencyWarnings, 
// [2.2.0][T4/O-3b] O-3b 消费接线：缺省协商上限由预估派生（plan.ts 纯函数，T3 已定稿）。
deriveSubtaskTimeoutMs, extractJson, flattenSubtasks, 
// [T7] 关键进度收敛：单条 500 上限裁剪器＋轮预算重置（C3）。
capKeyProgressText, resetRoundInjectionBudget, isRecord, isSocialMessage, isTerminalPhase, isStatusQuestion, isUserConfirmation, isVagueContinuation, makeUserMessage, markDependentsBlocked, messageText, readySubtasks, MAX_PLAN_RESUMES, PRESENT_DENY_CODES, canResumePlan, resetBlockedStatuses, parseCancelMessage, parseResultMessage, parseWorkplanMessage, planPhase, reconcilePhase, REASONING_EFFORTS, truncate, validatePlan, applyResultStatuses, adjudicateResult, 
// [3.0.0] F10 专家汇报核验（adjudicateExpertReport）复用同一解析器。
parseEvidenceBlock, 
// [2.5.2][T4b][D2] 备份归属校验需要从标记块内提取 JSON（裸 JSON 之外的第二入口）。
EVIDENCE_MARKER_BEGIN, EVIDENCE_MARKER_END, activeDenyCode, MAX_CONVERSATION_CHARS, MAX_ESCALATION_OPTIONS, MAX_INSTRUCTION_CHARS, MAX_QUESTION_CHARS, 
// [2.5.5][T10] 合并闸：回放按批展开，结算前把缓冲台账合并落盘。
parseUpdateMessages, flushPendingWorkplanUpdates, buildUpdateMessage, normaliseHandoffs, mergeHandoffEntriesByUpdatedAt, 
// [3.1.7][P0 U-64/U-68] 第三层台账条目级单调合并（唯一权威归约器）。
mergeDelegateEntriesMonotonic, needEntryText, openHandoffs, DEPARTMENTS, DEPARTMENT_IDS, MAX_HANDOFF_RESPONSE_CHARS, findSubtask, EFFORT_STRENGTH_ORDER, } from './plan.js';
// [3.0.0] 用户 2026-11-14 第 2、4 条：两条逐字冻结的会话固定文案。
import { STATUS_ASSIGNED_TEXT, STATUS_ASSIGNING_TEXT, checkExpertReport, checkSubtaskQualityRequirements, isQualityGatePlan } from './v3-contract.js';
// [SCv2-T4] 判据层单一真源（用户 2026-11-13 裁决 B/B/B/B/A/A/B）：生效边界 D-1、
// 例外批准 Q1-B、结算三选一 §3.5、单次墙钟 Q6-A、事前聚合 Q4-B。运行层常量不改。
import { appendCriterionViolation, attemptWallClockMsOf, criterionExAnte, criterionV2Active, evaluateCriterion, sanitizeCriterionException, } from './criterion.js';
import { auditClarifyNeed, compactUnderstandingAudit, validatePlanContext } from './understanding.js';
// [2.3.9][T3] LLM 家族检测 + 推理等级静态约束（用户强制要求 1/2；详见 llm-rules.ts 头注释）。
// [2.3.9][T4b] 追加第三层派发纯逻辑核：buildLlmRulesBrief（要求 1/2 全文告知注入，
// 部门层与专家/组员层共用同一事实源）、planDelegations（负责人「先全面梳理再分配」
// 硬门禁 + 分工表校验 + 等级钳制）、buildDelegateePrompt（第三层任务书）。
import { allowedEffortsForModel, buildDelegateePrompt, buildLlmRulesBrief, classifyModelFamily, correctEffortForModel, highestEffortOf, planDelegations, buildPhaseZeroDelegateePrompt, resolveTaskEffort, } from './llm-rules.js';
import { phaseGateFromErrors, phaseSummaryLine, renderStartPhaseEvidence, sanitizeStartPhaseEvidence, START_EVIDENCE_MIN_CHARS_BRIEF, validateFiveStepEvidence, validateStartPhaseEvidence } from './five-step.js';
import { lessonStats, rankLessons, readLessons, recordLesson, renderLessonsBrief, resolveLessonsFile, } from './lessons.js';
import { computeMappingDigest, verifyMappingDigest } from './supersede-digest.js';
import { supersedePlanRecord } from './supersede.js';
// [3.1.0] 人数上限单一真源（caps.ts）：报错文案与门禁同源。
import { MAX_COMPLEX_DELEGATE_MEMBERS } from './caps.js';
// [3.1.0] 排队等待上限环境变量化（默认 10 分钟不变）＋规划器并发预算环境变量化。
import { envPositiveInt } from './caps.js';
import { createProgressWatchdog, describeError } from './watchdog.js';
import { AUTO_RESUME_DEFAULTS, autoResumeAttemptCap, decideAutoResume, liveResumeCounts } from './auto-resume.js';
/*
 * [3.0.1] 认可闸门 + 死锁自愈（approval-gate.ts）：
 *   detectApprovalGate     —— 任务锚点里的「先经认可再执行」门槛语识别
 *   approvalGateDetectionDisabled —— DSH_WORKPLAN_APPROVAL_GATE=0 总开关
 *   isDispatchHeld         —— 计划是否被按住不得派发
 *   buildChildRevivePatch  —— escalated 行子会话失联时的复活补丁（纯函数）
 */
import { approvalGateDetectionDisabled, buildChildRevivePatch, detectApprovalGate, isDispatchHeld, } from './approval-gate.js';
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
 *
 * [2.2.9][T3][M4.1] `reportPending` 不再读 `record.reportPending` 可变标志。
 * 事故实证（wp-215ed52f 症状②）：门禁读标志、看板读标志、消息冻结读标志，
 * 而该标志在 finishRound/markReported/自愈/重建多处的写入时机互不同步，
 * 判定结果随读取落在哪个时间窗口而翻转——「可交付↔未放行」来回震荡。
 * 现在门禁、看板、stop-steer、消息冻结、自愈全部读同一个纯派生函数
 * `deriveReportPending(record)`：事实只有 statuses（经 T2 单调闸的终态），
 * 标志降级为审计镜像。blocked/pending 行不是 done，永不触发该阻塞。
 */
/*
 * [3.0.1][P0 冲突修复] 跨版本兼容的「continuable 中断」。
 *
 * DSH 0.2.2-rc.3 起旧 API `subagents.interruptByParent(childId, parentId,
 * 'continuable')` 已被 `subagents.interrupt(targetSessionId, authority)`
 * 取代（dsh-subagent/src/manager.ts）：authority = { kind:'ancestor', agent }
 * 携带中断方的**活体 Agent 对象**（必须是目标会话祖先树内的活体 Agent，
 * 否则宿主抛 UNAUTHORIZED）。新 API 的 local 分支语义与旧 'continuable'
 * 完全等价：agent.cancel({ kind:'parent' }, { keepInbox:true }) —— 中断
 * 当前回合但保留收件箱，可被后续接续重新驱动。
 *
 * 策略：优先新 API；宿主为旧版本时回退旧 API（保留旧测试夹具与旧宿主
 * 可用性）；两者皆无或 authority 不成立时返回 false（与修复前静默跳过
 * 同口径，调用方均有接续兜底，绝不因中断失败阻断主链路）。
 */
export function interruptChildContinuable(subagents, childSessionId, ancestorAgent, ancestorIdFallback) {
    if (subagents == null || typeof childSessionId !== 'string' || childSessionId.length === 0)
        return false;
    try {
        if (typeof subagents.interrupt === 'function') {
            // 新 API 要求 authority.agent 是目标会话祖先的活体 Agent 对象。
            if (ancestorAgent == null || typeof ancestorAgent !== 'object')
                return false;
            subagents.interrupt(childSessionId, { kind: 'ancestor', agent: ancestorAgent });
            return true;
        }
        // 旧版宿主（DSH < 0.2.2-rc.3）回退：interruptByParent(childId, parentId, 'continuable')。
        // ancestorAgent 无 string id（旧测试夹具的裸 stub）时退用调用方提供的祖先会话 id。
        if (typeof subagents.interruptByParent === 'function') {
            const ancestorId = typeof ancestorAgent?.id === 'string' && ancestorAgent.id.length > 0
                ? ancestorAgent.id
                : ancestorIdFallback;
            if (typeof ancestorId !== 'string' || ancestorId.length === 0)
                return false;
            subagents.interruptByParent(childSessionId, ancestorId, 'continuable');
            return true;
        }
        return false;
    }
    catch {
        // 中断失败不阻断接续（沿用原 try/catch 口径）：接续由调用方兜底保证。
        return false;
    }
}
/*
 * [3.0.1][P1a 冲突修复] 宿主 subagent.maxDepth 设置与本插件三层体系的冲突检测。
 *
 * 宿主设置页「subagent.maxDepth」默认 1，但宿主 manager 的判定是
 * resolveChildDepth(parent, spec.maxDepth)：调用方（本插件）显式传了
 * maxDepth:2 时该设置被架空——插件放行 depth 2 成员，其余 subagent 调用方
 * 仍受设置约束。这本身可运行（插件派发按 spec 为准），但用户看到的设置
 * 与实际行为不一致，属于配置矛盾。此处检测「宿主配置值 < 插件要求的最小
 * 深度 2」并生成一次性告警文案（同一 scopeId 只告警一次，避免刷屏）；
 * 调用方负责把文案投递给用户可见会话。返回 null = 无冲突或已告警过。
 */
const depthOverrideWarnedScopes = new Set();
export function detectDepthOverrideConflict(subagents, scopeId) {
    if (typeof scopeId !== 'string' || scopeId.length === 0)
        return null;
    if (depthOverrideWarnedScopes.has(scopeId))
        return null;
    let configured;
    try {
        configured = typeof subagents?.resolveMaxDepth === 'function' ? subagents.resolveMaxDepth() : undefined;
    }
    catch {
        return null;
    }
    // 未配置 / 无限深度 / 已 ≥2：无冲突。
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured >= 2)
        return null;
    depthOverrideWarnedScopes.add(scopeId);
    return `【dsh-workplan·深度设置说明】检测到设置页「子代理最大深度」（subagent.maxDepth）当前为 ${configured}。该上限**只约束内置 subagent/subagent_fork 工具**；本插件的三层体系（你 → 部门负责人 → 专家）按派发契约固定需要第 2 层深度，宿主对该契约单独放行，不受此设置影响——这是设计使然，你的负责人派发给专家的流程在任何设置下都正常工作。若你的意图是「完全禁止子代理」，请直接停用本插件；若只是想让设置页显示与插件行为一致，可把该设置调到 2（立即生效，重启后恢复默认 1）。`;
}
// 检测并把冲突告警投递到指定会话（best-effort：任何失败不阻断派发主链路）。
function notifyDepthOverrideConflict(ctx, scopeId) {
    const text = detectDepthOverrideConflict(ctx?.subagents, scopeId);
    if (!text)
        return;
    try {
        const session = ctx?.sessions?.get?.(scopeId);
        appendUserMessage(session, text);
    }
    catch {
        /* 告警投递失败不影响派发 */
    }
}
/*
 * [3.0.1][P1b 冲突修复] 宿主子代理并发上限错误的友好翻译。
 *
 * 宿主对超过 subagent.maxActiveSubagents（默认 8，按会话树共享）的派发抛
 * SubagentError(code='ACTIVATION_LIMIT_REACHED', message="subagent limit
 * reached (active child limit: N)")。原样透出会让用户看到英文宿主错误且
 * 无从行动；此处翻译为可行动的中文提示（重试 / 调大设置）。非该错误时
 * 原样返回传入错误（不吞错、不改类型），由调用方决定如何包装。
 */
export function describeSubagentActivationError(error, context) {
    const code = String(error?.code ?? '');
    const raw = String(error?.message ?? error ?? '');
    if (code === 'ACTIVATION_LIMIT_REACHED' || /limit reached/i.test(raw)) {
        return new PlanError(`${context}：子代理并发数已达宿主上限（设置项 subagent.maxActiveSubagents，整个会话树共享）。请稍后重试（让在跑的任务先完成），或在「设置 → 子代理」中调大该上限。`, 'ACTIVATION_LIMIT_REACHED');
    }
    return error instanceof Error ? error : new Error(raw || String(error));
}
/**
 * [3.0.6][第 2 批] 宿主并发上限的“排队”而不是“判失败”。
 *
 * 宿主 `maxActiveSubagents`（默认 8）按**整棵会话树**共享；插件三层体系
 * （5 个负责人 + 每人再派专家）很容易在某一刻撞上限。旧实现把
 * `ACTIVATION_LIMIT_REACHED` 当普通失败：重试一次仍满就整行 `blocked`，
 * 用户什么都没做错却看到“任务失败”。
 *
 * 现在在 `startActivation` 外层做**有界等待**：撞上限就退避后再试，直到
 * 有空位、被取消、或等满 {@link ACTIVATION_QUEUE_MAX_WAIT_MS}。等待期间
 * 不写失败状态、不消耗子任务 attempt；只有等满才如实报“仍未等到空位”。
 *
 * 多个等待者共享一个模块级冷却时间，避免同一毫秒一起撞门（惊群）。
 * 这不是“精确信号量”（宿主没有暴露当前活跃数），而是“有界排队退避”：
 * 空位一出现，等待者按退避节奏自然补位。
 *
 * [3.1.0] 等待上限可用 DSH_WORKPLAN_ACTIVATION_QUEUE_MAX_WAIT_MS 覆盖
 * （默认 10 分钟不变）；新增 onWait 回调：每次退避决策后通知调用方，
 * 供派发循环向用户暴露「排队中」状态（排队可见化）。
 */
export const ACTIVATION_QUEUE_MAX_WAIT_MS = envPositiveInt('DSH_WORKPLAN_ACTIVATION_QUEUE_MAX_WAIT_MS', 10 * 60 * 1000);
const ACTIVATION_QUEUE_BASE_DELAY_MS = 1000;
const ACTIVATION_QUEUE_MAX_DELAY_MS = 15000;
let activationQueueCooldownUntil = 0;
export function isActivationLimitError(error) {
    if (String(error?.code ?? '') === 'ACTIVATION_LIMIT_REACHED')
        return true;
    return /limit reached/i.test(String(error?.message ?? error ?? ''));
}
export async function startActivationQueued(start, signal, context, onWait) {
    const beganAt = Date.now();
    let waits = 0;
    for (;;) {
        try {
            return await start();
        }
        catch (error) {
            if (!isActivationLimitError(error))
                throw error;
            if (signal?.aborted)
                throw new PlanError('排队等待子代理空位时被取消', 'ABORTED');
            const elapsed = Date.now() - beganAt;
            if (elapsed >= ACTIVATION_QUEUE_MAX_WAIT_MS) {
                throw describeSubagentActivationError(error, `${context}：已排队等待 ${Math.round(elapsed / 1000)} 秒仍未等到空位`);
            }
            waits += 1;
            const backoff = Math.min(ACTIVATION_QUEUE_MAX_DELAY_MS, ACTIVATION_QUEUE_BASE_DELAY_MS * 2 ** Math.min(4, waits - 1));
            const now = Date.now();
            // 全局冷却只增不减：所有等待者共用同一个“下一次可以再试”的时刻。
            activationQueueCooldownUntil = Math.max(activationQueueCooldownUntil, now + backoff);
            const delay = Math.max(250, activationQueueCooldownUntil - now);
            // [3.1.0] 排队可见化：退避决策通知调用方（派发循环据此发用户可见通知）。
            if (onWait) {
                try {
                    onWait({ waits, elapsedMs: Date.now() - beganAt });
                }
                catch { /* 通知回调失败不影响排队 */ }
            }
            await sleepAbortable(signal, delay + Math.floor(Math.random() * 250));
            if (signal?.aborted)
                throw new PlanError('排队等待子代理空位时被取消', 'ABORTED');
        }
    }
}
export function deriveReportPending(record) {
    const statuses = Array.isArray(record?.statuses) ? record.statuses : [];
    /*
     * [1.11.0] 只把「本轮完成、还没回报」算作待回报：`closure:'done'` 是
     * 1.11.0 的显式中间态。旧日志的 done 行没有 closure（null），它本来就
     * 已经通过结果消息回报过，若用 `!== 'reported'` 判定，升级后每一份
     * 1.10.6 的历史计划都会被判成「未回报」而永久不可交付。
     */
    return statuses.some((item) => item?.status === 'done' && item?.closure === 'done');
}
function readinessOf(record, snapshot) {
    const snap = snapshot ?? derivePlanSnapshot(record?.plan ? blockCancelledDependents(record.plan, record?.statuses) : record?.statuses, record?.plan ? definedSubtaskCount(record.plan) : undefined);
    return deliveryReadiness(snap, {
        phase: record?.phase,
        changePending: record?.changeRequest?.status === 'pending',
        reportPending: deriveReportPending(record),
        /*
         * 计划定义的验收标准是交付门的另一半：状态行只回答「子 Agent 说通过
         * 了几条」，这里回答「计划要求的几条有没有被逐条回应」。
         */
        expectedAcceptance: record?.plan ? expectedAcceptanceOf(record.plan) : undefined,
    });
}
/**
 * [2.5.2] 规划期间心跳间隔（默认 45s，DSH_WORKPLAN_PLANNING_HEARTBEAT_MS，
 * 毫秒 ≥5000）：runPlanner 仍在跑时按此间隔在会话里发一条可见进度通知，
 * 治「持续流式但很慢的尝试整段静默、用户以为死机」（本会话 turn 1 实测
 * 12.5 分钟零输出）。与失败重试通知正交，不改重试/超时语义。
 */
export const PLANNING_HEARTBEAT_MS = 45000;
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
export const PLANNER_TIMEOUT_MS = 300000;
/**
 * 首个 chunk 之后的「完全静默」窗口（默认 90s，DSH_WORKPLAN_PLANNER_IDLE_
 * TIMEOUT_MS，毫秒 >0）：文本、推理、usage 一个 chunk 都没有这么久，判定为
 * 连接卡死而不是模型还在思考。这个常量在 2.1.6 之前只声明、从未接线（死
 * 代码），现在真正参与计时；设为不小于无进展窗口即等价于关闭。
 */
export const PLANNER_IDLE_TIMEOUT_MS = 90000;
/**
 * 绝对上限 = 无进展窗口 × 该倍数（默认 900s）。慢可以，慢到没边不行：它给
 * 单次规划器尝试一个终点，保证规划失败永远是「有限时间后给出可执行建议」，
 * 而不是无限占用本轮预算。
 */
export const PLANNER_HARD_MULTIPLIER = 3;
/**
 * [2.2.0][T13b/推理等级] 规划器默认推理档 = max（用户 2026-11-08 决策 5）。
 *
 * 用户规则（AGENTS.md 第 12 条）只说过「子 Agent 不得继承主 Agent 的等级」，
 * 规划器同样是主 Agent 派出的子调用：任务里明确授权「规划器停止继承」。规划
 * 本身属于「跨多个系统梳理根因并给出方案」——按五档规则（轻度=low／中等=
 * medium或high／非常复杂=xhigh或max）属非常复杂 → 默认取 max（五档内的最高
 * 档；xhigh 留给显式覆盖）。`DSH_WORKPLAN_PLANNER_REASONING_EFFORT` 仍可显式
 * 覆盖（用户为降本/提速
 * 主动选择低档时有效），未设或非法时才用本默认值；**绝不读取
 * modelSelection.reasoningEffort**。旧行为（plannerEffort || 主 Agent 档位）会
 * 让主 Agent 的 low/high 直接决定拆解质量，与「子 Agent 自决档位」同源、同错。
 */
export const DEFAULT_PLANNER_REASONING_EFFORT = 'max';
/*
 * [2.2.7] 推理档位兼容性钳制（用户 2026-11-09 报告的 PLANNER_LLM_ERROR 根因修复）。
 *
 * 宿主 dsh-llm 会在发起网络请求之前，把请求的 reasoningEffort 与该模型声明的
 * `reasoning.efforts` 清单逐一比对，不在清单内即抛 UNSUPPORTED_REASONING_EFFORT
 * （本地失败、重试不会自愈）。规划器默认 max、子任务档位允许 low / medium /
 * high / xhigh / max 五档——这些都假设主链路模型支持相应档位。一旦运行在
 * qwen 这类只声明 low/medium/xhigh 的模型上，第一次规划调用就被宿主拒绝，
 * 整个自动分解降级；
 * 同一枚雷也埋在派发侧：计划里的 high/max/xhigh 行派给 qwen 子会话会同样即抛。
 *
 * 治本方案不是按模型名字猜档位（家族无穷、名单过时），而是在发送任何带档位的
 * 请求前，用宿主公开能力面 `llm.resolveModelInfo` 读出目标模型**实际声明**的
 * 档位清单，把请求档位钳制到清单内强度最接近的一档：
 *  - 清单包含请求档位 ⇒ 原样发送（模型声明支持五档时，low/medium/high/xhigh/max
 *    全部原样透传，不钳制）；
 *  - 否则取「不高于请求档」里最高的支持档（max→xhigh、high→medium…）；
 *    [2.2.7][T4/五档] 五档请求落在三档清单（low/high/max）上的降级序按强度表
 *    逐级下探：max 原样、xhigh→high、high 原样、medium→low、low 原样；落在
 *    qwen 型清单（low/medium/xhigh）上：max→xhigh、xhigh 原样、high→medium、
 *    medium 原样、low 原样。降级序即 EFFORT_STRENGTH_ORDER 中「不高于请求档」
 *    的最近支持档，任何合法五档值都不会被拒绝或清空；
 *  - 全部支持档都强于请求档 ⇒ 取最弱支持档（宁可降质，不可失败）；
 *  - 模型根本没有 reasoning 元数据（空清单）⇒ 不发送 reasoningEffort 字段，
 *    与宿主 resolveCallWithInfo 的「reasoning===undefined 时任何档位都抛错」对齐；
 *  - 能力查询不可用（宿主不暴露 / 查询抛错）⇒ 保持旧行为，绝不因钳制引入新故障。
 */
// [3.0.0] 去副本：强度序单一真源为 plan.ts 导出的 EFFORT_STRENGTH_ORDER（上方已导入，本文件直接引用）。
/** 请求档位 → 模型支持清单内的等效钳制档；空清单返回 undefined（= 不发送该字段）。 */
export function clampEffortToSupported(effort, supported) {
    if (!Array.isArray(supported) || supported.length === 0)
        return undefined;
    if (supported.includes(effort))
        return effort;
    const rank = (id) => EFFORT_STRENGTH_ORDER.indexOf(id);
    const ranked = [...supported].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra === rb)
            return 0;
        if (ra < 0)
            return 1;
        if (rb < 0)
            return -1;
        return ra - rb;
    });
    const target = rank(effort);
    if (target < 0)
        return ranked[ranked.length - 1];
    const atOrBelow = ranked.filter((id) => rank(id) >= 0 && rank(id) <= target);
    if (atOrBelow.length > 0)
        return atOrBelow[atOrBelow.length - 1];
    return ranked[0];
}
const supportedEffortsCache = new Map();
/**
 * 读取 provider/model 声明的推理档位清单。
 * @returns 档位 id 数组（可为空数组 = 模型不支持任何档位）；null = 无从判定，调用方保持旧行为。
 */
export async function resolveSupportedEfforts(llm, provider, model, signal) {
    if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model)
        return null;
    const key = `${provider}/${model}`;
    const hit = supportedEffortsCache.get(key);
    if (hit)
        return hit;
    if (signal?.aborted)
        return null;
    try {
        const info = await llm.resolveModelInfo(provider, model, signal);
        const efforts = info?.reasoning?.efforts;
        const list = Array.isArray(efforts)
            ? efforts.map((item) => String(item?.id ?? '')).filter((id) => id !== '')
            : [];
        supportedEffortsCache.set(key, list);
        return list;
    }
    catch {
        // 查询失败 ⇒ 与「宿主不暴露该能力」同等处理：不钳制、不缓存、不阻断。
        return null;
    }
}
/*
 * [3.0.1] 历史时间常量，仅供旧数据回放、纯函数审计与兼容测试读取。
 *
 * 生产执行不再调用 resolveSubtaskTimeoutMs，也不会用这些值创建计时器。
 * 部门负责人和全球顶尖专家的正式执行没有墙钟、空闲、回执或整轮截止；
 * timeoutMs / extendMs 即使出现在旧计划中也不会重新生效。保留数值是为了
 * 让旧计划、旧日志和旧测试仍能解释当时发生的事，而不是允许重新启用限制。
 */
export const CHILD_TIMEOUT_MS = 900000;
export const CHILD_IDLE_TIMEOUT_MS = 300000;
export const MIN_CHILD_TIMEOUT_MS = 1000;
export const MAX_CHILD_TIMEOUT_MS = 7200000;
export const MIN_CHILD_IDLE_MS = 1000;
export const MAX_CHILD_IDLE_MS = 900000;
export const CHILD_POLL_MS = 2000;
/*
 * [3.0.1] 派发回执只剩提示，没有硬截止。
 *
 * 90s 后仍未观察到子会话新事件时标记 ackOverdue，供看板提示和主 Agent 跟进；
 * 该标记不会 blocked、中止、换人或拒绝 done。ASSIGN_ACK_DEADLINE_MS 仅为
 * 旧脚本/测试保留的历史值，生产路径不再读取。
 */
export const ASSIGN_ACK_NOTICE_MS = 90000;
export const ASSIGN_ACK_DEADLINE_MS = 180000;
/*
 * [3.0.1] 指示回执只剩提示，没有硬截止。
 *
 * 60s 没有新事件先标 `instructionOverdue`（看板可见、主 Agent 可催），
 * 但不因缺少回执收束、阻断或换人；真正结果、真实错误或用户取消才结束。
 * INSTRUCTION_ACK_DEADLINE_MS 仅为旧脚本/测试保留，生产路径不再读取。
 */
export const INSTRUCTION_ACK_NOTICE_MS = 60000;
export const INSTRUCTION_ACK_DEADLINE_MS = 180000;
/*
 * 正向回执的观察频率。5s 足以在 60s 提醒前发现「子会话已在动」，同时把
 * 会话读取次数控制在可接受范围（每个等指示的行每 5s 一次只读查询）。
 */
export const INSTRUCTION_POLL_MS = 5000;
// [3.0.1] 整轮预算已停用。
//
// dispatchPlan 的 deadline 恒为 Infinity，不再创建 totalTimer；显式配置
// DSH_WORKPLAN_TOTAL_TIMEOUT_MS 或旧 totalTimeoutMs 也不会中止任何负责人/
// 专家，或产生“预算用尽/可续跑”。TOTAL_TIMEOUT_MS/NO_ROUND_BUDGET_MS
// 仅保留给旧记录解释和兼容测试，不代表仍可通过配置重新开启。
export const TOTAL_TIMEOUT_MS = 0;
export const NO_ROUND_BUDGET_MS = 20 * 24 * 60 * 60 * 1000;
export const ROUND_TIMER_MAX_MS = 2_000_000_000;
export const DISPOSE_TIMEOUT_MS = 5000;
export const STALE_PENDING_MS = 10 * 60 * 1000;
export const MAX_HISTORY_EVENTS = 2000;
export const MAX_LIVE_SESSIONS = 20;
/**
 * 看板响应上限按**字节**计，而不是 JavaScript 字符串长度。
 * UTF-8 下一个汉字通常 3 字节：旧实现用 `body.length > 2_500_000`，中文响应
 * 实际可发出约 7.5MB，远超注释承诺的 2.5MB。截断后也必须复检，否则 12 个
 * 会话仍可能超限。
 */
export const MAX_PLANS_RESPONSE_BYTES = 2_500_000;
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
 * 终态（cancelled/superseded）判定复用 plan.ts 的同一真源 `isTerminalPhase()`
 * （TERMINAL_PHASES），不再本地硬编码；goal 轮次入口在终态之外，done/ended/
 * degraded/clarify 同样是「这一轮可以开始新计划」的历史记录，不能把 `/goal`
 * 任务永久挡在自动分解之外。
 */
function planRecordIsLive(existing) {
    if (!existing?.plan)
        return false;
    const phase = String(existing.phase ?? '');
    return !isTerminalPhase(phase) && !['done', 'ended', 'clarify', 'degraded'].includes(phase);
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
/**
 * [T4][F4] 结算回调失败的审计行：把「被吞掉的回调」变成可读、可回放的事实。
 *
 * 旧实现两处结算回调 catch 都是静默吞错（`catch { /* … *\/ }` 与 `.catch(() => {})`），
 * 事后无法回答「这条台账为什么没有结算」。审计行带 subtaskId / childId / 阶段，
 * 写入 record.errors（有界 20 条，随 durable 消息与回放保留）。
 */
export function settlementCallbackFailureLine(info) {
    return `${info.subtaskId}: 结算回调异常（childId=${info.childId || '未知'}，阶段=${info.stage}）：`
        + truncate(describeError(info.error), 300);
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
     *    low / medium / high / xhigh / max 五档。非法值不传给模型，回落默认档（见下）。
     *
     * [2.2.0][T13b] 用户 2026-11-08 决策 5「规划器停止继承」：未设该旋钮时，规划器
     * 不再沿用主 Agent 的推理档，而是取 DEFAULT_PLANNER_REASONING_EFFORT（max）。
     * 校验白名单复用 plan.ts 的 REASONING_EFFORTS（五档：low / medium / high /
     * xhigh / max；[2.2.7][T4] 由三档扩五档，medium/xhigh 现为合法值）：把
     * "ultra"/"minimal" 这类非法值原样发给模型，真实宿主会以 400 拒绝整次规划——
     * 环境变量写错不应该让整个
     * 任务降级，所以非法值按「未设置」处理。
     */
    const plannerMaxTokens = normalisePlannerWindow(process.env.DSH_WORKPLAN_PLANNER_MAX_TOKENS, 0);
    // 大小写归一："LOW" 这类写法若因大小写被当成非法值回落 max，会静默抬高
    // 用户的成本预期，所以先归一化再进白名单。
    const plannerEffortRaw = String(process.env.DSH_WORKPLAN_PLANNER_REASONING_EFFORT ?? '').trim().toLowerCase();
    const plannerEffort = REASONING_EFFORTS.includes(plannerEffortRaw) ? plannerEffortRaw : '';
    /*
     * [2.3.9][T3/llm-rules] 用户强制要求 1/2（分配前先检测模型家族）：qwen 开头
     * 模型只允许 low / medium / xhigh，其余模型只允许 low / high / max。
     * env 显式覆盖仍优先，覆盖值同样过静态收窄。静态约束先于宿主能力钳制执行
     * （两道闸：静态表权威，能力面在其上继续交集钳制，均留痕，与 U7 裁决一致）。
     * 模型名缺失⇒不施加静态约束并用原默认档，保持 [2.2.7]「无从判定⇒不阻断」旧行为。
     *
     * [2.5.2][stall-fix] 根因修复（用户报告「提交任务后长时间无反应/以为死机」）：
     * 旧默认档取家族最高档（qwen⇒xhigh、非 qwen⇒max），规划器要在最高推理档
     * 生成整份大 JSON，实测单次规划 12-13 分钟——预告之后长时间只有心跳、没有
     * 结果，用户体验即「死机」。规划是结构化分解（中等复杂度），默认档改为
     * 家族中等档（qwen⇒medium、非 qwen⇒high），显著缩短首屏等待；需要最高档
     * 的会话仍可用 DSH_WORKPLAN_PLANNER_REASONING_EFFORT 显式覆盖。中等档不在
     * 合法集时回落最高档（不改变家族白名单语义）。
     */
    const plannerStaticAllowed = allowedEffortsForModel(modelSelection?.model);
    const plannerModerateDefault = classifyModelFamily(modelSelection?.model) === 'qwen' ? 'medium' : 'high';
    const plannerFamilyDefault = (plannerStaticAllowed && plannerStaticAllowed.includes(plannerModerateDefault)
        ? plannerModerateDefault
        : highestEffortOf(plannerStaticAllowed)) ?? DEFAULT_PLANNER_REASONING_EFFORT;
    const requestedPlannerEffort = plannerEffort || plannerFamilyDefault;
    const plannerEffortOriginLabel = plannerEffort ? 'env' : `default-${plannerFamilyDefault}`;
    const plannerStaticCorrection = plannerStaticAllowed && !plannerStaticAllowed.includes(requestedPlannerEffort)
        ? correctEffortForModel(requestedPlannerEffort, modelSelection?.model)
        : null;
    const staticRulePlannerEffort = plannerStaticCorrection ? plannerStaticCorrection.effort : requestedPlannerEffort;
    const plannerStaticTrace = plannerStaticCorrection
        ? `→${classifyModelFamily(modelSelection?.model) === 'qwen' ? 'qwen-rule' : 'non-qwen-rule'}:${plannerStaticCorrection.requested}→${plannerStaticCorrection.effort}`
        : '';
    if (plannerStaticCorrection) {
        console.warn('[dsh-workplan] planner reasoning effort corrected by LLM family rules:', JSON.stringify({
            provider: modelSelection?.provider,
            model: modelSelection?.model,
            family: classifyModelFamily(modelSelection?.model),
            requested: requestedPlannerEffort,
            corrected: plannerStaticCorrection.effort,
            allowed: plannerStaticAllowed,
            reason: plannerStaticCorrection.reason,
        }));
    }
    /*
     * [2.2.7] 发送前按模型能力钳制档位：宿主对不支持的档位会在网络调用前直接
     * 抛 UNSUPPORTED_REASONING_EFFORT，重试不自愈（终态），整次规划因此降级。
     * 查询不可用时保持旧行为；查询成功后请求档钳制到清单内等效档，空清单
     * （模型无 reasoning 元数据）则不发送档位字段。'' 在这里表示「不发送」。
     */
    const plannerEffortSupport = await resolveSupportedEfforts(ctx.llm, modelSelection?.provider, modelSelection?.model, signal);
    const effectivePlannerEffort = plannerEffortSupport === null
        ? staticRulePlannerEffort
        : (clampEffortToSupported(staticRulePlannerEffort, plannerEffortSupport) ?? '');
    if (plannerEffortSupport !== null && effectivePlannerEffort !== staticRulePlannerEffort) {
        console.warn('[dsh-workplan] planner reasoning effort clamped for model compatibility:', JSON.stringify({
            provider: modelSelection?.provider,
            model: modelSelection?.model,
            requested: staticRulePlannerEffort,
            effective: effectivePlannerEffort || '(omitted)',
            supported: plannerEffortSupport,
        }));
    }
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
                // [2.2.7] '' = 模型无 reasoning 元数据，不发送档位字段（发送必被宿主拒绝）。
                ...(effectivePlannerEffort ? { reasoningEffort: effectivePlannerEffort } : {}),
                ...(plannerMaxTokens > 0 ? { maxTokens: plannerMaxTokens } : {}),
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                signal: controller.signal,
                sessionId,
            });
            const text = await collectStream(stream, onChunk, sink);
            lastText = text;
            const raw = extractJson(text);
            // [2.3.9][T3] 事前约束：规划器显式写出集合外档位 → validatePlan 拒绝并点名，
            // 经重试回路回喂自纠（用户要求 1/2；模型名缺失⇒null⇒不施加）。
            const validated = validatePlan(raw, { allowedEfforts: allowedEffortsForModel(modelSelection.model) });
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
                    // [2.5.5] 归一化留痕随计划持久化，status/回放可见（治本不静默）。
                    if (Array.isArray(validated.notes) && validated.notes.length > 0) {
                        plan.normalizations = validated.notes;
                    }
                    return plan;
                }
                outcome = 'CONTEXT_GUARD';
                lastErrors = guard.errors.length > 0 ? guard.errors : guard.warnings;
                /*
                 * [3.0.1][治本] 只有用户本人能答复的校验错误（CLARIFY=要求自相矛盾、
                 * CONTEXT=指代找不到先行词）禁止交回规划器重试：重试的所谓「修复」只能是
                 * 模型替用户瞎猜，猜过守卫后计划照常自动派发——用户还没来得及答复，
                 * 部门 Agent 已经对着猜出来的目标开工（本次用户报告的正是这一行为）。
                 * 这类错误立即中止规划，由入口转成「先澄清」卡片等用户明确答复；
                 * 只有 DEVIATION 这类规划器自己能改写的才继续重试。
                 */
                const askUser = lastErrors.filter((entry) => /^(?:CLARIFY|CONTEXT):/.test(String(entry)));
                if (askUser.length > 0) {
                    const reason = askUser.map((entry) => String(entry).replace(/^(?:CLARIFY|CONTEXT):\s*/, '')).join('；');
                    const hasClarify = askUser.some((entry) => String(entry).startsWith('CLARIFY'));
                    const hasContext = askUser.some((entry) => String(entry).startsWith('CONTEXT'));
                    const question = [
                        hasClarify ? '上述互相矛盾/缺失的信息以哪个为准？请用户明确取舍' : '',
                        hasContext ? '任务里的指代具体指哪个对象？请用户给出名称、路径或原内容' : '',
                    ].filter(Boolean).join('；');
                    throw new PlanError(reason, 'CLARIFY_NEEDED', question);
                }
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
            /*
             * [3.0.1] CLARIFY_NEEDED 是终态，不是可重试错误：原样上抛给入口转澄清卡片。
             * 必须最先判定——否则会被下面的泛化处理标成 outcome 并进入下一次重试。
             */
            if (error instanceof PlanError && error.code === 'CLARIFY_NEEDED') {
                outcome = 'CLARIFY_NEEDED';
                throw error;
            }
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
                        // [2.3.2][D2-P1] 定向修复指令：message 已含「错误位置 + 断点附近原文」（extractJson
                        // 的 parseFailureHint），这里明确要求只修语法、不动内容，替代旧「整段重掷」。
                        ? '末尾已闭合 → 断点在正文中间，属语法写错（漏逗号/括号不匹配）：请按上文「错误位置/断点附近原文」只修复该处语法，禁止改动字段值与整体结构'
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
                    // [2.2.7] 钳制发生时同样记录实际发出值（'' = 未发送）。
                    reasoningEffort: effectivePlannerEffort,
                    reasoningEffortSource: plannerEffortOriginLabel
                        + plannerStaticTrace
                        + (plannerEffortSupport !== null && effectivePlannerEffort !== staticRulePlannerEffort
                            ? `→clamped(${staticRulePlannerEffort})` : ''),
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
/*
 * [3.0.0] F10 专家汇报门禁接线（用户 2026-11-14 要求 7；契约同一事实源
 * src/comm-format.ts 的 F10 条目 / src/v3-contract.ts 的 checkExpertReport）。
 *
 * 第三层叶子（专家）的产出有两处结算回调消费（delegateTool dispatch /
 * selfEffort 接续），此前只看 stopReason：专家即使不写精简 report 对象也会被
 * 记成 done，F10 形同虚设。现在在两处回调的汇报入口统一过这道核验：
 * 只对「子会话正常结束且结果块声明 done」的汇报校验 report 对象
 * （keyResults/keyInfo/importantInfo/leadRequirements 四字段齐全、非空、
 * 不重复）；缺失或重复即退回（该成员记 failed 并附 F10 拒因），绝不记 done。
 *
 * 最小侵入、只拦 done 路径：F1–F9 与三阶段既有判定不在此重复；replay/读档
 * 路径不经这两个回调，行为零变化。
 *
 * [修复] 与主链路「非法 JSON 绝不计 done」同一口径（T4 契约）：
 *  - 结果块缺失 / JSON 无法解析：旧实现返回 ok:true，这类汇报被**记成成员
 *    done**（看板虚报完成，与 executeSubtask 的 EVIDENCE_UNPARSABLE 闸矛盾）；
 *    现在记 failed 并附拒因，负责人核实产物后可重派。
 *  - 声明 blocked/partial：旧实现同样记 done；现在记 failed，受阻原因随拒因
 *    交负责人（escalate 工具已登记 escalation 的行不受本判定影响——结算回调
 *    里 escalation 优先于 done/failed）。
 */
function adjudicateExpertReport(outcome) {
    const text = resultText(outcome);
    const parsed = parseEvidenceBlock(text);
    const payload = parsed && typeof parsed === 'object' ? parsed.payload : null;
    if (!payload || typeof payload !== 'object') {
        return {
            ok: false,
            rejection: '专家汇报无法结算：结果块缺失或 JSON 无法解析（完成必回报，非法 JSON 绝不计 done）；请负责人核实其产物后重派，或按实改判',
        };
    }
    if (String(payload.status ?? '') !== 'done') {
        return {
            ok: false,
            rejection: `专家汇报声明 status=${String(payload.status ?? '（缺失）')}（非 done，不计完成）：${truncate(String(payload.blockedReason ?? payload.question ?? '未附原因'), 200)}`,
        };
    }
    const report = checkExpertReport(payload.report);
    if (!Array.isArray(report.violations) || report.violations.length === 0)
        return { ok: true };
    return {
        ok: false,
        rejection: `专家汇报未通过 F10 精简汇报契约核验，结果退回重交：${report.violations.slice(0, 4).join('；')}`,
    };
}
async function disposeActivation(activation, record, subtaskId, guard) {
    let timer = null;
    try {
        await Promise.race([
            activation.dispose(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('dispose timeout')), DISPOSE_TIMEOUT_MS);
                // [2.2.9][handle-policy] 收束类（T1 报告 R6）：dispose 超时臂必须真实触发，
                // unref 时裸事件循环下进程先排空、race 永不 settle 也不报错。下方 finally 照常 clearTimeout。
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
 * [3.1.8][治本] 派发实例表：childId → { planId, subtaskId }。
 *
 * 为什么需要它：`writeSubtaskStatus` 只改内存台账（本轮审查的根因之一）。
 * 轮次进行中一旦台账被重建替换（手动 dispatch、update 改判、重启回放），
 * 内存里的 `childId` 就丢了；而正在运行的部门负责人会话紧接着调
 * `delegate(action="review"/"direct")` 时按 childId 反查不到自己的行，
 * 被 `NO_SUBTASK` 拒绝 ⇒ 推理等级登记不了 ⇒ phase-0 结算闸报
 * `SELF_EFFORT_MISSING` ⇒ 白白重试一次（真实现场：T2/T3 各重试 1 次）。
 *
 * 「这个子会话是哪个子任务派出去的」是进程内的客观事实，不该跟着台账一起丢。
 * 表挂在 ctx 上（WeakMap，随运行时实例存活）：进程重启后子会话本身也不存在，
 * 无需持久化；而台账重建（同一进程内换对象）时它仍然有效——正好覆盖漏洞窗口。
 * 认亲成功后调用方会把 childId 补写进 durable 日志，后续重建读档即可自证。
 */
const activationRegistry = new WeakMap();
function rememberActivation(ctx, childId, planId, subtaskId) {
    if (!ctx || typeof childId !== 'string' || !childId)
        return;
    let map = activationRegistry.get(ctx);
    if (!map) {
        map = new Map();
        activationRegistry.set(ctx, map);
    }
    map.set(childId, { planId: String(planId ?? ''), subtaskId: String(subtaskId ?? '') });
}
function recallActivation(ctx, childId) {
    if (!ctx || typeof childId !== 'string' || !childId)
        return null;
    return activationRegistry.get(ctx)?.get(childId) ?? null;
}
/*
 * [3.1.8][P0 D4] 子任务 → 当前存活负责人会话的进程内登记表。
 *
 * 为什么不能只看 statuses[].childId：resetBlockedStatuses 续跑时会把行重置为
 * pending 并把 childId 清空（applyStatus 的 childId:null 不留历史），于是同一
 * 子任务可以在旧负责人还活着时被再次派发，出现两个负责人并行写同一目录、先
 * 结算者胜、另一会话工作被丢弃（T2 事故 028f5a26 与 2933143e 并行）。
 *
 * 「这个子任务已经起过哪个负责人、它现在还活不活」是进程内的客观事实，和
 * activationRegistry 同范式，不随台账重置/重建丢失。进程重启后旧会话本来就
 * 不存在，因此无需持久化；只拦同一进程内的重复起头。
 */
const headActivationRegistry = new WeakMap();
function headActivationKey(planId, subtaskId) {
    return `${String(planId ?? '')}\u0000${String(subtaskId ?? '')}`;
}
export function rememberHeadActivation(ctx, planId, subtaskId, childId) {
    if (!ctx || typeof childId !== 'string' || !childId)
        return;
    let map = headActivationRegistry.get(ctx);
    if (!map) {
        map = new Map();
        headActivationRegistry.set(ctx, map);
    }
    map.set(headActivationKey(planId, subtaskId), { childId, at: Date.now() });
}
/**
 * 返回该子任务仍存活的负责人 childId；负责人已消失则顺手清掉死条目。
 * `ctx.sessions.get` 只查活体会话（宿主释放后返回空），因此不需要额外心跳。
 */
export function recallLiveHeadActivation(ctx, planId, subtaskId) {
    if (!ctx)
        return null;
    const map = headActivationRegistry.get(ctx);
    const key = headActivationKey(planId, subtaskId);
    const entry = map?.get(key);
    if (!entry)
        return null;
    let live = false;
    try {
        live = Boolean(ctx.sessions?.get?.(entry.childId));
    }
    catch {
        live = false;
    }
    if (live)
        return entry.childId;
    map?.delete(key);
    return null;
}
/**
 * [3.1.8][P0 D4] 负责人结算/释放后撤销登记，避免「旧会话仍活着但已不干活」
 * 让 dispatchPlan 永久拒绝该子任务的合法重派。
 *
 * childId 用于防止旧尝试的 finally 删掉同一子任务后来登记的更新负责人：
 * 只有登记表里仍是这个 childId 时才删。
 */
export function forgetHeadActivation(ctx, planId, subtaskId, childId) {
    if (!ctx)
        return;
    const map = headActivationRegistry.get(ctx);
    if (!map)
        return;
    const key = headActivationKey(planId, subtaskId);
    const entry = map.get(key);
    if (!entry)
        return;
    if (typeof childId === 'string' && childId && entry.childId !== childId)
        return;
    map.delete(key);
}
/**
 * [3.1.8][P0 D1/D3] 负责人身份判据：当前 childId 或 childIdHistory 命中都算。
 *
 * 负责人换主时 applyStatus 会把前任 childId 追加进 childIdHistory（plan.ts
 * 有界 8 条）；旧负责人会话仍是其派出叶子的直接父会话，必须能继续认亲，
 * 否则 self_effort 与 instruct 都会把合法负责人判成陌生人。
 */
export function headRowOwnedBy(row, sessionId) {
    if (!row || typeof sessionId !== 'string' || !sessionId)
        return false;
    if (row.childId === sessionId)
        return true;
    return Array.isArray(row.childIdHistory)
        && row.childIdHistory.some((entry) => entry?.childId === sessionId);
}
/**
 * [3.1.8][P0 D3] 负责人认亲三级回退（与 delegateTool 入口同判据）：
 * ① 当前 childId → ② childIdHistory（换主留档）→ ③ 调用者仍是某条已登记
 * 叶子的直接父会话。第三级只用于找回「哪个部门行」，目标叶子的投递边界仍由
 * instructDelegateLeaf 的 spawnedChildIds + 父链双校验守住。
 */
export function findHeadRowForSession(statuses, sessionId, getSession) {
    const list = Array.isArray(statuses) ? statuses : [];
    if (typeof sessionId !== 'string' || !sessionId)
        return null;
    const direct = list.find((row) => row?.childId === sessionId);
    if (direct)
        return direct;
    const historical = list.find((row) => headRowOwnedBy(row, sessionId));
    if (historical)
        return historical;
    return list.find((row) => Array.isArray(row?.delegates)
        && row.delegates.some((item) => {
            if (!item?.childId)
                return false;
            try {
                return getSession?.(item.childId)?.header?.parentSession === sessionId;
            }
            catch {
                return false;
            }
        })) ?? null;
}
/**
 * [3.1.8][P0 D2] 重派登记前的基线修正。
 *
 * mergeDelegateEntriesMonotonic 的「新一轮尝试」判据要求 incoming 带非空且
 * 不同的 childId；而 D2 的占位条目恰恰是 childId=null 的 running。若旧条目
 * 是 failed/rejected/timeout/blocked，merge 会按终态优先保留旧条目，占位根本
 * 落不了账——重派场景又回到「叶子 phase-0 开工找不到成员」的窗口。
 *
 * 这里只在「本次派发显式新建的同名占位」上替换旧终态；待指示
 * （escalation / closure==='escalated'）与 done 一律保留。替换后的基线再交给
 * merge，仍由它统一做字段级合并与上限约束。
 */
export function prepareDelegateRegistrationBase(current, incoming) {
    const base = Array.isArray(current) ? current : [];
    const placeholders = (Array.isArray(incoming) ? incoming : []).filter((item) => item && item.childId == null && item.status === 'running'
        && typeof item.member === 'string' && item.member !== '');
    if (placeholders.length === 0)
        return base;
    const terminal = new Set(['failed', 'rejected', 'timeout', 'blocked']);
    return base.map((existing) => {
        if (!existing || existing.escalation || existing.closure === 'escalated')
            return existing;
        const placeholder = placeholders.find((item) => item.member === existing.member);
        if (!placeholder)
            return existing;
        return terminal.has(String(existing.status ?? '')) ? placeholder : existing;
    });
}
/**
 * [3.1.8][治本] 认亲成功后的 durable 补绑：把 childId 写进工作日志。
 *
 * 只补「身份」一个字段（status/closure 等保持原样），不制造新的状态迁移；
 * 写失败只记错误、不影响本次调用（内存已认亲，本次照常放行）。
 */
/**
 * [3.1.7][治本] 接续证据落盘：把完整登记原文写进工作区 reports/，返回相对路径。
 *
 * 提示词里只带「执行蓝图 + 审计链索引 + 这个路径」，证据一条不丢（文件是原文），
 * 但每次接续不再为审计链的全文付费。写盘失败（无 cwd / 只读目录 / 证据非法）
 * 一律返回 null——调用点据此回退「全文注入」，绝不因这条路丢证据。
 */
export function persistStartEvidenceFile(cwd, planId, subtaskId, evidence) {
    try {
        if (typeof cwd !== 'string' || !cwd)
            return null;
        const sanitized = sanitizeStartPhaseEvidence(evidence);
        if (!sanitized)
            return null;
        const safe = (value) => String(value ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
        const rel = join('reports', `wp-start-evidence-${safe(planId)}-${safe(subtaskId)}.md`);
        const abs = join(cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, [
            '# 开工登记证据（完整原文）',
            '',
            `- 计划：${String(planId ?? '')}`,
            `- 子任务：${String(subtaskId ?? '')}`,
            `- 生成时间：${new Date().toISOString()}`,
            '',
            renderStartPhaseEvidence(sanitized),
            '',
        ].join('\n'), 'utf8');
        return rel;
    }
    catch {
        return null;
    }
}
function persistChildIdentity(ctx, record, parentId, subtaskId, childId) {
    try {
        const current = (record.statuses ?? []).find((item) => item?.subtaskId === subtaskId);
        if (!current || current.childId === childId)
            return;
        const revision = Number(current.revision ?? 0) + 1;
        record.statuses = applyStatus(record.statuses, subtaskId, { childId, revision, updatedBy: 'child' });
        const session = ctx.sessions?.get?.(parentId);
        appendUserMessage(session, buildUpdateMessage({
            planId: record.plan?.planId,
            planCreatedAt: record.plan?.createdAt,
            subtaskId,
            status: current.status,
            childId,
            revision,
        }));
    }
    catch (error) {
        pushRecordError(record, error);
    }
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
 * The `TOTAL_TIMEOUT` branch（整轮预算到点；现行默认 TOTAL_TIMEOUT_MS=0 即不设
 * 整轮硬预算，仅显式配置正数时启用）resets unfinished rows to `pending`, and
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
function settleFromOutput(record, subtask, output, guard, options, 
/*
 * [2.2.8][T7] 两个可选入参：`precomputedVerdict` 让调用方把已经裁决过的
 * 结果直接传入（unparsable 门在结算前判定过一次，纯函数重算是浪费也是
 * 双源）；`extraEvidence` 只在「解析失败重试耗尽、按实受阻」时传入——
 * 它把 attempt 摘要/声明产物在盘上的事实随 blocked 行留档。
 */
precomputedVerdict, extraEvidence) {
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
    const verdict = precomputedVerdict ?? adjudicateResult({
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
        /*
         * [3.0.0][用户要求 7/10/11] 格式层级：计划行＝部门负责人，结果必须带
         * departmentSummary（F11）；专家结果必须带 report（F10）。结算时按行上
         * 已派发的专家名单做覆盖度核对。缺省（无层级/旧回放）不查新条目。
         */
        formatTier: (Array.isArray(record?.statuses)
            ? record.statuses
                .find((item) => item?.subtaskId === subtask?.id)?.delegates
                ?.map((item) => String(item?.member ?? ''))
                .filter((name) => name !== '') ?? []
            : []).length > 0 ? 'leader' : undefined,
        expectedExperts: Array.isArray(record?.statuses)
            ? record.statuses
                .find((item) => item?.subtaskId === subtask?.id)?.delegates
                ?.map((item) => String(item?.member ?? ''))
                .filter((name) => name !== '') ?? []
            : [],
        /*
         * [3.0.8] 开工-结算一致性比对输入：行级 startPhases（review/direct 开工闸
         * 登记值）；历史行无登记 ⇒ undefined，跳过比对（零迁移）。
         */
        startPhases: Array.isArray(record?.statuses)
            ? record.statuses.find((item) => item?.subtaskId === subtask?.id)?.startPhases ?? undefined
            : undefined,
    });
    const checked = checkArtifacts(verdict.artifacts, options.cwd, options.artifactExists);
    const escalated = verdict.status === 'blocked'
        && typeof verdict.question === 'string' && verdict.question.trim() !== '';
    /*
     * [2.2.8][T7] 解析失败重试耗尽后的受阻，不得退化成「零产出失败」。
     *
     * T4 实证：子会话工作已完成、交付物已在盘上，只是结果块 JSON 写坏了；
     * 旧账本只留一句「结果块 JSON 非法」，主 Agent 无从知道产物存在，只能
     * 级联下游重做。现在把 attempt 摘要/声明产物中**确实在盘上**的清单随
     * blocked 行留档，并在 error 文案里给出「用 dsh_workplan_update 复核改判」
     * 的出口。语义不变：非法 JSON 依旧不计 done，这里只是把事实说全。
     */
    const landedRefs = (extraEvidence?.artifacts ?? [])
        .filter((item) => item?.exists === true)
        .map((item) => String(item?.ref ?? ''))
        .filter((ref) => ref !== '');
    const reviewNote = landedRefs.length > 0
        ? `；本次回报声明的产物清单已随本行留档（已在盘上：${landedRefs.slice(0, 6).join('、')}）——产物已在盘上，`
            + '请先用 dsh_workplan_update 复核改判，勿按零产出处理，也不要级联阻断下游'
        : '';
    const settleError = typeof verdict.error === 'string' && verdict.error !== ''
        ? `${verdict.error}${reviewNote}`
        : verdict.error;
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
    /*
     * [SCv2-T4][Q1-B/S-Q1-3/Q3-B/Q6-A] 判据层结算闸（spec §3.5 第 4 步）：
     * 仅对判据 v2 已生效的计划（D-1 三重门后新创建）判定；未生效计划行为逐字不变。
     * 运行层先安全结算（不丢成果，L4/产物探测照旧），再判判据层：done 且
     * 事前预估之和 ≤10 且事后单次墙钟 ≤10 ⇒ met；有用户批准留痕 ⇒ exception-approved；
     * 否则 unmet ⇒ 不得 done，改判 blocked(criterion-overrun)、记违规（append-only）、
     * 文案指向 replan(replace) 接替行只补缺口。判定顺序＝运行层→判据层（S-Q7-5）。
     */
    let effectiveStatus = verdict.status;
    let effectiveError = settleError;
    let criterionResultValue = null;
    let criterionDirectWrite = null;
    if (verdict.status === 'done' && criterionV2Active(record.plan?.createdAt)) {
        const criterionRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
        const settledAt = Date.now();
        let leaderForCriterion = null;
        try {
            leaderForCriterion = deriveLeaderEstimate(criterionRow);
        }
        catch {
            leaderForCriterion = null;
        }
        const exAnte = criterionExAnte(criterionRow, leaderForCriterion);
        const wallClockMs = attemptWallClockMsOf({ startedAt: criterionRow?.startedAt, finishedAt: settledAt });
        const evaluation = evaluateCriterion({
            exAnteMinutes: exAnte.minutes,
            exAnteComplete: exAnte.complete,
            wallClockMs,
            exception: sanitizeCriterionException(criterionRow?.criterionException),
            settledAt,
        });
        criterionResultValue = evaluation.criterionResult;
        criterionDirectWrite = { criterionResult: evaluation.criterionResult };
        if (evaluation.criterionResult === 'unmet') {
            effectiveStatus = 'blocked';
            criterionDirectWrite = {
                criterionResult: 'unmet',
                closure: 'blocked',
                blockedKind: 'criterion-overrun',
                criterionViolations: appendCriterionViolation(criterionRow?.criterionViolations, {
                    at: settledAt,
                    attempt: Number(criterionRow?.timeoutCount ?? 0) + 1,
                    wallClockMs,
                    exAnteMinutes: exAnte.minutes,
                    reasons: evaluation.reasons,
                }),
            };
            effectiveError = `${typeof settleError === 'string' && settleError !== '' ? `${settleError}；` : ''}`
                + `判据违规（criterion-overrun）：${evaluation.reasons.join('；')}。`
                + '未获用户批准不得以 done 收尾（Q1-B）；已完成产物只读保留，请用 dsh_workplan_replan(replace) 生成接替子任务只补缺口，'
                + '或先向用户申请例外批准并留痕（criterionApproval）后复核改判。';
        }
    }
    writeSubtaskStatus(record, subtask.id, {
        status: effectiveStatus,
        progress: 100,
        finishedAt: Date.now(),
        summary: truncate(lessonNote ? `${output}\n[自我学习] ${lessonNote}` : output, 3000),
        error: effectiveError,
        verification: verdict.verification,
        acceptance: verdict.acceptance,
        artifacts: checked.artifacts.length > 0
            ? checked.artifacts
            : (extraEvidence && extraEvidence.artifacts.length > 0 ? extraEvidence.artifacts : undefined),
        missingArtifacts: checked.missingArtifacts.length > 0
            ? checked.missingArtifacts
            : (extraEvidence && extraEvidence.missingArtifacts.length > 0 ? extraEvidence.missingArtifacts : undefined),
        needs: verdict.needs.length > 0 ? verdict.needs : undefined,
        /*
         * [3.0.0][用户要求 7/8/10/11] 两级精简 JSON 落行：专家汇报 report 与
         * 部门汇总 departmentSummary。它们已通过 F10/F11 格式门禁，这里原样
         * 持久化，供完成通知与看板按需读取（不裁剪内容）。
         */
        ...(verdict.departmentSummary ? { departmentSummary: verdict.departmentSummary } : {}),
        ...(verdict.report ? { report: verdict.report } : {}),
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
            : effectiveStatus === 'done'
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
    /*
     * [SCv2-T4][C08] 判据字段走 StatusEntry 未知字段直写通道（applyStatus 白名单
     * 不路由新字段，与 pendingAdjudication/timeoutCount 同一纪律）；回放白名单
     * 已追加 criterionResult/criterionException/criterionViolations，刷新不丢。
     */
    if (criterionDirectWrite) {
        const criterionRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
        if (criterionRow)
            Object.assign(criterionRow, criterionDirectWrite);
    }
    if (effectiveStatus === 'blocked') {
        recordSubtaskError(record, subtask.id, escalated ? `待指示：${verdict.question}` : (effectiveError ?? '未完成'), guard);
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
    if (effectiveStatus === 'done' && options.notifyCompletion === true
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
    return { ...verdict, status: effectiveStatus, escalated, ...(criterionResultValue ? { criterionResult: criterionResultValue } : {}) };
}
/**
 * Retry policy for one child attempt.
 *
 * A wedged child (no event for the whole idle window) is worth one fresh
 * attempt. `CHILD_NOT_COMPLETED` 的预算比较在生产路径上恒真：当前实现没有
 * 「整轮剩余预算」概念，全部调用点传入 remainingMs=+∞（TOTAL_TIMEOUT_MS=0
 * 表示不设整轮硬预算），真正的重试上限只有函数开头的 attempt<2。预算比较
 * 保留给单元测试与将来接入真实整轮预算的场景，注释按此真实契约书写。
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
         * 现行默认是 ceiling=CHILD_TIMEOUT_MS(900s) / idle=CHILD_IDLE_TIMEOUT_MS
         * (300s) / round=TOTAL_TIMEOUT_MS(0=不设整轮硬预算)，撞上限后剩下约
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
    /*
     * [2.2.8][T7] 结果块解析失败与 CHILD_NOT_COMPLETED 走同一道闸（用户 2026-11-09
     * 报告 T4 事故：非法 JSON 一次即 blocked，并级联阻断下游；子会话其实已完成
     * 工作，只差一个合法回报）。生产路径 remainingMs=+∞（无整轮预算概念），
     * 该比较恒真、退化为 attempt<2 上限把关；预算比较保留给单测与将来接入
     * 真实整轮预算的场景。
     */
    if (code === 'EVIDENCE_UNPARSABLE') {
        return Number(remainingMs) > Number(idleTimeoutMs);
    }
    /*
     * [2.2.9] 结果块缺失与 unparsable 同闸（用户 2026-11-10 红字复发族）：
     * 结算的唯一载体是收尾消息块，任何异常收尾（error/截断/超时）都会丢；
     * 旧实现 missing 一次即 blocked 并级联冻结下游（看板红字「待裁决/需处理」
     * 反复出现的结构根因之一）。回喂补报（勿重做已完成工作）在生产路径上
     * remainingMs=+∞、预算比较恒真，由函数开头 attempt<2 上限把关；预算比较
     * 保留给单测与将来接入真实整轮预算的场景。
     */
    if (code === 'EVIDENCE_MISSING') {
        return Number(remainingMs) > Number(idleTimeoutMs);
    }
    /*
     * [修复] 结算闸退回（EVIDENCE_INCOMPLETE：验收未逐条覆盖 / 五步证据不完整 /
     * 开工-结算证据不一致）与 unparsable/missing 同闸：结果块已解析，缺口清单
     * 经 previousFailure 回喂同一子会话补报。
     */
    if (code === 'EVIDENCE_INCOMPLETE') {
        return Number(remainingMs) > Number(idleTimeoutMs);
    }
    return true;
}
/*
 * [2.2.7] 执行中断即时通知（用户 2026-11-09 报告的第二个缺陷）。
 *
 * 缺陷现场：部门专家执行中被中断（子会话报错、重试、no-ack、预算耗尽）时，
 * 主会话直到整轮结束才随结果消息一并交代——期间用户只看到进度不动，无法区分
 * 「在慢慢做」与「已经失败」，只能干着急。既有即时通道只覆盖 done
 * （emitSubtaskDoneNotice）与到点预警；中断类事件全走 record.errors（只有
 * 主 Agent 下次读记录才可见）。
 *
 * 这里补上同构的「中断即报」：中断一发生就往主会话写一条纯文本 user/message，
 * 文案固定三段——发生什么（含错误码与真因摘录）、系统正在怎么处理（重试/收束/
 * 待裁决）、对用户意味着什么（不是任务失败终局）。频率纪律：每个子任务整轮
 * 至多 INTERRUPT_NOTICE_CAP 条，写失败只留档到 record.errors，绝不影响执行。
 * 消息不带 workplan 标记，回放解析器按未知消息跳过（与完成通知同一纪律）。
 */
const INTERRUPT_NOTICE_CAP = 3;
export function announceSubtaskInterrupt(record, session, subtaskId, text) {
    if (!record || !session || typeof session.append !== 'function')
        return false;
    const row = Array.isArray(record.statuses)
        ? record.statuses.find((item) => item?.subtaskId === subtaskId)
        : null;
    const sent = Number(row?.interruptNoticeCount ?? 0);
    if (sent >= INTERRUPT_NOTICE_CAP)
        return false;
    const notice = `【dsh-workplan·执行中断】${truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), 400)}`;
    try {
        appendUserMessage(session, notice);
    }
    catch (error) {
        record.errors = [...(record.errors ?? []), `${subtaskId} 中断通知写入失败：${truncate(String(error?.message ?? error), 200)}`].slice(-20);
        return false;
    }
    if (row)
        row.interruptNoticeCount = sent + 1;
    return true;
}
/*
 * [2.5.5][T6] 活体 agent 解析兜底：工具路径（exec.agent）与自动派发路径
 * （payload.agent）都可能因宿主契约差异拿不到 agent，旧实现把 undefined 直传
 * 宿主 startActivation，在 spec.parent.id 处毫秒级抛 TypeError（session-1513
 * 与当前会话实测，childId=null）。这里用宿主同款安全访问器按 session.id 解析；
 * 解析不到由调用方 fail-closed，绝不裸抛 TypeError。
 */
function resolveLiveAgent(ctx, sessionId) {
    const id = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : '';
    if (!id)
        return null;
    try {
        const agentsService = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents;
        return agentsService?.get?.(id) ?? null;
    }
    catch {
        return null;
    }
}
async function executeSubtask(ctx, record, stage, subtask, options) {
    const { parentSignal, modelSelection, conversationContext = '', child, guard } = options;
    /*
     * [2.2.7] 中断即报的目标会话：与 noticeChannel/finaliseNotice 同一取值链，
     * 拿不到就安静跳过（通知是观测设施，不是交付物）。
     */
    const interruptSession = () => options.session ?? options.agent?.session
        ?? findSession(ctx, String(record?.plan?.sessionId ?? ''));
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
    // [2.5.0][自配档] phase-0→phase-1 接续状态（本次尝试链内）。
    let phaseZeroCompleted = false;
    let phaseZeroOutput = '';
    let interruptedFlag = false;
    let interruptedEvidence = null;
    // 仅用于真实错误后的重试策略与日志，不参与 watchdog 或执行截止。
    const idleTimeoutMs = normaliseIdleTimeout(options.idleTimeoutMs);
    try {
        // 新尝试只记录起点；历史 deadlineAt 不再作为执行指令，也不显示为本轮截止。
        const attemptStartMs = Date.now();
        if (!writeSubtaskStatus(record, subtask.id, {
            status: 'in_progress',
            progress: 5,
            startedAt: attemptStartMs,
            deadlineAt: null,
        }, guard))
            return;
        for (let attempt = firstAttempt; attempt <= 2; attempt += 1) {
            interruptedEvidence = null;
            if (parentSignal.aborted)
                throw abortError();
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
                /*
                 * [2.2.7] 子会话档位同样要过模型能力这道闸：计划里的 low / medium /
                 * high / xhigh / max 五档值是规划器按通用五档规则写的（[2.2.7][T4]；旧
                 * 三档计划中的 low/high/max 属五档子集，回放零迁移），可子会话用的就是
                 * 主链路模型（modelSelection）。
                 * 若该模型不声明这些档（qwen 只声明 low/medium/xhigh），照发必被宿主
                 * 在请求前抛 UNSUPPORTED_REASONING_EFFORT——派发期即中断。查询不可用
                 * 时保持旧行为；查询成功后钳制到等效档，空清单则不发送该字段。
                 */
                /*
                 * [2.5.0] 用户要求 2「全程应用」的执行点：每次激活（首发/重试/续跑）
                 * 都经 resolveTaskEffort 单一判据读档——负责人通过 delegate review
                 * 配置的整体等级（状态行 effortOverride，durable 回放不丢）优先于
                 * 规划器写死的 subtask.reasoningEffort；两者缺失才回落默认档。
                 */
                const effortRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
                /*
                 * [2.5.0][自配档] 先配置后开工（平台强制）：未登记自配整体档 ⇒ phase-0
                 * 以 low 启动（唯一职责=评估复杂度+经 review 提交自配）；已登记（含
                 * 重试/续跑/回放读回）⇒ phase-1 经 resolveTaskEffort 单一判据全程用自配档。
                 */
                const selfEffortConfigured = typeof effortRow?.effortOverride === 'string' && effortRow.effortOverride.length > 0;
                const phaseZeroActivation = !phaseZeroCompleted && !selfEffortConfigured;
                const requestedChildEffort = phaseZeroActivation ? 'low' : resolveTaskEffort({
                    override: effortRow?.effortOverride,
                    planned: subtask.reasoningEffort,
                });
                /*
                 * [2.3.9][T3/llm-rules] 用户强制要求 1/2 的执行点：派发前对每个子任务的
                 * reasoningEffort 做模型家族等级集合校验。越界档不中断派发（A3 修正轨），
                 * 按强度序自动降级并 console.warn 留痕；随后 [2.2.7] 宿主能力钳制作为
                 * 第二道闸继续生效（静态表权威 + 能力面交集）。模型名缺失⇒不施加静态
                 * 约束，保持旧行为。
                 */
                const childStaticAllowed = allowedEffortsForModel(modelSelection?.model);
                const childStaticCorrection = childStaticAllowed && !childStaticAllowed.includes(requestedChildEffort)
                    ? correctEffortForModel(requestedChildEffort, modelSelection?.model)
                    : null;
                const staticRuleChildEffort = childStaticCorrection ? childStaticCorrection.effort : requestedChildEffort;
                if (childStaticCorrection) {
                    console.warn('[dsh-workplan] child reasoning effort corrected by LLM family rules:', JSON.stringify({
                        subtaskId: subtask.id,
                        provider: modelSelection?.provider,
                        model: modelSelection?.model,
                        family: classifyModelFamily(modelSelection?.model),
                        requested: requestedChildEffort,
                        corrected: childStaticCorrection.effort,
                        allowed: childStaticAllowed,
                        reason: childStaticCorrection.reason,
                    }));
                }
                /*
                 * [2.2.7] 能力不可查询时保持同步路径：派发链上任何多余的 await 微任务都会
                 * 把 awaiting 通道写入推晚一个 tick（notice-channel 运行时集成用例即因此
                 * 断言失败）。只有真要向宿主查询时才引入这一次等待。
                 */
                const effortQueryable = Boolean(ctx.llm && typeof ctx.llm.resolveModelInfo === 'function'
                    && modelSelection?.provider && modelSelection?.model);
                const childEffortSupport = effortQueryable
                    ? await resolveSupportedEfforts(ctx.llm, modelSelection.provider, modelSelection.model, parentSignal)
                    : null;
                const childEffort = childEffortSupport === null
                    ? staticRuleChildEffort
                    : (clampEffortToSupported(staticRuleChildEffort, childEffortSupport) ?? '');
                /*
                 * [2.5.5][治本] 宿主 SubagentActivationSpec 契约：prompt/parent/cwd/
                 * agentOptions/maxDepth 必须在 spec **顶层**（dsh-subagent types.d.ts
                 * SubagentStartRequest）。旧实现把它们嵌套在 request:{} 里（旧宿主形状），
                 * 现宿主读 spec.parent 得 undefined → 派发期即抛
                 * 「Cannot read properties of undefined (reading 'id')」，全部子任务
                 * 级联受阻（本会话重启后 0/6 现场）。单点拍平，两处 spawn 同口径。
                 */
                // [2.5.5][T6] agent 兜底 + fail-closed（见 resolveLiveAgent 注释）。
                const liveAgent = options.agent ?? resolveLiveAgent(ctx, options.session?.id ?? record?.plan?.sessionId);
                if (!liveAgent) {
                    throw new PlanError('派发失败：无法解析活体父 Agent（agent 缺失且 agents 服务兜底失败），fail-closed 不创建子会话', 'AGENT_RESOLUTION_FAILED', { subtaskId: subtask.id });
                }
                // [3.0.1][P1a] 宿主 subagent.maxDepth < 2 时一次性告警（不阻断派发）。
                notifyDepthOverrideConflict(ctx, typeof record?.plan?.sessionId === 'string' ? record.plan.sessionId : null);
                /*
                 * [3.1.7] 接续证据分层：完整登记原文落盘，提示词只带执行蓝图 + 审计链索引。
                 * 拿不到目录或写盘失败 ⇒ 空串 ⇒ 接续块回退全文注入（证据不丢）。
                 */
                const phaseZeroEvidenceRef = phaseZeroCompleted
                    ? persistStartEvidenceFile(options.cwd, record.plan?.planId, subtask.id, effortRow?.startPhases)
                    : '';
                try {
                    activation = await startActivationQueued(() => ctx.subagents.startActivation({
                        provider: 'spawn',
                        label: `${subtask.department}:${subtask.id} ${subtask.title}`.slice(0, 120),
                        prompt: [{
                                type: 'text',
                                text: phaseZeroActivation ? buildPhaseZeroLeaderPrompt({
                                    subtaskId: subtask.id,
                                    title: subtask.title,
                                    objective: subtask.objective,
                                    departmentLabel: DEPARTMENTS[subtask.department]?.zh ?? String(subtask.department ?? '部门'),
                                }) : buildChildPrompt({
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
                                    /*
                                     * [3.0.1] 死锁自愈：行上登记的复活指示（子会话失联后由
                                     * dsh_workplan_instruct 写入）必须随重建的子提示词送达，
                                     * 否则新子会话会再请示一遍同一个问题。
                                     */
                                    reviveInstruction: (record.statuses.find((item) => item?.subtaskId === subtask.id)?.reviveInstruction) ?? null,
                                    /*
                                     * [2.3.9][T4b] 用户强制要求 3：分配任务时必须把要求 1/2 的
                                     * **全部内容**告知相关部门。注入文本由 llm-rules.ts 的
                                     * buildLlmRulesBrief 单一事实源生成（tier='department'）：
                                     * 要求 1/2 原文 + 本会话模型与家族判定 + 本子任务已配置/钳制后
                                     * 的推理等级 + 部门负责人「先全面梳理、再用 dsh_workplan_delegate
                                     * 分配给顶尖专家与组员」的强制流程告知。
                                     */
                                    // [3.1.1] 第 4 参回注登记原文：direct/review 在负责人会话登记、执行在
                                    // 新会话承接时，接续提示必须带登记证据原文，否则收尾必然被变薄退回。
                                    phaseZeroContinuation: phaseZeroCompleted ? buildPhaseZeroContinuationHint(String(effortRow?.effortOverride ?? ''), phaseZeroOutput, effortRow?.effortOverride === 'low' && (effortRow?.consolidation?.assignments ?? []).length === 0, effortRow?.startPhases, phaseZeroEvidenceRef ?? '') : '',
                                    llmRulesBrief: buildLlmRulesBrief({
                                        model: modelSelection?.model ?? null,
                                        effort: staticRuleChildEffort || null,
                                        requested: childStaticCorrection ? requestedChildEffort : null,
                                        correctionReason: childStaticCorrection?.reason ?? null,
                                        tier: 'department',
                                        taskEffort: typeof effortRow?.effortOverride === 'string' ? effortRow.effortOverride : null,
                                    }),
                                }),
                            }],
                        parent: liveAgent,
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
                            // [2.2.7] '' = 模型无 reasoning 元数据 ⇒ 不发送，避免派发期即中断。
                            ...(childEffort ? { reasoningEffort: childEffort } : {}),
                        },
                        /*
                         * [2.3.9][T4b] 三层派发深度（用户强制要求 4/5）：主 Agent(0) →
                         * 部门负责人子会话(1) → 顶尖专家/组员子会话(2)。maxDepth 是宿主
                         * resolveChildDepth 的**绝对深度上限**（child-agent.d.ts:24-29），
                         * 部门层放行到 2 才能让负责人经 dsh_workplan_delegate 派生第三层；
                         * 第三层成员派生时同样传 2 ⇒ 任何第四层（深度 3）被宿主抛
                         * SubagentDepthError 硬拒，delegateTool 服务端另有一道「只有部门
                         * 负责人行可调用」的校验——提示词说服模型，代码守住边界。
                         */
                        maxDepth: 2,
                        signal: child.controller.signal,
                        delivery: 'caller',
                    }), child.controller.signal, `派发子任务 ${subtask.id}（${subtask.title}）`);
                }
                catch (error) {
                    // [3.0.1][P1b] 并发上限翻译为可行动提示；其余错误原样上抛（保持旧行为）。
                    throw describeSubagentActivationError(error, `派发子任务 ${subtask.id}（${subtask.title}）`);
                }
                if (guard.timedOut)
                    return;
                if (!activation || typeof activation.result?.then !== 'function') {
                    throw new PlanError('子 Agent 没有返回可等待的结果', 'NO_ACTIVATION');
                }
                // [3.1.8][P0 D4] 登记「这个子任务当前由哪个负责人会话执行」：续跑重置
                // 会清掉 statuses[].childId，但旧负责人可能仍存活；后续派发据此拒绝重复起头。
                rememberHeadActivation(ctx, record.plan?.planId, subtask.id, activation.childId);
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
                // [3.1.8][治本] 记住「这个负责人会话属于哪个子任务」——台账随后被重建
                // 替换时，delegate(review/direct) 仍能靠它认亲，不再 NO_SUBTASK。
                rememberActivation(ctx, activation.childId, record.plan.planId, subtask.id);
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
                // [2.2.9][handle-policy] 卫生类（T1 报告 R7）：只丢一次「已下发未响应」提示，保留 unref。
                noticeTimer.unref?.();
                ackTimers.push(noticeTimer);
                // 未收到回执只保留 ackOverdue 提示；执行等待没有硬截止，绝不因此 blocked/abort。
                const watchdog = createProgressWatchdog({
                    enforceTimeouts: false,
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
                    idleMs: Number.POSITIVE_INFINITY,
                    hardMs: Number.POSITIVE_INFINITY,
                    pollMs: CHILD_POLL_MS,
                    onProgress: ({ now, seq, elapsedMs }) => {
                        record.heartbeatAt = now;
                        record.updatedAt = now;
                        // 子会话日志增长是正向回执；确认后只撤销提示计时器，不设置任何新截止。
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
                    // 纯观测模式永不调用；保留参数以兼容 watchdog 的公开工厂接口。
                    makeError: () => new PlanError('执行时限已禁用', 'TIME_LIMITS_DISABLED', { subtaskId: subtask.id }),
                });
                let result;
                try {
                    const waiter = waitForActivation(activation, child.controller.signal);
                    // The losing side of the race may reject after the watchdog fired;
                    // keep that rejection handled so Node never reports it as unhandled.
                    waiter.catch(() => { });
                    result = await waiter;
                }
                finally {
                    watchdog.stop();
                }
                if (guard.timedOut)
                    return;
                /*
                 * [2.5.0][自配档] phase-0 结算分支：已登记自配 ⇒ 平台立即以自配档接续
                 * phase-1（不计失败、不耗重试预算）；未登记 ⇒ 明确 SELF_EFFORT_MISSING
                 * 回喂（有界重试），禁止静默以 low 档继续正式任务。
                 */
                if (phaseZeroActivation) {
                    const configuredRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
                    const configured = typeof configuredRow?.effortOverride === 'string' && configuredRow.effortOverride.length > 0;
                    if (configured) {
                        phaseZeroCompleted = true;
                        phaseZeroOutput = resultText(result);
                        attempt -= 1; // phase-0→phase-1 是接续不是重试：不消耗 attempt 预算
                        continue;
                    }
                    throw new PlanError('phase-0 结束但未提交自配推理等级：先配置后开工是平台硬规则——请评估任务复杂度并经 dsh_workplan_delegate(action="review") 配置 consolidation.taskReasoningEffort，平台将以自配档接续；low（轻度）任务请改经 action="direct" 登记开工证据 startPhases（负责人亲自执行，禁止下派）', 'SELF_EFFORT_MISSING', { subtaskId: subtask.id });
                }
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
                 * [2.2.8][T7] 结果块解析失败 = 与 CHILD_NOT_COMPLETED 同路径的有界回喂重试。
                 *
                 * T4 事故（用户 2026-11-09 报告）：子会话工作完成、交付物已在盘上，只是
                 * 结果块 JSON 写坏；旧实现在这里一次即判 blocked，并级联阻断下游——
                 * 侧栏（子会话实时活动态）与账本（结算态）出现十几分钟的可见错位。
                 * 现在结算前先用纯函数裁决一次（不写状态、不留双源）：
                 *  - unparsable 且还有回喂意义（`shouldRetryAttempt` 与 CHILD_NOT_COMPLETED
                 *    同一道闸；最多两次由 attempt 上限统一把关，不会无限循环）→ 抛
                 *    EVIDENCE_UNPARSABLE，由下方 catch 把解析器具体错误回喂同一子会话，
                 *    要求「修正结果块后重新回报，勿重做已完成工作」；
                 *  - 重试后仍 unparsable（或预算不再够一次回喂）→ 按实受阻，随行附上
                 *    attempt 摘要声明且确核在盘的产物清单，提示主 Agent 用
                 *    `dsh_workplan_update` 复核改判。
                 * 结算严格性不变：非法 JSON 依旧绝不计 done——只修恢复路径。
                 */
                const settleRow = record.statuses.find((item) => item?.subtaskId === subtask.id);
                /*
                 * [修复] F11 接通：行上有已派发专家 ⇒ 本行是部门负责人 ⇒ 结算闸按
                 * leader 层级核验 departmentSummary（F11）并按专家名单核 sources 覆盖度。
                 * 口径与 settleFromOutput :1885-1896 逐字同源（此前预裁决路径不传这两项，
                 * F11 在生产路径上从未执行，但提示词宣称存在——提示词与闸门双源矛盾）。
                 */
                const settleDelegates = Array.isArray(settleRow?.delegates)
                    ? settleRow.delegates.map((item) => String(item?.member ?? '')).filter((name) => name !== '')
                    : [];
                const settleVerdict = settleRow?.closure === 'escalated'
                    ? null
                    : adjudicateResult({
                        output,
                        strict: options.strictEvidence !== false,
                        expectedAcceptance: Array.isArray(subtask?.acceptance) ? subtask.acceptance : [],
                        // [3.0.8] 开工-结算一致性比对输入（行级登记值，历史行跳过）。
                        startPhases: settleRow?.startPhases ?? undefined,
                        formatTier: settleDelegates.length > 0 ? 'leader' : undefined,
                        expectedExperts: settleDelegates,
                    });
                if (settleVerdict && settleVerdict.verification === 'unparsable') {
                    const unparsableLanded = probeInterruptedArtifacts(output, subtask, options.cwd, options.artifactExists);
                    const unparsableError = new PlanError(`结果块无法解析，本次回报不能结算（工作本身不计失败）：${truncate(String(settleVerdict.error ?? ''), 600)}`
                        + (unparsableLanded.length > 0
                            ? `；上一次回报声明且已核到在盘的产物：${unparsableLanded.slice(0, 6).join('、')}——请勿重做已完成的工作，只修正结果块为合法 JSON 后重新完整回报`
                            : '；请修正结果块为合法 JSON（引号、逗号、括号成对，标记成对出现）后重新回报'), 'EVIDENCE_UNPARSABLE', { subtaskId: subtask.id });
                    if (shouldRetryAttempt(unparsableError, attempt, Number.POSITIVE_INFINITY, idleTimeoutMs)) {
                        throw unparsableError;
                    }
                    settleFromOutput(record, subtask, output, guard, options, settleVerdict, probeInterruptedEvidence(output, subtask, options.cwd, options.artifactExists));
                    return;
                }
                /*
                 * [2.2.9] 结果块**缺失**（子会话收尾异常：error/截断/超时）= 与 unparsable
                 * 同族的有界回喂重试，且优先采纳盘上结算备份。
                 *
                 * 红字复发族根因（用户 2026-11-10 截图：T1 超时/缺失结算→blocked→级联
                 * 冻结→「已结束·需处理」）：结算唯一载体是收尾消息块，单点、原子、无
                 * 盘上备份；丢块后旧实现一次即 blocked。现在两层恢复：
                 *  ① 盘上备份优先：子会话按提示词约定在收尾前把结果块 JSON 写入
                 *     reports/wp-settlement-<subtaskId>.json（见 plan.ts 子提示词）；
                 *     消息块缺失时读该文件重裁决，合法即照常结算（来源留档）；
                 *  ② 无备份且预算够一个空闲窗口 → 抛 EVIDENCE_MISSING 回喂同一子会话，
                 *     附在盘产物清单与「只补交结果块、勿重做已完成工作」；重试耗尽才
                 *     按实 blocked（既有 settleFromOutput 路径，严格性不变：缺失永不计 done）。
                 */
                if (settleVerdict && settleVerdict.missingBlock === true) {
                    /*
                     * [T4][F3] 备份文件名纳入 planId（旧固定名在多计划并发时会被同名子任务
                     * 互相覆盖）。读取顺序：新名优先；只有「文件不存在」才回退旧名。无论哪个
                     * 名字，都必须通过下面的新鲜度 + 归属闸；存在但过不了闸的文件一律拒绝，
                     * 不静默改读另一个文件。
                     */
                    const backupCandidates = settlementBackupPaths(options.cwd ?? process.cwd(), String(record.plan.planId ?? ''), String(subtask.id));
                    let settleBackup = backupCandidates[0];
                    let backupVerdict = null;
                    let backupText = '';
                    /*
                     * [2.5.2][T4b][D2] 备份采纳前的新鲜度+归属闸。根因
                     * （reports/D1-D2-root-cause-diagnosis.md §2）：固定文件名跨计划跨会话
                     * 复用，旧实现读到合法 JSON 即采纳、不做任何校验——本次误采纳 T1 的
                     * 陈旧截图任务结算（假完成）与 T2 的陈旧基金基线结算（误 blocked），
                     * 级联冻结 T3/T4/T5。现在：
                     *  ① 新鲜度：备份 mtime 必须 >= 本次尝试 startedAt（只认本次尝试内
                     *     新写的备份；提示词同步要求覆盖旧文件）。
                     *  ② 归属：备份 JSON 顶层含 planId/subtaskId 则必须与本计划/本子任务
                     *     一致（裸 JSON 或标记块内 JSON 两个入口都查；无这些字段的旧格式
                     *     备份仍受新鲜度闸约束，adjudicateResult 对额外顶层字段容忍）。
                     *  ③ 任一不满足 ⇒ 不采纳，写 record.errors 审计行（含文件 mtime 与
                     *     startedAt），落回下方既有 EVIDENCE_MISSING 有界回喂路径。
                     *     结算严格性不变：缺失永不计 done。
                     */
                    let backupRejectReason = '';
                    let backupMtimeMs = null;
                    const backupAttemptStartedAt = Number(attemptRow()?.startedAt ?? 0);
                    for (const backupPath of backupCandidates) {
                        let backupStat;
                        try {
                            backupStat = statSync(backupPath);
                        }
                        catch {
                            continue;
                        }
                        settleBackup = backupPath;
                        backupMtimeMs = backupStat.mtimeMs;
                        if (backupStat.mtimeMs < backupAttemptStartedAt) {
                            backupRejectReason = '陈旧备份（mtime 早于本次尝试 startedAt，非本次执行新写）';
                            break;
                        }
                        try {
                            backupText = readFileSync(backupPath, 'utf8');
                        }
                        catch {
                            break;
                        }
                        let backupMeta = null;
                        try {
                            backupMeta = JSON.parse(backupText);
                        }
                        catch {
                            const beginAt = backupText.lastIndexOf(EVIDENCE_MARKER_BEGIN);
                            const endAt = backupText.indexOf(EVIDENCE_MARKER_END, beginAt + EVIDENCE_MARKER_BEGIN.length);
                            if (beginAt >= 0 && endAt > beginAt) {
                                try {
                                    backupMeta = JSON.parse(backupText.slice(beginAt + EVIDENCE_MARKER_BEGIN.length, endAt).trim());
                                }
                                catch {
                                    backupMeta = null;
                                }
                            }
                        }
                        const metaPlanId = typeof backupMeta?.planId === 'string' && backupMeta.planId ? backupMeta.planId : null;
                        const metaSubtaskId = typeof backupMeta?.subtaskId === 'string' && backupMeta.subtaskId ? backupMeta.subtaskId : null;
                        if (metaPlanId && metaPlanId !== record.plan.planId) {
                            backupRejectReason = `归属不匹配（备份 planId=${metaPlanId} ≠ 本计划 ${record.plan.planId}）`;
                        }
                        else if (metaSubtaskId && metaSubtaskId !== subtask.id) {
                            backupRejectReason = `归属不匹配（备份 subtaskId=${metaSubtaskId} ≠ 本子任务 ${subtask.id}）`;
                        }
                        else {
                            backupVerdict = adjudicateResult({
                                output: backupText,
                                strict: true,
                                expectedAcceptance: Array.isArray(subtask?.acceptance) ? subtask.acceptance : [],
                                // [3.0.8] 开工-结算一致性比对输入（行级登记值，历史行跳过）。
                                startPhases: settleRow?.startPhases ?? undefined,
                                // [修复] 备份采纳与消息路径同一 F11 口径（见 settleVerdict 处注释）。
                                formatTier: settleDelegates.length > 0 ? 'leader' : undefined,
                                expectedExperts: settleDelegates,
                            });
                            if (!backupVerdict || backupVerdict.missingBlock === true || backupVerdict.verification === 'unparsable')
                                backupVerdict = null;
                        }
                        break;
                    }
                    if (backupRejectReason) {
                        record.errors = [
                            ...(record.errors ?? []),
                            `${subtask.id}: 拒绝采纳盘上结算备份 ${settleBackup}——${backupRejectReason}（文件 mtime=${backupMtimeMs === null ? '未知' : new Date(backupMtimeMs).toISOString()}，本次尝试 startedAt=${new Date(backupAttemptStartedAt).toISOString()}；[2.5.2][T4b][D2] 新鲜度/归属闸），落回 EVIDENCE_MISSING 回喂`,
                        ].slice(-20);
                    }
                    if (backupVerdict) {
                        settleFromOutput(record, subtask, backupText, guard, options, backupVerdict, probeInterruptedEvidence(backupText, subtask, options.cwd, options.artifactExists));
                        record.errors = [
                            ...(record.errors ?? []),
                            `${subtask.id}: 消息结果块缺失，已采纳盘上结算备份 ${settleBackup}（[2.2.9] 恢复路径）`,
                        ].slice(-20);
                        return;
                    }
                    const missingLanded = probeInterruptedArtifacts(output, subtask, options.cwd, options.artifactExists);
                    const missingError = new PlanError('结果块缺失，本次回报不能结算（工作本身不计失败）'
                        + (missingLanded.length > 0
                            ? `；已核到在盘产物：${missingLanded.slice(0, 6).join('、')}`
                            : '')
                        + '——请勿重做已完成的工作，只补交完整结构化结果块（WORKPLAN_EVIDENCE 标记成对、JSON 合法）后重新回报', 'EVIDENCE_MISSING', { subtaskId: subtask.id });
                    if (shouldRetryAttempt(missingError, attempt, Number.POSITIVE_INFINITY, idleTimeoutMs)) {
                        throw missingError;
                    }
                }
                /*
                 * [修复] 结果块已解析、但结算闸退回（验收未逐条覆盖 / 五步证据不完整 /
                 * 开工-结算证据不一致）= 与 unparsable/missing 同族的有界回喂重试。
                 *
                 * 结构性根因：旧实现里这类缺口一次即 blocked、无任何回喂，子 Agent 不知道
                 * 差在哪，主 Agent 只能人工重派——「五步证据不完整」反复出现的直接原因。
                 * 现在把校验器给出的具体缺口清单经 previousFailure 回喂同一子会话：
                 * 勿重做已完成的工作，按缺口补全证据后重新回报完整结构化结果块；
                 * 最多两次由 attempt 上限统一把关，重试耗尽仍按实 blocked（严格性不变）。
                 */
                if (settleVerdict && settleVerdict.verification === 'unverified' && settleVerdict.rereport === true) {
                    const incompleteError = new PlanError(`结果块已解析，但结算闸退回（本次回报不能计完成）：${truncate(String(settleVerdict.error ?? ''), 600)}`
                        + '——请勿重做已完成的工作，按上述缺口补全证据后重新回报完整结构化结果块', 'EVIDENCE_INCOMPLETE', { subtaskId: subtask.id });
                    if (shouldRetryAttempt(incompleteError, attempt, Number.POSITIVE_INFINITY, idleTimeoutMs)) {
                        throw incompleteError;
                    }
                }
                /*
                 * [1.7.0] Evidence decides the verdict.
                 *
                 * The old rule was "not BLOCKED => done", so a child that reported
                 * unverified or failed self-checks was still counted as finished and
                 * the main Agent had nothing to review but prose. `adjudicateResult`
                 * is the single deterministic table; `settleFromOutput` adds the
                 * environment-dependent artifact check.
                 */
                settleFromOutput(record, subtask, output, guard, options, settleVerdict ?? undefined);
                return;
            }
            catch (error) {
                lastError = error;
                const isAbort = parentSignal.aborted || child.controller.signal.aborted;
                const remaining = Number.POSITIVE_INFINITY;
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
                    // [3.1.1] 带上登记原文回喂：EVIDENCE_INCOMPLETE 的重试根因常是「登记在
                    // 别的会话、交卷人没见过原文」，只回数字会把补报退化成凑字数；附原文后
                    // buildChildPrompt 会渲染登记证据块，交卷人照抄即可。settleRow 声明在
                    // try 块内、catch 不可见，这里从台账按 id 重查（record 在两级作用域均在）。
                    registeredStartPhases: record.statuses.find((item) => item?.subtaskId === subtask.id)?.startPhases,
                };
                const retry = !isAbort && shouldRetryAttempt(error, attempt, remaining, idleTimeoutMs);
                if (retry) {
                    record.errors = [
                        ...(record.errors ?? []),
                        `${subtask.id}: 第 ${attempt} 次执行失败（${lastFailure.code}），已带上失败原因重试`,
                    ].slice(-20);
                    writeSubtaskStatus(record, subtask.id, { progress: 15 }, guard);
                    // [2.2.7] 中断即报：用户当下就知道「谁被打断、为什么、系统正在怎么处理」。
                    announceSubtaskInterrupt(record, interruptSession(), subtask.id, `子任务 ${subtask.id}（${subtask.title}）第 ${attempt} 次执行被打断（${lastFailure.code}：${truncate(lastFailure.message, 140)}）；处理：插件已把失败原因回喂同一子会话并自动重试（第 ${attempt + 1} 次），任务整体仍在推进，这不是最终失败。`);
                    continue;
                }
                break;
            }
            finally {
                clearAckTimers();
                if (activation) {
                    const settledActivation = activation;
                    try {
                        await disposeActivation(activation, record, subtask.id, guard);
                    }
                    finally {
                        /*
                         * [3.1.8][P0 D4] 本次负责人尝试已结束（成功/失败/重试/中止）：
                         * 撤销登记，避免旧会话仍留在 sessions 里时永久挡住合法重派。
                         */
                        forgetHeadActivation(ctx, record.plan?.planId, subtask.id, settledActivation.childId);
                        activation = null;
                    }
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
        const finalBlocked = writeSubtaskStatus(record, subtask.id, {
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
        // [2.2.7] 中断即报：重试耗尽/不可重试走到终点时立即说清本质原因与后续处置，
        // 不等整轮结果消息。
        if (finalBlocked && !guard.timedOut && !parentSignal.aborted) {
            const landed = interruptedEvidence?.artifacts?.length
                ? `已核到 ${interruptedEvidence.artifacts.length} 个产物在盘上：${interruptedEvidence.artifacts.slice(0, 3).join('、')}`
                : '子会话未留下已核实的在盘产物';
            announceSubtaskInterrupt(record, interruptSession(), subtask.id, `子任务 ${subtask.id}（${subtask.title}）已受阻：${truncate(message, 160)}；产物线索：${landed}；处理：本行不再自动重试，整轮结果会如实列为未完成，由主会话据实决定续跑/改判/向你说明——期间其余子任务继续执行。`);
        }
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
        // [2.2.7] 中断即报：执行链路自身出异常同样不能对用户沉默。
        announceSubtaskInterrupt(record, interruptSession(), subtask.id, `子任务 ${subtask.id}（${subtask.title}）执行过程发生未预期异常：${truncate(message, 160)}；处理：本行已置为受阻并如实留档，主会话将在结果消息后据实决定续跑/改判，不会伪造完成。`);
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
 * [2.3.0][T1] 专家执行时间机制 v2.3.0（用户 2026-11-10 四项要求，全链路）：
 *  (a) 预估上报 → 告知用户：recordTimeNotice 落档后向主会话推送「请把预期用时
 *      转告用户」的即时通知；
 *  (b) 超时 → 放宽 → 告知专家：延期事务成功后把最新执行时限推送给执行中的专家
 *      子会话，并附「必须在保证工作质量的前提下高效率执行」硬要求；
 *  (c) 二次超时 → 主 Agent 接手：runSubtaskAttempt 的到点收束对每行计数
 *      （timeoutCount），第二次超时置 takeoverRequired，并用 buildTakeoverBrief
 *      登记专家已完成产物、mergePreservedArtifacts 做「禁止丢弃已完成部分」的
 *      只读保护合并。
 * 向后兼容：全部走 StatusEntry 未知字段直写通道（与 deadlineAt/timeJournal
 * 同族），回放白名单同步透传；不改任何既有判定与既有字段语义。
 */
export const TAKEOVER_AFTER_TIMEOUTS = 2;
/**
 * [2.3.0][T1] 组装「主 Agent 接手包」：已完成部分（专家已落盘产物 + 已登记
 * artifacts）逐条快照，未完成部分按 outputs 反推。instruction 是硬约束文案：
 * 禁止丢弃已完成部分——接手只补缺口，不整步重跑、不删除或覆盖专家产物。
 */
export function buildTakeoverBrief(subtask, row, landedRefs, timeoutCount) {
    const refs = (Array.isArray(landedRefs) ? landedRefs : [])
        .map((item) => String(item ?? ''))
        .filter(Boolean)
        .slice(0, 20);
    const completedArtifacts = (Array.isArray(row?.artifacts) ? row.artifacts : [])
        .filter((item) => item?.kind === 'file' && typeof item?.ref === 'string' && item.ref)
        .map((item) => ({ kind: 'file', ref: item.ref, exists: item.exists !== false }))
        .slice(0, 20);
    const outputs = (Array.isArray(subtask?.outputs) ? subtask.outputs : [])
        .map((item) => String(item ?? ''))
        .filter(Boolean);
    const remainingOutputs = outputs.filter((ref) => !refs.includes(ref));
    return {
        at: Date.now(),
        timeoutCount: Number(timeoutCount) || 0,
        landedRefs: refs,
        completedArtifacts,
        remainingOutputs,
        instruction: '主 Agent 只接手未完成部分：landedRefs/completedArtifacts 是专家已'
            + '完成并登记保护的产物，只读、禁止丢弃、禁止删除或覆盖、禁止整步重跑；'
            + '仅继续 remainingOutputs 与未满足的验收标准。',
    };
}
/**
 * [2.3.0][T1] 「禁止丢弃已完成部分」的只读保护合并（A4 硬编码点）：
 * 接手登记的保护清单（takeoverBrief.landedRefs）与行上 artifacts 取并集，
 * 只增不减——任何后续对 artifacts 的写入都不可能丢掉已完成部分。
 * 纯函数，可脱离宿主回归。
 */
export function mergePreservedArtifacts(artifacts, preservedRefs) {
    const list = (Array.isArray(artifacts) ? artifacts : [])
        .filter((item) => item && typeof item === 'object' && typeof item.ref === 'string')
        .map((item) => ({ ...item }));
    const seen = new Set(list.map((item) => String(item.ref)));
    for (const rawRef of Array.isArray(preservedRefs) ? preservedRefs : []) {
        const ref = String(rawRef ?? '');
        if (!ref || seen.has(ref))
            continue;
        // 保护条目固定 kind:'file'/exists:true：登记发生在产物确认在盘的时刻。
        list.push({ kind: 'file', ref, exists: true, preservedByTakeover: true });
        seen.add(ref);
    }
    return list.slice(-40);
}
/**
 * [2.5.0][R4] 第三层叶子「已完成产物在盘」探测：delegate 下级重派（重试/续跑）
 * 前先核盘它上次按任务书约定写下的结算备份（buildDelegateePrompt：
 * reports/wp-member-<成员名>-<任务代号>.json），随重试任务书附给新叶子。
 * 只读目录、不改任何判定；目录不存在/读取失败返回空清单（绝不编造产物）。
 * listDir 可注入，纯逻辑可脱离真实文件系统回归。
 */
export function probeDelegateLandedArtifacts(cwd, member, listDir = readdirSync) {
    const name = String(member ?? '').trim();
    if (!name || typeof cwd !== 'string' || !cwd)
        return [];
    const prefix = `wp-member-${name}-`;
    let entries = [];
    try {
        entries = listDir(join(cwd, 'reports'));
    }
    catch {
        return [];
    }
    return (Array.isArray(entries) ? entries : [])
        .map((entry) => String(entry ?? ''))
        .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
        .slice(0, 6)
        .map((file) => `reports/${file}`);
}
/**
 * [2.5.0][R4] 第三层叶子重试/续跑简报（根因修复）：旧实现 delegate 重派时给
 * 叶子一张全新任务书——上一次尝试的状态、失败原因、已回报结论与在盘产物
 * 全部丢失，叶子只能整步重跑（违反用户要求 4「禁止丢弃已完成部分」，与
 * 第二层 buildTakeoverBrief/结果块回喂同一语义在第三层的落点）。现在重派
 * 时把本简报经 buildDelegateePrompt.extraContext 附进任务书：上次尝试状态/
 * 错误/摘要 + 已核实在盘产物清单 + 负责人梳理思路 + 「请勿重做已完成的工作」
 * 硬约束。纯函数，可脱离宿主回归。prior 为空（首发）返回 ''。
 */
export function buildDelegateRetryBrief(prior, landedRefs, approach) {
    if (!prior || typeof prior !== 'object')
        return '';
    const refs = (Array.isArray(landedRefs) ? landedRefs : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
        .slice(0, 6);
    const status = String(prior.status ?? '');
    const lines = [
        `【重试/续跑简报——禁止丢弃已完成部分】这不是你的首次尝试：上一次尝试的状态为 ${status || '未知'}。`,
    ];
    if (typeof prior.error === 'string' && prior.error.trim()) {
        lines.push(`- 上次失败原因：${truncate(prior.error.trim(), 300)}`);
    }
    if (typeof prior.summary === 'string' && prior.summary.trim()) {
        lines.push(`- 上次已回报的结论（含已完成工作）：${truncate(prior.summary.trim(), 300)}`);
    }
    if (refs.length > 0) {
        lines.push(`- 已核实在盘的已完成产物：${refs.join('、')}`);
    }
    const approachLines = (Array.isArray(approach) ? approach : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
        .slice(0, 6);
    if (approachLines.length > 0) {
        lines.push(`- 部门负责人的梳理思路（供参考）：${approachLines.join('；')}`);
    }
    lines.push(status === 'done'
        ? '- 硬约束：上次尝试已完成——先核对上述产物与结论，只补缺口；请勿重做已完成的工作，禁止删除或覆盖既有产物。'
        : '- 硬约束：请勿重做已完成的工作——以上述在盘产物与结论为基础，只继续补齐未完成部分；禁止删除或覆盖既有产物、禁止整步重跑。');
    return lines.join('\n');
}
/**
 * [2.3.0][T1] 放宽成功后告知执行中的专家最新时限（A2 的「告知」半边）。
 * 走 ctx.subagents.sendMessage 与 follow-up 同一投递通道：运行中的子会话在下一
 * 步收到。投递失败不阻断延期事务（时限已经推移），只留档 record.errors。
 */
async function notifyExpertOfExtension(ctx, agent, record, subtaskId, deadlineAt) {
    const row = Array.isArray(record?.statuses)
        ? record.statuses.find((item) => item?.subtaskId === subtaskId)
        : null;
    const childId = String(row?.childId ?? '');
    const service = ctx?.subagents;
    if (!childId) {
        return { ok: false, error: '该行没有活跃子会话（childId 缺失），专家续跑时可从状态行 deadlineAt 读取最新时限' };
    }
    if (!service || typeof service.sendMessage !== 'function') {
        return { ok: false, error: '当前部署没有可用的 subagent 服务，无法投递延期告知' };
    }
    const remainingMin = Math.max(1, Math.ceil((Number(deadlineAt) - Date.now()) / 60000));
    const text = `【dsh-workplan·延期告知】子任务 ${subtaskId} 的执行时限已由主 Agent 放宽：`
        + `最新执行时间为 ${new Date(Number(deadlineAt)).toISOString()}（约剩 ${remainingMin} 分钟）。`
        + '你必须在保证工作质量的前提下高效率执行：优先推进高价值步骤，已完成内容及时落盘，'
        + '并在回报中明确区分「已完成 / 未完成」。收到本通知后请继续当前工作，不要重新开始。';
    try {
        await service.sendMessage(agent, childId, [{ type: 'text', text }], { signal: new AbortController().signal }); // [T11] 缺陷②：延期告知携带有效 signal，消除 throwIfAborted
        if (row) {
            const journal = Array.isArray(row.timeJournal) ? row.timeJournal : [];
            journal.push({ at: Date.now(), action: 'notify-expert', deadlineAt: Number(deadlineAt), by: 'system' });
            row.timeJournal = journal.slice(-20);
        }
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: truncate(error instanceof Error ? error.message : String(error), 300) };
    }
}
/*
 * 部门负责人与其全球顶尖专家的正式执行不设墙钟、空闲或回执硬截止。
 * 只有子会话真实收束、返回错误、证据门禁或用户显式取消才能结束等待。
 */
async function runSubtaskAttempt(ctx, record, stage, subtask, options) {
    const child = createChildController(options.parentSignal);
    const guard = { timedOut: false };
    try {
        const outcome = await executeSubtask(ctx, record, stage, subtask, {
            ...options,
            child,
            guard,
            attemptTimeoutMs: 0,
            attemptHandle: undefined,
        });
        return { outcome, ceilingFired: false, ceilingLanded: [], ceilingFingerprint: [] };
    }
    finally {
        child.disposeListener();
        if (!child.controller.signal.aborted)
            child.controller.abort();
    }
}
async function runSubtask(ctx, record, stage, subtask, options) {
    const attempt = await runSubtaskAttempt(ctx, record, stage, subtask, options);
    return attempt.outcome;
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
    return list.map((item) => {
        /*
         * [T7][lead-decisions J2/G2] 负责人时长聚合：与看板载荷（plan.ts
         * normaliseStatusEntry）挂同一读时派生纯函数，模型可读面不是第二套计算。
         * null＝空 roster（无下属分工）/replanned 旧行/越界 fail-closed；
         * roster 非空且非 replanned 却为 null ⇒ 总和越界异常，显式标注拒绝展示（J8）。
         */
        const leaderEstimate = deriveLeaderEstimate(item);
        const leaderEstimateAnomaly = leaderEstimate === null
            && item?.closure !== 'replanned'
            && leaderEstimateRoster(item).length > 0
            ? '下属开工预估聚合异常（总和超出安全整数范围），拒绝展示数值；请核对 delegateEstimates 台账'
            : null;
        // [SCv2-T4][Q4-B/C22] 事前预估口径（有叶子＝和；直做＝负责人自身预估，D-2）。
        const exAnteView = criterionExAnte(item, leaderEstimate);
        return {
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
            executionTimeLimit: 'none',
            // 旧记录只读保留，绝不再解释为当前截止或剩余执行时间。
            deadlineAt: null,
            legacyDeadlineAt: item.deadlineAt ?? null,
            deadlineRemainingMs: null,
            timeWarning: item.timeWarning ?? null,
            timeJournal: Array.isArray(item.timeJournal) ? item.timeJournal.slice(-10) : [],
            pendingAdjudication: item.pendingAdjudication === true,
            // [2.3.0][T1] 预估上报（A1）也要进模型可读面：主 Agent 告知用户前先读这里。
            timeNotice: item.timeNotice ?? null,
            /*
             * [2.3.0][T1] 超时计数 / 二次超时接手进入模型可读面：主 Agent 一眼能看出
             * 该行第几次超时、是否必须接手、接手包里哪些是只读保护的已完成产物。
             */
            timeoutCount: Number(item.timeoutCount ?? 0),
            takeoverRequired: item.takeoverRequired === true,
            takeoverBrief: item.takeoverBrief ?? null,
            /*
             * [2.3.0][T1] 已完成产物的只读保护登记必须进模型可读面：statusTool 的行
             * 来自本函数，此前不序列化 artifacts，导致 takeoverRequired 的「禁止丢弃
             * 已完成部分」清单对主 Agent 不可见。只透出对象形条目，照录不改写。
             */
            artifacts: (Array.isArray(item.artifacts) ? item.artifacts : [])
                .filter((entry) => entry && typeof entry === 'object' && typeof entry.ref === 'string')
                .map((entry) => ({ ...entry })),
            /*
             * [2.2.0][T3/O-2a] 子→主预告通道的结论必须进入模型可读面。
             *
             * 这条能力的目标就是「可观测」：主 Agent 要能一眼看出该子任务的开工预告
             * 有没有真的到达（observed/not-observed）、目标是谁、什么时候、失败原因。
             * 只写状态行不让读，等于又是一个「看不见的失败」。
             */
            noticeChannel: item.noticeChannel ?? null,
            /*
             * [T6][契约v1 §3] 第三层开工预估进入模型可读面：delegates 行透出 estimate
             * （declaredMinutes/delivery 等，照录不改写），任务级 delegateEstimates 台账
             * 一并透传——主 Agent/负责人据此核对「谁预估了多少分钟、是否已送达」。
             */
            delegates: (Array.isArray(item.delegates) ? item.delegates : [])
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry) => ({ ...entry })),
            delegateEstimates: item.delegateEstimates ?? null,
            // [3.1.5] 第三层完成度投影：与看板载荷同源，避免「专家已完成/行未完成」互相矛盾。
            delegateCompletion: item.delegateCompletion ?? null,
            // [T7][J1 冻结结构] {totalMinutes, reported, expected, missing[], failed[]} | null。
            leaderEstimate,
            ...(leaderEstimateAnomaly ? { leaderEstimateAnomaly } : {}),
            /*
             * [SCv2-T4] 判据层字段进入模型可读面（与看板载荷 normaliseStatusEntry 同源）：
             * 单次尝试墙钟（缺失＝null 未验证，绝不按 0）、结算三选一、用户批准留痕、
             * 违规审计（append-only）、事前预估超判据布尔（服务端算术，客户端不计算）。
             */
            attemptWallClockMs: attemptWallClockMsOf(item),
            criterionResult: item.criterionResult ?? null,
            criterionException: item.criterionException ?? null,
            criterionViolations: Array.isArray(item.criterionViolations) ? item.criterionViolations.slice(-10) : [],
            leaderEstimateOverCriterion: false,
        };
    });
}
export function buildRoundResult(record, sessionId, limits) {
    const { statuses, stats } = derivePlanSnapshot(record.statuses);
    return buildResultMessage({
        planId: record.plan.planId,
        planCreatedAt: record.plan?.createdAt,
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
        /*
         * [2.2.9][T3][M5] 冻结值与载荷同源：finishRound 已保证先 markReported
         * 再 build，这里若仍读 `record.reportPending` 可变标志，标志可能停在
         * 上一次失败的旧值，导致结果消息文本（plan.ts buildResultSummary 判
         * 「证据未通过（reportPending）」）与同一消息内 statuses 的门禁判定互相
         * 矛盾——正是震荡观感在消息侧的残留。改读派生函数后，冻结的 S3 恒等于
         * 载荷 statuses 的事实，摘要、指令与 present 门禁读到同一结论。
         */
        reportPending: deriveReportPending(record),
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
    const deadline = Number.POSITIVE_INFINITY;
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
        if (repairing) {
            record.resumeCount = Number(record.resumeCount ?? 0) + 1;
            /*
             * [3.1.7][P1 U-52] 续跑计数必须立刻落 durable。
             *
             * 旧实现只在内存自增，唯一持久化来源是回合结束时的 result 消息
             * （plan.ts buildResultMessage）。崩溃/重启发生在回合中途时，这次续跑
             * 完全不留痕 ⇒ 重建后 resumeCount 回退，续跑预算被无限重置（U-52）。
             * 这里在自增当场写一条计划级 workplan-update（subtaskId=null，只带
             * resumeCount），与 dispatchHold/gateHistory 同一「计划级字段抬升」范式。
             */
            try {
                const resumeSession = options.session ?? agent?.session;
                if (resumeSession) {
                    appendUserMessage(resumeSession, buildUpdateMessage({
                        planId: String(record.plan?.planId ?? record.planId ?? ''),
                        subtaskId: null,
                        status: undefined,
                        resumeCount: Number(record.resumeCount ?? 0),
                        note: `第 ${record.resumeCount} 次续跑已计费（durable）`,
                    }));
                }
            }
            catch (error) {
                pushRecordError(record, error);
            }
        }
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
    // 不创建整轮 totalTimer：配置中的历史时间值不会再中止部门或专家执行。
    record.dispatchedAt = Date.now();
    record.phase = 'executing';
    record.updatedAt = record.dispatchedAt;
    /*
     * [3.0.0][用户要求 4] 分配完成后，会话内必须输出固定文案
     * 「任务已经完成分配，正在执行中......」。放在本轮真正开跑（phase=executing、
     * 子 Agent 即将启动）之后、任何子任务结算之前，自动派发与手工派发同一路径，
     * 因此只输出一次、不会漏也不会重复。逐字冻结，不得改写。
     */
    {
        const assignSession = options.session ?? agent?.session;
        /*
         * [3.0.0][幂等键] 同一份计划只发一次：续跑/重派/durable 回放都会再次走到
         * 这里，若不加键就会重复刷屏。键＝planId，随 record 持久化（record 本身
         * 走 durable 快照），刷新后仍然生效。
         */
        const noticeKey = String(record.plan?.planId ?? record.planId ?? '');
        if (assignSession && noticeKey && record.assignedNoticeKey !== noticeKey) {
            record.assignedNoticeKey = noticeKey;
            appendUserMessage(assignSession, STATUS_ASSIGNED_TEXT);
        }
    }
    /*
     * [2.5.2][stall-fix] 执行期进度心跳（用户报告「提交任务后长时间无反应/以为
     * 死机」）：规划心跳只覆盖 runPlanner，派发后的执行轮次（可能十几分钟）
     * 旧实现期间零会话输出。现在只要本轮还在跑，就按固定间隔（默认 45s，
     * DSH_WORKPLAN_DISPATCH_HEARTBEAT_MS 可调，≥5000ms）经唯一合规写入器发
     * 「已用时+完成进度+不是卡死」的可见通知。与规划心跳同一收束纪律：
     * finally 里 stop（成功/超时/中止都收束），maxNotices 保险丝防失控，
     * 不新增事件类型、不触碰 system/message。
     */
    const dispatchHbSession = options.session ?? agent?.session;
    // [T7] C3 整轮预算：新一轮开跑即重置注入预算（roundKey=planId:dispatchedAt，与 finishRound 同键；
    // 会话取 dispatchHbSession，与本轮 appendUserMessage 同一对象，WeakMap 键一致）。
    if (dispatchHbSession)
        resetRoundInjectionBudget(dispatchHbSession, `${record.plan.planId}:${record.dispatchedAt}`);
    const dispatchHeartbeat = dispatchHbSession ? createPlanningHeartbeat({
        signal: childController.signal,
        appendNotice: (text) => appendUserMessage(dispatchHbSession, text),
        // 默认值引用 PLANNING_HEARTBEAT_MS 单一真源（同为 45s 心跳间隔）；
        // 环境变量名 DSH_WORKPLAN_DISPATCH_HEARTBEAT_MS 保持不变。
        intervalMs: planningHeartbeatIntervalMs(process.env.DSH_WORKPLAN_DISPATCH_HEARTBEAT_MS ?? PLANNING_HEARTBEAT_MS),
        startedAt: record.dispatchedAt,
        maxAttempts: 1,
        buildMessage: (elapsedMs) => {
            const snap = derivePlanSnapshot(record.statuses);
            return buildDispatchHeartbeat(elapsedMs, snap.stats?.done, snap.stats?.total, snap.stats?.inProgress);
        },
    }) : { start: () => { }, stop: () => { } };
    dispatchHeartbeat.start();
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
            /*
             * [3.1.8][P0 D4] 单写者闸：同一子任务已有存活负责人时不得再起一个。
             *
             * 先查进程内 head 登记表（resetBlockedStatuses 清掉 childId 后仍然有效），
             * 再查 durable row.childId 对应会话是否存活。只跳过「重复起头」，不把行改判；
             * 旧负责人仍可由 instruct/status 继续，避免两个负责人并行写同一目录。
             */
            const activeHeadNotices = [];
            const readyAfterHeadGate = ready.filter((item) => {
                let liveHead = recallLiveHeadActivation(ctx, record.plan?.planId, item.id);
                if (!liveHead) {
                    const row = (record.statuses ?? []).find((status) => status?.subtaskId === item.id);
                    const childId = typeof row?.childId === 'string' ? row.childId : '';
                    if (childId) {
                        try {
                            liveHead = ctx.sessions?.get?.(childId) ? childId : null;
                        }
                        catch {
                            liveHead = null;
                        }
                    }
                }
                if (!liveHead)
                    return true;
                const line = `${String(item.id)}（负责人 ${String(liveHead).slice(0, 8)}… 仍存活）`;
                if (!activeHeadNotices.includes(line))
                    activeHeadNotices.push(line);
                return false;
            });
            /*
             * [3.0.0+] 派发质量闸（2026-11-15 用户裁决）：主 Agent 派给部门负责人的
             * 每个子任务必须携带 qualityRequirements（质量要求）。缺失的子任务本轮
             * 直接拒发（不启动部门 Agent），落 blocked + closure:'escalated'——等主
             * Agent replan 补齐后重派：该形态不参与自动续跑（canResumePlan 排除
             * escalated）、不会被 readySubtasks 重复选中，天然防重试空转；其余合格
             * 子任务照常并发执行，互不影响。旧计划（createdAt 早于
             * QUALITY_GATE_ACTIVATED_AT）豁免，零回归。
             */
            let runnable = readyAfterHeadGate;
            if (isQualityGatePlan(record.plan)) {
                const rejected = [];
                runnable = [];
                for (const item of readyAfterHeadGate) {
                    const check = checkSubtaskQualityRequirements(item);
                    if (check.ok) {
                        runnable.push(item);
                        continue;
                    }
                    rejected.push(`${item.id}（${String(item.title ?? '无标题')}）：${check.error}`);
                    record.statuses = applyStatus(record.statuses, item.id, {
                        status: 'blocked',
                        closure: 'escalated',
                        blockedKind: 'escalated',
                        question: `${check.error} ${check.hint}`,
                        error: check.error,
                        escalatedAt: Date.now(),
                    });
                    record.errors = [...(record.errors ?? []), `${item.id}: ${check.code} ${check.error}`].slice(-20);
                }
                if (rejected.length > 0) {
                    const noticeSession = options.session ?? agent?.session;
                    if (noticeSession) {
                        appendUserMessage(noticeSession, [
                            `【派发拒发 · 质量要求缺失】${rejected.length} 个子任务未携带质量要求（qualityRequirements），`
                                + '已被系统直接拒发（DISPATCH_QUALITY_REQUIREMENTS_MISSING），未启动任何部门 Agent：',
                            ...rejected.map((line, index) => `  ${index + 1}. ${line}`),
                            '请立刻用 dsh_workplan_replan 为这些子任务补写质量要求（至少 1 条可检查：什么算合格、什么算不合格），'
                                + '然后重新派发；本次其余合格子任务正常执行、不受影响。',
                        ].join('\n'));
                    }
                }
            }
            if (runnable.length === 0) {
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
                if (activeHeadNotices.length > 0) {
                    const notice = `【防重复派发】以下子任务已有存活负责人，本轮未重复启动：${activeHeadNotices.join('、')}。`
                        + '请用 dsh_workplan_status 查看进度，或用 dsh_workplan_instruct 催办；不要再次 dispatch 起第二个负责人。';
                    record.errors = [...(record.errors ?? []), notice].slice(-20);
                    try {
                        const noticeSession = options.session ?? agent?.session;
                        if (noticeSession) {
                            appendUserMessage(noticeSession, makeUserMessage(notice, {
                                kind: 'workplan',
                                form: 'notice',
                                summary: '防重复派发：已有存活负责人',
                            }));
                        }
                    }
                    catch { /* 通知失败不影响主流程 */ }
                }
                const pending = liveStatuses(record.statuses).filter((item) => item.status === 'pending');
                if (pending.length > 0) {
                    const reasons = pending.map((item) => `${item.subtaskId}：${describePendingCause(record.plan, record.statuses, item.subtaskId)}`);
                    const message = `本轮结束，仍有 ${pending.length} 项保持 pending（不是失败，也未级联成 blocked）：${reasons.slice(0, 6).join('；')}`;
                    record.error = message;
                    record.errors = [...(record.errors ?? []), message].slice(-20);
                }
                break;
            }
            await runWithConcurrency(runnable, MAX_CONCURRENT, async (item) => {
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
        dispatchHeartbeat.stop();
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
 * [3.1.5] 第三层「会话已结束但台账仍 running」的读时收敛。
 *
 * 事故（session-82fe93a1…T4）：行业景气/资金面两个叶子会话已经正常 turn/end，
 * 但因为收尾消息没有合格 WORKPLAN_EVIDENCE 结果块，结算回调不能把它们记 done；
 * 回调若再被异步链路上的异常吞掉，行 delegates[] 就会永久停在 running。负责人
 * action="status" 时按会话日志重放最后一条助手正文：合格汇报按 F10 补结算 done，
 * 不合格汇报按实改 failed；没有助手正文（phase-0 等接续）保持 running，绝不误杀。
 */
function latestAssistantText(session) {
    if (!session || typeof session.eventAt !== 'function')
        return '';
    const total = Number(session.seq);
    if (!Number.isFinite(total) || total <= 0)
        return '';
    const floor = Math.max(0, Math.floor(total) - 100);
    for (let seq = Math.floor(total) - 1; seq >= floor; seq -= 1) {
        let event;
        try {
            event = session.eventAt(seq);
        }
        catch {
            return '';
        }
        if (!event)
            continue;
        if (event.type !== 'assistant/message')
            continue;
        const text = messageText(event.data?.message ?? event.data).trim();
        if (text)
            return text;
    }
    return '';
}
/**
 * [T4][F3] 结算备份候选路径：新名（含 planId）优先，旧名兼容。
 *
 * planId 只做安全字符清洗；planId 为空时退化为旧名（不产生重复候选）。
 */
export function settlementBackupPaths(cwd, planId, subtaskId) {
    const dir = join(cwd, 'reports');
    const legacy = join(dir, `wp-settlement-${subtaskId}.json`);
    const safePlan = String(planId ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
    return safePlan ? [join(dir, `wp-settlement-${safePlan}-${subtaskId}.json`), legacy] : [legacy];
}
/*
 * [T4][F1] 持久结算快照：子会话被释放后唯一还能取到的「它已经结束」的事实。
 *
 * 生产时序（宿主源码）：dsh-subagent/src/manager.ts:1077 先 dispose 子会话，
 * :1105 才 notifySettlement；dsh-session/src/index.ts:1409 在 detach 时删除
 * 登记表条目，:1511 的 get() 只查活体。因此负责人事后 action="status" 时
 * `ctx.sessions.get(childId)` 必然为空——3.1.5 的收敛函数据此直接 return，
 * 台账永远停在 running。
 *
 * 宿主在同一时刻把收尾事实写成了父会话（这里是部门负责人会话）的 durable
 * user/message：source.kind='subagent-settled'，携带 stopReason 与 closing
 * text。它是可回放的（刷新/重启后仍在事件流里），这就是第二状态源。
 */
export function settledSnapshotOf(message, at) {
    const source = message?.source;
    if (!source || source.kind !== 'subagent-settled')
        return null;
    const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : '';
    if (!childId)
        return null;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const texts = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text));
    let text = '';
    let omitted = false;
    const closingAt = texts.indexOf('Its closing message:');
    if (closingAt >= 0) {
        text = texts
            .slice(closingAt + 1)
            .filter((item) => !item.startsWith('Structured result: '))
            .join('\n')
            .trim();
    }
    else if (texts.some((item) => item.startsWith('It sent you a message just before finishing'))) {
        /*
         * 「收尾正文被省略」表示子会话最后一步是给父会话发消息。该条消息本身
         * 也是父会话的 durable user/message（source.kind='agent-message'），
         * 由 collectSettledSnapshots 用同一 childId 的最近正文回填。
         */
        omitted = true;
    }
    return {
        childId,
        at: Number.isFinite(Number(at)) ? Number(at) : null,
        stopReason: typeof source.stopReason === 'string' ? source.stopReason : 'unknown',
        text,
        omitted,
    };
}
/** 取一条 `agent-message` 消息的正文（去掉宿主包装的 "Agent X sent a message: " 前缀行）。 */
export function agentMessageText(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const texts = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text));
    if (texts.length > 0 && /^Agent .+ sent a message: $/.test(texts[0]))
        return texts.slice(1).join('\n').trim();
    return texts.join('\n').trim();
}
const settledSnapshotCache = new Map();
/**
 * 扫描父会话事件流，按 childId 汇总「持久结算快照」。
 *
 * 只读、纯派生；同一 `session.seq` 直接命中缓存（事件流 append-only，seq
 * 推进才会重新扫描）。同一 childId 多次结算时以最后一次为准。
 */
export function collectSettledSnapshots(session) {
    const snapshots = new Map();
    if (!session || typeof session.eventAt !== 'function')
        return snapshots;
    const total = Number(session.seq);
    if (!Number.isFinite(total) || total <= 0)
        return snapshots;
    const key = String(session.id ?? 'anonymous');
    const cached = settledSnapshotCache.get(key);
    if (cached && cached.at === total && cached.session === session)
        return cached.snapshots;
    const lastAgentMessage = new Map();
    for (let seq = 0; seq < total; seq += 1) {
        let event;
        try {
            event = session.eventAt(seq);
        }
        catch {
            break;
        }
        if (event?.type !== 'user/message')
            continue;
        const message = event.data?.message ?? event.data;
        const source = message?.source ?? {};
        const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : '';
        if (!childId)
            continue;
        if (source.kind === 'agent-message') {
            const text = agentMessageText(message);
            if (text)
                lastAgentMessage.set(childId, text);
            continue;
        }
        if (source.kind !== 'subagent-settled')
            continue;
        const snapshot = settledSnapshotOf(message, event.time);
        if (!snapshot)
            continue;
        if (!snapshot.text && snapshot.omitted)
            snapshot.text = lastAgentMessage.get(childId) ?? '';
        snapshots.set(childId, snapshot);
    }
    settledSnapshotCache.set(key, { at: total, session, snapshots });
    return snapshots;
}
/**
 * [3.1.5][T4] 第三层「会话已结束但台账仍 running」的读时收敛。
 *
 * 状态源按优先级：① 仍存活的子会话（释放前的窄窗口）；② 父会话 durable 的
 * `subagent-settled` 快照（生产主路径，见上）。只有「确认已结束」才收敛，
 * 绝不把仍在跑的行误杀：活体回合未 end、phase-0 只调用工具没有助手正文，
 * 都保持 running。收敛结果仍按 F10 判：无合格结果块一律 failed，绝不计 done。
 *
 * 第三个参数（getSettled）保持可选：旧调用点/旧测试不传即维持原行为。
 */
export function reconcileEndedDelegateSessions(delegates, getSession, getSettled) {
    const list = Array.isArray(delegates) ? delegates : [];
    let changed = false;
    const reconciled = [];
    const unresolved = [];
    const next = list.map((item) => {
        if (!item || item.status !== 'running' || item.escalation || item.closure === 'escalated')
            return item;
        const childId = typeof item.childId === 'string' ? item.childId : '';
        if (!childId) {
            unresolved.push({ member: String(item.member ?? '?'), childId: null, reason: 'childId 未登记' });
            return item;
        }
        let endedAt = null;
        let text = '';
        let from = 'live-session';
        let abnormal = null;
        const session = getSession?.(childId);
        if (session) {
            const turn = sessionTurnState(session);
            if (turn.state !== 'ended')
                return item;
            endedAt = Number.isFinite(turn.at) ? turn.at : null;
            text = latestAssistantText(session);
            // phase-0 / 仅工具调用收尾：活体回合结束但没有助手正文，保持 running，绝不误杀。
            if (!text)
                return item;
        }
        else {
            const settled = getSettled?.(childId);
            if (!settled) {
                unresolved.push({ member: String(item.member ?? '?'), childId, reason: '子会话已释放且无持久结算快照' });
                return item;
            }
            from = 'settled-message';
            endedAt = Number.isFinite(Number(settled.at)) ? Number(settled.at) : null;
            text = typeof settled.text === 'string' ? settled.text : '';
            if (typeof settled.stopReason === 'string' && settled.stopReason !== 'completed')
                abnormal = settled.stopReason;
            else if (!text.trim())
                abnormal = 'completed-without-text';
        }
        changed = true;
        const f10 = abnormal ? null : adjudicateExpertReport({ output: [{ type: 'text', text }] });
        const ok = f10?.ok === true;
        const settledItem = {
            ...item,
            status: ok ? 'done' : 'failed',
            closure: null,
            summary: truncate(text, 300),
            error: ok ? null : truncate(abnormal === 'completed-without-text'
                ? '子会话已结束但没有任何收尾正文，无法核验结果块（完成必回报）'
                : abnormal
                    ? `子会话结束状态 ${abnormal}`
                    : String(f10?.rejection ?? '结果块缺失或 JSON 无法解析'), 300),
            finishedAt: endedAt ?? Date.now(),
            /*
             * [T4][F4] 与正常子结算区分：正常结算条目没有这两个字段；它们随
             * delegates 一起进 durable workplan-update 并被回放（plan.ts 白名单）。
             */
            reconciledAt: Date.now(),
            reconciledFrom: from,
        };
        reconciled.push({
            member: String(settledItem.member ?? '?'),
            childId,
            from,
            status: settledItem.status,
        });
        return settledItem;
    });
    return { delegates: changed ? next : list, changed, reconciled, unresolved };
}
/**
 * [3.1.8][P1 D5] 负责人会话已释放时的停滞收敛。
 *
 * `reconcileEndedDelegateSessions` 只认「活体会话已结束」或「父会话有
 * subagent-settled 快照」；两者都没有时它会保持 running（宁可不动，绝不误杀）。
 * 但负责人会话被释放后，叶子既不会有活体回合、也没有父会话可写快照，台账会
 * 永久停在 running——这正是 T2 事故里“专家静默死亡、负责人无感知”的最后一段。
 *
 * 这里补一条**有界**判定：childId 已登记、当前无活体会话、无结算快照、且开工
 * 已超过 stallMs（默认 120s）⇒ 标 failed(stalled) 并写 reconciledAt/From。
 * 仍保持与正常结算可区分；不自动重派。childId 为空（排队中尚未激活）、
 * escalation、getSession/getSettled 抛错（未知）一律不动。
 */
export function markStalledDelegates(delegates, getSession, getSettled, now = Date.now(), stallMs = 120_000) {
    const list = Array.isArray(delegates) ? delegates : [];
    const stalled = [];
    let changed = false;
    const next = list.map((item) => {
        if (!item || item.status !== 'running' || item.escalation || item.closure === 'escalated')
            return item;
        const childId = typeof item.childId === 'string' ? item.childId : '';
        if (!childId)
            return item;
        let live = null;
        try {
            live = getSession?.(childId);
        }
        catch {
            return item;
        }
        if (live)
            return item;
        let settled = null;
        try {
            settled = getSettled?.(childId);
        }
        catch {
            return item;
        }
        if (settled)
            return item;
        const startedAt = Number(item.startedAt ?? 0);
        if (!Number.isFinite(startedAt) || startedAt <= 0 || now - startedAt < stallMs)
            return item;
        changed = true;
        const marked = {
            ...item,
            status: 'failed',
            error: '子会话已消失超过 120s 且无结束快照，判定停滞（不自动重派）',
            finishedAt: now,
            reconciledAt: now,
            reconciledFrom: 'live-session',
        };
        stalled.push(marked);
        return marked;
    });
    return { delegates: changed ? next : list, changed, stalled };
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
            /*
             * [3.1.7][P2 U-08] 投影必须自洽且可识别：
             *  - closure 同步投影成 blocked（escalated 保留——那是真实的人工
             *    等待，不是 stale），否则下发载荷里出现「blocked + instructed/
             *    assigned」的非法组合，与 applyStatus 的投影不变量分叉；
             *  - blockedKind/finishedAt 补齐，读侧不再看到「卡住但没有原因、
             *    没有结束时间」的行；
             *  - staleProjection:true 显式标记这是**只读投影**而非持久改判，
             *    消费端（看板/审计）据此区分「真的受阻」与「回合结束的收束」。
             * 不抬 revision：本函数只作用于 serialisePlan 的下发快照，绝不写回
             * record.statuses（持久层仍是 in_progress，由续跑/重置路径接管）；
             * 抬号反而会让「同一行两次下发版本不同」污染单调闸。U-08 的治本是
             * 「投影自洽 + 显式标记 + 不冒充持久状态」，而不是给只读快照抬号。
             */
            closure: item.closure === 'escalated' ? 'escalated' : 'blocked',
            blockedKind: item.blockedKind ?? 'failed',
            finishedAt: typeof item.finishedAt === 'number' ? item.finishedAt : Date.now(),
            staleProjection: true,
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
        /*
         * [3.1.7][P3 U-36] 看板载荷不再把同一份计划定义整包下发第三遍。
         *
         * 旧实现同时带 plan（完整定义）、statuses（行级验收证据）、stages
         * （plan.stages 的原样投影）——同一条 acceptance 文本在载荷里出现 3 次
         * （T9 R-8-03 实证：$.sessions[0].plan.stages… / statuses… / stages…）。
         * 客户端只读 session.stages 与 session.statuses（src/client.ts 的
         * allEntries/planStageRows/StageCard 全部走这两个字段），从不读
         * session.plan；plan 整包是纯冗余传输。现在只保留 stages 投影（界面
         * 渲染所需）与 statuses（行级证据），plan 定义不再随看板载荷下发；
         * 需要完整定义时走 dsh_workplan_status／ durable 计划消息，那是权威源。
         */
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
        // [2.2.9][T3][M4.1] 看板观测与门禁同源（纯派生），不再读可变标志。
        reportPending: deriveReportPending(record),
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
                mainStartPhases: null,
                mainStartPhasesPlanId: null,
                dispatchHold: undefined,
                gateHistory: undefined,
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
            /*
             * [3.1.7][P2 U-40] 幂等哨兵从 durable 日志恢复，不再只活在内存。
             *
             * assignedNoticeKey / preAnnouncedPlanId 旧实现只在 live record 上赋值，
             * 重建记录从不携带 ⇒ 重启后同一份计划的「任务已经完成分配」与「派发预告」
             * 会再刷一遍（T7 W2-07）。这两条通知本身就是 durable user/message，
             * 回放时按逐字文案识别即可还原哨兵：见过 STATUS_ASSIGNED_TEXT ⇒ 该 planId
             * 已发过分配通知；见过【派发预告】⇒ 已预告。哨兵随重建记录返回，live 与
             * replay 同口径，重复刷屏封死。识别只认本计划窗口内的事件（start 已按
             * planId 前移），不会把别的计划的通知误算进来。
             */
            try {
                const noticeText = messageText(event.data).trim();
                if (noticeText === STATUS_ASSIGNED_TEXT && currentId) {
                    const snap = snapshots.get(currentId);
                    if (snap)
                        snap.assignedNoticeKey = String(snap.plan?.planId ?? currentId);
                }
                else if (noticeText.startsWith('【派发预告】') && currentId) {
                    const snap = snapshots.get(currentId);
                    if (snap)
                        snap.preAnnouncedPlanId = String(snap.plan?.planId ?? currentId);
                }
            }
            catch {
                /* 哨兵识别失败不影响回放主流程。 */
            }
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
                        for (const field of ['deadlineAt', 'timeNotice', 'timeWarning', 'timeJournal', 'pendingAdjudication', 'timeoutCount', 'takeoverRequired', 'takeoverBrief', 'criterionResult', 'criterionException', 'criterionViolations']) {
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
                    // [3.1.7][P1 U-52] 只前进不后退：旧 result 消息（崩溃前写的、计数更小）
                    // 不得把续跑当场已落 durable 的计数抹回去。
                    snap.resumeCount = Math.max(Number(snap.resumeCount ?? 0), Number(result.resumeCount ?? 0)) || 0;
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
             * "apply it when its turn comes". [2.2.9][T2][mono-gate] used to claim a
             * protection that only existed on the result-message path
             * (`applyResultStatuses`): a durable update with a lower revision could
             * still overwrite a newer settled row. The gate below now enforces it —
             * a strictly-lower revision never overwrites; equal revision passes
             * (dedup for the same write lives in `appliedUpdates`).
             */
            /* [2.5.5][T10] 合并汇总消息按序展开成多条 update，逐条应用（与逐条落盘等价）。 */
            for (const update of parseUpdateMessages(event.data)) {
                /*
                 * [3.0.8] 主 Agent 开工证据回放（计划级字段）：写入侧
                 * （dispatchTool 开工闸登记）把 mainStartPhases/mainStartPhasesPlanId 随
                 * durable workplan-update 落盘（subtaskId=null，不挂任何子任务行）；
                 * 消费侧同一判据消毒（sanitizeStartPhaseEvidence）后抬进计划快照——刷新/
                 * 重启后续跑读档放行，不必重新提交；旧日志无该字段零迁移不报错。
                 */
                if (update && typeof update.planId === 'string' && update.mainStartPhases !== undefined) {
                    const startPhasesSnap = snapshots.get(update.planId);
                    if (startPhasesSnap) {
                        startPhasesSnap.mainStartPhases = sanitizeStartPhaseEvidence(update.mainStartPhases);
                        startPhasesSnap.mainStartPhasesPlanId = typeof update.mainStartPhasesPlanId === 'string' ? update.mainStartPhasesPlanId : null;
                    }
                }
                /*
                 * [3.0.1] 认可闸门回放（计划级字段）：写入侧 buildUpdateMessage 已携带
                 * dispatchHold/gateHistory；消费侧同口径消毒抬升。dispatchHold 为 null
                 * 表示「已 release」（快照清闸），gateHistory 只增审计随回放还原。
                 */
                if (update && typeof update.planId === 'string' && update.dispatchHold !== undefined) {
                    const holdSnap = snapshots.get(update.planId);
                    if (holdSnap) {
                        const raw = update.dispatchHold;
                        holdSnap.dispatchHold = raw && typeof raw === 'object'
                            ? {
                                kind: raw.kind === 'manual' ? 'manual' : 'keyword',
                                reason: truncate(String(raw.reason ?? ''), 300),
                                at: Number(raw.at) || 0,
                                by: raw.by === 'agent' ? 'agent' : 'system',
                            }
                            : null;
                    }
                }
                if (update && typeof update.planId === 'string' && Array.isArray(update.gateHistory)) {
                    const holdSnap = snapshots.get(update.planId);
                    if (holdSnap)
                        holdSnap.gateHistory = update.gateHistory.slice(-10);
                }
                /*
                 * [3.1.7][P1 U-52] 续跑计数回放（计划级字段抬升，与 gateHistory 同范式）：
                 * 只前进不后退——取历史最大值，避免旧 result 消息把已计费的续跑抹回去。
                 */
                if (update && typeof update.planId === 'string' && Number.isInteger(Number(update.resumeCount))) {
                    const resumeSnap = snapshots.get(update.planId);
                    if (resumeSnap) {
                        resumeSnap.resumeCount = Math.max(Number(resumeSnap.resumeCount ?? 0), Number(update.resumeCount));
                    }
                }
                if (update && typeof update.planId === 'string' && typeof update.subtaskId === 'string') {
                    const snap = snapshots.get(update.planId);
                    if (snap) {
                        try {
                            /*
                             * [2.2.9][T2][mono-gate] 结算事件写入单调性闸（M1，症状①主闸）。
                             *
                             * 事故形状（wp-215ed52f T5 实证）：结算 rev16 已落 durable 结果消息，
                             * 主 Agent 基于落后的 live 快照做 handoff 答复，追加了 rev9/10 的
                             * workplan-update（seq 更晚）。回放按 seq 升序，后到的旧事件无条件
                             * 覆盖先落盘的新结算——「后到即覆盖」与「revision 单调、已结算内容
                             * 不可回退」的业务不变量正面冲突。
                             *
                             * 闸语义（与 plan.ts applyResultStatuses 的 result 族闸对齐）：
                             *  - evRev < rowRev → 回退事件：拒绝整事件语义（含 3936 一带的直写
                             *    白名单与 extendMs 合成，防止旧事件的状态性字段漏进新行），只有
                             *    handoffs 走逐项单调合并（M2：答复是字段级增量，新登记永远合法、
                             *    answered/closed 终态永不回退）；
                             *  - 仍必须 appliedUpdates.set：否则同一次改判的 tool/result 配对
                             *    记录（patch 不带 rev，applyStatus 强算 current+1）会绕过本闸从
                             *    第二通道把旧内容灌回；
                             *  - evRev === rowRev → 前向通过（等 rev 补写是合法场景；同一条写入
                             *    的重复应用由既有 appliedUpdates/1.8.11 去重通道拦截）；
                             *  - evRev 为 null（旧格式无 revision 字段 / 非整数）→ 不猜、放行，
                             *    向后兼容（applyStatus 尾部按 current+1 单调抬号）。
                             */
                            const gateRow = snap.statuses.find((item) => item?.subtaskId === update.subtaskId);
                            const rowRev = Number(gateRow?.revision ?? 0);
                            const evRev = Number.isInteger(update.revision) ? Number(update.revision) : null;
                            if (gateRow && evRev !== null && evRev < rowRev) {
                                if (Array.isArray(update.handoffs)) {
                                    const merged = mergeHandoffEntriesByUpdatedAt(gateRow.handoffs, update.handoffs);
                                    if (merged.changed)
                                        gateRow.handoffs = merged.value;
                                }
                                console.warn('[dsh-workplan] monotonicity gate skipped a stale replayed update: '
                                    + `${String(update.planId)}/${String(update.subtaskId)} `
                                    + `(event rev ${evRev} < row rev ${rowRev}); row content kept, `
                                    + 'handoff entries merged monotonically');
                                appliedUpdates.set(updateKey(update.planId, update.subtaskId), {
                                    seq: Number(event.seq ?? 0),
                                    status: String(update.status ?? ''),
                                });
                                continue;
                            }
                            /*
                             * [2.3.0][hotfix] 回放兼容「已回报行 + 旧版 closure:'done' 错误快照」（用户 2026-11-10 截图：
                             * wp-3080d01d T6/T7「非法闭环迁移：reported → done」回放忽略）。
                             *
                             * 2.0.4 之前 live 侧 applyStatus 把 reported 行的 closure 误写回 'done'，durable 改判
                             * 消息因此嵌着这个错误快照。2.2.6 D-1 给回放补了 closure 透传，但没有豁免这一组合：
                             * 回放大方把 'done' 当显式闭环意图传给迁移表 → reported → done 被拒 → 整条改判
                             * （含 verification/acceptance 证据）被裸 catch 吞掉，重启后行退回缺证据态。
                             *
                             * 口径与 2.0.4 live 侧镜像：事件 closure='done' 且当前行 closure='reported' 时，这是
                             * 「复核补齐」而非「退回未回报」，丢弃该显式值，让 done 分支按 2.0.4 保留已回报事实。
                             * 其余透传分支（escalated/instructed 等，D-1 语义）零改动。
                             */
                            const preReplayRow = snap.statuses.find((item) => item?.subtaskId === update.subtaskId);
                            const replayClosure = typeof update.closure === 'string'
                                ? (update.closure === 'done' && preReplayRow?.closure === 'reported' ? undefined : update.closure)
                                : undefined;
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
                                closure: replayClosure,
                                progress: typeof update.progress === 'number' ? update.progress : undefined,
                                summary: typeof update.note === 'string' ? update.note : undefined,
                                // [1.8.13] Evidence written through the update tool must survive replay.
                                verification: update.verification,
                                acceptance: update.acceptance,
                                artifacts: update.artifacts,
                                missingArtifacts: update.missingArtifacts,
                                handoffs: update.handoffs,
                                /*
                                 * [3.0.1] 死锁自愈：复活指示随 durable update 回放（applyStatus
                                 * 同口径消毒，undefined 保留旧值）——重启后重建的子会话仍能收到
                                 * 主 Agent 对升级请示的拍板指示。
                                 */
                                reviveInstruction: update.reviveInstruction,
                                revision: Number.isInteger(update.revision) ? update.revision : undefined,
                                // [2.2.0][T4/O-3b][E] 回放白名单（T3b TODO#2）：O-3b/O-2c 留档字段随
                                // update 记录回放；timeoutMs 有 applyStatus 分支，走 patch 即可。
                                timeoutMs: update.timeoutMs,
                                /*
                                 * [2.5.0][G1] 整体任务等级与第三层梳理/台账必须随 durable
                                 * workplan-update 回放：写入侧（plan.ts buildUpdateMessage）已携带
                                 * effortOverride/consolidation/delegates，消费端 patch 此前漏传，
                                 * 刷新/重启后整体等级丢失（resolveTaskEffort 回落旧档）、梳理登记
                                 * 与第三层台账同丢。三字段在 applyStatus 均有路由分支，undefined
                                 * 保留旧值——旧日志零迁移，与 live 侧同一口径。
                                 */
                                effortOverride: update.effortOverride,
                                consolidation: update.consolidation,
                                // [3.0.8] 行级开工证据（review/direct 登记）回放：applyStatus 同口径
                                // 消毒，undefined 保留旧值——刷新/重启后结算一致性比对与重试蓝图不丢。
                                startPhases: update.startPhases,
                                delegates: update.delegates,
                                delegateSelfEfforts: update.delegateSelfEfforts,
                                // [3.0.8] 叶子开工证据台账回放（applyStatus 同口径消毒）。
                                delegateStartPhases: update.delegateStartPhases,
                                // [T6][契约v1 §3] 第三层开工预估台账回放（applyStatus 同口径消毒，
                                // undefined 保留旧值）：刷新/重启后预估不丢，重派读档门禁据此判定。
                                delegateEstimates: update.delegateEstimates,
                                // [2.5.4][T3R1] 分派前深度梳理门禁审计回放（A3：刷新/重启后
                                // 拒绝/放行记录仍可复核；applyStatus 同口径消毒，undefined 保留旧值）。
                                gateAudit: update.gateAudit,
                                /*
                                 * [3.1.7][P1 U-38] 回放白名单补齐 13 个闭环字段。
                                 *
                                 * 写入侧（plan.ts buildUpdateMessage）早已携带这些字段，但消费端
                                 * patch 一直漏传 ⇒ 重启/刷新后「待指示的问题与选项、请示序号、
                                 * 指示正文与回执、指派/回报时间」全部丢失，行看起来像从未被指示过。
                                 * applyResultStatuses（结果消息路径）本来就传全了，只有 update
                                 * 路径丢——这里对齐同一口径。undefined 保留旧值，旧日志零迁移。
                                 */
                                question: update.question,
                                options: update.options,
                                blockedKind: update.blockedKind,
                                escalatedAt: update.escalatedAt,
                                escalationSeq: update.escalationSeq,
                                instruction: update.instruction,
                                instructionSeq: update.instructionSeq,
                                assignedAt: update.assignedAt,
                                ackedAt: update.ackedAt,
                                ackEvidence: update.ackEvidence,
                                ackOverdue: update.ackOverdue,
                                instructionOverdue: update.instructionOverdue,
                                reportedAt: update.reportedAt,
                                // [3.1.7][P0 U-71] 负责人换主留档回放（applyStatus 同口径消毒）。
                                childIdHistory: update.childIdHistory,
                                // [3.1.8][治本] 负责人身份回放：派发成功即 durable 写入，
                                // 重建后仍认得出「这一行属于哪个负责人会话」（治 SELF_EFFORT_MISSING 竞态）。
                                childId: update.childId,
                                updatedBy: 'agent',
                            });
                            /*
                             * [2.2.9][T3][M4] 回放侧人工改判的回报闭环——与 live 路径（改判
                             * 工具在 durable 落盘成功后 markReported）配成同一条不变量：
                             * durable 的 workplan-update 携带显式 status:'done' 时，这条消息
                             * 本身就是主 Agent 亲笔写进会话日志的「完成已回报」证据。旧日志
                             * 嵌的是 closure:'done'（2.2.9 之前的口径），回放在此一并升级为
                             * reported；report.ref 指向这条 durable 消息的 seq——引用真实存在、
                             * 可复核。不升 handoffs 快照消息（它们的 status 未被应用，handoff
                             * 记录不是一次回报），子结算行的回报仍须来自结果消息或 pre-step
                             * 自愈（M4.2）。live 与重建由此在同一份日志上逐行同判，
                             * 「可交付↔门禁未放行」的震荡失去立足点。
                             */
                            if (update.status === 'done' && update.handoffs === undefined) {
                                const healedRow = snap.statuses.find((item) => item?.subtaskId === update.subtaskId);
                                if (healedRow?.status === 'done' && healedRow?.closure === 'done') {
                                    healedRow.closure = 'reported';
                                    healedRow.reportedAt = Number(update.at) || Date.now();
                                    healedRow.report = {
                                        state: 'sent',
                                        at: Number(update.at) || Date.now(),
                                        ref: `${String(update.planId)}:replay:${String(Number(event.seq ?? 0))}`,
                                        turn: null,
                                    };
                                    /*
                                     * [3.1.7][P1 U-15] 自愈不再额外抬 revision。
                                     *
                                     * 首版修复曾在此 +1，但 applyStatus 的 done 分支已经把 revision
                                     * 抬到事件值（Math.max(patch.revision, current+1)），再 +1 会让
                                     * 「durable update 与配对 tool/result 只写一次」的不变量失效
                                     * （runtime-replay 两条守门测试实证 5!==4）。自愈只是把同一次
                                     * 改判的闭环投影补齐（closure/report/reportedAt），不是一次新的
                                     * 状态前进；revision 以 applyStatus 的结果为准，updatedBy 保持
                                     * 'agent'（这条 durable 消息本就是主 Agent 亲笔写的）。
                                     */
                                }
                            }
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
                                for (const field of ['deadlineAt', 'timeNotice', 'timeWarning', 'timeJournal', 'pendingAdjudication', 'timeoutCount', 'takeoverRequired', 'takeoverBrief', 'criterionResult', 'criterionException', 'criterionViolations']) {
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
                                + /*
                                   * [2.2.9][T3][M4.3] 可诊断化：旧快照携带的 closure/revision 与被保留
                                   * 的行现状一并带出，「改判丢失」不再只有一句 error.message。
                                   */
                                    `event rev=${String(update?.revision ?? 'none')} closure=${String(update?.closure ?? 'none')} `
                                + `vs row rev=${String(snap.statuses.find((item) => item?.subtaskId === update?.subtaskId)?.revision ?? 'none')}：`
                                + `${error instanceof Error ? error.message : String(error)}`);
                        }
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
    /*
     * [3.1.7][P1 U-43] 台账写前日志（WAL）消费：把「进过内存缓冲但没来得及落
     * user/message」的更新补回重建态。纪律与主回放完全一致——
     *  - 只认本会话（sessionId）＋本计划（planId）的行；
     *  - revision 单调闸：WAL 行 rev < 当前行 rev ⇒ 跳过（user/message 通道已经
     *    应用过同一条或更新的改判，绝不重复前进、绝不回退）；
     *  - 走同一个 applyStatus 白名单（含 3.1.7 补齐的 13 个闭环字段）；
     *  - 坏行/非法形状静默跳过（读端 coerceRecord 已兜底），不抛错拖垮重建。
     * WAL 是兜底不是权威：user/message 仍是模型可见的权威通道。
     */
    try {
        const walRows = readNoticeLedger();
        /*
         * [3.1.7][P1 U-43] 先收集本会话的 WAL 确认标记：合并归档真正落
         * user/message 时会写一条 form='wal-ack'（携带本批 walIds）。有 ack 的
         * wal 行说明权威通道已经应用过同一次改判，回放绝不重复消费。
         */
        const ackedWalIds = new Set();
        for (const row of walRows) {
            if (row?.form !== 'wal-ack')
                continue;
            if (String(row.sessionId ?? '') !== String(session?.id ?? ''))
                continue;
            const ids = row.durable?.walIds;
            if (Array.isArray(ids))
                for (const id of ids)
                    if (typeof id === 'string')
                        ackedWalIds.add(id);
        }
        for (const row of walRows) {
            if (row?.form !== 'wal' || !row.durable)
                continue;
            if (String(row.sessionId ?? '') !== String(session?.id ?? ''))
                continue;
            const update = row.durable;
            if (update?.kind !== 'workplan-update' || String(update?.planId ?? '') !== String(plan?.planId ?? ''))
                continue;
            /*
             * [3.1.7][P1 U-43] 计划实例归属：同一 planId/sessionId 可能被不同计划
             * 实例复用（测试夹具、重建后的新计划）。WAL 行携带 planCreatedAt 时，
             * 必须与当前计划的 createdAt 一致才消费；旧格式 WAL 行没有该键，退回
             * revision 单调闸单独守门。
             */
            if (Number.isFinite(Number(update.planCreatedAt)) && Number(update.planCreatedAt) !== Number(plan?.createdAt ?? 0))
                continue;
            /*
             * [3.1.7][P1 U-43] 会话实例归属（第二道）：WAL 行写入时的会话事件数
             * （walSeq）必须 >= 当前重建会话的事件总数。缓冲中的更新一定发生在
             * 会话已有事件之后；若 walSeq < session.seq，说明这条 WAL 属于「更早的
             * 会话实例」（同 id 同 planId 的上一轮测试/上一次运行），其内容要么已
             * 落权威通道、要么与本次重建无关——绝不消费。崩溃窗口里的真实 WAL 行
             * walSeq == 崩溃前事件数 == 重建会话事件数，恰好通过。
             */
            const walSeq = Number(update.walSeq);
            if (Number.isFinite(walSeq) && walSeq < Number(session?.seq ?? 0))
                continue;
            if (typeof update?.subtaskId !== 'string' || !update.subtaskId)
                continue;
            /* 已确认（权威通道已落盘）⇒ 跳过；只补崩溃窗口里没落盘的更新。 */
            if (typeof update.walId === 'string' && ackedWalIds.has(update.walId))
                continue;
            /*
             * revision 单调闸（第二道防线）：WAL 行 rev <= 当前行 rev ⇒ 跳过。
             * 即使 ack 缺失（写入失败/旧格式），也绝不把旧快照叠到新状态上。
             * 只有 rev 严格大于当前行 rev 的 WAL 行才是「缓冲了但没落盘就崩溃」
             * 的新改判，才补。applyStatus 内部 Math.max(rev, current+1) 保证只前进。
             */
            const target = statuses.find((item) => item?.subtaskId === update.subtaskId);
            if (!target)
                continue;
            const evRev = Number.isInteger(update.revision) ? Number(update.revision) : null;
            if (evRev !== null && evRev <= Number(target.revision ?? 0))
                continue;
            try {
                const replayClosure = typeof update.closure === 'string'
                    ? (update.closure === 'done' && target?.closure === 'reported' ? undefined : update.closure)
                    : undefined;
                const next = applyStatus(statuses, update.subtaskId, {
                    status: update.handoffs === undefined ? update.status : undefined,
                    closure: replayClosure,
                    progress: typeof update.progress === 'number' ? update.progress : undefined,
                    summary: typeof update.note === 'string' ? update.note : undefined,
                    verification: update.verification,
                    acceptance: update.acceptance,
                    artifacts: update.artifacts,
                    missingArtifacts: update.missingArtifacts,
                    handoffs: update.handoffs,
                    reviveInstruction: update.reviveInstruction,
                    revision: evRev ?? undefined,
                    timeoutMs: update.timeoutMs,
                    effortOverride: update.effortOverride,
                    consolidation: update.consolidation,
                    startPhases: update.startPhases,
                    delegates: update.delegates,
                    delegateSelfEfforts: update.delegateSelfEfforts,
                    delegateStartPhases: update.delegateStartPhases,
                    delegateEstimates: update.delegateEstimates,
                    gateAudit: update.gateAudit,
                    question: update.question,
                    options: update.options,
                    blockedKind: update.blockedKind,
                    escalatedAt: update.escalatedAt,
                    escalationSeq: update.escalationSeq,
                    instruction: update.instruction,
                    instructionSeq: update.instructionSeq,
                    assignedAt: update.assignedAt,
                    ackedAt: update.ackedAt,
                    ackEvidence: update.ackEvidence,
                    ackOverdue: update.ackOverdue,
                    instructionOverdue: update.instructionOverdue,
                    reportedAt: update.reportedAt,
                    childIdHistory: update.childIdHistory,
                    // [3.1.8][治本] WAL 行同样携带负责人身份，崩溃窗口恢复后不丢认亲依据。
                    childId: update.childId,
                    updatedBy: 'agent',
                });
                statuses.splice(0, statuses.length, ...next);
            }
            catch {
                /* 非法 WAL 行跳过：与主回放裸 catch 同纪律，不拖垮重建。 */
            }
        }
    }
    catch {
        /* WAL 读取失败不影响重建：user/message 通道仍是权威。 */
    }
    /*
     * [3.0.6][复审修复] 僵尸 in_progress 回收：派发中途进程死亡 → 重启 → 回放
     * 重建出的行永远停在「正在做」，但没有任何存活 dispatchPromise 在调度它们
     * （canResumePlan 又只对 executing 放行，结果只能人工逐行改判）。重建路径
     * 天然不存在运行期派发，因此把残留的 in_progress 降级为 blocked：
     * 既有 resetBlockedStatuses/dispatch 路径即可正常接管续跑。行级 error 沿用
     * 本文件 settleStaleInflight（1.8.4）的同款收束写法：保留原说明、缺说明补
     * 一句人话；另往快照 errors 追加一条计划级留痕。运行期 in_progress 不在此
     * 误伤——那条路由 serialisePlan 的存活信号（dispatchPromise/turnEnded）收敛。
     *
     * 只收「还可能被派发」的计划：cancelled/superseded 的行状态是历史留痕
     * （workplan-255-cancel-replay R2 钉住取消后行状态原样回放），不做改写。
     * resultSeen 不豁免——暂停在中途的计划（结果消息已写、行停在 in_progress）
     * 恰恰是事故本体；而真正收尾的计划行全 done，本循环自然空转。
     */
    const ZOMBIE_INFLIGHT_ERROR = '重启后失联：派发中断，需重新派发';
    const zombieRecoveryApplies = !chosen.cancelled && !chosen.superseded;
    let zombieRecovered = 0;
    if (zombieRecoveryApplies) {
        for (const row of statuses) {
            if (row?.status !== 'in_progress')
                continue;
            /*
             * [3.1.7][P0 U-50 / P2 U-16] 僵尸回收不再裸写 status。
             *
             * 旧实现只把 status 改成 blocked，留下 closure='instructed'（或 assigned/
             * acknowledged）与空 finishedAt、revision 不变 ⇒ 产生「blocked + instructed」
             * 的非法组合：readySubtasks 只选 pending，resetBlockedStatuses 又跳过
             * instructed，于是这一行既不能调度也不能续跑，永久卡死（U-50）。
             * 这里补齐闭环投影：closure='blocked'、blockedKind='failed'、finishedAt、
             * revision+1、updatedBy='system'，与 applyStatus 的 blocked 分支同口径。
             * 待指示（escalated）行保留原 closure —— 那是真实的人工等待，不是僵尸。
             */
            row.status = 'blocked';
            if (row.closure !== 'escalated') {
                row.closure = 'blocked';
                row.blockedKind = 'failed';
            }
            /*
             * [3.1.7][P0 U-50 补正] finishedAt 缺失判定必须排除 null。
             * Number(null) === 0 且 Number.isFinite(0) === true，旧写法
             * `!Number.isFinite(Number(row.finishedAt))` 会把 null 当成「已有时间戳」
             * 而跳过补值 ⇒ 僵尸行 finishedAt 永远停在 null（实测复现）。这里改为
             * 「不是有限正数就补当前时间」，与 applyStatus blocked 分支同口径。
             */
            if (typeof row.finishedAt !== 'number' || !Number.isFinite(row.finishedAt) || row.finishedAt <= 0)
                row.finishedAt = Date.now();
            row.revision = Number(row.revision ?? 0) + 1;
            row.updatedBy = 'system';
            if (typeof row.error !== 'string' || row.error.trim() === '')
                row.error = ZOMBIE_INFLIGHT_ERROR;
            zombieRecovered += 1;
        }
    }
    if (zombieRecovered > 0) {
        console.warn(`[dsh-workplan] 回放回收 ${zombieRecovered} 条僵尸 in_progress 行`
            + `（计划 ${String(plan.planId)}，派发中断后进程重启）：已降级为 blocked，重新派发即可续跑。`);
        chosen.errors = [...(chosen.errors ?? []),
            `${ZOMBIE_INFLIGHT_ERROR}（${zombieRecovered} 项已降级为 blocked，可重新派发续跑）`].slice(-20);
    }
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
        /* [3.0.8] 主 Agent 开工证据随回放回到记录（续跑读档放行）。 */
        mainStartPhases: chosen.mainStartPhases ?? null,
        mainStartPhasesPlanId: chosen.mainStartPhasesPlanId ?? null,
        /* [3.0.1] 认可闸门随重建记录还原：重启后 dispatch 闸门与审计留痕不失效。
         * 直接属性而非条件展开——条件展开会破坏返回字面量的判别收窄
         * （rebuilt.plan 的 null/对象判别失效，resumeLimit 访问报 union 错）。 */
        dispatchHold: chosen.dispatchHold ?? null,
        gateHistory: Array.isArray(chosen.gateHistory) ? chosen.gateHistory : [],
        /*
         * [1.8.17] A reconstructed record must carry every field the live dispatch
         * path spreads/pushes unconditionally. `errors` was the one that was
         * missing; its absence turned a recoverable child failure into a round
         * abort that marked the rest of the plan blocked.
         */
        errors: (chosen.errors ?? []).slice(-20),
        // [2.5.7] 与 serialisePlan/status 输出同口径：优先读档内 resumeLimit，
        // 缺失才回落 MAX_PLAN_RESUMES（三源统一，消除第四套口径）。
        resumeLimit: Number(chosen?.resumeLimit ?? MAX_PLAN_RESUMES),
        resumeAvailable: canResumePlan({ phase, statuses, resumeCount }, Number(chosen?.resumeLimit ?? MAX_PLAN_RESUMES)).resume,
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
         * [2.2.9][T3][M4.2] 重建记录必须带 `resultWritten`。
         *
         * 事故实证（wp-215ed52f 症状②第三拍）：pre-step 回报自愈的条件是
         * `reportPending && resultWritten`，而重建对象从不携带该字段（恒
         * undefined）→ 条件永不成立 → 重启后派生出的「未回报」态永远无法
         * 自愈，只能靠幂等复核+人工改判收敛——这正是「震荡三次」的机制解释。
         * durable 会话里存在本轮结果消息（resultSeen）就是「已写入」的事实，
         * 用它补齐后自愈在重建态可达：重启 → reportPending 派生 true →
         * pre-step 幂等 markReported → 门禁一次收敛。
         */
        resultWritten: resultSeen,
        // [2.2.9][T3][M4.1] 派生口径与门禁/看板/冻结单源（deriveReportPending）。
        reportPending: deriveReportPending({ statuses }),
        /*
         * [3.1.7][P2 U-40] 幂等哨兵随重建记录还原（见回放循环内的识别逻辑）：
         * 重启后同一份计划不再重复刷「任务已经完成分配」与「派发预告」。
         */
        assignedNoticeKey: chosen.assignedNoticeKey ?? null,
        preAnnouncedPlanId: chosen.preAnnouncedPlanId ?? null,
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
/**
 * 响应超限时逐级收缩：先减会话数，再丢单会话的大块明细，最后只留摘要。
 * 任何一级都返回**合法 JSON**；宁可少给字段，也不返回半截字符串。
 */
export function trimPlansPayload(payload) {
    const fits = (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_PLANS_RESPONSE_BYTES;
    if (fits(payload))
        return payload;
    const original = Array.isArray(payload?.sessions) ? payload.sessions.slice() : [];
    let sessions = original.slice();
    let trimmed = { ...payload, truncated: true, sessions };
    while (!fits(trimmed) && sessions.length > 1) {
        sessions = sessions.slice(0, Math.max(1, Math.ceil(sessions.length / 2)));
        trimmed = { ...trimmed, sessions };
    }
    if (!fits(trimmed)) {
        sessions = sessions.map((item) => ({
            sessionId: item.sessionId,
            planId: item.planId,
            title: typeof item.title === 'string' ? truncate(item.title, 200) : item.title,
            phase: item.phase,
            suspendedPhase: item.suspendedPhase,
            endedAt: item.endedAt,
            stats: item.stats,
            departments: item.departments,
            statuses: Array.isArray(item.statuses) ? item.statuses.slice(-50) : [],
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            running: item.running,
            deliveryReady: item.deliveryReady,
            plan: item.plan ? { planId: item.plan.planId, title: item.plan.title } : null,
            omittedDetail: true,
        }));
        trimmed = { ...trimmed, sessions };
    }
    if (!fits(trimmed)) {
        trimmed = {
            ...trimmed,
            sessions: sessions.map((item) => ({
                sessionId: item.sessionId,
                planId: item.planId,
                title: typeof item.title === 'string' ? truncate(item.title, 120) : item.title,
                phase: item.phase,
                omittedDetail: true,
            })),
        };
    }
    // 极端情况（例如单条 title 本身就巨大）：只保留会话计数，保证响应仍是合法 JSON。
    if (!fits(trimmed)) {
        trimmed = {
            ...trimmed,
            sessions: [],
            omittedSessions: original.length,
        };
    }
    return trimmed;
}
export function createWorkplanRuntime(ctx, options = {}) {
    /*
     * `activeTurns` maps a root session to the turn whose user message carried a
     * real task; the `agent/turn-stopping` gate only objects on those turns.
     */
    const state = { records: new Map(), activeTurns: new Map() };
    /*
     * [3.1.8][P1 D5] 第三层静默死亡巡检：只在本进程真的有 running 成员时启动，
     * 每 120s 走一次与 status/delegate 同源的读时收敛；没有 running 就停表。
     * unref 保证巡检不吊住进程；dispose 会清掉。
     */
    let delegateSweepTimer = null;
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
        // [1.12.0] 默认开启：仅显式 `autoResume:false`（或
        // `DSH_WORKPLAN_AUTO_RESUME=0`）才关闭，与 `AUTO_RESUME_DEFAULTS.enabled=true` 一致。
        autoResume: {
            enabled: options.autoResume !== false,
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
        // [2.5.5][T6] payload.agent 缺失时按 session.id 兜底解析活体 agent，
        // 避免宿主 spec.parent.id 毫秒级崩溃（自动派发与工具路径同病实测）。
        agent = agent ?? resolveLiveAgent(ctx, session?.id);
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
        /*
         * [3.0.6][第 3 批①] 复用同一 record 再派发时清零等待耗尽标记：否则 auto-resume/
         * continue/重派之后，onTurnStopping 会把下一回合按"已耗尽"零预算秒放行，
         * 且 waitExhaustedNotifiedTurn 只按 turn 去重，导致每回合误发 ⏳ 上限通知。
         */
        record.turnWaitExhausted = undefined;
        record.waitExhaustedNotifiedTurn = undefined;
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
             *
             * [2.2.9][T3][M4.1/M4.2] 判定改读派生谓词 `deriveReportPending`：live
             * 记录的标志只是审计镜像，自愈若读镜像，镜像过期时该自愈的不自愈、
             * 不该自愈的白跑一遍。配合重建对象补上的 `resultWritten`（M4.2，
             * 此前该字段在重建态恒 undefined、条件永不成立，自愈对重启后的会话
             * 形同虚设——「震荡三次靠人工收敛」的第三拍），重启 → 派生 true →
             * 首个 pre-step 幂等 markReported → 门禁一次收敛，无需人工改判。
             */
            const session = payload.agent?.session;
            const known = session ? state.records.get(session.id) : null;
            if (known?.plan && deriveReportPending(known) && known.resultWritten === true) {
                const changed = markReported(known, session, `${known.plan.planId}:${known.dispatchedAt ?? 0}`);
                if (changed > 0) {
                    known.reportPending = deriveReportPending(known);
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
    function recordTimeNotice(record, subtaskId, notice, session) {
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
        /*
         * [2.3.0][T1] 预估上报 → 告知用户（用户要求 1 的前半段闭环）：专家的开工
         * 预告落档后，插件立即向主会话推送一条即时通知，明确「请把此预期执行
         * 时间告知用户」；新预告覆盖旧预告（每条新预告各通知一次，与「开工预告」
         * 协议一致）。通知是观测设施：写失败只留档 errors，绝不影响记录与执行。
         */
        if (session) {
            try {
                appendUserMessage(session, `【dsh-workplan·专家预估上报】子任务 ${subtaskId} 的执行专家`
                    + `预估执行时间 ${Number(notice?.declaredMinutes)} 分钟`
                    + (reason ? `（${reason}）` : '')
                    + '；请把此预期执行时间告知用户。预估仅供参考、非承诺，不会形成执行截止、超时接管或完成验收门槛。', undefined, { allowBanned: true });
            }
            catch (error) {
                record.errors = [...(record.errors ?? []), `${subtaskId} 预估上报通知写入失败：${truncate(String(error?.message ?? error), 200)}`].slice(-20);
            }
        }
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
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                error: `extendMs 必须是正整数毫秒：${String(extendMsArg)}`,
                hint: '请传入 1 以上的整数毫秒；放宽永远有界（累计 ≤ 初始协商上限 × 1），超出请转新轮续跑或转 escalate 请主 Agent 裁决。',
            };
        }
        if (hasExtend) {
            return {
                ok: false,
                code: 'TIME_LIMITS_DISABLED',
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                error: '部门负责人与全球顶尖专家执行已取消时限，无需也不能申请延期；当前任务会继续等待真实完成、真实错误或用户取消。',
                hint: '请移除 extendMs，直接继续执行；如需汇报预估变化，只传 timeNotice（纯信息，不影响验收）。',
            };
        }
        /*
         * [SCv2-T4][Q1-B/C05/C06] extendMs 用户批准闸（判据 v2 生效计划专用）：
         * 第一次超时不再自动放宽——未携带合格用户批准留痕（criterionApproval）一律
         * 拒绝（EXTEND_NEEDS_USER_APPROVAL），批准时间晚于当前时刻 likewise 拒绝
         * （C-4 推荐 A：批准仅在本次尝试结算前有效，事后追认无效）。
         * 未生效计划（历史/在途，Q5-A/D-1）保持 2.3.0 旧行为，既有回归零改动。
         * 留痕 5 项：任务 ID（subtaskId）、批准原文/来源（reason/source）、批准时间
         * （at）、放宽后分钟数（extendedMinutes，事务内回填）、适用范围（scope）。
         */
        const criterionActive = criterionV2Active(record.plan?.createdAt);
        let criterionApproval = null;
        if (hasExtend && criterionActive) {
            criterionApproval = sanitizeCriterionException(args?.criterionApproval);
            if (!criterionApproval) {
                return {
                    ok: false,
                    code: 'EXTEND_NEEDS_USER_APPROVAL',
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    error: '判据 v2 已对该计划生效：extendMs 放宽必须先取得用户明确批准并留痕（Q1-B），本次调用未携带合格的 criterionApproval。',
                    hint: '请先向用户申请例外批准，再随 extendMs 传 criterionApproval={ approvedBy:"user", at:<批准时间 epoch 毫秒>, reason:<批准原文/来源>, scope:"task"|"plan" }（5 项留痕：任务 ID、批准原文/来源、批准时间、放宽后分钟数、适用范围；无留痕＝未批准）。未获批准时不得放宽：按判据层未达标处理，用 dsh_workplan_replan(replace) 转接替子任务只补缺口。',
                };
            }
            if (criterionApproval.at > Date.now()) {
                return {
                    ok: false,
                    code: 'EXTEND_APPROVAL_INVALID_TIME',
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    error: `criterionApproval.at（${criterionApproval.at}）晚于当前时刻：批准必须在本次尝试结算前取得，事后追认无效（C-4 推荐 A）。`,
                    hint: '请使用用户实际批准的时间（epoch 毫秒，Asia/Shanghai 展示）；结算后只能批准接替行，不能追改本次判定。',
                };
            }
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
                    planCreatedAt: record.plan?.createdAt,
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
                planCreatedAt: record.plan?.createdAt,
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
                planCreatedAt: record.plan?.createdAt,
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
                planCreatedAt: record.plan?.createdAt,
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
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    error: '该子任务不在待指示状态，不需要 instruction；普通受阻请直接改判。',
                };
            }
            if (status !== 'in_progress') {
                return {
                    ok: false,
                    code: 'INSTRUCTION_REQUIRES_IN_PROGRESS',
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
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
                recordTimeNotice(record, subtaskId, timeNoticeArg, session);
            return instructed;
        }
        if (current?.closure === 'escalated') {
            if (status === 'done') {
                return {
                    ok: false,
                    code: 'ESCALATION_OPEN',
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    error: '该子任务仍在等待指示，不能直接改判 done：请先给出 instruction，或明确改判 blocked 放弃。',
                };
            }
            if (status === 'in_progress') {
                return {
                    ok: false,
                    code: 'INSTRUCTION_REQUIRED',
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    error: '该子任务正在等待指示：恢复推进必须传 instruction（或调用 dsh_workplan_instruct），不能只改 status。',
                };
            }
            /*
             * [3.1.7][P2 U-14] 「先 blocked 再 done」两步绕过封死。
             *
             * 旧实现只拦 escalated→done / escalated→in_progress，却放行
             * escalated→blocked（文案甚至主动建议「明确改判 blocked 放弃」）。
             * 于是主 Agent 可以先写 blocked（请示被静默放弃、question/options 清空），
             * 再写 done——一条从未被回答的请示就这样被洗成「已完成」，与
             * ALREADY_DONE/ESCALATION_OPEN 的保护意图不对称（T7 W3-02）。
             *
             * 现在：escalated 行改判 blocked 必须显式携带放弃理由（args.reason 或
             * args.summary 非空），把「放弃请示」变成一次有留痕的裁决而不是顺手
             * 一跳；放弃后该行 closure=blocked、question 清空，后续 done 是正常
             * 的 blocked→done 裁决，审计链上能看到「为什么放弃」。不带理由的
             * blocked 改判一律拒绝，两步绕过的第一步就此封死。
             */
            if (status === 'blocked') {
                const abandonReason = typeof args?.reason === 'string' && args.reason.trim()
                    ? args.reason.trim()
                    : (typeof args?.summary === 'string' && args.summary.trim() ? args.summary.trim() : '');
                if (!abandonReason) {
                    return {
                        ok: false,
                        code: 'ESCALATION_ABANDON_REASON_REQUIRED',
                        planId: record.plan.planId,
                        planCreatedAt: record.plan?.createdAt,
                        subtaskId,
                        error: '该子任务正在等待指示：改判 blocked 等于放弃这条请示，必须显式给出放弃理由（reason 或 summary 非空），不能静默跳成 blocked 后再改 done。恢复推进请传 instruction（或调用 dsh_workplan_instruct）。',
                    };
                }
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
                    planCreatedAt: record.plan?.createdAt,
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
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    error: extended.error,
                    hint: extended.hint,
                };
            }
            extension = extended;
            /*
             * [SCv2-T4][Q1-B/C08] 批准留痕落行（criterionException，最终定名）：
             * 放宽后分钟数由本次 extendMs 回填；timeJournal 追加 action:'criterion-exception'
             * 审计条目。回放白名单已追加 criterionException，刷新/重启不丢批准记录。
             */
            if (criterionActive && criterionApproval) {
                const extendRow = record.statuses.find((item) => item?.subtaskId === subtaskId);
                if (extendRow) {
                    extendRow.criterionException = {
                        ...criterionApproval,
                        extendedMs: extendMsArg,
                        extendedMinutes: Math.round((extendMsArg / 60000) * 100) / 100,
                    };
                    const approvalJournal = Array.isArray(extendRow.timeJournal) ? extendRow.timeJournal : [];
                    approvalJournal.push({
                        at: Date.now(),
                        action: 'criterion-exception',
                        by: 'user',
                        extendMs: extendMsArg,
                        scope: criterionApproval.scope,
                        reason: truncate(criterionApproval.reason, 300),
                    });
                    extendRow.timeJournal = approvalJournal.slice(-20);
                }
            }
            /*
             * [2.3.0][T1] 用户要求 1 后半段：放宽成功后必须把「最新执行时间」告知
             * 专家，同时附「必须在保证工作质量的前提下高效率执行」硬要求，让专家
             * 有准备（收到通知继续当前工作，不重新开始）。投递失败不回滚延期——
             * 时限已经推移，只是告知通道未达：留档 errors，回执带 childNotified
             * 供主 Agent 决定是否用 dsh_workplan_followup 补发。
             */
            extension.childNotified = (await notifyExpertOfExtension(ctx, agent, record, subtaskId, extension.deadlineAt)).ok;
        }
        if (!statusRequested) {
            if (hasTimeNotice)
                recordTimeNotice(record, subtaskId, timeNoticeArg, session);
            /*
             * 纯时限事务到此结束。方案 §2.2 效果 3：状态行 revision +1（延期/预告也是
             * 行变更，同样受 STALE_WRITE 乐观锁保护）；状态与判定一个字段都不改。
             *
             * [3.1.7][P2 U-20] 收口第 4 条旁路：旧实现直接 `row.revision = …`、
             * `row.updatedBy = 'agent'` 裸写行对象，绕过 applyStatus 这个自称唯一的
             * 写入口（T3 X-01 四条旁路之一）。现在改走 applyStatus 的纯抬号 patch
             * （不带 status/closure，只带 revision/updatedBy），让所有行变更都经过
             * 同一道消毒与不变量校验；语义完全不变（状态与判定一个字段都不改）。
             */
            record.statuses = applyStatus(record.statuses, subtaskId, {
                revision: Number(current?.revision ?? 0) + 1,
                updatedBy: 'agent',
            });
            record.updatedAt = Date.now();
            const snapshot = derivePlanSnapshot(record.statuses);
            const written = snapshot.statuses.find((item) => item.subtaskId === subtaskId);
            const readiness = readinessOf(record, snapshot);
            return {
                ok: true,
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                status: written?.status ?? current?.status ?? null,
                revision: written?.revision ?? Number(current?.revision ?? 0),
                updatedBy: written?.updatedBy ?? 'agent',
                ...(extension
                    ? {
                        deadlineAt: extension.deadlineAt,
                        timerRearmed: extension.timerRearmed,
                        watchdogRearmed: extension.watchdogRearmed,
                        childNotified: extension.childNotified === true,
                    }
                    : {}),
                ...(hasTimeNotice ? { timeNotice: written?.timeNotice ?? null } : {}),
                // [SCv2-T4] 批准留痕随纯时限事务回执下发（仅生效计划且本次携带批准时）。
                ...(criterionActive && criterionApproval ? { criterionException: written?.criterionException ?? null } : {}),
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
        /*
         * [SCv2-T4][Q1-B/S-Q1-3] 人工改判 done 的判据闸（仅生效计划）：
         * 未达标且无用户批准 ⇒ CRITERION_UNMET 拒绝（不得以 done 收尾）；
         * 随调用携带 criterionApproval 或行上已有有效批准 ⇒ 记例外后放行。
         * 这是「复核改判」恢复路径的判据边界：恢复也必须经用户批准留痕。
         */
        let manualCriterionFields = null;
        if (status === 'done' && criterionActive) {
            const settledAt = Date.now();
            let leaderForCriterion = null;
            try {
                leaderForCriterion = deriveLeaderEstimate(current);
            }
            catch {
                leaderForCriterion = null;
            }
            const exAnte = criterionExAnte(current, leaderForCriterion);
            const approval = sanitizeCriterionException(args?.criterionApproval)
                ?? sanitizeCriterionException(current?.criterionException);
            const evaluation = evaluateCriterion({
                exAnteMinutes: exAnte.minutes,
                exAnteComplete: exAnte.complete,
                wallClockMs: attemptWallClockMsOf({ startedAt: current?.startedAt, finishedAt: current?.finishedAt ?? settledAt }),
                exception: approval,
                settledAt,
            });
            if (!evaluation.canBeDone) {
                return {
                    ok: false,
                    code: 'CRITERION_UNMET',
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    criterionResult: evaluation.criterionResult,
                    reasons: evaluation.reasons,
                    error: `判据层未达标（criterion-overrun），不得以 done 收尾：${evaluation.reasons.join('；')}`,
                    hint: '唯一例外＝用户明确批准并留痕：向用户申请后随本次调用传 criterionApproval={ approvedBy:"user", at, reason, scope }；或改用 dsh_workplan_replan(replace) 生成接替子任务只补缺口（已完成产物只读保护）。',
                };
            }
            manualCriterionFields = {
                criterionResult: evaluation.criterionResult,
                ...(approval && evaluation.exceptionRecorded ? { criterionException: approval } : {}),
            };
        }
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
         * [2.3.0][T1] 禁止丢弃已完成部分（A4 的第二个硬编码保护点）：接手行
         * （takeoverRequired）后续任何一次 artifacts 写入，都把 takeoverBrief 登记
         * 的保护产物并集合并回来——只增不减，主 Agent 改判时不可能删掉专家已完成
         * 的产物清单，只能在其基础上补缺口。
         */
        if (args?.artifacts !== undefined) {
            const protectedRow = record.statuses.find((item) => item?.subtaskId === subtaskId);
            if (protectedRow?.takeoverRequired === true && Array.isArray(protectedRow?.takeoverBrief?.landedRefs)
                && protectedRow.takeoverBrief.landedRefs.length > 0) {
                protectedRow.artifacts = mergePreservedArtifacts(protectedRow.artifacts, protectedRow.takeoverBrief.landedRefs);
            }
        }
        /*
         * [2.2.0][T5/O-4c] 带 status 的调用同时带 timeNotice 时，预告记录在改判落行
         * 之后写入：applyStatus 抛错（如非法 verification）时不会留下半写的预告。
         */
        if (hasTimeNotice)
            recordTimeNotice(record, subtaskId, timeNoticeArg, session);
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
                planCreatedAt: record.plan?.createdAt,
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
                // [T7] C1 白名单：仅四态（开始/完成/受阻/待指示）注入一行关键进度；
                // instructed（指示已下发恢复执行）等过程改判文本置空。标题取自计划
                // 定义（渲染输入，不进 durable 载荷）。
                keyProgress: writtenRow?.closure === 'escalated'
                    || (['in_progress', 'done', 'blocked'].includes(String(status)) && writtenRow?.closure !== 'instructed'),
                title: flattenSubtasks(record.plan).find((entry) => entry.subtask?.id === subtaskId)?.subtask?.title,
            }));
            /*
             * [2.2.9][T3][M4] 人工改判的这条 durable update 消息本身就是「完成已
             * 回报」的会话证据（主 Agent 亲笔写进会话日志），落盘成功后立即闭环
             * closure done→reported，否则派生闸会把改判行当成未回报而永久拦死
             * ——改判→present 是主 Agent 的正常工作流（wp-215ed52f T5/R1-1 实证）。
             * append 失败时不进此支：行留在 closure:'done'，门禁 fail-closed，
             * 绝不留下无证据的已回报（与 finishRound 同一铁律）。回放侧对
             * status:'done' 的改判消息做同样的升级（见 reconstructFromSession），
             * live 与重建在同一份日志上逐行同判——W2 分叉就此封死。
             */
            if (status === 'done') {
                markReported(record, session, `${record.plan.planId}:${record.dispatchedAt ?? 0}`, subtaskId);
            }
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
            planCreatedAt: record.plan?.createdAt,
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
                planCreatedAt: record.plan?.createdAt,
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
            /*
             * [3.1.7][P2 U-12] 取消全 done 计划不再「直写 phase=done 就返回」。
             *
             * 旧实现绕过 reconcilePhase 与回报门禁：行可能停在 closure:'done'
             * （完成但结果消息还没写），reportPending=true，交付门仍有 blocker，
             * 而 cancel 却宣称 phase=done——「已完成」与「不可交付」同屏（T9 R-3-02
             * 实证：取消前后 reportPending 恒 true、行 closure 不动）。
             *
             * 现在：no-op 仍保持 done（不产生「100% + 已取消」），但先走与
             * finishRound 同口径的收敛——markReported 幂等补齐已回报事实，再经
             * reconcilePhase 出口对账。回报标记只在该行确实已有 durable 完成证据
             * （status=done）时写，与 finishRound 的轮级补齐同一铁律；写入失败
             * 不改变 no-op 结论，但如实把 reportPending 带进返回体，让调用方知道
             * 「完成 ≠ 已可交付」。
             */
            try {
                markReported(record, session, `${record.plan.planId}:${record.dispatchedAt ?? 0}`);
            }
            catch (error) {
                pushRecordError(record, error);
            }
            record.phase = reconcilePhase('done', record.statuses);
            record.updatedAt = Date.now();
            state.records.set(session.id, record);
            /*
             * [3.1.7][P2 U-13] 「取消 no-op 后既取消不掉也接管不了」的出路。
             *
             * 冻结契约（_rerun_20261101/GATE_rule_design.md §6.2 V3）规定全 done
             * 不得 supersede——那是为了避开 reconcilePhase 把「被取代」洗成「完成」，
             * 不能私改。但用户点取消时如果计划恰好全 done，旧实现只回 alreadyDone，
             * 既不落取消记录也不给任何可执行下一步，用户只能干等（T9 R-3-03）。
             *
             * 现在：no-op 结论不变（不产生「100% + 已取消」），但返回体如实带上
             * reportPending 与一条明确 hint——已完成且已回报的计划走正常交付；
             * 若用户确实要放弃这份完成记录，正确路径是 replan(replace) 生成接替
             * 子任务或显式行政处置，而不是反复点取消。把「为什么没反应」和
             * 「下一步做什么」一次说清，死等就此封死。
             */
            const afterSnapshot = derivePlanSnapshot(record.statuses);
            return {
                ok: true,
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                phase: record.phase,
                reason,
                alreadyDone: true,
                abortedRunning: false,
                stats: afterSnapshot.stats,
                reportPending: deriveReportPending(record),
                hint: deriveReportPending(record)
                    ? '计划已全部完成，但仍有行未回报（closure=done）：本次取消是 no-op，不会把完成洗成取消。请先让结果消息落盘（正常收尾会自动补齐），再走交付；不要反复取消。'
                    : '计划已全部完成且已回报：本次取消是 no-op（不产生「100% + 已取消」）。如需交付请走正常交付检查；如确需放弃这份完成记录，请用 dsh_workplan_replan(action=replace) 生成接替子任务，或向用户确认后走行政处置——反复取消不会改变终态。',
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
                planCreatedAt: record.plan?.createdAt,
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
                planCreatedAt: record.plan?.createdAt,
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
            planCreatedAt: record.plan?.createdAt,
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
                // [3.0.6][第 3 批①] 自动续跑同样复用原 record：派发前清零等待耗尽标记（同 startAutoDispatch）。
                record.turnWaitExhausted = undefined;
                record.waitExhaustedNotifiedTurn = undefined;
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
        // [2.2.9][handle-policy] 收束类（T1 报告 R3）：自动续跑计时器是计划走向下一轮的唯一驱动，
        // unref 时裸循环下续跑永不发生、计划静默停摆。clearAutoResumeTimer 在人工派发/状态写入/
        // 取消/指示/dispose/rearm 各路径统一撤销；延时自身有界，不会悬挂宿主。
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
            if (item?.status !== 'done') {
                /*
                 * [3.1.7][P2 U-17] 回报失败必须能定位到行。
                 *
                 * 旧实现只扫 status==='done'：一条 in_progress 却带着 closure:'reported'
                 * 的脏行（历史直写/投影分叉产物）永远不被处理，reportPending 与行级
                 * closure 两套口径各说各话，审计也找不到是哪一行回报失败（T7 W2-04/05）。
                 *
                 * 现在：非 done 但带 reported 投影的行，把矛盾如实记进 record.errors
                 * （带 subtaskId 与当前 status），并把 reportPending 置 true 让门禁
                 * fail-closed——绝不静默跳过。不改写该行状态（那是 U-05 迁移守卫的
                 * 职责），只保证「任何回报矛盾都有留痕、都能被门禁看见」。
                 */
                if (item?.closure === 'reported' || isRecord(item?.report)) {
                    const line = `${String(item?.subtaskId)}: 回报投影矛盾（status=${String(item?.status)} 但 closure/report 显示已回报）——回报失败无法定位到行的缺口已留痕，请人工核对该行`;
                    if (!Array.isArray(record.errors))
                        record.errors = [];
                    if (!record.errors.includes(line))
                        record.errors.push(line);
                    record.errors = record.errors.slice(-20);
                    record.reportPending = true;
                }
                continue;
            }
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
     * [2.2.0][T6/O-1a] 完成即时通知的插件兜底投递器。
     * [T9][用户要求6] 起 wait/async 两模式均启用：部门负责人完成即独立汇报主 Agent。
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
            ? `验收结论：${passed}/${acceptance.length} 通过`
            : '验收结论：0 条验收记录（legacy 未提供结构化验收）';
        const elapsedMs = Number.isFinite(Number(row?.startedAt))
            ? Math.max(0, Date.now() - Number(row.startedAt))
            : 0;
        const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
        const summary = truncate(String(row?.summary ?? '').replace(/\s+/g, ' ').trim(), 160) || '（无摘要）';
        /*
         * [T9][用户要求6/D7] 部门负责人完成 → 主 Agent 即时汇报的文本增强。
         * 行级「完美完成」判据与 deliveryReadiness 的行级口径同源（plan.ts）：
         * verification==='structured' ＋ acceptance 非空 ＋ 每项 result==='pass'
         * ＋ 无 missingArtifacts。达到才允许声称「完美完成」；未达到仍保留结算
         * 通知，但必须显式写明缺口，绝不声称完美（D7）。
         */
        const rowAcceptance = Array.isArray(row?.acceptance) ? row.acceptance : acceptance;
        const missingArtifacts = Array.isArray(row?.missingArtifacts) ? row.missingArtifacts : [];
        const d7Reasons = [];
        if (row?.verification !== 'structured')
            d7Reasons.push(`证据等级为 ${String(row?.verification ?? '缺失')}（需 structured）`);
        if (rowAcceptance.length === 0)
            d7Reasons.push('未提供验收项（acceptance 为空）');
        else if (rowAcceptance.some((item) => item?.result !== 'pass'))
            d7Reasons.push('验收未全部 pass');
        if (missingArtifacts.length > 0) {
            d7Reasons.push(`缺少声明产物：${missingArtifacts.slice(0, 5).map((ref) => truncate(String(ref ?? ''), 80)).join('、')}`);
        }
        const conclusion = d7Reasons.length === 0
            ? `完美完成（验收 ${rowAcceptance.length}/${rowAcceptance.length} 全部 pass，structured）`
            : `未达完美完成判据：${d7Reasons.join('；')}`;
        const acceptanceLines = rowAcceptance.map((item) => `  - ${truncate(String(item?.criterion ?? '未命名验收项').replace(/\s+/g, ' ').trim(), 80)} → ${String(item?.result ?? '缺失')}`);
        const needs = Array.isArray(row?.needs) ? row.needs : [];
        const todoLines = [
            '待主 Agent 执行事项：',
            '  - 核验本行证据与验收结论，处置 needs/待指示（如有）',
            ...needs.map((item) => `  - 跨部门需求：${truncate(needEntryText(item), 300)}`),
            ...missingArtifacts.map((ref) => `  - 缺失产物待补：${truncate(String(ref ?? ''), 200)}`),
            '  - 生效建议：插件源码改动需用户手动重启 dsh web 生效，无需安装；Agent 不得自行重启或安装（D8）',
        ];
        /*
         * [3.0.0][用户要求 11] 部门负责人的汇总报告完成后必须直接交给主 Agent：
         * 完成通知里原样带上 departmentSummary 的 JSON（不经二次概括、不裁剪），
         * 主 Agent 收到即可直接汇总最终成果（用户要求 12）。
         */
        const departmentSummaryBlock = row?.departmentSummary && typeof row.departmentSummary === 'object'
            ? ['部门汇总报告（JSON，直接交给主 Agent）：', JSON.stringify(row.departmentSummary)]
            : [];
        const text = truncate([
            `[dsh-workplan] 子任务 ${String(subtask?.id ?? '')} 已完成并结算：${summary}；${acceptanceCount}；用时 ${elapsed}`,
            conclusion,
            ...(acceptanceLines.length > 0 ? ['逐条验收结论：', ...acceptanceLines] : []),
            ...departmentSummaryBlock,
            ...todoLines,
        ].join('\n'), 4000);
        const ref = `${record?.plan?.planId ?? 'plan'}:${record?.dispatchedAt ?? 0}`;
        /*
         * [T9][T5 冻结契约 §1/§4/§5] head→root 完成留痕 kind='completion'（复用
         * channelJournal 统一入口，不另造通道）。留痕结果与投递结果分开报、绝不
         * 互相掩盖：留痕写失败只 warn＋pushRecordError，不阻塞通知投递与回报标记。
         */
        const journalCompletion = (delivery) => {
            try {
                const artifacts = (Array.isArray(row?.artifacts) ? row.artifacts : [])
                    .map((artifact) => truncate(String(artifact?.ref ?? ''), 200))
                    .filter(Boolean)
                    .slice(0, 20);
                const written = channelJournal({
                    planId: String(record?.plan?.planId ?? ''),
                    subtaskId: String(subtask?.id ?? ''),
                    kind: 'completion',
                    from: { sessionId: String(row?.childId || session.id), role: 'head' },
                    to: { sessionId: String(session.id), role: 'root' },
                    body: text,
                    data: { status: 'done', acceptanceCount: passed, artifacts },
                    delivery,
                });
                if (!written.result?.ok) {
                    ctx.logger?.warn?.(`dsh-workplan: 完成汇报留痕写入失败 ${String(subtask?.id ?? '')}：${String(written.result?.error ?? 'JOURNAL_WRITE_FAILED')}`);
                    pushRecordError(record, `完成汇报留痕写入失败（通知投递结果=${String(delivery?.status ?? 'unknown')}）：${String(written.result?.error ?? 'JOURNAL_WRITE_FAILED')}`);
                }
            }
            catch (error) {
                ctx.logger?.warn?.(`dsh-workplan: 完成汇报留痕写入失败 ${String(subtask?.id ?? '')}：${error instanceof Error ? error.message : String(error)}`);
                pushRecordError(record, `完成汇报留痕写入失败（通知投递结果=${String(delivery?.status ?? 'unknown')}）：${error instanceof Error ? error.message : String(error)}`);
            }
        };
        /*
         * [T7] C1/C2/C3：注入正文裁剪为一行关键进度（ID＋完成状态＋验收计数＋
         * 用时＋D7 结论＋摘要＋needs/缺失产物计数＋下一步）；逐条验收全文与待办
         * 清单只保留在 channelJournal completion 留痕（按需通道：journal／reports
         * 产物／dsh_workplan_status），不再默认注入模型上下文。
         */
        /*
         * [T9][F1/F2] C1 必含字段补齐「子任务标题」；C2 禁止注入回报正文——summary
         * 只保留在 channelJournal completion 留痕与既有全量 text 里，不再拼进模型
         * 可见通知；回报正文里的 <!-- WORKPLAN_EVIDENCE... --> 证据块因此不会进入
         * 上下文（此前 summary 截 160 字仍可能把证据 JSON 头部带进模型可见面）。
         */
        const titleText = truncate(String(subtask?.title ?? '').replace(/\s+/g, ' ').trim(), 60);
        const keyText = capKeyProgressText([
            `【关键进度】${String(subtask?.id ?? '')} 完成`,
            ...(titleText ? [`标题：${titleText}`] : []),
            acceptanceCount,
            `用时 ${elapsed}`,
            truncate(conclusion, 160),
            ...(needs.length > 0 ? [`跨部门需求 ${needs.length} 条待处置（dsh_workplan_handoff list）`] : []),
            ...(missingArtifacts.length > 0 ? [`缺失产物 ${missingArtifacts.length} 项待补`] : []),
            '下一步：主 Agent 核验证据与验收后整合（按需：dsh_workplan_status／结算文件）',
        ].join('｜'));
        try {
            appendUserMessage(session, keyText);
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-workplan: 完成即时通知写入失败 ${String(subtask?.id ?? '')}：`
                + `${error instanceof Error ? error.message : String(error)}`);
            /* [T9][D6] 投递失败显式留 failed 痕（可重试、不静默），维持 reportPending
             * 交 finishRound 补齐——「先写通知后记回报、绝不留无证据已回报」不变。 */
            journalCompletion({ status: 'failed', error: truncate(String(error instanceof Error ? error.message : error), 300) });
            record.reportPending = true;
            return;
        }
        journalCompletion({ status: 'sent' });
        markReported(record, session, ref, subtask?.id);
    }
    /**
     * [T8] 第三层叶子完成即时通知：收件方 = 原分派部门负责人会话。
     *
     * 改动前验证结论（2026-11-12）：两处叶子结算回调（delegateTool dispatch /
     * selfEffortTool 自配档接续）此前只把 durable workplan-update 写到根会话；
     * 负责人会话只能靠宿主 delivery=caller 转达子会话原文，没有插件侧「已结算
     * 为 done」的即时完成汇报，delegates 条目也没有回报幂等标记。负责人会话
     * id 的反查判据：根计划部门行 row.childId（executeSubtask 派发时登记，
     * delegateTool 按 statuses[].childId===负责人会话 id 定位行），与
     * escalateDelegateLeaf 的 headChildId 同一判据。
     *
     * 复用 T5 冻结契约（_t5_channel_20261112/00-contract-v1.md §1/§5）：
     *   - 投递：ctx.subagents.sendMessage（根 agent → row.childId 负责人会话，
     *     宿主 lineage 校验与 instructDelegate/followup 同范式）；辅助
     *     user/message 纯文本通知（appendUserMessage 唯一合规写入器，尽力而为，
     *     不改变投递判定）；
     *   - 留痕：channelJournal kind='completion'，data={status:'done'}，
     *     from 叶子 → to head；
     *   - done-only：只对 delegates[].status==='done' 通知（failed/待指示不产生
     *     「已完成」措辞）；
     *   - 幂等：只有 report.state==='sent' 拦重报（T5 教训：failed 必须可重试）；
     *     先投递、成功才记 sent；
     *   - 兜底：投递失败显式 DELIVERY_FAILED + report.state='failed' +
     *     record.errors 留痕，下一次结算（含其他成员结算）自动补发所有 done
     *     未 sent 条目——与 reportPending「绝不留无证据的已回报」同一纪律；
     *     不触碰主行 closure/deriveReportPending，通知失败绝不回滚或阻塞完成判定。
     * 主计划子任务通知仍 → 根会话（emitSubtaskDoneNotice 不变，T9 范围）。
     */
    /*
     * [T8][race-fix] 并发结算竞态治本（负责人独立审读发现，2026-11-12）：
     * 旧实现在 pending 过滤与 report 标记写回之间隔着 await sendMessage——
     * 8 名下属同一 tick 完成时，回调 A 在 await 处让出事件循环，回调 B 随即
     * 把 m1（尚未写 sent 标记）也视为 pending → 重复投递，击穿「8 人=恰 8 条」；
     * 且各回调用入口捕获的 delegates 快照写回，会互相覆盖对方的结算与标记
     * （lost update）。治本 = 等价串行化：每 record 一条 promise 链（闭包级
     * WeakMap，随 record 生命周期回收，无定时器/认领泄漏），入队在同步段完成
     * （任何 await 之前）；链节内「读最新台账 → 投递 → 写标记」整段互斥，
     * 上一节完全结束才跑下一节；异常在节内捕获，链永不断裂。failed 天然可重试
     * （无认领，state!=='sent' 即补发）。
     */
    const delegateNoticeChains = new WeakMap();
    const delegateNoticeKey = (item) => `${String(item?.childId ?? '')}|${String(item?.member ?? '')}`;
    function emitDelegateDoneNotices(record, leaderSession, rootSession, subtaskId) {
        if (!record || !leaderSession)
            return Promise.resolve();
        const prior = delegateNoticeChains.get(record) ?? Promise.resolve();
        const task = prior
            .then(() => deliverDelegateDoneNotices(record, leaderSession, rootSession, subtaskId))
            .catch((error) => {
            // 意外异常只留痕：链不得断裂，也不得影响结算判定。
            try {
                ctx.logger?.warn?.(`dsh-workplan: 第三层完成通知链节异常 ${subtaskId}：${error instanceof Error ? error.message : String(error)}`);
                record.errors = [...(record.errors ?? []), `${subtaskId} 完成通知链节异常：${truncate(String(error instanceof Error ? error.message : error), 200)}`].slice(-20);
            }
            catch { /* 留痕失败不影响主链路 */ }
        });
        delegateNoticeChains.set(record, task);
        return task;
    }
    async function deliverDelegateDoneNotices(record, leaderSession, rootSession, subtaskId) {
        if (!record || !leaderSession)
            return;
        const row = Array.isArray(record.statuses)
            ? record.statuses.find((item) => item?.subtaskId === subtaskId)
            : null;
        const delegates = Array.isArray(row?.delegates) ? row.delegates : [];
        const pending = delegates.filter((item) => item?.status === 'done' && item?.report?.state !== 'sent');
        if (pending.length === 0)
            return;
        const headChildId = typeof row?.childId === 'string' && row.childId ? row.childId : String(leaderSession?.id ?? '');
        const service = ctx.subagents;
        /*
         * 发送者必须是根会话 agent：负责人会话是根会话的直接子会话，宿主 lineage
         * 校验只允许父→子投递（instructDelegate 同范式）。结算回调闭包里的 agent
         * 是负责人自己（delegateTool 调用者），不能作发送者。解析失败 fail-closed
         * 记 failed，绝不静默跳过。
         */
        const rootAgent = resolveLiveAgent(ctx, rootSession?.id);
        const rawTurn = Number(state.activeTurns?.get?.(leaderSession?.id) ?? NaN);
        const turn = Number.isFinite(rawTurn) ? rawTurn : null;
        const ref = `${record?.plan?.planId ?? 'plan'}:${record?.dispatchedAt ?? 0}`;
        const marks = new Map();
        for (const member of pending) {
            const startedAt = Number(member?.startedAt);
            const finishedAt = Number(member?.finishedAt);
            const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? Math.max(0, finishedAt - startedAt) : 0;
            const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
            const summary = truncate(String(member?.summary ?? '').replace(/\s+/g, ' ').trim(), 300) || '（无摘要）';
            const body = truncate([
                `【第三层完成汇报｜${String(member?.member ?? '')} → 部门负责人】`,
                `子任务 ${subtaskId} 的第三层成员 ${String(member?.member ?? '')} 已完成并结算（status=done）。`,
                `摘要：${summary}`,
                `用时：${elapsed}`,
                '请核验并汇总该成员产物；收齐后写最终结果块。',
            ].join('\n'), 4000);
            const deliveryStartedAt = Date.now();
            let messageId = '';
            let deliveryError = '';
            if (!headChildId)
                deliveryError = '部门行没有登记负责人会话（childId 缺失），无法投递完成汇报';
            else if (!service || typeof service.sendMessage !== 'function')
                deliveryError = '当前部署没有可用的 subagent 服务（NO_SUBAGENT_SERVICE），无法投递完成汇报';
            else if (!rootAgent)
                deliveryError = '根会话 agent 解析失败，无法向负责人会话投递完成汇报';
            else {
                try {
                    messageId = String(await service.sendMessage(rootAgent, headChildId, [{ type: 'text', text: body }], { signal: new AbortController().signal }) ?? ''); // [T11] 缺陷②：完成汇报携带有效 signal，消除 throwIfAborted
                }
                catch (error) {
                    deliveryError = truncate(error instanceof Error ? error.message : String(error), 500);
                }
            }
            const delivery = deliveryError ? 'failed' : 'sent';
            const journal = channelJournal({
                planId: String(record?.plan?.planId ?? ''),
                subtaskId,
                kind: 'completion',
                from: { sessionId: String(member?.childId ?? ''), role: 'expert', member: String(member?.member ?? '') },
                to: { sessionId: headChildId, role: 'head' },
                body,
                data: { status: 'done' },
                delivery: { status: delivery, ...(messageId ? { messageId } : {}), latencyMs: Date.now() - deliveryStartedAt, ...(deliveryError ? { code: 'DELIVERY_FAILED', error: deliveryError } : {}) },
            });
            // 契约 §4：留痕写失败本身也要显式报 JOURNAL_WRITE_FAILED，且不得掩盖投递结果。
            if (!journal.result.ok) {
                record.errors = [...(record.errors ?? []), `${subtaskId}/${String(member?.member ?? '')} 完成留痕写入失败 JOURNAL_WRITE_FAILED：${truncate(String(journal.result.error ?? ''), 200)}`].slice(-20);
            }
            // 辅助用户可见纯文本通知（user/message 通道，尽力而为）：不替代 sendMessage 投递，不改变投递判定。
            /*
             * [3.1.7][P3 U-29/U-31] 第二路不再重发摘要正文。
             *
             * 旧实现把同一份成员摘要（≤160 字）在 sendMessage 正文之外又经
             * appendUserMessage 注入一遍（T4 A06：两路投递、内容同源）。现在
             * 第二路只留一行「谁完成了哪一项 + 用时 + 去哪看详情」的指针，摘要
             * 正文只在 sendMessage 那一路出现一次；关键串「已完成并结算」保活
             * （守门测试钉住），负责人仍能在会话里看到完成事实，但不再为同一
             * 摘要付两遍 token。
             */
            if (typeof leaderSession.append === 'function') {
                try {
                    appendUserMessage(leaderSession, `[dsh-workplan] 第三层成员 ${String(member?.member ?? '')}（子任务 ${subtaskId}）已完成并结算；用时 ${elapsed}。摘要与证据见完成汇报消息，请核验并汇总该成员产物。`);
                }
                catch (error) {
                    ctx.logger?.warn?.(`dsh-workplan: 第三层完成纯文本通知写入失败 ${subtaskId}/${String(member?.member ?? '')}：${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (deliveryError) {
                ctx.logger?.warn?.(`dsh-workplan: 第三层完成即时通知投递失败 ${subtaskId}/${String(member?.member ?? '')}：DELIVERY_FAILED ${deliveryError}`);
                record.errors = [...(record.errors ?? []), `${subtaskId}/${String(member?.member ?? '')} 完成即时通知投递失败 DELIVERY_FAILED（report.state=failed，待兜底补发）：${truncate(deliveryError, 200)}`].slice(-20);
            }
            marks.set(delegateNoticeKey(member), { state: delivery, at: Date.now(), ref, turn });
        }
        /*
         * 幂等标记写回台账（applyStatus 唯一写入口 + delegates.report 消毒）并
         * durable 回放到根会话：刷新/重启后「已通知」不丢、重复结算不重报。
         * 标记写失败只留痕：下次结算按 state!=='sent' 补发，不影响结算判定。
         */
        try {
            // [T8][race-fix] 写时重读当前行＋按键贴标记：不用入口快照，对
            // escalate/instruct 等非结算路径的并发写也免疫（不覆盖请示/指示子对象）。
            const currentRow = Array.isArray(record.statuses)
                ? record.statuses.find((item) => item?.subtaskId === subtaskId)
                : null;
            const currentDelegates = Array.isArray(currentRow?.delegates) ? currentRow.delegates : delegates;
            const list = currentDelegates.map((item) => {
                const mark = marks.get(delegateNoticeKey(item));
                return mark ? { ...item, report: mark } : item;
            });
            const revision = Number(currentRow?.revision ?? row?.revision ?? 0) + 1;
            record.statuses = applyStatus(record.statuses, subtaskId, { delegates: list, revision, updatedBy: 'system' });
            record.updatedAt = Date.now();
            const written = record.statuses.find((item) => item?.subtaskId === subtaskId);
            appendUserMessage(rootSession, buildUpdateMessage({
                planId: record?.plan?.planId,
                subtaskId,
                status: written?.status ?? row?.status,
                delegates: written?.delegates ?? list,
                revision,
                note: '第三层成员完成即时通知已回报原分派负责人会话（delegates[].report）',
            }));
        }
        catch (error) {
            record.errors = [...(record.errors ?? []), `${subtaskId} delegates[].report 标记写入失败：${truncate(String(error instanceof Error ? error.message : error), 200)}`].slice(-20);
        }
    }
    const TERMINATION_KIND_LABEL = {
        failed: '失败',
        interrupted: '中断',
        'empty-turn': '空回合',
        reconciled: '对账',
        'settlement-error': '结算异常',
        stalled: '停滞',
    };
    function classifyDelegateTermination(outcome, f10) {
        const stopReason = String(outcome?.stopReason ?? 'unknown');
        const text = resultText(outcome);
        if (stopReason !== 'completed')
            return { kind: 'interrupted', reason: `子会话被外部中断（stopReason=${stopReason}）` };
        if (!text.trim())
            return { kind: 'empty-turn', reason: '回合已结束但没有任何助手正文或结果块（completed-without-text）' };
        return { kind: 'failed', reason: String(f10?.rejection ?? '结果块缺失或 JSON 无法解析') };
    }
    function buildDelegateTerminationBody(kind, member, subtaskId, reason) {
        const head = `【第三层终止·${TERMINATION_KIND_LABEL[kind]}｜${member} → 部门负责人】`;
        const tail = kind === 'stalled'
            ? '本判定基于「120 秒无存活会话、无结束快照」的 fail-closed 规则，不代表任务完成；不会自动重派。'
            : '这是终止通知，不代表任务完成；本判定不含任何超时。';
        if (kind === 'failed') {
            return truncate([head, `子任务 ${subtaskId} 的成员 ${member} 已终止，不是完成：结果块未通过 F10 核验（${truncate(reason, 300)}）。`, '台账已写 failed；请核验其产物后决定重派、补派或按实标记受阻。', tail].join('\n'), 4000);
        }
        if (kind === 'interrupted') {
            return truncate([head, `子任务 ${subtaskId} 的成员 ${member} 已终止：子会话被外部中断（${truncate(reason, 300)}），不是完成，也不会再自行继续。`, '台账已写 failed；请决定重派或补派（原任务书可直接复用）。', tail].join('\n'), 4000);
        }
        if (kind === 'empty-turn') {
            return truncate([head, `子任务 ${subtaskId} 的成员 ${member} 已终止：回合已经结束，但没有任何助手正文或结果块（${truncate(reason, 300)}），专家不会再继续。`, '台账已写 failed；请决定重派或补充说明后重派。', tail].join('\n'), 4000);
        }
        if (kind === 'settlement-error') {
            return truncate([head, `子任务 ${subtaskId} 的成员 ${member} 的结算链发生异常（${truncate(reason, 300)}），台账可能仍为 running，不能视为仍在运行。`, '请人工核对产物后重派或标记受阻。', tail].join('\n'), 4000);
        }
        if (kind === 'stalled') {
            return truncate([head, `子任务 ${subtaskId} 的成员 ${member} 已超过 120 秒没有任何存活会话或结束快照（${truncate(reason, 300)}），判定为停滞：不是完成，也不是普通的结果块不合格。`, '台账已写 failed(stalled)；请核验其已落盘产物后决定重派、补派或按实标记受阻。', tail].join('\n'), 4000);
        }
        return truncate([head, `子任务 ${subtaskId} 的成员 ${member} 的会话已结束（读时对账确认），但结果块未通过核验（${truncate(reason, 300)}）。`, '台账已写 failed；请核验产物后决定重派或按实标记受阻。', tail].join('\n'), 4000);
    }
    function emitDelegateTerminationNotices(record, leaderSession, rootSession, subtaskId, notices) {
        if (!record || !leaderSession || notices.length === 0)
            return Promise.resolve();
        const prior = delegateNoticeChains.get(record) ?? Promise.resolve();
        const task = prior
            .then(() => deliverDelegateTerminationNotices(record, leaderSession, rootSession, subtaskId, notices))
            .catch((error) => {
            try {
                ctx.logger?.warn?.(`dsh-workplan: 第三层终止通知链节异常 ${subtaskId}：${error instanceof Error ? error.message : String(error)}`);
                record.errors = [...(record.errors ?? []), `${subtaskId} 终止通知链节异常：${truncate(String(error instanceof Error ? error.message : error), 200)}`].slice(-20);
            }
            catch { /* 留痕失败不影响主链路 */ }
        });
        delegateNoticeChains.set(record, task);
        return task;
    }
    async function deliverDelegateTerminationNotices(record, leaderSession, rootSession, subtaskId, notices) {
        if (!record || !leaderSession || notices.length === 0)
            return;
        const row = Array.isArray(record.statuses) ? record.statuses.find((item) => item?.subtaskId === subtaskId) : null;
        const delegates = Array.isArray(row?.delegates) ? row.delegates : [];
        const headChildId = typeof row?.childId === 'string' && row.childId ? row.childId : String(leaderSession?.id ?? '');
        const service = ctx.subagents;
        const rootAgent = resolveLiveAgent(ctx, rootSession?.id);
        const ref = `${record?.plan?.planId ?? 'plan'}:${record?.dispatchedAt ?? 0}`;
        const marks = new Map();
        for (const notice of notices) {
            const member = delegates.find((item) => item?.childId === notice.childId);
            if (!member)
                continue;
            if (member.escalation || member.closure === 'escalated')
                continue;
            if (member.status === 'done')
                continue;
            if (member.termination?.state === 'sent' && member.termination?.kind === notice.kind)
                continue;
            const body = buildDelegateTerminationBody(notice.kind, String(member?.member ?? ''), subtaskId, notice.reason);
            let deliveryError = '';
            if (!headChildId)
                deliveryError = '部门行没有登记负责人会话（childId 缺失），无法投递终止通知';
            else if (!service || typeof service.sendMessage !== 'function')
                deliveryError = '当前部署没有可用的 subagent 服务（NO_SUBAGENT_SERVICE），无法投递终止通知';
            else if (!rootAgent)
                deliveryError = '根会话 agent 解析失败，无法向负责人会话投递终止通知';
            else {
                try {
                    await service.sendMessage(rootAgent, headChildId, [{ type: 'text', text: body }], { signal: new AbortController().signal });
                }
                catch (error) {
                    deliveryError = truncate(error instanceof Error ? error.message : String(error), 500);
                }
            }
            const delivery = deliveryError ? 'failed' : 'sent';
            // [缺陷 22 取舍] 部门 journal 的 kind 是 T5 冻结契约（7 种，防漂移测试守着）；
            // 终止通知不硬塞进 completion/escalation 冒充，也不私扩枚举，权威留痕落在
            // delegates[].termination（幂等标记，随台账持久化 + durable 回放）。
            if (deliveryError) {
                ctx.logger?.warn?.(`dsh-workplan: 第三层终止通知投递失败 ${subtaskId}/${String(member?.member ?? '')}：DELIVERY_FAILED ${deliveryError}`);
                record.errors = [...(record.errors ?? []), `${subtaskId}/${String(member?.member ?? '')} 终止通知投递失败 DELIVERY_FAILED（termination.state=failed，待兜底补发）：${truncate(deliveryError, 200)}`].slice(-20);
            }
            marks.set(notice.childId, { kind: notice.kind, state: delivery, at: Date.now(), ref });
            /*
             * [3.1.7][P3 U-29/U-31] 终止通知第二路同样只留指针，不重发 reason 正文
             * （与完成通知同口径）：reason 已在 sendMessage 正文里出现一次，这里
             * 只告知「谁终止了、哪一类、去哪看详情」，关键语义「这是终止，不是在
             * 运行」保活。
             */
            if (typeof leaderSession.append === 'function') {
                try {
                    appendUserMessage(leaderSession, `[dsh-workplan] 第三层成员 ${String(member?.member ?? '')}（子任务 ${subtaskId}）已终止（${TERMINATION_KIND_LABEL[notice.kind]}）。这是终止，不是在运行；原因见终止通知消息，请决定重派或补派。`);
                }
                catch (error) {
                    ctx.logger?.warn?.(`dsh-workplan: 第三层终止纯文本通知写入失败 ${subtaskId}/${String(member?.member ?? '')}：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        if (marks.size === 0)
            return;
        try {
            const currentRow = Array.isArray(record.statuses) ? record.statuses.find((item) => item?.subtaskId === subtaskId) : null;
            const currentDelegates = Array.isArray(currentRow?.delegates) ? currentRow.delegates : delegates;
            const list = currentDelegates.map((item) => {
                const mark = marks.get(String(item?.childId ?? ''));
                return mark ? { ...item, termination: mark } : item;
            });
            const revision = Number(currentRow?.revision ?? 0) + 1;
            record.statuses = applyStatus(record.statuses, subtaskId, { delegates: list, revision, updatedBy: 'system' });
            record.updatedAt = Date.now();
            const written = record.statuses.find((item) => item?.subtaskId === subtaskId);
            appendUserMessage(rootSession, buildUpdateMessage({
                planId: record?.plan?.planId,
                subtaskId,
                status: written?.status ?? row?.status,
                delegates: written?.delegates ?? list,
                revision,
                note: '第三层成员终止通知已投递原分派负责人会话（delegates[].termination）',
            }));
        }
        catch (error) {
            record.errors = [...(record.errors ?? []), `${subtaskId} delegates[].termination 标记写入失败：${truncate(String(error instanceof Error ? error.message : error), 200)}`].slice(-20);
        }
    }
    function finishRound(record, session) {
        /*
         * [2.5.5][T10] 结算前先合并落盘缓冲的台账事件：本轮最后一批非关键更新
         * 不能因为「后面没有别的消息」而滞留内存（刷新/重启即丢）。
         */
        try {
            flushPendingWorkplanUpdates(session);
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-workplan: 合并台账落盘失败：${error instanceof Error ? error.message : String(error)}`);
        }
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
            markReported(record, session, ref);
            const resultMessage = buildRoundResult(record, session.id, limits);
            try {
                appendUserMessage(session, resultMessage);
                record.resultWritten = true;
                /*
                 * [2.2.9][T3][M4] 标志自此只是审计镜像，一律按派生函数回填。
                 * 旧公式 `needReport > 0 && reported < needReport` 自带第三套口径
                 * （把旧日志 closure=null 的行也算待回报），与门禁/重建/自愈使用的
                 * 严格 `closure==='done'` 判据并存——多套判据互不一致正是震荡的
                 * 温床。收敛后镜像与 statuses 事实恒等，任何读取方都对得上。
                 */
                record.reportPending = deriveReportPending(record);
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
                 * [1.11.0] 写失败时不能假装回报过。回滚后镜像同步为回滚事实
                 * （done 行回到 closure:'done' ⇒ 派生 true），交下一次 pre-step
                 * 自愈或下一轮 finishRound 幂等补齐（契约 §7.3 B4）。
                 */
                record.reportPending = deriveReportPending(record);
            }
        }
        else {
            /*
             * [2.2.9][T3][M4] 旧日志 / 上一次写失败的重试：结果消息已在，但仍有
             * 本轮完成、未回报的 done 行（closure==='done'）。幂等补齐，不重复追加
             * 消息。判据与 deriveReportPending（runtime.ts:245 严格口径
             * `status==='done' && closure==='done'`）收敛为同一套：旧日志
             * closure=null 的历史 done 行本来就已回报过，不在此补标。
             */
            const pending = (record.statuses ?? []).some((item) => item?.status === 'done' && item?.closure === 'done');
            if (pending) {
                markReported(record, session, ref);
                // [2.2.9][T3][M4] 镜像按派生回填：部分标记失败时不谎报「已回报」。
                record.reportPending = deriveReportPending(record);
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
        /*
         * [T4][F6] 一致性告警（只告警，不参与 done / deliveryReady 判定）：
         * 部门行已 done 而第三层专家结算 0/N 时，读的人必须知道「产物已验收但
         * 专家未结算」，而不是误以为专家都做完了。
         */
        const warnings = deriveDelegateConsistencyWarnings(snapshot?.statuses);
        return {
            complete: total > 0 && done >= total,
            remaining: Math.max(0, total - done),
            deliveryReady: readiness.ready,
            deliveryBlockers: readiness.blockers.slice(0, 12),
            deliveryRemaining: readiness.remaining.slice(0, 20),
            ...(warnings.length > 0 ? { warnings } : {}),
        };
    }
    function dispatchSnapshotOf(record, extra = {}) {
        const snapshot = derivePlanSnapshot(record.statuses);
        return {
            ok: true,
            version: pluginVersion,
            runtime: runtimeIdentity(),
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
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
    /**
     * [3.1.8][P1 D5] 根会话读状态时的第三层静默死亡收敛。
     *
     * 旧实现只在负责人自己调用 delegate(status/dispatch/direct) 时才对账；负责人
     * 回合结束后没人再调，9 名专家 inactive 也不会有人把 running 收敛、更不会通知
     * 负责人。根会话 status 是用户最常触发的读路径：这里对每个仍有 running 成员的
     * 部门行做一次与 delegateTool 同源的 reconcileEndedDelegateSessions，已确认结束
     * 的收敛为 done/failed 并写 durable，失败项补终止通知。
     *
     * 只收敛「有结束证据」的行：活体会话 turn 已结束、父会话有 subagent-settled
     * 快照，或 childId 已登记但会话已消失且无快照、开工超过 120s（markStalledDelegates）。
     * 其余查不到证据的行保持 running，绝不误杀；停滞条目与正常结算用
     * reconciledAt/reconciledFrom 区分，不自动重派。
     */
    async function reconcileRecordDelegates(record, rootSession) {
        if (!record?.plan)
            return { rows: 0, failed: 0 };
        let rows = 0;
        let failed = 0;
        for (const row of (Array.isArray(record.statuses) ? record.statuses.slice() : [])) {
            if (!row || row.closure === 'escalated' || row.status === 'done')
                continue;
            const delegates = Array.isArray(row.delegates) ? row.delegates : [];
            if (!delegates.some((item) => item?.status === 'running'))
                continue;
            const history = Array.isArray(row.childIdHistory) ? row.childIdHistory : [];
            const leaderId = typeof row.childId === 'string' && row.childId
                ? row.childId
                : (typeof history[history.length - 1]?.childId === 'string' ? history[history.length - 1].childId : '');
            const leaderSession = leaderId ? ctx.sessions?.get?.(leaderId) : null;
            const settled = leaderSession ? collectSettledSnapshots(leaderSession) : new Map();
            const result = reconcileEndedDelegateSessions(delegates, (childId) => ctx.sessions?.get?.(childId), (childId) => settled.get(childId));
            /*
             * [3.1.8][P1 D5] leader 已释放时 reconcile 只能给 unresolved；再用
             * markStalledDelegates 对「childId 有、会话没了、无快照、开工超 120s」的
             * 条目补 failed(stalled)。两者都没改动才跳过，绝不误动健康 running。
             */
            const stalledResult = markStalledDelegates(result.delegates, (childId) => ctx.sessions?.get?.(childId), (childId) => settled.get(childId));
            if (!result.changed && !stalledResult.changed)
                continue;
            const finalDelegates = stalledResult.delegates;
            const revision = Number(row.revision ?? 0) + 1;
            record.statuses = applyStatus(record.statuses, row.subtaskId, {
                delegates: finalDelegates,
                revision,
                updatedBy: 'child',
            });
            record.updatedAt = Date.now();
            rows += 1;
            try {
                appendUserMessage(rootSession ?? ctx.sessions?.get?.(record.plan?.sessionId), buildUpdateMessage({
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId: row.subtaskId,
                    status: row.status,
                    delegates: finalDelegates,
                    revision,
                }));
            }
            catch (error) {
                pushRecordError(record, error);
            }
            const seenFailed = new Set();
            const noticeItems = [];
            for (const item of result.reconciled.filter((entry) => entry?.status === 'failed')) {
                const id = String(item?.childId ?? '');
                if (!id || seenFailed.has(id))
                    continue;
                seenFailed.add(id);
                noticeItems.push({ item, kind: 'reconciled' });
            }
            for (const item of stalledResult.stalled) {
                const id = String(item?.childId ?? '');
                if (!id || seenFailed.has(id))
                    continue;
                seenFailed.add(id);
                noticeItems.push({ item, kind: 'stalled' });
            }
            const failedRows = noticeItems.map((entry) => entry.item);
            if (failedRows.length > 0) {
                failed += failedRows.length;
                if (leaderSession) {
                    try {
                        await emitDelegateTerminationNotices(record, leaderSession, rootSession, row.subtaskId, noticeItems.map(({ item, kind }) => ({
                            childId: String(item.childId),
                            kind,
                            reason: String(item.error ?? (kind === 'stalled'
                                ? '子会话已消失超过 120s 且无结束快照，判定停滞（不自动重派）'
                                : '读时对账确认：会话已结束，但结果块未通过核验')),
                        })));
                    }
                    catch { /* 通知失败不影响状态收敛 */ }
                }
            }
        }
        return { rows, failed };
    }
    function disarmDelegateSweep() {
        if (!delegateSweepTimer)
            return;
        clearInterval(delegateSweepTimer);
        delegateSweepTimer = null;
    }
    /**
     * [3.1.8][P1 D5] 巡检开关：只在确实有 running 成员时启动，避免空转；
     * 120s 一次，unref，不阻断进程退出。
     */
    function armDelegateSweep() {
        if (delegateSweepTimer)
            return;
        delegateSweepTimer = setInterval(() => { void sweepDelegateRecords(); }, 120_000);
        delegateSweepTimer.unref?.();
    }
    async function sweepDelegateRecords() {
        let anyRunning = false;
        for (const record of state.records.values()) {
            if (!record?.plan)
                continue;
            const rows = Array.isArray(record.statuses) ? record.statuses : [];
            if (!rows.some((row) => Array.isArray(row?.delegates)
                && row.delegates.some((item) => item?.status === 'running')))
                continue;
            anyRunning = true;
            const rootSession = ctx.sessions?.get?.(record.plan?.sessionId);
            try {
                await reconcileRecordDelegates(record, rootSession);
            }
            catch (error) {
                pushRecordError(record, error);
            }
        }
        if (!anyRunning)
            disarmDelegateSweep();
    }
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
             * [T3][M7 在途可见] 计划尚未落盘、但后台自动分解正在进行时，不得误报"没有计划"
             * （T1 失效分支 F4：在途不可见曾让用户与主 Agent 误判为"分配器无对象、任务未开始"，
             * 正是本次缺陷的直接观感）。返回 PLANNING_IN_FLIGHT，附带已耗时与明确下一步，
             * 与真正的 NO_PLAN 区分。仅读取 state.planningInFlight，不写任何状态。
             */
            const inFlight = state.planningInFlight?.get(session.id);
            if (inFlight) {
                /* [R2 修正] ok 取 false，与 NO_PLAN 一致：在途意味着「还没有可用计划」，避免调用方
                 * 把 ok:true 误读为「已有计划」。code=PLANNING_IN_FLIGHT 与 hint 明确区分原因与下一步。 */
                return {
                    ok: false,
                    code: 'PLANNING_IN_FLIGHT',
                    running: false,
                    version: pluginVersion,
                    runtime: runtimeIdentity(),
                    elapsedMs: Date.now() - Number(inFlight.startedAt ?? Date.now()),
                    error: '',
                    hint: '任务分解进行中，计划生成后会话将自动出现计划；请稍后再查看，或等待分配通知。',
                };
            }
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
        // [3.1.8][P1 D5] 读状态即收敛：负责人回合结束后静默死亡的专家，在根会话
        // 下一次 status 时补结算并通知负责人；查不到结束证据的行保持 running。
        try {
            await reconcileRecordDelegates(record, session);
        }
        catch (error) {
            pushRecordError(record, error);
        }
        const running = Boolean(record.dispatchPromise);
        const snapshot = derivePlanSnapshot(record.statuses);
        const readiness = readinessOf(record, snapshot);
        // [T4][F6] 一致性告警只算一次（只告警，不改变 deliveryReady 与 done 判定）。
        const consistencyWarnings = deriveDelegateConsistencyWarnings(snapshot.statuses);
        return {
            ok: true,
            version: pluginVersion,
            runtime: runtimeIdentity(),
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
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
            // [T4][F6] 一致性告警（只告警，不改变 deliveryReady 与 done 判定）。
            ...(consistencyWarnings.length > 0 ? { warnings: consistencyWarnings } : {}),
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
     * [1.13.0→3.0.8] 第四步（验证阶段）的插件核验入口（用户 2026-11-05；五步口径）。
     *
     * 「按提交内容判阶段」：
     *   - 只有 planning + preparation + execution 证据齐全，才会进入第四步核验；
     *   - 缺 planning/preparation/execution 的调用以 PHASE_GATE 拒绝并列出待补项 —— 这是一道
     *     证据门禁，不是对插件的全局禁用（「前三步禁用插件」只是 2026-11-05
     *     当次优化会话的过程约束，2.0.2 起不再作为所有会话的产品规则）；
     *   - 第四步核验会逐条检查：任务梳理/资源/工具/方案是否有实质内容、准备就绪
     *     证据是否记录、执行步骤是否记录、验证是否全部通过、验证记录是否覆盖全部验收标准。
     *
     * 它不写状态、不替子 Agent 宣称完成：最终是否 done 仍由 `adjudicateResult`
     * 对同一份 phases 再判一次，避免「核验工具说通过」与「结果块没写」两套真相。
     */
    async function verifySubtask(agent, args) {
        const childSession = agent?.session;
        if (!childSession?.id) {
            return { ok: false, code: 'NO_SESSION', passed: false, error: '只能在部门子会话内做第四步核验' };
        }
        const parentId = childSession.header?.parentSession;
        if (!parentId) {
            return {
                ok: false,
                code: 'NOT_CHILD_SESSION',
                passed: false,
                error: '当前不是子会话，无法反查父计划；第四步核验只对已派发的部门子任务开放',
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
        /*
         * [3.1.6 修复] 第三层叶子也必须能核验：叶子的直接父会话是部门负责人，
         * 计划只挂在根会话上。旧实现只按「父会话 = 计划所有者」读取，叶子必然
         * 得到 NO_PLAN（现场日志：T2 的 sec4/sec6 专家核验被拒，只好改成请示）。
         * 这里复用 findDelegateLeafContext 的既有反查（与 escalate / self_effort
         * 同一判据，不信任自报 subtaskId）：叶子以所属成员的 qualityRequirements
         * 作为验收标准，subtaskId 回报所属部门行。第一层路径逐行不变。
         */
        const row = (record?.statuses ?? []).find((item) => item?.childId === childSession.id);
        let planId = '';
        let subtaskId = '';
        let expectedAcceptance = [];
        if (record?.plan && row) {
            if (row.status === 'done') {
                return { ok: false, code: 'ALREADY_DONE', passed: false, subtaskId: row.subtaskId, error: '该子任务已标记完成，无需再次核验' };
            }
            const found = findSubtask(record.plan, row.subtaskId);
            planId = record.plan.planId;
            subtaskId = row.subtaskId;
            expectedAcceptance = Array.isArray(found?.subtask?.acceptance) ? found.subtask.acceptance : [];
        }
        else {
            const leaf = findDelegateLeafContext(childSession);
            if (!leaf) {
                if (!record?.plan) {
                    return { ok: false, code: 'NO_PLAN', passed: false, error: '父会话没有可关联的计划，无法核验' };
                }
                return { ok: false, code: 'NO_SUBTASK', passed: false, error: '计划里找不到与本子会话关联的子任务（childId 未登记）' };
            }
            if (leaf.member?.status === 'done') {
                return { ok: false, code: 'ALREADY_DONE', passed: false, subtaskId: leaf.row.subtaskId, member: leaf.member?.member, error: '该成员已结算，无需再次核验' };
            }
            planId = leaf.record.plan.planId;
            subtaskId = leaf.row.subtaskId;
            expectedAcceptance = Array.isArray(leaf.member?.qualityRequirements) ? leaf.member.qualityRequirements : [];
        }
        const rawPhases = isRecord(args?.phases)
            ? args.phases
            : { planning: args?.planning, preparation: args?.preparation, execution: args?.execution, verification: args?.verification };
        const check = validateFiveStepEvidence(rawPhases, expectedAcceptance);
        if (!check.ok || !check.phases) {
            const gate = phaseGateFromErrors(check.errors);
            return {
                ok: false,
                passed: false,
                code: gate === 'steps-1-3' ? 'PHASE_GATE' : 'VERIFICATION_INCOMPLETE',
                phase: gate,
                planId,
                subtaskId,
                gaps: check.errors,
                error: gate === 'steps-1-3'
                    ? `核验缺少前几步证据：先完成「梳理任务 → 研究资源工具方案 → 准备到位 → 执行」并按步写全证据，再提交验证核验。${check.errors.slice(0, 5).join('；')}`
                    : `验证核验未通过：${check.errors.slice(0, 5).join('；')}`,
            };
        }
        return {
            ok: true,
            passed: true,
            phase: 'verification',
            planId,
            subtaskId,
            summary: phaseSummaryLine(check.phases),
            message: '插件核验通过：第四步证据齐全、验证全部通过。现在把同一份 phases 写进结果块，并按第五步以 JSON mode 交回本部门负责人。',
        };
    }
    /**
     * [2.5.6] 第三层叶子归属反查（叶子↔负责人双向请示/指示通道的读侧）。
     *
     * 叶子会话的父链是「叶子 → 部门负责人 → 根会话」，计划只挂在根会话上。
     * 沿父链向上（≤3 跳，防环）找到第一个有计划记录的祖先，再按 delegate
     * 登记（行 delegates[].childId）定位叶子所属的部门行与成员条目——与
     * selfEffortTool 同一判据，不信任自报 subtaskId。找不到计划或 childId
     * 未登记时返回 null，由调用方维持原错误语义。
     */
    function findDelegateLeafContext(childSession) {
        let ancestorId = childSession?.header?.parentSession;
        for (let hop = 0; hop < 3 && typeof ancestorId === 'string' && ancestorId; hop += 1) {
            let rec = state.records.get(ancestorId);
            if (!rec?.plan) {
                const sess = ctx.sessions?.get?.(ancestorId);
                if (sess) {
                    try {
                        rec = reconstructFromSession(sess);
                    }
                    catch (error) {
                        pushRecordError({ errors: [] }, error);
                    }
                }
            }
            if (rec?.plan) {
                const deptRow = (rec.statuses ?? []).find((item) => Array.isArray(item?.delegates)
                    && item.delegates.some((d) => d?.childId === childSession.id));
                if (!deptRow)
                    return null;
                const member = deptRow.delegates.find((d) => d?.childId === childSession.id);
                return { record: rec, row: deptRow, member, ownerId: ancestorId };
            }
            const sess = ctx.sessions?.get?.(ancestorId);
            ancestorId = sess?.header?.parentSession;
        }
        return null;
    }
    /**
     * [T5-channel][契约v1 §1/§2] 通道留痕统一入口：补齐 v/id/ts 后交
     * appendDeptMessage（fail-closed 校验＋显式 JOURNAL_WRITE_FAILED）。返回
     * 消息 id 与写盘结果，供调用方把「投递结果」与「留痕结果」两者都报，
     * 绝不互相掩盖（契约 §4）。
     */
    function channelJournal(fields) {
        const message = { v: 1, id: makeDeptMessageId(), ts: Date.now(), ...fields };
        const written = appendDeptMessage(message);
        return { id: message.id, result: written };
    }
    /*
     * [T6][契约v1 §3/§5] 叶子开工预估的读侧消毒（与 plan.ts sanitizeDelegateEstimate
     * 同一判据，G1 双侧接线）：declaredMinutes 正整数分钟（Number.isInteger 且
     * 1..10080，不做字符串强转）、at 正数、delivery 枚举 sent/failed；reason ≤300、
     * messageId ≤200 均可选。任一必填非法 ⇒ 整个 estimate 视为未登记（null）。
     * 重派读档门禁与 self_effort 幂等判据据此判定「预估已登记」。
     */
    function sanitizeLeafEstimate(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return null;
        const minutes = value.declaredMinutes;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)
            return null;
        const at = Number(value.at);
        if (!Number.isFinite(at) || at <= 0)
            return null;
        if (value.delivery !== 'sent' && value.delivery !== 'failed')
            return null;
        return {
            declaredMinutes: minutes,
            ...(typeof value.reason === 'string' && value.reason.trim() ? { reason: truncate(value.reason.trim(), 300) } : {}),
            at,
            ...(typeof value.messageId === 'string' && value.messageId ? { messageId: truncate(value.messageId, 200) } : {}),
            delivery: value.delivery,
        };
    }
    /**
     * [T5-channel][契约v1 §3a] 第三层叶子的请示落档（写侧）：question/options/
     * needs 经 ctx.subagents.sendMessage 投给部门负责人会话（row.childId），写
     * kind='escalation' 留痕，经 applyStatus 把 delegates[i].escalation 子对象
     * 持久化并发 durable update 到根会话。部门行本身的 status/closure 不变——
     * 问题等负责人答，不是等主 Agent。announceSubtaskInterrupt 仅作辅助用户
     * 可见通知，不替代给负责人的 sendMessage 投递。
     */
    async function escalateDelegateLeaf(agent, leaf, args) {
        const { record, row, member, ownerId } = leaf;
        if (member.status === 'done') {
            return { ok: false, code: 'ALREADY_DONE', subtaskId: row.subtaskId, member: member.member, error: '该成员已结算，不能再提交请示' };
        }
        const question = truncate(String(args?.question ?? '').trim(), MAX_QUESTION_CHARS);
        if (!question) {
            return { ok: false, code: 'INVALID_QUESTION', subtaskId: row.subtaskId, member: member.member, error: 'question 必填：写清需要部门负责人决定的单个问题' };
        }
        // [T5-channel][D6] 投递失败的请示允许重试：delivery='failed' 不走幂等分支，
        // 重新投递并覆盖留档；只有已成功送达（sent）的请示才拦截重复提交。
        if (member.escalation && member.escalation.delivery !== 'failed') {
            return {
                ok: true,
                alreadyEscalated: true,
                routedTo: 'head',
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId: row.subtaskId,
                member: member.member,
                question: member.escalation.question ?? question,
                message: '这条请示已经在上报队列里，不要重复提交；停止推进，等待部门负责人指示。',
            };
        }
        const options = (Array.isArray(args?.options) ? args.options : [])
            .slice(0, MAX_ESCALATION_OPTIONS)
            .map((item) => truncate(needEntryText(item), 300))
            .filter(Boolean);
        const needs = (Array.isArray(args?.needs) ? args.needs : [])
            .slice(0, 10)
            .map((item) => truncate(needEntryText(item), 300))
            .filter(Boolean);
        const headChildId = typeof row.childId === 'string' ? row.childId : '';
        if (!headChildId) {
            return { ok: false, code: 'NO_SUBTASK', subtaskId: row.subtaskId, member: member.member, error: '部门行没有登记负责人会话（childId 缺失），无法投递请示' };
        }
        const service = ctx.subagents;
        if (!service || typeof service.sendMessage !== 'function') {
            return { ok: false, code: 'NO_SUBAGENT_SERVICE', subtaskId: row.subtaskId, member: member.member, error: '当前部署没有可用的 subagent 服务，无法投递请示' };
        }
        const now = Date.now();
        const body = truncate([
            `【第三层请示｜${member.member} → 部门负责人】`,
            `子任务 ${row.subtaskId} 的第三层成员 ${member.member} 执行中请求指示：`,
            question,
            options.length ? `可选方向：${options.join('；')}` : '',
            needs.length ? `跨部门需求：${needs.join('；')}` : '',
            `请答复：dsh_workplan_instruct（subtaskId=${row.subtaskId}，member=${member.member}，instruction=你的决定）。答复前该成员停止推进、只做只读核对。`,
        ].filter(Boolean).join('\n'), 4000);
        const startedAt = Date.now();
        let messageId = '';
        let deliveryError = '';
        try {
            messageId = String(await service.sendMessage(agent, headChildId, [{ type: 'text', text: body }], { signal: new AbortController().signal }) ?? ''); // [T11] 缺陷②：请示上报携带有效 signal，消除 throwIfAborted
        }
        catch (error) {
            deliveryError = truncate(error instanceof Error ? error.message : String(error), 500);
        }
        const latencyMs = Date.now() - startedAt;
        const delivery = deliveryError ? 'failed' : 'sent';
        const journal = channelJournal({
            planId: record.plan.planId,
            subtaskId: row.subtaskId,
            kind: 'escalation',
            from: { sessionId: String(agent?.session?.id ?? ''), role: 'expert', member: member.member },
            to: { sessionId: headChildId, role: 'head' },
            body,
            data: { options, needs },
            delivery: { status: delivery, ...(messageId ? { messageId } : {}), latencyMs, ...(deliveryError ? { code: 'DELIVERY_FAILED', error: deliveryError } : {}) },
        });
        const journalInfo = journal.result.ok ? {} : { journal: { ok: false, code: journal.result.code, error: journal.result.error } };
        const revision = Number(row.revision ?? 0) + 1;
        const delegates = (Array.isArray(row.delegates) ? row.delegates : []).map((item) => (item?.childId === member.childId
            ? {
                ...item,
                // [3.0.5] 待指示必须显式落在第三层台账：负责人改派闸门与看板都读这个字段。
                closure: 'escalated',
                blockedKind: 'escalated',
                error: question,
                escalation: { question, options, needs, at: now, ...(messageId ? { messageId } : {}), delivery },
            }
            : item));
        record.statuses = applyStatus(record.statuses, row.subtaskId, { delegates, revision, updatedBy: 'child' });
        record.updatedAt = now;
        try {
            const written = record.statuses.find((item) => item?.subtaskId === row.subtaskId);
            const ownerSession = ctx.sessions?.get?.(ownerId);
            // durable 回放挂在计划所有者（根会话）上：刷新/重启后请示不丢。
            appendUserMessage(ownerSession, buildUpdateMessage({
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId: row.subtaskId,
                status: written?.status ?? row.status,
                delegates: written?.delegates ?? delegates,
                revision,
                note: `第三层成员 ${member.member} 提交请示（待指示）`,
                // [T7] C1 白名单：第三层请示=待指示事件，注入一行关键进度（含阻塞原因）。
                keyProgress: true,
                stateLabel: '待指示（第三层）',
                question,
                title: flattenSubtasks(record.plan).find((entry) => entry.subtask?.id === row.subtaskId)?.subtask?.title,
            }));
            // 辅助用户可见通知（不替代 sendMessage 投递）：负责人当下看到谁在等谁。
            const leader = ctx.sessions?.get?.(headChildId);
            announceSubtaskInterrupt(record, leader, row.subtaskId, `第三层成员 ${member.member} 请求指示：${truncate(question, 160)}；性质：等待部门负责人拍板，不是执行失败；处理：负责人用 dsh_workplan_instruct（subtaskId=${row.subtaskId}，member=${member.member}）答复后，该成员恢复执行。`);
        }
        catch (error) {
            pushRecordError(record, error);
        }
        if (deliveryError) {
            return { ok: false, code: 'DELIVERY_FAILED', subtaskId: row.subtaskId, member: member.member, error: deliveryError, ...journalInfo };
        }
        return {
            ok: true,
            routedTo: 'head',
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
            subtaskId: row.subtaskId,
            member: member.member,
            messageId,
            latencyMs,
            question,
            revision,
            ...journalInfo,
            message: '已上报部门负责人。请立即停止推进，只允许做只读核对；等待指示期间不要开始新的写入或大改。',
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
        const row = (record?.statuses ?? []).find((item) => item?.childId === childSession.id);
        /*
         * [2.5.6] 第三层叶子兜底（治本）：叶子的直接父会话是部门负责人，负责人
         * 自己没有计划记录——旧实现在这里直接 NO_PLAN，叶子永远无法请示。现在
         * 经 delegate 登记（根计划行 delegates[].childId）反查所属部门行，把
         * 「待指示」落在该行的第三层台账上，并通知负责人。第一层（父会话即计划
         * 所有者）路径逐字节不变。
         */
        if (!record?.plan || !row) {
            const leaf = findDelegateLeafContext(childSession);
            if (leaf)
                return await escalateDelegateLeaf(agent, leaf, args);
            if (!record?.plan) {
                return {
                    ok: false,
                    code: 'NO_PLAN',
                    error: '父会话没有可关联的计划；请在结果块写 status=blocked + question，由主 Agent 处理',
                };
            }
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
                planCreatedAt: record.plan?.createdAt,
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
                planCreatedAt: record.plan?.createdAt,
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
                // [T7] C1 白名单：第一层请示=待指示事件，注入一行关键进度。
                keyProgress: true,
                title: flattenSubtasks(record.plan).find((entry) => entry.subtask?.id === row.subtaskId)?.subtask?.title,
            }));
            // [2.2.7] 中断即报：请示同样要让用户当下看到「有人卡在哪、等什么决定」，
            // 结构化 update 消息是给回放/主 Agent 的，这条纯文本是给用户的。
            announceSubtaskInterrupt(record, parent, row.subtaskId, `子任务 ${row.subtaskId} 执行中请求指示：${truncate(question, 160)}；性质：等待主会话拍板，不是执行失败；处理：主会话答复后用 dsh_workplan_instruct 下发决定，该行将恢复执行。`);
        }
        catch (error) {
            pushRecordError(record, error);
        }
        return {
            ok: true,
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
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
     *  - 60s：仍无增长 → 写 `instructionOverdue`（界面显示、主 Agent 可催）。
     * 这里没有 180s 硬截止，也不会因缺少回执收束为 blocked/no-ack；主 Agent
     * 再次改判、子会话产出结果或用户显式取消才会让观察自然作废。
     */
    function scheduleInstructionAck(record, subtaskId, childId, revision) {
        const rowOf = () => record.statuses.find((item) => item?.subtaskId === subtaskId);
        /*
         * [3.1.7][P2 U-39] 回执必须落 durable，不能只改内存。
         *
         * 旧实现的 poll/notice 只经 writeSubtaskStatus 改 record.statuses，从不
         * appendUserMessage：acknowledged/ackedAt/ackEvidence/instructionOverdue
         * 这些字段在重启回放后全部消失（回放白名单虽已补齐字段，但根本没有对应
         * 的 durable 消息可回放），「已回执」与「未回执」在刷新前后两套口径
         * （T7 W2-06）。现在每次回执写入都同步追加一条 workplan-update（与
         * instructSubtask 的指示落盘同范式），失败留痕 errors 不拖垮轮询。
         * ownerSession 取计划所有者会话（record 挂在根会话上）。
         */
        const ackOwnerSession = () => {
            try {
                return ctx.sessions?.get?.(String(record?.plan?.sessionId ?? '')) ?? null;
            }
            catch {
                return null;
            }
        };
        const persistAck = (patch) => {
            const written = writeSubtaskStatus(record, subtaskId, patch, { timedOut: false });
            if (!written)
                return;
            const owner = ackOwnerSession();
            if (!owner)
                return;
            try {
                const fresh = rowOf();
                appendUserMessage(owner, buildUpdateMessage({
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    status: fresh?.status,
                    closure: fresh?.closure,
                    ackedAt: fresh?.ackedAt,
                    ackEvidence: fresh?.ackEvidence,
                    instructionOverdue: fresh?.instructionOverdue,
                    progress: fresh?.progress,
                    revision: fresh?.revision,
                }));
            }
            catch (error) {
                pushRecordError(record, error);
            }
        };
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
         * 正向回执：没有这一步时，一个正常工作但耗时较长的子会话会被误判成
         * 无响应；它其实早就在产出事件了。现在只用于消除逾期提示，不做阻断。
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
                persistAck({
                    closure: 'acknowledged',
                    ackedAt: Date.now(),
                    ackEvidence: { seq, elapsedMs: Date.now() - Number(row.instruction?.at ?? Date.now()) },
                    instructionOverdue: false,
                    progress: Math.max(Number(row.progress ?? 0), 15),
                });
            }
            catch {
                // Row moved on between read and write; the next tick re-evaluates.
                return;
            }
            stop();
        }, INSTRUCTION_POLL_MS);
        // [3.0.1] 回执轮询只提供正向确认与逾期提示；没有 deadline 判定，保留 unref。
        poll.unref?.();
        timers.push(poll);
        const notice = setTimeout(() => {
            if (!unchanged(rowOf()))
                return;
            try {
                persistAck({ instructionOverdue: true });
            }
            catch {
                // The row moved on between the read and the write; nothing to report.
            }
        }, INSTRUCTION_ACK_NOTICE_MS);
        // [2.2.9][handle-policy] 卫生类（T1 报告 R9）：只丢一次「指示未回执」提示，保留 unref。
        notice.unref?.();
        timers.push(notice);
    }
    /**
     * [1.11.0] 主 → 子下发指示  }
  
    /**
     * [1.11.0] 主 → 子下发指示（T4 C-10 / T6 M6）。
     *
     * [T5-channel][契约v1 §3b] 放权为「目标子会话的直接父会话」可调用：根会话
     * 答复第一层部门行（行为逐字节不变）；部门负责人答复自己派出的第三层叶子
     * （严格 lineage：调用者必须是该部门行的 childId，目标必须登记在本行
     * delegates 且在调用者的直接子会话 catalog 里）。非直系（跨行、跨层、无关
     * 会话）一律拒绝。根路径只接受 `closure:'escalated'` 的行；负责人路径按
     * member/sessionId 指定目标。投递失败时不改状态（不伪造成「已指示」），
     * 把错误原样交给调用方。
     */
    async function instructSubtask(agent, args, signal, existingRecord) {
        const session = agent?.session;
        if (!session)
            return { ok: false, code: 'NO_SESSION', error: '只能在会话内下发指示' };
        const callerIsRoot = isRootSession(session);
        let record;
        if (callerIsRoot) {
            record = existingRecord ?? state.records.get(session.id);
            if (!record?.plan)
                record = reconstructFromSession(session, args?.planId);
            record = adoptRequestedPlan(session, record, args?.planId);
            if (!record?.plan)
                return { ok: false, code: 'NO_PLAN', error: '当前会话还没有已生成的计划' };
        }
        else {
            /*
             * [T5-channel][契约v1 §3b] 负责人答复自己的叶子：先沿父链反查根计划，
             * 再判负责人身份（根记录中 statuses[].childId === session.id 的行）。
             * 既非根也非登记负责人 ⇒ 维持 NOT_ROOT；subtaskId 可省略（默认自己的
             * 行），给了必须等于自己的行，否则 UNKNOWN_SUBTASK。目标登记/catalog/
             * 父链的严格 lineage 在 instructDelegateLeaf 内硬校验。
             */
            record = findAncestorPlanRecord(session);
            if (!record?.plan)
                return { ok: false, code: 'NOT_ROOT', error: '只有根会话可以下发指示' };
            if (typeof args?.planId === 'string' && args.planId && record.plan.planId !== args.planId) {
                return { ok: false, code: 'NO_PLAN', error: `指定计划 ${args.planId} 与当前会话关联的计划不一致` };
            }
            const headRow = findHeadRowForSession(record.statuses ?? [], session.id, (id) => ctx.sessions?.get?.(id));
            if (!headRow)
                return { ok: false, code: 'NOT_ROOT', error: '只有根会话可以下发指示' };
            const requested = typeof args?.subtaskId === 'string' ? args.subtaskId.trim() : '';
            if (requested && requested !== String(headRow.subtaskId)) {
                return { ok: false, code: 'UNKNOWN_SUBTASK', subtaskId: requested, error: `未知子任务：${requested}（负责人只能答复自己的部门行 ${String(headRow.subtaskId)}）` };
            }
            return instructDelegateLeaf(agent, args, signal, record, headRow);
        }
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
        const childAlive = Boolean(childId) && spawnedChildIds(session).has(childId);
        if (!childAlive) {
            /*
             * [3.0.1] 死锁自愈（wp-e745a477 事故治本）：子会话失联时不再把 NO_CHILD /
             * NOT_DIRECT_CHILD 当成终点——那条路配上 ESCALATION_OPEN（不许改判）与
             * 「待指示行阻止续跑」会把三条出口全堵死，只剩人工取消整盘计划。
             * 现在：指示登记为行上 reviveInstruction（durable 回放不丢），行从
             * escalated 复位为 pending（TRANSITIONS 合法边），下一次 dispatch 走
             * 常规 executeSubtask 路径重建全新子会话，提示词由 buildChildPrompt
             * 带入这条指示。
             */
            const now = Date.now();
            const { patch: revivePatch, revision } = buildChildRevivePatch(current, instruction, now);
            record.statuses = applyStatus(record.statuses, subtaskId, revivePatch);
            record.phase = reconcilePhase(record.phase, record.statuses);
            record.updatedAt = now;
            try {
                const written = record.statuses.find((item) => item?.subtaskId === subtaskId);
                appendUserMessage(session, buildUpdateMessage({
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    status: 'pending',
                    closure: 'pending',
                    reviveInstruction: written?.reviveInstruction,
                    revision,
                    keyProgress: true,
                    stateLabel: '失联复活·待重派',
                    title: typeof current.title === 'string' ? current.title : undefined,
                }));
            }
            catch (error) {
                pushRecordError(record, error);
            }
            const snapshot = derivePlanSnapshot(record.statuses);
            return {
                ok: true,
                revived: true,
                code: 'CHILD_REVIVED',
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                status: 'pending',
                closure: 'pending',
                revision,
                stats: snapshot.stats,
                hint: '死锁自愈：该行子会话已失联，指示已登记为行上 reviveInstruction、行已复位为待跑。调用 dsh_workplan_dispatch 将重建全新子会话并带入该指示；不要再对本行重复 instruct。',
            };
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
                planCreatedAt: record.plan?.createdAt,
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
            planCreatedAt: record.plan?.createdAt,
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
     * [2.5.6] 沿父链向上（≤3 跳，防环）找到第一个有计划记录的祖先会话。
     * 负责人 instruct 与叶子 escalate 共用同一父链判据；不信任自报 planId。
     */
    function findAncestorPlanRecord(session) {
        let ancestorId = session?.header?.parentSession;
        for (let hop = 0; hop < 3 && typeof ancestorId === 'string' && ancestorId; hop += 1) {
            let rec = state.records.get(ancestorId);
            if (!rec?.plan) {
                const sess = ctx.sessions?.get?.(ancestorId);
                if (sess) {
                    try {
                        rec = reconstructFromSession(sess);
                    }
                    catch (error) {
                        pushRecordError({ errors: [] }, error);
                    }
                }
            }
            if (rec?.plan)
                return rec;
            const sess = ctx.sessions?.get?.(ancestorId);
            ancestorId = sess?.header?.parentSession;
        }
        return null;
    }
    /**
     * [T5-channel][契约v1 §3b] 负责人 → 第三层叶子的指示投递（instruct 的叶子分支）。
     *
     * 负责人身份与行级 lineage 已在 instructSubtask 校验（调用者 == 部门行
     * childId）；这里按 member/sessionId（至少其一）定位本行 delegates 登记的
     * 目标，再校验 spawnedChildIds 直接子会话证据＋父链双保险。投递复用
     * ctx.subagents.sendMessage 既有通道（与 follow-up/延期告知同一条），不新建
     * 队列；写 kind='instruction' 留痕（data.inReplyTo 指向被答复的请示）；
     * 持久化 delegates[i].lastInstruction 并清 escalation；负责人行 closure
     * 不变。投递失败不改状态（不伪造成「已指示」）。
     */
    async function instructDelegateLeaf(agent, args, signal, record, current) {
        const session = agent.session;
        const subtaskId = String(current.subtaskId);
        const memberName = typeof args?.member === 'string' ? args.member.trim() : '';
        const targetSessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!memberName && !targetSessionId) {
            return { ok: false, code: 'MISSING_TARGET', subtaskId, error: 'member 与 sessionId 至少提供其一：指定要答复的第三层成员' };
        }
        const delegates = Array.isArray(current.delegates) ? current.delegates : [];
        const target = memberName
            ? delegates.find((item) => item?.member === memberName)
            : delegates.find((item) => item?.childId === targetSessionId);
        if (!target) {
            return memberName
                ? { ok: false, code: 'UNKNOWN_MEMBER', subtaskId, member: memberName, error: `成员 ${memberName} 未登记在本行 delegates[]` }
                : { ok: false, code: 'NOT_DELEGATE', subtaskId, sessionId: targetSessionId, error: `${targetSessionId} 不是本行登记的第三层成员（跨部门/未登记目标一律拒绝）` };
        }
        if (memberName && targetSessionId && target.childId !== targetSessionId) {
            return { ok: false, code: 'NOT_DELEGATE', subtaskId, error: 'member 与 sessionId 指向不同成员，拒绝投递' };
        }
        /*
         * [3.0.5] 指示只能答复「已经提交请示」的原专家：这从机制上保证用户要求的
         * 四步闭环——专家先上报问题，负责人梳理全部任务状态并研究方案后，只能把
         * 解决方案下发给原专家继续执行；不能借 instruct 把未请示成员当作替代人选。
         */
        if (!target?.escalation && target?.closure !== 'escalated') {
            return {
                ok: false,
                code: 'NOT_ESCALATED',
                subtaskId,
                member: target?.member,
                error: `第三层成员 ${String(target?.member ?? '?')} 不在待指示状态：只有已提交请示的原专家才能接收指示。`,
                hint: '若该成员遇阻，先让其调用 dsh_workplan_escalate；待指示期间禁止 review/dispatch/direct 改派给其他专家。',
            };
        }
        const childId = typeof target.childId === 'string' ? target.childId : '';
        if (!childId) {
            return { ok: false, code: 'NOT_DELEGATE', subtaskId, member: target.member, error: '该成员没有登记子会话 childId，无法投递指示' };
        }
        if (!spawnedChildIds(session).has(childId)) {
            return { ok: false, code: 'NOT_DIRECT_CHILD', subtaskId, error: `${childId} 不是本会话的直接子会话（父会话 catalog 未登记），拒绝投递` };
        }
        const targetSession = ctx.sessions?.get?.(childId);
        if (targetSession?.header?.parentSession && targetSession.header.parentSession !== session.id) {
            return { ok: false, code: 'NOT_DIRECT_CHILD', subtaskId, error: '严格血缘校验失败：目标子会话的直接父会话不是调用者，拒绝投递' };
        }
        const instruction = truncate(String(args?.instruction ?? args?.text ?? '').trim(), MAX_INSTRUCTION_CHARS);
        if (!instruction)
            return { ok: false, code: 'INVALID_INSTRUCTION', subtaskId, error: 'instruction 必填：写清要成员执行的决定' };
        const service = ctx.subagents;
        if (!service || typeof service.sendMessage !== 'function') {
            return { ok: false, code: 'NO_SUBAGENT_SERVICE', subtaskId, error: '当前部署没有可用的 subagent 服务，无法投递指示' };
        }
        // inReplyTo（可选）：从留痕回放找该成员最近一条请示消息 id；读失败不阻断投递。
        let inReplyTo = '';
        try {
            const prior = readDeptMessages(record.plan.planId, { kind: 'escalation', newest: true });
            if (prior.ok) {
                const match = [...prior.messages].reverse().find((m) => m.from?.sessionId === childId && m.subtaskId === subtaskId);
                inReplyTo = match?.id ?? '';
            }
        }
        catch { /* 留痕读失败不阻断投递；inReplyTo 可选 */ }
        const body = truncate([
            '【部门负责人指示（对应你此前提交的请示）】',
            instruction,
            '',
            '请按上述指示继续原任务。若仍受阻，先调用 dsh_workplan_escalate 再次上报，然后停止推进等待指示；不要自行猜测未被回答的部分。',
        ].join('\n'), 4000);
        const startedAt = Date.now();
        let messageId = '';
        try {
            messageId = String(await service.sendMessage(agent, childId, [{ type: 'text', text: body }], { signal }) ?? '');
        }
        catch (error) {
            const errorText = truncate(error instanceof Error ? error.message : String(error), 500);
            const failedJournal = channelJournal({
                planId: record.plan.planId,
                subtaskId,
                kind: 'instruction',
                from: { sessionId: session.id, role: 'head' },
                to: { sessionId: childId, role: 'expert', member: target.member },
                body,
                ...(inReplyTo ? { data: { inReplyTo } } : {}),
                delivery: { status: 'failed', code: 'DELIVERY_FAILED', error: errorText, latencyMs: Date.now() - startedAt },
            });
            return {
                ok: false,
                code: 'DELIVERY_FAILED',
                subtaskId,
                member: target.member,
                sessionId: childId,
                error: errorText,
                hint: '状态未改变，该成员仍是待指示；可重试投递。',
                ...(failedJournal.result.ok ? {} : { journal: { ok: false, code: failedJournal.result.code, error: failedJournal.result.error } }),
            };
        }
        const latencyMs = Date.now() - startedAt;
        const now = Date.now();
        const journal = channelJournal({
            planId: record.plan.planId,
            subtaskId,
            kind: 'instruction',
            from: { sessionId: session.id, role: 'head' },
            to: { sessionId: childId, role: 'expert', member: target.member },
            body,
            ...(inReplyTo ? { data: { inReplyTo } } : {}),
            delivery: { status: 'sent', ...(messageId ? { messageId } : {}), latencyMs },
        });
        const revision = Number(current.revision ?? 0) + 1;
        const delegatesList = (Array.isArray(current.delegates) ? current.delegates : []).map((item) => (item?.childId === childId
            ? {
                ...item,
                status: 'running',
                closure: 'instructed',
                lastInstruction: { text: instruction, at: now, ...(messageId ? { messageId } : {}), delivery: 'sent' },
                escalation: undefined,
                instructionSeq: revision,
                instructionOverdue: false,
                ackedAt: null,
                blockedKind: null,
                error: null,
                finishedAt: null,
            }
            : item));
        record.statuses = applyStatus(record.statuses, subtaskId, { delegates: delegatesList, revision, updatedBy: 'agent' });
        record.updatedAt = now;
        try {
            const written = record.statuses.find((item) => item?.subtaskId === subtaskId);
            const update = buildUpdateMessage({
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                status: written?.status ?? current.status,
                delegates: written?.delegates ?? delegatesList,
                revision,
                note: `负责人已向第三层成员 ${target.member} 下发指示`,
            });
            // durable 回放挂在计划所有者（根会话）上；负责人会话留一份供其回放核对。
            const ownerSession = ctx.sessions?.get?.(record.plan.sessionId);
            appendUserMessage(ownerSession, update);
            if (ownerSession !== session)
                appendUserMessage(session, update);
        }
        catch (error) {
            pushRecordError(record, error);
        }
        scheduleDelegateInstructionAck(record, subtaskId, target.member, childId, revision);
        return {
            ok: true,
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
            subtaskId,
            member: target.member,
            sessionId: childId,
            messageId,
            latencyMs,
            revision,
            ...(journal.result.ok ? {} : { journal: { ok: false, code: journal.result.code, error: journal.result.error } }),
            hint: '指示已投递给第三层成员，该成员已变为「已收到指示」。它会开启新一轮；收齐结论前仍不得写最终结果块。',
        };
    }
    /**
     * [2.5.6] 叶子指示回执：与 scheduleInstructionAck 同一套观察语义
     * （轮询 seq 增长=acknowledged；60s 无增长=instructionOverdue），只是读写
     * 目标从部门行换成行内 delegates 成员条目。两者都没有 180s 硬截止，不会
     * 因缺少回执 blocked/no-ack；独立实现以保持第一层零回归。
     */
    function scheduleDelegateInstructionAck(record, subtaskId, member, childId, revision) {
        const rowOf = () => record.statuses.find((item) => item?.subtaskId === subtaskId);
        const entryOf = () => {
            const row = rowOf();
            return (Array.isArray(row?.delegates) ? row.delegates : []).find((item) => item?.member === member) ?? null;
        };
        const patchEntry = (patch) => {
            const row = rowOf();
            if (!row)
                return null;
            const list = (Array.isArray(row.delegates) ? row.delegates : [])
                .map((item) => (item?.member === member ? { ...item, ...patch } : item));
            const nextRevision = Number(row.revision ?? 0) + 1;
            record.statuses = applyStatus(record.statuses, subtaskId, { delegates: list, revision: nextRevision, updatedBy: 'system' });
            record.updatedAt = Date.now();
            /*
             * [3.1.7][P2 U-39] 第三层回执同样必须落 durable（与第一层
             * scheduleInstructionAck 同口径）：旧实现只改内存，重启后
             * acknowledged/ackedAt/instructionOverdue 全丢。现在每次 patchEntry
             * 同步追加 workplan-update（delegates 整行随消毒白名单回放），失败
             * 留痕 errors 不拖垮轮询。ownerSession 取计划所有者会话。
             */
            try {
                const owner = ctx.sessions?.get?.(String(record?.plan?.sessionId ?? '')) ?? null;
                if (owner) {
                    const fresh = rowOf();
                    appendUserMessage(owner, buildUpdateMessage({
                        planId: record.plan.planId,
                        planCreatedAt: record.plan?.createdAt,
                        subtaskId,
                        status: fresh?.status,
                        delegates: fresh?.delegates,
                        revision: fresh?.revision,
                    }));
                }
            }
            catch (error) {
                pushRecordError(record, error);
            }
            return entryOf();
        };
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
        const sameAttempt = (entry) => {
            if (stopped)
                return false;
            if (!entry || entry.closure !== 'instructed')
                return false;
            return Number(entry.instructionSeq ?? 0) === Number(revision);
        };
        const unchanged = (entry) => {
            if (!sameAttempt(entry))
                return false;
            const seq = readSeq();
            if (seq === undefined || baseline === undefined)
                return true;
            return seq <= baseline;
        };
        const poll = setInterval(() => {
            const entry = entryOf();
            if (!sameAttempt(entry)) {
                stop();
                return;
            }
            const seq = readSeq();
            if (seq === undefined || baseline === undefined || seq <= baseline)
                return;
            try {
                patchEntry({
                    closure: 'acknowledged',
                    ackedAt: Date.now(),
                    instructionOverdue: false,
                });
            }
            catch {
                return;
            }
            stop();
        }, INSTRUCTION_POLL_MS);
        poll.unref?.();
        timers.push(poll);
        const notice = setTimeout(() => {
            if (!unchanged(entryOf()))
                return;
            try {
                patchEntry({ instructionOverdue: true });
            }
            catch { /* entry moved on */ }
        }, INSTRUCTION_ACK_NOTICE_MS);
        notice.unref?.();
        timers.push(notice);
    }
    /**
     * [1.11.0] 工具层入口：子会话的遇阻上报  }
  
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
                planCreatedAt: record.plan?.createdAt,
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
         * 60s 逾期提示、下次激活注入），不另造第二条消息通道。
         * 投递失败不回滚 handoff：答复本身是真的，失败原因如实返回给主 Agent。
         */
        let instruction = null;
        if (action === 'resolve' && row.closure === 'escalated' && handoffs[index]?.response) {
            const answer = handoffs[index];
            instruction = await instructSubtask(agent, {
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                instruction: `跨部门需求 ${answer.id} 已答复${answer.department ? `（${answer.department}）` : ''}：${answer.response}。按此答复继续原任务。`,
            }, signal);
        }
        const finalReadiness = readinessOf(record, derivePlanSnapshot(record.statuses));
        return {
            ok: true,
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
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
    /**
     * [2.3.9][T4b] 第三层派发（用户强制要求 4/5）：部门负责人专用工具。
     *
     * 层级模型：主 Agent(根会话, depth 0) → 部门负责人子会话(depth 1) →
     * 顶尖专家/组员子会话(depth 2, 叶子层)。三道硬边界：
     *  1. 调用者必须是计划内某行的部门负责人子会话（childId 反查行）；
     *     根会话被拒（用 dsh_workplan_dispatch），第三层成员也被拒——
     *     其父会话是部门会话、没有计划记录，NO_PLAN/NO_SUBTASK 即叶子层禁令；
     *  2. 梳理门禁：dispatch 前必须先 review 提交「全面梳理产物 + 分工表」
     *     （planDelegations 唯一判据，durable 回放后依然生效）；
     *  3. 深度：成员 spawn 传 maxDepth:2，第四层(depth 3)由宿主
     *     SubagentDepthError 硬拒（resolveChildDepth 绝对上限）。
     *
     * 每位下级的推理等级按其任务复杂度由负责人配置，经 planDelegations 按
     * 当前模型家族合法集合（qwen→low/medium/xhigh；非qwen→low/high/max）
     * 钳制并留痕（delegates[].requested/effort 对），随 spawn 的 agentOptions
     * 下发且全生命周期生效（要求 5）。
     */
    /**
     * [2.5.0][自配档] 叶子自配推理等级（用户要求 2 新口径）：第三层专家/组员专用。
     * 先配置后开工——phase-0 以 low 启动，叶子评估自己任务复杂度后经此提交自配档；
     * 平台登记（五档白名单 + 家族钳制留痕 + delegates[].selfEffort + delegateSelfEfforts
     * 持久化回放）后立即中断 phase-0 回合，并以自配档接续 phase-1。宿主契约：
     * reasoningEffort 在子会话创建时解析（resolveChildAgentOptions），同会话换档不可行
     * ⇒ 接续 = interruptByParent(continuable) + 新激活携带 phase-0 产物与完整任务书，
     * childId 台账更新，旧结算回调按旧 childId 自动失配。接续失败重试 1 次仍败 ⇒
     * 明确 SELF_EFFORT_CONTINUATION_FAILED，禁止静默降档。
     */
    async function selfEffortTool(agent, args, signal) {
        const childSession = agent?.session;
        if (!childSession?.id)
            return { ok: false, code: 'NO_SESSION', error: 'self_effort 只能在会话内使用' };
        const leaderId = childSession.header?.parentSession;
        const leaderSession = leaderId ? ctx.sessions?.get?.(leaderId) : null;
        const rootId = leaderSession?.header?.parentSession;
        let record = rootId ? state.records.get(rootId) : undefined;
        if (!record?.plan && rootId) {
            const rootSession = ctx.sessions?.get?.(rootId);
            if (rootSession) {
                try {
                    record = reconstructFromSession(rootSession);
                }
                catch (error) {
                    pushRecordError({ errors: [] }, error);
                }
            }
        }
        let row = (record?.statuses ?? []).find((item) => Array.isArray(item?.delegates) && item.delegates.some((d) => d?.childId === childSession.id));
        /*
         * [T11] 血缘懒加载回退（治本，缺陷①）：重启早期负责人会话可能尚未载入
         * ctx.sessions，rootId 取不到会在旧逻辑里被误报 SELF_EFFORT_NOT_LEAF。
         * 此处不直接拒绝，改按 childId 扫描既有台账定位归属计划（与 rootId 路径
         * reconstructFromSession 回退同范式）。只有真正未被任何部门行登记为叶子的
         * 会话（根会话/负责人自调用）才命中下方 NOT_LEAF 拒绝——安全边界不变。
         */
        if (!record?.plan || !row) {
            for (const candidate of state.records.values()) {
                const candidateRow = (candidate?.statuses ?? []).find((item) => Array.isArray(item?.delegates) && item.delegates.some((d) => d?.childId === childSession.id));
                if (candidate?.plan && candidateRow) {
                    record = candidate;
                    row = candidateRow;
                    break;
                }
            }
        }
        /*
         * [3.1.8][P0 D1] 派发实例表兜底：dispatch 先拉起叶子、后落 durable childId，
         * 叶子在窗口内调用 self_effort 时台账里可能还没有它；而「这个子会话是哪个
         * 子任务派出去的」在同一进程内由 rememberActivation 客观记录，不随台账重建
         * 丢失。先按这张表找回行，再走成员名兜底——负责人换主也不影响（表按 leaf
         * childId 建键，不依赖当前 row.childId）。
         */
        if (!record?.plan || !row) {
            const activation = recallActivation(ctx, childSession.id);
            if (activation?.subtaskId) {
                for (const candidate of state.records.values()) {
                    if (!candidate?.plan)
                        continue;
                    if (activation.planId && String(candidate.plan.planId ?? '') !== String(activation.planId))
                        continue;
                    const candidateRow = (candidate.statuses ?? []).find((item) => item?.subtaskId === activation.subtaskId);
                    if (candidateRow) {
                        record = candidate;
                        row = candidateRow;
                        break;
                    }
                }
            }
        }
        /*
         * [3.1.7][P0 U-37] 成员名兜底认亲（治本：落账晚于激活的竞态）。
         *
         * 事故形状：dispatch 先 await startActivation 拉起叶子，循环结束后才
         * persist({delegates})。叶子在 phase-0 立刻调用 self_effort 时，台账里
         * 还没有它的 childId ⇒ 恒报 SELF_EFFORT_NOT_LEAF，专家开工即卡死。
         * 任务书首行已写明成员名（「你是…（Expert-A）」），这里允许叶子用
         * args.member 自报身份，在**同一负责人派出的**部门行里按成员名定位；
         * 仍要求该成员条目尚未绑定任何 childId（或绑定的正是本会话），
         * 且本会话确实是该负责人的直接子会话（父链证据），安全边界不放宽：
         * 根会话/负责人自调用/陌生会话依旧命中 NOT_LEAF。
         */
        const selfMemberName = typeof args?.member === 'string' ? args.member.trim() : '';
        if ((!record?.plan || !row) && selfMemberName && leaderId) {
            /*
             * [3.1.8][P0 D1] 负责人换主后，旧叶子仍以旧负责人为 parentSession。
             * childIdHistory 记录了「谁曾负责过这一行」（plan.ts applyStatus 在换主时
             * 留档）；把它与 row.childId 同判据，旧叶子才能认回自己的部门行。安全边界
             * 不变：仍要求本会话是负责人的直接子会话，且成员条目未绑定别的 childId。
             */
            for (const candidate of state.records.values()) {
                if (!candidate?.plan)
                    continue;
                const candidateRow = (candidate?.statuses ?? []).find((item) => headRowOwnedBy(item, leaderId)
                    && Array.isArray(item?.delegates)
                    && item.delegates.some((d) => d?.member === selfMemberName && (!d?.childId || d.childId === childSession.id)));
                if (candidateRow) {
                    record = candidate;
                    row = candidateRow;
                    break;
                }
            }
        }
        if (!record?.plan || !row) {
            return { ok: false, code: 'SELF_EFFORT_NOT_LEAF', error: '找不到与本子会话关联的第三层台账（childId 未登记）：self_effort 仅限部门负责人派出的全球顶尖专家叶子会话调用。若台账尚未登记你的 childId（派发竞态），请携带 member=任务书首行括号里的成员名 重试。' };
        }
        /*
         * [3.1.8][P0 D1] 角色边界：派发实例表/历史认亲可能把「负责人自己的会话」
         * 也找回这一行；负责人不是叶子，不能给自己登记 self_effort。当前/前任
         * childId 命中都拒绝，避免成员名占位条目被负责人冒名占用。
         */
        if (headRowOwnedBy(row, childSession.id)) {
            return { ok: false, code: 'SELF_EFFORT_NOT_LEAF', error: 'self_effort 仅限部门负责人派出的全球顶尖专家叶子会话调用：负责人会话不能给自己登记自配档。' };
        }
        const member = row.delegates.find((d) => d?.childId === childSession.id)
            ?? (selfMemberName ? row.delegates.find((d) => d?.member === selfMemberName && (!d?.childId || d.childId === childSession.id)) : undefined);
        if (!member) {
            return { ok: false, code: 'SELF_EFFORT_NOT_LEAF', error: '找不到与本子会话关联的第三层台账（childId 未登记）：self_effort 仅限部门负责人派出的全球顶尖专家叶子会话调用。若台账尚未登记你的 childId（派发竞态），请携带 member=任务书首行括号里的成员名 重试。' };
        }
        if (member.status === 'done')
            return { ok: false, code: 'ALREADY_DONE', error: '该成员已结算，不能再自配等级。' };
        const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
        const raw = args?.reasoningEffort;
        if (typeof raw !== 'string' || !FIVE.includes(raw)) {
            return { ok: false, code: 'SELF_EFFORT_INVALID', error: `reasoningEffort "${String(raw)}" 非法：必须是 low / medium / high / xhigh / max 之一（按你自己任务复杂度自配：轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max）。` };
        }
        const rationale = String(args?.complexityRationale ?? '').trim();
        if (!rationale)
            return { ok: false, code: 'SELF_EFFORT_RATIONALE_MISSING', error: 'complexityRationale 必填：写清你分到的单项任务为何是该复杂度档（事实/依赖/验证难度）。' };
        /*
         * [3.0.8] 叶子执行前五步第 1/2/3 步开工证据硬门禁（五步工作法单框架；取代
         * 2.5.2 的两轮深度思考 deepThink 门禁——两轮内容本就是五步第 1、2 步的子集）。
         *
         * self_effort 必须同时携带合格 startPhases={ planning, preparation }
         * （与主 Agent/负责人同一 validateStartPhaseEvidence 判据、同一七项字数下限
         * 口径：problemAnalysis/approach ≥40、approachBasis/resources/prepared/evidence ≥20、
         * tools ≥10），缺交/不合格硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），
         * 不登记、不接续；齐全才登记并以自配档接续 phase-1——正式执行只能发生在
         * 第 1/2/3 步证据登记之后，且必须按第二步理清的方法、流程、步骤执行。
         * 已登记自配档的旧叶子重派直接 phase-1（零迁移），其结算门禁仍验产物。
         */
        const leafStartCheck = validateStartPhaseEvidence(args?.startPhases);
        if (!leafStartCheck.ok) {
            return {
                ok: false,
                code: leafStartCheck.code ?? 'START_EVIDENCE_INCOMPLETE',
                subtaskId: String(row.subtaskId),
                member: member.member,
                error: `开工证据${leafStartCheck.code === 'START_EVIDENCE_MISSING' ? '缺失' : '不合格'}：全球顶尖专家开始执行自己的任务前，必须先完成五步前三步——第一步全面、全盘、深入梳理、研究、思考自己的任务；第二步基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案（方法、流程、步骤，含依据）；第三步把资源与工具真正备齐并给出就绪证据。请在 self_effort 一并携带 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }。${leafStartCheck.error ?? ''}`,
            };
        }
        const leafStartPhases = leafStartCheck.evidence;
        /*
         * [T6][D9] 开工前预估硬门禁（T6 冻结契约 §2，校验顺序最后一项：
         * reasoningEffort→complexityRationale→startPhases→timeNotice）。timeNotice=
         * { declaredMinutes: 正整数分钟(1..10080), reason?: ≤300 }。缺交=ESTIMATE_MISSING；
         * 非对象/非整数/越界=ESTIMATE_INVALID；error 必须含 D9 原话＋形状说明。拒绝一律
         * 不登记、不投递、不接续（A1）。预估登记后经 T5 通道送达部门负责人（§4）才准
         * 接续 phase-1——「没有告知部门负责人预估时间，先拦截」。
         */
        const D9_ESTIMATE = '你必须自己预估时间，汇报给对应负责人后，才可以重试或继续执行';
        const rawTimeNotice = args?.timeNotice;
        if (rawTimeNotice === undefined) {
            return {
                ok: false,
                code: 'ESTIMATE_MISSING',
                subtaskId: String(row.subtaskId),
                member: member.member,
                error: `开工前预估缺失：${D9_ESTIMATE}。请在 self_effort 一并携带 timeNotice={ declaredMinutes: 正整数分钟（1..10080）, reason?: 可选理由（≤300 字符） }。`,
            };
        }
        if (!rawTimeNotice || typeof rawTimeNotice !== 'object' || Array.isArray(rawTimeNotice)) {
            return {
                ok: false,
                code: 'ESTIMATE_INVALID',
                subtaskId: String(row.subtaskId),
                member: member.member,
                error: `开工前预估形状非法：timeNotice 必须是对象 { declaredMinutes: 正整数分钟（1..10080）, reason? }，现值 ${JSON.stringify(rawTimeNotice) ?? String(rawTimeNotice)}。${D9_ESTIMATE}。`,
            };
        }
        const rawMinutes = rawTimeNotice.declaredMinutes;
        if (!Number.isInteger(rawMinutes) || rawMinutes < 1 || rawMinutes > 10080) {
            return {
                ok: false,
                code: 'ESTIMATE_INVALID',
                subtaskId: String(row.subtaskId),
                member: member.member,
                error: `开工前预估非法：declaredMinutes 必须是正整数分钟（Number.isInteger 且 1..10080），现值 ${JSON.stringify(rawMinutes) ?? String(rawMinutes)}。${D9_ESTIMATE}。`,
            };
        }
        const rawEstimateReason = rawTimeNotice.reason;
        if (rawEstimateReason !== undefined && typeof rawEstimateReason !== 'string') {
            return {
                ok: false,
                code: 'ESTIMATE_INVALID',
                subtaskId: String(row.subtaskId),
                member: member.member,
                error: `开工前预估非法：reason 可选但必须是字符串（trim 后 ≤300 字符），现值类型 ${typeof rawEstimateReason}。${D9_ESTIMATE}。`,
            };
        }
        const estimateReason = typeof rawEstimateReason === 'string' && rawEstimateReason.trim() ? truncate(rawEstimateReason.trim(), 300) : '';
        const modelSelection = resolveModelSelection(ctx, { agent });
        const model = typeof modelSelection?.model === 'string' && modelSelection.model.trim() ? modelSelection.model.trim() : null;
        const correction = correctEffortForModel(raw, model);
        const selfEffort = correction.effort;
        if (correction.adjusted) {
            console.warn('[dsh-workplan] delegate self-effort corrected by LLM family rules:', JSON.stringify({ member: member.member, model, requested: raw, corrected: selfEffort, reason: correction.reason }));
        }
        const subtaskId = String(row.subtaskId);
        const rootSession = ctx.sessions?.get?.(rootId);
        const persistSelf = (patch) => {
            const current = record.statuses.find((item) => item?.subtaskId === subtaskId);
            const revision = Number(current?.revision ?? 0) + 1;
            record.statuses = applyStatus(record.statuses, subtaskId, { ...patch, revision, updatedBy: 'child' });
            record.updatedAt = Date.now();
            const written = record.statuses.find((item) => item?.subtaskId === subtaskId);
            try {
                appendUserMessage(rootSession, buildUpdateMessage({
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    status: written?.status ?? row.status,
                    ...(patch.delegates === undefined ? {} : { delegates: written?.delegates }),
                    ...(patch.delegateSelfEfforts === undefined ? {} : { delegateSelfEfforts: written?.delegateSelfEfforts }),
                    ...(patch.delegateStartPhases === undefined ? {} : { delegateStartPhases: written?.delegateStartPhases }),
                    // [T6][契约v1 §3] 预估台账随 durable workplan-update 回放（重启不丢）。
                    ...(patch.delegateEstimates === undefined ? {} : { delegateEstimates: written?.delegateEstimates }),
                    revision: written?.revision ?? revision,
                }));
            }
            catch (error) {
                pushRecordError(record, error);
            }
            return written;
        };
        const currentRow = () => record.statuses.find((item) => item?.subtaskId === subtaskId);
        // [T6][契约v1 §4] 预估读档（幂等判据）：已 sent ⇒ 不重复投递；failed/缺失 ⇒
        // 本次投递。读侧消毒与 plan.ts sanitizeDelegateEstimate 同口径（正整数分钟才算已登记）。
        const priorEstimate = sanitizeLeafEstimate(currentRow()?.delegateEstimates?.[member.member])
            ?? sanitizeLeafEstimate((currentRow()?.delegates ?? []).find((d) => (d?.childId === childSession.id || (!d?.childId && d?.member === member.member)))?.estimate);
        const estimateAlreadySent = priorEstimate?.delivery === 'sent';
        const estimateDraft = estimateAlreadySent
            ? priorEstimate
            : { declaredMinutes: rawMinutes, ...(estimateReason ? { reason: estimateReason } : {}), at: Date.now(), delivery: 'failed' };
        const registerList = (currentRow()?.delegates ?? row.delegates)
            .map((d) => ((d?.childId === childSession.id || (!d?.childId && d?.member === member.member))
            // [3.1.7][P0 U-37] 首次登记即绑定 childId：竞态窗口里台账条目可能还没有
            // childId，这里补上本会话 id，后续结算/通知/对账全部按 childId 认亲。
            ? { ...d, childId: d?.childId ?? childSession.id, selfEffort, ...(correction.adjusted ? { selfEffortRequested: raw } : {}), complexityRationale: truncate(rationale, 300), startPhases: leafStartPhases, estimate: estimateDraft, status: 'running', error: null }
            : d));
        const stash = { ...(currentRow()?.delegateSelfEfforts ?? {}), [member.member]: selfEffort };
        // [3.0.8] 开工证据与自配档同为任务级配置：delegates[].startPhases +
        // delegateStartPhases 双通道落档，重置保留、durable 回放（G1 双侧接线）。
        const startPhasesStash = { ...(currentRow()?.delegateStartPhases ?? {}), [member.member]: leafStartPhases };
        // [T6][契约v1 §3] 预估双通道：delegates[].estimate + delegateEstimates（任务级
        // 配置，重置保留、durable 回放），与 selfEffort/startPhases 同范式。
        const estimateStash = { ...(currentRow()?.delegateEstimates ?? {}), [member.member]: estimateDraft };
        persistSelf({ delegates: registerList, delegateSelfEfforts: stash, delegateStartPhases: startPhasesStash, delegateEstimates: estimateStash });
        /*
         * [T6][D9][契约v1 §4] 预估送达部门负责人：登记之后、interrupt/接续之前。
         * 路由 row.childId（部门行负责人会话），缺失回退 leaderId；两者皆缺 ⇒
         * ESTIMATE_DELIVERY_FAILED（显式，不静默）。投递失败 ⇒ delivery:'failed' 已落档
         * ＋显式报错，不接续 phase-1；重试只重投 failed（sent 幂等跳过，不重复投递）。
         * 留痕 kind='estimate' 走 channelJournal 统一入口；journal 写失败不掩盖投递结果
         * （ok:true 附 journal:{ok:false,...}，同 escalateDelegateLeaf journalInfo 口径）。
         */
        let estimateFinal = estimateDraft;
        let estimateJournalInfo = {};
        if (!estimateAlreadySent) {
            const headChildId = typeof row.childId === 'string' && row.childId ? row.childId : (typeof leaderId === 'string' ? leaderId : '');
            const estimateBody = `【第三层开工预估｜${member.member} → 部门负责人】子任务 ${subtaskId} 成员 ${member.member} 开工前预估：执行本人任务约需 ${rawMinutes} 分钟（整数分钟）。理由：${estimateReason || '无'}。该预估已登记，平台即将以自配档接续其正式执行。`;
            const estimateStartedAt = Date.now();
            let estimateMessageId = '';
            let estimateDeliveryError = '';
            if (!headChildId) {
                estimateDeliveryError = '部门行未登记负责人会话（childId 缺失）且父会话 leaderId 缺失，无法投递预估';
            }
            else {
                const estimateService = ctx.subagents;
                if (!estimateService || typeof estimateService.sendMessage !== 'function') {
                    estimateDeliveryError = '当前部署没有可用的 subagent 服务，无法投递预估';
                }
                else {
                    try {
                        estimateMessageId = String(await estimateService.sendMessage(agent, headChildId, [{ type: 'text', text: estimateBody }], { signal: new AbortController().signal }) ?? ''); // [T11] 缺陷②：预估投递携带有效 signal，消除 throwIfAborted
                    }
                    catch (error) {
                        estimateDeliveryError = truncate(error instanceof Error ? error.message : String(error), 500);
                    }
                }
            }
            const estimateLatencyMs = Date.now() - estimateStartedAt;
            const estimateDelivery = estimateDeliveryError ? 'failed' : 'sent';
            estimateFinal = { ...estimateDraft, delivery: estimateDelivery, ...(estimateMessageId ? { messageId: estimateMessageId } : {}) };
            const estimateList = (currentRow()?.delegates ?? [])
                .map((d) => ((d?.childId === childSession.id || (!d?.childId && d?.member === member.member)) ? { ...d, estimate: estimateFinal } : d));
            const estimateMap = { ...(currentRow()?.delegateEstimates ?? {}), [member.member]: estimateFinal };
            persistSelf({ delegates: estimateList, delegateEstimates: estimateMap });
            const estimateJournal = channelJournal({
                planId: record.plan.planId,
                subtaskId,
                kind: 'estimate',
                from: { sessionId: String(childSession.id), role: 'expert', member: member.member },
                to: { sessionId: headChildId, role: 'head' },
                body: estimateBody,
                data: { declaredMinutes: rawMinutes, ...(estimateReason ? { reason: estimateReason } : {}) },
                delivery: { status: estimateDelivery, ...(estimateMessageId ? { messageId: estimateMessageId } : {}), latencyMs: estimateLatencyMs, ...(estimateDeliveryError ? { code: 'DELIVERY_FAILED', error: estimateDeliveryError } : {}) },
            });
            estimateJournalInfo = estimateJournal.result.ok ? {} : { journal: { ok: false, code: estimateJournal.result.code, error: estimateJournal.result.error } };
            if (estimateDeliveryError) {
                return {
                    ok: false,
                    code: 'ESTIMATE_DELIVERY_FAILED',
                    subtaskId,
                    member: member.member,
                    error: `预估投递失败（预估已以 delivery:'failed' 落档，未接续执行）：${estimateDeliveryError}。请重试 self_effort（携带完整原子对：reasoningEffort＋complexityRationale＋startPhases＋timeNotice），重试将重新投递。`,
                    ...estimateJournalInfo,
                };
            }
        }
        /*
         * [2.5.2][T4b][D1] 负责人 agent 解析必须先于 interrupt，且用宿主同款安全
         * 访问器。根因（reports/D1-D2-root-cause-diagnosis.md §1）：旧实现在
         * interrupt 之后用属性访问 `(ctx as any).agents?.get?.(leaderId)`，而插件
         * inject 清单（host.ts）不含 'agents'——Cordis 上下文代理对未注入服务的
         * 属性访问直接抛 `cannot get property "agents" without inject`（可选链挡
         * 不住代理 getter 抛错）。异常发生在 interrupt 之后、startActivation 之前、
         * 且不在任何 try/catch 内 ⇒ 接续会话从未创建、失败台账路径不可达，四个
         * 叶子永久死亡。现在：
         *  ① 解析移到 interrupt 之前：ctx.get('agents') 安全访问器（宿主
         *     dsh-subagent / dsh-tool-jobs 同款范式），整体 try/catch；无 get 方法
         *     的上下文（旧测试夹具）回退属性访问，同样在 try/catch 内。
         *  ② 解析失败 ⇒ 不中断 phase-0；自配档与开工证据已登记保留
         *     （delegateSelfEfforts / delegateStartPhases 已 durable 落档，负责人
         *     重派该成员时读档直连 phase-1），显式返回
         *     SELF_EFFORT_CONTINUATION_FAILED，绝不静默。
         */
        let leaderAgent = null;
        try {
            const agentsService = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
            leaderAgent = agentsService?.get?.(leaderId) ?? null;
        }
        catch {
            leaderAgent = null;
        }
        if (!leaderAgent) {
            const message = '自配档与开工证据已登记，但负责人 agent 解析失败（agents 服务不可用）：phase-0 未被中断，登记保留——负责人可重派该成员，重派将读档直接以自配档接续 phase-1（禁止静默降档）';
            const failedList = (currentRow()?.delegates ?? [])
                .map((d) => ((d?.childId === childSession.id || (!d?.childId && d?.member === member.member)) ? { ...d, status: 'failed', error: truncate(message, 300), finishedAt: Date.now() } : d));
            persistSelf({ delegates: failedList });
            try {
                await emitDelegateTerminationNotices(record, leaderSession, rootSession, subtaskId, [{ childId: String(childSession.id ?? ''), kind: 'settlement-error', reason: message }]);
            }
            catch { /* 通知失败不改变失败返回 */ }
            return { ok: false, code: 'SELF_EFFORT_CONTINUATION_FAILED', subtaskId, member: member.member, selfEffort, error: message };
        }
        // 接续：中断 phase-0（ancestor authority, continuable），尽力而为。
        // [3.0.1] 优先新版 interrupt()（authority=负责人活体 Agent）；旧版宿主回退
        // interruptByParent。ancestorAgent 缺失时返回 false（与修复前静默跳过同口径）。
        interruptChildContinuable(ctx.subagents, childSession.id, leaderAgent, leaderId);
        const departmentLabel = DEPARTMENTS[row.department]?.zh ?? String(row.department ?? '部门');
        const assignment = (Array.isArray(row.consolidation?.assignments) ? row.consolidation.assignments : [])
            .find((a) => a?.member === member.member);
        const fullTask = assignment?.task ?? member.task;
        /*
         * [3.0.0][用户要求 6] 质量要求随 phase-1 任务书一起交给专家：优先取 review
         * 登记的分工表原文（含质量要求），缺省时取成员记录，再缺省为空数组
         * （由提示词侧 renderQualityRequirementsBlock 如实显示「未交代」）。
         */
        const qualityRequirements = Array.isArray(assignment?.qualityRequirements) && assignment.qualityRequirements.length > 0
            ? assignment.qualityRequirements
            : (Array.isArray(member?.qualityRequirements) ? member.qualityRequirements : []);
        const rulesBrief = buildLlmRulesBrief({ model, effort: selfEffort, requested: correction.adjusted ? raw : null, correctionReason: correction.reason ?? null, tier: 'delegate', memberName: member.member, memberRole: member.role });
        /*
         * [3.1.7] 接续证据分层（专家侧）：完整登记原文落盘，任务书只带执行蓝图 + 索引。
         * 写盘失败 ⇒ 空串 ⇒ 回退全文注入（旧行为），证据一条不丢。
         */
        const startEvidenceRef = persistStartEvidenceFile(typeof childSession.header?.cwd === 'string' ? childSession.header.cwd : '', record.plan?.planId, subtaskId, leafStartPhases);
        const promptText = buildDelegateePrompt({
            departmentLabel,
            leaderSubtaskId: subtaskId,
            leaderSubtaskTitle: String(row.title ?? ''),
            member: { member: member.member, role: 'expert', task: fullTask, qualityRequirements, effort: selfEffort },
            rulesBrief,
            cwd: typeof childSession.header?.cwd === 'string' ? childSession.header.cwd : '',
            leadSessionId: leaderId,
            /*
             * [3.1.6][治本] 接续必须携带「前三步的全部成果」，否则「不要重做」等于让
             * 专家闭着眼睛跳步：phase-0 会话是独立会话（宿主不继承上下文），phase-1
             * 看不到它读过什么、想过什么。旧文案只回注第二步 approach 的前 300 字符，
             * 等于只给了结论的零头却要求「不要重做」——局部（一句提示）与整体（证据
             * 链）自相矛盾。现在把消毒后的登记证据**原文全量**随接续注入（上限由
             * MAX_PHASE_LIST_ITEMS/MAX_PHASE_ITEM_CHARS 统一约束），并把「不要重做」
             * 限定为「登记证据已覆盖的部分」，覆盖不到的细节要求补齐而非重来。
             */
            extraContext: `【phase-0→phase-1 接续——继续勿重做（只补缺口）】你已在 phase-0 完成复杂度评估并自配推理等级 \`${selfEffort}\`（依据：${truncate(rationale, 300)}${correction.adjusted ? `；请求档 ${raw} 越界已被平台钳制为 ${selfEffort}` : ''}）。平台已按你的自配档接续（宿主另起执行会话，不是刚才那个 phase-0 评估会话）：不要重新评估复杂度；下方登记证据已覆盖的部分不要重做，登记范围之外的细节若缺失，先补齐再执行（只补缺口，不推倒重来）。正式执行必须严格按你第二步理清的方法、流程、步骤进行，全程少走弯路：先查历史教训、先验证再动手、不重复试错。

${startEvidenceRef
                ? renderStartEvidenceBrief(leafStartPhases, startEvidenceRef)
                : '\n【开工登记证据·原文（phase-0 已登记的完整前三步成果；收尾结果块的 phases.planning / phases.preparation 必须原样收录，再追加执行期新补充）】\n' + renderStartPhaseEvidence(leafStartPhases)}`,
        });
        // [3.0.1][P1a] 宿主 subagent.maxDepth < 2 时一次性告警（scope=计划根会话）。
        notifyDepthOverrideConflict(ctx, typeof rootId === 'string' ? rootId : null);
        let activation = null;
        let lastError = null;
        for (let i = 0; i < 2; i += 1) {
            try {
                // [2.5.5][治本] 第三处 spawn 同口径：spec 顶层契约（prompt/parent/cwd/agentOptions/maxDepth）。
                activation = await startActivationQueued(() => ctx.subagents.startActivation({
                    provider: 'spawn',
                    label: `${row.department}:${subtaskId}→${member.member}(self:${selfEffort})`.slice(0, 120),
                    prompt: [{ type: 'text', text: promptText }],
                    parent: leaderAgent ?? agent,
                    cwd: typeof childSession.header?.cwd === 'string' && childSession.header.cwd ? childSession.header.cwd : undefined,
                    agentOptions: {
                        ...(modelSelection?.provider && modelSelection?.model ? { provider: modelSelection.provider, model: modelSelection.model } : {}),
                        reasoningEffort: selfEffort,
                    },
                    maxDepth: 2,
                    /*
                     * [2.5.2][T4b][D1] 接续是平台驱动的重激活：signal 不得复用调用方
                     * （phase-0 回合）的 signal——phase-0 即将被 interrupt，复用会让接续
                     * 在 publication 前被连带取消。宿主契约 spec.signal 必填、语义只管
                     * publication 前取消 ⇒ 用独立不中止的控制器。
                     */
                    signal: new AbortController().signal,
                    delivery: 'caller',
                }), undefined, `自配档接续（成员 ${member.member}）`);
                break;
            }
            catch (error) {
                lastError = error;
            }
        }
        if (!activation) {
            // [3.0.1][P1b] 宿主并发上限单独翻译为可行动提示；其余错误走下方统一 PlanError。
            if (String(lastError?.code ?? '') === 'ACTIVATION_LIMIT_REACHED' || /limit reached/i.test(String(lastError?.message ?? ''))) {
                throw describeSubagentActivationError(lastError, `自配档接续（成员 ${member.member}）`);
            }
            const message = `自配档已登记但接续失败（已重试 1 次）：${String(lastError?.message ?? lastError)}——禁止静默降档；该成员记为 failed，负责人可重派（自配档保留，重派直接以自配档接续）`;
            const failedList = (currentRow()?.delegates ?? [])
                .map((d) => ((d?.childId === childSession.id || (!d?.childId && d?.member === member.member)) ? { ...d, status: 'failed', error: truncate(message, 300), finishedAt: Date.now() } : d));
            persistSelf({ delegates: failedList });
            try {
                await emitDelegateTerminationNotices(record, leaderSession, rootSession, subtaskId, [{ childId: String(childSession.id ?? ''), kind: 'settlement-error', reason: message }]);
            }
            catch { /* 通知失败不改变失败返回 */ }
            return { ok: false, code: 'SELF_EFFORT_CONTINUATION_FAILED', subtaskId, member: member.member, selfEffort, error: message };
        }
        const newChildId = typeof activation.childId === 'string' ? activation.childId : null;
        // [3.1.8][治本] 接续出来的新会话也要登记：后续重建后仍按新 childId 认亲。
        rememberActivation(ctx, newChildId, record.plan.planId, subtaskId);
        const continuedList = (currentRow()?.delegates ?? [])
            .map((d) => ((d?.childId === childSession.id || (!d?.childId && d?.member === member.member)) ? { ...d, childId: newChildId, status: 'running', startedAt: Date.now(), finishedAt: null, error: null } : d));
        const written = persistSelf({ delegates: continuedList });
        if (activation && typeof activation.result?.then === 'function') {
            // [T8] 结算回调异步化：完成即时通知经 sendMessage 定向投递（T5 契约）。
            activation.result.then(async (outcome) => {
                try {
                    const completed = outcome?.stopReason === 'completed';
                    // [3.0.0] F10：专家汇报入口强制核验（adjudicateExpertReport），
                    // 未过即退回（failed + F10 拒因），绝不记 done。
                    const f10 = completed ? adjudicateExpertReport(outcome) : { ok: true };
                    const settledDone = completed && f10.ok;
                    const termination = classifyDelegateTermination(outcome, completed ? f10 : null);
                    const current = (record.statuses ?? []).find((item) => item?.subtaskId === subtaskId);
                    const list = (Array.isArray(current?.delegates) ? current.delegates : [])
                        .map((item) => (item?.childId === newChildId
                        // [T5-channel] 与 delegateTool 结算同款：待指示优先于结算——escalation
                        // 子对象存在即请示未答复，不得覆盖成 done/failed（契约v1 权威形状）。
                        ? (item?.escalation
                            ? item
                            : { ...item, status: settledDone ? 'done' : 'failed', closure: null, summary: truncate(resultText(outcome), 300), error: settledDone ? null : truncate(f10.ok ? String(outcome?.diagnostic ?? `子会话结束状态 ${outcome?.stopReason}`) : f10.rejection, 300), finishedAt: Date.now() })
                        : item));
                    const revision = Number(current?.revision ?? 0) + 1;
                    record.statuses = applyStatus(record.statuses, subtaskId, { delegates: list, revision, updatedBy: 'child' });
                    record.updatedAt = Date.now();
                    appendUserMessage(rootSession, buildUpdateMessage({ planId: record.plan.planId, subtaskId, status: current?.status ?? row.status, delegates: list, revision }));
                    // [T8] 与 delegateTool 结算同款：完成即时通知 → 原分派负责人会话（leaderId）。
                    await emitDelegateDoneNotices(record, ctx.sessions?.get?.(String(leaderId ?? '')) ?? leaderSession, rootSession, subtaskId);
                    if (!settledDone && newChildId) {
                        await emitDelegateTerminationNotices(record, ctx.sessions?.get?.(String(leaderId ?? '')) ?? leaderSession, rootSession, subtaskId, [{ childId: newChildId, kind: termination.kind, reason: termination.reason }]);
                    }
                }
                catch (error) {
                    /*
                     * [T4][F4] 不再静默吞错：结算链失败必须留下可读审计行（含 childId 与
                     * 阶段），否则「台账为什么停在 running」永远无法事后解释。
                     */
                    record.errors = [
                        ...(record.errors ?? []),
                        settlementCallbackFailureLine({ subtaskId, childId: newChildId, stage: 'self_effort-settlement', error }),
                    ].slice(-20);
                }
            }).catch((error) => {
                record.errors = [
                    ...(record.errors ?? []),
                    settlementCallbackFailureLine({ subtaskId, childId: newChildId, stage: 'self_effort-settlement-outer', error }),
                ].slice(-20);
            });
        }
        return {
            ok: true,
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
            subtaskId,
            action: 'self_effort',
            member: member.member,
            selfEffort,
            requested: raw,
            ...(correction.adjusted ? { clamped: { requested: raw, corrected: selfEffort, reason: correction.reason } } : {}),
            childId: newChildId,
            delegates: written?.delegates ?? continuedList,
            // [T6][契约v1 §2/§4] 成功回执附预估（declaredMinutes/reason?/delivery）；
            // 留痕写失败不掩盖投递结果（journal:{ok:false,...}，同 escalateDelegateLeaf 口径）。
            estimate: { declaredMinutes: estimateFinal.declaredMinutes, ...(estimateFinal.reason ? { reason: estimateFinal.reason } : {}), delivery: estimateFinal.delivery },
            ...estimateJournalInfo,
            hint: `自配档 \`${selfEffort}\` 已登记并以该档接续 phase-1（继续勿重做）。请执行正式任务，完成后把结论回报部门负责人会话。`,
        };
    }
    async function delegateTool(agent, args, signal) {
        const childSession = agent?.session;
        if (!childSession?.id) {
            return { ok: false, code: 'NO_SESSION', error: '只能在会话内使用第三层派发' };
        }
        // [2.5.0][自配档] self_effort 是叶子专属动作：先于负责人校验路由。
        if (args?.action === 'self_effort')
            return selfEffortTool(agent, args, signal);
        const parentId = childSession.header?.parentSession;
        if (!parentId) {
            return {
                ok: false,
                code: 'NOT_LEADER_SESSION',
                error: '只有「部门负责人子会话」可以使用 dsh_workplan_delegate：根会话请用 dsh_workplan_dispatch 派发主计划；第三层全球顶尖专家是叶子层，不得再派发（用户要求 4：只有一层下级）。',
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
                error: '父会话没有可关联的计划。若你是第三层全球顶尖专家（叶子层）：不得再派发，完成自身任务后把结论回报部门负责人即可。',
            };
        }
        let row = (record.statuses ?? []).find((item) => item?.childId === childSession.id);
        if (!row) {
            /*
             * [3.1.8][治本] 认亲兜底：台账在派发后被重建替换时，durable 日志里可能还
             * 没有这个 childId（旧实现把它只写在内存）。这时按「派发实例表」找回
             * 本会话对应的子任务行——它是同一进程内的客观事实，不随台账重建丢失。
             * 找回后立刻把 childId 补写进 durable 日志，下一次重建就能自证身份。
             */
            const activation = recallActivation(ctx, childSession.id);
            if (activation?.subtaskId) {
                row = (record.statuses ?? []).find((item) => item?.subtaskId === activation.subtaskId);
                if (row)
                    persistChildIdentity(ctx, record, parentId, row.subtaskId, childSession.id);
            }
        }
        if (!row) {
            /*
             * 第二道兜底：负责人换主后旧会话会被记进 childIdHistory（U-71 留档）。
             * 旧会话若再次操作，按历史记录认回自己的行，而不是判它「查无此人」。
             */
            const historical = (record.statuses ?? []).find((item) => Array.isArray(item?.childIdHistory)
                && item.childIdHistory.some((entry) => entry?.childId === childSession.id));
            if (historical) {
                row = historical;
                persistChildIdentity(ctx, record, parentId, historical.subtaskId, childSession.id);
            }
        }
        if (!row) {
            return {
                ok: false,
                code: 'NO_SUBTASK',
                error: '计划里找不到与本子会话关联的子任务行（childId 未登记）；第三层派发只能由计划内的部门负责人子会话发起。',
            };
        }
        if (row.status === 'done') {
            return { ok: false, code: 'ALREADY_DONE', subtaskId: row.subtaskId, error: '该子任务已完成，不能再派发第三层。' };
        }
        const action = ['review', 'dispatch', 'direct', 'status'].includes(args?.action) ? String(args.action) : '';
        if (!action) {
            return { ok: false, code: 'INVALID_ACTION', error: 'action 必须是 review（提交全面梳理产物）/ dispatch（派发给本部门全球顶尖专家）/ direct（low 任务负责人亲自执行登记）/ status（查看梳理与下级进度）' };
        }
        const subtaskId = String(row.subtaskId);
        // [2.5.5][T3] D1 兜底：任务行记录等级。计划形状＝stages[].subtasks[]（不存在
        // record.plan.subtasks 平铺数组），复用 findSubtaskById（本文件 :1547）。
        // 五档消毒：非法/缺失一律 undefined（视同未配置），不把脏值传进判定链。
        const plannedRow = findSubtaskById(record.plan, subtaskId);
        const taskRowEffort = typeof plannedRow?.reasoningEffort === 'string'
            && REASONING_EFFORTS.includes(plannedRow.reasoningEffort)
            ? plannedRow.reasoningEffort
            : undefined;
        const modelSelection = resolveModelSelection(ctx, { agent });
        const model = typeof modelSelection?.model === 'string' && modelSelection.model.trim() ? modelSelection.model.trim() : null;
        const parentSession = ctx.sessions?.get?.(parentId);
        /*
         * [3.1.7][P0 U-63] 写前重读：persist 不再用闭包里的旧 row 算 revision。
         * 结算回调可能在 await 期间已经把同一行推进（rev+1、delegates 已结算），
         * 旧快照会让本次写入基于过期 revision，并把新结果整表盖掉。
         * liveRow() 每次从 record.statuses 现读，保证「读—改—写」在同一份事实上。
         */
        const liveRow = () => (record.statuses ?? []).find((item) => item?.subtaskId === subtaskId) ?? row;
        const persist = (patch) => {
            // [3.1.7][P0 U-64/U-68] delegates 走条目级单调合并，绝不整表覆盖。
            const effectivePatch = { ...patch };
            if (patch.delegates !== undefined) {
                const currentRow = liveRow();
                const merged = mergeDelegateEntriesMonotonic(currentRow?.delegates, patch.delegates);
                effectivePatch.delegates = merged.value;
            }
            const baseRevision = Number(liveRow()?.revision ?? row.revision ?? 0);
            const revision = baseRevision + 1;
            record.statuses = applyStatus(record.statuses, subtaskId, { ...effectivePatch, revision, updatedBy: 'child' });
            record.updatedAt = Date.now();
            try {
                const written = record.statuses.find((item) => item?.subtaskId === subtaskId);
                appendUserMessage(parentSession, buildUpdateMessage({
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    subtaskId,
                    status: written?.status ?? row.status,
                    ...(effectivePatch.consolidation === undefined ? {} : { consolidation: written?.consolidation }),
                    // [3.0.8] 行级开工证据随 durable workplan-update 落盘（与 consolidation 同口径）。
                    ...(effectivePatch.startPhases === undefined ? {} : { startPhases: written?.startPhases }),
                    ...(effectivePatch.delegates === undefined ? {} : { delegates: written?.delegates }),
                    // [2.5.4][T3R1] 门禁审计随 durable workplan-update 落盘（A3 可复核）。
                    ...(effectivePatch.gateAudit === undefined ? {} : { gateAudit: written?.gateAudit }),
                    // [2.5.0] 整体任务等级随 durable workplan-update 回放，重启不丢。
                    ...(effectivePatch.effortOverride === undefined ? {} : { effortOverride: written?.effortOverride }),
                    revision: written?.revision ?? revision,
                }));
            }
            catch (error) {
                pushRecordError(record, error);
            }
            const fresh = record.statuses.find((item) => item?.subtaskId === subtaskId);
            // [3.1.7][P0 U-63/U-65] 写后把 row 指向最新行：后续门禁/返回体不再读旧快照。
            if (fresh)
                row = fresh;
            return fresh;
        };
        /*
         * [2.5.4][T3R1] 门禁审计记录器（T3 A3）：review/dispatch 的每次拒绝都经
         * persist 留痕（durable workplan-update + applyStatus 消毒，有界 20 条）。
         * 放行记录并入各自动作既有的 persist 补丁（review 登记/dispatch 台账），
         * 避免同一动作二次 persist 造成 revision 竞争。
         * [3.1.7][P0 U-69] prior 改为写前现读，避免并发门禁互相覆盖审计条目。
         */
        const recordGate = (gateAction, ok, code) => {
            const prior = Array.isArray(liveRow()?.gateAudit) ? liveRow().gateAudit : [];
            const entry = { at: Date.now(), action: gateAction, ok, code: ok ? null : String(code ?? 'UNKNOWN') };
            return persist({ gateAudit: [...prior, entry].slice(-20) });
        };
        /*
         * [T6] 入口一次对账（唯一写入口，事件驱动）：review 的闸只读 consolidation/
         * startPhases，不读 delegates[].status；status / dispatch / direct 三个动作
         * 的全部读取面都依赖它。收敛后必须把 row 指向持久化后的新行，后续门禁才
         * 读到新值。本入口自身无定时器、无超时、无轮询；D5 的 120s 巡检只负责
         * 把已终止成员收敛成终态并通知，不参与本入口的结算判定。
         * 同一台账二次进入 changed=false（幂等）。
         */
        const entryReconciliation = ['status', 'dispatch', 'direct'].includes(action)
            ? (() => {
                const settled = collectSettledSnapshots(childSession);
                return reconcileEndedDelegateSessions(row.delegates, (childId) => ctx.sessions?.get?.(childId), (childId) => settled.get(childId));
            })()
            : null;
        if (entryReconciliation?.changed) {
            row = persist({ delegates: entryReconciliation.delegates });
            const failedReconciled = entryReconciliation.reconciled.filter((item) => item?.status === 'failed');
            if (failedReconciled.length > 0) {
                await emitDelegateTerminationNotices(record, ctx.sessions?.get?.(String(row.childId ?? '')) ?? childSession, parentSession, subtaskId, failedReconciled.map((item) => ({ childId: String(item.childId), kind: 'reconciled', reason: '读时对账确认：会话已结束，但结果块未通过核验' })));
            }
        }
        /*
         * [3.0.5] 用户改进方案 1/2 的硬机制：第三层任何专家进入「待指示」后，部门负责
         * 人不得借 review/dispatch/direct 把相关问题改派、重派或降级给其他人；必须先
         * 全面梳理该问题与本部门全部 delegates 执行状态，研究方案后用 dsh_workplan_
         * instruct 答复原成员，由原成员继续执行。这里硬拒的是「换人/重派」动作，
         * status 仍放行，保证负责人能看到当前所有任务状态并履行研究义务。
         */
        // [3.1.7][P0 U-65] 待指示门禁写前现读：入口对账里有 await（终止通知投递），
        // 期间 instruct/escalate 可能已改变 delegates；用闭包旧 row 会漏判或误判。
        const gateRow = liveRow();
        const openEscalations = (Array.isArray(gateRow?.delegates) ? gateRow.delegates : [])
            .filter((item) => Boolean(item?.escalation) || item?.closure === 'escalated');
        if (openEscalations.length > 0 && ['review', 'dispatch', 'direct'].includes(action)) {
            const members = openEscalations.map((item) => String(item?.member ?? '?'));
            recordGate(action, false, 'DELEGATE_ESCALATION_OPEN');
            return {
                ok: false,
                code: 'DELEGATE_ESCALATION_OPEN',
                subtaskId,
                members,
                delegates: gateRow?.delegates,
                error: `第三层已有成员待指示（${members.join('、')}）：禁止改派、重派或降级给其他人。`
                    + '必须先全面梳理该成员遇到的问题与本部门全部已派发任务的执行状态，研究形成解决方案后，'
                    + '用 dsh_workplan_instruct 答复原成员；平台会强制由原成员继续执行。',
                hint: '先用 action="status" 查看全部 delegates；对每位待指示成员执行 dsh_workplan_instruct（subtaskId=本部门行 ID，member=待指示成员）。待指示清零后才允许 review/dispatch/direct。',
            };
        }
        if (action === 'status') {
            /*
             * [T6] 对账已在入口（recordGate 之后、待指示门禁之前）完成：这里只消费
             * 同一份结果做报告，不再二次采集/对账/写台账，避免双写与 revision 竞争。
             */
            // [3.1.7][P2 U-61] status 返回体写前现读：不再返回入口那一刻的旧快照。
            const statusRow = liveRow();
            const delegates = Array.isArray(statusRow?.delegates) ? statusRow.delegates : [];
            /*
             * [T4][F5] 历史不追溯：收敛只发生在本次 status 读时；既拿不到活体会话、
             * 又没有持久结算快照的旧行不会被静默改写。这里如实列出并给出人工入口。
             *
             * [3.1.7][P3 U-62] 响应体不再把同一份信息抄三遍（T6 R04）。
             * delegates 里已经含每个成员的 status/reconciledAt/reconciledFrom/
             * summary/error，旧实现又把 entryReconciliation.reconciled/unresolved
             * 整组复制进 delegateReconciliation，每次 status 多 0.5–1 KB 重复计费。
             * 现在只留计数 + 无法追溯行的成员名与原因（那是 delegates 里没有的
             * 「为什么没被自动收敛」信息，必须保活），reconciled 明细不再重发——
             * 需要逐条核对时读 delegates[].reconciledAt/reconciledFrom 即可。
             */
            const reconciledList = entryReconciliation?.reconciled ?? [];
            const unresolvedList = entryReconciliation?.unresolved ?? [];
            const delegateReconciliation = {
                reconciledCount: reconciledList.length,
                unresolved: unresolvedList,
                ...(unresolvedList.length > 0
                    ? { note: '以下下级的子会话已释放且没有持久结算快照：历史行不会被自动改写，请人工用 dsh_workplan_update 补判或重新派发。' }
                    : {}),
            };
            return {
                ok: true,
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                action,
                consolidation: statusRow?.consolidation ?? null,
                effortOverride: statusRow?.effortOverride ?? null,
                // [2.5.4][T3R1] 门禁审计对负责人可见（A3：拒绝/放行记录可复核）。
                gateAudit: Array.isArray(statusRow?.gateAudit) ? statusRow.gateAudit : [],
                delegates,
                // [3.0.5] 待指示成员清单：负责人履行「先梳理全部任务状态」义务的读取面。
                openEscalations: openEscalations.map((item) => String(item?.member ?? '?')),
                // [T4][F5] 本次读时收敛的台账与无法追溯的历史行（见上）。
                delegateReconciliation,
                // [T7][lead-decisions J2] 负责人时长聚合：与看板/模型面同一读时派生纯函数
                // （J1 冻结结构；null＝无下属分工/replanned 旧行/越界 fail-closed，J8/R8）。
                leaderEstimate: deriveLeaderEstimate(statusRow),
                // [2.5.5][T3] low 直执分支（派生判据，不新增持久化标记）：effortOverride='low'
                // 且分工表为空/缺失 ⇒ low 直执；复杂任务被钳制到 low 的行（assignments 非空）
                // 不命中，避免误导（规格 §5.6）。
                hint: row.effortOverride === 'low' && (!Array.isArray(row.consolidation?.assignments) || row.consolidation.assignments.length === 0)
                    ? 'low 任务（含视同 low）：禁止第三层下派，负责人亲自执行；开工证据 startPhases 经 action="direct" 登记（已登记则直接执行）。'
                    : !row.consolidation
                        ? '尚未提交梳理产物：先调用 action="review"（用户要求 4 的硬门禁）。'
                        : delegates.length === 0
                            ? '梳理产物已登记，可调用 action="dispatch" 正式派发给本部门全球顶尖专家。'
                            : openEscalations.length > 0
                                ? `第三层已有 ${openEscalations.length} 名成员待指示（${openEscalations.map((item) => String(item?.member ?? '?')).join('、')}）：按 3.0.5 硬规则禁止 review/dispatch/direct 改派；必须先全面梳理该问题与本部门全部任务状态，研究方案后用 dsh_workplan_instruct 答复原成员，由原成员继续执行。`
                                : '第三层已派发；各下级结论会送回本会话，收齐后汇总核验，再写最终结果块。用 action="status" 查看进度。成员遇阻会经 dsh_workplan_escalate 在你这里落「待指示」：必须当轮用 dsh_workplan_instruct（subtaskId=本部门行 ID，多个成员同时请示时加 member）答复，投递成功后该成员恢复执行。',
            };
        }
        /*
         * [2.5.5][T3] 用户裁决 D2/D4：low 任务负责人亲自执行登记（direct）。
         * low（含视同 low）任务禁止第三层下派——planDelegations 禁派闸对 review/dispatch
         * 一律硬拒（DELEGATE_LOW_TASK_FORBIDDEN）；负责人亲自执行，五步第 1/2/3 步开工
         * 证据经本动作登记（复用 validateStartPhaseEvidence，与主 Agent/叶子/review
         * 同一判据）。登记 effortOverride='low' ⇒ phase-0 结算闸（runSubtaskAttempt 内
         * SELF_EFFORT_MISSING 分支）只查 effortOverride 非空，逻辑零改动即可接续。
         * 防旁路（规格 §5.8）：不收 consolidation/分工表；只接受 reasoningEffort='low'
         * （缺省默认 low）；已有复杂分工表的行不得降级；下级 running 中不得改走；
         * 叶子调用在上方调用者边界命中 NOT_LEADER_SESSION/NO_PLAN。无任何例外通道（D5）。
         */
        if (action === 'direct') {
            // [3.1.7][P0 U-65] running 闸写前现读（入口对账含 await，旧 row 可能过期）。
            const directGateRow = liveRow();
            if (Array.isArray(directGateRow?.delegates) && directGateRow.delegates.some((item) => item?.status === 'running')) {
                recordGate('direct', false, 'DELEGATE_ALREADY_RUNNING');
                return {
                    ok: false,
                    code: 'DELEGATE_ALREADY_RUNNING',
                    subtaskId,
                    error: '第三层仍在派发中（有下级 running）：不能改走 low 直执。先等当前下级结算（action="status" 查看进度）。',
                };
            }
            const priorAssignments = Array.isArray(row.consolidation?.assignments) ? row.consolidation.assignments : [];
            if (priorAssignments.length > 0) {
                recordGate('direct', false, 'DELEGATE_DIRECT_CONFLICT');
                return {
                    ok: false,
                    code: 'DELEGATE_DIRECT_CONFLICT',
                    subtaskId,
                    error: '本行已登记非空分工表（复杂流程已启动）：不得降级改走 low 直执。复杂任务请继续 review/dispatch；low 禁派闸只拦 low/视同 low 任务。',
                };
            }
            if (args?.consolidation !== undefined && args?.consolidation !== null) {
                recordGate('direct', false, 'DELEGATE_DIRECT_ASSIGNMENTS_FORBIDDEN');
                return {
                    ok: false,
                    code: 'DELEGATE_DIRECT_ASSIGNMENTS_FORBIDDEN',
                    subtaskId,
                    error: 'direct 不接受 consolidation/分工表（low 任务禁止下派，用户裁决 D2）：只提交 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }（第 1/2/3 步证据，字数下限：' + START_EVIDENCE_MIN_CHARS_BRIEF + '）与可选 reasoningEffort="low"。',
                };
            }
            const startCheck = validateStartPhaseEvidence(args?.startPhases);
            if (!startCheck.ok || !startCheck.evidence) {
                const code = startCheck.code === 'START_EVIDENCE_MISSING' ? 'DELEGATE_DIRECT_START_MISSING' : 'DELEGATE_DIRECT_START_INCOMPLETE';
                recordGate('direct', false, code);
                return {
                    ok: false,
                    code,
                    subtaskId,
                    error: `${startCheck.error ?? '开工证据缺失或不合格。'}（direct 登记与主 Agent/叶子同一判据：${START_EVIDENCE_MIN_CHARS_BRIEF}。）`,
                };
            }
            const directEffortRaw = args?.reasoningEffort;
            if (directEffortRaw !== undefined && directEffortRaw !== null && directEffortRaw !== 'low') {
                recordGate('direct', false, 'DELEGATE_DIRECT_EFFORT_INVALID');
                return {
                    ok: false,
                    code: 'DELEGATE_DIRECT_EFFORT_INVALID',
                    subtaskId,
                    error: `direct 只接受 reasoningEffort="low"（缺失默认 low）；"${String(directEffortRaw)}" 不被接受。复杂任务（medium/high/xhigh/max）请走 review+dispatch（≥8 人闸），direct 不是复杂任务通道。`,
                };
            }
            const hadEffortOverride = typeof row.effortOverride === 'string' && row.effortOverride.length > 0;
            const written = persist({
                // [3.0.8] 第 1/2/3 步开工证据存行级 startPhases（结算一致性比对读档用）。
                startPhases: startCheck.evidence,
                consolidation: {
                    assignments: [], // 空分工表＝直执标记（派生判据，规格 §5.6）
                    taskReasoningEffort: 'low',
                    submittedAt: Date.now(),
                },
                effortOverride: 'low',
                gateAudit: [...(Array.isArray(liveRow()?.gateAudit) ? liveRow().gateAudit : []), { at: Date.now(), action: 'direct', ok: true, code: null }].slice(-20),
            });
            // 中断镜像 review 的 stall-fix 口径：仅「本次登记前尚无 effortOverride」
            // （真正的 phase-0→登记转变）才中断；phase-1 重新 direct 只更新产物。
            // [3.0.1] 优先新版 interrupt()（ancestor=执行本工具的活体负责人 agent）。
            if (!hadEffortOverride)
                interruptChildContinuable(ctx.subagents, childSession.id, agent, parentId);
            return {
                ok: true,
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                action: 'direct',
                effortOverride: 'low',
                consolidation: written?.consolidation ?? null,
                hint: 'low 直执已登记（durable，刷新后门禁依然生效）：平台将以 low 档接续（宿主另起执行会话并携带本阶段产物）进入 phase-1。负责人亲自执行本任务，禁止再调用 review/dispatch（low 禁派闸会硬拒）；完成后按五步契约提交证据与结论。',
            };
        }
        if (action === 'review') {
            const input = isRecord(args?.consolidation) ? args.consolidation : null;
            if (!input) {
                return {
                    ok: false,
                    code: 'MISSING_CONSOLIDATION',
                    subtaskId,
                    error: `review 必须携带 consolidation 分工表：{ assignments[{member, role:"expert", task, qualityRequirements[], reasoningEffort}] }，并随附 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }——五步第 1/2/3 步开工证据（第一步任务梳理；第二步基于第一步全部结果研究资源、工具与具体实施方案；第三步把资源与工具真正备齐并给出就绪证据）+ 分工表（至少 1 名、最多 ${MAX_COMPLEX_DELEGATE_MEMBERS} 名本部门全球顶尖专家；组员角色已取消；每项任务必须极简并附质量要求）。`,
                };
            }
            // [3.0.8] 负责人 review 开工闸：与 direct/dispatch/self_effort 同一
            // validateStartPhaseEvidence 判据，缺交/不合格硬拒，不登记。
            const reviewStartCheck = validateStartPhaseEvidence(args?.startPhases);
            if (!reviewStartCheck.ok) {
                recordGate('review', false, reviewStartCheck.code ?? 'START_EVIDENCE_INCOMPLETE');
                return {
                    ok: false,
                    code: reviewStartCheck.code ?? 'START_EVIDENCE_INCOMPLETE',
                    subtaskId,
                    error: `开工证据${reviewStartCheck.code === 'START_EVIDENCE_MISSING' ? '缺失' : '不合格'}：部门负责人执行自己的任务前必须先完成五步前三步（任务梳理 + 资源/工具/方案研究 + 准备就绪），随 review 一并提交 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }。${reviewStartCheck.error ?? ''}`,
                };
            }
            // [2.5.0][R2×R4] 重新 review 未再配整体等级时，继承行上已持久化的
            // effortOverride（重置不清除的任务级配置），全程贯穿不丢。
            // [2.5.5][T3] 防注入：钳制前声明记忆只由平台写入，review 新输入不得携带
            // （否则 {taskReasoningEffort:'low', taskReasoningEffortDeclared:'max'} 可绕过禁派闸）。
            const { taskReasoningEffortDeclared: _stripped, ...reviewInput } = input;
            const preview = planDelegations({ consolidation: reviewInput, model, taskEffortFallback: row.effortOverride, taskRowEffort });
            if (!preview.ok) {
                // [2.5.4][T3R1] 门禁拒绝留痕（A3）：薄产物/缺产物都记入 gateAudit。
                recordGate('review', false, preview.code ?? 'DELEGATE_CONSOLIDATION_INVALID');
                return {
                    ok: false,
                    code: preview.code ?? 'DELEGATE_CONSOLIDATION_INVALID',
                    subtaskId,
                    error: preview.error,
                    hint: '修正梳理产物后重新 action="review"；未登记前 action="dispatch" 会持续被硬门禁拒绝。',
                };
            }
            // [2.5.2][stall-fix] 中断判据快照：本次 review 之前是否已登记整体档。
            const hadEffortOverride = typeof row.effortOverride === 'string' && row.effortOverride.length > 0;
            const written = persist({
                // [3.0.8] 负责人开工证据存行级 startPhases（结算一致性比对读档用）。
                startPhases: reviewStartCheck.evidence,
                consolidation: {
                    assignments: input.assignments,
                    // [2.5.0] 整体任务等级随梳理产物留档，dispatch 读回时同口径消费。
                    ...(preview.taskEffort ? { taskReasoningEffort: preview.taskEffort } : {}),
                    // [2.5.5][T3] 钳制前声明记忆随梳理产物留档：dispatch 读回时防
                    // 「非 qwen medium 钳制后 low」误杀复杂声明（规格 §3.4）。
                    ...(preview.taskEffortDeclared ? { taskReasoningEffortDeclared: preview.taskEffortDeclared } : {}),
                    submittedAt: Date.now(),
                },
                // [2.5.0] 用户要求 2：负责人配置的整体等级写入状态行，本任务每次
                // 派发/重试/续跑优先读它（resolveTaskEffort），全程生效、durable 回放。
                ...(preview.taskEffort ? { effortOverride: preview.taskEffort } : {}),
                // [2.5.4][T3R1] 门禁放行留痕（A3）：合格梳理登记成功记入 gateAudit。
                gateAudit: [...(Array.isArray(liveRow()?.gateAudit) ? liveRow().gateAudit : []), { at: Date.now(), action: 'review', ok: true, code: null }].slice(-20),
            });
            /*
             * [2.5.0][自配档] 登记后立即中断 phase-0 回合（parent authority, continuable）；
             * runSubtaskAttempt 检测到 effortOverride 即以自配档接续 phase-1。尽力而为：
             * interrupt 不可用时 phase-0 自然结束，平台接续仍然成立。
             *
             * [2.5.2][stall-fix] 根因修复（用户报告「提交任务后长时间无反应」）：
             * 旧实现只要 preview.taskEffort 非空就中断——负责人已在 phase-1 时重新
             * review（哪怕等级不变）也会触发中断，而接续逻辑只存在于 phase-0 结算
             * 分支：phase-1 回合被中断后无人接续，子会话 aborted、产物丢失、台账
             * blocked，用户看到的就是长时间停滞。现在仅当「本次 review 之前尚未
             * 登记 effortOverride」（真正的 phase-0→登记 转变）才中断；phase-1 的
             * 重新 review 只更新梳理产物，绝不中断正在执行的回合。
             */
            // [3.0.1] 优先新版 interrupt()（ancestor=执行本工具的活体负责人 agent）。
            if (preview.taskEffort && !hadEffortOverride)
                interruptChildContinuable(ctx.subagents, childSession.id, agent, parentId);
            return {
                ok: true,
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId,
                action,
                consolidation: written?.consolidation ?? null,
                members: preview.members,
                clamped: preview.clamped,
                taskEffort: preview.taskEffort,
                ...(preview.taskEffortClamped ? { taskEffortClamped: preview.taskEffortClamped } : {}),
                model: model ?? '（未知，未施加静态等级约束）',
                hint: '分工表与开工证据已登记（durable，刷新后门禁依然生效）。现在可调用 action="dispatch" 正式派发；每位下级的推理等级已按当前模型家族合法集合钳制（clamped 列出越界修正与原因，留痕可审计）。'
                    + (preview.taskEffort ? `整体任务等级已配置为 ${preview.taskEffort}（负责人自配档），本任务重试/续跑全程沿用；下级以 self_effort 自配为权威。` : '未配置整体任务等级：负责人须按先配置后开工经 review 自配（consolidation.taskReasoningEffort）；下级经 self_effort 自配。'),
            };
        }
        // action === 'dispatch'
        const consolidation = isRecord(row.consolidation) ? row.consolidation : null;
        // [2.5.0][R2×R4] dispatch 读回梳理产物时，整体等级缺失同样回落行上
        // effortOverride（durable 回放/重置后依然全程贯穿）。
        const delegationPlan = planDelegations({ consolidation, model, taskEffortFallback: row.effortOverride, taskRowEffort });
        if (!delegationPlan.ok) {
            // [2.5.4][T3R1] 分派门禁拒绝留痕（A3）：未梳理/薄产物一律记录拒因。
            recordGate('dispatch', false, delegationPlan.code ?? 'DELEGATE_CONSOLIDATION_MISSING');
            return {
                ok: false,
                code: delegationPlan.code ?? 'DELEGATE_CONSOLIDATION_MISSING',
                subtaskId,
                error: delegationPlan.error,
            };
        }
        // [3.1.7][P0 U-65/U-68] running 闸写前现读：同批并发派发时，先到的那一批
        // 已把成员写成 running，后到的必须看见（旧 row 快照会让两批同时通过闸）。
        const dispatchGateRow = liveRow();
        if (Array.isArray(dispatchGateRow?.delegates) && dispatchGateRow.delegates.some((item) => item?.status === 'running')) {
            return {
                ok: false,
                code: 'DELEGATE_ALREADY_RUNNING',
                subtaskId,
                error: '第三层已在派发中（仍有下级 running）：不要重复派发。用 action="status" 查看进度；如需补派新成员，先等当前下级结算。',
                delegates: dispatchGateRow.delegates,
            };
        }
        const departmentLabel = DEPARTMENTS[row.department]?.zh ?? String(row.department ?? '部门');
        // cwd 与 dispatchTool 同源（session.header.cwd，7465 行同款）：优先负责人
        // 子会话自己的工作目录，缺失回退根会话；都没有则交给宿主按 parent 推导。
        const cwd = typeof childSession.header?.cwd === 'string' && childSession.header.cwd
            ? childSession.header.cwd
            : (typeof parentSession?.header?.cwd === 'string' && parentSession.header.cwd
                ? parentSession.header.cwd
                : undefined);
        const delegates = [];
        /*
         * [3.1.8][P0 D2] 派发即登记（内存侧）：每个成员在 startActivation **之前**
         * 先以 childId=null 的 running 条目进入台账，叶子 phase-0 立刻调用
         * self_effort 时就能按成员名/父会话认亲，不再等整批循环结束。
         *
         * 只做内存 applyStatus，不发用户可见消息（否则 9 名成员会刷 9 条）；循环末
         * 仍走原有 persist 一次性写 durable。合并用 mergeDelegateEntriesMonotonic，
         * 避免把 await 期间已结算的条目整表盖掉。
         */
        const registerDelegatesInMemory = () => {
            try {
                const currentRow = liveRow();
                /*
                 * [3.1.8][P0 D2 重派] 旧条目若已是 failed/rejected/timeout/blocked，
                 * merge 的终态优先会把 childId=null 的新占位挡回去；先按占位替换旧
                 * 终态（待指示/done 不动），重派窗口内 self_effort 才能按成员名认亲。
                 */
                const base = prepareDelegateRegistrationBase(currentRow?.delegates, delegates);
                const merged = mergeDelegateEntriesMonotonic(base, delegates);
                const revision = Number(currentRow?.revision ?? 0) + 1;
                record.statuses = applyStatus(record.statuses, subtaskId, {
                    delegates: merged.value,
                    revision,
                    updatedBy: 'child',
                });
                record.updatedAt = Date.now();
            }
            catch (error) {
                record.errors = [
                    ...(record.errors ?? []),
                    `dispatch.childId-register: ${truncate(String(error?.message ?? error), 300)}`,
                ].slice(-20);
            }
        };
        // [3.1.0] 排队可见化：派发期间每次「首次退避」记一条用户可见通知，循环结束
        // 后统一投递（不在工具执行中途重入会话事件流）；每成员至多一条，防刷屏。
        const queueNotices = [];
        let skippedDone = 0;
        /*
         * [2.5.0][R4] 重试/续跑不丢已完成部分（第三层落点）：重派时 row.delegates
         * 仍是上一次尝试的台账——为每位下级附上次状态/失败原因/已回报结论与已核实
         * 在盘产物（buildDelegateRetryBrief），经 extraContext 写进新任务书。
         * 旧实现这里直接发全新任务书，叶子失败后重派只能整步重跑。
         */
        const priorDelegates = Array.isArray(row.delegates) ? row.delegates : [];
        // [3.0.8] retry brief 的负责人执行蓝图改从行级 startPhases.planning.approach
        // 读取（consolidation 不再携带两轮思考产物）。
        const consolidationApproach = Array.isArray(row?.startPhases?.planning?.approach) ? row.startPhases.planning.approach : [];
        for (const assignment of delegationPlan.members) {
            const prior = priorDelegates.find((item) => item?.member === assignment.member) ?? null;
            /*
             * [3.1.0] 重派跳过已完成成员：done 结论已经过 F10 汇报核验，是已交付的
             * 有效成果；旧实现对分工表成员无条件重新拉起，已完成专家被重复派活
             * （浪费 token，还可能覆盖已验收产物）。跳过激活、原样保留台账条目。
             */
            if (prior?.status === 'done') {
                delegates.push(prior);
                skippedDone += 1;
                continue;
            }
            const rulesBrief = buildLlmRulesBrief({
                model,
                effort: assignment.effort,
                requested: assignment.requested ?? null,
                correctionReason: assignment.correctionReason ?? null,
                tier: 'delegate',
                memberName: assignment.member,
                memberRole: assignment.role,
            });
            const retryBrief = prior
                ? buildDelegateRetryBrief(prior, probeDelegateLandedArtifacts(cwd, assignment.member), consolidationApproach)
                : '';
            // [2.5.0][自配档] 先配置后开工：未登记自配档 ⇒ phase-0 以 low 启动（唯一
            // 职责=self_effort）；已有自配档（含重置保留的 delegateSelfEfforts）⇒ 直接
            // 以自配档接续 phase-1。分工表 effort 降为建议（台账保留供看板对照）。
            const stashedSelf = row.delegateSelfEfforts?.[assignment.member];
            const priorSelf = typeof stashedSelf === 'string' && stashedSelf ? stashedSelf
                : (typeof prior?.selfEffort === 'string' && prior.selfEffort ? prior.selfEffort : '');
            /*
             * [3.0.8] 开工证据读档：已登记证据（delegateStartPhases 或
             * delegates[].startPhases）⇒ 随接续提示词下发执行蓝图，直接 phase-1；
             * 未登记（含旧计划遗留叶子）⇒ 仍走 phase-0 补齐证据+自配后才准执行。
             */
            const stashedStartPhases = sanitizeStartPhaseEvidence(row.delegateStartPhases?.[assignment.member])
                ?? sanitizeStartPhaseEvidence(prior?.startPhases);
            /*
             * [T6][D9][契约v1 §5] 预估读档门禁：已登记且已送达（delivery='sent'）的预估
             * 才算门禁通过。未预估、或预估投递失败（failed）⇒ 回 phase-0 补交完整原子对
             * （self_effort 重试只重投 failed，sent 幂等不重投）。D9 唯一权威：「汇报给对应
             * 负责人后，才可以重试或继续执行」——failed 若放行 phase-1 将永远无人补投，
             * 故门禁以 sent 为准（正整数 declaredMinutes 才算已登记，消毒同 plan.ts 口径）。
             */
            const stashedEstimate = sanitizeLeafEstimate(row.delegateEstimates?.[assignment.member])
                ?? sanitizeLeafEstimate(prior?.estimate);
            const registeredEstimate = stashedEstimate?.delivery === 'sent' ? stashedEstimate : null;
            const leafPhaseZero = !priorSelf || !stashedStartPhases || !registeredEstimate;
            const selfContinuation = priorSelf && stashedStartPhases && registeredEstimate
                ? `【自配档接续·开工证据读档】你的自配推理等级 \`${priorSelf}\` 与五步第 1/2/3 步开工证据均已登记生效（成员自配为权威）。继续勿重做：直接执行正式任务，不要重新评估复杂度、不要重复提交开工证据。正式执行必须严格按你第二步理清的方法、流程、步骤进行，全程少走弯路：先查历史教训、先验证再动手、不重复试错。你的开工预估已登记并送达部门负责人（约 ${registeredEstimate.declaredMinutes} 分钟，整数分钟），无需重复上报。

【开工登记证据·原文（[3.1.1] 收尾结果块的 phases.planning / phases.preparation 必须原样收录下列全部登记条目——逐字复制、不得重写或摘要——再追加执行期新补充）】
${renderStartPhaseEvidence(stashedStartPhases)}`
                : (priorSelf
                    ? `【自配档接续】你的自配推理等级 \`${priorSelf}\` 已登记生效（成员自配为权威）。继续勿重做：直接执行正式任务，不要重新评估复杂度。`
                    : '');
            const promptText = leafPhaseZero ? buildPhaseZeroDelegateePrompt({
                departmentLabel,
                member: assignment,
                cwd: cwd ?? '',
                ...(retryBrief ? { extraContext: retryBrief } : {}),
            }) : buildDelegateePrompt({
                departmentLabel,
                leaderSubtaskId: subtaskId,
                leaderSubtaskTitle: String(row.title ?? ''),
                member: assignment,
                rulesBrief,
                cwd: cwd ?? '',
                leadSessionId: childSession.id,
                ...(retryBrief || selfContinuation ? { extraContext: [selfContinuation, retryBrief].filter(Boolean).join('\n') } : {}),
            });
            /*
             * [3.1.8][P0 D2] 先落条目、后拉起：placeholder 的 childId 为空，phase-0
             * 的 self_effort 按成员名即可认亲；激活成功后同一对象补 childId。
             * 若 self_effort 已把该成员接续到新会话（live 条目带 selfEffort 且
             * childId 不同），以 live 为准，绝不把新会话覆盖回 phase-0 的旧 id。
             */
            const entry = {
                member: assignment.member,
                role: assignment.role,
                task: assignment.task,
                qualityRequirements: assignment.qualityRequirements,
                effort: assignment.effort,
                ...(assignment.requested && assignment.requested !== assignment.effort ? { requested: assignment.requested } : {}),
                childId: null,
                status: 'running',
                summary: '',
                error: null,
                startedAt: Date.now(),
                finishedAt: null,
            };
            delegates.push(entry);
            registerDelegatesInMemory();
            let childId = null;
            let memberError = null;
            // [3.1.0] 排队计量：只有真的发生退避等待才记录 queuedMs（不把正常激活
            // 延迟误标成排队）。
            let memberQueued = false;
            const activationBeganAt = Date.now();
            try {
                // [3.0.1][P1a] 宿主 subagent.maxDepth < 2 时一次性告警（scope=计划根会话）。
                notifyDepthOverrideConflict(ctx, typeof parentSession?.header?.parentSession === 'string' ? parentSession.header.parentSession : (typeof parentId === 'string' ? parentId : null));
                // [2.5.5][治本] 同 executeSubtask：spec 顶层契约（prompt/parent/cwd/agentOptions/maxDepth）。
                const activation = await startActivationQueued(() => ctx.subagents.startActivation({
                    provider: 'spawn',
                    label: `${row.department}:${subtaskId}→${assignment.member}`.slice(0, 120),
                    prompt: [{ type: 'text', text: promptText }],
                    parent: agent,
                    cwd,
                    agentOptions: {
                        ...(modelSelection?.provider && modelSelection?.model
                            ? { provider: modelSelection.provider, model: modelSelection.model }
                            : {}),
                        // [2.5.0][自配档] phase-0 强制 low；phase-1 用成员自配档（权威）。
                        reasoningEffort: leafPhaseZero ? 'low' : priorSelf,
                    },
                    // 成员在 depth 2；任何第四层（depth 3）被宿主绝对深度上限硬拒。
                    maxDepth: 2,
                    signal,
                    delivery: 'caller',
                }), signal, `派发成员 ${assignment.member}（${subtaskId}）`, (info) => {
                    // [3.1.0] 排队可见化：首次退避时记录一条用户可见通知（循环结束后
                    // 统一投递，不在工具执行中途重入会话事件流）；按成员去重，防刷屏。
                    memberQueued = true;
                    if (queueNotices.some((line) => line.includes(`成员 ${assignment.member}（`)))
                        return;
                    queueNotices.push(`【排队中】成员 ${assignment.member}（${subtaskId}）：子代理并发空位已满，已等待约 ${Math.round(info.elapsedMs / 1000)} 秒。这不是失败——空位一出现就会自动开始；长时间无进展可在「设置 → 子代理」调大 subagent.maxActiveSubagents，或设 DSH_WORKPLAN_ACTIVATION_QUEUE_MAX_WAIT_MS 调大排队等待上限。`);
                });
                childId = typeof activation?.childId === 'string' ? activation.childId : null;
                // [3.1.8][治本] 第三层叶子同样登记派发实例：叶子结算/对账时按 childId 认亲。
                rememberActivation(ctx, childId, record.plan.planId, subtaskId);
                const liveEntry = (liveRow()?.delegates ?? []).find((item) => item?.member === assignment.member);
                if (!(liveEntry?.selfEffort && liveEntry.childId && liveEntry.childId !== childId)) {
                    entry.childId = childId;
                    entry.status = 'running';
                    /*
                     * [3.1.8][P0 D2] startedAt 是「真正开工」时间，不是排队起点；
                     * 否则排队 5 分钟后激活的成员一启动就接近 D5 的 120s 停滞线。
                     */
                    entry.startedAt = Date.now();
                    if (memberQueued)
                        entry.queuedMs = Date.now() - activationBeganAt;
                    registerDelegatesInMemory();
                }
                if (activation && typeof activation.result?.then === 'function') {
                    const settledChildId = childId;
                    // [T8] 结算回调异步化：完成即时通知经 sendMessage 定向投递（T5 契约）。
                    activation.result.then(async (outcome) => {
                        try {
                            const completed = outcome?.stopReason === 'completed';
                            // [3.0.0] F10：专家汇报入口强制核验（adjudicateExpertReport），
                            // 未过即退回（failed + F10 拒因），绝不记 done。
                            const f10 = completed ? adjudicateExpertReport(outcome) : { ok: true };
                            const settledDone = completed && f10.ok;
                            const termination = classifyDelegateTermination(outcome, completed ? f10 : null);
                            const current = (record.statuses ?? []).find((item) => item?.subtaskId === subtaskId);
                            const list = (Array.isArray(current?.delegates) ? current.delegates : [])
                                .map((item) => (item?.childId === settledChildId
                                /*
                                 * [2.5.6] 待指示优先于结算：叶子请示后结束回合（stopReason
                                 * 可能是 completed），但请示还没被负责人答复——结算不得把
                                 * escalated 覆盖成 done/failed，否则「待指示」凭空消失。
                                 * 负责人 instruct 投递后叶子恢复执行，正常结算再收敛。
                                 */
                                ? (item?.escalation
                                    ? item
                                    : {
                                        ...item,
                                        status: settledDone ? 'done' : 'failed',
                                        closure: null,
                                        summary: truncate(resultText(outcome), 300),
                                        error: settledDone ? null : truncate(f10.ok ? String(outcome?.diagnostic ?? `子会话结束状态 ${outcome?.stopReason}`) : f10.rejection, 300),
                                        finishedAt: Date.now(),
                                    })
                                : item));
                            const revision = Number(current?.revision ?? 0) + 1;
                            record.statuses = applyStatus(record.statuses, subtaskId, { delegates: list, revision, updatedBy: 'child' });
                            record.updatedAt = Date.now();
                            appendUserMessage(parentSession, buildUpdateMessage({
                                planId: record.plan.planId,
                                planCreatedAt: record.plan?.createdAt,
                                subtaskId,
                                status: current?.status ?? row.status,
                                delegates: list,
                                revision,
                            }));
                            // [T8] 完成即时通知 → 原分派负责人会话（row.childId）：done-only、
                            // report.state='sent' 幂等、投递失败留 failed 待兜底补发，绝不回滚结算。
                            await emitDelegateDoneNotices(record, ctx.sessions?.get?.(String(row.childId ?? '')) ?? childSession, parentSession, subtaskId);
                            if (!settledDone && settledChildId) {
                                await emitDelegateTerminationNotices(record, ctx.sessions?.get?.(String(row.childId ?? '')) ?? childSession, parentSession, subtaskId, [{ childId: settledChildId, kind: termination.kind, reason: termination.reason }]);
                            }
                        }
                        catch (error) {
                            /*
                             * [T4][F4] 不再静默吞错：结算链失败必须留下可读审计行（含 childId 与
                             * 阶段），否则「台账为什么停在 running」永远无法事后解释。
                             */
                            record.errors = [
                                ...(record.errors ?? []),
                                settlementCallbackFailureLine({ subtaskId, childId: settledChildId, stage: 'delegate-settlement', error }),
                            ].slice(-20);
                        }
                    }).catch((error) => {
                        record.errors = [
                            ...(record.errors ?? []),
                            settlementCallbackFailureLine({ subtaskId, childId: settledChildId, stage: 'delegate-settlement-outer', error }),
                        ].slice(-20);
                    });
                }
            }
            catch (error) {
                // [3.0.1][P1b] 宿主并发上限翻译为可行动中文提示（其余错误原样透出）。
                const friendlyActivationError = describeSubagentActivationError(error, `派发成员 ${assignment.member}`);
                memberError = truncate(String(friendlyActivationError?.message ?? friendlyActivationError), 300);
                entry.status = 'rejected';
                entry.error = memberError;
                entry.finishedAt = Date.now();
                registerDelegatesInMemory();
            }
        }
        // [3.1.0] 排队可见化：派发期间发生过的排队等待，统一向根会话投递用户可见
        // 通知（每成员一条）；投递失败不影响派发结果。
        for (const line of queueNotices) {
            try {
                appendUserMessage(parentSession, makeUserMessage(line, { kind: 'workplan', form: 'notice', summary: line.slice(0, 80) }));
            }
            catch { /* 通知投递失败不影响派发结果 */ }
        }
        // [2.5.4][T3R1] 分派门禁放行留痕（A3）：并入台账 persist，同一动作不二次
        // persist（避免 revision 竞争）；gateAudit 经 applyStatus 消毒 + durable 回放。
        // [3.1.7][P0 U-64/U-68] gateAudit 的 prior 改为写前现读（liveRow），delegates
        // 由 persist 内部走 mergeDelegateEntriesMonotonic 条目级合并：本次新建数组只
        // 提供「新派发/重派」的条目，await 期间已结算的成员不会被整表覆盖抹掉。
        const liveEntries = Array.isArray(liveRow()?.delegates) ? liveRow().delegates : [];
        const finalDelegates = delegates.map((entry) => {
            const liveEntry = liveEntries.find((item) => item?.member === entry?.member);
            if (!liveEntry)
                return entry;
            /*
             * [3.1.8][P0 D2] self_effort 会在派发循环 await 期间把成员接续到新会话并
             * 改写 live childId；本地数组仍是 phase-0 的旧值。只有带 selfEffort 标记的
             * 新会话才以 live 为准，避免 durable 收尾把新会话 id 盖回旧 id；普通旧
             * failed 条目的 childId 不能被当成本次尝试。
             */
            if (liveEntry.selfEffort && liveEntry.childId && liveEntry.childId !== entry.childId)
                return liveEntry;
            return entry;
        });
        const written = persist({
            delegates: finalDelegates,
            gateAudit: [...(Array.isArray(liveRow()?.gateAudit) ? liveRow().gateAudit : []), { at: Date.now(), action: 'dispatch', ok: true, code: null }].slice(-20),
        });
        const rejected = finalDelegates.filter((item) => item.status === 'rejected');
        // [3.1.8][P1 D5] 有 running 成员才启动巡检；全部 done/failed 不空转。
        if ((written?.delegates ?? finalDelegates).some((item) => item?.status === 'running'))
            armDelegateSweep();
        return {
            ok: rejected.length < finalDelegates.length,
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
            subtaskId,
            action,
            delegates: written?.delegates ?? finalDelegates,
            clamped: delegationPlan.clamped,
            taskEffort: delegationPlan.taskEffort,
            effortOverride: written?.effortOverride ?? row.effortOverride ?? null,
            ...(rejected.length ? { rejected: rejected.map((item) => ({ member: item.member, error: item.error })) } : {}),
            ...(skippedDone ? { skippedDone } : {}),
            hint: '第三层已派发（一层下级、叶子层，第四层会被硬拒）。每位全球顶尖专家的完成结论会送回本会话（delivery=caller）；收齐后由你汇总核验，再写最终结果块。用 action="status" 查看进度。成员遇阻会经 dsh_workplan_escalate 在你这里落「待指示」（delegates[].closure=escalated）：必须当轮用 dsh_workplan_instruct（subtaskId=本部门行 ID，多个成员同时请示时加 member）答复，投递成功后该成员恢复执行。3.0.5 硬规则：任何成员待指示期间，review/dispatch/direct 一律拒绝改派，必须由原成员继续执行。' + (skippedDone ? ` 本次重派跳过 ${skippedDone} 名已完成成员（成果已保留，未重复拉起）。` : ''),
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
                planCreatedAt: record.plan?.createdAt,
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
         * [3.0.1] 认可闸门硬门禁：被按住（keyword/manual）且未派发的计划，派发一律
         * 拒绝——这是「未经用户认可不得开跑」的执行侧；唯一的合法出口是
         * dsh_workplan_release（它登记用户认可留痕后解除闸门并派发）。
         * 落点在终态闸门之后、开工证据门禁之前：拒绝不产生副作用。
         */
        if (isDispatchHeld(record)) {
            const snapshot = derivePlanSnapshot(record.statuses);
            return {
                ok: false,
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                phase: record.phase,
                running: false,
                alreadyRunning: false,
                complete: false,
                remaining: Math.max(0, Number(snapshot.stats.total ?? 0) - Number(snapshot.stats.done ?? 0)),
                stats: snapshot.stats,
                code: 'DISPATCH_HELD',
                error: `计划处于认可闸门之下（${truncate(String(record.dispatchHold?.reason ?? '未注明原因'), 200)}）：任务要求先经用户认可再执行，在用户明确认可前不得派发。`,
                hint: '请先征得用户明确认可，然后调用 dsh_workplan_release（可附 note 留痕、附 startPhases 直接开跑）；不要用 dsh_workplan_dispatch 绕过闸门。',
            };
        }
        /*
         * [3.0.8] 主 Agent 开工证据硬门禁（五步工作法单框架；取代 2.5.1 两轮深度思考
         * deepThink 门禁——两轮内容本就是五步第 1、2 步的子集，同一内容不再双份提交）。
         *
         * 主 Agent 执行自己的任务同样必须先完成五步前三步：第一步全面、全盘、深入
         * 梳理、研究、思考自己的任务；第二步基于第一步完成好的所有结果研究资源、
         * 工具与具体实施方案；第三步把资源与工具真正备齐并给出就绪证据——派发就是
         * 主 Agent 执行的起点，因此首次派发必须随附 startPhases 证据，未交/不合格
         * 硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），提示词绕不过。
         *
         * 落点=已通过 NO_PLAN / PLAN_ID_MISMATCH / 终态闸门之后、派发预告与任何
         * 子 Agent 启动之前：拒绝不产生副作用，也不刷派发预告。登记后持久化
         * （record + durable workplan-update），续跑/重试/join/重启回放读档放行；
         * 证据按 planId 记账——重规划换新计划是新任务，必须重新完成前三步。
         */
        if (!record.mainStartPhases || record.mainStartPhasesPlanId !== record.plan.planId) {
            const startCheck = validateStartPhaseEvidence(args?.startPhases);
            if (!startCheck.ok) {
                const snapshot = derivePlanSnapshot(record.statuses);
                return {
                    ok: false,
                    planId: record.plan.planId,
                    planCreatedAt: record.plan?.createdAt,
                    phase: record.phase,
                    running: false,
                    alreadyRunning: false,
                    complete: false,
                    remaining: Math.max(0, Number(snapshot.stats.total ?? 0) - Number(snapshot.stats.done ?? 0)),
                    stats: snapshot.stats,
                    code: startCheck.code,
                    error: startCheck.error,
                    hint: '先完成五步前三步再派发：第一步任务梳理，第二步基于第一步全部结果研究资源、工具与具体实施方案（含依据 approachBasis），第三步准备就绪，随 dsh_workplan_dispatch 的 startPhases 参数提交；登记后续跑/重启自动读档，无需重复提交。',
                };
            }
            record.mainStartPhases = startCheck.evidence;
            record.mainStartPhasesPlanId = record.plan.planId;
            // durable 持久化（计划级字段，subtaskId=null 不落任何子任务行）；回放消费端同口径消毒。
            appendUserMessage(session, buildUpdateMessage({
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId: null,
                mainStartPhases: startCheck.evidence,
                mainStartPhasesPlanId: record.plan.planId,
            }));
        }
        /*
         * [2.3.10][T2] 用户要求1（P2）：派发前会话内预告执行耗时。落点=已通过
         * 全部拒绝闸门（NO_PLAN / PLAN_ID_MISMATCH / 终态）、尚未启动任何子 Agent。
         * 幂等守卫：同一 planId 只预告一次——dispatch 工具契约是重复调用幂等，
         * 续跑/重复派发/join 在途回合都不得重复刷屏；重规划换新 planId 时自然
         * 重新预告。只追加 notice，不改派发语义与任何返回体。
         */
        if (record.preAnnouncedPlanId !== record.plan.planId) {
            record.preAnnouncedPlanId = record.plan.planId;
            const preAnnouncement = buildDispatchPreAnnouncement(record.plan);
            if (preAnnouncement)
                appendUserMessage(session, preAnnouncement);
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
                planCreatedAt: record.plan?.createdAt,
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
                planCreatedAt: record.plan?.createdAt,
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
             * [T9][用户要求6] 两种模式都推完成即时汇报：各部门负责人任务完成必须
             * 立刻、独立地向主 Agent 汇报，不分 wait/async（2.2.0「wait 不推」语义
             * 由 T9 取代）。即时通知是纯文本 user/message、不带 workplan 标记，
             * 不是轮级结果消息——「每轮恰 1 条持久结果消息」断言不受影响。
             * 结算备份采纳路径（settleFromOutput 同一 options）因此同样覆盖。
             */
            notifyCompletion: true,
            onSubtaskDone: (recordArg, subtask, verdict) => emitSubtaskDoneNotice(recordArg, session, subtask, verdict),
        };
        // [3.0.6][第 3 批①] 人工派发/续派复用原 record：派发前清零等待耗尽标记（同 startAutoDispatch）。
        record.turnWaitExhausted = undefined;
        record.waitExhaustedNotifiedTurn = undefined;
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
                planCreatedAt: record.plan?.createdAt,
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
    /*
     * [3.0.6][第 3 批①] 收尾等待上限（解析一次，全路径同值）。
     * ≤0 = 无限等待（旧行为）；默认 60 分钟。只约束 turn-stopping 的等待，
     * 不构成部门/专家的执行时限。
     */
    const turnStoppingMaxWaitMs = (() => {
        const raw = Number(options.turnStoppingMaxWaitMs);
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
    })();
    /**
     * 带上限地等待一个收尾承诺。capMs<=0 时等同无限等待（旧行为）。
     * 返回 true = 按时结算；false = 等满上限（调用方决定如何收尾）。
     * 承诺自身结算后绝不再被本函数消费——由调用方一次性判定。
     */
    async function waitTurnPromise(promise, capMs) {
        if (!(capMs > 0)) {
            try {
                await promise;
            }
            catch { /* 结算失败已由产出方留痕 */ }
            return true;
        }
        let timer = null;
        try {
            const timeout = new Promise((resolve) => {
                // 收束类计时器：到点即状态转移（等待预算耗尽），禁止 unref
                // （handle-policy 契约；到点必然被 clearTimeout 或先行触发）。
                timer = setTimeout(() => resolve('timeout'), capMs);
            });
            const outcome = await Promise.race([promise.then(() => 'settled', () => 'settled'), timeout]);
            return outcome === 'settled';
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    function recordReadiness(record) {
        return readinessOf(record);
    }
    /**
     * [3.0.1] 显式认可闸门（双保险中不依赖关键词识别的那一半）：主 Agent 在
     * 派发前把计划按住，用户明确认可后由 dsh_workplan_release 解除并开跑。
     * 只能设在尚未派发的计划上；已开跑的计划不设闸门（那是取消/重规划语义）。
     */
    async function holdTool(agent, args) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内操作计划闸门', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能操作主计划闸门', 'NOT_ROOT');
        const record = state.records.get(session.id);
        const requestedPlanId = typeof args?.planId === 'string' ? args.planId : undefined;
        if (requestedPlanId && record?.plan && record.plan.planId !== requestedPlanId) {
            throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH');
        }
        if (!record?.plan)
            throw new PlanError('当前会话没有可操作闸门的计划', 'NO_PLAN');
        if (isTerminalPhase(record.phase) || record.cancelled === true) {
            throw new PlanError('计划已是终态，不再设闸门', 'PLAN_TERMINAL');
        }
        if (record.dispatchedAt || record.dispatchPromise) {
            return {
                ok: false,
                code: 'ALREADY_RUNNING',
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                error: '计划已开跑，闸门只能设在尚未派发的计划上；如需停止执行请取消后重新规划。',
            };
        }
        if (isDispatchHeld(record)) {
            return { ok: true, alreadyHeld: true, planId: record.plan.planId, hold: record.dispatchHold };
        }
        const reason = truncate(String(args?.reason ?? '').trim() || '主 Agent 显式闸门：等待用户认可', 300);
        record.dispatchHold = { kind: 'manual', reason, at: Date.now(), by: 'agent' };
        record.updatedAt = record.dispatchHold.at;
        try {
            appendUserMessage(session, buildUpdateMessage({
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId: null,
                status: record.phase,
                dispatchHold: record.dispatchHold,
            }));
        }
        catch (error) {
            pushRecordError(record, error);
        }
        return { ok: true, planId: record.plan.planId, hold: record.dispatchHold };
    }
    /**
     * [3.0.1] 解除认可闸门并立即派发。release 是「用户已明确认可」的唯一合法
     * 出口：它把按住事实追加进 gateHistory（只增审计，durable 回放），清空
     * dispatchHold，然后走 dispatchTool 的同一套闸门（终态/开工证据等照常生效）。
     * 若 dispatch 因开工证据等门禁被拒，闸门保持已解除——认可事实是用户给的，
     * 不让它人质化；补齐 startPhases 后直接重发 dispatch 即可。
     */
    async function releaseTool(agent, args, signal) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内操作计划闸门', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能操作主计划闸门', 'NOT_ROOT');
        const record = state.records.get(session.id);
        const requestedPlanId = typeof args?.planId === 'string' ? args.planId : undefined;
        if (requestedPlanId && record?.plan && record.plan.planId !== requestedPlanId) {
            throw new PlanError('planId 与当前计划不匹配', 'PLAN_ID_MISMATCH');
        }
        if (!record?.plan)
            throw new PlanError('当前会话没有可操作闸门的计划', 'NO_PLAN');
        if (!isDispatchHeld(record)) {
            return {
                ok: false,
                code: 'NOT_HELD',
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                error: '计划不在认可闸门之下：无需解除。要开跑请直接调用 dsh_workplan_dispatch。',
            };
        }
        const hold = record.dispatchHold;
        const note = truncate(String(args?.note ?? '').trim(), 300);
        const releasedAt = Date.now();
        record.dispatchHold = null;
        record.gateHistory = [
            ...(Array.isArray(record.gateHistory) ? record.gateHistory : []),
            { hold, releasedAt, note, by: 'agent' },
        ].slice(-10);
        record.updatedAt = releasedAt;
        try {
            appendUserMessage(session, buildUpdateMessage({
                planId: record.plan.planId,
                planCreatedAt: record.plan?.createdAt,
                subtaskId: null,
                status: record.phase,
                dispatchHold: null,
                gateHistory: record.gateHistory,
            }));
        }
        catch (error) {
            pushRecordError(record, error);
        }
        const dispatched = await dispatchTool(agent, {
            planId: record.plan.planId,
            planCreatedAt: record.plan?.createdAt,
            startPhases: args?.startPhases,
            mode: args?.mode,
        }, signal);
        return { ok: dispatched?.ok !== false, gateReleased: true, hold, note, dispatch: dispatched };
    }
    function stopGateApplies(record, session, turn) {
        if (!record?.plan)
            return false;
        if (record.degraded)
            return false;
        /*
         * [3.0.1] 认可闸门：被按住且未派发的计划是在**等用户拍板**，不是在偷懒。
         * 此时既不 steer「请派发」（模型只会撞 DISPATCH_HELD 拒绝墙），headless
         * 也不许按「未完成」硬失败——用户还没认可，谈不上未完成。
         */
        if (isDispatchHeld(record) && !record.dispatchedAt)
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
    /*
     * [3.0.1] followup/queue 到达时立即取代旧后台规划。
     *
     * turn-stopping 正在 await 旧 planning.promise 时，新消息可能尚未进入下一次
     * pre-step；若只在那里 supersede，旧规划仍会跑完并迟到交付。官方
     * `agent/inbox/inserted` 在消息进入 live inbox 时即发本事件，因此这里先中止。
     * 内部 workplan 通知、社交/状态/空泛续跑均不取消；同任务重复投递保持幂等。
     * [T3][M2 取代显式通知] 与 pre-step 取代路径同一缺口：此处只置 superseded +
     * abort，全程静默，用户看到的就是"任务没分配"且无任何解释。这里补同一条
     * 用户可见取代通知；alreadySuperseded 守卫保证连续多条新消息只通知一次（幂等），
     * 且绝不恢复旧计划、绝不写 state.records，避免迟到覆盖新任务占位记录。
     */
    function onInboxInserted(payload) {
        const session = payload?.agent?.session;
        if (!session || !isRootSession(session))
            return;
        const planning = state.planningInFlight?.get(session.id);
        if (!planning)
            return;
        const message = payload?.message;
        if (humanMessages([message]).length === 0)
            return;
        const taskText = taskTextFromMessages([message]);
        // [3.1.2] 确认回复：不取代在途后台规划，并当场盖「已确认」章——规划完成时
        // settlement 读 planning.userConfirmed 即自动放行派发。盖章必须落在收件箱
        // 侧：pre-step 的确认路由用全量拼接文本判断，单条确认会被历史任务文本淹没
        // （3.0.7 只完工了「不取代」这一半，「标记 userConfirmed」从未真正落地，
        // 是「用户认可后插件不再运行」死锁的第一根因）。
        if (taskText && isUserConfirmation(taskText)) {
            if (planning.userConfirmed !== true) {
                planning.userConfirmed = true;
                try {
                    appendUserMessage(session, makeUserMessage('✅ 已收到您的确认回复：原计划的后台分解不会被本条消息取代；任务分解完成后将自动放行并派发，无需再次确认。', { kind: 'workplan-confirm-received', form: 'notice', summary: '确认已接收：计划生成后将自动派发' }));
                }
                catch (error) {
                    pushRecordError(state.records.get(session.id) ?? {}, error);
                }
            }
            return;
        }
        // [3.0.7] 社交/空泛续跑/状态提问同样不取代在途后台规划。
        if (!taskText || isSocialMessage(taskText) || isVagueContinuation(taskText) || isStatusQuestion(taskText))
            return;
        if (planning.taskText === taskText)
            return;
        const alreadySuperseded = planning.superseded === true;
        planning.superseded = true;
        planning.controller.abort();
        if (!alreadySuperseded) {
            appendUserMessage(session, '【dsh-workplan·任务分解被取代】你上一条任务的后台自动分解已被本条新消息中止，原任务不会自动分配。\n' +
                '如仍需执行原任务：请重新发送该任务，或说"重新生成计划并执行"；也可以让我先手动制定计划给你确认后再执行。');
        }
    }
    async function onTurnStopping(payload) {
        try {
            const agent = payload?.agent;
            const session = agent?.session;
            if (!agent || !session || !isRootSession(session))
                return;
            /*
             * [3.1.8][P1 D5] 根会话收尾前再对账一次：负责人回合已结束、专家静默
             * inactive 时，本轮收尾就是最后一次能看见它们的时点。已确认结束的成员
             * 收敛为 done/failed 并补终止通知；查不到结束证据的保持 running。
             */
            try {
                const liveRecord = state.records.get(session.id);
                if (liveRecord?.plan)
                    await reconcileRecordDelegates(liveRecord, session);
            }
            catch (error) {
                ctx.logger?.warn?.(`dsh-workplan: 收尾前第三层对账失败：${error instanceof Error ? error.message : String(error)}`);
            }
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
            /*
             * [3.0.1] 后台规划必须和本回合闭环，不能只靠“请勿提前收尾”的软提示。
             * 规划期间 record.plan 为空，旧 stopGateApplies 会直接放行；先等当前规划
             * 承诺结算，再读取最新 record，避免主 Agent 在计划出现前答复并停止回合。
             */
            let record = state.records.get(session.id) ?? known;
            const planning = state.planningInFlight?.get(session.id);
            if (planning?.promise && planning.turnWaitTimedOut !== true) {
                /*
                 * [3.0.6][第 3 批①] 收尾等待上限：规划在途时最多等
                 * turnStoppingMaxWaitMs（默认 60 分钟；0=无限）。到点不再等，标记
                 * turnWaitTimedOut（同一规划对象只等一次，后续收尾不再重复等待），
                 * 按规划未完成继续走下方既有闸门（有界 steer / fail-closed）。
                 */
                const settled = await waitTurnPromise(planning.promise, turnStoppingMaxWaitMs);
                if (!settled) {
                    planning.turnWaitTimedOut = true;
                    ctx.logger?.warn?.(`dsh-workplan: 回合 ${turn} 等待在途规划达到上限 ${Math.round(turnStoppingMaxWaitMs / 60000)} 分钟，`
                        + '按「等待预算耗尽」继续收尾检查（规划仍在后台，完成后的交回逻辑不受影响）');
                }
                /*
                 * 等待期间若同回合后续 step 已用新任务取代旧规划，本次旧收尾必须退出；
                 * 新规划的收尾会自行等待并交回，绝不能在这里消费旧结果或误 steer。
                 */
                const latestPlanning = state.planningInFlight?.get(session.id);
                if (latestPlanning && latestPlanning !== planning)
                    return;
                record = state.records.get(session.id) ?? reconstructFromSession(session) ?? record;
            }
            if (!record?.plan && record?.planningCompletionPending !== true) {
                // [1.8.14] N5：优先按本回合结算消息里点名的计划重建，而不是最后生成的计划。
                // 后台降级/澄清虽然没有 plan，也必须先交回主 Agent，不能被旧回放覆盖。
                record = reconstructFromSession(session, planIdFromTurn(session, turn)) ?? record;
                if (record?.plan)
                    state.records.set(session.id, record);
            }
            /*
             * 即使规划在 turn-stopping 前已完成，也必须把结果交回主 Agent 消费一次。
             * 标记只挂在后台规划的终态 record 上；held 计划下一步仍等待用户认可，
             * 不会落入普通“未完成计划”循环。plan mode 也要先完成这次交回。
             */
            if (Number(record?.createdTurn ?? record?.plan?.createdTurn) === turn && record?.planningCompletionPending === true) {
                record.planningCompletionPending = false;
                agent.steer(makeUserMessage([
                    '【后台规划结果待处理】任务分解已经结束，结果已写入本会话。',
                    '请立即读取最新结果并据此继续：若计划已生成，先向用户展示计划并遵守其中的认可闸门或派发要求；若处于认可闸门，只能针对这份已生成的计划请求认可，不得再说“计划尚未生成”；若规划降级或需要澄清，如实说明原因并提出下一步。',
                    '不得把本回合停留在“计划仍在生成”的旧状态。',
                ].join('\n'), { kind: 'workplan-planning-complete', form: 'notice' }));
                return;
            }
            if (isPlanModeActive(ctx, session))
                return;
            if (!stopGateApplies(record, session, turn))
                return;
            if (record.dispatchPromise) {
                if (record.turnWaitExhausted) {
                    /*
                     * [3.0.6][第 3 批①] 本轮（及后续回合）已耗尽过等待预算且派发仍在跑：
                     * 不再重复等待，直接走下方「放行但留痕」分支，回合如实收尾。
                     */
                }
                else {
                    const settled = await waitTurnPromise(record.dispatchPromise, turnStoppingMaxWaitMs);
                    if (!settled) {
                        record.turnWaitExhausted = { turn, at: Date.now(), waitedMs: turnStoppingMaxWaitMs };
                        record.errors = [...(record.errors ?? []), `回合收尾等待派发达到上限 ${Math.round(turnStoppingMaxWaitMs / 60000)} 分钟（等待预算耗尽，派发仍在后台执行）`].slice(-20);
                        ctx.logger?.warn?.(`dsh-workplan: 回合 ${turn} 等待派发达到上限 ${Math.round(turnStoppingMaxWaitMs / 60000)} 分钟：`
                            + `计划 ${record.plan?.planId} 仍在后台执行，结果消息会照常落盘`);
                        if (failClosedActive) {
                            throw new PlanError(`等待预算耗尽：回合收尾已连续等待派发超过 ${Math.round(turnStoppingMaxWaitMs / 60000)} 分钟`
                                + `（计划 ${record.plan?.planId} 仍在后台执行，本回合不再等待）。headless 以非零退出码结束，不输出「已完成」结果。`, 'WORKPLAN_WAIT_EXHAUSTED', { planId: record.plan?.planId });
                        }
                    }
                }
                if (!record.turnWaitExhausted) {
                    try {
                        await record.dispatchPromise;
                    }
                    catch {
                        /* the failure is already on record.errors; the gate only needs the outcome */
                    }
                    finishRound(record, session);
                }
                if (record.turnWaitExhausted) {
                    /*
                     * 等待预算耗尽的放行与 steer 用尽同一套「放行但留痕」语义：
                     * 不 steer（避免再拖住回合）、记 releasedIncomplete、追加 notice。
                     * fail-closed 已在上方抛错，不会走到这里。
                     */
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
                        reason: 'wait-exhausted',
                    };
                    try {
                        if (record.waitExhaustedNotifiedTurn !== turn) {
                            record.waitExhaustedNotifiedTurn = turn;
                            appendUserMessage(session, makeUserMessage([
                                `⏳ 本轮等待派发已达上限（${Math.round(turnStoppingMaxWaitMs / 60000)} 分钟），按计划仍在后台执行，本回合先行收尾（计划 ${record.plan.planId}）`,
                                `进度 ${stuck.stats.done}/${stuck.stats.total}；未完成：${released.join(', ') || '无'}`,
                                '后台结果照常落盘：稍后可用 dsh_workplan_status 查看，或在下一回合继续。',
                            ].join('\n'), {
                                kind: 'workplan-release',
                                form: 'notice',
                                summary: `等待预算耗尽放行 ${stuck.stats.done}/${stuck.stats.total}`,
                            }));
                        }
                    }
                    catch (error) {
                        ctx.logger?.warn?.(`dsh-workplan: 等待耗尽放行留痕写入失败：${error instanceof Error ? error.message : String(error)}`);
                    }
                    return;
                }
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
                planCreatedAt: record.plan?.createdAt,
                phase: record.phase,
                stats: snapshot.stats,
                statuses: snapshot.statuses,
                attempt: book.count,
                changePending: record.changeRequest?.status === 'pending',
                // [2.2.9][T3][M4.1] 强制收尾提示与门禁同源（纯派生）。
                reportPending: deriveReportPending(record),
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
             * [3.0.6] WORKPLAN_WAIT_EXHAUSTED 同属硬失败（等待预算耗尽），同样必须穿透。
             */
            if (error instanceof PlanError
                && (error.code === 'WORKPLAN_INCOMPLETE' || error.code === 'WORKPLAN_WAIT_EXHAUSTED'))
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
        /*
         * 鉴权 fail-closed：connection 服务存在但没有 requestRejection（宿主 API 改名/降级）时，
         * 旧实现会因可选链返回 undefined 而直接放行，等于把全部会话计划暴露给未鉴权请求。
         * 看板是敏感数据路由，宁可直接拒绝，也不能在“检查器不见了”时默认通过。
         */
        if (typeof connectionCtx?.connection?.requestRejection !== 'function') {
            respondJson(res, 503, { ok: false, error: '鉴权服务不可用，已拒绝访问' });
            return;
        }
        try {
            rejection = await Promise.resolve(connectionCtx.connection.requestRejection(req));
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
            let payload = plansPayload(url.searchParams.get('sessionId') ?? undefined);
            let body = JSON.stringify(payload);
            if (Buffer.byteLength(body) > MAX_PLANS_RESPONSE_BYTES) {
                payload = trimPlansPayload(payload);
                body = JSON.stringify(payload);
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
     * 用户要求这些经验必须能被复核。主 Agent 在第四步可以用它查：记住了什么、
     * 哪些同类错误在重复发生、文件到底写在哪。它只读文件，不改任何计划状态。
     */
    /*
     * [3.0.6][复审修复] 数据面越权：lessons.jsonl 是跨项目的全局永久记忆（含
     * 其它项目 cwd 与问题描述），此前无任何会话校验，任意子 Agent（含其它插件
     * 拉起的子会话）都能读走。这里与其它工具（update/replan/cancel 等）同一
     * 写法加 isRootSession 硬校验：非根会话直接抛权限错误，不依赖提示词约束；
     * 根会话行为不变。
     */
    async function lessonsTool(agent, args) {
        const session = agent?.session;
        if (!session)
            throw new PlanError('只能在会话内查询永久教训记忆', 'NO_SESSION');
        if (!isRootSession(session))
            throw new PlanError('子 Agent 不能读取全局永久教训记忆', 'NOT_ROOT');
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
        disarmDelegateSweep();
        for (const record of state.records.values())
            clearAutoResumeTimer(record, 'dispose');
        state.records.clear();
    }
    return {
        state,
        limits,
        onPreStep,
        onInboxInserted,
        onTurnStopping,
        presentDenialReason,
        presentDenialVerdict,
        supersededDenialVerdict,
        presentedWriteDenialReason,
        writeTargets,
        updateStatus,
        cancelPlan,
        dispatchTool,
        holdTool,
        releaseTool,
        statusTool,
        followupTool,
        escalateTool,
        // [2.3.9][T4b] 第三层派发（部门负责人专用）：review 梳理门禁 → dispatch 全球顶尖专家。
        delegateTool,
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
    if (!session)
        return downstream;
    /*
     * [2.5.5][T10] 每个 pre-step 先把该会话缓冲的台账合并落盘：合并闸把有界延迟
     * 从「整轮」缩短到一个 step，进程崩溃最多丢当前 step 未落盘的台账。
     */
    try {
        flushPendingWorkplanUpdates(session);
    }
    catch {
        /* 合并失败不拦规划：下一次落盘/结算再试。 */
    }
    if (!isRootSession(session))
        return downstream;
    /*
     * 后续 step 通常是工具续跑，不能重复规划；但后台规划未结算时，DSH 会把
     * steering/followup 的新人类任务作为同回合下一 step 送达（官方生命周期：
     * next-step input → pre-step）。此时必须进入下方分类与 supersede，否则新任务
     * 被静默跳过、旧计划随后迟到覆盖。相同 taskText 仍会在下方去重返回。
     */
    if (payload.step !== 1 && !state.planningInFlight?.get(session.id))
        return downstream;
    // [2.5.5][T3] pre-step 窗口标记：规划/自动派发的头前通知一律暂存（治本）。
    enterPreHeadWindow(session);
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
    // [3.1.2] 单条口径：消息分类只看最新一条人类消息。全量拼接文本会把短跟进
    // （认可/谢谢/继续/进度如何）淹没在原始任务里，分类器集体失效——这是
    // 「用户确认后插件不再运行」死锁的第一根因（与 onInboxInserted 口径对齐；
    // goal 轮次无人类消息时为空串，分类判断自然跳过，不影响原 goal 分支）。
    const lastHumanText = (() => {
        const list = humanMessages(payload.messages);
        return list.length ? messageText(list[list.length - 1]).trim() : '';
    })();
    if (!taskText)
        return downstream;
    if (lastHumanText && isSocialMessage(lastHumanText))
        return downstream;
    if (lastHumanText && isVagueContinuation(lastHumanText))
        return downstream;
    if (lastHumanText && isStatusQuestion(lastHumanText))
        return downstream;
    /*
     * [3.0.7] 确认回复路由（用户想法，原话）：「收到用户确认回复后，你应该结合所
     * 有上下文全面、深入分析、思考、研究后，开始依据得出的所有结果分配任务」。
     * 用户 2026-11-18 补充裁决：「用户确认后，无论任务是否已经生成，都必须结合
     * 所有上下文和用户的回复，全面、深入开展分析、思考、研究，然后依据得出的
     * 所有结果开始分配任务」——分析在先、派发现在，插件不得在钩子层不经分析
     * 机械开跑。落到三条出口，全部在 activeTurns 标记与取代/取消逻辑之前：
     *  ① 已有已提交未派发的计划（被认可闸门按住或 plan-first 未派发）→ 解除
     *     闸门（留痕 gateHistory，记下用户确认原文）、刷新 conversationContext
     *     （含确认消息的全量上下文），并给主 Agent 下分析-派发指令；本回合标记
     *     activeTurns：主 Agent 若未在回合内派发，收尾闸门会拦停 steer「请派发」
     *     作为兜底，绝不留下「确认后无人派发」的尾巴；
     *  ② 任务分解正在后台进行 → 只标记 userConfirmed，原分解不被取代中止。后台
     *     分解本身就是「结合所有上下文的深入分析研究」，计划一生成即跳过认可
     *     闸门、刷新上下文后自动派发（＝依据分析得出的结果分配任务）；
     *  ③ 其余（无计划/已在执行/终态）→ 交还主 Agent 结合上下文正常答复，绝不做
     *     任务分解——确认消息不再是新任务。
     */
    // [3.1.2] 触发条件用最新单条消息（lastHumanText），不再用全量拼接文本：
    // 否则单条确认（如「认可」）永远进不了本路由，出口①解闸派发 / 出口②盖章
    // 全部空转，确认消息反而落到下方真实任务路径取代并杀死在途后台规划。
    if (isUserConfirmation(lastHumanText)) {
        if (existing?.plan && !existing.dispatchedAt && !isTerminalPhase(existing.phase)
            && !existing.dispatchPromise && existing.phase !== 'executing' && !existing.degraded
            && existing.planner?.outcome !== 'SALVAGED') {
            if (planMode)
                return downstream;
            const wasHeld = isDispatchHeld(existing);
            if (wasHeld) {
                const hold = existing.dispatchHold;
                existing.dispatchHold = null;
                existing.gateHistory = [
                    ...(Array.isArray(existing.gateHistory) ? existing.gateHistory : []),
                    { hold, releasedAt: Date.now(), note: `用户确认消息自动放行：${truncate(lastHumanText, 60)}`, by: 'user' },
                ].slice(-10);
            }
            existing.conversationContext = recentConversation(session);
            existing.updatedAt = Date.now();
            try {
                appendUserMessage(session, buildUpdateMessage({
                    planId: existing.plan.planId,
                    subtaskId: null,
                    status: existing.phase,
                    ...(wasHeld ? { dispatchHold: null, gateHistory: existing.gateHistory } : {}),
                }));
                appendUserMessage(session, makeUserMessage([
                    `✅ 已收到并采纳您的确认回复（"${truncate(lastHumanText, 40)}"）：${wasHeld ? '认可闸门已按您的确认解除。' : ''}`,
                    '【主 Agent 指令·必须执行】您必须结合当前所有上下文和用户的这条确认回复，全面、深入地开展分析、思考、研究；然后依据得出的所有结果，调用 dsh_workplan_dispatch 开始分配任务（dispatch 时必须提交 startPhases，即您刚才的完整分析——五步第 1/2/3 步开工证据，它会作为登记在案的分析依据）。',
                    '若分析发现计划需要按用户意图调整：先调用 dsh_workplan_replan 调整，再派发调整后的计划。',
                    '禁止：不分析直接派发；把计划重新按住；把本条确认当成新任务重新分解。',
                ].join('\n'), { kind: 'workplan-confirm-analyze', form: 'notice', summary: '用户已确认：请深入分析后调用 workplan_dispatch 派发' }));
            }
            catch (error) {
                pushRecordError(existing, error);
            }
            if (!state.activeTurns)
                state.activeTurns = new Map();
            state.activeTurns.set(session.id, Number(payload.turn ?? 0));
            return downstream;
        }
        const planning = state.planningInFlight?.get(session.id);
        if (planning && planning.superseded !== true) {
            if (planning.userConfirmed !== true) {
                planning.userConfirmed = true;
                try {
                    appendUserMessage(session, makeUserMessage('✅ 已收到您的确认回复：原计划的后台分解不会被本条消息取代；任务分解完成后将自动放行并派发，无需再次确认。', { kind: 'workplan-confirm-received', form: 'notice', summary: '确认已接收：计划生成后将自动派发' }));
                }
                catch (error) {
                    pushRecordError(state.records.get(session.id) ?? {}, error);
                }
            }
            return downstream;
        }
        return downstream;
    }
    /*
     * [1.8.7] Remember that this turn carries a real task.
     *
     * `agent/turn-stopping` must only object on turns whose plan belongs to the
     * user's actual request. A plan left paused in an earlier turn must not turn
     * every later "谢谢/进度如何" turn into a forced dispatch（现行轮次预算默认
     * 关闭，TOTAL_TIMEOUT_MS=0；此处只拦「带真实任务文本的轮次」），so the
     * stop gate reads this marker and stays silent on social or status turns.
     */
    if (!state.activeTurns)
        state.activeTurns = new Map();
    state.activeTurns.set(session.id, Number(payload.turn ?? 0));
    /*
     * 新的真实任务到达时，旧任务的后台规划不得再迟到覆盖新任务。
     * 社交/状态消息在上方已提前返回，不会误取消；同一任务的重复 pre-step 只去重。
     */
    const priorPlanning = state.planningInFlight?.get(session.id);
    if (priorPlanning) {
        if (priorPlanning.taskText === taskText)
            return downstream;
        // [3.1.2] 单条豁免：最新一条消息若是寒暄/空泛续跑/状态提问/确认回复，
        // 不视为新任务，不得取代在途后台规划——拼接锚点会让每条跟进消息都
        // 「改变任务文本」而误杀规划（确认/社交类消息即使走到这里也必须放行）。
        if (lastHumanText && (isSocialMessage(lastHumanText) || isVagueContinuation(lastHumanText) || isStatusQuestion(lastHumanText) || isUserConfirmation(lastHumanText)))
            return downstream;
        /*
         * [T3][M2 取代显式通知] 原任务的后台自动分解被本条新消息取代。T1 根因：此处置旧规划
         * 只置 superseded + abort，全程静默，用户看到的就是"任务没分配"且无任何解释。这里补一条
         * 用户可见降级通知。边界沿用 11099 注释的防御意图：绝不恢复旧计划、绝不写 state.records
         * （避免迟到覆盖新任务占位记录）；通知只走 appendUserMessage（与规划预告/心跳同一合规
         * 写入器）。alreadySuperseded 守卫保证连续多条新消息只在首次取代时通知一次（幂等）。
         */
        const alreadySuperseded = priorPlanning.superseded === true;
        priorPlanning.superseded = true;
        priorPlanning.controller.abort();
        if (!alreadySuperseded) {
            appendUserMessage(session, '【dsh-workplan·任务分解被取代】你上一条任务的后台自动分解已被本条新消息中止，原任务不会自动分配。\n' +
                '如仍需执行原任务：请重新发送该任务，或说"重新生成计划并执行"；也可以让我先手动制定计划给你确认后再执行。');
        }
    }
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
    /*
     * [3.0.1] 认可闸门同理：被按住等用户认可的计划不得被下一条用户消息自动
     * 取消（wp-e745a477 事故：主 Agent 正在等用户回复，计划已被自动派发出去；
     * 修复后若计划被闸门按住，保护它活到用户答复、release 放行）。
     */
    /*
     * [3.1.4] 认可闸门兜底提示：被按住等认可的计划不得被下一条消息自动取消
     * （3.0.1 的保护契约不变），但也**不得静默吞掉**——2026-11-20 事故
     * （wp-cff638b6）里用户回了一句未被识别的同意，插件一声不响，计划 0/13
     * 一直挂着，用户只能反过来问「为什么没开始分配」。静默本身就是第二个缺陷：
     * 即便分类器再漏判，也必须让用户看见闸门在哪、怎么放行。
     * 每条新消息最多提示一次（按消息原文去重），不刷屏、不自动派发。
     */
    if (existing?.plan && isDispatchHeld(existing) && !existing.dispatchedAt) {
        const hintKey = truncate(lastHumanText || taskText, 120);
        if (existing.holdHintKey !== hintKey) {
            existing.holdHintKey = hintKey;
            existing.updatedAt = Date.now();
            const rows = Array.isArray(existing.statuses) ? existing.statuses : [];
            const doneCount = rows.filter((item) => item?.status === 'done').length;
            try {
                appendUserMessage(session, makeUserMessage([
                    `【dsh-workplan·计划仍在等待您的明确认可】计划 ${String(existing.plan.planId ?? '')} 尚未派发（完成 ${doneCount}/${rows.length}）：本条消息没有被识别为「认可」类回复，为防误判，暂不派发任何子任务。`,
                    '若您认可该计划：请回复「认可」或「按计划执行」，或让我调用 dsh_workplan_release 放行。',
                    '若需要修改：直接说明要改的内容，我会先 replan 再派发。',
                ].join('\n'), { kind: 'workplan-hold-hint', form: 'notice', summary: '计划仍在等待明确认可：请回复「认可」或让我 release' }));
            }
            catch (error) {
                pushRecordError(existing, error);
            }
        }
        return downstream;
    }
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
    /*
     * [3.0.1] 认可闸门：任务锚点要求「先经用户认可再执行」时，计划照出、按住不派。
     * 识别结果随本函数流入计划创建尾（approvalGateVerdict）：创建时写入
     * record.dispatchHold、跳过 autoDispatch，直到用户明确认可、主 Agent 调用
     * dsh_workplan_release。DSH_WORKPLAN_APPROVAL_GATE=0 时识别关闭（显式
     * 闸门 dsh_workplan_hold 不受影响）。
     */
    const approvalGateVerdict = approvalGateDetectionDisabled()
        ? { held: false, matched: [], reason: '' }
        : detectApprovalGate(taskText);
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
     * [2.3.10][T2] 用户要求1（P1）：规划前会话内预告规划耗时。此前该时点只有
     * 侧栏占位卡、无会话输出（T1 E6）；现在在 runPlanner 之前经唯一合规写入器
     * appendUserMessage 发一条【规划预告】。预估与 runPlanner 同源：同一个
     * normalisePlannerWindow 解析出的实际窗口（含配置/环境变量覆盖）。
     */
    /*
     * [3.0.0][用户要求 2] 从接收到用户任何任务开始，会话内必须输出固定文案
     * 「任务正在分配中，请稍等一下......」。逐字冻结文案来自 v3-contract，
     * 与用户原文逐字一致（6 个半角点），不得拼接、不得改写。
     * 位置：任何规划动作之前（含规划预告之前），保证用户先看到「正在分配」。
     * deferUntilHead：受保护系统头未落地前暂存，落地后按序补发（2.5.5 治本）。
     */
    appendUserMessage(session, STATUS_ASSIGNING_TEXT, undefined, { deferUntilHead: true });
    appendUserMessage(session, buildPlanningPreAnnouncement(normalisePlannerWindow(options?.limits?.plannerTimeoutMs ?? options?.plannerTimeoutMs, PLANNER_TIMEOUT_MS), PLANNER_MAX_ATTEMPTS), undefined, { deferUntilHead: true });
    /*
     * [2.2.5][T5] 进度回调落点（T1 P-6 / T3 §3 C2/C3、§4 频率规则）：
     * 通道 A = 占位卡片 errors 区追加重试摘要（≤2 行，保底通道）；通道 B =
     * appendUserMessage 通知（仅「会退避重试」的失败发，≤2 条，aborted 静默）。
     * 文案组装与频率硬规则全部在 createPlannerProgressReporter / plannerProgressLines
     * （plan.ts，可独立回归）；这里只注入宿主交互面。
     */
    /*
     * [3.0.0][用户要求 1 / 2 治本 —— 依据 T4 根因报告（reports/T4b-会话内容丢失根因报告-20261114.md）]
     *
     * 缺陷实证（T4，3497 个会话 / 4034 轮对照）：宿主在 pre-step 之前就认领
     * 用户消息，人类 user/message 只在首个 model step 内部落盘；而本插件在
     * pre-step 里 `await runPlanner`，把这一步推迟到分钟级（含规划轮的轮次
     * p50=58.4s、p90=250s，不含的 p50=0.04s）。这段时间里会话日志没有任何
     * 可渲染的任务正文，屏幕上唯一副本是客户端回声，而客户端在收到回执后
     * 无条件退休该回声——于是「切走会话再切回」就看不到用户刚输入的任务。
     *
     * 治本：pre-step 不再等待规划。先同步放行本步（模型立即看到「正在分配」
     * 的注入说明，不会自己去执行用户任务），规划转后台继续：计划一成即经唯一
     * 合规写入器 appendUserMessage 写入会话并按既有路径自动派发。这样首 step
     * 在秒级启动 → 宿主立即落盘人类消息、暂存的通知按序补发，任务正文与固定
     * 文案都在切会话前后稳定可见。
     *
     * 中止语义不变：仍沿用本步的 payload.signal（宿主只在 cancel/中断时 abort
     * 该信号，正常收尾不 abort），用户中断时后台规划与以前一样静默退出。
     * 幂等：同一会话已有规划在跑时直接放行本步，不会重复规划。
     */
    const deliver = (messages) => {
        for (const message of messages) {
            try {
                /*
                 * 后台路径没有 pre-step 的返回值可用，只能写进会话（append-only）。
                 * deferUntilHead 由 appendUserMessage 自身按「受保护系统头是否已落地」
                 * 判定，与本步的窗口标记无关，因此不会写出头前 surface。
                 */
                appendUserMessage(session, message);
            }
            catch (error) {
                pushRecordError(planningRecord, error);
            }
        }
    };
    if (!state.planningInFlight)
        state.planningInFlight = new Map();
    const planningController = new AbortController();
    const forwardPayloadAbort = () => planningController.abort();
    if (payload.signal.aborted)
        planningController.abort();
    else
        payload.signal.addEventListener('abort', forwardPayloadAbort, { once: true });
    const planningSignal = planningController.signal;
    const planningEntry = {
        startedAt: planningStartedAt,
        turn: payload.turn,
        taskText,
        controller: planningController,
        superseded: false,
        promise: null,
    };
    state.planningInFlight.set(session.id, planningEntry);
    const runPlanningInBackground = async () => {
        let plannerAttempt = 1;
        const onPlannerProgress = createPlannerProgressReporter({
            signal: planningSignal,
            record: planningRecord,
            setRecord: (record) => state.records.set(session.id, record),
            appendNotice: (text) => appendUserMessage(session, text, undefined, { deferUntilHead: true }),
            maxAttempts: PLANNER_MAX_ATTEMPTS,
        });
        /*
         * [2.5.2] 规划期间心跳（治本：用户 2026-11-11 报告本会话 turn 1 规划 12.5
         * 分钟全程零会话输出、以为死机并手动中断）。失败重试回报器只在「失败且
         * 退避重试」时发通知；一次持续流式但很慢的尝试不失败也不触发 idle，于是
         * 预告之后整段静默。心跳与重试正交：只要 runPlanner 还在跑，就按固定间隔
         * 经唯一合规写入器发一条「仍在生成、已用时多久、不是卡死」的可见通知。
         * 写入仍是 user/message（surfaceOp:'append'、形状校验），不新增事件类型、
         * 不触碰 system/message，不会引入会话日志损坏；finally 里 stop，绝不残留。
         */
        const planningHeartbeat = createPlanningHeartbeat({
            signal: planningSignal,
            appendNotice: (text) => appendUserMessage(session, text, undefined, { deferUntilHead: true }),
            intervalMs: planningHeartbeatIntervalMs(process.env.DSH_WORKPLAN_PLANNING_HEARTBEAT_MS ?? PLANNING_HEARTBEAT_MS),
            startedAt: planningStartedAt,
            getAttempt: () => plannerAttempt,
            maxAttempts: PLANNER_MAX_ATTEMPTS,
        });
        planningHeartbeat.start();
        try {
            plan = await runPlanner(ctx, {
                taskText,
                cwd: session.header?.cwd ?? options.cwd,
                sessionId: session.id,
                modelSelection,
                signal: planningSignal,
                plannerTimeoutMs: normalisePlannerWindow(options?.limits?.plannerTimeoutMs ?? options?.plannerTimeoutMs, PLANNER_TIMEOUT_MS),
                plannerIdleTimeoutMs: normalisePlannerWindow(options?.limits?.plannerIdleTimeoutMs ?? options?.plannerIdleTimeoutMs, PLANNER_IDLE_TIMEOUT_MS),
                telemetry: plannerTelemetry,
                // [2.2.5][T5] 分解期间进度事件（T1 P-6）：只追加观察回调，不改重试语义。
                onProgress: (report) => {
                    // [2.5.2] 顺带记录当前尝试序号，供心跳文案显示「第 N/M 次尝试」。
                    const failedAttempt = Number(report?.attempt) || 0;
                    if (failedAttempt > 0) {
                        const willRetry = Number(report?.retryBackoffMs) > 0 && failedAttempt < PLANNER_MAX_ATTEMPTS;
                        plannerAttempt = Math.min(PLANNER_MAX_ATTEMPTS, willRetry ? failedAttempt + 1 : failedAttempt);
                    }
                    onPlannerProgress(report);
                },
                conversationContext,
                sourceMessageIds: human.map((message) => message.id).filter((id) => typeof id === 'string'),
                // 旧 totalTimeoutMs/childTimeoutMs 配置不再注入规划器；只保留非时间资源约束。
                budget: {
                    totalMinutes: 0,
                    childMinutes: 0,
                    // [3.1.0] 规划器并发预算环境变量化：宿主不向插件暴露 maxActiveSubagents，
                    // 故以 DSH_WORKPLAN_PLANNER_CONCURRENCY 显式可配（默认不变 = MAX_CONCURRENT）。
                    // 调大宿主 subagent.maxActiveSubagents 后，同步调大此值让规划器按真实并行度排预算。
                    concurrency: envPositiveInt('DSH_WORKPLAN_PLANNER_CONCURRENCY', MAX_CONCURRENT),
                    maxResumes: Number(options?.limits?.maxResumes ?? MAX_PLAN_RESUMES),
                },
            });
        }
        catch (error) {
            if (planningSignal.aborted) {
                /*
                 * 用户中止或被新任务取代都静默退出；后者尤其不得恢复旧计划、写降级通知，
                 * 否则已取消的旧规划会迟到覆盖新任务的占位记录。
                 */
                if (!planningEntry.superseded && existing?.plan)
                    state.records.set(session.id, existing);
                return;
            }
            /*
             * [3.0.1] 规划守卫判定「只有用户能答复」（CLARIFY_NEEDED）：与规划前的
             * C1–C4 澄清闸同一条出口——写 clarify 记录、把问题原样转给用户、本轮回合
             * 直接结束。不降级、不生成计划、不派发；用户的下一条答复会带着答案重新
             * 进入规划。在降级路径之前拦截，否则这里会把「等用户」误报成「分解失败」。
             */
            if (error instanceof PlanError && error.code === 'CLARIFY_NEEDED') {
                const createdAt = Date.now();
                state.records.set(session.id, {
                    planId: null,
                    plan: null,
                    title: '任务信息不足（先澄清）',
                    degraded: false,
                    clarify: true,
                    error: error.message,
                    statuses: [],
                    phase: 'clarify',
                    errors: [truncate(error.message, 1000)],
                    createdAt,
                    updatedAt: createdAt,
                    createdTurn: payload.turn,
                    planningCompletionPending: true,
                });
                deliver([buildClarifyMessage({
                        rule: 'AUDIT',
                        reason: error.message,
                        question: typeof error.details === 'string' && error.details.trim() !== '' ? error.details : '',
                    })]);
                return;
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
                planningCompletionPending: true,
            });
            return deliver([message]);
        }
        finally {
            // [2.5.2] 无论成功/降级/中止，规划结束即停心跳，绝不残留定时器。
            planningHeartbeat.stop();
        }
        if (planningSignal.aborted) {
            // 用户中止或新任务取代：旧规划结果不得再落入会话。
            if (!planningEntry.superseded && existing?.plan)
                state.records.set(session.id, existing);
            return;
        }
        const planId = `wp-${randomUUID()}`;
        const createdAt = Date.now();
        /*
         * [3.0.1] 认可闸门：任务锚点命中「先经用户认可再执行」门槛语时，计划照出、
         * 按住不派（dispatchHold 落档），直到用户明确认可、主 Agent 调用
         * dsh_workplan_release。必须在 record 字面量之前声明——字面量引用了它。
         *
         * [3.0.7] 例外：分解期间用户已回过确认（planningEntry.userConfirmed）——
         * 认可事实先于计划成立，闸门不再按住，计划落地即自动放行派发。
         */
        const approvalHeld = !planMode && approvalGateVerdict.held && planningEntry.userConfirmed !== true;
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
            planningCompletionPending: true,
            /*
             * [3.0.1] 认可闸门落档：keyword=任务锚点命中门槛语；manual=dsh_workplan_hold
             * 显式按住。release 置 null（事实本身追加进 gateHistory 审计）。
             */
            ...(approvalHeld
                ? {
                    dispatchHold: {
                        kind: 'keyword',
                        reason: approvalGateVerdict.reason,
                        at: createdAt,
                        by: 'system',
                    },
                }
                : {}),
        };
        state.records.set(session.id, record);
        /*
         * [1.12.0] Q2：默认自动派发。计划消息仍然先把计划完整展示出来，紧接着以
         * async 方式开跑——不是等所有子任务结束再显示（那才是旧的「没动静」）。
         * plan 模式不自动派发；显式 `autoDispatch:false` 保留 plan-first。
         *
         * [3.0.1] 认可闸门（approvalHeld，声明见 record 字面量之前）：任务锚点命中
         * 「先经用户认可再执行」门槛语时同样不自动派发——用户明确认可、主 Agent
         * 调用 dsh_workplan_release 之前，计划只展示、任何派发都被拒。
         */
        /*
         * [3.0.6][复审修复] SALVAGED 计划禁止自动派发：规划器抢救出的残缺计划
         * （超时/中断截断、仅过部分校验）未经确认直接 startAutoDispatch，等于让
         * 残缺的部门划分与验收口径在无人复核的情况下生效。这里把 outcome 纳入
         * 派发判据，SALVAGED 时改为下发一条用户可见通知（见下方 deliver 分支），
         * 确认后再由主 Agent 显式 dsh_workplan_dispatch。autoResume 链路不构成
         * 渗透点：armAutoResume 只在 finishRound（一轮派发结束后）触发，从未派发
         * 的 SALVAGED 记录进不了那条路径。
         */
        const plannerSalvaged = plannerTelemetry.outcome === 'SALVAGED';
        const autoDispatched = !planMode && !approvalHeld && options?.autoDispatch !== false && !plannerSalvaged;
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
            totalBudgetMinutes: 0,
            maxResumes: Number(options?.limits?.maxResumes ?? MAX_PLAN_RESUMES),
            planMode,
            autoDispatched,
            approvalHeld,
        });
        /*
         * [3.0.0][顺序] 必须先让计划可见，再开跑、再发「分配完成」：
         * 用户要求 4 的文案由 dispatchPlan 在真正开跑时写入，若自动派发抢在计划
         * 消息之前，用户会先看到「分配完成」再看到计划（T6 设计复核 D2）。因此这里
         * 先 deliver 计划消息，再启动自动派发。
         */
        if (!planMode) {
            if (approvalHeld) {
                /*
                 * [3.0.1] 认可闸门：durable 落档（与 mainStartPhases 同一写入口径，
                 * subtaskId=null 计划级）——刷新/重启后回放读档，闸门不丢；
                 * 随后发用户可见通知，计划保持 phase=pending、不派发。
                 */
                try {
                    appendUserMessage(session, buildUpdateMessage({
                        planId: fullPlan.planId,
                        subtaskId: null,
                        status: record.phase,
                        dispatchHold: record.dispatchHold,
                    }));
                }
                catch (error) {
                    pushRecordError(record, error);
                }
                deliver([
                    planMessage,
                    makeUserMessage([
                        '🔒 认可闸门已生效：您的任务要求「先经用户认可再执行」，本计划已生成但暂不分派任务。',
                        `命中依据：${approvalGateVerdict.reason}`,
                        '在您明确回复认可之前，任何派发（自动或手动）都会被拒绝；您认可后，请告知主 Agent 调用 dsh_workplan_release 开跑。',
                    ].join('\n'), { kind: 'workplan-hold', form: 'notice', summary: '认可闸门已生效：等待用户认可后再派发' }),
                ]);
                return;
            }
            /*
             * [3.0.7] 用户已在分解期间确认：把确认事实与计划一起展示，让用户清楚
             * 本轮派发来自他自己的确认（而非系统自作主张）。后台分解本身就是「结合
             * 所有上下文的深入分析研究」，派发＝依据分析结果分配任务；派发前刷新
             * conversationContext，让各部门 Agent 拿到含确认消息的全量上下文。
             */
            if (planningEntry.userConfirmed === true) {
                deliver([
                    planMessage,
                    makeUserMessage('✅ 已采纳您此前的确认回复：后台分解（结合全部上下文的深入分析）已纳入您的确认，本计划不再等待认可，正在自动放行并派发。', { kind: 'workplan-confirm-dispatch', form: 'notice', summary: '已按用户确认自动放行并派发' }),
                ]);
            }
            else {
                deliver([planMessage]);
            }
            if (autoDispatched) {
                if (planningEntry.userConfirmed === true) {
                    record.conversationContext = recentConversation(session);
                }
                record.dispatchedAt = Date.now();
                // [T7] C3 整轮预算：自动派发同样重置（与显式派发同口径）。
                resetRoundInjectionBudget(session, `${record.plan.planId}:${record.dispatchedAt}`);
                state.startAutoDispatch?.(record, session, payload.agent);
            }
            else if (plannerSalvaged) {
                /*
                 * [3.0.6][复审修复] 残缺计划的暂停通知：计划照展示（用户需要看到抢救
                 * 结果），但什么都不开跑。计划级留痕进 record.errors，随 durable 回放
                 * 不丢；用户确认后由主 Agent 显式 dispatch。
                 */
                record.errors = [...(record.errors ?? []),
                    '规划器只抢救出残缺计划（outcome=SALVAGED），已暂停自动执行；请人工确认后再 workplan_dispatch。'].slice(-20);
                deliver([
                    makeUserMessage([
                        '⚠️ 规划器只抢救出残缺计划：模型输出在超时/中断前被截断，仅通过部分校验。',
                        '为避免残缺计划在无人复核的情况下直接执行，本次已暂停自动派发。',
                        '请人工核对该计划：确认可用后告知主 Agent 调用 dsh_workplan_dispatch 开跑；不可用可要求重新分解。',
                    ].join('\n'), {
                        kind: 'workplan-salvaged',
                        form: 'notice',
                        summary: '规划器只抢救出残缺计划，已暂停自动执行，请确认后再 workplan_dispatch',
                    }),
                ]);
            }
            return;
        }
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
        return deliver([planMessage, note]);
    };
    const planningPromise = (async () => {
        try {
            await runPlanningInBackground();
        }
        catch (error) {
            if (!planningEntry.superseded)
                pushRecordError(planningRecord, error);
        }
        finally {
            payload.signal.removeEventListener('abort', forwardPayloadAbort);
            // 旧任务被取代后，只能清理自己的登记，不能删掉新任务的 in-flight。
            if (state.planningInFlight.get(session.id) === planningEntry) {
                state.planningInFlight.delete(session.id);
            }
        }
    })();
    planningEntry.promise = planningPromise;
    void planningPromise;
    /*
     * 同步注入给本步模型的说明：先等计划，不要自己动手做用户的活。文案复用
     * 用户逐字冻结的 STATUS_ASSIGNING_TEXT，不另造第二份固定文案。
     */
    return enterDecision(downstream, [makeUserMessage(
        /*
         * [3.0.0][不重复] 固定文案已由上面的 appendUserMessage(STATUS_ASSIGNING_TEXT)
         * 写入会话，这里只给本步模型一条行为说明——绝不第二次复述同一句固定文案，
         * 否则用户会看到两条一模一样的「任务正在分配中」。
         */
        '（dsh-workplan：任务分解已在后台生成中，计划一生成就立即显示在本会话并自动派发；现在请不要自己动手执行用户任务，也不要提前收尾，先简短告知用户正在分配。）', { kind: 'workplan', form: 'notice', summary: '任务分解已转为后台生成' })]);
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
