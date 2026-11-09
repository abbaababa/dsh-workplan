#!/usr/bin/env node
/*
 * [2.2.1] One-time repair for sessions corrupted by dsh-workplan <= 2.2.0.
 *
 * What went wrong: the plugin appended plain strings as `user/message` data.
 * DSH stores non-record payloads without complaint, but projections assume the
 * canonical message shape and crash on `event.data.source.kind`:
 *   "Cannot read properties of undefined (reading 'kind')"
 * The GUI reports that as "历史加载失败 / failed to project session".
 *
 * What this script does:
 *  - decompresses session.v4.jsonl.zstd (concatenated zstd frames);
 *  - converts every malformed `user/message` payload that is a plain string
 *    into a complete DSH UserMessage. The original text is preserved verbatim;
 *    source.kind becomes 'workplan' for known dsh-workplan notice text and
 *    'recovered' for any other producer, so attribution is never invented:
 *      { id, role:'user', content:[{type:'text', text}],
 *        source:{ kind:'workplan'|'recovered', form:'notice', summary } }
 *  - preserves seq/time/surfaceOp/sourceEventSeqs/ignorable and the event count;
 *  - validates every `user/message` after conversion and seq continuity;
 *  - dry-runs by default; `--write` backs up the original, writes atomically,
 *    verifies the result by decompressing again, and invalidates a projection
 *    cache only when its watermark reaches the repaired range.
 *
 * Refuses to write while any process holds the log open (for example a live
 * DSH server). Stop DSH first, run with --write, then start DSH again.
 *
 * Usage:
 *   node scripts/repair-malformed-user-messages.mjs <session-id|session-dir|.zstd> [...] [--write] [--force]
 *   node scripts/repair-malformed-user-messages.mjs --scan-recent [--hours 24] [--write]
 *
 * `--scan-recent` repairs every session log modified within the last N hours
 * (default 24), which is the safe post-incident blast-radius check.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const CHECKSUM_LEVEL_19 = {
  params: {
    [zlibConstants.ZSTD_c_compressionLevel]: 19,
    [zlibConstants.ZSTD_c_checksumFlag]: 1,
  },
}
const MAX_BUFFER = 1024 * 1024 * 1024

const rawArgs = process.argv.slice(2)
const write = rawArgs.includes('--write')
const force = rawArgs.includes('--force')
const scanRecent = rawArgs.includes('--scan-recent')
const hoursIndex = rawArgs.indexOf('--hours')
const scanHours = hoursIndex === -1 ? 24 : Number(rawArgs[hoursIndex + 1])
const targets = []
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index]
  if (arg === '--hours') {
    index += 1
    continue
  }
  if (arg.startsWith('--')) continue
  targets.push(arg)
}

if (targets.length === 0 && !scanRecent) {
  console.error('usage: node scripts/repair-malformed-user-messages.mjs <session-id|session-dir|.zstd> [...] [--write] [--force]')
  console.error('       node scripts/repair-malformed-user-messages.mjs --scan-recent [--hours 24] [--write]')
  process.exit(2)
}
if (scanRecent && (!Number.isFinite(scanHours) || scanHours <= 0 || scanHours > 24 * 365)) {
  console.error(`--hours must be a positive number, got ${String(rawArgs[hoursIndex + 1])}`)
  process.exit(2)
}

function log(message) {
  console.log(message)
}

function oneLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim() || '（无摘要）'
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`
}

function shapeProblem(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'payload is not a plain object'
  if (typeof data.id !== 'string' || data.id.length === 0) return 'missing message id'
  if (data.role !== 'user') return 'role must be "user"'
  if (!Array.isArray(data.content) || data.content.length === 0) return 'content must be a non-empty array'
  if (typeof data.source !== 'object' || data.source === null) return 'missing source'
  if (typeof data.source.kind !== 'string' || data.source.kind.length === 0) return 'missing source.kind'
  return null
}

function resolveSessionFile(target) {
  const direct = resolve(target)
  if (existsSync(direct)) {
    const stat = statSync(direct)
    if (stat.isFile() && direct.endsWith('.zstd')) return direct
    if (stat.isDirectory()) {
      const candidate = join(direct, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) return candidate
      throw new Error(`no session.v4.jsonl.zstd in ${direct}`)
    }
  }
  if (/^session-[0-9a-f-]+$/i.test(basename(target))) {
    const sessionsRoot = join(homedir(), '.dsh', 'sessions')
    const matches = []
    if (existsSync(sessionsRoot)) {
      for (const workspace of readdirSync(sessionsRoot)) {
        const candidate = join(sessionsRoot, workspace, basename(target), 'session.v4.jsonl.zstd')
        if (existsSync(candidate)) matches.push(candidate)
      }
    }
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error(`session id ${target} matched ${matches.length} workspaces; pass an explicit path`)
    throw new Error(`session id ${target} not found under ~/.dsh/sessions`)
  }
  throw new Error(`cannot resolve session target: ${target}`)
}

function assertNotOpen(file) {
  const probe = spawnSync('lsof', [file], { encoding: 'utf8' })
  if (probe.error || typeof probe.stdout !== 'string') return
  if (probe.stdout.trim().length > 0) {
    throw new Error(`refusing to write: the session log is still open by another process\n${probe.stdout.trim()}\nStop DSH first, then rerun with --write.`)
  }
}

function decompress(file) {
  return execFileSync('zstd', ['-dc', file], { maxBuffer: MAX_BUFFER })
}

function encodeContainer(lines) {
  const headerFrame = zstdCompressSync(Buffer.from(`${lines[0]}\n`), CHECKSUM_LEVEL_19)
  if (lines.length === 1) return headerFrame
  const eventsFrame = zstdCompressSync(Buffer.from(`${lines.slice(1).join('\n')}\n`), CHECKSUM_LEVEL_19)
  return Buffer.concat([headerFrame, eventsFrame])
}

function invalidateProjectionCache(sessionId, firstRepairedSeq) {
  const cachePath = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (!existsSync(cachePath)) return null
  let maxSeq = -1
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    for (const row of Object.values(cache?.record?.rows ?? {})) {
      if (Number.isSafeInteger(row?.seq) && row.seq > maxSeq) maxSeq = row.seq
    }
  } catch {
    maxSeq = firstRepairedSeq
  }
  if (maxSeq < firstRepairedSeq) return null
  const backup = `${cachePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSync(cachePath, backup)
  return backup
}

function repairOne(target) {
  const file = resolveSessionFile(target)
  log(`\n=== ${file} ===`)
  const text = decompress(file).toString('utf8')
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) throw new Error('session log is empty')

  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const header = parsed[0]
  if (header?.type !== 'session') throw new Error('first line is not a session header')
  const sessionId = String(header.id ?? basename(dirname(file)))
  const beforeCounts = new Map()
  const repairedSeqs = []
  let firstRepairedSeq = Number.POSITIVE_INFINITY

  for (let index = 1; index < parsed.length; index += 1) {
    const event = parsed[index]
    const expectedSeq = index - 1
    if (event?.seq !== expectedSeq) throw new Error(`event at line ${index + 1} has seq ${String(event?.seq)}, expected ${expectedSeq}`)
    if (event.type !== 'user/message') continue
    const problem = shapeProblem(event.data)
    if (problem === null) continue
    beforeCounts.set(problem, (beforeCounts.get(problem) ?? 0) + 1)
    if (typeof event.data !== 'string') {
      throw new Error(`seq ${event.seq}: unsupported malformed user/message (${problem}); refusing to guess a repair`)
    }
    const text = event.data
    const workplanNotice = /^\[dsh-workplan\] 子任务 /.test(text) || /^子任务 .+ 即将到点：/.test(text)
    event.data = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: workplanNotice ? 'workplan' : 'recovered',
        form: 'notice',
        summary: oneLine(text),
      },
    }
    repairedSeqs.push(event.seq)
    firstRepairedSeq = Math.min(firstRepairedSeq, event.seq)
  }

  log(`session: ${sessionId}`)
  log(`events: ${parsed.length - 1}; malformed user/message: ${repairedSeqs.length}`)
  if (repairedSeqs.length === 0) {
    log('result: clean, nothing to repair')
    return { file, sessionId, repaired: 0 }
  }
  log(`repaired seqs: ${repairedSeqs.slice(0, 20).join(', ')}${repairedSeqs.length > 20 ? ' …' : ''}`)
  log(`payload kinds: ${[...beforeCounts.entries()].map(([key, value]) => `${key}=${value}`).join(', ')}`)

  const repairedLines = parsed.map((event, index) => {
    const line = JSON.stringify(event)
    if (index === 0) return line
    if (event.type === 'user/message') {
      const problem = shapeProblem(event.data)
      if (problem !== null) throw new Error(`seq ${event.seq}: repaired payload still invalid (${problem})`)
    }
    return line
  })
  const encoded = encodeContainer(repairedLines)
  // A dry-run must not touch the (possibly read-only) session directory.
  const staged = write
    ? join(dirname(file), `.session.v4.jsonl.zstd.repair-${process.pid}.tmp`)
    : join(tmpdir(), `dsh-session-repair-${process.pid}.zst`)
  writeFileSync(staged, encoded, { mode: 0o600 })

  const verifyText = execFileSync('zstd', ['-dc', staged], { maxBuffer: MAX_BUFFER }).toString('utf8')
  const verifyLines = verifyText.split('\n').filter(Boolean)
  if (verifyLines.length !== lines.length) throw new Error(`verification failed: event line count ${verifyLines.length} != ${lines.length}`)
  const verifyEvents = verifyLines.map((line) => JSON.parse(line))
  const verifyHeader = verifyEvents[0]
  if (verifyHeader?.id !== sessionId) throw new Error('verification failed: session id changed')
  for (let index = 1; index < verifyEvents.length; index += 1) {
    if (verifyEvents[index].seq !== index - 1) throw new Error(`verification failed: seq discontinuity at ${index}`)
    if (verifyEvents[index].type === 'user/message') {
      const problem = shapeProblem(verifyEvents[index].data)
      if (problem !== null) throw new Error(`verification failed: seq ${verifyEvents[index].seq} (${problem})`)
    }
  }

  if (!write) {
    rmSync(staged, { force: true })
    log('dry-run: OK; pass --write to apply')
    return { file, sessionId, repaired: repairedSeqs.length, wrote: false }
  }
  if (!force) assertNotOpen(file)

  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(file, backup)
  renameSync(staged, file)
  const cacheBackup = invalidateProjectionCache(sessionId, firstRepairedSeq)
  log(`wrote: ${repairedSeqs.length} event(s) repaired`)
  log(`backup: ${backup}`)
  if (cacheBackup) log(`projection cache moved aside: ${cacheBackup}`)
  log(`verify: ${execFileSync('zstd', ['-dc', file], { maxBuffer: MAX_BUFFER }).toString('utf8').split('\n').filter(Boolean).length} lines readable`)
  return { file, sessionId, repaired: repairedSeqs.length, wrote: true, backup }
}

function recentSessionFiles(hours) {
  const sessionsRoot = join(homedir(), '.dsh', 'sessions')
  const cutoff = Date.now() - hours * 3600 * 1000
  const files = []
  if (!existsSync(sessionsRoot)) return files
  for (const workspace of readdirSync(sessionsRoot)) {
    const workspacePath = join(sessionsRoot, workspace)
    let sessionDirs = []
    try {
      sessionDirs = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue
      const file = join(workspacePath, entry.name, 'session.v4.jsonl.zstd')
      try {
        if (statSync(file).mtimeMs >= cutoff) files.push(file)
      } catch {
        // A session without a v4 log is not a repair candidate.
      }
    }
  }
  return files.sort()
}

const workTargets = scanRecent ? [...new Set([...recentSessionFiles(scanHours), ...targets])] : targets
if (scanRecent) log(`scan-recent: ${workTargets.length} session log(s) modified in the last ${scanHours}h`)

let failed = false
for (const target of workTargets) {
  try {
    repairOne(target)
  } catch (error) {
    failed = true
    console.error(`\n[ERROR] ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(failed ? 1 : 0)
