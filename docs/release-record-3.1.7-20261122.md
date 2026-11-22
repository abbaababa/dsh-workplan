# dsh-workplan 3.1.7 发布记录（2026-11-22）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.1.7` |
| 发布提交 | `e147195e43f257eb0084a1da67ac1f4055c07ad1` |
| Git tag | `v3.1.7`（指向同一提交） |
| 发布分支 | `main` |

## 发布前验证

- 本地 `npm run verify`：`tsc --noEmit` 通过；`npm test` **1429 tests / 1428 pass / 0 fail / 1 todo**，`cancelled=0`，退出码 0。
- 构建产物可复现：提交后重新 `npm run build`，`git diff --exit-code -- lib client.js` 退出码 0。
- GitHub Actions `verify`：run **44988234233**，Node 22/26 双矩阵全部 success。
- GitHub Actions `release`：run **44988241381**，Build / Test / Release 全部 success。

## GitHub Release

- 页面：https://github.com/abbaababa/dsh-workplan/releases/tag/v3.1.7
- 制品：`dsh-workplan-3.1.7.tgz`
- 大小：`1,940,177` 字节
- sha256：`be8289107de306e2f490da90d5b447cea6e67b2cc1ed200735b9dad9eff6cc97`

## npm 官方索引源

- 包：`dsh-workplan@3.1.7`
- `latest`：`3.1.7`
- tarball：https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.1.7.tgz
- shasum（SHA-1）：`1e0198b6a41f901c32c9f5a908e4967427f9a4a7`
- sha256（与 GitHub Release 制品同一份）：`be8289107de306e2f490da90d5b447cea6e67b2cc1ed200735b9dad9eff6cc97`
- 发布时间：`2026-11-22T05:15:45.685Z`

## 索引源（dsh-plugin-catalog 上游条目）

- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17707
- 变更：`data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball` 由 `v3.1.2` 更新为 `v3.1.7`
- 说明：catalog 的 `docs/index.json` 与 npm 包 `dsh-plugin-catalog` 由上游 CI 在 PR 合并后生成；本仓库只负责条目 PR。

## 备注

- 3.1.7 包含 3.1.5、3.1.6、3.1.7 三个版本的累积变更（npm 上一个已发布版本为 3.1.4）。
- 本次同时包含 T2 缺陷报告 D1–D5 的修复与审计中发现的 D2 重派占位、D4 登记撤销等修复；完整变更见 `CHANGELOG.md` 与 `docs/release-notes-3.1.7.md`。
