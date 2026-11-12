# dsh-workplan「分配慢」根因与修复说明（session-1513 整合版）

面向零基础读者：把插件想象成餐厅服务员。您下单后，服务员要先写一份完整菜单计划（规划），再把菜分给各个厨房（派发子任务）。本次问题=写菜单太慢（让您干等 13 分钟+），以及分菜那一刻服务员摔倒（派发崩溃，一个厨房都没启动）。

## 1 现象（T1）
截图（IMG_0467.jpeg，read_image 实读）：规划心跳 45 秒→13 分 30 秒仍「等待模型返回」，处于第 2/3 次尝试；模型档 Xhigh；模型泳道单条长条、工具无活动。证据：reports/T1-screenshot-evidence-session-1513.md。

## 2 证据时间线（T2）
6059 会话：turn1 规划≈5min+重试；turn2 又从零重规划 14min+；本会话 medium 档仍等 5m16s；派发毫秒级崩溃 childId=null。证据：reports/T2-timeline-session-1513.md（含缺口 G1-G3）。

## 3 根因（T3）
R1 旧构建规划器继承主会话最高档 Xhigh；R2 大 prompt+大 JSON 单次生成本身分钟级（medium 仍 5min）；R3 失败整轮重试翻倍；R4 每个新 turn 从零重规划。主环节=规划器模型调用（占比≈100%）。独立缺陷 D-1 派发崩溃（根因未闭环，缺堆栈 G2；候选宿主 dsh-subagent index.js:3024；auto+tool 两路径均实证）。淘汰假设：网络主因、与慢同根因。证据：reports/T3-root-cause-session-1513.md。

## 4 修复（T5b 规格交接，6059 实施；本会话零改码）
F1 档位解耦设上限；F2 骨架先显细化异步（治本主瓶颈）；F3 重试降档；F4 跨 turn 复用；F5 崩溃先堆栈留痕+fail-closed 再治本；F6 预告口径实测化。每项带代码位置、开关、回退、不触碰声明。证据：reports/T5b-fix-spec-session-1513.md。

## 5 验收（T6b/T8）
盘上全量套件 860/0 绿（/tmp/wp5.txt 16:14）；边界 B1-B11 逐条盘上通过；运行态无退化**待重载后验证**。回归用例规格 R-01…R-13 交 6059 实现。证据：reports/T6b-regression-spec-session-1513.md、reports/T8-gate-review-session-1513.md。

## 6 耗时对比（T7b）
基线已固定（xhigh 5–14min/尝试；medium 5m16s）；复测协议同口径≥5 轮中位数；**修复后数据尚未取得**，责任人=6059 或重载后主 Agent。证据：reports/T7b-baseline-protocol-session-1513.md。

## 7 防复发
- 监控点：planner telemetry（runtime.ts:1191）p50/p90 告警；首显时延>60s 告警；派发 childId=null 即告警。
- 回归门禁：R-01…R-13 入全量套件，红即单提交回退（T5b§7）。
- 口径纪律：预告必带「仅供参考，非承诺」+实测分位。
- 并发纪律：同一插件工作区单写者（本次 6059/1513 分工经用户确认）。

## 8 残留未知与需人工执行的动作（未执行，仅建议）
U1 派发崩溃真因待堆栈闭环（T5b§0 步骤①）。U2 修复后实测待执行。U3 6059 最终补丁范围待其收尾。
A1 6059 按 T5b 实施并复跑全量。A2 **用户手工重载插件/重启 dsh web**（规则：禁止 Agent 自行重启）。A3 重载后按 T7b 复测+T8 运行态复核。A4 本计划剩余行写回后核对 deliveryReady。
