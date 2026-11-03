# dsh-workplan 1.12.0 发布记录（可复核）

- 发布时刻：2026-11-03 10:00–10:17（Asia/Shanghai）
- 发布人：主 Agent（abbaababa / npm open-dsh）
- 版本：**1.12.0**（10 个声明点一致，`verify_version.mjs` → `ALL_EQUAL=1.12.0`）

## 1. 提交与 tag

| 项 | 值 |
|---|---|
| 发布提交 | `6f5bd88a990ead0b98a858277c535058985dd91f` |
| commit 标题 | `Release 1.12.0: rebase T11 low-risk patches, acceptance IDs, auto-dispatch, collapsible step rows` |
| tag | `v1.12.0`（annotated，tag 对象 `7f4bf784799170eeb182234af4dcedbc43677ed5`） |
| tag → 提交 | `git rev-list -n 1 v1.12.0` = `6f5bd88a990ead0b98a858277c535058985dd91f`（一致） |
| 远端 | `main` 已推送 `f5160ff..6f5bd88`；`git ls-remote --tags origin v1.12.0` 返回 `refs/tags/v1.12.0` |

复核命令：

```bash
cd plugins/dsh-workplan
git rev-parse HEAD
git rev-list -n 1 v1.12.0
git ls-remote --tags origin v1.12.0
```

## 2. 干净克隆门禁（tag 构建，不是本机脏树）

在 `/tmp/dsh-workplan-release-1.12.0`（`git clone --depth 1 --branch v1.12.0`）执行：

| 命令 | 结果 |
|---|---|
| `npm ci` | 退出 0 |
| `npm run check` | 退出 0（`tsc -p tsconfig.json --noEmit`） |
| `npm test` | **tests 459 / pass 459 / fail 0**，退出 0 |
| `npm run build` | 退出 0 |
| `npm pack` | `dsh-workplan-1.12.0.tgz`，**983,635 B**，sha256 `ebda99d10eda30e73f7061d0c5ed22b2b428a7f05b3a838ede600477dcd3c54e` |

包清单 83 个文件；含 `lib/departments.js`、`lib/understanding.js`、`lib/replan.js`、`docs/release-notes-1.12.0.md`（5,444 B，含「10 个声明点」）；`*.orig` / `*.rej` / `*.tgz` 计数为 0。

## 3. GitHub Release

- URL：https://github.com/abbaababa/dsh-workplan/releases/tag/v1.12.0
- 资产：`dsh-workplan-1.12.0.tgz`，state `uploaded`，**983,635 B**
- 资产 digest（GitHub API 返回）：`sha256:ebda99d10eda30e73f7061d0c5ed22b2b428a7f05b3a838ede600477dcd3c54e`
- 实际下载复核：`gh release download v1.12.0 --pattern 'dsh-workplan-1.12.0.tgz'` 成功，落盘 983,635 B，`shasum -a 256` 与 digest 完全一致。
- 直连 `curl https://github.com/.../download/...` 在本机网络返回 `HTTP=000`（连接失败，非 404）；因此本条不使用 curl 200 作为证据，改以上面的 API state + 实际下载哈希为证据。

复核命令：

```bash
gh api repos/abbaababa/dsh-workplan/releases/tags/v1.12.0 \
  --jq '{tag:.tag_name,assets:[.assets[]|{name,size,state,digest}]}'
```

## 4. npm

| 项 | 值 |
|---|---|
| `npm publish` | 成功（`+ dsh-workplan@1.12.0`） |
| `npm view dsh-workplan@latest version` | `1.12.0` |
| `npm view dsh-workplan@1.12.0 version` | `1.12.0` |
| tarball | `https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-1.12.0.tgz` |
| `dist.shasum` | `9be532629f357cc850e0b2fc6f3b8836daf2ac8d` |
| `dist.integrity` | `sha512-K12M8xrT19AjFA6lMy/2QvpiEC7fwVGebhBpdsZT4G/mf00MEvYQvsEtxyQXPbOIbNlZnBOA6RK+4kGHPhfS2Q==` |

安装烟测（`/tmp/dsh-wp-install-1.12`）：

```text
npm i dsh-workplan@1.12.0
installed 1.12.0
node_modules/dsh-workplan/lib/host.js 中 createHandoffTool 出现 3 次
包内 docs/release-notes-1.12.0.md 含「10 个声明点」
```

## 5. 索引源

- 上游仓库：`awesome-dsh-plugin/awesome-dsh-plugin`
- 条目：`data/plugins/abbaababa__dsh-workplan.yml`，`tarball` 改为
  `https://github.com/abbaababa/dsh-workplan/releases/download/v1.12.0/dsh-workplan-1.12.0.tgz`
- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11515
- 状态：**OPEN / MERGEABLE**，diff 为 1 行新增 + 1 行删除（只改 tarball）
- 边界：合并由上游维护者决定；合并后上游 CI（cron）重建 `dsh-plugin-catalog`，jsDelivr 有缓存。**合并前不能写「索引已生效」。**

## 6. 发布决策（用户答复）

| 问题 | 用户选择 | 落地 |
|---|---|---|
| 智能验收口径 | 固定样例 + 代码护栏 | 发布说明按「代码级护栏 + 固定样例」限定，不宣称真实模型命中率 |
| 自动派发默认值 | 默认开启（plan 模式除外） | `autoDispatch` 默认 true；`autoDispatch:false` / `DSH_WORKPLAN_AUTO_DISPATCH=0` 可关 |
| 截图红圈位置 | 「分步进度」那几行 | 与实现一致：默认收起，点击行或 Enter/Space 展开 |

## 7. 已知限制（未折算为已修）

- U-17：42 条 `present` 缺陷中 28 条仍无逐条复验；D-01 / D-13 属高风险补丁范围（D-13 的级联修复已在 1.11.1）。
- 真实模型 20 条任务的理解质量 / 部门命中率未跑；T10 的 41/41 是历史计划回放，只证明旧计划不被误伤。
- 自动派发的宿主端到端未单独演练（配置解析与计划消息有单测）。
- 真实浏览器点击未在带登录态的 3080 页面完成（组件级 17/17 已过）。
- 当前宿主进程仍是 v1.11.1 旧构建；需要重启 DSH Web 才会加载 1.12.0（插件为 `link:` 安装，重启即可，无需重新安装）。
- 索引 PR 未合并，catalog npm 包未重建。
