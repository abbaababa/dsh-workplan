# T8 既有机制无退化门禁复核（只读）

基线：T4 B1-B11。证据：/tmp/wp5.txt（16:14，860/0 全量绿）+ 本轮代码不变量核对 + 本会话零改码事实。

| 边界 | 结论 | 证据 |
|---|---|---|
| B1 澄清闸 | 盘上通过 | wp5 含 clarify 用例；src:9321 未被本会话触碰 |
| B2 自动派发 | 盘上通过/运行态缺陷另列 D-1 | wp5 w5-cancel-e2e；D-1 为既有缺陷非退化 |
| B3 续跑重置 | 盘上通过 | wp5 evidence-missing-retry；3566-3618 语义未改 |
| B4 证据裁决 | 盘上通过 | wp5 备份闸用例；2561-2631 未改 |
| B5 通知写入器 | 盘上通过（6059 已修） | wp5 绿；plan.ts:1684+ deferUntilHead 在盘 |
| B6 档位治理 | 盘上通过 | wp5 effort-rules-llm-family |
| B7 计时纪律 | 盘上通过 | wp5 stuck-recovery |
| B8 phase-0 | 盘上通过 | wp5 250-head-delegation |
| B9 深度 | 盘上通过 | wp5 delegate 用例 |
| B10 交付门禁 | 盘上通过 | 本计划自身受闸约束（deliveryReady=false 至今） |
| B11 时长协商 | 盘上通过 | wp5 time-estimate-negotiation |

缺陷条目（既有，非本会话引入）：
- D-1 派发毫秒级 TypeError（auto+tool 两路径实证，childId=null）。最小复现：15:11 构建下对任意计划调用 dsh_workplan_dispatch 或触发自动派发。修复规格见 T5b§0；运行态验证待重载。
- D-2 跨 turn 重规划税（设计缺陷，6059 turn2 与本会话 08:06Z 实证）。修复规格 T5b§4。

门禁结论：**盘上状态可保留**（全量绿+零改码）；**运行态无退化未验证**（宿主仍 15:11 旧 lib）⇒ 放行条件=6059 按 T5b 落地+用户手工重载+复跑 wp 全量+T7b 协议达标。任一回归红⇒按 T5b§7 单提交回退。
