/**
 * [2.3.9][T3] LLM 家族检测与推理等级约束——执行工具层。
 *
 * 单一事实源在 src/plan.ts（REASONING_EFFORTS 五档存储全集旁：classifyModelFamily /
 * allowedEffortsForModel / COMPLEXITY_EFFORT_BY_FAMILY，含用户要求 1/2 原文与
 * 「不得删档/模型未知不约束」的完整语义注释）。本模块只做两件事：
 *  1) 转发真源符号（保持 runtime/replan/tests 的引用面稳定，兼容别名
 *     detectLlmType ≡ classifyModelFamily）；
 *  2) 提供「事前约束」需要的两个执行函数：validateReasoningEffort（集合校验，
 *     给明确错误信息=A3 报错轨）与 correctEffortForModel（越界自动降级修正
 *     =A3 修正轨，绝不抛错中断派发）。
 *
 * 与 [2.2.7] 宿主能力钳制（clampEffortToSupported/resolveSupportedEfforts）的
 * 时序关系：检测(入口) → 静态集合收窄(本模块) → 宿主能力交集钳制 → 发送；
 * 两道闸各自留痕（U7 裁决：静态表权威 + 能力面交集钳制留痕）。
 */

import {
  allowedEffortsForModel,
  classifyModelFamily,
  defuseSessionReferenceText,
  effortForComplexity,
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  effortsForModelFamily,
  highestEffortOf,
  OTHER_MODEL_EFFORTS,
  QWEN_MODEL_EFFORTS,
  REASONING_EFFORTS,
  truncate,
  type ModelFamily,
  type TaskComplexity,
} from './plan.js'
import { threePhasePromptLines } from './three-phase.js'

export {
  allowedEffortsForModel,
  classifyModelFamily,
  effortForComplexity,
  effortsForModelFamily,
  highestEffortOf,
  OTHER_MODEL_EFFORTS,
  QWEN_MODEL_EFFORTS,
}
export type { ModelFamily, TaskComplexity }
/** 兼容别名：T3 计划文本中的 detectLlmType ≡ 真源 classifyModelFamily。 */
export const detectLlmType = classifyModelFamily
/** 兼容别名：T3 计划文本中的 getAllowedEffortLevels(llmType) ≡ 真源 effortsForModelFamily。 */
export const getAllowedEffortLevels = effortsForModelFamily

/** 校验结果：ok=在集合内；error=集合外的明确错误文案（A3 报错轨）。 */
export interface EffortValidation {
  ok: boolean
  error?: string
}

/**
 * 集合校验（用户要求 1/2 的硬白名单判定）。
 * @param effort 待校验档位
 * @param allowed 等级集合（null=模型未知，不施加约束，任何值都 ok）
 */
export function validateReasoningEffort(
  effort: unknown,
  allowed: readonly string[] | null,
): EffortValidation {
  if (allowed === null) return { ok: true }
  if (typeof effort !== 'string' || !allowed.includes(effort)) {
    return {
      ok: false,
      error: `reasoningEffort "${String(effort)}" 不在当前模型家族的推理等级集合 {${allowed.join(', ')}} 内（qwen 系仅 low/medium/xhigh；非 qwen 系仅 low/high/max）——请改用集合内档位`,
    }
  }
  return { ok: true }
}

/** 自动修正结果：effort=修正后档位；adjusted=是否改动；reason=可审计留痕文案。 */
export interface EffortCorrection {
  effort: string
  adjusted: boolean
  requested: string
  reason?: string
}

/** 静态强度序（与 runtime.ts EFFORT_STRENGTH_ORDER 同源语义）。 */
const STATIC_STRENGTH_ORDER: readonly string[] = Object.freeze(
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
)

/**
 * 越界自动降级修正（A3 修正轨）：请求档不在家族集合内时，钳到集合内「不高于
 * 请求档」的最近档（按强度序逐级下探：qwen 下 max→xhigh、high→medium；非 qwen
 * 下 xhigh→high、medium→low），全部更弱则取最弱档；集合未知（模型名缺失）
 * ⇒ 原样透传。派发绝不因档位问题中断。
 */
export function correctEffortForModel(
  effort: string,
  modelId?: string | null,
): EffortCorrection {
  const allowed = allowedEffortsForModel(modelId)
  if (allowed === null) return { effort, adjusted: false, requested: effort }
  if (allowed.includes(effort)) return { effort, adjusted: false, requested: effort }
  const rank = (id: string) => STATIC_STRENGTH_ORDER.indexOf(id)
  const ranked = [...allowed].sort((a, b) => rank(a) - rank(b))
  const target = rank(effort)
  const corrected = target < 0
    ? ranked[0]
    : (() => {
      const atOrBelow = ranked.filter((id) => rank(id) >= 0 && rank(id) <= target)
      return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : ranked[0]
    })()
  const family = classifyModelFamily(modelId)
  return {
    effort: corrected,
    adjusted: true,
    requested: effort,
    reason: `${family === 'qwen' ? 'qwen-rule' : 'non-qwen-rule'}:${effort}→${corrected}（模型家族等级集合为 {${allowed.join(', ')}}，越界档按强度序自动降级）`,
  }
}

/**
 * 要求 1/2 的规则全文（供 T4/T4b 部门告知注入引用同一事实源，避免文案漂移）。
 */
export const LLM_REASONING_RULES_TEXT = [
  '1. 分配任务前先判断用户此刻使用的大模型：字母 qwen 开头的模型，推理等级只包括 low、medium、xhigh——轻度任务使用 low，比较复杂的任务使用 medium，非常复杂的任务使用 xhigh。',
  '2. 非 qwen 开头的其他大模型，推理等级只包括 low、high、max——轻度任务使用 low，比较复杂的任务使用 high，非常复杂的任务使用 max。',
].join('\n')

/**
 * [2.3.9][T4b] 部门告知块（用户强制要求 3：分配任务时必须把要求 1/2 全文告知相关部门）。
 *
 * 派发链路上唯一的注入事实源：二级部门任务书（buildChildPrompt 的 llmRulesBrief
 * 参数）与三级专家/组员任务书（buildDelegateePrompt）都调用本函数生成，文案
 * 不可能分叉。信息缺失（模型未知）时如实写明「不施加静态约束」，不编造等级集。
 */
export interface LlmRulesBriefInfo {
  model?: string | null
  family?: ModelFamily | null
  allowed?: readonly string[] | null
  effort?: string | null
  requested?: string | null
  correctionReason?: string | null
  tier?: 'department' | 'delegate'
  memberName?: string
  memberRole?: 'expert' | 'member'
}

export function buildLlmRulesBrief(info: LlmRulesBriefInfo = {}): string {
  const family = info.family ?? classifyModelFamily(info.model ?? null)
  const allowed = info.allowed ?? allowedEffortsForModel(info.model ?? null)
  const lines = [
    '[2.3.9][LLM 推理等级强制规则——用户要求 1/2 全文（部门、专家、组员全员告知，必须遵守）]',
    LLM_REASONING_RULES_TEXT,
    `- 本会话模型：${info.model || '（未知，不施加静态等级约束）'}`
      + (info.model ? `（家族：${family === 'qwen' ? 'qwen 系' : '非 qwen 系'}）` : '')
      + (allowed ? `；可用推理等级集合：{${allowed.join(', ')}}` : ''),
  ]
  if (info.effort) {
    const adjusted = Boolean(info.requested) && info.requested !== info.effort
    lines.push(`- 本任务的推理等级已按任务复杂度配置为 \`${info.effort}\`，必须全程应用（开工预告、执行、验证、复盘全生命周期生效）`
      + (adjusted
        ? `；请求档 \`${info.requested}\` 越出当前模型家族等级集合，已按规则自动钳制修正${info.correctionReason ? `（${info.correctionReason}）` : ''}。`
        : '。'))
  }
  if (info.tier === 'delegate') {
    lines.push(`- 你是部门第三层执行者（${info.memberRole === 'expert' ? '本部门相关领域全球顶尖专家' : '本部门组员'}${info.memberName ? `：${info.memberName}` : ''}）。你的等级由部门负责人按你分到任务的复杂度配置并经平台按上述等级集合强制约束；越界档会被钳制并留痕。必须确保自身任务完成品质非常高的前提下，完美、超高效率地执行。`)
  } else {
    lines.push('- 部门负责人（本任务书的直接接收者）强制流程（用户要求 4/5）：接到任务后必须先全面、全盘、深入梳理与研究，再用 dsh_workplan_delegate(action="review") 提交梳理产物（问题梳理 + 分工表 + 每位专家/组员的推理等级配置）；梳理产物未提交前，dsh_workplan_delegate(action="dispatch") 会被平台拒绝（硬门禁）。梳理完成后再把任务合理分配给本部门相关领域全球顶尖专家与本部门组员；每位下级必须按自己分到任务的复杂度配置相应推理等级（轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max），全程应用；平台会按上述等级集合自动钳制越界档并留痕，等级在其任务全生命周期生效且不可被覆盖。第三层为叶子层：任何第四层派发一律被拒绝。')
  }
  return lines.join('\n')
}

/**
 * [2.3.9][T4b] 部门负责人「先全面梳理、再分配」硬门禁 + 第三层分工的纯逻辑核。
 *
 * 为什么放这里而不是 runtime.ts：这段判定是用户要求 4/5 的完整语义
 * （梳理产物齐全 → 才允许派发；顶尖专家 + 至少 1 名组员 → 才算分工成立；
 * 每位下级的推理等级 → 必须在当前模型家族等级集合内，越界按要求 1/2
 * 自动钳制并留痕），不依赖宿主会话/子会话服务，可被 delegateTool 与测试
 * 同口径消费——门禁不能被提示词绕过，只能被这段代码绕过，而这段代码是
 * 唯一入口。
 */
export interface ConsolidationInput {
  problemAnalysis?: unknown
  constraints?: unknown
  unknowns?: unknown
  approach?: unknown
  assignments?: unknown
}

export interface DelegationAssignment {
  member: string
  role: 'expert' | 'member'
  task: string
  effort: string
  requested?: string
  correctionReason?: string
}

export interface DelegationPlan {
  ok: boolean
  code?: string
  error?: string
  members: DelegationAssignment[]
  clamped: Array<{ member: string; requested: string; corrected: string; reason: string }>
  consolidation?: {
    problemAnalysis: string[]
    constraints: string[]
    unknowns: string[]
    approach: string[]
    assignments: number
  }
}

const MAX_DELEGATE_MEMBERS = 6

function readTrimmedStrings(value: unknown, limit: number): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item: any) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, limit)
}

/**
 * 梳理产物校验 + 分工表校验 + 等级钳制，三合一（一次调用给出全部拒因）。
 * @param input.consolidation 部门负责人提交的梳理产物（review 阶段写入行，
 *        dispatch 阶段从行读回；两处都走这里，门禁与派发同一判据）
 * @param input.model 当前会话模型 id（未知 ⇒ allowed=null ⇒ 不施加静态收窄，
 *        但仍必须落在五档存储全集内——枚举校验永不放松）
 */
export function planDelegations(input: {
  consolidation?: ConsolidationInput | null
  model?: string | null
}): DelegationPlan {
  const empty = { ok: false as const, code: 'DELEGATE_CONSOLIDATION_MISSING', members: [], clamped: [] }
  const consolidation = input?.consolidation
  if (!consolidation || typeof consolidation !== 'object') {
    return { ...empty, error: '尚未提交「全面梳理」产物：先用 dsh_workplan_delegate(action="review") 提交问题梳理与分工表，派发才会放行（用户要求 4 的硬门禁）。' }
  }
  const problemAnalysis = readTrimmedStrings(consolidation.problemAnalysis, 12)
  if (problemAnalysis.length === 0) {
    return { ...empty, code: 'DELEGATE_CONSOLIDATION_INCOMPLETE', error: '梳理产物不完整：problemAnalysis 至少 1 条（现状/事实/约束/未知/主要矛盾逐条写清），未梳理完不得进入再分配。' }
  }
  const assignments = (Array.isArray(consolidation.assignments) ? consolidation.assignments : []).slice(0, MAX_DELEGATE_MEMBERS)
  if (assignments.length === 0) {
    return { ...empty, code: 'DELEGATE_CONSOLIDATION_INCOMPLETE', error: '梳理产物不完整：分工表 assignments 至少 1 条（member/role/task/reasoningEffort 四项齐全）。' }
  }
  const allowed = allowedEffortsForModel(input.model ?? null)
  const members: DelegationAssignment[] = []
  const clamped: DelegationPlan['clamped'] = []
  let experts = 0
  let regular = 0
  for (let index = 0; index < assignments.length; index += 1) {
    const item: any = assignments[index] ?? {}
    const member = truncate(String(item.member ?? '').trim(), 80)
    const role = item.role === 'expert' ? 'expert' : item.role === 'member' ? 'member' : ''
    const task = truncate(String(item.task ?? '').trim(), 1500)
    if (!member || !role || !task) {
      return {
        ok: false,
        code: 'DELEGATE_ASSIGNMENT_INVALID',
        members: [],
        clamped: [],
        error: `分工表第 ${index + 1} 条不完整：member（姓名/代号）、role（expert|member）、task（分到的任务）三者都必须非空。`,
      }
    }
    const requested = REASONING_EFFORTS.includes(item.reasoningEffort)
      ? String(item.reasoningEffort)
      : (allowed === null ? 'low' : (highestEffortOf(allowed) ?? 'low'))
    const outOfSet = allowed !== null && !allowed.includes(requested)
    const correction = outOfSet ? correctEffortForModel(requested, input.model ?? null) : null
    const effort = correction ? correction.effort : requested
    if (correction) {
      clamped.push({ member, requested, corrected: correction.effort, reason: correction.reason ?? '' })
    }
    if (role === 'expert') experts += 1
    else regular += 1
    members.push({
      member,
      role,
      task,
      effort,
      ...(outOfSet ? { requested, correctionReason: correction?.reason } : {}),
    })
  }
  if (experts === 0 || regular === 0) {
    return {
      ok: false,
      code: 'DELEGATE_ROLE_MIX_REQUIRED',
      members: [],
      clamped: [],
      error: '分工表必须同时覆盖「本部门相关领域全球顶尖专家」与「本部门组员」（各至少 1 名，用户要求 4）：当前 expert=' + experts + '、member=' + regular + '。',
    }
  }
  return {
    ok: true,
    members,
    clamped,
    consolidation: {
      problemAnalysis,
      constraints: readTrimmedStrings(consolidation.constraints, 12),
      unknowns: readTrimmedStrings(consolidation.unknowns, 12),
      approach: readTrimmedStrings(consolidation.approach, 12),
      assignments: members.length,
    },
  }
}

/**
 * [2.3.9][T4b] 第三层任务书：部门负责人 → 顶尖专家/组员子会话。
 *
 * 与二级任务书（buildChildPrompt）共享同一注入事实源 buildLlmRulesBrief
 * （tier='delegate'），要求 1/2 全文与「等级全程应用、越界钳制留痕」的
 * 口径不可能在两处漂移；叶子层禁令（不得再派生第四层）直接写进任务书，
 * 服务端 delegateTool 另有一道硬拒——提示词说服模型，代码守住边界。
 */
export function buildDelegateePrompt(input: {
  departmentLabel?: string
  leaderSubtaskId?: string
  leaderSubtaskTitle?: string
  member: DelegationAssignment
  rulesBrief: string
  cwd?: string
  leadSessionId?: string
  extraContext?: string
}): string {
  const roleLabel = input.member.role === 'expert' ? '本部门相关领域全球顶尖专家' : '本部门组员'
  return defuseSessionReferenceText([
    `你是「${input.departmentLabel ?? '部门'}」的${roleLabel}（${input.member.member}），由部门负责人直接分配，只负责下面这一项分配到的工作。`,
    `负责人任务：${input.leaderSubtaskId ?? ''} ${input.leaderSubtaskTitle ?? ''}`,
    `你的任务：${input.member.task}`,
    `工作目录：${input.cwd || '（未知）'}`,
    ...(input.extraContext ? ['', input.extraContext] : []),
    '',
    input.rulesBrief,
    '',
    '执行要求（用户强制要求 5 原文口径）：',
    '- 你分到的推理等级已按任务复杂度配置并由平台按当前模型等级集合钳制生效：必须全程应用（规划、执行、验证、复盘全生命周期），不得自行换档。',
    '- 必须在确保自身任务完成品质非常高的前提下，完美、超高效率地执行；严禁低效执行与浪费 token。',
    '- 你是第三层叶子执行者：不得派生任何第四层 Agent/子会话；无法完成时在结论首行写 BLOCKED: 原因 并说明缺什么，不要空转。',
    '- 完成后把结论与逐项证据（命令输出/文件/引用）用简洁中文回报给部门负责人会话；同时把同一份结构化结论写入 reports/wp-member-<你的成员名>-<任务代号>.json（相对工作目录，目录不存在就创建）作为结算兜底。',
    `- 结果块契约：以 ${EVIDENCE_MARKER_BEGIN} 开头、${EVIDENCE_MARKER_END} 结尾，内含合法 JSON（status ∈ done/blocked/partial、phases 三阶段、acceptance 逐条带证据）。`,
    '',
    ...threePhasePromptLines(),
  ].filter(Boolean).join('\n'))
}
