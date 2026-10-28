/**
 * 生成「改前 / 改后」可视化预览（T8 取证材料）。
 *
 * 为什么需要它：自动化测试只能证明 DOM 属性与文本正确，不能证明「看起来醒目」。
 * 该脚本用与 `tests/*.test.ts` 完全相同的 React 桩把 `client.js` 真实渲染成 HTML，
 * 再把 `src/client.ts` 里的真实 CSS 抽出来，产出一个自包含 HTML（无外部请求、无 CDN、
 * 无第三方依赖），任何人双击即可在同一套样式下比较 1.4.3 与 1.5.0 的卡头。
 *
 * 约束（不得违反）：
 * 1. 数据全部来自真实渲染输出，脚本不手写任何进度数字；
 * 2. CSS 直接从 `src/client.ts` 抽取，如果抽取失败立即抛错，绝不回退到内置样式；
 * 3. DSH 设计 token（`--dsw-alias-*`）在插件里由宿主注入，这里显式给出一套浅色值，
 *    仅为让离线预览可读；它不改变插件在真实宿主里的取色。
 */
import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, 'docs', 'preview')
const OUT_FILE = path.join(OUT_DIR, 'progress-visual-1.5.0.html')

type Stage = {
  id: string
  name: string
  goal: string
  checkpoint: string
  subtasks: Array<{ id: string; title: string; department: string; role: string }>
}

function stage(id: string, name: string, tasks: Array<[string, string]>): Stage {
  return {
    id,
    name,
    goal: `${name}目标`,
    checkpoint: `${name}检查点`,
    subtasks: tasks.map(([tid, title]) => ({ id: tid, title, department: 'engineering', role: '工程师' })),
  }
}

function session(input: {
  sessionId: string
  title: string
  phase: string
  stats: Record<string, number>
  stages: Stage[]
  statuses: Array<{ subtaskId: string; status: string }>
}) {
  return {
    ...input,
    planId: `plan-${input.sessionId}`,
    createdAt: 1,
    updatedAt: Date.now(),
    departments: [],
    taskUnderstanding: { deliverable: '一份可视化改造结果' },
    contradictions: { primary: null, secondary: [], transformationConditions: [] },
    risks: [],
    verification: [],
    practiceLoop: null,
    errors: [],
  }
}

const zeroStages = [
  stage('S1', '现状定位', [['T1', '定位插件源码'], ['T2', '整理澄清问题']]),
  stage('S2', '方案设计', [['T3', '设计图表形态'], ['T4', '定义版本策略']]),
  stage('S3', '实现与验证', [['T5', '实现图表渲染'], ['T6', '同步递增版本'], ['T7', '编写单元测试'], ['T8', '截取对比证据']]),
]

const midStages = [
  stage('S1', '现状定位', [['T1', '定位插件源码'], ['T2', '整理澄清问题']]),
  stage('S2', '方案设计', [['T3', '设计图表形态'], ['T4', '定义版本策略']]),
  stage('S3', '实现与验证', [['T5', '实现图表渲染'], ['T6', '同步递增版本'], ['T7', '编写单元测试'], ['T8', '截取对比证据']]),
]

const fixtures = [
  session({
    sessionId: 's-zero',
    title: '核查 1.1.9 是否已进入 CDN 插件索引',
    phase: 'executing',
    stats: { total: 8, done: 0, blocked: 0, inProgress: 1, pending: 7, progress: 0 },
    stages: zeroStages,
    statuses: [{ subtaskId: 'T1', status: 'in_progress' }],
  }),
  session({
    sessionId: 's-mid',
    title: 'dsh 插件多通道版本发布一致性方案',
    phase: 'executing',
    stats: { total: 8, done: 3, blocked: 1, inProgress: 1, pending: 3, progress: 38 },
    stages: midStages,
    statuses: [
      { subtaskId: 'T1', status: 'done' },
      { subtaskId: 'T2', status: 'done' },
      { subtaskId: 'T3', status: 'done' },
      { subtaskId: 'T4', status: 'blocked' },
      { subtaskId: 'T5', status: 'in_progress' },
    ],
  }),
  session({
    sessionId: 's-empty',
    title: '已收尾但没有任何工作项的计划',
    phase: 'done',
    stats: { total: 0, done: 0, blocked: 0, inProgress: 0, pending: 0, progress: 0 },
    stages: [],
    statuses: [],
  }),
]

let localeTable: any = null
let mainComponent: any = null

/** 与 tests/group-summary.test.ts 相同的渲染语义：属性只输出 primitive。 */
function makeRenderer() {
  const render = (node: any): string => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node.type === 'function') {
      const isClass = node.type.prototype && node.type.prototype.render
      if (isClass) return render(new node.type(node.props).render())
      return render(node.type(node.props))
    }
    let attrs = ''
    for (const [key, value] of Object.entries(node.props || {})) {
      if (key === 'children' || value === undefined || value === null) continue
      if (key === 'style' && value && typeof value === 'object') {
        attrs += ` style="${styleToText(value).replace(/"/g, '&quot;')}"`
        continue
      }
      if (typeof value === 'function' || typeof value === 'object') continue
      attrs += ` ${key}="${String(value).replace(/"/g, '&quot;')}"`
    }
    return `<${node.type}${attrs}>${(node.children || []).map(render).join('')}</${node.type}>`
  }
  // 真实 DOM 里 React 会把 style 对象写成内联样式；测试桩刻意丢弃它，
  // 预览必须保留，否则构成条会等宽、阶段填充会消失，看起来比线上更差。
  const styleToText = (style: Record<string, any>): string =>
    Object.entries(style)
      .map(([key, value]) => `${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}:${String(value)}`)
      .join(';')

  // 测试桩把 props 原样输出成 attribute，浏览器不认识 className / key / SVG 驼峰属性，
  // 这里转成真实 DOM 的属性名；除属性名外不改动任何标记。
  const toDom = (html: string): string =>
    html
      .replace(/\sclassName="/g, ' class="')
      .replace(/\skey="[^"]*"/g, '')
      .replace(/\sstrokeWidth="/g, ' stroke-width="')
      .replace(/\sstrokeDasharray="/g, ' stroke-dasharray="')
      .replace(/\sstrokeLinecap="/g, ' stroke-linecap="')
      .replace(/\sstrokeLinejoin="/g, ' stroke-linejoin="')
      .replace(/\sstrokeOpacity="/g, ' stroke-opacity="')
      .replace(/\sfillOpacity="/g, ' fill-opacity="')

  return (node: any) => toDom(render(node))
}

async function renderDashboard(sessions: any[]): Promise<string> {
  let loaded: any = null
  ;(globalThis as any).window = { __ModuleLoader__: { load: (spec: any) => { loaded = spec } } }
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', setAttribute: () => {} }),
    head: { appendChild: () => {} },
  }

  const stateFixture = { loading: false, sessions, error: null, updatedAt: Date.now() }
  let firstState = true
  class Component {
    props: any
    constructor(props: any) { this.props = props }
    render() { return this.props?.children ?? null }
  }
  const ReactStub: any = {
    Component,
    createElement: (type: any, props: any, ...children: any[]) => {
      const next = { ...(props || {}) }
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next, children }
    },
    useState: (init: any) => {
      if (firstState) { firstState = false; return [stateFixture, () => {}] }
      return [init, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
  }

  const clientPath = path.resolve(ROOT, 'client.js')
  await import(`${pathToFileURL(clientPath).href}?preview=${Date.now()}${Math.random()}`)
  if (!loaded) throw new Error('client.js 未通过 window.__ModuleLoader__ 注册')
  const mod = loaded.factory(() => ReactStub)
  const locales: any = {}
  let main: any = null
  const t = (key: string) => (localeTable?.zh?.[key] ?? key)
  const ctx: any = {
    effect(fn: any) { return fn() },
    locale: {
      register(_ns: string, lang: string, obj: any) {
        locales[lang] = obj
        if (lang === 'zh') localeTable = { zh: obj }
        return () => {}
      },
      bind() { return t },
    },
    slots: {
      inject(_name: string, fn: any) { fn() },
      register(spec: any, component: any) { if (spec.name === 'main') main = component; return () => {} },
    },
  }
  mod.apply(ctx)
  if (!main) throw new Error('主面板组件未注册')
  mainComponent = main
  return makeRenderer()(ReactStub.createElement(main, { t }))
}

/** 从 client.ts 抽出真实 CSS；抽不到就失败，绝不静默替换。 */
async function extractCss(): Promise<string> {
  const source = await readFile(path.join(ROOT, 'src', 'client.ts'), 'utf8')
  const openMarker = 'const CSS = `'
  const start = source.indexOf(openMarker)
  if (start === -1) throw new Error('未找到 `const CSS = ` 声明')
  const bodyStart = start + openMarker.length
  const end = source.indexOf('\n`\n', bodyStart)
  if (end === -1) throw new Error('未找到 CSS 模板字符串的结束反引号')
  const css = source.slice(bodyStart, end)
  for (const selector of ['.dsh-wp-planviz', '.dsh-wp-stepper', '.dsh-wp-mini-fill--done', '.dsh-wp-group-ring-track']) {
    if (!css.includes(selector)) throw new Error(`抽取到的 CSS 缺少选择器 ${selector}`)
  }
  return css
}

function sliceSession(html: string, sessionId: string): string {
  const start = html.indexOf(`data-session-id="${sessionId}"`)
  if (start === -1) throw new Error(`渲染结果中找不到 ${sessionId}`)
  const articleStart = html.lastIndexOf('<article', start)
  // 计划卡之间不嵌套 <article>，直接配对自身的 </article>。
  // 不能「截到下一个 <article>」：会话顺序由数据决定，截取会吞掉整组收尾标签，产出不合法 HTML。
  const articleEnd = html.indexOf('</article>', start)
  if (articleEnd === -1) throw new Error(`${sessionId} 的 </article> 未闭合`)
  return html.slice(articleStart, articleEnd + '</article>'.length)
}

function sliceGroup(html: string, group: 'live' | 'done'): string {
  const start = html.indexOf(`data-group="${group}"`)
  if (start === -1) throw new Error(`渲染结果中找不到 ${group} 组`)
  const sectionStart = html.lastIndexOf('<section', start)
  // 按深度配对找到该组自身的 </section>：组内每张计划卡也是一个 <section>，
  // 取第一个 </section> 会把组的收尾标签截断，产出不合法 HTML。
  let depth = 0
  let cursor = sectionStart
  while (cursor < html.length) {
    const openAt = html.indexOf('<section', cursor)
    const closeAt = html.indexOf('</section>', cursor)
    if (closeAt === -1) throw new Error(`${group} 组未闭合`)
    if (openAt !== -1 && openAt < closeAt) { depth += 1; cursor = openAt + '<section'.length; continue }
    depth -= 1
    cursor = closeAt + '</section>'.length
    if (depth === 0) return html.slice(sectionStart, cursor)
  }
  throw new Error(`${group} 组括号不配对`)
}

const TOKENS: Array<[string, string]> = [
  ['--dsw-alias-bg-base', '#ffffff'],
  ['--dsw-alias-bg-elevated', '#ffffff'],
  ['--dsw-alias-bg-layer-1', '#f7f8fa'],
  ['--dsw-alias-bg-layer-2', '#eff2f6'],
  ['--dsw-alias-border-l1', '#e2e6ec'],
  ['--dsw-alias-border-l2', '#d3d9e2'],
  ['--dsw-alias-brand-primary', '#3b6cf6'],
  ['--dsw-alias-label-primary', '#16191d'],
  ['--dsw-alias-label-secondary', '#55606e'],
  ['--dsw-alias-label-tertiary', '#8a94a3'],
  ['--dsw-alias-line-1', '#e2e6ec'],
  ['--dsw-alias-state-error-primary', '#e5484d'],
  ['--dsw-alias-state-idle-primary', '#9aa3b2'],
  ['--dsw-alias-state-warn-primary', '#d97706'],
]

function page(css: string, oldBlock: string, newBlock: string, meta: { generatedAt: string }): string {
  const tokenBlock = TOKENS.map(([name, value]) => `  ${name}: ${value};`).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-workplan 1.4.3 → 1.5.0 进度可视化对比</title>
<style>
:root {
${tokenBlock}
  color-scheme: light;
}
body {
  margin: 0;
  padding: 24px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: 14px/1.6 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif;
}
.wrap { max-width: 760px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 6px; }
.lead { color: var(--dsw-alias-label-secondary); margin: 0 0 18px; }
.compare { display: grid; gap: 14px; margin: 18px 0 22px; }
.pane { border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; padding: 12px; background: var(--dsw-alias-bg-layer-1); }
.pane h2 { font-size: 13px; margin: 0 0 10px; color: var(--dsw-alias-label-secondary); font-weight: 600; }
.badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; margin-left: 6px; }
.badge-old { background: #fde8e8; color: #9b1c1c; }
.badge-new { background: #e3f5ec; color: #10643f; }
.note { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.note code { background: var(--dsw-alias-bg-layer-2); padding: 1px 5px; border-radius: 5px; }
</style>
<style>
/* ===== 以下 CSS 由 scripts/render-preview.ts 从 src/client.ts 原样抽取，未做任何改写 ===== */
${css}
</style>
</head>
<body>
<div class="wrap">
  <h1>dsh-workplan 进度可视化：1.4.3 → 1.5.0</h1>
  <p class="lead">同一套 CSS、同一份数据。左上方是 1.4.3 折叠卡的样子（0% 时条形宽度为 0，只剩灰字），下方是 1.5.0 的实际渲染输出。</p>

  <div class="compare">
    <div class="pane">
      <h2>改前 <span class="badge badge-old">v1.4.3</span></h2>
      <div class="dsh-wp">${oldBlock}</div>
      <p class="note">折叠卡只有 12px 灰字 + 54×5px 迷你条；0% 时迷你条填充宽度为 0、轨道色与卡片底色几乎同色，等于没有图；百分比只在 <code>title</code> 悬停里。</p>
    </div>
    <div class="pane">
      <h2>改后 <span class="badge badge-new">v1.5.0</span>（真实渲染输出）</h2>
      <div class="dsh-wp">${newBlock}</div>
      <p class="note">44px 环形图 + 24px 百分比 + 四段构成条 + 状态图例 + 阶段步进条，全部在折叠态可见；0% 时环轨加粗、构成条整条灰色「还没开始」、当前阶段虚线槽描边。</p>
    </div>
  </div>

  <p class="note">生成时间 ${meta.generatedAt}；改后区块由 <code>node scripts/render-preview.ts</code> 渲染 <code>client.js</code> 得到，改前区块按 1.4.3 的 <code>meta</code> 结构还原（同样的 <code>Collapse</code> 骨架与旧类名）。</p>
</div>
</body>
</html>
`
}

async function main() {
  const emit = process.argv.includes('--emit')
  const html = await renderDashboard(fixtures)
  const zeroCard = sliceSession(html, 's-zero')
  const midCard = sliceSession(html, 's-mid')
  const doneGroup = sliceGroup(html, 'done')

  if (!emit) {
    console.log('=== zeroCard ===')
    console.log(zeroCard.slice(0, 2600))
    console.log('\n=== doneGroup ===')
    console.log(doneGroup.slice(0, 1200))
    return
  }

  const css = await extractCss()
  const oldBlock = await readFile(path.join(ROOT, 'scripts', 'fixtures', 'old-header-1.4.3.html'), 'utf8')
  const newBlock = `${zeroCard}\n${midCard}`
  const htmlPage = page(css, oldBlock.trim(), newBlock, { generatedAt: new Date().toISOString() })
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, htmlPage, 'utf8')
  const groupNote = doneGroup.includes('完成率暂无数据') ? 'BAD: 仍含旧句子' : 'OK: 0/0 组不再出现「完成率暂无数据」'
  console.log(`wrote ${OUT_FILE} (${htmlPage.length} bytes) — ${groupNote}`)
  void mainComponent
}

await main()
