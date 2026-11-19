/*
 * [SCv2-T6] 「简单」判据 v2 · T6 回归：Q5 历史回溯（E-2/E-5/E-6）。
 * 承载用例：C-Q5-01…C-Q5-04（cases.md §6.2）。
 * 预期唯一来源：spec:192-194（AC-Q5-1…AC-Q5-3）。
 * GAP-6：C-Q5-01 依赖 T7 变更说明落盘；未落盘 ⇒ pending-unverified（t.todo），
 * 由 T8 复核清单承接，不伪造通过。
 * GAP-2：基线清单＝T6 首跑前快照 reports/simple-criterion-v2-history-baseline.txt。
 * 2026-11-18 按同一快照程序刷新（shasum -a 256 重拍、shasum -c 复核）：T10R-final-acceptance /
 * T11-acceptance 两份历史验收报告在 2026-11-18 仓库清理（2.8GB→108MB，commit 26fddc2 同批）
 * 中从规范位置移除——移除前留存的副本（_t4_regression_final_20261113/after-copy/reports/）经
 * shasum -a 256 复核与基线哈希逐位一致（内容未被改写），故自清单移除；evidence-index 仍在盘
 * 且哈希与 T6 快照一致，继续作为防改写锚点。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { criterionV2Active } from '../src/criterion.js'
import { validatePlan } from '../src/plan.js'
import { reconstructFromSession } from '../src/runtime.js'
import { ACTIVE_ENV, withEnv } from './helpers/scv2-runtime.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'

const REPORTS = path.resolve(process.cwd(), '../../reports')

test('C-Q5-01（AC-Q5-1 正例，GAP-6）：变更说明含裁决日期/生效条件/不回溯；T7 未落盘 ⇒ pending-unverified', (t) => {
  const candidates = [
    path.join(REPORTS, 'simple-criterion-v2-changelog-draft.md'),
    path.join(REPORTS, 'simple-criterion-v2-changelog.md'),
  ]
  const file = candidates.find((p) => existsSync(p))
  if (!file) {
    t.todo('GAP-6：T7 变更说明尚未落盘（changelog-draft.md 不存在）⇒ C-Q5-01 pending-unverified，由 T8 复核承接')
    return
  }
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('2026-11-13'), '①命中裁决日期')
  assert.ok(/部署/.test(text) && /重启/.test(text), '②命中部署/重启生效条件')
  assert.ok(/不回溯|不重判/.test(text), '③命中不回溯/不重判')
  assert.ok(!/T3\/T4 违规/.test(text), '④无违规回填表述')
})

test('C-Q5-02（AC-Q5-2 正例）：旧计划 estimateMinutes=23/28 回放不拒、不改判、不产生违规', async () => {
  for (const minutes of [23, 28]) {
    const plan = {
      version: 1,
      title: '历史计划回放',
      taskUnderstanding: { originalRequest: '历史任务', deliverable: '产物', successCriteria: ['完成'], constraints: [], knownFacts: [], unknowns: [], assumptions: [] },
      contradictions: { primary: { statement: '历史矛盾', evidence: ['证据'], whyPrimary: '原因' }, secondary: [], transformationConditions: [] },
      stages: [{ id: 'S1', name: '实施', goal: '目标', rationale: '理由', checkpoint: '检查', subtasks: [{ id: 'T1', title: '历史任务', department: 'engineering', role: '工程师', objective: '历史目标', method: ['执行'], inputs: [], outputs: ['历史产物'], dependsOn: [], acceptance: ['完成'], risk: '无', estimateMinutes: minutes }] }],
      risks: [{ risk: '无', likelihood: 'low', impact: '无', mitigation: '无', trigger: '无' }],
      verification: [{ item: '回放', method: '单测', evidence: '本文件' }],
      practiceLoop: { plan: 'p', do: 'd', check: 'c', act: 'a' },
    }
    // ① validatePlan.ok=true（不因 >10 被拒；即使 env 生效也不回溯）
    await withEnv(ACTIVE_ENV, async () => {
      const res: any = validatePlan(plan)
      assert.equal(res.ok, true, `estimateMinutes=${minutes} 旧计划不被新规则拒绝`)
      assert.equal(res.plan.stages[0].subtasks[0].estimateMinutes, minutes, '估时原样保留')
    })
    // ② 回放后 status 仍 done（createdAt 早于生效点，Q5-A）
    const planId = `wp-scv2-t6-legacy-${minutes}`
    const sessionId = `session-scv2-t6-legacy-${minutes}`
    const session: any = {
      id: sessionId, header: { createdAt: 1_000, cwd: process.cwd() }, events: [] as any[],
      get seq() { return this.events.length },
      append(type: string, data: any) { this.events.push({ type, data }); return data },
      eventAt: (seq: number) => session.events[seq],
    }
    const fullPlan = { ...plan, planId, sessionId, createdTurn: 1, createdAt: 1_000 }
    session.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN:BEGIN -->\n${JSON.stringify({ kind: 'workplan', version: 1, planId, sessionId, plan: fullPlan })}\n<!-- DSH-WORKPLAN:END -->` }] })
    seedLeaderSelfEffort(session, fullPlan)
    const resultPayload = {
      kind: 'workplan-result', version: 1, planId, sessionId, dispatchedAt: 5_000, phase: 'done',
      stats: { total: 1, done: 1, blocked: 0, inProgress: 0, pending: 0, progress: 100 },
      statuses: [{ subtaskId: 'T1', status: 'done', progress: 100, summary: '历史验收 done' }],
      errors: [], resumeCount: 0, resumeAvailable: false,
    }
    session.append('user/message', { content: [{ type: 'text', text: `<!-- DSH-WORKPLAN-RESULT:BEGIN -->\n${JSON.stringify(resultPayload)}\n<!-- DSH-WORKPLAN-RESULT:END -->` }] })
    await withEnv(ACTIVE_ENV, async () => {
      const replayed: any = reconstructFromSession(session)
      const row = replayed.statuses.find((item: any) => item.subtaskId === 'T1')
      assert.equal(row.status, 'done', '回放后仍 done，不改判')
      // ③ 不产生违规记录、不重判、不重跑
      assert.equal(row.criterionResult, undefined, '未生效计划不落判据字段')
      assert.equal(row.criterionViolations, undefined, '不回填违规')
    })
  }
})

test('C-Q5-03（AC-Q5-3 边界，GAP-2）：T6 首跑前历史基线快照 shasum -c 全部 OK（执行后复核）', (t) => {
  const baseline = path.join(REPORTS, 'simple-criterion-v2-history-baseline.txt')
  if (!existsSync(baseline)) {
    t.todo('GAP-2：基线清单缺失 ⇒ unverified（不记 pass）')
    return
  }
  const run = spawnSync('shasum', ['-a', '256', '-c', baseline], { cwd: path.resolve(process.cwd(), '../..'), encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const failed = output.split('\n').filter((line) => /FAILED/.test(line))
  assert.deepEqual(failed, [], `历史文件被改写：${failed.join('；')}`)
  assert.equal(run.status, 0, `shasum -c 退出码应为 0：${output}`)
  assert.ok(output.includes('OK'), '必须有逐文件 OK 记录')
})

test('C-Q5-04（执行时限取消）：criterionV2Active 在任何环境变量与时间点都恒为 false', () => {
  const since = 1_000_000
  const env = { DSH_WORKPLAN_CRITERION_V2: '1', DSH_WORKPLAN_CRITERION_V2_SINCE: String(since) }
  assert.equal(criterionV2Active(since - 1_000, env), false)
  assert.equal(criterionV2Active(since, env), false, '历史生效点也不再打开 10 分钟门')
  assert.equal(criterionV2Active(since + 1_000, env), false)
  assert.equal(criterionV2Active(Number.MAX_SAFE_INTEGER, env), false, '未来任何时间都不生效')
  const iso = { DSH_WORKPLAN_CRITERION_V2: 'true', DSH_WORKPLAN_CRITERION_V2_SINCE: '2026-11-13T00:00:00Z' }
  assert.equal(criterionV2Active(Date.parse('2026-11-13T00:00:01Z'), iso), false)
  assert.equal(criterionV2Active(Date.parse('2026-11-12T23:59:59Z'), iso), false)
})
