# 2.5.0 机制核验证据报告（R1–R5）

- 核验部门：机制核验部（dept-mechanism），Team Lead：lead
- 日期：2026-11-11（19:06 开工，19:27 交付；G1 经 lead 裁决批准解冻修复）
- 对象：`plugins/dsh-workplan` 工作树（git HEAD=b358783 / 2.3.9，含未提交的 2.5.1/2.5.0/2.3.10 机制改动）
- 方式：只读源码核验 + 根因修复 + 定向回归。**全程未启用/安装/重启任何插件或服务，未调用任何 dsh_workplan_* 工具。**
- 行号口径：均为**修复后工作树**的当前行号（runtime.ts 因新增两个纯函数与 G1 回放补丁，2837 行之后整体下移）。
- 子代理派单（先由部门负责人通读关键源码后派单，均 provider=qw / model=qwen4-max-preview）：
  1. expert·R4 二层+R2 持久链深度核验（reasoning_effort=xhigh）——已返回：二层回喂链/激活唯一入口 pass，**发现 G1 主链缺口**（负责人直读复核确认）；
  2. expert·R5 耗时预告核验（reasoning_effort=medium）——已返回，5 项全 pass，关键行号经部门负责人抽查复核；
  3. member·测试覆盖盘点与定向运行方法（reasoning_effort=low）——已返回，确认「第三层叶子重派携带已完成产物」此前零覆盖。
  部门负责人对全部关键结论亲自抽查源码行号复核，未照单全收。

## 总结论

| 项 | 结论 | 说明 |
|---|---|---|
| R1 部门负责人再分配权限 | **pass** | 硬门禁/角色混合/层级边界/无矛盾禁令全部在代码层生效 |
| R2 整体推理等级全程贯穿 | **fixed**（3 处缺口全部根因修复：继承回落×1 + durable 回放消费端 G1×1，另主链核验 pass） | 含刷新/重启回放恢复，回归锁定 |
| R3 分解更简单 | **pass** | 规划器硬规则 + delegate 分工约束齐全 |
| R4 重试不丢已完成部分 | **fixed**（二层 pass + 第三层缺口已根因修复） | 叶子重派提示词原不携带任何已完成部分 |
| R5 分配前耗时预告 | **pass** | 纯函数/时序/幂等守卫/提示词硬规则/测试齐全 |

---

## R1 部门负责人再分配权限 —— pass

1. **dispatch 硬门禁（review 未提交即拒）**：`src/runtime.ts:7221-7229` dispatch 从状态行读回 consolidation 交 `planDelegations` 唯一判据；未登记 ⇒ `src/llm-rules.ts:258-263` 返回 `DELEGATE_CONSOLIDATION_MISSING`（梳理不完整另有 `DELEGATE_CONSOLIDATION_INCOMPLETE`）。提示词绕不过服务端判定。
2. **角色混合 expert≥1 且 member≥1**：`src/llm-rules.ts:345-355` `experts===0 || regular===0` ⇒ `DELEGATE_ROLE_MIX_REQUIRED`；人数上限 `MAX_DELEGATE_MEMBERS=6`（llm-rules.ts:231，assignments slice(0,6)）。
3. **工具只对计划内部门负责人子会话可用**：`src/runtime.ts:7084` 根会话 `NOT_LEADER_SESSION`；`:7102` 叶子层（父会话无计划）`NO_PLAN`；`:7110` childId 未登记 `NO_SUBTASK`；另有 `ALREADY_DONE` 与 `DELEGATE_ALREADY_RUNNING` 防重复派发。成员 spawn `maxDepth:2`，第四层由宿主绝对深度上限硬拒。
4. **无矛盾禁令**：`src/plan.ts:5377-5378` 禁令精确限定为「除 dsh_workplan_delegate 外不得派生其它 Agent / 无主计划派发权限、不能重启或安装」；`plan.ts:5388-5392` 为负责人授权段（再分配权限+整体等级配置+更简单分工）。`src/llm-rules.ts:173` buildLlmRulesBrief 部门层文案同为授权口径；全 src grep「没有派发权限/不要派生」仅命中 plan.ts:5373 的修复注释与 llm-rules.ts:403 的**第四层**叶子禁令（合法保留）。规划器侧 `plan.ts:1520` 同口径。
5. 定向测试：`tests/delegate-tool.test.ts` 13 例全过（含 NOT_LEADER_SESSION/NO_PLAN/NO_SUBTASK/硬门禁/角色混合/钳制留痕/durable 消息）。

## R2 整体推理等级全程贯穿 —— fixed（主链 pass + 3 处缺口已修）

**主链（原有实现，核验 pass）：**
1. 五档白名单：`src/llm-rules.ts:282-292` 非法 `taskReasoningEffort` ⇒ `DELEGATE_TASK_EFFORT_INVALID` 明确拒绝；家族钳制留痕 `:294-299`（taskEffortClamped）。
2. 状态行消毒：`src/plan.ts:4043-4050` applyStatus 只收五档或 null，非法抛 `INVALID_EFFORT_OVERRIDE`；durable 写入侧 `src/plan.ts:3491`（buildUpdateMessage 透传）+ `src/runtime.ts:7138`（persist 随 workplan-update 写盘）；**重置不清除**：`src/plan.ts:4179-4183` pending 分支明确保留 effortOverride（任务级配置非尝试痕迹）。
3. 每次激活单一判据：`src/runtime.ts:2057-2061` runSubtaskAttempt 内（首发/重试/续跑共用同一激活函数）经 `resolveTaskEffort`（`src/llm-rules.ts:380-384`）读档：override 优先于规划器档位，缺失回落默认；随后家族静态闸+宿主能力闸（runtime.ts:2069-2100）。expert 独立复核：startActivation 全 src 仅两个调用点（部门层 runtime.ts:2101 / 第三层 :7285），续跑三入口（:4979/:6102/:7601）全部汇入 dispatchPlan→runSubtaskAttempt，无旁路。
4. 下级继承：`src/llm-rules.ts:326-328` 未单独配档 ⇒ `taskEffort ?? 'low'`（整体未配置回落 low，不再无条件烧家族最高档）。

**缺口①（已修）：重置后重新 review 的继承链断裂。** 尝试重置清掉 consolidation（plan.ts:4177）但保留 effortOverride；负责人重新 review 若不再写 taskReasoningEffort，旧实现只看 consolidation ⇒ 下级静默回落 low。修复：`src/llm-rules.ts:250-257` planDelegations 新增 `taskEffortFallback`，`:277-284` 梳理未带整体等级时回落该源（显式配置优先、回落源同样过白名单+家族钳制）；`src/runtime.ts:7177`（review）与 `:7222`（dispatch）均传 `taskEffortFallback: row.effortOverride`。

**缺口② G1（expert 独立复核发现 + 负责人直读确认，lead 裁决批准后已修）：durable 回放消费端漏接。** 写入侧已接线——buildUpdateMessage 携带 consolidation/delegates/effortOverride（`src/plan.ts:3487-3491`，注释明言「必须随 durable 回放」），parseUpdateMessage 全量返回 payload（plan.ts:3508-3518）；但 `reconstructFromSession` 的 workplan-update 回放 patch（修复前 `src/runtime.ts:4389-4421`）与直写白名单（`:4458`，仅 deadlineAt/timeNotice 等 8 字段）均不含三字段 ⇒ 刷新/重启后 effortOverride 丢失（resolveTaskEffort 回落规划器档位）、梳理登记与第三层台账同丢。既有测试只测 buildUpdateMessage→parseUpdateMessage→applyStatus 直连，未覆盖 reconstructFromSession 消费端，故未暴露（与 2.2.6 D-1 handoffs 漏回放同族根因）。
**修复（lead 批准的最小治本补丁）：** `src/runtime.ts:4420-4430` 回放 patch 追加三字段透传 `effortOverride: update.effortOverride / consolidation: update.consolidation / delegates: update.delegates`——applyStatus 对三者均有路由分支（plan.ts:3981/4021/4043），undefined 保留旧值，旧日志零迁移、与 live 侧同口径。回归：`tests/workplan-250-delegate-retry.test.ts` 用例 8 经真实消费端 `reconstructFromSession(session)` 断言三字段全部恢复（含 consolidation.taskReasoningEffort 与 delegates 台账）。

## R3 分解更简单 —— pass

1. 规划器硬规则：`src/plan.ts:1516-1519` 「每个子任务只写单一目标、单一主产物、可独立验收的一件事；不要把多个交付物压进同一个子任务」，执行细节下沉部门内分工；`:1520` 负责人牵头+部门内再分配。
2. delegate 分工约束：`src/host.ts:804-812` 工具描述「每位下级只承担单一目标、单一主产物、可独立验收的一项工作」「至少 1 名 expert + 1 名 member，最多 6 人」；`src/plan.ts:5389-5390` 负责人任务书同口径；`src/llm-rules.ts:173` 注入文案同口径；人数上限代码强制（llm-rules.ts:231，plan.ts:4022-4023 delegates slice(0,6)）。
3. 定向测试：workplan-250-head-delegation「要求1/3」用例断言规划器/任务书文案；delegate-tool 角色混合/上限用例全过。

## R4 重试不丢已完成部分 —— fixed（二层 pass，第三层缺口已修）

**第二层（部门负责人子会话，原有实现核验 pass + expert 独立复核 pass）：**
1. `mergePreservedArtifacts`（`src/runtime.ts:2824-2837`）：保护清单与行 artifacts 取并集、只增不减；保护条目追加在尾部且 landedRefs≤20，单次调用 `slice(-40)` 容量上限不挤掉保护条目（超量边界见 G2 留档）。调用点：二次超时接手 `runtime.ts:3074-3075`、保护行改判 `:5529`。
2. `buildTakeoverBrief`（`runtime.ts:2793-2816`）：已完成产物快照+remainingOutputs+硬约束文案「只读、禁止丢弃、禁止删除或覆盖、禁止整步重跑」。
3. 结果块补报回喂：`runtime.ts:2460-2476` EVIDENCE_UNPARSABLE 与 `:2491-2529` EVIDENCE_MISSING 均附「已核到在盘产物：…——**请勿重做已完成的工作**」（:2465/:2522），盘上结算备份优先采纳（:2493-2514）；一般失败重试携带 lastFailure（:2555-2559）经 shouldRetryAttempt 闸门回喂同一子会话（下一次激活 previousFailure 传入 buildChildPrompt）；resumeHint 读状态行在盘 artifacts 输出「先核对，不要重写…只补缺失部分」（plan.ts:5279-5286）。
4. 定向测试：interrupted-artifacts 5 例、expert-time-mechanism-2-3-0 4 例全过。expert 另发现 G2/G3/G4 既有边角（见「遗留与交接」留档，非本轮新机制缺口，lead 批准本轮不动）。

**第三层缺口（本次核验重点，已确认并根因修复）：** delegate 派出的叶子失败后，负责人再次 dispatch 时旧实现给叶子一张**全新任务书**——`buildDelegateePrompt` 的 `extraContext` 参数从未被传入，上次尝试的状态/失败原因/已回报结论/在盘产物全部丢失，叶子只能整步重跑；与第二层「禁止丢弃已完成部分」语义断裂。member 子代理全 tests/ 盘点确认此点此前零测试覆盖；expert 在最终快照中确认修复生效。
**修复（治本：把第二层的「接手简报」语义落到第三层重派链路）：**
- `src/runtime.ts:2846-2861` 新增 `probeDelegateLandedArtifacts`：重派前核盘叶子按任务书约定写下的结算备份 `reports/wp-member-<成员名>-*.json`（只读、读失败返回空、绝不编造；listDir 可注入便于回归）。
- `src/runtime.ts:2872-2902` 新增纯函数 `buildDelegateRetryBrief`：上次状态/失败原因/已回报摘要 + 在盘产物清单 + 负责人梳理思路 + 硬约束「请勿重做已完成的工作…禁止删除或覆盖既有产物、禁止整步重跑」（done 成员续跑则为「只补缺口」）；首发返回空串。
- `src/runtime.ts:7255-7279` delegateTool dispatch：从上一次台账按成员名取 prior，经 `buildDelegateePrompt.extraContext` 注入重试简报；首发链路零变化。
- R2 交叉：effortOverride 在重试/续跑不丢——二层见 R2 主链 3（每次激活读档）+ G1 修复（重启回放恢复），三层见缺口①修复（taskEffortFallback）；端到端用例断言重派叶子 agentOptions.reasoningEffort 沿用整体等级。
- 回归：`tests/workplan-250-delegate-retry.test.ts` 用例 1-5（探测纯逻辑 2 例 + 简报纯函数 2 例 + 真实临时目录端到端 1 例：首发无简报→叶子 failed/done→重派任务书含失败原因/在盘产物/勿重做约束/梳理上下文/叶子禁令）。

## R5 分配前会话内耗时预告（2.3.10）—— pass

1. 纯函数（部门负责人直读复核）：`src/plan.ts:1798-1802` planningEstimateMinutes = max(1, ceil(窗口/60000/2))，非法输入回落 300000ms（默认 300s→3 分钟）；`:1804-1811` 【规划预告】含窗口/重试口径与「预估仅供参考，非承诺」；`:1813-1818` 【派发预告】复用 estimatePlanMinutes 下界估算，空计划返回 ''。
2. P1 时序（直读复核）：`src/runtime.ts:8924-8927` maybePlan 在 `runPlanner`（:8943）**之前**经唯一合规写入器 appendUserMessage 发【规划预告】，窗口与 runPlanner 同源（同一 normalisePlannerWindow 表达式）。
3. P2 时序与幂等（expert 核验+行号抽查）：`src/runtime.ts:7466-7468` dispatchTool 在全部拒绝闸门之后、模式分支与 dispatchPlan 之前，`record.preAnnouncedPlanId !== record.plan.planId` 守卫——同 planId 只预告一次，重规划新 planId 自然重预告；续跑直调 dispatchPlan 不经过该文案、不刷屏。
4. 提示词硬规则（直读复核）：`src/host.ts:93` PROMPT_SECTION「调用 dsh_workplan_dispatch 前，必须先在会话中告知用户本次分配的预估耗时（含明确数值与单位分钟，标注『仅供参考，非承诺』）……不得省略、不得吞掉」。
5. 测试：`tests/preannounce-2-3-10.test.ts` 6 例定向全过（数值口径/文案措辞/触发点顺序/幂等锚点/提示词位置）。
6. 非阻断观察（不修，留档）：preAnnouncedPlanId 仅挂在内存 record 上，进程重启重建后同一 planId 可能再预告一次——属 informational 文案，重启后重新告知不构成刷屏缺陷；是否持久化由后续版本裁量。

## 修复清单（本轮全部改动，最小化、治本；G1 为 lead 裁决批准的解冻范围）

| # | 文件 | 改动 | 对应缺口 |
|---|---|---|---|
| 1 | src/runtime.ts:16 | fs import 增加 readdirSync | 修复 2 的依赖 |
| 2 | src/runtime.ts:2846-2902 | 新增 probeDelegateLandedArtifacts + buildDelegateRetryBrief 两个导出纯函数 | R4 第三层 |
| 3 | src/runtime.ts:7255-7279 | dispatch 重派按成员注入重试简报（extraContext） | R4 第三层 |
| 4 | src/llm-rules.ts:250-257,277-284 | planDelegations 新增 taskEffortFallback 回落源 | R2 缺口① |
| 5 | src/runtime.ts:7177,7222 | review/dispatch 传 taskEffortFallback: row.effortOverride | R2 缺口① |
| 6 | src/runtime.ts:4420-4430 | reconstructFromSession 回放 patch 追加 effortOverride/consolidation/delegates 三字段透传 | R2 G1（lead 批准） |
| 7 | tests/workplan-250-delegate-retry.test.ts（新增） | 8 例回归（含 G1 消费端回放 1 例） | 修复 2-6 |

未动：任何版本号字符串、package.json、README、CHANGELOG、lib/、client.js、tests/fixtures/tool-surface.json（归发布部）。G1 修复后 src/tests 重新冻结。

## 验证结果

- `npm run check`（tsc -p tsconfig.json --noEmit）：**通过**（G1 修复后复跑通过）。
- `npx tsc -p tsconfig.test.json`：**编译通过**。
- 定向回归第一轮（G1 修复前，8 文件）：**68 例 pass 68 / fail 0 / cancelled 0**（60.1s）：workplan-250-delegate-retry 7、delegate-tool 13、workplan-250-head-delegation 8、preannounce-2-3-10 6、effort-rules 11、effort-rules-llm-family 14、interrupted-artifacts 5、expert-time-mechanism-2-3-0 4。
- 定向回归第二轮（G1 修复后，仅新测试文件）：**8 例 pass 8 / fail 0 / cancelled 0**（含 G1 消费端回放新用例；期间一次测试夹具缺 contradictions.primary 的红已即时诊断修正，非源码缺陷）。
- 全量回归数字：**由发布部全量回归填入**（本报告不跑全量，避免重复劳动）。注意：发布部已在并行把版本号统一为 2.5.0（npm 输出可见 dsh-workplan@2.5.0），workplan-250-head-delegation 的版本断言（期望 2.5.1）与 tool-surface fixture 由发布部同批更新。

## 遗留与交接

- **G1 已修复并回归锁定**（lead 裁决批准，范围严格限定回放 patch 三行 + 1 例测试）；已通知 lead 与 dept-release 可重跑全量。
- **G2–G5（expert 发现的既有行为边角，均非本轮 2.5.0 新机制缺口，lead 批准本轮不动代码，留档供后续版本裁量）：**
  - G2：mergePreservedArtifacts `slice(-40)`（runtime.ts:2836）并集>40 时淘汰最旧条目；buildTakeoverBrief 两处 `slice(0,20)`（2797/2801）截断保护集——严格「只增不减」仅在总量≤40 时成立（单次调用新保护项在尾部可幸存）。
  - G3：保护合并仅 3074-3075/5529 两个调用点；applyStatus 对 artifacts 整段替换（plan.ts:3896），人工改判重置 pending 且不携带 artifacts 时清空保护清单（plan.ts:4166）；自动续跑路径安全（resetBlockedStatuses 跳过 takeover 行，plan.ts:5083）。
  - G4：失败说明截断 600 字（plan.ts:5261），EVIDENCE_UNPARSABLE 前置解析器错误最多 600 字（runtime.ts:2463），超长错误可能把「在盘产物清单+勿重做」尾部挤出截断窗口。
  - G5：第三层探测仅覆盖 wp-member 结算备份 JSON、prior 按成员名匹配（改名丢简报）——主缺口已修复，此为残留边界。
- 生效条件不变：需 `npm run build` 后由用户手工重启 dsh web（本轮全程禁止启用/重启，未执行）。