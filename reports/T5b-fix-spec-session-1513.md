# T5b 最小修复规格与交接文档（供 6059 实施；本会话不改代码）

依据：T3 根因（R1-R4、F1-F6）、T4 边界（B1-B11、C1-C4）。基线 src 行号以当前工作区为准。
新增实证：工具路径 dsh_workplan_dispatch 与自动派发**同样**毫秒级崩溃（T5b 首执，childId=null）⇒ 崩溃在共享 spawn 链，非 auto 入口独有。

## 0. 先诊断后修复（派发崩溃，根因未闭环 G2）
D-1 步骤①：executeSubtask catch（runtime.ts:2657-2675）把 `error.stack` 截断 1500 字写入 record.errors 与受阻行 error，重跑一次取堆栈。
D-1 步骤②：spawn 前（runtime.ts:2143 之前）fail-closed：`const liveParent = ctx.get('agents')?.get(options.agent?.id)`；options.agent 缺失或 liveParent!==options.agent 时抛 PlanError('PARENT_MISSING'/'PARENT_STALE', 含入口 auto/tool/resume 与 agent id)，绝不把 undefined 传进宿主 startActivation（宿主 dsh-subagent lib/index.js:3024 读 spec.parent.id 即现 TypeError）。
D-1 步骤③：用①堆栈闭环真因后再定补丁；若真因即 parent 缺失，②即为治本最小补丁。
边界：C3 三入口（auto 5145/tool 6286/resume 8096）同测；不改宿主代码。

## 1. F1 规划档位解耦（R1）
位置：runtime.ts:1002-1011 effectivePlannerEffort。现状已 default-medium；规格：保留家族中等档上限+env 覆盖（DSH_WORKPLAN_PLANNER_EFFORT），禁止回落主会话档。边界：B6 钳制链不动；C2 三消费点回归。开关：env 即开关；回退=恢复旧表达式（不建议）。

## 2. F2 骨架先显、细化异步（R2，主瓶颈治本）
位置：runPlanner（~1034-1191）+ buildPlanMessage（plan.ts:2122）。规格：第一段小 schema（阶段+子任务标题/部门/依赖，≤2K tok 输出）秒级返回即展示【任务分解·骨架】；第二段细化（method/acceptance/risks）异步补全，经 C1 同一写入器更新；细化失败保留骨架+降级标注，不整轮重跑。边界：B5 surface-head 纪律、B10 门禁（骨架不计 deliveryReady）、B4 裁决不变。开关：DSH_WORKPLAN_PLAN_SKELETON=1 灰度，默认 0 直至回归绿。

## 3. F3 重试降档/增量（R3）
位置：runPlanner 尝试循环（721 PLANNER_MAX_ATTEMPTS=3）。规格：attempt≥2 降一档（medium→low，经 B6 钳制）或仅重发缺失字段；禁止同档整轮重跑。边界：B6；SALVAGED 判定保留。开关：DSH_WORKPLAN_PLANNER_RETRY_DOWNGRADE=1。

## 4. F4 跨 turn 复用（R4）
位置：maybePlan 9232/9265-9272。规格：existing 计划 blocked 且新 taskText 与旧 anchor 相似度≥阈值（复用 understanding.ts normalizeForMatch）时复用旧计划续跑，不取消重规划；纯选项/确认类短答复并入 isVagueContinuation 白名单（先过 B1 澄清闸）。边界：B1/B3；不得把真实新需求误判为复用（阈值+变更原文落 changeRequest 兜底）。

## 5. F5 见 §0（崩溃 fail-closed+堆栈）。

## 6. F6 预告口径实测化
位置：buildPlanningPreAnnouncement / buildBudgetWarning（plan.ts:2094-2120）。规格：口径=最近 N 次规划 p50/p90（planner telemetry 已留痕 runtime.ts:1191-1192）×重试放大系数；保留「仅供参考，非承诺」。边界：B11 协商语义不变。

## 7. 不触碰声明与回退
不触碰：B3 重置语义、B4 裁决、B7 计时纪律、B8/B9 门禁与深度、B10 交付闸。回退：每 F 独立 env 开关+独立提交，任一回归红即单提交 revert。本会话未改码/未重启/未装依赖（分工约束）。
