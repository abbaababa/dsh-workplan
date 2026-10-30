# 复盘：「已结束 ∧ 正在做」同屏（2026-10-30，dsh-workplan 1.8.4）

## 1. 时间线（全部来自原始事件日志，可复核）

| 时刻（本机 +08:00） | 事件 | 证据 |
|---|---|---|
| 19:52:50 | 事故会话第一个 `turn/start`（seq 5） | `session.v4.jsonl.zstd` |
| 19:58:39 | turn 1 `turn/end`（seq 254，`reason.kind=completed`） | 同上 |
| 20:06:33 | 用户截图：卡片已进「已结束」组，60%，第 4 步「正在做」 | 用户截图 |
| 20:16:37 | turn 2 `turn/start`（seq 261） | 日志 |
| 20:18:57 | turn 2 `turn/end`（seq 395） | 日志 |
| 20:22:50 | 计划结果写入（seq 396，`phase=blocked`，11/15，4 blocked） | 日志 |

关键事实：**20:06:33 处于两个回合之间，没有任何打开回合，但计划仍在推进**
（20:06:33 是 9/15、1 正在做；20:22:50 落成 11/15、4 卡住）。所以「已结束」不是文案错，
而是判定依据错。

## 2. 5-Why

1. 为什么同一张卡既说「已结束」又说「正在做」？——载荷同时携带 `phase='ended'` 与
   `statuses` 里的 `in_progress`。
2. 为什么 `phase` 会是 `ended`？——`serialisePlan` 只看最后一个 `turn/start|turn/end`，
   判定「本轮已结束」，就把未完成计划的阶段改写成 `ended`。
3. 为什么「回合结束」不等于「没东西在跑」？——1.7.0 引入 async 派发（`cb40b7a`），
   派发在宿主回合结束后继续执行，结算可以晚数分钟。
4. 为什么插件没发现自己在跑？——存活信号 `record.dispatchPromise` 早就存在，且
   `dispatchStatus` 已经用它算 `running`，但 `serialisePlan` 的 ended 改写块没读它，
   载荷也不下发 `running`。**同一个进程里有两套「是否在跑」的判据，展示层拿到的是弱的那套。**
5. 为什么直到用户截图才发现？——没有任何断言检查「ended 载荷里不许有 in_progress」；
   而 `tests/ended-group.test.ts:193` 反而把「卡住的计划结束后仍然报需处理」固化成期望行为。

系统层原因：状态事实有多个宣告者（宿主回合、派发结算、客户端计数派生），但**没有仲裁规则**
和**出口收敛**；一旦异步派发把两个宣告者的时间拉开，矛盾就必然出现。

## 3. 已落地的防复发措施

| 措施 | 落点 | 如何验证 |
|---|---|---|
| 存活事实优先：有活派发不得进 `ended`，`running` 随载荷下发 | `src/runtime.ts` `serialisePlan` | `tests/ended-live-dispatch.test.ts` 用例 1 |
| 出口收敛：ending 时残留 `in_progress` 改判 `blocked`（只改下发副本） | `settleStaleInflight` | 用例 3、4、5 |
| 新不变量 I11：`ended` 且 `inProgress>0` 判红 | `src/plan.ts` `aggregateInvariantViolations` | 用例 6 |
| 展示层自保：`running===true` 时不得渲染「已结束」 | `src/client.ts` `sessionPhaseOf` | `tests/client-resume-hint.test.ts` |
| 承诺与操作一致：徽标说「可续跑」，卡片必须给续跑方法 | `resumeHint` | 同上 |
| 单一百分比口径：分组/环/展开页取同一个计数 | `PlanOverview` | 事故日志离线渲染：只有「总体进度 73%」 |

## 4. 仍待观察（未验证，不当结论）

- 重启后 `GET /dsh-workplan/plans` 的实机载荷（本机该端点需进程内凭据，未取像素级证据）。
- `dsh-context` 的 Fleet「任务进度」是第二个同名表面，是否也读 `turn/end` 判存活未审查完。
- `billion-context` 改写会话消息是否可能丢弃 workplan 标记、`delivery-accepted.throughSeq`
  停在某个序号之后的语义——均未证实。
