/**
 * [3.0.8] 五步工作法：部门 Agent 的强制执行顺序（单一框架）。
 *
 * 历史口径（本文件是三次强制要求的收口）：
 *   1. [1.13.0] 三阶段工作法（2026-11-05）：规划 → 执行 → 验证；
 *   2. [2.5.1] 两轮深度思考协议（2026-11-11）：第一轮任务深研 + 第二轮方法流程
 *      步骤（含依据 approachBasis），deepThink 开工硬门禁；
 *   3. [3.1.0] 五步工作法（2026-11-17）：第一步任务梳理 → 第二步资源/工具/实施
 *      方案研究 → 第三步准备 → 第四步执行与验证 → 第五步 JSON 交付。
 *   4. [3.0.8] 单框架收口（用户裁决）：废除独立的两轮深度思考 deepThink 门禁——
 *      两轮思考的实质内容（problemAnalysis/approach/approachBasis）本就是五步法
 *      第 1、2 步的子集，保留两套框架造成同一内容双份提交、编号口径互相矛盾。
 *      现在全系统只有一套五步契约：
 *        - 开工闸（dispatch/review/self_effort/direct）：必须随附第 1、2、3 步
 *          证据（phases.planning + phases.preparation，validateStartPhaseEvidence），
 *          未交/不合格硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE）；
 *        - 结算闸（adjudicateResult）：第 4、5 步证据（execution/verification/
 *          report）+ 与开工登记的一致性比对（checkStartEvidenceCarryover），
 *          防止「开工登记一套、收尾另写一套」；
 *        - verify 工具：第四步验证前的分步自检（PHASE_GATE 语义不变）。
 *
 * 为什么用「结构化证据」而不是只写一句提示：
 * 只写提示词时，模型可以直接动手、最后补一句「我已规划」。把规划内容变成
 * 收尾证据的一部分后，缺规划/缺验证的结果无法被记成 done，主 Agent 和
 * 回放日志都能看到每个部门到底梳理了什么、按什么思路做、验证了什么。
 *
 * 这个模块只做纯函数与常量，不依赖 harness 服务：
 *   - 校验开工证据（第 1/2/3 步）与结算证据（全部五步）；
 *   - 开工-结算一致性比对（carryover）；
 *   - 生成阶段摘要（写进结果与日志）；
 *   - 生成提示词段落（由 buildChildPrompt/buildDelegateePrompt 拼进任务书）。
 */

import { type Retrospective, MIN_RETRO_PREVENTION_CHARS, MIN_RETRO_PROBLEM_CHARS, MIN_RETRO_RESOLUTION_CHARS, validateRetrospective } from './lessons.js'
// [3.0.0] Dice 单一真源在 v3-contract（零依赖，无循环）：
// plan.ts#criterionSimilarity 与这里的 missingCriteria 都用它。
import { diceSimilarity } from './v3-contract.js'

/** 五步证据四组键（结果块里 `phases` 的键名）；第五步由 report/departmentSummary 承载。 */
export const FIVE_STEP_EVIDENCE_KEYS = Object.freeze(['planning', 'preparation', 'execution', 'verification'] as const)
/**
 * [3.0.8] 契约版本 4：单框架收口——废除 deepThink 两轮开工门禁，开工闸升级为
 * 第 1/2/3 步证据（planning+preparation），结算新增开工-结算一致性比对。
 */
export const FIVE_STEP_CONTRACT_VERSION = 4

/**
 * 「全面、全盘、深入」无法由代码度量，但可以给一个不可忽略的下限：
 * 第一步任务梳理与第二步方法、流程、步骤各至少 40 个字符，避免一个词就冒充
 * 规划；第二步依据（approachBasis）至少 20 个字符，避免一句空话冒充依赖对应。
 */
export const MIN_PLANNING_PROBLEM_CHARS = 40
export const MIN_PLANNING_APPROACH_CHARS = 40
export const MIN_PLANNING_BASIS_CHARS = 20
/** [3.1.0] 第二步资源与工具、第三步准备与就绪证据的下限（合计字符数）。 */
export const MIN_RESOURCE_CHARS = 20
export const MIN_TOOL_CHARS = 10
export const MIN_PREPARATION_CHARS = 20
export const MAX_PHASE_LIST_ITEMS = 20
export const MAX_PHASE_ITEM_CHARS = 800
export const MAX_PHASE_TOTAL_CHARS = 6000

/**
 * [修复] 七项字数下限的完整简报（由上方常量渲染，提示词与校验器同一事实源）。
 * 旧文案只写「40/40/20 字判据」，遮蔽了 resources/tools/prepared/evidence 四项下限，
 * 导致子 Agent 照提示词写却仍然被开工闸/结算闸打回。此处一处定义、各处引用。
 */
export const START_EVIDENCE_MIN_CHARS_BRIEF = `problemAnalysis 合计 ≥${MIN_PLANNING_PROBLEM_CHARS} 字、approach 合计 ≥${MIN_PLANNING_APPROACH_CHARS} 字、approachBasis 合计 ≥${MIN_PLANNING_BASIS_CHARS} 字、resources 合计 ≥${MIN_RESOURCE_CHARS} 字、tools 合计 ≥${MIN_TOOL_CHARS} 字、prepared 合计 ≥${MIN_PREPARATION_CHARS} 字、evidence 合计 ≥${MIN_PREPARATION_CHARS} 字`

export type PhaseCheck = {
  criterion: string
  method: string
  evidence: string
}

export type PlanningPhase = {
  /** 第一步 · 任务梳理：全面、全盘、深入梳理、研究、思考自己的任务的结果。 */
  problemAnalysis: string[]
  constraints: string[]
  unknowns: string[]
  /** 第二步 · 资源研究：完成本任务需要哪些资源（数据、文件、权限、人、知识、时间）。 */
  resources: string[]
  /** 第二步 · 工具研究：完成本任务需要哪些工具，以及每个工具用来做什么。 */
  tools: string[]
  /** 第二步 · 基于第一步全部结果理清的方法、流程、步骤（一步步执行的路径）。 */
  approach: string[]
  /**
   * 第二步依据（必填）：第二步的资源/工具/方案如何「基于第一步完成好的所有
   * 结果」——逐条写清第一步的哪些事实/约束/矛盾决定了第二步的哪些资源/工具/
   * 步骤。缺它则两步之间的依赖不可审计，规划阶段判未完成。
   */
  approachBasis: string[]
}

/**
 * [3.1.0] 第三步 · 准备工作：把第二步研究出的资源与工具真正备齐（不是「打算用」，
 * 而是「已就绪」）。每条都要有可复核的就绪证据，缺证据的资源不得进入执行。
 */
export type PreparationPhase = {
  /** 已准备好的资源/工具清单：每一项写清准备了什么、在哪里、是否可用。 */
  prepared: string[]
  /** 就绪证据：命令输出、文件路径、配置项、版本号或引用；与 prepared 一一对应。 */
  evidence: string[]
}

export type ExecutionPhase = {
  steps: string[]
  deviations: string[]
}

export type VerificationPhase = {
  allPassed: boolean
  checks: PhaseCheck[]
  requirementCheck: string
  /**
   * [2.0.0] 第四步收尾的自我学习复盘（用户 2026-11-05 强制要求）。
   *
   * 复盘不是第五步，而是第四步验证收尾的必填项——完成之后、报 done 之前，
   * 必须把本次全过程遇到的问题、弯路、解决方式与防再犯规则说清楚，并由
   * lessons.ts 落盘成永久记忆。
   */
  retrospective: Retrospective
}

/** 结果块里的 `phases` 对象（五步证据的第 1–4 组；第 5 步由 report 承载）。 */
export type FiveStepPhases = {
  version: number
  planning: PlanningPhase
  preparation: PreparationPhase
  execution: ExecutionPhase
  verification: VerificationPhase
}

export type PhaseValidation = {
  ok: boolean
  phases: FiveStepPhases | null
  errors: string[]
  /** 错误落在哪一组：'planning' | 'preparation' | 'execution' | 'verification' | 'shape' */
  failedPhase: 'planning' | 'preparation' | 'execution' | 'verification' | 'shape' | null
}

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readTextList(
  value: any,
  field: string,
  errors: string[],
  options: { required: boolean; minItems?: number },
) {
  if (value === undefined || value === null) {
    if (options.required) errors.push(`${field} 缺失`)
    return []
  }
  if (!Array.isArray(value)) {
    errors.push(`${field} 必须是数组`)
    return []
  }
  const items = value
    .map((item: any) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
  if (options.required && items.length < (options.minItems ?? 1)) {
    errors.push(`${field} 至少需要 ${options.minItems ?? 1} 条非空内容`)
    return items.slice(0, MAX_PHASE_LIST_ITEMS)
  }
  if (items.length > MAX_PHASE_LIST_ITEMS) {
    errors.push(`${field} 超过 ${MAX_PHASE_LIST_ITEMS} 条上限`)
  }
  return items.slice(0, MAX_PHASE_LIST_ITEMS).map((item: string) => item.slice(0, MAX_PHASE_ITEM_CHARS))
}

function totalChars(items: string[]) {
  return items.reduce((sum, item) => sum + item.length, 0)
}

/**
 * Same matching rules as `src/plan.ts#acceptanceCoverage`（[4th batch] 归一化逐字
 * 对齐 plan.ts:3300-3309：全角折叠、完成态前缀剥离、去标点、去祈使前缀）：
 * stable A1…An numbering, exact full text, a longer text containing the
 * full criterion, a near-full copy (≥85% of the criterion length), or a
 * paraphrase with Dice ≥ 0.70 and matching negation polarity. A partial
 * copy must not count as coverage.
 *
 * Kept local to avoid importing plan.ts (which imports this module); the
 * rules are pinned by tests on both sides. Dice itself is shared via the
 * zero-dependency v3-contract single source (`diceSimilarity`).
 */
function normaliseCriterion(value: any) {
  return String(value ?? '')
    .trim()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .toLowerCase()
    .replace(/^(?:已完成|完成|已|done|yes)(?=[\s:：,，。.!！?？;；、\-—–]|$)|^(?:已完成|完成|已)/i, '')
    .replace(/[\s，。；、,.;:：!！?？"'“”‘’()（）\[\]【】《》<>]/g, '')
    .replace(/^(必须|需要|应当|应该|请|务必)/, '')
}

/** 与 plan.ts#hasNegation 逐字对齐：否定/禁止语气不一致不允许判覆盖。 */
function hasNegation(text: string) {
  return /不得|禁止|严禁|不能|不可|不允许|不应|无需|避免|排除|不超过|不低于|不高于|不等于|未通过|未完成/.test(String(text ?? ''))
}

function missingCriteria(expected: any, checks: PhaseCheck[]) {
  const want = (Array.isArray(expected) ? expected : []).map(normaliseCriterion)
  const got = checks.map((check) => normaliseCriterion(check.criterion)).filter(Boolean)
  const missing: string[] = []
  for (const [index, criterion] of want.entries()) {
    if (!criterion) continue
    const id = new RegExp(`(^|[^a-z0-9])a${index + 1}([^0-9]|$)`)
    const covered = got.some((row) => {
      if (row === criterion) return true
      if (id.test(row)) return true
      if (Math.min(row.length, criterion.length) < 6) return false
      if (row.includes(criterion)) return true
      // [2.0.4] 宽松规则（与 plan.ts:3199-3201 逐字对齐）：
      if (criterion.includes(row) && row.length / criterion.length >= 0.85) return true
      if (hasNegation(criterion) !== hasNegation(row)) return false
      return diceSimilarity(row, criterion) >= 0.7
    })
    if (!covered) missing.push(`A${index + 1}`)
  }
  return missing
}

/** 解析并校验 planning 组（第 1、2 步证据）；required=false 时全部字段 optional。 */
function parsePlanningPhase(planningRaw: any, errors: string[], required: boolean): PlanningPhase {
  const planning: PlanningPhase = {
    problemAnalysis: readTextList(planningRaw?.problemAnalysis, 'phases.planning.problemAnalysis', errors, {
      required,
      minItems: 1,
    }),
    constraints: readTextList(planningRaw?.constraints, 'phases.planning.constraints', errors, { required: false }),
    unknowns: readTextList(planningRaw?.unknowns, 'phases.planning.unknowns', errors, { required: false }),
    approach: readTextList(planningRaw?.approach, 'phases.planning.approach', errors, {
      required,
      minItems: 1,
    }),
    approachBasis: readTextList(planningRaw?.approachBasis, 'phases.planning.approachBasis', errors, {
      required,
      minItems: 1,
    }),
    resources: readTextList(planningRaw?.resources, 'phases.planning.resources', errors, {
      required,
      minItems: 1,
    }),
    tools: readTextList(planningRaw?.tools, 'phases.planning.tools', errors, {
      required,
      minItems: 1,
    }),
  }
  if (planning.problemAnalysis.length > 0 && totalChars(planning.problemAnalysis) < MIN_PLANNING_PROBLEM_CHARS) {
    errors.push(`phases.planning.problemAnalysis 太薄（合计 ${totalChars(planning.problemAnalysis)} 字，至少 ${MIN_PLANNING_PROBLEM_CHARS} 字）：第一步要全面、全盘、深入梳理、研究、思考自己的任务，逐条写清目标与验收、现状、约束、未知、主要矛盾与边界`)
  }
  if (planning.approach.length > 0 && totalChars(planning.approach) < MIN_PLANNING_APPROACH_CHARS) {
    errors.push(`phases.planning.approach 太薄（合计 ${totalChars(planning.approach)} 字，至少 ${MIN_PLANNING_APPROACH_CHARS} 字）：第二步要基于第一步全部结果理清具体一步步执行、完美完成任务的方法、流程和步骤，而不是一句目标`)
  }
  if (planning.approachBasis.length > 0 && totalChars(planning.approachBasis) < MIN_PLANNING_BASIS_CHARS) {
    errors.push(`phases.planning.approachBasis 太薄（合计 ${totalChars(planning.approachBasis)} 字，至少 ${MIN_PLANNING_BASIS_CHARS} 字）：要写清第二步的方法、流程、步骤如何基于第一步梳理、研究、思考完成好的所有结果`)
  }
  if (planning.resources.length > 0 && totalChars(planning.resources) < MIN_RESOURCE_CHARS) {
    errors.push(`phases.planning.resources 太薄（合计 ${totalChars(planning.resources)} 字，至少 ${MIN_RESOURCE_CHARS} 字）：第二步要逐项写清完成本任务需要哪些资源（数据/文件/权限/人/知识/时间），缺一项就会在执行中卡住`)
  }
  if (planning.tools.length > 0 && totalChars(planning.tools) < MIN_TOOL_CHARS) {
    errors.push(`phases.planning.tools 太薄（合计 ${totalChars(planning.tools)} 字，至少 ${MIN_TOOL_CHARS} 字）：第二步要逐项写清需要哪些工具、每个工具用来做什么、为什么选它`)
  }
  return planning
}

/** 解析并校验 preparation 组（第 3 步证据）；required=false 时全部字段 optional。 */
function parsePreparationPhase(preparationRaw: any, errors: string[], required: boolean): PreparationPhase {
  const preparation: PreparationPhase = {
    prepared: readTextList(preparationRaw?.prepared, 'phases.preparation.prepared', errors, {
      required,
      minItems: 1,
    }),
    evidence: readTextList(preparationRaw?.evidence, 'phases.preparation.evidence', errors, {
      required,
      minItems: 1,
    }),
  }
  if (preparation.prepared.length > 0 && totalChars(preparation.prepared) < MIN_PREPARATION_CHARS) {
    errors.push(`phases.preparation.prepared 太薄（合计 ${totalChars(preparation.prepared)} 字，至少 ${MIN_PREPARATION_CHARS} 字）：第三步要把第二步研究出的资源与工具真正备齐，逐项写清准备了什么、在哪里、是否可用`)
  }
  if (preparation.evidence.length > 0 && totalChars(preparation.evidence) < MIN_PREPARATION_CHARS) {
    errors.push(`phases.preparation.evidence 太薄（合计 ${totalChars(preparation.evidence)} 字，至少 ${MIN_PREPARATION_CHARS} 字）：每一项就绪状态都要有可复核的证据（命令输出/文件路径/配置项/版本号/引用）`)
  }
  return preparation
}

/**
 * Parse + validate the `phases` object from a child's evidence block（结算闸：五步全量）。
 *
 * `expectedAcceptance` is the plan's own acceptance table. When present, every
 * criterion must have a verification check; a shorter list is treated as an
 * incomplete 第四步 verification rather than "some checks are better than none".
 */
export function validateFiveStepEvidence(value: any, expectedAcceptance: any = [], fillStart: any = null): PhaseValidation {
  const errors: string[] = []
  let failedPhase: PhaseValidation['failedPhase'] = null
  const fail = (phase: NonNullable<PhaseValidation['failedPhase']>, message: string) => {
    errors.push(message)
    if (failedPhase === null) failedPhase = phase
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      phases: null,
      errors: ['phases 缺失：必须提交 execution（第四步）/ verification（第四步验证）两组证据；若本任务是 phase-0 已登记开工证据的接续执行，planning / preparation 由平台自动并入，无需重抄'],
      failedPhase: 'shape',
    }
  }
  /*
   * [3.2.0][省钱] 交卷免重抄开工证据。
   *
   * phase-0 已把第 1/2/3 步原文登记为 durable 事实；旧结算闸仍要求交卷时
   * 逐字重抄一遍，模型为此多输出 2–5KB，且抄错/抄薄就会退回重交。这里在
   * 校验入口允许用登记证据补齐缺失的 planning / preparation：交卷只需
   * execution / verification 增量，平台随后用 mergeStartEvidenceIntoSettlement
   * 做并集落账，登记内容一条不丢。fillStart 不传时行为与旧版逐字一致。
   */
  const fill = isRecord(fillStart) && isRecord(fillStart.planning) && isRecord(fillStart.preparation)
    ? fillStart
    : null
  /*
   * 「提交了但整组为空」与「没提交」等价：模型常写 planning:{} 占位。
   * 更常见的是只补写了其中一两个清单——按字段而不是按整组判断，缺哪个
   * 清单就用登记值补哪个，交卷人写多少算多少，不会被半组内容击穿。
   */
  const planningKeys = ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'] as const
  const preparationKeys = ['prepared', 'evidence'] as const
  const submittedPlanning = isRecord(value.planning) ? value.planning : null
  const submittedPreparation = isRecord(value.preparation) ? value.preparation : null
  const missingPlanningFields = fill
    ? planningKeys.filter((key) => !(Array.isArray(submittedPlanning?.[key]) && submittedPlanning[key].length > 0))
    : []
  const missingPreparationFields = fill
    ? preparationKeys.filter((key) => !(Array.isArray(submittedPreparation?.[key]) && submittedPreparation[key].length > 0))
    : []
  const planningRaw = fill
    ? {
        ...(submittedPlanning ?? {}),
        ...Object.fromEntries(missingPlanningFields.map((key) => [key, (fill.planning as any)[key]])),
      }
    : submittedPlanning
  if (!planningRaw) fail('planning', 'phases.planning 缺失（第一步 · 任务梳理 + 第二步 · 资源/工具/实施方案研究：先全面、全盘、深入梳理研究自己的任务，再基于其结果研究需要哪些资源、哪些工具、具体实施方案）')
  const preparationRaw = fill
    ? {
        ...(submittedPreparation ?? {}),
        ...Object.fromEntries(missingPreparationFields.map((key) => [key, (fill.preparation as any)[key]])),
      }
    : submittedPreparation
  if (!preparationRaw) fail('preparation', 'phases.preparation 缺失（第三步 · 准备：把第二步研究出的资源、工具、实施方案真正备齐，并给出就绪证据）')
  const executionRaw = isRecord(value.execution) ? value.execution : null
  if (!executionRaw) fail('execution', 'phases.execution 缺失（第四步：基于第二步理清的方法、流程、步骤执行）')
  const verificationRaw = isRecord(value.verification) ? value.verification : null
  if (!verificationRaw) fail('verification', 'phases.verification 缺失（第四步收尾：逐条验证）')

  const planning = parsePlanningPhase(planningRaw, errors, !!planningRaw)
  if (errors.some((item) => item.startsWith('phases.planning'))) failedPhase ||= 'planning'

  const preparation = parsePreparationPhase(preparationRaw, errors, !!preparationRaw)
  if (errors.some((item) => item.startsWith('phases.preparation'))) failedPhase ||= 'preparation'

  const execution: ExecutionPhase = {
    steps: readTextList(executionRaw?.steps, 'phases.execution.steps', errors, {
      required: !!executionRaw,
      minItems: 1,
    }),
    deviations: readTextList(executionRaw?.deviations, 'phases.execution.deviations', errors, { required: false }),
  }
  if (errors.some((item) => item.startsWith('phases.execution'))) failedPhase ||= 'execution'

  const retroCheck = validateRetrospective(verificationRaw?.retrospective)
  for (const error of retroCheck.errors) fail('verification', error)
  const verification: VerificationPhase = {
    allPassed: verificationRaw?.allPassed === true,
    checks: [],
    requirementCheck: typeof verificationRaw?.requirementCheck === 'string'
      ? verificationRaw.requirementCheck.trim().slice(0, MAX_PHASE_ITEM_CHARS)
      : '',
    retrospective: retroCheck.retrospective,
  }
  if (verificationRaw && verificationRaw.allPassed !== true) {
    fail('verification', 'phases.verification.allPassed 必须为 true：只要有一条验收标准未通过或未验证，就不得报 done')
  }
  if (!Array.isArray(verificationRaw?.checks)) {
    if (verificationRaw) fail('verification', 'phases.verification.checks 必须是数组')
  } else {
    verification.checks = verificationRaw.checks
      .slice(0, MAX_PHASE_LIST_ITEMS)
      .map((item: any, index: number): PhaseCheck => {
        if (!isRecord(item)) {
          fail('verification', `phases.verification.checks[${index}] 必须是对象（criterion / method / evidence）`)
          return { criterion: '', method: '', evidence: '' }
        }
        const check: PhaseCheck = {
          criterion: typeof item.criterion === 'string' ? item.criterion.trim().slice(0, MAX_PHASE_ITEM_CHARS) : '',
          method: typeof item.method === 'string' ? item.method.trim().slice(0, MAX_PHASE_ITEM_CHARS) : '',
          evidence: typeof item.evidence === 'string' ? item.evidence.trim().slice(0, MAX_PHASE_ITEM_CHARS) : '',
        }
        if (!check.criterion) fail('verification', `phases.verification.checks[${index}].criterion 不能为空`)
        if (!check.method) fail('verification', `phases.verification.checks[${index}].method 不能为空（用什么方式验证）`)
        if (!check.evidence) fail('verification', `phases.verification.checks[${index}].evidence 不能为空（命令输出/文件/引用）`)
        return check
      })
    if (verification.checks.length === 0) {
      fail('verification', 'phases.verification.checks 至少需要一条逐项验证记录')
    }
  }
  const expected = Array.isArray(expectedAcceptance) ? expectedAcceptance.filter(Boolean) : []
  if (expected.length > 0 && verification.checks.length < expected.length) {
    fail(
      'verification',
      `phases.verification.checks 只验证了 ${verification.checks.length} 项，少于验收标准的 ${expected.length} 项：每条验收标准都要有验证记录`,
    )
  }
  if (expected.length > 0) {
    const missing = missingCriteria(expected, verification.checks)
    if (missing.length > 0) {
      fail(
        'verification',
        `phases.verification.checks 未逐条覆盖验收标准：缺少 ${missing.join('、')}（可按 A1/A2 编号对号入座，或写完整原文；只写一部分不算覆盖）`,
      )
    }
  }

  const phases: FiveStepPhases = {
    version: FIVE_STEP_CONTRACT_VERSION,
    planning,
    preparation,
    execution,
    verification,
  }
  const total = [
    ...planning.problemAnalysis,
    ...planning.constraints,
    ...planning.unknowns,
    ...planning.approach,
    ...planning.approachBasis,
    ...planning.resources,
    ...planning.tools,
    ...preparation.prepared,
    ...preparation.evidence,
    ...execution.steps,
    ...execution.deviations,
    verification.requirementCheck,
  ].reduce((sum, item) => sum + item.length, 0)
  /*
   * [3.2.0] 字数上限只约束「交卷人自己写的内容」。由平台并入的登记证据
   * 已经在开工闸逐字校验并 durable 落账，不应再拿 6000 字上限把它判为超限；
   * 否则省输出反而变成新的退回源。这里按条目精确扣除自动并入的部分，
   * 交卷人自己写超了仍然拦截（不会因为「有登记」就完全放开日志粘贴）。
   */
  const autoFilledChars = fill
    ? missingPlanningFields.reduce((sum, key) => {
        const items = (fill.planning as any)[key]
        return sum + (Array.isArray(items) ? totalChars(items) : 0)
      }, 0)
      + missingPreparationFields.reduce((sum, key) => {
        const items = (fill.preparation as any)[key]
        return sum + (Array.isArray(items) ? totalChars(items) : 0)
      }, 0)
    : 0
  if (total - autoFilledChars > MAX_PHASE_TOTAL_CHARS) {
    fail('shape', `phases 合计超过 ${MAX_PHASE_TOTAL_CHARS} 字，请压缩到可核对的事实，不要粘贴大段日志`)
  }
  return { ok: errors.length === 0, phases: errors.length === 0 ? phases : null, errors, failedPhase }
}

/**
 * Which stage a caller is allowed to be in, judged only by the evidence it sent.
 *
 * Used by `dsh_workplan_verify`: planning/preparation/execution gaps mean the caller is
 * still in steps 1–3, where verify returns PHASE_GATE with the missing items.
 */
export function phaseGateFromErrors(errors: string[]): 'steps-1-3' | 'verification' {
  return errors.some((item) => /^phases(\.| 缺失)/.test(item) && /planning|preparation|execution/.test(item))
    ? 'steps-1-3'
    : 'verification'
}

/** One-line, model-readable summary of what the five-step evidence contains. */
export function phaseSummaryLine(phases: FiveStepPhases): string {
  const deviations = phases.execution.deviations.length
  return [
    `第一步 任务梳理（${phases.planning.problemAnalysis.length} 条）`,
    `第二步 资源/工具/方案研究（资源 ${phases.planning.resources.length} 项 / 工具 ${phases.planning.tools.length} 项 / 方法 ${phases.planning.approach.length} 步 / 依据 ${phases.planning.approachBasis.length} 条）`,
    `第三步 准备（已备 ${phases.preparation.prepared.length} 项 / 就绪证据 ${phases.preparation.evidence.length} 条）`,
    `第四步 执行与验证（执行 ${phases.execution.steps.length} 步${deviations ? ` / 偏离 ${deviations} 处` : ''}；验证 ${phases.verification.checks.length} 项${phases.verification.allPassed ? '，全部通过' : '，未全部通过'}；`
      + `复盘 ${phases.verification.retrospective.problems.length} 个问题 / `
      + `${phases.verification.retrospective.detours.length} 条弯路 / `
      + `${phases.verification.retrospective.prevention.length} 条防再犯规则）`,
    '第五步 JSON 交付（report / departmentSummary，只含关键信息）',
  ].join('；')
}

/**
 * Prompt paragraphs injected into every department child.
 *
 * Kept in this module so the wording and the validators above are one contract:
 * changing what is demanded without changing what is checked would make the
 * prompt lie about completion.
 */
export function fiveStepPromptLines(): string[] {
  return [
    '五步工作法（用户 2026-11-17 强制要求；五个步骤必须按顺序执行，前一步没有完成并写好证据之前，禁止进入下一步）：',
    '【第一步 · 任务梳理（部门负责人、相关领域全球顶尖专家执行自己的任务时同一口径）】',
    '  先全面、全盘、深入梳理、研究、思考自己的任务：逐条写清任务目标与验收标准、现状与已知事实、约束条件、未知/待确认项、主要矛盾、工作边界与依赖，结果写入 phases.planning.problemAnalysis；约束与未知项若在开工登记（startPhases）里请一并写进 problemAnalysis 条目内（startPhases 的 planning 只收 problemAnalysis/resources/tools/approach/approachBasis 五个字段），收尾结果块的 phases.planning 可以另写 constraints / unknowns 两个可选清单。',
    '【第二步 · 资源、工具与实施方案研究】',
    '  基于第一步完成好的所有结果，再全面、全盘、深入地梳理、研究、思考：完成本任务需要哪些资源（数据/文件/权限/人/知识/时间）写入 phases.planning.resources；需要哪些工具、每个工具用来做什么写入 phases.planning.tools；具体实施方案写成自己该具体如何一步步以最高效率执行、确保完美完成自己任务的方法、流程和步骤（每一步做什么、产出什么、依赖什么、风险与对策、如何证明做对了，以及全程如何少走弯路：先查历史教训、先验证再动手、不重复试错）写入 phases.planning.approach；同时把第二步如何基于第一步全部结果逐条对应写入 phases.planning.approachBasis。',
    '  自检：任何一条验收标准或用户原要求没有落在第二步的资源、工具与实施方案上，就回到第一步重做。',
    '【第三步 · 准备】',
    '  基于第二步的全部结果，把需要的资源、工具、实施方案真正准备到位，而不是「打算用」：逐项写清准备了什么、在哪里、是否可用，写入 phases.preparation.prepared；每一项就绪状态都必须给出可复核的证据（命令输出/文件路径/配置项/版本号/引用），写入 phases.preparation.evidence。缺资源、缺工具、缺证据时，先补齐或如实上报受阻，不得带着缺口进入第四步。',
    '【第四步 · 执行与验证】',
    '  基于第三步备齐的成果和既定实施方案，开始具体执行，严格按 phases.planning.approach 落地；出现新事实需要偏离时，必须记录偏离原因、证据与调整后的做法，不得静默改道，执行步骤写入 phases.execution.steps。',
    '  执行完成后逐条验证验收标准与用户原要求：每条都要有可复核的证据（命令输出/文件/引用）；验证未通过不得报 done；确实无法确认的验收项，在结果块顶层 acceptance[] 对应条目的 result 写 "unverified"（evidence 写已核到的事实），不要写 pass——phases.verification.checks 里只写已验证条目（criterion/method/evidence 齐全），且 allPassed 必须为 true；checks/allPassed 可省略，平台会按顶层 acceptance 自动生成；结果写入 phases.verification。',
    '【第四步收尾 · 自我学习复盘（强制）】',
    '  报 done 之前必须把 phases.verification.retrospective 写全，四项缺一不可：',
    '  1) problems：本次全过程遇到的所有问题（现象 + 根因），至少 1 条；',
    '  2) detours：走过的弯路、返工与无效尝试（确实没有就写空数组 []，不要编造）；',
    '  3) resolutions：最终是如何解决上述问题的，至少 1 条，可与 problems 一一对应；',
    '  4) prevention：以后如何预防再犯，至少 1 条，必须写成「遇到…先…」的可执行硬规则。',
    '【第五步 · JSON mode 结构化交付给本部门负责人】',
    '  执行完美完成后，必须把成果以 JSON mode 结构化交回本部门负责人：专家写入 report 对象（只允许 keyResults / keyInfo / importantInfo / leadRequirements 四个字符串数组字段，只写关键信息、关键成果、重要信息和负责人要求的东西，禁止过程流水账与重复表述）；部门负责人写入 departmentSummary 对象（keyResults / keyInfo / importantInfo / sources，汇总本部门全部专家汇报，sources 必须覆盖全部已派发专家）。成果块必须放在 <!-- WORKPLAN_EVIDENCE:START --> 与 <!-- WORKPLAN_EVIDENCE:END --> 之间，且是合法 JSON，不得用散文代替。',
    '开工闸与结算闸（五步证据门禁）：',
    '  - 开工前：第一、二、三步证据（phases.planning + phases.preparation）必须经开工工具随附提交（主 Agent 随 dsh_workplan_dispatch 的 startPhases，负责人随 dsh_workplan_delegate 的 startPhases，专家随 self_effort 的 startPhases），未交/不合格会被硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），不登记、不接续正式执行。',
    '  - 第一、二、三步：先把问题梳理、资源/工具/实施方案、准备与就绪证据写全；此时不要调用 dsh_workplan_verify，它会因缺少前几步证据返回 PHASE_GATE 与待补项（这是证据门禁，不是禁用插件）。',
    '  - 第四步：可以调用 dsh_workplan_verify 让插件做最终核验：提交 execution / verification 增量；有 phase-0 登记时 phases.planning / phases.preparation 由平台自动并入（无需重抄），无登记时四组证据仍须齐全。插件返回 passed 或仍需补齐的 gaps；未通过先修复再回报。遇阻时可用 dsh_workplan_escalate 上报，它是安全通道，不属于五步产物。',
    '  - 结果块里的 phases 仍有硬门禁：无登记时缺 phases.planning / phases.preparation，或有登记时缺 phases.execution / phases.verification、内容为空、或验证未全部通过，插件都会判为未完成，不能用 done 收尾；第五步缺 report / departmentSummary 同样判为未完成。开工登记的第 1/2/3 步证据不允许在收尾时变薄。',
    '  - [3.2.0] 收尾复制纪律：有 phase-0 登记证据时，phases.planning / phases.preparation 可以省略——平台会把登记原文与交卷内容并集落账（登记内容永不丢失），不要重抄；无登记（旧计划/旧回放）时仍须自带这两组。只交执行/验证且无登记才判退回（EVIDENCE_INCOMPLETE）。',
    /*
     * [修复] 校验器同源的下限/上限全量披露：旧提示词只口头要求「写全、写深」，
     * 从不公布具体数字（40/40/20/10、20 条/800 字/6000 字、复盘 20/20/16），
     * 子 Agent 只能靠猜，猜错即被开工闸/结算闸打回（「五步证据不完整」「小于
     * 20 个字符」的高频根因）。此处渲染的每个数字都与本文件校验器常量一致。
     */
    `硬下限（校验器逐字执行，缺一即退回）：${START_EVIDENCE_MIN_CHARS_BRIEF}。`,
    `硬上限（校验器逐字执行，超出即退回）：每个清单（数组）最多 ${MAX_PHASE_LIST_ITEMS} 条、每条最多 ${MAX_PHASE_ITEM_CHARS} 字；phases 四组（planning+preparation+execution+verification）全部条目合计最多 ${MAX_PHASE_TOTAL_CHARS} 字；phases.verification.checks 至少 1 条、且条数不得少于验收标准条数、必须逐条覆盖验收标准（可省略：平台会用顶层 acceptance 自动生成并逐条覆盖；显式写了则以你写的为准）。`,
    `复盘硬下限（校验器逐字执行）：retrospective.problems 至少 1 条、合计 ≥${MIN_RETRO_PROBLEM_CHARS} 字；resolutions 至少 1 条、合计 ≥${MIN_RETRO_RESOLUTION_CHARS} 字；prevention 至少 1 条、合计 ≥${MIN_RETRO_PREVENTION_CHARS} 字；detours 确实没有可写空数组 []。`,
  ]
}

/**
 * [3.1.9][省钱] phase-1 接续专用的精简五步提示。
 *
 * 完整 fiveStepPromptLines() 有 3,583 字符，其中大量篇幅在讲「第一步/第二步/
 * 第三步怎么做」；但这些步骤已经在 phase-0 完成并登记，phase-1 的任务书上方
 * 还带着登记证据摘要。再逐字讲一遍前三步，等于让每个负责人/专家每一步都为
 * 已经完成的动作重复付费。这里保留：
 *  - 前三步口径的关键串（兼容守门测试与模型核对）；
 *  - 第四步执行/验证、复盘、第五步 JSON 交付、开工/结算闸；
 *  - 全部硬下限/硬上限数字（校验器同源，不能让模型靠猜）。
 * 完整版仍在 phase-0、主 Agent 与无接续块的旧计划路径使用。
 */
export function fiveStepContinuationPromptLines(): string[] {
  return [
    '五步工作法（接续执行：前三步已在 phase-0 完成并登记，不再重做；本次只执行第四步与第五步。收尾结果块可省略 phases.planning / phases.preparation——平台会自动并入 phase-0 登记原文，登记内容不会变薄；只交 execution / verification 增量即可，不要重抄）：',
    '  前三步口径（已登记，本次只核对、不重做）：先全面、全盘、深入梳理、研究、思考自己的任务；基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案（方法、流程、步骤，含 approachBasis）；把资源与工具备齐并给出就绪证据。',
    '【第四步 · 执行与验证】严格按已登记的 phases.planning.approach 落地；出现新事实需要偏离时，记录偏离原因、证据与调整后的做法，不得静默改道，执行步骤写入 phases.execution.steps。逐条验证验收标准与用户原要求，每条都要有可复核的证据（命令输出/文件/引用）；验证未通过不得报 done；确实无法确认的验收项写 "unverified"，不要写 pass。',
    '【第四步收尾 · 自我学习复盘（强制）】phases.verification.retrospective 四项缺一不可：problems（现象+根因，至少 1 条）、detours（弯路/返工，确实没有写空数组 []）、resolutions（至少 1 条）、prevention（「遇到…先…」可执行硬规则，至少 1 条）。',
    '【第五步 · JSON mode 结构化交付】专家写 report 对象（keyResults / keyInfo / importantInfo / leadRequirements 四个字符串数组）；负责人写 departmentSummary 对象（keyResults / keyInfo / importantInfo / sources，sources 必须覆盖全部已派发专家）。成果块必须放在 <!-- WORKPLAN_EVIDENCE:START --> 与 <!-- WORKPLAN_EVIDENCE:END --> 之间，且是合法 JSON，不得用散文代替。',
    '开工闸与结算闸：前三步登记证据已经生效；收尾结果块允许省略 phases.planning / phases.preparation（平台自动并入登记原文，并集落账、不会变薄），只需写 phases.execution、phases.verification 与顶层 acceptance/artifacts/report 或 departmentSummary；若要补充执行期新事实，可在这两组里追加，平台会保留。缺 execution/verification、验证未全部通过、缺 report / departmentSummary 都会判未完成。第四步可用 dsh_workplan_verify 做最终核验；遇阻用 dsh_workplan_escalate 上报，它是安全通道，不属于五步产物。开工证据未交/不合格会被硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE）。',
    `硬下限（校验器逐字执行，缺一即退回）：${START_EVIDENCE_MIN_CHARS_BRIEF}。`,
    `硬上限（校验器逐字执行，超出即退回）：每个清单（数组）最多 ${MAX_PHASE_LIST_ITEMS} 条、每条最多 ${MAX_PHASE_ITEM_CHARS} 字；phases 四组（planning+preparation+execution+verification）全部条目合计最多 ${MAX_PHASE_TOTAL_CHARS} 字；phases.verification.checks 至少 1 条、且条数不得少于验收标准条数、必须逐条覆盖验收标准（可省略：平台会用顶层 acceptance 自动生成并逐条覆盖；显式写了则以你写的为准）。`,
    `复盘硬下限（校验器逐字执行）：retrospective.problems 至少 1 条、合计 ≥${MIN_RETRO_PROBLEM_CHARS} 字；resolutions 至少 1 条、合计 ≥${MIN_RETRO_RESOLUTION_CHARS} 字；prevention 至少 1 条、合计 ≥${MIN_RETRO_PREVENTION_CHARS} 字；detours 确实没有可写空数组 []。`,
  ]
}

/**
 * [3.0.8] 开工证据 = 五步第 1、2、3 步（planning + preparation）。
 *
 * 每个执行者（主 Agent / 部门负责人 / 全球顶尖专家）在开工前必须随开工工具
 * 提交：问题梳理、资源/工具/实施方案研究、准备与就绪证据。缺交/不合格硬拒
 * （START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），不登记、不接续；
 * 登记后 durable 持久化，续跑/重试/重启回放读档放行，无需重复提交。
 */
export type StartPhaseEvidence = {
  planning: PlanningPhase
  preparation: PreparationPhase
}

export type StartPhaseValidation = {
  ok: boolean
  code?: 'START_EVIDENCE_MISSING' | 'START_EVIDENCE_INCOMPLETE'
  error?: string
  evidence: StartPhaseEvidence | null
}

/**
 * 开工证据校验（dispatch / review / self_effort / direct 四个开工闸同一判据）。
 * 纯函数：工具层与测试同口径消费，门禁不能被提示词绕过。
 */
export function validateStartPhaseEvidence(value: any): StartPhaseValidation {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: 'START_EVIDENCE_MISSING',
      error: '开工证据缺失：执行自己的任务必须先完成五步前三步——第一步全面、全盘、深入梳理、研究、思考自己的任务；第二步基于第一步全部结果研究资源、工具与具体实施方案（方法、流程、步骤，含依据）；第三步把资源与工具真正备齐并给出就绪证据——然后随开工工具提交 startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }。未提交或不合格会被硬拒，不登记、不接续正式执行。',
      evidence: null,
    }
  }
  const errors: string[] = []
  const planningRaw = isRecord(value.planning) ? value.planning : null
  if (!planningRaw) errors.push('startPhases.planning 缺失（第一步 · 任务梳理 + 第二步 · 资源/工具/实施方案研究）')
  const preparationRaw = isRecord(value.preparation) ? value.preparation : null
  if (!preparationRaw) errors.push('startPhases.preparation 缺失（第三步 · 准备：把资源、工具、实施方案真正备齐并给出就绪证据）')
  const planning = parsePlanningPhase(planningRaw, errors, !!planningRaw)
  const preparation = parsePreparationPhase(preparationRaw, errors, !!preparationRaw)
  const prefix = (field: string) => field.replace(/^phases\./, 'startPhases.')
  const renamed = errors.map((item) => prefix(item))
  if (renamed.length > 0) {
    return { ok: false, code: 'START_EVIDENCE_INCOMPLETE', error: renamed.join('；'), evidence: null }
  }
  return { ok: true, evidence: { planning, preparation } }
}

/**
 * 回放侧消毒（写入与消费双侧同一判据）：durable 日志里的开工证据重新过一遍
 * 校验，非法/被篡改 ⇒ null（门禁要求重新提交），合法 ⇒ 归一化后的证据。
 * 旧日志无该字段 ⇒ undefined 进、null 出，零迁移不报错。
 */
export function sanitizeStartPhaseEvidence(value: any): StartPhaseEvidence | null {
  const check = validateStartPhaseEvidence(value)
  return check.ok ? check.evidence : null
}

/**
 * [3.0.8] 开工-结算一致性比对：结算时的 phases 不允许比开工登记的证据变薄。
 *
 * 机制动机：开工闸登记的第 1/2/3 步证据与结果块里的 phases.planning/preparation
 * 是同一份内容的两处载体；若无比对，执行者可以开工时写一套、收尾时另写一套
 * （甚至把薄的换成厚的、把厚的换成薄的）。规则（宽容新增、禁止变薄）：
 * 对开工登记过的每一个清单字段，结算对应清单的条数与合计字符数都必须
 * ≥ 开工登记值；违反即返回可读的违规描述（结算闸据此退回）。
 */
export function checkStartEvidenceCarryover(registered: StartPhaseEvidence, settlement: any): string[] {
  const violations: string[] = []
  if (!isRecord(settlement)) {
    return ['结果块缺少 phases 对象，无法与开工登记的第 1/2/3 步证据比对']
  }
  const groups: Array<{ key: 'planning' | 'preparation'; label: string; fields: Array<[string, string]> }> = [
    {
      key: 'planning',
      label: '第 1/2 步（任务梳理 + 资源/工具/方案研究）',
      fields: [
        ['problemAnalysis', '任务梳理'],
        ['approach', '方法流程步骤'],
        ['approachBasis', '第二步依据'],
        ['resources', '资源研究'],
        ['tools', '工具研究'],
      ],
    },
    {
      key: 'preparation',
      label: '第 3 步（准备）',
      fields: [
        ['prepared', '已备清单'],
        ['evidence', '就绪证据'],
      ],
    },
  ]
  for (const group of groups) {
    const registeredGroup: any = (registered as any)[group.key] ?? {}
    const settlementGroup: any = isRecord(settlement[group.key]) ? settlement[group.key] : null
    for (const [field, label] of group.fields) {
      const want: string[] = Array.isArray(registeredGroup[field]) ? registeredGroup[field] : []
      if (want.length === 0) continue
      const got: string[] = settlementGroup && Array.isArray(settlementGroup[field])
        ? settlementGroup[field].filter((item: any) => typeof item === 'string' && item.trim())
        : []
      const wantChars = totalChars(want)
      const gotChars = totalChars(got)
      if (got.length < want.length || gotChars < wantChars) {
        violations.push(
          `${group.label}的${label}变薄：开工登记 ${want.length} 条/${wantChars} 字，结算仅 ${got.length} 条/${gotChars} 字——收尾证据不得稀释开工时登记的第 1/2/3 步证据（可在执行中补充完善，不得减少）`,
        )
      }
    }
  }
  return violations
}

/**
 * [3.1.1] 结算自动归并（治本：跨会话登记的登记原文不进交卷人上下文）。
 *
 * 缺陷现场（2026-11-19，T2/T3）：部门负责人在自己的会话经 action="direct" 代登记
 * 开工证据（8 条/1242 字），平台另开全新执行子会话跑 phase-1——接续提示只转述
 * 「已登记」这个事实，登记的逐字原文从未进入执行者视野；执行者交卷时凭任务书
 * 重写一份更短的摘要（6 条/471 字），被结算闸开工-结算一致性比对退回
 * （EVIDENCE_INCOMPLETE）。执行者重试时自述 "I don't have the exact startPhases
 * text"，只能靠退回消息里的数字凑字数过闸——比对的数据源错了对象。
 *
 * 归并规则：登记内容是任务的 durable 事实，不因交卷人未复述而减少。对开工登记
 * 过的每个清单字段，取「交卷条目 ∪ 登记条目」的并集（交卷条目在前、登记条目
 * 按原序补入、逐字去重、每清单封顶 MAX_PHASE_LIST_ITEMS）后再比对并落账：
 *   - 执行者补充完善的内容全部保留（原「宽容新增」语义不变）；
 *   - 登记内容永不丢失（原「禁止变薄」语义由平台侧保证，不再依赖执行者自觉）；
 *   - 并集后条数/字数恒 ≥ 登记值，一致性比对恒过——比对仍保留作安全网
 *     （仅当封顶截断使登记条目装不下时才会真的退回，此时回喂通道已带登记原文）。
 *
 * 注意：validateFiveStepEvidence 的 MAX_PHASE_TOTAL_CHARS（6000 字）上限只约束
 * 交卷原文，不约束平台归并后的落账记录——登记原文本就是 durable 事实，归并
 * 只增不减，落账记录略超上限不影响任何下游消费（phaseSummaryLine 只数条数）。
 */
export function mergeStartEvidenceIntoSettlement(settlement: FiveStepPhases, registered: StartPhaseEvidence): FiveStepPhases {
  // 登记为 null/undefined（未登记、登记不合格被消毒丢弃、回放缺字段）时原样返回：
  // 调用点（plan.ts 结算链 / runtime.ts 回喂链）传的都是行级快照，可能缺字段。
  if (!registered || !registered.planning || !registered.preparation) return settlement
  const mergeList = (settleItems: string[], regItems: string[]): string[] => {
    if (!Array.isArray(regItems) || regItems.length === 0) return settleItems
    const base = Array.isArray(settleItems) ? settleItems : []
    const seen = new Set(base.map((item) => String(item).trim()))
    const additions = regItems.filter((item) => !seen.has(String(item).trim()))
    return [...base, ...additions].slice(0, MAX_PHASE_LIST_ITEMS)
  }
  settlement.planning.problemAnalysis = mergeList(settlement.planning.problemAnalysis, registered.planning.problemAnalysis)
  settlement.planning.approach = mergeList(settlement.planning.approach, registered.planning.approach)
  settlement.planning.approachBasis = mergeList(settlement.planning.approachBasis, registered.planning.approachBasis)
  settlement.planning.resources = mergeList(settlement.planning.resources, registered.planning.resources)
  settlement.planning.tools = mergeList(settlement.planning.tools, registered.planning.tools)
  settlement.preparation.prepared = mergeList(settlement.preparation.prepared, registered.preparation.prepared)
  settlement.preparation.evidence = mergeList(settlement.preparation.evidence, registered.preparation.evidence)
  return settlement
}

/**
 * [3.1.1] 开工登记证据的逐字渲染块：回注给交卷人（phase-1 接续提示 /
 * EVIDENCE_INCOMPLETE 回喂消息），让执行者照抄登记原文而不是凭记忆重写。
 * 登记内容经 sanitizeStartPhaseEvidence 消毒后传入，此处只做展示级截断（每条
 * 800 字与校验器上限同源），不再二次校验。
 */
export function renderStartPhaseEvidence(registered: StartPhaseEvidence): string {
  if (!registered || !registered.planning || !registered.preparation) return ''
  const lines: string[] = []
  const push = (label: string, items: string[]) => {
    if (!Array.isArray(items) || items.length === 0) return
    lines.push(`${label}：`)
    items.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${String(item).slice(0, MAX_PHASE_ITEM_CHARS)}`)
    })
  }
  push('第一步·任务梳理 problemAnalysis', registered.planning.problemAnalysis)
  push('第二步·资源研究 resources', registered.planning.resources)
  push('第二步·工具研究 tools', registered.planning.tools)
  push('第二步·方法流程步骤 approach（执行蓝图，严格照做）', registered.planning.approach)
  push('第二步·依据 approachBasis', registered.planning.approachBasis)
  push('第三步·已备清单 prepared', registered.preparation.prepared)
  push('第三步·就绪证据 evidence', registered.preparation.evidence)
  return lines.join('\n')
}

/**
 * [3.1.7] 接续用的「执行蓝图」：只保留真正指导执行的两段（approach / approachBasis）。
 *
 * 其余登记清单（任务梳理、资源、工具、已备、就绪证据）是**审计链**，不该在每次
 * 接续时把全文再贴一遍——完整原文随接续一起落盘，需要逐字核对时读文件。
 * 这样既不会丢任何证据（文件里是原文），又只在提示词里为「必须照做」的部分付费。
 */
export function renderStartEvidenceBlueprint(registered: StartPhaseEvidence): string {
  if (!registered || !registered.planning) return ''
  const lines: string[] = []
  const push = (label: string, items: string[]) => {
    if (!Array.isArray(items) || items.length === 0) return
    lines.push(`${label}：`)
    items.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${String(item).slice(0, MAX_PHASE_ITEM_CHARS)}`)
    })
  }
  push('第二步·方法流程步骤 approach（执行蓝图，严格照做）', registered.planning.approach)
  push('第二步·依据 approachBasis', registered.planning.approachBasis)
  return lines.join('\n')
}

/** [3.1.7] 其余登记清单的规模索引（只报条数与字数，不重复正文）。 */
export function startEvidenceIndexLines(registered: StartPhaseEvidence): string[] {
  if (!registered) return []
  const rows: Array<[string, string[]]> = [
    ['第一步·任务梳理 problemAnalysis', (registered.planning as any)?.problemAnalysis ?? []],
    ['第二步·资源研究 resources', (registered.planning as any)?.resources ?? []],
    ['第二步·工具研究 tools', (registered.planning as any)?.tools ?? []],
    ['第三步·已备清单 prepared', (registered.preparation as any)?.prepared ?? []],
    ['第三步·就绪证据 evidence', (registered.preparation as any)?.evidence ?? []],
  ]
  return rows
    .filter(([, items]) => Array.isArray(items) && items.length > 0)
    .map(([label, items]) => `${label}：${items.length} 条 / ${items.reduce((sum, item) => sum + String(item).length, 0)} 字`)
}
