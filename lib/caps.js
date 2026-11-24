/**
 * [3.1.0] 数量上限的单一真源（ caps = capability caps ）。
 *
 * 为什么要有这个模块：
 *  - 复杂任务分工表人数上限（12 → 25，用户裁决 2026-11-19）与部门汇总 sources
 *    上限（16 → 30）此前分散硬编码在 llm-rules / v3-contract / plan.ts 的存档
 *    消毒里，历史上发生过「改一处漏一处」：3.0.6 的部门汇总死锁（人数 12 但
 *    sources 卡 6）、以及「写 25 读 12」的存读不对称。收口到本模块后，
 *    所有消费方 import 同一常量，物理上不可能再分叉。
 *  - llm-rules.ts 依赖 plan.ts（历史既有），plan.ts 不能反向 import llm-rules，
 *    因此把上限放在这个零依赖叶子模块里，两边都能安全引用，无循环风险。
 *
 * 环境变量（全部可选，默认即用户裁决值，不设则行为与 3.1.0 默认完全一致）：
 *  - DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS：复杂任务专家人数上限，默认 25
 *    （仍强制 ≥ MIN_COMPLEX_DELEGATE_MEMBERS，防止把上限配得比下限低）。
 *  - DSH_WORKPLAN_MAX_SOURCES_ITEMS：部门汇总 sources 条数上限，默认 30
 *    （必须 ≥ 专家人数上限，否则「逐人覆盖」硬要求与条数上限互相矛盾——
 *    3.0.6 死锁的复发条件，故默认值取 25+余量）。
 */
/**
 * [3.2.6][省钱 A 档] 负责人预登记开关（3.2.6 起**默认开**）。
 *
 * 打开后：部门负责人可在分工表每个成员条目里随附 `startPhases`（五步第 1/2/3 步
 * 证据）与 `timeNotice`（开工前预估）；平台替成员登记这两项，成员**免跑 phase-0
 * 评估回合**、直接以分工表档进入执行——每个专家省掉整整一次会话。
 *
 * 为什么默认开：旧默认关，于是每个专家都要先开一个只写开工证据、不产交付物的
 * 评估会话，再另起执行会话。实测（wp-2b766146，2026-11-24）：7 名专家第一波
 * 各跑 7–17 步纯评估（合计 64 步），且这批评估会话在被判「假死」后又被替换成
 * 9 个新会话重跑 393 步。证据内容完全由负责人掌握的计划信息决定，专家单独开
 * 一个会话来「想」一遍既贵又容易与负责人施工图不一致。
 *
 * 关掉它的方式：`DSH_WORKPLAN_LEADER_PRE_REGISTER=0`（或 off/false）。
 * 语义仍 fail-open：负责人没填、填了非法值 ⇒ 该成员照旧走 phase-0，不新增拒因。
 */
export function leaderPreRegisterEnabled() {
    const raw = String(process.env.DSH_WORKPLAN_LEADER_PRE_REGISTER ?? '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off')
        return false;
    return true;
}
export function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim() === '')
        return fallback;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
/**
 * 复杂任务（声明档 medium/high/xhigh/max）分工表人数下限。
 * [3.2.6][省钱] 2026-11-24 用户裁决：8 → 3。
 *
 * 为什么降：旧下限 8 意味着「只要判成复杂，就必须至少开 8 个独立子代理会话」。
 * 实测（session-da5b9915，2026-11-24 18:23–19:22）：32 个会话 / 846 步里，
 * 单个 T3 子任务因强制下限拉起了 18 个会话、541 步（占 64%）、143MB 重发
 * （占 65%）。下限本身不产生任何额外产出，只产生额外会话——「人多」不等于
 * 「活好」，而每个会话都是独立上下文、独立系统提示、独立摸底。
 *
 * 仍可用环境变量 `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS` 覆盖（下限 1）。
 * 另外：单阶段计划（stages.length === 1）不适用本下限——「可并行拆分」的
 * 人数下限对单阶段任务只会制造无解死锁，豁免逻辑在 llm-rules 人数闸。
 */
export const MIN_COMPLEX_DELEGATE_MEMBERS = Math.max(1, envPositiveInt('DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS', 3));
/**
 * [3.2.4][O6] 全计划专家总数上限（[3.2.6] 40 → 30）。
 * MAX_SUBTASKS(15) × 单任务人数上限 = 数百名专家 ⇒ 约上千个 LLM 回合，
 * 没有任何全局闸时单个失控计划就能烧穿预算。
 * 取 30 而不是更低，是为避免制造死锁：上限之间必须自洽——若把总上限压到 12，
 * 则「5 阶段 × 每阶段 3 人 = 15」这种完全正常的计划会被整单拒绝，而这正是
 * 3.0.6「部门汇总死锁」（人数 12 但 sources 卡 6）同一类错误。40 → 30 只削掉
 * 最失控的一档，不改变正常计划的可行域。
 * 环境变量 `DSH_WORKPLAN_MAX_TOTAL_EXPERTS_PER_PLAN` 可调；超出即整单拒绝。
 */
export const MAX_TOTAL_EXPERTS_PER_PLAN = envPositiveInt('DSH_WORKPLAN_MAX_TOTAL_EXPERTS_PER_PLAN', 30);
/**
 * 复杂任务分工表人数上限（保持 25 不变）。
 *
 * [3.2.6] 只降下限、不动上限的理由：真正制造费用的不是「允许的上限」，而是
 * 「强制的最低人数」——下限 8 会把每一个复杂任务都变成 8 个独立会话，而上限 25
 * 只在负责人主动要多人才生效。降上限会直接拒收原本合法的 7–25 人分工表
 * （把「允许」变成「禁止」），属于另一种形式的破坏；因此本项维持 25。
 */
export const MAX_COMPLEX_DELEGATE_MEMBERS = Math.max(MIN_COMPLEX_DELEGATE_MEMBERS, envPositiveInt('DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS', 25));
/**
 * 部门汇总 sources（「覆盖的专家汇报」）条数上限：3.0.6 为修复 12 人死锁放宽到
 * 16；3.1.0 随专家上限 25 同步放宽到 30（25 + 非专家来源余量 5）。覆盖是诚实
 * 硬要求——本条数必须 ≥ 专家人数上限，否则部门永远交不出合法汇总（死锁）。
 */
export const MAX_SOURCES_ITEMS = envPositiveInt('DSH_WORKPLAN_MAX_SOURCES_ITEMS', 30);
