# dsh-workplan 3.2.1 发布记录（2026-11-22）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.2.1` |
| 发布提交 | `e274dd767392abdf3bc4f498cbf460465dedbb21` |
| Git tag | `v3.2.1`（tag 对象 `23e1904d7bd813da5d9a013a0c77ebdd9e051a7f`，指向同一提交） |
| 发布分支 | `main` |
| 说明 | 本次同时包含 3.2.0（开工证据免重抄/任务书压缩）与 3.2.1（兄弟可见/依赖自检/终止收编/排队可见） |

## 发布前验证

- 本地 `npx tsc -p tsconfig.json --noEmit`：通过。
- 本地 `npm test`：**1449 例，pass=1448 / fail=0 / cancelled=0 / todo=1，exit 0**；新增 `tests/sibling-visibility.test.ts` 8 例。
- 构建产物可复现：`git add -A` 后重新 `npm run build`，`git status --short` 无新的未暂存差异。
- GitHub Actions `release` run **45017432010**（tag `v3.2.1`）：Build 22/26、Test 22/26、Release 全部 success。
  - https://github.com/abbaababa/dsh-workplan/actions/runs/45017432010

### W5 旧读端探针的边界（如实记录，不冒充 PASS）

- 对 tag `v1.8.19` 旧读端运行 `scripts/w5-cross-version-check.mjs`，在 `oldCancel` 处返回 `NO_PLAN`（`当前会话还没有已生成的计划`）。
- 同一条探针对 `v3.1.7` 运行：六条断言全 PASS，`RESULT: PASS`，退出码 0。
- 定位：3.1.9 起计划消息把完整计划移入 `source.durable`，可见文本 marker 只保留定位字段；1.8.19 读端没有 durable 形态，无法重建新计划，因此不是 3.2.1 的逻辑回归，而是计划消息格式的兼容边界。
- 安全表现：旧读端拒绝（`NO_PLAN`），不会把新计划误当可交付；新版取消/取代信封仍双写旧 marker，旧读端对取消事件的降级路径未被破坏。
- 结论：本探针“旧读端必须重建新计划”的前提已不成立，本次不记为 PASS。若要支持 1.8.19 降级到 3.2.x，需要单独的兼容层或按语义化版本规则做一次大版本声明；不属于 3.2.1 的补丁范围。

## GitHub Release

- 页面：https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.1
- 标题：`v3.2.1 — 兄弟可见与依赖自检版`
- 制品：`dsh-workplan-3.2.1.tgz`
- 大小：`1,987,456` 字节
- sha256：`dcb6515a8381854546585823d4ea2864ef3da0573fb118af12b5738b29b02dea`
- 下载校验：HTTP 200；下载文件 sha256 与上述值一致。

## npm 官方索引源

- 包：`dsh-workplan@3.2.1`
- `latest`：`3.2.1`
- tarball：https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.2.1.tgz
- shasum（SHA-1）：`c258047196d0938189d78a26367f1d53323ef2b2`
- sha256（与 GitHub Release 制品同一份）：`dcb6515a8381854546585823d4ea2864ef3da0573fb118af12b5738b29b02dea`
- 发布时间：`2026-11-22T11:32:31.828Z`
- 安装复验：`npm install dsh-workplan@3.2.1 --prefix /tmp/... --ignore-scripts` 成功，包版本 `3.2.1`。

## 索引源（dsh-plugin-catalog 上游条目）

- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17794
- 变更：仅 `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball` 由 `v3.1.2` 更新为 `v3.2.1`（1 行）。
- 机制：catalog 的 `docs/index.json` 与 npm 包 `dsh-plugin-catalog` 由上游 CI 在 PR 合并后生成；本仓库只负责条目 PR，合并权限在上游维护者。
- 复验（合并后执行）：
  - `npm view dsh-plugin-catalog@latest version`
  - `curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -o '"id":"dsh-workplan"' | head -1`
  - DSH 内 `plugin_market list_plugins(query="dsh-workplan")`

## 备注

- 运行中的 DSH 不会自动加载新代码；需要用户手动重启后在 `dsh_workplan_status` 看到 `v3.2.1`。
- 本次未自行重启任何服务，未执行 `npm unpublish`，未修改上游 catalog 仓库的生成逻辑。
