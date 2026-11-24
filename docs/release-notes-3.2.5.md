# dsh-workplan 3.2.5 发布说明（2026-11-24）

> 本版是 **3.2.3 + 3.2.4 + 3.2.5 的一次性合并发布**。3.2.3、3.2.4 从未单独提交或发布过（远端 tag 止于 `v3.2.2`，npm `latest` 为 `3.2.2`），其改动只以未提交工作区形式存在，无法在不编造历史的前提下拆开重建；按用户裁决，全部内容以 **3.2.5** 一个版本号发布，下文 3.2.3/3.2.4 的内容作为开发记录保留在 CHANGELOG。

## 一句话

**在"子任务注意力零丢失"的硬红线内省 token**：只删逐字重复、死代码、模型看不到的界面/磁盘内容；凡属唯一信息（最近对话背景、pending 兄弟目标）的删减全部回滚，并新增 4 例守门测试防止以后再犯。

## 红线：注意力零丢失（本版最重要的变化）

- 曾按"自包含任务"推断整块省略 1,200 字最近对话背景（−1,191 字/本）——**已回滚**。理由：任务里没写"它"，不代表用户上文没改过要求；唯一信息删除就是注意力丢失。
- 曾省掉 pending 兄弟的 60 字目标（≈−64 字/个）——**已回滚**。理由：目标决定执行者要不要等它、会不会重复采集同一批输入。
- 重复的 66 字《提交前自查》只留一份（逐字重复不增加约束），但在结果模板后补回一句 **19 字**短提醒（保留"提交前"位置的近期效应，成本只有原副本三成）。
- phase-1 不再收到 phase-0 的过时流程指令（与接续块"前三步已完成、不要重做"正面矛盾）；"已完成"这一事实仍由接续块保留。
- 新增 `tests/attention-red-line.test.ts`（4 例）：背景仍注入、pending 目标仍可见、自查句只 1 份且提交位置有提醒、phase-1 不带 phase-0 过时指令。以后任何"省 token"改动碰这四条，测试立即失败。

## 省 token（只删不丢信息的三类）

| 改动 | 省什么 | 为什么不算注意力丢失 |
|---|---|---|
| `dsh_workplan_update` 删除两个已停用参数（`extendMs`、`criterionApproval`） | 根工具面 10,098 → **9,622 字符**（−476/次请求） | 生产里判据 v2 恒关闭，这两个参数永远不可达；删的是"注定被拒的说明" |
| 规划器失败重试底稿加 24,000 字上限 | 校验上限 6 万字，最坏每次重试少付约 6 万输入字符 | 超限时改发"完整规则 + 错误清单"，规则一条不少；底稿正常时仍走短修复 |
| 删除重复自查副本 | −67 字符/本；补 19 字提醒后净 −48 | 同一句逐字出现两遍；保留的那句在规范旁，提醒句在提交位置 |
| phase-1 去掉 phase-0 残留 | −115 字符/本 | 已完成的准备工作指令，不是任务信息；矛盾句删除提高聚焦 |
| 测量脚本重写为按真实可见面计 | — | 旧脚本把根看不到的 3 个工具算进基线、又漏掉真实注入的 3 个，历次"省了多少"失真 |

## 3.2.3 / 3.2.4 带来的大块节省（首次随本版发布）

- 规划器请求拆 system/user：静态方法论进 system，跨重试字节级稳定，上游前缀缓存可命中。
- 计划消息与结果消息的大 JSON 移入 `source.durable`：可见文本不再带 22KB plan JSON，结果消息压到一行 ≤500 字。
- 五步法接续版 2,662 → 1,323 字符；负责人任务书 11,119 → 8,676；专家任务书 5,006 → 3,678；14 个工具 schema 行为长文 22,621 → 16,124（必填/枚举/阈值/错误码全部保留）。以上为 3.2.3 当时的样例口径，与本文件「验证」节的 3.2.5 新夹具数字不可直接横比。
- F11 部门汇总 `sources` 只写专家名，成果一句话由平台从成员结算行自动补全（每次结算省约 1,000 字符输出）。
- 全计划专家总数上限 `MAX_TOTAL_EXPERTS_PER_PLAN`（默认 40）与单阶段计划豁免，避免 15×25=375 人的无界回合。

## 验证

- `npm run build`（含 `tsc`）通过。
- `npm test`：**1514 例，pass=1513 / fail=0 / cancelled=0 / todo=1，exit=0**（含 `tests/attention-red-line.test.ts` 红线守门 4 例）。
- CI：tag 运行 `45334519374`，Build/Test（Node 22 与 26）与 Release 全 success。
- 终态实测（字符数非账单 token）：根工具面 9,622；负责人任务书 12,797；phase-1 接续 11,524；专家任务书 4,813；PROMPT_SECTION 3,663；规划器 5,757；加权样例 107,092。
- 版本统一 3.2.5：`package.json`、`package-lock.json`（两处）、`PLUGIN_VERSION`、`meta.version`、三份 README、`tests/fixtures/tool-surface.json`。

## 升级

```bash
dsh plugin --profile web add dsh-workplan@3.2.5
```

已运行的 DSH 不会自动加载新代码：请手动重启 DSH（或在插件管理里禁用再启用）。重启后在新会话调用 `dsh_workplan_status`，应显示 `v3.2.5`。

## 隐私与写入范围（不变）

- `~/.dsh/workplan/journal/`、`~/.dsh/workplan/lessons.jsonl`、`~/.dsh/workplan/notices.jsonl`（可用环境变量改到别处；0o600 文件 / 0o700 目录，拒绝写符号链接）。
- 工作目录下 `reports/`：`wp-start-evidence-<planId>-<subtask>.md`（插件自己写）与 `wp-settlement-<planId>-<subtask>.json`（任务书要求模型写的结算备份，消息丢失时用它结算）。不需要就在 `.gitignore` 里排除 `reports/`。

## 发布证据（2026-11-24 回填）

- 发布提交：`226b3679a091ed7b914481b0c192aca76a75917d`（tag 对象 `d59d7f965c6050919e7a6a0a3fd0c5dc1b7fcb48` 指向该提交）
- Git tag：`v3.2.5`
- 构建指纹：`f50f5d236f84fb66`（`cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16`；连续两次 `npm run build` 结果一致）
- GitHub Release：`https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.5`
  - 制品 `dsh-workplan-3.2.5.tgz`：2,062,293 字节，sha256 `71166781dbdf7092a5944cf22bddbfd31a20219f38f282707b3b18655d705f9b`（`gh release download` 下载复核一致）
- npm：`dsh-workplan@3.2.5`，`dist-tags.latest = 3.2.5`（2026-11-24T05:41:26Z），tarball `https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.2.5.tgz`，sha1 `9ac73385772c4814e3e5616cbc3f59ef586b84b5`，161 文件 / 2,062,293 字节（下载复核一致）；provenance 透明日志 `https://search.sigstore.dev/?logIndex=4070239801`
- CI：tag 运行 `45334519374`，Build（22/26）、Test（22/26）、Release 全 success（首次运行 `45333607979` 因 Node 22 的子测试嵌套问题失败，修复提交 `226b367` 后转绿）
- 索引源：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18401`（tarball 指向 v3.2.5；描述工具数 11→14）
