# CHANGELOG 2.5.0 自配置机制补写段落 · 预起草 v2（草稿，冻结后落盘）

- 起草人：dept-release（lead 20:07 令预起草；20:14 裁决 hold 到 20:15 冻结硬门禁，无冻结消息等 lead 明确启动令，不得自行按在盘代码启动）
- 依据：lead 五要素 + 在盘代码实读预核实（host.ts:800-874、llm-rules.ts:158-176、runtime.ts:2055-2089/2418-2444/4470/7125-7169/7491-7493、plan.ts:3508/4051-4074/4220-4227、client.ts:1824、tests/workplan-250-self-effort.test.ts 9 例标题实读）。
- 状态：**草稿 v2，预核实已完成 8/8 项**；落盘前仍须对照 20:15 冻结代码做最终 diff 复核（防冻结前最后改动）。

## 一、拟替换 CHANGELOG.md:4 的整条 bullet（单行长行）

- **三层执行者推理等级自配置（用户要求 2，机制升级）**：由「负责人配置整体等级、下级未单独配档时继承」升级为**先配置后开工、各自自配全程自用、平台强制接续**。① 先配置后开工（平台强制）：部门负责人与第三层专家/组员会话在未登记自配档时一律以 low 启动 phase-0——唯一职责是评估自身任务复杂度并提交自配；负责人经 `delegate(action="review")` 的 `consolidation.taskReasoningEffort` 提交（即负责人自配整体档），专家/组员经新增 `delegate(action="self_effort")` 提交（`reasoningEffort`+`complexityRationale` 必填：缺依据拒绝 `SELF_EFFORT_RATIONALE_MISSING`、非法档拒绝 `SELF_EFFORT_INVALID`、非第三层叶子拒绝 `SELF_EFFORT_NOT_LEAF`、已结算拒绝 `ALREADY_DONE`）；phase-0 结束仍未登记自配 ⇒ 明确 `SELF_EFFORT_MISSING` 回喂（有界重试），禁止静默以 low 档继续正式任务。② 自配为权威：成员自配档为权威，分工表 per-member 档降为建议；下级不再继承负责人整体档，各层自配全程自用。③ 平台强制接续：宿主在子会话创建时解析推理等级、同会话换档不可行，故登记后平台立即 `interruptByParent(continuable)` 中断 phase-0 回合，新激活携带 phase-0 产物与完整任务书、以自配档接续同一任务进入 phase-1（继续勿重做；childId 台账同步更新，旧结算回调按旧 childId 自动失配）；接续不是重试——不消耗 attempt 预算；接续失败重试 1 次仍败则明确报 `SELF_EFFORT_CONTINUATION_FAILED`，禁止静默降档；每次激活（首发/重试/续跑/中断后新激活）经 `resolveTaskEffort` 单一判据读档，自配档优先于规划器档位；尝试重置后 `delegateSelfEfforts` 保留，重派直接以已自配档接续 phase-1（不再 phase-0）。④ 持久化与回放：负责人自配写入状态行 `effortOverride`，成员自配写入 `delegates[].selfEffort`（越界钳制留痕 `selfEffortRequested`）与 `delegateSelfEfforts` 回落源，均经 applyStatus 五档白名单消毒（非法 `delegateSelfEfforts` 拒绝 `INVALID_DELEGATE_SELF_EFFORTS`）+ durable workplan-update 回放（写入与消费双侧接线，G1 教训），刷新/重启不丢；越界档按模型家族合法集合钳制并留痕，非法整体档仍拒绝 `DELEGATE_TASK_EFFORT_INVALID`。旧「下级未单独配档时继承整体等级、整体也未配置则回落 low」的继承回落口径废止；无新字段的旧计划回放零迁移。

## 二、CHANGELOG.md:7 条件微调（最小改动，冻结后定）

- 原句「新增 tests/workplan-250-head-delegation.test.ts 回归；既有字段与校验原样，旧计划零迁移。」——「既有字段与校验原样」仍真（新增字段不改既有字段），拟仅追加新测试文件名：「…回归；要求2 自配置机制新增 `tests/workplan-250-self-effort.test.ts` 9 例回归；既有字段与校验原样，旧计划零迁移。」若冻结后测试数/文件名有变，以实测为准。
- CHANGELOG.md:3 授权段名称「本部门再分配权限与推理等级配置」：llm-rules.ts:173 现文仍为该口径 → 预期零改动（冻结后复核）。

## 三、预核实清单（8/8 完成，证据为在盘代码实读；冻结后 diff 复核）

1. ✅ 字段名：delegates[].selfEffort / selfEffortRequested（plan.ts:4051-4052）、delegateSelfEfforts（plan.ts:4066-4074）、effortOverride、complexityRationale（runtime.ts:7163/7195）。
2. ✅ 错误码全集：SELF_EFFORT_MISSING（runtime.ts:2441）/ NOT_LEAF（7143,7154）/ INVALID（7161）/ RATIONALE_MISSING（7164）/ CONTINUATION_FAILED（7248）+ ALREADY_DONE（7157）+ DELEGATE_TASK_EFFORT_INVALID + INVALID_DELEGATE_SELF_EFFORTS（plan.ts:4074）。
3. ✅ interruptByParent(continuable) 两处：叶子 selfEffortTool（runtime.ts:7201-7202）、负责人 review（7417-7418）；接续语义注释 7126-7134（新激活携带 phase-0 产物+完整任务书、childId 更新、旧回调失配、重试1次）；不耗 attempt 预算（2436）。
4. ✅ 「三层」口径：host.ts 全文 grep 自配/phase-0 仅命中 delegate 工具面——主 Agent（一层）无插件侧自配落点；标题沿用 lead「三层执行者」口径，正文按实际执行者（部门负责人+第三层专家/组员）描述，不虚写主 Agent 机制。
5. ✅ delegateSelfEfforts 持久化链：buildUpdateMessage 携带（plan.ts:3508）→ 回放消费端路由（runtime.ts:4470，G1 双侧接线）→ applyStatus 消毒（plan.ts:4066-4074）→ 尝试重置保留（4220-4227）→ dispatch 读 stash 直接 phase-1（runtime.ts:7491-7493）。
6. ✅ CHANGELOG:3 预期零改动；:7 条件微调见上。
7. ✅ 看板新渲染 client.ts:1824「自配档 X（钳制自 Y）/待自配」——按最小改动原则 bullet 内不带（看板细节属机制部文档面）。
8. ✅ 新增测试：tests/workplan-250-self-effort.test.ts 共 9 例（标题实读：phase-0 low 启动/e2e 接续/硬校验/接续失败/重置保留/回放双侧/负责人 phase-0→review→接续/重试续跑读档/旧计划零迁移）；另 6 个既有测试文件被机制部更新。预期全量 ≈ 785+9=794（以实测为准）。

## 四、其它文件处置（已裁决）

- README 三语：零改动（lead 裁决）。docs/cc：机制部同批同步（lead 裁决①，工作树已见其改动）。版本字面量：保持 2.5.0。
- 落盘顺序（收到冻结消息/lead 启动令后）：最终 diff 复核 → 改 CHANGELOG:4（+:7 条件微调）→ npm run build → npm test 全量 → 填证据报告 → git add -A && git commit（信息「fix(2.5.0): 三层执行者推理等级自配置——先配置后开工、平台强制全程自用、selfEffort持久化；全量N/0/0」）→ 回报 lead。