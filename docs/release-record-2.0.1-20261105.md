# dsh-workplan 2.0.1 发布记录（可复核）

- 发布时间：2026-11-05 13:11 起（Asia/Shanghai，本文件在发布后补写）
- 版本：**2.0.1**（package.json / package-lock.json 两处 / `src/host.ts` 的 `meta.version` / CHANGELOG / 两份 README 安装命令，共 7 个声明点；`tests/version-sync.test.ts` 全部断言一致）
- 主题：**自我学习与自我迭代**——第三阶段强制复盘、永久教训记忆、下次派发自动注入防再犯

## 1. 用户八条要求的落地对照

| # | 要求 | 落地位置 | 证据 |
|---|---|---|---|
| 1 | 自我学习与自我迭代能力 | `src/lessons.ts`（445 行）、`dsh_workplan_lessons` 工具、`src/runtime.ts` 的注入与落盘 | `tests/self-learning.test.ts` 10 条用例 |
| 2 | 每项工作完成后必须复盘问题/弯路/解决方式并永久记住 | 阶段三 `verification.retrospective` 必填；`recordLesson` 写 `~/.dsh/workplan/lessons.jsonl`；`renderLessonsBrief` 在下次派发时注入 | `validateRetrospective` 太薄即拒；`rankLessons` 按部门/关键词/重复次数排序 |
| 3 | 三阶段：计划 → 执行 → 验证 | `src/three-phase.ts`（1.13.0 引入，2.0.1 扩展复盘） | `dsh_workplan_verify` 只接受三阶段齐全的证据 |
| 4 | 第一、二阶段禁用 dsh-workplan 插件 | 插件文档与工具描述明确规定；阶段一/二只产出文字计划与执行记录，插件核验工具仅在阶段三可用 | `src/host.ts` 的 `PROMPT_SECTION` 与 `dsh_workplan_verify` 描述 |
| 5 | 第三阶段用插件验证是否满足全部要求 | `dsh_workplan_verify` 逐项核验 `acceptance`，本次发布即用该契约自检（见第 5 节） | 546 条测试全过 |
| 6 | 不得偏离用户要求 | 需求逐条映射到代码与测试，无删减 | CHANGELOG「用户要求逐条对照」 |
| 7 | 版本更新为 2.0.1 | 7 个版本声明点全部 2.0.1 | `tests/version-sync.test.ts` |
| 8 | 源码与版本同步发布到 GitHub 与索引源 | GitHub Release `v2.0.1` + npm `dsh-workplan@2.0.1` + awesome-dsh-plugin PR #12201 | 见第 3、4、6 节 |

## 2. 提交与 tag

| 项 | 值 |
|---|---|
| 发布提交 | `88098ef2f2015ae404133c5362deee6513177f34` |
| commit 标题 | `Release 2.0.1: 自我学习与自我迭代（阶段三复盘写入永久记忆，下次派发自动防再犯）` |
| tag | `v2.0.1`（annotated，tag 对象 `e3b8968a2f26e0145ebcb50d07a305c2b1201385`） |
| tag → 提交 | `git rev-list -n 1 v2.0.1` = `88098ef2f2015ae404133c5362deee6513177f34`（一致） |
| 远端 | `main` 已推送 `55b1f36..88098ef`；`git ls-remote --tags origin v2.0.1` 返回 `refs/tags/v2.0.1` |

复核命令：

```bash
cd plugins/dsh-workplan
git rev-parse HEAD
git rev-list -n 1 v2.0.1
git ls-remote --tags origin v2.0.1
```

## 3. 干净克隆门禁（tag 构建，不是本机脏树）

在 `/tmp/dsh-workplan-release-2.0.1`（`git clone --depth 1 --branch v2.0.1`）执行：

| 命令 | 结果 |
|---|---|
| `npm ci` | 退出 0 |
| `npm run check` | 退出 0（`tsc -p tsconfig.json --noEmit`） |
| `npm test` | **tests 546 / pass 546 / fail 0**，退出 0（基线 536 + 新增自我学习 10） |
| `npm pack` | `dsh-workplan-2.0.1.tgz`，**1,082,830 B**，sha256 `89cb21cde1ee18452e4c75803c3a9300d2ee04889ba6f4de3505fb5251d58b99` |

包清单 98 个文件；含 `lib/lessons.js`、`src/lessons.ts`、`docs/release-notes-2.0.1.md`；`*.orig` / `*.rej` / `*.tgz` 计数为 0。

## 4. GitHub Release

- URL：https://github.com/abbaababa/dsh-workplan/releases/tag/v2.0.1
- 资产：`dsh-workplan-2.0.1.tgz`，state `uploaded`，**1,082,830 B**
- 资产 digest（GitHub API 返回）：`sha256:89cb21cde1ee18452e4c75803c3a9300d2ee04889ba6f4de3505fb5251d58b99`（与本地 `shasum -a 256` 一致）

复核命令：

```bash
gh api repos/abbaababa/dsh-workplan/releases/tags/v2.0.1 \
  --jq '.assets[] | {name, size, state, digest}'
```

## 5. npm 发布（含延迟与短暂 staged 状态的如实记录）

| 时间 | 动作 | 结果 |
|---|---|---|
| 13:23 | 在干净克隆执行 `npm publish` | 输出 `+ dsh-workplan@2.0.1` 和「being processed」，但 `npm view dsh-workplan version` 仍为 1.12.3 |
| 13:24 | 立即重试 `npm publish --loglevel=http` | `E409`：`Cannot publish over previously staged version "2.0.1"`（版本已进入注册表处理队列，不能重复投递） |
| 13:29 | 再次查询 | `npm view dsh-workplan dist-tags version` = `{ latest: '2.0.1' }` / `2.0.1`，正式生效 |

结论：npm 12 的发布请求先进入注册表处理队列，`npm view` 有数分钟延迟；这**不是**失败，也**不需要**重复发布；同一版本二次投递会得到 E409。

发布后安装冒烟（`/tmp/dsh-wp-install-2.0.1`）：

```bash
npm i dsh-workplan@2.0.1
node -e "const p=require('dsh-workplan/package.json');console.log(p.version)"
```

结果：`2.0.1`；`node_modules/dsh-workplan/lib/lessons.js` 存在；`lib/host.js` 含 `dsh_workplan_lessons`；`src/lessons.ts` 存在。

## 6. 索引源（awesome-dsh-plugin）

| 项 | 值 |
|---|---|
| 仓库 | `awesome-dsh-plugin/awesome-dsh-plugin` |
| fork | `abbaababa/awesome-dsh-plugin`（已 merge-upstream 到上游 main） |
| 分支 | `bump-dsh-workplan-2.0.1` |
| 条目提交 | `aff9578b0ef442d324ade2a7000037f1d2083701` |
| PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12201 |
| 变更 | 仅 `data/plugins/abbaababa__dsh-workplan.yml`：`tarball` 指向 `v2.0.1` Release 资产，描述补自我学习闭环、三阶段与 11 个工具 |
| 校验 | 条目 YAML 通过 `js-yaml` 解析；`tarball` 为 GitHub Release 托管 URL；`package.json` 声明 `dsh.bundle` |

索引条目为「一个插件一个文件」，不修改生成的 README，符合仓库贡献指南。

## 7. 本次发布过程中遇到的两类问题与根因（自我复盘）

1. **新增测试首次 2 条失败**：`self-learning.test.ts` 中 planning 证据合计不足 40 字，先触发「计划太薄」错误，导致失败阶段与期望不符。根因是 fixture 只满足结构、不满足长度下限。修正：把 `problemAnalysis` 与 `approach` 加长到阈值以上，重跑 546 全过。
2. **npm 版本可见性延迟**：首次发布后 6 分钟内 `npm view` 仍显示旧版本，误以为发布失败，二次投递得到 E409。根因是注册表异步处理队列与本地查询缓存。修正：查询 `dist-tags` 与 `GET /dsh-workplan/2.0.1`（200）确认生效；不再重复投递。

两条经验已写入本次复盘，对应「发布前先跑干净克隆门禁」「npm 发布后以 dist-tags + 版本 JSON 双证据确认，不重复投递」。

## 8. 已知边界

- 本文件在 npm 2.0.1 发布完成之后补写并提交到仓库；npm 上的 2.0.1 tarball 是 13:23 构建的固化产物，不包含本文件。仓库与 GitHub Release 是权威来源，功能代码与测试不受影响。
- 证据契约在 2.0.1 变为「结果块必须带三阶段（含复盘）」；旧结果回放需显式传 `requirePhases: false`，已在 CHANGELOG「兼容边界」说明。

## 9. 勘误（2.0.2，2026-11-05）

- 本记录把用户要求 4「第一、二阶段禁用 dsh-workplan 插件」当成了产品级永久规则；用户随后澄清：该条只适用于 2026-11-05 本次优化会话，不是对所有后续会话的要求。
- 2.0.2 已更正提示词、`dsh_workplan_verify` 描述、运行时报错、README 与协作文档中的相关措辞；三阶段工作法与证据门禁保持不变。2.0.2 的完整证据见 `docs/release-record-2.0.2-20261105.md`。
