#!/usr/bin/env node
/**
 * [2.5.3] 修复「重启后 SessionFormatError: system/message requires a protected
 * first surface head」的既有会话日志（只处理已静止/加载失败的会话，勿对正在运行
 * 的会话使用）。
 *
 * 根因：2.5.3 之前的 dsh-workplan 在宿主写入受保护 system/message 头之前，就把
 * 【规划预告】/【规划进行中】等通知以 user/message(surfaceOp:append) 落到 surface，
 * 使首条 surface 事件不是 system/message；重启回放校验即整会话判损坏。
 *
 * 修法（最小、可逆、保内容）：把「首条 system/message 之前、且 source.kind 为
 * workplan 的 user/message 通知」改写为 log-only 事件类型 workplan/notice（不在
 * SURFACE_TYPES 内，校验器按 log-only 忽略），其余事件与 seq 原样保留。于是首条
 * surface 事件恢复为 system/message 头，校验通过；通知内容仍留在日志可检索。
 * 原始文件先备份为 <log>.bak-pre253，绝不删除。
 *
 * 用法：node scripts/repair-prehead-notices.mjs <session.v4.jsonl.zstd> [...]
 * 仅依赖本机 zstd CLI 与 Node，无网络、无依赖安装。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SURFACE = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])

/** 忠实复刻 v4 Relationships.foldSurface 的 surface/protectedHead 规则（只读校验）。 */
function validateSurface(events) {
  const surface = []
  let protectedHead
  for (const event of events) {
    if (!SURFACE.has(event.type)) continue
    if (event.type === 'system/message' && surface.length > 0 && protectedHead === undefined) {
      throw new Error('system/message requires a protected first surface head')
    }
    if (event.surfaceOp === 'append') {
      if (event.type === 'system/message' && surface.length === 0) protectedHead = event.seq
      surface.push(event.seq)
      continue
    }
    const op = event.surfaceOp
    const first = surface.indexOf(op.startSeq)
    const last = surface.indexOf(op.endSeq)
    if (first < 0 || last < first) throw new Error(`${event.type} replacement range is not on the current surface`)
    const removed = surface.slice(first, last + 1)
    const sources = event.sourceEventSeqs || []
    if (removed.some((s) => !sources.includes(s))) throw new Error('replacement sourceEventSeqs omit a shadowed surface node')
    if (protectedHead !== undefined && removed.includes(protectedHead)) {
      if (event.type !== 'system/message' || removed.length !== 1) throw new Error('surface replacement cannot shadow the protected system head')
      protectedHead = event.seq
    }
    surface.splice(first, removed.length, event.seq)
  }
  return { surface, protectedHead }
}

function repairOne(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 }).toString('utf8')
  const events = raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
  // 先证明原日志确实触发该报错（避免误修健康日志）。
  let originalError = null
  try { validateSurface(events) } catch (e) { originalError = e.message }
  const headIdx = events.findIndex((e) => e.type === 'system/message')
  if (headIdx < 0) { console.log(`SKIP ${file}: 无 system/message 头，非本缺陷`); return }
  let changed = 0
  for (let i = 0; i < headIdx; i += 1) {
    const e = events[i]
    if (e.type === 'user/message' && e.surfaceOp === 'append' && e.data && e.data.source && e.data.source.kind === 'workplan') {
      e.type = 'workplan/notice' // log-only：不在 SURFACE_TYPES，校验器忽略
      changed += 1
    }
  }
  if (changed === 0) { console.log(`SKIP ${file}: 头前无 workplan 通知（原校验=${originalError ?? 'pass'}）`); return }
  // 修复后必须通过 surface 校验，否则不落盘。
  const after = validateSurface(events)
  if (after.protectedHead === undefined) throw new Error('repair 后仍无 protectedHead，拒绝落盘')
  const backup = `${file}.bak-pre253`
  copyFileSync(file, backup)
  const dir = mkdtempSync(join(tmpdir(), 'wp-repair-'))
  const plain = join(dir, 'session.v4.jsonl')
  writeFileSync(plain, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  execFileSync('zstd', ['-q', '-f', '-o', file, plain])
  console.log(`REPAIRED ${file}: 改写 ${changed} 条头前 workplan 通知为 log-only；备份=${backup}；修复后 surface 首事件 seq=${after.surface[0]} protectedHead=${after.protectedHead}；原校验=${originalError ?? 'pass'}`)
}

const files = process.argv.slice(2)
if (files.length === 0) { console.error('用法: node scripts/repair-prehead-notices.mjs <session.v4.jsonl.zstd> [...]'); process.exit(2) }
for (const f of files) repairOne(f)
