# T1 四角色「先两轮思考后执行」门禁差距诊断报告

- 采集时点：2026-11-12 10:25 (Asia/Shanghai)；基线：HEAD=9e05e21（2.5.2），工作树干净（审计起点）。
- 执行方式说明（如实）：T1 部门子会话在提交分工后被中断（aborted，无在盘产物），主 Agent 会话未暴露 dsh_workplan_* 工具、无法续跑派发，经向用户如实说明后由主 Agent 直接接手 T1-T5（直接执行而非派发）。本报告为接手后的代码实证结论。
- 权威源码：/Users/open/Documents/Stocks/plugins/dsh-workplan（web profile 的 node_modules/dsh-workplan 是指向该目录的软链接，同一份代码）。

## 一、四角色 × 强制时机矩阵（审计时点 = 修复前现状）

| 角色 | 第一轮任务深研 | 第二轮方法流程步骤+依据 | 强制时机 | 证据（file:line，修复前树） |
|---|---|---|---|---|
| 主 Agent | problemAnalysis≥40字 | approach≥40字 + approachBasis≥20字 | **执行前硬门禁**（首次 dispatch 必交 deepThink，拒绝不启动任何子 Agent） | src/runtime.ts dispatchTool 门禁（现 7782 起）；src/three-phase.ts:419 validateMainDeepThink；持久化 runtime.ts 回放抬升（现 4388-4393）+ 记录返回 mainDeepThink |
| 部门负责人 | consolidation.problemAnalysis≥1条 | approach≥1条 + approachBasis≥1条 | **再分配前硬门禁**（review 未交齐 dispatch 硬拒 DELEGATE_CONSOLIDATION_INCOMPLETE） | src/llm-rules.ts:255 planDelegations（approachBasis 校验 :383）；runtime.ts review 登记/durable 回放 |
| 顶尖专家（叶子） | 仅任务书注入 + 结算时 phases.planning 校验 | 同左 | **缺口：无执行前硬门禁**——phase-0 只强制 self_effort（推理等级+复杂度依据），两轮思考产物在结算时才被 validatePhaseEvidence 检查，模型可以先执行后补思考 | runtime.ts selfEffortTool（修复前仅校验 reasoningEffort/complexityRationale）；phase-0 任务书 llm-rules.ts buildPhaseZeroDelegateePrompt（修复前无 deepThink 义务）；结算 three-phase.ts validatePhaseEvidence |
| 组员（叶子） | 与专家同源（同一 selfEffortTool/buildPhaseZeroDelegateePrompt/buildDelegateePrompt） | 同左 | **同缺口** | 同上 |

## 二、口径统一性

- 主 Agent 与负责人：字段 problemAnalysis/approach/approachBasis；主 Agent 有字数下限（40/40/20，MIN_PLANNING_* 常量），负责人 review 仅条数下限（各≥1条）——条数口径略宽于主 Agent，但字段结构与依据链接一致。
- 叶子（修复前）：无执行前字段要求；结算 phases.planning 与主 Agent 同一 validatePhaseEvidence 家族口径（40/40/20）。
- 结论：需把叶子执行前门禁补齐到与主 Agent 完全同一判据（validateMainDeepThink，40/40/20）。

## 三、续跑/重试/重启回放（修复前）

- 主 Agent：mainDeepThink 按 planId 记账，durable workplan-update（subtaskId=null）+ reconstruct 消毒抬升，续跑读档放行 ✔。
- 负责人：consolidation 经 applyStatus 消毒 + durable 回放，重置清除后须重新 review ✔（任务级 effortOverride 保留）。
- 叶子：selfEffort/delegateSelfEfforts 重置保留、重派读档直接 phase-1 ✔；但思考产物无台账——重派不检查思考 ✔/✘（缺口的一部分）。

## 四、基线盘点

- package.json version=2.5.2；git HEAD=9e05e21。
- 用例计数口径：锚定 grep `^\s*test(` ≈816（漏计缩进/换行定义与 helper 内定义）；非锚定 `test(` ≈856（含注释/字符串误计）；**权威口径=run-tests.mjs 实际运行的 node:test 注册数**，最近全量实测 828 pass/0 fail/0 cancelled（2.5.2 定版运行）。816 vs 828 差异即统计口径差异，非用例丢失。

## 五、差距清单与处置（最小修复）

1. **叶子执行前硬门禁（核心缺口）**：self_effort 升级为原子对（reasoningEffort+complexityRationale+deepThink），缺交/不合格硬拒 DEEP_THINK_MISSING/DEEP_THINK_INCOMPLETE，不登记不接续；齐全才接续 phase-1。→ 已实现（runtime.ts:7212 起）。
2. **叶子思考台账持久化**：delegates[].deepThink + delegateDeepThinks，applyStatus 消毒、重置保留、durable 回放双侧接线。→ 已实现（plan.ts applyStatus/buildUpdateMessage；runtime.ts 回放白名单）。
3. **旧叶子旁路封堵**：只有自配档没有思考产物的叶子重派路由回 phase-0 补齐（runtime.ts:7568 leafPhaseZero = !priorSelf || !stashedThink）；已登记思考的叶子读档直接 phase-1 并随任务书下发第二轮执行蓝图。→ 已实现。
4. **少走弯路（用户 2026-11-12 补充）**：四角色协议文案统一加入「以最高效率执行、确保完美完成」与「全程少走弯路：先查历史教训、先验证再动手、不重复试错」；历史教训自动注入机制（lessons.ts，既有）作为少走弯路的底层支撑。→ 已实现（three-phase.ts/llm-rules.ts/host.ts 同源）。
5. 无需改动项：主 Agent dispatch 门禁、负责人 review 门禁、结算 phases 契约、时间协商/supersede/lessons 等无关机制——保持原样。

## 六、只读声明

T1 审计本身不修改代码；上述 1-4 的修复属 T2 职责，由主 Agent 接手后在同一工作树实施，修复前后证据分别以 git HEAD 9e05e21 与本次变更区分。