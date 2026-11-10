/**
 * [2.2.9][P-2] 全局事件循环锚 —— 由 scripts/run-tests.mjs 以 `node --test --import` 加载，
 * 注入每一个测试子进程（治本 T1 报告 RC-2：旧修复为每文件手工加锚，覆盖 12/97、且与触及
 * unref 计时器路径的 9 个测试文件交集为空——最需要保护的文件恰好全部裸奔）。
 *
 * 机理：node 22 的 node:test 在「loop 排空且无 ref'd 句柄」时会把等待中的用例判为
 * cancelledByParent → exit 1 → CI 红叉；node 26 因 runner 自带句柄竞态获胜而假绿（RC-3）。
 * 本锚持有一个 ref'd setInterval：测试子进程内永远存在存活句柄，排空竞态在**任何 node 版本**
 * 上都结构性不可触发——不再依赖版本行为差异，也不再依赖手工枚举。
 *
 * 清理三层（探针实证，2026-11-10）：①正常路径 node:test after() 钩子——经 --import 加载的
 * 模块里注册的 after 会绑定到该子进程文件级根钩子，测试完即 clearInterval，子进程立即退出；
 * ②failsafe：10 分钟后强制放锚（unref'd，不阻碍退出），防钩子意外失效悬挂子进程；
 * ③锚体为 no-op interval，零业务副作用。
 *
 * tests/event-loop-anchor-global.test.ts 断言本模块注入成功且句柄为 ref 态；
 * 该测试红 = 接线断裂（脚本/路径/编译产物变更），保护整体失效，禁止信任当轮「全绿」结论。
 */
import { after } from 'node:test'

const anchor = setInterval(() => {}, 1_000)
const failsafe = setTimeout(() => clearInterval(anchor), 600_000)
failsafe.unref?.()
;(globalThis as any).__DSH_WORKPLAN_EVENT_LOOP_ANCHOR__ = anchor

try {
  after(() => clearInterval(anchor))
} catch {
  // 非测试上下文加载（理论上不发生：探针实证 runner 父进程不加载 --import 模块）：
  // after 不可用时由 failsafe 兜底放锚。
}
