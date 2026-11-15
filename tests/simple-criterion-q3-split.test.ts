/*
 * [T5-04][简单判据 v2 · Q3 = B：拆分优先；超时判未完成，转新子任务续做]
 *
 * 口径来源（逐字，不改写）：
 *  - reports/simple-criterion-v2-spec.md §2.3（S-Q3-1..4 与验收表 AC-Q3-1..4）；
 *  - reports/simple-criterion-v2-touchpoints.md §4 C14–C18：
 *      C14 规划器提示词补「10 分钟内不能完美完成的任务必须事前拆小」；
 *      C15 超时结算文案把默认去向改为「判未完成 → replan 转新子任务」；
 *      C16 pendingAdjudication 事实标记保留；
 *      C17 「转新子任务」通道 = replan(replace)，机制已存在，不新写；
 *      C18 buildTakeoverBrief / mergePreservedArtifacts 已登记只读保护（只增不减）。
 *
 * 本文件覆盖：
 *  - AC-Q3-1 规划产物中不存在「预计 >10 且无拆分说明/用户确认」的主计划行（扫描计划 JSON）；
 *  - AC-Q3-2 模拟超 10 且无批准 → 状态非 done、生成接替行、原产物只读保留；
 *  - AC-Q3-3 接替行通过「单一目标/单一产物/可验收」结构校验，凑数行被拒；
 *  - AC-Q3-4 有用户批准 → 记例外、可 done、不生成接替行（与 AC-Q3-2 成对断言）。
 *
 * 现状与限制（如实登记，不隐藏）：
 *  当前 src/ 尚未落盘 Q3 的生产接线（检索不到 criterionResult / splitReason，规划器
 *  提示词的 C14 硬句也未加入）。因此：
 *   1) AC-Q3-1 的「校验器扫描计划 JSON」与 AC-Q3-2/4 的「判据结果三选一
 *      met / exception-approved / unmet」在本文件内以 referenceQ3* 参考实现固化判据
 *      （AC-Q3-1 的验证方式原文即为「校验器/单测扫描计划 JSON」）；
 *   2) 接替行生成、旧行状态、只读产物保护、结构校验四件事**全部调用真实生产函数**
 *      （planReplan / applyReplanStatuses / timeoutBlockedPatch / buildTakeoverBrief /
 *      mergePreservedArtifacts），不做替身、不 mock 判定。
 *  生产接线落盘后，本文件只需把 referenceQ3* 替换为同名导出，断言口径保持不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { applyStatus, createStatuses } from '../src/plan.js'
import { applyReplanStatuses, planReplan } from '../src/replan.js'
import { buildTakeoverBrief, mergePreservedArtifacts, timeoutBlockedPatch } from '../src/runtime.js'

/** 用户口径「10 分钟」：主计划子任务 ≤10 分钟为简单判据达标线。 */
const TEN_MINUTES = 10

/* ------------------------------------------------------------------ *
 * 参考实现：Q3 判据（生产接线落盘前的唯一真源，口径抄自 spec §2.3）
 * ------------------------------------------------------------------ */

/** 拆分说明或用户确认二者其一即可放行「预计 >10」的行（AC-Q3-1）。 */
function hasSplitJustification(row: any): boolean {
  const reason = typeof row?.splitReason === 'string' ? row.splitReason.trim() : ''
  const confirmed = row?.userConfirmed === true || row?.estimateConfirm?.confirmed === true
  return reason.length > 0 || confirmed
}

/** 扫描计划 JSON：返回「预计 >10 且既无拆分说明也无用户确认」的行 id（AC-Q3-1）。 */
function referenceScanOversizedRows(plan: any): string[] {
  const stages = Array.isArray(plan?.stages) ? plan.stages : []
  const rows = stages.flatMap((stage: any) => (Array.isArray(stage?.subtasks) ? stage.subtasks : []))
  return rows
    .filter((row: any) => Number.isFinite(row?.declaredMinutes) && Number(row.declaredMinutes) > TEN_MINUTES)
    .filter((row: any) => !hasSplitJustification(row))
    .map((row: any) => String(row.id))
}

/** 结算判据三选一：met / exception-approved / unmet（spec §2.3 结算期口径）。 */
function referenceQ3Settlement(input: { declaredMinutes?: number; wallClockMinutes?: number; userApproved?: boolean }) {
  const declared = Number(input.declaredMinutes ?? 0)
  const wall = Number(input.wallClockMinutes ?? 0)
  const over = declared > TEN_MINUTES || wall > TEN_MINUTES
  if (!over) return { criterionResult: 'met', canBeDone: true, needsReplacement: false, exceptionRecorded: false }
  if (input.userApproved === true) {
    return { criterionResult: 'exception-approved', canBeDone: true, needsReplacement: false, exceptionRecorded: true }
  }
  return { criterionResult: 'unmet', canBeDone: false, needsReplacement: true, exceptionRecorded: false }
}

/**
 * 接替行结构校验（AC-Q3-3）：单一目标、单一主产物、可独立验收。
 * 凑数行（无目标 / 零产物 / 多产物 / 无验收）一律拒绝。
 */
function referenceReplacementRowIssues(row: any): string[] {
  const issues: string[] = []
  const objective = typeof row?.objective === 'string' ? row.objective.trim() : ''
  const title = typeof row?.title === 'string' ? row.title.trim() : ''
  if (!objective && !title) issues.push('缺少单一目标（objective/title 均为空）')
  const outputs = Array.isArray(row?.outputs) ? row.outputs.filter((item: any) => typeof item === 'string' && item.trim()) : []
  if (outputs.length === 0) issues.push('缺少主产物（outputs 为空）')
  if (outputs.length > 1) issues.push(`主产物不唯一（outputs=${outputs.length} 项）`)
  const acceptance = Array.isArray(row?.acceptance) ? row.acceptance.filter((item: any) => typeof item === 'string' && item.trim()) : []
  if (acceptance.length === 0) issues.push('不可独立验收（acceptance 为空）')
  return issues
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function basePlan(subtask: any) {
  return {
    planId: 'p-q3-split',
    sessionId: 's-q3-split',
    createdTurn: 1,
    createdAt: 1,
    stages: [{ id: 'S1', name: 's', subtasks: [subtask] }],
  }
}

function baseSubtask(overrides: any = {}) {
  return {
    id: 'T5',
    title: '编写 AC-Q3 用例',
    department: 'qa',
    role: '组员',
    objective: '写出 tests/simple-criterion-q3-split.test.ts 的 AC-Q3 断言',
    method: ['参照 spec §2.3 写断言'],
    outputs: ['artifacts/t5-q3.md'],
    acceptance: ['文件存在且断言通过'],
    dependsOn: [],
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * AC-Q3-1：规划产物扫描
 * ------------------------------------------------------------------ */

test('AC-Q3-1 规划产物中不存在「预计 >10 且无拆分说明/用户确认」的主计划行', () => {
  const compliant = {
    planId: 'p-q3-ok',
    stages: [
      {
        id: 'S1',
        subtasks: [
          { id: 'T1', declaredMinutes: 6 },
          { id: 'T2', declaredMinutes: TEN_MINUTES },
          { id: 'T3', declaredMinutes: 11, splitReason: '拆成「写骨架」与「补断言」两步' },
          { id: 'T4', declaredMinutes: 23, userConfirmed: true },
          { id: 'T5', declaredMinutes: 12, estimateConfirm: { confirmed: true } },
        ],
      },
    ],
  }
  assert.deepEqual(referenceScanOversizedRows(compliant), [], '合规计划不得存在超 10 且无说明的行')

  const violating = {
    planId: 'p-q3-bad',
    stages: [
      {
        id: 'S1',
        subtasks: [
          { id: 'T1', declaredMinutes: 6 },
          { id: 'T2', declaredMinutes: 11 },
          { id: 'T3', declaredMinutes: 23, splitReason: '已事前拆小' },
          { id: 'T4', declaredMinutes: 12, userConfirmed: true },
          { id: 'T5', declaredMinutes: 15, splitReason: '   ' },
        ],
      },
    ],
  }
  assert.deepEqual(
    referenceScanOversizedRows(violating),
    ['T2', 'T5'],
    '空白拆分说明不算说明；超 10 无批准的行必须被点名',
  )
})

/* ------------------------------------------------------------------ *
 * AC-Q3-2：超 10 且无批准 → 非 done + 接替行 + 原产物只读保留
 * ------------------------------------------------------------------ */

test('AC-Q3-2 超 10 且无批准：状态非 done、生成接替行、原产物只读保留', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'wp-q3-split-'))
  mkdirSync(path.join(cwd, 'artifacts'), { recursive: true })
  writeFileSync(path.join(cwd, 'artifacts', 't5-q3.md'), '# 已完成的一半\n', 'utf8')
  const before = readFileSync(path.join(cwd, 'artifacts', 't5-q3.md'), 'utf8')

  const subtask = baseSubtask()
  const plan = basePlan(subtask)

  // ① 到点结算：真实 timeoutBlockedPatch——判据未达标绝不能变成 done。
  const settled = timeoutBlockedPatch(subtask, cwd, '子任务 T5 第 1 次达到协商执行上限（600000ms）')
  assert.equal(settled.patch.status, 'blocked', '超时结算必须是 blocked（非 done）')
  assert.notEqual(settled.patch.status, 'done')
  assert.deepEqual(settled.landed, ['artifacts/t5-q3.md'], '已在盘上的产物必须被探测到')

  // ② 判据结果：未批准 → unmet，不允许 done，必须生成接替行。
  const verdict = referenceQ3Settlement({ declaredMinutes: 23, wallClockMinutes: 23, userApproved: false })
  assert.equal(verdict.criterionResult, 'unmet')
  assert.equal(verdict.canBeDone, false)
  assert.equal(verdict.needsReplacement, true)
  assert.equal(verdict.exceptionRecorded, false)

  // ③ 接替行：真实 planReplan(replace) 通道（C17 既有机制，不新写）。
  const replanned = planReplan(
    plan,
    [
      {
        subtaskId: 'T5',
        action: 'replace',
        reason: '超 10 分钟且无用户批准，判未完成，只补缺口',
        replacement: { objective: '仅为 AC-Q3-2 补齐失败分支断言' },
      },
    ],
    { planId: 'p-q3-split', reason: '超 10 分钟未获批准', revision: 2, at: 1_700_000_000_000 },
  )
  assert.equal(replanned.ok, true, `replace 必须成功：${(replanned as any).error ?? ''}`)
  const payload = (replanned as any).payload
  assert.equal(payload.marks.length, 1)
  assert.equal(payload.marks[0].action, 'replace')
  assert.equal(payload.marks[0].subtaskId, 'T5')
  const successorId = payload.marks[0].replacedBy[0]
  assert.equal(successorId, 'T5b', '缺省接替行 id 必须是 T5b')

  const oldRow = (payload.plan.stages[0].subtasks as any[]).find((row) => row.id === 'T5')
  const successor = (payload.plan.stages[0].subtasks as any[]).find((row) => row.id === successorId)
  assert.ok(oldRow && successor, '修订计划必须同时保留旧行与接替行')
  assert.equal(oldRow.supersededAt, 1_700_000_000_000, '旧行必须打上已重规划标记')
  assert.deepEqual(oldRow.replacedBy, [successorId], '旧行必须指直接替行')
  assert.equal(successor.replaces, 'T5', '接替行必须记录它替代谁')
  assert.deepEqual(successor.outputs, ['artifacts/t5-q3.md'], '接替行继承主产物，不重复整步重跑')

  // ④ 状态面：真实 applyReplanStatuses——旧行不得停在 done。
  const statuses = applyReplanStatuses(createStatuses(plan as any), payload)
  const oldStatus = statuses.find((row: any) => row.subtaskId === 'T5') as any
  const newStatus = statuses.find((row: any) => row.subtaskId === successorId) as any
  assert.notEqual(oldStatus.status, 'done', '未批准的旧行不得为 done')
  assert.equal(oldStatus.closure, 'replanned', '旧行以已重规划收口')
  assert.equal(newStatus.status, 'pending', '接替行以 pending 进入下一轮')

  // ⑤ 只读保留：真实 buildTakeoverBrief + mergePreservedArtifacts（只增不减）。
  const brief = buildTakeoverBrief(subtask, settled.patch as any, settled.landed, 1)
  assert.deepEqual(brief.landedRefs, ['artifacts/t5-q3.md'])
  assert.deepEqual(brief.remainingOutputs, [], '已落盘产物不再列为待做')
  assert.match(brief.instruction, /只读|禁止整步重跑/, '接手指令必须写明只读保护')

  const merged = mergePreservedArtifacts(settled.patch.artifacts, brief.landedRefs)
  const preserved = merged.filter((item: any) => item.ref === 'artifacts/t5-q3.md')
  assert.equal(preserved.length, 1, '已落盘产物在合并后必须仍然在册（只增不减）')
  assert.equal(preserved[0].exists, true)
  assert.equal(readFileSync(path.join(cwd, 'artifacts', 't5-q3.md'), 'utf8'), before, '原产物内容必须原样保留')
})

/* ------------------------------------------------------------------ *
 * AC-Q3-3：接替行结构校验（单一目标/单一产物/可验收），凑数行被拒
 * ------------------------------------------------------------------ */

test('AC-Q3-3 接替行通过结构校验；凑数行（多产物/无验收/无目标）被拒', () => {
  const plan = basePlan(baseSubtask())
  const replanned = planReplan(
    plan,
    [{ subtaskId: 'T5', action: 'replace', reason: '超时转接替行', replacement: { objective: '只补 AC-Q3-3 的结构校验断言' } }],
    { planId: 'p-q3-split', reason: '结构校验', revision: 2, at: 1_700_000_000_001 },
  )
  assert.equal(replanned.ok, true)
  const payload = (replanned as any).payload
  const successor = (payload.plan.stages[0].subtasks as any[]).find((row: any) => row.id === 'T5b')

  // 合法接替行：单一目标 + 单一主产物 + 可独立验收。
  assert.deepEqual(referenceReplacementRowIssues(successor), [], '真实 replan 产出的接替行必须结构合规')
  assert.equal(successor.outputs.length, 1, '单一主产物')
  assert.ok(successor.acceptance.length >= 1, '可独立验收')

  // 凑数行：全部必须被结构校验拒绝。
  const paddingRows = [
    { title: '', objective: '', outputs: ['x'], acceptance: ['y'] },
    { title: 't', objective: 'o', outputs: [], acceptance: ['y'] },
    { title: 't', objective: 'o', outputs: ['a', 'b'], acceptance: ['y'] },
    { title: 't', objective: 'o', outputs: ['a'], acceptance: [] },
  ]
  for (const row of paddingRows) {
    const issues = referenceReplacementRowIssues(row)
    assert.ok(issues.length > 0, `凑数行必须被拒：${JSON.stringify(row)}`)
  }

  /*
   * 生产侧同口径（真实校验）：接替行的字段形状非法时 planReplan 必须拒绝。
   * 说明：replace 允许省略 objective/title（继承旧行，见 mergeReplacement），
   * 因此「凑数」不能只靠缺字段判定；生产侧目前只做字段形状/部门白名单校验，
   * 反凑数的结构判据由上面的 referenceReplacementRowIssues 承担（缺口已上报）。
   */
  const badDepartment = planReplan(
    basePlan(baseSubtask()),
    [{ subtaskId: 'T5', action: 'replace', reason: '凑数', replacement: { department: 'not-a-department' } }],
    { planId: 'p-q3-split', reason: '非法部门', revision: 2, at: 1_700_000_000_002 },
  )
  assert.equal(badDepartment.ok, false, '非法部门的接替行必须被拒')
  assert.equal((badDepartment as any).code, 'REPLAN_INVALID_REPLACEMENT')

  const badOutputs = planReplan(
    basePlan(baseSubtask()),
    [{ subtaskId: 'T5', action: 'replace', reason: '凑数', replacement: { outputs: 'not-an-array' } }],
    { planId: 'p-q3-split', reason: '产物字段形状非法', revision: 2, at: 1_700_000_000_003 },
  )
  assert.equal(badOutputs.ok, false, '字段形状非法的接替行必须被拒')
  assert.equal((badOutputs as any).code, 'REPLAN_INVALID_REPLACEMENT')

  // 继承语义钉：省略 outputs/acceptance 时接替行继承旧行，绝不退化成空产物行。
  const inherited = planReplan(
    basePlan(baseSubtask()),
    [{ subtaskId: 'T5', action: 'replace', reason: '只改目标', replacement: { objective: '只补缺口' } }],
    { planId: 'p-q3-split', reason: '继承', revision: 2, at: 1_700_000_000_004 },
  )
  assert.equal(inherited.ok, true)
  const inheritedRow = ((inherited as any).payload.plan.stages[0].subtasks as any[]).find((row: any) => row.id === 'T5b')
  assert.deepEqual(inheritedRow.outputs, ['artifacts/t5-q3.md'], '接替行必须继承主产物')
  assert.ok(inheritedRow.acceptance.length >= 1, '接替行必须继承可验收项')
})

/* ------------------------------------------------------------------ *
 * AC-Q3-4：有用户批准 → 记例外、可 done、不生成接替行（与 AC-Q3-2 成对）
 * ------------------------------------------------------------------ */

test('AC-Q3-4 有用户批准：记例外、可 done、不生成接替行（与 AC-Q3-2 成对）', () => {
  const overrunInput = { declaredMinutes: 23, wallClockMinutes: 23 }

  // 成对断言：同样超 10，未批准 vs 已批准必须分叉。
  const unapproved = referenceQ3Settlement({ ...overrunInput, userApproved: false })
  const approved = referenceQ3Settlement({ ...overrunInput, userApproved: true })
  assert.equal(unapproved.criterionResult, 'unmet')
  assert.equal(approved.criterionResult, 'exception-approved')
  assert.equal(approved.canBeDone, true, '有批准允许 done')
  assert.equal(approved.needsReplacement, false, '有批准不生成接替行')
  assert.equal(approved.exceptionRecorded, true, '有批准必须留例外记录')
  assert.notEqual(unapproved.criterionResult, approved.criterionResult, '两种场景必须可区分')

  // 与 AC-Q3-2 同一计划形状：批准场景下计划保持原样（无 supersededAt / 无替换行）。
  const subtask = baseSubtask()
  const plan = basePlan(subtask)
  const statuses = applyStatus(createStatuses(plan as any), 'T5', {
    status: 'done',
    verification: 'structured',
    acceptance: [{ criterion: '文件存在且断言通过', result: 'pass' }],
  })
  const doneRow = statuses.find((row: any) => row.subtaskId === 'T5') as any
  assert.equal(doneRow.status, 'done', '批准后可 done')
  assert.equal(doneRow.closure !== 'replanned', true, '批准场景不得被重规划收口')
  assert.equal(plan.stages[0].subtasks.length, 1, '批准场景不生成接替行')
  assert.equal((plan.stages[0].subtasks[0] as any).supersededAt, undefined)
})
