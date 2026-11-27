# dsh-workplan v3.3.2 — DSH 0.2.3-alpha.2 全面适配 + 结算误判治本版

本版做两件事：一是针对 DeepSeek Harness `0.2.3-alpha.2` 的全部破坏性变更做逐项底层适配（100% 向后兼容 `0.2.2-rc.x`）；二是治本修复一条会把「已经交出的证据」判成「没交证据」、并连带冻结整条计划的结算链缺陷。3.3.1 的极致省 Token 与高质量证据门禁体系原样保留。

## 一、结算误判治本（2026-11-26 会话 `session-ad9066eb…` / 计划 `wp-6cf42e5b…` 实测）

事故现场：T1 子会话收尾正文已经交出 `execution` / `verification`（含复盘），真正缺口只有验收项 A2 一条；但平台最后写进台账的是「五步证据不完整：phases 缺失」，且 T1 一次即受阻、T2–T11 全部「上游受阻」，11 项 0 完成。三层根因，逐层治本：

- **① 盘上结算备份不得覆盖更优的本次回报**：旧逻辑对「结果块不可解析 / 缺块 / 结算闸退回」三类失败统一先读盘上备份，只要备份不是「缺块或不可解析」就照单采纳。T1 的备份是摘要式的（只有 `status`/`summary`/`artifacts`/`acceptance`，没有 `phases` 与证据块），于是更差的备份覆盖了更好的本次回报：子会话拿到与真实缺口无关的「phases 缺失」，台账 `summary` 被替换成一段备份 JSON，本可救回的有界回喂（`EVIDENCE_INCOMPLETE`）被直接跳过。现在只采纳「有独立结算价值」的备份——`status=done`（等价于一份完整合法证据）或 `blocked` 且带 `question`（明确请示，需要保住问题原文）；其余（`unverified` / `failed` / `comm-format` / `partial`）一律拒绝采纳，并落回消息路径的有界回喂，按真实缺口补报。严格性不变，诊断不再被覆盖。
- **② 结算备份写法指令去歧义**：旧提示词写「发送前将同一 JSON（顶层带 planId/subtaskId）写入 …」，实际被理解成「写一份摘要 JSON 就算备份」，于是备份永远过不了结算闸、本地恢复形同虚设。现在明确要求：把最终结果块里那份 JSON **原样**另存（字段一个不少，含 `phases`/`acceptance`/`artifacts`/`departmentSummary`），只在最外层额外加 `planId` 与 `subtaskId`；摘要式备份平台不采纳。
- **③ 归位成功的缺口提示改为如实文案**：结果块结尾少一个 `}` 时，`acceptance`/`artifacts` 会被吞进 `phases`；平台本已把它们自动归位并读到 5 条验收，旧提示却统一写「若 acceptance 位于错误点之后，会被一起裁掉」，让子会话以为证据被裁、倾向整块重写（费 token 又扩大出错面），还掩盖了「只缺 A2」这条真正要补的缺口。现在归位成功时如实写明已归位哪些字段、已读到几条验收，并只要求补缺的编号。

## 二、DeepSeek Harness 0.2.3-alpha.2 深度兼容修复

- **修复看板接口 100% 报错（503 鉴权服务不可用）**：`0.2.3-alpha.2` 移除了 `connection.requestRejection(req)`，改为由 `WebServer.register({ auth })` 经 `webserver/authorize` 完成 Host/Origin/Cookie/Token 校验，并把已放行的 `peer: PeerScope` 作为第 3 参数传给 `handler(req, res, peer)`。本版在 `/dsh-workplan/plans` 显式声明 `auth: 'required'` 并透传 `peer`，在 `/dsh-workplan/vendor/chart.umd.js` 显式声明 `auth: 'anonymous'`；`runtime.route()` 依次兼容旧版 `requestRejection`、新版 `PeerScope` 放行与 `connection.admit(request)` 直调，无可用鉴权器或拒绝时严格 fail-closed；前端 `fetchPlans` 显式附带 `credentials: 'same-origin'`，保证 `HttpOnly; SameSite=Strict` 会话 Cookie 稳定送达。
- **修复工具 JSON Schema 严格子集校验报错**：`dsh-tools` 现在只接受精简子集（关键字仅 `type/oneOf/properties/required/additionalProperties/items/enum/const` 加注解 `description/title/default/examples`）。清理了 `dsh_workplan_replan.changes`（`minItems`/`maxItems`）与 `dsh_workplan_delegate.timeNotice.declaredMinutes`（`minimum`/`maximum`）上的非子集关键字；14 个工具的 `parameters`/`output.schema` 与 `plannerOutputSchema` 全部零违例，运行时上下界硬校验不变（0 与 10081 分钟仍被丢弃）。
- **适配预设隔离域下的 `planMode` 检测**：`dsh-plan-mode` 移入每会话预设的 `isolate: { planMode: true }` 隔离域。`isPlanModeActive` 在 `sessionProjections.snapshot(session, ['plan'])` 缺失时自动回退到会话预设域 `planMode.get(agent)` 及会话持久化的 `plan/mode` 事件，冷恢复与预设切换场景不再漏判 plan 模式。
- **系统提示词字面量保护与新 Shell 工具写保护**：主会话全局段与子会话遮蔽段显式声明 `interpolate: false`，防止模板插值器因意外 `{{...}}` 抛错；`isShellLikeToolName` 扩展覆盖 0.2.3 预设新增的 `pwsh` 与 `persistent_bash`。

## 三、验证与版本同步

- 新增 `tests/dsh-023-compat.test.ts`：双代鉴权五分支（旧 `requestRejection` 拒绝/放行/抛错、新版 `PeerScope` 放行/拒绝、`connection.admit` 三条结果、无鉴权器 fail-closed）、`isPlanModeActive` 三层检测、14 个工具 + 规划器的严格子集关键字零违例、`isShellLikeToolName` 覆盖 `pwsh`/`persistent_bash`，以及 `interpolate: false`、`auth: 'required'/'anonymous'`、`credentials: 'same-origin'` 三处宿主契约的静态断言。
- 新增 `tests/workplan-332-backup-quality.test.ts`：摘要式备份不得覆盖更好的本次回报（拒绝采纳 → 带真实缺口的回喂 → 补报后 done）、回喂耗尽仍按真实缺口受阻、受阻备份只在带 `question` 时采纳、完整合法备份照旧一次采纳、归位文案如实、提示词写明原样备份。
- 修正三处随本版过期的旧断言：`delegate` 的 `timeNotice` 边界断言改为「描述写明 1..10080 + 代码硬校验」，两处版本断言升至 3.3.2。
- 全量回归测试、类型检查与构建产物同步通过。
- 版本同步：`package.json` / `package-lock.json` / `src/host.ts` / `CHANGELOG.md` / 三份 README / `tests/fixtures/tool-surface.json` 全部为 `3.3.2`。

## 安装与升级

```bash
dsh plugin --profile web add dsh-workplan@3.3.2
```

安装后请**手动重启一次 DSH Web**（本插件不会自行重启任何进程），再用 `dsh_workplan_status` 确认 `version=3.3.2`。

## 已知边界（如实说明）

- 本版仍不改变「缺失永不计 done」的严格性：证据不全时子任务照旧不能记完成，区别只在于**诊断准确、且会先回喂补报**，不再一次即阻断并级联冻结下游。
- 计划若已因历史缺陷写坏（如 11 项全部 blocked），升级不会自动重算历史台账；请按主 Agent 给出的恢复指引在原会话重新 `dsh_workplan_dispatch` 续跑（已完成项不会重跑）。
