# T2 · dsh-workplan 现有分发机制源码结构报告（v2.3.9 改造基线）

> 研究分析部门·代码考古专家 ｜ 采集时点：2026-11-10 23:44+（HEAD 见 §6）
> 基线版本 2.3.2 ｜ 插件路径 `/Users/open/Documents/Stocks/plugins/dsh-workplan` ｜ TypeScript（src 16 文件，约 24145 行）

## 0. 源码文件地图（wc -l 实测）

| 文件 | 行数 | 职责（据定位） |
|---|---|---|
| src/runtime.ts | 8783 | 核心：规划调用、dispatchPlan 派发循环、子 Agent 选项装配、档位钳制 |
| src/plan.ts | 5212 | 计划 schema 校验（reasoningEffort 白名单）、规划器提示词生成 |
| src/client.ts | 3520 | Web 看板渲染（子任务卡片显示推理等级 Pill） |
| src/host.ts | 1646 | 宿主侧状态行/规划器档位记录展示 |
| src/understanding.ts | 1463 | 需求理解阶段 |
| src/replan.ts | 739 | 重规划字段校验（reasoningEffort 入口白名单） |
| src/departments.ts | 311 | 部门定义（13 部门枚举） |
| src/lessons.ts / watchdog.ts / auto-resume.ts / notice-channel.ts / comm-format.ts / three-phase.ts / supersede*.ts | ≤445 | 辅助机制 |

## 1. 已确证的现有机制（grep -n 行号证据）

### 1.1 档位校验（五档全白名单，无 qwen/非qwen 分模型约束）
- `src/plan.ts:781-786` — 规划输出校验：`REASONING_EFFORTS.includes(source.reasoningEffort)`，允许 low/medium/high/xhigh/max 五档全集；非法值拒绝不改写；缺失回落 `DEFAULT_REASONING_EFFORT`（plan.ts:831）。
- `src/replan.ts:262-272` — replan 入口白名单（replace/add 共用 `replanFieldError`）：同样五档全集。
- `src/replan.ts:199-214` — 字段清单含 reasoningEffort；显式 null 按缺失处理（2.2.7 修复）。
- `src/client.ts:1741-1743` — 渲染侧白名单 `['low','medium','high','xhigh','max']`。
- **缺失点①**：全链路校验只按"五档全集"，没有按**目标模型**（qwen→{low,medium,xhigh} / 非qwen→{low,high,max}）收窄——这正是 2.3.9 要加的约束。

### 1.2 2.2.7/2.3.x 已有的 qwen 兼容基线（运行时钳制，非分配约束）
- `src/runtime.ts:247-275` — 注释块：旧行为 `plannerEffort || modelSelection.reasoningEffort` 在 qwen（只声明 low/medium/xhigh）上被宿主 dsh-llm 请求前拒绝（D2 现场 qwen3.8-flash INVALID_JSON×3）；修复=按模型声明清单钳制：max→xhigh、high→medium、空清单则不发送 reasoningEffort 字段。
- `src/runtime.ts:915` — `buildPlannerPrompt(taskText, cwd, conversationContext, budget)` 规划提示词入口。
- `src/runtime.ts:928-937` — `effectivePlannerEffort` 计算 + 规划调用注入。
- `src/runtime.ts:1111-1112` — 规划器档位记录 `reasoningEffortSource: env | default-max`。
- `src/runtime.ts:1998-2004` — 派发侧：读 `subtask.reasoningEffort`（REASONING_EFFORTS 白名单）为 `requestedChildEffort`。
- `src/runtime.ts:2076-2087` — 子 Agent 选项：`resolveChildAgentOptions` 未点名档位会继承父档位（AGENTS.md#12 禁止），故显式 `...(childEffort ? { reasoningEffort: childEffort } : {})`。
- **性质区分**：以上是**事后钳制**（把不合模型的档位映射成合法档），不是用户要求的**事前按模型限定候选集+按复杂度指定档**。T3/T4 是在分配规则层新增，不是替换钳制层。

### 1.3 规划器提示词中的分配规则（部门告知注入点）
- `src/plan.ts:1443-1446` — 强制规划器为每个子任务写 reasoningEffort（五档；轻度=low、中等=medium/high、非常复杂=xhigh/max；禁止继承主 Agent 档位）。
- `src/plan.ts:1506` — 规划输出 JSON 模板含 `"reasoningEffort": "high"` 示例。
- **修改点**：要求1/2 全文（qwen 三档/非 qwen 三档映射）需注入此提示词与派发 payload。

## 2. 调用链（主 Agent 分配→部门→专家）

```
dsh_workplan_dispatch 工具 (runtime.ts:6887 dispatchTool)
  └→ record.dispatchPromise = dispatchPlan(...)   (runtime.ts:7105; 另有 4809、5932 两个调用点)
       dispatchPlan 定义: runtime.ts:3252 (export async function dispatchPlan(ctx, record, options))
       └→ 逐子任务派发:
            读 subtask.reasoningEffort → requestedChildEffort (runtime.ts:1998-2004)
            → 按模型清单钳制 → childEffort (runtime.ts:247-275 注释所述逻辑)
            → 子提示词组装: buildChildPrompt(plan.ts:4934) ← 在 runtime.ts:2027 被调用
               (部门职责/典型产物注入: plan.ts:4995-5001 departmentCapability)
            → resolveChildAgentOptions → agentOptions { provider, model, reasoningEffort: childEffort } (runtime.ts:2076-2090)
            → startActivation(provider:'spawn', maxDepth:1, delivery:'caller') (runtime.ts:2024-2096)
            → 部门子会话创建（现状严格两层：主→部门执行者；无负责人第三层）
  规划上游:
  用户任务 → buildPlannerPrompt (runtime.ts:915) → LLM 规划（注入 effectivePlannerEffort, :937）
  → plan.ts 校验子任务 schema (:781-831) → 计划落库 → dispatch
```

## 3. 修改点清单（A1 五维度，engineering 可直接引用）

### 维度① LLM 检测逻辑（qwen/非qwen 判定）—— 净新增
- 现有基础：`src/runtime.ts:8187` `function resolveModelSelection(ctx, payload)` —— 现成的"当前用户模型"取值函数（8193/8201/8210 读 direct/agentOptions/current 三处 reasoningEffort，8362 `const modelSelection = resolveModelSelection(ctx, payload)` 为赋值点；`modelSelection.model` 即模型 id 字符串）。
- **M1 新增**：`src/runtime.ts` 或 `src/plan.ts` 增 `classifyModelFamily(modelId): 'qwen'|'other'` + `allowedEffortsForModel(modelId): string[]`（qwen→{low,medium,xhigh}；非qwen→{low,high,max}）。建议放 `plan.ts:211` 常量旁（与 REASONING_EFFORTS 同区，四点校验共用一处真源）。
- **M2 集成**：`src/runtime.ts:1998-2033` 派发前，先取静态表 `allowedEffortsForModel(modelSelection.model)`，再与 `resolveSupportedEfforts`（:309，宿主声明清单）取交集钳制、留痕（H1 拍板口径：静态表权威+宿主交集钳制留痕）。

### 维度② 推理等级集合设定 —— 扩展
- `src/plan.ts:211-212` — `REASONING_EFFORTS`（五档全集）与 `DEFAULT_REASONING_EFFORT='high'`。**修改**：保持五档为存储全集，新增"按模型收窄的候选集"导出；缺失回落值改为按模型族选档（qwen 上 'high' 非法，现靠钳制兜底，2.3.9 应在选择层就合法）。
- `src/plan.ts:781-786, 831` — validatePlan 校验点：加模型感知校验（拒绝不属于该模型集合的档位，或按复杂度映射改写）。
- `src/replan.ts:262-272`（`replanFieldError`）— 同规则入口校验扩展。
- `src/client.ts:1741-1743` — 渲染白名单同步。
- `src/runtime.ts:250` `DEFAULT_PLANNER_REASONING_EFFORT='max'` — max 在 qwen 上非法，靠 :284 钳制降档；规划器档位选择应改为按当前模型合法集内最高档。

### 维度③ 部门告知注入（要求1/2 全文）—— 净新增注入
- **模式基线**：`src/departments.ts:39-49` `DEPARTMENT_EXPERT_STANDARD = {planner, child}` —— 既有"单一事实源、双端消费"模式，2.3.9 的 `LLM_EFFORT_RULES`（要求1/2 全文）应照此新增常量（建议 departments.ts 或新模块）。
- **注入点A（规划器）**：`src/plan.ts:1370` `buildPlannerPrompt(...)`，规则文本段现位于 :1443-1446（五档通用规则）、输出模板 :1506。插入要求1/2 全文+当前模型判定结果。
- **注入点B（部门子会话）**：`src/plan.ts:4934` `buildChildPrompt({...})`，段落组装区 :4955-5023（noticeTarget/anchor/contradiction/team/failure 各段）；调用点 `src/runtime.ts:2027`。新增 `llmRules` 段=要求1/2 全文+本子任务目标模型合法档集+该子任务已配档位。
- `src/runtime.ts:915`（planner 调用）与 :2027（child 调用）为两条注入链的运行时交汇点。

### 维度④ 负责人二次分配流程 —— 净新增（三层派发不存在）
- 全 src grep：`workplan_delegate` 0 命中；「负责人」仅 `src/client.ts:18` 一处注释（role 是自由文本，无 lead 语义）→ **无部门负责人节点、无二次派发代码**。
- `src/runtime.ts:2089` `maxDepth: 1` 硬编码 → 子会话不能再派子会话（T4b 需新增工具+放开深度或模拟两层台账）。
- 挂接点：`src/runtime.ts:3252` `dispatchPlan(ctx, record, options)` 派发循环（:4809/:5932/:7105 三调用点）；新工具注册模式参照 `dispatchTool`（:6887）与工具面 schema（:8749 `dispatchToolOutputSchema`）。
- `src/departments.ts:51-58` `DepartmentCapability` 接口（id/zh/en/responsibilities/outputs/keywords）——新增 lead 职责字段/门禁文案的扩展点。

### 维度⑤ 专家等级配置应用（全程） —— 扩展
- `src/runtime.ts:1998-2004` `requestedChildEffort` 读取 + :2076-2087 `agentOptions.reasoningEffort` 显式下发 —— 档位已"一次性"传给子会话选项；**缺**：把档位与其规则全文写入子提示词（维度③注入点B 合并实现），使专家在规划/执行/验证各步自觉应用；续跑/延期路径（:5932 再激活）同样经过 :2027 buildChildPrompt，注入后自动全程生效。
- `src/host.ts:1182-1183` 规划器档位留痕展示；`src/runtime.ts:1111-1112` `reasoningEffortSource` 记录 —— 留痕模式可复用于"模型族判定结果"审计。

## 4. 负责人二次分配现状结论
现有机制为**严格两层**：主 Agent(dispatchPlan) → 部门子会话(执行者)。无负责人节点、无第三层派发工具、maxDepth=1 阻断子会话再派。T4b 的三层派发（负责人→顶尖专家+组员）全部为净新增，建议实现骨架：① departments.ts 增 lead 语义与梳理门禁文案；② 新工具（如 workplan_delegate）注册+权限校验（参照 dispatchTool:6887 模式）；③ 派发循环 runtime.ts:3252 增负责人先梳理再分配的硬门禁；④ 子会话深度策略调整（maxDepth:1 于 :2089，需评估放开或改"同层多子会话"台账模拟）；⑤ tool-surface fixture 同步。

## 5. qwen/非qwen 等级校验缺失点·精确定位
| # | 位置 | 现状 | 缺失 |
|---|---|---|---|
| G1 | plan.ts:211 | 五档全集常量 | 无按模型族的合法子集定义 |
| G2 | plan.ts:781-786 | validatePlan 只查五档全集 | 未按 modelSelection.model 前缀收窄候选集 |
| G3 | replan.ts:262-272 | 同上 | 同上 |
| G4 | runtime.ts:284/309/1998-2033 | 事后钳制降级（宿主声明清单） | 无事前"qwen→三档/非qwen→三档"静态规则；钳制留痕无"为何降"审计文案 |
| G5 | plan.ts:1443-1446 | 规划器提示词写通用五档映射 | 无要求1/2 的模型族条件映射文本 |
| G6 | plan.ts:4934/4995 | 子提示词注入部门职责 | 不注入等级规则与本任务档位，专家无从"全程应用" |
| G7 | client.ts:1741 | 渲染白名单五档 | 不显示模型族合法集/降档原因 |

## 6. 版本与构建记录
- package.json：`dsh-workplan@2.3.2`（node require 实测输出 `2.3.2 dsh-workplan`）
- 构建：TypeScript，`npm run build`（tsc）；测试 `npm test`（run-tests.mjs）；engines node>=22（T1 已证，本任务不重复取证）
