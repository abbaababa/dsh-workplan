# T2 根因报告：重启后继续 session-1513aa1d 读取历史报错（治本版）

面向零基础读者：会话日志像一本笔记本，读取端要求「封面（系统头 system/message）」必须在第一页。旧版插件在封面写好之前就往里插了几页「任务通知」，服务运行时本子拿在手里看不出问题；重启后从磁盘重新读本子，读取端按规矩检查顺序，发现通知在封面前面，就整本判「损坏」拒读——这就是「只有重启后才报错」的原因。

## 1 现象与证据（T1 交接）
- GUI 报错原文（用户实供）：`历史加载失败：stored session "session-1513aa1d-…" is corrupt: … SessionFormatError: system/message requires a protected first surface head (raw log: …/session.v4.jsonl.zstd)（gateway/internal）`。
- 持久化数据完好：`~/.dsh/sessions/--Users-open-Documents-Stocks--/session-1513aa1d-ea9d-463c-9273-ee9a253e40cb/session.v4.jsonl.zstd`，多帧 zstd，`zstd -dc` 全帧解码 476 行（1 头行 + 475 事件），末尾 `turn/end completed`，无截断。解码副本：`scripts/wp-fix/target-session.jsonl`。
- 违规顺序实证：seq 7–13 共 7 条 `user/message`（workplan 中断/受阻通知，`surfaceOp:"append"`）先于 seq 14 `step/start`、seq 15 首条 `system/message`（系统头）。

## 2 根因（双侧，均代码级定位）
- 读取端：`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` `Relationships.foldSurface`（原 599 行）：`system/message` 到达时 surface 非空且 `protectedHead===undefined` 即抛 `SessionFormatError`；v4 读取链 `dsh-session-persistence-jsonl/lib/index.js:1077 assertReleasedV4Relationships` 调用它，失败被包装成 `stored log is corrupt`（2825/2869 行）。v2→v3 迁移同规则（`dsh-session-format-v2-to-v3/lib/index.js:432`）。
- 写入端：dsh-workplan 插件 `appendUserMessage`（src/plan.ts）旧实现仅对显式 `opts.deferUntilHead` 的规划期三类通知暂存；派发崩溃中断通知（`announceSubtaskInterrupt`）、受阻/结算消息同样落在 pre-step 窗口（系统头之前），写出「头前通知」日志。旧版 2.5.4 无任何 defer；未提交 2.5.5 只覆盖规划三处，仍漏中断/结算通知。
- 为何仅重启后触发：运行态会话在内存，追加不做该校验（dsh-session 活体 fold 无 protectedHead 规则，已核实）；重启后 resume 走 stored-log 校验才暴露。
- 故障范围：通用写入缺陷+读取端零容忍，非单会话数据损坏。实证当前会话 session-6e26e9e5 同样 THROW（3 条头前通知，系统头 seq11）——不修则下次重启所有含头前通知的会话都无法继续。

## 3 离线回放验证（修复前失败/修复后通过）
- 脚本 `scripts/wp-fix/replay-proof.mjs`：对 1513 与当前会话调用 `assertReleasedV4Relationships`。
  - 修复前：两者均 `THROW: system/message requires a protected first surface head`（与 GUI 报错逐字一致）。
  - 修复后：两者均 `VALID`。
- 保护语义不放宽：晚到系统头被采纳为 protectedHead 后，「replacement 不得遮蔽系统头」等后续校验仍生效（负向用例见 T4 回归）。

## 4 修复（最小作用域，不删改任何用户数据）
- 写入端（插件，工作区内）：`src/plan.ts appendUserMessage` 前置闸覆盖 pre-step 规划/自动派发窗口——`maybePlan` 入口 `enterPreHeadWindow(session)` 标记，窗口内全部通知头前暂存、头后按序补发（既有 flush 保险丝复用）；显式 `opts.deferUntilHead` 与 `false` 逃生门保留。真实宿主里工具调用/结算必在首 step 系统头之后，窗口外立即写入（单元桩同契约，零回归）。
- 读取端（DSH 安装包，工作区外，经用户批准）：4 文件同改「晚到系统头采纳为受保护头」替代抛错——v3-to-v4 lib/index.js + src/relationships.ts、v2-to-v3 lib/index.js + src/validation.ts。补丁脚本 `scripts/wp-fix/patch-reader.mjs`（逐文件唯一匹配校验）。
- 生效条件：读取端补丁需用户手工重启 dsh web 后生效（规则 18，Agent 不自行重启）；写入端随插件构建+同一重启生效。

## 5 排除的备选假设
- 数据损坏/截断：排除（全帧解码完整、turn/end completed）。
- 单会话特例：排除（当前会话同病）。
- zstd 多帧读取问题：排除（CLI 全帧解码成功，且报错来自格式校验而非解压）。
- 派发 TypeError（reading 'id'）与本病同根因：排除（独立缺陷，候选宿主 dsh-subagent:3024，另行实证）。
