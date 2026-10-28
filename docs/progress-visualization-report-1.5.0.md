# dsh-workplan 1.5.0 改造说明：让执行进度一眼可见

> 版本：1.5.0（1.4.3 → 1.5.0，minor）
> 日期：2026-10-28（Asia/Shanghai）
> 范围：只改进度**展示层**（`src/client.ts` + 测试 + 版本文件 + 文档），`plan.ts` / `runtime.ts` 零改动，顶部 5 格统计条与两组之后的图表原样保留。
> 证据：`npm run check` exit 0；`npm test` **99 / 99 通过**；离线对比页 `docs/preview/progress-visual-1.5.0.html`；回滚快照 `.backups/v1.4.3-progress-viz-code-20261028-142153.tar.gz`（SHA-256 `c79513f5c0279e3bb291d536fba7a631fa8018e27bc7d4fca500fbabd9e602da`）。

---

## 1. 问题（用户截图的三处红圈）

截图里被圈出的文字分别是：

1. 进行中计划卡：`本计划 0/8 做好了` / `0 卡住了`
2. 第二张计划卡：`本计划 0/4 做好了`
3. 已完成组头：`未完成 0 / 已完成 0（完成率暂无数据）` + `还没有完成的任务`

问题不是「数据不对」，而是「**看不见进度**」。改前实测的四个成因（全部可在 1.4.3 源码里复核）：

| 成因 | 1.4.3 的事实 |
|---|---|
| 没有图形，只有一行 12px 灰字 | `.dsh-wp-collapse-meta` 是 `font-size: 12px`、`label-secondary` 颜色 |
| 0% 时进度条整条消失 | `.dsh-wp-mini-fill` 宽度 = `percent%`，0% 时宽度 0；轨道用的 `--dsw-alias-bg-layer-2` 与折叠按钮底色是**同一个 token**，肉眼等于没有轨道 |
| 百分比只存在于 `title` 提示里 | `h('span', { className: 'dsh-wp-mini', title: '0%' })`，不悬停看不到 |
| 迷你条太小 | `54×5px`，放在 44px 高的折叠按钮里几乎不可见 |

所以「0/8 做好了」在屏幕上和「0/4 做好了」长得一样，用户无法在扫视时判断“到底动了没有”。

## 2. 改了什么（四层可见信号，折叠状态就看得见）

折叠卡头部（默认状态）现在是**四层冗余信号**，任何一层失效都还有另外三层：

1. **44px 圆环 + 24px 大号百分比**：`0%` 以 24px/700 常量数字显示在环旁，不再依赖悬停；
2. **四段构成条（8px 高、整行宽）**：做好了 / 正在做 / 卡住了 / 还没开始 各占一段，**0% 时整条是灰色「还没开始」，不会消失**（轨道 `rgba(148,163,184,.22)`，0% 计划另加 `data-zero="true"` 用深一档轨道 `rgba(100,116,139,.80)`）；
3. **11px 状态图例**：`做好了 0 · 正在做 1 · 卡住了 0 · 还没开始 7`，数字是文本，可读屏、可复制；
4. **6px 阶段步进条**：每个阶段一段，当前阶段有橙色描边、`data-current="true"`；卡住阶段用错误色内描边。

再补一行 **现在在做什么**：`正在做 · 改客户端`（有卡住则优先显示 `卡住了 · 标题`），回答“它现在到底在干嘛”。

展开后多一块 **分步进度 / Step progress**：每个阶段一行（7px 状态点 + 阶段名 + 48px 细条 + `2/3` + `正在做`），当前阶段橙色底。

组头（第二处 + 第三处红圈）：

- 组环在 0 条工作时加粗轨道并放大百分比（`data-zero="true"`），不再是一个空环；
- **0/0 的组不再输出「未完成 0 / 已完成 0（完成率暂无数据）」这句话**（用户选择：去掉这行，只留清晰空态），保留 `data-percent="none"` 与环里的 `—` 作为机器可读标识；
- 有数据的组保留原文案（`未完成 3 / 已完成 1（完成率 25%）`），测试仍覆盖。

### 数据映射（全部由既有字段派生，无新增接口）

```
total   = max(0, Number(stats.total) || 0)
done    = clamp(done, 0, total)
blocked = clamp(blocked, 0, total - done)
active  = clamp(stats.inProgress, 0, total - done - blocked)
pending = max(0, total - done - blocked - active)
percent = total > 0 ? Math.round(done / total * 100) : null   // null 显示为 —
```

## 3. 改前 / 改后对照

离线对比页（同一份 CSS、同一套数据夹具，左旧右新）：

```
打开文件：docs/preview/progress-visual-1.5.0.html
重新生成：npm run preview
```

| 场景 | 1.4.3 看到什么 | 1.5.0 看到什么 |
|---|---|---|
| 0/8 刚开始 | `本计划 0/8 做好了` + 一条看不见的条 | `0%` 大号 + 灰色整条 + 图例全灰 + 第一个阶段橙色描边 + `正在做 · 列出文件` |
| 3/8 进行中 | `本计划 3/8 做好了` + 54×5px 小条 | `38%` + 蓝/橙/红/灰四段构成条 + 4 项图例计数 + 阶段步进条 |
| 有卡住 | `1 卡住了` 字样 | 红色 `卡住了 · 改客户端` 胶囊（`data-alarm="true"`）+ 该阶段红色内描边 |
| 已完成组 0 项 | `未完成 0 / 已完成 0（完成率暂无数据）` | 不再出现该句；环里 `—`，空态文案保留 |

## 4. 怎么看到效果（必须做这一步）

插件前端是 `client.js`，**DSH Web 启动时加载并缓存**，所以：

```bash
# 1) 重启 DSH Web（在运行 DSH 的终端按 Ctrl+C，再重新启动同一条命令）
# 2) 浏览器强制刷新 http://127.0.0.1:3080 （⌘⇧R）
# 3) 打开左侧栏「任务进度」，看折叠卡头部即可
```

不想重启也可以先看离线对比页（`docs/preview/progress-visual-1.5.0.html`，双击即可用浏览器打开，无需服务器）。

## 5. 验证记录（真实输出，可复跑）

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run check` | exit 0 |
| 全量测试 | `npm test` | `tests 99 / pass 99 / fail 0`（基线 90 + `progress-visual` 8 + `version-sync` 1） |
| 一键校验 | `npm run verify` | check + test 均通过 |
| 对比页重生成 | `npm run preview` | 写出 `docs/preview/progress-visual-1.5.0.html`，输出 `OK: 0/0 组不再出现「完成率暂无数据」` |
| 版本一致性 | `tests/version-sync.test.ts` | `package.json` = `package-lock.json`（两处）= `src/host.ts` 的 `meta.version` |
| 版本点人工复核 | `grep -n "1.5.0"` | 7 处：`package.json:3`、`package-lock.json:3`、`:9`、`src/host.ts:328`、`lib/host.js:297`、`dist/host.js:297`、`CHANGELOG.md:1` |

自动化验收项（`tests/progress-visual.test.ts`，8 项）：

1. 0/8：`data-percent="0"`、`data-zero="true"`、文本含 `本计划 0/8 做好了`、`data-kind="pending" data-count="7"`、**不含** `strokeDasharray`；
2. 3/8：`data-percent="38"`，四段计数之和 = 8；
3. 有卡住：`data-alarm="true"`、文本 `1 卡住了`、含 `卡住了 · 改客户端`、对应阶段 `data-tone="blocked"`；
4. 三阶段：恰好一个 `data-current="true"`；
5. 图例恰好 4 项，顺序与计数 `[0,1,0,7]`；
6. 折叠状态**不挂载**展开面板（源码断言 `open === true ? h(PlanOverview`）；
7. 脏数据（负数、缺字段、字符串数字）不出现 `NaN`/`Infinity`/`undefined`，百分比 ≤ 100；
8. 折叠卡头部不含 `canvas`/`Chart.`（图表仍只在两组之后，未抢主视觉）。

## 6. 版本、变更记录与回滚

- 版本：`1.4.3` → **`1.5.0`**（minor：用户可见的新增能力，对外载荷不变）；产物已重建（`client.js` 138195 字节、`lib/host.js` 14384 字节）。
- 变更记录：`CHANGELOG.md` 顶部 `## 1.5.0 — 2026-10-28`，含“零新增依赖”的真实表述（`node_modules` 里 `chart.js@4.6.1` 是 extraneous 残留，不参与构建；运行时图表库来自 `vendor/chart.umd.js`）。
- 回滚（二选一，都需要重建）：
  ```bash
  # A. git（仓库有 tag v1.4.3、跟踪 origin/main）
  git checkout -- .            # 放弃未提交改动
  # B. 快照（覆盖未跟踪文件与构建产物）
  tar -xzf .backups/v1.4.3-progress-viz-code-20261028-142153.tar.gz -C .
  # 两者之后都执行：
  npm run build && npm run verify
  ```
  完整策略见 `docs/version-upgrade-rollback-1.5.0-20261028.md`。

## 7. 已知限制（如实说明，不掩饰）

1. **没有浏览器截图**：本机 `qlmanage -t` 被沙箱拒绝（`sandbox initialization failed: Operation not permitted`），`/Applications` 下只有 Safari、无 Chrome/Chromium，GUI `http://127.0.0.1:3080` 未带凭据返回 HTTP 401。因此“改前/改后”证据是**同一份 CSS 渲染出的自包含 HTML 对比页**，不是 GUI 截图；GUI 里的最终目视效果需要用户刷新后确认。
2. **改动未提交**：`commit` / `tag` / `npm publish` 都**没有执行**（未获授权）。工作区当前是 1.5.0 的完整状态，可随时审阅或回滚。
3. **样式依赖宿主 token**：`--dsw-alias-*` 由 DSH Web 主题提供；离线对比页里用 14 个等价浅色值替代，深色主题下的对比由 `--dsh-wp-*` 自有 token 与 `state-*` 语义色保证，但未逐主题截图。

## 8. 文件清单

| 文件 | 变更 |
|---|---|
| `src/client.ts` | 新增 `PlanRing`/`PlanLegend`/`PlanSegments`/`PlanStepper`/`PlanViz`/`PlanOverview` 与 `planCounts`/`planStageRows`/`planNow` 等纯函数；`SessionCard` 接新头部；组头 0/0 不再输出“完成率暂无数据”；组环 0 值加粗；CSS 新增 `.dsh-wp-planviz*`/`.dsh-wp-stepper*`/`.dsh-wp-planoverview*`/`.dsh-wp-planrow*` 与 2 个 token；zh/en 各 2 个文案键 |
| `tests/progress-visual.test.ts` | 新增 8 项验收测试 |
| `tests/version-sync.test.ts` | 新增版本一致性测试 |
| `tests/group-summary.test.ts`、`tests/session-collapse.test.ts` | 同步新文案与新结构断言 |
| `scripts/render-preview.ts`、`scripts/fixtures/old-header-1.4.3.html` | 对比页生成器与旧版标记夹具 |
| `package.json`、`package-lock.json`、`src/host.ts`、`client.js`、`lib/host.js`、`dist/host.js` | 1.5.0 版本与重建产物；新增 `preview` 脚本 |
| `CHANGELOG.md`、`README.md`、`README.en.md`、本文、`docs/preview/progress-visual-1.5.0.html` | 变更记录、使用说明、对比证据 |
