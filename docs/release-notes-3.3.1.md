# dsh-workplan v3.3.1 — 全流程防偏离锚定 + 阶段裁剪极致省 Token 版

本版在 3.3.0 基础上完成全链路防偏离锚定与第二轮深度省 Token 优化；证据链（F1–F11、startPhases）、防幻觉、写保护、审批门禁与无执行时限契约原样保留。

## 一、全流程防注意力丢失与防偏离

- **阶段 0 规划可见北极星锚点**：部门主管阶段 0（`buildPhaseZeroLeaderPrompt`）与一线专家阶段 0（轻量 `planning` 上下文包，零磁盘 I/O）均携带用户原要求、交付物、验收标准与质量要求，避免前期估算与拆解跑偏。
- **阶段 1 执行与终局防偏离提醒**：部门主管任务书（`buildChildPrompt`）与一线专家任务书（`buildDelegateePrompt`）末尾增补近因防偏离锚定提醒；总管最终汇总（`buildResultMessage`）附带原要求锚点对照提示。
- **清除内部通知挤占对话上下文**：`recentConversation` 自动过滤所有 `workplan` / `workplan-*` 内部通知，不再把真实用户需求挤出上下文窗口。

## 二、极致省 Token 优化

- **按不可变阶段裁剪无用工具定义（KV 缓存零抖动）**：基于子会话首条不可变提示词判定阶段，一线专家执行期隐藏 `dsh_workplan_delegate`（工具注入从 4,981 字降至 1,392 字，**-72.1%**），主管规划期隐藏 `dsh_workplan_verify` / `dsh_workplan_instruct`（**-48.4%**）。
- **静态前置最大化复用 KV 前缀缓存**：重排部门主管任务书为“通用协议与计划级静态前缀在前、单任务动态尾巴在后”，跨部门并行主管共享 >3,000 字节相同前缀；专家执行期规则简报省略已完成阶段 0 规则与专家姓名，确保同组专家前缀一致。
- **精简提示词、工具 Schema 与无效历史经验**：系统提示词再降 17.4%、14 个工具 Schema 总计再降 15.6%、过滤跨部门/跨项目零相关历史教训并消除 RCR 上下文包重复标题与冗余引用列表；阶段 0 跳过不必要的磁盘教训读取。

## 三、一致性与验证

- 全量回归测试、类型检查与构建产物同步通过。
- 版本同步：`package.json` / `package-lock.json` / `src/host.ts` / `CHANGELOG.md` / 三份 README / `tests/fixtures/tool-surface.json` 全部为 `3.3.1`。

## 安装与升级

```bash
dsh plugin --profile web add dsh-workplan@3.3.1
```

安装后请手动重启 DSH Web，然后用 `dsh_workplan_status` 确认 `version=3.3.1`。
