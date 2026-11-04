# 四处缺陷 before/after 证据表（1.12.3）

> 口径：befor 一律取自 11-04 真实重跑落盘的 capture 或当时构建（1.12.2）的实测输出；
> after 一律取自 1.12.3 工作树（提交 56e3aad）的实测输出。**没有重跑 20 条模型调用**，
> 全部是确定性判定回放（不联网、不调模型），命令与样本见每行「证据」。

| 编号 | 缺陷 | before（1.12.2） | after（1.12.3） | 证据 |
|---|---|---|---|---|
| ① 指代误拦 | T05-08「它每天具体走势」 | capture_T05-08.json：`CONTEXT: 含指代的任务在最近对话里找不到先行词：它`，计划为空（降级） | `resolved=true, resolvedBy=task-text, antecedent=159667工业母机ETF国泰, verdict=aligned` | `_t3_anaphora_20261104/replay_results.json`（fixtures/T05-08.txt，sha256 3c891437c8a4302f） |
| ② 该问不问 | T05-04 / T05-09 / T05-13 / T05-20 | 四条全部生成计划并派发（0/4 澄清） | C1/C2/C4/C3 四条规则各命中 1 例，4/4 触发澄清；16 条正常任务误拦 0 | `tests/clarify-gate.test.ts`（10 条）+ 离线回放输出（4/4、0 误拦） |
| ③ 未确认自行派发 | 20 条累计 46 次（T05-07 单条 9 次） | 信息不足也照派发 | 信息不足时连计划都不生成：headless 真跑 T05-13 → `dsh_workplan_*` 调用 0 次、计划信封 0 个 | `_t_clarify_20261104/T05-13_events.jsonl` |
| ④ 法务召回 | T05-12「会窃取…文件和数据吗」 | legal 命中 0 词，required 不含 legal | legal 命中 2 词（窃取、移动终端），required = [`legal`]；「修复内存泄露导致的崩溃」仍 0 词 | `auditDepartmentCoverage` 实测输出 + `src/departments.ts` 词表 |

## 未通过项

- 本版没有未通过的修复项。
- 未覆盖项（不计入本表证据）：同一工作区里 headless「未完成不得成功收尾」闸门（`failClosedOnIncomplete` / `WORKPLAN_INCOMPLETE`）只有实现、没有自动化用例；已在 CHANGELOG 1.12.3 §四登记。

## 复跑方式

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
npm test                 # 523/523
npm run check            # tsc --noEmit，退出码 0
node _t_clarify_20261104/../../../../tmp/replay_after.mjs   # 若临时脚本仍在
```

## 声明

本表没有重跑那 20 条模型调用：11-04 的数字作为「历史基线（1.12.2 之前构建）」保留；
1.12.3 的 after 全部是确定性判定回放（纯函数 / 本地 lib），不消耗模型额度。

## 口径差异（为什么这两列不能相加、不能算出「通过率提升」）

1. **被测对象不同**：11-04 的 before 是「20 条整会话任务 → 插件生成计划」的计划口径（capture 里的 outcome/planId/stages/departments）；本表 after 是**判定函数口径**（auditClarifyNeed / resolvePronounAntecedentInline / matchDepartmentKeywords 的返回）。
2. **构建不同**：before 由 1.12.2 之前的构建跑出（进程自报 version=1.12.2、buildHash=f4f349b6da0c4474，且新规则代码在提交 56e3aad 才出现）；after 来自 1.12.3 工作树。
3. **不可比结论**：因此**不能**把「before 4/20 通过」与「after 4/4 澄清命中」相减得到「通过率提升」。本表只逐条证明「这个缺陷的判定从此正确」，不给出新的 20 条通过率。新通过率需要用户提供模型额度后重跑 20 条才能得到。
4. **历史数字的用途**：11-04 的 4/20、46 次、25/29 等数字保留为历史基线原样引用，未按 after 重算、未修改。

