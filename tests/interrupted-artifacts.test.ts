/*
 * [1.8.5] 中断不是「什么都没做」。
 *
 * 真实事故：2026-10-30 21:34:52，T6 的子 Agent 已写出 38,140 字节的交付物；
 * 21:34:54 它被外部中断，插件只留下「子 Agent 结束状态为 aborted」，产物存在
 * 与否完全不进判定，于是这一步被判死，6 个下游一起停摆。
 *
 * 修法刻意保守：判定语义一个字都不改（中断仍记 blocked、仍不自动重试），只
 * 在报错里补一句可核实的事实——「该步声明的产物里有哪几个已经在盘上」。人看
 * 到这句话才知道该去核对、据实改判，而不是干等一次不会发生的重试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createStatuses } from '../src/plan.js'
import { dispatchPlan, probeInterruptedArtifacts } from '../src/runtime.js'

function makePlan() {
  return {
    planId: 'wp-interrupted',
    sessionId: 'session-interrupted',
    createdTurn: 1,
    createdAt: 1000,
    title: '中断产物核对',
    stages: [
      {
        id: 'S1',
        subtasks: [
          {
            id: 'T1',
            title: '写清单',
            department: 'engineering',
            dependsOn: [],
            outputs: ['T5_事件影响清单_20261030.csv：事件清单'],
          },
        ],
      },
    ],
  }
}

function makeRecord(plan: any): any {
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'pending',
    statuses: createStatuses(plan),
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: false,
  }
}

function makeSession() {
  const events: any[] = []
  return {
    id: 'session-interrupted',
    header: { createdAt: 1000 },
    get seq() {
      return events.length
    },
    append(type: string, data: any) {
      events.push({ type, data })
      return data
    },
    eventAt: (seq: number) => events[seq],
    events,
  }
}

function abortedChild(text: string) {
  return {
    childId: 'child-aborted',
    result: Promise.resolve({ stopReason: 'aborted', output: [{ type: 'text', text }] }),
    dispose: async () => {},
  }
}

function makeCtx(child: any) {
  return {
    logger: { warn() {} },
    subagents: { startActivation: () => child },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
}

test('中断时报错点出已在盘上的产物，而不是只说一句 aborted', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const child = abortedChild('已写出 T5_事件影响清单_20261030.csv，正在写报告')
  const result = await dispatchPlan(makeCtx(child), record, {
    agent: { session: makeSession(), options: {} },
    signal: new AbortController().signal,
    cwd: '/tmp/never-written',
    // 只认这一个文件存在：断言的是「核到并说出来」，不是在测文件系统。
    artifactExists: (path: string) => String(path).endsWith('T5_事件影响清单_20261030.csv'),
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 20000,
  })

  assert.ok(result)
  const step = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(step.status, 'blocked', '中断仍然算失败，语义没被放宽')
  assert.match(step.error, /已核到 1 个文件确实在盘上/)
  assert.match(step.error, /T5_事件影响清单_20261030\.csv/)
})

test('产物并不存在时，不编造「已落盘」，只保留核对提示', async () => {
  const plan = makePlan()
  const record = makeRecord(plan)
  const child = abortedChild('打算写 T5_事件影响清单_20261030.csv，还没开始')
  const result = await dispatchPlan(makeCtx(child), record, {
    agent: { session: makeSession(), options: {} },
    signal: new AbortController().signal,
    cwd: '/tmp/never-written',
    artifactExists: () => false,
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 20000,
  })

  assert.ok(result)
  const step = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(step.status, 'blocked')
  assert.match(step.error, /先核对该步声明的产物是否已写出/)
  assert.doesNotMatch(step.error, /已核到/)
})

test('probeInterruptedArtifacts 只认真正存在的文件，且限制条数', () => {
  const landed = probeInterruptedArtifacts(
    '产出 a.md、b.csv 与 c.json',
    { outputs: ['d.html'] },
    '/tmp/base',
    (path: string) => /a\.md|b\.csv|c\.json/.test(String(path)),
  )
  assert.deepEqual(landed.sort(), ['a.md', 'b.csv', 'c.json'])
  assert.ok(landed.length <= 6)
})

/*
 * [1.8.6] 1.8.5 只把「核到哪些文件」写进报错；计划里仍然没有 artifacts，调度器
 * 无从核对，于是照旧级联下游。下面两条把新语义钉死：证据要落进状态，且下游不再
 * 因为一次中断被连坐。
 */
test('被中断的子任务把已核产物写进 blocked 状态', async () => {
  const plan = makePlan()
  plan.stages[0].subtasks[0].outputs = ['out_甲.csv：清单', 'out_丙.md：说明']
  const record = makeRecord(plan)
  const child = abortedChild('已写出 out_甲.csv，正在写 out_丙.md')
  await dispatchPlan(makeCtx(child), record, {
    agent: { session: makeSession(), options: {} },
    signal: new AbortController().signal,
    cwd: '/tmp/never-written',
    artifactExists: (path: string) => String(path).endsWith('out_甲.csv'),
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 20000,
  })

  const step: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
  assert.equal(step.status, 'blocked', '中断仍然算失败，不自动改判')
  assert.deepEqual(
    step.artifacts,
    [
      { kind: 'file', ref: 'out_甲.csv', exists: true },
      { kind: 'file', ref: 'out_丙.md', exists: false },
    ],
    '声明过的与核到的取并集，逐项标 exists',
  )
  assert.deepEqual(step.missingArtifacts, ['out_丙.md'])
})

test('被中断的子任务不再把下游级联成 blocked', async () => {
  const plan: any = makePlan()
  plan.stages[0].subtasks.push({
    id: 'T2',
    title: '写报告',
    department: 'writing',
    dependsOn: ['T1'],
    outputs: ['report.md'],
  })
  const record = makeRecord(plan)
  const child = abortedChild('已写出 T5_事件影响清单_20261030.csv')
  const result = await dispatchPlan(makeCtx(child), record, {
    agent: { session: makeSession(), options: {} },
    signal: new AbortController().signal,
    cwd: '/tmp/never-written',
    artifactExists: (path: string) => String(path).endsWith('T5_事件影响清单_20261030.csv'),
    idleTimeoutMs: 60000,
    childTimeoutMs: 60000,
    totalTimeoutMs: 20000,
  })

  const t1: any = record.statuses.find((item: any) => item.subtaskId === 'T1')
  const t2: any = record.statuses.find((item: any) => item.subtaskId === 'T2')
  assert.equal(t1.status, 'blocked')
  assert.equal(t2.status, 'pending', '下游没有被判死，留给主 Agent 据实改判后续跑')
  assert.ok((record.errors ?? []).some((line: string) => /未自动级联下游/.test(line)))
  assert.equal(result.phase, 'blocked', '真有失败项时阶段仍是 blocked')
})
