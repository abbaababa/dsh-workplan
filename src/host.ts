import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * Host half of dsh-workplan.
 *
 * Registers:
 *  - the agent/pre-step listener that commits a plan before step 1; dispatch is a model tool;
 *  - a short system-prompt section for the main agent's integration duties;
 *  - dsh_workplan_update and dsh_workplan_dispatch model tools;
 *  - the read-only dashboard route.
 */

import {
  applyHardeningHeaders,
  cancelToolOutputSchema,
  createWorkplanRuntime,
  dispatchToolOutputSchema,
  plannerOutputSchema,
  replanToolOutputSchema,
  statusToolOutputSchema,
  updateToolOutputSchema,
} from './runtime.js'
import { DEPARTMENT_IDS, isRecord, START_EVIDENCE_MIN_CHARS_BRIEF } from './plan.js'
// [3.1.0] 人数上限单一真源（caps.ts）：工具说明书与门禁/消毒/提示词同源。
import { MAX_COMPLEX_DELEGATE_MEMBERS, MIN_COMPLEX_DELEGATE_MEMBERS } from './caps.js'
import { autoResumeEnabledFrom } from './auto-resume.js'
import { pruneJournal } from './dept-journal.js'

/*
 * [1.8.14] Identity of the modules this process actually loaded (N1).
 *
 * `version` alone cannot answer "is the running process the build I just
 * shipped": the same version can be rebuilt, and a profile recomposition can
 * leave stale modules in memory while the files on disk are new. Hashing the
 * compiled entry files that make up the plugin at activation time gives a
 * value that changes whenever the loaded bytes change. It is computed once, so
 * it cannot drift during the process's life.
 *
 * [1.8.15] `watchdog.js` was missing from the list even though runtime.ts
 * imports it and the build copies it next to the other entries. Appending a
 * line to it left the fingerprint unchanged (T5c §6.1) — a build identity that
 * ignores a loaded module is a false negative, exactly what it exists to catch.
 */
const LOADED_BUILD = (() => {
  try {
    const entryPath = fileURLToPath(import.meta.url)
    const dir = dirname(entryPath)
    const hash = createHash('sha256')
    for (const file of ['host.js', 'runtime.js', 'plan.js', 'watchdog.js']) {
      hash.update(readFileSync(join(dir, file)))
    }
    return { entryPath, buildHash: hash.digest('hex').slice(0, 16) }
  } catch {
    /*
     * Never fail activation for a diagnostic. An unknown fingerprint is still a
     * truthful answer ("I cannot prove which bytes I am"), and `status` will
     * show `unknown` instead of a fabricated hash.
     */
    return { entryPath: '', buildHash: 'unknown' }
  }
})()

/*
 * Process start time derived from `process.uptime()`, so it is the actual OS
 * process start, not the moment the plugin was constructed. Used to tell
 * "restarted after the fix" from "same process, rebuilt files on disk".
 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)

/*
 * [3.0.6][第 2 批] 静态图表资产只读一次。
 * 旧实现每次请求都 readFileSync 210KB（看板每次加载都拉一次），在请求路径上
 * 做磁盘 I/O 没有必要：vendor 文件随插件发布、运行期不会变。缓存 Buffer 后
 * 后续请求直接复用；读取失败不缓存，下次仍会重试。
 */
let chartVendorBytes: Buffer | null = null

function phaseLabel(phase: any) {
  if (phase === 'paused') return '本轮预算用尽，可续跑'
  if (phase === 'blocked') return '卡住了'
  if (phase === 'done') return '已完成'
  if (phase === 'executing') return '正在做'
  if (phase === 'planning') return '正在安排'
  if (phase === 'integrating') return '正在收尾'
  if (phase === 'cancelled') return '已取消'
  return String(phase ?? '')
}

export const name = 'dsh-workplan'

export const inject = ['tools', 'systemPrompt', 'llm', 'subagents', 'sessions']

export const PROMPT_ORDER = 40

const PROMPT_SECTION = [
  '本会话已启用自动任务分解。系统会在每个新用户任务的第一个模型步骤前生成计划，并先把计划显示在对话里；看到【任务分解】计划消息后，若插件未自动派发或需要续跑/重试，再调用 dsh_workplan_dispatch（默认 wait 等结果；预计较久时用 mode:"async" 先开跑）。若只收到「任务分解已在后台生成中」而尚未看到【任务分解】，不要手动派发，先告知用户正在分配并等待计划落地。',
  /*
   * [3.0.0] 用户 2026-11-14 十三条要求的提示词侧双保险（代码侧同源门禁见
   * v3-contract / comm-format / llm-rules / runtime）。文案不做发挥，只写
   * 机制的实际行为，避免提示词与门禁分叉。
   */
  '3.0.0 会话可见性与状态提示（插件自动执行，你不得省略或改动）：接单时插件会自动在会话内输出「任务正在分配中，请稍等一下......」；分配完成（派发成功）后自动输出「任务已经完成分配，正在执行中......」。这两条是逐字冻结的固定文案，由平台发送，你不需要也不得重复发送；若你发现其中一条没有出现在会话里，说明插件未走通对应环节，应先报告而不是假装已发送。计划消息会把你刚才输入的任务原文逐字带在会话里（切换会话再切回也仍可见），这是用户要求 1 的保证，不要删除或改写。',
  '3.0.0 任务书质量要求（用户要求 3/6）：插件派给部门负责人的每个子任务都携带 qualityRequirements（结果质量要求），部门负责人派给专家的每条任务也必须携带 qualityRequirements。负责人→专家缺它平台直接拒绝派发（DELEGATE_QUALITY_REQUIREMENTS_MISSING）；主 Agent→部门负责人缺它则该子任务在派发时被直接拒发（DISPATCH_QUALITY_REQUIREMENTS_MISSING，不启动部门 Agent），须 replan 补齐后重派。你审阅计划时先看每个子任务是否写了清楚的质量要求。',
  '3.0.0 极简任务（用户要求 5，用户裁决 A＝硬门槛）：部门负责人派出的每条任务必须简单到像 1+1=2——一个动作、一个主产物、一项可独立验收，单句、≤300 字符、不含「并且/同时/另外/还要/以及/分别/顺便」等并列词；不满足即被拒绝并给出拆分提示（DELEGATE_TASK_NOT_ATOMIC）。',
  '3.0.0 角色与汇报（用户要求 7/8/9/10/11/12）：部门组员角色已取消，只保留部门负责人与全球顶尖专家（role 只允许 expert）；专家完成后必须以 JSON 汇报（证据块里的 report：keyResults/keyInfo/importantInfo/leadRequirements，精简、禁止重复，F10）；部门负责人必须全面汇总本部门全部专家汇报后，以 JSON 交回主 Agent（departmentSummary：keyResults/keyInfo/importantInfo/sources，精简、禁止累赘重复，F11）；等所有部门的汇总都交回后，由你再全面、深入整理汇总成最终成果交付给用户（用户要求 12）。',
  '3.1.0 版本（用户要求 13）：本插件当前版本为 3.1.0。涉及版本号的对外表述一律写 3.1.0。',
  /*
   * [3.0.8] 主 Agent 五步开工证据协议（取代 2.5.1 两轮深度思考，用户已批准）：
   * 部门三层执行者已有开工/结算双门禁，主 Agent 自己也必须做到同一协议——
   * 提示词告知 + dispatch 硬门禁（validateStartPhaseEvidence）双保险，与部门层同一哲学。
   */
  '主 Agent 五步开工证据协议（3.0.8 强制，与部门负责人/顶尖专家同一口径）：你执行自己的任务时，必须完成五步工作法的前三步——第一步全面、全盘、深入梳理、研究、思考自己的任务（目标与验收、现状与事实、约束、未知、主要矛盾、边界）；第二步基于刚才第一步完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考，研究需要哪些资源、哪些工具、理清具体一步步以最高效率执行、确保完美完成自己任务的方法、流程和步骤（含全程如何少走弯路：先查历史教训、先验证再动手、不重复试错），并写清依据；第三步把资源与工具真正备齐并给出就绪证据。首次调用 dsh_workplan_dispatch 必须随附 startPhases={ planning{ problemAnalysis（第一步任务梳理）, resources（第二步资源研究）, tools（第二步工具研究）, approach（第二步方法流程步骤）, approachBasis（第二步基于第一步全部结果的依据对应） }, preparation{ prepared（第三步已备清单）, evidence（第三步就绪证据） } }，未提交或不合格会被平台硬门禁拒绝（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE）；登记后持久化，续跑/重试/重启回放自动读档，无需重复提交；重规划产生的新计划是新任务，必须重新完成前三步并提交。派发顺序、督战、验收与交付必须严格按第二步理清的方法、流程、步骤执行，不得静默改道。四角色执行前门禁现已全覆盖：主 Agent 经 dispatch 门禁、负责人经 delegate review 门禁、专家经 phase-0 self_effort+startPhases 门禁（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），未登记合格开工证据一律不进入正式执行。',
  /*
   * [2.3.10][T2] 用户要求1（P3）提示词双保险：插件已在规划前/派发前自动发送
   * 【规划预告】/【派发预告】（runtime.ts maybePlan / dispatchTool）；这里把
   * 「分配前必须先告知用户预估耗时」写成主 Agent 硬规则，防止模型省略或吞掉。
   */
  '分配任务前必须先告知预估耗时：调用 dsh_workplan_dispatch 前，必须先在会话中告知用户本次分配的预估耗时（含明确数值与单位分钟，标注「仅供参考，非承诺」）。插件在规划前与派发前自动发送的【规划预告】/【派发预告】即该告知的组成部分，不得省略、不得吞掉；主 Agent 自己的答复也应向用户转述预估时间。',
  '如果当前是 plan 模式：不要调用 dsh_workplan_dispatch；先把计划展示给用户，等待用户审阅并退出 plan 模式后，再调用 dsh_workplan_dispatch 执行。',
  '纯问候、寒暄、致谢、告别、简单确认（如「你好」「谢谢」「好的」「再见」）不生成计划，也不启动子 Agent；直接自然、简短地回答。只有包含实际目标、问题或交付物的消息才进行分解。',
  '单独的「继续」「接着」「然后呢」「下一步」等没有新增任务内容的追问，不生成计划；由主 Agent 结合会话上下文继续，或先询问用户要延续哪件事。',
  '询问进度、是否完成、还剩多少、哪里卡住等状态型问题，不生成计划、不启动子 Agent；主 Agent 直接读取当前计划/会话记录回答。只有要求继续修复或新增工作量时，才重新分解。',
  '当上下文出现来源为 workplan 的「任务分解」或「部门执行结果」时：',
  '1. 先核对计划中的事实、未知项与假设，不得把假设当成已验证事实；',
  '2. 核对每个完成子任务的证据与验收标准，不合格的要用 dsh_workplan_update 标记为 blocked 或 in_progress；',
  '3. 对受阻项向用户说明，必要时先询问再继续；',
  '4. 不要声称未经验证的完成，不要重复派发已完成的子任务。',
  /*
   * [1.8.7] 硬规则：ok:true 不等于完成。
   *
   * 事故（session-99984ebd…）里模型把「本轮预算用尽，可续跑（10/13）」当成
   * 成功，直接 present 并收尾。提示词必须把「complete 字段才是完成」写到
   * 不可误解，并且与 runtime 的回合收尾闸门（agent/turn-stopping）形成双保险。
   */
  /*
   * [1.8.13] 用户明确取消不是完成。
   *
   * 1.8.7 的原文是「全部 done（或用户明确取消）」，T5-C 就是拿这句话把
   * “取消 1/3 再 present”走通的：提示词把它写成完成等价物，present 的
   * planIncomplete 又对 cancelled 短路。现在完成只有一个判据：全部 done
   * 且 deliveryReady=true。
   */
  '5. 「完成」只有一个判据：计划里全部子任务都是 done，**且** deliveryReady=true（每个 done 项 verification="structured"、acceptance 非空且逐项 result="pass"、无缺失产物）。用户取消 ≠ 完成：取消只停止执行，未完成项仍然是未完成。`dsh_workplan_dispatch` 返回 ok:true / complete:true 只表示调用成功或状态全 done，必须再看 deliveryReady 与 完成 X/Y；只要 deliveryReady=false 或还有 pending/blocked，就禁止 present 交付物、禁止写“已完成/最终版/已交付”、禁止给收尾性最终答复，必须先再次调用 dsh_workplan_dispatch 续跑剩余项。',
  '6. 如果续跑被拒绝、受阻项无法恢复、证据补不齐、计划已取消但未完成，或用户要求先看中间结果：答复开头必须写「未完成：剩余 N 项（列出 ID）与原因」，正文只能按中间结果表述，不得包装成成品。取消不会给你交付许可。',
  /*
   * [3.0.1] 部门负责人与全球顶尖专家的正式执行已彻底取消时间上限。
   *
   * 历史版本曾同时使用单次超时、空闲超时、回执超时、整轮预算和十分钟判据；
   * 这些机制会在长任务尚未完成时中止、判 blocked、换人接手或拒绝 done。
   * 现在只保留用户显式取消、真实执行错误、证据与质量门禁。预估和开工上报
   * 仍用于协调，但不得派生任何截止、延期、接手或完成门槛。
   */
  '7. 执行时间规则：部门负责人和部门相关领域全球顶尖专家执行任务不设总时长、单次时长、空闲无进展或回执硬截止；平台不得仅因执行较久、暂时无新事件或未立即回执而中止、判 blocked、换人接手或拒绝 done。estimateMinutes、timeNotice、timeSpentMinutes 只用于协调与告知，仅供参考、非承诺，不参与完成验收。extendMs 已停用（TIME_LIMITS_DISABLED），无需申请延期。用户显式取消、真实执行错误、证据/质量门禁仍然有效；长时间任务应及时落盘并报告进度，完成与否只由真实结果和验收证据决定。',
  /*
   * [2.3.0][T1] 专家执行时间机制三条款（用户 2026-11-10 要求 1/2 的主 Agent 侧义务）：
   * 预估上报后必须转告用户；第 1 次超时必须放宽并告知专家（插件自动投递最新时限
   * 与质量效率要求）；第 2 次超时由主 Agent 接手，已完成部分只读保护、禁止丢弃。
   */
  '7a. 专家预估沟通：timeNotice/【专家预估上报】到达后仍须把预估告知用户；预估变化可再次上报，但它只是协调信息，不会触发延期、超时计数、主 Agent 接手或时长判据。不得要求专家为超过任意分钟数申请批准，也不得因实际耗时高于预估否定其已完成且证据合格的工作。',
  '8. 出现「待指示」项（closure=escalated，左侧栏显示「待指示」并附问题摘录）时，必须在当轮处理：用 dsh_workplan_instruct 下发决定（投递到子会话并把该行恢复为执行中），或确认放弃后用 dsh_workplan_update 置 blocked。不要沉默略过，也不要把待指示当成普通失败——它是一条还没被回答的请示，会一直占着交付门禁。',
  '9. 出现「已下发未响应」（ackOverdue）时，不要重复派发：先用 dsh_workplan_status 看该行 childId 与已等待时长，必要时用 dsh_workplan_followup 投递一次说明。ackOverdue 仅是提示，不存在无回执硬超时；平台不会仅因此把任务记为 blocked 或中止执行。',
  /*
   * [1.11.0] T7：需求变更的重规划不能只靠模型自觉。
   *
   * 变更通知（workplan-change）与 replan 工具都在，但如果提示词不写“必须判定”，
   * 模型仍可能用旧计划直接交付。这里把它写成第 10 条硬规则：判定动作只有
   * replan / dispatch / cancel 三个，旧行保留可追溯，新行必须再 dispatch。
   */
  '10. 执行中用户提出新要求，或原安排的前提被推翻时，必须用 `dsh_workplan_replan` 明确判定：`cancel`/`replace` 受影响的旧子任务、`add` 新工作，并在 `reason` 写清原因；旧行保留为「已重规划」（可追溯、不计入剩余项、不再调度），随后调用 `dsh_workplan_dispatch` 执行新行。只是补充说明、不改范围时用 `dsh_workplan_update` 的 `note`；不允许用旧计划直接交付。',
  '结果消息里每个完成项都带 verification 与 acceptance：`structured` 是子 Agent 逐条自检通过，`unverified` 是自述但未逐条确认，`failed` 是自检失败（已按受阻处理），`legacy` 是旧格式回传。只有 structured 且 acceptance 每项 pass 才算可交付；其余必须你自己核对产物，并用 dsh_workplan_update 的 verification/acceptance/artifacts 字段把核对结果写回（这些字段会持久化、刷新后仍生效），不要把“看着没问题”当成证据。',
  '子 Agent 通过 `needs` 提出的跨部门需求会列在结果消息的「跨部门待转达」里，并自动登记为待处理需求、计入交付门禁：用 `dsh_workplan_handoff` 逐条处置（list 查看、assign 登记责任部门、resolve 写入答复或产物引用、close 判定无需动作），不要忽略。注意：assign 不产生工作（没有常驻部门代理），需要产出就用 `dsh_workplan_replan(action=add)` 建该部门的子任务或自己完成；对「待指示」的行 resolve 会直接把答复投递给子会话。每条需求都必须有处置结论，否则 present 会被拒绝。',
  '长任务可以用 `dsh_workplan_dispatch({ mode: "async" })` 先开跑并立即答复用户，再用 `dsh_workplan_status` 查看进度；async 返回的是“已开跑”，不是“已完成”。',
  '如果自动分解降级，先向用户说明失败原因并询问是否重试，在用户确认前不要开始执行任务。',
  /*
   * [2.0.0] 自我学习与自我迭代（用户 2026-11-05 强制要求）。
   *
   * 部门 Agent 在第五步收尾必须复盘并落盘为永久记忆；这条提示词让主 Agent 知道
   * 记忆存在、存在哪里、怎么复核，而不是把「会学习」当成不可见的口号。
   */
  '每个部门完成工作后，必须在第五步收尾提交复盘（问题 / 弯路 / 解决 / 防再犯规则），插件会自动把它写入永久教训记忆文件（默认 ~/.dsh/workplan/lessons.jsonl，可用 DSH_WORKPLAN_LESSONS_FILE 覆盖）；下次派发同类子任务时，相关历史教训会自动出现在子 Agent 提示词里。',
  '需要复核「到底记住了什么、哪些错误在重复发生」时，调用 `dsh_workplan_lessons`（action: list / search / stats）。它是只读工具；记忆里反复出现的教训（occurrences ≥ 2）必须在下一次计划里变成明确约束，不能让同类错误第三次发生。',
].join('\n')

/**
 * Seconds a dispatch has been running, from the payload only.
 *
 * `elapsedMs` is authoritative; `startedAt` is the fallback for a payload that
 * carries no elapsed value. Computing this inside the template mixed `??` with
 * a conditional and could silently print the wrong number.
 */
function elapsedSeconds(result: any) {
  const elapsed = Number(result?.elapsedMs)
  if (Number.isFinite(elapsed) && elapsed >= 0) return elapsed
  const startedAt = Number(result?.startedAt)
  return Number.isFinite(startedAt) && startedAt > 0 ? Date.now() - startedAt : 0
}

function textContent(text: any) {
  return [{ type: 'text', text }]
}

function asObject(value: any) {
  if (isRecord(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

export type WorkplanConfig = {
  cwd?: string
  /** [2.1.3][2.1.6] 单次规划器调用的无进展窗口（毫秒），亦可用 DSH_WORKPLAN_PLANNER_TIMEOUT_MS。 */
  plannerTimeoutMs?: number
  /** [2.1.6] 输出开始后的完全静默窗口（毫秒），亦可用 DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS。 */
  plannerIdleTimeoutMs?: number
  /**
   * 历史兼容字段。为免旧配置报错仍接受数值，但执行层不会据此创建任何
   * 截止、空闲监控、整轮计时器或自动中止；新配置不应再使用。
   */
  childTimeoutMs?: number
  idleTimeoutMs?: number
  totalTimeoutMs?: number
  maxResumes?: number
  /**
   * [1.10.4][1.12.0] 整轮预算到点后自动开始下一轮。默认 **true**（自 1.10.6）。
   *
   * 关闭方式（部署时二选一）：profile 配置 `autoResume: false`，或环境变量
   * `DSH_WORKPLAN_AUTO_RESUME=0`。默认开启是用户 2026-11-01 的明确要求：
   * 一个没人被告知要打开的恢复开关等于没有。取消、blocked、等指示、无进展、
   * 轮次上限等安全分支仍然生效。
   */
  autoResume?: boolean
  /** 自动续跑轮次上限（0–4，默认 2）；环境变量 `DSH_WORKPLAN_AUTO_RESUME_MAX`。 */
  autoResumeMaxAttempts?: number
  /**
   * [1.11.0] 完成必回报（C-05 / M3 / M11）。默认 **true**。
   *
   * `true`：子任务结束必须附结构化证据块；只有散文、没有证据块且没写
   * `BLOCKED:` 时判为 `blocked/unverified`，不再记成「已完成」。
   * `false`：保留 1.10.6 行为（无证据块按 `done/legacy` 收），用于回放旧会话、
   * 或部署方明确只想看松散结果。环境变量 `DSH_WORKPLAN_STRICT_COMPLETION=0`。
   */
  strictCompletion?: boolean
  /**
   * [1.12.0] 计划生成后是否自动派发（T6 Q2 / 用户三项机制体检）。
   *
   * 默认 **true**：计划一生成就自动开跑，不再依赖主模型额外调用
   * `dsh_workplan_dispatch`。以下边界仍然生效：plan 模式不自动派发（等用户
   * 审阅）；已有计划执行中不重复派发；预算、取消、幂等与交付门禁全部保留。
   * 关闭方式：`autoDispatch: false` 或环境变量 `DSH_WORKPLAN_AUTO_DISPATCH=0`。
   */
  autoDispatch?: boolean
  /**
   * [1.12.3] headless「未完成不得成功收尾」硬闸门。
   *
   * `'auto'`（不配置时的默认）：只在 headless 运行中启用，交互式 web/tui 会话
   * 行为完全不变。`true` 强制开启（任何运行方式都硬失败），`false` 关闭并回到
   * 1.12.2 的「steer 用尽即放行」。
   *
   * 环境变量：`DSH_WORKPLAN_FAIL_CLOSED_ON_INCOMPLETE=1|0`。
   */
  failClosedOnIncomplete?: boolean | 'auto'
  /**
   * [3.0.6][第 3 批①] `agent/turn-stopping` 等待在途规划/派发的上限（毫秒）。
   * 默认 60 分钟；0 = 无限等待（旧行为）。只约束收尾等待，不构成执行时限。
   */
  turnStoppingMaxWaitMs?: number
  /**
   * [3.0.6][第 2 批] 留痕保留天数。**0（默认）= 永久保留，不自动删除**。
   *
   * 审计证据默认不该被清理；只有部署方明确配置正数（或环境变量
   * `DSH_WORKPLAN_JOURNAL_RETENTION_DAYS`）时，才会在启动时和之后每 24 小时
   * 删除超过该天数未更新的 `<planId>.jsonl`（单次最多 200 个最旧文件）。
   */
  journalRetentionDays?: number
}

function createUpdateTool(runtime: any) {
  return {
    name: 'dsh_workplan_update',
    description:
      '更新当前任务分解计划中一个子任务的状态与证据。仅用于本会话已生成的主计划；子 Agent 不可调用。'
      + '当主 Agent 核对子任务结果、发现完成不实或需要修正时使用。'
      + '把子任务标成 done 时，必须同时给出真实的 verification 与 acceptance（每项 result="pass"），'
      + '否则计划不会变成可交付状态（deliveryReady=false，present 会被拒绝）。'
      + '部门负责人和全球顶尖专家执行没有时限，extendMs 已停用并返回 TIME_LIMITS_DISABLED；不要申请延期。'
      + 'timeNotice 仅记录预估（仅供参考、非承诺），可用于告知预估变化，不影响执行或验收。'
      + '这些字段会写入会话日志，刷新/重启后仍然生效。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        subtaskId: {
          type: 'string',
          description: '要更新的子任务 ID，例如 T1。',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'blocked'],
          description: '新的状态（普通改判必填；仅记录开工预估时可省略并改传 timeNotice）。extendMs 仅为旧调用兼容，会返回 TIME_LIMITS_DISABLED。',
        },
        progress: {
          type: 'integer',
          description: '进度百分比（0-100）；done 会自动置为 100。',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: '支持该状态的证据（文件、命令输出、验收结果）。只用于说明，不参与可交付判定。',
        },
        verification: {
          type: 'string',
          enum: ['structured', 'legacy', 'unverified', 'failed'],
          description: '证据等级：structured=逐条自检通过；unverified=自述未逐条确认；'
            + 'legacy=旧格式回传（没有结构化证据）；failed=自检失败。'
            + '可交付要求 structured。',
        },
        acceptance: {
          type: 'array',
          description: '验收项及逐项结果；可交付要求非空且每项 result="pass"。',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string', description: '验收标准。' },
              result: { type: 'string', enum: ['pass', 'fail', 'unverified'], description: '该项结果。' },
              evidence: { type: 'string', description: '支持该结果的证据（文件、命令输出、测试结果）。' },
            },
            required: ['criterion', 'result'],
            additionalProperties: false,
          },
        },
        artifacts: {
          type: 'array',
          description: '声明产物；kind=file/url/note，exists=false 表示产物缺失。',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['file', 'url', 'note'] },
              ref: { type: 'string' },
              exists: { type: 'boolean' },
            },
            required: ['kind', 'ref'],
            additionalProperties: false,
          },
        },
        missingArtifacts: {
          type: 'array',
          items: { type: 'string' },
          description: '已知缺失的产物路径；非空时计划不可交付。',
        },
        expectedRevision: {
          type: 'integer',
          description: '你读取到的 revision。传入后若该子任务已被更新，会返回 STALE_WRITE 而不是覆盖新证据。',
        },
        force: {
          type: 'boolean',
          description: '计划执行中强行改判（默认拒绝并返回 TASK_RUNNING）。会记录为人工改判。',
        },
        note: {
          type: 'string',
          description: '补充说明；会显示在任务卡片中。',
        },
        /*
         * [1.12.0][D-28] 结果消息指引的 `update + instruction` 必须真的能通过
         * schema 校验。runtime 的 updateStatus 一直读 args.instruction，但这里
         * 因 additionalProperties:false 从未声明该字段：严格宿主会直接拒绝，
         * 模型只能看到「该动作不存在」。与 dsh_workplan_instruct 等价，二选一。
         */
        instruction: {
          type: 'string',
          description: '待指示项（closure=escalated）的答复文本：与 status="in_progress" 一起使用，'
            + '会投递给子会话并把该行恢复为执行中。等价于 dsh_workplan_instruct。',
        },
        /*
         * [2.2.0][T5/O-4c] 延期事务（方案 §2.2 / §5.4；D-28 教训：runtime 会读取的
         * 字段必须在这里显式声明，additionalProperties:false 会让未声明参数被严格
         * 宿主直接拒收）。extendMs 只推移协商截止并重置计时，不改状态判定，运行中
         * 无需 force（TASK_RUNNING 的唯一豁免）；放宽永远有界（累计 ≤ 初始协商
         * 上限 × 1），超出由 runtime 拒绝并转「请主 Agent 裁决」。
         */
        extendMs: {
          type: 'integer',
          description: '旧版延期字段，仅为兼容保留。部门负责人和全球顶尖专家已无执行截止，传入正整数只返回 TIME_LIMITS_DISABLED，不改状态、不重设任何计时器，也不需要用户批准。请改用 timeNotice 更新纯信息预估。',
        },
        /*
         * [SCv2-T4][Q1-B/C06/C08] 用户例外批准留痕（criterionApproval → 行上
         * criterionException）。D-28 教训同源：runtime 会读取的字段必须在这里
         * 显式声明（additionalProperties:false）。5 项口径：任务 ID（subtaskId）、
         * 批准原文/来源（reason/source）、批准时间（at）、放宽后分钟数（由
         * extendMs 自动回填 extendedMinutes）、适用范围（scope）。
         */
        criterionApproval: {
          type: 'object',
          description: '旧版时间判据批准字段，仅为兼容历史调用与记录保留；当前没有时间判据、延期或超时例外审批，此字段不影响 done。完成仍必须通过真实证据、产物与质量验收。',
          properties: {
            approvedBy: { type: 'string', enum: ['user'], description: '批准主体：必须是 user（用户明确批准）；主 Agent 自行批准无效。' },
            at: { type: 'number', description: '用户实际批准的时间（epoch 毫秒；展示按 Asia/Shanghai）。不得晚于当前时刻。' },
            reason: { type: 'string', description: '用户批准原文/来源（逐字摘录，必填；「全部按推荐」不构成对个别超时的批准）。' },
            source: { type: 'string', description: '批准来源（可选：用户消息引用/会话 ID 等）。' },
            scope: { type: 'string', enum: ['task', 'plan'], description: '适用范围：task=仅本任务；plan=本计划。' },
          },
          required: ['approvedBy', 'at', 'reason', 'scope'],
          additionalProperties: false,
        },
        /*
         * [2.2.0][T5/O-4c] O-2a 专家开工预告：{declaredMinutes, reason}。与 extendMs
         * 同属「只记录、不改判定」的时限信息，运行中同样放行。
         */
        timeNotice: {
          type: 'object',
          description: '专家开工预估：{ declaredMinutes, reason }，只记入信息流水并通知主 Agent 转告用户，仅供参考、非承诺；不生成截止、不触发延期或接管，也不改状态与完成判定。',
          properties: {
            declaredMinutes: { type: 'number', description: '预计完成本子任务的分钟数（仅供参考、非承诺）。' },
            reason: { type: 'string', description: '预告理由（可选）。' },
          },
          required: ['declaredMinutes'],
          additionalProperties: false,
        },
      },
      /*
       * [2.2.0][T5/O-4c] status 不再是无条件必填：纯延期/纯预告事务（只带
       * extendMs / timeNotice）是合法调用，runtime 会按「不改判定只改时限/记录」
       * 处理；普通改判缺 status 仍由 runtime 以 INVALID_STATUS 拒绝。
       */
      required: ['subtaskId'],
      additionalProperties: false,
    },
    output: {
      schema: updateToolOutputSchema(),
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        const stats = isRecord(result.stats) ? result.stats : {}
        const text = result.ok
          ? `已更新子任务 ${String(result.subtaskId ?? '')}：${String(result.status ?? '')}`
            + `（完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}，受阻 ${Number(stats.blocked ?? 0)}）`
          : `更新失败${result.code ? `（${String(result.code)}）` : ''}：${String(result.error ?? result.hint ?? '未知错误')}`
        return textContent(text)
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args)
      if (!parsed) throw new Error('参数必须是 JSON 对象')
      const result = await runtime.updateStatus(exec.agent, parsed)
      return result
    },
  }
}

/**
 * [1.11.0] 需求变更 → 重规划的唯一入口（T4 C-11 / T7）。
 *
 * 触发条件写在工具描述里，因为「什么时候该重规划」是语义判断，代码不猜：
 *  - 执行中用户提出新要求、原安排不再成立；
 *  - 验收标准/交付物变化，旧子任务的完成不再等于用户要的结果；
 *  - 上游结论推翻了后续步骤的前提。
 * 只补说明、不改范围时不要用本工具（那会白白留下一批“已重规划”旧行），
 * 改用 `dsh_workplan_update` 的 note。
 *
 * 旧状态不删除：`planReplan()` 在计划定义上写 `supersededAt/replacedBy`，
 * `applyReplanStatuses()` 在状态条上写 `closure:'replanned'` + `replannedFrom`，
 * 两者是同一次写入的两个镜像；旧行保留可追溯、不计入剩余项、不再调度。
 * 重规划本身不执行新行——必须再调用 `dsh_workplan_dispatch`。
 */
function createReplanTool(runtime: any) {
  return {
    name: 'dsh_workplan_replan',
    description:
      '按需求变更重规划当前计划：把受影响的旧子任务标为「已重规划」（保留可追溯，不再调度、不计入剩余项），'
      + '并为每个被替换项生成一个接替子任务、为新增工作生成新子任务。'
      + '触发条件：执行中用户提出新要求、验收标准或交付物变化、原安排的前提被推翻。'
      + '只补充说明而不改范围时不要调用本工具，改用 dsh_workplan_update 的 note。'
      + '重规划不会中途改写正在跑的本轮：执行中调用返回 REPLAN_PLAN_RUNNING 并把变更原文记为 changeRequest，'
      + '等本轮结束后用同一组 changes 重试即可（变更不会丢）。'
      + '重规划成功后必须再调用 dsh_workplan_dispatch 执行新行；旧行不会复活。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        reason: {
          type: 'string',
          description: '为什么原安排失效（必填，会写进持久化记录与旧行留档）。',
        },
        changeText: {
          type: 'string',
          description: '可选：用户变更原文。本轮派发仍在执行时，本工具不会改计划，只会把它记为 changeRequest。',
        },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          description: '逐项说明受影响的子任务：cancel=撤销，replace=用新行接替，add=追加新工作。',
          items: {
            type: 'object',
            properties: {
              subtaskId: {
                type: 'string',
                description: '受影响的旧子任务 ID（add 时可填任意未被占用的新 ID）。',
              },
              action: {
                type: 'string',
                enum: ['cancel', 'replace', 'add'],
                description: 'cancel=只撤销；replace=撤销旧行并插入接替行；add=不动旧行，追加新行。',
              },
              reason: { type: 'string', description: '该子任务受影响的原因；省略时继承顶层 reason。' },
              replacement: {
                type: 'object',
                description: 'replace 必填：改后的字段（未给的字段继承旧行）。',
                properties: {
                  id: { type: 'string', description: '接替行 ID（默认在旧 ID 后加 b）；最长 16 字符，不能与现有 ID 重复。' },
                  title: { type: 'string' },
                  department: {
                    type: 'string',
                    /* [1.12.0][D-07] 与规划入口同源：模型先选合法 key，而不是先写自由文本再被运行期拒绝。 */
                    enum: [...DEPARTMENT_IDS],
                    description: '受影响的部门 key（必须是规划器枚举之一）。',
                  },
                  role: { type: 'string' },
                  objective: { type: 'string' },
                  method: { type: 'array', items: { type: 'string' } },
                  inputs: { type: 'array', items: { type: 'string' } },
                  outputs: { type: 'array', items: { type: 'string' } },
                  acceptance: { type: 'array', items: { type: 'string' } },
                  risk: { type: 'string' },
                },
                additionalProperties: false,
              },
              newSubtask: {
                type: 'object',
                description: 'add 必填：新增子任务，title 与 objective 必填。',
                properties: {
                  id: { type: 'string', description: '新行 ID；省略时自动生成 R<修订号>-<序号>。' },
                  title: { type: 'string' },
                  objective: { type: 'string' },
                  department: {
                    type: 'string',
                    /* [1.12.0][D-07] 同 replacement.department：枚举与规划入口同源。 */
                    enum: [...DEPARTMENT_IDS],
                    description: '新行所属部门 key（必须是规划器枚举之一）。',
                  },
                  role: { type: 'string' },
                  method: { type: 'array', items: { type: 'string' } },
                  inputs: { type: 'array', items: { type: 'string' } },
                  outputs: { type: 'array', items: { type: 'string' } },
                  acceptance: { type: 'array', items: { type: 'string' } },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  risk: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['title', 'objective'],
                additionalProperties: false,
              },
            },
            required: ['subtaskId', 'action'],
            additionalProperties: false,
          },
        },
      },
      required: ['reason', 'changes'],
      additionalProperties: false,
    },
    output: {
      schema: replanToolOutputSchema(),
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(
            `重规划失败${result.code ? `（${String(result.code)}）` : ''}：${String(result.error ?? result.hint ?? '未知错误')}`
            + (result.code === 'REPLAN_PLAN_RUNNING'
              ? '｜变更已记录，等本轮结束（dispatch 返回后）再用同一组 changes 重试。'
              : ''),
          )
        }
        const marks = Array.isArray(result.marks) ? result.marks : []
        const added = Array.isArray(result.added) ? result.added : []
        const changed = marks
          .map((mark: any) => `${String(mark?.subtaskId ?? '')}→${Array.isArray(mark?.replacedBy) && mark.replacedBy.length > 0 ? mark.replacedBy.join('、') : '撤销'}`)
          .join('，')
        const fresh = added.map((item: any) => String(item?.subtaskId ?? '')).filter(Boolean).join('、')
        return textContent(
          `计划 ${String(result.planId ?? '')} 已重规划为修订 r${Number(result.planRevision ?? 0)}`
          + (changed ? `｜受影响：${changed}` : '')
          + (fresh ? `｜新增：${fresh}` : '')
          + '｜旧行保留为「已重规划」（可追溯、不计入剩余项、不再调度）'
          + '｜下一步：调用 dsh_workplan_dispatch 执行新行。',
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.replanPlan(exec.agent, parsed)
    },
  }
}

function createCancelTool(runtime: any) {
  return {
    name: 'dsh_workplan_cancel',
    description:
      '取消当前会话尚未派发/正在等待派发的任务分解计划。仅取消计划记录，不伪造任何完成；'
      + '取消后计划在面板中显示为“已取消”，不会启动任何部门 Agent。'
      + '注意：取消不等于完成。取消后如仍有未完成项或证据缺口，present 仍会被拒绝，'
      + '答复必须按「未完成：剩余 N 项与原因」说明。'
      + 'disposition="superseded" 是另一种处置：把交付责任转移给一个可验证的承接计划。'
      + '运行时逐条复算（V1–V8）：源计划必须已取消且未全 done、承接计划必须定义更晚且非终态、'
      + '映射必须覆盖源计划全部子任务、每个映射目标必须有 done+structured 证据与全通过的验收、'
      + '且本会话存在同时含两个 planId 的用户确认消息。任一不满足即拒绝并返回 SUPERSEDE_* 码，'
      + '状态不变；被取代不等于完成。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        reason: {
          type: 'string',
          description: '取消/取代原因，会写入会话记录。',
        },
        disposition: {
          type: 'string',
          enum: ['cancelled', 'superseded'],
          description: '处置方式：cancelled=用户撤销（默认）；superseded=责任已转移给承接计划。',
        },
        supersededBy: {
          type: 'object',
          description: 'disposition=superseded 时必填：承接计划与逐项覆盖映射。'
            + '只给映射意图，requiredCount/coveredCount/coverage/digest 由运行时复算，不接受自报。',
          properties: {
            planId: {
              type: 'string',
              description: '承接计划的 planId（必须定义得过且未终止）。',
            },
            mapping: {
              type: 'array',
              description: '源计划每个定义子任务一条映射；from 必须恰好覆盖全部源项（各一次）。',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string', description: '源计划子任务 ID。' },
                  to: { type: 'string', description: '承接计划子任务 ID。' },
                  basis: { type: 'string', description: '覆盖依据（为什么这两项是同一责任）。' },
                },
                required: ['from', 'to', 'basis'],
                additionalProperties: false,
              },
            },
          },
          required: ['planId', 'mapping'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: cancelToolOutputSchema(),
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(`处置失败${result.code ? `（${String(result.code)}）` : ''}：`
            + `${String(result.error ?? '未知错误')}`)
        }
        const stats = isRecord(result.stats) ? result.stats : {}
        if (result.phase === 'superseded') {
          const by = isRecord(result.supersededBy) ? result.supersededBy : {}
          return textContent(
            `计划 ${String(result.planId ?? '')} 已被取代：承接计划 ${String(by.planId ?? '')}`
            + `（映射 ${Number(by.coveredCount ?? 0)}/${Number(by.requiredCount ?? 0)}，digest 已复算）`
            + `｜源计划仍是 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}：被取代不等于完成，`
            + '不得 present 源计划，只能使用承接计划通过交付就绪检查的产物。',
          )
        }
        const cancelledIncomplete = result.phase !== 'done'
        return textContent(
          `已取消计划 ${String(result.planId ?? '')}：${String(result.reason ?? '用户取消')}`
          + `（完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}）`
          + (cancelledIncomplete
            ? '｜计划仍未完成：不要 present，不要写“已完成”；答复按「未完成：剩余 N 项与原因」开头。'
            : '｜计划此前已全部 done。'),
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args)
      if (!parsed) throw new Error('参数必须是 JSON 对象')
      return runtime.cancelPlan(exec.agent, parsed)
    },
  }
}

function createFollowupTool(runtime: any) {
  return {
    name: 'dsh_workplan_followup',
    description:
      '把一条说明投递给本会话的某个**直接子会话**，让它继续跑一个正常回合。'
      + '用途仅限：子任务被预算/超时中止、但产物已在盘上，且用户明确同意补发 follow-up 时，'
      + '让子会话自己收尾，从而让它自己的 turn/end 变成 completed。'
      + '它不写计划状态、不触发交付、也不改变界面判定；投递本身不等于完成。'
      + '不是直接子会话（父会话 catalog 未登记）一律拒绝。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '直接子会话 ID（父会话 subagent/catalog 中登记的那一个）。',
        },
        message: {
          type: 'string',
          description: '发给子会话的说明：确认已有产物、只补缺口、不要整步重跑；不要要求它伪造完成。',
        },
      },
      required: ['sessionId', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          messageId: { type: 'string' },
          code: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(
            `follow-up 未投递：${String(result.error ?? result.code ?? '未知错误')}`,
          )
        }
        return textContent(
          `已向子会话 ${String(result.sessionId ?? '')} 投递 follow-up`
          + (result.messageId ? `（messageId ${String(result.messageId)}）` : '')
          + '。投递只代表消息被接收；界面状态要等该子会话自己的回合正常结束才会变化。',
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.followupTool(exec.agent, parsed, exec.signal)
    },
  }
}

/**
 * [1.11.0] 子 → 父的唯一反向通道（T4 C-09 / T6 M5）。
 *
 * 为什么要有独立工具而不是让子 Agent 在结果块里写 `question`：结果块只在
 * 子会话结束时才被父会话看到，那时子会话已经停了，请示与「已结束」无法区分，
 * 主 Agent 只会在下一次 dispatch 之后才发现有人在等回答。这个工具把请示
 * 提前到「还在跑」的时刻，并在状态条上留下 `closure:'escalated'`。
 */
function createEscalateTool(runtime: any) {
  return {
    name: 'dsh_workplan_escalate',
    description:
      '子 Agent 遇阻时向父会话上报请示，并把该子任务置为「待指示」。'
      + '第三层专家（叶子）同样可用：请示会经 delegate 登记落到所属部门行的第三层台账，由部门负责人用 dsh_workplan_instruct 答复。'
      + '3.0.5 硬规则：第三层专家上报后，部门负责人禁止另派给其他专家，必须梳理该问题与本部门全部任务执行状态、研究方案后，用 dsh_workplan_instruct 答复原专家，原专家继续执行。'
      + '遇阻（缺权限/缺输入/依赖产物缺失/需求自相矛盾/无法验证/同一命令连续两次失败/需要主 Agent 决定方向）时，'
      + '第一动作是调用本工具，然后停止推进、只做只读核对，等待主 Agent/负责人指示。'
      + '不需要外部决定时不要调用；调用后不要自行选定一个选项继续。',
    parameters: {
      type: 'object',
      properties: {
        subtaskId: {
          type: 'string',
          description: '你的子任务 ID（仅用于回显核对；服务端按父子会话关系反查，自报值不作为定位依据）。',
        },
        question: {
          type: 'string',
          description: '需要主 Agent 回答的单个问题：写清卡在哪一步、已经尝试过什么、需要谁做什么决定。必填。',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的处理方向（建议 2–4 个）。只是建议，不会被自动执行，也不会替你选择。',
        },
        needs: {
          type: 'array',
          items: { type: 'string' },
          description: '需要其他部门/人员提供什么（每条一句话），由主 Agent 转达。',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          planId: { type: 'string' },
          subtaskId: { type: 'string' },
          status: { type: 'string' },
          closure: { type: 'string' },
          question: { type: 'string' },
          code: { type: 'string' },
          error: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(
            `上报未登记：${String(result.error ?? result.code ?? '未知错误')}`
            + '｜改为在结果块里写 "status":"blocked" 并附 "question"，仍然算作请示。',
          )
        }
        return textContent(
          `${String(result.subtaskId ?? '')} 已登记为「待指示」`
          + (result.alreadyEscalated ? '（此前已登记，未重复提交）' : '')
          + `：${String(result.question ?? '')}`
          + '｜现在停止推进，只做只读核对；等待主 Agent/部门负责人指示后再继续。第三层请示在答复前禁止改派给其他专家。',
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.escalateTool(exec.agent, parsed)
    },
  }
}

/**
 * [2.3.9][T4b] 第三层派发工具（用户强制要求 4/5）：部门负责人专用。
 *
 * 用户要求 4 原文：「分到相关任务的相关部门的负责人，必须再将你分配的任务，
 * 通过自己全面、全盘、深入开展梳理、研究、思考后，再合理分配相关任务给本部门
 * 相关领域全球顶尖专家（部门组员角色已取消）。」
 *
 * 落地为两步硬流程（服务端校验，提示词绕不过）：
 *  - `review`：提交「开工证据 + 分工表」（startPhases 五步第 1/2/3 步 +
 *    每位下级的 member/role/task/reasoningEffort）；分工表必须同时含
 *    ≥1 名 expert（顶尖专家）；部门组员角色已取消（3.0.0）。
 *  - `dispatch`：未登记 review 产物 ⇒ 硬门禁拒绝；登记后为每位下级派生
 *    第三层子会话（叶子层，第四层被宿主绝对深度上限硬拒），推理等级按
 *    当前模型家族合法集合（qwen→low/medium/xhigh；非qwen→low/high/max）
 *    钳制并留痕，随 agentOptions 全程生效（要求 5）。
 *  - `direct`：[2.5.5][T3] low（含未配置视同 low）任务负责人亲自执行登记：
 *    仅收 startPhases 开工证据（problemAnalysis/approach ≥40 字、approachBasis/
 *    resources/prepared/evidence ≥20 字、tools ≥10）＋可选 reasoningEffort='low'，
 *    拒 consolidation/分工表与复杂档；登记后平台以 low 档接续本会话亲自执行
 *    （文档同步，门禁在 runtime/llm-rules）。
 *
 * 权限模型与 escalate 同款：注册在插件根、对所有会话可见，`execute` 内部由
 * runtime.delegateTool 按「调用者必须是计划内某行的部门负责人子会话」硬校验。
 */
function createDelegateTool(runtime: any) {
  return {
    name: 'dsh_workplan_delegate',
    description:
      '部门负责人专用的第三层派发（用户要求 1/2/3，3.0.8 五步工作法单框架）：你拥有本部门内再分配权限。执行自己的任务必须先完成五步前三步：'
      + '第一步全面、全盘、深入梳理、研究、思考自己的任务；第二步基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案（方法、流程、步骤，含依据）；'
      + '第三步把资源与工具真正备齐并给出就绪证据。'
      + '先 action="review" 提交第 1/2/3 步开工证据（startPhases）'
      // [2.5.4][T4] D1/D2 人数口径同步（与 llm-rules.ts 负责人任务书同源逐字一致；3.1.0 上限 25）
      + `（planning{ problemAnalysis, resources, tools, approach, approachBasis } + preparation{ prepared, evidence }，开工证据字数下限：${START_EVIDENCE_MIN_CHARS_BRIEF} + 分工表：每位下级的 member/role/task/reasoningEffort，至少 1 名 expert 顶尖专家（部门组员角色已按用户要求 9 取消）；low/未配置任务禁止下派——负责人亲自执行，开工证据经 dsh_workplan_delegate(action="direct") 登记（${START_EVIDENCE_MIN_CHARS_BRIEF}；可选 reasoningEffort="low"）；复杂任务（medium/high/xhigh/max）合计不少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人且最多 ${MAX_COMPLEX_DELEGATE_MEMBERS} 人，少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人硬性阻断；`
      + '并可用 consolidation.taskReasoningEffort 为整个任务配置整体推理等级，配置后本任务重试/续跑全程沿用；下级档位以成员 self_effort 自配为权威（分工表档仅建议）），'
      + '再 action="dispatch" 把任务派给本部门相关领域全球顶尖专家（部门组员角色已取消，只保留 expert；固定一层下级、叶子层，第四层一律被拒）。'
      + '分配必须更简单：每位专家只承担一个动作、一个主产物、一项可独立验收的工作（简单到像 1+1=2：单句、≤300 字符、不含并列词，且每条必须带至少 1 条 qualityRequirements 质量要求；不满足即拒绝派发）。'
      + 'review 未提交前 dispatch 被硬门禁拒绝。每位下级的推理等级必须按其任务复杂度配置'
      + '（轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max），'
      + '平台按当前模型家族合法集合自动钳制越界档并留痕，等级在其任务全生命周期生效。'
      + 'action="status" 查看登记与下级进度。第三层专家叶子用 action="self_effort" 自配推理等级并提交五步第 1/2/3 步开工证据'
      + '（先配置+先研究准备后开工：phase-0 以 low 启动，唯一职责=评估自身任务复杂度并提交 reasoningEffort+complexityRationale+startPhases{planning,preparation}+开工前预估 timeNotice{declaredMinutes:正整数分钟,reason?}；'
      + '缺交/不合格开工证据硬拒 START_EVIDENCE_MISSING/START_EVIDENCE_INCOMPLETE、不接续；齐全登记后平台立即以自配档接续同一任务进入 phase-1，正式执行必须按第二步方法流程步骤进行、全程少走弯路；成员自配为权威、分工表档仅建议）。'
      + '3.0.5 硬规则：任一第三层成员处于待指示（escalated）时，review/dispatch/direct 一律拒绝改派、重派或降级；负责人必须梳理该成员问题与本部门全部任务状态，研究方案后用 dsh_workplan_instruct 答复原成员，原成员继续执行。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['review', 'dispatch', 'direct', 'status', 'self_effort'],
          description: 'review=提交开工证据与分工表（负责人）：startPhases 五步第 1/2/3 步证据 + 每位下级的 member/role/task/reasoningEffort；dispatch=正式派发给专家（负责人）；direct=low 任务负责人亲自执行登记（仅收 startPhases 开工证据，' + START_EVIDENCE_MIN_CHARS_BRIEF + '＋可选 reasoningEffort=\'low\'；拒 consolidation/分工表与复杂档，防旁路）；status=查看登记与进度；self_effort=第三层专家叶子自配推理等级+提交开工证据 startPhases+开工前预估 timeNotice（先配置+先研究准备后开工，缺一硬拒不接续）。',
        },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'action="self_effort" 必带（schema 层不强制，缺交将被运行时拒绝 SELF_EFFORT_MISSING）：叶子按自己分到的单项任务复杂度自配的推理等级（轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max）。成员自配为权威，越界档被平台钳制并留痕；登记后平台立即以自配档接续 phase-1。action="direct" 可选：仅接受 \'low\'（缺失默认 low）；复杂档请走 review。',
        },
        complexityRationale: {
          type: 'string',
          description: 'action="self_effort" 必带（schema 层不强制，缺交将被运行时拒绝 SELF_EFFORT_RATIONALE_MISSING）：复杂度依据（为什么你的单项任务是该档：事实/依赖/验证难度）。',
        },
        startPhases: {
          type: 'object',
          description: 'action="self_effort" / "review" / "direct" 必填（3.0.8 开工证据硬门禁）：五步工作法前三步证据——第一步全面、全盘、深入梳理、研究、思考自己的任务；第二步基于第一步完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，研究需要哪些资源、哪些工具、具体实施方案（方法、流程、步骤，含依据）；第三步把资源与工具真正备齐并给出就绪证据。缺交/不合格硬拒（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE），不登记、不接续正式执行；登记后持久化，重派/续跑读档放行。',
          properties: {
            planning: {
              type: 'object',
              properties: {
                problemAnalysis: { type: 'array', items: { type: 'string' }, description: '第一步 · 任务梳理：全面、全盘、深入梳理、研究、思考自己的任务（目标与验收/现状/事实/约束/未知/主要矛盾/边界），至少 1 条、合计 ≥40 字。' },
                resources: { type: 'array', items: { type: 'string' }, description: '第二步 · 资源研究：基于第一步全部结果，研究需要哪些资源（数据/文件/权限/人/知识/时间），至少 1 项、合计 ≥20 字。' },
                tools: { type: 'array', items: { type: 'string' }, description: '第二步 · 工具研究：需要哪些工具、每个工具用来做什么，至少 1 项、合计 ≥10 字。' },
                approach: { type: 'array', items: { type: 'string' }, description: '第二步 · 方法流程步骤：理清如何一步步以最高效率、少走弯路、完美完成任务的方法、流程和步骤，至少 1 条、合计 ≥40 字。' },
                approachBasis: { type: 'array', items: { type: 'string' }, description: '第二步依据：如何基于第一步完成好的所有结果（逐条对应），至少 1 条、合计 ≥20 字。' },
              },
              required: ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'],
              additionalProperties: false,
            },
            preparation: {
              type: 'object',
              properties: {
                prepared: { type: 'array', items: { type: 'string' }, description: '第三步 · 已备齐的资源与工具清单（每项写清：准备了什么、在哪里、是否可用），至少 1 项、合计 ≥20 字。' },
                evidence: { type: 'array', items: { type: 'string' }, description: '第三步 · 就绪证据：命令输出/文件路径/配置项/版本号/引用，至少 1 条、合计 ≥20 字。' },
              },
              required: ['prepared', 'evidence'],
              additionalProperties: false,
            },
          },
          required: ['planning', 'preparation'],
          additionalProperties: false,
        },
        timeNotice: {
          type: 'object',
          description: 'action="self_effort" 必填（T6/D9 开工前预估硬门禁）：本人任务预估执行时间，整数分钟；未提交/不合格硬拒（ESTIMATE_MISSING/ESTIMATE_INVALID），预估经通道送达部门负责人后才接续执行。',
          properties: {
            declaredMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: '本人任务预估执行时间，正整数分钟（Number.isInteger 且 ≥1、≤10080）；单位=分钟。' },
            reason: { type: 'string', description: '可选：预估理由（≤300 字符，trim 后落档）。' },
          },
          required: ['declaredMinutes'],
          additionalProperties: false,
        },
        consolidation: {
          type: 'object',
          description: 'action="review" 必带（schema 层不强制，缺交将被运行时拒绝 DELEGATE_CONSOLIDATION_MISSING / DELEGATE_CONSOLIDATION_INCOMPLETE）：第三层分工表（3.0.8 起不再内嵌开工证据——开工证据一律经 startPhases 提交登记）。负责人自己的第 1/2/3 步开工证据未登记前 dispatch 被硬门禁拒绝。action="direct" 禁止携带（direct 不接受分工表）。',
          properties: {
            taskReasoningEffort: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'xhigh', 'max'],
              description: '可选：负责人为整个任务配置的整体推理等级（按本任务复杂度：轻度=low；qwen 中等=medium、非 qwen 中等=high；qwen 非常复杂=xhigh、非 qwen 非常复杂=max）。负责人自配整体档：配置后本任务每次派发/重试/续跑全程沿用；下级以 self_effort 自配为权威；越界档被平台钳制并留痕。',
            },
            assignments: {
              type: 'array',
              // [3.0.0] 用户 2026-11-14 第 5/6/9 条：组员角色取消、任务极简、质量要求必填；3.1.0 上限随 caps.ts。
              description: `分工表：至少 1 名 expert（本部门相关领域全球顶尖专家；部门组员角色已按用户要求 9 取消，role 只允许 expert）；low/未配置任务禁止下派——负责人亲自执行，开工证据经 dsh_workplan_delegate(action="direct") 登记（${START_EVIDENCE_MIN_CHARS_BRIEF}；可选 reasoningEffort="low"）；复杂任务（medium/high/xhigh/max）合计不少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人且最多 ${MAX_COMPLEX_DELEGATE_MEMBERS} 人，少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人硬性阻断，超过上限平台拒收（可精简名单或拆两轮派发，绝不静默丢人无痕）。每一条任务必须简单到像 1+1=2：一个动作、一个主产物、一项可独立验收（≤300 字符、单句、不含并列词），且必须带 qualityRequirements（至少 1 条可检查的质量要求）；不满足即拒绝派发。`,
              items: {
                type: 'object',
                properties: {
                  member: { type: 'string', description: '专家的姓名或代号。' },
                  role: { type: 'string', enum: ['expert'], description: '只能是 expert=本部门相关领域全球顶尖专家（部门组员角色已取消；历史数据里的 member 读取时归一为 expert）。' },
                  task: { type: 'string', description: '分配给该专家的任务：一个动作、一个主产物，完整自包含，单句且 ≤300 字符；出现并列词或分句会被拒绝（DELEGATE_TASK_NOT_ATOMIC）。' },
                  qualityRequirements: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '必填（用户要求 6）：这条任务成果必须达到的要求和质量，至少 1 条、最多 8 条、每条 ≤400 字符，写清什么算合格、什么算不合格；缺失即拒绝派发（DELEGATE_QUALITY_REQUIREMENTS_MISSING）。',
                  },
                  reasoningEffort: {
                    type: 'string',
                    enum: ['low', 'medium', 'high', 'xhigh', 'max'],
                    description: '按该任务复杂度配置：轻度=low；比较复杂的任务 qwen 系=medium、非 qwen 系=high；非常复杂的任务 qwen 系=xhigh、非 qwen 系=max。建议档（成员自配为权威）：叶子 phase-0 一律 low 启动并经 self_effort 自配；越界档会被平台钳制并留痕。',
                  },
                },
                required: ['member', 'role', 'task', 'qualityRequirements'],
                additionalProperties: false,
              },
            },
          },
          required: ['assignments'],
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          planId: { type: 'string' },
          subtaskId: { type: 'string' },
          action: { type: 'string' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
          consolidation: { type: 'object' },
          members: { type: 'array', items: { type: 'object' } },
          delegates: { type: 'array', items: { type: 'object' } },
          clamped: { type: 'array', items: { type: 'object' } },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(`第三层派发未执行：${String(result.error ?? result.code ?? '未知原因')}`)
        }
        if (result.action === 'review') {
          const members = Array.isArray(result.members) ? result.members : []
          const clamped = Array.isArray(result.clamped) ? result.clamped : []
          return textContent(
            `梳理产物已登记（${String(result.subtaskId ?? '')}）：分工 ${members.length} 名专家`
            + `（全部为 expert；部门组员角色已取消）`
            + (clamped.length ? `；越界等级已钳制 ${clamped.length} 条（${clamped.map((c: any) => `${c.member}:${c.requested}→${c.corrected}`).join('、')}）` : '')
            + '｜下一步：action="dispatch" 正式派发。',
          )
        }
        if (result.action === 'dispatch') {
          const delegates = Array.isArray(result.delegates) ? result.delegates : []
          return textContent(
            `第三层已派发 ${delegates.length} 人：`
            + delegates.map((d: any) => `${d?.member ?? '?'}(专家/${d?.effort ?? '?'}/${d?.status ?? '?'})`).join('、')
            + '｜下级结论会送回本会话；收齐汇总核验后再写最终结果块。action="status" 可查看进度。',
          )
        }
        const delegates = Array.isArray(result.delegates) ? result.delegates : []
        return textContent(
          `${String(result.subtaskId ?? '')} 第三层状态：梳理${result.consolidation ? '已登记' : '未登记'}；下级 ${delegates.length} 人`
          + (delegates.length ? `（${delegates.map((d: any) => `${d?.member ?? '?'}:${d?.status ?? '?'}`).join('、')}）` : '')
          + `｜${String(result.hint ?? '')}`,
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.delegateTool(exec.agent, parsed, exec?.signal)
    },
  }
}

/**
 * [1.13.0→3.0.8] 第四步（验证阶段）的插件核验工具（用户 2026-11-05；五步口径）。
 *
 * 五步工作法要求部门 Agent 先梳理问题（第一步）、再研究资源/工具/方案（第二步）、
 * 再备齐就绪（第三步）、执行并逐项验证（第四步）、最后收尾与复盘（第五步）。
 * 这个工具只做一件事：接收五步证据并给出核验结论。缺少 planning/preparation
 * /execution 证据时会被 `runtime.verifySubtask` 以 `PHASE_GATE` 拒绝并列出待补项，
 * 避免跳过前三步直接宣称验证通过。
 *
 * 注意（2.0.2 更正）：2026-11-05 的「第一、二阶段禁用 dsh-workplan 插件」是
 * 该次优化会话的过程约束，不是对所有后续会话的产品规则；插件不全局禁用。
 */
export function createVerifyTool(runtime: any) {
  return {
    name: 'dsh_workplan_verify',
    description:
      '部门子 Agent 在第四步（验证阶段）使用的插件核验：提交 planning / preparation / execution / verification 五步证据，'
      + '插件逐项核验并返回 passed 或仍需补齐的 gaps。缺少 planning / preparation / execution 证据时返回 PHASE_GATE 与待补项；'
      + '只有「前三步开工证据（第一步任务梳理 + 第二步资源/工具/方案研究 + 第三步准备就绪）+ 实际执行步骤」齐全后，才会进入第四步核验。'
      + '核验通过不代表完成：最终仍要在结果块里写同一份 phases，由主计划按五步契约判定。',
    parameters: {
      type: 'object',
      properties: {
        subtaskId: {
          type: 'string',
          description: '你的子任务 ID（仅用于回显核对；服务端按父子会话关系反查，自报值不作为定位依据）。',
        },
        phases: {
          type: 'object',
          description: '五步证据：planning（第一步问题梳理 + 第二步资源/工具/方案）、preparation（第三步准备与就绪证据）、execution（第四步执行步骤）、verification（第四步逐项验证与复盘）。',
          properties: {
            planning: {
              type: 'object',
              description: '第一步 + 第二步：全面、全盘、深入梳理、研究、思考自己的任务（问题梳理），再基于第一步全部结果研究资源、工具与实施方案（方法、流程、步骤，含依据）。',
              properties: {
                problemAnalysis: { type: 'array', items: { type: 'string' }, description: '第一步 · 任务梳理：全面、全盘、深入梳理、研究、思考自己的任务（目标与验收/现状/事实/约束/未知/主要矛盾/边界）' },
                constraints: { type: 'array', items: { type: 'string' }, description: '约束条件' },
                unknowns: { type: 'array', items: { type: 'string' }, description: '未知或待确认项' },
                approach: { type: 'array', items: { type: 'string' }, description: '第二步 · 方法流程步骤：基于第一步全部结果理清的具体一步步执行、完美完成任务的方法、流程和步骤（每一步做什么、产出什么、如何证明）' },
                approachBasis: { type: 'array', items: { type: 'string' }, description: '第二步依据（必填）：第二步的资源、工具、方案如何基于第一步完成好的所有结果——第一步的哪些事实/约束/矛盾决定了第二步的哪些资源/工具/步骤' },
                resources: { type: 'array', items: { type: 'string' }, description: '第二步 · 资源研究：完成本任务需要哪些资源（数据/文件/权限/人/知识/时间），逐项写清用途与获取方式' },
                tools: { type: 'array', items: { type: 'string' }, description: '第二步 · 工具研究：需要哪些工具、每个工具用来做什么、为什么选它' },
              },
              required: ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'],
            },
            preparation: {
              type: 'object',
              description: '第三步 · 准备：把第二步研究出的资源、工具、实施方案真正备齐，并给出可复核的就绪证据。',
              properties: {
                prepared: { type: 'array', items: { type: 'string' }, description: '已准备好的资源/工具清单：准备了什么、在哪里、是否可用' },
                evidence: { type: 'array', items: { type: 'string' }, description: '就绪证据：命令输出/文件路径/配置项/版本号/引用，与 prepared 一一对应' },
              },
              required: ['prepared', 'evidence'],
            },
            execution: {
              type: 'object',
              properties: {
                steps: { type: 'array', items: { type: 'string' }, description: '实际执行的步骤' },
                deviations: { type: 'array', items: { type: 'string' }, description: '偏离原思路的地方与原因' },
              },
              required: ['steps'],
            },
            verification: {
              type: 'object',
              properties: {
                allPassed: { type: 'boolean', description: '是否全部验证通过；未全部通过必须为 false' },
                checks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      criterion: { type: 'string', description: '对应的验收标准（A1/A2…）' },
                      method: { type: 'string', description: '用什么方式验证' },
                      evidence: { type: 'string', description: '命令输出/文件/引用' },
                    },
                    required: ['criterion', 'method', 'evidence'],
                  },
                },
                requirementCheck: { type: 'string', description: '逐条核对用户原要求的结果' },
                retrospective: {
                  type: 'object',
                  description: '第四步收尾的自我学习复盘：本次遇到的问题、走过的弯路、如何解决、以后如何预防再犯',
                  properties: {
                    problems: { type: 'array', items: { type: 'string' }, description: '本次全过程遇到的问题（现象 + 根因），至少 1 条' },
                    detours: { type: 'array', items: { type: 'string' }, description: '走过的弯路/返工/无效尝试；确实没有就写空数组' },
                    resolutions: { type: 'array', items: { type: 'string' }, description: '最终是如何解决的，至少 1 条' },
                    prevention: { type: 'array', items: { type: 'string' }, description: '以后如何预防再犯（遇到…先…），至少 1 条' },
                  },
                  required: ['problems', 'detours', 'resolutions', 'prevention'],
                },
              },
              required: ['allPassed', 'checks', 'retrospective'],
            },
          },
          required: ['planning', 'preparation', 'execution', 'verification'],
        },
      },
      required: ['phases'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          passed: { type: 'boolean' },
          phase: { type: 'string' },
          planId: { type: 'string' },
          subtaskId: { type: 'string' },
          summary: { type: 'string' },
          gaps: { type: 'array', items: { type: 'string' } },
          code: { type: 'string' },
          error: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          const gaps = Array.isArray(result.gaps) ? result.gaps.slice(0, 5).join('；') : ''
          return textContent(
            `插件核验未通过（${String(result.code ?? 'FAILED')}）：${String(result.error ?? '未知原因')}`
            + (gaps ? `｜需补齐：${gaps}` : '')
            + '｜先修复再回报，不要用 done 收尾。',
          )
        }
        return textContent(
          `${String(result.subtaskId ?? '')} 第四步核验通过：${String(result.summary ?? '')}`
          + '｜把同一份 phases 写进结果块后提交。',
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.verifyTool(exec.agent, parsed)
    },
  }
}

/**
 * [2.0.0] 永久教训记忆的只读入口（用户 2026-11-05 自我学习要求）。
 *
 * 不提供写动作：记忆只能由「第四步复盘通过 → 完成判定」这条链写入，
 * 防止主 Agent 事后手写一条“教训”绕过真实复盘证据。
 */
function createLessonsTool(runtime: any) {
  return {
    name: 'dsh_workplan_lessons',
    description:
      '查看 dsh-workplan 的永久教训记忆（部门完成工作后自动落盘的复盘）：'
      + 'action=list 按部门取最相关教训，action=search 按关键词检索，action=stats 看总数/重复数与文件位置。'
      + '只读，不修改计划状态；第四步验证时用它核对记住了什么、哪些同类错误在重复出现。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'stats'], description: '默认 list' },
        department: { type: 'string', description: 'list 时按部门筛选（如 engineering）' },
        query: { type: 'string', description: 'search 时的关键词' },
        limit: { type: 'number', description: '最多返回多少条（1–50，默认 10）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          total: { type: 'number' },
          repeated: { type: 'number' },
          lessons: { type: 'array', items: { type: 'object' } },
          departments: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) return textContent(`教训记忆读取失败：${String(result.error ?? '未知原因')}`)
        const file = String(result.file ?? '')
        if (Array.isArray(result.departments)) {
          const rows = result.departments.map((item: any) => `${item.department}:${item.count}`).join('、') || '（空）'
          return textContent(`永久教训记忆：共 ${String(result.total ?? 0)} 条，其中重复发生 ${String(result.repeated ?? 0)} 类；分布 ${rows}；文件 ${file}`)
        }
        const lessons = Array.isArray(result.lessons) ? result.lessons : []
        if (lessons.length === 0) return textContent(`永久教训记忆为空（${file}）`)
        const lines = lessons.slice(0, 8).map((item: any) =>
          `- [${String(item.department ?? '')}] ${String(item.title ?? '')}（${String(item.occurrences ?? 1)} 次）`
          + `｜问题：${String((item.problems ?? []).join('；'))}`
          + `｜预览：${String((item.prevention ?? []).join('；'))}`)
        return textContent(`永久教训记忆（${lessons.length}/${String(result.total ?? lessons.length)} 条，文件 ${file}）：\n${lines.join('\n')}`)
      },
    },
    async execute(args: any, exec: any) {
      return runtime.lessonsTool(exec.agent, asObject(args) ?? {})
    },
  }
}

/**
 * [1.11.0] 主 → 子的指示通道（T4 C-10 / T6 M6）。
 *
 * 服务端硬校验：调用者是目标子会话的直接父会话（根会话答复第一层部门行，
 * 部门负责人答复自己派出的第三层叶子；严格 lineage，非直系一律拒绝）、
 * 目标 `closure:'escalated'`、`childId` 是调用者直接子会话、instruction
 * 非空且 ≤4000 字符。投递失败时不改状态 —— 「我发了」与「它收到了」必须
 * 是两件事，否则界面会显示一个没人执行的指示。
 */
function createInstructTool(runtime: any) {
  return {
    name: 'dsh_workplan_instruct',
    description:
      '向一条「待指示」子任务下发决定：投递给对应子会话，并把该行恢复为执行中（closure=instructed）。'
      + '根会话可答复第一层部门行；部门负责人可答复自己派出的第三层专家（subtaskId 填自己的部门行 ID 或省略，用 member 或 sessionId 指定目标，二者至少其一）。'
      + '3.0.5 硬规则：第三层只能答复已经提交请示的原专家，投递成功后必须原专家继续执行；待指示期间负责人不得 review/dispatch/direct 改派。'
      + '只有目标子会话的直接父会话可调用，非直系一律拒绝；根路径只接受 closure=escalated 的行。'
      + '投递失败时状态不变（仍是待指示），按返回的 hint 重试或改用 dsh_workplan_update 明确放弃。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        subtaskId: {
          type: 'string',
          description: '待指示的子任务 ID，例如 T3。部门负责人答复第三层叶子时填自己的部门行 ID。',
        },
        member: {
          type: 'string',
          description: '可选：第三层成员名（delegates[].member）。仅部门负责人答复叶子时使用；与 sessionId 至少其一。',
        },
        sessionId: {
          type: 'string',
          description: '可选：目标叶子的子会话 ID（delegates[].childId）。仅部门负责人答复叶子时使用；与 member 至少其一；必须是调用者的直接子会话。',
        },
        instruction: {
          type: 'string',
          description: '要子 Agent 执行的决定：写清结论、约束与仍需保留的边界；不要只说“继续”。最多 4000 字符。',
        },
      },
      required: ['subtaskId', 'instruction'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          planId: { type: 'string' },
          subtaskId: { type: 'string' },
          status: { type: 'string' },
          closure: { type: 'string' },
          revision: { type: 'number' },
          messageId: { type: 'string' },
          deliveryReady: { type: 'boolean' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(
            `指示未下发：${String(result.error ?? result.code ?? '未知错误')}`
            + (result.hint ? `｜下一步：${String(result.hint)}` : ''),
          )
        }
        return textContent(
          `${String(result.subtaskId ?? '')} 已收到指示并恢复执行（revision ${String(result.revision ?? '')}）`
          + (result.messageId ? `，messageId ${String(result.messageId)}` : '')
          + '｜该行现在显示「已收到指示」；完成前仍不得交付，需等它回报结果。',
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.instructTool(exec.agent, parsed, exec.signal)
    },
  }
}

/**
 * [3.0.1] 认可闸门·显式按住（双保险中不依赖关键词识别的那一半）。
 * 与 dispatch 同款权限模型：注册在插件根，execute 内部 isRootSession 硬校验。
 */
function createHoldTool(runtime: any) {
  return {
    name: 'dsh_workplan_hold',
    description:
      '把当前会话尚未派发的计划设为「认可闸门」按住状态：在用户明确认可前，自动与手动派发都会被拒绝'
      + '（dsh_workplan_dispatch 返回 DISPATCH_HELD）。用于任务要求先经用户认可再执行、'
      + '而任务锚点又未被关键词识别命中的场景。只能设在尚未派发的计划上；已开跑的计划不设闸门。'
      + '解除唯一出口：用户明确认可后调用 dsh_workplan_release（登记留痕并开跑）。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        reason: {
          type: 'string',
          description: '按住原因（会写入闸门记录与 durable 留档）。',
        },
      },
    },
    /*
     * [3.0.1-激活热修] DSH tools.register() 的强制契约：每个工具必须声明
     * output { schema, render, presentationMeta? }（dsh-tools/src/index.ts
     * register() 校验，缺 output 或 render 非函数即抛 TypeError）。此前本工具
     * 把 render 直接挂在工具根上、整体缺 output 包裹，宿主注册即抛
     * 「tool "dsh_workplan_hold" must declare output { schema, render, presentationMeta? }」，
     * 整个插件条目启用失败（web/headless 两 profile 经符号链接同源皆挂）。
     * 此处与文件内其它 12 个工具同款写法对齐：schema 覆盖 runtime.holdTool 的
     * 全部返回形（ok/planId/alreadyHeld/hold/code/error），render 按宿主契约
     * 接收 (args, value) 并返回 ContentBlock[]（textContent）。
     */
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          planId: { type: 'string' },
          alreadyHeld: { type: 'boolean' },
          hold: { type: 'object', additionalProperties: true },
          code: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(`未能按住计划：${String(result.error ?? '未知错误')}（${String(result.code ?? '')}）`)
        }
        if (result.alreadyHeld) return textContent('计划已在认可闸门之下，无需重复按住。')
        return textContent(`计划 ${String(result.planId ?? '')} 已设为认可闸门按住：用户明确认可前不得派发。`)
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.holdTool(exec.agent, parsed)
    },
  }
}

/**
 * [3.0.1] 认可闸门·解除并开跑：「用户已明确认可」的唯一合法出口。
 */
function createReleaseTool(runtime: any) {
  return {
    name: 'dsh_workplan_release',
    description:
      '解除当前会话计划的「认可闸门」并立即派发：先登记用户认可的留痕（gateHistory，durable 回放不丢），'
      + '再调用派发链（与 dsh_workplan_dispatch 同一套闸门：终态/startPhases 等照常生效）。'
      + '仅当计划处于认可闸门之下时可用；若派发因 startPhases 等门禁被拒，闸门保持已解除，'
      + '补齐后直接重发 dispatch 即可，认可事实无需重来。仅根会话可用。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        note: {
          type: 'string',
          description: '用户认可的留痕备注（例如认可的原文摘要），写入 gateHistory。',
        },
        startPhases: {
          type: 'object',
          description: '可选：随解除一并提交的主 Agent 五步第 1/2/3 步开工证据（与 dsh_workplan_dispatch.startPhases 同形状）；提供则解除后立即开跑，缺省则派发按 START_EVIDENCE_MISSING 门禁返回补交指引。',
          properties: {
            planning: {
              type: 'object',
              properties: {
                problemAnalysis: { type: 'array', items: { type: 'string' } },
                resources: { type: 'array', items: { type: 'string' } },
                tools: { type: 'array', items: { type: 'string' } },
                approach: { type: 'array', items: { type: 'string' } },
                approachBasis: { type: 'array', items: { type: 'string' } },
              },
              required: ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'],
            },
            preparation: {
              type: 'object',
              properties: {
                prepared: { type: 'array', items: { type: 'string' } },
                evidence: { type: 'array', items: { type: 'string' } },
              },
              required: ['prepared', 'evidence'],
            },
          },
          required: ['planning', 'preparation'],
        },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: '可选：解除后的派发模式，语义与 dsh_workplan_dispatch.mode 相同。',
        },
      },
    },
    /*
     * [3.0.1-激活热修] 与 dsh_workplan_hold 同款契约修复：output { schema, render }
     * 为 tools.register() 强制项。schema 覆盖 runtime.releaseTool 的全部返回形
     * （ok/gateReleased/planId/note/hold/dispatch/code/error；dispatch 为 dispatchTool
     * 的完整结果对象，保持开放对象不裁剪）。render 语义修正：判定「未能解除」
     * 以 gateReleased 为准——原实现只看 ok===false，会把「闸门已解除但 startPhases
     * 门禁拒派发」误报成未解除（该分支 ok 恰为 false 但闸门已松）。
     */
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          gateReleased: { type: 'boolean' },
          planId: { type: 'string' },
          note: { type: 'string' },
          hold: { type: 'object', additionalProperties: true },
          dispatch: { type: 'object', additionalProperties: true },
          code: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (result.gateReleased !== true) {
          return textContent(`未能解除闸门：${String(result.error ?? '未知错误')}（${String(result.code ?? '')}）`)
        }
        if (result.dispatch && result.dispatch.ok === false) {
          return textContent(`认可闸门已解除，但派发未通过：${String(result.dispatch.error ?? '')}（${String(result.dispatch.code ?? '')}）`)
        }
        return textContent(`认可闸门已解除（${String(result.hold?.reason ?? '')}），计划已开始执行。`)
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.releaseTool(exec.agent, parsed, exec.signal)
    },
  }
}

/**
 * [1.11.0] 跨部门需求的处置入口（用户 m00687）。
 *
 * 子 Agent 提出的 `needs` 会自动变成一条 open handoff，并进入交付门禁；
 * 只有根会话能用本工具把需求指派给部门、写入答复或判定无需动作。这是
 * 「跨部门协作必须有始有终」的唯一人工出口，避免需求只停留在提示词文本里。
 */
function createHandoffTool(runtime: any) {
  return {
    name: 'dsh_workplan_handoff',
    description:
      '处置跨部门需求（needs）。子 Agent 每条 needs 都会登记为待处理需求，未处置会拦住交付。插件没有常驻部门代理：assign 只登记责任，实际产出要用 dsh_workplan_replan(action=add) 建子任务或由你完成；被答复的行若在「待指示」，resolve 会把答复直接投递给子会话。'
      + '动作：list 列出全部待处理需求；assign 指派给某个部门（department）；'
      + 'resolve 写入书面答复或产物引用（response），表示需求已满足；close 判定无需动作。'
      + '只有根会话可调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'assign', 'resolve', 'close'],
          description: 'list=查看；assign=指派部门；resolve=写入答复并解除阻塞；close=判定无需动作。',
        },
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        subtaskId: {
          type: 'string',
          description: '提出该需求的子任务 ID。除 list 外必填。',
        },
        handoffId: {
          type: 'string',
          description: '需求编号（如 H1）；省略时处理该行第一条 open/routed 需求。',
        },
        department: {
          type: 'string',
          description: 'assign 必填：负责满足该需求的部门 ID。',
        },
        response: {
          type: 'string',
          description: 'resolve 必填：写清答复，或指出已由哪项产物/子任务满足该需求。最多 4000 字符。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          planId: { type: 'string' },
          subtaskId: { type: 'string' },
          handoff: { type: 'object' },
          count: { type: 'number' },
          handoffs: { type: 'array' },
          deliveryReady: { type: 'boolean' },
          code: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) {
          return textContent(`处置未生效：${String(result.error ?? result.code ?? '未知错误')}`)
        }
        if (Array.isArray(result.handoffs)) {
          if (result.handoffs.length === 0) return textContent('没有待处理的跨部门需求。')
          return textContent(
            `待处理跨部门需求 ${result.handoffs.length} 条：\n`
            + result.handoffs.slice(0, 10).map((item: any) =>
              `- ${String(item.subtaskId)} ${String(item.id)}｜${String(item.status)}`
              + `${item.department ? ` → ${String(item.department)}` : ''}｜${String(item.request)}`).join('\n'),
          )
        }
        return textContent(
          `${String(result.subtaskId ?? '')} ${String(result.handoff?.id ?? '')} 已更新为 ${String(result.handoff?.status ?? '')}`
          + `｜${result.deliveryReady === true ? '交付门禁已通过' : '交付门禁仍未通过'}`
          + `｜${String(result.hint ?? '')}`,
        )
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.handoffTool(exec.agent, parsed, exec.signal)
    },
  }
}

function createStatusTool(runtime: any) {
  return {
    name: 'dsh_workplan_status',
    description:
      '只读查看当前计划各子任务的实时状态与进度，不启动任何 Agent、不改任何状态。'
      + '在 async 派发之后、或用户问“做到哪了”时使用；它是进度问题的唯一可信来源。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: statusToolOutputSchema(),
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        const stats = isRecord(result.stats) ? result.stats : {}
        const runtimeInfo = isRecord(result.runtime) ? result.runtime : {}
        /*
         * [1.8.14] Every answer names the loaded build, including the failure
         * path. The restart verification in the incident report (§14.6 step 2)
         * called `status` before any plan existed and got bare `NO_PLAN`, so it
         * could not confirm which build was answering.
         */
        const startedAt = Number(runtimeInfo.startedAt) || 0
        const identity = [
          typeof result.version === 'string' ? `v${result.version}` : '',
          typeof runtimeInfo.buildHash === 'string' ? `build ${runtimeInfo.buildHash}` : '',
          Number(runtimeInfo.pid) > 0 ? `pid ${Number(runtimeInfo.pid)}` : '',
          startedAt > 0
            ? `启动 ${new Date(startedAt).toLocaleString('zh-CN', { hour12: false })}`
            : '',
        ].filter(Boolean).join('｜')
        if (!result.ok) {
          return textContent(
            `查询失败：${String(result.error ?? '未知错误')}`
            + (identity ? `（${identity}）` : ''),
          )
        }
        const running = result.running === true
        const planner = isRecord(result.planner) ? result.planner : null
        const statuses = Array.isArray(result.statuses) ? result.statuses : []
        /*
         * [2.2.3][N1] 模型可见面补齐：planner 与 noticeChannel 之前只进结构化
         * value，DSH 只把 render 文本写进对话，导致 D5/D1-b 结构性不可读。
         * 这里只做只读展示，不改变状态机；缺失字段不编造。
         */
        const plannerLine = planner
          ? `规划器：推理等级 ${String(planner.reasoningEffort ?? '未记录')}`
            + `｜来源 ${String(planner.reasoningEffortSource ?? '未记录')}`
            + `｜判定 ${String(planner.outcome ?? '未记录')}`
            + (typeof planner.model === 'string' && planner.model ? `｜模型 ${planner.model}` : '')
          : ''
        const channelLines = statuses
          .filter((item: any) => isRecord(item?.noticeChannel))
          .slice(0, 12)
          .map((item: any) => {
            const channel = item.noticeChannel
            const at = Number(channel.at) > 0
              ? new Date(Number(channel.at)).toLocaleString('zh-CN', { hour12: false })
              : '—'
            const observedAt = Number(channel.observedAt) > 0
              ? new Date(Number(channel.observedAt)).toLocaleString('zh-CN', { hour12: false })
              : '—'
            return `${String(item.subtaskId ?? '')} 通道：${String(channel.state ?? '')}`
              + `｜target ${String(channel.target ?? '—')}`
              + `｜caller ${String(channel.caller ?? '—')}`
              + `｜at ${at}`
              + `｜observedAt ${observedAt}`
              + `｜reason ${String(channel.reason ?? '—')}`
          })
        return textContent([
          `计划 ${String(result.planId ?? '')}｜${running ? '执行中' : '未在执行'}`
          + `｜阶段：${phaseLabel(result.phase)}`
          + `｜完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}，受阻 ${Number(stats.blocked ?? 0)}`
          + `｜${result.deliveryReady === true ? '可交付' : '未就绪'}`
          + (running && Number(result.elapsedMs ?? 0) > 0
            ? `｜已 ${Math.round(Number(result.elapsedMs) / 1000)}s`
            : '')
          + (identity ? `｜${identity}` : ''),
          plannerLine,
          ...channelLines,
        ].filter(Boolean).join('\n'))
      },
    },
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.statusTool(exec.agent, parsed)
    },
  }
}

function createDispatchTool(runtime: any) {
  return {
    name: 'dsh_workplan_dispatch',
    description:
      '派发当前会话尚未执行的任务分解计划。计划显示后必须先调用本工具；wait 会等到本轮结束，'
      + '把 durable 结果写入会话并返回每个子任务的状态/摘要。'
      + '【3.0.8 主 Agent 五步开工证据协议】执行自己的任务必须先完成前三步：全面、全盘、深入梳理、研究、思考自己的任务（第一步任务梳理），'
      + '基于第一步完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，研究需要哪些资源、哪些工具、理清具体一步步以最高效率、少走弯路、完美完成任务的方法、流程和步骤（第二步资源/工具/方案研究，含依据），'
      + '再把资源与工具真正备齐并给出就绪证据（第三步准备就绪）；最后才基于第二步的方法、流程、步骤开始执行：首次派发必须随附 startPhases 开工证据，未提交或不合格被硬门禁拒绝'
      + '（START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE）；登记后持久化，续跑/重试/重启回放自动读档，无需重复提交；重规划的新计划须重新提交。'
      + '返回值里的 complete=false 表示计划还没做完（可能只是本轮预算用尽），此时必须再次派发续跑，'
      + '不得把当前产物当作最终结果。重复调用是幂等的。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        mode: {
          type: 'string',
          enum: ['wait', 'async'],
          description: '默认 wait：等本轮结束后返回完整结果。async：立即返回 running，'
            + '本轮结束时自动写入结果消息；期间用 dsh_workplan_status 查看进度。',
        },
        startPhases: {
          type: 'object',
          description: '主 Agent 五步第 1/2/3 步开工证据（本计划首次派发必填；已登记后续跑/重启自动读档）：第一步全面、全盘、深入梳理、研究、思考自己的任务；第二步基于第一步完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，研究需要哪些资源、哪些工具、理清具体一步步执行、完美完成任务的方法、流程和步骤，并写清第二步基于第一步全部结果的依据；第三步把资源与工具真正备齐并给出就绪证据。派发顺序、督战、验收与交付必须按第二步理清的方法、流程、步骤执行。',
          properties: {
            planning: {
              type: 'object',
              properties: {
                problemAnalysis: { type: 'array', items: { type: 'string' }, description: '第一步 · 任务梳理：全面、全盘、深入梳理、研究、思考自己的任务（目标与验收/现状/事实/约束/未知/主要矛盾/边界逐条写清），至少 1 条、合计 ≥40 字。' },
                resources: { type: 'array', items: { type: 'string' }, description: '第二步 · 资源研究：基于第一步全部结果，研究需要哪些资源（数据/文件/权限/人/知识/时间），至少 1 项、合计 ≥20 字。' },
                tools: { type: 'array', items: { type: 'string' }, description: '第二步 · 工具研究：需要哪些工具、每个工具用来做什么，至少 1 项、合计 ≥10 字。' },
                approach: { type: 'array', items: { type: 'string' }, description: '第二步 · 方法流程步骤：理清的具体一步步执行、完美完成任务的方法、流程和步骤（派发顺序/督战/验收/交付如何做、如何证明），至少 1 条、合计 ≥40 字。' },
                approachBasis: { type: 'array', items: { type: 'string' }, description: '第二步依据（必填）：第二步如何基于第一步完成好的所有结果——第一步的哪些事实/约束/矛盾决定了第二步的哪些资源/工具/步骤，至少 1 条、合计 ≥20 字。' },
              },
              required: ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'],
              additionalProperties: false,
            },
            preparation: {
              type: 'object',
              properties: {
                prepared: { type: 'array', items: { type: 'string' }, description: '第三步 · 已备齐的资源与工具清单（每项写清：准备了什么、在哪里、是否可用），至少 1 项、合计 ≥20 字。' },
                evidence: { type: 'array', items: { type: 'string' }, description: '第三步 · 就绪证据：命令输出/文件路径/配置项/版本号/引用，至少 1 条、合计 ≥20 字。' },
              },
              required: ['prepared', 'evidence'],
              additionalProperties: false,
            },
          },
          required: ['planning', 'preparation'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: dispatchToolOutputSchema(),
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        const stats = isRecord(result.stats) ? result.stats : {}
        const done = Number(stats.done ?? 0)
        const total = Number(stats.total ?? 0)
        const blocked = Number(stats.blocked ?? 0)
        const remaining = Math.max(0, total - done)
        const name = `计划 ${String(result.planId ?? '')}`
        if (!result.ok) {
          // The hint carries the recovery instruction (resume, or take the work
          // over directly); showing it in the rendered line keeps it visible
          // even when only the summary is read.
          return textContent(`派发失败：${String(result.error ?? '未知错误')}${result.hint ? `｜下一步：${String(result.hint)}` : ''}`)
        }
        /*
         * [1.8.7] The first word decides how the model reads the round.
         *
         * Incident: `ok:true` + "已加入进行中的派发并等到结果（完成 10/13）"
         * read as "done", so the model presented a half-finished report. Now an
         * unfinished round starts with 未完成 and states the only legal next
         * move; a finished one is the only place the word 已完成 appears.
         */
        if (result.mode === 'async' || (result.running === true && result.joined !== true)) {
          return textContent(
            `${name} 已开跑，尚未完成：当前完成 ${done}/${total}，剩余 ${remaining} 项由本轮执行`
            + `（${Math.round(elapsedSeconds(result) / 1000)}s）`
            + '｜不要重复派发；结果消息会在本轮结束时自动写入。在结果消息到达并确认 complete=true 之前，不要给最终答复。',
          )
        }
        /*
         * [1.8.13] All rows done is not the finish line.
         *
         * T5-B/D: every row said done, no structured evidence, and this branch
         * printed 已完成 — the model then presented. Only deliveryReady=true
         * reaches the completion sentence; every other state names the gaps and
         * the legal next move (dispatch, fix evidence, or report unfinished).
         */
        if (result.deliveryReady === true) {
          return textContent(
            `${name} 已完成且可交付：完成 ${done}/${total}，证据通过`
            + (result.joined ? '｜已加入进行中的派发并等到结果' : ''),
          )
        }
        const blockers = Array.isArray(result.deliveryBlockers) ? result.deliveryBlockers.slice(0, 6).join('；') : ''
        const cancelled = result.phase === 'cancelled'
        const next = cancelled
          ? '计划已取消且未完成：不要再次 dispatch，不要 present；答复按「未完成：剩余 N 项与原因」开头。'
          : remaining > 0
            ? '下一步：再次调用 dsh_workplan_dispatch 续跑剩余项；全部 done 之前不要 present。'
            : "全部子任务虽已 done，但证据未通过：用 dsh_workplan_update 补 verification='structured' 与 acceptance（每项 result='pass'），或把对应项改回 blocked；不要 present。"
        return textContent(
          `${name} 未就绪：完成 ${done}/${total}，剩余 ${remaining} 项，受阻 ${blocked}（${phaseLabel(result.phase)}）`
          + (blockers ? `｜证据缺口：${blockers}` : '')
          + (result.joined ? '｜本轮已返回，但计划没有达到可交付状态' : '')
          + `｜${next}｜不要写“已完成/最终版/已交付”，不要给收尾性最终答复。`,
        )
      },
    },
    // 不声明 timeoutMs：部门与专家执行没有工具层 24 小时或预算派生截止。
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.dispatchTool(exec.agent, parsed, exec.signal)
    },
  }
}

/*
 * [3.0.1] Legacy limit readers.
 *
 * childTimeoutMs / idleTimeoutMs / totalTimeoutMs and their environment
 * variables are still accepted so old profile configs do not fail validation,
 * but the runtime no longer arms any deadline from them. They must not be
 * documented or used as a way to limit department-lead or expert execution.
 */
/**
 * [1.10.4] 布尔开关：配置项优先，其次环境变量。
 *
 * 与 `numericSetting` 不同，显式 `false` 必须能被表达，所以先判 boolean；
 * 环境变量只接受 1/true/yes/on，大小写不敏感。未配置时返回 `false`。
 *
 * [1.10.6] 注意：`autoResume` 已改用 `autoResumeEnabledFrom`（默认开启，
 * 且 `0/false/no/off` 可以显式关闭）。本函数保留给「默认关闭」语义的开关。
 */
/**
 * [1.11.0] `strictCompletion` 的三态解析：显式配置 > 显式环境变量 > 默认 true。
 *
 * 不能复用 `booleanSetting`：那个函数「未配置即 false」，会把默认开启的
 * 完成门禁反过来关掉（1.10.6 的 autoResume 就栽在这上面）。
 */
function strictCompletionEnabledFrom(configValue: any, envValue: any) {
  if (typeof configValue === 'boolean') return configValue
  const raw = envValue === undefined || envValue === null ? '' : String(envValue).trim()
  if (raw !== '') {
    if (/^(1|true|yes|on)$/i.test(raw)) return true
    if (/^(0|false|no|off)$/i.test(raw)) return false
  }
  return true
}

/**
 * [1.12.3] `failClosedOnIncomplete` 的三态解析：显式配置 > 显式环境变量 > 'auto'。
 *
 * 与 `strictCompletionEnabledFrom` 的区别只在默认值：这里未配置时返回 `'auto'`，
 * 语义是「headless 才硬失败」，不能退化成 `false`（那等于默认关闭，事故会复发），
 * 也不能退化成 `true`（那会让交互式会话在收尾时抛错）。
 */
function failClosedOnIncompleteFrom(configValue: any, envValue: any): boolean | 'auto' {
  if (typeof configValue === 'boolean') return configValue
  const raw = envValue === undefined || envValue === null ? '' : String(envValue).trim()
  if (raw !== '') {
    if (/^(1|true|yes|on)$/i.test(raw)) return true
    if (/^(0|false|no|off)$/i.test(raw)) return false
  }
  return 'auto'
}

function booleanSetting(configValue: any, envName: string) {
  if (typeof configValue === 'boolean') return configValue
  const raw = typeof process !== 'undefined' ? process.env?.[envName] : undefined
  if (raw === undefined || raw === '') return false
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/** [1.10.6] 原样读取环境变量，供三态解析使用（未设置返回 undefined）。 */
function settingEnv(envName: string) {
  return typeof process !== 'undefined' ? process.env?.[envName] : undefined
}

function numericSetting(configValue: any, envName: string, allowZero = false) {
  const positive = (value: number) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
  if (configValue !== undefined && configValue !== null && configValue !== '') {
    const numeric = Number(configValue)
    if (positive(numeric)) return numeric
  }
  const raw = typeof process !== 'undefined' ? process.env?.[envName] : undefined
  if (raw === undefined || raw === '') return undefined
  const numeric = Number(raw)
  return positive(numeric) ? numeric : undefined
}

/**
 * Hard, tool-level guards. Kept as a pure function so the contracts can be
 * pinned without mounting the whole plugin:
 *  - plan mode：只拦住 dispatch，其他工具保持可用（避免死锁）；
 *  - `present`：计划未完成时由 runtime 拒绝（事故中模型在收尾闸门之前
 *    present，卡片一旦出现就无法撤回）。
 */
export function toolGuardReason(
  exec: any,
  runtime: { planModeActive(session: any): boolean; presentDenialReason(agent: any): string | undefined },
) {
  if (exec?.name === 'dsh_workplan_dispatch' || exec?.name === 'dsh_workplan_release') {
    const session = exec?.agent?.session
    if (session && runtime.planModeActive(session)) {
      return exec?.name === 'dsh_workplan_release'
        ? '当前是 plan 模式：计划尚待用户审阅，不能用 dsh_workplan_release 绕过审阅直接开跑；请用户退出 plan 模式后再解除闸门/派发。'
        : '当前是 plan 模式：计划已生成，请先让用户审阅/退出 plan 模式，再调用 dsh_workplan_dispatch。'
    }
    return undefined
  }
  if (exec?.name === 'present') return runtime.presentDenialReason(exec?.agent)
  return undefined
}

export function apply(ctx: any, config: WorkplanConfig = {}) {
  const runtime = createWorkplanRuntime(ctx, {
    // [1.8.13] The answering version must be visible in status/dispatch output,
    // not inferred from the PID.
    version: meta.version,
    // [1.8.14] ...and so must the exact loaded build (see LOADED_BUILD above).
    build: {
      pid: process.pid,
      startedAt: PROCESS_STARTED_AT,
      entryPath: LOADED_BUILD.entryPath,
      buildHash: LOADED_BUILD.buildHash,
    },
    cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
    plannerTimeoutMs: numericSetting(config.plannerTimeoutMs, 'DSH_WORKPLAN_PLANNER_TIMEOUT_MS'),
    plannerIdleTimeoutMs: numericSetting(config.plannerIdleTimeoutMs, 'DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS'),
    childTimeoutMs: numericSetting(config.childTimeoutMs, 'DSH_WORKPLAN_CHILD_TIMEOUT_MS'),
    idleTimeoutMs: numericSetting(config.idleTimeoutMs, 'DSH_WORKPLAN_IDLE_TIMEOUT_MS'),
    totalTimeoutMs: numericSetting(config.totalTimeoutMs, 'DSH_WORKPLAN_TOTAL_TIMEOUT_MS', true),
    maxResumes: numericSetting(config.maxResumes, 'DSH_WORKPLAN_MAX_RESUMES'),
    /*
     * [1.10.6] 三态解析：显式配置 > 显式环境变量 > 默认开启。
     * 旧实现用 `booleanSetting(..., false)`，未配置即等于关闭，于是「预算到点
     * 自动续跑」这个能力在用户机器上从来没打开过（1h57m 空窗的直接原因）。
     */
    autoResume: autoResumeEnabledFrom(config.autoResume, settingEnv('DSH_WORKPLAN_AUTO_RESUME')),
    autoResumeMaxAttempts: numericSetting(config.autoResumeMaxAttempts, 'DSH_WORKPLAN_AUTO_RESUME_MAX'),
    /*
     * [1.11.0] 三态解析（显式配置 > 显式环境变量 > 默认 true）。
     * 与 autoResume 用同一种写法：未配置时走默认值，而不是悄悄等于 false。
     */
    strictEvidence: strictCompletionEnabledFrom(config.strictCompletion, settingEnv('DSH_WORKPLAN_STRICT_COMPLETION')),
    /*
     * [1.12.0] 自动派发三态：显式配置 > 显式环境变量 > 默认 true。
     * 与 autoResume / strictCompletion 同一写法，避免「没配置就等于关闭」。
     */
    autoDispatch: strictCompletionEnabledFrom(config.autoDispatch, settingEnv('DSH_WORKPLAN_AUTO_DISPATCH')),
    /*
     * [1.12.3] headless「未完成不得成功收尾」。默认 'auto'：只有 headless
     * 运行上下文（提供 `headlessStartup` 服务）才硬失败，交互式会话不受影响。
     */
    failClosedOnIncomplete: failClosedOnIncompleteFrom(
      config.failClosedOnIncomplete,
      settingEnv('DSH_WORKPLAN_FAIL_CLOSED_ON_INCOMPLETE'),
    ),
    turnStoppingMaxWaitMs: numericSetting(config.turnStoppingMaxWaitMs, 'DSH_WORKPLAN_TURN_STOPPING_MAX_WAIT_MS', true),
  })

  /*
   * [3.0.6][第 2 批] 可选留痕清理：默认关闭（0 = 永久保留证据）。
   * 只有显式配置正数时才启用；启动先跑一次，之后每 24 小时一次。
   */
  const journalRetentionDays = (() => {
    const configured = numericSetting(config.journalRetentionDays, 'DSH_WORKPLAN_JOURNAL_RETENTION_DAYS', true)
    return configured !== undefined && configured > 0 ? Math.min(configured, 3650) : 0
  })()
  if (journalRetentionDays > 0) {
    const prune = () => {
      const result = pruneJournal({ retentionDays: journalRetentionDays, excludePlanIds: activePlanIdSet(runtime) })
      if (!result.ok) ctx.logger?.warn?.(`[dsh-workplan] journal 清理失败：${result.error}`)
      // 删除失败逐条 warn（ok 仍为 true，errors[] 是弱错误通道，不得静默）。
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        for (const line of result.errors) console.warn(`[dsh-workplan] journal 清理异常：${String(line)}`)
      }
      return result
    }
    ctx.effect(() => {
      /*
       * [复审修复] 首次清理从激活同步路径挪到 10s 后：激活是同步路径，不能
       * 当场扫盘（readdir/stat 大目录会拖住插件注册）。卸载时清除——
       * journalRetentionTimer 同款的 ctx.effect 清理模式。
       */
      const firstPruneTimer = setTimeout(prune, 10_000)
      if (typeof firstPruneTimer?.unref === 'function') firstPruneTimer.unref()
      return () => clearTimeout(firstPruneTimer)
    })
    ctx.effect(() => {
      // 卫生类：不触发只少一次清理，不得拖住正在关闭的宿主。
      const journalRetentionTimer = setInterval(prune, 24 * 60 * 60 * 1000)
      if (typeof journalRetentionTimer?.unref === 'function') journalRetentionTimer.unref()
      return () => clearInterval(journalRetentionTimer)
    })
  }

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'dsh-workplan',
      order: PROMPT_ORDER,
      text: PROMPT_SECTION,
    }),
  )

  ctx.effect(() => ctx.tools.register(createUpdateTool(runtime)))
  ctx.effect(() => ctx.tools.register(createCancelTool(runtime)))
  ctx.effect(() => ctx.tools.register(createStatusTool(runtime)))
  ctx.effect(() => ctx.tools.register(createFollowupTool(runtime)))
  /*
   * [1.11.0] 闭环的两条工具通道（T4 C-09 / C-10）。
   *
   * `escalate` 必须对子会话可见（子 Agent 是它的唯一调用者），`instruct`
   * 必须只有根会话可用（服务端 `isRootSession` 硬校验，不依赖提示词）。
   * 注册在插件根与其它工具一致：宿主按会话注入哪些工具由平台决定，插件
   * 侧不做过滤；权限判断一律落在 execute 内部。
   */
  ctx.effect(() => ctx.tools.register(createEscalateTool(runtime)))
  /*
   * [2.3.9][T4b] 第三层派发（用户要求 4/5）：与 escalate 同款权限模型——
   * 注册在插件根、对所有会话可见，runtime.delegateTool 内部按「调用者必须是
   * 计划内某行的部门负责人子会话」硬校验；根会话与第三层叶子会话都会被拒。
   */
  ctx.effect(() => ctx.tools.register(createDelegateTool(runtime)))
  /* [1.13.0→3.0.8] 第四步核验：子会话唯一可用的插件工作能力，前三步会被 PHASE_GATE 拒绝。 */
  ctx.effect(() => ctx.tools.register(createVerifyTool(runtime)))
  /* [2.0.0] 永久教训记忆的只读复核入口（第四步验证用）。 */
  ctx.effect(() => ctx.tools.register(createLessonsTool(runtime)))
  ctx.effect(() => ctx.tools.register(createInstructTool(runtime)))
  /*
   * [1.11.0] 需求变更的重规划入口（T4 C-11 / T7）。
   *
   * 根会话工具：子 Agent 不能改写主计划（execute 内部 `isRootSession` 硬校验）。
   * 它只在“计划定义需要改”时使用；执行中调用会拒绝改计划但保留变更原文。
   */
  ctx.effect(() => ctx.tools.register(createReplanTool(runtime)))
  /*
   * [1.11.0] 跨部门需求处置（用户 m00687）：注册在根插件上，`execute` 内部
   * 用 `isRootSession` 硬校验，子会话即使拿到工具表也无法处置需求。
   */
  ctx.effect(() => ctx.tools.register(createHandoffTool(runtime)))
  ctx.effect(() => ctx.tools.register(createDispatchTool(runtime)))
  /* [3.0.1] 认可闸门：显式按住 / 解除并开跑，与 dispatch 同款根会话硬校验。 */
  ctx.effect(() => ctx.tools.register(createHoldTool(runtime)))
  ctx.effect(() => ctx.tools.register(createReleaseTool(runtime)))

  /*
   * Plan mode produces a plan for review, not department execution. Denying
   * only the dispatch tool keeps every other tool available (no deadlock)
   * and gives the model a precise reason instead of a silent no-op.
   *
   * [1.8.8] `present` 也在执行前拦截：事故里模型在回合中途就把未完成
   * 的产物 present 出去，回合收尾闸门再拦已经撤不回卡片。计划未完成时
   * 拒绝交付，模型必须先续跑或显式取消计划。
   */
  ctx.effect(() => ctx.tools.guard((exec: any) => toolGuardReason(exec, runtime)))

  ctx.effect(() => ctx.on('agent/pre-step', runtime.onPreStep))
  /*
   * [3.0.1] 后台规划等待期间，followup/queue 可能还没进入下一次 pre-step。
   * 在官方 inbox 插入事件处立即取代旧规划，避免旧结果迟到覆盖新任务。
   */
  ctx.effect(() => ctx.on('agent/inbox/inserted', runtime.onInboxInserted))
  /*
   * [1.8.7] 回合收尾前的闸门。官方 `agent/turn-stopping` 是 serial 事件、
   * 在边界提交前被 await；监听器 `agent.steer()` 后机器会重读 inbox，于是
   * 「计划没做完」时回合不会被关闭。这是「未完成即输出」的唯一强制点：
   * 提示词和工具文案只能说服模型，这个事件能拦住收尾本身。
   */
  ctx.effect(() => ctx.on('agent/turn-stopping', runtime.onTurnStopping))
  ctx.effect(() => ctx.tools.guard((exec: any) => fileWriteGuardReason(exec, runtime)))

  ctx.inject(['webServer', 'connection'], (scope: any) => {
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: '/dsh-workplan/plans',
        handler: (req: any, res: any) => runtime.route(req, res, scope),
      }),
    )
    /*
     * Chart.js is vendored (vendor/chart.umd.js, MIT) instead of bundled: the
     * client half is a hand-written module-registry factory with no bundler, so
     * the page loads the library as a same-origin script and falls back to the
     * built-in CSS charts when it cannot load.
     */
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: '/dsh-workplan/vendor/chart.umd.js',
        handler: (req: any, res: any) => {
          applyHardeningHeaders(res)
          /*
           * [1.8.1] Read-only, and it stays read-only: the file path is a
           * constant (never built from the request URL) and only GET/HEAD are
           * answered. It deliberately does NOT call
           * `connection.requestRejection`: this is a public, non-sensitive
           * static asset with no per-user data. `/dsh-workplan/plans` is the
           * route that carries data, and that one is auth-checked in
           * `runtime.route()`. SECURITY.md states this asymmetry explicitly.
           */
          if (req?.method !== 'GET' && req?.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD')
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end()
            return
          }
          try {
            if (!chartVendorBytes) {
              chartVendorBytes = readFileSync(new URL('../vendor/chart.umd.js', import.meta.url))
            }
            const body = chartVendorBytes
            res.statusCode = 200
            res.setHeader('content-type', 'text/javascript; charset=utf-8')
            res.setHeader('cache-control', 'public, max-age=3600')
            res.end(req?.method === 'HEAD' ? undefined : body)
          } catch (error) {
            res.statusCode = 404
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('chart.js not found')
          }
        },
      }),
    )
  })

  ctx.effect(() => () => runtime.dispose())

  /*
   * [3.0.6][复审修复] 把 runtime 句柄交还给调用方：宿主契约不消费本返回值
   * （清理一律经上方 effect），测试与宿主编排需要观察 state.records /
   * 替换 startAutoDispatch 时可直接拿到同一实例，不必从工具闭包里挖。
   */
  return runtime
}

export const meta = {
  name,
  version: '3.1.1',
  promptOrder: PROMPT_ORDER,
  routes: ['/dsh-workplan/plans', '/dsh-workplan/vendor/chart.umd.js'],
}

export { PROMPT_SECTION, createCancelTool, createDelegateTool, createDispatchTool, createEscalateTool, createHandoffTool, createInstructTool, createLessonsTool, createReplanTool, createStatusTool, createUpdateTool, plannerOutputSchema }

/**
 * [1.8.18] 写工具的路径级闸门（T7-N2），与 `toolGuardReason` 分开注册。
 *
 * present/dispatch 的语义是「计划未就绪不能交付」；这里管的是「已交付的
 * 文件不能在计划未就绪时被原地改写」。两条守卫都返回拒绝原因，harness
 * 取第一个非空原因，互不覆盖。
 */
export function fileWriteGuardReason(
  exec: any,
  runtime: {
    presentedWriteDenialReason(agent: any, args: any): string | undefined
    writeTargets(agent: any, args: any): string[]
  },
) {
  /*
   * [复审修复] bash 写保护绕过：shell 类工具的 command 字符串（重定向/heredoc/
   * tee/sed -i/cp/mv）此前因参数形状不认（无 file_path/path）而整类绕过闸门。
   * 先解析出 shell 写目标（非 shell 调用为 null），形状闸门与 shell 闸门至少
   * 命中其一才继续。
   */
  const shellTargets = shellWriteTargets(exec)
  if (!isWriteShapedCall(exec) && shellTargets === null) return undefined
  // The three historical write tools pass their arguments through untouched, so
  // their behaviour stays exactly as before (argument-shape matching is only an
  // EXTENSION: a tool that used to be denied is still denied the same way).
  const direct = exec?.name === 'write' || exec?.name === 'edit' || exec?.name === 'str_replace_editor'
  const reason = direct ? runtime.presentedWriteDenialReason(exec?.agent, exec?.arguments) : undefined
  if (typeof reason === 'string') return reason
  // [1.12.2] G2: a single call can touch several files (apply_patch hunks).
  // Deny the call as a whole if any of its targets is a protected deliverable.
  for (const target of runtime.writeTargets(exec?.agent, exec?.arguments) ?? []) {
    const extra = runtime.presentedWriteDenialReason(exec?.agent, { file_path: target })
    if (typeof extra === 'string') return extra
  }
  /*
   * [复审修复] shell 写目标：与上面同一判定出口——只拦「写入已交付文件」，
   * 纯读命令（cat/grep/less 该路径）解析不出写目标，天然放行。
   * 启发式局限（保守模式）：只认 > / >> 重定向、tee、sed -i、mv/cp/install/dd
   * 的目标；命令拼接变量（cmd=path; $cmd）、eval、find -delete 等动态写法
   * 不在解析范围内——见 shellWriteTargets 注释。
   */
  if (shellTargets) {
    for (const target of shellTargets) {
      const extra = runtime.presentedWriteDenialReason(exec?.agent, { file_path: target })
      if (typeof extra === 'string') return extra
    }
  }
  return undefined
}

/*
 * [复审修复] 活跃 planId 集合：pruneJournal 只看 mtime，「活跃但安静」的计划
 * （久无新留痕、mtime 变旧）会被误删；把当前活跃 planId 传给 excludePlanIds
 * 即可保住。planning 在途时尚未铸出 planId（planId 在规划完成后才生成，占位
 * 记录 planId=null），因此 runtime.state.records 就是全部活跃 planId 的事实源。
 * 导出以便直接单测；读取失败返回空集——宁可少排除，也不让清理路径抛错。
 */
export function activePlanIdSet(runtime: any): ReadonlySet<string> {
  const ids = new Set<string>()
  try {
    const records = runtime?.state?.records
    if (records instanceof Map) {
      for (const record of records.values()) {
        const direct = typeof record?.planId === 'string' ? record.planId.trim() : ''
        const nested = typeof record?.plan?.planId === 'string' ? record.plan.planId.trim() : ''
        const id = direct !== '' ? direct : (nested !== '' ? nested : null)
        if (id) ids.add(id)
      }
    }
  } catch {
    // 同上：名单读取失败不阻断清理。
  }
  return ids
}

/**
 * [1.12.2] G2: recognise write calls by their argument shape, not by a tool-name
 * allow-list. The 1.8.18 version named write/edit/str_replace_editor only, so a
 * fourth write tool such as apply_patch never reached the guard at all.
 *
 * Shape rule: a path/first positional argument PLUS a content-bearing argument
 * (content, file_text, new_str, old_string, patch, input). read/read_image/
 * present/glob/grep carry no such pair, so they stay untouched.
 */
const READ_ONLY_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'ls', 'list', 'list_dir',
  'present', 'todo_write', 'ask_user_question',
])

function isWriteShapedCall(exec: any) {
  const name = exec?.name
  if (typeof name !== 'string' || !name) return false
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return false
  // Read-only tools also carry file_path/path; the guard must never touch them.
  if (READ_ONLY_TOOLS.has(name)) return false
  // A patch tool names its target(s) inside the patch text, not in an argument.
  if (typeof args.input === 'string' && /\*\*\* (Update|Add|Delete|Move) File/.test(args.input)) return true
  // Every other write form names a single target: file_path or path.
  return typeof args.file_path === 'string' || typeof args.path === 'string'
}

/*
 * [复审修复] shell 类工具的识别：exec.name 为 bash/shell/exec，或以它们为
 * 前缀且前缀后是 [-_] 分隔符或结尾（bash_exec、shell-tool 等宿主工具名变体）。
 * 要求分隔符是为了避免 'executor' 这类普通名字被误判进 shell 闸门。
 */
function isShellLikeToolName(name: any): boolean {
  if (typeof name !== 'string' || name === '') return false
  if (name === 'bash' || name === 'shell' || name === 'exec') return true
  return /^(?:bash|shell|exec)(?:[-_]|$)/.test(name)
}

/*
 * [复审修复] 从 shell 调用的 command 字符串解析「写目标路径」。
 *
 * 返回 null = 这不是 shell 类调用（或没有 command 参数），调用方据此跳过
 * shell 闸门；返回数组则可能为空（shell 调用但不含写形态，如纯读的
 * cat/grep/less）——空数组同样放行。多提取无害：每个候选最终仍走
 * presentedWriteDenialReason 的「已交付且计划未就绪」判定，普通路径直接
 * 放行；要防的是漏提取，所以解析宁可宽进。
 *
 * 保守模式只认这些强写信号：
 *  - `>` / `>>` 重定向（含 heredoc：`cat <<EOF > path` 的重定向部分）；
 *  - `tee [-a] files...`（tee 是纯写管道，必须整组检查）；
 *  - `sed -i[.bak] ... files`（段内 -i 之后的全部非选项 token）；
 *  - `mv/cp/install 源... 目标`（只取最后一个非选项 token——源是读，只有
 *    目标是写，全取会把「复制自受保护文件」误拦成写）；
 *  - `dd of=path`。
 *
 * 启发式局限（有意保守，备查）：
 *  - 变量间接（cmd="> $f"; eval、sh -c 嵌套命令）不做展开；
 *  - find -delete、perl -i、crontab 等少见写法不覆盖；
 *  - 引号内带空格的路径按空白截断，不做完整 shell 词法分析；
 *  - 超长命令只解析前 20k 字符。
 */
const SHELL_COMMAND_PARSE_LIMIT = 20_000
function shellWriteTargets(exec: any): string[] | null {
  if (!isShellLikeToolName(exec?.name)) return null
  const command = exec?.arguments?.command
  if (typeof command !== 'string' || command.trim() === '') return null
  const text = command.length > SHELL_COMMAND_PARSE_LIMIT ? command.slice(0, SHELL_COMMAND_PARSE_LIMIT) : command
  const targets = new Set<string>()
  const stripQuotes = (token: string) => token.replace(/^['"]+|['"]+$/g, '')
  const isOption = (token: string) => token === '-' || token.startsWith('-') || token === '--'
  const add = (token: string | undefined) => {
    const cleaned = stripQuotes(String(token ?? '')).trim()
    if (cleaned !== '') targets.add(cleaned)
  }
  // > / >> 重定向（兼容 fd 前缀 2>file、1> file；&> 合并重定向跳过——歧义大）。
  for (const match of text.matchAll(/(?<![&\d])\d*>>?\s*([^\s;|&<>]+)/g)) add(match[1])
  // 按命令段分隔：; | &&。单 &（2>&1 的合并目标）不拆，避免把 fd 描述切碎。
  for (const segment of text.split(/&&|[;|]/)) {
    const trimmed = segment.trim()
    if (trimmed === '') continue
    // tee [-a] files...：tee 之后到段尾的全部 token 都是写目标。
    const tee = /(?:^|\s)tee(?:\s+-[a-zA-Z]+)*\s+(\S(?:[\s\S]*?))?$/.exec(trimmed)
    if (tee && /\btee\b/.test(trimmed)) {
      for (const token of (tee[1] ?? '').split(/\s+/)) if (!isOption(token)) add(token)
    }
    // sed -i[.bak] ...：段内含 sed 且带 -i 选项时，取其后的全部非选项 token。
    const sed = /(?:^|\s)sed(?:\s+-[a-zA-Z]+)*\s+(-i\S*)(?:\s+([\s\S]*))?$/.exec(trimmed)
    if (sed) {
      for (const token of (sed[2] ?? '').split(/\s+/)) if (!isOption(token)) add(token)
    }
    // mv/cp/install 源... 目标：只取最后一个非选项 token（目标是写、源是读）。
    const mover = /(?:^|\s)(?:mv|cp|install)(?:\s+-[a-zA-Z]+)*\s+([\s\S]+)$/.exec(trimmed)
    if (mover) {
      const tokens = (mover[1] ?? '').split(/\s+/).filter((token) => !isOption(token))
      add(tokens[tokens.length - 1])
    }
    // dd of=path（of= 后到空白为止）。
    for (const match of trimmed.matchAll(/(?:^|\s)of=([^\s;|&]+)/g)) add(match[1])
  }
  return [...targets]
}
