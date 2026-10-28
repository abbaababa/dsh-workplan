# dsh-workplan 视觉精修规范（可施工版）

> 适用对象：侧栏「任务进度」面板（`dsh-workplan` 1.4.x）。本文只写**数值与位置**，每条都能落到现有 DOM/class，工程师不需要二次翻译。
> 快照：`src/client.ts` 2153 行，13:31:27 修改，sha256 `8148e213d7fd7d5175b0a47528aa2931a9b548f5f7a31cc44d3a9757f205e0a1`。该文件正被另一个实现 Agent 并发修改（13:25→13:31 已先后落地徽章底色、去 opacity、组头摘要、零依赖进度环）。本文是**目标态**；带「现状」的条目表示截至该快照尚未达标，行号会随后续编辑漂移，以选择器为准。
> 度量口径：WCAG 2.x，`L=0.2126R+0.7152G+0.0722B`，半透明按 `fg·α+bg·(1−α)` 合成后再算。浅色组底 `#fafafb`、卡片 `#ffffff`；深色组底 `#1b1c1f`、卡片 `#232324`。

## 0. 一页速查（所有关键数值）

| 维度 | 值 |
|---|---|
| 间距节奏 | 4 的倍数：4 / 8 / 12 / 16 / 20（详见 §2） |
| 字阶 | 11 / 12 / 14 / 16 / 24（组件标题 11、元数据 12、组标题 14、卡片标题 16、环心 24 或 11） |
| 字重 | 400 / 600 / 700，**不再新增 650** |
| 圆角 | 999（胶囊）/ 16（组）/ 14（卡片、图卡、环卡）/ 10（输入与按钮）/ 4（进度） |
| 分隔 | 只有 1px 发丝线；**零阴影、零容器透明度** |
| 填充 | **零渐变**（`grep -c linear-gradient` 必须为 0） |
| 边线信号色 | 浅色橙 `#ea580c`(3.41:1)/蓝 `#0284c7`(3.93:1)；深色 `#fb923c`(8.06)/`#38bdf8`(8.51) |
| 文本 | 一律 `--dsw-alias-label-primary`；次要 `--secondary`(5.56:1)；**禁用品牌色写 12px 文字**（2.77–2.80:1） |
| 动效 | 脉冲 2.4s、chevron 160ms、进度 240ms、图表 320ms；折叠瞬时；全部有 reduced-motion 降级 |
| 图表 | Chart.js 4.6.1，两张卡放在两组**之后**，canvas 高 140，回退态同高（零 CLS） |

## 1. 三条不可协商

1. **可度量**：文本 ≥4.5:1，≥3px 的图形/边线 ≥3:1，焦点环 ≥3:1。达不到就换色阶，不靠"看起来还行"。
2. **不依赖颜色**：组别由「位置 + 文案 + 圆点/环/对勾 + 导轨」四重编码；状态胶囊的文字必须是主文本色，颜色只做点与底。
3. **不打扰**：不写用户偏好、不弹窗、不抢焦点、不自动滚动、轮询刷新不重播动画、不加新依赖。

## 2. 间距与几何（节点 → 属性 → 值）

| 节点（class） | 属性 | 规范值 | 现状/差异 |
|---|---|---|---|
| `.dsh-wp-groups` | gap | 16px | 20px → 16px，两组更成一体 |
| `.dsh-wp-group` | padding / radius | 12px 12px 8px / 16px | 14 14 6 → 12 12 8 |
| `.dsh-wp-group` | border | 1px `var(--dsh-wp-line)` | 现用不存在的 `--dsw-alias-line-1` 吃 fallback，改为显式 token |
| `.dsh-wp-group` | background | `rgba(148,163,184,.05)` | 保留（合成后 #fafafb / #1b1c1f） |
| `.dsh-wp-group` | box-shadow | **none** | 现状 646 行有双层投影 → 删；深度只由发丝线+底色承担 |
| `.dsh-wp-group--done` | opacity | **禁止** | 现状 651 行 `opacity:.97` → 删。容器透明度会等比压低所有文字对比度，且使测值随主题漂移 |
| `.dsh-wp-group::before` | 导轨 | 3px，`inset:12px auto 12px 0`，圆角 `0 3px 3px 0`，实色 `--dsh-wp-*-ink` | 现状渐变（浅端 2.1:1）→ 实色 |
| `.dsh-wp-group-head` | padding / gap | `0 4px 8px` / `8px` | 现 `0 4px 6px`，底部补到 8 |
| `.dsh-wp-group-head` | 布局 | 两行：行 1 = 点+标题+计数+需处理+环+chevron，行 2 = 摘要（`flex:0 0 100%`） | 已实现，保留 |
| `.dsh-wp-group-body` | gap | 8px | 10px → 8px |
| `.dsh-wp-session` | padding / radius / border | `0` / 14px / `1px var(--dsw-alias-border-l2)` | 16 内边距 + 16 圆角 + l1 边框 → 单框 |
| `.dsh-wp-session` | 顶条 | 3px `--dsh-wp-*-ink`（done/active）、error/warn token | 现用填充色 2.77/2.80 → 换 ink |
| `.dsh-wp-collapse-toggle` | padding / min-height / radius | `12px 16px` / 44px / `13px 13px 0 0` | 现 7 10；与卡合并后需 16 对齐标题 |
| `.dsh-wp-group--done .dsh-wp-collapse-toggle` | padding | `10px 16px` | 已完成行更紧凑（设计稿 52 → 44，触控下限） |
| 卡片详情面板 | padding | `0 16px 16px` | 卡片改单框后去掉重复内边距 |
| `.dsh-wp-pill` | 尺寸 | 高 20，`padding:0 8px`，11px/600，radius 999 | 现 26 高 / 12px → 收紧 |
| `.dsh-wp-chart-card` | padding / radius | `10px 12px` / 14px | 12 14 10 / 16 → 与卡片同圆角 |
| `.dsh-wp-chart-canvas` | height | 140px | 200px → 140px |
| `.dsh-wp-chart-card` | 回退态高度 | 与 canvas 同高（140） | 现状回退态矮 → 图加载后跳 ~140px（CLS）。**必须等高** |
| `.dsh-wp-mini` | 尺寸 | 56×4，四段，段间 2px | 现 54×5 单色 → 四段 |

## 3. 字体

| 用途 | 字号/字重 | 说明 |
|---|---|---|
| 组标题 `.dsh-wp-group-title` | 14/600 | 现 15/700；回到 4px 字阶，与 16px 卡片标题拉开层级 |
| 卡片标题 `.dsh-wp-session-title` | 16/600 | 现 650 → 600（字重表只留 400/600/700） |
| 组摘要 `.dsh-wp-group-sub` | 12/400，line-height 1.45 | 承载完成率，11px 在 292px 宽下不可读 |
| 计数徽章、元数据、section 标题 | 12/600、12/400、12/600 | 徽章、时间、部门等 |
| 胶囊、需处理、图卡标题、图例、轴标签 | 11/600 或 11/400 | 图例/轴用 400 |
| 环心 `.dsh-wp-group-ring-label` | 11/700（≤360px 时 10/700） | tabular-nums |
| 所有数字 | `font-variant-numeric: tabular-nums` | 已有，保留 |

## 4. 组头（结构已定，这里只锁数值）

DOM（`src/client.ts` 约 1649–1671）：`button.dsh-wp-group-head.dsh-wp-group-head--btn[aria-expanded][aria-controls]` > 点 / `span[role=heading][aria-level=2]` / 计数 / 需处理 / 环 / chevron / 摘要。live 组用 `div.dsh-wp-group-head`（无按钮、不可折叠）。

- `h2` 不得放进 `button`（内容模型非法）→ 用 `span[role=heading][aria-level=2]`，视觉与 class 不变。**已落地，保留**。
- 环：`44×44`，`stroke 4`，`stroke-linecap:round`，`transform:rotate(-90)`，轨 `rgba(148,163,184,.28)`，弧 `--dsh-wp-*-ink`，`aria-hidden="true"`；百分比文字必须在摘要里重复一次（不能只靠环）。≤360px：36px / stroke 3.5 / label 10。
- 计数徽章：12/600，高 20，`padding:0 7px`，`min-width:22px`，`14%` 语义底色 + `inset 0 0 0 1px` 同色 34%（实测主文本压底 15.76:1，已达标）。**徽章保留纯数字**，单位 `个任务` 只进 aria/摘要（292px 内容宽下 "3 个任务"+环+需处理会换行）。
- 需处理：11/600，高 20，`padding:0 8px`，红 12% 底，文字 `color-mix(80% error, 20% primary)`（实测 5.16/5.67:1，已达标，勿回退成纯 error 色 → 3.67:1 不合格）。
- 摘要文案（**完成率必须排在最前，避免省略号吃掉关键数字**）：
  - 进行中、无卡住：`完成 {pct}% · {doing} 件正在做 / {total} 件工作`
  - 进行中、有卡住：`{blocked} 件卡住 · 完成 {pct}%`
  - 已完成：`全部完成 · 最近完成：{title}` 或 `{done}/{total} 件已完成 · 最近完成：{title}`
  - 无工作项：`暂无工作项`
  - 单行 + `text-overflow:ellipsis` + `title` 全文；≤320px 允许两行（`-webkit-line-clamp:2`），因为 292px 下当前 nowrap 会把 `%` 截掉。

## 5. 卡片

- 单框：`article` 去掉 16 内边距 → toggle 12/16、详情面板 `0 16 16`；卡片与 toggle 不再有"卡中卡"的双层底与双圆角。
- 已完成行：`10px 16px`、`min-height:44px`、标题单行省略（`title` 属性带全文）；不整组降透明度。
- 摘要行保留「本计划 X/Y 做好了」「N 卡住了」（测试断言）。
- `.dsh-wp-mini` 改四段：`done`（`--dsh-wp-done`，测试锁定该 class 与变量）/ `doing`（`--dsh-wp-active`）/ `blocked`（error）/ `pending`（idle），宽度按 `stats` 占比取整，最小 2px，段间 2px；右侧文字仍是 `X/Y 做好了`（形状 + 文字双编码）。
- 胶囊：文字 `--dsw-alias-label-primary`（现 done/active 用品牌色 2.77/2.80:1，**不合格**），底 `10%` 语义色，边框 `1px 28%`；圆点 6px 用 `--dsh-wp-*-ink`。

## 6. 图表

**位置**：`GroupCharts` 移到两组**之后**（`Dashboard` 中与 `.dsh-wp-groups` 同级、后置）。理由见 §8 第 12 条：两张卡各 ≈246px，现排在组前，首屏 500px 内看不到任何一张任务卡。

- 只保留"两组占比"环形图；"进行中计划完成度"横向条与顶部 `TaskBars` 重复，删卡（若必须保留，两卡 canvas 均为 96，总高 ≤260）。
- 卡：radius 14、`1px border-l2`、`padding 10 12`、标题 11/600 secondary、**无渐变底、无标题前色块**（现 656–661 行有渐变小方块，浅端 2.1:1，删）。
- canvas：140px；`responsive:true`、`maintainAspectRatio:false`。
- 环：`cutout:'70%'`、`borderWidth:0`、`spacing:0`、`hoverOffset:0`、`animation:{duration:320,easing:'easeOutCubic'}`。
- 颜色：`['--dsh-wp-active-ink','--dsh-wp-done-ink']` 实色（不用渐变）；`Chart.defaults.font.family = getComputedStyle(document.body).fontFamily`，size 11；`Chart.defaults.color = secondary`。
- 图例：HTML 里的 `.dsh-wp-overview-legend` 已有，图表卡内用 `generateLabels` 把数量拼进 label（`进行中 3`），`boxWidth:8`、`usePointStyle:true`、`pointStyle:'circle'`、`padding:8`、`color:secondary`。
- 网格：`rgba(148,163,184,.16)`；轴标签 11/400 secondary（现在是主文本色，权重过强）。
- 主题切换：颜色来自 `getComputedStyle`，只在重建时读取 → 用 `MutationObserver` 监听 `body[data-ds-dark-theme]`，把主题键放进 effect deps；否则切深色后图例仍是 #61666b（深底 2.9:1，**不合格**）。
- 回退态（chart.js 未加载）：固定 140px 高，条形 8px 高、实色、图例 11px secondary，与 canvas 态等高。

## 7. 动效与深色

| 动效 | 值 | reduced-motion |
|---|---|---|
| 进行中脉冲 | 2.4s ease-in-out infinite，光晕 4px 16% → 6px 4% | 关闭，光晕静态 4px |
| 折叠 chevron | 160ms transform | none |
| 环弧 | stroke-dasharray 280ms | none |
| 进度/迷你条宽度 | 240ms ease-out | none |
| 图表 | 320ms（仅首绘） | `animation:false` |
| 折叠显隐 | **瞬时**（`display:none`） | 天然满足 |

- 禁止：入场动画、hover 位移、阴影过渡、呼吸之外的循环动画、`prefers-reduced-motion` 下任何位移/缩放。
- 深色：`body[data-ds-dark-theme] .dsh-wp{ --dsh-wp-done-ink:#38bdf8; --dsh-wp-live-ink:#fb923c; --dsh-wp-hover:rgba(148,163,184,.12); }`；面用 layer-1（卡片 #232324 比组底 #1b1c1f 亮一级，深色下层级天然成立）；文字/发丝线全部走 alias token，不写死浅色值。
- 焦点：组头 `outline:2px solid var(--dsw-alias-label-primary); outline-offset:2px`（现用 `--dsh-wp-done`，2.77:1 <3:1，**不合格**）；卡片 toggle 已是 brand-primary，保持。

## 8. 与设计稿（docs/status-grouping-ia.md §6.4）的逐条差异

| # | 设计稿 | 本规范 | 原因 |
|---|---|---|---|
| 1 | 组头 44px 环 | **采纳**（44 / stroke 4 / 窄宽 36） | 已落地且零依赖；stroke 4.5→4 是 44px 下更稳的视觉重量 |
| 2 | 环心 13/700 | 11/700 | 44px 环内 13px 会挤压弧线；百分比在摘要里已重复 |
| 3 | 组头 min-height 64 | 无固定值（环 44 + 摘要行 ≈70） | 行高由环决定，写死 64 会多出空白 |
| 4 | 已完成行 min-height 52 | 44 | 44 是触控下限，与 toggle 一致；密度更高 |
| 5 | 计数徽章 layer-2 底 | 14% 语义色 + 主文本 | 浅色 layer-2 = `#ffffff`，与组底同色，徽章会消失 |
| 6 | 已完成组用 layer-2 做背景层级 | 蓝导轨 + 环 + 紧凑行 + 默认折叠 | 同上：浅色两主题 layer-1/2 都是 #fff；层级改用形状与密度 |
| 7 | 折叠动画 grid-rows 220ms | 瞬时 | 组高不确定、4s 轮询会抖；reduced-motion 天然满足。代价：观感略硬，由 chevron 旋转补足 |
| 8 | 计数文案「{n} 个任务」 | 徽章纯数字，单位进 aria/摘要 | 292px 内容宽下「3 个任务」+环+需处理会换行 |
| 9 | 副行 11/400 | 12/400 单行 | 副行现在承载完成率，11px 不可读 |
| 10 | 四段条在卡片摘要 | 采纳，56×4、段间 2 | 与设计一致；组头让位给环 |
| 11 | 零依赖图表 | Chart.js 4.6.1（用户已选 B），同时给 SVG 回退参数 | 与总任务描述里的"零依赖"冲突，见 §11 |
| 12 | 图表在组上方 | 移到两组之后 | 两卡 ≈500px，首屏看不到任务，直接违背"一目了然" |

## 9. 落地难度与顺序

| 顺序 | 改动 | 难度 | 风险 |
|---|---|---|---|
| 1 | 删 `.dsh-wp-group` 阴影、`--done` 的 `opacity:.97`、全部 `linear-gradient`；导轨/顶条/图例改实色 ink | 低（纯 CSS） | 视觉变"平"，属预期 |
| 2 | 间距/圆角/字阶按 §2 §3 | 低 | 触发若干快照式测试，重跑 `npm test` |
| 3 | 胶囊文字改主文本色、组头焦点环改 primary | 低 | 无 |
| 4 | 组头摘要文案顺序（完成率前置）+ 窄宽两行 | 低（改 locale 串） | 与已实现文案不同，需同步 zh/en |
| 5 | 卡片单框 + 已完成紧凑行 + 四段迷你条 | 中（JSX + 宽度计算） | `.dsh-wp-mini-fill--done` 已被 `status-colors.test.ts` 锁定，class 不能改名 |
| 6 | 图表后置、canvas 140、回退等高、轴/图例降级为 secondary | 中 | `client-render.test.ts` 只断言文案与 `<svg>` 存在，不校验顺序；仍建议重跑 |
| 7 | `container-type:inline-size` + `@container` 两档 | 中 | 现有 `@media (max-width:600px)` 按视口，侧栏里永不触发；改为容器查询后才能测 |
| 8 | 深色主题切换重建图表 | 中 | 需 `MutationObserver`，注意卸载时断开 |

## 10. 验收（可复现）

1. `npm test` → 现有 67 条必须全过（新增项另计）。
2. CSS 断言（建议加进 `tests/`，与 `status-groups.test.ts` 同风格）：
   - `src/client.ts` 中 `linear-gradient` 次数为 **0**；`opacity: .97` 为 **0**；`box-shadow: 0 1px 0` 为 **0**。
   - 行首基础声明各只允许 **1** 处（截至快照各为 2 处，重复定义会让后写的规则静默覆盖前一条）：`^\.dsh-wp-group {`、`^\.dsh-wp-group-count {`、`^\.dsh-wp-group-sub {`、`^\.dsh-wp-group--live::before`、`^\.dsh-wp-chart-card {`。当前实测各 2 处（如 414/654、424/655、385/649）。
   - `.dsh-wp-pill.dsh-wp-tone-done` / `--active` 的 `color` 为 `label-primary`，且 `--dsh-wp-active` 变量仍被 `.dsh-wp-pill.dsh-wp-tone-active` 子节点引用（`status-colors.test.ts` 的既有正则不可破）。
   - `.dsh-wp-session` 的 `border-top-color` 使用 `--dsh-wp-done-ink` / `--dsh-wp-live-ink`。
3. 对比度（用 §0 公式复算，目标值见 §3/§4）：组标题 18.12、摘要 5.56、徽章 15.76、需处理 5.16、卡片标题 18.90、元数据 5.80、焦点环 18.12；深色对应 16.30 / 11.31 / 13.38 / 5.67 / 15.03 / 10.42。
4. 目视（需要主 Agent 重启后执行，本人不能重启）：深色切换、`prefers-reduced-motion` 下无动画、292px 宽下摘要不被截断、折叠/展开不重挂卡片、0 项组显示空态。

## 11. 需要主 Agent 决定 / 无法在本会话验证

1. **零依赖 vs Chart.js**：总任务描述写"零依赖图表"，但 1.4.0 已依赖 `chart.js@4.6.1`，用户也选了 B 引入图表库。本规范按 Chart.js 施工，同时给 SVG 回退参数；若要回到零依赖，删依赖与 canvas，用同色同尺寸渲染即可，不影响其余数值。
2. **`--dsw-alias-line-1` / `--dsw-alias-bg-elevated` 在主题包里不存在**（各 0 次出现），现有组卡一直在吃 fallback。本规范改为显式 `--dsh-wp-line`，避免主题升级后边框突然消失。
3. **越界项未修**：`.dsh-wp-stat--done/active` 的 18px 数字仍用 `#0ea5e9`/`#f97316`（2.77/2.80:1）。`tests/status-colors.test.ts` 锁定了变量值与选择器，单改样式会破坏测试；要修必须同时改测试与色阶，建议单独立项。
4. **无法目视验证**：本会话不能重启 `dsh web`、不能截图。所有"外观"结论均由源码行号 + WCAG 计算支撑；重启后需要按 §10.4 逐条目视核对（建议由主 Agent 出一张核对表）。
5. **构建产物**：`dist/client.js` 与根 `client.js` 需 `npm run build` 重新生成；本会话不执行构建/重启。
