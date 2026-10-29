# dsh-workplan 状态-进度一致性矩阵与同类问题清单（T5）

- 角色：测试工程师（T5）
- 工作目录：`/Users/open/Documents/Stocks/plugins/dsh-workplan`
- 代码基线：git HEAD `b0e0b76`（1.5.1）；本报告不修改任何源码或测试
- 复现脚本：`scripts/scan-state-matrix.mjs`
- 复现命令：`cd /Users/open/Documents/Stocks/plugins/dsh-workplan && node scripts/scan-state-matrix.mjs > /tmp/t5scan.out`
- 输入依赖：T3 的数据流/状态机说明、T4 的根因结论（`docs/root-cause-phase-percent.md`）
- 说明：截图字面「正在做收尾」在本仓库源码与 locale 中不存在；实际文案是「正在收尾」。本报告按实际文案记录。

## 0. 结论摘要

1. **截图矛盾可复现且可归入一个更大的类**：`phase`（状态文案）与环百分比（`done/total`）是两套独立事实，二者之间没有任何联合不变量。全 done 时 `planPhase` 返回 `integrating`，环已 100%，于是「100% + 正在收尾」必然成立。
2. 本 T5 额外发现两类**更危险**的同类问题：
   - **执行中却显示终态文案**：当计划没有 `pending` 项但尚未全 done 时（单任务计划正在做，或所有剩余任务都在 `in_progress`），Guide 的「下一步」兜底输出「没有下一步，这件事已完成」，而同一张卡同时显示「正在做」和 0%–50%。
   - **取消终态不终态**：`cancelled` 卡被 Dashboard 在分组前过滤，用户根本看不到「已取消」，与 cancel 工具描述相反；取消后再来一次 no-op update，live 的 phase 会被重算回 `integrating`，卡片复活。
3. 枚举结果：仅由 `statuses` 可派生的 `(phase, 环百分比, 加权百分比)` 组合只有 **12 类**，已全部枚举；另加 5 类事件相位（`done`、`paused`、`cancelled`、`degraded`、无写入点的 `planning`）。不可达组合已在 §3.3 给出证明。
4. 冲突清单共 14 项：**P0 3 项、P1 8 项、P2 1 项、P3 2 项**；另有 2 项交叉引用 T4 已证实的缺陷。每项都有代码理由或本脚本的实测 DOM 证据。

---

## 1. 方法与证据强度

### 1.1 做了什么

1. **代码提取**：从 `src/plan.ts` 提取 `STATUSES`、`applyStatus`、`normaliseStatusEntry`、`deriveAggregates`、`planPhase`、`aggregateInvariantViolations`；从 `src/runtime.ts` 提取所有 `phase` 写入点、`serialisePlan`、`reconstructFromSession`、`updateStatus`、`cancelPlan`、`dispatchPlan`；从 `src/client.ts` 提取所有「是否完成」判断与百分比渲染。
2. **状态空间枚举**：对 n=1..3 的全部 `4^n` 子任务状态组合，`done` 固定 100、`pending` 固定 0、`in_progress`/`blocked` 取 progress ∈ {0,5,10,40,50,95,99,100}，用真实的 `derivePlanSnapshot` + `planPhase` + 与 `client.ts:1475` 相同的环口径计算 `(phase, ring, weighted)`，去重后得到 12 类结构组合。
3. **真实路径实测**：脚本不 mock 业务函数，使用构建后的 `lib/plan.js`、`lib/runtime.js`、`client.js`：
   - 工具路径：真实调用 `updateStatus`，并把同样的参数以 `tool/call` 事件写入会话，供 `reconstructFromSession` 回放；
   - 调度路径：真实调用 `dispatchPlan`（quick/fail/hang/delayed 子 Agent），覆盖 `blocked`、`paused`、`paused+100%`；
   - 取消/刷新：真实调用 `cancelPlan`、`plansPayload`、`reconstructFromSession`；
   - 渲染：用最小 React 桩加载真实 `client.js`，展开目标卡，抽取 `data-percent`、`data-state`、百分比、`now` 文案、徽章、阶段行、Guide、分组摘要等 DOM 事实。
4. **逐格判定**：对每个可达组合，按「同一张卡上是否同时出现互斥断言」判定；判定理由与实测场景一一对应（§4、§5）。

### 1.2 证据强度分级

| 级别 | 含义 | 本报告中的例子 |
|---|---|---|
| E1 实测（真实业务路径） | 真实 runtime + 真实 client 渲染得到的 DOM/相位 | `integrating`、`paused-partial`、`blocked-dispatch`、`cancelled-*` |
| E2 实测（真实函数、构造输入） | 真实函数处理人工记录 | `stale-pending`、`degraded`、`done` 的记录构造 |
| E3 代码证明 | 仅由代码分支与枚举可证，未单独跑 | `planning` 无写入点、不可达组合 |
| E4 未验证 | 需要额外故障注入或真实浏览器 | `paused-100` 的外部持续可见性、CSS 视觉 |

T5 的验收要求是「每个冲突格有判定理由或实测证据」；本报告对每个冲突项标注了 E 级别。

---

## 2. 事实源与派生规则

### 2.1 子任务状态与进度

- 状态唯一枚举：`src/plan.ts:25` `STATUSES = ['pending','in_progress','done','blocked']`。
- 工具 schema：`src/host.ts:78-128`，`status` 为四值枚举；`progress` 为 0..100 整数，描述「进度百分比；done 会自动置为 100」。
- `applyStatus`（`src/plan.ts:1034-1086`）的实际约束：
  - 只校验 `progress` 是 0..100 整数；
  - `done` 强制 progress=100；
  - `pending` 强制 progress=0 并清空 `startedAt/finishedAt/childId`；
  - `in_progress` 只补 `startedAt`，**不限制 progress**；
  - `blocked` 只补 `finishedAt`，**不限制 progress**。
- 因此合法但语义可疑的组合：`in_progress + 100`、`blocked + 任意 progress`。

### 2.2 进度有四个口径

| 口径 | 代码 | 公式 | 用途 |
|---|---|---|---|
| 环百分比 `ring` | `src/client.ts:1475` | `total>0 ? round(done/total*100) : null` | 大环、`data-percent`、TaskBars |
| 加权百分比 `weighted` | `src/plan.ts:1282-1300` | `round(Σ itemWeight/total)`；done=100，blocked/in_progress=clamp(progress)，pending=0 | 展开区「总体进度（加权）」 |
| 阶段触达 `reach` | `src/client.ts:1646` | `round((done+active+blocked)/total*100)` | PlanStepper 分段填充宽度 |
| 子任务进度 | `client.ts:1298-1322` | 仅 `in_progress` 显示 `progress%` | 子任务行「进度 N%」 |

四个口径没有任何相互约束。尤其 `reach` 把 `blocked` 当作「已触达」，因此 blocked 可以把阶段条填到 100%。

### 2.3 相位（phase）有两类来源

**A. 由 statuses 派生**：`src/plan.ts:1377-1383`

```text
statuses.length === 0                         -> pending
every status === done                         -> resultSeen ? done : integrating
some status === blocked                       -> blocked
some status === in_progress || done           -> executing
otherwise                                     -> pending
```

**B. 事件/生命周期直接写入**（不经过 `planPhase`）：

| phase | 写入点 | 触发 |
|---|---|---|
| `pending` | `runtime.ts:1664` | 新计划创建 |
| `executing` | `runtime.ts:717` | dispatchPlan 开始 |
| `paused` | `runtime.ts:803` | 本轮预算耗尽 |
| `blocked` | `runtime.ts:837` | dispatchPlan 非预算异常（非父级取消） |
| `cancelled` | `runtime.ts:870,1244,1257,1263,1272,1580` | 取消、回放取消、旧计划被取代 |
| `done` | `runtime.ts:1415` | `resultWritten && 全 done`，dispatchTool 后置 |
| `degraded` | `runtime.ts:1016,1166,1604,1642` | 回放/运行时降级 |
| `planning` | **无写入点** | 仅 locale、`phaseTone`、host 标签引用（死枚举） |

`serialisePlan`（`runtime.ts:868`）的规则是：

```text
phase = record.phase ?? (plan ? planPhase(statuses) : 'degraded')
if phase === 'pending' && !record.dispatchedAt && plan.createdAt 超过 10 分钟:
    phase = 'cancelled'
```

即：**内存中的 `record.phase` 一旦存在就完全绕过 statuses**；而环百分比每次都从 `done/total` 重算。两者在 payload 组装处汇合，却没有任何交叉校验。

### 2.4 七个独立的「完成」谓词

| 编号 | 谓词 | 代码 | 说明 |
|---|---|---|---|
| P1 | `ring === 100` | `client.ts:1475` | `done === total` |
| P2 | `planNow` 的完成分支 | `client.ts:1557` | `total>0 && done===total` |
| P3 | `phase === 'done'` | `plan.ts:1379` / `runtime.ts:1415` | 还要求 `resultSeen` 或 `resultWritten` |
| P4 | Guide 下一步「都做完了」 | `client.ts:1067` | `total>0 && done>=total`；否则兜底「没有下一步，这件事已完成」 |
| P5 | 阶段卡完成 | `client.ts:1348` | `done === items.length` |
| P6 | 阶段条填满 | `client.ts:1646` | `done+active+blocked === total` |
| P7 | 加权百分比 100 | `plan.ts:1282` | `done + blocked/in_progress 的 progress === total` |

这七个谓词在正常路径上可能同时为真（全 done），但**只要状态分布特殊就会分叉**。截图正是 P1 与 P3 分叉；本 T5 找到的 `nextText` 问题则是 P4 在全 done 之前就为真。

### 2.5 不变量校验的空白

`src/plan.ts:1318-1375` 的 `aggregateInvariantViolations` 目前只校验 I1–I7：

- total 等于 statuses 长度、四计数和等于 total、计数非负整数、progress 0..100；
- subtaskId 非空且唯一；
- pending 的 progress=0 且无 childId/startedAt/finishedAt；done 的 progress=100；
- 部门汇总一致。

**没有**校验：

- `ring` 与 `phase` 的联合关系；
- `weighted` 与 `done/total` 的关系；
- `blocked` / `in_progress` 的 progress 语义；
- `reach` 是否与 `ring` 一致；
- 文案谓词 P2/P4/P5/P6 是否与 P1/P3 一致；
- `cancelled`/`done` 是否为吸收态。

---

## 3. 可达性枚举

### 3.1 仅由 statuses 可派生的组合（12 类，完整）

枚举输入：n=1..3；每个子任务 4 种状态；done 固定 100、pending 固定 0、in_progress/blocked 取 8 个 progress 样本。去重后只有以下 12 类。计数为命中的输入组合数（含状态与 progress 样本），不是概率。

| # | phase | 环区间 | 加权区间 | 命中数 | 代表形态 | 是否存在冲突 |
|---|---|---|---|---|---|---|
| 1 | `blocked` | 0 | 0 | 25 | 全部 blocked@0 | 否（0% + 卡住一致） |
| 2 | `blocked` | 0 | 1–99 | 4337 | 全部 blocked@5 | 双口径差异，见 C6 |
| 3 | `blocked` | 0 | 100 | 38 | 全部 blocked@100 | **C6** |
| 4 | `blocked` | 1–99 | 1–99 | 627 | done + blocked@0 | 否（部分完成 + 卡住） |
| 5 | `blocked` | 1–99 | 100 | 37 | done + blocked@99/100 | **C6** |
| 6 | `executing` | 0 | 0 | 11 | in_progress@0 | 否（刚开始） |
| 7 | `executing` | 0 | 1–99 | 797 | in_progress@5 | 双口径差异，见 C6 |
| 8 | `executing` | 0 | 100 | 8 | 单任务 in_progress@100 | **C6/C8** |
| 9 | `executing` | 1–99 | 1–99 | 269 | done + pending | **C5**（若无 active） |
| 10 | `executing` | 1–99 | 100 | 19 | done + in_progress@99/100 | **C6/C8**；无 pending 时 **C2** |
| 11 | `integrating` | 100 | 100 | 3 | 全 done | **C1** |
| 12 | `pending` | 0 | 0 | 3 | 全 pending | 否（P3 的 `data-state` 见 C13） |

> 组合 1/2/3 的 phase 为 `blocked` 但环为 0：因为 `planPhase` 在「有 blocked」时优先于「有 done」之外的所有分支；只有 done 才能把环推高。

### 3.2 事件相位（不由 statuses 派生）

| phase | 可达路径 | 环可能值 | 加权可能值 | 冲突 |
|---|---|---|---|---|
| `done` | dispatchTool 后置：`resultWritten && 全 done` | 100 | 100 | 否（但可被 update 回退，见 §5 交叉引用） |
| `paused` | 预算耗尽，非 done 全部重置 pending | 0 或 1–99；竞态下 100 | 同环（竞态下 100） | **C4/C5/C9** |
| `cancelled` | cancelPlan / 回放 cancel / 旧计划被取代 | 0、1–99、100 均可 | 任意 | **C3** |
| `degraded` | plan=null、statuses=[] | `null`（—） | 0 | **C11** |
| `planning` | **无任何写入点** | 不适用 | 不适用 | 死枚举（C14） |

### 3.3 不可达组合与证明

| 声称的组合 | 不可达理由 |
|---|---|
| `pending` 且环 > 0 | `planPhase` 只有在无 done、无 blocked、无 in_progress 时才返回 pending；此时 done=0。 |
| `integrating` 且环 < 100 | `integrating` 要求 `every done`，故 done=total，环=100。 |
| `done` 且环 < 100 | 同上；且 `done` 额外要求结果已写。 |
| `blocked` 且环 = 100 | 环=100 要求 done=total，此时 `every done` 分支先返回（integrating/done），不会返回 blocked。 |
| `executing` 且环 = 100 | 同上，全 done 时不会返回 executing。 |
| `planning` | 源码无写入点（`runtime.ts` 全部 phase 赋值已 grep）；仅作为标签存在。 |
| `degraded` 且 total>0 | degraded 记录固定 `plan:null,statuses:[]`；若 statuses 非空，`planPhase` 会产生其他相位。 |
| `0% + 已完成`（phase=done 且环 0） | 不存在：done 强制 progress=100、且环=done/total。**但「文案声称已完成而数值 0–50%」是可达的，见 C2/C11。** |

---

## 4. 一致性矩阵

### 4.1 结构组合矩阵（phase × 环 × 加权）

判定标准：同一张卡的可读文本/数值是否包含互斥断言。`✔` 一致；`△` 仅双口径差异（有标签但无联合约束）；`✘` 冲突。

| # | phase | 环 | 加权 | 判定 | 实测场景 | 冲突项 |
|---|---|---|---|---|---|---|
| 1 | blocked | 0 | 0 | ✔ | 枚举（全部 blocked@0） | — |
| 2 | blocked | 0 | 1–99 | △ | `blocked-and-active`（0/20） | C6 |
| 3 | blocked | 0 | 100 | ✘ | `blocked-ring-0-weighted-100` | C6 |
| 4 | blocked | 1–99 | 1–99 | ✔ | `blocked-update`（50/50） | — |
| 5 | blocked | 1–99 | 100 | ✘ | `blocked-ring-50-weighted-100` | C6/C7 |
| 6 | executing | 0 | 0 | ✔ | 枚举（in_progress@0） | — |
| 7 | executing | 0 | 1–99 | △ | `executing-active-40`（0/20） | C6 |
| 8 | executing | 0 | 100 | ✘ | `executing-ring-0-weighted-100` | C2/C6/C8 |
| 9 | executing | 1–99 | 1–99 | ✘（无 active 时） | `executing-partial-done`（50/50） | C5 |
| 10 | executing | 1–99 | 100 | ✘ | `executing-ring-50-weighted-100` | C2/C6/C8 |
| 11 | integrating | 100 | 100 | ✘ | `integrating` | C1 |
| 12 | pending | 0 | 0 | ✔ | `pending` | C13（仅属性） |

> 组合 9 的 `executing` 若存在 active（例如 done + in_progress），则 `planNow` 显示「正在做」，C5 不触发；但只要没有 pending、也没有 active、done>0，就触发「还没开始」。因此矩阵的判定必须结合 `active/pending` 计数，不能只看三元组（§4.4 给出谓词条件）。

### 4.2 事件相位矩阵

| phase | 环 | 加权 | 实测场景 | 同一视图关键文本 | 判定 |
|---|---|---|---|---|---|
| done | 100 | 100 | `done` | 100% · 已完成 · 都做完了 · done 组 | ✔ |
| paused | 33 | 33 | `paused-partial` | 33% · 预算用完，可续跑 · 还没开始 · 阶段条 33 · 概览行「正在做」 | ✘ C5/C9 |
| paused | 0 | 0 | 预算立即耗尽（E3，代码路径，未单独跑） | 0% · 预算用完，可续跑 · 还没开始 | ✔（尚未完成属实） |
| paused | 100 | 100 | `paused-100` | 100% · 预算用完，可续跑 · 都做完了 | ✘ C4（边界） |
| cancelled | 任意 | 任意 | `cancelled-hidden` | 主面板无卡片、无分组、无「已取消」 | ✘ C3 |
| cancelled → update | 100 | 100 | `cancelled-resurrected` | 100% · 正在收尾 · 都做完了；回放仍是 cancelled | ✘ C3 |
| degraded | — | 0 | `degraded` | — · 安排失败 · 还没开始 · 下一步「没有下一步，这件事已完成」 | ✘ C11 |
| 过期 pending | — | — | `stale-pending` | 主面板无卡片；回放 pending+stale | ✘ C10 |

### 4.3 关键场景文本矩阵（实测）

缩写：`环`=大环文本；`加`=总体进度（加权）；`徽`=折叠卡徽章；`今`=planNow；`阶`=阶段卡徽章；`行`=PlanOverview 阶段行；`谁`=Guide 当前；`下`=Guide 下一步。

| 场景 | 环 | 加 | 徽 | 今 | 阶 | 行 | 谁 | 下 | 分组 |
|---|---|---|---|---|---|---|---|---|---|
| pending | 0% | 0 | 还没开始 | 还没开始 | 还没开始 | 还没开始 | 还没开始 | T1 | live 0% |
| executing-partial-done | 50% | 50 | 正在做 | **还没开始** | **还没开始** | 正在做 | **还没开始** | T2 | live 50% |
| executing-active-40 | 0% | 20 | 正在做 | 正在做 T1 | 正在做 | 正在做 | 正在做 T1 | T2 | live 0% |
| in-progress-100 | 0% | 50 | 正在做 | 正在做 T1 | 正在做 | 正在做 | 正在做 T1 | T2 | live 0% |
| executing-ring-0-weighted-100 | 0% | **100** | 正在做 | 正在做 T1 | 正在做 | 正在做 | 正在做 T1 | **已完成** | live 0% |
| executing-ring-50-weighted-100 | 50% | **100** | 正在做 | 正在做 T2 | 正在做 | 正在做 | 正在做 T2 | **已完成** | live 50% |
| integrating | 100% | 100 | **正在收尾** | 都做完了 | 都做完了 | 都做完了 | 都做完了 | 都做完了 | live **100%** |
| done | 100% | 100 | 已完成 | 都做完了 | 都做完了 | 都做完了 | 都做完了 | 都做完了 | done 100% |
| blocked-update | 50% | 50 | 卡住了 | 卡住了 T2 | 1 卡住了 | 卡住了 | 卡住了 T2 | 先处理 T2 | live 50% |
| blocked-ring-0-weighted-100 | 0% | **100** | 卡住了 | 卡住了 T1 | 1 卡住了 | 卡住了 | 卡住了 T1 | 先处理 T1 | live 0% |
| blocked-ring-50-weighted-100 | 50% | **100** | 卡住了 | 卡住了 T2 | 1 卡住了 | 卡住了 | 卡住了 T2 | 先处理 T2 | live 50% |
| blocked-dispatch | 33% | **67** | 卡住了 | 卡住了 T2 | 2 卡住了 | 卡住了 | 卡住了 T2 | 先处理 T2 | live 33% |
| paused-partial | 33% | 33 | 预算用完 | **还没开始** | **还没开始** | **正在做** | **还没开始** | T2 | live 33% |
| paused-100 | 100% | 100 | **预算用完** | 都做完了 | 都做完了 | 都做完了 | 都做完了 | 都做完了 | live 100% |
| cancelled-hidden | — | — | — | — | — | — | — | — | **无卡片** |
| cancelled-resurrected | 100% | 100 | 正在收尾 | 都做完了 | 都做完了 | 都做完了 | 都做完了 | 都做完了 | live 100% |
| stale-pending | — | — | — | — | — | — | — | — | **无卡片** |
| degraded | — | 0 | 安排失败 | 还没开始 | — | — | 还没开始 | **已完成** | live 0/0 |

加粗为冲突点。`—` 表示该区域未渲染或指标为 null。`先处理 T2` 是对 blocked 引导文案的缩写，原文更长，含「续跑这个计划」。

### 4.4 文本冲突的精确触发条件

| 文案/区域 | 触发条件（由代码推出） | 与哪个数值冲突 |
|---|---|---|
| `planNow` 显示「还没开始」 | `blocked===0 && active===0 && done>0 && done<total`（`client.ts:1558` 兜底） | 环 >0、阶段 meta `done/total` |
| 阶段卡徽章「还没开始」 | 同上；`StageCard` 用 `inProgress` 而不是 active 计数（`client.ts:1346-1350`） | 阶段 meta `done/total` |
| Guide 下一步「没有下一步，这件事已完成」 | `blocked===0`、无 pending、无 itemless entry、`done<total`（`client.ts:1064-1068`） | 环 0–99、`planNow`「正在做」 |
| 加权「总体进度 100%」 | `done + Σprogress(non-done) === total`（`plan.ts:1282`） | 环 <100、phase blocked/executing |
| 阶段条填满 | `done+active+blocked === total`（`client.ts:1646`） | 环 <100（blocked 被算作触达） |
| 徽章「预算用完，可续跑」 | `phase='paused'` | 环 100（全 done 竞态） |
| 徽章「正在收尾」 | `phase='integrating'` | 环 100、`planNow`「都做完了」 |
| 卡片消失 | `phase==='cancelled'` 被 `activeSessions` 过滤（`client.ts:2262`） | 取消工具承诺的「已取消」 |
| 卡片消失（过期） | `phase` 被 `serialisePlan` 改为 cancelled 后再被过滤 | `reconstructFromSession` 的 `stale:true` |

---

## 5. 同类问题清单（按严重度排序）

严重度定义：

- **P0**：同一用户视图内直接自相矛盾，或把终态/完成错误声明，会误导用户做决定。
- **P1**：同一卡片/区域出现两个互斥数值或文案，或状态不可见/可复活，但需要展开或特定路径才看到。
- **P2**：次级区域口径不一致，或低频状态下的误导。
- **P3**：样式/属性/死枚举，当前不影响用户可读结论，但会掩盖回归。

### P0

#### C1｜100% + 「正在收尾」+「都做完了」并存（截图主问题）

- 触发：全部子任务 done，结果消息尚未落盘（`resultSeen=false`）。`planPhase` 返回 `integrating`（`plan.ts:1377-1383`），环从 `done/total` 得 100（`client.ts:1475`）。
- 证据（E1，`integrating` 场景）：
  - `100% · 本计划 2/2 做好了 · 都做完了 · 正在收尾`；
  - `data-state="done"`、`data-percent="100"`；
  - 卡片仍在「进行中」组，组摘要「未完成 0 / 已完成 2（完成率 100%）」。
- 判定：同一张卡同时声称「100%/都做完了」与「正在收尾」，且 `data-state` 已判 done、分组仍判未完成。环、`planNow`、徽章、分组各自使用不同谓词（P1/P2/P3/分组），没有任何联合不变量。
- 根因关联：T4 主因；`percent` 与 `phase` 不同源，`done` 依赖结果写入副作用。

#### C2｜执行中却显示「没有下一步，这件事已完成」

- 触发：`phase='executing'`，没有 blocked，没有 pending，但尚未全 done。典型：
  - 单任务计划，该任务 `in_progress`；
  - 多任务计划中所有剩余任务同时 `in_progress`（并发 ≤3 时常见）。
- 代码：`client.ts:1064` 先找 pending 或 itemless entry；找不到后 `client.ts:1067` 判全 done 为假，`client.ts:1068` **无条件**返回 `helpNextDone`「没有下一步，这件事已完成」。
- 证据（E1）：
  - `executing-ring-0-weighted-100`：环 0%、加权 100%、徽章「正在做」、Guide 当前「正在做 T1」、下一步「**没有下一步，这件事已完成**」；
  - `executing-ring-50-weighted-100`：环 50%、徽章「正在做」、当前「正在做 T2」、下一步同样是「没有下一步，这件事已完成」。
- 判定：这是比 C1 更直接的「中间进度却显示终态」：同一张卡一边「正在做」，一边宣布「这件事已完成」。`helpNextDone` 本意是「没有下一步且无事可做」，但代码把它当成了「非全 done」的兜底。
- 影响：单任务计划是最常见形态之一；任何模型在任务执行中刷新面板都可能看到「已完成」。
- 与根因关系：`nextText` 自己实现了一套完成判断（P4），既不读 phase，也不读环，属于「多个独立完成判断」的又一实例。

#### C3｜取消终态不可见、且可被一次 no-op update 复活

- 触发 A（不可见）：`cancelPlan` 把 `record.phase='cancelled'`（`runtime.ts:1255-1275`），Dashboard 在分组前执行 `sessions.filter(phase!=='cancelled')`（`client.ts:2262-2264`），于是 cancelled 卡在两个组里都不出现。
- 触发 B（复活）：取消后调用 `updateStatus`；该函数**无条件**执行 `record.phase = planPhase(record.statuses)`（`runtime.ts:1209`），没有 `cancelled`/`done` 终态守卫，于是全 done 的计划从 `cancelled` 变回 `integrating`。
- 证据（E1）：
  - `cancelled-hidden`：payload `phase='cancelled'`，渲染 `hidden=true`、`groups=[]`，页面上没有任何「已取消」；
  - `cancelled-resurrected`：cancel 后一次 `update T1 done`，live `phase='integrating'`、100%、徽章「正在收尾」、卡片可见；`reconstructFromSession` 仍返回 `cancelled`（因为 cancel 事件是吸收的），live 与刷新后不一致。
- 判定：`cancelled` 既不是吸收态，也不是可见终态。host 的 cancel 工具描述（`host.ts`）明确说「取消后计划在面板中显示为『已取消』」，与实际行为相反。
- 影响：用户取消后看不到结果；刷新前后状态相反；模型可能继续对已取消计划 update。

### P1

#### C4｜100% + 「预算用完，可续跑」

- 触发：最后一个子任务在 deadline 之后完成。`dispatchPlan` 下一轮 while 先检查 `Date.now() >= deadline`（`runtime.ts:666-845`）并抛 `TOTAL_TIMEOUT`，进入预算分支；此时所有 statuses 已 done，非 done 集合为空，phase 仍被置为 `paused`，错误文案仍说「其余 0 项保留为未完成……可续跑」。
- 证据（E1，`paused-100`）：环/加权 100%、徽章「预算用完，可续跑」、`planNow`「都做完了」；回放为 `done`。
- 判定：100% 已完成与「预算用完、可续跑」互斥；同一计划 live 与 replay 相位不同。
- 外部可观测性（E4，未验证）：正常 `dispatchTool` 在结果 append 成功后同一 tick 就把 phase 置 `done`（无 await），因此该中间态通常不跨事件循环；**若结果消息写入失败**（append 抛错仅 warn），phase 会停在 `paused`，才可能持续可见。本场景是直接调用 `dispatchPlan` 后截取，未注入 append 失败，故标为「代码可达、外部持续可见性未验证」。
- 建议：预算分支必须先判断「是否已全部 done」；全 done 不得置 paused。

#### C5｜部分完成却显示「还没开始」

- 触发：`done>0`、`active===0`、`blocked===0`、尚未全 done。常见于：
  - `executing` 且剩余项都是 pending（T1 done + T2 pending）；
  - `paused`（预算把未完成项重置为 pending）。
- 代码：`planNow` 在无 blocked、无 active 后直接落到「还没开始」（`client.ts:1558`）；`StageCard` 在无 inProgress 时也落到 `phase.pending`（`client.ts:1350`）。
- 证据（E1）：
  - `executing-partial-done`：50%、`1/2 做好了`，但 `now`/阶段徽章/Guide 当前全是「还没开始」；
  - `paused-partial`：33%、`1/3 做好了`，`now`/阶段徽章/Guide 当前仍是「还没开始」。
- 判定：`planNow` 没有「部分完成」档；它把「没有正在做」误判成「还没开始」，与同一卡上的 50%/33% 和 `1/2`、`1/3` 直接冲突。

#### C6｜同一张卡两个「总进度」：环 vs 加权

- 触发：`in_progress` 或 `blocked` 带 progress（尤其 100）。环只算 done/total；加权把这些 progress 计入（`plan.ts:1282`），在展开区显示为「总体进度（加权）N%」（`client.ts:1711`）。
- 证据（E1）：
  - `executing-ring-0-weighted-100`：环 0%、加权 100%、徽章「正在做」；
  - `executing-ring-50-weighted-100`：环 50%、加权 100%；
  - `blocked-ring-0-weighted-100`：环 0%、加权 100%、徽章「卡住了」；
  - `blocked-ring-50-weighted-100`：环 50%、加权 100%；
  - `blocked-dispatch`：环 33%、加权 67%（done + blocked@100 + 级联 blocked@0）。
- 判定：两个数都叫「进度」，实测最多可差 100 个百分点（0% vs 100%；另有 50% vs 100%、33% vs 67%）；「总体进度（加权）100%」与「卡住了」「正在做」并排出现时，用户无法判断哪个代表完成。标签「加权」只解释了算法，没有解释语义差异，也没有任何不变量要求二者在完成态一致。
- 备注：这不一定是「错误」，但属于同一事实源缺失下的双口径冲突；T6 必须决定保留一个，或把加权明确改名为「投入/工作量」并禁止称「总体进度」。

#### C7｜阶段条被 blocked 填满：环 50% 而阶段条 100%

- 触发：存在 blocked 项时，`PlanStepper` 的 `reach=(done+active+blocked)/total`（`client.ts:1646`），blocked 被算作「触达」；只要 `tone!=='pending'`，`width=reach`（`client.ts:1647`）。
- 证据（E1）：
  - `blocked-update`：环 50%，stepper `data-width=100`；
  - `blocked-dispatch`：环 33%，stepper `data-width=100`；
  - `blocked-ring-50-weighted-100`：环 50%，stepper 100%。
- 判定：同一卡上环显示一半，阶段条却全满；阶段条是「阶段完成」的视觉断言，`blocked` 不等于完成。即便把 `reach` 解释为「已触达」，UI 也没有说明，且与环的「完成」语义冲突。

#### C8｜子任务 `in_progress` + 进度 100%

- 触发：工具允许 `status=in_progress, progress=100`；`applyStatus` 只校验 0..100，不会把 in_progress 的 100 改为 done（`plan.ts:1034-1086`）。
- 证据（E1）：
  - `in-progress-100`：子任务行显示「正在做」+「进度 100%」，计划环 0%、加权 50%；
  - `executing-ring-0-weighted-100`：单任务同样如此，且加权 100%。
- 判定：子任务自身「正在做 + 100%」已矛盾；计划层又出现「0% 环 / 100% 加权」。工具描述没有禁止该组合，模型可以合法写入。
- 建议：`in_progress` 的 progress 上限应 <100，或 100 自动晋升 done；二者必须选一个并在 schema/applyStatus/不变量三处一致。

#### C9｜`paused` 时阶段行「正在做」而阶段卡「还没开始」

- 触发：预算暂停把未完成项重置为 pending，`done>0`；`planStageRows` 的 tone 只要 `done>0` 就为 active（`client.ts:1509-1535`），而 `StageCard` 只有在 `inProgress` 时才 active，否则 idle（`client.ts:1339-1350`）。
- 证据（E1，`paused-partial`）：PlanOverview 阶段行 state「正在做」；StageCard 徽章「还没开始」；环 33%；stepper width 33。
- 判定：同一阶段在概览行与阶段卡上分别被判为「正在做」和「还没开始」，两者都与「1/3 做好了」不一致。这证明阶段层的完成判断也有两套（P5 与行 tone）。

#### C10｜过期 pending 被序列化成 cancelled，卡片消失，与回放 `stale:true` 矛盾

- 触发：`phase==='pending'`、`!record.dispatchedAt`、计划创建超过 10 分钟（`runtime.ts:868-870`，`STALE_PENDING_MS` 见 `runtime.ts:79`）。`reconstructFromSession` 已改为返回 `phase='pending', stale=true`（`runtime.ts:1037-1046`），但其返回对象没有 `dispatchedAt`，`serialisePlan` 仍会把它改成 `cancelled`；随后 Dashboard 过滤 cancelled。
- 证据（E1，`stale-pending`）：payload `phase='cancelled'`、`hidden=true`、`groups=[]`；同一会话的 `reconstructFromSession` 返回 `phase='pending'`、`stale=true`。
- 判定：回放层认为「这是过期未派发，应提示 stale」，序列化层却把它变成「已取消」并隐藏；两个模块对同一事实给出相反语义。用户看不到这个计划，也无法区分「从未派发」和「已取消」。
- 备注：旧计划被新计划取代时 `runtime.ts:1580` 也写 cancelled，这属于真正的取代；与 stale 的 10 分钟规则混在一起，进一步降低可解释性。

#### C11｜降级计划显示「没有下一步，这件事已完成」

- 触发：planner 失败/无路由 → `plan=null,statuses=[],phase='degraded'`；Guide 的 `nextText` 找不到 pending、也没有 itemless entry，`stats.total=0`，于是落到 `helpNextDone`「没有下一步，这件事已完成」。
- 证据（E1，`degraded`）：环「—」、`0/0`、徽章「安排失败」、`now`「还没开始」、Guide 下一步「没有下一步，这件事已完成」。
- 判定：安排失败（根本没有计划）却说「这件事已完成」；`0/0` 与「已完成」也互斥。
- 备注：`degraded` 是低频路径，但它是「文案兜底没有完成语义」的清晰证据，修复 `nextText` 时应一并覆盖。

### P2

#### C12｜blocked 与 in_progress 并存时，两个区域各说一个「现在」

- 触发：同一计划同时有 blocked 与 in_progress。
- 代码：`planNow` 先判 blocked（`client.ts:1549`），Guide 的 `workerText` 先找 in_progress（`client.ts:1030-1034`）。
- 证据（E1，`blocked-and-active`）：`now`「卡住了 · T1」，Guide 当前「质量验证 · T2」（正在做），环 0%、加权 20%、子任务 T2 40%。
- 判定：用户在同一屏看到「现在卡住了 T1」和「现在正在做 T2」，没有说明两者可以同时成立；优先级不同导致两个「当前」口径。属于呈现层多事实源的次级表现。

### P3

#### C13｜0% 的 pending 卡带 `data-state="active"`

- 触发：`PlanViz` 的 state 只看 `percent===null`、`blocked>0`、`percent>=100`（`client.ts:1666-1671`），没有读 phase；`pending` 且 0% 落到 `active`。
- 证据（E1，`pending`）：`data-percent="0"`、`data-state="active"`。
- 判定：视觉/ARIA 属性把「还没开始」标成 active；用户可读文本仍为「还没开始」，故列为 P3，但它证明「状态属性」也没有读 phase。

#### C14｜`planning` 是死枚举

- 触发：`phaseTone`、locale、host 标签均包含 `planning`，但 `runtime.ts` 所有 phase 赋值点没有 `planning`（grep 证据）。
- 判定：当前不可达，不构成用户可见冲突；但它会让「状态枚举完整性」检查误以为 planning 可达，属于矩阵盲区。若未来加入 planning，必须同时定义它与 percent/text 的约束。

### 交叉引用（T4 已证实，T5 未重复实测）

- **X1｜done → integrating 回退**：`updateStatus` 不传 `resultSeen`，对已 done 计划执行一次 no-op update 会把 phase 打回 integrating；`done` 不是吸收态。见 T4 报告 H3/F4。
- **X2｜live 与 replay 相位分叉**：内存 `record.phase` 优先于回放 `planPhase(statuses,resultSeen)`；本 T5 的 `cancelled-resurrected` 与 `stale-pending` 是同一结构在取消/stale 场景下的两个实例。

---

## 6. 对修复的硬约束（供 T6 使用）

T5 不负责修复，但矩阵给出以下验收约束；任何修复都必须让这些约束可测。

### 6.1 单一 selector

用一个函数从同一份 `statuses + 事件态` 派生**全部**对外事实：

```text
derivePlanView(statuses, eventPhase, resultSeen) -> {
  done, total, percent, weighted,
  completion: 'empty' | 'not_started' | 'partial' | 'active' | 'blocked'
            | 'settling' | 'completed' | 'paused' | 'cancelled' | 'degraded',
  nowText, nextText, stageText, badge, group, terminal
}
```

禁止在 `client.ts` 里再用 `done===total`、`percent>=100`、`stats.done>=total`、`inProgress` 等独立条件决定文案。

### 6.2 必须新增的不变量（建议 I8–I12）

1. `ring === (total>0 ? round(done/total*100) : null)` 且 `ring===100 ⇔ done===total`。
2. `phase==='done' ⇒ ring===100`；`phase==='integrating' ⇒ ring===100`；`ring<100 ⇒ phase∉{done,integrating}`。
3. `phase==='paused'` 时若 `ring===100`，必须改为 `done`（或明确输出「已完成，预算未使用」而不是「可续跑」）。
4. `nowText/nextText/stageText` 的「完成」语义只能由 `completion==='completed'` 产生；`nextText` 不得在 `done<total` 时返回完成文案。
5. `cancelled`/`done` 为吸收态：`updateStatus`/`cancelPlan` 对终态不得把 phase 改回非终态；或明确允许「取消后恢复」但要有独立 transition 和 UI 提示。
6. `weighted` 与 `ring` 若同时展示，必须满足：`weighted===100 ⇒ (ring===100 或 completion==='blocked' 且显式说明)`；更推荐只保留一个「进度」，把另一个改名为「投入」。
7. `reach` 不得把 blocked 算作完成；阶段条要么用 done/total，要么标注为「已触达」并与环分栏。
8. `blocked` 的 progress 统一：要么冻结为最后进度（<100），要么恒 100；`updateStatus` 与 dispatch 失败/级联必须同口径。
9. `in_progress` 的 progress 必须 <100；100 自动晋升 done，或工具拒绝。
10. `serialisePlan` 与 `reconstructFromSession` 对 stale 的判定必须一致；不得在序列化层把 pending 改成 cancelled 后又被 UI 过滤。

### 6.3 必须保留的回归用例

`scripts/scan-state-matrix.mjs` 的 19 个场景可直接作为回归基线。至少断言：

- `executing-ring-0-weighted-100` / `executing-ring-50-weighted-100`：`nextText` 不得包含「已完成」；应给出「正在做 T1」或「等待续跑」。
- `paused-partial`：`nowText`/阶段徽章不得是「还没开始」；应为「已暂停，1/3 已完成」之类的单一语义。
- `blocked-ring-*`：加权 100 时不得显示「总体进度 100%」而不解释卡住；或干脆不显示加权。
- `blocked-update`：stepper 不得 100 而环 50；应使用 done/total 或标注触达。
- `cancelled-hidden`/`cancelled-resurrected`：取消后卡片应在「已完成/已取消」组可见，或工具描述改为「不显示」；update 不得把 phase 拉回。
- `stale-pending`：payload 与 replay 的 phase 必须一致；不能静默消失。
- `degraded`：`nextText` 不得是「没有下一步，这件事已完成」；应为「安排失败，请重试/补充信息」。

---

## 7. 覆盖范围、盲区与未验证项

### 7.1 已覆盖

- 4 种子任务状态 × 3 个进度区间（0、1–99、100）的全部结构组合（n≤3 穷举 + 12 类去重）。
- 7 个用户可见区域：大环、`data-state`、`planNow`、阶段卡、PlanOverview 行/加权、PlanStepper、Guide、分组摘要、子任务行。
- 8 个相位：pending/executing/integrating/done/blocked/paused/cancelled/degraded；planning 证明不可达。
- 19 个场景（含真实 dispatch、真实 cancel、真实 update、回放对照；`stale-pending` 与 `degraded` 为真实函数处理构造记录）。

### 7.2 盲区

1. **n>3 的精确计数未穷举**：结构组合按谓词去重，理论上 n>3 不会产生新的 `(phase, ring区间, weighted区间)` 类，但未对每个 n 做完整数值枚举。可用同一脚本扩展 n=4..6 复核。
2. **`paused-100` 的外部持续可见性未验证**：需要注入结果消息 append 失败，或捕获真实 dispatchTool 的中间帧；本报告标为 E4。
3. **TurnCard 未渲染**：脚本只渲染 Dashboard 主面板；TurnCard（`client.ts:2394-2418`）不过滤 cancelled，可能在会话内显示「已取消」，造成同一计划在主面板与会话内表现不同。未实测。
4. **多会话/分组聚合**：只测单会话；`MAX_LIVE_SESSIONS`、多计划分组的 `groupTotals` 已完成度、组内混合相位未测。
5. **plan mode / 未派发旧计划被取代**：`runtime.ts:1580` 的 cancelled 分支未单独跑；它与 stale 的语义重叠，需在 T6 一起决定。
6. **真实浏览器 CSS/动效**：React 桩只验证 DOM 文本与 `data-*`，不验证颜色、折叠动画、窄屏截断。
7. **工具调用时序**：`updateStatus` 是直接调用，未通过模型工具往返；但参数与 `tool/call` 回放同源，业务函数一致。

### 7.3 未验证/未复现的原始说法

- 截图字面「正在做收尾」在本仓库/构建物/git 历史中不存在（T4 已注明）；实际 locale 为「正在收尾」。若截图来自其他构建，T5 无法证实。
- T4 的 U2（截图触发路径 P2a/P2b 唯一性）仍依赖原始会话日志；T5 不重复推断。

---

## 8. 附：复现与核对

```bash
# 运行全部 19 个场景 + 12 类结构枚举；退出码应为 0
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
node scripts/scan-state-matrix.mjs

# 只保留汇总行（每场景一行 JSON）
node scripts/scan-state-matrix.mjs | sed -n '/## 全场景汇总/,$p'
```

脚本输出中每个场景包含：

- `payload`：真实 `plansPayload` 的 phase/statuses/stats；
- `replay`：`reconstructFromSession` 的 phase/stale/statuses；
- `dom`：`data-percent`、`data-state`、`pctText`、`nowText`、徽章、阶段卡、加权文本、阶段行、stepper width、子任务进度、Guide；
- `groups`：分组摘要；
- `hidden`：是否被 `activeSessions` 过滤。

核对要点：

1. `integrating` 场景应出现 `pctText=100%`、`badge=正在收尾`、`nowText=都做完了`。
2. `executing-ring-50-weighted-100` 的 `guide.next` 应为「没有下一步，这件事已完成」，而 `nowText=正在做 · 子任务 T2`。
3. `cancelled-hidden` 的 `hidden=true`、`groups=[]`；`cancelled-resurrected` 的 `phase=integrating`、`replay.phase=cancelled`。
4. `paused-partial` 的 `pctText=33%`、`nowText=还没开始`、`stageCollapses[0].meta=1/3 做好了`。
5. `blocked-update` 的 `stepper[0].width=100`，同时 `pctText=50%`。
6. `degraded` 的 `guide.next=没有下一步，这件事已完成`，`pctText=—`。

---

## 9. 一句话交给主 Agent

截图不是孤例：插件把「数值完成」「相位完成」「文案完成」「阶段条完成」「加权完成」分别实现，且不变量只校验 stats 内部。T5 已枚举全部 12 类结构组合并实测 19 个场景，确认 3 个 P0（原截图、执行中谎称已完成、取消不可见/可复活）、8 个 P1；修复必须让所有完成语义从一个 selector 派生，并用 §6.2 的联合不变量把「100% ⇒ 不得显示进行中文案」「未全 done ⇒ 不得显示完成文案」锁死。
