/*
 * [2.5.1] 主 Agent 两轮深度思考协议——共享测试夹具。
 *
 * dispatchTool 硬门禁（validateMainDeepThink）要求首次派发随附 deepThink
 * 产物；既有 dispatch 用例考察的是派发/续跑/时间机制本身，统一用本合格
 * 夹具过闸（与真实主 Agent 提交同一口径：第一轮 ≥40 字、第二轮 ≥40 字、
 * 依据 ≥20 字）。门禁本身的拒绝/放行回归在 workplan-251-main-deep-think.test.ts。
 */
export const MAIN_DEEP_THINK_FIXTURE = {
  problemAnalysis: [
    '第一轮任务深研：现状是计划已生成待派发；目标是把子任务派给部门并收齐结构化证据；约束是不得重复派发已完成项；未知是各部门实际耗时；主要矛盾是质量与时间；边界是只做本计划内的工作。',
  ],
  approach: [
    '第二轮方法流程步骤：先按依赖顺序派发全部子任务 → 督战并核对每项结构化证据与验收 → 受阻项按门禁处置或接手 → 全部 done 且 deliveryReady=true 后逐条验收交付。',
  ],
  approachBasis: [
    '第二轮基于第一轮全部结果：质量与时间的主要矛盾决定先派发后督战的顺序，证据约束决定逐条核对验收的交付方式，边界决定不扩大范围。',
  ],
}