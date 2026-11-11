/*
 * [2.3.10][T2] 用户要求1「分配前会话内预告耗时」最小补丁回归。
 *
 * 断言点：
 *  - A2 文案可观察：规划/派发预告均含明确时间数值与单位「分钟」，并带
 *    O-5b「仅供参考，非承诺」标注；预估口径（窗口一半 / estimateMinutes 下界）
 *    数值正确，空计划不产生派发预告。
 *  - A2 触发点顺序（源码锚定，路径用 process.cwd() 从包根定位——历史教训：
 *    编译进 dist-tests 后 import.meta.url 相对路径失效）：P1 在 runPlanner 之前；
 *    P2 在终态闸门之后、wait/async 模式分支之前，且带 planId 幂等守卫。
 *  - A3 schema 兼容：estimateMinutes 校验与 reasoningEffort 常量原样（全量
 *    回归由既有套件承担，这里锚定关键导出未被改动语义）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  planningEstimateMinutes,
  buildPlanningPreAnnouncement,
  buildDispatchPreAnnouncement,
  estimatePlanMinutes,
  MAX_CONCURRENT,
  REASONING_EFFORTS,
  DEFAULT_REASONING_EFFORT,
} from '../src/plan.js'

const runtimeSource = readFileSync(join(process.cwd(), 'src/runtime.ts'), 'utf8')
const hostSource = readFileSync(join(process.cwd(), 'src/host.ts'), 'utf8')

test('规划预估口径：窗口一半向上取整、至少 1 分钟、非法输入回落默认窗口', () => {
  assert.equal(planningEstimateMinutes(300000), 3)
  assert.equal(planningEstimateMinutes(60000), 1)
  assert.equal(planningEstimateMinutes(1000), 1)
  assert.equal(planningEstimateMinutes(0), 3)
  assert.equal(planningEstimateMinutes(-5), 3)
  assert.equal(planningEstimateMinutes('abc'), 3)
})

test('A2 规划预告：含【规划预告】、明确分钟数值、窗口与重试口径、非承诺标注', () => {
  const text = buildPlanningPreAnnouncement(300000, 3)
  assert.match(text, /【规划预告】/)
  assert.match(text, /预估约 3 分钟/)
  assert.match(text, /单次规划窗口 5 分钟/)
  assert.match(text, /最多尝试 3 次/)
  assert.match(text, /仅供参考，非承诺/)
})

test('A2 派发预告：子任务数 + estimateMinutes 下界估算 + 非承诺标注', () => {
  const plan = { stages: [{ subtasks: [{ estimateMinutes: 10 }, { estimateMinutes: 20 }] }] }
  const text = buildDispatchPreAnnouncement(plan)
  const expected = Math.max(1, estimatePlanMinutes(plan))
  assert.equal(expected, Math.max(1 * 20, Math.ceil(30 / MAX_CONCURRENT)))
  assert.match(text, /【派发预告】/)
  assert.match(text, /本次分配 2 个子任务/)
  assert.ok(text.includes(`预计执行约 ${expected} 分钟`))
  assert.match(text, /仅供参考，非承诺/)
  assert.match(text, /实际时长由执行专家开工预告协商决定/)
})

test('派发预告：缺 estimateMinutes 按每项 15 分钟默认；空计划返回空串不发通知', () => {
  const plan = { stages: [{ subtasks: [{}, {}] }] }
  assert.ok(buildDispatchPreAnnouncement(plan).includes('预计执行约 15 分钟'))
  assert.equal(buildDispatchPreAnnouncement({ stages: [] }), '')
  assert.equal(buildDispatchPreAnnouncement({ stages: [{ subtasks: [] }] }), '')
})

test('A2 触发点顺序：P1 在 runPlanner 前；P2 在终态闸门后、模式分支前，且有幂等守卫', () => {
  const p1 = runtimeSource.indexOf('appendUserMessage(session, buildPlanningPreAnnouncement(')
  const planner = runtimeSource.indexOf('plan = await runPlanner(ctx, {')
  assert.ok(p1 > 0 && planner > p1, 'P1 必须先于 runPlanner')
  const terminalGate = runtimeSource.indexOf("code: superseded ? 'PLAN_SUPERSEDED' : 'PLAN_CANCELLED'")
  const p2 = runtimeSource.indexOf('if (record.preAnnouncedPlanId !== record.plan.planId)')
  const modeBranch = runtimeSource.indexOf("const mode = args?.mode === 'async' ? 'async' : 'wait'")
  assert.ok(terminalGate > 0 && p2 > terminalGate, 'P2 必须在终态拒绝闸门之后')
  assert.ok(modeBranch > p2, 'P2 必须先于 wait/async 模式分支（尚未启动子 Agent）')
  assert.ok(runtimeSource.includes('record.preAnnouncedPlanId = record.plan.planId'), '幂等守卫必须落标记')
  assert.ok(runtimeSource.includes('if (preAnnouncement) appendUserMessage(session, preAnnouncement)'), '预告经唯一合规写入器 appendUserMessage')
})

test('A3 提示词双保险与 schema 兼容锚点：新规则在首条规则后；effort 常量语义未变', () => {
  const firstRule = hostSource.indexOf('本会话已启用自动任务分解。')
  const newRule = hostSource.indexOf('分配任务前必须先告知预估耗时')
  assert.ok(firstRule >= 0 && newRule > firstRule)
  assert.ok(hostSource.includes('【规划预告】/【派发预告】'))
  assert.ok(Array.isArray(REASONING_EFFORTS) && REASONING_EFFORTS.length > 0)
  assert.ok(REASONING_EFFORTS.includes(DEFAULT_REASONING_EFFORT))
})
