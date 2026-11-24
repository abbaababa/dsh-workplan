/*
 * [3.1.8][T2 报告 D1/D2/D3] 回归守门。
 *
 * 事故（2026-11-21 T2，wp-67ab2259）：9 名第三层专家 0 名最终汇报；负责人
 * 换主后旧叶子 self_effort 认亲失败；派发循环先拉起叶子、后落 delegates，
 * 叶子在窗口内开工登记被拒；负责人 instruct 只认当前 childId，旧负责人被
 * 判「只有根会话可以下发指示」。
 *
 * 这里钉住三条可独立验证的不变量：
 *  - D1/D3：childIdHistory 里的前任负责人仍算这一行的负责人；instruct 的
 *    三级认亲（当前 childId → 历史 → 叶子父会话）与 delegateTool 同判据。
 *  - D2：childId=null 的 running 占位条目可被 applyStatus/回放接受；后续
 *    self_effort 绑定 childId 后，旧的 null 快照不得把新 childId 抹掉。
 *  - D5：负责人会话已释放且无快照时，开工超过 120s 的 running 才标
 *    failed(stalled)；活体、新开工、排队中、待指示一律不动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyStatus, createStatuses, mergeDelegateEntriesMonotonic } from '../src/plan.js'
import {
  findHeadRowForSession,
  forgetHeadActivation,
  headRowOwnedBy,
  markStalledDelegates,
  prepareDelegateRegistrationBase,
  recallLiveHeadActivation,
  rememberHeadActivation,
} from '../src/runtime.js'

const PLAN = {
  planId: 'wp-318-d1d2d3',
  sessionId: 'session-318',
  createdTurn: 1,
  createdAt: 1000,
  title: 'T2 缺陷回归',
  contradictions: { primary: { statement: '负责人身份必须可回溯' } },
  stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }] }],
}

test('D1：childIdHistory 中的前任负责人仍拥有该行', () => {
  const row = {
    subtaskId: 'T1',
    childId: 'head-new',
    childIdHistory: [{ childId: 'head-old', replacedAt: 2000 }],
  }
  assert.equal(headRowOwnedBy(row, 'head-new'), true)
  assert.equal(headRowOwnedBy(row, 'head-old'), true, '换主后旧负责人必须能认回自己的行')
  assert.equal(headRowOwnedBy(row, 'stranger'), false)
  assert.equal(headRowOwnedBy({}, 'head-old'), false)
})

test('D3：instruct 三级认亲——当前 childId / 历史 / 叶子父会话', () => {
  const direct = { subtaskId: 'T1', childId: 'head-1', delegates: [] }
  assert.equal(findHeadRowForSession([direct], 'head-1', () => null), direct)

  const historical = {
    subtaskId: 'T2',
    childId: 'head-new',
    childIdHistory: [{ childId: 'head-old', replacedAt: 2000 }],
    delegates: [],
  }
  assert.equal(findHeadRowForSession([historical], 'head-old', () => null), historical)

  const byLeafParent = {
    subtaskId: 'T3',
    childId: 'head-other',
    delegates: [{ member: 'Expert-A', childId: 'leaf-1' }],
  }
  const getSession = (id: string) => id === 'leaf-1'
    ? { header: { parentSession: 'head-old' } }
    : null
  assert.equal(findHeadRowForSession([byLeafParent], 'head-old', getSession), byLeafParent)

  assert.equal(findHeadRowForSession([direct, historical], 'stranger', () => null), null)
})

test('D2：childId=null 的 running 占位条目可落账，self_effort 绑定后旧快照不覆盖', () => {
  let statuses: any = createStatuses(PLAN)
  statuses = applyStatus(statuses, 'T1', { status: 'in_progress', childId: 'head-1' })
  const placeholder = {
    member: 'Expert-A',
    role: 'expert',
    task: '实现核心逻辑',
    qualityRequirements: ['必须给出可复核的命令输出'],
    effort: 'high',
    childId: null,
    status: 'running',
    summary: '',
    error: null,
    startedAt: 1000,
    finishedAt: null,
  }
  statuses = applyStatus(statuses, 'T1', { delegates: [placeholder] })
  let row: any = statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.delegates.length, 1, '派发前必须先登记占位条目')
  assert.equal(row.delegates[0].status, 'running')
  assert.equal(row.delegates[0].childId, null, '占位条目尚未绑定 childId')

  // phase-0 叶子首次 self_effort：按成员名认亲并绑定自己的 childId。
  let merged = mergeDelegateEntriesMonotonic(row.delegates, [{ ...placeholder, childId: 'leaf-phase0' }])
  row = { ...row, delegates: merged.value }
  assert.equal(row.delegates[0].childId, 'leaf-phase0')

  // self_effort 接续到 phase-1：同一个成员换新 childId。
  merged = mergeDelegateEntriesMonotonic(row.delegates, [{
    ...row.delegates[0],
    childId: 'leaf-phase1',
    selfEffort: 'high',
    startedAt: 2000,
  }])
  assert.equal(merged.value[0].childId, 'leaf-phase1')

  // 派发循环收尾时本地数组仍可能是 childId=null 的旧快照：不得把 phase-1 抹掉。
  merged = mergeDelegateEntriesMonotonic(merged.value, [placeholder])
  assert.equal(merged.value[0].childId, 'leaf-phase1', '旧 null 快照不得覆盖已接续的新 childId')
  assert.equal(merged.value[0].status, 'running')
})

test('D2 重派：childId=null 的新占位必须替换旧 failed，不能被终态闸挡回', () => {
  const old = { member: 'Expert-A', childId: 'leaf-old', status: 'failed', finishedAt: 900 }
  const placeholder = { member: 'Expert-A', childId: null, status: 'running', startedAt: 1000 }
  const base = prepareDelegateRegistrationBase([old], [placeholder])
  assert.equal(base.length, 1)
  assert.equal(base[0].childId, null, '旧 failed 必须先被新占位替换，否则 merge 会保留旧终态')
  assert.equal(base[0].status, 'running')

  const merged = mergeDelegateEntriesMonotonic(base, [placeholder])
  assert.equal(merged.value[0].status, 'running')
  assert.equal(merged.value[0].childId, null)

  const escalated = { member: 'Expert-A', childId: 'leaf-old', status: 'failed', escalation: { question: '选 A 还是 B？' } }
  assert.equal(prepareDelegateRegistrationBase([escalated], [placeholder])[0], escalated, '待指示条目绝不能被重派占位替换')
})

test('D4：head 结算后 forget，旧会话仍存活也不再永久挡住重派', () => {
  const sessions = new Map<string, any>([['head-1', { id: 'head-1' }]])
  const ctx: any = { sessions }
  rememberHeadActivation(ctx, 'wp-318', 'T1', 'head-1')
  assert.equal(recallLiveHeadActivation(ctx, 'wp-318', 'T1'), 'head-1')

  forgetHeadActivation(ctx, 'wp-318', 'T1', 'another-head')
  assert.equal(recallLiveHeadActivation(ctx, 'wp-318', 'T1'), 'head-1', '非本次 childId 不得误删更新登记')

  forgetHeadActivation(ctx, 'wp-318', 'T1', 'head-1')
  assert.equal(recallLiveHeadActivation(ctx, 'wp-318', 'T1'), null, 'head 结算后必须撤销登记，允许合法重派')
})

test('D5：负责人已释放且无快照，超 600s 的 running 才标 failed(stalled)（3.2.6 阈值 120s→600s）', () => {
  const now = 10_000_000
  const delegates = [
    { member: 'dead', childId: 'c-dead', status: 'running', startedAt: now - 630_000 },
    { member: 'live', childId: 'c-live', status: 'running', startedAt: now - 630_000 },
    { member: 'fresh', childId: 'c-fresh', status: 'running', startedAt: now - 10_000 },
    { member: 'queued', childId: null, status: 'running', startedAt: now - 630_000 },
    { member: 'esc', childId: 'c-esc', status: 'running', startedAt: now - 630_000, escalation: { question: '选 A 还是 B？' } },
    { member: 'settled', childId: 'c-settled', status: 'running', startedAt: now - 630_000 },
  ]
  const result = markStalledDelegates(
    delegates,
    (id: string) => (id === 'c-live' ? { id } : null),
    (id: string) => (id === 'c-settled' ? { at: now - 1000, text: '{}' } : null),
    now,
  )
  assert.equal(result.changed, true)
  assert.equal(result.stalled.length, 1)
  assert.equal(result.stalled[0].member, 'dead')
  assert.equal(result.stalled[0].status, 'failed')
  assert.match(result.stalled[0].error, /600s|停滞/)
  assert.equal(result.delegates.find((item: any) => item.member === 'live').status, 'running', '活体会话不得误杀')
  assert.equal(result.delegates.find((item: any) => item.member === 'fresh').status, 'running', '新开工不得误杀')
  assert.equal(result.delegates.find((item: any) => item.member === 'queued').status, 'running', 'childId 未登记（排队/激活中）不得误杀')
  assert.equal(result.delegates.find((item: any) => item.member === 'esc').status, 'running', '待指示不得误杀')
  assert.equal(result.delegates.find((item: any) => item.member === 'settled').status, 'running', '有结算快照交给 reconcile 处理，不由停滞兜底误杀')
})

test('D5：getSession 抛错视为未知，不把 running 误判为停滞', () => {
  const now = 10_000_000
  const delegates = [{ member: 'unknown', childId: 'c-x', status: 'running', startedAt: now - 130_000 }]
  const result = markStalledDelegates(
    delegates,
    () => { throw new Error('sessions unavailable') },
    () => null,
    now,
  )
  assert.equal(result.changed, false)
  assert.equal(result.delegates[0].status, 'running')
})

test('D5：stalled 终止标记可随 delegates 持久化/回放（不被消毒丢弃）', () => {
  let statuses: any = createStatuses(PLAN)
  statuses = applyStatus(statuses, 'T1', { status: 'in_progress', childId: 'head-1' })
  statuses = applyStatus(statuses, 'T1', {
    delegates: [{
      member: 'Expert-A',
      childId: 'leaf-1',
      status: 'failed',
      error: '子会话已消失超过 120s 且无结束快照，判定停滞（不自动重派）',
      termination: { kind: 'stalled', state: 'sent', at: 2000, ref: 'plan:1' },
    }],
  })
  const row: any = statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.delegates[0].termination.kind, 'stalled')
  assert.equal(row.delegates[0].termination.state, 'sent')
})
