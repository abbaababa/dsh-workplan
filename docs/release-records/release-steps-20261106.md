# dsh-workplan 发布流程梳理（T1 交付物）

> 仓库根：`plugins/dsh-workplan`（相对工作区根；自身含 `.git`，工作区根不是 git 仓库）
> 当前版本：`2.1.3`（`package.json:3`、`package-lock.json:3,9`、`src/host.ts` 的 `meta.version`、CHANGELOG 顶部 `## 2.1.3 — 2026-11-06`）
> 本文所有命令均标注来源：RELEASING.md 章节、package.json scripts、.github/workflows/verify.yml，或前期对话（m00001）实测事实。

---

## 一、发布步骤（有序列表）

### 步骤 0 · 版本号规则与四处声明点
- 版本号只有四个声明点，由 `tests/version-sync.test.ts` 断言一致（`RELEASING.md:12-19`）：
  1. `package.json` 的 `version`
  2. `package-lock.json` 的 `version` 与 `packages[""].version`
  3. `src/host.ts` 的 `meta.version`
  4. `CHANGELOG.md` 的 `## <version> — <date>`
- 改版本时必须四处同步改，否则 CI `npm test` 中的 version-sync 断言会失败。
- 来源：RELEASING.md §0（行 6-19）

### 步骤 1 · 发布前检查（全部通过才继续）
```bash
git status --short                                   # 工作区干净，无未提交改动 [RELEASING.md §1:25]
npm run check                                        # = tsc --noEmit [package.json scripts:69]
npm test                                             # = build + 全部用例 [package.json scripts:70]
npm run build && git diff --exit-code -- lib client.js  # 重新构建后 lib/client.js 无差异 [RELEASING.md §1:32]
```
- `npm test` 会先 `npm run build` 再跑全部用例；任一失败不打 tag。
- （可选/历史探针，不并入 npm test）headless W5 跨版本 A/B 探针：`node scripts/w5-cross-version-check.mjs ...`，需 tag `v1.8.19` 与夹具，判据 `RESULT: PASS` 且 EXIT=0（`RELEASING.md §1.4:41-70`）。该步当前有已知偏差，未确认前只记未通过。
- 来源：RELEASING.md §1（行 21-35、41-90）

### 步骤 2 · 提交与打标签
```bash
git add -A
git commit -m "Release 2.1.3: <一句话说明>"
git tag -a v2.1.3 -m "v2.1.3 <说明>"
git push origin main
git push origin v2.1.3
```
- 来源：RELEASING.md §2（行 92-100）；实际 tag `v2.1.2`、`v2.1.3` 已存在于仓库（`git tag` 实测）

### 步骤 3 · GitHub Release + 制品（必须带 tgz）
```bash
# 干净检出打包，避免把本地未跟踪文件打进制品
rm -rf /tmp/dsh-workplan-pack && git clone --depth 1 --branch v2.1.3 \
  git@github.com:abbaababa/dsh-workplan.git /tmp/dsh-workplan-pack
cd /tmp/dsh-workplan-pack && npm ci && npm run build && npm pack
sha256sum dsh-workplan-2.1.3.tgz                  # macOS: shasum -a 256

# 建 Release 并上传制品
gh release create v2.1.3 /tmp/dsh-workplan-pack/dsh-workplan-2.1.3.tgz \
  --repo abbaababa/dsh-workplan \
  --title "v2.1.3 — <说明>" \
  --notes-file docs/release-notes-2.1.3.md

# 验证制品可下载（HTTP 200，大小一致）
curl -sIL -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://github.com/abbaababa/dsh-workplan/releases/download/v2.1.3/dsh-workplan-2.1.3.tgz
```
- 历史教训（1.6.0）：Release 必须带 `assets`，否则索引源 `tarball:` 指向 GitHub Release 会 404。
- 来源：RELEASING.md §3（行 102-126）
- 实测事实（前期对话 m00001 + `gh release view v2.1.3`）：`v2.1.3` Release 已建，含 `dsh-workplan-2.1.3.tgz`，URL `https://github.com/abbaababa/dsh-workplan/releases/tag/v2.1.3`

### 步骤 4 · npm 发布
```bash
npm whoami                                          # 必须是拥有该包发布权的账号
npm publish                                         # 已登录直接发；CI 用 NPM_TOKEN + --provenance
npm view dsh-workplan@2.1.3 version dist.tarball    # 验证已发布
npm view dsh-workplan@latest version                # 必须等于新版本
```
- 来源：RELEASING.md §4（行 128-135）
- 实测事实（前期对话 m00001）：`npm view` → `version=2.1.3 latest=2.1.3`，tarball `https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-2.1.3.tgz`
- 注意：本地 `npm view` 在本次环境因沙箱 EPERM 缓存权限被拒，但以 RELEASING.md §4 文档命令 + 前期对话实测输出为准。

### 步骤 5 · 索引源（dsh-plugin-catalog，上游 CI，非本仓库权限）
- 链路：awesome-dsh-plugin 条目 → CI 探测 npm `dist-tags.latest` → 构建 `docs/index.json` → 发布 npm 包 `dsh-plugin-catalog` → jsDelivr → DSH 插件市场。
- 本仓库只完成「条目 PR」（改 `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball:` 指向刚发布的 Release），catalog 的 npm 发版由上游 CI 触发。
- 来源：RELEASING.md §5（行 137-155）

### 步骤 6 · 发布后记录
- 在 `docs/release-record-<version>-<date>.md` 写可复核证据：tag、commit、npm `shasum`、Release 制品 URL 与 sha256、catalog 版本、复验命令输出。
- 来源：RELEASING.md §6（行 157-161）；实测 `git log` 顶条 `7c054e9 docs: add reproducible release record for 2.1.3`

### 步骤 7 · 回滚
- npm：`npm unpublish dsh-workplan@<version>`（24h 内）或发 `-fix` 补丁。
- GitHub：`gh release delete v<version>`，tag 保留。
- 索引源：改回上一可用 `tarball` 并提 PR。
- 来源：RELEASING.md §7（行 163-167）

---

## 二、CI（自动验证，非手动步骤）

`.github/workflows/verify.yml` 在 `push: main` 与 `pull_request` 触发（`verify.yml:3-6`）：
1. `actions/checkout@v4`（`verify.yml:15-16`）
2. `actions/setup-node@v4`，node 22，cache npm（`verify.yml:18-22`）
3. `npm ci`（`verify.yml:24-25`）
4. `npm run verify`（`verify.yml:27-28` = `npm run check && npm test`）
5. `git diff --exit-code -- lib client.js` 失败当提交产物过期（`verify.yml:30-31`）

- 实测事实（前期对话 m00001）：2.1.2 与 2.1.3 的 CI run 均 success（run `42188255718`、`42192179962`）。

---

## 三、关键命令清单（一键脚本可直接复用）

| 序 | 命令 | 作用 | 来源 |
|---|---|---|---|
| 1 | `npm run build` | 构建：`rm -rf dist && tsc -p tsconfig.json && cp dist/*.js lib/ && cp dist/client.js client.js` | package.json:68 |
| 2 | `npm run check` | 类型检查 `tsc --noEmit` | package.json:69 |
| 3 | `npm test` | build + 全量用例 | package.json:70 |
| 4 | `npm run verify` | `check && test` | package.json:71 |
| 5 | `git status --short` | 发布前工作区干净检查 | RELEASING.md:25 |
| 6 | `git diff --exit-code -- lib client.js` | 构建产物无差异 | RELEASING.md:32 |
| 7 | `git add -A && git commit -m "..." && git tag -a vX -m "..."` | 提交并打注释 tag | RELEASING.md:95-97 |
| 8 | `git push origin main && git push origin vX` | 推送分支与 tag | RELEASING.md:98-99 |
| 9 | `git clone --depth 1 --branch vX ... && npm ci && npm run build && npm pack` | 干净打包生成 tgz | RELEASING.md:109-111 |
| 10 | `gh release create vX <tgz> --repo abbaababa/dsh-workplan --title "..." --notes-file ...` | 建 Release 并上传制品 | RELEASING.md:115-118 |
| 11 | `curl -sIL -o /dev/null -w '%{http_code} %{size_download}\n' <release-url>` | 验证制品可下载 | RELEASING.md:124-125 |
| 12 | `npm whoami` / `npm publish` | 登录校验 + 发布 | RELEASING.md:131-132 |
| 13 | `npm view dsh-workplan@X version dist.tarball` / `npm view dsh-workplan@latest version` | 验证已发布且 latest 正确 | RELEASING.md:133-134 |
| 14 | CI：checkout → setup-node22 → `npm ci` → `npm run verify` → `git diff --exit-code -- lib client.js` | 推送即自动验证 | verify.yml:15-31 |

---

## 四、给 T2（脚本工程）的要点提示
- 顺序铁律：检查 → 改版本四处 → 构建 → 测试 → 提交打 tag → 推 tag → GitHub Release(带 tgz) → npm publish → 验证。
- 两处「非本仓库权限」：索引源 catalog 由上游 CI 触发（步骤 5）、服务重启/加载新代码由运行环境负责（不在脚本内，前期对话中用户手动重启 PID 9137）。
- `npm publish` 需 `NPM_TOKEN` 或已登录账号；`gh release` 需 `gh` 已登录且对 `abbaababa/dsh-workplan` 有写权限。
- 回滚命令（步骤 7）建议也纳入脚本的 `--rollback` 分支。
