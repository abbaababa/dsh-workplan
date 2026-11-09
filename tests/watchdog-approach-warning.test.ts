/*
 * [2.2.0][T2 红灯先行] 超时预警窗 —— 对应优化项 **O-4b / O-4d**。
 * 设计依据：docs/dsh-workplan_优化方案_20261107.md §1 ④ 验收矩阵 D1/D2、§2.3 超时预警行。
 *
 * 断言点（公式/数值抄录方案原文，不改写）：
 *  - O-4b：剩余时间 ≤ **max(20%, 2 分钟)**（取大者）**恰好触发一次、幂等**；
 *    3 组数值样例：长任务按 20%、短任务按 2 分钟、相等边界；
 *  - D1：预警在**到点之前**到达（一个轮询周期内，含 remainingMs 与新预估位）；
 *  - O-4d：**extendMs 后重新武装可再触发**（推移上限后为新截止点再预警一次）；
 *  - **watchdog 自身无延期能力**：预警是提示不是拦截，不推移上限，到点仍按
 *    exhausted 走 L4 结算兜底（§5.3「预警是提示，不是拦截」）。
 *
 * 现状（v2.1.7，红灯原因）：createProgressWatchdog（src/watchdog.ts:121）只有
 * onProgress，无 onApproachingDeadline 回调、无 extend 接口——预警类断言全部
 * 待实现/失败；「自身无延期能力」的 exhausted 兜底断言现状即绿（防御钉）。
 *
 * 计时口径：一律注入可控时钟（createProgressWatchdog 的 `now` 形参）+ 瞬移逻辑
 * 时间，真实等待仅 ~40ms/步（pollMs=10 的轮询节奏），无任何真实长睡眠，可重复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createProgressWatchdog } from '../src/watchdog.js'

/** 预警窗 = max(20%, 2 分钟)（取大者）。2 分钟 = 120000ms。 */
const WARN_FLOOR_MS = 120_000
function warnWindow(hardMs: number) {
  return Math.max(hardMs * 0.2, WARN_FLOOR_MS)
}

function harness(hardMs: number) {
  const startedAt = 1_000_000_000
  let fakeNow = startedAt
  const warnings: Array<{ remainingMs: number }> = []
  const input: any = {
    getSeq: () => undefined,
    idleMs: 3_600_000,
    hardMs,
    pollMs: 10,
    makeError: (reason: string) => Object.assign(new Error(`watchdog:${reason}`), { reason }),
    onApproachingDeadline: (info: any) => warnings.push(info),
    now: () => fakeNow,
  }
  const watchdog = createProgressWatchdog(input)
  return {
    watchdog,
    warnings,
    setElapsed(ms: number) {
      fakeNow = startedAt + ms
    },
    /** 等 2~4 个真实轮询（pollMs=10），让下一次 poll 读到新逻辑时间。 */
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 40))
    },
    stop() {
      watchdog.stop()
    },
  }
}

test('长任务按 20%：hardMs=3600000，恰好在剩余 720000ms 边界幂等触发一次', async () => {
  const h = harness(3_600_000)
  try {
    const window = warnWindow(3_600_000)
    assert.equal(window, 720_000, 'max(20%, 2 分钟) 取大者：3600000×20%=720000 > 120000')
    h.setElapsed(3_600_000 - window - 60_000) // 剩余 780000ms，窗之外
    await h.settle()
    assert.equal(h.warnings.length, 0, '尚未进入预警窗不得预警')
    h.setElapsed(3_600_000 - window) // 剩余恰好 720000ms
    await h.settle()
    assert.equal(h.warnings.length, 1, '待实现（O-4b/D1）：剩余 ≤ max(20%, 2 分钟) 时 onApproachingDeadline 必须触发（恰好边界含等号）')
    assert.equal(
      h.warnings[0]?.remainingMs,
      720_000,
      'D1：预警回调带 remainingMs（剩余 720000ms），供主 Agent 核对',
    )
    h.setElapsed(3_600_000 - window / 2) // 深入窗内
    await h.settle()
    assert.equal(h.warnings.length, 1, 'O-4b：一个尝试只预警一次（幂等）')
  } finally {
    h.stop()
  }
})

test('短任务按 2 分钟：hardMs=300000，恰好在剩余 120000ms 边界幂等触发一次', async () => {
  const h = harness(300_000)
  try {
    const window = warnWindow(300_000)
    assert.equal(window, 120_000, 'max(20%, 2 分钟) 取大者：300000×20%=60000 < 120000，按 2 分钟')
    h.setElapsed(300_000 - window - 60_000) // 剩余 180000ms，窗之外
    await h.settle()
    assert.equal(h.warnings.length, 0, '尚未进入预警窗不得预警')
    h.setElapsed(300_000 - window) // 剩余恰好 120000ms
    await h.settle()
    assert.equal(h.warnings.length, 1, '待实现（O-4b/D1）：剩余 ≤ max(20%, 2 分钟) 时必须触发（短任务按 2 分钟）')
    assert.equal(h.warnings[0]?.remainingMs, 120_000, 'D1：预警带 remainingMs=120000ms')
    h.setElapsed(240_000)
    await h.settle()
    assert.equal(h.warnings.length, 1, 'O-4b：幂等，不重复预警')
  } finally {
    h.stop()
  }
})

test('相等边界：hardMs=600000，20% 恰等于 2 分钟，仍只触发一次', async () => {
  const h = harness(600_000)
  try {
    const window = warnWindow(600_000)
    assert.equal(window, 120_000, '600000×20% = 120000 = 2 分钟，max() 相等边界')
    h.setElapsed(600_000 - window - 60_000) // 剩余 180000ms
    await h.settle()
    assert.equal(h.warnings.length, 0, '尚未进入预警窗不得预警')
    h.setElapsed(600_000 - window) // 剩余恰好 120000ms，两规则相等
    await h.settle()
    assert.equal(h.warnings.length, 1, '待实现（O-4b）：相等边界必须触发且只触发一次（取大者相等不双发）')
    assert.equal(h.warnings[0]?.remainingMs, 120_000, 'D1：remainingMs=120000ms')
  } finally {
    h.stop()
  }
})

test('O-4d：extendMs 推移上限后重新武装，可再触发一次', async () => {
  const h = harness(300_000)
  try {
    h.setElapsed(180_000) // 剩余 120000ms = 窗口，第 1 次
    await h.settle()
    assert.equal(h.warnings.length, 1, '第 1 次预警（原截止点）')
    const extend = (h.watchdog as any).extend
    assert.equal(
      typeof extend,
      'function',
      '待实现（O-4d/2.6 表 #9）：ProgressWatchdog 需提供 extend(newHardMs)——推移绝对上限（自尝试起点计）并重新武装预警',
    )
    extend.call(h.watchdog, 600_000) // 新上限 600000ms：新窗口 max(120000, 120000)=120000
    h.setElapsed(300_000) // 新上限下剩余 300000ms，窗之外
    await h.settle()
    assert.equal(h.warnings.length, 1, '推移后未进入新预警窗不得重复预警')
    h.setElapsed(480_000) // 新上限下剩余恰好 120000ms
    await h.settle()
    assert.equal(h.warnings.length, 2, '待实现（O-4d）：extendMs 后重新武装，新截止点的预警窗应能再触发一次')
    h.setElapsed(520_000)
    await h.settle()
    assert.equal(h.warnings.length, 2, '重新武装后同样幂等：每个截止点只预警一次')
  } finally {
    h.stop()
  }
})

test('watchdog 自身无延期能力：预警不推移上限，到点仍按 exhausted 走兜底', async () => {
  const h = harness(300_000)
  h.setElapsed(180_000) // 触发预警
  await h.settle()
  assert.equal(h.warnings.length, 1, '预警已触发')
  h.setElapsed(300_001) // 越过绝对上限，期间没有任何 extendMs
  await h.settle()
  await assert.rejects(
    h.watchdog.fired,
    /exhausted/,
    '预警是提示不是拦截：watchdog 自身无延期能力，未被 extendMs 推移的上限到点必须照常触发兜底（L4 结算保证不失效）',
  )
  assert.equal(h.warnings.length, 1, '到点兜底不追加预警（一个尝试一次）')
})
