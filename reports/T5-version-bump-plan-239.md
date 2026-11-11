# T5 原子改版执行清单（2.3.2 → 2.3.9）— 交接主 Agent

> 状态：主 Agent 已接管本行（二次超时 takeoverRequired），且约束为「必须在 T3/T4b 代码落地后原子性一次性改版」。
> 本清单由 T5 于接管前只读盘点生成，可逐行直接执行。盘点时间：2026-11-11 00:12 +08:00。
> 权威声明位清单来源：主 Agent 指示（以 tests/version-sync.test.ts 为权威）+ 全仓 grep 实测命中。

## 1. 当前事实（已实测，非假设）

- package.json:3 → `"version": "2.3.2"`（与 git tag v2.3.2 / npm / CHANGELOG 首行四源一致，主 Agent 已确认）
- 全仓 `2.3.9` 命中（排除 node_modules/reports）：**0 处**（上轮实测 `grep -rn "2\.3\.9" ... | wc -l` = 0，改版无冲突残留）
- 历史位（禁改，防篡改 CHANGELOG 与代码版本锚点）：
  - CHANGELOG.md 旧条目（`## 2.3.2 — 2026-11-10` 及其下全部旧版本段）
  - lib/plan.js、lib/runtime.js、dist/plan.js、dist/runtime.js、tests/plan.test.ts 中的 `[2.3.2]` 注释锚点
  - docs/release-notes-2.3.2.md、docs/release-record-2.3.2-20261110.md、历史 .tgz 文件名

## 2. 声明位逐行改法（原子一次性执行）

| # | 文件:行 | 现值 | 改为 |
|---|---|---|---|
| 1 | package.json:3 | `"version": "2.3.2",` | `"version": "2.3.9",` |
| 2 | package-lock.json:3 | `"version": "2.3.2",` | `"version": "2.3.9",` |
| 3 | package-lock.json:9 | `"version": "2.3.2",` | `"version": "2.3.9",` |
| 4 | src/host.ts:1584 | `version: '2.3.2',` | `version: '2.3.9',` |
| 5 | lib/host.js:1455 | `version: '2.3.2',` | `version: '2.3.9',`（等价定向补丁；若执行时做全量构建则构建会重新生成，二者取一，勿双写冲突） |
| 6 | dist/host.js:1455 | `version: '2.3.2',` | `version: '2.3.9',`（同上，构建则免） |
| 7 | README.md:6 | 徽章 `version-2.3.2-blue` + 链接 `releases/tag/v2.3.2` | 均 → `2.3.9` |
| 8 | README.md:72 | `dsh plugin --profile web add dsh-workplan@2.3.2` | `@2.3.9` |
| 9 | README.en.md:6 | 同 7 | 同 7 |
| 10 | README.en.md:83 | 同 8 | 同 8 |
| 11 | README.zh.md:6 | 同 7 | 同 7（主 Agent 指示：测试未覆盖徽章，手工同步） |
| 12 | README.zh.md:72 | 同 8 | 同 8 |
| 13 | tests/fixtures/tool-surface.json:3 | `"version": "2.3.2",` | `"version": "2.3.9",` |
| 14 | CHANGELOG.md:1 之前 | （无） | 插入新段标题 `## 2.3.9 — <发布日期>` + 本次机制优化要点（LLM 类型检测/推理等级约束/部门告知/负责人二次分配/三层派发），旧 `## 2.3.2` 段原文保留 |

## 3. 执行顺序与门禁（A3）

1. T4b 落地且其 tool-surface fixture 更新稳定后再改第 13 项（T4b 会重写该文件，避免双写）。
2. 全部声明位一次改完（原子），不留中间态。
3. 验证 A2（一致性）：`grep -rn "2\.3\.2" --exclude-dir=node_modules --exclude-dir=reports --exclude-dir=docs . | grep -v "\[2\.3\.2\]"` → 应仅剩 CHANGELOG 历史段（可加 `--include` 白名单复核声明位为 0）。
4. 验证 A1（产物版本）：若跑全量 build（`npm run build`），构建后 `grep -n "version: '2" lib/host.js dist/host.js` 输出 2.3.9；若不 build 用定向补丁，等价成立。
5. 验证 A3（构建无错）：live 仓库只做 `npx tsc --noEmit`（零副作用）；全量测试在 /tmp 隔离副本跑（符号链接 node_modules，补齐 package-lock/CHANGELOG/README×3/docs/scripts，历史教训 T2 2.2.5 已记录缺件 ENOENT 的补齐清单）。
6. 运行已编译 version-sync 测试断言：package.json/lock×2/src/host.ts/lib/fixtures/README×3 一致（主 Agent 指示其为权威门禁）。
7. sha256-manifest.json 与 lib 产物哈希耦合，定向补丁 lib/host.js 会使清单过期 → 交由 T7 发布流程重建清单，勿在本行手改。

## 4. 风险与红线

- 禁止在 T3/T4b 未完成时中途改版（version-sync 门禁会红，主 Agent 明令）。
- 禁止全局盲替 `2.3.2`（历史位/锚点/文档记录必须保留）。
- 禁止在 live 仓库跑含 build 副作用的 npm test（会覆盖 lib/、扰动并发写者）。
