/**
 * [3.2.4][步数预算][治本] 步数预算：把「钱」的杠杆从单价搬到步数。
 *
 * 背景（reports/wp-diagnosis-token-and-expert-stop-20261123.md 第二节实测）：
 * 一个 124 步的专家会话合计 13,263,562 token，其中 95% 是同一段对话被每一步
 * 反复读（cacheRead）；13 步的同型会话合计 542,450。合计 token 与步数近似
 * 线性，所以控钱的第一杠杆是步数，不是单价。但直接给专家加「步数上限」
 * 会与已冻结的机制契约冲突——「专家执行没有总时长、单次时长、空闲或回执
 * 硬截止」。因此本模块的实现口径是：
 *
 *  - 默认开启（软 60 / 硬 75）：`DSH_WORKPLAN_STEP_BUDGET=0|false|off` 可整体
 *    关闭，正整数 n 表示软上限 n、硬上限 ceil(n×1.25)；
 *  - 生效点是**结算时（settle-time），不是中途击杀**：插件无法安全中止一个
 *    正在运行的宿主子会话（没有它的 abort 信号），而且「任务做到 80 步终于
 *    成功」绝不能反过来判失败。所以：
 *      · 结果为 done ⇒ 只在步数 ≥ 软上限时 console.warn 留痕，不改任何状态；
 *      · 结果不是 done ⇒ 在失败 error 里追加步数上下文（N 步、软/硬上限、
 *        是否超硬上限），让重派决策有据可依——配合 failedErrorWithHarvestNote
 *        的产物收编说明，失败也不丢已完成的工作；
 *  - 永不改判成功为失败、永不中断回合——与「专家执行没有总时长、单次时长、
 *    空闲或回执硬截止」的冻结契约零冲突。
 *  - 只统计「assistant/message」事件数（每步一个）。phase-0/仅工具步与正文步
 *    一视同仁——它们同样驱动整段对话重读。
 *
 * 宿主没有把「当前步号」直接给插件，所以这里用会话日志自数。扫描有界
 * （countCap 提前止损），不引入 O(全史) 成本。
 */
export const STEP_BUDGET_ENV = 'DSH_WORKPLAN_STEP_BUDGET'
/** 硬上限默认值：软上限的 1.25 倍向上取整，兜底必须有界。 */
export const STEP_HARD_MULTIPLIER = 1.25
/** 默认软上限：与「每批 ≤5 名专家」的实测 213s/约 20 步的量级对齐。 */
export const DEFAULT_STEP_BUDGET = 60

export type StepBudgetConfig = {
  /** null = 关闭（默认）。>0 = 软上限；硬上限 = ceil(soft × 1.25)。 */
  soft: number | null
  hard: number
}

/** 解析环境变量：'0'/'false'/'off' ⇒ 关闭；正整数 ⇒ 软上限；非法 ⇒ 默认 60。 */
export function parseStepBudget(raw: string | undefined | null): StepBudgetConfig {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '' ) {
    const soft = DEFAULT_STEP_BUDGET
    return { soft, hard: Math.ceil(soft * STEP_HARD_MULTIPLIER) }
  }
  if (text === '0' || text === 'false' || text === 'off') return { soft: null, hard: 0 }
  const n = Number(text)
  if (Number.isInteger(n) && n > 0) {
    return { soft: n, hard: Math.ceil(n * STEP_HARD_MULTIPLIER) }
  }
  const soft = DEFAULT_STEP_BUDGET
  return { soft, hard: Math.ceil(soft * STEP_HARD_MULTIPLIER) }
}

/**
 * 数一个会话在 afterSeq 之后出现的 assistant/message 条数（即模型步数）。
 * countCap 提前止损：预算已爆就不需要精确值。
 */
export function countAssistantSteps(session: any, afterSeq: number, countCap = 4096): number {
  if (!session || typeof session.eventAt !== 'function') return 0
  const total = Number(session.seq)
  if (!Number.isFinite(total) || total <= 0) return 0
  const from = Math.max(0, Math.floor(Number(afterSeq) || 0))
  let count = 0
  for (let seq = from; seq < Math.floor(total); seq += 1) {
    let event: any
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (!event) continue
    if (event.type !== 'assistant/message') continue
    count += 1
    if (count >= countCap) return count
  }
  return count
}

export type StepBudgetVerdict = {
  /** 'ok' = 未触及；'soft' = 触及软上限（提醒收尾）；'hard' = 触及硬上限（按停滞处理）。 */
  level: 'ok' | 'soft' | 'hard'
  steps: number
  soft: number | null
  hard: number
}

export function judgeStepBudget(steps: number, config: StepBudgetConfig): StepBudgetVerdict {
  if (config.soft === null) return { level: 'ok', steps, soft: null, hard: config.hard }
  if (steps >= config.hard) return { level: 'hard', steps, soft: config.soft, hard: config.hard }
  if (steps >= config.soft) return { level: 'soft', steps, soft: config.soft, hard: config.hard }
  return { level: 'ok', steps, soft: config.soft, hard: config.hard }
}

/**
 * 软上限文案（**目前故意未接线**）。
 *
 * 设计取舍：在专家运行途中给他发「你到 60 步了，快收尾」这类消息，技术上可行
 * （平台能给子会话 sendMessage），但它会把「成本压力」变成「质量压力」——
 * 模型收到催促后最常见的反应是提前交卷、少做一步验证，而不是少做无意义重复。
 * 验收门禁不会因此放宽，交薄了只会被退回重做，反而更贵。
 *
 * 因此 v1 只做结算后记账（console.warn + durable 台账 + 失败 error 上下文），
 * 不给运行中的专家任何到点信号。若将来要启用中途提醒，必须先单独评估质量影响，
 * 并把「只提醒、不催交、绝不降低证据要求」写进文案。
 */
export function wrapUpNote(steps: number, soft: number): string {
  return `步数提醒：该会话已 ${steps} 步（软上限 ${soft}）——请继续把验收证据做全，不要为省步数削减证据。`
}

/**
 * 失败 error 的步数上下文（只在结果不是 done 时追加，配合产物收编说明）。
 * refs 为空时只报步数，不提产物。
 */
export function budgetFailureContext(
  steps: number,
  config: StepBudgetConfig,
  harvestRefs: readonly string[],
): string {
  if (config.soft === null) return ''
  const exceeded = steps >= config.hard ? '，已超硬上限' : ''
  const base = `步数预算：本会话 ${steps} 步（软 ${config.soft}/硬 ${config.hard}${exceeded}）`
  if (harvestRefs.length === 0) return base
  return `${base}；已落盘结算备份（可先收编核验，勿按零产出重做）：${harvestRefs.slice(0, 3).join('、')}`
}
