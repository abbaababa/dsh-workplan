# 发布记录 — dsh-workplan 2.3.2（2026-11-10）

## 本次内容（三个缺陷治理，均未单独上线 2.3.1）
- **D1 用户附件全链路可见**（commit 8b48796）：用户消息的 image/file/document 块在 messageText 处被整块丢弃，规划器/子 Agent 看不见附件 → 专家被迫请示往返。现渲染为含 attachment-id 的标注行，taskText→锚点→派发提示→回放上下文同源覆盖；附防误伤零回归断言。
- **D2 规划器 JSON 三层兜底**（commit b49a395，T1 诊断/T2 实现/T3 两轮独立复核）：
  - P0 `repairJsonStructure` 扩能：字符串外补缺失逗号、全角标点归一、栈空多余闭括号丢弃——六类高频损伤（漏逗号/全角逗号/全角引号/多余闭合等）本地修复，不再进入 3×29s 全量盲掷；
  - P1 `parseFailureHint`：不可本地修复时抛错携带「错误位置 + 断点±60 原文 + 只修该处语法禁改值」，经 lastErrors 定向回喂下一次请求；
  - P2 buildPlannerPrompt 加半角标点/成员逗号/括号成对自检硬约束。
  - **生产实证**：本次重启后首轮自动分解第 1 次尝试 INVALID_JSON（Bad escaped character at 2812），P1 反馈格式出现、第 2 次带反馈重掷即出计划（旧行为为 3 次全挂降级）。
- **QA-1 值篡改红线**（随 b49a395）：既有 `stripTrailingCommas` 正则不感知字符串边界、会吃掉值内 `", }"`——改字符串边界感知，探针 TAMPER-3 转绿并加回归锁。

## 验证证据（命令级）
- 静态检查：tsc --noEmit 零错误；npm run build exit 0。
- 全量回归：**724 pass / 0 fail / 0 cancelled / exit 0**（基线 718+5+1：[2.3.2] D2 五条 + QA-1 锁；主 Agent 与 T3 专家双通道各实测一遍：723（QA-1 前）与 724（QA-1 后））。
- 产物同源：干净检出 clone 自 tag 构建打包；T3 双构建哈希逐字节一致（lib/plan.js 480f0bc9…）。
- 版本一致性：version-sync 门禁通过（package.json/lock×2/src/host.ts/lib/fixtures/README×3=2.3.2）。

## 发布链路（RELEASING.md §0–§7）
- commit `bd95cbd`「Release 2.3.2」→ origin/main；tag `v2.3.2`（注解 tag，解引用=bd95cbd）。
- GitHub Release：https://github.com/abbaababa/dsh-workplan/releases/tag/v2.3.2 ；制品 dsh-workplan-2.3.2.tgz **sha256=dfbf533b3da364e658d384c31aaf2aab8318f3a74f3c8c2ff24caf6bd7b10e21**（tag 干净检出 npm ci+build+pack），下载校验 HTTP 200。
- npm 索引源：`+ dsh-workplan@2.3.2` 发布成功；npm view 2.3.2=2.3.2、dist-tags.latest=2.3.2（传播后两次实测一致）。
- 上游条目源（awesome-dsh-plugin）：PR #13893 分支 bump229 更新至 tarball 指 v2.3.2（git 直推；注：昨日 API PUT 的提交曾被分支重置覆盖，本次经 ls-remote 权威头 81f3639b 核实后重推，推送结果见会话记录）。合并权在上游（RELEASING §5 边界），合并后 CI 自动发 dsh-plugin-catalog。

## 运行态生效
本机需用户手工重启 DSH 后加载 2.3.2 字节（发布前进程为 21:0x 启动、已含 D1+D2 代码）。核对方式：dsh_workplan_status 应回显 v2.3.2｜新 build 指纹。
