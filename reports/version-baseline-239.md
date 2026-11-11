# T3 · 版本基线快照与 2.3.9 原子改版精确清单（dsh-workplan）

- 生成时间：2026-11-11T12:26+08:00（Asia/Shanghai）
- 任务：T3（只读）——全仓快照所有版本声明位现值，产出供 T4 直接执行的原子改版清单。**本任务未修改任何声明位本体**（A4 证据见 §7）。
- 仓库根：`/Users/open/Documents/Stocks/plugins/dsh-workplan`（下文相对路径均以此为根）
- 当前版本：**2.3.2** → 目标版本：**2.3.9**（跳号直发，2.3.3–2.3.8 不发布，用户锚点已定）
- 本清单**取代**旧报告 `reports/T5-version-bump-plan-239.md`：该报告写于 T4b 落码前，行号已过期（如 src/host.ts:1584 → 现 **1724**；lib/dist host.js:1455 → 现 **1587**）。T4 必须以本清单行号为准。

## 1. 权威口径（测试怎么判，就怎么改）

### 1.1 version-sync 门禁（`tests/version-sync.test.ts`，52 行，已全文核读）
不写死版本号，只断言互相一致（升级无需改测试）：
1. `package.json.version` == `package-lock.json.version`（根，:31）
2. `package.json.version` == `package-lock.json.packages[""].version`（嵌套，:32）
3. `src/host.ts` 的 `export const meta = { … version: '<v>' }` == package.json（:27-33，正则提取）
4. `CHANGELOG.md` 必须存在标题行，正则 **`^## <version> — `**（多行模式；注意是**全角破折号 `—`（U+2014）+ 空格**，不是 `-` 或 `--`）（:39-43）
5. `README.md` 与 `README.en.md` 必须包含安装串 **`dsh-workplan@<version>`**（:45-51）

**测试未覆盖、但必须手工同步的入口**（历史教训 [engineering] T2-2.3.0 硬规则）：`README.zh.md`（徽章+安装行）、三份 README 的**徽章行**（badge 与 tag 链接）。漏改不会红测试，但会造成文档双版本并存。
**生成物不在 version-sync 断言内**（测试头注释 :14 明示）：`lib/host.js`、`dist/host.js` 由 `npm run build` 覆盖——但它们在 npm `files` 发布清单内，发布字节必须为 2.3.9，故仍列入清单（构建再生或等价定向补丁，二选一）。

### 1.2 tool-surface 门禁（`tests/tool-surface-inventory.test.ts:62-70`）
`tests/fixtures/tool-surface.json` 的 `version` 字段必须等于 `src/host.ts` meta.version（"baseline must be re-confirmed whenever the plugin version changes"）。**fixture 的 tools 数组已含 `dsh_workplan_delegate`（12 工具，T4b 已同步，实测 node 读取确认）——T4 只需改 version 一行，不要动 tools。**

### 1.3 构建/测试脚本行为（package.json scripts，实测读取）
- `build` = `rm -rf dist && tsc -p tsconfig.json && cp dist/*.js lib/ && cp dist/client.js client.js` → **改完 src/host.ts 后跑 build，lib/host.js、dist/host.js、根 client.js 自动再生**（根 client.js 无版本字面量，实测 grep 0 命中，无需手改）。
- `test` = `npm run build && rm -rf dist-tests && tsc -p tsconfig.test.json && node scripts/run-tests.mjs` → **dist-tests/src/host.js 由 npm test 自动再生**，不需手改、也不在 npm files 内（不发布）。
- npm `files` 含 `src, lib, client.js, CHANGELOG.md, README.md, README.en.md, docs…`（**README.zh.md 不在发布包内**，但仓库文档仍须同步）。

### 1.4 Hindsight 核对
按任务方法调用了 `hindsight_search_knowledge_pages`，返回 **"Hindsight memory is disabled for this workspace"**（本工作区未启用）。改以盘上权威事实替代：version-sync 测试全文 + 历史教训（提示词注入的 [engineering] T2-2.3.0「声明位/历史位分类、禁全局盲替、README.zh/徽章手工同步」）+ 旧 T5 清单交叉核对。此偏离已如实记录。

## 2. 全仓 grep 基线（可复核）

命令（仓库根执行）：
```bash
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=reports -F "2.3.2" . | sort
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=reports -F "2.3.9" . | sort
```
实测结果（2026-11-11 12:2x）：
- `2.3.2` 命中 **92 行**（含 reports 则更多，reports 全部为历史结算/日志，禁改）。其中**声明位 14 行（17 处字面量）+ CHANGELOG 旧标题 1 行（历史位）+ 历史位 77 行**，逐条分类见 §3/§4。
- `2.3.9` 命中全部为 **[2.3.9] 注释锚点 / 测试标签 / docs/cc 已更新文档 / reports 历史**（src、lib、dist、tests、docs/cc、scripts），**没有任何一处是"版本声明字面量已提前改成 2.3.9"**——即除 src/host.ts:1724 仍为 `version: '2.3.2'` 外，不存在半改版残留；改版无冲突。
- 每份 README 恰 **3 处** `2.3.2`（徽章行 2 处 + 安装行 1 处；`grep -o -F "2.3.2" README*.md | wc -l` 各=3）。
- git tag 现有 `v2.3.0`、`v2.3.2`（历史，不动；v2.3.9 由 T6/主 Agent 发布时新建）。
- 仓库根历史 tgz：1.8.3/1.8.4/2.0.3/2.0.4/2.1.0/2.1.1/2.1.2（无 2.3.2 tgz；文件名历史位，禁改）。`sha256-manifest.json` 绑定的是 **1.12.0** 历史发布件（206B，实测读取），非 2.3.2 声明位；2.3.9 发布时由 `scripts/compute-release-sha256.mjs` 重算（T6 范围）。

## 3. 14 声明位原子改版精确清单（T4 直接执行）

**数量核对：恰为 14 处**（与计划口径一致）= 11 处手工字面量行 + 2 处构建再生发布产物行 + 1 处 CHANGELOG 插入。另有 1 处派生行 dist-tests（§3.1）由 npm test 自动再生，不计入 14。

| # | 文件:行 | 现值（旧） | 目标值（新） | 改法 |
|---|---------|-----------|-------------|------|
| 1 | `package.json:3` | `  "version": "2.3.2",` | `  "version": "2.3.9",` | edit 替换 |
| 2 | `package-lock.json:3` | `  "version": "2.3.2",`（根） | `  "version": "2.3.9",` | edit 替换（与 #3 同文两处，用 replace_all 或两次定位） |
| 3 | `package-lock.json:9` | `      "version": "2.3.2",`（**嵌套 `packages[""]`**，缩进 6 空格） | `      "version": "2.3.9",` | edit 替换；**嵌套引用显式列出（A3）** |
| 4 | `src/host.ts:1724` | `  version: '2.3.2',`（meta 内） | `  version: '2.3.9',` | edit 替换；**唯一运行时真源** |
| 5 | `lib/host.js:1587` | `    version: '2.3.2',` | `    version: '2.3.9',` | **跑 `npm run build` 自动再生（推荐）**；若不 build 则等价定向补丁。二者取一，勿双写 |
| 6 | `dist/host.js:1587` | `    version: '2.3.2',` | `    version: '2.3.9',` | 同 #5（build 再生） |
| 7 | `README.md:6` | 徽章行 `[![version](https://img.shields.io/badge/version-2.3.2-blue.svg)](https://github.com/abbaababa/dsh-workplan/releases/tag/v2.3.2)`（**一行 2 处**） | `version-2.3.9-blue.svg` + `releases/tag/v2.3.9` | 整行替换 |
| 8 | `README.md:72` | `dsh plugin --profile web add dsh-workplan@2.3.2` | `dsh plugin --profile web add dsh-workplan@2.3.9` | edit 替换（version-sync 断言点） |
| 9 | `README.en.md:6` | 徽章行（同 #7 结构，一行 2 处） | `version-2.3.9-blue.svg` + `releases/tag/v2.3.9` | 整行替换 |
| 10 | `README.en.md:83` | `dsh plugin --profile web add dsh-workplan@2.3.2` | `dsh plugin --profile web add dsh-workplan@2.3.9` | edit 替换（version-sync 断言点） |
| 11 | `README.zh.md:6` | 徽章行（同 #7 结构，一行 2 处） | `version-2.3.9-blue.svg` + `releases/tag/v2.3.9` | 整行替换（**测试不覆盖，必须手工**） |
| 12 | `README.zh.md:72` | `dsh plugin --profile web add dsh-workplan@2.3.2` | `dsh plugin --profile web add dsh-workplan@2.3.9` | edit 替换（**测试不覆盖，必须手工**） |
| 13 | `tests/fixtures/tool-surface.json:3` | `  "version": "2.3.2",` | `  "version": "2.3.9",` | edit 替换；**只改 version 行**，tools 数组已含 delegate（T4b 已落地），禁动 |
| 14 | `CHANGELOG.md:1 之前` | （无 2.3.9 段；现首行 `## 2.3.2 — 2026-11-10`） | 插入新段：首行 **`## 2.3.9 — 2026-11-11`**（全角破折号 `—`，日期用实际发布日）+ 要点正文（引用 T2 草稿 `reports/T5-changelog-239-draft.md`）；**旧 `## 2.3.2` 段原文保留** | 文件头插入，不替换旧段 |

字面量合计：14 行内 **17 处** `2.3.2` → `2.3.9`（README×3 每份 3 处=9，其余 8 行各 1 处=8）+ CHANGELOG 新增标题 1 处。

### 3.1 额外派生行（不计入 14，自动再生，禁止手改后又被覆盖造成困惑）
| 文件:行 | 现值 | 处置 |
|---------|------|------|
| `dist-tests/src/host.js:1587` | `    version: '2.3.2',` | `npm test` 会 `rm -rf dist-tests && tsc -p tsconfig.test.json` 自动再生为 2.3.9；不在 npm files 内，不发布。**无需手工编辑** |
| 根 `client.js` | 无版本字面量（grep 0 命中） | build 自动 `cp dist/client.js client.js`；无需编辑 |

### 3.2 T4 执行顺序（原子性保障）
1. **前置**：确认 T1 构建已绿（`reports/T4b-build-evidence.md`）、T2 草稿在盘（`reports/T5-changelog-239-draft.md`）。fixture 双写风险已消除（T4b 对 fixture 的 tools 更新已落地，实测确认）。
2. 一次性完成 #1–#4、#7–#14（11 处手工行 + CHANGELOG 插入），**同一批编辑内完成，不留中间态**。
3. 跑 `npm run build` → #5/#6 与根 client.js 自动再生（若选择定向补丁路线则跳过 build，但发布前 T6 仍须全量 build 验证新鲜度）。
4. 跑 §5 验证命令 → version-sync 与 tool-surface 必须绿；`npm test` 顺带再生 dist-tests（§3.1）。
5. 改后全仓复核：声明位 `2.3.2` 残留必须为 **0**（历史位除外，§4 红线）。

## 4. 历史位红线（禁改清单，grep 命中但绝不替换）

| 类别 | 位置（实测行号） | 说明 |
|------|------------------|------|
| CHANGELOG 旧段 | `CHANGELOG.md:1` 起整个 `## 2.3.2` 段及更早各段 | 历史变更日志，只增不改 |
| [2.3.2] 注释锚点（源码） | `src/plan.ts` 13 处（1176/1190/1192/1194/1257/1274/1289/1295/1316/1386/1438/1518 等）、`src/runtime.ts:1091` | D2 修复锚点，改动会破坏锚定计数证据 |
| [2.3.2] 测试标签 | `tests/plan.test.ts` 7 处（586/590/599/605/613/628/635） | 历史回归用例名 |
| 构建镜像中的同源锚点 | `lib/plan.js`、`lib/runtime.js:987`、`dist/plan.js`、`dist/runtime.js:987`、`dist-tests/src/plan.js`、`dist-tests/src/runtime.js:987`、`dist-tests/tests/plan.test.js` 7 处 | 随 src 构建再生，内容同上，禁手改 |
| 2.3.2 发布文档 | `docs/release-notes-2.3.2.md`（:1/:5/:7）、`docs/release-record-2.3.2-20261110.md`（:1/:14/:16/:19/:20/:21/:22/:25） | 历史发布记录 |
| 历史发布件 | 根目录 `dsh-workplan-1.8.3…2.1.2.tgz` 7 个、`sha256-manifest.json`（1.12.0） | 文件名与哈希历史，禁改；2.3.9 清单由 T6 重算 |
| git 历史 | tag `v2.3.0`、`v2.3.2`，历史提交 | 不动 |
| reports/ 全部 | 含旧 T5 清单、各结算 JSON、测试日志 | 历史证据，禁改（本任务只新增文件） |

**禁止全局盲目 `sed s/2.3.2/2.3.9/g`**——会篡改上述全部历史位（历史教训硬规则）。

## 5. 改后验证命令（T4/T5 用）

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
# 1) 声明位残留检查：以下输出必须为空（历史位已按路径排除）
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=reports \
  --exclude-dir=docs --exclude="plan.*" --exclude="runtime.*" --exclude="*.tgz" \
  -F "2.3.2" package.json package-lock.json src/host.ts lib/host.js dist/host.js \
  dist-tests/src/host.js README.md README.en.md README.zh.md tests/fixtures/tool-surface.json
# 2) 新值就位检查：14 行全部命中 2.3.9（CHANGELOG 为新标题）
grep -n -F "2.3.9" package.json package-lock.json src/host.ts lib/host.js dist/host.js \
  README.md README.en.md README.zh.md tests/fixtures/tool-surface.json | head -30
grep -n "^## 2.3.9 — " CHANGELOG.md
# 3) 门禁测试（build 后）
node --test --import ./scripts/setup-event-loop-anchor.js dist-tests/tests/version-sync.test.js dist-tests/tests/tool-surface-inventory.test.js
# （若 dist-tests 未编译：npm test 全量跑，T5 范围）
```
注：`scripts/setup-event-loop-anchor.js` 的 import 路径以 `scripts/run-tests.mjs` 实际用法为准（T5 全量跑时自动处理）。

## 6. 与计划口径的核对结论

- 「是否恰为 14 处」：**是**。14 声明位 = §3 表 #1–#14，与旧 T5 清单同口径；行号已全部按当前盘上真态刷新。
- 新增发现（旧清单未列）：`dist-tests/src/host.js:1587` 派生行（§3.1，npm test 自动再生，不构成第 15 个手工声明位）；旧清单行号过期问题（§0 已声明取代关系）。
- 隐蔽声明位排查：package-lock 嵌套（#3 显式列出）、fixture（#13）、README.zh 与徽章（#7/#9/#11，测试盲区）均已覆盖；全仓 grep 92 行逐条分类完毕，无遗漏。

## 7. 只读证明（A4）

- 改前哈希快照：`reports/version-baseline-239.sha256.pre.txt`（12 个文件：11 声明位文件 + 根 client.js，shasum -a 256 实测）。
- 本报告落盘后复跑同一 shasum 命令并 diff：**必须逐字节一致**（结果见 `reports/version-baseline-239.sha256.post.txt` 与结算 JSON 的 A4 证据）。
- 本任务新增文件仅 3 个，全部在 reports/ 下：本报告、pre/post 哈希快照；未触碰任何声明位本体。