import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/*
 * [2.2.9][P-3] handle-policy 静态守卫 —— T1 根因报告（docs/rootcause-red-x-recurrence-20261110-T1.md）
 * §4.1 计时器分类的可执行契约，治本 RC-1（句柄策略二元冲突）。
 *
 * 口径：
 *  - 收束类计时器（不触发则子任务/轮次无法到达终态：attempt 上限、轮次总预算、no-ack deadline、
 *    auto-resume、watchdog、dispose 超时）**禁止 unref**——node:test/裸事件循环下 unref = 允许进程
 *    在收束前排空退出 → cancelledByParent → CI 红叉（2.2.6/2.2.7 两次复发的根因族）。其生命周期
 *    由收束路径的 clearTimeout/clearInterval 管理，不会悬挂宿主（2.2.8 attempt 修法同款口径）。
 *  - 卫生类计时器（不触发只丢一条通知/轮询：noticeTimer、poll、notice）**必须保留 unref**——
 *    插件不得拖住正在关闭的 DSH 宿主（9f0de34 的原始卫生动机）。
 *
 * 任何未来新增计时器：默认不得 unref；确属卫生类必须显式加进本测试白名单并附分类理由，否则此测试红。
 * 这就是「未分类即红」的防回归门禁：把一次性诊断固化成持续契约。
 */
const SRC_DIR = path.resolve(process.cwd(), 'src')

/** 卫生类 unref 白名单：句柄名 → 出现次数（精确契约，多一处少一处都红）。 */
const HYGIENE_WHITELIST: Record<string, number> = {
  // runtime.ts 派发 ack 提示（T1 R7）
  noticeTimer: 1,
  // runtime.ts 指示回执轮询（T1 R8）
  poll: 1,
  // runtime.ts 指示未回执提示（T1 R9）
  notice: 1,
}

/** 历史事故点位黑名单：显式命名，回归时给出最直白的报错（与白名单检查互为双保险）。 */
const CONVERGENCE_FORBIDDEN = ['timer', 'totalTimer', 'deadlineTimer', 'deadline', 'attemptTimer']

function collectUnrefNames(file: string): string[] {
  const text = readFileSync(path.join(SRC_DIR, file), 'utf8')
  const names: string[] = []
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*unref/g)) names.push(m[1])
  return names
}

test('[2.2.9][P-3] handle-policy：src/ 全部 unref 点位 === 卫生类白名单（收束类禁止 unref）', () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts')).sort()
  assert.ok(files.includes('runtime.ts') && files.includes('watchdog.ts'), 'src/ 布局变化，本守卫需同步更新')

  const found = new Map<string, string[]>()
  for (const f of files) {
    const names = collectUnrefNames(f)
    if (names.length > 0) found.set(f, names)
  }

  // 1) 精确集合契约：只有 runtime.ts 的三处卫生类点位允许 unref。
  assert.deepEqual(
    Object.fromEntries([...found.entries()].map(([f, n]) => [f, n.sort()])),
    { 'runtime.ts': ['notice', 'noticeTimer', 'poll'] },
    'unref 点位与 handle-policy 契约不符：收束类计时器（必须触发才能到达终态）禁止 unref；'
    + '新增卫生类计时器必须显式加入 tests/handle-policy.test.ts 白名单并附分类理由。'
    + '背景见 docs/rootcause-red-x-recurrence-20261110-T1.md §3/§4.1。',
  )

  // 2) 黑名单显式核查：历史事故句柄名永不回归（报错信息直指事故族）。
  for (const [f, names] of found) {
    for (const n of names) {
      assert.ok(
        !CONVERGENCE_FORBIDDEN.includes(n),
        `${f}: 收束类计时器「${n}」不得 unref（CI cancelled 红叉根因族，T1 报告 R1-R6）`,
      )
    }
  }

  // 3) 白名单计数核查：卫生类 unref 被误删也会红（反向回归：插件拖住关闭中的宿主）。
  for (const [name, count] of Object.entries(HYGIENE_WHITELIST)) {
    const actual = (found.get('runtime.ts') ?? []).filter((n) => n === name).length
    assert.equal(actual, count, `卫生类计时器「${name}」应保留 unref ${count} 处（实际 ${actual}）：删掉会拖住关闭中的宿主`)
  }
})

test('[2.2.9][P-3] handle-policy：watchdog 收束 interval 不得回归 unref（T1 R4）', () => {
  const text = readFileSync(path.join(SRC_DIR, 'watchdog.ts'), 'utf8')
  assert.ok(!/\.unref/.test(text), 'watchdog.ts 出现 unref：看门狗是卡死子任务的最后收束保证，必须保持 ref 句柄')
  assert.ok(/setInterval\(poll, pollMs\)/.test(text), 'watchdog 轮询结构变化，本守卫需同步复核')
})
