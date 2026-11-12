# T4 既有机制与耦合点边界清单（session-1513，只读）

基线：当前工作区 src（含 6059 未提交修改）。每项=机制→代码位置→关键不变量→回归判据→耦合风险。回归判据优先引用真实存在的测试文件（tests/ 目录，6059 全量跑）。

| # | 机制 | 代码位置(src/) | 关键不变量 | 回归判据 | 耦合风险 |
|---|---|---|---|---|---|
| B1 | 澄清闸 | runtime.ts:9321 auditClarifyNeed | 信息不足只问一句，不规划不派发 | tests 中 clarify 相关用例；env DSH_WORKPLAN_CLARIFY_GATE=0 可关 | 与 R4 修复相邻：改重规划触发时不得绕过闸 |
| B2 | 自动派发 | runtime.ts:9571,5145 | 计划消息先展示；async 开跑不阻塞回合；失败不伪装成规划失败 | tests/workplan-w5-cancel-e2e.test.ts | 与崩溃修复同路径（agent 解析） |
| B3 | 续跑/重置 | runtime.ts:3566-3618 | done 不重跑；resume≤maxResumes；comm-format 退回先抄后重置 | tests/workplan-evidence-missing-retry.test.ts | 重置会清 blockedKind，修复不得改语义 |
| B4 | 证据裁决 | runtime.ts:2561-2631 settleFromOutput/adjudicateResult+备份新鲜度/归属闸 | 缺失永不计 done；陈旧/异属备份不采纳 | 同 B3 测试 + 备份闸用例 | 性能修复不得放宽裁决 |
| B5 | 通知写入器 | plan.ts:1684+ surfaceHeadExists/deferUntilHead | surface 上 user/message 不得先于系统头；重启回放校验通过 | 6059 正在修的相关用例（wp 系列输出） | **最高危**：所有心跳/预告/改判共用此写入器 |
| B6 | 档位治理 | runtime.ts:1002-1011,2111-2142; llm-rules.ts | qwen=low/medium/xhigh，非qwen=low/high/max；子不继承主档；越界钳制留痕 | tests/effort-rules-llm-family.test.ts | F1/F3 修复直接作用于此，须保钳制链 |
| B7 | 计时纪律 | runtime.ts:2306,2340,3226,3629 | 收束计时器禁 unref；卫生通知可 unref；finally 必 stop | tests/workplan-stuck-recovery.test.ts | 心跳/看门狗改动易引 CI 红叉族 |
| B8 | phase-0/self_effort | runtime.ts:2098,2459,7283+ | 先配置后开工；缺交硬拒；登记 durable | tests/workplan-250-head-delegation.test.ts | 与三层派发深度共享 spawn 参数 |
| B9 | 深度边界 | runtime.ts:2242 maxDepth:2 | 第四层硬拒 | delegate 相关用例 | spawn 参数改动须保留 |
| B10 | 重规划/交付门禁 | replan.ts; plan.ts deliveryReady/present 闸 | 取消≠完成；present 需 structured+逐项 pass+无缺失 | tests 中 replan/supersede 用例 | 本计划自身受其约束 |
| B11 | 时长协商 | runtime.ts:385-424; time-estimate 注释 | 协商上限=clamp(预估×2,…)，延期有界；二次超时接手 | tests/time-estimate-negotiation.test.ts | F6 口径修复不得改协商语义 |

高风险耦合点（显式标记，T5b/T8 必引）：
- C1 appendUserMessage（B5）：任何新增通知必须走 deferUntilHead 同一写入器。
- C2 effort 解析链（B6）：planner/child/delegate 三消费点共享，改一处须三处回归。
- C3 dispatchPlan agent 解析（B2+崩溃）：auto/tool/resume 三入口共享 options.agent，fail-closed 校验须三入口同测。
- C4 resetBlockedStatuses（B3）：续跑与格式退回共享，修复不得改清空语义。
