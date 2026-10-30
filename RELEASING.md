# 发布清单（RELEASING）

> 目标：一次发布做到「四个地方同一个版本、三个渠道同一份制品、任何人都能按这份清单复查」。
> 全程只用官方命令，不依赖个人机器上的临时状态。

## 0. 版本号规则

- **主版本**：破坏既有消息契约或回放兼容（`PLAN_VERSION` 变更、旧会话无法回放）。
- **次版本**：新增能力但只增不改（1.7.0 的结构化证据、async 派发、`status` 工具都属于此类）。
- **补丁版本**：只修 bug 或只改文档。

版本号只有四个声明点，由 `tests/version-sync.test.ts` 断言一致：

| 位置 | 说明 |
|---|---|
| `package.json` 的 `version` | npm 包版本 |
| `package-lock.json` 的 `version` 与 `packages[""].version` | 锁文件根版本 |
| `src/host.ts` 的 `meta.version` | 宿主面板显示的版本 |
| `CHANGELOG.md` 的 `## <version> — <date>` | 人读的变更记录 |

## 1. 发布前检查（全部通过才继续）

```bash
# 1. 工作区干净（未提交改动必须先提交或回滚）
git status --short

# 2. 版本四处一致 + CHANGELOG/README 已更新
npm run check
npm test

# 3. 生成物可复现：重新构建后 git 不应有差异
npm run build && git diff --exit-code -- lib client.js
```

`npm test` 会先构建再跑全部用例；`npm run check` 是 `tsc --noEmit`。任何一步失败都不要打 tag。

## 2. 提交与打标签

```bash
git add -A
git commit -m "Release 1.7.0: collaboration contract, async dispatch, write guards"
git tag -a v1.7.0 -m "v1.7.0 协作契约版"
git push origin main
git push origin v1.7.0
```

## 3. GitHub Release + 制品

Release 必须**带 tgz 制品**。历史教训（1.6.0）：Release 存在但 `assets: []`，而索引源的
`tarball:` 指向 GitHub Release，用户点下载会拿到旧版本或 404。

```bash
# 干净检出打包，避免把本地未跟踪文件打进制品
rm -rf /tmp/dsh-workplan-pack && git clone --depth 1 --branch v1.7.0 \
  git@github.com:abbaababa/dsh-workplan.git /tmp/dsh-workplan-pack
cd /tmp/dsh-workplan-pack && npm ci && npm run build && npm pack
sha256sum dsh-workplan-1.7.0.tgz    # macOS: shasum -a 256

# 建 Release 并上传制品（--notes-file 可用 CHANGELOG 对应段落）
gh release create v1.7.0 /tmp/dsh-workplan-pack/dsh-workplan-1.7.0.tgz \
  --repo abbaababa/dsh-workplan \
  --title "v1.7.0 — 协作契约版" \
  --notes-file docs/release-notes-1.7.0.md
```

验证制品真的可下载（HTTP 必须 200，大小与本地一致）：

```bash
curl -sIL -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://github.com/abbaababa/dsh-workplan/releases/download/v1.7.0/dsh-workplan-1.7.0.tgz
```

## 4. npm 发布

```bash
npm whoami                 # 必须是拥有该包发布权的账号
npm publish                # 已登录时直接发；CI 用 NPM_TOKEN + --provenance
npm view dsh-workplan@1.7.0 version dist.tarball
npm view dsh-workplan@latest version   # 必须等于新版本
```

## 5. 索引源（dsh-plugin-catalog）

链路：`awesome-dsh-plugin` 仓库条目 → CI 探测 npm `dist-tags.latest` → 构建 `docs/index.json`
→ 发布 npm 包 `dsh-plugin-catalog` → jsDelivr → DSH 插件市场。

本仓库只能完成**条目 PR**；catalog 的 npm 发版由上游 CI 触发，不属于本仓库权限。

1. 确认上游条目 `data/plugins/abbaababa__dsh-workplan.yml` 的版本与 `tarball:` 指向刚发布的 Release：
   `tarball: https://github.com/abbaababa/dsh-workplan/releases/download/v1.7.0/dsh-workplan-1.7.0.tgz`
2. 若版本未更新，fork 上游仓库、改这一行、提 PR（只改必要字段，便于维护者合并）。
3. 合并后按下面三条复验（换掉 `<latest>`）：

```bash
npm view dsh-plugin-catalog@latest version          # 应晚于本次合并时间
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json \
  | grep -o '"id":"dsh-workplan"' | head -1          # 应命中
```

4. 在 DSH 里执行 `plugin_market list_plugins(query="dsh-workplan")`，应能看到条目并能安装。

## 6. 发布后记录

在 `docs/release-record-<version>-<date>.md` 写下可复核的证据：tag、commit、npm `shasum`、
Release 制品 URL 与 sha256、catalog 版本、复验命令输出。发布记录不是仪式，它是下一次排障的
唯一时间线。

## 7. 回滚

- npm：`npm unpublish dsh-workplan@<version>`（24 小时内）或发布一个 `-fix` 补丁版本，不覆盖旧版本号。
- GitHub：`gh release delete v<version>`，tag 保留可追溯。
- 索引源：改回上一个可用 `tarball` 并提 PR。
