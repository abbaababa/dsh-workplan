# T2 · dsh-workplan 现有分发机制代码结构报告（v2.3.9 改造基线）

- 部门：研究分析 ｜ 角色：代码考古专家 ｜ 日期：2026-11-10
- 基线：plugins/dsh-workplan，version 2.3.2，TypeScript，Node>=22 ｜ 性质：只读分析，零源码改动
- 行号以 src/*.ts 当前工作区内容为准；函数名为稳定锚点（文件并发变更时行号可能偏移）

## 1. 现有调用链（实测，含行号）

用户消息
- maybePlan(ctx, state, payload, downstream, options) — src/runtime.ts:8220-8479区
  - resolveModelSelection(ctx, payload) -> {provider, model, reasoningEffort} | null — src/runtime.ts:8187（调用点 8362）＝现有「用户LLM检测」唯一入口；优先级 payload.modelSelection -> payload.agent.options -> ctx.get('agentDefaultModel').currentSelection()
  - runPlanner(ctx, {taskText, modelSelection, budget, ...}) — src/runtime.ts:779（调用点 8435；modelSelection 于 8439 传入）
    - env 档位 DSH_WORKPLAN_PLANNER_REASONING_EFFORT — runtime.ts:805-806
    - requestedPlannerEffort = plannerEffort || 'max' — runtime.ts:807（DEFAULT_PLANNER_REASONING_EFFORT='max' @250）
    - resolveSupportedEfforts(llm, provider, model) — runtime.ts:309（查宿主 resolveModelInfo efforts 清单，带 Map 缓存）
    - clampEffortToSupported(effort, supported) — runtime.ts:284（EFFORT_STRENGTH_ORDER @281: off<minimal<low<medium<high<xhigh<max）
    - buildPlannerPrompt(taskText, cwd, conversationContext, budget) — src/plan.ts:1370（调用点 runtime.ts:915）；五档规则文本硬编码 @1443/1445/1446；JSON 模板含 reasoningEffort @1506
    - llm 调用携带 reasoningEffort: effectivePlannerEffort — runtime.ts:937
  - 计划校验 validatePlan/readSubtasks 档位白名单 — plan.ts:781-787；REASONING_EFFORTS=freeze(['low','medium','high','xhigh','max']) @211；DEFAULT_REASONING_EFFORT='high' @212；缺失回落 @831；非法值拒绝 @786
  - dsh_workplan_dispatch 工具注册 — src/host.ts:1228
    - 派发轮 -> executeSubtask(ctx, record, stage, subtask, options) — src/runtime.ts:1791
      - 教训注入 renderLessonsBrief — runtime.ts:1982-1992
      - requestedChildEffort = subtask.reasoningEffort || DEFAULT — runtime.ts:2002-2005
      - effortQueryable -> resolveSupportedEfforts(modelSelection) — runtime.ts:2011-2017
      - childEffort = clampEffortToSupported(...) — runtime.ts:2018-2020
      - buildChildPrompt(...) — plan.ts:4934（调用点 runtime.ts:2027）
      - ctx.subagents.startActivation({provider:'spawn', delivery:'caller', maxDepth:1, request:{agentOptions:{provider, model, reasoningEffort: childEffort}}}) — runtime.ts:2021-2093（agentOptions @2082-2088；maxDepth:1 @2089）

其它同步点：
- 客户端 UI Pill 白名单：src/client.ts:1737 附近（与 plan.ts:211 「唯二事实源」注释）
- 状态行档位留痕：src/host.ts:1183（planner.reasoningEffortSource）；telemetry runtime.ts:1111-1112
- 2.2.7 档位兼容钳制注释块（现有基线）：runtime.ts:252-279 ＝ 动态能力面钳制，非静态 qwen 前缀判定

## 2. qwen/非-qwen 等级校验缺失点（精确定位）

结论：全代码库不存在任何按模型 ID 前缀（qwen）判定等级集合的代码。
证据：grep -rn -i "qwen" src/*.ts 命中仅 5 处且全为注释（plan.ts:1079；runtime.ts:259/261/271/1998）；无 startsWith('qwen 代码形态。

- G1 检测缺失：无 detectModelFamily/allowedEffortsForModel；可挂钩模型事实源=resolveModelSelection（runtime.ts:8187）的 modelSelection.model
- G2 规划器规则不随模型变：buildPlannerPrompt（plan.ts:1370）硬编码五档（1443-1446），签名不接收 modelSelection——qwen 会话下规划器仍被要求写 high/max
- G3 校验不认模型：plan.ts:781-787 只按静态五档校验；qwen 计划的 high/max 被放行、派发期被钳制静默降级（U7 拍板=静态表权威+宿主档位交集钳制留痕）
- G4 部门告知缺失：buildChildPrompt（plan.ts:4934，出口数组 5092-5211）无要求1/2全文，不知本会话模型与等级集合；子任务档位亦未告知专家本人
- G5 负责人二次分配不存在：startActivation 固定 maxDepth:1（runtime.ts:2089）；workplan_delegate 在 src/tests/docs 检索 0 命中——三层派发为净新增
- G6 事实源同步：client.ts:1737 与 plan.ts:211 为唯二事实源；新增静态规则表后需三源收口

## 3. 修改点清单（供 T3/T4/T4b/T5/T6/T7 引用）

- M1 LLM检测｜src/runtime.ts｜resolveModelSelection(8187) 后新增 detectModelFamily(modelId)+allowedEffortsForModel（建议新建 src/llm-rules.ts）：qwen*->{low,medium,xhigh}，其余->{low,high,max}；映射：轻度=low；qwen 中等=medium、非常复杂=xhigh；非qwen 中等=high、非常复杂=max｜类型=新增
- M2 等级集合设定｜src/plan.ts｜buildPlannerPrompt(1370) 增参（等级集合），1443/1445/1446 改为按集合注入要求1/2原文；调用点 runtime.ts:915 传 modelSelection｜类型=改造
- M3 等级校验交集｜src/plan.ts｜validatePlan/readSubtasks(781-787,211-212) 按静态集合交集校验+留痕；runtime.ts:814-822(planner) 与 2002-2020(child) 钳制并入静态集合｜类型=改造
- M4 部门告知注入｜src/plan.ts｜buildChildPrompt(4934) return 数组（5092-5211，建议 5114 附近）注入要求1/2全文+本会话模型/等级集合+子任务档位依据；调用点 runtime.ts:2027 补传参｜类型=新增
- M5 负责人二次分配｜src/host.ts+src/runtime.ts+src/client.ts｜host.ts 注册区(1228附近)新增 workplan_delegate；executeSubtask(1791) 支持三层派发（现 maxDepth:1 @2089）；看板三层渲染｜类型=净新增
- M6 专家等级配置应用｜src/runtime.ts｜executeSubtask 内 childEffort(2002-2020) 除写 agentOptions(2087) 外同步写入子提示词（与 M4 同源），并过静态集合交集｜类型=改造
- M7 展示/版本同步｜src/client.ts+src/host.ts｜client.ts:1737 UI Pill 按集合过滤；host.ts:1183 状态行补模型/集合/钳制留痕；版本号四点同步 2.3.9｜类型=改造

## 4. 当前版本号与构建方式（实测）

- version=2.3.2：package.json:3（与 git tag v2.3.2、npm latest、CHANGELOG 四源一致，T1 已证）
- 构建：npm run build = rm -rf dist && tsc -p tsconfig.json && cp dist/*.js lib/ && cp dist/client.js client.js（package.json:69）
- 测试：npm test = build + tsc -p tsconfig.test.json + node scripts/run-tests.mjs（package.json:71）
- engines node>=22；入口 lib/host.js（package.json:29-31）
- 发布：release.sh + RELEASING.md；repository=git+https://github.com/abbaababa/dsh-workplan.git（package.json:9）
- 目标：2.3.9 直发（跳号 2.3.3-2.3.8，用户锚点已定）

## 5. 未验证项（如实声明）

- executeSubtask 调用点行号（派发轮循环函数名）本轮未取到（H2 污染持续拦截检索）；已知定义 runtime.ts:1791、由 host.ts:1228 dispatch 工具触发；T3 补一条 grep -n "executeSubtask(" src/runtime.ts 即可（<10 秒），不影响修改点结论
- threePhasePromptLines() 定义未展开（src/three-phase.ts，非验收面向）
- release.sh 内 version-sync 断言细节未展开（T1 已证四源一致；T7 面向）

## 6. 复盘素材

- H2「hi」污染为跨工具随机拦截（bash/grep/read/terminal_send/write 均中招），与命令内容无关；规避=换工具面+同命令最多重试 1 次
- 超长内容勿用 terminal 大 heredoc（PTY 回显放大丢字）；write 工具重试是可靠写盘通道
- 本仓库单文件超大（runtime.ts 8783 行/424KB），检索必须限定 src/ 并控制输出量
