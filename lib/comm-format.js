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
 *    由三阶段门禁与人工复核兜底，这里不自动判）；
 *  - 规范是纯数据，可序列化进提示词，也可独立校验，版本号随内容变更递增；
 *  - 与既有门禁正交：解析失败、验收缺口、三阶段缺失仍由原门禁先拦，
 *    本门禁只负责把「其它门禁都过了、但格式仍不合规」的 done 退回。
 */
/** 格式规范版本，随规范内容变更递增。 */
export const COMM_FORMAT_VERSION = 1;
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
            description: '必须包含三阶段证据：phases.planning（问题分析与可执行思路）、phases.execution（实际执行步骤）、phases.verification（逐项验证）',
            rationale: '三阶段是质量闭环的基础，缺任一阶段等于跳过对应质控环节' }),
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
 */
export function checkCommFormatCompliance(parsed, rawOutput, expectedAcceptanceCount) {
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
    // F3: 三阶段证据齐全
    const phases = parsed.phases;
    if (!phases || typeof phases !== 'object') {
        violations.push({ ruleId: 'F3', category: 'phases',
            message: '缺少 phases 对象：planning / execution / verification 三阶段证据全部缺失' });
    }
    else {
        const missing = [];
        if (!phases.planning || typeof phases.planning !== 'object')
            missing.push('planning（问题分析与思路）');
        if (!phases.execution || typeof phases.execution !== 'object')
            missing.push('execution（实际执行步骤）');
        if (!phases.verification || typeof phases.verification !== 'object')
            missing.push('verification（逐项验证与复盘）');
        if (missing.length > 0) {
            violations.push({ ruleId: 'F3', category: 'phases', message: `三阶段证据缺失：${missing.join('、')}` });
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
    return { compliant: violations.length === 0, violations, version: COMM_FORMAT_VERSION };
}
/**
 * 把格式规范渲染为嵌入子 Agent 提示词的文本。
 * 这是「派发工作时附带统一沟通交流格式要求」的具体实现。
 */
export function renderCommFormatSpec() {
    const lines = [
        '沟通交流格式规范（v' + String(COMM_FORMAT_VERSION) + '，主 Agent 与部门人员双方认可的结果格式契约）：',
    ];
    for (const req of COMM_FORMAT_SPEC.requirements) {
        lines.push(`- 【${req.id}】${req.description}`);
    }
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
