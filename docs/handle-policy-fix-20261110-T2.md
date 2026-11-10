# T2 系统性修复报告：handle-policy + 测试防回归（2026-11-10）

> 仓库：`plugins/dsh-workplan`（HEAD `3aed805`，v2.2.8，工作树含本修复，版本号升级留给发布决策）
> 依据：T1 根因报告 `docs/rootcause-red-x-recurrence-20261110-T1.md`（P-1~P-5 建议、R1-R9 风险清单）
> 补丁：`docs/handle-policy-fix-20261110-T2.patch`（16 个 diff；`git apply --reverse --check` = PATCH_FRESH_OK，与当前树逐字节一致）

## 1. 修复内容（对 T1 清单逐项）

### P-1 收束计时器去 unref（R1-R6，全部完成）
| T1 风险点 | 位置（当前树） | 处置 |
|---|---|---|
| R1 totalTimer 轮次总预算 (P0) | src/runtime.ts:3178 区域 | 删 unref，注释禁令；收束路径 finally clearTimeout |
| R2 no-ack deadlineTimer (P0) | src/runtime.ts:2185 区域 | 删 unref；clearAckTimers 清理 |
| R3 auto-resume 计时器 (P0) | src/runtime.ts:5746 区域 | 删 unref；clearAutoResumeTimer 多路径撤销 |
| R4 watchdog interval (P0) | src/watchdog.ts:265 | 删 unref；finish()/stop() clearInterval |
| R5 指示 ack deadline (P1) | src/runtime.ts:6406 区域 | 删 unref；触发/回执即 stop() 清整组 |
| R6 dispose 超时臂 (P1) | src/runtime.ts:1201 区域 | 删 unref；finally clearTimeout |

卫生类 R7/R8/R9（noticeTimer/poll/notice）**保留 unref + 分类注释**（不拖住关闭中的宿主）。
终态：`grep -n "\.unref" src/*.ts` = 恰好 3 处（runtime.ts:2152/6372/6383），全部卫生类白名单。

### P-2 全局测试锚（治本 RC-2）
- `tests/setup-event-loop-anchor.ts`：ref'd interval + after() 清理 + 10min failsafe；由 `scripts/run-tests.mjs` 以 `--import` 注入**每个**测试子进程 → 97+ 文件全覆盖（含 §4.2 九个裸奔文件），新文件自动获保护。
- `tests/event-loop-anchor-global.test.ts`：接线自检（锚存在且 hasRef()===true），接线断即红。
- **偏离记录**：12 份手工锚未删除（T1 原文建议删）。理由：①全局锚已是结构保证，手工锚为无害冗余（707 全绿实证）；②保留可护住「直接 node --test 单文件、不经 run-tests.mjs」的场景（T3 验证/开发者单跑）；③删除需再全量复跑一轮，时间预算不允许。风险：零（功能不变，仅代码冗余）。

### P-3 静态守卫（把分类固化为可执行契约）
- `tests/handle-policy.test.ts`：①精确集合契约（src/ 全部 unref 点位 === runtime.ts 三处卫生类）；②历史事故句柄名黑名单（timer/totalTimer/deadlineTimer/deadline/attemptTimer）；③白名单计数（卫生类 unref 被误删也红）。未来新增计时器未分类即红。

### P-4 CI 断言与环境对齐（治本 RC-3）
- `scripts/run-tests.mjs`：强制 TAP + **硬断言 cancelled===0**（点名 cancelledByParent，exit 1），汇总行显式打印 pass/fail/cancelled/exit；package.json test 脚本收口到它。
- `.github/workflows/verify.yml`：node **22+26 双矩阵**（fail-fast:false），单版本绿不再算过。

### P-5 文档固化
- `RELEASING.md` 新增 §7「计时器句柄分类（handle-policy）——发布前必读」。

### 附加（上次尝试落盘，本次核验保留）：[2.2.9] 结算恢复路径
- `src/runtime.ts`：结果块缺失（EVIDENCE_MISSING）与 unparsable 同闸有界回喂重试 + 优先采纳盘上结算备份 `reports/wp-settlement-<id>.json`（治「超时/丢块→blocked→级联冻结→红字」族，即上一轮 T2 自身遭遇的故障模式）；`src/plan.ts`：子提示词增加盘上备份必做条款；`tests/workplan-evidence-missing-retry.test.ts`：配套回归用例（含于 707 全绿）。

## 2. 验证证据索引（全部可复跑）
1. **全量**：`npm run verify` → `[run-tests] pass=707 fail=0 cancelled=0 exit=0`，整体 exit 0（日志尾：`reports/t2-verify-summary.log`）。
2. **A2 实弹**：注入 `totalTimer.unref` → handle-policy exit=1 fail=1（契约不符）；破坏卫生类 `noticeTimer.unref` → exit=1 fail=1；锚测试无 `--import` → exit=1 fail=1；全部还原 → exit=0（LIVE-FIRE 残留 grep=0，diff stat 79+6=85 与基线一致）。
3. **裸事件循环探针**（node22 本地不可用的替代验证，版本无关机理）：`reports/t2-bare-loop-probe.cjs` —— 正样本 elapsed=418ms PASS（watchdog interval 为 ref 态，loop 存活至收束触发）；负样本（lib 注入 unref）elapsed=0ms FAIL（loop 立即排空 = CI cancelled 同机理复现）；还原复跑 416ms PASS。
4. **补丁**：`git apply --reverse --check docs/handle-policy-fix-20261110-T2.patch` → PATCH_FRESH_OK。
5. **A4 无悬挂/泄漏**：全量 707 用例 11.7s 干净退出（残留 ref 句柄会挂住子进程）；探针进程收束后自然退出；锚 after()+failsafe 双清理；收束计时器均有 clearTimeout/clearInterval 收束路径（§1 表内逐项注明）。

## 3. 遗留与移交
- 版本号升级（2.2.9）与提交/发布：留主 Agent 决策（本任务不扩权）；提交时 src/ 与 lib/ 必须同 commit（CI 新鲜度门禁 `git diff --exit-code -- lib client.js`）。
- CI 双矩阵首次真实跑在推送后由远端验证；本地已用裸循环探针替代 node22 行为验证。
- 12 份手工锚冗余保留（偏离记录见 §1 P-2），后续可在独立清理 PR 中移除。
