/*
 * [1.7.0] Dependency gate and artifact verification.
 *
 * Before this, a dependency only counted as satisfied when its status said
 * `done` — a child that declared a file which was never written still unblocked
 * its dependents, and they failed on a missing input with no explanation. The
 * gate now also requires the upstream's declared files to exist, and a blocked
 * upstream records *why* downstream was stopped.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStatus,
  createStatuses,
  markDependentsBlocked,
  readySubtasks,
} from '../src/plan.js'
import { checkArtifacts } from '../src/runtime.js'

function makePlan() {
  return {
    planId: 'wp-artifacts',
    sessionId: 'session-artifacts',
    createdTurn: 1,
    createdAt: 1000,
    title: '产物门禁回归',
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        {
          id: 'T1',
          title: '产出接口清单',
          department: 'engineering',
          objective: '产出清单',
          acceptance: ['清单存在'],
          outputs: ['docs/api.md'],
          risk: 'low',
          dependsOn: [],
        },
        {
          id: 'T2',
          title: '按清单实现',
          department: 'engineering',
          objective: '实现',
          acceptance: ['实现完成'],
          outputs: ['src/api.ts'],
          risk: 'low',
          dependsOn: ['T1'],
        },
      ],
    }],
  }
}

test('产物检查只核对 file，缺失项被单独列出', () => {
  const seen: string[] = []
  const result = checkArtifacts([
    { kind: 'file', ref: 'src/api.ts' },
    { kind: 'file', ref: 'docs/api.md' },
    { kind: 'url', ref: 'https://example.invalid/x' },
  ], '/repo', (target: string) => {
    seen.push(target)
    return target.endsWith('src/api.ts')
  })

  assert.deepEqual(seen, ['/repo/src/api.ts', '/repo/docs/api.md'])
  assert.equal(result.artifacts[0].exists, true)
  assert.equal(result.artifacts[1].exists, false)
  assert.equal(result.artifacts[2].exists, undefined, 'url 不做文件系统检查')
  assert.deepEqual(result.missingArtifacts, ['docs/api.md'])
})

test('产物检查在文件系统出错时按“缺失”处理，不放行', () => {
  const result = checkArtifacts([{ kind: 'file', ref: 'a.md' }], '/repo', () => {
    throw new Error('EACCES')
  })
  assert.deepEqual(result.missingArtifacts, ['a.md'])
  assert.equal(result.artifacts[0].exists, false)
})

test('依赖只看 done 时 T2 会放行；产物门禁把缺失产物视为未满足', () => {
  const plan = makePlan()
  let statuses: any[] = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', {
    status: 'done',
    artifacts: [{ kind: 'file', ref: 'docs/api.md' }],
    missingArtifacts: ['docs/api.md'],
  })

  const loose = readySubtasks(plan, statuses).map((item: any) => item.id)
  assert.deepEqual(loose, ['T2'], '1.6.0 行为：done 即放行（兼容保留）')

  const gated = readySubtasks(plan, statuses, {
    dependencyOk: (dependency: any) => dependency?.status === 'done'
      && !(Array.isArray(dependency?.missingArtifacts) && dependency.missingArtifacts.length > 0),
  }).map((item: any) => item.id)
  assert.deepEqual(gated, [], '声明产物缺失的上游不得解锁下游')
})

test('上游受阻时下游写明原因与缺失产物，而不是笼统“依赖未完成”', () => {
  const plan = makePlan()
  let statuses: any[] = createStatuses(plan)
  statuses = applyStatus(statuses, 'T1', { status: 'blocked', error: '子 Agent 报告受依赖阻塞' })

  const next = markDependentsBlocked(plan, statuses, 'T1', {
    reason: '子 Agent 报告受依赖阻塞',
    missingArtifacts: ['docs/api.md'],
  })
  const t2 = next.find((item: any) => item.subtaskId === 'T2')
  assert.equal(t2?.status, 'blocked')
  assert.match(String(t2?.error), /T1/)
  assert.match(String(t2?.error), /产出接口清单/, '要带上上游标题，主 Agent 才知道找谁')
  assert.match(String(t2?.error), /docs\/api\.md/, '缺失产物必须点名')
  assert.equal(t2?.blockedBy?.[0]?.id, 'T1')
})
