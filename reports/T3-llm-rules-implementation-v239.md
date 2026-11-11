# T3 · LLM 检测与推理等级约束实现纪要（v2.3.9）

- 部门：工程研发 ｜ 角色：核心引擎架构师 ｜ 日期：2026-11-11
- 上一轮 CHILD_TIMEOUT 后策略：按纪律先核对盘上产物（上次尝试已落盘大部分实现），本轮只做核验→补缺口→回归，不整步重跑。

## 1. 交付物地图（真源→集成→校验→展示→测试）

| 层 | 文件 | 位置 | 内容 |
|---|---|---|---|
| 真源 | src/plan.ts | L214-281 | `ModelFamily`/`classifyModelFamily`/`effortsForModelFamily`/`allowedEffortsForModel`/`COMPLEXITY_EFFORT_BY_FAMILY`/`effortForComplexity`/`highestEffortOf`（含用户要求1/2原文注释；REASONING_EFFORTS 五档保持存储全集） |
| 执行工具层 | src/llm-rules.ts | 全文(120行) | 真源转发 + 别名 `detectLlmType`/`getAllowedEffortLevels`；`validateReasoningEffort`(A3报错轨)；`correctEffortForModel`(A3修正轨，强度序自动降级、绝不抛错)；`LLM_REASONING_RULES_TEXT`(要求1/2全文，T4 告知注入同引用) |
| 派发集成 | src/runtime.ts | L2040-2078 | executeSubtask：requestedChildEffort→家族集合静态收窄(qwen-rule/non-qwen-rule console.warn 留痕)→[2.2.7]宿主能力钳制（双闸，静态闸先于能力闸）；模型名缺失不约束 |
| 规划器集成 | src/runtime.ts | L809-861 | 默认档=家族合法集最高档（qwen⇒xhigh、其余⇒max）；env 覆盖同过静态收窄；遥测 `reasoningEffortSource = env/default + 修正留痕` |
| 规划校验 | src/runtime.ts / src/plan.ts | 979 / L1101-1140 | validatePlan 增 `options.allowedEfforts`：规划器显式写出的集合外档位拒绝并点名（重试回路回喂自纠）；缺失回落语义不变 |
| 重规划校验点 | src/replan.ts | L262-267 | 本轮补 [2.3.9][T3] 口径注释：按存储全集五档校验是刻意决策（回放/他模型计划零迁移），收窄统一发生在派发入口与规划校验 |
| UI 展示同步 | src/client.ts | L1736-1745 | Pill 白名单保持五档并注明家族收窄口径（不靠 UI 过滤兜底） |

## 2. 自测

- 专项：tests/effort-rules.test.ts（11 用例，run-tests.mjs 按目录自动发现，无需注册）
  - A1 检测与集合（qwen3.8 ⇒ {low,medium,xhigh}，不含 high/max；大小写/空白/非开头边界）
  - A2 集合（gpt-4o/claude/deepseek/kimi/GLM ⇒ {low,high,max}，不含 medium/xhigh；模型缺失⇒null 不约束）
  - A3 报错轨+修正轨（max→xhigh、high→medium、xhigh→high、medium→low；reason 留痕可读；未知模型原样透传）
  - 复杂度映射（轻度/比较/非常 → low/medium|high/xhigh|max）
  - A3b 派发端到端（旧宿主无能力清单时静态闸仍收窄五档请求）
  - A3c 规划器端到端（qwen 命名模型默认 max 静态修正为 xhigh 后发送）
- 旧契约对齐：tests/planner-salvage.test.ts（fake-model 判 'other'，五档旋钮期望按家族闸更新并加 qwen-fake 对照组；大小写/trim 原意保留在合法集内验证）

## 3. 验收结论

- A1/A2/A3：effort-rules.test.ts 全绿（11/11，含派发/规划器集成用例）
- A4：npm run build 退出码 0（tsc 零错误）；npm test 全量回归见结算文件
