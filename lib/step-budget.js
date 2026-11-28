/**
 * [3.2.4][步数预算][治本] 步数预算：把「钱」的杠杆从单价搬到步数。
 *
 * 背景（reports/wp-diagnosis-token-and-expert-stop-20261123.md 第二节实测）：
 * 一个 124 步的专家会话合计 13,263,562 token，其中 95% 是同一段对话被每一步
 * 反复读（cacheRead）；13 步的同型会话合计 542,450。合计 token 与步数近似
 * 线性，所以控钱的第一杠杆是步数，不是单价。但直接给专家加「步数上限」
 * 会与已冻结的机制契约冲突——「专家执行没有总时长、单次时长、空闲或回执
 * 硬截止」。因此本模块的实现口径是：
 *
 *  - 默认开启（软 60 / 硬 75）：`DSH_WORKPLAN_STEP_BUDGET=0|false|off` 可整体
 *    关闭，正整数 n 表示软上限 n、硬上限 ceil(n×1.25)；
 *  - 生效点是**结算时（settle-time），不是中途击杀**：插件无法安全中止一个
 *    正在运行的宿主子会话（没有它的 abort 信号），而且「任务做到 80 步终于
 *    成功」绝不能反过来判失败。所以：
 *      · 结果为 done ⇒ 只在步数 ≥ 软上限时 console.warn 留痕，不改任何状态；
 *      · 结果不是 done ⇒ 在失败 error 里追加步数上下文（N 步、软/硬上限、
 *        是否超硬上限），让重派决策有据可依——配合 failedErrorWithHarvestNote
 *        的产物收编说明，失败也不丢已完成的工作；
 *  - 永不改判成功为失败、永不中断回合——与「专家执行没有总时长、单次时长、
 *    空闲或回执硬截止」的冻结契约零冲突。
 *  - 只统计「assistant/message」事件数（每步一个）。phase-0/仅工具步与正文步
 *    一视同仁——它们同样驱动整段对话重读。
 *
 * 宿主没有把「当前步号」直接给插件，所以这里用会话日志自数。扫描有界
 * （countCap 提前止损），不引入 O(全史) 成本。
 */
export const STEP_BUDGET_ENV = 'DSH_WORKPLAN_STEP_BUDGET';
/** 硬上限默认值：软上限的 1.25 倍向上取整，兜底必须有界。 */
export const STEP_HARD_MULTIPLIER = 1.25;
/** 默认软上限：与「每批 ≤5 名专家」的实测 213s/约 20 步的量级对齐。 */
export const DEFAULT_STEP_BUDGET = 60;
/** 解析环境变量：'0'/'false'/'off' ⇒ 关闭；正整数 ⇒ 软上限；非法 ⇒ 默认 60。 */
export function parseStepBudget(raw) {
    const text = String(raw ?? '').trim().toLowerCase();
    if (text === '') {
        const soft = DEFAULT_STEP_BUDGET;
        return { soft, hard: Math.ceil(soft * STEP_HARD_MULTIPLIER) };
    }
    // 'no' 与 auto-resume 的开关口径保持一致：同一个值在两个开关上不能有两种含义。
    if (text === '0' || text === 'false' || text === 'off' || text === 'no')
        return { soft: null, hard: 0 };
    const n = Number(text);
    if (Number.isInteger(n) && n > 0) {
        return { soft: n, hard: Math.ceil(n * STEP_HARD_MULTIPLIER) };
    }
    const soft = DEFAULT_STEP_BUDGET;
    return { soft, hard: Math.ceil(soft * STEP_HARD_MULTIPLIER) };
}
/**
 * 数一个会话在 afterSeq 之后出现的 assistant/message 条数（即模型步数）。
 * countCap 提前止损：预算已爆就不需要精确值。
 */
export function countAssistantSteps(session, afterSeq, countCap = 4096) {
    if (!session || typeof session.eventAt !== 'function')
        return 0;
    const total = Number(session.seq);
    if (!Number.isFinite(total) || total <= 0)
        return 0;
    const from = Math.max(0, Math.floor(Number(afterSeq) || 0));
    let count = 0;
    for (let seq = from; seq < Math.floor(total); seq += 1) {
        let event;
        try {
            event = session.eventAt(seq);
        }
        catch {
            continue;
        }
        if (!event)
            continue;
        if (event.type !== 'assistant/message')
            continue;
        count += 1;
        if (count >= countCap)
            return count;
    }
    return count;
}
export function judgeStepBudget(steps, config) {
    if (config.soft === null)
        return { level: 'ok', steps, soft: null, hard: config.hard };
    if (steps >= config.hard)
        return { level: 'hard', steps, soft: config.soft, hard: config.hard };
    if (steps >= config.soft)
        return { level: 'soft', steps, soft: config.soft, hard: config.hard };
    return { level: 'ok', steps, soft: config.soft, hard: config.hard };
}
/**
 * 软上限文案（**目前故意未接线**）。
 *
 * 设计取舍：在专家运行途中给他发「你到 60 步了，快收尾」这类消息，技术上可行
 * （平台能给子会话 sendMessage），但它会把「成本压力」变成「质量压力」——
 * 模型收到催促后最常见的反应是提前交卷、少做一步验证，而不是少做无意义重复。
 * 验收门禁不会因此放宽，交薄了只会被退回重做，反而更贵。
 *
 * 因此 v1 只做结算后记账（console.warn + durable 台账 + 失败 error 上下文），
 * 不给运行中的专家任何到点信号。若将来要启用中途提醒，必须先单独评估质量影响，
 * 并把「只提醒、不催交、绝不降低证据要求」写进文案。
 */
export function wrapUpNote(steps, soft) {
    return `步数提醒：该会话已 ${steps} 步（软上限 ${soft}）——请继续把验收证据做全，不要为省步数削减证据。`;
}
/**
 * 失败 error 的步数上下文（只在结果不是 done 时追加，配合产物收编说明）。
 * refs 为空时只报步数，不提产物。
 */
export function budgetFailureContext(steps, config, harvestRefs) {
    if (config.soft === null)
        return '';
    const exceeded = steps >= config.hard ? '，已超硬上限' : '';
    const base = `步数预算：本会话 ${steps} 步（软 ${config.soft}/硬 ${config.hard}${exceeded}）`;
    if (harvestRefs.length === 0)
        return base;
    return `${base}；已落盘结算备份（可先收编核验，勿按零产出重做）：${harvestRefs.slice(0, 3).join('、')}`;
}
/**
 * [3.4.0][防失控治本] 单子会话累计 token 预算（默认硬上限 2,000,000 token，软上限 75% = 1,500,000）。
 *
 * 历史实测（2026-11-23）：单个 124 步专家会话烧掉 13,263,562 token。仅有结算后
 * `console.warn` 无法阻止失控循环烧穿用户预算；此处提供可配置的运行期步数 + token
 * 双维度软提醒与硬熔断判定（`DSH_WORKPLAN_TOKEN_BUDGET=0|false|off|no` 可关闭）。
 */
export const TOKEN_BUDGET_ENV = 'DSH_WORKPLAN_TOKEN_BUDGET';
export const DEFAULT_TOKEN_BUDGET = 2_000_000;
export const TOKEN_SOFT_RATIO = 0.75;
export function parseTokenBudget(raw) {
    const text = String(raw ?? '').trim().toLowerCase();
    if (text === '') {
        return { hard: DEFAULT_TOKEN_BUDGET, soft: Math.floor(DEFAULT_TOKEN_BUDGET * TOKEN_SOFT_RATIO) };
    }
    if (text === '0' || text === 'false' || text === 'off' || text === 'no') {
        return { hard: null, soft: 0 };
    }
    const n = Number(text);
    if (Number.isFinite(n) && n >= 10_000) {
        const hard = Math.floor(n);
        return { hard, soft: Math.floor(hard * TOKEN_SOFT_RATIO) };
    }
    return { hard: DEFAULT_TOKEN_BUDGET, soft: Math.floor(DEFAULT_TOKEN_BUDGET * TOKEN_SOFT_RATIO) };
}
export const PLAN_TOKEN_BUDGET_ENV = 'DSH_WORKPLAN_PLAN_TOKEN_BUDGET';
export const PLAN_WEIGHTED_BUDGET_ENV = 'DSH_WORKPLAN_PLAN_WEIGHTED_BUDGET';
export const SESSION_WEIGHTED_BUDGET_ENV = 'DSH_WORKPLAN_SESSION_WEIGHTED_BUDGET';
/**
 * [3.4.2] 主流大模型真实计费权重：
 * cacheRead ~0.1×，input 1×，cacheWrite ~1.25×，output（含 thinking）~5×。
 * 用等效计费 token 替代单纯 1:1 raw token，既不误杀高缓存命中（90%+）的优质工作，
 * 也能精准刹住狂吐高价 Output/Thinking 的失控循环。
 */
export const BILLING_WEIGHTS = Object.freeze({
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 5,
});
export function computeRawTokens(usage) {
    if (!usage || typeof usage !== 'object')
        return 0;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    return Math.floor(n(usage.inputTokens) + n(usage.outputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens));
}
export function computeWeightedTokens(usage) {
    if (!usage || typeof usage !== 'object')
        return 0;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    return Math.floor(n(usage.inputTokens) * BILLING_WEIGHTS.input
        + n(usage.cacheReadTokens) * BILLING_WEIGHTS.cacheRead
        + n(usage.cacheWriteTokens) * BILLING_WEIGHTS.cacheWrite
        + n(usage.outputTokens) * BILLING_WEIGHTS.output);
}
export function parseWeightedBudget(raw, fallbackHard) {
    const text = String(raw ?? '').trim().toLowerCase();
    if (text === '') {
        if (fallbackHard === null)
            return { hard: null, soft: 0 };
        return { hard: fallbackHard, soft: Math.floor(fallbackHard * TOKEN_SOFT_RATIO) };
    }
    if (text === '0' || text === 'false' || text === 'off' || text === 'no') {
        return { hard: null, soft: 0 };
    }
    const n = Number(text);
    if (Number.isFinite(n) && n >= 10_000) {
        const hard = Math.floor(n);
        return { hard, soft: Math.floor(hard * TOKEN_SOFT_RATIO) };
    }
    if (fallbackHard === null)
        return { hard: null, soft: 0 };
    return { hard: fallbackHard, soft: Math.floor(fallbackHard * TOKEN_SOFT_RATIO) };
}
export function parsePlanTokenBudget(raw, profile = 'balanced') {
    const fallbackHard = profile === 'ultra-lean' ? 800_000 : profile === 'balanced' ? 3_000_000 : null;
    return parseWeightedBudget(raw, fallbackHard);
}
export function resolveProfileBudgets(profile = 'balanced', env = process.env, subtaskCount) {
    const count = Number.isFinite(Number(subtaskCount)) && Number(subtaskCount) > 0
        ? Math.min(15, Math.floor(Number(subtaskCount)))
        : 0;
    const stepRaw = env[STEP_BUDGET_ENV];
    const stepConfig = typeof stepRaw === 'string' && stepRaw.trim() !== ''
        ? parseStepBudget(stepRaw)
        : profile === 'ultra-lean'
            ? { soft: 20, hard: 25 }
            : profile === 'balanced'
                ? { soft: 35, hard: 45 }
                : parseStepBudget(undefined);
    const sessionTokenRaw = env[TOKEN_BUDGET_ENV];
    const sessionTokenConfig = typeof sessionTokenRaw === 'string' && sessionTokenRaw.trim() !== ''
        ? parseTokenBudget(sessionTokenRaw)
        : profile === 'ultra-lean'
            ? { hard: 2_000_000, soft: 1_500_000 }
            : profile === 'balanced'
                ? { hard: 6_000_000, soft: 4_500_000 }
                : parseTokenBudget(undefined);
    const sessionWeightedFallback = profile === 'ultra-lean' ? 250_000 : profile === 'balanced' ? 600_000 : null;
    const sessionWeightedConfig = parseWeightedBudget(env[SESSION_WEIGHTED_BUDGET_ENV], sessionWeightedFallback);
    const planTokenFallback = profile === 'ultra-lean'
        ? (count > 0 ? Math.min(4_000_000, Math.max(800_000, count * 400_000)) : 800_000)
        : profile === 'balanced'
            ? (count > 0 ? Math.min(15_000_000, Math.max(3_000_000, count * 1_200_000)) : 3_000_000)
            : null;
    const planTokenConfig = parseWeightedBudget(env[PLAN_TOKEN_BUDGET_ENV], planTokenFallback);
    const planWeightedFallback = profile === 'ultra-lean'
        ? (count > 0 ? Math.min(1_200_000, Math.max(400_000, count * 120_000)) : 400_000)
        : profile === 'balanced'
            ? (count > 0 ? Math.min(4_000_000, Math.max(1_200_000, count * 350_000)) : 1_200_000)
            : null;
    const planWeightedConfig = parseWeightedBudget(env[PLAN_WEIGHTED_BUDGET_ENV], planWeightedFallback);
    return {
        stepConfig,
        sessionTokenConfig,
        sessionWeightedConfig,
        planTokenConfig,
        planWeightedConfig,
    };
}
/**
 * 运行期每步（agent/pre-step）预算裁决纯函数：
 *  - 优先检查全计划硬上限（等效计费 + 原始 token）→ 再检查单子会话硬上限（等效计费 + 原始 token + 步数）；
 *  - 软上限同理，返回单次收尾提醒（不催交、不降验收标准）；
 *  - 未触及 ⇒ `action: 'ok'`。
 */
export function evaluateRuntimeBudget(input) {
    const steps = Math.max(0, Math.floor(Number(input.steps) || 0));
    const tokens = Math.max(0, Math.floor(Number(input.tokens) || 0));
    const weightedTokens = Math.max(0, Math.floor(Number(input.weightedTokens) || 0));
    const planTokens = Math.max(0, Math.floor(Number(input.planTokens) || 0));
    const planWeightedTokens = Math.max(0, Math.floor(Number(input.planWeightedTokens) || 0));
    const { stepConfig, tokenConfig, weightedConfig, planTokenConfig, planWeightedConfig, } = input;
    if (planWeightedConfig?.hard !== null && planWeightedConfig?.hard !== undefined && planWeightedTokens >= planWeightedConfig.hard) {
        return {
            action: 'abort',
            reason: 'plan-weighted-hard',
            scope: 'plan',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `全计划累计等效计费 token 已达 ${planWeightedTokens.toLocaleString('en-US')}（硬上限 ${planWeightedConfig.hard.toLocaleString('en-US')}），触发计划级总预算熔断并收编已落盘产物`,
        };
    }
    if (planTokenConfig?.hard !== null && planTokenConfig?.hard !== undefined && planTokens >= planTokenConfig.hard) {
        return {
            action: 'abort',
            reason: 'plan-token-hard',
            scope: 'plan',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `全计划累计原始 token 已达 ${planTokens.toLocaleString('en-US')}（硬上限 ${planTokenConfig.hard.toLocaleString('en-US')}），触发计划级总预算熔断并收编已落盘产物`,
        };
    }
    if (weightedConfig?.hard !== null && weightedConfig?.hard !== undefined && weightedTokens >= weightedConfig.hard) {
        return {
            action: 'abort',
            reason: 'weighted-hard',
            scope: 'session',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `单子会话等效计费 token 已达 ${weightedTokens.toLocaleString('en-US')}（硬上限 ${weightedConfig.hard.toLocaleString('en-US')}），触发运行期计费预算熔断并收编已落盘产物`,
        };
    }
    if (tokenConfig.hard !== null && tokens >= tokenConfig.hard) {
        return {
            action: 'abort',
            reason: 'token-hard',
            scope: 'session',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `单子会话累计 token 已达 ${tokens.toLocaleString('en-US')}（硬上限 ${tokenConfig.hard.toLocaleString('en-US')}），触发运行期预算熔断并收编已落盘产物`,
        };
    }
    if (stepConfig.soft !== null && steps >= stepConfig.hard) {
        return {
            action: 'abort',
            reason: 'step-hard',
            scope: 'session',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `单子会话已执行 ${steps} 步（硬上限 ${stepConfig.hard} 步），触发运行期步数熔断并收编已落盘产物`,
        };
    }
    if (planWeightedConfig?.hard !== null && planWeightedConfig?.hard !== undefined && planWeightedTokens >= planWeightedConfig.soft) {
        return {
            action: 'warn',
            reason: 'plan-weighted-soft',
            scope: 'plan',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `计划总预算提醒：全计划等效计费约 ${planWeightedTokens.toLocaleString('en-US')} token（软上限 ${planWeightedConfig.soft.toLocaleString('en-US')} / 硬上限 ${planWeightedConfig.hard.toLocaleString('en-US')}）。请停止发散并收敛交付（不削减必交证据）。`,
        };
    }
    if (planTokenConfig?.hard !== null && planTokenConfig?.hard !== undefined && planTokens >= planTokenConfig.soft) {
        return {
            action: 'warn',
            reason: 'plan-token-soft',
            scope: 'plan',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `计划总预算提醒：全计划累计约 ${planTokens.toLocaleString('en-US')} token（软上限 ${planTokenConfig.soft.toLocaleString('en-US')} / 硬上限 ${planTokenConfig.hard.toLocaleString('en-US')}）。请尽快完成验证并提交结果块（不削减必交证据）。`,
        };
    }
    if (weightedConfig?.hard !== null && weightedConfig?.hard !== undefined && weightedTokens >= weightedConfig.soft) {
        return {
            action: 'warn',
            reason: 'weighted-soft',
            scope: 'session',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `计费预算提醒：本会话等效计费约 ${weightedTokens.toLocaleString('en-US')} token（软上限 ${weightedConfig.soft.toLocaleString('en-US')} / 硬上限 ${weightedConfig.hard.toLocaleString('en-US')}）。请减少冗余输出，立即收敛验证并提交完整结果块（不削减必交证据）。`,
        };
    }
    if (tokenConfig.hard !== null && tokens >= tokenConfig.soft) {
        return {
            action: 'warn',
            reason: 'token-soft',
            scope: 'session',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `预算提醒：本会话累计约 ${tokens.toLocaleString('en-US')} token（软上限 ${tokenConfig.soft.toLocaleString('en-US')} / 硬上限 ${tokenConfig.hard.toLocaleString('en-US')}）。请停止发散试错，立即收敛并输出完整结构化结果块（不削减必交证据）。`,
        };
    }
    if (stepConfig.soft !== null && steps >= stepConfig.soft) {
        return {
            action: 'warn',
            reason: 'step-soft',
            scope: 'session',
            steps,
            tokens,
            weightedTokens,
            planTokens,
            planWeightedTokens,
            message: `${wrapUpNote(steps, stepConfig.soft)}（硬上限 ${stepConfig.hard} 步将触发预算熔断，请尽快完成验证并提交结果块。）`,
        };
    }
    return { action: 'ok', reason: 'none', scope: 'session', steps, tokens, weightedTokens, planTokens, planWeightedTokens, message: '' };
}
