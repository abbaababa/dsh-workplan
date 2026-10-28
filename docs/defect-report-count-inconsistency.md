# dsh-workplan 计数一致性缺陷诊断报告（T2 分级清单）

- 报告编号：T2-DEFECT-2026-10-28
- 被测版本：`dsh-workplan@1.4.2`
- 被测代码指纹：见第 8 节（源码与构建产物 sha256）
- 复现文档：[`docs/repro-count-inconsistency.md`](repro-count-inconsistency.md)
- 复现脚本：[`scripts/repro-inconsistent-counts.ts`](../scripts/repro-inconsistent-counts.ts)
- 结论：**存在 4 条已实测缺陷，全部可稳定复现；其中 2 条 P0、2 条 P1。它们不是 4 个互不相关的根因，而是“同一份计划状态被维护成两个真相源”在 4 个边界上的表现。**
- 原始会话证据：`session-91ec3273-3277-49ff-87b3-7ce4722f29e0` 内嵌的第 6 条 `workplan-result` 已直接出现 `done=11/12 + stats.progress=100 + 最后一项 pending/progress=100`。

---

## 1. 分级口径

| 级别 | 定义 | 用户影响 |
| --- | --- | --- |
| P0 | 正常执行路径即可触发；同一屏出现互相矛盾的事实；会直接误导用户对“还有没有在干活”的判断 | 高，主界面常驻 |
| P1 | 特定但常规的路径触发（预算暂停、续跑）；状态/进度语义被破坏，可能误导“是否完成” | 中高，暂停/续跑时可见 |
| P2 | 需要非常规路径；影响局部或仅内部契约 | 低 |

“复现概率”指在当前代码下由逻辑必然性决定，不是统计抽样；本轮脚本每次运行都得到同一组数值。

---

## 2. 缺陷总表

| ID | 级别 | 一句话 | 触发路径 | 主要观测面 | 复现概率 |
| --- | --- | --- | --- | --- | --- |
| D1 | P0 | 并发波内 `stats` 冻结在第一波波末，实时状态继续变化 | 任何多波计划 | 顶部统计条、卡片进度行、Donut | 确定性 100% |
| D2 | P0 | 同一份 payload 内 `stats` 与 `departments` 互相矛盾 | 同 D1 | HTTP/序列化契约、任何消费者 | 确定性 100% |
| D3 | P1 | 预算暂停把未完成项改成 `pending`，却保留 `progress=100`、`childId`、`startedAt` | 单轮预算耗尽 | 任务明细、卡片 100%、原始会话 | 确定性 100% |
| D4 | P1 | blocked 计划 resume 后 `stats.blocked` 仍为 2，实际已无 blocked | 续跑受阻计划 | 顶部“卡住了”、卡片“正在做/还没开始” | 确定性 100% |

D1 与 D2 是同一根因的两个观测面：前者是“时间上的旧”，后者是“同一时刻的自相矛盾”。D4 是同一根因在 resume 路径上的又一次出现。把它们分开列，是因为验收探针、用户影响和修复检查点不同，不是为了凑数。

---

## 3. D1（P0）：并发波内 `stats` 冻结

### 3.1 用户看到什么

一个三任务、两阶段的计划正在执行：

- 主 Agent 的实时状态：T1 done、T2 done、T3 正在做；
- 页面顶部：`1 做好了 · 0 正在做`；
- 卡片：`总体进度 33%`、`0 正在做 · 2 还没开始`；
- 但同一张卡片的第二阶段徽标写着「正在做」，T3 的子任务胶囊也写着「正在做」。

也就是说，**同一屏同时存在“0 个正在做”和“某个任务正在做”**。用户无法判断到底有没有在干活。

### 3.2 观察到的错误值 vs 期望值

场景 A 实测（`node scripts/repro-inconsistent-counts.ts`）：

| 字段/界面 | 观察到的错误值 | 期望值（由同一份 statuses 派生） |
| --- | --- | --- |
| `stats.total` | `3` | `3` |
| `stats.done` | `1` | `2` |
| `stats.inProgress` | `0` | `1` |
| `stats.pending` | `2` | `0` |
| `stats.progress` | `33` | `70` |
| 顶部统计条 | `1 做好了 / 0 正在做` | `2 做好了 / 1 正在做` |
| 卡片进度行 | `总体进度 33%`、`0 正在做 · 2 还没开始` | `总体进度 70%`、`1 正在做 · 0 还没开始` |
| 阶段徽标 | `第 2 步：第二波 … 正在做` | 同左；但它与上方统计条不能同时为真 |
| 子任务胶囊 | T2「做好了」、T3「正在做」 | 同左；与上方统计条不能同时为真 |
| Donut | `33%` | 至少不应与卡片 `33%` 一起被当成“实时” |

### 3.3 代码证据与机制

- 所有子任务状态写入都经过 `writeSubtaskStatus()`：`src/runtime.ts:361-366`。它只写 `record.statuses` 和 `updatedAt`，**不碰 `record.stats`**。
- `dispatchPlan` 只在每一轮并发波结束后重算：`src/runtime.ts:760`（`record.stats = computeStats(record.statuses)`），以及 `finally` 中再算一次：`src/runtime.ts:825`。
- 因此，从第一波波末到整个派发结束，`record.stats` 是**冻结快照**；而 `record.statuses` 在波内持续变化。窗口长度 = 后续所有波 + 子 Agent 运行时间，可能是分钟级。
- 序列化时直接取缓存：`src/runtime.ts:838`（`const stats = record.stats ?? computeStats(statuses)`）。
- UI 每 4000ms 轮询一次（`src/client.ts` 的 `usePlans`），所以错误画面是稳定可见的，不是瞬时闪烁。

### 3.4 复现概率与可见性

- 任何“第一波结束后还有状态变化”的计划：确定性 100%。
- 主界面常驻元素：顶部统计条、卡片进度行、Donut、组头汇总都读 `stats`；阶段徽标和子任务胶囊读 `statuses`。因此用户不需要点开详情就能看到矛盾。
- 原始会话 `session-91ec3273…` 有 6 个阶段、12 个子任务、6 轮预算续跑，天然处于多波结构；用户的截图投诉与此路径一致（截图原文件本轮未取得，故不引用其具体数字）。

### 3.5 根因

`statuses` 是唯一事实，`stats` 是派生缓存；但代码把缓存当成可独立维护的第二事实，且只在“波末”失效。跨波期间没有任何机制让两者对齐。

---

## 4. D2（P0）：同一份 payload 内 `stats` 与 `departments` 自相矛盾

### 4.1 用户/消费者看到什么

不需要 UI，只看服务端下发的一份 JSON：

```json
"stats": { "total": 3, "done": 1, "blocked": 0, "inProgress": 0, "pending": 2, "progress": 33 },
"departments": [
  { "id": "engineering", "total": 1, "done": 1, "blocked": 0, "inProgress": 0 },
  { "id": "qa",          "total": 1, "done": 1, "blocked": 0, "inProgress": 0 },
  { "id": "design",      "total": 1, "done": 0, "blocked": 0, "inProgress": 1 }
]
```

`stats.done=1` 与 `qa.done=1` 不可能同时成立（qa 一个部门就完成了 1 项）；`stats.inProgress=0` 与 `design.inProgress=1` 同样不可能同时成立。

### 4.2 观察到的错误值 vs 期望值

| 字段 | 观察到的错误值 | 期望值 |
| --- | --- | --- |
| `stats.done` | `1` | `2` |
| `stats.inProgress` | `0` | `1` |
| `stats.pending` | `2` | `0` |
| `departments[qa].done` | `1` | `1`（正确，实时聚合） |
| `departments[design].inProgress` | `1` | `1`（正确，实时聚合） |
| 同一响应的一致性 | 矛盾 | 所有聚合字段必须来自同一次 `computeStats(statuses)` |

### 4.3 代码证据与机制

- `serialisePlan()` 的 `stats` 走缓存：`src/runtime.ts:838`；
- 同一函数的 `departments` 却按 `statuses` 实时累加：`src/runtime.ts:843-857`（`if (item.status === 'done') current.done += 1` 等）。
- 这是**同一响应内的两套聚合逻辑**：一套读旧快照，一套读实时数组。即使把 D1 的冻结窗口缩到最短，这种“同报文矛盾”仍然会在每次序列化时出现，除非统一为一个派生结果。

### 4.4 复现概率与用户可见性

- 与 D1 同触发条件：确定性 100%。
- 普通用户看到的是 UI 矛盾；任何脚本、导出、第三方消费者读到的是 API 矛盾。它比 D1 更严重的地方在于：**即使不渲染 UI，数据本身已经坏了**。
- 修复验收必须直接比较 `stats` 与 `computeStats(payload.statuses)`，以及 `departments` 与按 statuses 聚合的结果。

---

## 5. D3（P1）：预算暂停产生 `pending + progress=100`

### 5.1 用户看到什么

本轮预算用尽，计划暂停：

- 卡片：`总体进度 100%`；
- 同一卡片：`0 正在做 · 1 还没开始`；
- Donut：`0%`（它按 `done/total` 算）；
- 任务明细里最后一项：状态「还没开始」，进度却是 100%，还带着上一轮的 `childId` 和开始时间。

用户会以为“已经 100% 完成了”，但实际上还有一项没做。原始会话第 6 轮下发的就是这一组合；按 `client.js` 的渲染逻辑，卡片会显示 `总体进度 100%`，而同屏 Donut 为 `0%`。

### 5.2 观察到的错误值 vs 期望值

场景 B 实测：

| 字段/界面 | 观察到的错误值 | 期望值 |
| --- | --- | --- |
| `statuses[0].status` | `pending` | `pending` |
| `statuses[0].progress` | `100` | `0` |
| `statuses[0].childId` | `child-hang` | `null` |
| `statuses[0].startedAt` | 非空 | `null` |
| `statuses[0].finishedAt` | `null` | `null` |
| `statuses[0].error` | `本轮预算用尽，等待续跑` | 同左 |
| `stats` | `{"total":1,"done":0,"blocked":0,"inProgress":0,"pending":1,"progress":100}` | `progress: 0` |
| UI 卡片 | `总体进度 100%` + `0 正在做 · 1 还没开始` | `总体进度 0%` |
| UI Donut | `0%` | `0%`；但不应与卡片 100% 同屏 |

原始会话真实数据（`session-91ec3273…`，解压后 JSONL 第 327 行 / `seq=325`，2026-10-27 21:20:36 CST）：

```json
"stats": {"total":12,"done":11,"blocked":0,"inProgress":0,"pending":1,"progress":100}
```

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

同一条消息的头部写着「完成 11/12……剩余 1 项未完成」。**这是原始会话内的真实记录，不是构造。**

### 5.3 代码证据与机制

预算耗尽分支在 `src/runtime.ts:780-791`：

```ts
record.statuses = record.statuses.map((item: any) => item.status === 'done'
  ? item
  : {
      ...item,
      status: 'pending',
      progress: item.progress ?? 0,
      error: '本轮预算用尽，等待续跑',
      summary: '',
      finishedAt: null,
    })
record.phase = 'paused'
```

它用对象展开**手工重写**状态，绕过了 `applyStatus()`；而 `applyStatus()` 在 `patch.status === 'pending'` 时会强制 `progress=0`、`startedAt=null`、`finishedAt=null`、`childId=null`（`src/plan.ts:1034-1074`）。两套“变成 pending”的规则不一致，于是产生了 `pending + 100` 这种非法组合。

随后 `finally` 里的 `computeStats(statuses)`（`src/runtime.ts:825`）如实把 `progress=100` 平均进 `stats.progress`，于是 100% 进入 UI。

### 5.4 复现概率与用户可见性

- 只要单轮预算在任一子任务执行中耗尽：确定性 100%。
- 默认单轮预算下限 60000ms；原始会话连续 6 轮都在预算边界暂停，说明这是常规路径。
- 用户可见性高：暂停画面正是用户会停下来检查“做到哪了”的时刻，此时给出 100% 最容易被误读为完成。

### 5.5 附带影响（不夸大）

残留的 `childId` / `startedAt` 与 `pending` 语义冲突，会让后续消费者无法区分“从未启动”与“启动过但被暂停”。本轮没有证据表明它会直接导致重复执行；这一点**未验证**，不写成已发生的后果。

---

## 6. D4（P1）：blocked 计划 resume 后 `stats.blocked` 残留

### 6.1 用户看到什么

一个 2 项都“卡住了”的计划被用户续跑，第一项已经重新开始执行：

- 顶部：`2 卡住了 · 0 正在做`；
- 卡片：`0 正在做 · 0 还没开始`；
- 子任务：T1「正在做」，T2「还没开始」。

三个地方三种说法。

### 6.2 观察到的错误值 vs 期望值

场景 C 实测：

| 字段/界面 | 观察到的错误值 | 期望值 |
| --- | --- | --- |
| `stats.blocked` | `2` | `0` |
| `stats.inProgress` | `0` | `1` |
| `stats.pending` | `0` | `1` |
| 实际计数 | `{done:0, blocked:0, inProgress:1, pending:1}` | 同左 |
| 顶部 | `2 卡住了 / 0 正在做` | `0 卡住了 / 1 正在做` |
| 卡片 | `0 正在做 · 0 还没开始` | `1 正在做 · 1 还没开始` |
| 子任务胶囊 | T1「正在做」 | 同左 |

### 6.3 代码证据与机制

- resume 分支：`src/runtime.ts:691`（`record.statuses = resetBlockedStatuses(record.statuses)`）之后，没有立即重算 `record.stats`。
- 紧接着 `src/runtime.ts:716` 把 `record.phase='executing'`，于是 UI 立即显示“执行中”，但统计仍停在 resume 前的 `blocked=2`。
- 直到第一波结束 `src/runtime.ts:760` 或 `finally` `src/runtime.ts:825` 才重算；如果第一个子任务运行较久，错误窗口同样是分钟级。
- `updateStatus()`（`src/runtime.ts:1169` 起）反而会同步重算 stats（`:1198`），说明代码里已经知道“写状态后要重算”，只是没有把这条规则落实到所有写入口。

### 6.4 复现概率与用户可见性

- 只要计划曾 blocked 且被 resume，并在第一波结束前读取：确定性 100%。
- 用户主动点“续跑”后最关心“是不是又跑起来了”，此时顶部仍说 2 个卡住，直接打击可信度。

---

## 7. 根因归纳（单一真相源原则）

### 7.1 事实链

```text
canonical: statuses[]  ──(writeSubtaskStatus, 波内实时写)──►  永远最新
                                  │
                                  │ 没有失效通知
                                  ▼
derived cache: stats  ──(只在 760 波末 / 825 finally 重算)──►  跨波冻结
                                  │
serialisePlan: stats 读缓存 ──────┘
              departments 读 statuses（843-857）──► 同一响应两套事实
                                  │
client: 顶部/卡片/Donut 读 stats；阶段徽标/胶囊读 statuses
                                  └──► 用户屏幕上同时出现两种事实
```

### 7.2 两个主根因 + 一个放大器

| 编号 | 根因 | 表现 |
| --- | --- | --- |
| R1 | `stats` 被当作可独立维护的第二真相源：写 `statuses` 时不失效，只在波末重算 | D1、D4 |
| R2 | 预算暂停手工重写 statuses，绕过 `applyStatus()` 的 pending 归一化 | D3 |
| R3（放大器） | `serialisePlan` 内 `stats` 读缓存、`departments` 读实时；客户端又分别信任两种来源 | D2 及全部 UI 矛盾 |

### 7.3 为什么“只在批次结束时偶然对齐”

- 每轮 `dispatchPlan` 结束时执行 `finally` 的 `record.stats = computeStats(record.statuses)`（`:825`）；
- 每个并发波结束时执行 `:760`；
- 因此只有在这些时刻，两个来源才短暂一致。其余时间 UI 轮询到的都是旧 `stats` + 新 `statuses`。

这与用户观察到的“截图里显示的数量和实际数量不一致”完全吻合，不是渲染库、缓存策略或浏览器问题。

### 7.4 设计文档早已规定单一来源

`docs/collapse-interaction-spec.md` 写明：

> `stats` 的唯一算法在服务端：`computeStats(statuses)`；`phase` 由 `planPhase` 单独判定。

`docs/status-grouping-ia.md` 也把 `stats.inProgress` 定义为 `status === 'in_progress'` 数。当前实现违反了自己文档里的不变量，属于实现缺陷，不是设计分歧。

---

## 8. 证据指纹

```text
plugin           <repo>
version          1.4.2
node             v26.9.0
src/runtime.ts   f4dc6fd33b3e511ff0bfbc5886a1d1ef2404d17f495c142e93e5174cd385b367
src/plan.ts      c3cfd5e760604c8cde3a2b9c57bc55b01b4755837257d09396d05bd269dd506e
lib/runtime.js   5f93ea0fa49b0cdc04819642d8626704b5918c8768e2982ebfa0603b355f9790
lib/plan.js      24455faea8791ba8e0ccec26c8d84cc98415ae0e6da881e9f60f5573b9418503
client.js        0c3ffd342a66da3a436633ba73b9d5b514200e9d91db3203f0a97bf7d5acd15d
package.json     b542c81034a24eb31cea016a93ef2716fc850787994cf8dd93c9e42ce8f05fad
```

- 无 git 仓库：`git rev-parse` 返回 `fatal: not a git repository`，因此用文件哈希 + 版本号绑定证据。
- 源码 mtime：`src/runtime.ts` 2026-10-26 21:24；构建产物 `lib/runtime.js`、`client.js` 2026-10-27 16:16。

---

## 9. 复现方式与验收探针

完整步骤见 [`docs/repro-count-inconsistency.md`](repro-count-inconsistency.md)。摘要：

```bash
cd <repo>
node scripts/repro-inconsistent-counts.ts              # 当前构建：exit 0，14 条复现断言全 PASS
node scripts/repro-inconsistent-counts.ts --expect-fixed  # 当前构建：exit 1，9 条不变量断言中 8 条 FAIL（departments 那条本就 PASS）
```

修复完成后，第二条命令必须变成 `exit 0`，且打印 `All single-source invariants hold.`。这应作为 T4 的硬验收门禁，而不是“看一眼 UI 差不多对了”。

---

## 10. 对修复方向的约束（交给 T3，不在本任务实施）

以下是**约束**，不是已经写好的补丁；T3 必须自行设计并让回归测试证明：

1. **单一派生点**：`stats` 只能由 `computeStats(statuses)` 得到；序列化时现算，或使用带失效机制的派生缓存。禁止在 `statuses` 写入后继续向客户端发送旧 `stats`。
2. **同一响应同一次派生**：`departments` 与 `stats` 必须来自同一次状态快照；不能一个读缓存、一个读实时。
3. **所有状态迁移统一入口**：预算暂停、resume、取消、`updateStatus`、子 Agent 回调都必须经过同一套状态迁移规则（尤其是 `pending` 的归一化）。
4. **不变量断言**：序列化前断言
   - `stats.total === statuses.length`；
   - 四状态计数与 `statuses` 逐一相等；
   - `pending` 项必须 `progress===0`、`childId===null`、`startedAt===null`；
   - `done` 项必须 `progress===100`；
   - `departments` 的聚合与 `statuses` 一致。
5. **回归测试**：把本脚本的三个场景移植为 `node:test`，并保留 `--expect-fixed` 作为独立探针；测试必须在修复前失败、修复后通过。
6. **客户端信任边界**：客户端继续只读服务端 `stats` 是可以的，但前提是服务端保证不变量；如果保留客户端二次聚合，必须与 `stats` 使用同一派生结果，不能各自维护。
7. **版本与变更记录**：按用户要求升级版本并写 CHANGELOG；本条属于 T3/T4 的交付，不在 T2 伪造。

---

## 11. 本轮未验证/未纳入分级的静态候选

以下两条是读代码时发现的可疑点，但**没有构造出运行态复现**，因此不计入 4 条缺陷，也不声称它们一定成立：

1. **运行中 `cancelPlan` 返回的 `stats` 可能是旧快照**：`src/runtime.ts:1249` 在 `record.dispatchPromise` 分支直接返回 `record.stats ?? computeStats(...)`。若取消时波内状态刚变、`finally` 尚未重算，返回值可能落后于 `statuses`。需要构造“取消瞬间”的时序才能验证。
2. **`planPhase` 把“有 done 但无 in_progress”判为 `executing`**：`src/plan.ts:1089-1095`。这可能是为了让主 Agent 收尾阶段仍显示“执行中”，但会让“全部子任务已 done、结果尚未写入”的计划显示为「正在做」；设计文档把该状态定义为 `integrating`，两者是否冲突需要产品口径确认。当前实现 `planPhase` 实际是先判全 done → `integrating`，因此只有“部分 done 且无 in_progress”才落 `executing`，属于边界语义问题，不是本轮主诉。

这两条建议 T3 在修复主问题时顺手加断言或测试确认；若确认成立，应另开缺陷编号并补“观察 vs 期望”，不要混入本报告的 4 条。

---

## 12. 结论

1. 用户的怀疑成立：插件确实存在多处逻辑不一致，且不是单点笔误。
2. 但根因高度集中：`stats` 作为派生缓存被当成第二真相源；预算暂停又绕过了统一的 pending 归一化。4 条缺陷是同一类错误在不同边界的表现。
3. 已用不依赖人工观察的脚本稳定复现 4 条缺陷，并在**原始会话的真实 payload** 中找到了 D3 的直接证据。
4. 当前版本 1.4.2 不应被视为“只是显示问题”；服务端下发的同一份 JSON 已经自相矛盾，修复必须从服务端单一派生点入手，不能只改前端文案。
5. 本报告不包含修复代码、不改版本号；修复、回归测试、版本升级与 CI 门禁属于后续任务。
