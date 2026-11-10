import assert from 'node:assert/strict'
import test from 'node:test'

/*
 * [2.2.9][P-2] 全局事件循环锚的注入自检（治本 T1 报告 RC-2「修复层次错位」+ RC-3「验证环境
 * 与故障环境不一致」）。
 *
 * 锚由 scripts/run-tests.mjs 以 `--import tests/setup-event-loop-anchor.js` 注入每个测试子进程：
 * 只要锚在，测试子进程内永远存在一个 ref'd 句柄，「loop 排空 → node 22 把等待中用例判
 * cancelledByParent」的竞态在任何 node 版本上都结构性不可触发——不再依赖 runner 自带句柄
 * 的版本差异（node 26 假绿的根源），也不再依赖每文件手工加锚（12/97 覆盖、新文件即漏）。
 *
 * 本测试若红：说明 --import 接线断了（脚本/路径/编译产物变更），保护整体失效，必须修复后才能信任
 * 任何一轮「本地全绿」的结论。
 */
test('[2.2.9][P-2] 全局事件循环锚已注入本测试子进程且为 ref 句柄', () => {
  const anchor = (globalThis as any).__DSH_WORKPLAN_EVENT_LOOP_ANCHOR__
  assert.ok(
    anchor,
    'tests/setup-event-loop-anchor 未经 --import 注入：裸事件循环（CI node 22）下 cancelledByParent 红叉保护失效'
    + '（T1 报告 RC-2/RC-3）。检查 package.json test 脚本与 scripts/run-tests.mjs。',
  )
  assert.equal(typeof anchor.hasRef, 'function', '锚应是 node 计时器句柄（Timeout）')
  assert.equal(anchor.hasRef(), true, '锚必须处于 ref 状态：unref 的锚无法阻止 loop 排空')
})
