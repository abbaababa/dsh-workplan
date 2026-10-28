# dsh-workplan 1.4.3 修复报告：「正在做」数字与真实状态不一致

> 结论先行：用户报告的现象是**真实缺陷**，且不是一处，而是同一根因下的 **4 处**逻辑分裂
> （D1 计数缓存冻结、D2 同一报文自相矛盾、D3 重置绕过状态机、D4 同一失败两种进度语义）。
> 根因是**同一个计划存在两套真相源**：实时状态列表 `record.statuses` 与缓存在记录上的
> `record.stats`。1.4.3 把计数改为**纯派生**（`derivePlanSnapshot`），结构上让「同一报文内
> 两套数字」无法再被表示出来，并加了不变量测试与真实会话回放作为护栏。

- 插件：`<repo>`
- 版本：1.4.2 → **1.4.3**（补丁级：仅缺陷修复 + 内部重构，对外载荷字段未变）
- 报告日期：2026-10-28
- 证据文件：本文 + `docs/repro-count-inconsistency.md` + `docs/defect-report-count-inconsistency.md`

---

## 一、用户报告与截图对应

| 截图 | 显示 | 真实状态 | 判定 |
|---|---|---|---|
| 图 1 顶部汇总 | 2 个任务 / 29 件工作 / 18 做好 / **0 正在做** | 同一时刻至少 1 个子任务处于 `in_progress` | 缺陷（D1） |
| 图 1 计划卡 | 该计划 3/14 做好（21%），组头仍归入「进行中」 | 一致（21% = 3/14） | 正常 |
| 图 2 第 3 步 | 0/3 做好，徽标 **正在做** | 阶段内确有子任务在跑 | 正常（阶段徽标读状态列表） |
| 图 3 具体工作 1 | **正在做 · 进度 10%** | 子 Agent 刚绑定，`progress: 10` 是启动即写入的真实值 | **正常行为，不是缺陷**（此前曾被误判，特此纠正） |

真正互相矛盾的是：**顶部/卡片数字读缓存**，**阶段与子任务徽标读实时状态列表**。缓存只在
「整批子任务跑完」后刷新，所以一批任务运行期间，看板会在同一屏同时显示「0 正在做」与「正在做」。

---

## 二、证据链（全部可复现）

### 2.1 真实会话回放（用户报告的原始会话）

`scripts/replay-reported-session.ts` 直接读取
`~/.dsh/sessions/--Users-open-Documents-Stocks--/session-91ec3273-3277-49ff-87b3-7ce4722f29e0/session.v4.jsonl.zstd`，
把其中**每一条** workplan 结果报文解析出来，用修复后的算法重算同一份 `statuses`，与 1.4.2 当时写下的数字对照：

```
workplan 结果报文: 7 条；其中 1.4.2 发出时与状态列表不一致: 6 条
其中「待做却带着旧进度/旧子 Agent」的报文（D3 残留）: 6 条

seq        done  inProgress  pending  progress(1.4.2→1.4.3)  不一致字段
195        5     0           9        43→36                   progress
247        6     0           6        58→50                   progress
263        7     0           5        67→58                   progress
292        8     0           4        75→67                   progress
308        9     0           3        83→75                   progress
325        11    0           1        100→92                  progress
392        12    0           0        100→100                 —

D3 证据（1.4.2 把预算暂停项重置为 pending 却留着旧字段）：
  seq=195: T6(progress=100, childId)     seq=247: T7(progress=100, childId)
  seq=263: T8(progress=100, childId)     seq=292: T9(progress=100, childId)
  seq=308: T10(progress=100, childId)    seq=325: T12(progress=100, childId)
```

注意 seq=325 那条：`done=11 / pending=1`，进度却写 **100%**。这正是截图图 1 计划卡
「未完成 11 / 已完成 3」与「21%」并存的同源问题：**进度与完成数来自不同口径**。

### 2.2 现象级复现（并发波中途读取看板载荷 + 真实 `client.js` 渲染）

`scripts/repro-inconsistent-counts.ts` 构造三组真实运行时状态：

- 场景 A（并发波进行中）：真实状态 `done 2 / 正在做 1 / 待做 0`；1.4.2 载荷写出
  `done 1 / 正在做 0 / 待做 2`、进度 33%，而真实进度 70%。同一载荷里
  `stats.inProgress = 0` 与 `departments.design.inProgress = 1` 同时存在（D2）。
- 场景 B（预算用尽重置）：`status = pending` 却带 `progress = 100`、`childId`、`startedAt`（D3）。
- 场景 C（blocked 计划 resume 后）：`stats.blocked = 2`，而实际 `blocked = 0`（D1 的另一面）。

---

## 三、根因（代码级）

| 编号 | 位置 | 缺陷 |
|---|---|---|
| **D1** | `src/runtime.ts:361-366` `writeSubtaskStatus()` | 只写 `record.statuses`，**不写** `record.stats` |
| **D1** | `src/runtime.ts:760`（1.4.2 行号） | `record.stats = computeStats(...)` 只在**整批子任务全部结束之后**执行，批次运行期间缓存冻结 |
| **D1** | `src/runtime.ts:838`（1.4.2） | `const stats = record.stats ?? computeStats(statuses)`：`stats` 恒已初始化，回退分支**永不触发**，恒发旧值 |
| **D2** | `src/runtime.ts:843-857`（1.4.2） | 同一函数内 `stats` 取自缓存、`departments` 由 `statuses` 现场聚合 → 一个响应两套口径 |
| **D3** | `src/runtime.ts:779-790`（1.4.2） | 预算用尽重置用裸对象展开 `{...item, status:'pending', progress: item.progress ?? 0}`，绕过 `applyStatus()` 的伴随字段清理 |
| **D4** | `src/runtime.ts:807-818`（1.4.2） | 异常收敛写 `progress: item.progress ?? 0`，而其余 4 处 blocked 写入点写 `progress: 100` |

连带的数据口径错误：1.4.2 的 `computeStats()` 直接对每条 `item.progress` 求平均，**不看 status**，
所以被重置为 pending 却残留 100 的条目会把总进度抬到 100%（12 项里 11 项完成也报 100%）。

---

## 四、其它同类模式的全面审查结论

用户问「是否还有多处逻辑混乱」。答案是：**数字层面已全部收敛，另有一处「状态缓存」经审查不是缺陷**。
逐项如下（每项都读过代码，不是推测）：

| 数字/状态出现的位置 | 数据来源（1.4.2） | 1.4.3 结论 |
|---|---|---|
| 顶部汇总四格（任务数/工作量/完成/正在做） | 各计划 `stats` 求和（`src/client.ts:1950-1952`） | 单一来源 ✅ |
| 计划卡数字（总数、已完成、正在做、进度环） | `session.stats`（`src/client.ts:1339-1377`） | 单一来源 ✅ |
| 阶段徽标「N/M 做好」 | 该阶段 `items` 的状态计数（`src/client.ts:1250-1267`） | 与 `stats` 同源（同一 `statuses` 数组派生）✅ |
| 子任务进度条 | 子任务自身 `progress`（`src/client.ts:1231`） | 同源 ✅ |
| 部门分布（design/engineering/qa…） | 1.4.2 现场聚合，与缓存 `stats` 不同源 | 现由同一次遍历产出 ✅ |
| 甜甜圈/条形图/统计条 | `totals` ← 各计划 `stats` | 单一来源 ✅ |
| 工具返回 JSON（`dispatch`/`update`/`cancel`） | 1.4.2 部分读 `record.stats`，部分读状态 | 全部改为同一次派生 ✅ |
| 结果消息摘要「完成 x/y」 | `result.stats` | 派生 ✅ |
| 结果消息载荷 `stats` | 1.4.2 `record.stats` | 派生 ✅（并新增端到端守卫测试） |
| `record.phase`（计划阶段） | 缓存，但有补偿：批次结束/异常/暂停/取消各出口都会重算 `planPhase`；回放时用随载荷下发的 `phase` 还原 | **非计数**，未发现可观测矛盾；保留为设计注意点（见 §8） |

---

## 五、修复内容

### 5.1 单一派生源（核心）

`src/plan.ts` 新增（全部 TypeScript）：

```
SubtaskStatus / StatusEntry / Stats / DepartmentSummary / PlanSnapshot
isSubtaskStatus / clampProgress / normaliseStatusEntry / normaliseStatuses
deriveAggregates / derivePlanSnapshot / computeStats(别名, @deprecated) / aggregateInvariantViolations
```

规则固定在一处：未知状态降级 `pending`；`pending` 强制 `progress=0` 且清空
`childId/startedAt/finishedAt`；`done` 强制 100；进度加权 done=100、blocked/in_progress=自身
（clamp 0–100）、pending=0；无 `subtaskId` 的条目丢弃；部门在同一次遍历内聚合。

`src/runtime.ts`：

- 删除**全部** `record.stats` 写入/读取（16 处），`grep 'record.stats'` 只剩一条注释；
- `serialisePlan` / `buildRoundResult` / `dispatchTool` / `updateStatus` / `cancelPlan`
  统一「先派生一次，再用同一快照填 `statuses`、`stats`、`departments`、`phase`」；
- 预算用尽重置改为逐项 `applyStatus(..., { status: 'pending', error: ... })`；
- 异常收敛分支 blocked 统一 `progress: 100`。

### 5.2 状态机收口

`applyStatus()` 的 `pending` 分支清空 `progress/startedAt/finishedAt/childId`（同一 patch 里显式传入的值优先，
所以「预算用尽」的原因仍能保留在 `error` 里）。

### 5.3 构建卫生（本次实际踩到并修掉的 error）

`npm test` 曾因旧编译物残留报
`ERR_MODULE_NOT_FOUND ... dist-tests/src/state.js`（exit 2）。已修：

```json
"clean": "rm -rf dist dist-tests",
"build": "rm -rf dist && tsc -p tsconfig.json && cp ... && cp dist/client.js client.js",
"test":  "npm run build && rm -rf dist-tests && tsc -p tsconfig.test.json && node --test dist-tests/tests/*.test.js"
```

### 5.4 移出失控产物（防止再造双真相源）

- 子 Agent 遗留、未被任何生产代码引用的 `src/state.ts`、`tests/state-machine.test.ts`
  → `docs/design-proposals/`（它与 `applyStatus` 重复实现同一语义，接入即再造两套状态机）；
- `docs/design-derived-counts.reference.ts`（设计稿副本）在设计落地后**删除**，
  `scripts/prove-derived-counts.ts` 改为直接导入 `src/plan.ts`，杜绝「设计与实现各算一套」。

---

## 六、验证证据

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run check` | exit 0 |
| 单元/回归测试 | `npm test` | **90 / 90 通过**（79 原有 + 11 新增） |
| 修复前行为复现 | `node --experimental-strip-types scripts/repro-inconsistent-counts.ts` | 12 条 check 失败 —— **符合预期**，脚本默认断言缺陷存在 |
| 修复后不变量 | 同脚本 `--expect-fixed` | **exit 0，全部 PASS**（顶部 2/1、卡片 70%/正在做 1/待做 0、甜甜圈 67；暂停项 progress=0、childId=null；resume 后 blocked=0） |
| 设计证明 | `node --experimental-strip-types scripts/prove-derived-counts.ts` | **13 条断言 PASS**，含 500 组随机状态序列的不变量与幂等检查 |
| 真实会话回放 | `node --experimental-strip-types scripts/replay-reported-session.ts <会话日志> --expect-fixed` | **exit 0**：7 条历史报文派生后全部满足不变量；并证明其中 6 条 1.4.2 的显示值确实与状态列表不符 |

新增测试 `tests/derived-counts.test.ts` 的关键设计：**变异测试**——手工把
`stats.done + 1`、`total + 1`、`pending - 1`、`progress = 101`、部门 `done/total` 改坏，
不变量检查器必须报错；否则测试只描述现状、挡不住回归。另有结构性守卫
`assert.equal('stats' in record, false)`，有人把缓存字段加回记录就会立刻失败。

---

## 七、版本与回滚

- `package.json`、`src/host.ts`、重建后的 `lib/host.js` / `dist/host.js` 均为 **1.4.3**（四处交叉核对一致）。
- 对外载荷字段不变：`statuses` / `stats` / `departments` 同名同义，工具 JSON Schema 未改。
- 历史结果消息仍可回放读取（1.4.2 写下的数字保持原样，不被改写）。
- 回滚：`.backups/v1.4.2-pre-derived-counts-20261028-123136.tar.gz`（改动前完整快照），
  `tar -xzf` 后 `npm test` 即回到 1.4.2 的 79 项通过。

---

## 八、防复发机制与遗留说明

1. **结构上不可表示**：`stats`/`departments`/`statuses` 只能由 `derivePlanSnapshot` 一次产出，
   报文里再想手工拼一个数进去，端到端守卫测试会失败。
2. **不变量 I1–I7**：四状态之和 = total、进度 0–100、pending 不携带进度/子 Agent、
   done 恒 100、subtaskId 唯一非空、部门合计 = 总量。
3. **历史数据可自证**：回放脚本让任意一条历史报文都能被判「当时是否自相矛盾」。
4. **遗留说明（不作夸大）**：`record.phase` 仍是缓存字段。它在批次结束、异常、预算暂停、
   取消四个出口都会重算，回放时又随载荷下发 `phase` 还原，因此本次**未**观察到可复现矛盾；
   它不参与任何计数。若将来要给 phase 也做同样处理，可作为下一轮的独立改进项。

## 九、生效方式

已安装的运行实例在启动时加载 `lib/*.js`，**需要重启 DSH（或重新加载 `web` profile）才会使用 1.4.3**。
未重启时，页面仍由旧代码提供服务，旧缺陷会继续存在——这是「改完还没生效」，不是修复失败。
