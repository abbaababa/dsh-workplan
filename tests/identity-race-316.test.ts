/**
 * [3.1.6] 守门：负责人身份竞态 + phase-0/phase-1 口径冲突。
 *
 * 现场复盘（T2/T3 各失败一次 SELF_EFFORT_MISSING）：负责人行的 childId 过去只写在
 * 内存台账里，轮次中任何一次重建（手动 dispatch / update 改判 / 重启回放）都会把它
 * 洗掉，负责人随后调 delegate(review/direct) 被 NO_SUBTASK 拒，推理等级登记不了，
 * phase-0 结算闸报 SELF_EFFORT_MISSING 并白重试一次。
 *
 * 本轮修法：childId 随 durable workplan-update 落盘并在回放侧认回（写读同源）；
 * 派发实例表补进程内认亲；phase-1 任务书不再一边说「不要重做」一边要求「先做前三步」。
 * 这组用例盯住这四条不变量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlanMessage,
  buildUpdateMessage,
  createStatuses,
  applyStatus,
} from '../src/plan.js'
import { buildChildPrompt, buildPhaseZeroContinuationHint, renderStartEvidenceBrief } from '../src/plan.js'
import { buildDelegateePrompt } from '../src/llm-rules.js'
import { persistStartEvidenceFile, reconstructFromSession } from '../src/runtime.js'

const PLAN = {
  planId: 'wp-identity-316',
  sessionId: 'session-identity',
  createdTurn: 1,
  createdAt: 1000,
  title: '身份竞态',
  contradictions: { primary: { statement: '身份必须可回放' } },
  stages: [{ id: 'S1', subtasks: [{ id: 'T1', dependsOn: [] }] }],
}

function sessionOf(messages: any[]) {
  const events = messages.map((message) => ({ type: 'user/message', data: message, time: 1000 }))
  return {
    seq: events.length,
    header: { createdAt: 1000 },
    eventAt: (seq: number) => events[seq],
  }
}

test('[3.1.6] childId 随 durable update 落盘，重建台账后仍在', () => {
  const message = buildUpdateMessage({
    planId: PLAN.planId,
    planCreatedAt: PLAN.createdAt,
    subtaskId: 'T1',
    status: 'in_progress',
    closure: 'assigned',
    progress: 10,
    childId: 'child-leader-316',
    revision: 2,
  })
  assert.equal((message as any).source?.durable?.childId, 'child-leader-316', '写侧必须携带 childId')

  const record: any = reconstructFromSession(sessionOf([buildPlanMessage(PLAN), message]) as any)
  const row = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.childId, 'child-leader-316', '回放必须认回负责人身份')
})

test('[3.1.6] 旧日志没有 childId 时零迁移，不误清已有身份', () => {
  const first = buildUpdateMessage({
    planId: PLAN.planId,
    planCreatedAt: PLAN.createdAt,
    subtaskId: 'T1',
    status: 'in_progress',
    closure: 'assigned',
    progress: 10,
    childId: 'child-leader-316',
    revision: 2,
  })
  // 旧格式：不带 childId 的改判（例如旧版本写下的 durable）
  const second = buildUpdateMessage({
    planId: PLAN.planId,
    planCreatedAt: PLAN.createdAt,
    subtaskId: 'T1',
    status: 'in_progress',
    progress: 40,
    revision: 3,
  })
  assert.equal((second as any).source?.durable?.childId, undefined, '旧格式不得凭空造身份')
  const record: any = reconstructFromSession(sessionOf([buildPlanMessage(PLAN), first, second]) as any)
  const row = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(row.childId, 'child-leader-316', '缺省字段必须保留旧值，不得清空')
  assert.equal(row.progress, 40)
})

test('[3.1.6] applyStatus 只有显式给 childId 才改身份', () => {
  const statuses = applyStatus(createStatuses(PLAN), 'T1', { childId: 'child-a', revision: 2 })
  const kept = applyStatus(statuses, 'T1', { progress: 50 })
  assert.equal(kept[0].childId, 'child-a')
})

test('[3.1.6] phase-1 任务书不再同时要求「不要重做」与「必须先做前三步」', () => {
  const subtask = {
    id: 'T1',
    title: '实现幂等写入',
    department: 'engineering',
    role: 'expert',
    objective: '同一请求只写一条记录',
    method: ['读代码', '改代码', '验证'],
    inputs: ['现有写入路径'],
    outputs: ['补丁', '验证记录'],
    acceptance: ['同一请求连发两次只写一条记录'],
    risk: '可能影响旧调用方',
    dependsOn: [],
  }
  const base = {
    plan: PLAN,
    subtask,
    stage: PLAN.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    conversationContext: '',
    statuses: createStatuses(PLAN),
  }
  const phase1: string = buildChildPrompt({ ...base, phaseZeroContinuation: '【phase-0→phase-1 接续】不要重做 phase-0 已完成的工作。' })
  assert.match(phase1, /不要重做/, '接续块必须保留')
  assert.match(phase1, /直接从第四步执行/, '接续时必须明确从第四步继续')
  assert.doesNotMatch(phase1, /执行自己的任务必须先完成上方「五步工作法」的前三步/, '不得同时下发「必须先做前三步」')

  const legacy: string = buildChildPrompt(base)
  assert.match(legacy, /执行自己的任务必须先完成上方「五步工作法」的前三步/, '无接续块时保留原口径（旧计划兼容）')
})

test('[3.1.6] 专家 phase-1 任务书明确「前三步已登记，不要重做」且关键串不丢', () => {
  const prompt = buildDelegateePrompt({
    departmentLabel: '工程',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '部门任务',
    member: { member: 'X', role: 'expert', task: '单项工作', effort: 'xhigh', qualityRequirements: ['必须给出命令输出'] },
    rulesBrief: '规则简报',
    cwd: '/tmp',
  } as any)
  assert.match(prompt, /不要重做/, '必须避免重做 phase-0')
  assert.match(prompt, /直接从第四步执行/)
  assert.match(prompt, /先全面、全盘、深入梳理、研究、思考自己的任务/)
  assert.match(prompt, /基于第一步完成好的所有结果研究需要哪些资源、哪些工具、具体实施方案/)
  assert.match(prompt, /approachBasis/)
  assert.match(prompt, /startPhases/)
})

test('[3.1.6] 接续块携带前三步的「登记证据原文」，不只是摘要', () => {
  const registered = {
    planning: {
      problemAnalysis: ['P1 先读入口与调用链，确认三条写入路径：delegate 入口、结算回调与回放白名单，并记录各自的判定条件。'],
      approach: ['A1 按入口→调度→结算顺序改造：先补身份落盘，再让回放认身份，最后加兜底认亲。'],
      approachBasis: ['B1 现场复现证明结算回调会覆盖台账，故必须先落盘再谈兜底。'],
      resources: ['R1 src/runtime.ts 与 src/plan.ts，外加 lib 构建产物用于探针验证。'],
      tools: ['T1 node --test 定向用例与 tsc --noEmit。'],
    },
    preparation: {
      prepared: ['C1 已确认改造点行号与调用顺序，改造窗口已锁定。'],
      evidence: ['E1 grep 输出：三处写入点与两处回放点，行号已记录。'],
    },
  }
  const longOutput = 'phase-0 口语摘要。'.repeat(120) // 超过 600 字符
  const hint = buildPhaseZeroContinuationHint('high', longOutput, false, registered)
  // 摘要按 600 字符截断（省 token 的既有设计），但登记证据必须逐字在
  assert.ok(hint.length > 600, '接续块本身必须比摘要长')
  assert.match(hint, /开工登记证据·原文/)
  assert.match(hint, /P1 先读入口与调用链，确认三条写入路径/)
  assert.match(hint, /A1 按入口→调度→结算顺序改造/)
  assert.match(hint, /B1 现场复现证明结算回调会覆盖台账/)
  assert.match(hint, /R1 src\/runtime\.ts 与 src\/plan\.ts/)
  assert.match(hint, /E1 grep 输出：三处写入点/)
  // 口径必须限定为「已覆盖的部分」而不是绝对「不要重做任何事」
  assert.match(hint, /只补缺口/)
})

test('[3.1.7] 证据分层：蓝图全量、审计链只给索引、完整原文指向落盘文件', () => {
  const registered = {
    planning: {
      problemAnalysis: ['P1 先读入口与调用链，确认三条写入路径：delegate 入口、结算回调与回放白名单，并记录各自的判定条件。'],
      approach: ['A1 按入口→调度→结算顺序改造：先补身份落盘，再让回放认身份，最后加兜底认亲。'],
      approachBasis: ['B1 现场复现证明结算回调会覆盖台账，故必须先落盘再谈兜底。'],
      resources: ['R1 src/runtime.ts 与 src/plan.ts，外加 lib 构建产物用于探针验证。'],
      tools: ['T1 node --test 定向用例与 tsc --noEmit。'],
    },
    preparation: {
      prepared: ['C1 已确认改造点行号与调用顺序，改造窗口已锁定。'],
      evidence: ['E1 grep 输出：三处写入点与两处回放点，行号已记录。'],
    },
  }
  const brief = renderStartEvidenceBrief(registered, 'reports/wp-start-evidence-wp-x-T1.md')
  // 蓝图（必须照做的部分）逐字在内
  assert.match(brief, /A1 按入口→调度→结算顺序改造/)
  assert.match(brief, /B1 现场复现证明结算回调会覆盖台账/)
  // 审计链只留索引：正文不重复，但条数与字数可见
  assert.match(brief, /第一步·任务梳理 problemAnalysis：1 条 \/ \d+ 字/)
  assert.match(brief, /第三步·就绪证据 evidence：1 条 \/ \d+ 字/)
  assert.doesNotMatch(brief, /R1 src\/runtime\.ts 与 src\/plan\.ts/)
  // 完整原文有明确落点
  assert.match(brief, /完整原文已逐字落盘：reports\/wp-start-evidence-wp-x-T1\.md/)
  assert.match(brief, /不要凭记忆重写/)
})

test('[3.1.7] 没有落盘引用时回退全文注入（任何情况下不丢证据）', () => {
  const registered = {
    planning: {
      problemAnalysis: ['P1 先读入口与调用链，确认三条写入路径：delegate 入口、结算回调与回放白名单，并记录各自的判定条件。'],
      approach: ['A1 按入口→调度→结算顺序改造：先补身份落盘，再让回放认身份，最后加兜底认亲。'],
      approachBasis: ['B1 现场复现证明结算回调会覆盖台账，故必须先落盘再谈兜底。'],
      resources: ['R1 src/runtime.ts 与 src/plan.ts，外加 lib 构建产物用于探针验证。'],
      tools: ['T1 node --test 定向用例与 tsc --noEmit。'],
    },
    preparation: {
      prepared: ['C1 已确认改造点行号与调用顺序，改造窗口已锁定。'],
      evidence: ['E1 grep 输出：三处写入点与两处回放点，行号已记录。'],
    },
  }
  const hint = buildPhaseZeroContinuationHint('high', '摘要', false, registered)
  assert.match(hint, /开工登记证据·原文/)
  assert.match(hint, /R1 src\/runtime\.ts 与 src\/plan\.ts/)
  assert.match(hint, /E1 grep 输出/)
})

test('[3.1.7] 落盘文件包含完整原文，路径可直接读取', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const registered = {
    planning: {
      problemAnalysis: ['P1 先读入口与调用链，确认三条写入路径：delegate 入口、结算回调与回放白名单，并记录各自的判定条件。'],
      approach: ['A1 按入口→调度→结算顺序改造：先补身份落盘，再让回放认身份，最后加兜底认亲。'],
      approachBasis: ['B1 现场复现证明结算回调会覆盖台账，故必须先落盘再谈兜底。'],
      resources: ['R1 src/runtime.ts 与 src/plan.ts，外加 lib 构建产物用于探针验证。'],
      tools: ['T1 node --test 定向用例与 tsc --noEmit。'],
    },
    preparation: {
      prepared: ['C1 已确认改造点行号与调用顺序，改造窗口已锁定。'],
      evidence: ['E1 grep 输出：三处写入点与两处回放点，行号已记录。'],
    },
  }
  const cwd = mkdtempSync(join(tmpdir(), 'wp-evidence-'))
  const rel = persistStartEvidenceFile(cwd, 'wp-x', 'T1', registered)
  assert.ok(rel && rel.startsWith('reports/'), '必须返回 reports/ 相对路径')
  const abs = join(cwd, rel!)
  assert.ok(existsSync(abs), '文件必须真的写到磁盘')
  const text = readFileSync(abs, 'utf8')
  // 全文：审计链与蓝图都在
  assert.match(text, /R1 src\/runtime\.ts 与 src\/plan\.ts/)
  assert.match(text, /A1 按入口→调度→结算顺序改造/)
  assert.match(text, /第三步·就绪证据 evidence/)
})

test('[3.1.7] 无 cwd 或非法证据时返回 null（调用点据此回退全文）', () => {
  assert.equal(persistStartEvidenceFile('', 'wp-x', 'T1', { planning: {}, preparation: {} }), null)
  assert.equal(persistStartEvidenceFile('/tmp', 'wp-x', 'T1', null), null)
})
