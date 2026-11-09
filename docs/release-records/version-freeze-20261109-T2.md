# 版本与变更基准冻结清单（T2 · 2026-11-09）

采集时刻：2026-11-09T13:08+08:00；仓库：`/Users/open/Documents/Stocks/plugins/dsh-workplan`（`git rev-parse --show-toplevel` 确认为仓库根）。

## 1. 版本号三处对照（A1）

| 口径 | 结果 | 证据 |
|---|---|---|
| package.json `version` | **2.2.6** | `node -e require('./package.json')` → `dsh-workplan@2.2.6` |
| 构建产物/源码标记 | **2.2.6** | `src/host.ts:1574` `version: '2.2.6'`；`[2.2.6]` 标记 src 12 处（plan.ts 8 / runtime.ts 3 / understanding.ts 1），lib 对应 plan.js 8 / runtime.js 3 / understanding.js 1，一一对应 |
| 索引源 & npm 已发布版本 | **2.1.5** | 插件目录索引 `dsh-plugin-catalog/index.json`（unpkg 拉取，目录版本 2026.1109.17642）中 dsh-workplan 仅登记 versions=[2.1.5]；npm registry dist-tags.latest=2.1.5 |
| CHANGELOG 顶部条目 | 2.2.6 — 2026-11-08 | `head CHANGELOG.md` |

**冻结结论：本次发布的「最新版本」= 2.2.6**。已发布基准为 2.1.5（tag v2.1.5，commit 6ed12d3），2.1.5 之后全部 2.2.x 内容目前只存在于**未提交的工作区**。

## 2. Git 基线与未提交变更（A2）

- 分支 `main`，HEAD `6ed12d32af03d22d5024eb1d9fbb1c20a7546781`（= tag v2.1.5 = 已发布基准）。
- 未提交变更：**30 个已跟踪文件修改 + 23 个未跟踪新文件**，含全部 2.2.x 源码（src/ 与 lib/ 10 组）、CHANGELOG.md、package.json/package-lock.json、13 个新测试、`release.sh`、`docs/release-records/*`、`src/notice-channel.ts` 等。
- **判定：包含**。版本号 2.2.6 只存在于未提交变更中，不提交则「发布 2.2.6」无从谈起——发布前必须先把这些变更作为 2.2.6 提交（该提交由发布脚本/T4-T5 执行，本清单已将其显式纳入范围，无静默纳入）。
- 构建产物新鲜度：T2 已执行 `npm run build`，build 后 lib/ 与当前 src 同源（编译成功、产物含 2.2.6 标记）；发布脚本构建步骤再次构建即可保持同源。
- 遗留杂物：未跟踪 `dist-tests-t4/`、`handoff-need-serialization.test.ts`（根目录散件，tests/ 下已有同名）建议发布提交时不纳入或清理，由主 Agent 决定。

## 3. 敏感信息初筛（A3）

- 密钥类模式（sk-/ghp_/AKIA/api_key/password/token 硬编码）扫描变更范围内文件：**0 命中 → 通过**。
- 本地绝对路径 `/Users/open`：4 处命中——`CHANGELOG.md:138/180/2233`、`RELEASING.md:61`、`docs/release-records/release-steps-20261106.md:3`、`release.sh:271`（含 W5_ROOT_LOG 默认值）。均为机器路径/日志路径，**非凭证**，泄露面为「暴露本机用户目录结构」，风险低。结论：**通过，附发现项**——建议 T3/T4 在发布文案与脚本中把 `/Users/open/...` 改写为相对路径或 `$(pwd)` 占位；若不处理亦可接受（公开仓库历史中已有同类）。
- 远端：`origin = git@github.com:abbaababa/dsh-workplan.git`（SSH），与索引源登记的 `github.com/abbaababa/dsh-workplan` 一致。

## 4. 待发布内容清单（冻结范围）

以「发布提交 = 当前工作区全部变更（30 修改 + 22 有效新文件，剔除 §2 杂物 2 项）」为冻结范围，版本号 2.2.6，构建产物 lib/ + client.js 由发布脚本构建步骤生成。凭证与推送执行属 T1/T4/T5 结论，本清单不预设。

## 5. 待确认项（移交）

- 索引源提交协议（catalog 是第三方聚合索引，登记机制/是否需 PR 或自动同步 npm）→ T1/T6 结论。
- GitHub 凭证可用性（SSH key / gh CLI / token）→ T1 核查。
