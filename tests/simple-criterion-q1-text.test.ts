/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：条文类用例（E-1）。
 * 承载用例：C-Q1-01、C-Q1-02、C-Q1-09、C-Q7-01、C-Q7-02、C-Q7-04
 * （cases.md §6.2；C-Q7-01/02/04 由本文件承载，避免重复建文件）。
 *
 * 预期唯一来源：reports/simple-criterion-v2-spec.md（AC-Q1-1/AC-Q1-5/AC-Q7-1/AC-Q7-3）。
 * 断言实现：复用 T5 冻结的条文检查器 reports/simple-criterion-v2-text-assertions.py
 * （TA-01…TA-07，v1.1 精化版），不重写第二套规则（防口径漂移）；
 * C-Q7-02① 的「15 分钟」运行层上下文检查为 cases.md 明列断言，检查器未含，
 * 在本文件内以同窗口（同行±1）同词表（运行层/兜底/预算）实现。
 * C-Q1-09 断言对象＝两个既有测试文件按 AC-Q1-5 改写后的新断言（改写由 T6 执行，
 * 见 tests/no-fixed-deadline-semantics.test.ts E1/E2 与 tests/time-estimate-negotiation.test.ts B1）。
 *
 * 已知预期红灯（不得为全绿放宽）：D-T5-1（plan.ts:1633 缺判据层标记，TA-04）。
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PLUGIN_ROOT = process.cwd()
const REPORTS = path.resolve(PLUGIN_ROOT, '../../reports')
const CHECKER = path.join(REPORTS, 'simple-criterion-v2-text-assertions.py')
const SRC_FILES = ['plan.ts', 'host.ts', 'runtime.ts', 'client.ts', 'llm-rules.ts']

let ta: Record<string, { ok: boolean; detail: string; level: string }> = {}

// [CI] 条文检查器位于作者工作区的 ../../reports（取证资产，不入库）；CI 检出目录没有它，
// 此时整组用例按 skip 处理，避免把"本机取证资产缺失"误报成插件缺陷。
const HAS_CHECKER = existsSync(CHECKER)
const SKIP = HAS_CHECKER ? false : '外部条文检查器 reports/simple-criterion-v2-text-assertions.py 不在当前工作区（CI 无取证目录）'

before(() => {
  if (!HAS_CHECKER) return
  const outDir = mkdtempSync(path.join(tmpdir(), 'scv2-t6-ta-'))
  const jsonPath = path.join(outDir, 'text-assertions.json')
  const run = spawnSync('python3', [CHECKER, '--json', jsonPath], { cwd: PLUGIN_ROOT, encoding: 'utf8' })
  assert.ok(run.status === 0 || run.status === 1, `条文检查器环境错误（exit=${run.status}）：${run.stderr}`)
  const payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
  for (const r of payload.results) ta[r.rule] = r
  rmSync(outDir, { recursive: true, force: true })
})

function rule(name: string) {
  assert.ok(ta[name], `检查器缺少规则 ${name}`)
  return ta[name]
}

test('C-Q1-01（AC-Q1-1 正例）：plan.ts 与 host.ts 均含判据层 10 分钟完成目标允许措辞＋两层标签同现' , { skip: SKIP }, () => {
  const ta01 = rule('TA-01')
  const ta02 = rule('TA-02')
  assert.equal(ta01.ok, true, `TA-01：${ta01.detail}`)
  assert.equal(ta02.ok, true, `TA-02：${ta02.detail}`)
})

test('C-Q1-02（AC-Q1-1 反例）：全仓 src 旧绝对否定零命中（命中即失败并打印文件行号）' , { skip: SKIP }, () => {
  const ta01b = rule('TA-01b')
  assert.equal(ta01b.ok, true, `TA-01b：${ta01b.detail}`)
})

test('C-Q1-09（AC-Q1-5 正例）：E1/B1 已改写为双向/条件断言（判据层目标句命中＋运行层禁令保留＋TA-05 条件）' , { skip: SKIP }, () => {
  const e1File = readFileSync(path.join(PLUGIN_ROOT, 'tests/no-fixed-deadline-semantics.test.ts'), 'utf8')
  const b1File = readFileSync(path.join(PLUGIN_ROOT, 'tests/time-estimate-negotiation.test.ts'), 'utf8')
  // 改写标记与 TA-05 条件断言函数必须在场（机械可 grep）
  for (const [label, source] of [['no-fixed-deadline-semantics(E1/E2)', e1File], ['time-estimate-negotiation(B1)', b1File]] as const) {
    assert.ok(source.includes('[SCv2-T6][C-Q1-09]'), `${label} 缺少 C-Q1-09 改写标记`)
    assert.ok(source.includes('function ta05Holds'), `${label} 缺少 TA-05 条件断言实现`)
    assert.ok(source.includes('ta05Holds('), `${label} 未调用 TA-05 条件断言`)
  }
  // E1 双向：判据层目标句正向断言必须在场（允许措辞三式之一）
  assert.ok(/assert\.ok\(\s*\/完成目标/.test(e1File) || e1File.includes('判据层目标句必须命中'), 'E1 缺少判据层目标句正向断言')
  // E2 补「运行层」标签断言（协商处运行层语境）
  assert.ok(e1File.includes('[SCv2-T6][C-Q1-09][E2]'), 'E2 缺少运行层标签断言标记')
  // B2/O-2b（146-164 区间守卫）必须保持不改：1、90、240 通过断言仍在
  assert.ok(b1File.includes('estimateMinutes=${value}（1–240 区间内）必须通过校验'), 'B2/O-2b 区间守卫断言被改动（必须保持）')
})

test('C-Q7-01（AC-Q7-1 正例）：两层标签同现＋10 分钟句归判据层＋120 分钟句归运行层（TA-02/TA-04）' , { skip: SKIP }, () => {
  const ta02 = rule('TA-02')
  const ta04 = rule('TA-04')
  assert.equal(ta02.ok, true, `TA-02：${ta02.detail}`)
  assert.equal(ta04.ok, true, `TA-04：${ta04.detail}`)
})

test('C-Q7-02（AC-Q7-1 边界）：每处「15 分钟」在运行层上下文＋无未标注规模参考＋10/120 归属不互换（TA-03/TA-04）' , { skip: SKIP }, () => {
  const ta03 = rule('TA-03')
  const ta04 = rule('TA-04')
  assert.equal(ta03.ok, true, `TA-03：${ta03.detail}`)
  // cases.md C-Q7-02①：每处「15 分钟」同行±1 含 运行层/兜底/预算
  const bad: string[] = []
  let total = 0
  for (const name of SRC_FILES) {
    const lines = readFileSync(path.join(PLUGIN_ROOT, 'src', name), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!/15\s*分钟/.test(lines[i])) continue
      total += 1
      const window = lines.slice(Math.max(0, i - 1), i + 2).join('\n')
      if (!/(运行层|兜底|预算)/.test(window)) bad.push(`${name}:${i + 1} ${lines[i].trim().slice(0, 80)}`)
    }
  }
  assert.deepEqual(bad, [], `「15 分钟」共 ${total} 处，以下位置缺运行层上下文（同行±1）：${bad.join('；')}`)
  // ② 不得出现未标注的「规模参考 15 分钟」被读成判据层目标：凡「规模参考」句必须带运行层标签
  for (const name of SRC_FILES) {
    const lines = readFileSync(path.join(PLUGIN_ROOT, 'src', name), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('规模参考')) continue
      const window = lines.slice(Math.max(0, i - 1), i + 2).join('\n')
      assert.ok(/(运行层|兜底)/.test(window), `${name}:${i + 1} 「规模参考」缺运行层标签`)
    }
  }
  assert.equal(ta04.ok, true, `TA-04（10/120 归属）：${ta04.detail}`)
})

test('C-Q7-04（AC-Q7-3 反例）：「10 分钟不是完成期限」「120 分钟＝允许慢」零命中（TA-06）' , { skip: SKIP }, () => {
  const ta06 = rule('TA-06')
  assert.equal(ta06.ok, true, `TA-06：${ta06.detail}`)
})
