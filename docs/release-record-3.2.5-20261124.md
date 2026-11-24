# dsh-workplan 3.2.5 发布记录（2026-11-24）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.2.5` |
| 发布提交 | `226b3679a091ed7b914481b0c192aca76a75917d` |
| Git tag | `v3.2.5`（tag 对象 `d59d7f965c6050919e7a6a0a3fd0c5dc1b7fcb48`，指向同一提交） |
| 发布分支 | `main` |
| 构建指纹 | `f50f5d236f84fb66` |
| 说明 | 3.2.3 + 3.2.4 + 3.2.5 一次性合并发布；注意力红线对齐（唯一信息零丢失），只删逐字重复 / 死代码 / 模型不可见内容 |

发布范围事实：3.2.3、3.2.4 从未单独提交或发布——远端 tag 止于 `v3.2.2`，npm `latest` 为 `3.2.2`，仓库无对应提交；其改动只以未提交工作区存在。按用户 2026-11-24 裁决（A 方案）合并为 3.2.5 一次发布，CHANGELOG 已如实记载。

## 发布前验证

- `npm run build`（tsc 类型检查 + 产出 lib/ 与 client.js）：通过；连续两次构建指纹均为 `f50f5d236f84fb66`（`cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16`），与提交的构建产物一致，工作区无 `src/`、`lib/` 漂移。
- `npm test`：**1514 例，pass=1513 / fail=0 / cancelled=0 / todo=1，exit=0**。
- 版本一致性：`package.json`、`package-lock.json`（两处）、`PLUGIN_VERSION`、`meta.version`、三份 README 徽章/安装命令、`tests/fixtures/tool-surface.json` 均为 `3.2.5`。
- 安全扫描（npm tarball 解包）：161 文件 / 约 6.2 MB，凭证模式（AWS key / GitHub token / 私钥 / Slack token / `sk-`）0 命中；`LICENSE` 为 MIT 全文。
- 首轮 CI（tag `v3.2.5`，运行 `45333607979`）：Node 22 的 Test job 失败——`tests/workplan-unparsable-retry.test.ts` 的 W2-a / W2-b 两个子测试写在父用例回调内，Node 22 取消未 await 的子测试（`test did not finish before its parent and was cancelled`）；本机 Node 为 v26.9.0，故本地未复现。修复：把两个子测试提升为顶层用例（提交 `226b367`），`npx tsc -p tsconfig.test.json` 通过，单文件 6 例全过。
- 修复后 CI（tag `v3.2.5`，运行 `45334519374`）：Build 22/26、Test 22/26、Release 全部 success。

## GitHub Release

- 页面：https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.5
- 标题：`v3.2.5 — 注意力红线对齐版`
- 正文：`docs/release-notes-3.2.5.md`（已回填全部发布证据）
- 制品：`dsh-workplan-3.2.5.tgz`
- 大小：`2,062,293` 字节
- sha256：`71166781dbdf7092a5944cf22bddbfd31a20219f38f282707b3b18655d705f9b`
- 下载校验：`gh release download v3.2.5 -R abbaababa/dsh-workplan` 取得文件大小与 sha256 均与上述值一致。
- 注：浏览器直连 `releases/download` 的 `curl` 在本机会话超时（CDN 不可达），改用 `gh release download` 走 API 复核成功；这是本机网络路径差异，不是制品问题。

## npm

- 包与版本：`dsh-workplan@3.2.5`（`dist-tags.latest = 3.2.5`）
- 发布时间：`2026-11-24T05:41:26.485Z`
- tarball：https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.2.5.tgz
- sha1：`9ac73385772c4814e3e5616cbc3f59ef586b84b5`（下载复核一致）
- 大小：`2,062,293` 字节；161 文件
- 发布方式：tag 触发的 GitHub Actions Release job，`npm publish --provenance`（透明日志 `https://search.sigstore.dev/?logIndex=4070239801`）
- 镜像提示：中国大陆 npm 镜像可能滞后于上游 `latest`，安装前以 `registry.npmjs.org` 的 `dist-tags.latest` 与可下载的 `dist.tarball` 为准。

## 索引源 / 插件市场

- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18401
- 分支：`abbaababa:awesome-dsh-plugin:dsh-workplan-3.2.5`，仅改 `data/plugins/abbaababa__dsh-workplan.yml`
- 改动：`tarball` v3.2.2 → v3.2.5；描述工具数 11 → 14（`hold` / `release` / `followup` 此前已注册但未写入文档）
- 状态：以 PR 页面与 `Submission gate` 检查为准；合并后上游 CI 重建 `dsh-plugin-catalog`，经 jsDelivr 分发。

## 运行态

- 本会话所在的 Web profile **未加载** dsh-workplan（`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 不含它，`cordis.patch.yml` 无对应插入，`/dsh-workplan/*` 路由 404），因此无法在本 GUI 内用 `dsh_workplan_status` 自报 `v3.2.5`。
- headless profile 已包含该 bundle；升级后需用户**手动重启** DSH（或在插件管理里禁用再启用）才会加载新代码。重启后新会话调用 `dsh_workplan_status` 应显示 `v3.2.5`。

## 隐私与写入范围

- `~/.dsh/workplan/journal/`、`~/.dsh/workplan/lessons.jsonl`、`~/.dsh/workplan/notices.jsonl`（可用环境变量改路径；0o600 文件 / 0o700 目录，拒绝符号链接）。
- 工作目录下 `reports/`：`wp-start-evidence-<planId>-<subtask>.md`（插件写）与 `wp-settlement-<planId>-<subtask>.json`（任务书要求模型写的结算备份）。
- 本次发布未新增任何写入位置；未提交 `reports/`、临时探针脚本、`dist-tests/` 等本地产物。
