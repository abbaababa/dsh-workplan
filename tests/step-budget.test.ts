/* [3.2.4][步数预算] 步数预算：解析表、判定边界、会话步数计数、失败上下文拼接。 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_STEP_BUDGET,
  STEP_BUDGET_ENV,
  budgetFailureContext,
  countAssistantSteps,
  judgeStepBudget,
  parseStepBudget,
} from '../src/step-budget.js'

const anchor = setInterval(() => {}, 1_000)
const release = setTimeout(() => clearInterval(anchor), 60_000)
release.unref?.()
after(() => clearInterval(anchor))

function fakeSession(events: Array<{ type: string }>) {
  let seq = 0
  return {
    get seq() { return seq },
    bump() { seq += 1 },
    eventAt(i: number) { return events[i] ?? null },
  }
}

test('parseStepBudget：缺省 ⇒ 默认开启（软 60/硬 75）', () => {
  const cfg = parseStepBudget(undefined)
  assert.equal(cfg.soft, DEFAULT_STEP_BUDGET)
  assert.equal(cfg.hard, Math.ceil(DEFAULT_STEP_BUDGET * 1.25))
  assert.equal(parseStepBudget('').soft, DEFAULT_STEP_BUDGET)
  assert.equal(parseStepBudget('   ').soft, DEFAULT_STEP_BUDGET)
})

test('parseStepBudget：0/false/off ⇒ 完全关闭', () => {
  for (const raw of ['0', 'false', 'off', 'OFF', 'False']) {
    const cfg = parseStepBudget(raw)
    assert.equal(cfg.soft, null, raw)
    assert.equal(cfg.hard, 0, raw)
  }
})

test('parseStepBudget：正整数 ⇒ 软 n/硬 ceil(n*1.25)；非法 ⇒ 默认', () => {
  assert.deepEqual(parseStepBudget('45'), { soft: 45, hard: Math.ceil(45 * 1.25) })
  assert.deepEqual(parseStepBudget('1'), { soft: 1, hard: 2 })
  // '1e2' 经 Number() 是合法正整数 100 —— 接受（宽松解析不制造惊喜）。
  assert.deepEqual(parseStepBudget('1e2'), { soft: 100, hard: 125 })
  for (const raw of ['abc', '0.5', '-3']) {
    const cfg = parseStepBudget(raw)
    assert.equal(cfg.soft, DEFAULT_STEP_BUDGET, raw)
  }
})

test('parseStepBudget：环境变量名未变（防漂移）', () => {
  assert.equal(STEP_BUDGET_ENV, 'DSH_WORKPLAN_STEP_BUDGET')
})

test('judgeStepBudget：边界（soft-1/soft/hard-1/hard）', () => {
  const cfg = { soft: 60, hard: 75 }
  assert.equal(judgeStepBudget(0, cfg).level, 'ok')
  assert.equal(judgeStepBudget(59, cfg).level, 'ok')
  assert.equal(judgeStepBudget(60, cfg).level, 'soft')
  assert.equal(judgeStepBudget(74, cfg).level, 'soft')
  assert.equal(judgeStepBudget(75, cfg).level, 'hard')
  assert.equal(judgeStepBudget(200, cfg).level, 'hard')
  // 关闭 ⇒ 永远 ok
  assert.equal(judgeStepBudget(999, { soft: null, hard: 0 }).level, 'ok')
})

test('countAssistantSteps：只数 assistant/message，afterSeq 之前的不算', () => {
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
    { type: 'assistant/message' },
    { type: 'turn/end' },
    { type: 'user/message' },
    { type: 'assistant/message' },
  ]
  const session = fakeSession(events)
  session.bump(); session.bump(); session.bump(); session.bump(); session.bump(); session.bump(); session.bump()
  assert.equal(session.seq, 7)
  assert.equal(countAssistantSteps(session, 0), 3)
  // 从 seq 3 起数 ⇒ 只有 seq 3 与 seq 6 两条 assistant
  assert.equal(countAssistantSteps(session, 3), 2)
  // 从 seq 5 起数 ⇒ 只有 seq 6 一条
  assert.equal(countAssistantSteps(session, 5), 1)
})

test('countAssistantSteps：countCap 提前止损；会话异常 ⇒ 0（fail-open）', () => {
  const events = Array.from({ length: 50 }, (_v, i) => ({ type: i % 2 === 0 ? 'assistant/message' : 'user/message' }))
  const session = fakeSession(events)
  for (let i = 0; i < 50; i += 1) session.bump()
  // 50 个事件里偶数位是 assistant ⇒ 25 条
  assert.equal(countAssistantSteps(session, 0), 25)
  assert.equal(countAssistantSteps(session, 0, 10), 10)
  assert.equal(countAssistantSteps(null, 0), 0)
  assert.equal(countAssistantSteps({ seq: 0, eventAt: () => null }, 0), 0)
  assert.equal(countAssistantSteps({ eventAt: () => { throw new Error('boom') }, seq: 5 }, 0), 0)
})

test('budgetFailureContext：关闭 ⇒ 空串；有产物 ⇒ 附收编说明；超硬上限 ⇒ 标注', () => {
  const off = { soft: null, hard: 0 }
  assert.equal(budgetFailureContext(80, off, []), '')
  const cfg = { soft: 60, hard: 75 }
  assert.equal(
    budgetFailureContext(50, cfg, []),
    '步数预算：本会话 50 步（软 60/硬 75）',
  )
  const withRefs = budgetFailureContext(80, cfg, ['reports/wp-member-A-t4.json'])
  assert.ok(withRefs.includes('已超硬上限'), withRefs)
  assert.ok(withRefs.includes('reports/wp-member-A-t4.json'), withRefs)
  assert.ok(withRefs.includes('勿按零产出重做'), withRefs)
})

test('build 指纹覆盖全部已加载模块（含 step-budget.js）', async () => {
  /*
   * [3.2.4] 回归 1.8.15 的假阴性：手写清单漏掉新模块时，改模块而指纹不变。
   * 这里直接对 lib/ 目录复算 host.js 里同一套枚举规则，断言 step-budget.js
   * 在集合内——新增模块若再被漏掉，这条会失败。
   */
  const { readdirSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const hostSrc = (await import('node:fs')).readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'host.ts'),
    'utf8',
  )
  assert.ok(hostSrc.includes('readdirSync(dir)'), '指纹必须按目录枚举模块，不能回退手写清单')
  assert.ok(hostSrc.includes("name !== 'client.js'"), 'client.js 是浏览器 bundle，不参与服务端指纹')
  const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib')
  const modules = readdirSync(libDir).filter((name: string) => name.endsWith('.js') && name !== 'client.js').sort()
  assert.ok(modules.includes('step-budget.js'), 'step-budget.js must be covered by the build fingerprint')
  assert.ok(modules.includes('host.js') && modules.includes('runtime.js'), 'entry modules must stay covered')
})
