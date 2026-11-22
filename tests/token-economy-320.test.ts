import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildChildPrompt, dependencyResultBrief } from '../src/plan.js'
import { MAX_LESSON_BRIEF_CHARS, renderLessonsBrief } from '../src/lessons.js'

/*
 * [3.2.0] token 经济的守门测试（只钉结构性事实，不钉具体文案）：
 *  - 依赖摘要 ≤800 字；兄弟简报摘要 ≤80 字且总量受控；
 *  - 历史教训 ≤2200 字、同主题只留一条；
 *  - phase-1 任务书用精简结算模板，并明说 planning/preparation 平台自动并入；
 *  - 全局任务与用户锚点重复时只保留一份。
 */

function makePlan() {
  const mk = (id: string, dependsOn: string[], objective: string) => ({
    id,
    title: `${id} 任务`,
    department: id === 'T1' ? 'data' : 'writing',
    role: '专家',
    objective,
    method: ['读取输入', '产出结果'],
    inputs: ['输入'],
    outputs: [`${id.toLowerCase()}.md`],
    dependsOn,
    acceptance: ['A1 可复核'],
    qualityRequirements: ['给出命令输出'],
    risk: '低',
    estimateMinutes: 10,
    reasoningEffort: 'high',
  })
  const subtasks = [
    mk('T1', [], '产出数据表'),
    mk('T2', ['T1'], '写报告'),
    mk('T3', [], '并行任务'),
  ]
  return {
    version: 1,
    planId: 'wp-token-320',
    title: '测试计划',
    taskAnchor: { text: `${'用户原要求全文。'.repeat(10)}补充：必须逐字保留。`, sha256: 'b'.repeat(64) },
    taskUnderstanding: {
      originalRequest: '用户原要求全文。'.repeat(10),
      deliverable: '一份报告',
      successCriteria: [],
      constraints: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: { primary: { statement: '时间与质量' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', goal: '完成', rationale: 'r', checkpoint: 'c', subtasks }],
  }
}

test('[3.2.0] 依赖摘要压到 800 字，兄弟简报摘要压到 80 字', () => {
  const long = '关键结论。'.repeat(500)
  const brief = dependencyResultBrief(long)
  assert.ok(brief.length <= 800, `依赖摘要应 <=800，实际 ${brief.length}`)

  const plan = makePlan()
  const statuses = plan.stages[0].subtasks.map((item: any, index: number) => ({
    subtaskId: item.id,
    status: index === 0 ? 'done' : 'pending',
    summary: index === 0 ? long : '',
  }))
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[1],
    stage: plan.stages[0],
    dependencyResults: [{ id: 'T1', title: 'T1 任务', status: 'done', summary: long, artifacts: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    cwd: '/tmp',
    statuses,
  })
  const teamBlock = prompt.slice(prompt.indexOf('兄弟部门进展'))
  const siblingLines = teamBlock.split('\n').filter((line: string) => /^- T\d+ /.test(line))
  assert.ok(siblingLines.length > 0, '兄弟简报必须存在')
  assert.ok(siblingLines.every((line: string) => line.length < 300), `每条兄弟简报应受控：${siblingLines.join(' | ')}`)
  assert.ok(siblingLines.some((line: string) => line.includes('T3')), '并行兄弟必须仍可见')
})

test('[3.2.0] 历史教训同主题去重且总长 ≤2200 字', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-320-lessons-'))
  const file = join(dir, 'lessons.jsonl')
  const base = {
    version: 1,
    at: Date.now(),
    planId: 'p',
    subtaskId: 'T1',
    department: 'research',
    cwd: '/tmp',
    problems: ['同名 ETF 成分与名称不一致，按名称检索漏掉最大驱动；根因是只看基金名称。'],
    detours: [],
    resolutions: ['先查指数成分权重，再决定检索方向。'],
    prevention: ['遇到ETF名称与成分可能不一致，先查成分权重再定方向。'],
    occurrences: 1,
    fingerprint: 'f',
  }
  writeFileSync(file, [
    JSON.stringify({ ...base, id: 'l1', title: 'T3 ETF 权重教训' }),
    JSON.stringify({ ...base, id: 'l2', title: 'T4 ETF 权重教训（同主题）' }),
    JSON.stringify({
      ...base, id: 'l3', title: '另一条不同教训',
      prevention: ['遇到日期字段，先用 datetime 实算再引用。'],
      problems: ['日期口径错误，把周日当交易日；根因是没实算。'],
      resolutions: ['用 datetime 实算并分层标注。'],
    }),
  ].join('\n') + '\n', 'utf8')

  const brief = renderLessonsBrief({ department: 'research', title: 'ETF 事件梳理' }, file)
  assert.ok(brief.length <= MAX_LESSON_BRIEF_CHARS, `教训简报应 <=${MAX_LESSON_BRIEF_CHARS}，实际 ${brief.length}`)
  const titleHits = (brief.match(/ETF 权重教训/g) ?? []).length
  assert.equal(titleHits, 1, '同主题教训只保留一条，避免同一规则付两遍')
  assert.ok(brief.includes('datetime'), '不同主题的教训必须保留')
})

test('[3.2.0] 全局任务与锚点重复时只保留一份', () => {
  const plan = makePlan()
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[0],
    stage: plan.stages[0],
    dependencyResults: [],
    cwd: '/tmp',
    statuses: [],
    phaseZeroContinuation: '【phase-0→phase-1 接续】已登记。',
  })
  const original = plan.taskUnderstanding.originalRequest.trim()
  assert.equal(prompt.split(original).length - 1, 1, '同一段用户原文只应出现一次')
  assert.ok(prompt.includes('以锚点为准，不再重复'))
  assert.ok(prompt.includes('平台会自动并入'), '接续任务书必须说明 planning/preparation 免重抄')
  assert.ok(prompt.includes('phase-0 已登记 phases.planning / phases.preparation'))
})
