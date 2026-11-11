# 要求2「selfEffort 自配置机制」发布收尾前置条件核对清单（版本保持 2.5.0）

- 核对人：版本发布部 member（清单核对）
- 核对时间：2026-11-11 约 19:55（Asia/Shanghai）
- 仓库：/Users/open/Documents/Stocks/plugins/dsh-workplan（独立 git 仓库）
- 方式：全程只读（read/grep/glob + 只读 git/ls 命令）；未编辑任何既有文件、未 install/build/test、未做任何 git 写操作；本报告为唯一新建文件。

## 1) 版本统一 2.5.0 —— PASS

| 位置 | 实测证据 | 结果 |
|---|---|---|
| package.json:3 | `"version": "2.5.0",` | 2.5.0 ✓ |
| package-lock.json:3（顶层） | `"version": "2.5.0",` | 2.5.0 ✓ |
| package-lock.json:9（packages[""]，已读 1–12 行确认结构） | `"version": "2.5.0",` | 2.5.0 ✓ |
| src/host.ts:1737（`export const meta` 起于 1735 行） | `version: '2.5.0',` | 2.5.0 ✓ |
| tests/fixtures/tool-surface.json:3 | `"version": "2.5.0",` | 2.5.0 ✓ |
| README.md:6 / README.en.md:6 / README.zh.md:6 | 徽章 `version-2.5.0-blue.svg`（三语一致） | ✓ |
| README.md:72 / README.en.md:83 / README.zh.md:72 | 安装行 `dsh plugin --profile web add dsh-workplan@2.5.0`（三语一致） | ✓ |
| CHANGELOG.md:1 | `## 2.5.0 — 2026-11-11` | ✓ |

## 2) git 基线 —— PASS

- `git log -1 --format='%H %s'` 实测：
  `9d13fa8c969410f915881699eecc8ebd7bfe9ab5 Release 2.5.0: 部门负责人再分配权限+整体推理等级全程贯穿+分解更简单+重试保留已完成部分+分配前耗时预告+G1回放消费端三字段透传修复；版本统一2.5.0；全量785/0/0`
  → HEAD = 9d13fa8（与基线一致）✓
- `git status --short` 实测输出为空 → 工作树干净 ✓（机制部尚未开始改动，无「机制部进行中」文件清单）。

## 3) 旧口径独立复扫 —— PASS（复扫完成；命中已如实记录，README 三语确认干净）

### 3a. 「未单独配档|整体推理等级|继承整体|整体等级」于 CHANGELOG.md 与 docs/cc/

逐词 grep 实测命中（每文件行号）：

| 文件:行号 | 未单独配档 | 整体推理等级 | 继承整体 | 整体等级 |
|---|---|---|---|---|
| CHANGELOG.md:4 | ✓ | ✓ | ✓ | ✓ |
| docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md:31 | ✓ | — | — | — |

- CHANGELOG.md:4 为 2.5.0 发布条目「负责人配置整体推理等级并全程贯穿（用户要求 2）」，四个旧口径词均在该行（描述 taskReasoningEffort/effortOverride/resolveTaskEffort 旧机制）。
- docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md:31 为 delegate 工具规格行，命中「未单独配档」（"未单独配档的下级继承它"）；其余三词在 docs/cc/ 全目录零命中。
- 除上述两处外，CHANGELOG.md 与 docs/cc/ 无其他命中。
- 定性：这两处是上一轮 2.5.0 的既有发布记录/规格描述，属冻结后发布部「文档最小改动」的待更新点，不构成本轮前置条件失败。

### 3b. README 三语推理等级机制句子扫描

- `grep -nEi 'effort|inherit|overall|等级|推理' README.md README.en.md README.zh.md`：全部命中仅 1 处——
  README.en.md:186 `... plus a weighted overall figure`（展开面板进度条描述，按任务要求排除）。
- `grep -nE '档位|配档|xhigh|reasoningEffort' README.md README.en.md README.zh.md`：三语零命中。
- 结论：三语 README 确无推理等级机制句子 ✓。

## 4) 新机制落码状态（selfEffort）—— PASS（符合预期：零命中）

- `grep -rn 'selfEffort' src/ lib/` 实测零命中（src/ 与 lib/ 目录均存在，已用 ls 确认）。
- 结论：机制部尚未落码、未冻结，与本轮预期一致；无「机制部已部分落码」位置需记录。

## 5) 测试基线 —— PASS

- tests/*.test.ts 文件数：glob 计 108 个，`ls tests/*.test.ts | wc -l` 复核 = **108**。
- reports/release-250-20261111.md §5（L52–59）实读确认上轮全量：
  - L56：`tests 785 / pass 785 / fail 0 / cancelled 0 / skipped 0 / todo 0，exit 0`（TAP 收尾 `1..785`，duration ≈60.5s）
  - L57：`[run-tests] pass=785 fail=0 cancelled=0 exit=0`
  - L58：G1 修复前首轮 784/0/0，修复新增 1 例后总数 785。
- 本轮预期：785 + 机制部 selfEffort 新增用例（待机制部冻结后实测）。

## 6) reports/ 目录存在且可写 —— PASS

- `ls -ld reports` 实测：`drwxr-xr-x 46 open staff 1472 Nov 11 19:31 reports` → 目录存在，属主 open 具写权限（本报告即写入其中）。未创建任何测试文件。

---

## 总体结论：PASS

六项核对全部通过：版本六处+三语徽章/安装行+CHANGELOG 首行统一 2.5.0；HEAD=9d13fa8 且工作树干净；旧口径仅存于 CHANGELOG.md:4 与 docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md:31（冻结后文档最小改动的待更新点），三语 README 无推理等级机制句子；selfEffort 在 src/ 与 lib/ 零命中（机制部未落码，符合预期）；上轮基线 785/0/0 已实读确认、现有 108 个测试文件；reports/ 存在可写。发布收尾可待机制部冻结后启动（文档最小改动 + build + 全量测试 + 新提交，版本保持 2.5.0）。
