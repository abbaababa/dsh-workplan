# R3 复现与计时实证报告（T1 · 研究分析部门）

- 任务：只读复现 `session_event_search` 30s 超时（R3），采集可复核的复现与计时实证
- 负责人：agent-12（research:T1，分布式系统性能取证）；下级：repro-expert（专家）、source-reader（组员）
- 取证窗口：2026-11-12 20:47–21:05（Asia/Shanghai）；报告版本：最终版（21:05 定稿，结算备份 reports/wp-settlement-T1.json）
- 全程只读：未重启服务、未安装/升级依赖、未调用主计划派发工具、未向任何会话日志写入

## 0. 结论摘要（小白版）

**R3 真实存在，且已稳定复现。** 系统的"历史会话搜索"功能（工具名 `session_event_search`）规定每次搜索最多等 30 秒；在本工作区（约 2092 个历史会话、压缩后共约 767MB）里，**每一次搜索都会把 30 秒用光然后报错**，哪怕你只搜一个很小的范围。今天存档里能找到的 25 次真实搜索调用**全部超时（25/25）**；本轮我们又用历史上触发超时的**原参数**重放 5 次（下级 repro-expert 4 次＋负责人独立交叉 1 次），**全部以同样的 30000ms 超时告终（合计 30/30）**，错误文本与历史逐字一致。搜索本身不写任何数据（有零写入证明）。根因判定交给 T2，本报告只提供可复核的复现事实与源码线索。

## 1. R3 定义与取证范围

- R3 定义（引自 [R1-R3-evidence-audit-checklist.md](../../reports/R1-R3-evidence-audit-checklist.md) L32/L123）：「session_event_search 30s 超时为独立观测（疑似 2016 会话索引慢），与本报错无因果证据，待重启后复测。」
- 备注：「2016」是当时报告里的工作区会话总数假设，**不是会话 ID**；本轮实测为 **2092** 个会话文件（见 §5）。
- 历史观测锚点（任务书给定）：T2 一次、T4 18:22 两次。**存档实测比口头记录更多**：今日共 25 次调用全部超时，其中 T2 系 6 次、T4 系 18:22 共 3 次（§2 有逐条出处）。以存档为准。

## 2. 历史超时实证（第一手存档提取，非转述）

提取方法：对今日有改动的 133 个会话存档（`~/.dsh/sessions/--Users-open-Documents-Stocks--/*/session.v4.jsonl.zstd`）逐个 `zstd -dc` 只读解码，按 `tool/call(name=session_event_search)` 与 `tool/result` 的 `callId` 精确配对，耗时=两事件 `time` 字段差（毫秒）。

- 原始提取：[_r3_repro_forensics_20261112/search-calls-raw.jsonl](<_r3_repro_forensics_20261112/search-calls-raw.jsonl>)（769 条含关键词事件）
- 配对结果：[_r3_repro_forensics_20261112/search-calls-paired.json](<_r3_repro_forensics_20261112/search-calls-paired.json>)（25 条调用，全部 `isError=true`）
- 提取脚本：[_r3_repro_forensics_20261112/extract-search-calls.py](<_r3_repro_forensics_20261112/extract-search-calls.py>)

**25/25 全部超时，逐字错误文本均为：`Error: tool call timed out after 30000ms`**（事件时间差 30000–34845ms，含排队开销）。

关键历史调用（完整 25 条见配对 JSON）：

| 时刻 | 发起会话（前 8 位） | 参数（逐字） | 事件差 | 归属 |
|---|---|---|---|---|
| 17:54:28 | session-6e26e9e5（主） | `{"session_id":"session-1513aa1d-…","query":"session","seq_from":0,"seq_to":16}` | 30005ms | 主会话自查（**范围仅 17 个事件仍超时**） |
| 17:58:54 | 94bdfb13 | `{"session_id":"session-6e26e9e5-…","query":"重启"}` | 30001ms | T2 系 |
| 18:04:59 | 94bdfb13 | 同上＋`time_from/to=17:40–17:56` | 30188ms | T2 系 |
| 18:11:20 | c17d075f | `{"session_id":"session-6e26e9e5-…","query":"1513","time_from":"2026-11-12T17:50:00+08:00"}` | 30022ms | T2 系（decode-auditor/log-scan 关键词佐证） |
| 18:22:01 | adc8dfbc | `{"session_id":"e6374f66-…","query":"R1"}` | 30168ms | T4 系 |
| 18:22:27 | d9fcd0d8 | `{"session_id":"session-6e26e9e5-…","query":"R1","seq_from":1}` | 30005ms | T4 系（evidence-auditor 关键词佐证） |
| 18:22:31 | adc8dfbc | `{"session_id":"session-6e26e9e5-…","query":"任务分解"}` | 30000ms | T4 系 |

归属依据：子会话存档内角色关键词计数（如 d9fcd0d8 含 evidence-auditor×112；c17d075f 含 decode-auditor×113/log-scan×125）＋查询目标指向。
**重要现象：超时与查询范围无关**——17 个事件的小范围、单会话、全工作区三种口径都超时；今日无一成功。

## 3. 本轮重放实测（同一历史原参数，只读）

### 3.1 负责人独立交叉重放（第一手，已完成）

- 参数 P1（=18:22:27 历史原参数）：`{"session_id":"session-6e26e9e5-1d95-4d47-b59d-4d75b838cae7","query":"R1","seq_from":1}`
- 墙钟括号：start=1794488251609（20:57:31）→ end=1794488298232（含步骤开销）
- **精确事件计时：本会话 8011099b-b5a8-4dfe-9937-b2af1ebccada 的 tool/call seq=310 → tool/result seq=311，差=30000ms**
- 状态：超时；逐字返回：`Error: tool call timed out after 30000ms`
- 证据：[lead-crosscheck-replay.txt](<_r3_repro_forensics_20261112/lead-crosscheck-replay.txt>)、[lead-crosscheck-event-timing.json](<_r3_repro_forensics_20261112/lead-crosscheck-event-timing.json>)

### 3.2 下级 repro-expert 受控重放（P1×3＋P3×1，已完成并经负责人独立复核）

下级报告：[repro-timing.md](<_r3_repro_forensics_20261112/repro-timing.md>)（执行于 20:53–20:57，会话 73927dff-11bb-4655-b99f-259c6e87a9e7）。计时用 python3 毫秒三段式（BSD date `%N` 不可用已实测：`date +%s%3N` 输出 `17944879863N`，负责人批准偏离）。

| 运行 | 参数 | 起始戳(ms) | 结束戳(ms) | 墙钟差(ms)* | 状态 | 逐字返回 |
|---|---|---|---|---|---|---|
| 1 | P1 | 1794488026318 | 1794488074486 | 48168 | 超时 | `Error: tool call timed out after 30000ms` |
| 2 | P1（与运行1完全相同） | 1794488074503 | 1794488118699 | 44196 | 超时 | 同上 |
| 3 | P1（与运行1完全相同） | 1794488118719 | 1794488163754 | 45035 | 超时 | 同上 |
| 4 | P3 小范围对照 | 1794488163771 | 1794488213997 | 50226 | 超时 | 同上 |

\* 墙钟差含前后 agent 步骤开销，故 ≥30000ms；**权威精确计时以存档事件对时间差为准**（下表，负责人第一手提取，不采信自述）。

**负责人独立复核（从下级会话存档 tool/call→tool/result 事件对提取）：**

| 运行 | call seq→result seq | 精确事件差(ms) | 参数核对 | 逐字错误 |
|---|---|---|---|---|
| 1 | 78→79 | **30001** | P1 三字段逐字一致 | 一致 |
| 2 | 90→91 | **30006** | P1 一致 | 一致 |
| 3 | 102→103 | **30003** | P1 一致 | 一致 |
| 4 | 114→115 | **30008** | P3 四字段逐字一致 | 一致 |

证据：[repro-expert-event-timing.json](<_r3_repro_forensics_20261112/repro-expert-event-timing.json>)。**4/4 超时，0 次成功，未中止任何预定次数。**

### 3.3 重放汇总与引用更正

- 本轮新鲜重放共 **5 次**（P1×4：下级 3＋负责人 1；P3×1），**5/5 超时**，精确事件差 30000–30008ms；加上历史 25 次，今日累计 **30/30 超时**。
- **引用更正（如实记录）**：负责人给下级的确认消息中 P1 历史 epoch 误写为 1794481347041，存档原文实为 **1794478947041**（=18:22:27.041，差 40 分钟）。下级执行前独立核验发现该笔误，墙钟时刻与 args 逐字吻合，按存档原文执行。负责人已复核存档确认笔误属实，参数效力不受影响（repro-timing.md §1 有完整记录）。

## 4. 稳定复现条件（A2）

满足以下条件时**稳定复现**（历史 25/25＋本轮重放全部命中）：
1. 工作区会话规模：本工作区 2092 个会话文件、压缩总量 766,764,755 B（§5）；
2. 工具：`session_event_search`（任意 query；带或不带 session_id/seq/时间过滤均可，范围大小不影响结果）；
3. 超时阈值：工具自带 30000ms（源码 `DEFAULT_SEARCH_TIMEOUT_MS = 30_000`，§6）；
4. 进程环境：当前 pid 59827（20:39:26 启动）与历史 pid 20983（17:50:54 启动）**两个进程下均复现**，说明不依赖特定进程状态；
5. 并发：无特殊并发要求，单次调用即超时。
**不可复现的边界（如实披露）**：未在小规模工作区验证（无此环境）；"规模多大才会超时"的阈值曲线未测（超出 T1 范围，供 T2/T3 参考）。

## 5. 数据规模基线（实测，供后续量变对照）

| 会话 | 压缩字节 | 解压字节 | 行数 | 事件 seq | 状态 |
|---|---|---|---|---|---|
| session-6e26e9e5（主，重放目标） | 1,360,123（20:50 时点） | 5,074,472 | 1062 | 0–1060 | 活跃追加 |
| session-1513aa1d（对照） | 632,447 | 2,551,779 | 477 | 0–475 | 17:51:12 起静止 |
| session-6059f01b（大会话样例） | 1,843,163 | 6,317,100 | 1746 | 0–1744 | 活跃 |
| **工作区合计** | **766,764,755**（2092 个文件） | 未全量解压（按主会话压缩比≈3.7 估算约 2.8GB，**估算值非实测**） | — | — | — |

证据：[scale-baseline.json](<_r3_repro_forensics_20261112/scale-baseline.json>)（20:50 实测）。

## 6. 实现与索引相关文件真实路径（A3，全部实测存在）

运行时 checkout：`/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai/`（R2 已证运行时加载该 checkout，见 R2-build-live-check.md）。启用证据：`~/.dsh/profiles/web/package.json:35` bundles 含 `@deepseek-ai/dsh-experimental-session-search`。

| 文件（相对 checkout） | 作用 | 关键行 |
|---|---|---|
| `dsh-experimental-session-search/cordis.patch.yml` | 组合入口：sqlite 索引(`:memory:`, openAt=first-search)＋查询工具 | 全文 12 行 |
| `dsh-tool-session-query/src/index.ts` | 工具定义 | :25 `DEFAULT_SEARCH_TIMEOUT_MS = 30_000`；:76 `session_event_search`；:70/:80 timeoutMs 接线 |
| `dsh-tool-call-timeout-policy/src/index.ts` | 30s 超时执行器 | :42 错误模板 `tool call timed out after ${timeoutMs}ms`（与逐字错误一致）；:61 deadline |
| `dsh-session-query-sqlite/src/index.ts`（1131 行） | 内存 SQLite 索引 | :296–325 searchEvents 先 `_reconcile` 后范围查询；:407–493 全量对账；:495–562 全库观察＋冷读；:86 重试上限=2 |
| `dsh-session-query-sqlite/src/query.ts` / `schema.ts` | SQL 查询/表结构 | 477/173 行 |
| `dsh-session-query/src/cold-read.ts` / `corpus.ts` | 冷读会话日志/会话清单 | readColdSessionLog :31；listSessions :62 |

负责人交叉核对笔记（含逐条存在性检查输出）：[source-crosscheck.md](<_r3_repro_forensics_20261112/source-crosscheck.md>)。

**下级 source-reader 独立源码佐证（已完成，负责人抽查复核通过）**：[t1-source-evidence.md](../../reports/t1-source-evidence.md)（360 行，reports/ 目录）。要点：
- 版本锚点：涉事 8 个包均为 **0.2.2-rc.2**（各自 package.json 实测）；运行锚点 `DSH_PROFILE=web`、`DSH_INSTALL_DIR=…/f0e663d3a92a984e/node_modules/@deepseek-ai/dsh`（环境变量实测）。
- 注册入口 `dsh-tool-session-query/src/index.ts:75–83`，handler `src/operations.ts:117–163`，编译对应 `lib/index.js:964/968`；30000 常量 `src/index.ts:25`、编译 `lib/index.js:932`（3e4）。
- 超时执行链：`dsh-tool-call-timeout-policy`（:57/:61/:73–74/:41–48）＋ `dsh-timeout` deadline；合作式超时，错误码 TOOL_TIMEOUT。
- **干扰项排除（负责人已抽查原文复核）**：所有 `searchTimeoutMs: 60000` 均属 `tool-web`（web_search），如 `dsh-base/cordis.patch.yml:505`（负责人 sed 逐字核对一致，含 :479–480 注释「provider-neutral tool default remains 30s」）；web profile 补丁无任何 session-query 覆盖 → 生效值=30000ms。

**机制线索（供 T2，非 T1 结论）**：每次搜索先对**全部**会话做观察/冷读对账（`_reconcile`），之后才执行范围化 SQL；新进程内存索引为空需冷读全库；活跃会话追加会使快照稳定性检查失败并整轮重试（上限 2 次）；超时中止后索引未落库，下次搜索重复同样开销——与"小范围也超时、25/25 全超时"现象一致。

## 7. 零写入证明（A4）

- PRE 快照（20:48:36）：[snapshot-pre.txt](<_r3_repro_forensics_20261112/snapshot-pre.txt>)
- MID 快照（20:59:24）＋解码副本：[snapshot-mid.txt](<_r3_repro_forensics_20261112/snapshot-mid.txt>)、parent-mid.jsonl（1075 行）、s1513-mid.jsonl（477 行）
- POST 快照（21:02:41）：[snapshot-post.txt](<_r3_repro_forensics_20261112/snapshot-post.txt>)、parent-post.jsonl（1081 行）、s1513-post.jsonl（477 行）

**结果（全部实测）：**
1. **静止对照会话 1513（P3 重放的被检索目标）**：PRE/MID/POST 三点 size=632447、mtime=17:51:12（epoch 1794477072）完全一致；sha256 三点一致=`293cbc877f82c9454fdedfcf0445052aaabc3a53c691f8f0cbe490237b33a250`；MID/POST 解码副本 `cmp` 逐字节一致（exit 0）。**严格满足 A4：被检索会话日志取证前后零变化。**
2. **活跃主会话（P1 被检索目标）口径披露**：size 1351396(PRE)→1371396(MID)→1386576(POST)，mtime 随宿主追加更新。这**不是取证写入**——本取证对话树自身运行时宿主就在向该会话追加事件。验证：POST 解码与 MID 解码逐行比对，**前 1075 行逐字节一致（prefix_identical=True）**，新增仅 6 行且全部为 `user/message`（宿主正常投递的消息事件，无任何注入/篡改）。另源码证明冷读 non-mutating（dsh-session-query-sqlite/src/index.ts:515–517 注释「The cold read is non-mutating」）。
3. 下级 repro-expert 独立 PRE/POST（20:53:06/20:56:53）同样证明 1513 逐字节不变（repro-timing.md §7），与负责人三点快照互证。

## 8. 合规声明（A5）

未重启服务（当前 pid 59827 为 20:39:26 用户侧既有重启，非本任务所为，见 [env-facts.txt](<_r3_repro_forensics_20261112/env-facts.txt>)）；未安装/升级依赖；未调用主计划派发工具（仅用部门内 delegate）；对 ~/.dsh 只读；写入仅限工作区报告与本证据目录。

## 9. 证据索引

[_r3_repro_forensics_20261112/](<_r3_repro_forensics_20261112/>) 目录（负责人）：
- extract-search-calls.py（提取脚本）、search-calls-raw.jsonl（769 条原始命中）、search-calls-paired.json（25 条历史调用配对）
- scale-baseline.json（规模基线）、snapshot-pre/mid/post.txt（三点快照）、parent-mid/post.jsonl、s1513-mid/post.jsonl（零写入比对副本）
- env-facts.txt（进程事实）、source-crosscheck.md（源码交叉核对）
- lead-crosscheck-replay.txt、lead-crosscheck-event-timing.json（负责人独立重放）
- repro-timing.md（下级主产物）、repro-expert-event-timing.json（负责人对下级 4 次重放的独立事件计时复核）

reports/ 目录（下级与结算）：t1-source-evidence.md（source-reader 主产物）、wp-member-repro-expert-T1.json、wp-member-source-reader-T1.json（下级结算）、wp-settlement-T1.json（本任务结算备份）。

## 10. 验收对照（逐条）

- **A1** ≥3 次同参数重放逐次耗时/状态/逐字错误：**pass** — §3：P1 同参 4 次（下级 3＋负责人 1）＋P3 对照 1 次，共 5 次；逐次墙钟戳与精确事件差（30000–30008ms）、状态（全超时）、逐字错误文本齐全。
- **A2** 稳定复现条件：**pass** — §4：规模/工具/阈值/进程四条件明确，历史 25/25＋本轮 5/5；两个不同进程下均复现；未测边界如实披露。
- **A3** 实现与索引文件真实路径：**pass** — §6：9 个文件存在性实测（wc -l 输出在 source-crosscheck.md），行号经负责人与下级双份独立核对；版本 0.2.2-rc.2。
- **A4** 会话日志零写入：**pass** — §7：被检索静止会话 1513 三点 size/mtime/sha256 严格一致＋cmp 逐字节；活跃主会话以前缀逐行比对＋新增事件类型枚举证明仅宿主正常追加；口径差异如实披露。
- **A5** 未重启/未安装/未调用主派发：**pass** — §8：当前 pid 59827 为 20:39:26 既有重启（libproc 实测，非本任务所为）；全程仅部门内 delegate；~/.dsh 只读。

## 11. 移交 T2 的要点

1. 复现参数与规模基线齐备（§2/§3/§5），可直接做根因实验对照。
2. 源码线索（§6 机制推论）：每次搜索先全库 `_reconcile`（观察＋冷读）后范围查询；新进程索引为空；活跃追加触发稳定性重试（上限 2）；超时后索引未落库导致每次重复全量开销——与「范围无关、30/30 全超时」现象吻合，请 T2 以实验证实或证伪。
3. 修复约束提醒：R1/R2 已闭环，任何补丁不得触碰派发/读取路径；30000ms 为工具默认常量（可配置项 searchTimeoutMs），改阈值只是缓解不是治本。