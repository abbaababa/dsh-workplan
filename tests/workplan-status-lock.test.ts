/*
 * [1.7.0] Write protection for manual re-adjudication.
 *
 * Two data sources wrote the same status table with no protocol: the child's
 * settlement and the main Agent's `dsh_workplan_update`. A model editing a
 * running subtask had its verdict overwritten seconds later, and an edit based
 * on a stale snapshot silently destroyed newer evidence.
 *
 * These tests pin the two non-throwing refusals (`TASK_RUNNING`, `STALE_WRITE`),
 * the explicit `force` override, and the durability of a manual verdict — it
 * must survive a rebuild from the session log, otherwise a refresh reverts the
 * dashboard to the child's original result.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, parseResultMessage } from '../src/plan.js'
import { createWorkplanRuntime, reconstructFromSession } from '../src/runtime.js'

const eventLoopAnchor = setInterval(() => {}, 1_000)
const dropEventLoopAnchor = setTimeout(() => clearInterval(eventLoopAnchor), 60_000)
dropEventLoopAnchor.unref?.()
after(() => clearInterval(eventLoopAnchor))

function makePlan() {
  return {
    planId: 'wp-lock',
    sessionId: 'session-lock',
    createdTurn: 1,
    createdAt: 1000,
    title: '写保护回归',
    taskUnderstanding: { originalRequest: '回归验证协作通道', deliverable: '通过验收' },
    contradictions: { primary: { statement: '主 Agent 与子 Agent 必须共享同一份状态' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [{
        id: 'T1',
        title: '实现写保护',
        department: 'engineering',
        objective: '实现写保护',
        acceptance: ['拒绝并发覆盖'],
        outputs: ['代码'],
        risk: 'low',
        dependsOn: [],
      }],
    }],
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-lock',
    header: { createdAt: 1000 },
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

function deferred() {
  let release!: (value: any) => void
  const promise = new Promise<any>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function completed(text = '完成') {
  return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

function makeRuntime(child: Promise<any>) {
  const session = makeSession()
  session.append('user/message', buildPlanMessage(makePlan()))
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async () => ({ childId: 'child-lock', result: child, dispose: async () => {} }),
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, idleTimeoutMs: 30_000, maxResumes: 4 })
  return { session, runtime, ctx }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('计划执行中改判被拒绝（TASK_RUNNING），并给出当前状态', async () => {
  const gate = deferred()
  const { session, runtime } = makeRuntime(gate.promise)
  await runtime.dispatchTool({ session, options: {} }, { mode: 'async' }, new AbortController().signal)

  const refused = await runtime.updateStatus({ session }, { subtaskId: 'T1', status: 'blocked', note: '先标记' })
  assert.equal(refused.ok, false, '运行中的写入必须被拒绝而不是抛出')
  assert.equal(refused.code, 'TASK_RUNNING')
  assert.equal(refused.current.status, 'in_progress')
  assert.match(String(refused.hint), /force/)

  const forced = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    status: 'blocked',
    note: '人工改判',
    force: true,
  })
  assert.equal(forced.ok, true, 'force 是显式覆盖出口')
  assert.equal(forced.updatedBy, 'agent')

  gate.release(completed('完成'))
  assert.ok(await waitFor(() => session.events.some(
    (event) => event.type === 'user/message' && parseResultMessage(event.data),
  )))
})

test('基于旧 revision 的写入被拒绝（STALE_WRITE），不覆盖新证据', async () => {
  const { session, runtime } = makeRuntime(Promise.resolve(completed('完成')))
  await runtime.dispatchTool({ session, options: {} }, {}, new AbortController().signal)

  const snapshot: any = await runtime.statusTool({ session }, {})
  const current = snapshot.statuses[0]
  assert.equal(current.status, 'done')
  assert.ok(Number(current.revision) > 0, '完成项必须带 revision 供下次写入校验')

  const stale: any = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    status: 'in_progress',
    expectedRevision: Number(current.revision) - 1,
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'STALE_WRITE')
  assert.equal(stale.current.revision, current.revision)

  const fresh: any = await runtime.updateStatus({ session }, {
    subtaskId: 'T1',
    status: 'blocked',
    note: '证据不足，人工改回',
    expectedRevision: Number(current.revision),
  })
  assert.equal(fresh.ok, true, 'revision 正确时必须允许改判')
  assert.ok(Number(fresh.revision) > Number(current.revision), '每次写入都递增 revision')

  /*
   * A manual verdict is durable: a fresh runtime rebuilding from the session
   * log must see `blocked`, not fall back to the child's `done`.
   */
  const replayed = reconstructFromSession(session)
  assert.equal(replayed?.statuses[0].status, 'blocked')
  assert.equal(replayed?.statuses[0].updatedBy, 'agent')
  assert.ok(session.events.some((event) => {
    const text = JSON.stringify(event.data ?? {})
    return text.includes('workplan-update')
  }), '改判必须写进会话记录，刷新后仍可回放')
})
