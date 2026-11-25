/**
 * [3.2.9] RCR（Role-Conditioned Context Routing）插件级实现。
 *
 * 用户 2026-11-25 第 3 条：不再向所有代理广播完整上下文，而是按角色与任务
 * 阶段，在 token/字符预算内分配最相关的记忆条目。
 *
 * 本模块是纯函数路由层：输入结构化的 ContextItem[]，输出 selected / omitted、
 * 用量与原因。它不读文件、不调模型、不写状态，因而可被 plan / llm-rules /
 * runtime / 测试同口径消费。
 *
 * 与「3.2.5 注意力零丢失红线」的关系：
 *  - priority:'must' 的条目永不因预算被丢弃；预算不够时允许溢出并显式记账。
 *  - 被省略的条目必须带 id/ref 进入 omitted 索引，原文仍在计划/状态/产物中可
 *    取回；这里只压缩「本次提示词不直接展开」的展示面，不删除持久信息。
 */

export type ContextRole = 'planner' | 'leader' | 'expert' | 'verifier' | 'root'
export type ContextStage = 'planning' | 'preparation' | 'execution' | 'verification' | 'retro'

export type ContextKind =
  | 'anchor'
  | 'acceptance'
  | 'constraint'
  | 'quality'
  | 'dependency'
  | 'sibling'
  | 'lesson'
  | 'handoff'
  | 'instruction'
  | 'artifact'
  | 'risk'
  | 'background'
  | 'evidence'
  | 'strategy'

export type ContextPriority = 'must' | 'high' | 'normal' | 'low'

export interface ContextItem {
  id: string
  kind: ContextKind
  text: string
  /** 缺省 '*' = 所有角色可见；具体角色只对该角色可见。 */
  role?: ContextRole | '*'
  /** 缺省 '*' = 所有阶段可见。 */
  stage?: ContextStage | '*'
  priority?: ContextPriority
  /** 0–100，调用方给的额外相关性；不改变 must 的不可丢弃性。 */
  relevance?: number
  /** 原文/产物的可检索引用（路径、status 字段、会话 id 等）。 */
  ref?: string
  /** 去重键；缺省用归一化文本。 */
  dedupeKey?: string
}

export interface ContextRouteBudget {
  /** 字符预算（插件全链路以字符计，避免引入 tokenizer 依赖）。 */
  chars: number
  maxItems?: number
  /** 每种 kind 的条数上限；must 条目不受该上限约束。 */
  perKind?: Partial<Record<ContextKind, number>>
}

export interface ContextRouteOptions extends ContextRouteBudget {
  role: ContextRole
  stage: ContextStage
}

export interface ContextOmission {
  id: string
  kind: ContextKind
  reason: 'role-mismatch' | 'stage-mismatch' | 'duplicate' | 'kind-cap' | 'budget' | 'empty'
  ref?: string
}

export interface ContextRouteResult {
  selected: ContextItem[]
  omitted: ContextOmission[]
  usedChars: number
  overflowChars: number
  reasons: string[]
}

const PRIORITY_SCORE: Record<ContextPriority, number> = {
  must: 1000,
  high: 300,
  normal: 100,
  low: 10,
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。；、,.;:：！？!?（）()\[\]【】「」“”"'—–\-]/g, '')
    .toLowerCase()
}

function scoreOf(item: ContextItem, role: ContextRole, stage: ContextStage, order: number): number {
  const priority = item.priority ?? 'normal'
  let score = PRIORITY_SCORE[priority]
  const itemRole = item.role ?? '*'
  const itemStage = item.stage ?? '*'
  if (itemRole === '*' || itemRole === role) score += 40
  else score -= 400
  if (itemStage === '*' || itemStage === stage) score += 30
  else score -= 120
  const relevance = Number(item.relevance)
  if (Number.isFinite(relevance)) score += Math.max(0, Math.min(100, relevance))
  // 稳定排序：同分时保留调用方顺序（越靠前越优先）。
  return score * 10000 - order
}

/** 估算字符对应的 token 数（中英混排的保守近似，仅用于展示/预算说明）。 */
export function estimateContextTokens(chars: number): number {
  return Math.max(0, Math.ceil(Math.max(0, chars) / 2))
}

/**
 * 路由入口。确定性：同样的 items/options 必然得到同样的 selected 顺序与
 * omitted 顺序（不依赖时间、随机数或宿主状态）。
 */
export function routeContext(items: readonly ContextItem[], options: ContextRouteOptions): ContextRouteResult {
  const role = options.role
  const stage = options.stage
  const budget = Math.max(0, Math.floor(Number(options.chars) || 0))
  const maxItems = Number.isFinite(Number(options.maxItems)) ? Math.max(1, Math.floor(Number(options.maxItems))) : 64
  const perKind = options.perKind ?? {}
  const omitted: ContextOmission[] = []
  const reasons: string[] = []

  const candidates: Array<{ item: ContextItem; score: number; order: number }> = []
  items.forEach((item, order) => {
    if (!item || typeof item.text !== 'string' || item.text.trim() === '') {
      omitted.push({ id: String(item?.id ?? `#${order}`), kind: item?.kind ?? 'background', reason: 'empty' })
      return
    }
    const itemRole = item.role ?? '*'
    const itemStage = item.stage ?? '*'
    if (itemRole !== '*' && itemRole !== role) {
      omitted.push({ id: item.id, kind: item.kind, reason: 'role-mismatch', ...(item.ref ? { ref: item.ref } : {}) })
      return
    }
    if (itemStage !== '*' && itemStage !== stage) {
      omitted.push({ id: item.id, kind: item.kind, reason: 'stage-mismatch', ...(item.ref ? { ref: item.ref } : {}) })
      return
    }
    candidates.push({ item, score: scoreOf(item, role, stage, order), order })
  })

  candidates.sort((a, b) => b.score - a.score || a.order - b.order)

  const seen = new Set<string>()
  const selected: ContextItem[] = []
  const kindCounts = new Map<ContextKind, number>()
  let usedChars = 0

  for (const candidate of candidates) {
    const item = candidate.item
    const key = item.dedupeKey ?? normalizeText(item.text)
    if (key !== '' && seen.has(key)) {
      omitted.push({ id: item.id, kind: item.kind, reason: 'duplicate', ...(item.ref ? { ref: item.ref } : {}) })
      continue
    }
    const cap = Number(perKind[item.kind])
    const count = kindCounts.get(item.kind) ?? 0
    const isMust = (item.priority ?? 'normal') === 'must'
    if (selected.length >= maxItems && !isMust) {
      omitted.push({ id: item.id, kind: item.kind, reason: 'kind-cap', ...(item.ref ? { ref: item.ref } : {}) })
      continue
    }
    if (!isMust && Number.isFinite(cap) && cap >= 0 && count >= cap) {
      omitted.push({ id: item.id, kind: item.kind, reason: 'kind-cap', ...(item.ref ? { ref: item.ref } : {}) })
      continue
    }
    const length = item.text.length
    if (!isMust && usedChars + length > budget) {
      omitted.push({ id: item.id, kind: item.kind, reason: 'budget', ...(item.ref ? { ref: item.ref } : {}) })
      continue
    }
    selected.push(item)
    seen.add(key)
    kindCounts.set(item.kind, count + 1)
    usedChars += length
  }
  const overflowChars = Math.max(0, usedChars - budget)

  const counts = selected.reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)
  reasons.push(`预算 ${budget} 字；选中 ${selected.length} 条 / ${usedChars} 字${overflowChars > 0 ? `（must 溢出 ${overflowChars} 字）` : ''}`)
  reasons.push(`按角色 ${role} / 阶段 ${stage} 路由；省略 ${omitted.length} 条（原文可按 ref 取回）`)
  const kinds = Object.keys(counts).sort()
  if (kinds.length > 0) reasons.push(`选中类型：${kinds.map((kind) => `${kind}:${counts[kind]}`).join('、')}`)

  return { selected, omitted, usedChars, overflowChars, reasons }
}

/** 渲染省略索引（只给 id/kind/ref/reason，不重复正文，避免二次付费）。 */
export function renderContextOmissions(omitted: readonly ContextOmission[], limit = 12): string {
  const rows = omitted.filter((item) => item.reason !== 'empty').slice(0, Math.max(0, limit))
  if (rows.length === 0) return ''
  return [
    '本次未直接展开的条目（原文仍在计划/状态/产物中，可按 ref 取回；不是删除）：',
    ...rows.map((item) => `- ${item.id}｜${item.kind}｜${item.reason}${item.ref ? `｜${item.ref}` : ''}`),
  ].join('\n')
}
