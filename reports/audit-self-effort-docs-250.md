# 要求2「推理等级自配置机制」发布收尾 · 文档口径审计与最小改动建议

- 审计人：版本发布部 expert（文档口径审计）
- 时间：2026-11-11（Asia/Shanghai）
- 仓库：/Users/open/Documents/Stocks/plugins/dsh-workplan
- 基线实测：`git log -1` = **9d13fa8**（Release 2.5.0 …全量785/0/0）；`git status --porcelain` 输出为空（工作树干净，本报告写入前）。版本保持 2.5.0 不变。
- 新机制落码状态实测：全仓 grep `selfEffort` → **零命中**（机制部尚未落码，与任务背景一致）。
- 本轮权限：除本报告外全程只读；未编辑任何源文件/文档，未运行 install/build/test，未做 git 写操作。

---

## 1. 独立复核方法与覆盖范围

实测执行的检索（grep 工具，非 shell）：

| # | 范围 | 模式 | 结果概要 |
|---|------|------|----------|
| G1 | 全仓 | `selfEffort` | 0 命中 |
| G2 | 全仓 *.md | `继承\|整体等级\|未单独配档\|effortOverride` | 39 命中（CHANGELOG / README 零 / docs/cc 2 文件 / reports 5 文件 / docs 其它 3 文件为无关语义） |
| G3 | README*.md | `(?i)effort\|inherit\|overall\|等级\|推理` | 仅 README.en.md:186 |
| G4 | README*.md | `档位\|配档\|xhigh\|reasoningEffort\|taskReasoningEffort\|effortOverride` | 0 命中 |
| G5 | docs/cc 全部文件 | `(?i)effort\|等级\|档位` | 11 命中：ADV-FSP:31、AVA:124/126/130/132 为相关；SECURITY-TARGET:23 与 CC-2026-ASSESSMENT:38/50/135/137 均为 CC 保证等级（EAL），与推理等级无关 |
| G6 | 全仓 *.md | `整体推理\|taskReasoningEffort\|resolveTaskEffort\|effortOverride` | 24 命中，全部落在 G2 已覆盖文件内，无新增文件 |
| G7 | 全仓 *.ts | `继承\|整体等级\|未单独配档` | 76 命中（src 4 文件 + tests 7 文件；其中大量为「规划器不继承主 Agent」「replace 继承旧行」等**无关旧语义**，见 §2.4 备注） |
| R1 | CHANGELOG.md:1-14 | read | 要求2 bullet 全文核实（见 §3） |
| R2 | src/llm-rules.ts:163-176 | read | 核实盘点所称 :168 行确为整体等级告知文案（见 §2.4） |

结论：负责人初步盘点**基本准确**，且本审计**补漏 6 处**（见 §2 加粗「补漏」标记）：src/host.ts:850、src/llm-rules.ts:197/251-253/278-280/321-322/375、src/plan.ts:4001-4002、src/runtime.ts:2054/4424/7186/7209/7231、tests 两文件的 :8/:10/:72/:206-228 等行、CHANGELOG:3 的间接关联短语。docs/cc 其它文件（SECURITY-TARGET、CC-2026-ASSESSMENT 等）经 G5 全量扫描**无**推理等级旧口径。

---

## 2. 分类清单表（file:line | 原文摘录 | 分类）

### 2.1 发布部 Phase B 改（本轮唯一写范围：CHANGELOG 2.5.0 条目）

| file:line | 原文摘录（节选） | 分类 |
|---|---|---|
| CHANGELOG.md:4 | 「**负责人配置整体推理等级并全程贯穿（用户要求 2）**：`consolidation.taskReasoningEffort` 新字段——负责人按本任务复杂度配置整体等级…下级未单独配档时继承整体等级（旧默认无条件取家族最高档…整体也未配置则回落 low）。」 | **发布部 Phase B 主改点**：整条 bullet 按新机制重写（草稿见 §3） |
| CHANGELOG.md:3 | 「并新增『本部门再分配权限与推理等级配置』授权段」 | 发布部 Phase B **复核点（预期零改动）**：短语「推理等级配置」为泛指，新机制下仍成立；冻结后若授权段名称变更再同步 |
| CHANGELOG.md:7 | 「新增 `tests/workplan-250-head-delegation.test.ts` 回归；既有字段与校验原样，旧计划零迁移。」 | 发布部 Phase B **复核点**：机制部冻结后若新增/改名测试或「既有字段原样」不再成立（selfEffort 新字段、旧 effortOverride 数据迁移口径），须对照冻结代码微调本行；仍在 CHANGELOG 单文件内 |

CHANGELOG 其余命中（:206、:228、:314、:324、:338、:365、:378、:962、:2790）均属 **2.3.x 及更早历史版本条目**（规划器停止继承、replan 继承旧行、paused 回放等），与要求2 新机制无关或属历史事实 → **历史留档，保留不改**。

### 2.2 README 三语零改动判定

| file:line | 原文摘录 | 分类 |
|---|---|---|
| README.en.md:186 | 「"Step progress": one row per stage … plus a weighted overall figure」 | **无关命中**：进度条加权总进度描述，与推理等级无关 |
| README.md / README.zh.md | （两轮 grep 均 0 命中） | **README 零改动判定**（最终判定见 §4） |

### 2.3 docs/cc 待指派（发布部本轮无权改，需 lead 指派归属）

| file:line | 原文摘录（节选） | 分类 |
|---|---|---|
| docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md:31 | 「…合法则钳制后写入状态行 `effortOverride`（五档白名单消毒 + durable 回放 + 尝试重置不清除），派发链每次激活经 `resolveTaskEffort` 优先读它，**未单独配档的下级继承它**…」 | **docs/cc 待指派**：delegate 工具行的等级链路整段需按 selfEffort 新机制重写（含「先配置后开工」门禁、三层自配） |
| docs/cc/AVA-VULNERABILITY-ANALYSIS.md:124 | 「## 10. v2.3.9 攻击面增量（模型家族推理等级约束与第三层派发）」 | docs/cc 待指派：节标题本身可保留（历史增量），但节内现势描述需更新或增补新机制攻击面 |
| docs/cc/AVA-VULNERABILITY-ANALYSIS.md:126 | 「…把『按模型家族限定推理等级』从提示词约定改为服务端强制」 | docs/cc 待指派复核：家族钳制若保留则本句仍真，冻结后核实 |
| docs/cc/AVA-VULNERABILITY-ANALYSIS.md:130 | 「…经 `taskReasoningEffort`/`effortOverride` 注入非法档位…`effortOverride` 经 `applyStatus` 五档白名单消毒…派发链经 `resolveTaskEffort` 单一判据读档…」 | **docs/cc 待指派**：AS-13 行的字段名/消毒/读档链路需按 selfEffort 重写，并补「未配置先开工」攻击路径与对策 |
| docs/cc/AVA-VULNERABILITY-ANALYSIS.md:132 | 「等级约束侧…`src/llm-rules.ts` 是要求 1/2 的唯一事实源…按强度序钳制并 `console.warn` 留痕…」 | docs/cc 待指派复核：钳制留痕若保留则大体仍真；「唯一事实源」表述冻结后核实 |

docs/cc 其它文件（G5 全量扫描）：SECURITY-TARGET.md:23、CC-2026-ASSESSMENT.md:38/50/135/137 的「等级」均指 **CC/EAL 保证等级**，与推理等级无关 → 不改。**docs/cc 无其它遗漏。**

### 2.4 机制部范围（src/、tests/；发布部只记录，不动）

| file:line | 原文摘录（节选） | 分类 |
|---|---|---|
| src/host.ts:806 | 「并可用 consolidation.taskReasoningEffort 为整个任务配置整体推理等级，配置后本任务重试/续跑与未单独配档的下级全程沿用」 | 机制部范围（工具描述） |
| src/host.ts:836 | 「可选：负责人为整个任务配置的整体推理等级…未单独配档的下级继承该档；越界档被平台钳制并留痕。」 | 机制部范围（schema 描述） |
| **src/host.ts:850（补漏）** | 「缺失时继承负责人配置的整体任务等级（taskReasoningEffort），整体也未配置则回落 low。」 | 机制部范围（assignments 子字段描述，盘点漏列） |
| src/llm-rules.ts:168 | 「部门负责人已为本任务配置整体推理等级 `${info.taskEffort}`（effortOverride）：…全体下级默认档全程沿用该等级，不得中途丢弃或覆盖。」 | 机制部范围（read 实测核实 :168 确为此文案） |
| src/llm-rules.ts:173 | 「…并在 consolidation.taskReasoningEffort 里按本任务复杂度配置整体推理等级…**未单独配置时继承整体等级**，全程应用…」 | 机制部范围（部门负责人强制流程文案） |
| **src/llm-rules.ts:197、251-253、278-280、321-322、375（补漏）** | 「下级未单独配置档位时也继承它」「taskEffortFallback…回落源」「继承负责人为整个任务配置的整体等级（taskEffort）…回落 low」「读取推理等级的唯一入口…effortOverride」 | 机制部范围（注释 + resolveTaskEffort/taskEffortFallback 实现，新机制下整链重写） |
| **src/plan.ts:4001-4002（补漏）** | 「缺失档位须保持缺失，才能继承负责人配置的整体任务等级（taskReasoningEffort）。旧默认 'low' 会截断继承链。」 | 机制部范围（applyStatus 注释） |
| src/plan.ts:5391 | 「在 consolidation.taskReasoningEffort 里按本任务复杂度配置整体推理等级…全体未单独配档的下级全程沿用…」 | 机制部范围（负责人任务书授权段） |
| **src/runtime.ts:2054、4424、7186、7209、7231（补漏）** | 「配置的整体等级（状态行 effortOverride…）优先于」「刷新/重启后整体等级丢失」「重新 review 未再配整体等级时，继承行上已持久化的」「负责人配置的整体等级写入状态行」「dispatch 读回梳理产物时，整体等级缺失同样回落行上」 | 机制部范围（激活读档/回放/回落注释与实现） |
| src/runtime.ts:7225 | 「整体任务等级已配置为 ${preview.taskEffort}，本任务重试/续跑与未单独配档的下级全程沿用。…未配置整体任务等级…下级未配档时回落 low。」 | 机制部范围（review 结果消息文案） |
| tests/workplan-250-head-delegation.test.ts:8、55、72、173 | 「下级未配档时继承它」「要求2：下级未单独配档时继承整体等级…」「非法整体等级明确拒绝」「端到端：review 配置整体等级 → effortOverride → dispatch 下级继承」 | 机制部范围（:72 非法拒绝语义若保留可复用，其余按新机制改写） |
| tests/workplan-250-delegate-retry.test.ts:10、173、175-228 | 「重置后…不丢已持久化的整体等级 effortOverride」「taskEffortFallback——梳理未带整体等级时继承行上 effortOverride」「必须继承 effortOverride」「沿用整体等级」 | 机制部范围（R2×R4 回落继承用例整组按 selfEffort 持久化口径改写） |

**无关语义备注（不改）**：G7 其余命中——src/plan.ts:203/847/1535/1547、src/replan.ts:197-276、src/runtime.ts:257-258/811/971/1156/2167-2172/6403、src/host.ts:456/459、tests/planner-salvage.test.ts、tests/reasoning-effort.test.ts、tests/workplan-budget-pause.test.ts:341、tests/runtime-replay.test.ts:269——均为「规划器/子 Agent **禁止**继承主 Agent 档位」「replace 继承旧行」「reason 字段继承」「paused/完成数不继承」等**既有且与新机制不冲突**的语义，机制部冻结时仅需确认不被误伤，非旧口径清理对象。docs/t8-fix-prioritization.md:75/78、docs/t4-contrast-measurement.md:147、docs/stuck-review-1.3.0.md:401/419/591 的「继承」为 CSS 颜色/暂停回放语义 → 无关，不改。

### 2.5 历史留档（reports/，保留不改）

| file:line | 原文摘录（节选） | 分类 |
|---|---|---|
| reports/verify-250-mechanism-20261111.md:19/31/34/37-45/66/86-87 | 「R2 整体推理等级全程贯穿…继承回落…taskEffortFallback…effortOverride 三字段透传」 | 历史留档（当时机制验证证据，如实反映当时代码） |
| reports/release-250-20261111.md:81/88 | 「G1 修复与重跑…effortOverride/consolidation/delegates…785/0/0」 | 历史留档（发布记录） |
| reports/dsh-workplan-2.5.0-结果与问题说明.md:12-15/26/28/41-44 | 「专家/组员没单独配档时继承整体等级…整体也没配则回落 low」 | 历史留档（2.5.0 首发说明） |
| reports/T3-llm-effort-constraints-v239.md:60、reports/T2-dispatch-archaeology-v239.md:34/38 | 「防继承契约不变」「未点名档位会继承父档位」 | 历史留档（2.3.9 考古/约束报告） |

---

## 3. CHANGELOG.md:4 最小改动替换文案（草稿）

> **⚠️ 草稿——Phase B 须对照机制部冻结后的实际代码逐项核实措辞，不得提前定稿。**
> 下文方括号【】内均为待冻结代码确认项：selfEffort 字段名与挂载位置、先配置后开工的门禁/错误码名、三层各自档位字段是否沿用 consolidation.taskReasoningEffort 与 assignments[].reasoningEffort、旧 effortOverride 数据的兼容/迁移口径、五档白名单与家族钳制是否原样保留。机制部当前全仓 selfEffort 零命中（G1 实测），任何字段名/错误码现在都不可视为已定。

**替换草案（整条 bullet 重写，保留还正确的机制骨架）：**

> - **三层执行者推理等级自配置（用户要求 2，机制升级）**：由「负责人配置整体等级、下级未单独配档时继承」升级为**三层各自自配、全程自用**——主 Agent、部门负责人、第三层专家/组员均须**先配置后开工**：开工前按自身任务复杂度配置本人推理等级【门禁与错误码以冻结代码为准】，未配置不得开工；三层等级互不继承、互不覆盖，各自全程自用。**平台强制接续**：重试/续跑/重新派发每次激活均沿用本人已配置等级，不得中途丢弃或被他人覆盖；等级以 `selfEffort` 持久化【字段与写入位置待冻结确认】，经 durable 回放刷新/重启不丢【回放链路待冻结确认】。五档白名单校验（非法明确拒绝）、模型家族集合钳制并留痕、状态行消毒等防线沿用【逐项以冻结代码为准】；旧「整体也未配置则回落 low」的继承回落口径废止【旧 effortOverride 数据兼容口径待冻结确认】。

**是否另加一条简短 bullet 的判断：不需要。** 理由：要求2 的全部用户可见变化（先配置后开工、三层自配、强制接续、selfEffort 持久化）可在原 bullet 一条内容纳，另加会重复口径、扩大改动面，违背最小改动原则。仅当冻结后出现**新的独立用户可见面**（如新增工具参数或新错误码需要单独向用户交代）时，才考虑追加一条 ≤1 行的短 bullet——该判断留待 Phase B 对照冻结代码做出。同时 Phase B 须顺带复核同条目 :3（授权段名称）与 :7（测试文件名/「既有字段原样」表述）是否需微调（见 §2.1）。

---

## 4. README 三语最终判定：**无相应句子，零改动**

- 实测 G3（`(?i)effort|inherit|overall|等级|推理`，覆盖 README.md / README.en.md / README.zh.md）：**仅 1 命中** = README.en.md:186「…plus a weighted overall figure」，为看板展开面板**进度条加权总进度**描述，与推理等级机制无关。
- 实测 G4（`档位|配档|xhigh|reasoningEffort|taskReasoningEffort|effortOverride`，同覆盖三语）：**0 命中**。
- 最终判定：三语 README **不存在任何推理等级机制句子**，「相应句子同步」= **零改动**。负责人初步结论经独立双轮 grep 复核成立。Phase B 无需触碰 README 三语（含徽章/安装行——版本号保持 2.5.0 不变，亦无版本改动需求）。

---

## 5. 末尾结论

**清单完备性**：以 G1-G7 七轮检索 + 两处定点 read 覆盖全仓 *.md（含 CHANGELOG 全文 2908 行经两轮模式交叉扫描）、docs/cc 全部文件、src/ 与 tests/ 全部 *.ts、reports/ 与 docs/ 历史文档；负责人盘点全部核实，另补漏 6 处（均在机制部写范围内，已记录于 §2.4）；docs/cc 除 ADV-FSP:31 与 AVA:124-132 外无其它旧口径；未发现盘点之外的发布部写范围内新改点（CHANGELOG:3/:7 为复核点而非确定改点）。本清单在「旧口径关键词」维度完备；机制部冻结后若引入全新术语（selfEffort 等），Phase B 须以冻结代码为准做增量核对。

**Phase B 发布部实际需改动预估**：
- **确定改动：1 个文件、1 行**——CHANGELOG.md:4 整条 bullet 重写（该行现为 1 个长行，重写后仍为 1 行）。
- **条件改动：0–2 行**——CHANGELOG.md:7（测试名/字段原样表述，视冻结结果）；另加短 bullet 判断为「不需要」（§3），仅冻结出现新独立用户可见面时 +1 行。
- **README.md / README.en.md / README.zh.md：0 文件 0 行**（§4 判定）。
- **合计数：1 个文件（CHANGELOG.md），1–3 行。** docs/cc 2 文件（ADV-FSP:31 一行、AVA §10 约 3-5 行）需 lead 指派归属后另行处理，不计入发布部本轮；src/tests 归机制部；reports/ 历史留档一律不动。

（完）
