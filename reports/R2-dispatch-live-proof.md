# R2-T3 派发重启后实证与堆栈取证（最终版）

负责人：research:T3（agent-5，session 79f1a172-b028-4b7d-bce3-05a70c818f7a）
下级：log-forensics（expert，childId 77aee598-37e7-496a-993e-8c97119c0d8f）、code-verifier（member，childId 626679e1-f9b8-42aa-9aa6-071cef56a1b7）
取证时间：2026-11-12 17:54–18:10 (+08:00)｜方式：全程只读（zstd -dc 多帧解码 + 源码阅读），未调用主计划派发工具 dsh_workplan_dispatch、未重启服务。

## 0 单一结论

**不再崩溃。** 重启（2026-11-12 17:50:54，pid 20983，插件 build 4ba6e9dc9b4161a8）后：
- 新回合自动派发（第二层）6 次子会话登记 childId 全部非空；
- 第三层部门派发（本负责人亲自执行）2 名下级成功启动并运行至完成；
- 8 个子会话实测存活 50s–346s+、事件 24–170 条、持续真实工具活动；
- 重启前「17–43ms 即崩、childId=null、TypeError reading 'id'」的基线模式未再复现；
- 代码侧核对：根因修复（spec 顶层契约拍平 + resolveLiveAgent 兜底 + fail-closed）存在于 src 且已编译进运行时加载的 lib 产物，三条派发路径全覆盖。

## 1 重启时间界（三方一致）

| 证据 | 值 | 来源 |
|---|---|---|
| 进程自报 | `v2.5.4｜build 4ba6e9dc9b4161a8｜pid 20983｜启动 2026/11/12 17:50:54` | 主会话解码流 L820（seq 818，tool/result，17:54:28.778）——log-forensics 取证 |
| cordis.yml mtime | 2026-11-12T17:50:54+0800 | 负责人 `stat ~/.dsh/profiles/web/cordis.yml` |
| session/end-seed | L799，17:51:06.289 | 负责人提取器（scripts/wp-fix/r2-dispatch-extract.py） |

切分界 T0=1794477054000（17:50:54）；此前记录一律标注 pre，仅作基线对照。

## 2 重启前基线崩溃（pre，仅对照，不作现状结论）

权威证据源：`~/.dsh/sessions/--Users-open-Documents-Stocks--/session-6e26e9e5-1d95-4d47-b59d-4d75b838cae7/session.v4.jsonl.zstd`（解码 `zstd -dc`，行号 L# 为解码后行号）。

| 时刻 | 事件 | 关键原文 | 行号 |
|---|---|---|---|
| 16:49:51.366→.373 | T1 派发→受阻仅 **17ms** | 结果块 `"childId":null,"startedAt":1794473391356,"finishedAt":1794473391373`，`"error":"Cannot read properties of undefined (reading 'id')"` | L9–L11 |
| 17:29:49.218 | 手动 `tool/call dsh_workplan_dispatch` | callId call_4b19266f771049cca458af33 | L431 |
| 17:29:49.244/.250（+26/+32ms） | T3/T4【执行中断】 | `UNKNOWN：Cannot read properties of undefined (reading 'id')` | L434/L435 |
| 17:29:49.257/.258 | T3/T4 受阻 | 「子会话未留下已核实的在盘产物」 | L436/L437 |
| 17:29:49.261（+43ms） | tool/result | 计划未就绪 2/5，受阻 3 | L439 |

## 3 重启后派发实证（POST）

### 3.1 第二层：自动派发 6 次登记，childId 全部非空（subagent/catalog 原文）

| 行号 | 时刻 | childId | 名称/角色 |
|---|---|---|---|
| L806 | 17:53:41.434 | fe57cfa9-6a8f-4109-be6e-a958fcb217aa | agent-1 devops:T1 phase-0 |
| L807 | 17:53:41.442 | f3251269-2459-46ba-bbc8-384fac208736 | agent-3 research:T3 phase-0 |
| L808 | 17:53:41.447 | c7563f07-af73-486e-b1ab-b5fe19d093df | agent-2 qa:T2 |
| L822 | 17:54:31.359 | 33dab0e6-317e-450f-8325-f73fbfe69c9f | agent-4 T1 phase-1 接续 |
| L824 | 17:54:45.341 | 79f1a172-b028-4b7d-bce3-05a70c818f7a | agent-5 T3 phase-1（本负责人） |
| L847 | 17:55:51.783 | 9ae362c5-545e-4a4a-a9dd-78d81e042b87 | agent-6 T1 EVIDENCE_MISSING 重试 |

L811 17:53:42.833【任务分解】正常显示；派发心跳 L817/L831/L848/L863/L867（45s→3m45s）「3 个子任务执行中，不是卡死」。
首轮子会话 f3251269、fe57cfa9 末事件均为 `turn/end reason=completed`（负责人独立解码核对，tool_errors=0）——其后继是 phase-0→phase-1 平台接续，不是崩溃重试。

### 3.2 第三层：本负责人亲自派发，2 名下级非空 childId 运行至完成

主会话 L833（17:55:24.618）及 workplan-update revision 9–11（L838/L839/L849/L850）登记中出现的第三层 childId（77aee598、626679e1、a20c7f18、ff69046c）**全部非空**，对应会话目录均存在且有真实事件流（含 phase 接续登记）。实际回传结论的下级：
- log-forensics（77aee598）：17:55:24 启动，存活 302s+、135 事件，报告落盘并回传；
- code-verifier（626679e1）：17:55:24 启动，存活 300s+、170 事件，报告落盘并回传。

本负责人自身会话日志 117 行（取证时点）、tool_errors=0。

### 3.3 子会话存活测量（log-forensics 解码 8 个存档逐一测量，18:00–18:01）

最短命者 fe57cfa9 存活 50s 并正常 completed；其余 64s–346s+，事件 24–170 条，持续真实工具活动。与基线「17ms 即崩」模式截然不同。详表见 `_t3_dispatch_crash_forensics_20261112/log_evidence.md` §2.3。

### 3.4 崩溃关键词全量扫描（按事件类型分层，防文本回声误判）

主会话 T0 后 68 事件 + 8 个子会话存档全量扫描 `TypeError / Cannot read properties / childId":null / AGENT_RESOLUTION_FAILED / fail-closed / 执行中断`：
- **无任何运行态崩溃事件**；全部命中为任务书/计划正文/deepThink/报告引文的文本回声（逐条鉴别，遵循历史教训「事件类型分层」硬规则）；
- 重启后无 AGENT_RESOLUTION_FAILED fail-closed 触发（未走到「解析不到」的最坏分支）。

### 3.5 如实单列的两类非崩溃异常

1. **EVIDENCE_MISSING**（L846，17:55:51.763）：T1 子会话已运行 80s/55 事件，仅结果块缺失被要求补交，自动重试成功（agent-6 登记）。属结算格式门禁，与派发崩溃不同故障类。
2. **session_event_search 30s 超时**（L821→L825，17:54:28→17:54:58，ToolTimeoutError/TOOL_TIMEOUT）：R3 独立索引路径问题，与派发链路无因果证据，不混入本判定。

## 4 代码侧对照（code-verifier 行级核对 + 负责人抽查复核）

崩溃机制：旧实现把 prompt/parent/cwd 嵌套在 `request:{}`（旧宿主形状），现宿主读 spec 顶层 `spec.parent` 得 undefined；且 exec.agent/payload.agent 可能缺失。宿主 `startActivation` 在 `spec.parent.id` 处毫秒级抛 TypeError，崩溃发生在子会话创建之前 ⇒ childId=null 是症状不是病因。

| 事实 | 位置（负责人已抽查原文） |
|---|---|
| 宿主崩溃点（无空值守卫） | checkout `node_modules/@deepseek-ai/dsh-subagent/src/index.ts:275`：`if (this.ctx.get('agents')?.get(spec.parent.id) !== spec.parent)` |
| 宿主 childId 生成本就空值安全 | `dsh-subagent/src/manager.ts:335`：`spec.childId ?? brandString<SessionId>(randomUUID())` |
| 治本① spec 顶层契约拍平 | 插件 `src/runtime.ts:2163–2169` 注释（负责人已读原文）+ 两处 spawn 同口径（2243、7761–7766） |
| 治本② resolveLiveAgent 兜底 | `src/runtime.ts:1880–1889`（ctx.get('agents') 安全访问器 + try/catch，解析不到返回 null） |
| fail-closed + parent: liveAgent | `src/runtime.ts:2171/2173/2243`（PlanError AGENT_RESOLUTION_FAILED，不创建半个子会话） |
| 自动派发兜底 | `src/runtime.ts:5169` |
| 第三层入口闸 + D1 接续守卫 | `src/runtime.ts:7504–7507`（NO_SESSION）、7403–7417（SELF_EFFORT_CONTINUATION_FAILED） |
| describeError 堆栈截断 | `src/watchdog.ts:64–77`（Error 附 stack 前 6 行 ≤600 字符，注释明示针对 G2 缺口） |

编译产物与生效链路（负责人独立核对）：
- `lib/runtime.js` 含 `resolveLiveAgent`×4、`AGENT_RESOLUTION_FAILED`×1；`lib/watchdog.js` 含 `stack:` 标记；code-verifier 逐句同构核对 lib 行号 1772/2069–2073/2142/4985/7274/7644。
- 接线：`~/.dsh/profiles/web/package.json:18` `"dsh-workplan": "link:/Users/open/Documents/Stocks/plugins/dsh-workplan"` → node_modules 符号链接 → `lib/host.js:14` import `./runtime.js`。
- lib/host.js、lib/runtime.js、lib/watchdog.js mtime 均 **17:46:14**，早于重启 17:50:54 ⇒ 重启进程加载含补丁产物（进程级最终核验由 T1 出具，其进程自报 build 4ba6e9dc9b4161a8 已见 L820）。

诚实边界：派发成功证明「不再崩溃」；成功本身无法区分「agent 直接可用」与「兜底解析成功」分支（两者均不产生日志事件）。重启后无 fail-closed 事件，说明未触发最坏分支。

## 5 剩余风险与建议（供 T4 收尾引用）

1. **R2 判定：闭环（不再崩溃）**——日志侧 + 代码侧 + 负责人独立取证三方一致。
2. 宿主侧 `spec.parent.id` 仍无空值守卫（防线在插件侧）；若未来其他调用方绕过插件直传坏 spec 仍会崩。建议后续在宿主 dsh-subagent 加守卫（超出本任务范围，仅建议）。
3. 插件 package.json 仍 2.5.4，修复以 [2.5.5] 锚点在工作树未发布：**发布前勿从 npm 重装 2.5.4 发布包**，否则回退。
4. EVIDENCE_MISSING 结算门禁与 R3 搜索超时为独立问题，不属派发崩溃，按各自轨道跟踪。
5. 两名下级 dsh_workplan_verify 均返回 NO_PLAN（叶子层无可关联计划登记），三阶段证据已完整写入各自报告；请主 Agent 按 structured 口径复核写回。

## 6 验收对照

- **A1**：结论=**不再崩溃**（三态之一）。原始时间戳与片段：§2 基线（L9–L11、L431–L439）与 §3 正向（L806–L847、L833、心跳行）。pass。
- **A2**：不适用（未再崩溃）。崩溃点与候选缺失字段（exec.agent/payload.agent → spec.parent=undefined）的取值机制已用行级代码证据说明（§4），非猜测。pass（条件未触发，机制取证已附）。
- **A3**：不适用（证据充足）。重启后新回合触发已实际发生：17:53:41 自动派发×3 + 17:54:31/17:54:45 接续×2 + 17:55:51 重试×1 + 第三层派发×2，无需主 Agent 补触发。pass。
- **A4**：未调用 dsh_workplan_dispatch（仅部门内 dsh_workplan_delegate），未重启服务；全程只读，唯一写盘为本报告、下级报告与提取脚本。pass。

## 7 证据索引（可复跑）

- 负责人提取器：`scripts/wp-fix/r2-dispatch-extract.py`（`zstd -dc <主会话日志> | python3 r2-dispatch-extract.py`）
- log-forensics：`_t3_dispatch_crash_forensics_20261112/log_evidence.md`（解码副本 tmp/，行号可复核）
- code-verifier：`_t3_dispatch_crash_forensics_20261112/code_evidence.md`（§七复核命令）
- T3 补丁说明：`plugins/dsh-workplan/reports/T3-patch-resume-1513.md`
