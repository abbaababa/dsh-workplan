# Release record — dsh-workplan 2.1.1 (2026-11-06)

## 1. 变更主题

修复 2.1.0 的三处「说到了但没做到」：

1. **格式退回通知在续跑时送不到部门人员**（功能缺陷，用户要求 2 的「通知」环节断链）。
2. `README.zh.md:72` 的安装命令仍是 `dsh-workplan@1.12.3`（同文件徽章已是新版本，用户会照着装错）。
3. `docs/cc/AGD-OPS-SECURE-OPERATION.md` 安装校验步骤写着「当前 1.12.0」，是唯一一处面向用户的过期「当前版本」陈述。

## 2. 缺陷 1 的根因与修复（治本，不治标）

### 根因（按执行顺序）

| # | 环节 | 2.1.0 的实际行为 |
|---|---|---|
| 1 | 子 Agent 交回不合规结果 | `adjudicateResult` 判 `blocked`，并把 `blockedKind:'comm-format'` + 逐条不合规项写进 `error`（这一步是对的） |
| 2 | 主 Agent 再次派发 | `dispatchPlan` 先调用 `resetBlockedStatuses`，把受阻行连同 `blockedKind` / `error` 一起清成待跑 |
| 3 | `executeSubtask` 想读「上次是不是格式退回」 | 信息已被第 2 步清掉，`lastFailure` 恒为 `null` |
| 4 | 结果 | 第 2 次激活的提示词与第 1 次逐字相同（实测均 4374 字符），子 Agent 不知道要改哪几条格式，只能把同样的错误再交一遍 → 退回只剩状态行一个记号 |

### 修复（`src/runtime.ts`，两处）

- `dispatchPlan`：在 `resetBlockedStatuses` **之前**扫描 `blockedKind === 'comm-format'` 的行，把退回原因抄进本轮的 `record.commFormatRejections`。
- `executeSubtask`：行内 `blockedKind` 已被清掉时改读这份记录，构造 `{attempt:1, code:'COMM_FORMAT_REJECTED', message:退回原因}` 交给 `buildChildPrompt` 的 `previousFailure`；消费一次即删，避免后续无关重试重复带上。

### 修复证据

- 端到端探针（真实 `createWorkplanRuntime` + 假子会话，2 轮）：
  - 第 1 轮：`status=blocked`、`blockedKind=comm-format`、`error` 点名 F4；
  - 第 2 轮：`status=done`、`blockedKind=null`；
  - 第 2 次激活提示词含「上一次尝试失败」段、`COMM_FORMAT_REJECTED`、逐条不合规项；长度 4374 → 4584。
- 新增 `tests/workplan-comm-format-e2e.test.ts`（2 条）把上述断言固化：不合规 → 退回不计完成、合规 → 通过、第 2 次激活必须带退回段与失败类型。

## 3. 另两处修正的判据

- `README.zh.md:72`：`dsh-workplan@1.12.3` → `dsh-workplan@2.1.1`。漏检原因：`tests/version-sync.test.ts` 只校验 `README.md` 与 `README.en.md`，不校验中文 README——这是测试覆盖面缺口，本次未扩大该测试（避免超范围改动）。
- `docs/cc/AGD-OPS-SECURE-OPERATION.md`：删除「当前 1.12.0」的过期断言，改为「与 README 徽章一致的最新版本号」；文首补一条带日期的版本说明，声明正文其余 1.12.0 是 v1.12.0 评估快照，不改写历史。**未**批量替换 31 处 1.12.0：那些是带日期的历史证据，改写会伪造评估记录。

## 4. 版本与提交

| 项目 | 值 |
|---|---|
| package.json version | 2.1.1 |
| meta.version（src/host.ts） | 2.1.1 |
| git commit | d3a3b32 |
| git tag | v2.1.1 |
| 远程 | `git@github.com:abbaababa/dsh-workplan.git`（main） |

版本同步点：`package.json`、`package-lock.json` 两处、`src/host.ts`、`tests/fixtures/tool-surface.json`、README 三语（徽章 + 安装命令）、CHANGELOG 的 `## 2.1.1 — 2026-11-06`。

## 5. 验证

- `npm run check`（tsc -p tsconfig.json --noEmit）：退出码 0。
- `npm test`：tests 580 / pass 580 / fail 0（2.1.0 为 578；新增 e2e 文件 2 条）。
- `npm run build`：`lib/host.js` 内 `version: '2.1.1'`，`lib/runtime.js` 含本次修复。

## 6. 发布渠道（均已核验）

| 渠道 | 状态 | 证据 |
|---|---|---|
| npm | 已发布 | registry 原始元数据 `dist-tags.latest = 2.1.1`，`versions` 列表含 `2.1.1`；`https://registry.npmjs.org/-/package/dsh-workplan/dist-tags` → `{"latest":"2.1.1"}` |
| GitHub Release | 已发布 | https://github.com/abbaababa/dsh-workplan/releases/tag/v2.1.1 |
| git tag | 已推送 | `git ls-remote --tags origin` → `refs/tags/v2.1.1`（tag 对象 72f5992，peel 到 d3a3b32） |
| Release 制品 | 已上传且校验一致 | `dsh-workplan-2.1.1.tgz`，GitHub 记录 `digest: sha256:9db23eed0c22a8f38b7a2aeef892f1d8277d1469605cf5518577e634f3071d03`，与本机 `npm pack` 复算一致 |
| npm tarball sha1 | 与本地 pack 一致 | `c9a8a627648477a28837583ca388a4f6f673fba4` |

注：npm publish 返回 `202 Accepted`（异步处理），registry 约 4 分钟后才出现 2.1.1；以 registry 原始响应为准，`npm view` 的本地缓存可能更慢。

## 7. 复验命令

```bash
# 1) registry 最新版与版本列表
curl -s https://registry.npmjs.org/dsh-workplan | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j['dist-tags'].latest, Object.keys(j.versions).includes('2.1.1'))})"

# 2) dist-tags
curl -s https://registry.npmjs.org/-/package/dsh-workplan/dist-tags

# 3) 远程 tag
git ls-remote --tags origin | grep v2.1.1

# 4) 制品摘要（GitHub 侧记录）
gh release view v2.1.1 --json assets | grep -o 'sha256:[0-9a-f]*'

# 5) 本地复现
cd /Users/open/Documents/Stocks/plugins/dsh-workplan
npm run check && npm test
```

## 8. 回滚方案

- 代码：`git revert d3a3b32` 并推送；撤销 tag：`git tag -d v2.1.1 && git push origin :refs/tags/v2.1.1`。
- npm：发布 72 小时内可 `npm unpublish dsh-workplan@2.1.1`；超时则 `npm deprecate dsh-workplan@2.1.1 "请升级到修复版本"` 并另发修复版。
- 用户侧：可回退到 `dsh-workplan@2.1.0`，但请注意 2.1.0 存在「退回通知送不到」的缺陷。

## 9. 已知问题（如实记录，未解决）

本次会话里 dsh-workplan 自己的自动任务分解（部门子 Agent 调度）持续不可靠：

- 计划 `wp-b7750256`（10 项）：全部 blocked，错误 `cannot get required service "subagents" in inactive context` / `子 Agent 结束状态为 error`。
- 计划 `wp-80e484d9`（9 项）：3 项 done、6 项 blocked（T4/T5 子 Agent 结束状态为 error，其余为上游级联），并留下一条跨部门需求 H1（docs/cc 版本锚点同步）。
- 计划 `wp-295e0e44`（5 项）：本轮执行中。

这些子 Agent 的产物中有真实可用的部分（T1 变更盘点、T2 测试复核、T3 版本引用清单、T4 的 e2e 测试文件），主 Agent 已逐项核对后并入 2.1.1；但调度链路本身的失败原因（`subagents` 服务在 inactive context 取不到、子 Agent 频繁以 error 结束）属于运行环境/宿主层问题，本次未修复，需单独排查。**不得**把上述计划读作「已完成」。
