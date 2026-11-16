/**
 * [3.0.1] 认可闸门（approval gate）——「未经用户认可不得派发」的底层机制修复。
 *
 * 事故复盘（2026-11-15，wp-e745a477）：用户明确要求「有疑问先问用户、经认可后
 * 再开始执行」，主 Agent 也确在提问；但计划一生成，autoDispatch 默认 true 仍
 * 把第一个子任务派了出去。子 Agent 缺产品背景、够不到用户，只能升级待指示，
 * 子会话随后失联（NO_CHILD），instruct/update/dispatch 三条出口全部堵死，
 * 整盘计划只能人工取消。
 *
 * 本模块钉住第一根因：任务锚点文本里凡是「先经用户认可/批准/确认再执行」的
 * 明确门槛语，计划照出、但按住不派（等价于该计划的 plan-first），直到用户
 * 明确认可、主 Agent 调用 dsh_workplan_release 解除闸门。
 *
 * 关闭方式（保留给自动化场景）：DSH_WORKPLAN_APPROVAL_GATE=0/false/off
 * 只关「关键词识别」这一半；主 Agent 显式闸门（dsh_workplan_hold）不受影响。
 */
import { PlanError } from './plan.js';
/**
 * 认可门槛语规则表。每条都是「批准类动词 + （再|才）+ 开始执行类动词」的
 * 明确组合，宁可漏判（回落到默认自动派发）也不误判（把普通任务按住），
 * 因为误判的成本是每次执行多一次手动放行，漏判的成本才是事故复发。
 */
const APPROVAL_PATTERNS = [
    {
        re: /经[^。；！？\n]{0,10}?认可[^。；！？\n]{0,10}?(再|才)/,
        label: '「经（您/用户）认可后再……」',
    },
    {
        re: /(得到|获得|征得|收到|拿到)[^。；！？\n]{0,10}?(您|用户)?[^。；！？\n]{0,6}?(认可|批准|同意|确认|答复|回复|首肯)[^。；！？\n]{0,10}?(后|再|才)/,
        label: '「得到您认可后再……」',
    },
    {
        re: /(确认|批准|同意|拍板|审阅|答复|回复|首肯)好?(之后|以后|后)[^。；！？\n]{0,6}?(再|才|然后)(开始|执行|动手|做)/,
        label: '「确认后再开始执行」',
    },
    {
        re: /(先|务必先|必须先)[^。；！？\n]{0,8}?(问|询问|请示|向您确认|向您请示|和您确认|跟您确认)[^。；！？\n]{0,4}?(用户|您|我)/,
        label: '「（有疑）先问用户/您」',
    },
    {
        re: /(有疑问|任何疑问|存在疑问|不确定|不清楚)[^。；！？\n]{0,12}?(问|询问|请示|确认)[^。；！？\n]{0,6}?(用户|您)/,
        label: '「有疑问先问用户」',
    },
    {
        re: /(等待|待)[^。；！？\n]{0,4}?(用户|您)[^。；！？\n]{0,10}?(确认|批准|认可|答复|回复|审阅|同意|拍板)/,
        label: '「等待用户确认/批准」',
    },
    {
        re: /(未经|未获得|未得到|没有得到|缺少)[^。；！？\n]{0,8}?(您|用户)?[^。；！？\n]{0,4}?(认可|批准|同意|确认)[^。；！？\n]{0,10}?(不要|不得|禁止|不能|勿|别|不可)/,
        label: '「未经认可不得开始执行」',
    },
    {
        re: /(认可|批准|同意|确认|审阅)[^。；！？\n]{0,4}?后[^。；！？\n]{0,8}?(开始执行|再执行|才执行|开始正式执行|再开始|才开始)/,
        label: '「认可后开始执行」',
    },
];
function excerptOf(text, match, max = 60) {
    const start = Math.max(0, match.index - 6);
    const end = Math.min(text.length, match.index + match[0].length + 10);
    const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return slice.length > max ? `${slice.slice(0, max)}…` : slice;
}
/**
 * 识别任务锚点文本里的「先经认可再执行」门槛语。
 * 纯函数、无副作用；空文本/纯寒暄在上游已被过滤，这里再兜底一次。
 */
export function detectApprovalGate(taskText) {
    const text = typeof taskText === 'string' ? taskText.trim() : '';
    if (!text)
        return { held: false, matched: [], reason: '' };
    const matched = [];
    for (const { re, label } of APPROVAL_PATTERNS) {
        const found = re.exec(text);
        if (found) {
            matched.push({ label, excerpt: excerptOf(text, found) });
            // 一条规则命中即可；继续跑完所有规则只为汇总证据，不去重（同义重复无害）。
        }
    }
    const held = matched.length > 0;
    return {
        held,
        matched,
        reason: held
            ? `任务锚点命中认可门槛语：${matched.map((item) => item.label).join('、')}`
            : '',
    };
}
/** [3.0.1] 关键词识别闸门的总开关：DSH_WORKPLAN_APPROVAL_GATE=0/false/off 关闭。 */
export function approvalGateDetectionDisabled() {
    const raw = String(process.env.DSH_WORKPLAN_APPROVAL_GATE ?? '').trim().toLowerCase();
    return raw === '0' || raw === 'false' || raw === 'off';
}
/**
 * 计划是否被认可闸门按住、不得派发。
 * 闸门一旦被 release 清空（dispatchHold=null），这里立即放行——
 * 释放动作本身由 dsh_workplan_release 登记 gateHistory 留痕，不赖在本字段上。
 */
export function isDispatchHeld(record) {
    const hold = record?.dispatchHold;
    return Boolean(hold && typeof hold === 'object' && (hold.kind === 'keyword' || hold.kind === 'manual'));
}
/**
 * [3.0.1] 死锁自愈：escalated 行子会话失联时的复活补丁。
 *
 * 旧行为：instruct 发现 childId 缺失或子会话已不在 spawnedChildIds 里，直接报
 * NO_CHILD / 投递失败——而 ESCALATION_OPEN 又禁止改判、dispatch 又被待指示行
 * 挡住，三条出口全堵，整盘计划只能人工取消（wp-e745a477 T1 实证）。
 *
 * 新行为：把该行从 escalated 复位为 pending，并把指示登记为 reviveInstruction；
 * 下一次 dispatch 走常规的 executeSubtask 路径重建全新子会话，提示词会把指示
 * 带给新子会话。状态迁移 escalated→pending 在 TRANSITIONS 里是合法边。
 *
 * 纯函数：只产出 applyStatus 补丁，不写任何状态，便于单测。
 */
export function buildChildRevivePatch(current, instruction, now) {
    const trimmed = String(instruction ?? '').trim();
    if (!trimmed)
        throw new PlanError('复活指示不能为空：请把要下发给子会话的决定原文传入 instruction。', 'INVALID_INSTRUCTION');
    const revision = Number(current?.revision ?? 0) + 1;
    return {
        patch: {
            status: 'pending',
            closure: 'pending',
            reviveInstruction: {
                text: trimmed,
                at: now,
                by: 'agent',
                reason: 'child-revive',
            },
            question: null,
            options: [],
            error: null,
            blockedKind: null,
            finishedAt: null,
            ackOverdue: false,
            ackedAt: null,
            // 旧失联子会话解绑；新子会话由 executeSubtask 激活时写回新的 childId。
            childId: null,
            revision,
            updatedBy: 'agent',
        },
        revision,
    };
}
