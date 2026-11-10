/*
 * [2.3.0][T1] 专家执行时间机制验收 —— 用户 2026-11-10 四项要求（要求 1/2 的
 * 插件侧闭环），对应子任务验收标准 A1/A2/A3/A4（A5=静态检查由 tsc 承担）。
 *
 * 断言点：
 *  - A1 预估上报→告知用户：dsh_workplan_update(timeNotice) 落档后，主会话出现
 *    含「专家预估上报」「告知用户」的即时通知（用户要求 1 前半段）；
 *  - A2 超时放宽→告知专家：extendMs 延期成功后，插件经 subagent 服务把「最新
 *    执行时间」与「必须在保证工作质量的前提下高效率执行」投递给执行中的专家，
 *    回执 childNotified=true，timeJournal 记 notify-expert（用户要求 1 后半段）；
 *  - A3 二次超时接手：同一子任务第 2 次达到协商时限后 takeoverRequired=true，
 *    结算文案与状态行含「主 Agent 接手」，且 resetBlockedStatuses 跳过该行
 *    （不再重派专家从零重做）；
 *  - A4 已完成部分只读保护：takeoverBrief.landedRefs 登记专家已落盘产物并并入
 *    行 artifacts（只增不减）；mergePreservedArtifacts/buildTakeoverBrief 纯
 *    函数回归，任何后续写入都不能删除保护条目。
 *
 * 计时口径：与既有时间测试同构——小窗口 childTimeoutMs + 10ms 轮询，不用真实
 * 长睡眠。假 ctx 的 subagents 同时提供 startActivation 与 sendMessage 探针。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlanMessage } from '../src/plan.js'
import { resetBlockedStatuses } from '../src/plan.js'
import {
  createWorkplanRuntime,
  buildTakeoverBrief,
  mergePreservedArtifacts,
  TAKEOVER_AFTER_TIMEOUTS,
} from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
const workRoot = mkdtempSync(join(tmpdir(), 'wp-time-230-'))
after(() => rmSync(workRoot, { recursive: true, force: true }))

function makePlanMessage(subtaskExtra: any = {}) {
  return buildPlanMessage({
    planId: 'wp-time-230',
    sessionId: 'session-time-230',
    createdTurn: 1,
    createdAt: 1000,
    title: '专家时间机制验收',
    taskUnderstanding: { originalRequest: '验证 2.3.0 时间机制', deliverable: '机制回归' },
    contradictions: { primary: { statement: '超时处理需要在放宽与接手之间有序升级' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '长任务',
        department: 'engineering',
        objective: '验证时间机制',
        method: ['执行'],
        inputs: [],
        outputs: ['T1_report.md'],
        acceptance: ['产出报告'],
        risk: '超时',
        dependsOn: [],
        ...subtaskExtra,
      }],
    }],
  })
}

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => { release = resolve })
  return { promise, release }
}

function makeRuntime(options: any = {}) {
  const session: any = {
    id: 'session-time-230',
    header: { createdAt: 1000, cwd: workRoot },
    events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) {
      this.events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', makePlanMessage())
  const gate = deferred()
  const sent: any[] = []
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        started = true
        return { childId: 'child-230', result: gate.promise, dispose: async () => {} }
      },
      sendMessage: async (_agent: any, childId: string, parts: any[]) => {
        sent.push({ childId, text: String(parts?.[0]?.text ?? '') })
        return 'msg-1'
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx as any, {
    totalTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    strictEvidence: false,
    ...options,
  })
  return { session, runtime, gate, sent, hasStarted: () => started }
}

async function waitFor(check: () => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function rowOf(runtime: any, session: any) {
  const snapshot: any = await runtime.statusTool({ session }, {})
  return (snapshot?.statuses ?? []).find((item: any) => item.subtaskId === 'T1')
}

function messageTexts(session: any) {
  return session.events
    .filter((event: any) => event.type === 'user/message')
    .map((event: any) => String(event.data?.content?.[0]?.text ?? event.data?.text ?? ''))
}

test('A1 预估上报→告知用户：timeNotice 落档后主会话出现「专家预估上报/告知用户」即时通知', async () => {
  const { session, runtime } = makeRuntime()
  const res: any = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    timeNotice: { declaredMinutes: 18, reason: '含实现与回归，预计 18 分钟' },
  })
  assert.equal(res?.ok, true, 'timeNotice 纯时限事务应放行')
  assert.equal(Number(res?.timeNotice?.declaredMinutes), 18, '状态行 timeNotice 已落档（回执回显）')
  const notice = messageTexts(session).find((text: string) => text.includes('专家预估上报'))
  assert.ok(notice, '待验证（A1）：主会话应出现【专家预估上报】通知')
  assert.match(notice!, /18/, '通知含预估分钟数')
  assert.match(notice!, /告知用户/, '通知明确要求主 Agent 把预期执行时间告知用户（用户要求 1）')
})

test('A2 放宽→告知专家：延期成功后插件把最新执行时限与「保证质量、高效率执行」投递给专家，childNotified=true', async () => {
  const { session, runtime, gate, sent, hasStarted } = makeRuntime({ childTimeoutMs: 3_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  const res: any = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 2_000, reason: '第 1 次超时预警，按机制放宽' })
  assert.equal(res?.ok, true, '运行中 extendMs 放宽应放行')
  assert.equal(res?.childNotified, true, '待验证（A2）：延期回执应带 childNotified=true')
  assert.ok(await waitFor(() => sent.length >= 1, 5_000), '延期告知应经 subagent 服务投递')
  const noticeText = sent[0].text
  assert.equal(sent[0].childId, 'child-230', '告知目标是执行中的专家子会话')
  assert.match(noticeText, /延期告知/, '通知抬头')
  assert.match(noticeText, /最新执行时间/, '含最新执行时限（用户要求 1「告知此专家最新执行时间」）')
  assert.match(noticeText, /必须在保证工作质量的前提下高效率执行/, '含「保证质量、高效率执行」硬要求（用户要求 1）')
  const row = await rowOf(runtime, session)
  assert.ok((row?.timeJournal ?? []).some((item: any) => item.action === 'notify-expert'), 'timeJournal 留档 notify-expert')
  assert.equal(Number(row?.deadlineAt) > 0, true, 'deadlineAt 已推移')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
})

test('A3+A4 二次超时接手：第 2 次到点 takeoverRequired=true、已完成产物只读登记并跳过续跑重派', async () => {
  writeFileSync(join(workRoot, 'T1_report.md'), '# 专家已完成部分\n')
  const { session, runtime, gate, hasStarted } = makeRuntime({ childTimeoutMs: 1_000, totalTimeoutMs: 400_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  // 两次协商上限先后到点（首次 + 自动重试第二次），每次 fire() 给行 timeoutCount+1。
  let row: any = null
  const end = Date.now() + 25_000
  while (Date.now() < end) {
    row = await rowOf(runtime, session)
    if (row?.takeoverRequired === true) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(row?.takeoverRequired, true, '待验证（A3）：第二次超时应置 takeoverRequired=true')
  assert.ok(Number(row?.timeoutCount) >= TAKEOVER_AFTER_TIMEOUTS, `timeoutCount 应 ≥2，实际 ${row?.timeoutCount}`)
  assert.match(String(row?.error ?? ''), /主 Agent 接手|主 Agent 直接接手/, '结算文案要求主 Agent 接手（用户要求 2）')
  assert.match(String(row?.error ?? ''), /禁止丢弃/, '结算文案含「禁止丢弃」保护（用户要求 2）')
  // A4：已落盘产物进入保护登记并并入 artifacts（只增不减）。
  const brief = row?.takeoverBrief
  assert.ok(brief, 'takeoverBrief 应已生成')
  assert.ok((brief?.landedRefs ?? []).includes('T1_report.md'), '专家已落盘产物登记进 landedRefs 只读保护')
  assert.ok((row?.artifacts ?? []).some((item: any) => item?.ref === 'T1_report.md'), '保护产物并入行 artifacts')
  // 二次超时行不再被续跑重派（resetBlockedStatuses 跳过 takeoverRequired）。
  const afterReset = resetBlockedStatuses([row])
  const kept = afterReset.find((item: any) => item.subtaskId === 'T1')
  assert.notEqual(kept?.status, 'pending', 'takeoverRequired 行不得被重置为 pending 重派专家')
  assert.equal(kept?.takeoverRequired, true, '跳过重派时保护登记原样保留')
  const takeoverNotice = messageTexts(session).find((text: string) => text.includes('执行中断') && text.includes('接手'))
  assert.ok(takeoverNotice, '主会话应收到二次超时接手的即时通知')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] })
})

test('A4 纯函数回归：buildTakeoverBrief 反推未完成清单；mergePreservedArtifacts 只增不减（禁止丢弃已完成部分）', () => {
  const brief = buildTakeoverBrief(
    { outputs: ['T1_report.md', 'T1_tests.md'], acceptance: ['A1'] },
    { artifacts: [{ kind: 'file', ref: 'T1_report.md', exists: true }, { kind: 'note', ref: 'x' }] },
    ['T1_report.md'],
    2,
  )
  assert.deepEqual(brief.landedRefs, ['T1_report.md'], '已落盘清单照录')
  assert.deepEqual(brief.remainingOutputs, ['T1_tests.md'], '未完成 = outputs 去掉已落盘（接手只继续缺口）')
  assert.match(brief.instruction, /禁止丢弃/, 'instruction 硬编码「禁止丢弃已完成部分」')
  const merged = mergePreservedArtifacts([{ kind: 'file', ref: 'new.md', exists: true }], ['protected.md', 'protected.md'])
  assert.ok(merged.some((item: any) => item.ref === 'new.md'), '新写入保留（不破坏主 Agent 正常补证据）')
  const preserved = merged.filter((item: any) => item.ref === 'protected.md')
  assert.equal(preserved.length, 1, '保护条目去重并入')
  assert.equal(preserved[0].exists, true, '保护条目固定存在语义（登记发生在确认在盘时刻）')
  assert.deepEqual(
    mergePreservedArtifacts([], []),
    [],
    'mergePreservedArtifacts 输出必须始终包含全部输入条目（只增不减）——见下方显式断言',
  )
  const before = [{ kind: 'file', ref: 'a.md', exists: true }]
  const after = mergePreservedArtifacts(before, ['b.md'])
  assert.ok(after.length >= before.length && before.every((item: any) => after.some((x: any) => x.ref === item.ref)),
    '任何合并都不得删除既有条目：禁止丢弃已完成部分的代码级保证')
})
