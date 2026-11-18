/**
 * [1.13.0] 三阶段工作法：部门 Agent 的强制执行顺序。
 *
 * 用户要求（2026-11-05）：每个部门人员收到分配的工作后，必须
 *   1. 先全面、深入梳理「要解决的问题」；
 *   2. 再全面、深入思考，整理出能完美完成自身工作的完整、可执行思路；
 *   3. 只有前两步完成后，才按思路执行与验证。
 * 全过程按先后顺序分为三个阶段：规划阶段 → 执行阶段 → 验证阶段。
 *
 * [2.5.1] 两轮深度思考协议（用户 2026-11-11 强制要求，底层机制升级）：
 * 部门负责人、部门里相关领域的全球顶尖专家，分别在执行自己的
 * 任务时，必须——
 *   第一轮：先全面、全盘、深入梳理、研究、思考自己的任务（→ problemAnalysis）；
 *   第二轮：基于第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究
 *           和思考，理清自己的思路，理清自己该具体如何一步步执行、达到最终
 *           完美完成自己任务的方法、流程和步骤（→ approach），并把第二轮如何
 *           基于第一轮全部结果的依据对应写清（→ approachBasis，新增必填证据）；
 *   执行：最后，基于第二轮理清楚的所有方法、流程、步骤，开始具体的执行工作。
 * 三轮顺序与依赖不可颠倒：第二轮必须消费第一轮的全部结果，执行必须消费第二
 * 轮的方法、流程、步骤。approachBasis 让「基于前一步完成好的所有结果」这条
 * 依赖成为可审计的结构化证据，而不是一句提示词——缺依据的结果无法记 done。
 * 本协议对三层执行者同一口径：二级任务书（buildChildPrompt）与三级任务书
 * （buildDelegateePrompt）都注入本模块的 threePhasePromptLines，结算门禁
 * （validatePhaseEvidence）与负责人再分配门禁（planDelegations）同判据。
 * 阶段三允许用 dsh_workplan_verify 核验；缺 planning/execution 证据时返回 PHASE_GATE。
 * 注意（2.0.2 更正）：2026-11-05 的「第一、二阶段禁用插件」只是当次优化会话的
 * 过程约束，不是对所有后续会话的产品规则；插件不全局禁用。
 *
 * 这个模块只做纯函数与常量，不依赖 harness 服务：
 *   - 校验子 Agent 回报的 `phases` 证据（缺一阶段就判未完成）；
 *   - 生成阶段摘要（写进结果与日志）；
 *   - 生成提示词段落（由 `buildChildPrompt` 拼进子 Agent 的提示词）。
 *
 * 为什么用「结构化证据」而不是只写一句提示：
 * 只写提示词时，模型可以直接动手、最后补一句「我已规划」。把规划内容变成
 * 收尾证据的一部分后，缺规划/缺验证的结果无法被记成 done，主 Agent 和
 * 回放日志都能看到每个部门到底梳理了什么、按什么思路做、验证了什么。
 */
import { validateRetrospective } from './lessons.js';
// [3.0.0] Dice 单一真源在 v3-contract（零依赖，无循环）：
// plan.ts#criterionSimilarity 与这里的 missingCriteria 都用它。
import { diceSimilarity } from './v3-contract.js';
/** 三阶段顺序不可颠倒；这里也是结果块里 `phases` 的键名。 */
export const THREE_PHASE_IDS = Object.freeze(['planning', 'execution', 'verification']);
/** [2.5.1] 契约版本 2：规划阶段升级为两轮深度思考协议（新增必填 approachBasis）。 */
export const THREE_PHASE_VERSION = 3;
/**
 * 「全面、全盘、深入」无法由代码度量，但可以给一个不可忽略的下限：
 * 第一轮任务深研与第二轮方法、流程、步骤各至少 40 个字符，避免一个词就冒充
 * 规划；第二轮依据（approachBasis）至少 20 个字符，避免一句空话冒充依赖对应。
 */
export const MIN_PLANNING_PROBLEM_CHARS = 40;
export const MIN_PLANNING_APPROACH_CHARS = 40;
export const MIN_PLANNING_BASIS_CHARS = 20;
/** [3.1.0] 第二步资源与工具、第三步准备与就绪证据的下限（合计字符数）。 */
export const MIN_RESOURCE_CHARS = 20;
export const MIN_TOOL_CHARS = 10;
export const MIN_PREPARATION_CHARS = 20;
export const MAX_PHASE_LIST_ITEMS = 20;
export const MAX_PHASE_ITEM_CHARS = 800;
export const MAX_PHASE_TOTAL_CHARS = 6000;
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function readTextList(value, field, errors, options) {
    if (value === undefined || value === null) {
        if (options.required)
            errors.push(`${field} 缺失`);
        return [];
    }
    if (!Array.isArray(value)) {
        errors.push(`${field} 必须是数组`);
        return [];
    }
    const items = value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    if (options.required && items.length < (options.minItems ?? 1)) {
        errors.push(`${field} 至少需要 ${options.minItems ?? 1} 条非空内容`);
        return items.slice(0, MAX_PHASE_LIST_ITEMS);
    }
    if (items.length > MAX_PHASE_LIST_ITEMS) {
        errors.push(`${field} 超过 ${MAX_PHASE_LIST_ITEMS} 条上限`);
    }
    return items.slice(0, MAX_PHASE_LIST_ITEMS).map((item) => item.slice(0, MAX_PHASE_ITEM_CHARS));
}
function totalChars(items) {
    return items.reduce((sum, item) => sum + item.length, 0);
}
/**
 * Same matching rules as `src/plan.ts#acceptanceCoverage`（[4th batch] 归一化逐字
 * 对齐 plan.ts:3300-3309：全角折叠、完成态前缀剥离、去标点、去祈使前缀）：
 * stable A1…An numbering, exact full text, a longer text containing the
 * full criterion, a near-full copy (≥85% of the criterion length), or a
 * paraphrase with Dice ≥ 0.70 and matching negation polarity. A partial
 * copy must not count as coverage.
 *
 * Kept local to avoid importing plan.ts (which imports this module); the
 * rules are pinned by tests on both sides. Dice itself is shared via the
 * zero-dependency v3-contract single source (`diceSimilarity`).
 */
function normaliseCriterion(value) {
    return String(value ?? '')
        .trim()
        .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/　/g, ' ')
        .toLowerCase()
        .replace(/^(?:已完成|完成|已|done|yes)(?=[\s:：,，。.!！?？;；、\-—–]|$)|^(?:已完成|完成|已)/i, '')
        .replace(/[\s，。；、,.;:：!！?？"'“”‘’()（）\[\]【】《》<>]/g, '')
        .replace(/^(必须|需要|应当|应该|请|务必)/, '');
}
/** 与 plan.ts#hasNegation 逐字对齐：否定/禁止语气不一致不允许判覆盖。 */
function hasNegation(text) {
    return /不得|禁止|严禁|不能|不可|不允许|不应|无需|避免|排除|不超过|不低于|不高于|不等于|未通过|未完成/.test(String(text ?? ''));
}
function missingCriteria(expected, checks) {
    const want = (Array.isArray(expected) ? expected : []).map(normaliseCriterion);
    const got = checks.map((check) => normaliseCriterion(check.criterion)).filter(Boolean);
    const missing = [];
    for (const [index, criterion] of want.entries()) {
        if (!criterion)
            continue;
        const id = new RegExp(`(^|[^a-z0-9])a${index + 1}([^0-9]|$)`);
        const covered = got.some((row) => {
            if (row === criterion)
                return true;
            if (id.test(row))
                return true;
            if (Math.min(row.length, criterion.length) < 6)
                return false;
            if (row.includes(criterion))
                return true;
            // [2.0.4] 宽松规则（与 plan.ts:3199-3201 逐字对齐）：
            if (criterion.includes(row) && row.length / criterion.length >= 0.85)
                return true;
            if (hasNegation(criterion) !== hasNegation(row))
                return false;
            return diceSimilarity(row, criterion) >= 0.7;
        });
        if (!covered)
            missing.push(`A${index + 1}`);
    }
    return missing;
}
/**
 * Parse + validate the `phases` object from a child's evidence block.
 *
 * `expectedAcceptance` is the plan's own acceptance table. When present, every
 * criterion must have a verification check; a shorter list is treated as an
 * incomplete phase-3 verification rather than "some checks are better than none".
 */
export function validatePhaseEvidence(value, expectedAcceptance = []) {
    const errors = [];
    let failedPhase = null;
    const fail = (phase, message) => {
        errors.push(message);
        if (failedPhase === null)
            failedPhase = phase;
    };
    if (!isRecord(value)) {
        return {
            ok: false,
            phases: null,
            errors: ['phases 缺失：必须提交 planning（第一、二步）/ preparation（第三步）/ execution（第四步）/ verification（第四步验证）四组证据，第五步用 report / departmentSummary 交付'],
            failedPhase: 'shape',
        };
    }
    const planningRaw = isRecord(value.planning) ? value.planning : null;
    if (!planningRaw)
        fail('planning', 'phases.planning 缺失（第一步 · 任务梳理 + 第二步 · 资源/工具/实施方案研究：先全面、全盘、深入梳理研究自己的任务，再基于其结果研究需要哪些资源、哪些工具、具体实施方案）');
    const preparationRaw = isRecord(value.preparation) ? value.preparation : null;
    if (!preparationRaw)
        fail('preparation', 'phases.preparation 缺失（第三步 · 准备：把第二步研究出的资源、工具、实施方案真正备齐，并给出就绪证据）');
    const executionRaw = isRecord(value.execution) ? value.execution : null;
    if (!executionRaw)
        fail('execution', 'phases.execution 缺失（阶段二：基于第二轮理清的方法、流程、步骤执行）');
    const verificationRaw = isRecord(value.verification) ? value.verification : null;
    if (!verificationRaw)
        fail('verification', 'phases.verification 缺失（阶段三：逐条验证）');
    const planning = {
        problemAnalysis: readTextList(planningRaw?.problemAnalysis, 'phases.planning.problemAnalysis', errors, {
            required: !!planningRaw,
            minItems: 1,
        }),
        constraints: readTextList(planningRaw?.constraints, 'phases.planning.constraints', errors, { required: false }),
        unknowns: readTextList(planningRaw?.unknowns, 'phases.planning.unknowns', errors, { required: false }),
        approach: readTextList(planningRaw?.approach, 'phases.planning.approach', errors, {
            required: !!planningRaw,
            minItems: 1,
        }),
        approachBasis: readTextList(planningRaw?.approachBasis, 'phases.planning.approachBasis', errors, {
            required: !!planningRaw,
            minItems: 1,
        }),
        resources: readTextList(planningRaw?.resources, 'phases.planning.resources', errors, {
            required: !!planningRaw,
            minItems: 1,
        }),
        tools: readTextList(planningRaw?.tools, 'phases.planning.tools', errors, {
            required: !!planningRaw,
            minItems: 1,
        }),
    };
    if (errors.some((item) => item.startsWith('phases.planning.problemAnalysis')))
        failedPhase ||= 'planning';
    if (errors.some((item) => item.startsWith('phases.planning.approach')))
        failedPhase ||= 'planning';
    if (planning.problemAnalysis.length > 0 && totalChars(planning.problemAnalysis) < MIN_PLANNING_PROBLEM_CHARS) {
        fail('planning', `phases.planning.problemAnalysis 太薄（合计 ${totalChars(planning.problemAnalysis)} 字，至少 ${MIN_PLANNING_PROBLEM_CHARS} 字）：第一轮要全面、全盘、深入梳理、研究、思考自己的任务，逐条写清目标与验收、现状、约束、未知、主要矛盾与边界`);
    }
    if (planning.approach.length > 0 && totalChars(planning.approach) < MIN_PLANNING_APPROACH_CHARS) {
        fail('planning', `phases.planning.approach 太薄（合计 ${totalChars(planning.approach)} 字，至少 ${MIN_PLANNING_APPROACH_CHARS} 字）：第二轮要基于第一轮全部结果理清具体一步步执行、完美完成任务的方法、流程和步骤，而不是一句目标`);
    }
    if (planning.approachBasis.length > 0 && totalChars(planning.approachBasis) < MIN_PLANNING_BASIS_CHARS) {
        fail('planning', `phases.planning.approachBasis 太薄（合计 ${totalChars(planning.approachBasis)} 字，至少 ${MIN_PLANNING_BASIS_CHARS} 字）：要写清第二轮的方法、流程、步骤如何基于第一轮梳理、研究、思考完成好的所有结果`);
    }
    if (planning.resources.length > 0 && totalChars(planning.resources) < MIN_RESOURCE_CHARS) {
        fail('planning', `phases.planning.resources 太薄（合计 ${totalChars(planning.resources)} 字，至少 ${MIN_RESOURCE_CHARS} 字）：第二步要逐项写清完成本任务需要哪些资源（数据/文件/权限/人/知识/时间），缺一项就会在执行中卡住`);
    }
    if (planning.tools.length > 0 && totalChars(planning.tools) < MIN_TOOL_CHARS) {
        fail('planning', `phases.planning.tools 太薄（合计 ${totalChars(planning.tools)} 字，至少 ${MIN_TOOL_CHARS} 字）：第二步要逐项写清需要哪些工具、每个工具用来做什么、为什么选它`);
    }
    const preparation = {
        prepared: readTextList(preparationRaw?.prepared, 'phases.preparation.prepared', errors, {
            required: !!preparationRaw,
            minItems: 1,
        }),
        evidence: readTextList(preparationRaw?.evidence, 'phases.preparation.evidence', errors, {
            required: !!preparationRaw,
            minItems: 1,
        }),
    };
    if (errors.some((item) => item.startsWith('phases.preparation')))
        failedPhase ||= 'preparation';
    if (preparation.prepared.length > 0 && totalChars(preparation.prepared) < MIN_PREPARATION_CHARS) {
        fail('preparation', `phases.preparation.prepared 太薄（合计 ${totalChars(preparation.prepared)} 字，至少 ${MIN_PREPARATION_CHARS} 字）：第三步要把第二步研究出的资源与工具真正备齐，逐项写清准备了什么、在哪里、是否可用`);
    }
    if (preparation.evidence.length > 0 && totalChars(preparation.evidence) < MIN_PREPARATION_CHARS) {
        fail('preparation', `phases.preparation.evidence 太薄（合计 ${totalChars(preparation.evidence)} 字，至少 ${MIN_PREPARATION_CHARS} 字）：每一项就绪状态都要有可复核的证据（命令输出/文件路径/配置项/版本号/引用）`);
    }
    const execution = {
        steps: readTextList(executionRaw?.steps, 'phases.execution.steps', errors, {
            required: !!executionRaw,
            minItems: 1,
        }),
        deviations: readTextList(executionRaw?.deviations, 'phases.execution.deviations', errors, { required: false }),
    };
    if (errors.some((item) => item.startsWith('phases.execution')))
        failedPhase ||= 'execution';
    const retroCheck = validateRetrospective(verificationRaw?.retrospective);
    for (const error of retroCheck.errors)
        fail('verification', error);
    const verification = {
        allPassed: verificationRaw?.allPassed === true,
        checks: [],
        requirementCheck: typeof verificationRaw?.requirementCheck === 'string'
            ? verificationRaw.requirementCheck.trim().slice(0, MAX_PHASE_ITEM_CHARS)
            : '',
        retrospective: retroCheck.retrospective,
    };
    if (verificationRaw && verificationRaw.allPassed !== true) {
        fail('verification', 'phases.verification.allPassed 必须为 true：只要有一条验收标准未通过或未验证，就不得报 done');
    }
    if (!Array.isArray(verificationRaw?.checks)) {
        if (verificationRaw)
            fail('verification', 'phases.verification.checks 必须是数组');
    }
    else {
        verification.checks = verificationRaw.checks
            .slice(0, MAX_PHASE_LIST_ITEMS)
            .map((item, index) => {
            if (!isRecord(item)) {
                fail('verification', `phases.verification.checks[${index}] 必须是对象（criterion / method / evidence）`);
                return { criterion: '', method: '', evidence: '' };
            }
            const check = {
                criterion: typeof item.criterion === 'string' ? item.criterion.trim().slice(0, MAX_PHASE_ITEM_CHARS) : '',
                method: typeof item.method === 'string' ? item.method.trim().slice(0, MAX_PHASE_ITEM_CHARS) : '',
                evidence: typeof item.evidence === 'string' ? item.evidence.trim().slice(0, MAX_PHASE_ITEM_CHARS) : '',
            };
            if (!check.criterion)
                fail('verification', `phases.verification.checks[${index}].criterion 不能为空`);
            if (!check.method)
                fail('verification', `phases.verification.checks[${index}].method 不能为空（用什么方式验证）`);
            if (!check.evidence)
                fail('verification', `phases.verification.checks[${index}].evidence 不能为空（命令输出/文件/引用）`);
            return check;
        });
        if (verification.checks.length === 0) {
            fail('verification', 'phases.verification.checks 至少需要一条逐项验证记录');
        }
    }
    const expected = Array.isArray(expectedAcceptance) ? expectedAcceptance.filter(Boolean) : [];
    if (expected.length > 0 && verification.checks.length < expected.length) {
        fail('verification', `phases.verification.checks 只验证了 ${verification.checks.length} 项，少于验收标准的 ${expected.length} 项：每条验收标准都要有验证记录`);
    }
    if (expected.length > 0) {
        const missing = missingCriteria(expected, verification.checks);
        if (missing.length > 0) {
            fail('verification', `phases.verification.checks 未逐条覆盖验收标准：缺少 ${missing.join('、')}（可按 A1/A2 编号对号入座，或写完整原文；只写一部分不算覆盖）`);
        }
    }
    const phases = {
        version: THREE_PHASE_VERSION,
        planning,
        preparation,
        execution,
        verification,
    };
    const total = [
        ...planning.problemAnalysis,
        ...planning.constraints,
        ...planning.unknowns,
        ...planning.approach,
        ...planning.approachBasis,
        ...planning.resources,
        ...planning.tools,
        ...preparation.prepared,
        ...preparation.evidence,
        ...execution.steps,
        ...execution.deviations,
        verification.requirementCheck,
    ].reduce((sum, item) => sum + item.length, 0);
    if (total > MAX_PHASE_TOTAL_CHARS) {
        fail('shape', `phases 合计超过 ${MAX_PHASE_TOTAL_CHARS} 字，请压缩到可核对的事实，不要粘贴大段日志`);
    }
    return { ok: errors.length === 0, phases: errors.length === 0 ? phases : null, errors, failedPhase };
}
/**
 * Which stage a caller is allowed to be in, judged only by the evidence it sent.
 *
 * Used by `dsh_workplan_verify`: planning/execution gaps mean the caller is
 * still in phase 1 or 2, where the plugin is disabled by the user's rule.
 */
export function phaseGateFromErrors(errors) {
    return errors.some((item) => /^phases(\.| 缺失)/.test(item) && /planning|preparation|execution/.test(item))
        ? 'phase-1-3'
        : 'verification';
}
/** One-line, model-readable summary of what the three phases contain. */
export function phaseSummaryLine(phases) {
    const deviations = phases.execution.deviations.length;
    return [
        `第一步 任务梳理（${phases.planning.problemAnalysis.length} 条）`,
        `第二步 资源/工具/方案研究（资源 ${phases.planning.resources.length} 项 / 工具 ${phases.planning.tools.length} 项 / 方法 ${phases.planning.approach.length} 步 / 依据 ${phases.planning.approachBasis.length} 条）`,
        `第三步 准备（已备 ${phases.preparation.prepared.length} 项 / 就绪证据 ${phases.preparation.evidence.length} 条）`,
        `第四步 执行与验证（执行 ${phases.execution.steps.length} 步${deviations ? ` / 偏离 ${deviations} 处` : ''}；验证 ${phases.verification.checks.length} 项${phases.verification.allPassed ? '，全部通过' : '，未全部通过'}；`
            + `复盘 ${phases.verification.retrospective.problems.length} 个问题 / `
            + `${phases.verification.retrospective.detours.length} 条弯路 / `
            + `${phases.verification.retrospective.prevention.length} 条防再犯规则）`,
        '第五步 JSON 交付（report / departmentSummary，只含关键信息）',
    ].join('；');
}
/**
 * Prompt paragraphs injected into every department child.
 *
 * Kept in this module so the wording and the validator above are one contract:
 * changing what is demanded without changing what is checked would make the
 * prompt lie about completion.
 */
export function threePhasePromptLines() {
    return [
        '五步工作法（用户 2026-11-17 强制要求，取代旧的三阶段口径；五个步骤必须按顺序执行，前一步没有完成并写好证据之前，禁止进入下一步）：',
        '【第一步 · 任务梳理（部门负责人、相关领域全球顶尖专家执行自己的任务时同一口径）】',
        '  先全面、全盘、深入梳理、研究、思考自己的任务：逐条写清任务目标与验收标准、现状与已知事实、约束条件、未知/待确认项、主要矛盾、工作边界与依赖，结果写入 phases.planning.problemAnalysis（约束写 constraints，未知写 unknowns）。',
        '【第二步 · 资源、工具与实施方案研究】',
        '  基于第一步完成好的所有结果，再全面、全盘、深入地梳理、研究、思考：完成本任务需要哪些资源（数据/文件/权限/人/知识/时间）写入 phases.planning.resources；需要哪些工具、每个工具用来做什么写入 phases.planning.tools；具体实施方案写成自己该具体如何一步步以最高效率执行、确保完美完成自己任务的方法、流程和步骤（每一步做什么、产出什么、依赖什么、风险与对策、如何证明做对了，以及全程如何少走弯路：先查历史教训、先验证再动手、不重复试错）写入 phases.planning.approach；同时把第二步如何基于第一步全部结果逐条对应写入 phases.planning.approachBasis。',
        '  自检：任何一条验收标准或用户原要求没有落在第二步的资源、工具与实施方案上，就回到第一步重做。',
        '【第三步 · 准备】',
        '  基于第二步的全部结果，把需要的资源、工具、实施方案真正准备到位，而不是「打算用」：逐项写清准备了什么、在哪里、是否可用，写入 phases.preparation.prepared；每一项就绪状态都必须给出可复核的证据（命令输出/文件路径/配置项/版本号/引用），写入 phases.preparation.evidence。缺资源、缺工具、缺证据时，先补齐或如实上报受阻，不得带着缺口进入第四步。',
        '【第四步 · 执行与验证】',
        '  基于第三步备齐的成果和既定实施方案，开始具体执行，严格按 phases.planning.approach 落地；出现新事实需要偏离时，必须记录偏离原因、证据与调整后的做法，不得静默改道，执行步骤写入 phases.execution.steps。',
        '  执行完成后逐条验证验收标准与用户原要求：每条都要有可复核的证据（命令输出/文件/引用）；验证未通过不得报 done，无法确认写 unverified；结果写入 phases.verification。',
        '【第四步收尾 · 自我学习复盘（强制）】',
        '  报 done 之前必须把 phases.verification.retrospective 写全，四项缺一不可：',
        '  1) problems：本次全过程遇到的所有问题（现象 + 根因），至少 1 条；',
        '  2) detours：走过的弯路、返工与无效尝试（确实没有就写空数组 []，不要编造）；',
        '  3) resolutions：最终是如何解决上述问题的，至少 1 条，可与 problems 一一对应；',
        '  4) prevention：以后如何预防再犯，至少 1 条，必须写成「遇到…先…」的可执行硬规则。',
        '【第五步 · JSON mode 结构化交付给本部门负责人】',
        '  执行完美完成后，必须把成果以 JSON mode 结构化交回本部门负责人：专家写入 report 对象（只允许 keyResults / keyInfo / importantInfo / leadRequirements 四个字符串数组字段，只写关键信息、关键成果、重要信息和负责人要求的东西，禁止过程流水账与重复表述）；部门负责人写入 departmentSummary 对象（keyResults / keyInfo / importantInfo / sources，汇总本部门全部专家汇报，sources 必须覆盖全部已派发专家）。成果块必须放在 <!-- WORKPLAN_EVIDENCE:START --> 与 <!-- WORKPLAN_EVIDENCE:END --> 之间，且是合法 JSON，不得用散文代替。',
        '插件使用说明（五步证据门禁）：',
        '  - 第一、二、三步：先把问题梳理、资源/工具/实施方案、准备与就绪证据写全；此时不要调用 dsh_workplan_verify，它会因缺少前几步证据返回 PHASE_GATE 与待补项（这是证据门禁，不是禁用插件）。',
        '  - 第四步：可以调用 dsh_workplan_verify 让插件做最终核验：提交 planning / preparation / execution / verification 证据，插件返回 passed 或仍需补齐的 gaps；未通过先修复再回报。遇阻时可用 dsh_workplan_escalate 上报，它是安全通道，不属于五步产物。',
        '  - 结果块里的 phases 是必填项：缺 planning / preparation / execution / verification 任一组、内容为空、或验证未全部通过，插件都会判为未完成，不能用 done 收尾；第五步缺 report / departmentSummary 同样判为未完成。',
    ];
}
/**
 * 主 Agent 两轮思考产物校验（派发硬门禁的唯一判据，与结算门禁同一口径：
 * 第一轮 ≥40 字、第二轮方法流程步骤 ≥40 字、第二轮依据 ≥20 字）。
 * 纯函数：dispatchTool 与测试同口径消费，门禁不能被提示词绕过。
 */
export function validateMainDeepThink(value) {
    if (!isRecord(value)) {
        return {
            ok: false,
            code: 'MAIN_DEEP_THINK_MISSING',
            error: '两轮深度思考产物缺失：执行自己的任务必须先全面、全盘、深入梳理、研究、思考自己的任务（第一轮），再基于第一轮完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，理清具体如何一步步以最高效率、少走弯路、完美完成任务的方法、流程和步骤（第二轮），最后才按此执行。请随相应工具调用提交 deepThink={ problemAnalysis[]（第一轮任务深研）, approach[]（第二轮方法流程步骤）, approachBasis[]（第二轮基于第一轮全部结果的依据对应） }（主 Agent 经 dsh_workplan_dispatch，专家经 self_effort）。',
            deepThink: null,
        };
    }
    const errors = [];
    const problemAnalysis = readTextList(value.problemAnalysis, 'deepThink.problemAnalysis', errors, { required: true, minItems: 1 });
    const approach = readTextList(value.approach, 'deepThink.approach', errors, { required: true, minItems: 1 });
    const approachBasis = readTextList(value.approachBasis, 'deepThink.approachBasis', errors, { required: true, minItems: 1 });
    if (problemAnalysis.length > 0 && totalChars(problemAnalysis) < MIN_PLANNING_PROBLEM_CHARS) {
        errors.push(`deepThink.problemAnalysis 太薄（合计 ${totalChars(problemAnalysis)} 字，至少 ${MIN_PLANNING_PROBLEM_CHARS} 字）：第一轮要全面、全盘、深入梳理、研究、思考自己的任务，写清目标与验收、现状、约束、未知、主要矛盾与边界`);
    }
    if (approach.length > 0 && totalChars(approach) < MIN_PLANNING_APPROACH_CHARS) {
        errors.push(`deepThink.approach 太薄（合计 ${totalChars(approach)} 字，至少 ${MIN_PLANNING_APPROACH_CHARS} 字）：第二轮要基于第一轮全部结果理清具体一步步以最高效率、少走弯路、完美完成任务的方法、流程和步骤，而不是一句目标`);
    }
    if (approachBasis.length > 0 && totalChars(approachBasis) < MIN_PLANNING_BASIS_CHARS) {
        errors.push(`deepThink.approachBasis 太薄（合计 ${totalChars(approachBasis)} 字，至少 ${MIN_PLANNING_BASIS_CHARS} 字）：要写清第二轮的方法、流程、步骤如何基于第一轮完成好的所有结果`);
    }
    if (errors.length > 0) {
        return { ok: false, code: 'MAIN_DEEP_THINK_INCOMPLETE', error: errors.join('；'), deepThink: null };
    }
    return { ok: true, deepThink: { problemAnalysis, approach, approachBasis } };
}
/**
 * 回放侧消毒（G1 教训：写入与消费双侧同一判据）：durable 日志里的主 Agent
 * 两轮产物重新过一遍校验，非法/被篡改 ⇒ null（门禁要求重新提交），合法 ⇒
 * 归一化后的产物。旧日志无该字段 ⇒ undefined 进、null 出，零迁移不报错。
 */
export function sanitizeMainDeepThink(value) {
    const check = validateMainDeepThink(value);
    return check.ok ? check.deepThink : null;
}
