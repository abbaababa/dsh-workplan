/*
 * [3.1.5] 第三层叶子「会话已结束但台账仍 running」的回归。
 *
 * 事故口径：行业景气/资金面专家会话已 turn/end，甚至已给出普通文字结论；但
 * 缺少合格 WORKPLAN_EVIDENCE 结果块时绝不能显示/结算为 done。旧实现一旦异步
 * 结算回调被吞，delegates[].status 会永久停在 running，和会话侧“已完成”观感互相矛盾。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectSettledSnapshots, reconcileEndedDelegateSessions } from '../src/runtime.js'

function sessionWith(events: any[]) {
  return {
    seq: events.length,
    eventAt(index: number) {
      return events[index] ?? null
    },
  }
}

test('叶子会话已结束且最后只有普通正文时，running 收敛为 failed，绝不计 done', () => {
  const ended = sessionWith([
    { type: 'turn/start', time: 1000 },
    {
      type: 'assistant/message',
      time: 1100,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '任务完成，但没有结构化结果块。' }] } },
    },
    { type: 'turn/end', time: 1200, data: { reason: { kind: 'completed' } } },
  ])
  const delegates = [{ member: '行业景气研究员', childId: 'c-1', status: 'running' }]
  const result = reconcileEndedDelegateSessions(delegates, () => ended)
  assert.equal(result.changed, true)
  assert.equal(result.delegates[0].status, 'failed')
  assert.match(result.delegates[0].error, /结果块缺失|WORKPLAN_EVIDENCE|完成必回报/)
  assert.equal(result.delegates[0].finishedAt, 1200)
})

test('phase-0 以工具调用结束、无助手正文时，不误判 failed', () => {
  const phaseZero = sessionWith([
    { type: 'turn/start', time: 1000 },
    { type: 'assistant/message', time: 1100, data: { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'dsh_workplan_delegate' }] } } },
    { type: 'turn/end', time: 1200, data: { reason: { kind: 'completed' } } },
  ])
  const delegates = [{ member: '资金面研究员', childId: 'c-2', status: 'running' }]
  const result = reconcileEndedDelegateSessions(delegates, () => phaseZero)
  assert.equal(result.changed, false)
  assert.equal(result.delegates[0].status, 'running')
})

test('待指示叶子保持待指示，不被收敛覆盖', () => {
  const ended = sessionWith([
    { type: 'turn/start', time: 1000 },
    { type: 'assistant/message', time: 1100, data: { message: { role: 'assistant', content: [{ type: 'text', text: '需要负责人决定。' }] } } },
    { type: 'turn/end', time: 1200, data: { reason: { kind: 'completed' } } },
  ])
  const delegates = [{ member: 'x', childId: 'c-3', status: 'running', escalation: { question: '选 A 还是 B？' } }]
  const result = reconcileEndedDelegateSessions(delegates, () => ended)
  assert.equal(result.changed, false)
  assert.equal(result.delegates[0].status, 'running')
})

test('没有会话或回合仍开时保持 running', () => {
  const open = sessionWith([
    { type: 'turn/start', time: 1000 },
  ])
  const delegates = [{ member: 'a', childId: 'missing', status: 'running' }, { member: 'b', childId: 'open', status: 'running' }]
  const result = reconcileEndedDelegateSessions(delegates, (id) => id === 'open' ? open : null)
  assert.equal(result.changed, false)
  assert.deepEqual(result.delegates.map((item: any) => item.status), ['running', 'running'])
})

/*
 * [T4][F1] 生产主路径回归：宿主先 dispose 子会话、后 notifySettlement
 * （dsh-subagent/src/manager.ts:1077 → :1105），负责人事后 status 时
 * ctx.sessions.get(childId) 必然为空。收尾事实只能来自父会话 durable 的
 * subagent-settled 快照（source.kind='subagent-settled'）。
 */
test('F1：子会话已释放但父会话有持久结算快照，running 收敛为 failed（不再永久 running）', () => {
  const delegates = [{ member: '行业景气专家', childId: 'c-9', status: 'running' }]
  const result = reconcileEndedDelegateSessions(
    delegates,
    () => undefined,
    (id) => id === 'c-9'
      ? { childId: id, at: 5000, stopReason: 'completed', text: '任务完成，但没有结构化结果块。', omitted: false }
      : undefined,
  )
  assert.equal(result.changed, true)
  assert.equal(result.delegates[0].status, 'failed')
  assert.equal(result.delegates[0].finishedAt, 5000)
  assert.equal(result.delegates[0].reconciledFrom, 'settled-message')
  assert.equal(typeof result.delegates[0].reconciledAt, 'number')
  assert.equal(result.reconciled.length, 1)
  assert.equal(result.unresolved.length, 0)
})

test('F1：结算快照里有合格结果块时收敛为 done（与 F10 判据同源）', () => {
  const block = [
    '<!-- WORKPLAN_EVIDENCE:START -->',
    '{"status":"done","report":{"keyResults":["完成行业景气度分析"],"keyInfo":[],"importantInfo":[],"leadRequirements":["核实结论"]}}',
    '<!-- WORKPLAN_EVIDENCE:END -->',
  ].join('\n')
  const delegates = [{ member: '资金面专家', childId: 'c-10', status: 'running' }]
  const result = reconcileEndedDelegateSessions(
    delegates,
    () => undefined,
    (id) => id === 'c-10'
      ? { childId: id, at: 6000, stopReason: 'completed', text: block, omitted: false }
      : undefined,
  )
  assert.equal(result.changed, true)
  assert.equal(result.delegates[0].status, 'done')
  assert.equal(result.delegates[0].error, null)
  assert.match(String(result.delegates[0].summary), /完成行业景气度分析/)
})

test('F1：结算快照 stopReason 非 completed 时收敛为 failed', () => {
  const delegates = [{ member: 'x', childId: 'c-11', status: 'running' }]
  const result = reconcileEndedDelegateSessions(
    delegates,
    () => undefined,
    () => ({ childId: 'c-11', at: 7000, stopReason: 'error', text: '', omitted: false }),
  )
  assert.equal(result.changed, true)
  assert.equal(result.delegates[0].status, 'failed')
  assert.match(String(result.delegates[0].error), /子会话结束状态 error/)
})

test('F1：已结束但没有收尾正文时收敛为 failed，绝不计 done', () => {
  const delegates = [{ member: 'y', childId: 'c-12', status: 'running' }]
  const result = reconcileEndedDelegateSessions(
    delegates,
    () => undefined,
    () => ({ childId: 'c-12', at: 8000, stopReason: 'completed', text: '', omitted: false }),
  )
  assert.equal(result.changed, true)
  assert.equal(result.delegates[0].status, 'failed')
  assert.match(String(result.delegates[0].error), /收尾正文/)
})

test('F1：待指示的叶子即使有结算快照也不被收敛覆盖', () => {
  const delegates = [{ member: 'z', childId: 'c-13', status: 'running', escalation: { question: '选 A 还是 B？' } }]
  const result = reconcileEndedDelegateSessions(
    delegates,
    () => undefined,
    () => ({ childId: 'c-13', at: 9000, stopReason: 'completed', text: '内容', omitted: false }),
  )
  assert.equal(result.changed, false)
  assert.equal(result.delegates[0].status, 'running')
})

/*
 * [T4][F1] 快照解析：subagent-settled 的 content 结构 + omitted 回退到同
 * childId 最近一条 agent-message 正文（宿主在「子会话最后一步是给父会话发
 * 消息」时会省略 closing text）。
 */
test('F1：collectSettledSnapshots 解析 durable 结算消息，并用最近一条 agent-message 回填 omitted 正文', () => {
  const events = [
    {
      type: 'user/message',
      time: 1000,
      seq: 0,
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'Agent agent-2 sent a message: ' }, { type: 'text', text: '阶段性正文，无结果块' }],
        source: { kind: 'agent-message', senderSessionId: 'child-a' },
      },
    },
    {
      type: 'user/message',
      time: 2000,
      seq: 1,
      data: {
        role: 'user',
        content: [
          { type: 'text', text: 'Background subagent agent-2 finished.' },
          { type: 'text', text: 'It sent you a message just before finishing, so its closing message is omitted.' },
        ],
        source: { kind: 'subagent-settled', stopReason: 'completed', senderSessionId: 'child-a' },
      },
    },
  ]
  const session = { id: 'leader-session', seq: events.length, eventAt: (index: number) => events[index] ?? null }
  const snapshots = collectSettledSnapshots(session)
  const snapshot = snapshots.get('child-a')
  assert.equal(snapshot.stopReason, 'completed')
  assert.equal(snapshot.omitted, true)
  assert.equal(snapshot.text, '阶段性正文，无结果块')
  assert.equal(snapshot.at, 2000)
})
