/*
 * [2.5.4][T3R1] 分派前深度梳理质量闸——共享测试夹具（gate-tests）。
 *
 * 质量闸与主 Agent（validateMainDeepThink）/叶子（self_effort）同一判据：
 * problemAnalysis/approach/approachBasis 合计 ≥40/40/20 字（three-phase
 * MIN_PLANNING_*_CHARS 单一事实源）。既有 delegate 夹具多为「一句话」薄产物，
 * 在新闸下被拒属预期；本 helper 提供达标补充项与复杂任务 ≥8 人分工表，
 * 供既有测试做薄夹具适配——断言意图零删改：只补字数/人数，原有数组项、
 * 成员名与断言语义一律保留。
 */

/** 第一轮补充项：追加到原 problemAnalysis 后合计 ≥40 字（单独使用也达标）。 */
export const GATE_PAD_PROBLEM = '约束与边界：不得改动无关文件；验收以聚焦测试全绿为准；未知项先验证再动手，主要矛盾是质量与时间。'

/** 第二轮补充项：追加到原 approach 后合计 ≥40 字（单独使用也达标）。 */
export const GATE_PAD_APPROACH = '第二轮方法流程步骤：先按依赖顺序派发，再督战核对每项结构化证据与验收，受阻按门禁处置，全部合格后逐条验收交付。'

/**
 * [2.5.4][T4] 复杂任务（声明档 medium/high/xhigh/max）expert+member 合计 ≥8 人
 * （用户决策 D1/D2）。前两名固定 Expert-A（expert）/Member-B（member），
 * 其余为通用组员——既有按成员名定位的断言（member-1=Expert-A 等）不受影响。
 *
 * [3.0.0] 两处契约升级同步到本 helper，断言意图不变：
 *  1) 用户要求 9：部门组员角色取消 —— role 一律 'expert'（成员名可继续叫 Member-x）；
 *  2) 用户要求 3/6：质量要求必填 —— 每项统一附一条可检查的质量要求。
 */
export function gateMembers(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const qualityRequirements = ['必须给出可复核的命令输出或文件证据']
    if (i === 0) return { member: 'Expert-A', role: 'expert', task: '实现核心逻辑并自测', qualityRequirements }
    if (i === 1) return { member: 'Member-B', role: 'expert', task: '整理验收证据清单', qualityRequirements }
    return { member: `Member-${i + 1}`, role: 'expert', task: `单一目标子任务 ${i + 1}（单一主产物、可独立验收）`, qualityRequirements }
  })
}
