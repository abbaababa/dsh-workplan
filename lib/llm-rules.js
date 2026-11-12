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
import { allowedEffortsForModel, classifyModelFamily, DEFAULT_REASONING_EFFORT, defuseSessionReferenceText, effortForComplexity, EVIDENCE_MARKER_BEGIN, EVIDENCE_MARKER_END, effortsForModelFamily, highestEffortOf, OTHER_MODEL_EFFORTS, QWEN_MODEL_EFFORTS, REASONING_EFFORTS, truncate, } from './plan.js';
// [2.5.4][T3R1] 负责人分派前深度梳理门禁与主 Agent/叶子同一字数判据：
// 复用 three-phase 的 40/40/20 下限常量（three-phase 只依赖 lessons，无循环）。
import { MIN_PLANNING_APPROACH_CHARS, MIN_PLANNING_BASIS_CHARS, MIN_PLANNING_PROBLEM_CHARS, threePhasePromptLines, } from './three-phase.js';
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
/** 静态强度序（与 runtime.ts EFFORT_STRENGTH_ORDER 同源语义）。 */
const STATIC_STRENGTH_ORDER = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
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
        '[2.3.9][LLM 推理等级强制规则——用户要求 1/2 全文（部门、专家、组员全员告知，必须遵守）]',
        LLM_REASONING_RULES_TEXT,
        `- 本会话模型：${info.model || '（未知，不施加静态等级约束）'}`
            + (info.model ? `（家族：${family === 'qwen' ? 'qwen 系' : '非 qwen 系'}）` : '')
            + (allowed ? `；可用推理等级集合：{${allowed.join(', ')}}` : ''),
    ];
    if (info.effort) {
        const adjusted = Boolean(info.requested) && info.requested !== info.effort;
        lines.push(`- 本任务的推理等级已按任务复杂度配置为 \`${info.effort}\`，必须全程应用（开工预告、执行、验证、复盘全生命周期生效）`
            + (adjusted
                ? `；请求档 \`${info.requested}\` 越出当前模型家族等级集合，已按规则自动钳制修正${info.correctionReason ? `（${info.correctionReason}）` : ''}。`
                : '。'));
    }
    if (info.taskEffort) {
        lines.push(`- 部门负责人已为本任务配置整体推理等级 \`${info.taskEffort}\`（effortOverride，负责人自配档）：本任务每次派发/重试/续跑全程沿用该等级，不得中途丢弃或覆盖；下级自己的等级以 self_effort 自配为权威（分工表档仅建议）。`);
    }
    if (info.tier === 'delegate') {
        lines.push(`- 你是部门第三层执行者（${info.memberRole === 'expert' ? '本部门相关领域全球顶尖专家' : '本部门组员'}${info.memberName ? `：${info.memberName}` : ''}）。执行自己的任务必须先走两轮深度思考（2.5.1 强制，详见三阶段工作法）：先全面、全盘、深入梳理、研究、思考自己的任务；再基于刚才前一步完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考，理清自己的思路，理清自己该具体如何一步步执行、达到最终完美完成自己任务的方法、流程和步骤；最后，基于刚才理清楚的所有方法、流程、步骤，开始具体的执行工作，全程少走弯路（先查历史教训、先验证再动手、不重复试错）。分工表给你的档位仅为建议：你必须在 phase-0（low 档启动）经 dsh_workplan_delegate(action="self_effort") 按自己任务复杂度提交自配档（reasoningEffort+complexityRationale），平台登记后立即以自配档接续你执行正式任务；越界档会被钳制并留痕。必须确保自身任务完成品质非常高的前提下，完美、超高效率地执行。`);
    }
    else {
        // [2.5.4][T4] 人数口径同步（D1/D2）：非复杂≤6；复杂（medium/high/xhigh/max）≥8 且 ≤12，少于 8 硬性阻断。
        lines.push('- 部门负责人（本任务书的直接接收者）强制流程（用户要求 1/2/3，2.5.0 强化；2.5.1 两轮深度思考协议）：你拥有本部门内的再分配权限——执行自己的任务必须先走两轮深度思考：第一轮，先全面、全盘、深入梳理、研究、思考自己的任务；第二轮，基于刚才第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考，理清自己的思路，理清自己该具体如何一步步以最高效率执行、确保完美完成自己任务的方法、流程和步骤（含全程如何少走弯路：先查历史教训、先验证再动手、不重复试错）；最后，基于第二轮理清楚的所有方法、流程、步骤，开始具体的执行与再分配。两轮思考产物经 dsh_workplan_delegate(action="review") 提交（problemAnalysis=第一轮任务深研 + approach=第二轮方法流程步骤 + approachBasis=第二轮基于第一轮全部结果的依据对应 + 分工表 + 每位专家/组员的推理等级配置），并在 consolidation.taskReasoningEffort 里按你接到任务的复杂度配置你自己的整体推理等级（先配置后开工：phase-0 以 low 启动，登记后平台立即以自配档接续本会话进入 phase-1，重试/续跑全程生效）；梳理产物未提交前，dsh_workplan_delegate(action="dispatch") 会被平台拒绝（硬门禁）。梳理完成后必须把任务拆得更简单——每位下级只承担单一目标、单一主产物、可独立验收的一项工作——再合理分配给本部门多名相关领域全球顶尖专家与本部门组员（expert 与 member 各至少 1 名；非复杂任务（low/未配置）最多 6 人；复杂任务（medium/high/xhigh/max）合计不少于 8 人且最多 12 人，少于 8 人硬性阻断）；每位下级必须在 phase-0 经 dsh_workplan_delegate(action="self_effort") 按自己分到的单项任务复杂度自配推理等级（轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max），成员自配为权威（分工表 per-member 档仅建议），平台登记后以自配档接续下级会话，全程应用；平台会按上述等级集合自动钳制越界档并留痕，等级在其任务全生命周期生效且不可被覆盖。第三层为叶子层：任何第四层派发一律被拒绝。');
    }
    return lines.join('\n');
}
const MAX_DELEGATE_MEMBERS = 6;
/**
 * [2.5.4][T4] 用户决策 D1/D2：复杂任务（声明档 medium/high/xhigh/max）分派
 * 人数下限 8（expert+member 合计，少于 8 硬性阻断）；上限放宽到 12
 * （12 为实现取值，D2 授权提高上限）。非复杂（low/未配置）保持 6 人上限
 * 与原有静默截断，旧行为零变化。
 */
const MIN_COMPLEX_DELEGATE_MEMBERS = 8;
const MAX_COMPLEX_DELEGATE_MEMBERS = 12;
/** [2.5.4][T4] D1：除 low 外全部算复杂——medium/high/xhigh/max 均触发 ≥8 人门禁，xhigh 不豁免。 */
const COMPLEX_DECLARED_EFFORTS = Object.freeze(['medium', 'high', 'xhigh', 'max']);
function readTrimmedStrings(value, limit) {
    return (Array.isArray(value) ? value : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
        .slice(0, limit);
}
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
        return { ...empty, error: '尚未提交「全面梳理」产物：先用 dsh_workplan_delegate(action="review") 提交问题梳理与分工表，派发才会放行（用户要求 4 的硬门禁）。' };
    }
    const problemAnalysis = readTrimmedStrings(consolidation.problemAnalysis, 12);
    if (problemAnalysis.length === 0) {
        return { ...empty, code: 'DELEGATE_CONSOLIDATION_INCOMPLETE', error: '梳理产物不完整：problemAnalysis 至少 1 条（现状/事实/约束/未知/主要矛盾逐条写清），未梳理完不得进入再分配。' };
    }
    /*
     * [2.5.4][T3R1] 分派前深度梳理质量闸（用户要求 1 的代码级保障）：旧实现只查
     * 「有没有交」（length>0），一句话就能冒充全面梳理；主 Agent（three-phase
     * validateMainDeepThink）与叶子（self_effort）早有 40/40/20 字下限，负责人层
     * 缺失。此处补齐同一判据：合计字数=各项长度之和（与 three-phase totalChars
     * 同语义），不合格硬拒，合格才放行 dispatch。
     */
    const problemChars = problemAnalysis.reduce((sum, item) => sum + item.length, 0);
    if (problemChars < MIN_PLANNING_PROBLEM_CHARS) {
        return { ...empty, code: 'DELEGATE_CONSOLIDATION_INCOMPLETE', error: `梳理产物太薄：problemAnalysis 合计 ${problemChars} 字，至少 ${MIN_PLANNING_PROBLEM_CHARS} 字——第一轮必须全面、全盘、深入梳理、研究、思考自己的任务，逐条写清目标与验收、现状、约束、未知、主要矛盾与边界；一句话不能冒充深度梳理。` };
    }
    /*
     * [2.5.4][T4] 复杂判定必须用「声明档」（钳制前）：
     * declared = consolidation.taskReasoningEffort ?? input.taskEffortFallback。
     * 原因（D1）：correctEffortForModel 在非 qwen 系会把 medium 钳到 low，
     * 若按钳制后档位判复杂会静默豁免 medium，违反「medium/high/xhigh/max 均触发」。
     * 这里只提前「原始声明档读取 + 复杂判定 + 上限选择」这一纯读取逻辑，
     * TASK_EFFORT_INVALID 校验与其余各闸位置一律不动，既有拒因顺序完全保持。
     * 持久化边界（负责人补充说明 2）：review 通过后宿主把钳制后值写回
     * row.consolidation.taskReasoningEffort 与 effortOverride，dispatch 读回的是
     * 钳制后声明——因此强制点在 review 入口（dispatch 必须先有合格 review，每个
     * 复杂声明都必然在 review 处按原始声明被 ≥8 校验）；dispatch 复读为纵深复核，
     * 非 qwen+medium 的极端组合复读时虽看到钳制后的 low，但分工表已是 review 放行
     * 的 ≥8 人名单，强制语义不破。qwen 系钳制不改变复杂性分类，两入口完全一致。
     */
    const declaredEffort = consolidation.taskReasoningEffort ?? input.taskEffortFallback;
    const complexTask = typeof declaredEffort === 'string' && COMPLEX_DECLARED_EFFORTS.includes(declaredEffort);
    const memberCap = complexTask ? MAX_COMPLEX_DELEGATE_MEMBERS : MAX_DELEGATE_MEMBERS;
    const assignments = (Array.isArray(consolidation.assignments) ? consolidation.assignments : []).slice(0, memberCap);
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
    let regular = 0;
    for (let index = 0; index < assignments.length; index += 1) {
        const item = assignments[index] ?? {};
        const member = truncate(String(item.member ?? '').trim(), 80);
        const role = item.role === 'expert' ? 'expert' : item.role === 'member' ? 'member' : '';
        const task = truncate(String(item.task ?? '').trim(), 1500);
        if (!member || !role || !task) {
            return {
                ok: false,
                code: 'DELEGATE_ASSIGNMENT_INVALID',
                members: [],
                clamped: [],
                taskEffort: null,
                taskEffortClamped: null,
                error: `分工表第 ${index + 1} 条不完整：member（姓名/代号）、role（expert|member）、task（分到的任务）三者都必须非空。`,
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
        if (role === 'expert')
            experts += 1;
        else
            regular += 1;
        members.push({
            member,
            role,
            task,
            effort,
            ...(outOfSet ? { requested, correctionReason: correction?.reason } : {}),
        });
    }
    if (experts === 0 || regular === 0) {
        return {
            ok: false,
            code: 'DELEGATE_ROLE_MIX_REQUIRED',
            members: [],
            clamped: [],
            taskEffort: null,
            taskEffortClamped: null,
            error: '分工表必须同时覆盖「本部门相关领域全球顶尖专家」与「本部门组员」（各至少 1 名，用户要求 4）：当前 expert=' + experts + '、member=' + regular + '。',
        };
    }
    /*
     * [2.5.1] 两轮深度思考协议（用户 2026-11-11 强制要求）：负责人执行自己的
     * 任务必须先完成两轮深度思考，才允许进入执行与再分配——
     *   第一轮（problemAnalysis，上方已校验）：全面、全盘、深入梳理、研究、
     *   思考自己的任务；
     *   第二轮（approach）：基于第一轮完成好的所有结果，再全面、全盘、深入地
     *   开展梳理、研究和思考，理清具体一步步执行、完美完成任务的方法、流程、
     *   步骤；approachBasis 写清第二轮如何基于第一轮全部结果（依赖可审计）。
     * 放在角色配比校验之后：缺 problemAnalysis/assignments/角色配比的旧拒因
     * 顺序不变，两轮产物门禁是新增的最后一道闸。
     */
    const approach = readTrimmedStrings(consolidation.approach, 12);
    if (approach.length === 0) {
        return {
            ...empty,
            code: 'DELEGATE_CONSOLIDATION_INCOMPLETE',
            error: '两轮深度思考未完成：approach 至少 1 条——第二轮必须基于第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考，理清自己该具体如何一步步执行、达到最终完美完成自己任务的方法、流程和步骤；未理清前不得进入执行与再分配。',
        };
    }
    // [2.5.4][T3R1] 第二轮方法流程步骤质量闸：与主 Agent/叶子同一 40 字下限。
    const approachChars = approach.reduce((sum, item) => sum + item.length, 0);
    if (approachChars < MIN_PLANNING_APPROACH_CHARS) {
        return {
            ...empty,
            code: 'DELEGATE_CONSOLIDATION_INCOMPLETE',
            error: `梳理产物太薄：approach 合计 ${approachChars} 字，至少 ${MIN_PLANNING_APPROACH_CHARS} 字——第二轮要基于第一轮全部结果理清具体一步步执行、完美完成任务的方法、流程和步骤，而不是一句目标。`,
        };
    }
    const approachBasis = readTrimmedStrings(consolidation.approachBasis, 12);
    if (approachBasis.length === 0) {
        return {
            ...empty,
            code: 'DELEGATE_CONSOLIDATION_INCOMPLETE',
            error: '两轮深度思考未完成：approachBasis 至少 1 条——第二轮的方法、流程、步骤必须基于第一轮完成好的所有结果，逐条写清第一轮的哪些事实/约束/矛盾决定了第二轮的哪些方法/流程/步骤（依赖依据，不可省略）。',
        };
    }
    // [2.5.4][T3R1] 第二轮依据质量闸：与主 Agent/叶子同一 20 字下限。
    const basisChars = approachBasis.reduce((sum, item) => sum + item.length, 0);
    if (basisChars < MIN_PLANNING_BASIS_CHARS) {
        return {
            ...empty,
            code: 'DELEGATE_CONSOLIDATION_INCOMPLETE',
            error: `梳理产物太薄：approachBasis 合计 ${basisChars} 字，至少 ${MIN_PLANNING_BASIS_CHARS} 字——要写清第二轮的方法、流程、步骤如何基于第一轮梳理、研究、思考完成好的所有结果（拆解理由与依赖对应，不可省略）。`,
        };
    }
    /*
     * [2.5.4][T4] 用户决策 D1/D2 人数下限硬门禁（新增的最后一道闸）：
     * 复杂任务（声明档 medium/high/xhigh/max）expert+member 合计必须 ≥8 人，
     * 不足直接阻断分派。人数按截断后实际分派数计（复杂上限 12≥8，截断前后
     * 判定等价）；角色配比校验（ROLE_MIX_REQUIRED）在本闸之前，保持不变。
     * 放在拒因链最后：既有 8 道拒因顺序完全不变。
     */
    if (complexTask && assignments.length < MIN_COMPLEX_DELEGATE_MEMBERS) {
        return {
            ok: false,
            code: 'DELEGATE_HEADCOUNT_MIN',
            members: [],
            clamped: [],
            taskEffort: null,
            taskEffortClamped: null,
            error: `复杂任务（声明档 ${String(declaredEffort)}）按用户决策 D1/D2 须 expert+member 合计 ≥8 人，当前 ${assignments.length} 人；请把任务拆得更简单（单一目标/单一主产物/可独立验收）并扩充分工表后重新 review/dispatch。`,
        };
    }
    return {
        ok: true,
        members,
        clamped,
        taskEffort,
        taskEffortClamped,
        consolidation: {
            problemAnalysis,
            constraints: readTrimmedStrings(consolidation.constraints, 12),
            unknowns: readTrimmedStrings(consolidation.unknowns, 12),
            approach,
            approachBasis,
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
 * [2.3.9][T4b] 第三层任务书：部门负责人 → 顶尖专家/组员子会话。
 *
 * 与二级任务书（buildChildPrompt）共享同一注入事实源 buildLlmRulesBrief
 * （tier='delegate'），要求 1/2 全文与「等级全程应用、越界钳制留痕」的
 * 口径不可能在两处漂移；叶子层禁令（不得再派生第四层）直接写进任务书，
 * 服务端 delegateTool 另有一道硬拒——提示词说服模型，代码守住边界。
 */
export function buildDelegateePrompt(input) {
    const roleLabel = input.member.role === 'expert' ? '本部门相关领域全球顶尖专家' : '本部门组员';
    return defuseSessionReferenceText([
        `你是「${input.departmentLabel ?? '部门'}」的${roleLabel}（${input.member.member}），由部门负责人直接分配，只负责下面这一项分配到的工作。`,
        `负责人任务：${input.leaderSubtaskId ?? ''} ${input.leaderSubtaskTitle ?? ''}`,
        `你的任务：${input.member.task}`,
        `工作目录：${input.cwd || '（未知）'}`,
        ...(input.extraContext ? ['', input.extraContext] : []),
        '',
        input.rulesBrief,
        '',
        '执行要求（用户强制要求 5 原文口径）：',
        '- 执行自己的任务必须先完成下方「三阶段工作法」的两轮深度思考（2.5.1 强制；2.5.2 执行前硬门禁）：第一轮全面、全盘、深入梳理、研究、思考自己的任务；第二轮基于第一轮完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，理清具体一步步以最高效率、少走弯路、完美完成任务的方法、流程和步骤（含依据 approachBasis）；两轮产物经 phase-0 的 self_effort 一并提交 deepThink，未登记合格产物平台不会接续你进入正式执行；执行必须严格基于第二轮的方法、流程、步骤，全程少走弯路（先查历史教训、先验证再动手、不重复试错）。',
        '- 你的推理等级以自配为权威（分工表档仅建议）：phase-0（low 档启动）唯一职责是经 dsh_workplan_delegate(action="self_effort") 提交自配档；phase-1 以登记生效的自配档全程应用（规划、执行、验证、复盘全生命周期），不得自行换档。',
        '- 必须在确保自身任务完成品质非常高的前提下，完美、超高效率地执行；严禁低效执行与浪费 token。',
        '- 你是第三层叶子执行者：不得派生任何第四层 Agent/子会话；无法完成时在结论首行写 BLOCKED: 原因 并说明缺什么，不要空转。',
        '- 遇阻上报通道：遇阻（缺权限/缺输入/依赖产物缺失/需求自相矛盾/无法验证/需要负责人决定方向）时，第一动作是调用 dsh_workplan_escalate({ "question": "需要负责人回答的单个问题", "options": ["可选方向"], "needs": ["需要谁提供什么"] })——请示会经 delegate 登记落到你所属部门行的第三层台账（待指示），由部门负责人用 dsh_workplan_instruct 答复你；调用成功后停止推进、只做只读核对，不要自行选定一个选项继续。',
        '- 完成后把结论与逐项证据（命令输出/文件/引用）用简洁中文回报给部门负责人会话；同时把同一份结构化结论写入 reports/wp-member-<你的成员名>-<任务代号>.json（相对工作目录，目录不存在就创建）作为结算兜底。',
        `- 结果块契约：以 ${EVIDENCE_MARKER_BEGIN} 开头、${EVIDENCE_MARKER_END} 结尾，内含合法 JSON（status ∈ done/blocked/partial、phases 三阶段、acceptance 逐条带证据）。`,
        '',
        ...threePhasePromptLines(),
    ].filter(Boolean).join('\n'));
}
/**
 * [2.5.0][自配档] phase-0 任务书（叶子）：唯一职责=评估复杂度+提交 self_effort。
 * extraContext 可携带重试简报（重派仍未自配时不丢已完成部分）。
 */
export function buildPhaseZeroDelegateePrompt(input) {
    const roleLabel = input.member.role === 'expert' ? '本部门相关领域全球顶尖专家' : '本部门组员';
    return [
        `你是「${input.departmentLabel ?? '部门'}」的${roleLabel}（${input.member.member}），当前处于 phase-0（先配置后开工，low 档启动）。`,
        `你分到的任务：${input.member.task}`,
        `工作目录：${input.cwd || '（未知）'}`,
        ...(input.extraContext ? ['', input.extraContext] : []),
        '本阶段唯一职责（先配置+先思考，后开工）：评估你分到的单项任务的复杂度，并完成执行前两轮深度思考，然后调用 dsh_workplan_delegate(action="self_effort") 一次性提交：reasoningEffort（你的自配推理等级：轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max）+ complexityRationale（复杂度依据，必填）+ deepThink={ problemAnalysis[], approach[], approachBasis[] }（两轮思考产物，必填）。',
        'deepThink 两轮口径（与主 Agent/负责人同一判据）：第一轮 problemAnalysis=先全面、全盘、深入梳理、研究、思考自己分到的任务（目标与验收/现状/事实/约束/未知/主要矛盾/边界，合计≥40字）；第二轮 approach=基于第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考，理清自己该具体如何一步步以最高效率、少走弯路、确保完美完成自己任务的方法、流程和步骤（合计≥40字，含如何少走弯路：先查历史教训、先验证再动手、不重复试错）；approachBasis=第二轮如何基于第一轮全部结果的依据对应（合计≥20字）。',
        '不要执行任务本身，不得派生任何第四层 Agent/子会话。缺交或不合格 deepThink 会被硬拒（DEEP_THINK_MISSING / DEEP_THINK_INCOMPLETE），不登记、不接续。两项齐全提交后结束本回合；平台会立即以你的自配档接续本会话进入 phase-1（正式任务），正式执行必须严格按你第二轮理清的方法、流程、步骤进行。越界档由平台按模型家族合法集合钳制并留痕。',
    ].join('\n');
}
