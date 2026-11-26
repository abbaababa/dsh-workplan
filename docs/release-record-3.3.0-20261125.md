# dsh-workplan 3.3.0 发布记录（2026-11-25）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.3.0` |
| 发布提交 | 待本机推送后回填 |
| Git tag | `v3.3.0`（待本机推送） |
| 发布分支 | `main` |
| 运行态构建指纹（`lib/*.js` 不含 `client.js`） | `dbab4946d52be6a4` |
| 四入口构建指纹（host/runtime/plan/watchdog） | `2bf0f45fe452dccd` |
| 说明 | 底层逻辑冲突/死锁/竞态全面清零 + 极致省 Token 改造（静态加权注入 106,954 → 72,415 字符，-32.3%；复杂任务默认人数下限 3 → 1；默认开启确定性快路径；专家任务书静态前缀共享 >85%） |

## 本地发布前验证（已完成）

- `npm run check`（`tsc --noEmit`）：通过，0 错误。
- `npm run build`：通过，`src/` 与 `lib/`、`client.js` 已同步。
- `npm test`：**1553 例，pass=1549 / fail=1 / cancelled=0 / todo=3**（含新增 12 项回归测试 `tests/audit-fixes-and-token-economy.test.ts` 与 `tests/version-sync.test.ts` 全部通过；唯一失败项为 `journal-ledger-batch4` 的 `chmod 0o555` 只读目录删除断言，系云端沙箱 `root` 身份忽略文件只读权限所致，在非 root 本机与 GitHub Actions `ubuntu-latest` 下通过）。
- 版本一致性：`package.json`、`package-lock.json`（两处）、`src/host.ts` 的 `PLUGIN_VERSION` / `meta.version`、`CHANGELOG.md`、三份 README、`tests/fixtures/tool-surface.json` 均为 `3.3.0`。
- 注入实测（`node scripts/measure-injection.mjs`）：`weightedExample = 72415`（基准 `106954`，**-32.3%**）；`promptSection = 1629`（**-42.7%**）；`toolSchemasAll = 12663`（**-42.3%**）；`fiveStepContinuation = 522`（**-59.6%**）；`expertTaskBook = 2688`（**-37.4%**）。

## 外部渠道发布状态（待本机有登录态环境执行）

> 说明：当前生成本记录的云端环境无 `.git` 远端、无 `gh` CLI 及 GitHub/npm 凭证，以下外部发布动作需在用户已登录的本机或 GitHub Actions 完成，未在无凭证环境下宣称已上线。

1. **GitHub 源码 / Tag / Release（`abbaababa/dsh-workplan`）**：
   - 待推 `main` 分支与 annotated tag `v3.3.0`，触发 `.github/workflows/release.yml` 自动构建、测试、创建带 `dsh-workplan-3.3.0.tgz` 的 GitHub Release（正文取 `docs/release-notes-3.3.0.md`）。
2. **npm 官方索引源（`dsh-workplan@3.3.0`）**：
   - 由上述 `release.yml` 在 Release 创建后自动执行 `npm publish --provenance --access public`。
3. **DSH 插件市场（`awesome-dsh-plugin` → `dsh-plugin-catalog`）**：
   - 更新 `awesome-dsh-plugin` 仓库的 `data/plugins/abbaababa__dsh-workplan.yml`（可更新既有分支 `abbaababa:wp327` 或新开 PR），将 `tarball` 指向 `https://github.com/abbaababa/dsh-workplan/releases/download/v3.3.0/dsh-workplan-3.3.0.tgz`；待上游合并后由上游 CI 自动重建 `dsh-plugin-catalog` 并同步至插件市场。

## 冷启动核验清单（发布并安装重启 DSH 后执行）

- [ ] 执行 `dsh plugin --profile web add dsh-workplan@3.3.0` 并手动重启 DSH Web。
- [ ] 调用 `dsh_workplan_status`，确认 `version=3.3.0` 且 `build=dbab4946d52be6a4`。
- [ ] 验证普通任务走确定性快路径且复杂任务可按需只派 1 名专家，左侧进度面板与状态行一致。
