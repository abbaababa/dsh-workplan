# T2 版本确定与发布渠道核对记录（2026-11-06）

本文件为可复现证据记录，供 T4（运维发布）接手。

## 一、包信息（读取 package.json）

| 字段 | 值 |
|---|---|
| name | `dsh-workplan` |
| 当前 version | `2.1.1` |
| publishConfig.access | `public` |
| main | `lib/host.js` |
| repository | git+https://github.com/abbaababa/dsh-workplan.git |

## 二、版本冲突结论（A2）

- 远端 registry 已发布版本共 28 个，其中已含 `2.1.1`，且 `latest` dist-tag 指向 `2.1.1`。
- 本地 `package.json` 版本仍为 `2.1.1`，与远端冲突，**不可重复发布**（npm 拒绝覆盖已发布版本）。
- 「修正后的最新源代码」= `PLANNER_TIMEOUT_MS` 120000 → 300000 的超时修复，属于**未提交的工作区改动**（`git status`：`M lib/runtime.js`、`M src/runtime.ts`）。
- 远端 2.1.1 tarball 内 `PLANNER_TIMEOUT_MS = 120000`（旧值），本地为 `300000`，证明该修复**确为 2.1.1 之后的新改动**，尚未对外发布。
- **目标发布版本号：`2.1.2`**（patch 升级，属 bug 修复级别，符合 semver 递增规则）。`2.1.2` 远端返回 HTTP 404，未被占用。

## 三、版本号规范性（A1）

- `2.1.2` 符合 semver `MAJOR.MINOR.PATCH` 规范（严格正则通过）。

## 四、发布渠道与凭证（A3）

- 发布渠道：`https://registry.npmjs.org/`
- 发行 tag：`latest`（默认；package.json 无自定义 dist-tag，publishConfig 仅 access=public）
- 凭证：`~/.npmrc` 已配置 `//registry.npmjs.org/:_authToken`（40 字符，前缀 `npm_`，值已脱敏不落盘）。
- 凭证可用性验证（可复现）：
  - `npm whoami --cache /tmp/t2-npmcache` → `open-dsh`（通过）
  - 直连 `GET https://registry.npmjs.org/-/whoami`（Authorization: Bearer <token>）→ `{"username":"open-dsh"}`（通过）

## 五、已知环境风险（需转达 T4）

- 默认 npm 缓存目录 `/Users/open/.npm/_cacache/tmp` 存在 root 属主文件，导致 `npm whoami`（不带 --cache）报 `EPERM`。
- **规避方式**：发布时使用 `npm publish --cache /tmp/<可写目录>`，或先 `sudo chown -R 501:20 /Users/open/.npm`（需提权，子 Agent 无此权限）。
