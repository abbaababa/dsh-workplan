/*
 * [2.2.6][T4] handoff 跨部门需求序列化缺陷回归（缺陷二："[object Object]"）。
 *
 * 写坏点（T1 双缺陷诊断报告 §2.2，已逐处修复并加 [2.2.6][T4] 锚点）：
 *   W1 src/plan.ts readEvidenceNeeds —— 结果块证据解析，对象被 String() 成
 *      字面量 "[object Object]"，department 字段当场丢失；
 *   W2 src/plan.ts mergeHandoffsFromNeeds —— needs→handoff 升级；
 *   W3 src/plan.ts readEvidenceOptions、W4 src/runtime.ts escalate needs/options
 *      （同模式共犯，共用 needEntryText 助手）。
 *
 * 本文件锁四条不变量：
 *  1.（A1）对象形 needs 落盘后 request 保留原文语义（部门/需求/用途齐全）、
 *     department 落库为合法部门键；嵌套/循环/undefined 形状不抛错、读回可深比较；
 *  2.（A1）字符串形 needs 行为逐字不变；
 *  3.（A2）历史 "[object Object]" 记录加载不抛错、存量数据不被改写；
 *  4. 回放/重读幂等：结构化条目二次进入 readEvidenceNeeds 不二次拼前缀、
 *     不绕过去重键造成重复登记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  adjudicateResult,
  applyStatus,
  createStatuses,
  mergeHandoffsFromNeeds,
  needEntryDepartment,
  needEntryText,
  normaliseHandoffs,
} from '../src/plan.js'

function planFixture(overrides: any = {}) {
  return {
    planId: 'p-need-serialization',
    sessionId: 's',
    createdTurn: 1,
    createdAt: 1,
    stages: [{
      id: 'S1',
      name: 's',
      subtasks: [{
        id: 'T1',
        title: '交付一份数据',
        department: 'data',
        role: '数据工程师',
        objective: '产出可复核数据',
        method: ['取数'],
        outputs: ['data.csv'],
        acceptance: ['给出可复现的取数命令'],
        dependsOn: [],
        ...overrides,
      }],
    }],
  }
}

function evidenceBlock(payload: any) {
  return `已完成。\n<!-- WORKPLAN_EVIDENCE:START -->\n${JSON.stringify(payload)}\n<!-- WORKPLAN_EVIDENCE:END -->`
}

function phasesFixture() {
  return {
    planning: {
      problemAnalysis: ['现状：需要交付可复核数据；约束：只能用离线样本；未知：样本是否完整；主要矛盾：覆盖与时间。'],
      constraints: ['只能使用离线样本'],
      unknowns: ['样本完整性待确认'],
      approach: ['先确认数据源与字段 → 写取数脚本 → 运行并记录行数与校验值 → 对照验收逐条留证。'],
    },
    execution: { steps: ['确认数据源', '运行取数脚本', '记录校验值'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [
        { criterion: 'A1', method: '复跑取数命令', evidence: 'node fetch.js --date 2026-11-02 输出一致' },
      ],
      requirementCheck: '验收标准已覆盖。',
      retrospective: {
        problems: ['第一次取数时字段名写错，脚本静默产出 0 行；根因是没有先核对样本字段。'],
        detours: [],
        resolutions: ['先抽样读 3 行确认字段，再改脚本重跑并核对行数。'],
        prevention: ['遇到取数任务，先用 3 行样本确认字段，再写脚本。'],
      },
    },
  }
}

const OBJECT_NEED = { department: 'engineering', need: 'T4 按 P-1/P-2 实施最小 diff', purpose: '修复 handoff 序列化缺陷' }
const COMPOSED = 'engineering：T4 按 P-1/P-2 实施最小 diff（用途：修复 handoff 序列化缺陷）'

function rowWith(statuses: any, subtaskId = 'T1') {
  return statuses.find((item: any) => item.subtaskId === subtaskId)
}

test('A1 对象形 needs：request 保留原文语义、department 落库为合法部门键（W1+W2）', () => {
  const statuses = applyStatus(createStatuses(planFixture() as any), 'T1', { needs: [OBJECT_NEED] })
  const row = rowWith(statuses)
  // 结构化条目：文本可读 + 部门键不再丢失（历史缺陷：request="[object Object]"、department=null）
  assert.deepEqual(row.needs[0], { request: COMPOSED, department: 'engineering' })
  const handoff = row.handoffs[0]
  assert.equal(handoff.request, COMPOSED)
  assert.equal(handoff.department, 'engineering')
  assert.equal(handoff.status, 'open')
  assert.equal(handoff.by, 'child')
})

test('A1 嵌套对象：兜底为受控 JSON，读回与原文 JSON 深比较一致', () => {
  const nested = { detail: { a: 1, b: { c: 'deep' } }, list: [1, undefined, 2] }
  const statuses = applyStatus(createStatuses(planFixture() as any), 'T1', { needs: [nested] })
  const entry = rowWith(statuses).needs[0]
  // 无合法部门键的未知形状对象条目落为字符串形态（受控 JSON，不是 "[object Object]"）
  assert.equal(typeof entry, 'string')
  const request = String(entry)
  // undefined 数组成员按 JSON 规范落为 null（受控序列化，不是 "[object Object]"）
  assert.equal(request, JSON.stringify({ detail: { a: 1, b: { c: 'deep' } }, list: [1, null, 2] }))
  assert.deepEqual(JSON.parse(request), { detail: { a: 1, b: { c: 'deep' } }, list: [1, null, 2] })
})

test('A1 循环引用：不抛错，循环处标记 [Circular]', () => {
  const circular: any = { x: 1 }
  circular.self = circular
  const statuses = applyStatus(createStatuses(planFixture() as any), 'T1', { needs: [circular] })
  const entry = rowWith(statuses).needs[0]
  // 无合法部门键的对象条目落为字符串形态；文本是受控 JSON 而非 "[object Object]"
  assert.equal(typeof entry, 'string')
  assert.match(String(entry), /"self":"\[Circular\]"/)
  // 整条状态可安全再序列化（持久化链路不再被循环引用炸掉）
  assert.doesNotThrow(() => JSON.stringify(statuses))
})

test('A1 字符串形 needs 行为逐字不变（回归）', () => {
  const text = '宿主侧三项的落实路径需要主 Agent 决策'
  const statuses = applyStatus(createStatuses(planFixture() as any), 'T1', { needs: [text] })
  const row = rowWith(statuses)
  assert.equal(row.needs[0], text)
  assert.equal(row.handoffs[0].request, text)
  assert.equal(row.handoffs[0].department, null)
})

test('A2 历史 "[object Object]" 记录：加载不抛错、存量数据不被改写', () => {
  const legacy = [{
    id: 'H1',
    request: '[object Object]',
    department: null,
    status: 'answered',
    response: '已人工补记',
    at: 1794144446143,
    updatedAt: 1794148471408,
    by: 'agent',
  }]
  assert.doesNotThrow(() => normaliseHandoffs(legacy))
  const loaded = normaliseHandoffs(legacy)
  // 存量逐字段原样保留（读取层不篡改历史数据）
  assert.deepEqual(loaded, legacy)
})

test('A2 历史损坏记录与新对象需求共存：旧条目不动、新条目正确落库', () => {
  const legacy = [{
    id: 'H1',
    request: '[object Object]',
    department: null,
    status: 'answered',
    response: null,
    at: 1794144446143,
    updatedAt: 1794148471408,
    by: 'agent',
  }]
  const merged = mergeHandoffsFromNeeds(legacy, [{ department: 'qa', need: '回归 B/C 组', purpose: '对齐基准' }])
  assert.equal(merged.length, 2)
  // 历史条目原样保留（含已处理状态不被重放抹掉）
  assert.equal(merged[0].request, '[object Object]')
  assert.equal(merged[0].status, 'answered')
  // 新对象条目正确落库
  assert.equal(merged[1].request, 'qa：回归 B/C 组（用途：对齐基准）')
  assert.equal(merged[1].department, 'qa')
})

test('幂等：落盘→读回→结果消息回放，去重键稳定、不重复登记', () => {
  const first = applyStatus(createStatuses(planFixture() as any), 'T1', { needs: [OBJECT_NEED] })
  const persisted = JSON.parse(JSON.stringify(first)) // 模拟落盘
  const replayed = applyStatus(persisted as any, 'T1', { needs: [OBJECT_NEED] }) // 结果消息回放
  assert.equal(rowWith(replayed).handoffs.length, 1)
  assert.equal(rowWith(replayed).handoffs[0].request, COMPOSED)
})

test('幂等：结构化条目二次进入 readEvidenceNeeds 不二次拼前缀', () => {
  const first = applyStatus(createStatuses(planFixture() as any), 'T1', { needs: [OBJECT_NEED] })
  const structured = JSON.parse(JSON.stringify(rowWith(first).needs[0])) // {request, department}
  const second = applyStatus(createStatuses(planFixture() as any), 'T1', { needs: [structured] })
  assert.equal(rowWith(second).needs[0].request, COMPOSED)
  assert.equal(rowWith(second).handoffs[0].request, COMPOSED)
  assert.equal(rowWith(second).handoffs[0].department, 'engineering')
})

test('A1 全链路：结果块解析（adjudicateResult）对象形 needs 不再损坏（W1 公开路径）', () => {
  const output = evidenceBlock({
    status: 'done',
    phases: phasesFixture(),
    acceptance: [{ criterion: '给出可复现的取数命令', result: 'pass', evidence: 'node fetch.js --date 2026-11-02' }],
    needs: [{ department: 'qa', need: '回归 B/C 组', purpose: '对齐基准' }],
  })
  const verdict = adjudicateResult({ output, expectedAcceptance: ['给出可复现的取数命令'] })
  assert.equal(verdict.status, 'done')
  assert.equal(verdict.needs[0].request, 'qa：回归 B/C 组（用途：对齐基准）')
  assert.equal(verdict.needs[0].department, 'qa')
})

test('needEntryText/needEntryDepartment 单元：escalate 工具（W4）与 options（W3）共用助手形状', () => {
  assert.equal(needEntryText('纯字符串'), '纯字符串')
  assert.equal(needEntryText(OBJECT_NEED), COMPOSED)
  // 无 purpose 时只拼部门前缀
  assert.equal(needEntryText({ department: 'research', need: '完成根因定位报告' }), 'research：完成根因定位报告')
  // 无文本字段的对象 → 受控 JSON 兜底（旧实现是 "[object Object]"）
  assert.equal(needEntryText({ label: '方案 A' }), '{"label":"方案 A"}')
  assert.equal(needEntryText(null), '')
  assert.equal(needEntryText(undefined), '')
  assert.equal(needEntryText(42), '42')
  // 部门键判定与 normaliseHandoffs 同一标准
  assert.equal(needEntryDepartment({ department: 'engineering' }), 'engineering')
  assert.equal(needEntryDepartment({ department: 'not-a-dept' }), null)
  assert.equal(needEntryDepartment('纯字符串'), null)
})
