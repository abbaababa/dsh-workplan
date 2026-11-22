/**
 * [3.0.6][第 3 批②] dsh-workplan 专用通知台账（notice ledger）。
 *
 * 审计病根：插件通知唯一的持久可见通道是 user/message，与用户真实输入混在同
 * 一条事件流里（source.kind 虽可区分，但没有任何插件侧权威台账可供工具/前端
 * 直接消费）。
 *
 * 官方约束（dsh-agent-preset/skills/dsh-doc/references/practices.md:21）：
 *  1. 禁止给 Session 新增自定义事件类型——live Session.append 无法打
 *     ignorable 标记，重启后 Session 会拒绝重新打开；
 *  2. appendPluginRecord() 保留给 DSH 实验包，本插件不得使用；
 *  3. 插件自有数据应放在插件自己的存储里。
 *
 * 因此 v1 专用通道 = 插件自有 JSONL 台账（默认 ~/.dsh/workplan/notices.jsonl，
 * 可用 DSH_WORKPLAN_NOTICES_FILE 覆盖）：
 *  - appendUserMessage 每次成功落盘一条 workplan 通知后，同步追加一行台账；
 *  - 台账行自带 sessionId/planId/kind/form/summary/text，是机器可读的权威
 *    通知流（区别于用户真实输入——真实输入永远不会进本文件）；
 *  - 写入失败不拖垮通知投递（user/message 才是模型的权威通道，且已通过
 *    回读校验）：失败行进内存环形缓冲，下一次写入时先行补落，尽最大努力
 *    不丢、且绝不静默。
 *
 * 纪律与 lessons.ts（第 1 批）一致：同步读写、整行 JSON、坏行读端跳过/写端
 * 原样保留。审计证据默认永久保留，不做轮转（与 journalRetentionDays 默认 0
 * 的裁决一致）。
 *
 * [复审修复][第 4 批] 治理与安全加固：
 *  - 行数上限 NOTICE_LEDGER_MAX_LINES（默认 5000，可被正整数环境变量
 *    DSH_WORKPLAN_NOTICES_MAX_LINES 覆盖）：超限即重写为「最新 N 行」
 *    （读全 → 取末 N → tmp+rename 原子替换），重写失败 best-effort 不拖垮写入；
 *  - 权限：目录 0o700、文件 0o600（新建以 mode 落盘、既有文件 best-effort chmod）；
 *  - 防符号链接投毒：写/重写前 lstatSync 目标文件，是符号链接则跳过写入并
 *    console.warn（不抛错），绝不跟随链接写任意路径。
 */
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const NOTICE_LEDGER_VERSION = 1
/** 写失败时的内存环形缓冲上限（尽最大努力补落，绝不清空丢弃）。 */
export const NOTICE_LEDGER_OVERFLOW_MAX = 100
/** 台账行数上限：超过即重写为「最新 N 行」。可被 DSH_WORKPLAN_NOTICES_MAX_LINES（正整数）覆盖。 */
export const NOTICE_LEDGER_MAX_LINES = 5000

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 500)
}

/** 解析行数上限（env 优先，沿用 resolveNoticeLedgerFile 的解析风格）。 */
function resolveNoticeLedgerMaxLines(env: NodeJS.ProcessEnv = process.env): number {
  const raw = typeof env?.DSH_WORKPLAN_NOTICES_MAX_LINES === 'string'
    ? env.DSH_WORKPLAN_NOTICES_MAX_LINES.trim()
    : ''
  if (!raw) return NOTICE_LEDGER_MAX_LINES
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NOTICE_LEDGER_MAX_LINES
}

/** 统计文本中的行数（按换行计；本模块写盘恒以 \n 结尾，行数 == \n 数）。 */
function countNewlines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}

/**
 * 行数治理：写后若总行数超过上限，重写为「最新 N 行」。
 * 全程 best-effort：任何失败只 console.warn，绝不抛错、绝不拖垮已成功的写入。
 */
function enforceNoticeLedgerCap(file: string, maxLines: number): void {
  if (!Number.isSafeInteger(maxLines) || maxLines <= 0) return
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    console.warn(`dsh-workplan: notice 台账行数统计失败（不重写）file=${file}（${errorText(error)}）`)
    return
  }
  const total = countNewlines(text)
  if (total <= maxLines) return
  // 防符号链接投毒：重写前再确认目标是普通文件（TOCTOU 缩小面；rename 只换链接本身也不跟随，但按纪律跳过）。
  try {
    if (lstatSync(file).isSymbolicLink()) {
      console.warn(`dsh-workplan: notice 台账是符号链接，跳过重写 file=${file}`)
      return
    }
  } catch (error) {
    console.warn(`dsh-workplan: notice 台账重写前 lstat 失败（不重写）file=${file}（${errorText(error)}）`)
    return
  }
  const kept = text.split('\n').filter((line) => line.trim() !== '').slice(-maxLines)
  const body = kept.length > 0 ? `${kept.join('\n')}\n` : ''
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    console.warn(`dsh-workplan: notice 台账超限重写失败（保留原文件）file=${file}（${errorText(error)}）`)
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件清理失败可忽略。 */
    }
  }
}

export type NoticeLedgerRecord = {
  version: number
  at: number
  sessionId: string
  planId: string
  kind: string
  form: string
  summary: string
  text: string
  /** 对应的 user/message 事件 seq（写入时未知则为 -1）。 */
  surfaceSeq: number
  /**
   * [3.1.7][P1 U-43] 台账写前日志（additive 可选键）：缓冲中的 workplan-update
   * 在进内存缓冲的**同一时刻**就把 durable 载荷同步落到插件自有 JSONL，崩溃/
   * 重启窗口内不再只活在内存里。回放侧按 planId+subtaskId+revision 单调消费，
   * 与 user/message 通道互为兜底（同一条更新两边都有时只前进一次）。
   * 旧台账行没有该键，读端零迁移。
   */
  durable?: Record<string, unknown>
}

/** 台账文件位置：默认用户主目录，跨项目保留；测试可用环境变量覆盖。 */
export function resolveNoticeLedgerFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = typeof env?.DSH_WORKPLAN_NOTICES_FILE === 'string'
    ? env.DSH_WORKPLAN_NOTICES_FILE.trim()
    : ''
  if (override) return override
  return join(homedir(), '.dsh', 'workplan', 'notices.jsonl')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function coerceRecord(raw: unknown): NoticeLedgerRecord | null {
  if (!isRecord(raw)) return null
  return {
    version: Number(raw.version) || NOTICE_LEDGER_VERSION,
    at: Number(raw.at) || 0,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    planId: typeof raw.planId === 'string' ? raw.planId : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    form: typeof raw.form === 'string' ? raw.form : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    surfaceSeq: Number.isSafeInteger(Number(raw.surfaceSeq)) ? Number(raw.surfaceSeq) : -1,
    // [3.1.7][P1 U-43] additive 可选键：旧行没有 durable，读端零迁移。
    ...(isRecord(raw.durable) ? { durable: raw.durable } : {}),
  }
}

/** 读端：坏行跳过不拖垮整份台账。 */
export function readNoticeLedger(file: string = resolveNoticeLedgerFile()): NoticeLedgerRecord[] {
  if (!existsSync(file)) return []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: NoticeLedgerRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = coerceRecord(JSON.parse(trimmed))
      if (parsed) out.push(parsed)
    } catch {
      // 单行损坏跳过：append-only 文件不做重写，坏行原样留在盘上。
    }
  }
  return out
}

/** 内存补落缓冲：文件写入失败时暂存，下一次写入先行补落。 */
let overflow: string[] = []

/** 取出当前积压的补落行数（可观测性/测试用）。 */
export function noticeLedgerOverflowSize(): number {
  return overflow.length
}

function textOfMessage(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 追加一行通知台账（同步、尽力而为）。
 *
 * @returns 是否写入（含补落）成功；失败行留在内存环形缓冲等待下次补落。
 */
export function appendNoticeLedger(
  sessionId: string,
  message: any,
  file: string = resolveNoticeLedgerFile(),
  now: number = Date.now(),
): boolean {
  const source = isRecord(message?.source) ? message.source : {}
  const record: NoticeLedgerRecord = {
    version: NOTICE_LEDGER_VERSION,
    at: now,
    sessionId: String(sessionId ?? ''),
    planId: typeof source.planId === 'string' ? source.planId
      : (typeof message?.planId === 'string' ? message.planId : ''),
    kind: typeof source.kind === 'string' ? source.kind : 'workplan',
    form: typeof source.form === 'string' ? source.form : 'notice',
    summary: typeof source.summary === 'string' ? source.summary : '',
    text: textOfMessage(message),
    surfaceSeq: typeof message?.seq === 'number' ? message.seq : -1,
    // [3.1.7][P1 U-43] 写前日志：durable 载荷随行落盘（缓冲中的台账更新由此
    // 获得崩溃窗口内的持久副本；回放侧单调消费，绝不重复前进）。
    ...(isRecord(source.durable) ? { durable: source.durable } : {}),
  }
  return flushNoticeLedger(file, [JSON.stringify(record)])
}

/**
 * [3.1.7][P1 U-43] 台账写前日志专用入口：把一条**尚未落 user/message** 的
 * workplan-update durable 载荷同步写进插件自有 JSONL。与 appendNoticeLedger
 * 共用同一文件/权限/防链接/行数治理/失败补落纪律；失败只返回 false（调用方
 * 的内存缓冲仍在，user/message 通道随后兜底），绝不抛错拖垮派发。
 */
export function appendWorkplanUpdateWAL(
  sessionId: string,
  durable: Record<string, unknown>,
  file: string = resolveNoticeLedgerFile(),
  now: number = Date.now(),
): string | null {
  if (!isRecord(durable) || durable.kind !== 'workplan-update') return null
  const walId = `wal-${now}-${Math.random().toString(36).slice(2, 10)}`
  const record: NoticeLedgerRecord = {
    version: NOTICE_LEDGER_VERSION,
    at: now,
    sessionId: String(sessionId ?? ''),
    planId: typeof durable.planId === 'string' ? durable.planId : '',
    kind: 'workplan-update',
    form: 'wal',
    summary: '',
    text: '',
    surfaceSeq: -1,
    durable: { ...durable, walId },
  }
  return flushNoticeLedger(file, [JSON.stringify(record)]) ? walId : null
}

/**
 * [3.1.7][P1 U-43] WAL 确认标记：合并归档真正落 user/message 后，把本批每条
 * 更新的 walId 写成一条 form='wal-ack' 行。回放侧只消费**没有对应 ack** 的
 * wal 行——即「缓冲了但没落盘就崩溃」的更新。ack 与 wal 同文件同纪律；
 * 失败只返回 false（最坏情况是回放多补一次同 revision 的改判，单调闸仍守门）。
 */
export function appendWorkplanUpdateWALAck(
  sessionId: string,
  planId: string,
  walIds: string[],
  file: string = resolveNoticeLedgerFile(),
  now: number = Date.now(),
): boolean {
  const ids = (Array.isArray(walIds) ? walIds : []).filter((id) => typeof id === 'string' && id !== '')
  if (ids.length === 0) return true
  const record: NoticeLedgerRecord = {
    version: NOTICE_LEDGER_VERSION,
    at: now,
    sessionId: String(sessionId ?? ''),
    planId: String(planId ?? ''),
    kind: 'workplan-update',
    form: 'wal-ack',
    summary: '',
    text: '',
    surfaceSeq: -1,
    durable: { kind: 'workplan-update-wal-ack', planId: String(planId ?? ''), walIds: ids, at: now },
  }
  return flushNoticeLedger(file, [JSON.stringify(record)])
}

/** 先补落积压行，再写新行；全部成功才清空缓冲。 */
function flushNoticeLedger(file: string, freshLines: string[]): boolean {
  const pending = [...overflow, ...freshLines]
  // 防符号链接投毒：目标是符号链接则跳过写入并告警（不抛错，行留缓冲等待下次）。
  try {
    if (lstatSync(file).isSymbolicLink()) {
      console.warn(`dsh-workplan: notice 台账目标是符号链接，跳过写入 file=${file}`)
      overflow = pending.slice(-NOTICE_LEDGER_OVERFLOW_MAX)
      return false
    }
  } catch {
    /* 文件不存在（ENOENT，首写）或 lstat 失败：交给 appendFileSync 显式成败。 */
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, `${pending.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      // 既有文件权限收紧为 0o600（best-effort；新建文件已由 mode 覆盖）。
      chmodSync(file, 0o600)
    } catch {
      /* best-effort：权限收紧失败不阻断追加。 */
    }
    overflow = []
    // 行数治理（best-effort）：超限即重写为「最新 N 行」，失败只 warn 不拖垮写入。
    enforceNoticeLedgerCap(file, resolveNoticeLedgerMaxLines())
    return true
  } catch {
    overflow = pending.slice(-NOTICE_LEDGER_OVERFLOW_MAX)
    return false
  }
}
