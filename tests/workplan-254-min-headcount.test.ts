/*
 * [2.5.4][T4] 复杂任务分派人数下限硬门禁（用户决策 D1/D2）聚焦回归。
 *
 * D1：除 low 外全部算复杂——声明档 medium/high/xhigh/max 均触发「expert+member
 *     合计 ≥8 人」，xhigh 不豁免；复杂判定用「钳制前声明档」
 *     （consolidation.taskReasoningEffort ?? taskEffortFallback），因为
 *     correctEffortForModel 在非 qwen 系会把 medium 钳到 low，按钳制后判会静默豁免。
 * D2：复杂任务合计 <8 直接阻断分派（code=DELEGATE_HEADCOUNT_MIN）；上限放宽到 12
 *     （12 为实现取值）；非复杂保持 6 人上限 + 原有静默截断，旧行为零变化。
 *
 * 拒因顺序（新闸放最后，既有 8 道完全不变）：
 *   CONSOLIDATION_MISSING → problemAnalysis INCOMPLETE → assignments 空 INCOMPLETE
 *   → TASK_EFFORT_INVALID → ASSIGNMENT_INVALID → ROLE_MIX_REQUIRED
 *   → approach/approachBasis INCOMPLETE → DELEGATE_HEADCOUNT_MIN。
 *
 * 持久化边界（负责人补充说明 2）：强制点在 review 入口（宿主把钳制后值写回
 *   consolidation/effortOverride，dispatch 读回钳制后声明，为纵深复核）；
 *   「非 qwen + 声明 medium → 7 人拦」用例即 review 入口语义的直接验证。
 *   qwen 系钳制不改变复杂性分类，review/dispatch 两入口完全一致；二者都消费
 *   planDelegations 这一单一判据，无需为 dispatch 复读另造 runtime 夹具。
 *
 * 夹具口径取自既有 tests/workplan-250-head-delegation.test.ts（consolidation()
 *   形状、QWEN='qwen3-max-preview'）；非 qwen 真实模型样例 gpt-4o 取自
 *   tests/effort-rules.test.ts。每案增量打印，防中途崩溃丢证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildLlmRulesBrief, planDelegations } from '../src/llm-rules.js'

const QWEN = 'qwen3-max-preview'
const NON_QWEN = 'gpt-4o'
const COMPLEX_TIERS = ['medium', 'high', 'xhigh', 'max'] as const

/** 生成 count 条分工；mixed=首条 expert 其余 member（保证 ≥1expert+≥1member）。 */
function assignmentsOf(count: number, role: 'mixed' | 'expert' | 'member' = 'mixed') {
  return Array.from({ length: count }, (_, i) => ({
    member: `成员${i + 1}`,
    role: role === 'mixed' ? (i === 0 ? 'expert' : 'member') : role,
    task: `单一目标子任务 ${i + 1}（单一主产物、可独立验收）`,
  }))
}

function consolidation(overrides: any = {}) {
  return {
    // 夹具须满足 [2.5.4][T3R1] 质量闸：problemAnalysis≥40 字、approach≥40 字、approachBasis≥20 字。
    problemAnalysis: [
      '现状与事实：复杂任务需要拆给多名相关领域全球顶尖专家与本部门组员共同承担，单一负责人无法兼顾质量与进度。',
      '主要矛盾与约束：质量与人数下限的矛盾决定必须扩充分工表，约束决定只改授权文件且保持既有拒因顺序完全不变。',
    ],
    approach: [
      '第二轮方法流程步骤：先按单一目标、单一主产物、可独立验收把任务拆得更简单，再合理分配给专家与组员并逐条验收。',
      '执行与证明：专家承担核心实现并附聚焦单测，组员整理验收证据清单，最后跑构建与测试取证，确保保质保量完美交付。',
    ],
    approachBasis: ['第二轮分工的方法、流程、步骤基于第一轮完成好的全部结果：质量与人数下限的主要矛盾决定扩充分工表，约束决定不改无关文件。'],
    assignments: assignmentsOf(2),
    ...overrides,
  }
}

function planWith(tier: string | undefined, count: number, model: string | null, extra: any = {}) {
  const overrides: any = { assignments: assignmentsOf(count), ...extra }
  if (tier !== undefined) overrides.taskReasoningEffort = tier
  return planDelegations({ consolidation: consolidation(overrides), model })
}

test('A1：model=null，四个复杂档各 7 人 → DELEGATE_HEADCOUNT_MIN（D1 全档触发）', () => {
  for (const tier of COMPLEX_TIERS) {
    const plan = planWith(tier, 7, null)
    console.log(`[254-min-headcount] A1 ${tier} 7人 → ok=${plan.ok} code=${plan.code}`)
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
    assert.ok(plan.error!.includes('7'), 'error 须含当前人数 7')
    assert.ok(plan.error!.includes('8'), 'error 须含下限 8')
    assert.ok(plan.error!.includes(tier), 'error 须含声明档')
    assert.ok(plan.error!.includes('D1/D2'), 'error 须注明用户决策 D1/D2')
  }
})

test('A2：复杂 8 人 → ok 且 members=8；9 人 → ok 且 members=9', () => {
  const eight = planWith('xhigh', 8, null)
  console.log(`[254-min-headcount] A2 8人 → ok=${eight.ok} members=${eight.members.length}`)
  assert.equal(eight.ok, true)
  assert.equal(eight.members.length, 8)
  const nine = planWith('max', 9, null)
  console.log(`[254-min-headcount] A2 9人 → ok=${nine.ok} members=${nine.members.length}`)
  assert.equal(nine.ok, true)
  assert.equal(nine.members.length, 9)
})

test('A3：low 2 人过；low 7 人截断为 6 过（旧行为）；未配置整体档 2 人过', () => {
  const low2 = planWith('low', 2, null)
  console.log(`[254-min-headcount] A3 low 2人 → ok=${low2.ok} members=${low2.members.length}`)
  assert.equal(low2.ok, true)
  assert.equal(low2.members.length, 2)
  const low7 = planWith('low', 7, null)
  console.log(`[254-min-headcount] A3 low 7人 → ok=${low7.ok} members=${low7.members.length}（截断 6）`)
  assert.equal(low7.ok, true)
  assert.equal(low7.members.length, 6)
  const none = planWith(undefined, 2, null)
  console.log(`[254-min-headcount] A3 未配置 2人 → ok=${none.ok} members=${none.members.length}`)
  assert.equal(none.ok, true)
  assert.equal(none.members.length, 2)
})

test('A4：复杂枚举恰为 {medium,high,xhigh,max}——四档 7 人均拦、low 7 人不拦', () => {
  for (const tier of COMPLEX_TIERS) {
    assert.equal(planWith(tier, 7, null).code, 'DELEGATE_HEADCOUNT_MIN')
  }
  const low7 = planWith('low', 7, null)
  console.log(`[254-min-headcount] A4 low 7人 → ok=${low7.ok}（不拦，截断 6）`)
  assert.equal(low7.ok, true)
  assert.equal(low7.members.length, 6)
  // 非法档不属于复杂集，仍按原位置报 TASK_EFFORT_INVALID（先于人数闸）。
  const invalid = planWith('ultra', 7, null)
  console.log(`[254-min-headcount] A4 ultra 7人 → code=${invalid.code}（非法档原拒因）`)
  assert.equal(invalid.code, 'DELEGATE_TASK_EFFORT_INVALID')
})

test('边界：taskEffortFallback=max 且 consolidation 无该字段 → 7 人拦（effortOverride 回落链）', () => {
  const plan = planDelegations({
    consolidation: consolidation({ assignments: assignmentsOf(7) }),
    model: null,
    taskEffortFallback: 'max',
  })
  console.log(`[254-min-headcount] 边界 fallback=max 7人 → code=${plan.code}`)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('边界：非 qwen 模型 + 声明 medium → 仍复杂 7 人拦（D1 不豁免；review 入口语义）', () => {
  // dispatch 复读边界：宿主写回钳制后值，非 qwen+medium 复读会看到 low，但分工表
  // 已是 review 放行的 ≥8 人名单，强制语义不破；本用例直接验证 review 入口按原始声明判复杂。
  const plan = planWith('medium', 7, NON_QWEN)
  console.log(`[254-min-headcount] 边界 ${NON_QWEN}+medium 7人 → code=${plan.code}`)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('边界：qwen 模型 + 声明 high → 复杂 7 人拦（实际档位被钳但判定用声明档）', () => {
  const plan = planWith('high', 7, QWEN)
  console.log(`[254-min-headcount] 边界 ${QWEN}+high 7人 → code=${plan.code}`)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('边界：复杂 12 人过；13 人截断 12 过；非复杂 8 人截断 6 过', () => {
  const twelve = planWith('max', 12, null)
  console.log(`[254-min-headcount] 边界 复杂12人 → ok=${twelve.ok} members=${twelve.members.length}`)
  assert.equal(twelve.ok, true)
  assert.equal(twelve.members.length, 12)
  const thirteen = planWith('max', 13, null)
  console.log(`[254-min-headcount] 边界 复杂13人 → ok=${thirteen.ok} members=${thirteen.members.length}（截断 12）`)
  assert.equal(thirteen.ok, true)
  assert.equal(thirteen.members.length, 12)
  const nonComplex8 = planWith('low', 8, null)
  console.log(`[254-min-headcount] 边界 非复杂8人 → ok=${nonComplex8.ok} members=${nonComplex8.members.length}（截断 6）`)
  assert.equal(nonComplex8.ok, true)
  assert.equal(nonComplex8.members.length, 6)
})

test('边界：复杂 8 人全 expert → ROLE_MIX_REQUIRED（先于人数门禁）', () => {
  const plan = planDelegations({
    consolidation: consolidation({ taskReasoningEffort: 'max', assignments: assignmentsOf(8, 'expert') }),
    model: null,
  })
  console.log(`[254-min-headcount] 边界 复杂8人全expert → code=${plan.code}`)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_ROLE_MIX_REQUIRED')
})

test('拒因顺序回归：复杂 7 人但缺梳理产物时，旧拒因先于人数闸', () => {
  const noConsolidation = planDelegations({ consolidation: null, model: null })
  assert.equal(noConsolidation.code, 'DELEGATE_CONSOLIDATION_MISSING')
  const noAnalysis = planDelegations({
    consolidation: { taskReasoningEffort: 'max', assignments: assignmentsOf(7) },
    model: null,
  })
  assert.equal(noAnalysis.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  const noApproach = planDelegations({
    consolidation: consolidation({ taskReasoningEffort: 'max', assignments: assignmentsOf(7), approach: [] }),
    model: null,
  })
  console.log(`[254-min-headcount] 顺序 缺approach → code=${noApproach.code}（先于人数闸）`)
  assert.equal(noApproach.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.ok(noApproach.error!.includes('approach'))
  const noBasis = planDelegations({
    consolidation: consolidation({ taskReasoningEffort: 'max', assignments: assignmentsOf(7), approachBasis: [] }),
    model: null,
  })
  assert.equal(noBasis.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.ok(noBasis.error!.includes('approachBasis'))
})

test('提示词同步：负责人任务书人数口径改为非复杂≤6 / 复杂≥8 且 ≤12（D1/D2）', () => {
  const brief = buildLlmRulesBrief({ tier: 'department', model: QWEN })
  console.log('[254-min-headcount] 提示词同步断言')
  assert.ok(brief.includes('非复杂任务（low/未配置）最多 6 人'))
  assert.ok(brief.includes('复杂任务（medium/high/xhigh/max）合计不少于 8 人且最多 12 人，少于 8 人硬性阻断'))
  assert.ok(!brief.includes('各至少 1 名，最多 6 人'), '旧「最多 6 人」表述须已移除')
})
