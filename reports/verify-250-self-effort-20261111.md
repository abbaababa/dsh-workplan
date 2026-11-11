<!-- task-3 专属交付报告；与 reports/verify-250-mechanism-20261111.md 追加章节同源同内容 -->

# 2.5.0 自配档·先配置后开工——实现与验证证据报告

## 新口径（lead 传达用户裁定）

①负责人按自己接到任务的复杂度自配推理等级，整个分配过程（派活/协调/验收/重试决策）全程用自配档；②每位 expert/member 各自按自己分到的单项任务复杂度自配自己的等级，各自执行全程用自配档；③分工表 per-member 档降为**建议**，成员自配为**权威**；继承不再是主路径（仅旧计划回放兼容保留）。

## 宿主契约核验（expert 子代理 xhigh + 部门负责人亲读，结论一致）

证据基准：`/Users/open/.npm/_npx/72500ffcd8799faa/node_modules/@deepseek-ai/`（dsh-subagent/lib/…）：
1. `startActivation` 只能新建：request 无 resume/childId 指向字段；传既有 childId 必报 `DUPLICATE_CHILD`（manager.js:536-539/363-370）。
2. `reasoningEffort` 在子会话创建时解析进 descriptor（manager.js:327-338），冷恢复只回放 descriptor、驻留续跑不带 agentOptions ⇒ **同一 durable session 无法换档**。
3. `interrupt(target, authority)`/`interruptByParent(child, parent, 'continuable')` 存在（index.d.ts:182-197/266-280）：fire-and-return、保留 Activation/inbox，turn 级 interrupted 归一为 stopReason `'aborted'`（lifecycle.js:79-105）。
4. 契约内同会话换档唯一机制是 `Agent.model.select`（durable model/selection）+ sendMessage，但存在自然结算竞态且不暴露新 result Promise。
5. **采用方案（lead 批准的等效平台强制方案，亦即 expert 推荐的最稳等价实现）**：登记后 `interruptByParent(continuable)` 中断 phase-0 回合 + **新 startActivation 以 agentOptions.reasoningEffort=自配值**接续，prompt 携带 phase-0 产物+完整任务书+「继续勿重做」，台账 childId 更新、结算回调重绑——phase-1 第一步即保证自配档，插件续持 result Promise。

## 实现清单（平台强制，不靠提示词自觉）

**负责人（第二层，runSubtaskAttempt 单所有者）：**
- `src/runtime.ts:2064-2075`：未登记 effortOverride ⇒ `phaseZeroActivation`，激活档强制 `'low'`；已登记（含重试/续跑/回放读回）⇒ `resolveTaskEffort` 单一判据用自配档。
- `src/plan.ts:1824-1833` `buildPhaseZeroLeaderPrompt`：phase-0 任务书唯一职责=评估复杂度+经 review 提交 `consolidation.taskReasoningEffort`，不执行任务不派发。
- `src/runtime.ts:2425-2445`：phase-0 结果分支——已登记 ⇒ 置 phaseZeroCompleted、携带 phase-0 输出 `continue` 接续 phase-1（`attempt -= 1` 不耗重试预算）；未登记 ⇒ 显式 `SELF_EFFORT_MISSING` 有界回喂，**禁止静默以 low 档继续正式任务**。
- `src/plan.ts:1835-1838` `buildPhaseZeroContinuationHint` + buildChildPrompt 新参 `phaseZeroContinuation`：phase-1 任务书=完整任务书+接续块（自配档+phase-0 输出+继续勿重做）。
- `src/runtime.ts:7413-7420`：review 登记成功即 `interruptByParent(childSession.id, parentId, 'continuable')`（尽力而为；不可用时 phase-0 自然结束，平台接续仍成立）。

**叶子（第三层，delegateTool 单所有者）：**
- `src/runtime.ts:7136-7288` 新增 `selfEffortTool`（`delegate` 新 action=`self_effort`，路由 :7290 先于负责人校验）：仅台账登记的叶子可调（`SELF_EFFORT_NOT_LEAF`）；五档白名单非法拒 `SELF_EFFORT_INVALID`；`complexityRationale` 必填（`SELF_EFFORT_RATIONALE_MISSING`）；家族钳制留痕（console.warn + selfEffortRequested）；登记 `delegates[].selfEffort/complexityRationale` + 行级 `delegateSelfEfforts` 并 durable 落盘；随后 interruptByParent + 新激活以自配档接续（prompt=完整 buildDelegateePrompt+phase-0 产物+继续勿重做），childId 台账更新、结算回调按新 childId 重绑（旧回调按旧 childId 自动失配）；**接续失败重试 1 次仍败 ⇒ `SELF_EFFORT_CONTINUATION_FAILED` 显式报错、成员记 failed、自配档保留，禁止静默降档**。
- `src/runtime.ts:7508-7531` dispatch：未自配 ⇒ phase-0 强制 low（`buildPhaseZeroDelegateePrompt`，llm-rules.ts:429-445，唯一职责=self_effort，可携带重试简报）；已自配（含重置保留的 delegateSelfEfforts）⇒ 直接以自配档 phase-1 接续（自配档接续块+重试简报）。分工表 effort 仅留台账作建议对照。

**持久化（G1 教训：写入+消费双侧接线）：**
- `src/plan.ts` applyStatus：delegates 消毒新增 selfEffort（五档白名单）/selfEffortRequested/complexityRationale；新行级字段 `delegateSelfEfforts`（member→档，白名单消毒，非法抛 `INVALID_DELEGATE_SELF_EFFORTS`）；**pending 重置保留**（从 delegates 收集 selfEffort 入台账，显式 patch 优先）。
- 写入侧 `src/plan.ts:3508` buildUpdateMessage 携带 delegateSelfEfforts（delegates 整体已携带 selfEffort）；消费侧 `src/runtime.ts:4470` 回放 patch 接 delegateSelfEfforts（delegates/effortOverride/consolidation 经 G1 修复已接）。normaliseStatusEntry ...source 透传。
- 重试/续跑单一判据：负责人 resolveTaskEffort（effortOverride）；叶子 dispatch 读 delegateSelfEfforts/prior.selfEffort——自配档 govern 本人后续全部激活。

**文案/看板/文档（继承主规则全部改写为自配义务）：**
- llm-rules.ts buildLlmRulesBrief（部门/叶子两层）、buildDelegateePrompt 执行要求、plan.ts 负责人授权段、host.ts 工具描述与 taskReasoningEffort/reasoningEffort 字段描述、runtime.ts review hint：均改为「自配为权威、分工表档仅建议、phase-0 low+登记后接续」。
- `src/client.ts` 看板每位下级新增「自配档 X（钳制自 Y）/待自配」显示（数据源 delegates.selfEffort）。
- `docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md`（工具 12 行）与 `docs/cc/AVA-VULNERABILITY-ANALYSIS.md`（AS-13）同步自配口径+新拒因码。
- 规划器提示词 1547 行**未动**（member 盘点警示：与 tests/reasoning-effort.test.ts:188-189 正则逐字耦合）。

## 测试（冻结时全绿）

- 新增 `tests/workplan-250-self-effort.test.ts` **9 例**：叶子 phase-0 low+自配义务文案；self_effort e2e（qwen max→xhigh 钳制留痕、接续档=自配、phase-0 产物+继续勿重做+完整任务书携带、interruptByParent continuable、childId 更新、durable 携带、结算落档）；非法/缺依据/非叶子拒绝；接续失败恰好重试 1 次显式报错+自配档保留；重置保留 delegateSelfEfforts+重派已自配直连 phase-1/未自配仍 phase-0；回放消费端恢复 selfEffort/delegateSelfEfforts；负责人 phase-0→review→phase-1 自配档接续（携带 phase-0 输出、不耗重试预算、正常结算 done）；已登记 effortOverride 首发即 phase-1（重试/续跑同判据）；旧计划零迁移。
- 旧契约断言按新口径更新（6 文件）：delegate-tool（专家首发改 low）、workplan-250-head-delegation（叶子首发 low+self_effort 义务）、workplan-250-delegate-retry（叶子 phase-0 low）、effort-rules A3b 与 interrupted-artifacts、reasoning-effort（harness 预登记自配档=规划档，保留原考察意图：家族静态闸/中断产物/子会话档位不继承主 Agent）。
- **定向终跑：10 文件 88 例 pass 88 / fail 0 / cancelled 0**；`npm run check` 通过；`tsc -p tsconfig.test.json` 编译通过。全量数字由发布部填入。
- 过程红项均已即时诊断修复（测试夹具 contradictions.primary 缺失、mock resolver 取错对象、旧 harness 未预登记自配档、phase-0 文案缺「推理等级」字样），无源码逻辑带红冻结。

## 纪律与交接

- 子代理：expert（xhigh）契约核验 2 轮投递完整返回（结论已并入本节）；member（medium）文案/测试盘点返回并消费（含 1547 行耦合避坑）。重试均携带既有产物，未整步重跑。
- 写范围合规：src/**、tests/**、docs/cc 两文件（lead 裁决追加）、本报告；未动版本号/package/README/CHANGELOG/lib/client.js/tool-surface fixture。
- 20:15 已向 lead 与 dept-release 发「已冻结」；发布部接棒 CHANGELOG→build→全量。
- 遗留观察（不阻断）：phase-0 旧会话中断后自然结算（stopReason aborted），其旧结算回调按旧 childId 失配无副作用；model.select 同会话换档路径未采用（竞态+无 result Promise），如后续宿主演进可再评估。
---

# 追加：全量回归测试适配（lead 裁决 (a)：仅解冻 tests/，src 门禁零改动）

## 背景与裁决

自配档机制上线后全量回归 26 红（768 pass/26 fail/0 cancelled，日志 /tmp/wp-full-run1.log）：根因统一为「phase-0 门禁拦截既有『直接执行正式任务』的测试模拟」——属新契约预期行为，非 src 缺陷。lead 裁决：选 (a) 适配测试，禁选 (b) 收窄门禁；不得删除/跳过/弱化任何断言意图；冻结前置条件升级为 npm test 全量 0 失败 0 取消。

## 共享 helper（tests/helpers/self-effort-contract.ts）

- `selfEffortStatuses(plan)`：createStatuses + 各行 effortOverride 预登记为规划档（缺失回落 low），模拟负责人「已自配」直接进入 phase-1。
- `seedLeaderSelfEffort(session, plan, effort='low')`：会话存档路径——plan 消息后追加 durable workplan-update 预登记自配档（回放消费端已接线，G1 教训）。
- `withSelfEfforts(record)` / `withLeafSelfEfforts(record)` / `withAllSelfEfforts(record)`：record/叶子台账（delegates[].selfEffort + delegateSelfEfforts）预登记。

## 适配清单（16 文件，断言意图零删改）

- record harness 预登记（selfEffortStatuses）：interrupt-announce、notice-channel（applyStatus 用例）、plan（DAG 派发）、planner-effort-clamp×2、workplan-auto-retry、workplan-budget-pause（makeRecord）、workplan-monotonicity×3、workplan-stuck-recovery。
- 会话存档预登记（seedLeaderSelfEffort）：time-notice-immediate×2、workplan-dispatch-modes×2、workplan-status-lock、workplan-comm-format-e2e、workplan-evidence-missing-retry、workplan-unparsable-retry、qa-time-mechanism-scenarios-t3、notice-channel（运行时集成）、workplan-budget-pause（raw plan 消息×3 + wrap(older/newer)×4）、workplan-monotonicity（仅 G5-X1 真实派发会话 x1Plan）。
- 唯一过滤器适配：time-notice-immediate `noticeTexts` 增加 `parseUpdateMessage` 排除——durable 改判记录（含预登记 workplan-update）不是即时通知；与 2.3.10「结果消息计数排除预告通知」同一 precedent，通知幂等/措辞断言本身零改动。
- 撤回过度 seed：workplan-monotonicity 的 plan/planB/plan2 会话不派发（G4-P2 等纯改判/回放用例），seed 的 revision 2 会与其自有 revision 交互 ⇒ 仅保留真实派发用例 x1Plan 的 seed。

## 过程红项诊断留痕（逐轮收敛）

| 轮次 | 结果 | 日志 | 诊断与修复 |
|---|---|---|---|
| run1 | 768/26/0 | /tmp/wp-full-run1.log | 26 红全为 phase-0 门禁拦截直接执行模拟 ⇒ 共享 helper + 15 文件适配 |
| run2 | 787/7/0 | /tmp/wp-full-run2.log | budget-pause raw plan 简写变体锚点漏配；time-notice 宽过滤器把 seed 改判消息计入通知；notice-channel 运行时集成会话未 seed；monotonicity G4-P2 被过度 seed 的 revision 干扰 |
| run3 | 792/2/0 | /tmp/wp-full-run3.log | budget-pause wrap(older) 两个重启用例未 seed（含先派发 newer 的用例） |
| run4 | 793/1/0 | /tmp/wp-full-run4.log | 「内存里是另一份计划」用例先派发 newer 计划，newer 也需 seed |
| run5 | **794/0/0 exit=0** | /tmp/wp-full-run5.log | 全量绿（npm test 全链路：build+tsc+run-tests，cancelled===0 硬断言通过） |

期间一次脚本锚点失败（notice-channel makePlanMessage 4 处同形）与一次 TS2304（budget-pause 缺 seedLeaderSelfEffort import）均即时诊断修正，未带错运行。

## 冻结声明

20:42 前达成全量绿；src/ 门禁零改动、版本号/package/README/CHANGELOG/lib 零改动；tests/ 与 docs/cc 自冻结消息起停止编辑。冻结消息已同时发 lead 与 dept-release（附汇总行与日志路径）。
