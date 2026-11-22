# 功能规范（ADV_FSP.1 对齐）／ Functional Specification

> 对象（TOE）：dsh-workplan 插件 v1.12.0 ｜ 基线：git HEAD `5fe47a1` ｜ 日期：2026-11-03 ｜ 撰写：T5（文档与合规证据）
> 性质：**公开自评估文档**，非认证机构出具的评估证据。本插件未通过 CC 认证，本文不宣称任何证书。
>
> TOE：dsh-workplan plugin v1.12.0 ｜ Baseline: git HEAD `5fe47a1` ｜ 2026-11-03 ｜ Nature: **public self-assessment**, not accredited-lab evidence. No CC certificate is claimed.

## 0. 覆盖的差距编号 / Covered gaps

G-08（ADV-FSP.1 独立接口规范缺失）。核对方法：工具名逐一来自 `src/host.ts` 的 `name:` 字段（L201/338/472/567/633/713/787/873/936），路由来自 `src/runtime.ts` L5516。任何人可用 `grep -n "name: 'dsh_workplan_" src/host.ts` 复核。

## 1. 对外接口总表 / External interface inventory

TOE 对外暴露 **2 类接口**：9 个 Agent 工具（宿主注入给模型调用）+ 1 个本地 HTTP 路由（面板数据源）。

### 1.1 Agent 工具（14 个）／ Agent tools

| # | 工具 | 调用者 | 用途（一句话） | 关键参数 | 失败/拒绝行为 |
|---|---|---|---|---|---|
| 1 | `dsh_workplan_dispatch` | 主 Agent | 派发计划执行（2.5.2 起首次派发强制主 Agent 两轮深度思考协议） | `planId?`, `mode: wait/async`, `deepThink{problemAnalysis, approach, approachBasis}`（首次派发必填） | 无计划/重复派发幂等返回；首次派发未交/不合格两轮思考产物硬拒 `MAIN_DEEP_THINK_MISSING` / `MAIN_DEEP_THINK_INCOMPLETE`（不启动子 Agent），登记后 durable 持久化、续跑/重启回放读档放行，重规划新计划须重新提交；`complete:false` 表示未完成，必须续跑 |
| 2 | `dsh_workplan_status` | 主 Agent（只读） | 查看各子任务实时状态 | `planId?` | 只读，无副作用 |
| 3 | `dsh_workplan_update` | 主 Agent | 回写子任务状态/证据/验收 | `subtaskId`, `status`, `verification`, `acceptance[]` | done 需 structured+pass，否则 `deliveryReady=false`；执行中改判需 `force` |
| 4 | `dsh_workplan_replan` | 主 Agent | 需求变更时重规划 | `reason`, `changes[]` | 执行中调用返回 `REPLAN_PLAN_RUNNING`，变更不丢 |
| 5 | `dsh_workplan_cancel` | 主 Agent | 取消计划（或转移责任） | `planId?`, `reason`, `disposition`, `supersededBy?` | supersede 需 V1–V8 复算，任一不满足返回 `SUPERSEDE_*` |
| 6 | `dsh_workplan_followup` | 主 Agent | 向直接子会话补发说明 | `sessionId`, `message` | 非直接子会话一律拒绝 |
| 7 | `dsh_workplan_instruct` | 主 Agent | 向「待指示」子任务下发决定 | `subtaskId`, `instruction` | 仅接受 `closure=escalated` 的行 |
| 8 | `dsh_workplan_escalate` | 子 Agent | 子任务遇阻上报请示 | `question`, `options?`, `needs?` | 调用后子任务置「待指示」 |
| 9 | `dsh_workplan_handoff` | 主 Agent（仅根会话） | 处置跨部门需求 | `action: list/assign/resolve/close` | 非根会话拒绝 |
| 10 | `dsh_workplan_verify` | 子 Agent（阶段三） | 核验三阶段证据与验收覆盖（planning 为两轮深度思考产物，approachBasis 必填，2.5.1） | `phases`（planning/execution/verification） | 阶段一/二返回 `PHASE_GATE`；证据缺口返回 `VERIFICATION_INCOMPLETE`；核验通过不等于完成 |
| 11 | `dsh_workplan_lessons` | 根会话 / 子 Agent（只读） | 查看永久教训记忆（`list` / `search` / `stats`） | `action`、`department`、`query`、`limit` | 只读，不写计划状态、不提供写入动作；记忆只能由阶段三复盘通过后的完成判定写入 |
| 12 | `dsh_workplan_delegate` | 部门负责人子 Agent（2.3.9；2.5.0 强化） | 第三层派发：先提交「两轮深度思考」产物（第一轮全面、全盘、深入梳理研究思考自己的任务，第二轮基于其全部结果理清方法、流程、步骤），再把任务拆成更简单的单项工作分给本部门多名顶尖专家与组员 | `action: review/dispatch/status/self_effort`、`consolidation{problemAnalysis, approach, approachBasis, assignments[], taskReasoningEffort?}`、self_effort 携带 `reasoningEffort+complexityRationale+deepThink{problemAnalysis, approach, approachBasis}`（2.5.2 叶子执行前硬门禁） | 非部门负责人子会话（根会话 / 第三层叶子）拒绝；`review` 未登记时 `dispatch` 返回 `DELEGATE_CONSOLIDATION_MISSING`；两轮产物缺 approach/approachBasis 返回 `DELEGATE_CONSOLIDATION_INCOMPLETE`（2.5.1）；分工表缺 expert 或 member 返回 `DELEGATE_ROLE_MIX_REQUIRED`；越界推理等级按模型家族集合钳制并留痕；`taskReasoningEffort` 非法返回 `DELEGATE_TASK_EFFORT_INVALID`，合法则钳制后写入状态行 `effortOverride`（五档白名单消毒 + durable 回放 + 尝试重置不清除），派发链每次激活经 `resolveTaskEffort` 优先读它，下级档位以成员 self_effort 自配为权威（分工表档仅建议；继承仅旧计划回放兼容）；下级子会话 `maxDepth:2`，第四层由宿主深度上限硬拒 |

| 13 | `dsh_workplan_hold` | 主 Agent（仅根会话） | 认可闸门·显式按住：把尚未派发的计划置为「用户认可前不得派发」（3.0.0 本地修复；与任务锚点关键词识别互为双保险） | `planId?`, `reason` | 已派发的计划拒绝；已按住时幂等返回 |
| 14 | `dsh_workplan_release` | 主 Agent（仅根会话） | 认可闸门·解除并开跑：登记用户认可留痕（`gateHistory`，durable 回放不丢）后立即派发，语义与 `dsh_workplan_dispatch` 同一套闸门 | `planId?`, `note`, `deepThink?`, `mode?` | 非 held 计划返回 `NOT_HELD`；解除后派发若被 deepThink 等门禁拒绝，闸门保持已解除、认可事实无需重来 |

### 1.2 HTTP 路由（1 个）／ HTTP route

| 路由 | 方法 | 用途 | 安全头 | 说明 |
|---|---|---|---|---|
| `/dsh-workplan/plans` | GET | 返回面板所需的计划状态数据 | `x-content-type-options: nosniff`、`referrer-policy: no-referrer`（`HARDENING_HEADERS`，见 `tests/security-headers.test.ts`） | 非该路径一律拒绝（`src/runtime.ts` L5516）；只读，无写入接口 |

### 1.3 宿主生命周期订阅（4 个）／ Host lifecycle subscriptions

这些事件是插件与 DSH 宿主的内部协作入口，不是新增模型工具或 HTTP 路由。

| 事件 | 触发时机 | 本插件行为 | 边界与失败防护 |
|---|---|---|---|
| `agent/pre-step` | 模型步骤开始前 | 识别真实任务、启动后台规划；在途规划期间允许后续 step 的不同真实任务取代旧规划 | 非根会话、内部通知、社交/状态/空泛续跑不启动或取消规划；相同任务去重 |
| `agent/inbox/inserted` | followup/queue 消息进入 live inbox | 收尾正在等待旧规划时，不同真实人类任务入队即中止旧规划，防止旧结果迟到覆盖 | 只认 `source.kind=user` 或省略的人类消息；同任务、状态问题和内部 workplan 通知不取消；旧规划经 `superseded + AbortController` 静默退出 |
| `agent/created` | 任一 Agent 创建完成、发布到注册表之前 | [3.1.6] 子 Agent 的 `agent.ctx` 注册同名 system-prompt section（子会话提示）覆盖全局「主 Agent 专属段」，把 5,354 字符的主 Agent 指引从部门负责人/专家每步注入中移除；根会话不动 | 只读 `session.header`（parentSession/origin/delegationDepth）判角色；WeakSet 保证每 Agent 只注册一次；任何异常 fail-open（保留全局段，只多付 token、不影响能力）；不改工具权限与任何判定逻辑 |
| `agent/turn-stopping` | 自然收尾且 next-step inbox 为空 | 等待在途规划结算，并把成功/降级/澄清结果一次性交回主 Agent；随后执行既有未完成与认可闸门 | 若等待期间已由另一规划接替，旧 waiter 退出；held 计划交回后仍等待用户认可，不进入重复 steer |

### 1.4 不存在的接口（负面声明）／ Interfaces that do NOT exist

- 无网络出站调用、无遥测上报（零运行时依赖，`package.json` `dependencies` 为空）。
- 无鉴权/账户体系（见 ST 假设 A-1：宿主环境已鉴别，TOE 不自做鉴别）。
- HTTP 层无任何写入/删除路由。

## 2. SFR 对应 / SFR trace

接口行为与 ST（`docs/cc/SECURITY-TARGET.md`）SFR 的对应：审计留痕→FAU_GEN（状态变更全留档）；访问控制→FDP_ACC/ACF（文件沙箱 + presented-write-guard）；域隔离→FPT_SEP（子会话隔离）；会话终止→FTA_SSL（负责人/专家执行无总时长、单次、空闲或无回执硬截止；旧时限配置与 deadline 仅历史回放，不再生成计时器；用户取消、真实错误与证据/质量门禁仍有效）。
