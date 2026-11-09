# dsh-workplan v2.2.6 对外发布说明（T3 · 2026-11-09）

- 版本冻结依据：`docs/release-records/version-freeze-20261109-T2.md`（冻结版本 = **2.2.6**；已发布基准 2.1.5 / tag v2.1.5 / commit 6ed12d3）
- 本文所有数字与事实均回指既有归档证据，未新造任何数字；引用清单见文末「证据回指表」。
- 用途：§一 供 GitHub Release 页面正文直接粘贴；§二 供索引源（awesome-dsh-plugin）PR 与 tarball 更新；§三 为自检记录。
- 本文件只描述「准备就绪的发布内容」，不表述发布动作是否已发生；发布执行与状态由 T4/T5/T6/T7 产出。

---

## 一、GitHub Release 正文（tag：v2.2.6）

# dsh-workplan v2.2.6 — 三项修复：回放闭环、需求序列化、分解进度可见

**本版包含三项修复**，全部改动以锚点标记可追溯（`[2.2.6]` 标记 src 12 处 ↔ lib 12 处一一对应），并完成合并态统一回归（**666/666** 通过）。

## 1. D-1：重启回放丢弃人工改判的 closure 字段（起源 1.7.0，非 2.2.5 引入）

durable 的 `workplan-update` 自 1.11.0 起携带 closure，但 `reconstructFromSession` 的回放 patch 一直没把它传给 `applyStatus`：行停在 escalated 时，`status=done` 的改判被「非法闭环迁移 escalated→done」拒绝，整条 update 被裸 catch 吞掉，重启后「待指示」行永久卡死。本版补上 `closure: update.closure`，并把裸 catch 改为 `console.warn` 留痕（fail-closed 而非 fail-silent）。

红-绿验证：摘掉修复跑全量 → 651 项中恰好 1 失败（失败点=改判链 escalated→instructed→done→reported 必须完整回放）；恢复修复 → 651/651 通过。

## 2. 跨部门需求落盘变 `[object Object]`（handoff 序列化）

- **现象**：子 Agent 以对象形提出的跨部门需求，入库时被隐式 `String(对象)` 整体转成字面量 `[object Object]`，部门信息一并丢失（实证：主计划 wp-db6de2f0 的 T1–T4 四条需求均为 `request="[object Object]"、department:null`）。
- **病根**：4 个写坏点（`src/plan.ts` `readEvidenceNeeds` / `mergeHandoffsFromNeeds` / `readEvidenceOptions`，`src/runtime.ts` escalate）。
- **修复**：全部改为对象感知的受控序列化——对象需求落盘为「部门：需求（用途）」可读文本 + 合法部门键；嵌套/循环引用兜底为循环引用安全、undefined 安全的受控 JSON；字符串路径逐字不变；历史损坏记录加载不抛错、存量逐字段不改写。
- **验证**：专项回归 **10/10**（对象原文一致 / 嵌套受控 JSON / 循环引用不抛错 / 历史记录不改写 / 幂等 / 全链路）；坏模式 `String(item ?? '')` 在 src 与 lib 中 **0 命中**。

## 3. 任务自动分解期间界面零提示（进度可见性）

- **现象**：发任务后自动分解的几十秒到几分钟里界面毫无反应，分不清「在干活」「在重试」还是「卡死」。取证判定：分解全程插件零 `session.append`、零 `records.set`——侧栏 4 秒轮询与「正在安排」词汇早已存在，只是从未收到数据（断点层=未发出，插件层）。
- **修复**（零新组件、零新路由、零推送机制）：
  1. **进行中**：进入分解先写占位进度卡，侧栏 4 秒轮询内出现「正在安排」+「正在生成任务分解…」；
  2. **重试中**：每次可重试失败，卡片追加「第 N 次尝试失败（原因码）：真因；正在重试（约 X 秒后），第 (N+1)/3 次」，聊天通知每轮**至多 2 条**（第 3 次失败直接进降级文案）；
  3. **失败带真因**：3 次全败走降级横幅，逐次真因链截断 ≤120 字符、错误码（如 `ECONNREFUSED`）原样保留；
  4. **等信息中**：澄清场景徽标不再回显原始键名 `clarify`（zh「等信息中」/ en "Waiting for info"）；
  5. **用户中止**：全静默、不残留假「进行中」、不丢上一份终态进度。
- **验证**：专项回归 **5/5**（抖动重试文案 / 通知频率硬规则 / aborted 静默 / 真因截断 / 词汇键）；重试语义零变化（`onProgress` 只读观察点）。

## 合并态统一回归（总判定 GO，产品级失败项 = 0）

- 产物一致性：构建前后双检哈希 15/15 + 根 client.js 一致；`npm run check` exit 0；
- 全量套件 **666/666**（= 661 + 5，计数精确吻合）；
- 既有守卫与双向回归不回退：守卫 6/6、抖动正例 8/8 断言、AUTH 反例 4/4、cause 链 3/3、取消传播 3/3、真故障反例 7/7（1564–1678ms，与基线 1.454s 同量级带内）。

## 边界与已知事项（如实登记，不包装）

- 两项双缺陷修复的**生环境复验**待用户重启后执行（四态：进行中 / 重试中 / 失败带真因 / 等信息中）；聊天通知能否在分解等待期间即时上屏属宿主运行态行为（H-1），侧栏卡片（4 秒轮询）为保底通道。
- wp-db6de2f0 四条历史损坏记录原文已从子会话日志提取留档，**可恢复**；存量数据一字不改。
- **D-3 未在本版修复**（轮次中途完成只存内存、重启丢当前计划状态）：属轮次生命周期改造，建议下版专项处理；缓解：重要节点后不要立刻重启。
- 宿主侧三项深度改进（cause 透传、maxRetries 可配、直连流重试覆盖）随宿主发版落实；插件侧已前向兼容、不依赖。
- 2.1.5 → 2.2.6 之间各版的完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

```bash
npm install dsh-workplan@2.2.6
```

---

## 二、索引源登记内容

索引源机制（沿用既有结论）：上游索引仓库 `awesome-dsh-plugin`，文件 `data/plugins/abbaababa__dsh-workplan.yml`，仅含 7 个键、无 version/sha256 字段，版本由 `tarball` URL 隐含；上游 catalog 的 npm 包由上游 CI 定时从该仓库生成，提交 PR 不等于 npm 包立即更新。

### 2.1 tarball 行更新（本次只改 1 行）

旧值：

```yaml
tarball: https://github.com/abbaababa/dsh-workplan/releases/download/v2.1.5/dsh-workplan-2.1.5.tgz
```

新值（版本号与冻结值一致）：

```yaml
tarball: https://github.com/abbaababa/dsh-workplan/releases/download/v2.2.6/dsh-workplan-2.2.6.tgz
```

### 2.2 PR 标题与正文模板

标题：

```text
Update abbaababa__dsh-workplan to v2.2.6
```

正文：

```markdown
Bump dsh-workplan tarball from v2.1.5 to v2.2.6.

Release: https://github.com/abbaababa/dsh-workplan/releases/tag/v2.2.6
Highlights: replay keeps manual-adjudication closure across restart; cross-department handoff needs serialize as readable text instead of "[object Object]" (department key preserved); progress visibility during automatic task planning (planning card via 4s sidebar poll, retry notices with real cause chain, capped at 2 per round, "Waiting for info" badge).
No breaking changes.
Tests: 666/666 passing (`npm test`).
```

### 2.3 版本短描述（zh / en，供目录与展示用）

- zh：修复三项：重启后人工改判不再丢失（closure 回放）；跨部门需求落盘不再变 `[object Object]`（可读文本+部门键，历史记录不改写）；任务自动分解期间界面有进度（4 秒内侧栏进度卡、重试带真因且每轮至多 2 条通知、澄清徽标显示「等信息中」）。合并态回归 666/666。
- en: Three fixes: manual-adjudication closure survives restart replay; handoff needs serialize as readable "department: need (purpose)" text with the department key preserved instead of "[object Object]" (legacy broken records load untouched); progress visibility during automatic task planning (planning card via 4s sidebar poll, retry notices with real cause chain capped at 2 per round, "Waiting for info" badge). Merged-state suite 666/666.

---

## 三、自检记录（A1–A3）

- **A1 版本号一致**：本文所有版本号均为 **2.2.6**（tag v2.2.6 / npm install dsh-workplan@2.2.6 / tarball URL v2.2.6），与 T2 冻结值一致；对比基准 2.1.5 亦与 T2 三处对照记录一致。自检命令：`grep -n "2\.2\.6\|2\.1\.5" docs/release-records/release-notes-2.2.6-T3.md`（结果见 T3 汇报）。
- **A2 数字可回指、未新造**：651（D-1 红绿）、10/10（序列化专项）、5/5（可见性专项）、666/666、15/15、6/6、8/8、4/4、3/3、7/7、1564–1678ms、1.454s、≤120 字符、至多 2 条、4 秒轮询、300s 窗口、12 处标记、四条历史记录——逐项出处见下表。
- **A3 无未经验证的收尾表述**：全文不含任何收尾性定论用语（如宣称发布动作已完成、宣称成品定稿）；发布动作状态显式移交 T4–T7；生环境复验明确写为「待用户执行」。

### 证据回指表

| 文中数字/事实 | 出处 |
|---|---|
| 2.2.6 冻结 / 2.1.5 已发布基准 / 6ed12d3 / 12 处标记 / 666 待发布范围 | `docs/release-records/version-freeze-20261109-T2.md` §1–§4 |
| D-1 651 红绿 / closure 补丁 / console.warn | CHANGELOG.md 2.2.6 条目（既有，本版沿用）；tests/runtime-replay.test.ts |
| `[object Object]` 现象 / W1–W4 点位 / wp-db6de2f0 四条 / 可恢复结论 | `_t1_dualdefect_rootcause_20261108/root-cause-and-boundary-report.md` §2.2/§2.3/§2.5 |
| 序列化修复点位与改法 / 10/10 / `String(item ?? '')` 0 命中 / `[2.2.6][T4]` 锚点 | `_t4_need_serialization_fix/fix-report.md` §二/§四 |
| 可见性四态文案 / 频率 ≤2 条 / ≤120 截断 / P-9 clarify / 零新组件 / 4 秒轮询 / 300s 窗口 / 重试语义零变化 | `_t5_visibility_impl_20261108/implementation-notes.md` §一/§二/§三 |
| 666/666 / 15/15 哈希 / 守卫 6/6 / 抖动 8/8 / AUTH 4/4 / cause 3/3 / 取消 3/3 / 真故障 7/7 / 1564–1678ms / 基线 1.454s / 偏差披露 | `_t6_dualfix_regression_20261108/T6_双修复回归测试报告.md` §一/§四/§五/§六 |
| 生环境复验四态 / H-1 / 通道 A 保底 / 宿主三项 H2 | `_t7_closure_20261108/结案说明与移交清单.md` §四/§二 |
| 索引源机制（awesome-dsh-plugin / 7 键 YAML / tarball 隐含版本 / CI 定时） | `_t11_release_20261102/index_entry_v1.11.0.md`（既有机制结论，机制未变） |

### 遗留提示（移交，不阻塞文案冻结）

- CHANGELOG.md 三处历史条目含本机用户目录绝对路径（T2 敏感初筛发现项：:138/:180/:2233 附近），属既有条目，是否随发布提交改写由主 Agent/T4 决定；本 T3 新增文案未引入任何本机绝对路径。
- GitHub Release 资产名 `dsh-workplan-2.2.6.tgz` 为按既有 tarball 命名惯例（v1.11.0 同构）推导的约定值，实际资产名以 T4 发布脚本/T5 上传为准。
