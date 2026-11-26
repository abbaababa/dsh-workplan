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
// [3.2.9] 执行通道判定：顺序链之外的「跨源矛盾裁决 / 单决策 / 共享可变状态」
// 同样不能拆给多个互相看不见的上下文；与 plan.ts 的提示词行共用同一函数。
import { decideDelegationStrategy, type DelegationStrategy } from './context-strategy.js'
// [3.0.0] 用户 2026-11-14 第 5、6、7、9 条要求的纯逻辑契约（零依赖模块）：
// 极简任务硬门槛 + 质量要求硬门槛 + 专家精简 JSON 汇报契约。
import {
  checkAtomicAssignment,
  detectSequentialChainTask,
  normalizeQualityRequirements,
  renderExpertReportSpec,
  renderQualityRequirementsBlock,
} from './v3-contract.js'
// [3.1.0] 数量上限单一真源（复杂任务专家人数 12→25）：与 v3-contract 的 sources
// 上限、plan.ts 的存档消毒同一常量，杜绝「改一处漏一处」的写读不对称。
import { MAX_COMPLEX_DELEGATE_MEMBERS, MIN_COMPLEX_DELEGATE_MEMBERS, leaderPreRegisterEnabled } from './caps.js'

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
  '1. qwen 开头模型：推理等级仅 {low、medium、xhigh}（轻度=low，较复杂=medium，非常复杂=xhigh）。',
  '2. 非 qwen 模型：推理等级仅 {low、high、max}（轻度=low，较复杂=high，非常复杂=max）。',
  '2.1 越界档按强度就近降级（不升档）：非 qwen 写 medium→low、xhigh→high；qwen 写 high→medium、max→xhigh，请直接写本家族档位。',
].join('\n')

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
  taskEffort?: string | null
  phase1?: boolean
}

export function buildLlmRulesBrief(info: LlmRulesBriefInfo = {}): string {
  const family = info.family ?? classifyModelFamily(info.model ?? null)
  const allowed = info.allowed ?? allowedEffortsForModel(info.model ?? null)
  const lines = [
    '[LLM 推理等级规则（全员告知）]',
    LLM_REASONING_RULES_TEXT,
    `- 本会话模型：${info.model || '未知'}`
      + (info.model ? `（${family === 'qwen' ? 'qwen' : '非 qwen'}）` : '')
      + (allowed ? `；可用 {${allowed.join(', ')}}` : ''),
  ]
  if (info.effort) {
    const adjusted = Boolean(info.requested) && info.requested !== info.effort
    lines.push(`- 本任务等级 \`${info.effort}\`，全程应用`
      + (adjusted
        ? `（请求 \`${info.requested}\` 已按家族钳制${info.correctionReason ? `：${info.correctionReason}` : ''}）。`
        : '。'))
  }
  if (info.taskEffort) {
    lines.push(`- 负责人整体等级 \`${info.taskEffort}\`（effortOverride）：全程沿用，下级以 self_effort 自配为权威。`)
  }
  if (info.tier === 'delegate') {
    if (info.phase1) {
      lines.push('- 第三层全球顶尖专家（phase-1 接续）：已登记自配档与前三步开工证据，直接按自配档执行第四/五步，少走弯路；不得派生第四层。')
    } else {
      lines.push(`- 第三层全球顶尖专家${info.memberName ? `（${info.memberName}）` : ''}：执行自己的任务必须遵守五步工作法的前三步（见任务书）；phase-0 经 self_effort 交 startPhases+reasoningEffort+complexityRationale+timeNotice（开工前预估，整数分钟），按自配档接续，少走弯路。`)
    }
  } else if (info.phase1) {
    lines.push(
      `- 部门负责人强制流程（phase-1 接续）：前三步已登记勿重做；review 交分工表后 dispatch（role="expert"，复杂 ${MIN_COMPLEX_DELEGATE_MEMBERS}-${MAX_COMPLEX_DELEGATE_MEMBERS} 人，单阶段/顺序链豁免下限；low/未配置禁下派走 direct；禁派生第四层；status 查进度）。`
      + (leaderPreRegisterEnabled() ? 'assignments 附 startPhases+timeNotice 可免专家 phase-0（可省）。' : ''),
    )
    lines.push('- 门禁：每项带 qualityRequirements（1-8 条 ≤400 字，缺拒 DELEGATE_QUALITY_REQUIREMENTS_MISSING）+ 原子单句 ≤300 字（DELEGATE_TASK_NOT_ATOMIC）；强耦合/顺序链/共享状态禁拆多人（DELEGATE_COUPLED_SPLIT），>5 人建议每批 ≤5 人；专家 F10、负责人 F11；无执行截止（extendMs 停用）；escalate 后禁改派，先 status 再 instruct 原 member。')
  } else {
    lines.push(
      `- 部门负责人强制流程：执行自己的任务必须先完成五步前三步，经 dsh_workplan_delegate(action="review") 交分工表与 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }；phase-0 low 启动，登记后按自配档接续 phase-1。派给本部门 expert（≥1 名，组员已取消）；low/未配置任务禁止下派——负责人亲自执行，第 1/2/3 步证据经 dsh_workplan_delegate(action="direct") 登记（${START_EVIDENCE_MIN_CHARS_BRIEF}；可选 reasoningEffort="low"）；复杂任务（medium/high/xhigh/max）合计不少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人且最多 ${MAX_COMPLEX_DELEGATE_MEMBERS} 人，少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人硬性阻断（**单阶段计划与顺序推理链一样豁免此下限**，别为了凑人数去拆无意义的独立专家），超过上限平台拒收（可精简名单或拆两轮派发，绝不静默丢人无痕）。专家自配为权威，禁派生第四层，action="status" 查进度。`
      + (leaderPreRegisterEnabled() ? '【默认开·预登记】assignments 附 startPhases+timeNotice 可免专家跑 phase-0 直入执行（可省，fail-open）。' : ''),
    )
    lines.push('- 分工与汇报门禁：每条必带 qualityRequirements（1-8 条、≤400 字，缺拒 DELEGATE_QUALITY_REQUIREMENTS_MISSING）且一动作/一主产物/单句 ≤300 字无并列词（DELEGATE_TASK_NOT_ATOMIC）；顺序链/跨源矛盾裁决/单决策/共享可变状态禁拆多人（DELEGATE_COUPLED_SPLIT），>5 人建议每批 ≤5 人分批派发；专家按 F10、负责人按 F11；无执行硬截止（extendMs 停用）；escalate 后禁改派，先 status 再 instruct 原 member。')
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
  /**
   * [3.2.4][O1] 负责人预登记的该成员五步第 1/2/3 步开工证据（仅当环境变量
   * DSH_WORKPLAN_LEADER_PRE_REGISTER 非 0 时被派发侧消费，3.2.6 起默认开；消毒在派发侧
   * sanitizeStartPhaseEvidence，非法照旧走 phase-0）。
   */
  startPhases?: unknown
  /** [3.2.4][O1] 负责人预登记的开工前预估 {declaredMinutes, reason?}（同上，派发侧校验）。 */
  timeNotice?: unknown
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
  /**
   * [3.2.9] 本次分工的执行通道判定（与提示词、耦合闸同一函数）。
   * 只对 ok:true 的成功返回携带；旧的错误返回形状不变。
   */
  contextStrategy?: DelegationStrategy
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
  /**
   * [3.2.3] 父子任务的 objective+method：用于「顺序推理链不得拆成多个独立
   * 专家上下文」硬闸。只有负责人会话调用时传入；缺失则跳过该闸（旧调用方零回归）。
   */
  parentTaskText?: string
  /**
   * [3.2.4][O8] 单阶段计划豁免标记（计划 stages.length === 1）：「可并行拆分」
   * 的 ≥8 人下限是为多阶段并行设计的，对单阶段任务只会制造无解死锁，豁免之。
   * 缺省 false（旧调用方零回归）。
   */
  singleStagePlan?: boolean
  /** 可选：覆盖默认复杂任务人数下限（缺省读取 caps.MIN_COMPLEX_DELEGATE_MEMBERS）。 */
  minHeadcount?: number
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
      // [3.2.4][O1] 负责人预登记载荷原样透传（派发侧消毒消费；未携带即缺省）。
      ...(item.startPhases !== undefined ? { startPhases: item.startPhases } : {}),
      ...(item.timeNotice !== undefined ? { timeNotice: item.timeNotice } : {}),
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
   * [3.2.3] 顺序推理链硬闸：父任务要求按固定顺序推理（先…再/逐步/基于上一步
   * 结论）时，禁止把彼此依赖的中间步骤分给多个独立上下文的专家。每位专家
   * 只拿到自己的任务书与上游摘要，读不到上一步的完整推理，强行并行会打断
   * 连续性并放大协调成本。合法出路：只派 1 名专家从头到尾一次做完（豁免
   * 复杂任务 ≥8 人下限——该下限为可并行拆分设计，链式任务不可并行拆），
   * 或——仅当任务为 low/未配置档——负责人亲自执行（direct）。
   * 位置在人数上下限闸之前：否则复杂链式任务会陷入「≥8 人被链闸拒、
   * 1 人被 MIN 闸拒」的无解死锁，反复重试纯烧 token。
   */
  let sequentialChain = false
  let chainMarkers: string[] = []
  if (typeof input.parentTaskText === 'string' && input.parentTaskText.trim()) {
    const chain = detectSequentialChainTask(input.parentTaskText)
    sequentialChain = chain.sequential
    chainMarkers = chain.markers
    if (chain.sequential && members.length > 1) {
      return {
        ...empty,
        code: 'DELEGATE_SEQUENTIAL_CHAIN_SPLIT',
        error: `本子任务是一条必须按顺序展开的推理链（命中：${chain.markers.join('、')}），不得拆给 ${members.length} 名独立专家：每名专家只有自己的上下文，看不到上一步完整推理，强行拆分会打断推理连续性。三条可照做的出路：1) 只派 1 名专家从头到尾一次做完（平台豁免复杂任务 ≥${MIN_COMPLEX_DELEGATE_MEMBERS} 人下限，把全部中间结论写进同一份产物）；2) 负责人亲自执行——action="direct" + reasoningEffort 自评复杂档（qwen: medium/xhigh；非 qwen: high/max，不得 low）+ startPhases 开工证据；3) 仅当任务为 low/未配置档时按 low 直执（direct，缺省 low）。跨子任务只传已落盘产物引用。`,
      }
    }
  }
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
   * [3.2.9] 跨源矛盾裁决/单决策/共享可变状态的硬闸。
   *
   * 顺序链闸只覆盖「先…再」这一种耦合；用户第 1 条明确点名「需要跨源矛盾
   * 裁决」这类决策高度耦合的任务也不应强行拆分子代理。这里用与提示词同一个
   * decideDelegationStrategy 判定：耦合分 ≥3 且拟派多人 ⇒ 拒收，给出两条
   * 可照做出路（1 名专家一次做完 / 负责人 direct）。只对明确信号生效，
   * 不拦普通的多专家并行任务；单阶段计划与顺序链的既有豁免不变。
   */
  const delegationStrategy: DelegationStrategy = decideDelegationStrategy({
    taskText: input.parentTaskText,
    memberCount: members.length,
    taskEffort: taskEffort ?? input.taskEffortFallback,
    singleStagePlan: input.singleStagePlan,
  })
  // 统一口径：强耦合（couplingScore >= 3）禁拆多人并豁免人数下限（避免强耦合单专家与显式下限打架）；默认 MIN_COMPLEX_DELEGATE_MEMBERS=1 已天然放行 1 人。
  const strongCoupled = delegationStrategy.lane !== 'split' && delegationStrategy.couplingScore >= 3
  const singleLaneExempt = strongCoupled
  if (strongCoupled && members.length > 1) {
    const signals = delegationStrategy.signals
      .filter((item) => item.weight > 0)
      .map((item) => item.label)
      .join('、') || '强耦合'
    return {
      ...empty,
      code: 'DELEGATE_COUPLED_SPLIT',
      error: `本子任务被判定为决策高度耦合（${signals}；耦合分 ${delegationStrategy.couplingScore}/10），不得拆给 ${members.length} 名互相看不见完整推理的独立专家。两条可照做的出路：1) 只派 1 名专家从头到尾一次做完（平台豁免复杂任务 ≥${MIN_COMPLEX_DELEGATE_MEMBERS} 人下限，把全部中间结论与精确值写进同一份产物）；2) 负责人亲自执行——action="direct" + reasoningEffort 自评复杂档（qwen: medium/xhigh；非 qwen: high/max，不得 low）+ startPhases 开工证据；跨子任务只传已落盘产物引用。`,
    }
  }
  const effectiveMinHeadcount = Number.isInteger((input as any).minHeadcount) && Number((input as any).minHeadcount) >= 1
    ? Number((input as any).minHeadcount)
    : MIN_COMPLEX_DELEGATE_MEMBERS
  if (complexTask && !sequentialChain && !input.singleStagePlan && !singleLaneExempt && members.length < effectiveMinHeadcount) {
    return {
      ok: false,
      code: 'DELEGATE_HEADCOUNT_MIN',
      members: [],
      clamped: [],
      taskEffort: null,
      taskEffortClamped: null,
      error: `复杂任务（声明档 ${String(declaredEffort)}，D1/D2）须合计 ≥${effectiveMinHeadcount} 人（全部为专家），当前 ${members.length} 人；请拆清分工并扩充后重新 review/dispatch（环境变量 DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS 可调，默认 1）。`,
    }
  }
  // 顺序推理链 / 强耦合单专家模式：明确禁止拆分时允许 1 名专家承接完整链条，
  // 不再用单句/连词规则反过来把唯一专家打回（消除「禁拆多人 + 单人任务不许含连词」二律背反）；
  // 但仍严格要求质量要求非空（DELEGATE_QUALITY_REQUIREMENTS_MISSING）。
  const singleLaneChainRelax = members.length === 1 && (sequentialChain || strongCoupled)
  for (let index = 0; index < members.length; index += 1) {
    const item = members[index]
    if (singleLaneChainRelax) {
      if (!Array.isArray(item.qualityRequirements) || item.qualityRequirements.length === 0) {
        return {
          ok: false,
          code: 'DELEGATE_QUALITY_REQUIREMENTS_MISSING',
          members: [],
          clamped: [],
          taskEffort: null,
          taskEffortClamped: null,
          error: `分工表第 ${index + 1} 条（${item.member}）缺少 qualityRequirements（成果质量要求，1-8 条）。`,
        }
      }
      continue
    }
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
  /*
   * [3.2.3] 顺序推理链硬闸已在人数闸之前执行（见上方 sequentialChain），
   * 这里不再重复判定，避免同一拒因两处漂移。
   */
  return {
    ok: true,
    members,
    clamped,
    taskEffort,
    taskEffortClamped,
    // [2.5.5][T3] 钳制前原始声明随 ok 返回，供平台持久化为 taskReasoningEffortDeclared。
    taskEffortDeclared: typeof rawTaskEffort === 'string' ? rawTaskEffort : null,
    // [3.2.9] 成功分工的执行通道判定（供 delegate review 展示与后续审计）。
    contextStrategy: delegationStrategy,
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
  /**
   * [3.2.9] 角色上下文包（RCR/ Latent Brief / ASTC）：用户原要求锚点、验收标准、
   * 约束、依赖产物、历史教训、跨部门答复等，按 expert/planning|execution 路由。
   * 缺省空串 = 旧调用方/旧测试逐字不变。
   */
  contextPacket?: string
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
  /*
   * [3.2.4][省钱 3.0] 静态优先（static-first）重排：让同部门多名专家共享同一段
   * 前缀，从而命中供应商的提示词缓存。
   *
   * 缺陷现场（2026-11-23 T4/T5 实测）：每名专家的任务书**第一行就写着成员名**，
   * 第二、三行写着各自的任务文本——8 名专家的提示词从第 1 个字就分叉，缓存
   * 前缀长度为 0，等于每人每次都要把同一份五步协议、执行要求、汇报规范按全价
   * 重新买一遍。而实测 95% 的会话 token 花在"同一段内容被重复读"上，缓存命中
   * 是唯一不牺牲质量的省钱手段。
   *
   * 现在的顺序：静态头部（部门名）→ 五步协议 → 执行要求 → 汇报规范 → 动态尾部
   * （成员名/负责人任务/你的任务/工作目录/质量要求/重试简报/规则摘要）。
   * 内容一字未删，只是换了位置；`五步工作法` 仍在 `执行要求：` 之前（守门测试
   * three-phase.test.ts:135 钉住）。
   */
  return defuseSessionReferenceText([
    `你是「${input.departmentLabel ?? '部门'}」的${roleLabel}，只负责末尾【你的分工】里那一项工作。`,
    ...(input.continuation ? fiveStepContinuationPromptLines() : fiveStepPromptLines()),
    '',
    '执行要求（用户强制要求 5 原文口径）：',
    input.continuation
      ? '- 执行自己的任务：前三步已在 phase-0 经 self_effort 登记，勿重做，直接从第四步执行；仅核对/补缺（含 approachBasis），全程少走弯路。'
      : '- 执行自己的任务：前三步已在 phase-0 经 self_effort 交 startPhases 登记，不要重做，直接从第四步执行；仅核对/补缺（先全面、全盘、深入梳理、研究、思考自己的任务，再基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案与方法、流程、步骤及 approachBasis），全程少走弯路。',
    '- 推理等级以 self_effort 自配为权威（分工表档仅建议），全程按登记档执行；开工前必须先预估本人任务耗时（整数分钟）经 self_effort 的 timeNotice={ declaredMinutes: 正整数分钟, reason? } 上报（ESTIMATE_MISSING/ESTIMATE_INVALID 硬拒）；该上报只是协调信息，没有总时长、单次时长、空闲或回执硬截止，预估或实际耗时不会触发延期、超时接手，也不影响 done 验收。',
    '- 确保品质、高效执行、不浪费 token。你是第三层叶子执行者，不得派生第四层；无法完成首行写 BLOCKED: 原因。共享可变状态纪律：只写 outputs 声明产物与 reports/wp-member-<成员>-<任务>.json，禁并发写共享文件。',
    '- 遇阻上报通道（四步闭环）：遇阻由你先向部门负责人报告具体问题（调 dsh_workplan_escalate({ question, options, needs })）并停写等待；负责人全面梳理你的问题与本部门全部已派发任务执行状态，再由负责人用 dsh_workplan_instruct 把方案告诉你（禁止负责人在你待指示期间把你改派给其他专家）。',
    '- 完成后 ≤200 字、≤3 句中文回报负责人并写 reports/wp-member-<成员>-<任务>.json 兜底；步数预算（只记账，不是时限）不中断，避免无效试错（verify 参数被拒则正文交结果块）。',
    `- 结果块契约：${EVIDENCE_MARKER_BEGIN} … ${EVIDENCE_MARKER_END} 内合法 JSON（status、phases、acceptance 逐条带证据；有 phase-0 登记可省 planning/preparation）。`,
    '',
    renderExpertReportSpec(),
    ...(input.rulesBrief ? ['', input.rulesBrief] : []),
    '',
    '【你的分工】（本任务书中唯一因专家而异的部分）：',
    `- 成员：${input.member.member}`,
    `- 负责人任务：${input.leaderSubtaskId ?? ''} ${input.leaderSubtaskTitle ?? ''}`,
    `- 你的任务：${input.member.task}`,
    `- 工作目录：${input.cwd || '（未知）'}`,
    `- 产物根目录（唯一，强制）：${input.cwd ? `${input.cwd}/reports/` : '（工作目录）/reports/'}（所有产物写 reports/<任务代号>/<文件名>，勿写进子仓库）。`,
    ...(input.contextPacket ? ['', input.contextPacket] : []),
    ...(qualityBlock ? ['', qualityBlock] : []),
    ...(input.extraContext ? ['', input.extraContext] : []),
    `【防偏离锚定】紧扣上方用户原要求锚点与本项唯一目标「${String(input.member.task ?? '').replace(/\s+/g, ' ').trim().slice(0, 90)}」，严禁扩题、偏题或漏项；提交前自查 F1–F10。`,
  ].filter(Boolean).join('\n'))
}

/**
 * [2.5.0][自配档] phase-0 任务书（叶子）：唯一职责=评估复杂度+提交 self_effort。
 */
export function buildPhaseZeroDelegateePrompt(input: { departmentLabel?: string; member: DelegationAssignment; cwd?: string; contextPacket?: string; extraContext?: string }) {
  const roleLabel = '本部门相关领域全球顶尖专家'
  const qualityBlock = renderQualityRequirementsBlock(input.member.qualityRequirements ?? [], '部门负责人')
  return [
    `你是「${input.departmentLabel ?? '部门'}」${roleLabel}（成员名见末尾），phase-0（先配置后开工，low 启动）。`,
    '唯一职责：评估复杂度并完成五步前三步，调 dsh_workplan_delegate(action="self_effort") 一次提交：member + 推理等级 reasoningEffort（轻度=low；qwen 中等=medium/非常复杂=xhigh；非 qwen 中等=high/非常复杂=max）+ 依据（complexityReason 枚举 facts/dependencies/verification-difficulty 或 complexityRationale 二选一）+ startPhases + timeNotice={ declaredMinutes: 正整数分钟, reason? }（整数分钟；缺/非法硬拒 ESTIMATE_MISSING/ESTIMATE_INVALID：你必须自己预估时间，汇报给对应负责人后，才可以重试或继续执行）。',
    `startPhases 下限（problemAnalysis/approach≥40字，依据/资源/准备≥20字）：${START_EVIDENCE_MIN_CHARS_BRIEF}（含少走弯路：先查教训、先验证再动手）。`,
    '勿执行任务、不得派生任何第四层子代理；缺/不合格 startPhases 硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE）。提交后结束本回合，平台按自配档接续 phase-1。',
    '',
    '【你的分工】（本任务书中唯一因专家而异的部分）：',
    `- 成员：${input.member.member}`,
    `- 你分到的任务：${input.member.task}`,
    `- 工作目录：${input.cwd || '（未知）'}`,
    `- 产物根目录（唯一，强制）：${input.cwd ? `${input.cwd}/reports/` : '（工作目录）/reports/'}（勿写进子仓库）。`,
    ...(input.contextPacket ? ['', input.contextPacket] : []),
    ...(qualityBlock ? ['', qualityBlock] : []),
    ...(input.extraContext ? ['', input.extraContext] : []),
  ].join('\n')
}
