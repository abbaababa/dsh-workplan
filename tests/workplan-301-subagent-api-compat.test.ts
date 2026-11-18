/*
 * [3.0.1][P0/P1] 与 DSH 0.2.2-rc.3 内置 subagent 插件的冲突修复回归。
 *
 * 背景（审计报告，4 条真冲突里的 3 条已在 3.0.1 修复）：
 *  P0 旧 API `subagents.interruptByParent(childId, parentId, 'continuable')`
 *     在 0.2.2-rc.3 已不存在 ⇒ phase-0 会话不被中断、白跑烧 token。
 *     修复：interruptChildContinuable() 优先新版 interrupt()，旧版回退。
 *  P1a 宿主设置 subagent.maxDepth（默认 1）与本插件三层体系（需 ≥2）矛盾
 *     且被 spec.maxDepth 架空。修复：detectDepthOverrideConflict() 一次性告警。
 *  P1b 宿主并发上限 SubagentError(code='ACTIVATION_LIMIT_REACHED') 原样透出。
 *     修复：describeSubagentActivationError() 翻译为可行动中文提示。
 *
 * 断言口径：三个 helper 全部行为级（纯函数，假 subagents 服务），
 * 不依赖真实宿主——旧测试夹具只 mock interruptByParent，回退路径必须保持可用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { PlanError } from '../src/plan.js'
import {
  describeSubagentActivationError,
  detectDepthOverrideConflict,
  interruptChildContinuable,
  isActivationLimitError,
  startActivationQueued,
} from '../src/runtime.js'

const LIVE_LEADER = { id: 'agent-leader' }

test('[3.0.1][P0] interruptChildContinuable 优先新版 interrupt()', () => {
  const calls: any[] = []
  const subagents = {
    interrupt: (target: string, authority: any) => { calls.push({ target, authority }) },
    interruptByParent: (...args: any[]) => { calls.push({ legacy: args }) },
  }
  const ok = interruptChildContinuable(subagents, 'session-child', LIVE_LEADER)
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, 'session-child')
  assert.equal(calls[0].authority.kind, 'ancestor')
  assert.equal(calls[0].authority.agent, LIVE_LEADER)
  // 旧 API 不得被同时调用（双派发会重复中断）。
  assert.equal(calls[0].legacy, undefined)
})

test('[3.0.1][P0] interruptChildContinuable 旧版宿主回退 interruptByParent', () => {
  const calls: any[] = []
  const subagents = {
    interruptByParent: (childId: string, parentId: string, mode: string) => { calls.push({ childId, parentId, mode }) },
  }
  const ok = interruptChildContinuable(subagents, 'session-child', LIVE_LEADER)
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ childId: 'session-child', parentId: 'agent-leader', mode: 'continuable' }])
})

test('[3.0.1][P0] interruptChildContinuable 无 API / 无活体 ancestor 时静默返回 false', () => {
  assert.equal(interruptChildContinuable({}, 'session-child', LIVE_LEADER), false)
  assert.equal(interruptChildContinuable(null, 'session-child', LIVE_LEADER), false)
  assert.equal(interruptChildContinuable({ interrupt: () => undefined }, 'session-child', null), false)
  assert.equal(interruptChildContinuable({ interrupt: () => undefined }, 'session-child', undefined), false)
})

test('[3.0.1][P0] interruptChildContinuable 吞掉底层异常（中断失败不阻断接续）', () => {
  const subagents = {
    interrupt: () => { throw new Error('UNAUTHORIZED: not a live descendant') },
  }
  assert.equal(interruptChildContinuable(subagents, 'session-child', LIVE_LEADER), false)
  const legacy = {
    interruptByParent: () => { throw new Error('boom') },
  }
  assert.equal(interruptChildContinuable(legacy, 'session-child', LIVE_LEADER), false)
})

test('[3.0.1][P1a] detectDepthOverrideConflict 宿主 maxDepth<2 时告警且只告警一次', () => {
  const subagents = { resolveMaxDepth: () => 1 }
  const first = detectDepthOverrideConflict(subagents, 'scope-plan-1')
  assert.ok(first)
  assert.match(first as string, /subagent\.maxDepth/)
  assert.match(first as string, /当前为 1/)
  assert.match(first as string, /不受此设置影响/)
  // 同一 scope 第二次不再告警（一次性）。
  assert.equal(detectDepthOverrideConflict(subagents, 'scope-plan-1'), null)
  // 不同 scope 仍告警。
  assert.ok(detectDepthOverrideConflict(subagents, 'scope-plan-2'))
})

test('[3.0.1][P1a] detectDepthOverrideConflict 无冲突情形返回 null', () => {
  assert.equal(detectDepthOverrideConflict({ resolveMaxDepth: () => 2 }, 'scope-a'), null)
  assert.equal(detectDepthOverrideConflict({ resolveMaxDepth: () => 8 }, 'scope-b'), null)
  assert.equal(detectDepthOverrideConflict({ resolveMaxDepth: () => Number.POSITIVE_INFINITY }, 'scope-c'), null)
  // 宿主无 resolveMaxDepth（旧版本/夹具）：不告警。
  assert.equal(detectDepthOverrideConflict({}, 'scope-d'), null)
  // 宿主解析抛错：不阻断派发。
  assert.equal(detectDepthOverrideConflict({ resolveMaxDepth: () => { throw new Error('x') } }, 'scope-e'), null)
  // 非法 scope：不告警。
  assert.equal(detectDepthOverrideConflict({ resolveMaxDepth: () => 1 }, ''), null)
  assert.equal(detectDepthOverrideConflict({ resolveMaxDepth: () => 1 }, null), null)
})

test('[3.0.1][P1b] describeSubagentActivationError 翻译宿主并发上限', () => {
  const byCode = describeSubagentActivationError(
    Object.assign(new Error('subagent limit reached (active child limit: 8)'), { code: 'ACTIVATION_LIMIT_REACHED' }),
    '派发子任务 T1',
  )
  assert.ok(byCode instanceof PlanError)
  assert.equal(byCode.code, 'ACTIVATION_LIMIT_REACHED')
  assert.match(byCode.message, /派发子任务 T1/)
  assert.match(byCode.message, /maxActiveSubagents/)
  assert.match(byCode.message, /稍后重试/)
  // 仅 message 命中（无 code）也要翻译。
  const byMessage = describeSubagentActivationError(new Error('subagent limit reached (active child limit: 8)'), '派发成员')
  assert.ok(byMessage instanceof PlanError)
  assert.equal(byMessage.code, 'ACTIVATION_LIMIT_REACHED')
})

test('[3.0.6] 并发上限排队：先满后空，等待后成功而不是判失败', async () => {
  let calls = 0
  const result = await startActivationQueued(async () => {
    calls += 1
    if (calls === 1) {
      throw Object.assign(new Error('subagent limit reached (active child limit: 8)'), { code: 'ACTIVATION_LIMIT_REACHED' })
    }
    return { childId: 'child-1' }
  }, undefined, '派发子任务 T1')
  assert.deepEqual(result, { childId: 'child-1' })
  assert.equal(calls, 2)
})

test('[3.0.6] 非并发上限错误立即上抛，不排队、不重试', async () => {
  const original = new Error('boom')
  await assert.rejects(
    () => startActivationQueued(async () => { throw original }, undefined, 'ctx'),
    (error: any) => error === original,
  )
})

test('[3.0.6] 排队等待期间被取消：抛 ABORTED，不把取消记成并发失败', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => startActivationQueued(async () => {
      throw Object.assign(new Error('limit reached'), { code: 'ACTIVATION_LIMIT_REACHED' })
    }, controller.signal, 'ctx'),
    (error: any) => error?.code === 'ABORTED',
  )
})

test('[3.0.6] isActivationLimitError 同时认 code 与 message，不误伤普通错误', () => {
  assert.equal(isActivationLimitError({ code: 'ACTIVATION_LIMIT_REACHED' }), true)
  assert.equal(isActivationLimitError(new Error('subagent limit reached (active child limit: 8)')), true)
  assert.equal(isActivationLimitError(new Error('boom')), false)
})

test('[3.0.1][P1b] describeSubagentActivationError 非并发上限错误原样返回', () => {
  const original = new Error('Cannot read properties of undefined')
  assert.equal(describeSubagentActivationError(original, '派发子任务 T1'), original)
  const plain = describeSubagentActivationError({ code: 'UNAUTHORIZED', message: 'nope' }, 'ctx')
  assert.ok(plain instanceof Error)
  assert.equal(plain.message, 'nope')
  // null/undefined 不炸。
  const nil = describeSubagentActivationError(null, 'ctx')
  assert.ok(nil instanceof Error)
})
