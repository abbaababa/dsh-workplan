# 测试覆盖矩阵（ATE_COV/DPT/FUN 对齐）／ Test Coverage Matrix

> 对象：dsh-workplan v1.12.0 ｜ 基线：git HEAD `5fe47a1` ｜ 日期：2026-11-03 ｜ 撰写：T5
> 证据基线：T3 实跑 `npm test --silent` → **tests 462 / pass 462 / fail 0**（2026-11-03，Node；注意历史文档中的 188/459 均为过期数字）。复核命令：`npm test`。
> 注：本仓工作区在 T4 修复进行中有未提交改动；本数字对应 HEAD `5fe47a1` 状态，T6 复检应以复检时点实跑为准。
> 性质：公开自评估文档，不宣称 CC 认证；ATE_IND.1（认可实验室独立测试）为固有残留，见文末。

## 0. 覆盖的差距编号

G-20（无正式覆盖矩阵）、G-21（测试分层未成文）、G-22（失败路径已覆盖，成文确认）。

## 1. 测试分层（ATE_DPT）／ Test layers

| 层级 | 范围 | 代表测试 |
|---|---|---|
| 单元级 | 单模块函数/数据结构 | plan、derived-counts、phase-percent-invariant、supersede-digest |
| 模块级 | 模块间契约 | workplan-host、workplan-host-schema、runtime-replay、version-sync、build-artifacts |
| 集成/端到端 | 工具全流程与门禁 | workplan-w5-cancel-e2e、workplan-dispatch-modes、workplan-supersede、delivery-gate |
| 失败路径 | 错误、超时、卡死、重试 | workplan-budget-pause、workplan-stuck-recovery、timeout-artifact-evidence、workplan-replay-errors、workplan-retry-feedback |

测试文件共 65 个（`ls tests | grep -c '\.test\.ts'`；另含 fixtures 目录）。

## 2. 安全功能（TSF）↔ 测试映射（ATE_COV）／ TSF ↔ test mapping

| TSF（SFR） | 测试文件（证据） |
|---|---|
| 审计留痕 FAU_GEN（证据契约） | workplan-evidence-contract、plan-anchor、derived-counts |
| 访问控制 FDP_ACC/ACF | workplan-presented-write-guard、session-reference-safety、security-headers |
| 安全管理 FMT（门禁/状态锁/根会话限制） | delivery-gate、present-gate-evidence、workplan-status-lock、present-deny-code、workplan-turn-stop-gate |
| 域隔离 FPT_SEP | session-reference-safety、security-headers、workplan-team-brief |
| 会话超时 FTA_SSL | timeout-artifact-evidence、workplan-budget-pause、workplan-budget-preserve |
| 容错 FRU_FLT | auto-resume-policy、workplan-stuck-recovery、workplan-auto-retry、workplan-retry-feedback、session-end-convergence |
| 重规划/取代（变更控制） | workplan-replan-progress、workplan-supersede、workplan-closure-ack-escalation、workplan-closure-n1-n5、workplan-crossdept-hardening |
| 工具接口行为 | workplan-followup-tool、workplan-dispatch-modes、workplan-1815-guards、plan-id-symmetry、plan-mode |

## 3. 覆盖声明与边界 / Coverage statement

- 每个 SFR 至少映射 2 个测试文件（见 §2），映射由文件名可复核（`ls tests`）。
- 未宣称行覆盖率（line coverage）百分比：本仓未配置覆盖率工具，此为如实披露，不做数字宣称。
- 残留（不可由本项目修复）：ATE_IND.1 要求认可实验室独立测试；本仓提供的替代事实是「任何人可一键复跑」——`npm test` / `npm run verify` + CI 每次提交执行。
