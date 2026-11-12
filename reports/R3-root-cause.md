# R3 根因诊断报告（T2 · 研究分析部门）

- 任务：基于 T1 复现实证，锁定 `session_event_search` 30s 超时（R3）的单一根因，产出可复核诊断与 ≤2 个修复方案对比
- 负责人：agent-14（research:T2，检索与存储链路根因分析）；下级：sqlite-index-mechanism-expert（专家，机制核验）、timeout-experiment-member（组员，判别实验）
- 诊断窗口：2026-11-12 21:11–21:40（Asia/Shanghai）；报告版本：最终版
- 全程只读：未重启、未安装、未改任何运行时/宿主代码；写入仅限工作区本报告与证据目录
- 源码锚点：运行时 checkout `/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai/`（版本 0.2.2-rc.2，T1 已证运行时加载该 checkout）。下文 `sqlite index.ts` 指 `dsh-session-query-sqlite/src/index.ts`（1131 行），`jsonl index.ts` 指 `dsh-session-persistence-jsonl/src/index.ts`（1839 行）

## 0. 结论摘要（小白版）

**单一根因已锁定：这是一个「每次搜索都要先把全馆档案重新建一遍索引，而建索引的时间永远超过允许的 30 秒，于是索引永远建不成、每次搜索都从零重来」的死循环。**

具体说：这个搜索工具在查你要的那几条记录之前，会先把本工作区**全部 2118 个历史会话**（压缩后约 775MB、解开约 2.67GB、72.5 万条事件）逐个解压、逐条校验、克隆、建搜索文档——我们用运行时自己的库离线重放这条流水线，**实测下限就要 24.2 秒**，再加上真实进程里的额外开销（文件句柄开关、宿主内存回收、与其他任务抢 CPU 等），实际必然超过 30 秒。而代码规定：**只有整轮观察全部完成，才把成果一次性写进索引**；30 秒一到就被中止，已做的成果全部丢弃，索引里一条记录都没留下。下一次搜索看到索引还是空的，又把同样的全量苦工从头做一遍——所以今天 32 次搜索（历史 25＋T1 重放 5＋本轮组员 2）**无一例外全部卡满 30 秒**，哪怕只搜一个 17 条记录的小会话。索引又是纯内存的（`:memory:`），进程一重启更是彻底归零。

**这不是「搜索范围太大」，也不是「解压太慢」**（纯解压实测只要 2.4–5.4 秒）；慢在解压之后的逐事件校验/克隆/指纹/建文档，以及「永远零进展」的机制。**只把 30 秒改大不是治本**（见 §5）。

## 1. 单一根因判定（机制链，全部 file:line 可复核）

**根因（一句话）**：搜索请求路径在范围化查询之前同步执行全语料「观察＋冷读」对账（`_reconcile`），对账仅在整轮稳定观察成功后才一次性提交；在当前语料规模下单轮观察实测下限 24.2s、在体必然 >30s 合作式预算，导致每次调用都在观察阶段被中止、零提交进展，`:memory:` 索引永远为空，后续调用无限重复同一不可完成的全量过程。

机制链（负责人与专家双份独立读码核实，行号一致）：

1. **每次搜索先全库对账，后才范围 SQL**：`searchEvents`（sqlite index.ts:296–325）在 `_serialized` 队列内依次 `_ensureReady`(:304) → **`_reconcile(signal)`(:305)** → `_queryEvents`(:312)。`_reconcile` 签名只收 signal（:407），**收不到 sessionId/seq/时间过滤**；过滤唯一生效点是末端 SQL `session_id = ?`（:692）。→ 解释「17 个事件的小范围也超时」（T1 §2 表首行）。
2. **对账 = 全量观察＋冷读**：`_observeStable`（:495–562）每轮：`persistence.list()` 全量枚举**两次**（before :510 / after :528，稳定性比对）；对每个「索引中没有或 revision 已变」的持久化会话 `readColdSessionLog`(:522) 读**完整**日志（cold-read.ts:31–57，一次读全量）；再对每个活跃会话 `observeLive`(:549–554)。增量跳过（:514）只在索引已有行时成立——本案例索引永远为空 → 每次全量。
3. **冷读单会话成本链**（jsonl 后端）：读文件 → 多帧 zstd 解码（zstd.ts:48–104 帧扫描＋逐帧解码）→ `SessionLogScanner` 逐行 JSON.parse＋catalog `restore.decodeRow` 校验/变换（format.ts:386–525，createRestore 参数 `{recovery:'strict',validation:'transformed'}` :369–372）→ `validateStoredEvents` 逐事件类型校验＋adopt（jsonl index.ts:862；storage-contract.ts:69–105）→ `freezeStoredEvents` **深度冻结**每个事件的全部嵌套对象（jsonl index.ts:154–174、:867）。
4. **观察成果再加工**：`observeSession`（sqlite index.ts:876–891）对每会话 `structuredClone(header)`＋`events.map(structuredClone)`＋`buildSessionEventSearchDocuments`（documents.ts:36–55，含 foldSurface 表面分类）＋**整会话 JSON.stringify 后 sha256 指纹**（:887–889）。
5. **仅在全轮稳定后一次性提交**：写入事务 `BEGIN IMMEDIATE…COMMIT` 在 `_observeStable` 成功返回**之后**（:418→:451–469）。观察循环每个冷读前后有中止检查点（:500/:521/:523/:527/:529）；中止即抛 `SESSION_QUERY_ABORTED`（:533–537），局部观察 Map 随异常丢弃，**事务从未到达 → 零提交**。
6. **30s 合作式预算必然先到**：工具声明 `timeoutMs=30000`（见 §4），到点举旗中止；对账死在提交前 → 下次调用 :410–415 读到的仍是空索引 → :514 增量跳过对任何会话都不成立 → 再次全量。**死循环闭合**。
7. **`:memory:` 无磁盘持久化**：bundle 配置 `path: ':memory:'`、`openAt: first-search`（dsh-experimental-session-search/cordis.patch.yml:11–12，全文 14 行）；schema.ts:47–51 对 `:memory:` 不建文件；web profile 零覆盖（专家 grep 实测 exit=1）；`launcherSessionQueryPath` 槽仅声明无消费方（sqlite index.ts:69/:74，全 checkout grep 证实）。进程重启一切归零（T1 已证两个进程下均复现）。
8. **中止后不偷跑**（排除「后台继续建索引」假设）：超时包装器 `await next()` 等工具停手才返回（policy :68、头注 :1–4）；冷读循环下一检查点即停；残留有界（在途同步段＋少量脱管 Promise）。专家判别 B 全文见其产物 §6。

**与全部现象吻合**：32/32 全超时（范围无关）✓；同参连续调用无加速（§2.3）✓；跨进程复现 ✓；错误文本逐字为超时包装器模板 ✓；无任何成功调用留下可复用索引 ✓。

## 2. 分段耗时证据（A1 核心：实测数据，非猜测）

### 2.1 负责人独立离线基准（三份，只读，脚本与原始 JSON 全部落盘）

语料规模随时间增长（活跃工作区自身在追加，本身即 churn 证据）：2092 文件/766.8MB（T1 20:50）→ 2114/773.8MB（21:15）→ 2115/774.5MB（21:20）→ **2118/775.3MB（21:24）**。

**基准 C（最忠实，最终采信）**：`faithful-corpus-benchmark.mjs/.json`（21:24:06 完成，Node v26.9.0）。用**运行时自己的库**（只读 import：`sessionFormatCatalog.createRestore`、`validateStoredEvents`、`buildSessionEventSearchDocuments`）对**全部 2118 个会话**逐一流水线重放：read → 帧扫描+逐帧 zstd 解码 → header createRestore → 逐行 JSON.parse+decodeRow+finish → validateStoredEvents → 深度冻结 → structuredClone(header+全部事件) → 真实建文档 → JSON.stringify+sha256，并**全程保留观察成果**（模拟 `_observeStable` 的 Map 保留，峰值 RSS 2.16GB）。实测：

| 段 | 耗时(ms) | 说明 |
|---|---:|---|
| readFile | 550 | 775,268,483 B 压缩 |
| 帧扫描+zstd 解码 | 2,599 | 解出 2,674,128,626 B（实测，非估算） |
| catalog restore 逐行扫描 | 5,077 | 725,257 事件，真实 createRestore/decodeRow/finish |
| validateStoredEvents | 292 | 真实库 |
| 深度冻结 | 1,007 | freezeStoredEvent 等价移植 |
| structuredClone | **10,556** | 冻结后克隆＋保留态 GC 压力（比非保留流式跑法 5,616ms 慢 88%） |
| 建搜索文档 | 225 | 真实 buildSessionEventSearchDocuments，296,510 篇 |
| stringify+sha256 指纹 | 3,856 | observeSession 指纹路径 |
| **合计（单轮观察下限）** | **24,163** | 墙钟 25,004ms；4 个文件因 workplan/notice 被拒（§3.4） |

另实测一次 `persistence.list()` 等价元数据遍（全库首帧解码+header 解析+stat）：**144ms**；运行时每轮观察至少 2 次（before/after）。

**基准 B（流式、不保留）**：`full-corpus-benchmark.mjs/.json`（21:20:46）：同语料不保留成果，段合计 17,124ms（read 466/decode 2410/parse 4523/clone 5616/fingerprint 3866/docs 243），峰值 RSS 1.35GB。与基准 C 对比证明**保留态 GC 使克隆段近乎翻倍**。

**基准 A（抽样外推，已被 B/C 取代，仅留档）**：`cold-pass-benchmark.mjs/.json`：14 会话分层抽样外推 22.1s。首版曾因「一次性 zstdDecompressSync 只解首帧」得出错误近零值，负责人以「解压后<压缩前」 sanity 检查发现并改用运行时多帧路径重跑（弯路如实记录，见 §7.3）。

### 2.2 组员实验①（独立方法交叉）：纯解压下限

`zstd -dc` CLI、5 样本确定性抽样（exp1_coldread.py / exp1-raw-output.txt）：加权吞吐 **141.92 MB/s（压缩口径）**，外推全库纯解压下限 **≈5.45s**（当前语料）/5.40s（T1 参考值）。与负责人 Node 原生解码实测 2.4–2.6s 同量级（CLI 含进程启动开销、口径偏保守）。**结论一致：纯解压 ≪30s，瓶颈在解压之后的逐事件加工与零进展机制。**

### 2.3 组员实验②（负责人已从存档独立复核）：同进程连续同参调用无复用

参数 `{"session_id":"session-6e26e9e5-…","query":"R1","seq_from":1}` 连续两次，宿主未重启。**负责人独立解码组员会话存档（e9ffc99a-…）提取 tool/call→tool/result 事件对**，与组员盘上产物逐字一致：

| # | call seq→result seq | call time(epoch ms) | Δms | 逐字结果 |
|---|---|---:|---:|---|
| 1 | 49→50 | 1794489400541（21:16:40.541） | **29999** | `Error: tool call timed out after 30000ms` |
| 2 | 61→62 | 1794489440529（21:17:20.529） | **30002** | 同上 |

第二次无任何加速 → 无跨调用复用（与 §1.5「零提交」代码证明互证）。诚实局限：两次均被 30s 截断，在体完整单轮耗时不可直接测得（§6）。**今日累计 32/32 全超时**（T1 30＋本轮 2）。

### 2.4 在体「单轮观察 >30s」的证明（不依赖离线重建）

离线下限 24.2s 本身 <30s，但在体超时是**被证明的**而非仅被重建的：(a) 32/32 调用全部恰在 30000ms 被超时包装器截断；(b) 若某次调用完成了对账提交，其后调用将走 :514 增量跳过而显著变快——实测连续调用无加速（§2.3），且今日无任何成功调用；(c) `_ensureReady` 仅开 :memory: 库（毫秒级），范围 SQL 只对单会话 FTS 查询（毫秒级）且在对账之后——**30s 预算只能消耗在观察/冷读阶段**。离线重建（24.2s 下限）＋未计入的在体附加开销（§3.3）与在体 >30s 一致。

## 3. 已证实 vs 未验证（A2，严格分离）

### 3.1 已证实（代码逐字＋实测/存档证据）
- §1 机制链全部 8 环（负责人与专家双份独立读码，行号一致；专家产物 §1–§6 逐字摘录）。
- §2 全部分段数字（脚本＋原始 JSON 落盘，可重跑）。
- 30s 阈值来源与无覆盖（§4，T1＋专家＋负责人三方核对）。
- 同参连续调用无加速（存档事件对，负责人独立提取）。
- 语料持续增长（2092→2118，四个时点实测）。

### 3.2 对 T1 机制推论的更正（专家核验，负责人复核采纳）
1. 「冷读每次无条件全量」→ **精确化**：:514 有增量跳过；全量冷读发生在索引为空/revision 变化时。本案例因索引永远为空而每次全量。观察/list/活跃快照则每次必全量。
2. 「超时后索引不保留」→ **更正为「未提交进展不保留」**：句柄与已提交行在同进程内跨调用保留（:370 `??=`、:260 仅销毁时 close）；本案例是「从未有机会提交」，不是「中止清空索引」。
3. 「活跃追加触发稳定性重试」→ **精确化**：稳定性只比持久化快照（size/revision/header，:911–925）与活跃 **ID 集合**（:927–936，不比内容）。活跃会话纯追加不改变 ID 集合；但**已物化存档的 revision 是 stat 基（dev:ino:size:mtimeNs:ctimeNs，jsonl index.ts:200–208），list() 对已物化 artifact 用 fileRevision（:545–557）**，宿主对活跃会话存档的追加（T1 §7 实测主会话文件持续增长）会改变 before/after revision → 整轮重试（上限 2 轮，:86/:499/:531/:555/:558–561）。**此条为代码证实，未在体实验观测**（因单轮从未在 30s 内跑完，重试路径从未有机会暴露）。

### 3.3 未量化/未验证项（不得当作事实引用）
- **在体附加开销未逐项量化**：每会话 handle open/close/findLog/readGenerationHeader、readStableJsonlFile 稳定性重读（generation.ts:255）、assertV4RowAdmission/assertReleasedV4Relationships、scheduler.yield（每 500ms 让出事件循环，jsonl index.ts:75/:1010–1030）、interruptedTurnClosers、活跃会话 observeLive 增量、宿主进程自身堆/GC 与多任务 CPU 竞争。均为**加性**成本，方向确定、数值未测。
- **在体完整单轮耗时**：被 30s 截断不可测（§6 给出补测方案）。
- **宿主运行日志佐证**：组员实验③证实 ~/.dsh 今日无宿主运行日志落盘（最新 startup 日志止于 Nov 1；292 个日志＋今日 ndjson/pnpm 关键词零命中）→ 中止位置由代码＋计时证明，**无日志侧直接痕迹**。
- **churn 重试在体触发频率**：代码证实路径存在，未观测（见 3.2.3）。

### 3.4 次生潜在缺陷（新发现，移交 T3/T4，不影响主根因判定）
基准 C 中 **4 个旧会话存档**被真实 `validateStoredEvents` 拒绝：`session-1075b1b0-…`、`session-4b036b43-…`、`session-72c219a9-…`、`session-d93cd464-…`，错误逐字：`contains event type "workplan/notice" (seq 8/9/11) unknown to this harness and not marked ignorable`。宿主事件词表是**静态生成集**（dsh-session/src/known-event-types.ts:23 起，注释明确：插件事件不在表内、兼容机制是 `ignorable` 标记、拒绝事件名注册）。若冷读循环在 30s 内到达这些文件，搜索将以 `SESSION_QUERY_PERSISTENCE_FAILED` 快速失败（sqlite index.ts:540–545）——**今日 32 次全为 TOOL_TIMEOUT、从未出现该错误**，说明在体迭代顺序下截止总是先于到达这些文件（迭代顺序为 list() 返回序，离线不可知，未验证）。**含义：T3 修复性能后，对账可能首次跑完并撞上这 4 个「毒丸」存档**；修复必须一并处置（工作区已有修复脚本线索：plugins/dsh-workplan/scripts/repair-prehead-notices.mjs；或插件今后以 ignorable:true 写入；需 T3 核实当前插件写入行为）。

## 4. 30s 阈值来源（A3）

- **唯一来源**：`dsh-tool-session-query/src/index.ts:25` `export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000`（负责人本次逐字复核）；配置项 `searchTimeoutMs`（:32，schema :38，回退 :126）；编译产物 lib/index.js:932（3e4）。工具注册 `timeoutMs: resolved.searchTimeoutMs`（:80）。
- **执行者**：通用 `dsh-tool-call-timeout-policy`（tools/execute 包装器）：:57 读预算 → :61 `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` 启动 setTimeout → :66 融合信号 → :68 await 工具 → :73–74 自己的表响了才替换为 `Error: tool call timed out after ${timeoutMs}ms`（:42，与 32 次逐字错误一致；负责人本次逐字复核 :41–48/:55–80）。定时器本体 dsh-timeout/src/index.ts:112–119。
- **性质**：**宿主进程内工具层合作式超时**（abort signal＋检查点），不是网络/服务端限制；搜索服务内部无任何超时（T1 grep 两包 src 零匹配）。同步段（FTS SQL/提交事务）不可打断 → 实际事件差可略超 30s（T1 历史最大 34845ms 含排队）。
- **生效值=30000，无覆盖**：bundle 对 optional-tool-session-query 无 config 块（cordis.patch.yml:13–14，负责人全文复核）；web profile 主补丁 grep timeout/session-query 零命中（T1＋专家双份实测）；所有 `searchTimeoutMs: 60000` 均属 web_search（T1 §7 逐条排除，dsh-base/cordis.patch.yml:479–480 注释铁证）。

## 5. 修复方案对比（A4，≤2 个；改动范围授权待确认，T2 不动代码）

| 维度 | 方案 A：配置级缓解（持久索引＋提高预算） | 方案 B：宿主代码治本（增量提交/可恢复对账） |
|---|---|---|
| 做法 | profile 覆盖 `optional-session-query-sqlite.config.path` 为持久文件（schema.ts:46–53 已支持建目录/建库/校验 application_id），并覆盖 `optional-tool-session-query.config.searchTimeoutMs`（如 300000）让首次全量建索引有机会完成 | 修改 `dsh-session-query-sqlite` 对账：按会话/批次**增量提交**观察成果（中止保留已提交进展，后续调用 :514 增量收敛）；可选启动期后台预热（openAt:'startup'＋异步建索引，不占工具预算）；稳定性语义需相应调整为逐会话判定 |
| 改动范围 | **部署配置**（~/.dsh/profiles/web 补丁/overlay），零代码改动；覆盖语法需 T3 按 loader 语义核实 | **宿主包代码**（checkout 内 dsh-session-query-sqlite，非工作区插件）＋重新编译 lib＋重启 |
| 是否写派生索引 | **是**（文件库，跨重启保留；首次建成后续搜索增量、毫秒级） | 可选（与持久路径组合最佳；:memory: 下进程内也能收敛） |
| 是否需重启 | **是**（配置生效需重启；按规则由用户手动） | **是**（lib 重建后重启；用户手动） |
| 能否治本 | **有条件**：首次建索引仍需数分钟阻塞；且活跃工作区 churn 使整轮稳定观察难以成立（2 轮上限，§3.2.3）——**可能仍建不成**；建成后日常搜索快 | **是**：打破「零进展死循环」，每次调用有界且收敛；对 churn 鲁棒 |
| 风险 | 低改动面；但 R3 可能未闭环（需实测）；首次长阻塞占串行队列 | 改动面较大；须保持 live-preferred/generation/游标语义；T4 必须回归 R1/R2（派发/读取路径在不同包，理论不受影响，需实证） |
| 共同前置 | **都必须先处置 §3.4 的 4 个毒丸存档**，否则性能修复后对账可能转为快速失败 | 同左 |

**推荐**：B 为治本方向（A 可作为先行缓解/对照实验）。**需主 Agent/用户决定**：① 是否授权修改宿主 checkout 代码（任务书「改动范围授权:待确认」）；② 重启由用户手动执行；③ 毒丸存档处置方式（修复脚本/ignorable 化/隔离）；④ 若走 A，可接受的首次建索引时长与 searchTimeoutMs 取值。**改阈值本身只是缓解不是治本**（T1 §11.3 提醒一致）。

## 6. 证据缺口与补测方案（A5）

1. **在体完整单轮耗时**（当前被 30s 截断不可测）：需先落地方案 A 的 searchTimeoutMs 提升（或 T3 修复后），由**主 Agent 协调、用户重启后**重放 P1 一次并取存档事件差；T2 范围内无法完成。
2. **宿主终端 stdout 日志**（~/.dsh 无今日运行日志，组员实验③）：如需日志侧直接佐证中止位置，由**主 Agent/用户**在下次重放时采集 `dsh web` 进程终端输出；非根因判定必需。
3. **list() 在体迭代顺序与毒丸文件位置**：离线不可知；T3 修复后首次完整对账时自然暴露（§3.4）。
4. **小规模工作区阈值曲线**：无此环境，未测（T1 已披露，维持）。

## 7. 证据索引与复核记录

### 7.1 产物清单
- 负责人（本目录 `_r3_root_cause_t2_20261112/`）：cold-pass-benchmark.mjs/.json/.stderr、full-corpus-benchmark.mjs/.json/.stderr、faithful-corpus-benchmark.mjs/.json/.stderr（脚本可重跑，只读）
- 专家（`_t2_r3_rca_20261112/`）：mechanism-verification.md（318 行，四断言三态判定＋判别 A/B＋行号核对）
- 组员（同目录）：experiment-log.md（101 行）、exp1_coldread.py、exp1-raw-output.txt、exp2_timing.py、exp2-after-call1.txt、exp2-after-call2.txt
- 上游：R3-repro-evidence.md（T1）、reports/t1-source-evidence.md（T1 下级）

### 7.2 下级结果复核（不采信自述）
- **专家**：负责人独立通读 sqlite index.ts 全文、cold-read.ts、documents.ts、jsonl index.ts 关键段、policy :39–80、schema.ts :40–69、两份 cordis.patch.yml，与其逐条比对——**全部一致**；其精确化/更正（§3.2）经负责人复核采纳。叶子 verify NO_PLAN（平台限制），按 structured 口径由主 Agent 写回。
- **组员**：盘上产物经负责人回读＋sha256 登记＋**独立解码其会话存档提取事件对**，实验②数字逐字吻合（29999/30002ms，seq49→50/61→62）。**如实记录不一致**：组员聊天回报中的数字（30001/30009ms、seq50→51/55→56、159.15MB/s、153 行）与盘上产物（29999/30002ms、seq49→50/61→62、141.92MB/s、101 行）**不符**；以盘上产物＋负责人独立存档提取为准，聊天回报数字弃用。实验①③产物内部自洽（raw 文件与汇总一致）。叶子 verify NO_PLAN，同上写回。

### 7.3 负责人弯路与纠正（复盘素材）
1. 基准 A 首版用一次性 `zstdDecompressSync` 解多帧容器，只得首帧（解压后≈0），sanity 检查（解压<压缩不可能）发现 → 改用运行时帧扫描＋逐帧解码（public fallback 路径，zstd-public-decoder.ts:20–29 等价）重跑。
2. 试图 import  bundled lib 的内部 zstd 导出（不存在）与 node_modules 下 TS 源码（Node 拒绝 strip）各失败一次 → 改为逐字移植帧扫描器＋真实导出库组合，未再试错。
3. 基准 C 的 4 个 workplan/notice 拒绝不是基准缺陷，而是真实运行时校验行为 → 升级为次生缺陷发现（§3.4）。

## 8. 验收对照（逐条）

- **A1** 根因指向具体文件/行号/机制＋分段耗时：**pass** — §1 八环机制链全部 file:line（双份独立读码）；§2 三份基准原始数据＋在体 >30s 证明。
- **A2** 已证实与未验证严格分离：**pass** — §3.1/3.2/3.3/3.4 四档分明；T1 推论三处更正留痕；离线下限 24.2s<30s 如实披露，在体超时以独立证据链证明。
- **A3** 30s 阈值来源位置：**pass** — §4：常量 src/index.ts:25、执行器 policy :41–48/:57–74、dsh-timeout :112–119、无覆盖三方核验；性质=宿主内工具层合作式超时。
- **A4** 修复方案与改动范围/派生索引/重启判定：**pass** — §5 两方案对比表＋推荐＋4 项待决定；明确 A=配置/写派生索引/需重启/有条件，B=宿主代码/可选派生索引/需重启/治本。
- **A5** 证据不足处写明缺哪次观测、由谁执行：**pass** — §6 四项缺口逐条给出补测方案与执行人（主 Agent/用户/T3）。
