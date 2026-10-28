import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPlanModeActive } from '../src/runtime.js'

function fake(plan: any) {
  return { get: (name: string) => name === 'sessionProjections'
    ? { snapshot: () => ({ values: { plan } }) }
    : undefined }
}

test('plan mode is detected from the plan projection', () => {
  const session = {}
  assert.equal(isPlanModeActive(fake({ active: true }), session), true)
  assert.equal(isPlanModeActive(fake({ pending: true }), session), true)
  assert.equal(isPlanModeActive(fake({ active: false, pending: false }), session), false)
  assert.equal(isPlanModeActive({ get: () => undefined }, session), false)
  assert.equal(isPlanModeActive({ get: () => { throw new Error('no projection') } }, session), false)
})
