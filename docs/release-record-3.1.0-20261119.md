# 发布记录 3.1.0 — 2026-11-19

## 发布物

- **Git tag**: `v3.1.0` → commit `64185912af6376eb107fa59f60caa8874e745afd`（main）
- **GitHub Release**: https://github.com/abbaababa/dsh-workplan/releases/tag/v3.1.0
  - 资产 `dsh-workplan-3.1.0.tgz`，官方 size `1798585` bytes
  - GitHub API attested digest：`sha256:0ce1decfb92ea7a6bca70b315fb9a0bd677a5dc8f91e2f63f29133e8f60d5024`
  - 下载校验：`curl -sIL` 资产 URL 返回 HTTP 200（2026-11-19 19:4x CST 首次探测遇瞬时 000，重测即过）
- **npm**: https://www.npmjs.com/package/dsh-workplan/v/3.1.0
  - `dist.shasum = 6eb00d01092799c46e41ddd648ae6b8ec905790f`（sha1）
  - `dist.tarball = https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.1.0.tgz`
  - `npm view dsh-workplan@latest version` → `3.1.0`（latest 已指向）
  - 注：npm 包与 GitHub 资产内容组成不同（npm 含 src/docs/scripts 全量，GitHub 资产为运行期
    dist 组合），两者 sha 不同属预期；各自完整性与内容已分别核验。

## CI 证据（红叉禁止 → 全部 success）

| 运行 | workflow | 触发 | run id | 结论 |
|---|---|---|---|---|
| verify (main) | verify.yml | push | 44517013534 | success |
| release (main) | release.yml | push | 44517013553 | success |
| release (tag) | release.yml | tag v3.1.0 | 44517031851 | success（2m20s） |

`gh run watch --exit-status` 通过；Release 资产由 CI 上传（digest 见上）。

## 本版本变更（3.0.9 → 3.1.0）

1. 专家上限 12→25 整套同步：`src/caps.ts` 单一真源（`MAX_COMPLEX_DELEGATE_MEMBERS=25`、
   `MIN_COMPLEX_DELEGATE_MEMBERS=8`、`MAX_SOURCES_ITEMS=30`）；`src/llm-rules.ts` 删本地常量；
   `src/v3-contract.ts` re-export；`src/plan.ts` 5 处存档消毒 slice 同步；提示词 5 处
   （llm-rules.ts:182、host.ts:875、host.ts:954、plan.ts:6862、runtime.ts:9163）模板化。
2. 隐藏暗伤治本：dispatch 按钳制前声明（`taskReasoningEffortDeclared`）判复杂档，
   修掉"非 qwen 声明 medium 被钳成 low → complexTask=false → memberCap=6 静默截断 8 人名单"。
3. 超上限拒收替代静默截断：新增 `DELEGATE_HEADCOUNT_MAX`（先拒收、错误文案含当前人数/上限/
   "拆两轮"指引），与既有 `HEADCOUNT_MIN` 并列；负责人告知块明示"超过上限平台拒收"。
4. 重派跳过已完成成员：派发循环 `prior.status==='done'` → 保留成果 + `skippedDone` 计数 +
   hint 明示。
5. 排队可见化：`startActivationQueued` 增 `onWait` 回调；排队期间用户收到"【排队中】"通知
   （可调 `subagent.maxActiveSubagents` / `DSH_WORKPLAN_ACTIVATION_QUEUE_MAX_WAIT_MS`）；
   成员条目增 `queuedMs`。
6. 上限环境变量化（默认不变）：`DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS=25`、
   `DSH_WORKPLAN_MAX_SOURCES_ITEMS=30`、`DSH_WORKPLAN_ACTIVATION_QUEUE_MAX_WAIT_MS=600000`、
   `DSH_WORKPLAN_PLANNER_CONCURRENCY=5`（新增 `src/caps.ts` 的 `envPositiveInt`）。
7. 降级消息可行动指引：`buildDegradedMessage` 增 4 条（拆两轮 / 人数超限调 env / 排队超时调
   并发 / 重试最多 3 次）。
8. 测试卫生治本：`tests/setup-event-loop-anchor.ts` 增 `DSH_WORKPLAN_JOURNAL_DIR` 每进程
   mkdtemp 隔离，堵"测试残留下次运行污染"的洞。
9. **W5 跨版本兼容回归修复**（v3.0.0 T7 引入、v3.0.0–v3.0.9 潜伏）：取消/取代信封恢复
   文本标记块双写（`buildCancelMessage`/`buildSupersededMessage`），旧版（1.8.19）读端
   按 cancelled 安全降级契约复原。`scripts/w5-cross-version-check.mjs` 六断言全 PASS
   （v3.0.3/v3.0.9 对照实验同为 FAIL，证明非本次引入）。

测试：npm test 1343 过 / 0 失败（本地，node v26.9.0）；CI 22/26 双版本全绿。

## 索引源（§5）

- 条目 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16952
  （fork 分支 `abbaababa:dsh-workplan-3.1.0`，单行 tarball v3.0.3 → v3.1.0）
- **待合并后复验**：
  1. `npm view dsh-plugin-catalog@latest version` 发布时间晚于合并时间；
  2. `curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -o '"id":"dsh-workplan"'` 命中；
  3. DSH `plugin_market list_plugins(query="dsh-workplan")` 可见可装。

## §6.1 运行态指纹 = 磁盘指纹（待用户重启后补登）

- 磁盘复刻指纹（发布时本地构建产物，算法同 src/host.ts:43-60）：
  `cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16`
  → **`4ff1d5c829704d8e`**
- 运行态自报指纹（需用户手动重启 DSH 后调用 `dsh_workplan_status`）：**待补**。
- 判定规则：相同=通过；不同=验收不通过（进程跑旧字节）；`build unknown`=无法确认。
