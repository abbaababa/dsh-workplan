/**
 * [2.2.0][T3] 子→主「开工预告」通道（O-2a）：目标解析、可达性观测与失败留痕。
 *
 * 缺陷（2026-11-08 真实环境复现）：插件在部门子 Agent 的提示词里要求
 * `send_message（target: "lead"）` 报开工预告，但宿主工具契约的字段名是
 * `agent_id`，且 `"lead"` 不是任何会话 id。真实派发中的结果只有一句
 * `subagent "lead" is unavailable`——看起来像「通道坏了」，实际是「目标不存在」。
 * 三段各自的「合理」组合成结构性断链：
 *
 *   [0] 插件用 `delivery: 'caller'` 派发（src/runtime.ts executeSubtask）
 *   [1] 宿主只在 `spec.delivery !== "caller"` 时把父会话 id 追加进子提示词
 *       （host: dsh-subagent/lib/index.js:1466）
 *   [2] 插件却要求子 Agent 主动向 "lead" 回报（旧版 src/plan.ts 的 O-2a 段）
 *
 * 于是子 Agent 既不知道父会话 id，又被要求给父发消息，消息在目标解析阶段必然
 * 失败，并且失败原因被误读成「通道不可用」。修法只有一条：**由插件注入真实父会话
 * id**（`agent.id` / `session.id` / `plan.sessionId`），并让通道变成可观测的——
 * 消息到底有没有在父会话日志里落地，由插件自己去看，而不是信任任何自述。
 *
 * 本模块只做纯函数，不依赖 harness 服务，也不 import 其它插件模块（避免环）：
 *   - `resolveLeadAgentId`：解析要注入的父会话 id 及其来源（来源要能写进证据）；
 *   - `observeRelayedNotice`：在父会话事件日志里找「该子会话转达过来的消息」；
 *   - `createNoticeChannel` / `finaliseNoticeChannel`：状态行上的通道条目；
 *   - `validateNoticeChannel`：写入前的形状校验（applyStatus 单点入口用）；
 *   - `formatNoticeChannelLog`：失败日志（目标 / 调用方 / 时间戳 / 原因）。
 *
 * 安全边界（T5 会复核）：目标 id 由插件注入，子 Agent 无权改写；本模块不提供
 * 任何「按名字查会话」「任意 id 直发」的能力，所有可达性判断仍由宿主的
 * lineage 校验（`authorizeLineage`）决定。
 */

/** 日志里「目标缺失」的固定措辞（与提示词里的分支保持一致，便于 grep 复核）。 */
export const NOTICE_TARGET_MISSING_TEXT = '(未注入)'

/** 通道条目在状态行上的字段名。 */
export const NOTICE_CHANNEL_FIELD = 'noticeChannel'

/** 通道状态：等待观测 → 已观测 / 未观测。 */
export const NOTICE_CHANNEL_STATES = Object.freeze(['awaiting', 'observed', 'not-observed'] as const)

/** 未观测的原因码（写日志用，不允许自由文本冒充原因）。 */
export const NOTICE_CHANNEL_REASONS = Object.freeze([
  /** 父会话日志里已经出现该子会话转达的消息（正面结果）。 */
  'agent-message-relayed',
  /** 扫了父会话日志但没有该子会话的转达消息。 */
  'NOT_OBSERVED_IN_SESSION_LOG',
  /** 拿不到父会话对象（无法扫描），只能如实记录「无法观测」。 */
  'SESSION_UNAVAILABLE',
  /** 目标 id 没能解析出来，提示词走的是「禁止猜测」分支。 */
  'TARGET_NOT_INJECTED',
] as const)

export type NoticeChannelState = (typeof NOTICE_CHANNEL_STATES)[number]
export type NoticeChannelReason = (typeof NOTICE_CHANNEL_REASONS)[number]

/** 通道字段长度上限：状态行会进入模型可读面与 HTTP 载荷，不能让单条记录无限膨胀。 */
export const MAX_NOTICE_FIELD_CHARS = 200

/** JS Date 可表示的最大毫秒值（8.64e15）；超过它 `toISOString()` 会抛 RangeError。 */
export const MAX_NOTICE_TIMESTAMP = 8_640_000_000_000_000

export interface NoticeChannelEntry {
  /** 观测状态。 */
  state: NoticeChannelState
  /** 子 Agent 必须使用的目标会话 id；未注入时为 null（绝不编造）。 */
  target: string | null
  /** id 的来源，便于复核「这个 id 是哪来的」。 */
  targetSource: string
  /** 调用方（子会话 id）；派发前还拿不到时为 null。 */
  caller: string | null
  /** 通道建立时刻（派发时刻）。 */
  at: number
  /** 观测到转达消息的时刻；未观测为 null。 */
  observedAt: number | null
  /** 结果原因码。 */
  reason: NoticeChannelReason | null
}

/**
 * 读一个「像会话 id」的字符串。
 *
 * 不做格式白名单（宿主 id 前缀在版本间变过：根会话是 `session-<uuid>`，
 * 子会话是裸 uuid），只拒绝空白与非字符串——编造一个形状对但内容错的 id
 * 比留空更糟，因为子 Agent 会把错误归因到通道而不是目标。
 */
export function readLeadAgentId(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/**
 * 解析要注入子提示词的父会话 id。
 *
 * 优先级（每一级都必须能自证来源，写进 `targetSource`）：
 *   1. `agent.id` —— 宿主传入的活 Agent 身份，也是宿主 sendMessage 里
 *      `activation.parent.id === targetId` 比较的同一个值，等价性最高；
 *   2. `options.session.id` —— 本轮会话。
 *
 * [2.2.1][T5][F4] 原第 3 级 `record.plan.sessionId` 已删除：它只是「计划创建
 * 时落盘的会话 id」，在 fork / 重启后换会话 / 迁移时可能指向另一个 root 会话，
 * 把它当发送目标等于把子 Agent 的预告投到别人的会话（越权投递面）。计划正文
 * 是不可信输入，不能参与「发给谁」的决策；两级都拿不到时返回空串，调用方必须
 * 走「禁止猜测」分支，而不是拼一个 id。
 */
export function resolveLeadAgentId(input: { agent?: any; session?: any } = {}): { id: string; source: string } {
  const agentId = readLeadAgentId(input.agent?.id)
  if (agentId) return { id: agentId, source: 'agent.id' }
  const sessionId = readLeadAgentId(input.session?.id)
  if (sessionId) return { id: sessionId, source: 'session.id' }
  return { id: '', source: 'TARGET_NOT_INJECTED' }
}

/**
 * 从一条会话事件里读出「转达者会话 id」。
 *
 * 真实事件形状（2026-11-08 从父会话日志实采，seq 2006）：
 *   {"type":"agent/inbox/spliced","data":{"target":"next-step","inserted":[
 *      {"content":[...],"source":{"kind":"agent-message","form":"relay",
 *                                 "senderSessionId":"3759600a-…"}}]}}
 * 另外兼容宿主在投递落地后可能产生的 `user/message`（`data.message.source`
 * 或 `data.source` 上带同样的 source）。两处都认，避免把一次版本升级当成
 * 「通道又不通了」。
 */
export function relayedSenderId(event: any): string {
  if (!event || typeof event !== 'object') return ''
  const data = event.data
  if (Array.isArray(data?.inserted)) {
    for (const item of data.inserted) {
      const sender = readLeadAgentId(item?.source?.senderSessionId)
      if (sender && item?.source?.kind === 'agent-message') return sender
    }
  }
  if (data && typeof data === 'object') {
    const message = data.message ?? data
    const sender = readLeadAgentId(message?.source?.senderSessionId)
    if (sender && message?.source?.kind === 'agent-message') return sender
  }
  return ''
}

/**
 * 在父会话事件日志里找该子会话转达过来的消息（最新一条）。
 *
 * 只读、只回看：从日志尾部向前扫，遇到早于 `sinceMs` 的事件就停（消息不可能
 * 平白出现在派发之前），扫描条数另有上限，杜绝一次异常日志把派发线程拖住。
 *
 * @returns 命中时 `{at, seq, eventType}`，未命中返回 null。
 */
export function observeRelayedNotice(
  session: any,
  options: { childId?: unknown; sinceMs?: unknown; maxScan?: unknown } = {},
): { at: number; seq: number; eventType: string } | null {
  const childId = readLeadAgentId(options.childId)
  if (!childId) return null
  if (!session || typeof session.eventAt !== 'function') return null
  const total = Number(session.seq)
  if (!Number.isFinite(total) || total <= 0) return null
  const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : 0
  const maxScan = Number.isFinite(Number(options.maxScan)) ? Math.max(1, Math.floor(Number(options.maxScan))) : 3000
  const last = Math.min(Math.floor(total), 1_000_000) - 1
  let scanned = 0
  for (let seq = last; seq >= 0 && scanned < maxScan; seq -= 1) {
    const event = session.eventAt(seq)
    scanned += 1
    if (!event) continue
    const time = Number(event.time)
    if (sinceMs > 0 && Number.isFinite(time) && time > 0 && time < sinceMs) break
    if (relayedSenderId(event) !== childId) continue
    return { at: Number.isFinite(time) && time > 0 ? time : Date.now(), seq, eventType: String(event.type ?? '') }
  }
  return null
}

/** 派发时刻写下的初始通道条目（还不知道消息会不会来）。 */
export function createNoticeChannel(input: {
  target?: unknown
  targetSource?: unknown
  caller?: unknown
  at?: unknown
}): NoticeChannelEntry {
  const target = readLeadAgentId(input.target)
  const at = Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now()
  return {
    state: 'awaiting',
    target: target || null,
    targetSource: typeof input.targetSource === 'string' && input.targetSource ? input.targetSource : 'none',
    caller: readLeadAgentId(input.caller) || null,
    at,
    observedAt: null,
    reason: target ? null : 'TARGET_NOT_INJECTED',
  }
}

/**
 * 结算时把通道条目收束成「已观测 / 未观测」。
 *
 * `observed` 只来自父会话日志的实证（`observeRelayedNotice`）；拿不到会话对象
 * 时写 `SESSION_UNAVAILABLE`，绝不用「没看到」冒充「没有发」。
 */
export function finaliseNoticeChannel(
  current: any,
  outcome: { observed?: boolean; observedAt?: unknown; sessionAvailable?: boolean; now?: unknown } = {},
): NoticeChannelEntry {
  const base = createNoticeChannel({
    target: current?.target,
    targetSource: current?.targetSource,
    caller: current?.caller,
    at: current?.at,
  })
  const now = Number.isFinite(Number(outcome.now)) ? Number(outcome.now) : Date.now()
  if (outcome.sessionAvailable !== true) {
    return { ...base, state: 'not-observed', observedAt: null, reason: 'SESSION_UNAVAILABLE' }
  }
  if (outcome.observed === true) {
    const observedAt = Number.isFinite(Number(outcome.observedAt)) ? Number(outcome.observedAt) : now
    return { ...base, state: 'observed', observedAt, reason: 'agent-message-relayed' }
  }
  return {
    ...base,
    state: 'not-observed',
    observedAt: null,
    reason: base.target ? 'NOT_OBSERVED_IN_SESSION_LOG' : 'TARGET_NOT_INJECTED',
  }
}

/** 写入前的形状校验：未知状态/原因一律拒绝，避免脏值悄悄进状态行。 */
export function validateNoticeChannel(value: unknown): { ok: true; value: NoticeChannelEntry } | { ok: false; error: string; value?: undefined } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'noticeChannel 必须是对象' }
  }
  const source: any = value
  if (!NOTICE_CHANNEL_STATES.includes(source.state)) {
    return { ok: false, error: `noticeChannel.state 必须是 ${NOTICE_CHANNEL_STATES.join(' / ')}：${String(source.state)}` }
  }
  const target = source.target === null ? '' : readLeadAgentId(source.target)
  if (source.target !== null && source.target !== undefined && !target) {
    return { ok: false, error: 'noticeChannel.target 必须是非空字符串或 null' }
  }
  if (source.reason !== null && source.reason !== undefined && !NOTICE_CHANNEL_REASONS.includes(source.reason)) {
    return { ok: false, error: `noticeChannel.reason 非法：${String(source.reason)}` }
  }
  const at = Number(source.at)
  if (!Number.isFinite(at) || at <= 0) return { ok: false, error: 'noticeChannel.at 必须是正数毫秒时间戳' }
  const observedAt = source.observedAt === null || source.observedAt === undefined ? null : Number(source.observedAt)
  if (observedAt !== null && (!Number.isFinite(observedAt) || observedAt <= 0)) {
    return { ok: false, error: 'noticeChannel.observedAt 必须是正数毫秒时间戳或 null' }
  }
  if (at > MAX_NOTICE_TIMESTAMP) {
    return { ok: false, error: 'noticeChannel.at 超出可表示范围' }
  }
  if (observedAt !== null && observedAt > MAX_NOTICE_TIMESTAMP) {
    return { ok: false, error: 'noticeChannel.observedAt 超出可表示范围' }
  }
  if (target && target.length > MAX_NOTICE_FIELD_CHARS) {
    return { ok: false, error: `noticeChannel.target 超过 ${MAX_NOTICE_FIELD_CHARS} 字符` }
  }
  const reason = source.reason ?? null
  const state = source.state as NoticeChannelState
  /*
   * 跨字段一致性（F2）：状态、原因码与观测时间必须能互相解释，不允许
   * 「observed 但没有到达时间」「awaiting 却已有 observedAt」这类自相矛盾记录。
   * 这里 fail-closed：拒绝比展示一条自相矛盾的证据更安全。
   */
  if (state === 'observed') {
    if (reason !== 'agent-message-relayed' || observedAt === null || observedAt <= 0) {
      return { ok: false, error: 'noticeChannel: state=observed 必须 reason=agent-message-relayed 且 observedAt>0' }
    }
  } else if (state === 'awaiting') {
    if (observedAt !== null || (reason !== null && reason !== 'TARGET_NOT_INJECTED')) {
      return { ok: false, error: 'noticeChannel: state=awaiting 不得带 observedAt，reason 只能是 null/TARGET_NOT_INJECTED' }
    }
  } else if (state === 'not-observed') {
    if (observedAt !== null) {
      return { ok: false, error: 'noticeChannel: state=not-observed 不得带 observedAt' }
    }
    if (!['NOT_OBSERVED_IN_SESSION_LOG', 'SESSION_UNAVAILABLE', 'TARGET_NOT_INJECTED'].includes(String(reason))) {
      return { ok: false, error: 'noticeChannel: state=not-observed 的 reason 非法' }
    }
  }
  return {
    ok: true,
    value: {
      state,
      target: target || null,
      targetSource: typeof source.targetSource === 'string' ? source.targetSource.slice(0, MAX_NOTICE_FIELD_CHARS) : 'none',
      caller: readLeadAgentId(source.caller) ? readLeadAgentId(source.caller).slice(0, MAX_NOTICE_FIELD_CHARS) : null,
      at,
      observedAt,
      reason,
    },
  }
}

/**
 * 通道失败日志：目标 / 调用方 / 时间戳 / 原因，四项缺一不可。
 *
 * 这条日志是「不静默丢失」的可复核凭据：主 Agent 读计划记录时能直接看到
 * 该子任务的预告到底有没有到、到不了是哪种原因，而不是只看到一句
 * `subagent "lead" is unavailable` 便无从下手。
 */
export function formatNoticeChannelLog(input: {
  subtaskId?: unknown
  target?: unknown
  caller?: unknown
  at?: unknown
  reason?: unknown
}): string {
  const subtaskId = typeof input.subtaskId === 'string' && input.subtaskId ? input.subtaskId : '?'
  const target = readLeadAgentId(input.target) || NOTICE_TARGET_MISSING_TEXT
  const caller = readLeadAgentId(input.caller) || 'pending-child'
  const rawAt = Number.isFinite(Number(input.at)) && Number(input.at) > 0 ? Number(input.at) : Date.now()
  // 超出 Date 可表示范围的值直接回退当前时间，避免日志函数自己抛 RangeError。
  const at = rawAt <= MAX_NOTICE_TIMESTAMP ? rawAt : Date.now()
  const reason = typeof input.reason === 'string' && input.reason ? input.reason : 'NOT_OBSERVED_IN_SESSION_LOG'
  return `${subtaskId} noticeChannel: target=${target} caller=${caller} at=${new Date(at).toISOString()} reason=${reason}`
}

/**
 * 提示词里要子 Agent 照抄的调用形式。
 *
 * **唯一来源**：提示词正文、回归测试断言、人工复核都从这里取，避免三处各写
 * 一遍后再次漂移（本次缺陷就是「提示词写的调用形式」与「宿主 schema」漂移）。
 */
export function leadNoticeCallForm(leadAgentId: string): string {
  const id = readLeadAgentId(leadAgentId)
  return id
    ? `send_message({ agent_id: ${JSON.stringify(id)}, message: "…" })`
    : 'send_message({ agent_id: "<父会话 ID：本提示词未注入>", message: "…" })'
}
