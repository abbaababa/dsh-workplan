# R3 最小修复补丁报告（T3 · 工程研发 · 冻结版）

- 计划：`wp-480eda74-6759-4794-a64a-d46ae5c4eaf1` · 子任务 T3 · 最终交付物之一
- 负责人：agent-18（engineering:T3，结算重试＋评审修正轮集成负责人）
- 双链署名（完整证据链，不可拆分）：
  - **agent-17 链**（原任部门负责人及其叶子）：E 系列实验、语料副本＋manifest＋P1 独立 oracle、毒丸干跑＋修复脚本、回归主套件（13 项）、补丁实现（expert-patch 双实例＋最小手术＋spec-5 预热）、修正规格 A/B/C 裁决、L5/L6/L7 补充回归、独立复核。
  - **agent-18 链**（本尝试）：独立同行评审＋确定性探针（发现 1 高危＋1 中危＋1 低危）、评审修正轮实施＋补丁包再生成＋冻结验证、真实语料决定性计时终验＋预热实证、本报告与结算。
- 时间窗口：2026-11-12 22:17–23:10（Asia/Shanghai）；补丁包冻结：22:55；双链独立复核全部通过：23:04
- 合规：全程未重启、未安装/升级依赖、未从 npm 重装、未调用主计划派发工具；对宿主 checkout 与 `~/.dsh` **零写入**（沙箱 workspace-write 实测拒写，全部产物落工作区）。

## 0. 结论摘要（小白版）

**修好了，而且经过「独立评审→发现隐患→再修→再验证」的完整闭环。** 原来搜索历史会话时，程序必须先把全部 2118 个历史会话一口气读完才肯把成果写进索引，30 秒一到就全部作废、下次从头再来——永远搜不出东西。现在改成**读一个、存一个**：30 秒到点时已读完的部分牢牢保住，下次接着读，几轮之后索引建全，搜索毫秒级返回；**一个坏存档不再拖垮全部**；**正在写入的活跃会话不再把整轮比对搅黄**。

独立评审还抓到并修掉了两个隐藏隐患：①「全失败保险丝」会在坏存档被隔离后的第二次安静搜索时误报「整体失败」——已改为「只要还有已索引的好会话就绝不熔断」；②中途掐断但已存了新数据时，翻页用的「变更令牌」不更新，旧翻页凭证可能被放行——已改为「部分提交即更新令牌」。另有启动期后台预热（重启后后台建索引，不占搜索预算）与应用器原子写/自动回滚加固。

**决定性数字**：同一复现查询 P1（lead 会话内搜 `R1`，seq≥1），基线引擎 **30003ms 超时、0 条结果**；修复引擎（冻结版）在已收敛索引上 **562ms 返回 62 条命中**，与独立 oracle 的 62 条**逐条逐序完全一致**（0 差异）。4 个「毒丸」旧存档的加固修复干跑已闭环（真实后端从「一个都读不出」变为「4 个全部可读」），正式写入真实存档留给主 Agent 经审批执行。

**诚实边界**：冷启动后的头几次搜索仍会各用满 30 秒（但每次都有进展、不再死循环，约 5–6 次收敛）；启用「启动预热＋持久索引路径」（§7.3 配置建议，主 Agent 决定）后，重启只需后台建一次索引，之后跨重启都是毫秒级。在体（真实进程）验证需主 Agent 应用补丁＋用户手动重启后进行（H2 分工）。

## 1. 根因回顾与补丁设计（对照 T2 判定，逐条映射）

T2 单一根因（[R3-root-cause.md](plugins/dsh-workplan/reports/R3-root-cause.md) §1）：`searchEvents` 先全语料 `_reconcile`，整轮稳定观察成功后才一次性提交；单轮观察离线下限 24.2s、在体必然 >30s 合作式预算 → 每次调用中止于提交前 → `:memory:` 索引永远为空 → 无限重复。

补丁（仅 `@deepseek-ai/dsh-session-query-sqlite` 一个包的 `src/index.ts` 与 `lib/index.js`，冻结版 472 行统一 diff）：

| # | 机制 | 对应根因环 | 实现要点 |
|---|---|---|---|
| 1 | **逐会话增量提交** | §1.5 一次性提交＋§1.6 死循环 | 观察前预定 `nextMainGeneration`；`commitPersisted` 闭包对每个冷读完成的会话立即 `BEGIN IMMEDIATE→_replacePersistedSession→COMMIT`（失败 ROLLBACK＋INDEX_FAILED）；中止保留已提交行，下次经既有 revision 门增量收敛；观察 Map 不再积压，峰值内存下降 |
| 2 | **失败隔离＋零成功保险丝** | §3.4 毒丸次生缺陷 | 单会话冷读失败仅记录＋具名 warn；中止/换绑优先上抛；**索引级提交失败（INDEX_FAILED）上抛不隔离**（评审修正 C）；保险丝三条件 `attempts>0 && successes===0 && skippedAsIndexed===0`（评审修正 A：有任何已索引跳过即证明 list+索引路径可用，安静含毒丸语料不误熔断；全新全毒丸仍 fail-closed） |
| 3 | **稳定性收窄到本轮冷读会话** | §3.2.3 churn 整轮重试 | `coldReadRevisions` 只比对本轮真正冷读过的会话；活跃存档 churn 不再触发整轮重试；删除 `samePersistenceSnapshots` 全量比对 |
| 4 | **启动期后台预热（配置门控）** | §1.7 冷启动预算缺口 | 仅 `openAt:'startup'`：fire-and-forget 后台 `_reconcile`（不占工具预算、失败仅日志）；`_close()` 经 `_prewarmAbort` 中止（关闭不被拖累，进展保留）；`first-search`/`never` 零行为变化 |
| 5 | **评审修正轮（A/B/C＋尾事务补强＋应用器加固）** | 评审探针实证 | A 保险丝 skippedAsIndexed；B1 每个提交事务内同步 `UPDATE search_state`（中止后 DB 与行代际一致）；B2 `_observeStable` 异常路径与尾事务异常路径在 `persistedWriteCount>0` 时内存令牌+1 后重抛（旧 sessions 游标正确失效）；C 见机制 2；应用器原子写＋备份不覆盖＋post-check 失败自动回滚 |

**保留不动的硬语义**（[PATCH-NOTES.md](plugins/dsh-workplan/patches/r3-session-search/PATCH-NOTES.md) §4 清单＋评审逐 hunk 复核）：live-preferred SQL、generation 单调、游标 encode/decode＋STALE_CURSOR、`_replacePersistedSession`/`_replaceLiveSession`/`_queryEvents`/`_querySessions`/`selectedDocumentsSql`、schema 版本（无新表/列）、宿主侧 30s 阈值、其它一切包。**R1/R2 已闭环的读取与派发链路不在本包内，diff 未触及。**

## 2. 变更文件清单与哈希（A1，冻结版 22:55）

补丁包：[plugins/dsh-workplan/patches/r3-session-search/](plugins/dsh-workplan/patches/r3-session-search/)

| 文件 | sha256 | 说明 |
|---|---|---|
| baseline/src/index.ts | `72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3` | 与 checkout 原件逐字节一致（cmp＋shasum 双向亲测） |
| baseline/lib/index.js | `dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0` | 同上 |
| patched/src/index.ts（1218 行） | `ee4d11b8ae26326d1397491295c3d9303cd9ffaf4a0ced1c292ba2278eee7bd6` | 修复后源码（含评审修正轮） |
| patched/lib/index.js（1232 行） | `574ef3ccd75025aaa3546890395aceb9fc4f9565ad364ffbabcaa9e7b74b4114` | 修复后运行 bundle（与 src 语义等价） |
| r3-session-search.patch（472 行） | `e14923ea87f4c46fc8e8f07055a7998dce51700ab7b5b7bbf9ce0cbd3d5a0af8` | src＋lib 双轨统一 diff |
| apply-r3-patch.py | `db9f4ea2dc09bba43c36f359dd326202f80cd4b421192770c0c3be219a65fa6e` | 幂等应用器（内嵌全文＋运行时哈希自检＋原子写＋自动回滚） |
| MANIFEST.md | `890d0f550f8baf4c0c34d8250702551e702c389463447d22785c7a904ffc73c7` | 包清单 |
| SHA256SUMS.txt | `6ec05d704ec0bf96d673aa606afda45677add886ba7a617b835f4381478838b0` | 9 件全量校验单 |

**可复核性（负责人亲测＋评审独立复演）**：
- 基线→补丁套回复现：`patch -p1` 套用于 baseline 副本后与 patched/ 逐字节 `cmp` **src exit=0、lib exit=0**（verify/roundtrip-final/；评审另以 git apply 双工具复现）。
- 应用器内嵌 SRC_CONTENT/LIB_CONTENT 哈希 == 声明 PATCHED_SHA256 == 盘上 patched 文件（python hashlib 三方比对全 True）。
- `shasum -a 256 -c SHA256SUMS.txt` → **9/9 OK**（冻结后亲跑）。
- 运行态标记：`[R3-fix] incremental per-session commit` 与 `[R3-fix] startup background pre-warm` 等 R3-fix 标记两文件各 7 处（grep -c 实测；应用后验收用标记而非版本号）。
- 逐 hunk 语义映射：PATCH-NOTES §1（spec→行号，最终树重新 grep）＋§7（评审修正轮）；独立同行评审 [expert-patch-review.md](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/t3-final-agent18/expert-patch-review.md)＋冻结版焦点复审 addendum（同目录）。

## 3. 回归用例（A2，全部可重复运行，冻结哈希绑定）

### 3.1 主套件 [tests/r3-session-search/](plugins/dsh-workplan/tests/r3-session-search/)（13 项，合成夹具＋真实 cordis 装配，秒级）

```bash
cd plugins/dsh-workplan/tests/r3-session-search
R3_EXPECT=baseline node run.mjs        # 基线：恰好 6 绿 7 红（S1.2/S1.3/S1.5/S2.1/S2.2/S4.1/S4.2）→ MATCH, exit 0
R3_LIB_PATH=<patched/lib/index.js> R3_EXPECT=fixed node run.mjs   # 修复：13/13 全绿, exit 0
R3_LIB_PATH=<patched/lib/index.js> node lead-supplement.mjs       # 补充 28 项（见 3.2）
```

冻结版实测（负责人隔离副本重跑，raw/final-*.log）：baseline 精确 MATCH exit 0；fixed **13/13** exit 0。组员双份独立隔离重跑（agent-2 与 member3）结论逐项吻合：baseline MATCH、fixed 13/13（对 5ff314ea 与 fdb67cd0 两版均绿）、毒丸 0→4、哈希一致（[member-rerun-report.md](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/t3-final-agent18/member-rerun-report.md)、member-rerun-report-agent3.md、raw/）。

### 3.2 补充套件 lead-supplement.mjs（28 项＝14 基础＋5 预热 L4＋9 评审回归 L5×2/L6×6/L7×1）

- 冻结版 fixed：**28/28 exit 0**（日志头部绑定 lib sha 574ef3cc…）。
- 基线缺陷捕获：21/28，红＝L4.1/L4.2/L4.4（预热）＋L5.1/L5.2（毒丸安静重复）＋L6.1/L6.2（中止提交游标）——新检查精确捕获旧缺陷。
- 修正前 patched（fdb67cd0）缺陷捕获：agent-17 落盘 [experiments/final-verify/supplement-defect-capture-patched.log](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/experiments/final-verify/supplement-defect-capture-patched.log)（L5.1/L6.2/L6.5/L6.6/L7.1 红）＋基线对照 supplement-defect-capture.log——构成「修正前后差分」证据。
- L5=毒丸隔离后重复安静调用×3 全 ok；L6=中止部分提交后旧游标 STALE_CURSOR＋DB 代际同步（四步交错双游标）；L7=外部 DROP persisted_docs 后提交失败以 INDEX_FAILED 传播而非隔离。

### 3.3 行为对照套件 patches/…/verify/behavior.mjs（真实引擎微语料）

- 冻结版 patched expect=fixed：**14/14 PASS**（A1 中止保留进展、A2 续跑收敛、A3 已提交零重读、A4 代际单调（不变量 row≤global 且 global==max(row)）、**A5 中止部分提交后旧 sessions 游标 STALE_CURSOR**、B1 毒丸隔离、B2 具名 warn、**B3 隔离后第 2/3 次安静调用仍 ok**、C1 零成功保险丝、D1 churn 收敛、P1–P4 预热四态）。
- baseline expect=baseline：**5/5 PASS**（证明缺陷原本存在）。
- 原始输出：verify/behavior-patched.log、behavior-baseline.log（冻结哈希绑定）。

### 3.4 毒丸回归（真实编译后端，非仿制品）

`poison-dryrun/_impl/verify-backend.mjs`：copies → **listedCount=0**（fail-closed）；repaired --read → **listedCount=4 全可读**（事件 488/193/212/297，noticesAllIgnorable 全 true）；原件 sha256 4/4 未变。组员双份独立重跑同值（raw/poison-*.json、member3-poison-*.json）。

## 4. 修复前后对比计时（A3，同一 P1 复现参数，原始 JSON 全部落盘）

P1 = `{"session_id":"session-6e26e9e5-1d95-4d47-b59d-4d75b838cae7","query":"R1","seq_from":1}`（T1 历史超时调用原参数，limit=100 观测全量命中）。语料 = 工作区只读副本（4452 文件/810,118,570 B，manifest 快照 sha `a107ab5c…`）；引擎 = 真实 `SqliteSessionQueryEngine`＋真实 JSONL 后端；预算 = 真实 30s 合作式 AbortSignal。

### 4.1 E 系列（agent-17 负责人跑，本负责人逐份亲读核对；experiments/）

| 实验 | 引擎 | 预算 | 语料 | 耗时(ms) | 结果 | 已提交会话/文档 |
|---|---|---:|---|---:|---|---|
| E1 | 基线 | 30s | corpus | 30003 | **aborted** | **0 / 0**（R3 离线忠实复现） |
| E5 | 基线 | 10s | corpus | 10000 | aborted | 0 / 0 |
| E2 | 修复 | 30s | corpus | 30003 | aborted | **561 / 69379**（进展保留） |
| E3 | 修复 | 30s | 续跑 E2 | 30016 | aborted | **1027 / 119627**（增量收敛） |
| E4 | 修复 | 30s | 续跑 E3 | 30060 | aborted | **1379 / 155978** |
| E5p | 修复 | 10s | corpus | 10000 | aborted | 52 / 5291（小预算也有进展） |
| E6 | 修复 | 无 | corpus | 203868 | **ok，62 命中** | 2216 / 306371，gen=1 |
| E7 | 修复 | 30s | E6 已建索引 | **700** | **ok，62 命中** | 2216 |
| E8 | 修复 | 无 | corpus-repaired | 235150 | **ok，62 命中** | **2220**（含 4 毒丸） |

### 4.2 负责人独立全量建索引与 30s 查询组（t3-final-agent18/）

- **独立全量建索引**（corpus-repaired，无预算，自己的 db，lib 5ff314ea 跑前后哈希记录）：**240823ms，ok，62 命中，2220 会话 / 307052 文档，gen=1**，峰值 RSS 727MB（LEAD-repaired-fullbuild-nobudget.json）。与 E8 独立互证。
- **收敛后 30s 预算查询组**（lib fdb67cd0，运行前后哈希一致；LEAD-post-convergence-30s.json）：

| 查询（T1 原参数） | 耗时(ms) | 结果 | 命中 |
|---|---:|---|---:|
| **P1**（lead 会话搜 R1，seq≥1） | **600** | **ok** | **62** |
| P3（1513 会话搜 session，seq 0–16） | 520 | ok | 1 |
| 全工作区 session_search「任务分解」 | 1068 | ok | 100（limit 上限，有 nextCursor） |
| 毒丸会话 72c219a9 搜 IMG_0464（修复后可见性探针） | 438 | ok | 16 |

- **正确性**：P1 命中集合 vs 组员独立 oracle（真实 FTS5＋从零 JS 分词器双方法）——`countMatch=true、seqOrderMatch=true、perHitMismatches=0、verdict=MATCH`（LEAD-P1-compare.json，compare-p1.mjs exit 0）。**没有为提速牺牲召回或排序。**

### 4.3 启动预热真实语料实证（lib fdb67cd0，LEAD-prewarm-startup.json）

openAt:'startup'，零搜索调用等待后台建索引：**activation 9ms（不阻塞启动）**，后台收敛 **226805ms（≈3.8 分钟）**，2220 会话全索引；随后 P1@30s → **ok，472ms，62 命中**。推荐部署模式在真实语料上端到端成立。

### 4.4 冻结版（574ef3cc）真实语料复验（负责人亲跑，运行前哈希记录一致）

- **全量建索引**（corpus-repaired，无预算，LEAD-final-fullbuild-nobudget.json）：**210744ms，ok，62 命中，2220 会话 / 307052 文档，gen=1**，峰值 RSS 723MB——与 5ff314ea 版（240823ms）及 E8（235150ms）同量级互证。
- **收敛后 30s 预算查询组**（LEAD-final-battery.json）：

| 查询（T1 原参数） | 耗时(ms) | 结果 | 命中 |
|---|---:|---|---:|
| **P1**（lead 会话搜 R1，seq≥1） | **562** | **ok** | **62** |
| P3（1513 会话搜 session，seq 0–16） | 504 | ok | 1 |
| 全工作区 session_search「任务分解」 | 1066 | ok | 100（limit 上限） |
| 毒丸会话 72c219a9 搜 IMG_0464 | 432 | ok | 16 |

- **正确性**：P1 vs 独立 oracle → `countMatch=true、seqOrderMatch=true、perHitMismatches=0、verdict=MATCH`（LEAD-final-P1-compare.json，compare-p1.mjs exit 0）。
- **启动预热**（openAt:'startup'，零搜索调用等待后台收敛，LEAD-final-prewarm.json）：**activation 10ms（不阻塞启动）**，后台收敛 **250612ms（≈4.2 分钟）**，2220 会话全索引；随后 P1@30s → **ok，488ms，62 命中**。与 fdb67cd0 版实证（9ms/226805ms/472ms，§4.3）跨版本一致。
- **agent-17 冻结版全量独立复核（23:04 通过，experiments/frozen-verify/）**：六件哈希一致、shasum -c 9/9、diff 套回全新基线 cmp×2=0、tsc strict=0、node --check=0、主套件 fixed 13/13×2＋baseline MATCH、supplement fixed 28/28×2（sha 绑定）＋baseline 21/28 精确捕获、behavior 14/14 vs 5/5、applier 2/0/0/3；快速 E 系列互证：E2/E3 进展 500→874、E5p 51、E7 热 1142ms 62 MATCH、P3 606ms、E6-frozen 243385ms 2216/306371/62 MATCH、E8-frozen 210018ms 2220/307052/62 MATCH＋4 毒丸 ID 全部入索引——与本报告 §4.4 流水线（210744ms/562ms/488ms）在负载差内一致。测试侧改动（PATCH-NOTES §7）经其审阅认定为合法语义适配而非断言弱化。**双链独立复核至此全部通过。**

**A3 判定：pass。** 同一 P1 参数：基线 30003ms 超时 0 结果 → 修复后收敛索引上 600ms（冻结版复验见 §4.4）返回 62 条正确结果（≪30s）。冷启动收敛过程与预热窗口如实披露于 §8。

## 5. 构建与静态检查（A4，冻结哈希绑定）

| 检查 | 结果 | 证据 |
|---|---|---|
| tsc 5.9.3 strict/nodenext/noEmit（冻结 patched src＋原样 query.ts/schema.ts） | **exit=0** | verify/typecheck/tsc-patched.log（命令原文/版本/src 哈希/退出码/时间戳全记录）；负责人另跑 [tsc-lead-rerun2.log](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/t3-final-agent18/tsc-lead-rerun2.log) |
| tsc 基线对照 | **exit=0** | verify/tsc-baseline.log（补记退出码，填补评审 §9 缺口） |
| node --check patched/lib/index.js | **exit=0** | 负责人亲跑（冻结后） |
| diff 套回基线复现 patched（src＋lib） | **cmp exit=0 ×2** | verify/roundtrip-final/（负责人亲跑，绝对路径修正后）；评审 git apply/patch -p1 双工具复现 |
| 应用器内嵌内容哈希三方一致 | **全 True** | python hashlib 比对（§2） |
| SHA256SUMS.txt 全量复算 | **9/9 OK** | 冻结后亲跑 shasum -c |
| 应用器演示（工作区副本） | no-args exit=2 / 首apply exit=0（原子写＋备份哈希==基线）/ 二次apply 幂等 skip exit=0 / 篡改 exit=3 | verify/applier-demo.log（冻结版重生成） |
| happy-path 冒烟（基线 vs 修复） | 两版 SMOKE PASS 输出逐字一致 | verify/smoke-baseline.log / smoke-patched-final.log |

说明：宿主包随包无构建脚本（lib 为预编译 ESM bundle），故「可编译进本地运行产物」以 **src 严格类型检查通过＋lib 与 src 语义等价（双轨 diff＋行为对照 14/14＋冒烟逐字一致＋套回复现）** 证明；应用器写入后自带 marker/哈希/node --check 三重后置校验＋失败自动回滚。

## 6. 毒丸存档加固修复（干跑闭环，正式应用留主 Agent）

- 对象：`~/.dsh/sessions/--Users-open-Documents-Stocks--/` 下 4 个旧存档（1075b1b0/4b036b43/72c219a9/d93cd464），共 **21 条** `workplan/notice` 未标 ignorable＋整日志单 zstd 帧违反「首帧恰一行头」不变量 → 真实 list() 静默跳过（会话「消失」）。
- 脚本：[plugins/dsh-workplan/scripts/repair-poison-notices.mjs](plugins/dsh-workplan/scripts/repair-poison-notices.mjs)（默认干跑只动工作区副本；`--apply` 先原目录 `.bak-<时间戳>` 备份并校验哈希，再 tmp+rename 原子替换）。
- 干跑证据（[poison-dryrun/](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/poison-dryrun/)）：真实编译后端 list() **0→4**、open('read')+read() 全过（488/193/212/297 事件）；每行仅在 `{` 后插入 `"ignorable":true,`，头行与其余字节逐行不动（diff-minimality.txt＋逐文件 diff）；帧数 1→2；双备份＋回滚命令；原件 sha256 修复前后 4/4 一致（零污染）。
- 当前插件写入行为已核实不再产生该缺陷（notice 全走 user/message，src grep workplan/notice 零命中）——毒丸系旧版遗留，无需改插件写入路径。
- corpus-repaired 全语料副本（4 毒丸已修复＋4 个 .bak 备份文件，list() 只认 session.v4.jsonl.zstd，.bak 不参与）用于 §4 终验：全语料 2220 会话全部可索引，毒丸会话可搜（IMG_0464 探针 16 命中）。

## 7. 给主 Agent 的建议动作（A6，本尝试一律未自行执行）

1. **应用补丁**（工作区外，需审批）：`python3 plugins/dsh-workplan/patches/r3-session-search/apply-r3-patch.py --target /Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai/dsh-session-query-sqlite`。应用器自带基线哈希门禁/备份 `.bak-r3`（不覆盖已有备份）/原子写/幂等/后置校验＋失败自动回滚；应用后按 MANIFEST §4 grep 标记＋shasum 比对。
2. **毒丸正式修复**（工作区外，需审批）：`node plugins/dsh-workplan/scripts/repair-poison-notices.mjs --apply`（先备份后原子替换；回滚=恢复 .bak-<时间戳>）。
3. **配置决策（推荐组合）**：把 bundle `dsh-experimental-session-search` 的引擎配置改为 **持久索引路径＋启动预热**，索引跨重启保留、重启后仅增量对账，无需每次重建约 4 分钟。建议 overlay（追加到 `~/.dsh/profiles/web/cordis.patch.yml`，agent-17 已核实现有语法；loader 若为替换语义，两字段同写亦安全；schema.ts 已支持建目录/建库/owner-only/application_id 校验；派生索引可随时删除重建）：
   ```yaml
   - id: optional-session-query-sqlite
     config:
       path: /Users/open/.dsh/cache/dsh-session-search/index.sqlite
       openAt: startup
   ```
   保持现行 `first-search`＋`:memory:` 则走增量收敛（头几次搜索各 30s 但有进展，约 5–6 次收敛，重启归零）。**本尝试未改任何配置**，取舍由主 Agent/用户决定。
4. **用户手动重启 dsh web**（规则 18：禁止代重启）。
5. **重启后在体验证**（T4/主 Agent）：重放 P1——startup＋持久路径模式首次重启后等待后台建索引（约 4 分钟，期间搜索会排队并可能中止，属已披露取舍），之后毫秒级；后续重启仅增量对账。first-search 模式连续重放至收敛（预期 ≤6 次）。另以 IMG_0464 探针确认毒丸会话可搜。预期命中 62（活体会话自然增长可能更多，以快照锚定口径比对）。
6. **回滚**：恢复两个 `.bak-r3`（或 `git apply -R r3-session-search.patch`）＋毒丸恢复 .bak＋手动重启；持久索引文件可直接删除重建。

## 8. 诚实披露与已知边界

1. **冷启动头几次搜索仍会中止**（first-search 模式）：每次 30s 但进展保留（561→1027→1379→…→2220），死循环已打破；预热＋持久路径组合可将其移出工具预算并跨重启保留。
2. **预热窗口内搜索排队**：预热与搜索共享 `_serialized` 队列（正确性优先），预热进行中到达的搜索会排队并在自身预算到点时中止；预热完成后毫秒级（P1–P4、L4、§4.3 实证）。
3. **在体验证待 H2**：本尝试全部计时为工作区副本上的真实引擎离线实证；真实进程效果需应用＋重启后由 T4/主 Agent 复核（分工已获用户批准）。
4. **lib 迭代窗口与哈希绑定**：补丁包经五轮收敛（1c4f297a→5ff314ea→fdb67cd0→cab41d5a→**574ef3cc 冻结**；第 4/5 轮为评审修正 A/B/C＋尾事务补强）。E2–E8 与负责人首轮全量建索引跑于迭代窗口内（进程启动时 import 定格，负责人跑前后哈希已记录）；fdb67cd0 查询组/预热实证运行前后哈希一致；**冻结版 574ef3cc 绑定：behavior 14/14、主套件 13/13、supplement 28/28、tsc/node --check/套回/应用器演示全绿，真实语料复验见 §4.4**。
5. **评审发现与修正（差分证据）**：独立评审探针实证 1 高危（保险丝误熔断，probe/poison-applied.json call2/3 FAIL）＋1 中危（中止提交游标令牌滞后，probe/cursor2-applied.json）＋1 低危（写故障被隔离）；修正规格由 agent-17 裁决（A/B/C）＋agent-18 评审/探针，尾事务补强为 agent-17 边角建议（已采纳）；修正前缺陷捕获日志与修正后全绿构成完整差分（§3.2/3.3）。
6. **测试侧改动（实现未动）**：behavior A4 不变量改为 row≤global 且 global==max(row)（B1 逐提交同步后混合代际为合法态）；A5 outcome 字符串对齐原始错误码；P1 预热轮询窗 4s→30s（并发全量建索引负载下观测到抖动）；inspect() 防御化（预热异步建库竞态）。全部披露于 PATCH-NOTES §7。
7. **双写者事件**：平台并行尝试导致补丁包一度双写（22:13 twin 写入、22:23–22:32 收敛窗口），agent-17 负责人裁决单一写者、splice PRE-WRITE 断言拒写未遂、TWIN-HASHES-PRE 留痕；22:44 评审修正轮再次裁决 agent-18 为 patches/、本报告、结算唯一写者，agent-17 独立复核（其结算另写 wp-settlement-T3-agent17.json 不覆盖）。未发生第三次事故。
8. **有界陈旧（评审 F2，设计内）**：稳定性收窄后，被跳过会话的 churn 至多延续到下一次调用（每次调用都校 revision），≤1 轮自愈；孤儿行边界同理自愈（评审 §7.2）。live-only 轮 nextMainGeneration 恒+1 为良性漂移（游标失效集合与基线相同，评审 §4b 核实）。
9. **corpus-repaired 含 4 个 .bak 备份文件**（干跑演练产物），不参与 list()。宿主终端日志侧佐证缺失（T2 §6 已写明采集人）；30s 阈值与中止位置由代码＋计时证明。

## 9. 验收对照（逐条）

- **A1 补丁只针对已判定根因，清单与 diff 可逐条复核**：pass — §1 五机制逐条映射 T2 根因环＋评审修正；§2 冻结六件哈希＋套回复现 cmp×2 exit 0＋应用器三方哈希一致＋SHA256SUMS 9/9；PATCH-NOTES §1/§7 逐 hunk 行号映射＋§4 保留语义清单；独立同行评审＋冻结版焦点复审。
- **A2 新增回归用例可重复运行且通过**：pass — §3 主套件 13 项（基线精确 MATCH／修复 13/13）＋补充 28 项（修复 28/28、基线 21/28 缺陷捕获、修正前 patched 捕获差分）＋行为 14/14 vs 5/5（含 B3/A5 评审回归）＋毒丸 0→4；组员双份隔离重跑复现；全部命令可重跑、原始输出落盘。
- **A3 同一复现参数本地耗时由超时降至 30s 内**：pass — §4：P1 基线 30003ms aborted 0 命中 → 修复冻结版收敛索引 **562ms ok 62 命中**（oracle 逐条逐序 MATCH；预热模式 488ms）；P3/全工作区/毒丸探针全部 <30s ok；冷启动收敛与预热窗口如实披露。
- **A4 构建与静态检查通过**：pass — §5：tsc 5.9.3 strict 冻结 src exit=0（基线对照亦 exit=0）＋node --check exit=0＋套回复现＋冒烟逐字一致＋应用器演示 2/0/0/3（原子写/备份/回滚）。
- **A5 未重启/未安装/未 npm 重装/未调主派发**：pass — 全程仅工作区写入＋只读命令；delegate 仅本部门两层；checkout/~/.dsh 零写入；无任何 restart/install/npm 命令。
- **A6 需主 Agent 的动作以建议列出，未自行执行**：pass — §7 六项建议（应用/毒丸 --apply/配置组合/用户重启/在体验证/回滚）全部未执行；H2 等待中未重复上报。

## 10. 证据索引

- 补丁包（MANIFEST/PATCH-NOTES/SHA256SUMS/verify 全套，冻结 22:55）：[patches/r3-session-search/](plugins/dsh-workplan/patches/r3-session-search/)
- 回归主套件＋补充：[tests/r3-session-search/](plugins/dsh-workplan/tests/r3-session-search/)
- E 系列＋缺陷捕获差分＋冻结版独立复核：[reports/_r3_fix_t3_20261112/experiments/](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/experiments/)（含 final-verify/、frozen-verify/）
- 负责人终验与评审：[reports/_r3_fix_t3_20261112/t3-final-agent18/](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/t3-final-agent18/)（LEAD-* JSON、tsc-lead-rerun2.log、roundtrip-lead/、expert-patch-review.md＋probe/、member-rerun-report*.md＋raw/、lead-query.mjs、lead-prewarm.mjs）
- 毒丸干跑：[reports/_r3_fix_t3_20261112/poison-dryrun/](plugins/dsh-workplan/reports/_r3_fix_t3_20261112/poison-dryrun/)
- 语料副本与 oracle：corpus/、corpus-repaired/、manifest.json、expected-p1-hits.json、NOTES.md（同 _r3_fix_t3_20261112/ 下）
- 上游：[R3-repro-evidence.md](plugins/dsh-workplan/reports/R3-repro-evidence.md)（T1）、[R3-root-cause.md](plugins/dsh-workplan/reports/R3-root-cause.md)（T2）
- 结算备份：[reports/wp-settlement-T3.json](reports/wp-settlement-T3.json)（本次新写，planId/subtaskId 归属本计划；agent-17 另写 wp-settlement-T3-agent17.json）
