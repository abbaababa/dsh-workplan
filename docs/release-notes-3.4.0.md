# dsh-workplan v3.4.0 — 防注意力偏离治本 + KV 前缀缓存重排 + 极致省 Token 全链路改造版

本版对 `dsh-workplan` 底层核心模块（`caps` / `step-budget` / `lessons` / `understanding` / `replan` / `context-packets` / `llm-rules` / `plan` / `host` / `runtime`）做全链路深度改造，系统性根治长链路执行中的注意力丢失/任务偏离问题，并将 KV Prefix Cache 命中率与单任务 Token 成本优化到极致。

## 一、全链路防注意力偏离与抗压缩失忆

- **Node-0 不可变子会话系统锚点 + 压缩后自动重注**：子会话不可变任务锚点直接随 scoped `systemPrompt.section` 注入系统提示词（保持 DSH 0.2.3 两段 `interpolate: false` 契约），不受 `dsh-compaction-basic` 对话折叠影响；并在压缩事件后自动重注防偏离锚点。
- **规划→执行全要素贯通**：明确禁止项（`不要/禁止/不得/严禁/不能/不可/切勿/不允许`）升级为硬约束审计；Phase-0/Phase-1 主管与专家上下文全面扩容并补齐 `constraints`、`successCriteria`、`knownFacts/unknowns/assumptions`、`verification`、`replanHistory` 与阶段检查点，尾部 `【防偏离锚定】` 提升至 `260` 字符。
- **重规划（Replan）真正刷新锚点并支持中止在途旧任务**：`planReplan` 将修订增量写入 `taskAnchor.text` 与 `replanHistory`；`dsh_workplan_replan` 支持 `abortRunning: true`。
- **终局回传零截断与防静默结束**：`workplan-result` 豁免长度压缩并附带 `【各部门交付摘要】`；`onTurnStopping` 等待后台派发就绪后自动引导主 Agent 综合输出最终答复。

## 二、KV Prefix Cache 满血复用与极致省 Token

- **子会话工具集全程锁定**：不可变阶段注册表 + `WeakMap` 会话记忆化消除 Step 1 / Step 2 工具集翻面导致的整条 KV Cache 失效。
- **全提示词 Static-First 重排**：同批 Leader Phase-0 前缀重叠率由 **0.3% → 97.7%**，跨部门 Expert Phase-0 由 **0.3% → 86.6%**，同部门 Expert Phase-1 **>85%**。
- **规划器修复重试多轮续写**：`useRepairDraft` 改为 4-message 多轮续写，100% 复用首轮超长前缀缓存。
- **纯概念问答直通 + 轻任务单会话快车道**：只读概念问答零子会话直答；单文件/轻量任务跳过 Phase-0 单会话闭环。
- **零 Output Token 自动落盘备份 + 洁净复盘**：Node 运行时自动原样落盘结算备份（0 Output Token）；零问题任务支持 `{"noIssues":true}`；专家预注册仅传 `timeNotice` 自动继承 `startPhases`。
- **实时步数 + Token 预算硬熔断**：`DSH_WORKPLAN_TOKEN_BUDGET`（默认 `2,000,000`）与步数硬上限双保险防失控循环。

## 安装与升级

```bash
dsh plugin --profile web add dsh-workplan@3.4.0
```

安装后请**手动重启一次 DSH Web**，再用 `dsh_workplan_status` 确认 `version=3.4.0`。
