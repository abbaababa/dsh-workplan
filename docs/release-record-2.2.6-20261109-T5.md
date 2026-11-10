# dsh-workplan 2.2.6 发布记录（T5 · 2026-11-09）

> 状态：**已发布**（GitHub + npm 双通道）；索引源 PR 内容包就绪、待 T6 提 PR（设计上独立不阻塞）。

## 1. 发布对象与结果

| 项 | 值 |
|---|---|
| 版本 | 2.2.6（= T2 冻结值；发布前四处存在性检测通过） |
| 发布 commit | `f1e3f7b31b51d18f304e90f596e9d3bebaf74220`（branch main，远端=本地一致） |
| Tag | `v2.2.6`（annotated，tag 对象 `22340ee8…`，指向 commit `f1e3f7b…`；已推送远端） |
| GitHub Release | https://github.com/abbaababa/dsh-workplan/releases/tag/v2.2.6 |
| Release 标题 | v2.2.6 — 三项修复：回放闭环、需求序列化、分解进度可见 |
| Release 正文 | T3 §一（`_t5_release_execution_20261109/gh-release-body-2.2.6.md`，逐字注入） |
| Release 资产 | `dsh-workplan-2.2.6.tgz`（1,282,070 B，state=uploaded；下载 URL HTTP 200 实测） |
| Release tgz sha256 | `05ffcb06f0c6595accd3efedfc89ea03fcf2d475d6f59cddf7a28d4ef83da4dc`（干净克隆 tag 打包） |
| npm | `dsh-workplan@2.2.6` 已发布，dist-tags.latest=2.2.6；tarball `https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-2.2.6.tgz`，dist.shasum=`c45cf983c6bf4be943cb1fde32e3c644100548c3`（repo 目录打包路径，与 Release tgz 为两处打包产物，双摘要并记） |
| 索引源 catalog 现状 | versions 仍=[2.1.5]（上游 CI 定时同步 + T6 PR 未提，属预期延迟，非故障）；PR 内容包已就绪：`_t5_release_execution_20261109/index-pr-package-2.2.6/`（upstream-current.yml 已拉取、tarball 行已改写 v2.2.6）与 T4 包 `_t4_release_pipeline_20261109/index-pr-package-2.2.6/` 等效 |

## 2. 时间线（全部日志留档于 `_t5_release_execution_20261109/`）

1. **前置复核**（13:28–13:36）：凭证三查 gh/npm/SSH ✓；v2.2.6 四处不存在 ✓；冻结范围对齐（剔除 2 项杂物至 `_t5_excluded_20261109/`）✓；build ✓。
2. **W5 硬检查 FAIL(1)**（两次一致）→ 上报主 Agent → **裁决选项 B**：判据过期、非回归；修订断言 3 为 2.2.x 门禁语义（注释引用根因诊断），RELEASING §1.4 偏差节更新为「已消解（2026-11-09 判据修订，非运行例外）」；修订后双跑 `RESULT: PASS`（`w5-probe-20261109-T5-pass-run1/2.json`）。
3. **/Users/open 路径改写**（T2 §3 发现项）：CHANGELOG.md 3 处、RELEASING.md 2 处（W5 示例 + 文中）、release-steps-20261106.md 1 处、release.sh 1 处 → 复测 4 文件 0 命中。
4. **首次正式执行**（原版脚本）：步骤①–⑤通过；步骤⑤产物守卫误报失败（`git diff` 以 HEAD 为基线，在未提交工作区场景必然失败；dry-run 不执行该步故 T4 未暴露）→ **零发布状态确认**（HEAD/tag/远端均无变化）+ **构建字节级确定实测**（重建前后聚合 sha256 一致）→ 生成 **v1.1 修正版脚本**（原件不动；守卫改为构建前快照、重建后逐字节比对，语义等价原意图且更严格）。
5. **v1.1 正式执行**：步骤①–⑥全部通过——commit `f1e3f7b` + tag `v2.2.6` 推送官方远端 ✓；步骤⑦克隆内 `npm run build` 触发 **G3 npm 缓存 EPERM**（该子壳未走变通）→ 按 G3 已验证方案**断点续跑**。
6. **步骤⑦续跑**：干净克隆 tag（HEAD=f1e3f7b）→ 临时缓存 `npm ci && build && npm pack` ✓（sha256 如上）→ `gh release create` ✓（05:43Z）；制品 URL 首验 504（CDN 瞬态）→ 轮询第 6 次 **HTTP 200** ✓，gh api 确认资产 uploaded。
7. **步骤⑧ npm publish**：G3 变通缓存，退出码 0、`+ dsh-workplan@2.2.6`；CDN 轮询第 5 次内回读 ✓（latest=2.2.6）。**未重复 publish。**
8. **步骤⑨ 索引内容包**：上游 yml 拉取成功、tarball 行改写 ✓（独立步骤，PR 属 T6）。
9. **全通道独立回验**（05:48Z）：远端 main=tag commit=本地=f1e3f7b ✓；Release 含 T3 正文+资产 ✓；npm version/shasum ✓；catalog 现状记录如上。

## 3. 偏差登记（3 项，均已处置并留痕）

| # | 偏差 | 处置 | 证据 |
|---|---|---|---|
| D-1 | W5 断言 3 判据过期（1.11.0 口径）→ FAIL(1) | 主 Agent 裁决选项 B：修订判据为 2.2.x 门禁语义，双跑 PASS | `w5-verdict-diagnosis-T5.md`、`w5-probe-…-pass-run1/2.json`、RELEASING §1.4 |
| D-2 | 原版脚本步骤⑤产物守卫基线错误（必然误报） | v1.1 修正版（快照逐字节比对），原件保留审计 | `auto-release-v1.1-guardfix.sh`、`real-2.2.6-T5.log`、`real-2.2.6-T5-run2.log` |
| D-3 | 步骤⑦克隆内 build 遇 G3 EPERM（脚本该子壳未走变通） | 按 T4 已验证 G3 方案断点续跑步骤⑦⑧⑨，语义与脚本一致 | `real-2.2.6-T5-resume.log` |

## 4. 敏感信息终检

推送前脚本敏感扫描：54 文件、疑似凭证 0 命中；本机路径提示 4 处（`version-freeze-20261109-T2.md` 报告自述路径 ×2、`w5-cross-version-check.mjs` 夹具默认路径注释 ×2——均为 T2 §3 已裁决可接受类，非凭证）。

## 5. 移交（不阻塞本记录）

1. **T6**：用 `index-pr-package-2.2.6/` 对上游 `awesome-dsh-plugin` 提 PR（pr-commands 在 T4 包内）；上游 CI 同步 catalog。
2. **T7**：独立验收（本记录 §1 各项可直接复核）。
3. **用户**：手工重启 DeepSeek Harness 使 2.2.6 运行态生效（本流程未自行重启任何服务）。

## 6. 续会话独立复验（2026-11-09 13:56–14:04，T5 会话恢复后增补）

背景：首次执行在发布动作全部完成、本记录 §1–§5 落盘（13:48）之后，收尾汇报阶段出现 CHILD_STALLED（子会话 300 秒零事件被超时中止）。本节由恢复后的同一子任务会话独立复核——**不采信上文自述，以下全部为本次重新实测**：

| 复核项 | 方法（本次实测） | 结果 |
|---|---|---|
| 远端 main | `git ls-remote origin refs/heads/main` = `f1e3f7b31b51d18f304e90f596e9d3bebaf74220` = 本地 HEAD | ✓ |
| 远端 tag | `git ls-remote origin refs/tags/v2.2.6` = `22340ee8…`，`v2.2.6^{}` = `f1e3f7b…`（tag 指向发布 commit） | ✓ |
| 发布 commit | `git show --stat HEAD`：54 files changed；`git show HEAD:package.json` version=2.2.6；剔除项 `dist-tests-t4` 在仓库树 0 命中；`tests/handoff-need-serialization.test.ts` 与 `_t5_excluded_20261109/` 隔离副本 diff 逐字一致（原根目录散件归位 tests/，非新增内容） | ✓ |
| Release 元数据 | `gh api repos/abbaababa/dsh-workplan/releases/tags/v2.2.6`：published=2026-11-09T05:44:52Z，body_chars=2494，assets=[dsh-workplan-2.2.6.tgz, state=uploaded, size=1282070] | ✓ |
| Release 正文 | API `.body` 与 `gh-release-body-2.2.6.md` diff 仅尾行空行差异（gh API 输出行为），含 T3 §一全部 6 节（「合并态统一回归」「边界与已知事项」「安装」均在） | ✓ |
| 资产可下载 | curl 直连首次 HTTP/2 瞬态失败（exit 16, HTTP=000）→ `gh release download` 认证通道重试成功：1,282,070 B，sha256=`05ffcb06f0c6595accd3efedfc89ea03fcf2d475d6f59cddf7a28d4ef83da4dc` 与 §1 一致；资产内 package.json version=2.2.6、lib/ 15 个产物文件 | ✓ |
| npm（只读回查） | `npm view dsh-workplan@2.2.6`（G3 临时缓存变通，无写操作）：version=2.2.6、dist-tags.latest=2.2.6、dist.shasum=`c45cf983c6bf4be943cb1fde32e3c644100548c3`，与 §1 一致 | ✓ |

**复验结论**：§1 记录的各项值全部独立重现实测一致，双渠道发布状态真实有效。资产下载的 HTTP/2 瞬态失败为客户端网络层问题，认证通道重试即成功，不构成发布缺陷。
