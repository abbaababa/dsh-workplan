/*
 * [2.5.4][T4] 复杂任务分派人数下限硬门禁（用户决策 D1/D2）聚焦回归。
 *
 * D1：除 low 外全部算复杂——声明档 medium/high/xhigh/max 均触发「expert+member
 *     合计 ≥8 人」，xhigh 不豁免；复杂判定用「钳制前声明档」
 *     （consolidation.taskReasoningEffort ?? taskEffortFallback），因为
 *     correctEffortForModel 在非 qwen 系会把 medium 钳到 low，按钳制后判会静默豁免。
 * D2：复杂任务合计 <8 直接阻断分派（code=DELEGATE_HEADCOUNT_MIN）；上限 3.1.0 起
 *     由 12 放宽到 25（用户裁决，单一真源 src/caps.ts），超限拒收 DELEGATE_HEADCOUNT_MAX
 *     （不再静默截断）；low/未配置禁派（非复杂 6 人上限仅在历史/非法档路径保留）。
 * [2.5.5][T3] 夹具适配（负责人裁决，门禁实现与夹具适配同批交付）：D1–D3 low/未配置
 *     禁派后，A3/A4/边界的 low 子案改断言 DELEGATE_LOW_TASK_FORBIDDEN＋direct 指路；
 *     提示词同步改 W1 新串。复杂档各案断言意图零删改。
 * [3.0.8] 单框架收口：consolidation 的 40/40/20 字数梳理闸已废除（第 1/2/3 步证据
 *     改由 review 的 startPhases 开工闸承载，与本文件人数闸无关），consolidation
 *     夹具瘦身为 { taskReasoningEffort?, assignments }；拒因顺序回归用例按新顺序重写。
 *
 * 拒因顺序（planDelegations 实际顺序，3.0.8 口径）：
 *   CONSOLIDATION_MISSING → LOW_TASK_FORBIDDEN（low/未配置禁派，2.5.5 新增）
 *   → CONSOLIDATION_INCOMPLETE（assignments 空）→ TASK_EFFORT_INVALID
 *   → ASSIGNMENT_INVALID → DELEGATE_EXPERTS_REQUIRED → DELEGATE_HEADCOUNT_MIN
 *   → TASK_NOT_ATOMIC / QUALITY_REQUIREMENTS_MISSING（3.0.0 极简/质量闸）。
 * （3.0.8 起 review 入口最前还有 startPhases 开工证据闸 START_EVIDENCE_MISSING/
 *   START_EVIDENCE_INCOMPLETE，在 runtime 层；本文件只测 planDelegations 分工表闸。）
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
import { MAX_COMPLEX_DELEGATE_MEMBERS, MIN_COMPLEX_DELEGATE_MEMBERS } from '../src/caps.js'
import { START_EVIDENCE_MIN_CHARS_BRIEF } from '../src/five-step.js'

const QWEN = 'qwen3-max-preview'
const NON_QWEN = 'gpt-4o'
const COMPLEX_TIERS = ['medium', 'high', 'xhigh', 'max'] as const

/** 生成 count 条分工；mixed=首条 expert 其余 member（保证 ≥1expert+≥1member）。 */
function assignmentsOf(count: number, role: 'mixed' | 'expert' | 'member' = 'mixed') {
  return Array.from({ length: count }, (_, i) => ({
    member: `成员${i + 1}`,
    role: role === 'mixed' ? (i === 0 ? 'expert' : 'member') : role,
    task: `单一目标子任务 ${i + 1}（单一主产物、可独立验收）`,
    // [3.0.0][用户要求 3/6] 质量要求必填（2.5.4 夹具补字段，判定意图零删改）
    qualityRequirements: ['必须给出可复核的命令输出或文件证据'],
  }))
}

function consolidation(overrides: any = {}) {
  // [3.0.8] 瘦身：分工表闸不再读取梳理字段（problemAnalysis/approach/approachBasis
  // 已随两轮思考 deepThink 门禁废除，改由 review 的 startPhases 开工闸承载）。
  return {
    assignments: assignmentsOf(2),
    ...overrides,
  }
}

function planWith(tier: string | undefined, count: number, model: string | null, extra: any = {}) {
  const overrides: any = { assignments: assignmentsOf(count), ...extra }
  if (tier !== undefined) overrides.taskReasoningEffort = tier
  return planDelegations({ consolidation: consolidation(overrides), model, minHeadcount: 3 })
}

test('A1：model=null，四个复杂档各 2 人 → DELEGATE_HEADCOUNT_MIN（D1 全档触发；配置下限 3）', () => {
  for (const tier of COMPLEX_TIERS) {
    const plan = planWith(tier, 2, null)
    console.log(`[254-min-headcount] A1 ${tier} 2人 → ok=${plan.ok} code=${plan.code}`)
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
    assert.ok(plan.error!.includes('2'), 'error 须含当前人数 2')
    assert.ok(plan.error!.includes('3'), 'error 须含下限 3')
    assert.ok(plan.error!.includes(tier), 'error 须含声明档')
    assert.ok(plan.error!.includes('D1/D2'), 'error 须注明用户决策 D1/D2')
  }
})

test('A2：复杂 3 人（恰为下限）→ ok 且 members=3；8 人 → ok 且 members=8', () => {
  const three = planWith('xhigh', 3, null)
  console.log(`[254-min-headcount] A2 3人 → ok=${three.ok} members=${three.members.length}`)
  assert.equal(three.ok, true)
  assert.equal(three.members.length, 3)
  const eight = planWith('max', 8, null)
  console.log(`[254-min-headcount] A2 8人 → ok=${eight.ok} members=${eight.members.length}`)
  assert.equal(eight.ok, true)
  assert.equal(eight.members.length, 8)
})

// [2.5.5][T3] D1–D3 夹具适配（原则②）：本子案意图本就是 low/未配置下派行为——
// 旧「放行/截断」断言改为新拒因 DELEGATE_LOW_TASK_FORBIDDEN＋direct 指路（裁决要求的新行为）。
test('A3：low 2 人 / low 7 人 / 未配置 2 人均 ⇒ DELEGATE_LOW_TASK_FORBIDDEN（D1–D3 禁派，旧放行行为废止）', () => {
  const low2 = planWith('low', 2, null)
  console.log(`[254-min-headcount] A3 low 2人 → ok=${low2.ok} code=${low2.code}`)
  assert.equal(low2.ok, false)
  assert.equal(low2.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  assert.match(low2.error!, /direct/, '拒因须指路 direct 登记')
  const low7 = planWith('low', 7, null)
  console.log(`[254-min-headcount] A3 low 7人 → ok=${low7.ok} code=${low7.code}（禁派先于截断）`)
  assert.equal(low7.ok, false)
  assert.equal(low7.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  const none = planWith(undefined, 2, null)
  console.log(`[254-min-headcount] A3 未配置 2人 → ok=${none.ok} code=${none.code}（视同 low）`)
  assert.equal(none.ok, false)
  assert.equal(none.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
})

test('A4：复杂枚举恰为 {medium,high,xhigh,max}——四档 2 人均拦、low 7 人禁派拦', () => {
  for (const tier of COMPLEX_TIERS) {
    assert.equal(planWith(tier, 2, null).code, 'DELEGATE_HEADCOUNT_MIN')
  }
  // [2.5.5][T3] D1–D3 适配（原则②）：low 7 人旧「不拦截断 6」改为禁派硬拒。
  const low7 = planWith('low', 7, null)
  console.log(`[254-min-headcount] A4 low 7人 → ok=${low7.ok} code=${low7.code}（禁派）`)
  assert.equal(low7.ok, false)
  assert.equal(low7.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  // 非法档不属于复杂集，仍按原位置报 TASK_EFFORT_INVALID（先于人数闸）。
  const invalid = planWith('ultra', 7, null)
  console.log(`[254-min-headcount] A4 ultra 7人 → code=${invalid.code}（非法档原拒因）`)
  assert.equal(invalid.code, 'DELEGATE_TASK_EFFORT_INVALID')
})

test('边界：taskEffortFallback=max 且 consolidation 无该字段 → 2 人拦（effortOverride 回落链）', () => {
  const plan = planDelegations({
    consolidation: consolidation({ assignments: assignmentsOf(2) }),
    model: null,
    taskEffortFallback: 'max',
    minHeadcount: 3,
  })
  console.log(`[254-min-headcount] 边界 fallback=max 2人 → code=${plan.code}`)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('边界：非 qwen 模型 + 声明 medium → 仍复杂 2 人拦（D1 不豁免；review 入口语义）', () => {
  // dispatch 复读边界：宿主写回钳制后值，非 qwen+medium 复读会看到 low，但分工表
  // 已是 review 放行的人数名单，强制语义不破；本用例直接验证 review 入口按原始声明判复杂。
  const plan = planWith('medium', 2, NON_QWEN)
  console.log(`[254-min-headcount] 边界 ${NON_QWEN}+medium 2人 → code=${plan.code}`)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('边界：qwen 模型 + 声明 high → 复杂 2 人拦（实际档位被钳但判定用声明档）', () => {
  const plan = planWith('high', 2, QWEN)
  console.log(`[254-min-headcount] 边界 ${QWEN}+high 2人 → code=${plan.code}`)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('边界：复杂 25 人过；26 人拒收 DELEGATE_HEADCOUNT_MAX（3.1.0 不再静默截断）；非复杂（low）8 人禁派拦', () => {
  const twentyFive = planWith('max', 25, null)
  console.log(`[254-min-headcount] 边界 复杂25人 → ok=${twentyFive.ok} members=${twentyFive.members.length}`)
  assert.equal(twentyFive.ok, true)
  assert.equal(twentyFive.members.length, 25)
  const twentySix = planWith('max', 26, null)
  console.log(`[254-min-headcount] 边界 复杂26人 → ok=${twentySix.ok} code=${twentySix.code}（拒收，不再截断）`)
  assert.equal(twentySix.ok, false)
  assert.equal(twentySix.code, 'DELEGATE_HEADCOUNT_MAX')
  assert.ok(twentySix.error!.includes('26'), '拒因须含当前人数 26')
  assert.ok(twentySix.error!.includes('25'), '拒因须含上限 25')
  assert.ok(twentySix.error!.includes('拆'), '拒因须给出拆两轮出路')
  // [2.5.5][T3] D1–D3 适配（原则②）：low 8 人旧「截断 6 过」改为禁派硬拒。
  const nonComplex8 = planWith('low', 8, null)
  console.log(`[254-min-headcount] 边界 low 8人 → ok=${nonComplex8.ok} code=${nonComplex8.code}（禁派）`)
  assert.equal(nonComplex8.ok, false)
  assert.equal(nonComplex8.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
})

test('边界：复杂 8 人全 expert → 放行（组员角色已取消，配比闸不复存在）', () => {
  const plan = planDelegations({
    consolidation: consolidation({ taskReasoningEffort: 'max', assignments: assignmentsOf(8, 'expert') }),
    model: null,
  })
  console.log(`[254-min-headcount] 边界 复杂8人全expert → ok=${plan.ok} code=${plan.code}`)
  assert.equal(plan.ok, true)
  assert.equal(plan.members.length, 8)
})

test('拒因顺序回归：人数闸前的既有闸仍先拒（3.0.8 新顺序：缺表→禁派→空分工表→非法档→分工不完整）', () => {
  // [3.0.8] 原「problemAnalysis/approach/approachBasis 字数闸」已废除：consolidation
  // 不再携带梳理字段，下面各案按 planDelegations 实际拒因顺序断言。
  const noConsolidation = planDelegations({ consolidation: null, model: null })
  assert.equal(noConsolidation.code, 'DELEGATE_CONSOLIDATION_MISSING')
  // low 禁派闸先于 assignments 空检查（2.5.5 起）。
  const lowSeven = planDelegations({ consolidation: consolidation({ taskReasoningEffort: 'low', assignments: assignmentsOf(7) }), model: null })
  assert.equal(lowSeven.code, 'DELEGATE_LOW_TASK_FORBIDDEN')
  // assignments 空先于人数闸。
  const emptyAssignments = planDelegations({
    consolidation: consolidation({ taskReasoningEffort: 'max', assignments: [] }),
    model: null,
  })
  assert.equal(emptyAssignments.code, 'DELEGATE_CONSOLIDATION_INCOMPLETE')
  assert.ok(emptyAssignments.error!.includes('assignments'))
  // 非法档先于人数闸。
  const invalid = planDelegations({
    consolidation: consolidation({ taskReasoningEffort: 'ultra', assignments: assignmentsOf(7) }),
    model: null,
  })
  assert.equal(invalid.code, 'DELEGATE_TASK_EFFORT_INVALID')
  // 分工表 member/role/task 不完整先于人数闸。
  const brokenAssignment = planDelegations({
    consolidation: consolidation({
      taskReasoningEffort: 'max',
      assignments: [{ member: '成员1', role: 'expert', task: '', qualityRequirements: ['必须给出可复核的命令输出或文件证据'] }, ...assignmentsOf(6).slice(1)],
    }),
    model: null,
  })
  console.log(`[254-min-headcount] 顺序 分工不完整 → code=${brokenAssignment.code}（先于人数闸）`)
  assert.equal(brokenAssignment.code, 'DELEGATE_ASSIGNMENT_INVALID')
  // 不带梳理字段不再拒（字数闸已废除）：复杂 2 人（低于 3.2.6 下限 3）⇒ 落到人数闸。
  const bare = planDelegations({
    consolidation: { taskReasoningEffort: 'max', assignments: assignmentsOf(2) },
    model: null,
    minHeadcount: 3,
  })
  console.log(`[254-min-headcount] 顺序 无梳理字段 2人 → code=${bare.code}（字数闸已废除，落到人数闸）`)
  assert.equal(bare.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('提示词同步：负责人任务书人数口径为 low 禁派＋direct 直执 / 复杂≥8 且 ≤25，超限拒收不静默截断（D1/D2＋T3 W1＋3.1.0）', () => {
  const brief = buildLlmRulesBrief({ tier: 'department', model: QWEN })
  console.log('[254-min-headcount] 提示词同步断言')
  // [2.5.5][T3] W1 文案同步（原则③）：与 src/llm-rules.ts 负责人告知块逐字一致；
  // [3.0.8] 「两轮思考产物」表述改为「第 1/2/3 步证据」（单框架收口）；
  // [3.1.0] 上限 12→25 且与 caps.ts 常量同源（环境变量覆盖时提示词不漂移）。
  assert.ok(brief.includes('low/未配置任务禁止下派——负责人亲自执行，第 1/2/3 步证据经 dsh_workplan_delegate(action="direct") 登记（' + START_EVIDENCE_MIN_CHARS_BRIEF + '；可选 reasoningEffort="low"）'))
  assert.ok(brief.includes(`复杂任务（medium/high/xhigh/max）合计不少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人且最多 ${MAX_COMPLEX_DELEGATE_MEMBERS} 人，少于 ${MIN_COMPLEX_DELEGATE_MEMBERS} 人硬性阻断（**单阶段计划与顺序推理链一样豁免此下限**，别为了凑人数去拆无意义的独立专家），超过上限平台拒收（可精简名单或拆两轮派发，绝不静默丢人无痕）`))
  assert.ok(!brief.includes('最多 12 人'), '旧「最多 12 人」口径必须移除')
  assert.ok(brief.includes('startPhases={ planning{ problemAnalysis[], approach[], approachBasis[], resources[], tools[] }, preparation{ prepared[], evidence[] } }'), '3.0.8 负责人告知块必须带 startPhases 开工证据口径')
  assert.ok(!brief.includes('两轮思考产物'), '旧「两轮思考产物」表述须已移除')
  assert.ok(!brief.includes('非复杂任务（low/未配置）最多 6 人'), '旧「非复杂≤6 人」表述须已移除')
  assert.ok(!brief.includes('各至少 1 名，最多 6 人'), '旧「最多 6 人」表述须已移除')
})
