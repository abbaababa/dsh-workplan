/**
 * Client half of dsh-workplan.
 *
 * Plain React only: no imports from DeepSeek Harness client packages. The
 * sidebar page, the inline turn card, and the two tool rows all read the same
 * same-origin host route and render defensively behind an error boundary.
 */

window.__ModuleLoader__.load({
  id: 'dsh-workplan',
  factory(require: any) {
    const React: any = require('react')
    const h = React.createElement as any as (type: any, props?: any, ...children: any[]) => any
    const PANEL_ID = 'workplan'
    const NS = 'dsh-workplan'
    const { useState, useEffect, useCallback, useMemo } = React

    const LOCALE = {
      "zh": {
        "panel": "任务进度",
        "groupLive": "进行中",
        "groupDone": "已完成",
        "groupLiveHint": "还没结束，正在或即将推进",
        "groupDoneHint": "已全部完成并收尾",
        "groupCollapse": "收起",
        "groupExpand": "展开",
        "groupNeeds": "需处理",
        "groupLiveEmpty": "没有进行中的任务",
        "groupDoneEmpty": "还没有完成的任务",
        "groupSummary": "未完成 {open} / 已完成 {done}（完成率 {pct}%）",
        "groupSummaryNoRate": "未完成 {open} / 已完成 {done}（完成率暂无数据）",
        "groupAria": "{title}组，{plans} 个计划，共 {total} 件具体工作，已完成 {done} 件，完成率 {pct}%。其中正在做 {active} 件、卡住 {blocked} 件、还没开始 {pending} 件。",
        "groupAriaEmpty": "{title}组，{plans} 个计划，暂无具体工作项。",
        "groupPlansLabel": "个计划",
        "chartGroups": "两类计划数量占比",
        "chartLive": "进行中计划完成度（按工作项）",
        "chartMore": "另有 {n} 个进行中计划未画入图表",

        "title": "任务进度：一眼看懂",
        "subtitle": "用大白话说明：现在要做什么、谁在做、做到哪一步、接下来做什么。",
        "helpTitle": "先看这三句",
        "helpWhat": "这件事",
        "helpWho": "现在谁在做",
        "helpNext": "接下来做什么",
        "helpNobody": "还没开始",
        "helpDone": "都做完了",
        "helpNextDone": "没有下一步，这件事已完成",
        "helpHint": "负责团队 = 谁来做；具体工作 = 要完成的一件事；卡住了 = 需要人处理。",
        "handleBlocked": "先处理",
        "resumeReady": "对主 Agent 说「续跑这个计划」，会从受阻处继续（已完成的不重跑）",
        "resumeLeft": "还可续跑",
        "resumeTimes": "次",
        "resumeExhausted": "自动续跑额度已用尽，需要主 Agent 直接接手完成",
        "refresh": "刷新",
        "updatedAt": "更新于",
        "empty": "还没有任务进度",
        "emptyHint": "先发一句话说明你要做什么，系统会自动安排步骤和负责人。",
        "error": "读取失败",
        "retry": "重试",
        "phase": {
          "pending": "还没开始",
          "planning": "正在安排",
          "executing": "正在做",
          "integrating": "正在收尾",
          "done": "已完成",
          "blocked": "卡住了",
          "paused": "预算用完，可续跑",
          "degraded": "安排失败",
          "cancelled": "已取消"
        },
        "status": {
          "pending": "还没开始",
          "in_progress": "正在做",
          "done": "做好了",
          "blocked": "卡住了"
        },
        "dept": {
          "engineering": "工程研发",
          "research": "研究分析",
          "design": "设计",
          "product": "产品",
          "data": "数据",
          "qa": "质量验证",
          "security": "安全",
          "devops": "运维",
          "writing": "文档写作",
          "operations": "运营",
          "legal": "法务合规",
          "finance": "财务"
        },
        "stats": {
          "done": "做好了",
          "blocked": "卡住了",
          "inProgress": "正在做",
          "pending": "还没开始",
          "progress": "总体进度"
        },
        "steps": "分几步做",
        "stepPrefix": "第",
        "stepSuffix": "步",
        "workPrefix": "具体工作",
        "who": "负责团队",
        "person": "负责人",
        "what": "要做出什么",
        "how": "怎么做",
        "doneWhen": "怎样算做好",
        "willDeliver": "做完交付",
        "waitFor": "要等",
        "blockedReason": "卡住原因",
        "progressLabel": "进度",
        "more": "更多细节（不看也不影响理解）",
        "why": "为什么这样安排",
        "whyHint": "先找出最关键的问题，再按顺序解决；每一步做完先检查，再决定下一步。",
        "advanced": "专业说明",
        "advancedHint": "下面是给研发人员看的字段，小白可以跳过。",
        "noBlocked": "没有卡住的工作",
        "analysis": "为什么这样安排",
        "taskUnderstanding": "任务说明",
        "deliverable": "最终要交的东西",
        "successCriteria": "做好后应该达到",
        "constraints": "不能违反的限制",
        "knownFacts": "已经确认的事",
        "unknowns": "还不确定的事",
        "assumptions": "暂时这样认为",
        "contradictions": "难点分析",
        "primaryContradiction": "最关键的问题",
        "evidence": "依据",
        "whyPrimary": "为什么它最关键",
        "secondary": "其他问题",
        "transformation": "什么情况下会变化",
        "checkpoint": "这一步做完先检查",
        "subtasks": "具体工作",
        "role": "负责人",
        "objective": "要做出什么",
        "method": "怎么做",
        "inputs": "开始前需要",
        "outputs": "做完交付",
        "dependsOn": "要等",
        "acceptance": "怎样算做好",
        "risk": "可能的问题",
        "summary": "结果",
        "risks": "需要注意的问题",
        "likelihood": "可能性",
        "level": { "low": "可能性较小", "medium": "有可能", "high": "可能性较大" },
        "impact": "影响",
        "mitigation": "怎么避免",
        "trigger": "什么情况下会发生",
        "verification": "怎么证明做对了",
        "item": "检查项",
        "practiceLoop": "做事四步",
        "plan": "先计划",
        "do": "动手做",
        "check": "看结果",
        "act": "再调整",
        "planId": "内部编号",
        "degraded": "自动安排失败",
        "degradedHint": "这次没有启动部门 Agent。请先说明原因，确认后再重试。",
        "viewHint": "看左侧「任务进度」了解谁在做。",
        "toolUpdateTitle": "更新工作状态",
        "toolDispatchTitle": "重新安排工作",
        "toolFailed": "失败了",
        "toolPreparing": "准备中",
        "toolRunning": "正在做",
        "toolDone": "做好了",
        "toolArgs": "参数",
        "noResult": "暂无结果",
        "sessionCount": "个任务",
        "taskBreakdown": "拆成",
        "subtaskCount": "件具体工作",
        "workItems": "分配工作",
        "overview": "进度总览",
        "statusChart": "状态分布",
        "taskChart": "每个任务的进度",
        "jumpToTask": "跳转到任务明细",
        "scopeAll": "当前各会话最新计划汇总",
        "scopeThis": "本计划",
        "vizStageTitle": "分步进度",
        "vizWeighted": "总体进度（加权）",
        "allPlansHint": "上面是当前各会话最新计划的合计；历史计划不在此汇总，下面每张卡片只统计本计划。",
        "openHint": "打开左侧「任务进度」看完整安排。"
      },
      "en": {
        "groupLive": "In progress",
        "groupDone": "Completed",
        "groupLiveHint": "Not finished yet — running or about to run",
        "groupDoneHint": "All work finished and wrapped up",
        "groupCollapse": "Collapse",
        "groupExpand": "Expand",
        "groupNeeds": "needs attention",
        "groupLiveEmpty": "No work in progress",
        "groupDoneEmpty": "Nothing completed yet",
        "groupSummary": "Open {open} / done {done} ({pct}% complete)",
        "groupSummaryNoRate": "Open {open} / done {done} (completion rate unavailable)",
        "groupAria": "{title} group: {plans} plan(s), {total} work item(s), {done} done, {pct}% complete. Right now {active} in progress, {blocked} blocked, {pending} not started.",
        "groupAriaEmpty": "{title} group: {plans} plan(s), no work items yet.",
        "groupPlansLabel": "plan(s)",
        "chartGroups": "Plan count by group",
        "chartLive": "In-progress plans by work item",
        "chartMore": "{n} more in-progress plans not drawn",
        "panel": "Task progress",
        "title": "Task progress at a glance",
        "subtitle": "Plain language: what this is, who is doing it, how far along it is, and what happens next.",
        "helpTitle": "Start with these three",
        "helpWhat": "This task",
        "helpWho": "Who is doing it now",
        "helpNext": "What happens next",
        "helpNobody": "Not started yet",
        "helpDone": "Everything is done",
        "helpNextDone": "Nothing next; this task is complete",
        "helpHint": "Team = who does it; work item = one thing to finish; stuck = a person needs to help.",
        "handleBlocked": "Fix first",
        "resumeReady": "Tell the main agent to resume this plan; it continues from the blocked step without re-running finished work",
        "resumeLeft": "resumable",
        "resumeTimes": "times",
        "resumeExhausted": "The automatic resume budget is used up; the main agent has to finish this directly",
        "refresh": "Refresh",
        "updatedAt": "Updated",
        "empty": "No task progress yet",
        "emptyHint": "Send one sentence about what you need; the system will lay out the steps and owners.",
        "error": "Could not load",
        "retry": "Retry",
        "phase": {
          "pending": "Not started",
          "planning": "Planning",
          "executing": "In progress",
          "integrating": "Wrapping up",
          "done": "Done",
          "blocked": "Stuck",
          "paused": "Paused (budget spent)",
          "degraded": "Planning failed",
          "cancelled": "Cancelled"
        },
        "status": {
          "pending": "Not started",
          "in_progress": "In progress",
          "done": "Done",
          "blocked": "Stuck"
        },
        "dept": {
          "engineering": "Engineering",
          "research": "Research",
          "design": "Design",
          "product": "Product",
          "data": "Data",
          "qa": "QA",
          "security": "Security",
          "devops": "DevOps",
          "writing": "Writing",
          "operations": "Operations",
          "legal": "Legal",
          "finance": "Finance"
        },
        "stats": {
          "done": "Done",
          "blocked": "Stuck",
          "inProgress": "In progress",
          "pending": "Not started",
          "progress": "Overall"
        },
        "steps": "Steps",
        "stepPrefix": "Step",
        "stepSuffix": "",
        "workPrefix": "Work item",
        "who": "Team",
        "person": "Owner",
        "what": "What to make",
        "how": "How",
        "doneWhen": "How we know it is good",
        "willDeliver": "What it delivers",
        "waitFor": "Waits for",
        "blockedReason": "Why it is stuck",
        "progressLabel": "Progress",
        "more": "More detail (optional)",
        "why": "Why it is arranged this way",
        "whyHint": "Find the most important problem first, solve in order, and check after each step before deciding the next one.",
        "advanced": "Technical notes",
        "advancedHint": "These fields are for engineers; a non-technical reader can skip them.",
        "noBlocked": "Nothing is stuck",
        "analysis": "Why it is arranged this way",
        "taskUnderstanding": "What this task means",
        "deliverable": "What you will get",
        "successCriteria": "What good looks like",
        "constraints": "Rules we cannot break",
        "knownFacts": "Confirmed facts",
        "unknowns": "Still unknown",
        "assumptions": "Temporary assumptions",
        "contradictions": "Key difficulty",
        "primaryContradiction": "The most important problem",
        "evidence": "Evidence",
        "whyPrimary": "Why it matters most",
        "secondary": "Other problems",
        "transformation": "What could change it",
        "checkpoint": "Check before moving on",
        "subtasks": "Work items",
        "role": "Owner role",
        "objective": "What to make",
        "method": "How",
        "inputs": "Needed first",
        "outputs": "What it delivers",
        "dependsOn": "Waits for",
        "acceptance": "How we know it is good",
        "risk": "Possible problem",
        "summary": "Result",
        "risks": "Things to watch",
        "likelihood": "Likelihood",
        "level": { "low": "Unlikely", "medium": "Possible", "high": "Likely" },
        "impact": "Impact",
        "mitigation": "How to avoid",
        "trigger": "What triggers it",
        "verification": "How we prove it is right",
        "item": "Check",
        "practiceLoop": "Four working steps",
        "plan": "Plan",
        "do": "Do",
        "check": "Check",
        "act": "Adjust",
        "planId": "Internal ID",
        "degraded": "Planning failed",
        "degradedHint": "No department agents were started. Explain why, confirm, then retry.",
        "viewHint": "Open “Task progress” on the left to see who is doing what.",
        "toolUpdateTitle": "Update work status",
        "toolDispatchTitle": "Arrange the work again",
        "toolFailed": "Failed",
        "toolPreparing": "Preparing",
        "toolRunning": "Running",
        "toolDone": "Done",
        "toolArgs": "Arguments",
        "noResult": "No result yet",
        "sessionCount": "tasks",
        "taskBreakdown": "split into",
        "subtaskCount": "work items",
        "workItems": "Work items",
        "overview": "Progress overview",
        "statusChart": "Status mix",
        "taskChart": "Progress by task",
        "jumpToTask": "Jump to task details",
        "scopeAll": "Latest plan per live session",
        "scopeThis": "This plan",
        "vizStageTitle": "Step progress",
        "vizWeighted": "Overall progress (weighted)",
        "allPlansHint": "These totals cover the latest plan in each live session; older plans are not included. Each card below counts only its own plan.",
        "openHint": "Open “Task progress” on the left for the full plan."
      }
    }

    function flattenLocale(source: any, prefix = '', out: any = {}) {
      for (const [key, value] of Object.entries(source)) {
        const full = prefix ? `${prefix}.${key}` : key
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          flattenLocale(value, full, out)
        } else {
          out[full] = String(value)
        }
      }
      return out
    }

    const CSS = `
.dsh-wp, .dsh-wp *, .dsh-wp *::before, .dsh-wp *::after { box-sizing: border-box; }
.dsh-wp {
  /* User-selected status colors: done = sky blue, in progress = orange. */
  --dsh-wp-done: #0ea5e9;
  --dsh-wp-active: #f97316;
  /* 文本/描边用的自适应色：与主文本色混合，浅色主题自动变深、深色主题自动变浅。
     裸品牌色在白底只有 2.77 / 2.80:1，18px 与 12px 文字都不达标（WCAG 4.5:1）。*/
  /* 兜底：不支持 color-mix 的旧浏览器（Safari <16.2 / Chrome <111）退回主文本色，
     可读性不降级，只是失去色相；支持时由下方 @supports 覆盖为混合色。*/
  --dsh-wp-done-text: var(--dsw-alias-label-primary);
  --dsh-wp-active-text: var(--dsw-alias-label-primary);
  /* T6 — 零依赖完成度环：弧线 #0284c7 在浅 #fafafb 3.93:1 / 深 #1b1c1f 4.16:1（≥3:1 图形对比）；
     底槽用中性灰而不是品牌色，避免「未完成部分」被误读成状态色。 */
  --dsh-wp-done-ink: var(--dsh-wp-done-text);
  --dsh-wp-ring-track: rgba(148,163,184,.30);
  /* 1.5.0 — 进度区图表化：构成条/阶段槽的中性轨道，以及 0% 零轨（≥3:1 图形对比）。 */
  --dsh-wp-track: rgba(148,163,184,.22);
  --dsh-wp-track-strong: rgba(100,116,139,.80);
  min-width: 0;
  width: 100%;
  height: 100%;
  max-height: 100dvh;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  touch-action: pan-y;
  scrollbar-gutter: stable;
  padding: 20px;
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 14px;
  line-height: 1.6;
}
.dsh-wp h1, .dsh-wp h2, .dsh-wp h3, .dsh-wp p { margin: 0; }
/* v1.4.0 — status grouping: in progress vs completed */
.dsh-wp-groups { display: flex; flex-direction: column; gap: 20px; }
.dsh-wp-group { border-radius: 16px; padding: 14px 14px 6px; border: 1px solid var(--dsw-alias-line-1, rgba(148,163,184,.22)); background: var(--dsw-alias-bg-elevated, rgba(148,163,184,.05)); position: relative; overflow: hidden; }
.dsh-wp-group::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 4px; }
.dsh-wp-group--live::before { background: linear-gradient(180deg, #fb923c, #f97316); }
.dsh-wp-group--done::before { background: linear-gradient(180deg, #38bdf8, #0284c7); }
/* T6 — 组头多出一行完成度摘要，底部内边距 10px → 6px，两组仍在同一屏内读完。 */
.dsh-wp-group-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 4px 6px; }
.dsh-wp-group-head--btn { width: 100%; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 8px; }
.dsh-wp-group-head--btn:hover .dsh-wp-group-chevron,
.dsh-wp-group-head--btn:focus-visible .dsh-wp-group-chevron { border-color: var(--dsw-alias-label-secondary); }
.dsh-wp-group-head--btn:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: 2px; }
/* 折叠 chevron：向下=已展开，向右=已折叠（形状编码，不依赖颜色） */
.dsh-wp-group-chevron { flex: none; width: 7px; height: 7px; border-right: 1.5px solid var(--dsw-alias-label-tertiary, #9ca3af); border-bottom: 1.5px solid var(--dsw-alias-label-tertiary, #9ca3af); transform: rotate(45deg); transition: transform .16s ease; }
.dsh-wp-group--folded .dsh-wp-group-chevron { transform: rotate(-45deg); }
/* 折叠态不再给副行降透明度：opacity:.75 会把浅色副行压到 2.45:1，折叠提示由旋转后的 chevron 承担。 */
@media (prefers-reduced-motion: reduce) { .dsh-wp-group-chevron { transition: none; } }
/* T6 — 组头完成度环：一个内联 SVG（底槽圆 + 弧线圆），零依赖、无 canvas、无第三方库。
   环是纯装饰（aria-hidden），百分比同时以文字出现在下一行摘要里，所以不依赖颜色也能读。 */
.dsh-wp-group-ring { position: relative; width: 44px; height: 44px; flex: none; margin-left: auto; display: inline-grid; place-items: center; }
.dsh-wp-group-ring svg { position: absolute; inset: 0; display: block; }
.dsh-wp-group-ring-track { stroke: var(--dsh-wp-ring-track, rgba(148,163,184,.30)); }
/* 1.5.0 — 0% 不等于「没有图」：零轨加粗到 ≥3:1（rgba(100,116,139,.80)），
   环仍然看得见；「暂无数据」保持细轨 + 「—」，两种状态在视觉上不是一回事。 */
.dsh-wp-group-ring[data-zero="true"] .dsh-wp-group-ring-track { stroke: var(--dsh-wp-track-strong); }
.dsh-wp-group-ring[data-zero="true"] .dsh-wp-group-ring-label { font-size: 12px; font-weight: 800; }
.dsh-wp-group-ring-arc { stroke: var(--dsh-wp-done-ink, #0284c7); transition: stroke-dasharray .28s ease; }
.dsh-wp-group-ring-label { position: relative; font-size: 11px; font-weight: 700; line-height: 1; letter-spacing: -.2px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #0f172a); }
@media (prefers-reduced-motion: reduce) { .dsh-wp-group-ring-arc { transition: none; } }
.dsh-wp-group-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dsh-wp-group--live .dsh-wp-group-dot { background: #f97316; box-shadow: 0 0 0 4px rgba(249,115,22,.16); animation: dsh-wp-pulse 1.8s ease-in-out infinite; }
.dsh-wp-group--done .dsh-wp-group-dot { background: #0ea5e9; box-shadow: 0 0 0 4px rgba(14,165,233,.14); }
.dsh-wp-group-title { font-size: 15px; font-weight: 700; letter-spacing: .2px; color: var(--dsw-alias-label-primary, #0f172a); }
/* 设计稿 §6.1：橙 #f97316 / 白 ≈2.8:1、蓝 #0ea5e9 / 白 ≈2.77:1，均不足 4.5:1，
   15px 粗体也不算法定「大字号」，所以组头一律用主文本色；品牌色只做「面」——
   圆点、卡片左栏，以及计数徽章 14% 底色（文字仍是主文本色，浅/深主题同源）。
   状态区分同时有文字（进行中/已完成）与形状（左栏、折叠 chevron），不依赖颜色。 */
.dsh-wp-group-count { min-width: 22px; padding: 0 7px; height: 20px; border-radius: 999px; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-primary, #0f172a); font-variant-numeric: tabular-nums; }
.dsh-wp-group--live .dsh-wp-group-count { background: rgba(249,115,22,.14); box-shadow: inset 0 0 0 1px rgba(249,115,22,.34); }
.dsh-wp-group--done .dsh-wp-group-count { background: rgba(14,165,233,.14); box-shadow: inset 0 0 0 1px rgba(14,165,233,.34); }
/* WCAG AA：错误色叠 12% 红底后，浅色 #ec1313 只有 3.70:1；与主文本色混合 20%
   让浅色变深、深色变浅，两套主题都 ≥4.5:1（实测 5.16:1 / 5.67:1）。 */
.dsh-wp-group-alert { font-size: 12px; font-weight: 650; color: var(--dsw-alias-state-error-primary, #ef4444); color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 80%, var(--dsw-alias-label-primary, #0f172a) 20%); background: rgba(239,68,68,.12); padding: 1px 8px; border-radius: 999px; }
/* T6 — 组头完成度摘要：先给纯文本「进行中 N / 已完成 M（完成率 x%）」，
   不点开、不看颜色也能读出进度。flex-basis:100% 让它独占一整行——
   窄面板（≈292px 内容宽）下只截断摘要自身（省略号 + title 全文），
   组名、计数徽章、完成度环都不被挤走；读屏由组头按钮的 aria-label 念完整句。 */
.dsh-wp-group-sub { flex: 0 0 100%; margin-left: 0; min-width: 0; font-size: 12px; line-height: 1.45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary, #475569); font-variant-numeric: tabular-nums; }
.dsh-wp-group-body { display: flex; flex-direction: column; gap: 10px; }
.dsh-wp-group-body--folded { display: none; }
/* 已完成的降级感由蓝色左栏 + 组头文案承担；不再整组 opacity:.8——
   它会把浅色次要文字压到 3.61:1、三级文字压到 2.64:1，直接破坏正文可读性。 */
.dsh-wp-group-empty { padding: 12px 4px 18px; font-size: 13px; color: var(--dsw-alias-label-secondary, #64748b); }
.dsh-wp-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin: 2px 0 2px; }
.dsh-wp-chart-card { border-radius: 16px; padding: 12px 14px 10px; border: 1px solid var(--dsw-alias-line-1, rgba(148,163,184,.22)); background: linear-gradient(180deg, rgba(148,163,184,.10), rgba(148,163,184,.02)); min-width: 0; }
.dsh-wp-chart-title { font-size: 12px; font-weight: 650; letter-spacing: .3px; color: var(--dsw-alias-label-secondary, #cbd5e1); margin-bottom: 6px; }
.dsh-wp-chart-canvas { position: relative; height: 200px; min-width: 0; }
/* 图表就绪前不占位、就绪后隐去 fallback；两者互斥，避免叠影 */
.dsh-wp-charts--fallback .dsh-wp-chart-canvas { display: none; }
.dsh-wp-charts--ready .dsh-wp-fallback { display: none; }
.dsh-wp-fallback { display: flex; flex-direction: column; gap: 10px; padding: 8px 2px 6px; }
.dsh-wp-fallback-bar { display: flex; height: 16px; border-radius: 999px; overflow: hidden; background: rgba(148,163,184,.18); }
.dsh-wp-fallback-live { background: linear-gradient(90deg, #fb923c, #f97316); transition: width .5s ease; }
.dsh-wp-fallback-done { background: linear-gradient(90deg, #38bdf8, #0284c7); transition: width .5s ease; }
.dsh-wp-fallback-legend { display: flex; gap: 16px; font-size: 12px; color: var(--dsw-alias-label-secondary, #cbd5e1); }
.dsh-wp-fallback-legend span { display: inline-flex; align-items: center; gap: 6px; }
.dsh-wp-fallback-key { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dsh-wp-fallback-key--live { background: #f97316; }
.dsh-wp-fallback-key--done { background: #0ea5e9; }
@keyframes dsh-wp-pulse { 0%,100% { box-shadow: 0 0 0 4px rgba(249,115,22,.16); } 50% { box-shadow: 0 0 0 7px rgba(249,115,22,.05); } }
@media (prefers-reduced-motion: reduce) { .dsh-wp-group--live .dsh-wp-group-dot { animation: none; } }

.dsh-wp-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.dsh-wp-title { font-size: clamp(18px, 2.4vw, 24px); font-weight: 650; letter-spacing: -0.01em; }
.dsh-wp-subtitle { margin-top: 4px; color: var(--dsw-alias-label-secondary); max-width: 70ch; }
.dsh-wp-guide {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 12px 14px;
  margin-bottom: 14px;
}
.dsh-wp-guide-title { font-weight: 650; margin-bottom: 8px; }
.dsh-wp-guide-body {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.dsh-wp-guide-row {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-wp-guide-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-wp-guide-value { min-width: 0; margin-top: 2px; font-size: 13px; overflow-wrap: anywhere; }
.dsh-wp-guide-hint { margin-top: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
.dsh-wp-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-wp-scope-note { margin: 8px 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; }
.dsh-wp-button {
  min-height: 44px;
  min-width: 44px;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.dsh-wp-button:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-wp-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-wp-banner {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 14px;
  overflow-wrap: anywhere;
}
.dsh-wp-banner--error { border-color: var(--dsw-alias-state-error-primary); }
.dsh-wp-banner--degraded { border-color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-wp-empty {
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 14px;
  padding: 28px 18px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dsh-wp-statbar {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 14px;
  overflow: hidden;
  margin-bottom: 16px;
}
.dsh-wp-stat {
  min-width: 0;
  padding: 9px 12px 10px;
  border-left: 1px solid var(--dsw-alias-border-l1);
}
.dsh-wp-stat:first-child { border-left: 0; }
.dsh-wp-stat-value { font-size: 18px; line-height: 1.25; font-weight: 650; font-variant-numeric: tabular-nums; }
.dsh-wp-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11px; letter-spacing: 0.01em; overflow-wrap: anywhere; }
.dsh-wp-stat--done .dsh-wp-stat-value { color: var(--dsh-wp-done-text); }
.dsh-wp-stat--active .dsh-wp-stat-value { color: var(--dsh-wp-active-text); }
.dsh-wp-stat--tasks .dsh-wp-stat-value { color: var(--dsw-alias-brand-primary); }
.dsh-wp-stat--blocked .dsh-wp-stat-value { color: var(--dsw-alias-state-error-primary); }
/* Visual overview: one status donut plus one progress bar per task. Uses only
   the live alias tokens and no chart dependency, so the page stays light. */
.dsh-wp-overview {
  display: grid;
  grid-template-columns: minmax(220px, 0.85fr) minmax(280px, 1.35fr);
  gap: 12px;
  margin-bottom: 16px;
}
.dsh-wp-chart-card {
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 14px;
  padding: 12px 14px;
  overflow-wrap: anywhere;
}
.dsh-wp-chart-card .dsh-wp-section-title { margin-top: 0; }
.dsh-wp-donut-wrap {
  position: relative;
  width: 132px;
  max-width: 100%;
  aspect-ratio: 1;
  margin: 6px auto 10px;
}
.dsh-wp-donut { display: block; width: 100%; height: 100%; }
.dsh-wp-donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  pointer-events: none;
  text-align: center;
}
.dsh-wp-donut-center strong { font-size: 24px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.dsh-wp-donut-center span { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-wp-legend { display: flex; flex-wrap: wrap; gap: 5px 12px; justify-content: center; }
.dsh-wp-legend-item { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-wp-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.dsh-wp-bar-row { min-width: 0; }
.dsh-wp-bar-row + .dsh-wp-bar-row { margin-top: 11px; }
.dsh-wp-bar-button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 8px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: 10px;
}
.dsh-wp-bar-button:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-wp-bar-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-wp-session { scroll-margin-top: 72px; }
.dsh-wp-bar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
.dsh-wp-bar-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dsh-wp-bar-value { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-wp-bar-track {
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
  margin-top: 4px;
}
.dsh-wp-bar-fill { height: 100%; border-radius: 999px; background: var(--dsh-wp-active); transition: width 240ms ease; }
.dsh-wp-bar-fill--done { background: var(--dsh-wp-done); }
.dsh-wp-bar-fill--blocked { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-bar-fill--warn { background: var(--dsw-alias-state-warn-primary); }
.dsh-wp-bar-fill--idle { background: var(--dsw-alias-state-idle-primary); }
.dsh-wp-bar-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-wp-mini {
  display: inline-block;
  width: 54px;
  height: 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
  vertical-align: middle;
}
.dsh-wp-mini-fill { display: block; height: 100%; border-radius: 999px; background: var(--dsh-wp-active); }
.dsh-wp-mini-fill--done { background: var(--dsh-wp-done); }
.dsh-wp-mini-fill--blocked { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-mini-fill--warn { background: var(--dsw-alias-state-warn-primary); }
.dsh-wp-mini-fill--idle { background: var(--dsw-alias-state-idle-primary); }
/* ── 1.5.0 计划卡进度图表（用户诉求：画圈处必须一眼可读）─────────────────
   四层信号同时存在，任何一层失效都还能读出进度，且都不依赖颜色：
   ① 44px 环：图形比例；0% 时轨道加粗仍可见，不画弧（避免圆头端点留下小点）。
   ② 24px 百分比：主文本色，浅色底 17:1；「—」表示分母为 0，绝不写 NaN。
   ③ 整行四段构成条：按件数分宽；0% 时是一条完整的灰色「还没开始」，
      这也是「整条灰＝都还没开始」的图形解释。
   ④ 11px 状态图例 + 一行「现在在做什么」+ 6px 阶段步进条。
   数据只来自既有 session.stats / stages / statuses：无新接口、无依赖、无定时器。 */
.dsh-wp-session-collapse .dsh-wp-collapse-meta { flex: 1 1 100%; display: block; margin-top: 6px; }
.dsh-wp-planviz {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  grid-template-areas: "ring head" "bar bar" "legend legend" "step step";
  column-gap: 10px;
  row-gap: 6px;
  width: 100%;
  min-width: 0;
}
.dsh-wp-planviz-ring { grid-area: ring; position: relative; width: 44px; height: 44px; display: inline-grid; place-items: center; }
.dsh-wp-planviz-ring svg { position: absolute; inset: 0; display: block; }
.dsh-wp-planring-track { stroke: var(--dsh-wp-track); }
.dsh-wp-planring-arc { stroke: var(--dsh-wp-done-ink); transition: stroke-dasharray .28s ease; }
.dsh-wp-planviz-ring[data-zero="true"] .dsh-wp-planring-track { stroke: var(--dsh-wp-track-strong); }
.dsh-wp-planviz-head { grid-area: head; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.dsh-wp-planviz-pct { font-size: 24px; font-weight: 700; line-height: 1.15; letter-spacing: -.4px; color: var(--dsw-alias-label-primary, #0f172a); font-variant-numeric: tabular-nums; }
.dsh-wp-planviz-scope { min-width: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #475569); font-variant-numeric: tabular-nums; }
.dsh-wp-planviz-alarm { font-size: 11px; font-weight: 650; padding: 1px 7px; border-radius: 999px; color: var(--dsw-alias-state-error-primary, #ef4444); color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 80%, var(--dsw-alias-label-primary, #0f172a) 20%); background: rgba(239,68,68,.12); }
.dsh-wp-planviz-now { flex: 1 1 100%; display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); }
.dsh-wp-planviz-now-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dsh-wp-planviz[data-state="active"] .dsh-wp-planviz-now-dot { background: var(--dsh-wp-active); }
.dsh-wp-planviz[data-state="done"] .dsh-wp-planviz-now-dot { background: var(--dsh-wp-done); }
.dsh-wp-planviz[data-state="blocked"] .dsh-wp-planviz-now-dot { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-planviz-now-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wp-planviz-bar { grid-area: bar; display: flex; align-items: stretch; gap: 2px; height: 8px; border-radius: 999px; background: var(--dsh-wp-track); overflow: hidden; }
.dsh-wp-planviz-seg { flex: 1 1 0; min-width: 4px; height: 100%; border-radius: 999px; }
.dsh-wp-planviz-seg[data-kind="done"] { background: var(--dsh-wp-done); }
.dsh-wp-planviz-seg[data-kind="active"] { background: var(--dsh-wp-active); }
.dsh-wp-planviz-seg[data-kind="blocked"] { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-planviz-seg[data-kind="pending"] { background: var(--dsw-alias-state-idle-primary); }
.dsh-wp-planviz-legend { grid-area: legend; display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #475569); font-variant-numeric: tabular-nums; }
.dsh-wp-planviz-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.dsh-wp-planviz-legend-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dsh-wp-planviz-legend-item[data-kind="done"] .dsh-wp-planviz-legend-dot { background: var(--dsh-wp-done); }
.dsh-wp-planviz-legend-item[data-kind="active"] .dsh-wp-planviz-legend-dot { background: var(--dsh-wp-active); }
.dsh-wp-planviz-legend-item[data-kind="blocked"] .dsh-wp-planviz-legend-dot { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-stepper { grid-area: step; display: flex; gap: 3px; min-width: 0; }
.dsh-wp-stepper-seg { position: relative; flex: 1 1 0; min-width: 0; height: 6px; border-radius: 999px; background: var(--dsh-wp-track); overflow: hidden; }
.dsh-wp-stepper-seg[data-tone="pending"] { background: transparent; border: 1px dashed var(--dsh-wp-track-strong); }
.dsh-wp-stepper-seg[data-tone="blocked"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.dsh-wp-stepper-seg[data-current="true"] { outline: 1.5px solid var(--dsh-wp-active-text); outline-offset: 1px; }
.dsh-wp-stepper-fill { display: block; height: 100%; border-radius: 999px; background: var(--dsh-wp-active); }
.dsh-wp-stepper-seg[data-tone="done"] .dsh-wp-stepper-fill { background: var(--dsh-wp-done); }
.dsh-wp-stepper-seg[data-tone="blocked"] .dsh-wp-stepper-fill { background: var(--dsw-alias-state-error-primary); }
@media (prefers-reduced-motion: reduce) { .dsh-wp-planring-arc { transition: none; } }
/* 短屏（纵向更紧）：先撤图例与阶段条，保住环 + 百分比 + 构成条 + 当前步骤。 */
@media (max-height: 720px) and (max-width: 600px) {
  .dsh-wp-planviz-legend, .dsh-wp-stepper { display: none; }
}
/* 展开态「分步进度」：替换旧的计划级进度条，保留加权进度并给出逐阶段分解。 */
.dsh-wp-planoverview { margin: 12px 0 4px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); display: grid; gap: 8px; }
.dsh-wp-planoverview-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); }
.dsh-wp-planoverview-title { font-size: 12px; font-weight: 650; letter-spacing: .2px; }
.dsh-wp-planoverview-stats { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); font-variant-numeric: tabular-nums; }
.dsh-wp-planrows { display: grid; }
.dsh-wp-planrow { display: grid; grid-template-columns: 7px minmax(0, 1fr) 48px auto auto; align-items: center; gap: 8px; min-height: 28px; padding: 4px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-wp-planrow:first-child { border-top: 0; }
.dsh-wp-planrow[data-current="true"] { background: rgba(249,115,22,.06); border-radius: 8px; }
.dsh-wp-planrow-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dsh-wp-planrow[data-tone="done"] .dsh-wp-planrow-dot { background: var(--dsh-wp-done); }
.dsh-wp-planrow[data-tone="active"] .dsh-wp-planrow-dot { background: var(--dsh-wp-active); }
.dsh-wp-planrow[data-tone="blocked"] .dsh-wp-planrow-dot { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-planrow-name { min-width: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #0f172a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wp-planrow-bar { display: block; height: 4px; border-radius: 999px; background: var(--dsh-wp-track); overflow: hidden; }
.dsh-wp-planrow-fill { display: block; height: 100%; border-radius: 999px; background: var(--dsh-wp-active); }
.dsh-wp-planrow[data-tone="done"] .dsh-wp-planrow-fill { background: var(--dsh-wp-done); }
.dsh-wp-planrow[data-tone="blocked"] .dsh-wp-planrow-fill { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-planrow-count { font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); font-variant-numeric: tabular-nums; }
.dsh-wp-planrow-state { font-size: 11px; color: var(--dsw-alias-label-secondary, #475569); white-space: nowrap; }
.dsh-wp-sessions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 16px; align-items: start; }
.dsh-wp-session {
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-top: 3px solid var(--dsh-wp-active);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 16px;
  padding: 16px;
  overflow-wrap: anywhere;
}
.dsh-wp-session.dsh-wp-tone-done { border-top-color: var(--dsh-wp-done); }
.dsh-wp-session.dsh-wp-tone-blocked { border-top-color: var(--dsw-alias-state-error-primary); }
.dsh-wp-session.dsh-wp-tone-warn { border-top-color: var(--dsw-alias-state-warn-primary); }

/* ── 1.4.1 视觉精修：只加细节，不改信息结构 ─────────────────────────────
   原则（对齐设计稿 §6.4）：
   1) 颜色不做唯一编码：组别另有位置、圆点、对勾/chevron、文案与形状；
   2) 所有数字用等宽数字（tabular-nums），列与列之间对得齐；
   3) 只有装饰性元素（发光、渐变、过渡）参与动效，且尊重 reduced-motion。 */
.dsh-wp-group { box-shadow: 0 1px 0 rgba(255,255,255,.03) inset, 0 10px 26px -18px rgba(15,23,42,.55); }
/* 组左栏：4px 竖向强调条，是「位置+形状」编码，不依赖颜色也能看出分区 */
.dsh-wp-group::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; width: 3px; border-radius: 0 3px 3px 0; opacity: .9; }
.dsh-wp-group--live::before { background: linear-gradient(180deg, #fbbf24, #ea580c); }
.dsh-wp-group--done::before { background: linear-gradient(180deg, #7dd3fc, #0369a1); }
.dsh-wp-group--done { opacity: .97; }
.dsh-wp-group-head--btn { transition: background-color .16s ease; }
.dsh-wp-group-head--btn:hover { background: rgba(148,163,184,.10); }
.dsh-wp-group-count { font-variant-numeric: tabular-nums; }
.dsh-wp-group-sub { font-variant-numeric: tabular-nums; }
/* 图表卡：标题左侧一枚小色块，和环形图/条形图配色呼应 */
.dsh-wp-chart-title { display: flex; align-items: center; gap: 7px; }
.dsh-wp-chart-title::before { content: ''; width: 9px; height: 9px; border-radius: 3px; flex: none;
  background: linear-gradient(135deg, #fbbf24, #ea580c); }
.dsh-wp-chart-card + .dsh-wp-chart-card .dsh-wp-chart-title::before,
.dsh-wp-chart-card:nth-of-type(2) .dsh-wp-chart-title::before { background: linear-gradient(135deg, #7dd3fc, #0369a1); }
@media (prefers-reduced-motion: reduce) {
  .dsh-wp-group-head--btn { transition: none; }
  .dsh-wp-charts, .dsh-wp-chart-canvas { animation: none !important; }
}
.dsh-wp-session-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px; }
.dsh-wp-session-title { font-size: 16px; font-weight: 650; min-width: 0; }
.dsh-wp-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-wp-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  white-space: normal;
  overflow-wrap: anywhere;
}
.dsh-wp-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.dsh-wp-tone-done .dsh-wp-dot, .dsh-wp-dot--done { background: var(--dsh-wp-done); }
.dsh-wp-tone-active .dsh-wp-dot, .dsh-wp-dot--in_progress { background: var(--dsh-wp-active); }
.dsh-wp-pill.dsh-wp-tone-done { color: var(--dsh-wp-done-text); }
.dsh-wp-pill.dsh-wp-tone-active { color: var(--dsh-wp-active-text); }
.dsh-wp-tone-blocked .dsh-wp-dot, .dsh-wp-dot--blocked { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-tone-warn .dsh-wp-dot, .dsh-wp-dot--degraded { background: var(--dsw-alias-state-warn-primary); }
.dsh-wp-progress {
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
  margin: 10px 0 6px;
}
.dsh-wp-progress-fill { height: 100%; border-radius: 999px; background: var(--dsh-wp-active); transition: width 240ms ease; }
.dsh-wp-progress-fill--done { background: var(--dsh-wp-done); }
.dsh-wp-progress-fill--blocked { background: var(--dsw-alias-state-error-primary); }
.dsh-wp-progress-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-wp-departments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.dsh-wp-section { margin-top: 14px; }
.dsh-wp-section-title { font-size: 13px; font-weight: 650; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; text-transform: none; }
.dsh-wp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 8px; }
.dsh-wp-field { min-width: 0; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 8px 10px; }
.dsh-wp-field-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-wp-field-value { margin-top: 2px; overflow-wrap: anywhere; }
.dsh-wp-list { margin: 0; padding-left: 18px; overflow-wrap: anywhere; }
.dsh-wp-list li + li { margin-top: 3px; }
.dsh-wp-stage {
  margin-top: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  padding: 12px;
  background: var(--dsw-alias-bg-base);
  min-width: 0;
}
.dsh-wp-stage-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsh-wp-stage-title { font-weight: 650; }
.dsh-wp-stage-goal { color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.dsh-wp-checkpoint { margin-top: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
.dsh-wp-subtask {
  margin-top: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 10px;
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.dsh-wp-subtask-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; }
.dsh-wp-subtask-title { font-weight: 600; min-width: 0; }
.dsh-wp-subtask-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-wp-subtask-body { margin-top: 6px; }
.dsh-wp-subtask-body > div { margin-top: 4px; }
.dsh-wp-subtask-body p { margin-top: 2px; overflow-wrap: anywhere; }
.dsh-wp-error-text { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dsh-wp-muted { color: var(--dsw-alias-label-secondary); }
/* Reusable disclosure container: default collapsed, one 44px+toggle row, panel below. */
.dsh-wp-collapse { min-width: 0; }
.dsh-wp-collapse-head { display: flex; align-items: stretch; gap: 6px; min-width: 0; }
.dsh-wp-collapse-toggle {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 44px;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  overflow-wrap: anywhere;
}
.dsh-wp-collapse-toggle:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-wp-chart-more { margin-top: 6px; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.dsh-wp-collapse-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-wp-collapse-chevron {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  margin-left: 2px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 160ms ease;
}
.dsh-wp-collapse[data-open="true"] .dsh-wp-collapse-chevron { transform: rotate(45deg); }
.dsh-wp-collapse-summary { display: flex; flex: 1 1 auto; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.dsh-wp-collapse-title { font-weight: 650; min-width: 0; }
.dsh-wp-collapse-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-wp-collapse-badge { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; margin-left: auto; }
.dsh-wp-collapse-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
.dsh-wp-collapse-panel { margin-top: 10px; min-width: 0; }
.dsh-wp-collapse-panel[hidden] { display: none; }
/* Task card / step card wrapping: the disclosure row is the only content shown
   while collapsed, so the card keeps its tone border and padding. */
.dsh-wp-session-collapse .dsh-wp-collapse-toggle { padding: 9px 12px; }
.dsh-wp-session-updated { margin: 0 0 10px; }
.dsh-wp-stage-collapse .dsh-wp-collapse-toggle { padding: 7px 10px; }
.dsh-wp-stage-body > .dsh-wp-stage-goal { margin-top: 0; }
.dsh-wp-details { margin-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; }
.dsh-wp-details > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-wp-details > summary:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-wp-turn {
  margin: 8px 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--dsw-alias-brand-primary);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 10px 12px;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
  overflow-wrap: anywhere;
}
.dsh-wp-turn.dsh-wp-tone-done { border-left-color: var(--dsh-wp-done); }
.dsh-wp-turn.dsh-wp-tone-active { border-left-color: var(--dsh-wp-active); }
.dsh-wp-turn-title { font-weight: 650; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dsh-wp-tool {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 8px 10px;
  margin: 6px 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dsh-wp-tool-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-weight: 600; }
.dsh-wp-tool-body { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-wp-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.dsh-wp-sidebar-icon { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: currentColor; }
@media (max-width: 600px) {
  .dsh-wp { padding: 12px; padding-bottom: calc(20px + env(safe-area-inset-bottom)); }
  .dsh-wp-sessions { grid-template-columns: minmax(0, 1fr); }
  .dsh-wp-overview { grid-template-columns: minmax(0, 1fr); }
  .dsh-wp-statbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dsh-wp-stat:nth-child(3),
  .dsh-wp-stat:nth-child(4),
  .dsh-wp-stat:nth-child(5) { border-top: 1px solid var(--dsw-alias-border-l1); }
  .dsh-wp-stat:nth-child(3),
  .dsh-wp-stat:nth-child(5) { border-left: 0; }
  .dsh-wp-stat:nth-child(5) { grid-column: 1 / -1; }
  .dsh-wp-session { padding: 12px; }
  .dsh-wp-guide-body { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .dsh-wp-details > summary { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-wp-progress-fill { transition: none; }
  .dsh-wp-collapse-chevron { transition: none; }
}

/* 主题自适应文本色（渐变品牌色 → 与主文本色混合）。
   浅色 #b35616 4.93:1 / #0e79a9 4.85:1，深色 #f99c5b 7.82:1 / #55beee 7.86:1。*/
@supports (color: color-mix(in srgb, red, blue)) {
  .dsh-wp {
    --dsh-wp-done-text: color-mix(in srgb, var(--dsh-wp-done) 70%, var(--dsw-alias-label-primary));
    --dsh-wp-active-text: color-mix(in srgb, var(--dsh-wp-active) 70%, var(--dsw-alias-label-primary));
  }
}
`

    function injectStyles() {
      const id = 'dsh-workplan-styles'
      const existing = document.getElementById(id)
      if (existing) existing.remove()
      const style = document.createElement('style')
      style.id = id
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    function asText(value: any) {
      return typeof value === 'string' ? value : ''
    }

    function clampPct(value: any) {
      const number = Number(value)
      return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0
    }

    function formatTime(value: any) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleString()
    }

    function toneOfStatus(status: any) {
      if (status === 'done') return 'done'
      if (status === 'in_progress') return 'active'
      if (status === 'blocked') return 'blocked'
      return 'idle'
    }

    function phaseTone(phase: any) {
      if (phase === 'blocked') return 'blocked'
      if (phase === 'degraded' || phase === 'cancelled' || phase === 'paused') return 'warn'
      if (phase === 'integrating' || phase === 'done') return 'done'
      if (phase === 'executing' || phase === 'planning') return 'active'
      return 'idle'
    }

    function allEntries(session: any) {
      const byId = new Map((Array.isArray(session?.statuses) ? session.statuses : []).map((item: any) => [item.subtaskId, item]))
      const entries: any[] = []
      for (const stage of Array.isArray(session?.stages) ? session.stages : []) {
        for (const subtask of Array.isArray(stage?.subtasks) ? stage.subtasks : []) {
          entries.push({ stage, subtask, item: byId.get(subtask.id) })
        }
      }
      return entries
    }

    function findEntry(session: any, status: any) {
      return allEntries(session).find((entry: any) => entry.item?.status === status) || null
    }

    function deptName(t: any, id: any) {
      const key = `dept.${id}`
      const value = t(key)
      return value === key ? String(id || '') : value
    }

    function levelText(t: any, value: any) {
      const key = `level.${value}`
      const text = t(key)
      return text === key ? String(value || '') : text
    }

    function stageLabel(t: any, index: any) {
      return `${t('stepPrefix')} ${index + 1} ${t('stepSuffix')}`.trim()
    }

    function workLabel(t: any, index: any) {
      return `${t('workPrefix')} ${index + 1}`
    }

    function plainError(value: any) {
      const text = typeof value === 'string' ? value : ''
      if (!text) return ''
      if (text.includes('超时')) return '这件事花的时间太长，系统先停下来了。'
      if (text.includes('上游') || text.includes('依赖')) return '前面的工作还没做完，所以这一步暂时不能开始。'
      if (text.includes('未启动')) return '这次没有启动负责这件事的 Agent。'
      if (text.includes('未完成')) return '这件事没有做完。'
      return text
    }

    function workerText(session: any, t: any) {
      const active = findEntry(session, 'in_progress')
      if (active) {
        return `${deptName(t, active.subtask.department)} · ${active.subtask.title}`
      }
      const blocked = findEntry(session, 'blocked')
      if (blocked) {
        return `${deptName(t, blocked.subtask.department)} · ${blocked.subtask.title}（${t('status.blocked')}）`
      }
      const stats = session.stats || {}
      if ((stats.total ?? 0) > 0 && (stats.done ?? 0) >= (stats.total ?? 0)) return t('helpDone')
      return t('helpNobody')
    }

    /*
     * A blocked card used to read "卡住了" and stop there: no hint that the plan
     * is recoverable, so the only visible option was to restate the request and
     * build a fresh plan. Say out loud how to resume instead.
     */
    function resumeHint(session: any, t: any) {
      if (!session || session.phase !== 'blocked') return ''
      if (session.resumeAvailable) {
        const limit = Number(session.resumeLimit ?? 0)
        const used = Number(session.resumeCount ?? 0)
        const left = Number.isFinite(limit) && limit > 0 ? Math.max(0, limit - used) : 0
        const suffix = left > 0 ? `（${t('resumeLeft')} ${left} ${t('resumeTimes')}）` : ''
        return `；${t('resumeReady')}${suffix}`
      }
      return `；${t('resumeExhausted')}`
    }

    function nextText(session: any, t: any) {
      const blocked = findEntry(session, 'blocked')
      if (blocked) return `${t('handleBlocked')}：${deptName(t, blocked.subtask.department)} · ${blocked.subtask.title}${resumeHint(session, t)}`
      const next = findEntry(session, 'pending') || allEntries(session).find((entry: any) => !entry.item)
      if (next) return `${deptName(t, next.subtask.department)} · ${next.subtask.title}`
      const stats = session.stats || {}
      if ((stats.total ?? 0) > 0 && (stats.done ?? 0) >= (stats.total ?? 0)) return t('helpDone')
      return t('helpNextDone')
    }

    function progressText(item: any, t: any) {
      const status = item?.status || 'pending'
      if (status === 'done') return t('status.done')
      if (status === 'blocked') return t('status.blocked')
      if (status === 'in_progress') return t('status.in_progress')
      return t('status.pending')
    }

    function Bullets({ items }: any) {
      const list = (Array.isArray(items) ? items : []).filter((item: any) => item !== null && item !== undefined && String(item).trim() !== '')
      if (list.length === 0) return h('span', { className: 'dsh-wp-muted' }, '—')
      return h('ul', { className: 'dsh-wp-list' }, list.map((item: any, index: any) => h('li', { key: index }, String(item))))
    }

    function Guide({ session, t }: any) {
      const task = session.taskUnderstanding || {}
      const what = task.deliverable || session.title || t('panel')
      return h('section', { className: 'dsh-wp-guide', 'aria-label': t('helpTitle') },
        h('div', { className: 'dsh-wp-guide-title' }, t('helpTitle')),
        h('div', { className: 'dsh-wp-guide-body' },
          h('div', { className: 'dsh-wp-guide-row' },
            h('div', { className: 'dsh-wp-guide-label' }, t('helpWhat')),
            h('div', { className: 'dsh-wp-guide-value' }, what),
          ),
          h('div', { className: 'dsh-wp-guide-row' },
            h('div', { className: 'dsh-wp-guide-label' }, t('helpWho')),
            h('div', { className: 'dsh-wp-guide-value' }, workerText(session, t)),
          ),
          h('div', { className: 'dsh-wp-guide-row' },
            h('div', { className: 'dsh-wp-guide-label' }, t('helpNext')),
            h('div', { className: 'dsh-wp-guide-value' }, nextText(session, t)),
          ),
        ),
        h('div', { className: 'dsh-wp-guide-hint' }, t('helpHint')),
      )
    }

    function Pill({ children, tone = 'idle' }: any) {
      return h('span', { className: `dsh-wp-pill dsh-wp-tone-${tone}` }, h('span', { className: 'dsh-wp-dot' }), children)
    }

    function Progress({ value, tone = 'active' }: any) {
      const pct = clampPct(value)
      return h(
        'div',
        { className: 'dsh-wp-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct },
        h('div', {
          className: `dsh-wp-progress-fill${tone === 'done' ? ' dsh-wp-progress-fill--done' : tone === 'blocked' ? ' dsh-wp-progress-fill--blocked' : ''}`,
          style: { width: `${pct}%` },
        }),
      )
    }

    function List({ items, empty }: any) {
      if (!Array.isArray(items) || items.length === 0) {
        return h('span', { className: 'dsh-wp-muted' }, empty || '—')
      }
      return h('ul', { className: 'dsh-wp-list' }, items.map((item: any, index: any) =>
        h('li', { key: index }, String(item)),
      ))
    }

    function Field({ label, children }: any) {
      return h('div', { className: 'dsh-wp-field' },
        h('div', { className: 'dsh-wp-field-label' }, label),
        h('div', { className: 'dsh-wp-field-value' }, children),
      )
    }

    let collapseIdSeq = 0

    function nextCollapseId() {
      collapseIdSeq += 1
      return `dsh-wp-collapse-${collapseIdSeq}`
    }

    /**
     * Collapse — the one disclosure container shared by the task layer
     * (a task card) and the step layer (the "分几步做" list).
     *
     * Behaviour:
     * - collapsed by default (`defaultOpen` defaults to false);
     * - the summary row is a native <button>, so a click, Enter, or Space all
     *   activate the same toggle and `aria-expanded` mirrors the state;
     * - uncontrolled (`defaultOpen`) or controlled (`open` + `onOpenChange`);
     * - summary clicks/Enter/Space stop propagation, so toggling never triggers
     *   a clickable parent card; content inside the panel keeps normal bubbling,
     *   so links and buttons in the body still work;
     * - the collapsed summary keeps `title`, `meta` (e.g. "1/4 做好了") and
     *   `badge` (e.g. the phase pill) visible; `actions` stays outside the
     *   toggle button for extra controls.
     *
     * Usage (uncontrolled, collapsed until the user opens it):
     *   h(Collapse, {
     *     title: session.title,
     *     meta: `${stats.done}/${stats.total} ${t('stats.done')}`,
     *     badge: h(Pill, { tone }, t(`phase.${phase}`)),
     *   }, h('div', null, body))
     *
     * Usage (controlled):
     *   h(Collapse, {
     *     open: expanded,
     *     onOpenChange: setExpanded,
     *     title: stage.name,
     *   }, h('div', null, stageBody))
     */
    function Collapse(props: any) {
      const {
        title,
        meta,
        badge,
        actions,
        children,
        defaultOpen = false,
        open: openProp,
        onOpenChange,
        id,
        className,
        panelClassName,
      } = props || {}
      const [generatedId] = useState(() => nextCollapseId())
      const baseId = asText(id) || generatedId
      const panelId = `${baseId}-panel`
      const controlled = typeof openProp === 'boolean'
      const [innerOpen, setInnerOpen] = useState(defaultOpen === true)
      const open = controlled ? openProp : innerOpen
      const toggle = useCallback(() => {
        const next = !open
        if (!controlled) setInnerOpen(next)
        if (typeof onOpenChange === 'function') onOpenChange(next)
      }, [controlled, open, onOpenChange])
      const stop = (event: any) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      }
      const handleClick = (event: any) => {
        stop(event)
        toggle()
      }
      const handleKeyDown = (event: any) => {
        const key = event?.key
        // The native button already turns Enter/Space into a click; only stop
        // the key event from reaching clickable parents here.
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') stop(event)
      }
      const extra = asText(className)
      return h('section', {
        className: `dsh-wp-collapse${open ? ' dsh-wp-collapse--open' : ''}${extra ? ` ${extra}` : ''}`,
        'data-open': open ? 'true' : 'false',
      },
        h('div', { className: 'dsh-wp-collapse-head' },
          h('button', {
            type: 'button',
            className: 'dsh-wp-collapse-toggle',
            'aria-expanded': open,
            'aria-controls': panelId,
            onClick: handleClick,
            onKeyDown: handleKeyDown,
          },
            h('span', { className: 'dsh-wp-collapse-chevron', 'aria-hidden': 'true' }),
            h('span', { className: 'dsh-wp-collapse-summary' },
              h('span', { className: 'dsh-wp-collapse-title' }, title ?? ''),
              meta === null || meta === undefined || meta === false
                ? null
                : h('span', { className: 'dsh-wp-collapse-meta' }, meta),
            ),
            badge === null || badge === undefined || badge === false
              ? null
              : h('span', { className: 'dsh-wp-collapse-badge' }, badge),
          ),
          actions ? h('div', { className: 'dsh-wp-collapse-actions' }, actions) : null,
        ),
        h('div', {
          id: panelId,
          className: `dsh-wp-collapse-panel${asText(panelClassName) ? ` ${panelClassName}` : ''}`,
          hidden: !open,
        }, children),
      )
    }

    async function fetchPlans(sessionId: any, signal: any) {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const response = await fetch(`/dsh-workplan/plans${query}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) {
        throw new Error(asText(payload?.error) || '计划接口返回异常')
      }
      return Array.isArray(payload.sessions) ? payload.sessions : []
    }

    function usePlans(sessionId?: string) {
      const [state, setState] = useState({ loading: true, sessions: [], error: null, updatedAt: null })
      const load = useCallback(async (signal?: AbortSignal) => {
        try {
          const sessions = await fetchPlans(sessionId, signal)
          if (signal?.aborted) return
          setState({ loading: false, sessions, error: null, updatedAt: Date.now() })
        } catch (error) {
          if (signal?.aborted) return
          setState((previous: any) => ({
            ...previous,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }, [sessionId])
      useEffect(() => {
        const controller = new AbortController()
        load(controller.signal)
        const timer = setInterval(() => load(controller.signal), 4000)
        return () => {
          controller.abort()
          clearInterval(timer)
        }
      }, [load])
      return { ...state, reload: () => load() }
    }

    function ErrorBanner({ message, onRetry, t }: any) {
      return h('div', { className: 'dsh-wp-banner dsh-wp-banner--error', role: 'alert' },
        h('div', { className: 'dsh-wp-section-title' }, t('error')),
        h('div', { className: 'dsh-wp-error-text' }, message || t('noResult')),
        h('button', { type: 'button', className: 'dsh-wp-button', style: { marginTop: '8px' }, onClick: onRetry }, t('retry')),
      )
    }

    function SubtaskRow({ item, subtask, index, t }: any) {
      const status = item?.status ?? 'pending'
      const tone = toneOfStatus(status)
      const pct = clampPct(item?.progress ?? 0)
      return h('div', { className: `dsh-wp-subtask dsh-wp-tone-${tone}` },
        h('div', { className: 'dsh-wp-subtask-head' },
          h('div', { className: 'dsh-wp-subtask-title' }, `${workLabel(t, index)}：${subtask.title}`),
          h(Pill, { tone }, progressText(item, t)),
        ),
        h('div', { className: 'dsh-wp-subtask-meta' },
          h('span', null, `${t('who')}：${deptName(t, subtask.department)} · ${subtask.role}`),
        ),
        h('div', { className: 'dsh-wp-subtask-body' },
          h('p', null, h('strong', null, `${t('what')}：`), subtask.objective),
          h('div', null, h('strong', null, `${t('how')}：`), h(Bullets, { items: subtask.method })),
          h('div', null, h('strong', null, `${t('doneWhen')}：`), h(Bullets, { items: subtask.acceptance })),
          subtask.outputs?.length ? h('div', null, h('strong', null, `${t('willDeliver')}：`), h(Bullets, { items: subtask.outputs })) : null,
          subtask.dependsOn?.length ? h('p', { className: 'dsh-wp-muted' }, `${t('waitFor')}：先等前面的工作做完，才能开始这一步。`) : null,
        ),
        status === 'in_progress' ? h(Progress, { value: pct, tone }) : null,
        status === 'in_progress' ? h('div', { className: 'dsh-wp-progress-meta' }, h('span', null, `${t('progressLabel')} ${pct}%`)) : null,
        status !== 'blocked' && item?.summary ? h('p', { className: 'dsh-wp-muted' }, `${t('summary')}：${plainError(item.summary)}`) : null,
        item?.error ? h('p', { className: 'dsh-wp-error-text' }, `${t('blockedReason')}：${plainError(item.error)}`) : null,
        h('details', { className: 'dsh-wp-details' },
          h('summary', null, t('more')),
          h('div', { className: 'dsh-wp-grid', style: { marginTop: '8px' } },
            h(Field, { label: t('person') }, subtask.role || '—'),
            h(Field, { label: t('inputs') }, h(Bullets, { items: subtask.inputs })),
            h(Field, { label: t('risk') }, subtask.risk || '—'),
            h(Field, { label: t('planId') }, subtask.id || '—'),
          ),
        ),
      )
    }

    function StageCard({ stage, statuses, index, t }: any) {
      const byId = useMemo(() => new Map((statuses || []).map((item: any) => [item.subtaskId, item])), [statuses])
      const items = (stage.subtasks || []).map((subtask: any) => ({ subtask, item: byId.get(subtask.id) }))
      const done = items.filter(({ item }: any) => item?.status === 'done').length
      const blocked = items.filter(({ item }: any) => item?.status === 'blocked').length
      const inProgress = items.some(({ item }: any) => item?.status === 'in_progress')
      const tone = blocked > 0 ? 'blocked' : done === items.length ? 'done' : inProgress ? 'active' : 'idle'
      // Same tone/counts as before; only the presentation moved into the
      // collapsed summary row (done/total + state pill), so the numbers keep one
      // source: this step's own items from `statuses`.
      const stateText = blocked > 0
        ? `${blocked} ${t('stats.blocked')}`
        : done === items.length
          ? t('helpDone')
          : inProgress ? t('phase.executing') : t('phase.pending')
      return h('section', { className: `dsh-wp-stage dsh-wp-tone-${tone}` },
        h(Collapse, {
          className: 'dsh-wp-stage-collapse',
          panelClassName: 'dsh-wp-stage-body',
          title: `${stageLabel(t, index)}：${stage.name}`,
          meta: `${done}/${items.length} ${t('stats.done')}`,
          badge: h(Pill, { tone }, stateText),
        },
          h('div', { className: 'dsh-wp-stage-goal' }, `${t('what')}：${stage.goal}`),
          h('div', { className: 'dsh-wp-checkpoint' }, `${t('checkpoint')}：${stage.checkpoint}`),
          items.map(({ subtask, item }: any, subIndex: any) => h(SubtaskRow, { key: subtask.id, subtask, item, index: subIndex, t })),
        ),
      )
    }

    function Analysis({ session, t }: any) {
      const task = session.taskUnderstanding || {}
      const contradictions = session.contradictions || {}
      const primary = contradictions.primary || {}
      return h('details', { className: 'dsh-wp-details' },
        h('summary', null, t('analysis')),
        h('div', { className: 'dsh-wp-muted', style: { marginTop: '6px' } }, t('whyHint')),
        h('div', { className: 'dsh-wp-section' },
          h('div', { className: 'dsh-wp-section-title' }, t('taskUnderstanding')),
          h('div', { className: 'dsh-wp-grid' },
            h(Field, { label: t('deliverable') }, task.deliverable || '—'),
            h(Field, { label: t('successCriteria') }, h(List, { items: task.successCriteria, empty: '—' })),
            h(Field, { label: t('constraints') }, h(List, { items: task.constraints, empty: '—' })),
            h(Field, { label: t('knownFacts') }, h(List, { items: task.knownFacts, empty: '—' })),
            h(Field, { label: t('unknowns') }, h(List, { items: task.unknowns, empty: '—' })),
            h(Field, { label: t('assumptions') }, h(List, { items: task.assumptions, empty: '—' })),
          ),
        ),
        primary.statement ? h('div', { className: 'dsh-wp-section' },
          h('div', { className: 'dsh-wp-section-title' }, t('contradictions')),
          h(Field, { label: t('primaryContradiction') }, primary.statement),
          h('div', { className: 'dsh-wp-grid', style: { marginTop: '8px' } },
            h(Field, { label: t('evidence') }, h(List, { items: primary.evidence, empty: '—' })),
            h(Field, { label: t('whyPrimary') }, primary.whyPrimary || '—'),
            h(Field, { label: t('secondary') }, h(List, { items: contradictions.secondary, empty: '—' })),
            h(Field, { label: t('transformation') }, h(List, { items: contradictions.transformationConditions, empty: '—' })),
          ),
        ) : null,
        session.risks?.length ? h('div', { className: 'dsh-wp-section' },
          h('div', { className: 'dsh-wp-section-title' }, t('risks')),
          session.risks.map((risk: any, index: any) => h('div', { className: 'dsh-wp-field', key: index, style: { marginTop: '6px' } },
            h('div', { className: 'dsh-wp-field-value' }, risk.risk),
            h('div', { className: 'dsh-wp-field-label' },
              `${t('likelihood')}: ${levelText(t, risk.likelihood)} · ${t('impact')}: ${risk.impact}`),
            h('div', { className: 'dsh-wp-muted' }, `${t('mitigation')}: ${risk.mitigation} · ${t('trigger')}: ${risk.trigger}`),
          )),
        ) : null,
        session.verification?.length ? h('div', { className: 'dsh-wp-section' },
          h('div', { className: 'dsh-wp-section-title' }, t('verification')),
          session.verification.map((item: any, index: any) => h('div', { className: 'dsh-wp-field', key: index, style: { marginTop: '6px' } },
            h('div', { className: 'dsh-wp-field-value' }, item.item),
            h('div', { className: 'dsh-wp-muted' }, `${item.method} → ${item.evidence}`),
          )),
        ) : null,
        session.practiceLoop ? h('div', { className: 'dsh-wp-section' },
          h('div', { className: 'dsh-wp-section-title' }, t('practiceLoop')),
          h('div', { className: 'dsh-wp-grid' },
            h(Field, { label: t('plan') }, session.practiceLoop.plan),
            h(Field, { label: t('do') }, session.practiceLoop.do),
            h(Field, { label: t('check') }, session.practiceLoop.check),
            h(Field, { label: t('act') }, session.practiceLoop.act),
          ),
        ) : null,
        h('div', { className: 'dsh-wp-section dsh-wp-muted' }, t('advancedHint')),
        h('div', { className: 'dsh-wp-section dsh-wp-muted dsh-wp-code' },
          `${t('planId')}: ${session.planId || '—'}`),
      )
    }

    // ── 1.5.0 进度图表化：把「做好了 / 卡住了」从一行 12px 文字升级为图表 ──
    // 数据只来自 session.stats / session.stages / session.statuses；全部是纯函数，
    // 无副作用、无新依赖；0/0 与脏数据收敛为「—」，绝不输出 NaN / Infinity。
    const PLAN_RING_SIZE = 44
    const PLAN_RING_RADIUS = 18
    const PLAN_RING_STROKE = 4
    const PLAN_RING_CIRCUMFERENCE = 2 * Math.PI * PLAN_RING_RADIUS

    type PlanTone = 'done' | 'active' | 'blocked' | 'pending' | 'idle'
    type PlanNowState = 'active' | 'blocked' | 'done' | 'pending'

    type PlanCounts = {
      total: number
      done: number
      active: number
      blocked: number
      pending: number
      percent: number | null
    }

    type PlanStageRow = {
      id: string
      name: string
      index: number
      total: number
      done: number
      active: number
      blocked: number
      tone: PlanTone
      current: boolean
    }

    type PlanTaskEntry = { title: string; status: string }
    type PlanNow = { text: string; state: PlanNowState }

    function planCount(value: any): number {
      const number = Number(value)
      if (!Number.isFinite(number)) return 0
      return Math.max(0, Math.round(number))
    }

    // 与 groupTotals 同一套口径：先夹到 [0,total]，再让「正在做/还没开始」
    // 吃掉剩余量，四段之和恒等于总数（构成条不会溢出或出现负宽度）。
    function planCounts(stats: any): PlanCounts {
      const source = stats || {}
      const total = planCount(source.total)
      const done = Math.min(planCount(source.done), total)
      const blocked = Math.min(planCount(source.blocked), total - done)
      const active = Math.min(planCount(source.inProgress), total - done - blocked)
      const pending = Math.max(0, total - done - blocked - active)
      const percent = total > 0 ? Math.round((done / total) * 100) : null
      return { total, done, active, blocked, pending, percent }
    }

    function planStatusMap(statuses: any): Map<string, any> {
      const byId = new Map<string, any>()
      for (const item of Array.isArray(statuses) ? statuses : []) {
        if (item && item.subtaskId != null) byId.set(String(item.subtaskId), item)
      }
      return byId
    }

    function planTaskEntries(stages: any, statuses: any): PlanTaskEntry[] {
      const byId = planStatusMap(statuses)
      const entries: PlanTaskEntry[] = []
      for (const stage of Array.isArray(stages) ? stages : []) {
        const subtasks = Array.isArray(stage?.subtasks) ? stage.subtasks : []
        for (const subtask of subtasks) {
          if (subtask?.id == null) continue
          const item = byId.get(String(subtask.id))
          entries.push({ title: String(subtask?.title ?? ''), status: String(item?.status ?? 'pending') })
        }
      }
      return entries
    }

    // 当前阶段＝第一个有「正在做」的阶段；否则第一个还没全部做完的阶段。
    function planCurrentStageId(rows: PlanStageRow[]): string | null {
      const running = rows.find((row) => row.active > 0)
      if (running) return running.id
      const open = rows.find((row) => row.tone !== 'done')
      return open ? open.id : null
    }

    function planStageRows(stages: any, statuses: any): PlanStageRow[] {
      const byId = planStatusMap(statuses)
      const rows: PlanStageRow[] = []
      const list = Array.isArray(stages) ? stages : []
      list.forEach((stage: any, index: number) => {
        const subtasks = Array.isArray(stage?.subtasks) ? stage.subtasks : []
        let done = 0
        let active = 0
        let blocked = 0
        for (const subtask of subtasks) {
          const status = subtask?.id == null ? undefined : byId.get(String(subtask.id))?.status
          if (status === 'done') done += 1
          else if (status === 'in_progress') active += 1
          else if (status === 'blocked') blocked += 1
        }
        const total = subtasks.length
        const tone: PlanTone = blocked > 0
          ? 'blocked'
          : total > 0 && done === total
            ? 'done'
            : active > 0 || done > 0 ? 'active' : 'pending'
        rows.push({
          id: String(stage?.id ?? `stage-${index}`),
          name: String(stage?.name ?? ''),
          index,
          total,
          done,
          active,
          blocked,
          tone,
          current: false,
        })
      })
      const currentId = planCurrentStageId(rows)
      return rows.map((row) => ({ ...row, current: row.id === currentId }))
    }

    // 「现在在做什么」：卡住优先（需要人介入），其次是正在做，再次是全部做完/还没开始。
    function planNow(t: (key: string) => string, counts: PlanCounts, entries: PlanTaskEntry[]): PlanNow {
      const withTitle = (label: string, title?: string): string => (title ? `${label} · ${title}` : label)
      if (counts.blocked > 0) {
        const blocked = entries.find((entry) => entry.status === 'blocked')
        return { state: 'blocked', text: withTitle(t('stats.blocked'), blocked?.title) }
      }
      if (counts.active > 0) {
        const active = entries.find((entry) => entry.status === 'in_progress')
        return { state: 'active', text: withTitle(t('stats.inProgress'), active?.title) }
      }
      if (counts.total > 0 && counts.done === counts.total) return { state: 'done', text: t('helpDone') }
      return { state: 'pending', text: t('stats.pending') }
    }

    function PlanRing({ percent }: { percent: number | null }) {
      const value = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)))
      // 0% 时不画弧：圆头端点会在 12 点方向留下一个与「已完成」混淆的小点。
      const arc = value === null ? 0 : (value / 100) * PLAN_RING_CIRCUMFERENCE
      return h('span', {
        className: 'dsh-wp-planviz-ring',
        'aria-hidden': 'true',
        'data-zero': value === 0 ? 'true' : 'false',
      },
        h('svg', { viewBox: `0 0 ${PLAN_RING_SIZE} ${PLAN_RING_SIZE}`, width: PLAN_RING_SIZE, height: PLAN_RING_SIZE, focusable: 'false' },
          h('circle', {
            className: 'dsh-wp-planring-track',
            cx: PLAN_RING_SIZE / 2,
            cy: PLAN_RING_SIZE / 2,
            r: PLAN_RING_RADIUS,
            fill: 'none',
            strokeWidth: PLAN_RING_STROKE,
          }),
          value !== null && value > 0
            ? h('circle', {
              className: 'dsh-wp-planring-arc',
              cx: PLAN_RING_SIZE / 2,
              cy: PLAN_RING_SIZE / 2,
              r: PLAN_RING_RADIUS,
              fill: 'none',
              strokeWidth: PLAN_RING_STROKE,
              strokeLinecap: 'round',
              strokeDasharray: `${arc} ${PLAN_RING_CIRCUMFERENCE - arc}`,
              transform: `rotate(-90 ${PLAN_RING_SIZE / 2} ${PLAN_RING_SIZE / 2})`,
            })
            : null,
        ),
      )
    }

    function PlanLegend({ t, counts }: { t: (key: string) => string; counts: PlanCounts }) {
      const items = [
        { kind: 'done', label: t('stats.done'), count: counts.done },
        { kind: 'active', label: t('stats.inProgress'), count: counts.active },
        { kind: 'blocked', label: t('stats.blocked'), count: counts.blocked },
        { kind: 'pending', label: t('stats.pending'), count: counts.pending },
      ]
      return h('div', { className: 'dsh-wp-planviz-legend' },
        items.map((item) => h('span', {
          key: item.kind,
          className: 'dsh-wp-planviz-legend-item',
          'data-kind': item.kind,
          'data-count': String(item.count),
        },
          h('span', { className: 'dsh-wp-planviz-legend-dot', 'aria-hidden': 'true' }),
          `${item.label} ${item.count}`,
        )),
      )
    }

    function PlanSegments({ counts }: { counts: PlanCounts }) {
      const segments = [
        { kind: 'done', count: counts.done },
        { kind: 'active', count: counts.active },
        { kind: 'blocked', count: counts.blocked },
        { kind: 'pending', count: counts.pending },
      ]
      return h('div', {
        className: 'dsh-wp-planviz-bar',
        'aria-hidden': 'true',
        'data-total': String(counts.total),
      },
        counts.total === 0
          ? null
          : segments.map((segment) => (segment.count > 0
            ? h('span', {
              key: segment.kind,
              className: 'dsh-wp-planviz-seg',
              'data-kind': segment.kind,
              'data-count': String(segment.count),
              style: { flexGrow: segment.count },
            })
            : null)),
      )
    }

    function PlanStepper({ t, rows }: { t: (key: string) => string; rows: PlanStageRow[] }) {
      if (rows.length < 1 || rows.length > 12) return null
      return h('div', { className: 'dsh-wp-stepper', 'aria-hidden': 'true', 'data-stages': String(rows.length) },
        rows.map((row) => {
          const reach = row.total > 0 ? ((row.done + row.active + row.blocked) / row.total) * 100 : 0
          const width = row.tone === 'pending' ? 0 : reach
          return h('span', {
            key: row.id,
            className: 'dsh-wp-stepper-seg',
            'data-stage-id': row.id,
            'data-tone': row.tone,
            'data-current': row.current ? 'true' : 'false',
            title: `${stageLabel(t, row.index)} ${row.done}/${row.total} ${t('stats.done')}`,
          },
            h('span', {
              className: 'dsh-wp-stepper-fill',
              'data-width': String(Math.round(width)),
              style: { width: `${width}%` },
            }),
          )
        }),
      )
    }

    function PlanViz({ t, counts, now, rows }: { t: (key: string) => string; counts: PlanCounts; now: PlanNow; rows: PlanStageRow[] }) {
      const state = counts.percent === null
        ? 'idle'
        : counts.blocked > 0
          ? 'blocked'
          : counts.percent >= 100 ? 'done' : 'active'
      return h('div', {
        className: 'dsh-wp-planviz',
        'data-percent': counts.percent === null ? 'none' : String(counts.percent),
        'data-alarm': counts.blocked > 0 ? 'true' : 'false',
        'data-state': state,
      },
        h(PlanRing, { percent: counts.percent }),
        h('div', { className: 'dsh-wp-planviz-head' },
          h('span', { className: 'dsh-wp-planviz-pct' }, counts.percent === null ? '—' : `${counts.percent}%`),
          h('span', { className: 'dsh-wp-planviz-scope' }, `${t('scopeThis')} ${counts.done}/${counts.total} ${t('stats.done')}`),
          counts.blocked > 0
            ? h('span', { className: 'dsh-wp-planviz-alarm' }, `${counts.blocked} ${t('stats.blocked')}`)
            : null,
          h('span', { className: 'dsh-wp-planviz-now', 'data-state': now.state },
            h('span', { className: 'dsh-wp-planviz-now-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'dsh-wp-planviz-now-text' }, now.text),
          ),
        ),
        h(PlanSegments, { counts }),
        h(PlanLegend, { t, counts }),
        h(PlanStepper, { t, rows }),
      )
    }

    // 展开后的「分步进度」：逐阶段行 + 加权总体进度，替代旧的一根计划级进度条。
    function PlanOverview({ t, stats, counts, rows }: { t: (key: string) => string; stats: any; counts: PlanCounts; rows: PlanStageRow[] }) {
      const stateOf = (tone: PlanTone): string => (tone === 'done'
        ? t('stats.done')
        : tone === 'active' ? t('stats.inProgress') : tone === 'blocked' ? t('stats.blocked') : t('stats.pending'))
      return h('div', {
        className: 'dsh-wp-planoverview',
        'data-plan-total': String(counts.total),
        'data-plan-done': String(counts.done),
      },
        h('div', { className: 'dsh-wp-planoverview-head' },
          h('span', { className: 'dsh-wp-planoverview-title' }, t('vizStageTitle')),
          h('span', null, `${counts.done}/${counts.total} ${t('stats.done')}`),
        ),
        h('div', { className: 'dsh-wp-planoverview-stats' },
          h('span', null, `${t('vizWeighted')} ${clampPct(stats?.progress ?? 0)}%`),
          h('span', null, `${counts.active} ${t('stats.inProgress')} · ${counts.pending} ${t('stats.pending')}`),
          counts.blocked > 0 ? h('span', null, `${counts.blocked} ${t('stats.blocked')}`) : null,
        ),
        rows.length
          ? h('div', { className: 'dsh-wp-planrows' },
            rows.map((row) => {
              const width = row.total > 0 ? (row.done / row.total) * 100 : 0
              return h('div', {
                key: row.id,
                className: 'dsh-wp-planrow',
                'data-tone': row.tone,
                'data-current': row.current ? 'true' : 'false',
              },
                h('span', { className: 'dsh-wp-planrow-dot', 'aria-hidden': 'true' }),
                h('span', { className: 'dsh-wp-planrow-name' }, `${stageLabel(t, row.index)}：${row.name}`),
                h('span', { className: 'dsh-wp-planrow-bar' },
                  h('span', {
                    className: 'dsh-wp-planrow-fill',
                    'data-width': String(Math.round(width)),
                    style: { width: `${width}%` },
                  }),
                ),
                h('span', { className: 'dsh-wp-planrow-count' }, `${row.done}/${row.total}`),
                h('span', { className: 'dsh-wp-planrow-state' }, stateOf(row.tone)),
              )
            }),
          )
          : null,
      )
    }

    function SessionCard({ session, t, open, onToggle }: any) {
      const domId = `dsh-wp-session-${session.sessionId}`
      const phase = session.phase || 'pending'
      const stats = session.stats || {}
      const tone = phaseTone(phase)
      const departments = Array.isArray(session.departments) ? session.departments : []
      // 1.5.0：折叠卡摘要＝图表（环 + 百分比 + 四段构成条 + 图例 + 阶段步进条）；
      // 数字仍只来自 session.stats，与旧头部的口径完全一致，不引入第二套统计。
      const counts = planCounts(stats)
      const statuses = Array.isArray(session.statuses) ? session.statuses : []
      const stageRows = planStageRows(session.stages, statuses)
      const now = planNow(t, counts, planTaskEntries(session.stages, statuses))
      return h('article', { id: domId, 'data-session-id': session.sessionId, className: `dsh-wp-session dsh-wp-tone-${tone}` },
        h(Collapse, {
          id: `dsh-wp-collapse-${session.sessionId}`,
          open: open === true,
          onOpenChange: onToggle,
          className: 'dsh-wp-session-collapse',
          panelClassName: 'dsh-wp-session-body',
          title: session.title || t('panel'),
          meta: h(PlanViz, { t, counts, now, rows: stageRows }),
          badge: h(Pill, { tone }, t(`phase.${phase}`)),
        },
          session.updatedAt
            ? h('div', { className: 'dsh-wp-meta dsh-wp-session-updated' }, `${t('updatedAt')} ${formatTime(session.updatedAt)}`)
            : null,
          open === true ? h(PlanOverview, { t, stats, counts, rows: stageRows }) : null,
          session.degraded ? h('div', { className: 'dsh-wp-banner dsh-wp-banner--degraded' },
            h('strong', null, t('degraded')),
            h('div', null, plainError(session.error || '')),
            h('div', { className: 'dsh-wp-muted' }, t('degradedHint')),
          ) : null,
          h(Guide, { session, t }),
          departments.length ? h('div', { className: 'dsh-wp-section' },
            h('div', { className: 'dsh-wp-section-title' }, t('who')),
            h('div', { className: 'dsh-wp-departments' },
              departments.map((dept: any) => h(Pill, { key: dept.id, tone: dept.blocked > 0 ? 'blocked' : dept.done === dept.total ? 'done' : 'active' },
                `${deptName(t, dept.id)} ${dept.done}/${dept.total} ${t('stats.done')}`)),
            ),
          ) : null,
          h('div', { className: 'dsh-wp-section' },
            h('div', { className: 'dsh-wp-section-title' }, t('steps')),
            (session.stages || []).map((stage: any, index: any) => h(StageCard, {
              key: stage.id,
              stage,
              statuses: session.statuses || [],
              index,
              t,
            })),
          ),
          Analysis({ session, t }),
          Array.isArray(session.errors) && session.errors.length
            ? h('div', { className: 'dsh-wp-section' },
              h('div', { className: 'dsh-wp-section-title' }, t('error')),
              h('div', { className: 'dsh-wp-error-text' }, session.errors.map(plainError).join('；')),
            )
            : null,
        ),
      )
    }

    const CHART_URL = '/dsh-workplan/vendor/chart.umd.js'
    let chartLibPromise: any = null
    function loadChartLib() {
      if (chartLibPromise) return chartLibPromise
      chartLibPromise = new Promise((resolve) => {
        const scope: any = typeof window === 'undefined' ? null : window
        if (!scope || !scope.document) { resolve(null); return }
        if (scope.Chart) { resolve(scope.Chart); return }
        const script = scope.document.createElement('script')
        script.src = CHART_URL
        script.async = true
        script.onload = () => resolve(scope.Chart || null)
        script.onerror = () => resolve(null)
        scope.document.head.appendChild(script)
      })
      return chartLibPromise
    }

    function GroupCharts({ liveCount, doneCount, liveBars, hiddenBars, t }: any) {
      // 用「状态当 ref」：宿主注入的 React 兼容层不保证有 useRef（实测会抛
      // useRef is not a function），而 useState 一定可用；节点变化才更新，
      // 避免 ref 回调触发无意义的重渲染循环。
      const [wrapEl, setWrapEl] = useState(null)
      // 'fallback' renders a pure-CSS split bar from the first paint, so the
      // card is never an empty canvas while Chart.js is still loading (or when
      // the script is unavailable, e.g. the host has not been restarted yet).
      const [chartState, setChartState] = useState('fallback')
      const barKey = JSON.stringify(liveBars || [])
      // 主题切换要重建图表：文字色 ink 只在建图那一刻从 body 读一次，不重建就会
      // 一直用旧主题的颜色（深色底上压深色字）。主题包通过 body 上的
      // data-ds-dark-theme 属性切换，监听它即可，不引入任何依赖。
      const [themeTick, setThemeTick] = useState(0)
      useEffect(() => {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
        const observer = new MutationObserver(() => setThemeTick((n: number) => n + 1))
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => observer.disconnect()
      }, [])
      useEffect(() => {
        let dropped = false
        const charts: any[] = []
        const reduced = typeof window !== 'undefined' && window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        loadChartLib().then((lib: any) => {
          if (dropped || !lib || !wrapEl) return
          const host: any = wrapEl
          // --dsw-alias-* 由主题包定义在 <body> 上，<html> 读不到自定义属性时会得到 ''，
          // 于是恒回退 #e2e8f0：浅色主题下对白底只有 1.14:1，图例与坐标轴几乎不可见
          // （T4 实测）。改读 body 后浅色 17.43:1 / 深色 15.01:1。
          const ink = getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary').trim() || '#e2e8f0'
          const canvasA: any = host.querySelector('canvas[data-chart="groups"]')
          const canvasB: any = host.querySelector('canvas[data-chart="live"]')
          try {
            if (canvasA && (liveCount + doneCount) > 0) {
              const ctx = canvasA.getContext('2d')
              const liveFill = ctx.createLinearGradient(0, 0, 0, 210)
              liveFill.addColorStop(0, '#fdba74')
              liveFill.addColorStop(1, '#ea580c')
              const doneFill = ctx.createLinearGradient(0, 0, 0, 210)
              doneFill.addColorStop(0, '#7dd3fc')
              doneFill.addColorStop(1, '#0369a1')
              charts.push(new lib(canvasA, {
                type: 'doughnut',
                data: {
                  labels: [t('groupLive'), t('groupDone')],
                  datasets: [{ data: [liveCount, doneCount], backgroundColor: [liveFill, doneFill], borderWidth: 0, hoverOffset: 5 }],
                },
                options: {
                  responsive: true, maintainAspectRatio: false, cutout: '66%',
                  animation: reduced ? false : { duration: 720, easing: 'easeOutQuart' },
                  plugins: {
                    legend: { position: 'bottom', labels: { color: ink, usePointStyle: true, pointStyle: 'circle', boxWidth: 9, boxHeight: 9, padding: 14 } },
                    tooltip: { callbacks: { label: (item: any) => ` ${item.label}: ${item.parsed}` } },
                  },
                },
              }))
            }
            if (canvasB && liveBars.length) {
              charts.push(new lib(canvasB, {
                type: 'bar',
                data: {
                  labels: liveBars.map((bar: any) => bar.label),
                  datasets: [{ data: liveBars.map((bar: any) => bar.value), backgroundColor: 'rgba(249,115,22,.85)', borderRadius: 6, barThickness: 15 }],
                },
                options: {
                  indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                  animation: reduced ? false : { duration: 720, easing: 'easeOutQuart' },
                  scales: {
                    x: { min: 0, max: 100, ticks: { color: ink, callback: (value: any) => `${value}%` }, grid: { color: 'rgba(148,163,184,.18)' } },
                    y: { ticks: { color: ink, font: { size: 11 } }, grid: { display: false } },
                  },
                  plugins: { legend: { display: false }, tooltip: { callbacks: { label: (item: any) => ` ${item.parsed.x}% ${t('stats.done')}` } } },
                },
              }))
            }
          } catch (error) {
            /* Charts are decoration: a canvas failure must never break the panel. */
          }
          if (!dropped && charts.length) setChartState('ready')
        })
        return () => {
          dropped = true
          for (const chart of charts) { try { chart.destroy() } catch (error) { /* ignore */ } }
        }
      }, [liveCount, doneCount, barKey, t, wrapEl, themeTick])
      const sum = liveCount + doneCount
      const livePct = sum > 0 ? (liveCount / sum) * 100 : 0
      const donePct = sum > 0 ? (doneCount / sum) * 100 : 0
      return h('div', {
        className: `dsh-wp-charts dsh-wp-charts--${chartState}`,
        ref: (node: any) => { if (node !== wrapEl) setWrapEl(node) },
      },
        h('div', { className: 'dsh-wp-chart-card' },
          h('div', { className: 'dsh-wp-chart-title' }, t('chartGroups')),
          // canvas 必须始终在 DOM 里：图表是先有 canvas 才能建，建完才把
          // chartState 置 ready。若用 chartState 门控 canvas，就形成
          // 「无 canvas → 不建图 → 不 ready → 无 canvas」的死循环（T3 实测
          // 探针输出 canvasNodes:0 / fallbackBars:1）。改为并存：
          // fallback 在 ready 前可见，ready 后由 CSS 隐藏，canvas 反向隐藏。
          h('div', { className: 'dsh-wp-chart-canvas' }, h('canvas', { 'data-chart': 'groups', role: 'img', 'aria-label': `${t('groupLive')} ${liveCount} / ${t('groupDone')} ${doneCount}` })),
          chartState !== 'ready'
            ? h('div', { className: 'dsh-wp-fallback' },
              h('div', { className: 'dsh-wp-fallback-bar', role: 'img', 'aria-label': `${t('groupLive')} ${liveCount} / ${t('groupDone')} ${doneCount}` },
                h('span', { className: 'dsh-wp-fallback-live', style: { width: `${livePct}%` } }),
                h('span', { className: 'dsh-wp-fallback-done', style: { width: `${donePct}%` } }),
              ),
              h('div', { className: 'dsh-wp-fallback-legend' },
                h('span', null, h('i', { className: 'dsh-wp-fallback-key dsh-wp-fallback-key--live' }), `${t('groupLive')} ${liveCount}`),
                h('span', null, h('i', { className: 'dsh-wp-fallback-key dsh-wp-fallback-key--done' }), `${t('groupDone')} ${doneCount}`),
              ),
            )
            : null,
        ),
        (liveBars || []).length
          ? h('div', { className: 'dsh-wp-chart-card' },
            h('div', { className: 'dsh-wp-chart-title' }, t('chartLive')),
            h('div', { className: 'dsh-wp-chart-canvas' }, h('canvas', { 'data-chart': 'live', role: 'img', 'aria-label': t('chartLive') })),
            hiddenBars > 0 ? h('div', { className: 'dsh-wp-chart-more' }, fill(t('chartMore'), { n: hiddenBars })) : null,
          )
          : null,
      )
    }

    /**
     * 极简 `{name}` 插值：语序留在 locale 里（中文/英文词序不同），代码只负责替换。
     * 未提供的占位符原样保留——宁可露出 `{pct}`，也不渲染出 undefined。
     */
    function fill(template: any, vars: any) {
      return String(template).replace(/\{(\w+)\}/g, (match: string, key: string) => {
        if (!vars || !(key in vars)) return match
        const value = vars[key]
        return value === null || value === undefined ? match : String(value)
      })
    }

    /**
     * 组头完成度聚合——这是 T6 把「一眼看清」变成可测试属性的口径。
     *
     * 只读 T1 已确认的 `session.stats`，不新增接口、不改下发格式：
     *  - total = Σ stats.total，负数与非有限值按 0 计（脏数据不污染分母）
     *  - done  = Σ stats.done，再夹到 [0, total]（done > total 的脏数据不会显示 >100%）
     *  - open  = total - done，所以「进行中 N / 已完成 M」两数相加恒等于 total
     *  - percent = total > 0 ? round(done / total * 100) : null
     *    total 为 0（还没拆出子任务、或阶段处于 degraded）时返回 null，
     *    由文案层输出「完成率暂无数据」，因此永远不会出现 NaN / Infinity。
     *  - active/pending/blocked 只用于 aria 明细，不参与分组判定。
     */
    function groupTotals(list: any) {
      const num = (value: any) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      let total = 0
      let done = 0
      let active = 0
      let pending = 0
      let blocked = 0
      for (const session of Array.isArray(list) ? list : []) {
        const stats = (session && session.stats) || {}
        total += num(stats.total)
        done += num(stats.done)
        active += num(stats.inProgress)
        pending += num(stats.pending)
        blocked += num(stats.blocked)
      }
      total = Math.max(0, total)
      done = Math.min(total, Math.max(0, done))
      return {
        total,
        done,
        open: total - done,
        percent: total > 0 ? Math.round((done / total) * 100) : null,
        active: Math.max(0, active),
        pending: Math.max(0, pending),
        blocked: Math.max(0, blocked),
      }
    }

    /**
     * 零依赖完成度环：两笔内联 SVG 圆（底槽 + 弧），不引第三方库、不用 canvas。
     * 纯装饰（aria-hidden）——百分比同时以纯文本出现在摘要行里，
     * 所以色觉障碍、对比度不足、甚至关掉图形时都仍可读出进度（WCAG 1.4.1 冗余编码）。
     * 弧线色 #0284c7：浅色 #fafafb 上 3.93:1、深色 #1b1c1f 上 4.16:1，均 ≥3:1 图形对比。
     * 0% 不画弧（避免圆头端点在 0 处留下一个小点），中心仍写 0%；未知写「—」。
     */
    function GroupRing({ percent }: any) {
      const size = 44
      const radius = 18
      const stroke = 4
      const circumference = 2 * Math.PI * radius
      const value = typeof percent === 'number' && Number.isFinite(percent)
        ? Math.min(100, Math.max(0, percent))
        : null
      const arc = value === null ? 0 : (value / 100) * circumference
      return h('span', {
        className: 'dsh-wp-group-ring',
        'aria-hidden': 'true',
        // 0% 与「暂无数据」必须在视觉上可区分：0% 加粗零轨（≥3:1），无数则细轨 + 破折号。
        'data-zero': value === 0 ? 'true' : 'false',
      },
        h('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, focusable: 'false' },
          h('circle', {
            className: 'dsh-wp-group-ring-track',
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            strokeWidth: stroke,
          }),
          value !== null && value > 0
            ? h('circle', {
              className: 'dsh-wp-group-ring-arc',
              cx: size / 2,
              cy: size / 2,
              r: radius,
              fill: 'none',
              strokeWidth: stroke,
              strokeLinecap: 'round',
              strokeDasharray: `${arc} ${circumference - arc}`,
              transform: `rotate(-90 ${size / 2} ${size / 2})`,
            })
            : null,
        ),
        h('span', { className: 'dsh-wp-group-ring-label' }, value === null ? '—' : `${value}%`),
      )
    }

    function SessionGroup({ group, list, hasLive, urgent, t, openSessionId, setOpenSessionId }: any) {
      const isDone = group === 'done'
      // 设计稿 §6.4 #1/#6：已完成组在有进行中任务时默认折叠，避免历史任务抢走
      // 「进行中」的视觉权重；没有进行中任务时默认展开，空的进度栏仍是空的。
      // 折叠态由本组件自己持有（不给 users 存偏好），刷新后回到默认，符合 §7.3「不打扰」。
      const [open, setOpen] = useState(!(isDone && hasLive))
      // §7.3「不打扰」的自动展开：只在这两种情形打开一次，不做反复弹开——
      // ① 进行中清零（最后一个任务完成）；② 用户正展开着的卡片被移进本组。
      // 依赖都是布尔值，轮询刷新不会重复触发。
      const holdsOpenCard = list.some((session: any) => session.sessionId === openSessionId)
      useEffect(() => { if (!hasLive) setOpen(true) }, [hasLive])
      useEffect(() => { if (holdsOpenCard) setOpen(true) }, [holdsOpenCard])
      const collapsible = isDone && list.length > 0
      // 折叠只隐藏、不卸载：`hidden` 必须是布尔 true，不能传空字符串——
      // React 对 `hidden` 走 DOM 布尔属性赋值，`el.hidden = ''` 会得到 false，
      // 只剩 CSS 类在遮挡；那样「折叠态 DOM 保留 + 无障碍语义」就不成立。
      const folded = collapsible && !open
      // 稳定的组体 id：按钮的 aria-controls 必须指向真实存在的节点，
      // 折叠后节点仍在 DOM 中，所以展开/折叠两侧都成立。
      const bodyId = `dsh-wp-group-body-${group}`
      // T6：组头完成度摘要 + 零依赖进度环。数值只来自 groupTotals(list)，
      // 先用纯文本给出「进行中 N / 已完成 M（完成率 x%）」，不点开、不看颜色也能读出进度。
      const totals = useMemo(() => groupTotals(list), [list])
      const groupTitle = t(isDone ? 'groupDone' : 'groupLive')
      const hintText = t(isDone ? 'groupDoneHint' : 'groupLiveHint')
      // 用户 Q3：0/0 时不再显示「未完成 0 / 已完成 0（完成率暂无数据）」——
      // 环上已经是「—」，组内空态也已说明没有工作项；再重复一遍 0/0 只是噪声。
      // 全部做完（100%）仍保留整句，因为那时「未完成 0」正是用户要找的结论。
      const summaryText = totals.percent === null
        ? null
        : fill(t('groupSummary'), { open: totals.open, done: totals.done, pct: totals.percent })
      // 读屏用完整句：计数、完成率与三态明细一起念，避免只听到一个孤零零的数字。
      const ariaText = totals.total > 0
        ? fill(t('groupAria'), {
          title: groupTitle,
          plans: list.length,
          total: totals.total,
          done: totals.done,
          pct: totals.percent,
          active: totals.active,
          pending: totals.pending,
          blocked: totals.blocked,
        })
        : fill(t('groupAriaEmpty'), { title: groupTitle, plans: list.length })
      const headChildren = [
        h('span', { key: 'dot', className: 'dsh-wp-group-dot', 'aria-hidden': 'true' }),
        // 组头在折叠态是 <button>，HTML 内容模型不允许 h2 嵌在 button 内，
        // 所以用 span + role=heading 保留文档大纲语义（T2 报告 C2）。
        h('span', { key: 'title', className: 'dsh-wp-group-title', role: 'heading', 'aria-level': 2 }, groupTitle),
        h('span', { key: 'count', className: 'dsh-wp-group-count', title: `${list.length} ${t('groupPlansLabel')}` }, list.length),
        !isDone && urgent > 0 ? h('span', { key: 'alert', className: 'dsh-wp-group-alert' }, `${t('groupNeeds')} ${urgent}`) : null,
        h(GroupRing, { key: 'ring', percent: totals.percent }),
        collapsible ? h('span', { key: 'chevron', className: 'dsh-wp-group-chevron', 'aria-hidden': 'true' }) : null,
        // 摘要独占一整行（CSS 里 flex-basis:100%）：窄面板只截断摘要本身，
        // 组名/徽章/环不会被挤走；完整句放在 title，悬停可读全。
        summaryText === null
          ? null
          : h('span', { key: 'summary', className: 'dsh-wp-group-sub', title: hintText }, summaryText),
      ]
      const head = collapsible
        ? h('button', {
          type: 'button',
          className: 'dsh-wp-group-head dsh-wp-group-head--btn',
          'aria-expanded': open,
          'aria-controls': bodyId,
          'aria-label': `${open ? t('groupCollapse') : t('groupExpand')}。${ariaText}`,
          onClick: () => setOpen(!open),
        }, ...headChildren)
        : h('div', { className: 'dsh-wp-group-head' }, ...headChildren)
      return h('section', {
        className: `dsh-wp-group dsh-wp-group--${group}${folded ? ' dsh-wp-group--folded' : ''}`,
        'data-group': group,
        'data-folded': folded ? 'true' : 'false',
        'data-total': String(totals.total),
        'data-done': String(totals.done),
        'data-percent': totals.percent === null ? 'none' : String(totals.percent),
      },
        head,
        list.length
          ? h('div', {
            id: bodyId,
            className: `dsh-wp-group-body${folded ? ' dsh-wp-group-body--folded' : ''}`,
            hidden: folded ? true : undefined,
            'aria-hidden': folded ? 'true' : undefined,
          }, list.map((session: any) => h(SessionCard, {
            key: session.sessionId,
            session,
            t,
            open: openSessionId === session.sessionId,
            onToggle: (next: boolean) => setOpenSessionId(next ? session.sessionId : null),
          })))
          : h('div', { className: 'dsh-wp-group-empty' }, t(isDone ? 'groupDoneEmpty' : 'groupLiveEmpty')),
      )
    }

    function Donut({ totals, t }: any) {
      const total = Math.max(0, Number(totals?.total) || 0)
      const done = Math.max(0, Number(totals?.done) || 0)
      const active = Math.max(0, Number(totals?.inProgress) || 0)
      const blocked = Math.max(0, Number(totals?.blocked) || 0)
      const pending = Math.max(0, Number(totals?.pending) || 0)
      const percent = total > 0 ? Math.round((done / total) * 100) : 0
      const radius = 42
      const circumference = 2 * Math.PI * radius
      const segments = [
        { key: 'done', value: done, color: 'var(--dsh-wp-done)' },
        { key: 'active', value: active, color: 'var(--dsh-wp-active)' },
        { key: 'blocked', value: blocked, color: 'var(--dsw-alias-state-error-primary)' },
        { key: 'pending', value: pending, color: 'var(--dsw-alias-state-idle-primary)' },
      ]
      let offset = 0
      const arcs: any[] = []
      for (const segment of segments) {
        if (total <= 0 || segment.value <= 0) continue
        const length = (segment.value / total) * circumference
        arcs.push(h('circle', {
          key: segment.key,
          cx: 50,
          cy: 50,
          r: radius,
          fill: 'none',
          stroke: segment.color,
          strokeWidth: 12,
          strokeDasharray: `${length} ${circumference - length}`,
          strokeDashoffset: -offset,
          transform: 'rotate(-90 50 50)',
        }))
        offset += length
      }
      const legend = [
        { key: 'done', label: t('stats.done'), value: done, color: 'var(--dsh-wp-done)' },
        { key: 'active', label: t('stats.inProgress'), value: active, color: 'var(--dsh-wp-active)' },
        { key: 'blocked', label: t('stats.blocked'), value: blocked, color: 'var(--dsw-alias-state-error-primary)' },
        { key: 'pending', label: t('stats.pending'), value: pending, color: 'var(--dsw-alias-state-idle-primary)' },
      ]
      return h('section', { className: 'dsh-wp-chart-card dsh-wp-donut-card' },
        h('div', { className: 'dsh-wp-section-title' }, t('statusChart')),
        h('div', { className: 'dsh-wp-donut-wrap' },
          h('svg', { className: 'dsh-wp-donut', viewBox: '0 0 100 100', role: 'img', 'aria-label': t('statusChart') },
            h('circle', {
              cx: 50, cy: 50, r: radius, fill: 'none',
              stroke: 'var(--dsw-alias-bg-layer-2)', strokeWidth: 12,
            }),
            arcs,
          ),
          h('div', { className: 'dsh-wp-donut-center' },
            h('strong', null, `${percent}%`),
            h('span', null, t('stats.done')),
          ),
        ),
        h('div', { className: 'dsh-wp-legend' },
          legend.map((item: any) => h('span', { key: item.key, className: 'dsh-wp-legend-item' },
            h('i', { className: 'dsh-wp-legend-dot', style: { background: item.color } }),
            `${item.label} ${item.value}`,
          )),
        ),
      )
    }

    function TaskBars({ sessions, t, onSelect }: any) {
      return h('section', { className: 'dsh-wp-chart-card dsh-wp-task-bars' },
        h('div', { className: 'dsh-wp-section-title' }, t('taskChart')),
        (Array.isArray(sessions) ? sessions : []).map((session: any) => {
          const stats = session.stats || {}
          const total = Math.max(0, Number(stats.total) || 0)
          const done = Math.max(0, Number(stats.done) || 0)
          const percent = total > 0 ? Math.round((done / total) * 100) : 0
          const tone = phaseTone(session.phase || 'pending')
          return h('button', {
            key: session.sessionId,
            type: 'button',
            className: 'dsh-wp-bar-row dsh-wp-bar-button',
            'aria-label': `${t('jumpToTask')} ${session.title || t('panel')}`,
            onClick: () => { if (typeof onSelect === 'function') onSelect(session.sessionId) },
          },
            h('div', { className: 'dsh-wp-bar-head' },
              h('span', { className: 'dsh-wp-bar-title' }, session.title || t('panel')),
              h('span', { className: 'dsh-wp-bar-value' }, `${done}/${total}`),
            ),
            h('div', { className: 'dsh-wp-bar-track' },
              h('div', { className: `dsh-wp-bar-fill dsh-wp-bar-fill--${tone}`, style: { width: `${percent}%` } }),
            ),
            h('div', { className: 'dsh-wp-bar-meta' },
              h('span', null, t(`phase.${session.phase || 'pending'}`)),
              h('span', null, `${percent}%`),
            ),
          )
        }),
      )
    }

    function Dashboard({ t }: any) {
      const { sessions, error, loading, updatedAt, reload } = usePlans()
      const [openSessionId, setOpenSessionId] = useState(null)
      const selectSession = useCallback((sessionId: string) => {
        if (!sessionId) return
        setOpenSessionId(sessionId)
        const reveal = () => {
          const target = document.getElementById(`dsh-wp-session-${sessionId}`)
          if (!target) return
          if (typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ block: 'start', behavior: 'smooth' })
          }
          const toggle = target.querySelector('.dsh-wp-collapse-toggle')
          if (toggle && typeof (toggle as any).focus === 'function') {
            ;(toggle as any).focus({ preventScroll: true })
          }
        }
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => setTimeout(reveal, 60))
        } else {
          setTimeout(reveal, 60)
        }
      }, [])
      const activeSessions = useMemo(
        () => sessions.filter((session: any) => session.phase !== 'cancelled'),
        [sessions],
      )
      const totals = useMemo(() => {
        let total = 0
        let done = 0
        let blocked = 0
        let inProgress = 0
        let pending = 0
        for (const session of activeSessions) {
          total += session.stats?.total ?? 0
          done += session.stats?.done ?? 0
          blocked += session.stats?.blocked ?? 0
          inProgress += session.stats?.inProgress ?? 0
          pending += session.stats?.pending ?? 0
        }
        return { total, done, blocked, inProgress, pending }
      }, [activeSessions])
      const groups = useMemo(() => {
        const live: any[] = []
        const finished: any[] = []
        const urgentPhases = ['blocked', 'degraded', 'paused']
        for (const session of activeSessions) {
          if (session.phase === 'done') finished.push(session)
          else live.push(session)
        }
        /*
         * 设计稿 §3.3：blocked 单独最优先（0），paused/degraded 次之（1），
         * executing(2) → integrating(3) → planning(4) → pending(5) 逐档展开。
         * 同档用 createdAt 倒序，sessionId 只做稳定兜底——不用 updatedAt：
         * 轮询每 4 秒刷新它，会让卡片在用户眼前反复跳位（§7.2 禁止布局动画）。
         */
        const phaseRank: Record<string, number> = {
          blocked: 0,
          paused: 1,
          degraded: 1,
          executing: 2,
          integrating: 3,
          planning: 4,
          pending: 5,
        }
        const rank = (session: any) => phaseRank[session.phase] ?? 5
        live.sort((a: any, b: any) => (rank(a) - rank(b))
          || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
          || String(a.sessionId).localeCompare(String(b.sessionId)))
        /*
         * 已完成组按「最近完成在前」（§3.3 / C8）：优先取子任务
         * statuses[].finishedAt 的最大值（忽略 null / 非数字），缺失则退回
         * updatedAt，再退回 createdAt。不能直接用 updatedAt：它会被轮询刷新，
         * 把「最近完成」变成「最近刷新」。
         */
        const toFinite = (value: any) => {
          if (value === null || value === undefined) return null
          const parsed = Number(value)
          return Number.isFinite(parsed) ? parsed : null
        }
        const finishedAt = (session: any) => {
          let latest: number | null = null
          for (const item of Array.isArray(session.statuses) ? session.statuses : []) {
            const at = toFinite(item?.finishedAt)
            if (at !== null && (latest === null || at > latest)) latest = at
          }
          if (latest !== null) return latest
          return toFinite(session.updatedAt) ?? toFinite(session.createdAt) ?? 0
        }
        finished.sort((a: any, b: any) => (finishedAt(b) - finishedAt(a))
          || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)))
        return { live, finished, urgent: live.filter((session: any) => urgentPhases.includes(session.phase)).length }
      }, [activeSessions])
      const liveBars = useMemo(() => groups.live.slice(0, 6).map((session: any) => {
        const doneCount = session.stats?.done ?? 0
        const totalCount = session.stats?.total ?? 0
        const raw = String(session.title || t('panel'))
        return {
          label: raw.length > 14 ? `${raw.slice(0, 14)}…` : raw,
          value: totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0,
        }
      }), [groups, t])
      return h('div', { className: 'dsh-wp' },
        h('header', { className: 'dsh-wp-header' },
          h('div', null,
            h('h1', { className: 'dsh-wp-title' }, t('title')),
            h('p', { className: 'dsh-wp-subtitle' }, t('subtitle')),
            h('div', { className: 'dsh-wp-meta' },
              updatedAt ? h('span', null, `${t('updatedAt')} ${formatTime(updatedAt)}`) : null,
              h('span', null, `${t('scopeAll')}：${activeSessions.length} ${t('sessionCount')}，${t('taskBreakdown')} ${totals.total} ${t('subtaskCount')}`),
            ),
          ),
          h('button', { type: 'button', className: 'dsh-wp-button', onClick: reload, disabled: loading }, t('refresh')),
        ),
        error ? h(ErrorBanner, { message: error, onRetry: reload, t }) : null,
        activeSessions.length > 0 ? h('div', { className: 'dsh-wp-statbar', role: 'list' },
          h('div', { className: 'dsh-wp-stat dsh-wp-stat--tasks', role: 'listitem' }, h('div', { className: 'dsh-wp-stat-value' }, activeSessions.length), h('div', { className: 'dsh-wp-stat-label' }, t('sessionCount'))),
          h('div', { className: 'dsh-wp-stat', role: 'listitem' }, h('div', { className: 'dsh-wp-stat-value' }, totals.total), h('div', { className: 'dsh-wp-stat-label' }, t('workItems'))),
          h('div', { className: 'dsh-wp-stat dsh-wp-stat--done', role: 'listitem' }, h('div', { className: 'dsh-wp-stat-value' }, totals.done), h('div', { className: 'dsh-wp-stat-label' }, t('stats.done'))),
          h('div', { className: 'dsh-wp-stat dsh-wp-stat--active', role: 'listitem' }, h('div', { className: 'dsh-wp-stat-value' }, totals.inProgress), h('div', { className: 'dsh-wp-stat-label' }, t('stats.inProgress'))),
          h('div', { className: 'dsh-wp-stat dsh-wp-stat--blocked', role: 'listitem' }, h('div', { className: 'dsh-wp-stat-value' }, totals.blocked), h('div', { className: 'dsh-wp-stat-label' }, t('stats.blocked'))),
        ) : null,
        activeSessions.length > 0 ? h('div', { className: 'dsh-wp-scope-note' }, t('allPlansHint')) : null,
        activeSessions.length === 0
          ? h('div', { className: 'dsh-wp-empty' }, h('div', { style: { fontWeight: 650, marginBottom: '4px' } }, t('empty')), h('div', null, t('emptyHint')))
          : h('div', { className: 'dsh-wp-groups' },
            h(SessionGroup, { group: 'live', list: groups.live, urgent: groups.urgent, t, openSessionId, setOpenSessionId }),
            h(SessionGroup, { group: 'done', list: groups.finished, hasLive: groups.live.length > 0, urgent: 0, t, openSessionId, setOpenSessionId }),
            // 用户选择 B：总览块（完成率环 + 每个计划的进度条）同样下移到两组之后，
            // 让开屏第一屏直接是「进行中」组的任务卡（此前统计条 → 总览 → 说明行 →
            // 任务卡，第一张卡要下滑约一屏）。顶部只保留 5 格数字统计条与一行口径说明。
            activeSessions.length > 0 ? h('div', { className: 'dsh-wp-overview' },
              h(Donut, { totals, t }),
              h(TaskBars, { sessions: activeSessions, t, onSelect: selectSession }),
            ) : null,
            // 图表放两组之后：两张卡各 ≈246px，排在组前会让首屏看不到任何一张任务卡
            // （设计稿 §8 第 12 条，T8 复核时复现在 1.4.2 源码里）。
            h(GroupCharts, { liveCount: groups.live.length, doneCount: groups.finished.length, liveBars, hiddenBars: Math.max(0, groups.live.length - 6), t }),
          ),
      )
    }

    function TurnCard({ sessionId, turn, t }: any) {
      const { sessions } = usePlans(sessionId)
      const session = sessions[0]
      if (!session) return null
      const createdTurn = typeof session.createdTurn === 'number' ? session.createdTurn : null
      const currentTurn = typeof turn?.turn === 'number' ? turn.turn : null
      if (createdTurn !== null && currentTurn !== null) {
        if (currentTurn < createdTurn) return null
        const active = ['planning', 'executing', 'blocked'].includes(session.phase)
        if (currentTurn > createdTurn && !active) return null
      }
      const stats = session.stats || {}
      const tone = phaseTone(session.phase || 'pending')
      return h('div', { className: `dsh-wp-turn dsh-wp-tone-${tone}` },
        h('div', { className: 'dsh-wp-turn-title' },
          h('span', null, session.title || t('panel')),
          h(Pill, { tone }, t(`phase.${session.phase || 'pending'}`)),
        ),
        h('div', { className: 'dsh-wp-muted', style: { marginTop: '6px' } },
          `${t('helpWho')}：${workerText(session, t)}`),
        h('div', { className: 'dsh-wp-muted', style: { marginTop: '2px' } },
          `${t('helpNext')}：${nextText(session, t)}`),
        h('div', { className: 'dsh-wp-progress-meta' },
          h('span', null, `${stats.done ?? 0}/${stats.total ?? 0} ${t('stats.done')} · ${stats.blocked ?? 0} ${t('stats.blocked')}`),
          h('span', { className: 'dsh-wp-muted' }, t('viewHint')),
        ),
      )
    }

    function contentText(block: any) {
      if (!block || !Array.isArray(block.content)) return ''
      return block.content
        .filter((item: any) => item && item.type === 'text' && typeof item.text === 'string')
        .map((item: any) => item.text)
        .join('\n')
        .trim()
    }

    function ToolRow({ title, argsLabel, phase, argsRaw, block, t }: any) {
      let args: any = null
      if (typeof argsRaw === 'string' && argsRaw.trim() !== '') {
        try {
          args = JSON.parse(argsRaw)
        } catch {
          args = null
        }
      }
      const finished = phase === 'result'
      const text = finished ? contentText(block) : ''
      const failed = finished && block?.isError === true
      const label = failed
        ? t('toolFailed')
        : phase === 'preparing'
          ? t('toolPreparing')
          : phase === 'start'
            ? t('toolRunning')
            : t('toolDone')
      return h('div', { className: 'dsh-wp-tool' },
        h('div', { className: 'dsh-wp-tool-head' },
          h('span', null, title),
          h(Pill, { tone: failed ? 'blocked' : finished ? 'done' : 'active' }, label),
        ),
        args ? h('div', { className: 'dsh-wp-tool-body' },
          `${argsLabel}: ${args.subtaskId ? `${args.subtaskId} → ${args.status || ''}` : args.planId || t('toolArgs')}`)
          : null,
        text ? h('div', { className: 'dsh-wp-tool-body' }, text) : null,
        failed && block?.error?.code
          ? h('div', { className: 'dsh-wp-error-text' }, String(block.error.code))
          : null,
      )
    }

    function toolArgsRaw(props: any) {
      if (props.phase === 'start') return props.block?.argsRaw ?? ''
      if (props.phase === 'result') return props.block?.call?.argsRaw ?? ''
      return ''
    }

    function createUpdateView(t: any) {
      return function UpdateView(props: any) {
        return h(ToolRow, {
          title: t('toolUpdateTitle'),
          argsLabel: t('toolArgs'),
          phase: props.phase,
          argsRaw: toolArgsRaw(props),
          block: props.block,
          t,
        })
      }
    }

    function createDispatchView(t: any) {
      return function DispatchView(props: any) {
        return h(ToolRow, {
          title: t('toolDispatchTitle'),
          argsLabel: t('toolArgs'),
          phase: props.phase,
          argsRaw: toolArgsRaw(props),
          block: props.block,
          t,
        })
      }
    }

    function WorkplanIcon() {
      return h('span', { className: 'dsh-wp-sidebar-icon', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('rect', { x: 3, y: 4, width: 18, height: 4, rx: 1.5 }),
          h('rect', { x: 3, y: 10.5, width: 12, height: 4, rx: 1.5 }),
          h('rect', { x: 3, y: 17, width: 15, height: 4, rx: 1.5 }),
          h('circle', { cx: 19, cy: 19, r: 2, fill: 'currentColor', stroke: 'none' }),
        ),
      )
    }

    type BoundaryProps = { label?: string; children?: any }

    class Boundary extends React.Component<BoundaryProps, { failed: boolean }> {
      constructor(props: BoundaryProps) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        if (this.state.failed) {
          return h('div', { className: 'dsh-wp' },
            h('div', { className: 'dsh-wp-banner dsh-wp-banner--error', role: 'alert' },
              this.props.label || 'Task Workplan',
            ),
          )
        }
        return this.props.children
      }
    }

    function guard(component: any, label: string) {
      return function Guarded(props: any) {
        return h(Boundary, { label }, h(component, props))
      }
    }

    const GuardedDashboard = guard(Dashboard, 'Task Workplan')
    const GuardedTurnCard = guard(TurnCard, 'Task Workplan')

    return {
      inject: ['slots', 'locale'],
      // Reusable presentational components: exported so the task layer and the
      // step layer in this bundle share one disclosure implementation, and so
      // component tests can mount them without copying markup.
      components: { Collapse },
      apply(ctx: any) {
        ctx.effect(() => injectStyles())
        ctx.effect(() => {
          const zh = ctx.locale.register(NS, 'zh', flattenLocale(LOCALE.zh))
          const en = ctx.locale.register(NS, 'en', flattenLocale(LOCALE.en))
          return () => {
            zh?.()
            en?.()
          }
        })
        const boundT = ctx.locale.bind(NS)
        const t = (key: any, ...args: any[]) => {
          const value = boundT(key, ...args)
          if (value === key && String(key).includes('.')) {
            console.warn(`[dsh-workplan] missing locale key: ${String(key)}`)
            return '—'
          }
          return value
        }

        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ t }),
          }, GuardedDashboard),
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 6,
            label: () => t('panel'),
            locale: NS,
          }, WorkplanIcon),
        )

        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'workplan-turn',
            order: 30,
            locale: NS,
            inject: (sessionId: any) => ({ sessionId, t }),
          }, GuardedTurnCard),
        )

        const UpdateView = createUpdateView(t)
        const DispatchView = createDispatchView(t)
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'dsh_workplan_update',
            locale: NS,
          }, UpdateView),
        )
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'dsh_workplan_dispatch',
            locale: NS,
          }, DispatchView),
        )
      },
    }
  },
})
