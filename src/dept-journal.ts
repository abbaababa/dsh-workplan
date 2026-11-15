/**
 * [2.5.4][T5] 部门消息留痕（journal）——用户决策 D5/D6 的持久化底座。
 *
 * 唯一权威契约：_t5_channel_20261112/00-contract-v1.md（FROZEN，T5 负责人冻结）。
 * 本文件严格实现契约 §1 消息结构与 §2 冻结导出；其他人只 import 不改。
 * 任何字段/语义变更必须经 T5 负责人重新冻结，不得私改。
 *
 * 设计纪律（契约 §2/§6）：
 *   - 纯函数 + 同步 fs，不依赖 harness 服务，不 import runtime/plan（避免环）；
 *     落盘模式参照 src/lessons.ts（JSONL 追加写、容错读取、坏行不静默吞）。
 *   - fail-closed：未知 kind/role、缺字段、超限一律拒（validateDeptMessage）。
 *   - 一切失败显式返回（JOURNAL_WRITE_FAILED / JOURNAL_READ_FAILED），绝不静默；
 *     planId 只允许 [A-Za-z0-9_-]{1,120}，非法抛 INVALID_PLAN_ID（防路径穿越）。
 *   - 目录 env DSH_WORKPLAN_JOURNAL_DIR || ~/.dsh/workplan/journal；文件 <planId>.jsonl。
 *   - 本模块只负责留痕的写/读/校验，不做任何投递与状态判定（路由归 runtime.ts，
 *     由 channel-expert 按契约 §3 实现）。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 接口版本（契约 §1：字面量 1）。 */
export const DEPT_MESSAGE_VERSION = 1

export type DeptRole = 'root' | 'head' | 'expert' | 'member'
export type DeptKind =
  | 'dispatch'
  | 'instruction'
  | 'escalation'
  | 'estimate'
  | 'completion'
  | 'need'
  | 'receipt'

/** 7 种关键沟通（frozen 数组，契约 §1/§2；日常闲聊不属于任何 kind，不入库）。 */
export const DEPT_MESSAGE_KINDS: readonly DeptKind[] = Object.freeze([
  'dispatch',
  'instruction',
  'escalation',
  'estimate',
  'completion',
  'need',
  'receipt',
])

/**
 * 角色枚举（frozen 数组，契约 §1/§2）。
 *
 * [3.0.0][用户要求 9] 部门组员角色已取消：新写入只使用 root/head/expert。
 * `member` 保留在枚举里仅用于**读取历史 journal**（append-only 历史记录不可
 * 追溯改写，拒绝读取会让旧会话的回放直接失败）；现有代码不再产生该值。
 */
export const DEPT_ROLES: readonly DeptRole[] = Object.freeze([
  'root',
  'head',
  'expert',
  'member',
])

export interface DeptEndpoint {
  sessionId: string
  role: DeptRole
  /** expert/member 必填成员名；root/head 可选。 */
  member?: string
}

export interface DeptDelivery {
  status: 'sent' | 'failed'
  messageId?: string
  code?: string
  error?: string
  latencyMs?: number
}

export interface DeptMessage {
  /** 接口版本，字面量 1。 */
  v: 1
  /** makeDeptMessageId() 生成，形如 msg-<ts36>-<rand6>，≤80 字符。 */
  id: string
  /** 创建时刻 epoch ms，>0 且 ≤8.64e15。 */
  ts: number
  /** 非空，≤120。 */
  planId: string
  /** 部门负责人所在计划行 ID（如 T5）；root↔head 消息同样用 head 行 ID。 */
  subtaskId: string
  kind: DeptKind
  from: DeptEndpoint
  to: DeptEndpoint
  /** 人类可读正文 ≤4000 字符，清洗控制字符。 */
  body: string
  /** kind 专属结构化载荷（JSON ≤4000 字符），语义见契约 §1/§5。 */
  data?: Record<string, unknown>
  delivery: DeptDelivery
}

/* —— 契约 §1 的边界常量（私有；数值全部来自冻结契约，不得私改） —— */
const MAX_ID_CHARS = 80
const MAX_TS = 8.64e15
const MAX_PLAN_ID_CHARS = 120
/** subtaskId 契约未给上限；取与 planId 同宽的防御边界（行 ID 形如 T5/R1-2，远小于此）。 */
const MAX_SUBTASK_ID_CHARS = 120
const MAX_SESSION_ID_CHARS = 200
const MAX_MEMBER_CHARS = 80
const MAX_BODY_CHARS = 4000
const MAX_DATA_JSON_CHARS = 4000
const MAX_DELIVERY_MESSAGE_ID_CHARS = 200
const MAX_DELIVERY_CODE_CHARS = 80
const MAX_DELIVERY_ERROR_CHARS = 4000
const DEFAULT_READ_LIMIT = 500
const MAX_READ_LIMIT = 5000
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 与 lessons.ts 同口径：去掉不可见控制字符，保留 \t \n \r。 */
function cleanBody(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 500)
}

function isNonEmptyString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars
}

/**
 * 生成消息 id：msg-<ts36>-<rand6>（契约 §1）。
 * now 非法（缺省/非有限/越界）时回退 Date.now()；总长恒 ≤80。
 */
export function makeDeptMessageId(now?: number): string {
  const ts = typeof now === 'number' && Number.isFinite(now) && now > 0 && now <= MAX_TS
    ? Math.floor(now)
    : Date.now()
  return `msg-${ts.toString(36)}-${randomBytes(3).toString('hex')}`
}

function validateEndpoint(value: unknown, label: string): DeptEndpoint | string {
  if (!isRecord(value)) return `${label} 必须是对象`
  const sessionId = value.sessionId
  if (!isNonEmptyString(sessionId, MAX_SESSION_ID_CHARS)) {
    return `${label}.sessionId 必填且 ≤${MAX_SESSION_ID_CHARS} 字符`
  }
  const role = value.role
  if (typeof role !== 'string' || !DEPT_ROLES.includes(role as DeptRole)) {
    return `${label}.role 非法（期望 ${DEPT_ROLES.join('/')}）`
  }
  const member = value.member
  const needsMember = role === 'expert' || role === 'member'
  if (needsMember && !isNonEmptyString(member, MAX_MEMBER_CHARS)) {
    return `${label}.member 必填（expert/member 角色）且 ≤${MAX_MEMBER_CHARS} 字符`
  }
  if (member !== undefined && !isNonEmptyString(member, MAX_MEMBER_CHARS)) {
    return `${label}.member 若提供必须非空且 ≤${MAX_MEMBER_CHARS} 字符`
  }
  const endpoint: DeptEndpoint = { sessionId, role: role as DeptRole }
  if (member !== undefined) endpoint.member = member as string
  return endpoint
}

function validateDelivery(value: unknown): DeptDelivery | string {
  if (!isRecord(value)) return 'delivery 必须是对象'
  const status = value.status
  if (status !== 'sent' && status !== 'failed') {
    return 'delivery.status 非法（期望 sent/failed）'
  }
  const delivery: DeptDelivery = { status }
  if (value.messageId !== undefined) {
    if (!isNonEmptyString(value.messageId, MAX_DELIVERY_MESSAGE_ID_CHARS)) {
      return `delivery.messageId 若提供必须非空且 ≤${MAX_DELIVERY_MESSAGE_ID_CHARS} 字符`
    }
    delivery.messageId = value.messageId
  }
  if (value.code !== undefined) {
    if (!isNonEmptyString(value.code, MAX_DELIVERY_CODE_CHARS)) {
      return `delivery.code 若提供必须非空且 ≤${MAX_DELIVERY_CODE_CHARS} 字符`
    }
    delivery.code = value.code
  }
  if (value.error !== undefined) {
    if (typeof value.error !== 'string' || value.error.length > MAX_DELIVERY_ERROR_CHARS) {
      return `delivery.error 若提供必须是字符串且 ≤${MAX_DELIVERY_ERROR_CHARS} 字符`
    }
    delivery.error = value.error
  }
  if (value.latencyMs !== undefined) {
    if (typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) {
      return 'delivery.latencyMs 若提供必须是 ≥0 的有限数字'
    }
    delivery.latencyMs = value.latencyMs
  }
  return delivery
}

/**
 * 契约 §2 的唯一校验入口（fail-closed）：未知 kind/role、缺字段、超限一律拒。
 * 通过时返回白名单归一化后的 DeptMessage（body 已清洗控制字符）。
 */
export function validateDeptMessage(
  value: unknown,
): { ok: true; value: DeptMessage } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error: `INVALID_MESSAGE: ${error}` })
  if (!isRecord(value)) return fail('消息必须是对象')
  if (value.v !== DEPT_MESSAGE_VERSION) return fail(`v 必须为 ${DEPT_MESSAGE_VERSION}`)
  if (!isNonEmptyString(value.id, MAX_ID_CHARS)) return fail(`id 必填且 ≤${MAX_ID_CHARS} 字符`)
  const ts = value.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0 || ts > MAX_TS) {
    return fail('ts 必须是 >0 且 ≤8.64e15 的有限 epoch ms')
  }
  if (!isNonEmptyString(value.planId, MAX_PLAN_ID_CHARS)) {
    return fail(`planId 必填且 ≤${MAX_PLAN_ID_CHARS} 字符`)
  }
  if (!isNonEmptyString(value.subtaskId, MAX_SUBTASK_ID_CHARS)) {
    return fail(`subtaskId 必填且 ≤${MAX_SUBTASK_ID_CHARS} 字符`)
  }
  const kind = value.kind
  if (typeof kind !== 'string' || !DEPT_MESSAGE_KINDS.includes(kind as DeptKind)) {
    return fail(`kind 非法（期望 ${DEPT_MESSAGE_KINDS.join('/')}）`)
  }
  const from = validateEndpoint(value.from, 'from')
  if (typeof from === 'string') return fail(from)
  const to = validateEndpoint(value.to, 'to')
  if (typeof to === 'string') return fail(to)
  if (typeof value.body !== 'string') return fail('body 必须是字符串')
  if (value.body.length > MAX_BODY_CHARS) return fail(`body 超限（≤${MAX_BODY_CHARS} 字符）`)
  const body = cleanBody(value.body)
  let data: Record<string, unknown> | undefined
  if (value.data !== undefined) {
    if (!isRecord(value.data)) return fail('data 若提供必须是对象')
    let json: string
    try {
      json = JSON.stringify(value.data)
    } catch {
      return fail('data 必须可 JSON 序列化')
    }
    if (typeof json !== 'string' || json.length > MAX_DATA_JSON_CHARS) {
      return fail(`data JSON 超限（≤${MAX_DATA_JSON_CHARS} 字符）`)
    }
    data = value.data
  }
  const delivery = validateDelivery(value.delivery)
  if (typeof delivery === 'string') return fail(delivery)
  const message: DeptMessage = {
    v: DEPT_MESSAGE_VERSION,
    id: value.id,
    ts,
    planId: value.planId,
    subtaskId: value.subtaskId,
    kind: kind as DeptKind,
    from,
    to,
    body,
    delivery,
  }
  if (data !== undefined) message.data = data
  return { ok: true, value: message }
}

/** 留痕目录：env DSH_WORKPLAN_JOURNAL_DIR || ~/.dsh/workplan/journal（契约 §2）。 */
function resolveJournalDir(): string {
  const override = typeof process.env.DSH_WORKPLAN_JOURNAL_DIR === 'string'
    ? process.env.DSH_WORKPLAN_JOURNAL_DIR.trim()
    : ''
  if (override) return override
  return join(homedir(), '.dsh', 'workplan', 'journal')
}

/**
 * 留痕文件路径：<目录>/<planId>.jsonl。
 * planId 只允许 [A-Za-z0-9_-]{1,120}；非法抛显式错误 INVALID_PLAN_ID（防路径穿越）。
 */
export function deptJournalPath(planId: string): string {
  if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) {
    throw new Error(
      `INVALID_PLAN_ID: planId 只允许 [A-Za-z0-9_-]{1,120}，收到 ${JSON.stringify(String(planId)).slice(0, 100)}`,
    )
  }
  return join(resolveJournalDir(), `${planId}.jsonl`)
}

/**
 * 追加一条留痕（契约 §2）：先 validate，再 mkdirSync(recursive)+appendFileSync。
 * 任何失败（校验不过 / planId 非法 / 写盘失败）显式返回 JOURNAL_WRITE_FAILED，绝不静默。
 */
export function appendDeptMessage(
  msg: unknown,
): { ok: true; path: string } | { ok: false; code: 'JOURNAL_WRITE_FAILED'; error: string } {
  const verdict = validateDeptMessage(msg)
  if (!verdict.ok) return { ok: false, code: 'JOURNAL_WRITE_FAILED', error: verdict.error }
  let path: string
  try {
    path = deptJournalPath(verdict.value.planId)
  } catch (error) {
    return { ok: false, code: 'JOURNAL_WRITE_FAILED', error: errorText(error) }
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(verdict.value)}\n`, 'utf8')
  } catch (error) {
    return { ok: false, code: 'JOURNAL_WRITE_FAILED', error: errorText(error) }
  }
  return { ok: true, path }
}

export interface DeptReadFilter {
  kind?: DeptKind
  since?: number
  limit?: number
}

/**
 * 按追加序回放留痕（契约 §2）：
 *   - 文件不存在 → 空列表（ok:true）；
 *   - 坏行（JSON 损坏或校验不过）计入 skipped，不静默吞；
 *   - kind/since 过滤后按 limit 截取：默认 500、上限 5000；
 *   - planId 非法或读盘失败 → 显式 JOURNAL_READ_FAILED。
 */
export function readDeptMessages(
  planId: string,
  filter?: DeptReadFilter,
):
  | { ok: true; messages: DeptMessage[]; skipped: number }
  | { ok: false; code: 'JOURNAL_READ_FAILED'; error: string } {
  let path: string
  try {
    path = deptJournalPath(planId)
  } catch (error) {
    return { ok: false, code: 'JOURNAL_READ_FAILED', error: errorText(error) }
  }
  if (!existsSync(path)) return { ok: true, messages: [], skipped: 0 }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, code: 'JOURNAL_READ_FAILED', error: errorText(error) }
  }
  const kind = filter?.kind
  const since = typeof filter?.since === 'number' && Number.isFinite(filter.since)
    ? filter.since
    : null
  const rawLimit = Number(filter?.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_READ_LIMIT)
    : DEFAULT_READ_LIMIT
  const matched: DeptMessage[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      skipped += 1
      continue
    }
    const verdict = validateDeptMessage(parsed)
    if (!verdict.ok) {
      skipped += 1
      continue
    }
    const message = verdict.value
    if (kind !== undefined && message.kind !== kind) continue
    if (since !== null && message.ts < since) continue
    matched.push(message)
  }
  return { ok: true, messages: matched.slice(0, limit), skipped }
}
