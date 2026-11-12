# T3 补丁差异与影响面说明（session-1513 重启后读取历史修复 + T6 派发崩溃治本）

主 Agent 接手实施（子 Agent 派发基础设施崩溃，childId=null 实证两次）。根因见 T2-root-cause-resume-1513.md。

## 1 写入端（插件工作区，单写者）
- `src/plan.ts`
  - 新增 `preHeadWindowSessions` WeakSet + `enterPreHeadWindow(session)` 导出。
  - `appendUserMessage` 前置闸：`(opts.deferUntilHead === true || 窗口标记) && opts.deferUntilHead !== false && !surfaceHeadExists(session)` ⇒ 暂存队列 + `schedulePreHeadFlush` 保险丝（既有）。
  - 影响面：仅 pre-step 窗口内的通知写入顺序变化（头后按序补发，内容不丢）；窗口外行为不变。
- `src/runtime.ts`
  - `maybePlan` 入口（step===1 守卫后）调用 `enterPreHeadWindow(session)`。
  - [T6] 新增 `resolveLiveAgent(ctx, sessionId)`（ctx.get('agents') 安全访问器，D1 同款范式）。
  - [T6] `executeSubtask` 派发前 `liveAgent = options.agent ?? resolveLiveAgent(...)`；缺失 ⇒ `PlanError AGENT_RESOLUTION_FAILED` fail-closed；`parent: liveAgent`。
  - [T6] `startAutoDispatch` 同样兜底 `agent = agent ?? resolveLiveAgent(ctx, session?.id)`。
- `src/watchdog.ts` [T6] `describeError` 对 Error 附截断堆栈（前 6 行、≤600 字符），durable 结果/看板可定位崩溃点（闭环缺口 G2）。

## 2 读取端（DSH 安装包，工作区外，经用户批准；patch-reader.mjs 唯一匹配校验）
- `dsh-session-format-v3-to-v4/lib/index.js` + `src/relationships.ts`：foldSurface 对「surface 非空且无 protectedHead 时到达的 system/message」由抛错改为采纳其为受保护头（legacy 容忍）。
- `dsh-session-format-v2-to-v3/lib/index.js` + `src/validation.ts`：同规则同改。
- 保护语义不放宽：晚到头仍受「replacement/compaction 不得遮蔽系统头」约束（负向用例 PASS）。
- 不删除/不覆盖任何用户会话数据；写入格式不变。

## 3 回归与构建
- 新增 `tests/resume-prehead-regression.test.ts`（6 用例：窗口暂存/按序补发/窗口外立即/逃生门/头在即写/源码锚定）。
- `scripts/wp-fix/regression-before-after.mjs`：写入端修复前（临时副本回退旧闸）失败/修复后通过；读取端 legacy 接受 + 负向保护 + 4 会话对照（1513/当前/6059/001d02ae）ALL PASS。
- `npm run check` 通过；`npm run build` 通过；全量套件结果见 full-suite-r2.log（T5 报告引用）。
- 适配旧契约用例：`tests/workplan-stuck-recovery.test.ts` describeError 断言改为「message 保留 + 无 [object Object]」（堆栈后缀为新契约）。

## 4 生效与验证
- 读取端补丁 + 插件构建需用户手工重启 dsh web 生效（规则 18）。重启验证清单见 T5 报告。
- 剩余风险：T6 的 exec.agent/payload.agent 缺失假设待重启后实证闭环（堆栈留痕已就位，若仍有崩溃可立即定位）。
