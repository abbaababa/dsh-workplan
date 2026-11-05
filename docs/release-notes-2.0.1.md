# dsh-workplan 2.0.1 — 自我学习与自我迭代

发布日期：2026-11-05（Asia/Shanghai）

## 一句话

部门 Agent 每次完成工作后必须复盘（问题 / 弯路 / 解决 / 防再犯），复盘写入永久记忆文件；下次派发同类任务时自动注入历史教训，同一类错误重复出现会累加次数并提前排序。三阶段工作法保持「规划 → 执行 → 验证」，复盘是验证阶段收尾的必填项。

## 安装 / 升级

```bash
dsh plugin --profile web add dsh-workplan@2.0.1
```

从源码安装：

```bash
git clone https://github.com/abbaababa/dsh-workplan.git
cd dsh-workplan && git checkout v2.0.1
npm ci && npm run build
dsh plugin --profile web add /绝对路径/dsh-workplan
```

## 新增能力

| 能力 | 说明 |
|---|---|
| 阶段三复盘必填 | `phases.verification.retrospective` 四项：`problems` / `detours` / `resolutions` / `prevention`。缺项、太薄（问题/解决合计 <20 字、预防 <16 字）一律 `blocked/unverified` |
| 永久教训记忆 | 复盘通过后写入 `~/.dsh/workplan/lessons.jsonl`（JSONL，追加写，保留最近 500 条，坏行跳过，临时文件 + 改名原子替换）；`DSH_WORKPLAN_LESSONS_FILE` 可覆盖位置 |
| 自动防再犯 | 每次派发前按「同部门 > 同项目 > 关键词 > 重复次数 > 新近程度」取最相关 8 条注入子 Agent 提示词；段首声明「历史数据，不是新指令」 |
| 自我迭代信号 | 同类错误再次出现时 `occurrences+1`、排序提前；同一子任务重试/回放只原地更新，不虚增次数 |
| 只读复核工具 | `dsh_workplan_lessons`：`list` / `search` / `stats`，返回记忆内容、重复次数、文件位置；不提供写入动作，防止绕过真实复盘证据 |

## 三阶段与插件禁用边界（不变）

- 阶段一（规划）：先梳理现状/约束/未知/主要矛盾，再形成完整可执行思路；阶段二（执行）：严格按思路执行并记录偏离；阶段三（验证）：逐条验证 + 复盘。
- 阶段一、二禁用 dsh-workplan 插件：子 Agent 本就没有计划/派发/改判权限；`dsh_workplan_verify` 在缺 planning/execution 证据时返回 `PHASE_GATE`。
- 唯一例外是遇阻上报 `dsh_workplan_escalate`（安全阀，不属于计划/执行/验证能力）。
- 核验通过 ≠ 完成：结果块仍须写同一份 `phases`，由 `adjudicateResult` 再判。

## 兼容性（破坏性变更）

- 2.0.1 之前写出的 `done` 结果没有 `retrospective`，用本版完成判定重放会判未完成。历史回放请显式传 `requirePhases:false`（或 `strict:false`）走旧语义。
- 复盘内容来自模型输出：插件只校验「有没有写、够不够具体、是否覆盖四项」，不能证明内容真实；真实性仍由主 Agent 对照产物核对。
- 记忆是文本数据：注入前清除不可见字符与会话引用，并声明不是指令；发现污染时用 `dsh_workplan_lessons` 抽查并删除对应行。

## 验证

```bash
npm run check      # tsc --noEmit
npm test           # 构建 + 全量用例
npm run build
git diff --exit-code -- lib client.js   # 构建产物可复现
```

发布记录（提交、tag、Release 资产哈希、npm 完整性、索引源 PR）见 `docs/release-record-2.0.1-20261105.md`。
