import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChildPrompt, buildTeamBrief, dependencyResultBrief } from '../src/plan.js'
import { buildDelegateePrompt, planDelegations } from '../src/llm-rules.js'
import { buildExpertContextPacket } from '../src/context-packets.js'
import { collectCacheSessionIds } from '../src/runtime.js'

function makePlan() {
  const mk = (id: string, dependsOn: string[], objective: string, acceptance: string[]) => ({
    id,
    title: `${id} 任务`,
    department: id === 'T1' ? 'data' : 'writing',
    role: '专家',
    objective,
    method: ['读取输入', '产出结果'],
    inputs: ['输入'],
    outputs: [`${id.toLowerCase()}.md`],
    dependsOn,
    acceptance,
    qualityRequirements: ['给出命令输出'],
    risk: '低',
    estimateMinutes: 10,
    reasoningEffort: 'high',
  })
  const subtasks = [
    mk('T1', [], '产出数据表 /tmp/reports/T1/a.md', ['A1 文件存在且数值 42% 可复核']),
    mk('T2', ['T1'], '写报告并引用 /tmp/reports/T1/a.md', ['A1 引用路径正确', 'A2 数值 42% 一致']),
    mk('T3', [], '并行任务', ['A1 可复核']),
  ]
  return {
    version: 1,
    planId: 'wp-context-329',
    sessionId: 'session-329',
    title: '测试计划',
    taskAnchor: { text: '用户原要求：必须逐字保留 /tmp/reports/T1/a.md 与 42%。', sha256: 'b'.repeat(64) },
    taskUnderstanding: {
      originalRequest: '用户原要求：必须逐字保留 /tmp/reports/T1/a.md 与 42%。',
      deliverable: '一份报告',
      successCriteria: ['路径与数值一致'],
      constraints: ['不得改写用户锚点'],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
    },
    contradictions: { primary: { statement: '时间与质量' }, secondary: [], transformationConditions: [] },
    stages: [{ id: 'S1', name: '实施', goal: '完成', rationale: 'r', checkpoint: 'c', subtasks }],
  }
}

test('[3.2.9] 负责人任务书带上下文策略行，依赖摘要保留精确路径', () => {
  const plan = makePlan()
  const statuses = [
    { subtaskId: 'T1', status: 'done', summary: '产物 /tmp/reports/T1/a.md，命中率 42%，hash abcdef1234567890。', artifacts: [{ exists: true, ref: '/tmp/reports/T1/a.md' }] },
    { subtaskId: 'T2', status: 'pending', summary: '' },
    { subtaskId: 'T3', status: 'pending', summary: '' },
  ]
  const prompt = buildChildPrompt({
    plan,
    subtask: plan.stages[0].subtasks[1],
    stage: plan.stages[0],
    dependencyResults: [{ id: 'T1', title: 'T1 任务', status: 'done', summary: statuses[0].summary, artifacts: ['/tmp/reports/T1/a.md'] }],
    cwd: '/tmp',
    statuses,
  })
  assert.match(prompt, /【上下文策略｜/)
  const depBrief = dependencyResultBrief(statuses[0].summary)
  assert.ok(depBrief.includes('/tmp/reports/T1/a.md'), depBrief)
  assert.ok(depBrief.length <= 800)
})

test('[3.2.9] 专家任务书注入角色上下文包，且位于质量要求之前', () => {
  const packet = '【RCR 角色上下文包｜role=expert｜stage=execution】\n- 验收 A1：路径 /tmp/reports/T1/a.md'
  const prompt = buildDelegateePrompt({
    departmentLabel: '数据部',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '产出数据表',
    member: { member: '专家甲', role: 'expert', task: '产出数据表', qualityRequirements: ['给出命令输出'], effort: 'high' },
    rulesBrief: '【规则】',
    cwd: '/tmp',
    leadSessionId: 'leader-1',
    contextPacket: packet,
  })
  assert.ok(prompt.includes(packet))
  const packetIndex = prompt.indexOf('【RCR 角色上下文包')
  const qualityIndex = prompt.indexOf('质量要求')
  assert.ok(packetIndex >= 0)
  assert.ok(qualityIndex < 0 || packetIndex < qualityIndex, '静态上下文包应在质量要求之前')
})

test('[3.2.9] 跨源矛盾裁决 + 多人拆分被硬闸拒绝，给出单专家/direct 出路', () => {
  const result = planDelegations({
    model: 'deepseek-v4',
    parentTaskText: '两个来源的数据相互矛盾，需要最终裁决并统一口径。',
    singleStagePlan: true,
    consolidation: {
      taskReasoningEffort: 'high',
      assignments: [
        { member: '专家甲', role: 'expert', qualityRequirements: ['给出命令输出'], task: '读取来源一', effort: 'high' },
        { member: '专家乙', role: 'expert', qualityRequirements: ['给出命令输出'], task: '读取来源二', effort: 'high' },
      ],
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DELEGATE_COUPLED_SPLIT')
  assert.match(String(result.error), /1 名专家|direct/)
})

test('[3.2.9] 专家角色上下文包包含验收、依赖产物与硬事实', () => {
  const plan = makePlan()
  const statuses = [
    { subtaskId: 'T1', status: 'done', summary: '产物 /tmp/reports/T1/a.md，数值 42%。', artifacts: [{ exists: true, ref: '/tmp/reports/T1/a.md' }] },
    { subtaskId: 'T2', status: 'pending' },
  ]
  const packet = buildExpertContextPacket({
    plan,
    statuses,
    subtaskId: 'T2',
    member: '专家乙',
    cwd: '/tmp',
    stage: 'execution',
    lessonsBrief: '历史教训：先核对路径再写入。',
  })
  assert.match(packet, /RCR 角色上下文包/)
  assert.ok(packet.includes('A1') || packet.includes('验收'))
  assert.ok(packet.includes('/tmp/reports/T1/a.md'))
  assert.ok(packet.includes('历史教训'))
})


test('[3.2.9] 单一决策/共享可变状态同样被耦合闸拒绝', () => {
  for (const text of ['请在这两个方案中做最终决定', '多名专家同时写同一份配置台账']) {
    const result = planDelegations({
      model: 'deepseek-v4',
      parentTaskText: text,
      singleStagePlan: true,
      consolidation: {
        taskReasoningEffort: 'high',
        assignments: [
          { member: '专家甲', role: 'expert', qualityRequirements: ['给出命令输出'], task: '方案一', effort: 'high' },
          { member: '专家乙', role: 'expert', qualityRequirements: ['给出命令输出'], task: '方案二', effort: 'high' },
        ],
      },
    })
    assert.equal(result.ok, false, text)
    assert.equal(result.code, 'DELEGATE_COUPLED_SPLIT', text)
  }
})

test('[3.2.9] 数字密集型摘要仍守 800 字预算，且保留路径/哈希/数值', () => {
  const raw = Array.from({ length: 60 }, (_, i) => `第${i}项产物 /tmp/reports/T${i}/a.md，数值 ${i}%，hash ${String(i).padStart(8, '0')}abcdef。`).join('')
  const brief = dependencyResultBrief(raw)
  assert.ok(brief.length <= 800, `依赖摘要 ${brief.length} 字超过 800`)
  assert.ok(/\/tmp\/reports\/T0\/a\.md/.test(brief) || brief.includes('/tmp/reports/'), brief.slice(0, 200))
  assert.ok(/\d+%/.test(brief), '至少保留一个百分比精确值')
})

test('[3.2.9] 兄弟简报超总预算时逐行收缩，所有并行兄弟仍可见', () => {
  const plan = makePlan()
  const subtasks: any[] = []
  const statuses: any[] = []
  for (let i = 0; i < 12; i += 1) {
    subtasks.push({ id: `S${i}`, title: `兄弟${i}`, department: 'writing', objective: '并行任务', method: ['做'], outputs: [`s${i}.md`], dependsOn: [], acceptance: ['A1'], qualityRequirements: ['q'], risk: '低', estimateMinutes: 10, reasoningEffort: 'high' })
    statuses.push({ subtaskId: `S${i}`, status: i === 11 ? 'pending' : 'done', summary: Array.from({ length: 8 }, (_, j) => `路径 /tmp/s${i}-${j}.md 数值 ${j}%`).join('；'), artifacts: [] })
  }
  const plan2 = { ...plan, stages: [{ ...plan.stages[0], subtasks }] }
  const brief = buildTeamBrief(plan2, statuses, { id: 'T0', department: 'writing' }, new Set())
  assert.ok(brief.length <= 1500)
  for (let i = 0; i < 12; i += 1) {
    assert.ok(brief.includes(`S${i}`), `兄弟 S${i} 被整体丢弃：${brief}`)
  }
  assert.ok(brief.includes('S11') && /pending/.test(brief), 'pending 兄弟必须仍可见')
})

test('[3.2.9] status 缓存会话集合覆盖根/负责人/专家/历史 childId 且去重', () => {
  const record = {
    plan: { sessionId: 'root' },
    statuses: [
      { childId: 'head1', childIdHistory: [{ childId: 'head0' }], delegates: [{ childId: 'expert1' }, { childId: 'expert2' }] },
      { childId: 'head1', delegates: [{ childId: 'expert1' }] },
    ],
  }
  assert.deepEqual(collectCacheSessionIds(record).sort(), ['expert1', 'expert2', 'head0', 'head1', 'root'])
})

test('[3.2.9] 缺 stages 的损坏计划不阻断上下文包（fail-open 返回空串）', () => {
  const packet = buildExpertContextPacket({ plan: { planId: 'broken' }, statuses: [], subtaskId: 'T1', member: '专家甲' })
  assert.equal(packet, '')
})
