# R2 · T2 会话 1513 重启后读取实证记录（最终整合版）

- 子任务：T2（质量验证部门）｜计划：wp-46f8cbde-ac51-454f-aa84-e06809089b4a
- 取证对象：`session-1513aa1d-ea9d-463c-9273-ee9a253e40cb`
- 整合时间：2026-11-12 18:16（Asia/Shanghai），宿主重启（17:50:54，pid 20983）之后
- 取证方式：**全程只读会话数据**；解码输出仅落 workspace（`scripts/wp-fix/`）
- 本报告为规定路径最终版；早期草稿 `scripts/wp-fix/R2-resume-1513-live.md`（agent-2 轮）与负责人笔记 `scripts/wp-fix/r2-t2-lead-notes.md` 保留可追溯，不覆盖。

---

## 0. 一句话结论（不懂电脑也能看懂）

**重启之后，1513 这本「会话日记」已经能完整读出来，那个「受保护头」报错没有再出现。判定：读取正常（服务端实证 PASS）。** 但「用户亲眼在界面上看到正常」这一条交叉证据本轮没有拿到原始记录，我们如实标注为缺口，**不宣称端到端通过**——端到端收尾由主 Agent/T4 结合 GUI 观察闭环。

---

## 1. 单一判定（A2）

**读取正常（PASS，服务端单侧实证）。** 无「仍报错」情形，故无逐字报错文本可附；检索到的报错关键词命中数为 0（见 §4）。

判定依据（三条独立证据链，全部指向同一结论）：
1. **运行实例成功读取并重新加载了该会话**：live 文件在重启后 18 秒（17:51:12）被追加 `session/end-seed seq475` 生命周期标记，追加时间与 live 文件 mtime 精确吻合——只有读取成功才会发生 re-seed。
2. **独立新鲜解码完整无损**：zstd exit=0；477 行 = 476 事件（seq 0–475 连续）+ 1 头行；0 解析错误、0 页码缺口；头行完好；前 476 行与重启前基线**逐字节一致**（cmp exit=0）。
3. **运行制品已生效**（T1 done/structured + 本负责人锚点互证）：pid 20983 启动 17:50:54 晚于全部 r4 产物；运行加载的 `dsh-session-format-v3-to-v4/lib/index.js:599` 与 `v2-to-v3/lib/index.js:432` 均命中 legacy 宽容补丁特征；旧抛错串 `requires a protected first surface head` 在 @deepseek-ai 全部格式包 index.js 中 **0 命中**。

## 2. 条数与关键字段核对（A1 · 数据侧）

| 项 | 基线（重启前快照 16:58:53） | live（重启后，18:14 新鲜解码） | 核对结果 |
|---|---|---|---|
| 行数 | 476（475 事件 + 1 头行） | 477（476 事件 + 1 头行） | 前 476 行逐字节一致（cmp_exit=0） |
| 头行 | type=session, version=4, id=1513aa1d… | 同左，合法 JSON | 完好 |
| seq 连续性 | 0–474 | 0–475 连续，0 缺口 | 通过 |
| JSON 解析错误 | 0 | 0 | 通过 |
| 原始末事件 | line476 = turn/end seq474, data.reason.kind=completed（16:26:42） | 保留在 line476 | 通过 |
| 重启后追加 | — | line477 = session/end-seed seq475（17:51:12） | 正常 resume 生命周期标记，非损坏 |
| sha256 | `15c718e963d4ab4c6f1ae7135fe0157ec0ffb94488e3dc74ac9109b850f05a6e` | 解码件 `912b71be979afd30261aa35cf015034ff83f64e7930e1e4ebc11a699b46d6fce`；live 压缩件 `293cbc87…`（笔记 §2） | 基线指纹两轮一致 |

**口径澄清**：任务书「476 行（475 事件+1 头行）」指重启前存储基线；live 多出的 1 行是重启后正常追加的 end-seed，原始 475 事件一页不少，与 r4 回归口径完全自洽。

**三重执行、互不采信自述**：
- decode-auditor（expert 叶子）18:14:49 新鲜解码审计 → `scripts/wp-fix/r2-t2-decode-audit.log`（zstd_exit=0 / 477 行 / parse_errors=0 / seq_gaps=0 / cmp_exit=0 / appended=1 条 end-seed）。
- 负责人 18:16 **独立重跑**核对：`wc -l`=477/476；`head -n476 | cmp`=CMP_OK；python 单遍校验 header_ok、events=476、parse_errors=0、seq_ok=True、末事件 session/end-seed seq475；sha256 复算与笔记一致。
- 解码件 `scripts/wp-fix/r2-t2-verify-decode.jsonl`（2551779 B）在盘可直接复核。

## 3. 运行事实与时间线

```
15:44:24  session createdAt
16:26:42  turn/end seq474 reason=completed（原始对话结束）
16:58:53  基线快照 target-session.jsonl（476 行）
17:50:54  宿主重启（pid 20983；T1 判定补丁产物 ACTIVE）
17:51:12  session/end-seed seq475 追加 ＝ live mtime（读取成功 re-seed 的直接证据）
18:14:49  decode-auditor 新鲜解码审计完成
18:16:43  负责人独立复核完成；live 文件 size=632447 / mtime=17:51:12 未变
```
lsof（log-scan 实测，exit=0）：pid 20983 以写方式打开的常规文件全部为 sessions/*/session.lock（12 个），**含 1513 的 session.lock** → 重启后宿主确实持有并加载该会话。

## 4. 重启后报错检索（A1 · 日志侧）

log-scan（member 叶子）18:13–18:16 执行，全文见 `scripts/wp-fix/r2-t2-log-scan.md`：
- 范围 1：`~/.dsh/logs` 全部 24 个 startup 日志（最新 2026-11-01 17:06，重启后无新增）。
- 范围 2：`find ~/.dsh -name '*.log' -newer <17:50:54 参照>` = **空集（0 个文件）**。
- 范围 3：workspace 22 个 .log（mtime 均早于重启，属重启前产物，如实注明）。
- 5 关键词固定字符串检索（protected first surface head / SessionFormatError / corrupt / 历史加载失败 / 受保护头）：**全部 total_matches=0**。

```
KW[protected first surface head] total_matches=0
KW[SessionFormatError] total_matches=0
KW[corrupt] total_matches=0
KW[历史加载失败] total_matches=0
KW[受保护头] total_matches=0
```

**未命中，故无原始报错行片段可附**（检索时间戳 18:13–18:16，范围与命令见上）。
**如实局限**：宿主 pid 20983 不持有任何 .log 句柄（lsof grep 命中 0），重启后运行输出不落盘为 .log；「无错误」由 §1 三条证据链证明，而非由某个读取日志文件证明。不伪造日志证据。

## 5. GUI 交叉证据状态（A3）

- 早期草稿曾引用「约 17:55 用户 GUI 观察正常（主 Agent 转达）」——属转述；本轮尝试用 `session_event_search`（父会话，query=1513，time_from=17:50+08:00）核实原始事件，返回 `tool call timed out after 30000ms`（与 R3 独立观测一致），**无法取得可引用的原始 GUI 观察记录**。
- 18:12 已 send_message 向主 Agent 索取 GUI 观察要点（投递成功）；截至本报告整合（18:16）未获回复。
- **按 A3 处置：本判定标注为「服务端单侧证据」，GUI 交叉证据缺口如实登记，不宣称端到端通过。** 请主 Agent/T4 在收尾时补入用户 GUI 观察（或确认缺口）；若 GUI 侧出现报错，本判定应退回重查。

## 6. 只读承诺核验（A4）

- live 压缩件：取证前后 size=632447 B、mtime=2026-11-12 17:51:12 **完全未变**（18:14 审计与 18:16 负责人 stat 两次一致）；17:51:12 的追加发生在本次取证开始之前，属宿主重启行为，非本任务写入。
- 基线副本 sha256 两轮一致（`15c718e9…`），未被改动。
- 本任务全部写入仅落在 workspace 新文件：本报告、r2-t2-verify-decode.jsonl、r2-t2-decode-audit.log、r2-t2-log-scan.md、r2-t2-lead-notes.md、.r2-restart-ref（0 字节参照）。**未对任何会话日志执行写入、删除或覆盖。**

## 7. 单列事项（不混入读取判定）

- **R3**：`session_event_search` 对 1513/父会话仍 30s 超时，属会话索引路径，与 GUI 读取链路无已证实因果关联；独立未决项，另行跟踪。本轮它造成的实际影响＝GUI 原始观察无法从事件流核实（§5）。
- **沙箱局限**：/bin/ps 被拒（历史教训：一次即停），改用 lsof + T1 状态核验佐证 pid/启动时间，不影响结论。
- 下级状态行在整合时点仍显示 running，但两份产物已完整落盘且经负责人独立重跑复核（审计日志有明确 end 时间戳）；按「产物在盘＋独立复核」采信，不空等状态行，偏离已如实记录。

## 8. 验收对照（本任务书 A1–A4）

| 验收项 | 结果 | 证据 |
|---|---|---|
| A1 条数与关键字段核对 + 报错检索命中/未命中的原始片段与时间戳 | pass | §2 三重核对（477=476+1、0 错误 0 缺口、cmp 逐字节、sha256）；§4 五关键词×三范围 0 命中（18:13–18:16），未命中无片段可附、局限如实 |
| A2 单一判定 | pass | §1 读取正常（服务端实证 PASS）；无报错故无逐字报错文本 |
| A3 GUI 缺失标注 | pass | §5 明确「服务端单侧证据 + GUI 缺口」，不宣称端到端通过 |
| A4 零写入会话日志 | pass | §6 live size/mtime 取证前后未变、基线指纹一致、写入仅 workspace 新文件 |

**最终判定：重启后继续会话 1513 读取正常（服务端实证 PASS）；GUI 交叉证据缺口已登记，端到端结论留待主 Agent/T4 闭环。**
