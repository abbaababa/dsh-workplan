# 根因诊断：同一张卡上的 100% 与「正在收尾」

- 诊断对象：dsh-workplan **1.5.1**，HEAD `b0e0b76`
- 诊断角色：T4 缺陷分析研究员
- 诊断日期：2026-10-29
- 代码位置均相对 `plugins/dsh-workplan/`
- 证据等级：**V** = 实机执行验证；**C** = 代码可判定；**U** = 未验证/推演

> **文案核对（重要）**：当前 1.5.1 源码与 git 历史中都没有字面「正在做收尾」。
> 实际中文文案是「正在收尾」（`src/client.ts:64`），模型侧文案也是「正在收尾」
> （`src/host.ts:26`）。本报告按语义等价处理；若截图字面确为「正在做收尾」，
> 需核对运行构建是否与当前源码一致（见 §9 U1）。这不影响根因结构，因为
> 100% 与收尾文案并存的机制完全相同。

---

## 0. 结论摘要

**一句话**：100% 没有算错，「正在收尾」也没有写错；错在它们分别来自
「工作项完成度」和「计划生命周期」两个不同粒度的判断，却被放在同一张卡片的
同一视觉层级；同时 phase 状态机允许 `done` 回退，也允许「通过 update 完成全部
子任务」这条路径永远到不了 `done`。

### 0.1 直接原因（V，置信 0.95）

`serialisePlan` 在同一次 payload 中同时下发：

```text
phase: "integrating"
stats: { total: 2, done: 2, progress: 100 }
statuses: [ {T1, done, 100}, {T2, done, 100} ]
```

客户端两条渲染路径各取一半，互不校验：

- 环形/百分比：`percent = Math.round(stats.done / stats.total * 100)`
  （`src/client.ts:1475`）→ `100%`、`data-percent="100"`、`data-state="done"`；
- 状态胶囊：`t('phase.' + phase)`（`src/client.ts:1764`）→「正在收尾」。

两者都出现在折叠卡的同一个 summary 行（`Collapse` 同时显示 `title/meta/badge`，
`src/client.ts:1167`），所以同屏并存。payload 内部没有任何字段能表达
「这两个信号是否允许同时出现」。

### 0.2 结构性主因（V/C，置信 0.9）

这是**两个「完成」语义共用一根进度轴**的问题，不是单点算错：

| 信号 | 实际含义 | 定义位置 |
|---|---|---|
| `percent` / 环 | **工作项**完成度：子任务 done / total | `src/client.ts:1475` |
| `phase` / 胶囊 | **计划**生命周期 | `src/plan.ts:1377-1383` |

`planPhase` 对 `integrating` 的定义就是「所有工作项都 done，但计划还没 done」
（`src/plan.ts:1379`）。因此 `100% + 正在收尾` 是这个语义模型的**必然输出**，
不是偶发计算错误。设计文档甚至明确写过这一组合「是正确的」：

> 一个 `integrating` 计划（所有子任务 done）会让进行中组环显示 100%，
> 但组头仍写「进行中」，卡片胶囊写「正在收尾」。这是正确的：
> **工作项完成 ≠ 计划完成**。
> —— `docs/status-grouping-ia.md:367`

代码层又叠加了三个结构问题：

1. **phase 没有单一事实源**：`serialisePlan` 优先用 `record.phase`，存在即绕过
   `planPhase(statuses)`（`src/runtime.ts:868`）；`record.phase` 有 8 个直接写入点
   （见 §4.3）。
2. **没有跨字段不变量**：`aggregateInvariantViolations` 只检查
   `stats/departments`（I1–I7，`src/plan.ts:1312-1318`），不检查
   `percent ↔ phase`；1.4.3 修复报告还把 `record.phase` 明确豁免为
   「非计数，未发现可观测矛盾」（`docs/fix-report-derived-counts-1.4.3.md:104`、§8）。
3. **`done` 不是吸收态，且 update 完成路径到不了 `done`**：
   唯一的晋升点是 `dispatchTool` 写结果消息之后（`src/runtime.ts:1414-1415`）；
   `updateStatus` 只重算 `planPhase`，不写结果、不晋升（`src/runtime.ts:1209`）。
   所以「最后一项由 update 置 done」会永远停在 `integrating`（V，见 §3 H3）。

### 0.3 关键诱因（V，置信 0.95）

`updateStatus` 与 `dispatchPlan` 重算 phase 时**不传 `resultSeen`**：

- `src/runtime.ts:1209`：`record.phase = planPhase(record.statuses)`
- `src/runtime.ts:767`：`record.phase = planPhase(record.statuses)`

结果消息已经落盘、计划已经 `done` 之后，任何一次 update（哪怕状态没变、只加
note）都会把 phase 打回 `integrating`。实测：

```text
回放（结果消息已落盘）: done
实时缓存（resultWritten=true）: done
一次 updateStatus 之后实时: {"phase":"integrating","done":2,"total":2}
同一会话回放: done
```

这解释了截图为什么可以**持久存在**，而不只是收尾瞬间：live 缓存被回退，
刷新/重启后回放又变回 `done`，用户看到的是「刷新前 100% + 正在收尾，
刷新后变成已完成」的翻转。

### 0.4 呈现诱因（V，置信 0.85）

同一计划的 UI 至少有 9 处各自判断「是否完成」（卡片 6、组头 1、TurnCard
引导 2，§4.4），包括：

- `100%`、`2/2`；
- `planNow` 的「都做完了」（`src/client.ts:1557`）；
- 胶囊「正在收尾」（`src/client.ts:1764`）；
- 分组「进行中」（分组逻辑 `src/client.ts:2286`，组名 `src/client.ts:21`）；
- tone 绿色（`integrating` 与 `done` 同为 `done`，`src/client.ts:977-982`）；
- `data-state="done"`（`src/client.ts:1667-1674`）；
- 加权「总体进度 100%」（`src/client.ts:1711`）。

设计原本靠「组名 + 胶囊 + 副行」消歧，但组名是「进行中」、胶囊是「正在收尾」、
副行是「都做完了」，三个标签本身全是进度语气，消歧失败。

**结论**：直接原因是两个渲染路径各取一半；结构性原因是两个完成语义共用一根
进度轴、phase 无单一事实源且 `done` 可回退/不可由 update 路径到达；诱因是
`resultSeen` 丢失、结果写入与晋升耦合、标签语气重叠。

---

## 1. 证据基线

| 项 | 值 |
|---|---|
| 插件版本 | `package.json` → `1.5.1` |
| 提交 | `b0e0b76` |
| 运行验证 | Node `v26.9.0`，真实 `lib/runtime.js` + `lib/plan.js` + `client.js` |
| 工作区状态 | 仅 T2 的 `scripts/repro-phase-percent-integrating.mjs` 未跟踪；本轮未修改任何插件源码 |
| 核心文件 | `src/plan.ts`、`src/runtime.ts`、`src/client.ts`、`src/host.ts` |
| 构建物 | `lib/*.js`、`client.js` 与 `src` 为同逻辑构建物（22:52 构建） |
| 设计依据 | `docs/status-grouping-ia.md`、`docs/fix-report-derived-counts-1.4.3.md` |

**边界声明**：本轮是诊断，不是修复。所有源码保持原样；T5 负责改代码与测试。

---

## 2. 现象的最小复现

T2 的复现脚本（真实构建物，不 mock）：

```bash
cd plugins/dsh-workplan
node scripts/repro-phase-percent-integrating.mjs
```

输出要点（`RESULT: PASS`，3/3 指纹一致 `76e136bdd1da5e34…`）：

**场景 A：直接构造「全部子任务 done、结果未到」的 payload**

```text
phase   = integrating
stats   = { total: 2, done: 2, progress: 100 }
statuses= [ {T1, done, 100}, {T2, done, 100} ]
```

同一 payload 渲染出的 DOM/文案：

```text
data-percent="100"
data-state="done"
100%  ·  2/2  ·  都做完了  ·  胶囊：正在收尾
has100 = true, hasIntegrating = true, hasAllDone = true
```

**场景 B：结果消息已落盘后再次 update**

```text
live  = integrating（done=2/2, progress=100）
replay= done
```

即：同一份事件流，内存视图与回放视图给出不同的 phase。

**关键判读**：100% 与「正在收尾」各自都对应真实事实——
「所有工作项完成」和「计划尚未完成收尾」——不是数据损坏，也不是显示错误。
矛盾发生在**把两个事实放在同一个进度断言里**。

---

## 3. 假设验证记录表

| ID | 候选假设 | 判定方法 | 结论 | 置信度 |
|---|---|---|---|---|
| H1 | 进度与状态来自双数据源/两套独立判断 | 读 1.4.3 前后代码；追踪 `percent` 与 `phase` 的输入；构造 payload 比对 | **成立**（精确表述见下） | 0.95 |
| H2 | 四舍五入导致 100% 显示 | 枚举 `total/done`；结合 `MAX_SUBTASKS=15`；实测加权 `stats.progress` | **对截图环不成立**；加权口径存在另一同类缺陷 | 0.99 / 0.95 |
| H3 | 终态缺失 | 读 `planPhase`/晋升点；实测「update 置最后一项 done」与「done 后 no-op update」 | **部分成立**（`done` 存在，但 update 路径到不了、且可回退） | 0.98 |
| H4 | 文案语义重叠 | 渲染 DOM；枚举同卡所有完成判断；对照设计文档 | **成立**（呈现层诱因） | 0.9 |
| H5 | 竞态/缓存时序 | 检查 `serialisePlan` 是否跨 `await`；对比 live/replay | **对截图不成立**；只解释刷新翻转 | 0.9 |
| H6 | 1.4.2 的 stats 缓存过期 | 读 1.4.3 单一派生代码；复现 stats 与 statuses 一致性 | **不成立** | 0.95 |
| H7 | 这是设计预期，不是缺陷 | 读 `status-grouping-ia.md` 与现有测试 | **部分成立**（设计允许该组合，但不支持回退/永久卡住） | 0.9 |

### H1：双数据源/两套独立判断 —— 成立（主因）

必须区分两种说法，否则会误归因：

- **若指 1.4.2 的 `record.stats` vs `record.statuses` 双源**：**不成立**。
  1.4.3 已删除全部 `record.stats` 读写，`stats/statuses/departments` 由同一次
  `derivePlanSnapshot` 产出（`src/runtime.ts:868` 附近）。T2 复现中
  `stats.done=2` 与两条 `status=done` 完全一致，没有计数漂移。
- **若指「percent 视图」与「phase 视图」两个派生结果**：**成立**。
  `percent` 只读 `stats.done/stats.total`（`src/client.ts:1475`）；
  `phase` 读 `record.phase`（缓存，8 个写入点）或
  `planPhase(statuses, resultSeen)`（`src/plan.ts:1377`）。
  两者没有共享 selector，也没有任何函数断言它们的组合合法。

**决定性证据**：同一个 payload 同时满足 `stats.done===stats.total` 与
`phase==='integrating'`，且这不是伪造——`planPhase` 对「全 done 但
`resultSeen=false`」的定义就是 `integrating`（`src/plan.ts:1379`）。
也就是说，两个视图在**定义层面**就可以同时为真，不存在“其中一个算错了”的
可能。这是结构性主因，而不是某个分支写错。

### H2：四舍五入 —— 对截图不成立；加权口径是另一同类缺陷

**环/百分比不成立（置信 0.99）**：

- `MAX_SUBTASKS=15`（`src/plan.ts:14`，`src/plan.ts:558` 强制），正常计划
  `total<=15`；
- 在 `total<=15` 内，`round(done/total*100)=100` 当且仅当 `done===total`：
  `14/15=93.33→93`，`13/14=92.86→93`，不存在“差一项却显示 100”；
- 枚举 `total<=500`，第一个「`done<total` 但四舍五入为 100」的实例是
  `199/200=99.5→100`；这已经远超插件的 `MAX_SUBTASKS`。

所以截图里的 100% 环只可能表示「所有工作项确实 done」，不是舍入假象。

**加权「总体进度」成立，但不能解释截图（置信 0.95）**：

`stats.progress = round(Σ权重 / total)`（`src/plan.ts:1282`），blocked/in_progress
按自身 `progress` 计权。实测 11 done + 1 blocked：

| blocked progress | 加权 `stats.progress` | 环 `done/total` |
|---|---|---|
| 90 | 99 | 92 |
| 95 | 100 | 92 |
| 99 | 100 | 92 |
| 100 | 100 | 92 |

同一张卡会出现「环 92% + 总体进度 100% + 卡住了」——这是真实的同类缺陷，但
**不是截图这一对**：只要存在 blocked，`planPhase` 会优先返回 `blocked`
（`src/plan.ts:1380`），胶囊会是「卡住了」，不会是「正在收尾」；只要存在
in_progress，phase 是 `executing`，也不会是 `integrating`。而
`phase==='integrating'` 要求所有项都是 `done`，此时加权值精确等于 100，
不需要任何舍入。**因此 H2 在逻辑上被排除，不是截图成因。**

严格说，如果 `record.phase` 缓存已经与 statuses 不一致（例如先 blocked、缓存
未同步），加权 100 也可能与 `integrating` 并置；但那时矛盾来自缓存不同步
（H1/H3），不是舍入本身。H2 只能解释「环 92% + 加权 100%」这类同卡数字打架，
不能解释「100% + 正在收尾」。

### H3：终态缺失 —— 部分成立，且是比“缺失”更严重的“不可达/不可保持”

分三层判定：

1. **「没有 done 状态」——不成立。**
   `planPhase` 有 `done` 分支（`src/plan.ts:1379`）；`dispatchTool` 在结果消息
   写入成功且全部 done 时置 `record.phase='done'`（`src/runtime.ts:1414-1415`）。
   T2 回放与我的实验都能得到 `done`。

2. **「update 完成路径到不了 done」——成立（V）。**
   `dsh_workplan_update` 的 status 枚举包含 `done`（`src/host.ts:92`），但
   `updateStatus` 只做 `record.phase = planPhase(record.statuses)`
   （`src/runtime.ts:1209`），**不写结果消息、不设置 `resultWritten`、不晋升
   `done`**。实测把最后一项从 `in_progress` 改为 `done`：

   ```text
   更新前: {"phase":"executing","stats":{"total":2,"done":1,"progress":75}}
   更新后 #1: {"phase":"integrating","done":2,"total":2}
   更新后 #2: {"phase":"integrating","done":2,"total":2,"resultWritten":false}
   ```

   连续两次读取都是 `integrating`，不是瞬时窗口。只要主 Agent 不再调用
   `dispatch`，这个计划就永远停在 100% + 正在收尾。这是**状态机缺一条边**：
   「所有子任务完成」→「计划完成」的唯一晋升边被绑在 dispatch 的结果写入上。

3. **「done 可保持」——不成立（V）。**
   `done` 之后任何一次 update（包括状态不变的 no-op）都会重算为
   `integrating`：

   ```text
   回放（结果消息已落盘）: done
   实时缓存（resultWritten=true）: done
   一次 updateStatus（T2 done→done，仅 note）之后: integrating（done=2/2）
   同一会话回放: done
   ```

   即 `done` 不是吸收态，且 update 不是幂等：对状态没有改变的更新改变了 phase。
   这直接违反「终态」应有的单调性。

**结论**：H3 的「状态不存在」部分是错的；「终态不可由 update 路径到达、且不可
保持」部分是对的，而且它是让截图从「短暂收尾」变成「持久矛盾」的关键。

### H4：文案语义重叠 —— 成立（呈现层诱因）

同卡实测文案与视觉：

| 位置 | 值 | 依据 |
|---|---|---|
| 环心 | `100%` | `src/client.ts:1475` |
| 计数 | `2/2` | `src/client.ts:1468` |
| 副行 now | 「都做完了」 | `src/client.ts:1557` |
| 胶囊 | 「正在收尾」 | `src/client.ts:1764` + `src/client.ts:64` |
| 分组 | 「进行中」 | `src/client.ts:2286` |
| tone | 绿色 `done` | `src/client.ts:977-982` |
| DOM state | `data-state="done"` | `src/client.ts:1667-1674` |
| 详情 | 「总体进度（加权）100%」 | `src/client.ts:1711` |

设计文档已经识别到「integrating 计划被误读为已完成」的风险
（`docs/status-grouping-ia.md:767`），缓解手段是「组头明确进行中、胶囊正在收尾、
副行整体完成而非已完成、环 100% 旁有组名兜底」。但实际标签是：

- 「都做完了」——完成语气；
- 「正在收尾」——进行语气，但与 100% 并置；
- 「进行中」——组名，不是对 100% 的解释；
- 绿色 + `data-state=done`——完成视觉。

这些标签没有把「工作项完成度」和「计划生命周期」明确分成两个轴，反而都在
同一个语义场里说「完成/收尾」。所以 H4 不是单纯措辞问题，而是**呈现层没有
把两个轴分开**，属于诱因和放大器。

### H5：竞态/缓存时序 —— 对截图不成立

`serialisePlan` 在一次同步调用里：

1. 从同一次 `derivePlanSnapshot(statuses)` 取 `stats` 与 `statuses`；
2. 从同一个 `record` 取 `phase`；
3. 中间没有 `await`、没有第二次读会话事件。

因此 payload 内部不存在「stats 读的时刻」与「phase 读的时刻」之间的竞态；
它输出的是同一时刻的两个事实。**截图不是跨请求时序造成的。**

但 live 与 replay 确实是两套来源：

- live：`record.phase`（缓存，可能被 update 回退）；
- replay：`planPhase(statuses, resultSeen)`（`src/runtime.ts:1028`）。

这解释的是「刷新前 integrating、刷新后 done」的翻转，不是「为什么能同时
100% + 收尾」。H5 只能解释可重复性问题，不能解释矛盾本身。

**补充**：`dispatchPlan` 末尾置 `integrating`（`src/runtime.ts:767`）与
`dispatchTool` 置 `done`（`src/runtime.ts:1415`）之间没有 `await`/IO，HTTP
轮询几乎不可能插入这个微任务窗口。因此「收尾瞬间被 4s 轮询抓到」这一路径
在正常 dispatch 流程中可观测性很低（C，置信 0.8）；真正持久的是
update 完成路径（H3-2）与 done 后回退（H3-3）。

### H6：1.4.2 stats 缓存 —— 不成立

- 1.4.3 已删除全部 `record.stats` 写入/读取，`stats` 每次从 `statuses` 派生
  （`docs/fix-report-derived-counts-1.4.3.md` §5.1）；
- T2 复现中 `stats.done=2` 与两条 done 状态一致，没有旧缓存的“计数漂移”；
- 当前源码中 `grep 'record.stats'` 只剩注释。

若截图来自**未重启的旧构建**，那要先核对版本（1.4.3 §9 明确要求重启），
但当前 1.5.1 源码本身已能复现同样的 100% + 收尾组合，因此不需要、也不应该
把原因归到 1.4.2 的 stats 缓存。**不要把同类问题的旧修复当成这次的原因。**

### H7：这是设计预期 —— 部分成立，但不足以否定缺陷

设计文档确实把 `100% + 正在收尾` 定义为正确（`docs/status-grouping-ia.md:367`），
现有测试也固化了这一点：

- `tests/workplan-budget-pause.test.ts:159` 断言全部完成后
  `phase==='integrating'`；
- `tests/plan.test.ts:297` 断言 `planPhase(allDone)==='integrating'`。

所以「只要全部子任务 done，phase 就应该是 integrating」是**当前设计契约**，
不是实现跑偏。仅把 `percent===100` 强行改成 `phase==='done'` 会破坏
`integrating` 的语义，也会让上面的测试失败。

但设计契约只覆盖：

> 工作项全部完成、计划正在等待主 Agent 收尾（结果尚未落盘）。

它**不覆盖**：

- `done` 之后被 no-op update 打回 `integrating`；
- 通过 update 完成最后一项、永远没有结果写入，因而永远停在 `integrating`；
- `done` 后 cancel 变成「100% + 已取消」；
- 刷新前后 live/replay 给出不同 phase；
- 同一张卡同时出现环 92% 与加权 100%。

因此 H7 解释的是「这个组合为什么被允许」，不是「这个组合为什么持久、为什么
会回退、为什么用户读成矛盾」。修复不能只改一个判断，必须同时决定
**一根轴还是两根轴**，并补齐状态机与不变量。

---

## 4. 主因链路

### 4.1 语义层：两个「完成」共用一个视觉槽

| 问题 | 回答 |
|---|---|
| 100% 是什么完成？ | 子任务完成度（done/total），不含计划收尾 |
| 「正在收尾」是什么没完成？ | 计划生命周期：结果尚未汇总/落盘 |
| `integrating` 的定义？ | 所有子任务 done、计划尚未 done（`src/plan.ts:1379`） |
| 两者能否同时为真？ | 能，而且按定义必然同时为真 |
| 用户会怎么读？ | 同一张卡的 100% 与「正在收尾」= 同一根进度轴上的矛盾 |

这不是「数字错」或「文案错」，而是**语义粒度错位**：把一个 0–100 的
工作项完成度，和一个生命周期枚举，放在同一个 summary 行的相邻位置，且都用
「完成/收尾」措辞。设计文档试图用「进行中组 + 正在收尾 + 整体完成」来消歧，
但这三个标签仍然在说同一件事，用户没有理由把它们理解成两个轴。

### 4.2 数据层：一个原始源，三个 phase 产出路径，零个跨字段约束

```text
record.statuses
  ├─ derivePlanSnapshot ──> stats ──> percent（每次 payload 现算）
  └─ statuses ──> planPhase(statuses, resultSeen) ──> 回放 phase
record.phase（缓存，8 个写入点）
  └─ serialisePlan: phase = record.phase ?? planPhase(statuses)
        └─ 注意：fallback 不传 resultSeen
```

三个 phase 产出路径：

1. **缓存优先**：`record.phase` 一旦存在就直接用（`src/runtime.ts:868`）；
2. **序列化 fallback**：`planPhase(statuses)`，不传 `resultSeen`，全 done 时
   必为 `integrating`；
3. **回放**：`planPhase(statuses, resultSeen)`，结果消息已落盘时为 `done`
   （`src/runtime.ts:1028`）。

三条路径没有被要求一致，也没有任何测试断言它们一致。percent 则有两条口径：

- 环：`stats.done/stats.total`；
- 详情：`stats.progress`（加权）。

`aggregateInvariantViolations` 的 I1–I7 只覆盖 `stats/departments`
（`src/plan.ts:1312-1318`），且注释说明生产路径不调用它，因为「纯派生已自洽」。
这句话对**计数内部**成立，对**计数与 phase 的联合**不成立——phase 不是纯派生，
它是缓存 + 多写入者。

### 4.3 状态机层：`done` 不是吸收态，晋升边绑在副作用上

`record.phase` 的 8 个直接写入点：

| 行 | 写入 | 触发 |
|---|---|---|
| `src/runtime.ts:717` | `'executing'` | dispatch 开始 |
| `src/runtime.ts:767` | `planPhase(statuses)` | dispatch 主循环结束 |
| `src/runtime.ts:803` | `'paused'` | 总预算耗尽 |
| `src/runtime.ts:837` | `cancelled` / `blocked` | catch 收敛 |
| `src/runtime.ts:1209` | `planPhase(statuses)` | updateStatus |
| `src/runtime.ts:1244` | `'cancelled'` | cancel（运行中分支） |
| `src/runtime.ts:1263` | `'cancelled'` | cancel（空闲分支） |
| `src/runtime.ts:1415` | `'done'` | 结果消息写入成功且全部 done |

状态转移的关键缺口：

```text
所有子任务 done
   ├─ 经 dispatchTool：写结果消息 → resultWritten=true → phase='done'（1414-1415）
   ├─ 经 updateStatus：phase=planPhase(statuses) → 'integrating'（1209）
   │     └─ 没有结果写入、没有 resultWritten、没有后续晋升
   └─ 经 cancelPlan：phase='cancelled'（1263），即使已经全部 done
```

- **唯一晋升边**依赖 `dispatchTool` 的副作用（写结果消息）。这不是状态机转移，
  是「工具调用完成后顺手改字段」；结果写入失败（`src/runtime.ts:1405-1410`
  的 try/catch 只 warn）就不会晋升，phase 停在 `integrating`。
- **没有降级保护**：`updateStatus` 对 `done` 计划再次调用时，会无条件用
  `planPhase` 覆盖；而 `planPhase` 不知道 `resultSeen`，于是一定回到
  `integrating`。
- **cancel 无完成度检查**：`cancelPlan` 两个分支都无条件写 `'cancelled'`
  （`src/runtime.ts:1244/1263`），即使 statuses 全 done。

因此 `done` 既不是「只能进不能出」，也不是「从所有完成路径都能到达」。
这两点都是状态机层面的结构性缺陷，不是展示层能修的。

### 4.4 呈现层：同一计划 9 处独立判断「完成」

这 9 处分布在 3 个渲染面；它们各自从同一份 payload 判断完成，因而可能给出
互相矛盾的信号：

| # | 所在面 | 位置 | 判断依据 | 输出 |
|---|---|---|---|---|
| 1 | 卡片 | `PlanViz` 环/百分比 | `stats.done/stats.total` | `100%`、`data-state="done"` |
| 2 | 卡片 | `planNow` | `counts.done===counts.total` | 「都做完了」 |
| 3 | 卡片 | 胶囊 | `phase` | 「正在收尾」 |
| 4 | 组头 | 分组 | `phase==='done'` | `integrating` →「进行中」 |
| 5 | 卡片 | `phaseTone` | `phase` | `integrating` → 绿色 `done` |
| 6 | 卡片 | `PlanOverview` | `stats.progress`（加权） | 「总体进度（加权）100%」 |
| 7 | TurnCard 引导区 | `workerText` | `stats.done>=stats.total` | 「都做完了」 |
| 8 | TurnCard 引导区 | `nextText` | `stats.done>=stats.total` | 「没有下一步，已完成」 |
| 9 | 卡片展开区 | 阶段行 `stateText` | 本阶段 `done===items.length` | 「都做完了」 |

（1 `src/client.ts:1475`、`:1667-1674`；2 `:1557`；3 `:1764`；4 `:2286`
（组名 `:21`）；5 `:977-982`；6 `:1711`；7 `:1040`；8 `:1067`；9 `:1349`。
`TaskBars` 与 `TurnCard` 在 `src/client.ts:2214/2231/2397` 复用同一 percent+phase
并置模式。）

没有任何共享 selector 或状态对象。每加一个渲染面，就多一套「完成」判断；
截图命中的可能只是其中一处（SessionCard 或 TurnCard）先被看见。

---

## 5. 触发路径与截图匹配度

| 路径 | 机制 | 是否持久 | 证据 | 与截图匹配 |
|---|---|---|---|---|
| **P2a** | 最后一项由 `dsh_workplan_update` 置 done；updateStatus 只到 integrating，不写结果/不晋升 | 持久（刷新后仍 integrating，因为回放也没有 resultSeen） | **V**（`/tmp/t4-manual-done.mjs`） | **最高**：100% + 正在收尾，且可无限期存在 |
| **P2b** | 计划已经 done，之后任意 update（含 no-op）用 `planPhase` 覆盖为 integrating | live 持久；刷新后回放变 done（翻转） | **V**（`/tmp/t4-phase-regress.mjs`） | **高**：可解释“刷新前有矛盾、刷新后正常” |
| **P3** | dispatch 已全 done，但结果消息 append 失败/进程在 767 与 1415 之间退出；`resultWritten=false`，永不晋升 | 持久（回放也 integrating） | **C**（`src/runtime.ts:1405-1415` 的 try/catch 只 warn） | 中：需要会话日志确认 |
| **P1** | dispatch 主循环结束置 integrating（767），随后 1415 置 done | 微任务窗口，HTTP 轮询几乎不可见 | **C**（两行之间无 await/IO） | 低：正常流程很难截到 |
| **P4** | 已完成计划被 cancel；cancelPlan 无条件写 cancelled | 持久 | **V**（`/tmp/t4-cancel-100.mjs`） | 不是截图（会显示“已取消”），但同一结构 |
| **P5** | catch 在全 done 后写 paused/blocked | 取决于路径 | **U**（代码推演，未执行） | 低：需要异常时序 |

**截图最可能对应 P2a 或 P2b**：

- 若截图中的计划是「子任务逐项由主 Agent 核对后 update 完成」，且从未再
  dispatch，则是 P2a——100% + 正在收尾会一直存在，刷新也不消失；
- 若截图中的计划先 dispatch 完成、之后又被 update 过（例如补记证据），
  则是 P2b——live 显示矛盾，刷新后恢复 done；
- 两者都不需要「收尾瞬间」的巧合，也不需要舍入。

这也修正了 T3 的一个推断：`runtime.ts:767→1415` 的收尾窗口在正常 dispatch
流程中太窄，不足以解释一张稳定截图；真正稳定的是 update 路径。

---

## 6. 同类问题清单

「同类」定义为：**两个或多个完成信号来自不同派生/判断，缺少联合约束，
因而可同时成立并互相矛盾。**

| # | 现象 | 证据等级 | 说明 |
|---|---|---|---|
| S1 | live=`integrating` vs replay=`done` | **V**（T2 场景 B） | 同一事件流，两个 phase 来源不一致；刷新翻转 |
| S2 | done 后 no-op update → `integrating` | **V**（`/tmp/t4-phase-regress.mjs`） | 终态回退 + update 非幂等 |
| S3 | 环 92% vs 加权「总体进度」100% | **V**（`/tmp/t4-weighted.mjs`） | 11 done + 1 blocked@95；两个百分比两套口径 |
| S4 | 100% + 「已取消」 | **V**（`/tmp/t4-cancel-100.mjs`） | cancel 无条件覆盖 done |
| S5 | 100% + 「进行中」+ 绿色 + `data-state=done` | **V**（T2 DOM） | 分组/色调/DOM 与数字各自判断 |
| S6 | 「都做完了」+「正在收尾」同卡 | **V**（T2 DOM） | 文案层直接并置 |
| S7 | 阶段「都做完了」+ 计划「正在收尾」 | **C**（`src/client.ts:1349`） | 阶段完成与计划完成不同粒度 |
| S8 | 模型可见文本「正在收尾」+ stats 100 | **C**（`src/host.ts:26`） | 模型也会收到矛盾信号，可能影响后续决策 |
| S9 | 结果写入失败 → 永远 integrating | **C**（`src/runtime.ts:1405-1415`） | 晋升依赖副作用，失败只 warn |
| S10 | 100% + paused/blocked（catch 路径） | **U** | 代码上 catch 不检查全 done；是否可达未验证 |
| S11 | TaskBars/TurnCard 同行 percent+phase | **C**（`src/client.ts:2214/2231/2397`） | 同一并置模式复制到多个渲染面 |

**共同模式**：每个现象都能单独找一个“局部补丁”（比如“done 后不许 update”、
“cancel 时检查全 done”、“加权改口径”），但根因是同一套结构：**完成信号没有
单一事实源，也没有联合不变量**。只修 S6 的文案，S1/S2/S4 仍在；只修 phase
状态机，环与加权仍可能打架。修复必须系统化。

---

## 7. 与 1.4.3 修复的关系：为什么“修过同类问题”还会复发

1.4.3 的根因是 `record.stats` 与 `record.statuses` 双源，修复方式是
`derivePlanSnapshot` 单一派生 + I1–I7 不变量。这次不是 1.4.3 的回归，而是
1.4.3 **明确留下的下一轮**：

> `record.phase`（计划阶段）｜缓存，但有补偿……｜**非计数**，未发现可观测矛盾；
> 保留为设计注意点（见 §8）
> —— `docs/fix-report-derived-counts-1.4.3.md:104`

> `record.phase` 仍是缓存字段……它不参与任何计数。若将来要给 phase 也做同样
> 处理，可作为下一轮的独立改进项。
> —— 同上 §8 第 4 条

问题在于豁免标准：**「不参与计数」不等于「不参与完成语义」**。phase 确实不是
一个数字，但它被渲染成胶囊、分组、色调，是用户判断“完成没有”的主要信号。
1.4.3 把不变量限定在 `stats/departments`，于是：

- 计数内部自洽（I1–I7 全过）；
- 计数与 phase 之间可以任意组合（无 I8+）；
- 变异测试只变异计数，挡不住这次回归；
- 现有测试还把 `integrating` 固化为预期（`tests/workplan-budget-pause.test.ts:159`、
  `tests/plan.test.ts:297`），使得“把 100% 直接改成 done”的粗暴修法会失败。

**这正是“同类问题复发”的机制**：1.4.3 修的是“数字的事实源”，没有修“完成
语义的事实源”。当展示层把 phase 当作完成信号时，phase 就成了第二个事实源，
只是它不叫 stats。

---

## 8. 修复约束与验收建议（交给 T5）

> 本节是诊断结论导出的约束，不是已经实施的修复。T5 需要在“一根轴”与
> “两根轴”之间做产品决策，然后让代码、测试、文案同时对齐。

### 8.1 单一呈现事实源

建议引入一个纯函数（名称示例，不强制）：

```text
derivePlanPresentation(record) -> {
  percent,            // 唯一对外百分比
  phase,              // 唯一对外生命周期
  completionLabel,    // 「子任务 2/2」或「计划已完成」
  badgeLabel,         // 「正在收尾」/「已完成」/...
  group,              // 进行中 / 已完成
  tone,               // active / done / blocked / warn
  weightedPercent?    // 若保留，必须明确标注为另一口径
}
```

约束：

- 所有渲染面（SessionCard、TaskBars、TurnCard、阶段行、host 文本）只消费
  这个对象，不再各自用 `stats.done/total` 或 `session.phase` 判断完成；
- `phase` 若保留缓存，必须在每次序列化时由同一函数重算/校验，或直接删除
  缓存，改为从 `statuses + resultWritten + paused/cancelled/degraded` 派生；
- `percent` 与 `weightedPercent` 若同时存在，必须在 UI 上明确标注两个口径，
  不能一个叫「进度」、另一个只叫「总体进度」却让用户以为是同一件事。

### 8.2 需要新增的联合不变量

在 I1–I7 之外至少增加：

| ID | 不变量 | 目的 |
|---|---|---|
| I8 | `phase==='done' ⇒ percent===100` 且 `weightedPercent===100` | 完成态不能显示未完成数字 |
| I9 | `percent===100` 不得与「正在收尾/进行中」这类**进行语气**的徽章并置；若保留 100%，必须明确标注为「子任务完成度」，徽章写「工作项已完成 · 待汇总」 | 禁止同一轴自相矛盾 |
| I10 | `phase` 单调：`done` 为吸收态；只有显式 reopen/resume（带原因）可离开；`updateStatus` 幂等（done→done 不改变 phase） | 防 S2 |
| I11 | 同一事件流：`live.phase === replay.phase` | 防 S1 |
| I12 | `cancelled/paused/blocked` 不得与 `percent===100` 并置，除非 UI 明确标注为“完成后取消/暂停”并解释原因 | 防 S4/S10 |
| I13 | `percent===100` 时，`planNow`、阶段行、workerText、nextText 必须与主徽章使用同一完成语义 | 防 S5–S7 |

**注意**：I9 不是「100% 必须等于 done」。如果产品决定环表示工作项完成度，
那么 100% 可以合法存在，但徽章/文案必须换成两个轴的表达；如果产品决定环表示
计划进度，那么 `integrating` 应显示 ≤99，100% 只在 done 出现。**两者只能选
一个，不能像现在这样混用。**

### 8.3 状态机修复（与呈现修复同等重要）

1. **统一晋升函数**：`markAllDoneIfNeeded(record)` 由 `updateStatus` 与
   `dispatchTool` 共用；当 statuses 全 done 时，要么写结果并置 done，要么
   置一个明确的 `awaiting_result` 子状态，不能停在语义模糊的 `integrating`。
2. **去掉 `resultSeen` 丢失**：`updateStatus` 与 `dispatchPlan` 重算 phase 时
   必须传入 `record.resultWritten`（或统一由 `derivePhase(record)` 读取），
   不能再用默认 `false`。
3. **`done` 吸收态**：`updateStatus` 对 `phase==='done'` 的计划默认 no-op
   （除非显式 `reopen:true` 并记录原因）；不能让一次补记把计划打回收尾。
4. **结果写入与晋升解耦/原子化**：结果 append 失败时，phase 不能静默停在
   `integrating`；至少标 `degraded` 并给出可见错误，或重试。
5. **cancel 保护**：全部 done 时 cancel 应拒绝，或转成「已完成（取消备注）」，
   不能出现 100% + 已取消。
6. **回放同源**：`reconstructFromSession` 与 live 使用同一个
   `derivePhase(record)`；`serialisePlan` 的 fallback 也要传 `resultSeen`。

### 8.4 测试建议

**新增端到端/契约测试**（不要只测纯函数）：

1. **golden payload**：`integrating` 全 done → 断言呈现对象满足 I8–I13；
2. **done 后 no-op update**：phase 仍 done，percent 100，不再出现“正在收尾”；
3. **update 完成最后一项**：要么 done（并写结果），要么明确
   `awaiting_result` + 非进行语气徽章；不能无提示停 integrating；
4. **cancel after done**：不出现 100% + 已取消；
5. **结果 append 失败**：phase 不得静默 integrating；断言可见错误/降级；
6. **11 done + 1 blocked@95**：断言环与加权口径的差异被明确标注，或统一口径；
7. **live/replay parity**：同一事件流 phase 相同；
8. **DOM 断言**：同一张卡不得同时出现 `100%` 与「正在收尾」（除非 100% 被
   明确标注为「子任务完成度」且徽章为「待汇总」这类非进行语气）。

**修改现有测试**：

- `tests/workplan-budget-pause.test.ts:159` 与 `tests/plan.test.ts:297` 目前
  把 `integrating` 当作“全 done 后的正确 phase”。修复后应改为断言**呈现契约**
  （percent、badge、group 的联合关系），而不是只断言 raw phase；否则旧的
  “正确”会挡住新契约。
- 增加变异测试：手工把 `phase` 改成 `done` 但 percent 不是 100、把 percent
  改成 100 但 badge 仍是进行语气，不变量检查器必须失败。

### 8.5 生效注意

- 修改 `src/*.ts` 后需要 `npm run build`，生成 `lib/*.js` 与 `client.js`；
- 已安装实例启动时加载 `lib/*.js`，**需要重启 DSH 或重新加载 web profile**
  才能生效（1.4.3 §9 的同类注意事项）；
- 若截图字面是「正在做收尾」，先核对运行构建版本，再谈修复验证（U1）。

---

## 9. 置信度与未验证边界

| 结论 | 置信度 | 依据 |
|---|---|---|
| 直接原因：payload 同时含 integrating 与 100%，客户端分别渲染 | 0.95 | 代码 + T2 DOM |
| 结构性主因：两个完成语义共用一根轴 | 0.9 | 代码 + 设计文档 + 复现 |
| update 完成路径到不了 done | 0.98 | V（`/tmp/t4-manual-done.mjs`） |
| done 可被 no-op update 回退 | 0.98 | V（`/tmp/t4-phase-regress.mjs`） |
| 舍入不是截图环 100 的原因 | 0.99 | MAX_SUBTASKS + 枚举 |
| 加权口径是另一同类缺陷 | 0.95 | V（`/tmp/t4-weighted.mjs`） |
| 文案/色调/分组是呈现诱因 | 0.85 | DOM + 设计文档；用户感知属推断 |
| live/replay 翻转 | 0.95 | T2 场景 B |
| 截图具体触发路径是 P2a 还是 P2b/P3 | 0.5 | 缺少会话日志/时间戳，无法唯一确定 |

**未验证项**：

- **U1（文案/版本）**：当前仓库与 git 历史均无「正在做收尾」。若截图字面如此，
  运行构建可能不是当前 1.5.1；需要主 Agent 核对截图来源、构建时间、是否重启。
  根因结构不受影响，但“是哪一版”会影响修复验证。
- **U2（具体触发）**：无法仅凭代码判断截图对应 P2a/P2b/P3 中的哪一条；需要
  会话日志（最后一次 update/dispatch 的时间、是否写过结果消息、phase 变更历史）。
- **U3（异常路径）**：P5（catch 在全 done 后写 paused/blocked）与 P3 的
  “进程在 767 与 1415 之间退出”只做了代码推演，未构造真实运行时故障。
- **U4（用户感知）**：把 100% 读成“计划完成”是用户侧解释；设计文档认为用户
  应能通过组名/胶囊消歧。本报告认为标签语气不足以消歧，但这是产品判断，
  不是纯代码事实。
- **U5（设计决策）**：环到底表示“工作项完成度”还是“计划进度”，当前文档
  两种说法都有（`status-grouping-ia.md:367` 明确说工作项完成 ≠ 计划完成，
  但 UI 仍把两者并置）。T5 必须先做这个决策，否则任何“修复”都只是换一种
  矛盾。

---

## 10. 对截图的直接解释（一段话）

计划的所有子任务已经 `done`（所以环/计数显示 100%、2/2，`planNow` 显示
「都做完了」），但计划 `phase` 仍是 `integrating`（结果尚未汇总，或 `done`
后被一次 update 重算回 `integrating`，或最后一项由 update 置 done 而从未
dispatch 写结果）。卡片环只读 `stats`，徽章只读 `phase`，两者在同一折叠头，
于是同屏出现「100% + 正在收尾」。100% 与「正在收尾」各自都是真话；矛盾来自
它们被当成同一根进度轴上的两个断言，而代码既没有跨字段不变量，也没有保证
`done` 的单调性/可达性。

---

## 附录 A：命令与输出

### A.1 T2 主复现（永久脚本）

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
node scripts/repro-phase-percent-integrating.mjs
```

关键输出：

```text
RESULT: PASS
stability: 3/3 ...
planviz: data-percent="100" data-state="done"
text: 100% · 2/2 · 都做完了 · 正在收尾
```

### A.2 done 后 no-op update 回退（T4 临时脚本）

```text
回放（结果消息已落盘）: done
实时缓存（resultWritten=true）: done
一次 updateStatus 之后实时: {"phase":"integrating","done":2,"total":2}
同一会话回放: done
```

### A.3 update 完成路径永不晋升（T4 临时脚本）

```text
更新前: {"phase":"executing","stats":{"total":2,"done":1,"progress":75}}
更新后 #1: {"phase":"integrating","done":2,"total":2}
更新后 #2: {"phase":"integrating","done":2,"total":2,"resultWritten":false}
```

### A.4 cancel after done（T4 临时脚本）

```text
取消前: {"phase":"done","done":2,"total":2}
取消后: {"phase":"cancelled","done":2,"total":2,"percent":100}
```

### A.5 加权 vs 环（T4 临时脚本）

```text
11 done + 1 blocked@90 {"done":11,"total":12,"weighted":99,"ring":92}
11 done + 1 blocked@95 {"done":11,"total":12,"weighted":100,"ring":92}
11 done + 1 blocked@99 {"done":11,"total":12,"weighted":100,"ring":92}
11 done + 1 blocked@100 {"done":11,"total":12,"weighted":100,"ring":92}
```

> T4 临时脚本位于 `/tmp/t4-*.mjs`，生命周期短；T5 应把关键场景固化为
> `tests/` 下的永久测试，而不是依赖 `/tmp`。

---

## 附录 B：代码阅读地图

| 关注点 | 位置 |
|---|---|
| 子任务/阶段上限 | `src/plan.ts:14`、`src/plan.ts:423/455/558` |
| 聚合与加权 | `src/plan.ts:1235-1282` |
| 不变量（仅计数） | `src/plan.ts:1312-1318` |
| phase 纯函数 | `src/plan.ts:1377-1383` |
| payload 组装 / phase 缓存优先 | `src/runtime.ts:868` |
| dispatch 结束置 integrating | `src/runtime.ts:767` |
| 预算暂停 | `src/runtime.ts:803` |
| catch 收敛 | `src/runtime.ts:837` |
| updateStatus 重算（丢 resultSeen） | `src/runtime.ts:1209` |
| cancel 无条件置 cancelled | `src/runtime.ts:1235-1272` |
| 结果写入与 done 晋升 | `src/runtime.ts:1404-1416` |
| 回放（使用 resultSeen） | `src/runtime.ts:926-1030` |
| percent 计算 | `src/client.ts:1475` |
| planNow「都做完了」 | `src/client.ts:1557` |
| PlanViz state/data-percent | `src/client.ts:1667-1674` |
| 加权总体进度 | `src/client.ts:1711` |
| 胶囊 | `src/client.ts:1764` |
| 分组 | `src/client.ts:2286` |
| 模型侧 phaseLabel | `src/host.ts:26` |
| 现有 integrating 断言 | `tests/workplan-budget-pause.test.ts:159`、`tests/plan.test.ts:297` |
| 1.4.3 phase 豁免 | `docs/fix-report-derived-counts-1.4.3.md:104`、§8 |
| 设计文档承认该组合 | `docs/status-grouping-ia.md:367`、`:149`、`:767` |

## 附录 C：第二轮独立复核（T4，2026-10-29 12:30）

> **目的**：把 §3 的每条 V 级结论用当前构建物重跑一遍，确认报告可复核；本轮不改源码。
> **环境**：`b0e0b76`（1.5.1），Node `v26.9.0`；工作区仅本报告与 T2 复现脚本未跟踪。
> **复核通道**：运行中的 GUI 端点 `GET /dsh-workplan/plans` 需要鉴权（实测 `HTTP 401`
> `{"ok":false,"error":"未授权的请求"}`，见 `src/runtime.ts:1450-1458`），因此与 T2 一样，
> 复核走真实构建物 `lib/*.js` + `client.js` 的进程内调用，不依赖浏览器会话。

### C.1 重放结果

| # | 复核项 | 命令（均在 `plugins/dsh-workplan/` 下执行） | 实测输出（摘要） | 支撑假设 |
|---|---|---|---|---|
| R1 | 最小复现 | `node scripts/repro-phase-percent-integrating.mjs` | `RESULT: PASS`；3/3 指纹 `76e136bdd1da5e34…`；DOM `data-percent="100" data-state="done"`；卡片文本 `100% · 2/2 · 都做完了 · 正在收尾` | H1、H4 |
| R2 | done 后 no-op update 回退 | `node /tmp/t4-phase-regress.mjs` | 回放 `done` → 实时 `done` → 一次 updateStatus 后 `{"phase":"integrating","done":2,"total":2}` → 同一会话回放 `done` | H3 |
| R3 | update 置最后一项 done | `node /tmp/t4-manual-done.mjs` | 更新前 `executing` 1/2 75%；更新后两次读取均 `integrating` 2/2、`resultWritten=false` | H3 |
| R4 | done 后 cancel | `node /tmp/t4-cancel-100.mjs` | `done` 2/2 → `cancelled` 2/2、`percent=100` | H3 同类 |
| R5 | 环 vs 加权 | `node /tmp/t4-weighted.mjs` | 11 done + 1 blocked：@90 → 加权 99 / 环 92；@95/@99/@100 → 加权 100 / 环 92 | H2 同类 |
| R6 | 舍入枚举 | 内联 `node`（见下） | `total<=15` 内不存在「done<total 且显示 100」；`total<=500` 首个为 `199/200` | H2 |

R6 的判定式与输出：

```text
ring(d,t) = Math.round(d/t*100)
1<=t<=15 枚举 0<=d<t：无 ring>=100          // 插件 MAX_SUBTASKS=15（src/plan.ts:14）
1<=t<=500 枚举 0<=d<t：首个 ring>=100 为 199/200（99.5 向上取整），远大于插件上限
```

### C.2 假设判定复核表（最终）

| ID | 假设 | 判定 | 决定性证据（本轮重放） | 置信度 |
|---|---|---|---|---|
| H1 | 双数据源 / 两套独立完成判断 | **计数层不成立；完成语义层成立（主因）** | R1：同一 payload 同时 `stats.done===stats.total` 与 `phase==='integrating'`。`percent` 只读 done/total（`src/client.ts:1475`）；phase 读缓存或 `planPhase(statuses[, resultSeen])`（`src/runtime.ts:868`、`src/plan.ts:1379`）；两者无共享 selector、无联合断言 | 0.95 |
| H2 | 四舍五入导致 100% | **对截图环不成立**；加权口径是另一同类缺陷 | R6：插件上限内不可能出现舍入 100；R5：加权 100 与环 92 可并存，但该组合 phase 为 `blocked`/`executing`，不会是 `integrating` | 0.99 / 0.95 |
| H3 | 终态缺失 | **部分成立**：`done` 存在，但 update 路径到不了、且可被 no-op update 回退 | R2/R3：`done` 后一次 update 即回 `integrating`；`updateStatus` 用 `planPhase(record.statuses)`（`src/runtime.ts:1209`）且不传 `resultSeen`；唯一晋升边在 `src/runtime.ts:1414-1415` | 0.98 |
| H4 | 文案语义重叠 | **成立（呈现诱因）** | R1：`100%`、`2/2`、`都做完了`、`正在收尾`、`data-state=done` 同卡；Collapse 把 title/meta/badge 放进同一 summary 行（`src/client.ts:1220-1239`），meta 内含 PlanViz 的百分比与「都做完了」 | 0.9 |
| H5 | 竞态/缓存时序 | **对截图不成立**；只解释刷新翻转 | `serialisePlan` 全函数无 `await`，payload 内 stats/statuses/phase 同一同步时刻读取；R2 的 live/replay 分歧来自两个 phase 来源，不是同一 payload 的读写竞态 | 0.9 |
| H6 | 1.4.2 stats 缓存 | **不成立** | `record.stats` 仅注释残留（`src/runtime.ts:853/1419`）；R1 中 `stats` 与两条 done 状态完全一致 | 0.95 |
| H7 | 设计预期 | **部分成立，但不否定缺陷** | 设计文档承认 100%+收尾（`docs/status-grouping-ia.md:367`），测试固化 `planPhase(allDone)==='integrating'`（`tests/plan.test.ts:297`）；但设计未覆盖回退、update 不可达、取消 | 0.9 |

**收敛结论（复核后与 §0 一致）**：主因是「工作项完成度」与「计划生命周期」两个完成语义
各自派生、共用同一视觉槽，且没有跨字段不变量；`planPhase` 对「全 done 且
`resultSeen=false`」返回 `integrating`（`src/plan.ts:1379`）是截图出现的直接机制；
`updateStatus` 丢 `resultSeen` 使该状态可持久、`done` 非吸收态使其可回退，是让矛盾
「稳定存在」的关键诱因；呈现层多处独立完成判断与标签语气重叠是放大器。

### C.3 复核发现的小更正（均不影响结论）

1. **字面文案 U1 收窄**：`grep -c '正在做收尾'` 在本仓库 `src/`、`locale/`、`client.js`、
   `lib/*.js` 全部为 0，`git log -S` 无记录；本机会话文本中该字样只出现在本轮任务描述里。
   当前 UI/模型侧文案均为「正在收尾」（`src/client.ts:64`、`src/host.ts:26`）。
   因此截图字面差异更可能是转述/OCR；若截图来自其他机器或旧构建，本机无法证实。
2. **行号校正**：`dsh_workplan_update` 的 status 枚举在 `src/host.ts:95`（原文 `:92`
   是 subtaskId schema 的结尾）；Collapse 同排渲染实现在 `src/client.ts:1220-1239`
   （原文 `:1167` 是注释示例）；`PlanViz` 的 state/data-percent 在
   `src/client.ts:1667-1676`；`aggregateInvariantViolations` 从 `src/plan.ts:1318`
   开始（覆盖 I1–I7 至函数结束）。
3. **phase 写入点计数**：`grep 'record\.phase\s*='` 精确为 8 处
   （`717/767/803/837/1209/1244/1263/1415`），与 §4.3 一致；T3 报告的 9 处应是把
   `src/runtime.ts:690`（读）或 `:1356`（读）也计入了。

### C.4 未决项

- **U2 仍未验证**：无法唯一确定截图对应 P2a（最后一项由 update 置 done 并持久）还是
  P2b（done 后又被 update 回退）。需要原始会话日志与时间戳；两条路径用户看到的结果相同，
  不影响主因判定。
- **运行实例版本未核对**：端点鉴权挡住了对运行中 payload 的采样，修复后需重启并按
  §8.4 的 DOM 断言复核；本轮全部证据来自与源码同逻辑的构建物。
