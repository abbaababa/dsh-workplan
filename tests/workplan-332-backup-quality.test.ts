/*
 * [3.3.2][治本] 盘上结算备份不得覆盖更优的本次回报。
 *
 * 事故（2026-11-26，session-ad9066eb-5ea0-45c7-9e95-4544e734e4b7 /
 * 计划 wp-6cf42e5b-b724-4a5c-b7ad-4ac5411c8b91 / T1）：
 *  - T1 子会话收尾正文交了 execution/verification（含复盘），真正缺口只有验收 A2；
 *  - 它同一次执行写下的盘上备份是「摘要式」的（只有 status/summary/artifacts/
 *    acceptance，没有 phases 与证据块）；
 *  - 旧逻辑对「结算闸退回」也先读备份，读到这份更弱的备份就照单采纳：子会话
 *    拿到与真实缺口无关的「phases 缺失」，台账 summary 被换成备份原文，本可
 *    救回的有界回喂被直接跳过 —— T1 一次即 blocked，T2–T11 全部「上游受阻」。
 *
 * 本文件钉死修复后的契约：
 *  B1 摘要式备份 + 本次回报有真实缺口 → 拒绝采纳备份，回喂真实缺口，补报后 done；
 *  B2 回喂耗尽 → 按本次回报的真实缺口受阻（不是「phases 缺失」），summary 不得变成备份原文；
 *  B3 受阻备份只在带 question（明确请示）时可采纳，且请求原文必须落行；
 *  B4 完整合法备份（含 phases）照旧一次采纳，不回归 3.2.3 的省钱能力。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EVIDENCE_MARKER_BEGIN, EVIDENCE_MARKER_END, adjudicateResult, buildPlanMessage } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'

process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `dsh-332-backup-quality-lessons-${process.pid}.jsonl`,
)

const A1 = '快照最后一条为已收盘交易日'
const A2 = '交易日清单条数与日历核对一致'

function phasesFixture() {
  return {
    planning: {
      problemAnalysis: ['现状：结算闸退回时旧实现先读盘上备份，摘要式备份覆盖了更好的本次回报；约束：缺失永不计 done、诊断不得被更差的证据覆盖；未知：备份可否原地结算；主要矛盾：本地恢复省钱与结算严格性必须同时成立；边界：只动结算恢复路径与提示词约定。'],
      constraints: ['缺失永不计 done', '诊断不得被更差的证据覆盖'],
      unknowns: [],
      approach: ['第 1 步：备份质量不足时拒绝采纳 → 回喂本次回报的真实缺口 → 证明：行状态 done 且回喂文案点名缺口'],
      approachBasis: ['第二轮方法基于第一轮结果：现状与主要矛盾决定先判备份质量再决定是否原地结算，约束决定不改无关文件，验收标准决定每步都要留可复核证据。'],
      resources: ['现有代码库与只读权限：本任务所需源文件、测试与运行环境均已确认可用', '任务数据与验收标准：来自计划行，已核对'],
      tools: ['TypeScript 编译与 node 测试运行器：用于改码后自检', '文件读写与命令执行工具：用于执行与留证'],
    },
    preparation: {
      prepared: ['源文件、测试环境与验收标准均已就位：工作目录可读写，依赖已安装'],
      evidence: ['ls 与 node -v 输出正常；测试运行器可启动'],
    },
    execution: { steps: ['按质量闸拒绝摘要式备份并回喂真实缺口'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [
        { criterion: A1, method: 'node --test', evidence: 'pass 输出' },
        { criterion: A2, method: 'node --test', evidence: 'pass 输出' },
      ],
      requirementCheck: '逐条核对通过',
      retrospective: {
        problems: ['现象：摘要式结算备份覆盖了更优的本次回报，子会话收到「phases 缺失」这种与真实缺口无关的诊断，整条计划级联受阻；根因：恢复路径只判断「备份可解析」，没有判断「备份是否更好」。'],
        detours: [],
        resolutions: ['给备份采纳加质量闸：只有 status=done 或带 question 的受阻备份可原地结算，其余落回消息路径的有界回喂。'],
        prevention: ['遇到恢复路径先比较证据强弱再采纳；任何「本地恢复」都必须给出比现有诊断更强的结论，否则回喂。'],
      },
    },
  }
}

/** 本次回报：只回 A1 一条验收（真实缺口是 A2）。 */
function incompleteOutput() {
  const payload = {
    status: 'done',
    phases: phasesFixture(),
    acceptance: [{ criterion: A1, result: 'pass', evidence: 'data/daily_bars_60d.csv 末行日期核对' }],
    artifacts: [],
    needs: [],
  }
  return `T1 完成。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

/** 补报后：两条验收逐条回应。 */
function compliantOutput() {
  const payload = {
    status: 'done',
    phases: phasesFixture(),
    acceptance: [
      { criterion: A1, result: 'pass', evidence: 'data/daily_bars_60d.csv 末行日期核对' },
      { criterion: A2, result: 'pass', evidence: 'data/trading_days_20261127_20261130.csv 与深交所日历 jybz 逐日比对一致' },
    ],
    artifacts: [],
    needs: [],
  }
  return `补齐 A2 后完成。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

/** 摘要式备份：就是事故现场那种「只有 status/summary/artifacts/acceptance」的备份。 */
function writeSummaryBackup(cwd: string, planId: string) {
  const p = join(cwd, 'reports', `wp-settlement-${planId}-T1.json`)
  writeFileSync(p, JSON.stringify({
    planId,
    subtaskId: 'T1',
    status: 'done',
    settledAtCst: '2026-11-26 23:58:59 +0800',
    summary: '159667 截至2026-11-26收盘快照 0.429 元，三源互证一致。',
    artifacts: [],
    acceptance: [
      { criterion: A1, result: 'pass' },
      { criterion: A2, result: 'pass' },
    ],
  }, null, 2))
  const future = new Date(Date.now() + 60_000)
  utimesSync(p, future, future)
  return p
}

function makePlan() {
  return {
    planId: 'wp-t332-backup-quality',
    title: '备份质量闸验收',
    taskUnderstanding: { originalRequest: '验证备份不得覆盖更好的本次回报', deliverable: '不误判' },
    contradictions: { primary: { statement: '省钱恢复与结算严格性并存' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      goal: '交付',
      rationale: '落盘优先',
      checkpoint: '可核对',
      subtasks: [{
        id: 'T1',
        title: '锁定交易日历与已收盘行情快照',
        department: 'data',
        role: 'engineer',
        objective: '锁定交易日历与已收盘快照并通过两条验收',
        method: ['抓取', '核对'],
        inputs: [],
        outputs: [],
        acceptance: [A1, A2],
        risk: '低',
        dependsOn: [],
      }],
    }],
  }
}

function makeSession(cwd: string) {
  const events: any[] = []
  return {
    id: 'session-t332-backup-quality',
    header: { createdAt: 1000, cwd },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function completed(text: string) {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

function makeRuntime(outputs: string[], cwd: string) {
  const prompts: string[] = []
  const session = makeSession(cwd)
  session.append('user/message', buildPlanMessage(makePlan()))
  seedLeaderSelfEffort(session, makePlan())
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        prompts.push(String(activation?.prompt?.[0]?.text ?? ''))
        const output = outputs.shift() ?? compliantOutput()
        return {
          childId: `child-t332-${prompts.length}`,
          result: Promise.resolve(completed(output)),
          dispose: async () => {},
        }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    childTimeoutMs: 20_000,
    maxResumes: 4,
    autoResume: false,
  })
  return { session, runtime, prompts }
}

function rowOf(out: any, id = 'T1') {
  return (Array.isArray(out?.statuses) ? out.statuses : []).find((item: any) => item.subtaskId === id)
}

async function dispatchOnce(outputs: string[], cwd: string) {
  const harness = makeRuntime(outputs, cwd)
  const result: any = await harness.runtime.dispatchTool(
    { session: harness.session, options: {} },
    { startPhases: MAIN_START_PHASES_FIXTURE },
    new AbortController().signal,
  )
  return { ...harness, result }
}

test('B1：摘要式备份不覆盖本次回报 → 回喂真实缺口（A2），补报后 done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-332-bq-b1-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  const backupPath = writeSummaryBackup(cwd, 'wp-t332-backup-quality')

  const { result, prompts } = await dispatchOnce([incompleteOutput(), compliantOutput()], cwd)
  const row = rowOf(result)

  assert.equal(prompts.length, 2, '摘要式备份不可采纳：必须回喂第二次，而不是一次即 blocked')
  assert.match(prompts[1], /验收项未被逐条回应/, '回喂必须点名真实缺口（验收覆盖），而不是「phases 缺失」')
  assert.match(prompts[1], /日历核对一致/, '回喂必须点名缺哪一条（A2 原文）')
  assert.doesNotMatch(prompts[1], /五步证据不完整/, '真实缺口不得被备份诊断覆盖')
  assert.equal(row?.status, 'done', '补齐 A2 后照常结算 done')
  assert.ok(!String(row?.summary ?? '').includes('三源互证一致'), 'summary 不得被替换成备份原文')
  assert.ok(backupPath.length > 0)
})

test('B2：回喂耗尽 → 按本次回报的真实缺口受阻，不得变成「phases 缺失」', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-332-bq-b2-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  writeSummaryBackup(cwd, 'wp-t332-backup-quality')

  const { result, prompts } = await dispatchOnce([incompleteOutput(), incompleteOutput()], cwd)
  const row = rowOf(result)

  assert.ok(prompts.length <= 2, '有界：最多两次激活')
  assert.equal(row?.status, 'blocked', '缺 A2 不补报 → 按实受阻')
  assert.match(String(row?.error ?? ''), /验收项未被逐条回应/, '受阻原因必须指向真实缺口')
  assert.doesNotMatch(String(row?.error ?? ''), /五步证据不完整/, '不得用备份诊断覆盖本次回报的诊断')
  assert.doesNotMatch(String(row?.summary ?? ''), /"planId"/, 'summary 不得变成一段备份 JSON')
  const errors = Array.isArray(result?.errors) ? result.errors : []
  assert.ok(
    !errors.some((line: string) => /已采纳盘上结算备份/.test(line)),
    '台账不得留下「已采纳」这种把更差证据当结算的痕迹',
  )
})

test('B3：受阻备份带 question → 仍可采纳，请示原文必须落行', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-332-bq-b3-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  const p = join(cwd, 'reports', 'wp-settlement-wp-t332-backup-quality-T1.json')
  writeFileSync(p, JSON.stringify({
    planId: 'wp-t332-backup-quality',
    subtaskId: 'T1',
    status: 'blocked',
    blockedReason: '数据源端点被重置，无法取得历史日K',
    summary: '历史日K主源被封，已按预案切双源，等主 Agent 拍板',
    question: '是否允许改用腾讯+新浪双源承担历史日K？',
    options: ['允许', '不允许'],
    needs: ['历史日K数据源的取舍决定'],
  }))
  const future = new Date(Date.now() + 60_000)
  utimesSync(p, future, future)

  const { result, prompts } = await dispatchOnce(['活干完了，报告如下：一切正常。（忘记附结果块）'], cwd)
  const row = rowOf(result)

  assert.equal(prompts.length, 1, '带请示的受阻备份可原地采纳，不必重开一轮')
  assert.equal(row?.status, 'blocked')
  assert.equal(row?.closure, 'escalated', '带 question 的受阻必须记成「等指示」')
  assert.match(String(row?.question ?? ''), /双源承担历史日K/, '请示原文必须落行')
})

test('B5：结果块少一个 } 被平台归位后，缺口文案如实说「已归位、已读几条」', () => {
  const retrospective = {
    problems: ['现象：结果块少一个 }，acceptance 被吞进 phases；根因：手写 JSON 未核对括号成对。'],
    detours: [],
    resolutions: ['改为先把 acceptance 写在顶层再写 phases，并用 JSON 校验器自检后提交。'],
    prevention: ['遇到手写长 JSON 先用校验器跑一遍再发；每条验收都按编号逐条回应，不重写整块。'],
  }
  const nested = {
    status: 'done',
    phases: {
      execution: { steps: ['按蓝图执行'], deviations: [] },
      verification: { retrospective },
      acceptance: [
        { criterion: A1, result: 'pass', evidence: 'A1 证据' },
        { criterion: A2, result: 'unverified', evidence: 'A3 证据（错位）' },
      ],
    },
  }
  const balanced = `${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(nested)}\n${EVIDENCE_MARKER_END}`
  const repaired = `${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(nested).slice(0, -1)}\n${EVIDENCE_MARKER_END}`

  for (const [label, output] of [['层级错位（JSON 合法）', balanced], ['少一个 }（已自动闭合）', repaired]] as const) {
    const verdict = adjudicateResult({ output, expectedAcceptance: [A1, A2, '第三项验收'] })
    assert.equal(verdict.status, 'blocked', `${label}：验收没逐条回应，必须受阻`)
    const text = String(verdict.error ?? '')
    assert.match(text, /自动归位到顶层/, `${label}：必须说清已把字段归位`)
    assert.match(text, /已读到 2 条验收/, `${label}：必须报告已读到的验收条数`)
    assert.doesNotMatch(text, /会被一起裁掉/, `${label}：归位成功就不得再暗示证据被裁`)
  }
})

test('B6：提示词明确要求「原样同一 JSON」的结算备份', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-332-bq-b6-'))
  const { prompts } = await dispatchOnce([compliantOutput()], cwd)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /原样另存/, '备份写法必须写明「原样」')
  assert.match(prompts[0], /摘要式备份平台不会采纳/, '必须写明摘要式备份不会被采纳')
  assert.match(prompts[0], /含 phases\/acceptance\/artifacts\/departmentSummary/, '必须逐项点明不得缺的字段')
})

test('B4：完整合法备份（含 phases）照旧一次采纳，不回归省钱能力', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-332-bq-b4-'))
  mkdirSync(join(cwd, 'reports'), { recursive: true })
  const p = join(cwd, 'reports', 'wp-settlement-wp-t332-backup-quality-T1.json')
  writeFileSync(p, `${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify({
    planId: 'wp-t332-backup-quality',
    subtaskId: 'T1',
    status: 'done',
    phases: phasesFixture(),
    acceptance: [
      { criterion: A1, result: 'pass', evidence: '备份内的逐条证据 A1' },
      { criterion: A2, result: 'pass', evidence: '备份内的逐条证据 A2' },
    ],
    artifacts: [],
    needs: [],
  })}\n${EVIDENCE_MARKER_END}`)
  const future = new Date(Date.now() + 60_000)
  utimesSync(p, future, future)

  const { result, prompts } = await dispatchOnce(['活干完了，报告如下：一切正常。（忘记附结果块）'], cwd)
  const row = rowOf(result)

  assert.equal(prompts.length, 1, '完整合法备份必须一次采纳，不得白起一轮')
  assert.equal(row?.status, 'done')
})
