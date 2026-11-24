/*
 * [修复] 合规的叶子（第三层专家）完成回报夹具。
 *
 * 修复后，成员结算回调对「无结构化结果块的完成回报」判 failed——与主链路
 * executeSubtask「非法 JSON 绝不计 done」（EVIDENCE_UNPARSABLE 闸）同一口径。
 * 旧夹具里的纯散文完成回报（'专家结论：完成' 之类）不再计 done，
 * 各测试按真实契约补齐结果块（status=done + F10 合规 report），断言意图不变。
 */
import { EVIDENCE_MARKER_BEGIN, EVIDENCE_MARKER_END } from '../../src/plan.js'

/**
 * [3.2.7] 第三层结算核验五步的第四步/验证两组证据（规划与准备由开工登记承载）。
 * 夹具统一用它补最小合规内容，断言意图不变。
 */
export function leafPhases() {
  return {
    execution: { steps: ['按验收标准完成并自测通过'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: '核心结论已落盘', method: '本地复跑', evidence: '测试输出通过' }],
      requirementCheck: '验收标准逐条覆盖，无偏离。',
    },
  }
}

/** 散文结论 + 结构化结果块（status=done，report 过 F10：keyResults/leadRequirements 各 ≥1 条）。 */
export function memberDoneOutcome(text: string) {
  const payload = {
    status: 'done',
    blockedReason: '',
    /*
     * [3.2.7] 第三层结算现在核验五步的第四步/验证两组证据（规划与准备由开工
     * 登记承载）。夹具补上最小合规的 execution + verification，断言意图不变。
     */
    phases: {
      execution: { steps: ['按验收标准完成并自测通过'], deviations: [] },
      verification: {
        allPassed: true,
        checks: [{ criterion: '核心结论已落盘', method: '本地复跑', evidence: '测试输出通过' }],
        requirementCheck: '验收标准逐条覆盖，无偏离。',
      },
    },
    report: {
      keyResults: ['核心结论已落盘并自测通过'],
      keyInfo: [],
      importantInfo: [],
      leadRequirements: ['无需负责人追加动作'],
    },
  }
  return {
    stopReason: 'completed',
    output: [{
      type: 'text',
      text: `${text}\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`,
    }],
  }
}
