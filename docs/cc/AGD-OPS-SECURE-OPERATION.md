# 安全操作与准备程序（AGD_OPS.1 / AGD_PRE.1 对齐）／ Secure Operation & Preparation

> 对象：dsh-workplan v1.12.0 ｜ 日期：2026-11-03 ｜ 撰写：T5 ｜ 性质：公开自评估文档，不宣称 CC 认证。
>
> **版本说明（2026-11-06 补记）**：本文是 v1.12.0 时点的评估快照，正文里的版本号与实测数字都属于那次评估，不改写历史；当前发布版本、下载校验值与变更记录以 README 徽章、CHANGELOG 和 GitHub Release 页为准。

## 0. 覆盖的差距编号

G-11（安全相关操作不成文）、G-12（安装缺完整性校验步骤）、G-31（超时常量未在 AGD 引用）。

## 1. 安装前校验（AGD_PRE.1 补强）／ Pre-installation verification

安装前按顺序做两步校验（复制即可用）：

```bash
# 1) 确认包来源是官方 npm 注册表与最新版本号
npm view dsh-workplan version dist.tarball
# 期望：输出与 README 徽章一致的最新版本号，tarball 域名为 registry.npmjs.org

# 2) 下载后校验完整性（sha512 由 npm 提供；发布包 sha256 见 GitHub Release 页附件）
npm pack dsh-workplan --pack-destination /tmp && shasum -a 256 /tmp/dsh-workplan-*.tgz
# 期望：与 GitHub Release 页公布 sha256 一致（发布物凭据由 T8 发布步骤生成）
```

- 来源确认：官方仓库 `github.com/abbaababa/dsh-workplan`；tag `vX.Y.Z` 与 npm 版本一一对应（`git rev-parse vX.Y.Z` 可复核）。
- 若 sha256 不一致：**停止安装**，按 SECURITY.md §3 报告。

## 2. 安装与启用（AGD_PRE.1）／ Installation

```bash
# 在支持 DSH 插件机制的宿主中安装（全局 CLI 示例）
npm install -g dsh-workplan
```

启用后插件向主 Agent 注入 9 个 `dsh_workplan_*` 工具与提示词规则；本地面板路由 `GET /dsh-workplan/plans` 提供只读状态视图。卸载即 `npm uninstall -g dsh-workplan`，插件不写入系统目录、不留驻后台进程。

## 3. 安全相关操作（AGD_OPS.1）／ Secure operation

### 3.1 权限边界
- 插件只在宿主授予的文件沙箱内写文件（DSH file policy，如 workspace-write）；越界写会被沙箱拒绝并在答复中如实标注。
- 子 Agent 权限在启动时固化：不能派发、不能扩权、不能联网安装服务；遇阻只能 `dsh_workplan_escalate` 上报。
- 只有根会话可调用 `dsh_workplan_handoff`；只有「待指示」行可被 `dsh_workplan_instruct` 恢复。

### 3.2 告警与状态含义（看到什么、该做什么）

| 状态/告警 | 含义 | 正确动作 |
|---|---|---|
| `deliveryReady=false` | 有 done 项缺 structured 验收或产物缺失 | 不要采信“已完成”答复，继续派发补齐 |
| `blocked` / 卡死 | 子任务停住或预算耗尽 | 看 error 里“已落盘产物”，核对后 `dsh_workplan_update` 复核改判或续跑 |
| 待指示（escalated） | 子 Agent 在等主 Agent 决定 | `dsh_workplan_instruct` 下发决定，或确认后置 blocked |
| 取消（cancelled） | 用户撤销 ≠ 完成 | 剩余项仍按未完成处理 |

### 3.3 超时与预算（FTA_SSL 运行参数，兼答 G-31）

默认：子任务单步硬上限 **15 分钟**、整轮预算 **20 分钟**；host 工具超时 > 计划预算（避免竞态）。可按需覆盖的环境变量（均为毫秒）：

```bash
DSH_WORKPLAN_CHILD_TIMEOUT_MS=900000   # 单步上限（默认 15 分钟）
DSH_WORKPLAN_IDLE_TIMEOUT_MS=…         # 子会话空闲超时
DSH_WORKPLAN_TOTAL_TIMEOUT_MS=1200000  # 整轮预算（默认 20 分钟）
```

### 3.4 日志与留痕位置
- 计划与子任务状态、证据块（WORKPLAN_EVIDENCE）持久化在会话记录中，面板只读展示。
- 会话/子会话日志由宿主（DSH harness）管理；插件自身不落独立日志文件、不上报网络。

### 3.5 升级与回滚
- 升级：`npm install -g dsh-workplan@latest`（只维护 latest 版本线，见 SECURITY.md §2）。
- 回滚：`npm install -g dsh-workplan@<旧版本号>`；插件无持久化数据文件，回滚无数据迁移负担。

## 4. 用户须知（诚实边界）
本插件不含鉴别/账户功能，安全前提是宿主环境已鉴别（见 SECURITY-TARGET 假设 A-1）。若宿主被攻破，插件不能提供额外防护。
