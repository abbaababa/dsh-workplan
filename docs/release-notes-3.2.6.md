# dsh-workplan 3.2.6 发布说明（2026-11-24）

费用治本版。基线 3.2.5；本版不新增、不删除、不修改任何工具、schema 或行为契约，
只改三个结构性默认值，并在两处补上「不误判」的证据。

## 为什么发这一版（实测依据）

会话 `session-da5b9915-9fcb-4d90-8948-72f7c2c04316`（计划 `wp-2b766146-c360-4644-b677-38c652fa13e2`）：
59 分钟、**32 个会话**（1 主 + 31 子）、**846 次模型调用**、978 次工具调用，累计重发上下文约
**218 MB**（按 2.6 字节/token 折算约 8,000 万输入 token），最终因 `402 Insufficient Balance`
中断，交付物未生成。3.2.3–3.2.5 的省 token 全部是提示词字面量削减（根工具面 −476 字符、
phase-1 简报 −115 字符、重复自查句 −48 字符），相对该账单差三个数量级。

## 改了什么

| 项 | 旧默认 | 新默认 | 覆盖方式 |
| --- | --- | --- | --- |
| `MIN_COMPLEX_DELEGATE_MEMBERS` | 8 | **3** | `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS` |
| `MAX_TOTAL_EXPERTS_PER_PLAN` | 40 | **30** | `DSH_WORKPLAN_MAX_TOTAL_EXPERTS_PER_PLAN` |
| `MAX_COMPLEX_DELEGATE_MEMBERS` | 25 | 25（不变） | `DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS` |
| `DELEGATE_STALL_MS` | 120s | **600s** | `DSH_WORKPLAN_DELEGATE_STALL_SECONDS` |
| `leaderPreRegisterEnabled()` | false | **true** | `DSH_WORKPLAN_LEADER_PRE_REGISTER=0` |

- **人数下限**：每个成员是一次独立计费会话；实测仅 T3 一个子任务就开了 18 个会话（2 负责人 + 16 专家），541 步占全计划 64%。
- **假死判定**：T3 第一波 7 名专家（64 步）在派发 226 秒后被判「子会话已消失超过 120s」并掐断，而它们在被判死后仍继续写记录最长 40 秒（即当时还活着）；随后又开 9 个会话重跑 393 步。本版把阈值提到 600s，并新增 `getAgent(childId)` 活体探针——取到活体执行体即绝不判死。
- **预登记默认开**：让负责人替成员登记 `startPhases` + `timeNotice`，成员免跑 phase-0 评估回合。实测 7 对「评估 + 执行」中评估段 111/382 步（29%），而评估会话产出的可交付文件为 0 个。语义仍 fail-open：负责人没填则该成员照旧走 phase-0。

## 验证

- `npm run build` 通过；`npm test`：**1513 例，pass=1513 / fail=0 / cancelled=0 / todo=1，exit=0**。
- CI（tag `v3.2.6`，run `45412794351`）：Build（Node 22 / 26）、Test（Node 22 / 26）、Release 全部 success，耗时 2m17s。

## 制品与指纹（均已下载复核）

- 提交 `5e44e4c`；Git tag `v3.2.6`（annotated）。
- GitHub Release：`https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.6`
  - 制品 `dsh-workplan-3.2.6.tgz`：2,071,602 字节，sha256 `9ad342402d82a1019f3cb9ab347b5a4cae2ddc23867f07e14a2785c92a522b2a`。
- npm：`dsh-workplan@3.2.6`，`dist-tags.latest = 3.2.6`（2026-11-24T14:26:49Z），
  tarball `https://registry.npmjs.org/dsh-workplan/-/dsh-workplan-3.2.6.tgz`，
  sha1 `a905b9958ea9fab2d14d46d7085a532f26b7eee5`，162 文件 / 6,181,388 字节（解包后）；
  与 GitHub Release 制品字节一致（同为 2,071,602 字节、同一 sha256）。
- 索引源：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18401`
  （原 3.2.5 PR 就地更新为 3.2.6，`tarball` 指向 `v3.2.6`；状态 OPEN，待维护者合并）。
  市场目录 `dsh-plugin-catalog` 最新快照 `2026.1124.26844`（2026-11-24T12:48:42Z）早于本次
  npm 发布（14:26:49Z），故需等下一次目录重建 + 该 PR 合并后，市场条目才会显示 3.2.6。

## 升级方式

```bash
dsh plugin --profile web add dsh-workplan@3.2.6
```

已运行的 DSH 不会自动加载新代码：请**手动重启 DSH**（或在插件管理里禁用再启用）。
重启后在新会话调用 `dsh_workplan_status`，应显示 `v3.2.6`。

## 回退

```bash
DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS=8
DSH_WORKPLAN_DELEGATE_STALL_SECONDS=120
DSH_WORKPLAN_LEADER_PRE_REGISTER=0
```
