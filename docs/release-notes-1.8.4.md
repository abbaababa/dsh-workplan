# v1.8.4 — 「已结束」不再和「正在做」同屏

## 一句话

左侧栏「任务进度」曾把同一张卡片同时写成「已结束，可续跑 · 正在做」，而同一次运行还在真实推进脚本。
这一版让「结束」只按**真实的存活事实**判定：只要派发还在跑，卡片就不会宣布结束。

## 你会看到什么变化

| 之前 | 现在 |
|---|---|
| 徽标「已结束，可续跑 · 正在做」 | 派发在跑时显示真实阶段（如「正在做」）；真的结束才显示「已结束」 |
| 「任务进度」卡一边宣告结束，展开后第 4 步仍写「正在做」 | 结束时会写明「本轮结束时这一步仍未完成，可以续跑」，不再残留「正在做」 |
| 同一张卡两个完成度：计数 73% / 加权 80% | 只有一个完成度，分组、环、展开页取同一个数 |
| 徽标承诺「可续跑」，卡片却不给方法 | 凡是说「可续跑」的地方，都给出「对主 Agent 说『续跑这个计划』…」以及剩余次数 |

## 根因（给需要复核的人）

计划结果由异步派发结算，而**派发可以跨过宿主回合结束**：事故会话里 `turn/end` 发生在
19:58:39，派发继续运行到 20:22:50 才写入结果。`serialisePlan` 只读取最后一个
`turn/start|turn/end` 事件判断「本轮是否结束」，从不读插件自己的存活信号
`record.dispatchPromise`，于是把「回合结束」误当成「没有东西在跑」，把阶段改写成
`ended`，而子任务状态仍是 `in_progress`——同屏的两句话从此互相打脸。

客户端还有三处加剧了矛盾：`planPhaseOf` 会用计数覆盖服务端阶段；`resumeHint` 只在
`phase === 'blocked'` 时给续跑指令，而徽标对 `ended` 也承诺「可续跑」；展开页用加权
百分比、分组与环用计数百分比。

## 修复内容

- `src/runtime.ts`：`serialisePlan` 先读 `record.dispatchPromise`；有活派发时不进入
  `ended`，并把 `running` 随载荷下发。
- `src/runtime.ts`：回合真的结束且无活派发时，用 `settleStaleInflight` 把残留的
  `in_progress` 改判 `blocked` 并附说明；**只改下发的副本**，内存记录不动，续跑仍从原地继续。
- `src/client.ts`：新增 `sessionPhaseOf`，`running === true` 时回退到原阶段，展示层不再
  仅凭 `phase` 说「已结束」。
- `src/client.ts`：`resumeHint` 覆盖 `blocked` / `paused` / 可续跑的 `ended`；展开页与
  分组统一使用计数百分比（删除 `planWeightedPercent`）。
- `src/plan.ts`：新增不变量 I11 —— `phase=ended` 且仍有 `in_progress` 时自检判红。
- 测试：新增 `tests/ended-live-dispatch.test.ts`（6 例，含回放路径、只改副本），
  `tests/client-resume-hint.test.ts` 增 2 例（徽标与续跑说明必须同时成立；载荷说「还在跑」
  时界面不得出现「已结束」）。全部 **196 项测试通过**。

## 升级

```bash
dsh plugin --profile web add dsh-workplan@1.8.4
```

插件在 `dsh web` 启动时加载，**升级后需重启一次 `dsh web` 才生效**（重启会中断正在运行的会话）。
历史计划不需要数据订正：面板按新规则重算，旧记录里「已结束 + 正在做」的组合不会再被渲染。

## 已知限制

- 「已结束」只代表**没有活派发**，不代表计划完成。没做完的计划仍会进入「已结束」分组并
  标出受阻数——这是刻意的，用户需要看到「这一轮结束了，但事情没做完」。
- 存活信号只在同一进程内有效。若进程在派发中途被杀，记录里不会留下 `dispatchPromise`，
  此时按「回合结束 + 残留 `in_progress`」收敛为受阻。

## 复核

```bash
npm run check && npm test          # 196 项测试
npm run build && git diff --exit-code -- lib client.js   # 生成物可复现
```
