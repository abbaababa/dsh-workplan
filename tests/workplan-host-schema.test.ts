/*
 * [1.7.1] Host JSON-Schema subset.
 *
 * The host compiles every tool schema with `assertSupportedJsonSchema`, which
 * rejects anything outside a small subset — most notably `type` arrays and
 * `minimum`/`maximum`. A violation does not degrade the plugin: it throws while
 * the plugin is activating, so *every* tool disappears and the panel loses its
 * feed. 1.7.0 shipped `elapsedMs: { type: ['number', 'null'] }` and this exact
 * failure ("schema.properties.elapsedMs.type must be a single type string").
 *
 * These tests mirror the host's subset so a future schema edit fails here
 * instead of in the user's terminal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCancelTool,
  createDispatchTool,
  createStatusTool,
  createUpdateTool,
} from '../src/host.js'
import {
  dispatchToolOutputSchema,
  plannerOutputSchema,
  statusToolOutputSchema,
  updateToolOutputSchema,
  cancelToolOutputSchema,
} from '../src/runtime.js'

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']
const ANNOTATIONS = ['description', 'title', 'default', 'examples']
const KEYWORDS = [
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  ...ANNOTATIONS,
]
const COMPANION_TYPES: Record<string, string[]> = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
}

/** Mirror of @deepseek-ai/dsh-tools `checkSchemaNode` for the parts we use. */
function hostViolations(node: any, path = 'schema', out: string[] = []): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    out.push(`${path} must be a schema object`)
    return out
  }
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.includes(key)) {
      out.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
    }
  }
  if ('description' in node && typeof node.description !== 'string') out.push(`${path}.description must be a string`)
  if ('title' in node && typeof node.title !== 'string') out.push(`${path}.title must be a string`)

  const hasType = 'type' in node
  const hasOneOf = 'oneOf' in node
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`)
    return out
  }
  if (!hasType && !hasOneOf) {
    for (const key of Object.keys(COMPANION_TYPES)) {
      if (key in node) out.push(`${path}.${key} requires type or oneOf`)
    }
    return out
  }

  if (hasOneOf) {
    const options = node.oneOf
    if (!Array.isArray(options) || options.length < 2) {
      out.push(`${path}.oneOf must be an array of at least two schemas`)
    } else {
      options.forEach((option, index) => hostViolations(option, `${path}.oneOf[${index}]`, out))
    }
    return out
  }

  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    out.push(Array.isArray(type)
      ? `${path}.type must be a single type string (type arrays are not supported)`
      : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return out
  }

  for (const [key, types] of Object.entries(COMPANION_TYPES)) {
    if (key in node && !types.includes(type)) out.push(`${path}.${key} is not supported on type "${type}"`)
  }

  if (type === 'object' && 'properties' in node) {
    if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) {
      out.push(`${path}.properties must be an object of schemas`)
    } else {
      for (const [key, child] of Object.entries(node.properties)) {
        hostViolations(child, `${path}.properties.${key}`, out)
      }
    }
  }
  if (type === 'array' && 'items' in node) hostViolations(node.items, `${path}.items`, out)
  return out
}

function fakeRuntime() {
  return {
    limits: { totalTimeoutMs: 600_000, maxResumes: 4 },
    dispatchTool: async () => ({ ok: true }),
    updateStatus: async () => ({ ok: true }),
    cancelPlan: async () => ({ ok: true }),
    statusTool: async () => ({ ok: true, running: false }),
  }
}

test('each registered tool stays inside the host JSON-Schema subset', () => {
  const tools = [
    createDispatchTool(fakeRuntime()),
    createStatusTool(fakeRuntime()),
    createUpdateTool(fakeRuntime()),
    createCancelTool(fakeRuntime()),
  ]
  for (const tool of tools) {
    const violations = hostViolations(tool.parameters)
    assert.deepEqual(violations, [], `${tool.name} parameters: ${violations.join('; ')}`)
    const outputSchema = tool.output?.schema
    if (outputSchema) {
      const outputViolations = hostViolations(outputSchema)
      assert.deepEqual(outputViolations, [], `${tool.name} output: ${outputViolations.join('; ')}`)
    }
  }
})

test('every exported output schema stays inside the host subset', () => {
  for (const [label, schema] of Object.entries({
    planner: plannerOutputSchema(),
    dispatch: dispatchToolOutputSchema(),
    status: statusToolOutputSchema(),
    update: updateToolOutputSchema(),
    cancel: cancelToolOutputSchema(),
  })) {
    assert.deepEqual(hostViolations(schema), [], label)
  }
})

test('elapsedMs is nullable through oneOf, never through a type array', () => {
  const schema: any = statusToolOutputSchema()
  const elapsed = schema.properties.elapsedMs
  assert.equal(elapsed.type, undefined, 'a type array throws at plugin activation')
  assert.deepEqual(elapsed.oneOf, [{ type: 'number' }, { type: 'null' }])
})
