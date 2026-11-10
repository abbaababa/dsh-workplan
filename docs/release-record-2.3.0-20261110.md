# 发布记录 — dsh-workplan 2.3.0（2026-11-10）

## 本次内容：专家执行时间机制优化（用户 2026-11-10 四项要求）
- 要求1 前半段：专家开工预告（timeNotice）落档后，插件即时向主会话推送【专家预估上报】，明确「请把此预期执行时间告知用户」（src/runtime.ts recordTimeNotice→appendUserMessage）；主 Agent 义务写入 7a 条款（src/host.ts）。
- 要求1 后半段：超时后主 Agent 用 extendMs 放宽成功，插件自动向执行中专家投递【延期告知】= 最新执行时间 + 约剩余量 + 「必须在保证工作质量的前提下高效率执行」（notifyExpertOfExtension，回执 childNotified，投递留档 timeJournal）。
- 要求2：同一子任务第 2 次超时（TAKEOVER_AFTER_TIMEOUTS=2）置 takeoverRequired，生成接手包 takeoverBrief（landedRefs/completedArtifacts 只读保护、remainingOutputs 仅含未完成部分）；mergePreservedArtifacts 只增不减，代码硬编码「禁止丢弃、禁止删除或覆盖、禁止整步重跑」；plan.ts resetBlockedStatuses 对该行跳过重派。
- 向后兼容：全部走 StatusEntry 未知字段直写通道 + 回放白名单透传（timeoutCount/takeoverRequired/takeoverBrief），不改既有判定语义。

## 验证证据
- 静态检查：npm run check（tsc --noEmit）exit 0；npm run build exit 0。
- 产物可复现：重建后 16 个 lib/*.js + client.js sha256 逐一 OK（H1 新鲜度门禁通过）。
- 全量回归：node scripts/run-tests.mjs pass=716 fail=0 cancelled=0 exit=0（reports/t3-full-suite-summary-2.3.0.txt）。
- 场景验证：tests/qa-time-mechanism-scenarios-t3.test.ts 场景A/B/C/D 5/5 pass；场景C断言产物 sha256 接手前后一致、保护清单只增不减。
- 版本一致性：version-sync 测试 2/2 pass；6 个声明位（package.json/lock×2/src/host.ts/lib/host.js/tool-surface fixture）= 2.3.0；三语 README 徽章与安装行同步 2.3.0。

## 发布链路（RELEASING.md §0–§7）
- commit 8e5b91c「Release 2.3.0」→ 已推送 origin/main；tag v2.3.0（aa8b1ef，指向 8e5b91c）。
- GitHub Release：https://github.com/abbaababa/dsh-workplan/releases/tag/v2.3.0，制品 dsh-workplan-2.3.0.tgz sha256=0347f615b7b5bb863493afa9ff515a275941d87b85db6468bc5c2992287c4f36（按 tag 干净检出 npm ci+build+pack 产出），制品下载 HTTP 200。
- npm 索引源：npm publish 成功（+ dsh-workplan@2.3.0）；npm view dsh-workplan@2.3.0 version=2.3.0，tarball=https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-2.3.0.tgz。
- 上游条目源（awesome-dsh-plugin）：PR #13893 已更新至 v2.3.0（fork 分支 bump229 commit b8d1cc5，tarball 指本次 Release），标题/描述同步；上游仓库合并权限不在本账号（MergePullRequest 被拒，属 RELEASING.md §5 明示边界——合并后上游 CI 自动发 dsh-plugin-catalog）。

## 运行态生效
本机运行中的 DSH 仍加载旧字节；需用户手动重启后，v2.3.0 机制才在运行态生效（重启后用 dsh_workplan_status 核对版本指纹）。
