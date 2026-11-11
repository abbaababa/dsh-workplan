# T2 草稿：CHANGELOG 2.3.9 段 + README×3 目标行对照（只读产出，供 T4 原子改版直接引用）

> 作者：T2 文档写作部门（资深技术文档专家）
> 盘点时间：2026-11-11T12:25:18+08:00（`date` 实测，非估计）
> 性质：**草稿**。本任务未修改任何声明位本体（package.json / package-lock.json / src/host.ts / lib / dist / README×3 / CHANGELOG.md / tool-surface fixture 全部原样）。
> 所有行号均为本次只读 grep/sed 实测现值；与旧清单 `reports/T5-version-bump-plan-239.md`（2026-11-11 00:12 盘点）相比，**src/host.ts 版本行已从 1584 漂移到 1724**（T4b 新增 createDelegateTool 等约 140 行所致），lib/dist host.js 从 1455 漂移到 1587。T4 执行时以本表为准，或执行前再 grep 复核一次。
> Hindsight 记忆检索：本工作区 Hindsight 已禁用（工具返回 "Hindsight memory is disabled for this workspace"），版本说明约定改以盘上 CHANGELOG.md 既有段落风格 + tests/version-sync.test.ts 断言为权威依据。

---

## 第一部分：CHANGELOG 2.3.9 段草稿（可整段粘贴到 CHANGELOG.md 第 1 行之前）

标题格式满足 `tests/version-sync.test.ts:39-43` 的正则 `^## 2\.3\.9 — `（必须有 `## <版本> — <日期>` 标题）。旧 `## 2.3.2` 段及其下全部历史段原文保留、禁改。

```markdown
## 2.3.9 — 2026-11-11

- **模型家族感知的推理等级约束（用户要求 1/2）**：单一事实源落在 `src/plan.ts`（`classifyModelFamily` / `QWEN_MODEL_EFFORTS` / `OTHER_MODEL_EFFORTS` / `COMPLEXITY_EFFORT_BY_FAMILY` / `effortForComplexity`）：qwen 开头的模型推理等级仅 low/medium/xhigh，其余模型仅 low/high/max；按复杂度配置——轻度=low，比较复杂的任务 qwen 系=medium、非 qwen 系=high，非常复杂的任务 qwen 系=xhigh、非 qwen 系=max。模型名未知 ⇒ 不施加静态约束（保持旧行为），但五档存储全集的枚举校验永不放松。
- **双轨执行闸（新增 `src/llm-rules.ts`）**：`validateReasoningEffort` 对集合外档位给出明确错误文案（报错轨）；`correctEffortForModel` 把越界档按强度序自动钳到集合内「不高于请求档」的最近档并留痕（修正轨），派发绝不因档位问题中断。时序：家族检测（入口）→ 静态集合收窄（本版）→ 宿主能力交集钳制（2.2.7 既有）→ 发送，两道闸各自留痕。规划器显式写出集合外档位由 `validatePlan` 拒绝并点名；派发前对每个子任务逐行钳制。
- **要求 1/2 全文全员告知（用户要求 3）**：`buildLlmRulesBrief` 是派发链路唯一注入事实源——二级部门任务书（`buildChildPrompt` 的 `llmRulesBrief` 参数）与三级专家/组员任务书（`buildDelegateePrompt`）共用同一文案，规则全文不可能在两处漂移；模型未知时如实写明「不施加静态约束」，不编造等级集。
- **部门负责人三层派发（用户要求 4/5，新工具 `dsh_workplan_delegate`）**：层级模型 主 Agent(depth 0) → 部门负责人(depth 1) → 顶尖专家/组员(depth 2，叶子层)。两步硬流程：`action="review"` 提交「全面梳理产物 + 分工表」（problemAnalysis 至少 1 条；assignments 必须同时含 ≥1 名 expert 顶尖专家与 ≥1 名 member 组员，最多 6 人，每位含 member/role/task/reasoningEffort）；未登记前 `action="dispatch"` 被硬门禁拒绝（DELEGATE_CONSOLIDATION_MISSING），门禁 durable 回放后依然生效。dispatch 为每位下级派生第三层子会话（spawn 传 maxDepth:2，第四层由宿主绝对深度上限硬拒），推理等级经 `planDelegations` 按当前模型家族合法集合钳制并留痕（clamped 列出 requested→corrected 与原因），随 agentOptions 下发、全生命周期生效；仍有下级 running 时重复 dispatch 被拒（DELEGATE_ALREADY_RUNNING）；下级结算后台账更新 done/failed，spawn 抛错的成员记 rejected 且不拖累其余成员。调用者硬校验：根会话 NOT_LEADER_SESSION（指引改用 dsh_workplan_dispatch）、第三层叶子 NO_PLAN/NO_SUBTASK（叶子层禁令）、childId 未登记 NO_SUBTASK、已完成行 ALREADY_DONE；`action="status"` 随时查看梳理登记与下级进度。
- **第三层台账面板可见**：客户端卡片渲染每位下级的姓名/角色（专家/组员）/推理等级（含越界钳制留痕）/实时状态/结论摘要（i18n 中英双语）；数据源 = 状态行 `delegates`（applyStatus 消毒 + durable workplan-update 回放），刷新/重启不丢，客户端不推导状态。
- **修复（根因族收口）**：qwen 系模型上越界推理档位导致派发即中断的问题（2.2.7 已修宿主能力钳制面），本版补上静态家族集合事前闸——越界档在请求发出前即被钳制修正或明确报错，不再落到宿主 `UNSUPPORTED_REASONING_EFFORT` 这类「本地失败、重试不会自愈」的中断。
- **测试**：新增 `tests/delegate-tool.test.ts`（14 用例：权限边界/梳理门禁/角色混合/双家族钳制/spawn 选项与任务书/重复派发/结算回写/status/spawn 异常隔离）、`tests/effort-rules.test.ts`（11 用例）、`tests/effort-rules-llm-family.test.ts`（14 用例）；tool-surface fixture 登记 `dsh_workplan_delegate` 并按其注释契约同步刷新 docs/cc（ADV-FSP / AVA / SECURITY-TARGET）。全量回归 【待 T5 回填：以 reports/full-regression-239.md 实测为准，要求 0 失败；草稿时点 T5 尚未执行，禁止预填数字】。
- **版本与发布**：全部版本标识原子同步至 2.3.9（package.json / package-lock.json×2 / src/host.ts meta.version / tool-surface fixture / README 三语徽章与安装行 / CHANGELOG 新段）；lib/ 与 dist/ 由 `npm run build` 重新生成，产物含 delegateTool。
```

**草稿纪律说明（不随段粘贴）**：
1. 回归总数留占位符——历史教训（writing/T3）明令「引用数字一律脚本对归档原文回指，禁止凭肉眼粗估/预填」。T5 全量回归出数后由 T4/T5 回填，格式对齐既有段落「全量回归 718/0/0」。
2. 发布日期写 2026-11-11（本计划执行日）；若实际发布跨日，由 T6 发布前改为真实发布日。
3. 每条要点与盘上真实变更一一对应，证据索引见第四部分；无虚构条目。

---

## 第二部分：README×3 目标行对照表（现值 2.3.2 → 目标 2.3.9，精确行定位）

实测命令：`grep -n '2\.3\.[0-9]' README.md README.zh.md README.en.md`（2026-11-11 12:2x 执行，输出见第四部分 E5）。

| # | 文件:行 | 现值（原文摘录） | 目标值 | 备注 |
|---|---|---|---|---|
| R1 | README.md:6 | `[![version](https://img.shields.io/badge/version-2.3.2-blue.svg)](https://github.com/abbaababa/dsh-workplan/releases/tag/v2.3.2)` | 同行两处 `2.3.2`→`2.3.9`、`v2.3.2`→`v2.3.9`（徽章图 URL 与 releases/tag 链接各 1 处） | 一行含 2 个版本号出现位，勿只改其一 |
| R2 | README.md:72 | `dsh plugin --profile web add dsh-workplan@2.3.2` | `dsh plugin --profile web add dsh-workplan@2.3.9` | version-sync 测试硬断言位（tests/version-sync.test.ts:45-51） |
| R3 | README.zh.md:6 | 同 R1 原文（逐字节相同） | 同 R1 改法 | 测试未覆盖徽章与 zh 版，手工同步（主 Agent 既有指示，见 T5-version-bump-plan-239.md 第 11 项） |
| R4 | README.zh.md:72 | `dsh plugin --profile web add dsh-workplan@2.3.2` | `…@2.3.9` | 同 R3，手工同步 |
| R5 | README.en.md:6 | 同 R1 原文（逐字节相同） | 同 R1 改法 | 徽章手工同步 |
| R6 | README.en.md:83 | `dsh plugin --profile web add dsh-workplan@2.3.2` | `…@2.3.9` | version-sync 测试硬断言位（注意 en 版安装行在 83 行，不是 72） |

**禁改的历史版本行（三份 README 均有，防篡改红线）**：
- 三份 README:47 —— v1.8.1/v1.8.0 自我更正记录（历史事实，禁改；历史教训 writing/T3 曾漏登记此行，本次已实测登记）。
- README.md:99,121,133,157,196,207,209,220,227,229,238,251,269；README.zh.md:99,119,158,169,171,182,189,191,200,213,231；README.en.md:59,108,128,130,179,181,192,199,201,210,220,237 —— 均为 1.4.3/1.5.0/2.0.2/1.11.0/Chart.js 4.6.1 等历史叙述或依赖版本，与本次发布版本无关，一律保留。

---

## 第三部分：其余声明位现值交叉核对（供 T3 基线/T4 原子改版引用；本任务不改）

实测命令：`grep -n '"version"' package.json package-lock.json`、`grep -n "version: '2" src/host.ts lib/host.js dist/host.js`、`sed -n '1,20p' tests/fixtures/tool-surface.json`。

| # | 文件:行（本次实测） | 现值 | 目标 | 与旧清单差异 |
|---|---|---|---|---|
| V1 | package.json:3 | `"version": "2.3.2",` | 2.3.9 | 无漂移 |
| V2 | package-lock.json:3 | `"version": "2.3.2",` | 2.3.9 | 无漂移 |
| V3 | package-lock.json:9 | `"version": "2.3.2",`（packages[""]） | 2.3.9 | 无漂移 |
| V4 | src/host.ts:1724 | `version: '2.3.2',`（export const meta） | 2.3.9 | **旧清单写 1584，已漂移**（T4b 新增代码所致） |
| V5 | lib/host.js:1587 | `version: '2.3.2',` | 构建重新生成 | 旧清单写 1455，已漂移；若 T4 走全量 build 则免手改 |
| V6 | dist/host.js:1587 | `version: '2.3.2',` | 构建重新生成 | 同 V5 |
| V7 | tests/fixtures/tool-surface.json:3 | `"version": "2.3.2",` | 2.3.9 | fixture 的 tools 数组已含 `dsh_workplan_delegate`（第 10 行，T4b 已更新），T4 只改 version 字段 |
| V8 | CHANGELOG.md:1 之前 | （无 2.3.9 段） | 插入第一部分草稿整段 | version-sync 硬断言 `^## 2.3.9 — ` 标题 |

**构建通电现状（只读观测，供 T1/T4 参考，非本任务结论）**：`grep -c delegateTool` 实测 lib/runtime.js=3、lib/host.js=3、dist/runtime.js=3、dist/host.js=3（T1 构建似已落盘）；client.js 与 lib/client.js 对字面 `delegateTool` 命中 0 属正常——客户端渲染走 `delegates` 台账字段（src/client.ts:1815-1830），不引用工具名。最终通电结论以 T1 的 reports/T4b-build-evidence.md 为准。

---

## 第四部分：来源证据索引（每处改动可复核）

| 证据号 | 内容 | 复核命令/位置 |
|---|---|---|
| E1 | 家族检测与等级集合单一事实源 | src/plan.ts:229-269（QWEN_MODEL_EFFORTS=233、OTHER_MODEL_EFFORTS=234、classifyModelFamily=237、COMPLEXITY_EFFORT_BY_FAMILY=260、effortForComplexity=267；229 行注释「模型名缺失⇒null⇒不施加静态约束」） |
| E2 | 双轨执行闸 + 与 2.2.7 时序 | src/llm-rules.ts:1-16（头注释时序）、62-74（validateReasoningEffort）、95-118（correctEffortForModel 强度序下探+留痕）、123-126（要求 1/2 全文） |
| E3 | 全文告知唯一注入源 + 三层纯逻辑核 | src/llm-rules.ts:147-170（buildLlmRulesBrief）、230-306（planDelegations：梳理门禁/角色混合/≤6 人/钳制留痕）、316-345（buildDelegateePrompt 叶子层任务书）；src/runtime.ts:2143（buildChildPrompt 传 llmRulesBrief） |
| E4 | delegateTool 服务端行为与错误码 | src/runtime.ts:6981-7160（层级模型注释 6983-6996；NOT_LEADER_SESSION 7007、NO_PLAN 7025、NO_SUBTASK 7033、ALREADY_DONE 7038、INVALID_ACTION 7042、review 门禁 7085-7126、DELEGATE_ALREADY_RUNNING 7142、maxDepth/cwd 7149-7160）；runtime 公开面 8544 |
| E5 | README×3 现值行 | `grep -n '2\.3\.[0-9]' README.md README.zh.md README.en.md` → 每份恰 2 行命中（6 与 72/72/83）；历史行清单来自 `grep -nE '[0-9]+\.[0-9]+\.[0-9]+' README*.md` 全量输出 |
| E6 | 工具注册/导出/fixture | src/host.ts:794-907（createDelegateTool 定义+schema+render）、1626（ctx.tools.register）、1729（export）；tests/fixtures/tool-surface.json:10（dsh_workplan_delegate）；git status 显示 docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md、AVA-VULNERABILITY-ANALYSIS.md、SECURITY-TARGET.md 已同步修改 |
| E7 | 面板三层台账 + i18n | src/client.ts:98-101（zh：delegates/delegateExpert/delegateMember/delegateStatus）、326-328（en 同键）、1809-1830（渲染块：角色/等级/钳制留痕/状态/摘要） |
| E8 | 测试新增与数量 | git status：`?? tests/delegate-tool.test.ts`、`?? tests/effort-rules.test.ts`、`?? tests/effort-rules-llm-family.test.ts`（均为新文件）；`grep -c 'test(' ` 实测 14/11/14；delegate 用例名逐条见 tests/delegate-tool.test.ts:109-333 |
| E9 | version-sync 权威断言 | tests/version-sync.test.ts:22-33（pkg/lock×2/meta.version 一致）、36-52（CHANGELOG `^## <ver> — ` 标题 + README.md/README.en.md 安装行含 `dsh-workplan@<ver>`；徽章与 zh 版不在断言内，需手工同步） |
| E10 | 版本行漂移修正 | 本次实测 src/host.ts:1724 / lib/host.js:1587 / dist/host.js:1587，对比 reports/T5-version-bump-plan-239.md 第 4/5/6 项旧行号 1584/1455/1455 |
| E11 | 既有 CHANGELOG 风格 | CHANGELOG.md:1-12（2.3.2 段：粗体导语+机制细节+回归数字+发布说明），本草稿逐条对齐该结构 |

---

## 第五部分：T4 原子改版引用指引（执行顺序建议）

1. 先确认 T1 构建绿（reports/T4b-build-evidence.md）与 T3 基线清单（reports/version-baseline-239.md）就绪。
2. 一次性原子修改：V1-V4、V7（手改）+ R1-R6（手改）+ V8（粘贴第一部分草稿，回填回归数字后）；V5/V6 由全量 `npm run build` 重新生成（勿与定向补丁双写）。
3. 改后核验：`npx tsc --noEmit` 零错；version-sync 测试绿；`grep -rn "2\.3\.2"` 排除 node_modules/reports/docs 与 `[2.3.2]` 历史锚点后，声明位命中应为 0（历史段/历史行按第二部分禁改清单保留）。
4. 红线：禁止全局盲替 `2.3.2`；禁止改 CHANGELOG 历史段与代码 `[2.3.2]` 注释锚点；sha256-manifest.json 与 lib 产物哈希耦合，交由发布流程（T6）重建，不在改版行手改。
