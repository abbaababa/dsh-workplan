# R1–R3 证据核对清单（只读审计 · 主产物）

- 审计人：质量验证部门 · evidence-auditor（第三层专家叶子，agent-10/agent-3）
- 上级任务：T4 出具重启后收尾结论与 R1–R3 闭环表（部门负责人 agent-10）
- 审计时间：2026-11-12 18:21–18:35（Asia/Shanghai，本机时钟）
- 审计方式：**全程只读**（read / glob / grep / stat / shasum / zstd -dc 解码副本 / python 单遍校验）。未修复、未重启、未写任何会话数据；唯一写盘为本清单与结算 JSON。
- 计划：wp-46f8cbde-ac51-454f-aa84-e06809089b4a（执行行 T1/T2/T3）；R1–R3 定义源自 T5 验收报告 §5。

---

## 0. 一句话结论（不懂电脑也能看懂）

把这次修复想象成「修好一本读不出来的日记本」：
- **R1（日记本能不能完整读出来）**：服务器侧已经证明**能完整读出来**，证据很硬；但「用户亲眼在界面上看到正常」这条**原始记录没拿到**，只能算「服务器单边证实」，不能宣称「端到端亲眼验证通过」。
- **R2（分派任务会不会一启动就闪退）**：**已修好，不再闪退**，日志、代码、独立取证三方一致。
- **R3（搜索历史工具卡 30 秒）**：**重启后仍然卡**，它是另一条独立毛病，和「日记本读不出来」没有因果关系，需要另开任务处理。

**总体：R2 闭环；R1 服务端闭环、GUI 原始交叉证据缺口如实登记；R3 未闭环（独立问题）。**

> ⚠️ 审计发现一处需更正的表述：主 Agent 在收尾发言中称「收到您的确认：重启后 1513 会话已能正常加载历史」。但全程会话记录里，用户真正的原始输入只有两条——原始任务（16:48）与「**已重启 继续**」（17:51:48）。**没有任何用户原话说过「界面正常加载」**。该表述把「已重启」过度解读成了「GUI 正常加载」，应更正为「用户已确认重启 ＋ 服务端实证读取成功」。详见 R1 §缺口。

---

## 1. 核对基准（R1–R3 权威定义）

定义来源：`plugins/dsh-workplan/reports/T5-acceptance-resume-1513.md` §5（L36–L38），逐字摘录：

| 编号 | 定义原文 | 对应执行行 | 执行行产物 |
|---|---|---|---|
| R1 | 「端到端重启确认未执行（需用户动作）；离线证据已覆盖读取链路同一校验函数。」 | T1（制品生效）＋ T2（读取实证） | R2-build-live-check.md ＋ R2-resume-1513-live.md |
| R2 | 「T6 的 agent 缺失假设待重启实证；fail-closed+兜底+堆栈留痕已就位，最坏情况明确报错而非裸 TypeError。」 | T3（派发实证） | R2-dispatch-live-proof.md |
| R3 | 「session_event_search 30s 超时为独立观测（疑似 2016 会话索引慢），与本报错无因果证据，待重启后复测。」 | T2 §5/§7 ＋ T3 §3.5（独立观测） | 主会话超时事件 ＋ 两份报告单列 |

> 口径说明（偏离记录）：本叶子会话经 `dsh_workplan_status` 查询返回「当前会话没有可查看的计划」（叶子层无可关联计划登记，与 T3 §5.5 所述 NO_PLAN 同源）。故 R1–R3 定义改从**权威 T5 报告 §5 ＋ 父/根会话日志只读解码**取得，未预设结论；此为取证路径偏离，已如实记录，不影响核对基准的权威性。

---

## 2. 逐项核对

### R1 — 端到端重启确认 / 读取链路

**定义**：端到端重启确认未执行（需用户动作）；离线证据已覆盖读取链路同一校验函数。

**证据路径与存在性**（全部 EXIST）：

| 证据 | 路径 | 存在 | 字节 |
|---|---|---|---|
| T1 制品生效报告 | plugins/dsh-workplan/reports/R2-build-live-check.md | ✅ | 7715 |
| T2 读取实证报告 | plugins/dsh-workplan/reports/R2-resume-1513-live.md | ✅ | 8855 |
| T2 解码审计日志 | scripts/wp-fix/r2-t2-decode-audit.log | ✅ | 1361 |
| T2 新鲜解码件 | scripts/wp-fix/r2-t2-verify-decode.jsonl | ✅ | 2551779 |
| T2 日志检索 | scripts/wp-fix/r2-t2-log-scan.md | ✅ | 7521 |
| T2 负责人笔记 | scripts/wp-fix/r2-t2-lead-notes.md | ✅ | 6136 |
| 1513 live 压缩件 | ~/.dsh/sessions/--Users-open-Documents-Stocks--/session-1513aa1d-…/session.v4.jsonl.zstd | ✅ | 632447 |

**覆盖判定：pass（服务端读取链路闭环）＋ GUI 端到端原始交叉证据＝缺证据（如实登记）**

逐条复核（审计人独立重跑，非采信自述）：

1. **制品生效（T1）pass** — 审计人复算 6 个运行加载文件 sha256，与 T1 §2 冻结值**逐一完全一致**：
   - lib/host.js `75203369…e8b13`、lib/runtime.js `28c369e2…3a1c8`、lib/plan.js `afb9da5f…6cb35`、lib/watchdog.js `0a8ff8bc…c089f`、v3-to-v4/lib/index.js `bdcb11b6…101698`、v2-to-v3/lib/index.js `426afde7…cb8ccc`。
   - 补丁特征在运行加载文件命中：`preHeadWindowSessions/enterPreHeadWindow`×5（lib/plan.js）、读取端 `legacy tolerance: adopt late system head`×1（两格式包各 1）、旧抛错串 `requires a protected first surface head`×**0**（两格式包均 0，旧拒绝逻辑已替换）。
2. **服务端读取成功（T2）pass** — 审计人独立解码 1513 live 件复核：
   - 末事件原文：`{"type":"session/end-seed","seq":475,"time":1794477072020,…}`，time=**17:51:12.020**，恰在重启（17:50:54）后 18 秒；live 件 mtime=17:51:12 与之精确吻合 → **只有读取成功才会发生 re-seed**，这是读取成功的直接运行态证据。
   - 解码行数 **477 = 476 事件（seq 0–475 连续）＋ 1 头行**；审计日志 `parse_errors=0 / seq_gaps=0 / seq_continuous_from_0=True / cmp_exit=0`（前 476 行与重启前基线逐字节一致）；`appended_count=1`（仅 end-seed，正常生命周期标记，非损坏）。
   - 报错检索：T2 §4 五关键词（protected first surface head / SessionFormatError / corrupt / 历史加载失败 / 受保护头）×三范围 **total_matches=0**；审计人复核主会话 post-restart 唯一 isError 为 R3 超时，无读取报错。
3. **用户重启动作 pass** — 根会话 L800（seq798，17:51:48）用户原话「**已重启 继续**」，source.kind=user，证实用户已手工重启。

**缺口（缺证据，如实登记，不宣称端到端通过）**：
- R1 定义要求「端到端重启确认」。重启已完成、服务端读取已实证成功，但**「用户亲眼在 GUI 看到 1513 正常加载」的原始记录不存在**。
- 审计人穷举根会话全部真实人类输入（source.kind=user），全程仅两条：L6（16:48:03）原始任务、L800（17:51:48）「已重启 继续」。**无任何用户原话确认「界面正常加载」**。
- T2 §5 已诚实标注「服务端单侧证据 ＋ GUI 缺口，不宣称端到端通过」，并曾向主 Agent 索取 GUI 观察要点（18:12 投递，截至 18:16 未获回复）；索取用的 `session_event_search` 本身 30s 超时（即 R3），无法从事件流核实原始 GUI 观察。
- **需更正表述**：主 Agent seq862（17:56:48）「收到您的确认：重启后 1513 会话已能正常加载历史——核心问题端到端解决」缺乏可引用用户原话依据，属对「已重启 继续」的过度解读。建议 T4 收尾更正为「用户已确认重启 ＋ 服务端实证读取成功；GUI 原始观察记录缺口如实登记」。

**引用摘录**：
- T5 §5 L36：「R1：端到端重启确认未执行（需用户动作）；离线证据已覆盖读取链路同一校验函数。」
- T2 §0：「判定：读取正常（服务端实证 PASS）……『用户亲眼在界面上看到正常』这一条交叉证据本轮没有拿到原始记录……不宣称端到端通过。」
- 根会话 L800 用户原话：「已重启 继续」。
- 1513 live 末事件：`session/end-seed seq475 time=1794477072020`（17:51:12）。

---

### R2 — T6 agent 缺失假设 / 派发不再崩溃

**定义**：T6 的 agent 缺失假设待重启实证；fail-closed+兜底+堆栈留痕已就位，最坏情况明确报错而非裸 TypeError。

**证据路径与存在性**（全部 EXIST）：

| 证据 | 路径 | 存在 | 字节 |
|---|---|---|---|
| T3 派发实证报告 | plugins/dsh-workplan/reports/R2-dispatch-live-proof.md | ✅ | 10524 |
| 日志取证 | _t3_dispatch_crash_forensics_20261112/log_evidence.md | ✅ | 10951 |
| 代码取证 | _t3_dispatch_crash_forensics_20261112/code_evidence.md | ✅ | 12117 |
| 提取器 | scripts/wp-fix/r2-dispatch-extract.py | ✅ | 1868 |
| 全量测试日志 | scripts/wp-fix/full-suite-r4.log | ✅ | 208147 |
| 对照回归日志 | scripts/wp-fix/regression-r4.log | ✅ | 641 |

**覆盖判定：pass（闭环：不再崩溃；日志＋代码＋独立取证三方一致）**

逐条复核（审计人独立重跑）：

1. **重启前基线崩溃（对照）pass** — 根会话 L11（seq9，16:49:51）原文：`"childId":null,"startedAt":1794473391356,"finishedAt":1794473391373,"error":"Cannot read properties of undefined (reading 'id')"` → **17ms 即崩、childId=null、裸 TypeError**，与 T3 §2 逐字一致。
2. **重启后不再崩溃 pass** — 审计人独立扫描根会话 T0（17:50:54）后：
   - `subagent/catalog` 登记 **10 次，childId 全部非空**（fe57cfa9 / f3251269 / c7563f07 / 33dab0e6 / 79f1a172 / 9ae362c5 / c17d075f / 379d1b56 / 03f95cba / e6374f66；T3 报告时点为 6 次，其后又增 4 次，含本审计父会话 agent-10=e6374f66，18:20:33 非空启动）。
   - post-T0 `isError` 工具结果**仅 1 条＝R3 超时**（L825，17:54:58），**无任何 TypeError / childId:null / AGENT_RESOLUTION_FAILED 崩溃事件**。
   - post-T0「执行中断」崩溃通知 **0 条**。
3. **代码侧治本就位 pass** — 审计人在运行加载 lib 复核：`resolveLiveAgent`×4、`AGENT_RESOLUTION_FAILED`×1（lib/runtime.js）、`stack:`×1（lib/watchdog.js）；sha256 与 T1 一致（见 R1）；全量 `full-suite-r4.log` 末行 `[run-tests] pass=866 fail=0 cancelled=0 exit=0 / EXIT=0`；`regression-r4.log` 末行 `ALL PASS`（含修复前缺陷复现对照与负向保护用例）。

**诚实边界（如实保留，不夸大）**：
- 重启后**无 fail-closed（AGENT_RESOLUTION_FAILED）事件**，说明未走到「解析不到 agent」的最坏分支；派发成功本身**无法区分「agent 直接可用」与「兜底解析成功」两分支**（两者均不产生日志事件）。故「agent 缺失假设」本身未被直接触发实证，但**崩溃已消除**这一结论证据充足。与 T3 §4 诚实边界、§5.1「R2 判定：闭环（不再崩溃）」一致。
- 残留建议（非本审计范围）：宿主 `dsh-subagent` 的 `spec.parent.id` 仍无空值守卫，防线在插件侧；插件 package.json 仍 2.5.4，修复以 [2.5.5] 锚点在工作树未发布，发布前勿从 npm 重装 2.5.4 以免回退。

**引用摘录**：
- T5 §5 L37：「R2：T6 的 agent 缺失假设待重启实证；fail-closed+兜底+堆栈留痕已就位……」
- T3 §0：「不再崩溃……新回合自动派发 6 次子会话登记 childId 全部非空……重启前『17–43ms 即崩、childId=null、TypeError reading 'id'』的基线模式未再复现。」
- T3 §5.1：「R2 判定：闭环（不再崩溃）——日志侧＋代码侧＋负责人独立取证三方一致。」
- 基线 L11：`childId:null … finishedAt-startedAt=17ms … reading 'id'`。

---

### R3 — session_event_search 30s 超时（独立观测）

**定义**：session_event_search 30s 超时为独立观测（疑似 2016 会话索引慢），与本报错无因果证据，待重启后复测。

**证据路径与存在性**（全部 EXIST）：

| 证据 | 路径/位置 | 存在 |
|---|---|---|
| 重启后超时事件 | 根会话 L825（seq823，17:54:58）tool/result isError | ✅ |
| T2 单列 | plugins/dsh-workplan/reports/R2-resume-1513-live.md §5/§7 | ✅ |
| T3 单列 | plugins/dsh-workplan/reports/R2-dispatch-live-proof.md §3.5 | ✅ |
| 审计人新鲜复测 | 本审计 session_event_search（root，query=R1）返回 timed out after 30000ms | ✅（本审计实测） |

**覆盖判定：未闭环（独立未决项）— 重启后复测仍 30s 超时；与读取报错无因果证据**

逐条复核：
1. **重启后复测已执行且仍超时** — 根会话 post-T0 唯一 isError 即 L825（17:54:58）`Error: tool call timed out after 30000ms`（T3 §3.5 引 L821→L825，17:54:28→17:54:58）；T2 §5 记录 18:16 对父会话 query=1513 仍超时；**审计人本次独立调用 session_event_search 亦 30s 超时**（新鲜第三方复测）。三方一致：R3 重启后依旧存在。
2. **独立性 pass** — 读取链路（R1）经格式包校验函数成功，派发链路（R2）正常；R3 属会话**索引/查询**路径，与「受保护头读取报错」无已证实因果关联。T2 §7、T3 §3.5 均单列不混入各自判定。
3. **结论** — R3 **不是本次修复的回归**，而是独立未决问题；定义中「待重启后复测」已完成，复测结果＝仍超时。需另开任务跟踪（主 Agent 已表示收尾时请用户决定是否另开任务）。

**引用摘录**：
- T5 §5 L38：「R3：session_event_search 30s 超时为独立观测……与本报错无因果证据，待重启后复测。」
- 根会话 L825：`Error: tool call timed out after 30000ms`（isError=true，17:54:58）。
- T2 §7：「R3：session_event_search 对 1513/父会话仍 30s 超时，属会话索引路径……独立未决项，另行跟踪。」

---

## 3. 汇总表（供 T4 闭环表直接引用）

| 项 | 定义要点 | 证据存在 | 覆盖判定 | 关键证据 | 残留 |
|---|---|---|---|---|---|
| **R1** | 端到端重启确认；离线已覆盖读取链路 | ✅ 全在 | **pass（服务端）＋ GUI 原始交叉证据缺证据** | end-seed seq475@17:51:12；解码 477=476+1、0 错 0 缺口、cmp_exit=0；sha256 六件全一致；用户「已重启 继续」 | GUI 原始观察记录缺失；主 Agent「用户确认正常加载」表述需更正 |
| **R2** | agent 缺失假设待实证；兜底/fail-closed/堆栈就位 | ✅ 全在 | **pass（闭环：不再崩溃）** | 基线 17ms childId=null → 重启后 10 次 childId 全非空、0 崩溃；resolveLiveAgent×4/fail-closed×1/stack×1；866/0 | 最坏分支未触发，假设本身未直接实证（崩溃已消除）；宿主守卫/发布锚点为后续建议 |
| **R3** | 搜索 30s 超时独立观测，待重启复测 | ✅ 全在 | **未闭环（独立未决）** | L825@17:54:58 ＋ T2@18:16 ＋ 审计人新鲜复测均 30s 超时 | 重启后仍超时；与读取报错无因果；需另开任务 |

**审计总判定**：R2 闭环；R1 服务端读取链路闭环、GUI 端到端原始交叉证据缺口如实登记（不宣称端到端通过）；R3 未闭环（独立问题，非本次修复回归）。全部 15 个被引用证据文件真实存在，关键锚点经审计人独立重跑复核，无伪造、无修复动作。

---

## 4. 只读承诺与偏离记录

- **只读承诺**：未对任何会话日志/运行制品执行写入、删除、覆盖；解码输出仅落 workspace（本清单与结算 JSON）；1513 live 件 size=632447 / mtime=17:51:12 审计前后未变。
- **偏离 1（取证路径）**：`dsh_workplan_status` 在叶子会话返回 NO_PLAN，定义改从 T5 §5＋父/根会话日志只读解码取得（权威同源，未预设结论）。
- **偏离 2（沙箱）**：/bin/ps 被拒（历史教训：一次即停），进程事实改用 T1 已冻结的 libproc 证据＋审计人 sha256/特征复核佐证，未重复试错。
- **未采信自述**：所有关键锚点（sha256、补丁特征、解码完整性、派发 childId、超时事件、用户原话）均由审计人独立重跑/重新解码复核，而非直接采信下级报告结论。