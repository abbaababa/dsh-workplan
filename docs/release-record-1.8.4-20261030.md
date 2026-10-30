# 发布记录 — 1.8.4（2026-10-30）

> 每一次发布留一条可复核的时间线：tag、commit、制品哈希、渠道复验命令与输出。

## 制品身份

| 项 | 值 |
|---|---|
| 版本 | 1.8.4 |
| commit | `0c8564c`（`Fix 已结束 shown while dispatch still running (1.8.4)`） |
| tag | `v1.8.4` |
| 本地制品 | `dsh-workplan-1.8.4.tgz`，590051 B |
| sha256 | `3b180810336030740560a8bfb249eb44b809a4fda608bc43ce28a7190e10af1b` |
| GitHub Release | https://github.com/abbaababa/dsh-workplan/releases/tag/v1.8.4 |
| npm | `dsh-workplan@1.8.4`，integrity `sha512-UnFQJPX76vgcx3dMe3/5x1BDTp22mrJd1cEndDP/wKiwOUDZBAu7V3rkACHs5nC6lwMwjixZ4Yx5qMDtVUEWbQ==` |

## 发布前检查（全部通过）

```
$ npm run check                 # tsc --noEmit，无输出即通过
$ npm test                      # ℹ tests 196  ℹ pass 196  ℹ fail 0
$ npm run build && git diff --exit-code -- lib client.js
REPRODUCIBLE: clean
```

## 渠道复验（实际输出）

```
$ npm view dsh-workplan dist-tags --json
[ { "latest": "1.8.4" } ]

$ npm view dsh-workplan@1.8.4 version dist.tarball
version = '1.8.4'
dist.tarball = 'https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-1.8.4.tgz'

$ gh api repos/abbaababa/dsh-workplan/releases/tags/v1.8.4 \
    --jq '.tag_name, (.assets[] | {name, state, size})'
v1.8.4
{"content_type":"application/x-gtar","name":"dsh-workplan-1.8.4.tgz","size":590051,"state":"uploaded"}
```

**未在本机复验的一项**：`curl -sIL` 直连 `release-assets.githubusercontent.com` 在本机
TLS 握手超时（`http=000`），因此「浏览器/包管理器直链下载返回 200」这条只能在网络可达的
机器上确认。Release 侧的资产状态已由 GitHub API 证明为 `uploaded`，大小与本地制品一致
（590051 B）。

## 生效方式

本机 profile 里 `~/.dsh/profiles/web/node_modules/dsh-workplan` 是指向本仓库的软链接，
源码与 `lib/`、`client.js` 已在发布前更新；**运行中的 `dsh web`（PID 27767，18:42:45 启动）
仍在用启动时加载的旧模块**，重启一次才生效：

```bash
# 先停掉当前的 dsh web，再用同一条精确命令拉起（会中断正在运行的会话）
node /Users/open/.npm/_npx/bd325e168b7188a4/node_modules/.bin/dsh \
  --profile web --host 127.0.0.1 --port 3080 \
  --trusted-host openmacbook-pro-1.ts.net --no-open
```

## 发布后离线复验（用事故会话真实日志重算）

```
$ T3_EXPAND=session-b83e4a75-225a-4e78-9bb2-d8cb90078278 \
  node docs/status-audit/t3-render_sidebar_state.mjs \
  ~/.dsh/sessions/--Users-open-Documents-Stocks--/session-b83e4a75-.../session.v4.jsonl.zstd
payload: {"phase":"ended","suspendedPhase":"blocked","inProgress":0,"violations":[]}
expanded: 分步进度 11/15 做好了 总体进度 73% 0 正在做 · 0 还没开始 4 卡住了
badge:    已结束，可续跑 · 卡住了
hint:     对主 Agent 说「续跑这个计划」，会从受阻处继续（已完成的不重跑）（还可续跑 4 次）
```
