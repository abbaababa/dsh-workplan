# T2 分配耗时时间线与证据索引（session-1513 主 Agent 只读取证）

证据源（均只读）：
- S6059 = `/Users/open/.dsh/sessions/--Users-open-Documents-Stocks--/session-6059f01b-7d0f-45fb-9c7e-5fca0abeeac3/session.v4.jsonl.zstd`（zstd -dc 全帧解码后逐事件解析）。
- S1513 = 同目录 `session-1513aa1d-ea9d-463c-9273-ee9a253e40cb/session.v4.jsonl.zstd`。
- 源码 = `/Users/open/Documents/Stocks/plugins/dsh-workplan/src/runtime.ts`（经 profile web/node_modules/dsh-workplan 符号链接被运行态加载，已核实）。
时间均为 UTC（本地 +8h）。

## 一、6059 会话（截图会话）规划阶段时间线

| 区间 | 起 | 止 | 耗时 | 来源 |
|---|---|---|---|---|
| turn 1 开始 | 07:18:51 | — | — | S6059 turn/start seq(turn=1) |
| 规划尝试 1 | 07:18:51 | ≈07:23:51 | ≈5 分钟 | 心跳「已用时 45 秒…4 分 30 秒」无尝试标签段（第一批，flush 时间戳失真，见§三） |
| 规划尝试 2 请求头 | 07:26:51 | — | — | S6059 request/header：provider=qw model=qwen4-max-preview reasoningEffort=**xhigh** |
| 尝试 2 心跳 | 累计 5 分 15 秒 | 累计 7 分 30 秒+ | ≥2.5 分钟 | 第一批带「第 2/3 次尝试」标签心跳 |
| turn 2 开始（新一轮重新规划） | 07:30:06 | — | — | S6059 turn/start(turn=2)；同刻再次出现【规划预告】 |
| turn 2 规划尝试 1 | 07:30:06 | ≈07:40:06 | ≈10 分钟 | 第二批心跳 45 秒→9 分 45 秒（真实时间戳 07:30:51→07:39:51，无标签） |
| turn 2 规划尝试 2 | ≈07:40:06 | ≥07:44:21 | ≥4.5 分钟 | 心跳 10 分 30 秒→14 分 15 秒带「第 2/3 次尝试」（07:40:36→07:44:21） |
| 截图定格 | 07:43:36 | — | 累计 13 分 30 秒 | 与截图「已用时 13 分 30 秒（第 2/3 次尝…」逐字吻合（T1 摘录） |

结论性事实（有双证据）：
1. 等待主体是规划器模型调用：模型泳道单条长条（T1）+ 心跳全部为「正在等待模型返回」+ request/header 显示 xhigh 档。
2. 失败重试=整轮重新生成：尝试 2 从 0 重新计时但累计显示，等待翻倍。
3. **每个新 turn 都从零重新规划**：turn 2 在 turn 1 规划尚未产出可用计划时再次发【规划预告】并重跑 14 分钟+（代码对应 src/runtime.ts maybePlan：`payload.step!==1` 才跳过、`existing.plan.createdTurn===payload.turn` 才跳过，跨 turn 即重规划）。
4. 预告口径「约 3 分钟」与实测 5–14 分钟/尝试严重不符（口径按 5 分钟窗口典型值估算，未含 xhigh 长尾与重试）。

## 二、1513 会话派发阶段时间线（崩溃，非慢）

| 事件 | 时间(ms epoch) | 来源 |
|---|---|---|
| 自动派发开始 dispatchedAt | 1794469997824 | workplan-result 消息 |
| T1 startedAt / 崩溃 / 重试 / 受阻 | …826 / …849 通知 / …863 | S1513 user/message seq7-13 + result statuses |
| T2/T4 同模式 | …837/…842 起，…864 受阻 | 同上 |
| childId | 全部 null | result statuses：子会话从未创建 |
错误文本：`Cannot read properties of undefined (reading 'id')`，两次尝试相同，毫秒级 ⇒ 派发链路在创建子会话前即抛 TypeError；持久日志中**无堆栈**（缺口 G2）。

## 三、测量口径与缺口

- G1：第一批心跳的 event.time 全为 07:30:06（deferUntilHead 暂存后一次性补发所致），该批只用「已用时」数值排序，不用 flush 时间戳；第二批时间戳真实可用。
- G2：派发 TypeError 无堆栈留存；候选崩溃点（宿主 dsh-subagent lib/index.js:3024 `spec.parent.id`，parent=options.agent）尚未用运行态实证闭环，列为 T3 待验证 V5，禁止当既定结论。
- G3：规划器每次尝试的精确起止无独立事件，用心跳 45s 粒度推算，误差 ≤45s。
- 源码/配置可访问：是（符号链接核实）；全程只读，未改任何运行状态。

## 四、交 T3 的量化排序

占比排序：规划模型调用（含整轮重试）≈100% 的可见等待（截图泳道+心跳）；跨 turn 重复规划=等待×N；派发崩溃=等待后仍 0 产出（独立缺陷）。
