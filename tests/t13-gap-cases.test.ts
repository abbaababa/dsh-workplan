/*
 * [T13→T9 1.12.0] T11 低风险补丁的 4 条补位回归用例（D-04 / D-11 / D-19 / D-45）。
 * 由 T13_gap_cases.test.ts 适配 1.12.0 版本口径：D-45 断言 1.11.0 → 1.12.0。
 *
 * 背景（可复核）：T11 自带的 tests/t11-lowrisk-patches.test.ts 只有 12 条用例，
 * 实际断言覆盖 11 个缺陷 ID（D-07/08/09/10/15/17/21/28/30/31/35）；文件头注释
 * 声称 D-04/D-11/D-19/D-45 由「D-10 文档一致性用例 + §45 版本口径核对」覆盖，
 * 但 D-10 的文档用例只比对 docs/departments.md 的部门表行序，不含版本口径、
 * 「执行角色」措辞、交接路径口径，也没有环检测断言。故补这 4 条。
 *
 * 用法（在已应用 T11 补丁的 B2 全树上）：
 *   cp T13_gap_cases.test.ts tests/t13-gap-cases.test.ts
 *   npx tsc -p tsconfig.test.json
 *   node --test dist-tests/tests/t13-gap-cases.test.js
 *
 * 断言只钉文档/代码中已承诺的口径，不钉实现细节。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

import { validatePlan } from '../src/plan.js'

const read = (rel: string) => readFile(path.resolve(process.cwd(), rel), 'utf8')

function subtask(id: string, dependsOn: string[]) {
  return {
    id,
    title: `子任务 ${id}`,
    department: 'engineering',
    role: '执行工程师',
    objective: `完成 ${id} 的工作`,
    method: ['按目标执行'],
    inputs: [],
    outputs: ['结果说明'],
    dependsOn,
    acceptance: ['给出可核对证据'],
    risk: '无',
  }
}

function planWith(subtasks: any[]) {
  return {
    version: 1,
    title: '补位回归',
    taskUnderstanding: {
      originalRequest: '验证 T11 补位用例',
      deliverable: '一份报告',
      successCriteria: ['证据可复核'],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: {
      primary: { statement: '口径与实现不一致', evidence: ['旧文档'], whyPrimary: '会误导' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '执行',
      goal: '完成工作',
      rationale: '只有一个阶段',
      checkpoint: '结果可核对',
      subtasks,
    }],
    risks: [],
    verification: [{ item: '可复核', method: '重跑', evidence: '日志' }],
    practiceLoop: { plan: '计划', do: '执行', check: '核对', act: '修正' },
  }
}

/* ---------- D-45：文档版本口径必须与实现一致 ---------- */

test('D-45 协作文档声明适用版本 1.13.0，且写明 7 处 NOT_ROOT 与 present 仅根会话', async () => {
  const doc = await read('docs/collaboration.md')
  assert.match(doc, /适用版本：\*\*1\.13\.0\*\*/, '文档首部必须声明适用版本 1.13.0')
  assert.match(doc, /7 处/, '权限硬约束必须写为 7 处 NOT_ROOT（旧文写 3 处）')
  assert.match(doc, /present/, '必须写明 present 只允许根会话')
  /* 旧口径「3 处 NOT_ROOT」不得再作为现行约束出现 */
  assert.ok(!/硬约束[^\n]*3 处/.test(doc), '不得再宣称「3 处」硬约束')
})

test('D-45 协作文档不再把 1.7.0 的能力写成「未发布」', async () => {
  const doc = await read('docs/collaboration.md')
  const stale = doc.split('\n').filter((line) => /1\.7\.0/.test(line) && /未发布/.test(line))
  assert.deepEqual(stale, [], `仍存在「1.7.0 未发布」的过期表述：${stale.join(' | ')}`)
})

/* ---------- D-11：role 是「执行角色」，不是负责人 ---------- */

test('D-11 面板把 role/person 显示为「执行角色」，文档同口径', async () => {
  const client = await read('src/client.ts')
  assert.match(client, /"person":\s*"执行角色"/, '中文 person 文案必须是「执行角色」')
  assert.match(client, /"role":\s*"执行角色"/, '中文 role 文案必须是「执行角色」')
  assert.match(client, /"person":\s*"Execution role"/, '英文 person 文案必须是 Execution role')
  assert.match(client, /"role":\s*"Execution role"/, '英文 role 文案必须是 Execution role')
  assert.ok(!/"person":\s*"负责人"/.test(client), '不得把 role 显示为「负责人」')

  const doc = await read('docs/departments.md')
  assert.match(doc, /`role` 是执行角色，不是负责人/, '文档必须写明 role 是执行角色而非负责人')
})

/* ---------- D-04：交接物路径口径固化 ---------- */

test('D-04 部门文档固化交接路径口径（相对或绝对二选一，插件不做归一化）', async () => {
  const doc = await read('docs/departments.md')
  assert.match(doc, /以\*\*工作目录为基准的相对路径\*\*/, '必须写明以工作目录为基准的相对路径')
  assert.match(doc, /或\*\*绝对路径\*\*/, '必须写明绝对路径是可选项')
  assert.match(doc, /二选一/, '必须写明二选一，不得混写')
  assert.match(doc, /不做\*\*?路径归一化|不做\*\*路径归一化/, '必须声明插件不做路径归一化')
})

/* ---------- D-19：环检测有独立回归基线 ---------- */

test('D-19 依赖成环时校验拒绝，并给出环信息（不只依赖顺序规则）', () => {
  const result = validatePlan(planWith([
    subtask('T1', ['T2']),
    subtask('T2', ['T1']),
  ]))
  assert.equal(result.ok, false, 'T1<->T2 成环必须被拒绝')
  const errors = (result.errors ?? []).join(' / ')
  assert.match(errors, /依赖存在环：T1/, `必须给出环信息，实际：${errors}`)
})
