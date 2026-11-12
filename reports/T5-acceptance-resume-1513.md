# T5 验收报告：重启后继续 session-1513aa1d 读取历史修复（含 T6 派发崩溃治本）

结论：**通过（离线验证全绿）**；端到端重启确认待用户手工重启后回收（清单见 §4，剩余风险见 §5）。

## 1 回归用例运行结果（修复后）
- 全量套件：`npm test` → **866/866 pass，0 fail**（scripts/wp-fix/full-suite-r4.log，EXIT=0）。含新增 tests/resume-prehead-regression.test.ts 6 用例。
- 对照回归 `scripts/wp-fix/regression-before-after.mjs` → **ALL PASS**（regression-r4.log）：
  - 写入端·修复后：头前暂存 ✔ 头后按序补发 ✔
  - 写入端·修复前（临时副本回退旧闸）：头前立即写入 2 条 ⇒ 缺陷复现、用例失败 ✔（先失败后通过对照）
  - 读取端·1513：legacy 日志接受 ✔；历史完整性 475 事件+1 头行=476 行、turn/end completed ✔
  - 读取端·负向：replacement 遮蔽系统头仍抛错 ✔（保护语义未放宽）
- 读取端修复前失败证据：本会话补丁前 replay-proof.mjs 实测 `THROW: system/message requires a protected first surface head`，与 GUI 报错逐字一致（T2 报告 §3）。

## 2 多会话读取对照（无新增失败）
| 会话 | 事件数 | 补丁前 | 补丁后 |
|---|---|---|---|
| session-1513aa1d（目标） | 475 | THROW（同 GUI 报错） | VALID |
| session-6e26e9e5（当前） | 681 | THROW | VALID |
| session-6059f01b | 1466 | —（未测前） | VALID |
| session-001d02ae（子会话样本） | 467 | —（未测前） | VALID |
对照均只读解码副本/原始日志离线校验，未改任何用户数据。

## 3 构建与静态检查
- `npm run check`（tsc --noEmit）通过；`npm run build` 通过（build-r4.log）。
- 过程留痕：r1 37 失败=旧契约 mock/断言（默认全量 defer 设计）→ 收窄为 pre-step 窗口契约并适配 describeError 断言后 r2 866/0；r3 22 失败=executeSubtask 过宽标记 → 回退该标记（maybePlan 入口标记已覆盖真实头前窗口）后 r4 866/0。弯路已复盘入 §5。

## 4 重启端到端验证清单（用户手工执行，Agent 不自行重启）
1. 确认补丁在盘：plugins/dsh-workplan/lib/plan.js 含 `preHeadWindowSessions`；宿主 4 文件含「legacy tolerance」注释（patch-reader.mjs 可复核）。
2. 用户手工重启 dsh web（当前 GUI http://127.0.0.1:3080 的服务进程）。
3. GUI 继续 session-1513aa1d-ea9d-463c-9273-ee9a253e40cb：预期历史完整加载（475 事件）、无「历史加载失败/corrupt」报错。
4. GUI 继续当前会话 session-6e26e9e5：预期正常。
5. 新回合触发自动派发：预期不再毫秒级崩溃（childId 非 null）；若仍异常，durable 错误含［stack:…］可立即定位（T6 留痕）。
6. 抽查另一历史会话（如 6059）读取正常。

## 5 剩余风险与复盘
- R1：端到端重启确认未执行（需用户动作）；离线证据已覆盖读取链路同一校验函数。
- R2：T6 的 agent 缺失假设待重启实证；fail-closed+兜底+堆栈留痕已就位，最坏情况明确报错而非裸 TypeError。
- R3：session_event_search 30s 超时为独立观测（疑似 2016 会话索引慢），与本报错无因果证据，待重启后复测。
- 复盘（问题/弯路/解决/防再犯）：① 问题=头前 surface 写入+读取端零容忍；解决=窗口前置闸+读取端 legacy 容忍。② 弯路=默认全量 defer 破坏 37 个旧契约 mock、executeSubtask 过宽标记破坏 22 个；解决=契约收窄到真实头前窗口（pre-step），mock 与真实宿主同契约。③ 防再犯=凡改写入顺序契约，先以「真实宿主何时写」界定窗口，再跑全量；回归必须含修复前失败对照与负向保护用例。
