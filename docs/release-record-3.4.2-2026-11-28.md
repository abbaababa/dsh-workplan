# dsh-workplan 3.4.2 发布记录（2026-11-28）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.4.2` |
| 发布提交 | `c0581c5d1226c373ada74b5fee7b70eea0ed9ad0`（`main`） |
| Git tag | `v3.4.2`（annotated，tag 对象 `9064868a194cdfae78b214f4e030555882b58c83`，指向同一提交） |
| 运行态构建指纹 | `022379d882df46e2`（`cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js \| shasum -a 256 \| cut -c1-16`） |
| 发布分支 | `main` |
| 说明 | 全流程高质量交付与极致省 Token 治本版（详见 [CHANGELOG.md](../CHANGELOG.md) 与 [release-notes-3.4.2.md](./release-notes-3.4.2.md)） |

## 本地发布前验证（已完成）

- `npm run check`（`tsc -p tsconfig.json --noEmit`）：通过，0 错误。
- `npm test`：**1615 例，pass=1612 / fail=0 / cancelled=0 / todo=3**（`exit=0`，含新增 `tests/workplan-342-quality-token-economy.test.ts`）。
- 提交后可复现校验：`npm run build && test -z "$(git status --porcelain -- lib client.js)"` 通过（`exit=0`），并已清理先前遗留的 `lib/* 2.js` / `lib/* 3.js` 未跟踪副本。
- 版本声明（`package.json`、`package-lock.json`、`src/host.ts`、`CHANGELOG.md`、三语 README、`tests/fixtures/tool-surface.json`）全部为 `3.4.2`（`tests/version-sync.test.ts` 通过）。

## 外部渠道发布状态（已完成并核验）

1. **官方 GitHub 仓库与 Release（`abbaababa/dsh-workplan`）**：
   - 分支 `main`（`c0581c5`）与 tag `v3.4.2` 已推送。
   - GitHub Actions 流水线：`release`（<https://github.com/abbaababa/dsh-workplan/actions/runs/46137575293>）与 `verify` 全部成功。
   - GitHub Release 页面：<https://github.com/abbaababa/dsh-workplan/releases/tag/v3.4.2>
   - 附带 Tarball 资产：`dsh-workplan-3.4.2.tgz`（2,225,295 字节，共 187 个文件，`sha256:598685865d4972d5c7e6ab08ef94d0c5d3145fb958eaa62de67350236710f553`），下载链接 <https://github.com/abbaababa/dsh-workplan/releases/download/v3.4.2/dsh-workplan-3.4.2.tgz> 实测返回 `HTTP 200`。
2. **npm 官方源（`dsh-workplan@3.4.2`）**：
   - 由 GitHub Actions `release.yml`（Run `46137575293`）以 `npm publish --provenance --access public` 发布，附带 SLSA provenance（Sigstore `logIndex=4160619691`）。
   - `npm view dsh-workplan@latest version` → `3.4.2`
   - `dist.tarball` → `https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.4.2.tgz`
   - `dist.shasum` → `d91b98df872cde9d45cf05955192108d4657245b`
   - `dist.integrity` → `sha512-tqC6rOEh2XAb2u7rcIiC3CGuNEbMSrA2DuCVLpvF0YOhYRFuWAPx0scmjHhauFm+2WuD5OnX+LGSfTaV1E+x2w==`
3. **官方索引源与 DSH 插件市场（`awesome-dsh-plugin` / `dsh-plugin-catalog`）**：
   - 已向官方索引仓 `awesome-dsh-plugin/awesome-dsh-plugin` 提交 PR [#19583](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/19583)（仅更新 `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball:` 为 `v3.4.2` 资产链接，状态 `OPEN / MERGEABLE`）。
   - 当前已发布的 `dsh-plugin-catalog@2026.1128.28846` 仍停留在 `3.4.1`（发布时间早于 `3.4.2`），待上游自动轮询 npm `dist-tags.latest=3.4.2` 并合并 PR #19583 后自动同步至 DSH 插件市场前端。
4. **本机 DSH 运行环境（`~/.dsh/profiles/web`）**：
   - 已核验 `~/.dsh/profiles/web/package.json` 与 `~/.dsh/profiles/web/pnpm-workspace.yaml` 均指向 `link:/Users/open/Documents/Stocks/dsh-workplan`，`/Users/open/.dsh/profiles/web/node_modules/dsh-workplan/package.json` 解析为 `3.4.2`。用户手动重启一次 DSH Web 即可运行最新版（若之前仍显示 `3.4.1`，需确认完全退出旧进程后重启）。
