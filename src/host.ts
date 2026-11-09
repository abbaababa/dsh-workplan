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
import { DEPARTMENT_IDS, isRecord } from './plan.js'
import { autoResumeEnabledFrom } from './auto-resume.js'

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
  '本会话已启用自动任务分解。系统会在每个新用户任务的第一个模型步骤前生成计划，并先把计划显示在对话里；收到【任务分解】后，必须先调用 dsh_workplan_dispatch（默认 wait 等结果；预计较久时用 mode:"async" 先开跑），再做任何其他工具调用或回答。',
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
   * [2.2.0][T5/O-5a] E1：超时是安全兜底（防止任务无限运行），不是交付期限。
   * 旧句把「每步 15 分钟」的规模参考写成硬性上限，等于对外承诺固定完成时间；
   * 改为「协商上限＋安全兜底」，并给出 extendMs 协商入口。安全概念与事故溯源
   * （上方 1.8.7/1.8.13 注释）全部保留，不删。
   */
  '7. 子任务的时间是「协商上限」＋「安全兜底」，不是固定交付期限：规模参考 15 分钟量级（仅供参考、非承诺，实际时长由执行专家开工预告协商决定），整轮预算（默认 20 分钟）同样只是安全兜底，不是交付期限。子 Agent 接近上限时应先把已完成内容落盘并在结论里列出路径。任何「达到协商上限」「本轮预算用尽」都不等于「什么都没做」：状态里的 error 会列出「声明产物已在盘上」，必须先用文件核对；若产物已覆盖验收标准，用 dsh_workplan_update 复核改判，只补缺失部分再续跑，禁止无视盘上产物把整步重跑。确认需要更多时间时，主 Agent 可用 dsh_workplan_update 的 extendMs 协商放宽（放宽永远有界：累计超过初始协商上限的一倍即拒绝，转新轮续跑或转 escalate 请主 Agent/用户裁决）。',
  '8. 出现「待指示」项（closure=escalated，左侧栏显示「待指示」并附问题摘录）时，必须在当轮处理：用 dsh_workplan_instruct 下发决定（投递到子会话并把该行恢复为执行中），或确认放弃后用 dsh_workplan_update 置 blocked。不要沉默略过，也不要把待指示当成普通失败——它是一条还没被回答的请示，会一直占着交付门禁。',
  '9. 出现「已下发未响应」（ackOverdue）时，不要重复派发：先用 dsh_workplan_status 看该行 childId 与已等待时长，必要时用 dsh_workplan_followup 投递一次说明；超过硬超时仍未响应会记为 blocked（blockedKind=no-ack），可以再下发指示复活。',
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
   * 部门 Agent 在阶段三必须复盘并落盘为永久记忆；这条提示词让主 Agent 知道
   * 记忆存在、存在哪里、怎么复核，而不是把「会学习」当成不可见的口号。
   */
  '每个部门完成工作后，必须在阶段三提交复盘（问题 / 弯路 / 解决 / 防再犯规则），插件会自动把它写入永久教训记忆文件（默认 ~/.dsh/workplan/lessons.jsonl，可用 DSH_WORKPLAN_LESSONS_FILE 覆盖）；下次派发同类子任务时，相关历史教训会自动出现在子 Agent 提示词里。',
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
  failClosedOnIncomplete?: boolean
}

function createUpdateTool(runtime: any) {
  return {
    name: 'dsh_workplan_update',
    description:
      '更新当前任务分解计划中一个子任务的状态与证据。仅用于本会话已生成的主计划；子 Agent 不可调用。'
      + '当主 Agent 核对子任务结果、发现完成不实或需要修正时使用。'
      + '把子任务标成 done 时，必须同时给出真实的 verification 与 acceptance（每项 result="pass"），'
      + '否则计划不会变成可交付状态（deliveryReady=false，present 会被拒绝）。'
      + '运行中的子任务需要更多时间时，传 extendMs（毫秒）即可协商放宽，不需要 force；放宽永远有界（累计 ≤ 初始协商上限 × 1），超出转新轮续跑或转 escalate 请主 Agent 裁决。'
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
          description: '新的状态（普通改判必填；仅协商时限时可省略，改传 extendMs / timeNotice）。',
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
          description: '延期毫秒数（正整数，仅主 Agent 可用）：只推移本子任务的协商截止并重置计时，'
            + '不改状态判定；运行中可用，不需要 force。除非另传 status，否则可省略 status。'
            + '放宽永远有界：累计延期 ≤ 初始协商上限的一倍，超出会被拒绝并提示转新轮续跑或转 escalate 请主 Agent 裁决。',
        },
        /*
         * [2.2.0][T5/O-4c] O-2a 专家开工预告：{declaredMinutes, reason}。与 extendMs
         * 同属「只记录、不改判定」的时限信息，运行中同样放行。
         */
        timeNotice: {
          type: 'object',
          description: '专家开工预告（O-2a）：{ declaredMinutes, reason }，只记入协商流水，不改状态与判定。',
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
      + '遇阻（缺权限/缺输入/依赖产物缺失/需求自相矛盾/无法验证/同一命令连续两次失败/需要主 Agent 决定方向）时，'
      + '第一动作是调用本工具，然后停止推进、只做只读核对，等待主 Agent 指示。'
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
          + '｜现在停止推进，只做只读核对；等待主 Agent 指示后再继续。',
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
 * [1.13.0] 阶段三（验证阶段）的插件核验工具（用户 2026-11-05）。
 *
 * 三阶段工作法要求部门 Agent 先梳理问题、再形成可执行思路、最后执行与验证。
 * 这个工具只做一件事：接收三阶段证据并给出核验结论。缺少 planning/execution
 * 证据时会被 `runtime.verifySubtask` 以 `PHASE_GATE` 拒绝并列出待补项，避免
 * 跳过前两阶段直接宣称验证通过。
 *
 * 注意（2.0.2 更正）：2026-11-05 的「第一、二阶段禁用 dsh-workplan 插件」是
 * 该次优化会话的过程约束，不是对所有后续会话的产品规则；插件不全局禁用。
 */
export function createVerifyTool(runtime: any) {
  return {
    name: 'dsh_workplan_verify',
    description:
      '部门子 Agent 在第三阶段（验证阶段）使用的插件核验：提交 planning / execution / verification 三阶段证据，'
      + '插件逐项核验并返回 passed 或仍需补齐的 gaps。缺少 planning / execution 证据时返回 PHASE_GATE 与待补项；'
      + '只有「问题梳理 + 可执行思路 + 实际执行步骤」齐全后，才会进入阶段三核验。'
      + '核验通过不代表完成：最终仍要在结果块里写同一份 phases，由主计划按三阶段契约判定。',
    parameters: {
      type: 'object',
      properties: {
        subtaskId: {
          type: 'string',
          description: '你的子任务 ID（仅用于回显核对；服务端按父子会话关系反查，自报值不作为定位依据）。',
        },
        phases: {
          type: 'object',
          description: '三阶段证据：planning（问题梳理 + 可执行思路）、execution（执行步骤）、verification（逐项验证）。',
          properties: {
            planning: {
              type: 'object',
              properties: {
                problemAnalysis: { type: 'array', items: { type: 'string' }, description: '要解决的问题逐条梳理（现状/事实/约束/未知/主要矛盾/边界）' },
                constraints: { type: 'array', items: { type: 'string' }, description: '约束条件' },
                unknowns: { type: 'array', items: { type: 'string' }, description: '未知或待确认项' },
                approach: { type: 'array', items: { type: 'string' }, description: '完整可执行的思路：每一步做什么、产出什么、如何证明' },
              },
              required: ['problemAnalysis', 'approach'],
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
                  description: '阶段三收尾的自我学习复盘：本次遇到的问题、走过的弯路、如何解决、以后如何预防再犯',
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
          required: ['planning', 'execution', 'verification'],
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
          `${String(result.subtaskId ?? '')} 阶段三核验通过：${String(result.summary ?? '')}`
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
 * 不提供写动作：记忆只能由「阶段三复盘通过 → 完成判定」这条链写入，
 * 防止主 Agent 事后手写一条“教训”绕过真实复盘证据。
 */
function createLessonsTool(runtime: any) {
  return {
    name: 'dsh_workplan_lessons',
    description:
      '查看 dsh-workplan 的永久教训记忆（部门完成工作后自动落盘的复盘）：'
      + 'action=list 按部门取最相关教训，action=search 按关键词检索，action=stats 看总数/重复数与文件位置。'
      + '只读，不修改计划状态；阶段三验证时用它核对记住了什么、哪些同类错误在重复出现。',
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
 * 服务端硬校验：根会话、该行 `closure:'escalated'`、`childId` 是本会话直接
 * 子会话、instruction 非空且 ≤4000 字符。投递失败时不改状态 —— 「我发了」
 * 与「它收到了」必须是两件事，否则界面会显示一个没人执行的指示。
 */
function createInstructTool(runtime: any) {
  return {
    name: 'dsh_workplan_instruct',
    description:
      '向一条「待指示」子任务下发主 Agent 的决定：投递给对应子会话，并把该行恢复为执行中（closure=instructed）。'
      + '只有根会话可调用；只接受 closure=escalated 的行。'
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
          description: '待指示的子任务 ID，例如 T3。',
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
    /*
     * The host tool timeout must outlive the plan budget, otherwise the model
     * call is killed while the dispatcher is still legitimately working and the
     * plan looks stuck. Derive it from the resolved limits.
     */
    timeoutMs: Number(runtime?.limits?.totalTimeoutMs ?? 0) > 0
      ? Number(runtime.limits.totalTimeoutMs) + 20000
      : 24 * 60 * 60 * 1000,
    async execute(args: any, exec: any) {
      const parsed = asObject(args) ?? {}
      return runtime.dispatchTool(exec.agent, parsed, exec.signal)
    },
  }
}

/*
 * Read the limits from the environment when the config does not set them.
 *
 * The plugin used to hard-code a 300 s child ceiling with no way to raise it
 * short of editing the source, so any machine with slower subagents hit the
 * wall on every plan. These knobs let operations tune it without a rebuild.
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
  if (exec?.name === 'dsh_workplan_dispatch') {
    const session = exec?.agent?.session
    if (session && runtime.planModeActive(session)) {
      return '当前是 plan 模式：计划已生成，请先让用户审阅/退出 plan 模式，再调用 dsh_workplan_dispatch。'
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
  })

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
  /* [1.13.0] 阶段三核验：子会话唯一可用的插件工作能力，阶段一/二会被 PHASE_GATE 拒绝。 */
  ctx.effect(() => ctx.tools.register(createVerifyTool(runtime)))
  /* [2.0.0] 永久教训记忆的只读复核入口（阶段三验证用）。 */
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
            const body = readFileSync(new URL('../vendor/chart.umd.js', import.meta.url))
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
}

export const meta = {
  name,
  version: '2.2.6',
  promptOrder: PROMPT_ORDER,
  routes: ['/dsh-workplan/plans', '/dsh-workplan/vendor/chart.umd.js'],
}

export { PROMPT_SECTION, createCancelTool, createDispatchTool, createEscalateTool, createHandoffTool, createInstructTool, createLessonsTool, createReplanTool, createStatusTool, createUpdateTool, plannerOutputSchema }

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
  if (!isWriteShapedCall(exec)) return undefined
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
  return undefined
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
