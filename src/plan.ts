/**
 * Pure planning helpers for dsh-workplan.
 *
 * This module deliberately has no dependency on DeepSeek Harness services. It
 * owns the plan contract, JSON extraction/validation, the planner prompt, the
 * durable message format, and the pure status/graph helpers used by the host
 * runtime and by unit tests.
 */

import { randomUUID } from 'node:crypto'

export const PLAN_VERSION = 1
export const MAX_STAGES = 6
export const MAX_SUBTASKS = 15
export const MAX_CONCURRENT = 5
export const MAX_PLAN_JSON_CHARS = 60000

export const PLAN_MARKER_BEGIN = '<!-- DSH-WORKPLAN:BEGIN -->'
export const PLAN_MARKER_END = '<!-- DSH-WORKPLAN:END -->'
export const RESULT_MARKER_BEGIN = '<!-- DSH-WORKPLAN-RESULT:BEGIN -->'
export const RESULT_MARKER_END = '<!-- DSH-WORKPLAN-RESULT:END -->'
export const CANCEL_MARKER_BEGIN = '<!-- DSH-WORKPLAN-CANCEL:BEGIN -->'
export const CANCEL_MARKER_END = '<!-- DSH-WORKPLAN-CANCEL:END -->'
/*
 * [1.7.0] Two new durable message kinds.
 *
 * The child's structured result travels inside its own reply (not the session
 * log), while a manual re-adjudication by the main Agent must survive a page
 * refresh — before this it existed only in memory and vanished on reload.
 */
export const EVIDENCE_MARKER_BEGIN = '<!-- WORKPLAN_EVIDENCE:START -->'
export const EVIDENCE_MARKER_END = '<!-- WORKPLAN_EVIDENCE:END -->'
export const UPDATE_MARKER_BEGIN = '<!-- DSH-WORKPLAN-UPDATE:BEGIN -->'
export const UPDATE_MARKER_END = '<!-- DSH-WORKPLAN-UPDATE:END -->'

/** Upper bound for the run-time conversation window (single truncation point). */
export const MAX_CONVERSATION_CHARS = 7000
/** Upper bound for one child evidence block; longer blocks are truncated. */
export const MAX_EVIDENCE_BLOCK_CHARS = 8000
export const MAX_EVIDENCE_ACCEPTANCE = 20
export const MAX_EVIDENCE_ARTIFACTS = 20
export const MAX_EVIDENCE_NEEDS = 10
export const VERIFICATIONS = Object.freeze(['structured', 'legacy', 'unverified', 'failed', 'unparsable'])
export const EVIDENCE_STATUSES = Object.freeze(['done', 'blocked', 'partial'])
export const ACCEPTANCE_RESULTS = Object.freeze(['pass', 'fail', 'unverified'])

export const STATUSES = Object.freeze(['pending', 'in_progress', 'done', 'blocked'])
export const LIKELIHOODS = Object.freeze(['low', 'medium', 'high'])

export const DEPARTMENTS = Object.freeze({
  engineering: { zh: '工程研发', en: 'Engineering' },
  research: { zh: '研究分析', en: 'Research' },
  design: { zh: '设计', en: 'Design' },
  product: { zh: '产品', en: 'Product' },
  data: { zh: '数据', en: 'Data' },
  qa: { zh: '质量验证', en: 'QA' },
  security: { zh: '安全', en: 'Security' },
  devops: { zh: '运维', en: 'DevOps' },
  writing: { zh: '文档写作', en: 'Writing' },
  operations: { zh: '运营', en: 'Operations' },
  legal: { zh: '法务合规', en: 'Legal' },
  finance: { zh: '财务', en: 'Finance' },
})

export const DEPARTMENT_IDS = Object.freeze(Object.keys(DEPARTMENTS))

export class PlanError extends Error {
  code: string
  details: unknown

  constructor(message: string, code: any = 'PLAN_ERROR', details: unknown = undefined) {
    super(message)
    this.name = 'PlanError'
    this.code = code
    this.details = details
  }
}

export function isRecord(value: any) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function truncate(value: any, max: any) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

export function messageText(message: any) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
}

/*
 * Lightweight conversational inputs must not start the planning pipeline.
 *
 * This is deliberately a conservative, deterministic token list rather than a
 * model call: a greeting should never pay for a planner request or spawn
 * department agents. The check only returns true when EVERY meaningful token is
 * a known greeting/thanks/acknowledgement/farewell. "你好，帮我写代码" keeps
 * the task text and therefore still gets a plan.
 */
const SOCIAL_PHRASES = Object.freeze([
  'thank you very much',
  'nice to meet you',
  'how are you doing',
  'have a nice day',
  'see you later',
  'good afternoon',
  'good morning',
  'good evening',
  "how's it going",
  'hello there',
  'hi there',
  'hey there',
  'thank you',
  'see you',
  'good night',
  'what\'s up',
  'thanks a lot',
  'goodbye',
  'bye bye',
  '谢谢你',
  '谢谢你了',
  '辛苦了',
  '麻烦你了',
  '好久不见',
  '最近怎么样',
  '最近好吗',
  '很高兴认识你',
  '早上好',
  '上午好',
  '中午好',
  '下午好',
  '晚上好',
  '晚安',
  '早安',
  '午安',
  '早点休息',
  '亲爱的',
  '大家好',
  '你好',
  '您好',
  '哈喽',
  '请问',
  '在吗',
  '在么',
  '谢谢',
  '多谢',
  '再见',
  '拜拜',
  '好的',
  '收到',
  '明白了',
  '没问题',
  '不客气',
  '没关系',
  'hello',
  'thanks',
  'thank you',
  'good morning',
  'good night',
  'see you',
  'okay',
  'ok',
  'yes',
  'yep',
  'sure',
  'cool',
  'great',
  'nice',
  'lol',
  'hey',
  'hi',
  'yo',
  'sup',
  'thx',
  'bye',
  '嗯嗯',
  '哈哈',
  '嘿嘿',
  '呵呵',
  '老师',
  '同学',
  '朋友',
  '大佬',
  '老板',
  '先生',
  '女士',
  '好',
  '行',
  '可以',
  '嗯',
  '哦',
  '噢',
  '嗨',
  '嘿',
])

const SOCIAL_TRAILING_PARTICLES = /[呀啊呢吧啦哦噢嗯哈嘛喽咯哒滴了喔唔嘿呵吗]+$/u

export function isSocialMessage(value: any) {
  if (typeof value !== 'string') return false
  const original = value.trim()
  if (original.length === 0 || original.length > 60) return false
  let rest = original.toLowerCase()
  for (const phrase of SOCIAL_PHRASES) {
    if (!rest.includes(phrase)) continue
    rest = rest.split(phrase).join(' ')
  }
  rest = rest.replace(/[\s\p{P}\p{S}]+/gu, '')
  rest = rest.replace(SOCIAL_TRAILING_PARTICLES, '')
  return rest.length === 0
}

/*
 * A bare "continue" carries no new task content. The planner only sees the
 * current message, so it cannot know what to continue; planning it produces a
 * huge plan for an unknown object. The main Agent has the conversation history
 * and should continue directly (or ask which thread), so this gate bypasses the
 * planner exactly like a social message.
 */
const VAGUE_CONTINUATIONS = Object.freeze([
  'continue',
  'keep going',
  'carry on',
  'go on',
  'proceed',
  '继续推进',
  '继续做',
  '继续吧',
  '接着来',
  '接着做',
  '往下推进',
  '往下做',
  '然后呢',
  '接下来',
  '下一步',
  '继续',
  '接着',
  '往下',
  '再来',
  '开始吧',
  '干吧',
  'next',
])

export function isVagueContinuation(value: any) {
  if (typeof value !== 'string') return false
  const original = value.trim()
  if (original.length === 0 || original.length > 24) return false
  let rest = original.toLowerCase()
  for (const phrase of VAGUE_CONTINUATIONS) {
    if (!rest.includes(phrase)) continue
    rest = rest.split(phrase).join(' ')
  }
  rest = rest.replace(/[\s\p{P}\p{S}]+/gu, '')
  if (rest.length === 0) return true
  /*
   * "B继续" / "按B继续" / "方案B继续" continue a decision already made in the
   * conversation. The main Agent can see that decision; the planner only sees
   * this short message, so planning it invents a huge new task. Require a short
   * tail so "继续修复这个 bug" is still planned.
   */
  const compact = original.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  if (/继续|接着|往下|下一步/.test(compact)) {
    const tail = compact.replace(/继续|接着|往下|下一步|方案|按照|按|就|吧|呀|啊|呢/g, '')
    if (tail.length <= 2) return true
  }
  return false
}

/*
 * A status question asks about work already recorded; planning and dispatching
 * it creates a second plan about the first plan and is guaranteed to feed back
 * on itself. The main Agent can answer it from the session log/dashboard, so
 * this gate bypasses the planner. It deliberately requires a question/status
 * form so a real repair task such as "修复卡住的任务" still gets planned.
 */
const STATUS_PATTERNS = Object.freeze([
  /完成(了)?(吗|么|没有|没|嘛)/,
  /(全部|全都|都|已经).{0,6}完成/,
  /(做|写|改|修)(完|好)(了)?(吗|么|没有|没|嘛)/,
  /进度(如何|怎么样|多少|到哪|呢|吗)?/,
  /卡住(了)?(吗|么|没有|没|嘛)?/,
  /(还|剩)(有|下|余)?.{0,6}(多少|几|什么|哪些)/,
  /是否.{0,8}(完成|做完|卡住|进行|通过)/,
  /正确(吗|么|不)/,
  /(显示|数字|统计|具体工作).{0,12}(正确|对不上|不一致|不对)/,
  /(对不上|不一致)(吗|么|？|\?)/,
  /(status|progress|done yet|completed|how many.*(left|remain)|what.*(left|remain))/i,
])

export function isStatusQuestion(value: any) {
  if (typeof value !== 'string') return false
  const original = value.trim()
  if (original.length === 0 || original.length > 120) return false
  const looksLikeQuestion = /[?？]/.test(original)
    || /(吗|呢|没有|是否|多少|几|如何|怎么样|到哪)/.test(original)
    || /^(查|看|告诉我|确认|核对).{0,8}(进度|状态|完成|卡住)/.test(original)
  if (!looksLikeQuestion) return false
  // A request to change/repair the progress UI is a real task, not a status
  // question, even though it contains the word 进度.
  if (/(改进|优化|设计|修复|实现|增加|调整|开发|重构|排查|诊断|改造|排版)/.test(original)) return false
  return STATUS_PATTERNS.some((pattern) => pattern.test(original))
}

function push(errors: string[], path: string, message: string) {
  errors.push(`${path}: ${message}`)
}

function readString(value: any, path: any, min: any, max: any, errors: any) {
  if (typeof value !== 'string') {
    push(errors, path, '必须是字符串')
    return ''
  }
  const text = value.trim()
  if (text.length < min) {
    push(errors, path, `长度不能小于 ${min}`)
    return text
  }
  if (text.length > max) {
    push(errors, path, `长度不能超过 ${max}`)
    return text.slice(0, max)
  }
  return text
}

function readStringArray(value: any, path: string, options: any, errors: string[]) {
  const opts = { min: 0, max: 20, itemMax: 2000, ...options }
  if (!Array.isArray(value)) {
    push(errors, path, '必须是字符串数组')
    return []
  }
  if (value.length < opts.min) push(errors, path, `至少需要 ${opts.min} 项`)
  if (value.length > opts.max) push(errors, path, `最多允许 ${opts.max} 项`)
  const out: string[] = []
  value.slice(0, opts.max).forEach((item: any, index: any) => {
    if (typeof item !== 'string') {
      push(errors, `${path}[${index}]`, '必须是字符串')
      return
    }
    const text = item.trim()
    if (text.length === 0) {
      push(errors, `${path}[${index}]`, '不能为空')
      return
    }
    if (text.length > opts.itemMax) {
      push(errors, `${path}[${index}]`, `长度不能超过 ${opts.itemMax}`)
      out.push(text.slice(0, opts.itemMax))
      return
    }
    out.push(text)
  })
  return out
}

function readEnum(value: any, path: any, allowed: any, errors: any) {
  if (!allowed.includes(value)) {
    push(errors, path, `必须是 ${allowed.join(' / ')} 之一`)
    return allowed[0]
  }
  return value
}

function readTaskUnderstanding(value: any, errors: any) {
  const source = isRecord(value) ? value : {}
  if (!isRecord(value)) push(errors, 'taskUnderstanding', '必须是对象')
  return {
    originalRequest: readString(source.originalRequest, 'taskUnderstanding.originalRequest', 1, 8000, errors),
    deliverable: readString(source.deliverable, 'taskUnderstanding.deliverable', 1, 2000, errors),
    successCriteria: readStringArray(
      source.successCriteria,
      'taskUnderstanding.successCriteria',
      { min: 1, max: 20, itemMax: 600 },
      errors,
    ),
    constraints: readStringArray(
      source.constraints,
      'taskUnderstanding.constraints',
      { min: 0, max: 20, itemMax: 600 },
      errors,
    ),
    knownFacts: readStringArray(
      source.knownFacts,
      'taskUnderstanding.knownFacts',
      { min: 0, max: 20, itemMax: 600 },
      errors,
    ),
    unknowns: readStringArray(
      source.unknowns,
      'taskUnderstanding.unknowns',
      { min: 0, max: 20, itemMax: 600 },
      errors,
    ),
    assumptions: readStringArray(
      source.assumptions,
      'taskUnderstanding.assumptions',
      { min: 0, max: 20, itemMax: 600 },
      errors,
    ),
  }
}

function readContradictions(value: any, errors: any) {
  const source = isRecord(value) ? value : {}
  if (!isRecord(value)) push(errors, 'contradictions', '必须是对象')
  const primary = isRecord(source.primary) ? source.primary : {}
  if (!isRecord(source.primary)) push(errors, 'contradictions.primary', '必须是对象')
  return {
    primary: {
      statement: readString(primary.statement, 'contradictions.primary.statement', 1, 1200, errors),
      evidence: readStringArray(
        primary.evidence,
        'contradictions.primary.evidence',
        { min: 1, max: 10, itemMax: 800 },
        errors,
      ),
      whyPrimary: readString(primary.whyPrimary, 'contradictions.primary.whyPrimary', 1, 1200, errors),
    },
    secondary: readStringArray(
      source.secondary,
      'contradictions.secondary',
      { min: 0, max: 10, itemMax: 800 },
      errors,
    ),
    transformationConditions: readStringArray(
      source.transformationConditions,
      'contradictions.transformationConditions',
      { min: 0, max: 10, itemMax: 800 },
      errors,
    ),
  }
}

function readSubtasks(value: any, stageIndex: any, errors: any) {
  const path = `stages[${stageIndex}].subtasks`
  if (!Array.isArray(value)) {
    push(errors, path, '必须是数组')
    return []
  }
  if (value.length < 1) push(errors, path, '每个阶段至少需要 1 个子任务')
  if (value.length > MAX_SUBTASKS) push(errors, path, `最多允许 ${MAX_SUBTASKS} 个子任务`)
  return value.slice(0, MAX_SUBTASKS).map((item: any, index: any) => {
    const source = isRecord(item) ? item : {}
    const base = `${path}[${index}]`
    if (!isRecord(item)) push(errors, base, '必须是对象')
    const department = typeof source.department === 'string'
      ? source.department
      : ''
    if (!DEPARTMENTS[department as keyof typeof DEPARTMENTS]) {
      push(errors, `${base}.department`, `必须是 ${DEPARTMENT_IDS.join(' / ')} 之一`)
    }
    return {
      id: readString(source.id, `${base}.id`, 1, 16, errors),
      title: readString(source.title, `${base}.title`, 1, 200, errors),
      department,
      role: readString(source.role, `${base}.role`, 1, 200, errors),
      objective: readString(source.objective, `${base}.objective`, 1, 2000, errors),
      method: readStringArray(source.method, `${base}.method`, { min: 1, max: 8, itemMax: 800 }, errors),
      inputs: readStringArray(source.inputs, `${base}.inputs`, { min: 0, max: 12, itemMax: 800 }, errors),
      outputs: readStringArray(source.outputs, `${base}.outputs`, { min: 1, max: 12, itemMax: 800 }, errors),
      dependsOn: readStringArray(source.dependsOn, `${base}.dependsOn`, { min: 0, max: 12, itemMax: 16 }, errors),
      acceptance: readStringArray(source.acceptance, `${base}.acceptance`, { min: 1, max: 8, itemMax: 800 }, errors),
      risk: readString(source.risk, `${base}.risk`, 1, 1000, errors),
      /*
       * [1.7.0] Optional time estimate, advisory only. Validation never fails on
       * a missing or out-of-range value: a plan that cannot be dispatched is
       * worse than one carrying a rough estimate.
       */
      ...(Number.isFinite(Number(source.estimateMinutes))
        ? { estimateMinutes: Math.min(15, Math.max(1, Math.round(Number(source.estimateMinutes)))) }
        : {}),
    }
  })
}

function readStages(value: any, errors: any) {
  if (!Array.isArray(value)) {
    push(errors, 'stages', '必须是数组')
    return []
  }
  if (value.length < 1 || value.length > MAX_STAGES) {
    push(errors, 'stages', `数量必须为 1-${MAX_STAGES}`)
  }
  return value.slice(0, MAX_STAGES).map((item: any, index: any) => {
    const source = isRecord(item) ? item : {}
    const base = `stages[${index}]`
    if (!isRecord(item)) push(errors, base, '必须是对象')
    return {
      id: readString(source.id, `${base}.id`, 1, 16, errors),
      name: readString(source.name, `${base}.name`, 1, 200, errors),
      goal: readString(source.goal, `${base}.goal`, 1, 1200, errors),
      rationale: readString(source.rationale, `${base}.rationale`, 1, 1200, errors),
      checkpoint: readString(source.checkpoint, `${base}.checkpoint`, 1, 1200, errors),
      subtasks: readSubtasks(source.subtasks, index, errors),
    }
  })
}

function readRisks(value: any, errors: any) {
  if (!Array.isArray(value)) {
    push(errors, 'risks', '必须是数组')
    return []
  }
  if (value.length > 8) push(errors, 'risks', '最多允许 8 项')
  return value.slice(0, 8).map((item: any, index: any) => {
    const source = isRecord(item) ? item : {}
    const base = `risks[${index}]`
    if (!isRecord(item)) push(errors, base, '必须是对象')
    return {
      risk: readString(source.risk, `${base}.risk`, 1, 800, errors),
      likelihood: readEnum(source.likelihood, `${base}.likelihood`, LIKELIHOODS, errors),
      impact: readString(source.impact, `${base}.impact`, 1, 800, errors),
      mitigation: readString(source.mitigation, `${base}.mitigation`, 1, 800, errors),
      trigger: readString(source.trigger, `${base}.trigger`, 1, 800, errors),
    }
  })
}

function readVerification(value: any, errors: any) {
  if (!Array.isArray(value)) {
    push(errors, 'verification', '必须是数组')
    return []
  }
  if (value.length < 1) push(errors, 'verification', '至少需要 1 项')
  if (value.length > 12) push(errors, 'verification', '最多允许 12 项')
  return value.slice(0, 12).map((item: any, index: any) => {
    const source = isRecord(item) ? item : {}
    const base = `verification[${index}]`
    if (!isRecord(item)) push(errors, base, '必须是对象')
    return {
      item: readString(source.item, `${base}.item`, 1, 600, errors),
      method: readString(source.method, `${base}.method`, 1, 800, errors),
      evidence: readString(source.evidence, `${base}.evidence`, 1, 800, errors),
    }
  })
}

function readPracticeLoop(value: any, errors: any) {
  const source = isRecord(value) ? value : {}
  if (!isRecord(value)) push(errors, 'practiceLoop', '必须是对象')
  return {
    plan: readString(source.plan, 'practiceLoop.plan', 1, 800, errors),
    do: readString(source.do, 'practiceLoop.do', 1, 800, errors),
    check: readString(source.check, 'practiceLoop.check', 1, 800, errors),
    act: readString(source.act, 'practiceLoop.act', 1, 800, errors),
  }
}

function checkPlanGraph(plan: any, errors: string[]) {
  const stageIds = new Set()
  const subtaskIds = new Set()
  const order = new Map()
  const dependencies = new Map()
  let nextOrder = 0
  let total = 0

  for (const [stageIndex, stage] of plan.stages.entries()) {
    if (!stage.id) {
      push(errors, `stages[${stageIndex}].id`, '不能为空')
      continue
    }
    if (stageIds.has(stage.id)) {
      push(errors, `stages[${stageIndex}].id`, `阶段 ID 重复：${stage.id}`)
    }
    stageIds.add(stage.id)
    for (const [subtaskIndex, subtask] of stage.subtasks.entries()) {
      const base = `stages[${stageIndex}].subtasks[${subtaskIndex}]`
      total += 1
      if (!subtask.id) {
        push(errors, `${base}.id`, '不能为空')
        continue
      }
      if (subtaskIds.has(subtask.id)) {
        push(errors, `${base}.id`, `子任务 ID 重复：${subtask.id}`)
      }
      subtaskIds.add(subtask.id)
      order.set(subtask.id, nextOrder)
      dependencies.set(subtask.id, subtask.dependsOn)
      nextOrder += 1
    }
  }

  if (total < 1) push(errors, 'stages', '至少需要 1 个子任务')
  if (total > MAX_SUBTASKS) push(errors, 'stages', `子任务总数不能超过 ${MAX_SUBTASKS}`)

  for (const [stageIndex, stage] of plan.stages.entries()) {
    for (const [subtaskIndex, subtask] of stage.subtasks.entries()) {
      const base = `stages[${stageIndex}].subtasks[${subtaskIndex}]`
      for (const dependency of subtask.dependsOn) {
        if (!order.has(dependency)) {
          push(errors, `${base}.dependsOn`, `未知子任务依赖：${dependency}`)
          continue
        }
        if (order.get(dependency) >= order.get(subtask.id)) {
          push(errors, `${base}.dependsOn`, `依赖必须位于更早阶段或更早位置：${dependency}`)
        }
      }
    }
  }

  const visiting = new Set()
  const visited = new Set()
  function visit(id: any) {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      push(errors, 'stages', `依赖存在环：${id}`)
      return
    }
    visiting.add(id)
    for (const dependency of dependencies.get(id) ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of dependencies.keys()) visit(id)

  let serialized = ''
  try {
    serialized = JSON.stringify(plan)
  } catch {
    push(errors, 'plan', '无法序列化为 JSON')
  }
  if (serialized.length > MAX_PLAN_JSON_CHARS) {
    push(errors, 'plan', `计划 JSON 超过 ${MAX_PLAN_JSON_CHARS} 字符，请精简`)
  }
}

/**
 * Validate an untrusted planner object. Never throws for malformed input.
 *
 * @param {unknown} raw
 * @returns {{ok: true, plan: object} | {ok: false, errors: string[]}}
 */
export function validatePlan(raw: any) {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['计划必须是 JSON 对象'] }
  }
  const errors: string[] = []
  if (raw.version !== PLAN_VERSION) errors.push(`version: 必须为 ${PLAN_VERSION}`)
  const plan = {
    version: PLAN_VERSION,
    title: readString(raw.title, 'title', 1, 200, errors),
    taskUnderstanding: readTaskUnderstanding(raw.taskUnderstanding, errors),
    contradictions: readContradictions(raw.contradictions, errors),
    stages: readStages(raw.stages, errors),
    risks: readRisks(raw.risks, errors),
    verification: readVerification(raw.verification, errors),
    practiceLoop: readPracticeLoop(raw.practiceLoop, errors),
  }
  checkPlanGraph(plan, errors)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, plan }
}

export function attachPlanMeta(plan: any, meta: any) {
  return {
    ...plan,
    planId: meta.planId,
    sessionId: meta.sessionId,
    createdTurn: meta.createdTurn,
    createdAt: meta.createdAt,
    sourceMessageIds: [...meta.sourceMessageIds],
  }
}

export function flattenSubtasks(plan: any): Array<{ stage: any; subtask: any }> {
  const out: Array<{ stage: any; subtask: any }> = []
  for (const stage of plan.stages) {
    for (const subtask of stage.subtasks) {
      out.push({ stage, subtask })
    }
  }
  return out
}

export function extractJson(text: any) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PlanError('规划器没有返回内容', 'EMPTY_OUTPUT')
  }
  let value = text.trim()
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) value = fenced[1].trim()
  const first = value.indexOf('{')
  const last = value.lastIndexOf('}')
  if (first < 0 || last <= first) {
    throw new PlanError('规划器返回内容中没有 JSON 对象', 'NO_JSON')
  }
  const candidate = value.slice(first, last + 1)
  try {
    return JSON.parse(candidate)
  } catch (error) {
    throw new PlanError(`规划器返回的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`, 'INVALID_JSON')
  }
}

export function departmentLabel(id: any, language: any = 'zh') {
  const entry = DEPARTMENTS[id as keyof typeof DEPARTMENTS]
  if (!entry) return id
  return language === 'en' ? entry.en : entry.zh
}

export function buildPlannerPrompt(taskText: any, cwd: any, conversationContext: any = '', budget: any = {}) {
  const departments = DEPARTMENT_IDS
    .map((id: any) => { const d = DEPARTMENTS[id as keyof typeof DEPARTMENTS]; return `- ${id}（${d.zh} / ${d.en}）` })
    .join('\n')
  const totalMinutes = Math.max(1, Math.round(Number(budget?.totalMinutes) || 20))
  const childMinutes = Math.max(1, Math.round(Number(budget?.childMinutes) || 15))
  const concurrency = Math.max(1, Number(budget?.concurrency) || MAX_CONCURRENT)
  const resumes = Number.isFinite(Number(budget?.maxResumes)) ? Number(budget.maxResumes) : MAX_PLAN_RESUMES
  const task = truncate(taskText, 16000)
  const directory = typeof cwd === 'string' && cwd ? cwd : '（未知）'
  const context = truncate(conversationContext, 7000)
  return [
    '你是一个任务分解规划器。请用马克思主义哲学的科学方法分析下面的任务，并只输出一个 JSON 对象。',
    '',
    '必须遵守：',
    '1. 实事求是：knownFacts 只能来自用户输入或可验证事实；不得编造文件、接口、数据或结论。',
    '2. 抓主要矛盾：找出决定任务成败的核心矛盾，写清证据和“为什么它是主要矛盾”。',
    '3. 具体问题具体分析：根据任务类型选择部门和方法，不要机械套模板。',
    '4. 实践—认识—再实践：每个阶段设置检查点，用结果修正后续行动。',
    '5. 质量互变：把大目标拆成可验收的量变阶段，设置阶段门槛。',
    '6. 矛盾转化：说明什么条件下次要矛盾会上升为主要矛盾，以及如何应对。',
    '',
    '硬性约束：',
    `- 阶段 1-${MAX_STAGES} 个；子任务总数 1-${MAX_SUBTASKS} 个；每个阶段至少 1 个子任务。`,
    '- 按任务实际复杂度决定规模：简单任务 1-3 个子任务，复杂任务才展开；不得为了显得细致而堆叠子任务。',
    '- 子任务 ID 使用 T1、T2…；阶段 ID 使用 S1、S2…；所有 ID 唯一。',
    '- dependsOn 只能引用更早阶段或更早位置的子任务；不得形成环。',
    '- dependsOn 只在真正需要前序产出时填写；能独立并行的子任务必须留空，不要为了形式制造依赖链。',
    '- department 必须从下面的部门中选择一个。',
    '- method、outputs、acceptance 必须是非空数组；inputs 可以为空，未知写“待确认”。',
    '- unknowns 和 assumptions 必须如实列出；没有就写空数组，不能把假设写成事实。',
    '- 子任务必须可独立执行、可验收；不要为了凑数拆无意义任务。',
    '- 子任务由子 Agent 独立执行：它们没有派发权限、不能重启服务、不能安装或升级依赖。禁止把「调用 dsh_workplan_dispatch」「重启/停止 dsh web」「安装或升级插件」这类只有主 Agent 才能执行的动作写进子任务；确实需要时，写成“给出结论或建议，由主 Agent 执行”。',
    '- 单个子任务应能在 10 分钟内完成；动手重的任务要拆成多个小步，避免整条计划被一个慢子任务拖住。',
    '- 不要输出 Markdown 代码围栏、解释或前后缀；只输出一个 JSON 对象。',
    '',
    '本轮时间预算（硬事实，请据此规划规模）：',
    `- 一轮总预算约 ${totalMinutes} 分钟；单个子任务上限 ${childMinutes} 分钟；同时最多 ${concurrency} 个子任务并行。`,
    `- 受阻后自动续跑额度 ${resumes} 次；总工作量超过一轮预算时，计划会被暂停并在下一轮继续。`,
    '- 每个子任务必须写 estimateMinutes（整数 1-15）：你预估它需要多少分钟。宁可估高，不要估低。',
    '- 规模大就如实拆成多轮，不要为了塞进一轮而把多个交付物压进一个子任务。',
    '',
    '可用部门：',
    departments,
    '',
    `工作目录：${directory}`,
    '',
    '最近对话（只用于理解“它 / 这个 / B / 上一项”等指代，不是新的任务；不要把它当成额外需求）：',
    context || '（无可用对话背景）',
    '',
    '任务：',
    task,
    '',
    '输出 JSON 结构（字段必须齐全，值要具体）：',
    '{',
    '  "version": 1,',
    '  "title": "短标题",',
    '  "taskUnderstanding": {',
    '    "originalRequest": "用户原任务复述",',
    '    "deliverable": "最终交付物",',
    '    "successCriteria": ["可验收标准"],',
    '    "constraints": ["约束"],',
    '    "knownFacts": ["仅来自用户输入或可验证事实"],',
    '    "unknowns": ["未验证项：如何验证"],',
    '    "assumptions": ["明确标注的假设"]',
    '  },',
    '  "contradictions": {',
    '    "primary": {',
    '      "statement": "主要矛盾",',
    '      "evidence": ["证据"],',
    '      "whyPrimary": "为什么它决定成败"',
    '    },',
    '    "secondary": ["次要矛盾"],',
    '    "transformationConditions": ["矛盾转化条件"]',
    '  },',
    '  "stages": [',
    '    {',
    '      "id": "S1",',
    '      "name": "阶段名",',
    '      "goal": "阶段目标",',
    '      "rationale": "为什么需要该阶段",',
    '      "checkpoint": "阶段检查点",',
    '      "subtasks": [',
    '        {',
    '          "id": "T1",',
    '          "title": "子任务",',
    '          "department": "engineering",',
    '          "role": "部门内角色",',
    '          "objective": "目标",',
    '          "method": ["具体方法/步骤"],',
    '          "inputs": ["输入；未知写待确认"],',
    '          "outputs": ["输出/交付物"],',
    '          "dependsOn": [],',
    '          "acceptance": ["可测试的验收标准"],',
    '          "risk": "主要风险",',
    '          "estimateMinutes": 5',
    '        }',
    '      ]',
    '    }',
    '  ],',
    '  "risks": [',
    '    {',
    '      "risk": "风险",',
    '      "likelihood": "low",',
    '      "impact": "影响",',
    '      "mitigation": "缓解",',
    '      "trigger": "触发信号"',
    '    }',
    '  ],',
    '  "verification": [',
    '    { "item": "验证项", "method": "方法", "evidence": "证据形式" }',
    '  ],',
    '  "practiceLoop": {',
    '    "plan": "计划",',
    '    "do": "执行",',
    '    "check": "检查",',
    '    "act": "修正"',
    '  }',
    '}',
  ].join('\n')
}

export function makeUserMessage(text: any, source: any) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

export function buildPlanSummary(plan: any) {
  const total = flattenSubtasks(plan).length
  const primary = plan.contradictions.primary.statement
  return truncate(
    `【任务分解】${plan.title}｜${plan.stages.length} 个阶段 / ${total} 个子任务｜主要矛盾：${primary}`,
    300,
  )
}

/**
 * Conservative lower bound for how long this plan needs, in minutes.
 *
 * The estimate is deliberately a lower bound: `ceil(total / concurrency)` and
 * the largest single estimate, whichever is larger. It only drives an advisory
 * line in the plan message; it never blocks dispatch, because a legal plan that
 * cannot start is a worse failure than one that is merely too big for one round.
 */
export function estimatePlanMinutes(plan: any, fallbackMinutes = 15, concurrency = MAX_CONCURRENT) {
  const subtasks = flattenSubtasks(plan).map((entry: any) => entry.subtask)
  const total = subtasks.length
  if (total === 0) return 0
  const estimates = subtasks.map((subtask: any) => {
    const value = Number(subtask?.estimateMinutes)
    return Number.isFinite(value) && value > 0 ? value : fallbackMinutes
  })
  const maxEstimate = Math.max(...estimates)
  const waves = Math.ceil(total / Math.max(1, concurrency))
  const totalEstimate = estimates.reduce((sum: number, value: number) => sum + value, 0)
  return Math.max(waves * maxEstimate, Math.ceil(totalEstimate / Math.max(1, concurrency)))
}

export function buildBudgetWarning(plan: any, totalBudgetMinutes = 20, maxResumes = MAX_PLAN_RESUMES) {
  const minutes = estimatePlanMinutes(plan)
  const budget = Math.max(1, Math.round(Number(totalBudgetMinutes) || 20))
  if (minutes <= budget) return ''
  const rounds = Math.max(1, Math.ceil(minutes / budget))
  const missing = flattenSubtasks(plan).some((entry: any) => !Number.isFinite(Number(entry.subtask?.estimateMinutes)))
  return [
    `⚠ 预算提示：本计划 ${flattenSubtasks(plan).length} 项，按其估计约需 ${minutes} 分钟 > 本轮 ${budget} 分钟，`
      + `预计需要约 ${rounds} 轮（续跑额度 ${maxResumes} 次）。`,
    '建议：拆成多轮，或减少同时进行的子任务。',
    ...(missing ? ['（部分子任务缺少 estimateMinutes，已按 15 分钟上限估算。）'] : []),
  ].join('\n')
}

export function buildPlanMessage(plan: any, options: any = {}) {
  const summary = buildPlanSummary(plan)
  const payload = {
    kind: 'workplan',
    version: PLAN_VERSION,
    planId: plan.planId,
    sessionId: plan.sessionId,
    createdTurn: plan.createdTurn,
    createdAt: plan.createdAt,
    plan,
  }
  const warning = buildBudgetWarning(
    plan,
    options.totalBudgetMinutes ?? 20,
    options.maxResumes ?? MAX_PLAN_RESUMES,
  )
  const text = [
    summary,
    ...(warning ? ['', warning] : []),
    '',
    PLAN_MARKER_BEGIN,
    JSON.stringify(payload),
    PLAN_MARKER_END,
  ].join('\n')
  return makeUserMessage(text, { kind: 'workplan', form: 'notice', summary })
}

export function buildDegradedMessage(options: any) {
  const error = truncate(options.error ?? '未知错误', 600)
  const summary = truncate(`【自动分解降级】${error}`, 300)
  const payload = {
    kind: 'workplan',
    version: PLAN_VERSION,
    planId: options.planId,
    sessionId: options.sessionId,
    createdTurn: options.createdTurn,
    createdAt: options.createdAt,
    degraded: true,
    error,
    title: '自动分解降级',
    taskUnderstanding: {
      originalRequest: truncate(options.taskText ?? '', 2000),
      deliverable: '未能自动生成计划',
      successCriteria: [],
      constraints: [],
      knownFacts: [],
      unknowns: ['任务分解失败，需要用户确认是否重试'],
      assumptions: [],
    },
  }
  const text = [
    summary,
    '',
    '自动任务分解失败，部门 Agent 未启动。',
    '请先向用户说明失败原因，并询问是否重试；在用户确认前不要开始执行任务。',
    '',
    PLAN_MARKER_BEGIN,
    JSON.stringify(payload),
    PLAN_MARKER_END,
  ].join('\n')
  return makeUserMessage(text, { kind: 'workplan', form: 'notice', summary })
}

export function buildResultSummary(result: any) {
  const stats = result.stats ?? { done: 0, total: 0, blocked: 0 }
  return truncate(
    `【部门执行结果】完成 ${stats.done}/${stats.total}，受阻 ${stats.blocked}，请主 Agent 核对并整合`,
    300,
  )
}

export function buildResultMessage(result: any) {
  const summary = buildResultSummary(result)
  const payload = {
    kind: 'workplan-result',
    version: PLAN_VERSION,
    planId: result.planId,
    sessionId: result.sessionId,
    dispatchedAt: result.dispatchedAt,
    statuses: result.statuses,
    errors: result.errors ?? [],
    stats: result.stats,
    /*
     * The round's final phase has to travel with the payload. Without it a
     * budget pause could not be replayed after a page refresh: `@rebuild`
     * guessed `executing` from the statuses, the card said "正在做" while
     * nothing was running, and the pause looked like a stall again.
     */
    phase: typeof result.phase === 'string' ? result.phase : undefined,
    // Carried so a page refresh can still tell "resume budget exhausted" from
    // "never resumed", instead of promising a retry that will be refused.
    resumeCount: Number(result.resumeCount ?? 0),
    resumeAvailable: result.resumeAvailable === true,
  }
  const blocked = Number(result.stats?.blocked ?? 0)
  const paused = Number(result.stats?.pending ?? 0) > 0 && result.phase === 'paused'
  /*
   * [1.7.0] Evidence review block.
   *
   * A done row is no longer self-certifying: the main Agent is told exactly how
   * many claims are unverified, which self-checks failed, which declared files
   * are missing, and what a sibling department asked for. Keeping this out of
   * the payload (it is derived) keeps the durable message small.
   */
  const statuses = Array.isArray(result.statuses) ? result.statuses : []
  const unverified = statuses.filter((item: any) => item?.verification === 'unverified')
  const failed = statuses.filter((item: any) => item?.verification === 'failed')
  const legacy = statuses.filter((item: any) => item?.status === 'done' && item?.verification === 'legacy')
  const missingArtifacts = statuses.flatMap((item: any) =>
    (Array.isArray(item?.missingArtifacts) ? item.missingArtifacts : [])
      .map((ref: any) => `${item.subtaskId}：${ref}`))
  const needs = statuses.flatMap((item: any) =>
    (Array.isArray(item?.needs) ? item.needs : []).map((need: any) => `${item.subtaskId}：${need}`))
  const review: string[] = []
  if (unverified.length > 0) {
    review.push(`- 未验证 ${unverified.length} 条：${unverified.map((item: any) => item.subtaskId).join('、')}（完成但证据不足，需主 Agent 核对）`)
  }
  if (failed.length > 0) {
    review.push(`- 自检失败 ${failed.length} 条：${failed.map((item: any) => item.subtaskId).join('、')}（已按受阻处理，禁止当完成）`)
  }
  if (legacy.length > 0) {
    review.push(`- 未提供结构化证据 ${legacy.length} 条：${legacy.map((item: any) => item.subtaskId).join('、')}（旧格式回传，按“未验证”对待）`)
  }
  if (missingArtifacts.length > 0) {
    review.push(`- 声明产物缺失：${missingArtifacts.slice(0, 10).join('；')}`)
  }
  const lines = [
    summary,
    '',
    '各部门子任务结果如下，请主 Agent：',
    '1. 核对每个完成项的证据与验收标准；',
    '2. 处理受阻项，必要时向用户确认；',
    '3. 给出最终答复，不要声称未验证的完成。',
    ...(review.length > 0 ? ['', '验收核对：', ...review] : []),
    ...(needs.length > 0
      ? ['', '跨部门待转达（子 Agent 提出的需求，请逐条处理）：', ...needs.slice(0, 10).map((line: string) => `- ${line}`)]
      : []),
    // A blocked plan used to look identical to a finished one. State the exact
    // recovery move so the model retries the failed work instead of rebuilding
    // the whole plan or stopping to ask the user for a repeated request.
    ...(blocked > 0
      ? [result.resumeAvailable === false
          ? `4. 本计划已用尽自动续跑额度（${Number(result.resumeCount ?? 0)}/${MAX_PLAN_RESUMES}），受阻项不会再自动重跑：请主 Agent 直接接手完成，不要重复派发。`
          : `4. 受阻项可再次调用 dsh_workplan_dispatch 从受阻处续跑（已完成的不会重跑，本计划剩余续跑额度 ${MAX_PLAN_RESUMES - Number(result.resumeCount ?? 0)} 次）。`]
      : paused
        ? [`4. 本轮执行预算用尽，剩余 ${Number(result.stats?.pending ?? 0)} 项未完成（不是失败、未计入续跑额度）：再次调用 dsh_workplan_dispatch 即可从剩下的步骤继续，已完成的不重跑。`]
        : []),
    '',
    RESULT_MARKER_BEGIN,
    JSON.stringify(payload),
    RESULT_MARKER_END,
  ]
  return makeUserMessage(lines.join('\n'), {
    kind: 'workplan-result',
    form: 'notice',
    summary,
  })
}

function extractBetween(text: any, begin: any, end: any) {
  if (typeof text !== 'string') return null
  const start = text.indexOf(begin)
  if (start < 0) return null
  const finish = text.indexOf(end, start + begin.length)
  if (finish < 0) return null
  return text.slice(start + begin.length, finish).trim()
}

export function parseWorkplanMessage(message: any) {
  const body = extractBetween(messageText(message), PLAN_MARKER_BEGIN, PLAN_MARKER_END)
  if (!body) return null
  try {
    const payload = JSON.parse(body)
    if (!isRecord(payload) || payload.kind !== 'workplan') return null
    return payload
  } catch {
    return null
  }
}

export function parseResultMessage(message: any) {
  const body = extractBetween(messageText(message), RESULT_MARKER_BEGIN, RESULT_MARKER_END)
  if (!body) return null
  try {
    const payload = JSON.parse(body)
    if (!isRecord(payload) || payload.kind !== 'workplan-result') return null
    return payload
  } catch {
    return null
  }
}

export function buildCancelMessage(planId: any, reason: any = '用户取消') {
  const summary = `【任务已取消】${truncate(String(reason || '用户取消'), 120)}`
  const payload = {
    kind: 'workplan-cancel',
    version: PLAN_VERSION,
    planId,
    reason: String(reason || '用户取消'),
    cancelledAt: Date.now(),
  }
  const lines = [
    summary,
    '',
    '这次任务分解已取消。取消只停止后续执行，不会把未完成项标成完成；已完成项保留原记录。',
    '',
    CANCEL_MARKER_BEGIN,
    JSON.stringify(payload),
    CANCEL_MARKER_END,
  ]
  return makeUserMessage(lines.join('\n'), {
    kind: 'workplan-cancel',
    form: 'notice',
    summary,
  })
}

export function parseCancelMessage(message: any) {
  const body = extractBetween(messageText(message), CANCEL_MARKER_BEGIN, CANCEL_MARKER_END)
  if (!body) return null
  try {
    const payload = JSON.parse(body)
    if (!isRecord(payload) || payload.kind !== 'workplan-cancel') return null
    return payload
  } catch {
    return null
  }
}

function readEvidenceAcceptance(value: any) {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_EVIDENCE_ACCEPTANCE).map((item: any) => {
    const source = isRecord(item) ? item : {}
    const result = ACCEPTANCE_RESULTS.includes(source.result) ? source.result : 'unverified'
    return {
      criterion: truncate(String(source.criterion ?? ''), 500),
      result,
      evidence: truncate(String(source.evidence ?? ''), 300),
    }
  }).filter((item: any) => item.criterion !== '')
}

function readEvidenceArtifacts(value: any) {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_EVIDENCE_ARTIFACTS).map((item: any) => {
    const source = isRecord(item) ? item : {}
    const kind = ['file', 'url', 'note'].includes(source.kind) ? source.kind : 'note'
    const artifact: any = { kind, ref: truncate(String(source.ref ?? ''), 500) }
    if (typeof source.exists === 'boolean') artifact.exists = source.exists
    return artifact
  }).filter((item: any) => item.ref !== '')
}

function readEvidenceNeeds(value: any) {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_EVIDENCE_NEEDS)
    .map((item: any) => truncate(typeof item === 'string' ? item : String(item ?? ''), 300))
    .filter(Boolean)
}

/**
 * Parse the child's structured evidence block.
 *
 * Only the last block is read: a child may quote the template from its prompt
 * before filling in the real one, and the filled-in copy is the last one.
 * A malformed block is reported as such instead of being silently ignored —
 * "cannot tell" must never default to "done".
 */
export function parseEvidenceBlock(output: any) {
  const text = typeof output === 'string' ? output : ''
  const begin = text.lastIndexOf(EVIDENCE_MARKER_BEGIN)
  if (begin < 0) return { found: false, malformed: false, truncated: false, payload: null, raw: '' }
  const end = text.indexOf(EVIDENCE_MARKER_END, begin + EVIDENCE_MARKER_BEGIN.length)
  if (end < 0) return { found: true, malformed: true, truncated: false, payload: null, raw: '' }
  const raw = text.slice(begin + EVIDENCE_MARKER_BEGIN.length, end).trim()
  const truncated = raw.length > MAX_EVIDENCE_BLOCK_CHARS
  try {
    const payload = JSON.parse(raw)
    if (!isRecord(payload) || !EVIDENCE_STATUSES.includes(payload.status)) {
      return { found: true, malformed: true, truncated, payload: null, raw }
    }
    return { found: true, malformed: false, truncated, payload, raw }
  } catch {
    return { found: true, malformed: true, truncated, payload: null, raw }
  }
}

const BLOCKED_LINE = /^\s*(BLOCKED|受阻|无法完成)\s*[:：]\s*/i

/**
 * Deterministic verdict for one child result.
 *
 * This is the single place that decides done vs blocked, so the eight cases in
 * the acceptance table cannot drift apart between the runtime and the replay.
 * It never invents evidence and never upgrades a failed self-check to done.
 */
export function adjudicateResult({ output, strict = true }: any) {
  const text = typeof output === 'string' ? output : ''
  const parsed = parseEvidenceBlock(text)
  if (!strict) {
    if (BLOCKED_LINE.test(text)) {
      return {
        status: 'blocked',
        verification: 'legacy',
        acceptance: [],
        artifacts: [],
        needs: [],
        error: text.replace(BLOCKED_LINE, '').trim() || '子 Agent 报告受阻',
      }
    }
    return { status: 'done', verification: 'legacy', acceptance: [], artifacts: [], needs: [], error: null }
  }
  if (parsed.malformed) {
    return {
      status: 'blocked',
      verification: 'unparsable',
      acceptance: [],
      artifacts: [],
      needs: [],
      error: '结果块无法解析，请主 Agent 核对',
    }
  }
  if (!parsed.found) {
    if (BLOCKED_LINE.test(text)) {
      return {
        status: 'blocked',
        verification: 'legacy',
        acceptance: [],
        artifacts: [],
        needs: [],
        error: text.replace(BLOCKED_LINE, '').trim() || '子 Agent 报告受阻',
      }
    }
    return { status: 'done', verification: 'legacy', acceptance: [], artifacts: [], needs: [], error: null }
  }
  const payload: any = parsed.payload
  const acceptance = readEvidenceAcceptance(payload.acceptance)
  const artifacts = readEvidenceArtifacts(payload.artifacts)
  const needs = readEvidenceNeeds(payload.needs)
  const blockedReason = truncate(String(payload.blockedReason ?? payload.error ?? ''), 2000)
  if (payload.status === 'blocked') {
    return {
      status: 'blocked',
      verification: 'structured',
      acceptance,
      artifacts,
      needs,
      error: blockedReason || '子 Agent 报告受阻',
    }
  }
  if (payload.status === 'partial') {
    const detail = truncate(String(payload.summary ?? payload.blockedReason ?? ''), 2000)
    return {
      status: 'blocked',
      verification: 'structured',
      acceptance,
      artifacts,
      needs,
      error: detail ? `部分完成：${detail}` : '部分完成',
    }
  }
  const failed = acceptance.filter((item: any) => item.result === 'fail')
  if (failed.length > 0) {
    return {
      status: 'blocked',
      verification: 'failed',
      acceptance,
      artifacts,
      needs,
      error: `自检未通过：${failed.map((item: any) => item.criterion).join('；')}`,
    }
  }
  const hasUnverified = acceptance.some((item: any) => item.result === 'unverified')
  return {
    status: 'done',
    verification: hasUnverified ? 'unverified' : 'structured',
    acceptance,
    artifacts,
    needs,
    error: null,
  }
}

export function buildUpdateMessage(update: any) {
  const payload = {
    kind: 'workplan-update',
    version: PLAN_VERSION,
    planId: update.planId,
    subtaskId: update.subtaskId,
    status: update.status,
    ...(update.progress === undefined ? {} : { progress: update.progress }),
    ...(update.note === undefined ? {} : { note: update.note }),
    ...(update.evidence === undefined ? {} : { evidence: update.evidence }),
    ...(update.revision === undefined ? {} : { revision: update.revision }),
    at: update.at ?? Date.now(),
  }
  const summary = truncate(`【状态改判】${update.subtaskId} → ${update.status}`, 300)
  const lines = [
    summary,
    '',
    '这条记录是主 Agent 的人工改判，刷新/重启后按同一顺序回放，不会丢失。',
    '',
    UPDATE_MARKER_BEGIN,
    JSON.stringify(payload),
    UPDATE_MARKER_END,
  ]
  return makeUserMessage(lines.join('\n'), { kind: 'workplan-update', form: 'notice', summary })
}

export function parseUpdateMessage(message: any) {
  const body = extractBetween(messageText(message), UPDATE_MARKER_BEGIN, UPDATE_MARKER_END)
  if (!body) return null
  try {
    const payload = JSON.parse(body)
    if (!isRecord(payload) || payload.kind !== 'workplan-update') return null
    return payload
  } catch {
    return null
  }
}

/**
 * Read-only sibling briefing for one child.
 *
 * Departments cannot message each other directly (see collaboration docs), so
 * "紧密联系" is delivered as visibility: every child sees what its siblings are
 * producing and the status they reached. Only `done` siblings expose a summary,
 * which keeps half-finished work from leaking into another department's prompt.
 */
export function buildTeamBrief(plan: any, statuses: any, subtask: any) {
  if (!plan || !Array.isArray(statuses)) return ''
  const byId = new Map(statuses.map((item: any) => [item.subtaskId, item]))
  const lines: string[] = []
  for (const { subtask: sibling } of flattenSubtasks(plan)) {
    if (sibling.id === subtask?.id) continue
    const status = byId.get(sibling.id)
    const state = typeof status?.status === 'string' ? status.status : 'pending'
    const outputHint = Array.isArray(sibling.outputs) && sibling.outputs.length > 0
      ? `；产出 ${truncate(sibling.outputs.join('、'), 120)}`
      : ''
    const summary = state === 'done' && typeof status?.summary === 'string' && status.summary
      ? `｜摘要：${truncate(status.summary, 200)}`
      : ''
    lines.push(
      `- ${sibling.id} ${departmentLabel(sibling.department)}：目标 ${truncate(sibling.objective, 120)}${outputHint}｜状态：${state}${summary}`,
    )
  }
  if (lines.length === 0) return ''
  return truncate(lines.join('\n'), 2000)
}

/*
 * Replay a durable result message into statuses. Dashboard reconstruction used
 * to read only the plan message, so after a page refresh every finished child
 * looked pending again (0 done / 0 blocked / 12 pending). The result message is
 * the only durable record of child outcomes, so it must be folded back too.
 */
export function applyResultStatuses(statuses: any, result: any) {
  if (!Array.isArray(statuses) || !result || !Array.isArray(result.statuses)) return statuses
  let next = statuses
  for (const entry of result.statuses) {
    if (!isRecord(entry) || typeof entry.subtaskId !== 'string') continue
    if (!STATUSES.includes(entry.status)) continue
    const current = next.find((item: any) => item.subtaskId === entry.subtaskId)
    if (!current) continue
    /*
     * A manually re-adjudicated status (durable `workplan-update`) must not be
     * rolled back by an older result snapshot. Only comparable revisions are
     * ordered; legacy entries without `revision` keep the old "last wins" rule.
     */
    if (Number.isInteger(entry.revision) && Number.isInteger(current.revision)
      && Number(entry.revision) < Number(current.revision)) continue
    try {
      next = applyStatus(next, entry.subtaskId, {
        status: entry.status,
        progress: typeof entry.progress === 'number' ? entry.progress : undefined,
        childId: entry.childId ?? null,
        startedAt: entry.startedAt ?? null,
        finishedAt: entry.finishedAt ?? null,
        summary: typeof entry.summary === 'string' ? entry.summary : undefined,
        error: entry.error ?? null,
        verification: entry.verification,
        acceptance: entry.acceptance,
        artifacts: entry.artifacts,
        missingArtifacts: entry.missingArtifacts,
        needs: entry.needs,
        blockedBy: entry.blockedBy,
        revision: entry.revision,
        updatedBy: entry.updatedBy,
      })
    } catch {
      // Ignore a single corrupt historical status; the rest still replay.
    }
  }
  return next
}

export function createStatuses(plan: any) {
  return flattenSubtasks(plan).map(({ stage, subtask }: any) => ({
    subtaskId: subtask.id,
    stageId: stage.id,
    title: subtask.title,
    department: subtask.department,
    role: subtask.role,
    status: 'pending',
    progress: 0,
    childId: null,
    startedAt: null,
    finishedAt: null,
    summary: '',
    error: null,
  }))
}

export function applyStatus(statuses: any, subtaskId: any, patch: any) {
  const index = statuses.findIndex((item: any) => item.subtaskId === subtaskId)
  if (index < 0) throw new PlanError(`未知子任务：${subtaskId}`, 'UNKNOWN_SUBTASK')
  const current = statuses[index]
  const next = { ...current }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) {
      throw new PlanError(`非法状态：${String(patch.status)}`, 'INVALID_STATUS')
    }
    next.status = patch.status
  }
  if (patch.progress !== undefined) {
    if (!Number.isInteger(patch.progress) || patch.progress < 0 || patch.progress > 100) {
      throw new PlanError('progress 必须是 0-100 的整数', 'INVALID_PROGRESS')
    }
    next.progress = patch.progress
  }
  if (patch.childId !== undefined) next.childId = patch.childId
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt
  if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt
  if (patch.summary !== undefined) next.summary = truncate(String(patch.summary), 3000)
  if (patch.error !== undefined) next.error = patch.error === null ? null : truncate(String(patch.error), 2000)
  if (patch.verification !== undefined) {
    if (!VERIFICATIONS.includes(patch.verification)) {
      throw new PlanError(`非法 verification：${String(patch.verification)}`, 'INVALID_VERIFICATION')
    }
    next.verification = patch.verification
  }
  if (patch.acceptance !== undefined) next.acceptance = readEvidenceAcceptance(patch.acceptance)
  if (patch.artifacts !== undefined) next.artifacts = readEvidenceArtifacts(patch.artifacts)
  if (patch.missingArtifacts !== undefined) {
    let budget = 2000
    next.missingArtifacts = (Array.isArray(patch.missingArtifacts) ? patch.missingArtifacts : [])
      .slice(0, MAX_EVIDENCE_ARTIFACTS)
      .map((ref: any) => truncate(String(ref ?? ''), 300))
      .filter((ref: string) => {
        if (!ref || budget <= 0) return false
        budget -= ref.length
        return true
      })
  }
  if (patch.needs !== undefined) next.needs = readEvidenceNeeds(patch.needs)
  if (patch.blockedBy !== undefined) {
    next.blockedBy = (Array.isArray(patch.blockedBy) ? patch.blockedBy : [])
      .slice(0, 10)
      .filter((item: any) => isRecord(item) && typeof item.id === 'string')
      .map((item: any) => ({ id: item.id, reason: truncate(String(item.reason ?? ''), 300) }))
  }
  /*
   * [1.7.0] Monotonic revision + author.
   *
   * Every write bumps the revision, so a stale page (or an older replay entry)
   * can be told apart from a newer manual re-adjudication. `updatedBy` records
   * who wrote it: the child, the main Agent, or the system.
   */
  const revision = Number.isInteger(patch.revision) ? Number(patch.revision) : Number(current.revision ?? 0) + 1
  next.revision = Math.max(revision, Number(current.revision ?? 0) + 1)
  next.updatedBy = ['child', 'agent', 'system'].includes(patch.updatedBy) ? patch.updatedBy : 'system'
  if (patch.status === 'done') {
    next.progress = 100
    if (next.finishedAt === null) next.finishedAt = Date.now()
  }
  if (patch.status === 'pending') {
    /*
     * A reset means "back to the initial state", so every companion field of
     * the previous attempt goes too.
     *
     * Leaving `summary` (and, unless the caller asked for one, `error`) behind
     * made a re-queued subtask read as `pending` while still carrying the
     * verdict of the attempt that just failed. Explicit values in the same
     * patch still win, so a caller can attach a reason such as “预算用尽”.
     */
    next.progress = 0
    next.startedAt = null
    next.finishedAt = null
    next.childId = null
    if (patch.summary === undefined) next.summary = ''
    if (patch.error === undefined) next.error = null
    // The evidence of the failed attempt must not survive a reset either.
    if (patch.verification === undefined) next.verification = undefined
    if (patch.acceptance === undefined) next.acceptance = undefined
    if (patch.artifacts === undefined) next.artifacts = undefined
    if (patch.missingArtifacts === undefined) next.missingArtifacts = undefined
    if (patch.needs === undefined) next.needs = undefined
    if (patch.blockedBy === undefined) next.blockedBy = undefined
  }
  if (patch.status === 'in_progress') {
    if (next.startedAt === null) next.startedAt = Date.now()
    /*
     * [1.5.2] 「正在做」不允许自称 100%。
     *
     * 工具允许 `{status:'in_progress', progress:100}`，界面于是出现
     * 「正在做 + 进度 100%」，计划层再叠一个环 0% / 加权 100%（T5 C8）。
     * 完成只能由 status='done' 表达，progress 到 99 就是这一步的上限。
     */
    if (Number(next.progress) >= 100) next.progress = 99
  }
  if (patch.status === 'blocked' && next.finishedAt === null) {
    next.finishedAt = Date.now()
  }
  const copy = statuses.slice()
  copy[index] = next
  return copy
}

/*
 * Derived aggregates: the only place counts are ever produced.
 *
 * Why this block exists
 * ---------------------
 * 1.4.2 kept a second copy of the truth: the record stored `stats` next to the
 * status list and refreshed it only between dispatch batches. During a batch
 * the dashboard therefore showed the *previous* counts — the card said
 * “0 正在做” while a stage badge, read from the live statuses, said “正在做”.
 * The same payload also carried `departments` aggregated live, so one JSON body
 * could contradict itself.
 *
 * The fix is structural rather than a smaller patch: `stats` is not stored
 * anywhere any more. `derivePlanSnapshot()` normalises and aggregates in a
 * single pass and hands back the very array it counted, so a payload cannot
 * pair fresh statuses with stale numbers. `computeStats()` stays as a
 * compatibility alias for existing callers and tests.
 */

/** One legal subtask status. Mirrors `STATUSES`, which stays the single runtime list. */
export type SubtaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

/** The canonical shape of one subtask status entry. Extra fields are preserved. */
export interface StatusEntry {
  readonly subtaskId: string
  readonly stageId: string
  readonly title: string
  readonly department: string
  readonly role: string
  readonly status: SubtaskStatus
  readonly progress: number
  readonly childId: string | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly summary: string
  readonly error: string | null
  readonly [extra: string]: unknown
}

/** Everything the dashboard needs to describe a plan's progress. */
export interface Stats {
  total: number
  done: number
  blocked: number
  inProgress: number
  pending: number
  progress: number
}

/** Per-department slice of the same snapshot. */
export interface DepartmentSummary {
  id: string
  total: number
  done: number
  blocked: number
  inProgress: number
}

/** The single derived view a payload is allowed to be built from. */
export interface PlanSnapshot {
  statuses: StatusEntry[]
  stats: Stats
  departments: DepartmentSummary[]
}

export function isSubtaskStatus(value: unknown): value is SubtaskStatus {
  return typeof value === 'string' && STATUSES.includes(value)
}

/** Clamp anything to an integer in `[0, 100]`; non-finite input counts as 0. */
export function clampProgress(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(100, Math.max(0, Math.round(numeric)))
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Structurally normalise one entry without touching the clock.
 *
 * Rules mirror the write path in `applyStatus`:
 * - an unknown status becomes `pending` (otherwise the four counters sum to
 *   less than `total`, which is how a corrupt entry used to hide itself);
 * - `pending` carries no progress and no run bookkeeping;
 * - `done` is progress 100 even if a stale entry stored something else.
 *
 * Timestamps are only type-coerced, never filled in: filling them here would
 * change the payload on every poll just because time passed.
 */
export function normaliseStatusEntry(entry: any): StatusEntry {
  const source: any = entry ?? {}
  const status: SubtaskStatus = isSubtaskStatus(source.status) ? source.status : 'pending'
  const progress = status === 'done' ? 100 : status === 'pending' ? 0 : clampProgress(source.progress)
  return {
    ...source,
    subtaskId: stringOr(source.subtaskId, ''),
    stageId: stringOr(source.stageId, ''),
    title: stringOr(source.title, ''),
    department: stringOr(source.department, ''),
    role: stringOr(source.role, ''),
    status,
    progress,
    childId: status === 'pending' ? null : (source.childId ?? null),
    startedAt: status === 'pending' ? null : numberOrNull(source.startedAt),
    finishedAt: status === 'pending' ? null : numberOrNull(source.finishedAt),
    summary: stringOr(source.summary, ''),
    error: typeof source.error === 'string' ? source.error : null,
  }
}

/**
 * Normalise a whole list.
 *
 * Entries without an identity (`subtaskId`) are dropped rather than counted: an
 * entry that cannot be attributed to a subtask would inflate `total` and make
 * every ratio on the dashboard lie.
 */
export function normaliseStatuses(statuses: any): StatusEntry[] {
  const list = Array.isArray(statuses) ? statuses : []
  const result: StatusEntry[] = []
  for (const entry of list) {
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const normalised = normaliseStatusEntry(entry)
    if (normalised.subtaskId.trim() === '') continue
    result.push(normalised)
  }
  return result
}

/**
 * Count in one pass.
 *
 * Overall progress weights by status instead of trusting the stored number:
 * `done` counts as 100, `in_progress` / `blocked` as their own (clamped)
 * progress, `pending` as 0. A subtask that was rewound to `pending` can
 * therefore never drag the plan's percentage up to where the cards say it is
 * finished — that was the “100% 但 11/12” contradiction users saw.
 */
export function deriveAggregates(statuses: readonly StatusEntry[]): {
  stats: Stats
  departments: DepartmentSummary[]
} {
  const departments = new Map<string, DepartmentSummary>()
  let done = 0
  let blocked = 0
  let inProgress = 0
  let pending = 0
  let progressSum = 0

  for (const item of statuses) {
    if (item.status === 'done') {
      done += 1
      progressSum += 100
    } else if (item.status === 'blocked') {
      blocked += 1
      progressSum += clampProgress(item.progress)
    } else if (item.status === 'in_progress') {
      inProgress += 1
      progressSum += clampProgress(item.progress)
    } else {
      pending += 1
    }

    const department = departments.get(item.department) ?? {
      id: item.department,
      total: 0,
      done: 0,
      blocked: 0,
      inProgress: 0,
    }
    department.total += 1
    if (item.status === 'done') department.done += 1
    else if (item.status === 'blocked') department.blocked += 1
    else if (item.status === 'in_progress') department.inProgress += 1
    departments.set(item.department, department)
  }

  const total = statuses.length
  const allDone = total > 0 && done === total
  /*
   * [1.5.2] 加权进度在「未全部完成」时不得四舍五入成 100。
   *
   * 旧算法直接 `round(progressSum / total)`：11 个 done + 1 个 blocked@95 得到
   * 100，卡片上就出现「总体进度 100%」旁边还有「1 卡住了 / 11/12 做好了」——
   * 与截图同类的自相矛盾（T4 实测 A.5）。这里的封顶只作用于展示口径，不影响
   * 任何计数；全部完成时仍严格为 100，从而与 `done === total` 一一对应。
   */
  const raw = total === 0 ? 0 : Math.round(progressSum / total)
  return {
    stats: {
      total,
      done,
      blocked,
      inProgress,
      pending,
      progress: allDone ? 100 : Math.min(99, raw),
    },
    departments: [...departments.values()],
  }
}

/**
 * The one entry point used when a plan is serialised.
 *
 * Input is read once, normalised once and aggregated once; the three returned
 * values share one array instance, so `stats`, `departments` and `statuses` in
 * a single payload cannot disagree.
 */
export function derivePlanSnapshot(raw: any): PlanSnapshot {
  const statuses = normaliseStatuses(raw)
  const { stats, departments } = deriveAggregates(statuses)
  return { statuses, stats, departments }
}

/**
 * Compatibility alias for callers that only need the counts.
 *
 * @deprecated Prefer `derivePlanSnapshot(statuses).stats` so the caller counts
 * the exact array it is about to ship.
 */
export function computeStats(statuses: any): Stats {
  return derivePlanSnapshot(statuses).stats
}

/**
 * Invariant checker for tests and CI.
 *
 * Returns an empty array when every invariant holds. Each message names the
 * field and the observed value so it can be pasted straight into a report.
 *
 * [1.5.2] `phase` 是新增的可选入参：1.4.3 的 I1–I7 只校验计数内部自洽，
 * 完全不看 `phase` 与 `stats` 的关系，因此「14/14 且 progress=100 却写着
 * 正在收尾」这种**跨字段**矛盾一路畅通到界面。I8/I9 专门封住这一类：
 * 只要调用方把本次真正要下发的 phase 传进来，任何「进度与状态文案打架」
 * 的载荷都会在这里被判为违规，而不是等到用户看截图。
 */
export function aggregateInvariantViolations(snapshot: PlanSnapshot, phase?: any): string[] {
  const violations: string[] = []
  const { statuses, stats, departments } = snapshot

  if (stats.total !== statuses.length) {
    violations.push(`I1 stats.total=${stats.total} 与 statuses.length=${statuses.length} 不一致`)
  }
  const counted = stats.done + stats.blocked + stats.inProgress + stats.pending
  if (counted !== stats.total) {
    violations.push(`I2 四个状态计数之和=${counted} 与 total=${stats.total} 不一致`)
  }
  for (const key of ['total', 'done', 'blocked', 'inProgress', 'pending'] as const) {
    const value = stats[key]
    if (!Number.isInteger(value) || value < 0) violations.push(`I3 stats.${key}=${String(value)} 不是非负整数`)
  }
  if (!Number.isInteger(stats.progress) || stats.progress < 0 || stats.progress > 100) {
    violations.push(`I4 stats.progress=${String(stats.progress)} 不在 0..100`)
  }

  const seen = new Set<string>()
  for (const item of statuses) {
    if (item.subtaskId === '') violations.push('I5 存在 subtaskId 为空的条目')
    if (seen.has(item.subtaskId)) violations.push(`I5 subtaskId 重复：${item.subtaskId}`)
    seen.add(item.subtaskId)
    if (!Number.isInteger(item.progress) || item.progress < 0 || item.progress > 100) {
      violations.push(`I4 ${item.subtaskId}.progress=${String(item.progress)} 不在 0..100`)
    }
    if (item.status === 'pending') {
      if (item.progress !== 0) violations.push(`I6 ${item.subtaskId} 是 pending 但 progress=${item.progress}`)
      if (item.childId !== null) violations.push(`I6 ${item.subtaskId} 是 pending 但仍有 childId`)
      if (item.startedAt !== null) violations.push(`I6 ${item.subtaskId} 是 pending 但仍有 startedAt`)
      if (item.finishedAt !== null) violations.push(`I6 ${item.subtaskId} 是 pending 但仍有 finishedAt`)
    }
    if (item.status === 'done' && item.progress !== 100) {
      violations.push(`I6 ${item.subtaskId} 是 done 但 progress=${item.progress}`)
    }
  }

  const sums = { total: 0, done: 0, blocked: 0, inProgress: 0 }
  for (const department of departments) {
    sums.total += department.total
    sums.done += department.done
    sums.blocked += department.blocked
    sums.inProgress += department.inProgress
    const pendingHere = statuses.filter((item) => item.department === department.id && item.status === 'pending').length
    if (department.total !== department.done + department.blocked + department.inProgress + pendingHere) {
      violations.push(`I7 部门 ${department.id} 的计数之和与 total 不一致`)
    }
  }
  if (sums.total !== stats.total) violations.push(`I7 各部门 total 之和=${sums.total} 与 stats.total=${stats.total} 不一致`)
  if (sums.done !== stats.done) violations.push(`I7 各部门 done 之和=${sums.done} 与 stats.done=${stats.done} 不一致`)
  if (sums.blocked !== stats.blocked) violations.push(`I7 各部门 blocked 之和=${sums.blocked} 与 stats.blocked=${stats.blocked} 不一致`)
  if (sums.inProgress !== stats.inProgress) {
    violations.push(`I7 各部门 inProgress 之和=${sums.inProgress} 与 stats.inProgress=${stats.inProgress} 不一致`)
  }

  /*
   * [1.5.2] I8/I9 —— 完成语义跨字段不变量（用户截图那条「100% + 正在收尾」）。
   *
   * I8：工作项全部 done ⇔ phase 必须是 done。这是一条双向断言：
   *     - 全 done 却是 pending/planning/executing/integrating/paused/blocked/degraded
   *       ⇒ 卡片会同时出现 100% 与进行中文案（本次事故）；
   *     - phase=done 却还有未完成项 ⇒ 反向矛盾（「已完成」下面挂着没做完的活）。
   * I9：加权进度与计数同口径：全 done ⇒ 100；未全 done ⇒ 不得为 100。
   *     旧算法 round(progressSum/total) 让 11 done + 1 blocked@95 算出 100。
   */
  if (stats.total > 0) {
    const allDone = stats.done === stats.total
    if (allDone && phase !== undefined && phase !== null && phase !== 'done') {
      violations.push(`I8 stats.done=${stats.done}/${stats.total} 已全部完成，但 phase=${String(phase)} 仍表示未完成`)
    }
    if (!allDone && phase === 'done') {
      violations.push(`I8 phase=done 但 stats.done=${stats.done}/${stats.total} 尚未全部完成`)
    }
    if (allDone && stats.progress !== 100) {
      violations.push(`I9 全部完成但 stats.progress=${stats.progress}`)
    }
    if (!allDone && stats.progress >= 100) {
      violations.push(`I9 未全部完成（${stats.done}/${stats.total}）却显示 stats.progress=${stats.progress}`)
    }
  }
  /*
   * I10：单个工作项也不能自相矛盾——`in_progress` 意味着「还没做完」，
   * 它的进度必须 < 100（旧载荷里出现过「正在做 + 100%」，T5 C8）。
   */
  for (const item of statuses) {
    if (item?.status === 'in_progress' && Number(item?.progress) >= 100) {
      violations.push(`I10 子任务 ${String(item?.subtaskId)} 状态为 in_progress 但 progress=${item?.progress}`)
    }
  }
  /*
   * [1.8.4] I11：「已结束」与「正在做」不能同屏。
   *
   * 本次事故截图（session-b83e4a75…，2026-10-30 20:06:33）里，同一张卡片既在
   * 「已结束」组、又在第 4 步写着「正在做」。根因是 `turn/end` 早于异步派发
   * 结束（派发又跑了近 4 分钟）。修复后 `ended` 只在「没有任何活派发」时才会
   * 出现，那时不可能还有子任务在跑；一旦这条关系被未来的改动破坏，
   * 这个断言会把具体计数带出来，而不是等用户截图发现。
   */
  if (phase === 'ended' && stats.inProgress > 0) {
    violations.push(`I11 phase=ended 但仍有 ${stats.inProgress} 个子任务 in_progress（已结束与正在做同屏）`)
  }

  return violations
}

/**
 * 计划级阶段，由状态列表唯一决定。
 *
 * [1.5.2] 修复「一边 100%、一边正在收尾」的根因。
 *
 * 旧实现的最后一步是 `return resultSeen ? 'done' : 'integrating'`：工作项全部
 * done 时仍要等「结果消息落盘」才晋升终态。问题在于 `resultSeen` 只是**持久化
 * 回放**才知道的副作用，内存路径（`updateStatus` / `serialisePlan`）拿不到它：
 *
 *  - 主 Agent 用 `dsh_workplan_update` 补完最后几项时，phase 永远停在 integrating；
 *  - 该路径不会再派发，也就永远不会写结果消息，于是 integrating 永久留存；
 *  - 同期 `stats.done/total` 已是 14/14、百分比 100%，卡片就同时显示
 *    「100% · 都做完了」和「正在收尾」，并留在「进行中」组（用户截图）。
 *
 * 结论：完成语义只能有一个事实源——状态列表。工作项全部完成即计划完成，
 * 不需要也不允许等另一个副作用来「确认」。`resultSeen` 参数仅为兼容旧调用点保留，
 * 不再参与判定（旧的 integrating 窗口已由 dispatch 内的 `executing` 覆盖）。
 */
export function planPhase(statuses: any, _resultSeen = false) {
  if (statuses.length === 0) return 'pending'
  if (statuses.every((item: any) => item.status === 'done')) return 'done'
  if (statuses.some((item: any) => item.status === 'blocked')) return 'blocked'
  if (statuses.some((item: any) => item.status === 'in_progress' || item.status === 'done')) return 'executing'
  return 'pending'
}

/**
 * 把「缓存的 phase」与「由状态列表派生的 phase」对账成唯一结果。
 *
 * phase 是缓存（dispatch/预算/取消会写它），statuses 是事实源。只要两者可能
 * 分叉，就必须在出口处对账，否则同一个会话会因读取路径不同而翻转（实时
 * integrating / 刷新后 done，T2 场景 B）。
 *
 * 规则只有四条，全部可由 `aggregateInvariantViolations` 断言：
 *  1. 工作项全部 done ⇒ 一定是 done（缓存不得把它拖回任何进行中状态）；
 *  2. 缓存是 done/integrating 但工作项没全 done ⇒ 缓存过期，回退到派生值；
 *  3. pending/planning/executing 是「状态列表能直接回答」的轮次状态：一旦
 *     有工作项开始（派生值不再是 pending），缓存里的旧 pending/planning 必须
 *     让位；而派生值仍是 pending 时保留缓存（dispatch 刚开始、状态尚未落盘）。
 *  4. 其余情况保留缓存的轮次状态（paused/cancelled/blocked/degraded）——
 *     它们携带状态列表里没有的信息（预算暂停、用户取消）。
 */
export function reconcilePhase(phase: any, statuses: any) {
  const derived = planPhase(statuses)
  if (derived === 'done') return 'done'
  if (phase === 'done' || phase === 'integrating') return derived
  if (phase === 'pending' || phase === 'planning' || phase === 'executing') {
    return derived === 'pending' ? phase : derived
  }
  return phase ?? derived
}

export function nextReadyInStage(plan: any, statuses: any[], stageId: string) {
  const byId = new Map(statuses.map((item: any) => [item.subtaskId, item]))
  const stage = plan.stages.find((item: any) => item.id === stageId)
  if (!stage) return []
  return stage.subtasks.filter((subtask: any) => {
    const status = byId.get(subtask.id)
    if (!status || status.status !== 'pending') return false
    return subtask.dependsOn.every((dependency: any) => byId.get(dependency)?.status === 'done')
  })
}

/*
 * Readiness across the whole plan, not per stage. A stage is only a grouping
 * label; making every later stage wait for every earlier stage lets one slow
 * child turn an entire plan red. Only real dependsOn edges gate a subtask.
 *
 * [1.7.0] A `done` dependency only counts when its declared file artifacts
 * actually exist. `dependencyOk` is injectable so the rule stays pure and can
 * be turned off for compatibility (`artifactGate:false`).
 */
export function readySubtasks(plan: any, statuses: any[], options: any = {}) {
  const byId = new Map(statuses.map((item: any) => [item.subtaskId, item]))
  const dependencyOk = typeof options.dependencyOk === 'function'
    ? options.dependencyOk
    : (dependency: any) => Boolean(dependency) && dependency.status === 'done'
  return flattenSubtasks(plan)
    .map((entry: any) => entry.subtask)
    .filter((subtask: any) => {
      const status = byId.get(subtask.id)
      if (!status || status.status !== 'pending') return false
      return subtask.dependsOn.every((dependency: any) => dependencyOk(byId.get(dependency), dependency))
    })
}

export function markDependentsBlocked(plan: any, statuses: any, blockedId: any, cause: any = null) {
  let next = statuses.slice()
  let changed = true
  const blocked = new Set([blockedId])
  const upstreamLabel = (id: any) => {
    const title = findSubtask(plan, id)?.subtask?.title
    return title ? `${id}「${title}」` : String(id)
  }
  while (changed) {
    changed = false
    for (const { subtask } of flattenSubtasks(plan)) {
      if (blocked.has(subtask.id)) continue
      const status = next.find((item: any) => item.subtaskId === subtask.id)
      if (!status || status.status !== 'pending') continue
      if (subtask.dependsOn.some((dependency: any) => blocked.has(dependency))) {
        const direct = subtask.dependsOn.filter((id: any) => blocked.has(id))
        /*
         * Name the upstream and the concrete cause. "上游子任务受阻" alone sent
         * the main Agent back to the plan to guess which child failed and why;
         * the reason and the missing artifacts belong in the message.
         */
        const parts = [`上游子任务受阻：${direct.map(upstreamLabel).join('、')}`]
        if (cause?.reason) parts.push(`原因：${truncate(String(cause.reason), 300)}`)
        if (Array.isArray(cause?.missingArtifacts) && cause.missingArtifacts.length > 0) {
          parts.push(`缺失产物：${cause.missingArtifacts.slice(0, 10).join('、')}`)
        }
        next = applyStatus(next, subtask.id, {
          status: 'blocked',
          error: parts.join('；'),
          blockedBy: [{ id: blockedId, reason: cause?.reason ? truncate(String(cause.reason), 300) : `上游 ${upstreamLabel(blockedId)} 受阻` }],
        })
        blocked.add(subtask.id)
        changed = true
      }
    }
  }
  return next
}

/**
 * How many times one plan may be re-dispatched after it went blocked.
 *
 * Re-dispatch used to be a silent no-op: every subtask was already `blocked`,
 * `readySubtasks()` returned nothing, and the dispatcher returned
 * `{ ok: true, phase: 'blocked' }` without running a single child. A model that
 * followed the prompt ("核对结果后再继续") could not tell "nothing ran" apart
 * from "everything already ran", so the plan stayed dead and the only recovery
 * was asking the user to repeat the request — which built a fresh plan and hit
 * the same wall.
 */
export const MAX_PLAN_RESUMES = 4

/**
 * Reset every failed or half-run subtask to `pending` so it can run again.
 *
 * `done` results are preserved: the retry is a resume, not a restart. That
 * matters because a child may take minutes of real work, and re-running it
 * would also re-run its side effects.
 *
 * @param statuses - the current status list.
 * @returns a new status list with blocked/in_progress entries cleared.
 */
export function resetBlockedStatuses(statuses: any) {
  if (!Array.isArray(statuses)) return []
  let next = statuses.slice()
  for (const item of statuses) {
    if (item?.status !== 'blocked' && item?.status !== 'in_progress') continue
    next = applyStatus(next, item.subtaskId, {
      status: 'pending',
      progress: 0,
      error: null,
      summary: '',
      startedAt: null,
      finishedAt: null,
      childId: null,
    })
  }
  return next
}

/**
 * Decide whether re-dispatching this plan should resume the failed subtasks.
 *
 * Cancellation is never resumed automatically: a user cancel and a turn abort
 * both end in `cancelled`, and silently restarting work the user stopped is
 * worse than asking again. Both `blocked` and `paused` plans resume.
 *
 * @param record - the live plan record.
 * @param maxResumes - resume budget, defaults to {@link MAX_PLAN_RESUMES}.
 * @returns the decision plus a model-readable reason when refused.
 */
export function canResumePlan(record: any, maxResumes: number = MAX_PLAN_RESUMES) {
  const statuses = Array.isArray(record?.statuses) ? record.statuses : []
  /*
   * A `paused` plan is resumable too.
   *
   * Running out of the round budget leaves the unfinished subtasks `pending` on
   * purpose, so before this they were invisible here: the payload said
   * `resumeAvailable: false` and the card told the user the automatic resume
   * budget was spent, even though re-dispatching simply continues the work.
   * Pending work after a pause counts as resumable, and a pause is not charged
   * against the resume budget (it is a time slice, not a repair).
   */
  const paused = record?.phase === 'paused'
  const failed = statuses.filter((item: any) => {
    if (item?.status === 'blocked' || item?.status === 'in_progress') return true
    return paused && item?.status === 'pending'
  })
  const used = Number(record?.resumeCount ?? 0)
  if (failed.length === 0) {
    return { resume: false, reason: '没有需要续跑的子任务', failed: 0, used, remaining: maxResumes - used }
  }
  if (record?.phase !== 'blocked' && !paused) {
    return {
      resume: false,
      reason: `计划当前阶段是 ${String(record?.phase ?? 'unknown')}，不能续跑`,
      failed: failed.length,
      used,
      remaining: maxResumes - used,
    }
  }
  if (!paused && used >= maxResumes) {
    return {
      resume: false,
      reason: `续跑次数已用尽（${used}/${maxResumes}），受阻子任务需要主 Agent 直接接手完成`,
      failed: failed.length,
      used,
      remaining: 0,
    }
  }
  return { resume: true, reason: '', failed: failed.length, used, remaining: maxResumes - used }
}

export function findSubtask(plan: any, subtaskId: any) {
  for (const { stage, subtask } of flattenSubtasks(plan)) {
    if (subtask.id === subtaskId) return { stage, subtask }
  }
  return null
}

export function buildChildPrompt({
  plan,
  subtask,
  stage,
  dependencyResults,
  cwd,
  conversationContext = '',
  statuses = null,
  previousFailure = null,
}: any) {
  /*
   * Every field below is read defensively.
   *
   * A plan that was reconstructed, resumed, or written by an older version can
   * legitimately lack `taskUnderstanding` / `contradictions`. Dereferencing them
   * directly threw inside prompt building, so each child failed instantly and
   * the whole plan was blocked — a stuck plan caused by missing metadata rather
   * than by the work being impossible.
   */
  const results = Array.isArray(dependencyResults) ? dependencyResults : []
  const dependencies = results.length === 0
    ? '无'
    : results
      .map((item: any) => `- ${item.id} ${item.title}：${item.status}${item.summary ? `｜${item.summary}` : ''}`)
      .join('\n')
  /*
   * [1.7.0] No second truncation here.
   *
   * The background was cut to 5000 chars *after* the caller had already built
   * it to 7000, so a fresh conversation could lose its most recent turns. The
   * text now arrives already capped by `recentConversation`.
   */
  const background = typeof conversationContext === 'string' ? conversationContext : ''
  const understanding = plan?.taskUnderstanding ?? {}
  const contradiction = plan?.contradictions?.primary?.statement ?? '（未记录）'
  const stageName = stage?.name ?? '（未命名阶段）'
  const stageGoal = stage?.goal ?? '（未记录目标）'
  const team = statuses ? buildTeamBrief(plan, statuses, subtask) : ''
  const failure = previousFailure && typeof previousFailure === 'object'
    ? [
        '',
        '上一次尝试失败（这不是新的任务，请先判断上次为什么失败）：',
        `- 失败类型：${previousFailure.code ?? 'UNKNOWN'}${previousFailure.attempt ? `（第 ${previousFailure.attempt} 次尝试）` : ''}`,
        `- 失败说明：${truncate(String(previousFailure.message ?? '（无说明）'), 600)}`,
        '请针对上面这个原因调整做法，不要重复相同的失败路径；如果仍然无法完成，第一行输出 `BLOCKED: 原因` 并说明缺少什么。',
      ].join('\n')
    : ''
  return [
    `你是「${departmentLabel(subtask.department)}」部门的执行 Agent，只负责下面这一个子任务。`,
    '',
    `全局任务：${understanding.originalRequest ?? '（未记录）'}`,
    `最终交付物：${understanding.deliverable ?? '（未记录）'}`,
    `主要矛盾：${contradiction}`,
    `当前阶段：${stageName}（${stageGoal}）`,
    `工作目录：${cwd || '（未知）'}`,
    '',
    '最近对话背景（用于理解“它 / 这个 / B / 上一项”等指代；不是新的任务）：',
    background || '（无可用对话背景）',
    '',
    `你的子任务：${subtask.id} ${subtask.title}`,
    `角色：${subtask.role}`,
    `目标：${subtask.objective}`,
    `方法：${(subtask.method ?? []).join('；') || '（未指定）'}`,
    `输入：${Array.isArray(subtask.inputs) && subtask.inputs.length ? subtask.inputs.join('；') : '无明确输入'}`,
    `输出：${(subtask.outputs ?? []).join('；') || '（未指定）'}`,
    `验收标准：${(subtask.acceptance ?? []).join('；') || '（未指定）'}`,
    `风险：${subtask.risk}`,
    '',
    '依赖子任务的已知结果：',
    dependencies,
    ...(team ? ['', '兄弟部门进展（同一计划内的其他子任务；不要直接联系它们，需要协作请写进 needs 由主 Agent 转达）：', team] : []),
    ...(failure ? [failure] : []),
    '',
    '执行要求：',
    '- 只完成本子任务，不擅自扩大范围；不要派生新的 Agent。',
    '- 你没有派发权限，也不能重启或安装任何服务；遇到这类步骤，直接写清“需要主 Agent 执行什么”，不要等待或空转。',
    '- 不得编造事实、文件、命令结果或证据；无法确认时明确写“未验证”。',
    '- 可以读取工作目录、运行必要命令、修改与任务相关的文件。',
    '- 优先使用给定上下文和本地工具；只有任务明确需要最新外部信息时才联网搜索。',
    '- 控制工具调用次数，证据足够就立即汇报；不要反复搜索或等待长时间任务。',
    '- 如果确实无法完成，第一行输出 `BLOCKED: 原因`，然后简要说明。',
    '- 完成后用简洁中文汇报：做了什么、证据/文件、验收结果、遗留问题。',
    '',
    '结果回传（必填）：在汇报的最后附上一个结构化结果块，主 Agent 会按它逐项核对，不再只依赖自述。',
    EVIDENCE_MARKER_BEGIN,
    '{"status":"done","blockedReason":"","acceptance":[{"criterion":"把上面的验收标准原文抄在这里","result":"pass","evidence":"用命令输出、文件路径或引用证明"}],"artifacts":[{"kind":"file","ref":"相对工作目录的路径"}],"needs":[]}',
    EVIDENCE_MARKER_END,
    '- status 只能是 done / blocked / partial；partial 会被当作受阻处理。',
    '- acceptance 必须逐条覆盖上面的验收标准；result 只能是 pass / fail / unverified。无法确认就写 unverified，不要写 pass。',
    '- artifacts 写你实际产出或修改的文件（kind=file，ref 用相对路径）、链接（kind=url）或说明（kind=note）。',
    '- 需要其他部门配合时写进 needs（每条一句话），主 Agent 会转达；不要直连其他子 Agent。',
    '- 整块不超过 8000 字符；不要把这段模板本身抄进结果块。',
  ].join('\n')
}
