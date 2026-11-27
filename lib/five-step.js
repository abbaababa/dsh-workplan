/**
 * [3.0.8] 五步工作法：部门 Agent 的强制执行顺序（单一框架）。
 *
 * 历史口径（本文件是三次强制要求的收口）：
 *   1. [1.13.0] 三阶段工作法（2026-11-05）：规划 → 执行 → 验证；
 *   2. [2.5.1] 两轮深度思考协议（2026-11-11）：第一轮任务深研 + 第二轮方法流程
 *      步骤（含依据 approachBasis），deepThink 开工硬门禁；
 *   3. [3.1.0] 五步工作法（2026-11-17）：第一步任务梳理 → 第二步资源/工具/实施
 *      方案研究 → 第三步准备 → 第四步执行与验证 → 第五步 JSON 交付。
 *   4. [3.0.8] 单框架收口（用户裁决）：废除独立的两轮深度思考 deepThink 门禁——
 *      两轮思考的实质内容（problemAnalysis/approach/approachBasis）本就是五步法
 *      第 1、2 步的子集，保留两套框架造成同一内容双份提交、编号口径互相矛盾。
 *      现在全系统只有一套五步契约：
 *        - 开工闸（dispatch/review/self_effort/direct）：必须随附第 1、2、3 步
 *          证据（phases.planning + phases.preparation，validateStartPhaseEvidence），
 *          未交/不合格硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE）；
 *        - 结算闸（adjudicateResult）：第 4、5 步证据（execution/verification/
 *          report）+ 与开工登记的一致性比对（checkStartEvidenceCarryover），
 *          防止「开工登记一套、收尾另写一套」；
 *        - verify 工具：第四步验证前的分步自检（PHASE_GATE 语义不变）。
 *
 * 为什么用「结构化证据」而不是只写一句提示：
 * 只写提示词时，模型可以直接动手、最后补一句「我已规划」。把规划内容变成
 * 收尾证据的一部分后，缺规划/缺验证的结果无法被记成 done，主 Agent 和
 * 回放日志都能看到每个部门到底梳理了什么、按什么思路做、验证了什么。
 *
 * 这个模块只做纯函数与常量，不依赖 harness 服务：
 *   - 校验开工证据（第 1/2/3 步）与结算证据（全部五步）；
 *   - 开工-结算一致性比对（carryover）；
 *   - 生成阶段摘要（写进结果与日志）；
 *   - 生成提示词段落（由 buildChildPrompt/buildDelegateePrompt 拼进任务书）。
 */
import { MIN_RETRO_PREVENTION_CHARS, MIN_RETRO_PROBLEM_CHARS, MIN_RETRO_RESOLUTION_CHARS, validateRetrospective } from './lessons.js';
// [3.0.0] Dice 单一真源在 v3-contract（零依赖，无循环）：
// plan.ts#criterionSimilarity 与这里的 missingCriteria 都用它。
import { diceSimilarity } from './v3-contract.js';
/** 五步证据四组键（结果块里 `phases` 的键名）；第五步由 report/departmentSummary 承载。 */
export const FIVE_STEP_EVIDENCE_KEYS = Object.freeze(['planning', 'preparation', 'execution', 'verification']);
/**
 * [3.0.8] 契约版本 4：单框架收口——废除 deepThink 两轮开工门禁，开工闸升级为
 * 第 1/2/3 步证据（planning+preparation），结算新增开工-结算一致性比对。
 */
export const FIVE_STEP_CONTRACT_VERSION = 4;
/**
 * 「全面、全盘、深入」无法由代码度量，但可以给一个不可忽略的下限：
 * 第一步任务梳理与第二步方法、流程、步骤各至少 40 个字符，避免一个词就冒充
 * 规划；第二步依据（approachBasis）至少 20 个字符，避免一句空话冒充依赖对应。
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
/**
 * [修复] 七项字数下限的完整简报（由上方常量渲染，提示词与校验器同一事实源）。
 * 旧文案只写「40/40/20 字判据」，遮蔽了 resources/tools/prepared/evidence 四项下限，
 * 导致子 Agent 照提示词写却仍然被开工闸/结算闸打回。此处一处定义、各处引用。
 */
export const START_EVIDENCE_MIN_CHARS_BRIEF = `problemAnalysis 合计 ≥${MIN_PLANNING_PROBLEM_CHARS} 字、approach 合计 ≥${MIN_PLANNING_APPROACH_CHARS} 字、approachBasis 合计 ≥${MIN_PLANNING_BASIS_CHARS} 字、resources 合计 ≥${MIN_RESOURCE_CHARS} 字、tools 合计 ≥${MIN_TOOL_CHARS} 字、prepared 合计 ≥${MIN_PREPARATION_CHARS} 字、evidence 合计 ≥${MIN_PREPARATION_CHARS} 字`;
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
/*
 * [3.4.1][RC-1 治本] verification.checks 同义字段归一。
 *
 * 实机事故（wp-c04490d4 / macOS 27 / deepseek-flash）：T1、T2、T3 的子 Agent
 * 顶层 acceptance 全部 pass 且证据齐全，却把 checks 写成
 * `{check,result,evidence}` / `{item,result,evidence}` /
 * `{check,command,expected,actual,passed}`，被「criterion/method 不能为空」
 * 硬拒，T3 因此永久阻塞。字段名只是同义写法，不是证据缺失——这里把常见别名
 * 归一到 criterion/method/evidence；真正空白的仍然由校验器拦截。
 */
const CHECK_CRITERION_ALIASES = ['criterion', 'check', 'item', 'name', 'title', 'target', 'requirement', 'acceptance', 'id'];
const CHECK_METHOD_ALIASES = ['method', 'command', 'cmd', 'how', 'tool', 'via', 'approach', 'verifiedBy', 'verification'];
const CHECK_EVIDENCE_ALIASES = ['evidence', 'actual', 'output', 'observed', 'proof', 'detail', 'details', 'note', 'notes', 'result'];
function firstText(item, keys) {
    for (const key of keys) {
        const value = item[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
        if (typeof value === 'number' && Number.isFinite(value))
            return String(value);
    }
    return '';
}
export function normalizePhaseCheckFields(item) {
    if (!isRecord(item))
        return { criterion: '', method: '', evidence: '' };
    const criterion = firstText(item, CHECK_CRITERION_ALIASES);
    const method = firstText(item, CHECK_METHOD_ALIASES);
    let evidence = firstText(item, CHECK_EVIDENCE_ALIASES);
    // `result: "pass"` 只是结论不是证据；有 expected/actual 时拼成可复核的一句。
    if (/^(pass|passed|ok|true|通过|fail|failed|unverified)$/i.test(evidence)) {
        const expected = typeof item.expected === 'string' ? item.expected.trim() : '';
        evidence = expected ? `${evidence}（期望：${expected}）` : evidence;
    }
    return { criterion, method, evidence };
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
/** 解析并校验 planning 组（第 1、2 步证据）；required=false 时全部字段 optional。 */
function parsePlanningPhase(planningRaw, errors, required) {
    const planning = {
        problemAnalysis: readTextList(planningRaw?.problemAnalysis, 'phases.planning.problemAnalysis', errors, {
            required,
            minItems: 1,
        }),
        constraints: readTextList(planningRaw?.constraints, 'phases.planning.constraints', errors, { required: false }),
        unknowns: readTextList(planningRaw?.unknowns, 'phases.planning.unknowns', errors, { required: false }),
        approach: readTextList(planningRaw?.approach, 'phases.planning.approach', errors, {
            required,
            minItems: 1,
        }),
        approachBasis: readTextList(planningRaw?.approachBasis, 'phases.planning.approachBasis', errors, {
            required,
            minItems: 1,
        }),
        resources: readTextList(planningRaw?.resources, 'phases.planning.resources', errors, {
            required,
            minItems: 1,
        }),
        tools: readTextList(planningRaw?.tools, 'phases.planning.tools', errors, {
            required,
            minItems: 1,
        }),
    };
    if (planning.problemAnalysis.length > 0 && totalChars(planning.problemAnalysis) < MIN_PLANNING_PROBLEM_CHARS) {
        errors.push(`phases.planning.problemAnalysis 太薄（合计 ${totalChars(planning.problemAnalysis)} 字，至少 ${MIN_PLANNING_PROBLEM_CHARS} 字）：第一步要全面、全盘、深入梳理、研究、思考自己的任务，逐条写清目标与验收、现状、约束、未知、主要矛盾与边界`);
    }
    if (planning.approach.length > 0 && totalChars(planning.approach) < MIN_PLANNING_APPROACH_CHARS) {
        errors.push(`phases.planning.approach 太薄（合计 ${totalChars(planning.approach)} 字，至少 ${MIN_PLANNING_APPROACH_CHARS} 字）：第二步要基于第一步全部结果理清具体一步步执行、完美完成任务的方法、流程和步骤，而不是一句目标`);
    }
    if (planning.approachBasis.length > 0 && totalChars(planning.approachBasis) < MIN_PLANNING_BASIS_CHARS) {
        errors.push(`phases.planning.approachBasis 太薄（合计 ${totalChars(planning.approachBasis)} 字，至少 ${MIN_PLANNING_BASIS_CHARS} 字）：要写清第二步的方法、流程、步骤如何基于第一步梳理、研究、思考完成好的所有结果`);
    }
    if (planning.resources.length > 0 && totalChars(planning.resources) < MIN_RESOURCE_CHARS) {
        errors.push(`phases.planning.resources 太薄（合计 ${totalChars(planning.resources)} 字，至少 ${MIN_RESOURCE_CHARS} 字）：第二步要逐项写清完成本任务需要哪些资源（数据/文件/权限/人/知识/时间），缺一项就会在执行中卡住`);
    }
    if (planning.tools.length > 0 && totalChars(planning.tools) < MIN_TOOL_CHARS) {
        errors.push(`phases.planning.tools 太薄（合计 ${totalChars(planning.tools)} 字，至少 ${MIN_TOOL_CHARS} 字）：第二步要逐项写清需要哪些工具、每个工具用来做什么、为什么选它`);
    }
    return planning;
}
/** 解析并校验 preparation 组（第 3 步证据）；required=false 时全部字段 optional。 */
function parsePreparationPhase(preparationRaw, errors, required) {
    const preparation = {
        prepared: readTextList(preparationRaw?.prepared, 'phases.preparation.prepared', errors, {
            required,
            minItems: 1,
        }),
        evidence: readTextList(preparationRaw?.evidence, 'phases.preparation.evidence', errors, {
            required,
            minItems: 1,
        }),
    };
    if (preparation.prepared.length > 0 && totalChars(preparation.prepared) < MIN_PREPARATION_CHARS) {
        errors.push(`phases.preparation.prepared 太薄（合计 ${totalChars(preparation.prepared)} 字，至少 ${MIN_PREPARATION_CHARS} 字）：第三步要把第二步研究出的资源与工具真正备齐，逐项写清准备了什么、在哪里、是否可用`);
    }
    if (preparation.evidence.length > 0 && totalChars(preparation.evidence) < MIN_PREPARATION_CHARS) {
        errors.push(`phases.preparation.evidence 太薄（合计 ${totalChars(preparation.evidence)} 字，至少 ${MIN_PREPARATION_CHARS} 字）：每一项就绪状态都要有可复核的证据（命令输出/文件路径/配置项/版本号/引用）`);
    }
    return preparation;
}
/**
 * Parse + validate the `phases` object from a child's evidence block（结算闸：五步全量）。
 *
 * `expectedAcceptance` is the plan's own acceptance table. When present, every
 * criterion must have a verification check; a shorter list is treated as an
 * incomplete 第四步 verification rather than "some checks are better than none".
 */
/**
 * [3.2.7][P0] 第三层叶子（专家）结算专用的五步核验：只校验第四步
 * （execution）与第四步收尾（verification）两组。
 *
 * 规划（planning）与准备（preparation）由开工登记与平台自动并入承载，叶子
 * 不必重抄（见 five-step.ts 的「平台自动并入」契约）；但一份 `status:"done"`
 * 的汇报如果连「实际怎么做的」和「逐条验证过没有」都没有，就不该被记成完成。
 * 旧实现只校验 F10 的 report 四字段，五步契约在第三层完全落空。
 */
export function validateLeafExecutionEvidence(value, expectedAcceptance = []) {
    const errors = [];
    if (!isRecord(value)) {
        return { ok: false, errors: ['phases 缺失：第三层专家交卷同样必须附第四步（execution）与验证（verification）两组证据'] };
    }
    const steps = Array.isArray(value.execution?.steps)
        ? value.execution.steps.filter((step) => typeof step === 'string' && step.trim() !== '')
        : [];
    if (steps.length === 0)
        errors.push('phases.execution.steps 为空：第四步要逐条写清实际是怎么做完的');
    const verification = value.verification;
    if (!isRecord(verification)) {
        errors.push('phases.verification 缺失：第四步收尾必须逐条验证验收标准并附可复核证据');
    }
    else if (verification.allPassed === true && Array.isArray(expectedAcceptance)) {
        const explicit = expectedAcceptance.filter((entry) => isRecord(entry) && typeof entry.result === 'string');
        const failed = explicit.filter((entry) => entry.result !== 'pass');
        if (failed.length > 0) {
            errors.push(`phases.verification.allPassed 与验收表冲突：${failed.length}/${explicit.length} 项 result 不是 pass，不得报全部通过`);
        }
    }
    return { ok: errors.length === 0, errors };
}
export function validateFiveStepEvidence(value, expectedAcceptance = [], fillStart = null) {
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
            errors: ['phases 缺失：必须提交 execution（第四步）/ verification（第四步验证）两组证据；若本任务是 phase-0 已登记开工证据的接续执行，planning / preparation 由平台自动并入，无需重抄'],
            failedPhase: 'shape',
        };
    }
    /*
     * [3.2.0][省钱] 交卷免重抄开工证据。
     *
     * phase-0 已把第 1/2/3 步原文登记为 durable 事实；旧结算闸仍要求交卷时
     * 逐字重抄一遍，模型为此多输出 2–5KB，且抄错/抄薄就会退回重交。这里在
     * 校验入口允许用登记证据补齐缺失的 planning / preparation：交卷只需
     * execution / verification 增量，平台随后用 mergeStartEvidenceIntoSettlement
     * 做并集落账，登记内容一条不丢。fillStart 不传时行为与旧版逐字一致。
     */
    const fill = isRecord(fillStart) && isRecord(fillStart.planning) && isRecord(fillStart.preparation)
        ? fillStart
        : null;
    /*
     * 「提交了但整组为空」与「没提交」等价：模型常写 planning:{} 占位。
     * 更常见的是只补写了其中一两个清单——按字段而不是按整组判断，缺哪个
     * 清单就用登记值补哪个，交卷人写多少算多少，不会被半组内容击穿。
     */
    const planningKeys = ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'];
    const preparationKeys = ['prepared', 'evidence'];
    const submittedPlanning = isRecord(value.planning) ? value.planning : null;
    const submittedPreparation = isRecord(value.preparation) ? value.preparation : null;
    const missingPlanningFields = fill
        ? planningKeys.filter((key) => !(Array.isArray(submittedPlanning?.[key]) && submittedPlanning[key].length > 0))
        : [];
    const missingPreparationFields = fill
        ? preparationKeys.filter((key) => !(Array.isArray(submittedPreparation?.[key]) && submittedPreparation[key].length > 0))
        : [];
    const planningRaw = fill
        ? {
            ...(submittedPlanning ?? {}),
            ...Object.fromEntries(missingPlanningFields.map((key) => [key, fill.planning[key]])),
        }
        : submittedPlanning;
    if (!planningRaw)
        fail('planning', 'phases.planning 缺失（第一步 · 任务梳理 + 第二步 · 资源/工具/实施方案研究：先全面、全盘、深入梳理研究自己的任务，再基于其结果研究需要哪些资源、哪些工具、具体实施方案）');
    const preparationRaw = fill
        ? {
            ...(submittedPreparation ?? {}),
            ...Object.fromEntries(missingPreparationFields.map((key) => [key, fill.preparation[key]])),
        }
        : submittedPreparation;
    if (!preparationRaw)
        fail('preparation', 'phases.preparation 缺失（第三步 · 准备：把第二步研究出的资源、工具、实施方案真正备齐，并给出就绪证据）');
    const executionRaw = isRecord(value.execution) ? value.execution : null;
    if (!executionRaw)
        fail('execution', 'phases.execution 缺失（第四步：基于第二步理清的方法、流程、步骤执行）');
    const verificationRaw = isRecord(value.verification) ? value.verification : null;
    if (!verificationRaw)
        fail('verification', 'phases.verification 缺失（第四步收尾：逐条验证）');
    const planning = parsePlanningPhase(planningRaw, errors, !!planningRaw);
    if (errors.some((item) => item.startsWith('phases.planning')))
        failedPhase ||= 'planning';
    const preparation = parsePreparationPhase(preparationRaw, errors, !!preparationRaw);
    if (errors.some((item) => item.startsWith('phases.preparation')))
        failedPhase ||= 'preparation';
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
            const normalized = normalizePhaseCheckFields(item);
            const check = {
                criterion: normalized.criterion.slice(0, MAX_PHASE_ITEM_CHARS),
                method: normalized.method.slice(0, MAX_PHASE_ITEM_CHARS),
                evidence: normalized.evidence.slice(0, MAX_PHASE_ITEM_CHARS),
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
    /*
     * 自报 allPassed 不得与验收表打架：模型可以把 verification.allPassed 写成 true，
     * 同时在顶层 acceptance 里留 result!=="pass"。旧实现直接采信自报值，于是一份
     * 不可交付的计划被记成 done。这里用验收表复核，冲突即以验收表为准并报错。
     */
    let allPassed = verification.allPassed;
    if (allPassed && expected.length > 0) {
        // 只对「显式写了 result 字符串」的验收项复核：expectedAcceptance 既可能是
        // 对象数组，也可能是纯字符串数组（老调用方），后者的 result 不存在，不能算冲突。
        const explicit = expected.filter((entry) => isRecord(entry) && typeof entry.result === 'string');
        const failedAcceptance = explicit.filter((entry) => entry.result !== 'pass');
        if (failedAcceptance.length > 0) {
            allPassed = false;
            fail('verification', `phases.verification.allPassed 与你提交的验收表冲突：${failedAcceptance.length}/${expected.length} 项 result 不是 pass，不得报全部通过`);
        }
    }
    verification.allPassed = allPassed;
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
        version: FIVE_STEP_CONTRACT_VERSION,
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
        // 逐项验证记录与复盘同样属于「交卷人自己写的内容」，必须计入上限，
        // 否则 checks 每条 3×800 字、复盘任意长都能整体绕开 6000 字硬上限。
        ...verification.checks.flatMap((check) => [check.criterion, check.method, check.evidence]),
        ...Object.values(retroCheck.retrospective ?? {}).flatMap((value) => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []),
    ].reduce((sum, item) => sum + item.length, 0);
    /*
     * [3.2.0] 字数上限只约束「交卷人自己写的内容」。由平台并入的登记证据
     * 已经在开工闸逐字校验并 durable 落账，不应再拿 6000 字上限把它判为超限；
     * 否则省输出反而变成新的退回源。这里按条目精确扣除自动并入的部分，
     * 交卷人自己写超了仍然拦截（不会因为「有登记」就完全放开日志粘贴）。
     */
    const autoFilledChars = fill
        ? missingPlanningFields.reduce((sum, key) => {
            const items = fill.planning[key];
            return sum + (Array.isArray(items) ? totalChars(items) : 0);
        }, 0)
            + missingPreparationFields.reduce((sum, key) => {
                const items = fill.preparation[key];
                return sum + (Array.isArray(items) ? totalChars(items) : 0);
            }, 0)
        : 0;
    if (total - autoFilledChars > MAX_PHASE_TOTAL_CHARS) {
        fail('shape', `phases 合计超过 ${MAX_PHASE_TOTAL_CHARS} 字，请压缩到可核对的事实，不要粘贴大段日志`);
    }
    return { ok: errors.length === 0, phases: errors.length === 0 ? phases : null, errors, failedPhase };
}
/**
 * Which stage a caller is allowed to be in, judged only by the evidence it sent.
 *
 * Used by `dsh_workplan_verify`: planning/preparation/execution gaps mean the caller is
 * still in steps 1–3, where verify returns PHASE_GATE with the missing items.
 */
export function phaseGateFromErrors(errors) {
    return errors.some((item) => /^phases(\.| 缺失)/.test(item) && /planning|preparation|execution/.test(item))
        ? 'steps-1-3'
        : 'verification';
}
/** One-line, model-readable summary of what the five-step evidence contains. */
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
 * Kept in this module so the wording and the validators above are one contract:
 * changing what is demanded without changing what is checked would make the
 * prompt lie about completion.
 */
export function fiveStepPromptLines() {
    return [
        '五步工作法（强制顺序，前一步未完成不进下一步）：',
        '【第一步 · 任务梳理】先全面、全盘、深入梳理、研究、思考自己的任务（目标/验收/现状/约束/未知/主要矛盾/边界），写 phases.planning.problemAnalysis。',
        '【第二步 · 资源、工具与实施方案研究】基于第一步完成好的所有结果，再全面、全盘、深入地梳理、研究、思考需要哪些资源（resources）、哪些工具（tools），以及以最高效率执行、确保完美完成自己任务的方法、流程和步骤（approach，含少走弯路：先查历史教训、先验证再动手）；并在 approachBasis 写清第二步基于第一步结果的依据。',
        '【第三步 · 准备】把第二步资源、工具真正备齐：已备项→phases.preparation.prepared；就绪证据（命令/文件/配置/版本）→phases.preparation.evidence。',
        '【第四步 · 执行与验证】基于第三步备齐的成果和既定实施方案，开始具体执行（steps/deviations）；第四步：可以调用 dsh_workplan_verify 核验（前几步调用会因缺少前几步证据返回 PHASE_GATE；非必调，交卷前勿为它重复输出大段 JSON）；逐条验证并附证据（无法确认写 "unverified"，未全通过不得 done）；checks 可省略（只写顶层 acceptance 的 A1/A2… 编号 + result + evidence，平台由顶层 acceptance 生成 checks 与 allPassed）。',
        '【第四步收尾 · 自我学习复盘（强制）】retrospective 四项缺一不可：problems（现象+根因）≥1、detours（无写 []）、resolutions ≥1、prevention（「遇到…先…」）≥1。',
        '【第五步 · JSON mode 结构化交付给本部门负责人】专家写 report（四数组）；负责人写 departmentSummary（sources 覆盖全部专家）。放 <!-- WORKPLAN_EVIDENCE:START --> 与 <!-- WORKPLAN_EVIDENCE:END --> 间合法 JSON。',
        '开工/结算闸：开工前随 startPhases 交第 1-3 步（缺/不合格硬拒 START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE）；有 phase-0 登记时收尾可省略 planning/preparation（平台自动并入，勿重抄），只交 execution/verification；收尾不得变薄（否则 EVIDENCE_INCOMPLETE）。',
        `硬下限：${START_EVIDENCE_MIN_CHARS_BRIEF}；复盘 problems≥${MIN_RETRO_PROBLEM_CHARS}、resolutions≥${MIN_RETRO_RESOLUTION_CHARS}、prevention≥${MIN_RETRO_PREVENTION_CHARS} 字。`,
        `硬上限：每清单 ≤${MAX_PHASE_LIST_ITEMS} 条、每条 ≤${MAX_PHASE_ITEM_CHARS} 字，四组合计 ≤${MAX_PHASE_TOTAL_CHARS} 字。`,
    ];
}
export function fiveStepContinuationPromptLines() {
    return [
        '五步工作法（phase-1 接续：前三步已在 phase-0 登记，不要重做，直接做第四、第五步）：',
        '【第四步 · 执行与验证】按已登记方案执行（steps/deviations；含 approachBasis 对应检查）；逐条验证附证据，未通过不得 done（无法确认写 "unverified"）；只写顶层 acceptance（A1/A2… 编号 + result + evidence）即可，verification.checks/allPassed 由平台生成；dsh_workplan_verify 非必需，勿为它重复输出整份 JSON。收尾必填 retrospective（problems/detours/resolutions/prevention，零异常可写 {"noIssues":true}）。',
        '【第五步 · JSON mode 交付】专家交 report、负责人交 departmentSummary，放 <!-- WORKPLAN_EVIDENCE:START --> 与 END 间合法 JSON。',
        '结算闸：收尾可省略 phases.planning 与 phases.preparation（平台自动并入 phase-0 登记原文），只交 execution/verification；遇阻用 dsh_workplan_escalate；缺开工证据硬拒 START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE。',
    ];
}
/**
 * 开工证据校验（dispatch / review / self_effort / direct 四个开工闸同一判据）。
 * 纯函数：工具层与测试同口径消费，门禁不能被提示词绕过。
 */
export function validateStartPhaseEvidence(value) {
    if (!isRecord(value)) {
        return {
            ok: false,
            code: 'START_EVIDENCE_MISSING',
            error: '开工证据缺失：执行自己的任务必须先完成五步前三步——第一步全面、全盘、深入梳理、研究、思考自己的任务；第二步基于第一步全部结果研究资源、工具与具体实施方案（方法、流程、步骤，含依据）；第三步把资源与工具真正备齐并给出就绪证据——然后随开工工具提交 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }。未提交或不合格会被硬拒，不登记、不接续正式执行。',
            evidence: null,
        };
    }
    const errors = [];
    const planningRaw = isRecord(value.planning) ? value.planning : null;
    if (!planningRaw)
        errors.push('startPhases.planning 缺失（第一步 · 任务梳理 + 第二步 · 资源/工具/实施方案研究）');
    const preparationRaw = isRecord(value.preparation) ? value.preparation : null;
    if (!preparationRaw)
        errors.push('startPhases.preparation 缺失（第三步 · 准备：把资源、工具、实施方案真正备齐并给出就绪证据）');
    const planning = parsePlanningPhase(planningRaw, errors, !!planningRaw);
    const preparation = parsePreparationPhase(preparationRaw, errors, !!preparationRaw);
    const prefix = (field) => field.replace(/^phases\./, 'startPhases.');
    const renamed = errors.map((item) => prefix(item));
    if (renamed.length > 0) {
        return { ok: false, code: 'START_EVIDENCE_INCOMPLETE', error: renamed.join('；'), evidence: null };
    }
    return { ok: true, evidence: { planning, preparation } };
}
/**
 * 回放侧消毒（写入与消费双侧同一判据）：durable 日志里的开工证据重新过一遍
 * 校验，非法/被篡改 ⇒ null（门禁要求重新提交），合法 ⇒ 归一化后的证据。
 * 旧日志无该字段 ⇒ undefined 进、null 出，零迁移不报错。
 */
export function sanitizeStartPhaseEvidence(value) {
    const check = validateStartPhaseEvidence(value);
    return check.ok ? check.evidence : null;
}
/**
 * [3.0.8] 开工-结算一致性比对：结算时的 phases 不允许比开工登记的证据变薄。
 *
 * 机制动机：开工闸登记的第 1/2/3 步证据与结果块里的 phases.planning/preparation
 * 是同一份内容的两处载体；若无比对，执行者可以开工时写一套、收尾时另写一套
 * （甚至把薄的换成厚的、把厚的换成薄的）。规则（宽容新增、禁止变薄）：
 * 对开工登记过的每一个清单字段，结算对应清单的条数与合计字符数都必须
 * ≥ 开工登记值；违反即返回可读的违规描述（结算闸据此退回）。
 */
export function checkStartEvidenceCarryover(registered, settlement) {
    const violations = [];
    if (!isRecord(settlement)) {
        return ['结果块缺少 phases 对象，无法与开工登记的第 1/2/3 步证据比对'];
    }
    const groups = [
        {
            key: 'planning',
            label: '第 1/2 步（任务梳理 + 资源/工具/方案研究）',
            fields: [
                ['problemAnalysis', '任务梳理'],
                ['approach', '方法流程步骤'],
                ['approachBasis', '第二步依据'],
                ['resources', '资源研究'],
                ['tools', '工具研究'],
            ],
        },
        {
            key: 'preparation',
            label: '第 3 步（准备）',
            fields: [
                ['prepared', '已备清单'],
                ['evidence', '就绪证据'],
            ],
        },
    ];
    for (const group of groups) {
        const registeredGroup = registered[group.key] ?? {};
        const settlementGroup = isRecord(settlement[group.key]) ? settlement[group.key] : null;
        for (const [field, label] of group.fields) {
            const want = Array.isArray(registeredGroup[field]) ? registeredGroup[field] : [];
            if (want.length === 0)
                continue;
            const got = settlementGroup && Array.isArray(settlementGroup[field])
                ? settlementGroup[field].filter((item) => typeof item === 'string' && item.trim())
                : [];
            const wantChars = totalChars(want);
            const gotChars = totalChars(got);
            if (got.length < want.length || gotChars < wantChars) {
                violations.push(`${group.label}的${label}变薄：开工登记 ${want.length} 条/${wantChars} 字，结算仅 ${got.length} 条/${gotChars} 字——收尾证据不得稀释开工时登记的第 1/2/3 步证据（可在执行中补充完善，不得减少）`);
            }
        }
    }
    return violations;
}
/**
 * [3.1.1] 结算自动归并（治本：跨会话登记的登记原文不进交卷人上下文）。
 *
 * 缺陷现场（2026-11-19，T2/T3）：部门负责人在自己的会话经 action="direct" 代登记
 * 开工证据（8 条/1242 字），平台另开全新执行子会话跑 phase-1——接续提示只转述
 * 「已登记」这个事实，登记的逐字原文从未进入执行者视野；执行者交卷时凭任务书
 * 重写一份更短的摘要（6 条/471 字），被结算闸开工-结算一致性比对退回
 * （EVIDENCE_INCOMPLETE）。执行者重试时自述 "I don't have the exact startPhases
 * text"，只能靠退回消息里的数字凑字数过闸——比对的数据源错了对象。
 *
 * 归并规则：登记内容是任务的 durable 事实，不因交卷人未复述而减少。对开工登记
 * 过的每个清单字段，取「交卷条目 ∪ 登记条目」的并集（交卷条目在前、登记条目
 * 按原序补入、逐字去重、每清单封顶 MAX_PHASE_LIST_ITEMS）后再比对并落账：
 *   - 执行者补充完善的内容全部保留（原「宽容新增」语义不变）；
 *   - 登记内容永不丢失（原「禁止变薄」语义由平台侧保证，不再依赖执行者自觉）；
 *   - 并集后条数/字数恒 ≥ 登记值，一致性比对恒过——比对仍保留作安全网
 *     （仅当封顶截断使登记条目装不下时才会真的退回，此时回喂通道已带登记原文）。
 *
 * 注意：validateFiveStepEvidence 的 MAX_PHASE_TOTAL_CHARS（6000 字）上限只约束
 * 交卷原文，不约束平台归并后的落账记录——登记原文本就是 durable 事实，归并
 * 只增不减，落账记录略超上限不影响任何下游消费（phaseSummaryLine 只数条数）。
 */
export function mergeStartEvidenceIntoSettlement(settlement, registered) {
    // 登记为 null/undefined（未登记、登记不合格被消毒丢弃、回放缺字段）时原样返回：
    // 调用点（plan.ts 结算链 / runtime.ts 回喂链）传的都是行级快照，可能缺字段。
    if (!registered || !registered.planning || !registered.preparation)
        return settlement;
    const mergeList = (settleItems, regItems) => {
        if (!Array.isArray(regItems) || regItems.length === 0)
            return settleItems;
        const base = Array.isArray(settleItems) ? settleItems : [];
        const seen = new Set(base.map((item) => String(item).trim()));
        const additions = regItems.filter((item) => !seen.has(String(item).trim()));
        return [...base, ...additions].slice(0, MAX_PHASE_LIST_ITEMS);
    };
    settlement.planning.problemAnalysis = mergeList(settlement.planning.problemAnalysis, registered.planning.problemAnalysis);
    settlement.planning.approach = mergeList(settlement.planning.approach, registered.planning.approach);
    settlement.planning.approachBasis = mergeList(settlement.planning.approachBasis, registered.planning.approachBasis);
    settlement.planning.resources = mergeList(settlement.planning.resources, registered.planning.resources);
    settlement.planning.tools = mergeList(settlement.planning.tools, registered.planning.tools);
    settlement.preparation.prepared = mergeList(settlement.preparation.prepared, registered.preparation.prepared);
    settlement.preparation.evidence = mergeList(settlement.preparation.evidence, registered.preparation.evidence);
    return settlement;
}
/**
 * [3.1.1] 开工登记证据的逐字渲染块：回注给交卷人（phase-1 接续提示 /
 * EVIDENCE_INCOMPLETE 回喂消息），让执行者照抄登记原文而不是凭记忆重写。
 * 登记内容经 sanitizeStartPhaseEvidence 消毒后传入，此处只做展示级截断（每条
 * 800 字与校验器上限同源），不再二次校验。
 */
export function renderStartPhaseEvidence(registered) {
    if (!registered || !registered.planning || !registered.preparation)
        return '';
    const lines = [];
    const push = (label, items) => {
        if (!Array.isArray(items) || items.length === 0)
            return;
        lines.push(`${label}：`);
        items.forEach((item, index) => {
            lines.push(`  ${index + 1}. ${String(item).slice(0, MAX_PHASE_ITEM_CHARS)}`);
        });
    };
    push('第一步·任务梳理 problemAnalysis', registered.planning.problemAnalysis);
    push('第二步·资源研究 resources', registered.planning.resources);
    push('第二步·工具研究 tools', registered.planning.tools);
    push('第二步·方法流程步骤 approach（执行蓝图，严格照做）', registered.planning.approach);
    push('第二步·依据 approachBasis', registered.planning.approachBasis);
    push('第三步·已备清单 prepared', registered.preparation.prepared);
    push('第三步·就绪证据 evidence', registered.preparation.evidence);
    return lines.join('\n');
}
/**
 * [3.1.7] 接续用的「执行蓝图」：只保留真正指导执行的两段（approach / approachBasis）。
 *
 * 其余登记清单（任务梳理、资源、工具、已备、就绪证据）是**审计链**，不该在每次
 * 接续时把全文再贴一遍——完整原文随接续一起落盘，需要逐字核对时读文件。
 * 这样既不会丢任何证据（文件里是原文），又只在提示词里为「必须照做」的部分付费。
 */
export function renderStartEvidenceBlueprint(registered) {
    if (!registered || !registered.planning)
        return '';
    const lines = [];
    const push = (label, items) => {
        if (!Array.isArray(items) || items.length === 0)
            return;
        lines.push(`${label}：`);
        items.forEach((item, index) => {
            lines.push(`  ${index + 1}. ${String(item).slice(0, MAX_PHASE_ITEM_CHARS)}`);
        });
    };
    push('第二步·方法流程步骤 approach（执行蓝图，严格照做）', registered.planning.approach);
    push('第二步·依据 approachBasis', registered.planning.approachBasis);
    return lines.join('\n');
}
/** [3.1.7] 其余登记清单的规模索引（只报条数与字数，不重复正文）。 */
export function startEvidenceIndexLines(registered) {
    if (!registered)
        return [];
    const rows = [
        ['第一步·任务梳理 problemAnalysis', registered.planning?.problemAnalysis ?? []],
        ['第二步·资源研究 resources', registered.planning?.resources ?? []],
        ['第二步·工具研究 tools', registered.planning?.tools ?? []],
        ['第三步·已备清单 prepared', registered.preparation?.prepared ?? []],
        ['第三步·就绪证据 evidence', registered.preparation?.evidence ?? []],
    ];
    return rows
        .filter(([, items]) => Array.isArray(items) && items.length > 0)
        .map(([label, items]) => `${label}：${items.length} 条 / ${items.reduce((sum, item) => sum + String(item).length, 0)} 字`);
}
