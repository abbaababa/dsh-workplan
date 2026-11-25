# 3.2.9 上下文优化架构（五项能力的插件级实现）

本文说明 3.2.9 如何把用户提出的五项上下文优化落进 dsh-workplan 的插件源码，以及每条能力的边界、预算、开关和验收口径。先给结论：

- 第 1、2、3 项是**真实实现**：执行通道判定、子代理上下文隔离、角色条件上下文路由。
- 第 4、5 项是**插件级等价实现**：插件运行在 DSH 的 API 文本层，拿不到模型内部 KV 张量，也不能生成真正的 soft token；所以第 4 项实现为“结构化 Latent Brief + 稳定前缀 + 供应商缓存计量”，第 5 项实现为“硬事实逐字保留 + 软摘要 + 可检索引用”。字面实现需要改 DSH 内核并自建本地推理，另见 `docs/literal-kv-astc-kernel-design.md`。
- 所有新增能力都是增量的：**不加新模型工具、不改计划持久化 schema、旧计划可原样回放**。

## 一、总流程

```text
用户任务
  │
  ├─ 规划器产出计划（不变）
  │
  ├─ 主 Agent / 部门负责人任务书
  │    ├─ context-strategy：判定“拆子代理”还是“主上下文压缩”
  │    ├─ planDelegations：硬闸（顺序链 / 跨源耦合 / 人数 / 质量）
  │    └─ buildChildPrompt：把策略行写进负责人任务书
  │
  ├─ 派发专家
  │    ├─ context-packets：按 expert/execution 组装角色上下文包（phase-0 只做复杂度评估，不注入）
  │    ├─ context-router：按角色、阶段、预算挑选条目
  │    ├─ context-brief：硬事实逐字保留 + 软摘要 + ref 索引
  │    └─ buildDelegateePrompt：任务书 + 上下文包 + 质量要求
  │
  └─ 观测
       ├─ cache-meter：只读 llm/stream 的 usage
       └─ dsh_workplan_status：展示 KV 前缀缓存计量
```

## 二、第 1 项：什么时候拆子代理，什么时候在主上下文压缩

实现文件：`src/context-strategy.ts:97`（`assessIndependence`）、`src/context-strategy.ts:178`（`decideDelegationStrategy`）。

判定信号与权重：

| 信号 | 权重 | 说明 |
|---|---:|---|
| 顺序推理链 | +3 | 先…再 / 逐步 / 基于上一步 / 第 N 步 |
| 跨源矛盾裁决 | +3 | 多来源相互矛盾，需要裁决/统一口径 |
| 单一最终决策 | +3 | 最终决定 / 拍板 / 定稿 |
| 共享可变状态 | +3 | 同一文件/配置/台账并发写 |
| 串行依赖 | +1 | 基于上一步结论、先…再（非链式） |
| 极简单动作 | +1 | 文本很短且无并行/耦合信号 |
| 独立并行 | -2～-4 | 分别/各自/独立/并行/多路 |
| 探索量大 | 0 | 不改变耦合分，只提示先派侦察 |

输出：

- `lane=split`：独立且拟派多人，可以拆；
- `lane=single-expert`：只派 1 名专家一次做完；
- `lane=leader-direct`：强耦合/单线程，负责人亲自执行（`action="direct"`）；
- `contextMode=isolate|compressed-main`：隔离上下文或主上下文压缩。

硬门禁在 `src/llm-rules.ts:361`（`planDelegations`）：顺序链闸之后新增 `DELEGATE_COUPLED_SPLIT`——耦合分 ≥3 且拟派多人时整单拒绝，并给出两条出路：只派 1 名专家一次做完，或负责人 `direct`。该通道同时豁免复杂任务人数下限，避免“1 人被下限拒、多人被耦合闸拒”的无解死锁。

提示词侧：`src/plan.ts:7719`（`buildChildPrompt`）在“当前阶段”之后插入 `【上下文策略｜独立度…｜耦合分…｜信号…】`，与门禁使用同一判定函数，不会出现“提示词说可拆、代码说不能拆”的两套口径。

## 三、第 2 项：子代理上下文隔离

子代理本来就有独立会话；3.2.9 补的是“隔离之后专家仍拿得到完成任务所需的最小充分信息”：

- 探索重的任务在策略行里明确：先派 1 名只读侦察专家，回传 ≤800 字且含精确引用/产物路径的简报；其他专家复用简报，不重复采集。
- 专家上下文包只包含本专家需要的锚点、验收、约束、依赖产物、已完成兄弟摘要、教训、跨部门答复、主 Agent 指示；不把整份计划广播给每个专家。
- 依赖摘要/兄弟摘要统一走软硬压缩，原文仍可按 `ref` 取回；不删除唯一信息。

## 四、第 3 项：RCR 角色条件上下文路由

实现文件：`src/context-router.ts:121`（`routeContext`）。

输入 `ContextItem`：

```ts
{
  id, kind, text,
  role?: 'planner'|'leader'|'expert'|'verifier'|'root'|'*',
  stage?: 'planning'|'preparation'|'execution'|'verification'|'retro'|'*',
  priority?: 'must'|'high'|'normal'|'low',
  relevance?: 0..100,
  ref?, dedupeKey?
}
```

路由顺序：

1. 先按 `role`/`stage` 过滤，不匹配的进 `omitted`（带原因与 ref）；
2. 按 `priority` + 角色/阶段匹配 + `relevance` + 原始顺序打分排序；
3. 去重（`dedupeKey` 或归一化文本）；
4. 在字符预算内选取；`must` 条目永不因预算或条数上限被丢弃，预算不够时允许溢出并记账；
5. 其余条目按 kind 上限/预算省略，只进索引，不删除原文。

渲染：`renderContextOmissions` 只列 `id/kind/reason/ref`，不重复正文，避免二次付费。

## 五、第 4 项：Latent Briefing / KV 前缀缓存（等价实现）

实现文件：`src/context-brief.ts:180`（`compileBrief`）、`src/cache-meter.ts:95`（`createLlmCacheMeter`）、`src/cache-meter.ts:166`（`observeLlmStream`）。

### 5.1 Latent Brief

- 输入若干 `BriefSource{id,text,ref?,absorbed?,hard?}`；
- 句子级切分，硬事实逐字保留，软内容压成摘要；
- 调用方可传 `absorbed:true` 把已被结算吸收的条目只留 `ref`；当前生产路径不自动判定，避免误删唯一信息；
- 同一输入按内容哈希复用编译结果（最多 256 条）；内容哈希、硬/软条目与渲染结果稳定（缓存命中标记不进提示词）；
- 渲染顺序固定：硬事实 → 软摘要 → 可检索引用 → 省略索引。

### 5.2 供应商 KV 前缀缓存计量

- 只读挂载 `llm/stream`：包一层异步迭代器，透传全部块，只在 `usage` 块上累计 `cacheReadTokens/cacheWriteTokens`；
- 绝不二次调用 `next()`、绝不改写深冻结的主循环请求；
- 按会话累计 `calls/inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/hitRate`；命中率分母 = 三者之和（宿主计数互斥，`inputTokens` 是未缓存输入，不能单独当分母）；
- `dsh_workplan_status` 新增 `cache` 字段与一行“KV前缀缓存：调用/输入/缓存读/缓存写/命中”；无 usage 时不显示该行，结构化字段为 0，不虚报；只统计本进程，重启归零；
- `DSH_WORKPLAN_CACHE_METER=0` 可关闭。

**边界**：这不是模型内 KV 共享，插件拿不到 KV 张量；它只证明“稳定前缀 + 复用简报”是否真的命中供应商缓存。命中率低时不应伪造数据，也不应据此改变任务状态。

## 六、第 5 项：ASTC 式软/硬信息压缩（等价实现）

实现文件：`src/context-brief.ts:279`（`condenseText`）。

硬事实判定（确定性词面规则，不调模型）：

- 数字/百分比/日期；
- 文件路径（`/…`、`./…`、`reports/…`、Windows 盘符）；
- 哈希（8 位以上十六进制）、编号（T1/S1/A1/H2/wp-…）；
- 命令（npm/node/git/pnpm/python/curl/grep/rg/sed/awk/tsc/dsh）；
- 错误码/大写常量；
- 约束原句（必须/不得/禁止/至少/最多/逐字/精确）。

压缩规则：

- 硬事实优先逐字保留：单句≤600 字、总量≤max(600,预算)；超出时退到精确值清单（路径/哈希/编号/命令/数字/约束原句）+ ref，行内摘要严格守预算；
- 软内容按剩余预算保留，每条最多 180 字；
- 被吸收/重复/超预算的内容只留 `id/ref`（软句超预算也带来源 ref）；
- `dependencyResultBrief` 从“直接截断 800 字”改为“硬事实优先 + 软摘要 + 原文引用”，避免把唯一产物路径从中间截断；
- 兄弟 done 摘要同样走 `condenseText(...,80)`。

## 七、集成点与预算

| 位置 | 变化 | 预算/默认 |
|---|---|---|
| `src/plan.ts:7707 dependencyResultBrief` | 软硬压缩替代直接截断 | 严格 ≤800 字；硬事实超限退精确值清单+ref |
| `src/plan.ts` 兄弟 done 摘要 | `condenseText(...,80)` | 80 字 |
| `src/plan.ts:7719 buildChildPrompt` | 插入上下文策略行 | 不额外增预算 |
| `src/llm-rules.ts:361 planDelegations` | 新增耦合拆分硬闸 + `contextStrategy` 返回 | 无预算 |
| `src/llm-rules.ts:710 buildDelegateePrompt` | 新增 `contextPacket` | 由包预算控制 |
| `src/context-packets.ts:47 buildExpertContextPacket` | expert 角色包 | execution 3200 字；phase-0 不注入 |
| `src/runtime.ts:9400 statusTool` | 新增根/负责人/专家 `cache` 汇总 | 只读；按互斥计数求命中率 |
| `src/host.ts`（`PLUGIN_VERSION` / `observeLlmStream` 挂载 / status 展示） | 版本 3.2.9；挂载缓存计量；status 展示 | 可用环境变量关闭 |

## 八、红线与一致性约束

1. **不删除唯一信息**：must 条目不因预算丢弃；省略条目必须有 `ref` 或明确 id；原文仍在计划/状态/产物中。
2. **不伪造**：缓存命中率只来自供应商真实 usage；没有字段就是 0；不声称已实现模型内 KV/soft token。
3. **不双口径**：提示词与硬闸共用 `decideDelegationStrategy`；专家上下文包与任务书质量要求不重复。
4. **确定性**：同一输入的路由/压缩/哈希输出稳定，便于测试与缓存复用。
5. **回放兼容**：不改计划 schema；`contextStrategy` 是可选返回字段；旧计划没有上下文包时任务书逐字不变。
6. **fail-open**：缓存计量挂载失败、教训读取失败、上下文包构建异常都不阻断派发。

## 九、开关

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `DSH_WORKPLAN_CACHE_METER=0` | 关闭 llm/stream 缓存计量 | 开启 |
| `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS` | 复杂任务人数下限（既有） | 3 |
| `DSH_WORKPLAN_MAX_COMPLEX_DELEGATE_MEMBERS` | 复杂任务人数上限（既有） | 25 |
| `DSH_WORKPLAN_LEADER_PRE_REGISTER=0` | 关闭负责人预登记（既有） | 开启 |

## 十、验证

- `npm run check`：类型检查通过。
- `npm test`：1541 例，1540 通过 / 0 失败 / 1 todo；新增 5 个测试文件覆盖耦合闸、RCR、硬事实、缓存计量与端到端任务书。
- 构建产物：`lib/` 与 `client.js` 由 `npm run build` 重新生成并提交，CI 会断言工作区无差异。
- 运行态：用户重启后，`dsh_workplan_status` 应显示 `v3.2.9` 与构建哈希；面板进度正常；有真实调用后出现“KV前缀缓存”一行。
