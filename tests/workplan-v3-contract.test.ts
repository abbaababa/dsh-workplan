/*
 * [3.0.0] 用户 2026-11-14 十三条底层机制优化中「可机械复算」部分的回归锁。
 *
 * 覆盖：
 *  - 要求 2/4：两条会话固定文案逐字冻结；
 *  - 要求 1：计划消息把用户任务原文带进可见文本；
 *  - 要求 3/6：质量要求读取/渲染/必填；
 *  - 要求 5：极简任务硬门槛（长度、单句、并列词、质量要求）；
 *  - 要求 7/10：专家 JSON 汇报与部门 JSON 汇总的结构与精简（含近义重复）；
 *  - 要求 9：组员角色取消（role 只允许 expert，历史 member 归一）；
 *  - 要求 13：版本号 3.0.0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STATUS_ASSIGNED_TEXT,
  STATUS_ASSIGNING_TEXT,
  checkAtomicAssignment,
  checkDepartmentSummary,
  checkExpertReport,
  diceSimilarity,
  normalizeQualityRequirements,
  renderQualityRequirementsBlock,
} from '../src/v3-contract.js'
import {
  COMM_FORMAT_SPEC,
  COMM_FORMAT_VERSION,
  checkCommFormatCompliance,
  renderCommFormatSpec,
} from '../src/comm-format.js'
import { planDelegations } from '../src/llm-rules.js'
import { buildPlanMessage } from '../src/plan.js'
import { meta } from '../src/host.js'

/* ============================ 要求 2 / 4：固定文案 ============================ */

test('3.0.0 两条固定文案与用户原文逐字一致（6 个半角点）', () => {
  assert.equal(STATUS_ASSIGNING_TEXT, '任务正在分配中，请稍等一下......')
  assert.equal(STATUS_ASSIGNED_TEXT, '任务已经完成分配，正在执行中......')
  assert.equal((STATUS_ASSIGNING_TEXT.match(/\./g) ?? []).length, 6)
  assert.equal((STATUS_ASSIGNED_TEXT.match(/\./g) ?? []).length, 6)
})

/* ============================ 要求 1：任务原文可见 ============================ */

test('要求 1：计划消息的可见文本带用户任务原文（切换会话后仍可读）', () => {
  const taskText = '这是一段用户刚才输入的任务原文：把 A 改成 B，并给出证据。'
  const plan = {
    planId: 'p1',
    sessionId: 's1',
    createdTurn: 1,
    createdAt: 1,
    title: '标题',
    taskAnchor: { text: taskText, sha256: 'abc', length: taskText.length, sourceMessageIds: [] },
    contradictions: { primary: { statement: '主要矛盾' }, secondary: [], transformationConditions: [] },
    stages: [],
    risks: [],
    verification: [],
    practiceLoop: {},
  }
  const message = buildPlanMessage(plan, {})
  const text = message.content.map((block: any) => block.text).join('\n')
  assert.ok(text.includes('用户刚才输入的任务原文'), '必须有一段明示任务原文的可见文本')
  assert.ok(text.includes(taskText), '任务原文必须逐字出现在可见文本里')
})

test('要求 1：没有 taskAnchor 的旧计划不报错、不输出空标题', () => {
  const plan = {
    planId: 'p2',
    sessionId: 's2',
    createdTurn: 1,
    createdAt: 1,
    title: '标题',
    contradictions: { primary: { statement: '矛盾' }, secondary: [], transformationConditions: [] },
    stages: [],
    risks: [],
    verification: [],
    practiceLoop: {},
  }
  const message = buildPlanMessage(plan, {})
  const text = message.content.map((block: any) => block.text).join('\n')
  assert.ok(!text.includes('用户刚才输入的任务原文'))
})

/* ============================ 要求 3 / 6：质量要求 ============================ */

test('质量要求读取：去空、去重、截断、上限 8 条', () => {
  assert.deepEqual(normalizeQualityRequirements([' 必须可执行 ', '必须可执行', '', 7]), ['必须可执行'])
  assert.deepEqual(normalizeQualityRequirements('单条字符串'), ['单条字符串'])
  assert.equal(normalizeQualityRequirements(Array.from({ length: 20 }, (_, i) => `要求${i}`)).length, 8)
  assert.equal(normalizeQualityRequirements(undefined).length, 0)
  const long = 'x'.repeat(500)
  assert.ok(normalizeQualityRequirements([long])[0].length <= 400)
})

test('质量要求渲染块：逐条编号、注明下达方', () => {
  const block = renderQualityRequirementsBlock(['必须附真实命令输出', '必须是可执行的补丁'], '主 Agent')
  assert.ok(block.includes('主 Agent下达'))
  assert.ok(block.includes('1. 必须附真实命令输出'))
  assert.ok(block.includes('2. 必须是可执行的补丁'))
  assert.equal(renderQualityRequirementsBlock([]), '')
})

/* ============================ 要求 5：极简任务硬门槛 ============================ */

const QUALITY = ['必须给出可复现的命令输出作为证据']

test('极简门槛：合格的单项任务通过', () => {
  assert.equal(checkAtomicAssignment('分析 src/a.ts 得出根因结论', QUALITY).ok, true)
})

test('极简门槛：并列词、分号、多句、过长、缺质量要求全部被拒', () => {
  const cases: Array<[string, string]> = [
    ['修复登录报错并且补一条回归用例', 'DELEGATE_TASK_NOT_ATOMIC'],
    ['修复登录报错；补一条回归用例', 'DELEGATE_TASK_NOT_ATOMIC'],
    ['修复登录报错。补一条回归用例。', 'DELEGATE_TASK_NOT_ATOMIC'],
    [`要${'很长的描述'.repeat(60)}`, 'DELEGATE_TASK_NOT_ATOMIC'],
    ['太短', 'DELEGATE_TASK_NOT_ATOMIC'],
  ]
  for (const [task, code] of cases) {
    const result = checkAtomicAssignment(task, QUALITY)
    assert.equal(result.ok, false, task)
    assert.equal(result.code, code, task)
    assert.ok(String(result.hint ?? '').length > 0, '必须给出可照做的拆小提示')
  }
  const missingQuality = checkAtomicAssignment('分析 src/a.ts 得出根因结论', [])
  assert.equal(missingQuality.ok, false)
  assert.equal(missingQuality.code, 'DELEGATE_QUALITY_REQUIREMENTS_MISSING')
})

test('极简门槛：拒绝文案指出具体是哪条规则', () => {
  const tooLong = checkAtomicAssignment(`写${'x'.repeat(320)}`, QUALITY)
  assert.match(String(tooLong.error), /太长/)
  const multi = checkAtomicAssignment('分析同时修复登录报错', QUALITY)
  assert.match(String(multi.error), /并列词/)
})

/* ============================ 要求 7：专家 JSON 汇报 ============================ */

const GOOD_REPORT = {
  keyResults: ['根因是会话消息在规划期被追加到同一 surface，首条用户消息不再渲染'],
  keyInfo: ['复现步骤：发消息 → 切会话 → 切回'],
  importantInfo: ['旧会话回放不受影响'],
  leadRequirements: ['给出根因报告：已给出'],
}

test('专家汇报：合法精简 JSON 通过', () => {
  assert.deepEqual(checkExpertReport(GOOD_REPORT), { ok: true, violations: [] })
})

test('专家汇报：缺对象、缺字段、超条数、超长、重复、多余字段都被拒', () => {
  assert.equal(checkExpertReport(undefined).code, 'REPORT_INVALID')
  assert.equal(checkExpertReport({ keyResults: ['x'] }).ok, false)
  assert.equal(checkExpertReport({ ...GOOD_REPORT, keyResults: Array.from({ length: 7 }, (_, i) => `成果${i}`) }).ok, false)
  assert.equal(checkExpertReport({ ...GOOD_REPORT, keyResults: ['x'.repeat(300)] }).ok, false)
  assert.equal(checkExpertReport({ ...GOOD_REPORT, keyResults: ['重复的一条关键成果，长度足够长'] , keyInfo: ['重复的一条关键成果，长度足够长'] }).ok, false)
  assert.equal(checkExpertReport({ ...GOOD_REPORT, extra: ['多出来的字段'] }).ok, false)
})

test('专家汇报：近义重复（Dice ≥ 0.85）被拒', () => {
  const a = '根因是会话消息在规划期被追加到同一 surface，首条用户消息不再渲染'
  const b = '根因是会话消息在规划期被追加到同一 surface 里，首条用户消息不再渲染'
  assert.ok(diceSimilarity(a, b) >= 0.85, `dice=${diceSimilarity(a, b)}`)
  const result = checkExpertReport({ ...GOOD_REPORT, keyResults: [a], keyInfo: [b] })
  assert.equal(result.ok, false)
})

test('专家汇报：去重键相同即视为同一条信息', () => {
  const result = checkExpertReport({
    ...GOOD_REPORT,
    keyResults: ['根因｜第一条表述'],
    keyInfo: ['根因｜第二条完全不同的表述'],
  })
  assert.equal(result.ok, false)
})

/* ============================ 要求 10：部门 JSON 汇总 ============================ */

const GOOD_SUMMARY = {
  keyResults: ['两条固定文案与任务原文可见性已落地'],
  keyInfo: ['改动集中在 plan.ts / runtime.ts / comm-format.ts'],
  importantInfo: ['须用户手工重启 dsh web 才生效'],
  sources: ['专家甲：根因报告', '专家乙：回归用例'],
}

test('部门汇总：合法精简 JSON 通过（覆盖全部专家）', () => {
  assert.deepEqual(checkDepartmentSummary(GOOD_SUMMARY, ['专家甲', '专家乙']), { ok: true, violations: [] })
})

test('部门汇总：未覆盖全部专家、缺对象、多余字段被拒', () => {
  const missing = checkDepartmentSummary(GOOD_SUMMARY, ['专家甲', '专家丙'])
  assert.equal(missing.ok, false)
  assert.match(missing.violations.join('\n'), /专家丙/)
  assert.equal(checkDepartmentSummary(null).code, 'DEPARTMENT_SUMMARY_INVALID')
  assert.equal(checkDepartmentSummary({ ...GOOD_SUMMARY, extra: ['x'] }).ok, false)
})

test('部门汇总：sources 覆盖 8-25 名复杂任务专家（3.0.6 死锁修复随 3.1.0 扩容到 25 人保持有效）', () => {
  const phrases = [
    '根因报告', '回归用例', '性能基线', '接口契约', '数据字典', '部署手册',
    '风险评估', '验收清单', '依赖图谱', '变更日志', '容量测算', '巡检脚本',
    '告警规则', '灰度方案', '回滚预案', '压测结论', '权限矩阵', '链路追踪',
    '缓存策略', '配额校准', '日志规范', '审计要点', '熔断阈值', '镜像扫描',
    '编排模板', '网关策略', '调度窗口', '快照保留', '密钥轮换', '探针配置',
    '成本归因',
  ]
  const sourcesFor = (count: number) =>
    Array.from({ length: count }, (_, i) => `专家${i + 1}：${phrases[i]}已交付`)
  // 12 人（旧上限）逐人覆盖：仍须通过。
  const experts12 = Array.from({ length: 12 }, (_, i) => `专家${i + 1}`)
  assert.deepEqual(
    checkDepartmentSummary({ ...GOOD_SUMMARY, sources: sourcesFor(12) }, experts12),
    { ok: true, violations: [] },
  )
  // [3.1.0] 25 人（新上限）逐人覆盖：必须通过——死锁修复在新上限下不得复发。
  const experts25 = Array.from({ length: 25 }, (_, i) => `专家${i + 1}`)
  assert.deepEqual(
    checkDepartmentSummary({ ...GOOD_SUMMARY, sources: sourcesFor(25) }, experts25),
    { ok: true, violations: [] },
  )
  // 其余三个数组的 6 条精简上限不放松：keyResults 第 7 条仍拒。
  const fatKeyResults = {
    ...GOOD_SUMMARY,
    keyResults: Array.from({ length: 7 }, (_, i) => `互不相同的精简成果条目${phrases[i]}${i}`),
    sources: sourcesFor(12),
  }
  const fat = checkDepartmentSummary(fatKeyResults, experts12)
  assert.equal(fat.ok, false)
  assert.match(fat.violations.join('\n'), /keyResults 最多 6 条/)
  // sources 自身上限 30（随 caps.ts）：第 31 人仍拒（防止无限膨胀）。
  const experts31 = Array.from({ length: 31 }, (_, i) => `专家${i + 1}`)
  const tooMany = checkDepartmentSummary(
    { ...GOOD_SUMMARY, sources: sourcesFor(31) },
    experts31,
  )
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.violations.join('\n'), /sources 最多 30 条/)
})

/* ============================ F10 / F11 门禁接线 ============================ */

const BASE_PAYLOAD = {
  status: 'done',
  acceptance: [{ criterion: 'A1', result: 'pass', evidence: '命令输出' }],
  phases: {
    planning: { problemAnalysis: ['a'], resources: ['r'], tools: ['t'], approach: ['b'], approachBasis: ['c'] },
    preparation: { prepared: ['p'], evidence: ['e'] },
    execution: { steps: ['s'] },
    verification: {
      allPassed: true,
      checks: [{ criterion: 'A1', method: 'm', evidence: 'e' }],
      requirementCheck: 'r',
      retrospective: { problems: ['p'], detours: [], resolutions: ['r'], prevention: ['q'] },
    },
  },
  artifacts: [{ kind: 'note', ref: 'x' }],
}

function wrap(payload: any) {
  return `<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(payload)}\n<!-- WORKPLAN_EVIDENCE:END -->`
}

test('F10：专家结果缺 report 被退回，带 report 通过', () => {
  const leader = checkCommFormatCompliance(BASE_PAYLOAD, wrap(BASE_PAYLOAD), 1, { tier: 'expert' })
  assert.equal(leader.compliant, false)
  assert.ok(leader.violations.some((v) => v.ruleId === 'F10'))
  const ok = checkCommFormatCompliance({ ...BASE_PAYLOAD, report: GOOD_REPORT }, wrap(BASE_PAYLOAD), 1, { tier: 'expert' })
  assert.equal(ok.compliant, true)
})

test('F11：部门结果缺 departmentSummary 被退回，带汇总且覆盖专家后通过', () => {
  const missing = checkCommFormatCompliance(BASE_PAYLOAD, wrap(BASE_PAYLOAD), 1, { tier: 'leader', expectedExperts: ['专家甲'] })
  assert.equal(missing.compliant, false)
  assert.ok(missing.violations.some((v) => v.ruleId === 'F11'))
  const ok = checkCommFormatCompliance(
    { ...BASE_PAYLOAD, departmentSummary: GOOD_SUMMARY },
    wrap(BASE_PAYLOAD), 1, { tier: 'leader', expectedExperts: ['专家甲', '专家乙'] },
  )
  assert.equal(ok.compliant, true)
})

test('未声明层级时 F10/F11 都不查（历史回放零回归）', () => {
  const result = checkCommFormatCompliance(BASE_PAYLOAD, wrap(BASE_PAYLOAD), 1)
  assert.equal(result.compliant, true)
})

test('规范版本升到 3，五步证据与 F10/F11 同版', () => {
  assert.equal(COMM_FORMAT_VERSION, 3)
  assert.deepEqual(
    COMM_FORMAT_SPEC.requirements.map((item: any) => item.id),
    ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11'],
  )
  assert.match(renderCommFormatSpec('expert'), /F10/)
  assert.doesNotMatch(renderCommFormatSpec('expert'), /【F11】/)
  assert.match(renderCommFormatSpec('leader'), /F11/)
  assert.doesNotMatch(renderCommFormatSpec('leader'), /【F10】/)
})

/* ============================ 要求 9：组员角色取消 ============================ */

const CONSOLIDATION = {
  problemAnalysis: ['问题一：需要定位根因，约束是只读取证，未知是复现路径，主要矛盾是证据不足。这句要够四十字。'],
  approach: ['第一步读代码定位，第二步写用例复现，第三步给出修复点与证据链，确保每一步都有可复核输出。这句也要够四十字。'],
  approachBasis: ['因为第一轮确认了证据不足是主要矛盾，所以第二轮先只读取证再动手。'],
  taskReasoningEffort: 'high',
}

const ATOMIC_TASK = '分析 src/plan.ts 得出根因结论'

/* 复杂档（high）触发既有 ≥8 人门禁（2.5.4 基线保留，不因本版放宽）。 */
const EIGHT = Array.from({ length: 8 }, (_, i) => ({
  member: `专家${i + 1}`,
  role: 'expert' as const,
  task: ATOMIC_TASK,
  qualityRequirements: QUALITY,
}))

test('组员角色取消：role=member 在读取时归一为 expert，不再有配比门禁', () => {
  const plan = planDelegations({
    model: 'deepseek-chat',
    consolidation: {
      ...CONSOLIDATION,
      assignments: [{ member: '甲', role: 'member', task: ATOMIC_TASK, qualityRequirements: QUALITY }, ...EIGHT.slice(1)],
    },
  })
  assert.equal(plan.ok, true, plan.ok ? '' : String(plan.error))
  assert.equal(plan.members[0].role, 'expert')
})

test('组员角色取消：缺 expert（role 既非 expert 也非 member）被拒', () => {
  const plan = planDelegations({
    model: 'deepseek-chat',
    consolidation: {
      ...CONSOLIDATION,
      assignments: [{ member: '甲', role: 'worker', task: ATOMIC_TASK, qualityRequirements: QUALITY }, ...EIGHT.slice(1)],
    },
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_ASSIGNMENT_INVALID')
})

test('派发硬门槛：非极简任务被拒（DELEGATE_TASK_NOT_ATOMIC）', () => {
  const plan = planDelegations({
    model: 'deepseek-chat',
    consolidation: {
      ...CONSOLIDATION,
      assignments: [{ member: '甲', role: 'expert', task: '修复登录并且补回归用例', qualityRequirements: QUALITY }, ...EIGHT.slice(1)],
    },
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_TASK_NOT_ATOMIC')
})

test('派发硬门槛：缺质量要求被拒（DELEGATE_QUALITY_REQUIREMENTS_MISSING）', () => {
  const plan = planDelegations({
    model: 'deepseek-chat',
    consolidation: {
      ...CONSOLIDATION,
      assignments: [{ member: '甲', role: 'expert', task: ATOMIC_TASK }, ...EIGHT.slice(1)],
    },
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_QUALITY_REQUIREMENTS_MISSING')
})

test('派发：质量要求随分工表落到成员记录上', () => {
  const plan = planDelegations({
    model: 'deepseek-chat',
    consolidation: {
      ...CONSOLIDATION,
      assignments: [
        { member: '甲', role: 'expert', task: ATOMIC_TASK, qualityRequirements: ['必须给出命令输出'] },
        ...EIGHT.slice(1),
      ],
    },
  })
  assert.equal(plan.ok, true, plan.ok ? '' : String(plan.error))
  assert.deepEqual(plan.members[0].qualityRequirements, ['必须给出命令输出'])
})

/* ============================ 要求 13：版本号 ============================ */

test('要求 13：插件 meta 版本为 3.1.4', () => {
  assert.equal(meta.version, '3.1.4')
})
