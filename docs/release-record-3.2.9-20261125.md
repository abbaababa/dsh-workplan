# dsh-workplan 3.2.9 发布记录（2026-11-25）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.2.9` |
| 发布提交 | `d28da557b0d9eca07af27075bbf012d61e159742` |
| Git tag | `v3.2.9`（annotated tag 对象 `bf3b143ac9d79b5fa53b59fde78f7a752f37ea3e`，指向发布提交） |
| 发布分支 | `main` |
| 构建指纹 | `707c53497fd7b3d5` |
| 说明 | 五项上下文优化：执行通道判定、子代理上下文隔离、RCR、Latent Brief/供应商缓存计量的插件级等价实现、ASTC 式硬/软信息压缩；第 4/5 项不是模型内 KV/soft token，字面实现见 `docs/literal-kv-astc-kernel-design.md`（状态：未实现） |

## 发布前验证

- `npm run check`（`tsc --noEmit`）：通过。
- `npm test`：**1541 例，pass=1540 / fail=0 / cancelled=0 / todo=1，exit=0**；其中新增 5 个测试文件（context-strategy、context-router、context-brief、cache-meter、workplan-context-329）。
- `npm run build`：通过；`src/` 与 `lib/`、`client.js` 同步；发布提交后 `git status --porcelain -- lib client.js` 为空。
- 版本一致性：`package.json`、`package-lock.json`（两处）、`src/host.ts` 的 `PLUGIN_VERSION` / `meta.version`、`CHANGELOG.md`、README 三份、`tests/fixtures/tool-surface.json` 均为 `3.2.9`。
- 只读审计：上下文/提示词、runtime/缓存计量、版本/发布三路审计发现的 P0/P1/P2 问题已逐条修复；发布前审计结论见本节提交历史与 `docs/context-optimization-3.2.9.md`。

## GitHub Release

- 页面：https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.9
- 标题：`v3.2.9`
- 正文：`docs/release-notes-3.2.9.md`（release.yml 已改为优先 `--notes-file`）
- 制品：`dsh-workplan-3.2.9.tgz`
- 大小：`2,152,266` 字节
- sha256：`805bcb227ee30768688480281a814d0c8845497a44123780cf5af9ca878b7d37`
- 下载校验：`curl -fsSL` 下载得到的大小与 sha256 均与上述值一致。

## npm

- 包与版本：`dsh-workplan@3.2.9`（`dist-tags.latest = 3.2.9`）
- 发布时间：`2026-11-25T04:42:17.368Z`（CI 发布日志时间；npm 处理有数分钟延迟）
- tarball：https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.2.9.tgz
- sha1：`75612e22504faa4de50f1a1f5a933630e662748a`
- 文件数：`178`；解包大小：`6,401,155` 字节
- 完整性：`sha512-sh06h6sMObglpECXSAZebfhP72Mjog8plqVD5d7w6lMi5mZInavScDw4dFf9ykYFlT7tQUMgwGh3M+yTwd1Nkg==`
- 发布方式：tag 触发的 GitHub Actions Release job，`npm publish --provenance --access public`；透明日志见 CI 日志中的 sigstore 链接。

## CI

- Release 运行：`45547754703`（tag `v3.2.9`）
  - Build (Node 22)：11s，success
  - Build (Node 26)：13s，success
  - Test (Node 22)：1m38s，success
  - Test (Node 26)：1m37s，success
  - Release：18s，success（校验 tag/版本 → 构建 → 打包 → GitHub Release → npm publish）
- main 分支 verify 运行：`45547744376`，success。

## 索引源 / 插件市场

- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18582
- 分支：`abbaababa:wp327`，head `9f9673119d6f446ebce692fdef0c8180a3ce284d`
- 基于：`upstream/main` `ea97dfefbf02bfa82ab8fc20ee1f666c705b39a8`
- 改动：仅 `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball`，从 `v3.2.6` 改为 `v3.2.9`；description 保留 14 tools 口径。
- PR 状态（2026-11-25 12:47 +08:00）：`OPEN`，`mergeable=MERGEABLE`，`mergeStateStatus=UNSTABLE`，`PR check` 仍在运行（Build 步骤耗时较长）；以 PR 页面最终检查结果为准。
- 当前账号对 `awesome-dsh-plugin` 仓库权限为只读（`push=false`），无法自行合并；合并由上游维护者完成。
- 合并后刷新链路：`sync-readme` → `build-site`（`docs/index.json` 较快更新）→ `dsh-plugin-catalog` npm 包（仅每日 02:23 UTC 或手动 `workflow_dispatch`）→ jsDelivr + DSH `pluginMarket` 缓存（约 10 分钟）。
- 因此截至本记录，DSH 市场索引尚未显示 3.2.9；这是上游合并/重建链路的预期延迟，不是本插件发布失败。

## 运行态

- 发布后按用户确认，把 `dsh-workplan` 加入了 Web profile 的 `dsh.profile.bundles`（`~/.dsh/profiles/web/package.json`，改前已备份为 `package.json.bak-<时间戳>`）；插件依赖仍指向源码目录的软链接。
- 加入后本会话已实际加载插件，`dsh_workplan_status` 返回：`v3.2.9｜build 72a75c57eab069ba｜pid 88664｜启动 2026/11/25 11:52:20`，工具 `dsh_workplan_*` 已出现在模型工具面。
- 运行态 build 指纹算法是「`lib/` 下除 `client.js` 外全部 `.js` 排序后逐个入哈希」；按同一算法对磁盘计算得到 `72a75c57eab069ba`，与运行态一致。注意：`cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16` 只覆盖 4 个文件，得到 `707c53497fd7b3d5`，不是运行态 build 值；两者不可混用。
- 仍建议用户手动重启一次 DSH，用冷启动再确认 profile 组成、左侧进度面板与 `status` 三处一致；禁止由代理自行重启。重启后 `dsh_workplan_status` 应继续显示 `v3.2.9` 与 `build 72a75c57eab069ba`（除非又改了源码并重新构建）。

## 隐私与写入范围

- `~/.dsh/workplan/journal/`、`~/.dsh/workplan/lessons.jsonl`、`~/.dsh/workplan/notices.jsonl`（可用环境变量改路径；0o600 文件 / 0o700 目录，拒绝符号链接）。
- 工作目录下 `reports/`：`wp-start-evidence-<planId>-<subtask>.md`（插件写）与 `wp-settlement-<planId>-<subtask>.json`（任务书要求模型写的结算备份）。
- 本次发布未新增写入位置；未提交 `reports/`、临时探针脚本、`dist-tests/` 等本地产物。
