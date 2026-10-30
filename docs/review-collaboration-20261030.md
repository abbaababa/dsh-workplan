# dsh-workplan 协作机制审查（T2）

- 审查对象：`plugins/dsh-workplan` @ 1.6.0（工作区含未提交改动，见 T1 盘点）
- 审查范围：任务分解 → 派发 → 部门子 Agent 执行 → 结果回传 → 主 Agent 整合 的全链路
- 审查方法：静态阅读源码（`src/host.ts` / `src/runtime.ts` / `src/plan.ts`）＋ 文档比对 ＋ 测试覆盖检查
- 证据等级：**【代码】**= 直接读到的实现；**【文档】**= 文档/注释中的承诺；**【推断】**= 由代码结构推出的风险，未运行验证
- 结论口径：本报告只描述“当前实现是什么、在哪里断”，不评价产品价值；未运行的行为一律标注“未验证”

---

## 一、协作机制现状说明（数据流）

### 1.1 全链路（含代码落点）

```
用户消息
  │  agent/pre-step（step===1，仅 root session）
  ▼
[L0 触发过滤] runtime.ts:1736 maybePlan
  │  isSocialMessage / isVagueContinuation / isStatusQuestion 直接放行不建计划（plan.ts:182/228/274）
  │  existing.dispatchPromise || phase==='executing' → 不重复规划
  ▼
[L1 规划] runtime.ts:205 runPlanner → ctx.llm.stream（PLANNER_TIMEOUT_MS=120s）
  │  plan.ts:675 buildPlannerPrompt（12 个部门、≤6 阶段、≤15 子任务）
  │  plan.ts:649 extractJson → plan.ts:607 validatePlan → plan.ts:523 checkPlanGraph
  ▼
[L2 计划落地] plan.ts:804 buildPlanMessage → runtime.ts:1863 enterDecision
  │  以 user/message（kind=workplan）注入，用户与主 Agent 同时可见
  │  plan 模式：额外注入 notice，禁止派发（host.ts:273-283 tools.guard）
  ▼
[L3 派发入口] host.ts:189 dsh_workplan_dispatch → runtime.ts:1453 dispatchTool
  │  守卫：root session、planId 匹配、plan 模式拒绝、dispatchPromise 去重、canResumePlan
  │  重建：内存无记录时 runtime.ts:1030 reconstructFromSession 从会话日志回放
  ▼
[L4 调度] runtime.ts:672 dispatchPlan
  │  readySubtasks(plan, statuses)（plan.ts:1503，只看 dependsOn 是否 done）
  │  runWithConcurrency(ready, MAX_CONCURRENT=5)（runtime.ts:739；plan.ts:15）
  │  失败级联 markDependentsBlocked（plan.ts:1514）
  ▼
[L5 子任务执行] runtime.ts:573 runSubtask → runtime.ts:375 executeSubtask
  │  ctx.subagents.startActivation({ provider:'spawn', parent:主 Agent, maxDepth:1, delivery:'caller' })
  │  buildChildPrompt（plan.ts:1638）：全局任务/交付物/主要矛盾/阶段/子任务/依赖结果/执行约束
  │  看门狗：idle 300s / hard 900s（runtime.ts:65-67）；stalled 重试 1 次
  ▼
[L6 依赖回传] 只回传 dependsOn 的 {id,title,status,summary}（runtime.ts:404-415），summary ≤3000 字
  ▼
[L7 落状态] writeSubtaskStatus → record.statuses（runtime.ts:363）
  │  子 Agent 输出首行 `BLOCKED:` → blocked（runtime.ts:485）；否则一律 done
  ▼
[L8 汇总回传] runtime.ts:655 buildRoundResult → plan.ts:863 buildResultMessage
  │  append user/message（kind=workplan-result）＋ dispatch 工具返回值（含 statuses/stats）
  ▼
[L9 主 Agent 整合] host.ts:38-47 系统提示：核对事实/证据/验收，不合格用 dsh_workplan_update 改判
  │  runtime.ts:1323 updateStatus（可被主 Agent 用于补完或降级）
  ▼
[L10 外部可见] GET /dsh-workplan/plans（runtime.ts:1625 route）
     client.ts:1344 fetch ＋ client.ts:1376 setInterval 4000ms 轮询
```

### 1.2 设计意图（从代码与提示可确认的部分）

| 意图 | 实现位置 | 是否真正生效 |
|---|---|---|
| 主 Agent 只做“核对与整合”，具体工作下放部门 | host.ts:38-47 | 生效（软约束，靠提示） |
| 子 Agent 不得派发/取消/改计划 | runtime.ts:1326/1456/1376 的 `isRootSession` 检查 | 生效（硬约束） |
| 子 Agent 不得重启服务/装依赖/派生 Agent | plan.ts:1685 仅写进 prompt | **仅口头约束** |
| 依赖驱动、可并行 | plan.ts:1503 readySubtasks＋runtime.ts:739 并发 5 | 生效 |
| 阶段门槛与检查点 | plan.ts:689-690、746 只进提示与 UI（client.ts:1456） | **不生效**（调度器无视阶段边界，plan.ts:1499-1501 注释自认“stage is only a grouping label”） |
| 受阻可续跑、已完成不重跑 | plan.ts:1589 canResumePlan、1560 resetBlockedStatuses | 生效（额度 4 次，可配置 0-5） |
| 刷新后状态不翻转 | runtime.ts:911 serialisePlan ＋ 1030 reconstructFromSession | 大部分生效，C10 例外 |
| 部门是“组织单元” | plan.ts:28-43 DEPARTMENTS（12 个） | **只是文案标签**：不参与调度、无负责人、无部门内队列 |

### 1.3 协作链路的真实形态

- **星型而非网状**：主 Agent 是唯一中枢；部门子 Agent 之间没有任何直接通道（无消息、无共享黑板、无互相提问）。
- **单向传递**：上游 → 下游只传 `status + summary` 文本；下游无法向上游追问，也无法告知“你的产物缺了什么”。
- **同步阻塞**：一次 `dsh_workplan_dispatch` 覆盖整轮执行，主 Agent 在返回前看不到任何中间结果（只有面板能看到心跳）。
- **回放即事实**：结果消息是唯一持久事实源（plan.ts:993 applyResultStatuses），内存 `state.records` 只是缓存（runtime.ts:1263，每会话单槽位）。

---

## 二、协作断点与风险点清单

> 编号 C1–C17。每条给出：现象 / 代码或文档出处 / 影响 / 复核方法。
> “复核方法”均为只读命令，任何人可在 `plugins/dsh-workplan` 下执行。

### C1 派发期间主 Agent 是黑箱等待【代码】

- 现象：`dispatchTool` 同步 `await record.dispatchPromise`，直到全部子任务结束或总预算（默认 20 分钟）耗尽才返回；子任务进展只写 `record.heartbeatAt`（runtime.ts:455），不产生任何中间对话消息。工具超时被设为“总预算 + 20s”（host.ts:225），即宿主也允许它阻塞 20 分钟。
- 出处：runtime.ts:672-800（while 循环）、1566-1617（await + append）；host.ts:225。
- 影响：用户中途问“在做什么”，主 Agent 没有任何可回答的上下文；一次慢子任务会让整轮“静默”十几分钟，与“各部门紧密联系”的诉求直接冲突。
- 复核：`grep -n "await record.dispatchPromise\|timeoutMs:" src/runtime.ts src/host.ts`

### C2 部门之间没有横向通信【代码】

- 现象：`buildChildPrompt` 的依赖段只注入 `dependsOn` 的 `{id,title,status,summary}`，且 summary 在写入时已 `truncate(output, 3000)`；并行兄弟任务的存在、目标、产物完全不可见。
- 出处：runtime.ts:404-415；plan.ts:1638-1693；runtime.ts:490-500。
- 影响：跨部门产物格式对不上时，只能等下游失败再由主 Agent 兜底；没有“结对/会签/互评”的承载。
- 复核：`grep -n "dependencyResults" src/runtime.ts src/plan.ts`

### C3 对话背景在计划时刻冻结，且被双重截断【代码】

- 现象：`conversationContext` 在 step 1 由 `recentConversation(session, 7000)` 计算并存入 record（runtime.ts:1568 使用），子 Agent prompt 内再 `truncate(…, 5000)`（plan.ts:1654）。之后用户补充的任何信息都不会进入已建计划的子任务；`reconstructFromSession` 不返回该字段（runtime.ts:1030-1200），重启/续跑后的子 Agent 背景为空。
- 出处：runtime.ts:124-146、1568；plan.ts:1654；runtime.ts:1030。
- 影响：部门拿到的是“旧意图”，越到后期越容易做偏；续跑场景下偏差最大。
- 复核：`grep -n "conversationContext" src/runtime.ts src/plan.ts`

### C4 回传无结构，完成判定过宽（假完成风险）【代码＋推断】

- 现象：唯一机器可读失败信号是子 Agent 输出首行匹配 `/^\s*BLOCKED\s*[:：]/i`（runtime.ts:485）；其余任何非空文本一律记 `done`。summary 只保留 3000 字自由文本，没有“证据/命令输出/文件路径/验收逐条打勾”的结构化字段。`acceptance` 数组没有被逐条核对，复核完全依赖主 Agent 自觉（host.ts:43-46 是软提示）。
- 出处：runtime.ts:485-520；plan.ts:1638-1693（执行要求段）；plan.ts:416-448（acceptance 仅校验非空）。
- 影响：写明“受阻：…”而非 `BLOCKED:` 会被记成完成；子 Agent 声称完成但无证据时，主 Agent 缺少可机读的核对抓手。
- 复核：`grep -n "BLOCKED" src/runtime.ts src/plan.ts`；`grep -rn "acceptance" src/runtime.ts`

### C5 依赖只看“状态=done”，不看“产物可用”【代码】

- 现象：`readySubtasks` 仅判断 `dependsOn.every(status==='done')`；不检查 outputs 是否真的存在。`markDependentsBlocked` 只写一句“上游子任务受阻：T1、T2”，不携带缺失产物/失败原因。
- 出处：plan.ts:1503-1512、1514-1540。
- 影响：上游“做完了但没交出可用物”时下游照常开跑，错误被推迟到更贵的环节；下游无法针对性补救。
- 复核：`sed -n '1503,1540p' src/plan.ts`

### C6 阶段检查点只是展示，调度器无视阶段边界【代码＋文档】

- 现象：planner 被要求为每阶段写 `checkpoint`、设置阶段门槛（plan.ts:689-690、746），但 `readySubtasks` 对 flatten 后的整图取就绪，跨阶段可直接并行；checkpoint 只在 UI 渲染（client.ts:1456）。
- 出处：plan.ts:1499-1501（注释：“A stage is only a grouping label”）、1503；client.ts:1456。
- 影响：“阶段验收后进入下一阶段”的协作承诺不成立；后期阶段可能在上游检查点未过时就开工。
- 复核：`grep -n "checkpoint" src/*.ts`

### C7 主 Agent 与调度器双写同一状态表（无锁）【代码】

- 现象：`dsh_workplan_update` 直接改 `record.statuses`（runtime.ts:1323-1370），**不检查** `record.dispatchPromise`；而 `dispatchTool` 对重复派发有 `alreadyRunning` 保护。两边都没有版本号或“该子任务正在执行”的保护，后写者覆盖先写者。
- 出处：runtime.ts:1323-1370（updateStatus）对比 runtime.ts:1500-1520（dispatch 锁）。
- 影响：主 Agent 在派发中改判 → 子任务结束时被覆盖；或子任务完成结果覆盖主 Agent 的人工修正。职责边界在代码层不存在。
- 复核：`sed -n '1323,1345p' src/runtime.ts`；`grep -rn "update.*dispatch\|同时" tests/*.ts`（无此覆盖）

### C8 工具描述承诺“重复调用幂等”，实现不一致【代码】

- 现象：host.ts:189-195 描述“重复调用是幂等的”；但并发重复调用走 alreadyRunning 分支，返回 `{ok:true, alreadyRunning:true, phase, startedAt}`，**不含 statuses/stats**（runtime.ts:1520）。
- 出处：host.ts:195；runtime.ts:1500-1520。
- 影响：模型第二次调用拿不到任何结果明细，可能误判“已成功但没结果”，进而重复回答或重复派发。
- 复核：`sed -n '1493,1520p' src/runtime.ts`

### C9 续跑额度文案用常量，运行时可配置 → 数字会错【代码】

- 现象：`buildResultMessage` 用 `MAX_PLAN_RESUMES = 4` 计算“剩余额度”（plan.ts:900-901、1548），运行时却用 `limits.maxResumes`（0–5，runtime.ts:1268-1280、1543）。配置 `maxResumes≠4` 时，回给主 Agent 的额度数字与真实可用额度不符。
- 出处：plan.ts:900-901、1548；runtime.ts:1268-1280、1543。
- 影响：直接决定“受阻后该重试还是直接接手”的判断，属于协作决策信息错误。
- 复核：`grep -n "MAX_PLAN_RESUMES" src/plan.ts src/runtime.ts`

### C10 未派发计划被内存标记取消，但不落盘 → 实时/回放不一致【代码】

- 现象：新一轮 step 1 时若上一计划从未派发，`maybePlan` 直接把内存 `phase='cancelled'` 并只写 `record.errors`（runtime.ts:1758-1765），**不 append 取消消息**；随后新计划覆盖单槽位 record。回放只认 `workplan-cancel` 标记消息（plan.ts:975-992），因此旧计划在刷新后回到 pending/stale。
- 出处：runtime.ts:1749-1765；plan.ts:950-992；runtime.ts:1030-1200。
- 影响：刷新前后结论不同，违反插件自身在 1.6.0 声明的“实时与回放同源”不变量（runtime.ts:957 注释）。
- 复核：`sed -n '1749,1770p' src/runtime.ts`；`grep -n "parseCancelMessage" src/runtime.ts`

### C11 跨计划、跨会话没有协作载体【代码】

- 现象：`state.records` 每会话只有一个记录（runtime.ts:1263）；面板只列 root session 且最多 20 条（MAX_LIVE_SESSIONS，runtime.ts:83、1218-1240）。一个复杂任务被拆成多轮计划后，计划之间没有依赖、引用或汇总视图；`finished[]` 快照只在同会话内、且需显式 planId 才能取回。
- 出处：runtime.ts:1030-1200（finished 快照）、1218-1240、1262。
- 影响：用户要求的“持之以恒、紧密联系”在“多计划/多轮次”尺度上没有实现载体；重启后旧计划只能靠 planId 逐个唤醒。
- 复核：`grep -n "MAX_LIVE_SESSIONS\|state.records" src/runtime.ts`

### C12 子 Agent 能力边界一半靠 prompt，一半靠代码【代码】

- 现象：硬约束只有三处 `isRootSession` 拒绝（update/cancel/dispatch，runtime.ts:1326、1376、1456）；“不能重启服务、不能安装/升级、不要派生 Agent”只写在 prompt（plan.ts:1685），`maxDepth:1` 只限制派生深度（runtime.ts:421）。文件写入与命令执行没有部门级护栏；`tools.guard` 只拦 plan 模式下的 dispatch（host.ts:273-283）。
- 出处：plan.ts:1685；runtime.ts:421；host.ts:273-283。
- 影响：越权动作可执行且不会被调度器发现；出事后只能靠事后读 summary。
- 复核：`grep -n "maxDepth\|tools.guard" src/runtime.ts src/host.ts`

### C13 规划超限即降级，没有“再分解”兜底【代码】

- 现象：`MAX_STAGES=6`、`MAX_SUBTASKS=15`、`MAX_PLAN_JSON_CHARS=60000`（plan.ts:13-16）；校验失败或 LLM 超时/输出非 JSON 时进 degraded（plan.ts:819-853；runtime.ts:1290-1330），只注入“请向用户说明并询问是否重试”，不自动缩小范围或分阶段重规划。
- 出处：plan.ts:13-16、523-605、607-628、819-853；runtime.ts:1290-1330。
- 影响：任务越复杂越容易撞上限，偏偏此时全线停摆、必须人工重试。
- 复核：`sed -n '11,16p' src/plan.ts`；`sed -n '819,853p' src/plan.ts`

### C14 失败重试只覆盖“停滞”一种，且没有失败经验回灌【代码】

- 现象：`executeSubtask` 最多 2 次尝试，仅 `CHILD_STALLED` 触发重试（runtime.ts:516-523）；超时、非 completed、空输出直接 blocked。再次 resume 用**完全相同**的 prompt 重跑（buildChildPrompt 不读取上次 error），续跑上限 4 次。
- 出处：runtime.ts:390-535、573-620；plan.ts:1589-1630。
- 影响：同一个坑可能重复踩满 4 次预算；失败原因没有反馈给下一次尝试。
- 复核：`grep -n "CHILD_STALLED\|attempt < 2" src/runtime.ts`

### C15 计划规模与时间预算之间没有校验【代码＋文档】

- 现象：planner 被要求“单个子任务 10 分钟内完成”（plan.ts:704），运行时默认子任务上限 15 分钟、总预算 20 分钟、并发 5（runtime.ts:65-79；plan.ts:15）。planner 不知道预算，也不校验“15 个子任务 × 10 分钟”在 20 分钟内是否可能完成。
- 出处：plan.ts:704、15；runtime.ts:65-79。
- 影响：合法但过大的计划必然撞总预算 → paused → 需要多轮续跑，用户观感是“怎么老做不完”。
- 复核：`grep -n "TOTAL_TIMEOUT_MS\|CHILD_TIMEOUT_MS" src/runtime.ts`

### C16 文档层：无协作机制设计文档，行号引用已漂移【文档】

- 现象：`docs/` 下 20 份 Markdown 文档全部围绕可视化/计数/阶段语义，**没有一份描述“任务→部门→子任务→回传”的协作设计**。且行号引用已过期：`docs/status-grouping-ia.md:61` 用 `src/runtime.ts:884` 指 departments，实际 884 行是 `sessionTurnState`，departments 聚合在 1007 行。这 20 份文档中共 265 处 `src/*.ts:NNN` 形式引用，未逐一校验。
- 出处：docs/status-grouping-ia.md:61；src/runtime.ts:884、1023。
- 影响：后续 Agent/维护者按文档定位会读错代码，正是本次任务“代码可读性差导致误判”的风险来源。
- 复核：`sed -n '61p' docs/status-grouping-ia.md`；`sed -n '884p;1007p' src/runtime.ts`；`grep -rho "src/[a-z]*\.ts:[0-9]\+" docs/*.md | wc -l`

### C17 人-机-部门三方只靠 4 秒轮询同步【代码】

- 现象：面板每 4s `fetch /dsh-workplan/plans`（client.ts:1344、1376），无推送；该面板是用户观察部门进展的唯一实时界面，而主 Agent 连这个界面都不读（dispatch 期间不返回）。
- 出处：client.ts:1344、1376；runtime.ts:1625 route。
- 影响：用户看到进度、主 Agent 看不到；主 Agent 的整合结论与用户此刻看到的画面可能不同步。
- 复核：`grep -n "setInterval\|/dsh-workplan/plans" src/client.ts`

---

## 三、风险分级（按“是否直接破坏协作闭环”排序）

| 级别 | 断点 | 理由 |
|---|---|---|
| 高 | C1、C4、C5、C7 | 直接造成“主 Agent 失联 / 假完成 / 下游空跑 / 双写覆盖”，协作闭环会断 |
| 高 | C9、C8 | 回给主 Agent 的决策信息错误，会引发错误动作（误判额度、误判幂等） |
| 中 | C2、C3、C6、C12、C14 | 削弱协作质量，但不一定立刻表现为失败 |
| 中 | C10、C11、C13、C15 | 状态一致性与复杂任务承载能力问题 |
| 低 | C16、C17 | 可维护性/体验问题，不改变执行结果 |

---

## 四、现有机制中已被验证有效的护栏（避免优化时误删）

1. 子 Agent 无法 update/cancel/dispatch（`isRootSession`，runtime.ts:1326 / 1376 / 1456）——硬约束，代码层成立；但 `grep -rn "NOT_ROOT" tests/` 无命中，即**没有测试覆盖**这三条拒绝路径。
2. 每个子任务独立 deadline，且超时**必定结算**（`Promise.race`，runtime.ts:573-629），一个慢子任务不会拖死整条 DAG。
3. 预算耗尽记 `paused` 而非 `blocked`，未完成项保留 `pending` 以便续跑（runtime.ts:790-850），有回归测试（`tests/workplan-budget-pause.test.ts`）。
4. 结果消息是持久事实源，刷新后由 `applyResultStatuses` 回放（plan.ts:993-1015），有测试（`tests/runtime-replay.test.ts`）。
5. plan 模式只拦 dispatch、不冻结其他工具（host.ts:273-283），不会死锁。
6. `stale pending` 不再被静默改判 cancelled（runtime.ts:1180）。

---

## 五、给后续优化（T3 及之后）的事实约束

1. 任何“跨部门直接通信”的新机制都必须解决 C1 的**同步阻塞**前提，否则只是把等待搬到另一处。
2. 任何“主 Agent 中途介入/改判”的设计必须同时解决 C7 的**双写竞争**（需要锁或版本号），否则会制造新的状态翻转。
3. 任何“阶段门槛”设计必须改 `readySubtasks`（plan.ts:1503），因为当前调度器根本不读 stage。
4. 修改回传字段时必须同步改三处：`writeSubtaskStatus`（runtime.ts:363）、`buildResultMessage`（plan.ts:863）、`applyResultStatuses`（plan.ts:993），否则实时/回放再次分叉。
5. 额度、超时这类“可配置值”只能在 `limits`（runtime.ts:1268-1280）取一次，禁止在 `plan.ts` 里再写常量（C9 即反例）。

---

## 六、本报告的局限

- 未运行插件、未执行真实派发；所有“影响”均为静态推断，标注【推断】处未验证。
- 未覆盖 `src/client.ts` 的交互细节（T2 只关心协作与状态链路），客户端只核对了轮询与部门渲染点。
- 未评估 1.6.0 之后那批未提交改动对协作链路的影响（T1 已记录工作区不干净）；若该批改动触及 `runtime.ts`/`plan.ts`，本报告行号需重新核对。
- 测试覆盖只做了“有无”判断，未评估断言强度。
