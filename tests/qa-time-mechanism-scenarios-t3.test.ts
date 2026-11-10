/*
 * [2.3.0][T3·质量验证] 专家执行时间机制——场景级独立验证（QA 视角，不复用 T1 断言，独立取证）
 *
 * 对应子任务 T3 验收标准：
 *  A1 场景 A/B/C/D 全部通过：
 *   - 场景A（预估上报→告知用户）：通知文本含预估分钟数与「告知用户」义务，
 *     且 timeNotice 进入模型可读面（主 Agent 告知用户前可读到）；
 *   - 场景B（超时→放宽→告知专家）：放宽计算正确（新时限 = 原时限 + extendMs，
 *     与时钟同源精确断言）；投递给专家的【延期告知】含最新执行时间 ISO 原文与
 *     「必须在保证工作质量的前提下高效率执行」措辞；timeJournal 留痕 extend +
 *     notify-expert；第一次到点的主会话通知要求主 Agent 立即放宽（用户要求1）；
 *   - 场景C（二次超时→主 Agent 接手＋已完成部分不丢）：takeoverRequired=true；
 *     已完成产物文件的 sha256 在接手前/后一致（禁止丢弃的磁盘级证据）；
 *     接手后主 Agent 再写 artifacts 也不可能删掉保护条目（只增不减）；
 *     仅未完成部分（remainingOutputs）进入主 Agent 接手清单；
 *   - 场景D（回归：不超时正常完成）：结算走既有路径，timeoutCount=0、
 *     无 takeoverRequired、无【延期告知】/【接手】通知、专家零打扰。
 *  A2 场景C已完成产物哈希与接手前一致（磁盘级断言）。
 *  A3 无新增静态检查失败（由 npm run check + 全量套件承担，见测试报告）。
 *
 * 计时口径与既有测试同构：小窗口 childTimeoutMs + 轮询，不用真实长睡眠。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlanMessage, parseResultMessage } from '../src/plan.js'
import {
  createWorkplanRuntime,
  modelStatusLines,
  TAKEOVER_AFTER_TIMEOUTS,
} from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
const workRoot = mkdtempSync(join(tmpdir(), 'wp-qa-t3-'))
after(() => rmSync(workRoot, { recursive: true, force: true }))

function makePlanMessage(planId: string, outputs: string[]) {
  return buildPlanMessage({
    planId,
    sessionId: `session-${planId}`,
    createdTurn: 1,
    createdAt: 1000,
    title: 'QA 场景验证',
    taskUnderstanding: { originalRequest: '验证 2.3.0 时间机制四场景', deliverable: '场景验证报告' },
    contradictions: { primary: { statement: '超时处理需在放宽与接手之间有序升级' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '长任务',
        department: 'engineering',
        objective: '四场景机制验证',
        method: ['执行'],
        inputs: [],
        outputs,
        acceptance: ['产出报告'],
        risk: '超时',
        dependsOn: [],
      }],
    }],
  })
}

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => { release = resolve })
  return { promise, release }
}

function makeRuntime(planId: string, outputs: string[], options: any = {}) {
  const session: any = {
    id: `session-${planId}`,
    header: { createdAt: 1000, cwd: workRoot },
    events: [] as any[],
    get seq() { return this.events.length },
    append(type: string, data: any) {
      this.events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => session.events[seq],
  }
  session.append('user/message', makePlanMessage(planId, outputs))
  const gate = deferred()
  const sent: any[] = []
  let started = false
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => {
        started = true
        return { childId: `child-${planId}`, result: gate.promise, dispose: async () => {} }
      },
      sendMessage: async (_agent: any, childId: string, parts: any[]) => {
        sent.push({ childId, text: String(parts?.[0]?.text ?? '') })
        return 'msg-qa'
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

async function waitFor(check: () => boolean, timeoutMs = 20_000) {
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

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/* ============================ 场景 A ============================ */

test('场景A：预估上报后通知含预估分钟与「告知用户」义务，且 timeNotice 进入模型可读面', async () => {
  // 现实时序（与用户要求 1 一致）：主 Agent 先分配工作（dispatch），执行中的
  // 专家才上报预估。派发前无活跃 record，timeNotice 属契约外输入（QA 记录为
  // 观察项 D-T3-1，非 2.3.0 回归：2.2.0 O-2a 起行为相同），本用例走真实时序。
  const { session, runtime, gate, hasStarted } = makeRuntime('wp-qa-a', ['T1_report.md'], { childTimeoutMs: 30_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  const res: any = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    timeNotice: { declaredMinutes: 22, reason: 'QA 场景A：含实现与回归' },
  })
  assert.equal(res?.ok, true, 'timeNotice 事务应放行')
  const notice = messageTexts(session).find((text: string) => text.includes('专家预估上报'))
  assert.ok(notice, '主会话应出现【专家预估上报】即时通知')
  assert.match(notice!, /22 分钟/, '通知含专家上报的预估分钟数（22）')
  assert.match(notice!, /请把此预期执行时间告知用户/, '通知要求主 Agent 把预估时间告知用户（用户要求 1 前半段）')
  assert.match(notice!, /放宽|接手/, '通知同时提示超时/接手后续义务，让主 Agent 有准备')
  // 模型可读面：主 Agent 在通知之外也要能从状态行读到预估（防止通知被忽略）。
  const row = await rowOf(runtime, session)
  assert.equal(Number(row?.timeNotice?.declaredMinutes), 22, 'statusTool 行应携带 timeNotice（真实时序）')
  const readable: any = modelStatusLines([row])[0]
  assert.equal(Number(readable?.timeNotice?.declaredMinutes), 22, 'timeNotice 已透出到模型可读面（T1 修复点复验）')
  const journal = (readable?.timeJournal ?? []).map((item: any) => item.action)
  assert.ok(journal.includes('estimate'), 'timeJournal 留痕 estimate（审计链）')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
})

/* ============================ 场景 B ============================ */

test('场景B：放宽时限计算 = 原时限 + extendMs（精确）；【延期告知】含最新时限与质量效率措辞', async () => {
  const { session, runtime, gate, sent, hasStarted } = makeRuntime('wp-qa-b', ['T1_report.md'], { childTimeoutMs: 30_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  const before = await rowOf(runtime, session)
  const deadline0 = Number(before?.deadlineAt)
  assert.ok(Number.isFinite(deadline0) && deadline0 > 0, '运行中状态行应有协商截止 deadlineAt')
  const res: any = await runtime.updateStatus({ session }, { subtaskId: 'T1', extendMs: 5_000, reason: 'QA 场景B：第 1 次超时预警前放宽' })
  assert.equal(res?.ok, true, 'extendMs 放宽应放行')
  assert.equal(res?.childNotified, true, '延期回执带 childNotified=true（插件已告知专家）')
  const after = await rowOf(runtime, session)
  // 放宽计算正确性：handle.extend 语义为 deadlineAt += extendMs（原时限平移）。
  assert.equal(Number(after?.deadlineAt), deadline0 + 5_000, '新时限必须精确 = 原时限 + extendMs')
  assert.ok(await waitFor(() => sent.length >= 1, 5_000), '告知应经 subagent 服务投递')
  const text = sent[0].text
  assert.equal(sent[0].childId, 'child-wp-qa-b', '投递目标是该专家子会话，不串台')
  assert.match(text, /延期告知/, '抬头【dsh-workplan·延期告知】')
  assert.ok(text.includes(new Date(Number(after?.deadlineAt)).toISOString()), '通知含最新执行时间（与时限字段同一 ISO 原文）')
  assert.match(text, /必须在保证工作质量的前提下高效率执行/, '含「保证质量、高效率执行」硬要求（用户要求 1）')
  assert.match(text, /不要重新开始/, '明确继续当前工作，防止专家重做')
  const journal = (after?.timeJournal ?? []).map((item: any) => item.action)
  assert.ok(journal.includes('extend'), 'timeJournal 留痕 extend')
  assert.ok(journal.includes('notify-expert'), 'timeJournal 留痕 notify-expert')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
})

test('场景B：第一次到点的中断通知要求主 Agent 立即放宽并告知专家（用户要求 1 的主 Agent 侧）', async () => {
  const { session, runtime, gate, hasStarted } = makeRuntime('wp-qa-b2', ['T1_report.md'], { childTimeoutMs: 400, totalTimeoutMs: 400_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  // 第一次到点：主会话出现含「放宽」指引的执行中断通知（文本判据，无竞态；
  // 接手文案含「takeoverRequired」，第一次文案必须没有——按发生顺序锁定第 1 条）。
  const got1 = await waitFor(() => messageTexts(session).some((text: string) =>
    text.includes('执行中断') && text.includes('放宽')), 20_000)
  assert.ok(got1, '主会话应收到要求放宽的第一次超时通知')
  const row = await rowOf(runtime, session)
  assert.ok(Number(row?.timeoutCount ?? 0) >= 1, `第一次到点应 timeoutCount+1，实际 ${row?.timeoutCount}`)
  const firstNotice = messageTexts(session).filter((text: string) => text.includes('执行中断'))[0]
  assert.match(firstNotice, /第 1 次达到协商时限/, '第一次超时的文案点名「第 1 次」')
  assert.match(firstNotice, /extendMs/, '通知点名放宽工具 extendMs（用户要求 1「必须继续放宽」）')
  // 语义两段断言（实现原文：「会自动把最新时限与「保证质量、高效率执行」要求
  // 告知专家」——词序与旧正则不同但语义等价；QA 断言按语义拆两段，防止把
  // 措辞演进误报为缺陷）。
  assert.match(firstNotice, /最新时限/, '通知说明放宽后会传达最新时限')
  assert.match(firstNotice, /告知专家/, '通知说明告知对象是执行中的专家（让专家有准备）')
  assert.doesNotMatch(firstNotice, /takeoverRequired/, '第一次超时不得出现接手语义（只有第 2 次才接手）')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] })
})

/* ============================ 场景 C（含 A2 哈希） ============================ */

test('场景C：二次超时接手——产物 sha256 接手前后一致（A2）；保护清单只增不减；仅未完成部分进接手清单', async () => {
  const artifact = join(workRoot, 'T1_report.md')
  const earlyWork = '# 专家已完成部分\n' + 'done-steps: A/B/C 三条链路已落地\n'
  writeFileSync(artifact, earlyWork)
  const hashBefore = sha256(artifact)
  const { session, runtime, gate, hasStarted } = makeRuntime('wp-qa-c', ['T1_report.md', 'T1_tests.md'], { childTimeoutMs: 900, totalTimeoutMs: 400_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  let row: any = null
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    row = await rowOf(runtime, session)
    if (row?.takeoverRequired === true) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(row?.takeoverRequired, true, '第二次到点应置 takeoverRequired=true')
  assert.ok(Number(row?.timeoutCount) >= TAKEOVER_AFTER_TIMEOUTS, `timeoutCount 应 ≥2，实际 ${row?.timeoutCount}`)
  // A2：磁盘级证据——接手机制运行前后，已完成产物文件内容哈希一致（未被删除/覆盖）。
  const hashAfter = sha256(artifact)
  assert.equal(hashAfter, hashBefore, '【A2】已完成产物文件 sha256 接手前后必须一致')
  // 接手清单：只含未完成部分。
  const brief = row?.takeoverBrief
  assert.ok(brief, 'takeoverBrief 已生成')
  assert.ok((brief?.landedRefs ?? []).includes('T1_report.md'), '已完成产物登记进 landedRefs')
  assert.deepEqual(brief?.remainingOutputs, ['T1_tests.md'], '仅未完成部分进入主 Agent 接手清单')
  assert.match(String(brief?.instruction ?? ''), /禁止丢弃|禁止删除或覆盖/, '接手指令硬编码只读保护')
  assert.match(String(row?.error ?? ''), /主 Agent/, '结算文案点名主 Agent 接手（用户要求 2）')
  // 模型可读面必须把接手包与保护清单透出（T1 修复点：artifacts 透出）。
  const readable: any = modelStatusLines([row])[0]
  assert.equal(readable?.takeoverRequired, true, 'takeoverRequired 进入模型可读面')
  assert.ok((readable?.artifacts ?? []).some((item: any) => item?.ref === 'T1_report.md'), '保护产物清单进入模型可读面')
  // 接手后主 Agent 再写 artifacts（只补充新证据）也不可能删掉保护条目（只增不减）。
  await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    status: 'in_progress',
    force: true,
    artifacts: [{ kind: 'file', ref: 'QA_main.md', exists: true }],
  })
  const row2 = await rowOf(runtime, session)
  const refs = (row2?.artifacts ?? []).map((item: any) => item?.ref)
  assert.ok(refs.includes('T1_report.md'), '接手后写入不得丢弃已完成产物登记')
  assert.ok(refs.includes('QA_main.md'), '主 Agent 的新证据正常并入')
  assert.equal(sha256(artifact), hashBefore, '写状态后磁盘产物依旧未被触碰')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] })
})

/* ============================ 场景 D（回归） ============================ */

test('场景D：不超时正常完成——既有结算路径零变化，无接手/放宽/预估通知、专家零打扰', async () => {
  const { session, runtime, gate, sent, hasStarted } = makeRuntime('wp-qa-d', ['T1_report.md'], { childTimeoutMs: 30_000 })
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)
  assert.ok(await waitFor(hasStarted, 5_000), 'T1 应已派发')
  const running = await rowOf(runtime, session)
  assert.match(String(running?.status ?? ''), /in_progress|running/, '运行中状态行应为执行中')
  gate.release({ stopReason: 'completed', output: [{ type: 'text', text: '正常完成' }] })
  // 正常收束：本轮应像 2.2.x 一样产生可解析的结算结果消息（既有路径不受影响）。
  assert.ok(await waitFor(() => session.events.some((event: any) =>
    event.type === 'user/message' && parseResultMessage(event.data)), 10_000), '既有结算路径应正常产生结果消息')
  const row = await rowOf(runtime, session)
  assert.equal(Number(row?.timeoutCount ?? 0), 0, '未超时：timeoutCount 必须为 0')
  assert.notEqual(row?.takeoverRequired, true, '未超时：不得出现 takeoverRequired')
  assert.notEqual(row?.pendingAdjudication, true, '未超时：不得出现待裁决标记')
  const allText = messageTexts(session).join('\n')
  assert.doesNotMatch(allText, /延期告知|执行中断|专家预估上报/, '无超时/无预告时，不得产生任何新机制通知（回归零打扰）')
  assert.equal(sent.length, 0, '未超时时插件不得向专家投递任何消息')
  assert.ok(!(row?.timeJournal ?? []).some((item: any) => item.action === 'timeout' || item.action === 'notify-expert'),
    'timeJournal 不得有 timeout/notify-expert 留痕')
})
