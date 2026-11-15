# R3 会话搜索回归套件（r3-session-search）

一句话：这是一套**可以反复运行的自动化测试**，用来证明 R3 缺陷（会话搜索 30 秒超时、永远零进展）在**基线版引擎上必然复现**，并在**修复版引擎上全部通过**。它不碰任何真实用户数据，全部用内存里的合成夹具，几秒内跑完。

## 1. 背景：R3 缺陷是什么（小白版）

搜索历史会话时，引擎会先把**全部**历史会话逐个完整读一遍、建好索引，**而且规定必须整轮全部读完、确认没有任何变化之后，才把成果一次性写进索引**。于是：

- **失败面 ①（零进展死循环，场景 S1）**：真实工作区有 2118 个会话，单轮全量冷读实测下限 24.2 秒，加上在体开销必然超过工具的 30 秒预算。30 秒一到，搜索被中止，**已读完的成果全部丢弃，索引一条都没写进去**。下次搜索看到索引还是空的，又从头全量读一遍——无限循环，永远搜不出结果。
- **失败面 ②（活跃会话 churn，场景 S2）**：整轮稳定性比对会把**正在被活跃会话持续写入的存档**的版本号（revision）也比进去。活跃工作区必然一直在写 → 版本号必然变 → 整轮比对必然失败 → 重试一次再失败 → 搜索直接报错，哪怕其余会话全都纹丝不动。
- **失败面 ③（无失败隔离，场景 S4）**：任何一个存档读失败（例如损坏），整轮观察立刻报错，**其余健康会话也全部搜不了**。

修复契约（由另一位专家并行实现，本套件按契约断言其行为）：**逐会话增量提交**（读一个提交一个，中止不丢已完成部分）＋**失败隔离**（坏存档不拖累健康会话）＋**稳定性收窄到本轮冷读的会话**（活跃存档的 churn 不再导致整轮失败）。

根因与实测证据详见 [R3-root-cause.md](../../reports/R3-root-cause.md)。

## 2. 目录结构

```
r3-session-search/
├── run.mjs                        #  runner：场景 S1–S4、判定、退出码、结果落盘
├── lib/
│   ├── harness.mjs                #  把被测引擎装配到真实 cordis Context（合成 sessions/persistence 服务）
│   └── fixtures.mjs               #  合成夹具：存档、事件、假持久化后端、活跃会话
├── vendor/baseline-lib/index.js   #  基线引擎（从宿主 checkout 只读复制，chmod 444）
├── node_modules -> checkout 的 node_modules   #  依赖解析符号链接（工作区内合法）
├── lead-supplement.mjs            #  负责人所有的补充检查（fail-closed/早中止/过滤/分页/游标/代际单调），两版都应全绿；只读复用本套件 harness/fixtures
├── baseline-run.log               #  基线对照运行日志（本目录交付物，实测产物）
├── evidence-fixed-gate-rejects-baseline.log  #  佐证：fixed 门禁对基线正确拒绝（exit 1）
├── last-results.json              #  最近一次运行的结构化结果（每次运行自动覆盖）
└── .tmp/                          #  运行时临时索引目录（每个场景独立、跑完即删）
```

被测引擎 = `@deepseek-ai/dsh-session-query-sqlite` 的 `lib/index.js`（未压缩 ESM bundle，default 导出 `SqliteSessionQueryEngine`）。
基线 sha256：`dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0`（与 checkout 逐字节一致，已用 `shasum -a 256` 双向核对）。

## 3. 怎么跑（三条命令）

前置：Node ≥ 22（需要 `node:sqlite`）；实测 Node v26.9.0。无需安装任何依赖（`node_modules` 符号链接已建好）。

```bash
cd plugins/dsh-workplan/tests/r3-session-search

# ① 基线对照：证明套件在基线上精确捕获缺陷（期望 7 红 6 绿，exit 0）
R3_EXPECT=baseline node run.mjs

# ② 修复版门禁：负责人集成修复 lib 后，一条命令验证全绿（期望 13 绿，exit 0）
R3_LIB_PATH=/path/to/fixed/index.js R3_EXPECT=fixed node run.mjs

# ③ 裸模式：不带期望，只报告每项检查的通过/失败（基线上必然 exit 1）
node run.mjs
```

- `R3_LIB_PATH`：被测 lib 的绝对/相对路径，**缺省 = vendor/baseline-lib/index.js**。runner 会打印实际加载路径与 sha256（provenance），切换已实测验证。
- `R3_EXPECT=baseline`：**精确模式匹配**——必须恰好是 7 个预期红项（S1.2、S1.3、S1.5、S2.1、S2.2、S4.1、S4.2）失败、其余 6 项全绿，才判 `MATCH` 并 exit 0。多红、少红、红错项都判 `MISMATCH`（防止夹具/装配坏掉导致“假捕获”）。
- `R3_EXPECT=fixed`：13 项全绿才 exit 0。对基线运行会正确拒绝（exit 1，见 evidence-fixed-gate-rejects-baseline.log），证明门禁非空转。

## 4. 场景与检查项（13 项）

| 场景 | 检查 | 断言（修复契约） | 基线实测 |
|---|---|---|---|
| S1 零进展死循环 | S1.1 | 中止轮以 `SESSION_QUERY_ABORTED` 拒绝 | ✅ PASS |
| | S1.2 | 第一次中止后索引进展 > 0（增量提交） | ❌ 0/12 |
| | S1.3 | 第二次中止后进展不回零（死循环打破） | ❌ 0/12 |
| | S1.4 | 不中止的搜索最终索引并返回全部 12 会话 | ✅ 12/12（但 totalColdReads=18） |
| | S1.5 | 跨重试无冗余全量重读：totalColdReads ≤ 14 | ❌ 18 = 3+3+12 每轮从头 |
| S2 活跃存档 churn | S2.1 | live-owned 存档 revision 持续变化时搜索仍成功 | ❌ `PERSISTENCE_FAILED: did not stabilize after one retry` |
| | S2.2 | 6 个稳定冷会话全部可搜 | ❌ 0/6 |
| S3 静态对照（两版都必须绿） | S3.1 | 静态语料搜索返回全部 5 会话 | ✅ 5/5 |
| | S3.2 | 每个命中的 snippet 含搜索词 | ✅ 5/5 |
| | S3.3 | 会话内事件搜索命中唯一 token | ✅ 1 |
| | S3.4 | 热搜索零额外冷读（索引复用不回退） | ✅ delta=0 |
| S4 失败隔离 | S4.1 | 一个存档损坏时搜索仍成功 | ❌ `PERSISTENCE_FAILED: synthetic corruption` |
| | S4.2 | 6 个健康会话全部可搜 | ❌ 0/6 |

S1.5 上界 14 的推导：12 个会话各至多冷读一次 ＋ 每个中止轮至多 1 个在途读被丢弃（共 2 个中止轮）= 14。基线签名是 18（每轮全量从头：3+3+12）。

## 5. 测试设计的等价性与确定性（为什么小而快的夹具能代表 30s/2118 会话的真实缺陷）

- **同一中止机制**：真实缺陷是 30 秒合作式预算到点举旗（AbortSignal），引擎在冷读检查点抛 `SESSION_QUERY_ABORTED`。本套件在第 3 次冷读完成时举旗——**走的是完全相同的信号与检查点代码路径**，只是把“时间不够”换成确定性的“读到第 3 个就中止”，不受机器快慢影响。
- **同一 churn 机制**：假持久化后端在**每次** `list()` 时递增 live-owned 存档的 revision，确定性复现“before/after 快照比对必然不一致”；冷读本身跳过 live 会话（与真实代码一致），churn 只影响整轮稳定性比对——正是根因所在。
- **同一失败隔离机制**：损坏存档在 `open()` 抛错，与真实后端读坏档的错误传播路径一致。
- **真实引擎、真实装配**：被测 lib 原样加载（不打桩、不改内部），装配在真实 cordis Context 上；唯一观测手段是只读打开派生 SQLite 索引数 `persisted_sessions` 行数。
- **规模缩小不改变机制**：12/6/5 个合成会话对应真实的 2118 个；缺陷是“全量＋单次提交＋整轮比对”的机制问题，与规模无关，规模只决定真实环境里多久触发。
- 每个场景独立临时目录＋全新索引文件，跑完即删；无网络、无真实用户数据、对宿主 checkout 只读。

## 6. 基线对照实测结果（2026-11-12，Node v26.9.0）

- `R3_EXPECT=baseline`：**13 项检查，6 绿 7 红，红项与预期集合精确一致 → `baseline pattern: MATCH`，exit 0**（完整日志见 [baseline-run.log](baseline-run.log)）。
- 可重复性：独立重跑逐条 diff，检查结果**逐字一致**（4 次运行全部 MATCH）。
- `R3_EXPECT=fixed` 对基线：正确拒绝，exit 1（[evidence-fixed-gate-rejects-baseline.log](evidence-fixed-gate-rejects-baseline.log)）。
- `R3_LIB_PATH` 显式切换到 checkout 原路径：加载路径与 sha256 正确记录，结果一致（切换机制已验证）。

## 7. 负责人集成修复版后的验收步骤

```bash
R3_LIB_PATH=<修复版 lib/index.js 绝对路径> R3_EXPECT=fixed node run.mjs
```

期望输出 `fixed-lib gate: ALL GREEN — R3 defects are fixed`，exit 0。若出现红项，输出会逐项给出失败检查与证据（错误码/计数），可直接定位修复未覆盖的失败面。

**诚实披露**：本套件按修复契约（逐会话增量提交＋失败隔离＋稳定性收窄）编写断言；截至本 README 落盘，修复版 lib 尚未集成，`R3_EXPECT=fixed` 的全绿验证待负责人集成后执行。基线侧的捕获能力已完整实测。