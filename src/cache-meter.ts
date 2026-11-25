/**
 * [3.2.9] 供应商 KV 前缀缓存计量（插件层可观测面）。
 *
 * 用户 2026-11-25 第 4 条要求「KV Cache 层面的记忆共享」。插件拿不到模型内部
 * KV 张量，但宿主在 llm/stream 的 usage 块里提供了 cacheReadTokens /
 * cacheWriteTokens（供应商前缀缓存命中/写入）。本模块只做三件事：
 *  - 只读观察 llm/stream 的 usage，不修改请求、不制造第二个 next()；
 *  - 按会话累计 input/output/cacheRead/cacheWrite 与命中率；
 *  - 供 dsh_workplan_status 展示，证明「稳定前缀 + 复用简报」是否真的命中缓存。
 *
 * 这不是伪造 KV 共享：它只报告供应商真实返回的缓存计量；拿不到字段时如实为 0。
 */

export interface LlmUsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  totalTokens?: unknown
}

export interface CacheUsageSummary {
  sessions: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * cacheRead / (inputTokens + cacheReadTokens + cacheWriteTokens)，0–1。
   * 宿主 TokenUsage 的计数互斥：inputTokens 是未命中缓存的输入，cacheRead/
   * cacheWrite 另行统计；真实计费输入为三者之和。无输入时为 0，不虚报。
   */
  hitRate: number
  savedTokens: number
}

export interface LlmCacheMeter {
  observe(sessionId: string, usage: LlmUsageLike | null | undefined): void
  snapshot(sessionId: string): CacheUsageSummary
  summary(sessionIds?: readonly string[]): CacheUsageSummary
  clear(): void
  size(): number
}

interface MutableUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function emptyMutable(): MutableUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function toSummary(rows: Iterable<MutableUsage>): CacheUsageSummary {
  let sessions = 0
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const row of rows) {
    sessions += 1
    calls += row.calls
    inputTokens += row.inputTokens
    outputTokens += row.outputTokens
    cacheReadTokens += row.cacheReadTokens
    cacheWriteTokens += row.cacheWriteTokens
  }
  const denominator = inputTokens + cacheReadTokens + cacheWriteTokens
  return {
    sessions,
    calls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    hitRate: denominator > 0 ? Math.min(1, cacheReadTokens / denominator) : 0,
    savedTokens: cacheReadTokens,
  }
}

/**
 * 创建计量器。默认最多保留 256 个会话；超出时按插入顺序淘汰最旧会话，
 * 避免长进程内存无界增长。数量级远小于计划/子会话数。
 */
export function createLlmCacheMeter(options: { maxSessions?: number } = {}): LlmCacheMeter {
  const maxSessions = Number.isFinite(Number(options.maxSessions))
    ? Math.max(8, Math.floor(Number(options.maxSessions)))
    : 256
  const rows = new Map<string, MutableUsage>()

  function ensure(sessionId: string): MutableUsage | null {
    const id = String(sessionId ?? '')
    if (id === '') return null
    let row = rows.get(id)
    if (row) {
      // 命中即刷新 LRU：活跃计划根会话不应被新会话的 FIFO 顺序淘汰。
      rows.delete(id)
      rows.set(id, row)
      return row
    }
    row = emptyMutable()
    rows.set(id, row)
    if (rows.size > maxSessions) {
      const oldest = rows.keys().next().value
      if (typeof oldest === 'string' && oldest !== id) rows.delete(oldest)
    }
    return row
  }

  return {
    observe(sessionId, usage) {
      if (!usage || typeof usage !== 'object') return
      const row = ensure(sessionId)
      if (!row) return
      row.calls += 1
      row.inputTokens += finiteNonNegative(usage.inputTokens)
      row.outputTokens += finiteNonNegative(usage.outputTokens)
      row.cacheReadTokens += finiteNonNegative(usage.cacheReadTokens)
      row.cacheWriteTokens += finiteNonNegative(usage.cacheWriteTokens)
    },
    snapshot(sessionId) {
      const row = rows.get(String(sessionId ?? ''))
      return row ? toSummary([row]) : toSummary([])
    },
    summary(sessionIds) {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) return toSummary(rows.values())
      const seen = new Set<string>()
      const picked: MutableUsage[] = []
      for (const id of sessionIds) {
        const key = String(id ?? '')
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        const row = rows.get(key)
        if (row) picked.push(row)
      }
      return toSummary(picked)
    },
    clear() {
      rows.clear()
    },
    size() {
      return rows.size
    },
  }
}

export function cacheMeterEnabled(): boolean {
  const raw = String(process.env.DSH_WORKPLAN_CACHE_METER ?? '').trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off')
}

/**
 * 只读挂载 llm/stream 瀑布：包一层异步迭代器，透传所有块，只在 usage 块上记账。
 * 失败一律 fail-open（返回空 disposer）：计量不能影响模型调用。
 */
export function observeLlmStream(ctx: any, meter: LlmCacheMeter): () => void {
  try {
    if (!ctx || typeof ctx.on !== 'function' || !meter) return () => {}
    const dispose = ctx.on('llm/stream', (options: any, next: () => AsyncIterable<any>) => {
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : ''
      return (async function* () {
        // 惰性调用 next()：与宿主内建观察器一致，注册时不触发同步副作用。
        const stream = next()
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'usage' && chunk.usage) {
            try {
              meter.observe(sessionId, chunk.usage)
            } catch {
              // 记账失败不得中断模型流。
            }
          }
          yield chunk
        }
      })()
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // 卸载期失败不阻断宿主关闭。
      }
    }
  } catch {
    return () => {}
  }
}

/** 给模型可读面用的稳定一行（无数据时明确写 0，不编造命中）。 */
export function renderCacheSummary(summary: CacheUsageSummary): string {
  const percent = summary.cacheReadTokens > 0 ? `${Math.round(summary.hitRate * 1000) / 10}%` : '0%'
  return `KV前缀缓存：调用 ${summary.calls}｜输入 ${summary.inputTokens}｜缓存读 ${summary.cacheReadTokens}｜缓存写 ${summary.cacheWriteTokens}｜命中 ${percent}`
}
