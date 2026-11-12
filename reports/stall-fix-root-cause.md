# 「提交任务后长时间无反应」根因诊断与修复报告（stall-fix）

- 采集/修复时点：2026-11-12 11:15 (Asia/Shanghai)；仓库 /Users/open/Documents/Stocks/plugins/dsh-workplan。
- 执行方式（如实）：本计划 T1 部门子会话两次在提交 review 后被中断（aborted、无产物），主 Agent 会话工具面未暴露 dsh_workplan_* 无法续跑，经向用户说明后由主 Agent 直接接手定位与修复（直接执行而非派发）。
- 结论均绑定 file:line（修复后树）与运行态事件证据；行号已逐条复算。

## 一、现象（用户视角）

提交任务后长时间（十几分钟）只有心跳、没有结果，子任务悄悄失败、台账停在 0/5，用户无法区分「在跑」与「死机」。本会话两次规划各静默约 13 分钟；两个计划的 T1 负责人都在提交 review 后数十毫秒内被中断。

## 二、三条根因（按证据强度排序，均已修复）

### R1 · 负责人 phase-1 重新 review 触发无条件中断（最致命，直接造成子会话死亡/台账停摆）
- 机制：`review` 登记整体推理档后，旧代码只要 `preview.taskEffort` 非空就 `interruptByParent(childSession, parent, 'continuable')`。但「中断后接续」的逻辑只存在于 runSubtaskAttempt 的 **phase-0 结算分支**。负责人已在 phase-1 执行时再次 review（哪怕等级不变）→ 当前回合被中断 → **没有任何接续** → 子会话 aborted、产物丢失、台账 blocked。
- 运行态证据：计划 wp-e5ea8772 的 T1（childId 9a4b8f66）revision4 首次 review 登记 effortOverride=xhigh（11:11:15），revision7 再次 review（11:13:53.410）后 **15ms** 即 finishedAt=…233425 aborted——与机制完全吻合。上一计划 wp-895c4cbf 的 T1 同样死法。
- 修复：中断前快照 `hadEffortOverride`（src/runtime.ts:7497），仅当「本次 review 之前尚未登记整体档」（真正的 phase-0→登记 转变）才中断（src/runtime.ts:7529）。phase-1 重新 review 只更新梳理产物，绝不中断正在执行的回合。
- 回归：tests/workplan-252-stall-fix.test.ts R1 两例（首次登记仍中断；已登记后同档/换档/不带档三种 re-review 均零新增中断）。

### R2 · 规划器默认取家族最高推理档 → 单次规划 12-13 分钟（首屏长时间等待的主因）
- 机制：旧默认 `plannerFamilyDefault = highestEffortOf(...)`（qwen⇒xhigh、非 qwen⇒max）。规划器要在最高推理档生成整份大 JSON，实测单次 12-13 分钟；预告之后长时间只有心跳没有结果，用户体验即「死机」。
- 修复：默认改家族**中等档**（qwen⇒medium、非 qwen⇒high，src/runtime.ts:855）；中等档不在合法集时回落最高档（白名单语义不变）；`DSH_WORKPLAN_PLANNER_REASONING_EFFORT` 显式覆盖保留。规划是结构化分解（中等复杂度），中等档足以保证质量并显著缩短首屏等待。
- 回归：R2 源码锚定用例；真实规划耗时需主 Agent 重启后实测（子任务不重启）。

### R3 · 派发执行轮次期间零会话输出（等待期无进度，无法区分在跑/卡死）
- 机制：2.5.2 的规划心跳只覆盖 runPlanner；`dispatchPlan` 的执行轮次（可能十几分钟）期间不产生任何会话通知，只有收尾才写结果。
- 修复：执行期进度心跳——复用 createPlanningHeartbeat 工厂（新增 buildMessage 注入），dispatchPlan 开始即 start（src/runtime.ts:3590）、finally 必 stop（src/runtime.ts:3863），默认 45s、`DSH_WORKPLAN_DISPATCH_HEARTBEAT_MS` 可调（≥5000ms），经唯一合规写入器 appendUserMessage 发「已用时+完成进度+不是卡死」（文案纯函数 buildDispatchHeartbeat，src/plan.ts:1797）。不新增事件类型、不触碰 system/message，maxNotices 保险丝防失控。
- 回归：R3 文案/假时钟周期/stop 收束/保险丝/中止静默 + dispatchPlan 接线源码锚定。

## 三、候选根因裁决（T1 列出的 H1-H5）

- H1 wait 阻塞无中间反馈 → **证实**（R3 已修）。
- H2 子会话中断未接续/台账停摆 → **证实**（R1 已修，运行态两次复现）。
- H3 主 Agent 工具面缺失 → **部分证实、属宿主侧**：子会话能调 dsh_workplan_delegate，主会话工具面未暴露 dsh_workplan_*，导致无法续跑/改判。此为宿主工具暴露/会话恢复问题，**不在本插件源码可修范围**，需主 Agent 重启 dsh web 后复核（单列交接）。
- H4 自动提醒只拦收尾不触发恢复 → 属实但为设计（提醒是门禁不是恢复器）；R1/R3 修复后失败会即时可见，僵局不再静默。
- H5 规划前置静默 → 2.5.2 规划心跳已覆盖，R2 进一步缩短规划本身耗时。

## 四、需主 Agent 执行的生效步骤（子任务不越权）

1. `npm run build` 重建 lib（本次已随全量回归构建）。
2. **用户手工重启 dsh web**（运行中进程不热加载；当前运行态仍是旧代码，故 T1 仍在复现 R1）。
3. 重启后真实提交一个任务复现验证：提交即有预告、规划耗时显著下降、执行期有【派发执行中】心跳、负责人 re-review 不再中断子会话。
4. 复核主会话工具面是否恢复 dsh_workplan_*（H3）；若仍缺失，属宿主侧问题另行处理。
5. 旧台账 wp-895c4cbf / wp-e5ea8772 的收尾由用户决定（取消或重启后续跑）。

## 五、验证口径

全量回归以 runner 实测为准（见 CHANGELOG 与本轮 npm test 输出）；tsc 零错误。未通过真实链路（重启后真派发）验证前，不声称缺陷已在运行态消除。