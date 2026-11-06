# Release record — dsh-workplan 2.1.0 (2026-11-06)

## 1. 变更主题

建立主 Agent 与部门人员之间的**统一沟通交流格式契约**：派发任务时随任务附带同一份格式要求；部门人员提交前据此自查，完全符合后全盘提交；主 Agent 收到后用同一份格式逐条核验，不合规立刻退回并写明不合规条目，通知其重新检查格式后重交。同时保留 2.0.5 草案的规划器 JSON 结构修复。

用户原话要点（2026-11-06）：

1. 与相关部门人员之间建立完善、健全的交流沟通机制。
2. 派发工作的同时附带一份统一的沟通交流格式要求；部门人员依据该格式自查，完全符合后再全盘交付；主 Agent 收到的结果不符合要求时，立刻退回，通知其重新检查格式。
3. 全部完美完成后，按以前规矩同步自动对外发布新源代码和新版本。

## 2. 机制落地位置

| 环节 | 代码位置 | 行为 |
|---|---|---|
| 下发 | `src/comm-format.ts#renderCommFormatSpec` → `src/plan.ts#buildChildPrompt` 末尾 | 每个子任务提示都附带 F1–F9 九条规范与「提交前自查（强制）」指令 |
| 自检 | 同上（提示词内强制指令） | 部门人员提交前逐条对照 F1–F9 |
| 核验 | `src/comm-format.ts#checkCommFormatCompliance` → `src/plan.ts#adjudicateResult` | 主 Agent 用同一份规范逐条核验 F1–F8（F9 为诚信约束） |
| 退回 | `adjudicateResult` 返回 `blockedKind: 'comm-format'` + `renderCommFormatRejection` | 不合规即判受阻，退回通知写明逐条不合规项与修正要求 |
| 重交 | `src/runtime.ts#executeSubtask` 的 `lastFailure` 注入（`COMM_FORMAT_REJECTED`） | 退回原因随下次激活回到子提示词，子 Agent 只补缺口不重做 |

九条规范：F1 证据块标记成对、F2 status 合法、F3 三阶段齐全、F4 pass 必须带证据、F5 验收条数不少于计划、F6 产物条目合法（kind ∈ file/url/note 且 ref 非空）、F7 复盘四项、F8 blocked 必须带 question、F9 不得编造。

`src/plan.ts` 中 `BLOCKED_KINDS` 同步加入 `'comm-format'`（第 145 行）。

## 3. 设计边界（不夸大）

- 只拦 `done` 路径：解析失败、验收缺口、三阶段缺失已被更早的门禁拦下，保留原有更具针对性的诊断。
- `requirePhases:false`（历史回放 / 明确关闭新契约）不追溯否决旧日志里按当时规则合法的 done。
- F6 只校验产物声明的合法性，是否必须交付文件由各子任务验收标准决定，避免把写作类任务误判为不合规。
- F9 不做自动判定：编造检测需要语义理解而非结构校验，写成提示词级诚信约束，由三阶段门禁与人工复核承担。

## 4. 版本与提交

| 项目 | 值 |
|---|---|
| package.json version | 2.1.0 |
| meta.version（src/host.ts） | 2.1.0 |
| git commit | c7e8f64 |
| git tag | v2.1.0 |
| 远程 | `git@github.com:abbaababa/dsh-workplan.git`（main） |

版本同步点（与 `tests/version-sync` 一致）：`package.json`、`package-lock.json` 两处、`src/host.ts` 的 `meta.version`、`tests/fixtures/tool-surface.json`、README 三语的安装命令与徽章、CHANGELOG 的 `## 2.1.0 — 2026-11-06` 标题。

## 5. 验证

- `npm run check`（tsc -p tsconfig.json --noEmit）：退出码 0。
- `npm test`：tests 578 / pass 578 / fail 0（含新增 `tests/workplan-comm-format.test.ts`）。
- 新增用例覆盖：规范下发一致性（提示词含 renderCommFormatSpec 全文与 F1–F9）、F1–F8 逐条拒收、F6 边界（纯 note 合法）、合规零违规、退回 blocked/comm-format 与通知文案、`requirePhases:false` 兼容、版本契约稳定性。
- 既有用例按新契约前移 1 条：`tests/workplan-evidence-contract.test.ts` 的 C-19 由「空证据 pass 降级 unverified 仍算 done」改为「按 F4 退回 blocked/comm-format」。
- `npm run build` 重新生成 `lib/`、`dist/`、`client.js`，`lib/comm-format.js` 新增，`lib/host.js` 内 version 为 2.1.0。

## 6. 发布渠道

| 渠道 | 状态 | 证据 |
|---|---|---|
| npm | 已发布 | registry 元数据 `dist-tags.latest` = 2.1.0，`versions["2.1.0"]` 存在（`https://registry.npmjs.org/dsh-workplan`，直接查询，非 CLI 缓存） |
| GitHub Release | 已发布 | https://github.com/abbaababa/dsh-workplan/releases/tag/v2.1.0 |
| Release 制品 | 已上传且校验一致 | `dsh-workplan-2.1.0.tgz`，sha256 `0f015202575999b4be428bd55f2349f676a88ad48c605727cbd6e8494c9ac261`；用 `gh release download` 重新下载后本地复算一致；GitHub 侧记录 `digest: sha256:0f015202…` 相同 |
| npm tarball sha1 | 与本地 pack 一致 | `afc59da063e210f03eb0424b00da6e594f8536eb`（npm publish 输出与本机 `npm pack` 输出相同） |

说明：`npm view` 使用的本地 CLI 缓存可能短时间仍返回 2.0.4，以 registry 原始响应为准（本记录的证据即取自此）。缓存刷新后 CLI 即一致。

## 7. 复验命令

```bash
# 1) npm registry 上的最新版本（原始元数据，绕过 CLI 缓存）
curl -s https://registry.npmjs.org/dsh-workplan | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j['dist-tags'].latest, !!j.versions['2.1.0'])})"

# 2) 远程 tag
git ls-remote --tags origin | grep v2.1.0

# 3) 制品可下载且校验一致
gh release download v2.1.0 -p 'dsh-workplan-2.1.0.tgz' -D /tmp/recheck --clobber
shasum -a 256 /tmp/recheck/dsh-workplan-2.1.0.tgz   # 期望 0f015202…

# 4) 本地复现验证
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
npm run check && npm test
```

## 8. 回滚方案

- 代码：`git revert c7e8f64` 后推送 `main`；需要撤销 tag 时 `git tag -d v2.1.0 && git push origin :refs/tags/v2.1.0`。
- npm：72 小时内可 `npm unpublish dsh-workplan@2.1.0`（已发布版本超过 72 小时不可撤，改用 `npm deprecate dsh-workplan@2.1.0 "…"` 标注问题并发布修复版）。
- 用户侧：安装旧版 `npm i dsh-workplan@2.0.4`；GitHub Release 可删除 v2.1.0 资产。

风险提示：版本一旦被下游安装，撤回不能从已安装环境消失，回滚应以「发修复版」为主，`unpublish` 仅用于发布后立刻发现的严重错误。

## 9. 已知问题（如实记录）

本次会话中，dsh-workplan 的**自动任务分解**（它自己驱动的部门子 Agent）连续失败，计划 `wp-b7750256`（10 项）与 `wp-80e484d9`（9 项）全部子任务为 blocked，错误均为基础设施层：`cannot get required service "subagents" in inactive context` 与 `子 Agent 结束状态为 error`。子 Agent 未产生任何代码改动；2.1.0 的全部实现、测试与发布均由主 Agent 在本会话直接完成。

这不影响 2.1.0 的代码正确性（578 条用例含专门的门禁用例全部通过），但说明「子 Agent 调度链路」在本机当前环境不可用，需在后续版本或部署侧单独排查。
