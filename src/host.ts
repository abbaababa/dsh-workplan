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
  statusToolOutputSchema,
  updateToolOutputSchema,
} from './runtime.js'
import { isRecord } from './plan.js'

/*
 * [1.8.14] Identity of the modules this process actually loaded (N1).
 *
 * `version` alone cannot answer "is the running process the build I just
 * shipped": the same version can be rebuilt, and a profile recomposition can
 * leave stale modules in memory while the files on disk are new. Hashing the
 * three compiled entry files that make up the plugin at activation time gives a
 * value that changes whenever the loaded bytes change. It is computed once, so
 * it cannot drift during the process's life.
 */
const LOADED_BUILD = (() => {
  try {
    const entryPath = fileURLToPath(import.meta.url)
    const dir = dirname(entryPath)
    const hash = createHash('sha256')
    for (const file of ['host.js', 'runtime.js', 'plan.js']) {
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
  '结果消息里每个完成项都带 verification 与 acceptance：`structured` 是子 Agent 逐条自检通过，`unverified` 是自述但未逐条确认，`failed` 是自检失败（已按受阻处理），`legacy` 是旧格式回传。只有 structured 且 acceptance 每项 pass 才算可交付；其余必须你自己核对产物，并用 dsh_workplan_update 的 verification/acceptance/artifacts 字段把核对结果写回（这些字段会持久化、刷新后仍生效），不要把“看着没问题”当成证据。',
  '子 Agent 通过 `needs` 提出的跨部门需求会列在结果消息的「跨部门待转达」里：由你逐条处理（补派、向用户确认或直接完成），不要忽略。',
  '长任务可以用 `dsh_workplan_dispatch({ mode: "async" })` 先开跑并立即答复用户，再用 `dsh_workplan_status` 查看进度；async 返回的是“已开跑”，不是“已完成”。',
  '如果自动分解降级，先向用户说明失败原因并询问是否重试，在用户确认前不要开始执行任务。',
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
  childTimeoutMs?: number
  idleTimeoutMs?: number
  totalTimeoutMs?: number
  maxResumes?: number
}

function createUpdateTool(runtime: any) {
  return {
    name: 'dsh_workplan_update',
    description:
      '更新当前任务分解计划中一个子任务的状态与证据。仅用于本会话已生成的主计划；子 Agent 不可调用。'
      + '当主 Agent 核对子任务结果、发现完成不实或需要修正时使用。'
      + '把子任务标成 done 时，必须同时给出真实的 verification 与 acceptance（每项 result="pass"），'
      + '否则计划不会变成可交付状态（deliveryReady=false，present 会被拒绝）。'
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
          description: '新的状态。',
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
      },
      required: ['subtaskId', 'status'],
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

function createCancelTool(runtime: any) {
  return {
    name: 'dsh_workplan_cancel',
    description:
      '取消当前会话尚未派发/正在等待派发的任务分解计划。仅取消计划记录，不伪造任何完成；'
      + '取消后计划在面板中显示为“已取消”，不会启动任何部门 Agent。'
      + '注意：取消不等于完成。取消后如仍有未完成项或证据缺口，present 仍会被拒绝，'
      + '答复必须按「未完成：剩余 N 项与原因」说明。',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '计划 ID；省略时使用当前会话最新计划。',
        },
        reason: {
          type: 'string',
          description: '取消原因，会写入会话记录。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: cancelToolOutputSchema(),
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        if (!result.ok) return textContent(`取消失败：${String(result.error ?? '未知错误')}`)
        const stats = isRecord(result.stats) ? result.stats : {}
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
        return textContent(
          `计划 ${String(result.planId ?? '')}｜${running ? '执行中' : '未在执行'}`
          + `｜阶段：${phaseLabel(result.phase)}`
          + `｜完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}，受阻 ${Number(stats.blocked ?? 0)}`
          + `｜${result.deliveryReady === true ? '可交付' : '未就绪'}`
          + (running && Number(result.elapsedMs ?? 0) > 0
            ? `｜已 ${Math.round(Number(result.elapsedMs) / 1000)}s`
            : '')
          + (identity ? `｜${identity}` : ''),
        )
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
    timeoutMs: Number(runtime?.limits?.totalTimeoutMs ?? 1200000) + 20000,
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
function numericSetting(configValue: any, envName: string) {
  if (configValue !== undefined && configValue !== null && configValue !== '') {
    const numeric = Number(configValue)
    if (Number.isFinite(numeric) && numeric > 0) return numeric
  }
  const raw = typeof process !== 'undefined' ? process.env?.[envName] : undefined
  if (raw === undefined || raw === '') return undefined
  const numeric = Number(raw)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
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
    childTimeoutMs: numericSetting(config.childTimeoutMs, 'DSH_WORKPLAN_CHILD_TIMEOUT_MS'),
    idleTimeoutMs: numericSetting(config.idleTimeoutMs, 'DSH_WORKPLAN_IDLE_TIMEOUT_MS'),
    totalTimeoutMs: numericSetting(config.totalTimeoutMs, 'DSH_WORKPLAN_TOTAL_TIMEOUT_MS'),
    maxResumes: numericSetting(config.maxResumes, 'DSH_WORKPLAN_MAX_RESUMES'),
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
  version: '1.8.14',
  promptOrder: PROMPT_ORDER,
  routes: ['/dsh-workplan/plans', '/dsh-workplan/vendor/chart.umd.js'],
}

export { PROMPT_SECTION, createCancelTool, createDispatchTool, createStatusTool, createUpdateTool, plannerOutputSchema }
