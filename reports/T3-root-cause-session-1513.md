# T3 分配慢根因诊断报告（session-1513，只读）

输入：T1 摘录、T2 时间线（同目录两份报告）。代码基线：当前工作区 src（含 6059 未提交修改），运行态为 15:11 加载的旧 lib；凡涉及运行态结论均以事件日志为准。

## 一、主要耗时环节（量化占比 + 代码位置双证据）

**主环节 = 规划器（planner）单次模型调用，并被「整轮重试」与「跨 turn 重新规划」两个放大器叠加。**
- 占比：截图可见等待 ≈100% 落在模型泳道单条长条（T1§二），工具泳道无活动；6059 心跳全部为「正在等待模型返回」（T2§一）。
- 量级：xhigh 旧构建单次尝试 5–10 分钟、重试后累计 ≥14 分钟（T2）；medium 新构建本会话 turn1 仍 5 分 16 秒（07:48:04→07:53:20Z，S1513 turn/start→step/start）。
- 代码位置：
  - 档位继承（旧构建根因）：src/runtime.ts:1002-1011 注释与实现——旧行为 `plannerEffort || modelSelection.reasoningEffort` 使规划器继承主会话档位；6059 request/header 07:26:51Z 实证 xhigh。现构建已改 default-medium（status 实证），但 medium 仍 ~5 分钟 ⇒ 档位只是放大器之一，非唯一根因。
  - 整轮重试：src/runtime.ts:721 `PLANNER_MAX_ATTEMPTS=3`；重试=重新发起完整生成（心跳「第 2/3 次尝试」从累计 5 分/10 分处重新计时，T2）。
  - 窗口与心跳口径：src/runtime.ts:246 `PLANNER_TIMEOUT_MS=300000`、259 idle 90s；预告「约 3 分钟」口径未含长尾与重试（T2§一.4）。
  - 跨 turn 重规划：src/runtime.ts:9206（仅 step1 规划）、9232（仅同 turn 跳过）、9265-9272（跨 turn 未派发即取消重规划）；6059 turn2 07:30:06Z 重新发【规划预告】实证；本会话 08:06–08:10Z 又出现一轮规划心跳（触发消息仅为插件自身【状态改判】通知，待 T3 附注 V6 核实 humanMessages 过滤）。
  - 输入规模：截图底部 46.7K tok（T1）——大 prompt+大 JSON schema 使单次生成即使 medium 也分钟级。

## 二、根因清单与证伪检查

| # | 根因 | 证据 | 证伪检查（若不成立应看到什么） | 判定 |
|---|---|---|---|---|
| R1 | 规划器继承主会话最高档（旧构建） | 6059 REQ xhigh + 代码 1002 | 若独立低档，REQ 应显示 low/medium | 成立（旧构建） |
| R2 | 大 prompt/大 schema 单次生成本身分钟级 | medium 仍 5m16s；46.7K tok | 若仅档位问题，medium 应秒级 | 成立 |
| R3 | 失败整轮重试翻倍等待 | 心跳 2/3 标签 + 721 | 若增量续写，累计不应重新计时 | 成立 |
| R4 | 跨 turn 从零重规划 | turn2 预告 + 9232/9265 | 若复用旧计划，turn2 不应再发预告 | 成立 |
| R5 | 网络/外部服务波动为主因 | — | 应见工具/网络重试事件与泳道碎片；实际单条模型长条 | 淘汰 |
| R6 | 派发崩溃与慢同根因 | 崩溃毫秒级 TypeError | 同根因应表现为耗时型而非瞬时型 | 淘汰（独立缺陷，见§三） |

## 三、独立缺陷：派发毫秒级崩溃（根因未闭环，如实标注）

- 现象：S1513 自动派发 T1/T2/T4 于 +2…40ms 抛 `Cannot read properties of undefined (reading 'id')`，childId=null，两次尝试相同。
- 候选点：宿主 dsh-subagent lib/index.js:3024 `spec.parent.id`（parent=options.agent，插件 runtime.ts:2212 透传）；若 options.agent 为 undefined 则必抛该错。插件侧 auto 路径 agent=payload.agent（runtime.ts:9574/5153），按宿主契约应非空 ⇒ **矛盾未解**。
- 所缺证据：运行态堆栈（持久日志无堆栈，G2）。结论未成立，禁止当既定事实。
- 最小诊断/修复方向（交 6059）：① executeSubtask catch 增补 error.stack 留痕（record.errors+受阻行）；② spawn 前对 options.agent 做 fail-closed 校验并经 ctx.get('agents') 解析活 parent，缺失时抛带上下文的 PlanError 而非宿主 TypeError；③ 用①的堆栈闭环后再定补丁。

## 四、最小修复方向（不改码，交 T5b 细化）

F1 规划器档位与主会话解耦并设上限（已部分落地 default-medium，需回归确认）。
F2 规划「先骨架后细化」或流式可见：先秒级产出阶段/子任务骨架展示，细化异步补全，消除「全有或全无」等待。
F3 重试改增量/降级（降档重试而非同档整轮重跑）。
F4 跨 turn 复用未过期计划（含插件自身通知 turn 不触发重规划）。
F5 派发崩溃 fail-closed 校验+堆栈留痕（§三）。
F6 预告口径按实测分位数标注，含重试放大说明。
