# v1.7.0 — 协作契约版

这是 **dsh-workplan** 自 1.6.0 以来最大的一次协作语义升级。1.6.0 让「这一轮到底有没有在跑」变准；
1.7.0 让「派出去的部门到底做了什么、凭什么算做完、改判以谁为准」有了机器可核对的答案。

## 装这一版

```bash
dsh plugin --profile web add dsh-workplan@1.7.0
```

装完重启 DSH Web（或重新载入页面）。要求 Node.js 22+，无第三方运行时依赖。

## 你直接能感觉到的变化

- **派发不再让主 Agent 干等。** `dsh_workplan_dispatch` 支持 `mode:"async"` 立刻返回，后台继续跑；
  随时用新的只读工具 `dsh_workplan_status` 问「做到哪了」——刷新页面、重启进程后依然答得出。
- **「假完成」被堵住。** 子 Agent 要在输出末尾回传结构化证据（验收逐条结果、产物、协作需求）。
  只完成一半、验收有失败、证据块坏了，都判受阻；只有全部通过才直接采信。结果消息会单独列出
  「未验证」「自检失败」「声明产物缺失」，主 Agent 不会再把半成品当完成。
- **产物不存在就不解锁下游。** 声明为文件的产物会被逐个核实，缺失的写进计划，下游明确停在
  「上游 T1「产出接口清单」受阻，缺失 docs/api.md」这种可执行的信息上。
- **改判不会互相覆盖。** 运行中的子任务默认拒绝改判（`TASK_RUNNING`）；基于旧状态的写入返回
  `STALE_WRITE`；人工改判会落盘，刷新后仍在。
- **跨部门不再只能靠猜。** 每个子 Agent 都能看到兄弟部门的只读一览（谁、做什么、产出什么、已完成摘要），
  需要协作就写 `needs`，结果消息汇总成「跨部门待转达」交给主 Agent 逐条处理。

## 兼容性

旧会话不需要迁移：没有证据块的旧结果按 `legacy` 读作「完成但未验证」，并提示主 Agent 复核。
`strict: false`、`artifactGate: false` 两条回滚通道保留旧判定。`PLAN_VERSION` 仍为 1，
`dispatch` 默认仍是 `wait`，既有调用行为不变。

## 质量

- 180 个测试全绿（`npm test`），新增 7 个测试文件覆盖证据契约、派发模式、写保护、产物门禁、
  跨部门 brief、重试回灌与工具 schema。
- `npm run check` 通过；`lib/` 与 `client.js` 由构建生成并入库，可用 `npm run build && git diff --exit-code` 复现。
- 完整变更：[CHANGELOG.md](https://github.com/abbaababa/dsh-workplan/blob/main/CHANGELOG.md)；
  发布流程：[RELEASING.md](https://github.com/abbaababa/dsh-workplan/blob/main/RELEASING.md)。

## 文档

- [协作契约](https://github.com/abbaababa/dsh-workplan/blob/main/docs/collaboration.md) — 角色、数据契约、状态机、失败恢复、写者所有权
- [部门职责与交接](https://github.com/abbaababa/dsh-workplan/blob/main/docs/departments.md) — 12 个部门的边界与逐部门交接清单
- [协作机制审查](https://github.com/abbaababa/dsh-workplan/blob/main/docs/review-collaboration-20261030.md) — 17 条断点的证据
