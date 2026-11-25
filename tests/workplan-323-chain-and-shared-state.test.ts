/* [3.2.3] 顺序推理链不拆 + 共享可变状态串行：根治性守门测试。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { detectSequentialChainTask } from '../src/v3-contract.js'
import { planDelegations } from '../src/llm-rules.js'
import { sharedStateKeysForSubtask, withSharedStateLocks } from '../src/runtime.js'

const QUALITY = ['必须给出可复现的命令输出作为证据']
const CONSOLIDATION = {
  taskReasoningEffort: 'high',
  approachBasis: ['第二轮先只读取证再动手。'],
}
const ATOMIC_TASK = '分析 src/plan.ts 得出根因结论'
const EIGHT = Array.from({ length: 8 }, (_, i) => ({
  member: `专家${i + 1}`,
  role: 'expert' as const,
  task: ATOMIC_TASK,
  qualityRequirements: QUALITY,
}))

test('顺序链检测：抓顺序连接词，不误伤单项任务', () => {
  assert.equal(detectSequentialChainTask('先读取日志再更新配置').sequential, true)
  assert.equal(detectSequentialChainTask('基于上一步结论继续推导').sequential, true)
  assert.equal(detectSequentialChainTask('逐步排查并汇总结论').sequential, true)
  assert.deepEqual(detectSequentialChainTask('修复按钮颜色'), { sequential: false, markers: [] })
})

test('planDelegations：链式父任务禁止拆给多名独立专家', () => {
  const result = planDelegations({
    model: 'deepseek-chat',
    consolidation: { ...CONSOLIDATION, assignments: EIGHT },
    parentTaskText: '先读取三份日志，再基于上一步结论更新配置',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_SEQUENTIAL_CHAIN_SPLIT')
  assert.match(String(result.error), /独立专家/)
})

test('planDelegations：链式任务豁免 ≥8 人下限，1 名专家可放行', () => {
  const result = planDelegations({
    model: 'deepseek-chat',
    consolidation: { ...CONSOLIDATION, assignments: EIGHT.slice(0, 1) },
    parentTaskText: '先读取三份日志，再基于上一步结论更新配置',
  })
  assert.equal(result.ok, true, result.ok ? '' : String(result.error))
})

test('planDelegations：配置下限时非链式复杂任务 1 人仍被 HEADCOUNT_MIN 拒（豁免不扩大）', () => {
  const result = planDelegations({
    model: 'deepseek-chat',
    consolidation: { ...CONSOLIDATION, assignments: EIGHT.slice(0, 1) },
    parentTaskText: ATOMIC_TASK,
    minHeadcount: 3,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('planDelegations：非链式父任务保持原有派发语义', () => {
  const result = planDelegations({
    model: 'deepseek-chat',
    consolidation: { ...CONSOLIDATION, assignments: EIGHT },
    parentTaskText: ATOMIC_TASK,
  })
  assert.equal(result.ok, true, result.ok ? '' : String(result.error))
})

test('sharedStateKeysForSubtask：相对/绝对路径归一、去重、含 inputs', () => {
  const keys = sharedStateKeysForSubtask({
    outputs: ['reports/a.json', '/tmp/b.json', 'reports/a.json'],
    inputs: ['/tmp/b.json', 'src/c.ts'],
  }, '/work')
  assert.deepEqual(keys, ['/tmp/b.json', '/work/reports/a.json', '/work/src/c.ts'])
})

test('withSharedStateLocks：无重叠键仍并发，重叠键严格串行', async () => {
  const scope = {}
  const started: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

  const first = withSharedStateLocks(scope, ['/shared/file.md'], async () => {
    started.push('first')
    await firstGate
    return 1
  })
  const second = withSharedStateLocks(scope, ['/shared/file.md'], async () => {
    started.push('second')
    return 2
  })
  const unrelated = withSharedStateLocks(scope, ['/other/file.md'], async () => {
    started.push('other')
    return 3
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(started, ['first', 'other'])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second, unrelated]), [1, 2, 3])
})
