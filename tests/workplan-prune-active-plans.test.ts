/*
 * [3.0.6][复审修复] prune 接入增强的两条契约：
 *
 *  A) 活跃计划保护名单：apply 里调 pruneJournal 时必须把当前活跃 planId
 *     集合（state.records 里的记录）经 excludePlanIds 传进去——「活跃但
 *     安静」的计划（久无新消息、mtime 变旧）不得被保留策略误删。
 *     activePlanIdSet 单测直接钉收集规则（planId 字段优先，空串回退
 *     plan.planId，非法条目跳过，异常时宁可少排除）。
 *
 *  B) 首次 prune 不得占用激活同步路径：apply 注册时只挂一个 10 秒后触发
 *     的 setTimeout（卸载时经 ctx.effect 清理，与 24h 周期计时器同款）。
 *     钉住：注册完成时旧文件原样还在（没有当场扫盘）；10s 回调真跑
 *     prune（旧文件被删、在册计划文件被 excludePlanIds 保住）；cleanup
 *     调 clearTimeout（卸载后不得再触发）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { activePlanIdSet, apply } from '../src/host.js'
import { createStatuses } from '../src/plan.js'

const DAY = 24 * 60 * 60 * 1000

function withJournalDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-journal-'))
  const previous = process.env.DSH_WORKPLAN_JOURNAL_DIR
  process.env.DSH_WORKPLAN_JOURNAL_DIR = dir
  try {
    return run(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_JOURNAL_DIR
    else process.env.DSH_WORKPLAN_JOURNAL_DIR = previous
  }
}

function makeFile(dir: string, name: string, ageDays: number) {
  const path = join(dir, name)
  writeFileSync(path, '{"kind":"dispatch"}\n')
  const at = new Date(Date.now() - ageDays * DAY)
  utimesSync(path, at, at)
  return path
}

test('activePlanIdSet：planId 优先、空串回退 plan.planId、垃圾记录跳过', () => {
  const records = new Map<string, any>([
    ['s1', { planId: 'wp-a' }],
    ['s2', { plan: { planId: 'wp-b' } }],
    ['s3', { planId: '', plan: { planId: 'wp-c' } }],
    ['s4', { planId: '   ' }],
    ['s5', null],
    ['s6', { planId: 42 }],
  ])
  const set = activePlanIdSet({ state: { records } } as any)
  assert.deepEqual([...set].sort(), ['wp-a', 'wp-b', 'wp-c'])
})

test('activePlanIdSet：state/records 不可用时宁可少排除（返回空集而不是抛）', () => {
  assert.deepEqual([...activePlanIdSet(undefined as any)], [])
  assert.deepEqual([...activePlanIdSet({} as any)], [])
  assert.deepEqual([...activePlanIdSet({ state: {} } as any)], [])
})

test('apply：首次 prune 延迟 10s、真删旧文件、活跃计划被 excludePlanIds 保住、cleanup 清定时器', () => {
  withJournalDir((dir) => {
    const activePlanId = 'wp-prune-active'
    const staleFile = makeFile(dir, 'wp-prune-stale.jsonl', 60)
    const activeFile = makeFile(dir, `${activePlanId}.jsonl`, 60) // 活跃但安静：mtime 也旧

    // 捕获 setTimeout 调度（fake timer 永不自己触发）。
    const scheduled: Array<{ fn: () => void; delay: number; timer: any }> = []
    const cleared: any[] = []
    const RealSetTimeout = globalThis.setTimeout
    const RealClearTimeout = globalThis.clearTimeout
    let timerSeq = 0
    ;(globalThis as any).setTimeout = (fn: any, delay: any, ...rest: any[]) => {
      const timer = { id: ++timerSeq }
      scheduled.push({ fn, delay: Number(delay), timer })
      return timer
    }
    ;(globalThis as any).clearTimeout = (timer: any) => { cleared.push(timer) }
    try {
      const cleanups: Array<() => void> = []
      const ctx: any = {
        logger: { warn() {}, info() {}, error() {} },
        effect(fn: any) {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        },
        tools: {
          register() { return () => {} },
          guard() { return () => {} },
        },
        on() { return () => {} },
        inject(_deps: any, _cb: any) { return () => {} },
        systemPrompt: { section() { return () => {} } },
      }
      const runtime: any = apply(ctx, {
        journalRetentionDays: 30,
        cwd: '/work',
        totalTimeoutMs: 60_000,
      })

      // 把「活跃但安静」的计划登记进 records（apply 返回 runtime）。
      const plan: any = {
        planId: activePlanId,
        sessionId: 'session-prune',
        createdTurn: 1,
        createdAt: 1000,
        title: 'prune 保护名单',
        stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }] }],
      }
      runtime.state.records.set('session-prune', {
        plan,
        planId: activePlanId,
        statuses: createStatuses(plan),
        phase: 'pending',
        errors: [],
        createdAt: 1000,
        updatedAt: Date.now(),
      })

      const firstPrune = scheduled.find((entry) => entry.delay === 10_000)
      assert.ok(firstPrune, '首次 prune 必须经 setTimeout(…, 10_000) 调度（离开激活同步路径）')
      assert.ok(existsSync(staleFile), '注册完成时不得当场扫盘：旧文件必须还在')

      // 触发 10s 回调：真跑 prune。
      firstPrune.fn()
      assert.equal(existsSync(staleFile), false, '回调触发后超期且不在册的旧 journal 必须被删')
      assert.ok(existsSync(activeFile), '活跃但安静的计划文件必须被 excludePlanIds 保住')

      // 卸载清理：cleanup 必须清掉这个定时器。
      for (const cleanup of cleanups) cleanup()
      assert.ok(cleared.includes(firstPrune.timer), 'cleanup 必须 clearTimeout 首次 prune 定时器')
      assert.deepEqual(
        readdirSync(dir).sort(),
        [`${activePlanId}.jsonl`],
        '最终目录里只应剩活跃计划的 journal',
      )
    } finally {
      globalThis.setTimeout = RealSetTimeout
      globalThis.clearTimeout = RealClearTimeout
    }
  })
})

test('apply：未开启保留策略（默认 0）时不挂任何 prune 定时器', () => {
  const scheduled: number[] = []
  const RealSetTimeout = globalThis.setTimeout
  const RealSetInterval = globalThis.setInterval
  ;(globalThis as any).setTimeout = (fn: any, delay: any) => { scheduled.push(Number(delay)); return RealSetTimeout(fn, delay) }
  ;(globalThis as any).setInterval = (fn: any, delay: any) => scheduled.push(Number(delay))
  try {
    const ctx: any = {
      logger: { warn() {}, info() {}, error() {} },
      effect() {},
      tools: { register() {}, guard() {} },
      on() { return () => {} },
      inject() {},
      systemPrompt: { section() {} },
    }
    apply(ctx, { cwd: '/work', totalTimeoutMs: 60_000 })
    assert.equal(scheduled.filter((delay) => delay === 10_000).length, 0, '默认永久保留：不得挂首次 prune')
    assert.equal(scheduled.filter((delay) => delay === 24 * 60 * 60 * 1000).length, 0, '默认永久保留：不得挂 24h 周期 prune')
  } finally {
    globalThis.setTimeout = RealSetTimeout
    globalThis.setInterval = RealSetInterval
  }
})
