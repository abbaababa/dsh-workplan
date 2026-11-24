#!/usr/bin/env node
/**
 * T4 推理档位钳制行为验证 —— W1 探针：模型无 reasoning 元数据（空清单）时，
 * lib/runtime.js 的 runPlanner 发给 ctx.llm.stream 的请求必须**不含**
 * reasoningEffort 字段，并且 runPlanner 必须走完整条校验链后正常返回、不得抛错。
 *
 * 被验证的机制（lib/runtime.js 构建产物）：
 *   - lib/runtime.js:527     `const efforts = info?.reasoning?.efforts;` 缺失时，
 *                            能力清单解析为 []（空数组，lib/runtime.js:528-530）。
 *   - lib/runtime.js:1093     runPlanner 发送前查询 ctx.llm 的能力面。
 *   - lib/runtime.js:1098-1102 空清单经 clampEffortToSupported 得到 undefined，
 *                            再被 `?? ''` 归一为 ''（= 不发送该字段）。
 *   - lib/runtime.js:1231-1238 stream 入参用条件展开 `...(effectivePlannerEffort ? {...} : {})`：
 *                            只有 effectivePlannerEffort 非空时 reasoningEffort 才出现。
 *   - lib/runtime.js:1246     validatePlan 校验模型输出。
 *   - lib/runtime.js:1261     validatePlanContext 校验计划与用户原文一致。
 *
 * 运行方式（在插件仓库根目录）：
 *   cd plugins/dsh-workplan && node scripts/t4-effort-w1.mjs
 * 退出码：0 = 全部断言通过；1 = runPlanner 抛错或任一断言失败（失败时打印错误与栈，
 *         绝不改断言凑通过）。
 *
 * 只读约束：脚本不修改 src/、lib/、tests/ 或任何共享文件；只读取构建产物并发起
 * 一次纯内存的桩调用。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ---------- 1. 环境隔离：必须在导入/调用被测代码之前完成 ---------- */

// 显式覆盖旋钮会把档位写死；本次要验证“空清单 ⇒ 字段缺席”，先清掉它。
delete process.env.DSH_WORKPLAN_PLANNER_REASONING_EFFORT
// 关闭上下文严格闸：让 validatePlanContext 仍然执行（审计照跑）但不因警告阻塞计划；
// 这是 tests/planner-effort-clamp.test.ts:181-190 已验证的回滚开关用法。
process.env.DSH_WORKPLAN_CONTEXT_GUARD = 'off'

/* ---------- 2. 定位并导入真实构建产物 lib/runtime.js ---------- */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const runtimePath = path.join(repoRoot, 'lib', 'runtime.js')

assert.ok(
  fs.existsSync(runtimePath),
  `未找到构建产物：${runtimePath}（请先在插件仓库根目录执行 npm run build）`,
)
console.log(`[probe] repoRoot   = ${repoRoot}`)
console.log(`[probe] runtime    = ${runtimePath}`)
console.log(`[probe] DSH_WORKPLAN_PLANNER_REASONING_EFFORT = ${JSON.stringify(process.env.DSH_WORKPLAN_PLANNER_REASONING_EFFORT)} (已删除)`)
console.log(`[probe] DSH_WORKPLAN_CONTEXT_GUARD = ${JSON.stringify(process.env.DSH_WORKPLAN_CONTEXT_GUARD)}`)

const runtime = await import(pathToFileURL(runtimePath).href)
assert.equal(typeof runtime.runPlanner, 'function', 'lib/runtime.js 必须导出 runPlanner')

/* ---------- 3. 合法最小计划（复用已通过校验链的夹具） ---------- */

// 与 tests/planner-effort-clamp.test.ts:116-158 同源，保证能通过 validatePlan +
// validatePlanContext，不触发重试。只把 originalRequest 换成当前任务文本。
function minimalPlan(taskText) {
  return {
    version: 1,
    title: '钳制用例',
    taskUnderstanding: {
      originalRequest: taskText,
      deliverable: '可复现的测试结果',
      successCriteria: ['断言有输出'],
      constraints: ['不修改既有测试'],
      knownFacts: ['用户报告了 UNSUPPORTED_REASONING_EFFORT'],
      unknowns: ['无'],
      assumptions: ['无'],
    },
    contradictions: {
      primary: { statement: '默认档与模型能力不匹配', evidence: ['宿主本地即抛'], whyPrimary: '分解整体失败' },
      secondary: [],
      transformationConditions: [],
    },
    stages: [{
      id: 'S1',
      name: '验证',
      goal: '验证钳制',
      rationale: '回归用例',
      checkpoint: '断言通过',
      subtasks: [{
        id: 'T1',
        title: '执行钳制回归',
        department: 'qa',
        role: '验证工程师',
        objective: '运行测试并记录结果',
        method: ['执行 node --test'],
        inputs: ['测试文件'],
        outputs: ['测试输出'],
        dependsOn: [],
        acceptance: ['全部用例通过'],
        risk: '无',
      }],
    }],
    risks: [],
    verification: [{ item: '测试通过', method: 'node --test', evidence: '输出' }],
    practiceLoop: { plan: '写用例', do: '跑测试', check: '核对断言', act: '修复' },
  }
}

/* ---------- 4. 桩：空 reasoning 元数据 + 捕获 stream 入参 ---------- */

const taskText = '验证空清单下规划器请求不带 reasoningEffort 字段'
const seen = []
const telemetry = {}

// provider/model 带时间戳+pid+随机串唯一化：supportedEffortsCache 的键是
// `${provider}/${model}`（lib/runtime.js:517），唯一名保证本次永远回源、读到
// 桩返回的“空能力面”，不会被同进程历史缓存污染。模型名以 probe 开头，
// classifyModelFamily 判为 'other'（非 qwen），静态默认档为 high——这让
// “省略字段”只能由空清单钳制解释，而不是“没有请求过档位”。
const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
const provider = `probe-effort-w1-${stamp}`
const model = `probe-none-${stamp}`

const ctx = {
  llm: {
    // 返回空对象 {}：resolveSupportedEfforts 只读 info?.reasoning?.efforts
    //（lib/runtime.js:527），{} 与 { reasoning: { efforts: [] } } 在运行时等价；
    // 用 {} 更贴近“模型能力面完全未声明 reasoning”的真实形态，且不伪造任何档位。
    async resolveModelInfo(p, m) {
      console.log(`[probe] resolveModelInfo(${JSON.stringify(p)}, ${JSON.stringify(m)}) -> {}`)
      return {}
    },
    // 捕获位置：runPlanner 在 lib/runtime.js:1231 把最终请求体作为唯一参数传给
    // ctx.llm.stream(options)。先保存该对象引用再返回异步生成器，等于捕获最终
    // 请求体本身（含组装后的全部键），无需拦截网络或宿主。
    stream(options) {
      seen.push(options)
      const json = JSON.stringify(minimalPlan(taskText))
      async function* gen() {
        yield { type: 'text-delta', text: json }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return { [Symbol.asyncIterator]: () => gen() }
    },
  },
}

/* ---------- 5. 主断言 ---------- */

let plan
try {
  plan = await runtime.runPlanner(ctx, {
    taskText,
    cwd: '/tmp',
    sessionId: `session-t4-effort-w1-${stamp}`,
    modelSelection: { provider, model },
    signal: new AbortController().signal,
    conversationContext: '',
    budget: {},
    sourceMessageIds: [],
    telemetry,
  })
  console.log('[probe] ✅ runPlanner 未抛错（validatePlan + validatePlanContext 整条校验链已走完）')
} catch (error) {
  console.error('[probe] ❌ runPlanner 抛错，空清单路径未跑通：')
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
}

assert.ok(plan, 'runPlanner 必须返回计划对象，而不是降级为空')
console.log(`[probe] 返回计划：title=${JSON.stringify(plan.title)}，subtask数=${plan.stages?.[0]?.subtasks?.length ?? 0}`)
console.log(`[probe] telemetry.reasoningEffort=${JSON.stringify(telemetry.reasoningEffort)}，source=${JSON.stringify(telemetry.reasoningEffortSource)}`)

assert.equal(seen.length, 1, `ctx.llm.stream 必须恰好被调用 1 次，实际 ${seen.length} 次`)
const options = seen[0]
const optionKeys = Object.keys(options)
console.log(`[probe] stream options 键列表（直接证据）：${JSON.stringify(optionKeys)}`)
console.log(`[probe] 'reasoningEffort' in options = ${'reasoningEffort' in options}`)

// 核心断言：空清单 ⇒ 该字段必须缺席（不是 undefined 值，而是键不存在）。
assert.equal(
  'reasoningEffort' in options,
  false,
  '模型无 reasoning 元数据（空清单）时 reasoningEffort 必须缺席，实际出现了该键',
)

console.log('\n=== T4 W1 探针全部通过：runPlanner 未抛错，且请求体不含 reasoningEffort ===')
