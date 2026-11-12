# R2-build-live-check — 重启后运行实例制品生效核验记录（T1）

- 计划：wp-46f8cbde-ac51-454f-aa84-e06809089b4a ｜ 子任务：T1（devops）
- 核验时间：2026-11-12 17:56–18:00（Asia/Shanghai，本机时钟）
- 方式：全程只读（lsof / libproc / stat / grep / shasum / find），未重启任何服务、未安装或升级任何依赖、未写任何会话数据。
- 判定对象：重启后的 dsh web 运行实例是否加载了含 T3（写入端窗口前置闸 + 读取端 legacy 容忍）与 T6（agent 兜底 / fail-closed / 堆栈留痕）补丁的构建产物。

## 0 单一判定

**生效（ACTIVE）。** 重启后的 dsh web 进程（PID 20983，启动于 2026-11-12 17:50:54.889）加载的插件入口与读取端校验器，均为含 T3/T6 补丁的 r4 构建批次产物；启动后至今零改动，磁盘指纹已复算冻结。无需任何额外生效步骤。

## 1 证据类一：运行进程事实（进程启动时间 / 入口 / 加载路径）

| 项 | 值 | 采集方式 |
|---|---|---|
| GUI 监听 | 127.0.0.1:3080，唯一监听者 PID 20983（node） | `lsof -nP -iTCP:3080 -sTCP:LISTEN`（1 行，无旧 PID 并存） |
| 进程启动时间 | **2026-11-12T17:50:54.889**（本地时区） | python3 ctypes `libproc.proc_pidinfo(PID, PROC_PIDTBSDINFO)` 的 `pbi_start_tvsec/usec`（历史教训：ps 被沙箱禁用，直接走 libproc，未试 ps） |
| 父进程 | PPID 20958 | 同上 |
| 可执行文件 | /opt/homebrew/bin/node | sysctl KERN_PROCARGS2（仅取 argv 公开段，未采集环境变量，无凭据落盘） |
| 运行入口 | `/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/.bin/dsh --profile web --host 127.0.0.1 --port 3080 --no-open`（argv 公开段，已脱敏检查） | 同上 |
| 入口真实路径 | `/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai/dsh/lib/bin.js`（mtime 2026-11-12T14:52:02，早于启动） | `os.path.realpath` |
| 进程 cwd | /Users/open/Documents/Stocks | `lsof -p 20983` cwd 行 |
| 插件加载路径 | `~/.dsh/profiles/web/node_modules/dsh-workplan` 为软链 → realpath = `/Users/open/Documents/Stocks/plugins/dsh-workplan`；`profiles/web/package.json` 第 18 行声明 `"dsh-workplan": "link:/Users/open/Documents/Stocks/plugins/dsh-workplan"` | `ls -la` + `os.path.realpath` + grep（历史教训：不凭 ls 表象判副本，用 realpath 定论） |
| 插件入口 | package.json：name=dsh-workplan，version=2.5.4，main/exports=`lib/host.js` | 读 package.json |

结论：运行实例经 profile 软链直接加载工作区 `plugins/dsh-workplan/lib/*`（非打包缓存副本），读取端校验器来自同一 npx 安装目录 `@deepseek-ai/dsh-session-format-*`。

## 2 证据类二：产物时间 × 构建批次对照

r4 构建批次（T3/T6 补丁所属批次，见 T3-patch-resume-1513.md §3 与 full-suite-r4.log）：

| 产物 | mtime（本地） | 与启动时间 17:50:54.889 的关系 |
|---|---|---|
| scripts/wp-fix/build-r4.log（npm run build，tsc→lib/） | 2026-11-12T17:46:12 | 早于启动 |
| plugins/dsh-workplan/lib/host.js（运行入口） | 2026-11-12T17:46:14 | 早于启动 |
| plugins/dsh-workplan/lib/runtime.js | 2026-11-12T17:46:14 | 早于启动 |
| plugins/dsh-workplan/lib/plan.js | 2026-11-12T17:46:14 | 早于启动 |
| plugins/dsh-workplan/lib/watchdog.js | 2026-11-12T17:46:14 | 早于启动 |
| plugins/dsh-workplan/client.js | 2026-11-12T17:46:14 | 早于启动 |
| @deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js（读取端） | 2026-11-12T17:27:44 | 早于启动 |
| @deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js（读取端） | 2026-11-12T17:27:44 | 早于启动 |
| scripts/wp-fix/full-suite-r4.log（866/866 pass，EXIT=0） | 2026-11-12T17:47:16 | 早于启动 |

- **启动后零改动**：`find plugins/dsh-workplan/lib plugins/dsh-workplan/client.js <v3-to-v4>/lib <v2-to-v3>/lib -type f -newermt "2026-11-12 17:50:54"` → **0 个文件**。
- **磁盘指纹复算（sha256，冻结本次核验时点）**：
  - lib/host.js `75203369fc8448e272820cb289eb75b6a0c03d0356ee8ac69d0cb356534e8b13`
  - lib/runtime.js `28c369e248f1a30939766e4f7aab8d4c5df4f7025691c7cd45f90b765703a1c8`
  - lib/plan.js `afb9da5fdccac0e31bd43bbe0179e4b049e5c62a068b04b57fc7e90d7a86cb35`
  - lib/watchdog.js `0a8ff8bc2998171df4802a4afc416ed83cbff397ddf153b1d83cc0a5addc089f`
  - v3-to-v4/lib/index.js `bdcb11b6058b2818c1ed12e925c486890fdc857245f9616d0e04f4f76c101698`
  - v2-to-v3/lib/index.js `426afde79333be7115a4c7ae5de2ba34587f37ad58a7c84472829e8899cb8ccc`

三证齐全：启动时间晚于全部产物 mtime ＋ 启动后零改动 ＋ 指纹复算（历史教训硬规则：缺一只能写 UNKNOWN；本次三证齐全）。

## 3 证据类三：补丁特征检索（在运行实例实际加载的文件中）

插件侧（工作区 lib，即运行加载路径，符号未压缩、可直接检索）：

| 补丁特征 | 文件:行号 | 结果 |
|---|---|---|
| T6 `resolveLiveAgent` 定义 | lib/runtime.js:1772 | 命中（全文 4 处） |
| T6 派发前兜底 `options.agent ?? resolveLiveAgent(...)` | lib/runtime.js:2070 | 命中 |
| T6 fail-closed `AGENT_RESOLUTION_FAILED` | lib/runtime.js:2072 | 命中（1 处） |
| T6 `parent: liveAgent` | lib/runtime.js:2142 | 命中 |
| T6 startAutoDispatch 兜底 | lib/runtime.js:4985 | 命中 |
| T3 写入端窗口 `preHeadWindowSessions` / `enterPreHeadWindow` | lib/plan.js:1692/1693/1695/1790（5 处）＋ lib/runtime.js（2 处） | 命中 |
| T6 堆栈留痕 describeError（前 6 行、≤600 字符） | lib/watchdog.js:67-68 | 命中 |

读取端（npx 安装目录 lib，即运行加载文件；特征串取自 patch-reader.mjs 的替换文本）：

| 补丁特征 | 文件 | 结果 |
|---|---|---|
| `legacy tolerance: adopt late system head (read-side backward compat)` | dsh-session-format-v3-to-v4/lib/index.js | 命中 1 处 |
| 同上 | dsh-session-format-v2-to-v3/lib/index.js | 命中 1 处 |
| 旧抛错串 `requires a protected first surface head`（应已消失） | 上述两文件 | **0 处**（旧拒绝逻辑已被替换） |

风险预案核对：任务书提示「入口可能为打包/缓存产物、符号被压缩」——实测插件经 link: 软链直载工作区未压缩 lib，读取端为未压缩 lib/index.js，特征检索全部直接命中，无需降级为纯哈希对照（哈希已同时给出）。

## 4 补充运行态旁证（非判定依据，仅佐证）

- 本核验会话（agent-6）本身即重启后经 workplan 派发链路成功创建的子会话，`dsh_workplan_delegate(action=status)` 正常返回——插件 runtime 已在运行实例中加载并工作（派发链路的完整实证归 T3/R2-dispatch-live-proof.md）。
- 前次尝试派发的两名下级（runtime-checker / patch-forensics）挂在旧尝试会话 agent-4 下、盘上无其产物；为避免空等孤儿下级，本回合由部门负责人直接只读取证完成（偏离已记录，见结果块 deviations）。

## 5 结论与生效步骤建议

- **判定：生效。** 无需主 Agent 执行任何额外生效步骤。
- 剩余边界（如实说明）：Node 进程内存中的模块字节无法从外部直接读取（历史教训：lsof 看不到已读完的 JS 句柄）；本判定依据「软链加载路径唯一性 + 启动时间晚于构建 + 启动后零改动 + 指纹复算 + 特征命中」证据链，与既往 2.2.2/2.2.3 运行态核验同一方法论。1513 实际读取结果与新回合派发结果分别由 T2/T3 独立实证。
- 凭据安全：argv 仅采集公开段，未采集环境变量；报告落盘前自检无 token/key/secret 字样内容（--trusted-host 为公开主机名，非凭据）。