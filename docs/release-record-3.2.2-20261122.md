# dsh-workplan 3.2.2 发布记录（2026-11-22）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.2.2` |
| 发布提交 | `6a445940277cd44f00d741916aa32d17f7fe32ed` |
| Git tag | `v3.2.2`（tag 对象 `6ade7004857b237a20ee09d4344d0b0a40a2f981`，指向同一提交） |
| 发布分支 | `main` |
| 构建指纹 | `671153c0b0afcc98` |
| 说明 | 省 token 与一致性修复版；基线 3.2.1，不含破坏性契约变更 |

## 发布前验证

- `npx tsc -p tsconfig.json --noEmit`：通过。
- `npm test`：**pass=1454 / fail=0 / cancelled=0 / todo=1（共 1455 例）**，exit=0。
- 构建可复现：连续两次 `npm run build` 后，四入口文件指纹均为 `671153c0b0afcc98`；GitHub Actions 的 `Build (22)` / `Build (26)` 均通过。
- 版本一致性：`package.json`、`package-lock.json`（两处）、`PLUGIN_VERSION`、`meta.version`、README、`tests/fixtures/tool-surface.json` 全部为 `3.2.2`。
- 安全扫描：真实 tarball 157 文件/6,004,925 B，凭证模式 0 命中；`LICENSE` 为 MIT 全文；未新增敏感文件。
- GitHub Actions tag 运行 `45024819371`（tag `v3.2.2`）：Build 22/26、Test 22/26、Release 全部 success。

### W5 旧读端探针的边界（如实记录，不冒充 PASS）

- 对 tag `v1.8.19` 与 `v3.1.7` 的旧 `lib/` 运行 `scripts/w5-cross-version-check.mjs`，均在 `oldCancel` 处返回 `NO_PLAN`（`当前会话还没有已生成的计划`），EXIT=1。
- 原因与 3.2.1 发布记录所述一致：3.1.9 起计划消息把完整计划移入 `source.durable`，旧读端没有该形态，无法重建新计划；这是格式兼容边界，不是 3.2.2 的逻辑回归。
- 新版路径的 W5-1..W5-5 用例（旧取消信封、present/dispatch 门禁、生产写路径、superseded 降级）在 `npm test` 中全绿。
- 结论：本探针不记为 PASS；未因该历史探针阻断本次发布，后续若要支持 1.8.19 读 3.2.x，需单独兼容层或大版本声明。

## GitHub Release

- 页面：https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.2
- 标题：`v3.2.2 — 省 token 与一致性修复版`
- 正文：已用 T4 定稿替换早期草稿（见 `reports/release-notes-3.2.2-T4.md` §一）。
- 制品：`dsh-workplan-3.2.2.tgz`
- 大小：`2,000,442` 字节
- sha256：`a201f7692c66f61a80d64d592433923ca7f456f51cddef1d31f3358e1e633229`
- 下载校验：HTTP 200；下载文件大小与 sha256 与上述值一致。
- 说明：tag 触发的 release job 以 `--clobber` 上传了 CI 构建制品，覆盖了本地首次上传的同名资产；最终以 CI 制品为准。

## npm 官方索引源

- 包：`dsh-workplan@3.2.2`
- `latest`：`3.2.2`
- tarball：https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.2.2.tgz
- shasum（SHA-1）：`302d92bc56cd5cdad6b4cafa91f43a4cd341f34a`
- sha256（与 GitHub Release 制品同一份）：`a201f7692c66f61a80d64d592433923ca7f456f51cddef1d31f3358e1e633229`
- 发布时间：`2026-11-22T13:02:33.146Z`
- 发布方式：tag 触发的 GitHub Actions `Release` job（run `45024819371`）执行 `npm publish --provenance --access public`。
- 安装复验：`npm install dsh-workplan@3.2.2 --prefix /tmp/dsh-install-322 --ignore-scripts` 成功，包版本 `3.2.2`。

## 索引源（dsh-plugin-catalog 上游条目）

- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17810
- 分支：`abbaababa:update-dsh-workplan-3.2.2-210525`
- 变更：仅 `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball` 由 `v3.1.2` 更新为 `v3.2.2`（1 行）。
- 上游基线：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `main` 提交 `d9701b3a5f12beae2abca839315e48a16176edc2`。
- 状态：PR 已提交，合并权限在上游维护者；catalog 的 `docs/index.json` 与 npm 包 `dsh-plugin-catalog` 由上游 CI 在 PR 合并后生成。
- 复验（合并后执行）：
  - `npm view dsh-plugin-catalog@latest version`
  - `curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -o '"id":"dsh-workplan"' | head -1`
  - DSH 内 `plugin_market list_plugins(query="dsh-workplan")`

## 生效方式

- 已运行的 DSH 不会自动加载新代码；请手动重启 DSH（或在插件管理里禁用再启用）。
- 重启后在新会话调用 `dsh_workplan_status`，应显示 `v3.2.2` 与 `build 671153c0b0afcc98`。
- 本次未自行重启任何服务，未执行 `npm unpublish`，未修改上游 catalog 生成逻辑。
