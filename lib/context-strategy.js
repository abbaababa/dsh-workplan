/**
 * [3.2.9] 执行通道判定：子代理隔离 vs 主上下文压缩。
 *
 * 用户 2026-11-25 第 1 条：多轮推进且子任务真正独立时，优先用子代理隔离；
 * 单线程连续任务或决策高度耦合（例如跨来源矛盾裁决）时，强行拆成多个互相
 * 看不见的上下文反而会割裂视野，应在主上下文/负责人上下文内做智能压缩。
 *
 * 本模块只做**纯函数判定**，不 import 宿主服务，也不写任何状态：
 *  - 输入：任务文本、拟派人数、任务等级、是否单阶段；
 *  - 输出：lane（split / single-expert / leader-direct）、contextMode
 *    （isolate / compressed-main）、耦合信号与可直接注入提示词的一行说明。
 *
 * 硬门禁在 llm-rules.ts#planDelegations 消费同一判定；提示词只是把同一结论
 * 提前说清楚，代码与提示词不会出现两套口径。
 */
import { detectSequentialChainTask } from './v3-contract.js';
const CROSS_SOURCE = /(?:跨源|多源|多方|多个来源|来源之间|口径之间|相互矛盾|自相矛盾|彼此矛盾|跨来源|交叉核对|交叉验证|矛盾|冲突)[^。！？；\n]{0,60}(?:裁决|裁定|拍板|取舍|权衡|统一口径|最终结论|最终决定|定稿)|(?:裁决|裁定|拍板|取舍|权衡|统一口径)[^。！？；\n]{0,60}(?:矛盾|冲突|来源|口径)/i;
const SINGLE_DECISION = /(?:最终|统一|唯一|最后)[^。！？；\n]{0,12}(?:决定|结论|方案|口径|版本)|拍板|定稿|一锤定音/i;
const SHARED_MUTABLE = /(?:同一|共享|公共|同一份|同一个|同一批)[^。！？；\n]{0,16}(?:文件|配置|台账|数据集|目录|仓库|数据库)|并发写|同时写|写冲突|竞争写/i;
const SERIAL_DEPENDENCY = /(?:基于|根据|依赖|接续|继承)[^。！？；\n]{0,20}(?:上一步|前一步|上一条|上一阶段|上游)|先[^。！？；\n]{0,30}(?:再|然后|接着)|逐步|依次|按顺序|串行/i;
const INDEPENDENT_PARALLEL = /(?:分别|各自|独立|互不依赖|并行|多路|分头|同时开展|各写各的|互不影响)/gi;
const EXPLORATION_HEAVY = /(?:海量|大量|全量|逐个|遍历|扫描|检索|调研|收集|汇总|整理|核对全部|逐条|全库|全目录|全量读取)/i;
function textOf(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
function evidenceOf(text, regex) {
    const match = regex.exec(text);
    if (!match || typeof match[0] !== 'string')
        return '';
    return match[0].slice(0, 80);
}
function countIndependentHints(text) {
    let count = 0;
    INDEPENDENT_PARALLEL.lastIndex = 0;
    while (INDEPENDENT_PARALLEL.exec(text) !== null && count < 4)
        count += 1;
    return count;
}
/**
 * 评估任务文本的独立性。判定保守：只有出现明确耦合信号才降低独立度；
 * 只有出现明确并行/独立提示才提高独立度。无信号时按「未知」处理（不硬拆）。
 */
export function assessIndependence(taskText) {
    const text = textOf(taskText);
    if (text === '') {
        return {
            independent: false,
            couplingScore: 0,
            signals: [],
            explorationHeavy: false,
            reason: '任务文本为空，无法判定独立性；按单通道保守处理。',
        };
    }
    const signals = [];
    const chain = detectSequentialChainTask(text);
    if (chain.sequential) {
        signals.push({
            id: 'sequential-chain',
            label: '顺序推理链',
            weight: 3,
            evidence: chain.markers.slice(0, 3).join('、') || '先…再/逐步/基于上一步',
        });
    }
    const cross = evidenceOf(text, CROSS_SOURCE);
    if (cross) {
        signals.push({ id: 'cross-source-adjudication', label: '跨源矛盾裁决', weight: 3, evidence: cross });
    }
    const decision = evidenceOf(text, SINGLE_DECISION);
    if (decision) {
        signals.push({ id: 'single-decision', label: '单一最终决策', weight: 3, evidence: decision });
    }
    const shared = evidenceOf(text, SHARED_MUTABLE);
    if (shared) {
        signals.push({ id: 'shared-mutable-state', label: '共享可变状态', weight: 3, evidence: shared });
    }
    if (!chain.sequential) {
        const serial = evidenceOf(text, SERIAL_DEPENDENCY);
        if (serial) {
            signals.push({ id: 'serial-dependency', label: '串行依赖', weight: 1, evidence: serial });
        }
    }
    const independentHits = countIndependentHints(text);
    const explorationHeavy = EXPLORATION_HEAVY.test(text) || (text.length >= 240 && independentHits > 0);
    if (explorationHeavy) {
        signals.push({
            id: 'exploration-heavy',
            label: '探索/检索/汇总量大',
            weight: 0,
            evidence: '适合先派只读侦察并回传精炼简报',
        });
    }
    const tiny = text.length < 120 && signals.every((item) => item.weight <= 0);
    if (tiny) {
        signals.push({ id: 'tiny-scope', label: '极简单动作', weight: 1, evidence: '任务文本很短且无并行/耦合信号' });
    }
    if (independentHits > 0 && !chain.sequential && !cross) {
        signals.push({
            id: 'independent-parallel',
            label: '独立并行',
            weight: -Math.min(independentHits, 2) * 2,
            evidence: `命中 ${independentHits} 个并行/独立提示`,
        });
    }
    const rawScore = signals.reduce((sum, item) => sum + item.weight, 0);
    const couplingScore = Math.max(0, Math.min(10, rawScore));
    // 保守：只有出现明确的独立/并行负权重信号，才判定为「可拆」；无信号按未知处理。
    const independent = couplingScore < 3 && !chain.sequential && !cross && signals.some((item) => item.weight < 0);
    const reason = signals.length === 0
        ? '未命中明确耦合或独立信号；按单通道保守处理，不强行拆分。'
        : `信号：${signals.map((item) => `${item.label}(${item.weight >= 0 ? '+' : ''}${item.weight})`).join('、')}；耦合分 ${couplingScore}/10。`;
    return { independent, couplingScore, signals, explorationHeavy, reason };
}
/**
 * 决定执行通道。规则：
 *  - 强耦合（链式/跨源裁决/耦合分≥5）：负责人亲自执行（主上下文压缩）或只派 1 名专家；
 *  - 中等耦合（3–4）：只派 1 名专家，一次做完，中间结论写进同一份产物；
 *  - 独立（<3）：可拆分；探索量大时先派只读侦察，回传精炼简报；
 *  - 拟派人数 ≤1：single-expert（不为了凑人数硬拆）。
 */
export function decideDelegationStrategy(input = {}) {
    const text = textOf(input.taskText);
    const memberCount = Number.isFinite(Number(input.memberCount)) ? Math.max(0, Math.floor(Number(input.memberCount))) : 0;
    const taskEffort = typeof input.taskEffort === 'string' ? input.taskEffort : '';
    const assessment = assessIndependence(text);
    const strongCoupling = assessment.signals.some((item) => item.id === 'sequential-chain' || item.id === 'cross-source-adjudication');
    const independent = assessment.independent;
    const lowEffort = taskEffort === 'low';
    let maxMembers = assessment.couplingScore >= 3 || strongCoupling ? 1 : Math.max(1, memberCount);
    let lane;
    let contextMode;
    if (lowEffort) {
        // low/未配置档在平台规则里禁止下派；策略行必须先说 direct，不能先教拆分。
        lane = 'leader-direct';
        contextMode = 'compressed-main';
        maxMembers = 1;
    }
    else if (strongCoupling && (memberCount <= 1 || assessment.couplingScore >= 5)) {
        lane = 'leader-direct';
        contextMode = 'compressed-main';
    }
    else if (assessment.couplingScore >= 3) {
        lane = 'single-expert';
        contextMode = 'isolate';
    }
    else if (independent && memberCount > 1) {
        lane = 'split';
        contextMode = 'isolate';
    }
    else {
        lane = 'single-expert';
        contextMode = 'isolate';
    }
    let guidance;
    if (lowEffort) {
        guidance = '本任务为 low/未配置档，平台规则禁止下派：负责人亲自执行（action="direct"，按 low 登记 startPhases）；若 review 时自配为复杂档，再以实际整体档重新判断是否拆分。';
    }
    else if (lane === 'leader-direct') {
        guidance = '本任务高度耦合或单线程连续：不得拆给多名独立专家。由负责人亲自执行（action="direct"，按自评档登记 startPhases）并压缩中间过程，所有关键结论与精确值写进同一份产物。';
    }
    else if (lane === 'single-expert') {
        guidance = '本任务应单通道完成：只派 1 名专家一次做完，不要为凑人数拆成互相看不见的上下文；中间结论与精确值写进同一份产物。';
    }
    else {
        guidance = '任务可独立并行：按极简原则拆分给多名专家，每个专家只拿自己的任务书与角色上下文包。token 重的探索先派 1 名只读侦察专家，回传 ≤800 字且含精确引用/产物路径的简报，其他专家复用简报，不重复采集。';
    }
    const signalText = assessment.signals.length > 0
        ? assessment.signals.map((item) => item.label).join('、')
        : '无明确信号';
    const promptLine = `【上下文策略｜独立度${independent ? '高' : '低'}｜耦合分 ${assessment.couplingScore}/10｜信号：${signalText}】${guidance}`;
    return {
        lane,
        contextMode,
        independent,
        couplingScore: assessment.couplingScore,
        signals: assessment.signals,
        explorationHeavy: assessment.explorationHeavy,
        maxMembers,
        reason: assessment.reason,
        promptLine,
    };
}
/** 只渲染判定结论；不重复判定逻辑，避免提示词与门禁两套口径。 */
export function renderDelegationStrategyLine(strategy) {
    return strategy && typeof strategy.promptLine === 'string' ? strategy.promptLine : '';
}
