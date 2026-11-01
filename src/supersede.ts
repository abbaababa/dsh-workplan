/**
 * [1.9.2] `superseded`（责任已转移）的**唯一写入路径**。
 *
 * 规则出处（落盘文档，不在本文件重复全文）：
 * - `_rerun_20261101/GATE_rule_design.md` §6.1（字段 schema：工具入参 vs
 *   运行时存储）、§6.2（V1–V8 核验与失败码）、§7.2（迁移证据要求）、
 *   §7.4（幂等 / 撤销 / 批量 / 失败即不变）。
 * - `docs/postmortem-1.8.7-20261031.md` §16「残余：superseded 写入路径」。
 *
 * 为什么要有这一个文件：1.9.0/1.9.1 只做了读侧（replay 读
 * `cancel.disposition === 'superseded'`、present 的覆盖链判定、dispatch 的
 * `PLAN_SUPERSEDED`），写侧完全不存在。任何「就地改一下 record.phase」的
 * 捷径都会造成 live 与 replay 分叉——UI 说被取代、重启后说未完成/已取消，
 * 正是本子任务要杜绝的绕过。因此写入只允许经过本模块：
 *
 *   1. 先做 V1–V8 全量核验（任一失败：返回 `ok:false` + `SUPERSEDE_*` 码，
 *      **不改内存、不写日志**）；
 *   2. 由运行时复算 `coverage` 与 `digest`（模型只能给映射意图，不能自报
 *      计数/摘要）；
 *   3. 用 `buildCancelMessage(..., { disposition:'superseded' })`——全仓库唯一
 *      拼装 `workplan-cancel` 信封的函数——写 durable 记录；
 *   4. 只有 append 成功之后才把内存记录翻成 `phase='superseded'`。
 *
 * 语义边界（必须明说）：运行时能验的是承接计划那一侧的机器事实（存在、时序、
 * 状态、结构化证据、验收、产物）；「两项工作在语义上等价」是人的判断，只能
 * 由用户消息确认（V8）承载。这不是实现缺陷，而是 RC-2（自证闭环）的结构性
 * 防线。
 */
import {
  buildCancelMessage,
  derivePlanSnapshot,
  flattenSubtasks,
  isRecord,
  isTerminalPhase,
  messageText,
  parseWorkplanMessage,
  truncate,
} from './plan.js'
import { withMappingDigest } from './supersede-digest.js'

/** V1–V8 的失败码。对外契约：工具结果、测试与审计日志按字面值断言。 */
export const SUPERSEDE_CODES = {
  TARGET_UNKNOWN: 'SUPERSEDE_TARGET_UNKNOWN',
  ORDER_INVALID: 'SUPERSEDE_ORDER_INVALID',
  SOURCE_NOT_CANCELLED: 'SUPERSEDE_SOURCE_NOT_CANCELLED',
  SOURCE_DONE: 'SUPERSEDE_SOURCE_DONE',
  /** 设计 §7.1：空计划不是交付对象，不能走 supersede（U6）。 */
  SOURCE_EMPTY: 'SUPERSEDE_SOURCE_EMPTY',
  MAPPING_INCOMPLETE: 'SUPERSEDE_MAPPING_INCOMPLETE',
  TARGET_ITEM_UNKNOWN: 'SUPERSEDE_TARGET_ITEM_UNKNOWN',
  EVIDENCE_GAP: 'SUPERSEDE_EVIDENCE_GAP',
  TARGET_TERMINAL: 'SUPERSEDE_TARGET_TERMINAL',
  NOT_CONFIRMED: 'SUPERSEDE_NOT_CONFIRMED',
  /** 信封构造失败（含 digest 无法复算）：fail-closed，不写日志。 */
  WRITE_FAILED: 'SUPERSEDE_WRITE_FAILED',
} as const

export type SupersedeCode = (typeof SUPERSEDE_CODES)[keyof typeof SUPERSEDE_CODES]

/** V8 的确认词，逐字取自规则设计 §6.2。 */
const CONFIRMATION_WORDS = /确认|同意|可以|按此执行/u

/** mapping 上限：计划最多 15 项，留出审计余量，防止异常输入撑爆日志。 */
const MAX_MAPPING_ENTRIES = 100

export interface SupersedeDeps {
  /** `reconstructFromSession`：由调用方注入，避免 runtime ↔ supersede 循环 import。 */
  reconstruct: (session: any, planId: string) => any
}

function messageOf(event: any) {
  return event?.data?.message ?? event?.data
}

/** 计划定义在会话日志中的位置；找不到返回 -1（V2 的输入，fail-closed）。 */
export function planDefinitionSeq(session: any, planId: string): number {
  if (!planId || typeof session?.eventAt !== 'function') return -1
  for (let i = 0; i < session.seq; i += 1) {
    let event
    try {
      event = session.eventAt(i)
    } catch {
      continue
    }
    if (!event || event.type !== 'user/message') continue
    const plan = parseWorkplanMessage(messageOf(event))?.plan
    if (plan && String(plan.planId ?? '') === planId) return i
  }
  return -1
}

/**
 * V8：本会话中**真实用户消息**（非工具结果、非插件通知）需同时包含源与承接
 * 两个 planId，且含确认词；返回该消息的 seq（未确认返回 -1）。
 *
 * 只认 `role==='user'` 且 `source.kind` 为 `user`/省略的消息：插件自己写的
 * plan/result/cancel/update 通知也都是 role user，但带 `source.kind`，必须排除，
 * 否则「计划正文里同时出现两个 planId」会被误当用户确认。
 */
export function confirmationSeq(session: any, sourcePlanId: string, successorPlanId: string): number {
  if (!sourcePlanId || !successorPlanId || typeof session?.eventAt !== 'function') return -1
  for (let i = session.seq - 1; i >= 0; i -= 1) {
    let event
    try {
      event = session.eventAt(i)
    } catch {
      continue
    }
    if (!event || event.type !== 'user/message') continue
    const message = messageOf(event)
    if (!message || message.role !== 'user') continue
    const kind = message.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const text = messageText(message)
    if (!text || !text.includes(sourcePlanId) || !text.includes(successorPlanId)) continue
    if (CONFIRMATION_WORDS.test(text)) return i
  }
  return -1
}

function definedSubtasks(plan: any): any[] {
  try {
    return flattenSubtasks(plan).map((entry: any) => entry.subtask)
  } catch {
    return []
  }
}

/**
 * V6：承接计划某个目标项的机器事实缺口（空数组 = 通过）。
 *
 * 判据逐字取自规则设计 §6.2：`status==='done'` ∧ `verification==='structured'`
 * ∧ `acceptance` 非空且逐项 `result==='pass'` ∧ `missingArtifacts` 为空 ∧
 * 声明产物 `exists!==false`。
 */
export function mappedEvidenceGaps(item: any): string[] {
  const gaps: string[] = []
  if (item?.status !== 'done') gaps.push(`状态为 ${String(item?.status ?? '缺失')}`)
  const verification = typeof item?.verification === 'string' ? item.verification : ''
  if (verification !== 'structured') gaps.push(`verification=${verification || '缺失'}`)
  const acceptance = Array.isArray(item?.acceptance) ? item.acceptance : []
  if (acceptance.length === 0) gaps.push('未提供验收项（acceptance 为空）')
  for (const entry of acceptance) {
    if (entry?.result !== 'pass') {
      gaps.push(`验收未通过：${truncate(String(entry?.criterion ?? '未命名验收项'), 60)}`)
    }
  }
  const missing = Array.isArray(item?.missingArtifacts) ? item.missingArtifacts.filter(Boolean) : []
  if (missing.length > 0) gaps.push(`缺少声明产物：${missing.slice(0, 3).join('、')}`)
  const artifacts = Array.isArray(item?.artifacts) ? item.artifacts : []
  for (const artifact of artifacts) {
    if (artifact?.exists === false) {
      gaps.push(`声明产物不存在：${truncate(String(artifact?.ref ?? '未命名产物'), 80)}`)
    }
  }
  return gaps
}

/**
 * 唯一的 superseded 写入函数。
 *
 * 返回值直接是工具结果（`ok/code/error/hint`）。**任何失败分支都不写日志、
 * 不改 record**（§7.4「失败即不变」）；只有 V1–V8 全通过且 append 成功才
 * 翻状态。幂等：已 superseded 再次调用返回 `ok:true, alreadySuperseded:true`，
 * 不追加记录、不改变状态。
 */
export function supersedePlanRecord(session: any, record: any, args: any, deps: SupersedeDeps): any {
  const planId = String(record?.plan?.planId ?? '')
  const snapshot = derivePlanSnapshot(record?.statuses ?? [])
  const stats = snapshot.stats

  const deny = (code: SupersedeCode, detail: string, extra: any = {}) => ({
    ok: false,
    code,
    planId,
    phase: String(record?.phase ?? 'cancelled'),
    stats,
    error: detail,
    hint: '状态未改变：仍为 cancelled 且未完成。不得调用 present，不得声称“已完成/最终版/已交付”；'
      + '修正该缺口后，再调用 dsh_workplan_cancel({ disposition:"superseded", supersededBy:{…} })。',
    ...extra,
  })

  // §7.4 幂等：被取代是终态，重复调用不得追加记录。
  if (record?.phase === 'superseded' || record?.superseded === true) {
    return {
      ok: true,
      planId,
      phase: 'superseded',
      alreadySuperseded: true,
      supersededBy: record?.supersededBy ?? null,
      stats,
      hint: '该计划已被取代：本次调用是幂等 no-op（不追加记录、不改变状态）。被取代不等于完成。',
    }
  }

  // V3：源计划必须是**已落盘**的 cancelled，且未全部 done。
  if (record?.phase !== 'cancelled') {
    return deny(
      SUPERSEDE_CODES.SOURCE_NOT_CANCELLED,
      `源计划 ${planId} 当前为 ${String(record?.phase ?? '未知')}，不是 cancelled：禁止静默取代运行中/未取消的计划`,
    )
  }
  if (record?.cancelRecorded === false) {
    return deny(
      SUPERSEDE_CODES.SOURCE_NOT_CANCELLED,
      `源计划 ${planId} 的取消记录没有成功落盘（cancelRecorded=false）：先重试取消，再考虑覆盖迁移`,
    )
  }
  if (Number(stats.total) > 0 && Number(stats.done) === Number(stats.total)) {
    return deny(
      SUPERSEDE_CODES.SOURCE_DONE,
      `源计划 ${planId} 已 ${stats.done}/${stats.total} 全部 done：完成态不得被取代（应保持 done，不能洗成 superseded）`,
    )
  }
  const sourceItems = definedSubtasks(record?.plan)
  if (sourceItems.length === 0) {
    return deny(SUPERSEDE_CODES.SOURCE_EMPTY, `源计划 ${planId} 没有定义任何子任务：空计划不是交付对象，不能走 supersede`)
  }

  // 入参：只接受「映射意图」，计数与摘要由运行时复算。
  const byInput = isRecord(args?.supersededBy) ? args.supersededBy : null
  const successorPlanId = typeof byInput?.planId === 'string' ? byInput.planId.trim() : ''
  if (!successorPlanId) {
    return deny(SUPERSEDE_CODES.TARGET_UNKNOWN, '缺少 supersededBy.planId：无法指定承接计划')
  }
  if (!Array.isArray(byInput?.mapping)) {
    return deny(SUPERSEDE_CODES.MAPPING_INCOMPLETE, '缺少 supersededBy.mapping：必须逐项给出源→承接的映射与 basis')
  }

  // V1：承接计划存在、是同会话日志里的真实计划定义、且定义了子任务。
  const successor = deps.reconstruct(session, successorPlanId)
  if (!successor?.plan || String(successor.plan.planId ?? '') !== successorPlanId) {
    return deny(SUPERSEDE_CODES.TARGET_UNKNOWN, `承接计划 ${successorPlanId} 不存在于本会话日志`)
  }
  const successorItems = definedSubtasks(successor.plan)
  if (successorItems.length === 0) {
    return deny(SUPERSEDE_CODES.TARGET_UNKNOWN, `承接计划 ${successorPlanId} 没有定义任何子任务，不能作为覆盖计划`)
  }

  // V2：承接计划必须定义得比源计划晚（防止用历史计划反盖当前计划）。
  const sourceSeq = planDefinitionSeq(session, planId)
  const successorSeq = planDefinitionSeq(session, successorPlanId)
  if (sourceSeq < 0 || successorSeq < 0) {
    return deny(
      SUPERSEDE_CODES.ORDER_INVALID,
      `无法在会话日志中定位计划定义（源 ${planId}=seq ${sourceSeq}，承接 ${successorPlanId}=seq ${successorSeq}）：`
      + '覆盖时序无法复核，按 fail-closed 拒绝',
    )
  }
  if (successorSeq <= sourceSeq) {
    return deny(
      SUPERSEDE_CODES.ORDER_INVALID,
      `承接计划 ${successorPlanId} 定义于 seq ${successorSeq}，不晚于源计划 ${planId} 的 seq ${sourceSeq}`,
    )
  }

  // V7：承接计划不得是终态（不能拿另一个 cancelled/superseded 当覆盖）。
  if (isTerminalPhase(successor.phase)) {
    return deny(
      SUPERSEDE_CODES.TARGET_TERMINAL,
      `承接计划 ${successorPlanId} 本身是终态（${String(successor.phase)}）：不能用一个已终止的计划承担交付责任`,
    )
  }

  // V4：mapping.from 恰好覆盖源计划全部定义子任务，各一次，无多余项。
  const sourceIds = sourceItems.map((item: any) => String(item.id))
  const sourceIdSet = new Set(sourceIds)
  const successorIds = new Set(successorItems.map((item: any) => String(item.id)))
  const seen = new Map<string, number>()
  const mappingProblems: string[] = []
  const mapping: Array<{ from: string; to: string; basis: string }> = []
  byInput.mapping.slice(0, MAX_MAPPING_ENTRIES).forEach((raw: any, index: number) => {
    if (!isRecord(raw)) {
      mappingProblems.push(`第 ${index + 1} 项不是对象`)
      return
    }
    const from = typeof raw.from === 'string' ? raw.from.trim() : ''
    const to = typeof raw.to === 'string' ? raw.to.trim() : ''
    const basis = typeof raw.basis === 'string' ? raw.basis.trim() : ''
    if (!from || !to) {
      mappingProblems.push(`第 ${index + 1} 项缺少 from/to`)
      return
    }
    if (!basis) mappingProblems.push(`${from} 缺少 basis（覆盖依据）`)
    if (!sourceIdSet.has(from)) {
      mappingProblems.push(`from=${from} 不是源计划 ${planId} 的定义子任务`)
    } else if (seen.has(from)) {
      mappingProblems.push(`from=${from} 重复映射`)
    } else {
      seen.set(from, 1)
    }
    mapping.push({ from, to, basis: truncate(basis, 500) })
  })
  if (byInput.mapping.length > MAX_MAPPING_ENTRIES) {
    mappingProblems.push(`映射项超过 ${MAX_MAPPING_ENTRIES} 条上限`)
  }
  const missingFrom = sourceIds.filter((id: string) => !seen.has(id))
  if (mappingProblems.length > 0 || missingFrom.length > 0) {
    return deny(
      SUPERSEDE_CODES.MAPPING_INCOMPLETE,
      '映射不完整或非法：必须逐项覆盖源计划全部定义子任务（各一次）',
      {
        requiredCount: sourceIds.length,
        coveredCount: seen.size,
        missingFrom,
        problems: mappingProblems.slice(0, 20),
      },
    )
  }

  // V5：每个映射目标都必须是承接计划的定义子任务。
  const unknownTargets = mapping.filter((entry) => !successorIds.has(entry.to)).map((entry) => entry.to)
  if (unknownTargets.length > 0) {
    return deny(
      SUPERSEDE_CODES.TARGET_ITEM_UNKNOWN,
      `映射目标不存在于承接计划 ${successorPlanId}`,
      { unknownTargets: [...new Set(unknownTargets)].slice(0, 20) },
    )
  }

  // V6：逐项机器事实（done + structured + 验收全 pass + 产物齐）。
  const successorStatus = new Map<string, any>(
    (Array.isArray(successor.statuses) ? successor.statuses : []).map((item: any) => [String(item?.subtaskId ?? ''), item]),
  )
  const evidenceGaps: string[] = []
  const normalizedMapping = mapping.map((entry) => {
    const item = successorStatus.get(entry.to)
    const gaps = mappedEvidenceGaps(item)
    if (gaps.length > 0) evidenceGaps.push(`${entry.from}→${entry.to}：${gaps.join('；')}`)
    return {
      ...entry,
      evidence: { status: 'done', verification: 'structured', acceptance: 'all-pass', artifacts: 'ok' },
    }
  })
  if (evidenceGaps.length > 0) {
    return deny(
      SUPERSEDE_CODES.EVIDENCE_GAP,
      `承接计划 ${successorPlanId} 的映射目标存在证据缺口：被取代不等于完成，缺口补不齐就不得迁移`,
      { gaps: evidenceGaps.slice(0, 20) },
    )
  }

  // V8：用户确认（真实用户消息，同时含两个 planId 与确认词）。
  const confirmedAtSeq = confirmationSeq(session, planId, successorPlanId)
  if (confirmedAtSeq < 0) {
    return deny(
      SUPERSEDE_CODES.NOT_CONFIRMED,
      `没有找到用户确认：本会话需要一条用户消息同时包含 ${planId} 与 ${successorPlanId}，`
      + '并含「确认/同意/可以/按此执行」之一；模型自述不算确认',
    )
  }

  // 运行时复算 coverage 与 digest（模型不得自报），再写 durable 记录。
  const verifiedAt = Date.now()
  let supersededBy: any
  try {
    supersededBy = withMappingDigest({
      planId: successorPlanId,
      requiredCount: sourceIds.length,
      coveredCount: normalizedMapping.length,
      coverage: normalizedMapping.length === sourceIds.length ? 'full' : 'partial',
      mapping: normalizedMapping,
      verifiedAt,
      verifiedBy: 'runtime-recompute',
      successorSeenAtSeq: successorSeq,
      confirmedAtSeq,
    })
  } catch (error: any) {
    return deny(SUPERSEDE_CODES.WRITE_FAILED, `无法计算覆盖摘要：${error?.message ?? String(error)}`)
  }
  const reason = typeof args?.reason === 'string' && args.reason.trim()
    ? truncate(args.reason.trim(), 300)
    : '责任已转移给可验证的承接计划'
  let message
  try {
    message = buildCancelMessage(planId, reason, {
      disposition: 'superseded',
      supersededAt: verifiedAt,
      supersededBy,
    })
  } catch (error: any) {
    return deny(SUPERSEDE_CODES.WRITE_FAILED, `构造取代记录失败：${error?.message ?? String(error)}`)
  }
  try {
    session.append('user/message', message, { surfaceOp: 'append' })
  } catch (error: any) {
    record.errors = [...(Array.isArray(record?.errors) ? record.errors : []),
      `写入取代记录失败：${error instanceof Error ? error.message : String(error)}`].slice(-20)
    record.supersedeRecorded = false
    return {
      ok: false,
      code: SUPERSEDE_CODES.WRITE_FAILED,
      planId,
      phase: String(record?.phase ?? 'cancelled'),
      stats,
      error: `取代记录写入会话日志失败：${error instanceof Error ? error.message : String(error)}`,
      hint: '日志未写入，状态保持不变（仍为 cancelled/未完成）：不得调用 present。'
        + '修复日志写入后重试；不要用内存改判伪造 superseded。',
    }
  }

  // 只有 durable 记录写入成功后，才允许翻内存状态（live 与 replay 同源）。
  record.phase = 'superseded'
  record.superseded = true
  record.supersededBy = supersededBy
  record.cancelled = false
  record.supersedeRecorded = true
  record.supersededAt = verifiedAt
  record.updatedAt = verifiedAt

  return {
    ok: true,
    planId,
    phase: 'superseded',
    reason,
    supersededAt: verifiedAt,
    supersededBy,
    coverage: supersededBy.coverage,
    requiredCount: supersededBy.requiredCount,
    coveredCount: supersededBy.coveredCount,
    successorSeenAtSeq: successorSeq,
    confirmedAtSeq,
    supersedeRecorded: true,
    stats,
    hint: '已写入 superseded 记录（replay 后仍为 superseded）。被取代不等于完成：'
      + `源计划仍是 ${stats.done}/${stats.total}，交付只能用承接计划 ${successorPlanId} 通过交付就绪检查的产物。`,
  }
}
