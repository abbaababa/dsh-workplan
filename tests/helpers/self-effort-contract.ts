/*
 * [2.5.0][自配档] 两阶段契约共享测试 helper（lead 裁决：仅适配测试，不改 src 门禁）。
 *
 * 背景：用户要求 2 新口径「先配置后开工」——未登记自配档的执行者一律 phase-0
 * 以 low 启动、唯一职责=评估复杂度+提交自配；登记后平台才以自配档接续 phase-1。
 * 既有测试大多模拟「直接执行正式任务」，被 phase-0 门禁拦截属预期行为。
 *
 * 适配模式（lead 裁决 (a)，断言意图零删改）：
 *  - 被测主题是下游行为（重试/通知/预算/结算/单调性等）⇒ 预登记「已自配」：
 *    负责人行 effortOverride（selfEffortStatuses / seedLeaderSelfEffort），
 *    叶子台账 delegates[].selfEffort + delegateSelfEfforts（withLeafSelfEfforts）。
 *  - 被测主题是首次派发 ⇒ 模拟 phase-0 结果→phase-1 接续两段（见 workplan-250-self-effort）。
 */
import { buildUpdateMessage, createStatuses } from '../../src/plan.js'
import { MAIN_START_PHASES_FIXTURE } from './main-deep-think.js'

/** createStatuses + 预登记负责人自配档（=规划档，缺失回落 low），模拟「已自配」直接进入 phase-1。 */
export function selfEffortStatuses(plan: any): any[] {
  const rows: any[] = createStatuses(plan)
  const subtasks = (plan?.stages ?? []).flatMap((stage: any) => stage?.subtasks ?? [])
  for (const row of rows) {
    const planned = subtasks.find((item: any) => item?.id === row?.subtaskId)?.reasoningEffort
    row.effortOverride = typeof planned === 'string' && planned ? planned : 'low'
  }
  return rows
}

/** 会话存档路径：plan 消息后追加 durable workplan-update 预登记各自配档（回放消费端已接线）。 */
export function seedLeaderSelfEffort(session: any, plan: any, effort = 'low') {
  for (const stage of plan?.stages ?? []) {
    for (const subtask of stage?.subtasks ?? []) {
      session.append('user/message', buildUpdateMessage({
        planId: plan.planId,
        subtaskId: subtask.id,
        status: 'pending',
        effortOverride: effort,
        revision: 2,
      }))
    }
  }
  return session
}

/** 负责人行预登记（record 形态）。 */
export function withSelfEfforts(record: any): any {
  const subtasks = (record?.plan?.stages ?? []).flatMap((stage: any) => stage?.subtasks ?? [])
  for (const row of Array.isArray(record?.statuses) ? record.statuses : []) {
    const planned = subtasks.find((item: any) => item?.id === row?.subtaskId)?.reasoningEffort
    row.effortOverride = typeof planned === 'string' && planned ? planned : 'low'
  }
  return record
}

/** 叶子台账预登记 delegates[].selfEffort + delegateSelfEfforts，模拟「已自配」。
 * [2.5.2] 同步预登记执行前两轮思考产物（delegates[].startPhases + delegateStartPhases），
 * 模拟「已自配+已思考」读档直接 phase-1；缺思考产物会被路由回 phase-0 补齐。
 * [T6] 同步预登记开工预估（delegates[].estimate + delegateEstimates 双通道，
 * delivery:'sent'、at>0、整数分钟）：新重派门禁 registeredEstimate 要求 sent，
 * 缺预估会被路由回 phase-0；期望 phase-0 的用例不得经本 helper 预登记。 */
export function withLeafSelfEfforts(record: any, effort = 'medium'): any {
  for (const row of Array.isArray(record?.statuses) ? record.statuses : []) {
    if (!Array.isArray(row?.delegates) || row.delegates.length === 0) continue
    const stash: Record<string, string> = { ...(row.delegateSelfEfforts ?? {}) }
    const thinkStash: Record<string, any> = { ...(row.delegateStartPhases ?? {}) }
    const estimateStash: Record<string, any> = { ...(row.delegateEstimates ?? {}) }
    row.delegates = row.delegates.map((member: any) => {
      stash[member.member] = member.selfEffort ?? effort
      thinkStash[member.member] = member.startPhases ?? MAIN_START_PHASES_FIXTURE
      const estimate = member.estimate ?? { declaredMinutes: 15, at: 1_700_000_000_000, delivery: 'sent' }
      estimateStash[member.member] = estimate
      return { ...member, selfEffort: member.selfEffort ?? effort, startPhases: member.startPhases ?? MAIN_START_PHASES_FIXTURE, estimate }
    })
    row.delegateSelfEfforts = stash
    row.delegateStartPhases = thinkStash
    row.delegateEstimates = estimateStash
  }
  return record
}

/** 组合：负责人+叶子一并预登记。 */
export function withAllSelfEfforts(record: any, leafEffort = 'medium'): any {
  return withLeafSelfEfforts(withSelfEfforts(record), leafEffort)
}
