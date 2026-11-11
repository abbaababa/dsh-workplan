# dsh-workplan 2.5.0「要求2 推理等级自配置机制」发布收尾证据报告（release-250-self-effort-20261111）

- 执行人：版本发布部负责人 dept-release（Team Lead = lead）
- 仓库：/Users/open/Documents/Stocks/plugins/dsh-workplan（独立 git 仓库）
- 基线：HEAD = 9d13fa8「Release 2.5.0 …+G1回放消费端三字段透传修复；版本统一2.5.0；全量785/0/0」，盘点时工作树干净
- 版本口径：**保持 2.5.0 不变**（本轮为机制收尾 fix，不升版本号）
- 任务来源：lead 新任务令（约19:51）+ 两点裁决（约19:57）：① docs/cc 旧口径归机制部随代码同批同步，发布部 Phase B 不碰 docs/cc；② README 三语零改动批准（实测无机制句子），证据入报告，不新增简介句。
- 合规声明：全程未启用/安装/重启任何东西，未调用任何 dsh_workplan_* 工具；禁 push / npm publish / GitHub Release / release.sh。

## 1. 阶段A 只读盘点（已完成）

### 1.1 旧口径位置清单（grep 实测）

| 位置 | 旧口径摘录 | 归属/处置 |
|---|---|---|
| CHANGELOG.md:4 | 「下级未单独配档时继承整体等级（…整体也未配置则回落 low）」 | 发布部 Phase B 主改点（改写为自配置口径） |
| docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md:31 | delegate 行「未单独配档的下级继承它」+ effortOverride 全段 | 机制部随代码同批同步（lead 裁决①） |
| docs/cc/AVA-VULNERABILITY-ANALYSIS.md:124-132 | §10 等级约束 / taskReasoningEffort / effortOverride 描述 | 机制部随代码同批同步（lead 裁决①） |
| src/host.ts:806,836；src/llm-rules.ts:168,173；src/plan.ts:5391；src/runtime.ts:7225 | 提示词/工具描述中的整体等级+继承口径 | 机制部写范围 |
| tests/workplan-250-head-delegation.test.ts:55,173；tests/workplan-250-delegate-retry.test.ts:175-262 | 继承语义断言 | 机制部写范围（随新机制更新） |
| reports/ 历史证据（release-250-20261111.md、verify-250-mechanism-20261111.md、dsh-workplan-2.5.0-结果与问题说明.md 等） | 旧口径历史叙述 | 留档不改 |

### 1.2 README 三语零改动证据（lead 裁决②批准）

- 第一轮 grep `(?i)effort|inherit|overall|等级|推理`（README*.md）：仅命中 README.en.md:186「weighted overall figure」——进度条描述，与推理等级机制无关。
- 第二轮 grep `档位|配档|xhigh|reasoningEffort|taskReasoningEffort|effortOverride`（README*.md）：零命中。
- 结论：三语 README 无任何推理等级机制句子，「相应句子同步」的最小改动 = **零改动**；不新增简介句。

### 1.3 client.ts 看板等级渲染口径（只读，改由机制部）

- L231 / L458：locale 标签「推理等级」/「Reasoning effort」。
- L1756-1778：任务卡 Pill 按五档白名单（low/medium/high/xhigh/max）渲染 subtask.reasoningEffort；注释明确家族收窄发生在发送前（规划校验+派发入口），UI 不按家族删档。
- L1815-1829：第三层台账渲染 delegates 每位下级 member.effort，requested≠effort 时显示「越界钳制自 X」留痕；数据源为状态行 delegates（applyStatus 消毒 + durable 回放）。
- selfEffort 渲染尚不存在（全仓 grep selfEffort 零命中，盘点时机制未落码），待机制部新增。

## 2. 部门内再分配（用户要求1/2/3/4）

| 角色 | 模型/推理档 | 单一目标 | 单一产物 | 结论 | 负责人抽查复核 |
|---|---|---|---|---|---|
| expert | qw/qwen4-max-preview · medium | 文档口径审计+最小改动建议 | reports/audit-self-effort-docs-250.md | 清单完备：Phase B 发布部仅改 CHANGELOG.md 1–3 行（:4 整条重写，:3/:7 冻结后复核点）；README 双轮 grep 独立复核零改动；docs/cc 仅 ADV-FSP:31+AVA:124-132（归机制部）；补漏机制部范围 6 处；CHANGELOG:4 替换草稿已标注「须对照冻结代码核实、不得提前定稿」 | ✅ 负责人亲自抽查：补漏点 src/host.ts:850 实读确认含旧继承口径（盘点确漏、expert 属实）；报告 G1-G7 检索覆盖与分类抽核一致；草稿未定稿纪律正确 |
| member | qw/qwen4-max-preview · low | 发布前置清单核对 | reports/check-self-effort-list-250.md | PASS×6：版本各处2.5.0／基线9d13fa8且树净／旧口径仅CHANGELOG:4+ADV-FSP:31／README无机制句／selfEffort零命中／108个测试文件、上轮785/0/0 | ✅ 负责人亲自抽查：git log 实测 HEAD=9d13fa8c969410f915881699eecc8ebd7bfe9ab5 一致；工作树仅3份新报告无源码改动；ls tests/*.test.ts 实测=108 一致；版本读数与 9d13fa8 已验证状态一致 |

重试纪律：如重试必携带既有产物续做，不整步重跑。

## 3. 阶段B（机制部 20:16「已冻结」+ lead 启动令后执行）

### 3.0 冻结与启动时间线

- 20:07 lead 令预起草；20:13 机制部代码在盘（13 文件 +334/−25，含新增 tests/workplan-250-self-effort.test.ts）；20:14 lead 裁决 hold 到 20:15 硬门禁；20:16 dept-mechanism 发「已冻结」（定向 10 文件 88 例 pass 88/fail 0/cancelled 0，npm run check 与 tsc -p tsconfig.test.json 均通过；其证据报告 reports/verify-250-mechanism-20261111.md 20:16 补交）；lead 随即发启动令。
- 发布部预核实：草稿 v2（reports/draft-changelog-self-effort-250.md）8/8 项对照在盘代码实读完成（字段名/错误码全集/interruptByParent 两处/三层口径/delegateSelfEfforts 持久化链/:3/:7 复核/看板渲染/新增 9 例）；冻结时 git diff --stat 与 20:13 快照一致（13 文件 +334/−25），代码无冻结前最后改动。
- 20:22 首轮全量红（794/768/26/0，见 §3.4）→ lead 裁决：机制部解冻 tests/ 做两阶段契约适配（src 冻结不变），冻结前置升级为全量绿（§4 过程改进）。
- 20:40 dept-mechanism「已冻结·全量绿」：其自跑 npm test pass=794 fail=0 cancelled=0 exit=0（日志 /tmp/wp-full-run5.log）；适配方式=共享 helper + 16 文件预登记自配档，src 门禁零改动、断言意图零删改；src/tests/docs/cc 冻结。发布部接棒，独立重跑 npm test 作发布证据（双保险）。

### 3.1 CHANGELOG 2.5.0 条目自配置口径改写（已落盘）

- 改动前原文（CHANGELOG.md:4 要求2 bullet，逐字）：
  「- **负责人配置整体推理等级并全程贯穿（用户要求 2）**：`consolidation.taskReasoningEffort` 新字段——负责人按本任务复杂度配置整体等级，经五档白名单校验（非法拒绝 `DELEGATE_TASK_EFFORT_INVALID`）与模型家族集合钳制留痕后，写入状态行 `effortOverride`（applyStatus 消毒 + durable workplan-update 回放，刷新/重启不丢；尝试重置不清除——它是任务级配置不是尝试痕迹）。派发链每次激活（首发/重试/续跑）经新纯函数 `resolveTaskEffort` 单一判据读档：effortOverride 优先于规划器档位，缺失才回落默认。下级未单独配档时继承整体等级（旧默认无条件取家族最高档，简单任务烧最高档的问题一并修复；整体也未配置则回落 low）。」
- 改动后原文（逐字，与草稿 v2 一致，已对照冻结代码核实）：
  「- **三层执行者推理等级自配置（用户要求 2，机制升级）**：由「负责人配置整体等级、下级未单独配档时继承」升级为**先配置后开工、各自自配全程自用、平台强制接续**。① 先配置后开工（平台强制）：部门负责人与第三层专家/组员会话在未登记自配档时一律以 low 启动 phase-0——唯一职责是评估自身任务复杂度并提交自配；负责人经 `delegate(action="review")` 的 `consolidation.taskReasoningEffort` 提交（即负责人自配整体档），专家/组员经新增 `delegate(action="self_effort")` 提交（`reasoningEffort`+`complexityRationale` 必填：缺依据拒绝 `SELF_EFFORT_RATIONALE_MISSING`、非法档拒绝 `SELF_EFFORT_INVALID`、非第三层叶子拒绝 `SELF_EFFORT_NOT_LEAF`、已结算拒绝 `ALREADY_DONE`）；phase-0 结束仍未登记自配 ⇒ 明确 `SELF_EFFORT_MISSING` 回喂（有界重试），禁止静默以 low 档继续正式任务。② 自配为权威：成员自配档为权威，分工表 per-member 档降为建议；下级不再继承负责人整体档，各层自配全程自用。③ 平台强制接续：宿主在子会话创建时解析推理等级、同会话换档不可行，故登记后平台立即 `interruptByParent(continuable)` 中断 phase-0 回合，新激活携带 phase-0 产物与完整任务书、以自配档接续同一任务进入 phase-1（继续勿重做；childId 台账同步更新，旧结算回调按旧 childId 自动失配）；接续不是重试——不消耗 attempt 预算；接续失败重试 1 次仍败则明确报 `SELF_EFFORT_CONTINUATION_FAILED`，禁止静默降档；每次激活（首发/重试/续跑/中断后新激活）经 `resolveTaskEffort` 单一判据读档，自配档优先于规划器档位；尝试重置后 `delegateSelfEfforts` 保留，重派直接以已自配档接续 phase-1（不再 phase-0）。④ 持久化与回放：负责人自配写入状态行 `effortOverride`，成员自配写入 `delegates[].selfEffort`（越界钳制留痕 `selfEffortRequested`）与 `delegateSelfEfforts` 回落源，均经 applyStatus 五档白名单消毒（非法 `delegateSelfEfforts` 拒绝 `INVALID_DELEGATE_SELF_EFFORTS`）+ durable workplan-update 回放（写入与消费双侧接线，G1 教训），刷新/重启不丢；越界档按模型家族合法集合钳制并留痕，非法整体档仍拒绝 `DELEGATE_TASK_EFFORT_INVALID`。旧「下级未单独配档时继承整体等级、整体也未配置则回落 low」的继承回落口径废止；无新字段的旧计划回放零迁移。」
- CHANGELOG.md:7 最小追加：「要求2 自配置机制新增 `tests/workplan-250-self-effort.test.ts` 9 例回归；」（其余字句不动）。CHANGELOG.md:3 授权段名称经核实仍成立，零改动。
- 其余文件：README×3 零改动（裁决②）；docs/cc 机制部同批同步（裁决①，工作树已见其改动）；版本字面量不动（保持 2.5.0）。

### 3.2 tool-surface fixture 核定（lead 授权同批刷新 → 实测结论：零改动）

- lead 启动令授权刷新 tests/fixtures/tool-surface.json（delegate 参数面新增 self_effort/reasoningEffort/complexityRationale），要求先读消费测试与生成方式。
- 实读 tests/tool-surface-inventory.test.ts（72 行全文）：仅断言 ①工具名清单（正则抽取 name: 'dsh_workplan_*'）②HTTP 路由 ③生命周期事件 ④fixture.version == src meta.version。**不含任何参数面断言**（grep self_effort|reasoningEffort|complexityRationale|parameters|action 零命中）。
- fixture 为人工确认基线（$comment 明示「不是从代码生成再回填的自证」）；scripts/ 目录 glob 实测无 fixture 刷新脚本。
- 本轮工具名/路由/事件均未变（delegate 工具名不变、无新工具），版本保持 2.5.0 → fixture 四项断言全部天然成立，**零改动即正确**；参数面成文归属 docs/cc ADV-FSP（机制部已同批刷新）。向 fixture 添加参数字段反而违背其人工基线契约，不做。

### 3.3 构建

- npm run build：**exit 0**（独立执行一次 + npm test 首步再一次，均成功）；lib/ 与 client.js 再生；版本保持 2.5.0（本轮无版本字面量改动）。

### 3.4 全量回归（第一轮：红，机制类，已报 lead 待裁决）

- 命令：`npm run build && npm test`（job bash-35228a40d253450b）
- 结果：**tests 794 / pass 768 / fail 26 / cancelled 0 / skipped 0，exit 1**；汇总行原文 `[run-tests] pass=768 fail=26 cancelled=0 exit=1`；duration_ms 60459.7。
- 原始日志：/var/folders/6q/h_p7d91j4n16s2gnbq82lvs40000gn/T/dsh-subprocess-htVJ4E/dsh-subprocess-770-3-c428c2521bb3-stdout.log
- **根因诊断（机制类，非版本/fixture/文档）**：新 phase-0 门禁（src/runtime.ts:2069-2070：未登记自配档 ⇒ 首次激活一律 low 档 phase-0）拦截既有用例的「直接执行」模拟——首个结果被当作 phase-0 产物消费，未注册 effortOverride ⇒ SELF_EFFORT_MISSING 回喂/blocked。实证：workplan-evidence-missing-retry A3 失败的实际 prompt 即 phase-0 自配任务书；A4 实际错误文案为「phase-0 结束但未提交自配推理等级…」；多例 'blocked'!=='done'。机制部冻结前验证为定向 10 文件 88 例绿，未跑全量；其余派发链测试文件未适配两阶段契约。
- 26 例分布：interrupt-announce 1、notice-channel 1、plan 1、planner-effort-clamp 2、qa-time-mechanism-scenarios-t3「场景D」1、time-notice-immediate 1、workplan-auto-retry 1、workplan-budget-pause 5、workplan-comm-format-e2e 2、workplan-dispatch-modes 3、workplan-evidence-missing-retry 3、workplan-monotonicity 1、workplan-status-lock 1、workplan-stuck-recovery 1、workplan-unparsable-retry 2。（场景D 归属文件经机制部适配改动清单核实为 qa-time-mechanism-scenarios-t3.test.ts）
- 处置：按 lead 红线「机制类立即报我」于 20:22 回报 lead 并附完整清单与修复方向；发布部未动任何 src/tests（禁改令有效），未提交。lead 裁决：机制部解冻 tests/ 做两阶段契约适配（src 冻结不变），冻结前置升级为全量绿（§4）。

### 3.4b 全量回归（第二轮：发布部独立重跑，绿，发布证据）

- 前置：20:40 dept-mechanism「已冻结·全量绿」（其自跑 npm test pass=794 fail=0 cancelled=0 exit=0，日志 /tmp/wp-full-run5.log；适配=共享 helper + 16 文件预登记自配档，src 门禁零改动、断言意图零删改；src/tests/docs/cc 冻结）。
- 发布部独立重跑：`npm test`（job bash-f66f8643e9484340；首步即 npm run build，构建 exit 0，lib/ 与 client.js 再生）。
- 结果：**tests 794 / pass 794 / fail 0 / cancelled 0 / skipped 0 / todo 0，exit 0**（TAP 收尾 `1..794`；duration_ms 60460.8 ≈ 60.5 秒）。
- 汇总行原文：`[run-tests] pass=794 fail=0 cancelled=0 exit=0`。
- 首轮 26 例红全部转绿（输出抽查确认：evidence-missing A2/A3/A4、monotonicity G5-X1、status-lock STALE_WRITE、stuck-recovery、unparsable e2e×2、dispatch-modes×3 等均 ok）；零失败零取消，未掩盖未跳过任何测试。
- 原始日志：/var/folders/6q/h_p7d91j4n16s2gnbq82lvs40000gn/T/dsh-subprocess-htVJ4E/dsh-subprocess-770-4-59eeb3208ceb-stdout.log

### 3.5 本地新提交（在 9d13fa8 之上）

- 提交信息原文：`fix(2.5.0): 三层执行者推理等级自配置——先配置后开工、平台强制全程自用、selfEffort持久化；两阶段契约测试适配；全量794/0/0`
- commit hash：本报告与该提交同批入库，无法自含其 hash；以 `git log -1` 为准（新 hash 已在给 lead 的完成回报中单独给出）。
- 严禁项确认：未 push、未 npm publish、未建 GitHub Release、未运行 release.sh；插件全程未启用、未重启任何服务、未调用任何 dsh_workplan_* 工具。

## 4. 过程改进（lead 已采纳，20:25 裁决）

1. **冻结前置升级为「全量绿」**：本轮机制部冻结前验证为定向 10 文件 88 例绿 + tsc 通过，但全量 794 例出现 26 红——phase-0 门禁改变了派发链首次激活契约，约 15 个既有测试文件未适配。教训：**定向绿 ≠ 全量绿**；凡改变运行时行为的机制变更，冻结前置必须为全量 npm test 0 失败 0 取消（机制部自跑），发布部在冻结后独立重跑一次作发布证据（双保险）。
2. lead 已采纳并下发新冻结门禁：本轮机制部解冻 tests/ 做两阶段契约适配（src 冻结不变），自跑全量绿后方可发「全量绿已冻结」；发布部收到后独立重跑→补报告→git 新提交→回报。
3. 发布部纪律重申：红结果如实回报并附根因诊断与完整清单（本轮 26 例分布与证据已入 §3.4，lead 评定质量合格并入裁决依据）；不掩盖、不跳过、不越权改他人写范围；0 失败 0 取消才提交。