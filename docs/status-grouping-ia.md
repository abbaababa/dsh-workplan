# dsh-workplan「任务进度」进行中 / 已完成分组与图表设计

> 子任务：T4 设计状态分组结构与图表选型（交互设计师）  
> 状态：设计提案 v1；T4 运行期间 T5 已并行进入实现（见下方快照提示）；另列 2 个待用户确认的偏好（见 §10）  
> 设计快照：`dsh-workplan@1.3.7`（`package.json`，未升版本；版本升级由 T5/主 Agent 执行）  
> 证据口径：T2 的字段结论 + 本任务直接复核的源码行号；**没有**线上真实计划样本（T2 实测接口 401），因此本文不给出任何“实际截图效果”或“已通过测试”的断言。

> **快照变更提示（T4 运行期间）**：本设计开始时快照为 `dsh-workplan@1.3.7`、`src/client.ts` 1384 行；约 12:48–12:57 工作区被并行修改，当前 `package.json` 已是 `1.4.0`、`src/client.ts` 1910 行，并已出现 `v1.4.0 — status grouping` 样式与 `SessionGroup`（`src/client.ts:367`、`src/client.ts:1444`）。这些修改**不是 T4 执行**的，T4 也未运行构建/测试/安装。本文所有 `src/*.ts` 行号是 1.3.7 快照的历史证据；若当前文件行号已偏移，请以函数名/代码片段重新定位，勿把行号当现状。设计结论仍按 1.3.7 基线给出；并行实现是否与本文一致，需主 Agent/T5 核对。

---

## 0. 结论先行

1. **分组只有两类**：`phase === 'done'` 进入「已完成」；**其余所有非取消阶段**（`pending / planning / executing / integrating / paused / blocked / degraded`）进入「进行中」；`cancelled` 继续完全不计入（与现有统计口径一致）。其中 `planning` 是客户端保留的兼容值，本快照服务端不产生；服务端实际可产生 8 个 phase 值（见 §2.1）。
2. **「进行中」置顶、始终展开；「已完成」置后、有进行中任务时默认折叠**；没有进行中任务时自动展开一次。折叠不是不渲染：已完成卡片仍保留在 DOM 中，只是面板 `hidden`，这样既有测试和无障碍/状态保持都不被破坏。
3. **图表不推翻现有总览**：保留现有 5 格统计条、状态分布环、每任务进度条；新增 **组头完成率环** 与 **卡片四段状态条**，已完成卡片改为紧凑行。所有图形只使用 T2 已确认字段，不引入新接口。
4. **视觉差异点至少 6 处**：位置（置顶/置后）、颜色（橙/蓝）、图标（脉冲/对勾）、文案（进行中/已完成）、形状（四段条/满环）、层级（全高卡/紧凑行）。详见 §6.4。
5. **零依赖**：全部用现有 SVG + CSS 变量；不新增 npm 包、不新增网络请求、不新增颜色变量。
6. **待确认偏好**：① 已完成组是否默认折叠（推荐折叠）；② 组头环的数字用“完成件数比”还是“平均进度”（推荐完成件数比）。若用户另有偏好，只需改这两处，不影响分组骨架。

---

## 1. 目标、范围与不做什么

### 1.1 目标

- 用户打开“任务进度”后，**不用读状态文字**也能一眼看出：哪些任务还在进行、哪些已经完成。
- 进行中的任务优先出现在视野里；已完成任务不抢注意力，但可随时展开查看。
- 用“组头环 + 状态分段条 + 紧凑完成行”把“完成度”和“状态构成”变成可比较的图形，而不是再堆一层文字。
- 设计必须能由 T5 在**不新增依赖、不改后端字段**的前提下落地，并兼容现有 `client-render` / `session-collapse` / `locale` 测试。

### 1.2 不做（本子任务）

- 不修改 `src/client.ts`、`src/plan.ts`、`src/runtime.ts`；不构建、不安装、不重启服务（这些是 T5/主 Agent 的步骤）。
- 不新增“优先级 / 预计完成时间 / 历史趋势”等字段；现有数据没有这些字段。
- 不把「已完成」等同于“所有子任务都 done”：`integrating` 即使子任务全完成，计划仍未 `done`，仍归「进行中」。
- 不改 `cancelled` 的过滤逻辑；不改全局统计分母。
- 不做浏览器截图验收（当前无法取得真实计划样本；T2 已实测 `/dsh-workplan/plans` 返回 401）。真实视觉验收由主 Agent 在安装重启后执行，步骤见 §11.3。

---

## 2. 设计依据：已确认的数据与现状

### 2.1 分组与图表可用的字段（全部有源码出处）

| 字段 | 层级 | 取值 / 含义 | 代码出处 | 本设计中的用途 |
|---|---|---|---|---|
| `phase` | Session | 客户端识别 9 个值：`pending / planning / executing / integrating / paused / blocked / degraded / cancelled / done`；**本快照服务端可产生 8 个**（无 `planning`），`planning` 仅是客户端 locale/兼容兜底 | `src/runtime.ts:862` 下发；`src/runtime.ts:839` 取 `record.phase` 否则 `planPhase`；`src/plan.ts:1089-1095` 计算基础 5 值，`paused/degraded/cancelled` 由 runtime 覆盖 | **唯一分组依据**；组头计数、需处理徽章、卡片状态胶囊、排序 |
| `stats.total` | Session | 子任务总数 | `src/plan.ts:1077-1087` 汇总；`src/runtime.ts:871` 下发 | 组/全局完成率分母、四段条总长、文案“N 件工作” |
| `stats.done` | Session | `status === 'done'` 数 | 同上 | 完成率分子；四段条蓝色段；文案“N 件做好了” |
| `stats.inProgress` | Session | `status === 'in_progress'` 数 | 同上 | 四段条橙色段；文案“N 件正在做” |
| `stats.blocked` | Session | `status === 'blocked'` 数 | 同上 | 四段条红色段；卡片“N 卡住了” |
| `stats.pending` | Session | `status === 'pending'` 数（`createStatuses` 会为缺记录的 subtask 补 pending） | 同上 | 四段条灰色段；文案“N 件还没开始” |
| `stats.progress` | Session | 平均进度：`Math.round(Σstatuses[].progress / total)`，**不是完成件数比**，也不是按状态加权 | `src/plan.ts:1077-1087` 的 `computeStats`（`progress` 计算在 `:1083-1085`）；`src/runtime.ts:871` 下发 | 只在现有卡片详情“总体进度”里保留；**本设计新增图形不用它**，避免与完成件数比混淆 |
| `statuses[].status` | Subtask | `pending / in_progress / blocked / done` 四值封闭集合 | `src/plan.ts:1034-1074`；`src/runtime.ts:870` 下发 | 现有任务明细；不直接画新图（组头用 `stats` 聚合） |
| `statuses[].finishedAt` | Subtask | 状态落定时间（毫秒）：`done` 写入；`blocked` 也可能写入；`pending` 重置为 null | 同上 | 计算“最近完成”排序时间；没有 Session 级 `completedAt`，所以这是近似值 |
| `title` | Session | 计划标题，兜底“任务进度” | `src/runtime.ts:861` | 组头“最近完成：<标题>”；卡片标题 |
| `sessionId` | Session | 会话 id，也是卡片 DOM id 的一部分 | `src/runtime.ts:859`；`src/client.ts:1187` | 折叠/滚动锚点；不要新造 id |
| `createdAt` | Session | 计划创建时间 | `src/runtime.ts:866` | 组内同优先级排序 |
| `updatedAt` | Session | 最近更新时间 | `src/runtime.ts:867` | 已完成排序兜底；“最近更新” |
| `departments[].{done,total,blocked}` | Session | 部门聚合，无百分比 | `src/runtime.ts:884`；`src/client.ts:1233-1235` | 现有卡片详情部门条**保持不变**；不用于新组头 |
| `resumeAvailable / resumeCount / resumeLimit` | Session | 续跑状态 | `src/runtime.ts:877-882` | 现有卡片操作**保持不变**；不用于分组 |

**明确不存在的字段（不得在设计中假装存在）**：Session 级 `completedAt`、`priority`、`estimate`、历史状态时间线、每个计划的“完成百分比”字段。需要“完成时间”时只能用 `statuses[].finishedAt` 的最大值，兜底 `updatedAt`。

### 2.2 现状（为什么需要改）

- 当前渲染层已有 `phase`、`stats`、`statuses`，但只做“每个计划一张卡”的平铺列表；没有 `phase === 'done'` 的分组（`src/client.ts:1354-1434`）。
- 现有卡片摘要已经显示“本计划 X/Y 做好了”“N 卡住了”、迷你条和阶段胶囊（`src/client.ts:1187-1254`），但**进行中与已完成在同一列表、同一视觉权重**，已完成任务仍然占据同样的高度和注意力。
- 现有总览已有一个四段状态环（`Donut`，`src/client.ts:1258-1320`）和一个每任务进度条（`TaskBars`，`src/client.ts:1322-1352`）；本设计复用它们，不重复造第三套总览。
- 取消计划在 Dashboard 入口已过滤（`src/client.ts:1377-1380`，`phase !== 'cancelled'`）；分组必须沿用同一过滤，否则会改变现有计数。

### 2.3 与旧文档的冲突（必须显式覆盖）

`docs/collapse-interaction-spec.md` 没有一条字面写着“禁止按 phase 分组”，但有两处硬约束会与本次设计冲突，必须显式更新，不能悄悄绕过：

- §10「给实现方的接线要点」写“`Dashboard` 的 `activeSessions`/`totals`/统计条……不动”。本设计会把 `activeSessions` 拆成 `visibleSessions / activeSessions / completedSessions`，并新增组头；`totals` 与统计条的数值口径不变，但变量语义会变。
- §11「不做项清单」写“不做第三级折叠（步骤列表整体、单条具体工作）”“不新增 locale 文案”。本设计新增“已完成组”这一层折叠（层级变为 组 → 卡片 → 步骤），并新增组头文案 key；这两条旧约束需要按本设计更新，否则实现会自相矛盾。

单卡片折叠与“卡片 → 步骤”两级折叠仍保留。若用户不接受多一层组折叠，备选是**只把已完成置后 + 紧凑行，不给组加折叠**（任务允许“折叠或置后”二选一）；推荐方案仍保留组折叠，因为“已完成默认收起”对“进行中优先”更有效。T5 应把上述覆盖写回旧文档，避免后续读者按旧结论实现。

---

## 3. 信息架构：分组规则

### 3.1 分区

```
visibleSessions   = sessions.filter(s => s.phase !== 'cancelled')   // 沿用现有口径
activeSessions    = visibleSessions.filter(s => s.phase !== 'done')  // 进行中（含 integrating / blocked / paused / degraded / pending / planning / executing）
completedSessions = visibleSessions.filter(s => s.phase === 'done')  // 已完成
```

- **只有 `done` 算已完成**；`integrating` 虽然子任务可能全 done，仍是“进行中·收尾”。
- `cancelled` 不进入任何组；全局统计条、总览环、任务条的分母都不变（仍只统计 `visibleSessions`）。
- `degraded`（自动分解失败，`plan` 为 null）进入进行中，因为用户还需要处理；它的 `stats.total` 可能为 0，组头环显示“—”。

### 3.2 9 个 phase 的映射（完整，无遗漏）

| phase | 分组 | 卡片状态胶囊文案（现有 key） | 组头/排序备注（数字越小越靠前） |
|---|---|---|---|
| `pending` | 进行中 | 等待派发（`phase.pending`） | `phaseRank = 5` |
| `planning` | 进行中 | 规划中（`phase.planning`） | `phaseRank = 4`；**本快照服务端不产生**，仅客户端兼容值，仍按“进行中”兜底 |
| `executing` | 进行中 | 正在做（`phase.executing`） | `phaseRank = 2` |
| `integrating` | 进行中 | 正在收尾（`phase.integrating`） | `phaseRank = 3`；可能 100% 工作项完成，但不算已完成 |
| `paused` | 进行中 | 已暂停（`phase.paused`） | `phaseRank = 1`；计入“需处理”（琥珀） |
| `blocked` | 进行中 | 卡住了（`phase.blocked`） | `phaseRank = 0`；计入“需处理”（红），最优先 |
| `degraded` | 进行中 | 自动分解失败（`phase.degraded`） | `phaseRank = 1`；计入“需处理”（琥珀，沿用 `phaseTone` 的 warn）；环可能无数据 |
| `cancelled` | 不显示 | 已取消（`phase.cancelled`） | 继续过滤，不进入任何组 |
| `done` | 已完成 | 已完成（`phase.done`） | 已完成组另排：最近完成在前 |

> 为什么不把 `paused` 当成“已完成”？因为它只是停住，用户可能还要续跑；放进已完成会误导。为什么不把 `integrating` 当成“已完成”？因为计划收尾尚未完成，主 Agent 还要集成结果；放到已完成会让“已完成”组出现仍需关注的任务。

### 3.3 组内排序

**进行中（`activeSessions`）**按“需要处理优先，其次新建优先”：

```
phaseRank = { blocked: 0, paused: 1, degraded: 1, executing: 2, integrating: 3, planning: 4, pending: 5 }
sort(activeSessions, (a,b) =>
  phaseRank[a.phase] - phaseRank[b.phase] ||
  (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
  String(a.sessionId).localeCompare(String(b.sessionId))
)
```

- 为什么 `blocked/paused/degraded` 置顶：它们是“需要用户/主 Agent 动手”的任务；先看到卡住/暂停/失败，符合“突出重点”。
- 为什么同优先级用 `createdAt` 倒序：不引入新字段；最新计划通常更相关；`sessionId` 只做稳定兜底。
- `integrating` 排在 `executing` 之后：它不需要用户操作，但仍是进行中；排在 `planning/pending` 之前，因为更接近完成。

**已完成（`completedSessions`）**按“最近完成在前”：

```
finishedAt(session) = max(statuses[].finishedAt, 忽略 null/非数字) ?? updatedAt ?? createdAt ?? 0
sort(completedSessions, (a,b) => finishedAt(b) - finishedAt(a) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
```

- 没有 Session 级完成时间，所以用子任务最新 `finishedAt` 兜底 `updatedAt`；这是明确的近似，不伪装成精确值。
- 已完成组头“最近完成：<completedSessions[0].title>”直接来自该排序，不另算。

### 3.4 边界情况

| 场景 | 行为 |
|---|---|
| 0 个可见计划 | 维持现有空状态；不渲染分组头（避免两个空组） |
| 只有进行中 | 进行中组有内容；已完成组头显示“0 个任务 / 还没有已完成的任务”，组体为空 |
| 只有已完成 | 进行中组头显示“0 个任务 / 当前没有进行中的任务”；已完成组**自动展开一次**，让用户直接看到结果 |
| 一个 `degraded` 计划 | 进行中组头计数 +1；环“—”；“需处理”徽章 +1；卡片显示错误与重试入口（现有能力） |
| 一个 `integrating` 计划 | 进行中组头计数 +1；该计划卡片进度条可能 100%；组头环可能 100%；状态胶囊“正在收尾”；不得移入已完成 |
| `stats.total = 0` | 环中心“—”；四段条显示 4px 空槽；文案“暂无工作项”；不要显示 0%（0% 会被误读为“一件没做”） |
| `stats.blocked > 0` 但 phase 不是 blocked | 组头红色计数照常显示；“需处理”徽章按 phase 判定（不要仅凭 stats.blocked 推断 phase） |
| 计划从进行中变为已完成 | 卡片移动到已完成组；若该卡片原本展开，则自动展开已完成组并保持该卡片展开（`openSessionId` 不变），避免“点着点着消失了” |
| 用户在“只有已完成”时手动折叠 | 尊重用户操作；后续轮询不应反复强制展开（见 §7.3） |

---

## 4. 文字版线框图

### 4.1 页面结构树

```
Dashboard
├─ Header（现有：标题、进行中计数胶囊、刷新）
├─ Statbar（现有 5 格：任务 / 工作项 / 做好 / 正在做 / 卡住）
├─ Overview（现有两卡）
│  ├─ 状态分布（Donut，现有）
│  └─ 每个任务的进度（TaskBars，现有；本设计只增加“进行中 / 已完成”分组标签与排序）
├─ Group A 进行中（NEW；始终展开）
│  ├─ GroupHeader：图标 + 标题 + 计数徽章 + 组头环 + 状态摘要 + 需处理徽章
│  └─ SessionCard × N（现有卡片；排序：需处理优先）
├─ Group B 已完成（NEW；有进行中任务时默认折叠，无进行中时自动展开）
│  ├─ GroupHeader（Collapse 按钮）：对勾 + 标题 + 计数徽章 + 组头环 + 摘要 + 最近完成
│  └─ SessionCard × N（现有卡片 + compact 变体；折叠时仍渲染，面板 hidden）
├─ Scope note（现有“统计范围”说明）
└─ Empty state（仅当 visibleSessions 为空）
```

**为什么总览仍在分组上方**：现有总览已经承担“全局状态构成 + 每任务对比”，且现有测试明确要求 `状态分布`、`每个任务的进度`、`dsh-wp-bar-button` 存在。把它们保留在原位，分组紧接其后，是最小改动；进行中组头仍位于已完成组之前，符合“进行中优先置顶”。如果实际安装后发现 360px 侧栏首屏看不到进行中组头，按 §6.5 的窄屏压缩处理，不重排 DOM。

### 4.2 整页线框（示意数据：3 个进行中 + 2 个已完成）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 任务进度                                          [进行中]   [刷新]   │  Header 现有
│ 5 个任务，拆成 21 件具体工作 · 更新于 12:04                           │  C: 5 个可见计划；S: Σ21
├──────────────────────────────────────────────────────────────────────┤
│ [5] 个任务  [17] 件工作完成  [2] 件正在做  [1] 件卡住了  [3] 个进行中  │  Statbar 现有
├──────────────────────────────────────────────────────────────────────┤
│ ┌ 状态分布 ──────────────┐   ┌ 每个任务的进度 ────────────────────┐ │
│ │        ╭──────╮        │   │ 进行中 ──────────────────────────  │ │
│ │       ╱  81%   ╲       │   │ ▌ TypeScript 使用范围核验 2/3  ●  │ │
│ │      │   做好    │      │   │ ▌ 接口回归             5/6  ●  │ │
│ │       ╲        ╱       │   │ ▌ 文档校对             1/3  ●  │ │
│ │        ╰──────╯        │   │ 已完成 ──────────────────────────  │ │
│ │  [■做好][■正在做]...    │   │ ▌ 旧计划               3/3  ✓  │ │
│ └────────────────────────┘   │ ▌ 上周复盘             6/6  ✓  │ │
│                              └────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ ● 进行中   ③ 个任务      ╭────╮                                      │  NEW Group A header
│   [橙色 4px 左栏]         │ 67%│  12 件工作 · 2 件正在做 · 1 件卡住   │
│                           ╰────╯  · 1 件还没开始 · 整体完成 67%       │
│                                     [1 个任务需处理]                  │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │━━ TypeScript 使用范围核验            [● 正在做]  2/3 做好了 · 1 卡住了│ │
│ │  ██████████░░░░  (橙/蓝/红/灰 四段条)                              │ │
│ │  （展开后：现有部门条、风险、任务明细、总体进度；不改变）           │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │━━ 接口回归                          [● 正在收尾] 5/6 做好了 · 0 卡住了│ │
│ │  ██████████████░                                                   │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │━━ 文档校对                          [● 卡住了]  1/3 做好了 · 1 卡住了│ │
│ │  ███░░░░░░░░░░░                                                    │ │
│ └──────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ ✓ 已完成   ② 个任务      ╭────╮                              [⌄]     │  NEW Group B header
│   [蓝色 4px 左栏]         │100%│  共 9 件工作全部完成                  │  Collapse button
│                           ╰────╯  最近完成：旧计划                     │
│   ┌ 折叠时仍渲染（hidden），展开后： ──────────────────────────────┐  │
│   │ ✓ 旧计划       [已完成]  本计划 3/3 做好了 · 0 卡住了  08-12     │  │  compact row
│   │ ✓ 上周复盘     [已完成]  本计划 6/6 做好了 · 0 卡住了  08-10     │  │
│   └──────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────┤
│ 统计范围：当前各会话的最新计划；已取消的计划不计入。                   │  Scope note 现有
└──────────────────────────────────────────────────────────────────────┘
```

**标注图例**：`C` = 渲染层计算（计数/最大时间/排序）；`S` = `stats.*`；`P` = `phase`；`T` = `createdAt/updatedAt/statuses[].finishedAt`；`D` = `departments`（仅现有卡片详情）。线框中的每个数字都能在 §5.2 映射表中找到来源。

> 色条方向说明：组头使用左侧 4px 竖栏；**卡片沿用现有 `border-top: 3px` 顶部色条**，线框中的 `━━` 表示顶部色条，不是新增左侧竖条。

### 4.3 组头（新增）

#### 进行中组头（非折叠）

```
┌──────────────────────────────────────────────────────────────┐
│ ●  进行中    ③ 个任务                         ╭──────╮      │
│    ↑ 8px 脉冲点  ↑ 14px/600  ↑ 计数徽章        │ 67%  │ 44px │
│   橙色左栏 4px                                 ╰──────╯      │
│    12 件工作 · 2 件正在做 · 1 件卡住 · 1 件还没开始 · 整体完成 67% │
│    [1 个任务需处理]（仅当有 blocked/paused/degraded）           │
└──────────────────────────────────────────────────────────────┘
```

- 位置：总览之后、所有卡片之前；无论有多少已完成任务，它都在最上面。
- 标题文案：`进行中`；计数：`{n} 个任务`（n = activeSessions.length）。
- 副行：总数、正在做、卡住、未开始（只显示非零项），末尾“整体完成 X%”；空数据“暂无工作项”。
- “需处理”徽章：`blocked` 红；`paused` / `degraded` 琥珀（与现有 `phaseTone` 一致）；文案“N 个任务需处理”。数据只来自 `phase`，不来自 `stats.blocked`。
- 图标：8px 橙色脉冲圆点 + 外圈柔光；`prefers-reduced-motion` 时静止。

#### 已完成组头（折叠按钮）

```
┌──────────────────────────────────────────────────────────────┐
│ ✓  已完成    ② 个任务                         ╭──────╮  [⌄]  │
│ ↑ 14px 对勾   ↑ 计数徽章                       │100%  │ 44px  │
│ 蓝色左栏 4px                                   ╰──────╯        │
│ 共 9 件工作全部完成 · 最近完成：旧计划                           │
└──────────────────────────────────────────────────────────────┘
```

- 位置：进行中组之后、Scope note 之前。
- 标题文案：`已完成`；计数：`{n} 个任务`（n = completedSessions.length）。
- 副行：若 `Σdone === Σtotal` 且 total>0 → “共 N 件工作全部完成”；否则 “N/M 件已完成”（防御不一致数据）；末尾“最近完成：<标题>”。无已完成 → “还没有已完成的任务”。
- 图标：蓝色对勾（内联 SVG，14px，`stroke-width: 2.4`）；右侧折叠箭头沿用现有 `Collapse` 的 chevron。
- 整行是 `<button aria-expanded>`；点击/Enter/Space 切换；44px 最小高度。
- 默认状态：`activeSessions.length > 0` → 折叠；否则展开一次（见 §7.3）。折叠时只隐藏组体，不卸载卡片。

### 4.4 进行中卡片（现有卡片，微调摘要）

```
┌──────────────────────────────────────────────────────────────┐
│━━ TypeScript 使用范围核验                [● 正在做]   2/3 卡住 │
│  现有标题 13px/600                      10px 胶囊    11px    │
│  ██████████░░░░  ← 四段状态条（替换现有 54px 单色迷你条）     │
│  （点击标题展开：现有 updatedAt、部门条、风险、任务明细、续跑）│
└──────────────────────────────────────────────────────────────┘
```

- 保留现有卡片结构、`Collapse`、`openSessionId`、阶段胶囊、`本计划 X/Y 做好了 · N 卡住了` 文案（现有测试断言这些字符串）。
- 只把摘要里的单色迷你条替换成四段条；四段条宽度仍约 54–72px，不改变摘要高度（细条 4px）。
- 顶部 3px 色条（现有 `border-top`）用 `phaseTone` 配色；`executing/planning` 橙、`integrating` 蓝、`blocked` 红、`paused/degraded` 琥珀、`pending` 灰。与组头的橙色不冲突：组头橙表示“这是进行中组”，卡片顶部色条表示“该计划处于哪个阶段”。

### 4.5 已完成卡片（compact 变体）

```
┌──────────────────────────────────────────────────────────────┐
│ ✓  旧计划                    [已完成]   本计划 3/3 做好了 · 0 卡住了 │
│    13px 蓝对勾 + 标题         10px 蓝    11px 次级文字             │
│    （默认不显示详情；点击后展开现有完整详情）                        │
└──────────────────────────────────────────────────────────────┘
```

- **不是新组件**：复用 `SessionCard`，加 `variant="done"`，只改 CSS 类与标题前对勾；详情面板仍由现有 `Collapse` 控制。这样 `session-collapse.test.ts` 仍能找到 `dsh-wp-session-collapse`、标题、`已完成` 胶囊和 `0 卡住了` 文案。
- 已完成行的标题前加蓝色对勾；顶部 3px 蓝色边框（现有 `.dsh-wp-tone-done` 已实现）；背景用 `--dsw-alias-bg-layer-2`，与进行中卡片（`layer-1`）形成层级差。
- 摘要仍保留“本计划 X/Y 做好了 · N 卡住了”和阶段胶囊，虽然信息略多，但这是现有测试与可访问性的锚点；通过 compact CSS 降低高度（min-height 52px，summary padding 10px 12px），而不是删除内容。
- 四段条在已完成卡片里通常全蓝；仍保留，表示“确实每一件都完成了”，并让所有卡片有一致的图形语言。
- 详情展开后与进行中卡片完全一致（部门条、任务明细、总体进度），不缩减已确认的信息。

### 4.6 空状态与降级

| 场景 | 组头 | 组体 | 文案 |
|---|---|---|---|
| active=0, done>0 | 进行中组头显示 `0 个任务` | 一行轻量提示，不渲染卡片 | “当前没有进行中的任务” |
| active>0, done=0 | 已完成组头显示 `0 个任务` | 空（或一行提示） | “还没有已完成的任务” |
| active=0, done=0 | 不渲染组头 | 现有空状态 | 现有 `empty` 文案 |
| 某计划 total=0 | 计数仍 +1；环“—” | 卡片照常；摘要“暂无工作项” | 不显示 0% |

---

## 5. 图表选型与数据映射

### 5.1 选型结论

| 图形 | 用在哪里 | 为什么选它 | 数据是否足够 |
|---|---|---|---|
| **单值完成率环（Ring）** | 两个组头 | 组头只需要一个“完成度”值；环形与现有全局 Donut 同一视觉语言，44px 也不占宽；中心可放百分比 | 有 `Σstats.done / Σstats.total`，足够 |
| **四段状态条（Segmented Bar）** | 卡片摘要、可选组头副条 | 4 个状态是“部分-整体”关系；线性条能让“做好/正在做/卡住/没开始”的先后与长度同时可读；比饼图更适合窄条 | 有 `stats.done/inProgress/blocked/pending`，四项相加等于 total |
| **全局四段 Donut（保留）** | 状态分布 | 现有组件、现有测试；品牌色环让总览仍然醒目 | 现有 `totals`，不变 |
| **每任务水平条（保留）** | 每个任务的进度 | 现有组件、现有测试；多任务比较比环更省垂直空间 | 现有 `stats.done/total`，不变 |
| **计数徽章 + 文字摘要** | 组头 | 图形之外必须有无障碍/精确值兜底；颜色不能是唯一编码 | `phase` 计数、`stats` 聚合 |
| **完成率进度条（线性）** | 不新增 | 与四段条语义重叠；组头已有环 | — |

**明确不选**：

- 饼图：4 类在 44px 组头里不可读；已有 Donut 承担全局部分-整体。
- 折线/面积图：没有时间序列数据；`updatedAt` 只有一个点。
- 仪表盘（gauge）：与环重复，且更占空间。
- 矩形树图：部门只有 `total/done/blocked`，没有面积/权重字段；会误导。
- 热力图：没有时间桶/矩阵字段。
- 每卡一个环：卡片数量最多 20，环会抢走标题与状态；四段条更紧凑。

### 5.2 图形 → 字段映射表（无凭空元素）

| ID | 图形/视觉元素 | 位置 | 精确数据映射 | 字段来源 | 空值/异常 |
|---|---|---|---|---|---|
| G1 | 全局四段 Donut 的 4 段弧 + 中心百分比 | Overview 左卡 | 段长 = `stats.done / inProgress / blocked / pending`；中心 = `round(done/total*100)%` | `stats.*`（`src/runtime.ts:871`） | total=0 → 中心“—”，不画弧 |
| G2 | 每任务水平条的填充宽度 | Overview 右卡 | 每条 = `round(stats.done / stats.total * 100)%` | `stats.done/total` | total=0 → 0%，显示“暂无” |
| G3 | 每任务条的分组标签/分隔线/对勾 | Overview 右卡 | 组 = `phase === 'done'`；组内顺序同 G8/G9 | `phase` | 无已完成 → 不显示“已完成”标签 |
| G4 | 进行中组头计数徽章 | Group A header | 数字 = `activeSessions.length` | `phase !== 'done' && !== 'cancelled'`（C） | 0 也显示“0 个任务” |
| G5 | 已完成组头计数徽章 | Group B header | 数字 = `completedSessions.length` | `phase === 'done'`（C） | 0 也显示“0 个任务” |
| G6 | 进行中组头环 | Group A header | 弧 = `Σstats.done / Σstats.total`；中心 = `round(...)%`；颜色橙 | `stats.*` 对 activeSessions 求和（C） | 总 total=0 → “—”，空槽 |
| G7 | 已完成组头环 | Group B header | 弧 = `Σstats.done / Σstats.total`；中心 = 实际百分比（正常 100%）；颜色蓝 | `stats.*` 对 completedSessions 求和（C） | 无已完成或 total=0 → “—”，空槽 |
| G8 | 进行中组头副行计数 | Group A header | `Σtotal` 件工作；`ΣinProgress` 正在做；`Σblocked` 卡住；`Σpending` 没开始；`round(Σdone/Σtotal*100)%` 完成 | `stats.*`（C） | 只显示非零项；total=0 → “暂无工作项” |
| G9 | 已完成组头副行 | Group B header | `Σdone/Σtotal`；`latestCompleted.title` | `stats.*` + 排序后的 `completedSessions[0].title`（C） | 无已完成 → “还没有已完成的任务” |
| G10 | “需处理”徽章 | Group A header | 数字 = `activeSessions.filter(phase ∈ {blocked,paused,degraded}).length`；色 = 有 blocked 红，否则琥珀 | `phase`（C） | 0 → 不渲染 |
| G11 | 进行中脉冲点 | Group A header | 纯装饰；`aria-hidden`；仅当 active>0 | `activeSessions.length > 0`（C） | 无 active → 不渲染 |
| G12 | 已完成对勾 | Group B header、已完成行 | 纯装饰 + 文本“已完成”兜底；颜色蓝 | `phase === 'done'`（C） | 无已完成 → 组头保留，显示 0 与“还没有已完成的任务”，不渲染组体 |
| C1 | 卡片四段状态条 | 每张卡摘要 | 段宽比例 = `done : inProgress : blocked : pending`；段色蓝/橙/红/灰 | `stats.done/inProgress/blocked/pending` | total=0 → 4 段全 0，轨道空槽 |
| C2 | 卡片“本计划 X/Y 做好了” | 每张卡摘要 | X = `stats.done`，Y = `stats.total` | `stats.done/total` | total=0 → “暂无工作项”（新 key） |
| C3 | 卡片“N 卡住了” | 每张卡摘要 | N = `stats.blocked` | `stats.blocked` | 0 也显示（现有测试要求） |
| C4 | 卡片阶段胶囊 | 每张卡摘要 | 文案 = `phase.<phase>`；色 = 现有 `phaseTone(phase)` | `phase` | 未知 phase → `idle` 兜底（现有） |
| C5 | 卡片顶部色条 | 每张卡 | 色 = `phaseTone(phase)` | `phase` | 同上 |
| C6 | 已完成行对勾/顶部蓝色边框 | 已完成行 | `phase === 'done'` 时显示 | `phase`（C） | 仅已完成组内，必为 true |
| C7 | 已完成行完成时间 | 已完成行（可选） | `formatTime(max(statuses[].finishedAt) ?? updatedAt)` | `statuses[].finishedAt` / `updatedAt` | 都无 → 不显示该片段 |
| C8 | 组内排序 | 两组 | 进行中按 phaseRank → createdAt desc；已完成按 finishedAt/updatedAt desc | `phase`、`createdAt`、`statuses[].finishedAt`、`updatedAt` | 时间缺失 → 0 兜底 |
| C9 | 部门条（现有） | 卡片详情 | 不动；仍用 `departments[].done/total` | `departments` | 无部门 → 不渲染（现有） |
| C10 | 总体进度（现有） | 卡片详情 | 不动；仍用 `stats.progress` | `stats.progress` | 无 → 0（现有） |

> 阅读方式：G = 组/总览级，C = 卡片级。每一个新增图形都能在上表找到字段；没有“装饰性假数据”。

### 5.3 完成率的定义（避免 100% 误读）

- 组头环的“完成率”是**工作项完成件数比**：`Σstats.done / Σstats.total`，不是 `Σstats.progress` 的平均值，也不是“计划完成率”。
- 因此，一个 `integrating` 计划（所有子任务 done）会让进行中组环显示 100%，但组头仍写“进行中”，卡片胶囊写“正在收尾”。这是正确的：**工作项完成 ≠ 计划完成**。组头副行始终带“整体完成 X%”，环中心只放百分比，避免把环读成“计划已完成”。
- 全局 Donut 中心同样用 `done/total`；卡片详情的“总体进度”仍用 `stats.progress`（现有），并在标签上保留“总体进度”以免与组头环混淆。
- 已完成组环正常显示 100%；若 `Σdone < Σtotal`（数据不一致），显示实际百分比，不强行画满，副行写“N/M 件已完成”，让异常可见。

---

## 6. 视觉规范（token、尺寸、文案、动效、验收差异）

### 6.1 颜色与语义

沿用现有 token（`src/client.ts` 的 `phaseTone()` 与 `:root` 中的 CSS 变量）：

| 语义 | 颜色 | 用途 | 约束 |
|---|---|---|---|
| 进行中组 | `--dsh-wp-active: #f97316` | 组头 4px 左栏、脉冲点、组头环弧、卡片顶部色条（executing/planning） | 只做图形/大字号；小字用主文本色 |
| 已完成组 | `--dsh-wp-done: #0ea5e9` | 组头 4px 左栏、对勾、组头环弧、完成段、已完成行顶部蓝边 | 同上 |
| 正在做/暂停/降级 | `--dsw-alias-state-warn-primary` | 四段条第二段、`paused/degraded` 需处理徽章、对应卡片顶部条 | 与品牌橙区分：用 token，不硬编码 |
| 卡住段 / blocked 徽章 | `--dsw-alias-state-error-primary` | 四段条第三段、`blocked` 需处理徽章 | 红仅表示 blocked 异常；degraded 用琥珀，与 `phaseTone` 一致 |
| 未开始段 | `--dsw-alias-state-idle-primary` | 四段条第四段 | 灰，不抢眼 |
| 轨道/底 | `--dsw-alias-bg-layer-2` | 环轨道、条轨道、已完成行底 | 深色模式自动适配 |
| 主/次文本 | `--dsw-alias-label-primary/secondary` | 标题/摘要 | 不用品牌色写小字 |

**对比度实测**（WCAG 相对亮度公式，本任务计算）：

| 前景/背景 | 对比度 | 结论 |
|---|---|---|
| `#f97316` / `#ffffff` | 约 2.8:1 | 低于正文 4.5:1，也略低于非文本 3:1；**不能**用它写小字，只能做图形/大数字 |
| `#f97316` / `#111827` | 约 6.33:1 | 深色模式可读 |
| `#0ea5e9` / `#ffffff` | 约 2.77:1 | 同上，浅色模式只做图形 |
| `#0ea5e9` / `#111827` | 约 6.4:1 | 深色模式可读 |

因此：浅色模式下组头标题、计数、摘要一律用主/次文本色；橙/蓝只出现在左栏、环、对勾、条段与脉冲点。所有图形同时有文字/形状编码（“进行中/已完成”文案、对勾、四段顺序），不依赖颜色单独传达。

### 6.2 尺寸与排版

| 元素 | 规格 |
|---|---|
| 组头容器 | 左右 padding 12px；上下 10px；min-height 64px；圆角 12px；背景 `layer-1`；左栏 4px 圆角 |
| 组头标题 | 14px / 600；行高 1.4；主文本 |
| 计数徽章 | 高 20px；padding 0 8px；圆角 999px；12px / 600；底 `layer-2`；数字与“个任务”同色主文本 |
| 组头环 | 44×44px；viewBox 44；stroke 4.5；轨道同宽；中心百分比 13px / 700；下方可无字（副行已有“整体完成”） |
| 组头副行 | 11px / 400；次文本；行高 1.5；允许换行；最多 2 行（窄屏） |
| 需处理徽章 | 高 20px；padding 0 7px；圆角 999px；11px / 600；红/琥珀底 12% 透明度 |
| 四段条 | 高 4px；段间 gap 2px；圆角 999px；宽度 54–72px（卡片摘要），组头可选 96px |
| 进行中卡片 | 保持现有 `padding: 16px`、`border-top: 3px` 色条、`border-radius: 16px`；标题沿用现有 Collapse 标题字号，不为了分组改小；摘要 meta 11px |
| 已完成行 | min-height 52px；padding 10px 12px；顶部 3px 蓝色边框（复用现有 `dsh-wp-tone-done`）；背景 `layer-2`；标题 13px / 600 |
| 已完成详情 | 与进行中卡片相同，不缩减 |
| 组间距 | 14px；组头与组体 8px；卡片之间 8px |
| 折叠动画 | 现有 `grid-template-rows 220ms ease`；尊重 `prefers-reduced-motion` |

### 6.3 图标与文案

| 位置 | 图标 | 文案（中文） | 英文 key 值 |
|---|---|---|---|
| 进行中组头 | 8px 脉冲圆点（CSS + SVG 外圈） | `进行中` | `进行中` |
| 进行中计数 | 无图标 | `{n} 个任务` | `{n} 个任务` |
| 进行中副行 | 无 | `{total} 件工作 · {doing} 件正在做 · {blocked} 件卡住 · {pending} 件还没开始 · 整体完成 {pct}%` | `{total} 件工作 · {doing} 件正在做 · {blocked} 件卡住 · {pending} 件还没开始 · 整体完成 {pct}%` |
| 需处理 | 小圆点/感叹 | `{n} 个任务需处理` | `{n} 个任务需处理` |
| 已完成组头 | 14px 对勾（内联 SVG） | `已完成` | `已完成` |
| 已完成计数 | 无 | `{n} 个任务` | `{n} 个任务` |
| 已完成副行 | 无 | `共 {n} 件工作全部完成` 或 `{done}/{total} 件已完成` + `最近完成：{title}` | `全部完成` / `最近完成` |
| 已完成行 | 14px 对勾 | `已完成`（胶囊） | `已完成`（复用 `phase.done`） |
| 空进行中 | 无 | `当前没有进行中的任务` | `当前没有进行中的任务` |
| 空已完成 | 无 | `还没有已完成的任务` | `还没有已完成的任务` |
| 无工作项 | 无 | `暂无工作项` | `暂无工作项` |

- 文案风格延续现有插件：短句、口语、中文优先；不出现“Phase”“DONE”之类内部词。
- `进行中` 是新 key，不复用 `phase.executing` 的“正在做”，因为“进行中”是组名，“正在做”是单计划状态；两者同时出现才不会混淆。
- `已完成` 可直接复用 `phase.done`，不必新增同义 key；组名与胶囊同词是有意的。

### 6.4 进行中 vs 已完成的视觉差异（验收清单）

| # | 维度 | 进行中 | 已完成 | 落点 |
|---|---|---|---|---|
| 1 | **位置** | Group A，置顶，始终展开 | Group B，置后，默认折叠（有进行中时） | DOM 顺序 + `Collapse` 默认态 |
| 2 | **颜色** | 橙色左栏/环/脉冲；卡片顶部色条按 phase | 蓝色左栏/环/对勾；完成段蓝色 | CSS 变量与 `variant` |
| 3 | **图标** | 脉冲圆点；卡片阶段胶囊 | 对勾；折叠 chevron | 内联 SVG + CSS |
| 4 | **文案** | “进行中”“N 个任务”“N 件正在做”“需处理” | “已完成”“N 个任务”“最近完成” | 新 locale key |
| 5 | **形状** | 44px 环 + 四段条；卡片全高 | 44px 满环 + 四段全蓝；紧凑一行 | `Ring` / `SegmentBar` / compact CSS |
| 6 | **层级** | 背景 `layer-1`，标题主文本，可展开全部详情 | 背景 `layer-2`，标题前对勾，默认只露摘要 | CSS + `variant="done"` |

以上 6 项各自独立成立；即使色觉异常或深色模式，位置、图标、文案、形状仍可区分。

### 6.5 窄屏与深色模式

- 侧栏 ≤ 380px：组头环 40px；副行允许 2 行；计数徽章不换行；已完成行标题 `text-overflow: ellipsis`，`title` 属性保留全文。
- 侧栏 ≤ 340px：隐藏组头环（`display:none`），副行保留百分比文字；不能让环把标题挤成竖排。
- 深色模式：全部使用 alias token；品牌橙/蓝在深色底对比度 >5:1，可用于数字；轨道/底用 `layer-2`，不要硬编码 `#fff`/`#111`。
- 动画：脉冲仅在不 reduced motion 时播放；环的 `stroke-dashoffset` 过渡 300ms；折叠沿用现有 220ms；轮询刷新不重播入场动画。
- 打印/导出：当前插件无此需求；不新增。

---

## 7. 交互与状态

### 7.1 展开/折叠

- **进行中组**：不可折叠（始终展开）。理由：它是用户最需要看的内容；折叠会增加一次点击。
- **已完成组**：`completedOpen` 初始值 = `activeSessions.length === 0`（推荐：有进行中时默认折叠，没有进行中时默认展开；§10 待确认）；点击组头切换。`Collapse` 的 panel 始终渲染，`hidden` 由 `open` 控制；**不要条件卸载**，否则 `session-collapse.test.ts` 找不到已完成卡片，也会丢失卡片展开状态。
- 单卡片折叠保持现状：点击卡片标题切换；同一时间只允许一张卡展开（`openSessionId`）。
- 当用户点击 `TaskBars` 中已完成条：先 `setCompletedOpen(true)`，再 `selectSession(sessionId)`；`selectSession` 现有 `setTimeout(..., 60)` 足够等一次渲染，然后 `scrollIntoView`。如果目标在隐藏面板里，必须先展开，否则滚动无效。
- 当用户点击进行中条：行为不变，直接展开并滚动。

### 7.2 轮询刷新

- 现有 `usePlans` 4 秒轮询；分组状态必须跨轮询保持：
  - 不要每次 `sessions` 变化都重置 `completedOpen`。
  - `openSessionId` 保持不变；若该计划从 active 变 done，已完成组自动展开（见 §7.3），卡片仍展开。
- 排序变化时不做布局动画（避免 4 秒一次跳动）；只更新数字与条宽。
- 若已完成组从 0 变为 >0，且当前没有进行中任务：自动展开一次，让用户看到“刚完成”的结果。

### 7.3 自动展开的精确规则（不打扰用户）

```ts
// 推荐初始值：没有进行中时直接展开，避免首帧闪一下折叠（§10 待确认；若选“始终默认展开”，改为 true）
const [completedOpen, setCompletedOpen] = useState(activeSessions.length === 0)

useEffect(() => {
  if (activeSessions.length === 0) setCompletedOpen(true)
}, [activeSessions.length])

// 正在看的卡片变成 done 时，确保它所在的组是展开的
const openSession = visibleSessions.find((s: any) => s.sessionId === openSessionId)
useEffect(() => {
  if (openSession?.phase === 'done') setCompletedOpen(true)
}, [openSessionId, openSession?.phase])
```

- 初始 mount：`completedOpen = activeSessions.length === 0`，没有进行中任务时首帧就是展开的。
- 最后一个进行中任务完成（active 1→0）→ effect 展开。
- 用户在 active=0 时手动折叠 → `activeSessions.length` 不变，effect 不重跑，保持折叠；下一次 active 从 >0 变 0 时才再展开。
- 两个 effect 都**不要**依赖整个 `sessions` 数组，否则每次轮询都会强制展开，用户无法收起。
- **不使用 `useRef`**：`tests/client-render.test.ts:83-91`、`tests/session-collapse.test.ts:96-119` 等测试自带的 React stub 只实现 `useState/useEffect/useCallback/useMemo`，没有 `useRef`；上面两个 effect 只用 `useState/useEffect`，不必改测试桩。
- 第二个 effect 是**必须**的：当 `openSessionId` 对应的计划变为 done 时，把 `completedOpen` 置 true，避免“正在看的卡片突然消失”。依赖只写 `openSessionId` 与目标计划的 `phase`，不要依赖整个 session 对象；用户手动折叠后，只要这两个值不变，effect 不会重跑。

### 7.4 键盘与无障碍

- 已完成组头：原生 `<button>`，`aria-expanded={completedOpen}`，`aria-controls` 指向组体 id；Enter/Space 可切换；focus ring 用现有 `:focus-visible`。
- 进行中组头：`<section aria-labelledby>` + `<h2 id>`；不是按钮，不进入 Tab 顺序。
- 组头环：SVG `aria-hidden="true"`；百分比在副行可见文本中，屏幕阅读器不丢失。
- 四段条：`role="img"` + `aria-label` 精确文案（“已完成 8 件，正在做 2 件，卡住 1 件，未开始 1 件，共 12 件”）；旁边同时有文字计数，避免重复朗读时可改为 `aria-hidden`，但保留文字。
- 计数徽章：可见文本“3 个任务”，无需额外 aria。
- 已完成行：保留现有 `Collapse` 的按钮语义与 `aria-expanded`；对勾 `aria-hidden`；标题文本仍可读。
- 对比度：见 §6.1；品牌色不用于小字。
- 不要用 `title` 作为唯一信息源；`title` 只做截断补全。

---

## 8. 零依赖实现方案（交给 T5）

### 8.1 组件与改动点

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/client.ts` | 新增 `GroupHeader`、`Ring`、`SegmentBar`（或 `StatusBar`）组件 | 纯函数组件；SVG 用 `h('svg', ...)`；不引入库 |
| `src/client.ts` | `Dashboard` 增加 `completedOpen` state + 分组派生 + effect | 注意：`usePlans()` 必须是 Dashboard 的第一个 hook（现有测试桩把第一个 `useState` 返回值当 fixture；新增 state 放在它之后） |
| `src/client.ts` | `TaskBars` 接收 `activeSessions` / `completedSessions`（或接收分组后的数组） | 保留 `.dsh-wp-bar-button`、`跳转到任务明细`、`dsh-wp-session-<id>`，否则现有测试失败 |
| `src/client.ts` | `SessionCard` 增加 `variant?: 'active' \| 'done'`，done 时加类与标题对勾 | 不新建 `CompletedRow` 组件；保留全部现有子节点与文案 |
| `src/client.ts` | 新增 `sumStats`、`groupPercent`、`finishedAt`、`phaseRank`、`sortActive`、`sortCompleted` 辅助函数 | 纯函数，便于单测；无新依赖 |
| `src/client.ts` | locale `zh/en` 增加组头/空态 key | 见 §8.4；en 也要补齐，`client-locale` 测试会核对 |
| `src/client.css`（或样式字符串） | 新增 `.dsh-wp-group-*`、`.dsh-wp-ring`、`.dsh-wp-segbar`、`.dsh-wp-session--done` | 复用现有变量；`@media (prefers-reduced-motion: reduce)` |
| `docs/collapse-interaction-spec.md` | 在 §10/§11 加“已被 status-grouping-ia.md 覆盖”的具体条目 | 防止旧结论冲突 |
| `docs/status-grouping-ia.md` | 本文 | 设计依据 |
| `CHANGELOG.md` / `package.json` | 版本与变更说明 | T5；设计时建议 1.3.8，当前工作区已 1.4.0（见 §9.1） |

### 8.2 关键伪代码

```ts
// 分组（全部基于现有字段）
const visibleSessions = state.sessions.filter((s: any) => s.phase !== 'cancelled')
const activeSessions = visibleSessions
  .filter((s: any) => s.phase !== 'done')
  .sort(compareActive)
const completedSessions = visibleSessions
  .filter((s: any) => s.phase === 'done')
  .sort(compareCompleted)

const activeStats = sumStats(activeSessions)
const completedStats = sumStats(completedSessions)
const activePercent = activeStats.total > 0
  ? Math.round(activeStats.done / activeStats.total * 100)
  : null
const completedPercent = completedStats.total > 0
  ? Math.round(completedStats.done / completedStats.total * 100)
  : null
const attentionCount = activeSessions.filter((s: any) =>
  s.phase === 'blocked' || s.phase === 'paused' || s.phase === 'degraded'
).length
const latestCompleted = completedSessions[0]?.title ?? null

// 组头环：单值弧
function Ring(props: { percent: number | null; tone: 'active' | 'done' }) {
  const r = 18, c = 2 * Math.PI * r
  const offset = props.percent === null ? c : c * (1 - props.percent / 100)
  return h('svg', { className: `dsh-wp-ring dsh-wp-ring--${props.tone}`, viewBox: '0 0 44 44', 'aria-hidden': 'true' },
    h('circle', { cx: 22, cy: 22, r, className: 'dsh-wp-ring-track' }),
    h('circle', { cx: 22, cy: 22, r, className: 'dsh-wp-ring-arc', strokeDasharray: c, strokeDashoffset: offset }),
    h('text', { x: 22, y: 26, textAnchor: 'middle', className: 'dsh-wp-ring-text' },
      props.percent === null ? '—' : `${props.percent}%`))
}

// 四段条：width 用 flex-basis 百分比；total=0 时四段 0，轨道仍在
function SegmentBar(props: { stats: any }) {
  const total = Math.max(0, Number(props.stats.total) || 0)
  const cells = [
    ['done', Number(props.stats.done) || 0],
    ['doing', Number(props.stats.inProgress) || 0],
    ['blocked', Number(props.stats.blocked) || 0],
    ['pending', Number(props.stats.pending) || 0],
  ]
  return h('div', { className: 'dsh-wp-segbar', role: 'img',
    'aria-label': `${cells[0][1]} 件已完成，${cells[1][1]} 件正在做，${cells[2][1]} 件卡住，${cells[3][1]} 件未开始，共 ${total} 件` },
    cells.map(([key, n]) => h('span', {
      key, className: `dsh-wp-segbar-cell dsh-wp-segbar-cell--${key}`,
      style: { flexGrow: n },
    }))
  )
}
```

> 注意：`flexGrow: 0` 的段不占宽；四段都为 0 时条内无可见段，但轨道仍画出 4px 空槽。不要用 `width: 0` 让小段消失到不可见；轨道是空态提示。

### 8.3 CSS 类名（建议）

```
.dsh-wp-group-header
.dsh-wp-group-header--active / --done
.dsh-wp-group-title
.dsh-wp-group-count
.dsh-wp-group-ring
.dsh-wp-group-subline
.dsh-wp-group-attention
.dsh-wp-ring / .dsh-wp-ring--active / --done
.dsh-wp-ring-track / .dsh-wp-ring-arc / .dsh-wp-ring-text
.dsh-wp-segbar / .dsh-wp-segbar-cell / --done / --doing / --blocked / --pending
.dsh-wp-session--done
.dsh-wp-done-check
```

- 保留现有 `.dsh-wp-session-collapse`、`.dsh-wp-pill`、`.dsh-wp-bar-button` 等类名；新样式只做追加，不改旧选择器语义。
- **组头折叠必须用 `.dsh-wp-group-collapse`，绝不能复用 `.dsh-wp-session-collapse` 或 `data-session-id`**：`tests/session-collapse.test.ts:287` 用 `collapses(tree, 'dsh-wp-session-collapse')` 精确数任务卡，复用会让计数从 2 变 3/4。
- 用 `data-group="active|done"` 便于测试与 CSS 断言。

### 8.4 Locale key（zh/en 都要加）

| key | zh | en |
|---|---|---|
| `group.active` | `进行中` | `In progress` |
| `group.done` | `已完成` | `Completed` |
| `group.taskCount` | `{count} 个任务` | `{count} tasks` |
| `group.activeSubline` | `{total} 件工作 · {doing} 件正在做 · {blocked} 件卡住 · {pending} 件还没开始 · 整体完成 {percent}%` | `{total} items · {doing} in progress · {blocked} blocked · {pending} pending · {percent}% complete` |
| `group.attention` | `{count} 个任务需处理` | `{count} need attention` |
| `group.completedSubline` | `共 {total} 件工作全部完成` | `All {total} items completed` |
| `group.completedSublinePartial` | `{done}/{total} 件已完成` | `{done}/{total} items completed` |
| `group.latestCompleted` | `最近完成：{title}` | `Latest: {title}` |
| `group.emptyActive` | `当前没有进行中的任务` | `No tasks in progress` |
| `group.emptyDone` | `还没有已完成的任务` | `No completed tasks yet` |
| `group.noWorkItems` | `暂无工作项` | `No work items` |
| `group.completedAria` | `已完成任务，{count} 个，点击展开或收起` | `Completed tasks, {count}, expand or collapse` |

- 插值沿用现有 `t(key, params)` 机制；不要拼接半句话，避免英文语序问题。
- 若不想新增太多 key，可把 `group.activeSubline` 拆成多个小 key；但不要复用到 `stats.*` 造成“正在做”与“进行中”混淆。

### 8.5 兼容既有测试的硬约束（T5 必读）

现有测试不是“参考”，而是验收门槛。实现时逐条保留：

| 测试 | 断言/机制 | 本设计必须满足 |
|---|---|---|
| `tests/session-collapse.test.ts` | 2 个 done 计划 → 2 个 `dsh-wp-session-collapse` 卡；摘要包含 `1/1 做好了`、`3/3 做好了` | 已完成组折叠时**仍渲染** `SessionCard`，不卸载；摘要文案不删 |
| 同上 | 摘要包含 `已完成`、`0 卡住了` | 已完成行保留阶段胶囊与 blocked 计数（即使 0） |
| 同上 | 点击摘要 → `aria-expanded="true"`，详情包含 `部门`、`风险` | 复用现有 `Collapse` 子节点；不把已完成行改成无详情的新组件 |
| 同上 | `assert.equal(collapses(...).length, 2, 'one task card per active plan')` | 两个 done 卡都要在 DOM 中；组头不能替代卡片；组头折叠用 `.dsh-wp-group-collapse`，**不得**复用任务卡类名 |
| 同上 | 点击进行中条 → 目标卡片 `article.hidden === false` 且 `aria-expanded === 'true'` | `TaskBars` 对 active 的行为保持；`selectSession` 逻辑不破坏 |
| `tests/client-render.test.ts` | 状态条 `<div>1</div><div>个任务</div>`；`状态分布`；`每个任务的进度`；`dsh-wp-bar-button`；`dsh-wp-session-` | 保留现有 Statbar、Donut、TaskBars；不要把总览移出或改名 |
| 同上 | `2 个任务` 不得出现（fixture 1 active + 1 cancelled） | 分组计数只统计可见计划；不要用 `sessions.length` 做组头计数 |
| `tests/client-locale.test.ts` | zh/en 扁平 map，key 一致 | 新 key 两种语言都加；值必须是可读中文/英文，不能是 `group.active` 这种 key |
| 同上 | `no raw locale keys` | 所有新文案走 `t()`，不要硬编码中文到组件里（现有英文模式会露馅） |
| `tests/client-*.test.ts` | 渲染桩 `useState` 第一个返回值当 fixture | `usePlans()` 仍是 Dashboard 第一个 hook；新增 `useState` 放它之后 |
| `tests/plan.test.ts` | 后端 phase/stats 不变 | 不改 `plan.ts`/`runtime.ts`；本设计不需要 |

**实现顺序建议**：

1. 先加纯函数与单测：`sumStats`、`compareActive`、`compareCompleted`、`finishedAt`。
2. 加 `Ring` / `SegmentBar`，在现有卡片摘要中替换迷你条（先不分组），跑 `client-render`。
3. 加 `GroupHeader`，把 `Dashboard` 的 `activeSessions` 拆成 `visibleSessions/activeSessions/completedSessions`，保持 header/statbar/donut 的 totals 仍对 `visibleSessions`。
4. 加 `completedOpen` + `Collapse` 组体；确认 `session-collapse` 仍找到 2 张卡。
5. 加 `variant="done"` 与 compact CSS；跑全量测试。
6. 加 locale 两种语言；跑 `client-locale`。
7. 手动验证：真实计划里至少一个进行中 + 一个已完成；若没有已完成，用测试 fixture 或临时数据验证（不要提交临时数据）。

---

## 9. 版本与变更说明（T5 执行，设计给建议）

### 9.1 版本建议

> **版本基线变化（重要）**：T4 设计时是 `1.3.7`，当时建议升 `1.3.8`；T4 运行期间工作区已被并行改为 `1.4.0`（见文首快照提示）。因此主 Agent **不要回退到 1.3.8**；应在当前 `1.4.0` 上核对已实现内容，若仍需补设计项，再按语义化版本决定 `1.4.1`（或由主 Agent 决定）。下面的 `1.3.8` 草稿只作为“变更说明结构”模板。

- 设计时当前：`1.3.7`（`package.json`，已复核）；当前工作区已 `1.4.0`。
- 设计时建议：`1.3.8`（minor UI 功能，无 API/数据变更）；当前基线已高于此，**不要回退**。
- 设计时执行方式（历史草稿）：由 T5 修改 `package.json` 的 `version`，并在 `CHANGELOG.md` 顶部加 `### 1.3.8 — 2026-10-27`（日期以实际发布日为准）。
- 如果 T5 还改了行为（例如自动展开规则、排序），可考虑 `1.4.0`；但仅本设计范围，`1.3.8` 足够。**不要**只改 `package.json` 不写 CHANGELOG。

### 9.2 CHANGELOG 草稿

```md
## 1.3.8 — 2026-10-27

### 任务进度：进行中 / 已完成分组
- 「任务进度」面板按计划状态分组：进行中置顶并始终展开，已完成置后并默认收起；没有进行中任务时自动展开已完成。
- 组头新增计数徽章、完成率环、状态摘要与“需处理”提示；进行中组优先显示 blocked / paused / degraded 任务。
- 每个任务新增四段状态条（做好 / 正在做 / 卡住 / 没开始）；已完成任务改为紧凑行，保留展开详情。
- 总览的统计条、状态分布环、每任务进度条保留；每任务进度条按进行中 / 已完成分组排序。
- 零新增依赖：全部使用现有 SVG/CSS 变量；颜色沿用天蓝 / 橙。
- 测试：新增分组、计数、折叠、无障碍断言；全量测试结果由 T5 填写（不得预填未运行的数字）。
```

---

## 10. 待用户确认（影响两处视觉参数）

> T3（用户确认）未在本子任务上下文中收到。下面两项会改变最终视觉结果，**按总任务要求应先向用户确认**；本设计给出推荐与备选，确认前 T5 不应擅自定稿这两项。其余分组骨架、字段映射、紧凑行不依赖它们，可先做无争议部分。

1. **已完成组默认折叠还是默认展开？**
   - 推荐：**默认折叠**（有进行中任务时）。理由：进行中优先，已完成不抢注意力；用户点一下即可展开。
   - 备选：默认展开但置后。理由：所有信息一次可见；代价是页面更长、已完成仍占注意力。
   - 影响：只改 `completedOpen` 初始值与自动展开规则，不影响分组/图表/测试。

2. **组头环的数字用“完成件数比”还是“平均进度”？**
   - 推荐：**完成件数比** `Σdone/Σtotal`。理由：和“N 件工作做好了”文案、四段条、全局 Donut 完全一致；可解释、可核对。
   - 备选：`Σ(stats.progress × stats.total) / Σstats.total` 的加权平均。理由：更接近现有卡片详情的“总体进度”；代价是组头环与副行“N 件做好了”可能不一致，且一个 100% 的 integrating 计划也会让环 100%，解释成本更高。
   - 影响：只改 `Ring` 的 `percent` 计算；两方案都必须保留“工作项完成 ≠ 计划完成”的说明。

如果用户对图表形式有额外偏好（例如“不要环，改用横条”），分组骨架、字段映射、紧凑完成行仍可保留，只需替换 `Ring` 为 `SegmentBar`/线性条；这属于可控返工，不推翻信息架构。

---

## 11. 验收、证据与复现

### 11.1 本子任务验收对照

| 验收项 | 本设计的回答 | 证据 |
|---|---|---|
| 分组依据明确 | `phase === 'done'` 为已完成，其余非取消为进行中；9 个 phase 全表映射 | §3.1–3.2；`src/runtime.ts:862`、`src/plan.ts:1089-1095` |
| 进行中优先置顶 | Group A 在 Group B 之前，始终展开 | §4.1、§4.3、§7.1 |
| 已完成折叠/置后 | Group B 置后；有进行中时默认折叠；无进行中自动展开一次 | §3.4、§7.3 |
| 每组标题/计数徽章/进度图 | 组头标题、`N 个任务` 徽章、44px 环、副行计数 | §4.3、§5.2 G4–G10 |
| 文字版线框图 | 整页 + 组头 + 两种卡片 + 空态 | §4.2–4.6 |
| 图表类型与数据映射 | 选型表 + 逐元素映射表 | §5.1–5.2 |
| 视觉差异点 ≥ 各一处 | 位置/颜色/图标/文案/形状/层级 6 项 | §6.4 |
| 每个图表元素有字段 | 映射表每行都有字段/来源/空值 | §5.2 |
| 零依赖、可落地 | 仅 SVG/CSS；组件/伪代码/类名/locale/测试约束 | §8 |
| 版本与变更说明 | 设计时建议 1.3.8；当前已 1.4.0，以主 Agent 核对为准 | §9 |
| 不编造 | 无真实样本；401 来自 T2；测试数字未填 | §0、§11.3 |

### 11.2 已执行的验证（可复现）

```bash
# 1. 确认插件版本与文件快照
cd <repo>
node -p "require('./package.json').version"     # 设计时 1.3.7；T4 运行期间已变为 1.4.0
shasum -a 256 src/client.ts src/runtime.ts src/plan.ts package.json
# 已记录：client.ts c4e18008...1e75；runtime.ts f4dc1c...2f8；plan.ts c3cf...0d3；package.json e233...c51

# 2. 确认分组字段与现有渲染入口
grep -n "const activeSessions = useMemo" src/client.ts            # 1377
grep -n "function serialisePlan" src/runtime.ts                 # 831
grep -n "export function computeStats" src/plan.ts              # 1077

# 3. 确认旧文档的冲突条款
grep -n "不新增 locale 文案" docs/collapse-interaction-spec.md  # 258
grep -n "不做第三级折叠" docs/collapse-interaction-spec.md      # 256
```

本任务**没有**执行：`npm run build`、`npm test`、安装、重启、浏览器截图。原因：T4 只做设计，且当前无真实计划样本；这些由 T5/主 Agent 执行。任何“测试通过/已安装”均不应由本设计声称。

### 11.3 主 Agent 安装后的真实视觉验收（建议步骤）

1. T5 完成代码、版本号、CHANGELOG、`npm run build`、`npm test`，报告实际通过数。
2. 主 Agent 按插件既有流程安装并重启 DSH Web（本设计不提供安装命令，避免与主 Agent 流程冲突）。
3. 打开 `http://127.0.0.1:3080`，在左侧栏打开“任务进度”。
4. 造出/等待至少 1 个进行中 + 1 个已完成计划（不要伪造生产数据；可用测试 fixture 或真实跑一个短任务）。
5. 逐项检查：
   - 进行中组在已完成组之前；已完成组默认状态按 §10 确认结果验收（推荐“有进行中时收起”）；点组头可展开；无进行中时自动展开。
   - 两个组头都有计数、环、副行；进行中组有“需处理”时显示徽章。
   - 每张进行中卡有四段条；已完成行更矮、有对勾、点击仍可展开部门/风险/明细。
   - 总览的统计条/Donut/TaskBars 仍在；TaskBars 进行中在前、已完成在后；点已完成条能展开组并滚动到卡片。
   - 浅色/深色、360px/420px 宽度下不溢出；键盘 Tab/Enter 可操作组头与卡片。
   - 轮询 4 秒不重置折叠状态；最后一个进行中完成时已完成组自动展开一次，手动收起后不再被强制展开。
6. 若实际首屏看不到进行中组头：先按 §6.5 缩小环/副行，不要把总览删掉或把分组移到总览之前（会破坏现有测试锚点）。

---

## 12. 遗留问题与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户偏好“已完成默认展开”或“不要环” | 需小幅返工 | 方案已把这两点隔离为变量；分组/字段映射/紧凑行不受影响；**先向用户确认，再定稿这两项** |
| 真实侧栏首屏高度不足，进行中组头在总览下方 | “一眼看到进行中”打折扣 | §6.5 窄屏压缩；若仍不够，T5 可把总览的“每任务进度”默认收成 3 行 + “查看全部”，但需新增交互，属于范围扩展，先问用户 |
| `integrating` 计划被用户误读为“已完成” | 语义误解 | 组头明确“进行中”、胶囊“正在收尾”、副行“整体完成”而非“已完成”；环 100% 旁有组名兜底 |
| 浅色品牌色对比度不足 | 小字不可读 | 品牌色只做图形/大数字；文字用主/次文本色；图形有文字/形状冗余 |
| 既有测试把第一个 `useState` 当 fixture | 新增 state 位置错误会导致测试全挂 | `usePlans()` 保持第一个 hook；新增 state 放后面；已完成组折叠时仍渲染卡片 |
| 已完成组折叠导致 `scrollIntoView` 失效 | 点任务条无反应 | `selectSession` 前先 `setCompletedOpen(true)`；等一次渲染再滚动 |
| 无真实计划样本 | 无法在 T4 截图验收 | 明确标注未验证；主 Agent 安装后按 §11.3 验收，不伪造截图/数据 |
| 旧文档 §10/§11 与本次分组冲突 | 后续实现可能按旧结论 | 在旧文档加覆盖说明；本文 §2.3 显式记录；若用户拒绝组折叠，改用“只置后 + 紧凑行” |

---

## 附录 A：一页纸给 T5 的检查清单

- [ ] `phase === 'done'` 才进已完成；`integrating` 留进行中；`cancelled` 继续过滤。
- [ ] 进行中组在已完成组之前；进行中始终展开；已完成有进行中时默认折叠。
- [ ] 已完成组折叠时卡片仍渲染（`Collapse` panel hidden，不卸载）。
- [ ] 组头：标题、`N 个任务`、44px 环、副行计数、需处理徽章（可选）。
- [ ] 卡片：四段条 + 现有 `X/Y 做好了` + `N 卡住了` + 阶段胶囊。
- [ ] 已完成行：对勾、顶部蓝边、compact 高度；点击仍展开现有详情。
- [ ] TaskBars 保留原类名/文案/锚点；进行中在前，已完成在后；点已完成条先展开组。
- [ ] 总览 Statbar/Donut/TaskBars 不动；totals 仍只统计非取消计划。
- [ ] locale zh/en 新 key 齐全；无硬编码中文。
- [ ] `usePlans()` 仍是 Dashboard 第一个 hook；新增 state 在后。
- [ ] 浅色/深色、360px/420px、键盘、reduced motion 检查。
- [ ] 版本号 + CHANGELOG；测试实际通过数；安装/重启交给主 Agent。
