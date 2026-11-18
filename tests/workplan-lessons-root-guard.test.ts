/*
 * [3.0.6][复审修复] lessons 工具的会话级越权读取封禁。
 *
 * 事故形状：lessons 工具无任何会话校验，任意子 Agent（含其他插件拉起的
 * 子会话）都能读全局跨项目 lessons.jsonl——其他项目的 cwd、问题描述、
 * 复盘结论全部泄露。修复后契约（数据面越权修复，根会话行为不变）：
 *  - 非根会话（parentSession / origin=subagent / delegationDepth>0）调用 →
 *    抛 PlanError，code=NOT_ROOT，提示语说明子 Agent 不能读全局记忆；
 *  - 连 session 都没有 → code=NO_SESSION；
 *  - 根会话照常工作：stats 返回 ok（用临时 lessons 文件，不碰真实全局记忆）。
 *
 * 与 updateStatus/replan 等工具的 isRootSession 硬校验同款式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkplanRuntime } from '../src/runtime.js'

function makeRuntime() {
  return createWorkplanRuntime(
    { logger: { warn() {} } },
    { totalTimeoutMs: 60_000, cwd: '/work' },
  ) as any
}

const NON_ROOT_MARKERS = [
  { label: 'parentSession 标记', header: { createdAt: 1000, cwd: '/work', parentSession: 'session-parent' } },
  { label: 'origin=subagent 标记', header: { createdAt: 1000, cwd: '/work', origin: 'subagent' } },
  { label: 'delegationDepth>0 标记', header: { createdAt: 1000, cwd: '/work', delegationDepth: 1 } },
]

for (const { label, header } of NON_ROOT_MARKERS) {
  test(`非根会话被拒（${label}）：code=NOT_ROOT`, async () => {
    const runtime = makeRuntime()
    const agent = { session: { id: 'session-child', header } }
    await assert.rejects(
      () => runtime.lessonsTool(agent, { action: 'list' }),
      (error: any) => {
        assert.equal(error?.code, 'NOT_ROOT', `必须抛 NOT_ROOT，实际：${error?.code}`)
        assert.match(String(error?.message), /子 Agent 不能读取全局永久教训记忆/)
        return true
      },
    )
  })
}

test('无 session 的调用被拒：code=NO_SESSION', async () => {
  const runtime = makeRuntime()
  await assert.rejects(
    () => runtime.lessonsTool({}, { action: 'list' }),
    (error: any) => {
      assert.equal(error?.code, 'NO_SESSION')
      assert.match(String(error?.message), /只能在会话内查询永久教训记忆/)
      return true
    },
  )
})

test('根会话行为不变：stats 正常返回（临时 lessons 文件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workplan-lessons-guard-'))
  const file = join(dir, 'lessons.jsonl')
  const previous = process.env.DSH_WORKPLAN_LESSONS_FILE
  process.env.DSH_WORKPLAN_LESSONS_FILE = file
  try {
    const runtime = makeRuntime()
    const agent = { session: { id: 'session-root', header: { createdAt: 1000, cwd: '/work' } } }
    const result = await runtime.lessonsTool(agent, { action: 'stats' })
    assert.equal(result.ok, true, `根会话必须照常可用：${JSON.stringify(result)}`)
    assert.equal(typeof result.total, 'number')
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKPLAN_LESSONS_FILE
    else process.env.DSH_WORKPLAN_LESSONS_FILE = previous
  }
})
