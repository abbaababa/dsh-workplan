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
 * 部门负责人、部门里相关领域的全球顶尖专家、部门里组员，分别在执行自己的
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
/** 三阶段顺序不可颠倒；这里也是结果块里 `phases` 的键名。 */
export const THREE_PHASE_IDS = Object.freeze(['planning', 'execution', 'verification']);
/** [2.5.1] 契约版本 2：规划阶段升级为两轮深度思考协议（新增必填 approachBasis）。 */
export const THREE_PHASE_VERSION = 2;
/**
 * 「全面、全盘、深入」无法由代码度量，但可以给一个不可忽略的下限：
 * 第一轮任务深研与第二轮方法、流程、步骤各至少 40 个字符，避免一个词就冒充
 * 规划；第二轮依据（approachBasis）至少 20 个字符，避免一句空话冒充依赖对应。
 */
export const MIN_PLANNING_PROBLEM_CHARS = 40;
export const MIN_PLANNING_APPROACH_CHARS = 40;
export const MIN_PLANNING_BASIS_CHARS = 20;
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
 * Same matching rules as `src/plan.ts#acceptanceCoverage` (Q6 / U-16):
 * stable A1…An numbering, exact full text, or a longer text containing the
 * full criterion. A partial copy must not count as coverage.
 *
 * Kept local to avoid importing plan.ts (which imports this module); the
 * rules are pinned by tests on both sides.
 */
function normaliseCriterion(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[\s，。；、,.;:：!！?？"'“”‘’()（）\[\]【】《》<>]/g, '')
        .replace(/^(必须|需要|应当|应该|请|务必)/, '');
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
            return row.includes(criterion);
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
            errors: ['phases 缺失：必须提交 planning / execution / verification 三阶段证据'],
            failedPhase: 'shape',
        };
    }
    const planningRaw = isRecord(value.planning) ? value.planning : null;
    if (!planningRaw)
        fail('planning', 'phases.planning 缺失（阶段一 · 两轮深度思考：先全面、全盘、深入梳理、研究、思考自己的任务，再基于其全部结果理清方法、流程、步骤）');
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
        execution,
        verification,
    };
    const total = [
        ...planning.problemAnalysis,
        ...planning.constraints,
        ...planning.unknowns,
        ...planning.approach,
        ...planning.approachBasis,
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
    return errors.some((item) => /^phases(\.| 缺失)/.test(item) && /planning|execution/.test(item))
        ? 'phase-1-2'
        : 'verification';
}
/** One-line, model-readable summary of what the three phases contain. */
export function phaseSummaryLine(phases) {
    const deviations = phases.execution.deviations.length;
    return [
        `阶段一 规划 · 两轮深度思考（第一轮任务深研 ${phases.planning.problemAnalysis.length} 条 / 第二轮方法流程步骤 ${phases.planning.approach.length} 步 / 第二轮依据 ${phases.planning.approachBasis.length} 条）`,
        `阶段二 执行（${phases.execution.steps.length} 步${deviations ? ` / 偏离 ${deviations} 处` : ''}）`,
        `阶段三 验证（${phases.verification.checks.length} 项${phases.verification.allPassed ? '，全部通过' : '，未全部通过'}；`
            + `复盘 ${phases.verification.retrospective.problems.length} 个问题 / `
            + `${phases.verification.retrospective.detours.length} 条弯路 / `
            + `${phases.verification.retrospective.prevention.length} 条防再犯规则）`,
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
        '三阶段工作法（用户强制要求；顺序不可颠倒，阶段一的两轮深度思考没有完成之前禁止动手执行）：',
        '【阶段一 · 规划阶段 = 两轮深度思考（部门负责人、全球顶尖专家、组员执行自己的任务时同一口径，顺序与依赖不可颠倒）】',
        '  第一轮 · 任务深研：先全面、全盘、深入梳理、研究、思考自己的任务——逐条写清任务目标与验收标准、现状与已知事实、约束条件、未知/待确认项、主要矛盾、工作边界与依赖，结果写入 phases.planning.problemAnalysis；',
        '  第二轮 · 理清方法流程步骤：基于刚才第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考，理清自己的思路，理清自己该具体如何一步步以最高效率执行、确保完美完成自己任务的方法、流程和步骤——每一步做什么、产出什么、依赖什么、风险与对策、如何证明做对了，并写清全程如何少走弯路（先查历史教训记忆、先验证再动手、不重复同样的试错），结果写入 phases.planning.approach；同时把第二轮如何基于第一轮全部结果写入 phases.planning.approachBasis（逐条对应：第一轮的哪些事实/约束/矛盾决定了第二轮的哪些方法/流程/步骤）；',
        '  自检：任何一条验收标准或用户原要求没有落在第二轮的方法、流程、步骤上，就回到第一轮重做；两轮深度思考没有完成并写全（problemAnalysis + approach + approachBasis）之前，不得进入阶段二。',
        '【阶段二 · 执行阶段】',
        '  最后，基于刚才第二轮理清楚的所有方法、流程、步骤，开始具体的执行工作：严格按 phases.planning.approach 执行。出现新事实需要偏离时，必须记录偏离原因、证据与调整后的做法，不得静默改道。',
        '【阶段三 · 验证阶段】',
        '  执行完成后逐条验证验收标准与用户原要求：每条都要有可复核的证据（命令输出/文件/引用）；验证未通过不得报 done，无法确认写 unverified。',
        '【阶段三收尾 · 自我学习复盘（强制）】',
        '  报 done 之前必须把 phases.verification.retrospective 写全，四项缺一不可：',
        '  1) problems：本次全过程遇到的所有问题（现象 + 根因），至少 1 条；',
        '  2) detours：走过的弯路、返工与无效尝试（确实没有就写空数组 []，不要编造）；',
        '  3) resolutions：最终是如何解决上述问题的，至少 1 条，可与 problems 一一对应；',
        '  4) prevention：以后如何预防再犯，至少 1 条，必须写成「遇到…先…」的可执行硬规则。',
        '  插件会在完成判定时复核这四项，并在通过后把复盘写入永久记忆文件；下次派发同类任务时，历史教训会自动出现在提示词里。',
        '插件使用说明（三阶段证据门禁）：',
        '  - 阶段一、二：先把两轮深度思考产物（第一轮任务深研 problemAnalysis、第二轮方法流程步骤 approach、第二轮依据 approachBasis）与执行记录写全；此时不要调用 dsh_workplan_verify，它会因缺少前两阶段证据返回 PHASE_GATE 与待补项（这是证据门禁，不是禁用插件）。',
        '  - 阶段三：可以调用 dsh_workplan_verify 让插件做最终核验：提交 planning / execution / verification 三阶段证据，插件返回 passed 或仍需补齐的 gaps；未通过先修复再回报。遇阻时可用 dsh_workplan_escalate 上报，它是安全通道，不属于三阶段产物。',
        '  - 结果块里的 phases 是必填项：缺任一阶段、内容为空、或验证未全部通过，插件都会判为未完成，不能用 done 收尾。',
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
            error: '两轮深度思考产物缺失：执行自己的任务必须先全面、全盘、深入梳理、研究、思考自己的任务（第一轮），再基于第一轮完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，理清具体如何一步步以最高效率、少走弯路、完美完成任务的方法、流程和步骤（第二轮），最后才按此执行。请随相应工具调用提交 deepThink={ problemAnalysis[]（第一轮任务深研）, approach[]（第二轮方法流程步骤）, approachBasis[]（第二轮基于第一轮全部结果的依据对应） }（主 Agent 经 dsh_workplan_dispatch，专家/组员经 self_effort）。',
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
