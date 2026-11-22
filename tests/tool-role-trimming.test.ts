import test from 'node:test'
import assert from 'node:assert/strict'

import { workplanToolAdmitted } from '../src/host.js'

/**
 * [3.1.6][省钱三件套 ①] 工具按角色裁剪：声明面收窄，判定面不动。
 *
 * 这里钉死的是「哪些角色能看到哪些工具的说明书」这一张表：
 *   - 根会话（无 parentSession/非子 Agent/depth=0）：10 个根专用工具 +
 *     instruct 可见；delegate/escalate/verify 不可见（根会话调用必然被
 *     NOT_LEADER_SESSION / NO_PLAN / NOT_CHILD_SESSION 拒绝，3.1.9 起不再
 *     为它们付说明书 token）；
 *   - 部门负责人（depth=1）：看不到 10 个根专用工具；保留 delegate/instruct；
 *   - 第三层专家（depth=2）：根专用与 instruct 都看不到，但 **必须看到 delegate**
 *     ——叶子的唯一开工登记入口是 `delegate(action="self_effort")`，全仓没有
 *     名为 `dsh_workplan_self_effort` 的独立工具（3.1.6 首版裁剪把它藏掉，
 *     导致叶子 phase-0 无法登记，本用例即该回归的守门测试）；
 *   - 任何拿不准的输入（无 header、depth 缺失）：fail-open 全可见。
 * 权限仍然由 execute 内部 isRootSession 等硬校验决定，本函数只影响注入体积。
 */

const root = { header: { createdAt: 1 } }
const head = { header: { parentSession: 'root-session', delegationDepth: 1 } }
const leaf = { header: { parentSession: 'head-session', delegationDepth: 2 } }
const plainChild = { header: { parentSession: 'root-session', origin: 'subagent', delegationDepth: 1 } }

const ROOT_ONLY = [
  'dsh_workplan_update', 'dsh_workplan_cancel', 'dsh_workplan_status',
  'dsh_workplan_followup', 'dsh_workplan_hold', 'dsh_workplan_release',
  'dsh_workplan_handoff', 'dsh_workplan_replan', 'dsh_workplan_dispatch',
  'dsh_workplan_lessons',
]

test('根会话：根专用工具与 instruct 可见，delegate/escalate/verify 不注入', () => {
  for (const name of ROOT_ONLY) assert.equal(workplanToolAdmitted(name, root), true, name)
  assert.equal(workplanToolAdmitted('dsh_workplan_instruct', root), true)
  /*
   * [3.1.9][省钱治本] 根会话调用这三个工具必然被 runtime 硬拒：
   * delegate 需要 parentSession（根没有），escalate 需要已登记的 childId
   * 或第三层叶子上下文，verify 需要 parentSession 反查父计划。声明面不再
   * 注入，能力零损失，每步少付约 12.8KB。
   */
  assert.equal(workplanToolAdmitted('dsh_workplan_delegate', root), false)
  assert.equal(workplanToolAdmitted('dsh_workplan_escalate', root), false)
  assert.equal(workplanToolAdmitted('dsh_workplan_verify', root), false)
})

test('部门负责人：10 个根专用工具不注入，delegate/instruct 保留', () => {
  for (const name of ROOT_ONLY) assert.equal(workplanToolAdmitted(name, head), false, name)
  assert.equal(workplanToolAdmitted('dsh_workplan_delegate', head), true)
  assert.equal(workplanToolAdmitted('dsh_workplan_instruct', head), true)
  assert.equal(workplanToolAdmitted('dsh_workplan_verify', head), true)
  assert.equal(workplanToolAdmitted('dsh_workplan_escalate', head), true)
})

test('第三层专家：根专用与 instruct 不注入，delegate 必须保留（self_effort 是它的 action）', () => {
  for (const name of ROOT_ONLY) assert.equal(workplanToolAdmitted(name, leaf), false, name)
  assert.equal(workplanToolAdmitted('dsh_workplan_instruct', leaf), false)
  // 关键回归守卫：藏掉 delegate = 叶子无法提交 self_effort = 整个第三层无法开工。
  assert.equal(workplanToolAdmitted('dsh_workplan_delegate', leaf), true)
  assert.equal(workplanToolAdmitted('dsh_workplan_verify', leaf), true)
  assert.equal(workplanToolAdmitted('dsh_workplan_escalate', leaf), true)
})

test('普通子 Agent（origin=subagent，非计划角色）：根专用工具不注入', () => {
  assert.equal(workplanToolAdmitted('dsh_workplan_dispatch', plainChild), false)
  assert.equal(workplanToolAdmitted('dsh_workplan_update', plainChild), false)
})

test('fail-open：无 header 或判定异常时一律可见（宁可多付 token，不让工具凭空消失）', () => {
  assert.equal(workplanToolAdmitted('dsh_workplan_dispatch', {}), true)
  assert.equal(workplanToolAdmitted('dsh_workplan_dispatch', undefined), true)
  assert.equal(workplanToolAdmitted('dsh_workplan_dispatch', { header: null }), true)
})
