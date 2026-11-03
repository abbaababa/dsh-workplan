#!/usr/bin/env node
/**
 * 计算发布物的 SHA-256 完整性凭据（T4 · CC G-12 AGD_PRE / G-15 ALC_DEL 的流程件）。
 *
 * 用途：每次发布（npm pack 产物 .tgz、GitHub tag 资产等）后运行本脚本，
 * 把输出的 JSON 清单随 release 一起公布，用户即可在安装前校验下载物完整性
 * （CC AGD_PRE.1「准备程序」与 ALC_DEL.1「交付程序」的落地步骤）。
 *
 * 用法：
 *   node scripts/compute-release-sha256.mjs <file> [<file> ...]
 *   node scripts/compute-release-sha256.mjs dsh-workplan-1.12.0.tgz --out sha256-manifest.json
 *
 * 输出：确定性 JSON（无时间戳、键已排序，两次对同一批文件运行结果逐字节一致，
 * 便于把清单本身也纳入校验）。--out 可同时写入文件。
 *
 * 设计约束：只读输入文件、只写用户显式指定的 --out 路径；不做网络请求；
 * 缺文件即非零退出，绝不输出"看起来像成功"的部分清单。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
let outPath = null
if (outIdx !== -1) {
  outPath = args[outIdx + 1]
  if (!outPath) {
    console.error('error: --out requires a path')
    process.exit(2)
  }
  args.splice(outIdx, 2)
}

if (args.length === 0) {
  console.error('usage: node scripts/compute-release-sha256.mjs <file> [...] [--out manifest.json]')
  process.exit(2)
}

const entries = []
for (const file of args) {
  let bytes
  try {
    bytes = readFileSync(file)
  } catch (err) {
    console.error(`error: cannot read ${file}: ${err.message}`)
    process.exit(1)
  }
  entries.push({
    file: basename(file),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

// 对同一批文件确定性输出：entries 本身按命令行顺序，但每个对象键固定；
// 顶层用 { files: [...] }，不混入时间戳或环境信息。
const manifest = { algorithm: 'sha256', files: entries }
const text = JSON.stringify(manifest, null, 2) + '\n'

if (outPath) {
  writeFileSync(outPath, text)
  console.error(`wrote ${outPath}`)
}
process.stdout.write(text)
