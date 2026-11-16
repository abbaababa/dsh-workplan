/**
 * [3.0.1][历史模块] 「简单」判据 v2 · 判据层（criterion layer）。
 *
 * **生产已停用**：用户已取消部门负责人及全球顶尖专家的执行时限，
 * `criterionV2Active()` 现在无条件返回 false，任何环境变量、计划时间或旧字段
 * 都不能重新开启 `≤10 分钟才能 done` 的间接时间门。本文件保留纯函数，仅供
 * 旧记录回放、历史审计和既有单元测试解释当时规则，不参与新任务结算。
 *
 * 口径来源（历史，逐字保留以便追溯）：
 *  - reports/simple-criterion-v2-spec.md（用户 2026-11-13 裁决 B/B/B/B/A/A/B）：
 *    S-Q1-1..6 / S-Q2-1..4 / S-Q3-1..4 / S-Q4-1..5 / S-Q5-1..5 / S-Q6-1..5 / S-Q7-1..5，
 *    §3.5 唯一判定链（met / exception-approved / unmet 三选一）。
 *  - reports/simple-criterion-v2-touchpoints.md C05–C10 / C22 / C29（机制落点）。
 *  - reports/simple-criterion-v2-open-decisions.md D-1~D-4 推荐项（均选 A，
 *    **待用户裁定**；本模块按推荐实现，裁定前不得据以宣称达标）。
 *
 * 分层纪律（Q7-B，红线）：
 *  - 本模块只承载**判据层**（完成目标 ≤10 分钟）；**运行层**安全兜底
 *    （CHILD_TIMEOUT_MS=900000 / MAX_CHILD_TIMEOUT_MS=7200000 /
 *    deriveSubtaskTimeoutMs 公式 / L4 结算）数值与公式一律不改。
 *  - 判据层不改变运行层时限；运行层允许延长不等于判据层达标。
 *
 * 历史生效边界（Q5-A/D-1；当前已全部失效）：
 *  - 旧版本曾用 DSH_WORKPLAN_CRITERION_V2 与 _SINCE 按计划创建时间开启；
 *  - [3.0.1] 该开关已被硬编码关闭，且不得恢复。即使环境变量齐全、计划新建，
 *    `criterionV2Active()` 仍为 false；时长不参与 done 判定。
 *  - `evaluateCriterion` 等纯函数仍可被历史测试/审计直接调用，但其结论不会
 *    进入生产结算路径。
 *
 * 本模块不 import plan.ts / runtime.ts（避免循环依赖）：聚合结果
 * （LeaderEstimateSummary 形状）由调用方以参数传入。
 */
/** [历史] 旧判据层目标（分钟）；仅供纯函数审计，不参与新任务验收。 */
export const CRITERION_TARGET_MINUTES = 10;
/** 结算判据三选一（spec §3.5 第 4 步）。 */
export const CRITERION_RESULTS = ['met', 'unmet', 'exception-approved'];
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * fail-closed 消毒（与 sanitizeDelegateEstimate 同风格）：任一必填项缺失/非法
 * ⇒ 整个批准丢弃（返回 null），绝不入库脏值、绝不把「未批准」洗成「已批准」。
 */
export function sanitizeCriterionException(value) {
    if (!isRecord(value))
        return null;
    if (value.approvedBy !== 'user')
        return null;
    const at = Number(value.at);
    if (!Number.isFinite(at) || at <= 0)
        return null;
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    if (reason === '')
        return null;
    if (value.scope !== 'task' && value.scope !== 'plan')
        return null;
    const extendedMs = Number(value.extendedMs);
    const extendedMinutes = Number(value.extendedMinutes);
    return {
        approvedBy: 'user',
        at,
        reason: reason.slice(0, 2000),
        ...(typeof value.source === 'string' && value.source.trim() !== ''
            ? { source: value.source.trim().slice(0, 500) }
            : {}),
        scope: value.scope,
        ...(Number.isFinite(extendedMs) && extendedMs > 0 ? { extendedMs: Math.floor(extendedMs) } : {}),
        ...(Number.isFinite(extendedMinutes) && extendedMinutes > 0
            ? { extendedMinutes: Math.round(extendedMinutes * 100) / 100 }
            : {}),
    };
}
/**
 * [3.0.1] 判据 v2 是否对该计划生效。
 *
 * 现在恒为 false：这是取消执行时限后的硬边界，不是默认值。保留参数是为了
 * 兼容旧调用签名与历史测试；任何环境变量都不能让判据重新进入生产结算。
 */
export function criterionV2Active(planCreatedAt, env = process.env) {
    // 用户已取消部门负责人及全球顶尖专家的执行时限：历史环境变量不得重新启用
    // “≤10 分钟才能 done”的间接时间门。evaluateCriterion 仍保留供历史记录/回放审计。
    void planCreatedAt;
    void env;
    return false;
}
/**
 * [SCv2-T4][Q6-A/C28/C29] 单次尝试墙钟（毫秒）＝结算时间 − 尝试起点。
 *
 * 数据源只认 journal 时间戳（startedAt/finishedAt），绝不采用模型自报分钟数
 * （S-Q6-3）。已知陷阱（touchpoints C29 ⚠）：预算重置会清空 startedAt/finishedAt
 * ——缺失时返回 null（「未验证」），**绝不返回 0**（否则把「计时被清空」误判成
 * 「0 分钟完成」）。每次尝试独立计量，不跨尝试累计（S-Q6-1/2）。
 */
export function attemptWallClockMsOf(row) {
    if (!isRecord(row))
        return null;
    // null/undefined 必须显式拒绝：Number(null)===0 会把「计时被重置清空」
    // 误判成「0 分钟完成」（Q6-A 唯一实现陷阱，touchpoints C29 ⚠）。
    if (row.startedAt === null || row.startedAt === undefined)
        return null;
    if (row.finishedAt === null || row.finishedAt === undefined)
        return null;
    const started = Number(row.startedAt);
    const finished = Number(row.finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished))
        return null;
    return Math.max(0, finished - started);
}
/**
 * [SCv2-T4][Q4-B/D-2 推荐 A/D-3 推荐 A] 部门行事前预估口径。
 *
 * - 有叶子（leaderEstimate 非 null）：事前值＝全部叶子最新 sent 预估之和；
 *   reported===expected 才算「齐」（部分和不得视为达标，S-Q4-5/D-3）。
 * - 无叶子直做（leaderEstimate null）：事前值＝负责人自身开工预估
 *   （row.timeNotice.declaredMinutes，D-2 推荐 A，对称于叶子之和）；缺失⇒不齐。
 *   绝不因「没有叶子」而自动豁免（S-Q4-4）。
 *
 * leaderEstimate 由调用方传 plan.ts deriveLeaderEstimate 的结果（形状兼容），
 * 本模块不重复求和、不反写台账（F6/J8 同纪律）。
 */
export function criterionExAnte(row, leaderEstimate) {
    if (leaderEstimate && Number.isFinite(Number(leaderEstimate.totalMinutes))) {
        return {
            minutes: Number(leaderEstimate.totalMinutes),
            complete: leaderEstimate.reported === leaderEstimate.expected && leaderEstimate.expected > 0,
        };
    }
    const notice = isRecord(row) && isRecord(row.timeNotice) ? row.timeNotice : null;
    const declared = notice ? Number(notice.declaredMinutes) : NaN;
    if (Number.isFinite(declared) && declared > 0)
        return { minutes: declared, complete: true };
    return { minutes: null, complete: false };
}
/**
 * [SCv2-T4][spec §3.5 第 4 步 / S-Q6-5 / D-4 推荐 A] 判据层结算判定（纯函数）。
 *
 * 达标（met）＝事前预估之和 ≤10 **且** 事后单次尝试墙钟 ≤10（双条件同时满足）；
 * 任一不满足且无有效用户批准 ⇒ unmet（不得 done、记违规、转接替行）；
 * 有有效用户批准 ⇒ exception-approved（可 done、留例外、不生成接替行）。
 *
 * 批准时机（C-4 推荐 A，待裁定）：批准必须不晚于本次结算（at <= settledAt）；
 * 结算后追认一律无效（防「事后洗白」），只能批准接替行。
 *
 * 严格口径（D-3 推荐 A，待裁定）：事前预估未齐 / 墙钟缺失（被重置清空）
 * ⇒ 不得宣称达标，按 unmet 处理并如实给出 reasons；受平台缺陷影响的行
 * 可经 Q1 例外审批留痕后豁免（exception-approved 分支）。
 */
export function evaluateCriterion(input) {
    const reasons = [];
    let over = false;
    if (!input.exAnteComplete) {
        over = true;
        reasons.push('ex-ante-incomplete：事前预估未齐或缺失（D-3 严格口径，不得视为达标）');
    }
    else if (input.exAnteMinutes !== null && input.exAnteMinutes > CRITERION_TARGET_MINUTES) {
        over = true;
        reasons.push(`ex-ante-over：事前预估 ${input.exAnteMinutes} 分钟 > ${CRITERION_TARGET_MINUTES} 分钟目标`);
    }
    if (input.wallClockMs === null) {
        over = true;
        reasons.push('wall-clock-unverified：单次尝试墙钟缺失（计时被重置或无时间戳），不得按 0 分钟判达标（Q6-A）');
    }
    else if (input.wallClockMs > CRITERION_TARGET_MINUTES * 60_000) {
        over = true;
        reasons.push(`wall-clock-over：本次尝试墙钟 ${(input.wallClockMs / 60_000).toFixed(2)} 分钟 > ${CRITERION_TARGET_MINUTES} 分钟目标`);
    }
    if (!over) {
        return { criterionResult: 'met', canBeDone: true, needsReplacement: false, exceptionRecorded: false, reasons };
    }
    const exception = input.exception ?? null;
    if (exception) {
        const settledAt = Number.isFinite(Number(input.settledAt)) ? Number(input.settledAt) : Date.now();
        if (exception.at <= settledAt) {
            return {
                criterionResult: 'exception-approved',
                canBeDone: true,
                needsReplacement: false,
                exceptionRecorded: true,
                reasons: [...reasons, 'user-exception：用户明确批准并留痕（Q1-B 唯一例外通道）'],
            };
        }
        reasons.push('approval-after-settlement：批准时间晚于本次结算，事后追认无效（C-4 推荐 A）');
    }
    return { criterionResult: 'unmet', canBeDone: false, needsReplacement: true, exceptionRecorded: false, reasons };
}
/**
 * [SCv2-T4] T5 参考实现 referenceQ3Settlement 的同口径生产适配器（分钟入参）。
 * 生产接线落盘后 T5 只需把 referenceQ3* 替换为本导出，断言口径保持不变。
 */
export function q3SettlementVerdict(input) {
    const exception = input.userApproved === true
        ? { approvedBy: 'user', at: 1, reason: 'user-approved（参考夹具口径）', scope: 'task' }
        : null;
    return evaluateCriterion({
        exAnteMinutes: Number(input.declaredMinutes ?? 0),
        exAnteComplete: true,
        wallClockMs: Number(input.wallClockMinutes ?? 0) * 60_000,
        exception,
        settledAt: Date.now(),
    });
}
/**
 * [SCv2-T4][D-4 推荐 A] 判据违规审计条目（append-only，绝不抹除）。
 * 行级最终结果取最后一次（接替）尝试；原始未批准超时保留在本数组供审计，
 * 防「续跑洗白」。上限 20 条与 timeJournal 同纪律。
 */
export function appendCriterionViolation(existing, entry) {
    const list = Array.isArray(existing) ? existing.filter(isRecord) : [];
    return [...list, { ...entry, kind: 'criterion-overrun' }].slice(-20);
}
