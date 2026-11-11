# 阶段A 文档与清单核验报告（check-docs-250）

- 核验人：版本发布部 member（文档/清单核对）
- 时间：2026-11-11（Asia/Shanghai）
- 仓库：/Users/open/Documents/Stocks/plugins/dsh-workplan（HEAD=2.3.9, b358783，工作树含未提交改动）
- 方法：全程只读（read/grep 工具 + git status/diff 只读命令）；未编辑任何源文件，未执行 npm/build/test，未调用任何 dsh_workplan_* 工具。

## 1) CHANGELOG 2.5.0 定版条目 — PASS

- 第 1 行为 `## 2.5.0 — 2026-11-11`（CHANGELOG.md:1，read 实测）。
- 全文标题扫描（grep `^## `，共 81 个标题）无任何 `## 2.5.1`；2.5.0 之后依次为 2.3.10（L9）、2.3.9（L13）、2.3.2（L21）等。
- 版本统一说明（CHANGELOG.md:6）逐项覆盖：
  - package.json ✓（「package.json / …」）
  - package-lock×2 ✓（「package-lock.json×2（顶层 version 与 packages[""].version）」）
  - src/host.ts meta ✓（「src/host.ts meta」）
  - lib/ 编译产物 ✓（「lib/ 编译产物（lib/host.js 等，由 npm run build 再生）」）
  - tests/fixtures/tool-surface.json ✓
  - README 三语 ✓（「README 三语徽章与安装行（三语徽章此前滞留 2.3.9，一并修正）」）
  - 版本回归断言 ✓（「tests/version-sync.test.ts 一致性断言、tests/workplan-250-head-delegation.test.ts 要求5 版本断言」）
  - 原 2.5.1 定性 ✓（「原「2.5.1」仅为版本标签改动、无任何功能差异，按用户最终指令定版 2.5.0 并入本条目，不再单独设节」）

## 2) CHANGELOG 历史未动 — PASS

- `git diff -- CHANGELOG.md` 实测：整个 diff 只有一个 hunk（@@ -1,3 +1,15 @@），全部为新增 '+' 行（2.5.0 与 2.3.10 两个小节），**没有任何 '-' 删除行**。即相对 HEAD 未删除任何历史内容（背景中提到的旧「## 2.5.1」小节与旧 bullet 在工作树中间态存在过，当前树中已不存在，且 HEAD 本无这些行，故 diff 无删除，符合预期）。
- 旧小节标题仍在且顺序不变：2.3.10（L9）→ 2.3.9（L13）→ 2.3.2（L21）→ 2.3.0（L28）→ 2.2.9（L36）…直至 1.0.0（L2906），共 81 个 `## ` 标题，降序无乱序（grep 全量标题清单实测）。

## 3) 三个 README 徽章与安装行 — PASS

`git diff -- README.md README.en.md README.zh.md` 实测，每个文件恰好 2 处改动、均为版本字符串（HEAD 2.3.9 → 工作树 2.5.0，中间态 2.5.1 已被覆盖，属预期）：

| 文件 | 徽章行（diff @@ -3,7） | 安装行（diff @@ -69/-80,7） |
|---|---|---|
| README.md | `version-2.5.0-blue.svg` + `releases/tag/v2.5.0` ✓ | `dsh plugin --profile web add dsh-workplan@2.5.0` ✓ |
| README.en.md | 同上 ✓ | 同上 ✓ |
| README.zh.md | 同上 ✓ | 同上 ✓ |

- 三个文件的 diff 中除上述徽章行与安装行外无任何其它内容改动（无其它 +/- 行）。

## 4) 「2.5.1」残留扫描 — PASS

grep `2\.5\.1`（范围：README.md / README.en.md / README.zh.md / CHANGELOG.md）：

- README 三语：**0 命中**。
- CHANGELOG.md：**仅 1 处命中**，位于 L6 的 2.5.0 版本统一说明内：「原「2.5.1」仅为版本标签改动、无任何功能差异…」——属允许的叙述性文字，无「当前版本 2.5.1」含义。

## 5) package.json 清单 — PASS（version 项 PENDING-B1）

- `name` = `dsh-workplan`（package.json:2，grep 实测）。
- `scripts.build` 存在（package.json:69：`rm -rf dist && tsc -p tsconfig.json && cp dist/*.js lib/ && cp dist/client.js client.js`）。
- `scripts.test` 存在（package.json:71：`npm run build && rm -rf dist-tests && tsc -p tsconfig.test.json && node scripts/run-tests.mjs`）。
- `git diff -- package.json` 实测：**仅 version 一行变化**（`"version": "2.3.9"` → `"version": "2.5.1"`），name/scripts 等其余字段与 HEAD 完全一致。
- `version` 当前为 `2.5.1`（package.json:3）：**PENDING-B1** —— 按任务背景，这是阶段B待办（改为 2.5.0），不算失败。

## 附注（如实记录，非失败项）

- git status 显示工作树还有 src/、tests/、lib/、docs/cc、package-lock.json 等改动，属其他同事/阶段B范围，未纳入本次核验，也未触碰。
- 全程未发生工具错误；所有结论均基于上述实测证据。

## 总体结论：PASS

阶段A 文档改动（CHANGELOG 定版合并、README 三语版本行）全部核验通过；package.json 清单完整、仅 version=2.5.1 为阶段B预期待办（PENDING-B1）。