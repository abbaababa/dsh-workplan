/*
 * [3.2.4] 产物回报的双基座核对（治本回归）。
 *
 * 现场（2026-11-23，wp-bb6cee17）：子 Agent 按任务书把产物写在 <cwd>/reports/
 * 下，回报里的路径也相对产物根目录写（如 "T1/x.md"）；结算却只按 <cwd> 解析，
 * 真实存在的文件被判成缺失，依赖门把 11 个下游全部挡成 blocked，dispatch 零
 * 派发。这里锁死：两个基座都要核对，且工作目录基座仍排第一（兼容旧回报）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkArtifacts,
  fingerprintArtifacts,
  probeInterruptedArtifacts,
} from '../src/runtime.js'

test('checkArtifacts：相对产物根目录的回报不再被误判为缺失', () => {
  const seen: string[] = []
  const result = checkArtifacts([
    { kind: 'file', ref: 'T1/需求单.md' },
    { kind: 'file', ref: 'T2/行情.csv' },
  ], '/repo', (target: string) => {
    seen.push(target)
    return target === '/repo/reports/T1/需求单.md'
  })

  assert.deepEqual(seen, [
    '/repo/T1/需求单.md',
    '/repo/reports/T1/需求单.md',
    '/repo/T2/行情.csv',
    '/repo/reports/T2/行情.csv',
  ])
  assert.equal(result.artifacts[0].exists, true)
  assert.equal(result.artifacts[1].exists, false)
  assert.deepEqual(result.missingArtifacts, ['T2/行情.csv'])
})

test('checkArtifacts：工作目录基座仍优先，旧回报行为不变', () => {
  const seen: string[] = []
  const result = checkArtifacts([{ kind: 'file', ref: 'docs/api.md' }], '/repo', (target: string) => {
    seen.push(target)
    return target === '/repo/docs/api.md'
  })

  assert.deepEqual(seen, ['/repo/docs/api.md'])
  assert.deepEqual(result.missingArtifacts, [])
  assert.equal(result.artifacts[0].exists, true)
})

test('checkArtifacts：带 reports/ 前缀的回报不会拼出 reports/reports 路径', () => {
  const seen: string[] = []
  checkArtifacts([{ kind: 'file', ref: 'reports/T3/清单.json' }], '/repo', (target: string) => {
    seen.push(target)
    return false
  })

  assert.deepEqual(seen, ['/repo/reports/T3/清单.json'])
})

test('checkArtifacts：绝对路径只核对一次，不叠加基座', () => {
  const seen: string[] = []
  checkArtifacts([{ kind: 'file', ref: '/data/x.csv' }], '/repo', (target: string) => {
    seen.push(target)
    return true
  })
  assert.deepEqual(seen, ['/data/x.csv'])
})

test('probeInterruptedArtifacts：报告正文里的产物根相对路径也能在盘上认出来', () => {
  const landed = probeInterruptedArtifacts(
    '已写出 T2/汇总.csv 与 reports/T2/明细.json，另有 T9/未写.md',
    { outputs: [] },
    '/repo',
    (target: string) => target.startsWith('/repo/reports/T2/'),
  )
  assert.deepEqual(landed.sort(), ['T2/汇总.csv', 'reports/T2/明细.json'].sort())
})

test('fingerprintArtifacts：指纹记录按同一双基座解析', () => {
  const seen: string[] = []
  const out = fingerprintArtifacts(['T4/图.png'], '/repo', (target: string) => {
    seen.push(target)
    if (target !== '/repo/reports/T4/图.png') throw new Error('ENOENT')
    return { size: 12, mtimeMs: 345 }
  })
  assert.deepEqual(seen, ['/repo/T4/图.png', '/repo/reports/T4/图.png'])
  assert.deepEqual(out, [{ ref: 'T4/图.png', size: 12, mtimeMs: 345 }])
})
