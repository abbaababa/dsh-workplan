## 1.7.0 — 2026-10-30

**「协作契约」版：让主 Agent 与各部门在全程共享同一份事实。**

1.6.0 的协作审查（[docs/review-collaboration-20261030.md](docs/review-collaboration-20261030.md)，17 条断点 C1–C17）
暴露了同一个根因：**派出去的部门与主 Agent 之间没有可核对的契约**。派发期间主 Agent 全盲；
子 Agent 交回任何非空文本就算完成；依赖只看状态不看产物；主 Agent 的改判会被子 Agent 的结算覆盖，
也活不过一次刷新。本版把「谁在做什么、凭什么算做完、改判以谁为准」收敛成代码里唯一的判定表。

### 新增

- **结构化结果契约**（`src/plan.ts#adjudicateResult`、`#parseEvidenceBlock`）：子 Agent 在输出末尾回传
  `WORKPLAN_EVIDENCE` 块，含 `status` / `blockedReason` / `acceptance[]` / `artifacts[]` / `needs[]`。
  八种情形写死在 `adjudicateResult`：`blocked` / `partial` → 受阻；任一验收 `fail` → 受阻（`failed`）；
  全 `pass` → 完成（`structured`）；含 `unverified` → 完成但标 `unverified`；无块但首行 `BLOCKED:` → 旧格式受阻；
  坏块 → 受阻（`unparsable`）。只有 `structured` 可直接采信，其余在结果消息「验收核对」段逐项列出，交给主 Agent 复核。
- **异步派发与只读观测**：`dsh_workplan_dispatch` 新增 `mode: "wait" | "async"`（默认 `wait`）。`async` 立即返回
  `running: true` 与实时状态，本轮结束时仍自动写入 durable 结果消息；新增只读工具 `dsh_workplan_status`，
  可从会话记录重建计划，刷新或重启后也能回答「做到哪了」。`wait` 遇到进行中的派发会**汇合**（`joined: true`）
  并返回完整结果，不再只回一个 `alreadyRunning: true`。
- **写保护**：`dsh_workplan_update` 新增 `expectedRevision` 与 `force`。基于旧快照的写入返回 `STALE_WRITE`；
  计划执行中改判运行中的子任务返回 `TASK_RUNNING`（`force: true` 才覆盖，并记录为人工改判）。每次写入递增
  `revision`，人工改判以 durable `workplan-update` 消息落盘，刷新后仍然生效。
- **产物门禁**：结算时逐个核实子 Agent 声明的 `file` 产物，缺失的记入 `missingArtifacts`；依赖它的下游不解锁，
  受阻文案点名上游 `T1「标题」`、原因与缺失文件。可用 `artifactGate: false` 关闭（排障/旧计划回放）。
- **跨部门 brief 与 needs 转达**：子 Agent 提示词带上「兄弟部门进展」（谁、做什么、产出什么、已完成摘要），
  并明确「需要协作请写进 needs，由主 Agent 转达」；结果消息新增「跨部门待转达」段，要求逐条处理。
- **重试回灌**：重试只发生一次且规则确定——硬超时/中止/预算到点不重试，停滞或未完成且剩余时间足够才重试；
  第二次尝试的提示词带上一次的 `code` 与原因，不再原样重撞同一堵墙。
- **时间预算预估**：规划器必须为每个子任务写 `estimateMinutes`，计划卡提示本轮预算是否够用。

### 修正

- 子 Agent 输出不再被二次截断：背景由「计划时刻采样并截断到 5000 字」改为派发前 `recentConversation` 的 7000 字，
  `buildChildPrompt` 直接使用入参。
- 依赖受阻文案从「依赖未完成或上游受阻」改为带上上游标题、原因与缺失产物。
- 结构化证据块解析失败不再默认完成，而是显式 `blocked/unparsable`。

### 兼容与迁移

- 旧会话无需迁移：没有结构化块的旧结果按 `legacy` 读作「完成但未验证」，结果消息会提示主 Agent 复核；
  `strict: false` 保留 1.6.0 的判定，供旧计划回放使用。
- `update` 原有参数与语义不变，新增参数全部可选。
- `PLAN_VERSION` 仍为 1；旧计划消息可原样回放。

### 文档

- 新增[协作契约](docs/collaboration.md)（角色、数据契约、状态机、失败恢复、写者所有权）与
  [部门职责与交接约定](docs/departments.md)；新增 [RELEASING.md](RELEASING.md) 发布清单；
  更新中英文 README 至 1.7.0 并去掉过期的测试数字硬编码。

### 验收

- `npm test` 179 个用例全绿；新增 7 个测试文件，覆盖证据契约、派发模式、写保护、产物门禁、
  跨部门 brief、重试回灌与 host 工具 schema；`npm run check` 通过。
- 原计划的 1.6.1（纯文档修复）已并入本版，不再单独发号。

## 1.6.0 — 2026-10-29

**「会话终止」收敛版**。用户截图圈出 `session-7129faea-d4bd-4ed5-a081-769496e07ceb`：
这一轮对话早就结束了（没有任何东西在跑），面板红圈的分组仍写着**「进行中」**，卡片还停在
「预算用完，可续跑」。本次让**宿主会话生命周期**成为「到底有没有在跑」的唯一事实源，并把
该结论落成新的独立阶段 `ended` / 独立分组「已结束」，同时修掉回放路径上把失败写入计为完成的
第二个打架点。

### 事故与根因

事故会话的关键事实（来自会话日志回放）：

1. 插件**只订阅 `agent/pre-step`**（`src/host.ts:286`），`turn/end`、`session/event`、
   `session/disposed` 一个都不消费 → **会话结束这件事对插件不可见**；
2. 计划阶段只由「派发动作」写入（`executing` / `paused` / `blocked` …），派发结束后
   再没有任何代码把它改回来，于是阶段永久停在被最后一次派发写下的值；
3. 唯一存在的兜底只覆盖一种情形：**从未派发**且 `pending` 超过 10 分钟才改判 `cancelled`
   （`src/runtime.ts` 的 `STALE_PENDING_MS` 分支），对「派发过、会话结束」完全无效；
4. 客户端把**除 done 以外的一切阶段**都塞进「进行中」组
   （分组条件只有 `planPhaseOf(...) !== 'done'`）→ `paused` / `blocked` / `pending` /
   `executing` / `degraded` 全部显示成「进行中」；
5. 回放路径 `reconstructFromSession` 见到 `dsh_workplan_update` 调用就 `applyStatus`，
   **忽略宿主 `tool/result` 的 `message.isError`** → 该会话里一次失败的写入被记成完成
   （面板显示 7/12，真实完成 6/12），刷新前后又一次「数据源打架」。

结论：这是**插件缺陷**，不是上游缺失——宿主侧 `turn/start` / `turn/end`（含
`aborted.reason.kind` 的 `user` / `parent` / `hook` / `disposed`）事件齐全且已落盘。

### 改动

- **`src/runtime.ts`**
  - 新增并导出 `sessionTurnState(session)`：从会话日志末尾向前扫最近 200 条
    （`TURN_BOUNDARY_SCAN`），先遇 `turn/start` ⇒ 这一轮还开着，先遇 `turn/end` ⇒
    已结束并带出 `reason.kind` 与 `aborted` 子原因；扫不到 ⇒ `unknown`（**绝不猜**）。
    读日志而不是加事件订阅：日志既是实时事实也是回放事实，实时与刷新后必然同源。
  - `serialisePlan()`（实时与回放共用的唯一出口）在既有的过期 `pending` 兜底之后、
    不变量自检之前收敛：`planPhase` 不是 `done` / `cancelled` 且这一轮已结束 ⇒
    阶段改为 `ended`，原阶段写进 `suspendedPhase`，并附带 `endReason` /
    `endReasonDetail` / `endedAt`。**`done` 不参与改写**（否则直接违反不变量 I8）。
  - **`turn/end` 不等于「取消」或「完成」**：一轮结束后可以随时续跑，因此只把
    「没有东西在跑」这件事表达出来，不动 `record.phase`——用户说「继续」、日志出现
    新的 `turn/start` 后，下一份载荷自然回到原派发阶段，无反向迁移逻辑。
  - 回放改为**先登记、后定案**：`tool/call` 只记 `callId → 参数`，等配对
    `tool/result` 到达才采纳；`message.isError === true` 丢弃，无结果同样不采纳
    （保守优先于乐观）。跨计划的迟到结果按 `planId` 拒绝，不污染新计划。
- **`src/client.ts`**
  - 新增阶段 `ended`（中「已结束，可续跑」/ 英「Ended (resumable)」）与**第三个独立分组
    「已结束」**，位置在「进行中」与「已完成」之间；分组、组头计数、卡片胶囊继续共用
    `planPhaseOf` 单一结论。
  - 新增 `phaseLabel()`：徽标两段式表达「终态 + 原阶段」（如
    「已结束，可续跑 · 预算用完，可续跑」「已结束，可续跑 · 卡住了」），
    不再用一个词暗示还在跑，也不丢「停在哪儿」这个关键信息。
  - 「已结束」组保留「需处理」角标（判定用后端下发的 `suspendedPhase`），
    组头按 `endedAt` 排序（最近结束在前）；有进行中/已结束计划时「已完成」组默认收起。
  - 图表口径随之改名：环图为「未结束 / 已完成」，柱图为「未结束计划的完成度」，
    已结束但未完成的计划一并计入「未结束」。
  - 新增 `.dsh-wp-group--ended` 样式：灰点、**不脉冲**——「没有东西在跑」不允许用动画表达。
- **版本**：`1.5.2 → 1.6.0`（minor）。载荷新增字段、客户端新增分组，属**向后兼容的对外
  扩展**而非纯 bugfix：旧客户端读新载荷只会忽略 `ended` 相关字段并把计划当 `pending`，
  不会崩溃，但**看不到「已结束」**，所以建议同步升级。

### 测试（新增 17 条，全部可复跑）

- `tests/session-end-convergence.test.ts`（12 条，后端/载荷级）：正常结束、异常中断
  （`aborted/user`）、进程级中断（`aborted/disposed`）、**正在跑不误判**、全部完成仍是
  `done` 且无不变量违规、结束后说「继续」阶段回退、刷新幂等、双会话隔离、
  扫描上限返回 `unknown`、回放只采纳成功写入（isError / 无结果 / 成功三态）。
- `tests/ended-group.test.ts`（5 条，渲染级）：`ended` 计划只进「已结束」组、组名不再出现
  「进行中」、徽标两段式、卡住的计划仍报「需处理」、无 `ended` 时不渲染空组、
  「已完成」组折叠规则。

```
npm test   # 137 tests / 137 pass / 0 fail
```

### 验证方式（任何人都可复跑）

```bash
# 1) 完整回归（含本次新增的 17 条用例）
cd /Users/open/Documents/Stocks/plugins/dsh-workplan && npm test
# 2) 只跑本次的两个新用例文件
node --test dist-tests/tests/session-end-convergence.test.js dist-tests/tests/ended-group.test.js
# 3) 面板验收（人工）：打开一个「已结束、未完成」的会话，
#    任务进度面板应把它放在「已结束」组，徽标写「已结束，可续跑 · …」；
#    说一句「继续」后，同一张卡应回到「进行中」。
```

### 兼容与升级

- 已装 1.5.x 的用户：升级后刷新页面即可，「已结束」组立即生效；
- 若面板在升级后仍显示「进行中」：先确认宿主版本已把 `turn/end` 落盘（1.6.0 依赖它，
  未落盘时会保持原判定而不是误判），再确认浏览器已加载新 `client.js`。

## 1.5.2 — 2026-10-29

**「完成语义」统一版**。用户截图圈出一张 `14/14` 全部做完、环形进度 `100%` 的计划卡，
右侧状态胶囊却写「正在收尾」，而且这张卡仍留在「进行中」组。本次把**进度**与**状态**
收敛到同一个事实源，并把状态矩阵里同一根因的 8 类矛盾一并修掉。

### 事故与根因

截图会话为 `session-c3852c31-f6cd-4fc5-8cff-d8a3932e9feb`。事件回放显示：

1. 最后一次派发在预算用尽时结束，结果消息落盘为 `12/14 done、phase: paused`；
2. 之后主 Agent 直接调用 `dsh_workplan_update`，把剩余 `T13`、`T14` 标为 done
   （会话里两次工具调用，`seq 263` / `seq 269`），**没有再发生任何派发轮次**；
3. `updateStatus` 用 `planPhase(statuses)` 重算 phase，而 `planPhase` 以
   「结果消息是否已落盘（`resultSeen`）」为终态闸门 → 全部完成后仍返回 `integrating`；
4. 结果消息只在派发轮次末尾写入，走 update 工具的路径**永远不会**写它，
   于是 phase 永久停在 `integrating`，`stats.progress` 已经是 `100`；
5. `serialisePlan` 又优先信任内存里的 `record.phase`，而回放 `reconstructFromSession`
   用 `resultSeen = true` 重算出 `done` —— 同一条记录「刷新前正在收尾、刷新后已完成」；
6. 客户端还有三套独立的「是否完成」判断：环形进度看 `percent >= 100`、
   「都做完了」看 `done === total`、状态胶囊看 `phase`，三者可以各说各话。

因此这不是文案问题，而是**完成事实有两个事实源**（计数 vs. 副作用闸门）。

### 改动

- **`src/plan.ts`**
  - `planPhase()`：所有子任务 `done` 时**恒返回 `done`**，不再看 `resultSeen`
    （参数保留以兼容既有调用，标注为历史遗留）；`integrating` 仅作为旧载荷的
    兼容取值存在。
  - 新增 `reconcilePhase(phase, statuses)`：终态只由计数决定；`done` / `integrating`
    这类「由计数派生」的旧值一律重算；`paused` / `cancelled` / `blocked` / `degraded`
    保留各自的事实来源。
  - `deriveAggregates()`：未全部完成时总进度**封顶 99**（`Math.min(99, raw)`），
    杜绝「11 done + 1 blocked@95 → 总体进度 100」。
  - `applyStatus()`：`in_progress` 的 `progress` 夹紧到 `99`，「正在做」不允许自称 100%。
  - `aggregateInvariantViolations(snapshot, phase?)`：新增
    **I8**（`done === total` 必须 `phase === 'done'`，双向）、
    **I9**（全部完成必须 100%，未全部完成不得 >= 100）、
    **I10**（`in_progress` 不得 `progress >= 100`）。
- **`src/runtime.ts`**
  - `serialisePlan()`：`phase` 改为 `reconcilePhase(record.phase ?? 派生值, statuses)`；
    载荷在存在不变量违背时附带 `violations` 数组，便于定位而不是静默显示。
  - `updateStatus()`：改为 `reconcilePhase(record.phase, record.statuses)`
    —— 截图矛盾的直接入口。
  - 派发尾部：终态晋升不再依赖「结果消息写入」这一副作用，同样走 `reconcilePhase`。
  - 回放 `reconstructFromSession()`：paused/cancelled 覆盖之后统一 `reconcilePhase`，
    保证**刷新前后同源**。
  - `cancelPlan()`：计划已全部完成时改为 no-op（返回 `alreadyDone: true`），
    消除「100% + 已取消」。
  - 预算到点分支：若此刻已经全部完成，记 `done` 而不是 `paused`（防御性，正常循环下不可达）。
- **`src/client.ts`**（自包含 bundle，不能 import `plan.ts`，故在客户端复刻同一语义）
  - 三个唯一算式：`planPercent(done, total)`、`planPhaseOf(rawPhase, counts)`、
    `planWeightedPercent(stats, counts)`；卡片环、徽章、分组、分组环、阶段条、
    会话内联卡、`rank`、`liveBars` 全部改走它们。
  - 新增文案：`helpWaitActive`（等这一步做完，再继续下一项）、
    `helpNoPlan`（还没有安排任何工作）、`nowRemaining`（还剩 {n} 项）。
- **测试**
  - 新增 `tests/phase-percent-invariant.test.ts`（13 例）：终态语义、计数封顶、
    I8/I9 双向、update 补完最后一项、空更新不回退、取消已完成计划、
    客户端渲染旧载荷。
  - 新增 `tests/completion-semantics.test.ts`（8 例）：`in_progress@100` 夹紧、
    I10、单任务执行中不再宣布完成、部分完成「还剩 N 项」、0/0 降级不说完成、
    阶段条只按 done 计宽度、阶段卡与「现在」同口径、0% 未开始不再标 active。
  - 更新 `tests/plan.test.ts`、`tests/workplan-budget-pause.test.ts` 里把
    「全部完成后停在进行中」当期望值的断言；`tests/derived-counts.test.ts`
    的 blocked 用例期望改为 99。
- **版本**：`1.5.1 → 1.5.2`（patch，修正完成语义，不新增对外接口）。

### 同类矛盾（来自 `docs/state-progress-matrix.md`）

| 编号 | 现象 | 本次 |
| --- | --- | --- |
| C1 | 100% + 「正在收尾」+ 留在「进行中」 | 已修 |
| C2 | 执行中却写「没有下一步，这件事已完成」 | 已修 |
| C5 | 部分完成却写「还没开始」 | 已修 |
| C7 | 阶段条把 blocked 算作已触达（环 50%、条 100%） | 已修 |
| C8 | 允许 `in_progress + 100%` | 已修 |
| C9 | 阶段行说「正在做」、阶段卡说「还没开始」 | 已修 |
| C11 | 0/0 降级计划也说「这件事已完成」 | 已修 |
| C12 | 同屏两个互斥的「现在」 | 已修 |
| C13 | 0% 未开始的卡标 `data-state="active"` | 已修 |
| C3 | 已取消的卡在前端被过滤，用户看不到（与 `dsh_workplan_cancel` 描述文案不一致） | 未改：既有设计，`tests/client-render.test.ts` 明确断言不渲染；记录待与工具描述统一 |
| C10 | stale pending 被序列化成 cancelled，而回放返回 `pending + stale:true` | 未改：记录为下一步 |
| C14 | `planning` 是死枚举 | 未改：记录为清理项 |

### 验证

- `npm run build` → exit 0；`npm run check`（`tsc --noEmit`）→ exit 0。
- `npm test` → **120/120 通过**，0 fail（原 99 + 新增 13 + 8）。
- `node scripts/repro-phase-percent-integrating.mjs --expect-fixed` → 7/7 PASS，
  `payload.phase = done`、`stats = { total: 2, done: 2, progress: 100 }`、
  徽章「已完成」、`live = done`、`replay = done`、无 `violations`。
  （同一脚本不带参数运行现在会 3 条 FAIL —— 这是旧 bug 已不存在、修复生效的证据。）
- 版本一致性 7 处：`package.json`、`package-lock.json` 两处、`src/host.ts`、
  `lib/host.js`、`dist/host.js`、本文件顶部，全部 `1.5.2`。
- 本次**未重启 DSH 服务**：`lib/*.js`（host 侧）在 DSH 进程下次启动时才加载；
  `client.js` 随页面刷新生效。

### 发布

- 两个渠道、同一份制品（2026-10-29 13:22–13:25 +08:00 实测，发布已完成）：
  - git：`https://github.com/abbaababa/dsh-workplan.git` 的 annotated tag `v1.5.2` → `666b0fe`；
  - npm：公共 registry `https://registry.npmjs.org/dsh-workplan` 的 `1.5.2`（`dist-tags.latest`）。
- **状态**：
  - `git push origin main` → `b0e0b76..666b0fe  main -> main`（快进，exit 0）；
  - `git push origin v1.5.2` → `* [new tag]  v1.5.2 -> v1.5.2`（exit 0）；
  - 远端复核（`git ls-remote`）：`refs/heads/main` = `666b0fee483b…`，
    `refs/tags/v1.5.2` = `155c601c73d7…` → `^{}` = `666b0fee483b…`；
  - `npm publish ./dsh-workplan-1.5.2.tgz --access public --ignore-scripts`
    （在 `git worktree add --detach /tmp/dsh-wp-1.5.2 v1.5.2` 的干净快照上先 `npm pack`，
    再发布该 `.tgz`，22 个文件全部取自 tag 提交）→ `+ dsh-workplan@1.5.2`（exit 0）；
  - `https://registry.npmjs.org/dsh-workplan/1.5.2` → **HTTP 200**，
    `time['1.5.2']` = `2026-10-29T05:24:48.346Z`（13:24:48 +08:00），`dist-tags.latest` = `1.5.2`；
  - 消费者视角：空白目录 `npm i dsh-workplan@1.5.2` →
    `meta = {"name":"dsh-workplan","version":"1.5.2",…}`（22 个文件）。
- **已发布制品的校验值**（registry 实测，与本地 `.tgz` 逐字节一致）：
  - npm `shasum`（SHA-1）：`2159024d69c05b3aeeefd5e7ff2f208ec05c67a2`
  - npm `integrity`（SHA-512 SRI）：`sha512-sY7UgT09JwfRFe61HKCOCH7wLz0xbdAxyLla3WO8xoyZ/T6Yxb6H/IqRFf9LEX9EsnW7+z4jcHICms6RKPmTzQ==`
  - 本地 `.tgz` SHA-256：`4482f202d098bbaec35051e54440d0d2be6e0099b6d6606e3c582b88e1aee9fa`
    （269 264 字节，解包 888 135 字节，22 个文件）
- 发布顺序：先分支、后标签、再 npm，避免出现「远端有 tag 而 npm 没有」的半发布态。
- registry 传播延迟实测约 45 秒（直连 404×3 → 200）。
- **CI 说明**：tag 提交 `666b0fe` 的 verify 运行 `40823115340` 为 failure——20 个用例在
  Node 22 上被 `cancelledByParent`（`Promise resolution is still pending but the event loop
  has already resolved`），与 1.5.1 / 1.5.0 / 1.4.3 的推送运行失败原因完全相同（各 20 条），
  属**既有 CI 缺陷**，与本次改动无关，也不影响制品（测试不入包）。根因是运行时把轮次预算/
  空闲计时器 `unref` 掉后，Node 22 在事件循环清空时取消挂起的测试。已在
  `9f0de34`（只改 `tests/` 两个文件，`git diff v1.5.2 -- . ':!tests' ':!docs' ':!scripts'` 为空）
  用「测试期间持有一个 ref 句柄、`after` 钩子释放」修掉；对应运行 `40823694198` 全绿。
- 命令原文与发布后验证：见 `docs/release-record-1.5.2-20261029.md`。

### 回滚

- 升级前四个文件的副本：`.backups/pre-1.5.2-20261029-125724/`
  （`package.json`、`package-lock.json`、`CHANGELOG.md`、`src/host.ts`）。
- 回滚后必须重新 `npm run build`；运行中的 DSH 进程不会自动重载 `lib/host.js`。

## 1.5.1 — 2026-10-28

**「先看这三句」与「分步进度」位置对换的补丁版**。用户以截图圈出展开态计划卡里的这两个板块，
要求把它们的布局位置互换。本次只调整渲染顺序，**数据、接口、样式与既有测试断言零改动**。

### 改动

- **展开态面板顺序对换**（`src/client.ts`）：原来的「先看这三句（`Guide`）→ 降级横幅 →
  分步进度（`PlanOverview`）」改为「分步进度（`PlanOverview`）→ 降级横幅 → 先看这三句（`Guide`）」。
  两个面板组件本身及其内部逻辑不变；`PlanOverview` 仍然只在计划卡展开时（`open === true`）挂载，
  折叠态依旧不挂载。
- **版本**：`1.5.0 → 1.5.1`（patch，仅布局顺序对换，不新增能力、不改对外载荷）；`package.json`、
  `package-lock.json` 两处、`src/host.ts` 的 `meta.version` 同步；`lib/host.js`、`dist/host.js`、
  `client.js` 由 `npm run build` 重新生成。

### 验证

- `npm run build` → exit 0；`npm run check` → exit 0。
- `npm test` → **99/99 通过**（0 fail）。
- 7 处版本一致性检查 → `[PASS] 7 处版本均为 1.5.1`（`package.json`、`package-lock.json` 两处、
  `src/host.ts`、`lib/host.js`、`dist/host.js`、`CHANGELOG.md` 顶部）。
- 提交 `fbe467b`（2026-10-28 22:27:53 +08:00）与 annotated tag `v1.5.1`
  （taggerdate 2026-10-28 22:28:51 +08:00）已就绪并**已对外发布**（见下「发布」）。
- 本次**未重启 DSH 服务**；运行实例里的界面换序靠刷新页面触发（客户端 bundle 热重载）。

### 发布

- 两个渠道、同一份制品：
  - git：`https://github.com/abbaababa/dsh-workplan.git` 的 annotated tag `v1.5.1` → `fbe467b`；
  - npm：公共 registry `https://registry.npmjs.org/dsh-workplan` 的 `1.5.1`（`dist-tags.latest`）。
- **状态（2026-10-28 22:46–22:50 +08:00 实测，发布已完成）**：
  - `git push origin refs/heads/main` → `db74d44..fbe467b  main -> main`（快进，exit 0）；
  - `git push origin refs/tags/v1.5.1` → `* [new tag]  v1.5.1 -> v1.5.1`（exit 0）；
  - 远端复核（`git ls-remote`，独立网络查询）：`refs/heads/main` = `fbe467b4a632…`，
    `refs/tags/v1.5.1` = `120dc2cb…` → `^{}` = `fbe467b4a632…`，本地 `ahead/behind` = `0/0`；
  - `npm publish --ignore-scripts`（在 `git worktree add --detach … v1.5.1` 的干净快照上执行）
    → `+ dsh-workplan@1.5.1`（exit 0）；
  - `https://registry.npmjs.org/dsh-workplan/1.5.1` → **HTTP 200**，`time['1.5.1']` =
    `2026-10-28T14:49:36.697Z`（22:49:36 +08:00），`dist-tags.latest` = `1.5.1`；
  - 消费者视角：空白目录 `npm i dsh-workplan@1.5.1 --prefer-online` → 装到 1.5.1
    （22 个文件，`client.js` 138 195 字节，`lib/host.js` 内 `version: '1.5.1'`）。
- **已发布制品的校验值**（registry 实测，与本地 `.tgz` 逐字节一致）：
  - npm `shasum`（SHA-1）：`a6f35bd1b3d2630e3a2cf9e9555b58e51b20eaba`
  - npm `integrity`（SHA-512 SRI）：`sha512-AmpYMx55Y0ea2tAc14C4V7t/Pxrho+9nZXZqxz7JtdPYvFRyxS+wzEIUCfATRgq5cogT22lTSf0pEwUYOlgdqw==`
  - 说明：同一份内容在原工作树打包时 `shasum` 为 `ecb39f0…`、在干净 `git worktree` 快照上为
    `a6f35bd1…`，差异只来自 tar 记录的 mtime；**22 个文件的 blob 哈希与 tag `v1.5.1` 逐一相同**
    （`checked 22 / mismatch 0`，另 44 个未随包发布的仓库文件按 `files` 白名单正确排除）。
    实际发布的是干净快照这一份，故以上两行为准。
- 发布顺序：先分支、后标签、再 npm，避免出现「远端有 tag 而 npm 没有」的半发布态。
- registry 有约 60–90 秒传播延迟（22:48:58、22:49:20 直连仍 404，22:49:41 转 200）；
  该窗口内 `npm i` 需加 `--prefer-online` 绕过本地元数据缓存。
- 命令原文、失败分支、发布后验证与回滚：见 `docs/release-record-1.5.1-20261028.md`。

### 回滚

- 升级前四个文件的副本：`.backups/pre-1.5.1-20261028-221343/`
  （`package.json`、`package-lock.json`、`CHANGELOG.md`、`src/host.ts`）。
- 回滚后必须重新 `npm run build`；运行中的进程不会自动重载 `lib/host.js`。
- 已推送（远端已有 `fbe467b` 与 `v1.5.1`）：`git push origin :refs/tags/v1.5.1` 删远端标签，
  `git revert fbe467b` 回退提交（不要 `push --force` 改远端 `main` 历史）。
- 已发布到 npm：先用 `npm deprecate dsh-workplan@1.5.1 "回滚说明"` 引导用户；确需撤销时
  `npm unpublish dsh-workplan@1.5.1 --force`——受 npm 官方 unpublish 政策约束（可撤销时间窗口、
  「有包依赖时不可撤销」），执行前核对 `npm unpublish --help` 与 npm 官方文档。

## 1.5.0 — 2026-10-28

**「进度必须一眼看得见」的图表化版本**。1.4.3 把数字收敛成单一来源，但计划卡折叠后仍然只有一行
12px 灰字（`本计划 0/8 做好了` + 54×5px 迷你条 + `0 卡住了`），0% 时迷你条宽度为 0、轨道色与
折叠按钮底色同 token，等于**没有图**；百分比只存在于 `title` 悬停提示里；组头在 0/0 时印
`未完成 0 / 已完成 0（完成率暂无数据）`。用户以截图指出三处画圈区域「不直观、不一目了然、不醒目」，
要求「必须通过图表等形式突出显示」。

### 改动（只动展示层，`plan.ts` / `runtime.ts` / `host.ts` 逻辑零改动）

- **折叠卡摘要改为图表**（`src/client.ts`，默认视图即可读，无需展开、无需悬停）：
  44px SVG 环 + 24px 百分比数字 + `本计划 X/Y 做好了` + 一行「现在在做什么」（卡住优先→正在做→
  全部做完/还没开始，带任务名）+ 8px 四段构成条（按件数分宽，`done/active/blocked/pending`）+
  11px 状态图例（`做好了 0 · 正在做 1 · 卡住了 0 · 还没开始 7`）+ 6px 阶段步进条
  （每阶段一段，当前阶段描边，`data-stage-id` / `data-tone` / `data-current`）。
- **展开后新增「分步进度」**：逐阶段行（名称、`done/total`、4px 细条、状态）＋加权总体进度，
  替换旧的一根计划级进度条；折叠态不挂载，保持卡头紧凑。
- **0% 不再等于「没有图」**：四层信号同时存在——环的零轨加粗到 `rgba(100,116,139,.80)`（≈3.14:1，
  `data-zero="true"`）、24px「0%」、整条灰色「还没开始」构成条、虚线阶段槽 + 当前阶段描边；
  0% 不画 SVG 弧，避免圆头端点在 12 点方向留下与「已完成」混淆的小点。
- **组头收口**：0% 组环零轨同样加粗（`data-zero="true"`）；0/0（没有工作项）时**删除**
  `未完成 0 / 已完成 0（完成率暂无数据）` 整句，只保留环上的 `—` 与组内空态；100% 组
  （`未完成 0 / 已完成 3（完成率 100%）`）整句保留，因为那正是用户要的结论。
- **零新增依赖**：进度全部由既有 `session.stats` / `session.stages` / `session.statuses` 派生，
  纯函数组件，无 `useEffect`、无定时器、不引用 chart.js；`package.json` 无 `dependencies`。
  注意 `node_modules` 里仍能看到 `chart.js@4.6.1`、`@kurkle/color@0.3.4` 标为 extraneous：
  它们是 1.4.3 之后那次「移除 chart.js 依赖」改动未执行 `npm prune` 的残留，不出现在
  `package.json`、不参与 `npm run build`，运行时图表库来自 `vendor/chart.umd.js` 路由。
- **版本**：`1.4.3 → 1.5.0`（minor，新增用户可见能力）；`package.json` / `package-lock.json` 两处 /
  `src/host.ts` 的 `meta.version` 同步，`lib/host.js`、`dist/host.js` 由 `npm run build` 生成。

### 验证

- `npm run check` → exit 0（strict + noImplicitAny）。
- `npm test` → **99/99 通过**（1.4.3 基线 90 项 + 新增 `tests/progress-visual.test.ts` 8 项 +
  `tests/version-sync.test.ts` 1 项）。
  新增用例锁定：0/8 的四个可见信号、3/8→38% 且构成条件数之和等于 total、卡住项
  `data-alarm="true"` 且阶段 `data-tone="blocked"`、三个阶段恰好一个 `data-current="true"`、
  图例恰好四项且顺序固定、折叠态不挂载分步面板、脏数据不产生 NaN/Infinity/undefined 且不超过 100%、
  卡头不引入 canvas 或图表库。`version-sync` 锁定 `package.json` = `package-lock.json` 两处 =
  `src/host.ts` 的 `meta.version`，升级时不需要改测试。
- 同步修改的既有断言：`tests/group-summary.test.ts`（两处 `完成率暂无数据` 改为「不再出现」）、
  `tests/session-collapse.test.ts`（`0 卡住了` → 图例 `卡住了 0` + 可见 `100%`）。

### 回滚

- 改造前整树快照：`.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz`
  （SHA-256 `b8ccc0efa7c307160739ffecdb4af44daab44b3a0f0c779c74d9d0783f6993c7`）。
- 代码完成、版本号未升时的中间快照：`.backups/v1.4.3-progress-viz-code-20261028-142153.tar.gz`
  （SHA-256 `c79513f5c0279e3bb291d536fba7a631fa8018e27bc7d4fca500fbabd9e602da`）。
- 恢复后必须 `npm run build` 并重启 DSH web profile（宿主启动时加载 `lib/host.js`，刷新浏览器不够）。

## 1.4.3 — 2026-10-28

**「同一个数字只能有一个来源」的根治版**。1.4.2 及更早版本里，同一个计划的数字存在两套真相源：
实时状态列表 `record.statuses` 与缓存在记录上的 `record.stats`。缓存只在**每批子任务全部跑完之后**
刷新一次，而看板头部读缓存、阶段徽标与卡片明细读列表，于是同一张卡片上会同时出现
「0 正在做」和「正在做」；预算用尽被重置成 pending 的子任务还带着上一轮的 `progress: 100`，
于是「0/3 做好」的阶段旁边挂着「正在做」、计划进度条显示 100% 而完成数是 0。

本版把计数改成**纯派生**：`derivePlanSnapshot(statuses)` 一次遍历同时产出 `statuses / stats / departments`，
再也没有第二份可被写坏的数字。

### 缺陷（4 条，全部有可复现证据）

用户报告（会话 `session-91ec3273-…`，19:02 截图）：顶部汇总「0 正在做」，而计划卡里第 3 步挂着「正在做」。
以同一份会话数据重放，确认差异为**真实缺陷**而非观感问题：

- **D1 计数缓存冻结**（根因）：`writeSubtaskStatus()` 只写 `record.statuses`，不写 `record.stats`；
  `record.stats` 只在 `while(true)` 批次循环里、**整批子任务跑完之后**才重算。批次运行期间缓存一直是旧值，
  `serialisePlan()` 又优先读缓存（`record.stats ?? computeStats(statuses)`，而 `stats` 恒已初始化，
  回退分支永不触发）。实测：真实状态 `done 2 / 正在做 1 / 待做 0`，缓存仍报 `done 1 / 正在做 0 / 待做 2`，
  进度条 33% 而真实进度 70%。
- **D2 同一报文自相矛盾**：`serialisePlan()` 里 `stats` 取自缓存、`departments` 却由 `statuses` 现场聚合，
  一个 GET 响应内 `stats.inProgress = 0` 与 `design.inProgress = 1` 并存。
- **D3 重置绕过状态机**：预算用尽时用裸对象展开重置为 pending（`progress: item.progress ?? 0`），
  绕过 `applyStatus()` 的伴随字段清理，留下 `pending + progress: 100 + childId + startedAt`。
  连带后果：旧公式把每条 `progress` 直接平均（不计状态），12 项里 11 项完成也算出 **100%**。
- **D4 同一失败两种语义**：异常收敛分支把 blocked 写成 `progress: item.progress ?? 0`，
  而其余 4 处 blocked 写入点都写 `progress: 100`。

### 修复

- **单一派生源**：`src/plan.ts` 新增 `StatusEntry / Stats / DepartmentSummary / PlanSnapshot` 与
  `normaliseStatuses`、`deriveAggregates`、`derivePlanSnapshot`、`aggregateInvariantViolations`。
  规则写死在一个地方：未知状态降级为 pending、pending 强制 `progress=0` 且清空 `childId/startedAt/finishedAt`、
  done 强制 100、进度加权 done=100、blocked/in_progress=自身进度的 clamp、pending=0。
- **删除 `record.stats`**：`src/runtime.ts` 移除全部写入与读取点（16 处），`serialisePlan` /
  `buildRoundResult` / `dispatchTool` / `updateStatus` / `cancelPlan` 全部改为「先派生一次，再用同一个快照填字段」。
  `grep 'record.stats' src/runtime.ts` 现在只剩一条注释。
- **状态机收口**：预算用尽重置改为逐项 `applyStatus(..., { status: 'pending', error: '本轮预算用尽，等待续跑' })`；
  `applyStatus` 的 pending 分支同时清空 `progress/startedAt/finishedAt/childId`（保留显式传入的 error）。
- **blocked 统一为 100**：异常收敛分支与其余写入点对齐，同一失败不再有两种进度。
- **构建卫生**：`build` 先 `rm -rf dist`、`test` 先 `rm -rf dist-tests`，并新增 `clean` 脚本。
  旧编译物残留曾让 `npm test` 报 `ERR_MODULE_NOT_FOUND ... dist-tests/src/state.js`（本次已实测复现并修掉）。
- **移出失控产物**：子 Agent 遗留、未被任何生产代码引用的 `src/state.ts` 与 `tests/state-machine.test.ts`
  移到 `docs/design-proposals/` 作参考（它与 `applyStatus` 重复实现同一语义，接入即再造双真相源）；
  `docs/design-derived-counts.reference.ts` 在设计落地后删除，`scripts/prove-derived-counts.ts`
  改为直接导入 `src/plan.ts`，杜绝「设计与实现各算一套」。

### 验证

- `npm run check`：exit 0。
- `npm test`：**90 / 90 通过**（79 项原有 + 11 项新增 `tests/derived-counts.test.ts`）。
  新增用例含**变异测试**：手工把 `stats.done +1`、`total +1`、`pending -1`、`progress=101`、部门 `done/total`
  改坏，不变量检查器必须报错——证明断言有效，而不是复述当前行为。
- `node --experimental-strip-types scripts/repro-inconsistent-counts.ts --expect-fixed`：**全部不变量 PASS**
  （场景 A 顶部 2 完成 / 1 正在做、卡片 70% / 正在做 1 / 待做 0、甜甜圈 67；场景 B 暂停项 `progress=0`、
  `childId=null`、`stats.progress=0` 与甜甜圈一致；场景 C resume 后 blocked=0）。
  同一脚本的默认模式（断言旧缺陷存在）现在 12 条全部失败——符合预期，缺陷已被消除。
- `node --experimental-strip-types scripts/prove-derived-counts.ts`：13 条断言全通过，含 500 组随机状态序列的
  不变量与幂等检查。

### 兼容性

- 对外载荷字段不变：`statuses`、`stats`（`total/done/blocked/inProgress/pending/progress`）、
  `departments` 同名同义；工具 JSON Schema 未改。
- `stats` 数值语义修正后可能与 1.4.2 的历史数字不同（这正是缺陷修复本身），旧结果消息仍可回放读取。
- `src/plan.ts` 的 `computeStats()` 保留为 `derivePlanSnapshot()` 的**别名**（标注 `@deprecated`），
  外部调用者不需要改动即可获得正确结果。

### 回滚

**1.4.3 是本项目首次公开发布**，更早的 1.0.0–1.4.2 只在本地开发，没有发布到 npm，也没有对应的 git 标签，
因此公开仓库里没有 1.4.2 的可回滚版本。如果你是从本地开发副本升级上来的，回滚到升级前那份副本即可：

```bash
npm ci && npm test        # 回到升级前的行为，先确认它仍然可构建、测试通过
dsh plugin --profile web add /path/to/the/older/copy
```

已安装的运行实例需要重启 DSH（或重新加载 `web` profile）才会使用本版代码。

## 1.4.2 — 2026-10-27

运行态验收（用户重启后的真实页面复核，7 个子任务）驱动的一轮修正，全部为**可复现证据**下的收口。

- **图表文字在浅色主题下几乎不可见（1.14:1）**：取色用了 `getComputedStyle(document.documentElement)`，而 `--dsw-alias-*` 主题变量由主题包定义在 `<body>` 上，`<html>` 读不到自定义属性时返回空串，于是恒回退 `#e2e8f0` —— 白底上仅 **1.14:1**（WCAG 要求 ≥4.5:1）。改读 `document.body` 后实测 **17.43:1（浅）/ 15.01:1（深）**。这是本轮唯一的功能级缺陷。
- **两处「完成率」口径打架**：图表按**计划数**算（1/7 → 14%），组头摘要按**工作项**算（1/2 → 50%），同屏两个百分比互相打脸。修正：图表标题写明「两类计划数量占比」「进行中计划完成度（按工作项）」，口径写进标题，不再靠读者猜。
- **「进行中」一词自相矛盾**：组头摘要原写「进行中 N」，而 N 实际是「未完成件数」（含还没开始的），与同一按钮 aria-label 里的「正在做 0 件、还没开始 3 件」冲突。改为 **「未完成 N / 已完成 M（完成率 x%）」**，与 aria 三态明细口径一致。
- **主题切换后图表文字不变色**：`ink` 只在建图那一刻读取一次，切到深色主题后图表文字仍是浅色主题的颜色。改用 `MutationObserver` 监听 `body` 的 `data-ds-dark-theme` 属性重建图表（零依赖），切换主题即刷新文字色。
- **自动展开（设计稿 §7.3 补齐）**：①最后一个进行中任务完成时，已完成组自动展开一次；②用户正展开的卡片被移入已完成组时，该组自动展开。依赖均为布尔值，4 秒轮询不会反复弹开。

- **小字对比度未达标（2.77 / 2.80:1）**：18px 统计数字与 12px 状态胶囊直接用了品牌色，白底上只有 2.80:1（橙）/ 2.77:1（蓝），低于 WCAG 4.5:1。改为主题自适应混合色 `color-mix(in srgb, 品牌色 70%, 主文本色)`：浅色实测 **#b35616 4.93:1 / #0e79a9 4.85:1**，深色 **#f99c5b 7.82:1 / #55beee 7.86:1**，色相保留。
- **环形图弧线深色主题失效**：`--dsh-wp-done-ink` 硬编码 `#0284c7`，对深色底约 2.4:1；改挂同一个自适应色。
- **焦点环 2.66:1**：组头按钮 `:focus-visible` 用 `--dsh-wp-done`；改为主文本色（浅 18.12 / 深 16.30）。
- **首屏看不到任务卡（已按用户选择 B 修完）**：`GroupCharts` 两张卡各约 246px、总览块（完成率环 + 每计划进度条）也排在两组之前，首屏被三块内容占满。现顺序为：5 格数字统计条 → 一行口径说明 → 「进行中」组 → 「已完成」组 → 总览块 → 两张图表。打开面板第一屏即是进行中任务卡，所有图表下移到两组之后。
- **旧浏览器兜底**：`color-mix` 在 Safari <16.2 / Chrome <111 不可用，原写法会让 `--dsh-wp-done-text` 成为无效值。改为先声明主文本色兜底、再用 `@supports (color: color-mix(...))` 覆盖，旧浏览器只丢色相、不丢可读性。
- **宿主元数据版本滞后**：`src/host.ts` 与 `lib/host.js` 仍写 `1.4.1`，与 `package.json` 的 1.4.2 不一致；已同步为 1.4.2。
- **条形图静默吞掉第 7 个及以后的计划**：`groups.live.slice(0, 6)` 截断后没有任何提示，读者会以为图里就是全部。改为在图表下方注明「另有 N 个进行中计划未画入图表」（中英双语，零新增依赖）。
**验证**：`npm test` **79/79 通过**；`npm run build` 无 TS 报错。

## 1.4.1 — 2026-10-27

「一目了然 + 精美绝伦」的收口版本。1.4.0 存在的问题全部由本轮的**实测证据**驱动修正。

- **致命缺陷修复：图表永远不出现**。1.4.0 用 `chartState === 'ready'` 门控 `<canvas>`，而 `chartState` 只有建图成功后才置 `ready` —— 无 canvas 就不建图、不建图就不 ready，形成死循环。只读渲染探针实测：`canvasNodes: 0 / fallbackBars: 1 / liveBarTitle: 0`。改为 **canvas 与 fallback 并存**（ready 前 fallback 可见、ready 后 CSS 互斥隐藏），修复后同一探针：`canvasNodes: 2 / liveBarTitle: 1`。
- **对比度达标（WCAG AA）**：组头计数徽章原为 12px 白字压在橙/蓝硬编码渐变上，实测 **2.26–2.80:1（进行中）/ 2.14–4.10:1（已完成）**，全部不合格；组头副标题 tertiary 实测 3.56:1 也不合格。改为「主文本色 + 半透明品牌底 + 1px 内描边」，品牌色只做底与描边。组头标题实测 **18.15:1（浅）/ 16.28:1（深）**，本就合格，保持主文本色。
- **组头完成度摘要**：新增 `groupSummary` / `groupSummaryNoRate` 与 `groupAria` 文案，组头以纯文本给出「进行中 N / 已完成 M（完成率 x%）」，分母为 0 时输出「完成率暂无数据」而非 NaN；读屏可完整念出计划数、件数、完成率与三态明细。折叠态同样可读。
- **折叠保留 DOM**：折叠走 `hidden`（布尔 true，不是空字符串）+ `--folded` CSS 类隐藏，卡片节点不卸载；`aria-expanded` / `aria-controls` 指向真实存在的节点。
- **HTML 内容模型修正**：折叠态组头是 `<button>`，原 `<h2>` 嵌在按钮内不合法；改用 `<span role="heading" aria-level="2">`，文档大纲语义不变。
- **视觉精修**（只加细节，不改结构）：组左栏 3px 竖向渐变强调条（位置+形状编码，非颜色唯一）、卡片内阴影与顶部高光、组头悬停反馈、图表标题色块、数字统一 `tabular-nums`；装饰性动效全部在 `prefers-reduced-motion` 下关闭。

**验证**：`npm test` **73/73 通过**（T5/T6 新增 6 例）；`npm run build` 无 TS 报错；渲染探针见上。

**未验证**：真实浏览器目视、窄侧栏换行、深色模式观感 —— 需重启 `dsh web` 后人工确认。

## 1.4.0 — 2026-10-27

侧栏「任务进度」一眼分清「进行中 / 已完成」。（用户确认口径：严格两组；允许引入图表库。）

- **分组**：面板改成两组 —— 「进行中」（橙色，左侧橙色竖条 + 呼吸圆点）与「已完成」（蓝色）。判定只认 `phase === 'done'` 进「已完成」；`blocked / degraded / paused` 置顶并显示「需处理 N」红色徽章；`planning / executing / integrating` 次之；`pending` 最后。已取消计划继续不显示（与 1.3.7 一致）。
- **图表**：引入 `chart.js@4.6.1`，以 `vendor/chart.umd.js` 随包分发（MIT，未走打包器——本插件客户端是手写的 `window.__ModuleLoader__` 模块工厂，无 bundler）。新增「两类任务占比」环形图（渐变）与「进行中计划完成度」横向条形图，均带数值与无障碍标签。
- **折叠**（对齐设计稿 `docs/status-grouping-ia.md` §6.4 #1/#6）：存在进行中任务时，「已完成」组默认折叠（组头可点、`aria-expanded` 同步、chevron 形状编码），避免历史任务抢走视觉权重；无进行中任务时默认展开。折叠态只在本组件内存里，不写偏好，刷新即回默认。
- **降级**：图表脚本未加载或宿主未重启时，首帧即渲染纯 CSS 双色占比条＋图例，不出现空画布；`prefers-reduced-motion` 下关闭动效与脉冲。
- **宿主**：新增只读路由 `/dsh-workplan/vendor/chart.umd.js`（`text/javascript`，1 小时缓存）；其余路由、工具、数据结构一字未动。
- **兼容修复**：`GroupCharts` 原用 `useRef`，而宿主注入的 React 兼容层未提供该 hook，`npm test` 实测抛 `TypeError: useRef is not a function`（3 个渲染用例失败）。改为「状态即 ref」（`useState` + 回调 ref，节点变化才更新），不再依赖 `useRef`；改后 `npm test` **67/67 通过**。
- **未验证**：本版本只完成编译与产物校验（`client.js` 含分组/图表/降级标记，`lib/host.js` 版本为 `1.4.0`）。**真实界面渲染需重启 `dsh web` 并刷新页面后才能看到**，尚未做视觉走查与浏览器截图验证。

## 1.3.7 — 2026-10-26

真机重启后当场复现，1.3.6 只修了一半。

- **复现**：重启后派发旧计划 `wp-8bc5c900`，返回 `Error: planId 与当前计划不匹配`。
- **根因**：1.3.6 只在「内存里没有记录」时重建。但重启后下一个回合的规划器会立刻生成新计划，内存马上就有一条别的计划记录，于是 `if (!record?.plan)` 为假，重建根本没跑，直接落到 planId 比对失败。重启窗口里内存为空的状态只存在几秒，实际用户永远撞不到那一半。
- **修复**：`dispatchTool` 现在在「内存无记录」**或**「调用方点名了另一份计划」时都重建（重建期间有派发在跑则不动），按 planId 从会话存档精确取回。点名一份存档里存在的计划，任何时候都应可派发。
- **验证**：新增用例「内存里是另一份计划时，按 planId 派发旧计划照样重建并继续跑」；`node --test` **67/67 通过**。用真实会话存档（2677 条事件）重放：不传 planId → 最新计划 `wp-0fd49b2d`、`pending`；传 `wp-8bc5c900` → `paused`、9 完成 / 2 未完成（T10、T11）；传不存在的 planId → `null`。

## 1.3.6 — 2026-10-26

真机重启后暴露的新缺陷：**重启前暂停的旧计划会变得不可派发**。

- 现象（代码推定 + 单测复现）：`reconstructFromSession` 只回放“最新那条计划消息”。重启后下一个回合自动生成了新计划，此时再派发重启前那份暂停计划，重建得到的是新计划，`dispatchTool` 随即抛 `PLAN_ID_MISMATCH`。磁盘上还有未完成的工作，却没有任何入口能继续它——又是一种“卡死”。
- 修复：`reconstructFromSession(session, targetPlanId?)` 现在为每条计划保留一份快照（状态、`resultPhase`、`resumeCount`、取消标记），派发时按 `planId` 精确取回；不传 `planId` 时行为不变（仍取最新计划，仪表盘语义不变）。
- 测试：新增「重启后仍能派发重启前暂停的旧计划」用例（两条计划在会话里、记忆为空、派发旧计划并跑完待续子任务）。`node --test` **66/66 通过**。

## 1.3.5 — 2026-10-26

真实进程（PID 7752，1.3.4）11 子任务派发：**完成 9、受阻 0、待续 2**，`phase: "paused"`、`resumeAvailable: true`、`errors` 只有一条预算说明——暂停语义与载荷字段在 1.3.4 真实进程再次成立。同一轮子任务查出两个真问题：

- **调用点变异存活（T4 实测）**：把 `buildRoundResult(record, …)` 改成 `buildRoundResult({ ...record, phase: undefined }, …)`，65/65 仍然全绿——所有用例都直接调函数本体，没有一条断言「session 里真正追加的那条结果消息」。现补端到端断言：重启重建用例派发后从会话取出 `workplan-result` 消息，断言 `phase === 'integrating'` 且键存在。同一变异现在会让用例变红（实测 64 pass / 1 fail）。
- **修复点 1 尚未在真实进程被触发（T7 实测）**：本轮派发对象是重启**之后**新建的计划（20:54:05 建、进程 20:48:23 启动），内存本来就热，`if (!record?.plan) reconstructFromSession(...)` 分支根本没进入。时间线证明「没报 NO_PLAN」≠「重建生效」。该修复目前仍只有代码 + 单测证据，需「先建计划、后重启、再派发」才能验证；验证动作安排在下一轮。
- **修复点 2 已取得运行时证据（T8）**：用真实事件流 + 进程实际加载的 `lib/runtime.js` 重放 20:54:18 派发边界 → 新计划 `phase: pending`、`resumeCount: 0`；把同一事件流喂给「删掉重置三行」的对照产物 → 立刻退回 `phase: paused`、`resumeAvailable: true`。对照组精确复现旧症状，说明这三行是承重的。
- **文档事实核对（T2）**：`plugins/.backups/dsh-workplan-1.3.4-20261026-2042.tar.gz` 文件名写的 20:42，文件系统记录的创建/修改时间是 20:32:15（构建窗口 20:32:07），命名与实际落盘时间不一致；内容本身与当前磁盘树逐字节相同（`lib/host.js` sha256 `3eea645b…`）。此处仅记录事实，不改写历史快照。

测试：65 例全部通过，其中「重启重建」一例新增端到端载荷断言。

## 1.3.4 — 2026-10-26

真实进程（PID 96748，1.3.3）的 11 子任务派发结果证明 1.3.3 的三处修正全部生效：`phase: "paused"` 进了载荷、`resumeAvailable: true`、`errors` 只剩一条预算说明、**受阻 0 / 完成 9 / 待续 2**。同一轮的子任务又查出三个新缺陷，本版修掉：

- **暂停后重启 `dsh web`，计划再也派发不了**：`dispatchTool` 只读内存记录，重启后内存为空就直接报 `NO_PLAN`「当前会话没有可派发的计划」——而卡片还在界面上。用户照我们的话重启一次，就把可续跑的计划变成了永久不可续跑。现在派发前会 `reconstructFromSession` 从会话存档重建记录并登记回内存。
- **上一份计划的暂停会污染下一份计划**：`reconstructFromSession` 的 `resultPhase` 在新计划消息到达时没有清零，于是同一会话里新建的计划在首次派发前就显示「预算用完」。现在新计划到达时重置 `resultPhase`/`resultSeen`/`resumeCount`。
- **结果写入处的接线没有测试**：1.3.3 的变异测试（B2：把 `phase: record.phase` 改成 `undefined`）存活，62 个测试全绿——没有任何用例覆盖调用点。现在结果消息构造抽成导出的 `buildRoundResult(record, sessionId, limits)`，并新增用例；同一变异现在会让测试变红（已实测）。

测试：新增 3 例（结果载荷必须携带阶段、新计划不继承暂停、重启后派发自动重建计划），全量 **65/65 通过**。

## 1.3.3 — 2026-10-26

真实进程（PID 29790，1.3.2）端到端派发已证明「预算到点 = 暂停而不是失败」：8 个子任务完成 4 个、**受阻 0 个**、其余 4 个保持 pending，面板显示「本轮预算用尽，可续跑」，没有再出现级联受阻。本轮派发又暴露三处收尾缺陷：

- **暂停计划被说成“不可续跑”**：`canResumePlan` 只认 `blocked`，而暂停留下的是 `pending`，于是载荷里 `resumeAvailable: false`，卡片提示「自动续跑额度已用尽，需要主 Agent 直接接手」——与事实相反（再派发一次就能继续）。现在 `paused` 也算可续跑，且暂停不消耗续跑额度（它是时间切片，不是返工）。
- **结果消息不带阶段，刷新后暂停会被回放成“正在做”**：结果载荷缺 `phase` 字段，`reconstructFromSession` 只能猜 `executing`。现在结果消息写入本轮 `phase`，刷新后原样回放 `paused`。
- **暂停仍把被杀子任务的「总执行超时」写进失败清单**：面板虽然显示正常，但载荷 `errors` 里留着 `["T4: 总执行超时", "总执行超时", …]`，模型会读成“有失败”。现在预算分支会剔除这些超时行，只保留「本轮执行预算（N 分钟）已到……」这一条说明。

测试：新增 3 例（暂停后可续跑且不扣额度、结果消息往返携带阶段、失败清单不含超时），全量 **62/62 通过**。

## 1.3.2 — 2026-10-26

真实进程（PID 24118，1.3.1）端到端派发暴露的剩余缺陷，全部来自“计划总预算”这条路径：

- **20 分钟总预算把正常长任务判成失败**：T1 真实跑了 840 秒才完成（1.2.1 的 300 秒上限下必死），T2 137 秒，随后总预算到点，正在跑的 T3 被记为「总执行超时」，T4–T9 级联受阻，面板再次显示「0~2/N 做好了、N 卡住了」。
- 修复：预算到点不再算失败——未完成子任务保持 `pending`（已完成的不重跑），计划阶段标记为新 `paused`，错误文案写明「本轮执行预算（N 分钟）已到：已完成 X/Y，其余 Z 项保留为未完成，再次派发即可续跑」。
- 面板与工具输出支持 `paused`：中文「预算用完，可续跑」（warn 色，不显示为「卡住了」），刷新后仍保持该阶段（按结果消息回放）。
- 自动续跑额度 2 → 4：一次派发最多 20 分钟，慢计划分多轮续跑，避免一整条计划被 20 分钟卡死。
- 规划器约束：子任务不得写「调用 dsh_workplan_dispatch / 重启或停止 dsh web / 安装升级插件」这类只有主 Agent 能执行的动作（本轮 T3「执行真实派发」对子 Agent 根本不可执行，必然失败）；单个子任务应在 10 分钟内完成。
- 子 Agent 提示：明确“没有派发权限、不能重启服务”，遇这类步骤直接说明需要主 Agent 执行，禁止空等。

## 1.3.1 — 2026-10-26

让「卡住了」变成一个看得懂、走得通的提示，而不是死路。

- 仪表盘在受阻计划上直接给出续跑指引：`对主 Agent 说「续跑这个计划」，会从受阻处继续（已完成的不重跑）`，并显示剩余额度（如「还可续跑 2 次」）。
- 续跑额度用尽时，文案改为 `自动续跑额度已用尽，需要主 Agent 直接接手完成`，不再只显示「卡住了」。
- **修复假取消**：超过 10 分钟未派发的计划原先会被重新标记为 `cancelled`，而 `cancelled` 永远不可续跑——一张没人动过的计划会自己「死掉」。现在保持 `pending`，只额外给出 `stale: true` 标记，提示而不是关死。
- `reconstructFromSession` 的载荷补上 `resumeLimit`，与实时计划保持一致。
- 新增 `tests/client-resume-hint.test.ts`（3 个用例）：有额度、额度用尽、pending 不被误显示为已取消。

## 1.3.0 — 2026-10-26

卡住（stuck）问题的系统性修复。所有改动都对应 1.2.1 及更早版本中可复现的“计划卡住”路径，回归测试见 `tests/workplan-stuck-recovery.test.ts`。

### 根因与修复

1. **固定 300 秒墙钟杀死了健康的子任务**（历史证据：22 次 `子任务 T? 超时（300000ms）`）。
   - 现在把“绝对上限”和“无进展窗口”分开：默认绝对上限 900 秒（可配置 1s–30min），无进展窗口默认 300 秒（可配置 1s–15min）。
   - 只要子 Agent 的会话日志还在增长，就不算卡住；只有日志停止增长才判定 wedged。
   - 新增 `src/watchdog.ts`（`pickTimeoutReason` / `createProgressWatchdog`），轮询间隔自动按窗口长度缩放。
   - 无进展导致的失败会自动重试一次（换一个新的子 Agent），达到绝对上限则不重试，避免烧掉整份计划预算。

2. **重新派发受阻计划是“假成功”**（历史证据：约 12 次 dispatch 完成 0 个子任务）。
   - 以前所有子任务都是 `blocked`，`readySubtasks()` 返回空，派发器直接 `ok: true`，模型以为成功，计划再也动不了。
   - 现在 `canResumePlan()` / `resetBlockedStatuses()` 支持从受阻处续跑：只重置受阻/进行中的子任务，已完成的不重跑，每份计划最多续跑 2 次（可配置 0–5）。
   - 续跑额度用尽时 `dsh_workplan_dispatch` 返回 `ok: false` + 明确原因 + `hint`，让主 Agent 直接接手，而不是重复派发。
   - 取消（cancelled）的计划永不被自动续跑。

3. **执行中不能取消**（`计划正在执行，不能取消`）。
   - 现在取消会中止正在运行的派发：`abortedRunning: true`，计划进入 `cancelled`，在途结果仍会写成 durable 消息。

4. **`dispatchPromise` 永挂后永远回答 already running**。
   - 超过“计划预算 + 120 秒”仍未返回时，派发工具返回 `ok: false`、`stale: true`，并提示主 Agent 直接接手，不再无限 wait-for-success。

5. **`[object Object]` 取代真实错误**（历史证据：1 次）。
   - 新增 `describeError()`，把 Error / 字符串 / 嵌套对象信封 / Envelope 文本统一渲染成可读文字；`record.errors` 与子任务 `error` 全部走它。

6. **缺少元数据直接炸掉子 Agent 提示词**。
   - `buildChildPrompt()` 对 `taskUnderstanding` / `contradictions` / `method` 等字段做了防御性读取；以前重建或旧版本计划缺字段会让每个子任务瞬间失败、整份计划被判受阻。

7. **构建产物漏拷 `watchdog.js`**：`npm run build` 之后 `lib/` 缺少新模块会直接导致插件加载失败，构建脚本已修正。

8. **续跑后不再写 durable 结果消息**：续跑会清除 `resultWritten`，保证刷新页面后看到的是最新结果，而不是旧的受阻快照。

### 可观测性

- 结果消息新增 `resumeCount` / `resumeAvailable`，并直接告诉主 Agent「可再次 dispatch 续跑（剩余 N 次）」或「额度已用尽，请直接接手」。
- 仪表盘 payload 新增 `heartbeatAt`、`resumeCount`、`resumeLimit`、`resumeAvailable`、`dispatchElapsedMs`。
- 派发工具的渲染文本会带出 `仍在执行（已 Ns）` 与失败时的「下一步」提示。

### 可配置项

| 配置键 | 环境变量 | 默认 | 范围 |
| --- | --- | --- | --- |
| `childTimeoutMs` | `DSH_WORKPLAN_CHILD_TIMEOUT_MS` | 900000 | 1000–1800000 |
| `idleTimeoutMs` | `DSH_WORKPLAN_IDLE_TIMEOUT_MS` | 300000 | 1000–900000 |
| `totalTimeoutMs` | `DSH_WORKPLAN_TOTAL_TIMEOUT_MS` | 1200000 | ≥ 60000 |
| `maxResumes` | `DSH_WORKPLAN_MAX_RESUMES` | 2 | 0–5 |

### 测试

- 新增 `tests/workplan-stuck-recovery.test.ts`（11 个用例）：续跑判定、状态重置、结果文案、超时分类、watchdog 增长/停滞、错误渲染、端到端「停滞→受阻→续跑→完成」、额度耗尽、执行中取消、陈旧派发。
- 全量 `npm test`：51 个用例全部通过。

## 1.2.1 — 2026-10-26

- “做好了/已完成” now uses sky blue (`#0ea5e9`); “正在做” uses orange (`#f97316`) across the summary strip, donut, legend, task bars, mini bars, cards, pills and tool-turn accents.
- Other status colors (blocked/pending) are unchanged; no layout, interaction or dependency changes.
- Added a static regression test for the two status color mappings.

## 1.2.0 — 2026-10-26

- Task progress rows in “每个任务的进度” are now buttons: one click expands the matching task card and scrolls it into view.
- Task cards expose a stable DOM anchor; scrolling uses `scroll-margin-top` so the fixed header does not cover the title.
- Keyboard users can Tab to a task row and press Enter/Space; focus moves to the expanded card.
- No new dependency; theme tokens and responsive layout are unchanged.

## 1.1.1 — 2026-10-26

- Plan mode no longer skips decomposition. The plugin now generates a plan in plan mode and explicitly defers dispatch until the user leaves plan mode.
- While plan mode is active, only `dsh_workplan_dispatch` is denied, with a clear reason; every other tool stays available, so there is no guard deadlock.
- A plan produced in plan mode is preserved across turns instead of being cancelled before the user can approve it.

# Changelog

## 1.1.0 — 2026-10-26

- Dashboard now shows a fifth `任务` cell in the circled summary strip, so the plan count is visible next to work-item and status counts.
- Added a status donut and per-task progress bars (SVG/CSS, no new dependency) for a more visual, less text-heavy overview.
- Added a compact progress bar to each collapsed task card, so progress is visible without expanding.
- Mobile: five-cell strip becomes a readable 2-column grid, with the task cell spanning the full width; the charts stack in one column.
- Version metadata is now `1.1.0` in the plugin manifest and host `meta`.

## 1.0.0

- Initial TypeScript implementation: pre-step task decomposition, real department subagents, durable plan/result messages, `dsh_workplan_update` / `dsh_workplan_dispatch` / `dsh_workplan_cancel`, and the responsive `任务进度` dashboard.
