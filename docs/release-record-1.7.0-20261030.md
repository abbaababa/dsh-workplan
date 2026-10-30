# 1.7.0 发布记录（2026-10-30）

可复核的一次性时间线。所有值来自发布当时的命令输出，命令可原样重跑。

## 版本与提交

| 项 | 值 |
|---|---|
| 版本 | `1.7.0` |
| 提交 | `cb40b7a8e0af05378558fba15c629d7ffdc6f368`（`Release 1.7.0: collaboration contract, async dispatch, write guards`） |
| 标签 | `v1.7.0`（annotated） |
| 分支 | `main` → `e36eeb9..cb40b7a` |
| CI | GitHub Actions `verify` 在 `cb40b7a` 上 **success** |

## GitHub Release

| 项 | 值 |
|---|---|
| URL | https://github.com/abbaababa/dsh-workplan/releases/tag/v1.7.0 |
| 制品 | `dsh-workplan-1.7.0.tgz`，311 709 字节 |
| 制品 sha256 | `85bdb32f4747bb8c13e5bb0d139b6b4c18b6487d07ef296d97c957a148e886df` |
| 可用性 | `curl -sIL` → **HTTP 200** |

## npm

| 项 | 值 |
|---|---|
| 包 | `dsh-workplan@1.7.0`（public，24 个文件解包后 1.0 MB） |
| dist-tags | `latest = 1.7.0`（`npm view dsh-workplan@latest version` → `1.7.0`） |
| shasum | `fa065c4fbdd53b97e91d7329192419139c28cad7` |
| integrity | `sha512-90e4AJ5WwbTFojqLCNdLN3ouuEBncJ5ORVskao2aDJRU4IN7fUwwwOwx9YY1vgUdnAGNudsI/21b4y09dgdAGg==` |
| tarball | https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-1.7.0.tgz |

## 索引源（dsh-plugin-catalog）

| 项 | 值 |
|---|---|
| 上游条目 | `awesome-dsh-plugin/awesome-dsh-plugin` → `data/plugins/abbaababa__dsh-workplan.yml` |
| 改动 | `tarball:` 由 `v1.5.0/dsh-workplan-1.5.0.tgz` 改为 `v1.7.0/dsh-workplan-1.7.0.tgz` |
| PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10528（fork 分支 `bump-dsh-workplan-1.7.0`，提交 `dc2c49b`） |
| 状态 | **待上游合并**；catalog 的 npm 发版由上游 CI 触发，本仓库无权限 |

合并后复验（`s-maxage=43200`，CDN 最长 12 小时）：

```bash
npm view dsh-plugin-catalog@latest version
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -o '"id":"dsh-workplan"' | head -1
```

## 本地与远端一致性

```bash
git tag -l 'v1.7.0'                       # v1.7.0
git rev-parse v1.7.0^{commit}             # cb40b7a...
git status --short                        # 干净（发布记录这次提交除外）
npm test                                  # 180 pass / 0 fail
npm run check                             # 通过
```
