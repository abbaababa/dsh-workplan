// [2.2.9][T2] 裸事件循环探针：进程内唯一等待物 = watchdog 收束 interval（T1 R4）。
// 修复后（ref 态）：进程必须存活到 hard 超时触发（~400ms）后才排空退出；
// 回归（unref）时：loop 立即排空、进程 ~0ms 退出、收束永不发生 —— 与 CI node22 cancelled 同机理。
const t0 = Date.now()
const { createProgressWatchdog } = require('../lib/watchdog.js')
const wd = createProgressWatchdog({
  getSeq: () => 1, idleMs: 60000, hardMs: 400, pollMs: 50,
  makeError: (reason) => new Error('probe:' + reason),
})
if (wd && wd.fired && typeof wd.fired.catch === 'function') wd.fired.catch(() => {})
process.on('exit', () => {
  const elapsed = Date.now() - t0
  const verdict = elapsed >= 350 ? 'PASS(收束计时器为 ref 态，loop 存活至触发)' : 'FAIL(loop 提前排空=unref 回归)'
  console.log(`BARE_LOOP_PROBE elapsed=${elapsed}ms ${verdict}`)
})
