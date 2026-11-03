/**
 * Structured task understanding, department matching and anchor deviation check
 * (T10 / M1 + M2, 1.12.0).
 *
 * Why this module exists
 * ----------------------
 * Before 1.12.0 the planner was a single model call:
 *
 *     user task -> model -> JSON plan -> twelve-value enum check -> dispatch
 *
 * `validatePlan` only asked "is `department` one of the twelve keys?". It had no
 * access to the user's original words, no notion of what a department can do,
 * and no way to notice that a subtask had drifted away from the request. The T4
 * diagnosis proved the consequence with a counter-example: a picture-book task
 * carrying a penetration-testing subtask still validated `ok:true`.
 *
 * This module adds the three deterministic stages the acceptance criterion asks
 * for, *after* the model produces its plan and *before* anything is dispatched:
 *
 *   1. extract  — pull hard requirements out of the user's own text
 *                 (versions, counts, dates, paths, ids, numeric bounds,
 *                 explicit negations, pronoun references, contradictions);
 *   2. match    — score every subtask against the department capability
 *                 catalog and explain the score with the exact keywords hit;
 *   3. check    — compare the plan (and the model's own restatement) against the
 *                 read-only anchor, and report every dropped hard element.
 *
 * Everything here is pure: no model call, no network, no clock, no filesystem.
 * The same inputs always produce the same audit, which makes the result
 * reproducible and unit-testable. A model-based reviewer would be *another*
 * opinion, not evidence — so it is deliberately not part of this path.
 *
 * Failure policy (why not everything blocks)
 * ------------------------------------------
 * A false rejection is worse than a warning: it turns a valid task into a
 * degraded plan. Only contradictions strong enough to be wrong in any reading
 * are blocking:
 *
 *   - a hard anchor (version / date / count / path / id / numeric bound) that
 *     exists in the user text but appears nowhere in the plan;
 *   - a subtask assigned to a guarded department (security/legal/finance/
 *     operations) whose domain vocabulary appears only in the subtask and never
 *     in the user's request, with no shared content token at all.
 *
 * Pronouns without context and contradictory requirements are reported as
 * warnings, never as silent passes: the plan message tells the main Agent to
 * clarify before dispatch. All thresholds are named constants so a test can pin
 * them instead of relying on prose.
 */

import { createHash } from 'node:crypto'

import {
  DEPARTMENT_CAPABILITIES,
  DEPARTMENT_INTRUSION_GUARDED,
  departmentCapability,
  keywordHit,
  matchDepartmentKeywords,
  scoreDepartments,
  type DepartmentCapability,
} from './departments.js'

export const UNDERSTANDING_AUDIT_VERSION = 1

/** Same cap the planner prompt uses for the task text. */
export const MAX_TASK_ANCHOR_CHARS = 16000
/** Enough to cover a dense six-part request without turning the audit into a dump. */
export const MAX_TASK_ELEMENTS = 40
/** A plan with more subtasks than this cannot exist (`MAX_SUBTASKS`), kept local to avoid a cycle. */
export const MAX_AUDITED_SUBTASKS = 15

/**
 * A mismatch is blocking when the chosen department has zero supporting
 * keywords and another department has at least this many. Three is high enough
 * that a single incidental word cannot trigger it.
 */
export const MISMATCH_BLOCKING_SCORE = 3

/** Hard anchors are the only elements that can fail a plan by themselves. */
export type TaskElementKind =
  | 'version'
  | 'date'
  | 'count'
  | 'path'
  | 'id'
  | 'quantity'
  | 'negation'

export interface TaskElement {
  kind: TaskElementKind
  /** The literal requirement, normalised only for whitespace. */
  value: string
  /** Surrounding clause, for a human reading the audit. */
  evidence: string
  /** Whether dropping this element is a blocking deviation. */
  hard: boolean
}

export interface TaskReference {
  token: string
  /** `context` = resolved by conversation; `inline-noun` = e.g. 「这个插件」. */
  resolvedBy: 'context' | 'inline-noun' | 'none'
  resolved: boolean
  evidence: string
}

export interface TaskConflict {
  kind: 'default-state' | 'scope' | 'polarity' | 'value'
  a: string
  b: string
  reason: string
}

export interface TaskElements {
  textLength: number
  elements: TaskElement[]
  hardCount: number
  references: TaskReference[]
  conflicts: TaskConflict[]
  /** Soft deliverable clauses (`交付/产出/输出/发布…`), reported but not blocking. */
  deliverableClauses: string[]
}

export interface DepartmentAssignment {
  subtaskId: string
  department: string
  departmentLabel: string
  score: number
  matched: string[]
  /** Chosen department's keywords that also occur in the user's own request. */
  anchorMatched: string[]
  bestAlternative: { id: string; zh: string; score: number; matched: string[] } | null
  /** Set when the department is guarded and its vocabulary is absent from the request. */
  intrusion: boolean
  verdict: 'fit' | 'weak' | 'mismatch'
  reason: string
  /** What the model said about its choice, when the planner emitted the field. */
  declaredRationale: string
}

export interface TaskAnchor {
  text: string
  sha256: string
  length: number
  sourceMessageIds: string[]
}

export interface UnderstandingAudit {
  version: number
  /** `null` for legacy plans / replays without the original request. */
  anchor: TaskAnchor | null
  stage1: {
    elements: TaskElement[]
    hardCount: number
    references: TaskReference[]
    conflicts: TaskConflict[]
    deliverableClauses: string[]
  }
  stage2: {
    assignments: DepartmentAssignment[]
    departmentsUsed: string[]
    mismatches: string[]
  }
  stage3: {
    verdict: 'aligned' | 'deviation' | 'needs-clarification' | 'needs-context' | 'degraded'
    rewritten: boolean
    summaryCoverage: number
    droppedFromSummary: string[]
    missingHardAnchors: string[]
    missingDeliverables: string[]
    reasons: string[]
  }
}

export interface PlanAuditContext {
  taskText?: string
  conversationContext?: string
  sourceMessageIds?: string[]
  /** `false` downgrades every blocking error to a warning (rollback switch). */
  strict?: boolean
}

export interface PlanContextValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  audit: UnderstandingAudit
}

const NEGATION_PATTERN = /(?:不要|禁止|不得|严禁|不能|不可|切勿|避免)\s*([^\s，。；、,.;:!?！？\n]{1,28})/g
const QUANTITY_PATTERN = /(?:最多|至少|不超过|不能超过|上限|下限|必须|只能|只允许|仅)\s*([^，。；;!?！？\n]{1,40})/g
const HARD_QUANTITY_PREFIX = /^(?:最多|至少|不超过|不能超过|上限|下限)/

/**
 * Normalise for "does the plan still mention this literal" checks. It strips
 * whitespace and punctuation only — never Chinese characters, digits or latin
 * letters — so a match cannot be manufactured by dropping content.
 */
export function normalizeForMatch(value: unknown): string {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[％]/g, '%')
    .replace(/[，。；、！？"'“”‘’（）()【】\[\]<>《》]/g, '')
    .toLowerCase()
}

function clauseOf(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 36)
  const end = Math.min(text.length, index + length + 36)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

function pushElement(target: TaskElement[], seen: Set<string>, element: TaskElement): void {
  const key = `${element.kind}|${normalizeForMatch(element.value)}`
  if (!element.value || seen.has(key)) return
  seen.add(key)
  target.push(element)
}

function collectMatches(
  text: string,
  pattern: RegExp,
  make: (match: RegExpExecArray) => TaskElement | null,
): TaskElement[] {
  const found: TaskElement[] = []
  const seen = new Set<string>()
  // A local clone keeps the shared literal's lastIndex from leaking between calls.
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const element = make(match)
    if (element) pushElement(found, seen, element)
    if (match.index === regex.lastIndex) regex.lastIndex += 1
  }
  return found
}

function splitClauses(text: string): string[] {
  return text
    .split(/[。；;\n！!？?]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

function cjkBigrams(text: string): Set<string> {
  const clean = String(text ?? '').replace(/[^\u4e00-\u9fff]+/g, ' ')
  const bigrams = new Set<string>()
  for (const run of clean.split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      bigrams.add(run.slice(i, i + 2))
    }
  }
  return bigrams
}

const STOP_BIGRAMS = new Set([
  '的是', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '一个', '已经',
  '可以', '需要', '必须', '应该', '进行', '以及', '或者', '但是', '因为', '所以',
  '如果', '没有', '不是', '就是', '通过', '对于', '时候', '现在', '问题', '要求',
  '这里', '那里', '同时', '并且', '而且', '还有', '全部', '所有', '任何', '其他',
])

function contentBigrams(text: string): Set<string> {
  const result = new Set<string>()
  for (const bigram of cjkBigrams(text)) {
    if (!STOP_BIGRAMS.has(bigram)) result.add(bigram)
  }
  return result
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const value of a) if (b.has(value)) count += 1
  return count
}

const SELF_CONTAINED_REFERENCE = /^(?:这个|那个|该|上述|前述|这些|那些|上一项|前一项|前者|后者)/

/**
 * Extract hard requirements and ambiguity signals from the user's own words.
 *
 * Deliberately literal: no stemming, no synonyms, no model. The cost is that a
 * heavily paraphrased plan may look lossy; the benefit is that every finding can
 * be checked by searching the two strings involved.
 */
export function extractTaskElements(taskText: unknown): TaskElements {
  const text = typeof taskText === 'string' ? taskText.trim() : ''
  const elements: TaskElement[] = []
  const seen = new Set<string>()

  // Order matters: `MAX_TASK_ELEMENTS` keeps the highest-signal kinds first.
  for (const element of collectMatches(text, /\bv?(\d+\.\d+(?:\.\d+)?)\b/g, (match) => ({
    kind: 'version' as const,
    value: match[0].replace(/^v/i, ''),
    evidence: clauseOf(text, match.index, match[0].length),
    hard: true,
  }))) pushElement(elements, seen, element)

  for (const element of collectMatches(text, /\b(?:20\d{2})[-/年.]\d{1,2}(?:[-/月.]\d{1,2}日?)?/g, (match) => ({
    kind: 'date' as const,
    value: match[0],
    evidence: clauseOf(text, match.index, match[0].length),
    hard: true,
  }))) pushElement(elements, seen, element)

  for (const element of collectMatches(text, /\b\d{1,2}月\d{1,2}日/g, (match) => ({
    kind: 'date' as const,
    value: match[0],
    evidence: clauseOf(text, match.index, match[0].length),
    hard: true,
  }))) pushElement(elements, seen, element)

  for (const element of collectMatches(
    text,
    /\b(?:T|D|U|S|Q|P|E|R|C|M|H|W|XB)-?\d{1,3}\b/g,
    (match) => ({
      kind: 'id' as const,
      value: match[0],
      evidence: clauseOf(text, match.index, match[0].length),
      hard: true,
    }),
  )) pushElement(elements, seen, element)

  for (const element of collectMatches(
    text,
    /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|patch|log|csv|py|html|css|svg|tgz)\b/g,
    (match) => ({
      kind: 'path' as const,
      value: match[0],
      evidence: clauseOf(text, match.index, match[0].length),
      hard: true,
    }),
  )) pushElement(elements, seen, element)

  for (const element of collectMatches(
    text,
    /\b\d+(?:\.\d+)?\s*(?:个|页|条|项|次|份|张|台|人日|人|天|小时|分钟|秒|字|%|万|亿|KB|MB|GB)/gi,
    (match) => ({
      kind: 'count' as const,
      value: match[0].replace(/\s+/g, ''),
      evidence: clauseOf(text, match.index, match[0].length),
      hard: true,
    }),
  )) pushElement(elements, seen, element)

  for (const element of collectMatches(text, QUANTITY_PATTERN, (match) => {
    const head = match[0]
    return {
      kind: 'quantity' as const,
      value: head.replace(/\s+/g, ''),
      evidence: clauseOf(text, match.index, match[0].length),
      hard: HARD_QUANTITY_PREFIX.test(head),
    }
  })) pushElement(elements, seen, element)

  /*
   * Negations are recorded for readability but are not blocking by themselves.
   * A negation's object often includes the verb ("不要修改业务代码"), so a
   * legitimate synonym ("不得改动业务代码") would be a false deviation. When the
   * object is a path, id or number it is already covered by the hard kinds
   * above, so nothing checkable is lost.
   */
  for (const element of collectMatches(text, NEGATION_PATTERN, (match) => ({
    kind: 'negation' as const,
    value: `禁止:${match[1]}`,
    evidence: clauseOf(text, match.index, match[0].length),
    hard: false,
  }))) pushElement(elements, seen, element)

  const deliverableClauses = splitClauses(text)
    .filter((clause) => /(?:交付|产出|输出|发布|提供|生成|给出)/.test(clause))
    .slice(0, 10)

  return {
    textLength: text.length,
    elements: elements.slice(0, MAX_TASK_ELEMENTS),
    hardCount: elements.filter((element) => element.hard).length,
    references: extractReferences(text),
    conflicts: extractConflicts(text),
    deliverableClauses,
  }
}

function extractReferences(text: string): TaskReference[] {
  if (!text) return []
  const references: TaskReference[] = []
  const seen = new Set<string>()
  const inlineTokens = ['这个', '那个', '该', '上述', '前述', '这些', '那些', '上一项', '前一项', '前者', '后者']
  for (const token of inlineTokens) {
    let index = text.indexOf(token)
    while (index >= 0) {
      const before = text[index - 1] ?? ''
      if (before === '其') {
        index = text.indexOf(token, index + token.length)
        continue
      }
      if (!seen.has(token)) {
        const after = text.slice(index + token.length, index + token.length + 6)
        /*
         * 「该」 is also a modal ("该怎么做"), which is not a reference at all.
         * Skipping it keeps a real task from being blocked by a false pronoun
         * while 「该模块」 still resolves inline.
         */
        if (token === '该' && /^(?:怎么|如何|怎样|是否|做|不|应)/.test(after)) {
          index = text.indexOf(token, index + token.length)
          continue
        }
        seen.add(token)
        const selfContained = SELF_CONTAINED_REFERENCE.test(token) && /^[\u4e00-\u9fff]{2}/.test(after)
        references.push({
          token,
          resolvedBy: selfContained ? 'inline-noun' : 'none',
          resolved: selfContained,
          evidence: clauseOf(text, index, token.length),
        })
      }
      index = text.indexOf(token, index + token.length)
    }
  }
  // Bare 「它」 is the real ambiguity: it can only be resolved by context.
  for (let index = text.indexOf('它'); index >= 0; index = text.indexOf('它', index + 1)) {
    const before = text[index - 1] ?? ''
    if (before === '其') continue
    if (!seen.has('它')) {
      seen.add('它')
      references.push({
        token: '它',
        resolvedBy: 'none',
        resolved: false,
        evidence: clauseOf(text, index, 1),
      })
    }
  }
  // Option letters are only references when the text also talks about options.
  if (/(?:选|选项|方案|可选|建议)/.test(text)) {
    const option = /(?:^|[^A-Za-z])([A-D])(?![A-Za-z])/.exec(text)
    if (option && !seen.has(option[1])) {
      seen.add(option[1])
      references.push({
        token: option[1],
        resolvedBy: 'none',
        resolved: false,
        evidence: clauseOf(text, option.index, option[0].length),
      })
    }
  }
  return references
}

function extractConflicts(text: string): TaskConflict[] {
  const conflicts: TaskConflict[] = []
  const seen = new Set<string>()
  const add = (conflict: TaskConflict): void => {
    const key = `${conflict.kind}|${normalizeForMatch(conflict.a)}|${normalizeForMatch(conflict.b)}`
    if (seen.has(key)) return
    seen.add(key)
    conflicts.push(conflict)
  }

  const open = /默认(?:展开|打开|显示)/.exec(text)
  const closed = /默认(?:不展开|不打开|收起|折叠|关闭|隐藏)/.exec(text)
  if (open && closed) {
    add({
      kind: 'default-state',
      a: open[0],
      b: closed[0],
      reason: '同一默认状态被同时要求展开与收起，二选一必须由用户决定',
    })
  }

  const only = /只(?:改|修改|动|做)\s*([^\s，。；、,;!?！？]{1,24})/.exec(text)
  const also = /(?:同时|还要|也要|并且|另外)(?:改|修改|动|做)\s*([^\s，。；、,;!?！？]{1,24})/.exec(text)
  if (only && also && normalizeForMatch(only[1]) !== normalizeForMatch(also[1])) {
    add({
      kind: 'scope',
      a: only[0],
      b: also[0],
      reason: `范围冲突：既要求只处理「${only[1]}」，又要求处理「${also[1]}」`,
    })
  }

  const clauses = splitClauses(text)
  for (const forbidClause of clauses) {
    const forbid = /(?:不要|禁止|不得|严禁)\s*(?:修改|改动|改|动|删除|移除)\s*([^\s，。；、,;!?！？]{1,24})/.exec(forbidClause)
    if (!forbid) continue
    for (const requireClause of clauses) {
      if (requireClause === forbidClause) continue
      const require = /(?:必须|需要|务必|要)\s*(?:修改|改动|改|动|删除|移除)\s*([^\s，。；、,;!?！？]{1,24})/.exec(requireClause)
      if (!require) continue
      const a = normalizeForMatch(forbid[1])
      const b = normalizeForMatch(require[1])
      const overlap = a === b || a.includes(b) || b.includes(a)
        || intersectionSize(contentBigrams(forbid[1]), contentBigrams(require[1])) > 0
      if (overlap) {
        add({
          kind: 'polarity',
          a: forbid[0],
          b: require[0],
          reason: `同一对象「${forbid[1]}」既被禁止修改又被要求修改`,
        })
      }
    }
  }

  for (const clause of clauses) {
    const change = /(?:改成|改为|设为|调整为|更新为)\s*([^\s，。；、,;!?！？]{1,24})/.exec(clause)
    if (!change) continue
    for (const otherClause of clauses) {
      if (otherClause === clause) continue
      const keep = /(?:保持|保持不变|仍为|保留)\s*([^\s，。；、,;!?！？]{1,24})/.exec(otherClause)
      if (!keep) continue
      if (normalizeForMatch(change[1]) === normalizeForMatch(keep[1])) continue
      const shared = intersectionSize(contentBigrams(clause), contentBigrams(otherClause))
      if (shared === 0) continue
      add({
        kind: 'value',
        a: change[0],
        b: keep[0],
        reason: `同一对象被要求改成「${change[1]}」又要求保持「${keep[1]}」`,
      })
    }
  }

  return conflicts.slice(0, 8)
}

function subtaskText(subtask: any): string {
  const parts = [
    subtask?.title,
    subtask?.role,
    subtask?.objective,
    ...(Array.isArray(subtask?.method) ? subtask.method : []),
    ...(Array.isArray(subtask?.inputs) ? subtask.inputs : []),
    ...(Array.isArray(subtask?.outputs) ? subtask.outputs : []),
    ...(Array.isArray(subtask?.acceptance) ? subtask.acceptance : []),
  ]
  return parts
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ')
}

function flattenPlanSubtasks(plan: any): any[] {
  const stages = Array.isArray(plan?.stages) ? plan.stages : []
  const subtasks: any[] = []
  for (const stage of stages) {
    for (const subtask of Array.isArray(stage?.subtasks) ? stage.subtasks : []) {
      subtasks.push(subtask)
      if (subtasks.length >= MAX_AUDITED_SUBTASKS) return subtasks
    }
  }
  return subtasks
}

/**
 * Explain one department choice with the catalog keywords that support it.
 *
 * `verdict` is intentionally coarse:
 *   - `fit`     — the chosen department has at least one matching keyword;
 *   - `weak`    — no keyword anywhere; insufficient evidence, not an error;
 *   - `mismatch`— the chosen department has zero evidence while another has a
 *                 strong one (>= MISMATCH_BLOCKING_SCORE).
 */
export function departmentFit(subtask: any, anchorText = ''): DepartmentAssignment {
  const department = typeof subtask?.department === 'string' ? subtask.department : ''
  const capability: DepartmentCapability | null = departmentCapability(department)
  const text = subtaskText(subtask)
  const matched = capability ? capability.keywords.filter((keyword) => keywordHit(text, keyword)) : []
  const anchorMatched = capability && anchorText.trim() !== ''
    ? capability.keywords.filter((keyword) => keywordHit(anchorText, keyword))
    : []
  const scores = scoreDepartments(text).filter((entry) => entry.id !== department)
  const best = scores.length > 0 && scores[0].score > 0 ? scores[0] : null
  const chosenScore = matched.length

  let intrusion = false
  if (capability && DEPARTMENT_INTRUSION_GUARDED.includes(department) && chosenScore > 0 && anchorText.trim() !== '') {
    const anchorHits = matchDepartmentKeywords(anchorText, department)
    if (anchorHits.length === 0) {
      const overlap = intersectionSize(contentBigrams(text), contentBigrams(anchorText))
      // No shared content bigram at all = the request never talks about this
      // domain. One shared topic word is enough to make it a warning instead.
      intrusion = overlap === 0
    }
  }

  let verdict: DepartmentAssignment['verdict'] = 'fit'
  let reason = ''
  if (!capability) {
    verdict = 'mismatch'
    reason = `未知部门「${department}」，不在 12 个部门目录内`
  } else if (chosenScore === 0 && anchorMatched.length === 0 && best && best.score >= MISMATCH_BLOCKING_SCORE) {
    verdict = 'mismatch'
    reason = `「${capability.zh}」无任何目录关键词命中，而「${best.zh}」命中 ${best.score} 个（${best.matched.slice(0, 4).join('、')}）`
  } else if (intrusion) {
    verdict = 'mismatch'
    reason = `「${capability.zh}」领域词（${matched.slice(0, 3).join('、')}）只出现在子任务中，用户原要求从未涉及该领域`
  } else if (chosenScore === 0 && anchorMatched.length === 0) {
    verdict = 'weak'
    reason = `「${capability.zh}」在子任务与用户原要求中都没有目录关键词命中，属证据不足（不阻断）`
  } else if (chosenScore === 0) {
    reason = `子任务未命中「${capability.zh}」职责词，但用户原要求命中：${anchorMatched.slice(0, 5).join('、')}`
  } else {
    reason = `命中「${capability.zh}」职责关键词 ${chosenScore} 个：${matched.slice(0, 5).join('、')}`
    if (anchorMatched.length > 0) reason += `；用户原要求也命中：${anchorMatched.slice(0, 5).join('、')}`
  }

  const declared = typeof subtask?.departmentRationale === 'string'
    ? subtask.departmentRationale.trim().slice(0, 600)
    : ''

  return {
    subtaskId: typeof subtask?.id === 'string' ? subtask.id : '',
    department,
    departmentLabel: capability?.zh ?? department,
    score: chosenScore,
    matched,
    anchorMatched,
    bestAlternative: best
      ? { id: best.id, zh: best.zh, score: best.score, matched: best.matched.slice(0, 5) }
      : null,
    intrusion,
    verdict,
    reason,
    declaredRationale: declared,
  }
}

export function buildTaskAnchor(taskText: unknown, sourceMessageIds: unknown = []): TaskAnchor | null {
  const text = typeof taskText === 'string' ? taskText.trim() : ''
  if (!text) return null
  const ids = Array.isArray(sourceMessageIds)
    ? sourceMessageIds.filter((id): id is string => typeof id === 'string').slice(0, 30)
    : []
  return {
    text: text.slice(0, MAX_TASK_ANCHOR_CHARS),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: text.length,
    sourceMessageIds: ids,
  }
}

function collectPlanText(plan: any): string {
  const understanding = plan?.taskUnderstanding ?? {}
  const parts: string[] = [plan?.title]
  for (const key of ['originalRequest', 'deliverable']) {
    if (typeof understanding?.[key] === 'string') parts.push(understanding[key])
  }
  for (const key of ['successCriteria', 'constraints', 'knownFacts', 'unknowns', 'assumptions']) {
    if (Array.isArray(understanding?.[key])) parts.push(...understanding[key])
  }
  for (const stage of Array.isArray(plan?.stages) ? plan.stages : []) {
    for (const key of ['name', 'goal', 'rationale', 'checkpoint']) {
      if (typeof stage?.[key] === 'string') parts.push(stage[key])
    }
    for (const subtask of Array.isArray(stage?.subtasks) ? stage.subtasks : []) {
      parts.push(subtaskText(subtask))
    }
  }
  for (const entry of Array.isArray(plan?.verification) ? plan.verification : []) {
    for (const key of ['item', 'method', 'evidence']) {
      if (typeof entry?.[key] === 'string') parts.push(entry[key])
    }
  }
  return parts.filter((part) => typeof part === 'string').join('\n')
}

function elementPresent(planText: string, element: TaskElement): boolean {
  const haystack = normalizeForMatch(planText)
  if (!haystack) return false
  if (element.kind === 'id') {
    const value = normalizeForMatch(element.value)
    return haystack.includes(value) || haystack.includes(value.replace(/-/g, ''))
  }
  if (element.kind === 'negation') {
    return haystack.includes(normalizeForMatch(element.value.replace(/^禁止:/, '')))
  }
  return haystack.includes(normalizeForMatch(element.value))
}

function emptyAudit(anchor: TaskAnchor | null, reason: string): UnderstandingAudit {
  return {
    version: UNDERSTANDING_AUDIT_VERSION,
    anchor,
    stage1: { elements: [], hardCount: 0, references: [], conflicts: [], deliverableClauses: [] },
    stage2: { assignments: [], departmentsUsed: [], mismatches: [] },
    stage3: {
      verdict: 'degraded',
      rewritten: false,
      summaryCoverage: 0,
      droppedFromSummary: [],
      missingHardAnchors: [],
      missingDeliverables: [],
      reasons: [reason],
    },
  }
}

/**
 * Run the three stages against one plan.
 *
 * A legacy/replayed plan without the original task text returns a `degraded`
 * audit instead of throwing: replay must keep working, and "cannot check" is
 * not the same as "checked and passed" (which is why the verdict says so).
 */
export function auditTaskUnderstanding(plan: any, context: PlanAuditContext = {}): UnderstandingAudit {
  const taskText = typeof context.taskText === 'string' ? context.taskText.trim() : ''
  const anchor = buildTaskAnchor(taskText, context.sourceMessageIds)
  if (!anchor) {
    return emptyAudit(null, '没有用户原文（旧计划/回放），锚点偏离校验降级为不阻断')
  }

  const extracted = extractTaskElements(taskText)
  const planText = collectPlanText(plan)
  const assignments = flattenPlanSubtasks(plan).map((subtask) => departmentFit(subtask, taskText))
  const departmentsUsed = [...new Set(assignments.map((entry) => entry.department))]
  const mismatches = assignments
    .filter((entry) => entry.verdict === 'mismatch')
    .map((entry) => `${entry.subtaskId || '（无 ID）'} → ${entry.departmentLabel}：${entry.reason}`)

  const missingElements = extracted.elements
    .filter((element) => element.hard && !elementPresent(planText, element))
  const missingHardAnchors = missingElements.map((element) => `${element.kind}:${element.value}`)

  const missingDeliverables = extracted.deliverableClauses.filter((clause) => {
    const haystack = normalizeForMatch(planText)
    const bigrams = [...contentBigrams(clause)]
    if (bigrams.length === 0) return false
    const hits = bigrams.filter((bigram) => haystack.includes(bigram)).length
    return hits < Math.max(1, Math.ceil(bigrams.length * 0.5))
  })

  const originalRequest = typeof plan?.taskUnderstanding?.originalRequest === 'string'
    ? plan.taskUnderstanding.originalRequest
    : ''
  const summaryNorm = normalizeForMatch(originalRequest)
  const anchorNorm = normalizeForMatch(taskText)
  const verbatim = summaryNorm.length > 0 && anchorNorm.includes(summaryNorm)
  const droppedFromSummary = extracted.elements
    .filter((element) => element.hard && !normalizeForMatch(originalRequest).includes(normalizeForMatch(element.value)))
    .map((element) => `${element.kind}:${element.value}`)
  const hardTotal = extracted.elements.filter((element) => element.hard).length
  const summaryCoverage = hardTotal === 0 ? 1 : (hardTotal - droppedFromSummary.length) / hardTotal

  const unresolved = extracted.references.filter((reference) => !reference.resolved
    && (typeof context.conversationContext !== 'string' || context.conversationContext.trim() === ''))
  const resolvedByContext = extracted.references.map((reference) => (
    !reference.resolved
      && typeof context.conversationContext === 'string'
      && context.conversationContext.trim() !== ''
      ? { ...reference, resolved: true, resolvedBy: 'context' as const }
      : reference
  ))

  const reasons: string[] = []
  let verdict: UnderstandingAudit['stage3']['verdict'] = 'aligned'
  if (missingHardAnchors.length > 0) {
    verdict = 'deviation'
    reasons.push(`用户原要求中的 ${missingHardAnchors.length} 个硬要素在计划中完全缺失：${missingHardAnchors.slice(0, 6).join('、')}`)
  }
  if (mismatches.length > 0) {
    if (verdict === 'aligned') verdict = 'deviation'
    reasons.push(`${mismatches.length} 个子任务的部门与用户原要求矛盾：${mismatches.slice(0, 4).join('；')}`)
  }
  if (extracted.conflicts.length > 0) {
    if (verdict === 'aligned') verdict = 'needs-clarification'
    reasons.push(`用户要求自相矛盾 ${extracted.conflicts.length} 处：${extracted.conflicts.map((conflict) => conflict.reason).slice(0, 3).join('；')}`)
  }
  if (unresolved.length > 0) {
    if (verdict === 'aligned') verdict = 'needs-context'
    reasons.push(`含指代的任务缺少对话上下文：${unresolved.map((reference) => reference.token).join('、')}，不应在未澄清前派发`)
  }
  if (verdict === 'aligned') {
    reasons.push(`硬要素 ${hardTotal - missingHardAnchors.length}/${hardTotal} 全部保留；${assignments.length} 个子任务的部门有目录关键词支撑`)
  }

  return {
    version: UNDERSTANDING_AUDIT_VERSION,
    anchor,
    stage1: {
      elements: extracted.elements,
      hardCount: extracted.hardCount,
      references: resolvedByContext,
      conflicts: extracted.conflicts,
      deliverableClauses: extracted.deliverableClauses,
    },
    stage2: { assignments, departmentsUsed, mismatches },
    stage3: {
      verdict,
      rewritten: !verbatim,
      summaryCoverage: Number(summaryCoverage.toFixed(3)),
      droppedFromSummary,
      missingHardAnchors,
      missingDeliverables,
      reasons,
    },
  }
}

/**
 * Convert an audit into retry errors.
 *
 * `strict:false` is the rollback switch: every finding becomes a warning and the
 * plan proceeds exactly like 1.11.1. This is what an operator flips if a
 * release starts rejecting legitimate tasks, without reverting code.
 */
export function validatePlanContext(plan: any, context: PlanAuditContext = {}): PlanContextValidation {
  const audit = auditTaskUnderstanding(plan, context)
  const warnings: string[] = []
  const errors: string[] = []
  const strict = context.strict !== false

  for (const reason of audit.stage3.reasons) {
    if (audit.stage3.verdict === 'aligned') continue
    warnings.push(reason)
  }
  for (const missing of audit.stage3.missingDeliverables) {
    warnings.push(`交付物子句可能未被计划覆盖：${missing}`)
  }
  for (const assignment of audit.stage2.assignments) {
    if (assignment.verdict === 'weak') warnings.push(`${assignment.subtaskId} 部门「${assignment.departmentLabel}」证据不足：${assignment.reason}`)
  }

  if (strict) {
    /*
     * A plan must not resolve a contradiction by silently picking a side, and
     * must not guess what 「它」 means. Both need the user, so both block the
     * dispatch under strict mode and degrade to a recorded warning only when
     * the rollback switch is on.
     */
    if (audit.stage3.verdict === 'needs-clarification') {
      errors.push(`CLARIFY: ${audit.stage3.reasons.find((reason) => reason.includes('自相矛盾')) ?? '用户要求存在矛盾，必须先向用户确认'}`)
    }
    if (audit.stage3.verdict === 'needs-context') {
      errors.push(`CONTEXT: ${audit.stage3.reasons.find((reason) => reason.includes('指代')) ?? '任务含指代但缺少对话上下文，必须先向用户确认'}`)
    }
    for (const missing of audit.stage3.missingHardAnchors.slice(0, 6)) {
      errors.push(`DEVIATION: 用户原要求中的硬要素「${missing}」在计划中完全缺失，请补回或说明为什么可以省略`)
    }
    for (const assignment of audit.stage2.assignments) {
      if (assignment.verdict !== 'mismatch') continue
      errors.push(`DEVIATION: 子任务 ${assignment.subtaskId || '（无 ID）'} 分配给「${assignment.departmentLabel}」缺乏依据：${assignment.reason}`)
      if (errors.length >= 12) break
    }
  }

  return { ok: errors.length === 0, errors: errors.slice(0, 12), warnings: warnings.slice(0, 20), audit }
}

/**
 * Compact audit kept on the plan message. The full audit (with evidence clauses)
 * stays available from `auditTaskUnderstanding`; the stored copy is trimmed so a
 * 15-subtask plan does not double its own JSON size.
 */
export function compactUnderstandingAudit(audit: UnderstandingAudit): any {
  return {
    version: audit.version,
    anchor: audit.anchor
      ? { sha256: audit.anchor.sha256, length: audit.anchor.length, sourceMessageIds: audit.anchor.sourceMessageIds }
      : null,
    stage1: {
      elements: audit.stage1.elements.map((element) => ({ kind: element.kind, value: element.value, hard: element.hard })),
      hardCount: audit.stage1.hardCount,
      references: audit.stage1.references.map((reference) => ({
        token: reference.token,
        resolved: reference.resolved,
        resolvedBy: reference.resolvedBy,
      })),
      conflicts: audit.stage1.conflicts,
    },
    stage2: {
      assignments: audit.stage2.assignments.map((assignment) => ({
        subtaskId: assignment.subtaskId,
        department: assignment.department,
        verdict: assignment.verdict,
        score: assignment.score,
        matched: assignment.matched.slice(0, 5),
        reason: assignment.reason,
        declaredRationale: assignment.declaredRationale,
      })),
      departmentsUsed: audit.stage2.departmentsUsed,
      mismatches: audit.stage2.mismatches,
    },
    stage3: {
      verdict: audit.stage3.verdict,
      rewritten: audit.stage3.rewritten,
      summaryCoverage: audit.stage3.summaryCoverage,
      droppedFromSummary: audit.stage3.droppedFromSummary,
      missingHardAnchors: audit.stage3.missingHardAnchors,
      missingDeliverables: audit.stage3.missingDeliverables,
      reasons: audit.stage3.reasons,
    },
  }
}

/**
 * The department catalogue is the contract behind every match above; keep the
 * 12 ids in sync with `DEPARTMENTS` in plan.ts.
 */
export const UNDERSTANDING_DEPARTMENT_IDS: readonly string[] = Object.freeze(
  DEPARTMENT_CAPABILITIES.map((entry) => entry.id),
)
