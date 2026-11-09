/*
 * [2.2.1] Regression guard for the 2026-11-08 session-a404d49d… history-load failure.
 *
 * Root cause under test: dsh-workplan appended plain strings as `user/message`
 * data. DSH persists them (its append gate only validates record payloads) but
 * on replay the `goal` projection dereferences `event.data.source.kind` and
 * throws "Cannot read properties of undefined (reading 'kind')", which the GUI
 * reports as "历史加载失败 / failed to project session".
 *
 * These tests pin the fix at the only two places that can prevent a recurrence:
 *  1. appendUserMessage() must always emit a complete DSH UserMessage payload;
 *  2. runtime.ts / supersede.ts must not bypass that helper again.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { appendUserMessage, makeUserMessage } from '../src/plan.js'

test('appendUserMessage wraps raw notice text into a valid DSH user message', () => {
  const calls: any[] = []
  const session = {
    append(type: string, data: any, options: any) {
      calls.push({ type, data, options })
    },
  }
  appendUserMessage(session, '子任务 T6 即将到点：剩余 119s\n第二行应被压成一行摘要')

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.type, 'user/message')
  assert.equal(call.options.surfaceOp, 'append')
  assert.equal(typeof call.data.id, 'string')
  assert.ok(call.data.id.length > 0)
  assert.equal(call.data.role, 'user')
  assert.deepEqual(call.data.content, [{
    type: 'text',
    text: '子任务 T6 即将到点：剩余 119s\n第二行应被压成一行摘要',
  }])
  assert.equal(call.data.source.kind, 'workplan')
  assert.equal(call.data.source.form, 'notice')
  assert.ok(call.data.source.summary.length > 0 && call.data.source.summary.length <= 120)
  assert.ok(!call.data.source.summary.includes('\n'))
})

test('appendUserMessage rejects malformed payloads before touching the log', () => {
  let appends = 0
  const session = { append() { appends += 1 } }

  assert.throws(
    () => appendUserMessage(session, { role: 'user', content: [{ type: 'text', text: 'x' }] }),
    /malformed user\/message/,
  )
  assert.throws(() => appendUserMessage(session, makeUserMessage('x', {})), /source\.kind/)
  assert.throws(() => appendUserMessage(session, makeUserMessage('x', { kind: '' })), /source\.kind/)
  assert.equal(appends, 0)
})

test('runtime and supersede have no direct user/message append left', () => {
  // Compiled tests live in dist-tests/tests/, so `../../src` is the real src dir.
  const sourceRoot = new URL('../../src/', import.meta.url)
  for (const file of ['runtime.ts', 'supersede.ts']) {
    const source = readFileSync(fileURLToPath(new URL(file, sourceRoot)), 'utf8')
    const direct = source.match(/\.append\??\s*\(\s*['"`]user\/message['"`]/g) ?? []
    assert.deepEqual(direct, [], `${file} must append user/message through appendUserMessage()`)
  }
})
