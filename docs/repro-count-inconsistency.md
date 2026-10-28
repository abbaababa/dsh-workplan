# 最小复现：聚合计数与实时状态不一致（T2）

- 适用版本：`dsh-workplan@1.4.2`（缺陷构建）
- 复现脚本：[`scripts/repro-inconsistent-counts.ts`](../scripts/repro-inconsistent-counts.ts)
- 缺陷清单：[`docs/defect-report-count-inconsistency.md`](defect-report-count-inconsistency.md)
- 记录时间：2026-10-28
- 结论：**可稳定复现**。脚本以当前 `lib/runtime.js`、`lib/plan.js`、`client.js` 为唯一被测对象，不 mock 被测逻辑；同一份下发的 JSON 里，`stats` 与 `statuses`/`departments` 可以同时给出互相矛盾的事实，且这些事实会同时渲染到同一个页面。

---

## 1. 复现前提

| 项目 | 实测值 |
| --- | --- |
| 操作系统 | macOS（Darwin），本轮实测机型 `<your-mac-hostname>` |
| Node | `v26.9.0`（`/opt/homebrew/Cellar/node/26.9.0/bin/node`） |
| 插件根目录 | `<repo>` |
| 被测构建 | `lib/runtime.js`、`lib/plan.js`、`client.js`（均未改动，见第 8 节哈希） |
| 服务状态 | 宿主已运行 `dsh --profile web --host 127.0.0.1 --port 3080`（PID 2511），**本复现不依赖它，也不重启它** |

**为什么不用真实 HTTP 接口**：实测 `GET http://127.0.0.1:3080/dsh-workplan/plans` 返回 `HTTP/1.1 401 Unauthorized` 与 `{"ok":false,"error":"未授权的请求"}`。该路由要求浏览器同源会话凭证，命令行无法提供。因此脚本直接调用 `runtime.plansPayload(sessionId)`——它与该路由使用的是**同一个序列化函数**，输出就是 UI 轮询拿到的 JSON 结构。UI 证据则用 `client.js` 的真实工厂函数在 React 桩上渲染成 HTML 字符串，读取的是与浏览器相同的组件代码。

这不是“模拟 bug”，而是绕开鉴权，调用产生该 JSON 的真实函数。

---

## 2. 一键复现（照做即可）

### 2.1 带注释版

```bash
# 1) 进入唯一的插件权威目录（改其他目录不会生效）
cd <repo>

# 2) 用当前构建跑复现：预期 exit 0（exit 0 = 四类缺陷全部被复现）
node scripts/repro-inconsistent-counts.ts

# 3) 可选：确认同一脚本在修复后能作为验收探针
#    当前缺陷构建下预期 exit 1；9 条不变量断言中 8 条 [FAIL]（departments 一致这条本就 PASS）
node scripts/repro-inconsistent-counts.ts --expect-fixed

# 4) 可选：单独做严格类型检查（脚本不在任何 tsconfig 的 include 内）
npx tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --types node --skipLibCheck \
  --allowJs --checkJs false scripts/repro-inconsistent-counts.ts
```

### 2.2 无注释、可直接复制版

```bash
cd <repo>
node scripts/repro-inconsistent-counts.ts
node scripts/repro-inconsistent-counts.ts --expect-fixed
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck --allowJs --checkJs false scripts/repro-inconsistent-counts.ts
```

预期耗时约 3–6 秒（场景 B 的预算暂停需要等计时器触发）。

---

## 3. 预期输出（当前缺陷构建，实测原文节选）

```text
=== Observed payloads ===
A stats      : {"total":3,"done":1,"blocked":0,"inProgress":0,"pending":2,"progress":33}
A actual     : {"done":2,"blocked":0,"inProgress":1,"pending":0} progress 70
A statuses   : T1:done:100, T2:done:100, T3:in_progress:10
A departments: [{"id":"engineering","total":1,"done":1,"blocked":0,"inProgress":0},{"id":"qa","total":1,"done":1,"blocked":0,"inProgress":0},{"id":"design","total":1,"done":0,"blocked":0,"inProgress":1}]

=== Observed UI (top bar / card / stage / pills) ===
A top done/doing: 1 / 0
A card meta     : {"progress":33,"inProgress":0,"pending":2}
A donut         : 33
B top done/doing: 0 / 0
B card meta     : {"progress":100,"inProgress":0,"pending":1}
B donut         : 0
C top blocked   : 2 doing 0
C card meta     : {"progress":0,"inProgress":0,"pending":0}

=== Reproduction assertions (buggy build) ===
[PASS] A: frozen stats say 0 doing / 2 pending — {...}
[PASS] A: actual state is 1 doing / 0 pending, one more done — {...}
[PASS] A: same payload contradicts itself (stats.done=1, qa.done=1) — [...]
[PASS] A: same payload contradicts itself (stats.inProgress=0, design.inProgress=1) — [...]
[PASS] A: UI top bar shows 1 done / 0 doing — 1/0
[PASS] A: UI card says 0 正在做 · 2 还没开始 — {...}
[PASS] A: UI renders a done T2 and an in-progress T3 — stage/subtask pills read statuses
[PASS] A: UI donut shows the frozen 33% — 33
[PASS] B: pending keeps progress=100 — {...}
[PASS] B: pause payload says 100% with 0 done — {...}
[PASS] B: UI says 总体进度 100% while the donut says 0% / 0 done — ...
[PASS] C: resume keeps stale blocked=2 while none is blocked — 2/0
[PASS] C: UI shows 2 卡住了 while T1 is 正在做 — blocked=2
[PASS] C: UI card says 0 正在做 · 0 还没开始 while T1 runs and T2 is pending — {...}

All four defects reproduced (stats freeze, payload split-brain, budget invariant breach, stale resume counts).
```

> 注：上面 `{...}` 只是本文档为控制篇幅做的省略；脚本运行时打印完整 JSON。以实际输出为准。

判定标准：

- 进程 exit code 为 `0`；
- 14 条断言全部为 `[PASS]`；
- 末行为 `All four defects reproduced (...)`。

---

## 4. 场景 A：第二并发波内 `stats` 冻结（P0，主诉）

### 4.1 构造步骤（脚本 `scenarioFrozenDuringSecondWave()`）

1. 建一个含 3 个子任务、2 个阶段的计划：
   - S1：`T1`（engineering，快任务）；
   - S2：`T2`（qa，依赖 T1，快任务）、`T3`（design，依赖 T1，挂起任务）。
2. 按 `createPlan` 的真实内存形状创建记录（`src/runtime.ts:1619-1628`，**初始没有 `stats` 字段**）。
3. 调用真实 `dispatchPlan`：
   - 第一波：T1 完成；波末 `src/runtime.ts:760` 写入 `record.stats`；
   - 第二波：T2 完成，T3 进入 `in_progress` 并挂起。
4. 在 T2 已 done、T3 仍 `in_progress` 时，读取 `runtime.plansPayload(session.id).sessions[0]`。
5. 把同一份 payload 交给真实 `client.js` 渲染 Dashboard，读取统计条、卡片、阶段徽标、子任务胶囊、Donut。

### 4.2 观察到的错误值 vs 期望值

| 观测面 | 观察到的错误值 | 期望值（由同一份 `statuses` 派生） |
| --- | --- | --- |
| `stats.done` | `1` | `2` |
| `stats.inProgress` | `0` | `1` |
| `stats.pending` | `2` | `0` |
| `stats.progress` | `33` | `70`（`(100+100+10)/3` 四舍五入） |
| 同一 payload 的 `departments` | `qa.done=1`、`design.inProgress=1` | 与 `stats.done=1`、`stats.inProgress=0` 不可能同时成立 |
| UI 顶部统计条 | `1 做好了 / 0 正在做` | `2 做好了 / 1 正在做` |
| UI 卡片进度行 | `总体进度 33%` + `0 正在做 · 2 还没开始` | `总体进度 70%` + `1 正在做 · 0 还没开始` |
| UI 阶段徽标 | `第 2 步：第二波 ... 正在做` | 同为「正在做」（与统计条矛盾） |
| UI 子任务胶囊 | T2「做好了」、T3「正在做」 | 同左（与统计条矛盾） |
| UI Donut | `33%` | `70%` 或按完成件数 `67%`，但**不应与卡片 33% 并存** |

### 4.3 复现概率与可见时长

- **确定性 100%**：只要计划存在“第一波结束之后仍有状态变化”，`stats` 就必然停留在第一波波末快照；这不是竞态偶发。
- **可见时长**：从第一波波末到整个 `dispatchPlan` 结束（含所有后续波、子 Agent 运行、预算等待），最长可达分钟级；UI 每 4000ms 轮询一次，因此不是一闪而过的渲染抖动，而是稳定可见的错误画面。
- 原始会话的旁证：`session-91ec3273…` 的计划分 6 个阶段、12 个子任务，分 6 轮预算续跑（见第 7 节），天然具备多波结构。

---

## 5. 场景 B：预算暂停产生 `pending + progress=100`（P1）

### 5.1 构造步骤（脚本 `scenarioBudgetPause()`）

1. 建一个 1 个子任务的计划，子 Agent 挂起不返回。
2. 调用 `dispatchPlan` 时传 `totalTimeoutMs: 350`。`dispatchPlan` 内部会把计时器下限抬到约 1000ms（`Math.max(1000, deadline - now)`），因此实际约 1 秒后触发“本轮预算用尽”。
3. 读取 `record.phase`、payload 的 `statuses`、`stats`，再渲染 UI。

### 5.2 观察到的错误值 vs 期望值

| 观测面 | 观察到的错误值 | 期望值 |
| --- | --- | --- |
| `statuses[0].status` | `pending` | `pending`（暂停后回到未开始，本身合理） |
| `statuses[0].progress` | `100` | `0`（`applyStatus` 对 pending 的归一化值） |
| `statuses[0].childId` | `child-hang`（残留） | `null` |
| `statuses[0].startedAt` | 非空（残留） | `null` |
| `statuses[0].finishedAt` | `null` | `null` |
| `statuses[0].error` | `本轮预算用尽，等待续跑` | 同左（保留原因合理） |
| `stats` | `{"total":1,"done":0,"blocked":0,"inProgress":0,"pending":1,"progress":100}` | `progress: 0` |
| UI 卡片 | `总体进度 100%` + `0 正在做 · 1 还没开始` | `总体进度 0%` |
| UI Donut | `0%`（按 done/total） | `0%`；但**不应与卡片的 100% 同屏并存** |

### 5.3 原始会话中的真实证据（非构造）

原始会话 `session-91ec3273-3277-49ff-87b3-7ce4722f29e0` 的解压后 JSONL 第 327 行（事件 `seq=325`，时间 `2026-10-27 21:20:36 CST`）是一条 `workplan-result`，其原文头部为：

```text
【部门执行结果】完成 11/12，受阻 0，请主 Agent 核对并整合
...
4. 本轮执行预算用尽，剩余 1 项未完成（不是失败、未计入续跑额度）：再次调用 dsh_workplan_dispatch 即可从剩下的步骤继续，已完成的不重跑。
```

同一消息内嵌的 payload 实测为：

```json
"stats": {"total":12,"done":11,"blocked":0,"inProgress":0,"pending":1,"progress":100}
```

其中未完成的 T12 条目：

```json
{
  "subtaskId": "T12",
  "status": "pending",
  "progress": 100,
  "childId": "41bcef5d-39b2-4726-9ba1-f67ac4908de1",
  "startedAt": 1793106957096,
  "finishedAt": null,
  "summary": "",
  "error": "本轮预算用尽，等待续跑"
}
```

这条证据直接证明：**原始会话里确实出现过“12 项只完成 11 项、但总体进度 100%、最后一项 pending 且 progress=100”的画面**。不是本报告构造出来的假想。

### 5.4 复现概率

- 只要本轮预算在任一子任务执行中耗尽，**确定性 100%**；
- 默认单轮预算为 60000ms（`createWorkplanRuntime` 下限），长任务/多子任务批次很容易触发；原始会话连续 6 轮都在预算边界暂停，说明这是常规路径，不是极端异常。

---

## 6. 场景 C：resume 后 `stats.blocked` 残留（P1）

### 6.1 构造步骤（脚本 `scenarioResumeBlocked()`）

1. 建一个 2 个子任务的计划，初始 `statuses` 都是 `blocked`，`record.stats.blocked = 2`，`phase = 'blocked'`，`resumeCount = 0`。
2. 调用 `plansPayload` 取得暂停画面（此时 stats 与 statuses 一致，均为 2 blocked）。
3. 调用 `resumePlan` 恢复；T1 变为 `in_progress` 并挂起，T2 被重置为 `pending`。
4. 在 T1 仍 `in_progress` 时读取 payload 并渲染 UI。

### 6.2 观察到的错误值 vs 期望值

| 观测面 | 观察到的错误值 | 期望值 |
| --- | --- | --- |
| `stats.blocked` | `2` | `0` |
| `stats.inProgress` | `0` | `1` |
| `stats.pending` | `0` | `1` |
| `stats.done` | `0` | `0` |
| 实际状态计数 | `{done:0, blocked:0, inProgress:1, pending:1}` | 同左 |
| UI 顶部 | `2 卡住了 / 0 正在做` | `0 卡住了 / 1 正在做` |
| UI 卡片 | `0 正在做 · 0 还没开始` | `1 正在做 · 1 还没开始` |
| UI 子任务胶囊 | T1「正在做」 | 同左（与顶部矛盾） |

### 6.3 复现概率

- 只要计划曾进入 `blocked` 且被 resume，并在“第一波结束前”读取，**确定性 100%**；
- 可见窗口从 resume 写入 `statuses` 起，到该波结束（`src/runtime.ts:760`）或 `finally`（`:825`）重算 `stats` 为止；若第一个子任务运行较久，窗口同样可达分钟级。

---

## 7. 原始会话与截图的对应关系（证据边界）

原始会话的解压命令（只读，不修改任何东西）：

```bash
zstd -dc "~/.dsh/sessions/--Users-open-Documents-Stocks--/session-91ec3273-3277-49ff-87b3-7ce4722f29e0/session.v4.jsonl.zstd" > /tmp/session-91ec.jsonl
```

该会话共 634 行事件，其中 7 条 `workplan-result`（解压后 JSONL 第 197、249、265、294、310、327、394 行）。前 6 条 `phase` 均为 `paused`，最后一条为 `integrating`。逐条实测统计：

| JSONL 行 | 时间（CST） | 完成/总数 | stats.progress | phase |
| --- | --- | --- | --- | --- |
| 197 | 2026-10-27 18:45:27 | 5/14 | 43 | paused |
| 249 | 2026-10-27 19:59:41 | 6/12 | 58 | paused |
| 265 | 2026-10-27 20:20:12 | 7/12 | 67 | paused |
| 294 | 2026-10-27 20:40:16 | 8/12 | 75 | paused |
| 310 | 2026-10-27 21:00:27 | 9/12 | 83 | paused |
| 327 | 2026-10-27 21:20:36 | 11/12 | **100** | paused |
| 394 | 2026-10-27 21:31:58 | 12/12 | 100 | integrating |

说明：

- 原始会话的 `workplan-result` 只在批次暂停/结束时生成，此时 `finally` 刚重算过 `stats`，所以这些快照大多是自洽的；**不能用它们反证运行中 UI 是自洽的**。
- 但第 327 行恰好同时暴露了 D3：`done=11/12`、`pending=1`、`stats.progress=100`、pending 项 `progress=100`。这是原始会话内的真实数据，不是构造。
- 用户截图显示的是运行中的 UI，与场景 A 的冻结窗口同源；但本轮没有拿到截图原文件，因此不能断言截图时刻一定处于 A，也不把“截图里的具体数字”当作已验证事实。场景 A 的结论由真实 `plansPayload` + 真实 `client.js` 渲染共同证明，可脱离截图独立成立。

---

## 8. 被测构建指纹（保证“跑的就是缺陷版本”）

```text
version        1.4.2
src/runtime.ts f4dc6fd33b3e511ff0bfbc5886a1d1ef2404d17f495c142e93e5174cd385b367
src/plan.ts    c3cfd5e760604c8cde3a2b9c57bc55b01b4755837257d09396d05bd269dd506e
lib/runtime.js 5f93ea0fa49b0cdc04819642d8626704b5918c8768e2982ebfa0603b355f9790
lib/plan.js    24455faea8791ba8e0ccec26c8d84cc98415ae0e6da881e9f60f5573b9418503
client.js      0c3ffd342a66da3a436633ba73b9d5b514200e9d91db3203f0a97bf7d5acd15d
package.json   b542c81034a24eb31cea016a93ef2716fc850787994cf8dd93c9e42ce8f05fad
```

复核命令：

```bash
cd <repo>
shasum -a 256 src/runtime.ts src/plan.ts lib/runtime.js lib/plan.js client.js package.json
```

若哈希与上表不同，说明被测代码已变化，本报告的数值需要重新跑一遍才能引用。

---

## 9. 第三人复核清单

照做后逐项打勾，任何一项不符都说明环境或代码版本不同，请先停下核对第 8 节哈希：

- [ ] 命令从 `<repo>` 执行；
- [ ] `node scripts/repro-inconsistent-counts.ts` 退出码为 `0`；
- [ ] 输出包含 14 条 `[PASS]`，且没有 `[FAIL]`；
- [ ] 场景 A 的 `stats` 为 `done=1, inProgress=0, pending=2, progress=33`，而 `actual` 为 `done=2, inProgress=1, pending=0`；
- [ ] 场景 A 的 UI 卡片为 `0 正在做 · 2 还没开始`，同时存在 `步骤 T3 ... 正在做` 的胶囊；
- [ ] 场景 B 的 pending 项为 `progress=100`、`childId=child-hang`、`startedAt` 非空，`stats.progress=100` 且 `done=0`；
- [ ] 场景 B 的 UI 卡片为 `总体进度 100%`，Donut 为 `0%`；
- [ ] 场景 C 的 `stats.blocked=2`，而实际 blocked 为 `0`、inProgress 为 `1`；
- [ ] `--expect-fixed` 在当前构建退出码为 `1`，且 9 条不变量断言中有 8 条 `[FAIL]`（`departments` 一致这条本就 `[PASS]`；修复后应全部 `[PASS]`、退出码 `0`）。

---

## 10. 本复现的边界

1. **没有重启、没有构建、没有改源码**：脚本只调用已存在的 `lib/*.js` 与 `client.js`；运行前后这些文件的哈希不变。
2. **HTTP 路由未被直接调用**：401 是宿主的鉴权设计，不是插件缺陷；用同一序列化函数取证不降低结论强度，但本报告不声称“亲眼看到浏览器网络面板里的 401 之后数据”。
3. **UI 是服务端渲染字符串，不是真实浏览器 DOM**：React 桩按 `client.js` 的真实组件树输出 HTML，足以证明“同一屏出现互相矛盾的文案”；但不覆盖 CSS 布局、字体、遮挡、浏览器扩展等纯展示因素。原始截图的具体像素不在本轮取证范围内。
4. **时间窗口依赖真实子 Agent 的挂起行为**：脚本用 `hangingChild` 精确控制窗口；真实环境的窗口长度取决于子 Agent 运行时长，但“窗口存在”这一点与子 Agent 快慢无关。
5. **本轮只诊断，不修复**：源码、`lib/`、`client.js`、版本号均未改动；修复与回归测试属于后续任务。
