/**
 * [3.2.9] 角色上下文包：RCR + Latent Briefing + ASTC 的组装层。
 *
 * 只服务第三层专家（部门负责人 → 全球顶尖专家）。这是 3.2.8 之前真实存在的
 * 信息缺口：专家任务书只有「你的任务 / 质量要求 / 规则摘要」，没有用户原要求
 * 锚点、子任务验收标准、依赖产物引用、历史教训与跨部门答复；专家只能凭一句
 * 任务描述猜验收口径。本模块按 expert/planning 或 expert/execution 路由最相关
 * 的条目，硬事实逐字保留，软内容压成简报，省略项保留 ref。
 *
 * 本模块不写状态、不读会话；只接收 plan/statuses/lessonsBrief 等纯数据。
 */

import { compileBrief, renderBrief, type BriefSource } from './context-brief.js'
import { renderContextOmissions, routeContext, type ContextItem, type ContextStage } from './context-router.js'
import { dependencyResultBrief, findSubtask, flattenSubtasks } from './plan.js'

export interface ExpertContextInput {
  plan: any
  statuses: any
  subtaskId: string
  member: string
  cwd?: string
  stage?: 'planning' | 'execution'
  lessonsBrief?: string
  /** 预算字符；缺省 planning=1500、execution=3200。 */
  budgetChars?: number
}

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function statusOf(statuses: any, id: string): any {
  if (!Array.isArray(statuses)) return null
  return statuses.find((item: any) => item && String(item.subtaskId) === String(id)) ?? null
}

function sameDepartment(a: any, b: any): boolean {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a === b
}

/**
 * 组装专家上下文包。返回空串表示没有可路由条目（旧计划/极简计划），调用方
 * 可直接忽略，不改变任务书原有内容。
 */
export function buildExpertContextPacket(input: ExpertContextInput): string {
  const plan = input?.plan
  const subtaskId = String(input?.subtaskId ?? '')
  if (!plan || !subtaskId) return ''
  /*
   * [3.2.9] fail-open：旧计划/损坏计划可能没有 stages（或 stage.subtasks 非数组）。
   * 这里直接返回空串，调用方按「没有可路由条目」处理；绝不因为上下文包构建
   * 异常而中断 self_effort 接续或专家派发。调用点另有 try/catch 双保险。
   */
  if (!Array.isArray(plan.stages) || plan.stages.some((stage: any) => !Array.isArray(stage?.subtasks))) return ''
  const found = findSubtask(plan, subtaskId)
  const subtask = found?.subtask
  if (!subtask) return ''
  const stage: ContextStage = input.stage === 'planning' ? 'planning' : 'execution'
  const budgetChars = Number.isFinite(Number(input.budgetChars))
    ? Math.max(400, Math.floor(Number(input.budgetChars)))
    : (stage === 'planning' ? 1200 : 2400)
  const current = statusOf(input.statuses, subtaskId)
  const items: ContextItem[] = []

  const anchorCap = Math.min(1400, Math.max(400, Math.floor(budgetChars * 0.45)))
  const anchor = clip(plan?.taskAnchor?.text, anchorCap)
  if (anchor) {
    items.push({
      id: 'anchor',
      kind: 'anchor',
      text: `用户原要求锚点（只读，不得改写；sha256 ${clip(plan?.taskAnchor?.sha256, 16) || '未记录'}）：${anchor}`,
      priority: 'must',
      role: '*',
      stage: '*',
      relevance: 100,
      ref: 'plan.taskAnchor',
    })
  }

  const acceptance = Array.isArray(subtask.acceptance) ? subtask.acceptance : []
  acceptance.slice(0, 8).forEach((value: any, index: number) => {
    const text = clip(value, 300)
    if (!text) return
    items.push({
      id: `acceptance:A${index + 1}`,
      kind: 'acceptance',
      text: `验收 A${index + 1}：${text}`,
      priority: 'must',
      role: '*',
      stage: '*',
      relevance: 95,
      ref: `subtask.${subtaskId}.acceptance[${index}]`,
    })
  })

  const understanding = plan?.taskUnderstanding ?? {}
  const constraints = [
    ...(Array.isArray(understanding.constraints) ? understanding.constraints : []),
    ...(Array.isArray(understanding.successCriteria) ? understanding.successCriteria : []),
  ].filter((value: any) => typeof value === 'string' && value.trim() !== '')
  if (constraints.length > 0) {
    items.push({
      id: 'constraints',
      kind: 'constraint',
      text: `用户约束/成功标准（逐字保留）：${constraints.slice(0, 10).map((value: any) => clip(value, 200)).join('；')}`,
      priority: 'must',
      role: '*',
      stage: '*',
      relevance: 92,
      ref: 'plan.taskUnderstanding.constraints',
    })
    if (constraints.length > 10) {
      items.push({
        id: 'constraints:overflow',
        kind: 'constraint',
        text: `另有 ${constraints.length - 10} 条约束/成功标准未在本次上下文包展开；原文在计划里，按 ref 取回，不得当作不存在。`,
        priority: 'high',
        role: 'expert',
        stage: '*',
        relevance: 80,
        ref: 'plan.taskUnderstanding.constraints',
      })
    }
  }

  const dependsOn = Array.isArray(subtask.dependsOn) ? subtask.dependsOn : []
  for (const depId of dependsOn.slice(0, 8)) {
    const dep = findSubtask(plan, String(depId))?.subtask
    const depStatus = statusOf(input.statuses, String(depId))
    if (!dep && !depStatus) continue
    const artifacts = (Array.isArray(depStatus?.artifacts) ? depStatus.artifacts : [])
      .filter((item: any) => item && item.exists !== false && typeof item.ref === 'string' && item.ref)
      .map((item: any) => String(item.ref))
      .slice(0, 4)
    const summary = dependencyResultBrief(depStatus?.summary)
    const reason = clip(depStatus?.error, 240)
    const text = [
      `依赖 ${String(depId)} ${clip(dep?.title, 80)}｜状态 ${String(depStatus?.status ?? 'pending')}`,
      summary ? `摘要：${summary}` : '',
      reason ? `原因：${reason}` : '',
      artifacts.length > 0 ? `已落盘产物：${artifacts.join('、')}` : '',
    ].filter(Boolean).join('｜')
    items.push({
      id: `dependency:${String(depId)}`,
      kind: 'dependency',
      text,
      priority: 'must',
      role: 'expert',
      stage: '*',
      relevance: 90,
      ref: `status.${String(depId)}`,
    })
  }

  if (dependsOn.length > 8) {
    items.push({
      id: 'dependency:overflow',
      kind: 'dependency',
      text: `另有 ${dependsOn.length - 8} 个依赖未在本次上下文包展开：${dependsOn.slice(8).map((id: any) => String(id)).join('、')}；完整状态见 status。`,
      priority: 'high',
      role: 'expert',
      stage: '*',
      relevance: 85,
      ref: 'plan.stages',
    })
  }
  /*
   * 并行兄弟只给「已完成且可直接复用」的摘要；pending/blocked 兄弟的完整清单
   * 仍在负责人任务书里。专家不需要看到全部并行进展，否则 RCR 又退化成广播。
   */
  const siblings: ContextItem[] = []
  if (Array.isArray(input.statuses)) {
    for (const { subtask: sibling } of flattenSubtasks(plan)) {
      if (!sibling || String(sibling.id) === subtaskId) continue
      if (dependsOn.some((id: any) => String(id) === String(sibling.id))) continue
      const siblingStatus = statusOf(input.statuses, String(sibling.id))
      if (siblingStatus?.status !== 'done') continue
      const summary = dependencyResultBrief(siblingStatus?.summary)
      const artifacts = (Array.isArray(siblingStatus?.artifacts) ? siblingStatus.artifacts : [])
        .filter((item: any) => item && item.exists !== false && typeof item.ref === 'string' && item.ref)
        .map((item: any) => String(item.ref))
        .slice(0, 2)
      if (!summary && artifacts.length === 0) continue
      siblings.push({
        id: `sibling:${String(sibling.id)}`,
        kind: 'sibling',
        text: `兄弟 ${String(sibling.id)} ${clip(sibling.title, 60)}（${String(siblingStatus.status)}）：${summary || '无摘要'}${artifacts.length ? `；产物 ${artifacts.join('、')}` : ''}`,
        priority: sameDepartment(sibling.department, subtask.department) ? 'high' : 'normal',
        role: 'expert',
        stage: 'execution',
        relevance: sameDepartment(sibling.department, subtask.department) ? 72 : 55,
        ref: `status.${String(sibling.id)}`,
      })
    }
  }
  items.push(...siblings)

  if (typeof input.lessonsBrief === 'string' && input.lessonsBrief.trim() !== '') {
    items.push({
      id: 'lessons',
      kind: 'lesson',
      text: input.lessonsBrief.trim(),
      priority: 'high',
      role: 'expert',
      stage: '*',
      relevance: 70,
      ref: 'lessons.jsonl',
    })
  }

  const handoffs = Array.isArray(current?.handoffs) ? current.handoffs : []
  const answered = handoffs.filter((item: any) => item?.status === 'answered' && item?.response)
  const waiting = handoffs.filter((item: any) => item?.status === 'open' || item?.status === 'routed')
  if (answered.length > 0) {
    items.push({
      id: 'handoffs:answered',
      kind: 'handoff',
      text: `跨部门需求答复（事实，不是建议）：${answered.slice(0, 4).map((item: any) => `${String(item.id)}：${clip(item.response, 400)}`).join('；')}`,
      priority: 'must',
      role: 'expert',
      stage: '*',
      relevance: 88,
      ref: 'status.handoffs',
    })
  }
  if (waiting.length > 0) {
    items.push({
      id: 'handoffs:waiting',
      kind: 'handoff',
      text: `跨部门需求仍在等待（不要重复上报；先做不依赖它的部分）：${waiting.slice(0, 4).map((item: any) => `${String(item.id)}：${clip(item.request, 240)}`).join('；')}`,
      priority: 'high',
      role: 'expert',
      stage: '*',
      relevance: 60,
      ref: 'status.handoffs',
    })
  }

  const instruction = current?.instruction
  if (instruction && typeof instruction.text === 'string' && instruction.text.trim() !== '') {
    items.push({
      id: 'instruction',
      kind: 'instruction',
      text: `主 Agent/负责人对你上一次请示的指示（决定，不是建议）：${clip(instruction.text, 1200)}`,
      priority: 'must',
      role: 'expert',
      stage: '*',
      relevance: 100,
      ref: 'status.instruction',
    })
  }

  const risk = clip(subtask.risk, 300)
  if (risk) {
    items.push({
      id: 'risk',
      kind: 'risk',
      text: `本任务风险：${risk}`,
      priority: 'high',
      role: '*',
      stage: '*',
      relevance: 65,
      ref: `subtask.${subtaskId}.risk`,
    })
  }

  if (items.length === 0) return ''
  const routed = routeContext(items, {
    role: 'expert',
    stage,
    chars: budgetChars,
    maxItems: 24,
    perKind: { sibling: 3, dependency: 8, lesson: 1, handoff: 2 },
  })
  if (routed.selected.length === 0) return ''

  const hardKinds = new Set(['anchor', 'acceptance', 'constraint', 'artifact', 'handoff', 'instruction', 'risk'])
  const sources: BriefSource[] = routed.selected.map((item) => ({
    id: item.id,
    text: item.text,
    ...(item.ref ? { ref: item.ref } : {}),
    hard: hardKinds.has(item.kind),
  }))
  const brief = compileBrief(sources, { budgetChars: Math.max(600, budgetChars - 200) })
  const mergedOmissions = [
    ...routed.omitted,
    ...brief.omitted.map((item) => ({
      id: item.id,
      kind: 'background' as const,
      reason: (item.reason === 'absorbed' ? 'budget' : item.reason) as 'empty' | 'duplicate' | 'budget',
      ...(item.ref ? { ref: item.ref } : {}),
    })),
  ]
  const omittedLines = renderContextOmissions(mergedOmissions, 12)
  const body = renderBrief(brief, {
    omitHeader: true,
    includeRefs: false,
    includeOmitted: false,
  })
  return [
    `【RCR 角色上下文包｜expert/${stage}｜${clip(input.member, 40)}｜hash ${brief.hash}｜选中 ${routed.selected.length} 条/${brief.chars} 字】`,
    body,
    ...(omittedLines ? [omittedLines] : []),
    '纪律：硬事实逐字照做；软摘要作线索，按 ref 取原文；勿重复采集已落盘产物或重复上报已答复需求。',
  ].filter(Boolean).join('\n')
}
