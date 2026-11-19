/*
 * [3.1.1] 跨会话登记缺陷治本——结算自动归并 + 登记原文回注（2026-11-19）。
 *
 * 缺陷现场（计划 wp-b26c6d56，T2/T3）：部门负责人在自己的会话经
 * action="direct" 代登记开工证据（T2 problemAnalysis 8 条/1242 字），平台另开
 * 全新执行会话承接——接续提示只转述「已登记」，登记逐字原文从未进入交卷人
 * 上下文；执行者凭任务书重写更短摘要（6 条/471 字）→ 结算闸开工-结算一致性
 * 比对（checkStartEvidenceCarryover）判「变薄」→ EVIDENCE_INCOMPLETE 退回；
 * 重试只回数字不回原文，补报退化成凑字数游戏（重试会话自述 "I don't have the
 * exact startPhases text"）。
 *
 * 本文件钉死修复契约：
 *  M1 归并=并集：交卷条目在前、登记条目按原序补入、逐字去重、封顶 20 条；
 *  M2 归并封顶：并集超 MAX_PHASE_LIST_ITEMS 时截断，截断可被一致性比对检出；
 *  M3 归并幂等：登记为空 ⇒ 交卷原样返回；
 *  A1 薄交卷+登记 ⇒ 判 done 且落账 phases 含登记条目（旧实现必 blocked）；
 *  A2 零回归：五步证据本身不完整（缺 preparation）⇒ 即使有登记也判 blocked；
 *  A3 封顶截断 ⇒ 登记条目装不下 ⇒ 仍判 blocked（比对作安全网保留）；
 *  P1 phase-1 接续提示回注登记原文（buildPhaseZeroContinuationHint 第 4 参）；
 *  P2 回喂消息回注登记原文（buildChildPrompt previousFailure.registeredStartPhases）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  EVIDENCE_MARKER_BEGIN,
  EVIDENCE_MARKER_END,
  adjudicateResult,
  buildChildPrompt,
  buildPhaseZeroContinuationHint,
  buildPlanMessage,
} from '../src/plan.js'
import {
  MAX_PHASE_LIST_ITEMS,
  mergeStartEvidenceIntoSettlement,
  renderStartPhaseEvidence,
  sanitizeStartPhaseEvidence,
  validateStartPhaseEvidence,
  type FiveStepPhases,
  type StartPhaseEvidence,
} from '../src/five-step.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { seedLeaderSelfEffort } from './helpers/self-effort-contract.js'
import { MAIN_START_PHASES_FIXTURE } from './helpers/main-deep-think.js'

process.env.DSH_WORKPLAN_LESSONS_FILE = join(
  tmpdir(),
  `t11-start-evidence-merge-lessons-${process.pid}.jsonl`,
)

/* ------------------------------------------------------------ 夹具构造 */

/** 长登记条目（模拟 T2 现场：负责人登记的单条实测证据）。 */
const LONG_REGISTERED_ITEM =
  '21:02 实测腾讯快照 0.454：登录 f10 行情接口取 159667 工业母机ETF 实时净值，与收盘价偏离在阈值内，数据源可用，作为后续盯盘基准。'

function registeredFixture(): StartPhaseEvidence {
  const check = validateStartPhaseEvidence({
    planning: {
      problemAnalysis: [LONG_REGISTERED_ITEM, '第二条登记：任务边界与依赖已在开工时由负责人逐条理清并登记在案。'],
      approach: ['登记的方法：先核对数据源可用性 → 再按依赖顺序跑主流程 → 最后逐条对照验收标准交付并留证。'],
      approachBasis: ['登记依据：数据源约束决定先验证再动手，边界决定不扩大范围。'],
      resources: ['登记资源：任务书、验收标准清单与会话通道均已确认具备。'],
      tools: ['登记工具：终端命令、浏览器与测试运行器。'],
    },
    preparation: {
      prepared: ['登记已备：工作目录可读写，依赖已安装，任务书已核对。'],
      evidence: ['登记证据：pwd 与 ls 输出正常，node -v 可运行。'],
    },
  })
  assert.equal(check.ok, true, `登记夹具须过开工闸：${check.error ?? ''}`)
  return check.evidence as StartPhaseEvidence
}

/**
 * 薄交卷 phases（模拟缺陷现场）：除了 problemAnalysis 用一条远短于登记的
 * 摘要重写外，其余字段均满足结算闸下限——旧实现在此必被 carryover 判「变薄」。
 */
function thinSettlementFixture(): FiveStepPhases {
  return {
    version: 4,
    planning: {
      problemAnalysis: ['任务梳理：目标与验收已明确；现状是计划已生成待执行；约束是不重复做已完成工作；边界是只做本任务。'],
      constraints: [],
      unknowns: [],
      approach: ['按任务书执行：先准备环境与依赖，再按依赖顺序实现各模块，最后运行测试逐条验收并留证存档。'],
      approachBasis: ['依据任务书要求：验收标准决定先实现后验证的顺序。'],
      resources: ['现有代码库、任务书、验收标准清单与测试运行环境均已具备。'],
      tools: ['TypeScript 编译器与 node 测试运行器。'],
    },
    preparation: {
      prepared: ['源文件、依赖与测试环境已准备就绪可复用。'],
      evidence: ['node -v 输出正常，node --test 可启动。'],
    },
    execution: { steps: ['完成实现并自检'], deviations: [] },
    verification: {
      allPassed: true,
      checks: [{ criterion: '通道可用', method: 'node --test', evidence: 'pass 输出' }],
      requirementCheck: '逐条核对通过',
      retrospective: {
        problems: ['现象：执行顺利无异常；根因：开工登记已覆盖全部前置梳理，按蓝图执行即可。'],
        detours: [],
        resolutions: ['按开工登记的方法蓝图逐步执行，遇到不确定处先核对登记内容再动手。'],
        prevention: ['遇到不确定先查开工登记原文与历史教训，验证后再动手。'],
      },
    },
  }
}

function outputWithPhases(phases: any) {
  const payload = {
    status: 'done',
    blockedReason: '',
    phases,
    acceptance: [{ criterion: '通道可用', result: 'pass', evidence: 'node --test pass 输出' }],
    artifacts: [],
    needs: [],
    question: '',
    options: [],
  }
  return `做完了。\n${EVIDENCE_MARKER_BEGIN}\n${JSON.stringify(payload)}\n${EVIDENCE_MARKER_END}`
}

/* ------------------------------------------------------------ 纯函数闸 */

test('M1：归并=并集——交卷在前、登记按原序补入、逐字去重', () => {
  const settlement: any = {
    planning: {
      problemAnalysis: ['交卷补充 A'],
      approach: ['交卷步骤 1'],
      approachBasis: [],
      resources: ['  登记资源：任务书、验收标准清单与会话通道均已确认具备。  '], // trim 后与登记逐字同 → 去重
      tools: [],
    },
    preparation: { prepared: [], evidence: [] },
  }
  const registered = sanitizeStartPhaseEvidence(registeredFixture()) as StartPhaseEvidence
  const merged = mergeStartEvidenceIntoSettlement(settlement, registered)
  assert.deepEqual(merged.planning.problemAnalysis, [
    '交卷补充 A',
    LONG_REGISTERED_ITEM,
    '第二条登记：任务边界与依赖已在开工时由负责人逐条理清并登记在案。',
  ], '交卷条目在前、登记条目按登记原序补入')
  assert.deepEqual(merged.planning.resources, ['  登记资源：任务书、验收标准清单与会话通道均已确认具备。  '],
    'trim 后逐字相同的登记条目不得重复落账')
  assert.equal(merged.planning.approach.length, 2, '登记方法并入交卷方法之后')
  assert.equal(merged.preparation.prepared.length, 1, '登记的已备清单并入空交卷')
})

test('M2：归并封顶——并集超上限截断到 MAX_PHASE_LIST_ITEMS', () => {
  const settlement: any = {
    planning: {
      problemAnalysis: Array.from({ length: 5 }, (_, i) => `交卷条目 ${i}`),
      approach: [],
      approachBasis: [],
      resources: [],
      tools: [],
    },
    preparation: { prepared: [], evidence: [] },
  }
  const registered: StartPhaseEvidence = sanitizeStartPhaseEvidence({
    planning: {
      problemAnalysis: Array.from({ length: MAX_PHASE_LIST_ITEMS }, (_, i) => `登记条目-${String(i).padStart(2, '0')}：开工时登记的梳理内容，逐字落账。`),
      approach: ['登记方法：先核对输入数据可用性，再按依赖顺序执行主流程，最后逐条对照验收标准交付并留证。'],
      approachBasis: ['登记依据：数据源约束决定先验证再动手，边界决定不扩大范围。'],
      resources: ['登记资源：任务书、验收标准清单与会话通道均已确认具备。'],
      tools: ['登记工具：终端命令、浏览器与测试运行器。'],
    },
    preparation: {
      prepared: ['登记已备：工作目录可读写，依赖已安装，任务书已核对。'],
      evidence: ['登记证据：pwd 与 ls 输出正常，node -v 可运行。'],
    },
  }) as StartPhaseEvidence
  const merged = mergeStartEvidenceIntoSettlement(settlement, registered)
  assert.equal(merged.planning.problemAnalysis.length, MAX_PHASE_LIST_ITEMS,
    '并集封顶 20 条：5 交卷 + 15 登记，后 5 条登记被截断')
  assert.equal(merged.planning.problemAnalysis[0], '交卷条目 0', '截断不得丢交卷条目')
})

test('M3：归并幂等——登记为空 ⇒ 交卷原样返回', () => {
  const settlement: any = { planning: { problemAnalysis: ['仅交卷'] }, preparation: {} }
  assert.deepEqual(mergeStartEvidenceIntoSettlement(settlement, null as any).planning.problemAnalysis, ['仅交卷'])
  assert.equal(renderStartPhaseEvidence(null as any), '', '空登记渲染为空串，不得抛错')
})

test('R1：登记原文渲染块逐字含登记条目（回注/回喂共用）', () => {
  const registered = registeredFixture()
  const text = renderStartPhaseEvidence(registered)
  assert.ok(text.includes(LONG_REGISTERED_ITEM), '渲染块必须逐字含登记长条目，不得摘要')
  assert.match(text, /第一步·任务梳理/, '分组标题在案')
})

/* ------------------------------------------------------------ 结算裁决 */

test('A1：薄交卷 + 登记 ⇒ 判 done 且落账 phases 含登记条目（旧实现必 blocked）', () => {
  const registered = registeredFixture()
  const out = adjudicateResult({
    output: outputWithPhases(thinSettlementFixture()),
    expectedAcceptance: ['通道可用'],
    startPhases: registered,
  })
  assert.equal(out.status, 'done', `归并后一致性比对必须通过：${out.error ?? ''}`)
  const mergedProblem = (out as any)?.phases?.planning?.problemAnalysis ?? []
  assert.ok(mergedProblem.includes(LONG_REGISTERED_ITEM),
    '落账 phases 必须含登记长条目（登记原文永不丢失）')
  assert.ok(mergedProblem.includes('任务梳理：目标与验收已明确；现状是计划已生成待执行；约束是不重复做已完成工作；边界是只做本任务。'),
    '交卷自有条目同样保留（宽容新增语义不变）')
})

test('A2：零回归——五步证据本身不完整（缺 preparation），有登记也判 blocked', () => {
  const phases: any = thinSettlementFixture()
  delete phases.preparation
  const out = adjudicateResult({
    output: outputWithPhases(phases),
    expectedAcceptance: ['通道可用'],
    startPhases: registeredFixture(),
  })
  assert.equal(out.status, 'blocked')
  assert.match(String(out.error), /五步证据不完整/)
})

test('A3：安全网——封顶截断使登记条目装不下 ⇒ 仍判 blocked', () => {
  // 登记 20 条 × 40 字；交卷 5 条 × 10 字（合计 50 ≥ 40 字下限，过结算闸）。
  // 归并截到 20 条后只能装 15 条登记 → 字数 50+600=650 < 800 ⇒ 比对判变薄。
  const registered = sanitizeStartPhaseEvidence({
    planning: {
      problemAnalysis: Array.from({ length: MAX_PHASE_LIST_ITEMS }, (_, i) => `登记长条目-${String(i).padStart(2, '0')}-${'数'.repeat(33)}`),
      approach: ['登记方法：按登记蓝图执行，先核对输入数据可用性再动手，按依赖顺序推进并逐条验收。'],
      approachBasis: ['登记依据：数据源约束决定先验证再动手，边界决定不扩大范围。'],
      resources: ['登记资源：任务书、验收标准清单与会话通道均已确认具备。'],
      tools: ['登记工具：终端命令、浏览器与测试运行器。'],
    },
    preparation: {
      prepared: ['登记已备：工作目录可读写，依赖已安装，任务书已核对。'],
      evidence: ['登记证据：pwd 与 ls 输出正常，node -v 可运行。'],
    },
  }) as StartPhaseEvidence
  const settlement = thinSettlementFixture()
  settlement.planning.problemAnalysis = ['交卷短条目一', '交卷短条目二', '交卷短条目三', '交卷短条目四', '交卷短条目五']
  const out = adjudicateResult({
    output: outputWithPhases(settlement),
    expectedAcceptance: ['通道可用'],
    startPhases: registered,
  })
  assert.equal(out.status, 'blocked', '截断丢登记内容时一致性比对必须仍兜底')
  assert.equal((out as any).rereport, true)
})

/* ------------------------------------------------------------ 提示词回注 */

test('P1：phase-1 接续提示回注登记原文（buildPhaseZeroContinuationHint 第 4 参）', () => {
  const registered = registeredFixture()
  const hint = buildPhaseZeroContinuationHint('high', 'phase-0 输出摘要', false, registered)
  assert.ok(hint.includes(LONG_REGISTERED_ITEM), '接续提示必须逐字含登记原文')
  assert.match(hint, /必须原样收录/, '接续提示必须明示复制纪律')
  // 无登记（旧调用点）零回归
  const legacy = buildPhaseZeroContinuationHint('high', 'phase-0 输出摘要')
  assert.match(legacy, /phase-0→phase-1 接续/)
  assert.ok(!legacy.includes('开工登记证据·原文'), '无登记不得渲染登记块')
})

test('P2：回喂消息回注登记原文（buildChildPrompt previousFailure.registeredStartPhases）', () => {
  const registered = registeredFixture()
  const prompt = buildChildPrompt({
    plan: {
      planId: 'wp-t11-merge', title: '回注验收',
      taskUnderstanding: { originalRequest: '验收', deliverable: '回注' },
      contradictions: { primary: { statement: 'p' }, secondary: [], transformationConditions: [] },
      stages: [{
        id: 'S1', name: '实施', goal: '交付', rationale: 'r', checkpoint: 'c',
        subtasks: [{
          id: 'T1', title: '子任务', department: 'engineering', role: 'engineer',
          objective: '完成', method: ['做'], inputs: [], outputs: [],
          acceptance: ['验收'], risk: '低', dependsOn: [],
        }],
      }],
    },
    subtask: {
      id: 'T1', title: '子任务', department: 'engineering', role: 'engineer',
      objective: '完成', method: ['做'], inputs: [], outputs: [],
      acceptance: ['验收'], risk: '低', dependsOn: [],
    },
    stage: { id: 'S1', name: '实施', goal: '交付', rationale: 'r', checkpoint: 'c' },
    dependencyResults: [],
    cwd: '/tmp',
    previousFailure: {
      attempt: 1,
      code: 'EVIDENCE_INCOMPLETE',
      message: '开工-结算证据不一致',
      registeredStartPhases: registered,
    },
  })
  assert.ok(String(prompt).includes(LONG_REGISTERED_ITEM), '回喂任务书必须逐字含登记原文')
  assert.match(String(prompt), /逐字抄入/, '回喂必须明示照抄而非重写')
  // 无登记字段（旧回放/旧调用）零回归
  const legacy = buildChildPrompt({
    plan: { planId: 'wp-t11-merge', title: 't', stages: [] },
    subtask: { id: 'T1', title: '子任务' },
    stage: { id: 'S1' },
    dependencyResults: [],
    cwd: '/tmp',
    previousFailure: { attempt: 1, code: 'CHILD_NOT_COMPLETED', message: '超时' },
  })
  assert.ok(!String(legacy).includes('开工登记证据·原文'), '无登记字段不得渲染登记块')
})

/* ------------------------------------------------------------ e2e */

function makePlan() {
  return {
    planId: 'wp-t11-merge-e2e',
    title: '归并落账验收',
    taskUnderstanding: { originalRequest: '验收归并', deliverable: '薄交卷也能正确落账' },
    contradictions: { primary: { statement: '登记永不丢失' }, secondary: [], transformationConditions: [] },
    stages: [{
      id: 'S1', name: '实施', goal: '交付', rationale: '归并优先', checkpoint: '可核对',
      subtasks: [{
        id: 'T1', title: '薄交卷子任务', department: 'engineering', role: 'engineer',
        objective: '交薄卷验证归并', method: ['实现', '测试'], inputs: [],
        outputs: ['reports/t11-核对报告.md'], acceptance: ['通道可用'], risk: '低', dependsOn: [],
      }],
    }],
  }
}

function makeSession(cwd: string) {
  const events: any[] = []
  return {
    id: 'session-t11-merge',
    header: { createdAt: 1000, cwd },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function makeRuntime(outputs: string[], cwd: string) {
  const prompts: string[] = []
  const session = makeSession(cwd)
  session.append('user/message', buildPlanMessage(makePlan()))
  seedLeaderSelfEffort(session, makePlan())
  const ctx = {
    logger: { warn() {} },
    subagents: {
      startActivation: async (activation: any) => {
        const prompt = String(activation?.prompt?.[0]?.text ?? '')
        prompts.push(prompt)
        const output = outputs.shift() ?? outputWithPhases(thinSettlementFixture())
        return {
          childId: `child-t11-${prompts.length}`,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
          dispose: async () => {},
        }
      },
    },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime = createWorkplanRuntime(ctx, {
    totalTimeoutMs: 60_000, idleTimeoutMs: 30_000, childTimeoutMs: 20_000, maxResumes: 4, autoResume: false,
  })
  return { session, runtime, prompts }
}

test('E1：direct 路径跨会话登记——薄交卷首跑即 done，不再被变薄退回', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-wp-t11-'))
  const { session, runtime, prompts } = makeRuntime([outputWithPhases(thinSettlementFixture())], cwd)
  const signal = new AbortController().signal
  const result: any = await runtime.dispatchTool({ session, options: {} }, { startPhases: MAIN_START_PHASES_FIXTURE }, signal)
  const row = (Array.isArray(result?.statuses) ? result.statuses : []).find((item: any) => item.subtaskId === 'T1')
  assert.equal(row?.status, 'done', `归并后首跑应交卷即 done：${row?.error ?? ''}`)
  assert.equal(row?.verification, 'structured')
  assert.equal(prompts.length, 1, '不再触发凑字数式回喂重试')
  assert.ok(!/开工-结算证据不一致/.test(String(row?.error ?? '')), '不得再出现变薄退回')
})
