# dsh-workplan 3.3.1 发布记录（2026-11-26）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.3.1` |
| 发布提交 | `0af71fd38a7da3f953dfcaefce2be05ca9b6ef46`（`main`） |
| Git tag | `v3.3.1`（annotated，指向同一提交） |
| 发布分支 | `main` |
| 运行态构建指纹（`lib/*.js` 不含 `client.js`） | 以 `dsh_workplan_status` 冷启动后显示为准 |
| 说明 | 全流程防偏离锚定 + 阶段裁剪极致省 Token 版（详见 `CHANGELOG.md` 3.3.1 段） |

## 本地发布前验证（已完成）

- `npm run check`（`tsc --noEmit`）：通过，0 错误。
- `npm run build`：通过；`lib/` 与 `client.js` 与 3.3.1 分发包逐字节一致（`diff -rq lib dist` 为空、`cmp client.js` 一致），证明该源码正是 3.3.1 制品的来源。
- `npm test`：**1553 例，pass=1552 / fail=0 / cancelled=0 / todo=3**。
- 版本一致性：`package.json`、`package-lock.json`（两处）、`src/host.ts` 的 `PLUGIN_VERSION` / `meta.version`、`CHANGELOG.md`、三份 README、`tests/fixtures/tool-surface.json` 均为 `3.3.1`；`git status --porcelain -- lib client.js` 为空。

## 源码恢复说明（如实记录）

3.3.1 在仓库中原本只有 npm 分发包、没有对应源码提交。本次以「3.3.0 完整仓库快照 + 3.3.1 分发包覆盖 + 构建复现校验」重建源码：构建产物与分发包逐字节一致后才提交发布；同时补齐了分发包未包含的 `tests/`、`package-lock.json`，把测试中硬编码的 `3.3.0` 断言升至 `3.3.1`，并修正 `CHANGELOG` 中两处与事实不符的表述（“新增 7 项测试”“server.mjs 同步”）。`docs/release-record-3.2.9-20261125.md` 中 3.3.0 快照误覆盖的冷启动复验证据已恢复。

## 外部渠道发布状态（已完成并核验）

1. **GitHub 源码 / Tag / Release（`abbaababa/dsh-workplan`）**：`main` 与 `v3.3.1` 已推送；`release.yml` 运行 45802901946 全部成功（Build 22/26、Test 22/26、Release）。Release 页面：<https://github.com/abbaababa/dsh-workplan/releases/tag/v3.3.1>，正文取 `docs/release-notes-3.3.1.md`，资产 `dsh-workplan-3.3.1.tgz` 大小 2,114,608 字节、sha256 `27d5cf460551cc1016cce3ec3a51372bc432bd5700ec247e5e97409636e64382`。
2. **npm 官方索引源（`dsh-workplan@3.3.1`）**：由同一 `release.yml` 的 `npm publish --provenance --access public` 发布，日志含 Sigstore 透明度日志记录；`registry.npmjs.org` 上 `dist-tags.latest=3.3.1`。npm tarball 下载后 sha256 与 GitHub Release 资产完全相同（`27d5cf46…`），integrity `sha512-lWlWZ7W/Q9GAbFd0XoRamtUGKOVByB8ODxZlmJldvmXGZHdi7dRGtCnhmG3ZRlNY6rFYZnsYiq/MAGR41Y+pcw==`。
3. **索引源（`awesome-dsh-plugin/awesome-dsh-plugin`）**：已提交 PR <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/19062>，仅改 `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball` 指向 v3.3.1（`+1/-1`，mergeable）。该仓库由维护者合并，合并后其 CI 重新生成 README / `docs/index.json`。
4. **DSH 插件市场**：市场以索引仓库的 `docs/index.json` 为数据源，`docs/index.json` 的版本来自对 npm 的探测（`data/npm-map.json`），没有独立于索引源的提交入口。npm 已是 3.3.1、索引入口已指向 v3.3.1，等维护者合并 PR 后市场自动同步到 3.3.1。

## 发布后的验收口径

- 安装/升级：`dsh plugin --profile web add dsh-workplan@3.3.1`，然后手动重启 DSH。
- `dsh_workplan_status` 应显示 `v3.3.1` 与新的 build 指纹。
- 观察点：阶段 0 任务书含原要求锚点；专家执行期工具面不含 `dsh_workplan_delegate`；部门主管规划期工具面不含 `dsh_workplan_verify` / `dsh_workplan_instruct`。

## 隐私与写入范围

- 发布过程只写入：本仓库（`src/`、`lib/`、`client.js`、`tests/`、`docs/`、`package.json`、`package-lock.json`、README、CHANGELOG）、GitHub 远端（`main`、`v3.3.1`、Release）、npm 官方源、`awesome-dsh-plugin` 的 fork 分支与 PR。
- 未改用户 profile 配置；未重启任何服务。
