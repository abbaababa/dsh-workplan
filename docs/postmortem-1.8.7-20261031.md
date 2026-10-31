# 复盘：计划没做完就把中间结果当成品交付（2026-10-31，dsh-workplan 1.8.7）

## 0. 结论先行

用户看到的现象是真的：会话
`session-99984ebd-7d13-47d5-87a0-e9ba7271b883` 在计划只完成 **10/13** 时
`present` 了报告并结束回合；第二个回合把进度改成 **11/13** 后再次结束，
T12、T13 从此再没执行。这不是用户误判，也不是「报告写得好不好」的问题，
而是**「完成」的判据分散在四处、且没有任何一处能在回合边界上强制生效**：

| 谁在宣告「完成」 | 当时的实际行为 | 缺陷 |
|---|---|---|
| 结果消息（`buildResultMessage`） | 第 3 条命令「给出最终答复」，第 4 条又命令「再派发续跑」 | 两条命令互斥，模型照前者收尾 |
| 工具返回（dispatch render/schema） | `ok:true` +「已加入进行中的派发并等到结果」 | 没有 `complete` 字段，暂停读起来像成功 |
| 系统提示词（`PROMPT_SECTION`） | 只有「不要声称未经验证的完成」 | 没有「未完成禁止交付」的硬规则 |
| 回合边界（官方 `agent/turn-stopping`） | 插件**没有订阅**该事件 | 模型随时可以收尾，没有强制点 |

## 1. 时间线（全部来自原始事件日志，可复核）

证据文件：`~/.dsh/sessions/--Users-open-Documents-Stocks--/`
`session-99984ebd-7d13-47d5-87a0-e9ba7271b883/session.v4.jsonl.zstd`
（658,957 字节；解压后 598 个事件）。计划 ID：`wp-66f57fa3-fc71-4f8e-b8dd-b3e67c279467`。

| 时刻（本机 +08:00） | 事件 | 证据 |
|---|---|---|
| 11:41:34 | turn 1 `turn/start`（真实任务回合） | 会话日志 |
| 11:42:54 | 首个工具调用 `dsh_workplan_dispatch({"mode":"async"})`（seq 25） | 会话日志 |
| 11:46:44 | 主 Agent 先写出一版报告 `159667_2026年11月走势预判报告.md` | 会话日志 |
| 11:48:54 | 再调 `dsh_workplan_dispatch({"mode":"wait"})`，阻塞约 14 分钟 | 会话日志 |
| 11:49:19–12:00:12 | 后台依次创建 T8/T9/T10/T11 四个子 Agent；T11（排版设计）到预算点仍在跑 | `subagent/catalog` 事件 |
| 12:02:54 | 派发返回：**「本轮预算用尽，可续跑（完成 10/13，受阻 0）｜已加入进行中的派发并等到结果」** | `tool/result` 原文 |
| 12:02:54 | 同一秒注入「【部门执行结果】完成 10/13，受阻 0，请主 Agent 核对并整合」，正文含「3. 给出最终答复」与「4. 再次调用 dsh_workplan_dispatch」 | `user/message`，`source.kind=workplan-result` |
| 12:03:08–12:03:54 | 模型修正报告日期/权重/表格，未再派发 | 会话日志 |
| 12:04:22 | `present` 报告（`deliverables/presented`） | 会话日志 |
| 12:04:25 | turn 1 `turn/end`，`reason.kind=completed`（计划 10/13） | 会话日志 |
| 12:12:34 | T11 完成通知（`subagent-settled`）触发 turn 2 `turn/start` | 会话日志 |
| 12:13:10 | 报告 E/G/I 行改为「11/13（T1–T11）」；T12/T13 未跑 | 会话日志 |
| 12:13:16 | turn 2 `turn/end`，`reason.kind=completed`（计划 11/13） | 会话日志 |
| 之后 | 没有第三个回合；计划永久停在 11/13 | 事件流结束 |

用户在 12:04 之后拿到的是「已 present 的报告 + 收尾性答复」；计划卡片同时显示
「已结束 · 本轮预算用尽，可续跑」。**聊天里的成品口径与卡片里的未完成口径不一致，
而用户读的是聊天。**

## 2. 5-Why

1. **为什么用户在没做完时看到了结果？**
   因为 12:04:22 调用了 `present`、12:04:25 回合以 `completed` 关闭，而计划
   `10/13`；12:13 的第二回合又以 `11/13` 关闭。
2. **为什么模型会认为可以收尾？**
   模型收到的结果消息第 3 条就是「给出最终答复」；工具返回 `ok:true` 且写着
   「已加入进行中的派发并等到结果」，没有任何字段说明「还剩 3 项」。
3. **为什么结果消息会自相矛盾？**
   `buildResultMessage` 把「核对证据 / 处理受阻 / 给出最终答复」写死成职责清单，
   未完成分支再追加第 4 条「再次派发」；`buildResultSummary` 也固定写
   「请主 Agent 核对并整合」。**同一份控制消息里同时存在「收尾」和「续跑」两条命令。**
4. **为什么没有任何机制拦住收尾？**
   插件只订阅 `agent/pre-step`，不订阅回合结束事件；官方提供的
   `agent/turn-stopping`（serial、边界提交前 await、监听器可 `agent.steer()`
   让机器重读 inbox）完全没有被使用。预算暂停只是文案上的「可续跑」。
5. **为什么没有回归测试发现？**
   1.8.4 只修了「已结束 ∧ 正在做」（I11），`workplan-budget-pause.test.ts`
   只断言暂停后的状态列表，从不断言「未完成时给模型的指令是什么」。

系统层原因：**「完成」有四个宣告者（模型叙述、工具返回、状态列表、回合边界），
但没有任何仲裁规则；唯一有强制力的边界事件没有被订阅。** 只要异步派发把
「预算到点」和「子任务结算」的时间拉开，这个缺口就必然被踩中。

## 3. 已落地的修复（1.8.7）

| 层 | 改动 | 落点 | 验证 |
|---|---|---|---|
| 结果消息 | 未完成时首句「未完成：完成 d/t，剩余 N 项」；职责第 3 条改为「【未完成，禁止交付】」，恢复动作固定为第 4 条；只有全 done 才出现「给出最终答复」 | `src/plan.ts` `buildResultSummary` / `buildResultMessage` | `tests/workplan-turn-stop-gate.test.ts` 用例 1、2 |
| 收尾指令 | 新增 `buildStopSteerText()`：说清剩余量/ID、禁止 present 与「已完成」措辞、给出唯一恢复动作 | `src/plan.ts` | 用例 3 |
| 工具返回 | render 分三态：「已开跑，尚未完成」/「未完成：完成 d/t，剩余 N 项」/「已完成」；schema 增加 `complete`、`remaining`；工具描述写明 `complete=false` 必须续跑 | `src/host.ts` `createDispatchTool`；`src/runtime.ts` `dispatchToolOutputSchema`、`completionFields` | `npm run check` + 用例 2 |
| 提示词 | 新增第 5、6 条：完成唯一判据是全部 done；`ok:true` 不等于完成；未完成禁止 `present`/「已完成」/收尾答复；确有阻碍时答复开头必须写「未完成：剩余 N 项与原因」 | `src/host.ts` `PROMPT_SECTION` | `tests/workplan-host.test.ts` |
| 回合边界 | 新增 `onTurnStopping` 并注册到官方 `agent/turn-stopping`：仍有未完成项时先等正在跑的派发，再 `agent.steer()` 注入「计划没做完，这个回合不关闭」；每回合最多 2 次；全 done/已取消/非任务回合直接放行 | `src/runtime.ts`、`src/host.ts` | 用例 4、5、6 |

## 4. 为什么这次能真正阻断

`agent/turn-stopping` 的语义（`@deepseek-ai/dsh-agent` 的
`lib/types/runtime-types.d.ts` 原文）：

> Awaited before the boundary commits — a listener that objects steers
> (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs
> another step, none closes the turn.

即：监听器在边界提交前被 await；只要 `steer` 注入新消息，机器会多跑一步而不关闭
回合。同仓的 `@deepseek-ai/dsh-workspace-changes` 就注册在插件根 `ctx` 上
（`lib/index.js:1067`），证明该 agent 作用域事件能到达根监听器。**提示词和文案
只能说服模型，这个事件能拦住收尾本身——两者叠加才是根治。**

## 5. 仍待验证 / 残余风险（不当结论）

- `agent/turn-stopping` 的实机行为尚未在本机重启后的 `dsh web` 上复现验证
  （插件在 `dsh web` 启动时加载，**必须重启一次才生效**）。当前只有类型定义、
  `dsh-agent-loop` 源码与同仓用例三处间接证据。
- `state.activeTurns` 只在「真实任务回合」置位；由用户一句「继续」触发的回合
  不会置位（`isVagueContinuation` 提前返回）。1.8.8 已用
  `turnCarriesPlanWork()` 补上「子 Agent 结算 / workplan 结果 / 续跑指令」
  唤醒的回合，但纯人工「继续」回合仍不 steer；该回合的 `present` 仍会被工具级
  闸门拒绝，纯文本收尾则只受提示词第 5、6 条约束。
- 每回合最多 2 次 steer：极端情况下第三轮仍可能带着未完成项收尾；此时界面与
  文案会明确写「未完成」，但不会无限阻止模型结束回合。
- 事故会话本身仍停在 11/13；如需补齐 T12/T13，应对主 Agent 说「续跑这个计划」。
- 客户端卡片仍沿用「已结束 · 本轮预算用尽，可续跑」；本轮未改卡片措辞，只保证
  聊天答复不再冒充成品。

## 6. 复现与验证命令

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
npm run check          # tsc --noEmit，期望无输出
npm test               # 期望 220 tests / 220 pass / 0 fail
git log --oneline -3   # 期望看到本次 1.8.7 提交
```

## 7. 1.8.8 补丁：补上审计发现的第二个绕过路径

1.8.7 上线后，审计计划 `wp-6753e19f` 的 T7 复核事故 turn 2 时发现：1.8.7 的闸门
只覆盖「有真实任务标记的回合」，而事故的第二个回合是被 T11 子 Agent 的结算通知
（`subagent-settled`）唤醒的——`humanMessages()` 只认人类 `user` 消息，`maybePlan`
在这类回合提前返回，`state.activeTurns` 没有置位，`onTurnStopping` 首行即放行。
同时 `present` 仍只有提示词约束，没有工具级拦截。两条合起来，正是事故里
「11/13 收尾 + 呈现半成品」的完整路径（H9、H10）。

1.8.8 的补法：

- **H9**：新增 `turnCarriesPlanWork(session, turn, record)`，从 `session.seq - 1`
  回扫本回合事件，识别 `subagent-settled` / `workplan-result` /
  `workplan-continue` 三类来源；`subagent-settled` 还要求
  `source.senderSessionId` 属于本计划的子会话，无关子 Agent 的结算不会误激活。
  `onTurnStopping` 改为「不在本回合任务标记里 **且** 本回合不携带计划工作」才放行。
- **H10**：新增 `presentDenialReason(agent)`，在 `src/host.ts` 的
  `ctx.tools.guard` 中对 `present` 执行前拦截；根会话计划未完成即拒绝，文案列出
  剩余项，并给出「先续跑 / 确实无法继续先 `dsh_workplan_cancel`」两条出路。
- **附带**：全部剩余项都 blocked 时不再空转 steer（没有可运行子任务，steer 只会
  消耗回合），但 `present` 仍被拒绝。

验证：`npm run check` 无诊断；`npm test` 220/220；`npm run build` 五个产物
sha256 前后一致。运行中的 `dsh web` 仍需重启后生效。

## 8. 1.8.9 补丁：重启后的进度回退与剩余两条绕过路径

1.8.8 上线、用户重启 Web 服务后，`wp-6753e19f` 从 13/14 退回 5/14。根因不在
写入而在回放：`reconstructFromSession` 只有一组 `plan/statuses`，会话里出现
第二个计划（「继续」被误判生成的 `wp-dd26f206`，seq 1223）时，前一个计划被
压进冻结快照并停止接收后续事件。`wp-6753e19f` 迟到的 7/14 结果（seq 1337）
与六条 T9–T14 的 `done` 改判（seq 1517–1532）因 `planId` 不匹配被丢弃，
重启后永远回到冻结时的 5/14。

1.8.9 的补法：

- **回放按 planId 分账**：`ReplaySnapshot` 以 `plan.planId` 为键；`plan` /
  `result` / `update` / `cancel` 与 `dsh_workplan_update` 的工具调用都按载荷
  里的 `planId` 路由，`targetPlanId` 显式指定时优先返回该计划。用 1657 事件的
  真实日志重放，`wp-6753e19f` 恢复为 13/14（仅 T5 blocked）。
- **结算回合按会话谱系认亲**：预算暂停把未完成项重置为 `pending`，而
  `normaliseStatusEntry` 对 `pending` 强制清空 `childId`（不变量 I6 也不允许
  `pending` 携带 `childId`）。事故里的 T11 因此从 `planChildIds` 消失。新增
  `isChildSessionOf()`，用 `header.parentSession` 判定谱系，不再依赖易失字段。
- **`present` 的证据硬缺口**：全部 `done` 但存在 `verification === 'failed'`、
  `acceptance[].result === 'fail'` 或非空 `missingArtifacts` 时，`present` 在
  执行前被拒绝，并提示先 `dsh_workplan_update` 补证或改回 `blocked`。
  `legacy`／无结构化证据属于软缺口，仍由提示词与结果消息约束；拦死它们会让
  旧计划永久不可交付，只剩 `cancel` 一条路，是新的死锁。

验证：`npm run check` 无诊断；`npm test` 223/223；新增三条回归用例
（回放分账、`childId` 清空后的结算拦截、`present` 证据缺口）。

残余：取消计划后 `planIncomplete` 为 `false`，`present` 会放行（当前语义是
「取消即只交付中间结果，正文须写明未完成」）；`status === 'done'` 但
`acceptance` 为空时仍按结构化证据接收，只能靠自检失败拦住明确错误的证据。
