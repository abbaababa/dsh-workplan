import test from 'node:test'
import assert from 'node:assert/strict'

import { renderContextOmissions, routeContext, type ContextItem } from '../src/context-router.js'

test('[3.2.9] RCR 按角色/阶段过滤，must 条目不被预算丢弃', () => {
  const items: ContextItem[] = [
    { id: 'anchor', kind: 'anchor', text: '用户原要求：必须保留 /tmp/a.md 与 42%', priority: 'must', role: '*', stage: '*' },
    { id: 'leader-only', kind: 'sibling', text: '负责人专属兄弟简报', priority: 'normal', role: 'leader' },
    { id: 'planning-only', kind: 'background', text: '计划阶段背景', priority: 'normal', role: 'expert', stage: 'planning' },
    { id: 'expert-note', kind: 'instruction', text: '专家指示：先核对路径', priority: 'high', role: 'expert', stage: 'execution' },
  ]
  const result = routeContext(items, { role: 'expert', stage: 'execution', chars: 8 })
  assert.deepEqual(result.selected.map((item) => item.id), ['anchor'])
  assert.ok(result.usedChars > 8)
  assert.ok(result.overflowChars > 0)
  assert.ok(result.omitted.some((item) => item.id === 'expert-note' && item.reason === 'budget'))
  assert.ok(result.omitted.some((item) => item.id === 'leader-only' && item.reason === 'role-mismatch'))
  assert.ok(result.omitted.some((item) => item.id === 'planning-only' && item.reason === 'stage-mismatch'))
  const roomy = routeContext(items, { role: 'expert', stage: 'execution', chars: 100 })
  assert.deepEqual(roomy.selected.map((item) => item.id), ['anchor', 'expert-note'])
})

test('[3.2.9] 去重键与预算省略都进入索引，且顺序确定', () => {
  const items: ContextItem[] = [
    { id: 'a', kind: 'dependency', text: '同一段依赖摘要：路径 /tmp/x.md', dedupeKey: 'same', priority: 'high' },
    { id: 'b', kind: 'dependency', text: '同一段依赖摘要：路径 /tmp/x.md', dedupeKey: 'same', priority: 'normal' },
    { id: 'c', kind: 'sibling', text: 'x'.repeat(80), priority: 'normal' },
  ]
  const first = routeContext(items, { role: 'expert', stage: 'execution', chars: 40, perKind: { sibling: 1 } })
  const second = routeContext(items, { role: 'expert', stage: 'execution', chars: 40, perKind: { sibling: 1 } })
  assert.deepEqual(first.selected.map((item) => item.id), second.selected.map((item) => item.id))
  assert.ok(first.omitted.some((item) => item.id === 'b' && item.reason === 'duplicate'))
  assert.ok(first.omitted.some((item) => item.id === 'c' && item.reason === 'budget'))
  assert.match(renderContextOmissions(first.omitted), /原文仍在计划\/状态\/产物中/)
})
