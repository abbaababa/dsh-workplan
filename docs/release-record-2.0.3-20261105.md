# Release record — dsh-workplan 2.0.3 (2026-11-05)

## 1. 变更主题

修复官方 DeepSeek Harness「`/goal` 目标指令」导致自动任务分解永不触发的缺陷。

根因证据链：

1. `/goal <objective>` 只写 goal 领域状态，不产生 `user/message`（`@deepseek-ai/dsh-command-goal` create 分支）。
2. goal 自动续跑轮次由 `@deepseek-ai/dsh-goal-round-driver` 以 `source.kind = 'goal'`、`round >= 1` 的 user 消息送达（`renderGoalRoundPrompt` + `createUserMessage`）。
3. 2.0.2 的 `src/runtime.ts#humanMessages` 只接受 `source.kind === 'user'` 或省略的消息。
4. `src/runtime.ts#maybePlan` 在 `human.length === 0` 时直接返回。

修复：`goalRoundPlanningTask()` 接受 goal 第一轮；进行中计划存在时不抢跑；任务文本优先取 `goals` 服务 objective，其次解析 `<goal_round>` 信封，最后用原文。

## 2. 版本与提交

| 项目 | 值 |
|---|---|
| package.json version | 2.0.3 |
| meta.version（src/host.ts） | 2.0.3 |
| git commit | 7e25f07 |
| git tag | v2.0.3 |

## 3. 验证

- `npm run check`：退出码 0（tsc --noEmit）。
- `npm test`：553 条用例全过（含新增 `tests/goal-round-planning.test.ts` 7 条）。
- `npm run build`：`lib/`、`dist/`、`client.js` 与 `src/` 同步；`lib/host.js` 内 version 为 2.0.3。

## 4. 发布渠道

| 渠道 | 状态 | 证据 |
|---|---|---|
| npm | 已发布 | `npm view dsh-workplan@latest version` → 2.0.3 |
| GitHub Release | 已发布 | https://github.com/abbaababa/dsh-workplan/releases/tag/v2.0.3 |
| Release 制品 | 已上传 | `dsh-workplan-2.0.3.tgz` sha256 `e6bdb13f31fde51f7a370abea5f1f734f32d35fd4b8ed7431aae21468dda50df`（本地与下载一致） |
| 索引源（awesome-dsh-plugin → dsh-plugin-catalog） | PR 待合并 | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12316（tarball 已指向 v2.0.3；catalog npm 发版由上游 CI 触发） |

## 5. 复验命令

```bash
npm view dsh-workplan@latest version
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://github.com/abbaababa/dsh-workplan/releases/download/v2.0.3/dsh-workplan-2.0.3.tgz
curl -s https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/data/plugins/abbaababa__dsh-workplan.yml | grep tarball
```
