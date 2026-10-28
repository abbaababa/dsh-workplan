# dsh-workplan 版本升级与回滚策略（T4 · 发布工程师）

> 插件根：`<repo>`（以下相对路径均以它为根）
> 当前版本：**1.4.3**（本文件写作时源码与产物仍是 1.4.3，**T4 没有改版本号**）
> 阶段：方案设计与验收标准定义 · 日期：2026-10-28（Asia/Shanghai）
> T4 边界：只定义版本递增、变更记录、构建校验、回滚路径，并做隔离目录预演。
> T4 落盘物只有两件：本文件；改造前快照 `.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz`。
> **未改动任何插件源码、版本号或运行实例；未重启任何服务。**

> **更正（Lead 复核，2026-10-28 14:26 Asia/Shanghai）**：本文件原有多处以「插件目录没有 git」为前提，
> 与事实不符——`ls -d .git` 存在，`git rev-parse --show-toplevel` 输出就是本插件目录，当前分支 `main`，
> 已有 tag `v1.4.3`，`git status` 显示跟踪 `origin/main`。正确口径是：**回滚首选 git**
> （`git checkout -- .` 放弃未提交改动、`git reset --hard <commit>` 回到已知提交），
> `.backups/` 快照负责覆盖「未提交改动、未跟踪文件、被 .gitignore 忽略的构建产物」这些 git 不保存的状态，
> 二者互补。§1.4、§3.3、§4.3 与 §6 风险表中的旧表述已同步修正。发布动作（commit / tag / npm publish）
> 仍属未授权，需用户明确要求后才执行。

---

## 0. 结论速览

| 项目 | 结论 | 依据 |
|---|---|---|
| 下一个版本 | **1.5.0（minor）** | 本次是新增“图表化进度展示”的用户可见能力，对外载荷不变；与 1.4.0（引入分组 + chart.js）同级 |
| 递增入口 | `npm version 1.5.0 --no-git-tag-version` | 一条命令同时更新 `package.json` 与 `package-lock.json` 的两处版本字段；隔离目录实测 exit 0 |
| 需要手工改的版本点 | 只有 `src/host.ts:328` 的 `meta.version` | `lib/host.js`、`dist/host.js` 由 `npm run build` 生成；`client.js` 不包含版本号 |
| 构建校验 | `npm run check`、`npm test`、7 处版本一致性检查 | 1.4.3 基线：check exit 0、test **90/90**；1.5.0 预演同样通过 |
| 回滚方式 | 整树快照恢复（**不支持局部回滚**） | 快照 349 KB、51 项、SHA-256 `b8ccc0ef…6993c7` |
| 运行实例 | 需要主 Agent 重启 DSH（或重新加载 web profile） | 宿主在进程启动时加载 `lib/host.js`；T4 无重启权限，未执行 |

一句话流程：**备份 → 实现 → 递增版本 → 写 CHANGELOG → 构建 → 7 处版本一致性 + check + test → 主 Agent 重启 → 真机走查；失败则整树回滚并重跑 90 项测试。**

---

## 1. 事实基线（全部可复核）

### 1.1 版本号出现在哪些地方

| # | 位置 | 当前值 | 性质 | 维护方式 |
|---|---|---|---|---|
| 1 | `package.json:3` | 1.4.3 | npm 包版本，插件管理器读取 | 人工（用 `npm version` 改） |
| 2 | `package-lock.json:3` | **1.3.7** | 锁文件根版本，仅 npm 元数据 | 人工/`npm version`（**当前不一致**） |
| 3 | `package-lock.json:9`（`packages[""]`） | **1.3.7** | 同上 | 同上（**当前不一致**） |
| 4 | `src/host.ts:328` | 1.4.3 | 插件 `meta.version`，DSH 看到的版本 | 人工改一行 |
| 5 | `lib/host.js:297` | 1.4.3 | **运行时真正加载**的文件（`package.json` `main`） | `npm run build` 生成 |
| 6 | `dist/host.js:297` | 1.4.3 | 编译中间产物 | `npm run build` 生成 |
| 7 | `CHANGELOG.md:1` | 1.4.3 | 变更记录顶部标题 | 人工写 |

补充事实：

- **`src/client.ts` 没有任何版本号引用**（`grep -c version src/client.ts` → `0`），因此浏览器端 `client.js` 不是版本点，不需要为版本递增而单独改它。
- **T4 新发现（重要）**：`package-lock.json` 两处仍是 **1.3.7**，与 `package.json` 1.4.3 不一致。1.4.3 修复报告第 177 行核对的是 `package.json` / `src/host.ts` / `lib/host.js` / `dist/host.js` 四处，**没有把锁文件算进去**。
  - 影响：不影响插件运行（运行只读 `lib/host.js`），但违反“版本同步”；任何按锁文件判断版本的检查都会报 1.3.7。
  - 修法（本机隔离目录实测）：`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` 只把这两行改成 1.4.3，diff 恰好 2 处，73 ms 完成。
  - 收口：本次发布用 `npm version` 一步升到 1.5.0，锁文件自然同步；回滚后再用同一命令同步回 1.4.3。

### 1.2 安装形态：只有一份代码，改仓库即可

- web profile 的依赖声明是**软链接**：
  `~/.dsh/profiles/web/package.json:18` → `"dsh-workplan": "link:<repo>"`。
- 实际链接已核验：
  `~/.dsh/profiles/web/node_modules/dsh-workplan -> ../../../../Documents/Stocks/plugins/dsh-workplan`。
- 结论：
  1. **没有第二份需要同步的插件副本**，不需要把文件复制到 profile；版本递增只改仓库。
  2. profile 的 `pnpm-lock.yaml` 只记录 `link:`，**没有版本号**，无需修改。
  3. 但宿主进程启动时 `import` 的是 `lib/host.js`；**只刷新浏览器不会重新加载宿主模块**。所以“升级/回滚是否生效”最终取决于**主 Agent 重启 DSH（或重新加载 web profile）**。
  4. profile 里存在 `"patchReload": "live"`（`~/.dsh/profiles/web/package.json:49`），但它是否覆盖 `lib/host.js` 的模块重载**本轮未验证**，不能当作“免重启”的依据。

### 1.3 构建链：只有两个手工版本点，其余全是生成物

`package.json:40` 的构建脚本：

```text
rm -rf dist && tsc -p tsconfig.json && cp dist/plan.js dist/runtime.js dist/host.js dist/watchdog.js lib/ && cp dist/client.js client.js
```

即：

```text
src/*.ts ──tsc──> dist/*.js ──cp──> lib/*.js（宿主运行时加载）
                              └──cp──> client.js（浏览器端）
```

规则：

- **禁止手改** `lib/host.js`、`dist/host.js`、`client.js`：下次 `npm run build` 会被覆盖，且容易出现源码与产物版本不一致。
- 版本递增后**必须重建**，否则 `lib/host.js` 仍报旧版本（1.4.3 报告里“四处交叉核对”就是查这个）。
- `tsconfig.json` 只编译 `src/**/*.ts`，不包含 `tests/` 与 `scripts/`；测试由 `tsconfig.test.json` 单独编译到 `dist-tests/`。

### 1.4 目录里有 git，快照与提交互补

- 插件目录**是独立 git 仓库**：`git rev-parse --show-toplevel` 输出即本目录，分支 `main`，已有 tag `v1.4.3`，跟踪远端 `origin/main`。
- 回滚首选 git：`git checkout -- .`（放弃未提交改动）或 `git reset --hard <commit>`；git 不保存被 `.gitignore` 忽略的构建产物与未跟踪文件，所以 `.backups/` 下的**带时间戳整树快照**仍要保留，作为「未提交 + 未跟踪」状态的取证与兜底。
- 发布动作（commit / tag / npm publish）未获用户授权前不执行；CHANGELOG 记录快照名与 SHA-256，发布后由 commit hash 与 tag 补齐审计链。

---

## 2. 版本递增规则与本次判定

### 2.1 采用 SemVer 2.0.0 的三段式

参考标准：[Semantic Versioning 2.0.0](https://semver.org/)。本项目把它落到下表（结合已有版本历史）：

| 级别 | 触发条件 | 本项目先例 |
|---|---|---|
| **MAJOR**（x.0.0） | 破坏性变更：计划报文/`PLAN_VERSION`/工具 JSON Schema 不兼容，或需要数据迁移 | 尚无 |
| **MINOR**（1.x.0） | 向后兼容的**新增用户可见能力**：新图表形态、新视觉层级、新数据映射；对外载荷不变 | 1.4.0：新增“进行中/已完成”分组 + chart.js 图表 |
| **PATCH**（1.4.x） | 仅缺陷修复/内部重构：不新增用户可见形态 | 1.4.1、1.4.2、1.4.3 |

判定口径：

- 只要“用户能看到一个新的图形/新的视觉编码方式/新的信息层级”，就是 **MINOR**；
- 只是把现有元素改颜色、改字号、修不可见/截断/对比度，属于 **PATCH**；
- 只有改动对外数据结构或工具参数且不兼容时，才是 **MAJOR**。

### 2.2 本次为什么是 1.5.0

- 用户诉求是“**通过图表等形式突出显示画圈部分**”，T1 已定位画圈区域目前只是折叠卡片的 12px 文本 meta 行、54×5px 迷你条和组头摘要（`src/client.ts:1356-1361`、`621-630`、`1671-1673`）。
- 改造会新增**图表化呈现与视觉层级**（具体形态由 T2 方案定），属于“向后兼容的新用户可见能力”，不是单纯修一个缺陷。
- 计划对外载荷（`statuses / stats / departments`）与工具 Schema 按设计**不需要变**；若最终确实没变，则不是 MAJOR。
- 因此：**1.4.3 → 1.5.0（minor）**。

### 2.3 允许的降级与禁止项

- **降级为 1.4.4（patch）的唯一条件**：最终实现只是修复“0% 不可见/百分比被截断/对比度不足”，**没有新增任何图形或视觉层级**。这与用户“用图表等形式突出显示”的诉求不符，属于范围被砍小，必须先由主 Agent 向用户确认。
- **禁止**为了“看起来升级多”而跳 2.0.0；没有破坏性变更就不允许 MAJOR。
- **禁止**使用 `1.5.0-rc.1` 之类预发布后缀：插件通过 `link:` 直接加载，profile 不解析版本范围，后缀只会制造第四个版本字符串。
- 版本递增应在**实现完成、准备验收时**执行，不要在写代码前先把版本改掉，避免源码与产物错位。

---

## 3. 变更记录方式

### 3.1 唯一权威记录：`CHANGELOG.md` 顶部新增一节

格式沿用 1.4.3 的结构（`## x.y.z — YYYY-MM-DD` + 分节），新版本条目放在文件第 1 行之前：

```markdown
## 1.5.0 — 2026-10-28

**一句话定位：把“画圈区域”的平铺文本升级为可一眼读懂的图表化进度层级。**

### 新增（用户可见）
- 画圈①②（折叠卡片 meta 行）：[按 T2 方案填写：图形形态、尺寸、百分比文本、0% 状态如何可见]
- 画圈③（组头摘要/空组）：[按 T2 方案填写：组头图表或三态条、空组如何表达]
- 视觉层级：[按 T2 方案填写：字号/字重/对比度/位置]

### 修复
- 0% 时迷你条轨道与折叠按钮同色、fill 宽 0，完全不可见（`src/client.ts:621-630`、`759`）
- 百分比只写在 `title` 属性，触屏无 hover 永远看不到（`src/client.ts:1358`）
- meta 行 12px 次要色，组摘要 nowrap + 省略号把百分比截掉（`src/client.ts:783`、`432`）
- 图表固定在两组之后，首屏看不到（`src/client.ts:1967-1969`）
- 空组仍显示“0/0 + 完成率暂无数据”（画圈③）

### 验证
- `npm run check`：exit 0
- `npm test`：**N / N 通过**（1.4.3 基线 90/90；N = 90 + 本轮新增用例数）
- 7 处版本一致性检查：全部 `1.5.0`
- 版本一致性命令与输出：见 `docs/version-upgrade-rollback-1.5.0-20261028.md` §5
- 真实页面（主 Agent 重启后）：0% / 部分完成 / 100% 三态，窄屏（约 440×888）与宽屏各一张截图
- 截图/走查记录：[填写报告文件名与截图路径]

### 兼容性
- 对外载荷（`statuses`、`stats`、`departments`）与工具 JSON Schema 未变；`PLAN_VERSION` 仍为 1（`src/plan.ts:12`）
- 旧会话记录可照常读取；展示层变更不回写历史
- **运行实例需重启 DSH（或重新加载 web profile）才会使用 1.5.0**

### 回滚
- 快照：`.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz`
- SHA-256：`b8ccc0efa7c307160739ffecdb4af44daab44b3a0f0c779c74d9d0783f6993c7`
- 步骤：见 `docs/version-upgrade-rollback-1.5.0-20261028.md` §6
- 回滚后基线：`npm test` 90/90、`npm run check` exit 0
```

填写要求：

1. **每条“修复”必须有代码行号或复现证据**，不能写“优化了观感”这类无法验收的话。
2. “验证”必须贴**真实命令与真实结果**；没跑过的命令不许写“通过”，只能写“未验证”。
3. 若最终没改某个代码点，就不要把它写进“修复”。
4. 日期用发布/验收当天的日期（Asia/Shanghai）；如果跨天，以主 Agent 重启验收的日期为准。

### 3.2 配套报告

- 实现与验收报告：`docs/progress-visualization-report-1.5.0.md`（名称可由主 Agent 统一，但 CHANGELOG 必须链接到实际文件）。
- 内容至少包含：改造前后对比截图、图表形态与数据映射、0%/部分/100% 三态、宽窄屏、无障碍（百分比必须有文本，不只靠颜色）、验证命令输出。
- 设计阶段的 T1 定位报告：`docs/progress-visualization-locate-20261028.md`；本策略：本文件。历史报告不因回滚而删除（`docs/` 被回滚命令排除）。

### 3.3 如何在 git 与 CHANGELOG 之间留痕

- 每次发布/回滚都写 CHANGELOG；快照名带时间戳；在 CHANGELOG 的“回滚”节写 SHA-256；发布后补 commit hash 与 tag（如 `v1.5.0`）。
- **回滚记录不能删历史**：
  - 若 1.5.0 尚未在主 Agent 的运行实例里重启、用户从未看到：可以撤掉未发布的条目，并在 `docs/` 留一份“未发布即回滚”的说明；
  - 若 1.5.0 已经重启并对用户可见：**保留 1.5.0 条目**，在其顶部加 `> 已回滚：时间 / 原因 / 恢复快照 SHA-256 / 验证结果`，然后另起一个 patch 版本修复，不允许把历史抹掉。

---

## 4. 升级操作手册（带注释版）

> 顺序不能颠倒：**先备份，再实现，最后递增版本 + 写记录 + 构建 + 校验**。
> 所有命令默认在 `<repo>` 执行。

### 4.1 预检（改动前）

```bash
cd <repo>

# 1) 确认当前版本基线仍是 1.4.3（T4 写作时如此）
grep -n '"version": "1.4.3"' package.json
grep -n "version: '1.4.3'" src/host.ts lib/host.js

# 2) 确认类型检查干净（T4 实测 exit 0）
npm run check

# 3) 记录测试基线（T4 实测 90/90）
npm test

# 4) 确认没有正在派发的计划
#    这一步 T4 无法从插件外部可靠判断，必须由主 Agent / 用户在界面上确认“没有执行中的计划”后再开始。
```

预检不通过（比如已有源码改动导致版本不是 1.4.3）时，**不要继续递增**：先确认改动归属，必要时从快照恢复干净基线。

### 4.2 改造前快照（T4 已生成，勿覆盖）

已生成：

```text
.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz
```

- 大小 349 KB；`tar -tzf` 共 51 项；包含 `src/ lib/ dist/ client.js tests/ scripts/ package.json package-lock.json tsconfig*.json cordis.patch.yml CHANGELOG.md locale/ vendor/ icon.svg`。
- SHA-256：`b8ccc0efa7c307160739ffecdb4af44daab44b3a0f0c779c74d9d0783f6993c7`。
- **不包含** `node_modules/`、`.backups/`、`docs/`、`dist-tests/`。
- 该快照必须在**任何实现改动之前**生成；T4 已确认生成时源码为 1.4.3、`npm test` 90/90。
- 如果实现过程中需要再加备份，命名必须是 `v1.5.0-pre-xxx-<时间戳>.tar.gz` 之类，**不得覆盖**这份 1.4.3 快照；也不要在半成品状态下重做这份“1.4.3 回滚包”。

校验命令：

```bash
cd <repo>
tar -tzf .backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz | wc -l   # 期望 51
shasum -a 256 .backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz       # 期望以 b8ccc0ef 开头
```

### 4.3 递增版本（实现完成后执行）

```bash
cd <repo>

# 只改 package.json + package-lock.json 的两处版本；--no-git-tag-version 表示只升版本、不打 tag（打 tag 由用户在发布时决定）
npm version 1.5.0 --no-git-tag-version

# 手工改插件 meta.version 这一行（src/host.ts:328）
perl -0pi -e "s/version: '1\.4\.3'/version: '1.5.0'/" src/host.ts
grep -n "version: '1.5.0'" src/host.ts
```

说明：

- `npm version` 在隔离目录实测：exit 0，`package.json:3`、`package-lock.json:3`、`package-lock.json:9` 三处同时变 1.5.0。
- 如果 `npm version` 因环境原因失败，**先停下来排查**，不要手改 `package-lock.json` 后继续；备选是 `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`（实测只改两行），但必须在 `package.json` 已改成 1.5.0 之后执行。
- **不要**手改 `lib/host.js` / `dist/host.js` / `client.js`。

### 4.4 写 CHANGELOG

按 §3.1 模板把 `## 1.5.0 — 2026-10-28` 一节插到 `CHANGELOG.md` 第 1 行之前。
这一步必须在跑“7 处版本一致性检查”之前完成，否则检查会因 CHANGELOG 仍是 1.4.3 而失败（这是预期行为，不是缺陷）。

### 4.5 构建与校验

```bash
cd <repo>

# 重新生成 dist/、lib/、client.js；版本号会进入 lib/host.js 与 dist/host.js
npm run build

# 1) 类型检查
npm run check

# 2) 完整测试（会再次 build；1.4.3 基线 90/90，1.5.0 应 0 fail）
npm test

# 3) 7 处版本一致性（见 §5 的完整脚本；期望 [PASS] 7 处版本均为 1.5.0）
```

产物抽查：

```bash
grep -n "version: '1.5.0'" src/host.ts lib/host.js dist/host.js
grep -n '"version": "1.5.0"' package.json package-lock.json
head -1 CHANGELOG.md
```

### 4.6 运行实例重载（T4 不能执行，交给主 Agent）

1. 由**主 Agent** 重启 DSH Web 进程（或重新加载 web profile）。T4 是子 Agent，无重启/安装权限，**未执行、也不会等待**。
2. 重启后确认：
   - 进程启动时间晚于 `lib/host.js` 的构建时间；
   - 插件管理器/关于页显示的 dsh-workplan 版本为 1.5.0（若界面没有版本展示，则以 `lib/host.js:297` + 进程启动时间为准，并注明“界面未展示版本”）；
   - 浏览器强刷后，画圈①②③ 的图表化展示出现，0% 状态也可见；
   - 再跑一次真实派发，确认进度数字与图表一致（不改服务端统计语义）。
3. 截图保存到 `docs/` 并在 CHANGELOG “验证”节引用。

> 重要：在重启之前，文件已经是 1.5.0，但**运行中的进程仍是 1.4.3**。这段时间不要用界面表现判断升级是否成功。

---

## 5. 可直接复制命令清单（无注释版）

> 说明：本节与 §6 的命令是**验收/回滚用的运维命令**，不是插件实现代码；插件源码、测试与构建仍全部是 TypeScript。
> 若要把版本检查长期固化，建议由实现轮次新增 `scripts/check-version-consistency.ts`（用 `node --experimental-strip-types` 运行）；T4 为避免越界，**没有擅自新增脚本文件**。

### 5.1 7 处版本一致性检查（严格模式，失败 exit 1）

在插件根目录执行：

```bash
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
const read = (p) => readFileSync(p, 'utf8')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
const meta = (p) => read(p).match(/version: '([^']+)'/)?.[1] ?? '(missing)'
const changelog = read('CHANGELOG.md').match(/^## ([0-9]+\.[0-9]+\.[0-9]+)/m)?.[1] ?? '(missing)'
const expected = pkg.version
const rows = {
  'package.json': pkg.version,
  'package-lock.json': lock.version,
  'package-lock.json#packages[""]': lock.packages[''].version,
  'src/host.ts': meta('src/host.ts'),
  'lib/host.js': meta('lib/host.js'),
  'dist/host.js': meta('dist/host.js'),
  'CHANGELOG.md (top)': changelog,
}
let bad = 0
for (const [name, value] of Object.entries(rows)) {
  if (value !== expected) { console.error(`[FAIL] ${name}: ${value} != ${expected}`); bad++ }
}
if (bad > 0) process.exit(1)
console.log(`[PASS] ${Object.keys(rows).length} 处版本均为 ${expected}`)
NODE
```

**当前 1.4.3 基线的真实结果（T4 实测）**：

```text
[FAIL] package-lock.json: 1.3.7 != 1.4.3
[FAIL] package-lock.json#packages[""]: 1.3.7 != 1.4.3
exit 1
```

这是 T4 发现的锁文件漂移，不是本次改造引入；按 §4.3 递增到 1.5.0 后会自然变一致（隔离目录预演已 PASS 7/7）。

### 5.2 发布校验（1.5.0，按顺序）

```bash
cd <repo>
npm run check
npm test
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
const read = (p) => readFileSync(p, 'utf8')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
const meta = (p) => read(p).match(/version: '([^']+)'/)?.[1] ?? '(missing)'
const changelog = read('CHANGELOG.md').match(/^## ([0-9]+\.[0-9]+\.[0-9]+)/m)?.[1] ?? '(missing)'
const expected = pkg.version
const rows = {
  'package.json': pkg.version,
  'package-lock.json': lock.version,
  'package-lock.json#packages[""]': lock.packages[''].version,
  'src/host.ts': meta('src/host.ts'),
  'lib/host.js': meta('lib/host.js'),
  'dist/host.js': meta('dist/host.js'),
  'CHANGELOG.md (top)': changelog,
}
let bad = 0
for (const [name, value] of Object.entries(rows)) {
  if (value !== expected) { console.error(`[FAIL] ${name}: ${value} != ${expected}`); bad++ }
}
if (bad > 0) process.exit(1)
console.log(`[PASS] ${Object.keys(rows).length} 处版本均为 ${expected}`)
NODE
```

验收口径：

- `npm run check`：exit 0。
- `npm test`：`fail 0`；总用例数 = 1.4.3 基线 90 + 本轮新增；**不能有 skipped 顶替通过**。
- 版本检查：`[PASS] 7 处版本均为 1.5.0`。
- 版本号是否真的被运行实例加载：由主 Agent 重启后按 §4.6 确认。

---

## 6. 回滚策略

### 6.1 回滚物（不可变）

| 项 | 值 |
|---|---|
| 快照文件 | `.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz` |
| 大小 | 349 KB |
| 条目数 | 51 |
| SHA-256 | `b8ccc0efa7c307160739ffecdb4af44daab44b3a0f0c779c74d9d0783f6993c7` |
| 覆盖内容 | `src/ lib/ dist/ client.js tests/ scripts/ package.json package-lock.json tsconfig*.json cordis.patch.yml CHANGELOG.md locale/ vendor/ icon.svg` |
| 不覆盖 | `node_modules/ .backups/ docs/ dist-tests/` |

### 6.2 何时回滚

满足任意一条即回滚，不在运行实例上“带病继续”：

1. `npm test` 失败且 30 分钟内无法定位根因；
2. 构建反复失败，或 `lib/host.js` 版本与源码不一致无法收敛；
3. 重启后画圈区域仍然不直观/出现遮挡/0% 不可见等**用户可见回归**，且当天无法修复；
4. 进度数字与图表出现新的不一致（破坏 1.4.3 的“单一派生源”承诺）；
5. 用户明确要求退回 1.4.3。

### 6.3 回滚步骤（带注释版）

前置条件：

- 由主 Agent/用户确认**没有正在派发的计划**（内存态派发中回滚会留下孤儿运行）；
- 告知用户回滚窗口；回滚期间不要刷新页面做验收。

```bash
cd <repo>

# 1) 解包到临时目录（不要直接 tar 到仓库根：tar 不会删除 1.5.0 新增的文件）
TMP=$(mktemp -d /tmp/dsh-wp-rollback-XXXXXX)
tar -xzf .backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz -C "$TMP"

# 2) 先核对解包出来的版本确实是 1.4.3
grep -n "version: '1.4.3'" "$TMP/src/host.ts" "$TMP/lib/host.js"
grep -n '"version": "1.4.3"' "$TMP/package.json"

# 3) 整树恢复：
#    --delete 删除 1.5.0 新增的源码/测试/根目录文件（整树回滚的关键）
#    --exclude 保护 node_modules（依赖）、.backups（快照本身）、docs（证据文档）
#    dist-tests 会被删掉，随后由 npm test 重新生成
rsync -a --delete --exclude node_modules --exclude .backups --exclude docs "$TMP"/ ./

# 4) 清理临时目录
rm -rf "$TMP"

# 5) 恢复后重建一次，确保 lib/、client.js、dist/ 与 1.4.3 源码一致
npm run build

# 6) 锁文件版本同步回 1.4.3（快照里的 lock 仍是历史 1.3.7，只改两行元数据）
npm install --package-lock-only --ignore-scripts --no-audit --no-fund

# 7) 验证
npm run check
npm test
```

回滚后的预期：

- `grep -n "version: '1.4.3'" src/host.ts lib/host.js dist/host.js` 全部为 1.4.3；
- `package.json`、`package-lock.json` 两处、CHANGELOG 顶部均为 1.4.3；
- `npm run check` exit 0；`npm test` **90/90、0 fail**；
- `docs/` 下证据文档仍在（被 `--exclude docs` 保护），`.backups/` 快照仍在。

然后由**主 Agent** 再次重启 DSH / 重新加载 web profile，旧版本代码才真正回到进程里；在重启前，运行中的仍是 1.5.0。

### 6.4 可直接复制命令（无注释版）

```bash
cd <repo>
TMP=$(mktemp -d /tmp/dsh-wp-rollback-XXXXXX)
tar -xzf .backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz -C "$TMP"
rsync -a --delete --exclude node_modules --exclude .backups --exclude docs "$TMP"/ ./
rm -rf "$TMP"
npm run build
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

### 6.5 数据兼容性：为什么回滚不影响历史计划

- 插件没有数据库迁移：计划状态保存在会话事件（`<!-- DSH-WORKPLAN:… -->` 载荷）与内存中，计数由 `derivePlanSnapshot` 在读取时派生（1.4.3 起），不存在需要回滚的表结构。
- 1.4.3 的 `validatePlan`（`src/plan.ts:607-626`）只读取已知字段并重建计划对象，**不拒绝未知字段**；因此 1.5.0 即使新增了可选展示字段，1.4.3 也能读取旧计划，不会因多字段崩溃。
- 但有一条硬边界：**1.5.0 不得改变现有字段的含义**。如果改变了，回滚后 1.4.3 会按旧语义显示，这不是“回滚失败”，而是版本语义差异。本次定位为展示层改造，按设计不触碰 `stats` 语义。
- 重启会丢失内存中的派发态，这是既有行为（1.3.7 起支持按 `planId` 从会话存档重建旧计划，见 `CHANGELOG.md` 1.3.7）；回滚重启不会额外破坏历史计划，但**正在跑的派发会中断**，所以必须先等它结束或取消。

### 6.6 禁止事项

- **禁止局部回滚**（比如只还原 `client.js` 而宿主仍是 1.5.0）：会造成宿主/客户端版本不一致，恰好是本策略要防的问题。
- **禁止**只 `tar -xzf` 到仓库根就结束：新增文件不会被删除，`src/` 里会残留 1.5.0 文件，`npm test` 可能编译到它们。
- **禁止**手改 `lib/host.js` 或 `dist/host.js` 来“临时回退版本”；必须重建。
- **禁止**删除 `.backups/` 下的历史快照；它们是「未提交改动 + 未跟踪文件 + 被忽略的构建产物」的唯一取证物（git 只覆盖已跟踪路径，不能替代快照）。

### 6.7 回滚后的记录

- 在 `docs/` 新增 `rollback-1.5.0-<时间戳>.md`，记录：触发原因、执行时间、恢复快照 SHA-256、回滚后 `check`/`test` 的真实输出、运行实例重启时间。
- 按 §3.3 处理 CHANGELOG：未发布可撤条目；已发布保留并加“已回滚”说明。

---

## 7. 风险与对策

| 风险 | 现状/证据 | 对策 |
|---|---|---|
| **锁文件版本漂移**（version 不一致） | `package-lock.json:3,9` = 1.3.7，`package.json` = 1.4.3（T4 实测） | 用 `npm version` 单一入口；发布前跑 §5.1 的 7 处检查；禁止手改 package.json 后不更新 lock |
| 生成物与源码版本不一致 | `lib/host.js`/`dist/host.js` 由 build 生成；手改会被覆盖 | 只改 `src/host.ts` + `package.json`；递增后必须 `npm run build`；用 §5.1 检查 |
| 以为刷新页面就升级 | 宿主在进程启动时加载 `lib/host.js`；`patchReload: live` 是否覆盖宿主模块**未验证** | 由主 Agent 重启 DSH / 重载 web profile；以进程启动时间 > 构建时间作为证据 |
| 回滚后残留 1.5.0 新文件 | `tar -xzf` 不会删除目标端多余文件 | 用 §6.3 的 `rsync --delete` 整树恢复；`--exclude` 保护 node_modules/.backups/docs |
| 回滚时仍在派发 | 回滚重启会中断内存派发 | 回滚前由主 Agent/用户确认无执行中计划；必要时先取消 |
| 回滚后锁文件仍是 1.3.7 | 快照本身包含历史 lock | 回滚步骤第 6 步同步到 1.4.3；实测只改两行，checker 变 PASS |
| 测试数被改动掩盖回归 | 本轮会新增测试，总数不再是 90 | 验收看 `fail 0` + 1.4.3 的 90 项仍存在；不能只看“总数变多” |
| 版本检查顺序错 | checker 包含 CHANGELOG 顶部 | 先写 CHANGELOG 再跑 checker，否则是预期 FAIL |
| 快照被半成品覆盖 | 实现过程中可能误建备份 | 1.4.3 快照保持不可变；新备份另起名字（`v1.5.0-pre-…`） |
| 只依赖快照、忘了目录其实有 git | 目录是 git 仓库（tag `v1.4.3`、远端 `origin`） | 优先 `git checkout -- .` / `git reset --hard <commit>`；快照用于未提交与未跟踪状态；禁止删除 `.backups/` |
| Node 版本差异 | 本机 Node v26.9.0、npm 12.0.2；`engines` 要求 >=22 | 在目标环境再跑一次 `npm run check`/`npm test`；tsc target ES2022 |
| 日期/时区写错 | CHANGELOG 只写日期 | 统一 Asia/Shanghai；以重启验收日为准，跨天要改 |

---

## 8. 验收对照（T4 交付标准）

| 验收标准 | 证据 | 状态 |
|---|---|---|
| 版本递增级别有依据 | §2 的 SemVer 映射 + 1.4.0（minor 先例）/1.4.1-1.4.3（patch 先例）+ 本次“新增图表化能力”的判定；结论 1.5.0 | **满足（策略层）** |
| 回滚步骤可执行 | T4 在隔离目录实际解包快照 → `npm run check` exit 0、`npm test` 90/90；再用 `rsync --delete` 模拟整树恢复，新增文件被删除、8 个关键文件与快照一致、check exit 0 | **满足（已实测）** |
| 回滚不影响其他功能 | 回滚后完整测试 90/90；插件通过 `link:` 独立安装，不触碰其他插件；计划数据无库表迁移；回滚不删除 `docs/` 与 `.backups/` | **满足（隔离环境）** |
| 版本点位清单完整 | §1.1 列出 7 处，并发现 `package-lock.json` 两处历史漂移 | **满足（含新发现）** |
| 升级流程可执行 | 隔离目录完整预演：`npm version 1.5.0` exit 0 → build exit 0 → 7 处 checker PASS → `npm run check` exit 0 → `npm test` 90/90 | **满足（预演）** |
| 变更记录有规范 | §3 给出 CHANGELOG 模板、报告路径、回滚记录规则 | **满足** |
| 运行实例升级路径明确 | §4.6 写明由主 Agent 重启并给出 4 条验收点；T4 未重启 | **满足（责任已交接）** |

---

## 9. 未验证与遗留（明确列出，不当作已完成）

1. **1.5.0 尚未落到源码**：本文件写作时 `src/`、`lib/`、`client.js`、`package.json` 仍是 1.4.3；版本递增与改造由后续实现轮次执行。
2. **真实界面未验证**：未重启 DSH、未截取 1.5.0 页面；画圈区域的最终观感需要主 Agent 重启后走查。
3. **`patchReload: live` 对宿主模块的作用未验证**：不能据此承诺“无需重启”；仍按重启执行。
4. **插件管理器/关于页的版本展示方式未验证**：若界面不显示版本，需用 `lib/host.js:297` + 进程启动时间作为证据，并在报告中注明。
5. **重启/重载 DSH 的具体命令未在本轮确认**：T4 无权限，不猜测命令；由主 Agent 按现有部署方式执行。
6. **`npm install --package-lock-only` 是否访问网络未验证**：本机 73 ms 完成且只改两行，但未抓包确认。
7. **Node 26.9.0 之外的版本未预演**：`engines` 是 >=22，目标环境需再跑 check/test。
8. **T3 最终是否新增源码文件/是否改载荷未定**：回滚流程用 `rsync --delete` 已覆盖“新增文件”场景；但若改动 `PLAN_VERSION` 或工具 Schema，本策略的“兼容回滚”前提不成立，必须先由主 Agent 重新评审。
9. **截图对应运行实例的 DOM 级版本**：沿用 T1 的未验证项；1.4.3 截图与源码布局一致，但未逐字节核验构建产物。
10. **测试总数**：1.5.0 若新增用例，总数会大于 90；本策略只把 90 作为“1.4.3 回归基线”，不把“数字变大”当验收。

---

## 10. 证据记录（T4 实际执行，全部在隔离目录，未改 live 源码）

### 10.1 1.4.3 基线

| 命令 | 结果 |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | exit 0；tests 90、pass 90、fail 0（duration 约 4.1 s） |
| 7 处版本检查 | exit 1；仅 `package-lock.json` 两处为 1.3.7，其余 1.4.3（锁文件漂移） |

### 10.2 快照与完整性

| 项 | 结果 |
|---|---|
| 快照 | `.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz` |
| 大小 / 条目 | 349 KB / 51 |
| SHA-256 | `b8ccc0efa7c307160739ffecdb4af44daab44b3a0f0c779c74d9d0783f6993c7` |
| 生成时机 | T4 预演前，源码仍为 1.4.3 |

### 10.3 回滚预演 A：解包到临时目录后全量验证

- 临时目录：`/tmp/wp-rollback-verify-ZoRV3F`（解包 + `node_modules` 软链）。
- 关键文件与 live 逐一 `cmp`：`src/host.ts`、`src/client.ts`、`package.json`、`package-lock.json`、`client.js`、`lib/host.js`、`CHANGELOG.md` 全部 SAME。
- 版本：`src/host.ts:328` 与 `lib/host.js:297` 均为 1.4.3。
- `npm run check` → exit 0。
- `npm test` → **90/90、0 fail**（exit 0）。

### 10.4 回滚预演 B：`rsync --delete` 整树恢复

- 在副本里人为制造 1.5.0 痕迹：新增 `src/visual-new.ts`、修改 `src/client.ts`。
- 用 §6.3 的 `rsync -a --delete …` 恢复。
- 结果：
  - `src/host.ts`、`src/client.ts`、`src/plan.ts`、`package.json`、`package-lock.json`、`client.js`、`lib/host.js`、`CHANGELOG.md` 与快照/ live 全部 SAME；
  - `src/visual-new.ts` 被删除（证明整树回滚能清掉新增文件）；
  - `npm run check` → exit 0；
  - `dist-tests/` 被删除（属生成物，`npm test` 会重建），`node_modules/`、`.backups/`、`docs/` 被保护。

### 10.5 回滚后锁文件同步

- 在 1.4.3 恢复副本上执行 `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`。
- diff 恰好 2 行：`"version": "1.3.7"` → `"1.4.3"`（根与 `packages[""]`）。
- 7 处版本检查 → `[PASS] 7 处版本均为 1.4.3`，exit 0；`npm run check` → exit 0。

### 10.6 升级预演（隔离目录 `/tmp/wp-upgrade-dryrun-ZG9HRS`）

| 步骤 | 结果 |
|---|---|
| `npm version 1.5.0 --no-git-tag-version` | exit 0；package.json 与 lock 两处均 1.5.0 |
| 改 `src/host.ts` meta.version | 1.5.0 |
| 插入 CHANGELOG `## 1.5.0 — 2026-10-28`（占位） | — |
| `npm run build` | exit 0；`lib/host.js:297`、`dist/host.js:297` 均 1.5.0 |
| 7 处版本检查 | `[PASS] 7 处版本均为 1.5.0`，exit 0 |
| `npm run check` | exit 0 |
| `npm test` | **90/90、0 fail**，exit 0 |

说明：预演只验证“版本递增/构建/校验链路”，**不代表 1.5.0 的视觉实现已完成**；视觉代码与新增测试由实现轮次完成。

### 10.7 未改动的证明

- live 版本仍为 1.4.3：`package.json:3`、`src/host.ts:328`、`lib/host.js:297` 均为 1.4.3。
- T4 只新增本文件 + 快照；live 上只跑过一次 `npm test`，它会按 `package.json:42` 重新生成 `dist/`、`lib/`、`client.js` 与 `dist-tests/`（同版本产物，源码与版本号未变）；其余构建/测试都在隔离目录完成。

---

## 11. 交接清单

### 给实现轮次（T3）

1. 先读本文件 §2、§3、§4；确认版本目标 **1.5.0**（若范围缩成纯修复，先找主 Agent 确认降为 1.4.4）。
2. 实现完成后按 §4.3 递增；只改 `src/host.ts:328` 与 `package.json`（由 `npm version` 改），不要手改生成物。
3. 按 §3.1 写 CHANGELOG；按 §3.2 写报告；报告里必须有真实截图与命令输出。
4. 交付前跑 §5.2：check、test、7 处版本检查全部通过。
5. 若新增/修改了对外载荷字段或工具 Schema：**停止**，交主 Agent 重新评审是否要 MAJOR 与回滚兼容性。

### 给验收轮次（T5）

1. 用 §5.1 检查版本 7 处一致；记录真实输出。
2. 用 §5.2 跑 check/test；确认 1.4.3 的 90 项仍全过、无 skipped 顶替。
3. 对照 CHANGELOG 模板检查：每条“修复”有行号/证据，每个“通过”有真实命令结果。
4. 把“未验证”项原样保留，不得在报告里写成已验证。

### 给主 Agent（T4 无权限，必须由你执行）

1. 确认版本目标：**1.5.0**（默认）或 **1.4.4**（仅当范围缩为纯修复，需用户确认）。
2. 在实现/回滚窗口确认**没有执行中的计划**。
3. 实现完成后重启 DSH Web / 重载 web profile，并按 §4.6 做真机验收。
4. 若触发 §6.2 任一条：按 §6.3 回滚，回滚后同样需要重启；重启前进程仍是 1.5.0。
5. 最终交付物中保留：快照 SHA-256、CHANGELOG、实现报告、本策略文件。

---

## 附录 A：版本与路径速查

| 项 | 值 |
|---|---|
| 插件根 | `<repo>` |
| 当前版本 | 1.4.3（T4 写作时） |
| 目标版本 | 1.5.0（minor） |
| 权威版本文件 | `package.json:3` |
| 插件 meta.version | `src/host.ts:328` |
| 运行时加载 | `lib/host.js`（build 生成） |
| 浏览器端 | `client.js`（build 生成，不含版本号） |
| 变更记录 | `CHANGELOG.md` 顶部 |
| 回滚快照 | `.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz` |
| 快照 SHA-256 | `b8ccc0efa7c307160739ffecdb4af44daab44b3a0f0c779c74d9d0783f6993c7` |
| 1.4.3 测试基线 | 90/90，0 fail |
| 回滚后预期 | 90/90，0 fail；check exit 0；7 处版本 1.4.3 |
