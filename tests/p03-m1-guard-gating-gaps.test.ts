/*
 * [P0-3 M1] G1 / G2 缺口的回归固定（只新增用例，不改 src）。
 *
 * G1：presentedWriteDenialReason 对非根会话直接放行。
 *     tests/workplan-presented-write-guard.test.ts:184 已经把这个行为当成
 *     契约钉住了，所以「改掉它」属于产品决策（M3），不在 M1。M1 只做一件事：
 *     把「子会话改写已交付文件不拦」这个事实单独钉成一个用例，让将来谁改
 *     isRootSession 分支时，一眼能看到这条要一并更新。
 *
 * G2：fileWriteGuardReason 只接管 write / edit / str_replace_editor。
 *     第四个写类工具名（例如 apply_patch 这种批量改文件的写法）根本不进闸门。
 *     可利用性尚未在仓库里验证，扩范围可能误伤正常写入（M2）。
 *     M1 把「不进闸门」钉住，并用 read / present / dispatch 作为对照，
 *     证明这不是闸门整体失灵，而只是工具名清单没覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { fileWriteGuardReason } from '../src/host.js'

const WORKSPACE = '/work'
const REPORT = `${WORKSPACE}/report.md`
const SESSION_ID = 'session-p03-m1-gating'

function makePlan() {
  return {
    planId: 'wp-p03-m1-gating',
    sessionId: SESSION_ID,
    createdTurn: 1,
    createdAt: 1000,
    title: 'P0-3 M1 G1/G2 缺口固定',
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

function makeSession(header: any) {
  const events: any[] = []
  return {
    id: SESSION_ID,
    header: { createdAt: 1000, cwd: WORKSPACE, ...header },
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

function makeRuntime(record: any, session: any) {
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, cwd: WORKSPACE })
  runtime.state.records.set(session.id, record)
  runtime.state.activeTurns.set(session.id, 1)
  return runtime
}

function agentFor(session: any) {
  return { session }
}

function guarded(header: any) {
  const plan = makePlan()
  const session = makeSession(header)
  session.append('user/message', buildPlanMessage(plan, { totalBudgetMinutes: 20 }))
  session.append('deliverables/presented', {
    turn: 1,
    callId: 'call_present_1',
    files: [{ path: REPORT, description: '交付报告' }],
  })
  return { session, runtime: makeRuntime(makeRecord(plan), session) }
}

test('M1 G1 现状：子会话改写已交付文件不被拦（修复属 M3，需同步改既有用例第 184 行）', () => {
  const { session, runtime } = guarded({ parentSession: 'parent-session' })
  assert.equal(runtime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT }), undefined)

  // 对照：同一份数据，根会话就被拦。证明差别只来自 isRootSession 分支。
  const root = guarded({})
  assert.equal(typeof root.runtime.presentedWriteDenialReason(agentFor(root.session), { file_path: REPORT }), 'string')
})

test('M1 G2 现状：闸门只认三个写工具名，第四个写类工具名不进闸门', () => {
  const { session, runtime } = guarded({})
  const agent = agentFor(session)
  const call = (name: string, args: any = { file_path: REPORT }) =>
    fileWriteGuardReason({ name, agent, arguments: args }, runtime)

  // 已覆盖的三个：全部进闸门并被拦。
  assert.equal(typeof call('write'), 'string', 'write')
  assert.equal(typeof call('edit'), 'string', 'edit')
  assert.equal(typeof call('str_replace_editor', { path: REPORT }), 'string', 'str_replace_editor')

  // 未覆盖的写类工具名：不进闸门，哪怕参数就是已交付路径。
  assert.equal(call('apply_patch'), undefined, 'G2 缺口现状：apply_patch 不进闸门')

  // 对照：非写工具本来就不该拦，证明上面的 undefined 不是闸门整体失灵。
  assert.equal(call('read'), undefined, 'read')
  assert.equal(fileWriteGuardReason({ name: 'present', agent }, runtime), undefined, 'present')
  assert.equal(fileWriteGuardReason({ name: 'dsh_workplan_dispatch', agent }, runtime), undefined, 'dispatch')
})
