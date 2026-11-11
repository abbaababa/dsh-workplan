# dsh-workplan「版本统一 2.5.0」版本一致性审计报告

- **审计时间戳**：2026-11-11 19:13:52 +0800（Asia/Shanghai）
- **审计人**：版本发布部 expert（版本一致性审计，只读快照审计）
- **仓库**：/Users/open/Documents/Stocks/plugins/dsh-workplan（独立 git 仓库）
- **基线**：HEAD = b358783「Release 2.3.9」，工作树含未提交的 2.5.0 机制改动（git status 实测：src/host.ts、src/plan.ts、src/runtime.ts、src/llm-rules.ts、package*.json、CHANGELOG.md、README×3、lib/×4、tests/×3 等已修改；tests/workplan-250-head-delegation.test.ts 等为未跟踪新文件）
- **快照性质**：dept-mechanism 彼时仍在改 src/ 与 tests/（约 19:14 结束）。本报告是时点快照，**负责人在阶段B开始时必须重新 grep 复核行号**（尤其 src/host.ts 的 meta 行号可能漂移）。
- **审计方式**：全程只读（grep/glob/read 工具 + git status/log/check-ignore 只读命令），未编辑任何受保护文件，未运行 npm install/build/test，未调用任何 dsh_workplan_* 工具。唯一写入即本报告。

---

## 一、全仓 grep "2\.5\.1" 命中逐条分类（共 10 处，全部亲自复核）

| # | 位置 | 实测内容 | 分类 |
|---|------|----------|------|
| 1 | package.json:3 | `"version": "2.5.1",` | **(a) 阶段B手改** |
| 2 | package-lock.json:3 | `"version": "2.5.1",`（顶层） | **(a) 阶段B手改** |
| 3 | package-lock.json:9 | `"version": "2.5.1",`（packages[""]，缩进6空格） | **(a) 阶段B手改** |
| 4 | src/host.ts:1737 | `version: '2.5.1',`（export const meta 内，:1735-1740） | **(a) 阶段B手改** |
| 5 | tests/fixtures/tool-surface.json:3 | `"version": "2.5.1",` | **(a) 阶段B手改** |
| 6 | tests/workplan-250-head-delegation.test.ts:195 | `test('要求5：版本声明统一 2.5.1', () => {`（测试标题字面量） | **(a) 阶段B手改** |
| 7 | tests/workplan-250-head-delegation.test.ts:197 | `assert.equal(pkg.version, '2.5.1')` | **(a) 阶段B手改** |
| 8 | tests/workplan-250-head-delegation.test.ts:199 | `assert.equal(fixture.version, '2.5.1')` | **(a) 阶段B手改** |
| 9 | lib/host.js:1600 | `version: '2.5.1',` | **(b) 编译产物**，npm run build 再生，不手改 |
| 10 | CHANGELOG.md:6 | 「原『2.5.1』仅为版本标签改动、无任何功能差异……定版 2.5.0 并入本条目」 | **(c) 允许的历史叙述**，保留不动 |

**(d) 范围外杂项（只记录不处理）**：
- node_modules/（存在；package-lock 显示仅 @types/node、@types/react、typescript 三个 devDependencies，无自引用包 node_modules/dsh-workplan，实测不存在）；
- dist/host.js:1600 与 dist-tests/src/host.js:1600 —— 直接 grep 实测**均已是 `version: '2.5.0'`**（上一轮 2.5.0 构建的滞留产物，与 lib/host.js 的 2.5.1 不一致；两者均为再生品：dist 由 build、dist-tests 由 npm test 再生，无需手改，build+test 后自然归一）；
- lib.bak.20261103140042/host.js:1149 = `version: '1.12.0'`（旧备份，无 2.5.1）；
- 7 个 *.tgz（1.8.3/1.8.4/2.0.3/2.0.4/2.1.0/2.1.1/2.1.2，均为旧版打包件，无 2.5.1）；
- 8 个 _t* 临时目录（_t_clarify/_t_release_1123/_t_replay/_t1_guard_fix/_t3_m1/_t3_release/_t7_release/_t9_replay，均 20261104，全仓 grep 无 2.5.1 命中）。
- git check-ignore 实测：dist、dist-tests、node_modules、lib.bak.20261103140042 均被忽略，故全仓 grep（遵循 ignore）未扫其内部；本审计已对其中关键文件逐个直接 grep 补查（见上）。

## 二、阶段B权威清单（file:line | 当前值 | 应改为）——8 处手改，全部已亲自读文件复核

| # | file:line | 当前值（实测） | 应改为 |
|---|-----------|----------------|--------|
| B1 | package.json:3 | `"version": "2.5.1",` | `"version": "2.5.0",` |
| B2 | package-lock.json:3 | `"version": "2.5.1",` | `"version": "2.5.0",` |
| B3 | package-lock.json:9 | `"version": "2.5.1",`（packages[""]） | `"version": "2.5.0",` |
| B4 | src/host.ts:1737 | `version: '2.5.1',`（meta） | `version: '2.5.0',` |
| B5 | tests/fixtures/tool-surface.json:3 | `"version": "2.5.1",` | `"version": "2.5.0",` |
| B6 | tests/workplan-250-head-delegation.test.ts:195 | 标题 `'要求5：版本声明统一 2.5.1'` | `'要求5：版本声明统一 2.5.0'` |
| B7 | tests/workplan-250-head-delegation.test.ts:197 | `assert.equal(pkg.version, '2.5.1')` | `assert.equal(pkg.version, '2.5.0')` |
| B8 | tests/workplan-250-head-delegation.test.ts:199 | `assert.equal(fixture.version, '2.5.1')` | `assert.equal(fixture.version, '2.5.0')` |

手改完成后执行 `npm run build` + `npm test`：lib/host.js（现 2.5.1）、dist/host.js、dist-tests/src/host.js 由构建/测试再生为 2.5.0，**严禁手改编译产物**。
注意：B6 测试标题是已知点位清单（195/197/199）中容易被漏改的字符串——195 行不只是断言，标题本身也含 2.5.1，必须一并改。

### 其他版本声明面排查（grep "2\.5\.[01]" 与 "version"，逐一实测）

| 文件 | 实测结果 | 结论 |
|------|----------|------|
| client.js | 仅 6 处历史性注释标记（[2.2.0]/[2.2.3]/[2.2.7]/[2.3.9]），无 version 声明、无 2.5.x | 无需同步 |
| cordis.patch.yml | 无 version、无任何 2.x.y 字样 | 无需同步 |
| locale/zh.json、locale/en.json | 无 version、无 2.x.y | 无需同步 |
| sha256-manifest.json | 无 version、无 2.x.y | 无需同步（若阶段B后 build 改变 lib/ 哈希，是否重算属发布流程另行决策，非版本字面量问题） |
| PROMO.md | 仅 :26「版本口径诚实…CC:2022」，与插件版本号无关 | 无需同步 |
| docs/ | 命中均为历史发布记录（1.x/2.1.x/2.2.6/2.3.x）；docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md:31 已写「2.3.9；2.5.0 强化」 | 无需同步 |
| README.md:6/:72、README.en.md:6/:83、README.zh.md:6/:72 | 徽章与安装行实测均已是 2.5.0（阶段A成果确认） | ✅ 已就位 |
| CHANGELOG.md:1 | `## 2.5.0 — 2026-11-11`（阶段A成果确认） | ✅ 已就位 |

## 三、tests/version-sync.test.ts 断言覆盖分析（全文 52 行已通读）

**设计确认：版本无关，无任何硬编码版本字面量，阶段B无需改此文件。**（与预期一致，以实际读到为准）

- 测试1（:22-34）「package.json, package-lock.json and meta.version stay in sync」：
  - 用正则 `/export const meta = \{[\s\S]*?version:\s*'([^']+)'/` 从 src/host.ts 提取 meta.version（:27）；
  - 断言 pkg.version == lock.version（:31，lock 顶层）；
  - 断言 pkg.version == lock.packages[""].version（:32，lock 嵌套）；
  - 断言 meta.version == pkg.version（:33）。
- 测试2（:36-52）「CHANGELOG and README mention the version being shipped」：
  - 以 pkg.version 动态构造正则，断言 CHANGELOG 存在 `^## <version> — ` 标题（:39-43）；
  - 断言 **README.md 与 README.en.md** 含 `dsh-workplan@<version>` 安装行（:45-51）。**注意：不覆盖 README.zh.md**（zh 的安装行/徽章靠人工同步，本轮阶段A已改好，实测 2.5.0）。
- 注释（:14）明确：lib/host.js、dist/host.js 为生成物，不在断言范围。
- 推论：只要 B1-B5 完成，version-sync 两条测试即通过（CHANGELOG 标题与 README×2 安装行已就位）；B6-B8 是另一测试文件里的硬编码断言，必须同步改，否则「要求5」测试失败。

## 四、异常与限制如实记录

1. 无工具错误、无诊断失败；所有结论均来自上述实际读取/grep 结果，无推测。
2. 发现一处**产物不一致**（非遗漏点位）：lib/host.js=2.5.1 而 dist/host.js、dist-tests/src/host.js=2.5.0，属上一轮构建滞留，build+test 后自然消除，不需手改。
3. 行号时效风险：src/host.ts:1737 与 tests 两处行号为 19:13 快照值；dept-mechanism 收尾后可能漂移，阶段B开始时以重新 grep 为准（历史报告曾记录 meta 行号从 1584→1724→1737 的漂移先例）。
4. 通信限制：本审计会话的 send_message 仅支持直连父代理；对 dept-release 的结论已通过父代理（agent_id 56bb1e47-5e8b-4fa4-912b-00d64ffc632f）转达，并在下方给出可直接转发的一句话结论。

## 五、结论

**COMPLETE（清单完备）**：全仓 2.5.1 命中 10 处已逐条分类闭环——8 处阶段B手改（B1-B8，含易漏的测试标题 :195）、1 处编译产物（lib/host.js:1600，build 再生）、1 处 CHANGELOG 允许的历史叙述（:6，保留）；client.js / cordis.patch.yml / locale / sha256-manifest.json / PROMO.md / docs 均无需同步的版本声明；version-sync.test.ts 为版本无关设计、无需改动；范围外杂项（node_modules、dist-tests、lib.bak.*、7 个 tgz、8 个 _t* 目录）已记录、无 2.5.1 残留（dist/dist-tests 滞留的 2.5.0 由再生归一）。按 B1-B8 + build + test 执行即可达成全仓版本统一 2.5.0。
