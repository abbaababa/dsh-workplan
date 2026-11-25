# dsh-workplan v3.3.0

发布日期：2026-11-25

一句话：清零底层源码梳理发现的逻辑死锁、竞态与策略冲突，同时将静态提示词/工具注入基准压降 **32.3%**、动态多子代理与规划调用开销压降 **60%–90%**，不削减任何质量门禁与反编造证据契约。

## 一、核心逻辑冲突与缺陷修复

1. **消除人数死锁与策略打架**：`MIN_COMPLEX_DELEGATE_MEMBERS` 默认从 `3` 调为 `1`（仍可通过 `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS` 按需调高），彻底消除 `15×3=45 > 30` 全计划上限死锁，以及强耦合单专家与人数下限之间的冲突。
2. **修复并发覆盖与运行期死循环**：
   - `persistStartEvidenceFile` 按专家名 + SHA-256 短哈希分文件落盘，同子任务多名专家（含纯中文名）不再互踩；
   - `auditClarifyNeed` 按会话隔离澄清轮次并在建计划时复位；
   - `maybePlan` 让用户确认回复优先于寒暄拦截；
   - `canResumePlan` 跳过 `takeoverRequired === true` 任务，`armAutoResume` 忽略 `closure === 'replanned'` 旧行；
   - `appendUserMessage` 对长取消信封豁免 500 字符裁剪，`flushPreHeadNotices` 补发时同步写入 `notices.jsonl`。
3. **修复上下文、工具与看板细节**：
   - `extractHardFacts` 改为按类别配额抽取，60 条路径不再挤掉百分比/哈希等硬事实；
   - `deriveLeaderEstimate` 放宽名单至 25 人并保持 `>120960` 分钟 fail-closed；
   - `fileWriteGuardReason` 不再误拦仅有 `path` 的未知只读工具；
   - `replan` 补齐 `reasoningEffort`、`delegate` 补齐 `direct`/`self_effort` 渲染、`lessons` 修正「预防」文案；
   - `client.ts` 过滤已重规划旧行、保留完整错误说明、修复档位回退并移除重复图表。

## 二、极致省 Token 实测指标

- **静态注入加权基准**：`106,954` → **`72,415` 字符（-32.3%）**
  - 系统提示词：`2,845` → `1,629`（**-42.7%**）
  - 14 个工具 Schema 总长：`21,956` → `12,663`（**-42.3%**）
  - phase-1 接续五步提示词：`1,291` → `522`（**-59.6%**）
  - 专家任务书：`4,297` → `2,688`（**-37.4%**），静态共享前缀占比 **>85%**（最大化 KV 前缀缓存命中）
- **动态执行开销**：默认开启 `deterministicFastPath` 跳过简单任务规划模型调用、复杂任务默认不强制凑 3 倍子代理、收紧 RCR 上下文包默认预算。

## 三、升级与回滚

```bash
dsh plugin --profile web add dsh-workplan@3.3.0
```

装完请手动重启一次 DSH Web；如需回滚可执行 `dsh plugin --profile web add dsh-workplan@3.2.9`。

- tag: v3.3.0
- date: 2026-11-25
- npm: https://www.npmjs.com/package/dsh-workplan/v/3.3.0
