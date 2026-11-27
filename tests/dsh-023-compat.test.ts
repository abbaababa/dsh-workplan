/*
 * [3.3.2] DeepSeek Harness 0.2.3-alpha.2 兼容回归。
 *
 * 本文件只钉「官方契约」上可验证的事实，不写无法自证的说法：
 *  1. 双代鉴权五分支：旧版 `connection.requestRejection`（拒绝/放行/抛错）、
 *     新版 `peer: PeerScope`（合法放行/非法拒绝/已中止拒绝）、
 *     `connection.admit(request)`（放行/带 rejection/抛错）、无鉴权器 fail-closed；
 *  2. `isPlanModeActive` 三层检测：会话投影 → 预设隔离域 `planMode` → 会话
 *     `plan/mode` 事件；三层都没有时 fail-closed 为 false；
 *  3. 14 个工具的 `parameters` / `output.schema` 与 `plannerOutputSchema` 全部
 *     落在 dsh-tools 强制子集内（关键字仅 type/oneOf/properties/required/
 *     additionalProperties/items/enum/const + 注解 description/title/default/examples，
 *     官方实现见 dsh-tools/lib/shared-DGx6D7zk.js 的 CONSTRAINT_KEYWORDS /
 *     ANNOTATION_KEYWORDS）；
 *  4. `isShellLikeToolName` 覆盖 0.2.3 预设新增的 `pwsh` 与 `persistent_bash`；
 *  5. 三处宿主契约的静态断言：两段系统提示词 `interpolate: false`、
 *     看板路由 `auth: 'required'` + 图表路由 `auth: 'anonymous'`、
 *     前端读计划带 `credentials: 'same-origin'`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { apply, isShellLikeToolName } from '../src/host.js'
import { createWorkplanRuntime, isPlanModeActive, plannerOutputSchema } from '../src/runtime.js'

/* --------------------------------------------------------- 1. 双代鉴权（HTTP 路由） */

function mockRes() {
  const out: any = { status: 0, headers: {} as Record<string, any>, body: '' }
  const res = {
    setHeader: (name: string, value: any) => { out.headers[name] = value },
    writeHead: (status: number, headers?: any) => { out.status = status; Object.assign(out.headers, headers ?? {}) },
    end: (chunk?: any) => { if (chunk !== undefined && chunk !== null) out.body += String(chunk) },
  }
  return { res, out }
}

function makeRouteRuntime() {
  return createWorkplanRuntime(
    { logger: { warn() {} }, get: () => undefined, agents: { get: () => undefined } } as any,
    { version: '3.3.2', autoResume: false } as any,
  )
}

async function callRoute(connectionCtx: any, peer?: any) {
  const runtime: any = makeRouteRuntime()
  const { res, out } = mockRes()
  await runtime.route({ method: 'GET', url: '/dsh-workplan/plans', headers: {} }, res, connectionCtx, peer)
  return out
}

test('3.3.2 双代鉴权：旧版 requestRejection 拒绝 → 原样返回状态码', async () => {
  const out = await callRoute({ connection: { requestRejection: async () => 401 } })
  assert.equal(out.status, 401)
  assert.match(out.body, /未授权的请求/)
})

test('3.3.2 双代鉴权：旧版放行 → 正常返回计划 JSON', async () => {
  const out = await callRoute({ connection: { requestRejection: async () => undefined } })
  assert.equal(out.status, 200)
  assert.equal(JSON.parse(out.body).ok, true)
})

test('3.3.2 双代鉴权：旧版 requestRejection 抛错 → 403 fail-closed', async () => {
  const out = await callRoute({ connection: { requestRejection: async () => { throw new Error('boom') } } })
  assert.equal(out.status, 403)
})

test('3.3.2 双代鉴权：新版 PeerScope 合法 → 放行；空对象 / 已中止 → 401', async () => {
  assert.equal((await callRoute({}, { id: 'peer-1' })).status, 200, '已放行 peer 必须可读计划')
  assert.equal((await callRoute({}, { principal: { id: 'u1' } })).status, 200, 'principal 形态同样视为已放行')
  assert.equal((await callRoute({}, {})).status, 401, '空对象不是合法 PeerScope')
  assert.equal((await callRoute({}, { id: 'p', signal: { aborted: true } })).status, 401, '已中止的 peer 不得放行')
})

test('3.3.2 双代鉴权：connection.admit 三条路径（放行 / rejection503 / 抛错403）', async () => {
  assert.equal((await callRoute({ connection: { admit: async () => ({ peer: { id: 'p' } }) } })).status, 200)
  const rejected = await callRoute({ connection: { admit: async () => ({ rejection: 503 }) } })
  assert.equal(rejected.status, 503)
  assert.match(rejected.body, /鉴权服务不可用，已拒绝访问/)
  assert.equal((await callRoute({ connection: { admit: async () => { throw new Error('x') } } })).status, 403)
  assert.equal((await callRoute({ connection: { admit: async () => ({ peer: {} }) } })).status, 401)
})

test('3.3.2 双代鉴权：没有任何鉴权器 → 503 fail-closed（绝不默认放行）', async () => {
  const out = await callRoute({})
  assert.equal(out.status, 503)
  assert.match(out.body, /鉴权服务不可用/)
})

test('3.3.2 双代鉴权：绕过路由鉴权也读不到别的路径（404）与非 GET（405）', async () => {
  const runtime: any = makeRouteRuntime()
  const connection = { connection: { requestRejection: async () => undefined } }
  const notFound = mockRes()
  await runtime.route({ method: 'GET', url: '/dsh-workplan/other', headers: {} }, notFound.res, connection)
  assert.equal(notFound.out.status, 404)
  const notAllowed = mockRes()
  await runtime.route({ method: 'POST', url: '/dsh-workplan/plans', headers: {} }, notAllowed.res, connection)
  assert.equal(notAllowed.out.status, 405)
})

/* --------------------------------------------------- 2. planMode 三层检测 */

function sessionStub(events: any[]) {
  return {
    id: 'session-plan-mode',
    header: { createdAt: 1000, cwd: '/tmp' },
    seq: events.length,
    eventAt: (index: number) => events[index],
  }
}

test('3.3.2 planMode：第一层会话投影命中（active / pending true 即激活）', () => {
  const ctx = { get: (name: string) => name === 'sessionProjections' ? { snapshot: () => ({ values: { plan: { active: true } } }) } : undefined }
  assert.equal(isPlanModeActive(ctx, sessionStub([])), true)
  const pending = { get: (name: string) => name === 'sessionProjections' ? { snapshot: () => ({ values: { plan: { pending: true } } }) } : undefined }
  assert.equal(isPlanModeActive(pending, sessionStub([])), true)
  const off = { get: (name: string) => name === 'sessionProjections' ? { snapshot: () => ({ values: { plan: { active: false } } }) } : undefined }
  assert.equal(isPlanModeActive(off, sessionStub([])), false, '投影明确说未激活就不得被下层覆盖')
})

test('3.3.2 planMode：投影缺失 → 回退预设隔离域 planMode.get(agent)', () => {
  const agent = { ctx: { get: (name: string) => name === 'planMode' ? { get: () => ({ active: true }) } : undefined } }
  const ctx = {
    get: (name: string) => name === 'sessionProjections' ? { snapshot: () => ({ values: {} }) } : undefined,
    agents: { get: (id: string) => (id === 'session-plan-mode' ? agent : undefined) },
  }
  assert.equal(isPlanModeActive(ctx, sessionStub([])), true)
})

test('3.3.2 planMode：前两层都缺失 → 回退会话 plan/mode 事件；都没有则 false', () => {
  const ctx = { get: () => undefined }
  assert.equal(isPlanModeActive(ctx, sessionStub([{ type: 'plan/mode', data: { active: true } }])), true)
  assert.equal(isPlanModeActive(ctx, sessionStub([{ type: 'plan/mode', data: { active: false } }])), false)
  assert.equal(isPlanModeActive(ctx, sessionStub([{ type: 'other', data: {} }])), false)
  assert.equal(isPlanModeActive({ get: () => { throw new Error('boom') } }, sessionStub([])), false, '任何异常都必须 fail-closed 为 false')
})

/* ------------------------------------------- 3. dsh-tools 严格 Schema 子集 */

function collectRegisteredTools(): any[] {
  const registered: any[] = []
  const mockCtx: any = {
    effect: (fn: () => unknown) => { const disposed = fn(); return typeof disposed === 'function' ? disposed : () => {} },
    get: () => undefined,
    systemPrompt: { section: () => () => {} },
    tools: { register: (def: any) => { registered.push(def); return () => {} }, guard: () => () => {} },
    on: () => () => {},
    inject: () => () => {},
  }
  apply(mockCtx, {})
  return registered
}

/** 逐字对齐 dsh-tools 的 CONSTRAINT_KEYWORDS / ANNOTATION_KEYWORDS（0.2.3-alpha.2）。 */
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

function walkSchema(schema: any, at: string, violations: string[]) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${at} 不是 schema 对象`)
    return
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      violations.push(`${at}.${key} 不是 dsh-tools 支持的关键字`)
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) walkSchema(child, `${at}.properties.${name}`, violations)
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(schema.properties, required)) violations.push(`${at}.required 引用了未声明属性 ${String(required)}`)
    }
  }
  if (schema.items) walkSchema(schema.items, `${at}.items`, violations)
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((child: any, index: number) => walkSchema(child, `${at}.oneOf[${index}]`, violations))
  if (typeof schema.type === 'string' && schema.type !== 'object' && schema.properties) {
    violations.push(`${at} 非 object 类型却声明 properties`)
  }
}

test('3.3.2 Schema 子集：14 个工具的 parameters / output.schema 零违例', () => {
  const registered = collectRegisteredTools()
  assert.equal(registered.length, 14, '工具数量变化必须同步 tests/fixtures/tool-surface.json')
  const violations: string[] = []
  for (const def of registered) {
    walkSchema(def.parameters, `${def.name}.parameters`, violations)
    assert.equal(def.parameters?.type, 'object', `${def.name}.parameters 根必须是 object`)
    walkSchema(def.output?.schema, `${def.name}.output.schema`, violations)
  }
  assert.deepEqual(violations, [], '任何非子集关键字都会让 DSH 0.2.3-alpha.2 拒绝启用插件')
})

test('3.3.2 Schema 子集：规划器输出 schema 零违例', () => {
  const violations: string[] = []
  walkSchema(plannerOutputSchema(), 'plannerOutputSchema', violations)
  assert.deepEqual(violations, [])
})

/* ------------------------------------- 4. 0.2.3 新 Shell 工具名的写保护 */

test('3.3.2 写保护：pwsh / persistent_bash 及其变体都判定为 shell 类工具', () => {
  for (const name of ['bash', 'shell', 'exec', 'pwsh', 'persistent_bash', 'persistent-bash', 'shell-exec', 'bash-run']) {
    assert.equal(isShellLikeToolName(name), true, `${name} 必须被判为 shell 类工具`)
  }
  for (const name of ['read', 'write', 'grep', 'raw_shell', 'execute', 'bashful']) {
    assert.equal(isShellLikeToolName(name), false, `${name} 不是 shell 类工具，不得误伤`)
  }
})

/* ---------------------------------------------- 5. 宿主契约的静态断言 */

async function readSource(relative: string) {
  return readFile(path.resolve(process.cwd(), relative), 'utf8')
}

test('3.3.2 宿主契约：两段系统提示词都声明 interpolate: false', async () => {
  const host = await readSource('src/host.ts')
  const sections = host.match(/systemPrompt\.section\(\{[\s\S]*?\}\)/g) ?? []
  assert.equal(sections.length, 2, '预期恰好两段系统提示词（全局段 + 子会话遮蔽段）')
  for (const block of sections) assert.match(block, /interpolate:\s*false/, '插值器必须被显式关闭')
})

test('3.3.2 宿主契约：看板路由 auth required、图表路由 auth anonymous', async () => {
  const host = await readSource('src/host.ts')
  assert.match(host, /path:\s*'\/dsh-workplan\/plans',\s*auth:\s*'required'/)
  assert.match(host, /path:\s*'\/dsh-workplan\/vendor\/chart\.umd\.js',\s*auth:\s*'anonymous'/)
})

test('3.3.2 宿主契约：读计划请求带同源 Cookie', async () => {
  const client = await readSource('src/client.ts')
  assert.match(client, /credentials:\s*'same-origin'/, 'HttpOnly; SameSite=Strict 会话 Cookie 必须随请求送达')
})
