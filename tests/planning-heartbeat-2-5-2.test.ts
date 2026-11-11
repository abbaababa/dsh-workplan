/*
 * [2.5.2] 规划期间心跳回归（用户 2026-11-11 报告：本会话 turn 1 规划 12.5
 * 分钟全程零会话输出，用户以为死机并手动中断，turn/end reason=interrupted）。
 *
 * 根因：失败重试回报器只在「失败且退避重试」时发通知；一次持续流式但很慢
 * 的尝试不失败也不触发 idle，于是【规划预告】之后整段静默。心跳与重试正交：
 * 只要 runPlanner 还在跑，就按固定间隔发一条「仍在生成、已用时多久、不是
 * 卡死」的可见通知。
 *
 * 断言点：
 *  - 文案纯函数：含已用时（分/秒）、含「不是卡死」、尝试序号 >1 才显示；
 *  - 间隔归一：合法值原样、非法/过小回落 45000；
 *  - 注入工厂（假时钟，零真实定时器）：周期触发、stop 收束、aborted 静默、
 *    maxNotices 保险丝、getAttempt 透传；
 *  - 源码锚定：maybePlan 在 runPlanner 之前 start、finally 里 stop、写入走
 *    唯一合规写入器 appendUserMessage（不新增事件类型、不触碰 system/message）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  planningHeartbeatIntervalMs,
  buildPlanningHeartbeat,
  createPlanningHeartbeat,
} from '../src/plan.js'

const runtimeSource = readFileSync(join(process.cwd(), 'src/runtime.ts'), 'utf8')

function makeFakeTimers() {
  let now = 0
  let seq = 0
  const tasks = new Map<number, { at: number; every: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      tasks.set(id, { at: now + ms, every: ms, fn })
      return id
    },
    clearTimer: (id: number) => { tasks.delete(id) },
    advance: (ms: number) => {
      const end = now + ms
      for (;;) {
        let best: { id: number; at: number } | null = null
        for (const [id, t] of tasks) {
          if (t.at <= end && (!best || t.at < best.at)) best = { id, at: t.at }
        }
        if (!best) break
        now = best.at
        const t = tasks.get(best.id)!
        t.at = now + t.every
        t.fn()
      }
      now = end
    },
    count: () => tasks.size,
  }
}

test('心跳文案：含已用时与「不是卡死」，尝试序号 >1 才显示', () => {
  const one = buildPlanningHeartbeat(65000, 1, 3)
  assert.match(one, /【规划进行中】/)
  assert.match(one, /1 分 5 秒/)
  assert.match(one, /不是卡死/)
  assert.ok(!one.includes('第 1/3'), '首次尝试不显示序号')
  const two = buildPlanningHeartbeat(125000, 2, 3)
  assert.match(two, /2 分 5 秒/)
  assert.match(two, /第 2\/3 次尝试/)
  assert.match(buildPlanningHeartbeat(0, 1, 3), /0 秒/)
  // 越界尝试序号被钳制到 [1, maxAttempts]
  assert.match(buildPlanningHeartbeat(1000, 9, 3), /第 3\/3 次尝试/)
})

test('心跳间隔归一：合法原样、非法/过小回落 45000', () => {
  assert.equal(planningHeartbeatIntervalMs(45000), 45000)
  assert.equal(planningHeartbeatIntervalMs(10000), 10000)
  assert.equal(planningHeartbeatIntervalMs(1000), 45000)
  assert.equal(planningHeartbeatIntervalMs(0), 45000)
  assert.equal(planningHeartbeatIntervalMs(-5), 45000)
  assert.equal(planningHeartbeatIntervalMs('abc'), 45000)
  assert.equal(planningHeartbeatIntervalMs(undefined), 45000)
})

test('心跳工厂：按间隔周期触发，stop 后彻底收束（零残留定时器）', () => {
  const clock = makeFakeTimers()
  const notices: string[] = []
  const hb = createPlanningHeartbeat({
    appendNotice: (t) => notices.push(t),
    intervalMs: 45000,
    startedAt: 0,
    maxAttempts: 3,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  hb.start()
  assert.equal(clock.count(), 1)
  clock.advance(45000)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /45 秒/)
  clock.advance(45000)
  assert.equal(notices.length, 2)
  assert.match(notices[1], /1 分 30 秒/)
  hb.stop()
  assert.equal(clock.count(), 0, 'stop 必须清除定时器')
  clock.advance(90000)
  assert.equal(notices.length, 2, 'stop 后不再发通知')
  hb.stop() // 幂等
  assert.equal(clock.count(), 0)
})

test('心跳工厂：用户中止（signal.aborted）后静默并收束', () => {
  const clock = makeFakeTimers()
  const notices: string[] = []
  const signal: any = { aborted: false }
  const hb = createPlanningHeartbeat({
    signal,
    appendNotice: (t) => notices.push(t),
    intervalMs: 45000,
    startedAt: 0,
    maxAttempts: 3,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  hb.start()
  clock.advance(45000)
  assert.equal(notices.length, 1)
  signal.aborted = true
  clock.advance(45000)
  assert.equal(notices.length, 1, '中止后不再打扰用户')
  assert.equal(clock.count(), 0, '中止 tick 自行收束定时器')
  // 已中止时 start 直接不武装
  const hb2 = createPlanningHeartbeat({
    signal,
    appendNotice: (t) => notices.push(t),
    intervalMs: 45000,
    startedAt: 0,
    maxAttempts: 3,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  hb2.start()
  assert.equal(clock.count(), 0)
})

test('心跳工厂：maxNotices 保险丝封顶后自动收束', () => {
  const clock = makeFakeTimers()
  const notices: string[] = []
  const hb = createPlanningHeartbeat({
    appendNotice: (t) => notices.push(t),
    intervalMs: 45000,
    startedAt: 0,
    maxAttempts: 3,
    maxNotices: 2,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  hb.start()
  clock.advance(45000 * 6)
  assert.equal(notices.length, 2)
  assert.equal(clock.count(), 0)
})

test('心跳工厂：getAttempt 透传到文案', () => {
  const clock = makeFakeTimers()
  const notices: string[] = []
  let attempt = 1
  const hb = createPlanningHeartbeat({
    appendNotice: (t) => notices.push(t),
    intervalMs: 45000,
    startedAt: 0,
    getAttempt: () => attempt,
    maxAttempts: 3,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  hb.start()
  clock.advance(45000)
  assert.ok(!notices[0].includes('第 1/3'))
  attempt = 2
  clock.advance(45000)
  assert.match(notices[1], /第 2\/3 次尝试/)
  hb.stop()
})

test('源码锚定：maybePlan 在 runPlanner 之前 start、finally 里 stop、走合规写入器', () => {
  assert.match(runtimeSource, /export const PLANNING_HEARTBEAT_MS = 45000/)
  const startIdx = runtimeSource.indexOf('planningHeartbeat.start()')
  const runIdx = runtimeSource.indexOf('plan = await runPlanner(ctx, {')
  const stopIdx = runtimeSource.indexOf('planningHeartbeat.stop()')
  assert.ok(startIdx > 0, '必须启动心跳')
  assert.ok(runIdx > startIdx, '心跳必须在 runPlanner 之前启动')
  assert.ok(stopIdx > runIdx, '心跳必须在 runPlanner 之后收束')
  // stop 落在 finally 块内（规划成功/降级/中止都收束）
  const finallyIdx = runtimeSource.lastIndexOf('} finally {', stopIdx)
  assert.ok(finallyIdx > runIdx && finallyIdx < stopIdx, 'stop 必须在 finally 内')
  // 心跳通知走唯一合规写入器，不新增事件类型
  const hbBlock = runtimeSource.slice(runtimeSource.indexOf('const planningHeartbeat = createPlanningHeartbeat('), startIdx)
  assert.match(hbBlock, /appendNotice: \(text: string\) => appendUserMessage\(session, text\)/)
  assert.ok(!/system\/message/.test(hbBlock), '心跳不得触碰 system/message')
})
