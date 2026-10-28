# dsh-workplan 两级折叠交互规格（T2 · 交互设计）

> 状态：设计定稿（可直接作为 T3/T4 的验收依据）
> 适用代码快照：`plugins/dsh-workplan/src/client.ts` sha256 前 16 位 `5533bf7293ef57b2`，1384 行，2026-10-25 22:37 读取。
> 说明：T2 勘察期间该文件被并行工作流从 1367 行改到 1384 行，`SessionCard` 与 `StageCard` 的折叠接线是**勘察中落地的**；本规格按该目标形态定义，若后续行号变化，以组件名/类名定位，不以行号为准。
> 本规格只覆盖 Dashboard 的任务卡片与步骤卡片；不覆盖会话内 `TurnCard`、工具调用卡片。

---

## 0. 结论先行

1. **两级折叠**：第一级是「任务卡片」（`SessionCard`），第二级是「每一步」（`StageCard`，即“第 N 步：…”那一行）。两级的摘要行默认都折叠。
2. **不设第三级**：不给「分几步做」整段再加一层折叠，也不给单条「具体工作」（`SubtaskRow`）加折叠；后者保留现有「更多细节」的 `<details>`。理由见 §2.2。
3. **默认折叠**：首次打开页面时，每张任务卡只显示一行摘要；展开任务后，每一步也只显示一行摘要；再点该步才显示目标、检查点和具体工作正文。
4. **折叠是纯展示层**：只改 `hidden`、`aria-expanded`、箭头方向；**不重算任何数字、不重新判状态、不发请求、不写存储**。顶部统计条、任务摘要、步骤摘要三者各有唯一数据源，见 §5。
5. **不做跨刷新记忆**：刷新后回到全部折叠；但在页面存活期间，4 秒一次的自动刷新**不得**把用户已展开的卡片收起来。见 §8。
6. **可访问性**：摘要行是原生 `<button>`，带 `aria-expanded` / `aria-controls`，面板用原生 `hidden` 隐藏；键盘 Enter/Space 可切换，焦点环可见；触摸目标不小于 44px。

---

## 1. 现状与设计依据

| 事实 | 证据（当前快照） |
|---|---|
| 已有一个可复用的折叠容器 `Collapse`，默认 `defaultOpen=false`，摘要含 `title`、`meta`、`badge`，面板为 `hidden` | `src/client.ts:802-873` |
| 折叠样式：整行按钮 `min-height: 44px`、`touch-action: manipulation`、焦点环、`[hidden]{display:none}`、箭头 160ms 且尊重 `prefers-reduced-motion` | `src/client.ts:494-540` |
| 任务卡片已接线：`article.dsh-wp-session` 内放 `Collapse.dsh-wp-session-collapse`，摘要用 `session.stats`，面板放其余内容 | `src/client.ts:1050-1111`（摘要 1061-1069，面板 1070-1109） |
| 步骤卡片已接线：`section.dsh-wp-stage` 内放 `Collapse.dsh-wp-stage-collapse`，摘要用本步 `statuses`，面板放目标/检查点/具体工作 | `src/client.ts:961-989`（摘要 977-983，面板 984-986） |
| 「分几步做」只是分组标题，不是第三层折叠 | `src/client.ts:1092-1100` |
| 顶部汇总的 `totals` 继续只遍历 `activeSessions` 的 `session.stats`，与折叠无关 | `src/client.ts:1113-1133`、统计条 1147 起 |
| `stats` 的唯一算法在服务端：`computeStats(statuses)`；`phase` 由 `planPhase` 单独判定（全完成但结果未写入是 `integrating`，不是 `done`） | `src/plan.ts:1052-1061`、`1064-1070` |
| `Collapse` 单元测试已覆盖默认折叠、点击开合、阻止冒泡、原生按钮键盘、受控/非受控、44px 与 `[hidden]` 样式 | `tests/collapse.test.ts`（359 行，本次勘察时） |

**尚未验证**：`http://127.0.0.1:3080` 需要登录态（T1 实测未登录返回 401），因此本规格未做线上像素/真机验证；所有结论来自源码与单元测试快照，不冒充已看过的视觉结果。

---

## 2. 两级折叠的定义

### 2.1 层级与 DOM 关系

```
Dashboard（统计条 + 汇总说明，不参与折叠）
└─ div.dsh-wp-sessions
   └─ article.dsh-wp-session（保留 tone 左边框/圆角/内边距）
      └─ section.dsh-wp-collapse.dsh-wp-session-collapse     ← 第一级
         ├─ button.dsh-wp-collapse-toggle（任务摘要行）
         └─ div.dsh-wp-collapse-panel（hidden 时隐藏）
            ├─ 更新于 / Guide / 降级提示 / 进度条 / 负责团队
            ├─ div.dsh-wp-section
            │  ├─ div.dsh-wp-section-title「分几步做」（静态标题，可折叠入口不是它）
            │  └─ section.dsh-wp-stage
            │     └─ section.dsh-wp-collapse.dsh-wp-stage-collapse   ← 第二级
            │        ├─ button.dsh-wp-collapse-toggle（步骤摘要行）
            │        └─ div.dsh-wp-collapse-panel
            │           ├─ 要做出什么 / 这一步做完先检查
            │           └─ div.dsh-wp-subtask × N（正文，不再折叠）
            ├─ Analysis（原有 details，保持原样）
            └─ 错误正文
```

- **第一级（任务层）**：一张任务卡 = 一个折叠单元。
- **第二级（步骤层）**：一步 = 一个折叠单元；步骤列表由多个独立折叠单元组成。
- 两级状态互相独立：收起任务不会重置它内部各步骤的展开状态；展开/收起某一步不影响同任务的其他步骤，也不影响任务本身的展开状态。

### 2.2 为什么不是三级（明确拒绝的方案）

| 被拒绝的方案 | 拒绝理由 |
|---|---|
| 在「分几步做」整段外面再套一层折叠 | 用户从“看任务”到“看某一步”需要点 3 次；且会隐藏步骤名，用户无法先扫一眼有几步、哪步卡住。属于规格过度设计。 |
| 每条「具体工作」再单独折叠 | 步骤展开后正是用户主动要看的内容；再折叠会把一次点击变成多次，且与已有的「更多细节」`<details>` 功能重复。 |
| 顶部增加“全部展开/全部收起” | 用户本次只要求默认折叠、按需展开；全局开关增加状态耦合与误操作面，本期不做。 |
| 为折叠加高度动画 | 需要测量高度、处理异步内容与 reduced-motion，收益低、回归风险高；本期只保留箭头旋转 160ms。 |

### 2.3 默认状态

| 场景 | 默认状态 | 说明 |
|---|---|---|
| 首次加载 / 刷新 | 全部任务卡折叠 | `defaultOpen=false` |
| 展开某任务后 | 该任务内的每一步仍各自折叠 | 只显示步骤摘要行 |
| 收起某任务再展开 | 该任务内各步骤保持收起前的状态 | 面板用 `hidden` 隐藏但保持挂载，组件 state 不丢 |
| 4 秒自动刷新（同一会话） | 已展开的保持展开，已收起的保持收起 | 卡片有稳定 `key`（`session.sessionId`、`stage.id`），未被卸载 |
| 刷新浏览器 / 重新进入页面 | 回到全部折叠 | 本期不做跨刷新记忆，见 §8 |

> 默认折叠是**首次渲染**语义，不是“每次数据刷新都强制收起”。这两件事必须分开，否则用户展开后 4 秒就被自动收起，会被当成故障。

---

## 3. 点击与开合行为

| 行为 | 规格 |
|---|---|
| 点击任务摘要行任意位置 | 展开该任务；再点一次收起。整行都是按钮（`button.dsh-wp-collapse-toggle`），不是只有小箭头可点。 |
| 点击步骤摘要行任意位置 | 展开该步；再点一次收起。只影响本步。 |
| 点击已展开面板内的正文/链接/按钮 | 正常执行内容自身行为，**不得**触发折叠（内容在按钮之外；折叠容器的点击只绑定在摘要按钮上）。 |
| 点击箭头 | 等同于点击整行，不单独处理。 |
| 事件冒泡 | 摘要按钮的 click / Enter / Space 必须 `stopPropagation()`，防止以后给卡片外层加点击时双重触发。当前 `Collapse` 已实现。 |
| 收起时焦点位置 | 焦点停留在摘要按钮上（用户就是点它收起的）；不把焦点丢进被隐藏区域。若未来出现“代码主动收起且焦点在面板内”的场景，必须把焦点移回摘要按钮；本期无此调用路径。 |
| 展开时焦点 | 不自动把焦点移入面板；用户按 Tab 自然进入面板第一个可聚焦元素。 |
| 切换时的网络/数据副作用 | 禁止：不发 fetch、不调用计划更新、不改 URL、不写 localStorage/sessionStorage、不重新排序会话、不改变 `activeSessions` 过滤。 |
| 切换时的视觉反馈 | 箭头旋转（160ms；`prefers-reduced-motion` 下无动画）；面板即时显示/隐藏，无高度动画。 |
| 双击/连点 | 每次点击翻转一次，最终状态以最后一次为准；不得出现“点一次开、再点仍开”的状态错位（state 由 React 管理，截图/测试以 `aria-expanded` 为准）。 |

---

## 4. 摘要字段规格

摘要行必须做到：**不展开也能回答“这是什么任务/哪一步、做完多少、现在什么状态”**。

### 4.1 第一级：任务卡片摘要行

| 字段 | 必需 | 精确文案 / 来源 | 缺失时 |
|---|---|---|---|
| 任务名 | 是 | `session.title` | 回退 `t('panel')`（“任务进度”） |
| 完成数/总数 | 是 | `本计划 ${stats.done ?? 0}/${stats.total ?? 0} 做好了`，只读 `session.stats` | 缺失按 0 处理，不隐藏 |
| 状态 | 是 | `Pill(tone=phaseTone(session.phase), t('phase.' + session.phase))`，如“已完成 / 正在做 / 卡住了 / 正在收尾 / 已取消” | `phase` 缺省 `pending` |
| 卡住数 | 保留（现有信息，不倒退） | `${stats.blocked ?? 0} 卡住了` | 显示 `0` |
| 更新于 | 可选 | 当前实现放在展开后的面板首行（`dsh-wp-session-updated`），可以接受；不要求塞进摘要，避免窄屏拥挤 | 无时间则不渲染 |
| 不进入摘要的内容 | — | 进度百分比、进行中/未开始数量、负责团队、Guide 三句话、降级提示、错误正文、Analysis | 全部留在面板内 |

可访问名称示例（屏幕阅读器会把按钮内文字连起来）：
`单句说明 1+1=2 本计划 1/1 做好了 0 卡住了 已完成`。

### 4.2 第二级：步骤卡片摘要行

| 字段 | 必需 | 精确文案 / 来源 | 缺失时 |
|---|---|---|---|
| 步骤名 | 是 | `第 N 步：${stage.name}`（现有 `stageLabel`） | 名称缺失显示“第 N 步” |
| 完成数/总数 | 是 | `${done}/${items.length} 做好了`，`done` 为本步内 `statuses` 中 `done` 的条数，`items` 为本步 `stage.subtasks` | `subtasks` 缺失按空数组，显示 `0/0` |
| 状态 | 是 | `Pill(tone, stateText)`；`stateText` 沿用折叠前既有规则：`blocked>0 → “${blocked} 卡住了”`；全部完成 → “都做完了”；有 `in_progress` → “正在做”；否则 → “还没开始” | 按“还没开始” |
| 步骤目标/检查点/具体工作 | 否（进面板） | `stage.goal`、`stage.checkpoint`、`SubtaskRow` 列表 | 不展示于摘要 |
| 不进入摘要的内容 | — | 负责人、方法、验收、交付、风险、单条具体工作的进度条 | 全部留在面板内 |

**口径声明（写进 UI 语义，防止误读）**：第二级的 `x/y` 是**本步**的完成数，不是整个任务；摘要必须保留“第 N 步”前缀，禁止把本步数字放到没有步骤语境的位置。任务级数字只认 `session.stats`（§5）。

### 4.3 数据来源铁律（摘要层）

1. 任务摘要的 `done/total/blocked` **只能**取 `session.stats`，与顶部统计条、页头“N 个任务，拆成 M 件具体工作”同源。
2. 步骤摘要的 `done/items.length` **只能**沿用折叠前 `StageCard` 的算法（本步 `subtasks` × `statuses`），不得改成读 `session.stats`，也不得把各步相加后回填任务摘要。
3. `phase` 一律透传服务端结果；禁止在客户端用 `done === total` 重新推导“已完成”，否则会把“正在收尾（integrating）”误判为“已完成”。
4. 折叠前后不得新增、隐藏、过滤或重排会话；`activeSessions` 仍只过滤 `phase === 'cancelled'`。

---

## 5. 统计与状态不变式（硬性）

**定义**：折叠是纯展示层。允许变化的只有 `hidden`、`aria-expanded`、`data-open`、箭头方向、焦点环。除此之外任何数字、状态、顺序、请求都不得变化。

| 不变式 | 要求 | 反例（禁止） |
|---|---|---|
| 顶部统计条 | 折叠/展开任意组合前后，四个数字逐字不变 | 根据展开的卡片重新累加 |
| 页头汇总 | “当前各会话最新计划汇总：N 个任务，拆成 M 件具体工作”不变 | 把已折叠任务从汇总里排除 |
| 任务摘要 | 每张卡的 `本计划 x/y` 等于该会话 `session.stats`；所有有效卡之和等于统计条 | 用 `stages.length`、`statuses.length`、DOM 条数重算 |
| 步骤摘要 | 每步 `x/y` 等于本步既有算法结果；不改状态判断 | 把各步相加显示成任务总数 |
| 状态 | `phase` 与 `stateText` 完全沿用折叠前逻辑 | 用“全 done”覆盖 `integrating` |
| 数据请求 | 切换折叠不发请求、不重置轮询、不丢已加载数据 | 展开时懒加载计划 |
| 挂载 | 面板隐藏时内容仍挂载（`hidden`），不卸载 | 用条件渲染卸载面板，导致 `<details>` 状态丢失、统计重算 |

**验收口径**：以“同一份接口数据、同一时刻”为前提，记录折叠前/后的 `statbar` 文本与每张卡摘要文本，必须逐字相等；不是“看起来差不多”。

---

## 6. 可访问性要求

| 项 | 要求 | 现状 |
|---|---|---|
| 控件语义 | 摘要行必须是原生 `<button type="button">`，不用 `div role=button`，不用 `<summary>` 模拟 | 已满足（`client.ts:846-864`） |
| 展开状态 | `aria-expanded="true/false"` 与视觉状态同步 | 已满足 |
| 关联面板 | `aria-controls` 指向面板 `id`；面板 id 在组件生命周期内稳定（`useState` 生成一次） | 已满足（`client.ts:816-818`） |
| 隐藏方式 | 面板用原生 `hidden` 属性；折叠时内容不可聚焦、不被读屏朗读 | 已满足（`client.ts:867-871`） |
| 按钮可访问名称 | 由标题 + 计数 + 状态文本组成；不额外加固定 `aria-label` 覆盖 | 由内容自然生成 |
| 键盘 | Tab 聚焦；Enter / Space 触发一次且仅一次（原生按钮行为；`onKeyDown` 只阻止冒泡，不 `preventDefault`） | 已满足，测试覆盖 |
| 焦点可见 | `:focus-visible` 显示 2px 品牌色描边、offset 2px | 已满足（CSS 516） |
| 折叠后 Tab 顺序 | 隐藏面板内的链接/按钮不进入 Tab 序列 | 由 `hidden` 保证 |
| 嵌套按钮 | 摘要按钮内不得再放按钮/链接；`Pill` 是 `span`，允许 | 已满足（`Pill` 见 `client.ts:727-729`） |
| 箭头 | 纯装饰，`aria-hidden="true"` | 已满足 |
| 读屏播报 | 聚焦时读“<任务名> … 已折叠/已展开 按钮”；不额外加 live region | 依赖 `aria-expanded` |
| 颜色 | 状态不能只靠颜色：`Pill` 内必须有状态文字；计数必须有数字 | 已满足 |
| 动态更新 | 4 秒轮询更新数字时，不打断用户焦点、不自动展开/收起、不移动焦点 | 需回归验证（见 AC9） |
| Escape | **不要求**用 Escape 收起（原生 disclosure 模式无此约定；加了反而与弹层习惯混淆） | 本期不做 |

---

## 7. 移动端与触摸要求

| 项 | 要求 |
|---|---|
| 触摸目标 | 摘要按钮 `min-height ≥ 44px`，整行可点，宽度撑满卡片内容区；不要求点小箭头。 |
| 触摸延迟 | 按钮保留 `touch-action: manipulation`，避免双击缩放延迟。 |
| 悬停 | 不允许存在“只有 hover 才能发现可折叠”的设计；箭头和摘要行在静止态即可识别。 |
| 窄屏换行 | 320px / 375px 宽度下，任务名、计数、状态药丸允许换行；不得出现横向滚动、文字截断（不用 `text-overflow: ellipsis` 截掉关键计数/状态）。 |
| 两级间距 | 步骤折叠行之间、步骤行与任务面板边缘之间保持现有 ≥10px 间距，避免误触相邻行。 |
| 嵌套误触 | 点步骤摘要不得收起父任务；点任务摘要不得展开任何步骤。 |
| 长文本 | 标题与摘要 `overflow-wrap: anywhere`；放大到 200% 字号不裁切、不重叠。 |
| 动效 | `prefers-reduced-motion: reduce` 时关闭箭头 transition；不引入面板高度动画。 |
| 安全区 | 不改现有 `env(safe-area-inset-bottom)` 与滚动容器；折叠不改变页面总滚动方式。 |

---

## 8. 折叠状态记忆（“待确认”项的结论）

**结论：本期不做跨刷新持久化；只保留页面内的组件状态。**

| 范围 | 行为 | 理由 |
|---|---|---|
| 同一次页面会话内 | 已展开/已收起状态保留，包括 4 秒轮询重渲染之后 | 组件 `key` 稳定、非受控 state 不丢；这是“不打断用户”的最低要求 |
| 浏览器刷新 / 重新进入 | 全部回到折叠 | 用户明确要求“默认折叠”；持久化会让“默认”失效，还会出现旧展开状态掩盖新任务 |
| 跨设备 / 跨标签页 | 不同步 | 无此需求 |
| 存储 | 不写 localStorage、sessionStorage、cookie、URL | 避免状态版本/清理/多会话串扰问题；减少回归面 |

如果将来产品确需“刷新后记住”，应单独立项，键建议 `dsh-workplan:collapsed:<sessionId>:<level>`，带版本号与过期清理；**不属于本次验收范围**。

---

## 9. 验收条件（可直接执行）

| 编号 | 场景 | 通过标准 |
|---|---|---|
| AC1 | 首次加载 | 所有任务卡默认折叠：每个 `.dsh-wp-collapse-panel` 都是 `hidden`；每个摘要按钮 `aria-expanded="false"`；页面只显示摘要行，不显示 Guide/进度条/团队/步骤正文。 |
| AC2 | 任务摘要字段 | 每张卡可见：任务名、`本计划 x/y 做好了`、`z 卡住了`、状态药丸；数字与同会话 `session.stats` 完全一致；状态文本与 `phase` 一致。 |
| AC3 | 任务开合 | 点摘要行 → `aria-expanded="true"`、面板 `hidden=false`、箭头朝上；再点 → 全部还原。点箭头与点整行效果相同。 |
| AC4 | 步骤层默认折叠 | 展开任务后，每一步只显示 `第 N 步：名称`、`x/y 做好了`、状态药丸；步骤面板默认 `hidden`。 |
| AC5 | 步骤独立开合 | 展开第 1 步不影响第 2 步；再点第 1 步收起；同任务其他步骤状态不变。 |
| AC6 | 嵌套不误触 | 点步骤摘要时任务不收起（`stopPropagation` 生效）；点已展开面板正文不触发折叠。 |
| AC7 | 键盘 | 仅用 Tab、Enter、Space 可完成两级开合；焦点环可见；每次按键只翻转一次；折叠面板内的控件不可 Tab 到。 |
| AC8 | 读屏语义 | 摘要按钮的可访问名称包含任务名/步骤名、计数、状态；`aria-controls` 指向的面板真实存在；箭头不被朗读。 |
| AC9 | 统计不变 | 以“全部折叠”为基线，任意展开/收起组合后：统计条四数、页头汇总、每张卡摘要数字、每步摘要数字逐字不变；状态文本不变。 |
| AC10 | 自动刷新 | 展开若干卡后等待 ≥2 个轮询周期（约 8s），展开状态保持；数字仅随接口数据变化；焦点不被抢走。 |
| AC11 | 无副作用 | 切换折叠期间无网络请求、无 URL 变化、无存储写入；计划/状态接口数据不被修改。 |
| AC12 | 移动端 | 320px 与 375px 视口：摘要行高度 ≥44px、可整行点击、无横向滚动、计数与状态不截断、200% 字号不重叠；reduced-motion 下无箭头动画。 |
| AC13 | 刷新语义 | 刷新浏览器后回到 AC1 的全折叠状态（本期明确不记忆）。 |

**建议的测试实现**：

1. 组件级：沿用 `tests/collapse.test.ts` 的 hook-aware harness（支持惰性初始值与函数式 `setState`），挂载 `Dashboard` fixture，断言所有面板 `hidden === true`、摘要文本、点击后状态翻转、统计文本不变。
2. 交互级：用 `client-render.test.ts` 的整页渲染断言默认折叠文本仍在（面板 `hidden` 但内容挂载），但需注意其简易 `useState` stub 不执行惰性初始值/函数式更新（`tests/client-render.test.ts:83-89`），若要在该文件里测点击，必须升级 stub，否则 `Collapse` 生成的 id 会变成函数、点击也不会重渲染。
3. 手工级（需登录态）：登录后在 `http://127.0.0.1:3080` 打开面板；DevTools 执行 `Array.from(document.querySelectorAll('.dsh-wp-collapse-panel')).every(p => p.hidden)` 应为 `true`；记录统计条文本，反复开合后再比对；切 320px 设备模拟；只用键盘走一遍；开 VoiceOver 抽查两个摘要按钮。

---

## 10. 给实现方的接线要点（当前快照已按此实现）

- 任务层：`SessionCard`（`client.ts:1050`）外层保留 `article.dsh-wp-session`（tone 边框/圆角/内边距），内部用 `Collapse`，传 `className='dsh-wp-session-collapse'`、`panelClassName='dsh-wp-session-body'`、`title`、`meta=[本计划计数, 卡住数]`、`badge=状态药丸`、`defaultOpen=false`；其余内容作为 children。
- 步骤层：`StageCard`（`client.ts:961`）外层保留 `section.dsh-wp-stage`（tone 边框），内部 `Collapse`，传 `className='dsh-wp-stage-collapse'`、`panelClassName='dsh-wp-stage-body'`、`title=第 N 步：名称`、`meta=本步 x/y`、`badge=本步状态`、`defaultOpen=false`；`goal/checkpoint/SubtaskRow` 作为 children。
- 不动的部分：`SubtaskRow` 正文与其 `<details>`、`Analysis`、`TurnCard`、`Dashboard` 的 `activeSessions`/`totals`/统计条、`plan.ts` 的 `computeStats`/`planPhase`、`host.ts`/`runtime.ts`。
- 已发现的边界（**非折叠引入**，供决定是否单独修）：`StageCard` 在 `stage.subtasks` 为空时，`done === items.length` 为 `0 === 0`，会显示 `0/0 做好了` + tone `done` + 状态“都做完了”。这是折叠前就有的逻辑；若要修，应另开缺陷，不要借折叠改动状态口径。
- 并行修改提醒：本次勘察 22:33→22:37 期间 `client.ts` 从 1367 行变为 1384 行，接线是并行落地的；实现/复核前先重新 `shasum` 与 `grep` 确认当前接线，不要只信本文行号。

---

## 11. 不做项清单（防止过度设计）

- 不做跨刷新/跨标签页记忆。
- 不做“全部展开/全部收起”。
- 不做第三级折叠（步骤列表整体、单条具体工作）。
- 不做面板高度动画、不做滚动定位/吸顶。
- 不改统计口径、不改 `phase` 判定、不改接口、不加新依赖。
- 不新增 locale 文案（本规格复用现有键：`panel`、`scopeThis`、`stats.done`、`stats.blocked`、`phase.*`、`steps`、`stepPrefix/stepSuffix`、`updatedAt`、`helpDone`）；如未来要显示“共 N 步”，需同时补中英文并处理英文单复数，本期不需要。

---

## 12. 未验证与风险

| 项 | 状态 |
|---|---|
| 线上真实 DOM / 像素 / iPhone 真机 | **未验证**（面板需登录，T1 实测未登录 401） |
| 4 秒轮询下展开状态保持 | 代码推演为保持（稳定 key + 非受控 state），未在真实页面计时验证 |
| 读屏软件实际播报 | 未用 VoiceOver/NVDA 实测，仅按 ARIA 规范与组件结构检查 |
| 并行工作流继续改文件 | 可能存在；以最终 `shasum` 与测试结果为准 |
| 空步骤边界 | 已发现，属既有逻辑，未修改 |

**风险控制**：本规格的核心是把“折叠”与“统计/状态”解耦——摘要只读既有数据源，折叠只改可见性。只要实现遵守 §4.3 与 §5，就不会再出现此前“4 件 / 5 件 / 12 件”口径混用的回归。
