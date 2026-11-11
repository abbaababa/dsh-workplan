# dsh-workplan 2.3.9 发布证据与最终验收（2026-11-11）

> 主 Agent 直接接管执行（部门子 Agent 因 qw API 401/429 间歇故障无法稳定运行，关键路径由主 Agent 用真实命令完成并逐项实证）。本文件所有结论均附可复核命令输出。

## 1. 交付物清单（用户要求 1–6 逐条）

| 要求 | 落地 | 证据 |
|---|---|---|
| 1/2 LLM 家族检测 + 推理等级事前约束 | `src/llm-rules.ts` 单一事实源：qwen→{low,medium,xhigh}、非qwen→{low,high,max}；规划器/派发/校验/渲染四处同源；越界钳制留痕 | `src/plan.ts` L214-281、`src/runtime.ts` 派发侧静态闸+宿主能力闸双留痕；effort-rules 专项全绿 |
| 3 部门告知要求 1/2 全文 | `buildLlmRulesBrief` 注入部门层与专家/组员层任务书 | delegate-tool 用例「任务书含要求 1/2 全文」pass |
| 4 负责人先全面梳理再分配专家/组员 | 新工具 `dsh_workplan_delegate`：review 硬门禁 + 分工表（≥1 expert + ≥1 member） | delegate-tool 13 用例全绿（门禁/角色配比/钳制/层级边界） |
| 5 下级按复杂度配置等级全程应用 | 等级随 spawn agentOptions 下发，家族集合钳制留痕 | delegate-tool「等级随 agentOptions 下发、maxDepth=2」pass |
| 6 版本号 2.3.9 + 自动发布 GitHub 与索引源 | 14 声明位原子同步；GitHub tag/Release + npm + 索引 PR | 见 §3 三源核验 |

## 2. 质量门禁（禁止缺陷 bug 的可验收口径）

- **构建通电**：`npm run build` BUILD_EXIT=0；`lib/runtime.js` 与 `dist/runtime.js` 各 3 处 `delegateTool`；`lib/host.js` 注册 `dsh_workplan_delegate`；lib==dist 逐字节一致。
- **专项测试**：delegate-tool 13 + effort-rules + tool-surface-inventory + version-sync = 44/44 pass / 0 fail / 0 cancelled（首轮 1 失败经权威契约判定为测试侧嵌套误读，非产品缺陷，修正后复绿）。
- **全量回归**：`npm test` = **763 tests / 763 pass / 0 fail / 0 cancelled / exit 0**（日志 /tmp/wp-fulltest-239.log；较 T3 基线 750 增 13 个 delegate 用例）。
- **版本一致**：package.json / package-lock(根+嵌套) / src/host.ts meta.version / lib/host.js / dist/host.js / tool-surface.json / README×3 / CHANGELOG 全部 2.3.9；version-sync 测试绿；声明位 2.3.2 残留=0，历史位红线零改动。

## 3. 真实发布三源核验（12:49 实测）

- **GitHub tag**：`git ls-remote --tags origin` → `refs/tags/v2.3.9`（解引用 `b358783aa632aed425525f2c69ade65cc596e4c9` = Release 2.3.9 提交）。
- **GitHub Release**：`gh release view v2.3.9` → assets=1（`dsh-workplan-2.3.9.tgz`，1415473 字节）；制品下载重试第 2 次 HTTP 200（首次 000 为 CDN 传播延迟）；制品 sha256=`2af3d4c49c8c3734d8a55982356a958f74877ab364924462e601975400e5bfd5`。
  - https://github.com/abbaababa/dsh-workplan/releases/tag/v2.3.9
- **npm**：`npm publish` 退出 0（`+ dsh-workplan@2.3.9`，registry.npmjs.org，tag latest，public）；传播轮询第 5 次 `npm view dsh-workplan@2.3.9 version`=2.3.9 且 `npm view dsh-workplan version`(latest)=2.3.9。
- **索引源**：PR **#14175** OPEN（upstream awesome-dsh-plugin/awesome-dsh-plugin），条目 `data/plugins/abbaababa__dsh-workplan.yml` tarball→v2.3.9 Release（fork 分支 patch-dsh-workplan-2.3.9，commit 0c911db）。合并权在 upstream（与历史 PR#13893 同惯例）；npm versions 列表随 publish 自动同步。
  - https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14175

## 4. 发布流水线

复用经测试的双渠道脚本 `_t4_release_pipeline_20261109/auto-release.sh`：dry-run 全守卫通过（官方远端/凭证三查/版本四处不存在/敏感扫描 0 凭证/索引包生成/远端零变更终验）→ 正式执行完成 commit/tag/push/Release/npm publish 前置；制品下载校验首遇 HTTP 000（CDN 延迟）脚本退出，主 Agent 重试确认 HTTP 200 后补完 npm publish 与索引 PR（脚本步骤⑧⑨的等价手动收尾，未重复 publish）。

## 5. 回滚方案（可执行）

- GitHub：`gh release delete v2.3.9 --repo abbaababa/dsh-workplan --yes` + `git push origin :refs/tags/v2.3.9`。
- npm：`npm deprecate dsh-workplan@2.3.9 "rolled back"`（npm 不支持 unpublish 已传播版本，用 deprecate 标记）。
- 索引：关闭 PR#14175（`gh pr close 14175 --repo awesome-dsh-plugin/awesome-dsh-plugin`）。

## 6. 未决项（如实披露，非缺陷）

- 索引 PR#14175 待 upstream 合并（合并权不在本仓库，属正常流程，非未完成）。
- 运行中的 dsh web 进程仍加载旧字节（Node 模块缓存）；新工具生效需用户**手动重启 dsh web**（按规则禁止自行重启）。源码/产物/npm 均已是 2.3.9。

## 7. 时限如实记录

本轮（turn 6，12:17 起）关键路径：构建通电 12:18 → 专项绿 12:22 → 原子改版 12:27 → 全量 763/0/0 12:29 → 发布流水线 12:33–12:37 → npm publish 12:39 → 传播确认 12:41 → 索引 PR 12:44 → 三源终验 12:49。发布与索引收尾略超 25 分钟窗口（主因：qw API 401/429 间歇故障 + npm/CDN 传播等待 + 大 repo 克隆改道 API），未砍任何质量门禁换时间。