# v1.9.1 — 圈注三行能自己变绿，1.9.0 的四项遗留全修完

## 一句话

`dsh_workplan_followup` 让被中止的子会话在**用户授权后自己再跑完一个正常回合**，
界面据此变绿；同时把 1.9.0 明确留到「下一批」的四项（superseded 写侧、P1 拒绝码、
W1 digest、W5 真实取消联测）全部落地。npm 上此前最新是 **1.8.18**，`1.9.0` 与
`1.9.1` 都从未发布，所以升到 1.9.1 会一次性拿到 1.9.0 与 1.9.1 的全部修复。

## 你会看到什么变化

| 之前 | 现在 |
|---|---|
| 被整轮预算 / 900s 上限中止的子会话永远是灰点（`lastTurnCompleted=false`），改台账也不会变绿 | `dsh_workplan_followup` 把说明投递给父会话登记过的**直接**子会话；子会话自己跑完一轮后 `turn/end` 正常，界面自然变绿 |
| 想把一个已取消计划的交付责任转给另一个计划，只能手改记录 → 重启后 live 与 replay 分叉 | `dsh_workplan_cancel` 支持 `disposition:'superseded'` + `supersededBy`，V1–V8 核验全过才写、`coverage`/`digest` 由运行时复算，append 成功才翻内存状态 |
| 全部子任务 done 但证据有缺口时，`present` 的拒绝码是 `ACTIVE_NOT_READY`，用户分不清「没做完」和「证据不齐」 | 统一走 `activeDenyCode()`：`remaining` 空 + `blockers` 非空 ⇒ `EVIDENCE_GAP`，其余 ⇒ `ACTIVE_NOT_READY`；拒绝文案不变 |
| 覆盖映射存进日志后无法复核是否被改动 | `sha256(canonical(mapping))` 规范化摘要（sort_keys + 紧凑分隔符 + 非 ASCII 不转义），读侧只重算、不信任缓存值，重算不一致即 stale |
| 取消 / 取代的信封只在单测里用桩件验证 | W5 联测直接走真实 `buildCancelMessage` 信封 → durable 记录 → replay 读回，覆盖两种处置与终态互斥 |

## 修复内容

### 1. `dsh_workplan_followup`（1.9.1 主体）

- 只允许根会话调用；目标必须是父会话 `subagent/catalog` 里登记的**直接**子会话。
- 只投递、不改状态：不写台账、不触发 `present`、不改 `lastTurnCompleted`；
  是否变绿由子会话自己的下一轮 `turn/end` 决定。
- 拒绝码：`NOT_ROOT` / `NOT_DIRECT_CHILD` / `NO_SUBAGENT_SERVICE` / `DELIVERY_FAILED`；
  空 message 或超 4000 字符直接拒绝。

### 2. superseded 写侧（唯一入口）

- `src/supersede.ts`：`supersedePlanRecord()` 是 `superseded` 的唯一写路径；
  V1–V8 任一失败返回 `ok:false` + `SUPERSEDE_*` 码，**不改内存、不写日志**。
- `src/plan.ts`：`buildCancelMessage(..., { disposition:'superseded' })` 是全仓库唯一
  拼装 `workplan-cancel` 信封的出口；自动覆盖路径只允许写 `cancelled`。
- 用户确认（V8）必须是真实用户消息：同时包含两个 planId 且含
  「确认/同意/可以/按此执行」之一；模型自述不算确认。

### 3. P1 拒绝码统一

- `PRESENT_DENY_CODES` + `activeDenyCode()` 收敛 `present` 的两个未完成分支；
  码值对外可断言，文案逐字保留；`EVIDENCE_GAP` 散落字符串 0 处。

### 4. W1 digest

- `src/supersede-digest.ts`：`canonicalMappingJson()` / `computeMappingDigest()` /
  `verifyMappingDigest()` / `withMappingDigest()`；摘要只证明「存下来的 mapping
  没被改动」，不证明两项工作在语义上等价。

### 5. W5 真实取消信封联测

- `tests/workplan-w5-cancel-e2e.test.ts` 5 例：1.8.19 真实信封字段契约不变、
  事故同构场景、生产写路径 schema 一致、D2 未放宽、superseded 增量字段降级可读。

## 升级与兼容

- 旧调用不受影响：`dsh_workplan_cancel` 的 `disposition` 缺省仍是 `cancelled`。
- 旧会话可回放：`superseded` 是增量字段，旧读侧按 `cancelled` 降级可读。
- 需要 Node ≥ 22（`engines.node` 未变）。

## 证据（发布时复核）

- `npm run check` EXIT 0（无诊断）。
- `npm test` EXIT 0：**306 / 306**（1.9.0 基线 277，净增 29）。
- 两次构建 7 个产物（`lib/*.js` + `client.js`）sha256 完全一致。
- `npm pack`：产物清单、体积与 `shasum` 在发布记录 `docs/release-record-1.9.1-20261101.md` 中逐项登记
  （本文件自身也在包内，因此不在此处写会随本文件变化的体积数字）。
