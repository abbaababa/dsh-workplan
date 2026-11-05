/*
 * [2.0.0] 自我学习与自我迭代的可执行契约（用户 2026-11-05 强制要求）。
 *
 * 锁五件事：
 *  1. 阶段三必须复盘「问题 / 弯路 / 解决 / 防再犯」，缺项或太薄都判未完成；
 *  2. 复盘通过后写入 JSONL 永久记忆，重试不虚增次数、同类错误跨任务累加；
 *  3. 下次派发前把相关历史教训注入子 Agent 提示词（越重复越靠前）；
 *  4. 提示词与结果模板都带 retrospective，提示词要求什么、判定就检查什么；
 *  5. 记忆文件损坏一行不会拖垮整份记忆。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  buildChildPrompt,
} from '../src/plan.js'
import { validatePhaseEvidence } from '../src/three-phase.js'
import {
  fingerprintLesson,
  lessonStats,
  rankLessons,
  readLessons,
  recordLesson,
  renderLessonsBrief,
  resolveLessonsFile,
  validateRetrospective,
} from '../src/lessons.js'

function retro(overrides: any = {}) {
  return {
    problems: ['第一次没有先读现有实现，改了错误入口，导致返工；根因是跳过了现状梳理。'],
    detours: ['先按猜测改了 A 文件，发现入口在 B 文件。'],
    resolutions: ['先用 grep 定位真实入口，再按阶段一思路重做并逐条验证。'],
    prevention: ['遇到改代码任务，先用 grep 定位入口再动手，不按猜测改。'],
    ...overrides,
  }
}

function phases(overrides: any = {}) {
  return {
    planning: {
      problemAnalysis: ['现状：需要交付可复核数据，但现有脚本没有字段校验；约束：只能使用离线样本、不能联网；未知：样本是否完整、字段名是否与文档一致；主要矛盾：交付时间紧与必须逐条留证之间的冲突。'],
      constraints: ['只能离线'],
      unknowns: ['样本是否完整'],
      approach: ['第一步先抽样读 3 行确认字段名与类型 → 第二步写取数脚本并加入字段校验 → 第三步运行脚本并记录行数与 sha256 → 第四步对照验收标准逐条留证 → 第五步复核产物路径可被下游直接读取。'],
    },
    execution: { steps: ['确认数据源', '运行脚本', '记录行数'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: 'A1', method: '复跑取数', evidence: 'rows=1200' }],
      requirementCheck: '验收标准逐条覆盖。',
      retrospective: retro(),
    },
    ...overrides,
  }
}

function evidence(payload: any) {
  return `完成。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

function tempLessonsFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-lessons-'))
  return join(dir, 'lessons.jsonl')
}

test('复盘校验：四项齐全且有实质内容才通过', () => {
  assert.equal(validateRetrospective(retro()).ok, true)

  const missing = validateRetrospective(undefined)
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join('；'), /retrospective 缺失/)

  const empty = validateRetrospective({ problems: [], detours: [], resolutions: [], prevention: [] })
  assert.equal(empty.ok, false)
  assert.match(empty.errors.join('；'), /problems 至少写 1 条/)
  assert.match(empty.errors.join('；'), /prevention 至少写 1 条/)

  const thin = validateRetrospective({ problems: ['报错'], detours: [], resolutions: ['改了'], prevention: ['小心'] })
  assert.equal(thin.ok, false)
  assert.match(thin.errors.join('；'), /太薄/)
})

test('阶段三证据：缺复盘无法判 done，补齐后通过并保留复盘内容', () => {
  const noRetro = phases()
  delete (noRetro.verification as any).retrospective
  const rejected = validatePhaseEvidence(noRetro, ['A1'])
  assert.equal(rejected.ok, false)
  assert.match(rejected.errors.join('；'), /retrospective/)
  assert.equal(rejected.failedPhase, 'verification')

  const ok = validatePhaseEvidence(phases(), ['A1'])
  assert.equal(ok.ok, true)
  assert.equal(ok.phases?.verification.retrospective.prevention.length, 1)
})

test('完成判定：复盘缺失时判 blocked，齐全时判 done 并带出复盘', () => {
  const planAcceptance = ['同一请求只写一条记录']
  const base = {
    status: 'done',
    phases: phases(),
    acceptance: [{ criterion: '同一请求只写一条记录', result: 'pass', evidence: '数据库 1 条' }],
    artifacts: [],
    needs: [],
  }
  const noRetro = structuredClone(base)
  delete (noRetro.phases.verification as any).retrospective
  const blocked = adjudicateResult({ output: evidence(noRetro), expectedAcceptance: planAcceptance })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.verification, 'unverified')
  assert.match(String(blocked.error), /三阶段证据不完整/)

  const done = adjudicateResult({ output: evidence(base), expectedAcceptance: planAcceptance })
  assert.equal(done.status, 'done')
  assert.equal(done.phases?.verification.retrospective.prevention.length, 1)
})

test('提示词：注入历史教训，并要求阶段三复盘', () => {
  const prompt = buildChildPrompt({
    plan: { planId: 'wp-1', taskUnderstanding: {} },
    subtask: {
      id: 'T1',
      title: '修写入重复',
      department: 'engineering',
      role: 'engineer',
      duty: '实现',
      objective: '修掉重复写入',
      method: ['改代码'],
      inputs: [],
      outputs: ['补丁'],
      acceptance: ['并发下只写一条'],
      risk: '可能影响旧调用方',
    },
    stage: { name: '执行' },
    dependencyResults: [],
    cwd: '/tmp',
    lessonsBrief: '历史教训（永久记忆）：遇到改代码任务先用 grep 定位入口再动手。',
  })
  assert.match(prompt, /历史教训（永久记忆）/)
  assert.match(prompt, /retrospective/)
  assert.match(prompt, /自我学习复盘（强制）/)
})

test('永久记忆：落盘、同子任务不虚增、同类错误跨任务累加', () => {
  const file = tempLessonsFile()
  const first = recordLesson({
    file,
    planId: 'wp-1',
    subtaskId: 'T1',
    department: 'engineering',
    title: 'T1 修写入',
    cwd: '/repo',
    retrospective: retro(),
    now: 1_000,
  })
  assert.equal(first?.mode, 'created')
  assert.equal(first?.record.occurrences, 1)

  // 同一子任务重试/回放：原地更新，不增加次数。
  const replay = recordLesson({
    file,
    planId: 'wp-1',
    subtaskId: 'T1',
    department: 'engineering',
    title: 'T1 修写入',
    retrospective: retro(),
    now: 2_000,
  })
  assert.equal(replay?.mode, 'updated')
  assert.equal(replay?.record.occurrences, 1)
  assert.equal(readLessons(file).length, 1)

  // 另一个子任务犯同一类错误：occurrences 累加（自我迭代信号）。
  const repeat = recordLesson({
    file,
    planId: 'wp-2',
    subtaskId: 'T9',
    department: 'engineering',
    title: 'T9 又改错入口',
    retrospective: retro(),
    now: 3_000,
  })
  assert.equal(repeat?.mode, 'repeated')
  assert.equal(repeat?.record.occurrences, 2)
  const rows = readLessons(file)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].occurrences, 2)
  // 不因重复而丢失新增的弯路/预防条目。
  assert.ok(rows[0].prevention.length >= 1)
})

test('永久记忆：文件损坏一行不影响其余教训，空复盘不落盘', () => {
  const file = tempLessonsFile()
  recordLesson({
    file,
    planId: 'wp-1',
    subtaskId: 'T1',
    department: 'design',
    title: 'T1 视觉',
    retrospective: {
      problems: ['色值写错导致对比度不足，根因是没先跑对比度检查。'],
      detours: [],
      resolutions: ['改用主题 token 并跑对比度脚本确认。'],
      prevention: ['遇到颜色改动，先跑对比度检查再提交。'],
    },
  })
  writeFileSync(file, `${readFileSync(file, 'utf8')}not-json-line\n`, 'utf8')
  const rows = readLessons(file)
  assert.equal(rows.length, 1)
  assert.match(rows[0].prevention[0], /对比度/)

  const empty = recordLesson({
    file,
    planId: 'wp-1',
    subtaskId: 'T2',
    department: 'design',
    title: '空复盘',
    retrospective: { problems: [], detours: [], resolutions: [], prevention: [] },
  })
  assert.equal(empty, null)
  assert.equal(readLessons(file).length, 1)
})

test('防再犯：相关教训注入提示词，重复次数越多排得越靠前', () => {
  const file = tempLessonsFile()
  recordLesson({
    file,
    planId: 'wp-1',
    subtaskId: 'T1',
    department: 'data',
    title: 'T1 取数',
    retrospective: {
      problems: ['取数脚本字段写错，产出 0 行；根因是没先核对样本字段。'],
      detours: ['直接跑完整脚本才发现字段不匹配。'],
      resolutions: ['先抽样 3 行确认字段再改脚本。'],
      prevention: ['遇到取数任务，先用 3 行样本确认字段再写脚本。'],
    },
    now: Date.now(),
  })
  recordLesson({
    file,
    planId: 'wp-2',
    subtaskId: 'T2',
    department: 'data',
    title: 'T2 再次取数',
    retrospective: {
      problems: ['取数脚本字段写错，产出 0 行；根因是没先核对样本字段。'],
      detours: [],
      resolutions: ['先抽样 3 行确认字段再改脚本。'],
      prevention: ['遇到取数任务，先用 3 行样本确认字段再写脚本。'],
    },
    now: Date.now(),
  })
  const rows = readLessons(file)
  const ranked = rankLessons(rows, { department: 'data', title: '取数脚本', now: Date.now() })
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].occurrences, 2)

  const brief = renderLessonsBrief({ department: 'data', title: '取数脚本' }, file)
  assert.match(brief, /永久记忆/)
  assert.match(brief, /重复 2 次/)
  assert.match(brief, /预防（硬规则）/)
  assert.match(brief, /先用 3 行样本确认字段/)
  assert.doesNotMatch(brief, /dsh-session:/)

  const stats = lessonStats(file)
  assert.equal(stats.total, 1)
  assert.equal(stats.repeated, 1)
  assert.equal(stats.departments[0].department, 'data')
})

test('记忆文件位置可用环境变量覆盖（默认在主目录，跨项目保留）', () => {
  assert.match(resolveLessonsFile({}), /\.dsh[\\/]workplan[\\/]lessons\.jsonl$/)
  assert.equal(resolveLessonsFile({ DSH_WORKPLAN_LESSONS_FILE: '/tmp/x.jsonl' }), '/tmp/x.jsonl')
})

test('同类教训指纹稳定：换标点/空格仍算同一类', () => {
  const a = fingerprintLesson({ department: 'qa', problems: ['测试 用例 没跑'], prevention: ['先跑 全量测试'] })
  const b = fingerprintLesson({ department: 'qa', problems: ['测试用例没跑'], prevention: ['先跑全量测试'] })
  assert.equal(a, b)
})
