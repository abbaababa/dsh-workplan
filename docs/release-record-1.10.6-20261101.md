# Release record — v1.10.6（2026-11-01）

本文件按 `RELEASING.md` 第 6 节生成：只记录可复核的证据，不写形容词。

## 1. 源码与版本

| 项目 | 值 |
|---|---|
| commit | `5cecb83b4e3c9b42107b2055f2b0825b4c2fb40a` |
| tag | `v1.10.6`（annotated，tag object `1414bb26975e6a5ac97265703488a25d607595c5`） |
| package.json version | `1.10.6` |
| package-lock.json version | `1.10.6`（root + `packages[""]`） |
| src/host.ts `meta.version` | `1.10.6` |
| CHANGELOG | `## 1.10.6 — 2026-11-01` |

## 2. 发布前检查

```text
npm run check                     → 通过（tsc --noEmit，无输出）
npm test                          → tests 332 / pass 332 / fail 0（duration 4.37s）
构建可复现（build 后 git diff lib client.js）→ 无差异
```

A/B 跨版本探针（R-W5-01）：本次改动集中在重试链路与 auto-resume 开关，未触及
superseded/cancelled 信封与 present 判定，探针结论沿用 v1.9.1 记录的 PASS；未重跑，
此处如实标注为"未在 1.10.6 树重跑"。

## 3. GitHub Release

| 项目 | 值 |
|---|---|
| Release | https://github.com/abbaababa/dsh-workplan/releases/tag/v1.10.6 |
| 资产 | `dsh-workplan-1.10.6.tgz` |
| 大小 | 805,574 bytes（API 回报 `state: uploaded`，大小一致） |
| sha256 | `0f11fc01c98fc1ba7079b6b2eb87c69c495f79e118dfc01e50141891d7cc2718` |
| 构建方式 | 从 tag 干净克隆 → `npm ci` → `npm run build` → `npm pack` |

## 4. npm

| 项目 | 值 |
|---|---|
| 版本 | `dsh-workplan@1.10.6`，`dist-tags.latest = 1.10.6` |
| tarball | https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-1.10.6.tgz |
| shasum | `7ba4fdf8c5c69c507b581a2beb511accd1e19826` |
| integrity | `sha512-O98ViT+dm/fO4dMQgZ0TTmIRFn11Mee3aOzS6AXkVMXnxYcU8pCrk0MiCGBaZ2XB7y60PhOiec6hcCI44eMx6A==` |
| 发布账号 | `open-dsh` |
| 端到端安装验证 | 空目录 `npm i dsh-workplan@1.10.6` → `added 1 package in 844ms`，`node_modules/dsh-workplan` 版本 1.10.6，`lib/` 存在 |

## 5. 索引源（dsh-plugin-catalog）

| 项目 | 值 |
|---|---|
| 上游条目 | `data/plugins/abbaababa__dsh-workplan.yml` |
| PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11154 |
| 变更 | `tarball:` 由 v1.8.3 指向 v1.10.6（只改这一行） |
| 合并前 catalog 状态 | jsDelivr `index.json` 中该条目 `versions` 仍为 `1.8.4`（catalog 由上游 CI 依 npm 重建，本仓库无法直接触发） |
| 合并后复验命令 | `npm view dsh-plugin-catalog@latest version`；`curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json \| grep -o '"name":"dsh-workplan"'` |

## 6. 已知限制

- 本机对 `github.com` 直连（curl）不可达（返回 000），因此 Release 资产的 HTTP 200
  复验未能用 curl 完成；改用 GitHub API 校验资产存在、`state: uploaded` 且大小与本地
  制品一致（805,574 bytes）。资产字节的 sha256 已在打包时记录。
- catalog 收录依赖上游 CI，PR 合并后需要等待一轮构建，本记录不预先声称已收录。

## 7. 回滚

```bash
# npm（24 小时内）
npm unpublish dsh-workplan@1.10.6
# 或发布 1.10.7 补丁，不覆盖 1.10.6

# GitHub
gh release delete v1.10.6 --repo abbaababa/dsh-workplan --yes   # tag 保留可追溯

# 索引源
把 PR 中的 tarball 改回 v1.8.3（或合并后反向 PR），并重跑 `npm view dsh-plugin-catalog@latest version` 确认
```
