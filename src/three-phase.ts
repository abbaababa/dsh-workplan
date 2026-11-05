/**
 * [1.13.0] 三阶段工作法：部门 Agent 的强制执行顺序。
 *
 * 用户要求（2026-11-05）：每个部门人员收到分配的工作后，必须
 *   1. 先全面、深入梳理「要解决的问题」；
 *   2. 再全面、深入思考，整理出能完美完成自身工作的完整、可执行思路；
 *   3. 只有前两步完成后，才按思路执行与验证。
 * 全过程按先后顺序分为三个阶段：规划阶段 → 执行阶段 → 验证阶段。
 * 阶段三允许用 dsh_workplan_verify 核验；缺 planning/execution 证据时返回 PHASE_GATE。
 * 注意（2.0.2 更正）：2026-11-05 的「第一、二阶段禁用插件」只是当次优化会话的
 * 过程约束，不是对所有后续会话的产品规则；插件不全局禁用。
 *
 * 这个模块只做纯函数与常量，不依赖 harness 服务：
 *   - 校验子 Agent 回报的 `phases` 证据（缺一阶段就判未完成）；
 *   - 生成阶段摘要（写进结果与日志）；
 *   - 生成提示词段落（由 `buildChildPrompt` 拼进子 Agent 的提示词）。
 *
 * 为什么用「结构化证据」而不是只写一句提示：
 * 只写提示词时，模型可以直接动手、最后补一句「我已规划」。把规划内容变成
 * 收尾证据的一部分后，缺规划/缺验证的结果无法被记成 done，主 Agent 和
 * 回放日志都能看到每个部门到底梳理了什么、按什么思路做、验证了什么。
 */

import { type Retrospective, validateRetrospective } from './lessons.js'

/** 三阶段顺序不可颠倒；这里也是结果块里 `phases` 的键名。 */
export const THREE_PHASE_IDS = Object.freeze(['planning', 'execution', 'verification'] as const)
export const THREE_PHASE_VERSION = 1

/**
 * 「全面、深入」无法由代码度量，但可以给一个不可忽略的下限：
 * 问题梳理与可执行思路各至少 40 个字符，避免一个词就冒充规划。
 */
export const MIN_PLANNING_PROBLEM_CHARS = 40
export const MIN_PLANNING_APPROACH_CHARS = 40
export const MAX_PHASE_LIST_ITEMS = 20
export const MAX_PHASE_ITEM_CHARS = 800
export const MAX_PHASE_TOTAL_CHARS = 6000

export type PhaseCheck = {
  criterion: string
  method: string
  evidence: string
}

export type PlanningPhase = {
  problemAnalysis: string[]
  constraints: string[]
  unknowns: string[]
  approach: string[]
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
   * [2.0.0] 阶段三的自我学习复盘（用户 2026-11-05 强制要求）。
   *
   * 三阶段仍是「规划 → 执行 → 验证」三个阶段：复盘不是第四个阶段，而是
   * 验证阶段收尾的必填项 —— 完成之后、报 done 之前，必须把本次全过程遇到的
   * 问题、弯路、解决方式与防再犯规则说清楚，并由 lessons.ts 落盘成永久记忆。
   */
  retrospective: Retrospective
}

export type ThreePhases = {
  version: number
  planning: PlanningPhase
  execution: ExecutionPhase
  verification: VerificationPhase
}

export type PhaseValidation = {
  ok: boolean
  phases: ThreePhases | null
  errors: string[]
  /** 错误落在哪个阶段：'planning' | 'execution' | 'verification' | 'shape' */
  failedPhase: 'planning' | 'execution' | 'verification' | 'shape' | null
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
 * Same matching rules as `src/plan.ts#acceptanceCoverage` (Q6 / U-16):
 * stable A1…An numbering, exact full text, or a longer text containing the
 * full criterion. A partial copy must not count as coverage.
 *
 * Kept local to avoid importing plan.ts (which imports this module); the
 * rules are pinned by tests on both sides.
 */
function normaliseCriterion(value: any) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，。；、,.;:：!！?？"'“”‘’()（）\[\]【】《》<>]/g, '')
    .replace(/^(必须|需要|应当|应该|请|务必)/, '')
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
      return row.includes(criterion)
    })
    if (!covered) missing.push(`A${index + 1}`)
  }
  return missing
}

/**
 * Parse + validate the `phases` object from a child's evidence block.
 *
 * `expectedAcceptance` is the plan's own acceptance table. When present, every
 * criterion must have a verification check; a shorter list is treated as an
 * incomplete phase-3 verification rather than "some checks are better than none".
 */
export function validatePhaseEvidence(value: any, expectedAcceptance: any = []): PhaseValidation {
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
      errors: ['phases 缺失：必须提交 planning / execution / verification 三阶段证据'],
      failedPhase: 'shape',
    }
  }
  const planningRaw = isRecord(value.planning) ? value.planning : null
  if (!planningRaw) fail('planning', 'phases.planning 缺失（阶段一：先梳理问题，再形成可执行思路）')
  const executionRaw = isRecord(value.execution) ? value.execution : null
  if (!executionRaw) fail('execution', 'phases.execution 缺失（阶段二：按阶段一的思路执行）')
  const verificationRaw = isRecord(value.verification) ? value.verification : null
  if (!verificationRaw) fail('verification', 'phases.verification 缺失（阶段三：逐条验证）')

  const planning: PlanningPhase = {
    problemAnalysis: readTextList(planningRaw?.problemAnalysis, 'phases.planning.problemAnalysis', errors, {
      required: !!planningRaw,
      minItems: 1,
    }),
    constraints: readTextList(planningRaw?.constraints, 'phases.planning.constraints', errors, { required: false }),
    unknowns: readTextList(planningRaw?.unknowns, 'phases.planning.unknowns', errors, { required: false }),
    approach: readTextList(planningRaw?.approach, 'phases.planning.approach', errors, {
      required: !!planningRaw,
      minItems: 1,
    }),
  }
  if (errors.some((item) => item.startsWith('phases.planning.problemAnalysis'))) failedPhase ||= 'planning'
  if (errors.some((item) => item.startsWith('phases.planning.approach'))) failedPhase ||= 'planning'
  if (planning.problemAnalysis.length > 0 && totalChars(planning.problemAnalysis) < MIN_PLANNING_PROBLEM_CHARS) {
    fail('planning', `phases.planning.problemAnalysis 太薄（合计 ${totalChars(planning.problemAnalysis)} 字，至少 ${MIN_PLANNING_PROBLEM_CHARS} 字）：要逐条写清现状、约束、未知与主要矛盾`)
  }
  if (planning.approach.length > 0 && totalChars(planning.approach) < MIN_PLANNING_APPROACH_CHARS) {
    fail('planning', `phases.planning.approach 太薄（合计 ${totalChars(planning.approach)} 字，至少 ${MIN_PLANNING_APPROACH_CHARS} 字）：要写出完整可执行的步骤，而不是一句目标`)
  }

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

  const phases: ThreePhases = {
    version: THREE_PHASE_VERSION,
    planning,
    execution,
    verification,
  }
  const total = [
    ...planning.problemAnalysis,
    ...planning.constraints,
    ...planning.unknowns,
    ...planning.approach,
    ...execution.steps,
    ...execution.deviations,
    verification.requirementCheck,
  ].reduce((sum, item) => sum + item.length, 0)
  if (total > MAX_PHASE_TOTAL_CHARS) {
    fail('shape', `phases 合计超过 ${MAX_PHASE_TOTAL_CHARS} 字，请压缩到可核对的事实，不要粘贴大段日志`)
  }
  return { ok: errors.length === 0, phases: errors.length === 0 ? phases : null, errors, failedPhase }
}

/**
 * Which stage a caller is allowed to be in, judged only by the evidence it sent.
 *
 * Used by `dsh_workplan_verify`: planning/execution gaps mean the caller is
 * still in phase 1 or 2, where the plugin is disabled by the user's rule.
 */
export function phaseGateFromErrors(errors: string[]): 'phase-1-2' | 'verification' {
  return errors.some((item) => /^phases(\.| 缺失)/.test(item) && /planning|execution/.test(item))
    ? 'phase-1-2'
    : 'verification'
}

/** One-line, model-readable summary of what the three phases contain. */
export function phaseSummaryLine(phases: ThreePhases): string {
  const deviations = phases.execution.deviations.length
  return [
    `阶段一 规划（问题梳理 ${phases.planning.problemAnalysis.length} 条 / 可执行思路 ${phases.planning.approach.length} 步）`,
    `阶段二 执行（${phases.execution.steps.length} 步${deviations ? ` / 偏离 ${deviations} 处` : ''}）`,
    `阶段三 验证（${phases.verification.checks.length} 项${phases.verification.allPassed ? '，全部通过' : '，未全部通过'}；`
      + `复盘 ${phases.verification.retrospective.problems.length} 个问题 / `
      + `${phases.verification.retrospective.detours.length} 条弯路 / `
      + `${phases.verification.retrospective.prevention.length} 条防再犯规则）`,
  ].join('；')
}

/**
 * Prompt paragraphs injected into every department child.
 *
 * Kept in this module so the wording and the validator above are one contract:
 * changing what is demanded without changing what is checked would make the
 * prompt lie about completion.
 */
export function threePhasePromptLines(): string[] {
  return [
    '三阶段工作法（用户强制要求；顺序不可颠倒，阶段一没有产出思路之前禁止动手执行）：',
    '【阶段一 · 规划阶段】',
    '  1) 先全面、深入梳理要解决的问题：逐条写清现状与已知事实、约束条件、未知/待确认项、主要矛盾、工作边界；',
    '  2) 再全面、深入思考，整理出能完美完成本子任务的完整、可执行思路：每一步做什么、产出什么、依赖什么、风险与对策、如何证明做对了；',
    '  3) 自检：任何一条验收标准或用户原要求没有落在思路上，就回到第 1 步重做；思路不完整不得进入阶段二。',
    '【阶段二 · 执行阶段】',
    '  严格按阶段一整理出的思路执行。出现新事实需要偏离时，必须记录偏离原因、证据与调整后的做法，不得静默改道。',
    '【阶段三 · 验证阶段】',
    '  执行完成后逐条验证验收标准与用户原要求：每条都要有可复核的证据（命令输出/文件/引用）；验证未通过不得报 done，无法确认写 unverified。',
    '【阶段三收尾 · 自我学习复盘（强制）】',
    '  报 done 之前必须把 phases.verification.retrospective 写全，四项缺一不可：',
    '  1) problems：本次全过程遇到的所有问题（现象 + 根因），至少 1 条；',
    '  2) detours：走过的弯路、返工与无效尝试（确实没有就写空数组 []，不要编造）；',
    '  3) resolutions：最终是如何解决上述问题的，至少 1 条，可与 problems 一一对应；',
    '  4) prevention：以后如何预防再犯，至少 1 条，必须写成「遇到…先…」的可执行硬规则。',
    '  插件会在完成判定时复核这四项，并在通过后把复盘写入永久记忆文件；下次派发同类任务时，历史教训会自动出现在提示词里。',
    '插件使用说明（三阶段证据门禁）：',
    '  - 阶段一、二：先把问题梳理、可执行思路与执行记录写全；此时不要调用 dsh_workplan_verify，它会因缺少前两阶段证据返回 PHASE_GATE 与待补项（这是证据门禁，不是禁用插件）。',
    '  - 阶段三：可以调用 dsh_workplan_verify 让插件做最终核验：提交 planning / execution / verification 三阶段证据，插件返回 passed 或仍需补齐的 gaps；未通过先修复再回报。遇阻时可用 dsh_workplan_escalate 上报，它是安全通道，不属于三阶段产物。',
    '  - 结果块里的 phases 是必填项：缺任一阶段、内容为空、或验证未全部通过，插件都会判为未完成，不能用 done 收尾。',
  ]
}
