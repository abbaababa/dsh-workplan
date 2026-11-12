/*
 * [2.5.4][T5] 消息接口 v1 冻结契约测试（contract-member）。
 *
 * 唯一权威契约：_t5_channel_20261112/00-contract-v1.md（冻结人：T5 负责人 agent-10，
 * planId wp-437e264b-77c4-4849-b088-f60a918e0cdc）。本文件把契约钉在两个可复核边界上：
 *   1. 冻结常量防漂移：DEPT_MESSAGE_VERSION / DEPT_MESSAGE_KINDS / DEPT_ROLES
 *      必须与契约精确一致（集合相等 + 数量 + 无重复）；任何增删改都会红。
 *   2. 逐夹具校验：tests/fixtures/dept-message-v1.json 的 7 条合法样例（每种 kind 各 1）
 *      必须被 validateDeptMessage 接受；6 条非法样例（未知 kind / 缺 body / ts 非法 /
 *      role 非法 / 版本漂移 / expert 缺 member）必须被 fail-closed 拒绝。
 *
 * 纪律（契约 §6）：不碰共享 dist/lib/dist-tests；私有编译实跑命令（负责人统一集成亦可）：
 *   cd plugins/dsh-workplan
 *   npx tsc tests/dept-message-contract.test.ts --module nodenext --moduleResolution nodenext \
 *     --target es2022 --skipLibCheck --rootDir . --outDir ../../_t5_channel_20261112/contract-build
 *   node --test ../../_t5_channel_20261112/contract-build/tests/dept-message-contract.test.js
 * 夹具路径按「自测试文件目录逐级向上」解析，源码树 / 私有编译产物 / dist-tests 三种布局均可命中。
 * 本测试不写留痕文件、不依赖 harness 服务（纯函数校验），无需 DSH_WORKPLAN_JOURNAL_DIR。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateDeptMessage,
  DEPT_MESSAGE_KINDS,
  DEPT_ROLES,
  DEPT_MESSAGE_VERSION,
} from '../src/dept-journal.js'

/** 契约 §1/§2 冻结集合（与 00-contract-v1.md 逐项一致；变更须 T5 负责人重新冻结）。 */
const FROZEN_KINDS = ['dispatch', 'instruction', 'escalation', 'estimate', 'completion', 'need', 'receipt'] as const
const FROZEN_ROLES = ['root', 'head', 'expert', 'member'] as const
const FROZEN_VERSION = 1

const here = dirname(fileURLToPath(import.meta.url))

/** 自测试文件目录逐级向上找夹具：兼容源码树、私有编译（contract-build/tests）与 dist-tests 布局。 */
function findFixture(): string {
  let dir = here
  for (let i = 0; i < 10; i += 1) {
    for (const rel of ['tests/fixtures/dept-message-v1.json', 'plugins/dsh-workplan/tests/fixtures/dept-message-v1.json']) {
      const candidate = join(dir, rel)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`dept-message-v1.json fixture not found from ${here}`)
}

interface FixtureCase {
  name: string
  expect: 'pass' | 'fail'
  why?: string
  message: Record<string, unknown>
}

const fixture = JSON.parse(readFileSync(findFixture(), 'utf8')) as {
  contractVersion: number
  cases: FixtureCase[]
}

test('冻结常量：DEPT_MESSAGE_VERSION 必须为字面量 1', () => {
  assert.equal(DEPT_MESSAGE_VERSION, FROZEN_VERSION)
})

test('冻结常量：DEPT_MESSAGE_KINDS 精确等于契约 7 种（防漂移）', () => {
  assert.equal(DEPT_MESSAGE_KINDS.length, FROZEN_KINDS.length)
  assert.equal(new Set(DEPT_MESSAGE_KINDS).size, FROZEN_KINDS.length, 'kind 不得重复')
  assert.deepEqual([...DEPT_MESSAGE_KINDS].sort(), [...FROZEN_KINDS].sort())
})

test('冻结常量：DEPT_ROLES 精确等于契约 4 种（防漂移）', () => {
  assert.equal(DEPT_ROLES.length, FROZEN_ROLES.length)
  assert.equal(new Set(DEPT_ROLES).size, FROZEN_ROLES.length, 'role 不得重复')
  assert.deepEqual([...DEPT_ROLES].sort(), [...FROZEN_ROLES].sort())
})

test('夹具自检：contractVersion=1，7 种 kind 各恰 1 条合法样例，非法样例 ≥4 且覆盖四类必检缺陷', () => {
  assert.equal(fixture.contractVersion, FROZEN_VERSION)
  const passCases = fixture.cases.filter((c) => c.expect === 'pass')
  const failCases = fixture.cases.filter((c) => c.expect === 'fail')
  assert.equal(passCases.length, FROZEN_KINDS.length)
  assert.deepEqual(passCases.map((c) => c.message.kind).sort(), [...FROZEN_KINDS].sort())
  assert.ok(failCases.length >= 4, '非法样例至少 4 条')
  const names = failCases.map((c) => c.name).join(' ')
  for (const required of ['unknown-kind', 'missing-body', 'invalid-ts', 'invalid-role']) {
    assert.ok(names.includes(required), `非法样例必须覆盖 ${required}`)
  }
})

for (const c of fixture.cases) {
  test(`契约夹具 ${c.name}（expect=${c.expect}）`, () => {
    const result = validateDeptMessage(c.message)
    if (c.expect === 'pass') {
      if (!result.ok) assert.fail(`合法样例被拒：${c.name} → ${result.error}`)
      // 契约只冻结「接受合法消息」；此处核对关键身份字段原样保留，不额外强加未冻结的归一化语义。
      assert.equal(result.value.v, FROZEN_VERSION)
      assert.equal(result.value.id, c.message.id)
      assert.equal(result.value.kind, c.message.kind)
      assert.equal(result.value.planId, c.message.planId)
      assert.equal(result.value.subtaskId, c.message.subtaskId)
    } else {
      if (result.ok) assert.fail(`非法样例被接受（fail-closed 失效）：${c.name}${c.why ? `（${c.why}）` : ''}`)
      assert.equal(typeof result.error, 'string')
      assert.ok(result.error.length > 0, '拒绝必须给出显式 error 文案（D6：不静默）')
    }
  })
}
