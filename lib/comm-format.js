/**
 * [2.1.0] 统一沟通交流格式规范与合规检查（用户 2026-11-06 的强制要求）。
 *
 * 机制闭环：
 *  1. 主 Agent 派发子任务时，在提示词里附带本模块渲染的《沟通交流格式规范》
 *     （renderCommFormatSpec），作为双方认可的唯一结果格式契约；
 *  2. 部门人员提交结果前，必须逐条对照规范自查（提示词中有强制自查指令）；
 *  3. 主 Agent 收到结果后，由 adjudicateResult 用 checkCommFormatCompliance
 *     按同一份规范逐条核验；不合规即判定 blocked/comm-format，把
 *     renderCommFormatRejection 生成的退回通知随下一次激活发回，
 *     通知部门人员重新检查格式后重交。
 *
 * 设计约束：
 *  - 本模块只做「格式/结构」核验，不做语义真伪判断（F9 为提示词级诚信约束，
 *    由五步证据门禁与人工复核兜底，这里不自动判）；
 *  - 规范是纯数据，可序列化进提示词，也可独立校验，版本号随内容变更递增；
 *  - 与既有门禁正交：解析失败、验收缺口、五步证据缺失仍由原门禁先拦，
 *    本门禁只负责把「其它门禁都过了、但格式仍不合规」的 done 退回。
 */
import { checkDepartmentSummary, checkExpertReport, MAX_SOURCES_ITEMS, renderDepartmentSummarySpec, renderExpertReportSpec, } from './v3-contract.js';
/**
 * 格式规范版本，随规范内容变更递增。
 *
 * [3.0.0] 1 → 2：用户 2026-11-14 第 7、10 条要求为结果格式增加了两条
 * 结构化精简契约（F10 专家 JSON 汇报、F11 部门 JSON 汇总）。F1–F9 的
 * 文本与判据一字未改（只增不改），新增条目由调用方按接收者层级开关：
 * 专家结果查 F10，部门负责人结果查 F11，未声明层级时两条都不查
 * （历史回放与其它调用点零回归）。
 */
export const COMM_FORMAT_VERSION = 3;
/**
 * 统一沟通交流格式规范定义（F1-F9，冻结不可变）。
 */
export const COMM_FORMAT_SPEC = Object.freeze({
    version: COMM_FORMAT_VERSION,
    name: 'dsh-workplan 沟通交流格式规范',
    requirements: Object.freeze([
        Object.freeze({ id: 'F1', category: 'structure',
            description: '结果必须包含结构化证据块：以 <!-- WORKPLAN_EVIDENCE:START --> 开头、<!-- WORKPLAN_EVIDENCE:END --> 结尾，且两块标记成对出现',
            rationale: '没有标记块，主 Agent 无法定位与解析结果，交付门禁无从启动' }),
        Object.freeze({ id: 'F2', category: 'structure',
            description: '证据块必须是合法 JSON 对象，顶层必须含 status 字段，取值只能是 done / blocked / partial',
            rationale: 'status 是交付门禁的入口条件，缺失或非法则无法判定完成与否' }),
        Object.freeze({ id: 'F3', category: 'phases',
            description: '必须包含五步工作法证据：phases.planning（第一步问题梳理 problemAnalysis + 第二步资源 resources / 工具 tools / 方法流程步骤 approach / 依据 approachBasis）、phases.preparation（第三步准备与就绪证据）、phases.execution（第四步实际执行步骤）、phases.verification（第四步逐项验证与复盘）；第五步交付由 F10/F11 的 report / departmentSummary 承载',
            rationale: '五步是质量闭环的基础，缺任一步等于跳过对应质控环节' }),
        Object.freeze({ id: 'F4', category: 'acceptance',
            description: '验收结果必须逐条回应计划的验收标准（A1、A2…），且每条 result=pass 必须附带具体证据（命令输出/文件路径/引用），禁止空证据 pass',
            rationale: '空证据 pass 是自述而非验证，交付门禁只认可证据' }),
        Object.freeze({ id: 'F5', category: 'acceptance',
            description: '验收回应的条数不得少于计划定义的验收标准条数',
            rationale: '少回应一条等于该条验收未做，交付门禁会判为未完成' }),
        Object.freeze({ id: 'F6', category: 'artifacts',
            description: 'artifacts 声明清单中每一项都必须是合法条目：kind 只能取 file / url / note，且 ref 非空；不允许空条目或占位条目',
            rationale: '主 Agent 按 ref 核验交付物；非法条目让核验无从执行。是否必须交付文件由计划验收标准决定，不由本条决定' }),
        Object.freeze({ id: 'F7', category: 'retrospective',
            description: 'phases.verification.retrospective 复盘必须完整：problems、resolutions、prevention 均至少 1 条（detours 没有可写空数组）',
            rationale: '复盘是自我学习闭环的入口，缺失则教训无法写入永久记忆' }),
        Object.freeze({ id: 'F8', category: 'blocked',
            description: '若 status 为 blocked，必须附非空 question 字段写清受阻原因（卡在哪一步、已尝试什么、需要谁决定什么）',
            rationale: '受阻无原因等于主 Agent 不知道卡在哪里，无法给出指示或转派' }),
        Object.freeze({ id: 'F9', category: 'integrity',
            description: '不得编造、虚构或伪造任何证据、文件路径、命令输出或验收结果；无法确认的项目必须写 unverified',
            rationale: '虚假证据一旦通过交付门禁，用户拿到的就是不可信的成品' }),
        /*
         * [3.0.0] F10/F11：用户 2026-11-14 第 7、10 条要求。F1–F9 是 2.1.0 起的
         * 冻结条目，本次只增不改；两条新条目按接收者层级启用（见 check 的 tier）。
         */
        Object.freeze({ id: 'F10', category: 'report',
            description: '专家（第三层执行者）结果必须包含 report 对象，只允许 keyResults/keyInfo/importantInfo/leadRequirements 四个字符串数组字段：keyResults / leadRequirements 各至少 1 条非空内容，keyInfo / importantInfo 可为空数组但字段必须存在，每数组最多 6 条、每条最多 200 字符，内部与跨字段不得出现重复表述',
            rationale: '用户要求 7：专家成果必须非常精简地汇报给部门负责人，只要关键信息、关键成果、重要信息和负责人要求的东西，并以 JSON mode 结构化输出' }),
        Object.freeze({ id: 'F11', category: 'report',
            description: `部门负责人结果必须包含 departmentSummary 对象，只允许 keyResults/keyInfo/importantInfo/sources 四个字符串数组字段，keyResults 至少 1 条非空，keyResults/keyInfo/importantInfo 每项最多 6 条、每条最多 200 字符；sources 最多 ${MAX_SOURCES_ITEMS} 条且必须逐人覆盖本部门全部已派发专家，内部与跨字段不得出现重复表述`,
            rationale: '用户要求 8/10/11：部门负责人必须全面汇总全部专家汇报，汇总报告必须精简、禁止累赘重复，并以 JSON mode 结构化直接交回主 Agent' }),
    ]),
    /*
     * [2.2.0][T3/O-2c] 结果块可选字段（方案 §2.4：「模板增加 timeSpentMinutes、
     * finalEstimateMinutes 字段」；方案 §2.5：「时间字段纯 advisory：不参与可
     * 交付判定，不加拒绝码」）。
     *
     * 纯增量：不属于 F1-F9 门禁条目（requirements 冻结不动、版本号不升），
     * 缺失或不合法一律不判不合规——仅供用时回填与协商审计，adjudicateResult
     * 以 readAdvisoryMinutes 透传。
     */
    optionalFields: Object.freeze([
        Object.freeze({ name: 'timeSpentMinutes', type: 'integer', unit: '分钟', required: false,
            description: '实际耗时回填（完成即回报时如实填写；未知可省略）',
            semantics: 'advisory：不参与可交付判定，缺失/非法不判不合规' }),
        Object.freeze({ name: 'finalEstimateMinutes', type: 'integer', unit: '分钟', required: false,
            description: '最终预估回填（与开工前预告不一致时以此为准，用于协商审计）',
            semantics: 'advisory：不参与可交付判定，缺失/非法不判不合规' }),
    ]),
});
/**
 * 对子 Agent 的证据块执行沟通交流格式合规检查（F1-F8 自动核验；F9 为诚信约束不自动判）。
 *
 * @param parsed - 已解析的证据块 payload（parseEvidenceBlock 的 payload，可为 null）
 * @param rawOutput - 子 Agent 原始输出全文
 * @param expectedAcceptanceCount - 计划定义的验收标准条数
 * @param options.tier - 接收者层级：'expert' 追加 F10（专家 JSON 汇报），
 *        'leader' 追加 F11（部门 JSON 汇总）；省略则两条都不查（历史回放、
 *        旧调用点零回归）
 * @param options.expectedExperts - 本部门已派发的专家名单（F11 覆盖度核对用）
 */
export function checkCommFormatCompliance(parsed, rawOutput, expectedAcceptanceCount, options = {}) {
    const violations = [];
    const text = typeof rawOutput === 'string' ? rawOutput : '';
    // F1: 证据块标记必须成对出现（rescueEvidence 捞到的豁免——主 Agent 已能解析）
    if (!text.includes('WORKPLAN_EVIDENCE:START') || !text.includes('WORKPLAN_EVIDENCE:END')) {
        if (!parsed) {
            violations.push({ ruleId: 'F1', category: 'structure',
                message: '缺少 WORKPLAN_EVIDENCE:START/END 标记块，主 Agent 无法定位与解析结果' });
        }
    }
    if (!parsed || typeof parsed !== 'object') {
        if (violations.length === 0) {
            violations.push({ ruleId: 'F2', category: 'structure', message: '证据块无法解析为 JSON 对象' });
        }
        return { compliant: false, violations, version: COMM_FORMAT_VERSION };
    }
    // F2: status 必填且取值合法
    if (!['done', 'blocked', 'partial'].includes(String(parsed.status ?? ''))) {
        violations.push({ ruleId: 'F2', category: 'structure',
            message: `status 字段缺失或取值非法（"${String(parsed.status ?? '')}"），只能是 done / blocked / partial` });
    }
    // F3: 五步证据齐全（planning / preparation / execution / verification）
    const phases = parsed.phases;
    if (!phases || typeof phases !== 'object') {
        violations.push({ ruleId: 'F3', category: 'phases',
            message: '缺少 phases 对象：planning / preparation / execution / verification 证据全部缺失' });
    }
    else {
        const missing = [];
        if (!phases.planning || typeof phases.planning !== 'object')
            missing.push('planning（第一步问题梳理 + 第二步资源/工具/方案）');
        if (!phases.preparation || typeof phases.preparation !== 'object')
            missing.push('preparation（第三步准备与就绪证据）');
        if (!phases.execution || typeof phases.execution !== 'object')
            missing.push('execution（第四步实际执行步骤）');
        if (!phases.verification || typeof phases.verification !== 'object')
            missing.push('verification（第四步逐项验证与复盘）');
        if (missing.length > 0) {
            violations.push({ ruleId: 'F3', category: 'phases', message: `五步证据缺失：${missing.join('、')}` });
        }
    }
    // F4: pass 必须带证据
    const acceptance = Array.isArray(parsed.acceptance) ? parsed.acceptance : [];
    const emptyPass = [];
    for (const item of acceptance) {
        if (item && item.result === 'pass' && !String(item.evidence ?? '').trim()) {
            emptyPass.push(String(item.criterion ?? '（未命名验收项）'));
        }
    }
    if (emptyPass.length > 0) {
        violations.push({ ruleId: 'F4', category: 'acceptance',
            message: `以下验收项 result=pass 但未附证据：${emptyPass.slice(0, 5).join('、')}；pass 必须附命令输出/文件路径/引用` });
    }
    // F5: 验收条数不得少于计划定义
    if (expectedAcceptanceCount > 0 && acceptance.length < expectedAcceptanceCount) {
        violations.push({ ruleId: 'F5', category: 'acceptance',
            message: `验收回应仅 ${acceptance.length} 条，少于计划定义的 ${expectedAcceptanceCount} 条；须逐条回应 A1、A2…` });
    }
    // F6: 产物声明必须逐条合法（kind 枚举 + ref 非空）；是否必须交付文件由计划验收决定，不在此拦
    const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
    const badArtifacts = artifacts.filter((item) => !item || typeof item !== 'object'
        || !['file', 'url', 'note'].includes(String(item.kind ?? ''))
        || String(item.ref ?? '').trim() === '');
    if (badArtifacts.length > 0) {
        violations.push({ ruleId: 'F6', category: 'artifacts',
            message: `artifacts 有 ${badArtifacts.length} 条非法声明：每条必须 kind 取 file/url/note 且 ref 非空，不允许空条目` });
    }
    // F7: 复盘完整（problems/resolutions/prevention 均至少 1 条）
    const retro = phases?.verification?.retrospective;
    if (!retro || typeof retro !== 'object') {
        violations.push({ ruleId: 'F7', category: 'retrospective',
            message: '缺少 phases.verification.retrospective 复盘（problems / detours / resolutions / prevention）' });
    }
    else {
        const missingRetro = [];
        if (!Array.isArray(retro.problems) || retro.problems.length === 0)
            missingRetro.push('problems（遇到的问题，现象+根因）');
        if (!Array.isArray(retro.resolutions) || retro.resolutions.length === 0)
            missingRetro.push('resolutions（最终如何解决）');
        if (!Array.isArray(retro.prevention) || retro.prevention.length === 0)
            missingRetro.push('prevention（防再犯规则）');
        if (missingRetro.length > 0) {
            violations.push({ ruleId: 'F7', category: 'retrospective',
                message: `复盘不完整，缺少：${missingRetro.join('、')}，均至少 1 条` });
        }
    }
    // F8: blocked 必须附非空 question
    if (parsed.status === 'blocked' && !String(parsed.question ?? '').trim()) {
        violations.push({ ruleId: 'F8', category: 'blocked',
            message: 'status 为 blocked 但 question 为空：须写清卡在哪一步、已尝试什么、需要谁做什么决定' });
    }
    /*
     * F10/F11（用户 2026-11-14 第 7、10、11 条）：按接收者层级启用。
     * 只拦 done 路径——受阻结果已有更针对性的诊断（F8/五步证据），
     * 不再叠加精简性条目，避免一条 blocked 被反复退回在格式上。
     */
    if (options.tier === 'expert' && parsed.status === 'done') {
        const report = checkExpertReport(parsed.report);
        for (const item of report.violations) {
            violations.push({ ruleId: 'F10', category: 'report', message: item });
        }
    }
    if (options.tier === 'leader' && parsed.status === 'done') {
        const summary = checkDepartmentSummary(parsed.departmentSummary, options.expectedExperts ?? []);
        for (const item of summary.violations) {
            violations.push({ ruleId: 'F11', category: 'report', message: item });
        }
    }
    return { compliant: violations.length === 0, violations, version: COMM_FORMAT_VERSION };
}
/**
 * 把格式规范渲染为嵌入子 Agent 提示词的文本。
 * 这是「派发工作时附带统一沟通交流格式要求」的具体实现。
 *
 * @param tier - 接收者层级：'expert' 附带专家 JSON 汇报契约（F10），
 *        'leader' 附带部门 JSON 汇总契约（F11）；省略时两条都不带。
 */
export function renderCommFormatSpec(tier) {
    const lines = [
        '沟通交流格式规范（v' + String(COMM_FORMAT_VERSION) + '，主 Agent 与部门人员双方认可的结果格式契约）：',
    ];
    const scoped = tier === 'expert'
        ? COMM_FORMAT_SPEC.requirements.filter((req) => req.id !== 'F11')
        : tier === 'leader'
            ? COMM_FORMAT_SPEC.requirements.filter((req) => req.id !== 'F10')
            : COMM_FORMAT_SPEC.requirements;
    for (const req of scoped) {
        lines.push(`- 【${req.id}】${req.description}`);
    }
    if (tier === 'expert')
        lines.push('', renderExpertReportSpec());
    if (tier === 'leader')
        lines.push('', renderDepartmentSummarySpec());
    lines.push('不合规的后果：主 Agent 收到结果后按本规范逐条核验；任一不合规，结果立刻退回，你将收到列明不合规条目的退回通知，须全部修正后重新提交完整结果。');
    return lines.join('\n');
}
/**
 * 把合规检查结果渲染为退回通知文本（随下一次激活发回部门人员）。
 */
export function renderCommFormatRejection(result) {
    if (result.compliant)
        return '';
    const lines = [
        '结果退回：沟通交流格式不合规（规范 v' + String(result.version) + '）。',
        '你的结果未通过以下条目，请逐条修正、重新自查全部 F1-F9 后再提交完整结果（不要只修一条就重交）：',
    ];
    for (const v of result.violations) {
        lines.push(`- ${v.ruleId}：${v.message}`);
    }
    return lines.join('\n');
}
