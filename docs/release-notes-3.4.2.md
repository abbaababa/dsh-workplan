# dsh-workplan v3.4.2 — 全流程高质量交付与极致省 Token 治本版

本版聚焦两大核心目标：**极高任务交付质量** 与 **极低真实 Token 开销**，并针对实机跑测（`T7` / `T7R` / `T7D` 等全量诊断日志）及 DeepSeek Harness `0.2.3-alpha.2` 运行机制做了全方位底层改造。

## 一、极致省 Token 全链路改造（默认 `costProfile: 'balanced'`）

- **三档成本模式（`DSH_WORKPLAN_COST_PROFILE`：`balanced` | `ultra-lean` | `full`）**：默认 `balanced` 在不降低高难任务推理深度和严格验收门槛的前提下全面消除无效开销；`ultra-lean` 提供更紧凑的步数与预算上限；`full` 保留旧版完整三层流程。
- **跨会话 KV Prefix Cache 共享锚点**：`buildChildSystemAnchor` + `registerPlanSystemAnchor` 确保同一计划内并行子任务从 Node-0 系统提示词到 Static-First 用户首包严格一致，实测跨会话前缀命中率提升至 90%+。
- **`leader-direct` 单会话直通与工具面减负**：默认跳过冗余的 Leader Phase-0 二次建会话与 0 轮开工预告步，并从 Step 1 隐藏 `dsh_workplan_delegate` / `dsh_workplan_instruct`（工具文本体积减少 71%）。
- **静态聊天免心跳刷屏**：静默 45 秒聊天心跳消息防止主会话过早触发上下文压缩（侧栏进度面板仍实时更新）。
- **计费权重精准预算控制**：按 `input×1 + cacheRead×0.1 + cacheWrite×1.25 + output×5` 精确计算真实账单消耗（`computeWeightedTokens`），按子任务数量动态缩放预算，同时放宽原始累计 token 兜底上限（`balanced`: 600 万，`ultra-lean`: 200 万），既精准刹停高输出死循环，又绝不误杀 90%+ 高缓存命中的优质任务。
- **纯概念问答直通与明确小改快车道**：只读问答 0 子会话直答，简单明确任务直走快速通道。

## 二、高质量交付与防半途而废/防傻等治本修复

- **事后证据打捞（Post-Abort Salvage）**：若子会话或专家已写出合规 `WORKPLAN_EVIDENCE` 证据块但后续步骤被预算/调度中止，`executeSubtask` / `settleContinuation` / `delegateTool` 会自动从会话记录中打捞并直接结算（修复 `T7R` `d3d69363`）。
- **1 步预算优雅交卷宽限窗 + 全工具锁定**：触发预算上限前给予 1 步优雅交卷窗口（`budgetGraceToolGuardReason` 在宽限步锁定所有工具调用，若模型误调工具则 0ms 拦截后再给 1 步纯文本输出），避免 `T7D` 等在 `BUILD OK` 后 99% 完成瞬间被直接掐断。
- **专家报告顶层字段自动归位**：`adjudicateExpertReport` 自动将顶层 `execution` / `verification` 归位到 `phases`，消除结构合法但缺少外层包裹导致的误拒（`T7D` 专家 `866b2c37`）。
- **活负责人精确通知与 Phase-0 在途专家排空**：动态读取 `record.plan.subtasks` 中当前负责人 `childId`，彻底消灭「向已结束 Phase-0 旧会话发完成通知导致新负责人傻等」以及 Phase-0→Phase-1 交接竞态。
- **重规划（Replan）预登记与 `directMode` 耐久重放**：`replanPlan` 复用 `applyBalancedDirectPreRegistration` 并在完成后立即 `flushPendingWorkplanUpdates`，恢复重启时同步恢复 `directMode`，根治重规划任务被 `FIRST_STEP_MUST_BE_TIME_NOTICE` 卡住及面板状态延迟。
- **后台完成主动唤醒与防 `wait_agent` 死等**：新增 `workplan-wake` 收件箱唤醒机制（纳入 `PLAN_CONTINUATION_KINDS`）与 `waitAgentGuardReason` 守卫，拦截主 Agent 对后台派发盲目 `wait_agent` 15 分钟死等，子任务一完成立刻自动推进。
- **DSH 0.2.3-alpha.2 兼容与界面净化**：`runPlanner` 多轮修复携带完整 `model` source 防止 `replayState` 崩溃；隔离 `abortBudget` 与 `abortDispatch` 修复左侧任务进度卡片意外消失；清理确定性错误与 UI 堆栈噪音；强化反多余测试脚本与反大范围 `ls -R reports` 纪律。

## 安装与升级

```bash
dsh plugin --profile web add dsh-workplan@3.4.2
```

- tag: `v3.4.2`
- date: `2026-11-28`
- npm: https://www.npmjs.com/package/dsh-workplan/v/3.4.2
