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
 *    （仍强制 ≥ MIN_COMPLEX_DELEGATE_MEMBERS=8，防止把上限配得比下限低）。
 *  - DSH_WORKPLAN_MAX_SOURCES_ITEMS：部门汇总 sources 条数上限，默认 30
 *    （必须 ≥ 专家人数上限，否则「逐人覆盖」硬要求与条数上限互相矛盾——
 *    3.0.6 死锁的复发条件，故默认值取 25+余量）。
 */
/** 读取正整数环境变量；缺失/非正整数/NaN 一律回落默认值（fail-closed 到裁决值）。 */
export function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim() === '')
        return fallback;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
/**
 * 复杂任务（声明档 medium/high/xhigh/max）分工表人数下限：用户裁决 D1/D2 原值 8。
 * [3.2.4][O8] 2026-11-23 用户裁决放开：可用环境变量
 * `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS` 覆盖（下限 1，非法/缺省回落 8）。
 * 默认行为与旧裁决完全一致（8）；只有显式设置环境变量时才放宽。
 * 另外：单阶段计划（stages.length === 1）不适用本下限——「可并行拆分」的
 * 8 人下限对单阶段任务只会制造无解死锁，豁免逻辑在 llm-rules 人数闸。
 */
export const MIN_COMPLEX_DELEGATE_MEMBERS = Math.max(1, envPositiveInt('DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS', 8));
/**
 * [3.2.4][O6] 全计划专家总数上限：MAX_SUBTASKS(15) × MAX_COMPLEX_DELEGATE_MEMBERS(25)
 * = 375 名专家 ⇒ 约 781 个 LLM 回合，没有任何全局闸——单个失控计划就能烧穿预算。
 * 环境变量 `DSH_WORKPLAN_MAX_TOTAL_EXPERTS_PER_PLAN` 可调（默认 40）；超出即整单
 * 拒绝，错误信息给出「精简名单 / 拆成多轮计划」两条出路。 enforce 点在 delegate
 * review/dispatch（runtime）：已登记 delegates 合计 + 本次新增 ≤ 上限。
 */
export const MAX_TOTAL_EXPERTS_PER_PLAN = envPositiveInt('DSH_WORKPLAN_MAX_TOTAL_EXPERTS_PER_PLAN', 40);
/**
 * 复杂任务分工表人数上限：用户裁决 D2 原为 12，2026-11-19 用户裁决扩大到 25
 * （部门负责人数量不动；只放宽部门内全球顶尖专家）。仍强制 ≥ 下限 8。
 */
export const MAX_COMPLEX_DELEGATE_MEMBERS = Math.max(MIN_COMPLEX_DELEGATE_MEMBERS, envPositiveInt('DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS', 25));
/**
 * 部门汇总 sources（「覆盖的专家汇报」）条数上限：3.0.6 为修复 12 人死锁放宽到
 * 16；3.1.0 随专家上限 25 同步放宽到 30（25 + 非专家来源余量 5）。覆盖是诚实
 * 硬要求——本条数必须 ≥ 专家人数上限，否则部门永远交不出合法汇总（死锁）。
 */
export const MAX_SOURCES_ITEMS = envPositiveInt('DSH_WORKPLAN_MAX_SOURCES_ITEMS', 30);
