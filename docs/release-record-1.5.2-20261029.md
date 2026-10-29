# dsh-workplan 1.5.2 发布记录（发布已完成；含发布前基线、CI 红转绿与回滚）

- 记录对象：`dsh-workplan` 1.5.2，提交 `666b0fe`，annotated tag `v1.5.2`
- 发布时间：2026-10-29 13:21–13:25 +08:00（registry 记录 `2026-10-29T05:24:48.346Z`）
- 一句话状态：**已对外发布并验证通过**——远端 `main`、tag `v1.5.2`、npm `1.5.2`
  （`dist-tags.latest`）三者一致，无半发布态。
- 本文所有"实测"均为主 Agent 在本机亲自运行的命令；时间均为 `+08:00`。

## 0. 实际发布结果

| # | 步骤 | 实测结果 |
|---|---|---|
| 1 | `npm run verify`（提交前门禁） | exit 0；`tsc --noEmit` 无输出；`node --test` **120 pass / 0 fail**，4.16 s |
| 2 | `git add -A && git commit` | `666b0fe fix: ship dsh-workplan 1.5.2 with progress and phase on one source of truth`；22 文件，+4 477 / −114 |
| 3 | `git tag -a v1.5.2 -m …` | tag 对象 `155c601c73d76f25a97cc0996e53c9e04407ea01` → 提交 `666b0fee483b00714f4ad401af7ffb18c4f2a214` |
| 4 | `npm run build` 后 `git diff --exit-code -- lib client.js`（CI 同名检查） | 重编译产物与提交逐字节一致，diff 为空；工作树 `git status --porcelain` 为空 |
| 5 | `git push origin main` | exit 0，`b0e0b76..666b0fe  main -> main`（快进） |
| 6 | `git push origin v1.5.2` | exit 0，`* [new tag]  v1.5.2 -> v1.5.2` |
| 7 | `git ls-remote origin`（独立网络查询复核） | `refs/heads/main` = `666b0fee483b…`；`refs/tags/v1.5.2` = `155c601c73d7…`，`^{}` = `666b0fee483b…` |
| 8 | `git worktree add --detach /tmp/dsh-wp-1.5.2 v1.5.2` → `npm pack` | 干净快照；`package.json` = `dsh-workplan 1.5.2`、无 `private`、`publishConfig = {"access":"public"}`；22 文件 / 269 264 B / 解包 888 135 B |
| 9 | `npm publish ./dsh-workplan-1.5.2.tgz --access public --ignore-scripts` | exit 0，`+ dsh-workplan@1.5.2`，tag `latest`，public |
| 10 | 传播等待 + 直连复核（`curl`） | 404 ×3（约 45 s）→ **HTTP 200**；`time['1.5.2']` = `2026-10-29T05:24:48.346Z` |
| 11 | `dist-tags` / `versions` | `latest = 1.5.2`；versions = `0.0.0-stage, 1.4.3, 1.5.0, 1.5.1, 1.5.2` |
| 12 | 下载已发布 tgz 并核验 | `shasum` = `2159024d…`、SHA-256 = `4482f202…`，与本地打包逐字节相同 |
| 13 | 消费者安装验证 | 空白目录 `npm i dsh-workplan@1.5.2` → `meta = {"name":"dsh-workplan","version":"1.5.2",…}` |

## 1. 发布前基线

- 工作树：14 个已跟踪文件被修改（+837 / −114）+ 8 个未跟踪文件（3 份根因/矩阵/修复报告、
  3 个脚本、2 个新测试文件），全部随发布提交入库，避免"CHANGELOG 引用的文档在 tag 上 404"。
- 门禁：`npm run verify` 120/120；构建可复现（`git diff --exit-code -- lib client.js` 为空）；
  版本 7 处一致（`package.json`、`package-lock.json` 两处、`src/host.ts`、`lib/host.js`、
  `dist/host.js`、`CHANGELOG.md` 顶部）。
- 安全快检：10 类高置信度凭据模式 0 命中；运行时依赖 0 个；`npm audit` 0 漏洞；
  `package-lock.json` 逐条锁定版本 + integrity；无 `preinstall/install/postinstall/prepare` 脚本。
- 回滚资产：`.backups/pre-1.5.2-20261029-125724/`（`package.json`、`package-lock.json`、
  `CHANGELOG.md`、`src/host.ts`，取自 `git show HEAD:`）。

## 2. 已发布制品的校验值

- npm `shasum`（SHA-1）：`2159024d69c05b3aeeefd5e7ff2f208ec05c67a2`
- npm `integrity`（SHA-512 SRI）：
  `sha512-sY7UgT09JwfRFe61HKCOCH7wLz0xbdAxyLla3WO8xoyZ/T6Yxb6H/IqRFf9LEX9EsnW7+z4jcHICms6RKPmTzQ==`
- 本地 `.tgz` SHA-256：`4482f202d098bbaec35051e54440d0d2be6e0099b6d6606e3c582b88e1aee9fa`
- 制品 = tag 快照：`.tgz` 在 `git worktree add --detach … v1.5.2` 的干净检出上打包，
  发布的正是这份文件，因此 22 个文件全部取自 `666b0fe`。
- `dist.fileCount = 22`；`tests/`、`docs/`、`scripts/` 按 `files` 白名单不入包。

## 3. CI 红转绿（与 1.5.2 内容无关的既有缺陷）

- tag 提交的 verify 运行 `40823115340` = **failure**：20 个用例报
  `cancelledByParent: Promise resolution is still pending but the event loop has already resolved`。
- 对照 1.5.1 / 1.5.0 / 1.4.3 的推送运行（`40710236377` / `40709317714` / `40646355248`），
  `cancelledByParent` 条数**均为 20** → 属于一直在红的既有 CI 缺陷，不是本次改动引入。
- 根因：运行时故意把轮次预算 / 空闲 / 硬超时计时器 `unref`（避免关闭中的宿主被它们held住）；
  Node 22 在事件循环清空时会取消仍挂起的测试，于是"等超时"的用例在 CI（Node 22）必失败，
  而本机 Node 26 通过。
- 修复：`9f0de34 test: keep the event loop alive while timeout tests wait`——
  `tests/workplan-budget-pause.test.ts` 与 `tests/workplan-stuck-recovery.test.ts` 在文件作用域
  持有一个 ref 句柄（真实宿主里由 HTTP server 承担），`after()` 钩子释放，60 s 后自动脱落，
  真卡死时仍会失败而不是挂住 CI。
- 证据：本机 Node **22.23.4** 全量 `node --test dist-tests/tests/*.test.js` → 120/120 pass、
  0 cancelled、4.09 s（修复前同一 Node 22 上 `workplan-budget-pause` 13/13 全部 cancelled、
  `workplan-stuck-recovery` 7 个 cancelled）；Node 26 `npm test` → 120/120。
- 修复后推送 `9f0de34` 的运行 `40823694198` = **success**（Install / Typecheck and test /
  stale-build check 全绿）。
- CI 修复只改 `tests/`，制品不变：`git diff --stat v1.5.2 -- . ':!tests' ':!docs' ':!scripts'` 为空。

## 4. 需注意的生效方式

- **npm / git 已完成**：消费者 `npm i dsh-workplan@1.5.2` 即得新代码。
- **本机 DSH 进程仍是 1.5.1 的内存副本**：`lib/*.js`（host 侧）在 DSH 下次启动时才加载；
  `client.js` 随页面刷新生效。因此界面上的「已完成 / 进行中」对账会在刷新后立刻正确，
  但 `updateStatus`、回放、取消等宿主逻辑要重启 DSH 后才换成 1.5.2。
- 插件目录以符号链接挂进 profile，重启即生效，无需重新安装。

## 5. 回滚

- npm：`npm deprecate dsh-workplan@1.5.2 "回滚说明"` 先引导；确需撤销时
  `npm unpublish dsh-workplan@1.5.2 --force`（受 npm unpublish 政策约束，执行前核对官方文档）。
- git：`git push origin :refs/tags/v1.5.2` 删远端标签，`git revert 666b0fe` 回退提交
  （不要 `push --force` 改写远端 `main` 历史）。
- 本机：用 `.backups/pre-1.5.2-20261029-125724/` 覆盖四个文件后 `npm run build`
  （运行中的进程不会自动重载 `lib/host.js`，需重启）。

## 6. 时间线（+08:00）

- 12:46 根因诊断完成（`docs/root-cause-phase-percent.md`）
- 12:57 版本升 1.5.2（备份 `.backups/pre-1.5.2-20261029-125724/`）
- 13:11 第二批同类修复 + `tests/phase-percent-invariant.test.ts`、`tests/completion-semantics.test.ts`
- 13:18–13:23 12 项发布准备子任务（5 项完成，7 项因 subagent 服务不可用受阻；发布动作由主 Agent 执行）
- 13:20 `npm run verify` 120/120
- 13:21 提交 `666b0fe` + tag `v1.5.2`
- 13:22 推送 `main` 与 tag
- 13:23 CI 运行 `40823115340` 失败（既有 20 cancelled）
- 13:24 `npm publish` → `+ dsh-workplan@1.5.2`
- 13:25 registry 200；`dist-tags.latest = 1.5.2`
- 13:25 消费者安装验证通过
- 13:26 Node 22 复现 CI 失败并定位到 `unref` 计时器
- 13:30 CI 修复提交 `9f0de34` 推送
- 13:33 运行 `40823694198` 全绿
