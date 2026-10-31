# dsh-workplan

> **两个卖点，一句话：ISO/IEC 15408:2026 全套安全证据，5 条命令自己验；安装一条命令、零第三方运行时依赖。**

[![verify](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml/badge.svg)](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml)

给 **DeepSeek Harness（DSH）** 加一段「先拆计划 → 真派部门子 Agent 去做 → 左侧栏实时看进度」的能力。不装 App、不改 DSH 源码、不换页面。

- 对话里先出【任务分解】：阶段、子任务、部门、验收标准，一样不缺
- 最多 5 个真实子 Agent 并行执行，结果写回会话
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
| 188 项自动化测试，一条命令复跑 | 测试（ATE） | `npm run verify` |

现状：CC 最低等级 **EAL1** 的 14 项组件里，**10 项就绪、3 项部分具备、1 项只能靠外部实验室**。差的不是代码，是认证要花的实验室费用与排期——所以我们只卖证据，不冒充分证。

自己验，3 行，复制即用：

```bash
git clone https://github.com/abbaababa/dsh-workplan.git && cd dsh-workplan
npm ci && npm run verify                                  # 期望：tests 188 / pass 188 / fail 0
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
3. **真的派人去做**：确认后，每一件具体工作交给一个**真实的 DSH 子 Agent** 去执行（最多 5 个同时跑），结果写回会话；你在左侧栏「任务进度」里随时能看到谁在做、做到哪、哪件卡住了。

计划不是装饰品：主 Agent 必须先派发、等到部门结果回来，才能继续往下答。

## 装之前你需要什么

| 要求 | 说明 |
|---|---|
| DeepSeek Harness | 官方 Web 版（`dsh web` / `--profile web` 跑的这套） |
| Node.js | **22 或更高**（`node -v` 自查） |
| 网络 | 安装时需要能访问 npm registry |

## 一键安装

```bash
dsh plugin --profile web add dsh-workplan@1.8.16
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
   - 计划卡：分「进行中」「已结束」「已完成」三组，右上角是完成率。「已结束」= 这一轮已经停了（没有东西在跑）但计划还没做完，卡片会写清停在哪儿（预算用完 / 卡住了 / 还没开始），说一句「继续」即可接着推进；
   - 展开任意计划：每个阶段的进度、每件具体工作由哪个部门负责、当前状态。

5. 进度数字背后的每一行，都来自同一份任务状态——**不会再出现「显示 0 个正在做、但下面明明写着正在做」这种自相矛盾**（1.4.3 专门修的就是这个，见下文）。

纯打招呼、道谢、问「做到哪了」不会触发拆解，不会平白多出一堆子 Agent。

## 四个模型工具（你不用直接调用）

| 工具 | 作用 |
|---|---|
| `dsh_workplan_dispatch` | 派发当前计划，把结果写回会话。默认 `mode:"wait"` 等结束；`mode:"async"` 立刻返回、后台继续。重复调用是幂等的。 |
| `dsh_workplan_status` | 只读：问到哪了。重启或刷新后也能从会话记录重建。 |
| `dsh_workplan_update` | 主 Agent 核对结果、修正某个子任务状态与证据。带 `expectedRevision` 防覆盖，运行中默认拒绝（`force:true` 才覆盖）。子 Agent 不能调用。 |
| `dsh_workplan_cancel` | 取消还没派发的计划，不会伪造任何「已完成」。 |

在 **plan 模式**下只会给你看计划，`dispatch` 会被明确拦下并说明原因，不会偷偷开跑。

## 部门怎么协作（1.7.1 的真实能力）

计划里的每件工作都带一个部门标签（工程研发、研究分析、设计、产品、数据、质量验证、安全、运维、文档写作、运营、法务合规、财务）。**标签决定提示词与统计口径，不是组织架构**：

- 部门之间**不能直接对话**；跨部门信息由主 Agent 转达，或落到双方都能读的工作区文件。但每个子 Agent 的提示词里会带上**兄弟部门的只读一览**（谁、做什么、产出什么、已完成摘要），需要协作就写进 `needs`，结果消息会汇总成「跨部门待转达」交给主 Agent 逐条处理。
- 下游只看到 `dependsOn` 里上游的**摘要**与完整体检结果，看不到上游的完整对话。所以上游必须把「产物绝对路径 + 怎么验收」写进摘要；声明为 `file` 的产物会被逐个核实，**缺失就不给下游解锁**。
- 子 Agent 在输出末尾回传结构化证据块（`status` / `acceptance` / `artifacts` / `needs`）。**非空输出不再等于完成**：`partial`、任一条验收失败、坏块都判受阻，只有全 `pass` 才可直接采信，其余在结果消息里标「未验证」等主 Agent 核对。
- 阶段（stage）只是展示分组，**不是执行门槛**；真正决定先后的是 `dependsOn`。

完整的角色、数据契约、状态机、失败恢复与「改代码时必须同步的三处」，见 **[协作契约](https://github.com/abbaababa/dsh-workplan/blob/main/docs/collaboration.md)**；12 个部门的职责与交接清单见 **[部门职责与交接约定](https://github.com/abbaababa/dsh-workplan/blob/main/docs/departments.md)**。

## 预算、超时与续跑（知道这些就不会误以为卡死）

| 项 | 默认值 | 怎么改 |
|---|---|---|
| 单轮派发预算 | 20 分钟 | `DSH_WORKPLAN_TOTAL_TIMEOUT_MS` |
| 单个子 Agent 上限 | 15 分钟 | `DSH_WORKPLAN_CHILD_TIMEOUT_MS` |
| 子 Agent 无进展判定 | 5 分钟 | `DSH_WORKPLAN_IDLE_TIMEOUT_MS` |
| 自动续跑次数 | 4 次 | `DSH_WORKPLAN_MAX_RESUMES` |
| 并发子 Agent | 5 个（固定） | — |

预算用尽不是失败：计划会变成「**本轮预算用尽，可续跑**」，已完成的不重跑，剩下的下次接着做。被判定卡住的子任务只卡它自己，不会拖垮整个计划；重试只会发生一次，第二次的提示词会带上一次的失败原因，不会原样重撞。

环境变量写在启动 DSH 的那个 shell 里，或者写进插件配置：

```jsonc
// cordis.patch.yml 里的 config 字段
{ "totalTimeoutMs": 1800000 }   // 30 分钟
```

## 安全与隐私（可以自己复核）

- **没有第三方运行时依赖**：`dependencies` 是空的；装出来的只有这个插件自己的 JS、配置、图标和说明。
- **不写你的磁盘**：源码里没有任何 `writeFileSync` / `appendFileSync` / `mkdirSync`（可 `grep` 验证）；结果只写进 DSH 会话记录。
- **不向外发数据**：源码里没有 `child_process`、没有对外 `fetch`/`http.request`；唯一的一次 `fetch` 是浏览器端请求**同源**的 `/dsh-workplan/plans`。
- **面板数据要登录**：该路由走 DSH 自己的鉴权，未登录直接返回 401。
- **图表库是本地自带**：`vendor/chart.umd.js`（Chart.js 4.6.1，MIT）随包分发，不加载任何 CDN 脚本。

自己复核：

```bash
npm view dsh-workplan@latest dependencies     # 应为空
grep -RInE "writeFileSync|child_process|eval\(" src   # 应无命中
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

## 常见问题

**装完没反应？**
先重启 DSH Web；再确认 `~/.dsh/profiles/web/package.json` 的依赖里有 `dsh-workplan`。

**面板一直是空的？**
面板只显示**当前会话**的计划。换一个会话、或这个会话还没产生计划时是空的，这是正常的。

**数字和以前不一样了？**
1.4.3 之后数字来自真实状态而不是缓存，所以会比旧版本「更小、但更准」（旧版本的完成率经常虚高）。

**子 Agent 卡住不动？**
5 分钟没有任何新事件会被判定卡住并单独标红；对主 Agent 说「续跑这个计划」即可从受阻处继续。

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
