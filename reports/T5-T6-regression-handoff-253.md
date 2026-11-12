# dsh-workplan 2.5.3 回归验收与生效交接（2026-11-12）

## 0. 一句话结论（给不懂电脑的朋友）
会话的聊天记录被存成一个压缩日志文件。Harness 有一条硬规定：日志里"对话面"的第一条记录必须是"系统提示"（叫 protected head）。旧版插件（2.5.2 及以前）在 Harness 还没写这条系统提示之前，就先把"【规划预告】/【规划进行中】"等通知写进了对话面，抢了第一位。平时不检查所以看着正常；一旦重启、Harness 重新读日志做检查，就发现"第一位不是系统提示"，于是把整份日志判为损坏，会话就显示"历史加载失败"。2.5.3 让插件"系统提示没写好之前先不发通知、写好后再补发"，从根上不再抢位；并把已经写坏的旧日志安全修好（原文件全部备份）。

## 1. 根因（可复核）
- 校验器：`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:599` 与 `dsh-session-persistence-jsonl/lib/worker.cjs:12181`（Relationships.foldSurface）：surface 非空且 protectedHead 未设时再遇 system/message 即抛 `SessionFormatError: system/message requires a protected first surface head`；protectedHead 仅在"surface 为空时的 system/message append"设置（index.js:601 / worker.cjs:12183）。
- 写入侧：插件唯一合规写入器 `src/plan.ts` appendUserMessage（旧版 1674-1684）以 `user/message, surfaceOp:'append'` 落盘；规划期调用点 `src/runtime.ts:9406`（规划预告）、`9434-9442`（规划心跳）、`9422`（重试回报）发生在宿主首条 system/message（首个 model step）之前 → 通知成为首条 surface 事件。
- 实证（zstd -dc 逐事件）：session-1075b1b0 首条 surface=seq8（workplan 通知）、system head=seq18；session-d93cd464 seq9/seq20 同构；健康旧会话 session-8f2cd20e 首条 surface=seq8 system/message（对照）。
- 多会话共性：凡首回合触发规划预告的会话共用该写入路径，故同时中招。

## 2. 修复（2.5.3，最小、单点、覆盖全部调用方）
- `src/plan.ts`：appendUserMessage 增加 protected-head 前置闸（surfaceHeadExists / flushPreHeadNotices / preHeadNoticeQueue）。系统头未出现时通知暂存不落 surface；系统头出现后按序补发再写当前通知。不改事件类型、不触碰 system/message、零 schema 变更。单元桩无 eventAt/seq 时保持旧行为（不影响既有测试）。
- 版本：`package.json` 2.5.2→2.5.3；`src/host.ts` meta.version 2.5.2→2.5.3；`npm run build` 通过（BUILD_EXIT=0），lib/plan.js 含 surfaceHeadExists、lib/host.js 含 version:'2.5.3'。
- 旧日志修复脚本：`scripts/repair-prehead-notices.mjs`。把"首条 system/message 之前、source.kind=workplan 的 user/message 通知"改写为 log-only 类型 workplan/notice（不在 SURFACE_TYPES，校验器忽略），其余事件与 seq 原样；先备份 `<log>.bak-pre253`；修复后用忠实复刻 foldSurface 的离线校验器验证通过才落盘；无 head 或头前无 workplan 通知的日志自动 SKIP（不误修）。

## 3. 回归证据
- 写入侧_deferral 回归（node 直测 lib/plan.js）：DEFERRAL_REGRESSION_PASS。头前两条通知被暂存（surface 零泄漏）；头落地后补发，顺序=[system/message, user, user, user]，首条 surface=system/message；已存在头的会话立即 append；畸形 payload 仍被拒绝。
- 旧日志修复离线校验（原日志抛原报错 → 修复后通过，protectedHead 已设）：
  - session-1075b1b0-adc5-429f-8d9f-3bd9c457fc87：改写 7 条，修复后首 surface seq=18=protectedHead。
  - session-d93cd464-061b-4cdd-bd1f-41282ef98c81：改写 1 条，seq=20=protectedHead。
  - session-72c219a9-56a6-4f52-8808-cb0e104e885f：改写 12 条，seq=26=protectedHead。
  - session-4b036b43-271b-41d2-9b5a-138b98eff969：改写 1 条，seq=127=protectedHead。
  - 以上 4 份均备份 .bak-pre253。
- 全量扫描（近 7 天会话）：另发现 session-39374797 / session-8f17be01 头前虽有 workplan 通知但整份日志无 system/message 头 → 不触发本报错，脚本正确 SKIP（非本缺陷）。
- 边界如实标注：离线校验忠实复刻了报错对应的 foldSurface/protectedHead 规则；"真实重启后 GUI 加载"需用户手工重启后目视确认（见 §4），子任务不执行重启。

## 4. 生效交接（需用户/主 Agent 执行，子任务不重启）
1. 本会话（session-096ece51，正在运行）日志仍含头前通知，属受影响但"活体"文件，未在本次改动。请在它静止后（重启前关闭或重启后加载失败时）运行：
   `node plugins/dsh-workplan/scripts/repair-prehead-notices.mjs /Users/open/.dsh/sessions/--Users-open-Documents-Stocks--/session-096ece51-2361-4f0f-84f3-b4c1b7657033/session.v4.jsonl.zstd`
   （脚本幂等：健康或已修日志自动 SKIP。）
2. 用户手工重启 dsh web（宿主侧无热加载，lib 已构建为 2.5.3）。禁止 Agent 自行重启。
3. 重启后目视确认：session-1075b1b0 / d93cd464 / 72c219a9 / 4b036b43 打开不再报"历史加载失败"；新建会话发一条触发规划的消息，重启后亦不再报错。
4. 状态行/插件自报版本应为 2.5.3。

## 5. 回滚方案
- 日志回滚：把对应 `<log>.bak-pre253` 覆盖回 `<log>`（备份即修复前原文件）。
- 插件回滚：`git -C plugins/dsh-workplan checkout -- src/plan.ts src/host.ts package.json` 后 `npm run build`（或恢复 .backups/ 内 2.5.2 产物），再手工重启。回滚后旧缺陷复现，需重新执行日志修复脚本的反向操作（即恢复备份）以回到修复前状态。
- 触发条件：若 2.5.3 出现新的加载/通知异常，先回滚插件并恢复日志备份，再报障。

## 6. 30 分钟预算执行留痕
取证/根因（T1/T2）与修复/版本（T3/T4）并行推进；主 Agent 独立实锤根因并落地最小补丁+日志修复+回归，T2 独立结论与主 Agent 完全一致（交叉验证）。全过程未重启、未安装依赖、未删除任何原始数据（全部备份）。
