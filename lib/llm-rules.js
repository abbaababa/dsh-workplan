/**
 * [2.3.9][T3] LLM 家族检测与推理等级约束——执行工具层。
 *
 * 单一事实源在 src/plan.ts（REASONING_EFFORTS 五档存储全集旁：classifyModelFamily /
 * allowedEffortsForModel / COMPLEXITY_EFFORT_BY_FAMILY，含用户要求 1/2 原文与
 * 「不得删档/模型未知不约束」的完整语义注释）。本模块只做两件事：
 *  1) 转发真源符号（保持 runtime/replan/tests 的引用面稳定，兼容别名
 *     detectLlmType ≡ classifyModelFamily）；
 *  2) 提供「事前约束」需要的两个执行函数：validateReasoningEffort（集合校验，
 *     给明确错误信息=A3 报错轨）与 correctEffortForModel（越界自动降级修正
 *     =A3 修正轨，绝不抛错中断派发）。
 *
 * 与 [2.2.7] 宿主能力钳制（clampEffortToSupported/resolveSupportedEfforts）的
 * 时序关系：检测(入口) → 静态集合收窄(本模块) → 宿主能力交集钳制 → 发送；
 * 两道闸各自留痕（U7 裁决：静态表权威 + 能力面交集钳制留痕）。
 */
import { allowedEffortsForModel, classifyModelFamily, DEFAULT_REASONING_EFFORT, defuseSessionReferenceText, EFFORT_STRENGTH_ORDER, effortForComplexity, EVIDENCE_MARKER_BEGIN, EVIDENCE_MARKER_END, effortsForModelFamily, highestEffortOf, OTHER_MODEL_EFFORTS, QWEN_MODEL_EFFORTS, REASONING_EFFORTS, truncate, } from './plan.js';
// [3.0.8] 注入 five-step 的五步提示词段落（buildDelegateePrompt 使用）。
import { fiveStepContinuationPromptLines, fiveStepPromptLines, START_EVIDENCE_MIN_CHARS_BRIEF } from './five-step.js';
// [3.0.0] 用户 2026-11-14 第 5、6、7、9 条要求的纯逻辑契约（零依赖模块）：
// 极简任务硬门槛 + 质量要求硬门槛 + 专家精简 JSON 汇报契约。
import { checkAtomicAssignment, detectSequentialChainTask, normalizeQualityRequirements, renderExpertReportSpec, renderQualityRequirementsBlock, } from './v3-contract.js';
// [3.1.0] 数量上限单一真源（复杂任务专家人数 12→25）：与 v3-contract 的 sources
// 上限、plan.ts 的存档消毒同一常量，杜绝「改一处漏一处」的写读不对称。
import { MAX_COMPLEX_DELEGATE_MEMBERS, MIN_COMPLEX_DELEGATE_MEMBERS } from './caps.js';
export { allowedEffortsForModel, classifyModelFamily, effortForComplexity, effortsForModelFamily, highestEffortOf, OTHER_MODEL_EFFORTS, QWEN_MODEL_EFFORTS, };
/** 兼容别名：T3 计划文本中的 detectLlmType ≡ 真源 classifyModelFamily。 */
export const detectLlmType = classifyModelFamily;
/** 兼容别名：T3 计划文本中的 getAllowedEffortLevels(llmType) ≡ 真源 effortsForModelFamily。 */
export const getAllowedEffortLevels = effortsForModelFamily;
/**
 * 集合校验（用户要求 1/2 的硬白名单判定）。
 * @param effort 待校验档位
 * @param allowed 等级集合（null=模型未知，不施加约束，任何值都 ok）
 */
export function validateReasoningEffort(effort, allowed) {
    if (allowed === null)
        return { ok: true };
    if (typeof effort !== 'string' || !allowed.includes(effort)) {
        return {
            ok: false,
            error: `reasoningEffort "${String(effort)}" 不在当前模型家族的推理等级集合 {${allowed.join(', ')}} 内（qwen 系仅 low/medium/xhigh；非 qwen 系仅 low/high/max）——请改用集合内档位`,
        };
    }
    return { ok: true };
}
/** 静态强度序：单一真源是 plan.ts 导出的 EFFORT_STRENGTH_ORDER（[3.0.0] 去副本）。 */
const STATIC_STRENGTH_ORDER = EFFORT_STRENGTH_ORDER;
/**
 * 越界自动降级修正（A3 修正轨）：请求档不在家族集合内时，钳到集合内「不高于
 * 请求档」的最近档（按强度序逐级下探：qwen 下 max→xhigh、high→medium；非 qwen
 * 下 xhigh→high、medium→low），全部更弱则取最弱档；集合未知（模型名缺失）
 * ⇒ 原样透传。派发绝不因档位问题中断。
 */
export function correctEffortForModel(effort, modelId) {
    const allowed = allowedEffortsForModel(modelId);
    if (allowed === null)
        return { effort, adjusted: false, requested: effort };
    if (allowed.includes(effort))
        return { effort, adjusted: false, requested: effort };
    const rank = (id) => STATIC_STRENGTH_ORDER.indexOf(id);
    const ranked = [...allowed].sort((a, b) => rank(a) - rank(b));
    const target = rank(effort);
    const corrected = target < 0
        ? ranked[0]
        : (() => {
            const atOrBelow = ranked.filter((id) => rank(id) >= 0 && rank(id) <= target);
            return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : ranked[0];
        })();
    const family = classifyModelFamily(modelId);
    return {
        effort: corrected,
        adjusted: true,
        requested: effort,
        reason: `${family === 'qwen' ? 'qwen-rule' : 'non-qwen-rule'}:${effort}→${corrected}（模型家族等级集合为 {${allowed.join(', ')}}，越界档按强度序自动降级）`,
    };
}
/**
 * 要求 1/2 的规则全文（供 T4/T4b 部门告知注入引用同一事实源，避免文案漂移）。
 */
export const LLM_REASONING_RULES_TEXT = [
    '1. 分配任务前先判断用户此刻使用的大模型：字母 qwen 开头的模型，推理等级只包括 low、medium、xhigh——轻度任务使用 low，比较复杂的任务使用 medium，非常复杂的任务使用 xhigh。',
    '2. 非 qwen 开头的其他大模型，推理等级只包括 low、high、max——轻度任务使用 low，比较复杂的任务使用 high，非常复杂的任务使用 max。',
].join('\n');
export function buildLlmRulesBrief(info = {}) {
    const family = info.family ?? classifyModelFamily(info.model ?? null);
    const allowed = info.allowed ?? allowedEffortsForModel(info.model ?? null);
    const lines = [
        '[LLM 推理等级强制规则（用户要求 1/2，全员告知）]',
        LLM_REASONING_RULES_TEXT,
        `- 本会话模型：${info.model || '未知'}`
            + (info.model ? `（${family === 'qwen' ? 'qwen' : '非 qwen'}）` : '')
            + (allowed ? `；可用等级 {${allowed.join(', ')}}` : ''),
    ];
    if (info.effort) {
        const adjusted = Boolean(info.requested) && info.requested !== info.effort;
        lines.push(`- 本任务等级 \`${info.effort}\`，全程应用（预告、执行、验证、复盘）`
            + (adjusted
                ? `；请求档 \`${info.requested}\` 越出当前模型家族等级集合，已按规则自动钳制修正${info.correctionReason ? `（${info.correctionReason}）` : ''}。`
                : '。'));
    }
    if (info.taskEffort) {
        lines.push(`- 部门负责人已为本任务配置整体推理等级 \`${info.taskEffort}\`（effortOverride，负责人自配档）：本任务每次派发/重试/续跑全程沿用该等级，不得中途丢弃或覆盖；下级自己的等级以 self_effort 自配为权威（分工表档仅建议）。`);
    }
    if (info.tier === 'delegate') {
        /*
         * [3.1.7][P3 U-24/U-26] 专家规则简报不再重发五步全文与预估门禁全文。
         *
         * 旧实现这条长行把「五步前三步全文 + startPhases 结构 + 自配档 + 预估
         * 门禁」整段写一遍，而 buildDelegateePrompt 的「执行要求」与末尾
         * fiveStepPromptLines() 已经逐字包含同一份内容（T4 A01/A03：每次派发
         * 多注入 485–755 字符）。现在简报只留身份 + 指针（五步协议见任务书下方、
         * 预估义务见执行要求），关键串「执行自己的任务必须遵守五步工作法的前三步」
         * 与 startPhases 保活（守门测试钉住），正文只在任务书里出现一次。
         */
        lines.push(`- 你是部门第三层执行者（全球顶尖专家${info.memberName ? `：${info.memberName}` : ''}）：执行自己的任务必须遵守五步工作法的前三步（协议见任务书）；phase-0 经 self_effort 交 startPhases 与自配 reasoningEffort+complexityRationale，按自配档接续，全程少走弯路；开工前经 timeNotice 报预估，未报不接续。`);
    }
    else {
        // [2.5.4][T4][3.1.0] 人数口径同步（D1/D2）：low/未配置禁派；复杂（medium/high/xhigh/max）
        // ≥8 且 ≤25（上限随 caps.ts，环境变量可覆盖，提示词与门禁同源不漂移）。
        /*
         * [3.2.4][省钱 R6] phase-1 任务书不再携带 phase-0 口径。
         *
         * phase-0 只负责自评复杂度与登记前三步（另有 buildPhaseZeroLeaderPrompt）；
         * phase-1 的负责人拿到的是同一份简报，旧文案却仍要求「先完成前三步…
         * phase-0 low 启动」，与接续块「前三步已完成，不要重做」正面冲突，还把
         * 已完成的流程每一步重付一次。这里按阶段分流：phase-1 只说派活与人数
         * 口径，不再重述已完成的开工流程（前缀保活：plan.ts 用「部门负责人强制
         * 流程」判断简报是否已带本段，避免重复注入）。
         */
        const deptFlowHead = info.phase1
            ? '- 部门负责人强制流程（phase-1 接续）：五步前三步已在 phase-0 完成并登记（见接续块与登记原文），不要重做、不要重复登记；用 dsh_workplan_delegate(action="review") 提交分工表（assignments+consolidation.taskReasoningEffort）后即可 dispatch 派活；未交分工表前 dispatch 硬拒。'
            : '- 部门负责人强制流程：执行自己的任务必须先完成五步前三步，经 dsh_workplan_delegate(action="review") 提交分工表（assignments+consolidation.taskReasoningEffort）与 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }；phase-0 low 启动，登记后按你的自配档接续 phase-1；未交前 dispatch 硬拒。';
        lines.push(deptFlowHead
            + `任务拆极简后派给本部门多名相关领域全球顶尖专家（role="expert"，≥1 名，单一目标、单一主产物、可独立验收）；low/未配置任务禁止下派——负责人亲自执行，第 1/2/3 步证据经 dsh_workplan_delegate(action="direct") 登记（${START_EVIDENCE_MIN_CHARS_BRIEF}；可选 reasoningEffort="low"）；复杂任务（medium/high/xhigh/max）合计不少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人且最多 ${MAX_COMPLEX_DELEGATE_MEMBERS} 人，少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人硬性阻断，超过上限平台拒收（可精简名单或拆两轮派发，绝不静默丢人无痕）。专家经 self_effort 按单项复杂度自配（轻度=low；qwen 中等=medium、非 qwen=high；复杂=xhigh/max），专家自配为权威；本部门再分配权限仅限本部门，越界钳制留痕；全程少走弯路；第三层为叶子层，第四层拒绝；action="status" 查看进度。`);
        /*
         * [3.0.0] 用户 2026-11-14 第 3、5、6、7、8、10、11 条要求：负责人侧四条硬规则。
         * 与代码门禁同源（planDelegations 的 checkAtomicAssignment、comm-format 的
         * F10/F11），提示词只是把代码已经在执行的规则提前说清楚。
         */
        lines.push('- 每条带 qualityRequirements（1-8 条、每条≤400 字符），写清合格/不合格，缺失拒发（DELEGATE_QUALITY_REQUIREMENTS_MISSING）；任务须一动作/一主产物/可独立验收、≤300 字符、无并列词，否则拒发（DELEGATE_TASK_NOT_ATOMIC）。');
        lines.push('- report 四数组（keyResults/keyInfo/importantInfo/leadRequirements）各≤6 条、每条≤200 字符，缺项/重复 F10 退回；departmentSummary 见 F11，sources 必须覆盖全部已派发专家。');
        lines.push('- 时间：均无硬截止，预估只用于协调，extendMs 已停用；done 只看真实结果、产物、结构化证据与质量验收。专家 escalate 后禁止 review/dispatch/direct 改派，先 status 梳理再 instruct 答复原 member。');
    }
    /*
     * [3.2.3] 顺序链不拆 + 共享文件不并发写：提示词提前说清，硬闸在
     * planDelegations（链拆分拒收）与 dispatchPlan（按产物路径互斥）执行。
     */
    lines.push('- 顺序推理链（先…再/逐步/基于上一步结论）不得拆给多个独立专家上下文：只派 1 名专家一次做完（链式任务豁免复杂任务 ≥8 人下限，全链写进同一份产物），或由负责人亲自执行——亲自执行必须先自评复杂度，再经 action="direct" 提交自评复杂档 reasoningEffort（qwen: medium/xhigh；非 qwen: high/max，不得 low）+ startPhases 开工证据；跨子任务只传已落盘产物引用。共享可变文件只写本任务 outputs 声明的产物，未声明的共享文件不要并发写。');
    /*
     * [3.2.4][治本 H3] 单批人数软上限：宿主子代理并发位是整个会话树共享的
     * （subagent.maxActiveSubagents，默认 4-8 量级），排队超过 120 秒预算后
     * 负责人本轮会以 CHILD_NOT_COMPLETED 结束。
     *
     * 缺陷现场（2026-11-23 wp-32bee059 T4/T5）：负责人一次把 8 名专家全推出去，
     * 排在队尾的成员 120 秒内没拿到空位 ⇒ 本轮整轮判为未完成 ⇒ 其余成员的产物
     * 无人结算、台账被标记 failed，实际已落盘的工作只能重跑。这不是并发 bug，
     * 是「一次推太多」的调度策略问题，所以放在提示词层的软约束里，配合平台
     * 已有的「done/running 跳过、failed 先重试」语义即可收敛。
     */
    lines.push('- 分批派出（强制软约束）：专家人数多于 5 名时，按每批 ≤5 名分批 review/dispatch；上一批有成员进入 running/done 后再派下一批。宿主子代理并发位是整个会话树共享的，一次推满会让队尾成员在本轮排队预算内起不来，导致本轮整轮判为未完成、已完成成员无人结算。分批不影响总人数与验收口径。');
    return lines.join('\n');
}
const MAX_DELEGATE_MEMBERS = 6;
/*
 * [3.1.0] 复杂人数下限 8 / 上限 25（原 12）已收口到 caps.ts（单一真源，含环境
 * 变量覆盖 DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS）。D1/D2 语义不变：复杂任务
 * （声明档 medium/high/xhigh/max）少于 8 人硬性阻断；low/未配置保持禁派
 * （MAX_DELEGATE_MEMBERS=6 仅保留给历史/非法档路径，正常低档位在禁派闸已被拦）。
 */
// const MIN_COMPLEX_DELEGATE_MEMBERS / MAX_COMPLEX_DELEGATE_MEMBERS → ./caps.ts
/** [2.5.4][T4] D1：除 low 外全部算复杂——medium/high/xhigh/max 均触发 ≥8 人门禁，xhigh 不豁免。 */
const COMPLEX_DECLARED_EFFORTS = Object.freeze(['medium', 'high', 'xhigh', 'max']);
// [3.0.8] 梳理产物（problemAnalysis/approach/approachBasis 等）已随两轮思考
// deepThink 门禁废除，分工表闸不再读取清单字段，readTrimmedStrings 一并退役。
/**
 * 梳理产物校验 + 分工表校验 + 等级钳制，三合一（一次调用给出全部拒因）。
 * @param input.consolidation 部门负责人提交的梳理产物（review 阶段写入行，
 *        dispatch 阶段从行读回；两处都走这里，门禁与派发同一判据）
 * @param input.model 当前会话模型 id（未知 ⇒ allowed=null ⇒ 不施加静态收窄，
 *        但仍必须落在五档存储全集内——枚举校验永不放松）
 */
export function planDelegations(input) {
    const empty = { ok: false, code: 'DELEGATE_CONSOLIDATION_MISSING', members: [], clamped: [], taskEffort: null, taskEffortClamped: null };
    const consolidation = input?.consolidation;
    if (!consolidation || typeof consolidation !== 'object') {
        return { ...empty, error: '尚未提交分工表：先用 dsh_workplan_delegate(action="review") 提交分工表（assignments + taskReasoningEffort），派发才会放行（用户要求 4 的硬门禁）。' };
    }
    /*
     * [3.0.8] 深度梳理质量闸（problemAnalysis≥40 字）已随两轮思考 deepThink 门禁
     * 一并废除：第 1/2/3 步证据（problemAnalysis/approach/approachBasis/resources/
     * tools/preparation）改由开工闸 startPhases 承载（validateStartPhaseEvidence，
     * review 时随 consolidation 一并校验），同一判据不再两处重复。此处只校验
     * 分工表与整体等级，拒因顺序不变。
     */
    /*
     * [2.5.4][T4][3.1.0 治本] 复杂判定必须用「声明档」（钳制前），且优先消费平台
     * 持久化的钳制前声明记忆 taskReasoningEffortDeclared：
     * declared = taskReasoningEffortDeclared ?? taskReasoningEffort ?? taskEffortFallback。
     *
     * 原因（D1 + 3.1.0 实测缺陷）：correctEffortForModel 在非 qwen 系会把 medium
     * 钳到 low；review 通过后宿主把钳制后值写回 consolidation.taskReasoningEffort，
     * dispatch 读回时若只看该字段，complexTask 会被误判成 false → memberCap 从
     * 25 回落成 6 → review 放行的 8–25 人名单被静默截断（tests C1 用例实测复现：
     * 8 人名单派发只剩 6 人）。旧注释自称「分工表已是 review 放行的 ≥8 人名单，
     * 强制语义不破」——但截断恰恰发生在 dispatch 复读分工表时，注释与行为矛盾，
     * 3.1.0 起按声明记忆判定，两入口完全一致。
     *
     * TASK_EFFORT_INVALID 校验与其余各闸位置一律不动，既有拒因顺序完全保持。
     */
    const declaredEffort = consolidation.taskReasoningEffortDeclared ?? consolidation.taskReasoningEffort ?? input.taskEffortFallback;
    const complexTask = typeof declaredEffort === 'string' && COMPLEX_DECLARED_EFFORTS.includes(declaredEffort);
    /*
     * [2.5.5][T3] 用户裁决 D1/D2/D3：low（含未配置视同 low）任务禁止第三层下派。
     * 判定链＝钳制前声明记忆 → 声明档 → effortOverride → 任务行记录等级 → 皆缺视同 low。
     * 消费条件：仅合法五档值或缺失触发本闸；非法字符串穿透到下方
     * DELEGATE_TASK_EFFORT_INVALID 报错轨（裁决配套明示，拒因顺序不变）。
     * 与 complexTask 解耦：本闸只判「是否禁派」，人数/上限判据一行不动（S4）。
     * 钳制前判定（D1）：banDeclared 消费原始声明，不经 correctEffortForModel。
     */
    const banDeclared = consolidation.taskReasoningEffortDeclared ?? declaredEffort ?? input.taskRowEffort;
    const banConsumable = banDeclared === undefined || banDeclared === null
        || (typeof banDeclared === 'string' && REASONING_EFFORTS.includes(banDeclared));
    const banComplex = typeof banDeclared === 'string' && COMPLEX_DECLARED_EFFORTS.includes(banDeclared);
    if (banConsumable && !banComplex) {
        return {
            ...empty,
            code: 'DELEGATE_LOW_TASK_FORBIDDEN',
            error: '本任务为 low 档（或未配置，视同 low）：按用户裁决 D1–D5 禁止第三层下派，review/dispatch 一律硬拒，无任何例外通道。请部门负责人亲自执行：完成五步第 1/2/3 步（任务梳理 + 资源/工具/方案研究 + 准备）后经 dsh_workplan_delegate(action="direct") 登记 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }（' + START_EVIDENCE_MIN_CHARS_BRIEF + '；可选 reasoningEffort="low"；不接受分工表），平台将以 low 档接续（宿主另起执行会话并携带登记产物）由你亲自执行。已完成的历史派发不回溯。[3.2.0] 收尾纪律：有登记证据时 phases.planning / phases.preparation 可省略——平台自动并入并集落账（登记永不丢失），不要重抄；无登记时才须自带这两组。',
        };
    }
    const memberCap = complexTask ? MAX_COMPLEX_DELEGATE_MEMBERS : MAX_DELEGATE_MEMBERS;
    /*
     * [3.1.0] 不再静默截断：完整分工表进入校验链，超上限由下方 DELEGATE_HEADCOUNT_MAX
     * 闸明确拒收（可照做的精简/拆两轮指引）。旧实现在这里 slice(0, memberCap)，
     * 交 26 人只派前 25 人、丢 1 人无痕——用户裁决废止该行为。
     */
    const assignments = Array.isArray(consolidation.assignments) ? consolidation.assignments : [];
    if (assignments.length === 0) {
        return { ...empty, code: 'DELEGATE_CONSOLIDATION_INCOMPLETE', error: '梳理产物不完整：分工表 assignments 至少 1 条（member/role/task/reasoningEffort 四项齐全）。' };
    }
    const allowed = allowedEffortsForModel(input.model ?? null);
    /*
     * [2.5.0] 用户要求 2：负责人为整个任务配置的整体推理等级。
     * 非法值（不在五档存储全集内）走 A3 报错轨明确拒绝；越出当前模型家族
     * 合法集合走 A3 修正轨自动钳制并留痕——与下级档位同一判据，绝不中断派发。
     */
    /*
     * [2.5.0][R2×R4] 梳理产物未带整体等级时回落状态行已持久化的 effortOverride
     * （taskEffortFallback）：尝试重置会清掉 consolidation 但保留 effortOverride，
     * 重新 review/旧梳理回放时整体等级不得因此丢失（全程贯穿）。
     */
    const rawTaskEffort = consolidation.taskReasoningEffort !== undefined && consolidation.taskReasoningEffort !== null
        ? consolidation.taskReasoningEffort
        : input.taskEffortFallback;
    if (rawTaskEffort !== undefined && rawTaskEffort !== null
        && !(typeof rawTaskEffort === 'string' && REASONING_EFFORTS.includes(rawTaskEffort))) {
        return {
            ...empty,
            code: 'DELEGATE_TASK_EFFORT_INVALID',
            error: `taskReasoningEffort "${String(rawTaskEffort)}" 非法：必须是 low / medium / high / xhigh / max 之一（负责人为整个任务配置的整体推理等级；缺失=不覆盖）。`,
        };
    }
    let taskEffort = typeof rawTaskEffort === 'string' ? rawTaskEffort : null;
    let taskEffortClamped = null;
    if (taskEffort !== null && allowed !== null && !allowed.includes(taskEffort)) {
        const correction = correctEffortForModel(taskEffort, input.model ?? null);
        taskEffortClamped = { requested: taskEffort, corrected: correction.effort, reason: correction.reason ?? '' };
        taskEffort = correction.effort;
    }
    const members = [];
    const clamped = [];
    let experts = 0;
    for (let index = 0; index < assignments.length; index += 1) {
        const item = assignments[index] ?? {};
        const member = truncate(String(item.member ?? '').trim(), 80);
        /*
         * [3.0.0][用户要求 9] 只保留专家角色：role 必须写 expert（历史数据里的
         * member 归一为 expert，保证旧计划回放可继续派发）；缺 role 仍按
         * ASSIGNMENT_INVALID 拒绝，拒因语义不变。
         */
        const roleInput = String(item.role ?? '').trim().toLowerCase();
        const role = roleInput === 'expert' ? 'expert' : roleInput === 'member' ? 'expert' : '';
        const qualityRequirements = normalizeQualityRequirements(item.qualityRequirements);
        const task = truncate(String(item.task ?? '').trim(), 1500);
        if (!member || !role || !task) {
            return {
                ok: false,
                code: 'DELEGATE_ASSIGNMENT_INVALID',
                members: [],
                clamped: [],
                taskEffort: null,
                taskEffortClamped: null,
                error: `分工表第 ${index + 1} 条不完整：member（专家姓名/代号）、role（只能是 expert）、task（分到的任务）三者都必须非空。部门组员角色已取消，任务只派给本部门相关领域全球顶尖专家。`,
            };
        }
        /*
         * [2.5.0] 用户要求 2/3：下级未单独配置档位时，继承负责人为整个任务
         * 配置的整体等级（taskEffort）；负责人也没配置时回落 low——简单任务
         * 用低档，不再无条件取家族最高档（旧默认会让简单任务烧最高档）。
         * 显式配置的档位仍优先，越界钳制规则不变。
         */
        const requested = REASONING_EFFORTS.includes(item.reasoningEffort)
            ? String(item.reasoningEffort)
            : (taskEffort ?? 'low');
        const outOfSet = allowed !== null && !allowed.includes(requested);
        const correction = outOfSet ? correctEffortForModel(requested, input.model ?? null) : null;
        const effort = correction ? correction.effort : requested;
        if (correction) {
            clamped.push({ member, requested, corrected: correction.effort, reason: correction.reason ?? '' });
        }
        experts += 1;
        members.push({
            member,
            role,
            qualityRequirements,
            task,
            effort,
            ...(outOfSet ? { requested, correctionReason: correction?.reason } : {}),
            // [3.2.4][O1] 负责人预登记载荷原样透传（派发侧消毒消费；未携带即缺省）。
            ...(item.startPhases !== undefined ? { startPhases: item.startPhases } : {}),
            ...(item.timeNotice !== undefined ? { timeNotice: item.timeNotice } : {}),
        });
    }
    /*
     * [3.0.0][用户要求 9] 组员角色取消后，角色配比门禁只剩一条：至少 1 名专家。
     * 拒绝码随之改名（DELEGATE_ROLE_MIX_REQUIRED → DELEGATE_EXPERTS_REQUIRED），
     * 因为已不存在「配比」可言。
     */
    if (experts === 0) {
        return {
            ok: false,
            code: 'DELEGATE_EXPERTS_REQUIRED',
            members: [],
            clamped: [],
            taskEffort: null,
            taskEffortClamped: null,
            error: '分工表必须至少包含 1 名「本部门相关领域全球顶尖专家」：部门组员角色已取消（用户要求 9），任务只派给专家。',
        };
    }
    /*
     * [3.0.8] 两轮思考产物闸（approach≥40 字 / approachBasis≥20 字）已废除：第 1/2
     * 步证据经 review 的 startPhases 开工闸校验（与主 Agent/专家同一判据），不再在
     * 分工表闸重复。下方直接是复杂任务人数下限闸，拒因顺序不变。
     */
    /*
     * [3.2.3] 顺序推理链硬闸：父任务要求按固定顺序推理（先…再/逐步/基于上一步
     * 结论）时，禁止把彼此依赖的中间步骤分给多个独立上下文的专家。每位专家
     * 只拿到自己的任务书与上游摘要，读不到上一步的完整推理，强行并行会打断
     * 连续性并放大协调成本。合法出路：只派 1 名专家从头到尾一次做完（豁免
     * 复杂任务 ≥8 人下限——该下限为可并行拆分设计，链式任务不可并行拆），
     * 或——仅当任务为 low/未配置档——负责人亲自执行（direct）。
     * 位置在人数上下限闸之前：否则复杂链式任务会陷入「≥8 人被链闸拒、
     * 1 人被 MIN 闸拒」的无解死锁，反复重试纯烧 token。
     */
    let sequentialChain = false;
    let chainMarkers = [];
    if (typeof input.parentTaskText === 'string' && input.parentTaskText.trim()) {
        const chain = detectSequentialChainTask(input.parentTaskText);
        sequentialChain = chain.sequential;
        chainMarkers = chain.markers;
        if (chain.sequential && members.length > 1) {
            return {
                ...empty,
                code: 'DELEGATE_SEQUENTIAL_CHAIN_SPLIT',
                error: `本子任务是一条必须按顺序展开的推理链（命中：${chain.markers.join('、')}），不得拆给 ${members.length} 名独立专家：每名专家只有自己的上下文，看不到上一步完整推理，强行拆分会打断推理连续性。三条可照做的出路：1) 只派 1 名专家从头到尾一次做完（平台豁免复杂任务 ≥${MIN_COMPLEX_DELEGATE_MEMBERS} 人下限，把全部中间结论写进同一份产物）；2) 负责人亲自执行——action="direct" + reasoningEffort 自评复杂档（qwen: medium/xhigh；非 qwen: high/max，不得 low）+ startPhases 开工证据；3) 仅当任务为 low/未配置档时按 low 直执（direct，缺省 low）。跨子任务只传已落盘产物引用。`,
            };
        }
    }
    /*
     * [3.1.0] 分工表人数上限硬门禁（用户裁决：超限拒收，不留「丢人无痕」）：
     * 完整名单（经上方逐条校验合法后）超过本任务上限即整单拒绝，并给出两条
     * 可照做的出路（精简 / 拆两轮）。位置在 MIN 闸之前：26 人先收到「超上限」
     * 而非「少于 8 人」这类误导性拒因；7 人则自然落到下方 MIN 闸。
     */
    if (members.length > memberCap) {
        return {
            ok: false,
            code: 'DELEGATE_HEADCOUNT_MAX',
            members: [],
            clamped: [],
            taskEffort: null,
            taskEffortClamped: null,
            error: `分工表当前 ${members.length} 人，超过${complexTask ? '复杂任务' : '本任务'}上限 ${memberCap} 人（平台 3.1.0 起不再静默截断，不留「丢人无痕」）。两条可照做的出路：1) 精简名单——把可合并/最弱的几项砍掉或合并成一项，重新 review；2) 拆成两轮——第一轮先派最关键的 ≤${memberCap} 人，收齐后用 dsh_workplan_delegate(action="review"/"dispatch") 补派剩余部分。`,
        };
    }
    /*
     * [2.5.4][T4] 用户决策 D1/D2 人数下限硬门禁：
     * 复杂任务（声明档 medium/high/xhigh/max）expert+member 合计必须 ≥8 人，
     * 不足直接阻断分派。人数按完整分工表计（3.1.0 起无截断，上限闸已在上方）。
     * [3.2.3] 例外：顺序推理链任务豁免——链式任务只能 1 人连续执行，≥8 人
     * 下限是为「可并行拆分」设计的，对链式任务只会制造无解死锁。
     * [3.2.4][O8] 例外 2：单阶段计划（stages.length === 1）豁免同一死锁；
     * 下限本身可用 DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS 调整（默认 8）。
     */
    if (complexTask && !sequentialChain && !input.singleStagePlan && members.length < MIN_COMPLEX_DELEGATE_MEMBERS) {
        return {
            ok: false,
            code: 'DELEGATE_HEADCOUNT_MIN',
            members: [],
            clamped: [],
            taskEffort: null,
            taskEffortClamped: null,
            error: `复杂任务（声明档 ${String(declaredEffort)}）按用户决策 D1/D2 须合计 ≥${MIN_COMPLEX_DELEGATE_MEMBERS} 人（组员角色已取消，全部为专家），当前 ${members.length} 人；请把任务拆得更简单（单一目标/单一主产物/可独立验收，简单到 1+1=2）并扩充分工表后重新 review/dispatch。下限可用环境变量 DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS 调整（默认 8）；单阶段计划（只有 1 个 stage）自动豁免本下限。`,
        };
    }
    /*
     * [3.0.0][用户要求 5/6 + 用户裁决 A] 极简任务与质量要求硬门槛（新增的最后一道闸）。
     *
     * 每一条分派都必须简单到 1+1=2（单一目标、单句、无并列多目标），并且必须
     * 交代清楚成果的质量要求；不满足即拒绝派发并给出可照做的拆小指令
     * （用户裁决 A：硬门槛，不软放）。
     *
     * 位置：既有 8 道拒因之后、放行之前——2.5.4 的拒因顺序与语义一字不变，
     * 新闸只在旧门禁全部通过时才生效，历史用例不会因新闸改变原有诊断。
     */
    for (let index = 0; index < members.length; index += 1) {
        const item = members[index];
        const atomic = checkAtomicAssignment(item.task, item.qualityRequirements);
        if (!atomic.ok) {
            return {
                ok: false,
                code: atomic.code ?? 'DELEGATE_TASK_NOT_ATOMIC',
                members: [],
                clamped: [],
                taskEffort: null,
                taskEffortClamped: null,
                error: `分工表第 ${index + 1} 条（${item.member}）不合格：${atomic.error}${atomic.hint ? ` 拆小要求：${atomic.hint}` : ''}`,
            };
        }
    }
    /*
     * [3.2.3] 顺序推理链硬闸已在人数闸之前执行（见上方 sequentialChain），
     * 这里不再重复判定，避免同一拒因两处漂移。
     */
    return {
        ok: true,
        members,
        clamped,
        taskEffort,
        taskEffortClamped,
        // [2.5.5][T3] 钳制前原始声明随 ok 返回，供平台持久化为 taskReasoningEffortDeclared。
        taskEffortDeclared: typeof rawTaskEffort === 'string' ? rawTaskEffort : null,
        consolidation: {
            assignments: members.length,
            taskReasoningEffort: taskEffort,
        },
    };
}
/**
 * [2.5.0] 用户要求 2 的执行侧单一判据：子任务每次激活（首发/重试/续跑）
 * 读取推理等级的唯一入口。负责人配置的整体等级（状态行 effortOverride）
 * 优先于规划器写死的 subtask.reasoningEffort；两者都缺失/非法时回落
 * DEFAULT_REASONING_EFFORT。纯函数，派发链与测试同口径消费——「全程应用」
 * 不可能在某一环悄悄回落。
 */
export function resolveTaskEffort(input) {
    if (typeof input.override === 'string' && REASONING_EFFORTS.includes(input.override))
        return input.override;
    if (typeof input.planned === 'string' && REASONING_EFFORTS.includes(input.planned))
        return input.planned;
    return DEFAULT_REASONING_EFFORT;
}
/**
 * [2.3.9][T4b] 第三层任务书：部门负责人 → 全球顶尖专家子会话。
 *
 * 与二级任务书（buildChildPrompt）共享同一注入事实源 buildLlmRulesBrief
 * （tier='delegate'），要求 1/2 全文与「等级全程应用、越界钳制留痕」的
 * 口径不可能在两处漂移；叶子层禁令（不得再派生第四层）直接写进任务书，
 * 服务端 delegateTool 另有一道硬拒——提示词说服模型，代码守住边界。
 */
export function buildDelegateePrompt(input) {
    const roleLabel = '本部门相关领域全球顶尖专家';
    const qualityBlock = renderQualityRequirementsBlock(input.member.qualityRequirements ?? [], '部门负责人');
    /*
     * [3.2.4][省钱 3.0] 静态优先（static-first）重排：让同部门多名专家共享同一段
     * 前缀，从而命中供应商的提示词缓存。
     *
     * 缺陷现场（2026-11-23 T4/T5 实测）：每名专家的任务书**第一行就写着成员名**，
     * 第二、三行写着各自的任务文本——8 名专家的提示词从第 1 个字就分叉，缓存
     * 前缀长度为 0，等于每人每次都要把同一份五步协议、执行要求、汇报规范按全价
     * 重新买一遍。而实测 95% 的会话 token 花在"同一段内容被重复读"上，缓存命中
     * 是唯一不牺牲质量的省钱手段。
     *
     * 现在的顺序：静态头部（部门名）→ 五步协议 → 执行要求 → 汇报规范 → 动态尾部
     * （成员名/负责人任务/你的任务/工作目录/质量要求/重试简报/规则摘要）。
     * 内容一字未删，只是换了位置；`五步工作法` 仍在 `执行要求：` 之前（守门测试
     * three-phase.test.ts:135 钉住）。
     */
    return defuseSessionReferenceText([
        `你是「${input.departmentLabel ?? '部门'}」的${roleLabel}，由部门负责人直接分配，只负责本任务书末尾【你的分工】里那一项工作。`,
        ...(input.continuation ? fiveStepContinuationPromptLines() : fiveStepPromptLines()),
        '',
        '执行要求（用户强制要求 5 原文口径）：',
        /*
         * [3.1.7][P3 U-27] 首条不再逐字重发五步前三步全文。
         *
         * 旧实现这条把「第一步…第二步…第三步…」整段写一遍，而本任务书末尾的
         * fiveStepPromptLines() 已经逐字包含同一份协议（T4 A04：开头段与执行
         * 要求首条重复 58+ 字符）。现在首条只留义务声明 + 指针 + 第四步纪律
         * （少走弯路），关键串「先全面、全盘、深入梳理、研究、思考自己的任务」
         * 「基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案」
         * 「方法、流程、步骤」「approachBasis」「startPhases」全部保活——它们
         * 在下方五步协议里逐字存在，守门测试（workplan-251-deep-think）不变。
         */
        // [3.2.3][省钱 R3] 前三步细则与 approachBasis/key phrases 已在下方
        // fiveStepContinuationPromptLines() 逐字给出，这里只留义务声明，不再复述一遍。
        '- 执行自己的任务：五步前三步已在 phase-0 经 self_effort 提交 startPhases 并登记，不要重做、不要重复登记，直接从第四步执行；登记范围之外的缺口先补齐（只做核对与增量，不推倒重来）。补给时基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案（方法、流程、步骤，含 approachBasis），只做核对与增量，不复述全文。第四步严格按第二步理清的方法、流程、步骤执行，全程少走弯路。',
        '- 推理等级以 self_effort 自配为权威（分工表档仅建议）：全程按登记档执行，不得换档。',
        '- 开工前必须先预估本人任务耗时（整数分钟）并经 self_effort 的 timeNotice={ declaredMinutes: 正整数分钟, reason? } 上报部门负责人，未上报不接续（ESTIMATE_MISSING/ESTIMATE_INVALID 硬拒）；该上报只是协调信息。你和部门负责人执行任务均没有总时长、单次时长、空闲或回执硬截止；预估或实际耗时不会触发延期、超时接手，也不影响 done 验收。',
        '- 在确保品质，高效执行，不浪费 token。',
        '- 你是第三层叶子执行者：不得派生任何第四层 Agent/子会话；无法完成时在结论首行写 BLOCKED: 原因 并说明缺什么，不要空转。',
        '- 共享可变状态纪律（3.2.3）：只写本任务 outputs 声明的产物与自己那份 reports/wp-member-*.json；不要并发写其他任务声明的产物或公共配置。必须改动共享文件时先回报负责人，由平台按依赖串行派发，不要多方同时写同一文件。',
        '- 遇阻上报通道（3.0.5 四步闭环）：遇阻（缺权限/缺输入/依赖产物缺失/需求自相矛盾/无法验证/需要负责人决定方向）时，第一动作是调用 dsh_workplan_escalate({ "question": "需要负责人回答的单个问题", "options": ["可选方向"], "needs": ["需要谁提供什么"] })。流程必须严格为：你先向部门负责人报告具体问题→负责人全面梳理你的问题与本部门全部已派发任务执行状态→负责人研究形成解决方案→负责人用 dsh_workplan_instruct 把方案告诉你→你继续执行原任务。平台禁止负责人在你待指示期间把你改派给其他专家；你必须是继续执行的人。调用 escalate 成功后停止推进、只做只读核对，不要自行选定一个选项继续。',
        '- 完成后用 ≤200 字、≤3 句中文回报部门负责人（结论 / 产物路径 / 遗留项）；同时把同一份结构化结论写入 reports/wp-member-<你的成员名>-<任务代号>.json（相对工作目录，目录不存在就创建）作为结算兜底。',
        /*
         * [3.2.4][治本 H4] 工具参数 JSON 写坏的兜底路径。
         *
         * 缺陷现场（2026-11-23 会话 93fc515d，writing:T5→行为探针专家）：模型生成的
         * dsh_workplan_verify 参数在第 3293 个字符处结束——根对象少一个右花括号。
         * 宿主解析失败 ⇒ 该工具调用作废 ⇒ 整轮以 error 结束，已完成的工作没有结算。
         * 宿主侧的解析器不能由插件改，但专家侧有两条可执行的止损：
         *  ① 参数写小（只写必要字段），花括号层级越少越不容易漏；
         *  ② 被拒后不要重试同一形状，直接在正文交结果块——结算读的是正文里的证据块，
         *     verify 只是自检通道，不是唯一通道。
         */
        /*
     * [3.2.4][步数预算] 步数软预算的透明告知（措辞必须与实现一致，否则就是误导）。
     *
     * 实现事实：预算是**结算时口径**——会话结束后才数步数，写台账/日志，
     * 全程不向运行中的专家发任何"你到 60 步了"的催促消息，也不中断、不改判。
     * 因此这里**不能**写"触及提醒后请立即收尾"（那会暗示一个不存在的信号，
     * 反而可能让专家提前收工、削减证据）。这条只做两件事：说清成本事实
     * （每多一步整段对话重读一遍），并明确禁止用步数压质量。
     */
        '- 步数预算（只记账，不是时限）：平台在你的会话结束后才统计步数，用于台账与成本复盘（可用 DSH_WORKPLAN_STEP_BUDGET 调整或设 0 关闭）。**执行过程中不会有任何到点催促、不会中断你、不会因步数判你失败**。之所以告诉你这件事：每多一步，整段对话都会被重读一遍（实测 95% 的 token 花在重读上），所以请避免无意义的重复探索与反复试错；但**绝不能为省步数而削减证据、跳过验证或提前交卷**——验收门禁（五步证据、逐条验收、复盘）一条都不会因步数放宽，交得薄只会被退回重做，反而更贵。',
        '- 工具参数纪律：dsh_workplan_verify 参数只写必要字段（execution/verification 两组，每条 ≤200 字、每数组 ≤20 条），不要拼接长字符串、不要手写超过四层的嵌套。若某次工具调用被宿主以「参数 JSON 非法」（报错含 JSON at position）拒绝，不要原样重试同一形状：直接在最终正文里给出结果块交卷，平台按结果块结算，不会因此判失败。',
        `- 结果块契约：以 ${EVIDENCE_MARKER_BEGIN} 开头、${EVIDENCE_MARKER_END} 结尾，内含合法 JSON（status ∈ done/blocked/partial、phases 证据、acceptance 逐条带证据）。有 phase-0 登记时 phases.planning / phases.preparation 可省略（平台自动并入），execution / verification 与顶层字段必交；无登记时四组齐全。`,
        '',
        renderExpertReportSpec(),
        '',
        '【你的分工】（本任务书中唯一因专家而异的部分）：',
        `- 成员：${input.member.member}`,
        `- 负责人任务：${input.leaderSubtaskId ?? ''} ${input.leaderSubtaskTitle ?? ''}`,
        `- 你的任务：${input.member.task}`,
        `- 工作目录：${input.cwd || '（未知）'}`,
        /*
         * [3.2.4][治本 H2] 唯一产物根：与部门任务书同一条硬约定，避免同一子任务的
         * 多名专家把产物写到不同子目录（2026-11-23 T4 现场：reports/ 与
         * plugins/dsh-workplan/reports/ 各有一半）。
         */
        `- 产物根目录（唯一，强制）：${input.cwd ? `${input.cwd}/reports/` : '（工作目录）/reports/'}——所有产物一律写在这里（相对工作目录写作 reports/<任务代号>/<文件名>），不要写进任何子仓库（例如 plugins/…）。回报里的产物路径必须相对它写。`,
        ...(qualityBlock ? ['', qualityBlock] : []),
        ...(input.extraContext ? ['', input.extraContext] : []),
        ...(input.rulesBrief ? ['', input.rulesBrief] : []),
    ].filter(Boolean).join('\n'));
}
/**
 * [2.5.0][自配档] phase-0 任务书（叶子）：唯一职责=评估复杂度+提交 self_effort。
 * extraContext 可携带重试简报（重派仍未自配时不丢已完成部分）。
 */
export function buildPhaseZeroDelegateePrompt(input) {
    const roleLabel = '本部门相关领域全球顶尖专家';
    const qualityBlock = renderQualityRequirementsBlock(input.member.qualityRequirements ?? [], '部门负责人');
    /*
     * [3.2.4][省钱 3.0] 同样静态优先：把与「谁」无关的协议段放前面，成员名与
     * 任务放最后一行区块——同一部门 8 名专家的 phase-0 任务书因此共享同一前缀，
     * 供应商缓存可以命中；内容一字未删。
     */
    return [
        `你是「${input.departmentLabel ?? '部门'}」${roleLabel}（成员名见本节末尾），phase-0（先配置后开工，low 档启动）。`,
        '本阶段唯一职责：评估复杂度并完成五步前三步，再调 dsh_workplan_delegate(action="self_effort") 一次提交：member（成员名，必填）+ reasoningEffort（推理等级：轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max）+ 复杂度依据（complexityReason 枚举三选一：facts=任务事实多且杂、dependencies=跨模块/跨系统依赖、verification-difficulty=验证难度高；或 prose complexityRationale，二选一）+ startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } } + timeNotice={ declaredMinutes: 正整数分钟, reason? }。未交/不合格预估硬拒（ESTIMATE_MISSING/ESTIMATE_INVALID）：未告知部门负责人预估时间，先拦截，再告知此人；你必须自己预估时间，汇报给对应负责人后，才可以重试或继续执行。',
        'startPhases 口径（同一判据）：problemAnalysis=任务梳理（目标/验收/现状/约束/未知/主要矛盾/边界，≥40字）；resources=所需资源（数据/文件/权限/人/知识/时间，≥20字）；tools=所需工具及用途（≥10字）；approach=基于第一步结果的可执行方法、流程和步骤（≥40字，含少走弯路：先查历史教训、先验证再动手、不重复试错）；approachBasis=第二步基于第一步的依据对应（≥20字）；prepared=已备资源/工具（≥20字）；evidence=逐项就绪证据（命令/文件/配置/版本/引用，≥20字）。',
        '不要执行任务本身，不得派生任何第四层 Agent/子会话。缺交/不合格 startPhases 硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），不接续。提交后结束本回合；平台立即以你的自配档接续（另起执行会话）进入 phase-1，严格按第二步方法、流程、步骤执行。',
        '',
        '【你的分工】（本任务书中唯一因专家而异的部分）：',
        `- 成员：${input.member.member}`,
        `- 你分到的任务：${input.member.task}`,
        `- 工作目录：${input.cwd || '（未知）'}`,
        `- 产物根目录（唯一，强制）：${input.cwd ? `${input.cwd}/reports/` : '（工作目录）/reports/'}——正式执行的产物一律写在这里，不要写进任何子仓库（例如 plugins/…）。`,
        ...(qualityBlock ? ['', qualityBlock] : []),
        ...(input.extraContext ? ['', input.extraContext] : []),
    ].join('\n');
}
