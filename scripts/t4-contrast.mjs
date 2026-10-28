#!/usr/bin/env node
/**
 * T4 对比度与字号实测 — 零依赖、只读。
 *
 * 取值方式（重要，勿简化）：
 *  1) 主题 token 值：从宿主主题包 @deepseek-ai/dsh-client-ui-theme 的
 *     design_platform.css 字面量中解析（该包与运行中的 server 属于同一份 npx 安装，
 *     且 `/assets/index-BXV-oxvX.js` 服务端返回与本地 SHA-256 完全一致）。
 *     选择器实测为 `body{...}` 与 `body[data-ds-dark-theme]{...}`，**不是** :root。
 *  2) 组件声明值：从 plugins/dsh-workplan/client.js（服务端派发字节，与本地同 hash）
 *     的 CSS 字面量中按选择器提取，提取失败即抛错，不做猜测。
 *  3) 半透明叠加：按 CSS Compositing and Blending Level 1，在 **sRGB 非线性通道**
 *     空间做 source-over 合成（α 越小越接近背景，这正是浏览器实际做法）。
 *  4) 亮度/对比度：WCAG 2.x 相对亮度公式（c<=0.03928 时 c/12.92，否则 ((c+0.055)/1.055)^2.4）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const NPX = '<npm-cache>/_npx/_npx/c8633a242642d858/node_modules/@deepseek-ai'
const THEME = path.join(NPX, 'dsh-client-ui-theme/lib/client.js')
const CLIENT = path.join(ROOT, 'client.js')

/* ---------- 颜色 ---------- */
const clamp = (v, a = 0, b = 255) => Math.min(b, Math.max(a, v))
const hex2rgb = (h) => {
  h = h.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a }
}
function parseColor(input, vars, depth = 0) {
  const s = String(input).trim()
  if (depth > 8) throw new Error('var() 解析过深: ' + input)
  if (/^#([0-9a-f]{3,8})$/i.test(s)) return hex2rgb(s)
  if (/^rgba?\(/i.test(s)) {
    const nums = s.replace(/^rgba?\(|\)$/gi, '').split(/[,\s/]+/).filter(Boolean).map(Number)
    return { r: clamp(nums[0]), g: clamp(nums[1]), b: clamp(nums[2]), a: nums.length > 3 ? nums[3] : 1 }
  }
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  let m = s.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s+([\d.]+)%\s*\)$/i)
  if (m) {
    const A = parseColor(m[1], vars, depth + 1), B = parseColor(m[3], vars, depth + 1)
    const wa = Number(m[2]) / 100, wb = Number(m[4]) / 100, w = wa + wb
    // 两者都不透明时，sRGB 空间按权重插值（premultiplied alpha 退化为普通加权）
    return { r: (A.r * wa + B.r * wb) / w, g: (A.g * wa + B.g * wb) / w, b: (A.b * wa + B.b * wb) / w, a: (A.a * wa + B.a * wb) / w }
  }
  m = s.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/)
  if (m) {
    const name = m[1]
    if (vars[name] !== undefined && String(vars[name]).trim() !== '') return parseColor(vars[name], vars, depth + 1)
    if (m[2] !== undefined) return parseColor(m[2], vars, depth + 1)
    throw new Error('未定义且无回退的自定义属性: ' + name)
  }
  throw new Error('无法解析颜色: ' + input)
}
/* source-over 合成（sRGB 非线性通道） */
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
})
const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const rgbStr = (c) => `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/* ---------- 主题 token ---------- */
const themeSrc = fs.readFileSync(THEME, 'utf8')
const lit = themeSrc.match(/var design_platform_css_default = "((?:[^"\\]|\\.)*)"/)
if (!lit) throw new Error('未找到 design_platform_css_default')
const themeCss = JSON.parse('"' + lit[1] + '"')
const blocks = [...themeCss.matchAll(/(body(?:\[data-ds-dark-theme\])?)\{([^}]*)\}/g)].map((m) => ({
  sel: m[1], decls: Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map((d) => [d[1], d[2].trim()])),
}))
if (blocks.length < 4) throw new Error('主题 CSS 块数异常: ' + blocks.length)
const merge = (...xs) => Object.assign({}, ...xs)
const LIGHT = merge(blocks[0].decls, blocks[2].decls)
const DARK = merge(blocks[1].decls, blocks[3].decls)

/* ---------- 组件 CSS 声明 ---------- */
const clientSrc = fs.readFileSync(CLIENT, 'utf8')
function rule(sel) {
  // 必须整条选择器从行首开始，否则 `.dsh-wp-section-title` 会误命中
  // `.dsh-wp-chart-card .dsh-wp-section-title { ... }` 这类叠加选择器的子串
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp('(?:^|\\n)' + esc + ' \\{').exec(clientSrc)
  if (!m) throw new Error('选择器未在派发产物中找到: ' + sel)
  const start = m.index + m[0].length
  const j = clientSrc.indexOf('}', start)
  const body = clientSrc.slice(start, j)
  return Object.fromEntries([...body.matchAll(/([a-z-]+)\s*:\s*([^;]+)(?:;|$)/g)].map((d) => [d[1].trim(), d[2].trim()]))
}
const decl = (sel, prop) => { const r = rule(sel); if (r[prop] === undefined) throw new Error(`${sel} 缺少 ${prop}`); return r[prop] }

/* ---------- 场景 ---------- */
function scene(theme, vars) {
  const pageBg = parseColor(decl('.dsh-wp', 'background'), vars)          // --dsw-alias-bg-base
  // --dsw-alias-bg-elevated 在宿主 CSS 中并不存在 → 回退到 rgba(148,163,184,.05)
  const groupBgDecl = decl('.dsh-wp-group', 'background')
  const groupBg = over(parseColor(groupBgDecl, vars), pageBg)
  const chartDecl = decl('.dsh-wp-chart-card', 'background')
  // 渐变两端：0% 为 rgba(148,163,184,.10)（最不透明，对本卡片文字最不利），100% 为 .02
  const g0 = chartDecl.match(/linear-gradient\(\s*[^,]+,\s*((?:rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8})/)[1]
  const cardBg = over(parseColor(g0, vars), pageBg) // 取渐变最不透明端（最不利）
  const badgeBg = over(parseColor(decl('.dsh-wp-group--live .dsh-wp-group-count', 'background'), vars), groupBg)
  const badgeBgDone = over(parseColor(decl('.dsh-wp-group--done .dsh-wp-group-count', 'background'), vars), groupBg)
  const alertBg = over(parseColor(decl('.dsh-wp-group-alert', 'background'), vars), groupBg)
  // 画布 ink：插件运行时用 getComputedStyle(document.documentElement) 取 --dsw-alias-label-primary；
  // 该 token 只定义在 body 上，html 不继承 → 取值为 ''，回退 '#e2e8f0'（client.js 中的字面量回退）
  const inkFallback = '#e2e8f0'
  const items = [
    ['组标题 .dsh-wp-group-title', '.dsh-wp-group-title', 'color', groupBg],
    ['计数徽章 .dsh-wp-group-count（进行中）', '.dsh-wp-group-count', 'color', badgeBg],
    ['计数徽章 .dsh-wp-group-count（已完成）', '.dsh-wp-group-count', 'color', badgeBgDone],
    ['组头摘要 .dsh-wp-group-sub', '.dsh-wp-group-sub', 'color', groupBg],
    ['完成度环文字 .dsh-wp-group-ring-label', '.dsh-wp-group-ring-label', 'color', groupBg],
    ['需关注徽标 .dsh-wp-group-alert', '.dsh-wp-group-alert', 'color', alertBg],
    ['空组提示 .dsh-wp-group-empty', '.dsh-wp-group-empty', 'color', groupBg],
    ['图表卡标题 .dsh-wp-chart-title', '.dsh-wp-chart-title', 'color', cardBg],
    ['图表 fallback 图例 .dsh-wp-fallback-legend', '.dsh-wp-fallback-legend', 'color', cardBg],
    ['图表卡片小标题 .dsh-wp-section-title', '.dsh-wp-section-title', 'color', cardBg],
    ['环形图图例 .dsh-wp-legend-item', '.dsh-wp-legend-item', 'color', cardBg],
    ['环形图中心说明 .dsh-wp-donut-center span', '.dsh-wp-donut-center span', 'color', cardBg],
  ]
  const rows = items.map(([label, sel, prop, bg]) => {
    // 同属性可出现两次（备用值 + color-mix），rule() 取后者 = 浏览器最终生效值
    const fgDecl = decl(sel, prop)
    const fg = parseColor(fgDecl, vars)
    const fs = rule(sel)['font-size'] ?? rule(sel)['font'] ?? '14px'
    const fw = rule(sel)['font-weight'] ?? '400'
    const px = parseFloat(fs)
    const bold = Number(fw) >= 700
    const large = px >= 24 || (bold && px >= 18.66)
    const r = ratio(fg, bg)
    return { label, theme, fgDecl, fg: hex(fg), bg: hex(bg), fontSizePx: px, fontWeight: Number(fw), large, ratio: +r.toFixed(2), threshold: large ? 3 : 4.5, pass: r >= (large ? 3 : 4.5) }
  })
  // 画布文字（Chart.js legend / ticks）：与 computed style 无关，必须单列
  for (const [what, bg] of [['图表图例/刻度（Chart.js canvas 文字）', cardBg]]) {
    const fg = parseColor(inkFallback, vars)
    const r = ratio(fg, bg)
    rows.push({ label: what, theme, fgDecl: `'${inkFallback}'（回退字面量）`, fg: hex(fg), bg: hex(bg), fontSizePx: 12, fontWeight: 400, large: false, ratio: +r.toFixed(2), threshold: 4.5, pass: r >= 4.5 })
  }
  // 环形图中心百分比：24px，属 WCAG「大字」，阈值 3:1；无显式 color → 继承 .dsh-wp 的 label-primary
  {
    const sel = '.dsh-wp-donut-center strong'
    const fg = parseColor(decl('.dsh-wp', 'color'), vars)
    const r = ratio(fg, cardBg)
    rows.push({ label: `环形图中心百分比 ${sel}（24px 大字）`, theme, fgDecl: '继承 .dsh-wp 的 var(--dsw-alias-label-primary)', fg: hex(fg), bg: hex(cardBg), fontSizePx: 24, fontWeight: 400, large: true, ratio: +r.toFixed(2), threshold: 3, pass: r >= 3 })
  }
  // 交互态：组头按钮 hover 底色 rgba(148,163,184,.10) 压在组卡上
  const hoverBg = over(parseColor('rgba(148,163,184,.10)', vars), groupBg)
  for (const sel of ['.dsh-wp-group-title', '.dsh-wp-group-sub']) {
    const fg = parseColor(decl(sel, 'color'), vars)
    const r = ratio(fg, hoverBg)
    rows.push({ label: `${sel}（组头 hover 态）`, theme, fgDecl: decl(sel, 'color'), fg: hex(fg), bg: hex(hoverBg), fontSizePx: parseFloat(rule(sel)['font-size'] ?? '12'), fontWeight: Number(rule(sel)['font-weight'] ?? '400'), large: false, ratio: +r.toFixed(2), threshold: 4.5, pass: r >= 4.5 })
  }
  // 非文本图形：完成度环弧线（WCAG 1.4.11，阈值 3:1）
  {
    const fg = parseColor('#0284c7', vars) // --dsh-wp-done-ink
    const r = ratio(fg, groupBg)
    rows.push({ label: '完成度环弧线 --dsh-wp-done-ink（非文本 3:1）', theme, fgDecl: 'var(--dsh-wp-done-ink) = #0284c7', fg: hex(fg), bg: hex(groupBg), fontSizePx: 0, fontWeight: 0, large: false, ratio: +r.toFixed(2), threshold: 3, pass: r >= 3 })
  }
  return { theme, pageBg: hex(pageBg), groupBg: hex(groupBg), cardBg: hex(cardBg), rows }
}

/* ---------- 方法自校验（用设计稿 §6.1 的历史基线反推） ---------- */
const v = LIGHT
const white = parseColor('#ffffff', v)
const selfTest = [
  ['黑/白（理论 21.00）', ratio(parseColor('#000', v), white), 21.0],
  ['#767676 / 白（WCAG AA 边界 4.54）', ratio(parseColor('#767676', v), white), 4.54],
  ['旧：橙 #f97316 / 白（设计稿记 2.80）', ratio(parseColor('#f97316', v), white), 2.8],
  ['旧：蓝 #0ea5e9 / 白（设计稿记 2.77）', ratio(parseColor('#0ea5e9', v), white), 2.77],
]
for (const [name, got, want] of selfTest) {
  if (Math.abs(got - want) > 0.02) throw new Error(`方法自校验失败：${name} 实得 ${got.toFixed(2)}，应为 ${want}`)
}
// 设计稿 §6.1 记「旧：错误色 #ec1313 / 12% 红底 3.70:1」。该数字隐含了一个未写明的底色假设：
// 纯白底同配方实得 3.85:1，二者相差 0.15。差异不足以通过自校验，因此仅记录、不改判据。
const docRedCase = ratio(parseColor('#ec1313', v), over(parseColor('rgba(239,68,68,.12)', v), white))
const selfTestNote = `设计稿 3.70:1 vs 本文纯白底同配方 ${docRedCase.toFixed(2)}:1（差 ${(docRedCase - 3.7).toFixed(2)}，设计稿底色假设未复现）`

const out = {
  generatedAt: new Date().toISOString(),
  targets: { themePackage: THEME, componentBundle: CLIENT },
  method: { compositing: 'CSS Compositing L1, source-over in sRGB gamma space', luminance: 'WCAG 2.x relative luminance', thresholds: '4.5:1 normal text / 3:1 large (>=24px, or >=18.66px bold)' },
  tokens: {
    light: { 'label-primary': LIGHT['--dsw-alias-label-primary'], 'label-secondary': LIGHT['--dsw-alias-label-secondary'], 'label-tertiary': LIGHT['--dsw-alias-label-tertiary'], 'bg-base': hex(parseColor(LIGHT['--dsw-alias-bg-base'], LIGHT)), 'bg-elevated': 'undefined → 回退 rgba(148,163,184,.05)', 'line-1': 'undefined → 回退 rgba(148,163,184,.22)' },
    dark: { 'label-primary': DARK['--dsw-alias-label-primary'], 'label-secondary': DARK['--dsw-alias-label-secondary'], 'label-tertiary': DARK['--dsw-alias-label-tertiary'], 'bg-base': hex(parseColor(DARK['--dsw-alias-bg-base'], DARK)), 'bg-elevated': 'undefined → 回退 rgba(148,163,184,.05)', 'line-1': 'undefined → 回退 rgba(148,163,184,.22)' },
  },
  selfTest: selfTest.map(([n, g]) => `${n} = ${g.toFixed(2)}:1`),
  scenes: [scene('light', LIGHT), scene('dark', DARK)],
}
fs.writeFileSync(path.join(ROOT, 'docs/t4-contrast-measurement.json'), JSON.stringify(out, null, 2))

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))
console.log('自校验：', out.selfTest.join(' | '))
for (const s of out.scenes) {
  console.log(`\n=== ${s.theme} === page=${s.pageBg} group=${s.groupBg} card=${s.cardBg}`)
  console.log(pad('元素', 42) + pad('前景', 10) + pad('背景', 10) + pad('px/w', 8) + pad('比值', 8) + '判定')
  for (const r of s.rows) console.log(pad(r.label, 42) + pad(r.fg, 10) + pad(r.bg, 10) + pad(`${r.fontSizePx}/${r.fontWeight}`, 8) + pad(r.ratio + ':1', 8) + (r.pass ? 'PASS' : 'FAIL (阈值 ' + r.threshold + ')'))
}
