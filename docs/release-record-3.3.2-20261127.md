# dsh-workplan 3.3.2 发布记录（2026-11-27）

## 版本与代码

| 项目 | 值 |
|---|---|
| 版本 | `3.3.2` |
| 发布提交 | `f3beafa4745ac0983ad9cc208981220ff19498cd`（`main`） |
| Git tag | `v3.3.2`（annotated，tag 对象 `8c420a766acf2c2e1ce701f49e19b10503a22552`，指向同一提交） |
| 发布分支 | `main` |
| 说明 | DSH 0.2.3-alpha.2 全面适配 + 结算误判治本版（详见 `CHANGELOG.md` 3.3.2 段与 `docs/release-notes-3.3.2.md`） |

## 本版修的三层根因（治本，非症状）

事故：会话 `session-ad9066eb-5ea0-45c7-9e95-4544e734e4b7` / 计划 `wp-6cf42e5b-b724-4a5c-b7ad-4ac5411c8b91` / T1，2026-11-26 23:56–23:59。
现场台账写的是「五步证据不完整：phases 缺失」，但子会话收尾正文里 `execution` / `verification` 都在，真正缺口只有验收项 A2 一条。

1. **盘上结算备份覆盖了更优的本次回报（主因）**：`readSettlementBackupVerdict` 只判断备份「能否解析」，不判断「是否比本次回报更好」。T1 的备份是摘要式的（无 `phases`、无证据块），却被采纳为最终结算——子会话因此收到与真实缺口无关的诊断，台账 `summary` 被换成一段备份 JSON，本可救回的有界回喂被直接跳过，T1 一次即 blocked，T2–T11 全部级联「上游受阻」。
   **修法**：只采纳 `status=done`（等价完整证据）或 `blocked` 且带 `question`（明确请示）的备份；其余一律拒绝并落回消息路径的有界回喂。
2. **备份写法指令有歧义**：旧提示词「发送前将同一 JSON（顶层带 planId/subtaskId）写入 …」被理解成「写份摘要就算备份」，导致备份永远过不了结算闸。**修法**：要求把最终结果块 JSON 原样另存（字段一个不少），只在最外层加 `planId`/`subtaskId`；摘要式备份明确说明不会被采纳。
3. **归位成功时给出误导性提示**：结果块少一个 `}` 时 `acceptance` 会被吞进 `phases`，平台已自动归位并读到 5 条，旧文案却写「若 acceptance 位于错误点之后，会被一起裁掉」，诱导子会话整块重写。**修法**：如实写明已归位哪些字段、已读到几条验收，只要求补缺的编号。

## 本地发布前验证（已完成）

- `npm run check`（`tsc --noEmit`）：通过，0 错误。
- `npm run build` 后 `git status --porcelain -- lib client.js` 为空：**提交的构建产物可由本提交源码逐字节重建**。
- `npm test`：**1575 例，pass=1574 / fail=0 / cancelled=0 / todo=1**（新增 `tests/dsh-023-compat.test.ts` 16 例、`tests/workplan-332-backup-quality.test.ts` 6 例；修正三处随本版过期的旧断言：`delegate.timeNotice` 边界表达、两处版本断言）。
- 版本四处 + 三语 README + `tests/fixtures/tool-surface.json` 均为 `3.3.2`（`tests/version-sync.test.ts` 通过）。
- 内容一致性：本地 `npm pack` 产物与 npm 已发布的 3.3.2 tarball 解包后 **184 个文件逐字节一致**（tarball 自身 sha256 因打包条目顺序不同而不同，内容无差异）。

## 源码恢复说明（如实记录）

3.3.2 在本仓库原本**只有分发包、没有对应源码提交**（与 3.3.1 当时的情况相同）。本次处理方式：

1. 以本机已安装/已分发的 3.3.2 制品（`src/`、`lib/`、`client.js`、CHANGELOG、README、docs、package.json）为基线，把源码重建进仓库；
2. 重建后 `npm run build`，与制品逐文件比对：**只差本版三处修复与测试所需的 `export`**，证明基线源码完整、没有夹带其它未记录的改动；
3. 在该基线上叠加三层修复 + 两个新测试套件 + 三处过期断言修正；
4. 剔除制品中无法自证的说法：3.3.2 CHANGELOG 原称「新增 `tests/dsh-023-compat.test.ts`」（该文件当时并不存在）与「`server.mjs` 版本同步」（`server.mjs` 里没有版本号）——本版**真的补出了该测试文件**，并删掉 `server.mjs` 这一不实同步点；同时修正 3.3.1 段「未新增测试文件」这处与事实不符的表述。

## 外部渠道发布状态（已完成并核验）

1. **GitHub 源码 / Tag / Release（`abbaababa/dsh-workplan`）**：`main` 与 `v3.3.2` 已推送；tag 触发的 `release` 流水线 <https://github.com/abbaababa/dsh-workplan/actions/runs/45926012127> 全部成功（Build 22 / Build 26 / Test 22 / Test 26 / Release）。Release 页面 <https://github.com/abbaababa/dsh-workplan/releases/tag/v3.3.2>，正文取 `docs/release-notes-3.3.2.md`，资产 `dsh-workplan-3.3.2.tgz` 大小 2,127,419 字节、仓库侧 digest `sha256:8f4e3ba83e2510432907533e2ecf39babdb96f111124bdea7bb9f2e25c545c49`。
2. **npm 官方索引源（`dsh-workplan@3.3.2`）**：由同一次 `release.yml` 的 `npm publish --provenance --access public` 发布（日志含 `Signed provenance statement` 与 Sigstore 透明度日志 `logIndex=4138710412`）。`registry.npmjs.org` 上 `dist-tags.latest=3.3.2`；integrity `sha512-Sujl+pcSJsXuvYKda/tIQfhYYz5YXXMUuRkAhpa0jVFZBOcWNk/9dIRo6L7cSmtnWasH9Khe5HWIJNrOBhW8eg==`、shasum `f1d8e1349dc639852d6c585dd3459a9c34e5e349`；下载后 tarball sha256 与 GitHub Release 资产**完全相同**（`8f4e3ba8…`）。
3. **本机运行态安装**：`~/.dsh/profiles/web/package.json` 的依赖仍是 `link:/Users/open/dsh-plugins/dsh-workplan-3.3.2`，该目录已用**已发布的 3.3.2 tarball 内容**整体覆盖（184 个文件，`lib/runtime.js`、`lib/plan.js`、`client.js` 与仓库构建产物 sha256 逐一相同）。旧版本已备份到 `.backup-dsh-workplan-3.3.2-old/`（181 个文件）。**运行中的 DSH 进程仍加载旧内存代码，需用户手动重启一次 DSH Web 才会生效**（发布流程不做任何重启）。
4. **索引源（`awesome-dsh-plugin/awesome-dsh-plugin`）**：本次**未执行**（用户选择的范围是 npm + GitHub Release）。如需上架/更新市场，人工步骤：把 `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball` 指向 `https://github.com/abbaababa/dsh-workplan/releases/download/v3.3.2/dsh-workplan-3.3.2.tgz` 后提 PR。

## 发布方式说明（与 `release.sh` 的差异）

本次**没有**整条跑 `release.sh`，而是按它清单逐步人工执行：`npm run check` → `npm test` → `npm run build` + 产物可复现断言 → `git add` 白名单 → commit → `git tag -a v3.3.2` → push 分支与 tag。原因：本仓库的 GitHub Release 与 npm 发布由 `.github/workflows/release.yml` 在 tag 上完成（带 SLSA provenance），本地再 `gh release create` / `npm publish` 会与 CI 竞争甚至重复发布，且本地发布没有 provenance 证明。其余检查项（版本四处一致、产物可复现、Release 必须带 tgz、制品 URL 可下载、npm latest 指向新版本）均已逐条核验，见上两节。

## 回滚

```bash
# 1) 运行态回滚（本机）：把备份目录换回去，然后手动重启 DSH
rm -rf /Users/open/dsh-plugins/dsh-workplan-3.3.2
rsync -a /Users/open/Documents/Stocks/.backup-dsh-workplan-3.3.2-old/ /Users/open/dsh-plugins/dsh-workplan-3.3.2/
# 2) GitHub Release 回滚（tag 保留）
gh release delete v3.3.2 -R abbaababa/dsh-workplan --yes
# 3) npm 回滚（24 小时内有效，需人工确认后执行）
npm unpublish dsh-workplan@3.3.2
```

## 已知边界（如实说明）

- 本版不改变「缺失永不计 done」的严格性：证据不全的子任务仍不能记完成，区别在于**诊断准确、且先回喂补报**，不再一次即阻断并级联冻结下游。
- 历史已写坏的台账不会自动重算：原计划 `wp-6cf42e5b…` 的 11 项 blocked 需要回原会话重新 `dsh_workplan_dispatch` 续跑（已完成项不会重跑）。
- 拒绝采纳备份时的台账行末尾仍沿用原后缀「新鲜度/归属闸」，而 `reason` 字段已逐字写明「备份证据不优于本次回报」——纯文案新旧混排，不影响判定与行为，留待下个版本顺手统一。
