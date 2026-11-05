# dsh-workplan 2.0.2 发布记录（可复核）

- 发布时间：2026-11-05 13:45–14:10（Asia/Shanghai）
- 版本：**2.0.2**（`package.json` / `package-lock.json` 两处 / `src/host.ts#meta.version` / CHANGELOG / README 两份安装命令，由 `tests/version-sync.test.ts` 断言一致）
- 主题：更正「第一、二阶段禁用 dsh-workplan 插件」的适用范围——只适用于 2026-11-05 本次优化会话，不是对所有后续会话的永久产品规则

## 1. 为什么发 2.0.2

用户在 2.0.1 发布后澄清：原要求 4「第一、二阶段禁用 dsh-workplan 插件」是**本次会话内**对优化过程的约束，不是要求插件对所有未来会话禁用。1.13.0 起该条被写成产品级规则（子 Agent 提示词、`dsh_workplan_verify` 描述、运行时报错、README、协作文档），属于对需求范围的误读；2.0.2 全面更正措辞与说明，三阶段契约与自我学习机制不变。

## 2. 提交与 tag

| 项 | 值 |
|---|---|
| 发布提交 | `17707511cafe2a9772eb630d3d8ccce1c7a22ccd` |
| commit 标题 | `Release 2.0.2: 更正「第一、二阶段禁用插件」的适用范围（仅 2026-11-05 本次会话，非永久规则）` |
| tag | `v2.0.2`（annotated，tag 对象 `ae402a8441267983195257f35ecc30644a45d281`） |
| tag → 提交 | `git rev-list -n 1 v2.0.2` = `17707511cafe2a9772eb630d3d8ccce1c7a22ccd`（一致） |
| 远端 | `main` 已推送 `ccd362a..1770751`；`git ls-remote --tags origin v2.0.2` 返回 `refs/tags/v2.0.2` |

## 3. 干净克隆门禁（tag 构建）

在 `/tmp/dsh-workplan-release-2.0.2`（`git clone --depth 1 --branch v2.0.2`）执行：

| 命令 | 结果 |
|---|---|
| `npm ci` | 退出 0 |
| `npm run check` | 退出 0（`tsc -p tsconfig.json --noEmit`） |
| `npm test` | **tests 546 / pass 546 / fail 0**，退出 0 |
| `npm pack` | `dsh-workplan-2.0.2.tgz`，**1,088,610 B**，sha256 `5e9dcc26a0e1ed204073ac0a1bf9ebc71b43403a1cd50a9ef68925999020f7f2` |

包清单 100 个文件；含 `lib/lessons.js`、`docs/release-notes-2.0.2.md`，`version` 为 2.0.2。

## 4. GitHub Release

- URL：https://github.com/abbaababa/dsh-workplan/releases/tag/v2.0.2
- 资产：`dsh-workplan-2.0.2.tgz`，state `uploaded`，1,088,610 B
- 资产 digest（GitHub API 返回）：`sha256:5e9dcc26a0e1ed204073ac0a1bf9ebc71b43403a1cd50a9ef68925999020f7f2`（与本地 `shasum -a 256` 一致）

## 5. npm 发布

- 2026-11-05 14:02 在干净克隆执行 `npm publish`，输出 `+ dsh-workplan@2.0.2`；注册表提示进入处理队列。
- 复核口径：`npm view dsh-workplan dist-tags version` 与 `GET https://registry.npmjs.org/dsh-workplan/2.0.2` 双证据（2.0.1 的经验：处理需数分钟，期间重复投递会得到 E409）。
- 发布结果：**2026-11-05 14:08 注册表可见**——`npm view dsh-workplan dist-tags version` 返回 `{ latest: '2.0.2' }`，`GET https://registry.npmjs.org/dsh-workplan/2.0.2` 返回 200。
- 安装冒烟（npm 公开包）：`/tmp/dsh-wp-install-2.0.2` 执行 `npm i dsh-workplan@2.0.2` 后核对——version 2.0.2、`lib/lessons.js` 存在、`lib/three-phase.js` 已不含「阶段一、二：dsh-workplan 插件禁用」、`PHASE_GATE` 与「缺少 planning / execution 证据时返回 PHASE_GATE」文案保留、注册工具 11 个。

## 6. 索引源（awesome-dsh-plugin）

| 项 | 值 |
|---|---|
| PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12201 |
| 条目提交 | `377bb700b49b7eb447270132540ea02f77bc1555` |
| 分支 | `abbaababa:bump-dsh-workplan-2.0.1`（PR 内已更新为 2.0.2） |
| 变更 | `data/plugins/abbaababa__dsh-workplan.yml` 的 `tarball` 指向 `v2.0.2` Release 资产 |
| 校验 | 条目 YAML 通过 `js-yaml` 解析；`tarball` 为 GitHub Release 托管 URL；`package.json` 声明 `dsh.bundle` |

## 7. 本次改了什么（可复核）

| 文件 | 变更 |
|---|---|
| `src/three-phase.ts` | 提示词删除「阶段一、二：dsh-workplan 插件禁用」，改为「阶段一、二写全证据；调用 verify 会因缺少前两阶段证据返回 PHASE_GATE（证据门禁，不是禁用插件）」；头部注释同步 |
| `src/host.ts` | `dsh_workplan_verify` 描述由「阶段一、二禁用本插件」改为「缺少 planning / execution 证据时返回 PHASE_GATE 与待补项」 |
| `src/runtime.ts` | `PHASE_GATE` 报错文案由「插件在阶段一、二禁用」改为「阶段三核验缺少前两阶段证据」 |
| `README.md` / `README.en.md` | 增加 2.0.2 更正说明：该约束仅适用于本次会话；主 Agent 任何阶段都可用计划/派发/查询/改判工具 |
| `docs/collaboration.md`、`docs/cc/AVA-VULNERABILITY-ANALYSIS.md` | 表格与措辞由「禁用」改为「证据门禁」，并加 2.0.2 更正说明 |
| `tests/three-phase.test.ts` | 断言提示词不再包含「插件禁用」；同时继续断言阶段三门禁与 `PHASE_GATE` |
| `CHANGELOG.md`、`docs/release-notes-2.0.2.md` | 新增 2.0.2 条目与发布说明；2.0.1 条目加勘误 |

## 8. 未变的部分

- 三阶段「规划 → 执行 → 验证」仍是产品功能；完成判定仍要求 `phases` 齐全。
- `dsh_workplan_verify` 仍只接受三阶段齐全的证据；缺 planning/execution 仍返回 `PHASE_GATE`。
- 阶段三复盘与永久教训记忆机制完全不变；工具面仍是 11 个。

## 9. 复核附录

```bash
# 版本与 tag
cd plugins/dsh-workplan && git rev-parse HEAD && git rev-list -n 1 v2.0.2
# 干净克隆门禁
git clone --depth 1 --branch v2.0.2 git@github.com:abbaababa/dsh-workplan.git /tmp/dsh-workplan-release-2.0.2
cd /tmp/dsh-workplan-release-2.0.2 && npm ci && npm run check && npm test && npm pack
# 发布核对
npm view dsh-workplan dist-tags version
gh api repos/abbaababa/dsh-workplan/releases/tags/v2.0.2 --jq '.assets[] | {name, size, state, digest}'
gh pr view 12201 --repo awesome-dsh-plugin/awesome-dsh-plugin
```
