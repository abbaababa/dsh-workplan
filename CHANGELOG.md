## 3.2.7 — 2026-11-25（全量审计：53 条矛盾/冲突/重叠/不合理，逐条治本）

> 6 个只读子代理逐行通读 24 个源文件（38,362 行），用 file:line 取证出 53 条问题。本版修掉其中可安全落地的部分，其余 3 条（推理档位降级、`originalRequest` 自比、时钟抖动）在文末如实说明处理方式。

### 一、会直接多花钱的

- **专家预算写进规划器**：规划器以前不知道「全计划专家上限 30 人」，而 15 个子任务 × 下限 3 人 = 45 人，后半段派发必被 `DELEGATE_PLAN_EXPERTS_EXCEEDED` 整单拒绝（前面的钱全白花）。现在提示词直接给出该预算与「阶段数 × 每阶段人数 ≤ 30」的算法。
- **单阶段计划豁免说清楚**：负责人简报以前只说「少于 3 人硬性阻断」，代码却对单阶段计划自动豁免，负责人为凑人数拆出无意义的独立专家会话。现在简报同步写明豁免。
- **`departmentRationale` 不再要求「语义一致」**：平台只做长度截断、不做语义校验，旧文案让模型每轮白写约 9,000 字。
- **自动续跑真的能关**：`autoResumeMaxAttempts` 以前拒绝 `0`，写 0 会被丢弃并回落默认值——想关的人反而得到数轮续跑。现在 0 就是关。
- **`step-budget` 口径对齐**：注释写「null = 关闭（默认）」，真实默认是 60 步；关闭值补上 `no`（与 auto-resume 同口径）。
- **停滞通知不再误导**：通知里硬写的「120 秒」改为跟真实阈值（600 秒）联动，否则负责人会提前重派，同一专家白跑两遍。

### 二、会卡死 / 白干一轮的

- **专家结算真正校验五步**：新增 `validateLeafExecutionEvidence()`。以前专家只要交 `status:"done"` + 汇报格式合规就记完成，第四步执行与验证、复盘可以整块空着——五步契约在第三层完全落空。
- **交接标记不再永久挂起**：`continuationPending` 以前只要落在 durable 就永远跳过判死，进程重启后内存表已空，该成员既不判失败也不发通知，负责人无限等。现在必须确有本进程的后台接续在等。
- **`escalate` 不再回退并发结算**：请示消息 await 期间别的成员已判完成，旧实现用旧快照整表写回，done 被回退成 running → 重派 → 同一专家跑两遍。现在读当下台账、只补丁请示成员。
- **并发派发不再留孤儿会话**：同 tick 两批 dispatch 会给同一成员起两个会话；多起的那个旧实现只是不覆盖台账，会话照跑照烧钱、结算时又找不到行。现在就地回收。
- **`self_effort` 直接路径同样回收**：旧实现只在后台路径判空，直接路径照样返回「已启动」。
- **部门汇总 `sources` 改精确匹配**：旧实现用子串，`W1` 被 `W10` 顶替，漏汇总的专家判通过。
- **`allPassed` 用验收表复核**：模型在 `verification` 写 `allPassed:true`、验收表却留着 `unverified` 时，旧实现照样放过。
- **6000 字上限补上 `checks` 与复盘**：这两块以前能整块绕开上限。
- **一次 replan 只开一个追加阶段**：旧实现每加 1 条就新开 1 个阶段，批量 5 条撞 `MAX_STAGES` 被整单拒。
- **`replan` 的 `dependsOn` 上限 12 → 16**，与 `plan.ts` 同源。
- **`hold` 在自动派发下可用**：旧实现只要 `dispatchedAt` 存在就拒，而自动派发会立刻写它——闸门在它声明要解决的场景里必然失败。现在只有「真的有东西开跑」才拒。
- **已重规划的死行不再算已定义子任务**（迁移分母不再被撑大）。
- **`sources` / `keywords` / 并列词**：规划器现在能看到部门覆盖判定用的关键词，不必被 COVERAGE 拒了再重试。

### 三、口径不一致（模型被误导）

- `meta.version` 直接取 `PLUGIN_VERSION`（单一来源，不再两处硬编码）。
- `dsh_workplan_instruct` 的 `subtaskId` 不再强制必填（运行时本来就允许省略）。
- `release` 的 `mode` 枚举统一为 `wait/async`（原来与 `dispatch` 各一套）。
- `handoff.department` 改为部门闭集枚举。
- 主提示词的并列词表补齐为 9 个，并注明「合并/并发/并行」不算并列词。
- 极简任务闸门删除裸「并」，改为只在连词位置命中（`合并登录模块的重复代码` 不再被误拒）。
- 理解层 `C1`：短回复「同意…」在上文已给出问题时不再被反问，reason 文案与真实原因一致。
- 理解层 `C3`：中文标的名（如「预测贵州茅台下月的走势」）不再被判「没有标的」。
- 理解层 `/\s/` 笔误修好（原写成 `/s/`，字母 s 被当空格）。
- 质量要求门禁的根因修在**提示词**：`qualityRequirements` 现在是规划器的强制字段，不再出现「创建通过、派发才拒、还得 replan」。
- 规划器审计改到 `originalRequest` 回填**之前**执行，不再拿用户原文比用户原文（覆盖率永远 100% 的老问题）。
- 面板：`{ok:false}` 的工具结果显示为失败（不再显示绿色「做好了」）；已完成的子任务不再提示「先等前面的工作做完」。
- `notice` 台账裁剪最旧行时写出告警（不再静默丢审计行）。
- `watchdog` 文档改为如实说明「生产调用点只观测、不执法，停滞由 `markStalledDelegates` 收敛」。

### 四、如实说明的三条

1. **非 qwen 家族 `medium` 仍降到 `low`**：这是 `correctEffortForModel` 的既有降级规则（越界档按强度序就近降级），有测试锁定。本版只把规则写进推理规则文案（2.1 条），让模型别再写越界档，**不改成升档**（升档会增加费用）。
2. **`criterion` 时钟抖动洗成 0**：测试明确断言「时钟抖动不为负 ⇒ 0」，是有意契约，审计判据有误，不改。
3. **修复底稿 24,000 字阈值**：这是刻意的费用取舍（超长底稿不整份重发），非缺陷。

## 3.2.6 — 2026-11-24（费用治本：人数下限、假死误杀、专家开工评估回合）

> **背景（实测，非估算）**：会话 `session-da5b9915-9fcb-4d90-8948-72f7c2c04316`（计划 `wp-2b766146-c360-4644-b677-38c652fa13e2`）在 59 分钟内开了 **32 个会话**（1 主 + 31 子）、**846 次模型调用**、978 次工具调用，累计重发上下文约 **218 MB**（按 2.6 字节/token 折算约 8,000 万输入 token），最终因 `402 Insufficient Balance` 中断，交付物未生成。3.2.3–3.2.5 的省 token 全部是提示词字面量削减（根工具面 −476 字符、phase-1 简报 −115 字符、重复自查句 −48 字符），相对该账单差三个数量级。本版改为动**结构性根因**，不再抠字。

### 一、复杂任务人数下限 8 → 3（费用第一主因）

- `src/caps.ts`：`MIN_COMPLEX_DELEGATE_MEMBERS` 默认 **8 → 3**（`DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS` 可覆盖）。每个成员都是一次独立计费会话；实测该计划仅 T3 一个子任务就开了 **18 个会话**（2 负责人 + 16 专家）、**541 步 = 全计划 64%**。人手应按活儿定，不该按"下限"定。
- `MAX_TOTAL_EXPERTS_PER_PLAN` 默认 **40 → 30**：压到 12 会把「5 阶段 × 3 人 = 15」这种正常计划整单拒绝，属 3.0.6 部门汇总死锁同类错误。
- `MAX_COMPLEX_DELEGATE_MEMBERS` **维持 25**：下限才是费用主因；降上限只会把合法的 7–25 人分工表从"允许"变成"禁止"。
- 闸门代码与错误码（`DELEGATE_HEADCOUNT_MIN`）不变，只改默认值与文案。

### 二、假死误杀治本（重复劳动的来源）

- 实测：T3 第一波 7 名专家（64 步）在派发 **226 秒**后被判「子会话已消失超过 120s 且无结束快照」，7 个会话随即被 `turn/end reason {kind:"aborted", reason:{kind:"parent"}}` 掐断——而它们在被判死后**仍继续写会话记录最长 40 秒**（即当时还活着）；随后平台又开 9 个专家会话重跑 **393 步**。
- `DELEGATE_STALL_MS` 默认 **120s → 600s**（`DSH_WORKPLAN_DELEGATE_STALL_SECONDS` 可覆盖，下限 60s）。
- `markStalledDelegates` 增加**正向存活证据**：`getAgent(childId)` 取到活体执行体即绝不判死；取不到（抛错/未知）一律不动，不把"查不到"当"已死亡"。
- 停滞后错误文案抽成 `delegateStalledReason()` 统一渲染，报出实际阈值。

### 三、负责人预登记默认开（每个专家省一整次会话）

- `leaderPreRegisterEnabled()` 默认 **false → true**（`DSH_WORKPLAN_LEADER_PRE_REGISTER=0/false/off` 关闭）；判定实现迁到 `src/caps.ts` 单一来源，`src/runtime.ts` 只做转调，避免两处判定分叉。
- 负责人在该开关打开时，任务书追加一句预登记说明（`src/llm-rules.ts`）：成员条目随附 `startPhases` + `timeNotice`，成员免跑 phase-0 评估回合、直接进执行段。
- 语义仍 **fail-open**：负责人没填、填错或字数不足 ⇒ 该成员照旧走 phase-0，不新增拒因；平台侧消毒与字数闸零改动。
- 依据：实测 7 对「评估会话 + 执行会话」中，评估段 **111/382 步（29%）**，而评估会话由模型自己产出的可交付文件为 **0 个**，唯一产物是平台生成的开工证据（7 份合计 47,767 字节，平均 6.8KB）；执行会话看不到评估会话的探索过程，只能重做（T1 同一批行情 URL 被两段各抓一遍）。

### 四、验证与版本

- `npm run build` 通过；`npm test`：**1513 例，pass=1513 / fail=0 / cancelled=0 / todo=1，exit=0**。
- 同步更新的守门测试：`tests/token-economy-324.test.ts`（人数下限、预登记默认开）、`tests/workplan-254-min-headcount.test.ts`、`tests/workplan-254-t3-deep-gate.test.ts`、`tests/workplan-low-delegation-gate.test.ts`、`tests/workplan-318-t2-defects.test.ts`（600s 阈值与 `630_000` 偏移）。
- 版本统一 **3.2.6**：`package.json` / `package-lock.json`（两处）/ `PLUGIN_VERSION` / `meta.version` / 三份 README / `tests/fixtures/tool-surface.json`。
- 运行中的 DSH 不会自动加载新代码：请**手动重启 DSH**（或在插件管理里禁用再启用）。重启后在新会话调用 `dsh_workplan_status` 应显示 `v3.2.6`。
- 回退开关（环境变量）：`DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS=8`、`DSH_WORKPLAN_DELEGATE_STALL_SECONDS=120`、`DSH_WORKPLAN_LEADER_PRE_REGISTER=0`。

## 3.2.5 — 2026-11-24（注意力红线对齐：唯一信息零丢失，只删重复/死代码/不可见面）

> **发布范围说明（事实，不修饰）**：3.2.3、3.2.4 从未单独提交或发布过——远端 tag 止于 `v3.2.2`，npm `latest` 为 `3.2.2`，仓库内也没有这两个版本的提交。它们的全部改动只以未提交工作区的形式存在，并与 3.2.5 的改动混在同一批文件里；在不编造历史的前提下无法重建。按用户 2026-11-24 的裁决（A 方案），本版一次性发布 3.2.3 + 3.2.4 + 3.2.5 的全部内容，版本号统一 **3.2.5**；下文 3.2.3/3.2.4 章节保留为开发记录。

### 一、红线（用户 2026-11-24 定死，写入守门测试）

- 所有子任务执行自己的任务全过程**禁止注意力丢失**：凡属「唯一信息」的内容一律不删。最近对话背景、pending 兄弟目标曾按省 token 删除，已全部回滚。
- 只允许三类删除：①同一 prompt 内逐字重复；②永不执行的死代码；③模型根本看不到的界面/磁盘内容。相位性文案（phase-0 残留）与矛盾句不属唯一信息，删除后由接续块保留事实。
- 新增 `tests/attention-red-line.test.ts`（4 例）钉住四条不变式：背景仍注入、pending 目标仍可见、完整自查句只留一份且提交位置有短提醒、phase-1 不带 phase-0 过时流程而 phase-0 仍完整。任何后续省 token 改动违反其一即测试失败。

### 二、省 token 与一致性收口（P0 批；语义门禁不变）

**用户 2026-11-24 红线：所有子任务执行自己的任务全过程禁止注意力丢失。** 凡属「唯一信息」的删减一律回滚（最近对话背景、pending 兄弟目标）；只保留三类删除：①同一 prompt 内逐字重复；②永不执行的死代码；③模型根本看不到的界面/磁盘内容。相位性文案（phase-0 残留）与矛盾句不属唯一信息，删除后由接续块保留事实。

- `dsh_workplan_update` 的 schema 移除 `extendMs` 与 `criterionApproval`：生产路径里 `criterionV2Active()` 恒为 false，延期事务与判据 v2 批准闸都不可达，`extendMs` 一律返回 `TIME_LIMITS_DISABLED`。根工具面因此 **10,098→9,622 字符（−476/次请求）**，也不再诱导模型调用一次注定被拒的工具；runtime 保留旧字段兼容读取（旧日志/旧客户端与既有测试不受影响）。
- phase-1 规则简报不再重述 phase-0 的「必须先完成前三步 / phase-0 low 启动」：旧文案与接续块「前三步已完成，不要重做」正面冲突，还让每次 phase-1 激活重付一遍（−115 字符/本）；`buildLlmRulesBrief` 新增 `phase1` 开关，派发侧传 `phaseZeroCompleted`。
- 负责人任务书删掉重复的 66 字《提交前自查》副本（同一句逐字出现两遍不增加约束），并在结果模板后补一句 **19 字**短提醒「提交前再对照上方 F1–F11 自查一遍」——重复副本删除不丢信息，但「提交前」这个位置有近期效应，用三成成本把该位置的注意力补回来（净 −48 字符/本）。
- 【已按红线回滚】自包含任务的 1,200 字「最近对话背景」曾整块省略（−1,191 字符/本），但「自包含」只是词面推断：任务里没写「它」，用户却可能在上文刚改过要求。唯一信息删除即注意力丢失，现恢复为「自包含也保留最近 1,200 字，探测到指代才放 7,000 字」。
- 【已按红线回滚】pending 兄弟的 60 字目标曾省掉（约 −64 字符/个），但目标属唯一信息：它决定执行者要不要等这个兄弟、会不会和它重复采集同一批输入。现恢复为与其他状态同一行格式；`tests/sibling-visibility.test.ts` 的产物可见性契约不受影响。
- 规划器修复重试的底稿加上限：`lastText` 超过 24,000 字时不再原样重发整份底稿，改为「完整规则 + 错误清单」重新生成（校验上限 6 万字，最坏每次重试省最多 6 万输入字符）；底稿正常大小时仍走短修复，避免模型凭空补出不存在的子任务。
- `scripts/measure-injection.mjs` 重写为按真实角色集合测量：导出 `createFollowupTool` / `createHoldTool` / `createReleaseTool`，用生产同一个 `workplanToolAdmitted()` 求可见面（**根 11 / 负责人 4 / 专家 3，共 14**），不再把根会话看不到的 delegate/verify/escalate 算进基线，也不再漏掉 hold/release/followup；同时把计划夹具换成 15 子任务、真实规则简报、1,200 字背景与兄弟状态。旧口径 15,080（11 份、含根不可见 3 份）由此作废。
- 文档更正（README.md / README.zh.md / README.en.md）：14 个工具与角色可见性、`hold`/`release`/`followup` 补齐、自动续跑（`DSH_WORKPLAN_AUTO_RESUME_MAX`）与手动续跑（`DSH_WORKPLAN_MAX_RESUMES`）拆成两行、回合收尾等待默认无限（可显式配毫秒）、教训注入 6 条 / 2200 字、隐私段补上项目目录 `reports/` 的两类写入并更正 grep 自检。
- 本批红线回滚后的实测（新测量脚本、确定性 15 子任务夹具）：负责人任务书 **12,797 字符**、phase-1 接续 **11,524 字符**、根工具面 **9,622 字符**（直接测量）。
  同夹具旧口径为推算值（新值 + 逐项已单独验证的删减量，−19 字新提醒已扣除）：负责人 12,845（+67 重复自查，−48，−0.4%）、phase-1 11,687（再 +115 phase-0 残留文案，−163，−1.4%）、根工具面 10,098（+476 已删 schema，−4.7%）。子 Agent 工具面（负责人 7,389 / 专家 6,886）本批未动。
  说明：早前草稿里的「13,088 / 11,930」把 pending 目标按 7 行估算（实际夹具约 3 行），属推算误差，已按实测差值更正；这项回滚后本批在子任务书上的净收益很小（仅重复自查），这是红线的必然代价。
- 测试：`tests/time-extension-transaction.test.ts` 的 schema 用例改为断言两个已停用字段不再宣告、`timeNotice` 仍保留；全套 **1514 例，pass=1513 / fail=0 / cancelled=0 / todo=1，exit=0**。


### 三、验证

- `npm run build`（含 tsc）通过；`npm test`：**1514 例，pass=1513 / fail=0 / cancelled=0 / todo=1，exit=0**（含新增红线守门 4 例）。
- CI：首次 tag 跑在 Node 22 上暴露一处测试嵌套问题（`tests/workplan-unparsable-retry.test.ts` 的两个子测试写在父用例回调里，Node 22 会取消未 await 的子测试），已把它们提升为顶层用例；修复提交 `226b367` 后，tag 运行 `45334519374` 的 Build/Test（Node 22 与 26）与 Release 全部 success。
- 终态实测（`node scripts/measure-injection.mjs`，字符数非账单 token）：根工具面 **9,622**（11 个工具，删除 2 个已停用参数后 −476）、负责人任务书 **12,797**、phase-1 接续 **11,524**、专家任务书 **4,813**、PROMPT_SECTION **3,663**、规划器提示词 **5,757**、加权样例 **107,092**。
- 版本统一 **3.2.5**：`package.json` / `package-lock.json`（两处）/ `PLUGIN_VERSION` / `meta.version` / 三份 README 徽章与安装命令 / `tests/fixtures/tool-surface.json`。
- 运行中的 DSH 由用户手动重启后生效；发布制品以 GitHub Release 与 npm registry 登记为准。

## 3.2.4 — 2026-11-23（档位安全治本 + 输入/输出 token 续省；用户裁决「全部按建议执行」当日第二批）

基线 3.2.3。本版两条主线：①推理档位链路治本——把「档位真发到模型、且真的被接受」从"按模型名猜"升级为"按宿主声明清单钳制"，专家路径补齐最后两道闸；②在 3.2.3 基础上继续压缩输入/输出计费面，所有改动经同一套回归测试复核（新增 9 例守门）。

### 一、推理档位安全（治本，不再有"发了但被拒"）

- 专家接续（phase-1，W3）与专家派发（phase-0/自配接续，W4）补宿主能力钳制：旧实现只按模型名做静态家族修正，档位不在模型声明清单时宿主在首次请求前即抛 `UNSUPPORTED_REASONING_EFFORT`（终态，重试不自愈），专家正式执行整段失败；现在与规划器/部门负责人同闸——发送前用 `llm.resolveModelInfo` 读目标模型**实际声明**的档位清单（`resolveSupportedEfforts`），清单内等效钳制；模型无 reasoning 元数据（空清单）⇒ 不发送档位字段。修复默认模型 `tx/minimax-m3`（无推理元数据）上专家必然失败的问题。台账/提示词保留「成员自配档」原值，实际发送用钳制值，不一致时 console.warn 留痕并在接续提示词如实告知。
- `supportedEffortsCache` 加 30 分钟 TTL 与 128 条容量上限：旧实现按 `${provider}/${model}` 永久缓存，模型改档后进程不重启就永远拿旧清单；现在过期重查、超限淘汰最旧，查询失败依旧不缓存不阻断。
- 规划器未知模型兜底：模型名不在静态白名单且旋钮未设时，兜底从裸发 `max` 改为「不发送档位字段」——`max` 兜底只在能力查询同时失败时才裸发，而 qwen4-max 等模型不支持 max，一次规划即被终态拒绝。`DSH_WORKPLAN_PLANNER_REASONING_EFFORT` 显式旋钮不受影响；`DEFAULT_PLANNER_REASONING_EFFORT='max'` 常量保留导出但不再用作运行时兜底。
- `leafPhaseZero` 三合一判定补可见性与复用：成员已登记自配档但因证据/预估缺失重走 phase-0 时，console.warn 留痕，并把已登记档位作为提示词复用建议（若复杂度判断不变可直接再次提交同一档，不改判）。

### 二、输入侧续省

- 规划器请求拆两角色：静态方法论/约束/部门表/输出精简/JSON 结构进 `role:'system'`（同会话内每次重试与多次规划字节级相同，上游前缀缓存稳定命中，每次重试省 ~4.3K 字符输入）；工作目录/最近对话/任务原文进 `role:'user'`。定向修复请求保持单条 user 消息；总字符数与旧单消息口径一致（`buildPlannerPrompt` 拼接视图供测试/遥测）。
- 负责人任务书《沟通交流格式规范》提前到规则简报之后（原在最尾部）：规范文本固定，与动态块（背景/依赖/兄弟进展/失败反馈）分离，请求前段跨重试字节级稳定；文本一字未改（与核验门禁同一事实源）。
- 复杂度依据支持极简枚举：`complexityReason` 三选一（facts=任务事实多且杂 / dependencies=跨模块跨系统依赖 / verification-difficulty=验证难度高）与 prose `complexityRationale` 二选一即可；台账统一落 `complexityRationale`（prose 优先、无 prose 落枚举原文），消毒器零改动；两者都缺才硬拒。每次 self_effort 的固定输出从一段话压到一个词。

### 三、输出侧续省

- F11 部门汇总 sources 只需写专家名（原「专家名：一句关键成果」）：成果一句话由平台在完成通知里从各成员结算行 summary 自动补全（成员名匹配、已带冒号说明的条目原样保留；台账 departmentSummary 原样存档，只改交回主 Agent 的通知）。按 25 人分工表计，每次结算省 ~1,000 字符模型输出。
- 最终成果答复长度约束（提示词侧）：正文 ≤800 字（结论、产物路径、遗留项），细节放产物文件与结果块，不复述证据 JSON——旧实现最终汇总完全不受约束。

### 四、全计划预算闸（O6/O8，默认行为不变）

- 新增全计划专家总数上限 `MAX_TOTAL_EXPERTS_PER_PLAN`（默认 40，环境变量 `DSH_WORKPLAN_MAX_TOTAL_EXPERTS_PER_PLAN` 可调）：旧实现 15 子任务 × 25 专家 = 375 名专家 ⇒ 约 781 个 LLM 回合，没有任何全局闸。派发前统计全计划已登记 delegates 合计 + 本轮真正要新启动的成员，超限整单拒绝（`DELEGATE_PLAN_EXPERTS_EXCEEDED`，给出「精简分工表 / 拆成多轮计划」两条出路）。
- 复杂任务 ≥8 人下限开放环境变量 `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS`（默认仍 8，行为不变；非法/缺省回落 8）；单阶段计划（stages.length === 1）自动豁免该下限——「可并行拆分」的 8 人下限对单阶段任务只会制造无解死锁。

### 五、可选负责人预登记（O1，默认关闭）

- 环境变量 `DSH_WORKPLAN_LEADER_PRE_REGISTER=1`（或 true/on）启用：分工表条目可随附该成员的 `startPhases`（五步第 1/2/3 步证据）与 `timeNotice`（开工前预估），派发时平台替成员登记（信息由负责人本人撰写，delivery 视为已送达），成员免跑 phase-0 评估回合、直接以分工表档接续 phase-1——每个专家省整整一次 LLM 回合（约占专家总输出的一半）。证据经 `sanitizeStartPhaseEvidence` 消毒、预估按 self_effort 同判据校验；任一缺失/非法 ⇒ 该成员照旧走 phase-0（fail-open，不新增拒因）。登记写进行级三通道（delegateSelfEfforts/delegateStartPhases/delegateEstimates），重启/回放不丢；consolidation.assignments 消毒白名单与 delegate 工具 schema 同步扩字段。默认关闭是有意取舍：预登记把「成员自配档」改为「负责人代配档」，是行为变更，交给用户显式选择。

### 六、明确不做（评估后保留/放弃，附原因）

- 团队简报省略 pending 兄弟：tests/token-economy-320.test.ts 钉住「并行兄弟必须仍可见」契约（执行者需要知道并行部门还没开工，避免空等或重复采集），撤销该裁剪。
- 工具 output.schema「清理」：核实后确认并非死代码——宿主 dsh-tools 用它做工具结果校验（INVALID_TOOL_OUTPUT）与渲染投影，保留。
- 子任务书全面静态前置重排：仅完成沟通规范前置；全面重排的缓存收益不确定而回归面大（73 处测试引用、两处「上方/下方」自引用），不做。
- STOP_STEER_LIMIT 调整：原建议「第二次 steer 只发工具调用」需宿主能力支持，简单降档会改变交付语义，不做。

### 七、验证

- `npm run check`（tsc --noEmit）通过。
- `npm test`：**1491 例，pass=1490 / fail=0 / cancelled=0 / todo=1，exit=0**；新增 9 例守门（tests/token-economy-324.test.ts）：单阶段豁免 ≥8 人下限、MIN 环境变量覆盖与非法回落、规划器 system+user 拆分（内容/角色/拼接视图）、规划器两角色请求实发断言、能力缓存同键命中与容量淘汰、空清单返回、预登记开关解析、F11 专家名契约、预登记载荷透传。
- `node scripts/measure-injection.mjs` 终态实测（字符数非账单 token）：PROMPT_SECTION 3,663（+84：新增最终答复长度约束一行）；11 个工具 schema 合计 14,797（delegate 3,980，+O1/枚举字段后仍 ≤4,500 预算）；规划器提示词 4,551（不变，但静态部分已移入 system 角色）；负责人任务书 7,081（沟通规范换位）；专家任务书 3,276（不变）；五步全文/接续 2,587/1,323（不变）；加权样例 74,796。
- 版本统一 **3.2.4**：`package.json` / `package-lock.json`（两处）/ `PLUGIN_VERSION` / `meta.version` / 三份 README 徽章与安装命令 / `tests/fixtures/tool-surface.json` / 版本断言测试。
- 运行中的 DSH 由用户手动重启后生效。


## 3.2.3 — 2026-11-23（省 token：输入侧提示词压缩 + 输出侧模板瘦身；门禁语义不变）

基线 3.2.2。本版只压缩「重复、客套、可省略」的提示词与输出模板，不改任何校验字段、枚举、阈值、错误码与派发/验收/交付语义；改动经同一套回归测试、守护断言与边界探针复核。

### 一、输入侧（7 个 src 文件，+195/−512 行）

- 系统提示段（PROMPT_SECTION）：5,314 → 3,579 字符。
- 14 个工具 schema 行为长文：22,621 → 16,124 字符（必填/枚举/阈值/错误码全部保留）。
- 规划器说明：6,548 → 4,622；负责人任务书（含 §5.5 汇报句）：11,119 → 8,676；专家任务书：5,006 → 3,678。
- phase-0 两份任务书：2,301 → 1,799；五步法全文版/接续版：3,659/1,876 → 2,601/1,325；沟通格式 F1–F11：1,993/1,815/551/726 → 1,304/1,223/359/445。
- 本版终态注入面实测（`node scripts/measure-injection.mjs`，字符数非账单 token）：PROMPT_SECTION 3,579；11 个工具 schema 合计 13,855（delegate 3,038 / verify 2,454 / replan 2,044 / update 1,999）；规划器提示词 4,551；负责人任务书 6,961；专家任务书 3,276（3.2.3 新增共享文件纪律 128 字符）；五步全文/接续 2,587/1,323；一个 5 负责人 + 5 专家的加权样例 73,170。**此前草稿中的 44,060 → 31,352、`reports/t5-probes/measure-injection.cjs`、317/251 断言与 20/20 探针在本仓库无脚本/报告可复现，已删除，不作为实测证据。**

### 二、输出侧（3 个 src 文件 + 1 个回归用例，+67/−26 行）

- 结果块模板：接续 452 → 293 字符，非接续 903 → 458 字符；交卷说明 1,164 → 622 字符。
- 删除模板中无消费方的可选字段示范与 done 空占位；`criterion` 改为编号示范，逐条证据仍以顶层 `acceptance` 为准。
- 修正真实冲突：`dsh_workplan_verify` 自检路径也按计划验收条目自动生成 checks，与结算闸使用同一套补齐逻辑；模型已写的 checks/allPassed 一律不覆盖。
- 统一三处「checks 可省略」文案（`src/five-step.ts` 两处、`src/plan.ts` 一处），消除「提示词说可省、verify 却打回」的矛盾。
- 汇报正文上限 600 → 200 字（3 句）。

### 三、失败路径治本（本轮新增，全部保持原有门禁）

- W1 规划器校验失败：第二次起不再整份重发规则/部门表/对话背景，改「待修问题 + 上一轮原文 + 只修点名字段」的定向修复提示词；三道闸、3 次上限、CLARIFY/CONTEXT 一次终态、DEVIATION 严格性与最终硬失败原样保留；传输/超时/中止类失败回退完整提示词。
- W2 子会话结算失败：unparsable / 结果块缺失 / 结算闸退回三类共用盘上结算备份先查（新鲜度 `mtimeMs >= startedAt` + planId/subtaskId 归属 + strict 重裁决 + 拒绝坏备份），命中即原地结算、不再白起一个新子会话；未命中仍按原 EVIDENCE_* 有界回喂。`verification:'failed'` 不触发重报。
- W3 已规划未派发：同任务（buildTaskAnchor 的 sha256 + sourceMessageIds 比对）且阶段 pending / 无 hold / 无 SALVAGED / 无 pending changeRequest 时复用原计划，只发一条轻量通报并派发；`DSH_WORKPLAN_REUSE_UNSENT_PLAN=0` 可关闭，plan-first（autoDispatch:false）只提示不代派发；任一闸不满足保留旧「取消并重规划」语义。
- W5 自动续跑放大器：dispatchPlan 在重置状态前记录 `subtaskId:status:revision` 指纹；一轮结束若指纹未变则 `NO_PROGRESS` 停止续跑，避免「什么都没写还反复开会话」；旧记录无指纹 fail-open，上限 2/4 不变。
- W6 开工证据重复注入：重试回喂与叶子自接续优先只注入文件引用 + 蓝图/索引摘要（`renderStartEvidenceBrief`），写盘失败自动回退逐字全文；证据内容一字不丢。
- 极简单动作快路径（用户已授权、默认关闭）：配置 `deterministicFastPath: true` 或 `DSH_WORKPLAN_DETERMINISTIC_FAST_PATH=1` 才启用；仅当「无活跃计划/非 planMode/非认可闸门/8–400 字/单动作动词/单文件路径/无指代矛盾/单部门/非分析请求」全部满足时，代码直接生成单子任务计划，完全跳过规划器 LLM；仍走同一 `validatePlan` + `validatePlanContext` 三闸，任何疑点 fail-closed 回落常规规划。默认关闭是有意取舍：它省掉规划器的分解与矛盾分析能力，只适合用户明确授权的简单任务。
- 守门短语恢复：恢复「执行自己的任务必须先完成上方『五步工作法』的前三步」「前三步证据经 review 的 startPhases 一并提交并登记，未登记合格证据前禁止进入执行与再分配」「基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案」三条用户强制原文口径（旧回归测试逐字断言）。
- 顺序推理链根治（本轮新增）：新增纯函数 `detectSequentialChainTask`（先…再 / 依次 / 逐步 / 第 N 步 / 串行 / 链式 / 基于上一步 / 最后一步，机械可复算、不做语义猜测）。`planDelegations` 在 review/dispatch 同一入口新增硬闸：链式父任务不得拆给多名独立专家（`DELEGATE_SEQUENTIAL_CHAIN_SPLIT`），只接受 1 名专家从头到尾一次做完（豁免复杂任务 ≥8 人下限——该下限为可并行拆分设计，否则「≥8 人被链闸拒、1 人被 MIN 闸拒」会构成无解死锁）；low/未配置档仍可负责人 `action="direct"` 亲自执行。闸位在人数上下限之前，避免误导性拒因；负责人/专家任务书同步告知，跨子任务只传已落盘产物引用，不用推理摘要替代结论。
- 链式直执档位（本轮新增）：顺序推理链任务改由负责人亲自执行时不得以 low 档开跑——负责人必须先自己评估复杂度，再经 `action="direct"` 提交自评复杂档 `reasoningEffort`（qwen 模型: medium/xhigh；非 qwen: high/max，以 `allowedEffortsForModel` 家族合法集合为准）。缺失 → `DELEGATE_DIRECT_CHAIN_EFFORT_REQUIRED`；显式 low / 非法值 / 非本家族合法档 → `DELEGATE_DIRECT_CHAIN_EFFORT_INVALID`；命中后 `effortOverride` 按自评档 durable 落位，平台以该档接续 phase-1 亲自全链执行，空分工表直执标记与「不再下派拆分（链闸仍拦截多人拆分）」不变。非链式任务的原 low 直执语义一字不变；delegate 工具描述、负责人/部门简报行同步更新。
- 共享可变状态根治（本轮新增）：`dispatchPlan` 在 `runSubtask` 外层按规范化后的绝对路径（`inputs` + `outputs`，`resolveArtifactPath` 同源）加互斥锁：重叠产物的子任务严格串行，无重叠键直接放行、原并发与 `MAX_CONCURRENT=5` 不变；`dependsOn`、单写者防重头、质量闸与全部原有拒因一字不动。专家任务书新增「只写本任务 outputs 声明的产物与自己那份 reports/wp-member-*.json，不并发写共享文件」的硬纪律。

### 四、验证

- `npm run check`（tsc --noEmit）通过。
- `npm test`：**1482 例，pass=1481 / fail=0 / cancelled=0 / todo=1，exit=0**；新增 23 例守门：长锚点去重、不复述/不重复口径、verify schema（tests/token-economy-321.test.ts）、未派发计划复用 5 例（tests/workplan-324-reuse-unsent-plan.test.ts）、W2 新鲜/陈旧备份 2 例（tests/workplan-unparsable-retry.test.ts）、快路径资格 + W1 定向修复 + W5 指纹 + W6 摘要 4 例（tests/token-economy-323.test.ts）、顺序链不拆（含链式豁免 ≥8 人下限与豁免不扩大两例）+ 共享状态互斥 7 例（tests/workplan-323-chain-and-shared-state.test.ts）、链式直执档位 5 例（tests/workplan-low-delegation-gate.test.ts D2b-1…D2b-5：缺档拒 / low 拒 / 四家族组合放行与 effortOverride 落位 / 越界档拒 / 非链式语义不变）。修正旧质量闸测试夹具的两条子任务同产物冲突（改为不同产物，保持该测试只考察质量闸）。
- `node scripts/measure-injection.mjs` 可复现实测；输出到 stdout，字符数非 token。
- 版本统一 **3.2.3**：`package.json` / `package-lock.json`（两处）/ `PLUGIN_VERSION` / `meta.version` / 三份 README（README.md、README.en.md、README.zh.md）徽章与安装命令 / `tests/fixtures/tool-surface.json` / 两处硬编码版本断言。
- 运行中的 DSH 由用户手动重启后生效（用户已确认 2026-11-23 重启完成）。

## 3.2.2 — 2026-11-22（省钱：不再让模型重抄/重复带同一段文字；一致性治本）

本版把“模型反复抄写、反复收到的同一段文字”改成平台一次性生成或按需携带；不删除功能、不改派发/验收/交付语义。基线为 3.2.1，本会话修改后统一版本 3.2.2。

### 一、输入 token 的节省

- 规划器不再输出 `taskUnderstanding.originalRequest`；平台从用户原文回填（上限 8,000 字，与 wire 校验同一常量）。
- 规划器对话背景按需：任务有“它/这个/B/上一项”等指代时 7,000 字，无指代时只带最近 3,000 字。
- 部门/专家任务书：真实派发时有指代 7,000 字，无指代只带最近 1,200 字；直接调用/旧测试仍默认完整背景，不破坏旧契约。
- 已带 `buildLlmRulesBrief({tier:'department'})` 时，任务书不再重复约 1,300 字的负责人授权段；只有简报确实包含“部门负责人强制流程”标记才省略，否则自动保留。
- 工具说明书瘦身（schema 字段/类型/必填/枚举/错误码不变）：`delegate` 7,280→4,121 字符，`update` 3,471→2,895，`dispatch` 2,386→2,053，`verify` 3,426→3,193；导出工具合计 24,061→19,760。
- 计划消息的“全局任务”与用户原文锚点重复时只保留一份；仅在前 4,000 字可见锚点确实包含全文时去重，避免“与上方相同”却看不到全文。

### 二、输出 token 的节省

- 子 Agent 结果块只写顶层 `acceptance`；平台自动生成 `phases.verification.checks` 与 `allPassed`，不再要求模型把同一张验收表写两遍。模型自己写了的保留；`acceptance` 为空仍按旧规则失败。
- 规划器输出增加“精简”硬要求：每个字符串≤200 字，简单任务的 contradictions/risks/verification/practiceLoop 各写 1 条要点即可。

### 三、一致性治本（本会话审查发现并修复）

- 统一 `MAX_ORIGINAL_REQUEST_CHARS = 8000`，回填与校验同源；8,001 字符明确拒绝，避免“长任务回放才炸”。
- 去重只看实际可见的 4,000 字锚点；超长任务不再丢失全局任务文本。
- `compactBackground` 默认关闭、真实派发开启；保留旧“完整背景不二次截断”契约。
- `recentConversation` 改为保留最新内容（原来用头部截断，窗口超一行会丢最新消息）。
- 参考探测失败时 fail-open 保留完整背景；不因探测异常让任务书构建失败。
- 补回压缩简报时丢失的“少走弯路”“action=status 查看进度”两句。

### 四、代码/RPA 结论

- 已把固定格式/装配交给代码：用户原文回填、验收表生成、对话窗口选择、计划消息去重、工具说明书声明面。
- 保留模型调用：规划器（任务分解判断）、部门/专家执行、复盘与最终综合；phase-0 复杂度自评是用户规则要求的“子 Agent 自己判断”，未用代码替代。
- 没有为了省 token 改变通知频率、派发顺序、验收门禁或并发语义。

### 五、验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm test`：**pass=1454 / fail=0 / cancelled=0 / todo=1（共 1455 例）**，exit=0。
- 新增 `tests/token-economy-321.test.ts` 6 例：缺 `originalRequest`、按需背景、简报去重、checks 自动生成、预算上限、8,000/8,001 边界。
- 版本统一 **3.2.2**：package.json / package-lock.json（两处）/ `PLUGIN_VERSION` / `meta.version` / README（中英）/ tool-surface 夹具。
- 运行中的 DSH 需用户手动重启后生效；重启后 `dsh_workplan_status` 的 build 指纹按实际构建核对。

## 3.2.1 — 2026-11-22（T4 根因：让兄弟部门被看见、让依赖缺口被点名、让终止可收编）

3.2.0 解决的是「同一份文字重复付费」；这一版解决的是「同一批事实重复采集」。真实事故 `wp-33c002f6/T4`：T3 已交付行情/资金事实，但 T4 的 `status` 只返回自己部门的 delegates，看不到兄弟完成到哪一步、产物在哪个文件；计划里 T4 的 `inputs` 还写着「公开政策与行业数据（待确认）」，`dependsOn` 却只列了 T2。T4 只能自己再采集一遍。3.2.1 不新增由插件直接发起的模型调用，只改信息可见性与复用规则；兄弟完成提示会进入负责人上下文，可能让它多处理一步，已按“每个负责人每个计划最多一条”封顶：

### 一、兄弟部门实时可见（治「不知道」）

- 子任务 done 时，平台主动给仍在 running 的其他部门负责人发**一行**通知：谁完成、1 个已落盘产物路径、可复用；不附摘要、不要求确认；每个负责人每个计划最多一条（只负责把人推醒，完整索引仍走 status），避免 13 个部门互相通知产生 150+ 条常驻消息。
- `dsh_workplan_delegate(action="status")` 新增 `siblingSubtasks`：最多 12 条同计划兄弟索引，done 优先，带状态、标题、最多 2 个已落盘产物、done 行 80 字摘要；有 done 兄弟时附 `siblingHint`。
- 任务书的兄弟简报对 done 兄弟改用 `status.artifacts` 真实路径（没有登记时才退回计划产物）；有 done 兄弟时多一句「兄弟复用」规则：先看 status、能读用就不重复采集。
- 有成员仍在 running 时，status 返回 `runningHint`：不要重写其层，先催收/收编，确认 failed 后再补写。

### 二、依赖缺口在计划阶段点名（治「依赖少设」）

- 规划器硬规则：下游 inputs 需要行情/资金/份额/政策/行业数据等共享事实，而计划中已有专门产出该数据的子任务时，必须把其写入 `dependsOn`。
- 计划消息新增只读的「依赖自检」：子任务 inputs 含「待确认/待定/TBD/不明」等未定项、且前序存在数据型产物时，点名可复用的前序 ID 并提示补 `dependsOn`；只警告，不自动改计划、不阻断派发。

### 三、终止通知可收编（治「整层重写」）

- 第三层失败/中断/空回合/停滞/结算异常的终止通知，新增「已落盘结算备份（可先收编核验，禁止整层重写）」；没有结算备份时明确写「未发现」，不再让负责人凭印象从零重写。
- 复用已有的 `probeDelegateLandedArtifacts` 只读探测，不新增写入、不改变终止判定。

### 四、补派排队可见（治「8 行全 running、没看到新成员」）

- 并发位不够时，新成员本来就会以 `childId=null` 的占位条目排队；旧 status 把「排队」和「真的在跑」都显示成 running，负责人误以为补派失败或被重置。
- 现在 status 只给读面加 `queued: true`（不改存储、不改门禁），并分开返回 `runningHint`（真正有会话在跑）与 `queuedHint`（排队中、不是失败、预算用完不会自动启动；再次 dispatch 会优先启动新成员，再重试 failed 旧成员（旧成员多时仍可能排队））；台账里的新成员不再「看不见」。
- 补派混合「新成员 + 上次 failed 旧成员」时，新成员优先启动，旧成员仍会重试/排队；避免旧 failed 按原顺序先占满并发位，把本次要补的新人继续挤回队列。
- 这解决的是「误判」和「补派被旧成员挤掉」，不是放宽派发：真正的落盘/激活仍由原并发预算和派发闸决定。

### 五、成本边界

- 兄弟通知每条 ≤320 字，每个负责人最多一条；status 兄弟索引最多 12 条；任务书复用规则只在有 done 兄弟时出现；计划自检只在「未定输入 + 有数据型前序」时出现。
- queued/running 拆分只是读面派生字段，不新增持久化；插件不直接发起模型调用。
- 插件不直接发起模型调用；兄弟完成提示可能让负责人多处理一步，已按每人一条封顶；没有改派发规则、验收、结算、超时、并发、权限语义；补派时只调整新成员启动顺序（新成员先于旧 failed，旧成员仍重试）。

### 验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm test`：**1449 例，pass=1448 / fail=0 / cancelled=0 / todo=1，exit 0**（新增 `tests/sibling-visibility.test.ts` 8 例；尾部 `[run-tests] pass=1448 fail=0 cancelled=0 exit=0`）。
- 版本统一 **3.2.1**：package.json / package-lock.json（两处）/ `PLUGIN_VERSION` / `meta.version` / README（中英）/ tool-surface 夹具。
- 本改动只影响插件源码与构建产物；运行中的 DSH 需用户手动重启后生效（插件不自行重启）。

## 3.2.0 — 2026-11-22（把可推导、可复用、已在盘上的内容从每次付费里拿掉）

本轮继续 3.1.9 的结构性省钱：不新增模型调用，不改变派发、验收、交付语义；只处理三类仍然重复付费的内容——已在 phase-0 登记过的开工证据、任务书里可截断的兄弟/教训/模板、以及给主 Agent 的冗长正文。

### 一、交卷不再重抄开工证据（省输出 token，治「抄薄被退回」）

3.1.1 起，结算时要求把 phase-0 登记的 `phases.planning / phases.preparation` 逐字重抄一遍。真实样本 `wp-33c002f6/T4` 的 phases 共 6,240 字符，其中 planning 1,928 + preparation 879 = **2,838 字符（45%）是重抄**；抄薄还会被一致性比对退回重交。3.2.0 起：

- 平台把 durable 登记证据作为缺省值：交卷只写 `execution / verification`（及顶层 acceptance/artifacts/report），缺失的 planning/preparation 按**字段级**自动补齐；交卷自己写了的字段原样保留，平台再做并集落账，登记内容一条不丢。
- 结算校验、`dsh_workplan_verify` 第四步核验、沟通格式 F3 三处同口径；无登记证据的旧计划/旧回放仍要求四组齐全，零迁移。
- 平台自动并入的登记证据不再计入「phases 合计 6000 字」上限，避免省输出反而制造新的退回源。
- 实测同一样本可少输出 **2,838 字符/部门**；按 13 个部门估算约 3.6 万字符。

### 二、任务书结构压缩（省输入 token，每一步都少付）

- 依赖结果摘要 1,200→**800** 字，产物引用 8→**5** 条；完整原文仍可从产物/会话读取。
- 兄弟简报：目标 120→**60** 字、产物 120→**80** 字、完成摘要 200→**80** 字，整块 2,000→**1,500** 字；依赖项仍由上方依赖块单列，不重复。
- 历史教训：8→**6** 条、3,200→**2,200** 字；新增同主题去重（取预防硬规则前 30 字为键），同一规则不再为多条近似记忆付两遍。
- 全局任务与「用户原要求」锚点重复时只保留锚点一份（省约 500–1,200 字/任务书）。
- phase-1 结算模板 992→**541** 字：省略 planning/preparation 示例，只留 execution/verification 与顶层字段；模板上方明确写「平台自动并入，不要重抄」。

### 三、正文汇报限长（省输出 token）

phase-1 任务书要求给主 Agent 的可见正文 **≤600 字**，细节放产物与结构化证据块，禁止复述证据 JSON。T4 真实负责人正文 9,780 字符（含证据块），叙述部分与 departmentSummary/证据块三份重复的问题由此收敛。

### 四、局部与整体口径统一（本轮一并修清）

- 接续提示、五步精简版、结算模板、verify 成功提示、F3 门禁五处过去分别暗示「必须重抄」或「缺 planning 即退回」，现统一为「有登记⇒可省略、平台自动并入；无登记⇒四组齐全」。
- 交卷只写半组 planning（例如只写 problemAnalysis）时按字段补齐，不再因 `planning:{}` 空对象或半组内容被误退。
- `renderStartEvidenceBrief`、`buildPhaseZeroContinuationHint`、回喂消息三条路径的「抄写纪律」文案同步改口，不再让模型为已登记内容重复付费。
- 保留安全网：并集封顶 20 条时若装不下登记条目，仍按变薄退回并回喂登记原文；`requirePhases:false` 的历史回放语义不变。

### 验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm test`：**pass=1440 / fail=0 / cancelled=0 / todo=1**（3.1.9 基线 1437 pass + 新增 3 例 `tests/token-economy-320.test.ts`；测试与构建同步定版 3.2.0）。
- 版本统一 **3.2.0**：package.json / package-lock.json（两处）/ `PLUGIN_VERSION` / `meta.version` / README（中英）/ tool-surface 夹具。
- 本改动只影响插件源码与构建产物，不新增模型调用；运行中的 DSH 需重新加载 bundle（重启 DSH，或在插件管理里禁用再启用）后才生效（插件不自行重启）。

## 3.1.9 — 2026-11-22（结构化省 token：计划信封迁移 + 根工具面裁剪 + 任务书去重 + 接续五步精简）

本轮不新增模型调用、不改变任何派发/验收语义，只处理「同一份信息被重复送进模型上下文」的结构性浪费。四个改动都先量化真实样本，再落到源码。

### 一、计划消息：完整计划迁入 source.durable，可见文本改紧凑骨架

旧版 `buildPlanMessage` 把 `{planId, sessionId, plan}` 整包 JSON 塞进聊天消息可见文本。真实样本
`session-93ffa230` 的计划消息 **23,071 字符**（其中 JSON 22,108），这条消息永久留在主会话里，
之后每个模型步骤都重复付费。

3.1.9 起：完整 plan 原样进入 `source.durable`（与 result/cancel 同一信封机制）；可见文本只保留
摘要、用户任务原文锚点、阶段/子任务的目标/依赖/验收/质量骨架和下一步。同一份真实计划可见文本
**23,071 → 5,262 字符（-77%）**。`parseWorkplanMessage` 优先读 durable，旧消息回退旧文本 marker，
已有会话零迁移；计划模式、认可闸门、自动派发文案保持不变。

### 二、根会话工具面：隐藏三件根会话必然调不通的工具

`dsh_workplan_delegate` 需要 `parentSession`（根会话没有），`dsh_workplan_escalate` 需要已登记
childId 或第三层叶子上下文，`dsh_workplan_verify` 需要 `parentSession` 反查父计划。三者在根会话
调用都会被 runtime 硬拒，但旧版仍把说明书注入根会话。3.1.9 只在「声明面」隐藏：
根会话可见工具 14→11；按运行时 `request/header` 实测，真正注入模型的 workplan 工具说明
**26,631 → 15,046 字符（-11,585，约 -43%）**。部门负责人/第三层专家的工具面一字不变，
execute 内权限硬校验也一字不动。判定仍 fail-open（无 header 的未知会话继续全量）。

### 三、部门负责人任务书：依赖结果去证据块、兄弟简报不重复依赖项

旧版 `buildChildPrompt` 把依赖项的 `status.summary` 整段渲染（真实样本两个依赖块 6,673 字符，
其中常含上游 `WORKPLAN_EVIDENCE` JSON），随后「兄弟部门进展」又把同一批依赖项再列一遍。
3.1.9 起：

- 依赖摘要先去掉 `WORKPLAN_EVIDENCE` 块、压平空白、每条截到 **1,200 字符**；产物 refs 保留，
  完整原文仍可从产物/会话读取，信息不丢。
- `buildTeamBrief` 新增 `excludeIds`，把已在上方「依赖子任务的已知结果」出现的 ID 排除；
  若排除后没有并行兄弟，保留一句「依赖项已在上方单列」，块不会凭空消失。

同一份真实负责人任务书的依赖块从约 6.7KB 降到约 2.6KB（按两个依赖、各 1.2KB 上限计）。

### 四、phase-1 接续：只讲第四/第五步，不再重讲已完成的前三步

旧版每个负责人/专家 phase-1 任务书都带完整 `fiveStepPromptLines()`（3,583 字符），其中大量
篇幅在教「第一步/第二步/第三步怎么做」；这些步骤已在 phase-0 完成并登记。3.1.9 新增
`fiveStepContinuationPromptLines()`（1,611 字符，**-1,972**），phase-1 接续改用它，保留：
第四步执行/验证、复盘、第五步 JSON 交付、开工/结算闸、全部硬下限/硬上限数字，以及
`START_EVIDENCE_MISSING/INCOMPLETE` 等关键串。phase-0、主 Agent、无接续块的旧计划路径继续用
完整版，旧计划零迁移。

### 五、局部与整体的矛盾（本轮一并修清）

- 根会话工具面宣称「可派发第三层/可请示/可核验」，实际 execute 必然拒绝——声明与权限两套事实；
- 计划消息仍是最后一块整包 JSON，而 result/cancel/replan 早已迁到 durable——同一插件两套信封口径；
- 依赖结果与兄弟简报重复同一批内容——两个 builder 各自为政；
- phase-1 任务书既说「前三步已完成、不要重做」，又用 3.6KB 重讲前三步——局部文案与整体阶段矛盾。
- 计划骨架为了省 token 设了 6,000 字上限，但字段写满时旧实现会把后面的子任务整段截掉——
  「省 token」与「计划完整可见」冲突。现已改为超长时退化为「全部子任务索引」（保留每个 ID、
  标题、目标缩略、依赖、验收/质量条数），15 项长字段实测 4,135 字、全部任务可见；14 项真实
  计划仍是 5,262 字。

### 验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm test`：**pass=1436 / fail=0 / cancelled=0 / todo=1**（基线 1430 + 新增 6 例
  `tests/token-economy-319.test.ts`；版本断言随定版升级）。
- 版本统一 **3.1.9**：package.json / package-lock.json（两处）/ `PLUGIN_VERSION` / `meta.version` /
  README（中英）/ tool-surface 夹具。
- 本改动只影响插件源码与构建产物，不新增任何模型调用；运行中的 DSH 需重新加载该 bundle
  （重启 DSH，或在插件管理里禁用再启用）后才会加载新构建（插件不自行重启）。

## 3.1.8 — 2026-11-22（并发位自锁治本：接续不占工具调用 + 派发排队预算 + 全量预登记）

现场：`session-93ffa230-1caf-4f8d-bb05-ed6f890a64b3` 的计划
`wp-d3448f95-3f8d-4bd4-8565-935f417de150` 在 T3 派发 10 名专家时，
`dsh_workplan_delegate` 自 14:40:40 起一直没有返回；7 名专家在同一秒被创建，
随后 7 次 `self_effort` 全部停在「无工具结果」，3 名专家从未被创建。

根因（两层，互相放大）：

1. **逻辑自锁**：`selfEffortTool` 在同一个工具调用里先中断自己的 phase-0 回合，
   再同步 `await` 新激活（phase-1）。宿主的并发位要等 phase-0 回合结束才释放，
   回合要等工具返回，工具又在等空位 ⇒ 三方互等。宿主 `dsh-tools` 在 abort 后
   仍会 await 在飞工具，所以只能等满队列上限（默认 10 分钟，内部再重试 1 次，
   最长约 20 分钟）才报错。
2. **设计矛盾**：复杂任务硬性要求至少 8 名专家，而宿主默认整个会话树只有 8 个
   并发位，部门负责人自己也占 1 个 ⇒ 9 > 8。按插件规则正常执行就必然占满，
   于是每次复杂任务都会稳定复现「长时间无响应」。

修复（治本，不动 phase-1 任务书内容，不新增任何模型调用）：

- **自配档接续不再占住工具调用**：先做一次不排队的激活尝试；空位可用则立即接续
  （与旧行为一致）；空位已满立即返回 `ok`（`continuation: "scheduled"`），把真正
  的 phase-1 激活交给回合结束之后的后台任务，空位一释放就自动接上。
- **交接过渡标记 `continuationPending`**：phase-0 结束、phase-1 尚未接上时，
  派发结算回调只等待，不写 `failed`、不发终止通知；`markStalledDelegates` 在
  交接期同样不判停滞。接续完成后清除标记。
- **派发全量预登记**：先把分工表全部成员写进台账（`running` 且 `childId` 为空
  = 排队中），再逐个争取并发位；第 8 名之后不会再有「连台账都没有」的成员。
- **本轮派发共用排队预算**：`DSH_WORKPLAN_DISPATCH_QUEUE_MAX_WAIT_MS`（默认
  120 秒）；预算用完立即返回 `queued` 清单与可执行的补派提示，绝不按成员各自
  等满宿主上限。
- **补派闸门放宽**：只有「全部下级都已真正启动（都有 childId）」才拒绝重复派发；
  有排队成员时允许补派，已在跑成员按 childId 跳过，绝不重复拉起。新增返回字段
  `queued` 与 `skippedRunning`。
- **排队提示改为可执行口径**：调大 `subagent.maxActiveSubagents` 或等下级结算后
  补派；不再提示对 dispatch 已不适用的旧环境变量。

token 影响：不新增模型调用，不改变 phase-1 任务书；消除最长约 20 分钟的空等与
失败重试（重试会重跑 phase-0，那才是真正的 token 浪费）。排队提示只在真的排队时
追加一条用户可见通知；补派只启动未启动成员。

验证：新增两条回归（满位时 `self_effort` 立即返回并自动接续；派发预算用完返回
`queued`、补派不重复拉起），全量测试 1430 项通过；版本统一 **3.1.8**。

## 3.1.7 — 2026-11-21（接续证据分层：蓝图全量 + 审计链索引 + 落盘原文）

3.1.6 让专家接续时带上了**完整**登记证据（此前只有 approach 前 300 字符）。证据完整了，
但一次接续要重复贴约 2,374 字（实测 5 份真实样本：1,775 / 2,234 / 3,420 字），其中
**约 73% 是审计链**（任务梳理、资源、工具、已备清单、就绪证据），真正指导执行的
`approach + approachBasis` 只占约 27%。

把上限从 6,000 砍到 3,000 是**丢证据**（模型看不见就会重做或猜），不是治本。3.1.7 改成
「**证据一条不丢，但只为必须照做的部分付费**」：

- **蓝图全量**：`approach`（方法流程步骤）+ `approachBasis`（依据）逐字进提示词——
  这两段直接决定怎么执行，必须让模型看见。
- **审计链索引**：`problemAnalysis / resources / tools / prepared / evidence` 只给
  「N 条 / M 字」的规模索引，正文不再重复。
- **完整原文落盘**：接续时把消毒后的登记原文写到工作区
  `reports/wp-start-evidence-<planId>-<subtaskId>.md`（`persistStartEvidenceFile`），
  提示词给出该路径并注明「需要逐字核对时读取，不要凭记忆重写」。
- **安全阀**：拿不到 cwd、目录只读、证据非法 ⇒ 返回 null ⇒ 调用点**回退全文注入**
  （3.1.6 行为），任何情况下都不会因为这条路丢证据。

实测效果（同一批 5 份真实登记证据复算）：接续提示词从**平均 2,656 字降到 1,048 字**，
**每次接续省 1,608 字（约 997 token）**；8 专家部门每轮约省 **7,975 token**。
落盘文件为纯本地写入，不产生模型调用；读取只在执行确实需要核对原文时发生。

验证：`npx tsc --noEmit` 通过；`npm test` **pass=1420 / fail=0 / cancelled=0 / todo=1**
（新增 4 例守门：分层摘要只含蓝图与索引、无引用时回退全文、落盘文件含完整原文、非法输入返回 null）；锚点 82/82。
版本：`package.json` / `package-lock.json` / `PLUGIN_VERSION` / `meta.version` /
README / 工具面夹具 统一 **3.1.7**。

## 3.1.6 — 2026-11-21（治「负责人身份竞态」与「phase-0/phase-1 口径冲突」）

现场复盘：核验计划里 T2、T3 各失败一次（`SELF_EFFORT_MISSING`）后重试，`noticeChannel`
记 `NOT_OBSERVED_IN_SESSION_LOG`。回到源码后定位到两条**局部逻辑与整体逻辑互相矛盾**的根因，
本轮一次修清。

### 一、负责人身份只在内存，台账一重建就「查无此人」（治本）

- **现象**：部门负责人以 phase-0（low 档）启动后要做的第一件事，是调
  `dsh_workplan_delegate(action="review"/"direct")` 登记推理等级；但入口按
  `childId` 反查自己的行，查不到就报 `NO_SUBTASK`（childId 未登记）→ 等级登记不了
  → phase-0 结算闸报 `SELF_EFFORT_MISSING` → 平台重试一次，白烧一轮。
- **根因**：`writeSubtaskStatus` 只改内存台账（`record.statuses`），**不写 durable 日志**。
  轮次进行中任何一次台账重建（手动 dispatch、`update` 改判、重启回放）都会用 durable
  日志重造记录，内存里的 `childId` 随之丢失。
- **修法**（`src/runtime.ts`）：
  1. 新增**派发实例表** `activationRegistry`（`WeakMap<ctx, Map<childId, {planId, subtaskId}>>`），
     在三处派发点登记：第一层负责人（`executeSubtask`）、第三层专家（`delegateTool`）、
     self_effort 接续（`newChildId`）。它是同一进程内的客观事实，不随台账对象重建而丢失。
  2. `delegateTool` 入口加两道认亲兜底：先按派发实例表找回本会话对应的行，再按
     `childIdHistory`（换主留档）认回旧会话；认回后立刻调 `persistChildIdentity`
     把 `childId` **补写进 durable 日志**，下一次重建即可自证。
  3. `buildUpdateMessage` 载荷新增 `childId`（additive），主回放与 WAL 消费两条通道
     都认它 ⇒ 身份与台账同源、不再两套。
- **效果**：台账重建不再导致「查无此人」；`SELF_EFFORT_MISSING` 与随之而来的无谓重试
  从根上消失；旧日志没有该键，读端零迁移。

### 二、phase-1 同时被告知「不要重做」和「必须先做前三步」（口径统一）

- **现象**：phase-1 任务书上方是 `phase-0→phase-1 接续` 块，明写「不要重做 phase-0 已完成的工作」；
  下方「执行要求」首条却写「执行自己的任务**必须先完成**五步工作法的前三步」。同一份任务书
  里两条指令正面冲突，模型只能二选一：重做前三步（白烧 token、还可能覆盖已登记证据），
  或违反执行要求。
- **修法**：
  - `src/plan.ts` `buildChildPrompt`：按 `phaseZeroContinuation` 分流——接续时明确
    「前三步已在 phase-0 完成并登记，不要重做、不要重新登记，直接从第四步执行」，
    只做核对与增量补充；拿不到接续块（旧计划/无 phase-0 产物）时保留原口径。
  - `src/llm-rules.ts` `buildDelegateePrompt`：专家任务书同理，首条改为「前三步已登记，
    不要重做，直接从第四步执行」。
  - 到处出现的「平台会立即以你的自配档**接续本会话**进入 phase-1」（含 phase-0 任务书、low 直执拒绝文案、接续块正文、运行时 hint）改为
    「接续（宿主**另起执行会话**并携带本阶段产物，不是当前评估会话）」——宿主
    spawn 每次都是全新会话（`manager.ts` 每次 `randomUUID()`），旧说法与机制不符，
    会让负责人误以为「还是我这个会话」，从而不把 phase-0 产物写进接续简报。
- **效果**：一句话只出现一次、一个阶段只有一个口径；phase-1 不再重做前三步，
  也不再与 phase-0 的登记证据打架。

### 二之补：接续时到底「知道多少前三步成果」

既然要求「不要重做」，就必须让执行者看见前三步的成果，否则等于让它闭着眼睛跳步。

- **负责人（phase-1）**：接续块携带 **登记证据原文全量**（`renderStartPhaseEvidence(sanitizeStartPhaseEvidence(effortRow.startPhases))`，受 20 条 × 800 字符、总量 6000 字符的统一上限约束）＋ phase-0 口语摘要（按 600 字符截断，省 token 的既有设计）。
- **专家（phase-1）**：旧实现只回注第二步 `approach` 的前 300 字符；本轮改为同样携带 **登记证据原文全量**（`renderStartPhaseEvidence(leafStartPhases)`），并在开头注明「宿主另起执行会话，不是刚才那个 phase-0 评估会话」。
- **诚实边界**：`所有成果 ≠ phase-0 会话的全部上下文`。宿主不继承父会话对话，phase-0 读过什么、想过什么无法整段搬运；能搬的是**已登记的书面证据**。因此口径限定为「**登记证据已覆盖的部分不要重做；登记范围之外、执行确实需要的细节缺口，先补齐再执行（只补缺口，不推倒重来）**」——这也是本轮同时改掉「绝对不要重做」措辞的原因。

### 三、验证

- `npx tsc -p tsconfig.json --noEmit` 通过。
- `npm test`：**pass=1416 / fail=0 / cancelled=0 / todo=1**（基线 1409 + 新增守门 6 例 `tests/identity-race-316.test.ts` + 版本断言随定版升级）。
- 版本：`package.json` / `package-lock.json` / `src/host.ts` `PLUGIN_VERSION` / `meta.version`
  统一为 **3.1.6**；工具面基线夹具同步。

## 3.1.5 — 2026-11-20（第三层完成度同源投影：专家已完成与部门行未汇总不再互相矛盾）

### 2026-11-21 晚补（按 T12 范围决策单执行全部 39 条必改：P0 卡死 7 + P1 丢数据 4 + P2 门禁 16 + P3 重复注入 12）

本轮把第二轮全方位审查（87 条问题 = 42 真矛盾 + 20 冗余 + 4 文档不符 + 21 设计权衡）里判定「必改」的 39 条全部落到源码。每条改完即 `npx tsc --noEmit` + `npm test`，最终 **1409 通过 / 0 失败 / 1 todo**（基线 1394 + 新增守门 15 例），锚点脚本 78/78 成立。

**P0 派发台账与入口快照（7 条，治「卡死/倒退」）**
- U-63/U-64/U-68（src/runtime.ts + src/plan.ts）：`delegateTool` 新增 `liveRow()`，`persist` 的 revision 与 delegates 一律基于**当前台账**而非闭包旧快照；新增 `mergeDelegateEntriesMonotonic`（条目级单调合并：低秩不覆盖高秩、同秩只认更晚时间戳、待指示条目绝不覆盖、已 sent 通知标记不回退、childId 稳定；**新一轮尝试例外**——不同 childId + running 视为负责人显式重派，取代旧终态，失败成员可再跑）。dispatch 不再整表覆盖在途结算。
- U-65/U-61：待指示门禁与 status 返回体改读 `liveRow()`，不再拿过期快照硬拒/回旧值。
- U-71（src/plan.ts）：负责人换主留档 `childIdHistory`（≤8 条、消毒拒非法），旧负责人会话不再凭空失联。
- U-37（src/runtime.ts + src/host.ts + src/llm-rules.ts）：`self_effort` 新增成员名兜底认亲（`member` 参数 + 台账未登记 childId 时按成员名匹配），phase-0 任务书写明 member 必填；叶子首次登记不再必报「childId 未登记」。
- U-50/U-16（src/runtime.ts）：僵尸回收不再裸写——补 closure/blockedKind/finishedAt/revision/updatedBy，blocked+instructed 僵尸行可被续跑重置。

**P1 回放与落盘（4 条，治「重启丢数据」）**
- U-38：回放 update 白名单补齐 13 个闭环字段（question/options/blockedKind/escalatedAt/escalationSeq/instruction/instructionSeq/assignedAt/ackedAt/ackEvidence/ackOverdue/instructionOverdue/reportedAt）+ childIdHistory。
- U-43（src/notice-ledger.ts + src/plan.ts + src/runtime.ts）：**台账写前日志（WAL）**——进内存缓冲的同一时刻同步落插件自有 JSONL（`appendWorkplanUpdateWAL`，form='wal'，携带 walId/walSeq/planCreatedAt）；flush 成功后写 ack（`appendWorkplanUpdateWALAck`）；回放消费四道闸：ack 跳过 + planCreatedAt 计划实例归属 + walSeq 会话实例归属 + revision 严格前进。崩溃窗口内只进过内存的更新不再永久丢失，且绝不污染别的计划/会话实例。
- U-15：回放自愈只补 closure/report/reportedAt，**不额外抬 revision**（applyStatus done 分支已抬号，再 +1 会破坏「durable 与 tool/result 只写一次」不变量）。
- U-52：resumeCount 自增当场落 durable（buildUpdateMessage 增 resumeCount），回放 Math.max 只前进；崩溃不再丢续跑计数。

**P2 状态单一真相（16 条，治「两套账/门禁绕过」）**
- U-05：新增 `STATUS_TRANSITIONS` 迁移守卫，done→in_progress 拒绝（返工必须经 pending 重置），同值/合法边/旧值放行。
- U-06：从非 done 进入 done 是新完成，closure 回 'done' 中间态等 markReported，不继承旧 reported（封死「返工后新结果永不进待回报」）。
- U-08：settleStaleInflight 投影补 closure/blockedKind/finishedAt + staleProjection 显式标记，不抬 revision（只读投影不冒充持久状态）。
- U-12/U-13：cancel 全 done 分支先 markReported 幂等补齐再 reconcilePhase，返回体带 reportPending 与明确出路 hint；**不改 supersede V3 冻结守卫**（全 done 不得 supersede 是契约，治法是给 no-op 出路）。
- U-14：blocked 放弃请示必须留理由（ESCALATION_ABANDON_REASON_REQUIRED），封死「先 blocked 静默放弃再 done」两步绕过。
- U-19：blocked（非 escalated）把 report/reportedAt 迁入 lastReport/lastReportedAt，「已卡住」与「已回报」不再同屏。
- U-18：normaliseStatusEntry 对 'Done'/'DONE ' 脏值保守归一，不再误降 pending 丢进度。
- U-11：canResumePlan 补 replanned 过滤，与其余 5 处同口径。
- U-17：markReported 对非 done 却带 reported 投影的行记 record.errors + reportPending=true（fail-closed 可定位）。
- U-10：blockCancelledDependents 改传递闭包，A→B→C 链不再让 C 永远 pending。
- U-20：纯时限事务第 4 条旁路收口走 applyStatus（不再裸写 revision）。
- U-39：两处指示回执（scheduleInstructionAck / scheduleDelegateInstructionAck）写内存的同时落 durable，重启不丢回执。
- U-40：回放识别 assignedNoticeKey/preAnnouncedPlanId 哨兵，重建后不再重复刷屏。
- U-21：closure 迁移表注释「19 条」更正为实测 40 条边。
- U-61：已在 P0 覆盖（status 读 liveRow）。

**P3 删重复注入（12 条，治「同一句话付两遍 token」）**
- U-24/U-26（src/llm-rules.ts）：专家规则简报不再重发五步全文与 startPhases 结构展开，改指针「完整协议见任务书下方」；预估门禁只留义务声明。关键串保活。
- U-27：buildDelegateePrompt 执行要求首条不再逐字重发五步前三步全文（下方 fiveStepPromptLines 已含），保留义务 + 第四步纪律。
- U-32：负责人汇总字段清单不再在简报重发（下方 F11 契约已含），改指针。
- U-28（src/host.ts）：PROMPT_SECTION 第二处门禁码括注改「同一组门禁码，见上文」。
- U-25/U-34（src/plan.ts）：第二次回合收尾 steer 改短提醒（headline + 剩余量 + 唯一恢复动作 + 页脚），不再逐字重发整段正文；attempt=1 仍发完整文案，关键串全部保活。
- U-29/U-31（src/runtime.ts）：完成/终止通知第二路改指针（摘要/reason 正文只在 sendMessage 那一路出现一次）。
- U-30（src/plan.ts）：质量要求缺失时回落改单行指针「质量要求＝下列验收标准」，不再把 acceptance 原文渲染两遍。
- U-36（src/runtime.ts）：看板载荷删除 plan 整包（客户端只读 stages+statuses，plan 是纯冗余第三份）。
- U-62（src/runtime.ts）：status 响应体 delegateReconciliation 改 reconciledCount + unresolved，不再整组复制 delegates 已有的明细。

**配套**：delegates 消毒补 queuedMs（此前写入但白名单丢弃）；buildUpdateMessage payload 增 planCreatedAt/resumeCount/childIdHistory；新增 `tests/workplan-317-fix-guards.test.ts` 16 例守门（单调合并/换主留档/迁移守卫/新完成不继承 reported/脏值归一/blocked 清回报/回放白名单/WAL 闭环与归属闸/僵尸回收 finishedAt 补正/第二次 steer 短提醒）。

**重启后实测追加修正（2026-11-21 20:03，U-50 补正）**：用户重启后做只读核验时发现僵尸回收的 `finishedAt` 仍停在 null——根因是 `!Number.isFinite(Number(row.finishedAt))` 把 null 误判成「已有时间戳」（`Number(null)===0` 且 `isFinite(0)===true`）。已改为「不是有限正数就补当前时间」，并新增守门测试钉住。全量回归 **1410 通过 / 0 失败**。此修正需再次手动重启才进入运行进程（核验时运行进程 build e3648adf9c543aaa 含 39 条主体修复，但不含这一处补正）。

**回归**：`npx tsc --noEmit` 通过；`npm test` **1410 通过 / 0 失败 / 1 todo**（todo 为既有 GAP-T6-2 多主产物校验缺口，非本轮引入；含重启后实测追加的 finishedAt 补正守门 1 例）；`reports/T7_anchors_check.js` 78/78 成立（行号未变 25、漂移 53、缺失 0）。**需用户手动重启 DSH 才生效**（插件不自行重启）。

### 2026-11-20 晚补（缺陷 22「专家停了、负责人永远在等」治本 + 省钱三件套）

- **缺陷 22 第一处治本（src/runtime.ts，读时对账前移）**：旧版 `reconcileEndedDelegateSessions` 只有一个调用点（`action="status"`），负责人不主动查就永远看不到「叶子会话已结束」。现在 `delegate` 在 `status/dispatch/direct` 三个入口先对账再走原逻辑（入口块 `entryReconciliation`），`status` 分支不再重复采集；对账失败写回 `reconciledFrom` 供回放区分。
- **缺陷 22 第二处治本（src/runtime.ts / src/plan.ts，终止事件推送）**：新增 `classifyDelegateTermination`（failed / interrupted / empty-turn / reconciled / settlement-error 五类）、`buildDelegateTerminationBody`（五套独立文案，统一结尾「这是终止通知，不代表任务完成；本判定不含任何超时」）、`emitDelegateTerminationNotices` / `deliverDelegateTerminationNotices`（投递到负责人会话、跳过待指示与已完成、`delegates[].termination` 幂等标记、写失败不掩盖结算）。接线三处：`delegate` 与 `self_effort` 结算回调、自配档接续失败两处、读时对账写回。`plan.ts` 的 delegates 白名单新增 `termination` 消毒（非法形状整体丢弃），durable 回放不丢标记。终止通知不写部门 journal：journal 的 kind 是 T5 冻结契约（7 种，防漂移测试守着），不硬塞也不私扩。
- **省钱三件套 ①（src/host.ts，工具按角色声明裁剪）**：14 个 workplan 工具改为按会话结构（`parentSession` / `origin=subagent` / `delegationDepth`）声明：根会话全量；其余会话隐藏 10 个根专用工具（`lessons` 也在内，runtime 只允许根会话读取）；`instruct` 只给 depth≤1；判定 fail-open（拿不准就可见）。实测每步少注入 ≥11,331 字符（负责人）、≥12,250 字符（专家），权限硬校验原样保留。宿主自带的 51 个非 workplan 工具插件无权裁剪（无公开 API），不在本次范围。
- **省钱三件套 ① 回归修正（2026-11-21）**：首版裁剪把 `dsh_workplan_delegate` 当成「负责人专用」对 depth≥2 隐藏，但叶子的唯一开工登记入口正是 `delegate(action="self_effort")`，全仓并不存在 `dsh_workplan_self_effort` 独立工具。现场后果：叶子工具面只剩 escalate/lessons/verify，phase-0 无法登记，T2 等多条第三层任务直接卡死。现已改为：`delegate` 对所有子会话保留，`instruct` 仍是根/负责人专用，`lessons` 归入根专用；`tests/tool-role-trimming.test.ts` 增加「叶子必须看到 delegate」的守门断言。全量回归 1394 通过 / 0 失败。
- **省钱三件套 ②（src/host.ts，系统提示分段）**：在子 Agent 的 `agent.ctx` 注册同名 section 遮蔽全局「主 Agent 专属段」（官方语义：scoped section shadows global）。根会话原文不动；子会话每步把 5,354 字符换成约 60 字子会话提示；`agent/created` 注册 + `agent/pre-step` 单监听器兜底，WeakSet 幂等，异常 fail-open。已用 `@deepseek-ai/dsh-system-prompt` 现场实验验证遮蔽语义（scope 内取到子文本、全局仍取到原文）。
- **省钱三件套 ③（src/plan.ts，任务书去重）**：`buildChildPrompt` 里 `renderDepartmentSummarySpec()` 与 `renderCommFormatSpec('leader')` 相邻重复（后者已内含前者，OV-08），删掉前者，每份负责人任务书少 726 字符。
- **回归**：`npx tsc --noEmit` 通过；`npm test` 1394 通过 / 0 失败（新增 `tests/tool-role-trimming.test.ts` 5 例；`T8-4` 断言更新为「failed 不产生完成通知、但必须产生终止通知且幂等」）；`reports/T7_anchors_check.js` 改为按内容定位并减掉已修复的 OV-08 锚点，78/78 成立（行号未变 42、漂移 36、缺失 0）。

- **事故口径**：T4 已派 agent-2/agent-3（行业景气专家、资金面专家），看板逐条显示两名专家完成；但 T4 行/状态查询仍显示未完成，用户看到“已完成”和“没完成”两种结论。
- **源码级根因**：不是第二份状态，也不是缓存。看板读取 `delegates[].status`，计划行进度与 `dsh_workplan_status` 以行级 `status` 为权威；旧版没有一个同源聚合字段说明“下级全部 done、但部门负责人尚未汇总收尾”，于是两个不同层级的事实被读成同一层级的矛盾。
- **源码级根因 2（目标会话实测）**：行业景气/资金面两个叶子会话已经 `turn/end`，甚至已输出普通文字结论；但收尾缺少合格 `WORKPLAN_EVIDENCE` 结果块，严格结算不能记 done。若异步结算回调再被吞，`delegates[].status` 会永久停在 `running`，与会话侧“已结束/已完成”的观感冲突。
- **修复（src/plan.ts / src/runtime.ts / src/client.ts，标记 [3.1.5]）**：新增 `deriveDelegateCompletion` 读时纯函数并挂入 `normaliseStatusEntry` 与 `modelStatusLines`，输出 `delegateCompletion={total,done,failed,running,rejected,blocked,timeout,escalated,allDone,awaitingLeaderSummary}`；客户端在行未完成但下级全 done 时明确显示“下级专家已全部完成，正在等本行负责人核验并汇总”。不自动把 T4 改 done，部门汇总 F11 与证据门禁仍由负责人收尾。
- **修复 2（src/runtime.ts `reconcileEndedDelegateSessions`，标记 [3.1.5]）**：负责人 `delegate action="status"` 时按叶子会话日志重放最后助手正文：合格 F10 汇报补结算 done；普通正文/缺结果块按实收敛 failed；phase-0 工具调用结束、待指示、无会话/回合仍开均不误杀。
- **回归**：新增 `tests/delegate-completion-projection.test.ts` 4 例与 `tests/delegate-ended-session-reconcile.test.ts` 4 例（全 done/in_progress、部分失败、无分工与 replanned 旧行、快照与模型可读面同源、结束无块收敛 failed、phase-0 不误判、待指示不覆盖、unknown/open 不变）；版本声明统一 3.1.5。

## 3.1.4 — 2026-11-20（「用户已同意、插件却毫无反应」二次治本：确认识别改句式模板 + 闸门静默兜底提示 + 版本自报 ＋ 工具执行中插通知致 400 INVALID_REQUEST 治本：mid-exchange 通知暂存补发）

- **事故（2026-11-20，会话 session-aa38d8c0-e197-4e5e-bf1c-55c96fdab089 实测存档）**：主 Agent 调用 `dsh_workplan_replan` 期间，插件把【重规划】通知直接写入会话，落在 assistant 工具调用与 tool/result 之间。DSH 核心按落盘顺序 1:1 投影消息、pi-ai 原样转发，Kimi/OpenAI 兼容 API 拒绝该序列：`messages with role 'tool' must be a response to a preceeding message with 'tool_calls'`（400 INVALID_REQUEST），整轮崩溃。
- **根因（双重）**：①插件 `appendUserMessage` 不区分时机，工具执行中插话破坏 wire 序列（assistant tool_calls → user → tool 违例）；②DSH 核心 `deriveMessages()` 无排序兜底，非法序列直达 API。
- **修复（src/plan.ts，标记 [3.1.4]）**：①新增 `surfaceAwaitingToolResult` 时机检测 + mid-exchange 通知内存暂存队列——工具结果落地后自动补发（100ms×6000 有界 unref 保险丝 `midExchangeFlushPoll`，超时强制补发后自停；已在 handle-policy 白名单按卫生类登记并附分类理由）；②空闲/已结算会话保持同步写入，零回归。
- **核心侧配套**：`@deepseek-ai/dsh-session` 派生历史新增 `repairDerivedHistory` 排序兜底（已向 deepseek-ai/deepseek-harness 提 PR），任何来源的错序都到不了 API——双层治本。
- **回归**：新增功能测试（工具执行中不立即写 / 结果落地后补发且位置在 tool/result 之后 / 空闲与已结算会话同步写，共 5 例）；复现脚本以真实存档转录验证修复后序列合法；全量 1365 通过 / 0 失败。

- **事故（2026-11-20 本会话实测，计划 wp-cff638b6）**：主 Agent 依据总任务「先出计划、经用户认可后再开始执行」生成 6 阶段 13 子任务计划并按住闸门。用户回复「全部按你建议执行」——插件无任何通知、计划停 0/13 挂死；用户只能反过来问「为什么没开始分配」。
- **源码级根因（第一根因，方法错）**：`isUserConfirmation` 走「信号词 + 填充词表穷举、剥到空串」判定，残留的「全部」二字吃不掉即判 false。实测 27 条日常同意句 **25 条漏判**（「全部同意」「全都同意」「完全同意」「完全没问题」「我完全同意」等）。用封闭词表穷举开放句式必然持续复发。
- **第二根因（静默）**：`onPreStep` 遇到「认可闸门按住」的计划直接 `return downstream`，既不派发也不提示——用户永远不知道闸门卡在哪，即使分类器再漏判也不该一声不响。
- **第三根因（自报版本错误）**：`src/host.ts` 提示词硬编码「本插件当前版本为 3.1.0」，与 `meta.version` 脱节，误导主 Agent 与用户。
- **修复（src/plan.ts / src/runtime.ts / src/host.ts，标记 [3.1.4]）**：① 新增 `CONFIRMATION_TEMPLATES` 四条锚定整句模板（纯同意 / 按建议执行 / 就这么办 / 听你的），与词表通道取并集，句中任何实质内容（「可以，但范围改成X」）仍无法匹配；② 闸门按住时按消息原文去重发一条可见提示（计划 ID、完成度、回复「认可」或调用 `dsh_workplan_release` 的放行方式），不刷屏、不自动派发；③ 版本号单源 `PLUGIN_VERSION = '3.1.4'`，提示词由常量渲染，新增测试锁定 `meta.version === PLUGIN_VERSION`。
- **行为对照**：闸门按住时回「全部按你建议执行」→ 自动解闸并下达派发指令；回「这个方案我还有别的想法」→ 保持按住并给出可见提示（同句重复只提示一次）。
- **回归**：新增 `tests/workplan-confirmation-natural-phrases-3-1-4.test.ts`（30 条正例、原 3.0.7 正例不退化、20 条反例仍排除、闸门解闸/提示/去重、版本单源）；全量 1366 例。

## 3.1.2 — 2026-11-19（「用户认可后插件不再运行」死锁治本：确认识别单条口径 + 收件箱盖章 + 取代豁免）

- **事故（2026-11-19 晚，本会话实测）**：用户对任务回复「认可」，插件毫无反应、任务分解反复重启且永不落地（notices/journal 双实证：四次后台分解无一存活、无任何确认接收通知）。前一会话（wp-b26c6d56 同型任务）同因流产。
- **源码级根因（第一根因）**：消息分类双口径自相矛盾——`onInboxInserted` 用【单条消息】判断（能认出「认可」），`onPreStep` 的确认路由与取代逻辑用【全量用户消息拼接文本】（`taskTextFromMessages`）判断，单条确认被原始任务文本淹没，分类器集体失效。3.0.7 注释承诺「确认回复会被 pre-step 标记 userConfirmed」，但拼接口径下从未兑现。
- **死锁链**：确认消息落到「真实任务」路径 → 取代（杀死）在途后台分解 → 分解永远完不成 → 认可闸门（approval gate，按用户总要求「经认可再执行」合法拦截）等不到确认信号 → 再启动新分解 → 被下一条消息再杀，循环死锁。
- **修复三件套（src/runtime.ts，标记 [3.1.2]）**：① 收件箱认出确认即当场 `planning.userConfirmed = true` 盖章并回复用户，规划完成 settlement 自动放行派发；② 确认路由触发条件改用最新单条人类消息（`lastHumanText`），通知引用原文同步改单条；③ 取代逻辑新增单条豁免——寒暄/空泛续跑/状态提问/确认回复不得取代在途后台规划。
- **行为对照**：分解跑一半时发「认可/继续/谢谢/进度如何」→ 全部放行不杀分解（修复前全杀）；发真正新任务（「重新生成计划并执行」「可以，但要把范围改成…」）→ 正常取代（不误豁免，修复未扩大）。
- **回归**：新增 `tests/workplan-confirmation-single-message-3-1-2.test.ts` 5 例（收件箱盖章、死锁现场复演放行、跟进消息三连豁免、新任务取代对照、带条件回复判新需求）；全量 1358 例零回归；版本断言随定版升级 3.1.2。

## 3.1.1 — 2026-11-19（跨会话登记缺陷治本：结算自动归并 + 登记原文回注）

- **事故（2026-11-19 晚，计划 wp-b26c6d56 T2/T3，EVIDENCE_INCOMPLETE 连环退回）**：部门负责人在自己的会话经 `action="direct"` 代登记开工证据（T2 problemAnalysis 8 条/1242 字），平台另开**全新执行子会话**承接——接续提示只转述「已登记」，登记**逐字原文从未进入交卷人上下文**；执行者凭任务书重写更短摘要（6 条/471 字）→ 结算闸开工-结算一致性比对判「变薄」→ 退回；重试只回数字不回原文，补报退化成凑字数游戏（重试会话原文自述 "I don't have the exact startPhases text"），重试仍在大概率再被退回。根因：登记人（负责人会话）≠ 交卷人（执行会话），比对的数据源错了对象。
- **结算自动归并（five-step.ts `mergeStartEvidenceIntoSettlement`）**：结算一致性比对前，先把行级登记 startPhases 与交卷 phases 取**并集**落账（交卷条目在前、登记条目按原序补入、trim 后逐字去重、每清单封顶 20 条）——登记内容是任务的 durable 事实，不因交卷人未复述而减少；「宽容新增」语义不变，「禁止变薄」由平台侧保证，比对保留作安全网（仅封顶截断装不下登记条目时才真退回）。
- **登记原文回注三路**：① phase-1 接续提示（`buildPhaseZeroContinuationHint` 新增第 4 参，runtime.ts 调用点传 `effortRow.startPhases`）；② EVIDENCE_INCOMPLETE 回喂消息（runtime.ts lastFailure 新增 `registeredStartPhases` 字段，`buildChildPrompt` 渲染「逐字抄入」登记原文块）；③ 负责人自配档接续提示（runtime.ts 由截断 200/300 字摘要升级为全文渲染）。direct 路径禁派文案（llm-rules.ts）同步追加收尾复制纪律。五条提示词链路全部明示「原样收录登记条目再追加，照抄不要重写」。
- **回归**：新增 `tests/workplan-start-evidence-merge.test.ts` 10 例（M1–M3 归并单测、R1 原文渲染、A1 薄交卷+登记判 done 且落账含登记条目、A2 缺块零回归、A3 封顶安全网仍 blocked、P1/P2 提示词回注、E1 direct 跨会话首跑即 done）；全量 1354 例零回归；版本断言随定版升级 3.1.1。

## 3.1.0 — 2026-11-19

- 专家上限 12→25 整套同步（sources 30、存档消毒、提示词、测试）；dispatch 按钳制前声明判复杂（静默截断治本）；超上限拒收替代静默截断（HEADCOUNT_MAX）；重派跳过已完成成员；排队可见化（通知+queuedMs+等待上限可配）；上限/规划并发环境变量化；降级消息可行动指引；测试全局台账隔离
- 恢复取消/取代信封的文本标记块双写：T7（v3.0.0）把信封迁出可见文本后，1.8.19 等旧版读端只剩文本标记通道，旧回放读不到终态、安全降级契约破坏（v3.0.0–v3.0.9 潜伏回归）；3.1.0 起双写，W5 跨版本探针六断言全 PASS

## 3.0.9 — 2026-11-19

- 3.0.9：五步工作法全量审计修复——结果块模板补 approachBasis 字段、全部结算阈值渲染进提示词（消除「40/40/20」简写遮蔽 resources/tools/prepared/evidence 四项下限）、五步证据不完整接入有界回喂（EVIDENCE_INCOMPLETE 闸）、负责人汇总 F11 校验接线生效、缺块/退回改结构化标志（不再依赖错误文案正则）；专家汇报回调强制结构化 JSON 结算（非法 JSON 绝不计 done）；取消 engines.dsh 版本门槛，各版本 DSH 均可安装使用

## 3.0.8 — 2026-11-18（废除两轮深度思考，五步工作法单框架）

- **废除「两轮深度思考」开工门禁**：2.5.1/2.5.2 引入的 deepThink 两轮产物（主 Agent dispatch / 负责人 review+direct / 专家 self_effort 三处硬门禁）与五步工作法（2026-11-17 引入）长期双轨并存——两轮内容本就是五步第 1、2 步的子集，同一内容双份提交、无一致性比对，且模块名/错误信息仍停留在三阶段口径。本版按用户裁决彻底废除 deepThink 双轨，五步工作法成为唯一框架。
- **开工闸升级**：三处开工门禁统一改查五步第 1/2/3 步证据 `startPhases`（第一步任务梳理 ≥40 字、第二步资源 ≥20 字/工具 ≥10 字/方法 ≥40 字/依据 ≥20 字、第三步准备与就绪证据各 ≥20 字）；错误码 `DEEP_THINK_*` / `MAIN_DEEP_THINK_*` → `START_EVIDENCE_MISSING` / `START_EVIDENCE_INCOMPLETE`（direct 动作为 `DELEGATE_DIRECT_START_*`）。
- **开工-结算一致性比对（新）**：结算时若行级已登记 startPhases，`phases.planning` 各清单条数与合计字符数必须 ≥ 开工登记值——收尾证据不得稀释开工时登记的第 1/2/3 步证据，违反即判 blocked（错误文案「开工-结算证据不一致」）。
- **consolidation 瘦身**：分工表不再内嵌开工证据，`ConsolidationInput` 只剩 `taskReasoningEffort(+Declared)` + `assignments`；`planDelegations` 删除三道两轮字数闸，开工证据一律经 `startPhases` 提交登记。
- **三阶段→五步全量改名**：`three-phase.ts` 删除，新模块 `five-step.ts`（契约版本 4）；状态字段 `mainDeepThink→mainStartPhases`、`delegateDeepThinks→delegateStartPhases`、`delegates[].deepThink→delegates[].startPhases`（durable 键同步，历史存档零迁移：读不到即回 phase-0 补交）；verify 工具与全部提示词口径统一为「第四步核验/五步证据」。
- **回归**：开工闸（START_EVIDENCE_* 缺交/太薄/边界 40-40-20-20-10-20）、开工-结算一致性比对、consolidation 瘦身、改名回放全链测试全量改写对齐；版本断言随定版升级 3.0.8。

## 3.0.7 — 2026-11-18（用户确认回复：自动放行并派发对应任务）

- **事故背景**：用户对计划回复「按你的建议执行」，旧的三类分类器（社交消息 / 空泛追问 / 进度提问）都不认确认回复，它就被当成全新任务——先把原任务在途的后台分解取代中止，再对这句确认本身启动新一轮分解；下一条消息又取代这一轮，任务永远开不了跑（无限取代循环）。本会话 2026-11-18 实测复现。
- **用户想法（原话）**：「收到用户确认回复后，你应该结合所有上下文全面、深入分析、思考、研究后，开始依据得出的所有结果分配任务」。
- **新增 `isUserConfirmation`（plan.ts）**：与三个既有分类器同层的纯函数判定。保守、可证三条件——文本 ≤24 字符；含至少一个认可信号词；不含任何否定词，且剥掉全部信号词与填充词后必须一个不剩。任何实质内容都会落选：如「可以，但范围改成X」回落到常规新任务路径——以该消息为最新输入、结合全部上下文**重新分解**（＝深入分析）后按新计划分配任务，正是用户裁决的语义，而不是误当纯确认直接开跑旧计划。
- **用户补充裁决（2026-11-18，同版本吸收）**：「用户确认后，无论任务是否已经生成，都必须结合所有上下文和用户的回复，全面、深入开展分析、思考、研究，然后依据得出的所有结果开始分配任务」——**分析在先、派发现在**。据此，maybePlan 确认分支（runtime.ts）按当时实际状态分三种情形：① 已有计划未派发（含被认可闸门按住的）→ 解除按住（`gateHistory` 落档 `by:'user'`）、刷新 `conversationContext` 为含确认消息的全量上下文，并向主 Agent 下达**分析-派发指令**（必须 deepThink 登记完整分析后 `workplan_dispatch`；分析发现计划需调整则先 `replan` 再派发）；本回合标记 activeTurns，主 Agent 若未在回合内派发，收尾闸门拦停 steer 兜底，不留「确认后无人派发」的尾巴。插件不在钩子层不经分析机械开跑。② 后台分解在途 → 标记 `planningEntry.userConfirmed`，原分解不被取代中止；后台分解本身就是结合全量上下文的深入分析，计划一生成即跳过认可闸门、刷新上下文后自动派发（＝依据分析结果分配任务）。③ 其余（执行中/无计划/社交场景）→ 原样放行，绝不把确认当成新任务重新分解。plan 模式（先审后执行）下确认只记录不派发，保护不变。
- **双保险**：`onInboxInserted` 的取代守卫同步排除确认回复，确认消息不会先把原规划中止掉；重复确认只通知一次。
- **回归**：新增 `tests/workplan-user-confirmation.test.ts` 7 例（事故原句、中英正例全集、含实质内容反例、长度/类型/标点边界）；版本断言（package.json / tool-surface fixture / host meta）随定版升级 3.0.7。

## 3.0.6 — 2026-11-18（审计后第 1–4 批：数据安全、并发排队、看板开销、收尾闸门与复审修复）

- **永久记忆不再可能被整体清空**：`recordLesson` 读文件失败（EACCES/EMFILE/EIO/路径被目录占用）时直接抛 `LESSONS_READ_FAILED` 并拒绝写入，不再把“读失败”当成“空文件”后覆盖；重写时把无法解析的坏行原样带回文件末尾；覆盖前留一代 `<file>.bak`。
- **journal 回读不再误报成功为失败**：写后校验从“只看末 5 行”改为全文件定位本次写入，避免并发追加把刚写入的行挤出窗口后误报 `JOURNAL_READBACK_FAILED`、调用方重试又重复写一条。
- **看板响应上限按字节计**：`body.length` 改为 `Buffer.byteLength`，截断后复检；先减会话数，再丢单会话大块明细，最后只留摘要，任何一级都返回合法 JSON。
- **鉴权 fail-closed**：`connection.requestRejection` 不存在时返回 503，不再因可选链静默放行全部会话计划。
- **文档更正**：README 不再声称“不写磁盘”“并发固定 5 个”；如实写明 journal/lessons 两类落盘文件，以及 5 个/轮 + 宿主 `maxActiveSubagents`（默认 8）的真实并发边界。
- **回归**：新增 4 例（读失败拒写、坏行保留 + `.bak`、字节截断、未超限原样返回）；全量 **1218 例：pass 1217 / fail 0 / cancelled 0**（1 例 todo）。

### 第 2 批：并发上限排队、看板轮询合并、静态资源缓存、留痕可选清理

- **撞宿主并发上限不再直接判失败**：新增 `startActivationQueued`，三处 `subagents.startActivation`（主导派发、自配档接续、成员派发）撞 `ACTIVATION_LIMIT_REACHED` 时按指数退避（1s→15s）+ 全局冷却等待空位，最多等 10 分钟；等待期间不写失败状态、不消耗子任务 attempt，取消时抛 `ABORTED`，等满才如实报“仍未等到空位”。
- **看板轮询按会话共享**：同一 `sessionId`（或“全部会话”）只保留一个 4 秒轮询器和一组订阅者，最后一个订阅者卸载时停止；不再每个 `TurnCard` 各发一份请求。
- **图表库只读一次**：`/dsh-workplan/vendor/chart.umd.js` 首次读取后缓存 Buffer，后续请求不再每次 `readFileSync` 210KB；读取失败不缓存，仍可重试。
- **留痕可选清理（默认关闭）**：新增 `journalRetentionDays` / `DSH_WORKPLAN_JOURNAL_RETENTION_DAYS`，默认 0 = 永久保留；正数时启动及每 24 小时删除超过该天数未更新的合法 `<planId>.jsonl`（跳过符号链接，单次最多 200 个最旧文件）。
- **回归**：新增 4 例并发排队 + 5 例留痕清理 + handle-policy 白名单登记；全量 **1227 例：pass 1226 / fail 0 / cancelled 0**（1 例 todo），`npm run build` 已同步 `lib/`。

### 第 3 批：收尾等待上限、专用通知台账、结构化门禁死锁修复

- **回合收尾不再无限等待**：`agent/turn-stopping` 等待在途规划/派发新增上限 `turnStoppingMaxWaitMs` / `DSH_WORKPLAN_TURN_STOPPING_MAX_WAIT_MS`（默认 60 分钟，0 = 无限旧行为）。到点不杀任务：计划仍在后台执行、结果照常落盘；交互式按「等待预算耗尽」放行但留痕（`releasedIncomplete.reason='wait-exhausted'` + 每回合至多一条通知），fail-closed（headless）抛 `WORKPLAN_WAIT_EXHAUSTED` 并以错误收尾。只约束收尾等待，不构成部门/专家执行时限。
- **专用通知台账**：宿主禁止插件新增 Session 事件类型（重启会拒开）且 `appendPluginRecord` 保留给实验包，故通知权威流落在插件自有 JSONL（默认 `~/.dsh/workplan/notices.jsonl`，`DSH_WORKPLAN_NOTICES_FILE` 可覆盖）：`appendUserMessage` 每次成功落盘 workplan 通知即同步记一行（sessionId/planId/kind/form/summary/text + 对应 surface seq），与用户真实输入彻底分离；写失败不拖垮投递，失败行进内存环形缓冲（上限 100）下次补落，绝不静默丢弃。
- **结构化门禁死锁修复**：复杂任务按裁决强制 ≥8 名专家（上限 12），而部门汇总 `sources` 必须逐人覆盖全部已派发专家——旧实现把 `sources` 也卡 6 条精简上限，7–12 人的部门永远交不出合法汇总。现 `sources` 单独放宽到 16 条（其余三个数组仍 6 条），契约文案同步。
- **回归**：新增 4 例收尾等待上限 + 5 例通知台账 + 1 例 sources 覆盖（12 人通过 / 其余数组仍限 6 条 / 第 17 人仍拒）；测试进程全局隔离台账路径；全量 **1237 例：pass 1236 / fail 0 / cancelled 0**（1 例 todo），`npm run build` 已同步 `lib/`。

### 第 4 批：复审修复（自引入回归 + 高危缺口 + 中危加固）

**自引入回归（第 1–3 批的收尾）**
- **journal 回读 O(n²) → O(窗口)**：写后校验不再全文件重读，只读末尾 64KB 窗口内定位本次写入（O_APPEND 保证新行必在末尾）；单行体积超窗口的极端情形会在错误信息里如实呈现末 5 行摘要。
- **通知台账有界且加固**：新增 `NOTICE_LEDGER_MAX_LINES = 5000`（`DSH_WORKPLAN_NOTICES_MAX_LINES` 可覆盖），超限原子重写为最新 N 行；目录 0o700、文件 0o600，写前 lstat 防符号链接投毒（跳过 + warn，不抛错）。
- **等待耗尽标志按派发实例复位**：三处 `dispatchPromise` 赋值前清零 `turnWaitExhausted`/`waitExhaustedNotifiedTurn`，同一记录再次派发不再被"零预算"秒放行、不再每回合误发上限通知。
- **F11 文案与门禁同源**：下发部门负责人的 comm-format 文本改为「keyResults/keyInfo/importantInfo 每项最多 6 条；sources 最多 16 条且必须逐人覆盖」，不再与放宽后的门禁相互矛盾。

**高危缺口**
- **僵尸 in_progress 回收**：重启/崩溃回放时，无人调度且失联的 in_progress 行降级为 blocked（留痕 + warn），既有重置/重派路径可接管，不再永远"正在做"；cancelled/superseded 计划的历史留痕原样回放不受影响。
- **salvaged 半截计划不再自动派发**：规划器只抢救出残缺结果时暂停自动执行，给用户一条可见通知，确认后再 `workplan_dispatch`。
- **bash 写保护绕过封堵**：`fileWriteGuardReason` 新增 shell 命令启发式（`>`/`>>`/heredoc、`tee`、`sed -i`、`mv`/`cp`/`install` 目标位、`dd of=`，按 `&&`/`;`/`|` 分段、去引号、20k 截断），已交付文件不能再用 bash 原地改写；只读命令不拦。
- **认可闸门否定/引用识别**：命中点前 40 字符窗口内出现否定词（不用/无需/不必/勿/别/禁止…）、制度转述词（原文/制度/规定/条款）或引号包裹时不再误触发，「不用经用户认可再执行」与粘贴的规章原文不再把计划按住。
- **澄清闸轮次上限**：同一会话连续 2 轮触发澄清后放行进入规划（30 分钟无触发自动归零 + `resetClarifyRounds` 导出），不再「越简短回答越问不出计划」的活锁。
- **看板三处**：`/plans` 轮询 15 秒超时（超时走错误路径 + 警告横幅，不再永久冻结）、后台标签页暂停轮询（回前台补一轮）、服务端截断标志（`truncated`/`omittedSessions`/`omittedDetail`）不再被前端丢弃，裁剪时看板显示"部分数据已省略"提示。

**中危加固**
- **lessons 仅限根会话**：`dsh_workplan_lessons` 增加根会话硬校验，子 Agent（含其他插件拉起的会话）不再能读全局跨项目经验文件。
- **本地文件权限收紧**：journal/lessons/notice-ledger 写路径统一 0o600 文件 + 0o700 目录 + 写前符号链接校验（lessons 遇符号链接抛 `LESSONS_WRITE_REFUSED`）。
- **原子门英文盲区**：句末符补英文句点（后跟空白/结尾才算，版本号 a.ts/1.12.0 不误伤）、并列词补 并/然后/接着/再（否定/频率语境不误伤）；报错如实报告截断后长度。
- **验收措辞归一化**：覆盖匹配前对验收项与子 Agent 文本做全角折叠、完成态前缀剥离（已完成/完成/已/done/yes）、标点空白归一，「换个措辞就永远 missing」的无限退回关闭；three-phase 私有副本同步。
- **prune 增强**：清理排除当前活跃计划（不再误删"活跃但安静"的审计留痕）、unlink 失败逐条 warn + `errors` 留痕、首次清理挪出激活路径（启动 10 秒后，随插件卸载清除）。
- **回归**：新增 77 例（journal/ledger 9、wait-cap 1、comm-format 1、client 轮询 7、认可闸门 14、澄清闸 14、原子门 6、验收归一化 8、lessons 守卫 9、zombie 2、salvaged 2、bash 守卫 22、prune 4 等）；全量 **1327 例：pass 1326 / fail 0 / cancelled 0**（1 例 todo），`npm test` 内置 build 已同步 `lib/`。

## 3.0.5 — 2026-11-17

- **机制改进（用户四步闭环）**：第三层专家遇阻必须 `dsh_workplan_escalate` 向部门负责人请示；负责人在答复前必须全面梳理该问题与本部门全部已派发任务执行状态、研究方案，并用 `dsh_workplan_instruct` 把决定投回原专家；原专家继续执行。
- **硬闸门**：任一第三层成员待指示时，`dsh_workplan_delegate` 的 `review/dispatch/direct` 一律拒绝改派/重派/降级（`DELEGATE_ESCALATION_OPEN`）；`dsh_workplan_instruct` 只允许答复已请示成员（`NOT_ESCALATED`），投递成功后原专家恢复执行。
- **回归**：新增 `tests/workplan-305-escalation-owner-continuity.test.ts`，并同步负责人 brief、专家任务书、工具描述与版本口径到 3.0.5。

## 3.0.3 — 2026-11-17

- release v3.0.3: latest source + version publish

## 3.0.2 — 2026-11-17

- **修复**：GitHub Actions Release 流水线补齐 `NPM_TOKEN` secret + `gh release create` 幂等（已存在则 upload --clobber），npm 发布不再 ENEEDAUTH/E403。
- **版本**：全仓版本号对齐 3.0.2。

## 3.0.1 — 2026-11-16

### 激活热修：`dsh_workplan_hold` / `dsh_workplan_release` 缺 output 契约导致插件启用失败（宿主 register 硬校验）

> **事故**：v3.0.1 在 DSH Web GUI 启用失败，横幅报错 `TypeError: tool "dsh_workplan_hold" must declare output { schema, render, presentationMeta? }`（`file:///…/dsh-workplan/lib/host.js`）。宿主 `ToolsService.register()`（dsh-tools）强制每个工具声明 `output { schema, render, presentationMeta? }`；这两个 3.0.1 新增工具把 `render` 直接挂在工具根上、整体缺 `output` 包裹，注册即抛 TypeError，整个插件条目激活失败（web/headless 两 profile 经符号链接同源皆挂，错误横幅停在第一个失败工具上，release 同款隐患一并修复）。插件自身 1195 例全绿却过不了宿主注册——测试套件此前没有任何用例按宿主契约校验工具定义，此次一并补上永久防线。

**治本改动（`src/host.ts`）**：

- 两个工具补齐 `output { schema, render }`：schema 覆盖 runtime 全部返回形（hold：`ok/planId/alreadyHeld/hold/code/error`；release：`ok/gateReleased/planId/note/hold/dispatch/code/error`），与文件内其它 12 个工具同款写法对齐；render 按宿主契约接收 `(args, value)` 并返回 `ContentBlock[]`（此前实现返回裸字符串，不符合契约）。
- 顺带修正 release 的 render 判定顺序：「未能解除」以 `gateReleased !== true` 为准——原实现只看 `ok === false`，会把「闸门已解除但 deepThink 门禁拒派发」误报成未解除（该分支 `ok` 恰为 `false` 但闸门已松，与工具描述「闸门保持已解除」矛盾）。

**回归**：新增 `tests/tool-output-contract.test.ts` 3 例（①全部 14 个已注册工具逐字复刻宿主 register 判定 + schema 形状 + render 返回 ContentBlock[]；②注册工具集与 `tests/fixtures/tool-surface.json` 清单逐字一致；③hold/release 门禁文案三分支语义）。另经宿主真实校验器（`@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` / `validateJsonSchemaValue`）对编译产物 `lib/host.js` 冒烟：14/14 通过。全量 **1206 例：pass 1205 / fail 0 / cancelled 0**。

**生效方式**：已 `npm run build` 并同步 `lib/`（web 与 headless 两 profile 经符号链接同源生效），**须用户手工重启 dsh** 后生效（禁止 Agent 自行重启）。

### 与 DSH 0.2.2-rc.3 内置 subagent 插件的冲突修复（全量审计后的 4 条真冲突，修 3 条 + 1 条文档声明）

> **审计结论**：工具名/配置键/事件无碰撞，4 条真冲突全部位于「插件 ↔ 内置 subagent 宿主 API/设置」边界。本条修复 3 条，第 4 条（双派发通道）以文档声明收口（内置工具无 per-agent 开关，preset toolFilter 改动面过大）。

**治本改动（`src/runtime.ts` + `package.json` + `README.md`）**：

- **[P0] `interruptByParent` 已在新版宿主移除 ⇒ phase-0 旧会话不再被中断（白跑烧 token、与 phase-1 重复工作）**。新增 `interruptChildContinuable()`（runtime.ts）：优先新版 `subagents.interrupt(target, { kind:'ancestor', agent })`（authority 携带活体祖先 Agent，语义等价于旧 'continuable'：中断当前回合、保留收件箱可接续）；旧版宿主自动回退 `interruptByParent`。三处调用点（selfEffortTool 接续、delegateTool direct/review 登记）全部改走该 helper。旧测试夹具只 mock 旧 API ⇒ 回退路径保持可用，全部旧测试不回改。
- **[P1a] 设置页 `subagent.maxDepth`（默认 1）与三层体系（需 2）语义错位**。经核实宿主源码，两条深度通道互不相干：设置页滑块只约束内置 subagent/subagent_fork 工具（经 `resolveMaxDepth()`），插件派发只认 `spec.maxDepth`（manager.ts `resolveChildDepth`），滑块任何位置都不影响负责人→专家流程。新增 `detectDepthOverrideConflict()` + `notifyDepthOverrideConflict()`：三处派发点在检测到该设置 <2 时向计划会话发**一次性**说明（讲清两通道设计、无需操作、如何保持一致），不阻断派发。
- **[P1b] 宿主并发上限 `ACTIVATION_LIMIT_REACHED` 原样透出**。新增 `describeSubagentActivationError()`：识别该错误（code 或 message 双口径），翻译为可行动中文提示（稍后重试 / 「设置 → 子代理」调大 `maxActiveSubagents`）；非该类错误原样返回不吞错。三处 `startActivation` 错误路径接入。
- **[P2] `package.json` 补 `engines.dsh: ">=0.2.2-rc.3"`**：此前完全无版本护栏，`interruptByParent` 漂移失效无人知晓；此后由宿主 plugin-compatibility 显式拦截过低版本。
- **[P2] README 新增「和 DSH 内置的子代理是什么关系」章节**：声明双派发通道事实（内置 subagent/subagent_fork 在插件子会话仍可见、绕过则不经任何闸门），并说明两个设置项对本插件的不同影响。

**回归**：新增 `tests/workplan-301-subagent-api-compat.test.ts`（8 个用例：新 API 优先/旧版回退/静默失败/异常吞掉、深度冲突一次性告警与各无冲突分支、并发上限翻译与非上限原样返回）。

## 3.0.0 — 2026-11-14

### 2026-11-15 本地机制修复补丁（认可闸门 + 死锁自愈；版本号维持 3.0.0，经用户确认后再定是否升版）

> **事故**：wp-e745a477 —— 用户任务原文写明「有疑问先问用户，经用户认可后再开始执行」，插件却在第一条用户消息上自动生成计划并因 `autoDispatch` 默认 true 立即派发；T1 子会话缺上下文升级待指示后子会话失联，`NO_CHILD` / `ESCALATION_OPEN` / dispatch 被待指示行挡住，三条出口全堵，整盘卡死只能人工取消。

**治本改动（`src/approval-gate.ts` + `src/runtime.ts` + `src/plan.ts` + `src/host.ts`）**：

1. **认可闸门（keyword 半，默认开）**：计划创建时检测任务锚点里的「先经用户认可/批准/确认再执行」门槛语（8 类正则），命中则计划照出、按住不派（`dispatchHold` 落档，durable 回放与重启重建均还原），直到用户明确认可、主 Agent 调用 `dsh_workplan_release`。`DSH_WORKPLAN_APPROVAL_GATE=0/false/off` 只关这一半。
2. **认可闸门（manual 半）**：新增 `dsh_workplan_hold` / `dsh_workplan_release` 工具，关键词未命中时主 Agent 可显式按住/解除；解除登记 `gateHistory` 留痕并走 dispatch 全部既有闸门。plan 模式下 release 同 dispatch 被 toolGuard 拒绝。
3. **派发/收尾联动**：闸门按住时 `dsh_workplan_dispatch` 拒 `DISPATCH_HELD`；回合收尾 steer 与 headless 硬失败对 held 计划豁免（不再催派发）；未派发 held 计划不被下一条用户消息自动取消。
4. **死锁自愈**：`dsh_workplan_instruct` 遇到 `NO_CHILD` / `NOT_DIRECT_CHILD` 不再硬失败——把 escalated 行复位为 `pending`（合法迁移边）并登记 `reviveInstruction`（durable 透传 + 重建子会话时由 `buildChildPrompt` 注入提示词），下一次 dispatch 重建全新子会话并带上下达的决定。
5. **止血配置**：`cordis.patch.yml` 一度置 `autoDispatch:false`，全量回归通过后恢复 `config:{}`（默认自动派发 + 关键词闸门保护）。

**回归**：新增 `tests/approval-gate.test.ts` 19 例（门槛语 8 命中/3 不误伤/总开关/isDispatchHeld/revive 补丁与 applyStatus 集成/提示词注入/durable 透传）；`tests/fixtures/tool-surface.json` 登记 2 个新工具；全量 **1195 例：pass 1194 / fail 0 / cancelled 0**（基线 1175 全绿）。`docs/cc/ADV-FSP`（工具 12→14）与 `AVA`（AS-14/15）同步。

**生效方式**：已 `npm run build` 并同步 `lib/`（web 与 headless 两 profile 经符号链接同源生效），**须用户手工重启 dsh** 后生效（禁止 Agent 自行重启）。


> **定版依据**：用户 2026-11-14 明确要求「优化全部完美完成后，此插件版本定为 3.0.0」，并裁决发布方式为**仅本地**（改版本号 + 构建 + 回归 + 变更说明，不对外发布、不打 tag）。本节下方「low 任务禁止第三层下派」一段原为 2.5.5 候选改动，经用户裁决**整体保留为 3.0.0 基线的一部分**，故并入本节，不再单独定版。
>
> **基线原则**：2.5.4 已有的全部强制机制（四角色两轮深度思考门禁、复杂任务 ≥8 人、下属开工预估上报、单任务 ≤10 分钟判据、F1–F9 沟通格式）**一条不减**，本节 13 条改动只做叠加。

### 十三条底层机制优化（用户 2026-11-14 原话逐条对应）

1. **会话内必须显示用户刚输入的任务内容**（原缺陷：等待分配期间切换会话再切回，看不到自己刚输入的任务）。根因（`reports/T4b-会话内容丢失根因报告-20261114.md`，3497 个会话 / 4034 轮对照）：宿主在 pre-step 之前就认领用户消息，人类 `user/message` 只在首个 model step 内部落盘；插件却在 pre-step 里 `await runPlanner`，把这一步推迟到分钟级（含规划轮 p50=58.4s / p90=250s，不含规划轮 p50=0.04s），这段时间日志里没有可渲染的任务正文，屏幕上唯一副本是客户端回声，而客户端收到回执后无条件退休回声 → 切走再切回就空了。**治本**：pre-step 不再等待规划 —— 先同步放行本步并注入「正在分配、别自己动手」的说明，规划转后台（`src/runtime.ts` 的 `runPlanningInBackground`，同会话幂等、沿用本步 signal 的取消语义），计划一成即经唯一合规写入器 `appendUserMessage` 写入会话并照旧自动派发；首 step 秒级启动后宿主立即落盘人类消息。**加固**：`src/plan.ts` 的 `buildPlanMessage` 另把 `taskAnchor.text`（截断 4000）以「用户刚才输入的任务原文（只读锚点，与你最初的输入逐字一致）：」逐字写进计划消息，任何回放都能读到原文。

2. **收到任务即输出固定文案**：`任务正在分配中，请稍等一下......`。由平台在规划预告之前写入会话（`src/runtime.ts` 的 `maybePlan`，`appendUserMessage(..., { deferUntilHead: true })`），常量定义在 `src/v3-contract.ts` 的 `STATUS_ASSIGNING_TEXT`（6 个半角点，逐字冻结）。
3. **派发给部门负责人的每个任务必须附质量要求**：新增 `qualityRequirements` 字段并设为**必填**（`src/host.ts` 的 schema、`src/llm-rules.ts` 的 `DelegationAssignment`），缺失即拒 `DELEGATE_QUALITY_REQUIREMENTS_MISSING`；负责人任务书用 `renderQualityRequirementsBlock` 逐条渲染并注明下达方。
4. **分配完成即输出固定文案**：`任务已经完成分配，正在执行中......`。由 `src/runtime.ts` 的 `dispatchPlan` 在 `record.phase='executing'` 之后写入（`STATUS_ASSIGNED_TEXT`）。两条文案各只发一次，重试/续跑不重复刷屏（提示词同步禁止子 Agent 自行复述这两句）。
5. **负责人派出的每个任务必须极简（1+1=2）**：新增硬门槛 `checkAtomicAssignment`（`src/v3-contract.ts`）：单句、≤300 字符、≥8 字符、禁止并列多目标词（并且/同时/另外/还要/以及/分别/顺便）、禁止分号与多句，且必须带质量要求；不满足即拒 `DELEGATE_TASK_NOT_ATOMIC`，拒因附**可照做的拆小指令**（硬门槛，用户裁决 A）。
6. **派发给全球顶尖专家的任务必须交代成果要求与质量**：`src/llm-rules.ts` 的 `buildDelegateePrompt` 与 `buildPhaseZeroDelegateePrompt` 固定角色标签为「本部门相关领域全球顶尖专家」，插入质量要求块与专家汇报契约全文。
7. **专家成果必须极简、JSON 结构化汇报**：新增 F10 门禁与 `checkExpertReport` —— 字段仅 `keyResults` / `keyInfo` / `importantInfo` / `leadRequirements`，每条 ≤200 字符、每字段 ≤6 条，多余字段直接判不合规；重复内容用「完全相同 / 短条被长条包含（≥12 字符）/ bigram Dice ≥ 0.85 近义重复 / 去重键相同」四路拦截。
8. **负责人必须全面深入汇总本部门全部专家汇报**：F11 门禁用 `expectedExperts` 按名称核对 `sources` 是否覆盖全部专家，缺一即退回。
9. **取消部门组员角色**：`role` 枚举只剩 `['expert']`；历史 `member` 读取时归一为 `expert`（不报错、不迁移、不改历史日志）；`ROLE_MIX_REQUIRED` 配比门禁删除，改为「至少 1 名专家」；client 文案、three-phase 提示词、journal 新写入全部去掉组员。
10. **负责人汇总报告必须精简、禁止累赘重复、JSON 结构化**：新增 F11 与 `checkDepartmentSummary` —— 字段仅 `keyResults` / `keyInfo` / `importantInfo` / `sources`，同一套四路去重规则；超长或重复一律退回。
11. **汇总报告完成后必须直接交给主 Agent**：`settleFromOutput` 把 `departmentSummary` 持久化到任务行，`emitSubtaskDoneNotice` 在完成通知里原样附「部门汇总报告（JSON，直接交给主 Agent）：」+ 完整 JSON，不经二次概括、不裁剪。
12. **全部任务交回后由主 Agent 汇总最终成果**：`src/host.ts` 的 `PROMPT_SECTION` 新增 R12 硬规则（收齐全部部门汇总 JSON 后由主 Agent 统一深入汇总，不得把部门汇总直接当最终成果）。
13. **版本定为 3.0.0**：`package.json` / `package-lock.json` / `src/host.ts` meta / `tests/fixtures/tool-surface.json` / `README(.md/.en.md)` 安装示例全部同步 3.0.0。

### 兼容与回归

- **沟通格式规范升版**：`COMM_FORMAT_VERSION` 1 → 2，新增 F10/F11，**F1–F9 原文一字未改**；只有 `status==='done'` 且声明了层级（`tier:'expert'|'leader'`）时才追加对应条目，历史回放与旧日志零回归（有专门用例锁定）。
- **新增回归**：`tests/workplan-v3-contract.test.ts` 24 例（固定文案逐字、任务原文可见、质量要求归一与渲染、极简门槛各类拒绝、专家/部门 JSON 校验含 Dice 近义重复与去重键、F10/F11 层级接线、role=member 归一、版本 3.0.0）。
- **生效方式**：改的是 `src/`，运行中的进程不热加载 —— 已 `npm run build` 并同步 `lib/`，**须用户手工重启 dsh web** 后生效（禁止 Agent 自行重启）。

- **low 任务禁止第三层下派（用户裁决 D1–D6；计划 wp-43d5099c；实现规格 `reports/wp-T3-impl-spec-20261114.md`）**：
  - **D1/D3 判定链（钳制前）**：low 判定＝负责人自配 `consolidation.taskReasoningEffort`（钳制前原始声明，经 `taskReasoningEffortDeclared` 持久化记忆）→ 缺失时按任务行记录等级 `subtask.reasoningEffort` 兜底 → 两者皆缺＝「未配置」**视同 low** 一并禁派。判定链与 `complexTask`（决定 ≥8 人闸与 6/12 人上限）**完全解耦**（`src/llm-rules.ts:348` `banDeclared = … ?? declaredEffort ?? input.taskRowEffort`）。
  - **D2/D4 出口与拦截**：review 与 dispatch 共用唯一入口 `planDelegations`（`src/llm-rules.ts:352-360`），low（含视同 low）一律硬拒 `DELEGATE_LOW_TASK_FORBIDDEN`，拒因含「负责人亲自执行 + `action="direct"` 登记 + 40/40/20 字 + 无任何例外通道 + 历史派发不回溯」五要素；负责人改经新增动作 `dsh_workplan_delegate(action="direct")` 登记两轮深度思考产物后由平台以 low 档接续本人执行（`src/runtime.ts:8853`，schema `src/host.ts:862`）。direct 防旁路：复杂档/非法档 ⇒ `DELEGATE_DIRECT_EFFORT_INVALID`；携带分工表 ⇒ `DELEGATE_DIRECT_ASSIGNMENTS_FORBIDDEN`；缺/薄思考产物 ⇒ `THINK_MISSING`/`THINK_INCOMPLETE`（与主 Agent、叶子同一 40/40/20 判据）；叶子调 direct ⇒ `NOT_LEADER_SESSION`/`NO_PLAN` 路由隔离。
  - **D5 生效范围**：判据在「新下派请求时」计算，无迁移、无回溯、**不设独立配置开关**（由「无任何例外通道」推断，标注为推断项）；回退＝恢复旧版 lib ＋ 用户手工重启。
  - **D6 基线与路径**：基线 dsh-workplan@2.5.4，源码 `plugins/dsh-workplan`（符号链接至 web/headless 双 profile，改源码两端同时生效）。改动集中在 `src/llm-rules.ts`（新增闸＋可选 `taskRowEffort` 参数＋`taskReasoningEffortDeclared`）、`src/runtime.ts`（direct 分支、review/dispatch 传参、review 注入字段剥离、`gateAudit` 留痕、`SELF_EFFORT_MISSING` 文案指路 direct）、`src/plan.ts`（consolidation 消毒白名单＋负责人任务书/接续提示文案）、`src/host.ts`（schema enum 与描述）；`src/three-phase.ts` 零改动。
  - **验证与证据**：专用回归 `tests/workplan-low-delegation-gate.test.ts` 30 例（A 判定链 / B 非法值与拒因顺序 / C 钳制记忆与防注入 / D direct 出口十项 / E 钳制前后 / F S4 非 low 零变化 / G 端到端），加受影响 4 文件共 **5 文件 72 例全绿**；全量回归 **1138 例 / 1137 通过 / 0 失败 / exit=0**（日志 `/tmp/full-final2.log`）。四态与非法值映射见 `/Users/open/Documents/Stocks/reports/T4-回归用例与执行结果_20261114.md`；对照 D1–D6/S1–S6 的逐条验收见 `/Users/open/Documents/Stocks/reports/T5-low禁派机制-对照原要求验收报告_20261114.md`；历史 81 条红灯整体修复与归因见 `/Users/open/Documents/Stocks/reports/本轮最终结果-81条回归清零-20261114.md`。
  - **生效交接**：`node node_modules/typescript/bin/tsc -p tsconfig.json` 已构建并 `cp dist/*.js lib/`，`lib/` 已含改动；运行中进程不热加载，**须用户手工重启 dsh web** 后按 `/Users/open/Documents/Stocks/reports/T5-low禁派机制-对照原要求验收报告_20261114.md` §五命令复核（禁止 Agent 自行重启）。改动在工作树，未 commit/push/tag（发布归用户决定）。
  - **已知问题（如实登记，未擅自处置）**：① 版本递增号待用户定版；② `delegateSelfEfforts`/`delegateDeepThinks` 的 `slice(0,6)` 与 `delegates`/`estimates` 的 `slice(0,12)` 上限不对称（第 7 名起台账截断，decision-record §5-2「O2」）；③ `allowBanned` 豁免（专家预估上报必达主会话）与内部噪音禁止清单的规则冲突待用户裁决（F3）。

## 2.5.4 — 2026-11-12

- **机制缺陷治本（用户 2026-11-12 本会话实锤，③④⑥ 落地；②⑤ 经核实为有意安全契约，不 loosening）**：
  - **③ 子会话迟到结算不得削弱主 Agent 人工改判**：主 Agent 已以 structured 证据裁决 done 后，子会话迟到结算携带更弱 verification/acceptance 时不再覆盖人工证据（plan.ts applyStatus 保留人工 structured 验收）。
  - **④ 超时「待裁决」标记随 done 裁决清除**：行裁决 done 后 `pendingAdjudication=false`，界面/回放不再对已完成行显示「待裁决」（plan.ts applyStatus done 分支）。
  - **⑥ 叶子中止/失败时父级完成口径显式**：父行 done 但含 failed/aborted 叶子时，摘要自动点名这些叶子并说明父级完成依据为其余证据+主 Agent 复核，非该叶子自报完成（plan.ts applyStatus），消除「叶子没做完却说全完成」的口径歧义。
  - **②/⑤ 契约澄清（不改迁移表/覆盖守卫）**：reported→done/assigned 的拒绝与「只回一半/否定词反转不覆盖」是插件有意的防假完成契约（既有 204/Q6/U-16/T4 测试锁定）。本会话的误 blocked 实为子会话迟到结算写了非法 closure；remedy 走写入侧（结算不写非法 closure、人工补证带 A 编号），不 loosening 状态机与门禁。新增 tests/workplan-254-closure-gate.test.ts 7 例锁定 ③④⑥ + 契约原样 + 2.5.3 前置闸回归。
  - **版本一致性**：package.json / package-lock（两处）/ host.ts meta / tool-surface fixture / README(.en) 安装命令 / 本 CHANGELOG 统一 2.5.4。
- **生效交接**：npm run build 已执行；运行中进程不热加载，须用户手工重启 dsh web 后复核。
- **T6 下属开工前预估时间上报硬门禁（用户 D9：「没有告知部门负责人预估时间，先拦截，再告知此人，你必须自己预估时间，汇报给对应负责人后，才可以重试或继续执行」；契约 _t6_estimate_20261112/00-contract-estimate-v1.md FROZEN）**：
  - **self_effort 原子对新增必填 timeNotice**：`timeNotice={ declaredMinutes: 正整数分钟（Number.isInteger 且 1–10080）, reason?: ≤300 字符 }`；校验顺序 reasoningEffort → complexityRationale → deepThink → timeNotice（最后校验），缺交硬拒 `ESTIMATE_MISSING`、形状非法硬拒 `ESTIMATE_INVALID`（error 均含 D9 原话＋形状/非法原因），不登记、不接续 phase-1；成功返回附 `estimate:{declaredMinutes,reason?,delivery}`。
  - **kind=estimate 送达负责人（复用 T5 通道，不新建队列）**：登记（persistSelf）之后、interrupt/接续之前经 `ctx.subagents.sendMessage` 投递【第三层开工预估】消息至部门行负责人会话（row.childId，缺失回退 leaderId）；channelJournal kind 联合扩为 'escalation'|'instruction'|'estimate'，from.member/to 归属留痕；两者皆缺或投递失败 ⇒ `ESTIMATE_DELIVERY_FAILED`（delivery:'failed' 落档、不接续，重试重新投递并覆盖；已 sent 幂等不重复投递）；journal 写失败不掩盖投递结果（ok:true 附 journal:{ok:false,…}）。
  - **delegateEstimates 双通道持久化**：`delegates[].estimate` + 任务级 `delegateEstimates: Record<member,estimate>`（与 selfEffort/deepThink 同范式）；applyStatus fail-closed 消毒（非法子对象丢弃、非法 map 抛 `INVALID_DELEGATE_ESTIMATES`）、尝试重置保留、durable 回放白名单一处不漏（buildUpdateMessage/reconstruct 消费端/persistSelf/modelStatusLines/derivePlanSnapshot）；delegates 上限沿用 T8 同步值 slice(0,12)，8 人预估全部存活。
  - **重派未预估回 phase-0**：`leafPhaseZero = !priorSelf || !stashedThink || !stashedEstimate`——旧叶子已配档/已思考但未预估 ⇒ 回 phase-0 补交完整原子对；selfContinuation 文案附「预估已登记（含分钟数）」。
  - **schema 与任务书同源**：host.ts delegate schema 新增 timeNotice 属性与 T6/D9 描述；llm-rules.ts phase-0 提交清单与叶子 brief 同步「整数分钟、未上报不接续」；plan.ts 负责人任务书补「下属预估即时送达并留痕（kind=estimate），未上报者被拦截开工」（时长求和归 T7，T6 只存不算；T7 读 delegateEstimates/journal estimate 求和）。
  - **验证与生效交接（D8）**：测试与全量回归数字以负责人全量回归日志为准（reports/T6-lead-independent-verification-20261112.md）；机制说明与冒烟步骤见 reports/T6-estimate-gate-mechanism-20261112.md。无需安装/升级插件包，集成构建由负责人执行；运行中进程不热加载，**须用户手工重启 dsh web** 后按冒烟步骤复核（派 1 名下级 → self_effort 缺 timeNotice 应被 ESTIMATE_MISSING 拦截 → 补交后负责人收到预估消息并接续执行）。

- **七条底层机制全面优化（用户 2026-11-12 七项要求 R1–R7；计划 wp-437e264b，T1–T11＋T10R 全部 structured 验收通过；用户决策 D1–D10 见 reports/wp-user-decisions-20261112.md）**：
  - **R1/T3 负责人分派前两轮深度梳理硬门禁**：部门负责人 review/dispatch 共用同一质量闸——problemAnalysis≥40字、approach≥40字、approachBasis≥20字（与主 Agent/叶子同源常量 three-phase.ts MIN_PLANNING_*），缺/薄产物硬拒 `DELEGATE_CONSOLIDATION_INCOMPLETE`（拒因点名实际字数与下限），合格才放行；每次拒绝/放行记入 gateAudit 台账（有界20条、durable 回放、status 可查）。标记 [2.5.4][T3R1]。证据 reports/T3-gate-audit-20261112.md。
  - **R2/T4 复杂任务≥8人硬门禁**：`DELEGATE_HEADCOUNT_MIN`——声明档 medium/high/xhigh/max（`COMPLEX_DECLARED_EFFORTS`，钳制前判复杂、xhigh 不豁免）合计≥8人（`MIN_COMPLEX_DELEGATE_MEMBERS=8`）硬阻断，复杂上限放宽至12、非复杂保持6＋静默截断；仍≥1 expert＋≥1 member；持久化消毒上限同步 6→12（plan.ts `slice(0,12)`，门禁为唯一人数判据）。聚焦 tests/workplan-254-min-headcount.test.ts 11/11。证据 reports/T4-min-headcount-final-20261112.md。
  - **R3/T5 负责人↔专家↔组员双向沟通通道**：叶子 dsh_workplan_escalate 经 delegate 登记反查部门行（不再 NO_PLAN 断链）、instruct 放权直系父会话（lineage 硬校验）；新增 dept-journal.ts JSONL 留痕（坏行计 skipped）；消息接口契约 v1 冻结（_t5_channel_20261112/00-contract-v1.md）。20 往返 40 投递 0 丢、故障注入 10/10 DELIVERY_FAILED 显式可重试、契约测试 17/17。证据 reports/T5-message-interface-v1-20261112.md。
  - **R4/T6 下属开工前预估时间上报硬门禁**：见上条 T6（self_effort 原子对必填 timeNotice，ESTIMATE_MISSING/INVALID/DELIVERY_FAILED，D9 原话拦截）。
  - **R5/T7 负责人任务时长=下属预估之和**：读时派生纯函数 `deriveLeaderEstimate`（plan.ts）挂三读面（serialisePlan→normaliseStatusEntry／modelStatusLines／delegate status），只计每成员最新 delivery='sent' 的 declaredMinutes 算术和、不含负责人自身耗时；客户端只渲染禁求和、无新增持久化（D3 口径）。tests/workplan-t7-duration-sum.test.ts 23 例。证据 reports/T7-final-acceptance-agent27.md。
  - **R6/T9 负责人完美完成即时报主 Agent**：`emitSubtaskDoneNotice` 增强——验收结论 X/Y＋D7 完美判据（structured＋全 pass）＋逐条验收＋待主 Agent 执行事项（含 D8 手动重启建议）；head→root completion 留痕；wait/async 均 notifyCompletion:true。证据 reports/T9-final-verification-20261112.md。
  - **R7/T8 下属完美完成即时报负责人**：`emitDelegateDoneNotices`/`deliverDelegateDoneNotices`——done-only 过滤、sent 幂等、写时重读防竞态、DELIVERY_FAILED 显式＋failed 留痕＋下次结算兜底补发；两处结算接线。证据 reports/t8-full-suite-r3-20261112.log。
  - **T11 两处运行态缺陷治本（T6/T7 实测暴露）**：①重启早期负责人会话不可见时 selfEffortTool 不再误报 `SELF_EFFORT_NOT_LEAF`——按 childId 懒加载回退扫 state.records（真非叶子仍拒绝）；②deliverDelegateDoneNotices 及 extendMs/escalate/estimate 同路径 sendMessage 全部携带有效 signal（`new AbortController().signal`），消除 "Cannot read properties of undefined (reading 'throwIfAborted')"，恢复要求7完成汇报真实投递（保留正常取消语义）。tests/workplan-t11-runtime-defects.test.ts 6 例。证据 reports/T11-acceptance-20261113.md。
  - **T10R 最终回归验收**：7 条机制正反例锚定当前源码＋全量绿；全量回归 **1035 pass / 0 fail / 0 cancelled / exit 0**（基线 983→1006→1029→1035）、tsc 零错误。证据 reports/T10R-final-acceptance-20261113.md、_t11_runtime_defects_20261113/full-test.log。
  - **生效交接（D8）**：npm run build 已执行、lib 已含全部改动；运行中进程不热加载，**须用户手工重启 dsh web** 后按 T10R 报告冒烟步骤复核（禁止 Agent 自行重启）。改动在工作树，未 commit/push/tag（发布归用户决定）。

## 2.5.3 — 2026-11-12

- **重启后会话损坏治本（用户 2026-11-12 报告：Harness 重启后多会话报 SessionFormatError: system/message requires a protected first surface head）**：根因=规划期【规划预告】/【规划进行中】等通知经唯一写入器 appendUserMessage 以 user/message append 抢在宿主首条 system/message（protected head）之前落 surface；运行期不校验、重启冷读经 foldSurface 校验即整会话判损坏。修复=appendUserMessage 单点 protected-head 前置闸（头未就绪暂存、头就绪按序补发，plan.ts surfaceHeadExists/flushPreHeadNotices/preHeadNoticeQueue），零 schema 变更、不触碰 system/message。配套 scripts/repair-prehead-notices.mjs 对已损坏旧日志先备份 .bak-pre253、头前 workplan 通知改 log-only、离线复刻 foldSurface 校验通过才落盘；本会话已修复 4 份受损日志并留备份。回归=写入侧 deferral 用例（头前零泄漏/头后补发/首 surface=system/message）。
- **生效交接**：须用户手工重启 dsh web；活体会话日志静止后用修复脚本处理。

## 2.5.2 — 2026-11-11

- **「提交任务后长时间无反应」缺陷治本（用户 2026-11-12 硬要求：必须修复、禁止遗留；stall-fix 三条根因，均经本会话运行态实证）**：
  - **R1 负责人 phase-1 重新 review 触发无条件中断（最致命）**：旧代码只要 review 登记了整体档就 `interruptByParent`，而中断后的接续逻辑只存在于 phase-0 结算分支——负责人已在 phase-1 执行时再次 review（哪怕等级不变）会被中断且无人接续，子会话 aborted、产物丢失、台账 blocked，用户看到长时间停滞。本会话两个计划的 T1 负责人均以此方式死亡（wp-e5ea8772 T1 在 revision7 review 后 15ms 即 aborted，运行态复现）。修复：中断前快照 `hadEffortOverride`（runtime.ts:7497），仅当 review 之前未登记整体档（真 phase-0→登记 转变）才中断（runtime.ts:7529）；phase-1 重新 review 只更新梳理产物，绝不中断执行中回合。
  - **R2 规划器默认取家族最高推理档 → 单次规划实测 12-13 分钟**：预告之后长时间只有心跳没有结果，用户体验即「死机」。修复：默认档改家族中等档（qwen⇒medium、非 qwen⇒high，runtime.ts:855），中等档不在合法集时回落最高档（家族白名单语义不变），`DSH_WORKPLAN_PLANNER_REASONING_EFFORT` 显式覆盖保留；规划是结构化分解（中等复杂度），中等档保证质量并显著缩短首屏等待。
  - **R3 派发执行轮次期间零会话输出**：规划心跳只覆盖 runPlanner，执行轮次（可能十几分钟）期间无任何进度可见。修复：执行期进度心跳——createPlanningHeartbeat 工厂新增 buildMessage 注入，dispatchPlan 开始即 start（runtime.ts:3590）、finally 必 stop（runtime.ts:3863），默认 45s、`DSH_WORKPLAN_DISPATCH_HEARTBEAT_MS` 可调（≥5000ms），经唯一合规写入器发「已用时+完成进度+不是卡死」（buildDispatchHeartbeat，plan.ts:1797）；不新增事件类型、maxNotices 保险丝、中止静默，与规划心跳同一收束纪律。
  - **验证**：新增 tests/workplan-252-stall-fix.test.ts 7 例（R1 行为级中断计数：首次登记仍中断、已登记后同档/换档/不带档 re-review 零新增中断；R3 文案/假时钟周期/stop 收束/保险丝/中止静默/接线源码锚定；R2 源码锚定；四角色门禁冒烟不回归）；既有 5 例规划器默认档断言按新契约适配（effort-rules A3c 改 env 显式 max 触发修正轨、planner-effort-clamp 两例、planner-salvage 两例，断言意图「不继承主 Agent/家族白名单/能力钳制」零删改）。根因与证据链：reports/stall-fix-root-cause.md。
  - **生效交接（需主 Agent/用户执行）**：npm run build 已随全量回归完成；**运行中进程不热加载，须用户手工重启 dsh web**，重启后真实提交任务复现验证（提交即预告、规划提速、执行期心跳、re-review 不再中断）；主会话工具面缺失 dsh_workplan_* 属宿主侧暴露问题（子会话可调用），重启后复核，不在本插件源码可修范围。未通过真实链路验证前不声称运行态缺陷已消除。
- **规划期间心跳治本（用户 2026-11-11 报告：本会话 turn 1 规划 12.5 分钟全程零会话输出，用户以为死机并手动中断，turn/end reason=interrupted）**：根因是 runPlanner 的失败重试回报器（createPlannerProgressReporter）只在「失败且会退避重试」时发通知；一次**持续流式输出但很慢**的尝试（推理 chunk 不断重置 idle 窗口，最长可达绝对上限 900s）既不失败也不触发 idle，于是【规划预告】之后整段静默，用户无法区分「正在生成」与「卡死」。本版新增与失败重试**正交**的规划心跳：只要 runPlanner 还在跑，就按固定间隔（默认 45s，DSH_WORKPLAN_PLANNING_HEARTBEAT_MS 可调，≥5000ms）经唯一合规写入器 appendUserMessage 在会话里发一条【规划进行中】通知——含已用时（分/秒）、当前尝试序号（第 N/M 次，>1 才显示）、并明确「正在等待模型返回，不是卡死；完成后立即显示【任务分解】；失败会自动重试并另行提示」。goal 触发的规划走同一 maybePlan 入口，同样受益。
- **实现与安全性**：文案纯函数 buildPlanningHeartbeat / 间隔归一 planningHeartbeatIntervalMs / 依赖注入工厂 createPlanningHeartbeat 落 plan.ts（可脱离宿主单元回归）；runtime.ts maybePlan 在 runPlanner 之前 start、try/catch 外加 finally stop（成功/降级/中止都收束，绝不残留定时器，吸取 2.2.8/2.2.9 计时器教训）；onProgress 包装顺带记录当前尝试序号供心跳显示。写入仍是 user/message（surfaceOp:'append'、形状校验），**不新增任何事件类型、不触碰 system/message**，故不会引入会话日志损坏；maxNotices 保险丝（默认 40）防失控，真正收束靠 finally。不改任何 schema、工具参数/输出、重试/超时语义，旧计划零迁移。
- **主 Agent 两轮深度思考协议硬门禁（用户 2026-11-11 补充要求：插件底层机制必须确保主 Agent 自己也做到）**：2.5.1 已覆盖部门负责人/全球顶尖专家/组员三层执行者；本版把同一协议强制到主 Agent——执行自己的任务必须先全面、全盘、深入梳理、研究、思考自己的任务（第一轮），再基于第一轮完成好的所有结果再全面、全盘、深入地开展梳理、研究和思考，理清自己的思路与具体一步步执行、完美完成任务的方法、流程和步骤（第二轮），最后才基于第二轮的方法、流程、步骤开始具体执行。机制落点：`dsh_workplan_dispatch` 首次派发必须随附 `deepThink{problemAnalysis, approach, approachBasis}`（three-phase.ts `validateMainDeepThink` 纯逻辑判据，与执行者层同一 40/40/20 字下限），未交硬拒 `MAIN_DEEP_THINK_MISSING`、不合格硬拒 `MAIN_DEEP_THINK_INCOMPLETE`，拒绝不启动任何子 Agent、不刷派发预告；合格后登记计划记录 + durable workplan-update（计划级 subtaskId=null）持久化，续跑/重试/join/重启回放读档放行（reconstruct 消费侧 `sanitizeMainDeepThink` 同口径消毒，G1 写入/消费双侧接线）；按 planId 记账——重规划的新计划是新任务，必须重新两轮思考；NO_PLAN/PLAN_ID_MISMATCH/终态拒绝顺序不变。PROMPT_SECTION 主 Agent 硬规则与 dispatch 工具 schema/描述同源告知（提示词说服模型，代码守住边界）。新增 tests/workplan-251-main-deep-think.test.ts 13 例回归 + tests/helpers/main-deep-think.ts 共享夹具；既有 17 个测试文件 48 处 dispatch 调用统一以合格夹具过闸。旧计划回放零迁移（无新字段不报错；未登记产物时派发要求补交，属协议强制口径）。
- **叶子执行前两轮思考硬门禁 + 四角色少走弯路（用户 2026-11-12 要求：你/负责人/顶尖专家/组员执行自己的任务前都必须先两轮深度思考再执行，最高效率且全程少走弯路）**：2.5.1/2.5.2 已覆盖主 Agent（dispatch 门禁）与负责人（review 门禁），但专家/组员叶子只有任务书注入+结算时检查——思考产物在「执行后」才被迫补齐，不满足「先思考后执行」。本版把叶子 phase-0 提交升级为原子对：`self_effort` 必须同时携带合格 `deepThink{problemAnalysis, approach, approachBasis}`（与主 Agent 同一 `validateMainDeepThink` 判据、同一 40/40/20 字口径），缺交硬拒 `DEEP_THINK_MISSING`、不合格硬拒 `DEEP_THINK_INCOMPLETE`，不登记、不接续；两项齐全才登记并以自配档接续 phase-1——正式执行只能发生在两轮思考登记之后，接续任务书随附第二轮执行蓝图。持久化：`delegates[].deepThink` + `delegateDeepThinks` 台账经 applyStatus 消毒（非法/篡改丢弃，`INVALID_DELEGATE_DEEP_THINKS`）+ 尝试重置保留 + durable workplan-update 回放双侧接线（G1）；重派读档直接 phase-1（提示词声明「自配档接续·两轮思考读档」+ 不要重复提交），只有自配档没有思考产物的旧叶子路由回 phase-0 补齐（先思考后执行不留旁路；旧计划回放零迁移）。四角色协议文案同源加入「以最高效率执行、确保完美完成」与「全程少走弯路：先查历史教训、先验证再动手、不重复试错」（threePhasePromptLines / PROMPT_SECTION / buildLlmRulesBrief 两 tier / phase-0 与 phase-1 任务书 / dispatch 与 delegate 工具 schema），历史教训自动注入（lessons）为少走弯路底层支撑。新增 tests/workplan-252-leaf-deep-think.test.ts 8 例回归 + helpers 预登记思考产物；既有 self-effort 用例按新契约适配（断言意图零删改）。T1 差距诊断落盘 reports/T1-four-role-gate-diagnosis.md（含四角色矩阵与 file:line 证据）。版本号沿用 2.5.2（用户尚未定版是否递增，不擅自改动）。
- **版本统一 2.5.2（用户定版）**：package.json / package-lock.json×2 / src/host.ts meta / tests/fixtures/tool-surface.json / README 三语徽章与安装行（README.zh 漏改在本轮补齐）/ 版本回归断言（workplan-250-head-delegation 要求5 断言随定版升级）。新增 tests/planning-heartbeat-2-5-2.test.ts 回归（文案/间隔/假时钟周期触发/stop 收束/中止静默/保险丝/源码锚定）。生效需 npm run build 后由用户手工重启 dsh web（宿主侧无热加载）。

- **重启后真实链路验证结论（2026-11-12，T6 补记；stall-fix 生效交接闭环）**：用户已手工重启 dsh web（11:29:53，pid 16910，build b5a6fc479711c210，加载 11:23:20 构建；三证：lsof/libproc 启动时间/插件自报一致 + 启动晚于构建 + realpath 链路同一，reports/t2-restart-state-check.md）。重启后本会话（wp-cb91f412）即真实提交任务链路，交接项逐条活证据（父会话日志 seq/时间，详见 reports/post-restart-verification-report.md §2）：**提交即预告**✓（seq8 规划预告 @11:31:23，回合启动后 14 秒内；seq301 派发预告 @11:57:02）；**规划提速（R2）**✓（状态行 default-medium，seq33；实测规划 305.6 秒（约 5 分钟）含第 2 次尝试，对比修复前 12–13 分钟）；**规划期心跳**✓（seq9–14 共 6 条、间隔恰 45s）；**执行期心跳（R3）**✓（57 条【派发执行中】、轮内 54 个间隔恰 45s，轮次间按 finally 收束停止属预期）；**专家开工预估上报**✓（seq73/106/365–367/370）；**主会话 dsh_workplan_* 工具面**✓（主会话直接调用 11 次，重启前缺失未复现）。**如实标注**：「re-review 不再中断（R1）」本会话无活体案例，由 workplan-252-stall-fix 7 例行为级测试覆盖、待重启后活体观察；叶子先思考后开工门禁的登记环节活证据成立，但接续环节在运行进程中被 D1 杀死（见下条），修复后由 D1-1/2/3 测试覆盖、活体复验待再次重启。**重启后新鲜全量复测（T5b，runner 实测口径）**：npm run verify **850 pass / 0 fail / 0 cancelled / exit 0**（含 D1/D2 新增 7 例；重启前 stall-fix 末轮基线 843/0/0）、tsc 零错误（CHECK_EXIT=0）、定向 5 文件 39/39（FOCUSED_EXIT=0）、全日志 not ok=0；证据 reports/T5b-verify-full.log / T5b-check.log / T5b-focused.log 与 reports/T5b-regression-acceptance.md。
- **D1 叶子接续死亡 + D2 陈旧结算备份误采纳（用户 2026-11-12 硬要求：查明并必须修复 T1/T2 四个叶子子任务自动停止；诊断 reports/D1-D2-root-cause-diagnosis.md，修复 T4b，独立验收 T5b）**：
  - **D1 现象/根因**：四个第三层叶子在 self_effort 登记后 12–16ms 全部 aborted，接续会话从未创建、失败台账路径未执行。根因：selfEffortTool 用属性访问 `(ctx as any).agents?.get?.(leaderId)` 取负责人 agent，而 inject 清单（host.ts:82）不含 `agents`，Cordis 上下文代理对未注入服务的属性访问直接抛 `cannot get property "agents" without inject`（可选链挡不住代理 getter 抛错）；异常发生在 interrupt 之后、startActivation 之前且无 try/catch → 叶子永久死亡（叶子 cffc015b seq18 抛错原文、11:38–11:46 无新会话目录、projcache `(self:` 零命中实证）。
  - **D1 修复（T4b，最小治本）**：负责人 agent 解析移到 interrupt 之前，改宿主同款安全访问器 `ctx.get('agents')` + 整体 try/catch（旧夹具回退属性访问也在保护内）；解析失败 ⇒ 不中断 phase-0、自配档与两轮思考产物登记保留、显式 `SELF_EFFORT_CONTINUATION_FAILED`（重派读档直连 phase-1 路径可用）；接续 startActivation 的 signal 改独立 `new AbortController().signal`（平台驱动重激活不得被 phase-0 回合中断牵连）。落点 src/runtime.ts:7365-7382、7420；既有两次重试/失败台账/childId 更新/结算回调原样保留。
  - **D2 现象/根因**：结果块缺失时的盘上备份恢复路径读固定文件名 `reports/wp-settlement-<subtaskId>.json` 且无归属/新鲜度校验，误采纳陈旧 wp-settlement-T1.json（截图任务）→ T1 假完成、wp-settlement-T2.json（基金任务）→ T2 误 blocked，T3/T4/T5 级联冻结；跨计划复用同名文件使陈旧副本必然存在。
  - **D2 修复（T4b）**：采纳前双闸——新鲜度 `mtimeMs >= startedAt` + 归属（备份顶层 planId/subtaskId 必须与当前计划/子任务一致，裸 JSON 与证据标记块双入口）；任一不满足 ⇒ 不采纳、record.errors 审计留痕（含文件 mtime 与 startedAt 的 ISO 值）、落回既有 EVIDENCE_MISSING 有界回喂（缺失永不计 done 的严格性不变）；提示词同步要求备份本次执行新写覆盖旧文件、顶层必带 planId/subtaskId（childId 若已知也带）。落点 src/runtime.ts:2577-2640、src/plan.ts:5645。
  - **验证（T5b 独立验收，全部 runner 实测）**：新增 tests/workplan-253-continuation-settlement.test.ts 7 例（D1-1/2/3 + D2-1/2/3/4，全量 ok646–652、定向 ok17–23）；全量 850/850/0/0 exit 0、tsc 零错误、定向 39/39；14 个既有四角色门禁/stall-fix/结算套件逐一核验无回归；修复落点逐行读码核验全部命中；改动恰 5 个已跟踪文件（211+/24-）+1 新增测试，无夹带；测前=测后 HEAD/工作树/sha256 一致（证据绑定确切构建）。夹具契约适配披露：evidence-missing-retry A2 用例以 utimesSync 置未来 mtime 模拟「尝试内新写」，语义断言零改动（新契约直接要求，非放宽闸）。
- **生效交接（D1/D2，需用户执行）**：运行中宿主（pid 16910，11:29:53 启动）加载 11:23:20 构建、不热加载 lib/；盘上 lib/ 已含 D1/D2 修复（12:24:43 重建，哈希经 T5b 绑定），**须用户再次手工重启 dsh web 才在运行态生效**（规则 18，禁止自行重启）。**重启前过渡纪律**：第三层叶子派发在运行进程中仍会触发旧 D1 死亡——各部门负责人一律直接执行、禁止 delegate dispatch 叶子（review 分工表照常登记留痕但不下派）；负责人自身 phase-0→phase-1 接续不受影响（已实证存活）。结算备份纪律（D2 教训）：各子任务备份必须本次新写、顶层带 planId/subtaskId。重启后用 T2b 同款三证法复核加载新构建，并活体复验叶子接续与 re-review 不中断。版本号沿用 2.5.2（用户尚未定版是否递增，不擅自改动）。

## 2.5.1 — 2026-11-11

- **两轮深度思考协议（用户要求 1，底层机制升级）**：三阶段工作法的规划阶段升级为用户 2026-11-11 强制的「两轮深度思考」协议，部门负责人、部门里相关领域的全球顶尖专家、部门里组员三层执行者在执行自己的任务时同一口径：① 第一轮 · 任务深研——先全面、全盘、深入梳理、研究、思考自己的任务（→ phases.planning.problemAnalysis）；② 第二轮 · 理清方法流程步骤——基于刚才第一轮完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考，理清自己的思路，理清自己该具体如何一步步执行、达到最终完美完成自己任务的方法、流程和步骤（→ phases.planning.approach）；③ 执行——最后，基于刚才第二轮理清楚的所有方法、流程、步骤，开始具体的执行工作。三步顺序与依赖不可颠倒：第二轮必须消费第一轮的全部结果，执行必须消费第二轮的方法、流程、步骤。
- **第二轮依据成为结构化必填证据（新增 approachBasis）**：「基于前一步完成好的所有结果」不再只是提示词——phases.planning.approachBasis（至少 1 条、合计 ≥20 字）要求逐条写清第一轮的哪些事实/约束/矛盾决定了第二轮的哪些方法/流程/步骤，两轮之间的依赖可审计；缺依据/依据太薄 ⇒ 规划阶段判未完成（PHASE_GATE 回喂待补项），不得记 done。THREE_PHASE_VERSION 1→2；problemAnalysis/approach 字段名保留、语义升级为两轮产物。在途旧结算证据缺 approachBasis 时按既有有界回喂通道要求补齐（强制口径，不是静默放行）。
- **负责人再分配硬门禁同口径**：planDelegations 在角色配比校验之后新增两轮产物闸——approach（第二轮方法、流程、步骤）与 approachBasis（第二轮依据）各至少 1 条，缺一拒绝 DELEGATE_CONSOLIDATION_INCOMPLETE、dispatch 不放行；缺 problemAnalysis/assignments/角色配比的旧拒因顺序不变。dsh_workplan_delegate 工具 consolidation schema 同步新增 approachBasis 并把 approach/approachBasis 列为必填；applyStatus 消毒与 durable workplan-update 回放写入/消费双侧接线（approachBasis 刷新/重启不丢）。旧计划状态回放不报错（新字段缺省为空）；旧梳理产物缺第二轮依据时 dispatch 要求重新 review 补齐（协议强制口径）。
- **三层任务书注入单一事实源**：threePhasePromptLines 重写为两轮深度思考协议（第一轮/第二轮/执行依赖 + approachBasis 自检），二级任务书（buildChildPrompt）与三级任务书（buildDelegateePrompt）共享同一注入；buildLlmRulesBrief 负责人 tier 改写为「执行自己的任务先两轮深度思考，再执行与再分配」，专家/组员 tier 新增协议全文；两份任务书的执行要求各新增一条两轮深度思考强制行。dsh_workplan_verify 工具 planning schema 同步新增 approachBasis 必填。
- **版本统一 2.5.1（用户要求 3 定版）**：package.json / package-lock.json×2 / src/host.ts meta / tests/fixtures/tool-surface.json / README 三语徽章与安装行 / 版本回归断言（workplan-250-head-delegation 要求5 断言随定版升级）。新增 tests/workplan-251-deep-think.test.ts 回归；既有字段与校验原样保留。生效需 npm run build 后由用户手工重启 dsh web（宿主侧无热加载）。

## 2.5.0 — 2026-11-11

- **部门负责人再分配权限根因修复（用户要求 1）**：2.3.9 已交付 `dsh_workplan_delegate` 工具，但二级任务书 `buildChildPrompt` 的执行要求仍写着「不要派生新的 Agent」「你没有派发权限」——负责人同时收到「必须再分配」（llmRulesBrief）与「没有派发权限」（执行要求）两套矛盾指令，普遍不敢行使再分配。本版把禁令改写为精确边界：负责人**拥有本部门内再分配权限**（dsh_workplan_delegate，先 review 后 dispatch），禁令只针对主计划派发、重启/安装与第四层派生；并新增「本部门再分配权限与推理等级配置」授权段。规划器提示词同步改写（旧「子任务由子 Agent 独立执行：它们没有派发权限」→ 负责人牵头 + 部门内再分配权限）。
- **三层执行者推理等级自配置（用户要求 2，机制升级）**：由「负责人配置整体等级、下级未单独配档时继承」升级为**先配置后开工、各自自配全程自用、平台强制接续**。① 先配置后开工（平台强制）：部门负责人与第三层专家/组员会话在未登记自配档时一律以 low 启动 phase-0——唯一职责是评估自身任务复杂度并提交自配；负责人经 `delegate(action="review")` 的 `consolidation.taskReasoningEffort` 提交（即负责人自配整体档），专家/组员经新增 `delegate(action="self_effort")` 提交（`reasoningEffort`+`complexityRationale` 必填：缺依据拒绝 `SELF_EFFORT_RATIONALE_MISSING`、非法档拒绝 `SELF_EFFORT_INVALID`、非第三层叶子拒绝 `SELF_EFFORT_NOT_LEAF`、已结算拒绝 `ALREADY_DONE`）；phase-0 结束仍未登记自配 ⇒ 明确 `SELF_EFFORT_MISSING` 回喂（有界重试），禁止静默以 low 档继续正式任务。② 自配为权威：成员自配档为权威，分工表 per-member 档降为建议；下级不再继承负责人整体档，各层自配全程自用。③ 平台强制接续：宿主在子会话创建时解析推理等级、同会话换档不可行，故登记后平台立即 `interruptByParent(continuable)` 中断 phase-0 回合，新激活携带 phase-0 产物与完整任务书、以自配档接续同一任务进入 phase-1（继续勿重做；childId 台账同步更新，旧结算回调按旧 childId 自动失配）；接续不是重试——不消耗 attempt 预算；接续失败重试 1 次仍败则明确报 `SELF_EFFORT_CONTINUATION_FAILED`，禁止静默降档；每次激活（首发/重试/续跑/中断后新激活）经 `resolveTaskEffort` 单一判据读档，自配档优先于规划器档位；尝试重置后 `delegateSelfEfforts` 保留，重派直接以已自配档接续 phase-1（不再 phase-0）。④ 持久化与回放：负责人自配写入状态行 `effortOverride`，成员自配写入 `delegates[].selfEffort`（越界钳制留痕 `selfEffortRequested`）与 `delegateSelfEfforts` 回落源，均经 applyStatus 五档白名单消毒（非法 `delegateSelfEfforts` 拒绝 `INVALID_DELEGATE_SELF_EFFORTS`）+ durable workplan-update 回放（写入与消费双侧接线，G1 教训），刷新/重启不丢；越界档按模型家族合法集合钳制并留痕，非法整体档仍拒绝 `DELEGATE_TASK_EFFORT_INVALID`。旧「下级未单独配档时继承整体等级、整体也未配置则回落 low」的继承回落口径废止；无新字段的旧计划回放零迁移。
- **分解更简单、多人承担（用户要求 3）**：规划器提示词新增硬规则——每个子任务单一目标、单一主产物、可独立验收，执行细节下沉到部门内分工；负责人任务书与 delegate 工具描述要求每位下级只承担一项简单工作，expert 与 member 各至少 1 名、最多 6 人共同承担。
- **版本统一 2.5.0（最终定版，含版本统一说明）**：原「2.5.1」仅为版本标签改动、无任何功能差异，按用户最终指令定版 2.5.0 并入本条目，不再单独设节。版本号逐处统一为 2.5.0：package.json / package-lock.json×2（顶层 version 与 packages[""].version）/ src/host.ts meta / lib/ 编译产物（lib/host.js 等，由 npm run build 再生）/ tests/fixtures/tool-surface.json / README 三语徽章与安装行（三语徽章此前滞留 2.3.9，一并修正）/ 版本回归断言（tests/version-sync.test.ts 一致性断言、tests/workplan-250-head-delegation.test.ts 要求5 版本断言）。本轮按用户要求全程禁用插件执行，重新启用需用户手工重启 dsh web。
- 新增 `tests/workplan-250-head-delegation.test.ts` 回归；要求2 自配置机制新增 `tests/workplan-250-self-effort.test.ts` 9 例回归；既有字段与校验原样，旧计划零迁移。生效需 `npm run build` 后由用户手工重启 dsh web（宿主侧无热加载）。

## 2.3.10 — 2026-11-11

- **分配前会话内耗时预告（用户要求1，T2 最小机制补丁）**：此前耗时预告只有专家开工后的 timeNotice 上报，规划前与派发前会话内零输出。本版在三个落点追加机制（均为追加式 notice/提示词，不改任何 schema 与工具参数/输出）：P1 `runtime.ts maybePlan` 在 runPlanner 之前经唯一合规写入器 `appendUserMessage` 发【规划预告】——预估口径=单次规划窗口（normalisePlannerWindow 同源解析，含配置/环境变量覆盖）一半向上取整、至少 1 分钟，默认窗口 300s → 约 3 分钟，文案带窗口/重试口径与 O-5b「仅供参考，非承诺」标注；P2 `runtime.ts dispatchTool` 在通过全部拒绝闸门后、启动任何子 Agent 之前发【派发预告】——复用 `estimatePlanMinutes` 下界估算（estimateMinutes+并发度），按 planId 幂等守卫（重复派发/续跑/join 在途回合不刷屏，重规划新 planId 自然重新预告）；P3 `host.ts PROMPT_SECTION` 追加主 Agent 硬规则「调用 dsh_workplan_dispatch 前必须先在会话中告知用户预估耗时（含数值与单位分钟、非承诺标注）」。文案纯函数 `planningEstimateMinutes` / `buildPlanningPreAnnouncement` / `buildDispatchPreAnnouncement` 落 `plan.ts`，新增 `tests/preannounce-2-3-10.test.ts` 6 例回归；`workplan-stuck-recovery` 的轮级结果消息计数按该用例本意排除新增预告通知。estimateMinutes / reasoningEffort 等既有字段与校验原样，旧计划零迁移。生效需 `npm run build` 后由用户手工重启 dsh web（宿主侧无热加载）。

## 2.3.9 — 2026-11-11

- **LLM 家族检测 + 推理等级事前约束（用户要求 1/2）**：新增单一事实源 `src/llm-rules.ts`——模型 ID 去空白转小写后以 `qwen` 前缀判定家族；qwen 系合法推理等级集合 `{low, medium, xhigh}`、非 qwen 系 `{low, high, max}`，并按任务复杂度映射（轻度=low；中等 qwen=medium/非qwen=high；非常复杂 qwen=xhigh/非qwen=max）。约束在**发送前**生效：规划器默认档取当前家族合法集最高档、派发侧子任务档位先按家族静态集收窄、再与宿主声明档位取交集钳制，两道闸各自 `console.warn` 留痕（model/family/requested/corrected/allowed/reason）。`plan.ts` 校验、`replan.ts` 入口、`client.ts` 渲染口径同源消费；五档仍为存储全集，旧计划/他模型计划回放零迁移。越界档不中断派发，按强度序自动降级并留痕（报错轨 `validateReasoningEffort` + 修正轨 `correctEffortForModel`）。
- **第三层派发工具 `dsh_workplan_delegate`（用户要求 3/4/5）**：部门负责人子会话专用。`review` 先提交「全面、全盘、深入梳理」产物 + 分工表（problemAnalysis/constraints/unknowns/approach + 每位下级 member/role/task/reasoningEffort），`dispatch` 才放行——未登记梳理产物硬门禁拒绝（`DELEGATE_CONSOLIDATION_MISSING`），分工表必须同时含 ≥1 名顶尖专家（expert）与 ≥1 名组员（member）（`DELEGATE_ROLE_MIX_REQUIRED`）。每位下级按任务复杂度配置推理等级，经家族合法集钳制并留痕，随 spawn `agentOptions` 全程生效。层级边界：仅计划内部门负责人子会话可调用（根会话 `NOT_LEADER_SESSION`、第三层叶子 `NO_PLAN`/`NO_SUBTASK`），下级 spawn `maxDepth:2`，第四层由宿主绝对深度上限硬拒。要求 1/2 全文经 `buildLlmRulesBrief` 单一事实源注入部门层与专家/组员层任务书，杜绝两处漂移。
- **看板三层可见**：`client.ts` 任务卡片渲染「主 Agent → 部门 → 专家/组员」第三层台账（每位下级角色、推理等级含越界钳制留痕、实时状态），数据源为状态行 `delegates`，经 `applyStatus` 消毒 + durable `workplan-update` 回放，刷新/重启不丢。梳理门禁判据 `consolidation` 同样持久化回放。
- **工具面与安全文档同步**：新增第 12 个模型工具 `dsh_workplan_delegate`，`tests/fixtures/tool-surface.json` 与 `docs/cc`（ADV-FSP 功能规范 / AVA 攻击面 AS-13 / SECURITY-TARGET）同一变更内刷新。
- 注：2.3.3–2.3.8 未单独发布（按用户要求版本号直跳 2.3.9）。

## 2.3.2 — 2026-11-10

- **D1 用户附件全链路可见**（修复「规划器/子 Agent 看不见用户图片」盲区，commit 8b48796）：`messageText` 把 image/file/document 块渲染为含 attachment-id 的标注行，任务文本→锚点→派发提示→回放上下文同源覆盖；接收方以 attachment-id 直读附件，不再请示往返。全量回归 718/0/0。
- **D2 规划器 JSON 语法三层兜底**（修复「INVALID_JSON×3、86.9 秒白烧降级」，commit b49a395）：P0 `repairJsonStructure` 扩能——字符串外补缺失逗号、全角标点归一、栈空多余闭合括号丢弃，六类高频损伤本地修复不再重掷；P1 `parseFailureHint`——不可修复时抛错携带「错误位置 + 断点±60 原文 + 只修该处语法」定向回喂重试（不再全量盲掷）；P2 规划器 prompt 半角/逗号/括号自检硬约束。回归 724/0/0，T3 两轮独立复核通过。
- **QA-1 值篡改红线修复**：既有 `stripTrailingCommas` 正则不感知字符串边界、会吃掉值内 `", }"`——改为字符串边界感知实现并加回归锁（探针 TAMPER-3 转绿）。
- 注：2.3.1 未单独发布（其改动即上述 D1，随本版一并上线）。

## 2.3.0 — 2026-11-10

- 专家执行时间机制优化（用户 2026-11-10 要求，四点）：
  - **预估上报**：子任务派发后，专家向主 Agent 上报预估执行时长；主 Agent 把预估告知用户（预估仅供参考、非承诺，实际时长由协商决定）。
  - **超时放宽并告知**：专家执行超过预估时间时，主 Agent 继续放宽时限，并把最新执行时间告知该专家，同时要求其在保证工作质量的前提下高效率执行，让专家有准备；放宽有界、可审计。
  - **二次超时主 Agent 接手**：预估时间连续超时两次后，由主 Agent 接手该专家尚未完成的工作；禁止丢弃专家已完美完成的部分，必须以既有产物与证据为基础继续补齐。
  - **版本与发布**：全部版本标识同步至 2.3.0（package.json / package-lock.json×2 / src/host.ts / lib/host.js / tool-surface fixture / README 三语安装行与徽章）；本版本完成后自动发布到官方 GitHub 与索引源。

## 2.2.9 — 2026-11-10

- 红字复发族治本（用户 2026-11-10 截图实证）：收束类计时器去 unref 分类治理（存活恰 3 处卫生类白名单）；结算结果块缺失与解析失败同闸有界回喂 + 盘上结算备份自动采纳（EVIDENCE_MISSING）；防回归四件套（handle-policy 静态守卫、全局事件循环测试锚、run-tests cancelled===0 硬断言、CI node22+26 双矩阵）。

## 2.2.8 — 2026-11-10

- 修复 CI 红叉根因（2.2.6/2.2.7 提交 cancelled→exit 1）：attempt 上限计时器 unref 导致裸事件循环进程排空、兜底链无法收束；计时器改 ref，finally 收束照旧 clearTimeout。

## 2.2.7 — 2026-11-09

**本版修复：规划器/派发侧推理档位兼容性——qwen 类模型上自动分解开局即降级、部门专家派发期即中断的根因（用户 2026-11-09 报告）；同时补齐执行中断的即时通知（用户 2026-11-09 报告的核心体验缺陷）。**

### 根因

宿主 dsh-llm 在发起网络请求之前，把请求的 `reasoningEffort` 与目标模型声明的
`reasoning.efforts` 清单比对，不在清单内即抛 `UNSUPPORTED_REASONING_EFFORT`
（本地失败，重试不会自愈）。规划器默认档 `max`、子任务档位白名单 `low/high/max`
都假设主链路模型支持这三档；一旦运行在 qwen 这类只声明 `low/medium/xhigh` 的
模型上：第一次规划调用即被宿主拒绝 → 整次自动分解降级（PLANNER_LLM_ERROR）；
同一枚雷在派发侧——计划里的 `high/max` 行派给 qwen 子会话同样即抛，专家
「执行过程中发生中断」的诱因之一。


### 执行中断即时通知（【dsh-workplan·执行中断】）

用户报告：部门专家执行中被中断时，主会话直到整轮结果消息才一并交代——期间
界面只剩进度不动，用户无法区分「在慢慢做」与「已经失败」。既有即时通道只
覆盖完成（emitSubtaskDoneNotice）与到点预警，中断类事件全部只写
record.errors（主 Agent 下次读记录才可见）。

本版把中断事件与完成事件同等对待，一发生就往主会话写纯文本 user/message，
文案固定三段：发生什么（错误码+真因摘录）、系统正在怎么处理（自动重试/收束/
待拍板）、对用户意味着什么（不是任务失败终局）。覆盖五个静默点：

- 执行失败自动重试（第 N 次被打断 + 原因 + 正在回喂重试）；
- 重试耗尽/不可重试的最终受阻（真因 + 在盘产物线索 + 处置去向）；
- 执行链路未预期异常（如实留档并即报）；
- 派发后 no-ack（性质：疑似根本没启动，非执行失败）；
- 子 Agent 请示 escalate（补充人类可读摘录；结构化 update 仍照写）。

纪律：每个子任务整轮至多 3 条（interruptNoticeCount cap）；写失败只留档
record.errors，绝不影响执行；用户主动取消（parentSignal.aborted）与整轮
超时（guard.timedOut）静默。回归 `tests/interrupt-announce.test.ts`（单元
cap + 集成「第一次 error 结束 → 即时通知含真因与重试说明 → 第二次成功结算」）；
A4 用例升级为镜像契约：零虚报完成，但中断必须如实即报；stall 用例的结果消息
计数显式排除中断通知。全量 678 用例通过。

### 修复：发送前按模型能力钳制档位（治本，不按模型名猜名单）

- 新增 `clampEffortToSupported` + `resolveSupportedEfforts`（`src/runtime.ts`）：
  发送任何带档位的请求前，用宿主公开能力面 `llm.resolveModelInfo` 读出目标模型
  实际声明的档位清单，把请求档位钳制到清单内等效档——清单包含则原样；否则取
  不高于请求档的最高支持档（max→xhigh、high→medium）；全部更强则取最弱支持档；
  模型无 reasoning 元数据则不发送该字段；能力查询不可用则保持旧行为。
- 规划器（`runPlanner`）：钳制后档位实际发送，遥测记录实际值并在
  `reasoningEffortSource` 标注 `clamped(原档)`；钳制发生时 console.warn 留现场。
- 派发侧（部门子会话 `agentOptions`）：同一钳制；能力不可查询时保持同步路径
  （不引入额外 await 微任务，notice-channel 运行时集成用例零改动通过）。
- 回归：`tests/planner-effort-clamp.test.ts` 共 10 例（纯函数规则、旧宿主兼容、
  qwen 钳制、无 reasoning 元数据、派发三档映射）；全量 676 用例通过。

## 2.2.6 — 2026-11-08

**本版三项修复：D-1 重启回放丢弃人工改判的 closure 字段；跨部门需求落盘变 `[object Object]`（handoff 序列化）；任务自动分解期间界面零提示（进度可见性）。**

### 修复 D-1：重启回放丢弃人工改判的 closure 字段——重启后「待指示」行永久卡死的确证缺陷（起源 1.7.0，非 2.2.5 引入）

### 修复

- 回放 patch 补上 `closure: update.closure`：durable 的 `workplan-update` 自 1.11.0 起携带 closure，但 `reconstructFromSession` 的回放 patch 一直没把它传给 `applyStatus`；行停在 escalated 时，`status=done` 的改判被「非法闭环迁移 escalated→done」拒绝，整条 update 被裸 catch 吞掉。实证：wp-3c8c84b2 T2（改判链 blocked/escalated→instructed→done→reported，durable rev4→rev10 全部单调合法），重启重建=blocked/escalated/rev5（artifacts/2.2.5-post-restart-regression.md §4 D-1）。
- 裸 catch 改为 `console.warn` 留痕（fail-closed 而非 fail-silent）：单条坏记录不再无声消失，回放继续。

### 验证（红-绿）

- 新回归测试 `人工改判链（escalated→instructed→done→reported）重启回放后完整保留`（tests/runtime-replay.test.ts）：
  - **红**：摘掉修复跑全量 → 651 项中恰好 1 失败，失败点=「closure 链 escalated→instructed→done→reported 必须完整回放」；
  - **绿**：恢复修复 → **651/651 通过**；`npm run check` 0 错误。

### 修复（二）：跨部门需求落盘变 `[object Object]`（handoff 序列化）

- **病根**：handoff/needs/options 入库路径上有 4 个点位用隐式 `String(对象)` 把对象形需求整体转成字面量 `[object Object]`，部门信息一并丢失（写坏点 W1–W4：`src/plan.ts` `readEvidenceNeeds` / `mergeHandoffsFromNeeds` / `readEvidenceOptions`，`src/runtime.ts` escalate；根因报告 `_t1_dualdefect_rootcause_20261108/root-cause-and-boundary-report.md` §2.2）。
- **修复**：4 个点位全部改为对象感知的受控序列化——对象形需求按 `{department, need, purpose}` 组装为「部门：需求（用途）」可读文本，并把合法部门键存入 `handoff.department`；嵌套对象兜底为循环引用安全、undefined 安全的受控 JSON（`safeJsonText`）；字符串形需求逐字不变；历史 `[object Object]` 记录加载不抛错、存量逐字段不改写。全部改动以 `[2.2.6][T4]` 锚点标记，src 与 lib 一一对应。实证：主计划 wp-db6de2f0 的 T1–T4 四条需求均被写成 `request="[object Object]"、department:null`。
- **证据**：`_t4_need_serialization_fix/fix-report.md`；专项回归 **10/10**（evidence/01，含幂等与历史记录共存用例）；坏模式 `String(item ?? '')` 在 src 与 lib 中 **0 命中**。

### 修复（三）：任务自动分解期间界面零提示（进度可见性）

- **病根**：分解全程（`runPlanner`，最长 3 次尝试 × 300s 窗口 + 退避）发生在 pre-step 钩子内同步 await，期间插件零 `session.append`、零 `records.set`——侧栏 4 秒轮询与「正在安排」词汇早已存在，只是从未收到数据（断点层=未发出，插件层，非宿主限制、非前端渲染缺陷）。
- **修复**（零新组件、零新路由、零推送机制）：
  - **进行中**：进入分解先写占位进度卡，侧栏 4 秒轮询内出现「正在安排」徽标 + 「正在生成任务分解…」标题；
  - **重试中**：每次可重试失败，卡片错误区追加「第 N 次尝试失败（原因码）：真因；正在重试（约 X 秒后），第 (N+1)/3 次」，并仅在会退避重试时发一条聊天通知（**每轮至多 2 条**，第 3 次失败直接进降级文案不叠加）；
  - **失败带真因**：3 次全败走既有降级横幅（含逐次真因链），真因截断 ≤120 字符、错误码（如 `ECONNREFUSED`）原样保留；
  - **等信息中**：信息不足先澄清的场景徽标不再回显原始键名 `clarify`（zh「等信息中」/ en "Waiting for info"）；
  - **用户中止**：全静默、不残留假「进行中」、不丢上一份终态进度；重试语义零变化（`onProgress` 为只读观察点，退避执行块逐字未动）。
- **证据**：`_t5_visibility_impl_20261108/implementation-notes.md`；专项回归 **5/5**（对照交互规范 `_t3_visibility_spec_20261108/interaction-spec.md` C2/C3 模板断言）。

### 验证（合并态统一回归）

T4（序列化）与 T5（可见性）并行改动同一批文件，在合并构建上做统一体检，**总判定 GO、产品级失败项 = 0**（`_t6_dualfix_regression_20261108/T6_双修复回归测试报告.md`）：

- 合并产物一致性：构建前后双检哈希 15/15 + 根 client.js 一致；`npm run check` exit 0；
- 全量套件 **666/666 通过**（= 661 + 5，计数精确吻合；full-test-666.log）；
- 上一轮守卫与双向回归不回退：守卫 6/6、抖动正例 8/8 断言、AUTH 反例 4/4、cause 链 3/3、取消传播 3/3、真故障反例 7/7（1564–1678ms，与基线 1.454s 同量级带内）；
- 执行偏差披露：真故障反例组首跑 3 断言失败系漏注入占位密钥（执行偏差而非产品回归），补齐后 3 次 7/7，首跑日志留档（negative-result.attempt1-missing-env.txt）。

### 边界

- 两项双缺陷修复的**生环境复验**（手工重启 dsh web 后新会话触发自动分解，核对「进行中 / 重试中 / 失败带真因 / 等信息中」四态）待用户执行；可见性聊天通知（通道 B）能否在分解等待期间即时上屏属宿主运行态行为（H-1），侧栏卡片（4 秒轮询）为保底通道，不依赖它。
- wp-db6de2f0 四条历史损坏记录的原文已从子会话日志提取留档（minimal-change-points.json `extractedSamples`），可恢复；回填走 `dsh_workplan_update`，存量数据一字不改。
- **D-3 未在本版修复**（轮次中途完成只存内存、重启丢当前计划状态）：需要把每子任务结算改为 mid-round durable 写入，属轮次生命周期改造，风险大于本版可承受；维持 SG4 登记，建议 2.2.7 专项处理。缓解：重要节点后不要立刻重启；主 Agent 会在整轮完成后再建议重启。
- G1–G10 与 SG1/SG3 等条件项不变；整体交付仍受 2.2.3 门禁 NO-GO 约束。

### 安装

```bash
npm install dsh-workplan@2.2.6
```

## 2.2.5 — 2026-11-08

**轮次预算默认关闭：不再在子任务协商截止之前用“本轮预算用尽”切断整轮；子任务自己的预估/协商/延期/预警仍是唯一时间治理。**

### 修复

- `TOTAL_TIMEOUT_MS` 默认改为 **0**（不设整轮硬预算）；`totalTimeoutMs=0` 现在表示“关闭轮次预算”，正数（配置/`DSH_WORKPLAN_TOTAL_TIMEOUT_MS`）才启用安全兜底，最小 60s。
- `dispatchPlan` 在关闭时使用 10 年哨兵值，避免 `Infinity` 参与计时器/差值；`staleAfter` 同步放宽；host 工具调用超时在关闭时用 24h 兜底。
- 规划器提示词与计划消息不再写“本轮总预算 20 分钟/需要 N 轮”；改为“本轮不设固定总预算，子任务按 estimateMinutes 与协商截止/延期执行”。
- 预算到点提示仅在显式启用正数预算时出现；关闭时不会出现“本轮预算用尽，等待续跑”。
- 子任务协商机制不变：`estimateMinutes`、`timeoutMs`/`deadlineAt`、`extendMs`、`timeNotice`、`timeWarning`、`pendingAdjudication` 仍按原逻辑工作。

### 版本说明

- 按用户要求跳过 2.2.4，直接使用 **2.2.5**。
- 2.2.3 的 N1（status 文本面 planner/通道）与 N2（看板“协商上限（派生）”）保留；2.2.5 只改轮次预算。

### 热修（2026-11-08 同日，修复首版 2.2.5 的秒杀 bug）

- **现场事故**：首版 2.2.5 的无预算哨兵值取 **10 年**，超过 Node `setTimeout` 上限（2³¹−1 ≈ 24.8 天），Node 把延时强制改为 **1 毫秒**（TimeoutOverflowWarning）。结果：计划派发后 1ms 整轮定时器就触发，全部子任务瞬间被「总执行超时」杀死（17:36 一批 38ms、18:01 一批 8ms，各 6/6 与 3/3 全灭）。
- **修复**：哨兵值改为 **20 天**（1,728,000,000ms < 2³¹−1，安全且对单轮等价于“无预算”）；`dispatchPlan` 的整轮定时器额外钳制在 `ROUND_TIMER_MAX_MS = 2,000,000,000ms`，双重保险。
- **验证**：`npm run check` 0；`npm test` 650/650；构建 build `e04e7c26f277e71a`（lib 四入口复算）。事故根因行号：`src/runtime.ts` 原 `setTimeout(..., Math.max(1000, deadline - Date.now()))`。

### 验证

### 边界

- 关闭轮次预算后，每个子任务自己的 `timeoutMs`/到期结算仍生效；没有“整轮硬切断”。若子任务自身卡住，仍需按子任务协商/延期或主 Agent 处理。
- 2.2.3 的 D2 Console/D6-e/F1-R1/F4 负向等缺口仍为 CONDITIONAL/UNKNOWN，不因 2.2.5 自动变 PASS。

### 安装

```bash
npm install dsh-workplan@2.2.5
```

## 2.2.3 — 2026-11-08

**把 2.2.2 只进结构化返回值的 D1/D5 可观测字段补到模型可见文本面，并让 D2 的“协商上限”可被观察；不改状态机。**

### 新增 / 修复

- **N1（status 文本面）**：`dsh_workplan_status` 的 render 文本新增：
  - `规划器：推理等级 / 来源 / 判定 / 模型`（来源可为 `default-max` 或 `env`）；
  - 每行 `通道：state｜target｜caller｜at｜observedAt｜reason`。
  这两类字段此前只在结构化 `value` 里，DSH 只把 render 文本写进对话，导致 D5 planner 与 D1-b awaiting 快照在模型侧结构性不可读。
- **N2（D2 协商上限）**：前端 `TimeNegotiation` 在计划未声明 `timeoutMs` 时，用 `deadlineAt - startedAt - 已延期` 派生一个只读上限，并标注“派生”；不写回计划、不冒充用户授权值。计划显式 `timeoutMs` 仍优先。
- **N3（可选日志）未实施**：stdout/stderr 落盘属启动配置，不在本版改码范围内，避免夸大。

### 验证

- `npm run check` 0 错误；`npm test` **650/650 通过**（含版本同步、状态渲染、时间协商 UI 既有用例）。
- 2.2.3 需要用户手动重启 DSH 才会加载；重启前运行态仍是 2.2.2。
- 重启后需重新采集：D5 planner、D1-b awaiting、D2 协商上限截图；2.2.2 的运行态证据不继承。

### 边界

- D2 的 Console 仍为 UNKNOWN（用户不看 Console）；截图-only 最高 CONDITIONAL。
- D6-e 真实负向回执仍为 0 条；D6 仍 CONDITIONAL，除非出现真实事件。
- F1/F4 运行态负向分支仍不可达；只能如实标 UNKNOWN/接受残余。

### 安装

```bash
npm install dsh-workplan@2.2.3
```

## 2.2.2 — 2026-11-08

**修复 F1/F4 回放边界，并让规划器的推理档位遥测进入 status 可读面（D5 真实环境取证）。**

### 修复

- **F1（noticeChannel 空值回放边界）**：结果载荷里的 `noticeChannel:null`/非法值不再导致整条结果行被跳过（done 行回放成 pending、摘要/验收全丢）；回放前先校验，非法值按“无字段”处理，重建时不写回 null。
- **F4（无活 Agent 时的目标回落）**：`injected` 为空且没有活 `agent.id` 时 fail-closed 为 `TARGET_NOT_INJECTED`，不再回落到 `plan.sessionId` 当消息目标。
- **D5（规划器遥测可读）**：`dsh_workplan_status` 新增 `planner` 字段（provider/model/reasoningEffort/source/outcome/at），成功计划也能在真实运行态核对“规划器未继承主 Agent”。
- 包含 2.2.1 的会话损坏热修（`appendUserMessage` + 修复脚本），2.2.2 是叠加版本。

### 验证

- F1/F4：修复前 5 条失败、修复后 19/19；隔离副本全量 650/650；生产源码 `tsc --noEmit` 0。
- 2.2.2 构建后全量测试与 D5/E2E 证据在重启后采集；本版不把源码级验证冒充运行态验证。

### 边界

- F3 仍为部分关闭（超时状态行不写结论，需产品决定口径）。
- 2.2.2 需要用户手动重启 DSH 才会加载；重启前运行态仍是 2.2.1。

### 安装

```bash
npm install dsh-workplan@2.2.2
```

## 2.2.1 — 2026-11-08

**修复：完成即时通知与到点预警把纯字符串写进 `user/message`，导致会话历史无法加载（`failed to project session … Cannot read properties of undefined (reading 'kind')`）。**

### 问题

2.2.0 新增的两条“即时通知”路径把**纯字符串**直接作为 `user/message` 事件载荷写入会话：

- `runtime.ts` 的 `emitSubtaskDoneNotice()`：子任务完成即写 `[dsh-workplan] 子任务 … 已完成并结算：…`；
- 看门狗到点预警：`timeoutMs ≥ 120000` 时写 `子任务 … 即将到点：…`。

DSH 0.2.2-rc.1 的 `Session.append()` 只对**对象**载荷执行消息校验（`isRecord(data)` 分支），字符串因此被原样持久化。回放时 `goal` 投影对每条 `user/message` 读取 `event.data.source.kind`，字符串没有 `source`，抛出 `TypeError`；DSH 将其包装为 `SESSION_QUERY_CORRUPT_SESSION`，Web 端显示：

```
历史加载失败：failed to project session "session-…": Cannot read properties of undefined (reading 'kind') (gateway/internal)
```

现场证据（2026-11-08，工作区根目录）：

- `session-a404d49d-86b2-448d-8b3d-648423ffa146`：投影缓存水位 seq 1035（12:42 写入）；12:43:11 首个坏事件 seq 1036（T2 完成通知）；截至修复脚本 dry-run 时共 7 条（seq 1036/1038/1046/1047/1049/1054/1055，含两条到点预警）。
- 同工作区 `session-4ce46ec9-236e-46f6-978b-c5fe7f52815f`：seq 2002/2003/2007/2008 共 4 条同类坏事件。

### 改了什么

- 新增 `appendUserMessage(session, payload, source?)`（`src/plan.ts`）：
  - 字符串自动包装为完整 DSH `UserMessage`：稳定 `id`、`role:'user'`、`content:[{type:'text',text}]`、非空 `source.kind`，并固定 `surfaceOp:'append'`；
  - 对象先按 DSH `user/message` 契约校验（id/role/content/source.kind）；不合格在 `session.append()` 之前抛错，坏事件不再有机会进入追加日志。
- `runtime.ts` 全部 10 处、`supersede.ts` 1 处 `user/message` 写入统一改走该 helper；两条纯字符串路径被彻底消除。
- 新增回归测试 `tests/workplan-user-message-shape.test.ts`：
  - 字符串通知必须落成合法 UserMessage；
  - 缺 id / 缺 source / 空 `source.kind` 的载荷必须在 append 前拒绝；
  - `runtime.ts`、`supersede.ts` 不得再出现直接 `append('user/message', …)`，防止未来绕过 helper。

### 已损坏会话的一次性修复

2.2.1 只阻止**新增**坏事件；已写入磁盘的字符串事件仍需修复。新增 `scripts/repair-malformed-user-messages.mjs`：

- 默认 dry-run；`--write` 才落盘；
- 只把 `user/message` 的字符串载荷改写为合法 UserMessage，**不改 seq/time/surfaceOp/sourceEventSeqs、不丢事件**；遇到其他异常形状中止并要求人工确认，不猜测；
- 原文件先备份为 `*.bak-<timestamp>`，再原子替换；
- 写入后重新解压逐行复验：事件总数不变、seq 连续、所有 `user/message` 形状合法；
- 支持 `--scan-recent [--hours 24]`：停机后按最近修改时间再扫一遍，防止其他正在运行的会话在停机前又写入同类坏事件；
- 仅当投影缓存水位落在被修复区间时，才把缓存文件移开（避免把坏事件后的缓存当基线）；
- 检测到日志仍被进程占用（例如 DSH 正在运行）时拒绝 `--write`，必须先停服。

### 边界

- DSH 0.2.2-rc.1 的 append 校验对非对象载荷不报错，这是本次事故能落地的前置条件；插件侧已自校验，建议上游在 `validateSessionEventData()` 对非记录消息载荷直接拒绝（不在本插件改动范围）。
- 修复脚本处理所有字符串 `user/message` 载荷：已知 dsh-workplan 文案标 `workplan`，未知文案标 `recovered`，原文逐字保留；其他异常形状中止并要求人工确认。其他插件若写入对象但缺字段的坏载荷，仍需各自修复。
- `session-a404d49d…` 在修复时仍被 DSH 进程持有，必须先停服再执行 `--write`；停服/重启由用户手工完成。

### 验证

- `npm run check`、`npm test` 全量通过（含新增回归测试）。
- 修复脚本在两个受影响会话上 dry-run 通过；对已关闭的 `session-4ce46ec9…` 执行 `--write` 后复验：2018 个事件、seq 连续、全部 `user/message` 形状合法，原文件已备份。
- 版本号同步：`package.json` / `package-lock.json`（两处）/ `src/host.ts` meta / README×3 / `tests/fixtures/tool-surface.json` 全部为 2.2.1。

### 升级

本仓库当前以本地 link 方式安装：`~/.dsh/profiles/web/node_modules/dsh-workplan → <工作区>/plugins/dsh-workplan`。重新构建后，**手工重启 DSH** 即可加载 2.2.1；重启前先按上节停服修复运行中的会话。

## 2.2.0 — 2026-11-08

**柔性时长协商：时间从「固定闸门」变成「协商上限 + 安全兜底」；子任务完成即时通知；子 Agent 推理等级自决；子→主开工预告通道修复并进入看板。**

### 问题

2.1.x 的子任务共用一条写死的执行时限，到点按「强制结束」处理：专家没有开工预告、没有超预估预警、没有申请延期的通道；主 Agent 也无法在运行中放宽。与此同时，部门子 Agent 的推理档位跟着主 Agent 走，规划器也继承主 Agent 档位——主 Agent 用低档省成本时，拆解与执行会被整体降档。真实环境还复现了「子→主开工预告」通道结构性不可达：插件用 `delivery:'caller'` 派发，宿主不会追加父会话 id，插件却让子 Agent 向不存在的目标 `"lead"` 发消息，预告静默丢失。

### 改了什么

- **时间语义**：`estimateMinutes` 放宽到 1–240 的整数（越界拒绝，不再静默钳成 15）；新增可选 `timeoutMs`；缺省时按 `clamp(预估分钟 × 2.0 × 60000, 1000, 7200000)` 派生协商上限；显式 `timeoutMs` 优先。上限 7,200,000ms（120 分钟）为用户 2026-11-07 决断。
- **专家协议**：派发提示词新增「柔性时长协商协议」——开工前报预估、超预估立即报新预估并申请延期、完成即报核心结论；明确不设固定完成时间。
- **主 Agent 放宽**：`dsh_workplan_update` 新增 `extendMs` / `timeNotice`；运行中纯时限事务无需 `force`；累计放宽 ≤ 初始协商上限 × 1，超限拒绝并提示裁决；仅主 Agent 可用。
- **到点兜底**：到点不再是「强制结束」，改为「达到协商执行上限，已按安全兜底结算（待裁决）」；保留落盘产物、自动重试一次、状态行写 `pendingAdjudication`；`escalated` 优先，不被超时覆盖。
- **完成即时通知**：后台/自动派发轮次中，子任务真正 `done` 后立即向主会话推送一条含摘要、验收计数、用时的通知（≤5 秒、幂等、先于整轮批量结果；只有 `done` 才推，不误报）。
- **到点预警**：看门狗在剩余 ≤ max(协商上限 20%, 2 分钟) 时提醒一次，写 `timeWarning` 与 `timeJournal`，不拦截、不自动延期；延期后重新武装可再提醒。
- **推理等级**：子任务支持 `reasoningEffort: low/high/max`（缺省回落 high）；校验非法值；重规划 replace/add 保留或显式覆盖；部门子会话只取子任务自己的档位，绝不继承主 Agent；规划器未设专用旋钮时取默认 `max`，不再继承主 Agent（用户 2026-11-08 决策 5）；规划器遥测记录实际生效档位与来源。
- **子→主开工预告通道**：由插件注入真实父会话 id，提示词改用宿主契约的 `send_message({agent_id, message})`，彻底移除 `target:"lead"`；状态行新增 `noticeChannel`（target/targetSource/caller/at/observedAt/reason），结算时到父会话日志实证「已观测/未观测」，失败留四项日志，不再静默丢失。
- **看板**：任务行展示推理等级、预估时长、协商上限、协商截止、延期记录、开工预告、到点预警、子→主通道状态与待裁决标记；字段缺失时整块降级不渲染。
- **版本号**：package.json / package-lock（两处）/ `src/host.ts` meta.version / README×3 / 工具面 fixture 全量同步 2.2.0。

### 兼容性与边界

- 时间字段为 advisory（仅供参考），不参与可交付判定；旧计划缺少新字段时按旧路径运行（显式 `timeoutMs` → 预估派生 → 全局兜底）。
- `wait`（同步）模式不推完成即时通知：主 Agent 阻塞在工具调用中，轮级结果消息即完成通道。自动派发/自动续跑/async 模式推送。
- 运行中刷新/重启仍可能丢「运行中尝试」的 `deadlineAt`；轮末结果消息会恢复。该边界与决策单第 5 条一致。
- 子→主通道仍受宿主 lineage 校验约束：插件只注入本轮父会话 id，不提供任意目标发送、不新增插件工具面。

### 验证

- 全量测试 `npm test` 通过（含新增 notice-channel、看板协商展示、规划器停止继承、时间协商/延期/预警用例）。
- 真实环境 e2e 需由用户手工重启 DSH 后执行（本仓库不自行重启），验证项与证据要求见 `docs/` 下的 2.2.0 决策单、实施记录与重启后验证报告。

### 安装

```bash
npm install dsh-workplan@2.2.0
```

### 并入的 2.1.7 WIP：规划器超时抢救（原 2026-11-07 未发布段，按用户 2026-11-08 决定并入 2.2.0）


**修复规划器超时第四次复发的根因：定时器中止不再把 900 秒的产出整体作废（抢救 + 遥测补字数 + 两个可选旋钮）。**

#### 问题

2.1.6 把计时改成「按有没有产出」，但绝对上限（900s）撞上时仍是**整体丢弃**：
2026-11-07 同一会话里 `PLANNER_TIMEOUT_HARD` 连续出现 4 次，现场为
「模型 mimo-v2.6-flash｜耗时 900.0s｜收到 11694 个输出块｜提示词 5102 字」。
模型明明持续产出了 15 分钟，最后什么都没留下。三个结构性缺陷：

- **正文随局部变量蒸发**：`collectStream` 的 `text` 是局部变量，定时器一 abort，
  for-await 直接抛错，900 秒流出的正文连同 `lastText` 一起消失——已写完的计划
  （哪怕只差收尾 `}` 之外全部就绪）被整体扔掉，只能降级。
- **遥测恒缺「输出 N 字」**：abort 时 `lastText` 恒为空串，`textChars` 记成 0，
  事后无法判断「模型到底写没写完」，失败现场不可复盘。
- **无界生成 + 无独立推理档**：规划器调用不传 `maxTokens`（慢模型可无限吐），
  且无条件继承主 agent 的推理档——慢模型 + 高档位正是 900 秒内完不成的放大器；
  连续 `INVALID_JSON` 也印证输出过长被截断。

#### 改了什么

- **抢救（`salvagePartialPlan`）**：正文边流边落进 `sink`；定时器中止 / 缺 finish
  信号时，若正文末尾已闭合（`}`），按与正常路径完全一致的三道闸
  （`extractJson` → `validatePlan` → `validatePlanContext`）重新验收，通过则照常返回
  计划，判定记 `SALVAGED`（成功记录保留该判定，不被 `ok` 覆盖）。拦腰截断的 JSON
  一律不救——宁可降级也不交残缺计划；strict 上下文闸同样不被绕过。
- **遥测补字数**：`textChars = max(lastText, sink)`，abort 现场从此有「输出 N 字」。
- **两个可选旋钮（不设 = 行为与旧版完全一致）**：
  - `DSH_WORKPLAN_PLANNER_MAX_TOKENS`：单次生成封顶，非法取值回落（不打成 NaN）；
  - `DSH_WORKPLAN_PLANNER_REASONING_EFFORT`：规划专用推理档，覆盖继承值。
- **版本号 2.1.7 全量同步**（package.json / package-lock / meta.version /
  README×3 / tool-surface fixture）。
- 新增 `tests/planner-salvage.test.ts`（5 条）：抢救成功、截断不救但留字数、
  缺 finish 信号可救、strict 闸不被绕过、两旋钮透传与回落；与既有
  `tests/planner-timeout.test.ts` 12 条一并通过。

#### 边界（不夸大）

- 抢救只认「末尾已闭合」的正文；被截断的输出仍按原判定降级，宁缺毋滥。
- 旋钮默认关闭，不改变任何现有行为；封顶过小会触发截断回喂重试，属可调参数。

### 安装

```bash
npm install dsh-workplan@2.2.0
```

## 2.1.6 — 2026-11-07

**修复规划器超时第三次复发：把「按墙钟掐断」改成「按有没有产出计时」，并把失败现场如实带回。**

### 问题

2.1.1 把 120s 提到 300s、2.1.3 把常量改成可配置，默认值依旧是 300s 的**固定墙钟**，
于是同一个故障第三次发生：2026-11-07 10:05:19.666 规划器开始生成计划，
10:10:19.700 被 abort 并降级（会话原始日志实测 **300.06 秒**，随后 10:10:19.727 才进入
模型第 1 步）。也就是说：**模型只要还在正常输出，也会在第 300 秒被掐断**，
提高默认值和开放配置都没有解决这个结构问题。

同时暴露四个伴生缺陷：

- `PLANNER_IDLE_TIMEOUT_MS`（90s）只声明、从未接线，是死代码：既不能更快识别卡死，
  也不能保护正常输出。
- 报错让用户「提高 `PLANNER_TIMEOUT_MS`」——那是**源码常量**，运行时真正的旋钮是
  `DSH_WORKPLAN_PLANNER_TIMEOUT_MS`，照做改不到任何东西。
- `limits` 里根本没有 `plannerTimeoutMs`，`options.limits.plannerTimeoutMs` 永远是
  `undefined`，配置 → limits → 单次调用这条链路断在中间。
- 失败现场什么都不留：没有模型、没有耗时、没有输出块数、没有判定码，事后只能从会话
  JSONL 反推「恰好 300 秒」。

### 改了什么

- **计时策略改为三扇窗（`src/runtime.ts` `runPlanner`）**：
  1. 无进展窗口（`plannerTimeoutMs`，默认 300s）自**上一个 chunk** 起算，首个 chunk
     之前同样适用；持续产出 ⇒ 窗口不断后移，慢而稳定的长任务不再被误杀。
  2. 静默窗口（`plannerIdleTimeoutMs`，默认 90s）在首个 chunk 之后生效：文本、推理、
     usage 一个都没有才算卡死；不小于无进展窗口即等于关闭。`PLANNER_IDLE_TIMEOUT_MS`
     从此真正参与计时。
  3. 绝对上限 = 无进展窗口 × `PLANNER_HARD_MULTIPLIER`（默认 900s）：有无产出都到此
     为止，规划失败永远是「有限时间 + 可执行建议」。
- **报错给出真实旋钮**：`DSH_WORKPLAN_PLANNER_TIMEOUT_MS` / `DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS`，
  并区分 `PLANNER_TIMEOUT`（没进展）、`PLANNER_IDLE`（输出后停滞）、`PLANNER_TIMEOUT_HARD`（超绝对上限）。
- **规划器遥测**：每次尝试记录 provider / model / reasoningEffort / 提示词字数 / 输出块数 /
  耗时 / 判定码；成功写进 `record.planner`，失败作为 `detail` 直接出现在降级消息里。
  `DSH_WORKPLAN_DEBUG=1` 时逐次打印。
- **`limits` 补齐** `plannerTimeoutMs` / `plannerIdleTimeoutMs`，配置 → limits → 单次调用同一链路。
- 新增配置项 `plannerIdleTimeoutMs`（`DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS`）；
  新增 `normalisePlannerWindow`（拒绝 0/负数/NaN，避免把计时器打成 1ms 立刻超时）。
- 测试 `tests/planner-timeout.test.ts` 覆盖四类判定与报错文案；版本号 2.1.6 全量同步
  （package.json / package-lock / meta.version / README×3 / tool-surface fixture）。
- **新增修复验收标准动作**（`RELEASING.md §6.1`）：每次修复验收都必须比对
  「**运行态指纹 = 磁盘指纹**」——`dsh_workplan_status` 回显的 `build <16位>` 与
  `printf '%s' "$(cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js)" | shasum -a 256 | cut -c1-16`
  必须一致，不一致即验收不通过。起因正是本次事故：修复 10:40:03 已构建完成，
  而运行进程 10:02:39 启动、加载的仍是旧字节 `6512166d9d425f7d`。

### 安装

```bash
npm install dsh-workplan@2.1.6
```

## 2.1.5 — 2026-11-07

**把「接收分配任务的部门人员」升级为该领域全球顶尖专家，而非普通部门人员（要求 1 + 2 同步落到源码）。**

### 问题

子 Agent 提示词里执行者只是「某部门的执行 Agent」，规划器给子任务填的 role 也只是「部门内角色」，
没有任何机制要求执行者以顶尖专家水准工作，导致分工到位但执行深度不足。

### 改了什么

- `src/departments.ts` 新增 `DEPARTMENT_EXPERT_STANDARD`（planner / child 两段文案的单一事实源，
  规划器与子 Agent 提示词共用，不会各自漂移）。
- 规划器提示词：可用部门列表标注「执行者都是来自全球相关领域的顶尖专家（不是普通部门人员）」，
  JSON 示例 role 改为按全球顶尖专家定位填写。
- 子 Agent 提示词：首句后新增「专家定位」段（先根因与全局、证据可复核、经得起同行评审、
  不交浅层补丁不遗留问题），「执行要求」新增同标准首条。
- 版本号 2.1.5 全量同步（package.json / package-lock / meta.version / README×3 / tool-surface fixture）。

### 安装

```bash
npm install dsh-workplan@2.1.5
```

## 2.1.3 — 2026-11-06

**修复规划器超时复发的真正根因：把单次规划器调用的墙钟上限从写死的常量改成可配置项。**

### 问题

2.1.1 把规划器超时常量从 120 秒提到 300 秒，只是推迟了超时，没解决
「单次 LLM 调用被固定超时卡死」的结构性问题。复杂任务（长上下文 /
多子任务 JSON）仍会在 5 分钟处稳定触发超时，导致自动任务分解反复降级。

### 改了什么

新增 `DSH_WORKPLAN_PLANNER_TIMEOUT_MS` 环境变量（毫秒，>0），
未配置时回落到默认值 300000。复杂任务可按需放宽时限，无需重新编译发布。

### 安装

```bash
npm install dsh-workplan@2.1.3
```

## 2.1.2 — 2026-11-06

**修复自动任务拆分「稳定超时被误报成意外中断」的问题：把规划器的思考时间上限从 2 分钟放宽到 5 分钟，并让真正超时时报出明确原因。**

### 一、问题是什么（通俗版）

插件在接到一个复杂任务时，会先花一段时间自动把它「拆分」成几个子任务，再分派给各部门去执行。这一步是有时间上限的：

1. 之前的上限只有 **2 分钟（120 秒）**。当任务描述特别长、要求特别多时，拆分还没做完，就被定时器强制打断了；
2. 更糟的是，底层的大模型接口把「超时被打断」这件事，**误报成了「请求意外中断」**（`DeepSeek Messages request aborted`），看起来像网络偶发故障，根本看不出真正原因是「时间到了」。

结果就是：复杂任务每次都会稳定失败，但日志却让人以为是「偶发中断」，排查方向被带偏。

### 二、改了什么（只有这两处）

1. 把拆分的时间上限从 **2 分钟（120 秒）放宽到 5 分钟（300 秒）**，给复杂任务留足拆分时间。
2. 当确实是「超时」被打断时，不再被误报成「意外中断」，而是明确抛出「规划器超时：任务分解未在时限内完成」的清晰报错。

改动只涉及 `lib/runtime.js` 与 `src/runtime.ts` 两个文件（+14/−2），没有改其它任何功能。

### 三、安装

```bash
npm install dsh-workplan@2.1.2
```

（版本号 2.1.2 为 patch 升级，属 bug 修复级别。）

## 2.1.1 — 2026-11-06

**修复 2.1.0 的三处「说到了但没做到」：格式退回通知在续跑时送不到部门人员、中文 README 的安装命令仍指旧版本、安全文档里有一句「当前 1.12.0」的错误陈述。**

### 一、退回通知为什么没送到（根因）

用户要求是「结果不符合格式立刻退回，通知其重新检查格式」。2.1.0 把退回原因写进了状态行（`blockedKind:'comm-format'` + `error`），但续跑路径的顺序错了：

1. 计划被判 `blocked` 后再次派发，`dispatchPlan` 先调用 `resetBlockedStatuses`，把受阻行连同 `blockedKind` / `error` 一起清成待跑；
2. `executeSubtask` 随后才去读「这一行上次是不是格式退回」，此时信息已经被清掉；
3. 结果：退回只留下一个状态记号，子 Agent 重跑时看到的提示词与第一次完全一样（实测两次提示词长度都是 4374 字符），只能把同样的格式错误再交一遍。

修复（`src/runtime.ts`）：

- `dispatchPlan` 在 `resetBlockedStatuses` **之前**扫出 `blockedKind === 'comm-format'` 的行，把退回原因抄进 `record.commFormatRejections`；
- `executeSubtask` 在行内 `blockedKind` 已被清掉时改读这份记录，作为 `COMM_FORMAT_REJECTED` 的上次失败原因带给子提示词；
- 消费一次即删，同一条退回通知不会被后续无关重试重复带上。

修复后实测：第 2 次激活的提示词多出「上一次尝试失败」段，包含失败类型 `COMM_FORMAT_REJECTED` 与逐条不合规项（4374 → 4584 字符）。

### 二、另外两处修正

- `README.zh.md:72` 的安装命令仍是 `dsh-workplan@1.12.3`，而同文件徽章已是新版本——用户会照着装错版本。已改为 `dsh-workplan@2.1.1`。（`tests/version-sync.test.ts` 只校验 `README.md` 与 `README.en.md`，所以这个缺口一直没被测出来。）
- `docs/cc/AGD-OPS-SECURE-OPERATION.md` 的安装校验步骤写着「当前 1.12.0」，是唯一一处面向用户的过期「当前版本」陈述。已改为版本中立表述，并在文首补一条带日期的版本说明：正文其余 1.12.0 都是那次评估的历史快照，不改写历史。

### 三、新增验证

- 新增 `tests/workplan-comm-format-e2e.test.ts`（2 条）：用真实运行时 + 假子会话跑完整链路——不合规结果判 `blocked/comm-format` 且不计完成；修正后同一子任务可判 `done`；**并断言第 2 次激活的提示词确实带「上一次尝试失败」段、失败类型与逐条不合规项**（把「通知」环节钉成回归用例）。
- `npm run check`（tsc --noEmit）退出码 0。
- `npm test`：580 条用例，pass 580 / fail 0。

### 四、边界

- 修复只影响「因格式不合规被退回」的行；超时、no-ack、escalated 等其它受阻原因的通知路径不变。
- `commFormatRejections` 是单轮内的传递载体，不写进会话事件；跨轮重跑依赖状态行上的 `blockedKind/error`，二者仍在结果消息里原样保留。

## 2.1.0 — 2026-11-06

**建立主 Agent 与部门人员之间的统一沟通交流格式契约（下发—自检—核验—退回闭环），并保留 2.0.5 草案的规划器 JSON 结构修复。**

### 一、问题与证据链

用户 2026-11-05 在同一会话里连续两次遇到自动分解失败：

| # | 事实 | 证据 |
|---|---|---|
| 1 | 第一次：`Expected ',' or '}' after property value in JSON at position 12475` | 会话降级消息原文 |
| 2 | 第二次：规划器 JSON 被 max tokens 截断，旧实现先 `lastIndexOf('}')` 找不到结尾括号，直接判 `NO_JSON` | `src/plan.ts#extractJson` 旧实现 |
| 3 | 两次都不是「没规划」，而是「规划结果有一个字符的结构瑕疵」 | 降级消息均带 `degraded:true` 与原 JSON 错误 |

2.0.4 修的是**子 Agent 回执**的解析（`repairEvidenceJson`），规划器入口的 `extractJson` 仍是裸 `JSON.parse`，是同一个病根的另一个出口。

### 二、改了什么

- **结构修复**：新增 `repairJsonStructure()`——配平未闭合的 `{` `[` `"`、去掉尾逗号、把字符串内的裸换行/制表符/控制符转义。**只修结构，不新增或猜测任何字段值**。
- **截断修复**：新增 `truncatedCandidates()`——输出被 max tokens 截断时，从尾部逐个丢弃不完整成员（每次都是「本来就残缺、不可用」的内容），最多 24 轮，每轮尝试解析。
- **不再误判 NO_JSON**：旧实现要求文本里存在结尾 `}`，截断输出因此被判「没有 JSON 对象」；现在只要以 `{` 起头就进入修复流程。
- **失败仍然如实报错**：修不好照旧抛 `INVALID_JSON`，不静默返回空计划；成功修复时打印一条 warn 日志说明「只补括号/逗号，未改内容」。

### 三、验证

- 新增离线自检 10 条，全部通过：合法 JSON、少一个 `}`、少两个 `}]`、尾逗号、字符串内裸换行、截断 70%、截断 55%、代码块包裹、无 JSON（应抛 `NO_JSON`）、纯空白（应抛 `EMPTY_OUTPUT`）。
- `npm run check`（tsc --noEmit）退出码 0；`npm run build` 重新生成 `lib/`、`dist/`、`client.js`。
- `npm test` 全套回归见本版本 CI 输出。

### 四、边界（不夸大）

- 结构修复无法把「内容本身就错」的 JSON 变成正确内容；它只解决括号/逗号/截断这类机械损伤。
- 丢弃尾部残缺成员意味着该成员的信息丢失，调用方的 schema 校验仍会拦下缺字段的计划，不会因此产出半成品计划。

### 五、沟通交流格式契约（本次核心）

用户 2026-11-06 的强制要求：派发工作的同时附带一份统一的沟通交流格式要求；部门人员提交结果前依此自查；主 Agent 收到后依同一份格式核验，不合规立刻退回，通知其重新检查格式后全盘重交。

| 环节 | 落地位置 | 行为 |
|---|---|---|
| 下发 | `src/comm-format.ts#renderCommFormatSpec` → `src/plan.ts#buildChildPrompt` 末尾 | 每个子任务提示都附带 F1–F9 九条格式规范与「提交前自查（强制）」指令 |
| 自检 | 同上（提示词内强制指令） | 部门人员提交前逐条对照 F1–F9 |
| 核验 | `src/comm-format.ts#checkCommFormatCompliance` → `src/plan.ts#adjudicateResult` done 路径前 | 主 Agent 用同一份规范逐条核验 F1–F8（F9 为诚信约束，由三阶段门禁与人工复核兜底） |
| 退回 | `adjudicateResult` 返回 `blockedKind:'comm-format'` + `renderCommFormatRejection` | 不合规即判 blocked，退回通知写明逐条不合规项与修正要求 |
| 重交 | `src/runtime.ts#executeSubtask` 的 `lastFailure` 注入 | 复位重派时把退回通知作为上次失败原因（`COMM_FORMAT_REJECTED`）随提示词发回，子 Agent 看到具体不合规条目，只补缺口不重做 |

九条规范：F1 证据块标记成对、F2 status 合法、F3 三阶段齐全、F4 pass 必须带证据、F5 验收条数不少于计划、F6 产物条目合法（kind ∈ file/url/note 且 ref 非空）、F7 复盘四项、F8 blocked 必须带 question、F9 不得编造。

设计边界（不夸大）：

- 只拦 `done` 路径。解析失败、验收缺口、三阶段缺失已被更早的门禁拦下，保留原有更具针对性的诊断，不用格式条目覆盖。
- `requirePhases:false`（历史回放 / 明确关闭新契约）不追溯否决旧日志里按当时规则合法的 done。
- F6 只校验「产物声明的合法性」，是否必须交付文件由计划验收标准决定——避免把无文件产物的写作类子任务误判为不合规。
- F9 不做自动判定：编造检测需要语义理解而非结构校验，把它写成提示词级诚信约束，由三阶段门禁与人工复核承担。

### 六、验证

- `npm run check`（tsc --noEmit）退出码 0。
- `npm test`：578 条用例，pass 578 / fail 0。
- 新增 `tests/workplan-comm-format.test.ts`：覆盖 F1–F8 逐条拒收、合规放行、退回通知文案、`requirePhases:false` 兼容边界。
- 既有用例按新契约修订 1 条：`workplan-evidence-contract.test.ts` 的 C-19 由「空证据 pass 降级 unverified 仍算 done」改为「按 F4 退回 blocked/comm-format」——这是用户要求的行为前移，不是放宽。

## 2.0.4 — 2026-11-05

**修复「子 Agent 干完活却交不了差」的四条判定缺陷，并给交互式会话收尾加上「放行但留痕」。**

### 一、问题与证据链

用户 2026-11-05 报告：计划里 5 个子 Agent 的产物都已在磁盘上，结果却被判「结果块无法解析」「未提供结构化证据块」，交付门禁反复重开；同一会话里还出现「子任务没完成就先给结论」。

逐条核对子会话原始回执后确认，这不是模型没干活，而是四处判定把「格式瑕疵」当成了「没有证据」：

| # | 事实 | 证据 |
|---|---|---|
| 1 | 3 份回执**结尾各少一个 `}`**，补一个括号后 `JSON.parse` 立即通过 | 逐字符括号扫描；补后解析成功 |
| 2 | 2 份回执 JSON 合法，只是**漏写 `WORKPLAN_EVIDENCE` 标记**（放在代码块里） | 旧实现判「未提供证据块」，与事实相反 |
| 3 | 旧验收只做 `实际文本.includes(声明原文)`，同义改写一律判「没回应」 | `acceptanceCoverage()` |
| 4 | `reported` 状态没有 `done` 出边，复核已回报的行必撞「非法闭环迁移」 | 状态迁移表 |
| 5 | 交互式会话 steer 上限 2 次，用尽后静默放行，用户看不到「这次是没做完就收尾」 | `onTurnStopping` |

### 二、改了什么

- **回执解析有界修复**：新增 `closeOpenJson` / `lastSafeCut` / `repairEvidenceJson`，只在结构层补括号与截断，不补内容；修不好的仍如实报错，并给出「只保留 status/summary/acceptance/artifacts/needs 后重发」的下一步。
- **无标记回执可认领**：新增 `rescueEvidenceFromFence()`，仅在缺规定标记时，从代码块中认领「有 `status` 且至少带一个证据字段」的对象；计划载荷、配置片段这类普通 JSON 不会被误认。
- **验收匹配放宽到语义层**：新增字符二元组 Dice 相似度与否定词一致性校验——同义改写、语序调整算同一条；**删掉「不得」这类否定词，或只抄前半句，仍然判不覆盖**。
- **状态机补齐**：已回报的行再次交付时保持 `reported`，不再强写 `done`，也不再报非法迁移。
- **交互式收尾「放行但留痕」（方案 B）**：steer 用尽时不再沉默 `return`，而是把 `releasedIncomplete`（轮次、进度、未完成项）记入计划状态、向会话追加一条 notice、并写一条 warn 日志；三处使用同一组数字。headless 场景维持原有 `WORKPLAN_INCOMPLETE` 硬失败语义。
- **错误文案分档**：截断、少闭合符、缺标记三种情况给出各自的修复指令，不再统一说「无法解析」。

### 三、验证

- 新增 `tests/workplan-user-logic-204.test.ts`：13 条用例覆盖同义改写、部分回应、删否定词、只抄前半句、缺括号、缺标记、误认普通 JSON、已回报复核。其中「删否定词」「只抄前半句」两类假阳性由独立复核子 Agent 用 18 条真实差异对复现后补入。
- `npm test`：**562 条用例全过，0 失败**。
- `npm run build` 重新生成 `lib/`、`dist/`、`client.js`，与 `src/` 同步。
- `npm pack --dry-run` 文件清单核对：不含 `.backups`、`node_modules`、测试临时文件与任何凭证。

### 四、范围说明（重要）

本版本**不含**官方 `@deepseek-ai/dsh-client-ui-chat` 的界面文案改动。那条改动（「已完成，用时 」→「本轮过程已完成，用时 」）落在第三方包内部文件，属官方 DSH 安装目录，不随本包分发；需要的话请按仓库文档中的说明自行替换，或等待上游修复。

### 五、发布

- npm：`dsh-workplan@2.0.4`
- GitHub Release：`v2.0.4`，附 `dsh-workplan-2.0.4.tgz` 制品与 SHA256
- 索引源（dsh-plugin-catalog 链路）：条目 tarball 指向 `v2.0.4` Release，由上游 CI 生成 catalog

## 2.0.3 — 2026-11-05

**修复「官方 `/goal` 目标指令会让 dsh-workplan 自动分解永远不触发」的真实缺陷：goal 第一轮现在作为合法任务入口参与自动分解；已有进行中计划时 goal 轮次绝不抢跑。**

### 一、问题与证据链

用户 2026-11-05 报告：使用官方 DeepSeek Harness 的「目标 goal」指令后，dsh-workplan 的自动任务分解似乎不会触发。核查代码后确认这不是猜测，而是一条可复现的契约缺口：

| # | 事实 | 证据位置 |
|---|---|---|
| 1 | `/goal <objective>` 命令只写 goal 领域状态，**不产生** `user/message` | `@deepseek-ai/dsh-command-goal` 的 `create` 分支 |
| 2 | goal 的自动续跑轮次由 round driver 以 `source.kind = "goal"` 的 user 消息送达，文本形如 `<goal_round>Objective: "…"</goal_round>` | `@deepseek-ai/dsh-goal-round-driver/lib/index.js` 的 `renderGoalRoundPrompt` 与 `createUserMessage` |
| 3 | 2.0.2 的 `humanMessages()` 只接受 `source.kind === 'user'` 或未标记的消息 | `src/runtime.ts#humanMessages` |
| 4 | `maybePlan()` 在 `human.length === 0` 时直接返回，不进入规划 | `src/runtime.ts#maybePlan` |

1+2+3+4 合并后的结论：如果任务是通过 `/goal` 设置的，整条 goal 生命周期内都不存在「人类消息」，插件永远不会自动分解该任务。人工消息路径（普通输入框任务）不受影响。

### 二、改了什么

- 新增 `goalRoundPlanningTask(ctx, payload, existing)`：只接受 `source.kind === 'goal'` 且 `round === 1` 的消息作为自动分解入口。
- `maybePlan()` 在没有任何人工消息时改走该入口；任务文本优先级为：`goals` 领域服务的结构化 `objective` → 从官方 `<goal_round>` 信封解析 JSON objective → 整条消息原文。
- 防抢跑：会话里存在进行中计划（`executing` / `paused` / `pending` / `verification` 等）时，goal 轮次直接放行不建计划；`done` / `ended` / `cancelled` / `superseded` / `degraded` / `clarify` 属于历史记录，不拦新任务。
- 人工消息路径、`humanMessages()` 的既有语义、执行中变更（changeRequest）与 replan 规则全部保持不变。

### 三、验证

- 新增 `tests/goal-round-planning.test.ts`：7 条断言覆盖 round 1/round 2、goals 服务优先、信封解析、无 objective 兜底、进行中计划防抢跑、历史终态放行。
- `npm test`：553 条用例全过；`npm run check`（tsc --noEmit）退出码 0。
- `npm run build` 重新生成 `lib/`、`dist/`、`client.js`，与 `src/` 同步。

### 四、发布

- npm：`dsh-workplan@2.0.3`
- GitHub Release：`v2.0.3`，附 `dsh-workplan-2.0.3.tgz` 制品
- 索引源（dsh-plugin-catalog 链路）：条目 tarball 指向 `v2.0.3` Release，等待上游 CI 生成 catalog

## 2.0.2 — 2026-11-05

**更正「第一、二阶段禁用 dsh-workplan 插件」的适用范围：这条只适用于 2026-11-05 本次优化会话，不是对所有后续会话的永久产品规则。2.0.2 起，提示词、工具描述、README 与协作文档不再声明全局禁用；三阶段工作法与「验证工具缺前两阶段证据返回 PHASE_GATE」的证据门禁保持不变。**

### 一、为什么要改

- 用户在 2.0.1 发布后澄清：原要求 4「第一、二阶段禁用 dsh-workplan 插件」是**本次会话内**对优化过程的约束，不是要求插件对所有未来会话禁用。
- 1.13.0 起把这条写成了产品级规则（子 Agent 提示词、`dsh_workplan_verify` 描述、运行时报错、README、协作文档），属于对需求范围的误读；2.0.2 全面更正。

### 二、改了什么（只改措辞与说明，不改三阶段契约）

| 位置 | 2.0.1 及以前 | 2.0.2 |
|---|---|---|
| `src/three-phase.ts#threePhasePromptLines` | 「阶段一、二：dsh-workplan 插件禁用。不得调用任何 dsh_workplan_* 工具」 | 「阶段一、二先把问题、思路与执行记录写全；调用 verify 会因缺少前两阶段证据返回 PHASE_GATE（证据门禁，不是禁用插件）」 |
| `src/host.ts#createVerifyTool` 描述 | 「阶段一、二禁用本插件」 | 「缺少 planning / execution 证据时返回 PHASE_GATE 与待补项」 |
| `src/runtime.ts#verifySubtask` 报错 | 「插件在阶段一、二禁用」 | 「阶段三核验缺少前两阶段证据」 |
| `README.md` / `README.en.md` | 声明永久禁用 | 声明仅 2026-11-05 本次会话约束；主 Agent 任何阶段都可用计划/派发/查询/改判 |
| `docs/collaboration.md`、`docs/cc/AVA` | 表格写「禁用」 | 写「证据门禁」并加 2.0.2 更正说明 |

### 三、没有变的部分

- 三阶段（规划 → 执行 → 验证）仍是产品功能，完成判定仍要求 `phases` 齐全。
- `dsh_workplan_verify` 仍只接受三阶段齐全的证据；缺 planning/execution 仍返回 `PHASE_GATE`——这是证据门禁，不是插件禁用。
- 阶段三复盘（自我学习）与永久教训记忆完全不变。

### 四、验证

- `npm run check`（tsc --noEmit）退出码 0；`npm test` 全过（见 `docs/release-notes-2.0.2.md` 与 GitHub Release 页）。
- 新增/更新断言：`tests/three-phase.test.ts` 明确断言提示词不再包含「插件禁用」，同时仍断言阶段三门禁与 `PHASE_GATE`。

## 2.0.1 — 2026-11-05

**新增「自我学习与自我迭代」：部门 Agent 每次完成工作后，必须在阶段三复盘本次全过程的问题、弯路、解决方式与防再犯规则；复盘通过后写入永久教训记忆文件，下次派发同类任务时自动注入提示词。同一类错误重复出现会累加次数并提前排序。三阶段工作法（1.13.0）保持「规划 → 执行 → 验证」不变，复盘是验证阶段收尾的必填项，不是第四个阶段。**

### 一、用户要求与本版实现逐条对照

| 用户要求（2026-11-05） | 本版实现 |
|---|---|
| 1. 增加自我学习和自我迭代能力 | 新增 `src/lessons.ts`（复盘校验、永久记忆读写、相关度排序、提示词注入）+ 运行时闭环（`src/runtime.ts#settleFromOutput` 完成即落盘）；主 Agent 可用 `dsh_workplan_lessons` 只读复核 |
| 2. 每次完成工作后全面复盘问题/弯路/如何解决，并永久记住、不再重犯 | `phases.verification.retrospective` 四项（problems / detours / resolutions / prevention）成为完成判定的必填证据：缺项、太薄（问题/解决 <20 字、预防 <16 字）一律 `blocked/unverified`；通过后写入 `~/.dsh/workplan/lessons.jsonl`（可用 `DSH_WORKPLAN_LESSONS_FILE` 覆盖），下次派发自动注入最相关的 8 条 |
| 3. 全过程按规划 → 执行 → 验证三阶段 | 沿用 1.13.0 的 `phases.planning/execution/verification` 契约；复盘放进验证阶段收尾，阶段数仍是三个 |
| 4. 第一、二阶段禁用 dsh-workplan 插件 | 子 Agent 本就没有 update/replan/cancel/dispatch/status/instruct/handoff/followup 权限；`dsh_workplan_verify` 在缺 planning/execution 证据时返回 `PHASE_GATE`；提示词写明阶段一、二不得调用插件，唯一例外是遇阻上报 `dsh_workplan_escalate`（安全阀） |
| 5. 第三阶段可用插件验证是否完全满足要求 | 阶段三核验工具同步要求 `verification.retrospective`：结构不全返回 `VERIFICATION_INCOMPLETE`，齐全才 `passed`；核验通过仍不等于完成，结果块与 `adjudicateResult` 会再判一次 |
| 6. 全程遵照用户要求，禁止偏离 | 本版所有新增门禁都落在完成判定与提示词两处，避免「提示词说要做、判定却不检查」的两套真相 |
| 7. 版本更新为 2.0.1 | `package.json` / `package-lock.json`（两处）/ `src/host.ts#meta.version` / `CHANGELOG` / `README.md` / `README.en.md` 全部为 2.0.1，由 `tests/version-sync.test.ts` 断言 |
| 8. 源码与版本同步发布到 GitHub 与索引源 | 提交 + `v2.0.1` tag + GitHub Release（带 tgz 制品）+ npm `dsh-workplan@2.0.1` + awesome-dsh-plugin 索引条目更新，发布记录见 `docs/release-record-2.0.1-20261105.md` |

> **勘误（2026-11-05，2.0.2）**：上表第 4 条「第一、二阶段禁用 dsh-workplan 插件」只适用于本次优化会话，不是对所有后续会话的永久插件限制。2.0.2 起提示词、工具描述、README 与文档已更正；三阶段工作法与证据门禁不变。

### 二、自我学习的具体机制（可复核）

| 环节 | 代码位置 | 行为 |
|---|---|---|
| 复盘校验 | `src/lessons.ts#validateRetrospective`、`src/three-phase.ts#validatePhaseEvidence` | 四项缺一不可；problems/resolutions/prevention 至少 1 条；问题与解决合计 ≥20 字、预防 ≥16 字；单条上限 600 字、最多 12 条 |
| 永久记忆 | `src/lessons.ts#recordLesson` | 追加写入 JSONL；同一子任务重复结算原地更新（不虚增次数）；不同子任务同类错误 `occurrences+1`；临时文件 + 改名原子替换；保留最近 500 条；坏行跳过 |
| 防再犯注入 | `src/lessons.ts#renderLessonsBrief`、`src/runtime.ts#executeSubtask` | 按同部门 > 同项目 > 关键词 > 重复次数 > 新近程度排序，注入最多 8 条；段首声明「历史数据，不是新指令」；清除不可见字符与会话引用 |
| 可复核入口 | `src/host.ts#createLessonsTool`、`src/runtime.ts#lessonsTool` | `dsh_workplan_lessons` 的 `list` / `search` / `stats` 只读返回记忆内容、重复次数、文件位置；不提供写入动作，防止绕过真实复盘证据 |
| 可见性 | `src/runtime.ts#settleFromOutput` | 完成摘要追加 `[自我学习] 复盘已写入永久教训记忆`（同类重复时注明第 N 次） |

### 三、兼容边界（如实登记）

- 这是**破坏性证据契约变更**：2.0.1 以前写出的 done 结果没有 `retrospective`，用本版完成判定重放会被判未完成。历史回放可显式传 `requirePhases:false`（或 `strict:false`）走旧语义。
- 复盘内容来自模型输出，插件只能校验「有没有写、写得是否够具体、是否覆盖四项」，**不能证明复盘内容真实**；真实性仍由主 Agent 对照产物核对。
- 记忆是文本数据：注入前已清除不可见字符与会话引用，并在提示词中声明不是指令；但一条被污染的记忆仍可能影响后续任务，主 Agent 应用 `dsh_workplan_lessons` 抽查并在发现污染时删除对应行。
- 插件无法自动判断「有没有走弯路」，只能要求子 Agent 如实填写 `detours`；确实没有时允许空数组，避免为了过门禁编造弯路。

### 四、验证

- `npm run check`（tsc --noEmit）退出码 0。
- `npm test`：**546 条全过、0 失败**（基线 536 + 新增 10 条 `tests/self-learning.test.ts`）；`npm run check`（tsc --noEmit）退出码 0。
- 新增 `tests/self-learning.test.ts`：复盘四项校验、完成判定缺复盘降级、提示词注入与复盘要求、落盘/去重/累加、坏行容错、相关度排序与统计、环境变量覆盖、指纹稳定。
- 工具面 fixture（`tests/fixtures/tool-surface.json`）与 `docs/cc` 同步到 11 个工具、2.0.1。

## 1.13.0 — 2026-11-05

**新增「三阶段工作法」：部门 Agent 收到工作后必须先规划、再执行、最后验证；阶段一、二不提供插件工作能力，阶段三才可用 `dsh_workplan_verify` 核验。完成判定新增三阶段证据门禁，缺段一律 blocked/unverified。**

### 一、改了什么

| 用户要求 | 本版实现 |
|---|---|
| 先全面梳理问题，再形成可执行思路，最后才动手 | `src/three-phase.ts#threePhasePromptLines` 写进每个子 Agent 提示词：阶段一先列事实/约束/未知/主要矛盾，再给步骤、产物、依赖、风险与验证方式，并明说「思路未形成前禁止动手」 |
| 全过程按规划→执行→验证三阶段 | 结果块新增必填 `phases`：planning（problemAnalysis/constraints/unknowns/approach）→ execution（steps/deviations）→ verification（allPassed/checks/requirementCheck）；`src/three-phase.ts#validatePhaseEvidence` 校验顺序与完整性 |
| 阶段一、二禁用插件 | 子 Agent 本就没有 update/replan/cancel/dispatch/status/instruct/handoff/followup 权限；新增的 verify 工具在只交 planning/execution 时返回 `PHASE_GATE`；提示词同时写明阶段一、二不得调用插件。唯一保留的是遇阻上报 `dsh_workplan_escalate`（安全阀，不属于计划/执行/验证能力），否则子 Agent 受阻只能空转或编造 |
| 阶段三可用插件验证是否成功、是否满足全部要求 | 新增 `dsh_workplan_verify`（`src/host.ts#createVerifyTool`、`src/runtime.ts#verifySubtask`）：提交三阶段证据，按计划验收表逐条核对结构与覆盖；核验通过也不等于完成，结果块仍须写同一份 phases，由 `adjudicateResult` 再判 |
| 完成判定必须挡住缺段 | `src/plan.ts#adjudicateResult` 对 done 默认 `requirePhases=true`：缺任一阶段、规划内容过薄（<40 字符）、`allPassed!==true`、验证条数少于验收数或未逐条对号、字段为空，一律 `blocked/unverified`，计划不可交付 |

### 二、验证

- `npm test`：**536 条全过、0 失败**（基线 523 + 新增 13 条 `tests/three-phase.test.ts`）；`npm run check`（tsc --noEmit）退出码 0。
- 新增用例覆盖：提示词含三阶段与禁用、合法 phases 仍 structured、缺 planning/思路过薄/allPassed=false/漏验均被降级、`requirePhases:false` 历史回放兼容、verify 工具的 `PHASE_GATE` 与 `VERIFICATION_INCOMPLETE`。
- 工具面 fixture（`tests/fixtures/tool-surface.json`）与 docs/cc 同步到 10 个工具、1.13.0。

### 三、事实边界（如实登记）

- 插件无法观测模型内部「想了多久、按什么顺序想」，只能把顺序变成**可审计的完成证据**：没有 planning/execution 证据就不算完成；阶段三核验只在模型主动调用时发生。
- 阶段一、二禁止的是插件的工作能力（计划/执行/验证）；`dsh_workplan_escalate` 是遇阻上报的安全通道，本版保留并在提示词中明确其例外身份。
- verify 只检查证据的结构与验收覆盖，不判断证据内容是否真实；真实性仍由主 Agent 核对产物与结果消息。

## 1.12.3 — 2026-11-04

**修好 MS2 20 条真实实跑暴露的四处缺陷：指代误拦（T05-08）、该问不问（T05-04/09/13/20）、未确认自行派发、法务召回缺失（T05-12）。默认行为变化：信息不足时不再生成计划、不再派发，改为向用户提问。**

### 一、四处缺陷的修法

| 编号 | 缺陷（MS2 实测） | 1.12.3 的修法 | 代码位置 |
|---|---|---|---|
| **① 指代误拦** | T05-08「它每天具体走势」——「它」的先行词就在同一句的上半句，却被判成「找不到先行词」直接拦下 | 先在**任务原文**的同一句、再在上一句里找「实体型」先行词（引号跨度，或含数字/字母的中文实体片段）；只有两处都找不到才拦 | `src/understanding.ts` `resolvePronounAntecedentInline` |
| **② 该问不问** | T05-04/09/13/20 四条本该澄清，却照做计划并派发 | 四条可判定规则：C1 裸表态、C2 悬空内部编号、C3 预测类无标的、C4 界面改动无对象；命中时**在规划之前**拦下，并给出一句可以原样问用户的话 | `src/understanding.ts` `auditClarifyNeed`；`src/plan.ts` `buildClarifyMessage`；`src/runtime.ts` 规划前闸门 |
| **③ 未确认自行派发** | 20 条里累计 46 次未经用户确认就启动部门 Agent | 按用户 2026-11-04 的决定：**自动派发语义不变**，只在「信息不足」这一类上拦截——缺信息时连计划都不生成，自然走不到派发 | `src/runtime.ts` `clarifyGateDisabled` / `maybePlan` |
| **④ 法务召回** | T05-12「会不会窃取用户文件和数据」判成无部门覆盖 | legal 词表增加 窃取 / 信息泄露 / 个人信息 / 数据安全 / 隐私风险 / 移动终端（刻意不用「泄露」：内存泄露属于工程问题） | `src/departments.ts` |

### 二、每一条结论的证据（可复核）

- **离线回放（不调用模型）**：20 条真实原文 → clarify **4/4 命中**，16 条正常任务**误拦 0 条**；T05-12 legal 命中 2 词（窃取、移动终端）；「修复内存泄露导致的崩溃」legal 命中 0 词；「参考国际标准做一下排版」仍为 1 词（低于 ≥2 门槛，不会把排版任务拉进法务）。
- **端到端（headless 真跑）**：用 T05-13 原文启动 headless → 事件流里 **0 个计划、0 次 `dsh_workplan_*` 工具调用**，模型改为向用户提问（证据见 `_t_clarify_20261104/`）。
- **自动化测试**：`npm test` **523 条全过、0 失败**（含新增 `tests/clarify-gate.test.ts`、`tests/antecedent-inline.test.ts`）；`npm run check`（`tsc --noEmit`）退出码 0。
- **修正了一条旧断言**：legal 词表从 16 词增到 22 词，`tests/department-coverage.test.ts` 的数量断言同步更新并写明原因；C4 曾把「把红圈处改为默认收起」误判成「没说要改哪里」，用 `department-fit.test.ts` 抓出来后才补上「红圈/红框/圈出」三种说法。

### 三、开关与行为影响

- 新增 `DSH_WORKPLAN_CLARIFY_GATE=0`：关闭澄清闸门，回到旧行为（信息不足也照做计划、照派发）。默认开启。
- `DSH_WORKPLAN_AUTO_DISPATCH` 语义**未变**：默认自动派发照旧，只是信息不足的任务不会再走到派发这一步。
- C3/C4 允许「缺的对象在最近对话里」：上一轮说过「截图红圈处的分步进度」，本轮「把它改成默认收起」就不算缺信息（否则会把正常追问也拦掉）。

### 四、本版没有覆盖的（如实登记，不计入修复证据）

- 同一工作区里还有一个 headless「未完成不得成功收尾」闸门（`failClosedOnIncomplete` / `WORKPLAN_INCOMPLETE`），目前**只有实现、没有自动化用例**；发布前必须补测，本版不宣称它已验证。

## 1.12.2 — 2026-11-04

**修好 G1/G2/G3 三个写保护漏洞（1.12.1 只记录了缺口）。这是一次有意的行为变更：已交付文件的写保护现在真正无死角，且不再区分「谁在写」。**

### 一、修了什么（三个漏洞，逐条）

| 编号 | 1.12.1 的状态 | 1.12.2 的修法 | 代码位置 |
|---|---|---|---|
| **G1** 子 Agent 不受保护 | 非根会话直接放行：「门卫只认户主，保姆拿钥匙能进」 | 去掉角色判断。已交付文件在计划未就绪期间不得被原地改写，**与谁在写无关**。 | `src/runtime.ts` `presentedWriteDenialReason` |
| **G2** 只认三个工具名 | 只接管 write / edit / str_replace_editor，第四个写工具（如 `apply_patch`）根本不进闸门 | 改为**按参数形状识别**写操作：带 `file_path`/`path`，或 patch 文本含 `*** Update/Add/Delete File:`。一次调用含多个文件时，只要有任一命中就整单拒绝。读类工具显式白名单排除。 | `src/host.ts` `fileWriteGuardReason` / `isWriteShapedCall`；`src/runtime.ts` `writeTargets` |
| **G3** 符号链接绕过 | 只做 `path.resolve`，`/link/report.md` 与 `/real/report.md` 被当成两个文件 | 两侧都归一到**真实文件身份**（`realpath.native`）。交付链接、写真实路径（或反之）都能认出来。文件尚不存在时解析最近的存在祖先；完全解析不了时退回旧行为。 | `src/runtime.ts` `realPathIdentity` / `identityPath` |

### 二、行为影响（会影响现有使用的部分，务必读完）

1. **子 Agent 写已交付文件会被拒绝**（G1）。以前后台子 Agent 能改掉用户手上那份报告，现在与主 Agent 同等对待。**present 仍只有主会话可用**，所以「交付能力」没有扩大，只是「改写已交付文件」的口子被堵上。
2. **更多工具名进入写保护**（G2）。过去改一个名字（如 `apply_patch`、`write_file`）就能绕过的写法，现在同样被拦；一次 patch 改动多个文件时，只要有一个是已交付文件就整单拒绝。
3. **符号链接不再是第二种写法**（G3）。通过软链接路径改写已交付文件会被拦下，报错文案与直接路径完全一致。
4. **照旧保留的出路**：计划交付就绪后放行；计划被 `dsh_workplan_cancel` 显式取消后放行；present 之后才新建的计划不受限制；plan 模式下写保护不生效。
5. **没有削弱的权限**：其余 8 处 `NOT_ROOT` 校验（子 Agent 不能 update / replan / cancel / dispatch 主计划、不能下发指示、不能处置跨部门需求、不能补发 follow-up、不能 present）**一处未动**。那是「子 Agent 不能改计划」的权限，与「不能改文件」是两件事。

### 三、验证（双向红绿，不是只跑一次绿）

- **修复前**（换回 1.12.1 的 `src/runtime.ts` + `src/host.ts`）：`tests 498 / pass 491 / fail 7`，失败项正是 6 条 G1/G2/G3 新用例 + 1 条既有契约用例。
- **修复后**：`tests 498 / pass 498 / fail 0`，退出码 0；`npm run check`（tsc --noEmit）退出码 0。
- 用例数构成：基线 495 + G1 一条 + G2 一条 + G3 反向一条 = 498。
- 三条原本「钉住缺口」的用例已翻转成「钉住修复」：`p03-m1-write-guard-gaps.test.ts` 的 G3 条、`p03-m1-guard-gating-gaps.test.ts` 的 G1/G2 条、以及既有契约 `workplan-presented-write-guard.test.ts` 中「非根会话放行」的断言。

### 四、事实边界（不得外推）

- 真实模型在 20 条任务上的通过率**未被本版刷新**，仍为 2026-11-03 的 `pass 4/20`。原因：模型密钥 4 个环境变量全空 + 工作区外写配置权限缺失，20 条真实模型验证无法在本轮重跑。
- 1.12.2 是**代码级修复 + 回归验证**的结论，不代表 20 条真实模型任务的表现有任何变化。

## 1.12.1 — 2026-11-04

**补强任务理解的三处漏判：部门覆盖硬校验、指代先行词核实、写保护缺口固化测试。**

### 一、改动内容

1. **部门覆盖硬门禁（P0-1）**：任务原文命中某部门职责词 ≥2 个时，计划必须安排该部门，或在 `taskUnderstanding.assumptions` 写明「不安排<部门>：理由」，否则校验直接拒绝。新增 `REQUIRED_DEPARTMENT_MIN_HITS = 2` 与 `auditDepartmentCoverage`。同时补齐安全/运维/法务词表，并支持「打…标签」这类有序对匹配（跨度上限 12）。
2. **指代先行词核实（P0-2）**：旧逻辑只要最近对话非空，就把所有「它 / 上面那个 / A / B」判为已解析；现在必须真正从对话里抽到先行词（新字段 `antecedent`），抽不到就判 `needs-context` 并要求澄清。选项字母只有在对话里真的列出过该选项时才认。另外收窄了字母识别：只有「选/选项/方案/可选/建议/采用/按」紧邻 A–D 才算未解析引用，排除「A/B 测试」和列表编号。
3. **写保护缺口用例（P0-3 / M1）**：只新增测试、不改任何源码行为，固化已实测确认的三个缺口——G1 只保护根会话、G2 只识别 write/edit/str_replace_editor 三种工具、G3 符号链接写法绕过路径归一。用例断言写成「与基准路径行为一致」，缺口修好时会自动转绿。

### 二、事实边界

- 本版**没有**修复 G1/G2/G3，只把缺口固化成测试；G1/G2/G3 的修复涉及现有契约（`tests/workplan-presented-write-guard.test.ts` 的「非根会话放行」用例），属产品取舍，需单独评审。
- 真实模型在 20 条任务上的通过率**未被本版刷新**，仍为 2026-11-03 的 `pass 4/20`。

### 三、验证

`npm test` 495 条全过、0 失败、退出码 0（基线 490 + 新增 5）；`npm run check`（tsc --noEmit）退出码 0；构建后 `lib/` 与 `src/` 同步。

## 1.12.0 — 2026-11-02

**把三类异质改动收敛为一次发布：T11 低风险缺陷补丁 rebase（15 个缺陷 / 44 个 hunk）、任务理解与部门分配机制修正、分步进度折叠 UI；并逐条给出 U-15…U-21 的结论或明确决策请求。**

> **事实边界（发布说明不得外推）**
> 1. 本版证明的是「代码级护栏 + 固定样例 + 全量回归」。真实模型在 20 条任务上的理解质量与部门命中率**尚未验证**（T5 D-1）。
> 2. 计划生成后**默认自动派发**（`autoDispatch` 默认 true，plan 模式除外；`autoDispatch:false` 或 `DSH_WORKPLAN_AUTO_DISPATCH=0` 可关闭并回到 plan-first）。
> 3. D-01 的验收改为**稳定编号 A1…An + 单向包含**：只写验收标准的一部分不再算覆盖，自创验收项也不能顶替计划验收（Q6 / U-16）。
> 4. 真实浏览器点击未在本机执行（缺浏览器自动化与 3080 鉴权）；组件级交互验收 17/17 通过，发布前仍需主 Agent 在 GUI 手工点验一次。

### 零、1.12.0 收口：自动派发与验收编号（T6 Q2 / Q6）

- **自动派发**：计划落地后立即以 async 方式调用 `dispatchPlan`，结果仍由 `finishRound` 写回；
  计划消息改为「已自动派发，不要重复调用 dispatch」。plan 模式不自动派发；预算、取消、
  幂等、交付门禁与自动续跑全部保留。三态解析：配置 > `DSH_WORKPLAN_AUTO_DISPATCH` > 默认 true。
- **验收稳定编号**：子提示词把计划验收编号为 A1…An，证据块 `criterion` 以 A1/A2… 对号入座；
  `acceptanceCoverage` 同时去掉反向包含（`criterion.includes(row)`），部分文字不再被判覆盖。
- 新增回归：子串绕过被拦、A1/A2 编号通过、缺少编号时只覆盖对应项、计划消息自动派发文案；
  全量 **459 / 459 pass，0 fail**，`npm run check` exit 0。

### 一、rebase：15 个低风险缺陷补丁

补丁：[`_t8_rebase_20261102/out/T11-1.12.0.patch`](../_t8_rebase_20261102/out/T11-1.12.0.patch)（7 文件 / 44 hunk / SHA256 `6331f169…aadb00f`），基于 `HEAD f5160ff`（1.11.1）重生成，`git apply --check` 与 `patch --fuzz=0` 均为 0 退出码，无 `.rej`。

45 个源 hunk 的去向（T7 台账 → T8 对账）：

| 去向 | 数量 | 说明 |
|---|---:|---|
| 可直用 | 31 | 上下文未受 1.11.0/1.11.1 影响 |
| 需改写 | 11 | 按 HEAD 上下文重写（含 D-45 的 1.12.0 版本口径、D-30 的回放透传拆分） |
| 建议废弃 | 3 | D-15 两段、D-17 一段；对应缺陷已被 1.11.0 以不同实现修复，强打会回退已修逻辑 |
| 对齐新增 | 1 | B1（文档口径） |
| **最终 patch hunk** | **44** | 42 保留（#37 拆分 1→2，已含测试文件 hunk）+ 1 对齐 |

覆盖的 15 个缺陷 ID：`D-04 / D-07 / D-08 / D-09 / D-10 / D-11 / D-15 / D-17 / D-19 / D-21 / D-28 / D-30 / D-31 / D-35 / D-45`。逐 hunk 落点见 `_t8_rebase_20261102/out/T11-1.12.0.map.json` 与 `source_decisions.csv`；D-15/D-17 的断言保留在 `tests/t11-lowrisk-patches.test.ts`，用于防止 1.11.0 的修复被回退，但不计作本次新增修复。

回归覆盖（详见 `_t9_regression_20261102/T9_回归用例补齐与实跑记录_20261102.md`）：

- 44/44 个 patch hunk 至少对应 1 条可执行用例，缺口 0；
- 新增 52 条：补丁自带 `tests/t11-lowrisk-patches.test.ts` 13 条 + `tests/t9-hunk-contract.test.ts` 34 条 + `tests/t13-gap-cases.test.ts` 5 条；
- 未打补丁基线同批对照：43/44 个 hunk 为 fail-before；唯一例外 hunk 33（D-19，基线本就拒绝环）已标注为「补独立基线」，不冒充判别力；
- T13 的 5 条补位用例已适配 1.12.0 版本口径（原断言写死 1.11.0，直接复用会假失败）。

### 二、任务理解与部门分配（T10）

改造前：`validatePlan(raw)` 拿不到用户原文，12 个部门只有中英文名，子 Agent 提示词首行才出现部门；「分配是否合理」在机制上不可判定。

改造后（纯函数，无模型、无网络、无时钟、无文件系统）：

- **任务锚点** `taskAnchor`：保存用户原文 + `sha256` + 长度 + 来源消息；哈希不一致即降级为 `null`，不会带着被改写的「原要求」通过校验；
- **要素抽取** `extractTaskElements()`：版本号、日期、编号、路径、数量、数值边界、显式否定、指代、矛盾；裸「它」等无上下文指代判 `needs-context`，不猜；
- **部门能力目录** `src/departments.ts`：12 个部门各有 `responsibilities / outputs / keywords`；`departmentFit()` 输出 `fit / weak / mismatch`、命中关键词、`bestAlternative` 与受保护部门的 `intrusion`；
- **偏离自检** `auditTaskUnderstanding()`：硬要素缺失、交付动作缺失、复述覆盖、部门矛盾；严格模式下以 `DEVIATION:` / `CLARIFY:` / `CONTEXT:` 前缀阻断并走既有重试/降级，不派发；
- **提示词**：规划提示词要求每个子任务写 `departmentRationale`；子 Agent 提示词注入部门职责、典型产物与只读锚点（含哈希前 12 位）；
- **回退开关**：`DSH_WORKPLAN_CONTEXT_GUARD=off` 时审计仍运行并写盘，但只告警不阻断。

真实历史计划回放（41 个子任务）：`fit 41/41`、`mismatch 0`；S3 的 7 个硬要素 0 丢失。该结果证明「旧计划不会被新护栏误伤」，**不证明真实模型对新任务的理解质量**。

### 三、自动化闭环口径修正（T11）

本版修正 4 组会让自动化闭环「看起来在跑、实际丢状态」的缺陷，均有 fail-before / pass-after：

1. 预算到点不再把 `escalated` / `instructed` / `replanned` 三类闭态行重置为 `pending`（原先会清空请示、触发 `INVALID_TRANSITION`、或让一条历史旧行毁掉整轮派发）；
2. 新增 `liveResumeCounts`：`replanned` 旧行不再被当作 pending，避免 live 行全 done 仍空排一轮并写误导性停止行；
3. `HAS_BLOCKED` 不再被 `NOTHING_PENDING` 抢先，`paused + blocked + 0 pending` 如实答「有受阻」，不再答成「证据缺口」；
4. 修正 3 处「自动续跑默认关闭」的错误文案（实现默认开启）与 1 处不存在的 `tools.guard` 强制派发注释。

本版已实现默认自动派发（见 §零）；plan 模式与 `DSH_WORKPLAN_AUTO_DISPATCH=0` 保留 plan-first。

### 四、分步进度折叠 UI（T12）

`PlanOverview` 的「分步进度」每行改为可点击展开/收起，**默认收起**：

- 收起态只显示状态点、第 N 步名称、进度条、done/total、状态词与折叠箭头；
- 点击行或键盘 Enter/Space 展开该步摘要（目标、检查点、子任务状态）；再次触发收起；
- `aria-expanded` / `aria-controls` 与 `hidden` 面板同步；点击不冒泡到外层卡片；
- 展开状态按会话存 `dsh-workplan:planrow-open:v1:<sessionId>`，刷新后恢复；localStorage 抛错时降级为纯内存，不影响点击；
- 统计数字与既有阶段卡不变，未删除下方「分几步做」列表（D-6 未拍板）。

局限：`stage id` 在重规划后可能复用，旧展开态可能被新阶段继承（T13 观察 O-2，不丢数据、不影响点击，未阻塞）。

### 五、U-15…U-21 结论

| ID | 结论 | 证据 / 待决 |
|---|---|---|
| U-15 | **本版已关闭** | 1.12.0 集成树 `npm test` 459/459、`fail 0`、退出码 0；原始日志见 T14 发布包 `logs/t14final2_npm_test.log` |
| U-16 | **已修（1.12.0）** | 验收改为稳定编号 A1…An + 单向包含；证据只写「通过登录测试」不再覆盖「通过登录测试与越权测试」。复跑探针 `BYPASS=BLOCKED`（`logs/t14final2_u16_probe.log`）；回归见 `tests/workplan-crossdept-hardening.test.ts` |
| U-17 | **未关闭，不得写「已修 N/42」** | 42 条 present 中，T11 用例覆盖 12 条、D-01/D-13 已复验，仍有 28 条无复验；T9 的 44 hunk 覆盖不等于 42 缺陷全覆盖 |
| U-18 | **已关闭** | `v1.11.0` 干净树重跑 `npm test`：363/363、`fail 0`、退出码 0（T14 日志 `logs/v110_npm_test.log`） |
| U-19 | **内容已闭合，时刻保留说明** | 1.12.0 map 由 `gen_map.py` 从最终补丁反解生成，45/45 源 hunk 一致；旧 map 的 `createdAt` 与 mtime 矛盾仍如实记录，不再作为 1.12.0 权威映射 |
| U-20 | **已关闭** | `_t12_high_risk_patches_20261102/ROLLBACK.md` 已存在；该 P0 补丁（D-01/D-13）不进入 1.12.0 |
| U-21 | **需主 Agent/用户确认口径** | 以 `T14_诊断与修正总报告_20261102.md` + 证据索引为准，`dsh-workplan-1.11.0-final-report.md` 降为参考 |

### 六、测试

| 检查 | 结果 |
|---|---|
| `npm run check`（tsc --noEmit） | exit 0 |
| `npm test` | **459 tests / 459 pass / 0 fail / exit 0**（约 4.4s） |
| `version-sync` | 2/2 通过；`verify_version.mjs` 10 个声明点（含 README 版本徽章）全部 1.12.0 |
| 基线对照（未打补丁） | 43/44 hunk fail-before；基线原套件 364/364 通过，排除环境故障 |
| `v1.11.0` 复跑 | 363/363，exit 0（U-18） |

459 = 1.11.1 之后已并入的机制/UI 用例 404 + 本次 rebase 52 + 1.12.0 收口新增 3（U-16 / 自动派发文案）。

### 七、破坏性变更

**无。** 可复核理由：

1. `PLAN_VERSION` 仍为 `1`（`src/plan.ts:16`），计划消息契约未变；
2. 未删除或改名任何字段/工具；新增 `taskAnchor`、`understandingAudit`、`departmentRationale` 均为可选字段；
3. `STATUSES` 仍为四值，计数与交付门禁语义不变；
4. 旧日志/旧计划缺新字段时按 1.11.1 语义降级（`degraded`、不阻断），刷新回放不翻红。

### 八、升级

```bash
dsh plugin --profile web add dsh-workplan@1.12.0
```

装完重启 DSH Web（或重新载入页面）。无需配置迁移；若新护栏误拒正常计划，可临时设 `DSH_WORKPLAN_CONTEXT_GUARD=off` 只告警不阻断，并把样例反馈回来。

### 九、已知缺口（如实列出，不折算为已修）

- U-16 验收子串绕过：**已修**（A1…An 稳定编号 + 单向包含），复跑 `BYPASS=BLOCKED`；
- U-17 28 条 present 缺陷未逐条复验；
- 自动派发：**已实现并默认开启**（plan 模式除外，`DSH_WORKPLAN_AUTO_DISPATCH=0` 可关闭）；真实宿主端到端自动派发未单独跑，证据为代码级 + 单测；
- 真实模型 20 条任务的理解质量/部门命中率：未验证；
- 真实浏览器点击：未执行（组件级 17/17 已过）；
- 索引源：本仓库只能提上游条目 PR，catalog npm 由上游 CI 重建；PR 合并前不得写「已上索引」。

## 1.11.1 — 2026-11-02

修复 1.11.0 中一个「已声称、但数据层未生效」的问题：

- **D-13 重规划 cancel 的下游悬挂**：1.11.0 只在 dispatch/readiness 阶段补了收束，而实时与回放共用的 `applyReplanStatuses` 仍只标记被取消行本身；直接走数据层时下游仍停在 `pending`（T12 探针在 1.11.0 的 `lib/` 上实测为 FAIL）。1.11.1 把传递闭包放进 `applyReplanStatuses`：直接下游的 `blockedBy` 指向被取消的上游，间接下游的 `error` 回溯到根源取消项与取消原因，刷新后与实时一致。
- 回归：新增 A→B→C 的取消级联用例；`npm test` **364 / 364 通过**。
- 其余 1.11.0 内容不变。

## 1.11.0 — 2026-11-02

**闭环契约 v1：为「派发 → 执行 → 遇阻 → 请示 → 指示 → 回报 → 进度 → 重规划」补上回执、上行请示与重规划通道；并如实标注本版仍未落地的深度下限。**

> 本版直接回应用户的 8 条质疑。判定沿用 T3：**3 条成立（③④⑥）、5 条部分成立（①②⑤⑦⑧）、0 条不成立**。
> 1.11.0 把 ①–⑧ 中「机制缺失」的部分全部补齐：派发回执、上行请示、下行指示与回执超时、完成必回报（沉默不再算成功）、验收逐条证据下限、就地重规划、左侧栏闭环徽标。**仍按设计延后的只有 SSE 推送（D1）、独立复核（D3）与预算/并发调参（D4）**——它们改变的是时延与成本，不是闭环是否存在。

### 8 条疑问逐条处置

| # | 疑问 | T3 判定 | 1.11.0 处置 | 代码落点 | 尚余 |
|---|---|---|---|---|---|
| ① | 下发分解 | 部分成立 | **已修复（回执与下发确定性）**：计划消息点名「必须调用 `dsh_workplan_dispatch`」；派发即写 `closure:'assigned'` + `dispatchSeq`；子会话首个进度事件写 `acknowledged`；90s 未回执标 `ackOverdue`，180s 仍无事件判 `blocked/no-ack` 并中止该次尝试 | `src/plan.ts:1038-1039`；`src/runtime.ts:903`（assigned）、`996`（acknowledged）、`929`（90s）、`941-955`（180s） | 无模型参与的完全自动派发延后（D2：会绕过预算/权限判断） |
| ② | 执行深度 | 部分成立 | **已修复（深度下限）**：删掉「证据足够就立即汇报」，改为「每条验收标准至少一处可复核证据」；`acceptance[].result==='pass'` 但没有 `evidence` 时降级为 `unverified`（C-19），交付门禁据此继续拦；`strictCompletion` 默认开启，可用 `DSH_WORKPLAN_STRICT_COMPLETION=0` 回到宽松档 | `src/plan.ts`（`readEvidenceAcceptance` 降级、`deliveryReadiness` 证据 blocker）、子提示词「执行要求」段；`src/host.ts`（`strictCompletion` 三态解析） | 独立复核延后（D3）、预算/并发调参延后（D4）；这两项是成本策略，不是深度下限 |
| ③ | 遇阻主动上报并请示 | 成立 | **已修复**：新增子会话工具 `dsh_workplan_escalate`（question 必填、按 `childId` 反查计划、写入 `blocked + closure:'escalated'` 并向父会话追加 `workplan-update`）；子提示词强制「遇阻先上报、再停止等待」；工具不可用时结果块的 `question` 走文本兜底；父层提示第 8 条要求当轮处理待指示项 | `src/host.ts:593`；`src/runtime.ts:3761`、`3814`；`src/plan.ts:3204-3210`、`1705-1717`；`src/host.ts:115` | 300s 空闲仍按失败收束，不会自动改判 `escalated`（只有子 Agent 主动上报或结果块带 question 才升级） |
| ④ | 收到指示后是否执行 | 成立（子层） | **已修复**：新增根会话工具 `dsh_workplan_instruct`（仅根会话、仅 `closure:'escalated'`、仅直接子会话；`sendMessage` 投递成功后写 `closure:'instructed'` + `instruction` + `instructionSeq`；投递失败返回 `DELIVERY_FAILED` 且**不改状态**）；指示写入 60s 无进展标 `instructionOverdue`、180s 仍无事件判 `blocked/no-ack`；子会话来重新激活时，`buildChildPrompt` 会把 `instruction.text` 注入提示词（不靠模型自己回想）；续跑重置不再把 `instructed` 洗成 `pending` | `src/host.ts`（`createInstructTool`）；`src/runtime.ts`（`instructSubtask`、`scheduleInstructionAck`）；`src/plan.ts`（`buildChildPrompt` 指示注入、`resetBlockedStatuses` 跳过 instructed） | 投递失败后的自动重投仍由主 Agent 重试（状态保持 `escalated`，不会假称已指示） |
| ⑤ | 完成后主动回报 | 部分成立 | **已修复**：结构化证据块成为完成的必要条件——没有证据块、又没写 `BLOCKED:` 的结果判 `blocked/unverified`（C-05，沉默不再算成功）；结果消息写成功后才由 `markReported` 把 `done` 行标 `closure:'reported'` + `report{state,at,ref,turn}`；`closure:'done'` 且 `updatedBy:'child'` 的行进交付 blocker；记录级 `reportPending` 同样拦交付；旧日志无 `closure` 时按 1.10.6 语义回放（done 视为已回报），避免升级后所有历史计划不可交付 | `src/plan.ts`（`adjudicateResult` 严格分支、`deliveryReadiness`）；`src/runtime.ts`（`markReported`、`settleFromOutput` 的 `closure:'done'`）；`src/host.ts`（`strictCompletion`） | 无 |
| ⑥ | 需求变更及时重规划 | 成立 | **已修复**：新增根会话工具 `dsh_workplan_replan`（`cancel`/`replace`/`add`）；执行中出现的新要求不再被丢弃，先暂存为 `changeRequest` 并由 pre-step 通知主 Agent 判定；旧行保留 `closure:'replanned'` + `supersededAt`/`replacedBy`，不计入剩余分母、不再调度、不再参与交付门禁；`planRevision` 随修订递增；未落实的变更进交付 blocker | `src/host.ts:308`（注册 `1013`）；`src/runtime.ts:2973`、`5153`、`5212`；`src/replan.ts`；`src/plan.ts:2820`、`2888` | 变更语义仍由主 Agent 判定、代码只检测与暂存（E7，按设计） |
| ⑦ | 左侧栏进度同步 | 部分成立 | **已修复（展示半边）**：`serialisePlan` 在同一快照中下发 `closure`/`replacedBy`/`report`/`planRevision`/`blockedKind`/`question`/`instruction`；客户端按服务端字段渲染闭环全档徽标——「待你决定」「已给指示 · 待执行」「已下发 · 待回应」「已回应 · 执行中」「完成 · 待回报」「已回报」「已重规划」；仍不持本地状态机，仍是写入后 ≤4s 的同一轮询链 | `src/runtime.ts`（`serialisePlan`）；`src/client.ts`（`SubtaskRow` 的 closure 分支与文案） | SSE 实时推送延后（D1）：现状是 ≤4s 有界延迟，不是不同步 |
| ⑧ | 底层机制/逻辑 | 部分成立 | **部分修复**：新增与四值 `status` 正交的 `closure` 九状态（`pending/assigned/acknowledged/instructed/escalated/blocked/done/reported/replanned`），`STATUSES` 仍为四值；唯一写入口仍是 `applyStatus`；非法 `closure` 抛 `INVALID_CLOSURE`；契约外迁移抛 `INVALID_TRANSITION`（`CLOSURE_TRANSITIONS` 白名单，`replanned` 为终态）；`escalated` 必须同时是 `blocked`；四个新工具的服务端权限硬校验（子会话/根会话、直接子会话、待指示状态）不依赖提示词 | `src/plan.ts:110`（STATUSES 未扩）、`123-133`（CLOSURES）、`1976-1980`、`2278-2281`；`src/host.ts:1005-1013` | D1–D4 延后；②⑤ 的上述缺口仍属机制未闭合——见 G1–G3 |

### 跨部门协作闭环（本版新增，回应用户追加要求）

> 追加要求原文：**「对于需要跨部门协作的时候，现有的这个插件是否有对应的完美机制，你必须同样全面、深入、全面地毯式、深入排查、诊断和修正。严禁发生不合理、不完美的跨部门协作机制。」**

1.10.6 的跨部门协作只有三件事：子任务带 `department`、兄弟部门进展通过 `buildTeamBrief` 只读展示、`needs` 以一段文字出现在结果消息的「跨部门待转达」里。它没有生命周期，也不进交付门禁：主 Agent 忘掉一条需求，计划照样可以 `present`。

1.11.0 把它补成一条可追踪、可处置、可验证的闭环：

- **需求自动登记**：`applyStatus` 在写入 `needs` 时同步生成 `handoffs`（`H1`、`H2`…），字段为 `{id, request, department, status, response, at, updatedAt, by}`，去重键是需求原文。任何写路径（子 Agent 结算、结果消息回放、人工改判）都无法只留一段文字而不留下可追踪记录。
- **四态生命周期**：`open`（已提出，未处置）→ `routed`（已指派部门）→ `answered`（已给出书面答复或产物引用）/ `closed`（判定无需动作）。只有 `answered` / `closed` 解除交付阻塞；`open` / `routed` 会在 `deliveryReadiness` 里生成「跨部门需求未落实」blocker，`present` 被拒绝。
- **唯一处置入口**：新增根会话工具 `dsh_workplan_handoff`（`list` / `assign` / `resolve` / `close`），服务端 `isRootSession` 硬校验；子 Agent 只能提出需求，不能宣称需求已解决。处置结果写回同一条状态行并追加可回放的 `workplan-update`。若提出需求的行正处于「待指示」，`resolve` 会复用 `instructSubtask` 的投递与回执链路把答复直接送进子会话——只改计划表、不唤醒等待方的「闭环」不算闭环。
- **答复回到提出方**：子任务下次被激活时，`buildChildPrompt` 把已答复的需求（含答复正文）与仍在等待的需求一起注入提示词；等待中的明确要求「不要重复上报、先做不依赖它的部分」。
- **交接物可消费**：派发时为下游注入的依赖结果不再只有状态与摘要，还带上游 `artifacts[].exists===true` 的产物引用（`runtime.ts` 的 `dependencyResults` 映射），跨部门交接从「知道做完了」变成「知道产物在哪」。
- **进度栏可见**：`SubtaskRow` 渲染每条需求的编号、原文、指派部门、四态文案与答复，用户不必从结果消息里猜「这条需求谁在办」。
- **测试**：`tests/workplan-closure-n1-n5.test.ts` 覆盖「needs 自动登记 → 未处置拦交付 → 指派后仍拦 → 答复后放行」与去重、回放；`npm test` 363 / 363 通过。

### 交付门禁收紧（跨部门审计 T4/T5/T8/T10 的阻断项）

第二轮地毯式审计（`_t5_contract_20261102/`、`_t8_scenario_20261102/`、`_t10_defect_triage_20261102/`，79 条来源缺陷去重为 54 条）确认本版还有两处**阻断级**缺口。它们不是新功能，而是「计划说完成了、其实没完成」的放行路径，本版一并堵住：

- **验收不可自证（D-01）**：`adjudicateResult` 原先只检查证据自身的 `result/evidence`，计划写的 5 条验收可以被一条「自创验收项：pass」全部绕开。现在裁决与交付门共用 `acceptanceCoverage`：证据必须逐条回应计划验收（允许措辞差异，短文本只接受等值），少一条即 `blocked/unverified`，交付阻塞写明「验收项未被逐条回应（N/M）」。
- **未验收上游不得解锁下游（D-02）**：调度门的 `dependencyOk` 原先只看 `status==='done'` 与缺失产物；上游 `unverified/failed` 时下游照常开跑。现在 `unverified/failed` 一律不放行（`legacy` 旧日志与 `structured` 仍放行，避免历史计划整体卡死）。
- **cancel 悬挂下游（D-13）**：`replan cancel` 不重写下游 `dependsOn`，下游会永久 `pending`。现在派发与交付判定前由 `blockCancelledDependents` 把这类下游显式标 `blocked`，并写明「请用 replan 重新安排或取消」。
- **级联不再撞非法迁移（F6-01）**：`markDependentsBlocked` 跳过 `closure:'replanned'` 的历史行，避免 `replanned → blocked` 抛 `INVALID_TRANSITION` 污染整轮。
- **replan 与首次规划同强度（D-T4-03/04）**：`add/replace` 校验 `dependsOn≤12`、`method/inputs/outputs≤12`、`acceptance 1–8`、字符串长度；容量只数未 `superseded` 的活跃行，满编 15 项时也能 replace；新阶段 ID 撞名时追加后缀，保证新任务始终在末尾。
- **子会话不得直接交付（T7 P9）**：`present` 的守卫对非根会话不再放行，返回 `NOT_ROOT`「子 Agent 不能直接交付」；交付只属于根会话。

以上 6 条均有 `tests/workplan-crossdept-hardening.test.ts` 回归（9 条）与 `tests/present-deny-code.test.ts` 的码值契约更新。

### 走查修正（T10 端到端报告 N1–N5）

端到端走查（`_t10_walkthrough_20261102/`）在已完成机制上又发现 5 处「机制对了、读出来的样子不对」，本版一并修复：

- **N1 阶段分母双口径**：`planStageRows` 现在过滤 `supersededAt` 旧行；重规划后不再出现「头部 100%、阶段条 1/2」。
- **N2 等指示被当成可续跑**：`canResumePlan` 跳过 `closure:'escalated'` 的行；「待你决定」不再显示为可续跑，也不消耗续跑额度。
- **N3 指示后仍显示卡住**：`reconcilePhase` 允许 `blocked` 在有活跃行时对账为 `executing`，`instructSubtask` 写入后立即重算 `record.phase`。
- **N4 指示回执字段被丢弃**：`applyStatus` 增加 `instructionOverdue` 分支并可回放；`scheduleInstructionAck` 新增 5s 轮询，子会话一有新事件就写 `acknowledged` 并撤销 60s/180s 定时器（正常工作但较慢的子会话不会再被误判 no-ack）；进度栏新增「指示还没被执行」徽标。
- **N5 变更正文不进进度栏**：卡片新增「需求变更待落实」横幅，显示变更原文与「本轮结束后重规划、不会丢失」的说明。

### 机制改动明细

- **派发回执**：`runtime.ts:903` 在启动子会话后写 `closure:'assigned'`、`assignedAt`、`dispatchSeq`；同一 `dispatchSeq` 的第一个进度事件写 `acknowledged`（`runtime.ts:996`）并撤销两个定时器；90s 写 `ackOverdue`（`runtime.ts:929`），180s 写 `blocked/blockedKind:'no-ack'` 并 abort（`runtime.ts:941-955`）。重试是全新尝试，旧的 `ackedAt`/`escalatedAt`/`question` 一律清空。
- **上行请示**：`dsh_workplan_escalate` 只接受子会话，按 `childId` 反查父计划（不信自报 `subtaskId`），`question` 必填、`options` 最多 6 条；写入 `blocked + closure:'escalated' + blockedKind:'escalated'` 并向父会话追加一条 `workplan-update`（`runtime.ts:3814-3862`）。子会话拿不到工具时，结果块里的 `question` 由 `adjudicateResult` 解析并走同一 `escalated` 投影（`plan.ts:1705-1717`、`runtime.ts:739-750`）。
- **下行指示**：`dsh_workplan_instruct` 校验根会话、`closure==='escalated'`、直接子会话，`sendMessage` 成功后写 `status:'in_progress' + closure:'instructed'`，并 append 同一条 update 供回放（`runtime.ts:3883-3985`）；失败路径 `DELIVERY_FAILED` 明确提示「状态未改变」。
- **完成回报**：`markReported` 是唯一写入点（`runtime.ts:3489`），只处理 `status:'done'` 的行，已 `reported` 的不重复写；`deliveryReadiness` 新增「`closure:'done'` 且 `updatedBy:'child'`」与记录级 `reportPending` 两类 blocker（`plan.ts:2842`、`2892`）。
- **重规划**：`src/replan.ts`（569 行）承载 `cancel/replace/add` 的纯函数；`runtime.ts:2973` 的 `replanPlan` 负责权限、修订号与持久化，执行中调用返回 `REPLAN_PLAN_RUNNING` 并保留 `changeText`；`plan.ts:2820` 把 `replanned` 行从剩余分母剔除，`runtime.ts:95-108` 让其不进入调度。
- **完成判定收紧**：`adjudicateResult` 的 `!parsed.found` 分支从 `done/legacy` 改为 `blocked/unverified`；`readEvidenceAcceptance` 把「宣称 pass 但没有 evidence」降级为 `unverified`；`deliveryReadiness` 对无证据的 pass 另记一条 blocker。严格档默认开启，`strictCompletion:false` / `DSH_WORKPLAN_STRICT_COMPLETION=0` 可回放旧行为。
- **状态机闸门**：`CLOSURE_TRANSITIONS` 逐状态列出合法出边，`applyStatus` 在投影校验之前拒绝契约外迁移；重试的 `blocked→assigned`、结果回放的 `pending→reported` 是两条显式例外。
- **指示闭环**：`instructSubtask` 投递成功后启动 60s/180s 两级回执定时器；`buildChildPrompt` 在 `closure:'instructed'` 时把 `instruction.text` 注入子提示词；`resetBlockedStatuses` 不再重置 `instructed` 行，避免续跑把指示静默抹掉。
- **进度读取**：字段全部来自 `serialisePlan` 的同一次快照；HTTP 仍只有一个 `/dsh-workplan/plans` GET；客户端 4s 轮询、按服务端 `closure` 渲染徽标，不做状态推导（`client.ts` 的 `SubtaskRow`）。

### 行为变化（非破坏性）

- 子任务派发后若 180s 内没有任何事件，状态会显示 `blocked`（原因 `no-ack`）而不是一直 `in_progress`，并中止该次子会话；重试策略不变（仍最多一次）。
- 子 Agent 主动上报遇阻后，该行保持 `blocked + escalated`；父会话必须用 `instruct` 回答或显式改判 `blocked`，交付门禁不会把它当成已完成。
- `done` 行只有在结果消息确实写入会话后才变为 `reported`；写失败时整轮记 `reportPending`，下一次交付被拦。
- 执行中收到的新要求会生成 `changeRequest` 并在 pre-step 提示，主 Agent 必须 `replan`/`dispatch`/`cancel` 三选一，不能再静默略过。

### 破坏性变更

**无。**

- `PLAN_VERSION` 保持 `1`（`src/plan.ts:14`），消息格式未变；
- 未删除或改名任何既有字段/工具，新增字段均为可选；
- `STATUSES` 仍是 `pending/in_progress/done/blocked` 四值（`src/plan.ts:110`），四值语义、计数与门禁不变；
- 旧日志没有 `closure` 时按 `null` 回放，`done` 行按 1.10.6 语义视为已回报（`src/plan.ts:1890`）；
- 新增的 `escalate`/`instruct`/`replan` 是纯增量工具，旧工具的参数面未变。

### 迁移与安装

**不需要迁移数据或改历史计划。** 升级后旧会话重新打开时按原语义回放；`closure` 为空的旧行不会被误判成「未回报」。

```bash
dsh plugin --profile web add dsh-workplan@1.11.0
```

装完重启一次 DSH Web（或重新载入页面）。

### 测试

`npm test`：**363 / 363 通过**（`src` + `tests` 全量，含 `tests/version-sync.test.ts` 对版本位点、CHANGELOG 标题与 README 安装命令的一致性断言）。新增用例：`tests/workplan-crossdept-hardening.test.ts`（验收覆盖、未验收上游、cancel 悬挂、replan 容量与字段强度 9 条）、`tests/workplan-closure-ack-escalation.test.ts`（9 条）、`tests/workplan-replan-progress.test.ts`、`tests/workplan-closure-n1-n5.test.ts`（走查修正 + 跨部门闭环 5 条）、`tests/workplan-evidence-contract.test.ts` 增补 3 条（严格判定、`strict=false` 兼容档、C-19 证据降级）；`tests/workplan-host-schema.test.ts` 纳入四个新工具的 schema（escalate / instruct / replan / handoff）。

### 未包含（列入 1.12 的入口）

- **D1** SSE 推送：左侧栏继续 4s 轮询（写入后 ≤4s 可见，不是「不同步」）。
- **D2** 完全自动派发：会绕过预算/权限判断，保持「计划消息点名 + 收尾闸门」。
- **D3** 独立复核/深度下限：需要第二套模型预算与复核判定标准。
- **D4** 预算/并发/maxDepth 调参：900s/1200s/5 并发是现有安全边界，需基准后再动。

### 本版固化的闭环语义（发布前自查）

- **状态机有闸门**：`applyStatus` 拒绝契约外迁移（`INVALID_TRANSITION`），`replanned` 是终态；重试路径（`blocked → assigned`）与结果回放（`pending → reported`）是显式允许的两条例外。
- **完成必须有证据**：无证据块 → `blocked/unverified`；`pass` 无 `evidence` → 降级 `unverified`；完成但未回报 → 交付 blocker。
- **指示必须能到、能被确认**：`instructed` 行在下次激活时把指示注入子提示词；60s/180s 两级回执超时；续跑重置跳过 `instructed`/`escalated`。
- **进度栏与服务端同源**：客户端只渲染 `serialisePlan` 下发的 `closure`，不推导状态。

### 仍按设计延后（不是缺口）

- **D1** SSE 推送：「写入后 ≤4s 可见」是有界延迟；改为推送属于性能优化，1.12 入口。
- **D3** 独立复核：需要第二套模型预算与复核判定标准。
- **D4** 预算/并发/maxDepth 调参：900s/1200s/5 并发是安全边界，需基准后再动。

## 1.10.6 — 2026-11-01

**修复：单个子任务超时后的「自动重试一次」在真实链路里是死代码；自动续跑开关默认关闭，等于从来没有打开过。**

> 用户 19:40 的原话：「超时的已分配子任务不会自动完美重试吗？这不是严重缺陷吗？」
> 上一轮 1.10.3 声称修好了，但本轮 T6 的探针实测：`CHILD_TIMEOUT` 场景
> `activationCalls=1`（策略函数返回 true，真实调度却只跑一次）。

### 根因（两处，缺一不可）

1. `src/runtime.ts` 里 900s 上限计时器先置 `guard.timedOut=true`，`catch` 首行
   `if (guard.timedOut) break` 在调用重试策略**之前**就跳出循环；同一计时器
   还 `abort` 了 `child.controller`，于是 `isAbort` 恒真。策略正确，链路不可达。
2. 「重试前的产物核对」在修复前是**同一瞬间读两次**（recorded / current 背靠背），
   生产环境永远不可能不一致 —— 「冲突不覆盖」只在注入假 `stat` 的测试里成立。

### 修复

- 把重试从 `executeSubtask` 内层循环**移到 `runSubtask` 外层**（新增
  `runSubtaskAttempt`），每次尝试拿一个全新的 `child controller`，不再被上一次
  的 `abort` 与 `guard.timedOut` 拦住；最多重试一次（`attemptOffset: 2` 双闸门）。
- 产物指纹改为**上限触发那一刻**取快照，重试前再读一次比对；不一致则跳过重试、
  行上写 `artifactConflict`，绝不覆盖别人刚写的文件。
- 重试前把 `CHILD_TIMEOUT` 作为 `priorFailure` 注入子 Agent 提示词，并附上
  「已在盘上的产物清单，先核对再补缺口」（1.8.19 的 resumeHint 复用）。
- **自动续跑默认开启**：`AUTO_RESUME_DEFAULTS.enabled` 由 `false` 改为 `true`，
  host 侧新增 `autoResumeEnabledFrom()` 三态解析（配置 > 环境变量 > 默认开启），
  `autoResume: false` 或 `DSH_WORKPLAN_AUTO_RESUME=0` 可显式关闭。
  旧实现里 `=0` 也等于「没配」，唯一结果是默认关闭 —— 这就是 1h57m 空窗的开关原因。

### 测试

`npm test` 331 → 332 全绿；新增 `tests/workplan-auto-retry.test.ts`（2 条真实调度
链路用例，含负控制：换回旧代码 → `2 !== 1` 失败）与 `autoResumeEnabledFrom` 的
11 条解析用例。

## 1.10.5 — 2026-11-01

**修复：1.10.4 漏拷 `lib/auto-resume.js`，导致插件整包加载失败（`ERR_MODULE_NOT_FOUND`）。**

> 现象（用户 19:32 重启后的终端）：`dsh: warning: 1 entry did not activate`
> `dsh-workplan-plugin ... failed to import: Cannot find module
> '.../lib/auto-resume.js' imported from '.../lib/runtime.js'` —— 工作台工具在
> 该进程里全部不可用（`unknown tool "dsh_workplan_status"`）。

### 根因

`npm run build` 用的是**写死的文件名列表** `cp dist/plan.js dist/runtime.js … lib/`。
1.10.4 新增 `src/auto-resume.ts` 后，`tsc` 生成了 `dist/auto-resume.js`，但列表没加它，
于是 `lib/runtime.js` 里 `import './auto-resume.js'` 在运行时解析失败。
`tsc` 与单测都发现不了：它们只编译，不按包内相对路径去解析 `lib/`。

### 修复

- `package.json` 的 build 改为 `cp dist/*.js lib/ && cp dist/client.js client.js`——
  以后再加模块不会漏。
- 新增 `tests/build-artifacts.test.ts`（2 例）：**dist 里每个 .js 都必须在 lib 有同名文件**，
  且 `client.js` 与 `dist/client.js` 字节一致。漏拷会让 `npm test` 直接红。
- 重建后 `lib/` 共 8 个 js；用真实 profile 软链 `import('~/.dsh/profiles/web/node_modules/dsh-workplan/lib/host.js')`
  实测 **HOST IMPORT OK**，导出 13 个符号。
- 全量 `npm test`：**329 pass / 0 fail**。

## 1.10.4 — 2026-11-01

**新增：自动续跑（auto-resume）——回合结束后自己再开一轮，直到做完或命中停止码。**

> 背景：用户连问三次「超时的已分配子任务不会自动完美重试吗」「不能全面预防吗」
> 「它不会主动告诉负责人发生了什么、负责人也不能追问吗」。取证结论：插件有
> `dispatch`（4 次额度）、`followup`（无额度、保留子会话上下文）、`turn-stopping`
> 施压三种**人工**入口，唯独没有「回合结束后自己开一轮」的驱动——这是实现缺口
> （T3 定性），严重度 S2（T4，场景 A/B 均已发生，4/4 中止子会话靠人工恢复）。

### 新增

- `src/auto-resume.ts`（新模块，纯函数）：`decideAutoResume()` 判定「是否再开一轮」，
  返回唯一继续码 `SCHEDULED` 或 11 个停止码（DISABLED / NO_PLAN / CANCELLED /
  SUPERSEDED / ALREADY_RUNNING / PLAN_MODE / PHASE_NOT_PAUSED / NOTHING_PENDING /
  HAS_BLOCKED / BUDGET_EXHAUSTED / NO_PROGRESS）；指数退避 `min(300s, 30s·2^n)`。
- `src/runtime.ts`：轮结束钩子记账 + 定时器 + 5 条撤销路径；每轮上限
  `maxAttempts=2`、硬上限 4，与既有 `MAX_PLAN_RESUMES=4`（仅 blocked 修复计费、
  paused 不计）**正交**。定时器 `unref()`，不会阻止进程退出。
- `src/host.ts`：开关默认**关闭**（`autoResume:true` 或 `DSH_WORKPLAN_AUTO_RESUME=1`），
  先灰度再默认开启。
- **D6 修复**：正常完成（全部 done、无 pending/blocked）的轮不再写
  「[auto-resume] 停止（PHASE_NOT_PAUSED）」噪音行。
- **D1 修复**：定时器到点后的五道复核不再裸 `return`，每个分支都写停止码
  （`SCHEDULE_REVOKED_*` / `CANCELLED` / `PHASE_TERMINAL` / `PLAN_MODE` /
  `PHASE_NOT_PAUSED` / `NOTHING_PENDING`），满足 I9 可见性。

### 回归

- 新增 9 条纯函数单测（`tests/auto-resume.test.ts`）＋既有套件：**327 pass / 0 fail**。
- `qa/replay_check.py` 64 项只读断言（含 T12 事故重放）通过；`design/verify_retry_patch.py` 12/12。
- 未验证：定时器跨回合真正拉起子 Agent 需 build + 重启 + 开灰度后实测（需主 Agent）。

## 1.10.3 — 2026-11-01

**修复：单个子任务撞上 900 秒硬上限时，只要整轮预算还够再跑一次，就自动重试。**

> 背景：用户问「超时的已分配子任务不会自动完美重试吗？这不是严重缺陷吗」。
> 核对源码：`shouldRetryAttempt` 对 `CHILD_TIMEOUT` 无条件 `return false`，
> 即使整轮 20 分钟里还剩十几分钟可用也一样——于是「只是这一步慢了」被判成阻塞，
> 必须等主 Agent 人工改判或重新派发。`CHILD_STALLED`（无事件）本来就会自动重试，
> 硬超时反而不重试，口径不一致。

### 修复

- `src/runtime.ts` `shouldRetryAttempt`：`CHILD_TIMEOUT` 改为「剩余预算 >
  max(空闲窗口, 120s) 时自动重试一次」，仍然最多两次尝试（`attempt >= 2` 直接停），
  不会形成重试风暴；重试沿用 1.7.0 的「带上一次失败原因」提示词。
- 「剩余预算不足，未重试」的说明原先显式排除 `CHILD_TIMEOUT`，现已一并覆盖。
- `TOTAL_TIMEOUT`（整轮预算用光）与 `ABORTED`（有人决定停）仍**不自动重试**：
  前者重试必被同一把闸刀砍掉，后者重试等于违背决定。
- `tests/workplan-retry-feedback.test.ts`：新增两条断言（剩余 10 分钟→重试；
  第二次超时→不重试）。全量 **318 pass / 0 fail**。

### 边界（如实）

- 这只解决「单个子任务超时」。**整轮预算耗尽仍是暂停 + 需一次续跑指令**，
  没有做「自动重新派发」——那会在用户不知情时继续消耗时间与 token。
- 若一次超时发生在整轮预算只剩 < 2 分钟，仍会直接判阻塞并写明原因。

## 1.10.2 — 2026-11-01

**补漏：即使调用方显式传 `error`，`done` 结果也一律清空 `error`；并补一条真实渲染 A/B 回归、一道单行一致性门禁。**

> 背景：1.10.1 只在 `patch.error === undefined/null` 时清空，而回放子会话 result 的
> `done+error`、或任何显式传字符串 error 的写入，仍能把「完成 + 失败文本」写进
> 持久化记录（实测写入 `{"status":"done","error":"HOSTILE-1"}` 成立）。读侧自愈能
> 兜住展示，但记录层仍脏。本版把写入口收敛为无条件清空，旧文本先归档 `lastError`。

### 修复

- `src/plan.ts` `applyStatus`：done 分支改为**无条件** `next.error = null`（非空文本先由
  上方逻辑归档进 `lastError/lastErrorAt`），覆盖 `applyStatus` 与 `applyResultStatuses` 两条入口。
- 新增 `tests/status-truth.test.ts` 的「显式 error 的 done 也必须清空」用例。

### 回归

- 新增 `tests/client-done-error-render.test.ts`（4 例）：用**真实 `client.js` 构建产物** +
  最小脏数据夹具渲染，并用 `DSH_WP_CLIENT_BUNDLE` 对 1.9.1 旧 bundle 做 A/B 对照
  ——旧版 3 失败（done 行显示原因、无留档、文本重复）、新版 4/4 通过、pending 对照组两版都过。
- 全量 `npm test`：**318 pass / 0 fail**（1.10.1 为 313）。

### 门禁

- `fix/progress_gate.py` 新增 **GC-08**：任一 `status=done` 的子任务归一后 `error` 非空即阻断
  （不套 100% 前置条件）。自证用例 7→9（V8/V9），对真实 85% 中途快照 `_result_step_76.json`
  命中此前漏检的 T7。

### 已知未修

- `src/client.ts:1112` `plainError` 会把含「未完成」的子任务 summary 整句改写为
  「这件事没有做完。」（首页实测 2 处误报）；属独立缺陷，本版未改。

## 1.10.1 — 2026-11-01

**修复：`done` 行残留 `error`，导致「已完成 13/13（100%）」与「卡住原因：本轮预算用尽」同屏。**

> 背景：用户截图显示 T12 子会话已中止（27 秒、无最终答复），面板侧栏却是
> 13/13 完成。根因不是百分比算错，而是同一个状态行上 `status=done` 与
> `error="本轮预算用尽，等待续跑"` 并存：`applyStatus` 的 done 分支从不清理
> `error`，改判路径又传 `undefined`（被解释为「保留旧值」），而客户端无条件
> 把 `error` 渲染成「卡住原因」。同类缺陷另见 equal-revision 二次回放、
> 分母取 `statuses.length`（写 5 行即可 100%）、`deliveryReady` 下发却无人消费。

### 修复

- `plan.ts` `applyStatus`：`done` 时把旧 `error` 迁入 `lastError` 并清空
  `error`（I12：完成的行没有「卡住原因」）；显式 `error: null` 同样先留档；
  新增 `completedBy / attemptOutcome / attemptEndedAt / priorOutcome`。
- `plan.ts` `normaliseStatusEntry`：读侧迁移历史脏数据（`done+error` →
  `done+lastError`），刷新即干净，不必重写会话日志。
- `plan.ts` `applyResultStatuses`：相等 `revision` 的结果快照不再二次应用
  （此前每次回放把 T1–T7 各抬一级 revision）。
- `plan.ts` `deriveAggregates` / `derivePlanSnapshot`：分母改为计划定义条数
  `N`，缺失行按 pending 计入；`progress` 未全部完成时封顶 99。
- `plan.ts` `aggregateInvariantViolations`：I1 改为「不得小于」并新增
  I12（done 行不得带 error）、I13（进度与计数必须一致）。
- `runtime.ts` `serialisePlan`：下发时传定义条数；计划 `done/cancelled` 时把
  计划级 `errors` 归档为 `archivedErrors`，不再与 100% 同屏。
- `client.ts`：`error` 只对非 done 行渲染（blocked →「卡住原因」，
  其余 →「还没做完的原因」），done 行改为灰色「上一轮的失败记录（仅留档）」；
  新增「还不能交付」横幅，消费此前从未被读取的 `deliveryReady/deliveryBlockers`；
  `100%` 需同时满足加权进度 100（`cappedPercent`）。
- `locale`：新增 `pendingReason / lastErrorNote / notDeliverable / notDeliverableHint`。
- **1.10.1 追加（DF-05，P0）**：`deliveryReadiness` 对账分母——状态明细少于计划定义时
  记为阻塞，修掉「定义 13 项、只写 5 行且全 done ⇒ `ready=true`」的放行漏洞。

### 回归

- 新增 `tests/status-truth.test.ts`（7 例）：done 清 error 并留档、读侧迁移、
  I12、分母对账、I13、回放幂等、全 done 一致性。
- 全量 `npm test`：**313 pass / 0 fail**（1.9.1 为 306）。

## 1.9.1 — 2026-11-01

**新增：`dsh_workplan_followup` —— 用户授权后，向直接子会话补发 follow-up。**

> 背景：事故夜三条子会话（`a0d5b134` / `031225ef` / `7934905a`）被整轮预算与
> 900s 上限中止，末轮 `turn/end = aborted/parent`，DSH 界面据此永远显示
> idle（灰点）；台账侧它们早已是 done/structured。用户 2026-11-01 明确同意
> 「补发 follow-up，让圈注三行真正变绿」——正确做法是让子会话自己再跑完一个
> 正常回合，而不是伪造 turn/end、改投影缓存或手工刷 UI。

### 新增

- `dsh_workplan_followup({ sessionId, message })`：调用官方
  `subagents.sendMessage(agent, childId, [{type:'text',text}], {signal})`，
  把说明投递给父会话 `subagent/catalog` 里登记过的**直接**子会话。
  - 只允许根会话；子 Agent 会话调用返回 `NOT_ROOT`。
  - 未在 catalog 登记的目标返回 `NOT_DIRECT_CHILD`，不做猜测式投递。
  - 空 message / 超过 4000 字符直接拒绝；子会话服务缺失返回
    `NO_SUBAGENT_SERVICE`；投递异常返回 `DELIVERY_FAILED` 并保留原文。
  - 工具只投递：不写计划状态、不触发 present、不改 `lastTurnCompleted`；
    界面是否变绿由子会话自己下一轮的 `turn/end` 决定。
- `src/runtime.ts` 新增 `followupTool`；`src/host.ts` 新增 `createFollowupTool`
  并在插件装配处注册；`tests/workplan-followup-tool.test.ts` 3 条。
- 本提交（followup 单项）`npm test` **277/277**；`npm run check` 无诊断；两次构建
  5 产物 sha256 一致。并入下方四项后的发布态为 **306/306**、7 产物一致。

### 边界

- 本工具不是「把子任务标完成」的捷径：它不会替子会话产出交付物，也不能
  绕过 `present`/`deliveryReady` 闸门；投递后仍需核对子会话自己的回合结果。
- 目标必须是直接子会话；孙会话、同标签的其他历史会话都不在允许范围。

### 一并发布：1.9.0 遗留的四项（superseded 写侧 / P1 拒绝码 / W1 digest / W5 联测）

> 背景：1.9.0 的「已知残余（下一批）」把四项留到下一批。本版把四项落地后与
> 1.9.1 合并为**同一个制品**发布：npm 上此前最新是 1.8.18，`1.9.0` 与 `1.9.1`
> 都从未发布到 npm，本地 `v1.9.1` 标签也从未 push（`git ls-remote --tags` 无
> `v1.9` 条目），因此 1.9.1 是用户第一个同时拿到 1.9.0、1.9.1 与四项修复的版本；
> 发布前该标签重挂到并入四项后的发布提交，标签与 npm 制品指向同一棵树。

#### superseded 写侧：唯一写入入口

- `src/supersede.ts`（新增）：`supersedePlanRecord()` 是 `superseded` 的**唯一**
  写路径。写入顺序固定为「V1–V8 全量核验 → 运行时复算 `coverage`/`digest` →
  `buildCancelMessage(..., { disposition:'superseded' })` 写 durable 记录 →
  append 成功后内存记录才翻成 `phase='superseded'`」；任何一步失败都返回
  `ok:false` + 失败码，**不改内存、不写日志**（消除「UI 说被取代、重启后说未完成」
  的 live/replay 分叉）。
- `dsh_workplan_cancel` 新增可选参数 `disposition: 'cancelled' | 'superseded'`
  （缺省仍是 `cancelled`，旧调用行为不变）与 `supersededBy { planId, mapping[] }`；
  `mapping` 每条含 `from`/`to`/`basis`/`evidence`，只表达映射意图，
  `requiredCount`/`coveredCount`/`coverage`/`digest` 一律由运行时复算，不接受自报。
- 失败码（对外契约，按字面值断言）：`SUPERSEDE_TARGET_UNKNOWN`、
  `SUPERSEDE_ORDER_INVALID`、`SUPERSEDE_SOURCE_NOT_CANCELLED`、
  `SUPERSEDE_SOURCE_DONE`、`SUPERSEDE_SOURCE_EMPTY`、
  `SUPERSEDE_MAPPING_INCOMPLETE`、`SUPERSEDE_TARGET_ITEM_UNKNOWN`、
  `SUPERSEDE_EVIDENCE_GAP`、`SUPERSEDE_TARGET_TERMINAL`、
  `SUPERSEDE_NOT_CONFIRMED`、`SUPERSEDE_WRITE_FAILED`。
- 运行时侧：`superseded` 与 `cancelled` 终态互斥；自动覆盖路径**只允许**写
  `cancelled`，永不写 `superseded`；被取代的计划不允许被普通取消静默改回
  `cancelled`。
- 语义边界：运行时只验承接计划那一侧的机器事实（存在、时序、状态、结构化证据、
  验收、产物）；「两项工作在语义上等价」是人的判断，只能由用户确认承载（V8：一条
  同时包含两个 planId 且含「确认/同意/可以/按此执行」之一的用户消息）。

#### P1 拒绝码统一（`EVIDENCE_GAP`）

- `src/plan.ts` 新增 `PRESENT_DENY_CODES` 与 `activeDenyCode()`：`remaining` 为空
  且 `blockers` 非空 ⇒ `EVIDENCE_GAP`，其余 ⇒ `ACTIVE_NOT_READY`。`present` 的
  两个未完成分支（全部 done 但证据缺口 / 仍有子任务未完成）共用同一个码值来源，
  不再各写一份判断；拒绝文案逐字保持不变，码值对外可断言。
- 门禁扫描：`EVIDENCE_GAP` 的散落字符串 **0 处**，拒绝点只引用常量或
  `activeDenyCode()`。

#### W1 digest：覆盖映射摘要

- `src/supersede-digest.ts`（新增）：`canonicalMappingJson()` 固定规范化口径
  （对象键按 Unicode 码位升序、分隔符 `,`/`:` 无空白、非 ASCII 不转义、数组保持
  存储顺序）；`computeMappingDigest()` 输出 `sha256:<64 位小写十六进制>`；
  `verifyMappingDigest()` 仅在「mapping 是数组 + digest 形如 `sha256:<64hex>` +
  重算值逐字符相等」时返回 true，其余一律 false（fail-closed，调用方据此判定 stale）。
- 写入方先落盘 digest 再写信封；读取方（replay / present 复验）只重算，不信任
  缓存数值。

#### W5：真实取消信封联测

- `tests/workplan-w5-cancel-e2e.test.ts`（新增 5 例）：不使用桩件，直接走真实的
  `buildCancelMessage` 信封 → durable 记录 → replay 读回，覆盖 `cancelled` 与
  `superseded` 两种处置的写入/读回链路与终态互斥。

#### 测试与门禁

- 四项定向共 **29 例**：`tests/workplan-supersede.test.ts` 9、
  `tests/present-deny-code.test.ts` 10、`tests/supersede-digest.test.ts` 5、
  `tests/workplan-w5-cancel-e2e.test.ts` 5；`tests/workplan-host.test.ts` 的
  工具参数集合断言随写侧收敛更新（1 例替换）。
- 全量 `npm test` **306/306**（1.9.0 基线 277，净增 29）；`npm run check` 无诊断；
  两次构建 7 个产物字节一致；`npm pack --dry-run` 产物含 `lib/supersede.js`、
  `lib/supersede-digest.js` 与对应 `src/*.ts`。

## 1.9.0 — 2026-11-01

**修复：终态计划不再无限挡门；取消/被取代与「本回合点名」解耦；present 只硬拦本回合点名的终态计划。**

> 背景：`wp-bea31753` 被取消（0/8）后，`present` 仍把它当作「最后可判定计划」
> 硬拦；同一计划 `dispatch` 又返回 `PLAN_CANCELLED`，形成「不能交付、不能派发、
> 收尾 steer 还说两件都不能做」的双向死锁（日志 seq 7167 → 7174 → 7175）。
> 更早的 T5-C 语义把「已取消」等同「不可交付」，但 1.8.16 的全会话并集又把
> 取消计划排除在未完成集合之外——两处判断互相矛盾，正是死锁来源。

### 修复

- `src/plan.ts` 新增 `TERMINAL_PHASES` / `isTerminalPhase`：`cancelled` 与
  `superseded` 统一为终态，`reconcilePhase` 不再把终态改回 `active`。
- `src/runtime.ts`：
  - `present` 的候选集合排除终态计划；终态计划只在「本回合结构化点名」时判定
    （D2 硬拦不放宽），不再自动写回 live、不再永久挡门（D1）。
  - 已取消计划被点名时文案逐字保留「已取消 + 完成 N/M + 不得调用 present」。
  - 新增只读 `superseded` 判定：`supersededBy.successorPlanId` 缺失/终止/未就绪
    ⇒ `SUPERSEDED_STALE`；承接计划就绪才放行。**写入路径（V1–V8 核验、覆盖映射、
    用户确认）不在本版**，`dsh_workplan_cancel` 仍只写 `cancelled`。
  - `dispatch` 对 `superseded` 返回 `PLAN_SUPERSEDED`；`cancelled` 返回体逐字保留。
  - `stopGateApplies`：终态计划不再自动触发收尾 steer（点名 `cancelled` 仍提醒一次）。
- 由 T10 产出的补丁按 `git apply` 应用：3 文件 +120/−12；`tsc --noEmit` 通过；
  更新 `tests/present-gate-evidence.test.ts` 的 A6/A8、`tests/delivery-gate.test.ts`
  与 `tests/workplan-turn-stop-gate.test.ts` 中「取消一律拒绝」的旧断言为
  「非点名放行 / 点名硬拦」；全量 **274/274**。
- 已知残余（下一批）：`superseded` 写入路径、P1 `EVIDENCE_GAP` 拒绝码统一、
  W1 digest 规范化、W5 replay 与真实取消信封联测、A6/A8 之外的全量回归。

## 1.8.19 — 2026-10-31

**修复：子任务超时/整轮预算中止时，不再抹掉已落盘的产物与运行痕迹。**

> 背景（2026-10-31 缺口补齐轮）：T11、T12 在 23:23:38 被 900 秒硬上限强制结束，
> 但它们的交付物在 23:22–23:23 已经落盘（T11 32,996 字节报告 + 140 行索引；
> T12 51,547 字节报告），父会话只看到「达到执行上限」，产物存在与否完全不进
> 状态；T10 在 23:07:25 被 20 分钟整轮预算中止，重置为 pending 时按设计清空
> `childId/startedAt`，卡片显示「从未开始」，用户只能问「T10 为什么自己停止」。
> 这两条路径都不探测盘上产物，重跑一次就是 15 分钟的重复劳动。

### 修复

- `src/runtime.ts` 新增 `findSubtaskById`、`timeoutBlockedPatch`、`budgetResetError`：
  - 硬超时的 `blocked` 补丁现在会探测该子任务声明的 `outputs`，把已在盘上的
    文件写进 `error`（「该步声明的产物已在盘上：…（先核对，不要当作从未运行）」）
    与 `artifacts/missingArtifacts`；判定仍是 `blocked`，不自动重试。
  - 整轮预算重置的 `error` 保留上一轮 `childId`（前 8 位）、运行时长与已落盘
    产物，例如「本轮预算用尽，等待续跑；上一轮子会话 a0d5b134；运行 526s；
    声明产物已在盘上：…」；仍按设计重置为 `pending` 并可续跑。
- `src/plan.ts` 的 `buildChildPrompt` 增加 `resumeHint`：上一轮被中止且状态里
  有 `artifacts[].exists=true` 时，下一次尝试的提示词先列出这些文件，要求
  read/grep 核对、已覆盖验收的部分保持原样、只补缺失部分。
- `src/host.ts` 的 `PROMPT_SECTION` 增加第 7 条：超时/预算中止不等于「什么都没
  做」，主 Agent 必须先核对盘上产物；覆盖验收标准的用 `dsh_workplan_update`
  改判，禁止无视产物整步重跑。
- 新增 `tests/timeout-artifact-evidence.test.ts` 4 条（超时产物入 error/artifacts、
  无产物不编造、预算重置保留子会话与时长、提示词续跑段），全量 **274/274**。

## 1.8.18 — 2026-10-31

**修复：`present` 对空计划与「取消后重启」两条边界的判定，并补上已交付文件的写保护。**

> 背景：1.8.16 的 `present` 闸门已按计划逐个检查，但 T5/T7 的边界复验发现两处
> 判定偏差：一个空计划（`stages: []`，只可能来自畸形历史消息）永远到不了
> `ready`，`present` 会拿「0 个子任务虽都已 done」这种错文案永久拒绝；反过来，
> 取消一个未完成计划再重启宿主，回放时既没有 live record 也没有本回合计划，
> 闸门会放行——这和取消工具自己的契约「取消后如仍有未完成项或证据缺口，
> present 仍会被拒绝」直接矛盾。另有一处交付完整性缺口：`present` 不复制文件，
> `write`/`edit` 也不校验路径，事故的迟到回合就在卡片发出后原地改写了同一份
> 报告。

### 修复

- `src/runtime.ts` 新增 `definedSubtaskCount(plan)`：闸门按「计划定义了几个子任务」
  判断是不是交付对象。空计划不再进入禁止清单（消除 U6 假拒绝），但畸形计划
  （`flattenSubtasks` 抛错）仍按「不可判断」失败关闭。
- `presentDenialReason` 的候选集增加 `lastGateablePlanRecord(session)`：重启后
  live record 与本回合计划都不存在时，回退到最近一个「定义了工作」的计划；
  被取消但未完成的计划因此仍拒绝 `present`。较新的已就绪计划不受历史取消项
  阻塞；空计划不能拿来当挡箭牌（A8）。
- 新增写保护：`present` 时把「当时已定义的计划 id + 交付路径」钉进会话事件快照；
  新的 `fileWriteGuardReason`（`src/host.ts`，注册在 `ctx.tools.guard`）在根会话
  对同一路径的 `write`/`edit`/`str_replace_editor` 请求上检查，只要这些计划仍未
  通过交付就绪检查就拒绝，并给出续跑 / 取消 / 重新 present 三个出口。`present`
  之后才定义的新计划不在快照里，所以「用户要求改版 → 新计划」不会被卡死；
  plan 模式、子会话、其它路径一律放行。
- 两条 guard 是并列的单调拒绝（`tools.guard` 的 `guardReason` 逐条求值，取第一个
  非空原因），互不覆盖。

### 测试

- `tests/present-gate-evidence.test.ts`：A1–A8（未完成必拒、全 done 无证据必拒、
  空计划放行、plan 模式防死锁、按定义而非状态过滤、取消后重启仍拒、旧计划取消
  不阻塞新计划、空计划挡箭牌无效）。
- `tests/workplan-presented-write-guard.test.ts`：7 条（拒绝与出口、相对/绝对路径
  归一、present 后新计划放行、就绪放行、取消放行、非根会话/plan 模式放行、
  只接管三个写工具）。
- 全量 `npm test` = 270 pass / 0 fail；`npm run check` 无诊断；两次构建的 5 个
  产物 sha256 一致。

## 1.8.17 — 2026-10-31

**修复：回放出来的记录缺少 `errors` 字段，预算到点清理子任务时整轮崩掉，剩余子任务被连带判为受阻。**

> 背景：17:51:37 对 `wp-40ce5eee` 的派发在 20 分钟预算边界中止。宿主刚重启，
> 内存里没有记录，`dispatchTool` 用 `reconstructFromSession` 从会话日志重建；
> 重建出的记录带着 `plan/statuses/phase/…`，唯独没有 `errors`。预算中止时
> `disposeActivation` 往 `record.errors` 里追一条清理失败信息，展开
> `[...record.errors]` 抛出 `TypeError: record.errors is not iterable`，
> 异常冒到本轮调度器，把还没跑的 T5–T10 一并标成受阻（6 项），其中三项
> 其实已经开始执行。这不是子 Agent 的失败，而是记录形状不一致导致的假受阻。

### 修复

- `reconstructFromSession` 的每个快照新增 `errors: string[]`：回放结果消息时
  把 durable 的失败行并入（`result.errors`，保留最近 20 条），返回的记录始终
  带 `errors` 数组；`ReplaySnapshot` 接口同步。
- 所有 `[...record.errors, …]` 展开点补 `?? []` 守卫（dispose 失败、子任务
  重试说明、剩余预算不足、子任务超时、超时状态写入失败、预算收尾、子任务
  错误记录），重建记录与内存记录的字段形状就此对齐。
- 测试：新增 `tests/workplan-replay-errors.test.ts` 2 条——回放记录始终有
  `errors` 数组并保留 durable 失败行；回放记录再派发时子任务失败只记错，
  不再抛错炸掉整轮。

验证：`npm run check` 无诊断；`npm test` 255/255；`npm run build` 前后
5 个产物 sha256 一致。

## 1.8.16 — 2026-10-31

**修复：`present` 闸门检查会话里所有未完成的计划，不再只看「本回合/最后定义」的那一个。**

> 背景：1.8.15 的活体 E2E 直接暴露了缺口——本会话里 `wp-6753e19f` 停在
> 13/14，而最后定义的计划已就绪，`present` 仍然把根因报告交付成功。1.8.15
> 只把「按本回合消息点名」接进闸门，但一个会话可以同时存在多个计划（这次
> 事故会话前后有四个），只判其中一个就等于没判。

### 修复

- `present` 闸门新增 `sessionPlanRecords()`：从会话日志里收集所有定义过的
  `planId`，逐个按显式 planId 重建（各自带回扫窗口），再逐个做
  `deliveryReadiness` 检查。
- 有多个未就绪计划时，拒绝文案逐条列出「计划 / 完成数 / 剩余项 / 证据缺口」，
  并说明先 `dispatch` 续跑、用 `update` 补证据；全部就绪前不得 `present`。
- **取消不是绕过交付闸门的逃生口**：取消只停止执行，不改变「未完成」的结论；
  对已取消且未就绪、又恰好是本回合/当前记录所指的计划，仍然拒绝 `present`
  （T5-C 语义保持不变）。已取消的计划不会被当成交付阻塞项长期卡住其他计划。
- 测试：新增「会话里还有未完成计划时 present 不得放行，即使最后定义的计划
  已就绪」，并断言取消之后仍拒绝。

验证：`npm run check` 无诊断；`npm test` 253/253；`npm run build` 前后产物
sha256 一致。

## 1.8.15 — 2026-10-31

**修复：取消成为真正的终态；长会话默认回放不再丢掉计划；`present` 按本回合的计划判定；构建指纹覆盖 `watchdog.js`。**

> 背景：对 1.8.13 / 1.8.14 字节的独立复核（T4e、T5c、T3 三份报告）实测出
> 四类缺陷：取消之后 `dispatch` 仍会真的启动部门 Agent；派发途中第二次取消
> 会再写一条取消消息；已取消回合的结果消息仍教模型「继续派发」；超过 2000
> 事件的会话里默认回放返回 null，`present` 因看不到计划而静默放行。另外
> `buildHash` 未覆盖 `lib/watchdog.js`，`/dsh-workplan/plans` 载荷没有版本
> 身份，UI 无法判断进程加载的是不是旧构建。

### 修复

- **取消是终态**：`dispatch` 遇到 `phase: 'cancelled'` 的计划直接返回
  `ok: false / code: 'PLAN_CANCELLED'`，不启动任何部门 Agent；已取消回合的
  结果摘要与正文改成「已取消……不得交付，也不要再次派发」，不再教模型
  「再次调用 dispatch 即可继续跑」。
- **取消幂等覆盖派发途中**：派发进行中收到取消时记录 `abortRequested`，
  第二次取消返回 `alreadyCancelled: true`，durable 取消消息只写一条。
- **长会话默认回放**：窗口起点会向前回扫到最后定义的计划消息，避免
  `reconstructFromSession` 在长会话里返回 null 而让交付闸门静默失效。
- **`present` 按本回合的计划判定**：新增 `currentTurnOf`，`present` 闸门优先
  用本回合消息里点名的 `planId` 重建；默认回放保持「最后定义的计划」契约，
  因为同一个默认答案也喂给 `dispatch`，改成「最后活动」会让旧计划截获新任务
  的默认派发目标。
- **构建指纹**：`buildHash` 的哈希文件加入 `lib/watchdog.js`。
- **UI 身份**：`/dsh-workplan/plans` 载荷返回 `version` 与 `runtime`
  （pid / startedAt / entryPath / buildHash）。
- **测试**：新增 `tests/workplan-1815-guards.test.ts` 6 条；订正 1.8.14 发布
  说明里与实现不符的 N5 描述。

验证：`npm run check` 无诊断；`npm test` 252/252；`npm run build` 前后 5 个
产物 sha256 一致；`git diff --exit-code -- lib client.js` 为空。

## 1.8.14 — 2026-10-31

**修复：事故报告 §12.6 表 A 里仍然开放的运行态/持久化缺口（N1、N5、N8、N12、N13），并让「重启后到底加载了哪份构建」可以自证。**

> 背景：1.8.13 把「完成」收敛成一个谓词，但重启复验仍然只能靠
> `ps`/`lsof`/文件 mtime 推断进程加载了什么；同时回放、取消、结果写入
> 三个持久化边界仍有可复现缺口。本轮按「运行态自证 → 持久化一致性 →
> 可观测性」的顺序修，全部以测试钉住。

### 修复

- **N1 运行态自证**：`dsh_workplan_status`（以及 `dispatch`）新增 `runtime`
  字段：`version / pid / startedAt / uptimeMs / entryPath / buildHash`。
  宿主在激活时对实际加载的 `host.js + runtime.js + plan.js` 做 sha256
  （取前 16 位），因此同一版本号重新构建、或 profile 重组后内存里仍是旧模块，
  都会被指纹区分出来；`startedAt` 由 `process.uptime()` 推导，是真实进程
  启动时间，不是插件构造时间。
- **无计划时也回答身份**：`status` 的 `NO_PLAN` 分支过去只有错误文案，导致
  报告 §14.6 第 2 步（新会话里调 `status` 确认版本）无法执行。现在该分支同样
  返回 `version` 与 `runtime`，渲染行也显示 `v…｜build …｜pid …｜启动 …`。
- **N5 收尾闸门按本回合结算消息认计划**：`onTurnStopping` 先用本回合 durable
  消息里点名的 `planId` 重建，再退回收尾检查。默认回放**仍保持「最后定义的
  计划」契约**——它同时是 `dispatch` 的默认目标，改成「最后活动」会让旧计划
  截获新任务的派发目标。1.8.14 发布说明初稿曾写成「默认回放改最后活动」，
  与实现不符，已在 1.8.15 更正。
- **N8 取消幂等**：第二次取消不再追加第二条取消消息，而是返回
  `alreadyCancelled: true`；已取消状态在回放里由 cancel 消息**或**
  结果消息的 `phase: 'cancelled'` 任一方确认。
- **派发途中取消持久化**：1.8.13 在中止分支直接 `return`，不写任何 durable
  消息；若随后结果消息写入失败，重启会把计划当成仍在执行。现在中止分支也写
  取消消息，并在返回值里报告 `cancelRecorded`。
- **N12 取消写入失败可报告**：取消消息的 `session.append` 加了 `try/catch`，
  失败进入 `record.errors` 并返回 `cancelRecorded: false`，不再抛出后留下
  「UI 已取消、日志没有」的分裂状态。
- **N13 结果写入失败可报告**：结果消息 `append` 失败时除宿主日志外，
  同时 `pushRecordError`，`status.errors` 与 UI 都能看到本轮结果未落盘。
- **取消途中的回放**：结果消息 `phase: 'cancelled'` 现在会让回放快照进入
  已取消，不再依赖是否存在 cancel 消息。

### 测试

- 新增 6 条回归：默认回放跟随最后活动计划；途中取消（结果 phase）回放仍取消；
  连续两次取消只写一条消息；中止分支写 durable 取消；取消写失败报告
  `cancelRecorded:false`；结果写失败进入 `errors`；无计划时 `status` 返回
  版本与构建指纹。
- `npm run check` 无诊断；`npm test` 全绿（见发布记录）。

## 1.8.13 — 2026-10-31

**修复：四套「完成」判定各自为政——全 done 无证据仍可交付、取消后仍可 present、补证无法持久化。**

> 背景：1.8.9 声称修好「按 planId 分账 / 结算回合识别 / present 证据闸门」，
> 但重启后的行为探针（T5、T6、T6b）证明仍有四个可复现缺口：
> B（全 done 但 legacy/空 acceptance/缺产物只拦一部分）、C（取消 1/3 后
> `planIncomplete` 直接 false，present 放行）、D（结构化结果 acceptance 为空
> 仍被判 structured）、A1（预算重置清空 `childId` 后结算回合不被武装）。
> 根因不是某条分支写错，而是「计划完成」「证据通过」「可以交付」三个事实
> 没有单一事实源：结果消息、回合闸门、present、dispatch 快照各算各的。

### 修复

- 新增唯一的 `deliveryReadiness(plan snapshot, { phase })`（`src/plan.ts`）：
  每个子任务必须 `status=done`、`verification=structured`、`acceptance` 非空
  且每项 `result=pass`、无 `missingArtifacts`、无 `artifacts[].exists=false`；
  未完成项进入 `remaining`，其余进入可命名的 `blockers`。
  `ready = total > 0 && remaining 为空 && blockers 为空`。
- 取消不再豁免：`cancelled` 仍有未完成项时，`blockers` 头部写明
  「计划已取消但只完成 X/Y：取消只停止执行，不等于完成」。
- `adjudicateResult`：空 `acceptance` 从 `structured` 降级为 `unverified`
  （没有验收项不等于验收通过，T5-D 根因）。
- 四处判定统一改用 `deliveryReadiness`：
  - 结果消息：全部 done 但证据未通过时，第 3 条改为
    「【证据未通过，禁止交付】」，第 4 条给出补证/改 blocked 的出路；
    未完成时仍为「【未完成，禁止交付】」；
  - 回合收尾闸门：不再只看 pending/in_progress，取消、全 blocked、
    证据缺口都会注入 steer；取消/受阻分支明确要求「不要 dispatch、
    不要 present、按未完成口径收尾」；
  - `present` 工具闸门：`ready` 才放行；拒绝文案不再把 cancel 写成交付许可；
  - `dispatch` 快照 / `status` 工具：新增 `deliveryReady`、
    `deliveryBlockers`、`deliveryRemaining` 与插件 `version`，模型与 UI
    看到的是同一个结论。
- `dsh_workplan_update` 新增 `verification`、`acceptance`、`artifacts`、
  `missingArtifacts` 参数；这些字段写入 `workplan-update` 消息并进入回放，
  人工补证后刷新/重启仍然生效（此前只接字符串 evidence，且不落盘）。
- 提示词第 5 条改为「全部 done **且** deliveryReady=true」；明确
  「用户取消 ≠ 完成」；取消文案、dispatch render、status render 同步。
- 顺带修复：`present` 取消分支的重复句；`modelStatusLines` 补充
  `acceptance` 摘要，主 Agent 能看到每项验收的 criterion/result。

### 验证

- `npm run check` 无诊断；`npm test`：**238 tests / 238 pass / 0 fail**
  （1.8.12 基线 233，新增 5 条：`tests/delivery-gate.test.ts` 4 条 +
  证据契约新增「空 acceptance→unverified」1 条；相对 1.8.8 的 220 条累计 +18）。
- 行为探针 `docs/rca-99984ebd-20261031/probes/T6b-delivery-gate-probes.mjs`
  在构建产物上逐项复现：B0–B5 全部拒绝；C0/C1 拒绝；D0=
  `done/unverified`；G0/G1 放行；S0/S1/S2 各 steer 1 次、S3 steer 0；
  U0 补证后 `deliveryReady` 由 false 变 true 且回放仍为 true；
  V0 `status` 返回 `version` 与 `deliveryReady`。
- **运行进程仍是 1.8.9（PID 16366），必须重启 `dsh web` 后上述行为才会
  在真实会话中生效**；重启后用
  `node docs/rca-99984ebd-20261031/probes/T6b-delivery-gate-probes.mjs`
  与 `dsh_workplan_status` 的 `version` 字段复核。

## 1.8.12 — 2026-10-31

**修复：部门子 Agent 首轮「处理失败」——提示词里的 `包名:行号` 被 Harness 当成跨会话引用。**

> 现象：同一轮派出的 4 个子会话（`0d55b72d`、`37e6b366`、`5964c07d`、`538a8fef`）
> 都在 `turn 1` 的 37ms 内结束，`turn/end` 的 reason 是
> `invalid session reference URI "dsh-session:1980"`，没有任何模型步。
> 对用户来说，这就是「处理失败」，且主 Agent 侧只看到子任务立刻结束。
>
> 成因：Harness 的 `@deepseek-ai/dsh-session-reference` 在 `agent/pre-step`
> 扫描每条 `source.kind === 'user'` 消息的文本块，裸的
> `dsh-session:<payload>` 会被当作引用候选去 base64url 解码 + `JSON.parse`；
> `1980` 解出的字节不是合法 UTF-8 JSON，抛 `SessionReferenceError`，整个
> turn 在第一次模型调用之前中止。该文本来自前一个子任务的完成摘要——它在
> 报告里把 `ctx.sessions.get()` 的源码位置写成 `dsh-session:1980`——再经
> 「兄弟部门进展」进入后续子任务的提示词。子 Agent 的首条消息正是
> `source.kind === 'user'`，于是必炸。

### 修复

- `buildChildPrompt` 的唯一出口统一调用新增的
  `defuseSessionReferenceText()`：无法规范化的裸 token 转义成
  `dsh-session\:<payload>`（文字与行号保留，只是不再命中引用正则）；
  规范 URI（真正的跨会话引用）原样保留；显式 Markdown 引用
  `@[label](dsh-session:…)` 的语义不变，仍由 Harness 严格校验。
- 消毒覆盖整段提示词：全局任务、对话背景、依赖结果、兄弟部门摘要、
  失败重试说明；任一处出现 citation 都不会再让子任务在首轮死亡。
- 新增 `isCanonicalSessionUri()`，规范化判断与 Harness 的
  `encodeSessionReferenceUri` 逐字节一致。

### 验证

- `npm run check` 无诊断。
- `npm test`：233 tests / 233 pass / 0 fail（新增 5 条：转义与正则不命中、
  规范 URI 保留、幂等、背景消毒、原始请求/依赖结果消毒）。
- 用事故原始提示词（23,098 字符，`/tmp/t9_prompt.txt`）回放打补丁后的
  Harness 解析器：不再抛错、`references` 为 0、文本未变。
- 附带的 Harness 本地热修复（见
  `docs/rca-99984ebd-20261031/harness-hotfix/`）在模块级验证 5/5 通过；
  **需要重启 DSH 进程后才能生效**，升级 Harness 后要重跑 apply 脚本。

## 1.8.11 — 2026-10-31

**修复两处在真实生命周期下仍会漏拦的缺陷：结算回合的谱系认亲、人工改判的重复回放。**

> 背景：1.8.10 的重启后核验（wp-91b6a96b）用真实字节与真实日志做了 8 项探针，
> 其中两项证明 1.8.7–1.8.10 的闸门仍有漏洞：
>
> 1. `subagent-settled` 到达父会话时，子会话已经被
>    `dsh-subagent` 的 `finishDisposal` dispose 掉（dispose 在 notifySettlement
>    之前），`ctx.sessions.get(senderId)` 恒为 undefined，1.8.9 的
>    `isChildSessionOf` 在真实生命周期下从未成立过——事故 turn 2 的路径仍然
>    可以绕过关卡。
> 2. 一次 `dsh_workplan_update` 会在会话里留下 durable `workplan-update` 消息
>    与配对的 `tool/result` 两份记录；回放两份都应用，第二次以 `system` 身份
>    把 revision 再抬一级并覆盖 summary，人工改判的作者与证据后缀丢失。

### 修复

- `turnCarriesPlanWork` 的 `subagent-settled` 认亲新增第三来源：父会话自己的
  `subagent/catalog` 事件（spawn 时追加，重启、回放、预算重置都不会改写）。
  判定顺序仍是 childId → live 会话谱系 → spawn 记录；三处都不命中才放行，
  无关后台任务不会误激活闸门。扫描结果按 `session.seq` 缓存。
- `reconstructFromSession` 记录每条 durable `workplan-update` 的 seq 与状态；
  配对的 `tool/result` 若在它之后且状态相同，则不再重复 `applyStatus`。
  durable 消息缺席时，`tool/result` 仍独立生效（保持 1.6.0 的容错语义）。

### 验证

- `npm run check` 无诊断。
- `npm test`：228 tests / 228 pass / 0 fail（新增 3 条：dispose 后按 spawn 记录
  认亲、三处都无记录不激活、人工改判只写一次）。
- 真实生命周期探针（T7）报告在 1.8.9 上 A1a 为 steered:0；「dispose 在
  notifySettlement 之前」的顺序已由我独立复读 `dsh-subagent/lib/index.js`
  确认（`:2026` dispose → `:2040` notify）。本版的对应语义由新增用例覆盖：
  父会话事件里只剩 catalog 记录、live 会话为空时，闸门仍 steer 一次。

## 1.8.10 — 2026-10-31

**修复：长会话的回放窗口越过 plan 消息，旧计划无法按 planId 重建。**

> 背景：1.8.9 上线重启后，`dsh_workplan_status({planId: "wp-6753e19f…"})`
> 仍然返回最新生成的计划。原因是回放窗口固定为最近 2000 个事件，而本会话
> 已有 2256 个事件，`wp-6753e19f` 的 plan 消息在 seq 22，早已落在窗口之外；
> 按 planId 重建得到 `null`，`status` 与 `dispatch` 一起退回内存里的新计划。

### 修复

- `reconstructFromSession(session, targetPlanId)` 在窗口内找不到目标计划时，
  从窗口起点向前扫描，直到找到该计划的 plan 消息，再把回放起点前移到那里。
  只有显式指定 planId 才会触发这段扫描，默认回放行为不变。
- 真实日志验证：同一份 2256 事件的会话日志重放 `wp-6753e19f` 得到 13/14
  （T1–T4、T6–T14 done，仅 T5 blocked），与重启前一致。

### 验证

- `npm run check` 无诊断。
- `npm test` → **224 tests / 224 pass / 0 fail**（1.8.9 基线 223，新增 1 条：
  窗口外的旧计划仍可按 planId 重建）。

### 残余

- 不指定 planId 的默认回放仍只保证最新计划可用；同一会话里并存多个计划时，
  卡片默认展示最新那个。要续跑旧计划必须显式传 `planId`。

## 1.8.9 — 2026-10-31

**修复：重启后计划进度回退，以及结算回合认亲与 `present` 的证据闸门。**

> 背景：1.8.8 上线后重启 Web 服务，`wp-6753e19f` 从 13/14 退回 5/14。
> 排查发现回放只保留“最后一个计划”的状态：会话里出现第二个计划后，前一个
> 计划迟到的 result 与 update 全部被丢弃。同时 T5 审计指出两条剩余绕过路径，
> 一并修复。

### 修复

- **回放按 planId 分账**：旧 `reconstructFromSession` 只有一组 `plan/statuses`。
  当“继续”被误判生成第二个计划（事故里是 `wp-dd26f206`），前一个计划被压进
  冻结快照，后续 `result.planId` / `update.planId` 不匹配而被丢弃，重启后永远
  回到冻结时的 5/14。现在每个计划独立快照，按载荷里的 `planId` 路由；
  显式传入 `targetPlanId` 时优先返回该计划。真实会话日志重放已从 5/14 恢复为
  13/14，与重启前一致。
- **结算回合按会话谱系认亲**：预算暂停会把未完成项重置为 `pending`，而
  `normaliseStatusEntry` 对 `pending` 强制 `childId: null`（不变量 I6 不允许
  `pending` 携带 `childId`），事故里的 T11 因此从 `planChildIds` 消失，turn 2
  仍能绕过收尾闸门。新增 `isChildSessionOf()`：`subagent-settled` 的发送者
  只要 `header.parentSession` 指向当前会话，就仍视为本计划的子会话。
- **`present` 的证据硬缺口**：计划全部 `done` 但存在自检失败
  （`verification === 'failed'`）、验收项失败（`acceptance[].result === 'fail'`）
  或缺失声明产物（`missingArtifacts` 非空）时，`present` 在工具执行前被拒绝，
  并提示先用 `dsh_workplan_update` 复核补证，或把对应子任务改回 `blocked`。
  `legacy`／无结构化证据的软缺口不在此层拦截：拦死会让所有旧计划永久不可
  交付、只剩 `cancel` 一条逃生路，反而制造新的死锁；软缺口仍由提示词与结果
  消息约束。

### 验证

- `npm run check` 无诊断。
- `npm test` → **223 tests / 223 pass / 0 fail**（1.8.8 基线 220，新增 3 条：
  第二个计划不得冻结前一个计划的 result/update、`childId` 被清空后结算回合
  仍被拦截、全 `done` 但有证据硬缺口时 `present` 仍被拒绝）。
- 用 1657 事件的真实会话日志重放 `wp-6753e19f`：13 个 `done`（T1–T4、T6–T14），
  仅 T5 `blocked`。

### 残余

- 取消计划后 `planIncomplete` 为 `false`，`present` 会放行。当前语义是
  “取消即表示剩余产物只能作为中间结果交付”，拒绝文案也要求先取消再在正文
  说明；是否要在取消后仍禁止 `present` 属于产品决策，本轮未改。
- `payload.status === 'done'` 但 `acceptance` 为空时仍按结构化证据接收，
  只能靠自检失败拦住明确错误的证据。

## 1.8.8 — 2026-10-31

**补丁：把 1.8.7 的收尾闸门补到「结算唤醒的回合」与 `present` 工具层。**

> 背景：审计计划 `wp-6753e19f` 的 T7 在复核事故 turn 2 时发现，1.8.7 仍有两个
> 绕过路径，而这两条正是事故第二个回合的真实路径：它在 11/13 收尾，却由
> `subagent-settled` 消息唤醒，既没有人工任务标记，也没被 `present` 层拦住。

### 修复

- **H9 结算唤醒的回合绕过闸门**：`humanMessages()` 只认人类 `user` 消息，
  由子 Agent 结算通知（`subagent-settled`）或 workplan 结果消息唤醒的回合不会
  写 `activeTurns`，`onTurnStopping` 首行直接放行。新增
  `turnCarriesPlanWork()`：从 `session.seq - 1` 回扫本回合事件，识别
  `subagent-settled` / `workplan-result` / `workplan-continue` 三类来源；
  对 `subagent-settled` 还要求 `senderSessionId` 属于本计划的子会话，
  无关子 Agent 的结算不会误激活闸门。
- **H10 `present` 没有工具级闸门**：1.8.7 只把「未完成不得交付」写进
  `PROMPT_SECTION`，模型仍可在回合中途 `present`。新增
  `presentDenialReason()` 并接入 `ctx.tools.guard`：根会话的计划未完成时，
  `present` 在执行前被拒绝，拒绝文案列出剩余项，并给出两条出路——
  先 `dsh_workplan_dispatch` 续跑，或确认无法继续时先 `dsh_workplan_cancel`。
- **全部剩余项都 blocked 时不再空转 steer**：没有可运行子任务时，每回合
  steer 只会消耗回合而不推进；现在只拦 `present`，不再 steer。
- 闸门仍按回合计数、上限 2 次，避免死循环。

### 验证

- `npm run check` 无诊断。
- `npm test` → **220 tests / 220 pass / 0 fail**（1.8.7 基线 215，新增 5 条：
  结算唤醒拦截、无关结算不误激活、`present` 拒绝/放行、全 blocked 行为）。
- `npm run build` 确定性：`lib/host.js`、`lib/runtime.js`、`lib/plan.js`、
  `lib/watchdog.js`、`client.js` 五个产物构建前后 sha256 一致。

### 说明

- 版本同步：`package.json`、`package-lock.json`、`README.md` / `README.en.md`
  安装命令、`src/host.ts` 的 `meta.version` 均为 1.8.8。
- 本次未改 `client.ts`；运行中的 `dsh web` 需要重启后才会加载新 `lib/*.js`。

## 1.8.7 — 2026-10-31

**修复：计划没做完就把中间结果当成品交付——「未完成即输出」的根治。**

> 事故（2026-10-31，会话 `session-99984ebd-7d13-47d5-87a0-e9ba7271b883`，
> 计划 `wp-66f57fa3…`，13 项子任务）：11:48:54 主 Agent 调
> `dsh_workplan_dispatch({mode:"wait"})`；12:02:54 计划以「本轮预算用尽，可续跑
> （完成 10/13，受阻 0）｜已加入进行中的派发并等到结果」返回，同一秒注入的
> 「部门执行结果」第 3 条写着「给出最终答复」、第 4 条又写「再次调用
> dsh_workplan_dispatch」；模型照第 3 条执行，12:04:22 `present` 了报告、
> 12:04:25 `turn/end` 记 `completed`。12:13 的第二个回合把进度写成
> 「11/13，可续跑，不是失败」后再次收尾，T12/T13 再没跑过。用户看到的就是一份
> 半成品「成品报告」。

### 根因（五层，缺一层都拦不住）

1. **结果消息自相矛盾**：未完成时仍写「3. 给出最终答复」，与「4. 再派发续跑」
   直接冲突（`src/plan.ts` `buildResultMessage`）；摘要也固定写「请主 Agent
   核对并整合」（`buildResultSummary`），把暂停包装成交付。
2. **工具返回误导**：`ok: true` + 「已加入进行中的派发并等到结果」读起来像成功，
   且没有任何 `complete` 字段可供模型判断（`src/host.ts` dispatch render、
   `dispatchToolOutputSchema`）。
3. **提示词只有软约束**：只说「不要声称未经验证的完成」，没有「未完成禁止
   present／禁止写已完成」的硬规则。
4. **回合结束不受约束**：插件只订阅 `agent/pre-step`，模型随时可以收尾；
   预算暂停只是提示「可续跑」，没有强制点。
5. **没有回归用例**：上一版 1.8.4 只修了「已结束 ∧ 正在做」，没有覆盖
   「已结束 ∧ 还有 pending/blocked」。

### 修复

- **结果消息分叉**：`buildResultSummary` / `buildResultMessage` 在
  `done < total` 时第一句即「未完成：完成 d/t，剩余 N 项」，职责清单改为
  「【未完成，禁止交付】」+ 恢复动作；只有全部 done 才出现「给出最终答复」。
- **工具文案分开**：dispatch render 三种口径——「已开跑，尚未完成」/「未完成：
  完成 d/t，剩余 N 项」/「已完成：完成 d/t」；schema 增加 `complete` 与
  `remaining`；工具描述写明 `complete=false` 必须续跑。
- **提示词硬规则**：`PROMPT_SECTION` 新增第 5、6 条：完成唯一判据是全部 done；
  `ok:true` 不等于完成；未完成时禁止 `present`、禁止「已完成/最终版/已交付」、
  禁止收尾答复，必须先续跑；确有阻碍时答复开头必须写「未完成：剩余 N 项」。
- **回合收尾闸门**：`src/runtime.ts` 新增 `onTurnStopping`，在官方
  `agent/turn-stopping`（serial、边界提交前 await）里检查本会话计划：仍有
  未完成项时先等正在跑的派发，再用 `agent.steer()` 注入「计划没做完，这个回合
  不关闭」并附续跑指令；每回合最多 2 次，全 done／已取消／非任务回合直接放行。

### 测试

- 新增 `tests/workplan-turn-stop-gate.test.ts`（6 条）：摘要/结果消息在未完成与
  完成时的分叉、收尾指令文案、steer 拦截与上限、全 done/已取消/非本回合放行、
  后台派发仍在跑时先等结果再判定。
- `npm test` → **215 tests / 215 pass / 0 fail**；`npm run check` 无诊断。

### 升级

```bash
dsh plugin --profile web add dsh-workplan@1.8.7
```

插件在 `dsh web` 启动时加载，**升级后需重启一次 `dsh web` 才生效**（重启会中断正在
运行的会话）。

---

## 1.8.6 — 2026-10-30

**修复：子 Agent 被中断时「证据已在盘上却不被承认」，以及把「待跑」冒充成「卡住」。**

> 事故（2026-10-30 21:34:54，ETF 计划 `wp-008107ca…`）里 T6 的子 Agent 在写出
> 38,140 字节产物后被打断（`turn/end` 记 `aborted`、`reason.kind = "user"`）。
> 计划把它判成受阻，并把 T7–T12 六个下游一并级联成 blocked；主 Agent 只能自己
> 逐条核对「文件其实已经在盘上」。同一轮里另有一处：`ready` 为空时所有 pending
> 被改写成 blocked，预算暂停与真失败在卡片上长得一模一样。

### 修复

- **D5 中断也要留证据**：新增 `probeInterruptedEvidence()`，中断时把「声明过的产物」
  与「核到在盘上的文件」取并集写进该步的 `artifacts` / `missingArtifacts`（不再只
  拼进报错字符串）；状态仍是 `blocked`，判定不放宽。
- **D5 不再连坐下游**：`dispatchPlan` 用 `interruptedIds` 记住被中断的步骤，级联时
  跳过它们，并在 `errors` 里写明「被中断但产物已核对，未自动级联下游；请据实改判
  或续跑」。
- **D8 不再把 pending 写成 blocked**：新增 `describePendingCause()`，按上游状态、
  缺失产物、legacy 回执分别给出原因；本轮结束时 pending 保持 pending，阶段为
  `paused`（没有真失败项时），不再被覆盖成 `blocked`。

### 测试

- 新增 4 条：中断写入 `artifacts`/`missingArtifacts`、下游保持 `pending` 且阶段为
  `blocked`（真有失败项时）、上游产物缺失时下游 `pending` + 阶段 `paused`、全部完成
  时不多写解释文案。
- `npm test` → **209 tests / 209 pass / 0 fail**；`npm run check` 无诊断。

### 升级

```bash
dsh plugin --profile web add dsh-workplan@1.8.6
```

插件在 `dsh web` 启动时加载，**升级后需重启一次 `dsh web` 才生效**（重启会中断正在
运行的会话）。

---

## 1.8.4 — 2026-10-30

**修复：左侧栏「任务进度」同时显示「已结束」和「正在做」。**

> 现象（用户截图，2026-10-30 20:06:33，会话 `session-b83e4a75-…`）：
> 同一张卡片既在「已结束」分组里、徽标写着「已结束，可续跑 · 正在做」，
> 第 4 步又写着「正在做」；而会话正文早已给出结果。同一张卡还给出两个完成度
> （计数 73% / 加权 80%），并承诺「可续跑」却不给续跑方法。

### 根因

计划结果由异步派发结算，**派发可以跨过宿主回合结束**（事故里 `turn/end`
在 19:58:39，派发又继续跑到 20:22:50）。`serialisePlan` 判断「本轮是否结束」
时只看最后一个 `turn/start|turn/end` 事件，没有看插件自己的存活信号
`record.dispatchPromise`，于是把「回合结束」当成「没有东西在跑」，把阶段改写成
`ended`，而子任务状态仍是 `in_progress`——两句话从此各说各的。

同一处还有三个次生矛盾：客户端 `planPhaseOf` 用计数覆盖服务端阶段；`resumeHint`
只在 `phase === 'blocked'` 时给指令（徽标却对 `ended` 承诺可续跑）；展开页用
`stats.progress`（加权）而分组/环用计数百分比。

### 修复

- **存活事实优先**：`serialisePlan` 先读 `record.dispatchPromise`；有活派发时
  不进入 `ended`，并把 `running` 随载荷下发（`src/runtime.ts`）。
- **收敛残留项**：回合真的结束且无活派发时，把残留的 `in_progress` 改判
  `blocked` 并附「本轮结束时这一步仍未完成…可以续跑」的说明——只改下发的副本，
  内存记录不动，续跑仍从原地继续（`settleStaleInflight`）。
- **口径统一**：展开页与分组/环改用同一个计数百分比，不再并列「加权」数字。
- **承诺与操作一致**：`ended`/`paused` 且原阶段可续跑时，也给出续跑指令。
- **新增不变量 I11**：`phase=ended` 且仍有 `in_progress` 时自检判红。
- **回归测试**：新增 `tests/ended-live-dispatch.test.ts`（6 例，含回放路径与
  「收敛不改内存记录」），`tests/client-resume-hint.test.ts` 增 2 例（徽标与
  续跑说明必须同时成立；载荷说「还在跑」时界面不得显示「已结束」）。

### 升级

```bash
dsh plugin --profile web add dsh-workplan@1.8.4
```

插件在 `dsh web` 启动时加载，**升级后需重启一次 `dsh web` 才生效**（重启会中断
正在运行的会话）。历史计划不需要数据订正：面板按新规则重算即可，旧记录里
「已结束 + 正在做」的组合不会再被渲染出来。

### 已知限制

- 「已结束」只代表「没有活派发」，不代表计划完成；未完成的计划仍会进「已结束」
  分组并标出受阻数，这是刻意的：用户需要看到「这一轮结束了，但事情没做完」。
- 派发存活信号只在同一进程内有效。进程在派发中途被杀时，记录里不会留下
  `dispatchPromise`，此时按「回合结束 + 残留 in_progress」收敛为受阻。

---

## 1.8.3 — 2026-10-30

**文档版：把首页第一句换成用户选定的措辞。不改代码。**

> 首页第一句定为：**"ISO/IEC 15408:2026 全套安全证据，5 条命令自己验；安装一条命令、零第三方运行时依赖。"**
> 仍然没有证书，仍然不写"通过/完全满足"——理由在紧接着的"为什么敢拿 ISO/IEC 15408 当卖点"一节，一句话可自证。

### 升级

```bash
dsh plugin --profile web add dsh-workplan@1.8.3
```

---

## 1.8.2 — 2026-10-30

**文档版：把两个卖点提到首页第一句，并删掉首屏的铺陈。不改运行时代码。**

> 反馈很直接：仓库首页看完还不知道卖点是什么，而且话太多。这一版只动文档：
> 第一句同时点明两个卖点，首屏压到「一句标语 + 一句定位 + 三条要点」，
> 长篇解释全部下移或折叠。技术结论、合规立场、测试数量都没有变。

### 变更（文档）

- `README.md` / `README.en.md`：**第一句**即两个卖点 —— ①安全证据按 ISO/IEC 15408:2026（CC）
  公开、可自己核对（明说没有证书、不宣称"通过"）；②安装只要一条命令、零第三方运行时依赖。
- 首屏从"徽章 + 两段引用 + 长段标准科普"压到 5 行内；CC 三方分工的解释由 4 条长要点改为 1 段。
- `1.5.0 改了什么` / `1.4.3 修了什么` 两节折叠进 `<details>`，默认收起，内容一字未删。
- 计算出的就绪度表述统一为"EAL1 的 14 项组件：10 就绪 / 3 部分 / 1 外部实验室"。

### 测试

- `npm run verify`：188 tests / 188 pass / 0 fail（无代码变更，仅版本号与文档）。

### 升级

```bash
dsh plugin --profile web add dsh-workplan@1.8.2
```

---

## 1.8.1 — 2026-10-30

**补丁版：把 v1.8.0 里三处"文档说得比代码多"的地方改成一致，并补上一处真实的方法限制。**

> v1.8.0 发布后我们做了独立复核，发现文档有三处与实现不符。讲安全的文档说错话，比不写文档更糟，
> 所以单独发补丁版更正，并把更正过程本身也写进 `docs/cc/CC-2026-ASSESSMENT.md` 的修复记录（D-05/D-06/D-07）。
> 本版**没有**新增安全功能上的主张，也没有改变对 CC 的立场：仍然没有证书，仍然不宣称"通过"。

### 更正（文档与实现对齐）

- `SECURITY.md`、`docs/cc/SECURITY-TARGET.md`：此前称图表库路由"同上鉴权"，实际该路由从未调用
  `connection.requestRejection`。现改为明确声明：`/dsh-workplan/vendor/chart.umd.js` 是**公开静态资源**
  （随包固定的 Chart.js 4.6.1，MIT，不含会话数据），只答 GET/HEAD，不鉴权；带数据的
  `/dsh-workplan/plans` 才做鉴权。两者差异在文档里写清楚，不再含糊。
- `docs/cc/SECURITY-TARGET.md`：此前称自测覆盖"鉴权分支、方法限制、响应截断"，实际 `route()` 的
  401/403、405、2.5 MB 截断分支**没有**逐分支用例。现改为如实列出已覆盖项，并把该缺口登记为
  ST §9 的已声明缺口（补测需要构造 DSH `connection` 桩件）。
- `docs/cc/CC-2026-ASSESSMENT.md`：EAL1 矩阵里 `ASE_CCL.1` 由 ✅ 改为 🟡（ST 自己写着
  "Conformance claim: NONE"，与"符合性主张已就绪"自相矛盾），就绪度合计由 11 项改为 **10 项**。
- `README.md` / `README.en.md` / `docs/SBOM.md`：测试数由 187 更新为 188，就绪数改为 10/3/1。
- `docs/cc/CC-2026-ASSESSMENT.md`：新增"版本时差提醒"与差距 N-07 —— ISO/IEC 15408:2026 是现行国际标准，
  但截至 2026 年 JISEC / NASK / 欧盟 CC 认证仍受理 **CC:2022 Release 1**，真实评估会先按 2022 版受理。

### 变更（实现）

- `src/host.ts`：图表库路由补上方法限制——非 GET/HEAD 返回 `405` 并带 `allow: GET, HEAD`；HEAD 返回头而无响应体。
  路径仍为常量（不由请求 URL 拼接），不引入任何写盘、子进程或出站请求。

### 测试

- 新增 1 项：`tests/security-headers.test.ts` 断言图表路由的 405 与方法限制存在，防止文档与实现再次漂移。
- `npm run verify` → **188 tests / 188 pass / 0 fail**。

## 1.8.0 — 2026-10-30

**本次发布只做一件事：把"安全"从形容词变成可核对的证据链 —— 按 ISO/IEC 15408:2026（CC）的结构公开自评估材料，并补上两处实现缺口。**

> 明确声明：**本插件没有 CC 证书，也没有通过任何实验室评测。** 我们不宣称"完全满足 ISO/IEC 15408"。
> 我们公开的是按标准结构组织的材料、可复跑的测试、以及逐条写明的边界。详见 `docs/cc/CC-2026-ASSESSMENT.md`。

### 新增（标准材料）

- `docs/cc/CC-2026-ASSESSMENT.md`：按 ISO/IEC 15408-3:2026 保证类（ASE/ADV/AGD/ALC/ATE/AVA/ACO/AMA）逐类判定，
  并给出 **EAL1 就绪度矩阵**（14 项组件：11 项就绪、2 项部分具备、1 项完全依赖外部实验室）与未修复差距清单。
- `docs/cc/SECURITY-TARGET.md`：按 ASE 族结构（INT/CCL/SPD/OBJ/ECD/REQ/TSS）编写的安全目标草案，
  含 7 条威胁、3 条假设、3 条组织策略、5 个功能要求族共 8 个组件，以及逐条到实现的映射。
  首行显式声明 **"Conformance claim: NONE"**。
- `docs/cc/AVA-VULNERABILITY-ANALYSIS.md`：攻击面穷举（2 条只读路由 + 4 个模型工具 + 1 个随包文件）、
  威胁→对策→残留风险表、8 项已识别缺陷（5 项本版修复、3 项写明接受理由）。
- `docs/SBOM.md`：软件物料清单。运行时 **0** 依赖、6 个开发依赖（含传递）、1 个随包第三方文件
  （Chart.js 4.6.1，MIT，sha256 `338399fb…f67fbf`）。
- `SECURITY.md`：漏洞私密报告渠道、响应时限、攻击面摘要、部署建议、以及
  **5 条"我们不做/不宣称的声明"**（无 CC 证书、非多租户、不替代 DSH 鉴权等）。

### 变更（实现）

- `src/runtime.ts`：新增冻结常量 `HARDENING_HEADERS`（`x-content-type-options: nosniff`、
  `referrer-policy: no-referrer`）与 `applyHardeningHeaders(res)`，在 `route()` 入口统一应用。
- `src/host.ts`：chart 静态文件路由同样调用 `applyHardeningHeaders`，避免两条路由的策略不一致。
- `package.json`：`files` 增加 `SECURITY.md` 与 `docs`，使 npm 包内即可查阅合规材料。

### 测试

- 新增 `tests/security-headers.test.ts`（4 项）：断言响应头常量值、写入行为、
  对无 `setHeader` 的对象保持静默、以及两条路由确实都调用了加固助手。
- `npm run verify`：**187 tests / 187 pass / 0 fail**（1.7.1 基线为 183）。

### 升级须知

- 无破坏性变更，无新增运行时依赖；`dsh plugin --profile web add dsh-workplan@1.8.0` 即可。
- 若你在反向代理后部署，请仍按 `SECURITY.md` §6 自行加 TLS 与认证——本插件不自带。

## 1.7.1 — 2026-10-30

**修复：1.7.0 在宿主上无法激活（整个插件被跳过）。**

现象：升级到 1.7.0 并重启 DSH Web 后，终端出现

```
dsh: warning: 1 entry did not activate
dsh-workplan-plugin: JsonSchemaError: unsupported JSON schema:
  schema.properties.elapsedMs.type must be a single type string (type arrays are not supported)
```

结果是任务进度面板与四个工具**全部消失**——不是功能降级，而是插件条目在激活阶段抛错被跳过。

根因：`statusToolOutputSchema()` 用 `type: ['number', 'null']` 表达「可为空的耗时」，而宿主的
`assertSupportedJsonSchema` 只接受**单一类型字符串**；同一处 `dsh_workplan_update` 的 `progress`
还用了宿主子集不支持的 `minimum` / `maximum`。

修复：

- `elapsedMs` 改为 `oneOf: [{ type: 'number' }, { type: 'null' }]`；
- `progress` 去掉 `minimum` / `maximum`，范围写进 `description`；
- `cancel` 的输出 schema 提取为 `cancelToolOutputSchema()`，与其余 schema 接受同一套校验；
- 新增 `tests/workplan-host-schema.test.ts`：按宿主子集规则递归校验全部工具的 `parameters` 与
  `output.schema`，并锁死「可空标量只能经 `oneOf` 表达，不能写 type 数组」；
- 另用宿主真实的 `assertSupportedJsonSchema` 对 4 个工具各跑一遍（开发期校验，不入测试依赖）。

验证：`npm test` 183 通过，`npm run check` 通过，四个工具 schema 均通过宿主校验。

## 1.7.0 — 2026-10-30

**「协作契约」版：让主 Agent 与各部门在全程共享同一份事实。**

1.6.0 的协作审查（[docs/review-collaboration-20261030.md](docs/review-collaboration-20261030.md)，17 条断点 C1–C17）
暴露了同一个根因：**派出去的部门与主 Agent 之间没有可核对的契约**。派发期间主 Agent 全盲；
子 Agent 交回任何非空文本就算完成；依赖只看状态不看产物；主 Agent 的改判会被子 Agent 的结算覆盖，
也活不过一次刷新。本版把「谁在做什么、凭什么算做完、改判以谁为准」收敛成代码里唯一的判定表。

### 新增

- **结构化结果契约**（`src/plan.ts#adjudicateResult`、`#parseEvidenceBlock`）：子 Agent 在输出末尾回传
  `WORKPLAN_EVIDENCE` 块，含 `status` / `blockedReason` / `acceptance[]` / `artifacts[]` / `needs[]`。
  八种情形写死在 `adjudicateResult`：`blocked` / `partial` → 受阻；任一验收 `fail` → 受阻（`failed`）；
  全 `pass` → 完成（`structured`）；含 `unverified` → 完成但标 `unverified`；无块但首行 `BLOCKED:` → 旧格式受阻；
  坏块 → 受阻（`unparsable`）。只有 `structured` 可直接采信，其余在结果消息「验收核对」段逐项列出，交给主 Agent 复核。
- **异步派发与只读观测**：`dsh_workplan_dispatch` 新增 `mode: "wait" | "async"`（默认 `wait`）。`async` 立即返回
  `running: true` 与实时状态，本轮结束时仍自动写入 durable 结果消息；新增只读工具 `dsh_workplan_status`，
  可从会话记录重建计划，刷新或重启后也能回答「做到哪了」。`wait` 遇到进行中的派发会**汇合**（`joined: true`）
  并返回完整结果，不再只回一个 `alreadyRunning: true`。
- **写保护**：`dsh_workplan_update` 新增 `expectedRevision` 与 `force`。基于旧快照的写入返回 `STALE_WRITE`；
  计划执行中改判运行中的子任务返回 `TASK_RUNNING`（`force: true` 才覆盖，并记录为人工改判）。每次写入递增
  `revision`，人工改判以 durable `workplan-update` 消息落盘，刷新后仍然生效。
- **产物门禁**：结算时逐个核实子 Agent 声明的 `file` 产物，缺失的记入 `missingArtifacts`；依赖它的下游不解锁，
  受阻文案点名上游 `T1「标题」`、原因与缺失文件。可用 `artifactGate: false` 关闭（排障/旧计划回放）。
- **跨部门 brief 与 needs 转达**：子 Agent 提示词带上「兄弟部门进展」（谁、做什么、产出什么、已完成摘要），
  并明确「需要协作请写进 needs，由主 Agent 转达」；结果消息新增「跨部门待转达」段，要求逐条处理。
- **重试回灌**：重试只发生一次且规则确定——硬超时/中止/预算到点不重试，停滞或未完成且剩余时间足够才重试；
  第二次尝试的提示词带上一次的 `code` 与原因，不再原样重撞同一堵墙。
- **时间预算预估**：规划器必须为每个子任务写 `estimateMinutes`，计划卡提示本轮预算是否够用。

### 修正

- 子 Agent 输出不再被二次截断：背景由「计划时刻采样并截断到 5000 字」改为派发前 `recentConversation` 的 7000 字，
  `buildChildPrompt` 直接使用入参。
- 依赖受阻文案从「依赖未完成或上游受阻」改为带上上游标题、原因与缺失产物。
- 结构化证据块解析失败不再默认完成，而是显式 `blocked/unparsable`。

### 兼容与迁移

- 旧会话无需迁移：没有结构化块的旧结果按 `legacy` 读作「完成但未验证」，结果消息会提示主 Agent 复核；
  `strict: false` 保留 1.6.0 的判定，供旧计划回放使用。
- `update` 原有参数与语义不变，新增参数全部可选。
- `PLAN_VERSION` 仍为 1；旧计划消息可原样回放。

### 文档

- 新增[协作契约](docs/collaboration.md)（角色、数据契约、状态机、失败恢复、写者所有权）与
  [部门职责与交接约定](docs/departments.md)；新增 [RELEASING.md](RELEASING.md) 发布清单；
  更新中英文 README 至 1.7.0 并去掉过期的测试数字硬编码。

### 验收

- `npm test` 179 个用例全绿；新增 7 个测试文件，覆盖证据契约、派发模式、写保护、产物门禁、
  跨部门 brief、重试回灌与 host 工具 schema；`npm run check` 通过。
- 原计划的 1.6.1（纯文档修复）已并入本版，不再单独发号。

## 1.6.0 — 2026-10-29

**「会话终止」收敛版**。用户截图圈出 `session-7129faea-d4bd-4ed5-a081-769496e07ceb`：
这一轮对话早就结束了（没有任何东西在跑），面板红圈的分组仍写着**「进行中」**，卡片还停在
「预算用完，可续跑」。本次让**宿主会话生命周期**成为「到底有没有在跑」的唯一事实源，并把
该结论落成新的独立阶段 `ended` / 独立分组「已结束」，同时修掉回放路径上把失败写入计为完成的
第二个打架点。

### 事故与根因

事故会话的关键事实（来自会话日志回放）：

1. 插件**只订阅 `agent/pre-step`**（`src/host.ts:286`），`turn/end`、`session/event`、
   `session/disposed` 一个都不消费 → **会话结束这件事对插件不可见**；
2. 计划阶段只由「派发动作」写入（`executing` / `paused` / `blocked` …），派发结束后
   再没有任何代码把它改回来，于是阶段永久停在被最后一次派发写下的值；
3. 唯一存在的兜底只覆盖一种情形：**从未派发**且 `pending` 超过 10 分钟才改判 `cancelled`
   （`src/runtime.ts` 的 `STALE_PENDING_MS` 分支），对「派发过、会话结束」完全无效；
4. 客户端把**除 done 以外的一切阶段**都塞进「进行中」组
   （分组条件只有 `planPhaseOf(...) !== 'done'`）→ `paused` / `blocked` / `pending` /
   `executing` / `degraded` 全部显示成「进行中」；
5. 回放路径 `reconstructFromSession` 见到 `dsh_workplan_update` 调用就 `applyStatus`，
   **忽略宿主 `tool/result` 的 `message.isError`** → 该会话里一次失败的写入被记成完成
   （面板显示 7/12，真实完成 6/12），刷新前后又一次「数据源打架」。

结论：这是**插件缺陷**，不是上游缺失——宿主侧 `turn/start` / `turn/end`（含
`aborted.reason.kind` 的 `user` / `parent` / `hook` / `disposed`）事件齐全且已落盘。

### 改动

- **`src/runtime.ts`**
  - 新增并导出 `sessionTurnState(session)`：从会话日志末尾向前扫最近 200 条
    （`TURN_BOUNDARY_SCAN`），先遇 `turn/start` ⇒ 这一轮还开着，先遇 `turn/end` ⇒
    已结束并带出 `reason.kind` 与 `aborted` 子原因；扫不到 ⇒ `unknown`（**绝不猜**）。
    读日志而不是加事件订阅：日志既是实时事实也是回放事实，实时与刷新后必然同源。
  - `serialisePlan()`（实时与回放共用的唯一出口）在既有的过期 `pending` 兜底之后、
    不变量自检之前收敛：`planPhase` 不是 `done` / `cancelled` 且这一轮已结束 ⇒
    阶段改为 `ended`，原阶段写进 `suspendedPhase`，并附带 `endReason` /
    `endReasonDetail` / `endedAt`。**`done` 不参与改写**（否则直接违反不变量 I8）。
  - **`turn/end` 不等于「取消」或「完成」**：一轮结束后可以随时续跑，因此只把
    「没有东西在跑」这件事表达出来，不动 `record.phase`——用户说「继续」、日志出现
    新的 `turn/start` 后，下一份载荷自然回到原派发阶段，无反向迁移逻辑。
  - 回放改为**先登记、后定案**：`tool/call` 只记 `callId → 参数`，等配对
    `tool/result` 到达才采纳；`message.isError === true` 丢弃，无结果同样不采纳
    （保守优先于乐观）。跨计划的迟到结果按 `planId` 拒绝，不污染新计划。
- **`src/client.ts`**
  - 新增阶段 `ended`（中「已结束，可续跑」/ 英「Ended (resumable)」）与**第三个独立分组
    「已结束」**，位置在「进行中」与「已完成」之间；分组、组头计数、卡片胶囊继续共用
    `planPhaseOf` 单一结论。
  - 新增 `phaseLabel()`：徽标两段式表达「终态 + 原阶段」（如
    「已结束，可续跑 · 预算用完，可续跑」「已结束，可续跑 · 卡住了」），
    不再用一个词暗示还在跑，也不丢「停在哪儿」这个关键信息。
  - 「已结束」组保留「需处理」角标（判定用后端下发的 `suspendedPhase`），
    组头按 `endedAt` 排序（最近结束在前）；有进行中/已结束计划时「已完成」组默认收起。
  - 图表口径随之改名：环图为「未结束 / 已完成」，柱图为「未结束计划的完成度」，
    已结束但未完成的计划一并计入「未结束」。
  - 新增 `.dsh-wp-group--ended` 样式：灰点、**不脉冲**——「没有东西在跑」不允许用动画表达。
- **版本**：`1.5.2 → 1.6.0`（minor）。载荷新增字段、客户端新增分组，属**向后兼容的对外
  扩展**而非纯 bugfix：旧客户端读新载荷只会忽略 `ended` 相关字段并把计划当 `pending`，
  不会崩溃，但**看不到「已结束」**，所以建议同步升级。

### 测试（新增 17 条，全部可复跑）

- `tests/session-end-convergence.test.ts`（12 条，后端/载荷级）：正常结束、异常中断
  （`aborted/user`）、进程级中断（`aborted/disposed`）、**正在跑不误判**、全部完成仍是
  `done` 且无不变量违规、结束后说「继续」阶段回退、刷新幂等、双会话隔离、
  扫描上限返回 `unknown`、回放只采纳成功写入（isError / 无结果 / 成功三态）。
- `tests/ended-group.test.ts`（5 条，渲染级）：`ended` 计划只进「已结束」组、组名不再出现
  「进行中」、徽标两段式、卡住的计划仍报「需处理」、无 `ended` 时不渲染空组、
  「已完成」组折叠规则。

```
npm test   # 137 tests / 137 pass / 0 fail
```

### 验证方式（任何人都可复跑）

```bash
# 1) 完整回归（含本次新增的 17 条用例）
cd plugins/dsh-workplan && npm test
# 2) 只跑本次的两个新用例文件
node --test dist-tests/tests/session-end-convergence.test.js dist-tests/tests/ended-group.test.js
# 3) 面板验收（人工）：打开一个「已结束、未完成」的会话，
#    任务进度面板应把它放在「已结束」组，徽标写「已结束，可续跑 · …」；
#    说一句「继续」后，同一张卡应回到「进行中」。
```

### 兼容与升级

- 已装 1.5.x 的用户：升级后刷新页面即可，「已结束」组立即生效；
- 若面板在升级后仍显示「进行中」：先确认宿主版本已把 `turn/end` 落盘（1.6.0 依赖它，
  未落盘时会保持原判定而不是误判），再确认浏览器已加载新 `client.js`。

## 1.5.2 — 2026-10-29

**「完成语义」统一版**。用户截图圈出一张 `14/14` 全部做完、环形进度 `100%` 的计划卡，
右侧状态胶囊却写「正在收尾」，而且这张卡仍留在「进行中」组。本次把**进度**与**状态**
收敛到同一个事实源，并把状态矩阵里同一根因的 8 类矛盾一并修掉。

### 事故与根因

截图会话为 `session-c3852c31-f6cd-4fc5-8cff-d8a3932e9feb`。事件回放显示：

1. 最后一次派发在预算用尽时结束，结果消息落盘为 `12/14 done、phase: paused`；
2. 之后主 Agent 直接调用 `dsh_workplan_update`，把剩余 `T13`、`T14` 标为 done
   （会话里两次工具调用，`seq 263` / `seq 269`），**没有再发生任何派发轮次**；
3. `updateStatus` 用 `planPhase(statuses)` 重算 phase，而 `planPhase` 以
   「结果消息是否已落盘（`resultSeen`）」为终态闸门 → 全部完成后仍返回 `integrating`；
4. 结果消息只在派发轮次末尾写入，走 update 工具的路径**永远不会**写它，
   于是 phase 永久停在 `integrating`，`stats.progress` 已经是 `100`；
5. `serialisePlan` 又优先信任内存里的 `record.phase`，而回放 `reconstructFromSession`
   用 `resultSeen = true` 重算出 `done` —— 同一条记录「刷新前正在收尾、刷新后已完成」；
6. 客户端还有三套独立的「是否完成」判断：环形进度看 `percent >= 100`、
   「都做完了」看 `done === total`、状态胶囊看 `phase`，三者可以各说各话。

因此这不是文案问题，而是**完成事实有两个事实源**（计数 vs. 副作用闸门）。

### 改动

- **`src/plan.ts`**
  - `planPhase()`：所有子任务 `done` 时**恒返回 `done`**，不再看 `resultSeen`
    （参数保留以兼容既有调用，标注为历史遗留）；`integrating` 仅作为旧载荷的
    兼容取值存在。
  - 新增 `reconcilePhase(phase, statuses)`：终态只由计数决定；`done` / `integrating`
    这类「由计数派生」的旧值一律重算；`paused` / `cancelled` / `blocked` / `degraded`
    保留各自的事实来源。
  - `deriveAggregates()`：未全部完成时总进度**封顶 99**（`Math.min(99, raw)`），
    杜绝「11 done + 1 blocked@95 → 总体进度 100」。
  - `applyStatus()`：`in_progress` 的 `progress` 夹紧到 `99`，「正在做」不允许自称 100%。
  - `aggregateInvariantViolations(snapshot, phase?)`：新增
    **I8**（`done === total` 必须 `phase === 'done'`，双向）、
    **I9**（全部完成必须 100%，未全部完成不得 >= 100）、
    **I10**（`in_progress` 不得 `progress >= 100`）。
- **`src/runtime.ts`**
  - `serialisePlan()`：`phase` 改为 `reconcilePhase(record.phase ?? 派生值, statuses)`；
    载荷在存在不变量违背时附带 `violations` 数组，便于定位而不是静默显示。
  - `updateStatus()`：改为 `reconcilePhase(record.phase, record.statuses)`
    —— 截图矛盾的直接入口。
  - 派发尾部：终态晋升不再依赖「结果消息写入」这一副作用，同样走 `reconcilePhase`。
  - 回放 `reconstructFromSession()`：paused/cancelled 覆盖之后统一 `reconcilePhase`，
    保证**刷新前后同源**。
  - `cancelPlan()`：计划已全部完成时改为 no-op（返回 `alreadyDone: true`），
    消除「100% + 已取消」。
  - 预算到点分支：若此刻已经全部完成，记 `done` 而不是 `paused`（防御性，正常循环下不可达）。
- **`src/client.ts`**（自包含 bundle，不能 import `plan.ts`，故在客户端复刻同一语义）
  - 三个唯一算式：`planPercent(done, total)`、`planPhaseOf(rawPhase, counts)`、
    `planWeightedPercent(stats, counts)`；卡片环、徽章、分组、分组环、阶段条、
    会话内联卡、`rank`、`liveBars` 全部改走它们。
  - 新增文案：`helpWaitActive`（等这一步做完，再继续下一项）、
    `helpNoPlan`（还没有安排任何工作）、`nowRemaining`（还剩 {n} 项）。
- **测试**
  - 新增 `tests/phase-percent-invariant.test.ts`（13 例）：终态语义、计数封顶、
    I8/I9 双向、update 补完最后一项、空更新不回退、取消已完成计划、
    客户端渲染旧载荷。
  - 新增 `tests/completion-semantics.test.ts`（8 例）：`in_progress@100` 夹紧、
    I10、单任务执行中不再宣布完成、部分完成「还剩 N 项」、0/0 降级不说完成、
    阶段条只按 done 计宽度、阶段卡与「现在」同口径、0% 未开始不再标 active。
  - 更新 `tests/plan.test.ts`、`tests/workplan-budget-pause.test.ts` 里把
    「全部完成后停在进行中」当期望值的断言；`tests/derived-counts.test.ts`
    的 blocked 用例期望改为 99。
- **版本**：`1.5.1 → 1.5.2`（patch，修正完成语义，不新增对外接口）。

### 同类矛盾（来自 `docs/state-progress-matrix.md`）

| 编号 | 现象 | 本次 |
| --- | --- | --- |
| C1 | 100% + 「正在收尾」+ 留在「进行中」 | 已修 |
| C2 | 执行中却写「没有下一步，这件事已完成」 | 已修 |
| C5 | 部分完成却写「还没开始」 | 已修 |
| C7 | 阶段条把 blocked 算作已触达（环 50%、条 100%） | 已修 |
| C8 | 允许 `in_progress + 100%` | 已修 |
| C9 | 阶段行说「正在做」、阶段卡说「还没开始」 | 已修 |
| C11 | 0/0 降级计划也说「这件事已完成」 | 已修 |
| C12 | 同屏两个互斥的「现在」 | 已修 |
| C13 | 0% 未开始的卡标 `data-state="active"` | 已修 |
| C3 | 已取消的卡在前端被过滤，用户看不到（与 `dsh_workplan_cancel` 描述文案不一致） | 未改：既有设计，`tests/client-render.test.ts` 明确断言不渲染；记录待与工具描述统一 |
| C10 | stale pending 被序列化成 cancelled，而回放返回 `pending + stale:true` | 未改：记录为下一步 |
| C14 | `planning` 是死枚举 | 未改：记录为清理项 |

### 验证

- `npm run build` → exit 0；`npm run check`（`tsc --noEmit`）→ exit 0。
- `npm test` → **120/120 通过**，0 fail（原 99 + 新增 13 + 8）。
- `node scripts/repro-phase-percent-integrating.mjs --expect-fixed` → 7/7 PASS，
  `payload.phase = done`、`stats = { total: 2, done: 2, progress: 100 }`、
  徽章「已完成」、`live = done`、`replay = done`、无 `violations`。
  （同一脚本不带参数运行现在会 3 条 FAIL —— 这是旧 bug 已不存在、修复生效的证据。）
- 版本一致性 7 处：`package.json`、`package-lock.json` 两处、`src/host.ts`、
  `lib/host.js`、`dist/host.js`、本文件顶部，全部 `1.5.2`。
- 本次**未重启 DSH 服务**：`lib/*.js`（host 侧）在 DSH 进程下次启动时才加载；
  `client.js` 随页面刷新生效。

### 发布

- 两个渠道、同一份制品（2026-10-29 13:22–13:25 +08:00 实测，发布已完成）：
  - git：`https://github.com/abbaababa/dsh-workplan.git` 的 annotated tag `v1.5.2` → `666b0fe`；
  - npm：公共 registry `https://registry.npmjs.org/dsh-workplan` 的 `1.5.2`（`dist-tags.latest`）。
- **状态**：
  - `git push origin main` → `b0e0b76..666b0fe  main -> main`（快进，exit 0）；
  - `git push origin v1.5.2` → `* [new tag]  v1.5.2 -> v1.5.2`（exit 0）；
  - 远端复核（`git ls-remote`）：`refs/heads/main` = `666b0fee483b…`，
    `refs/tags/v1.5.2` = `155c601c73d7…` → `^{}` = `666b0fee483b…`；
  - `npm publish ./dsh-workplan-1.5.2.tgz --access public --ignore-scripts`
    （在 `git worktree add --detach /tmp/dsh-wp-1.5.2 v1.5.2` 的干净快照上先 `npm pack`，
    再发布该 `.tgz`，22 个文件全部取自 tag 提交）→ `+ dsh-workplan@1.5.2`（exit 0）；
  - `https://registry.npmjs.org/dsh-workplan/1.5.2` → **HTTP 200**，
    `time['1.5.2']` = `2026-10-29T05:24:48.346Z`（13:24:48 +08:00），`dist-tags.latest` = `1.5.2`；
  - 消费者视角：空白目录 `npm i dsh-workplan@1.5.2` →
    `meta = {"name":"dsh-workplan","version":"1.5.2",…}`（22 个文件）。
- **已发布制品的校验值**（registry 实测，与本地 `.tgz` 逐字节一致）：
  - npm `shasum`（SHA-1）：`2159024d69c05b3aeeefd5e7ff2f208ec05c67a2`
  - npm `integrity`（SHA-512 SRI）：`sha512-sY7UgT09JwfRFe61HKCOCH7wLz0xbdAxyLla3WO8xoyZ/T6Yxb6H/IqRFf9LEX9EsnW7+z4jcHICms6RKPmTzQ==`
  - 本地 `.tgz` SHA-256：`4482f202d098bbaec35051e54440d0d2be6e0099b6d6606e3c582b88e1aee9fa`
    （269 264 字节，解包 888 135 字节，22 个文件）
- 发布顺序：先分支、后标签、再 npm，避免出现「远端有 tag 而 npm 没有」的半发布态。
- registry 传播延迟实测约 45 秒（直连 404×3 → 200）。
- **CI 说明**：tag 提交 `666b0fe` 的 verify 运行 `40823115340` 为 failure——20 个用例在
  Node 22 上被 `cancelledByParent`（`Promise resolution is still pending but the event loop
  has already resolved`），与 1.5.1 / 1.5.0 / 1.4.3 的推送运行失败原因完全相同（各 20 条），
  属**既有 CI 缺陷**，与本次改动无关，也不影响制品（测试不入包）。根因是运行时把轮次预算/
  空闲计时器 `unref` 掉后，Node 22 在事件循环清空时取消挂起的测试。已在
  `9f0de34`（只改 `tests/` 两个文件，`git diff v1.5.2 -- . ':!tests' ':!docs' ':!scripts'` 为空）
  用「测试期间持有一个 ref 句柄、`after` 钩子释放」修掉；对应运行 `40823694198` 全绿。
- 命令原文与发布后验证：见 `docs/release-record-1.5.2-20261029.md`。

### 回滚

- 升级前四个文件的副本：`.backups/pre-1.5.2-20261029-125724/`
  （`package.json`、`package-lock.json`、`CHANGELOG.md`、`src/host.ts`）。
- 回滚后必须重新 `npm run build`；运行中的 DSH 进程不会自动重载 `lib/host.js`。

## 1.5.1 — 2026-10-28

**「先看这三句」与「分步进度」位置对换的补丁版**。用户以截图圈出展开态计划卡里的这两个板块，
要求把它们的布局位置互换。本次只调整渲染顺序，**数据、接口、样式与既有测试断言零改动**。

### 改动

- **展开态面板顺序对换**（`src/client.ts`）：原来的「先看这三句（`Guide`）→ 降级横幅 →
  分步进度（`PlanOverview`）」改为「分步进度（`PlanOverview`）→ 降级横幅 → 先看这三句（`Guide`）」。
  两个面板组件本身及其内部逻辑不变；`PlanOverview` 仍然只在计划卡展开时（`open === true`）挂载，
  折叠态依旧不挂载。
- **版本**：`1.5.0 → 1.5.1`（patch，仅布局顺序对换，不新增能力、不改对外载荷）；`package.json`、
  `package-lock.json` 两处、`src/host.ts` 的 `meta.version` 同步；`lib/host.js`、`dist/host.js`、
  `client.js` 由 `npm run build` 重新生成。

### 验证

- `npm run build` → exit 0；`npm run check` → exit 0。
- `npm test` → **99/99 通过**（0 fail）。
- 7 处版本一致性检查 → `[PASS] 7 处版本均为 1.5.1`（`package.json`、`package-lock.json` 两处、
  `src/host.ts`、`lib/host.js`、`dist/host.js`、`CHANGELOG.md` 顶部）。
- 提交 `fbe467b`（2026-10-28 22:27:53 +08:00）与 annotated tag `v1.5.1`
  （taggerdate 2026-10-28 22:28:51 +08:00）已就绪并**已对外发布**（见下「发布」）。
- 本次**未重启 DSH 服务**；运行实例里的界面换序靠刷新页面触发（客户端 bundle 热重载）。

### 发布

- 两个渠道、同一份制品：
  - git：`https://github.com/abbaababa/dsh-workplan.git` 的 annotated tag `v1.5.1` → `fbe467b`；
  - npm：公共 registry `https://registry.npmjs.org/dsh-workplan` 的 `1.5.1`（`dist-tags.latest`）。
- **状态（2026-10-28 22:46–22:50 +08:00 实测，发布已完成）**：
  - `git push origin refs/heads/main` → `db74d44..fbe467b  main -> main`（快进，exit 0）；
  - `git push origin refs/tags/v1.5.1` → `* [new tag]  v1.5.1 -> v1.5.1`（exit 0）；
  - 远端复核（`git ls-remote`，独立网络查询）：`refs/heads/main` = `fbe467b4a632…`，
    `refs/tags/v1.5.1` = `120dc2cb…` → `^{}` = `fbe467b4a632…`，本地 `ahead/behind` = `0/0`；
  - `npm publish --ignore-scripts`（在 `git worktree add --detach … v1.5.1` 的干净快照上执行）
    → `+ dsh-workplan@1.5.1`（exit 0）；
  - `https://registry.npmjs.org/dsh-workplan/1.5.1` → **HTTP 200**，`time['1.5.1']` =
    `2026-10-28T14:49:36.697Z`（22:49:36 +08:00），`dist-tags.latest` = `1.5.1`；
  - 消费者视角：空白目录 `npm i dsh-workplan@1.5.1 --prefer-online` → 装到 1.5.1
    （22 个文件，`client.js` 138 195 字节，`lib/host.js` 内 `version: '1.5.1'`）。
- **已发布制品的校验值**（registry 实测，与本地 `.tgz` 逐字节一致）：
  - npm `shasum`（SHA-1）：`a6f35bd1b3d2630e3a2cf9e9555b58e51b20eaba`
  - npm `integrity`（SHA-512 SRI）：`sha512-AmpYMx55Y0ea2tAc14C4V7t/Pxrho+9nZXZqxz7JtdPYvFRyxS+wzEIUCfATRgq5cogT22lTSf0pEwUYOlgdqw==`
  - 说明：同一份内容在原工作树打包时 `shasum` 为 `ecb39f0…`、在干净 `git worktree` 快照上为
    `a6f35bd1…`，差异只来自 tar 记录的 mtime；**22 个文件的 blob 哈希与 tag `v1.5.1` 逐一相同**
    （`checked 22 / mismatch 0`，另 44 个未随包发布的仓库文件按 `files` 白名单正确排除）。
    实际发布的是干净快照这一份，故以上两行为准。
- 发布顺序：先分支、后标签、再 npm，避免出现「远端有 tag 而 npm 没有」的半发布态。
- registry 有约 60–90 秒传播延迟（22:48:58、22:49:20 直连仍 404，22:49:41 转 200）；
  该窗口内 `npm i` 需加 `--prefer-online` 绕过本地元数据缓存。
- 命令原文、失败分支、发布后验证与回滚：见 `docs/release-record-1.5.1-20261028.md`。

### 回滚

- 升级前四个文件的副本：`.backups/pre-1.5.1-20261028-221343/`
  （`package.json`、`package-lock.json`、`CHANGELOG.md`、`src/host.ts`）。
- 回滚后必须重新 `npm run build`；运行中的进程不会自动重载 `lib/host.js`。
- 已推送（远端已有 `fbe467b` 与 `v1.5.1`）：`git push origin :refs/tags/v1.5.1` 删远端标签，
  `git revert fbe467b` 回退提交（不要 `push --force` 改远端 `main` 历史）。
- 已发布到 npm：先用 `npm deprecate dsh-workplan@1.5.1 "回滚说明"` 引导用户；确需撤销时
  `npm unpublish dsh-workplan@1.5.1 --force`——受 npm 官方 unpublish 政策约束（可撤销时间窗口、
  「有包依赖时不可撤销」），执行前核对 `npm unpublish --help` 与 npm 官方文档。

## 1.5.0 — 2026-10-28

**「进度必须一眼看得见」的图表化版本**。1.4.3 把数字收敛成单一来源，但计划卡折叠后仍然只有一行
12px 灰字（`本计划 0/8 做好了` + 54×5px 迷你条 + `0 卡住了`），0% 时迷你条宽度为 0、轨道色与
折叠按钮底色同 token，等于**没有图**；百分比只存在于 `title` 悬停提示里；组头在 0/0 时印
`未完成 0 / 已完成 0（完成率暂无数据）`。用户以截图指出三处画圈区域「不直观、不一目了然、不醒目」，
要求「必须通过图表等形式突出显示」。

### 改动（只动展示层，`plan.ts` / `runtime.ts` / `host.ts` 逻辑零改动）

- **折叠卡摘要改为图表**（`src/client.ts`，默认视图即可读，无需展开、无需悬停）：
  44px SVG 环 + 24px 百分比数字 + `本计划 X/Y 做好了` + 一行「现在在做什么」（卡住优先→正在做→
  全部做完/还没开始，带任务名）+ 8px 四段构成条（按件数分宽，`done/active/blocked/pending`）+
  11px 状态图例（`做好了 0 · 正在做 1 · 卡住了 0 · 还没开始 7`）+ 6px 阶段步进条
  （每阶段一段，当前阶段描边，`data-stage-id` / `data-tone` / `data-current`）。
- **展开后新增「分步进度」**：逐阶段行（名称、`done/total`、4px 细条、状态）＋加权总体进度，
  替换旧的一根计划级进度条；折叠态不挂载，保持卡头紧凑。
- **0% 不再等于「没有图」**：四层信号同时存在——环的零轨加粗到 `rgba(100,116,139,.80)`（≈3.14:1，
  `data-zero="true"`）、24px「0%」、整条灰色「还没开始」构成条、虚线阶段槽 + 当前阶段描边；
  0% 不画 SVG 弧，避免圆头端点在 12 点方向留下与「已完成」混淆的小点。
- **组头收口**：0% 组环零轨同样加粗（`data-zero="true"`）；0/0（没有工作项）时**删除**
  `未完成 0 / 已完成 0（完成率暂无数据）` 整句，只保留环上的 `—` 与组内空态；100% 组
  （`未完成 0 / 已完成 3（完成率 100%）`）整句保留，因为那正是用户要的结论。
- **零新增依赖**：进度全部由既有 `session.stats` / `session.stages` / `session.statuses` 派生，
  纯函数组件，无 `useEffect`、无定时器、不引用 chart.js；`package.json` 无 `dependencies`。
  注意 `node_modules` 里仍能看到 `chart.js@4.6.1`、`@kurkle/color@0.3.4` 标为 extraneous：
  它们是 1.4.3 之后那次「移除 chart.js 依赖」改动未执行 `npm prune` 的残留，不出现在
  `package.json`、不参与 `npm run build`，运行时图表库来自 `vendor/chart.umd.js` 路由。
- **版本**：`1.4.3 → 1.5.0`（minor，新增用户可见能力）；`package.json` / `package-lock.json` 两处 /
  `src/host.ts` 的 `meta.version` 同步，`lib/host.js`、`dist/host.js` 由 `npm run build` 生成。

### 验证

- `npm run check` → exit 0（strict + noImplicitAny）。
- `npm test` → **99/99 通过**（1.4.3 基线 90 项 + 新增 `tests/progress-visual.test.ts` 8 项 +
  `tests/version-sync.test.ts` 1 项）。
  新增用例锁定：0/8 的四个可见信号、3/8→38% 且构成条件数之和等于 total、卡住项
  `data-alarm="true"` 且阶段 `data-tone="blocked"`、三个阶段恰好一个 `data-current="true"`、
  图例恰好四项且顺序固定、折叠态不挂载分步面板、脏数据不产生 NaN/Infinity/undefined 且不超过 100%、
  卡头不引入 canvas 或图表库。`version-sync` 锁定 `package.json` = `package-lock.json` 两处 =
  `src/host.ts` 的 `meta.version`，升级时不需要改测试。
- 同步修改的既有断言：`tests/group-summary.test.ts`（两处 `完成率暂无数据` 改为「不再出现」）、
  `tests/session-collapse.test.ts`（`0 卡住了` → 图例 `卡住了 0` + 可见 `100%`）。

### 回滚

- 改造前整树快照：`.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz`
  （SHA-256 `b8ccc0efa7c307160739ffecdb4af44daab44b3a0f0c779c74d9d0783f6993c7`）。
- 代码完成、版本号未升时的中间快照：`.backups/v1.4.3-progress-viz-code-20261028-142153.tar.gz`
  （SHA-256 `c79513f5c0279e3bb291d536fba7a631fa8018e27bc7d4fca500fbabd9e602da`）。
- 恢复后必须 `npm run build` 并重启 DSH web profile（宿主启动时加载 `lib/host.js`，刷新浏览器不够）。

## 1.4.3 — 2026-10-28

**「同一个数字只能有一个来源」的根治版**。1.4.2 及更早版本里，同一个计划的数字存在两套真相源：
实时状态列表 `record.statuses` 与缓存在记录上的 `record.stats`。缓存只在**每批子任务全部跑完之后**
刷新一次，而看板头部读缓存、阶段徽标与卡片明细读列表，于是同一张卡片上会同时出现
「0 正在做」和「正在做」；预算用尽被重置成 pending 的子任务还带着上一轮的 `progress: 100`，
于是「0/3 做好」的阶段旁边挂着「正在做」、计划进度条显示 100% 而完成数是 0。

本版把计数改成**纯派生**：`derivePlanSnapshot(statuses)` 一次遍历同时产出 `statuses / stats / departments`，
再也没有第二份可被写坏的数字。

### 缺陷（4 条，全部有可复现证据）

用户报告（会话 `session-91ec3273-…`，19:02 截图）：顶部汇总「0 正在做」，而计划卡里第 3 步挂着「正在做」。
以同一份会话数据重放，确认差异为**真实缺陷**而非观感问题：

- **D1 计数缓存冻结**（根因）：`writeSubtaskStatus()` 只写 `record.statuses`，不写 `record.stats`；
  `record.stats` 只在 `while(true)` 批次循环里、**整批子任务跑完之后**才重算。批次运行期间缓存一直是旧值，
  `serialisePlan()` 又优先读缓存（`record.stats ?? computeStats(statuses)`，而 `stats` 恒已初始化，
  回退分支永不触发）。实测：真实状态 `done 2 / 正在做 1 / 待做 0`，缓存仍报 `done 1 / 正在做 0 / 待做 2`，
  进度条 33% 而真实进度 70%。
- **D2 同一报文自相矛盾**：`serialisePlan()` 里 `stats` 取自缓存、`departments` 却由 `statuses` 现场聚合，
  一个 GET 响应内 `stats.inProgress = 0` 与 `design.inProgress = 1` 并存。
- **D3 重置绕过状态机**：预算用尽时用裸对象展开重置为 pending（`progress: item.progress ?? 0`），
  绕过 `applyStatus()` 的伴随字段清理，留下 `pending + progress: 100 + childId + startedAt`。
  连带后果：旧公式把每条 `progress` 直接平均（不计状态），12 项里 11 项完成也算出 **100%**。
- **D4 同一失败两种语义**：异常收敛分支把 blocked 写成 `progress: item.progress ?? 0`，
  而其余 4 处 blocked 写入点都写 `progress: 100`。

### 修复

- **单一派生源**：`src/plan.ts` 新增 `StatusEntry / Stats / DepartmentSummary / PlanSnapshot` 与
  `normaliseStatuses`、`deriveAggregates`、`derivePlanSnapshot`、`aggregateInvariantViolations`。
  规则写死在一个地方：未知状态降级为 pending、pending 强制 `progress=0` 且清空 `childId/startedAt/finishedAt`、
  done 强制 100、进度加权 done=100、blocked/in_progress=自身进度的 clamp、pending=0。
- **删除 `record.stats`**：`src/runtime.ts` 移除全部写入与读取点（16 处），`serialisePlan` /
  `buildRoundResult` / `dispatchTool` / `updateStatus` / `cancelPlan` 全部改为「先派生一次，再用同一个快照填字段」。
  `grep 'record.stats' src/runtime.ts` 现在只剩一条注释。
- **状态机收口**：预算用尽重置改为逐项 `applyStatus(..., { status: 'pending', error: '本轮预算用尽，等待续跑' })`；
  `applyStatus` 的 pending 分支同时清空 `progress/startedAt/finishedAt/childId`（保留显式传入的 error）。
- **blocked 统一为 100**：异常收敛分支与其余写入点对齐，同一失败不再有两种进度。
- **构建卫生**：`build` 先 `rm -rf dist`、`test` 先 `rm -rf dist-tests`，并新增 `clean` 脚本。
  旧编译物残留曾让 `npm test` 报 `ERR_MODULE_NOT_FOUND ... dist-tests/src/state.js`（本次已实测复现并修掉）。
- **移出失控产物**：子 Agent 遗留、未被任何生产代码引用的 `src/state.ts` 与 `tests/state-machine.test.ts`
  移到 `docs/design-proposals/` 作参考（它与 `applyStatus` 重复实现同一语义，接入即再造双真相源）；
  `docs/design-derived-counts.reference.ts` 在设计落地后删除，`scripts/prove-derived-counts.ts`
  改为直接导入 `src/plan.ts`，杜绝「设计与实现各算一套」。

### 验证

- `npm run check`：exit 0。
- `npm test`：**90 / 90 通过**（79 项原有 + 11 项新增 `tests/derived-counts.test.ts`）。
  新增用例含**变异测试**：手工把 `stats.done +1`、`total +1`、`pending -1`、`progress=101`、部门 `done/total`
  改坏，不变量检查器必须报错——证明断言有效，而不是复述当前行为。
- `node --experimental-strip-types scripts/repro-inconsistent-counts.ts --expect-fixed`：**全部不变量 PASS**
  （场景 A 顶部 2 完成 / 1 正在做、卡片 70% / 正在做 1 / 待做 0、甜甜圈 67；场景 B 暂停项 `progress=0`、
  `childId=null`、`stats.progress=0` 与甜甜圈一致；场景 C resume 后 blocked=0）。
  同一脚本的默认模式（断言旧缺陷存在）现在 12 条全部失败——符合预期，缺陷已被消除。
- `node --experimental-strip-types scripts/prove-derived-counts.ts`：13 条断言全通过，含 500 组随机状态序列的
  不变量与幂等检查。

### 兼容性

- 对外载荷字段不变：`statuses`、`stats`（`total/done/blocked/inProgress/pending/progress`）、
  `departments` 同名同义；工具 JSON Schema 未改。
- `stats` 数值语义修正后可能与 1.4.2 的历史数字不同（这正是缺陷修复本身），旧结果消息仍可回放读取。
- `src/plan.ts` 的 `computeStats()` 保留为 `derivePlanSnapshot()` 的**别名**（标注 `@deprecated`），
  外部调用者不需要改动即可获得正确结果。

### 回滚

**1.4.3 是本项目首次公开发布**，更早的 1.0.0–1.4.2 只在本地开发，没有发布到 npm，也没有对应的 git 标签，
因此公开仓库里没有 1.4.2 的可回滚版本。如果你是从本地开发副本升级上来的，回滚到升级前那份副本即可：

```bash
npm ci && npm test        # 回到升级前的行为，先确认它仍然可构建、测试通过
dsh plugin --profile web add /path/to/the/older/copy
```

已安装的运行实例需要重启 DSH（或重新加载 `web` profile）才会使用本版代码。

## 1.4.2 — 2026-10-27

运行态验收（用户重启后的真实页面复核，7 个子任务）驱动的一轮修正，全部为**可复现证据**下的收口。

- **图表文字在浅色主题下几乎不可见（1.14:1）**：取色用了 `getComputedStyle(document.documentElement)`，而 `--dsw-alias-*` 主题变量由主题包定义在 `<body>` 上，`<html>` 读不到自定义属性时返回空串，于是恒回退 `#e2e8f0` —— 白底上仅 **1.14:1**（WCAG 要求 ≥4.5:1）。改读 `document.body` 后实测 **17.43:1（浅）/ 15.01:1（深）**。这是本轮唯一的功能级缺陷。
- **两处「完成率」口径打架**：图表按**计划数**算（1/7 → 14%），组头摘要按**工作项**算（1/2 → 50%），同屏两个百分比互相打脸。修正：图表标题写明「两类计划数量占比」「进行中计划完成度（按工作项）」，口径写进标题，不再靠读者猜。
- **「进行中」一词自相矛盾**：组头摘要原写「进行中 N」，而 N 实际是「未完成件数」（含还没开始的），与同一按钮 aria-label 里的「正在做 0 件、还没开始 3 件」冲突。改为 **「未完成 N / 已完成 M（完成率 x%）」**，与 aria 三态明细口径一致。
- **主题切换后图表文字不变色**：`ink` 只在建图那一刻读取一次，切到深色主题后图表文字仍是浅色主题的颜色。改用 `MutationObserver` 监听 `body` 的 `data-ds-dark-theme` 属性重建图表（零依赖），切换主题即刷新文字色。
- **自动展开（设计稿 §7.3 补齐）**：①最后一个进行中任务完成时，已完成组自动展开一次；②用户正展开的卡片被移入已完成组时，该组自动展开。依赖均为布尔值，4 秒轮询不会反复弹开。

- **小字对比度未达标（2.77 / 2.80:1）**：18px 统计数字与 12px 状态胶囊直接用了品牌色，白底上只有 2.80:1（橙）/ 2.77:1（蓝），低于 WCAG 4.5:1。改为主题自适应混合色 `color-mix(in srgb, 品牌色 70%, 主文本色)`：浅色实测 **#b35616 4.93:1 / #0e79a9 4.85:1**，深色 **#f99c5b 7.82:1 / #55beee 7.86:1**，色相保留。
- **环形图弧线深色主题失效**：`--dsh-wp-done-ink` 硬编码 `#0284c7`，对深色底约 2.4:1；改挂同一个自适应色。
- **焦点环 2.66:1**：组头按钮 `:focus-visible` 用 `--dsh-wp-done`；改为主文本色（浅 18.12 / 深 16.30）。
- **首屏看不到任务卡（已按用户选择 B 修完）**：`GroupCharts` 两张卡各约 246px、总览块（完成率环 + 每计划进度条）也排在两组之前，首屏被三块内容占满。现顺序为：5 格数字统计条 → 一行口径说明 → 「进行中」组 → 「已完成」组 → 总览块 → 两张图表。打开面板第一屏即是进行中任务卡，所有图表下移到两组之后。
- **旧浏览器兜底**：`color-mix` 在 Safari <16.2 / Chrome <111 不可用，原写法会让 `--dsh-wp-done-text` 成为无效值。改为先声明主文本色兜底、再用 `@supports (color: color-mix(...))` 覆盖，旧浏览器只丢色相、不丢可读性。
- **宿主元数据版本滞后**：`src/host.ts` 与 `lib/host.js` 仍写 `1.4.1`，与 `package.json` 的 1.4.2 不一致；已同步为 1.4.2。
- **条形图静默吞掉第 7 个及以后的计划**：`groups.live.slice(0, 6)` 截断后没有任何提示，读者会以为图里就是全部。改为在图表下方注明「另有 N 个进行中计划未画入图表」（中英双语，零新增依赖）。
**验证**：`npm test` **79/79 通过**；`npm run build` 无 TS 报错。

## 1.4.1 — 2026-10-27

「一目了然 + 精美绝伦」的收口版本。1.4.0 存在的问题全部由本轮的**实测证据**驱动修正。

- **致命缺陷修复：图表永远不出现**。1.4.0 用 `chartState === 'ready'` 门控 `<canvas>`，而 `chartState` 只有建图成功后才置 `ready` —— 无 canvas 就不建图、不建图就不 ready，形成死循环。只读渲染探针实测：`canvasNodes: 0 / fallbackBars: 1 / liveBarTitle: 0`。改为 **canvas 与 fallback 并存**（ready 前 fallback 可见、ready 后 CSS 互斥隐藏），修复后同一探针：`canvasNodes: 2 / liveBarTitle: 1`。
- **对比度达标（WCAG AA）**：组头计数徽章原为 12px 白字压在橙/蓝硬编码渐变上，实测 **2.26–2.80:1（进行中）/ 2.14–4.10:1（已完成）**，全部不合格；组头副标题 tertiary 实测 3.56:1 也不合格。改为「主文本色 + 半透明品牌底 + 1px 内描边」，品牌色只做底与描边。组头标题实测 **18.15:1（浅）/ 16.28:1（深）**，本就合格，保持主文本色。
- **组头完成度摘要**：新增 `groupSummary` / `groupSummaryNoRate` 与 `groupAria` 文案，组头以纯文本给出「进行中 N / 已完成 M（完成率 x%）」，分母为 0 时输出「完成率暂无数据」而非 NaN；读屏可完整念出计划数、件数、完成率与三态明细。折叠态同样可读。
- **折叠保留 DOM**：折叠走 `hidden`（布尔 true，不是空字符串）+ `--folded` CSS 类隐藏，卡片节点不卸载；`aria-expanded` / `aria-controls` 指向真实存在的节点。
- **HTML 内容模型修正**：折叠态组头是 `<button>`，原 `<h2>` 嵌在按钮内不合法；改用 `<span role="heading" aria-level="2">`，文档大纲语义不变。
- **视觉精修**（只加细节，不改结构）：组左栏 3px 竖向渐变强调条（位置+形状编码，非颜色唯一）、卡片内阴影与顶部高光、组头悬停反馈、图表标题色块、数字统一 `tabular-nums`；装饰性动效全部在 `prefers-reduced-motion` 下关闭。

**验证**：`npm test` **73/73 通过**（T5/T6 新增 6 例）；`npm run build` 无 TS 报错；渲染探针见上。

**未验证**：真实浏览器目视、窄侧栏换行、深色模式观感 —— 需重启 `dsh web` 后人工确认。

## 1.4.0 — 2026-10-27

侧栏「任务进度」一眼分清「进行中 / 已完成」。（用户确认口径：严格两组；允许引入图表库。）

- **分组**：面板改成两组 —— 「进行中」（橙色，左侧橙色竖条 + 呼吸圆点）与「已完成」（蓝色）。判定只认 `phase === 'done'` 进「已完成」；`blocked / degraded / paused` 置顶并显示「需处理 N」红色徽章；`planning / executing / integrating` 次之；`pending` 最后。已取消计划继续不显示（与 1.3.7 一致）。
- **图表**：引入 `chart.js@4.6.1`，以 `vendor/chart.umd.js` 随包分发（MIT，未走打包器——本插件客户端是手写的 `window.__ModuleLoader__` 模块工厂，无 bundler）。新增「两类任务占比」环形图（渐变）与「进行中计划完成度」横向条形图，均带数值与无障碍标签。
- **折叠**（对齐设计稿 `docs/status-grouping-ia.md` §6.4 #1/#6）：存在进行中任务时，「已完成」组默认折叠（组头可点、`aria-expanded` 同步、chevron 形状编码），避免历史任务抢走视觉权重；无进行中任务时默认展开。折叠态只在本组件内存里，不写偏好，刷新即回默认。
- **降级**：图表脚本未加载或宿主未重启时，首帧即渲染纯 CSS 双色占比条＋图例，不出现空画布；`prefers-reduced-motion` 下关闭动效与脉冲。
- **宿主**：新增只读路由 `/dsh-workplan/vendor/chart.umd.js`（`text/javascript`，1 小时缓存）；其余路由、工具、数据结构一字未动。
- **兼容修复**：`GroupCharts` 原用 `useRef`，而宿主注入的 React 兼容层未提供该 hook，`npm test` 实测抛 `TypeError: useRef is not a function`（3 个渲染用例失败）。改为「状态即 ref」（`useState` + 回调 ref，节点变化才更新），不再依赖 `useRef`；改后 `npm test` **67/67 通过**。
- **未验证**：本版本只完成编译与产物校验（`client.js` 含分组/图表/降级标记，`lib/host.js` 版本为 `1.4.0`）。**真实界面渲染需重启 `dsh web` 并刷新页面后才能看到**，尚未做视觉走查与浏览器截图验证。

## 1.3.7 — 2026-10-26

真机重启后当场复现，1.3.6 只修了一半。

- **复现**：重启后派发旧计划 `wp-8bc5c900`，返回 `Error: planId 与当前计划不匹配`。
- **根因**：1.3.6 只在「内存里没有记录」时重建。但重启后下一个回合的规划器会立刻生成新计划，内存马上就有一条别的计划记录，于是 `if (!record?.plan)` 为假，重建根本没跑，直接落到 planId 比对失败。重启窗口里内存为空的状态只存在几秒，实际用户永远撞不到那一半。
- **修复**：`dispatchTool` 现在在「内存无记录」**或**「调用方点名了另一份计划」时都重建（重建期间有派发在跑则不动），按 planId 从会话存档精确取回。点名一份存档里存在的计划，任何时候都应可派发。
- **验证**：新增用例「内存里是另一份计划时，按 planId 派发旧计划照样重建并继续跑」；`node --test` **67/67 通过**。用真实会话存档（2677 条事件）重放：不传 planId → 最新计划 `wp-0fd49b2d`、`pending`；传 `wp-8bc5c900` → `paused`、9 完成 / 2 未完成（T10、T11）；传不存在的 planId → `null`。

## 1.3.6 — 2026-10-26

真机重启后暴露的新缺陷：**重启前暂停的旧计划会变得不可派发**。

- 现象（代码推定 + 单测复现）：`reconstructFromSession` 只回放“最新那条计划消息”。重启后下一个回合自动生成了新计划，此时再派发重启前那份暂停计划，重建得到的是新计划，`dispatchTool` 随即抛 `PLAN_ID_MISMATCH`。磁盘上还有未完成的工作，却没有任何入口能继续它——又是一种“卡死”。
- 修复：`reconstructFromSession(session, targetPlanId?)` 现在为每条计划保留一份快照（状态、`resultPhase`、`resumeCount`、取消标记），派发时按 `planId` 精确取回；不传 `planId` 时行为不变（仍取最新计划，仪表盘语义不变）。
- 测试：新增「重启后仍能派发重启前暂停的旧计划」用例（两条计划在会话里、记忆为空、派发旧计划并跑完待续子任务）。`node --test` **66/66 通过**。

## 1.3.5 — 2026-10-26

真实进程（PID 7752，1.3.4）11 子任务派发：**完成 9、受阻 0、待续 2**，`phase: "paused"`、`resumeAvailable: true`、`errors` 只有一条预算说明——暂停语义与载荷字段在 1.3.4 真实进程再次成立。同一轮子任务查出两个真问题：

- **调用点变异存活（T4 实测）**：把 `buildRoundResult(record, …)` 改成 `buildRoundResult({ ...record, phase: undefined }, …)`，65/65 仍然全绿——所有用例都直接调函数本体，没有一条断言「session 里真正追加的那条结果消息」。现补端到端断言：重启重建用例派发后从会话取出 `workplan-result` 消息，断言 `phase === 'integrating'` 且键存在。同一变异现在会让用例变红（实测 64 pass / 1 fail）。
- **修复点 1 尚未在真实进程被触发（T7 实测）**：本轮派发对象是重启**之后**新建的计划（20:54:05 建、进程 20:48:23 启动），内存本来就热，`if (!record?.plan) reconstructFromSession(...)` 分支根本没进入。时间线证明「没报 NO_PLAN」≠「重建生效」。该修复目前仍只有代码 + 单测证据，需「先建计划、后重启、再派发」才能验证；验证动作安排在下一轮。
- **修复点 2 已取得运行时证据（T8）**：用真实事件流 + 进程实际加载的 `lib/runtime.js` 重放 20:54:18 派发边界 → 新计划 `phase: pending`、`resumeCount: 0`；把同一事件流喂给「删掉重置三行」的对照产物 → 立刻退回 `phase: paused`、`resumeAvailable: true`。对照组精确复现旧症状，说明这三行是承重的。
- **文档事实核对（T2）**：`plugins/.backups/dsh-workplan-1.3.4-20261026-2042.tar.gz` 文件名写的 20:42，文件系统记录的创建/修改时间是 20:32:15（构建窗口 20:32:07），命名与实际落盘时间不一致；内容本身与当前磁盘树逐字节相同（`lib/host.js` sha256 `3eea645b…`）。此处仅记录事实，不改写历史快照。

测试：65 例全部通过，其中「重启重建」一例新增端到端载荷断言。

## 1.3.4 — 2026-10-26

真实进程（PID 96748，1.3.3）的 11 子任务派发结果证明 1.3.3 的三处修正全部生效：`phase: "paused"` 进了载荷、`resumeAvailable: true`、`errors` 只剩一条预算说明、**受阻 0 / 完成 9 / 待续 2**。同一轮的子任务又查出三个新缺陷，本版修掉：

- **暂停后重启 `dsh web`，计划再也派发不了**：`dispatchTool` 只读内存记录，重启后内存为空就直接报 `NO_PLAN`「当前会话没有可派发的计划」——而卡片还在界面上。用户照我们的话重启一次，就把可续跑的计划变成了永久不可续跑。现在派发前会 `reconstructFromSession` 从会话存档重建记录并登记回内存。
- **上一份计划的暂停会污染下一份计划**：`reconstructFromSession` 的 `resultPhase` 在新计划消息到达时没有清零，于是同一会话里新建的计划在首次派发前就显示「预算用完」。现在新计划到达时重置 `resultPhase`/`resultSeen`/`resumeCount`。
- **结果写入处的接线没有测试**：1.3.3 的变异测试（B2：把 `phase: record.phase` 改成 `undefined`）存活，62 个测试全绿——没有任何用例覆盖调用点。现在结果消息构造抽成导出的 `buildRoundResult(record, sessionId, limits)`，并新增用例；同一变异现在会让测试变红（已实测）。

测试：新增 3 例（结果载荷必须携带阶段、新计划不继承暂停、重启后派发自动重建计划），全量 **65/65 通过**。

## 1.3.3 — 2026-10-26

真实进程（PID 29790，1.3.2）端到端派发已证明「预算到点 = 暂停而不是失败」：8 个子任务完成 4 个、**受阻 0 个**、其余 4 个保持 pending，面板显示「本轮预算用尽，可续跑」，没有再出现级联受阻。本轮派发又暴露三处收尾缺陷：

- **暂停计划被说成“不可续跑”**：`canResumePlan` 只认 `blocked`，而暂停留下的是 `pending`，于是载荷里 `resumeAvailable: false`，卡片提示「自动续跑额度已用尽，需要主 Agent 直接接手」——与事实相反（再派发一次就能继续）。现在 `paused` 也算可续跑，且暂停不消耗续跑额度（它是时间切片，不是返工）。
- **结果消息不带阶段，刷新后暂停会被回放成“正在做”**：结果载荷缺 `phase` 字段，`reconstructFromSession` 只能猜 `executing`。现在结果消息写入本轮 `phase`，刷新后原样回放 `paused`。
- **暂停仍把被杀子任务的「总执行超时」写进失败清单**：面板虽然显示正常，但载荷 `errors` 里留着 `["T4: 总执行超时", "总执行超时", …]`，模型会读成“有失败”。现在预算分支会剔除这些超时行，只保留「本轮执行预算（N 分钟）已到……」这一条说明。

测试：新增 3 例（暂停后可续跑且不扣额度、结果消息往返携带阶段、失败清单不含超时），全量 **62/62 通过**。

## 1.3.2 — 2026-10-26

真实进程（PID 24118，1.3.1）端到端派发暴露的剩余缺陷，全部来自“计划总预算”这条路径：

- **20 分钟总预算把正常长任务判成失败**：T1 真实跑了 840 秒才完成（1.2.1 的 300 秒上限下必死），T2 137 秒，随后总预算到点，正在跑的 T3 被记为「总执行超时」，T4–T9 级联受阻，面板再次显示「0~2/N 做好了、N 卡住了」。
- 修复：预算到点不再算失败——未完成子任务保持 `pending`（已完成的不重跑），计划阶段标记为新 `paused`，错误文案写明「本轮执行预算（N 分钟）已到：已完成 X/Y，其余 Z 项保留为未完成，再次派发即可续跑」。
- 面板与工具输出支持 `paused`：中文「预算用完，可续跑」（warn 色，不显示为「卡住了」），刷新后仍保持该阶段（按结果消息回放）。
- 自动续跑额度 2 → 4：一次派发最多 20 分钟，慢计划分多轮续跑，避免一整条计划被 20 分钟卡死。
- 规划器约束：子任务不得写「调用 dsh_workplan_dispatch / 重启或停止 dsh web / 安装升级插件」这类只有主 Agent 能执行的动作（本轮 T3「执行真实派发」对子 Agent 根本不可执行，必然失败）；单个子任务应在 10 分钟内完成。
- 子 Agent 提示：明确“没有派发权限、不能重启服务”，遇这类步骤直接说明需要主 Agent 执行，禁止空等。

## 1.3.1 — 2026-10-26

让「卡住了」变成一个看得懂、走得通的提示，而不是死路。

- 仪表盘在受阻计划上直接给出续跑指引：`对主 Agent 说「续跑这个计划」，会从受阻处继续（已完成的不重跑）`，并显示剩余额度（如「还可续跑 2 次」）。
- 续跑额度用尽时，文案改为 `自动续跑额度已用尽，需要主 Agent 直接接手完成`，不再只显示「卡住了」。
- **修复假取消**：超过 10 分钟未派发的计划原先会被重新标记为 `cancelled`，而 `cancelled` 永远不可续跑——一张没人动过的计划会自己「死掉」。现在保持 `pending`，只额外给出 `stale: true` 标记，提示而不是关死。
- `reconstructFromSession` 的载荷补上 `resumeLimit`，与实时计划保持一致。
- 新增 `tests/client-resume-hint.test.ts`（3 个用例）：有额度、额度用尽、pending 不被误显示为已取消。

## 1.3.0 — 2026-10-26

卡住（stuck）问题的系统性修复。所有改动都对应 1.2.1 及更早版本中可复现的“计划卡住”路径，回归测试见 `tests/workplan-stuck-recovery.test.ts`。

### 根因与修复

1. **固定 300 秒墙钟杀死了健康的子任务**（历史证据：22 次 `子任务 T? 超时（300000ms）`）。
   - 现在把“绝对上限”和“无进展窗口”分开：默认绝对上限 900 秒（可配置 1s–30min），无进展窗口默认 300 秒（可配置 1s–15min）。
   - 只要子 Agent 的会话日志还在增长，就不算卡住；只有日志停止增长才判定 wedged。
   - 新增 `src/watchdog.ts`（`pickTimeoutReason` / `createProgressWatchdog`），轮询间隔自动按窗口长度缩放。
   - 无进展导致的失败会自动重试一次（换一个新的子 Agent），达到绝对上限则不重试，避免烧掉整份计划预算。

2. **重新派发受阻计划是“假成功”**（历史证据：约 12 次 dispatch 完成 0 个子任务）。
   - 以前所有子任务都是 `blocked`，`readySubtasks()` 返回空，派发器直接 `ok: true`，模型以为成功，计划再也动不了。
   - 现在 `canResumePlan()` / `resetBlockedStatuses()` 支持从受阻处续跑：只重置受阻/进行中的子任务，已完成的不重跑，每份计划最多续跑 2 次（可配置 0–5）。
   - 续跑额度用尽时 `dsh_workplan_dispatch` 返回 `ok: false` + 明确原因 + `hint`，让主 Agent 直接接手，而不是重复派发。
   - 取消（cancelled）的计划永不被自动续跑。

3. **执行中不能取消**（`计划正在执行，不能取消`）。
   - 现在取消会中止正在运行的派发：`abortedRunning: true`，计划进入 `cancelled`，在途结果仍会写成 durable 消息。

4. **`dispatchPromise` 永挂后永远回答 already running**。
   - 超过“计划预算 + 120 秒”仍未返回时，派发工具返回 `ok: false`、`stale: true`，并提示主 Agent 直接接手，不再无限 wait-for-success。

5. **`[object Object]` 取代真实错误**（历史证据：1 次）。
   - 新增 `describeError()`，把 Error / 字符串 / 嵌套对象信封 / Envelope 文本统一渲染成可读文字；`record.errors` 与子任务 `error` 全部走它。

6. **缺少元数据直接炸掉子 Agent 提示词**。
   - `buildChildPrompt()` 对 `taskUnderstanding` / `contradictions` / `method` 等字段做了防御性读取；以前重建或旧版本计划缺字段会让每个子任务瞬间失败、整份计划被判受阻。

7. **构建产物漏拷 `watchdog.js`**：`npm run build` 之后 `lib/` 缺少新模块会直接导致插件加载失败，构建脚本已修正。

8. **续跑后不再写 durable 结果消息**：续跑会清除 `resultWritten`，保证刷新页面后看到的是最新结果，而不是旧的受阻快照。

### 可观测性

- 结果消息新增 `resumeCount` / `resumeAvailable`，并直接告诉主 Agent「可再次 dispatch 续跑（剩余 N 次）」或「额度已用尽，请直接接手」。
- 仪表盘 payload 新增 `heartbeatAt`、`resumeCount`、`resumeLimit`、`resumeAvailable`、`dispatchElapsedMs`。
- 派发工具的渲染文本会带出 `仍在执行（已 Ns）` 与失败时的「下一步」提示。

### 可配置项

| 配置键 | 环境变量 | 默认 | 范围 |
| --- | --- | --- | --- |
| `childTimeoutMs` | `DSH_WORKPLAN_CHILD_TIMEOUT_MS` | 900000 | 1000–1800000 |
| `idleTimeoutMs` | `DSH_WORKPLAN_IDLE_TIMEOUT_MS` | 300000 | 1000–900000 |
| `totalTimeoutMs` | `DSH_WORKPLAN_TOTAL_TIMEOUT_MS` | 1200000 | ≥ 60000 |
| `maxResumes` | `DSH_WORKPLAN_MAX_RESUMES` | 2 | 0–5 |

### 测试

- 新增 `tests/workplan-stuck-recovery.test.ts`（11 个用例）：续跑判定、状态重置、结果文案、超时分类、watchdog 增长/停滞、错误渲染、端到端「停滞→受阻→续跑→完成」、额度耗尽、执行中取消、陈旧派发。
- 全量 `npm test`：51 个用例全部通过。

## 1.2.1 — 2026-10-26

- “做好了/已完成” now uses sky blue (`#0ea5e9`); “正在做” uses orange (`#f97316`) across the summary strip, donut, legend, task bars, mini bars, cards, pills and tool-turn accents.
- Other status colors (blocked/pending) are unchanged; no layout, interaction or dependency changes.
- Added a static regression test for the two status color mappings.

## 1.2.0 — 2026-10-26

- Task progress rows in “每个任务的进度” are now buttons: one click expands the matching task card and scrolls it into view.
- Task cards expose a stable DOM anchor; scrolling uses `scroll-margin-top` so the fixed header does not cover the title.
- Keyboard users can Tab to a task row and press Enter/Space; focus moves to the expanded card.
- No new dependency; theme tokens and responsive layout are unchanged.

## 1.1.1 — 2026-10-26

- Plan mode no longer skips decomposition. The plugin now generates a plan in plan mode and explicitly defers dispatch until the user leaves plan mode.
- While plan mode is active, only `dsh_workplan_dispatch` is denied, with a clear reason; every other tool stays available, so there is no guard deadlock.
- A plan produced in plan mode is preserved across turns instead of being cancelled before the user can approve it.

# Changelog

## 1.1.0 — 2026-10-26

- Dashboard now shows a fifth `任务` cell in the circled summary strip, so the plan count is visible next to work-item and status counts.
- Added a status donut and per-task progress bars (SVG/CSS, no new dependency) for a more visual, less text-heavy overview.
- Added a compact progress bar to each collapsed task card, so progress is visible without expanding.
- Mobile: five-cell strip becomes a readable 2-column grid, with the task cell spanning the full width; the charts stack in one column.
- Version metadata is now `1.1.0` in the plugin manifest and host `meta`.

## 1.0.0

- Initial TypeScript implementation: pre-step task decomposition, real department subagents, durable plan/result messages, `dsh_workplan_update` / `dsh_workplan_dispatch` / `dsh_workplan_cancel`, and the responsive `任务进度` dashboard.

### 八、3.2.4 追加修复（2026-11-23 19:25，重启后验证中发现）

- **replan 新增/替换行补 `qualityRequirements` 透传（治本死局）**：`src/replan.ts` 的 `newSubtask` 构造器与 `REPLACEMENT_FIELDS` 都不含质量要求字段，而 `src/plan.ts:1457-1458` 规定「激活时刻之后的新计划必填质量要求，缺失即拒发 `DISPATCH_QUALITY_REQUIREMENTS_MISSING`」。两条规则叠加成死局：**任何经 replan 建出来的新行都必然被派发门禁拒发，再 replan 一次也补不上——因为构造器根本不读这个字段**。现场由 `wp-32bee059` 的 T6 实测复现。修复：`add` 与 `replace` 两条路径都收 `qualityRequirements`，统一经 `normalizeQualityRequirements`（去空、去重、≤8 条、每条 ≤400 字）消毒；`replanner` 入口 `replanFieldError` 增加同口径校验；`src/host.ts` 的 replan 工具 schema 在 `newSubtask` 与 `replacement` 两处暴露该字段。缺失时不静默造一条假要求，仍由既有门禁照旧拒发——「没写」不伪装成「写了」。
- 关联诊断报告：`reports/wp-diagnosis-token-and-expert-stop-20261123.md`（token 构成实测、专家中断根因定位为 verify 参数 JSON 缺根对象右花括号、T4/T5 专家产物清单、6 条优化建议）。

### 九、3.2.4 第二轮追加修复（2026-11-23 19:40，按诊断报告建议逐条落地）

诊断报告 `reports/wp-diagnosis-token-and-expert-stop-20261123.md` 的 6 条建议中，第六条（replan 补 qualityRequirements）已在第八节修复，本节落地其余可执行项：

- **H1 异常终止时把「已落盘产物」写进台账 `error`**（建议 3）：新增纯函数 `failedErrorWithHarvestNote(text, cwd, member)`（`src/runtime.ts`，紧邻 `probeDelegateLandedArtifacts`），在两处成员结算点（self_effort 接续结算、部门派发成员结算）替换原来的裸错误文案。缺陷现场：专家会话以 error/中断结束，台账只写「子会话结束状态 error」，主 Agent 与负责人看不到产物其实已写好，只能整层重跑——同一份工作付两次钱。终止通知本来就带 `landedRefs`，但负责人会话已释放时无人接收；台账才是唯一可靠留痕通道。不新增字段、不改白名单、不动 durable 兼容性（仍 ≤300 字）。
- **H2 产物根目录单一化**（建议 4）：部门任务书（`src/plan.ts` 的 `buildChildPrompt`）、专家任务书与 phase-0 任务书（`src/llm-rules.ts`）统一写入硬约定「产物根目录（唯一，强制）：<工作目录>/reports/；不要写进任何子仓库（例如 plugins/…）」。缺陷现场：同一子任务的 8 名专家把产物分散写到 `reports/` 与 `plugins/dsh-workplan/reports/` 两处，机制都能找到，但人核验要在两个目录之间来回翻，且说不清哪份是正式产物。根因不是路径解析，是任务书从未规定唯一产物根。
- **H3 分批派出软约束**（建议 5）：部门负责人强制流程新增一条「专家多于 5 名时每批 ≤5 名」。宿主子代理并发位是整个会话树共享的，一次推满会让队尾成员在本轮 120 秒排队预算内起不来，导致本轮整轮判为 `CHILD_NOT_COMPLETED`、已完成成员无人结算（T4/T5 两次现场）。
- **H4 工具参数 JSON 纪律与兜底**（建议 2）：专家执行要求新增一条——`dsh_workplan_verify` 参数只写必要字段（每条 ≤200 字、每数组 ≤20 条），不拼接长字符串、不手写超四层嵌套；若被宿主以「参数 JSON 非法」拒绝，**不要原样重试**，直接在正文给出结果块交卷（结算读的是正文证据块，verify 只是自检通道）。宿主侧解析器不能由插件改，这是插件侧唯一能真正止损的路径。缺陷现场：会话 `93fc515d` 的 verify 参数在第 3293 字符结束，根对象少一个右花括号，整轮以 error 收尾。
- 建议 1（把 token 预算换成步数预算）**本轮未做**：属于新的调度机制，需要与宿主 tokenMeter/中断语义重新对齐，风险高于本轮收益；现状已在诊断报告中给出实测口径（步数 124 vs 13 ⇒ 合计 token 差 25 倍），可作为下一轮独立设计。
- 尺寸影响（`scripts/measure-injection.mjs`）：`leaderTaskBook` 7,081 → 7,218，`expertTaskBook` 3,276 → 3,585，`delegate` 工具 3,980（仍 ≤4,500 上限），`replan` 工具 2,044 → 2,327（新增 qualityRequirements 参数）。

### 十、步数预算（3.2.4 追加实现，2026-11-23 20:10；用户指定继续推进此前推迟的建议 1）

- **定位**：诊断报告第二节实测，合计 token 与步数近似线性（124 步 ⇒ 1,326 万；13 步 ⇒ 54 万；95% 是同一段对话被反复重读）。控钱的第一杠杆是步数。但直接加「步数上限」会与已冻结的「专家执行没有总时长、单次时长、空闲或回执硬截止」契约冲突。
- **实现（`src/step-budget.ts`，新模块）**：结算时（settle-time）口径，**绝不中断回合、绝不把成功改判失败**——
  - 默认开启：软 60 步 / 硬 75 步（`DSH_WORKPLAN_STEP_BUDGET` 正整数 n ⇒ 软 n/硬 ceil(n×1.25)；`0|false|off` ⇒ 完全关闭；非法值 ⇒ 默认）；
  - 结果为 done 且步数 ≥ 软上限 ⇒ 仅 console.warn 留痕，不改状态；
  - 结果为 done 且触线 ⇒ durable 台账消息附「步数台账：…共 N 步（软 M/硬 K）——已结算成功，仅留痕供下一轮参考」；
  - 结果不是 done ⇒ 失败 error 追加「步数预算：本会话 N 步（软 M/硬 K，超硬上限时标注），已落盘结算备份…」，让重派决策有据可依（与 3.2.4 的产物收编说明同段）；
  - 会话取不到 ⇒ 计 0 ⇒ 无操作（fail-open）。
- **接线点**：两处第三层成员结算（`src/runtime.ts` self_effort 接续结算 + 部门派发成员结算）；专家任务书新增一条透明告知——措辞按实现事实写：**执行中没有任何到点催促、不中断、不因步数判失败**，只说明「每多一步整段对话重读一遍」的成本事实，并明确**禁止为省步数削减证据、跳过验证或提前交卷**（门禁不因步数放宽，交薄只会被退回重做，反而更贵）。
- **诚实边界**：这不是运行中击杀——插件无法安全中止宿主子会话（拿不到它的 abort 信号），v1 的硬上限只在结算时留痕，不做中途截停。运行期的实际成本控制仍靠「每批 ≤5 名」与任务书指引。
- **测试**：新增 `tests/step-budget.test.ts` 8 例（解析表、判定边界、计数器 afterSeq/countCap/fail-open、失败上下文拼接、环境变量名防漂移），全绿。

### 十一、构建指纹覆盖全部已加载模块（治本，2026-11-23 20:32）

- **缺陷**：`src/host.ts` 的 `LOADED_BUILD` 只哈希手写的四个文件（`host.js / runtime.js / plan.js / watchdog.js`）。这正是它自己 docblock 里 `[1.8.15]` 记下的那类假阴性——「模块被加载、被修改，指纹却不变」。3.2.4 新增 `step-budget.js` 之后同一个洞又开了一次：`status` 报出的 `build` 值无法证明「跑的是哪几份 step-budget 字节」。
- **修复**：改为**按目录枚举**所有 `.js` 模块（排序后逐个入哈希），磁盘上多一个、少一个、改一个，指纹必然变化，不再依赖有人记得维护清单。排除 `client.js`：它是浏览器端 bundle，宿主进程从不加载，且生产布局里位于包根目录（不随 `lib/` 落盘）——算进来会让 `dist/` 与 `lib/` 枚举出不同集合，指纹反而取决于「从哪里加载」。枚举失败（沙箱限制、非常规打包布局）才回退到关键入口清单，仍然 fail-open，绝不因算指纹阻断激活。
- **覆盖范围**：`lib/` 下 22 个模块全部入哈希（含 `step-budget.js`）；当前磁盘复算值 `b086d3b822d4bbdf`。
- **回归**：`tests/step-budget.test.ts` 新增第 9 例「build 指纹覆盖全部已加载模块（含 step-budget.js）」——断言 `src/host.ts` 含 `readdirSync(dir)` 与 `name !== 'client.js'`，并断言 `lib/` 枚举集合包含 `step-budget.js`、`host.js`、`runtime.js`；将来再新增模块被漏掉时这条会失败。

### 十二、静态优先重排：让同部门专家的提示词共享前缀（纯省钱，质量零改动，2026-11-23 21:30）

- **缺陷（实测）**：每名专家的任务书**第一行就写着成员名**、第二三行写着各自任务，8 名专家的提示词从第 1 个字就分叉。实测旧布局的共享前缀只有 **24 字符**——等于每人每次都要把同一份五步协议、执行要求、汇报规范按全价重新买一遍。而 95% 的会话 token 花在「同一段内容被重复读」上，缓存命中是唯一不牺牲质量的省钱手段。
- **修复**：`buildDelegateePrompt` 与 `buildPhaseZeroDelegateePrompt` 改为**静态优先**——静态头部（部门名）→ 五步协议 → 执行要求 → 汇报规范 → 【你的分工】（成员名/负责人任务/你的任务/工作目录/产物根/质量要求/重试简报/规则摘要）。**内容一字未删，只换位置**。
- **实测收益**（8 名同部门专家）：
  - 专家任务书 4,870 字符，两两最小共享前缀 **3,678 字符 ≈ 2,164 token（75.5%）**，此前 ≈24 字符；
  - phase-0 任务书 1,366 字符，共享前缀 **1,137 字符 ≈ 669 token（83.2%）**。
  - 含义：缓存可命中的部分从「0」变成「四分之三以上」，且同一批专家的前缀完全一致——供应商侧前缀缓存（OpenAI 自动前缀缓存 / Anthropic cache_control）才有机会命中。命中与否仍取决于供应商，但**共享前缀是必要条件**，现在具备了。
- **质量零改动**：字句未变、门禁未变、五步协议仍先于执行要求（`tests/taskbook-static-first.test.ts` 4 例守门：共享前缀 ≥3000 字符、差异必须落在动态段内、五步先于执行要求、关键义务串零丢失）。
- **顺带**：`phases.verification.checks` 的提示从「只写已验证条目」改为「非必填——平台会用顶层 acceptance 逐条生成」，鼓励模型省略这段注定被平台重建的重复输出（**不改变**校验口径，`tests/token-economy-321.test.ts:220` 的「checks 可省略只应出现一次」守门仍通过）。
- **验证**：`npm run check` 无错；全量 **1503 通过 / 0 失败 / 0 取消**（+4 = 新增守门例）；`expertTaskBook` 3,889 字符、`leaderTaskBook` 7,293、`delegate` 工具 3,980（仍 ≤4,500）。


### 十三、3.2.4 第三轮追加修复（2026-11-23 21:50，产物路径双基座核对；现场 wp-bb6cee17）

- **缺陷（现场）**：T1/T2 已按任务书写完产物，结算却报「声明产物缺失/不存在」，依赖门把 11 个下游全部挡成 `blocked`，`dispatch` 零派发即返回「本轮预算用尽」，整份计划看起来卡死。结算 JSON 里 ref 写作 `T1/…`、`t2-closed-20261123/…`，真实文件在 `reports/T1/…`、`reports/t2-closed-20261123/…`。
- **根因**：任务书（`src/plan.ts` 的 `buildChildPrompt`、`src/llm-rules.ts`）强制「产物根目录唯一：`<cwd>/reports/`，回报路径相对这个根目录写」；而 `src/runtime.ts` 的 `checkArtifacts` / `probeInterruptedArtifacts` / `fingerprintArtifacts` 只按 `<cwd>` 一个基座解析。基座不一致 ⇒ 真实产物被判缺失 ⇒ 依赖门（`runtime.ts:4334/4345`）级联挡死下游。不是子 Agent 写错，也不是依赖门策略错。
- **修复（只改解析，不改任何门禁语义）**：新增 `artifactPathCandidates(ref, cwd)`——绝对路径原样；相对路径先按工作目录（兼容旧回报），再按 `<cwd>/reports/`（现行契约），带 `reports/` 前缀的回报先剥前缀避免拼出 `reports/reports/…`，候选去重。`checkArtifacts`、`probeInterruptedArtifacts`、`fingerprintArtifacts` 统一走候选表，命中即算在盘；`resolveArtifactPath` 保留单基座语义，仅供 `sharedStateKeysForSubtask` 使用（计划声明的 outputs/inputs 是工作目录路径，不是子 Agent 回报，锁键口径不变，避免无谓串行）。
- **质量与成本**：提示词零字符改动（不增加任何输入 token）；只在首个基座未命中时多一次文件系统探测，token 计费面无变化；不新增字段、不改白名单、旧消息回放与 `strict:false`/`artifactGate:false` 回滚通道均不受影响。
- **回归**：新增 `tests/workplan-324-artifact-root.test.ts` 6 例（产物根相对路径、工作目录优先、`reports/` 前缀去重、绝对路径单次、正文产物识别、指纹双基座）；`tests/workplan-dependency-artifacts.test.ts` 的探测序列同步为双基座。全量 `npm test`：**1509 通过 / 0 失败 / 0 取消**。`lib/` 已重建（`npm run build`），宿主进程需重载插件后生效。
- **现场回填**：已用 `dsh_workplan_update` 把 T1/T2 的 `artifacts` 改登记为真实 `reports/…` 路径并置 `exists:true`、`missingArtifacts:[]`，计划已恢复；待运行中计划收尾后再移除临时符号链接（`T1`、`t2-closed-20261123`）。