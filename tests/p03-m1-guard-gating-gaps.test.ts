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

test('M1 G1 现状已翻转（1.12.2）：子会话改写已交付文件同样被拦', () => {
  const { session, runtime } = guarded({ parentSession: 'parent-session' })
  assert.equal(typeof runtime.presentedWriteDenialReason(agentFor(session), { file_path: REPORT }), 'string')

  // 对照：同一份数据，根会话同样被拦。1.12.2 起两者一致。
  const root = guarded({})
  assert.equal(typeof root.runtime.presentedWriteDenialReason(agentFor(root.session), { file_path: REPORT }), 'string')
})

// ---------------------------------------------------------------------------
// [1.12.2] G1 已修复：写保护不再区分「谁在写」。
// 子 Agent 会改掉用户手上那份文件，后果与根会话完全相同，所以必须同样被拦。
// 反向保护：子会话 plan 模式、未交付路径仍放行——修复不扩大成「子 Agent 不能写」。
// ---------------------------------------------------------------------------
test('G1 已修复：子 Agent 改写已交付文件同样被拦，且不误伤其它路径', () => {
  const child = guarded({ parentSession: 'parent-session', delegationDepth: 1 })
  const childReason = child.runtime.presentedWriteDenialReason(agentFor(child.session), { file_path: REPORT })
  assert.equal(typeof childReason, 'string', 'G1：子 Agent 写已交付文件必须被拦')
  assert.match(childReason, /wp-p03-m1-gating/)

  // 三种子会话识别方式都要覆盖：parentSession / origin=subagent / delegationDepth>0。
  for (const header of [{ origin: 'subagent' }, { delegationDepth: 2 }]) {
    const scoped = guarded(header)
    assert.equal(
      typeof scoped.runtime.presentedWriteDenialReason(agentFor(scoped.session), { file_path: REPORT }),
      'string',
      JSON.stringify(header),
    )
  }

  // 反向保护：未交付的其它路径对子 Agent 仍然放行。
  assert.equal(
    child.runtime.presentedWriteDenialReason(agentFor(child.session), { file_path: WORKSPACE + '/other.md' }),
    undefined,
    'G1：未交付路径不得被误拦',
  )
})

test('M1 G2 现状已翻转（1.12.2）：第四个写类工具名同样进闸门', () => {
  const { session, runtime } = guarded({})
  const agent = agentFor(session)
  const call = (name: string, args: any = { file_path: REPORT }) =>
    fileWriteGuardReason({ name, agent, arguments: args }, runtime)

  // 已覆盖的三个：全部进闸门并被拦。
  assert.equal(typeof call('write'), 'string', 'write')
  assert.equal(typeof call('edit'), 'string', 'edit')
  assert.equal(typeof call('str_replace_editor', { path: REPORT }), 'string', 'str_replace_editor')

  // 未覆盖的写类工具名：1.12.2 起按参数形状进闸门，同样被拦。
  const patch = '*** Begin Patch\n*** Update File: ' + REPORT + '\n@@\n-a\n+b\n*** End Patch'
  assert.equal(typeof call('apply_patch', { input: patch }), 'string', 'G2 已修复：apply_patch 进闸门')

  // 对照：非写工具本来就不该拦，证明上面的 undefined 不是闸门整体失灵。
  assert.equal(call('read'), undefined, 'read')
  assert.equal(fileWriteGuardReason({ name: 'present', agent }, runtime), undefined, 'present')
  assert.equal(fileWriteGuardReason({ name: 'dsh_workplan_dispatch', agent }, runtime), undefined, 'dispatch')
})

// ---------------------------------------------------------------------------
// [1.12.2] G2 已修复：按「参数形状」识别写操作，不再依赖工具名白名单。
// ---------------------------------------------------------------------------
test('G2 已修复：第四个写类工具名按参数形状进闸门，读类调用不受影响', () => {
  const { session, runtime } = guarded({})
  const agent = agentFor(session)

  // 以前进不了闸门的写法，现在都被拦。
  const blocked: Array<[string, any]> = [
    ['apply_patch', { input: '*** Begin Patch\n*** Update File: ' + REPORT + '\n@@\n-a\n+b\n*** End Patch' }],
    ['write_file', { path: REPORT, content: '# 覆盖\n' }],
    ['create', { file_path: REPORT, file_text: '# 覆盖\n' }],
    ['some_future_editor', { file_path: REPORT, new_str: 'x' }],
  ]
  for (const [name, args] of blocked) {
    assert.equal(typeof fileWriteGuardReason({ name, agent, arguments: args }, runtime), 'string', name)
  }

  // apply_patch 多文件：只要有一个 hunk 命中已交付文件就整单拒绝。
  const mixed = '*** Begin Patch\n*** Update File: ' + WORKSPACE + '/other.md\n@@\n-a\n+b\n'
    + '*** Update File: ' + REPORT + '\n@@\n-a\n+b\n*** End Patch'
  assert.equal(typeof fileWriteGuardReason({ name: 'apply_patch', agent, arguments: { input: mixed } }, runtime), 'string')

  // 反向保护：只写未交付文件的 patch、以及纯读类工具一律放行。
  const harmless = '*** Begin Patch\n*** Update File: ' + WORKSPACE + '/other.md\n@@\n-a\n+b\n*** End Patch'
  assert.equal(fileWriteGuardReason({ name: 'apply_patch', agent, arguments: { input: harmless } }, runtime), undefined)
  for (const name of ['read', 'read_image', 'glob', 'grep', 'todo_write']) {
    assert.equal(fileWriteGuardReason({ name, agent, arguments: { file_path: REPORT, path: REPORT } }, runtime), undefined, name)
  }
})
