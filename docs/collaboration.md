# dsh-workplan 协作契约（唯一入口）

> 这份文档回答四个问题：**谁把什么写给谁、什么时候算完成、失败后谁接手、改代码时哪些地方必须一起改。**
>
> 适用版本：**1.7.0（当前已发布，2026-10-30）**。文中每一项能力都已落到代码与测试；标注「未处理」的是明确不做、留待后续版本的范围，不要当现状。
>
> 约定：本文只用「文件 + 符号名」定位代码（例如 `src/plan.ts#buildChildPrompt`），**不写行号**，避免代码改动后文档漂移。核对命令见 §11。

---

## 1. 角色与职责

| 角色 | 由谁承担 | 能做 | 不能做 |
|---|---|---|---|
| 用户 | 人 | 提任务、补充信息、拍板、说「继续」 | — |
| 规划器 | 宿主 LLM（`ctx.llm.stream`，`src/runtime.ts#runPlanner`） | 读最近对话，产出计划 JSON | 不执行、不派发、不写状态 |
| 主 Agent | 当前会话的主模型 | 展示计划；调用 `dsh_workplan_dispatch` / `update` / `cancel`；核对证据；向用户汇报 | 不能绕过「先派发后回答」；不能替子 Agent 编造结果 |
| 调度器 | 插件进程（`src/runtime.ts#dispatchPlan`） | 算就绪、并发跑子任务、写状态、写结果消息、重试/续跑 | 不做产品判断；不猜业务结论 |
| 部门执行 Agent | 宿主子 Agent（每个子任务一个，`maxDepth: 1`） | 只做本子任务；读写工作区；运行必要命令 | **不能** dispatch / update / cancel；不能派生 Agent；不能重启或安装服务 |
| 面板 | 浏览器端（`src/client.ts`） | 只读展示 `GET /dsh-workplan/plans` | 不写任何状态 |

要点：

- **部门是职责标签，不是组织架构。** 1.6.0 的 `src/plan.ts#DEPARTMENTS`（12 个）只用于生成提示词与界面分组；**没有部门负责人、部门队列、部门内串行**。是否并行只由 `dependsOn` 与全局并发 5 决定。
- **主 Agent 是唯一中枢。** 子 Agent 之间没有消息通道；跨部门信息只能经主 Agent 转达（见 §5、§7）。
- **子 Agent 的权限是「代码硬约束 + 提示词软约束」两层。** 硬约束只有三条 `NOT_ROOT` 拒绝（dispatch / update / cancel）；「不要重启服务、不要安装」只在 `buildChildPrompt` 文本里，**没有工具层护栏**。

---

## 2. 端到端流程（1.6.0 实际行为）

```
用户消息
  │ agent/pre-step（step===1，仅 root 会话）
  ▼
[触发过滤] src/runtime.ts#maybePlan
  │ 纯问候/致谢/告别、单独「继续/然后呢」、状态型提问 → 不建计划
  │ 已有 dispatchPromise 或 phase==='executing' → 不重复规划
  ▼
[规划] src/runtime.ts#runPlanner → src/plan.ts#buildPlannerPrompt
  │ 超时 PLANNER_TIMEOUT_MS；输出经 extractJson → validatePlan → checkPlanGraph
  │ 失败 → buildDegradedMessage（不自动再分解）
  ▼
[计划落地] src/plan.ts#buildPlanMessage → 以 user/message（kind=workplan）注入
  │ 用户与主 Agent 同时可见；plan 模式下只展示、拒绝 dispatch
  ▼
[派发] 主 Agent 调 dsh_workplan_dispatch → src/runtime.ts#dispatchTool
  │ 守卫：root / planId / plan 模式 / 运行中去重 / 续跑额度
  │ 内存无记录 → reconstructFromSession 从会话日志回放
  ▼
[调度] src/runtime.ts#dispatchPlan
  │ readySubtasks：只看 dependsOn 是否 done（不看产物、不看 stage）
  │ runWithConcurrency(ready, MAX_CONCURRENT=5)
  │ 失败级联 markDependentsBlocked
  ▼
[执行] src/runtime.ts#runSubtask → #executeSubtask
  │ 子 Agent 输入：buildChildPrompt（全局任务/交付物/主要矛盾/阶段/依赖结果/执行要求）
  │ 看门狗：无进展 idle 5min / 单项上限 15min；stalled 重试 1 次
  ▼
[落状态] src/runtime.ts#writeSubtaskStatus → applyStatus
  │ 子 Agent 输出末尾的工作计划证据块 + 首行 BLOCKED → adjudicateResult 八种情形
  ▼
[汇总] src/runtime.ts#buildRoundResult → src/plan.ts#buildResultMessage
  │ 追加 user/message（kind=workplan-result），并作为 dispatch 返回值
  ▼
[整合] 主 Agent 按系统提示核对；可用 dsh_workplan_update 改判
  ▼
[展示] GET /dsh-workplan/plans → derivePlanSnapshot → client 4s 轮询
```

**派发有两种模式。** 默认 `mode: "wait"` 会一直等到本轮调度结束（或总预算耗尽）才返回，期间可用 `dsh_workplan_status` 只读查询进度；`mode: "async"` 立刻返回 `running: true`，本轮结束时仍自动把结果写进会话。`wait` 如果撞上已在跑的派发，会**汇合**到同一个 Promise 并返回完整快照（`joined: true`），不会再只回一句「已在运行」。

**plan 模式只拦 dispatch。** `src/host.ts` 的 `tools.guard` 拒绝 `dsh_workplan_dispatch`，但不会冻结其他工具，也不会自动开始执行。

---

## 3. 数据契约

### 3.1 计划消息（`kind: "workplan"`）

持久化在会话日志里，标记块为 `<!-- DSH-WORKPLAN:BEGIN -->` … `<!-- DSH-WORKPLAN:END -->`，由 `src/plan.ts#parseWorkplanMessage` 回放。

```jsonc
{
  "kind": "workplan",
  "version": 1,                 // PLAN_VERSION，当前只能是 1
  "planId": "…",
  "sessionId": "…",
  "createdTurn": 1,
  "createdAt": 0,
  "plan": {
    "planId": "…",
    "sessionId": "…",
    "title": "…",
    "taskUnderstanding": {
      "originalRequest": "…", "deliverable": "…",
      "successCriteria": [], "constraints": [], "knownFacts": [],
      "unknowns": [], "assumptions": []
    },
    "contradictions": {
      "primary": { "statement": "…" },
      "secondary": [], "transformationConditions": []
    },
    "stages": [{
      "id": "S1", "name": "…", "goal": "…", "checkpoint": "…",
      "subtasks": [{
        "id": "T1", "title": "…",
        "department": "engineering",   // DEPARTMENTS 的 key
        "role": "…", "objective": "…",
        "method": ["…"], "inputs": ["…"], "outputs": ["…"],
        "dependsOn": ["T0"], "acceptance": ["…"], "risk": "…"
      }]
    }],
    "risks": [], "verification": [], "practiceLoop": { "plan": "", "do": "", "check": "", "act": "" }
  }
}
```

硬边界（`src/plan.ts#validatePlan` / `#checkPlanGraph`）：

| 项 | 限制 |
|---|---|
| 阶段数 | 1–6（`MAX_STAGES`） |
| 子任务总数 | 1–15（`MAX_SUBTASKS`） |
| 每个阶段的子任务 | ≥1 |
| 验收标准 | 每项 1–8 条 |
| 依赖 | 只能引用计划内、且不成环的 id |
| 部门 | 必须是 `DEPARTMENTS` 的 12 个 key 之一 |

### 3.2 结果消息（`kind: "workplan-result"`）

标记块 `<!-- DSH-WORKPLAN-RESULT:BEGIN/END -->`，由 `buildResultMessage` 生成、`parseResultMessage` 回放。**它是状态的持久事实源**，内存 `record.statuses` 只是在它之上的缓存。

```jsonc
{
  "kind": "workplan-result",
  "version": 1,
  "planId": "…",
  "sessionId": "…",
  "dispatchedAt": 0,
  "phase": "done | paused | blocked | cancelled | degraded | executing | …",
  "statuses": [/* 见 3.3 */],
  "stats": { "total": 0, "done": 0, "blocked": 0, "inProgress": 0, "pending": 0, "progress": 0 },
  "errors": [],
  "resumeCount": 0,
  "resumeAvailable": true
}
```

结果消息正文还会逐项写出：完成/受阻数量、受阻项是否还有续跑额度、预算暂停时剩余多少项。**主 Agent 应以这些文字 + statuses 为准，而不是只看 `ok:true`。**

### 3.3 子任务状态条目

由 `src/plan.ts#createStatuses` 初始化，`#applyStatus` 写入，`#normaliseStatusEntry` 在出口归一化。

| 字段 | 类型 | 含义 / 写入规则 |
|---|---|---|
| `subtaskId` | string | 计划内唯一 id；空 id 的条目会被丢弃，不计数 |
| `stageId` | string | 所属阶段（仅展示） |
| `title` | string | 子任务标题 |
| `department` | string | 部门 key |
| `role` | string | 角色名（提示词用） |
| `status` | `pending` / `in_progress` / `done` / `blocked` | 只有这 4 个值；未知值在展示层归一为 `pending` |
| `progress` | 0–100 整数 | `done` 强制 100，`pending` 强制 0 |
| `childId` | string \| null | 子 Agent 会话 id；`pending` 时为 null |
| `startedAt` / `finishedAt` | number \| null | 毫秒时间戳 |
| `summary` | string | 子 Agent 输出摘要；写入时截断到 **3000 字** |
| `error` | string \| null | 失败/受阻原因；截断到 **2000 字** |

> 1.7.0 在上述字段之外新增 `verification`（`structured`/`legacy`/`unverified`/`failed`/`unparsable`）、`acceptance[]`、`artifacts[]`、`missingArtifacts[]`、`needs[]`、`revision`、`updatedBy`（`child`/`agent`/`system`）。旧消息没有这些字段时按 `legacy` 读取。

### 3.4 取消消息（`kind: "workplan-cancel"`）

标记块 `<!-- DSH-WORKPLAN-CANCEL:BEGIN/END -->`。用户显式取消时由 `buildCancelMessage` 写入，`parseCancelMessage` 回放。**注意**：新一轮计划取代未派发旧计划时，1.6.0 只改内存 phase、不写取消消息，这是已知缺陷（§8）。**例外**：plan 模式下生成、尚未派发的计划会被刻意保留，不会被取代——否则用户还没看到计划它就消失了。

### 3.5 状态枚举与阶段

| 层面 | 取值 | 说明 |
|---|---|---|
| 子任务状态 | `pending` / `in_progress` / `done` / `blocked` | `STATUSES`，不要新增值 |
| 计划轮次阶段 | `pending` / `planning` / `executing` / `integrating` / `paused` / `blocked` / `done` / `cancelled` / `degraded` | 由派发动作或 `reconcilePhase` 写入 |
| 展示阶段 | 上述 + `ended` | `ended` **只出现在下发的载荷**里，不回写 `record.phase`；原阶段保存在 `suspendedPhase` |

阶段对账规则（`src/plan.ts#reconcilePhase`）：

1. 全部子任务 `done` ⇒ 一定是 `done`；
2. 缓存是 `done`/`integrating` 但并非全部 done ⇒ 回退到由状态派生的值；
3. 缓存是 `pending`/`planning`/`executing` ⇒ 一旦有任务开始，让位给派生值；
4. 其余（`paused`/`cancelled`/`blocked`/`degraded`）保留缓存——它们携带状态列表里没有的信息。

**`ended` 不等于完成，也不等于取消。** 它只表示「这一轮对话已经结束，当前没有任何东西在跑」；用户说「继续」后会出现新的 `turn/start`，下一份载荷自动回到原阶段。

---

## 4. 状态机

### 4.1 子任务

```
pending ──派发──▶ in_progress ──证据块全 pass / 无块旧格式──▶ done
   ▲                    │
   │                    ├──partial / 验收 fail / 坏块 / 首行 BLOCKED / 超时 / 失败──▶ blocked
   │                    │
   └────续跑重置─────────┴── blocked ──(resume)──▶ pending
```

- `done` 是终态；续跑不会重跑已完成项。
- `blocked` 可以通过 `dsh_workplan_dispatch` 续跑回到 `pending`，也可以由主 Agent 用 `update` 直接改判（包括改成 `done`）。
- 1.7.0 仍**没有**独立的「部分完成」状态值：证据块写 `status: "partial"` 会被判为 `blocked`，`error` 以「部分完成：」开头，正文说明进度。这样面板与统计口径保持 4 个值，同时不把半成品当完成。

### 4.2 计划轮次

```
pending ──规划──▶ planning ──计划落地──▶ pending(待派发)
      └─(降级)─▶ degraded

pending ──dispatch──▶ executing ──全部 done──▶ done
                         ├─预算耗尽，仍有 pending──▶ paused
                         ├─有 blocked 且无可继续项──▶ blocked
                         └─异常/中止──▶ blocked 或 paused（视路径）
 
任意未完成阶段 + 本轮已结束（载荷层）──▶ ended（suspendedPhase 记录原阶段）
未派发计划被取消 / 用户显式 cancel ──▶ cancelled
```

- `paused` 不是失败：未完成项仍是 `pending`，**不消耗续跑额度**，再次 dispatch 即从剩下步骤继续。
- `blocked` 才进入「续跑额度」计数；额度默认 4 次，可用配置改（0–5）。
- `ended` 是展示层对账结果，不改内存 phase。

---

## 5. 交接约定（摘要）

完整部门职责、典型交付物与逐部门交接清单见 **[departments.md](departments.md)**。这里只列所有部门都必须遵守的硬约定：

### 5.1 上游给下游什么

子 Agent 的 prompt 由 `src/plan.ts#buildChildPrompt` 组装，输入只有：

1. 全局任务、最终交付物、主要矛盾；
2. 当前阶段名称与目标；
3. 工作目录；
4. 最近对话背景（**截断到 7000 字**；1.7.0 在每次派发前重新采样，之后不再二次截断）；
5. 本子任务的 `role/objective/method/inputs/outputs/acceptance/risk`；
6. **仅 `dependsOn` 里的上游结果**：`{id, title, status, summary}`，summary 已是 3000 字以内的截断文本。

**下游看不到上游的原始对话**，但 1.7.0 会附上**兄弟任务的只读一览**（`buildTeamBrief`：id、部门、目标、产出、状态；已完成的带摘要），并用 `needs` 汇总需要主 Agent 转达的协作请求。产物本身仍要靠工作区文件与摘要传递，因此上游必须把「产物在哪、怎么用、什么算合格」写进摘要或落成文件。

### 5.2 下游向上游回什么

子 Agent 必须用**自由文本**汇报，并满足：

- 优先在输出末尾追加结构化证据块（`<!-- WORKPLAN_EVIDENCE:START -->` … JSON … `<!-- WORKPLAN_EVIDENCE:END -->`），含 `status` / `blockedReason` / `acceptance[]` / `artifacts[]` / `needs[]`。这是 1.7.0 的主信号：`partial`、任一验收 `fail`、坏块都判受阻，只有全 `pass` 直接采信。
- 没有证据块时，失败仍可**第一行**写 `BLOCKED: 原因`（大小写不敏感，中英文冒号都认，行首允许空白）——按 `legacy` 判受阻；其余非空文本按 `legacy` 判完成但标「未验证」，结果消息会提示主 Agent 复核。
- 正文写清：做了什么、证据/文件路径、验收结果、遗留问题；
- 不编造命令输出、文件或证据；无法确认就写「未验证」；
- 需要别人配合时，写「需要主 Agent 执行/确认什么」，**不要等待或空转**。

`summary` 会被截断到 3000 字，因此**关键结论和绝对路径要放在最前面**。

### 5.3 跨部门转达

1.7.0 **仍没有**子 Agent 直连、共享黑板或会签，但多了两个通道：兄弟任务只读一览（提示词内）与 `needs` 清单（结果消息内「跨部门待转达」）。转达仍只有两条路：

1. **经主 Agent**：主 Agent 读结果消息，用 `dsh_workplan_update` 的 `note` / `evidence` 写回结论，或在下一轮对话里补充背景；
2. **经工作区文件**：上游把接口/产物落到双方都能读到的路径，并在摘要里写绝对路径。

「兄弟任务只读一览」与 `needs` 清单已在 1.7.0 实现（`buildTeamBrief`、`buildResultMessage`）；子 Agent 直连仍然不开放。

---

## 6. 失败与恢复

| 现象 | 1.6.0 的实际行为 | 正确恢复动作 |
|---|---|---|
| 子 Agent 5 分钟无新事件 | 判 `CHILD_STALLED`，同一 prompt 重试 1 次 | 若仍失败转 `blocked`；主 Agent 核对并决定续跑或接手 |
| 单项超过 15 分钟 | 强制结束，记 `blocked` | 拆小任务或提高 `childTimeoutMs` 后重派 |
| 整轮 20 分钟预算用尽 | 阶段 `paused`，剩余项保持 `pending`，**不消耗续跑额度** | 再次 `dispatch` 即续跑，已完成不重跑 |
| 子任务 `blocked` | 下游依赖被级联标记 `blocked`；错误只写「上游子任务受阻：T1、T2」 | 先修上游；再 `dispatch` 续跑（额度内） |
| 续跑额度用尽 | `resumeAvailable:false`，结果消息要求主 Agent 直接接手 | 主 Agent 自己完成或向用户说明，不要重复派发 |
| 运行中 `update` 改判 | **允许**，但会被子任务结束时的结果覆盖（无锁） | 等本轮结束再改判；这是 1.7.0 要修的缺陷 |
| 刷新页面 | 由结果消息回放；显式 cancel 会回放 | 若改判消失，属已知缺陷（§8） |
| 新一轮取代未派发旧计划 | 旧计划只改内存为 `cancelled`，不落盘（plan 模式下未派发的计划例外：会保留） | 刷新前不要依赖「已取消」结论 |
| 规划失败 | `degraded` 消息，不自动重规划 | 向用户说明并询问是否重试 |
| 本轮对话结束但计划未完成 | 载荷阶段变 `ended`，`suspendedPhase` 保留原阶段 | 对主 Agent 说「继续」，不要重新建计划 |

**预算与额度是两件事**：`paused`（时间用尽）不算续跑次数，`blocked` 续跑才算。结果消息里的数字应以 `statuses`/`resumeAvailable` 为准。

---

## 7. 硬约束与已知限制

### 7.1 硬约束（代码层，改动需同步测试）

1. 只有 root 会话能 `dispatch` / `update` / `cancel`；子 Agent 调用会被 `NOT_ROOT` 拒绝。
2. 子 Agent 派生深度上限 1（`maxDepth: 1`）。
3. plan 模式下 `dispatch` 被 `tools.guard` 拒绝，并给出原因。
4. 状态枚举只有 4 个值；计划版本 `PLAN_VERSION = 1`。
5. `stats` 不缓存，统一由 `derivePlanSnapshot` 在出口派生；实时与回放必须同源。

### 7.2 限制清单（1.7.0 现状：哪些已处理、哪些明确不做）

| # | 限制 | 影响 | 1.7.0 状态 |
|---|---|---|---|
| L1 | 派发期间主 Agent 无法观测进度 | 用户问「做到哪了」时主 Agent 无上下文 | 已处理（async 派发 + `status` 工具） |
| L2 | 回传是自由文本，非空即 `done` | 「假完成」；验收标准没有被逐条核对 | 已处理（结构化证据 + 确定性裁决） |
| L3 | 主 Agent 与调度器都能写状态，无版本号/无锁 | 运行中改判会被覆盖 | 已处理（revision + 运行中拒绝） |
| L4 | `update` 改判只改内存、不写会话 | 刷新后人工改判消失 | 已处理（durable `workplan-update`） |
| L5 | 依赖只看 `done`，不看产物是否存在 | 上游交不出文件，下游照常开跑 | 已处理（产物门禁） |
| L6 | 未派发计划被取代时取消不落盘 | 实时/回放阶段不一致 | 已处理 |
| L7 | 阶段（stage）只是分组，不是执行门槛 | 后阶段可能先于前阶段检查点开工 | 不做（明确文档化，见下） |
| L8 | 部门之间无直接通信 | 跨部门接口对不上只能等失败 | 部分处理（兄弟只读一览 + needs 转达，仍不直连） |
| L9 | 一个会话只有一个计划槽位；计划之间无依赖/汇总 | 超长任务只能靠多轮对话承载 | 不做（后续版本评估） |
| L10 | 对话背景在计划时刻冻结，且 prompt 内再截断到 5000 字 | 续跑时子 Agent 拿到旧背景 | 已处理（派发时重新采样、7000 字、不二次截断） |
| L11 | 子 Agent 的「不要重启/安装」只是提示词 | 越权动作无法被插件拦截 | 不做（属宿主工具护栏） |
| L12 | 无证据块，无产物检查，无预算提示 | 计划过大时必然多轮 | 已处理（三者均已实现） |

**关于阶段（L7）的正式口径：阶段是展示分组，不是执行门槛。** `readySubtasks` 只读 `dependsOn`，不读 stage。这样设计是为了避免「一个慢任务拖红整个阶段」。如果产品上需要阶段验收，必须单独立项并改调度语义，不能在文档里暗示它已经生效。

---

## 8. 写者所有权（当前与目标）

### 8.1 1.7.0 实际

| 事实 | 写入者 | 写入位置 | 回放 |
|---|---|---|---|
| 计划结构 | 规划器 | `workplan` 消息 | `parseWorkplanMessage` |
| 子任务状态/摘要/证据 | 调度器 `writeSubtaskStatus`；主 Agent `updateStatus` | 内存 `record.statuses`；改判另写 `workplan-update` 消息 | 结果消息 `applyResultStatuses`；`workplan-update` 按 seq 回放 |
| 轮次阶段 | `dispatchPlan`、`updateStatus`、`reconcilePhase` | 内存 `record.phase` | 结果消息的 `phase` |
| 取消 | `cancelPlan`（用户显式） | 取消消息 | `parseCancelMessage` |
| 续跑计数 | `dispatchPlan` | 内存 `resumeCount` | 结果消息的 `resumeCount` |
| 面板数字 | 无（全派生） | — | `derivePlanSnapshot` |

### 8.2 写保护规则（1.7.0 已实现）

- 调度器与主 Agent 的改判都走同一条 `applyStatus`，每次写入递增 `revision`；
- 运行中的子任务拒绝 `update`（`TASK_RUNNING`），除非 `force:true`；
- 带 `expectedRevision` 的写入若与当前 revision 不符，返回 `STALE_WRITE`，不覆盖新证据；
- 改判写成持久的 `workplan-update` 消息，按 seq 回放；
- 所有写入都带 `updatedBy`（`child` / `agent` / `system`）。

### 8.3 改回传字段时必须同步的三处

> 这是本仓库最容易制造「实时/回放分叉」的地方（T2 约束 4）。

1. `src/runtime.ts#writeSubtaskStatus`（实时写入）
2. `src/plan.ts#buildResultMessage`（持久消息）
3. `src/plan.ts#applyResultStatuses`（回放）

任何新增字段如果只改其中一处，刷新前后就会不一致。配置值（超时、额度）只在派发入口 `src/runtime.ts#dispatchTool` 解析一次成 `limits`，再往下传；**禁止在 `src/plan.ts` 再写常量**（1.6.0 的续跑额度文案直接引用 `MAX_PLAN_RESUMES`，配置改后数字就错，是反例）。

---

## 9. 1.7.0 契约与实现状态

| 能力 | 设计要点 | 状态 |
|---|---|---|
| 异步派发 + 只读观测 | `dispatch({mode:'wait'\|'async'})` 默认 `wait`；新增 `dsh_workplan_status`；`wait` 汇合运行中的派发并返回完整快照 | 已实现 |
| 结构化证据块 | 子 Agent 在自由文本末尾追加 `<!-- WORKPLAN_EVIDENCE:START/END -->` JSON：`status/blockedReason/acceptance/artifacts/needs`；解析失败显式 `blocked`，不默认完成 | 已实现 |
| 确定性裁决 | `done` + 任一条 `acceptance.result=fail` ⇒ `blocked/failed`；部分 `unverified` ⇒ `done/unverified` 并在结果消息计数；`strict:false` 可回滚到旧判定 | 已实现 |
| 运行中写保护 | `update` 带 `expectedRevision`；对运行中条目默认 `TASK_RUNNING` 拒绝，`force:true` 才覆盖 | 已实现 |
| 改判持久化 | 新增 `workplan-update` 消息；回放按 seq 应用，低 revision 不回退 | 已实现 |
| 产物门禁 | 结算时检查 `artifacts[kind=file]` 是否存在；缺失写入 `missingArtifacts`，下游不就绪 | 已实现 |
| 取消落盘 | 未派发计划被取代时写 `workplan-cancel` | 已实现 |
| 背景刷新 | 每次派发前重新采样最近对话；单一截断点 | 已实现 |
| 兄弟可见 + `needs` 转达 | `buildTeamBrief` 注入兄弟任务只读一览；`needs` 汇总为「跨部门待转达」 | 已实现 |
| 预算提示 | planner 拿到真实预算；计划消息给出预计轮次，不阻断派发 | 已实现 |

**兼容承诺**：以上全部为「只增不改」——新字段可选、旧消息可回放、`PLAN_VERSION` 仍为 1、`dispatch` 默认行为不变。`strict: false` 与 `artifactGate: false` 提供两条回滚通道。验收编号与测试文件见仓库 `tests/` 下的 `workplan-*.test.ts`。

---

## 10. 文档与代码同步规则

1. **新文档不写行号。** 一律用 `src/xxx.ts#symbol`；历史文档里的行号不强制重写，但新改动不得增加新的行号债。
2. **改状态字段 → 同步本文 §3.3 与 §8.3 的三处代码。**
3. **改阶段枚举 → 同步本文 §3.5、`src/plan.ts#reconcilePhase`、客户端 `planPhaseOf` 与分组。**
4. **改部门列表 → 同步 `src/plan.ts#DEPARTMENTS`、本文 §1 与 [departments.md](departments.md)。**
5. **改工具参数/返回值 → 同步 `src/host.ts` 的 schema、工具描述、本文 §9 与 README 的三工具表。**
6. **发布前**：至少跑 `npm run verify`；文档中承诺的能力若未实现，必须标「未实现」。

---

## 11. 复核：这些描述怎么被验证

在 `plugins/dsh-workplan` 下执行（全部只读）：

```bash
# 角色与硬约束
grep -n "isRootSession" src/runtime.ts
grep -n "maxDepth" src/runtime.ts
grep -n "tools.guard\|dsh_workplan_dispatch" src/host.ts

# 状态枚举、计划版本、部门
grep -n "export const STATUSES\|export const PLAN_VERSION\|export const DEPARTMENTS" src/plan.ts

# 计划/结果/取消消息
grep -n "buildPlanMessage\|buildResultMessage\|buildCancelMessage\|parseResultMessage" src/plan.ts

# 状态机与对账
grep -n "export function planPhase\|export function reconcilePhase\|export function readySubtasks\|export function markDependentsBlocked" src/plan.ts

# 子 Agent prompt 与截断
grep -n "export function buildChildPrompt\|truncate(conversationContext" src/plan.ts

# 派发阻塞、重试、预算与续跑
grep -n "await record.dispatchPromise\|CHILD_STALLED\|TOTAL_TIMEOUT_MS\|canResumePlan" src/runtime.ts

# 面板轮询与只读路由
grep -n "setInterval\|/dsh-workplan/plans" src/client.ts src/runtime.ts

# 测试全绿（会先构建）
npm run verify
```

对照表：

| 本文断言 | 代码证据（符号） |
|---|---|
| 子 Agent 不能 dispatch/update/cancel | `src/runtime.ts#dispatchTool`、`#updateStatus`、`#cancelPlan` 的 `isRootSession` |
| 阶段只是分组 | `src/plan.ts#readySubtasks` 上方注释与实现 |
| 证据块决定完成/受阻，非空文本不再直接算完成 | `src/plan.ts#adjudicateResult`、`#parseEvidenceBlock` |
| 依赖同时看状态与产物 | `src/plan.ts#readySubtasks` 的 `dependencyOk`、`src/runtime.ts#checkArtifacts` |
| 派发支持 wait/async 且可汇合 | `src/runtime.ts#dispatchTool` 的 `mode` 与 `dispatchPromise` 分支 |
| 运行中 update 默认被拒 | `src/runtime.ts#updateStatus` 的 `TASK_RUNNING` 分支 |
| 改判落盘并可回放 | `src/runtime.ts#updateStatus` 写 `buildUpdateMessage`；`#reconstructFromSession` 调 `parseUpdateMessage` |
| 未派发取消落盘 | `src/runtime.ts#maybePlan` 取消分支写 `buildCancelMessage` |
| 预算暂停不耗额度 | `src/runtime.ts#dispatchPlan` 的 `paused` 分支 |
| 数字单一事实源 | `src/plan.ts#derivePlanSnapshot`、`src/runtime.ts#serialisePlan` |

---

## 12. 相关文档

- [部门职责与交接约定](departments.md)
- [协作机制审查（T2，问题证据）](review-collaboration-20261030.md)
- [1.6.0 会话终止收敛](../CHANGELOG.md)
- [安装与使用说明](../README.md) / [English](../README.en.md)
- T5 优化方案与验收标准：`deliverables/workplan/T5_优化方案与验收标准_20261030.md`
