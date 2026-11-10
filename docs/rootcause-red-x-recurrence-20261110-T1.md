# 根因诊断报告：CI「红叉/cancelled 红字」为何多次复发（T1 · 2026-11-10）

> 仓库：`/Users/open/Documents/Stocks/plugins/dsh-workplan`（HEAD `3aed805`，v2.2.8）
> 基线锚定：`src/runtime.ts` sha256 `173944207a4fc35f…1f0a`（8492 行）；本报告所有行号以此为准。
> 诊断人：T1（资深 SRE · Node.js 事件循环与 CI 诊断）

## 0. 执行摘要（一段话）

「红字/红叉」= CI（GitHub Actions，node 22）上 `node --test` 把等待中的用例判为 `cancelledByParent` → exit 1 → 提交状态红叉；本地 node 26 因 test runner 自带存活句柄而假绿。**它复发 4 次（1.5.0 起每次 push、2.1.2 版本漂移另一类、2.2.6、2.2.7）的根本原因不是某一行代码，而是三条结构性诱因叠加**：①生产代码把「必须触发才能收束的 deadline 计时器」与「卫生性计时器」一律 `unref()`，在裸事件循环下进程排空即死；②第一次修复（`9f0de34`）选择在**测试侧加锚**治标，未动生产模式，锚覆盖靠手工、新文件即漏；③本地 node 26 与 CI node 22 的 runner 句柄行为差异让问题只在 CI 显形，显形滞后于引入。2.2.8 只修了 1 处（attempt 上限计时器），**当前 src/ 仍有 9 处同类 unref，且 9 个触及这些路径的测试文件全部无锚**——同类竞态的复发面依然存在。

## 1. 「红字」的确切所指

- CI 日志红字：`# cancelled 3`（node:test 汇总行）+ exit code 1 → GitHub 提交状态红叉。
- 机理（`9f0de34` 提交信息原文，逐字）：
  > "Node 22 then cancels a pending test as soon as the loop drains with no ref'd handle left, which is why verify has been red on every push since 1.5.0 while the suite passed on Node 26."
- 同机理在 2.2.8 修复注释中再次确认（`src/runtime.ts:2727-2731`）：unref 时裸事件循环进程（node:test / CI node22）在等待竞态期间排空退出，用例被 `cancelledByParent` → exit 1 → 红叉；本地 node26 因 runner 自带句柄"竞态获胜"而假绿。

## 2. 历史复发时间线（git 实证，`git log --all --date=short`）

| # | 时间 | 提交 | 事件 | 修复方式 | 是否治本 |
|---|---|---|---|---|---|
| 1 | 2026-10-28→29 | `98989d9`(1.4.3)→`9f0de34` | **自 1.5.0 起每次 push CI verify 全红**（node 22 cancelled），本地 node 26 全绿 | 测试侧加 `eventLoopAnchor`（ref'd setInterval + after 钩子清理），仅覆盖当时受影响的少数文件 | ❌ 治标：生产 unref 模式原样保留 |
| 2 | 2026-11-06 | `c2ec7b2` | 另一类红叉：2.1.2 漏同步 6 处版本号 → version-sync 门禁红 | 补齐 6 处版本号 | ✅（该类）；说明「红叉」有独立第二成因类 |
| 3 | 2026-11-09→10 | 2.2.6（`f1e3f7b`）| CI 再现 cancelled 红叉（3 条用例 `cancelledByParent`，`pass 663/fail 0/cancelled 3`） | `dc39eeb`(2.2.7) 宣称"cancelled 之源消除（699/699, cancelled 0）"——**本地 node 26 验证** | ❌ 本地假绿再次骗过验证 |
| 4 | 2026-11-10 | `dc39eeb`(2.2.7) 提交本身在远端 CI 仍红 | attempt 上限计时器仍带 `unref` → 远端 node 22 复现同类排空 | `70c89f2`(2.2.8) 删除该行 unref + 注释禁令；远端 CI `completed success` | ⚠️ 单点治本；同类 9 处未动 |

**复发计数：事件循环排空类 3 次（#1、#3、#4），版本漂移类 1 次（#2）。**

## 3. 为什么多次发生：根因 + 触发条件矩阵（A1）

### 结构性根因（3 条）

- **RC-1 句柄策略二元冲突（主根因）**：插件运行在 DSH 宿主内，`unref()` 是刻意卫生设计（宿主关闭时不被插件计时器拖住，`9f0de34` 提交信息："unref'd on purpose so a shutting down host is not held open"）。但**收束语义计时器**（attempt 上限、round 总预算、ack deadline、auto-resume 延迟、watchdog）必须真实触发才能让子任务/轮次到达终态。在"进程内只有这些计时器在等"的裸事件循环窗口（node:test、headless、宿主排空瞬间），unref = 允许进程在收束前排空退出 → cancelled/静默死亡。**"不拖住宿主"与"保证收束"在同一句柄上互斥，代码未做分类，一律选了前者。**
- **RC-2 修复层次错位**：#1 的修复把锚加在**测试文件**（每文件手工一份），不是运行时或全局 setup。锚覆盖 = 手工枚举，任何新增/改动的触及计时器路径的测试文件默认无保护。实证：当前 12/97 个测试文件有锚，而 **9 个触及 unref 计时器路径的测试文件（§4.2）与 12 个有锚文件的交集为空**——最需要保护的文件恰好全部裸奔，目前靠"测试自身 await 的 promise 恰好持有句柄"侥幸不触发。
- **RC-3 验证环境与故障环境不一致**：故障只在 node 22（CI）显形；开发/验证在 node 26（本地，实测 `node -v` = v26.9.0）。node 26 的 test runner 自带存活句柄使排空竞态"获胜"→ 本地 699/699 全绿被当成修复证据（2.2.7 即如此误判），远端才暴露。**本地全绿对这类缺陷零检出能力。**

### 触发条件矩阵

| 条件 | 取值 | 说明 |
|---|---|---|
| 进程类型 | 裸事件循环（node:test / headless / 宿主排空瞬间） | 宿主常驻时 HTTP server 等 ref'd 句柄掩盖问题 |
| Node 版本 | 22（触发）vs 26（掩盖） | node:test 对 loop drain 的取消语义差异 |
| 等待窗口 | 所有存活句柄均 unref 的时刻 | 例：attempt 计时器被 clear 后仅剩 auto-resume 延迟计时器的窗口 |
| 计时器类别 | 收束类（必须触发）受致命影响；卫生类（notice/poll）仅丢通知 | 见 §4 分类 |

## 4. 当前代码全部风险点清单（A2/A3）

扫描命令：`grep -rn 'unref\|\.ref()' src/`、`grep -n 'setTimeout\|setInterval' src/*.ts`（全覆盖 `src/runtime.ts` 18 处、`src/client.ts` 3 处、`src/watchdog.ts` 2 处计时器点位，无遗漏）。

### 4.1 生产代码：9 处存活 unref（2.2.8 修复后仍在）

分类口径：**收束类** = 不触发则子任务/轮次无法到达终态（危险）；**卫生类** = 不触发只丢一条通知/轮询（低危）。

| # | 位置 | 计时器 | 类别 | 触发条件 | 影响 | 优先级 |
|---|---|---|---|---|---|---|
| R1 | `src/runtime.ts:3115` | `totalTimer` 轮次总预算 → abort TOTAL_TIMEOUT | **收束** | 裸循环下整轮仅剩此计时器（与已修的 attempt 计时器同构！） | 轮次不收束为 TOTAL_TIMEOUT，进程排空 → cancelled/静默死 | **P0** |
| R2 | `src/runtime.ts:2173` | `deadlineTimer` 180s no-ack 判定 → blocked+abort | **收束** | 派发后子会话未启动、无其他 ref'd 句柄 | no-ack 永不判定，行悬死 | **P0** |
| R3 | `src/runtime.ts:5678` | auto-resume 延迟计时器 | **收束** | 轮次结束→续跑窗口内进程无其他句柄 | 自动续跑永不发生，计划静默停摆 | **P0** |
| R4 | `src/watchdog.ts:265` | watchdog 轮询 interval（idle/hard 超时判定） | **收束** | 子会话执行期间宿主句柄排空 | 超时看门狗失效，卡死子任务无人收束 | **P0** |
| R5 | `src/runtime.ts:6334` | 指示 ack deadline → blocked no-ack | **收束** | instruct 后窗口内裸循环 | 指示无回执永不判 blocked | P1 |
| R6 | `src/runtime.ts:1201` | dispose 超时 reject（Promise.race 臂） | **收束**（弱） | dispose 挂起且无其他句柄 | race 永不 settle，进程直接退出而非报错 | P1 |
| R7 | `src/runtime.ts:2140` | ack notice（ackOverdue 标记） | 卫生 | 同上 | 丢一次"已下发未响应"提示 | P2 |
| R8 | `src/runtime.ts:6301/6311` | 指示 poll interval + notice | 卫生 | 同上 | 丢确认轮询/提示（deadline R5 兜底） | P2 |
| R9 | `src/runtime.ts:6282` 关联 `6301` | （同 R8 poll） | 卫生 | 同上 | 同 R8 | P2 |

**ref'd（安全）点位备查**：`runtime.ts:729`（sleepAbortable）、`889/891`（runPlanner progress/hard，planner 收束依赖，现为 ref——正确）、`2726`（attempt 上限，2.2.8 已修，带禁令注释）；`client.ts:1580/3077/3079` 为浏览器 UI 计时器，不在 node 事件循环风险面内。

### 4.2 测试代码：暴露面（RC-2 实证）

- 有 `eventLoopAnchor` 的文件：**12/97**（planner-*、time-*、workplan-auto-retry/budget-*/dispatch-modes/status-lock/stuck-recovery）。
- 触及 unref 计时器路径（grep `ackOverdue|no-ack|autoResume|TOTAL_TIMEOUT|instructionOverdue|startWatchdog|dispose timeout|ASSIGN_ACK`）的文件：`auto-resume-policy`、`interrupt-announce`、`workplan-closure-ack-escalation`、`workplan-closure-n1-n5`、`workplan-comm-format-e2e`、`workplan-followup-tool`、`workplan-monotonicity`、`workplan-retry-feedback`、`workplan-unparsable-retry` —— **9 个全部无锚（交集=∅）**。
- 风险：这些文件当前通过是因为测试自身 await 的 promise/桩件恰好持有句柄；任何桩件时序调整（如改用真计时器、加长等待）都会复现 #3/#4 型红叉。触发条件：node 22 + 等待窗口内句柄全 unref。建议：全局 setup 锚（见 §6 P-2）后此类风险整体消除。优先级 **P1**。

### 4.3 CI 环境因素（假红/假绿其他来源）

- `.github/workflows/verify.yml`：node-version **22** 固定单版本；`npm run verify` = check+test；另有 `git diff --exit-code -- lib client.js` 构建产物新鲜度门禁（漏 build 即红——第二类"非事件循环"红叉源，与 #2 版本漂移同类：门禁红 ≠ 逻辑错，需看红叉的具体 job/step 名分诊）。
- 本地 v26.9.0 与 CI 22 无矩阵交集 → RC-3 持续存在。建议 CI 增加 26 矩阵或本地验证强制 `node 22` 跑一遍（§6 P-4）。

## 5. 本地 vs CI 环境差异完整影响面（A1 支撑）

| 维度 | 本地（node 26.9.0） | CI（node 22） | 影响 |
|---|---|---|---|
| node:test loop-drain 语义 | runner 自带存活句柄，排空竞态获胜 | 排空即 cancel pending 用例，exit 1 | 同类缺陷本地 0 检出（#3 误判"cancelled 0"即此） |
| 验证结论效力 | 699/699 全绿 ≠ 修复 | 唯一真实判据 | 2.2.7 的"之源消除"宣称被远端证伪 |
| 构建门禁 | 手工 build 通常新鲜 | `git diff --exit-code` 强制 | 漏提交 lib/ 即红（历史 #2 类） |

## 6. 防回归建议（交 T2 实施，按优先级）

- **P-1（P0）收束计时器去 unref 分类改造**：R1–R6 六处收束类计时器删除 `unref()`（与 2.2.8 attempt 修法一致：ref 持有 + 收束路径 `finally clearTimeout`，不会悬挂宿主）；R7–R9 卫生类保留 unref 并加注释声明类别。**验收：`grep -c 'unref' src/runtime.ts src/watchdog.ts` 只剩卫生类白名单点位。**
- **P-2（P0）测试全局锚取代手工锚**：新增单一 `tests/setup-event-loop-anchor.ts`（或 `node --test --import` 全局 setup），持一个 ref'd interval + 全局 after 清理；删除 12 份手工锚防漂移。任何新测试文件自动获得保护，消除 RC-2。
- **P-3（P1）静态守卫测试**：仿 `tests/version-sync.test.ts` 门禁模式，新增 `handle-policy.test.ts`：解析 src/ 全部 `setTimeout/setInterval` 点位，断言"收束类白名单内禁止出现 unref、白名单外必须 unref"，把 §4.1 分类固化为可执行契约。任何未来新增计时器未分类即红。
- **P-4（P1）CI 断言与环境对齐**：test 脚本输出显式断言 `cancelled === 0`（当前 exit 1 间接体现，但汇总行断言可区分"fail"与"cancelled"两类红）；CI 增加 node 26 矩阵或 RELEASING 增加"发布前 node 22 本地复跑"硬步骤，消除 RC-3。
- **P-5（P2）文档固化**：把"收束 vs 卫生"句柄分类写进 RELEASING/贡献指南，附本报告 §3 矩阵。

## 7. 证据索引（全部可复跑）

1. 时间线：`git log --all --format='%h %ad %s' --date=short -i --grep='unref' --grep='cancel' --grep='红叉' --grep='alive'`（§2 各行）。
2. 机理原文：`git show 9f0de34`（提交信息 + eventLoopAnchor diff）；`sed -n '2715,2745p' src/runtime.ts`（2.2.8 禁令注释）。
3. unref 全量扫描：`grep -rn 'unref\|\.ref()' src/` → runtime.ts 1201/2140/2173/3115/5678/6301/6311/6334 + watchdog.ts:265（9 处）+ 2727 注释行。
4. 计时器全量点位：`grep -n 'setTimeout\|setInterval' src/runtime.ts src/client.ts src/watchdog.ts`（runtime 18、client 3、watchdog 2）。
5. 锚覆盖：`grep -ln 'eventLoopAnchor' tests/*.ts` = 12；`ls tests/*.ts | wc -l` = 97；路径触及 `grep -ln 'ackOverdue|no-ack|autoResume|TOTAL_TIMEOUT|instructionOverdue|startWatchdog|dispose timeout|ASSIGN_ACK' tests/*.ts` = 9（交集空）。
6. CI 配置：`.github/workflows/verify.yml`（node 22、verify、lib 新鲜度门禁）；`package.json:71-72`（test/verify 脚本）；本地 `node -v` = v26.9.0。
7. 第二类红叉：`git show c2ec7b2 --stat`（版本漂移 6 处）；`tests/version-sync.test.ts` 存在。
8. 基线：`git rev-parse HEAD` = `3aed805…`；`shasum -a 256 src/runtime.ts` = `173944207a4f…`。

## 8. 边界与未验证项（如实声明）

- 本轮截图原件未直接读取（子任务输入注明"待确认"）；「红字=cancelledByParent 汇总行/提交红叉」的判定基于会话上下文中主 Agent 已实证的 2.2.6/2.2.7 红叉记录（`pass 663/fail 0/cancelled 3`）与用户追问脉络，与全部 git 证据自洽。若截图另指其他红字，§4.3 提供了分诊入口（看 job/step 名），报告主体结论不受影响。
- node 22 与 26 的 node:test 句柄差异细节引自本仓库两处一手记录（9f0de34 提交信息、runtime.ts:2727 注释）与远端 CI 实测结果，未另行查 Node 官方 changelog 逐版本比对（20 分钟全链时限内的取舍）。
- R4（watchdog）在宿主常驻场景实际由宿主句柄兜底，其 P0 定级针对裸循环/headless 场景；宿主是否在所有版本都持有 ref'd 句柄未逐一验证。
