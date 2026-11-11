# T3 集成说明 · LLM 检测与推理等级约束（dsh-workplan 2.3.9）

日期：2026-11-11 ｜ 部门：工程研发 ｜ 角色：核心引擎架构师
依据：用户强制要求 1/2；H2 主 Agent 权威规格；T2 代码考古报告。

## 1. 架构决策（根因与全局）

**唯一事实源（single source of truth）**：家族判定与等级集合定义在
`src/plan.ts:218-282`（与 `REASONING_EFFORTS` 五档存储全集相邻）：

| 符号 | 语义 | 位置 |
|---|---|---|
| `classifyModelFamily(modelId)` | trim+小写后 `qwen` 开头⇒'qwen'；其余非空⇒'other'；空/缺失⇒null（不约束） | plan.ts:237 |
| `QWEN_MODEL_EFFORTS` | `['low','medium','xhigh']`（要求 1 硬白名单） | plan.ts:233 |
| `OTHER_MODEL_EFFORTS` | `['low','high','max']`（要求 2 硬白名单） | plan.ts:234 |
| `effortsForModelFamily(family)` / `getAllowedEffortLevels`（别名） | 家族⇒等级集合；null⇒null | plan.ts:244 / llm-rules.ts:43 |
| `allowedEffortsForModel(modelId)` | 一步式：模型 id⇒等级集合（detect 入口） | plan.ts:251 |
| `COMPLEXITY_EFFORT_BY_FAMILY` / `effortForComplexity` | 轻度/比较复杂/非常复杂⇒档位（要求 1/2 数值化，供负责人/专家选档引用） | plan.ts:256-270 |
| `highestEffortOf(levels)` | 合法集最高档（规划器默认档） | plan.ts:273 |

执行工具层 `src/llm-rules.ts`：转发真源 + 两轨执行函数：
- `validateReasoningEffort`（A3 报错轨：点名集合的明确错误文案）；
- `correctEffortForModel`（A3 修正轨：按强度序下探自动降级，绝不抛错中断派发；
  qwen: max→xhigh、high→medium；非 qwen: xhigh→high、medium→low；留痕含
  `qwen-rule/non-qwen-rule` 规则名与原请求档）；
- `LLM_REASONING_RULES_TEXT`（要求 1/2 全文，T4/T4b 部门告知注入的同一事实源）。

## 2. 双闸时序（要求「检测与约束在分配前执行」）

```
入口检测 classifyModelFamily(modelSelection.model)
  → ① 静态闸（本节新增）：请求档 ∉ 家族集合 ⇒ 自动降级 + console.warn 留痕
  → ② 宿主能力闸（[2.2.7] 既有）：resolveModelInfo 清单交集钳制
  → startActivation / llm.stream 发送
```

- 派发侧：`src/runtime.ts:2046-2078`（静态闸）→ `2079 startActivation`（派发）。
- 规划器侧：`src/runtime.ts:810-845`；默认档=家族合法集最高档
  （qwen⇒xhigh、非 qwen⇒max，H2 规格「规划器侧改为当前模型合法集最高档」）；
  env 覆盖值同样过静态收窄；遥测 `reasoningEffortSource` 记录
  `default-xhigh` / `env→qwen-rule:max→xhigh` 完整轨迹（runtime.ts:1145-1148）。
- 模型名缺失⇒null⇒不施加静态约束（保持 [2.2.7]「无从判定⇒不阻断」，
  防止凭空收紧误伤五档全支持模型）。

## 3. 校验点同步语义（存储不删档）

`plan.ts` readSubtasks / `replan.ts` 入口 / `client.ts` UI Pill 继续校验
**五档存储全集**（REASONING_EFFORTS）：旧计划序列化/回放零迁移；家族收窄
只发生在发送前（执行约束），不改变合法存储域。越界档因此有两条确定路径：
入口写五档全集外的值⇒明确报错；写全集内但家族外的值⇒派发前自动修正+留痕。

## 4. 测试与证据

- `tests/effort-rules.test.ts`（新增）：A1/A2 集合、A3 双轨、大小写/缺失边界、
  复杂度映射、告知事实源、A3b 旧宿主派发集成（qwen/非 qwen 五档收窄表）、
  A3c 规划器家族默认档——共 12 用例。
- `tests/planner-effort-clamp.test.ts`（契约更新）：qwen 家族默认档
  `default-xhigh`；新增 env=max 强制静态修正轨迹用例。
- `tests/reasoning-effort.test.ts`（契约更新）：非 qwen 派发表
  `medium→low、xhigh→high`（要求 2 直接推论），防继承契约不变。
- `scripts/llm-rules-selftest.mjs`：9 用例全过（exit=0）。
- 全量回归：`node scripts/run-tests.mjs` 日志
  `/tmp/full-tests-v239-t3.log`（结果计入结算）。
- A4 构建：`npm run build`（tsc）BUILD_OK，无编译错误。
