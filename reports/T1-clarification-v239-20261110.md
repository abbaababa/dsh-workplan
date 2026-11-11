# T1 澄清问题单与事实确认结论 — dsh-workplan v2.3.9 分发机制优化

> 产品部门·需求澄清专家 | 2026-11-10 | 只读核实，未改任何源码
> 结论：**全部明确（8/8 已确认），无待回复阻塞项，后续子任务可凭本文 §4 事实块直接开工。**

## 1. 结构化澄清问题单（8 项，按阻塞程度排序）

| # | 不明项 | 为何需要 | 可接受的回复范围 | 处置方式 | 状态 |
|---|--------|----------|------------------|----------|------|
| U1 | 插件源码路径（「现有最新版」指哪份代码） | T3/T4/T5 所有改动必须落在唯一权威源码树；找错目录则全部返工 | 绝对路径；须与运行中加载态一致 | 本地取证自证（无需问用户：盘上事实可核验，提问反而低效） | ✅ 已确认 |
| U2 | 官方 GitHub 仓库 URL | T7 发布 push/tag/Release 的目标；错一个字符即发布到错误仓库 | git remote 或 https 仓库地址 | 本地取证自证 | ✅ 已确认 |
| U3 | 「索引源」具体链路（发布到哪、怎么发） | 用户要求6「自动发布到索引源」；链路不明则 T7 无法写发布脚本、无法判定交付 | 条目仓库+文件路径+生效链路说明 | 本地取证自证（RELEASING.md §5 + 2.3.2 发布记录） | ✅ 已确认 |
| U4 | 当前版本号基线（从哪里升到 2.3.9） | T5 版本同步与 T6 回归判定都需要唯一基线；历史教训（[product] T3）明确运行态≠磁盘态时必须先冻结五元组 | package.json/tag/npm latest 三源读数 | 本地取证自证 | ✅ 已确认 |
| U5 | 语言/框架/构建与测试方式 | T3/T4 要写代码、T6 要跑测试；不知道 tsc 构建链与 version-sync 断言就会漏改声明点 | 语言+构建命令+测试命令 | 本地取证自证 | ✅ 已确认 |
| U6 | 「用户此刻使用的是哪个大模型」的权威判定来源 | 要求1/2 的整个分支逻辑的输入；取错源（如取子 Agent 自身模型）会全链路用错等级表 | 明确一个运行时字段/接口 | **主 Agent 已代问用户并拍板（H1）**：父会话当前 `modelSelection.model`，去空白转小写、qwen 前缀判定；本会话=qwen3.8-flash | ✅ 已确认（用户回复） |
| U7 | 静态等级表与宿主实际声明档位冲突时怎么办（如 qwen 宿主只暴露 low/medium/high 而无 xhigh） | 不定义钳制规则，T3 写出的约束函数在真实宿主上会直接报错或静默降级，违反要求5「品质非常高」 | 优先级规则+映射表+留痕要求 | **主 Agent 已代问用户并拍板（H1）**：静态前缀规则为权威 + 宿主声明档位取交集钳制（high→medium、max→xhigh；medium→low、xhigh→high）并留痕 | ✅ 已确认（用户回复） |
| U8 | 30 分钟预算（要求9）与「先问用户再执行」（要求7）的时间张力如何记账 | 结构性主要矛盾：等待用户回复可能清空全部预算，导致要么超时要么跳过澄清，两个要求必伤其一 | 等待是否计入预算 | **主 Agent 已代问用户并拍板（H1）**：等待用户回复时间不计入 30 分钟预算；澄清已全部获得答复 | ✅ 已确认（用户回复） |

无任何一项遭到用户拒绝回答；无需再次向用户发起询问。

## 2. 取证证据（U1–U5，全部可复核命令）

```
# U1 源码路径 = 运行加载态同源（符号链接实证）
$ readlink ~/.dsh/profiles/web/node_modules/dsh-workplan
../../../../Documents/Stocks/plugins/dsh-workplan
$ readlink ~/.dsh/profiles/headless/node_modules/dsh-workplan
../../../../Documents/Stocks/plugins/dsh-workplan

# U2 GitHub（package.json repository + git remote 双源一致）
origin  git@github.com:abbaababa/dsh-workplan.git (push)
"repository": { "url": "git+https://github.com/abbaababa/dsh-workplan.git" }

# U3 索引源链路（RELEASING.md §5 原文）
链路：awesome-dsh-plugin 仓库条目 data/plugins/abbaababa__dsh-workplan.yml
  → 上游 CI 探测 npm dist-tags.latest → 构建 docs/index.json
  → 发布 npm 包 dsh-plugin-catalog → jsDelivr → DSH 插件市场
本仓库权限边界：只能提条目 PR（2.3.2 先例：PR #13893，分支 bump229，ls-remote 权威头核实后重推）
上游条目仓库：github.com/awesome-dsh-plugin/awesome-dsh-plugin（fork：abbaababa/awesome-dsh-plugin）

# U4 版本基线三源一致
package.json            = 2.3.2
git tag --sort=-v:refname 首个 = v2.3.2（无 2.3.3+ 任何 tag/提交）
npm view dsh-workplan version = 2.3.2
CHANGELOG.md 首个小节   = ## 2.3.2 — 2026-11-10
git branch=main；git status --short 空（工作区干净）
→ 目标版本 2.3.9 为跳号直发（2.3.3–2.3.8 不发布），用户锚点已定死版本号，非不明项。

# U5 语言/框架/构建
TypeScript（tsconfig.json / tsconfig.test.json），Node >= 22（engines）
构建：npm run build（tsc → cp dist/*.js lib/ && cp dist/client.js client.js）
测试：npm test（build + tsc -p tsconfig.test.json + node scripts/run-tests.mjs）
版本四处一致断言：tests/version-sync.test.ts（package.json / package-lock.json / src/host.ts meta.version / CHANGELOG.md）
发布脚本：release.sh（一键：版本同步→check/test→commit+tag+push→GitHub Release 带 tgz 制品→npm publish→验证）

# U6 模型证据（本会话运行时头部）
"You are a coding agent powered by the qwen3.8-flash model" → qwen 前缀命中 → 等级集合 = {low, medium, xhigh}
```

## 3. 现有机制对范围界定的影响（交 T2/T3 的注意事项，非新问题）

- CHANGELOG 2.2.7 已实现「qwen 类模型推理档位兼容性」修复（宿主 dsh-llm 请求前校验档位）；本次 2.3.9 的 LLM 检测+等级约束是在其上**扩展**（分发前主动检测并注入规则告知），不是从零新建，T2 定位时须以现有实现为基线，避免重复造轮子或互相覆盖。
- 「部门负责人二次分配」在当前机制中不存在（现结构为 主Agent→部门子任务 一层），T4b 的 workplan_delegate 属净新增能力，权限校验须对齐现有 lineage 校验惯例。

## 4. 后续子任务可直接引用的最终事实块（A3）

```json
{
  "pluginRoot": "/Users/open/Documents/Stocks/plugins/dsh-workplan",
  "loadedVia": ["~/.dsh/profiles/web/node_modules/dsh-workplan", "~/.dsh/profiles/headless/node_modules/dsh-workplan"],
  "githubRepo": "git@github.com:abbaababa/dsh-workplan.git",
  "githubHttps": "https://github.com/abbaababa/dsh-workplan",
  "indexSource": "PR entry data/plugins/abbaababa__dsh-workplan.yml to github.com/awesome-dsh-plugin/awesome-dsh-plugin; upstream CI publishes npm dsh-plugin-catalog consumed via jsDelivr",
  "currentVersion": "2.3.2",
  "targetVersion": "2.3.9",
  "language": "TypeScript",
  "nodeEngine": ">=22",
  "buildCmd": "npm run build",
  "testCmd": "npm test",
  "releaseScript": "./release.sh --version 2.3.9 --summary \"...\" --yes",
  "versionSyncPoints": ["package.json", "package-lock.json", "src/host.ts meta.version", "CHANGELOG.md"],
  "modelForDetection": "qwen3.8-flash (parent session modelSelection.model, per H1)",
  "effortTableQwen": ["low", "medium", "xhigh"],
  "effortTableOther": ["low", "high", "max"],
  "clampRule": "static-prefix-authoritative ∩ host-declared; high→medium, max→xhigh, medium→low, xhigh→high; leave trace",
  "budgetRule": "user-reply wait excluded from 30-min budget (per H1/U8)"
}
```
