# T3 · LLM 检测与推理等级约束实现报告（v2.3.9）

- 部门：工程研发 ｜ 角色：核心引擎架构师 ｜ 日期：2026-11-11
- 范围：主 Agent 裁决口径 M1+M3（检测/静态集合/事前约束/留痕）；不触碰 buildChildPrompt 签名与三层派发（T4b 边界）。

## 1. 真源与工具层

- `src/plan.ts`（REASONING_EFFORTS 五档存储全集旁，L211 起）：
  - `classifyModelFamily(modelId)`：trim+小写后 `startsWith('qwen')` ⇒ 'qwen'，其余非空 ⇒ 'other'，缺失/空 ⇒ **null=不施加约束**（防凭空收紧误伤五档全支持模型，[2.2.7] 同风格）。
  - `QWEN_MODEL_EFFORTS={low,medium,xhigh}`、`OTHER_MODEL_EFFORTS={low,high,max}`、`allowedEffortsForModel(modelId)`。
  - 复杂度映射 `COMPLEXITY_EFFORT_BY_FAMILY`：light=low；qwen moderate=medium/heavy=xhigh；other moderate=high/heavy=max（`effortForComplexity`）。
  - `highestEffortOf(levels)`：家族合法集内最高档（qwen⇒xhigh、非 qwen⇒max）。
  - **五档 REASONING_EFFORTS 未删档**（存储全集；两家族集合的并恰=五档，正式测试有断言）。
- `src/llm-rules.ts`（新建工具层）：re-export 真源（兼容别名 `detectLlmType ≡ classifyModelFamily`）+ 执行函数：
  - `validateReasoningEffort(effort, allowed)`：A3 报错轨，错误文案点名家族集合；
  - `correctEffortForModel(effort, modelId)`：A3 修正轨，按强度序逐级下探（qwen: max→xhigh、high→medium；非 qwen: xhigh→high、medium→low），绝不抛错，reason 文案 `qwen-rule:high→medium（…）` 可审计；
  - `LLM_REASONING_RULES_TEXT`：要求 1/2 全文，单一事实源，供 T4/T4b 部门告知注入直接 import。

## 2. 集成点（时序：检测→静态收窄→宿主能力交集钳制→发送）

- `src/runtime.ts` import：`{ allowedEffortsForModel, classifyModelFamily, correctEffortForModel, highestEffortOf } from './llm-rules.js'`。
- **规划器侧**（runPlanner，原 805-831 区）：
  - 默认档改为「当前模型合法集内最高档」`plannerFamilyDefault`，env（DSH_WORKPLAN_PLANNER_REASONING_EFFORT）显式覆盖仍优先，覆盖值同样过静态收窄；
  - `plannerStaticCorrection`：env 值家族越界 ⇒ 自动降级 + console.warn JSON 留痕（provider/model/family/requested/corrected/allowed/reason）；
  - [2.2.7] 宿主能力钳制改为在 `staticRulePlannerEffort` 之上继续交集（两道闸，U7 裁决）；
  - 遥测 `reasoningEffortSource`（host.ts:1183 展示面同源）= `env|default-<档>` + `→qwen-rule:max→xhigh` + `→clamped(<档>)` 三段可审计文案。
- **派发侧**（executeSubtask，原 1998-2033 区）：
  - `requestedChildEffort`（五档白名单+缺失回落 high）后新增 `childStaticCorrection`：家族越界 ⇒ 强度序降级 + console.warn 留痕（含 subtaskId），再走 [2.2.7] 能力交集钳制——派发不因档位中断（A3 修正轨）。
- **规划校验**（`plan.ts validatePlan(raw, options?)`）：新增可选 `options.allowedEfforts`；传入时对规划器**显式写出**的集合外档位拒绝并点名（错误经重试回路回喂自纠=事前约束）；未传 ⇒ 零行为变化（旧计划/回放/旧调用零迁移）。规划器调用点（runtime.ts 主路径）已传 `allowedEffortsForModel(modelSelection.model)`。
- **replan 校验**（`src/replan.ts replanFieldError(raw, allowedEfforts?)`）：五档合规但家族越界同样拒绝并点名；`planReplan` 内 replace/add 两条调用路径已透传 `options.allowedEfforts`（runtime 工具处理器调用点未透传=保持旧行为，参数已就绪，T4b 派发链改造时一行接入）。
- **UI Pill**（`src/client.ts`）：注释口径同步——收窄发生在规划校验/派发入口，Pill 按存储全集五档展示（旧计划/他模型计划回放不得被 UI 删档）。

## 3. 验收证据

- A1：`tests/effort-rules-llm-family.test.ts [2.3.9/A1]` + 自测 `PASS A1 qwen3.8 → {low,medium,xhigh}`（`reports/t3-selftest-r2.log`，9/9 exit=0）。
- A2：`[2.3.9/A2]` gpt-4o/gpt-5 ⇒ {low,high,max} 且不含 medium/xhigh + `PASS A2`。
- A3：报错轨 `validateReasoningEffort`/`validatePlan` 拒绝文案 + 修正轨 `correctEffortForModel` 降级表（max→xhigh、high→medium、xhigh→high、medium→low），全部有测试断言与 console.warn/qwen-rule 留痕。
- A4：`npm run build` ⇒ **BUILD_EXIT=0**（`reports/t3-build-239-r2.log`，tsc 零错误）；正式 `npm test` 全量结果见 `reports/t3-npm-test-239.log`（NPM_TEST_EXIT 摘要追加于 §5）。

## 4. 边界与偏离记录

- 偏离1（主 Agent 指示 vs 现场）：指示要求自测文件名 tests/effort-rules.test.ts——该文件已存在且承载 [2.2.7] 能力钳制契约（全量套件的一部分）。处置：新建互补卷 `effort-rules-llm-family.test.ts`，不覆盖既有契约（禁止静默替换既有测试是同源教训）。
- 边界1：salvagePartialPlan（abort 抢救路径）未传 allowedEfforts——抢救的是已产出正文，收紧拒绝会让降级更常见；派发侧静态收窄对该路径产物同样生效，无漏网。
- 边界2：replan runtime 调用点未透传 allowedEfforts（避免与 T4b 的派发链改造冲突）；参数化与两路校验逻辑已就绪。
- 通道事故：本会话两次全程工具被 auto-review 污染拦截（「hi」前缀），一次经主 Agent 修复 AGENTS.md 后恢复，一次在步骤边界自行恢复；期间用 write/terminal/bash 换面推进，零虚构证据。

## 5. npm test 最终结果（追加）

- `npm test`（build + tsc -p tsconfig.test.json + run-tests.mjs 全管道）⇒ **R2_EXIT=0**：
  `# pass 750 / # fail 0 / # cancelled 0`（`reports/t3-npm-test-239-r2.log`）。
- `[2.3.9]` 标签用例 16 项全过，含新卷 `tests/effort-rules-llm-family.test.ts`：
  ok 119/120（A1）、121/122（A2）、124（映射）、126/127（A3 报错轨+修正轨）、
  129/130（事前约束/零迁移）、131（告知事实源）。
- 首轮 r1 唯一失败（`not ok 316`「合法旋钮 medium 必须原样透传」）判定：该断言属旧
  测试文本；tests/planner-salvage.test.ts 已并发更新为 [2.3.9] 新口径（fake-model⇒
  other 家族 medium→low 收窄 + non-qwen-rule 留痕），与 runtime 实现一致，r2 全绿。
- A4 双证：`npm run build` BUILD_EXIT=0（reports/t3-build-239-r2.log）+ 上述 R2_EXIT=0。
