# 发布清单（RELEASING）

> 目标：一次发布做到「四个地方同一个版本、三个渠道同一份制品、任何人都能按这份清单复查」。
> 全程只用官方命令，不依赖个人机器上的临时状态。

## 0. 版本号规则

- **主版本**：破坏既有消息契约或回放兼容（`PLAN_VERSION` 变更、旧会话无法回放）。
- **次版本**：新增能力但只增不改（1.7.0 的结构化证据、async 派发、`status` 工具都属于此类）。
- **补丁版本**：只修 bug 或只改文档。

版本号只有四个声明点，由 `tests/version-sync.test.ts` 断言一致：

| 位置 | 说明 |
|---|---|
| `package.json` 的 `version` | npm 包版本 |
| `package-lock.json` 的 `version` 与 `packages[""].version` | 锁文件根版本 |
| `src/host.ts` 的 `meta.version` | 宿主面板显示的版本 |
| `CHANGELOG.md` 的 `## <version> — <date>` | 人读的变更记录 |

## 1. 发布前检查（全部通过才继续）

```bash
# 1. 工作区干净（未提交改动必须先提交或回滚）
git status --short

# 2. 版本四处一致 + CHANGELOG/README 已更新
npm run check
npm test

# 3. 生成物可复现：重新构建后 git 不应有差异
npm run build && git diff --exit-code -- lib client.js
```

`npm test` 会先构建再跑全部用例；`npm run check` 是 `tsc --noEmit`。任何一步失败都不要打 tag。

**第 4 步（必做；不在 `npm test` 内）：headless W5 跨版本 A/B 探针（R-W5-01）。** 按 §1.4 执行，
必须打印 `RESULT: PASS` 且 EXIT=0。该步需要已发布 tag `v1.8.19` 的 `lib/` 与外部事故日志夹具，
属于发布前验证而不是常规回归测试，因此**不并入 `npm test`**。

### 1.4 headless W5 跨版本 A/B 探针（R-W5-01；**不属于 `npm test`**）

| 登记项 | 内容 |
|---|---|
| 条目编号 | **R-W5-01**（回归自动化；裁决来源 `_rerun_20261101/W5_RUN.md` §八，2026-11-01 用户「同意移入」） |
| 触发时机 | 每次发版、**打 tag 之前**必做；不随 `npm test` 运行 |
| 位置 | 本清单 §1「发布前检查」第 4 步 |
| 执行脚本（已入仓） | `scripts/w5-cross-version-check.mjs`（`git ls-files` 可见） |
| 通过判据 | `RESULT: PASS` 且 EXIT=0（六条断言全 PASS） |
| 失败处置 | 不得打 tag / 不得发布；保留脚本 JSON 输出 |
| 当前状态 | 已消解（2026-11-09 判据修订，见本节「已知偏差」）；修订后双跑 `RESULT: PASS` |

用途：证明「终态计划不再死锁 present」这次解耦没有把旧版行为改坏，并且新版写出的 `superseded` 信封交给旧读端时只会安全降级、不会变成可交付。脚本用 `node` 直接驱动两份 `lib/`（无 DSH 服务、无网络），即所谓 headless 运行。

```bash
# 旧运行时取已发布 tag 的 lib（tag 内已含构建产物，无需 npm ci）
rm -rf /tmp/w5-old && mkdir -p /tmp/w5-old
git archive v1.8.19 lib | tar -x -C /tmp/w5-old

# 新版使用刚构建的 lib；root 日志切片是外部证据夹具，可用 W5_ROOT_LOG 覆盖
W5_ROOT_LOG=../_baseline_work/root/root.jsonl \
  node scripts/w5-cross-version-check.mjs \
    /tmp/w5-old/lib/runtime.js "$PWD/lib/runtime.js" "$PWD/lib/plan.js"
```

前置：① 已执行 `npm run build`（`lib/` 与 `src/` 同步）；② 本地存在 tag `v1.8.19`；③ 夹具 root 日志可读（默认路径见脚本；`W5_ROOT_LOG` 可覆盖，缺夹具时本步**不得判 PASS**，按未验证记录并停下）。

PASS 判据：脚本最后打印 `RESULT: PASS` 且 EXIT=0，六条断言全 PASS（旧版复现生产拒绝文案、旧版 present 拒绝且 steer 触发、新版无取消 trap（steer=0）且 present 由 2.2.x 证据门禁拒绝（`EVIDENCE_GAP`，未落实 handoff 所致）、新版对终态计划仍拒绝 dispatch、superseded 写入为单条 full 覆盖信封、旧读端降级为 cancelled 且仍拒绝交付）。耗时约 1 秒。

失败处置：不得打 tag / 不得发布；保留脚本 JSON 输出；若「旧版复现生产文案」失败，先确认夹具 `root.jsonl` 的 seq 7168/7175 未被改写（`event7168Sha256` 应为 `36fc488d…`），再判断是回归还是证据过期。

**已知偏差（2026-11-04 实测；2026-11-09 已通过判据修订消解，非运行例外）**

在 1.12.2 工作树按本节命令执行（`lib/` 与 `dist/` 同源、sha256 一致；旧版 `lib/` 由
`git archive v1.8.19` 取出；夹具 `root.jsonl` 的 `event7168Sha256 = 36fc488d…` 未被改写），
结果 `RESULT: FAIL (1)`：六条断言中五条 PASS，失败的是第 3 条
`current does not trap: present allowed, no steer`。

- 实测：`current.presentBeforeCancel` 与 `current.presentAfterCancel` 都返回 `EVIDENCE_GAP`，
  指向同一日志切片里的**兄弟计划** `wp-4ad0038f-ef9c-4e9b-8907-9a3f414fe246`（8/8 done，
  但带 H1–H5 条未处置的跨部门需求），而不是本节假设的「取消后 present 放行」。
  `current.steers = 0`、`current.dispatch.code = PLAN_CANCELLED` 均符合预期。
- 版本差异（命令实测 + `git log -S` 佐证）：1.8.19 的 `lib/runtime.js` 没有 `EVIDENCE_GAP`
  字符串（`grep -c` 为 0）；该错误码由 1.9.1（`c6c3a0a`）引入，跨部门需求闸门由 1.11.0
  （`71f0b65`，`openHandoffs`）引入。历史夹具在现行「会话内全部计划一起判」的闸门下，
  会先命中兄弟计划的证据缺口。
- **已消解（2026-11-09，主 Agent 裁决 T4 清单 G4 · 选项 B）**：确认属「探针断言随版本演进而过期」，**非产品回归**——2.2.6 对象感知读取把历史 handoff 正确解析出来，现行闸门返回 `EVIDENCE_GAP` 正是本版证据门禁的设计语义。断言 3 已修订为 2.2.x 门禁语义（steer=0 且拒绝码 `EVIDENCE_GAP`、拒绝理由为未落实 handoff；注释引用工作区根目录 `_t5_release_execution_20261109/w5-verdict-diagnosis-T5.md`），修订后探针双跑 `RESULT: PASS`（JSON 留档同目录）。本条为判据口径修正，不是运行例外。复现输出见
  `_t3_rw5_20261104/w5_probe_output_20261104.txt`（工作区根目录）。

## 2. 提交与打标签

```bash
git add -A
git commit -m "Release 1.7.0: collaboration contract, async dispatch, write guards"
git tag -a v1.7.0 -m "v1.7.0 协作契约版"
git push origin main
git push origin v1.7.0
```

## 3. GitHub Release + 制品

Release 必须**带 tgz 制品**。历史教训（1.6.0）：Release 存在但 `assets: []`，而索引源的
`tarball:` 指向 GitHub Release，用户点下载会拿到旧版本或 404。

```bash
# 干净检出打包，避免把本地未跟踪文件打进制品
rm -rf /tmp/dsh-workplan-pack && git clone --depth 1 --branch v1.7.0 \
  git@github.com:abbaababa/dsh-workplan.git /tmp/dsh-workplan-pack
cd /tmp/dsh-workplan-pack && npm ci && npm run build && npm pack
sha256sum dsh-workplan-1.7.0.tgz    # macOS: shasum -a 256

# 建 Release 并上传制品（--notes-file 可用 CHANGELOG 对应段落）
gh release create v1.7.0 /tmp/dsh-workplan-pack/dsh-workplan-1.7.0.tgz \
  --repo abbaababa/dsh-workplan \
  --title "v1.7.0 — 协作契约版" \
  --notes-file docs/release-notes-1.7.0.md
```

验证制品真的可下载（HTTP 必须 200，大小与本地一致）：

```bash
curl -sIL -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://github.com/abbaababa/dsh-workplan/releases/download/v1.7.0/dsh-workplan-1.7.0.tgz
```

## 4. npm 发布

```bash
npm whoami                 # 必须是拥有该包发布权的账号
npm publish                # 已登录时直接发；CI 用 NPM_TOKEN + --provenance
npm view dsh-workplan@1.7.0 version dist.tarball
npm view dsh-workplan@latest version   # 必须等于新版本
```

## 5. 索引源（dsh-plugin-catalog）

链路：`awesome-dsh-plugin` 仓库条目 → CI 探测 npm `dist-tags.latest` → 构建 `docs/index.json`
→ 发布 npm 包 `dsh-plugin-catalog` → jsDelivr → DSH 插件市场。

本仓库只能完成**条目 PR**；catalog 的 npm 发版由上游 CI 触发，不属于本仓库权限。

1. 确认上游条目 `data/plugins/abbaababa__dsh-workplan.yml` 的版本与 `tarball:` 指向刚发布的 Release：
   `tarball: https://github.com/abbaababa/dsh-workplan/releases/download/v1.7.0/dsh-workplan-1.7.0.tgz`
2. 若版本未更新，fork 上游仓库、改这一行、提 PR（只改必要字段，便于维护者合并）。
3. 合并后按下面三条复验（换掉 `<latest>`）：

```bash
npm view dsh-plugin-catalog@latest version          # 应晚于本次合并时间
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json \
  | grep -o '"id":"dsh-workplan"' | head -1          # 应命中
```

4. 在 DSH 里执行 `plugin_market list_plugins(query="dsh-workplan")`，应能看到条目并能安装。

## 6. 发布后记录

在 `docs/release-record-<version>-<date>.md` 写下可复核的证据：tag、commit、npm `shasum`、
Release 制品 URL 与 sha256、catalog 版本、复验命令输出。发布记录不是仪式，它是下一次排障的
唯一时间线。

### 6.1 标准动作（每次修复验收必做）：运行态指纹 = 磁盘指纹

**为什么定为标准**：2026-11-07 的规划器 300 秒超时事故里，修复代码 10:40:03 就已构建完成，
但运行中的进程是 10:02:39 启动、加载的仍是旧字节（`build 6512166d9d425f7d`）。同一故障在
2.1.1→2.1.5 之间复发过，而「代码改了，进程里跑的却不是改后的字节」必须先被证据排除，
否则会把「没生效」误判成「修复无效」，或把「还没重启」误判成「修好了」。

**做法**：用户手动重启 DSH（禁止自行重启）后，两条命令各跑一次，比对结果。

```bash
# ① 运行态自报指纹：调用插件状态工具，回显形如
#    v2.1.6｜build e391f4d49758b982｜pid 3557｜启动 2026/11/7 10:50:24
#    （工具名 dsh_workplan_status；回显由 src/host.ts 的 runtimeIdentity 拼装）

# ② 磁盘复刻指纹：按 src/host.ts:43-60 的同一算法（四文件完整字节依次
#    sha256 取前 16 位）。必须用 cat 管道保留各文件尾换行；$(cat …) 的命令
#    替换会剥尾换行，产生与运行态的假「不匹配」（2026-11-10 实测纠正，
#    假值样本 bdb1ab2712cc538a 留档于 release-record-2.2.8）。
cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js \
  | shasum -a 256 | cut -c1-16
```

**判定（三选一，不许含糊）**：

- **相同** → 运行态与磁盘逐字节同一产物，修复确已加载 = 通过。把两条输出原文贴进
  `docs/release-record-<version>-<date>.md`。
- **不同** → 进程仍在跑旧字节，或加载了别的副本 = **验收不通过**：先按 §1 核对工作区与
  构建，再请用户手动重启，重启后重跑本动作。
- 回显 `build unknown` → 进程读不到入口文件，如实记为「**无法确认**」，不得当作通过。

> 旁证（可选但推荐）：比对四入口文件的 `stat mtime` 与进程启动时刻，构建时间必须**早于**启动
> 时间，否则新进程不可能加载到新字节。

## 7. 回滚

- npm：`npm unpublish dsh-workplan@<version>`（24 小时内）或发布一个 `-fix` 补丁版本，不覆盖旧版本号。
- GitHub：`gh release delete v<version>`，tag 保留可追溯。
- 索引源：改回上一个可用 `tarball` 并提 PR。

## 7. 计时器句柄分类（handle-policy）—— 发布前必读

> 背景：`docs/rootcause-red-x-recurrence-20261110-T1.md`（CI cancelled 红叉 4 次复发的根因报告）。
> 可执行契约：`tests/handle-policy.test.ts`（未分类即红）；全局测试锚：`tests/setup-event-loop-anchor.ts`
> 经 `scripts/run-tests.mjs` 以 `--import` 注入每个测试子进程，`cancelled === 0` 由运行器硬断言。

- **收束类计时器**（不触发则子任务/轮次无法到达终态：attempt 上限、轮次总预算 totalTimer、
  no-ack deadlineTimer/deadline、auto-resume、watchdog、dispose 超时）**禁止 `unref()`**。
  裸事件循环（node:test / headless / 宿主排空瞬间）下 unref = 允许进程在收束前排空退出 →
  node 22 判 cancelledByParent → CI 红叉。生命周期必须由收束路径 `clearTimeout/clearInterval`
  管理（不会悬挂宿主）。
- **卫生类计时器**（不触发只丢一条通知/轮询：noticeTimer、poll、notice）**必须保留 `unref()`**
  ——插件不得拖住正在关闭的 DSH 宿主。新增卫生类点位必须显式加进 handle-policy 白名单并附分类理由。
- 新增任何 `setTimeout/setInterval`：默认按收束类处理（ref + 明确清理路径）；选卫生类必须过白名单。
- 发布前本地复跑 `npm run verify`（test 脚本已内置全局锚与 cancelled===0 硬断言）；CI 为
  node 22 + 26 双矩阵，两版全绿才算过——单版本绿不代表修复（2.2.7 教训：本地 node 26 假绿）。
