# T1 定位报告 — dsh-workplan「画圈进度区」（2026-10-28）

状态：**定位完成，未改动任何代码。**
插件根：`<repo>`，当前版本 **1.4.3**。
运行侧：`~/.dsh/profiles/web/package.json:18` 以 `link:<repo>` 挂载，`:44` bundles 启用；`node_modules/dsh-workplan` 为指向该目录的符号链接（`package.json` 版本同为 1.4.3）。

---

## 0. 证据与前提

- 用户截图：`~/.dsh/attachments/v1/objects/84/848e3c3789bb1a6e997f5cc311b55748c183e93f158a8aae35320371a0e40228`
  JPEG 1320×2665，mtime 2026-10-28 13:34，早于本会话开始（13:35），画面内容与任务描述「画圈」一致。
  **该截图未随子任务正文下发，归属未由用户直接逐字确认**（按时间 + 内容匹配判定）。
- 视口推断：1320 / 3 = **440 CSS px**（DPR 3），命中 `@media (max-width: 600px)`，故统计条 2 列、计划卡单列。
- 截图中统计条：2 个任务 / 12 分配工作 / 0 做好了 / 2 正在做 / 0 卡住了。
- 红色手绘圈 3 处，对应关系见 §2。截图中文字与 1.4.3 布局一致；**未逐字节验证截图对应的构建产物**。

---

## 1. 版本与构建事实

| 项 | 路径 / 值 |
|---|---|
| 版本号（包） | `package.json:3` → `1.4.3` |
| 版本号（代码内） | `src/host.ts:328` → `version: '1.4.3'`；`lib/host.js:297` 同值 |
| 类型 | 全部源码为 TypeScript：`src/client.ts`、`src/plan.ts`、`src/runtime.ts`、`src/host.ts`、`src/watchdog.ts`、`src/globals.d.ts` |
| 编译 | `tsconfig.json`：`strict: true`、`target ES2022`、`module/moduleResolution NodeNext`、`rootDir src`、`outDir dist` |
| 构建 | `npm run build` = `tsc` → 复制 `dist/client.js` 到根 `client.js`，`dist/{plan,runtime,host,watchdog}.js` 到 `lib/` |
| 依赖 | `chart.js ^4.6.1`（已存在，非新增候选） |
| 仓库 | 插件目录**无 .git**；备份走 `.backups/*.tar.gz` |
| 当前快照哈希 | `package.json` 8f865285…f6912e；`src/client.ts` 62aa22fe…d8937f3；`client.js` 0c3ffd34…5acd15d；`lib/host.js` f87b9eab…f6912e |

---

## 2. 画圈区域 → 源码映射（核心结论）

三处圈都是**折叠态计划卡的 meta 行**与**组头摘要/空态**，不是图表本身。

| 圈 | 截图内容 | DOM / 组件 | 源码位置 | 当前形态 |
|---|---|---|---|---|
| ① | 第 1 张卡「dsh 插件多通道版本发布一致性方案…」下的「本计划 0/8 做好了」+「0 卡住了」 | `SessionCard` → `Collapse` 折叠头 `.dsh-wp-collapse-meta` | `src/client.ts:1356-1361`（scope 1357、迷你条 1358-1360、blocked 1361） | 12px 次要色文字 + 54×5px 迷你条（0% 时不可见） |
| ② | 第 2 张卡「核查 1.1.9 是否已进入 CDN 插件索引」下的「本计划 0/4 做好了」+「0 卡住了」 | 同上 | 同上 | 同上 |
| ③ | 「已完成」组组头「未完成 0 / 已完成 0（完成率暂无数据）」+ 空态「还没有完成的任务」 | `SessionGroup` 组头摘要 + 空态 | 摘要 `src/client.ts:1671-1673`、渲染 1698；空态 1732 | 12px 次要色文字（nowrap + ellipsis）+ 13px 空态文字；右侧 44px 环显示「—」 |

> 圈①的红线压到了标题末行（「不执行发布）」），但从笔画包围范围与两圈一致性看，主体是标题下方的进度 meta 行；这一点**建议主 Agent 向用户复述确认一次**。

---

## 3. 渲染管线（从挂载到画圈元素）

1. **面板挂载**：`src/client.ts:2148-2155` `ctx.slots.inject('main')` → `key: 'workplan'` → `GuardedDashboard`（注册于 2119）。
2. **数据轮询**：`Dashboard`（1832）→ `usePlans`（1176）→ `fetchPlans`（1161-1174）请求 `GET /dsh-workplan/plans`，4s 一轮。
3. **顶部统计条**：`src/client.ts:1947-1952`，5 格**纯数字**（任务数 / 工作项 / 做好了 / 正在做 / 卡住了）；1948-1952。
4. **分组**：`src/client.ts:1957-1959` 渲染 `SessionGroup('live')` 与 `SessionGroup('done')`。
5. **组头**：`SessionGroup`（1646-1734）：
   - 聚合 `groupTotals(list)`（1668 → 1574-1600）；
   - 摘要句 `summaryText`（1671-1673）；
   - 组头 children（1687-1698）：圆点、标题、计数、告警、**`GroupRing`（1694）**、chevron、**摘要 span（1698）**；
   - 空态（1732）：`groupDoneEmpty` / `groupLiveEmpty`。
6. **计划卡**：`SessionCard`（1336-1409）：`stats`/`percent`（1344-1347）→ `Collapse`（1349）→ **meta 数组（1356-1361）**；展开后才有 `Progress`（1374）与「总体进度 X%」（1375-1378）。
7. **折叠容器**：`Collapse`（1088-1176）：按钮 1134-1152 内依次是 chevron、title、**meta（1145）**、badge；面板 `hidden: !open`（1155-1157）——默认折叠，所以画圈 meta 就是用户第一眼看到的全部进度信息。
8. **图表（在两组之后）**：`Dashboard` 1963-1966 的 `Donut`（1736-1799，132px SVG）+ `TaskBars`（1800-1831，8px 横向条）；1969 的 `GroupCharts`（1425-1553，动态加载 `/dsh-workplan/vendor/chart.umd.js` 的 Chart.js 4.6.1，含 fallback）。

**结论：截图中 440×888 的首屏只包含「5 格数字 + 两行说明 + 组头（含 44px 环）+ 计划卡 meta 文本」；真正的 Chart.js 图表在两组之后，首屏不可见。**

---

## 4. 当前进度数据结构

服务端 `serialisePlan`（`src/runtime.ts:848` 起）每 4s 下发的关键字段：

```ts
// src/plan.ts:1111
interface StatusEntry { subtaskId; stageId; title; department; role; status; progress; childId; startedAt; finishedAt; summary; error }
// src/plan.ts:1128
interface Stats { total; done; blocked; inProgress; pending; progress }
// src/plan.ts:1147
interface PlanSnapshot { statuses: StatusEntry[]; stats: Stats; departments: DepartmentSummary[] }
```

- `serialisePlan` 顶层返回（`src/runtime.ts:872` 起）：`sessionId / planId / title / phase / degraded / error / errors / createdAt / updatedAt / createdTurn / plan / statuses / stats / heartbeatAt / resumeCount / resumeLimit / resumeAvailable / dispatchElapsedMs / departments / taskUnderstanding / contradictions / stages / risks / verification`。
- `stats` 由 `derivePlanSnapshot(statuses)` **单次派生**（1.4.3 起无缓存，`record.stats` 已删除）；`stats.progress` 是加权进度，`done/total` 是完成计数，两者不等价。
- 前端 `groupTotals`（`src/client.ts:1574-1600`）只读各会话 `session.stats` 求和：
  `open = total - done`（1594）；`percent = total > 0 ? Math.round(done/total*100) : null`（1595）。
- 卡片 `percent = Math.round(done/total*100)`（1347），仅在迷你条的 `title` 属性中出现（1358）与 fill 宽度（1359）。
- 空组 → `percent === null` → 走 `groupSummaryNoRate`（「完成率暂无数据」），即圈③文案来源。
- `GET /dsh-workplan/plans` 需登录态；未登录返回 401 `{"ok":false,"error":"未授权的请求"}`。

---

## 5. 为什么「不醒目」——基于代码事实

1. **迷你条轨道与折叠按钮同色**：`.dsh-wp-mini` 轨道 `background: var(--dsw-alias-bg-layer-2)`（`src/client.ts:626`），折叠按钮底色同为 `var(--dsw-alias-bg-layer-2)`（`:759`）。0% 时 fill 宽度 0，整条 54×5px 轨道与按钮底色重合 → **肉眼完全不可见**（与截图一致）。
2. **尺寸极小**：54×5px（623-624），无任何文字标注；百分比只写在 `title`（1358），触屏无 hover，永远看不到。
3. **文字是 12px 次要色**：`.dsh-wp-collapse-meta`（783）`font-size:12px; color: label-secondary`；「本计划 0/8 做好了」是直白文本，没有图形比例、没有百分比。
4. **组摘要同为 12px 次要色且尾部截断风险**：`.dsh-wp-group-sub`（432）`12px; nowrap; ellipsis`，完成率 `{pct}%` 恰在句尾（1671-1673），窄屏先被省略号吃掉。
5. **组头环太小且 0% 无弧**：`.dsh-wp-group-ring` 44×44px、label 11px（408-412），`aria-hidden`；0% 时弧长 0，只剩灰轨道 +「0%」/「—」。
6. **图表在第一屏之外**：`GroupCharts` 固定排在两组之后（1967-1969），移动端首屏看不到；首屏唯一图形是组头环。
7. **顶部统计条无完成率**：1947-1952 只有 5 个数字，没有百分比/图形；「0 做好了」与「2 正在做」只能靠颜色和数字自行换算。
8. **空组摘要语义噪声**：空「已完成」组仍渲染「未完成 0 / 已完成 0（完成率暂无数据）」（1671-1673 + 1732），圈③正是这一行——对用户没有信息量却占据组头位置。

补充（非画圈直接原因，但影响观感）：`linear-gradient` 尚有 9 处、`.dsh-wp-group--done { opacity: .97 }`（659），与 `docs/visual-refinement-spec.md` 的零渐变/禁 opacity 目标态不一致。

---

## 6. 现有图表资产与依赖策略事实

- **Chart.js 4.6.1 已是依赖**，由 `GroupCharts` 动态 import `/dsh-workplan/vendor/chart.umd.js`（1425 起；canvas 1526、1543），并有纯 HTML fallback 条并存策略（443-445）。
- **零依赖图形已存在**：`GroupRing`（内联 SVG 双圆，1609-1644）、`Donut`（1736）、`TaskBars`（1800）、`Progress`（1023）。
- 因此后续改造**不需要新增第三方依赖**（Chart.js 或内联 SVG 均可），但「图表形式/放置位置」属需求决策，须由用户确认（T2）。

---

## 7. 复核命令（可直接复制）

```bash
cd <repo>

# 1) 版本与挂载
node -e "const p=require('./package.json');console.log(p.version,p.main)"
grep -n "version: '1.4.3'" src/host.ts lib/host.js

# 2) 画圈①：卡片 meta（scope / mini / blocked）
sed -n '1356,1361p' src/client.ts

# 3) 迷你条轨道与按钮同色（两处都应为 --dsw-alias-bg-layer-2）
sed -n '621,630p;749,760p' src/client.ts

# 4) 画圈③：组摘要与空态
sed -n '1671,1673p;1694,1698p;1730,1733p' src/client.ts

# 5) 图表位置（在两组之后）
sed -n '1957,1969p' src/client.ts

# 6) 类型检查（不产生构建产物）
npm run check

# 7) 截图文件与时间（用于复核圈选区域）
ls -l ~/.dsh/attachments/v1/objects/84/848e3c3789bb1a6e997f5cc311b55748c183e93f158a8aae35320371a0e40228
```

---

## 8. 未验证 / 待用户确认

1. **截图归属**：未随任务消息下发，按时间与内容匹配；需主 Agent 复述三处圈选区域，请用户确认。
2. **图表形式与位置**：内联 SVG 环/条 vs 复用 Chart.js；放在卡片折叠头、组头，还是顶部统计条；是否保留纯文本百分比（可访问性冗余）——属 T2 需求澄清。
3. **是否顺带改顶部统计条/总览区**：用户未圈，不能擅自扩大范围。
4. **截图对应构建版本**：布局与 1.4.3 源码一致，但未对运行中实例做 DOM 级核验。
5. **运行实例的改动生效方式**：插件通过 link 挂载，构建后是否需重启 DSH Web / 刷新页面，由主 Agent 按运行环境确认（该步骤不在本子任务权限内）。

---

## 9. 建议改造落点（仅供 T2 决策，本子任务未实施）

- **主落点**：`SessionCard` 折叠头 meta（`src/client.ts:1356-1361`）——加可见百分比 + 更高对比度/更大尺寸的进度条或环，0% 时轨道也必须可见。
- **次落点**：`SessionGroup` 摘要（1698）——用图形化比例替代/伴随 12px 文本；空组隐藏「完成率暂无数据」。
- **可选**：把总览图表的轻量版（如每计划条）上移到首屏可用位置；需用户确认，避免整体重排。
- **约束**：百分比必须有文本（WCAG 1.4.1 冗余编码）；沿用现有 CSS 变量支持深/浅主题；不改服务端 stats 语义；版本号必须递增（当前 1.4.3）。
