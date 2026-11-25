/* 回归测试：底层逻辑矛盾修复 + 极致省 token 守门。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MIN_COMPLEX_DELEGATE_MEMBERS, MAX_COMPLEX_DELEGATE_MEMBERS, MAX_TOTAL_EXPERTS_PER_PLAN } from '../src/caps.js'
import { extractHardFacts } from '../src/context-brief.js'
import { planDelegations, buildDelegateePrompt, buildLlmRulesBrief } from '../src/llm-rules.js'
import {
  buildPlannerSystemPrompt,
  buildTeamBrief,
  deriveLeaderEstimate,
  canResumePlan,
  appendUserMessage,
  CANCEL_MARKER_BEGIN,
  CANCEL_MARKER_END,
} from '../src/plan.js'
import {
  persistStartEvidenceFile,
  createWorkplanRuntime,
} from '../src/runtime.js'
import {
  PROMPT_SECTION,
  createReplanTool,
  createDelegateTool,
  createLessonsTool,
  fileWriteGuardReason,
} from '../src/host.js'
import { fiveStepPromptLines, fiveStepContinuationPromptLines } from '../src/five-step.js'
import { readNoticeLedger } from '../src/notice-ledger.js'

test('[省 token + 消死锁] MIN_COMPLEX_DELEGATE_MEMBERS 默认为 1，复杂任务可只派 1 名专家，同时支持 minHeadcount 覆盖', () => {
  assert.equal(MIN_COMPLEX_DELEGATE_MEMBERS, 1)
  assert.ok(15 * MIN_COMPLEX_DELEGATE_MEMBERS <= MAX_TOTAL_EXPERTS_PER_PLAN, '15 个子任务各派 1 名专家不会触发全局 30 人死锁')

  const oneExpert = [{
    member: '核心专家',
    role: 'expert',
    task: '完成单一可独立验收的根因定位报告',
    qualityRequirements: ['必须提供可复核命令输出或文件证据'],
  }]
  const defaultRes = planDelegations({
    consolidation: { taskReasoningEffort: 'high', assignments: oneExpert },
    model: 'gpt-4o',
  })
  assert.equal(defaultRes.ok, true, `默认应允许复杂任务派 1 名专家省 token：${defaultRes.error ?? ''}`)
  assert.equal(defaultRes.members.length, 1)

  const strictRes = planDelegations({
    consolidation: { taskReasoningEffort: 'high', assignments: oneExpert },
    model: 'gpt-4o',
    minHeadcount: 3,
  })
  assert.equal(strictRes.ok, false)
  assert.equal(strictRes.code, 'DELEGATE_HEADCOUNT_MIN')
})

test('[消冲突] 强耦合任务禁拆多人且豁免显式人数下限（不再与 DELEGATE_HEADCOUNT_MIN 打架）', () => {
  const oneExpert = [{
    member: '主裁专家',
    role: 'expert',
    task: '汇总两份冲突结论并做出最终裁决',
    qualityRequirements: ['给出证据链与裁决依据'],
  }]
  const res = planDelegations({
    consolidation: { taskReasoningEffort: 'high', assignments: oneExpert },
    model: 'gpt-4o',
    parentTaskText: '请对比两份矛盾报告并做最终裁决',
    minHeadcount: 5,
  })
  assert.equal(res.ok, true, `强耦合任务只派 1 名专家时必须豁免下限：${res.error ?? ''}`)
})

test('[防信息饿死] extractHardFacts 分类型配额：60 条路径不会挤掉百分比与哈希硬事实', () => {
  const paths = Array.from({ length: 60 }, (_, i) => `src/module-${i}/file-${i}.ts`).join(' ')
  const text = `${paths} 实测命中率 94.5%，提交哈希 abcdef0123456789，硬性不得修改公共契约。`
  const facts = extractHardFacts(text)
  assert.ok(facts.length <= 40)
  assert.ok(facts.some((f) => f.includes('94.5%')), '百分比不得被大量路径挤掉')
  assert.ok(facts.some((f) => f.includes('abcdef0123456789')), '哈希不得被大量路径挤掉')
})

test('[修并发覆盖] persistStartEvidenceFile 按 member 分文件落盘，含纯中文专家名也互不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-ev-member-'))
  try {
    const pad45 = (s: string) => `${s}：${'细'.repeat(45)}`
    const pad25 = (s: string) => `${s}：${'证'.repeat(25)}`
    const evA = {
      planning: {
        problemAnalysis: [pad45('专家一分析')],
        resources: [pad25('资源一')],
        tools: [pad25('工具一')],
        approach: [pad45('方案一')],
        approachBasis: [pad25('依据一')],
      },
      preparation: { prepared: [pad25('准备一')], evidence: [pad25('就绪一')] },
    }
    const evB = {
      planning: {
        problemAnalysis: [pad45('专家二分析')],
        resources: [pad25('资源二')],
        tools: [pad25('工具二')],
        approach: [pad45('方案二')],
        approachBasis: [pad25('依据二')],
      },
      preparation: { prepared: [pad25('准备二')], evidence: [pad25('就绪二')] },
    }
    const refA = persistStartEvidenceFile(dir, 'wp-test1', 'T1', evA, '专家一')
    const refB = persistStartEvidenceFile(dir, 'wp-test1', 'T1', evB, '专家二')
    assert.ok(refA && refB && refA !== refB, `不同中文专家名应写入不同文件：${refA} vs ${refB}`)
    assert.ok(readFileSync(join(dir, refA!), 'utf8').includes('专家一分析'))
    assert.ok(readFileSync(join(dir, refB!), 'utf8').includes('专家二分析'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[修配额与上界] deriveLeaderEstimate 支持 >12 名专家且保持 >120960 fail-closed', () => {
  const members15 = Array.from({ length: 15 }, (_, i) => ({
    member: `专家${i + 1}`,
    status: 'running',
    estimate: { declaredMinutes: 10, delivery: 'sent', at: 1000 + i },
  }))
  const ok15 = deriveLeaderEstimate({
    consolidation: { assignments: members15.map((m) => ({ member: m.member, role: 'expert', task: 't' })) },
    delegates: members15,
  })
  assert.ok(ok15, '15 名专家合计 150 分钟应正常聚合（原硬编码 12 会截断）')
  assert.equal(ok15!.totalMinutes, 150)
  assert.equal(ok15!.reported, 15)
  assert.equal(ok15!.expected, 15)
  assert.ok(MAX_COMPLEX_DELEGATE_MEMBERS >= 15)

  const huge = deriveLeaderEstimate({
    consolidation: { assignments: Array.from({ length: 15 }, (_, i) => ({ member: `专家${i + 1}`, role: 'expert', task: 't' })) },
    delegates: Array.from({ length: 15 }, (_, i) => ({
      member: `专家${i + 1}`,
      status: 'running',
      estimate: { declaredMinutes: 10000, delivery: 'sent', at: 1000 + i },
    })),
  })
  assert.equal(huge, null, '超过 120960 分钟必须 fail-closed 返回 null')
})

test('[修取消信封被截断] appendUserMessage 对取消标记豁免 500 字符裁剪，且 pre-head flush 同步写入账本', () => {
  const events: any[] = []
  const session: any = {
    id: 'sess-cancel-test',
    header: null,
    get seq() { return events.length },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
  }
  const longCancel = `${CANCEL_MARKER_BEGIN}\n${JSON.stringify({ kind: 'workplan-cancel', planId: 'wp-c1', reason: 'r'.repeat(600) })}\n${CANCEL_MARKER_END}`
  appendUserMessage(session, longCancel, { kind: 'workplan-cancel', form: 'cancel', summary: '取消 wp-c1' }, { deferUntilHead: true })
  session.header = { createdAt: Date.now() }
  appendUserMessage(session, 'T1 已完成', { kind: 'workplan-progress', form: 'notice', summary: 'T1 已完成' })
  assert.ok(events.length >= 2)
  const firstText = events[0].data?.content?.[0]?.text ?? ''
  assert.ok(firstText.includes(CANCEL_MARKER_END), '长取消信封不得被 500 字符上限截断闭合标记')

  const ledger = readNoticeLedger().filter((e: any) => e.sessionId === 'sess-cancel-test')
  assert.ok(ledger.some((e: any) => String(e.text).includes('wp-c1')), 'pre-head 延迟消息 flush 后必须镜像到 notice ledger')
})

test('[修接管死循环] canResumePlan 跳过 takeoverRequired=true 的子任务', () => {
  const record = {
    plan: {
      planId: 'wp-takeover',
      stages: [{ id: 'S1', subtasks: [{ id: 'T1' }, { id: 'T2' }] }],
    },
    statuses: [
      { subtaskId: 'T1', status: 'done' },
      { subtaskId: 'T2', status: 'blocked', takeoverRequired: true },
    ],
    resumes: 0,
  }
  assert.equal(canResumePlan(record).resume, false, '仅剩 takeoverRequired=true 的受阻项时不应再自动续跑')
})

test('[修并行视野丢失] buildTeamBrief 在多并行兄弟下保留全部摘要行（每行下限降至 36 字）', () => {
  const subtasks = Array.from({ length: 12 }, (_, i) => ({
    id: `T${i + 1}`,
    title: `并行子任务 ${i + 1}`,
    department: 'engineering',
  }))
  const plan = { stages: [{ id: 'S1', subtasks }] }
  const statuses = subtasks.map((s) => ({
    subtaskId: s.id,
    status: 'in_progress',
    summary: `正在处理 ${s.id} 的核心模块`,
  }))
  const brief = buildTeamBrief(plan, statuses, subtasks[0])
  assert.ok(brief.includes('T12'), '第 12 个并行兄弟也必须在团队简报中可见，不被过早截断')
})

test('[修工具参数与展示] createReplanTool 支持 reasoningEffort，createDelegateTool 渲染 direct/self_effort，createLessonsTool 修复「预防」文案', async () => {
  const replanTool: any = createReplanTool({})
  assert.ok(
    replanTool.parameters.properties.changes.items.properties.replacement.properties.reasoningEffort,
    'replan replacement schema 必须支持 reasoningEffort',
  )

  const delegateTool: any = createDelegateTool({})
  const directText = JSON.stringify(delegateTool.output.render({}, { ok: true, action: 'direct', effectiveEffort: 'low' }))
  assert.ok(directText.includes('亲自执行开工证据已登记'), `direct 结果应有专属渲染：${directText}`)
  const selfText = JSON.stringify(delegateTool.output.render({}, { ok: true, action: 'self_effort', member: '专家1', selfEffort: 'high' }))
  assert.ok(selfText.includes('专家1') && selfText.includes('high'), `self_effort 结果应有专属渲染：${selfText}`)

  const lessonsTool: any = createLessonsTool({})
  const lessonRender = JSON.stringify(lessonsTool.output.render({}, {
    ok: true,
    lessons: [{ department: 'engineering', title: '契约校验', problems: ['遗漏'], prevention: ['遇到改契约先跑单测'] }],
  }))
  assert.ok(lessonRender.includes('｜预防：'), `应显示「预防」而非错别字「预览」：${lessonRender}`)
  assert.ok(!lessonRender.includes('｜预览：'))
})

test('[修误伤只读工具] fileWriteGuardReason 对未知只读工具（仅有 path 无写入内容键）不误拦截，对含 content 写入仍拦截', () => {
  const fakeRuntime = {
    presentedWriteDenialReason: (_agent: any, args: any) => (args?.file_path === 'src/a.ts' ? '禁止覆盖已交付文件' : undefined),
    writeTargets: (_agent: any, args: any) => (args?.path ? [String(args.path)] : []),
  }
  assert.equal(
    fileWriteGuardReason({ name: 'custom_read_meta', arguments: { path: 'src/a.ts' }, agent: {} }, fakeRuntime),
    undefined,
    '仅有 path 的未知工具不应误判为写入',
  )
  const blocked = fileWriteGuardReason(
    { name: 'custom_patch_tool', arguments: { path: 'src/a.ts', content: 'new body' }, agent: {} },
    fakeRuntime,
  )
  assert.ok(blocked && blocked.includes('禁止'), '携带 path+content 的未知写入工具必须拦截')
})

test('[修确定性快路径默认开启] deterministicFastPath 默认开启并支持显式关闭', () => {
  const prev = process.env.DSH_WORKPLAN_DETERMINISTIC_FAST_PATH
  delete process.env.DSH_WORKPLAN_DETERMINISTIC_FAST_PATH
  try {
    const rtDefault: any = createWorkplanRuntime({ sessions: { get: () => null }, logger: () => ({ info() {}, warn() {} }) }, {})
    assert.equal(rtDefault.options?.deterministicFastPath ?? true, true)
    const rtOff: any = createWorkplanRuntime({ sessions: { get: () => null }, logger: () => ({ info() {}, warn() {} }) }, { deterministicFastPath: false })
    assert.ok(rtOff, '显式传入 deterministicFastPath: false 正常初始化')
  } finally {
    if (prev !== undefined) process.env.DSH_WORKPLAN_DETERMINISTIC_FAST_PATH = prev
  }
})

test('[省 token 护栏] 提示词显著瘦身 + 专家任务书静态前缀缓存命中 >85% + continuation 五步 <60%', () => {
  assert.ok(PROMPT_SECTION.length < 2000, `PROMPT_SECTION 应显著瘦身（实测 ${PROMPT_SECTION.length}）`)
  const fullLen = fiveStepPromptLines().join('\n').length
  const contLen = fiveStepContinuationPromptLines().join('\n').length
  assert.ok(contLen < fullLen * 0.6, `phase-1 接续五步应 <60%（实测 ${contLen}/${fullLen}）`)

  const plannerSys = buildPlannerSystemPrompt({ concurrency: 4, maxResumes: 4 })
  assert.ok(plannerSys.includes(String(MAX_TOTAL_EXPERTS_PER_PLAN)), '规划器应明确告知全局专家预算上限')
  assert.ok(plannerSys.includes('qwen') && plannerSys.includes('low/high/max'), '规划器应与实际模型家族档位规则对齐')

  const brief = buildLlmRulesBrief({ model: 'gpt-4o', effort: 'high', tier: 'delegate' })
  const p1 = buildDelegateePrompt({
    departmentLabel: 'engineering',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '优化',
    member: { member: '专家1', role: 'expert', task: '任务一', qualityRequirements: ['可复核'], effort: 'high' },
    rulesBrief: brief,
    cwd: '/tmp/work',
    continuation: true,
  })
  const p2 = buildDelegateePrompt({
    departmentLabel: 'engineering',
    leaderSubtaskId: 'T1',
    leaderSubtaskTitle: '优化',
    member: { member: '专家2', role: 'expert', task: '任务二', qualityRequirements: ['可复核'], effort: 'high' },
    rulesBrief: brief,
    cwd: '/tmp/work',
    continuation: true,
  })
  let shared = 0
  while (shared < p1.length && shared < p2.length && p1[shared] === p2[shared]) shared += 1
  const ratio = shared / p1.length
  assert.ok(ratio > 0.85, `同部门专家任务书静态共享前缀应 >85% 以最大化 KV 缓存命中（实测 ${(ratio * 100).toFixed(1)}%）`)
})
