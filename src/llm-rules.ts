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
  DEFAULT_REASONING_EFFORT,
  defuseSessionReferenceText,
  EFFORT_STRENGTH_ORDER,
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
// [3.0.8] 注入 five-step 的五步提示词段落（buildDelegateePrompt 使用）。
import { fiveStepContinuationPromptLines, fiveStepPromptLines, START_EVIDENCE_MIN_CHARS_BRIEF } from './five-step.js'
// [3.0.0] 用户 2026-11-14 第 5、6、7、9 条要求的纯逻辑契约（零依赖模块）：
// 极简任务硬门槛 + 质量要求硬门槛 + 专家精简 JSON 汇报契约。
import {
  checkAtomicAssignment,
  normalizeQualityRequirements,
  renderExpertReportSpec,
  renderQualityRequirementsBlock,
} from './v3-contract.js'
// [3.1.0] 数量上限单一真源（复杂任务专家人数 12→25）：与 v3-contract 的 sources
// 上限、plan.ts 的存档消毒同一常量，杜绝「改一处漏一处」的写读不对称。
import { MAX_COMPLEX_DELEGATE_MEMBERS, MIN_COMPLEX_DELEGATE_MEMBERS } from './caps.js'

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

/** 静态强度序：单一真源是 plan.ts 导出的 EFFORT_STRENGTH_ORDER（[3.0.0] 去副本）。 */
const STATIC_STRENGTH_ORDER: readonly string[] = EFFORT_STRENGTH_ORDER

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
 * 参数）与三级全球顶尖专家任务书（buildDelegateePrompt）都调用本函数生成，文案
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
  memberRole?: 'expert'
  /** [2.5.0] 负责人已配置的整体任务等级（effortOverride），有则告知全程生效。 */
  taskEffort?: string | null
}

export function buildLlmRulesBrief(info: LlmRulesBriefInfo = {}): string {
  const family = info.family ?? classifyModelFamily(info.model ?? null)
  const allowed = info.allowed ?? allowedEffortsForModel(info.model ?? null)
  const lines = [
    '[3.0.0][LLM 推理等级强制规则——用户要求 1/2 全文（部门负责人与全球顶尖专家全员告知，必须遵守；组员角色已按用户要求 9 取消）]',
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
  if (info.taskEffort) {
    lines.push(`- 部门负责人已为本任务配置整体推理等级 \`${info.taskEffort}\`（effortOverride，负责人自配档）：本任务每次派发/重试/续跑全程沿用该等级，不得中途丢弃或覆盖；下级自己的等级以 self_effort 自配为权威（分工表档仅建议）。`)
  }
  if (info.tier === 'delegate') {
    /*
     * [3.1.7][P3 U-24/U-26] 专家规则简报不再重发五步全文与预估门禁全文。
     *
     * 旧实现这条长行把「五步前三步全文 + startPhases 结构 + 自配档 + 预估
     * 门禁」整段写一遍，而 buildDelegateePrompt 的「执行要求」与末尾
     * fiveStepPromptLines() 已经逐字包含同一份内容（T4 A01/A03：每次派发
     * 多注入 485–755 字符）。现在简报只留身份 + 指针（五步协议见任务书下方、
     * 预估义务见执行要求），关键串「执行自己的任务必须遵守五步工作法的前三步」
     * 与 startPhases 保活（守门测试钉住），正文只在任务书里出现一次。
     */
    lines.push(`- 你是部门第三层执行者（本部门相关领域全球顶尖专家${info.memberName ? `：${info.memberName}` : ''}）。执行自己的任务必须遵守五步工作法的前三步（3.0.8 单一框架，完整协议见本任务书下方「五步工作法」与「执行要求」）：先梳理任务、再研究资源/工具/方案、再备齐并给出就绪证据，然后才执行，全程少走弯路。前三步证据经 phase-0（low 档启动）由 dsh_workplan_delegate(action="self_effort") 一并提交 startPhases，未登记合格证据平台不会接续你进入正式执行。分工表给你的档位仅为建议：你必须在 phase-0 经 self_effort 按自己任务复杂度提交自配档（reasoningEffort+complexityRationale），平台登记后立即以自配档接续你执行正式任务；越界档会被钳制并留痕。开工前必须先预估本人任务耗时并经 self_effort 的 timeNotice 上报部门负责人（详见执行要求，未上报不接续）。必须确保自身任务完成品质非常高的前提下，完美、超高效率地执行。`)
  } else {
    // [2.5.4][T4][3.1.0] 人数口径同步（D1/D2）：low/未配置禁派；复杂（medium/high/xhigh/max）
    // ≥8 且 ≤25（上限随 caps.ts，环境变量可覆盖，提示词与门禁同源不漂移）。
    lines.push(`- 部门负责人（本任务书的直接接收者）强制流程（用户要求 1/2/3，3.0.8 五步工作法单框架）：你拥有本部门内的再分配权限——执行自己的任务必须先完成五步前三步（第一步任务梳理；第二步基于第一步全部结果研究资源、工具与具体实施方案；第三步把资源与工具真正备齐并给出就绪证据），正式执行与再分配全程少走弯路（先查历史教训、先验证再动手、不重复试错），经 dsh_workplan_delegate(action="review") 一并提交分工表（assignments + taskReasoningEffort）与第 1/2/3 步证据（startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }），并在 consolidation.taskReasoningEffort 里按你接到任务的复杂度配置你自己的整体推理等级（先配置后开工：phase-0 以 low 启动，登记后平台立即以自配档接续（宿主另起执行会话并携带 phase-0 产物，不是当前评估会话）进入 phase-1，重试/续跑全程生效）；第 1/2/3 步证据与分工表未提交前，dsh_workplan_delegate(action="dispatch") 会被平台拒绝（硬门禁）。梳理完成后必须把任务拆得更简单——每位下级只承担单一目标、单一主产物、可独立验收的一项工作——再合理分配给本部门多名相关领域全球顶尖专家（部门组员角色已按用户要求 9 取消，分工表只允许 role="expert"，至少 1 名；low/未配置任务禁止下派——负责人亲自执行，第 1/2/3 步证据经 dsh_workplan_delegate(action="direct") 登记（${START_EVIDENCE_MIN_CHARS_BRIEF}；可选 reasoningEffort="low"）；复杂任务（medium/high/xhigh/max）合计不少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人且最多 ${MAX_COMPLEX_DELEGATE_MEMBERS} 人，少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人硬性阻断，超过上限平台拒收（可精简名单或拆两轮派发，绝不静默丢人无痕））；每位下级必须在 phase-0 经 dsh_workplan_delegate(action="self_effort") 按自己分到的单项任务复杂度自配推理等级（轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max），专家自配为权威（分工表 per-expert 档仅建议），平台登记后以自配档接续下级会话，全程应用；平台会按上述等级集合自动钳制越界档并留痕，等级在其任务全生命周期生效且不可被覆盖。第三层为叶子层：任何第四层派发一律被拒绝。`)
    /*
     * [3.0.0] 用户 2026-11-14 第 3、5、6、7、8、10、11 条要求：负责人侧四条硬规则。
     * 与代码门禁同源（planDelegations 的 checkAtomicAssignment、comm-format 的
     * F10/F11），提示词只是把代码已经在执行的规则提前说清楚。
     */
    lines.push('- 极简任务硬门槛（用户要求 5，用户裁决 A＝硬门槛）：你派出的每一条任务必须简单到像 1+1=2——一个动作、一个主产物、一项可独立验收；出现「并且/并/同时/另外/还要/以及/分别/顺便/然后/接着/再」或分号并列、或一个任务里写了多句（含英文句点分隔的多句）、或超过 300 字符，平台直接拒绝派发（DELEGATE_TASK_NOT_ATOMIC）并给出拆分提示，实例：不要派「分析并修复并写测试」，要拆成「读 X 定位原因」「按原因改 Y」「写 Z 用例」三条。')
    lines.push('- 质量要求硬门槛（用户要求 6）：每一条分派都必须带 qualityRequirements（至少 1 条、每条 ≤400 字符、最多 8 条），写清「成果必须达到什么要求、什么算合格、怎么算不合格」；缺它平台拒绝派发（DELEGATE_QUALITY_REQUIREMENTS_MISSING）。任务书会把这块原文交给专家。')
    lines.push('- 专家汇报必须精简且是 JSON（用户要求 7）：专家完成后在证据块里给出 report（keyResults/keyInfo/importantInfo/leadRequirements 四个字符串数组，每数组 ≤6 条、每条 ≤200 字符，禁止重复）；你收到后逐条核对，缺项或重复会被格式门禁退回（F10）。')
    /*
     * [3.1.7][P3 U-32] 汇总字段清单不再在简报里重发一遍。
     *
     * 旧实现这条把 departmentSummary 的四个字段名与限额整段列出，而任务书
     * 末尾 renderCommFormatSpec('leader') 内含的 F11 契约（comm-format.ts）
     * 已经逐字给出同一份字段清单与限额（T4 A08：两份同源清单）。现在简报
     * 只留义务声明 + 指针（字段与限额见下方沟通交流格式规范 F11），关键语义
     * 「sources 必须覆盖全部已派发专家」「不合格会被退回（F11）」保活。
     */
    lines.push('- 你的汇总必须精简且是 JSON（用户要求 8/10/11）：汇总本部门全部专家汇报后，在证据块里给出 departmentSummary（字段清单与限额见本任务书下方《沟通交流格式规范》F11，sources 必须覆盖全部已派发专家，禁止累赘重复）；不合格会被退回（F11）。汇总完成后直接交回主 Agent，不需要另建文件。')
    lines.push('- 执行时间与验收：你和每位全球顶尖专家均没有总时长、单次时长、空闲或回执硬截止。开工预估及其汇总只用于协调与告知，未报齐时如实显示部分和，但不构成分钟判据；不得以耗时、预估超额或未经时间批准为由拒绝 done，extendMs 已停用。完成只由真实结果、产物、结构化证据和质量验收决定；用户显式取消与真实错误仍然有效。')
    lines.push('- 专家遇阻处置（3.0.5 硬规则，机制已强制）：任何专家调用 dsh_workplan_escalate 后，禁止用 review/dispatch/direct 把该问题改派、重派或降级给其他专家；你必须先用 action="status" 全面梳理该成员的问题与本部门全部 delegates 执行状态，再研究形成解决方案，最后用 dsh_workplan_instruct 答复原 member；平台在该成员待指示期间会硬拒一切改派动作，投递成功后强制原专家继续执行。')
  }
  return lines.join('\n')
}

/**
 * [2.3.9][T4b] 部门负责人「先全面梳理、再分配」硬门禁 + 第三层分工的纯逻辑核。
 *
 * 为什么放这里而不是 runtime.ts：这段判定是用户要求 4/5 的完整语义
 * （梳理产物齐全 → 才允许派发；至少 1 名全球顶尖专家 → 才算分工成立；
 * 每位下级的推理等级 → 必须在当前模型家族等级集合内，越界按要求 1/2
 * 自动钳制并留痕），不依赖宿主会话/子会话服务，可被 delegateTool 与测试
 * 同口径消费——门禁不能被提示词绕过，只能被这段代码绕过，而这段代码是
 * 唯一入口。
 */
export interface ConsolidationInput {
  /**
   * [3.0.8] 五步工作法单框架收口：负责人 review 的 consolidation 不再携带
   * problemAnalysis/constraints/unknowns/approach/approachBasis（原两轮思考
   * 产物）——第 1/2/3 步证据改由 startPhases 承载，经开工闸
   * validateStartPhaseEvidence 判据（与主 Agent/专家同一口径），登记后 durable
   * 持久化，review/dispatch/direct 共用。consolidation 只留分工表与整体等级配置。
   */
  assignments?: unknown
  /**
   * [2.5.0] 用户要求 2：部门负责人为「整个任务」配置的整体推理等级。
   * 配置后全程生效——本任务每次派发/重试/续跑都优先读它（状态行
   * effortOverride），下级未单独配置档位时也继承它。缺失=不覆盖。
   */
  taskReasoningEffort?: unknown
  /**
   * [2.5.5][T3][3.1.0 扩展] 平台写入的钳制前声明记忆（review 时的原始声明，由
   * runtime 持久化、dispatch 读回）。消费方有两处且同源：low 禁派闸（防非 qwen
   * 系 medium 被钳制后 low 误杀）与 complexTask 复杂判定（[3.1.0] 治本：dispatch
   * 复读若只看钳制后 taskReasoningEffort，已放行的 8–25 人名单会被回落成 cap=6
   * 静默截断——旧实现注释自称「强制语义不破」，实际截断发生在分工表复读，矛盾）。
   * review 新输入不得携带（runtime 调用点剥离＋host schema additionalProperties:false
   * 拒绝），否则 {taskReasoningEffort:'low', taskReasoningEffortDeclared:'max'} 可绕过禁派闸。
   */
  taskReasoningEffortDeclared?: unknown
}

export interface DelegationAssignment {
  member: string
  /**
   * [3.0.0][用户要求 9] 部门组员角色已取消：任务只派给本部门相关领域全球顶尖专家。
   * 历史数据里的 `role: "member"` 在读取时归一为 expert（回放兼容），新派发不再接受。
   */
  role: 'expert'
  /** 负责人把任务派下去时必须交代清楚的成果质量要求（用户要求 6）。 */
  qualityRequirements: string[]
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
  /** [2.5.0] 负责人配置的整体任务等级（已按模型家族钳制）；null=未配置。 */
  taskEffort: string | null
  /** [2.5.0] 整体任务等级的越界钳制留痕；null=未配置或未越界。 */
  taskEffortClamped: { requested: string; corrected: string; reason: string } | null
  /**
   * [2.5.5][T3] 钳制前原始声明（供平台持久化为 consolidation.taskReasoningEffortDeclared，
   * dispatch 读回时供禁派闸消费）；null=未配置。可选字段：不改各显式错误返回的形状。
   */
  taskEffortDeclared?: string | null
  consolidation?: {
    assignments: number
    taskReasoningEffort?: string | null
  }
}

const MAX_DELEGATE_MEMBERS = 6
/*
 * [3.1.0] 复杂人数下限 8 / 上限 25（原 12）已收口到 caps.ts（单一真源，含环境
 * 变量覆盖 DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS）。D1/D2 语义不变：复杂任务
 * （声明档 medium/high/xhigh/max）少于 8 人硬性阻断；low/未配置保持禁派
 * （MAX_DELEGATE_MEMBERS=6 仅保留给历史/非法档路径，正常低档位在禁派闸已被拦）。
 */
// const MIN_COMPLEX_DELEGATE_MEMBERS / MAX_COMPLEX_DELEGATE_MEMBERS → ./caps.ts
/** [2.5.4][T4] D1：除 low 外全部算复杂——medium/high/xhigh/max 均触发 ≥8 人门禁，xhigh 不豁免。 */
const COMPLEX_DECLARED_EFFORTS: readonly string[] = Object.freeze(['medium', 'high', 'xhigh', 'max'])

// [3.0.8] 梳理产物（problemAnalysis/approach/approachBasis 等）已随两轮思考
// deepThink 门禁废除，分工表闸不再读取清单字段，readTrimmedStrings 一并退役。

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
  /**
   * [2.5.0][R2×R4] 状态行已持久化的整体等级（effortOverride）回落源：
   * 梳理产物未带 taskReasoningEffort 时（尝试重置清掉 consolidation 后重新
   * review、或旧梳理产物回放）继承它——整体等级是任务级配置，重试/续跑
   * 全程不丢；两者都缺失才回落 low。
   */
  taskEffortFallback?: unknown
  /**
   * [2.5.5][T3] D1 兜底：任务行记录等级（计划定义 subtask.reasoningEffort，
   * 经 runtime findSubtaskById 读取并五档消毒后传入）。仅参与 low 禁派判定链，
   * 不参与 complexTask/memberCap/≥8 判据（S4：非 low 行为零变化）。
   * 缺失/非法由调用方归一为 undefined（视同未配置）。
   */
  taskRowEffort?: unknown
}): DelegationPlan {
  const empty = { ok: false as const, code: 'DELEGATE_CONSOLIDATION_MISSING', members: [], clamped: [], taskEffort: null, taskEffortClamped: null }
  const consolidation = input?.consolidation
  if (!consolidation || typeof consolidation !== 'object') {
    return { ...empty, error: '尚未提交分工表：先用 dsh_workplan_delegate(action="review") 提交分工表（assignments + taskReasoningEffort），派发才会放行（用户要求 4 的硬门禁）。' }
  }
  /*
   * [3.0.8] 深度梳理质量闸（problemAnalysis≥40 字）已随两轮思考 deepThink 门禁
   * 一并废除：第 1/2/3 步证据（problemAnalysis/approach/approachBasis/resources/
   * tools/preparation）改由开工闸 startPhases 承载（validateStartPhaseEvidence，
   * review 时随 consolidation 一并校验），同一判据不再两处重复。此处只校验
   * 分工表与整体等级，拒因顺序不变。
   */
  /*
   * [2.5.4][T4][3.1.0 治本] 复杂判定必须用「声明档」（钳制前），且优先消费平台
   * 持久化的钳制前声明记忆 taskReasoningEffortDeclared：
   * declared = taskReasoningEffortDeclared ?? taskReasoningEffort ?? taskEffortFallback。
   *
   * 原因（D1 + 3.1.0 实测缺陷）：correctEffortForModel 在非 qwen 系会把 medium
   * 钳到 low；review 通过后宿主把钳制后值写回 consolidation.taskReasoningEffort，
   * dispatch 读回时若只看该字段，complexTask 会被误判成 false → memberCap 从
   * 25 回落成 6 → review 放行的 8–25 人名单被静默截断（tests C1 用例实测复现：
   * 8 人名单派发只剩 6 人）。旧注释自称「分工表已是 review 放行的 ≥8 人名单，
   * 强制语义不破」——但截断恰恰发生在 dispatch 复读分工表时，注释与行为矛盾，
   * 3.1.0 起按声明记忆判定，两入口完全一致。
   *
   * TASK_EFFORT_INVALID 校验与其余各闸位置一律不动，既有拒因顺序完全保持。
   */
  const declaredEffort = consolidation.taskReasoningEffortDeclared ?? consolidation.taskReasoningEffort ?? input.taskEffortFallback
  const complexTask = typeof declaredEffort === 'string' && COMPLEX_DECLARED_EFFORTS.includes(declaredEffort)
  /*
   * [2.5.5][T3] 用户裁决 D1/D2/D3：low（含未配置视同 low）任务禁止第三层下派。
   * 判定链＝钳制前声明记忆 → 声明档 → effortOverride → 任务行记录等级 → 皆缺视同 low。
   * 消费条件：仅合法五档值或缺失触发本闸；非法字符串穿透到下方
   * DELEGATE_TASK_EFFORT_INVALID 报错轨（裁决配套明示，拒因顺序不变）。
   * 与 complexTask 解耦：本闸只判「是否禁派」，人数/上限判据一行不动（S4）。
   * 钳制前判定（D1）：banDeclared 消费原始声明，不经 correctEffortForModel。
   */
  const banDeclared = consolidation.taskReasoningEffortDeclared ?? declaredEffort ?? input.taskRowEffort
  const banConsumable = banDeclared === undefined || banDeclared === null
    || (typeof banDeclared === 'string' && REASONING_EFFORTS.includes(banDeclared))
  const banComplex = typeof banDeclared === 'string' && COMPLEX_DECLARED_EFFORTS.includes(banDeclared)
  if (banConsumable && !banComplex) {
    return {
      ...empty,
      code: 'DELEGATE_LOW_TASK_FORBIDDEN',
      error: '本任务为 low 档（或未配置，视同 low）：按用户裁决 D1–D5 禁止第三层下派，review/dispatch 一律硬拒，无任何例外通道。请部门负责人亲自执行：完成五步第 1/2/3 步（任务梳理 + 资源/工具/方案研究 + 准备）后经 dsh_workplan_delegate(action="direct") 登记 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }（' + START_EVIDENCE_MIN_CHARS_BRIEF + '；可选 reasoningEffort="low"；不接受分工表），平台将以 low 档接续（宿主另起执行会话并携带登记产物）由你亲自执行。已完成的历史派发不回溯。[3.2.0] 收尾纪律：有登记证据时 phases.planning / phases.preparation 可省略——平台自动并入并集落账（登记永不丢失），不要重抄；无登记时才须自带这两组。',
    }
  }
  const memberCap = complexTask ? MAX_COMPLEX_DELEGATE_MEMBERS : MAX_DELEGATE_MEMBERS
  /*
   * [3.1.0] 不再静默截断：完整分工表进入校验链，超上限由下方 DELEGATE_HEADCOUNT_MAX
   * 闸明确拒收（可照做的精简/拆两轮指引）。旧实现在这里 slice(0, memberCap)，
   * 交 26 人只派前 25 人、丢 1 人无痕——用户裁决废止该行为。
   */
  const assignments = Array.isArray(consolidation.assignments) ? consolidation.assignments : []
  if (assignments.length === 0) {
    return { ...empty, code: 'DELEGATE_CONSOLIDATION_INCOMPLETE', error: '梳理产物不完整：分工表 assignments 至少 1 条（member/role/task/reasoningEffort 四项齐全）。' }
  }
  const allowed = allowedEffortsForModel(input.model ?? null)
  /*
   * [2.5.0] 用户要求 2：负责人为整个任务配置的整体推理等级。
   * 非法值（不在五档存储全集内）走 A3 报错轨明确拒绝；越出当前模型家族
   * 合法集合走 A3 修正轨自动钳制并留痕——与下级档位同一判据，绝不中断派发。
   */
  /*
   * [2.5.0][R2×R4] 梳理产物未带整体等级时回落状态行已持久化的 effortOverride
   * （taskEffortFallback）：尝试重置会清掉 consolidation 但保留 effortOverride，
   * 重新 review/旧梳理回放时整体等级不得因此丢失（全程贯穿）。
   */
  const rawTaskEffort = consolidation.taskReasoningEffort !== undefined && consolidation.taskReasoningEffort !== null
    ? consolidation.taskReasoningEffort
    : input.taskEffortFallback
  if (rawTaskEffort !== undefined && rawTaskEffort !== null
    && !(typeof rawTaskEffort === 'string' && REASONING_EFFORTS.includes(rawTaskEffort))) {
    return {
      ...empty,
      code: 'DELEGATE_TASK_EFFORT_INVALID',
      error: `taskReasoningEffort "${String(rawTaskEffort)}" 非法：必须是 low / medium / high / xhigh / max 之一（负责人为整个任务配置的整体推理等级；缺失=不覆盖）。`,
    }
  }
  let taskEffort: string | null = typeof rawTaskEffort === 'string' ? rawTaskEffort : null
  let taskEffortClamped: DelegationPlan['taskEffortClamped'] = null
  if (taskEffort !== null && allowed !== null && !allowed.includes(taskEffort)) {
    const correction = correctEffortForModel(taskEffort, input.model ?? null)
    taskEffortClamped = { requested: taskEffort, corrected: correction.effort, reason: correction.reason ?? '' }
    taskEffort = correction.effort
  }
  const members: DelegationAssignment[] = []
  const clamped: DelegationPlan['clamped'] = []
  let experts = 0
  for (let index = 0; index < assignments.length; index += 1) {
    const item: any = assignments[index] ?? {}
    const member = truncate(String(item.member ?? '').trim(), 80)
    /*
     * [3.0.0][用户要求 9] 只保留专家角色：role 必须写 expert（历史数据里的
     * member 归一为 expert，保证旧计划回放可继续派发）；缺 role 仍按
     * ASSIGNMENT_INVALID 拒绝，拒因语义不变。
     */
    const roleInput = String(item.role ?? '').trim().toLowerCase()
    const role = roleInput === 'expert' ? 'expert' : roleInput === 'member' ? 'expert' : ''
    const qualityRequirements = normalizeQualityRequirements(item.qualityRequirements)
    const task = truncate(String(item.task ?? '').trim(), 1500)
    if (!member || !role || !task) {
      return {
        ok: false,
        code: 'DELEGATE_ASSIGNMENT_INVALID',
        members: [],
        clamped: [],
        taskEffort: null,
        taskEffortClamped: null,
        error: `分工表第 ${index + 1} 条不完整：member（专家姓名/代号）、role（只能是 expert）、task（分到的任务）三者都必须非空。部门组员角色已取消，任务只派给本部门相关领域全球顶尖专家。`,
      }
    }
    /*
     * [2.5.0] 用户要求 2/3：下级未单独配置档位时，继承负责人为整个任务
     * 配置的整体等级（taskEffort）；负责人也没配置时回落 low——简单任务
     * 用低档，不再无条件取家族最高档（旧默认会让简单任务烧最高档）。
     * 显式配置的档位仍优先，越界钳制规则不变。
     */
    const requested = REASONING_EFFORTS.includes(item.reasoningEffort)
      ? String(item.reasoningEffort)
      : (taskEffort ?? 'low')
    const outOfSet = allowed !== null && !allowed.includes(requested)
    const correction = outOfSet ? correctEffortForModel(requested, input.model ?? null) : null
    const effort = correction ? correction.effort : requested
    if (correction) {
      clamped.push({ member, requested, corrected: correction.effort, reason: correction.reason ?? '' })
    }
    experts += 1
    members.push({
      member,
      role,
      qualityRequirements,
      task,
      effort,
      ...(outOfSet ? { requested, correctionReason: correction?.reason } : {}),
    })
  }
  /*
   * [3.0.0][用户要求 9] 组员角色取消后，角色配比门禁只剩一条：至少 1 名专家。
   * 拒绝码随之改名（DELEGATE_ROLE_MIX_REQUIRED → DELEGATE_EXPERTS_REQUIRED），
   * 因为已不存在「配比」可言。
   */
  if (experts === 0) {
    return {
      ok: false,
      code: 'DELEGATE_EXPERTS_REQUIRED',
      members: [],
      clamped: [],
      taskEffort: null,
      taskEffortClamped: null,
      error: '分工表必须至少包含 1 名「本部门相关领域全球顶尖专家」：部门组员角色已取消（用户要求 9），任务只派给专家。',
    }
  }
  /*
   * [3.0.8] 两轮思考产物闸（approach≥40 字 / approachBasis≥20 字）已废除：第 1/2
   * 步证据经 review 的 startPhases 开工闸校验（与主 Agent/专家同一判据），不再在
   * 分工表闸重复。下方直接是复杂任务人数下限闸，拒因顺序不变。
   */
  /*
   * [3.1.0] 分工表人数上限硬门禁（用户裁决：超限拒收，不留「丢人无痕」）：
   * 完整名单（经上方逐条校验合法后）超过本任务上限即整单拒绝，并给出两条
   * 可照做的出路（精简 / 拆两轮）。位置在 MIN 闸之前：26 人先收到「超上限」
   * 而非「少于 8 人」这类误导性拒因；7 人则自然落到下方 MIN 闸。
   */
  if (members.length > memberCap) {
    return {
      ok: false,
      code: 'DELEGATE_HEADCOUNT_MAX',
      members: [],
      clamped: [],
      taskEffort: null,
      taskEffortClamped: null,
      error: `分工表当前 ${members.length} 人，超过${complexTask ? '复杂任务' : '本任务'}上限 ${memberCap} 人（平台 3.1.0 起不再静默截断，不留「丢人无痕」）。两条可照做的出路：1) 精简名单——把可合并/最弱的几项砍掉或合并成一项，重新 review；2) 拆成两轮——第一轮先派最关键的 ≤${memberCap} 人，收齐后用 dsh_workplan_delegate(action="review"/"dispatch") 补派剩余部分。`,
    }
  }
  /*
   * [2.5.4][T4] 用户决策 D1/D2 人数下限硬门禁：
   * 复杂任务（声明档 medium/high/xhigh/max）expert+member 合计必须 ≥8 人，
   * 不足直接阻断分派。人数按完整分工表计（3.1.0 起无截断，上限闸已在上方）。
   * 放在拒因链最后：既有拒因顺序完全不变。
   */
  if (complexTask && members.length < MIN_COMPLEX_DELEGATE_MEMBERS) {
    return {
      ok: false,
      code: 'DELEGATE_HEADCOUNT_MIN',
      members: [],
      clamped: [],
      taskEffort: null,
      taskEffortClamped: null,
      error: `复杂任务（声明档 ${String(declaredEffort)}）按用户决策 D1/D2 须合计 ≥${MIN_COMPLEX_DELEGATE_MEMBERS} 人（组员角色已取消，全部为专家），当前 ${members.length} 人；请把任务拆得更简单（单一目标/单一主产物/可独立验收，简单到 1+1=2）并扩充分工表后重新 review/dispatch。`,
    }
  }
  /*
   * [3.0.0][用户要求 5/6 + 用户裁决 A] 极简任务与质量要求硬门槛（新增的最后一道闸）。
   *
   * 每一条分派都必须简单到 1+1=2（单一目标、单句、无并列多目标），并且必须
   * 交代清楚成果的质量要求；不满足即拒绝派发并给出可照做的拆小指令
   * （用户裁决 A：硬门槛，不软放）。
   *
   * 位置：既有 8 道拒因之后、放行之前——2.5.4 的拒因顺序与语义一字不变，
   * 新闸只在旧门禁全部通过时才生效，历史用例不会因新闸改变原有诊断。
   */
  for (let index = 0; index < members.length; index += 1) {
    const item = members[index]
    const atomic = checkAtomicAssignment(item.task, item.qualityRequirements)
    if (!atomic.ok) {
      return {
        ok: false,
        code: atomic.code ?? 'DELEGATE_TASK_NOT_ATOMIC',
        members: [],
        clamped: [],
        taskEffort: null,
        taskEffortClamped: null,
        error: `分工表第 ${index + 1} 条（${item.member}）不合格：${atomic.error}${atomic.hint ? ` 拆小要求：${atomic.hint}` : ''}`,
      }
    }
  }
  return {
    ok: true,
    members,
    clamped,
    taskEffort,
    taskEffortClamped,
    // [2.5.5][T3] 钳制前原始声明随 ok 返回，供平台持久化为 taskReasoningEffortDeclared。
    taskEffortDeclared: typeof rawTaskEffort === 'string' ? rawTaskEffort : null,
    consolidation: {
      assignments: members.length,
      taskReasoningEffort: taskEffort,
    },
  }
}

/**
 * [2.5.0] 用户要求 2 的执行侧单一判据：子任务每次激活（首发/重试/续跑）
 * 读取推理等级的唯一入口。负责人配置的整体等级（状态行 effortOverride）
 * 优先于规划器写死的 subtask.reasoningEffort；两者都缺失/非法时回落
 * DEFAULT_REASONING_EFFORT。纯函数，派发链与测试同口径消费——「全程应用」
 * 不可能在某一环悄悄回落。
 */
export function resolveTaskEffort(input: { override?: unknown; planned?: unknown }): string {
  if (typeof input.override === 'string' && REASONING_EFFORTS.includes(input.override)) return input.override
  if (typeof input.planned === 'string' && REASONING_EFFORTS.includes(input.planned)) return input.planned
  return DEFAULT_REASONING_EFFORT
}

/**
 * [2.3.9][T4b] 第三层任务书：部门负责人 → 全球顶尖专家子会话。
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
  /**
   * [3.1.9][省钱] true = phase-1 接续任务书：前三步已在 phase-0 登记，
   * 只渲染第四步/第五步与门禁（fiveStepContinuationPromptLines）。
   * 缺省 false，保持旧调用方/旧测试逐字不变。
   */
  continuation?: boolean
}): string {
  const roleLabel = '本部门相关领域全球顶尖专家'
  const qualityBlock = renderQualityRequirementsBlock(input.member.qualityRequirements ?? [], '部门负责人')
  return defuseSessionReferenceText([
    `你是「${input.departmentLabel ?? '部门'}」的${roleLabel}（${input.member.member}），由部门负责人直接分配，只负责下面这一项分配到的工作。`,
    `负责人任务：${input.leaderSubtaskId ?? ''} ${input.leaderSubtaskTitle ?? ''}`,
    `你的任务：${input.member.task}`,
    `工作目录：${input.cwd || '（未知）'}`,
    '',
    ...(qualityBlock ? [qualityBlock, ''] : []),
    ...(input.extraContext ? ['', input.extraContext] : []),
    '',
    input.rulesBrief,
    '',
    '执行要求（用户强制要求 5 原文口径）：',
    /*
     * [3.1.7][P3 U-27] 首条不再逐字重发五步前三步全文。
     *
     * 旧实现这条把「第一步…第二步…第三步…」整段写一遍，而本任务书末尾的
     * fiveStepPromptLines() 已经逐字包含同一份协议（T4 A04：开头段与执行
     * 要求首条重复 58+ 字符）。现在首条只留义务声明 + 指针 + 第四步纪律
     * （少走弯路），关键串「先全面、全盘、深入梳理、研究、思考自己的任务」
     * 「基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案」
     * 「方法、流程、步骤」「approachBasis」「startPhases」全部保活——它们
     * 在下方五步协议里逐字存在，守门测试（workplan-251-deep-think）不变。
     */
    '- 执行自己的任务：五步工作法的前三步已在 phase-0 经 self_effort 提交 startPhases 并登记（本任务书即 phase-1 接续），已登记内容不要重做、不要重复登记，直接从第四步执行；只有登记范围之外、执行确实需要的细节缺口，才先补齐（只补缺口，不推倒重来）。开工前仍须先全面、全盘、深入梳理、研究、思考自己的任务，并基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案（方法、流程、步骤，含 approachBasis 依据）——这一步只做核对与增量补充，不重复登记；第四步执行必须严格基于第二步理清的方法、流程、步骤，全程少走弯路（先查历史教训、先验证再动手、不重复试错）。',
    '- 你的推理等级以自配为权威（分工表档仅建议）：phase-0（low 档启动）唯一职责是经 dsh_workplan_delegate(action="self_effort") 提交自配档；phase-1 以登记生效的自配档全程应用（规划、执行、验证、复盘全生命周期），不得自行换档。',
    '- 开工前必须先预估本人任务耗时（整数分钟）并经 self_effort 的 timeNotice={ declaredMinutes: 正整数分钟, reason? } 上报部门负责人，未上报不接续（T6/D9 硬门禁：ESTIMATE_MISSING/ESTIMATE_INVALID）；该上报只是协调信息，必须如实预估。你和部门负责人执行任务均没有总时长、单次时长、空闲或回执硬截止；预估或实际耗时不会触发延期、超时接手，也不影响 done 验收。',
    '- 必须在确保自身任务完成品质非常高的前提下，完美、超高效率地执行；严禁低效执行与浪费 token。',
    '- 你是第三层叶子执行者：不得派生任何第四层 Agent/子会话；无法完成时在结论首行写 BLOCKED: 原因 并说明缺什么，不要空转。',
    '- 遇阻上报通道（3.0.5 四步闭环）：遇阻（缺权限/缺输入/依赖产物缺失/需求自相矛盾/无法验证/需要负责人决定方向）时，第一动作是调用 dsh_workplan_escalate({ "question": "需要负责人回答的单个问题", "options": ["可选方向"], "needs": ["需要谁提供什么"] })。流程必须严格为：你先向部门负责人报告具体问题→负责人全面梳理你的问题与本部门全部已派发任务执行状态→负责人研究形成解决方案→负责人用 dsh_workplan_instruct 把方案告诉你→你继续执行原任务。平台禁止负责人在你待指示期间把你改派给其他专家；你必须是继续执行的人。调用 escalate 成功后停止推进、只做只读核对，不要自行选定一个选项继续。',
    '- 完成后把结论与逐项证据（命令输出/文件/引用）用简洁中文回报给部门负责人会话；同时把同一份结构化结论写入 reports/wp-member-<你的成员名>-<任务代号>.json（相对工作目录，目录不存在就创建）作为结算兜底。',
    `- 结果块契约：以 ${EVIDENCE_MARKER_BEGIN} 开头、${EVIDENCE_MARKER_END} 结尾，内含合法 JSON（status ∈ done/blocked/partial、phases 证据、acceptance 逐条带证据）。有 phase-0 登记时 phases.planning / phases.preparation 可省略（平台自动并入），execution / verification 与顶层字段必交；无登记时四组齐全。`,
    '',
    renderExpertReportSpec(),
    '',
    ...(input.continuation ? fiveStepContinuationPromptLines() : fiveStepPromptLines()),
  ].filter(Boolean).join('\n'))
}

/**
 * [2.5.0][自配档] phase-0 任务书（叶子）：唯一职责=评估复杂度+提交 self_effort。
 * extraContext 可携带重试简报（重派仍未自配时不丢已完成部分）。
 */
export function buildPhaseZeroDelegateePrompt(input: { departmentLabel?: string; member: DelegationAssignment; cwd?: string; extraContext?: string }) {
  const roleLabel = '本部门相关领域全球顶尖专家'
  const qualityBlock = renderQualityRequirementsBlock(input.member.qualityRequirements ?? [], '部门负责人')
  return [
    `你是「${input.departmentLabel ?? '部门'}」的${roleLabel}（${input.member.member}），当前处于 phase-0（先配置后开工，low 档启动）。`,
    `你分到的任务：${input.member.task}`,
    ...(qualityBlock ? [qualityBlock] : []),
    `工作目录：${input.cwd || '（未知）'}`,
    ...(input.extraContext ? ['', input.extraContext] : []),
    '本阶段唯一职责（先配置+先研究准备，后开工）：评估你分到的单项任务的复杂度，并完成五步工作法前三步（任务梳理、资源/工具/方案研究、准备就绪），然后调用 dsh_workplan_delegate(action="self_effort") 一次性提交：member（你的成员名＝上面括号里的名字，必填，平台据此在台账认亲）+ reasoningEffort（你的自配推理等级：轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max）+ complexityRationale（复杂度依据，必填）+ startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }（第 1/2/3 步证据，必填）+ timeNotice={ declaredMinutes: 正整数分钟, reason? }（开工前预估，必填）。未提交/不合格预估会被硬拒（ESTIMATE_MISSING/ESTIMATE_INVALID）：没有告知部门负责人预估时间，先拦截，再告知此人，你必须自己预估时间，汇报给对应负责人后，才可以重试或继续执行。',
    'startPhases 五步前三步口径（与主 Agent/负责人同一判据）：第一步 problemAnalysis=先全面、全盘、深入梳理、研究、思考自己分到的任务（目标与验收/现状/事实/约束/未知/主要矛盾/边界，合计≥40字）；第二步 resources=需要哪些资源（数据/文件/权限/人/知识/时间，合计≥20字）+ tools=需要哪些工具、每个用来做什么（合计≥10字）+ approach=基于第一步完成好的所有结果理清的具体一步步执行、确保完美完成的方法、流程和步骤（合计≥40字，含如何少走弯路：先查历史教训、先验证再动手、不重复试错）+ approachBasis=第二步如何基于第一步全部结果的依据对应（合计≥20字）；第三步 preparation.prepared=已备齐的资源/工具清单（合计≥20字）+ preparation.evidence=逐项就绪证据（命令输出/文件路径/配置项/版本号/引用，合计≥20字）。',
    '不要执行任务本身，不得派生任何第四层 Agent/子会话。缺交或不合格 startPhases 会被硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），不登记、不接续。三项齐全提交后结束本回合；平台会立即以你的自配档接续（宿主另起执行会话并携带本阶段产物，不是当前评估会话）进入 phase-1（正式任务），正式执行必须严格按你第二步理清的方法、流程、步骤进行。越界档由平台按模型家族合法集合钳制并留痕。',
  ].join('\n')
}
