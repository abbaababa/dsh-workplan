# dsh-workplan

> **两个卖点，一句话：ISO/IEC 15408:2026 全套安全证据，5 条命令自己验；安装一条命令、零第三方运行时依赖。**

[![verify](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml/badge.svg)](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml)
[![version](https://img.shields.io/badge/version-3.0.9-blue.svg)](https://github.com/abbaababa/dsh-workplan/releases/tag/v3.0.9)

给 **DeepSeek Harness（DSH）** 加一段「先拆计划 → 真派部门子 Agent 去做 → 左侧栏实时看进度」的能力。不装 App、不改 DSH 源码、不换页面。

- 对话里先出【任务分解】：阶段、子任务、部门、验收标准，一样不缺
- 每轮最多 5 个部门负责人并行启动；负责人还会再派专家，整棵会话树同时活跃的子 Agent 受宿主 `maxActiveSubagents` 约束（默认 8）
- 左侧栏「任务进度」：谁在做、做到哪、哪件卡住了

**English (US) — plain-language guide:** [README.en.md](README.en.md)

---

## 为什么敢拿 ISO/IEC 15408 当卖点，又不算吹牛

**CC（Common Criteria，ISO/IEC 15408）的规矩是三方分工：开发者交材料 → 独立实验室评测 → 国家机构发证。软件不能给自己发证。** 所以「本插件已通过 CC 认证」这句话，没有证书编号就是假的——这种话我们不说。

我们做的是能自己做的那一半：**按 2026 版（不是 2022 版）标准的结构，把材料真做出来、公开出来，任何人都能自己核对。**

| 我们公开的 | 对应标准 | 在哪儿 |
|---|---|---|
| 保护什么、防谁、边界在哪 | 安全目标（ST） | [docs/cc/SECURITY-TARGET.md](docs/cc/SECURITY-TARGET.md) |
| 攻击面、7 条威胁、对策、残留风险 | 脆弱性评定（AVA） | [docs/cc/AVA-VULNERABILITY-ANALYSIS.md](docs/cc/AVA-VULNERABILITY-ANALYSIS.md) |
| 逐类对照 + EAL1 就绪度 + 还缺什么 | 自评估 | [docs/cc/CC-2026-ASSESSMENT.md](docs/cc/CC-2026-ASSESSMENT.md) |
| 第三方组件、许可证、哈希 | 生命周期（ALC） | [docs/SBOM.md](docs/SBOM.md) |
| 漏洞怎么报、多久回、部署怎么配 | 安全策略 | [SECURITY.md](SECURITY.md) |
| 470 项自动化测试（2026-11-03 独立复检实测 470/470 全绿），一条命令复跑 | 测试（ATE） | `npm run verify` |

现状（2026-11-03 独立复检报告结论，33 条差距逐条复核）：**26 条已关闭（通过）；4 条经判定为「不适用或固有残留」且判定本身成立；1 条（发布包 sha256 数值）属发布期执行件，脚本已就绪、随发布公布**。无新发现的代码类缺口。**必须如实披露的固有残留**：`ATE_IND.1`（测试执行需认可实验室见证）与 `AVA_VAN.2+`（独立渗透评测）——按 CC 规则只能由认可实验室完成，本项目以「公开自评估」口径如实标注，任何宣传材料都不省略这条。

版本口径（两个头都有官方来源佐证）：证据包按 **ISO/IEC 15408:2026**（已列入 ISO 官方目录）的结构编写；现行国家认证体系（如德国 BSI）受理的版本仍为 **CC:2022**。所以我们说「**对齐 2026 结构、认证体系现行受理 CC:2022，公开全套自评证据 + 完整安装使用方法**」，不说「已通过 CC 认证」。

自己验，3 行，复制即用：

```bash
git clone https://github.com/abbaababa/dsh-workplan.git && cd dsh-workplan
npm ci && npm run verify                                  # 期望：tests 470 / pass 470 / fail 0
grep -RInE "child_process|execSync|eval\(|writeFileSync" src || echo "0 命中（预期）"
```

> 一句话记住：**有证书是第三方给的，有证据是自己挣的。**
>
> **自我更正记录**：v1.8.1 公开更正了 v1.8.0 里三处「文档写得比代码多」的地方（图表路由其实不鉴权、自测并未覆盖鉴权与截断分支、EAL1 矩阵把一个自相矛盾的组件判成就绪），详情见 [CHANGELOG](CHANGELOG.md) 与 [自评估 §6.1](docs/cc/CC-2026-ASSESSMENT.md)。

## 它到底做了什么（用大白话讲）

平时你给 AI 一个复杂任务，它经常「一边想一边做」，做到一半你才发现方向不对。

这个插件把节奏改成三拍：

1. **先排计划**：你发出任务后、AI 真正动手前，它先写一份计划——分几个阶段、每个阶段几件具体工作、每件工作交给哪个部门、怎么做、什么算做完、可能卡在哪。
2. **计划先给你看**：这份计划以「任务分解」的形式出现在对话里，包含每一步的依据与验收标准，而不是一句话糊过去。
3. **真的派人去做**：确认后，每一件具体工作交给一个**真实的 DSH 子 Agent** 去执行（每轮最多 5 个负责人同时启动；负责人再派专家，整棵树受宿主上限约束，默认 8），结果写回会话；你在左侧栏「任务进度」里随时能看到谁在做、做到哪、哪件卡住了。

计划不是装饰品：主 Agent 必须先派发、等到部门结果回来，才能继续往下答。

## 装之前你需要什么

| 要求 | 说明 |
|---|---|
| DeepSeek Harness | 官方 Web 版（`dsh web` / `--profile web` 跑的这套；自 3.0.9 起对 DSH 版本不作要求，均可安装使用） |
| Node.js | **22 或更高**（`node -v` 自查） |
| 网络 | 安装时需要能访问 npm registry |

## 一键安装

```bash
dsh plugin --profile web add dsh-workplan@3.0.9
```

装完**重启一次 DSH Web**（或重新载入当前页面）让插件生效。

没有 `dsh` 命令的话，先确认它在 PATH 里；用 `npx` 起的 DSH 可以直接用完整路径调用同一个 `dsh`。

### 从源码安装（可选，想改代码时用）

```bash
git clone https://github.com/abbaababa/dsh-workplan.git
cd dsh-workplan
npm ci && npm run build
dsh plugin --profile web add "$(pwd)"
```

## 装好以后怎么用（小白版）

1. 打开 DSH Web，随便发一个**有实际目标**的任务，例如「帮我把这个目录的测试补到 80% 覆盖」。
2. 等一两秒，对话里会出现一块【任务分解】：阶段、子任务、部门、验收标准齐全。
3. 你只需要正常对话；主 Agent 会按规则派发计划，遇到要拍板的地方会问你。
4. 点左侧栏的**「任务进度」**，就能看到：

   - 顶部五个数字：**几个任务 / 分配了多少件工作 / 做好了 / 正在做 / 卡住了**；
   - 计划卡：分「进行中」「已结束」「已完成」三组，右上角是完成率。「已结束」= 这一轮已经停了（没有东西在跑）但计划还没做完，卡片会写清停在哪儿（已暂停 / 卡住了 / 还没开始），说一句「继续」即可接着推进；
   - 展开任意计划：每个阶段的进度、每件具体工作由哪个部门负责、当前状态。

5. 进度数字背后的每一行，都来自同一份任务状态——**不会再出现「显示 0 个正在做、但下面明明写着正在做」这种自相矛盾**（1.4.3 专门修的就是这个，见下文）。

纯打招呼、道谢、问「做到哪了」不会触发拆解，不会平白多出一堆子 Agent。

## 十一个模型工具（你不用直接调用）

| 工具 | 作用 |
|---|---|
| `dsh_workplan_dispatch` | 派发当前计划，把结果写回会话。默认 `mode:"wait"` 等结束；`mode:"async"` 立刻返回、后台继续。重复调用是幂等的。 |
| `dsh_workplan_status` | 只读：问到哪了。重启或刷新后也能从会话记录重建。 |
| `dsh_workplan_update` | 主 Agent 核对结果、修正某个子任务状态与证据。带 `expectedRevision` 防覆盖，运行中默认拒绝（`force:true` 才覆盖）。子 Agent 不能调用。 |
| `dsh_workplan_cancel` | 取消还没派发的计划，不会伪造任何「已完成」。 |
| `dsh_workplan_replan` | 需求变更时就地修订：`cancel` / `replace` / `add`，旧行标为「已取代」保留可追溯，计划版本号递增。主 Agent 专用。 |
| `dsh_workplan_escalate` | 子 Agent 执行中遇阻上报：问题、选项、建议进状态机，等主 Agent 指示；不再是「只能憋到结尾写 BLOCKED」。 |
| `dsh_workplan_instruct` | 主 Agent 回答请示并下达指示；失败则挂起，子任务下次激活时注入。60 秒无回执只提示，不按时间判失败或中止。 |
| `dsh_workplan_handoff` | 处置跨部门需求：`list` / `assign` / `resolve` / `close`。未处置会拦住交付；对「待指示」的行 `resolve` 会直接把答复投递给子会话。 |
| `dsh_workplan_followup` | 给已中止或暂停、但产物已落盘的直接子会话补一条收尾说明。 |
| `dsh_workplan_verify` | 子 Agent 在**第四步（验证阶段）**提交五步证据做核验；前三步证据不齐调用会返回 `PHASE_GATE`。核验通过≠完成，最终仍由完成判定复核。 |
| `dsh_workplan_lessons` | 只读查看**永久教训记忆**：`list` / `search` / `stats`。仅限根会话调用（子 Agent 不能跨项目读取）；它只读文件，不改计划状态；用来核对「到底记住了什么、哪些错误在重复发生」。 |

在 **plan 模式**下只会给你看计划，`dispatch` 会被明确拦下并说明原因，不会偷偷开跑。

## 五步工作法与自我学习（3.0.8 的单框架）

### 五步：任务梳理 → 资源/工具/方案研究 → 准备就绪 → 执行与验证 → 收尾复盘

3.0.8 起，原「两轮深度思考」开工门禁并入五步工作法（两轮内容本就是第 1、2 步的子集，不再双份提交）：每个部门 Agent 收到工作后，顺序不可颠倒，开工前必须完成前三步并登记开工证据 `startPhases`：

| 步骤 | 必须完成的事 | 证据 |
|---|---|---|
| 一 任务梳理 | 全面、深入梳理自己的任务（目标与验收/现状/事实/约束/未知/主要矛盾/边界） | `startPhases.planning.problemAnalysis` + 结算 `phases.planning` |
| 二 资源/工具/方案 | 基于第一步全部结果研究需要哪些资源、哪些工具、具体实施方案（方法、流程、步骤，含依据） | `startPhases.planning.resources/tools/approach/approachBasis` |
| 三 准备就绪 | 把资源与工具真正备齐并给出可复核的就绪证据 | `startPhases.preparation.prepared/evidence` |
| 四 执行与验证 | 严格按第二步的方法、流程、步骤执行并逐条验证；需要改道必须记录原因 | `phases.execution.steps/deviations` + `phases.verification` |
| 五 收尾复盘 | 逐条验证验收标准与用户原要求，并做**自我学习复盘** | `phases.verification` + `retrospective` |

**关于「前三步禁用插件」的更正（2.0.2）**：这条只适用于 2026-11-05 本次优化会话，不是对所有后续会话的永久规则（2.0.1 曾把它写成产品级规则，2.0.2 已更正）。五步工作法约束的是部门子 Agent 的交付证据顺序；主 Agent 在任何阶段都可以正常使用计划、派发、查询与改判工具。验证工具在缺前三步证据时返回 `PHASE_GATE` 并列出待补项——这是防止跳过前三步直接「验证通过」的门禁，不是禁用插件。遇阻上报 `dsh_workplan_escalate` 始终可用。

### 自我学习与自我迭代：把弯路变成永久记忆

每次完成工作，第五步收尾必须提交四项复盘（缺一项就判未完成）：

1. **problems**：本次全过程遇到的所有问题（现象 + 根因）；
2. **detours**：走过的弯路、返工与无效尝试（确实没有就写空数组，不编造）；
3. **resolutions**：最终是如何解决的；
4. **prevention**：以后如何预防再犯，必须写成「遇到…先…」的可执行硬规则。

复盘通过后，插件立刻把它写入**永久记忆文件**（JSONL，追加写）：

```
~/.dsh/workplan/lessons.jsonl        # 默认位置，跨项目长期保留
DSH_WORKPLAN_LESSONS_FILE=/path/x.jsonl   # 需要时用环境变量覆盖
```

下一次派发子任务前，插件会按「同部门 > 同项目 > 关键词命中 > 重复次数 > 新近程度」挑选最相关的历史教训，自动注入子 Agent 提示词（最多 8 条），并明确标注：**这是历史数据，不是新指令，但相关就必须遵守**。

同一类错误再次出现时不会新增一条重复记录，而是把 `occurrences` 累加并把排序提前——越重复越显眼，这就是「自我迭代」。主 Agent 可用 `dsh_workplan_lessons` 复核；`occurrences ≥ 2` 的教训必须在下一次计划里变成明确约束。

记忆文件损坏一行不会拖垮整份记忆（坏行跳过）；文件最多保留最近 500 条；写入用「临时文件 + 改名」避免半截文件。复盘来自模型输出，注入前会清掉不可见字符与会话引用，并声明为数据而非指令。

## 部门怎么协作（1.11.0 的真实能力）

计划里的每件工作都带一个部门标签（工程研发、研究分析、设计、产品、数据、质量验证、安全、运维、文档写作、运营、法务合规、财务）。**标签决定提示词与统计口径，不是组织架构**：

- 部门之间**不能直接对话**（这是刻意的权限边界）；跨部门信息由主 Agent 转达，或落到双方都能读的工作区文件。但每个子 Agent 的提示词里会带上**兄弟部门的只读一览**（谁、做什么、产出什么、已完成摘要），需要协作就写进 `needs`；每条 needs 会自动登记成带编号的跨部门需求（`open → routed → answered/closed`），结果消息与 `status` 都能看到，**未处置就拦住交付**。主 Agent 用 `dsh_workplan_handoff` 逐条处置；提出需求的行若正在等指示，`resolve` 会把答复直接投递给该子会话。
- 下游只看到 `dependsOn` 里上游的**摘要**与完整体检结果，看不到上游的完整对话。所以上游必须把「产物绝对路径 + 怎么验收」写进摘要；声明为 `file` 的产物会被逐个核实，**缺失就不给下游解锁**。
- 子 Agent 在输出末尾回传结构化证据块（`status` / `acceptance` / `artifacts` / `needs`）。**非空输出不再等于完成**：`partial`、任一条验收失败、坏块都判受阻，只有全 `pass` 才可直接采信，其余在结果消息里标「未验证」等主 Agent 核对。
- 阶段（stage）只是展示分组，**不是执行门槛**；真正决定先后的是 `dependsOn`。

完整的角色、数据契约、状态机、失败恢复与「改代码时必须同步的三处」，见 **[协作契约](https://github.com/abbaababa/dsh-workplan/blob/main/docs/collaboration.md)**；12 个部门的职责与交接清单见 **[部门职责与交接约定](https://github.com/abbaababa/dsh-workplan/blob/main/docs/departments.md)**。

## 执行时限、健康保护与续跑

**部门负责人和部门相关领域全球顶尖专家没有任务总时限、单次执行时限、无进展终止时限或回执终止时限。** 事前预估仅用于协调和向用户说明，不会派生截止时间，也不会影响 `done` 验收；`extendMs` 只保留旧调用兼容并返回 `TIME_LIMITS_DISABLED`，不会真的延期。历史上的 10 分钟完成判据已停用，环境变量不能重新开启。

| 项 | 当前行为 | 配置说明 |
|---|---|---|
| 负责人/专家整轮与单次执行 | **无时限**，直到自然完成、真实错误、证据/质量门禁或用户显式取消 | 旧 `DSH_WORKPLAN_TOTAL_TIMEOUT_MS`、`DSH_WORKPLAN_CHILD_TIMEOUT_MS`、`totalTimeoutMs`、`childTimeoutMs`、子任务 `timeoutMs` 均不再形成截止 |
| 无进展与回执 | 保留观测和提醒，不因静默或回执超期自动 `blocked` / 中止 | 旧 `DSH_WORKPLAN_IDLE_TIMEOUT_MS` 不形成执行限制 |
| `dispatch` 工具 | 不声明工具执行期限；`async` 立即返回，`wait` 会一直等到本轮实际收束 | 长任务建议使用 `async`，配合 `status` 查询和显式 `cancel` |
| 规划器无进展上限 | 5 分钟（自上一个输出块起算；仅约束生成计划，不约束负责人/专家执行） | `DSH_WORKPLAN_PLANNER_TIMEOUT_MS` |
| 规划器静默判定 | 90 秒（仅规划输出传输健康保护） | `DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS` |
| 规划器绝对上限 | 15 分钟（仅规划器） | 随 `…_PLANNER_TIMEOUT_MS` 等比变化 |
| 自动续跑次数 | 2 次（处理可续跑的非时间暂停，不是执行时钟） | `DSH_WORKPLAN_MAX_RESUMES` |
| 回合收尾等待上限 | 60 分钟（只约束收尾时"等计划/派发落地"的等待；到点放行或报错但**不杀任务**，部门/专家执行本身仍无时限；0 = 无限旧行为） | `DSH_WORKPLAN_TURN_STOPPING_MAX_WAIT_MS` |
| 澄清闸轮次上限 | 同一回合对话连续触发 2 轮澄清提问后放行进入规划（30 分钟无触发自动归零） | 固定 |
| 并发子 Agent | **每轮最多 5 个负责人**；负责人还会再派专家，整棵会话树同时活跃的子 Agent 受宿主 `maxActiveSubagents` 约束（默认 8） | — |

单次模型网络请求、单条 Bash 命令和清理等待仍有各自的局部健康保护；它们不是部门任务的总时限，不能用一条慢命令的传输超时替代整个任务 deadline。后台任务也不能绕过用户显式取消。

没有自动时间终结后，真正卡住的执行可能持续占用并发和费用：请看板提示与 `status`，由用户明确取消或指示处理。旧记录中的 `deadlineAt`、延期日志、超时计数和判据字段只用于历史回放，不会重新武装计时器。

非时间的资源与续跑配置仍可写在启动 DSH 的 shell 或插件配置中，例如：

```jsonc
// cordis.patch.yml 里的 config 字段
{ "maxResumes": 2 }
```

留痕（`journal`）默认**永久保留**，不自动删除任何审计证据。只有显式配置正数时，才会在启动 10 秒后（不阻塞激活）和之后每 24 小时清理一次“超过该天数未更新”的 `<planId>.jsonl`（单次最多 200 个最旧文件；**当前活跃的计划始终排除**，正在执行的计划也会持续追加，不会被误删；单个文件删除失败会逐条告警留痕）：

```jsonc
{ "journalRetentionDays": 90 }
// 等价环境变量：DSH_WORKPLAN_JOURNAL_RETENTION_DAYS=90
```

## 安全与隐私（可以自己复核）

- **没有第三方运行时依赖**：`dependencies` 是空的；装出来的只有这个插件自己的 JS、配置、图标和说明。
- **只写三类本地文件，不写你的项目目录**：① `~/.dsh/workplan/journal/<planId>.jsonl`（计划留痕：派发、指示、请示、完成）；② `~/.dsh/workplan/lessons.jsonl`（永久教训记忆）；③ `~/.dsh/workplan/notices.jsonl`（专用通知台账：workplan 通知的权威机器可读流，与用户真实输入分离）。三者都可用环境变量改到别处，统一 **0o600 文件 / 0o700 目录**权限并拒绝向符号链接写入；台账默认最多保留最新 5000 行（`DSH_WORKPLAN_NOTICES_MAX_LINES` 可改），超限原子重写；源码里的 `appendFileSync` / `writeFileSync` 只出现在留痕/记忆/台账这几个模块。
- **不向外发数据**：源码里没有 `child_process`、没有对外 `fetch`/`http.request`；唯一的一次 `fetch` 是浏览器端请求**同源**的 `/dsh-workplan/plans`。
- **面板数据要登录**：该路由走 DSH 自己的鉴权，未登录直接返回 401。
- **图表库是本地自带**：`vendor/chart.umd.js`（Chart.js 4.6.1，MIT）随包分发，不加载任何 CDN 脚本。

自己复核：

```bash
npm view dsh-workplan@latest dependencies     # 应为空
grep -RInE "child_process|eval\(" src   # 应无命中
grep -RIn "appendFileSync\|writeFileSync" src  # 只应出现在 dept-journal.ts、lessons.ts 与 notice-ledger.ts
npm audit --omit=dev
```

<details>
<summary><b>1.5.0 改了什么（进度一眼可见）</b>（点开看）</summary>

1.5.0 只改展示层：把计划卡折叠态那行「本计划 0/8 做好了 + 一根 54×5px 的小条」换成图表组合。

| 位置 | 改前 | 改后 |
|---|---|---|
| 折叠中的计划卡 | 12px 灰字 + 迷你条 + 「0 卡住了」；百分比只在鼠标悬停的 `title` 里 | 44px 环形图 + 24px 百分比 + `本计划 X/Y 做好了` + 一行「现在在做什么」（卡住优先，带任务名）+ 8px 四段构成条 + 状态图例 + 阶段步进条 |
| 展开后的面板 | 一根计划级进度条 | 「分步进度」：每个阶段一行（名称、`完成/总数`、细条、状态），外加加权总体进度 |
| 0% 的计划 | 迷你条填充宽度为 0，轨道又与卡片底色用同一个 token，等于没有图 | 四层信号：加粗的环轨、24px「0%」、整条灰色的「还没开始」构成条、虚线阶段槽 + 当前阶段描边 |
| 0 个工作项的组头 | `未完成 0 / 已完成 0（完成率暂无数据）` | 整句删除，只留环上的 `—`；组内空态仍在（展开可见） |

「卡住了」这类数字一个都没少，只是换了呈现：图例始终是 `做好了 / 正在做 / 卡住了 / 还没开始` 四项带数字。

**怎么看到效果**：插件的前端在 `client.js` 里，DSH Web 进程启动时加载它，所以先重启 DSH Web，再刷新 <http://127.0.0.1:3080>。不想改环境也能离线看对比：打开 [docs/preview/progress-visual-1.5.0.html](docs/preview/progress-visual-1.5.0.html)（`npm run preview` 可重新生成，它用同一份 CSS 渲染 1.4.3 与 1.5.0 的卡头）。

没有新增依赖，`plan.ts` / `runtime.ts` 无改动；回滚方式见 [CHANGELOG.md](CHANGELOG.md)。

</details>

<details>
<summary><b>1.4.3 修了什么（为什么值得升级）</b>（点开看）</summary>

1.4.3 是一次**计数一致性**修复：插件曾同时维护「实时任务状态」和「缓存的统计快照」两份真相，导致面板数字和实际状态对不上（截图里「0 个正在做」但下面有任务正在做，就是它）。

| 缺陷 | 表现 | 根因 |
|---|---|---|
| D1 | 面板数字长时间不更新 | 统计只在整批子 Agent 跑完后才重算，运行期间冻结 |
| D2 | 同一份数据里两个数字互相矛盾 | 计数来自缓存，部门聚合来自实时状态 |
| D3 | 「还没开始」的任务却显示 100%、带着上一次的执行者 | 预算重置绕过了状态机，旧字段没清 |
| D4 | 同一类失败，进度有时 100 有时 0 | 两处代码对「卡住」的进度语义不一致 |

修法是**删掉缓存快照，只保留一份状态源**：所有数字在序列化时由同一函数现场派生，并配了 7 条不变量 + 变异测试防止回退。完整报告：[docs/fix-report-derived-counts-1.4.3.md](docs/fix-report-derived-counts-1.4.3.md)。

</details>

## 和 DSH 内置的子代理是什么关系（重要）

DSH 本身自带「子智能体」能力（内置 subagent 工具）。本插件**不替换、也不关闭**它，两者同时存在，请知道这三件事：

1. **插件的部门负责人/专家**由插件统一派发和管理，走 `dsh_workplan_delegate` 等 11 个工具的全部闸门（事前预估、分工表、五步开工证据、结算核验、汇报核验）。
2. **内置 subagent 工具在这些子会话里仍然可见**。如果模型绕过插件、直接调用内置 `subagent` / `subagent_fork`，那个人会话**不经过插件的任何闸门**（无台账、无核验、无执行管理），产物也不会自动进计划看板。发现看板外多出来路不明的子会话时，对它说「以后派活一律走 dsh_workplan」即可。
3. **设置页两个子代理选项对本插件的影响不同**（已核实宿主源码，两条通道互不相干）：
   - 「子代理最大深度」（`subagent.maxDepth`）**只管内置 subagent/subagent_fork 工具**——本插件的三层体系（你 → 部门负责人 → 专家）按派发契约固定申请第 2 层深度，宿主对插件契约单独放行，**该滑块在任何位置都不会影响、也不会拦阻**负责人派发给专家。首次检测到该设置 <2 时插件会一次性说明这一点（无需任何操作；想完全一致可把滑块调到 2，重启后恢复默认）；
   - 「子代理最大并发」（`maxActiveSubagents`）**对本插件生效**——超上限时插件会明确提示「稍后重试或调大该设置」。

## 常见问题

**装完没反应？**
先重启 DSH Web；再确认 `~/.dsh/profiles/web/package.json` 的依赖里有 `dsh-workplan`。

**面板一直是空的？**
面板只显示**当前会话**的计划。换一个会话、或这个会话还没产生计划时是空的，这是正常的。

**数字和以前不一样了？**
1.4.3 之后数字来自真实状态而不是缓存，所以会比旧版本「更小、但更准」（旧版本的完成率经常虚高）。

**子 Agent 卡住不动？**
插件不会再仅因 5 分钟没有新事件就自动判失败或中止。请查看「任务进度」和 `status`；确认需要停止时明确说「取消这个计划/子任务」，需要调整时用 `instruct` 下达指示。这样保留人工控制，也避免长时间深思或大型任务被误杀。

## 卸载

```bash
dsh plugin --profile web remove dsh-workplan
```

## 开发与验证

```bash
npm ci
npm run check     # tsc --noEmit
npm test          # 全部测试（数量随版本变化，以命令输出与 CI 为准），含计数不变量与进度图表用例
npm run build     # 编译 src/*.ts → lib/*.js、client.js
npm run preview   # 重新生成 docs/preview 里的 1.4.3 / 1.5.0 卡头对比页
```

`lib/` 与 `client.js` 是**提交进仓库的构建产物**，CI 会重建并校验二者无差异。

## 许可证

MIT，见 [LICENSE](LICENSE)。Chart.js 亦为 MIT。

---

**English (US) — plain-language guide:** [README.en.md](README.en.md)

## 🔒 安全性

我们对插件全部源码逐行做了安全审计。结论：**未发现任何窃取文件或数据的行为。**
它不读取您的文档、照片、通讯录、剪贴板等个人文件；不向任何外部服务器发送数据，仅在您本机内显示任务面板，且相关请求需登录授权。
以上为源码审计结论；发布包一致性、运行时实际行为两项仍在进一步验证中，详见 [SECURITY.md](SECURITY.md) 第 8 节。
