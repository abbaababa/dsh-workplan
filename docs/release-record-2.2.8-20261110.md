# 发布记录 v2.2.8（2026-11-10）

按 RELEASING.md §6 留档：所有证据可复跑。

## 1. 版本与提交

| 项 | 值 |
|---|---|
| 版本 | 2.2.8（四处一致：package.json / package-lock×2 / src/host.ts:1574 / CHANGELOG 首段） |
| 发布提交 | `70c89f2`（main 已推送） |
| 标签 | `v2.2.8`（已推送） |
| 上承 | v2.2.7（`dc39eeb`，同轮已发布；其 CI 红叉由本版本根因修复取代，见 §3） |

## 2. 渠道与制品

| 渠道 | 结果 | 证据 |
|---|---|---|
| GitHub Release | https://github.com/abbaababa/dsh-workplan/releases/tag/v2.2.8 | 资产 `dsh-workplan-2.2.8.tgz` |
| 制品 sha256 | `3f8c68055fa658f19b45c7e517db3324ea0e672fe1d0cec8b1b9a76457bbde53` | 本地 `shasum -a 256` 与 `gh api .../assets/<id> -H "Accept: application/octet-stream"` 下载流**逐字节一致** |
| npm | `+ dsh-workplan@2.2.8`（账号 open-dsh） | `npm publish /tmp/dsh-workplan-2.2.8.tgz`；`npm view dsh-workplan@latest` 传播期内为 2.2.7，复验命令见 §5 |
| 索引源 | PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13802 | 条目 tarball 已改指 v2.2.8 资产；catalog npm 发版由上游 CI 触发（本仓库权限边界=PR） |

## 3. 本次修复（CI 红叉根因，用户截图圈红的「Release 2.2.6 ✗」）

- 现象：2.2.6（run 42568839758）与 2.2.7（run 42749749361）提交 CI `pass N / fail 0 / cancelled 3 → exit 1` 判红；本地 node 26 全绿（假绿）。
- 根因：`runSubtaskAttempt` 的 `arm()` 对上限计时器 `timer.unref?.()`——裸事件循环进程（node:test / CI node 22）等待竞态期间无存活句柄 → 进程排空 → 用例 `cancelledByParent` → node:test exit 1。
- 修复：`src/runtime.ts` 去除 unref（ref 句柄；收束路径 `finally` 照旧 `clearTimeout`，不悬挂进程）。
- 实证：`70c89f2` 的 CI run **completed success**（node 22 裸循环环境）；本地 699/699、cancelled 0。
- 不可变历史声明：GitHub 提交状态是历史事实，**2.2.6/2.2.7 两个旧提交的红叉无法也不应被改写**；「修复」的语义=根因消除且其后继发布提交转绿。2.2.6 的失败重跑（run 42568839758 rerun）仍为 failure，与根因分析一致（旧提交代码仍含 unref）。

## 4. 发布前检查（RELEASING §1）

- `npm test`：699/699 pass、fail 0、cancelled 0、exit 0。
- W5 跨版本 A/B 探针（R-W5-01，打 tag 前）：`RESULT: PASS`、EXIT=0（六断言全过；旧 lib 取 `git archive v1.8.19`，夹具 `W5_ROOT_LOG=/Users/open/Documents/Stocks/_baseline_work/root/root.jsonl`）。
- 构建可复现：提交后 `npm run build && git diff --exit-code -- lib client.js` = **REPRO_CLEAN**（v2.2.7 与 v2.2.8 两次提交均验）。

## 5. 复验命令

```bash
npm view dsh-workplan@latest version                      # 传播完成后应=2.2.8
gh run list --repo abbaababa/dsh-workplan --commit 70c89f2 # 应 completed success
gh api repos/abbaababa/dsh-workplan/releases/tags/v2.2.8 --jq '.assets[0].size'  # 应=本地 tgz 字节数
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -o '"id":"dsh-workplan"'  # PR 合并+上游发版后命中
```

## 6. 运行态指纹（§6.1，待用户重启后补）

当前进程仍加载旧字节（pid 见会话状态行）。用户手工重启 DSH 后：
① `dsh_workplan_status` 回显指纹；② 磁盘指纹 `printf '%s' "$(cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js)" | shasum -a 256 | cut -c1-16`；两者相同才判「修复已加载」。本节在重启后由主 Agent 补记比对结果。
