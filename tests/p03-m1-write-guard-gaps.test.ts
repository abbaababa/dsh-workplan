/*
 * [P0-3 M1] 已交付文件写保护的缺口固定（不改 src，只补回归用例）。
 *
 * 背景：写保护本身已存在（src/host.ts 的 fileWriteGuardReason 只接管
 * write / edit / str_replace_editor；src/runtime.ts 的
 * presentedWriteDenialReason 决定拦不拦）。P0-3 要补的是「覆盖不到的
 * 缺口」，T2 把现有写保护拆成三个缺口：
 *
 *   G1 只对根会话生效：presentedWriteDenialReason 第一行
 *      `if (!session || !isRootSession(session)) return undefined`，
 *      子会话（事故 session-99984ebd 里真正动手的就是后台子 Agent）改写
 *      已交付文件不被拦。真修复会改变既有契约
 *      （tests/workplan-presented-write-guard.test.ts 第 184 行「非根会话放行」），
 *      属于产品决策，归 M3，不在 M1。
 *   G2 只识别三种写工具名：write / edit / str_replace_editor。
 *      可利用性尚未验证，扩范围可能误伤正常写入，归 M2。
 *   G3 不解析符号链接：canonicalPath 只做 path.resolve，src 里 realpath
 *      出现 0 次，因此「经符号链接指向同一个已交付文件」的写法被放行。
 *      这是已确认缺口；真修复（canonicalPath 加 realpath）会改源码行为，
 *      需要单独评审。
 *
 * M1 = 零风险：只新增本文件，一行 src 都不动；每个断言都先用本文件内
 * 自造的临时目录跑出真实结果，再钉住。G3 的断言刻意写成
 * 「与基准路径行为一致」而不是写死「放行」——
 *   - 缺口还在时：基准=绝对路径=被拦，符号链接=放行 ⇒ 不一致 ⇒ 用例红，
 *     缺口不声不响地消失会被发现；
 *   - 修好以后：两者都=被拦 ⇒ 一致 ⇒ 用例转绿，从「记录缺口」变成
 *     「守住修复」，不需要改测试。
 *
 * 为什么走 fileWriteGuardReason 而不是只调 runtime：G2 的缺口在
 * host.ts 的工具名分流上，只测 runtime 就测不到「第四个写工具名根本
 * 进不了闸门」这件事。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlanMessage, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { fileWriteGuardReason } from '../src/host.js'

const SESSION_ID = 'session-p03-m1'

function makePlan(planId = 'wp-p03-m1', sessionId = SESSION_ID) {
  return {
    planId,
    sessionId,
    createdTurn: 1,
    createdAt: 1000,
    title: 'P0-3 M1 缺口固定',
    contradictions: { primary: { statement: '交付后不得原地改写' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
      ],
    }],
  }
}

/** 只完成第一步的计划：未通过交付就绪检查，写保护应当生效。 */
function makeRecord(plan: any): any {
  const statuses: any[] = createStatuses(plan)
  statuses[0].status = 'done'
  statuses[0].verification = 'structured'
  statuses[0].acceptance = [{ criterion: '第一步验收', result: 'pass', evidence: '测试通过' }]
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'paused',
    statuses,
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: true,
  }
}

function makeSession(cwd: string, header: any = {}) {
  const events: any[] = []
  return {
    id: SESSION_ID,
    header: { createdAt: 1000, cwd, ...header },
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

function makeRuntime(record: any, session: any, cwd: string) {
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, cwd })
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

function agentFor(session: any) {
  return { session }
}

/** 造一个真目录 + 一个真符号链接，返回它们的绝对路径。 */
function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p03-m1-')))
  const realDir = join(root, 'real')
  mkdirSync(realDir)
  const reportPath = join(realDir, 'report.md')
  writeFileSync(reportPath, '# 交付报告\n')
  const linkDir = join(root, 'link')
  symlinkSync(realDir, linkDir)
  const linkPath = join(linkDir, 'report.md')
  return {
    root,
    linkDir,
    realDir,
    reportPath,
    linkPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 一份「已 present、计划尚未就绪」的运行环境。 */
function guardedRuntime(cwd: string, presentedPath: string, header: any = {}) {
  const plan = makePlan()
  const session = makeSession(cwd, header)
  session.append('user/message', buildPlanMessage(plan, { totalBudgetMinutes: 20 }))
  session.append('deliverables/presented', {
    turn: 1,
    callId: 'call_present_1',
    files: [{ path: presentedPath, description: '交付报告' }],
  })
  return { plan, session, runtime: makeRuntime(makeRecord(plan), session, cwd) }
}

// ---------------------------------------------------------------------------
// 基准：绝对路径确实被拦。没有这条，下面的「不一致」就没有参照。
// ---------------------------------------------------------------------------
test('M1 基准：绝对路径改写已交付文件被拦', () => {
  const fx = makeFixture()
  try {
    const { session, runtime } = guardedRuntime(fx.root, fx.reportPath)
    const reason = runtime.presentedWriteDenialReason(agentFor(session), { file_path: fx.reportPath })
    assert.equal(typeof reason, 'string')
    assert.match(reason, /wp-p03-m1/)
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 路径写法归一：相对路径、带 .. 的路径都归一到同一个文件，照样被拦。
// ---------------------------------------------------------------------------
test('M1 其它三种写法（绝对 / ./相对 / sub/../）都被拦', () => {
  const fx = makeFixture()
  try {
    const { session, runtime } = guardedRuntime(fx.realDir, 'report.md')
    const forms = [
      fx.reportPath,
      './report.md',
      'sub/../report.md',
    ]
    for (const form of forms) {
      assert.equal(
        typeof runtime.presentedWriteDenialReason(agentFor(session), { file_path: form }),
        'string',
        `应当被拦：${form}`,
      )
    }
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// G3：符号链接指向同一个文件，行为必须与绝对路径一致。
// 现在不一致（缺口仍在）⇒ 断言「一致」必然红，而红之后紧跟的断言把
// 现状也钉住，这样「缺口被悄悄修好」和「缺口被悄悄扩大」都会被发现。
// ---------------------------------------------------------------------------
test('M1 G3：符号链接路径与基准路径行为一致（1.12.2 已修复：两者都被拦）', () => {
  const fx = makeFixture()
  try {
    const { session, runtime } = guardedRuntime(fx.root, fx.reportPath)
    const viaReal = runtime.presentedWriteDenialReason(agentFor(session), { file_path: fx.reportPath })
    const viaLink = runtime.presentedWriteDenialReason(agentFor(session), { file_path: fx.linkPath })

    // 1.12.2 修复后：基准被拦，经符号链接同样被拦，且报的是同一个计划。
    assert.equal(typeof viaReal, 'string', '基准（无符号链接）必须被拦')
    assert.equal(typeof viaLink, 'string', 'G3 已修复：经符号链接的路径必须同样被拦')
    assert.match(viaLink as string, /wp-p03-m1/)
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// G3 反向保护：交付的是链接路径、改写的是真实路径，同样要被认出来；
// 以及不同文件不能被误判成同一个（否则就是过度拦截）。
// ---------------------------------------------------------------------------
test('G3 反向：交付链接路径、改写真实路径同样被拦；不同文件不被误伤', () => {
  const fx = makeFixture()
  try {
    // 反向：present 的是链接路径，改写走真实路径。
    // 注意 cwd 必须取「未解析符号链接」的根：按现行约定，cwd 本身若已是
    // realpath，present 的链接路径会被 canonicalPath 的字符串前缀规则判成
    // 相对路径（/work/link/report.md 不以 /real 开头），那是另一处已知的
    // 相对路径残缺，不属于 G3（G3 只处理「绝对路径 + 符号链接」）。
    const reverse = guardedRuntime(fx.linkDir, fx.linkPath)
    const reverseReason = reverse.runtime.presentedWriteDenialReason(
      agentFor(reverse.session),
      { file_path: fx.reportPath },
    )
    assert.equal(typeof reverseReason, 'string', 'G3：present 链接路径、写真实路径，必须被拦')

    // 误伤保护：同目录下另一个文件不是交付物，必须放行。
    writeFileSync(join(fx.realDir, 'other.md'), '# 未交付\n')
    const other = guardedRuntime(fx.root, fx.reportPath)
    assert.equal(
      other.runtime.presentedWriteDenialReason(agentFor(other.session), { file_path: join(fx.realDir, 'other.md') }),
      undefined,
      'G3：不同文件不得被误判为同一个',
    )
  } finally {
    fx.cleanup()
  }
})
