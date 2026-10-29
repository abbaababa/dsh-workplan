# 任务进度（dsh-workplan）

[![verify](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml/badge.svg)](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml)

**English (US) — plain-language guide:** [README.en.md](README.en.md)

> 给 **DeepSeek Harness（DSH）** 加一个「先拆任务、再真的派人去做、最后让你一眼看懂进度」的能力。
>
> **不用装 App，不改 DSH 源码，不替换页面。** 装上以后多三样东西：对话里的计划、真的部门子 Agent、左侧栏一个「任务进度」面板。

---

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
dsh plugin --profile web add dsh-workplan@1.4.3
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

## 三个模型工具（你不用直接调用）

| 工具 | 作用 |
|---|---|
| `dsh_workplan_dispatch` | 派发当前计划，等各部门子 Agent 完成，把结果写回会话。重复调用是幂等的。 |
| `dsh_workplan_update` | 主 Agent 核对结果、修正某个子任务状态与证据。子 Agent 不能调用。 |
| `dsh_workplan_cancel` | 取消还没派发的计划，不会伪造任何「已完成」。 |

在 **plan 模式**下只会给你看计划，`dispatch` 会被明确拦下并说明原因，不会偷偷开跑。

## 预算、超时与续跑（知道这些就不会误以为卡死）

| 项 | 默认值 | 怎么改 |
|---|---|---|
| 单轮派发预算 | 20 分钟 | `DSH_WORKPLAN_TOTAL_TIMEOUT_MS` |
| 单个子 Agent 上限 | 15 分钟 | `DSH_WORKPLAN_CHILD_TIMEOUT_MS` |
| 子 Agent 无进展判定 | 5 分钟 | `DSH_WORKPLAN_IDLE_TIMEOUT_MS` |
| 自动续跑次数 | 4 次 | `DSH_WORKPLAN_MAX_RESUMES` |
| 并发子 Agent | 5 个（固定） | — |

预算用尽不是失败：计划会变成「**本轮预算用尽，可续跑**」，已完成的不重跑，剩下的下次接着做。被判定卡住的子任务只卡它自己，不会拖垮整个计划。

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
npm view dsh-workplan@1.4.3 dependencies     # 应为空
grep -RInE "writeFileSync|child_process|eval\(" src   # 应无命中
npm audit --omit=dev
```

## 1.5.0 改了什么（进度一眼可见）

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

## 1.4.3 修了什么（为什么值得升级）

1.4.3 是一次**计数一致性**修复：插件曾同时维护「实时任务状态」和「缓存的统计快照」两份真相，导致面板数字和实际状态对不上（截图里「0 个正在做」但下面有任务正在做，就是它）。

| 缺陷 | 表现 | 根因 |
|---|---|---|
| D1 | 面板数字长时间不更新 | 统计只在整批子 Agent 跑完后才重算，运行期间冻结 |
| D2 | 同一份数据里两个数字互相矛盾 | 计数来自缓存，部门聚合来自实时状态 |
| D3 | 「还没开始」的任务却显示 100%、带着上一次的执行者 | 预算重置绕过了状态机，旧字段没清 |
| D4 | 同一类失败，进度有时 100 有时 0 | 两处代码对「卡住」的进度语义不一致 |

修法是**删掉缓存快照，只保留一份状态源**：所有数字在序列化时由同一函数现场派生，并配了 7 条不变量 + 变异测试防止回退。完整报告：[docs/fix-report-derived-counts-1.4.3.md](docs/fix-report-derived-counts-1.4.3.md)。

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
npm test          # 99 个测试，含计数不变量、变异测试与进度图表用例
npm run build     # 编译 src/*.ts → lib/*.js、client.js
npm run preview   # 重新生成 docs/preview 里的 1.4.3 / 1.5.0 卡头对比页
```

`lib/` 与 `client.js` 是**提交进仓库的构建产物**，CI 会重建并校验二者无差异。

## 许可证

MIT，见 [LICENSE](LICENSE)。Chart.js 亦为 MIT。

---

**English (US) — plain-language guide:** [README.en.md](README.en.md)
