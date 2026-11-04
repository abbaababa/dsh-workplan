# 1.12.3 发布核验记录（2026-11-04 21:15，全部实测）

| 项目 | 结果 | 证据 |
|---|---|---|
| git tag | v1.12.3（annotated）→ 提交 c1d6b22 | `git ls-remote --tags` 返回 `refs/tags/v1.12.3^{} = c1d6b22…` |
| 远端 main | 6fb767d | `git push` 输出 `c1d6b22..6fb767d main -> main` |
| tag 与 main 差异 | 仅 `_t_release_1123_20261104/notes_1.12.3.md`（30 行，纯文档） | `git diff --stat v1.12.3 HEAD` |
| npm latest | 1.12.3 | `npm view dsh-workplan dist-tags.latest` → 1.12.3 |
| npm 校验 | shasum=51f8ca4b78481c4190ff240d1eff8fee66e86450，gitHead=c1d6b22… | `npm view dsh-workplan dist.shasum gitHead` |
| 干净目录安装 | 成功，INSTALLED_VERSION=1.12.3 | `/tmp/verify_workplan_1123`，0 vulnerabilities |
| 安装包内含修复 | hasAuditClarifyNeed=true，hasInlineAntecedent=true | node require `lib/understanding.js` 实测 |
| GitHub Release | 存在、非草稿、非预发布、Latest | `gh release list --limit 2 --json tagName,isLatest` → v1.12.3 latest=true |
| Release 页面 HTML | 本机 curl 超时（000，连接 github.com 25s 超时） | 属本机网络问题；GitHub API 与 gh 均确认页面存在，URL 见下 |

Release URL：https://github.com/abbaababa/dsh-workplan/releases/tag/v1.12.3

## 复现命令

```bash
npm view dsh-workplan dist-tags.latest dist.shasum gitHead
gh release list --limit 2 --json tagName,isLatest
git diff --stat v1.12.3 HEAD
```
