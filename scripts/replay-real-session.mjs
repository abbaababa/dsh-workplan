#!/usr/bin/env node
/**
 * [1.5.2] 真实会话回放：把一份 DSH 会话日志（*.jsonl.zstd）里的 workplan 记录
 * 重新走一遍 `reconstructFromSession`，打印修复后的 phase / stats / 不变量告警。
 *
 * 用途：1.5.2 修的是「全部完成却显示正在收尾」。要证明修复对**用户真实遇到的那次
 * 事故**同样成立，不能只靠合成场景 —— 直接回放出事会话：
 *
 *   node scripts/replay-real-session.mjs \
 *     ~/.dsh/sessions/--路径编码--/session-xxxx/session.v4.jsonl.zstd
 *
 * 可加 `--plan <planId>` 回放同一会话里更早的计划；加 `--json` 只输出一行 JSON。
 * 退出码：0 = 回放出计划；2 = 会话里没有 workplan 记录或无法解码。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { derivePlanSnapshot, aggregateInvariantViolations } from '../lib/plan.js'
import { reconstructFromSession } from '../lib/runtime.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const planIndex = args.indexOf('--plan')
const targetPlanId = planIndex >= 0 ? args[planIndex + 1] : undefined
const file = args.find((arg, index) => !arg.startsWith('--') && (planIndex < 0 || index !== planIndex + 1))

if (!file) {
  console.error('用法: node scripts/replay-real-session.mjs <session.v4.jsonl.zstd> [--plan <planId>] [--json]')
  process.exit(2)
}

/**
 * 会话日志是**多帧** zstd（每次追加一帧）。Node 的 `zstdDecompressSync` 只解
 * 第一帧，拿到的是会话头，所以这里用系统 `zstd -dc`；失败必须响亮退出，
 * 否则会对一份被截断的日志下结论。
 */
function readSessionText(path) {
  if (!path.endsWith('.zst') && !path.endsWith('.zstd')) return readFileSync(path, 'utf8')
  const decoded = spawnSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 })
  if (decoded.error || decoded.status !== 0) {
    console.error(`无法解压会话日志（需要系统 zstd）: ${decoded.error?.message ?? decoded.stderr?.toString() ?? `exit ${decoded.status}`}`)
    process.exit(2)
  }
  return decoded.stdout.toString('utf8')
}

const text = readSessionText(file)
const events = []
for (const line of text.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed) continue
  try {
    events.push(JSON.parse(trimmed))
  } catch {
    // 尾行可能是半条记录（进程被杀），跳过而不是整份作废。
  }
}
if (events.length === 0) {
  console.error('会话日志里没有可解析的事件。')
  process.exit(2)
}

const session = {
  seq: events.length,
  header: events[0]?.header ?? { createdAt: Date.now() },
  eventAt: (seq) => events[seq],
}

const record = reconstructFromSession(session, targetPlanId)
if (!record) {
  console.error('该会话里没有可回放的 workplan 记录。')
  process.exit(2)
}

const snapshot = record.degraded ? derivePlanSnapshot([]) : derivePlanSnapshot(record.statuses)
const violations = record.degraded ? [] : aggregateInvariantViolations(snapshot, record.phase)
const result = {
  session: file,
  planId: record.planId,
  title: record.title,
  phase: record.phase,
  stats: snapshot.stats,
  subTasks: Array.isArray(record.statuses) ? record.statuses.length : 0,
  violations,
}

if (asJson) {
  console.log(JSON.stringify(result))
} else {
  console.log(`会话: ${file}`)
  console.log(`计划: ${record.planId} · ${record.title}`)
  console.log(`阶段: ${record.phase}`)
  console.log(`统计: total=${snapshot.stats.total} done=${snapshot.stats.done} blocked=${snapshot.stats.blocked} inProgress=${snapshot.stats.inProgress} pending=${snapshot.stats.pending} progress=${snapshot.stats.progress}`)
  console.log(`子任务: ${result.subTasks}`)
  console.log(`不变量告警: ${violations.length ? violations.join(' | ') : '无'}`)
}
