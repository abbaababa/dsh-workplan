# dsh-workplan 进度区图表化设计（T3）

- 日期：2026-10-28
- 角色：设计部门 T3（交互 / 视觉设计）
- 目标版本：**1.5.0**（沿用 T4 的版本方案）
- 状态：**设计稿，未改任何源码**；Q1–Q3 仍待用户确认，本文按 T2 推荐口径设计，并给出变更影响
- 上游：[T1 定位报告](./progress-visualization-locate-20261028.md)、[T2 澄清清单](./progress-visualization-clarify-20261028.md)
- 约束来源：[视觉精修规范](./visual-refinement-spec.md)、[1.5.0 版本升级与回滚](./version-upgrade-rollback-1.5.0-20261028.md)

---

## 0. 一句话方案

把折叠卡里「只写在 `title` 属性里的 0% + 54×5px、0% 时完全不可见的迷你条」替换为 **常驻图表区**：

> **44px 环形图 + 24px 百分比 + 「本计划 X/Y 做好了」+ 当前步骤一行 + 8px 四段构成条 + 11px 状态图例 + 6px 阶段步进条**

展开后再增加 **「分步进度」** 明细（每阶段一条 4px 进度条 + 状态文字）。0% 时构成条不是空的（「还没开始」段铺满整条），环轨加粗、阶段块用虚线槽 + 当前阶段描边，因此「0%」本身也能被看见，而不是一片空白。

---

## 1. 前置确认与设计假设

### 1.1 假设（来自 T2 推荐口径）

| 编号 | 假设 | 若用户改答，对本设计的影响 |
|---|---|---|
| Q1 | 三处红圈 = ①卡片 meta 行、②组头摘要、③空组「0/0 + 完成率暂无数据」 | 若 Q1=否，目标区域变化，本方案需重做 |
| Q2 | **2C：比例 + 当前在做什么** | 若 2A（只看比例）：删掉「当前步骤」一行，卡片高度 −18px；若 2B：把大百分比降为 16px |
| Q3 | **3A：只升级折叠头，图表仍留在两组之后** | 若 3B/3C：本方案卡片部分不变，只需把同一图表组件再放进总览区；若 3B 同时移除两组之后的图表，需另评估 `client-render.test.ts` |
| Q4 | **4A：内联 SVG**（环形图用 SVG，构成条/步进条用 CSS，不引入 canvas 图表） | 若 4B：需新增 Chart.js 实例与销毁逻辑，测试方式改为 canvas 快照，不建议 |
| Q5 | **5A：空组不再渲染摘要句** | 本设计细化为「只删文字摘要，保留 `—` 环」，见 §7.6 |
| Q6 | **1.5.0，顶部统计条不动** | 若 1.4.4：只改 `package.json` 版本策略，不影响视觉 |

### 1.2 本设计对 T2 的两处细化（需在实现时同步测试）

1. **blocked = 0 时不再渲染「0 卡住了」徽章**。该数字由新的状态图例「卡住了 0」承担；红色徽章只在 blocked > 0 时出现，避免「0 也红」的噪声。因此 `tests/session-collapse.test.ts:298` 的 `0 卡住了` 断言需改为图例文本 `卡住了 0`。
2. **卡片迷你条从 54×5px 改为「整行宽 × 8px」**。54px 宽在 0% 时无法充当图表；整行宽才能承载四段构成与阶段色块。此数值与 `docs/visual-refinement-spec.md` §2 的「56×4 四段」目标不同，需在该文档 §2 增加一条 1.5.0 例外说明（见 §12.2）。测试锁定的 `.dsh-wp-mini-fill--done { background: var(--dsh-wp-done) }` **保持不变**，`tests/status-colors.test.ts` 无需改动。

### 1.3 本设计不做

- 不改服务端：`src/runtime.ts`、`src/plan.ts`、`src/host.ts`（除 T4 的 `meta.version`）零改动。
- 不改数据语义：`stats.progress` 仍是加权进度，卡片大百分比仍是 `done/total`。
- 不加新依赖：`chart.js` 已存在且本方案不新增用法；不新增网络请求、定时器、全局状态。
- 不动顶部 5 格统计条、两组之后的 `Donut` / `TaskBars` / `GroupCharts`。
- 不改 `GroupRing` 的几何与文案（只加 `data-zero` 与零轨加粗）。

---

## 2. 设计目标（可验收的 7 条）

| 编号 | 目标 | 可测口径 |
|---|---|---|
| G1 | 0% 可见 | 0/8 时：大百分比「0%」、整条灰色「还没开始」构成条、加粗环轨、当前阶段描边，四者同时出现 |
| G2 | 比例可读 | 百分比字号 ≥24px、字重 700；环形图直径 ≥44px；构成条高度 ≥8px、宽度 ≥200px |
| G3 | 当前步骤可见 | 折叠态就显示「正在做 · 任务标题 · 部门」；无进行中时显示「还没开始」或「都做完了」 |
| G4 | 异常醒目 | blocked > 0 时：红色构成段 + 「N 卡住了」徽章 + 红色阶段块 + `data-alarm="true"`；blocked = 0 时不出现任何红色 |
| G5 | 不靠颜色 | 环形/条形都 `aria-hidden`；同一信息以文字（百分比、计数、图例、状态词）出现；色觉障碍下仍可读 |
| G6 | 不加依赖、不改数据源 | `package.json` dependencies 不变；新代码只用现有 React/SVG/CSS；服务端零改动 |
| G7 | 首屏不倒退 | 440×888 视口下，实时组的两张计划卡的图表区都完整出现在首屏（以 DevTools 实测为准） |

---

## 3. 视觉层级

### 3.1 层级表

| 层 | 内容 | 字号/字重 | 颜色 | 作用 |
|---|---|---|---|---|
| L0 容器 | 计划卡（现有 tone 顶边 3px） | — | 现有 | 卡片身份 |
| **L1 主角** | **24px 百分比 + 44px 环** | 24 / 700 | `label-primary`；弧 `done-ink` | 3 秒内读到「做了多少」 |
| **L1 主角** | **8px 四段构成条** | — | done/active/error/idle | 一眼看到「完成/进行/卡住/待做」的体量 |
| **L1 主角** | **6px 阶段步进条** | — | 四态 | 一眼看到「做到第几步」 |
| L2 支撑 | 「本计划 X/Y 做好了」 | 12 / 400 | `label-secondary` | 把百分比还原成可核对的数量 |
| L2 支撑 | 当前步骤一行 | 12 / 400 | `label-secondary` + 6px 状态点 | 回答「现在在做什么」 |
| L3 注解 | 状态图例（4 项） | 11 / 400 | `label-secondary` | 解释四段颜色与数量 |
| L3 注解 | 阶段 title / 图例 title | 11–12 | — | 悬停补充，不作唯一入口 |
| L4 异常 | 「N 卡住了」徽章 | 12 / 650（复用现有 alert 类） | 混合红 5.16:1 | 异常必须跳出 |
| L5 元信息 | 阶段卡标题、徽标、展开面板 | 16/650、11–16 | 现有 | 不抢主角 |

### 3.2 为什么是这个层级

- **百分比最大**：用户画圈的核心是「0/8 看不出进度」，数字是最直接的答案。
- **环 + 条 + 步进条三种图形各回答一个问题**：环＝总比例，条＝构成，步进条＝阶段位置。三者不重复同一编码。
- **文字始终与图形并存**：图形是加速器，不是唯一信息源；这也满足项目的「颜色不做唯一编码」原则。
- **异常只在真异常时出现**：0 卡住时不再有红色徽章，红色恢复为「有含义的颜色」。

---

## 4. 数据映射（唯一来源，前端推导）

### 4.1 输入

`SessionCard` 已拿到 `session`（含 `stats`、`statuses`、`stages`、`phase`）。全部数据已在 `serialisePlan` 中下发，**不需要服务端新增字段**。

### 4.2 计算规则

```ts
// 总进度（按件，非加权）
total   = max(0, Number(stats.total) || 0)
done    = clamp(Number(stats.done) || 0, 0, total)
blocked = clamp(Number(stats.blocked) || 0, 0, total - done)
active  = clamp(Number(stats.inProgress) || 0, 0, total - done - blocked)
pending = max(0, total - done - blocked - active)
percent = total > 0 ? Math.round((done / total) * 100) : null   // 0..100
```

- `percent === null`（total = 0）时显示「—」，不画环弧、不画构成条与步进条；卡片仍显示标题与徽标。
- `done > total` 的脏数据被 clamp，绝不出现 101% / NaN / Infinity。

### 4.3 阶段推导

```ts
// 每个 stage：
stageTotal   = stage.subtasks.length
stageDone    = Σ(status === 'done')
stageBlocked = Σ(status === 'blocked')
stageActive  = Σ(status === 'in_progress' || status === 'running')
stagePercent = stageTotal > 0 ? Math.round(stageDone / stageTotal * 100) : 0

tone = stageBlocked > 0 ? 'blocked'
     : stageTotal > 0 && stageDone === stageTotal ? 'done'
     : (stageActive > 0 || stageDone > 0) ? 'active'
     : 'pending'
```

- `statuses` 中缺失的 subtask 按 `pending` 计；`stages` 缺失或为空时，步进条不渲染，其余照常。
- 阶段顺序严格用 `session.stages` 的原顺序；步进条每段宽度**相等**（一段＝一步），不按任务数加权——避免「第 2 步比第 1 步宽」被误读成工作量。
- `currentStageId`：第一个 `stageActive > 0` 的阶段；若没有，则第一个 `stageDone < stageTotal` 的阶段；全部完成则无当前阶段。只给一个阶段加 `data-current="true"`。

### 4.4 「当前步骤」状态机

| 条件 | 文案 | data-state | 点色 |
|---|---|---|---|
| 有 `in_progress` 状态（取 `startedAt` 最新一条；缺失则第一条） | `正在做 · {title} · {dept}` | `active` | active 橙 |
| 无进行中，但有 `blocked` 状态 | `卡住了 · {title} · {dept}` | `blocked` | error 红 |
| 无进行中/卡住，`done === total && total > 0` | `都做完了` | `done` | done-ink 蓝 |
| 无进行中，但 `stats.inProgress > 0`（明细未同步） | `正在做 {n}` | `active` | active 橙 |
| 其余（含 total = 0） | `还没开始`（total = 0 时不渲染该行） | `idle` | idle 灰 |

- 分隔符统一用 ` · `，不写中文冒号，保证英文界面同样成立。
- `title` 过长时单行省略，`title` 属性放全文；部门用 `deptName(t, id)`。
- 该行不是链接、不加 hover 才出现的信息。

### 4.5 两个百分比的关系（必须说清）

| 指标 | 公式 | 出现位置 | 文案 |
|---|---|---|---|
| 完成率（按件） | `done / total` | 折叠卡 24px 大百分比 + 环 | `0%` + `本计划 0/8 做好了` |
| 总体进度（加权） | `stats.progress`（每件按其自身 progress 加权） | 展开面板「分步进度」头部 | `总体进度（加权）35%` |

两者**不相加、不互相替换**。在展开面板里保留加权的 `stats.progress`，并明确标注「加权」，避免用户把 0%（按件）和 70%（加权）当成矛盾。旧面板里的 `Progress` 条只保留给子任务行（`SubtaskRow`），计划级的那一条被「分步进度」取代。

---

## 5. 紧凑布局（折叠卡，默认可见）

### 5.1 线框（以 440px 视口、卡内容宽约 340–368px 为例）

```
┌──────────────────────────────────────────────────────────┐
│ ▸  计划标题（16/650，最多两行）                    [进行中] │
│                                                          │
│  ╭───╮   0%   本计划 0/8 做好了        [1 卡住了]        │
│  │ 0 │   ● 正在做 · 核对任务类型 · 工程研发               │
│  ╰───╯                                                   │
│  ████████████████████████████████████████████████████████ │  ← 8px 构成条
│  ● 做好了 0   ● 正在做 1   ● 卡住了 0   ● 还没开始 7      │  ← 11px 图例
│  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮        │  ← 6px 阶段步进条（3 段）
└──────────────────────────────────────────────────────────┘
```

> 0% 且无进行中时：第二行变成「● 还没开始」，构成条整条为灰色「还没开始」段，步进条为 3 个虚线空槽；仍有 24px「0%」与加粗环轨。

### 5.2 结构（HTML/React 层级）

```
span.dsh-wp-planviz[data-percent][data-total][data-done][data-blocked][data-zero][data-alarm]
├─ span.dsh-wp-planviz-gauge[aria-hidden="true"]
│  └─ svg.dsh-wp-planviz-ring (44×44, viewBox 0 0 44 44)
│     ├─ circle.dsh-wp-planviz-ring-track  (r=18, stroke=4, 无 fill)
│     └─ circle.dsh-wp-planviz-ring-arc    (仅 percent>0 时渲染)
├─ span.dsh-wp-planviz-head
│  ├─ strong.dsh-wp-planviz-pct            "0%"
│  ├─ span.dsh-wp-planviz-scope            "本计划 0/8 做好了"
│  └─ span.dsh-wp-planviz-alert            "1 卡住了"（仅 blocked>0）
│  └─ span.dsh-wp-planviz-now[data-state]  （作为 head 的第二行）
│     ├─ i.dsh-wp-planviz-now-dot
│     └─ span.dsh-wp-planviz-now-text
├─ span.dsh-wp-planviz-bar.dsh-wp-mini[aria-hidden="true"]
│  └─ span.dsh-wp-mini-fill--done|active|blocked|pending × 1..4
│     每个带 data-kind、data-count，宽度用 flex-grow=count、min-width=4px
├─ span.dsh-wp-planviz-legend
│  └─ span.dsh-wp-planviz-legend-item × 4
│     ├─ i.dsh-wp-planviz-dot
│     └─ "做好了 0" / "正在做 1" / "卡住了 0" / "还没开始 7"
└─ span.dsh-wp-stepper[aria-hidden="true"]（stages 1..12 时渲染）
   └─ span.dsh-wp-stepper-seg[data-stage-id][data-tone][data-current][data-done][data-total] × N
      └─ span.dsh-wp-stepper-fill（宽度=stagePercent%）
```

**为什么用 `data-*` 承载数字**：现有测试渲染器会丢弃 object/function 属性（`style` 对象不进 HTML），所以所有验收数字必须同时写到 `data-*` 与可见文本里；颜色/宽度用 CSS，不靠测试读 inline style。

### 5.3 关键尺寸与排版

| 元素 | 值 | 说明 |
|---|---|---|
| 卡片内 grid | `44px minmax(0,1fr)`；列距 8px；行距 5px | 环固定在左，文字可伸缩 |
| 环 | 44×44，`r=18`，`stroke-width=4`，`viewBox 0 0 44 44` | 与组头环同几何，视觉同源 |
| 大百分比 | `24px / 700 / line-height 1.05 / letter-spacing -.4px / tabular-nums` | 旧 12px → 2 倍；主文本色 |
| 计数句 | `12px / 400 / 1.4`，`label-secondary` | 保留「本计划 X/Y 做好了」原文 |
| 异常徽章 | `12px / 650`，`padding 1px 8px`，圆角 999，复用 `.dsh-wp-group-alert` | 只在 blocked>0 |
| 当前步骤 | `12px / 400 / 1.4`，单行省略；点 6×6 | 标签 + 标题 + 部门 |
| 构成条 | 整行宽 × 8px；四段；段间 2px；段最小 4px | 旧 54×5 → 整行×8 |
| 图例 | `11px / 400 / 1.5`；项间距 `2px 10px`；点 6×6 | 4 项；窄了换行 |
| 步进条 | 整行宽 × 6px；段间 3px；圆角 2px | 1 段 = 1 个阶段 |
| 卡片新增高度 | 约 +70~90px（单行标题 ~135px，双行标题 ~157px） | 实现后以 DevTools 实测为准 |

### 5.4 0% 的四个可见信号（核心验收）

1. **24px「0%」**：不再是 12px 次要色里的一个数字。
2. **加粗零轨**：`percent === 0` 时环轨从 `rgba(148,163,184,.30)`（1.27:1）切到 `rgba(100,116,139,.80)`（约 3.1:1），4px 环清楚可见；仍不画弧（不产生 `strokeDasharray`）。
3. **整条灰色构成条**：`pending = total` 时铺满整条，段为 `idle` 灰（8px 高）；不是「空轨道」。
4. **虚线阶段槽 + 当前阶段描边**：每个未开始阶段是 1px 虚线槽，当前阶段外描边 1.5px。

> 这四条中任意两条同时出现，也足以让 0% 不再「一片空白」；测试至少锁 1–3 条。

### 5.5 高度预算与首屏几何

以截图同尺寸 **440×888 CSS px** 估算（实现后必须实测）：

| 区域 | 高度 |
|---|---|
| 面板头 + 标题/副标题/刷新 | ~136 |
| 顶部 5 格统计条 | ~132 |
| scope note | ~32 |
| 实时组组头（44 环 + 摘要） | ~70 |
| 两张计划卡（各 ~157，双行标题） | ~314 + 16 gap |
| 组内边距 | ~28 |
| **合计** | **~728** |

首屏 888px 内可完整看到两张卡；若实测超出，优先隐藏图例（11px 行）而不是缩小主角。短屏（`max-height: 720px` 且 `max-width: 600px`）增加降级规则：隐藏图例与步进条，保留环 + 百分比 + 构成条 + 当前步骤，卡片约 118px，两张卡仍可进 667px 首屏（估算，需实测）。

---

## 6. 完整布局（展开面板，「分步进度」）

### 6.1 线框

```
┌ 分步进度                                    总体进度（加权）35% ┐
│ 1 正在做 · 0 卡住了 · 7 还没开始                               │
│ ● 第 1 步：直接回答        ▬▬▬▬▬▬  1/1   都做完了              │
│ ● 第 2 步：核验来源        ▬▬▬▬▬▬  0/3   正在做                │
│ ● 第 3 步：交付结果        ▬▬▬▬▬▬  0/4   还没开始              │
└────────────────────────────────────────────────────────────────┘
```

- 位置：展开面板内，**替换旧的计划级 `Progress` + `.dsh-wp-progress-meta`**（`src/client.ts:1374-1378` 一带），保留「更新于」「Guide」「部门」「步骤」原有顺序。
- 仅在 `open === true` 时渲染（`open ? h(PlanOverview…) : null`），折叠态 DOM 不重复输出一套图表。
- 不在展开面板重复 44px 环：同一指标不在同屏画两次；展开态增加的是「阶段分解」这一新信息。

### 6.2 规格

| 元素 | 值 |
|---|---|
| 容器 | `padding 12px`；`border 1px solid border-l1`；`border-radius 12px`；`background bg-layer-2`；`display grid; gap 8px` |
| 标题行 | `分步进度` 12/600 `label-secondary`；右侧 `总体进度（加权）X%` 12/400 `label-secondary` |
| 统计行 | `{active} 正在做 · {blocked} 卡住了 · {pending} 还没开始` 12/400 `label-secondary` |
| 阶段行 | `grid-template-columns: 7px minmax(0,1fr) 48px auto auto`；列距 8px；行高 28px；行间 `border-top 1px border-l1`（首行无） |
| 阶段点 | 7×7 圆点，颜色 = tone |
| 阶段名 | `13px / 600` 主文本色；单行省略；`第 N 步：{name}` |
| 阶段条 | 48×4px 轨道 + 填充；填充宽 = `stagePercent%`；填充色 = tone |
| 阶段计数 | `12px / 400` secondary；`done/total`；tabular-nums |
| 阶段状态 | `11px / 400` secondary；`都做完了 / 正在做 / {n} 卡住了 / 还没开始` |
| 当前阶段 | `data-current="true"`：整行 `background rgba(249,115,22,.06)`；名字主色；点用 active |
| 完成阶段 | 名字 primary；条 done 蓝；状态「都做完了」 |
| 阻塞阶段 | 点/条 error 红；状态文字仍用 secondary（红色只做面，12px 红字不达标） |

### 6.3 与旧 `Progress` 的关系

- 计划级旧块（`Progress` 8px 条 + 「总体进度 X% / N 正在做 · M 还没开始」）被新块取代。
- `Progress` 组件本身保留：子任务行仍在用，不能删。
- `stats.progress` 的加权数值保留在新块右上方，并显式写「（加权）」；不再与按件百分比混用同一个标签。

---

## 7. 图表组件规格

### 7.1 `PlanRing`（环形图）

| 属性 | 值 |
|---|---|
| 尺寸 | 44×44（`viewBox 0 0 44 44`） |
| 轨道 | `r=18`，`stroke=4`，`fill=none`，`stroke = var(--dsh-wp-ring-track)`；`data-zero` 时改 `--dsh-wp-ring-track-strong` |
| 弧 | `r=18`，`stroke=4`，`fill=none`，`stroke=var(--dsh-wp-done-ink)`，`strokeLinecap=round`，`transform=rotate(-90 22 22)`，`strokeDasharray = arc C-arc` |
| 0% | **不渲染弧**（不输出 `strokeDasharray`），只保留轨道；这是 `group-summary.test.ts` 的硬约束 |
| 100% | `arc = C`，`gap = 0`；round linecap 允许轻微重合，不做额外处理 |
| 文本 | 环内不放文字；百分比由外部 24px 文本承担（环是 `aria-hidden`） |
| 动画 | `transition: stroke-dasharray .28s ease`；`prefers-reduced-motion` 下取消 |
| 空值 | `percent === null` 时只画轨道，不画弧；外部显示「—」 |

### 7.2 四段构成条

- 顺序固定：done → active → blocked → pending；与 `Donut` 图例顺序一致。
- 每段：`flex-grow = count`、`flex-basis: 0`、`min-width: 4px`（count>0）、`border-radius: 999px`、`height: 100%`、`gap: 2px`。
- count=0 的段不渲染（不占位）；四段都为 0 时（total=0）整条不渲染。
- 8px 高、整行宽；外层 `background: var(--dsh-wp-track)` 只在段间缝隙露出。
- 颜色：done `var(--dsh-wp-done)`、active `var(--dsh-wp-active)`、blocked `var(--dsw-alias-state-error-primary)`、pending `var(--dsw-alias-state-idle-primary)`。**保留现有 `.dsh-wp-mini-fill--*` 类名与颜色**，不触碰 `status-colors.test.ts` 的锁定。
- 每段 `data-kind` / `data-count`；外层 `aria-hidden="true"`；数量由图例文字承担。

### 7.3 阶段步进条

| tone | 轨道 | 填充 | 额外 |
|---|---|---|---|
| done | `--dsh-wp-track` | done 蓝，宽 100% | — |
| active | `--dsh-wp-track` | active 橙，宽 = stagePercent | 若 done=0，左侧 2px 橙色起笔 |
| blocked | `--dsh-wp-track` | error 红，宽 = stagePercent | `inset 0 0 0 1px error` 描边 |
| pending | transparent | 无 | `1px dashed var(--dsh-wp-track-strong)` |

- 段宽相等（flex:1）；每段 `min-width: 0`；阶段数 1–12 渲染，>12 不渲染（避免每段 <8px）。
- 当前阶段：`outline: 1.5px solid var(--dsh-wp-active-text); outline-offset: 1px`；短屏降级时整条隐藏。
- 每段 `title = "第 N 步：{name}，{done}/{total} 做好了"`；`aria-hidden`。

### 7.4 状态图例

- 4 项固定顺序：`做好了 {done}`、`正在做 {active}`、`卡住了 {blocked}`、`还没开始 {pending}`。
- 复用现有 locale key：`stats.done` / `stats.inProgress` / `stats.blocked` / `stats.pending`，**不新增文案 key**；与顶部「状态分布」图例用词一致。
- 11px / 400 / secondary；点 6×6；数字 `tabular-nums`；`flex-wrap: wrap`，窄屏两行。
- 图例不是「悬停才出现」；它是 0% 时解释「整条灰＝还没开始」的唯一文字。

### 7.5 异常高亮（blocked）

四层信号，全部由 `blocked > 0` 触发：

1. 构成条出现红色段（宽度按 blocked 数量）。
2. 头部出现 `.dsh-wp-group-alert` 徽章 `{n} 卡住了`（复用现有 5.16:1 的混合红）。
3. 对应阶段块：红色描边 + 红色填充（步进条）；展开态阶段行点/条变红。
4. 根节点 `data-alarm="true"`（供测试与主题扩展）。

不额外加红框、不改变卡片顶边（顶边已由现有 `tone` 控制）。

### 7.6 空组（圈③）

| 项 | 处理 |
|---|---|
| `total = 0` 的组头摘要 | **不渲染**「未完成 0 / 已完成 0（完成率暂无数据）」整句 |
| `GroupRing` | **保留**，显示「—」，`data-percent="none"` 保持；它是「无数据」符号，不是噪声，且维持组头布局 |
| 空态正文 | 保留「还没有完成的任务」/「还没有进行中的任务」 |
| 组头 aria-label | 继续用 `groupAriaEmpty`（已有，含组名与计划数） |
| 0% 但 total>0 的组 | 摘要照常「未完成 N / 已完成 0（完成率 0%）」；环轨加粗 + 「0%」标签 |

> 这是对 T2 Q5=5A 的细化：删文字摘要，不删「—」环。测试只改摘要句断言，`data-percent="none"` 与 `dsh-wp-group-ring-label">—<` 保持不变。

---

## 8. 交互、可访问性与主题

### 8.1 交互

- 整个卡片头仍是唯一 toggle（现有 `button`）；图表区不是独立按钮，不新增 tab 停靠点。
- 点击图表任意位置 = 展开/收起；键盘 Enter/Space 沿用现有行为。
- 不新增 hover 才能看到的信息；所有 `title` 只是补充。
- 展开/收起的动效沿用现有 160ms chevron；图表不新增位移动画。

### 8.2 可访问性

- 环、构成条、步进条：`aria-hidden="true"`；信息由同一按钮内的文字承担。
- 按钮可读名（示例）：`计划标题 0% 本计划 0/8 做好了 正在做 · 核对任务类型 · 工程研发 做好了 0 正在做 1 卡住了 0 还没开始 7 进行中`。信息完整但偏长；这是「一眼可读」与「读屏完整」的折中，后续可加 `aria-describedby` 精简（本次不做）。
- 颜色对比（浅色主题，按 `#f8fafc` 底计算）：

| 用途 | 颜色 | 对比度 | 判定 |
|---|---|---|---|
| 24px 百分比 | `#0f172a` | 17.06:1 | ✅ |
| 12px 计数/当前步骤/图例 | `#475569` | 7.24:1 | ✅ |
| 11px 图例/状态文字 | `#475569` | 7.24:1 | ✅ |
| 环弧/完成点 | `#0284c7`（done-ink） | 3.91:1 | ✅ 图形 ≥3:1 |
| 当前阶段描边 | `#b3571c`（active-text 70% 混合） | 4.67:1 | ✅ |
| 零轨 | `rgba(100,116,139,.80)` → `#828fa2` | 3.14:1 | ✅ 图形 ≥3:1 |
| 红色徽章文字 | 80% error 混合 | 5.16:1（现有注释实测） | ✅ |
| done/active/pending 色面 | 品牌色 | 2.65 / 2.68 / 2.45 | 仅作「面」，均有文字标签；按项目既有口径 |

- 色觉障碍：所有四态都有文字（图例、阶段状态词）；形状上「当前阶段」有描边、「卡住」有红色段 + 徽章，不只靠色相。
- `prefers-reduced-motion`：环弧过渡取消；不新增脉冲动画（现有组头脉冲不动）。

### 8.3 主题与 token

新增 2 个 token（只加在 `.dsh-wp` 作用域）：

```css
--dsh-wp-track: rgba(148,163,184,.22);        /* 条/阶段槽底色 */
--dsh-wp-track-strong: rgba(100,116,139,.80); /* 0% 零轨 & 虚线阶段槽，≥3:1 */
```

- 不新增十六进制色值；不新增渐变（本方案 CSS 中 `linear-gradient` 计数为 0）。
- 深色主题由 `--dsw-alias-*` 与 `color-mix` 自动适配；`--dsh-wp-track` 是中性灰，深浅底都可读。

---

## 9. 代码落点与施工顺序

### 9.1 落点（全部在 `src/client.ts`，服务端零改动）

| # | 位置（以现有锚点定位，行号会浮动） | 改动 |
|---|---|---|
| C1 | `GroupRing` 之后（约 :1644） | 新增 `PlanRing({ percent, size })`；复用 GroupRing 的几何与零弧规则，但**不**带环内 label |
| C2 | `SessionCard` 之前（约 :1336） | 新增 `PlanLegend`、`PlanStepper`、`PlanViz`、`PlanOverview` 四个纯函数组件 |
| C3 | `SessionCard` 的 `meta:` 数组（约 :1356-1361） | 用 `meta: h(PlanViz, {...})` 替换旧的三段（scope / mini / blocked） |
| C4 | `SessionCard` 面板（约 :1374-1378） | `Progress` + `progress-meta` 替换为 `open ? h(PlanOverview, {...}) : null` |
| C5 | CSS 块（`.dsh-wp-mini` 附近，约 :621） | 追加 `.dsh-wp-planviz*`、`.dsh-wp-stepper*`、短屏 media query |
| C6 | `.dsh-wp` token 块（约 :356） | 追加 2 个 token |
| C7 | `SessionGroup` 摘要（约 :1671） | `totals.percent === null` 时 `summaryText = null`，且不渲染 `.dsh-wp-group-sub` |
| C8 | `GroupRing` 根节点（约 :1614） | `data-zero={value === 0}`；CSS 零轨加粗 |
| C9 | LOCALE 两处（zh 约 :18、en 约 :191） | 新增 `vizStageTitle`、`vizWeighted` 两个 key（中英都要，见 §9.3） |

### 9.2 施工顺序（P0 → P2）

1. **P0（核心）**：C1 + C2（PlanRing / PlanViz）+ C3 + C5 + C6 → 折叠卡图表。
2. **P0**：C7 + C8 → 空组与 0% 组头。
3. **P1**：C4 + PlanOverview + C9 → 展开态分步进度。
4. **P1**：短屏降级 media query。
5. **P2**：文档、测试、版本、构建、重启验证（T4/Main）。

### 9.3 新增 locale（必须中英各一份）

| key | zh | en |
|---|---|---|
| `vizStageTitle` | `分步进度` | `Step progress` |
| `vizWeighted` | `总体进度（加权）` | `Overall progress (weighted)` |

- 全部通过 `t()` 取值；`tests/client-locale.test.ts` 会扫描 `src/client.ts` 里的 `t('...')` 字面量，两个语言都必须存在。
- 其他文案复用现有 key，不新增。

### 9.4 明确不做的实现

- 不引入 Chart.js 新实例、不新增 canvas、不新增依赖。
- 不新增 `useEffect` / 定时器 / 订阅。
- 不改 `serialisePlan`、`deriveAggregates`、`Stats` 类型。
- 不改顶部统计条与两组之后的图表。

---

## 10. 验收标准（客观可判定）

> 自动项用 `npm test` / `npm run check` / `node` 断言；手动项必须附截图或 DevTools 读数。**未实测的项不得标 PASS**。

| ID | 类型 | 验收项 | 通过标准 |
|---|---|---|---|
| A1 | 自动 | 0% 有可见图表 | 0/8 夹具：HTML 含 `data-percent="0"`、`data-zero="true"`、可见文本 `0%`、`本计划 0/8 做好了`；构成条含 `data-kind="pending" data-count="8"` |
| A2 | 自动 | 0% 不画弧 | 0/8 卡片切片中不出现 `strokeDasharray`；环只有 track 圆 |
| A3 | 自动 | 比例正确 | 3/8 → `data-percent="38"`、文本 `38%`；弧存在且 dasharray 长度 > 0 |
| A4 | 自动 | 当前步骤 | 有进行中：文本含 `正在做` + 标题 + 部门，`data-state="active"`；全完成：`都做完了`；全待做：`还没开始`；无明细但有 inProgress：`正在做 1` |
| A5 | 自动 | 异常高亮 | blocked=1：`data-alarm="true"`、含 `1 卡住了`、构成条含 `data-kind="blocked"`、对应阶段 `data-tone="blocked"`；blocked=0：不含 `卡住了` 徽章、`data-alarm="false"` |
| A6 | 自动 | 阶段色块 | 3 阶段 → 3 个 `[data-stage-id]`，tone 分别为 done/active/pending；恰有一个 `data-current="true"`；段数与 `session.stages.length` 一致 |
| A7 | 自动 | 图例 | 恰有 4 个图例项，文本分别为 `做好了 X`、`正在做 X`、`卡住了 X`、`还没开始 X`，数字与夹具一致 |
| A8 | 自动 | 空组 | total=0：不含 `完成率暂无数据`；仍含 `data-percent="none"` 与 `dsh-wp-group-ring-label">—<`；空态正文存在 |
| A9 | 自动 | 脏数据 | done>total、负数、NaN：不出现 `NaN`/`Infinity`/`undefined`/`101%`；用 clamp 后的数字 |
| A10 | 自动 | 无新依赖 | `package.json` dependencies 仍只有 `chart.js`；`src/client.ts` 无新的 `require('...')` |
| A11 | 自动 | 类型/测试 | `npm run check` EXIT=0；`npm test` 全绿（含新测试与更新后的 2 处断言） |
| A12 | 自动 | 版本 | `package.json`、`package-lock.json`、`src/host.ts` meta.version 均为 `1.5.0`；`client.js`/`lib/host.js` 构建产物含新类名/新版本 |
| A13 | 手动 | 首屏 | 440×888（DPR=3 等效）：两张计划卡的图表区都完整可见；截图与设计稿对照 |
| A14 | 手动 | 高度/无溢出 | 单行标题卡 ≤160px、双行 ≤180px；无横向滚动；环 + 百分比 + 计数句在 ≥320px 卡宽时同一行（计数句最多换 1 行） |
| A15 | 手动 | 窄屏 | 320px 宽侧栏：无溢出；图例最多 2 行；`正在做` 行省略但 `title` 有全文；短屏 375×667 时图例/步进条隐藏且两卡进入首屏 |
| A16 | 手动 | 深色主题 | 深色下所有新增文字 ≥4.5:1、环/零轨 ≥3:1；无「白底灰字」残留；截图 |
| A17 | 手动 | 0% 真实观感 | 截图同尺寸对比：改造前 0% 处看不到条形，改造后能同时看到「0%」、灰色整条、虚线阶段槽 |
| A18 | 手动 | 可访问性 | Tab 能聚焦卡片，Enter/Space 展开；读屏可读出 0%、0/8、四态计数；减少动效下环无过渡 |
| A19 | 手动 | 运行时 | 重启 DSH Web + 刷新后插件加载 1.5.0；控制台无 error；接口无 500；展开/收起无布局跳动 |
| A20 | 手动 | 文档 | CHANGELOG 1.5.0、设计文档、验证记录三者齐全；截图命名与日期可追溯 |

### 10.1 自动验收的参考命令（实现后可直接复制）

```bash
cd <repo>

# 1) 类型检查
npm run check

# 2) 全量测试（会先构建 client.js）
npm test

# 3) 只跑新增的进度图表测试（若测试脚本支持 --test-name-pattern）
node --test tests/progress-visual.test.ts

# 4) 确认零改动面（施工前基线，施工后应只有预期文件变化）
md5 -q package.json src/plan.ts src/runtime.ts
shasum -a 256 src/client.ts client.js lib/host.js

# 5) 确认无新依赖
node -e "const p=require('./package.json'); console.log(Object.keys(p.dependencies||{}))"

# 6) 确认 1.5.0 三处版本
node -e "console.log(require('./package.json').version)"
node -e "const l=require('./package-lock.json'); console.log(l.version, l.packages[''].version)"
grep -n "version: '1.5.0'" src/host.ts
```

### 10.2 自动验收的断言骨架（新增 `tests/progress-visual.test.ts`）

用与 `tests/group-summary.test.ts` 相同的 React stub / `render()`（该渲染器会丢弃 object 属性，所以断言只用 `data-*` 与文本）：

```ts
// 夹具：8 件，3 阶段，0 完成，1 进行中
const zero = session({
  stats: { total: 8, done: 0, blocked: 0, inProgress: 1, pending: 7, progress: 12 },
  stages: [st1(3), st2(3), st3(2)],
  statuses: [inProgress('T4')],
})
const html = await renderDashboard([zero])

assert.match(html, /data-percent="0"/)
assert.match(html, /data-zero="true"/)
assert.match(html, /本计划 0\/8 做好了/)
assert.match(html, /0%/)
assert.match(html, /data-kind="pending" data-count="7"/)
assert.equal(html.includes('strokeDasharray'), false) // 0% 不画弧
assert.equal(html.includes('NaN'), false)

// 3/8、1 卡住
assert.match(html, /data-percent="38"/)
assert.match(html, /data-alarm="true"/)
assert.match(html, /1 卡住了/)
assert.match(html, /data-tone="blocked"/)
```

> 具体选择器以最终 DOM 为准；关键是「数字进 `data-*`、文案进文本、颜色/宽度进 CSS」这一分层不变。

---

## 11. 测试改造清单（实现时必须同步）

| 文件 | 位置 | 现状 | 改为 |
|---|---|---|---|
| `tests/session-collapse.test.ts` | :292-300 一带 | 断言折叠卡摘要含 `0 卡住了` | 改为断言图例 `卡住了 0`；并可加 `!includes('0 卡住了')` |
| `tests/group-summary.test.ts` | :189 一带 | 断言空分母组含 `未完成 0 / 已完成 0（完成率暂无数据）` | 删除该句断言；保留 `data-percent="none"`、`—` 环、空态正文；加 `!includes('完成率暂无数据')` |
| `tests/group-summary.test.ts` | :133 一带 | 0% 时 live 切片不含 `strokeDasharray` | **不改**；实现必须保证卡片环 0% 也不输出 dasharray |
| `tests/status-colors.test.ts` | :14 | `.dsh-wp-mini-fill--done` 用 `var(--dsh-wp-done)` | **不改**；保留类名与颜色 |
| `tests/client-render.test.ts` | :140 | 含 `本计划` | **不改**；新文案仍含「本计划 X/Y 做好了」 |
| `tests/client-locale.test.ts` | 全文件 | 扫 `t('...')` 字面量 | 新增 2 个 key 必须在 zh/en 都存在；其余复用 |
| `tests/progress-visual.test.ts` | 新文件 | — | 至少覆盖 A1–A9：0%、38%、100%、total=0、脏数据、阶段、图例、空组 |

**为什么保留「本计划 X/Y 做好了」**：一是用户原文，二是不破坏 `session-collapse` / `client-render` 的既有断言，三是让大百分比有一个可核对的文字底座。

---

## 12. 文档同步、版本与发布

### 12.1 版本（沿用 T4，不重复其细节）

- `npm version 1.5.0 --no-git-tag-version`（同时改 `package.json` 与 `package-lock.json`）。
- 手改 `src/host.ts:328` 的 `meta.version` 为 `1.5.0`。
- 构建：`npm run build`（tsc → dist → 复制到 `lib/` 与根 `client.js`）。
- **重启 DSH Web + 刷新页面**才能让 `client.js` 生效；本子任务无此权限，需主 Agent 执行。
- 回滚：T4 的 `.backups/v1.4.3-pre-progress-viz-20261028-133958.tar.gz`。

### 12.2 需同步的文档

| 文档 | 改动 |
|---|---|
| `docs/visual-refinement-spec.md` | §2 增加 1.5.0 例外：卡片迷你条由 56×4 改为整行×8；其余图表规范不变 |
| `CHANGELOG.md` | 1.5.0 条目：进度区图表化（环/百分比/构成条/图例/阶段条/当前步骤）、空组摘要精简、测试与版本 |
| 本文件 | 实现后把「预算/估算」改为实测值，并补验证记录链接 |

---

## 13. 风险与未验证项

| 风险 | 影响 | 缓解 |
|---|---|---|
| 卡片变高，第二张卡掉出首屏 | 违反 G7 | 440×888 预算 ~728px；短屏隐藏图例/步进条；实测后调 |
| 窄侧栏（<300px）文字换行过多 | 卡片更矮胖 | `minmax(0,1fr)` + 省略；图例两行；`320px` 实测 |
| 「0 卡住了」删除导致旧测试失败 | CI 红 | 已在 §11 列出改法；实现与测试同一提交 |
| 0% 环轨加粗后抢眼 | 视觉过重 | 只在 `percent===0` 时加粗；>0 恢复轻轨 |
| `color-mix` 兼容 | 旧浏览器无混合色 | 现有代码已有 `@supports` 兜底；新样式沿用 |
| 展开面板重复图表 | 视觉冗余 | 展开态只加「分步进度」，不再画第二个环/第二条构成条 |
| 阶段数 >12 | 步进条不可读 | 不渲染步进条；展开态阶段行仍完整 |
| 运行时截图与源码版本不一致 | 验收误判 | 以构建产物哈希 + 刷新后版本号为准；未验证项明确标注 |

**未验证（本设计阶段）**：

- 440×888 与 375×667 的真实高度（预算为估算，需 DevTools 实测）。
- 深色主题下新增 token 的实际观感（按 token 推导，未截图）。
- 截图对应运行实例与 1.4.3 源码的 DOM 级一致性（T1 已标注未验证）。
- `npm test` 未运行（本子任务只做设计，不写构建产物）。

---

## 14. 附：设计决策记录（为什么不是别的方案）

| 决策 | 选择 | 放弃的方案与原因 |
|---|---|---|
| 图表形态 | 内联 SVG 环 + CSS 条 | Chart.js canvas：需要实例生命周期、canvas 不可测、增加体积；本需求用不上 |
| 0% 表达 | 加粗环轨 + 整条灰 + 虚线阶段槽 + 0% 大字 | 只放大百分比：0% 仍是 0%，不解决「空」；只改颜色：色弱不友好 |
| 当前步骤 | 一行文字 + 状态点 | 只在 `title`：触屏永远看不到；放展开面板：折叠态仍不知道在做什么 |
| 阶段图 | 折叠态等宽步进条；展开态逐行 | 折叠态画带阶段名的甘特图：宽度不够；展开态重复环：冗余 |
| 图例 | 4 项常驻 11px | 悬停提示：触屏不可用；只靠颜色：不满足不依赖颜色 |
| 空组 | 删摘要句、留 `—` 环 | 连环保留都删：组头布局失衡，且「—」本身是清晰的无数据符号 |
| 展开态 | 只加分步进度 | 再画一个大环：同一指标同屏出现两次，浪费首屏 |
| 版本 | 1.5.0 | 1.4.4：新增可见图表与折叠卡结构，按语义版本应为 minor |

---

## 15. 给主 Agent 的下一步

1. 把 §1.1 的 Q1–Q3 与本文一起给用户确认；若 Q1/Q2/Q3 改答，按 §1.1 的影响列调整后再施工。
2. 用户确认后，按 §9.2 的 P0 → P1 施工；测试按 §11 同步改。
3. 构建后由主 Agent **重启 DSH Web 并刷新页面**，按 §10 的 A13–A19 做人工验收并截图。
4. 更新版本与文档（§12），把「估算」替换为实测值。
