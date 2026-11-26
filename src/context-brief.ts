/**
 * [3.2.9] Latent Briefing / ASTC 的插件级等价实现（纯函数）。
 *
 * 背景（必须如实说明）：DSH 插件运行在 API 文本层，拿不到模型内部 KV 张量，
 * 也无法生成真正的 soft token；宿主 llm/stream 对主循环请求深冻结。因此本模块
 * 不冒充模型内压缩，而是实现论文中可由插件承担的两条原则：
 *
 *  1) Latent Briefing：把父轨迹/兄弟结果压缩成「按任务相关性挑选 + 精确引用」
 *     的结构化简报，worker 只读简报，不重放全文；同一份输入复用同一份编译结果
 *     （可复用紧凑缓存），并在前缀顺序上保持稳定，便于供应商 KV 前缀缓存命中。
 *  2) ASTC：区分「已被吸收、可压缩」的内容与「硬事实」——数字、路径、哈希、
 *     编号、命令、错误码、验收/约束原句优先逐字保留；单句≤600 字、硬事实总量
 *     ≤max(600,预算)，超出退到精确值清单+ref；叙述性内容压成软摘要；被省略的
 *     内容保留 id/ref 索引，原文仍可检索，不做不可逆删除。
 *
 * 安全边界：本模块只处理调用方传入的文本，不读会话、不联网、不写盘。
 * 输出对同一输入字节级稳定（哈希只依赖输入内容与预算），便于缓存命中测试。
 */

import { createHash } from 'node:crypto'

export interface BriefSource {
  id: string
  text: string
  /** 原文/产物的可检索引用（路径、状态字段、会话 id 等）。 */
  ref?: string
  /** true = 该段已被后续摘要/结算吸收，正文可省略，仅保留 ref。 */
  absorbed?: boolean
  /** true = 强制整段按硬事实逐字保留。 */
  hard?: boolean
}

export interface BriefOmission {
  id: string
  reason: 'empty' | 'duplicate' | 'absorbed' | 'budget'
  ref?: string
}

export interface CompiledBrief {
  version: 1
  hash: string
  hard: string[]
  soft: string[]
  refs: string[]
  omitted: BriefOmission[]
  chars: number
  tokens: number
  cacheHit: boolean
}

const MAX_SOFT_ITEMS = 12
const MAX_HARD_ITEMS = 32
const MAX_SOFT_SENTENCE_CHARS = 180
const MAX_HARD_SENTENCE_CHARS = 600
const BRIEF_CACHE_MAX = 256
const briefCache = new Map<string, CompiledBrief>()
const cacheStats = { hits: 0, misses: 0 }

const HARD_PATTERNS: readonly RegExp[] = [
  // 匹配有语义的数字（带单位/小数/百分号/版本号/日期/≥2位数），避免单纯“第 1 步”“1)”把纯叙述句误判为硬事实
  /\b\d+\.\d+\b|\d+(?:\.\d+)?\s*(?:%|个|项|条|页|次|份|人|天|小时|分钟|秒|ms|s|KB|MB|GB|字|万|亿)\b|\b\d{2,}\b/i,
  /(?:^|[\s(（])(?:\.{0,2}\/|~\/|\/|[A-Za-z]:\\|reports\/)[^\s，。；、)）]+/,
  /\b[a-f0-9]{8,}\b/i,
  /\b(?:T|S|A|F|H|wp)[-_]?\d{1,4}\b/i,
  /\b(?:npm|node|git|pnpm|yarn|python|bash|sh|curl|grep|rg|sed|awk|tsc|dsh)\b/,
  /\b[A-Z][A-Z0-9_]{2,}\b/,
  /(?:必须|不得|禁止|只能|至少|最多|不超过|上限|下限|必须满足|不得改写|逐字|精确|原样)/,
  /\b(?:must|must not|shall|only|at least|at most|exactly)\b/i,
]

function asText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

/** 句子切分：中文标点、英文句点（后接空白或结尾）、换行。 */
export function splitBriefSentences(text: string): string[] {
  const normalized = asText(text)
  if (normalized === '') return []
  const matches = normalized.match(/[^。！？；!?;\n]+(?:[。！？；!?;]|\.(?=\s|$))?/g) ?? []
  return matches.map((item) => item.trim()).filter(Boolean)
}

/** 硬事实判定：只做确定性词面判断，不调模型、不猜语义。 */
export function isHardFactSentence(sentence: string): boolean {
  const text = asText(sentence)
  if (text === '') return false
  return HARD_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 从长文本中抽取「精确值」清单：路径、哈希、编号、命令、数字/百分比、约束原句。
 * 只用于硬事实总量超预算时的二级压缩——保留可执行的值，正文用 ref 指回原文。
 */
export function extractHardFacts(text: string): string[] {
  const value = asText(text)
  if (value === '') return []
  const patterns: readonly [RegExp, number][] = [
    [/(?:^|[\s(（])(?:\.{0,2}\/|~\/|\/|[A-Za-z]:\\|reports\/)[^\s，。；、)）]+/g, 10],
    [/\b[a-f0-9]{8,}\b/gi, 8],
    [/\b(?:T|S|A|F|H|wp)[-_]?\d{1,4}\b/gi, 8],
    [/\b(?:npm|node|git|pnpm|yarn|python|bash|sh|curl|grep|rg|sed|awk|tsc|dsh)\b[^，。；\n]{0,60}/g, 6],
    [/(?:必须|不得|禁止|只能|至少|最多|不超过|上限|下限)[^。！？；\n]{0,80}/g, 6],
    [/\d+(?:\.\d+)?%/g, 8],
    [/\d+(?:\.\d+)?%?/g, 8],
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const [pattern, quota] of patterns) {
    pattern.lastIndex = 0
    let taken = 0
    for (const match of value.matchAll(pattern)) {
      const fact = String(match[0] ?? '').replace(/^[\s(（]+/, '').trim()
      if (fact === '' || seen.has(fact)) continue
      seen.add(fact)
      out.push(fact)
      taken += 1
      if (out.length >= 40) return out
      if (taken >= quota) break
    }
  }
  return out
}

function normalizeForDedupe(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[，。；、,.;:：！？!?（）()\[\]【】「」“”"'—–\-]/g, '')
    .toLowerCase()
}

function bigrams(value: string): Set<string> {
  const text = normalizeForDedupe(value)
  const set = new Set<string>()
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

/** 可复用的轻量相似度（Dice，字符二元组）；用于「是否已吸收/重复」判断。 */
export function briefSimilarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return normalizeForDedupe(a) === normalizeForDedupe(b) ? 1 : 0
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}

/** 是否已被后续摘要/结算吸收（相似度阈值保守，避免误删唯一信息）。 */
export function looksAbsorbed(text: string, evidence: { summary?: string; settlement?: string; superseded?: boolean } = {}): boolean {
  if (evidence.superseded === true) return true
  for (const candidate of [evidence.summary, evidence.settlement]) {
    if (typeof candidate === 'string' && candidate.trim() !== '' && briefSimilarity(text, candidate) >= 0.82) return true
  }
  return false
}

function clipSentence(text: string, max: number): string {
  const value = asText(text)
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function cacheKey(sources: readonly BriefSource[], budgetChars: number): string {
  const payload = sources.map((source) => [
    String(source.id ?? ''),
    asText(source.text),
    String(source.ref ?? ''),
    source.absorbed === true ? '1' : '0',
    source.hard === true ? '1' : '0',
  ])
  return createHash('sha256').update(JSON.stringify({ payload, budgetChars })).digest('hex')
}

function rememberCache(key: string, brief: CompiledBrief): CompiledBrief {
  if (briefCache.size >= BRIEF_CACHE_MAX) {
    const oldest = briefCache.keys().next().value
    if (typeof oldest === 'string') briefCache.delete(oldest)
  }
  briefCache.set(key, { ...brief, cacheHit: false })
  return brief
}

/**
 * 编译简报。硬事实优先保留（允许超出预算并显式记账），软摘要按预算截断；
 * 被吸收/重复/预算省略的条目只记录 id/ref，原文不被删除。
 */
export function compileBrief(
  sources: readonly BriefSource[],
  options: { budgetChars?: number } = {},
): CompiledBrief {
  const budgetChars = Math.max(120, Math.floor(Number(options.budgetChars) || 1600))
  const key = cacheKey(sources, budgetChars)
  const cached = briefCache.get(key)
  if (cached) {
    cacheStats.hits += 1
    return { ...cached, cacheHit: true }
  }
  cacheStats.misses += 1

  const hard: string[] = []
  const soft: string[] = []
  const softRefs: Array<string | undefined> = []
  const refs: string[] = []
  const omitted: BriefOmission[] = []
  const seenHard = new Set<string>()
  const seenSoft = new Set<string>()
  let hardChars = 0
  // 硬事实也遵守总上限（至少 600 字，避免极短预算把一条路径截断）；超出进 omitted。
  const hardLimit = Math.max(600, budgetChars)

  for (const source of sources) {
    const id = String(source?.id ?? '')
    const text = asText(source?.text)
    const ref = typeof source?.ref === 'string' && source.ref.trim() !== '' ? source.ref.trim() : undefined
    if (ref && !refs.includes(ref)) refs.push(ref)
    if (text === '') {
      omitted.push({ id, reason: 'empty', ...(ref ? { ref } : {}) })
      continue
    }
    if (source.absorbed === true) {
      omitted.push({ id, reason: 'absorbed', ...(ref ? { ref } : {}) })
      continue
    }
    const sentences = splitBriefSentences(text)
    if (sentences.length === 0) {
      omitted.push({ id, reason: 'empty', ...(ref ? { ref } : {}) })
      continue
    }
    let sourceWasDuplicate = false
    for (const sentence of sentences) {
      const normalized = normalizeForDedupe(sentence)
      if (normalized === '') continue
      const explicitHard = source.hard === true
      const hardFact = explicitHard || isHardFactSentence(sentence)
      const bucket = hardFact ? hard : soft
      const seen = hardFact ? seenHard : seenSoft
      if (seen.has(normalized)) {
        sourceWasDuplicate = true
        continue
      }
      if (!explicitHard && bucket.length >= (hardFact ? MAX_HARD_ITEMS : MAX_SOFT_ITEMS)) {
        omitted.push({ id, reason: 'budget', ...(ref ? { ref } : {}) })
        continue
      }
      const clipped = clipSentence(sentence, hardFact ? MAX_HARD_SENTENCE_CHARS : MAX_SOFT_SENTENCE_CHARS)
      // 显式标注 hard: true 的权威约束/锚点必须守恒（绝不因软预算静默丢弃）；仅启发式命中的硬句受 hardLimit 约束。
      if (hardFact && !explicitHard && hardChars + clipped.length > hardLimit) {
        omitted.push({ id, reason: 'budget', ...(ref ? { ref } : {}) })
        continue
      }
      seen.add(normalized)
      bucket.push(clipped)
      if (hardFact) hardChars += clipped.length
      else softRefs.push(ref)
    }
    if (sourceWasDuplicate) omitted.push({ id, reason: 'duplicate', ...(ref ? { ref } : {}) })
  }

  /*
   * 硬事实优先但不再无界溢出：hardLimit 已限制总量，超出句子进 omitted。
   * 软摘要只在剩余预算内保留；软句被省略时仍带来源 ref，原文可回取。
   */
  const softSelected: string[] = []
  let used = hardChars
  for (let index = 0; index < soft.length; index += 1) {
    const sentence = soft[index]
    if (used + sentence.length > budgetChars) {
      const sourceRef = softRefs[index]
      omitted.push({ id: `soft:${normalizeForDedupe(sentence).slice(0, 24)}`, reason: 'budget', ...(sourceRef ? { ref: sourceRef } : {}) })
      continue
    }
    softSelected.push(sentence)
    used += sentence.length
  }

  const chars = hard.join('；').length + softSelected.join('；').length
  const brief: CompiledBrief = {
    version: 1,
    hash: key.slice(0, 16),
    hard,
    soft: softSelected,
    refs,
    omitted,
    chars,
    tokens: Math.max(0, Math.ceil(chars / 2)),
    cacheHit: false,
  }
  return rememberCache(key, brief)
}

/** 一行式压缩（用于依赖摘要/兄弟摘要等行内位置）：硬事实优先逐字保留，但严格受 budgetChars 约束；放不下的硬句退到精确值清单+ref，软摘要同样受预算约束。 */
export function condenseText(text: unknown, budgetChars = 800, ref?: string): string {
  const value = asText(text)
  if (value === '') return ''
  const budget = Math.max(80, Math.floor(Number(budgetChars) || 800))
  const brief = compileBrief([{ id: 'inline', text: value, ...(ref ? { ref } : {}) }], { budgetChars: budget })
  const hardText = brief.hard.join('；')
  const softText = brief.soft.join('；')
  const suffix = ref ? `（原文 ${ref}）` : '（原文在状态/产物中）'
  if (hardText.length === 0) {
    const body = softText || value.replace(/\s+/g, ' ').trim()
    return body.length > budget ? `${body.slice(0, Math.max(0, budget - suffix.length))}${suffix}` : body
  }
  /*
   * 行内摘要必须真的守预算：硬事实整句超限时退到「精确值清单」——路径/哈希/
   * 编号/命令/数字/约束原句逐字保留，叙述性部分由 ref 指回原文；清单仍超限时
   * 截断清单并保留 ref。这样 800/80 字调用点不会因为「句句带数字」而膨胀。
   */
  const capacity = Math.max(0, budget - suffix.length)
  if (hardText.length > capacity) {
    const facts = extractHardFacts(value).join('；')
    const kept = facts.length > capacity ? `${facts.slice(0, Math.max(0, capacity - 1))}…` : facts
    const fallback = hardText.slice(0, Math.max(0, capacity - 1))
    return `${kept || fallback}${suffix}`.slice(0, budget)
  }
  const combined = softText ? `${hardText}；${softText}` : hardText
  if (combined.length > capacity) {
    return `${hardText}${suffix}`.slice(0, budget)
  }
  return combined
}

export interface RenderBriefOptions {
  title?: string
  includeOmitted?: boolean
  omittedLimit?: number
  /** true = 省略顶部【title｜...】标题行（供外层已有标题的上下文包复用，避免双层套壳）。 */
  omitHeader?: boolean
  /** false = 省略「可检索引用」段（已包含条目的 ref 不重复列出）。默认 true。 */
  includeRefs?: boolean
}

/** 渲染完整简报（稳定顺序：硬事实 → 软摘要 → 引用 → 省略索引）。 */
export function renderBrief(brief: CompiledBrief, options: RenderBriefOptions = {}): string {
  const title = typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim() : 'Latent Brief'
  const lines: string[] = options.omitHeader
    ? []
    : [`【${title}｜v1｜hash ${brief.hash}｜硬 ${brief.hard.length} / 软 ${brief.soft.length}｜约 ${brief.tokens} token】`]
  if (brief.hard.length > 0) {
    lines.push('硬事实（优先逐字保留，不得改写）：', ...brief.hard.map((item) => `- ${item}`))
  }
  if (brief.soft.length > 0) {
    lines.push('软摘要（已吸收/可压缩内容，非逐字；需要原文按 ref 取回）：', ...brief.soft.map((item) => `- ${item}`))
  }
  if (options.includeRefs !== false && brief.refs.length > 0) {
    lines.push('可检索引用（原文未删除）：', ...brief.refs.slice(0, 20).map((item) => `- ${item}`))
  }
  if (options.includeOmitted !== false && brief.omitted.length > 0) {
    const limit = Number.isFinite(Number(options.omittedLimit)) ? Math.max(0, Math.floor(Number(options.omittedLimit))) : 20
    const rows = brief.omitted.slice(0, limit)
    lines.push('省略条目（只省略本次展开，原文仍可按 ref 取回）：', ...rows.map((item) => `- ${item.id}｜${item.reason}${item.ref ? `｜${item.ref}` : ''}`))
  }
  return lines.join('\n')
}

/** 测试/诊断：清空复用缓存与计数。 */
export function clearBriefCache(): void {
  briefCache.clear()
  cacheStats.hits = 0
  cacheStats.misses = 0
}

/** 测试/诊断：当前编译缓存命中情况。 */
export function briefCacheStats(): { size: number; hits: number; misses: number } {
  return { size: briefCache.size, hits: cacheStats.hits, misses: cacheStats.misses }
}
