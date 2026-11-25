import test from 'node:test'
import assert from 'node:assert/strict'

import { assessIndependence, decideDelegationStrategy, renderDelegationStrategyLine } from '../src/context-strategy.js'

test('[3.2.9] 顺序推理链被判为强耦合，不得拆给多个独立专家', () => {
  const assessment = assessIndependence('先读取A全部结论，再基于上一步结论写入B，最后逐条核对')
  assert.equal(assessment.independent, false)
  assert.ok(assessment.signals.some((item) => item.id === 'sequential-chain'))
  const strategy = decideDelegationStrategy({
    taskText: '先读取A全部结论，再基于上一步结论写入B，最后逐条核对',
    memberCount: 4,
    taskEffort: 'high',
  })
  assert.notEqual(strategy.lane, 'split')
  assert.ok(strategy.couplingScore >= 3)
  assert.match(strategy.promptLine, /不得拆给多名独立专家|单通道/)
})

test('[3.2.9] 跨源矛盾裁决被判为强耦合，推荐负责人单通道或 1 名专家', () => {
  const strategy = decideDelegationStrategy({
    taskText: '两个来源的数据相互矛盾，需要最终裁决并统一口径；结论必须可复核。',
    memberCount: 5,
    taskEffort: 'high',
  })
  assert.ok(strategy.couplingScore >= 3, `耦合分应 >=3，实际 ${strategy.couplingScore}`)
  assert.notEqual(strategy.lane, 'split')
  assert.ok(strategy.signals.some((item) => item.id === 'cross-source-adjudication'))
  assert.match(renderDelegationStrategyLine(strategy), /上下文策略/)
})

test('[3.2.9] 明确独立并行的任务允许拆分，探索重的任务提示先派侦察', () => {
  const strategy = decideDelegationStrategy({
    taskText: '分别读取三个互不依赖的目录，各自汇总成一份清单；数据量很大，需要全量扫描。',
    memberCount: 3,
    taskEffort: 'high',
  })
  assert.equal(strategy.independent, true)
  assert.equal(strategy.lane, 'split')
  assert.equal(strategy.explorationHeavy, true)
  assert.match(strategy.promptLine, /侦察|简报/)
})

test('[3.2.9] 极简单动作不为了凑人数硬拆', () => {
  const strategy = decideDelegationStrategy({ taskText: '把 2 加 3 算出来', memberCount: 1, taskEffort: 'low' })
  assert.notEqual(strategy.lane, 'split')
  assert.equal(strategy.maxMembers, 1)
})

test('[3.2.9] 单一最终决策与共享可变状态都达到强耦合阈值，不再被误判为可拆分', () => {
  for (const text of ['请在这两个方案中做最终决定', '多名专家同时写同一份配置台账']) {
    const strategy = decideDelegationStrategy({ taskText: text, memberCount: 3, taskEffort: 'high' })
    assert.ok(strategy.couplingScore >= 3, `${text} 耦合分应 >=3，实际 ${strategy.couplingScore}`)
    assert.notEqual(strategy.lane, 'split', `${text} 不应被判为可拆分`)
    assert.equal(strategy.independent, false)
  }
})

test('[3.2.9] 无明确耦合/独立信号时保守判为单通道，而不是默认独立', () => {
  const strategy = decideDelegationStrategy({ taskText: '整理一份季度复盘报告并给出下一步建议', memberCount: 3, taskEffort: 'high' })
  assert.equal(strategy.independent, false)
  assert.notEqual(strategy.lane, 'split')
})

test('[3.2.9] low 档不得先教拆分：策略行必须是负责人 direct/禁止下派', () => {
  const strategy = decideDelegationStrategy({
    taskText: '分别整理三个互不依赖的目录，各自汇总成清单',
    memberCount: 3,
    taskEffort: 'low',
  })
  assert.equal(strategy.lane, 'leader-direct')
  assert.equal(strategy.maxMembers, 1)
  assert.match(strategy.promptLine, /禁止下派|亲自执行/)
})
