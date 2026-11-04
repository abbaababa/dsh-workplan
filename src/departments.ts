/**
 * Department capability catalog (T10 / M2).
 *
 * Before 1.12.0 a department was nothing but a `{zh, en}` label: the planner
 * prompt listed twelve names and `validatePlan` only checked that the value was
 * one of the twelve keys. Nothing described what a department is responsible
 * for, what it produces, or which task vocabulary belongs to it — so "部门分配
 * 是否偏离" was not a question the code could answer.
 *
 * This module is the single source of truth for that missing semantic layer:
 *
 *   - `responsibilities` — what the department owns (used by the planner prompt
 *     and by the child-agent prompt, so a department actually changes execution);
 *   - `outputs` — the typical deliverables (used to explain a match);
 *   - `keywords` — the vocabulary that identifies the department's work. These
 *     are deliberately concrete nouns/verbs, not generic words, because the
 *     matcher must be explainable and must not fire on every task.
 *
 * The catalog is pure data: no model call, no I/O, no configuration. That keeps
 * the audit deterministic and testable, which is exactly what the acceptance
 * criterion ("分配理由可追溯、可复跑") requires.
 *
 * Important boundary: a match is *evidence*, not authority. The model still
 * chooses the department. The runtime only uses this catalog to detect a
 * contradiction that is strong enough to be worth a retry (e.g. a picture-book
 * task growing a penetration-testing subtask).
 */

export interface DepartmentCapability {
  id: string
  zh: string
  en: string
  responsibilities: readonly string[]
  outputs: readonly string[]
  keywords: readonly string[]
}

/**
 * Twelve departments, same ids and labels as `DEPARTMENTS` in plan.ts.
 * A unit test asserts the two tables never drift.
 */
export const DEPARTMENT_CAPABILITIES: readonly DepartmentCapability[] = Object.freeze([
  {
    id: 'engineering',
    zh: '工程研发',
    en: 'Engineering',
    responsibilities: ['代码实现与缺陷修复', '构建、编译与静态检查', '补丁应用与回归用例'],
    outputs: ['代码或补丁', '构建产物', '回归测试结果'],
    keywords: [
      '代码', '实现', '修复', '补丁', 'patch', 'rebase', '构建', '编译', '重构',
      '函数', '接口', '模块', '依赖', '提交', '合并', '分支', 'bug', 'tsc', '单元测试',
    ],
  },
  {
    id: 'research',
    zh: '研究分析',
    en: 'Research',
    responsibilities: ['调研与根因分析', '证据收集与交叉核对', '结论评估与方案对比'],
    outputs: ['诊断报告', '证据索引', '分析与结论'],
    keywords: [
      '调研', '研究', '分析', '诊断', '证据', '评估', '根因', '审计', '对比',
      '假设', '梳理', '阅读', '排查', '定性', '判定', '走查',
    ],
  },
  {
    id: 'design',
    zh: '设计',
    en: 'Design',
    responsibilities: ['交互与信息架构设计', '视觉、布局与样式', '原型与可用性验证'],
    outputs: ['设计稿或原型', '交互说明', '视觉规范'],
    keywords: [
      '设计', '交互', '视觉', '布局', '原型', '样式', '配色', 'UI', 'UX',
      '截图', '红圈', '折叠', '展开', '收起', '点击', '按钮', '页面', '组件', '渲染',
    ],
  },
  {
    id: 'product',
    zh: '产品',
    en: 'Product',
    responsibilities: ['需求澄清与范围界定', '优先级与取舍', '验收标准与用户问题'],
    outputs: ['需求单', '验收标准', '决策问题单'],
    keywords: [
      '需求', '范围', '优先级', '验收标准', '产品', '决策', '用户问题', '方案',
      '取舍', '边界', '排期', '目标',
    ],
  },
  {
    id: 'data',
    zh: '数据',
    en: 'Data',
    responsibilities: ['数据采集与清洗', '指标定义与统计', '数据集与可复现口径'],
    outputs: ['数据集', '指标表', '统计脚本'],
    keywords: [
      '数据', '指标', '统计', '采集', '清洗', 'CSV', '行情', '回测', '量化',
      '数据集', '样本', '口径', '权重', '收益率',
    ],
  },
  {
    id: 'qa',
    zh: '质量验证',
    en: 'QA',
    responsibilities: ['测试设计与执行', '回归与验收证据', '缺陷复现与质量门禁'],
    outputs: ['测试报告', '用例集', '缺陷清单'],
    keywords: [
      '测试', '用例', '回归', '验收', '复现', '缺陷', '质量', '断言',
      '通过率', '门禁', 'npm test', 'fail', '端到端', '推演', '演练',
    ],
  },
  {
    id: 'security',
    zh: '安全',
    en: 'Security',
    responsibilities: ['安全审计与威胁建模', '漏洞与越权验证', '密钥与权限加固'],
    outputs: ['安全报告', '漏洞清单', '加固建议'],
    keywords: [
      '安全', '漏洞', '渗透', '攻击', '越权', '权限', '密钥', '加密',
      '威胁', '加固', '审计日志',
      // [P0-1 recall] Naming an evaluation standard (ISO/IEC 15408 = CC) is a
      // security ask the catalog could not see: MS2 T05-05 was planned without
      // any security subtask.
      'ISO', '15408', 'CC', '等保', '安全评估',
    ],
  },
  {
    id: 'devops',
    zh: '运维',
    en: 'DevOps',
    responsibilities: ['构建发布与制品管理', '流水线与部署', '监控与回滚'],
    outputs: ['发布记录', '流水线配置', '回滚方案'],
    keywords: [
      '发布', '部署', '上线', 'CI', '流水线', '监控', '回滚', '镜像', '制品',
      'npm', 'registry', 'tag', 'release', 'publish', '索引源',
      // [P0-1 recall] Release nouns: the Chinese word for a release tag was
      // missing entirely, so MS2 T05-06 ("打 v1.5.1 标签") named devops work
      // the catalog could not see.
      '标签', '打标签', '发版', '打…标签',
    ],
  },
  {
    id: 'writing',
    zh: '文档写作',
    en: 'Writing',
    responsibilities: ['文档与报告撰写', '结构、措辞与排版', '版本说明与对外文案'],
    outputs: ['文档或报告', 'README 或 CHANGELOG', '对外说明'],
    keywords: [
      '文档', '报告', '说明', '写作', '润色', 'README', 'CHANGELOG',
      '排版', '措辞', '摘要', '变更说明', '对账', '对照表', '验收表',
    ],
  },
  {
    id: 'operations',
    zh: '运营',
    en: 'Operations',
    responsibilities: ['运营方案与活动策划', '用户增长与渠道', '客服与留存'],
    outputs: ['运营方案', '活动计划', '渠道分析'],
    keywords: ['运营', '活动', '增长', '渠道', '客服', '留存', '拉新', '转化'],
  },
  {
    id: 'legal',
    zh: '法务合规',
    en: 'Legal',
    responsibilities: ['合同与条款审查', '版权、许可与合规', '隐私与授权风险'],
    outputs: ['法务意见', '合同条款', '合规清单'],
    // [P0-2 recall] An evaluation/certification standard is a compliance claim,
    // not just a security one: MS2 T05-05 named 「ISO/IEC 15408（CC）国际标准」
    // and got legal as a single incidental hit. These add the standard-level
    // wording only — no single CJK character, so 「法」 alone still matches nothing.
    //
    // No ordered pair here on purpose: '国际…标准' was tried and removed because it
    // fires on the same span as the existing '国际标准' (「参考国际标准做一下排版」
    // went from 1 hit to 2 and crossed REQUIRED_DEPARTMENT_MIN_HITS). T05-05 still
    // hits 5 keywords without it.
    keywords: [
      '法务', '合同', '版权', '许可', '合规', '条款', '法律', '隐私', '授权', '侵权', '国际标准',
      'ISO/IEC 15408', '15408', 'ISO/IEC', 'ISO 标准', 'CC 标准',
      // [P0-4 recall] T05-12 「会不会窃取用户电脑和移动终端里的文件和数据」 is a
      // privacy/authorisation claim and matched nothing: the list had 隐私/授权 but
      // not the verbs a user actually writes. These are plain words, so the
      // intrusion guard keeps legal out of unrelated plans.
      // 「泄露」 alone would also fire on 「内存泄露」 (a memory leak is engineering,
      // not legal); 「信息泄露」 keeps the privacy sense and the keyword count at 22.
      '窃取', '信息泄露', '个人信息', '数据安全', '隐私风险', '移动终端',
    ],
  },
  {
    id: 'finance',
    zh: '财务',
    en: 'Finance',
    responsibilities: ['预算与成本核算', '结算与资金管理', '财务合规与凭证'],
    outputs: ['预算表', '成本核算', '结算记录'],
    keywords: ['财务', '预算', '成本', '结算', '发票', '报销', '资金', '利润', '现金流'],
  },
])

/** Departments whose domain keywords are strong enough to detect intrusion. */
export const DEPARTMENT_INTRUSION_GUARDED: readonly string[] = Object.freeze([
  'security',
  'legal',
  'finance',
  'operations',
])

const CAPABILITY_MAP: Readonly<Record<string, DepartmentCapability>> = Object.freeze(
  Object.fromEntries(DEPARTMENT_CAPABILITIES.map((entry) => [entry.id, entry])),
)

export const DEPARTMENT_CAPABILITY_IDS: readonly string[] = Object.freeze(
  DEPARTMENT_CAPABILITIES.map((entry) => entry.id),
)

export function departmentCapability(id: unknown): DepartmentCapability | null {
  if (typeof id !== 'string') return null
  return CAPABILITY_MAP[id] ?? null
}

/** Max characters allowed between the two halves of an ordered-pair keyword. */
const KEYWORD_PAIR_MAX_GAP = 12

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Keyword match that understands the difference between a CJK substring and a
 * short ASCII token. `ui` must not match inside `build`; `rebase` may match
 * inside `rebased` because that is still the same concept.
 */
export function keywordHit(text: string, keyword: string): boolean {
  if (typeof text !== 'string' || typeof keyword !== 'string') return false
  const haystack = text.toLowerCase()
  const needle = keyword.trim().toLowerCase()
  if (!needle) return false
  // Ordered pair ("打…标签"): CJK inserts objects between verb and noun, so a
  // substring match cannot see 「打 v1.5.1 标签」. Both parts must occur in
  // order and within a short window, otherwise it is not the same sentence.
  if (needle.includes('…')) {
    const parts = needle.split('…').filter(Boolean)
    if (parts.length < 2) return false
    let from = 0
    for (const [index, part] of parts.entries()) {
      const at = haystack.indexOf(part, from)
      if (at < 0) return false
      if (index > 0 && at - from > KEYWORD_PAIR_MAX_GAP) return false
      from = at + part.length
    }
    return true
  }
  if (/^[a-z0-9+#./-]+$/.test(needle) && needle.length <= 3) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(haystack)
  }
  return haystack.includes(needle)
}

/** All catalog keywords of one department that occur in `text`, in catalog order. */
export function matchDepartmentKeywords(text: string, departmentId: string): string[] {
  const capability = departmentCapability(departmentId)
  if (!capability) return []
  return capability.keywords.filter((keyword) => keywordHit(text, keyword))
}

export interface DepartmentScore {
  id: string
  zh: string
  en: string
  score: number
  matched: string[]
}

/**
 * Rank every department against one piece of text.
 *
 * The score is the number of distinct catalog keywords found. It is a
 * deliberately simple, explainable number: every point maps to a keyword the
 * reader can see in the output. No weights are hidden.
 */
export function scoreDepartments(text: string): DepartmentScore[] {
  return DEPARTMENT_CAPABILITIES
    .map((capability) => {
      const matched = capability.keywords.filter((keyword) => keywordHit(text, keyword))
      return {
        id: capability.id,
        zh: capability.zh,
        en: capability.en,
        score: matched.length,
        matched,
      }
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
