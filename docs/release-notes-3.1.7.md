# dsh-workplan 3.1.7

## 3.1.7 — 2026-11-21（接续证据分层：蓝图全量 + 审计链索引 + 落盘原文）

3.1.6 让专家接续时带上了**完整**登记证据（此前只有 approach 前 300 字符）。证据完整了，
但一次接续要重复贴约 2,374 字（实测 5 份真实样本：1,775 / 2,234 / 3,420 字），其中
**约 73% 是审计链**（任务梳理、资源、工具、已备清单、就绪证据），真正指导执行的
`approach + approachBasis` 只占约 27%。

把上限从 6,000 砍到 3,000 是**丢证据**（模型看不见就会重做或猜），不是治本。3.1.7 改成
「**证据一条不丢，但只为必须照做的部分付费**」：

- **蓝图全量**：`approach`（方法流程步骤）+ `approachBasis`（依据）逐字进提示词——
  这两段直接决定怎么执行，必须让模型看见。
- **审计链索引**：`problemAnalysis / resources / tools / prepared / evidence` 只给
  「N 条 / M 字」的规模索引，正文不再重复。
- **完整原文落盘**：接续时把消毒后的登记原文写到工作区
  `reports/wp-start-evidence-<planId>-<subtaskId>.md`（`persistStartEvidenceFile`），
  提示词给出该路径并注明「需要逐字核对时读取，不要凭记忆重写」。
- **安全阀**：拿不到 cwd、目录只读、证据非法 ⇒ 返回 null ⇒ 调用点**回退全文注入**
  （3.1.6 行为），任何情况下都不会因为这条路丢证据。

实测效果（同一批 5 份真实登记证据复算）：接续提示词从**平均 2,656 字降到 1,048 字**，
**每次接续省 1,608 字（约 997 token）**；8 专家部门每轮约省 **7,975 token**。
落盘文件为纯本地写入，不产生模型调用；读取只在执行确实需要核对原文时发生。

验证：`npx tsc --noEmit` 通过；`npm test` **pass=1420 / fail=0 / cancelled=0 / todo=1**
（新增 4 例守门：分层摘要只含蓝图与索引、无引用时回退全文、落盘文件含完整原文、非法输入返回 null）；锚点 82/82。
版本：`package.json` / `package-lock.json` / `PLUGIN_VERSION` / `meta.version` /
README / 工具面夹具 统一 **3.1.7**。

## 3.1.6 — 2026-11-21（治「负责人身份竞态」与「phase-0/phase-1 口径冲突」）

现场复盘：核验计划里 T2、T3 各失败一次（`SELF_EFFORT_MISSING`）后重试，`noticeChannel`
记 `NOT_OBSERVED_IN_SESSION_LOG`。回到源码后定位到两条**局部逻辑与整体逻辑互相矛盾**的根因，
本轮一次修清。

### 一、负责人身份只在内存，台账一重建就「查无此人」（治本）

- **现象**：部门负责人以 phase-0（low 档）启动后要做的第一件事，是调
  `dsh_workplan_delegate(action="review"/"direct")` 登记推理等级；但入口按
  `childId` 反查自己的行，查不到就报 `NO_SUBTASK`（childId 未登记）→ 等级登记不了
  → phase-0 结算闸报 `SELF_EFFORT_MISSING` → 平台重试一次，白烧一轮。
- **根因**：`writeSubtaskStatus` 只改内存台账（`record.statuses`），**不写 durable 日志**。
  轮次进行中任何一次台账重建（手动 dispatch、`update` 改判、重启回放）都会用 durable
  日志重造记录，内存里的 `childId` 随之丢失。
- **修法**（`src/runtime.ts`）：
  1. 新增**派发实例表** `activationRegistry`（`WeakMap<ctx, Map<childId, {planId, subtaskId}>>`），
     在三处派发点登记：第一层负责人（`executeSubtask`）、第三层专家（`delegateTool`）、
     self_effort 接续（`newChildId`）。它是同一进程内的客观事实，不随台账对象重建而丢失。
  2. `delegateTool` 入口加两道认亲兜底：先按派发实例表找回本会话对应的行，再按
     `childIdHistory`（换主留档）认回旧会话；认回后立刻调 `persistChildIdentity`
     把 `childId` **补写进 durable 日志**，下一次重建即可自证。
  3. `buildUpdateMessage` 载荷新增 `childId`（additive），主回放与 WAL 消费两条通道
     都认它 ⇒ 身份与台账同源、不再两套。
- **效果**：台账重建不再导致「查无此人」；`SELF_EFFORT_MISSING` 与随之而来的无谓重试
  从根上消失；旧日志没有该键，读端零迁移。

### 二、phase-1 同时被告知「不要重做」和「必须先做前三步」（口径统一）

- **现象**：phase-1 任务书上方是 `phase-0→phase-1 接续` 块，明写「不要重做 phase-0 已完成的工作」；
  下方「执行要求」首条却写「执行自己的任务**必须先完成**五步工作法的前三步」。同一份任务书
  里两条指令正面冲突，模型只能二选一：重做前三步（白烧 token、还可能覆盖已登记证据），
  或违反执行要求。
- **修法**：
  - `src/plan.ts` `buildChildPrompt`：按 `phaseZeroContinuation` 分流——接续时明确
    「前三步已在 phase-0 完成并登记，不要重做、不要重新登记，直接从第四步执行」，
    只做核对与增量补充；拿不到接续块（旧计划/无 phase-0 产物）时保留原口径。
  - `src/llm-rules.ts` `buildDelegateePrompt`：专家任务书同理，首条改为「前三步已登记，
    不要重做，直接从第四步执行」。
  - 到处出现的「平台会立即以你的自配档**接续本会话**进入 phase-1」（含 phase-0 任务书、low 直执拒绝文案、接续块正文、运行时 hint）改为
    「接续（宿主**另起执行会话**并携带本阶段产物，不是当前评估会话）」——宿主
    spawn 每次都是全新会话（`manager.ts` 每次 `randomUUID()`），旧说法与机制不符，
    会让负责人误以为「还是我这个会话」，从而不把 phase-0 产物写进接续简报。
- **效果**：一句话只出现一次、一个阶段只有一个口径；phase-1 不再重做前三步，
  也不再与 phase-0 的登记证据打架。

### 二之补：接续时到底「知道多少前三步成果」

既然要求「不要重做」，就必须让执行者看见前三步的成果，否则等于让它闭着眼睛跳步。

- **负责人（phase-1）**：接续块携带 **登记证据原文全量**（`renderStartPhaseEvidence(sanitizeStartPhaseEvidence(effortRow.startPhases))`，受 20 条 × 800 字符、总量 6000 字符的统一上限约束）＋ phase-0 口语摘要（按 600 字符截断，省 token 的既有设计）。
- **专家（phase-1）**：旧实现只回注第二步 `approach` 的前 300 字符；本轮改为同样携带 **登记证据原文全量**（`renderStartPhaseEvidence(leafStartPhases)`），并在开头注明「宿主另起执行会话，不是刚才那个 phase-0 评估会话」。
- **诚实边界**：`所有成果 ≠ phase-0 会话的全部上下文`。宿主不继承父会话对话，phase-0 读过什么、想过什么无法整段搬运；能搬的是**已登记的书面证据**。因此口径限定为「**登记证据已覆盖的部分不要重做；登记范围之外、执行确实需要的细节缺口，先补齐再执行（只补缺口，不推倒重来）**」——这也是本轮同时改掉「绝对不要重做」措辞的原因。

### 三、验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm test`：**pass=1416 / fail=0 / cancelled=0 / todo=1**（基线 1409 + 新增守门 6 例 `tests/identity-race-316.test.ts` + 版本断言随定版升级）。
- 版本：`package.json` / `package-lock.json` / `src/host.ts` `PLUGIN_VERSION` / `meta.version`
  统一为 **3.1.6**；工具面基线夹具同步。

## 3.1.5 — 2026-11-20（第三层完成度同源投影：专家已完成与部门行未汇总不再互相矛盾）

### 2026-11-21 晚补（按 T12 范围决策单执行全部 39 条必改：P0 卡死 7 + P1 丢数据 4 + P2 门禁 16 + P3 重复注入 12）

本轮把第二轮全方位审查（87 条问题 = 42 真矛盾 + 20 冗余 + 4 文档不符 + 21 设计权衡）里判定「必改」的 39 条全部落到源码。每条改完即 `npx tsc --noEmit` + `npm test`，最终 **1409 通过 / 0 失败 / 1 todo**（基线 1394 + 新增守门 15 例），锚点脚本 78/78 成立。

**P0 派发台账与入口快照（7 条，治「卡死/倒退」）**
- U-63/U-64/U-68（src/runtime.ts + src/plan.ts）：`delegateTool` 新增 `liveRow()`，`persist` 的 revision 与 delegates 一律基于**当前台账**而非闭包旧快照；新增 `mergeDelegateEntriesMonotonic`（条目级单调合并：低秩不覆盖高秩、同秩只认更晚时间戳、待指示条目绝不覆盖、已 sent 通知标记不回退、childId 稳定；**新一轮尝试例外**——不同 childId + running 视为负责人显式重派，取代旧终态，失败成员可再跑）。dispatch 不再整表覆盖在途结算。
- U-65/U-61：待指示门禁与 status 返回体改读 `liveRow()`，不再拿过期快照硬拒/回旧值。
- U-71（src/plan.ts）：负责人换主留档 `childIdHistory`（≤8 条、消毒拒非法），旧负责人会话不再凭空失联。
- U-37（src/runtime.ts + src/host.ts + src/llm-rules.ts）：`self_effort` 新增成员名兜底认亲（`member` 参数 + 台账未登记 childId 时按成员名匹配），phase-0 任务书写明 member 必填；叶子首次登记不再必报「childId 未登记」。
- U-50/U-16（src/runtime.ts）：僵尸回收不再裸写——补 closure/blockedKind/finishedAt/revision/updatedBy，blocked+instructed 僵尸行可被续跑重置。

**P1 回放与落盘（4 条，治「重启丢数据」）**
- U-38：回放 update 白名单补齐 13 个闭环字段（question/options/blockedKind/escalatedAt/escalationSeq/instruction/instructionSeq/assignedAt/ackedAt/ackEvidence/ackOverdue/instructionOverdue/reportedAt）+ childIdHistory。
- U-43（src/notice-ledger.ts + src/plan.ts + src/runtime.ts）：**台账写前日志（WAL）**——进内存缓冲的同一时刻同步落插件自有 JSONL（`appendWorkplanUpdateWAL`，form='wal'，携带 walId/walSeq/planCreatedAt）；flush 成功后写 ack（`appendWorkplanUpdateWALAck`）；回放消费四道闸：ack 跳过 + planCreatedAt 计划实例归属 + walSeq 会话实例归属 + revision 严格前进。崩溃窗口内只进过内存的更新不再永久丢失，且绝不污染别的计划/会话实例。
- U-15：回放自愈只补 closure/report/reportedAt，**不额外抬 revision**（applyStatus done 分支已抬号，再 +1 会破坏「durable 与 tool/result 只写一次」不变量）。
- U-52：resumeCount 自增当场落 durable（buildUpdateMessage 增 resumeCount），回放 Math.max 只前进；崩溃不再丢续跑计数。

**P2 状态单一真相（16 条，治「两套账/门禁绕过」）**
- U-05：新增 `STATUS_TRANSITIONS` 迁移守卫，done→in_progress 拒绝（返工必须经 pending 重置），同值/合法边/旧值放行。
- U-06：从非 done 进入 done 是新完成，closure 回 'done' 中间态等 markReported，不继承旧 reported（封死「返工后新结果永不进待回报」）。
- U-08：settleStaleInflight 投影补 closure/blockedKind/finishedAt + staleProjection 显式标记，不抬 revision（只读投影不冒充持久状态）。
- U-12/U-13：cancel 全 done 分支先 markReported 幂等补齐再 reconcilePhase，返回体带 reportPending 与明确出路 hint；**不改 supersede V3 冻结守卫**（全 done 不得 supersede 是契约，治法是给 no-op 出路）。
- U-14：blocked 放弃请示必须留理由（ESCALATION_ABANDON_REASON_REQUIRED），封死「先 blocked 静默放弃再 done」两步绕过。
- U-19：blocked（非 escalated）把 report/reportedAt 迁入 lastReport/lastReportedAt，「已卡住」与「已回报」不再同屏。
- U-18：normaliseStatusEntry 对 'Done'/'DONE ' 脏值保守归一，不再误降 pending 丢进度。
- U-11：canResumePlan 补 replanned 过滤，与其余 5 处同口径。
- U-17：markReported 对非 done 却带 reported 投影的行记 record.errors + reportPending=true（fail-closed 可定位）。
- U-10：blockCancelledDependents 改传递闭包，A→B→C 链不再让 C 永远 pending。
- U-20：纯时限事务第 4 条旁路收口走 applyStatus（不再裸写 revision）。
- U-39：两处指示回执（scheduleInstructionAck / scheduleDelegateInstructionAck）写内存的同时落 durable，重启不丢回执。
- U-40：回放识别 assignedNoticeKey/preAnnouncedPlanId 哨兵，重建后不再重复刷屏。
- U-21：closure 迁移表注释「19 条」更正为实测 40 条边。
- U-61：已在 P0 覆盖（status 读 liveRow）。

**P3 删重复注入（12 条，治「同一句话付两遍 token」）**
- U-24/U-26（src/llm-rules.ts）：专家规则简报不再重发五步全文与 startPhases 结构展开，改指针「完整协议见任务书下方」；预估门禁只留义务声明。关键串保活。
- U-27：buildDelegateePrompt 执行要求首条不再逐字重发五步前三步全文（下方 fiveStepPromptLines 已含），保留义务 + 第四步纪律。
- U-32：负责人汇总字段清单不再在简报重发（下方 F11 契约已含），改指针。
- U-28（src/host.ts）：PROMPT_SECTION 第二处门禁码括注改「同一组门禁码，见上文」。
- U-25/U-34（src/plan.ts）：第二次回合收尾 steer 改短提醒（headline + 剩余量 + 唯一恢复动作 + 页脚），不再逐字重发整段正文；attempt=1 仍发完整文案，关键串全部保活。
- U-29/U-31（src/runtime.ts）：完成/终止通知第二路改指针（摘要/reason 正文只在 sendMessage 那一路出现一次）。
- U-30（src/plan.ts）：质量要求缺失时回落改单行指针「质量要求＝下列验收标准」，不再把 acceptance 原文渲染两遍。
- U-36（src/runtime.ts）：看板载荷删除 plan 整包（客户端只读 stages+statuses，plan 是纯冗余第三份）。
- U-62（src/runtime.ts）：status 响应体 delegateReconciliation 改 reconciledCount + unresolved，不再整组复制 delegates 已有的明细。

**配套**：delegates 消毒补 queuedMs（此前写入但白名单丢弃）；buildUpdateMessage payload 增 planCreatedAt/resumeCount/childIdHistory；新增 `tests/workplan-317-fix-guards.test.ts` 16 例守门（单调合并/换主留档/迁移守卫/新完成不继承 reported/脏值归一/blocked 清回报/回放白名单/WAL 闭环与归属闸/僵尸回收 finishedAt 补正/第二次 steer 短提醒）。

**重启后实测追加修正（2026-11-21 20:03，U-50 补正）**：用户重启后做只读核验时发现僵尸回收的 `finishedAt` 仍停在 null——根因是 `!Number.isFinite(Number(row.finishedAt))` 把 null 误判成「已有时间戳」（`Number(null)===0` 且 `isFinite(0)===true`）。已改为「不是有限正数就补当前时间」，并新增守门测试钉住。全量回归 **1410 通过 / 0 失败**。此修正需再次手动重启才进入运行进程（核验时运行进程 build e3648adf9c543aaa 含 39 条主体修复，但不含这一处补正）。

**回归**：`npx tsc --noEmit` 通过；`npm test` **1410 通过 / 0 失败 / 1 todo**（todo 为既有 GAP-T6-2 多主产物校验缺口，非本轮引入；含重启后实测追加的 finishedAt 补正守门 1 例）；`reports/T7_anchors_check.js` 78/78 成立（行号未变 25、漂移 53、缺失 0）。**需用户手动重启 DSH 才生效**（插件不自行重启）。

### 2026-11-20 晚补（缺陷 22「专家停了、负责人永远在等」治本 + 省钱三件套）

- **缺陷 22 第一处治本（src/runtime.ts，读时对账前移）**：旧版 `reconcileEndedDelegateSessions` 只有一个调用点（`action="status"`），负责人不主动查就永远看不到「叶子会话已结束」。现在 `delegate` 在 `status/dispatch/direct` 三个入口先对账再走原逻辑（入口块 `entryReconciliation`），`status` 分支不再重复采集；对账失败写回 `reconciledFrom` 供回放区分。
- **缺陷 22 第二处治本（src/runtime.ts / src/plan.ts，终止事件推送）**：新增 `classifyDelegateTermination`（failed / interrupted / empty-turn / reconciled / settlement-error 五类）、`buildDelegateTerminationBody`（五套独立文案，统一结尾「这是终止通知，不代表任务完成；本判定不含任何超时」）、`emitDelegateTerminationNotices` / `deliverDelegateTerminationNotices`（投递到负责人会话、跳过待指示与已完成、`delegates[].termination` 幂等标记、写失败不掩盖结算）。接线三处：`delegate` 与 `self_effort` 结算回调、自配档接续失败两处、读时对账写回。`plan.ts` 的 delegates 白名单新增 `termination` 消毒（非法形状整体丢弃），durable 回放不丢标记。终止通知不写部门 journal：journal 的 kind 是 T5 冻结契约（7 种，防漂移测试守着），不硬塞也不私扩。
- **省钱三件套 ①（src/host.ts，工具按角色声明裁剪）**：14 个 workplan 工具改为按会话结构（`parentSession` / `origin=subagent` / `delegationDepth`）声明：根会话全量；其余会话隐藏 10 个根专用工具（`lessons` 也在内，runtime 只允许根会话读取）；`instruct` 只给 depth≤1；判定 fail-open（拿不准就可见）。实测每步少注入 ≥11,331 字符（负责人）、≥12,250 字符（专家），权限硬校验原样保留。宿主自带的 51 个非 workplan 工具插件无权裁剪（无公开 API），不在本次范围。
- **省钱三件套 ① 回归修正（2026-11-21）**：首版裁剪把 `dsh_workplan_delegate` 当成「负责人专用」对 depth≥2 隐藏，但叶子的唯一开工登记入口正是 `delegate(action="self_effort")`，全仓并不存在 `dsh_workplan_self_effort` 独立工具。现场后果：叶子工具面只剩 escalate/lessons/verify，phase-0 无法登记，T2 等多条第三层任务直接卡死。现已改为：`delegate` 对所有子会话保留，`instruct` 仍是根/负责人专用，`lessons` 归入根专用；`tests/tool-role-trimming.test.ts` 增加「叶子必须看到 delegate」的守门断言。全量回归 1394 通过 / 0 失败。
- **省钱三件套 ②（src/host.ts，系统提示分段）**：在子 Agent 的 `agent.ctx` 注册同名 section 遮蔽全局「主 Agent 专属段」（官方语义：scoped section shadows global）。根会话原文不动；子会话每步把 5,354 字符换成约 60 字子会话提示；`agent/created` 注册 + `agent/pre-step` 单监听器兜底，WeakSet 幂等，异常 fail-open。已用 `@deepseek-ai/dsh-system-prompt` 现场实验验证遮蔽语义（scope 内取到子文本、全局仍取到原文）。
- **省钱三件套 ③（src/plan.ts，任务书去重）**：`buildChildPrompt` 里 `renderDepartmentSummarySpec()` 与 `renderCommFormatSpec('leader')` 相邻重复（后者已内含前者，OV-08），删掉前者，每份负责人任务书少 726 字符。
- **回归**：`npx tsc --noEmit` 通过；`npm test` 1394 通过 / 0 失败（新增 `tests/tool-role-trimming.test.ts` 5 例；`T8-4` 断言更新为「failed 不产生完成通知、但必须产生终止通知且幂等」）；`reports/T7_anchors_check.js` 改为按内容定位并减掉已修复的 OV-08 锚点，78/78 成立（行号未变 42、漂移 36、缺失 0）。

- **事故口径**：T4 已派 agent-2/agent-3（行业景气专家、资金面专家），看板逐条显示两名专家完成；但 T4 行/状态查询仍显示未完成，用户看到“已完成”和“没完成”两种结论。
- **源码级根因**：不是第二份状态，也不是缓存。看板读取 `delegates[].status`，计划行进度与 `dsh_workplan_status` 以行级 `status` 为权威；旧版没有一个同源聚合字段说明“下级全部 done、但部门负责人尚未汇总收尾”，于是两个不同层级的事实被读成同一层级的矛盾。
- **源码级根因 2（目标会话实测）**：行业景气/资金面两个叶子会话已经 `turn/end`，甚至已输出普通文字结论；但收尾缺少合格 `WORKPLAN_EVIDENCE` 结果块，严格结算不能记 done。若异步结算回调再被吞，`delegates[].status` 会永久停在 `running`，与会话侧“已结束/已完成”的观感冲突。
- **修复（src/plan.ts / src/runtime.ts / src/client.ts，标记 [3.1.5]）**：新增 `deriveDelegateCompletion` 读时纯函数并挂入 `normaliseStatusEntry` 与 `modelStatusLines`，输出 `delegateCompletion={total,done,failed,running,rejected,blocked,timeout,escalated,allDone,awaitingLeaderSummary}`；客户端在行未完成但下级全 done 时明确显示“下级专家已全部完成，正在等本行负责人核验并汇总”。不自动把 T4 改 done，部门汇总 F11 与证据门禁仍由负责人收尾。
- **修复 2（src/runtime.ts `reconcileEndedDelegateSessions`，标记 [3.1.5]）**：负责人 `delegate action="status"` 时按叶子会话日志重放最后助手正文：合格 F10 汇报补结算 done；普通正文/缺结果块按实收敛 failed；phase-0 工具调用结束、待指示、无会话/回合仍开均不误杀。
- **回归**：新增 `tests/delegate-completion-projection.test.ts` 4 例与 `tests/delegate-ended-session-reconcile.test.ts` 4 例（全 done/in_progress、部分失败、无分工与 replanned 旧行、快照与模型可读面同源、结束无块收敛 failed、phase-0 不误判、待指示不覆盖、unknown/open 不变）；版本声明统一 3.1.5。

