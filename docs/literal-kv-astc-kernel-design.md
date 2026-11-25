# 字面 KV Cache 共享 / ASTC 软 Token 压缩：DSH 内核 + 本地推理设计

状态：**设计文档，未实现**。dsh-workplan 3.2.9 只包含插件级等价实现；本文描述要把第 4、5 项做成论文原方法所需的另一套工程，不能随 npm 插件发布，也不应被宣传成“已完成”。

## 一、为什么插件层做不到

dsh-workplan 是 DSH 的 Cordis 插件，能拿到的只有：

- `llm.stream(GenerateOptions)`：provider/model/messages/system/tools 等文本字段；
- `StreamChunk`：text / reasoning / tool-call / block / usage / finish；
- `llm/stream` 瀑布：只能读 `options` 和包 `next()`，主循环请求深冻结，不能改写；
- `subagents.startActivation`：启动子会话，传的是 prompt 文本；
- `systemPrompt`：拼系统提示词。

它拿不到：

- 每层每头的 K/V 张量、attention map、position ids；
- 模型的 GDN/attention 递归状态；
- 把 soft token 注入模型前向的接口。

Latent Briefing 需要逐层逐头求解 C1（高注意力 key 子集）、β（缺失 key 的偏置修正）、C2（ridge regression 重建 value），再把压缩后的 KV 写进 worker 的缓存；ASTC 需要模型自身的循环动态判断“哪些信息已被吸收”，把 soft token 前传。两者都要求**进程内能访问模型内部**，而 DeepSeek API 只返回文本与 usage。所以插件层只能做结构化简报 + 硬事实保留 + 稳定前缀 + 供应商缓存计量（3.2.9 已做），不能做字面 KV/soft token。

## 二、目标架构

```text
┌──────────────────────────────┐
│ DSH Kernel (TypeScript)      │
│  - agent loop                │
│  - subagent orchestration    │
│  - llm service (extended)    │
└──────────────┬───────────────┘
               │ KV handle / soft-token handle (opaque)
┌──────────────▼───────────────┐
│ Local Inference Gateway      │
│  - vLLM / SGLang / custom    │
│  - KV export/import          │
│  - Attention Matching        │
│  - ASTC compressor           │
└──────────────┬───────────────┘
               │ tensors
┌──────────────▼───────────────┐
│ Local Model (weights on GPU) │
│  - Qwen3-14B (Latent Brief)  │
│  - GDN-attention model (ASTC)│
└──────────────────────────────┘
```

三条硬要求：

1. **本地推理**：模型权重在本机/受控 GPU 上，进程能读每层 K/V；
2. **内核接口**：DSH 的 llm 服务与 agent loop 支持“缓存句柄”的导出/导入/传递；
3. **按架构适配**：Latent Briefing 适配标准 attention（如 Qwen3），ASTC 适配 GDN+attention 混合架构；不是所有模型都能用同一套。

## 三、DSH 内核需要改什么

### 3.1 扩展 GenerateOptions

```ts
interface GenerateOptions {
  // 既有字段不变
  provider: string
  model: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  // 新增（可选）
  kvCache?: {
    mode: 'none' | 'reuse' | 'export'
    handle?: string          // 不透明句柄，内核不解析张量
    compaction?: 'none' | 'attention-matching' | 'astc'
    budgetTokens?: number
  }
  softTokens?: {
    handle?: string          // ASTC 产出的软 token 句柄
    positions?: number[]
  }
}
```

### 3.2 StreamChunk 增加句柄事件

```ts
type StreamChunk =
  | { type: 'kv-cache'; handle: string; tokens: number; layers: number }
  | { type: 'soft-token'; handle: string; tokens: number }
  | ...既有块
```

句柄是**不透明字符串**，由推理网关签发；DSH 内核只负责保存/传递/过期，不接触张量，避免内核被模型细节污染。

### 3.3 Agent loop

- 每个 agent/session 记录自己的 `kvHandle`；
- 主 Agent 派生子 Agent 时，把“允许共享的父轨迹句柄”放进 `SubagentActivationSpec.contextHandle`；
- 子 Agent 首次调用模型时，网关按 `contextHandle` 做 Attention Matching，生成 worker 的 KV；
- 子 Agent 结束后句柄按 TTL 释放；
- 跨用户/跨租户禁止共享；句柄必须绑定 session/tenant 并签名。

### 3.4 推理网关接口（建议）

```ts
interface KvGateway {
  export(sessionId: string): Promise<{ handle: string; tokens: number; layers: number }>
  compact(input: {
    handle: string
    query: string
    budgetTokens: number
    method: 'attention-matching'
  }): Promise<{ handle: string; tokens: number; keptKeys: number }>
  import(handle: string, targetSessionId: string): Promise<void>
  release(handle: string): Promise<void>
}

interface SoftTokenGateway {
  compress(input: {
    handle: string
    budgetTokens: number
    method: 'astc'
  }): Promise<{ handle: string; softTokens: number; hardTokens: number }>
}
```

### 3.5 与 dsh-workplan 的衔接

dsh-workplan 仍只负责“决定谁在什么时候需要哪段上下文”，把结构化简报作为 fallback；当内核提供 `kvCache` 能力时，插件可以把 `contextHandle` 传给子代理，而不是把简报文本塞进 prompt。这样插件不需要改模型层，内核也不需要知道 workplan 的业务语义。

## 四、Latent Briefing 的落地步骤

### 4.1 单模型、单会话 KV 导出/导入

- 在本地 vLLM/SGLang 上启用 KV cache 导出（或自定义 runner 读 `past_key_values`）；
- 验证导出→清空→导入后，同一 prompt 的 logits 与未清空时一致（容差内）；
- 记录 KV 大小/层数/头数/显存占用。

### 4.2 Attention Matching 压缩

- 对每一层每一头，取当前 query 的 attention 分布；
- 选 C1：高注意力 key 子集；
- 估 β：缺失 key 的偏置修正；
- 解 C2：ridge regression 重建 value；
- 写回 worker 的 KV cache；
- 验证压缩后任务准确率、token 节省、延迟。

Qwen3-14B 参考规模：40 层 × 8 KV 头 = 320 次串行求解；需要 GPU 显存与求解时间预算。

### 4.3 编排器→worker 传递

- 主 Agent 轨迹 → 压缩句柄 → 子 Agent 首次请求；
- 子 Agent 只读压缩后的 KV，不重放全文；
- 子 Agent 自己的新 KV 可继续导出，形成链式传递；
- 失败回退：句柄失效/显存不足时，回退到文本简报（3.2.9 的等价实现）。

## 五、ASTC 的落地步骤

### 5.1 模型要求

- 需要 GDN（Gated Delta Network）+ attention 混合架构，或能暴露递归状态的模型；
- 需要训练-free 的“已吸收”判定：利用模型自身循环动态，不额外训练压缩器；
- 需要能插入 soft token 的前向接口。

### 5.2 压缩流程

1. 前向过程中记录每个 token 的“吸收分数”；
2. 已吸收内容 → soft token（连续向量），未吸收/精确值 → hard token 原样保留；
3. 压缩后的序列继续前向，后部层计算量下降，形成可复用 KV；
4. 输出仍由原模型解 token，保证可读性。

### 5.3 验收

- 长程任务准确率不低于未压缩基线；
- 端到端 attention 对数量下降（论文报告最多 -50.68%）；
- 每成功任务的额外开销远低于训练式压缩器（论文报告 15.4–103.7 倍优势）；
- 硬事实（数字/路径/哈希）逐字保留。

## 六、工程阶段与交付物

| 阶段 | 交付物 | 退出条件 |
|---|---|---|
| P0 可行性 | 本地推理跑通、KV 导出/导入 demo | 同 prompt logits 一致（容差内） |
| P1 单会话 KV 复用 | 网关 `export/import/release` | 跨请求复用成功，显存可控 |
| P2 Latent Briefing | Attention Matching + 子代理传递 | 准确率不降、token/延迟有收益 |
| P3 ASTC | 软 token 压缩 + 硬 token 保留 | 长程准确率不降、attention 对下降 |
| P4 内核集成 | DSH llm/subagent 句柄接口 | 插件可透明使用，失败可回退 |
| P5 评测与加固 | 基准、隔离、TTL、审计 | 安全评审通过 |

## 七、风险与约束

1. **硬件**：需要本地 GPU、模型权重、推理服务；当前机器不具备，不能在本轮实现。
2. **模型绑定**：KV 结构与模型架构/版本强绑定，升级模型要重做适配；不能跨模型共享。
3. **安全**：KV 可能包含用户隐私；句柄必须绑定租户/会话、加密/签名、TTL、禁止跨用户复用。
4. **一致性**：压缩后的 KV 可能改变输出；必须有“回退到文本简报/全文”的安全阀，且不能静默降级。
5. **成本**：Attention Matching 需要逐层逐头求解；Qwen3-14B 320 次串行求解可能比文本摘要更贵，必须用真实任务基准判定是否值得。
6. **可移植性**：远程 API（DeepSeek 官方）不提供 KV/soft token，字面方案只适用于自建推理；插件必须保留文本路径。

## 八、与 3.2.9 的关系

- 3.2.9 提供：执行通道判定、专家角色上下文包、RCR 路由、软硬压缩、稳定前缀、缓存计量；
- 本文提供：字面 KV/ASTC 的内核与推理层设计，**不包含实现代码**；
- 两者的接口预留：插件的 `contextPacket` 是文本 fallback；未来内核提供 `contextHandle` 时，插件可在同一决策点优先用句柄，失败回退文本，不需要重写业务逻辑。

## 九、结论

字面 KV Cache 共享与模型内 soft token 压缩不是“再改改插件”能完成的：它需要 DSH 内核、 本地推理网关、模型权重与 GPU 三件套，并且要按模型架构做适配。3.2.9 选择诚实的插件级等价实现，并把字面方案的设计、阶段、风险写清楚；在硬件与内核条件具备前，不应声称已完成。
