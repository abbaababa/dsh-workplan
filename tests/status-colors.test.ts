import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src/client.ts'), 'utf8')

test('done status is sky blue and in-progress status is orange', () => {
  assert.match(source, /--dsh-wp-done:\s*#0ea5e9/)
  assert.match(source, /--dsh-wp-active:\s*#f97316/)
  assert.match(source, /\.dsh-wp-stat--done[^}]*var\(--dsh-wp-done-text\)/)
  assert.match(source, /\.dsh-wp-stat--active[^}]*var\(--dsh-wp-active-text\)/)
  assert.match(source, /\.dsh-wp-bar-fill--done[^}]*var\(--dsh-wp-done\)/)
  assert.match(source, /\.dsh-wp-mini-fill--done[^}]*var\(--dsh-wp-done\)/)
  assert.match(source, /\.dsh-wp-progress-fill--done[^}]*var\(--dsh-wp-done\)/)
  assert.match(source, /\.dsh-wp-tone-active[^}]*var\(--dsh-wp-active\)/)
})
