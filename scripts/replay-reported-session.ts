/**
 * 真实会话回放：把用户报告的 session-91ec3273 里所有 workplan 结果报文重新算一遍。
 *
 * 目的（1.4.3 验收证据，非发布物）：
 *  1. 证明用户截图那一刻“显示 0 正在做、实际 1 个正在做”是**真实缺陷**，不是观感问题；
 *  2. 证明修复后（`derivePlanSnapshot`）同一份历史数据算出的数字与状态列表一致；
 *  3. 证明修复不依赖“重新跑一遍任务”，历史报文即可自证。
 *
 * 运行：
 *   node --experimental-strip-types scripts/replay-reported-session.ts <session.v4.jsonl.zstd> [--expect-fixed]
 *
 * 不加 --expect-fixed 时只打印对照表；加 --expect-fixed 时若仍有报文自相矛盾则以非 0 退出。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { RESULT_MARKER_BEGIN, RESULT_MARKER_END, derivePlanSnapshot } from '../src/plan.ts'

type Row = {
  seq: number
  at: string
  shipped: any
  derived: any
  statuses: any[]
}

const args = process.argv.slice(2)
const expectFixed = args.includes('--expect-fixed')
const file = args.find((arg) => !arg.startsWith('--'))

if (!file) {
  console.error('用法: node --experimental-strip-types scripts/replay-reported-session.ts <session.v4.jsonl.zstd> [--expect-fixed]')
  process.exit(2)
}

/*
 * Session logs are **multi-frame** zstd streams (one frame per append). Node's
 * `zstdDecompressSync` stops after the first frame — it returns only the
 * session header — so the system `zstd` CLI is used to decode every frame.
 * If it is missing the replay cannot be trusted, and it must fail loudly rather
 * than silently analyse a truncated log.
 */
function readSession(path: string): string {
  if (!path.endsWith('.zst') && !path.endsWith('.zstd')) return readFileSync(path, 'utf8')
  const decoded = spawnSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 })
  if (decoded.error || decoded.status !== 0) {
    console.error(`无法解压会话日志（需要系统 zstd 命令）: ${decoded.error?.message ?? decoded.stderr?.toString() ?? `exit ${decoded.status}`}`)
    process.exit(2)
  }
  return decoded.stdout.toString('utf8')
}

const text = readSession(file)

function collectText(node: any, out: string[]): void {
  if (typeof node === 'string') {
    if (node.includes(RESULT_MARKER_BEGIN)) out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectText(value, out)
  }
}

const rows: Row[] = []
const lines = text.split('\n')
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index].trim()
  if (!line) continue
  let event: any
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const texts: string[] = []
  collectText(event, texts)
  for (const body of texts) {
    const start = body.indexOf(RESULT_MARKER_BEGIN)
    const end = body.indexOf(RESULT_MARKER_END)
    if (start < 0 || end < start) continue
    let payload: any
    try {
      payload = JSON.parse(body.slice(start + RESULT_MARKER_BEGIN.length, end).trim())
    } catch {
      continue
    }
    if (!payload || payload.kind !== 'workplan-result' || !Array.isArray(payload.statuses)) continue
    rows.push({
      seq: Number(event.seq ?? index + 1),
      at: String(event.at ?? event.time ?? event.data?.at ?? ''),
      shipped: payload.stats,
      derived: derivePlanSnapshot(payload.statuses).stats,
      statuses: payload.statuses,
    })
  }
}

if (rows.length === 0) {
  console.error('没有在该会话里找到 workplan 结果报文。')
  process.exit(2)
}

const FIELDS = ['total', 'done', 'blocked', 'inProgress', 'pending', 'progress'] as const

function differingFields(row: Row): string[] {
  return FIELDS.filter((field) => (row.shipped?.[field] ?? null) !== (row.derived as any)[field])
}

function residue(row: Row): string[] {
  return row.statuses
    .filter((item: any) => item?.status === 'pending' && (Number(item.progress) > 0 || item.childId || item.startedAt))
    .map((item: any) => `${item.subtaskId}(progress=${item.progress ?? 0}${item.childId ? ', childId' : ''})`)
}

const mismatches = rows.filter((row) => differingFields(row).length > 0)

console.log(`会话文件: ${file}`)
console.log(`workplan 结果报文: ${rows.length} 条；其中 1.4.2 发出时与状态列表不一致: ${mismatches.length} 条`)
console.log(`其中「待做却带着旧进度/旧子 Agent」的报文（D3 残留）: ${rows.filter((row) => residue(row).length > 0).length} 条\n`)

console.log('seq        done  inProgress  pending  progress(1.4.2→1.4.3)  不一致字段')
for (const row of rows) {
  const fields = differingFields(row)
  const progress = `${row.shipped?.progress ?? '?'}→${row.derived.progress}`
  console.log(
    `${String(row.seq).padEnd(10)} ${String(row.derived.done).padEnd(5)} ${String(row.derived.inProgress).padEnd(11)} ${String(row.derived.pending).padEnd(8)} ${progress.padEnd(23)} ${fields.length > 0 ? fields.join(',') : '—'}`
  )
}

const residualRows = rows.filter((row) => residue(row).length > 0)
if (residualRows.length > 0) {
  console.log('\nD3 证据（1.4.2 把预算暂停项重置为 pending 却留着旧字段）：')
  for (const row of residualRows) console.log(`  seq=${row.seq}: ${residue(row).join(' ')}`)
}

const progressRows = mismatches.filter((row) => differingFields(row).includes('progress'))
if (progressRows.length > 0) {
  console.log('\n进度虚高证据（1.4.2 直接把每条 progress 求平均，不看状态）：')
  for (const row of progressRows) {
    console.log(`  seq=${row.seq}: 显示 ${row.shipped?.progress}% / 按状态应为 ${row.derived.progress}%`)
  }
}

if (expectFixed) {
  const stillWrong = mismatches
  /*
   * 历史报文永远保留 1.4.2 当时写下的数字，这是“证据”，不该被改写；修复的判据是
   * **用修复后的算法重算同一份 statuses 与显示数字不再冲突**。因此 --expect-fixed
   * 断言的是：所有报文的派生结果都满足不变量，且至少有一条历史报文能被证明曾经错。
   */
  const violations = rows.flatMap((row) => {
    const snapshot = derivePlanSnapshot(row.statuses)
    const total = snapshot.stats.total
    const sum = snapshot.stats.done + snapshot.stats.blocked + snapshot.stats.inProgress + snapshot.stats.pending
    const problems: string[] = []
    if (sum !== total) problems.push(`seq=${row.seq}: 四状态之和 ${sum} ≠ total ${total}`)
    if (snapshot.stats.progress < 0 || snapshot.stats.progress > 100) problems.push(`seq=${row.seq}: progress 越界 ${snapshot.stats.progress}`)
    for (const item of snapshot.statuses) {
      if (item.status === 'pending' && (item.progress !== 0 || item.childId !== null || item.startedAt !== null)) {
        problems.push(`seq=${row.seq}: ${item.subtaskId} 仍是 pending 却带着 progress=${item.progress}`)
      }
      if (item.status === 'done' && item.progress !== 100) problems.push(`seq=${row.seq}: ${item.subtaskId} done 却 progress=${item.progress}`)
    }
    return problems
  })
  if (violations.length > 0) {
    console.error('派生结果仍违反不变量:')
    for (const line of violations) console.error(`  - ${line}`)
    process.exit(1)
  }
  if (stillWrong.length === 0) {
    console.error('没有找到任何“历史显示值与状态列表不一致”的报文：证据不足，无法证明缺陷曾经存在。')
    process.exit(1)
  }
  console.log(`修复后：${rows.length} 条历史报文全部满足不变量；其中 ${stillWrong.length} 条 1.4.2 的历史显示值被证明与状态列表不符（已由派生算法纠正）。`)
  console.log('OK')
}
