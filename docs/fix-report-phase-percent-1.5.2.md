# 修复报告：计划卡「100% + 正在收尾」并存（1.5.2，2026-10-29）

> 一句话：**进度**和**状态**原本不是同一个事实源 —— 进度只数「做完了几项」，
> 状态却额外要求「结果消息已落盘」这个副作用。用 `dsh_workplan_update` 补完最后
> 一项时，没有任何代码会写结果消息，于是计划永久停在「正在收尾」，而进度已经是 100%。
> 1.5.2 让终态只由子任务计数决定，并把同根因的 8 类矛盾一并修掉。

- 事故会话：`session-c3852c31-f6cd-4fc5-8cff-d8a3932e9feb`
- 计划：`wp-dc44c4a2-3fce-4e78-a2df-1cf6da76eeb2`「159667工业母机ETF走势预判·证据驱动的分期推演计划」
- 截图现象：`14/14`、环形 `100%`、「都做完了」、胶囊「正在收尾」、卡片仍在「进行中」组
- 受影响版本：`1.5.1` 及更早
- 修复版本：`1.5.2`

---

## 1. 证据链（每一步都可复核）

### 1.1 用户截图那一轮到底发生了什么

直接解压会话日志（多帧 zstd，需用系统 `zstd -dc`；Node 的 `zstdDecompressSync`
只解第一帧，会得到一份被截断的日志）：

```bash
zstd -dc ~/.dsh/sessions/--Users-open-Documents-Stocks--/session-c3852c31-f6cd-4fc5-8cff-d8a3932e9feb/session.v4.jsonl.zstd \
  | nl -ba | sed -n '186,196p;260,276p'
```

事实（与截图逐项对得上）：

| 位置 | 事件 | 内容 |
| --- | --- | --- |
| `seq 189`（文件第 191 行） | 最后一条 `workplan-result` | `stats.total=14, done=12, pending=2, progress=86`，`phase: "paused"`，`errors`：本轮预算（20 分钟）已到，已完成 12/14 |
| `seq 263` / `seq 269` | 主 Agent 直接调 `dsh_workplan_update` | 把 `T13`、`T14` 标为 `done`（后一条带 `note`：「由主 Agent 承接完成排版与自检（未再派发设计部门 Agent）」） |
| `seq 276` | `turn/end`（2026-10-28T15:12:28Z） | 会话结束，**此后再没有新的 `workplan-result` 事件** |

于是 `statuses` 变成 14/14 全 `done`，`stats.progress` 由计数派生为 100；
但 `phase` 走的是另一条路：

```
updateStatus()  →  record.phase = planPhase(record.statuses)      // 不带 resultSeen
planPhase()     →  all done ? (resultSeen ? 'done' : 'integrating')  // 于是 'integrating'
```

而 `resultSeen` 只可能由「派发轮次末尾写入的结果消息」置真 —— 这一轮根本没有派发，
所以它永远不会变成 `done`。**与截图完全一致。**

### 1.2 同一个会话「刷新前后翻转」

同一份事件，`reconstructFromSession()` 能找到 `seq 189` 的结果消息，于是
`resultSeen = true`，回放得到 `done`。也就是说：

- 实时缓存：`integrating`（正在收尾）
- 刷新页面后：`done`（已完成）

这不是观感问题，而是两条链路对「完成」的定义不同。

### 1.3 代码位置（修复前）

| 位置 | 代码 | 含义 |
| --- | --- | --- |
| `src/plan.ts:1377` | `if (statuses.every(done)) return resultSeen ? 'done' : 'integrating'` | 完成被绑在「结果消息」这个副作用上 |
| `src/runtime.ts:1209`（`updateStatus`） | `record.phase = planPhase(record.statuses)` | 丢掉了 `resultSeen`，把 done 打回 integrating |
| `src/runtime.ts:868`（`serialisePlan`） | `let phase = record.phase ?? planPhase(statuses)` | 内存 phase 优先于计数派生值 |
| `src/runtime.ts:1415`（派发尾部） | `if (record.resultWritten && allDone) record.phase='done'` | 终态只由「结果写入成功」触发；写入抛错就永远停在 integrating |
| `src/client.ts:1475` | `percent = Math.round(done / total * 100)` | 环只看计数 |
| `src/client.ts:1557` | `counts.done === counts.total → 「都做完了」` | 再一套完成判断 |
| `src/client.ts:1667` | `state = percent >= 100 ? 'done'` | 第三套完成判断 |
| `src/client.ts:2286` | `phase === 'done' ? finished : live` | 分组看 phase，于是 100% 的卡留在「进行中」 |

### 1.4 不是四舍五入造成的假 100%

计划最多 15 个子任务（`MAX_SUBTASKS = 15`），13/14 显示 93%、14/15 显示 93%，
不存在「没做完却四舍五入成 100%」。另有一个**真实的**同类缺陷是**加权口径**：

```
11 done + 1 blocked@95  →  环形进度 92%（done/total），总体进度 100%（progress 加权）
```

这属于同一族问题（同一张卡两个百分比各说各话），一并修复。

---

## 2. 修复决策

**只保留一根轴：终态由子任务计数决定。** 理由：

1. 「结果消息是否落盘」是副作用，不是事实。用它决定计划是否完成，任何不走派发轮次的
   完成路径（`update` 工具、人工交接、结果消息写入失败）都会漏掉；
2. 反过来「封顶 99%」的方案会制造新矛盾：`14/14` 却显示 99%，仍与「都做完了」冲突；
3. 计划追踪器的语义是「计划内的工作是否做完」。合成本身不属于被追踪的子任务，
   进入合成就说明子任务已经清空 —— 此时对读者而言计划已完成。

因此新增 `reconcilePhase(phase, statuses)`，作为**唯一**的 phase 对账入口：

```ts
const derived = planPhase(statuses)          // 计数派生：全 done → 'done'
if (derived === 'done') return 'done'        // 终态优先
if (phase === 'done' || phase === 'integrating') return derived   // 旧派生值一律重算
if (phase === 'pending' || phase === 'planning' || phase === 'executing') {
  return derived === 'pending' ? phase : derived
}
return phase ?? derived                       // paused/cancelled/blocked/degraded 有独立事实来源
```

---

## 3. 改动清单

### 3.1 `src/plan.ts`

- `planPhase(statuses, _resultSeen)`：全部 `done` 时**恒返回 `done`**；参数保留只为兼容。
- 新增 `reconcilePhase()`（见上）。
- `deriveAggregates()`：未全部完成时总进度封顶 99（`Math.min(99, raw)`）。
- `applyStatus()`：`in_progress` 的进度夹紧到 99（「正在做」不允许自称 100%）。
- `aggregateInvariantViolations(snapshot, phase?)` 新增：
  - **I8**：`done === total` ⟺ `phase === 'done'`（双向）；
  - **I9**：全部完成 ⟺ `progress === 100`；
  - **I10**：`in_progress` 的子任务不得 `progress >= 100`。

### 3.2 `src/runtime.ts`

- `serialisePlan()`：phase 走 `reconcilePhase`；存在不变量违背时载荷附带 `violations`。
- `updateStatus()`：走 `reconcilePhase`（截图矛盾的直接入口）。
- 派发尾部：终态晋升不再依赖 `record.resultWritten` 这个副作用。
- `reconstructFromSession()`：回放与实时同源（刷新前后不再翻转）。
- `cancelPlan()`：计划已全部完成时改为 no-op（`alreadyDone: true`），消除「100% + 已取消」。
- 预算到点分支：此刻若已全部完成则记 `done`（防御性，正常循环下不可达）。

### 3.3 `src/client.ts`

自包含 bundle，不能 `import` `plan.ts`，因此在客户端复刻同一语义，并统一为三个函数：

- `planPercent(done, total)` —— 唯一的百分比算式；
- `planPhaseOf(rawPhase, counts)` —— 唯一的胶囊/分组判定；
- `planWeightedPercent(stats, counts)` —— 唯一的加权进度算式。

卡片环、徽章、分组、分组环、阶段条、会话内联卡、`rank`、`liveBars`、`TaskBars`
全部改走它们。新增文案：`helpWaitActive`、`helpNoPlan`、`nowRemaining`。

### 3.4 测试

| 文件 | 变化 |
| --- | --- |
| `tests/phase-percent-invariant.test.ts` | 新增 13 例：终态语义、计数封顶、I8/I9 双向、update 补完最后一项、空更新不回退、取消已完成计划、客户端渲染旧载荷 |
| `tests/completion-semantics.test.ts` | 新增 8 例：`in_progress@100` 夹紧、I10、单任务执行中不再宣布完成、部分完成「还剩 N 项」、0/0 降级不说完成、阶段条只按 done 计宽、阶段卡与「现在」同口径、0% 未开始不再标 active |
| `tests/plan.test.ts` | 原先断言「全 done → integrating」改为 `done`，并补 `reconcilePhase` 断言 |
| `tests/workplan-budget-pause.test.ts` | 三处「全部完成后仍 integrating」的期望值改为 `done` |
| `tests/derived-counts.test.ts` | blocked 用例的总进度期望由 100 改为 99（与封顶规则一致） |

> 说明：1.5.1 及更早的测试把**矛盾本身**写成了期望值
> （`tests/plan.test.ts:297`、`tests/workplan-budget-pause.test.ts:159`），
> 所以修复必须同时改测试 —— 这不是「为了让测试变绿而改测试」，
> 而是把设计契约从「完成需要副作用」改成「完成只看计数」，并附上新的反面用例。

---

## 4. 同类问题（来自 `docs/state-progress-matrix.md`）

状态矩阵枚举了 12 类结构组合 × 5 类事件相位，共 14 项冲突。本次处理：

| 编号 | 现象 | 处理 |
| --- | --- | --- |
| C1 | 100% + 「正在收尾」+ 留在「进行中」 | 已修（本报告主线） |
| C2 | 执行中却写「没有下一步，这件事已完成」 | 已修：`nextText` 不再兜底「已完成」 |
| C4 | 预算到点且已全 done 仍写 `paused` | 已修（防御性分支） |
| C5 | 部分完成却写「还没开始」 | 已修：`done > 0` → 「还剩 N 项」 |
| C6 | 环 `done/total` 与加权 `progress` 双口径 | 已修：未完成时两边都封顶 99，完成时都为 100 |
| C7 | 阶段条把 `blocked` 算作已触达（环 50%、条 100%） | 已修：`reach = done / total` |
| C8 | 允许 `in_progress + 100%` | 已修：夹紧 99 + I10 |
| C9 | 阶段行说「正在做」、阶段卡说「还没开始」 | 已修：两处同口径 |
| C11 | 0/0 降级计划也说「这件事已完成」 | 已修：`helpNoPlan` |
| C12 | 同屏两个互斥的「现在」 | 已修：`workerText` 与 `planNow` 同序（blocked → active → …） |
| C13 | 0% 未开始的卡标 `data-state="active"` | 已修：`idle` |
| C3 | 已取消的卡在前端被过滤，用户看不到 | **未改**：既有设计，`tests/client-render.test.ts` 明确断言「cancelled plan cards should not be rendered」。与 `dsh_workplan_cancel` 的工具描述文案不一致，记录为待统一 |
| C10 | stale pending 被序列化成 `cancelled`，回放返回 `pending + stale:true` | 未改：两种语义都有消费方，单独变更风险高，记录为下一步 |
| C14 | `planning` 是死枚举 | 未改：清理项 |

---

## 5. 验证（可复制的命令与实测输出）

### 5.1 构建、类型检查、测试

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
npm run build   # exit 0
npm run check   # tsc --noEmit，exit 0
npm test        # 120 tests / 120 pass / 0 fail（原 99 + 新增 13 + 8）
```

### 5.2 复现脚本（修复前会失败，修复后通过）

```bash
node scripts/repro-phase-percent-integrating.mjs --expect-fixed
```

实测输出（节选）：

```
payload phase = done
stats = { total: 2, done: 2, progress: 100 }
badge = 已完成 · hasIntegrating = false
data-state = done
live = done · replay = done · violations = null
[PASS] ×7        RESULT: PASS
稳定性：3/3 次指纹一致（8623b993cc8a686c…）
```

同一脚本**不带参数**运行现在会报 3 条 FAIL —— 这正是「旧 bug 已不存在」的证据
（脚本头部注释已写明两种模式各自的期望）。

### 5.3 直接回放用户报告的那次事故会话

```bash
node scripts/replay-real-session.mjs \
  ~/.dsh/sessions/--Users-open-Documents-Stocks--/session-c3852c31-f6cd-4fc5-8cff-d8a3932e9feb/session.v4.jsonl.zstd
```

实测输出：

```
计划: wp-dc44c4a2-3fce-4e78-a2df-1cf6da76eeb2 · 159667工业母机ETF走势预判·证据驱动的分期推演计划
阶段: done
统计: total=14 done=14 blocked=0 inProgress=0 pending=0 progress=100
子任务: 14
不变量告警: 无
```

即：同一份历史事件，修复后不再出现「100% + 正在收尾」。

### 5.4 版本一致性（7 处）

```
package.json: 1.5.2      package-lock.json（root）: 1.5.2
package-lock.json（packages[""]）: 1.5.2
src/host.ts meta.version: 1.5.2
lib/host.js: 1.5.2        dist/host.js: 1.5.2
CHANGELOG.md 顶部: 1.5.2
```

---

## 6. 生效方式（重要）

- **客户端**（`client.js`）：刷新页面即生效（客户端 bundle 热重载）。
- **宿主侧**（`lib/*.js`）：DSH 进程在**启动时** import，必须**重启 DSH** 才会加载 1.5.2。
- 已安装副本 `/Users/open/.dsh/profiles/web/node_modules/dsh-workplan` 是指向
  `/Users/open/Documents/Stocks/plugins/dsh-workplan` 的**符号链接**，无需重新安装。
- 因此：**当前正在运行的 DSH 实例仍是 1.5.1 的代码**。若在重启前把本会话的计划
  标成全完成，这张卡仍会显示「正在收尾」—— 那是旧代码的行为，不是修复失效；
  重启后同一份数据会显示「已完成」。这也是本次诊断最直观的验证方式。

---

## 7. 未做的事

- `git tag v1.5.2`、`npm publish`：属对外发布，**未执行**，需用户明确授权。
- C3 / C10 / C14：见第 4 节，记录为后续项。
- 运行中的 DSH 进程未重启（见第 6 节）。

---

## 8. 回滚

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
cp .backups/pre-1.5.2-20261029-125724/package.json .
cp .backups/pre-1.5.2-20261029-125724/package-lock.json .
cp .backups/pre-1.5.2-20261029-125724/CHANGELOG.md .
cp .backups/pre-1.5.2-20261029-125724/host.ts src/host.ts
npm run build
```

运行中的 DSH 进程不会自动重载 `lib/host.js`，回滚后同样需要重启。

---

## 附：相关文档

- `docs/root-cause-phase-percent.md` —— 根因推导与 H1–H7 假设逐条证伪
- `docs/state-progress-matrix.md` —— 12 类结构 × 5 类相位的状态矩阵与 14 项冲突
- `scripts/repro-phase-percent-integrating.mjs` —— 合成场景复现/回归
- `scripts/scan-state-matrix.mjs` —— 三层证据扫描器
- `scripts/replay-real-session.mjs` —— 真实会话回放
