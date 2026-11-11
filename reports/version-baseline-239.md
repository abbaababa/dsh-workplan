# T3 · 版本基线快照与 2.3.9 原子改版精确清单（dsh-workplan）【复核终版】

- 初次基线：2026-11-11T12:26+08:00（第一次尝试，盘上当时为 2.3.2）
- **复核更新：2026-11-11T12:34+08:00（本次重试会话，只读复核）**
- 任务：T3（只读）——全仓快照所有版本声明位现值，产出供 T4 直接执行的原子改版清单。**本任务两次尝试均未修改任何声明位本体**（A4 证据见 §7）。
- 仓库根：`/Users/open/Documents/Stocks/plugins/dsh-workplan`（下文相对路径均以此为根）
- **复核结论（最重要）：14/14 声明位现值已全部 = 2.3.9，待执行编辑 = 0 处。** 原子改版在两次尝试之间（12:26–12:30）已由本任务之外的执行方应用到 git 工作区（未提交；HEAD 仍为 `bd95cbd Release 2.3.2`）。本次重试的首个 grep（12:30）即已见 2.3.9。下文清单转为「**已应用台账 + 逐位复核证据**」，T4 无需再改任何字面量，只需按 §5 跑门禁确认；T6 发布前仍须全量 build 验证产物新鲜度。
- 本清单**取代**旧报告 `reports/T5-version-bump-plan-239.md`（写于 T4b 落码前，行号过期：src/host.ts:1584 → 现 **1724**；lib/dist host.js:1455 → 现 **1587**）。

## 1. 权威口径（测试怎么判，就怎么核）

### 1.1 version-sync 门禁（`tests/version-sync.test.ts`，52 行，已全文核读）
不写死版本号，只断言互相一致（升级无需改测试）：
1. `package.json.version` == `package-lock.json.version`（根，:31）
2. `package.json.version` == `package-lock.json.packages[""].version`（嵌套，:32）
3. `src/host.ts` 的 `export const meta = { … version: '<v>' }` == package.json（:27-33，正则提取）
4. `CHANGELOG.md` 必须存在标题行，正则 **`^## <version> — `**（多行模式；**全角破折号 `—`（U+2014）+ 空格**）（:39-43）
5. `README.md` 与 `README.en.md` 必须包含安装串 **`dsh-workplan@<version>`**（:45-51）

**测试未覆盖、但必须手工同步的入口**（历史教训 [engineering] T2-2.3.0 硬规则）：`README.zh.md`（徽章+安装行）、三份 README 的**徽章行**。本次复核：三语 README 各恰 3 处 `2.3.9`（徽章 2 + 安装 1），无盲区漂移。
**生成物不在 version-sync 断言内**（测试头注释 :14 明示）：`lib/host.js`、`dist/host.js` 由 `npm run build` 覆盖——但它们在 npm `files` 发布清单内，发布字节必须为 2.3.9。本次复核：两者均已再生为 2.3.9（:1587），且与 `dist-tests/src/host.js` 哈希逐字节一致（§7）。

### 1.2 tool-surface 门禁（`tests/tool-surface-inventory.test.ts:62-70`）
fixture `version` 必须等于 `src/host.ts` meta.version。本次复核：fixture.version=2.3.9 == meta=2.3.9 ✓；tools 数组恰 **12 个工具名（字符串数组）**，含 `dsh_workplan_delegate`（fixture:10，node 直读确认）。**注意：tools 是字符串数组，不是对象数组**——用 `t.name` 探测会误报缺失（本次复核曾误报一次，已用 `grep -n delegate fixture` + 全量名单纠正）。

### 1.3 构建/测试脚本行为（package.json scripts）
- `build` = `rm -rf dist && tsc -p tsconfig.json && cp dist/*.js lib/ && cp dist/client.js client.js`。
- `test` = `npm run build && rm -rf dist-tests && tsc -p tsconfig.test.json && node scripts/run-tests.mjs`。
- npm `files` 含 `src, lib, client.js, CHANGELOG.md, README.md, README.en.md, docs…`（**README.zh.md 不在发布包内**，但仓库文档仍须同步——已同步）。
- 根 `client.js` 无版本字面量（grep 0 命中；本次复核哈希与 12:25 基线一致，未被触碰）。

### 1.4 Hindsight 核对
按任务方法两次调用 `hindsight_search_knowledge_pages`，均返回 **"Hindsight memory is disabled for this workspace"**。改以盘上权威事实替代：version-sync 测试全文 + 提示词注入的历史教训（声明位/历史位分类、禁全局盲替、README.zh/徽章手工同步）。此偏离已如实记录。

## 2. 全仓 grep 基线（可复核）

命令（仓库根执行）：
```bash
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=reports -F "2.3.2" . | sort
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=reports -F "2.3.9" . | sort
```
- **12:25 基线（改版前，第一次尝试实测）**：`2.3.2` 命中 92 行 = 声明位 14 行（17 处字面量）+ CHANGELOG 旧标题 1 行 + 历史位 77 行；每份 README 恰 3 处。
- **12:34 复核（改版后，本次实测）**：全仓 `2.3.2` 命中 **78 行，全部为历史位**（§4 红线：源码 [2.3.2] 注释锚点、测试标签、构建镜像同源锚点、docs 历史发布文档、历史 tgz 文件名）；**11 个声明位文件 + dist-tests 派生行残留 = 0**（§5 命令 1 实测输出为空，exit=1）。
- git 工作区：8 个声明位文件均为 `M`（未提交）；`git diff -U0` 逐行核对，版本相关改动**恰为** 17 处 `2.3.2→2.3.9` 字面量 + CHANGELOG 头部插入 8 行（`## 2.3.9 — 2026-11-11` 段）；src/host.ts 其余 +144 行为 T4b delegate 代码（非版本改动）。CHANGELOG 旧段 `## 2.3.2`（现 :9）、`## 2.3.0`（现 :16）原文保留。
- git tag 现有 `v2.3.0`、`v2.3.2`（历史，不动；v2.3.9 由 T6/主 Agent 发布时新建）。`sha256-manifest.json` 绑定 1.12.0 历史发布件，非声明位；2.3.9 清单由 T6 重算。

## 3. 14 声明位台账（旧值 → 新值；复核现值全部已就位）

**数量核对：恰为 14 处** = 11 处手工字面量行 + 2 处构建再生发布产物行 + 1 处 CHANGELOG 插入。派生行 dist-tests（§3.1）自动再生，不计入 14。

| # | 文件:行 | 旧值（12:25 基线） | 目标值 | **复核现值（12:34 实测）** | 状态 |
|---|---------|--------------------|--------|---------------------------|------|
| 1 | `package.json:3` | `"version": "2.3.2",` | 2.3.9 | `"version": "2.3.9",` | ✅ 已就位 |
| 2 | `package-lock.json:3` | `"version": "2.3.2",`（根） | 2.3.9 | `"version": "2.3.9",` | ✅ 已就位 |
| 3 | `package-lock.json:9` | `"version": "2.3.2",`（**嵌套 `packages[""]`**，缩进 6 空格） | 2.3.9 | `"version": "2.3.9",` | ✅ 已就位（**A3 嵌套引用显式列出**） |
| 4 | `src/host.ts:1724` | `version: '2.3.2',`（meta 内） | 2.3.9 | `version: '2.3.9',` | ✅ 已就位（唯一运行时真源；全文件形如 `version: '…',` 的行恰 1 处，release.sh 守卫实测 cnt=1） |
| 5 | `lib/host.js:1587` | `version: '2.3.2',` | 2.3.9 | `version: '2.3.9',` | ✅ build 已再生 |
| 6 | `dist/host.js:1587` | `version: '2.3.2',` | 2.3.9 | `version: '2.3.9',` | ✅ build 已再生 |
| 7 | `README.md:6` | 徽章行 `version-2.3.2-blue.svg` + `releases/tag/v2.3.2`（一行 2 处） | 2.3.9 | `version-2.3.9-blue.svg` + `releases/tag/v2.3.9` | ✅ 已就位 |
| 8 | `README.md:72` | `dsh plugin --profile web add dsh-workplan@2.3.2` | 2.3.9 | `…dsh-workplan@2.3.9` | ✅ 已就位（version-sync 断言点） |
| 9 | `README.en.md:6` | 徽章行（同 #7，一行 2 处） | 2.3.9 | 同 #7 新值 | ✅ 已就位 |
| 10 | `README.en.md:83` | `…dsh-workplan@2.3.2` | 2.3.9 | `…dsh-workplan@2.3.9` | ✅ 已就位（version-sync 断言点） |
| 11 | `README.zh.md:6` | 徽章行（同 #7，一行 2 处） | 2.3.9 | 同 #7 新值 | ✅ 已就位（测试盲区，手工同步已核） |
| 12 | `README.zh.md:72` | `…dsh-workplan@2.3.2` | 2.3.9 | `…dsh-workplan@2.3.9` | ✅ 已就位（测试盲区，手工同步已核） |
| 13 | `tests/fixtures/tool-surface.json:3` | `"version": "2.3.2",` | 2.3.9 | `"version": "2.3.9",` | ✅ 已就位；tools 12 项含 delegate（:10），未被误动 |
| 14 | `CHANGELOG.md:1` | （无 2.3.9 段；首行 `## 2.3.2 — 2026-11-10`） | 插入 `## 2.3.9 — 2026-11-11` 段 | 首行 `## 2.3.9 — 2026-11-11`（全角破折号 ✓），旧段保留于 :9 | ✅ 已就位 |

字面量合计：14 行内 **17 处** `2.3.2 → 2.3.9`（README×3 每份 3 处=9，其余 8 行各 1 处=8）+ CHANGELOG 新增标题 1 处——与 `git diff -U0` 实测完全一致。

### 3.1 额外派生行（不计入 14）
| 文件:行 | 复核现值 | 处置 |
|---------|----------|------|
| `dist-tests/src/host.js:1587` | `version: '2.3.9',`（与 lib/dist 哈希逐字节一致） | npm test 自动再生；不在 npm files 内，不发布。无需手改 |
| 根 `client.js` | 无版本字面量；哈希与 12:25 基线一致 | build 自动 cp；无需编辑 |

### 3.2 T4 剩余动作（因改版已应用，原子编辑步骤全部免除）
1. **不要再改任何版本字面量**（已 14/14 就位；重复编辑只会引入漂移风险）。
2. 按 §5 跑残留检查 + version-sync / tool-surface 门禁确认绿（全量套件归 T5）。
3. 若 T1 后续再改 src/，发布前必须重跑 `npm run build` 保证 lib/dist 新鲜度（T6 门禁）。
4. 提交与 tag（`Release 2.3.9` / `v2.3.9`）由主 Agent/T6 执行；当前 8 个声明位文件改动尚未提交。

## 4. 历史位红线（禁改清单，grep 命中但绝不替换；复核确认全部原样保留）

| 类别 | 位置 | 说明 |
|------|------|------|
| CHANGELOG 旧段 | `CHANGELOG.md:9` 起 `## 2.3.2` 段及更早各段 | 只增不改（复核：原文保留 ✓） |
| [2.3.2] 注释锚点（源码） | `src/plan.ts` 13 处（1176/1190/1192/1194/1257/1274/1289/1295/1316/1386/1438/1518 等）、`src/runtime.ts:1091` | D2 修复锚点（复核：仍在盘 ✓） |
| [2.3.2] 测试标签 | `tests/plan.test.ts` 7 处 | 历史回归用例名 |
| 构建镜像同源锚点 | `lib/plan.js`、`lib/runtime.js`、`dist/*`、`dist-tests/*` 对应行 | 随 src 构建再生，禁手改 |
| 2.3.2/2.3.0 发布文档 | `docs/release-notes-2.3.2.md`、`docs/release-record-2.3.2-20261110.md`、`docs/release-*-2.3.0*` | 历史发布记录 |
| 历史发布件 | 根目录 `dsh-workplan-1.8.3…2.1.2.tgz` 7 个、`sha256-manifest.json`（1.12.0） | 文件名与哈希历史；2.3.9 清单由 T6 重算 |
| git 历史 | tag `v2.3.0`、`v2.3.2`，历史提交 | 不动 |
| reports/ 全部 | 旧 T5 清单、各结算 JSON、测试日志 | 历史证据，禁改（本任务只新增/更新自己的报告） |

**禁止全局盲目 `sed s/2.3.2/2.3.9/g`**——会篡改上述全部历史位（历史教训硬规则）。复核实测：全仓剩余 78 行 `2.3.2` 全部落在本表类别内。

## 5. 验证命令与本次实测结果

```bash
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
# 1) 声明位残留检查 —— 本次实测：输出为空，exit=1（无残留）✅
grep -n -F "2.3.2" package.json package-lock.json src/host.ts lib/host.js dist/host.js \
  dist-tests/src/host.js README.md README.en.md README.zh.md tests/fixtures/tool-surface.json
# 2) 新值就位检查 —— 本次实测：14 行全部命中 2.3.9；CHANGELOG:1 = "## 2.3.9 — 2026-11-11" ✅
grep -n -F "2.3.9" package.json package-lock.json src/host.ts lib/host.js dist/host.js \
  README.md README.en.md README.zh.md tests/fixtures/tool-surface.json
grep -n "^## 2.3.9 — " CHANGELOG.md
# 3) 静态一致性（node 只读直读，本次实测 ALL_CORE_EQUAL_2.3.9: true）✅
#    pkg=lockRoot=lockPackagesEmpty=hostMeta=fixture=2.3.9；hostVersionLineCount=1；
#    changelogHeading=true；三语 README install+badge 全 true
# 4) 门禁测试（build 后，T5 全量跑）：
node --test --import ./scripts/setup-event-loop-anchor.js dist-tests/tests/version-sync.test.js dist-tests/tests/tool-surface-inventory.test.js
```
注：本次 T3 为只读任务且 T1 正在并行构建，未运行会触发 build 副作用的 npm test；静态断言已用 node 只读直读逐条复核（与 version-sync 测试断言一一对应），运行态门禁绿由 T5 全量套件给出。

## 6. 与计划口径的核对结论

- 「是否恰为 14 处」：**是**。§3 表 #1–#14，行号按当前盘上真态逐一实测刷新。
- 隐蔽声明位排查：package-lock 嵌套（#3）、fixture（#13）、README.zh 与徽章（#7/#9/#11，测试盲区）、dist-tests 派生行（§3.1）均已覆盖；改版后全仓 78 行旧版本命中逐条归类为历史位，无遗漏声明位。
- **新增事实（相对第一次尝试）**：原子改版已被外部执行方应用且 build 产物已再生；本清单由「待执行编辑清单」转为「已应用台账 + 复核证据」，T4 待执行编辑 = 0。

## 7. 只读证明（A4）

- 12:25 改前哈希快照：`reports/version-baseline-239.sha256.pre.txt`（12 文件，第一次尝试落盘）。
- 12:34 复核哈希快照：`reports/version-baseline-239.sha256.recheck.txt`（本次落盘，同 12 文件同命令）。
- 两份快照 diff：前 11 个文件哈希不同——**差异全部由两次尝试之间的外部原子改版 + build 再生造成**（git diff 逐行核对恰为 17 处版本字面量 + CHANGELOG 插入 + T4b 代码，§2）；第 12 个文件根 `client.js` 哈希**逐字节一致**（ee6d00d2…）。
- 本次重试会话（12:29:42 起）对声明位本体**零写入**：首个 grep 即已见 2.3.9；本会话写入仅限 reports/ 下 3 个文件（本报告更新、recheck 哈希快照、结算备份 wp-settlement-T3.json）。
- 第一次尝试同样只读（其报告 §7 与 pre 快照为证）；其超时（CHILD_TIMEOUT 720s）发生在报告落盘后的收尾阶段，产物已在盘上，本次按「先核盘上产物、只补缺口」协议复核更新，未整步重跑。
