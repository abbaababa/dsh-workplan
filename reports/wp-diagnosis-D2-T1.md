# D2 诊断报告 · 规划器 JSON 解析链路根因分析

- 子任务：T1（wp 计划 · 研究分析部门）
- 时间：2026-11-10 19:5x（诊断只读，未改动任何源码）
- 现场：qwen3.8-flash 规划器 INVALID_JSON ×3，86.9 秒全链白烧，自动分解降级
- 源码：plugins/dsh-workplan @ 8b48796（v2.3.x），lib 与 src 同源（19:40 重建）

## 1. JSON 解析链路图（函数 → 文件 → 行号）

```
maybePlan                    src/runtime.ts:8217        ← 自动分解入口（每轮第一步前）
 └─ runPlanner               src/runtime.ts:779
     └─ 尝试循环             src/runtime.ts:842         ← PLANNER_MAX_ATTEMPTS=3 (:686)
         ├─ buildPlannerPrompt src/plan.ts:1252 附近    ← 拼 prompt；:1298 有「只输出一个 JSON 对象」
         ├─ 重试反馈拼装      src/runtime.ts:917-923    ← lastErrors 逐条回喂（slice 0..12）
         ├─ ctx.llm.stream → collectStream              src/runtime.ts:939-944
         ├─ extractJson      src/plan.ts:1185           ← ★ 解析入口（唯一 INVALID_JSON 抛出点 :1219）
         │   ├─ JSON.parse(candidate)                    :1199
         │   ├─ repairJsonStructure  src/plan.ts:1080    ← 结构修复①：配对括号/去尾逗号/转义裸控制符
         │   ├─ stripTrailingCommas  src/plan.ts:1148
         │   ├─ truncatedCandidates  src/plan.ts:1175    ← 结构修复②：截断抢救（尾部逐成员丢弃，≤24 轮）
         │   └─ throw PlanError('INVALID_JSON')          :1219
         ├─ catch：cause 链透传  :1024-1033
         ├─ INVALID_JSON 专项回喂（长度/末尾120字符/闭合判据） :1039-1049
         ├─ 退避：仅 TRANSPORT/TIMEOUT/SERVER/RATE_LIMIT 指数退避(:1056-1066, base 500ms :687)
         └─ 全部失败 → 降级文案  :1138-1142（attemptReports 逐次留档）
```

同族第二解析路径（不在 D2 现场，但受同一根因家族影响）：
- 子 Agent 结果块：parseEvidenceBlock src/plan.ts:2781 → repairEvidenceJson src/plan.ts:2716（独立实现，能力同型偏窄）
- salvagePartialPlan src/runtime.ts:746（定时中止抢救，只认「末尾已闭合」——对 E 类损伤同样回天无力）

## 2. 实测损伤类型矩阵（对当前 lib/plan.js extractJson 逐类实测，非推断）

命令：node --input-type=module 直接 import lib/plan.js 跑 12 个样本（本会话终端留档）。

| 样本 | 损伤类型 | 结果 | 说明 |
|---|---|---|---|
| A | 成员间漏逗号 `"x" "version"` | **FAIL INVALID_JSON** | 修复器不插分隔逗号 |
| B | 数组元素间漏逗号 `["a" "b"]` | **FAIL INVALID_JSON** | 同上 |
| C | 全角逗号分隔 `1， "b":2` | **FAIL INVALID_JSON** | 字符串外全角标点不归一 |
| D | 全角引号键 `“a”:1` | **FAIL INVALID_JSON** | 同上 |
| E | 多余闭合括号 `{"a":{}}}` | **FAIL INVALID_JSON** | 栈空时多余 `}` 原样保留（:1120-1126 只补缺不删多） |
| F | 错型闭合 `[1,2}` | OK（已修复） | 栈回补逻辑覆盖 |
| G | 截断缺收尾 | OK | truncatedCandidates/栈补齐覆盖 |
| H | 字符串裸换行 | OK | 转义逻辑覆盖 |
| I | 尾逗号 | OK | stripTrailingCommas 覆盖 |
| L | 嵌套深处漏逗号 | **FAIL INVALID_JSON** | 截断抢救从尾部丢成员，救不了文档中部的逗号缺失 |

**结论：现有容错（2.1.0 引入）覆盖「括号/尾逗号/裸控制符/截断」四类，但“成员间漏逗号、全角标点、多余闭合括号”三类完全穿透——这正是 D2 现场描述的「漏逗号/括号不匹配」形态。**

## 3. 根因结论（三因叠加，主因是①）

**根因①（主因）——修复器能力缺口**：extractJson 的 repairJsonStructure（plan.ts:1080）只做「补」不做「插/删/归一」：
- 不在字符串外为相邻成员插入缺失的 `,`（A/B/L 穿透）；
- 不把字符串外的 `，` `“”` 归一为 `,` `"`（C/D 穿透；中文模型长输出高频率）；
- 栈已空时多余闭合符原样保留（E 穿透）。
后果：对这三类损伤，本地修复必然失败，只能整轮回喂模型重生成。

**根因②——重试是「全量重掷」而非「定向修复」**：runtime.ts:842 的重试把错误清单+末尾 120 字符回喂（:917-923, :1039-1049，有反馈✓），但要求模型重新输出 6-10KB 完整 JSON。语法不稳定是输出长度的函数，重生成产生同类新损伤的概率高——3 次独立重掷 × 同一穿透类 = 复现乘性失败。且 INVALID_JSON 不在退避/终态分级考虑内，三次全量生成 ≈86.9 秒（每次 ~29 秒），无任何本地兜底。

**根因③（放大器）——prompt 约束只有一条泛文案**：buildPlannerPrompt（plan.ts:1298）只有「不要输出 Markdown 代码围栏…只输出一个 JSON 对象」，没有「半角标点、成员间逗号、括号成对」的逐条硬性自检指令（grep「半角/逗号」在 prompt 区 0 命中）。对 qwen 系中文模型，全角标点是最常见注入源，prompt 未设防。

**排除项**：
- 非「无容错」：2.1.0 容错已在现场版本生效（lib 19:40 重建，含 7 处 repair 符号；事故时 17:00 构建同样含）；
- 非「重试无反馈」：:917-923 反馈路径存在且 INVALID_JSON 有专项尾部诊断；
- 多入口排除：全 src 仅 plan.ts:1219 一处抛 INVALID_JSON，调用 extractJson 的仅 runtime.ts:945（主路径）与 :750（salvage，同样穿透），同一代码路径成立✓。

## 4. 修复方案建议（交 T2，按优先级；预算内可达）

**P0 修复器扩能（只改 src/plan.ts，约 +40 行，零新依赖）**
在 repairJsonStructure 的字符串外状态机里加三规则（全部满足「只修结构、不碰内容」红线）：
1. **插逗号**：字符串外，值结束符（`"`/数字尾巴/`true|false|null`/`}`/`]`）后跳过空白遇到 `"``（对象成员键起始）或下一值起点 → 插入 `,`。实现即现有单趟扫描的邻接判定，无回溯无猜测。
2. **归一半角**：字符串外 `，`→`,`、`：`→`:`、`“”``→`"`（仅在字符串外做，字符串内一字不动）。
3. **删多余闭合**：栈为空时遇到 `}`/`]` → 丢弃该字符（当前是原样保留）。
顺序：现有扫描内联完成 1/2/3，之后照旧 stripTrailingCommas；extractJson 兜底链不变（repair → truncated candidates → throw）。
预估改动：src/plan.ts 1 文件 + tests/plan.test.ts 补 A/B/C/D/E/L 六类样本用例（现该文件对漏逗号类 0 覆盖，实测 grep 确认）——合计 2 文件 ≤3 ✓，无需安装依赖 ✓。

**P1 重试从「全量重掷」升级为「先本地修、修不动才重掷 + 定向位置反馈」（src/runtime.ts 局部，约 +10 行）**
- INVALID_JSON 回喂文案追加解析器 position 附近 ±60 字符原文（现只给末尾 120 字符；错误在文档中部时模型依然盲）。position 已在 error.message 里（"at position 14"），提取切片即可。
- P0 落地后此条命中率大降，作为纵深保留。

**P2 prompt 加固（src/plan.ts buildPlannerPrompt +1 行）**
硬性约束区追加：「JSON 必须仅用半角标点；对象/数组成员之间必须有逗号；输出前自检括号成对」。与 P0 互为兜底。

**P3（记录，不在本轮范围）**：parseEvidenceJson/repairEvidenceJson（plan.ts:2716）与 repairJsonStructure 是同族双实现，建议后续统一收敛到一个修复器，避免再次分叉；salvagePartialPlan :747 只认末尾闭合，P0 落地后可顺带放宽。

**验收锚点（供 T3）**：本报告 §2 矩阵 A/B/C/D/E/L 六样本从 FAIL 转 OK；F/G/H/I 保持 OK；全量回归无新增失败。

## 5. 证据索引

- 链路行号：§1（全部 grep/sed 实测输出留档本会话）
- 穿透实测：§2 表格（node 直接 import lib/plan.js，12 样本逐一执行）
- 重试行为：src/runtime.ts:686/842/917-923/1039-1049/1056-1066
- 容错现状：src/plan.ts:1080-1146（repairJsonStructure）/:1148/:1153/:1175/:1199-1221
- prompt 文案：src/plan.ts:1268/1298；「半角/逗号」约束 grep 0 命中
- 依赖：package.json dev-only（typescript/@types），无 json5/jsonrepair——修复走零依赖自研
- 版本/构建：git 8b48796；lib/* mtime 19:40 与 src 同源，grep 计数 repair×7 / feedback×2

## 6. 复核增补（第 2 次尝试 T1 只读复核 · 2026-11-10 19:5x）

上次失败为结果块 JSON 语法非法（工作产物无损），本轮对全部证据锚点做独立复测，两处精度修正：

1. **F 样本（错型闭合 `[1,2}`）复测偏差定位**：裸顶层数组走 extractJson 返回 NO_JSON（候选识别只认对象形态），改用对象形态 `{"a":[1,2}` 实测 **OK 修复成功**。结论不变：栈回补对真实规划器输出（顶层对象）有效；§2 表格 F 行的 OK 以对象形态为准。
2. **退避分级精度修正**：runtime.ts:1060-1066 的判据是「PLANNER_LLM_ERROR 且不在 PLANNER_RETRYABLE_LLM_CODES → terminal 跳出」；INVALID_JSON 属 PlanError 非 LLM 错误类，落入 else 分支获得 500ms 级小退避后**照常全量重掷，且永不被判 terminal**——报告 §3 根因②的实质结论（三次全量重掷 ≈86.9s、无本地兜底、无终态分级止损）成立且更精确：不是「无退避」，是「退避无关痛痒、重掷策略错误」。
3. 其余锚点逐项复核全部吻合：PLANNER_MAX_ATTEMPTS=3（:686）、尝试循环（:842）、lastErrors 回喂（:917-923）、INVALID_JSON 专项诊断（:1039-1049）、cause 链透传（:1024-1033）、extractJson（plan.ts:1185）、唯一 INVALID_JSON 抛出点（plan.ts:1219，grep 全 src 确认单点）、repairJsonStructure（:1080）、stripTrailingCommas（:1148）、证据块双实现（:2716/:2781）、package.json dependencies={} 零运行时依赖。
4. 穿透矩阵复测（直接 import lib/plan.js 实测）：A/B/C/D/E/L 六类全 FAIL（与 §2 一致），G/I OK，F 对象形态 OK——**修复方案 P0 的六个转绿锚点全部真实成立**。
