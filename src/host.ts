import { readFileSync } from 'node:fs'
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
  createWorkplanRuntime,
  dispatchToolOutputSchema,
  plannerOutputSchema,
  statusToolOutputSchema,
  updateToolOutputSchema,
} from './runtime.js'
import { isRecord } from './plan.js'

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
  '结果消息里每个完成项都带 verification 与 acceptance：`structured` 是子 Agent 逐条自检通过，`unverified` 是自述但未逐条确认，`failed` 是自检失败（已按受阻处理），`legacy` 是旧格式回传。只把 structured 当作可直接采信，其余必须你自己核对产物。',
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
      + '当主 Agent 核对子任务结果、发现完成不实或需要修正时使用。',
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
          minimum: 0,
          maximum: 100,
          description: '进度百分比；done 会自动置为 100。',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: '支持该状态的证据（文件、命令输出、验收结果）。',
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
      + '取消后计划在面板中显示为“已取消”，不会启动任何部门 Agent。',
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
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          planId: { type: 'string' },
          phase: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args: any, value: any) {
        const result = isRecord(value) ? value : {}
        return textContent(
          result.ok
            ? `已取消计划 ${String(result.planId ?? '')}：${String(result.reason ?? '用户取消')}`
            : `取消失败：${String(result.error ?? '未知错误')}`,
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
        if (!result.ok) return textContent(`查询失败：${String(result.error ?? '未知错误')}`)
        const running = result.running === true
        return textContent(
          `计划 ${String(result.planId ?? '')}｜${running ? '执行中' : '未在执行'}` 
          + `｜阶段：${phaseLabel(result.phase)}`
          + `｜完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}，受阻 ${Number(stats.blocked ?? 0)}`
          + (running && Number(result.elapsedMs ?? 0) > 0
            ? `｜已 ${Math.round(Number(result.elapsedMs) / 1000)}s`
            : ''),
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
      '派发当前会话尚未执行的任务分解计划。计划显示后必须先调用本工具；它会等待各部门 Agent 完成，'
      + '把 durable 结果写入会话并返回每个子任务的状态/摘要。重复调用是幂等的。',
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
        return textContent(
          result.ok
            ? `计划 ${String(result.planId ?? '')} 当前阶段：${phaseLabel(result.phase)}`
              + `（完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}，受阻 ${Number(stats.blocked ?? 0)}）`
              + (result.alreadyRunning || result.mode === 'async'
                ? `｜已在执行（${Math.round(elapsedSeconds(result) / 1000)}s）`
                : '')
              + (result.joined ? '｜已加入进行中的派发并等到结果' : '')
            // The hint carries the recovery instruction (resume, or take the work
            // over directly); showing it in the rendered line keeps it visible
            // even when only the summary is read.
            : `派发失败：${String(result.error ?? '未知错误')}${result.hint ? `｜下一步：${String(result.hint)}` : ''}`,
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

export function apply(ctx: any, config: WorkplanConfig = {}) {
  const runtime = createWorkplanRuntime(ctx, {
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
   */
  ctx.effect(() => ctx.tools.guard((exec: any) => {
    if (exec?.name !== 'dsh_workplan_dispatch') return undefined
    const session = exec?.agent?.session
    if (session && runtime.planModeActive(session)) {
      return '当前是 plan 模式：计划已生成，请先让用户审阅/退出 plan 模式，再调用 dsh_workplan_dispatch。'
    }
    return undefined
  }))

  ctx.effect(() => ctx.on('agent/pre-step', runtime.onPreStep))

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
          try {
            const body = readFileSync(new URL('../vendor/chart.umd.js', import.meta.url))
            res.statusCode = 200
            res.setHeader('content-type', 'text/javascript; charset=utf-8')
            res.setHeader('cache-control', 'public, max-age=3600')
            res.end(body)
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
  version: '1.7.0',
  promptOrder: PROMPT_ORDER,
  routes: ['/dsh-workplan/plans', '/dsh-workplan/vendor/chart.umd.js'],
}

export { PROMPT_SECTION, createCancelTool, createDispatchTool, createStatusTool, createUpdateTool, plannerOutputSchema }
