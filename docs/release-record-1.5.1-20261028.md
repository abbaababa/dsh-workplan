# dsh-workplan 1.5.1 发布记录（发布已完成；含发布前基线、失败分支与回滚）

- 记录编写：T9 发布后验证与留痕（技术文档工程师），2026-10-28 22:43–22:46 +08:00
- 记录对象：`dsh-workplan` 1.5.1，提交 `fbe467b`，tag `v1.5.1`
- 一句话状态：**已对外发布并验证通过**——远端 `main` 与 tag `v1.5.1` 已更新，npm `1.5.1`
  已发布且为 `dist-tags.latest`。§0 是发布后回填的实测结果；§1 起保留发布前的基线快照与预案。
- 本文所有"实测"均指本记录编写者亲自运行的命令（§0 为主 Agent 于 2026-10-28 22:46–22:50 +08:00
  实测）；凡引用他人结论均标注来源与可得性（见 §8）。

## 0. 实际发布结果（2026-10-28 22:46–22:50 +08:00 实测，发布后回填）

| # | 步骤 | 实测结果 |
|---|---|---|
| 1 | `git push origin refs/heads/main:refs/heads/main` | exit 0，`db74d44..fbe467b  main -> main`（快进） |
| 2 | `git push origin refs/tags/v1.5.1:refs/tags/v1.5.1` | exit 0，`* [new tag]  v1.5.1 -> v1.5.1` |
| 3 | `git ls-remote origin`（独立网络查询复核） | `refs/heads/main` = `fbe467b4a632a41a2b341c090e8231071b76b26e`；`refs/tags/v1.5.1` = `120dc2cb60f6380ff624d08bbc1e3cebc753b325`，`^{}` = `fbe467b4a632…`；`rev-list --left-right --count origin/main...HEAD` = `0 0` |
| 4 | `git worktree add --detach /tmp/dsh-wp-publish-1.5.1 v1.5.1` | 干净快照（`git status --porcelain` 为空），`package.json` = `dsh-workplan 1.5.1`，无 `private` 键，`publishConfig = {"access":"public"}` |
| 5 | 快照内逐文件比对（防"发的不是 tag 内容"） | tar 内 22 个文件的 `git hash-object` 与 `git ls-tree -r v1.5.1` 逐一相同：`checked 22 / mismatch 0`，无多余文件（另 44 个仓库文件按 `files` 白名单正确排除） |
| 6 | `npm publish --ignore-scripts` | exit 0，`+ dsh-workplan@1.5.1`；`shasum a6f35bd1b3d2630e3a2cf9e9555b58e51b20eaba`；`integrity sha512-AmpYMx55…f0pEwUYOlgdqw==`；22 文件 / 250.6 kB / 解包 843.5 kB |
| 7 | 传播等待 + 直连复核（`curl`，`Cache-Control: no-cache`） | 22:48:58 HTTP 404 → 22:49:20 HTTP 404 → 22:49:41 **HTTP 200**；`time['1.5.1']` = `2026-10-28T14:49:36.697Z`（22:49:36 +08:00） |
| 8 | `dist-tags` / `versions` | `latest = 1.5.1`；versions = `0.0.0-stage, 1.4.3, 1.5.0, 1.5.1` |
| 9 | 下载已发布 tgz 并核验 | 本地 `shasum` = `a6f35bd1…`（与 registry `dist.shasum` 一致）；22 文件；`package.json` = 1.5.1；`lib/host.js` 含 `version: '1.5.1'` |
| 10 | 制品内板块顺序复核 | `src/client.ts`：`h(PlanOverview` 在 1769 行、`h(Guide` 在 1775 行；编译后 `client.js`：`PlanOverview@88070 < Guide@88366` → **新顺序** |
| 11 | 消费者安装验证 | 空白目录 `npm i dsh-workplan@1.5.1 --prefer-online` → exit 0，装到 1.5.1，`client.js` 138 195 字节 |

**结论**：两个渠道均为最终状态，无"远端有 tag 而 npm 没有"的半发布态。§4（未发布原因）、
§5（发布步骤）、§6（失败分支与回滚）保留为历史记录与回退依据，不再代表当前状态。

**两个只在这一步才会暴露的坑（已实测）**：
1. **npm 元数据缓存**：22:50:04 首次 `npm i dsh-workplan@1.5.1` 返回 `ETARGET No matching version`，
   加 `--prefer-online` 后同一命令成功——是客户端缓存了发布前的 packument，不是包没发上去。
2. **tar mtime 影响 `shasum`**：同一份内容在原工作树打包 `shasum` 为 `ecb39f0…`、在干净
   `git worktree` 快照上为 `a6f35bd1…`；22 个文件的 blob 哈希逐一相同。实际发布的是干净快照这一份，
   故以 `a6f35bd1…` / `sha512-AmpYMx55…` 为准。

## 1. 事实基线（发布前快照，实测于 2026-10-28 22:42–22:43 +08:00 / 14:42–14:43 UTC）

| 项 | 实测值 | 判定 |
|---|---|---|
| 工作目录 | `/Users/open/Documents/Stocks/plugins/dsh-workplan` | — |
| 本地 HEAD | `fbe467b4a632a41a2b341c090e8231071b76b26e` | 已就绪 |
| 提交时间 / 作者 | `2026-10-28T22:27:53+08:00` / `abbaababa <abbaababa@users.noreply.github.com>` | — |
| 本地 tag | `v1.5.1`（annotated，taggerdate `2026-10-28T22:28:51+08:00`，解引用 = `fbe467b`） | 已就绪 |
| 分支状态 | `## main...origin/main [ahead 1]`，工作树干净 | 本地领先 1 个提交 |
| 远端 `refs/heads/main` | `db74d44785c2359609906396932013348022152f`（1.5.0 的提交） | 未更新 |
| 远端 `refs/tags/v1.5.1` | 不存在（`git ls-remote` 无此行） | 未推送 |
| 远端 `refs/tags/v1.5.0` | `d409ea92ab45ba8eac8bfc24160cef8d1c1c3804` | 对照：远端标签通道可用 |
| npm `dsh-workplan` latest | `1.5.0` | 未发布 |
| npm `dsh-workplan@1.5.1` | `E404 No match found for version 1.5.1` | 未发布 |
| registry 直连 `/dsh-workplan/1.5.1` | `HTTP 404` | 排除客户端缓存 |
| registry 已有版本 | `0.0.0-stage`, `1.4.3`, `1.5.0` | 无 1.5.1 |
| registry `time.modified` | `2026-10-28T07:15:19.890Z`（= 15:15:19 +08:00） | 包在本次会话内未被写入 |
| 工具版本 | npm `12.0.2`，node `v26.9.0` | — |

**结论**：这是一个"已提交、已打标签、未推送、未发布"的状态，不存在需要收拾的半发布态
（不存在"远端有 tag 而 npm 没有"这类不一致）。

## 2. 制品（发什么）与校验值

在干净的 `v1.5.1` 快照上打包，22 个文件，`size` 250 615 字节，`unpackedSize` 843 535 字节。

| 校验类型 | 值 |
|---|---|
| npm `shasum`（SHA-1） | `ecb39f063f9aa5e5a7e318d4331a4c130876b47b` |
| `.tgz` 整文件 SHA-256 | `80f3cba730a1692c10efa8e8cb7d75b28dce41bcfd50554168279ac190279503` |
| npm `integrity`（SHA-512 SRI） | `sha512-kMpFNuP+vSJj7TmIjShxI1b5G0iEmpYBa6nuuHHd3+V+HU16vl1E6JIh1exz5BFa4XF2JZuD58Gf9ihqWD6VCQ==` |

**"制品 = tag 内容"的证明**（不是推断，是逐文件比对）：

- `git diff v1.5.1 -- .` 为空；
- 把 `git archive v1.5.1` 解到 `/tmp/t9tag`，对 `npm pack --dry-run --json` 列出的 22 个文件
  逐个算 SHA-256 比对：`checked 22 mismatch 0`。
- 因此 tag 里就是待发布的制品本身，没有版本漂移。

**为什么从 tag 打包而不是从工作树**：`CHANGELOG.md` 在 `package.json` 的 `files` 白名单里，
本文的回填改动会改变 tgz 的 shasum。所以发布动作必须在干净的 `v1.5.1` 快照上做（§5），
否则校验值失效、发布后核对会对不上。

**反例（实测，2026-10-28 22:46）**：在含本次 CHANGELOG 回填的**工作树**上再打包，
得到 `shasum` = `45161555ed3f7550557ed7b1248733918f2aa25d`、`size` 251 749 B（仍 22 文件）。
也就是说，同一份代码只要带上这份文档，指纹就变了——若从这个树发布，§6 的 `dist.integrity`
核对必然失败。这是 §5 要求用 `git worktree add … v1.5.1` 的直接原因。

## 3. 本次实际走的分支

| 分支 | 内容 | 本次是否走过 |
|---|---|---|
| A 正常双渠道发布 | `git push` 提交与标签 → `npm publish` → 发布后外部验证 | **未执行**（需写凭据，见 §4） |
| B 仅 git 渠道 | 只推标签、npm 记为"不适用" | **不适用**：`dsh-workplan` 已是公共包（1.4.3、1.5.0 均在 npm 上），渠道存在且应更新 |
| C 替代交付（离线 tgz） | 用 `git archive v1.5.1` 重建 tgz 直接分发 | **仅完成兜底准备**：可从 tag 重建，校验值已固化（§2）；但 tgz 尚未交给任何外部使用者 |
| D 停在"发布前就绪" | 事实固化 + 一次性动作留给主 Agent | **实际停留在此**（本记录就是 D 的产物） |

C 之所以不能算"本次走替代交付"：最终交付物要求"npm 分发渠道上存在 1.5.1 版本（**或明确记录该渠道
不适用及原因**）"，而该渠道既存在又适用，只是尚未发布。因此 C 只是兜底，不能替代 A。

## 4. 发布前为何停在「就绪未发布」（历史记录；2026-10-28 22:46–22:49 已完成发布，见 §0）

1. **权限边界**：`npm publish` 是带写凭据的对外写操作；执行本子任务的子 Agent 权限被限定为
   "可验证的只读核查"，不能执行带凭据的写操作。
2. **不可逆性**：npm 版本号一旦发布不可重用；发错了只能 `npm deprecate` 或受政策限制的
   `npm unpublish` 收拾，属于"一次性不可逆动作"，必须由具备凭据的主 Agent 执行。
3. **顺序约束**：必须先确认"制品 = tag"（已实测，§2），再推送与发布；否则容易出现
   "远端有 tag、npm 没有"的半发布态，那是最难收拾的状态。
4. **现状无需抢修**：npm 侧 1.5.1 完全不存在（404），不存在需要立刻纠正的错误发布。

可佐证的凭据侧前置条件（只读探测）：`npm whoami` → **exit 0**（本机 npm 已登录；用户名不记录）。
远端 SSH 只读可达（`git ls-remote` 成功）；**远端写权限未验证**（本子任务未尝试写操作）。

## 5. 发布步骤（已于 2026-10-28 22:46–22:49 执行完毕，结果见 §0；保留本节供复核与回退对照）

推荐顺序：先提交本次文档回填 → 推 main → 推标签 → **从 v1.5.1 快照发布**。
关键规则只有一条：`npm publish` 必须在干净的 `v1.5.1` 快照上跑，避免把发布后回填的文档打进
1.5.1 的 tgz。实测补充：干净快照打包得到的 `shasum` 是 `a6f35bd1…`，而原工作树打包是
`ecb39f0…`，差异仅来自 tar 记录的 mtime，22 个文件内容逐字节相同（见 §0 第 2 条坑）。

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
# 1) 提交本次发布记录回填（纯文档，不触碰 lib/ client.js，CI 的"构建产物未过期"检查不受影响）
git add CHANGELOG.md docs/release-record-1.5.1-20261028.md
git commit -m "docs: record the 1.5.1 release state, checksums and rollback"

# 2) 推提交与标签（标签指向 fbe467b，不会因步骤 1 的文档提交而移动）
git push origin main
git push origin v1.5.1

# 3) 在干净的 tag 快照上发布（避免把文档回填打进 1.5.1 的 tgz）
git worktree add /tmp/publish-1.5.1 v1.5.1
cd /tmp/publish-1.5.1
npm publish --access public

# 4) 收尾
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
git worktree remove /tmp/publish-1.5.1
```

可选（更保险）：发布前先空跑一次，确认打包清单与校验值仍是 `ecb39f0…`：

```bash
cd /tmp/publish-1.5.1 && npm pack --dry-run --json | grep -m1 shasum
```

说明：`package.json` 里没有 `prepare` / `prepublishOnly` 脚本（只有 `clean`/`build`/`check`/`test`/
`verify`/`preview`），所以这个临时 worktree 即使没有 `node_modules` 也能直接发布，不需要先 `npm ci`。

## 6. 发布后验证（外部视角，期望输出写死）

```bash
npm view dsh-workplan@1.5.1 version            # 期望：1.5.1
npm view dsh-workplan dist-tags --json         # 期望：{"latest":"1.5.1"}
npm view dsh-workplan@1.5.1 dist.integrity     # 期望：sha512-kMpFNuP+vSJj7…8Gf9ihqWD6VCQ==
npm view dsh-workplan@1.5.1 dist.tarball       # 期望：…/dsh-workplan-1.5.1.tgz
git ls-remote origin refs/tags/v1.5.1         # 期望：非空（tag 对象 SHA）
git ls-remote origin refs/heads/main          # 期望：包含 fbe467b 或其后的文档提交
npm pack dsh-workplan@1.5.1 --dry-run          # 期望：shasum ecb39f063f9aa5e5a7e318d4331a4c130876b47b
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-workplan/1.5.1   # 期望：200
```

判据：八条全部符合才算"对外可见"；任何一条不符（尤其 `dist.integrity`）按 §7 处理。

## 7. 失败分支与回滚

| 阶段 | 失败现象 | 处置 | 可逆性 |
|---|---|---|---|
| 仅本地提交/标签 | 任何后续中止 | `git tag -d v1.5.1` + `git reset --hard db74d44`（会丢失 `fbe467b`） | 完全可逆，无外部影响 |
| push 被拒 | `! [rejected] main -> main (non-fast-forward)` | 先 `git fetch origin`、看 `git log --oneline origin/main..HEAD`；**禁止 force push 到 main** | 可逆 |
| push 成功、publish 未做 | 远端有 tag、npm 无 | 先补发布；若决定不发，`git push origin :refs/tags/v1.5.1` 删远端标签 + `git revert fbe467b` | 可逆 |
| publish 报 403 / OTP | `E403`、`need auth`、`one-time password` | `npm whoami` 复核；需 2FA 时 `npm publish --otp=<code>`；token 失效则 `npm login` | 未产生版本 |
| publish 报版本已存在 | `E409` / `EPUBLISHCONFLICT` | `npm view dsh-workplan@1.5.1` 确认；已存在就**不要改号重发**，先查是谁发的 | 未产生新版本 |
| publish 成功但 latest 未指向 | `dist-tags.latest` 仍为 1.5.0 | `npm dist-tag add dsh-workplan@1.5.1 latest` | 可逆 |
| publish 成功但校验值不符 | `dist.integrity` ≠ 上面 SRI | 立即停手：说明发布物与 tag 不一致；`npm deprecate` 兜底，再按流程重置 | 部分可逆 |
| 已发布且用户可能已安装 | — | 首选发布 1.5.2 修正 + `npm deprecate dsh-workplan@1.5.1 "…"`；`npm unpublish dsh-workplan@1.5.1 --force` 受 npm 官方政策限制（时间窗口、有依赖时不可撤销） | 不可完全撤销 |

代码侧回滚（与发布无关时使用）：`.backups/pre-1.5.1-20261028-221343/` 下四个文件
（`package.json`、`package-lock.json`、`CHANGELOG.md`、`src/host.ts`），回滚后必须 `npm run build`。

## 8. 证据来源与可得性（逐条交代，不混淆转述与实测）

- **T8（外部视角验证，已完成）**：原文完整在本子任务上下文中，本记录 §1 的 npm / registry /
  `ls-remote` 全部条目均与之逐条一致，并由本人于 22:42–22:43 重新实测复现：
  `npm view` → 1.5.0、`@1.5.1` → E404、registry 直连 404、`versions` 三项、`ls-remote` 无 v1.5.1、
  `main` = `db74d44`。T8 记录的"绕过缓存重试""`npm pack 1.5.0` 对照组成功"未重复执行，
  但结论已被本次直连 registry 的 404 独立支持。
- **T7（发布前预检）**：原文未在本子任务上下文中提供，仅有摘要（记录 shasum `ecb39f0…`、
  sha256 `80f3cba…`、22 文件 250.6 kB、临时目录已删）。**处理方式**：本次重新打包实测，
  三组数值与摘要完全一致，故按"已由本次实测独立复现"引用，不按"引用 T7 原文"标注。
- **T5**：原文未在本子任务上下文中提供，**其日志未验证**。可间接复核的只有其产物：
  提交 `fbe467b` 的 7 个文件改动（`git show --stat`）、7 处版本号一致（`package.json` 1.5.1）、
  以及 `npm run verify` 的 99/99 测试结论（记录在 `CHANGELOG.md` 1.5.1「验证」节）。
- **本人本次实跑的命令（原文与结果，时间戳为 2026-10-28 +08:00）**：
  - `22:42:23` `git status --porcelain -b` → `## main...origin/main [ahead 1]`（干净）
  - `22:42:23` `git rev-parse HEAD` → `fbe467b4a632a41a2b341c090e8231071b76b26e`
  - `22:42:23` `git cat-file -t v1.5.1` → `tag`；`git rev-parse v1.5.1^{}` → `fbe467b…`
  - `22:42:23` `git ls-remote origin refs/tags/v1.5.1 refs/tags/v1.5.0 refs/heads/main`
    → 仅 `db74d44… refs/heads/main`、`d409ea9… refs/tags/v1.5.0`
  - `22:42:48` `npm view dsh-workplan version` → `1.5.0`
  - `22:42:48` `npm view dsh-workplan dist-tags --json` → `latest: 1.5.0`
  - `22:42:48` `npm view dsh-workplan@1.5.1 version` → `E404 No match found for version 1.5.1`
  - `22:43` `curl -o /dev/null -w '%{http_code}' https://registry.npmjs.org/dsh-workplan/1.5.1` → `404`
  - `22:43` `curl https://registry.npmjs.org/dsh-workplan` → `versions [0.0.0-stage, 1.4.3, 1.5.0]`，
    `modified 2026-10-28T07:15:19.890Z`
  - `22:43` `npm pack --dry-run --json` → 22 文件 / 250615 B / `shasum ecb39f0…` / `integrity sha512-kMpF…`
  - `22:43` `npm pack --pack-destination /tmp/t9pack` → sha1 `ecb39f0…`、sha256 `80f3cba…`
  - `22:43` `git archive v1.5.1` 解包后逐文件比对 → `checked 22 mismatch 0`
  - `22:43` `npm whoami` → exit 0（已登录）
  - `22:43` `cat .github/workflows/verify.yml` → 只有 `verify` job，**无 publish job**，
    即发布是手工动作，CI 不会代发
  - `22:45:07` `git status --porcelain`（写入本文与 CHANGELOG 回填后）→ ` M CHANGELOG.md`、
    `?? docs/release-record-1.5.1-20261028.md`
- 清理：`/tmp/t9pack`、`/tmp/t9tag`、`/tmp/t9tag.tar`、`/tmp/t9work` 已删除（`ls -d /tmp/*t9*`
  无输出）；仓库内未留下任何 `.tgz`（`git status` 只显示上面两项文档改动）。

## 9. 知识库条目草稿（**未写入，等主 Agent 决定**）

> 说明：以下为草稿，未调用任何知识库写入接口。是否收录、是否合并为一条，由主 Agent 决定。

### 草稿 1（事实页）：dsh-workplan 1.5.1 的发布状态

- 标题：`dsh-workplan 1.5.1: published to GitHub (tag v1.5.1) and npm (latest)`
- 正文要点：1.5.1 是"展开态计划卡里『分步进度』与『先看这三句』位置对换"的补丁版；
  提交 `fbe467b`（2026-10-28 22:27:53 +08:00）与 annotated tag `v1.5.1`（22:28:51 +08:00）；
  **2026-10-28 22:46–22:49 已完成发布**：远端 `main` = `fbe467b`、远端标签 `v1.5.1` 已建；
  npm `1.5.1` 已发布（`time['1.5.1']` = `2026-10-28T14:49:36.697Z`），`dist-tags.latest` = `1.5.1`。
  已发布制品指纹见草稿 3（以 `a6f35bd1…` 为准）。发布前"未发布"的状态只属于历史快照（§1）。

### 草稿 2（决策/规则）：发布顺序与"干净快照"规则

- 标题：`Release rule: publish from a clean version tag, never from a dirty tree`
- 正文要点：`CHANGELOG.md` 在 `package.json` 的 `files` 白名单内，任何发布后文档回填都会改变
  tgz 的 `shasum`；因此发布必须在 `git worktree add … <tag>` 得到的干净快照上执行，
  发布后再提交文档回填。顺序：commit 回填 → push main → push tag → 从 tag 发布 → 外部验证。
  违反该规则会导致"记录的校验值 ≠ 发布的制品"，发布后核对会被误判为失败。

### 草稿 3（基线数值）：1.5.1 制品指纹

- 标题：`dsh-workplan@1.5.1 artifact fingerprints`
- 正文要点：22 文件 / 250 615 B / 解包 843 535 B。
  - **实际发布（干净 `git worktree` 快照，以 registry `dist` 为准）**：`shasum`（SHA-1）
    `a6f35bd1b3d2630e3a2cf9e9555b58e51b20eaba`；`integrity`
    `sha512-AmpYMx55Y0ea2tAc14C4V7t/Pxrho+9nZXZqxz7JtdPYvFRyxS+wzEIUCfATRgq5cogT22lTSf0pEwUYOlgdqw==`。
  - 原工作树打包（同为 22 文件、内容逐字节相同，仅 tar mtime 不同）：`shasum ecb39f0…`、
    SHA-256 `80f3cba730a1692c10efa8e8cb7d75b28dce41bcfd50554168279ac190279503`。
  - 证明"制品 = tag 内容"：tar 内 22 个文件的 `git hash-object` 与 `git ls-tree -r v1.5.1`
    逐一相同（`checked 22 / mismatch 0`）。

### 草稿 4（经验）：`npm unpublish` 不是可靠的撤销手段

- 标题：`npm rollback: deprecate first, unpublish is constrained`
- 正文要点：版本一旦发布，优先用 `npm deprecate` 引导用户；`npm unpublish --force` 受官方政策
  限制（可撤销时间窗口、有包依赖时不可撤销），且不能消除已写入 lockfile 的校验值。
  真正可靠的修正是"发 1.5.2 并 deprecate 1.5.1"。

## 10. 待办（交给主 Agent）

1. ~~按 §5 执行 `git push` + `npm publish`~~ → **已于 2026-10-28 22:46–22:49 完成**（结果见 §0）。
2. ~~按 §6 逐条验证并回填~~ → 已回填到 §0（含 registry、tgz、消费者安装三路验证）。
3. 仍待决定：§9 四条草稿是否写入知识库（本条未执行，属主 Agent 的后续判断）。
4. 剩余可选动作：重启/重载 DSH web profile 后刷新页面，在运行实例里目视确认换序
   （本次发布未重启任何服务）。
