/*
 * [3.0.8] 主 Agent 五步开工证据协议——共享测试夹具。
 *
 * dispatchTool 硬门禁（validateStartPhaseEvidence）要求首次派发随附 startPhases
 * 开工证据（五步第 1/2/3 步）；既有 dispatch 用例考察的是派发/续跑/时间机制本身，
 * 统一用本合格夹具过闸（与真实主 Agent 提交同一口径：第一步 ≥40 字、第二步
 * 方法 ≥40 字 / 依据 ≥20 字 / 资源 ≥20 字 / 工具 ≥10 字、第三步各 ≥20 字）。
 * 门禁本身的拒绝/放行回归在 workplan-251-main-deep-think.test.ts。
 */
export const MAIN_START_PHASES_FIXTURE = {
  planning: {
    problemAnalysis: [
      '第一步任务梳理：现状是计划已生成待派发；目标是把子任务派给部门并收齐结构化证据；约束是不得重复派发已完成项；未知是各部门实际耗时；主要矛盾是质量与时间；边界是只做本计划内的工作。',
    ],
    resources: [
      '第二步资源研究：需要当前计划记录、子任务验收标准清单、部门成员名单与会话通道，均已具备。',
    ],
    tools: [
      '第二步工具研究：dsh_workplan_dispatch 用于派发与续跑，dsh_workplan_status 用于督战核对。',
    ],
    approach: [
      '第二步方法流程步骤：先按依赖顺序派发全部子任务 → 督战并核对每项结构化证据与验收 → 受阻项按门禁处置或接手 → 全部 done 且 deliveryReady=true 后逐条验收交付。',
    ],
    approachBasis: [
      '第二步基于第一步全部结果：质量与时间的主要矛盾决定先派发后督战的顺序，证据约束决定逐条核对验收的交付方式，边界决定不扩大范围。',
    ],
  },
  preparation: {
    prepared: [
      '第三步已备齐：计划记录与验收标准清单已在会话内确认可用，部门成员名单与派发通道就绪。',
    ],
    evidence: [
      '第三步就绪证据：dsh_workplan_status 返回计划与子任务清单，派发通道已连通并返回受理回执。',
    ],
  },
}
