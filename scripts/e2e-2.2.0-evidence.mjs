#!/usr/bin/env node
/*
 * [2.2.0][T6] 六项能力 e2e 取证脚本（只读 JSONL，不调用 dsh-workplan 工具）。
 *
 * 用法：
 *   node scripts/e2e-2.2.0-evidence.mjs \
 *     --main /path/to/main-session.v4.jsonl \
 *     [--child /path/to/child-1.v4.jsonl ...] [--json]
 *
 * 输入是 DSH 会话的明文 JSONL（`zstd -dc session.v4.jsonl.zstd > /tmp/main.jsonl`
 * 先解压）。脚本只读：不派发、不改计划、不写任何文件。
 *
 * 六项检查（与 T1/T2 台账、wp-8f6e5d1a 计划一致）：
 *   C1 完成即时通知：done 结算是否各推 1 条、先于轮级结果、≤5 秒（有子会话日志时）
 *   C2 子→主开工预告通道：noticeChannel 是否为 observed 且 target=本轮主会话 id；
 *      子提示词是否使用宿主契约 agent_id、且不再出现 target:"lead"
 *   C3 据预告给足时间：deadlineAt - startedAt 是否 = 显式 timeoutMs 或预估派生值
 *      （再叠加 timeJournal 的 extendMs），逐毫秒对齐
 *   C4 延期/预警：timeJournal 是否有 extend 记录；timeWarning 是否留档
 *   C5 禁设固定完成时间：子提示词是否含「不设固定完成时间 / 协商上限」且无硬性固定承诺
 *   C6 推理等级：计划是否给每项 low/high/max；子会话 descriptor 的
 *      agentReasoningEffort 是否等于该子任务自己的档位（不继承主 Agent）
 *
 * 注意：本脚本不替代真实运行；它只把「真实运行后留下的原始记录」按固定判据
 * 逐项核对。缺数据时输出 BLOCKED/PARTIAL，绝不把「没看到」写成 PASS。
 */
import fs from 'node:fs'

function parseArgs(argv) {
  const out = { main: '', children: [], json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--main') out.main = argv[++i] || ''
    else if (arg === '--child') out.children.push(argv[++i] || '')
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/e2e-2.2.0-evidence.mjs --main <main.jsonl> [--child <child.jsonl> ...] [--json]')
      process.exit(0)
    } else {
      console.error(`未知参数：${arg}`)
      process.exit(2)
    }
  }
  if (!out.main) {
    console.error('缺少 --main <main.jsonl>')
    process.exit(2)
  }
  return out
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8')
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { rows.push(JSON.parse(trimmed)) } catch { /* 跳过坏行，不中断取证 */ }
  }
  return rows
}

function contentText(event) {
  const data = event?.data
  if (typeof data === 'string') return data
  if (!data || typeof data !== 'object') return ''
  const content = Array.isArray(data.content) ? data.content
    : (data.message && Array.isArray(data.message.content) ? data.message.content : null)
  if (!Array.isArray(content)) return ''
  return content.filter((item) => item && item.type === 'text').map((item) => item.text || '').join('\n')
}

function blocks(rows, begin, end) {
  const out = []
  for (const event of rows) {
    const text = contentText(event)
    if (!text || !text.includes(begin)) continue
    const re = new RegExp(`${escapeRe(begin)}\\s*(\\{[\\s\\S]*?\\})\\s*${escapeRe(end)}`, 'g')
    let match
    while ((match = re.exec(text))) {
      try {
        const parsed = JSON.parse(match[1])
        out.push({ event, value: parsed })
      } catch { /* 坏块跳过，由缺数据路径报告 */ }
    }
  }
  return out
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function planSubtasks(planRecord) {
  const plan = planRecord?.plan || planRecord || {}
  const stages = Array.isArray(plan.stages) ? plan.stages : []
  const out = []
  for (const stage of stages) {
    for (const subtask of Array.isArray(stage?.subtasks) ? stage.subtasks : []) {
      if (subtask && typeof subtask.id === 'string') out.push(subtask)
    }
  }
  return out
}

function findSessionId(rows) {
  const header = rows.find((event) => event?.type === 'session')
  return typeof header?.id === 'string' ? header.id : ''
}

function mainReasoningEffort(rows) {
  let effort = ''
  for (const event of rows) {
    if (event?.type === 'model/selection' && typeof event?.data?.reasoningEffort === 'string') {
      effort = event.data.reasoningEffort
    }
  }
  return effort
}

function childInfo(file) {
  const rows = readJsonl(file)
  const header = rows.find((event) => event?.type === 'session')
  const descriptor = rows.find((event) => event?.type === 'subagent/descriptor')?.data || {}
  const promptEvent = rows.find((event) => event?.type === 'user/message')
  const turnEnds = rows.filter((event) => event?.type === 'turn/end')
  return {
    file,
    id: typeof header?.id === 'string' ? header.id : '',
    parentSession: typeof header?.parentSession === 'string' ? header.parentSession : '',
    label: typeof descriptor?.label === 'string' ? descriptor.label : '',
    effort: typeof descriptor?.agentReasoningEffort === 'string' ? descriptor.agentReasoningEffort : '',
    prompt: contentText(promptEvent),
    turnEnds: turnEnds.map((event) => Number(event?.time) || 0).filter(Boolean),
  }
}

function subtaskFromLabel(label) {
  const match = /(?:^|:)T(\d+)\b/.exec(String(label || ''))
  return match ? `T${match[1]}` : ''
}

const NOTICE_RE = /^\[dsh-workplan\] 子任务 (T\d+) 已完成并结算/

function check(id, title, status, evidence) {
  return { id, title, status, evidence }
}

const args = parseArgs(process.argv.slice(2))
const main = readJsonl(args.main)
const childRows = args.children.map(childInfo)
const mainSessionId = findSessionId(main)
const parentEffort = mainReasoningEffort(main)

const plans = blocks(main, '<!-- DSH-WORKPLAN:BEGIN -->', '<!-- DSH-WORKPLAN:END -->').map((item) => item.value)
const resultBlocks = blocks(main, '<!-- DSH-WORKPLAN-RESULT:BEGIN -->', '<!-- DSH-WORKPLAN-RESULT:END -->').map((item) => item.value)
const latestPlan = plans.length > 0 ? plans[plans.length - 1] : null
const latestResult = resultBlocks.length > 0 ? resultBlocks[resultBlocks.length - 1] : null
const planId = latestPlan?.planId || latestResult?.planId || ''
const subtasks = planSubtasks(latestPlan)
const statuses = Array.isArray(latestResult?.statuses) ? latestResult.statuses : []
const resultEvent = blocks(main, '<!-- DSH-WORKPLAN-RESULT:BEGIN -->', '<!-- DSH-WORKPLAN-RESULT:END -->').at(-1)?.event || null

// 即时通知：只认 [dsh-workplan] 子任务 T# 已完成并结算 的纯文本通知。
const notices = []
for (const event of main) {
  const text = contentText(event)
  const match = NOTICE_RE.exec(text)
  if (!match) continue
  notices.push({ event, subtaskId: match[1], text, seq: Number(event?.seq) || 0, time: Number(event?.time) || 0 })
}

const checks = []

/* C1 完成即时通知 */
{
  const done = statuses.filter((item) => item?.status === 'done')
  const evidence = []
  let status = 'BLOCKED'
  if (done.length === 0) {
    evidence.push('没有 done 结算行，无法验证正向通知；按证据纪律不写 PASS。')
  } else {
    const missing = done.filter((item) => !notices.some((notice) => notice.subtaskId === item.subtaskId))
    const duplicated = done.filter((item) => notices.filter((notice) => notice.subtaskId === item.subtaskId).length > 1)
    const beforeResult = resultEvent ? notices.every((notice) => notice.seq < Number(resultEvent.seq)) : false
    let slowest = null
    for (const child of childRows) {
      const idFromLabel = subtaskFromLabel(child.label)
      const linked = notices.filter((notice) => notice.subtaskId === idFromLabel)
      if (linked.length === 0 || child.turnEnds.length === 0) continue
      const ended = Math.max(...child.turnEnds)
      for (const notice of linked) {
        const delta = notice.time - ended
        if (slowest === null || delta > slowest) slowest = delta
      }
    }
    if (missing.length > 0 || duplicated.length > 0) {
      status = 'FAIL'
      evidence.push(`done=${done.map((item) => item.subtaskId).join(',')}；缺少通知=${missing.map((item) => item.subtaskId).join(',') || '无'}；重复通知=${duplicated.map((item) => item.subtaskId).join(',') || '无'}`)
    } else if (!beforeResult) {
      status = 'FAIL'
      evidence.push('通知未在任何轮级结果消息之前出现（无法证明「不等整轮」）。')
    } else if (slowest === null) {
      status = 'PARTIAL'
      evidence.push('通知恰好 1 条/行且先于结果消息；但未提供可对齐 turn/end 的子会话日志，≤5 秒判据无法实测。')
    } else if (slowest <= 5000) {
      status = 'PASS'
      evidence.push(`通知 1 条/行、先于结果消息；子会话 turn/end → 通知最慢 ${slowest}ms（≤5000）。`)
    } else {
      status = 'FAIL'
      evidence.push(`通知最慢 ${slowest}ms，超过 5000ms。`)
    }
  }
  checks.push(check('C1', '完成即时通知（≤5s、幂等、先于轮级结果）', status, evidence))
}

/* C2 子→主预告通道 */
{
  const rows = statuses.filter((item) => item?.noticeChannel)
  const observed = rows.filter((item) => item.noticeChannel?.state === 'observed')
  const targets = rows.map((item) => item.noticeChannel?.target).filter(Boolean)
  const badAlias = targets.filter((target) => target === 'lead')
  const correctTarget = observed.filter((item) => !mainSessionId || item.noticeChannel?.target === mainSessionId)
  const childPrompts = childRows.map((child) => child.prompt).filter(Boolean)
  const promptBad = childPrompts.filter((prompt) => /send_message\s*\(\s*target/.test(prompt) || /"lead"/.test(prompt))
  const promptGood = childPrompts.filter((prompt) => /send_message\(\{\s*agent_id:/.test(prompt) || /agent_id:/.test(prompt))
  let status = 'BLOCKED'
  const evidence = []
  if (rows.length === 0) {
    evidence.push('状态行没有 noticeChannel，无法验证通道。')
  } else if (observed.length === 0) {
    status = 'FAIL'
    evidence.push(`有 noticeChannel=${rows.length} 条，但没有 observed；states=${rows.map((item) => item.noticeChannel.state).join(',')}`)
  } else if (badAlias.length > 0) {
    status = 'FAIL'
    evidence.push(`出现旧别名目标 "lead"：${badAlias.length} 条`)
  } else if (correctTarget.length === 0) {
    status = 'FAIL'
    evidence.push(`observed 目标与主会话 id 不一致：targets=${targets.join(',')}；main=${mainSessionId || '?'}`)
  } else if (promptBad.length > 0) {
    status = 'FAIL'
    evidence.push(`子提示词仍出现宿主不认的 target 调用或 "lead"：${promptBad.length} 份`)
  } else if (childPrompts.length > 0 && promptGood.length === 0) {
    status = 'FAIL'
    evidence.push('子提示词没有出现宿主契约 agent_id 调用形式。')
  } else {
    status = childPrompts.length > 0 ? 'PASS' : 'PARTIAL'
    evidence.push(`observed=${observed.length}；target=${targets.slice(0, 5).join(',') || '?'}；main=${mainSessionId || '?'}；子提示词契约=${childPrompts.length > 0 ? '已核对' : '未提供，无法核对'}`)
  }
  checks.push(check('C2', '子→主开工预告通道可达且可观测', status, evidence))
}

/* C3 据预告给足时间 */
{
  const rows = statuses.filter((item) => Number.isFinite(Number(item?.startedAt)) && Number.isFinite(Number(item?.deadlineAt)))
  const evidence = []
  let status = 'BLOCKED'
  if (rows.length === 0) {
    evidence.push('没有同时带 startedAt/deadlineAt 的状态行。')
  } else {
    const bad = []
    for (const row of rows) {
      const subtask = subtasks.find((item) => item.id === row.subtaskId) || {}
      const delta = Number(row.deadlineAt) - Number(row.startedAt)
      const explicit = Number(subtask.timeoutMs)
      const estimate = Number(subtask.estimateMinutes)
      const derived = Number.isFinite(estimate) && estimate > 0
        ? Math.min(7_200_000, Math.max(1_000, estimate * 2.0 * 60_000))
        : null
      const explicitClamped = Number.isFinite(explicit) && explicit > 0
        ? Math.min(7_200_000, Math.max(1_000, explicit))
        : null
      const base = explicitClamped ?? derived
      const extended = (Array.isArray(row.timeJournal) ? row.timeJournal : [])
        .filter((entry) => entry?.action === 'extend')
        .reduce((sum, entry) => sum + (Number(entry.extendMs) > 0 ? Math.floor(Number(entry.extendMs)) : 0), 0)
      if (base === null) {
        bad.push(`${row.subtaskId}: 无显式 timeoutMs/estimateMinutes，无法反解（delta=${delta}ms）`)
      } else if (base + extended !== delta) {
        bad.push(`${row.subtaskId}: delta=${delta}ms ≠ ${base}+${extended}=${base + extended}ms`)
      }
    }
    status = bad.length === 0 ? 'PASS' : 'FAIL'
    evidence.push(...(bad.length === 0
      ? [`${rows.length}/${rows.length} 行 deadlineAt−startedAt 与公式（显式优先，否则 clamp(预估×2×60000)）+ extend 逐毫秒一致。`]
      : bad))
  }
  checks.push(check('C3', '据预告给足时间（协商窗口派生）', status, evidence))
}

/* C4 延期/预警 */
{
  const extendsRows = statuses.filter((item) => (Array.isArray(item?.timeJournal) ? item.timeJournal : []).some((entry) => entry?.action === 'extend'))
  const warningRows = statuses.filter((item) => item?.timeWarning && typeof item.timeWarning === 'object')
  const status = extendsRows.length > 0 ? 'PASS' : (warningRows.length > 0 ? 'PARTIAL' : 'BLOCKED')
  const evidence = []
  if (extendsRows.length > 0) {
    evidence.push(`${extendsRows.length} 行有 extend 流水：` + extendsRows.slice(0, 3).map((item) =>
      `${item.subtaskId}(${(item.timeJournal || []).filter((entry) => entry?.action === 'extend').map((entry) => `+${entry.extendMs}ms`).join('/')})`).join('；'))
  } else {
    evidence.push('没有 extend 流水：本轮未触发延期，不能算 PASS。')
  }
  if (warningRows.length > 0) evidence.push(`timeWarning=${warningRows.map((item) => item.subtaskId).join(',')}`)
  else evidence.push('timeWarning 未留档（本轮未触发或未到预警窗口）。')
  checks.push(check('C4', '超时预警 + 有界延期', status, evidence))
}

/* C5 禁设固定完成时间 */
{
  const prompts = childRows.map((child) => child.prompt).filter(Boolean)
  const forbidden = /硬执行上限|必须在.{0,8}分钟内完成|截止.{0,6}时刻/
  const good = prompts.filter((prompt) => prompt.includes('不设固定完成时间') || prompt.includes('协商上限'))
  const bad = prompts.filter((prompt) => forbidden.test(prompt))
  let status = 'BLOCKED'
  if (prompts.length === 0) {
    // 没有子日志时退回计划文本检查（证据较弱，标 PARTIAL）。
    const planText = JSON.stringify(latestPlan || {})
    status = /不设固定完成时间|协商上限|预估仅供参考/.test(planText) ? 'PARTIAL' : 'BLOCKED'
  } else if (bad.length > 0) {
    status = 'FAIL'
  } else if (good.length === prompts.length) {
    status = 'PASS'
  } else {
    status = 'PARTIAL'
  }
  checks.push(check('C5', '禁设固定完成时间（柔性协商措辞）', status, [
    `子提示词=${prompts.length}；含协商措辞=${good.length}；含硬性固定承诺=${bad.length}`,
    prompts.length === 0 ? '未提供子会话日志，只能对计划文本做弱检查。' : '依据：子会话首条 user/message（派发提示词原文）。',
  ]))
}

/* C6 推理等级不继承 */
{
  const allowed = new Set(['low', 'high', 'max'])
  const planEfforts = subtasks.map((item) => ({ id: item.id, effort: item.reasoningEffort }))
  const invalid = planEfforts.filter((item) => !allowed.has(String(item.effort)))
  const childrenWithEffort = childRows.filter((child) => child.effort)
  const mismatched = []
  for (const child of childrenWithEffort) {
    const id = subtaskFromLabel(child.label)
    const planRow = planEfforts.find((item) => item.id === id)
    if (planRow && String(planRow.effort) !== child.effort) {
      mismatched.push(`${id}: plan=${planRow.effort} child=${child.effort}`)
    }
  }
  const differsFromParent = parentEffort
    ? childrenWithEffort.filter((child) => child.effort !== parentEffort).length
    : 0
  let status = 'BLOCKED'
  const evidence = []
  if (subtasks.length === 0) {
    evidence.push('没有可读计划子任务。')
  } else if (invalid.length > 0) {
    status = 'FAIL'
    evidence.push(`计划档位非法：${invalid.map((item) => `${item.id}=${item.effort}`).join(',')}`)
  } else if (childrenWithEffort.length === 0) {
    status = 'PARTIAL'
    evidence.push('计划层 10/10 有档位，但没有提供子会话 descriptor，落模侧无法核对。')
  } else if (mismatched.length > 0) {
    status = 'FAIL'
    evidence.push(`子会话档位与计划行不一致：${mismatched.join('；')}`)
  } else if (!parentEffort) {
    status = 'PARTIAL'
    evidence.push('子会话档位与计划行一致；但无法读取主 Agent 档位，不能证明「未继承」。')
  } else if (differsFromParent === 0) {
    status = 'FAIL'
    evidence.push(`所有子会话档位都等于主 Agent=${parentEffort}，无法排除继承。`)
  } else {
    status = 'PASS'
    evidence.push(`计划 ${subtasks.length} 项档位合法；子会话=${childrenWithEffort.map((child) => `${subtaskFromLabel(child.label) || child.label}:${child.effort}`).join(',')}；主 Agent=${parentEffort}。`)
  }
  checks.push(check('C6', '推理等级按子任务自决、不继承主 Agent', status, evidence))
}

const summary = {
  main: args.main,
  sessionId: mainSessionId,
  planId,
  planSubtasks: subtasks.length,
  resultRows: statuses.length,
  children: childRows.length,
  checks,
  counts: checks.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc }, {}),
}

if (args.json) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`# dsh-workplan 2.2.0 e2e 证据（只读）`)
  console.log(`- 主会话：${mainSessionId || '?'}（${args.main}）`)
  console.log(`- 计划：${planId || '?'}；子任务定义 ${subtasks.length}；结果行 ${statuses.length}；子会话日志 ${childRows.length}`)
  for (const item of checks) {
    console.log(`\n[${item.status}] ${item.id} ${item.title}`)
    for (const line of item.evidence) console.log(`  - ${line}`)
  }
  console.log(`\n汇总：${JSON.stringify(summary.counts)}`)
}

const hardFail = checks.some((item) => item.status === 'FAIL')
process.exit(hardFail ? 1 : 0)
