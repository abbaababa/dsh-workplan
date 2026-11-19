# 发布记录 3.1.1 — 2026-11-19

## 发布物

- **Git tag**: `v3.1.1` → commit `e64ad252ed0c3b678a68c5f2e81e0f2f72596f64`（main）
- **GitHub Release**: https://github.com/abbaababa/dsh-workplan/releases/tag/v3.1.1
  - 资产 `dsh-workplan-3.1.1.tgz`，官方 size `1809128` bytes
  - GitHub API attested digest：`sha256:a1747f22a2f2edb0266c6877d0354d3173ef0166dfc3a2d42e2d914d9e88c374`
  - 下载校验：`curl -sIL` 资产 URL 返回 HTTP 200（发布脚本 verify 阶段实测）
- **npm**: https://www.npmjs.com/package/dsh-workplan/v/3.1.1
  - `dist.shasum = bdb4fbb23e391ae59c0a1ff8fcad9dd5906fa4b6`（sha1）
  - `dist.tarball = https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.1.1.tgz`
  - `npm view dsh-workplan@latest version` → `3.1.1`（latest 已指向；注册表发布约 6 分钟后传播可见，期间脚本 verify 曾遇假阴性，curl 直连注册表 API 复核为真阳性）

## CI 证据（红叉禁止 → 全部 success）

| 运行 | workflow | 触发 | run id | 结论 |
|---|---|---|---|---|
| release (tag v3.1.1) | release.yml | tag | 44540845111 | success（Build 22/26、Test 22/26、Release 全绿，Release 29s；npm publish 带 --provenance，sigstore logIndex 3998540062） |

`gh run watch --exit-status` 通过。

## 本版本变更（3.1.0 → 3.1.1）：跨会话登记缺陷治本

**事故（2026-11-19 晚，计划 wp-b26c6d56 T2/T3，EVIDENCE_INCOMPLETE 连环退回）**：
部门负责人在自己的会话经 `action="direct"` 代登记开工证据（T2 problemAnalysis 8 条/1242 字，
含 21:02 实测腾讯快照 0.454），平台另开**全新执行子会话**承接——接续提示只转述「已登记」，
登记**逐字原文从未进入交卷人上下文**（会话日志核实原文 0 次出现）；执行者凭任务书重写更短
摘要（6 条/471 字）→ 结算闸开工-结算一致性比对（checkStartEvidenceCarryover）判「变薄」→
EVIDENCE_INCOMPLETE 退回；重试只回数字不回原文，补报退化成凑字数游戏（重试会话原文自述
"I don't have the exact startPhases text"，10 条/1298 字 ≥ 8 条/1242 字）。

1. **结算自动归并（five-step.ts `mergeStartEvidenceIntoSettlement`）**：结算一致性比对前，
   行级登记 startPhases 与交卷 phases 取**并集**落账（交卷条目在前、登记条目按原序补入、
   trim 后逐字去重、每清单封顶 MAX_PHASE_LIST_ITEMS=20）——登记内容是任务 durable 事实，
   不因交卷人未复述而减少；「宽容新增」语义不变，「禁止变薄」由平台侧保证；比对保留作
   安全网（仅封顶截断装不下登记条目时才真退回）。空登记/null 入参 fail-safe 原样返回。
2. **登记原文三路回注**：① phase-1 接续提示（plan.ts `buildPhaseZeroContinuationHint` 新增
   第 4 参，runtime.ts:2600 调用点传 `effortRow.startPhases`）；② EVIDENCE_INCOMPLETE 回喂
   消息（runtime.ts lastFailure 新增 `registeredStartPhases` 字段，catch 内从台账按 id 重查——
   settleRow 声明在 try 块、catch 不可见；buildChildPrompt 渲染「逐字抄入」登记原文块）；
   ③ 负责人自配档接续提示（runtime.ts:9360 由截断 200/300 字摘要升级为 renderStartPhaseEvidence
   全文）。新增 five-step.ts `renderStartPhaseEvidence`（每条 slice 800 字展示级截断）。
3. **提示词明示收尾复制纪律**：fiveStepPromptLines 新增「[3.1.1] 收尾复制纪律」条目；
   llm-rules.ts direct 禁派文案同步追加；结算退回 error 文案更新（指引照抄登记原文）。

测试：本地 `npm test` 1353 过 / 0 失败（node v26.9.0，全量 1354 例含新增
`tests/workplan-start-evidence-merge.test.ts` 10 例：M1–M3 归并单测、R1 原文渲染、
A1 薄交卷+登记判 done 且落账含登记条目、A2 缺块零回归、A3 封顶安全网仍 blocked、
P1/P2 提示词回注、E1 direct 跨会话首跑即 done）。

## 索引源（§5）

- 条目 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16994
  （fork 分支 `abbaababa:dsh-workplan-3.1.1`，单行 tarball v3.0.3 → v3.1.1；
  上游在 3.1.0 的 #16952 未合并，故本次直接 3.0.3 → 3.1.1）
- **待合并后复验**：
  1. `npm view dsh-plugin-catalog@latest version` 发布时间晚于合并时间；
  2. `curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -o '"id":"dsh-workplan"'` 命中；
  3. DSH `plugin_market list_plugins(query="dsh-workplan")` 可见可装。

## §6.1 运行态指纹 = 磁盘指纹（待用户重启后补登）

- 磁盘复刻指纹（发布时本地构建产物，算法同 src/host.ts:43-60）：
  `cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16`
  → **`179490ac8e9bd7d4`**
- 运行态自报指纹（需用户手动重启 DSH 后调用 `dsh_workplan_status`）：**待补**。
- 判定规则：相同=通过；不同=验收不通过（进程跑旧字节）；`build unknown`=无法确认。
