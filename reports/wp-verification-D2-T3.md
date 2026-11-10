# D2 修复独立验证报告（T3 · 质量验证）

- 对象：T2 补丁（规划器 JSON 语法兜底 P0 + 结构化重试 P1 + prompt 约束 P2），工作区未提交改动（`git status` 实测 M src/plan.ts、src/runtime.ts、tests/plan.test.ts、lib/plan.js、lib/runtime.js 共 5 文件）
- 基线：HEAD 8b48796（2.3.1/D1）；验证时间 2026-11-10 20:16–20:30（Asia/Shanghai）
- 方式：全部只读验证 + 独立探针，未修改任何产品代码；探针脚本 `/tmp/t3_probe.mjs`（15 项用例）

## 一、验收结论（逐条）

| 项 | 结论 | 证据 |
|---|---|---|
| A1 全量测试 fail=0、cancelled=0、exit 0 | **pass** | `node scripts/run-tests.mjs`：`# tests 723 / pass 723 / fail 0 / cancelled 0`，`[run-tests] pass=723 fail=0 cancelled=0 exit=0`，exit 0（完整日志 /tmp/t3_full_tests.log）；npm run build exit 0、npm run check（tsc --noEmit）exit 0 |
| A2 漏逗号 JSON → 修复后 parse 成功 | **pass** | 独立探针 A2-1..A2-7 全 PASS：字符串值相邻 `"x" "b":1`、数组 `"a" "b"`、深层嵌套、数字/布尔相邻、全角逗号 `，`、全角引号冒号 `{“a”:1}`、多余闭合 `{}}}` 丢弃；官方定向用例 ok 262/263/264（[2.3.2] A/B/L、C/D、E+F/G/H/I 零回归） |
| A3 不可修复语法 → 结构化重试而非静默丢弃 | **pass** | 探针 A3-1：`{"a"=1,…}`（300 字符长输入）抛 INVALID_JSON 且 message 含「错误位置 N，断点附近原文（字符 F-T）：…」+「请只修复该处 JSON 语法」；控制流实证：terminalFailure 仅对非重试类 PLANNER_LLM_ERROR 置真（runtime.ts:1061-1066），INVALID_JSON 不终态 → 进重试循环（:842，上限 3）→ 断点反馈入 lastErrors（:1036-1050）→ 定向回喂下一 prompt（:914-918）；官方定向用例 ok 265 |
| A4 产物与源码同步（diff 门禁） | **pass** | 双构建哈希比对：rebuild 前 `shasum lib/plan.js lib/runtime.js client.js` = rebuild 后逐字节一致（480f0bc9…/0ce810ac…/221894ab…），即 lib 产物为当前 src 的忠实构建输出，可复现；[2.3.2] 标记锚定计数 src/lib 一致（plan.ts 11=plan.js 11，runtime.ts 1=runtime.js 1） |
| A5 无值篡改、重试 ≤3、总超时保护 | **pass（附 2 条缺陷记录，见 §二）** | 重试上限：`PLANNER_MAX_ATTEMPTS = 3`（runtime.ts:686，lib:603），循环 `attempt 1..3`，:1067 仅 `attempt < 3` 才退避续试；总超时保护：无进展窗口 PLANNER_TIMEOUT_MS=300s（:211）+ 绝对硬上限 hardMs=窗口×3=900s PLANNER_TIMEOUT_HARD（:786/:893）+ 停滞检测 PLANNER_IDLE（:870），全部落 lib 产物实测（grep 命中）；值篡改红线：代码读遍 repairJsonStructure 全函数——inString 分支内所有新规则（插逗号/归一/丢弃）均不可达，字符串内容不触碰；探针 TAMPER-1/2/5/6 PASS（串内全角一字不动、指数 1.5e-3 不拆、键后冒号不误插） |

## 二、审查发现（如实记录，不影响 D2 事故类修复有效性判定）

- **D2-QA-1（既有缺陷，非 T2 引入；可达面被 P0 扩大，建议后续小补丁）**：`stripTrailingCommas`（2.1.0 既有，HEAD 行 1076/1078 实测存在）正则 `/,(\s*[}\]])/g` 不感知字符串边界，会吃掉字符串值内部的「半角逗号+空白+闭括号」。旧版对照实锤：`{"a":1,"note":"p, } q"`（截断补闭合路径）旧版同样产出 `{"a":1,"note":"p }"}`（值篡改），故**根因是既有代码，非 T2 三条新规则**。但 T2 后新增可达：`{"a":"see a, } tail" "b":2}`（漏逗号）旧版拒绝（THROW INVALID_JSON → 回喂重试），新版接受但值为 `see a } tail`。触发条件罕见（值内需出现半角逗号紧邻 `}`/`]`），规划器中文正文值基本不含该形态。建议：把该正则改为复用单趟扫描器（字符串外才删尾逗号），约 5 行，归入 src/plan.ts 同文件。
- **D2-QA-2（低风险边界观察）**：全角 `＂`（U+FF02，非事故损伤类）开串后 `＂` 本身不作闭合符 → `{"a":＂1＂, "b":2}` 值错位配对后被截断抢救路径丢弃尾成员（有 console.warn 非静默；旧版此输入直接 THROW）。事故类 “” 配对探针 PASS。可选收紧：闭合符集加入与开串符同型的 `＂`。
- **范围确认**：`truncatedCandidates` 丢尾成员抢救为 2.1.0 既有契约（T2 已声明未动），本报告不计缺陷，与 T2 自述口径一致。
- **diff 面核对**：净改动 5 文件符合 T2 声明；`reports/wp-settlement-T1.json` 的 1 行 M 为 T1 遗留（T2 声明零写入，与 git status 事实不冲突）；`reports/wp-settlement-T2.json`、`reports/wp-diagnosis-D2-T1.md`（T1 诊断报告，在盘）为结算/报告类非产品代码。

## 三、结构化重试机制链路图（独立复核确认）

extractJson（plan.ts:1255 区域）→ 直接 parse 失败 → repairJsonStructure（P0：插逗号/全角归一/栈空丢弃/补闭合，仅字符串外）→ 仍失败 → truncatedCandidates 抢救（有 warn）→ 仍失败 → throw PlanError(INVALID_JSON) + parseFailureHint（错误位置 ±60 原文，plan.ts 新增）→ runtime catch（:1030+）：INVALID_JSON 非 terminal → lastErrors=[带位置反馈] +（closed 判定）定向修复指令（:1039-1050）→ 下轮 prompt 追加「上一次输出未通过校验…只修该处」（:914-918）→ 至多 3 次（:686/:842/:1067），全程受 300s 无进展窗口 + 900s 绝对上限（:211/:786）约束。D2 事故路径（3×29s 盲掷白烧 86.9s）的三类损伤 A/B/C/D/E/L 现均在第一层本地修复，不再进入重掷。

## 四、探针原始输出（节选）

```
PASS A2-1..A2-7 / TAMPER-1,2,4,5,6 / A3-1 / A3-2（共 14 PASS）
FAIL TAMPER-3 :: 修复路径伤及字符串内逗号（→ 定性为既有缺陷 D2-QA-1，见 §二）
OLD截断类+串内", }" => {"note":"x }"}（旧版同篡改，实锤既有）
OLD漏逗分类 => THROW INVALID_JSON（旧版拒绝，新版修复但受 D2-QA-1 影响）
FULL: # tests 723 / pass 723 / fail 0 / cancelled 0, exit 0
```

## 五、最终判定

**T2 补丁验收通过**：D2 事故三类损伤本地修复有效（A2）、不可修复时定向反馈重试有效且不静默（A3）、全量零回归（A1）、产物同源可复现（A4）、机制三要素齐备（A5）。两条审查发现均为**既有代码缺陷/罕见边界**（非本补丁引入），已给出 5 行级修复建议，是否追补由主 Agent 决策。

## 六、第二轮独立复验（结算轮 · 2026-11-10 20:24–20:40 Asia/Shanghai）

上一轮以 CHILD_TIMEOUT 结算：本报告已落盘（20:22:03），但结算备份与结果块未提交。本轮**逐项重跑复核全部结论，全部复现**，无一改判：

| 复核项 | 本轮实测 | 与首轮一致 | 证据留档 |
|---|---|---|---|
| 重建确定性（A4） | 记哈希→`npm run build` exit 0→再记哈希：lib/plan.js `480f0bc9…`、lib/runtime.js `0ce810ac…`、client.js `221894ab…` 逐字节一致 | ✓ | /tmp/t3_hash_before.txt、/tmp/t3_hash_after.txt、/tmp/t3_build.log |
| 全量测试（A1） | `node scripts/run-tests.mjs`：**pass=723 fail=0 cancelled=0 exit=0**（duration 60.4s） | ✓ | reports/wp-evidence-D2-T3-full-tests-r2.log |
| 15 项探针（A2/A3/红线） | 重跑：14 PASS + 1 FAIL（TAMPER-3，即 §二 D2-QA-1 既有缺陷，非新伤） | ✓ | reports/wp-evidence-D2-T3-probe-r2.log |
| 定向官方用例 | `node --test --import file://…/setup-event-loop-anchor.js dist-tests/tests/plan.test.js`：**30/30 pass、exit 0**，含 5 条 [2.3.2] 新用例（漏逗号/全角归一/多余闭合/INVALID_JSON 定向反馈/P2 prompt 约束）逐条 ✔ | ✓ | reports/wp-evidence-D2-T3-targeted-plan.log |
| D2-QA-1 归属强化 | `git diff -- src/plan.ts \| grep -c stripTrailingCommas` = **0**；按内容提取函数体与 HEAD 逐字节比对 = **STC_IDENTICAL** → 缺陷 100% 既有（2.1.0），T2 仅扩大可达面 | ✓（新增确证） | 本轮命令输出 |
| 源码锚点复核 | parseFailureHint（plan.ts:1261/:1269/:1308）、P2 约束行（:1388）、PLANNER_MAX_ATTEMPTS=3（runtime.ts:686/:842/:1067）、300s 无进展窗口（:211）+ hardMs=×3=900s 绝对上限（:786/:896）、定向回喂指令（runtime.ts:1044-1050 diff 实读） | ✓ | grep/sed 实测输出 |

- **测试操作偏差记录（非产品缺陷）**：定向单文件首次以 `--import dist-tests/…`（裸相对路径）调用被 Node 当作包名解析 → `ERR_MODULE_NOT_FOUND`、exit 1；按硬规则先诊断为用例操作错误（官方入口 scripts/run-tests.mjs 用 `pathToFileURL` 绝对化），改用 `file://` 形式后通过。
- **结论**：维持 §五判定不变——T2 补丁验收通过；`stripTrailingCommas` 不感知字符串边界（D2-QA-1）与全角 `＂` 异型配对（D2-QA-2）两条既有发现移交主 Agent 决策是否追补约 5 行小补丁。**运行态仍待用户手工重启 dsh web 进程加载修复后 lib 产物**（规则禁止 Agent 自行重启）。
