# 发布记录 3.1.2 — 2026-11-19

## 发布物

- **Git tag**: `v3.1.2` → commit `474adac`（main，"Release 3.1.2: 「用户认可后插件不再运行」死锁治本"）
- **GitHub Release**: https://github.com/abbaababa/dsh-workplan/releases/tag/v3.1.2
  - 资产 `dsh-workplan-3.1.2.tgz`；资产 URL `curl -sIL` 实测 HTTP 200（后台复核 job 完成）
  - 本地干净构建（clone tag → `npm ci` → `npm run build` → `npm pack`）sha256：
    `9f6df2681afffb0caf0528ce319c26c98dd876df0fcefb96309f25c33d2a9092`
  - CI 制品与本地制品 sha1 不同（`14ba2c82…` vs `887b9662…`，gzip 头差异）；
    已下载 npm 包解包核实：lib/host.js 含 `3.1.2`、lib/runtime.js 含 `lastHumanText` ×9、
    `userConfirmed = true` ×2 —— **npm 上的 3.1.2 确含本次修复**。
- **npm**: https://www.npmjs.com/package/dsh-workplan/v/3.1.2
  - `dist.shasum = 14ba2c8285e16e8fa1f0fa4efd58f53cae1295fd`（sha1）
  - `dist.tarball = https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.1.2.tgz`
  - `npm view dsh-workplan@latest version` → `3.1.2` ✅
  - 发布时间 `2026-11-19T15:20:26.212Z`（发布 CI 自动发布，无需人工 npm publish）

## CI 证据（红叉禁止 → 全部 success）

| 运行 | workflow | 触发 | run id | 结论 |
|---|---|---|---|---|
| release (tag v3.1.2) | release.yml | tag push | 44552444490 | success（2m22s，15:13:58Z；Release 自动创建 + npm publish） |
| release (main) | release.yml | main push | 44552431554 | success（1m49s，15:13:53Z） |

## 本版本变更（3.1.1 → 3.1.2）：「用户认可后插件不再运行」死锁治本

**事故（2026-11-19 晚，本会话 session-74fc8103 实测）**：用户对任务回复「认可」，插件毫无反应、
任务分解反复重启且永不落地（notices.jsonl 仅 2 条记录；四次后台分解无一存活）。前会话
session-378ab7a6 同型任务同因流产（21:11 被用户取消）。

**根因（源码级）**：消息分类双口径自相矛盾——`onInboxInserted` 用单条消息判断（能认出「认可」），
`onPreStep` 确认路由（runtime.ts:11280）与取代逻辑（11351-11368）用全量拼接文本
`taskTextFromMessages`（runtime.ts:670-677）判断，单条确认被原始任务文本淹没。死锁链：确认
消息走真实任务路径 → 杀死在途后台分解 → 认可闸门（approval-gate.ts:39-68）等不到确认 → 循环。

**修复三件套（src/runtime.ts，注释标记 [3.1.2]）**：
1. 收件箱认出确认即当场 `planning.userConfirmed = true` 盖章并回复用户（runtime.ts:10264-10284）；
2. 确认路由触发条件改用最新单条人类消息 `lastHumanText`；
3. 取代逻辑新增单条豁免（寒暄/空泛续跑/状态提问/确认不杀在途规划）。

## 发布前检查（RELEASING.md §4）

- `npm run check` ✅ 0 错误
- `npm test` ✅ **1358 全过 0 失败**（新增 3.1.2 死锁复演测试 5 例；版本断言四处随定版升级：
  README×3 badge/安装命令、tests/workplan-250-head-delegation.test.ts、
  tests/workplan-v3-contract.test.ts、tests/fixtures/tool-surface.json）
- `lib/host.js` 含 `version: '3.1.2'` ✅
- W5 跨版本探针 `RESULT: PASS`（六断言全过；v1.8.19 基线 lib + 夹具 root.jsonl）

## §6.1 运行态指纹 = 磁盘指纹

- 磁盘指纹：`cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16`
  → `7384cb5353f49ffb`
- 运行态指纹：**无法在本会话内自报**（root agent 工具表无 dsh_workplan_status；lessons.jsonl
  留档的 `build e8cfc1f46865652b` 为更早轮次记录）。
- 状态说明：用户上次手动重启（m00172）早于版本定版，运行态加载的 host.js 为 meta 3.1.1 字节；
  **修复代码 runtime.js 自重启后零改动、已在运行**（修复构建早于重启）。仅版本号显示 3.1.1，
  需用户再手动重启一次 DSH 使运行态 meta 同步为 3.1.2（按规则禁止 agent 自行重启，已告知用户）。
- 符号链接旁证：`~/.dsh/profiles/{web,headless}/node_modules/dsh-workplan` 均指向
  `/Users/open/Documents/Stocks/plugins/dsh-workplan`，磁盘 meta 已 `3.1.2`。

## 索引源（catalog）

- 官方仓库条目 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17024
  （分支 `dsh-workplan-3.1.2`，条目 tarball v3.0.3 → v3.1.2，一次到位含 3.1.1 中间变更；
  基分支 upstream/main，提交 `fe7f1b2`）
- 上游合并前 jsDelivr catalog 中 workplan 条目仍为旧版本，属预期（合并后 CI 自动重建）。

## 复验命令（下次排障直接用）

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
git log --oneline -1 && git tag -l v3.1.2
npm view dsh-workplan@3.1.2 version dist.shasum --cache /tmp/npm-cache-fresh
cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16
curl -sIL -o /dev/null -w '%{http_code}' \
  https://github.com/abbaababa/dsh-workplan/releases/download/v3.1.2/dsh-workplan-3.1.2.tgz
gh pr view 17024 --repo awesome-dsh-plugin/awesome-dsh-plugin --json state -q .state
```
