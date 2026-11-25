import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3000
const HOST = '0.0.0.0'

const now = Date.now()

const DEMO_SESSIONS = [
  {
    sessionId: 'demo-active-1',
    planId: 'wp-demo-329-active',
    title: 'dsh-workplan v3.2.9 多部门协同发布与回归验收',
    phase: 'executing',
    running: true,
    createdAt: now - 42 * 60 * 1000,
    updatedAt: now,
    createdTurn: 1,
    resumeAvailable: true,
    resumeCount: 0,
    resumeLimit: 3,
    stats: { total: 6, done: 3, blocked: 1, inProgress: 1, pending: 1, progress: 60 },
    departments: ['research', 'engineering', 'qa', 'writing'],
    taskUnderstanding: {
      deliverable: '完成 v3.2.9 架构梳理、核心补丁验证、回归测试报告与发布说明',
      successCriteria: [
        '所有关键子任务具备结构化验收证据',
        '回归测试套件全量通过且无新增告警',
      ],
      constraints: ['不破坏历史会话回放兼容性', '保持零外部运行时依赖'],
      knownFacts: ['当前版本为 3.2.9，已完成上下文优化与缓存计量'],
      unknowns: ['历史旧日志在多轮重规划后的边角回放表现'],
      assumptions: ['本地构建产物 lib/ 与 client.js 已同步最新源码'],
    },
    contradictions: {
      primary: {
        statement: '高严格度的证据门禁与低延迟执行体验之间的张力',
        evidence: ['开工登记与结算回放均需严格留痕', '多阶段串行易增加等待时长'],
        whyPrimary: '直接决定交付可信度与整体推进效率',
      },
      secondary: ['历史字段兼容与代码复杂度膨胀的权衡'],
      transformationConditions: ['统一单一事实源后可同时降低复杂度与误拦率'],
    },
    risks: [
      {
        risk: '多专家并发写入共享路径导致证据覆盖',
        likelihood: 'medium',
        impact: '高',
        mitigation: '按计划与子任务成员隔离产物文件名',
        trigger: '同一子任务并发派发 ≥3 名专家',
      },
    ],
    verification: [
      { item: '类型检查与构建产物一致性', method: 'npm run check && npm run build', evidence: '零 TypeScript 报错且 lib/client 同步' },
    ],
    practiceLoop: {
      plan: '拆解为现状定位、实施验证与文档收尾三个阶段',
      do: '按依赖顺序派发各部门负责人并下派领域专家',
      check: '逐项核验结构化验收证据与磁盘产物',
      act: '将阻塞项沉淀为教训并更新回归测试',
    },
    stages: [
      {
        id: 'S1',
        name: '现状定位与问题排查',
        goal: '摸清现有模块依赖与关键边界条件',
        checkpoint: '输出完整依赖清单与问题定位报告',
        subtasks: [
          {
            id: 'T1',
            title: '梳理核心状态机与回放链路',
            department: 'research',
            role: '架构研究员',
            reasoningEffort: 'high',
            estimateMinutes: 15,
            objective: '梳理 runtime 与 plan 的状态迁移及持久化回放逻辑',
            method: ['通读状态转移与 applyStatus 实现', '核对 live 与 replay 字段白名单'],
            acceptance: ['输出完整状态迁移矩阵', '列出所有潜在分叉点'],
            outputs: ['reports/state-matrix-audit.md'],
            inputs: ['src/plan.ts', 'src/runtime.ts'],
            risk: '长文件容易遗漏边缘分支',
            dependsOn: [],
          },
          {
            id: 'T2',
            title: '核对前端看板口径与无障碍交互',
            department: 'design',
            role: '交互设计师',
            reasoningEffort: 'medium',
            estimateMinutes: 10,
            objective: '核查分组统计、进度环与折叠面板呈现一致性',
            method: ['对比服务端派生统计与客户端展示函数'],
            acceptance: ['完成率与阶段标签在卡片/组头/总览处一致'],
            outputs: ['reports/ui-consistency.md'],
            inputs: ['src/client.ts'],
            risk: '旧载荷字段缺失导致展示异常',
            dependsOn: [],
          },
        ],
      },
      {
        id: 'S2',
        name: '实施验证与回归测试',
        goal: '完成关键修复并跑通全量测试验证',
        checkpoint: '构建产物校验与核心用例通过',
        subtasks: [
          {
            id: 'T3',
            title: '验证构建链路与产物完整性',
            department: 'engineering',
            role: '前端/Node 工程师',
            reasoningEffort: 'high',
            estimateMinutes: 12,
            objective: '确认 TypeScript 编译、产物复制及运行时入口可用',
            method: ['执行 npm run build', '校验 lib/ 与 client.js 一致性'],
            acceptance: ['编译零错误', '入口服务正常响应'],
            outputs: ['client.js', 'lib/host.js'],
            inputs: ['package.json', 'tsconfig.json'],
            risk: 'Node 版本差异导致模块解析失败',
            dependsOn: ['T1'],
          },
          {
            id: 'T4',
            title: '核验多专家下派门禁与原子任务规则',
            department: 'qa',
            role: '质量保障专家',
            reasoningEffort: 'xhigh',
            estimateMinutes: 20,
            objective: '验证高耦合顺序链与多人并行下派的边界行为',
            method: ['构造单通道与多专家边界用例', '核验拦截错误码与放行条件'],
            acceptance: ['所有门禁规则无死锁冲突'],
            outputs: ['reports/delegate-gate-verify.md'],
            inputs: ['src/llm-rules.ts', 'src/v3-contract.ts'],
            risk: '耦合分阈值与提示词建议不一致',
            dependsOn: ['T1'],
          },
          {
            id: 'T5',
            title: '执行端到端回放与长会话压测',
            department: 'qa',
            role: '测试工程师',
            reasoningEffort: 'high',
            estimateMinutes: 18,
            objective: '验证超过 2000 事件的长会话重建与刷新恢复',
            method: ['回放历史会话事件流', '核对修订号单调性与产物路径'],
            acceptance: ['重启前后看板计数与状态完全一致'],
            outputs: ['reports/replay-regression.md'],
            inputs: ['src/runtime.ts'],
            risk: '旧格式快照缺失字段',
            dependsOn: ['T3'],
          },
        ],
      },
      {
        id: 'S3',
        name: '文档收尾与发布交付',
        goal: '汇总验证结论并完成发布记录',
        checkpoint: '发布说明与验收清单齐备',
        subtasks: [
          {
            id: 'T6',
            title: '整理发布说明与变更清单',
            department: 'writing',
            role: '技术文档专家',
            reasoningEffort: 'low',
            estimateMinutes: 8,
            objective: '汇总各阶段产物与验证结论形成对外说明',
            method: ['汇总前置报告并校验版本信息'],
            acceptance: ['变更记录清晰且与源码一致'],
            outputs: ['CHANGELOG.md'],
            inputs: ['reports/replay-regression.md'],
            risk: '遗漏破坏性变更说明',
            dependsOn: ['T4', 'T5'],
          },
        ],
      },
    ],
    statuses: [
      {
        subtaskId: 'T1',
        status: 'done',
        closure: 'reported',
        progress: 100,
        startedAt: now - 40 * 60 * 1000,
        finishedAt: now - 28 * 60 * 1000,
        summary: '已完成核心状态机与回放链路梳理，产物已落盘。',
        timeNotice: { declaredMinutes: 15, reason: '覆盖 plan.ts 与 runtime.ts 主链路' },
        noticeChannel: { state: 'observed' },
      },
      {
        subtaskId: 'T2',
        status: 'done',
        closure: 'reported',
        progress: 100,
        startedAt: now - 38 * 60 * 1000,
        finishedAt: now - 26 * 60 * 1000,
        summary: '已完成看板视觉与统计口径一致性核查。',
        noticeChannel: { state: 'observed' },
      },
      {
        subtaskId: 'T3',
        status: 'done',
        closure: 'reported',
        progress: 100,
        startedAt: now - 25 * 60 * 1000,
        finishedAt: now - 14 * 60 * 1000,
        summary: '构建产物全部同步完成，入口服务响应正常。',
        noticeChannel: { state: 'observed' },
      },
      {
        subtaskId: 'T4',
        status: 'blocked',
        closure: 'escalated',
        progress: 65,
        startedAt: now - 22 * 60 * 1000,
        error: '检测到单通道建议与最小 3 人门禁存在口径分歧，待主 Agent 拍板策略优先级。',
        handoffs: [
          {
            id: 'H1',
            request: '确认高耦合任务单专家豁免阈值是否统一至策略模块',
            department: 'engineering',
            status: 'routed',
          },
        ],
        delegates: [
          { member: '门禁规则专家', role: 'expert', effort: 'high', selfEffort: 'high', status: 'done', summary: '已定位耦合分判定边界' },
          { member: '原子契约专家', role: 'expert', effort: 'high', selfEffort: 'high', status: 'done', summary: '已复现 300 字与连接词拦截条件' },
          { member: '策略路由专家', role: 'expert', effort: 'medium', selfEffort: 'high', status: 'blocked', escalation: { question: '是否按 couplingScore >= 1 统一豁免？' } },
        ],
        delegateCompletion: { done: 2, total: 3, awaitingLeaderSummary: false },
        leaderEstimate: { expected: 3, reported: 3, totalMinutes: 22, missing: [], failed: [] },
        noticeChannel: { state: 'observed' },
      },
      {
        subtaskId: 'T5',
        status: 'in_progress',
        closure: 'acknowledged',
        progress: 55,
        startedAt: now - 12 * 60 * 1000,
        summary: '正在回放长会话事件流并比对修订号单调性。',
        delegates: [
          { member: '回放验证专家', role: 'expert', effort: 'high', selfEffort: 'high', status: 'running' },
          { member: '持久化审计专家', role: 'expert', effort: 'high', selfEffort: 'high', status: 'done', summary: 'WAL 与主日志一致性检查通过' },
          { member: '边界用例专家', role: 'expert', effort: 'medium', selfEffort: 'medium', status: 'done', summary: '重规划替换行计数核对完成' },
        ],
        delegateCompletion: { done: 2, total: 3, awaitingLeaderSummary: false },
        leaderEstimate: { expected: 3, reported: 3, totalMinutes: 18, missing: [], failed: [] },
        noticeChannel: { state: 'observed' },
      },
      {
        subtaskId: 'T6',
        status: 'pending',
        closure: 'pending',
        progress: 0,
      },
    ],
    errors: [],
  },
  {
    sessionId: 'demo-done-1',
    planId: 'wp-demo-329-done',
    title: '供应商 KV 缓存命中率计量接入（v3.2.9）',
    phase: 'done',
    running: false,
    createdAt: now - 180 * 60 * 1000,
    updatedAt: now - 95 * 60 * 1000,
    createdTurn: 1,
    stats: { total: 3, done: 3, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
    departments: ['engineering', 'qa'],
    taskUnderstanding: { deliverable: '完成只读缓存计量模块及单元测试' },
    contradictions: { primary: null, secondary: [], transformationConditions: [] },
    risks: [],
    verification: [],
    practiceLoop: null,
    stages: [
      {
        id: 'S1',
        name: '实现与验收',
        goal: '接入只读 usage 观测与状态汇总',
        checkpoint: '测试通过且不影响主链路',
        subtasks: [
          {
            id: 'T1',
            title: '实现 cache-meter 计量器',
            department: 'engineering',
            role: '后端工程师',
            reasoningEffort: 'medium',
            objective: '按会话汇总 cacheRead 与 cacheWrite 指标',
            method: ['编写滑动容量 Map 统计'],
            acceptance: ['缺失字段如实记 0'],
            outputs: ['src/cache-meter.ts'],
            inputs: [],
            risk: '内存无界增长',
            dependsOn: [],
          },
          {
            id: 'T2',
            title: '接入 status 工具输出',
            department: 'engineering',
            role: '后端工程师',
            reasoningEffort: 'low',
            objective: '在状态查询接口中透出缓存计量摘要',
            method: ['在 runtime 状态快照注入摘要'],
            acceptance: ['status 返回字段完整'],
            outputs: ['src/runtime.ts'],
            inputs: ['src/cache-meter.ts'],
            risk: '无',
            dependsOn: ['T1'],
          },
          {
            id: 'T3',
            title: '补充单元测试并全量回归',
            department: 'qa',
            role: '测试工程师',
            reasoningEffort: 'low',
            objective: '覆盖零值、上限淘汰与异常事件场景',
            method: ['新增 cache-meter.test.ts'],
            acceptance: ['测试全部通过'],
            outputs: ['tests/cache-meter.test.ts'],
            inputs: ['src/cache-meter.ts'],
            risk: '无',
            dependsOn: ['T2'],
          },
        ],
      },
    ],
    statuses: [
      { subtaskId: 'T1', status: 'done', closure: 'reported', progress: 100, finishedAt: now - 130 * 60 * 1000, summary: '已实现有界缓存计量器。' },
      { subtaskId: 'T2', status: 'done', closure: 'reported', progress: 100, finishedAt: now - 110 * 60 * 1000, summary: '已在 status 汇总中接入缓存命中统计。' },
      { subtaskId: 'T3', status: 'done', closure: 'reported', progress: 100, finishedAt: now - 95 * 60 * 1000, summary: '新增单元测试全部通过。' },
    ],
    errors: [],
  },
]

const HOST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>dsh-workplan — Workplan Dashboard</title>
  <meta name="description" content="Automatic task decomposition, real department subagents, and a responsive workplan dashboard for DeepSeek Harness." />
  <meta property="og:title" content="dsh-workplan — Workplan Dashboard" />
  <meta property="og:description" content="Automatic task decomposition, real department subagents, and a responsive workplan dashboard for DeepSeek Harness." />
  <style>
    :root {
      --dsw-alias-bg-base: #ffffff;
      --dsw-alias-bg-elevated: #ffffff;
      --dsw-alias-bg-layer-1: #f7f8fa;
      --dsw-alias-bg-layer-2: #eff2f6;
      --dsw-alias-border-l1: #e2e6ec;
      --dsw-alias-border-l2: #d3d9e2;
      --dsw-alias-brand-primary: #3b6cf6;
      --dsw-alias-label-primary: #16191d;
      --dsw-alias-label-secondary: #55606e;
      --dsw-alias-label-tertiary: #8a94a3;
      --dsw-alias-line-1: #e2e6ec;
      --dsw-alias-state-error-primary: #e5484d;
      --dsw-alias-state-idle-primary: #9aa3b2;
      --dsw-alias-state-warn-primary: #d97706;
      color-scheme: light;
    }
    html, body, #root {
      margin: 0;
      padding: 0;
      height: 100%;
      background: var(--dsw-alias-bg-base);
      color: var(--dsw-alias-label-primary);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", system-ui, sans-serif;
    }
    .dsh-host-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      border-bottom: 1px solid var(--dsw-alias-border-l1);
      background: var(--dsw-alias-bg-layer-1);
      font-size: 13px;
    }
    .dsh-host-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .dsh-host-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dsh-host-btn {
      border: 1px solid var(--dsw-alias-border-l2);
      background: var(--dsw-alias-bg-elevated);
      color: var(--dsw-alias-label-primary);
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    .dsh-host-btn:hover {
      background: var(--dsw-alias-bg-layer-2);
    }
    .dsh-host-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .dsh-host-main {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/vendor/react.js"></script>
  <script src="/vendor/react-dom.js"></script>
  <script>
    (function () {
      var loadedSpec = null;
      window.__ModuleLoader__ = {
        load: function (spec) {
          loadedSpec = spec;
        },
      };
      window.__dshHostBoot = function () {
        if (!loadedSpec) {
          document.getElementById('root').textContent = 'Failed to load dsh-workplan client bundle.';
          return;
        }
        var React = window.React;
        var ReactDOM = window.ReactDOM;
        var mod = loadedSpec.factory(function (id) {
          if (id === 'react') return React;
          throw new Error('Unsupported module: ' + id);
        });

        var locales = {};
        var currentLang = 'zh';
        var mainSlot = null;
        var iconSlot = null;

        var ctx = {
          effect: function (fn) {
            return fn();
          },
          locale: {
            register: function (_ns, lang, table) {
              locales[lang] = table;
              return function () {};
            },
            bind: function () {
              return function (key) {
                var table = locales[currentLang] || locales.zh || {};
                return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
              };
            },
          },
          slots: {
            inject: function (_name, fn) {
              fn();
            },
            register: function (spec, component) {
              if (spec && spec.name === 'main') mainSlot = { spec: spec, component: component };
              if (spec && spec.name === 'sidebar.panellist') iconSlot = { spec: spec, component: component };
              return function () {};
            },
          },
        };

        mod.apply(ctx);

        function HostApp() {
          var langState = React.useState('zh');
          var lang = langState[0];
          var setLang = langState[1];
          currentLang = lang;

          var MainComponent = mainSlot ? mainSlot.component : null;
          var IconComponent = iconSlot ? iconSlot.component : null;
          var props = mainSlot && typeof mainSlot.spec.inject === 'function' ? mainSlot.spec.inject() : {};

          return React.createElement(
            'div',
            { className: 'dsh-host-shell' },
            React.createElement(
              'div',
              { className: 'dsh-host-bar' },
              React.createElement(
                'div',
                { className: 'dsh-host-brand' },
                IconComponent ? React.createElement('span', { style: { width: 18, height: 18, display: 'inline-flex' } }, React.createElement(IconComponent)) : null,
                React.createElement('span', null, 'dsh-workplan v3.2.9')
              ),
              React.createElement(
                'div',
                { className: 'dsh-host-controls' },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-host-btn',
                    onClick: function () { setLang(lang === 'zh' ? 'en' : 'zh'); },
                  },
                  lang === 'zh' ? 'English' : '中文'
                )
              )
            ),
            React.createElement(
              'div',
              { className: 'dsh-host-main' },
              MainComponent ? React.createElement(MainComponent, props) : null
            )
          );
        }

        var container = document.getElementById('root');
        if (typeof ReactDOM.createRoot === 'function') {
          ReactDOM.createRoot(container).render(React.createElement(HostApp));
        } else {
          ReactDOM.render(React.createElement(HostApp), container);
        }
      };
    })();
  </script>
  <script src="/client.js" onload="window.__dshHostBoot()"></script>
</body>
</html>
`

async function serveFile(res, filePath, contentType) {
  try {
    const content = await readFile(filePath)
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store',
    })
    res.end(content)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`Not found: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url.pathname === '/dsh-workplan/plans') {
    const sessionId = url.searchParams.get('sessionId')
    const sessions = sessionId
      ? DEMO_SESSIONS.filter((item) => item.sessionId === sessionId)
      : DEMO_SESSIONS
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify({ ok: true, sessions }))
    return
  }

  if (url.pathname === '/client.js') {
    await serveFile(res, path.join(__dirname, 'client.js'), 'application/javascript; charset=utf-8')
    return
  }

  if (url.pathname === '/vendor/react.js') {
    await serveFile(
      res,
      path.join(__dirname, 'node_modules', 'react', 'umd', 'react.production.min.js'),
      'application/javascript; charset=utf-8',
    )
    return
  }

  if (url.pathname === '/vendor/react-dom.js') {
    await serveFile(
      res,
      path.join(__dirname, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js'),
      'application/javascript; charset=utf-8',
    )
    return
  }

  if (url.pathname === '/icon.svg') {
    await serveFile(res, path.join(__dirname, 'icon.svg'), 'image/svg+xml')
    return
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(HOST_HTML)
})

server.listen(PORT, HOST, () => {
  console.log(`dsh-workplan host preview listening on http://${HOST}:${PORT}`)
})
