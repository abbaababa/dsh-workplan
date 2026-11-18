/*
 * [3.0.6][复审修复] bash 写保护绕过封堵（fileWriteGuardReason 的 shell 形态）。
 *
 * 事故形状：写保护闸门只认 file_path/path/input+patch 形状的调用，bash 类
 * 工具的 command 参数（heredoc/重定向/tee/sed -i/cp/mv）完全不进闸门——
 * 已交付文件可以一句话被原地改写。修复后契约（保守启发式）：
 *  - 写形态命中已交付路径 → 拒绝，理由串含 planId（与其他写工具同一出口）：
 *      >  / >> 重定向（含 heredoc，兼容 2> 丢弃流）、tee、sed -i、
 *      mv/cp/install 的目标位、dd of=；
 *  - 只读该路径（cat/grep/less、把它当源复制、重定向到别处）→ 放行；
 *  - 写到未交付路径 → 放行（不误伤正常 shell 用法）；
 *  - 非 shell 形工具名（custom_bash_tool / executor）→ 不进本闸门
 *    （executor 边界证明不误判「exec」前缀外的词）。
 *
 * 夹具照抄 tests/p03-m1-guard-gating-gaps.test.ts（同 plan / 同已交付文件）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlanMessage, createStatuses } from '../src/plan.js'
import { createWorkplanRuntime } from '../src/runtime.js'
import { fileWriteGuardReason } from '../src/host.js'

const WORKSPACE = '/work'
const REPORT = `${WORKSPACE}/report.md`
const SESSION_ID = 'session-bash-write-guard'

function makePlan() {
  return {
    planId: 'wp-bash-write-guard',
    sessionId: SESSION_ID,
    createdTurn: 1,
    createdAt: 1000,
    title: 'bash 写保护回归',
    contradictions: { primary: { statement: '交付后不得原地改写' } },
    stages: [{
      id: 'S1',
      name: '实施',
      subtasks: [
        { id: 'T1', title: '第一步', department: 'engineering', dependsOn: [] },
        { id: 'T2', title: '第二步', department: 'engineering', dependsOn: ['T1'] },
      ],
    }],
  }
}

function makeRecord(plan: any): any {
  const statuses: any[] = createStatuses(plan)
  statuses[0].status = 'done'
  statuses[0].verification = 'structured'
  statuses[0].acceptance = [{ criterion: '第一步验收', result: 'pass', evidence: '测试通过' }]
  return {
    plan,
    planId: plan.planId,
    title: plan.title,
    phase: 'paused',
    statuses,
    errors: [],
    degraded: false,
    createdAt: plan.createdAt,
    updatedAt: Date.now(),
    resultWritten: true,
  }
}

function guarded() {
  const plan = makePlan()
  const events: any[] = []
  const session: any = {
    id: SESSION_ID,
    header: { createdAt: 1000, cwd: WORKSPACE },
    get seq() { return events.length },
    append(type: string, data: any) { events.push({ type, data }); return data },
    eventAt: (seq: number) => events[seq],
    events,
  }
  session.append('user/message', buildPlanMessage(plan, { totalBudgetMinutes: 20 }))
  session.append('deliverables/presented', {
    turn: 1,
    callId: 'call_present_1',
    files: [{ path: REPORT, description: '交付报告' }],
  })
  const ctx = {
    logger: { warn() {} },
    subagents: { startActivation: async () => { throw new Error('this test never dispatches') } },
    sessions: { get: () => undefined, list: () => [], eventAt: () => undefined },
  }
  const runtime: any = createWorkplanRuntime(ctx, { totalTimeoutMs: 60_000, cwd: WORKSPACE })
  runtime.state.records.set(session.id, makeRecord(plan))
  runtime.state.activeTurns.set(session.id, 1)
  return { session, runtime }
}

/** 以 bash 类工具调闸门；返回 undefined=放行，string=拒绝理由。 */
function bashGuard(runtime: any, session: any, command: string, name = 'bash') {
  return fileWriteGuardReason(
    { name, agent: { session }, arguments: { command } },
    runtime,
  )
}

const WRITE_COMMANDS: Array<{ label: string; command: string }> = [
  { label: '> 重定向', command: `echo hacked > ${REPORT}` },
  { label: '>> 追加重定向', command: `echo more >> ${REPORT}` },
  { label: 'heredoc 重定向', command: `cat > ${REPORT} << 'EOF'\n重写内容\nEOF` },
  { label: '丢弃流重定向 2>（同段再 > 命中）', command: `ls /nope 2>/dev/null; echo x > ${REPORT}` },
  { label: 'tee', command: `cat notes.txt | tee ${REPORT}` },
  { label: 'tee -a', command: `echo x | tee -a ${REPORT}` },
  { label: 'sed -i 原地改', command: `sed -i '' 's/a/b/' ${REPORT}` },
  { label: 'sed -i.bak', command: `sed -i.bak 's/a/b/' ${REPORT}` },
  { label: 'mv 目标位', command: `mv ${WORKSPACE}/draft.md ${REPORT}` },
  { label: 'cp 目标位', command: `cp ${WORKSPACE}/draft.md ${REPORT}` },
  { label: 'install 目标位', command: `install -m 644 ${WORKSPACE}/draft.md ${REPORT}` },
  { label: 'dd of=', command: `dd if=/dev/zero of=${REPORT} bs=1 count=1` },
]

for (const { label, command } of WRITE_COMMANDS) {
  test(`写形态命中已交付文件 → 拦（${label}）`, () => {
    const { session, runtime } = guarded()
    const reason = bashGuard(runtime, session, command)
    assert.equal(typeof reason, 'string', `必须拒绝：${command}`)
    assert.match(String(reason), /wp-bash-write-guard/, '拒绝理由必须含 planId（与其他写工具同一出口）')
  })
}

const READ_COMMANDS: Array<{ label: string; command: string }> = [
  { label: 'cat 读取', command: `cat ${REPORT}` },
  { label: 'grep 读取', command: `grep -n 结论 ${REPORT}` },
  { label: 'less 读取', command: `less ${REPORT}` },
  { label: '把已交付文件当复制源（读它）', command: `cp ${REPORT} ${WORKSPACE}/backup.md` },
  { label: '读已交付文件、重定向到别处', command: `head -5 ${REPORT} > /tmp/summary.txt` },
  { label: 'mv 到别处（它是源不是目标）', command: `mv ${REPORT} ${WORKSPACE}/archive.md` },
]

for (const { label, command } of READ_COMMANDS) {
  test(`只读形态必须放行（${label}）`, () => {
    const { session, runtime } = guarded()
    assert.equal(bashGuard(runtime, session, command), undefined, `不得误拦：${command}`)
  })
}

test('写到未交付路径 → 放行（不误伤正常 shell 用法）', () => {
  const { session, runtime } = guarded()
  assert.equal(bashGuard(runtime, session, `echo x > ${WORKSPACE}/scratch.md`), undefined)
  assert.equal(bashGuard(runtime, session, `sed -i 's/a/b/' ${WORKSPACE}/scratch.md`), undefined)
})

test('非 shell 形工具名不进本闸门（custom_bash_tool / executor）', () => {
  const { session, runtime } = guarded()
  assert.equal(
    bashGuard(runtime, session, `echo x > ${REPORT}`, 'custom_bash_tool'),
    undefined,
    '名字不以 bash/shell/exec 开头的工具不属本闸门管辖',
  )
  assert.equal(
    bashGuard(runtime, session, `echo x > ${REPORT}`, 'executor'),
    undefined,
    'executor 不以分隔符结尾，不得被「exec」前缀误判（启发式边界）',
  )
})

test('shell 形前缀可以带分隔符（bash-legacy / shell_tool）', () => {
  const { session, runtime } = guarded()
  for (const name of ['bash-legacy', 'shell_tool', 'exec_cli']) {
    assert.equal(
      typeof bashGuard(runtime, session, `echo x > ${REPORT}`, name),
      'string',
      `${name} 属于 shell 形工具名，必须进闸门`,
    )
  }
})

test('command 缺失或非字符串 → 按原路径放行', () => {
  const { session, runtime } = guarded()
  assert.equal(
    fileWriteGuardReason({ name: 'bash', agent: { session }, arguments: {} }, runtime),
    undefined,
  )
  assert.equal(
    fileWriteGuardReason({ name: 'bash', agent: { session }, arguments: { command: 42 } }, runtime),
    undefined,
  )
})
