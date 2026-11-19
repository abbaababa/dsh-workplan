/**
 * [3.0.0] 用户 2026-11-14 十三条底层机制优化中「可由代码判定」的那部分契约。
 *
 * 单一事实源：两条会话固定文案、部门任务质量要求、极简任务硬门槛、专家精简
 * JSON 汇报、部门负责人精简 JSON 汇总。渲染函数与校验函数同源，保证提示词里
 * 写的规则与门禁实际执行的规则不可能分叉（与 2.x 的 comm-format / three-phase、
 * 3.0.8 的 five-step 同一哲学）。
 *
 * 纯函数、零依赖（不 import plan.ts，避免循环依赖），可被 host/plan/runtime/
 * llm-rules 与测试同口径消费。
 */

/* ========================================================================== */
/* 1. 两条会话固定文案（用户要求 2、4）                                        */
/* ========================================================================== */

/**
 * 用户要求 2 的固定文案：从接收到用户任何任务开始，会话内必须输出这一句。
 * 逐字冻结（含 6 个半角点），不得改写、不得拼接。
 */
export const STATUS_ASSIGNING_TEXT = '任务正在分配中，请稍等一下......'

/**
 * 用户要求 4 的固定文案：用户任务分配完成后，会话内必须输出这一句。
 * 逐字冻结（含 6 个半角点），不得改写、不得拼接。
 */
export const STATUS_ASSIGNED_TEXT = '任务已经完成分配，正在执行中......'

/* ========================================================================== */
/* 2. 部门任务质量要求（用户要求 3、6）                                        */
/* ========================================================================== */

/** 单个子任务质量要求的条数上限（多则失控，与「精简」冲突）。 */
export const MAX_QUALITY_REQUIREMENTS = 8
/** 单条质量要求的字符上限。 */
export const MAX_QUALITY_REQUIREMENT_CHARS = 400
/** 质量要求的最少条数：至少一条可检查的质量要求，否则等于没交代。 */
export const MIN_QUALITY_REQUIREMENTS = 1

/**
 * 读取并消毒质量要求列表（数组或单个字符串）。
 *
 * 空字符串、非字符串一律丢弃；重复项按规范化文本去重；条数与长度按上限截断。
 * 返回空数组表示「没有任何可用质量要求」，由调用方决定是拒绝还是回落。
 */
export function normalizeQualityRequirements(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : [])
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text.length > MAX_QUALITY_REQUIREMENT_CHARS
      ? `${text.slice(0, MAX_QUALITY_REQUIREMENT_CHARS - 3)}...`
      : text)
    if (out.length >= MAX_QUALITY_REQUIREMENTS) break
  }
  return out
}

/**
 * 渲染「本次任务结果的质量要求」块（用户要求 3、6）。
 *
 * 主 Agent 派发给部门负责人、部门负责人派发给专家，都必须带这一块；
 * 两处共用同一渲染，保证「负责人的要求」与「专家收到的要求」逐字一致。
 */
export function renderQualityRequirementsBlock(
  requirements: readonly string[],
  sourceLabel = '主 Agent',
): string {
  const list = normalizeQualityRequirements(requirements)
  if (list.length === 0) return ''
  return [
    `本次任务结果的质量要求（${sourceLabel}下达，属于验收的一部分，必须逐条达到，缺一不可）：`,
    ...list.map((item, index) => `  ${index + 1}. ${item}`),
  ].join('\n')
}

/* ========================================================================== */
/* 2b. 主 Agent→部门负责人派发的质量要求硬闸（2026-11-15 用户裁决）            */
/* ========================================================================== */

/**
 * 质量闸生效时刻（2026-11-15 10:30 +08:00 部署本机制的会话时点）。
 *
 * 用户裁决：旧计划（在途/历史，无 qualityRequirements 字段）豁免、零回归；
 * 只有 createdAt ≥ 该时刻的新计划在派发时才被本闸拦截。createdAt 缺失或
 * 非法一律视为旧计划放行（与 criterion v2 的「不回溯」哲学一致）。
 */
export const QUALITY_GATE_ACTIVATED_AT = Date.parse('2026-11-15T02:30:00.000Z')

/** 该计划是否受「派发必须带质量要求」硬闸约束（true=新计划，拦截）。 */
export function isQualityGatePlan(plan: unknown): boolean {
  const createdAt = Number((plan as any)?.createdAt ?? 0)
  return Number.isFinite(createdAt) && createdAt > 0 && createdAt >= QUALITY_GATE_ACTIVATED_AT
}

export interface SubtaskQualityCheck {
  ok: boolean
  code?: string
  error?: string
  hint?: string
}

/**
 * 校验单条派发给部门负责人的子任务是否携带质量要求（用户裁决：缺即拒发）。
 *
 * 判据与 normalizeQualityRequirements 同口径：至少 1 条非空、去重后 ≤8 条、
 * 每条 ≤400 字符；全部为空视为缺失。满足返回 ok:true（调用方照常派发）。
 */
export function checkSubtaskQualityRequirements(subtask: unknown): SubtaskQualityCheck {
  const item = (subtask ?? {}) as any
  if (normalizeQualityRequirements(item?.qualityRequirements).length >= MIN_QUALITY_REQUIREMENTS) {
    return { ok: true }
  }
  const label = typeof item?.title === 'string' && item.title.trim() !== '' ? `「${item.title.trim()}」` : ''
  return {
    ok: false,
    code: 'DISPATCH_QUALITY_REQUIREMENTS_MISSING',
    error: `派发给部门负责人的子任务${label}（${String(item?.id ?? '?')}）没有携带质量要求（qualityRequirements）：`
      + '不带质量要求的任务直接拒发，该子任务不会启动部门 Agent。',
    hint: '立刻用 dsh_workplan_replan 重新规划，为每个子任务补写 qualityRequirements'
      + '（至少 1 条可检查的质量要求：什么算合格、什么算不合格，每条 ≤400 字符），'
      + '然后重新调用 dsh_workplan_dispatch 派发；本次其余合格的子任务不受影响、正常执行。',
  }
}

/* ========================================================================== */
/* 3. 极简任务硬门槛（用户要求 5）                                             */
/* ========================================================================== */

/** 单项任务书的字符上限：超过即判定「不是一个 1+1=2 的单项任务」。 */
export const MAX_ATOMIC_TASK_CHARS = 300
/** 单项任务书的最短字符数（太短无法判断做什么；与函数注释、CHANGELOG 3.0.0 一致）。 */
export const MIN_ATOMIC_TASK_CHARS = 8

/**
 * 并列/多目标的强信号词。命中 1 个以上即视为「一个任务里塞了多件事」。
 * 只收强信号（明显的并列连词与小标题分隔），不收「和」这类高频虚词，
 * 避免把正常表述误判成多任务。
 *
 * [3.0.2] 补齐「并/然后/接着」：子 Agent 的任务书常写「改 A 并改 B」「先备份
 * 然后上传」这类口语并列，旧词表全漏（英文盲区事故：英文句点 + 英文 then
 * 都不在判据里，复合任务被当单句放行）。「并且」已含「并」，报错文案按
 * 长词优先去重。
 */
const MULTI_GOAL_MARKERS: readonly string[] = Object.freeze([
  '并且', '同时', '另外', '还要', '以及', '分别', '顺便', '并', '然后', '接着',
])

/**
 * [3.0.2] 「再」只在两个动作之间当连词时才算并列信号（「先备份再修改」）。
 * 不再/再次/再三/再现/再也不/要再 等副词用法不算——「不要再等待」不会被误伤。
 * 若后续实测「再」的误判率仍偏高，按用户裁决可仅保留 并/然后/接着 并删除
 * 本规则。
 */
const ZAI_CONJUNCTION_RE = /(?<![不未莫无勿别一要])再(?![次三现也])/

/**
 * 句末终止符：原子任务必须是单句。
 * [3.0.2] 英文句点 `.` 计入，但只认「后跟空白或文本结尾」的句读——文件名
 * （a.ts）、版本号（1.12.0）、省略号（...）里的点不算句子分隔。
 */
const SENTENCE_TERMINATORS: readonly RegExp[] = [new RegExp('[。！？!?]|\\.(?:\\s|$)', 'g')]

export interface AtomicTaskCheck {
  ok: boolean
  code?: string
  error?: string
  hint?: string
}

/**
 * 极简任务硬门槛（用户要求 5，用户裁决 A：不满足即拒绝派发并强制拆小）。
 *
 * 判据全部可机械复算，不看语义：
 *  1) 非空且长度在 8–300 字符之间；
 *  2) 只有一句话（不出现第二个句末标点——含英文句点 `.`，不含分号分句）；
 *  3) 不含并列强信号词（并且/并/同时/另外/还要/以及/分别/顺便/然后/接着，
 *     以及两动作之间的连词「再」）；
 *  4) 必须带非空的质量要求（用户要求 6：交代清楚成果必须达到的要求和质量）。
 *
 * 返回的 hint 是可直接照做的拆小指令，不是一句「不合格」。
 */
export function checkAtomicAssignment(task: string, qualityRequirements?: unknown): AtomicTaskCheck {
  const rawLength = String(task ?? '').trim().length
  const text = String(task ?? '').replace(/\s+/g, ' ').trim()
  if (text.length < MIN_ATOMIC_TASK_CHARS) {
    return {
      ok: false,
      code: 'DELEGATE_TASK_NOT_ATOMIC',
      error: `分到的任务太短（${text.length} 字符），必须写清「一个动作 + 一个主产物」（至少 ${MIN_ATOMIC_TASK_CHARS} 字符）。`,
      hint: '把任务写成：对什么对象做什么动作 → 产出哪一个文件/结论。一条只做一件事。',
    }
  }
  if (text.length > MAX_ATOMIC_TASK_CHARS) {
    return {
      ok: false,
      code: 'DELEGATE_TASK_NOT_ATOMIC',
      // [3.0.2] 如实报告截断后实际长度：调用方（llm-rules truncate(1500)）先截断
      // 再送检，这里的数字是被判定文本的真实长度，不是原始输入的长度。
      error: `分到的任务太长（截断后实际 ${rawLength} 字符 > ${MAX_ATOMIC_TASK_CHARS}），不是 1+1=2 的单项任务。`,
      hint: '按「一个目标 / 一个主产物 / 一项可独立验收」拆成多条；每条只保留一个动作，其余另起一条。',
    }
  }
  for (const pattern of SENTENCE_TERMINATORS) {
    pattern.lastIndex = 0
    const matches = text.match(pattern)
    if (matches && matches.length > 1) {
      return {
        ok: false,
        code: 'DELEGATE_TASK_NOT_ATOMIC',
        error: '分到的任务里出现了多个句子，说明塞进了多件事。',
        hint: '一个任务只写一句话；其余句子各自拆成独立任务。',
      }
    }
  }
  if (/[;；]/.test(text)) {
    return {
      ok: false,
      code: 'DELEGATE_TASK_NOT_ATOMIC',
      error: '分到的任务用分号并列了多个子任务，不是单项任务。',
      hint: '分号前、分号后各拆成一条独立任务，各自带质量要求。',
    }
  }
  const hit = MULTI_GOAL_MARKERS.filter((marker) => text.includes(marker))
  // 「并且」与「并」同命中时只报长词，报错文案不重复列同一个信号。
  const markers = hit.filter((marker) => !hit.some((other) => other !== marker && other.includes(marker)))
  if (ZAI_CONJUNCTION_RE.test(text)) markers.push('再')
  if (markers.length > 0) {
    return {
      ok: false,
      code: 'DELEGATE_TASK_NOT_ATOMIC',
      error: `分到的任务含并列词「${markers.join('、')}」，说明一个任务里有多件事。`,
      hint: '把并列词前后的内容各拆成一条独立任务，每条只做一个动作。',
    }
  }
  if (normalizeQualityRequirements(qualityRequirements).length < MIN_QUALITY_REQUIREMENTS) {
    return {
      ok: false,
      code: 'DELEGATE_QUALITY_REQUIREMENTS_MISSING',
      error: '分到的任务没有交代「成果必须达到的要求和质量」，专家无法判断做到什么程度算完成。',
      hint: '为这条任务补 qualityRequirements（至少 1 条可检查的质量要求，例如「必须是可执行命令并附真实输出」）。',
    }
  }
  return { ok: true }
}

/* ========================================================================== */
/* 4. 专家精简 JSON 汇报（用户要求 7）                                         */
/* ========================================================================== */

/** 单个汇报数组的条数上限：精简的量化口径。 */
export const MAX_REPORT_ITEMS = 6
/**
 * [3.0.6][第 3 批③] sources（部门汇总「覆盖的专家汇报」）专用上限。
 * 死锁修复：复杂任务按用户裁决 D1/D2 强制 ≥8 名专家（上限 12），而 sources
 * 必须覆盖全部已派发专家——若与其他数组共用 6 条上限，7–12 人的部门永远
 * 交不出合法汇总（覆盖诚实要求 vs 精简上限互相矛盾）。覆盖是硬要求，
 * 故 sources 单独放宽到 16（≥ 复杂任务 12 人上限 + 余量），其余数组仍 6 条。
 */
export const MAX_SOURCES_ITEMS = 16
/** 单条汇报文本的字符上限。 */
export const MAX_REPORT_ITEM_CHARS = 200

/** 专家汇报的四个必填字段（与用户要求 7 的四个方向一一对应）。 */
export const EXPERT_REPORT_FIELDS = Object.freeze([
  Object.freeze({ name: 'keyResults', label: '关键成果', description: '本次任务真正做出来的结果（做了什么、得出什么），至少 1 条' }),
  Object.freeze({ name: 'keyInfo', label: '关键信息', description: '支撑上述成果的关键事实/数据/结论，可为空数组' }),
  Object.freeze({ name: 'importantInfo', label: '重要信息', description: '负责人必须知道的风险、限制、未决项，可为空数组' }),
  Object.freeze({ name: 'leadRequirements', label: '负责人要求的东西', description: '负责人点名要的东西（文件路径/结论/证据）逐条回应，至少 1 条' }),
])

/** 部门汇总的必填字段（与用户要求 10 一一对应）。 */
export const DEPARTMENT_SUMMARY_FIELDS = Object.freeze([
  Object.freeze({ name: 'keyResults', label: '关键成果', description: '本部门汇总后的关键成果，至少 1 条' }),
  Object.freeze({ name: 'keyInfo', label: '关键信息', description: '支撑成果的关键事实/数据，可为空数组' }),
  Object.freeze({ name: 'importantInfo', label: '重要信息', description: '主 Agent 必须知道的风险、限制、未决项，可为空数组' }),
  Object.freeze({ name: 'sources', label: '覆盖的专家汇报', description: '逐条列明已汇总的专家：member + 其关键成果一句；必须覆盖本部门全部已派发专家' }),
])

function normalizeReportLine(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 去重检测（用户要求 10 的「禁止内容累赘和重复」）。
 *
 * 两种重复都算：
 *  1) 同一条信息重复出现——完全相同，或一条完整包含另一条且短的一条不少于
 *     12 字符；
 *  2) 近义重复——按 bigram 的 Dice 系数 ≥ 0.85 判定（与 T7 契约文档同一阈值），
 *     用于拦「换个说法写两遍」。
 * 条目支持「去重键｜内容」写法（T7 契约）：去重键相同即视为同一条信息，
 * 与内容是否一致无关。
 */
const DEDUPE_SIMILARITY_THRESHOLD = 0.85

/** 拆出「去重键｜内容」的去重键（没有分隔符时返回空串）。 */
export function entryDedupeKey(line: string): string {
  const index = line.indexOf('｜')
  if (index <= 0) return ''
  return line.slice(0, index).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** bigram 集合（去掉空白与标点，中文按二字切片）。 */
function bigrams(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  const out: string[] = []
  for (let i = 0; i < cleaned.length - 1; i += 1) out.push(cleaned.slice(i, i + 2))
  if (out.length === 0 && cleaned.length === 1) out.push(cleaned)
  return out
}

/** Dice 相似度：两个 bigram 多重集的重合程度（0–1）。 */
export function diceSimilarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.length === 0 || right.length === 0) return a.trim() === b.trim() ? 1 : 0
  const counts = new Map<string, number>()
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let overlap = 0
  for (const gram of right) {
    const remaining = counts.get(gram) ?? 0
    if (remaining > 0) {
      overlap += 1
      counts.set(gram, remaining - 1)
    }
  }
  return (2 * overlap) / (left.length + right.length)
}

function duplicatePairs(lines: readonly string[]): Array<[string, string]> {
  const found: Array<[string, string]> = []
  const normalized = lines.map((line) => line.toLowerCase())
  const keys = lines.map(entryDedupeKey)
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i]
      const b = normalized[j]
      if (a === '') continue
      if (keys[i] !== '' && keys[i] === keys[j]) { found.push([lines[i], lines[j]]); continue }
      if (a === b) { found.push([lines[i], lines[j]]); continue }
      const [short, long] = a.length <= b.length ? [a, b] : [b, a]
      if (short.length >= 12 && long.includes(short)) { found.push([lines[i], lines[j]]); continue }
      if (short.length >= 12 && diceSimilarity(a, b) >= DEDUPE_SIMILARITY_THRESHOLD) {
        found.push([lines[i], lines[j]])
      }
    }
  }
  return found
}

function checkListField(
  container: Record<string, unknown>,
  name: string,
  violations: string[],
  options: { minItems: number; maxItems?: number; dedupeAcross?: readonly string[] },
): string[] {
  const raw = container[name]
  if (!Array.isArray(raw)) {
    violations.push(`缺少 ${name} 数组（${name} 必须是字符串数组）`)
    return []
  }
  const lines = raw.map(normalizeReportLine).filter((line) => line !== '')
  if (lines.length < options.minItems) {
    violations.push(`${name} 至少 ${options.minItems} 条非空内容，当前 ${lines.length} 条`)
  }
  const maxItems = options.maxItems ?? MAX_REPORT_ITEMS
  if (lines.length > maxItems) {
    violations.push(`${name} 最多 ${maxItems} 条（精简要求），当前 ${lines.length} 条，请合并去重`)
  }
  for (const line of lines) {
    if (line.length > MAX_REPORT_ITEM_CHARS) {
      violations.push(`${name} 有一条 ${line.length} 字符超上限（${MAX_REPORT_ITEM_CHARS}），请压缩成一句关键信息`)
      break
    }
  }
  const dups = duplicatePairs(lines)
  if (dups.length > 0) {
    violations.push(`${name} 内部有重复表述（例：「${dups[0][0].slice(0, 40)}」与「${dups[0][1].slice(0, 40)}」），禁止累赘重复`)
  }
  const across = options.dedupeAcross ?? []
  for (const other of across) {
    const otherLines = (Array.isArray(container[other]) ? container[other] : [])
      .map(normalizeReportLine).filter((line) => line !== '')
    const crossDups = duplicatePairs([...lines, ...otherLines])
      .filter((pair) => lines.includes(pair[0]) && otherLines.includes(pair[1]))
    if (crossDups.length > 0) {
      violations.push(`${name} 与 ${other} 有重复项（例：「${crossDups[0][0].slice(0, 40)}」），同一信息只写一次`)
      break
    }
  }
  return lines
}

export interface ReportCheck {
  ok: boolean
  code?: string
  violations: string[]
}

/**
 * 校验专家精简 JSON 汇报（用户要求 7）。
 *
 * 只做结构/精简判定，不判语义真伪（诚信由 F9 与五步证据门禁兜底）。
 */
export function checkExpertReport(report: unknown): ReportCheck {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, code: 'REPORT_INVALID', violations: ['缺少 report 对象：专家成果必须以 JSON 汇报（keyResults/keyInfo/importantInfo/leadRequirements）'] }
  }
  const container = report as Record<string, unknown>
  const extra = Object.keys(container).filter((key) => !EXPERT_REPORT_FIELDS.some((field) => field.name === key))
  const violations: string[] = []
  checkListField(container, 'keyResults', violations, { minItems: 1, dedupeAcross: ['keyInfo', 'importantInfo', 'leadRequirements'] })
  checkListField(container, 'keyInfo', violations, { minItems: 0, dedupeAcross: ['keyResults', 'importantInfo', 'leadRequirements'] })
  checkListField(container, 'importantInfo', violations, { minItems: 0, dedupeAcross: ['keyResults', 'keyInfo', 'leadRequirements'] })
  checkListField(container, 'leadRequirements', violations, { minItems: 1, dedupeAcross: ['keyResults', 'keyInfo', 'importantInfo'] })
  if (extra.length > 0) {
    violations.push(`report 只允许 keyResults/keyInfo/importantInfo/leadRequirements 四个字段，多出：${extra.join('、')}`)
  }
  return violations.length === 0
    ? { ok: true, violations: [] }
    : { ok: false, code: violations.some((v) => v.startsWith('缺少 report')) ? 'REPORT_INVALID' : 'REPORT_NOT_CONCISE', violations }
}

/**
 * 校验部门负责人精简 JSON 汇总（用户要求 8、10、11）。
 *
 * @param summary 汇总对象
 * @param expectedExperts 本部门已派发给专家的名单（按 member 名称）；给空数组时
 *        不做覆盖度核对（负责人亲自执行、无下级的情形）
 */
export function checkDepartmentSummary(summary: unknown, expectedExperts: readonly string[] = []): ReportCheck {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return { ok: false, code: 'DEPARTMENT_SUMMARY_INVALID', violations: ['缺少 departmentSummary 对象：部门汇总必须以 JSON 交回主 Agent（keyResults/keyInfo/importantInfo/sources）'] }
  }
  const container = summary as Record<string, unknown>
  const extra = Object.keys(container).filter((key) => !DEPARTMENT_SUMMARY_FIELDS.some((field) => field.name === key))
  const violations: string[] = []
  checkListField(container, 'keyResults', violations, { minItems: 1, dedupeAcross: ['keyInfo', 'importantInfo'] })
  checkListField(container, 'keyInfo', violations, { minItems: 0, dedupeAcross: ['keyResults', 'importantInfo'] })
  checkListField(container, 'importantInfo', violations, { minItems: 0, dedupeAcross: ['keyResults', 'keyInfo'] })
  const covered = checkListField(container, 'sources', violations, { minItems: 0, maxItems: MAX_SOURCES_ITEMS })
  if (expectedExperts.length > 0) {
    const joined = covered.join('\n').toLowerCase()
    const missing = expectedExperts.filter((member) => member.trim() !== '' && !joined.includes(member.trim().toLowerCase()))
    if (missing.length > 0) {
      violations.push(`sources 未覆盖全部已派发专家，缺少：${missing.join('、')}（每条写「专家名：一句关键成果」）`)
    }
  }
  if (extra.length > 0) {
    violations.push(`departmentSummary 只允许 keyResults/keyInfo/importantInfo/sources 四个字段，多出：${extra.join('、')}`)
  }
  return violations.length === 0
    ? { ok: true, violations: [] }
    : { ok: false, code: 'DEPARTMENT_SUMMARY_NOT_CONCISE', violations }
}

/** 渲染专家汇报的 JSON 契约（嵌入专家任务书）。 */
export function renderExpertReportSpec(): string {
  return [
    '【专家成果汇报契约 · JSON mode · 用户强制要求 7】',
    '完成后必须在证据块 JSON 里额外给出 report 字段，只写下面四项，禁止写长文、禁止前后重复：',
    '  "report": {',
    '    "keyResults": ["关键成果"],',
    '    "keyInfo": ["关键信息"],',
    '    "importantInfo": ["重要信息"],',
    '    "leadRequirements": ["负责人要求的东西"]',
    '  }',
    ...EXPERT_REPORT_FIELDS.map((field) => `- ${field.name}（${field.label}）：${field.description}`),
    `- 每个数组最多 ${MAX_REPORT_ITEMS} 条、每条最多 ${MAX_REPORT_ITEM_CHARS} 字符；同一信息只能出现一次（禁止累赘和重复）。`,
    '- 门禁：缺 report、字段缺失、条数越界、单条超长、或出现重复项，结果一律退回重交（REPORT_INVALID / REPORT_NOT_CONCISE）。',
  ].join('\n')
}

/** 渲染部门汇总的 JSON 契约（嵌入部门负责人任务书）。 */
export function renderDepartmentSummarySpec(): string {
  return [
    '【部门汇总契约 · JSON mode · 用户强制要求 8/10/11】',
    '你的结果除了常规证据块，必须额外给出 departmentSummary 字段：全面、深入整理汇总本部门全部专家汇报，只保留关键信息、关键成果、重要信息与主 Agent 要求的东西，禁止累赘和重复；汇总完成后直接交回主 Agent。',
    '  "departmentSummary": {',
    '    "keyResults": ["关键成果"],',
    '    "keyInfo": ["关键信息"],',
    '    "importantInfo": ["重要信息"],',
    '    "sources": ["专家名：一句关键成果"]',
    '  }',
    ...DEPARTMENT_SUMMARY_FIELDS.map((field) => `- ${field.name}（${field.label}）：${field.description}`),
    `- keyResults/keyInfo/importantInfo 每个数组最多 ${MAX_REPORT_ITEMS} 条、每条最多 ${MAX_REPORT_ITEM_CHARS} 字符；sources 最多 ${MAX_SOURCES_ITEMS} 条（不受 6 条精简上限约束——必须逐人覆盖本部门全部已派发专家，覆盖是诚实硬要求），同一信息只能出现一次。`,
    '- 门禁：缺 departmentSummary、字段缺失、未覆盖全部专家、或出现重复项，结果一律退回重交（DEPARTMENT_SUMMARY_INVALID / DEPARTMENT_SUMMARY_NOT_CONCISE）。',
  ].join('\n')
}

/** 去掉首尾空白并截断（与 plan.ts truncate 同语义，此处自带以保持零依赖）。 */
export function clipReportText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text
}
