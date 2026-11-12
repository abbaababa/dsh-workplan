#!/usr/bin/env node
/**
 * repair-poison-notices.mjs — backup-first repair for "poison" DSH session archives.
 *
 * Defects repaired (both verified against the real implementation):
 *  1. Events with a type outside KNOWN_SESSION_EVENT_TYPES that lack the
 *     envelope marker `ignorable: true`. The real read path refuses them:
 *     @deepseek-ai/dsh-session-persistence/src/storage-contract.ts:75
 *       if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw ...
 *  2. The whole JSONL log packed into ONE zstd frame. The real read path
 *     requires the first frame to decode to exactly one header line:
 *     @deepseek-ai/dsh-session-persistence-jsonl/src/index.ts:78 assertZstdHeaderFrame,
 *     called at :1018 (readZstdPrefix) and :1519 (readFirstZstdLine / list()).
 *     list() silently skips such files, making sessions disappear.
 *
 * Repair strategy (minimal, byte-preserving):
 *  - Decompress all frames; keep the header line byte-identical.
 *  - For each event line needing the marker, insert `"ignorable":true,`
 *    immediately after the opening `{` — every other byte of the line is kept.
 *  - Re-encode as: frame 1 = header line + "\n" (checksummed zstd, exactly like
 *    compressZstdFrame in the implementation), frame 2 = remaining lines.
 *    If the first frame already is exactly the header, its bytes are preserved.
 *  - Backups are written and hash-verified BEFORE any repaired byte is produced.
 *
 * Modes:
 *  - Default (dry-run): operates ONLY on workspace copies under --workdir;
 *    the live archives under --source are read, never written.
 *  - --apply: backs up each live archive in place (session.v4.jsonl.zstd.bak-<ts>)
 *    and atomically replaces it (tmp + rename). Not used by the T3 dry-run.
 *
 * Frame scanning below is a faithful port of scanZstdFrames from
 * @deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts:48-104 (sha256 of the
 * source file at port time: fb5a0a148b0723fba4083670d6ba654794f40a30815593e99a47694df6945cd8).
 * Compression uses node:zlib zstdCompress with ZSTD_c_checksumFlag=1, identical
 * to compressZstdFrame (zstd.ts:111-113). The known-type set is copied verbatim
 * from @deepseek-ai/dsh-session/src/known-event-types.ts:22-86.
 *
 * Usage:
 *   node repair-poison-notices.mjs [--source DIR] [--workdir DIR] [--ids a,b,c]
 *                                  [--project-dir NAME] [--apply]
 */
import { constants as zlibConstants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, renameSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
const CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }
const ZSTD_MAGIC = 0xFD2FB528

const DEFAULT_IDS = [
  '1075b1b0-adc5-429f-8d9f-3bd9c457fc87',
  '4b036b43-271b-41d2-9b5a-138b98eff969',
  '72c219a9-56a6-4f52-8808-cb0e104e885f',
  'd93cd464-061b-4cdd-bd1f-41282ef98c81',
]
const DEFAULT_PROJECT_DIR = '--Users-open-Documents-Stocks--'
const LOG_NAME = 'session.v4.jsonl.zstd'

/** Verbatim copy of KNOWN_SESSION_EVENT_TYPES (known-event-types.ts:22-86, 64 types). */
const KNOWN_SESSION_EVENT_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided',
  'approval/policy', 'assistant/attempt', 'assistant/message', 'command/done', 'command/run',
  'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
  'deliverables/presented', 'developer/message', 'feedback/message-delete', 'feedback/message-put',
  'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'image/offload',
  'job/registered', 'job/settled', 'llm/retry', 'llm/retry-started', 'model/selection',
  'permission/preset', 'plan/mode', 'request/context', 'request/header', 'sandbox/mode',
  'schedule/change', 'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title',
  'session/title-llm-request', 'step/end', 'step/start', 'subagent/catalog', 'subagent/descriptor',
  'subagent/model-selection-policy', 'system/message', 'team/member', 'team/message/delivered',
  'team/message/queued', 'team/mode', 'team/task', 'todo/write', 'tool-workflow/agent-end',
  'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call',
  'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/result', 'turn/end', 'turn/start',
  'user/message', 'web/deepseek-search-llm-request', 'working-directory/change', 'workspace/changes',
])

/** Faithful port of scanZstdFrames (zstd.ts:48-104). */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** Exact replica of assertZstdHeaderFrame (index.ts:78-82). */
function assertZstdHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

async function decodeFrames(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (tornStart !== undefined) throw new Error(`torn final frame at byte ${tornStart}; refusing to repair a torn log`)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const plaintexts = []
  for (const f of frames) plaintexts.push(await zstdDecompressAsync(buffer.subarray(f.start, f.end)))
  return { frames, plaintexts }
}

/** Insert `"ignorable":true,` after the opening brace; verify semantic + byte minimality. */
function markIgnorable(line) {
  if (!line.startsWith('{')) throw new Error('event line does not start with "{"')
  const edited = '{"ignorable":true,' + line.slice(1)
  const before = JSON.parse(line)
  const after = JSON.parse(edited)
  deepStrictEqual(after, { ...before, ignorable: true })
  if (edited.replace('"ignorable":true,', '') !== line) throw new Error('edit is not byte-minimal')
  return edited
}

function parseArgs(argv) {
  const args = { apply: false, ids: DEFAULT_IDS, projectDir: DEFAULT_PROJECT_DIR }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--source') args.source = argv[++i]
    else if (a === '--workdir') args.workdir = argv[++i]
    else if (a === '--project-dir') args.projectDir = argv[++i]
    else if (a === '--ids') args.ids = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else throw new Error(`unknown argument: ${a}`)
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  args.source = resolve(args.source ?? join(homedir(), '.dsh', 'sessions', args.projectDir))
  args.workdir = resolve(args.workdir ?? join(scriptDir, '..', 'reports', '_r3_fix_t3_20261112', 'poison-dryrun'))
  return args
}

/** Write bytes durably via tmp + rename inside the destination directory. */
async function atomicWrite(dest, bytes) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = dest + '.tmp-' + process.pid
  const fh = await open(tmp, 'w')
  try { await fh.writeFile(bytes); await fh.sync() } finally { await fh.close() }
  renameSync(tmp, dest)
}

function backupOnce(backupPath, sourceBytes, sourceSha) {
  if (existsSync(backupPath)) {
    const existing = readFileSync(backupPath)
    if (sha256(existing) !== sourceSha) {
      throw new Error(`backup already exists with DIFFERENT content, refusing to overwrite: ${backupPath}`)
    }
    return { created: false, sha256: sourceSha }
  }
  mkdirSync(dirname(backupPath), { recursive: true })
  writeFileSync(backupPath, sourceBytes, { flag: 'wx' })
  const check = sha256(readFileSync(backupPath))
  if (check !== sourceSha) throw new Error(`backup hash mismatch after write: ${backupPath}`)
  return { created: true, sha256: check }
}

async function repairOne(id, args) {
  const rel = join(args.projectDir, `session-${id}`, LOG_NAME)
  const sourcePath = join(args.source, `session-${id}`, LOG_NAME)
  const sourceBytes = readFileSync(sourcePath)
  const sourceSha = sha256(sourceBytes)
  const report = {
    id, sourcePath, sourceSha256: sourceSha, sourceBytes: sourceBytes.length,
    mode: args.apply ? 'apply' : 'dry-run',
  }

  // --- backup BEFORE any repair work -------------------------------------
  const backupPath = args.apply
    ? join(args.source, `session-${id}`, `${LOG_NAME}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    : join(args.workdir, 'backups', rel)
  report.backup = { path: backupPath, ...backupOnce(backupPath, sourceBytes, sourceSha) }

  // --- dry-run keeps a hash-verified workspace copy of the original ------
  if (!args.apply) {
    const copyPath = join(args.workdir, 'copies', rel)
    if (existsSync(copyPath)) {
      if (sha256(readFileSync(copyPath)) !== sourceSha) throw new Error(`workspace copy differs from source: ${copyPath}`)
    } else {
      mkdirSync(dirname(copyPath), { recursive: true })
      copyFileSync(sourcePath, copyPath)
      if (sha256(readFileSync(copyPath)) !== sourceSha) throw new Error(`copy hash mismatch: ${copyPath}`)
    }
    report.workspaceCopy = copyPath
  }

  // --- analyze ------------------------------------------------------------
  const { frames, plaintexts } = await decodeFrames(sourceBytes)
  const text = Buffer.concat(plaintexts).toString('utf8')
  if (!text.endsWith('\n')) throw new Error('log does not end with a newline; refusing to repair')
  const lines = text.split('\n')
  lines.pop() // trailing empty piece after the final newline
  if (lines.length < 1) throw new Error('log has no header line')
  const headerLine = lines[0]
  const headerObj = JSON.parse(headerLine)
  // SessionId is branded with the "session-" prefix; directory names repeat it.
  const expectedHeaderId = id.startsWith('session-') ? id : `session-${id}`
  if (headerObj.id !== expectedHeaderId) {
    throw new Error(`header id ${headerObj.id} does not match session ${expectedHeaderId}`)
  }
  report.headerId = headerObj.id

  let firstFrameIsHeaderOnly = false
  try { assertZstdHeaderFrame(plaintexts[0]); firstFrameIsHeaderOnly = true } catch { /* defect 2 present */ }
  report.framesBefore = frames.length
  report.firstFrameHeaderOnlyBefore = firstFrameIsHeaderOnly
  report.totalLines = lines.length
  report.eventLines = lines.length - 1

  const changed = []
  const unknownTypes = {}
  const outLines = [headerLine]
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const obj = JSON.parse(line)
    if (!KNOWN_SESSION_EVENT_TYPES.has(obj.type)) {
      unknownTypes[obj.type] = (unknownTypes[obj.type] ?? 0) + 1
      if (obj.ignorable !== true) {
        const edited = markIgnorable(line)
        outLines.push(edited)
        changed.push({ lineNumber: i + 1, seq: obj.seq, type: obj.type })
        continue
      }
    }
    outLines.push(line)
  }
  report.unknownTypeCounts = unknownTypes
  report.linesChanged = changed.length
  report.changedLines = changed

  // --- re-encode ----------------------------------------------------------
  const newText = outLines.join('\n') + '\n'
  let outBytes
  if (firstFrameIsHeaderOnly && changed.length === 0) {
    outBytes = sourceBytes // already healthy: preserve original bytes exactly
    report.alreadyHealthy = true
  } else {
    const headerFrame = firstFrameIsHeaderOnly
      ? sourceBytes.subarray(frames[0].start, frames[0].end)
      : await zstdCompressAsync(headerLine + '\n', CHECKSUM_OPTIONS)
    const bodyText = outLines.slice(1).map(l => l + '\n').join('')
    const bodyFrame = bodyText.length > 0 ? await zstdCompressAsync(bodyText, CHECKSUM_OPTIONS) : Buffer.alloc(0)
    outBytes = Buffer.concat([headerFrame, bodyFrame])
    report.alreadyHealthy = false
  }

  // --- self-verification BEFORE writing -----------------------------------
  const outScan = scanZstdFrames(outBytes)
  if (outScan.tornStart !== undefined) throw new Error('output has a torn frame')
  const outPlaintexts = []
  for (const f of outScan.frames) outPlaintexts.push(await zstdDecompressAsync(outBytes.subarray(f.start, f.end)))
  assertZstdHeaderFrame(outPlaintexts[0])
  if (outPlaintexts[0].toString('utf8') !== headerLine + '\n') throw new Error('output header line changed')
  if (Buffer.concat(outPlaintexts).toString('utf8') !== newText) throw new Error('output plaintext mismatch')
  const outLinesCheck = Buffer.concat(outPlaintexts).toString('utf8').split('\n').slice(0, -1)
  for (let i = 0; i < outLinesCheck.length; i++) {
    if (i === 0) continue
    const original = lines[i]
    const wasChanged = changed.some(c => c.lineNumber === i + 1)
    if (!wasChanged && outLinesCheck[i] !== original) throw new Error(`unchanged line ${i + 1} differs byte-wise`)
  }
  report.framesAfter = outScan.frames.length
  report.outputBytes = outBytes.length
  report.outputSha256 = sha256(outBytes)
  report.selfChecks = {
    firstFrameExactlyHeader: true,
    headerByteIdentical: true,
    plaintextMatchesExpected: true,
    unchangedLinesByteIdentical: true,
    allUnknownEventsIgnorable: outLinesCheck.slice(1).every(l => {
      const o = JSON.parse(l)
      return KNOWN_SESSION_EVENT_TYPES.has(o.type) || o.ignorable === true
    }),
  }

  // --- write --------------------------------------------------------------
  const destPath = args.apply ? sourcePath : join(args.workdir, 'repaired', rel)
  await atomicWrite(destPath, outBytes)
  if (sha256(readFileSync(destPath)) !== report.outputSha256) throw new Error('written file hash mismatch')
  report.destPath = destPath

  // --- plaintext evidence (dry-run only) ----------------------------------
  if (!args.apply) {
    const beforePath = join(args.workdir, 'plaintext-before', `${id}.jsonl`)
    const afterPath = join(args.workdir, 'plaintext-after', `${id}.jsonl`)
    mkdirSync(dirname(beforePath), { recursive: true })
    writeFileSync(beforePath, text)
    writeFileSync(afterPath, newText)
    report.plaintextBefore = beforePath
    report.plaintextAfter = afterPath
  }
  return report
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(`[repair-poison-notices] mode=${args.apply ? 'APPLY (live archives)' : 'DRY-RUN (workspace copies only)'}`)
  console.log(`[repair-poison-notices] source=${args.source}`)
  console.log(`[repair-poison-notices] workdir=${args.workdir}`)
  const reports = []
  let failed = 0
  for (const id of args.ids) {
    try {
      const r = await repairOne(id, args)
      reports.push(r)
      const repDir = join(args.workdir, 'reports')
      mkdirSync(repDir, { recursive: true })
      writeFileSync(join(repDir, `${id}.json`), JSON.stringify(r, null, 2) + '\n')
      console.log(`OK ${id} frames ${r.framesBefore}->${r.framesAfter} lines=${r.totalLines} changed=${r.linesChanged} healthy=${r.alreadyHealthy} sha=${r.outputSha256.slice(0, 12)}`)
    } catch (e) {
      failed++
      reports.push({ id, error: String(e && e.stack || e) })
      console.error(`FAIL ${id}: ${String(e && e.message || e)}`)
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    source: args.source, workdir: args.workdir,
    total: args.ids.length, ok: args.ids.length - failed, failed,
    sessions: reports.map(r => ({
      id: r.id, error: r.error, framesBefore: r.framesBefore, framesAfter: r.framesAfter,
      totalLines: r.totalLines, linesChanged: r.linesChanged,
      unknownTypeCounts: r.unknownTypeCounts, outputSha256: r.outputSha256,
      backupSha256: r.backup?.sha256, selfChecks: r.selfChecks,
    })),
  }
  mkdirSync(join(args.workdir, 'reports'), { recursive: true })
  writeFileSync(join(args.workdir, 'reports', 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`[repair-poison-notices] done: ${summary.ok}/${summary.total} ok, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

await main()
